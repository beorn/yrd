/**
 * Best-effort forensics for one setup failure: WHY a declared `bun install
 * --frozen-lockfile` refused to run ([@i/10-yrd/24140]).
 *
 * Bun's own refusal — `error: lockfile had changes, but lockfile is frozen` —
 * never names what changed. Four identical, contentless stops of that exact
 * shape cost a 3h51m outage on 2026-09-04, because nobody could tell which
 * dependency moved without re-resolving by hand. The worktree this setup just
 * failed in is disposable and about to be torn down uninspected
 * (worktree.ts's own `prepareWorktree`), so this runs once, inside that same
 * tree, before it goes: re-resolve without the flag, diff the lockfile text
 * before and after, and name every entry whose resolution moved.
 *
 * Triggered ONLY when the failing command line names `--frozen-lockfile`;
 * every other setup failure is unrelated and gets none of this. Advisory
 * throughout: mutating the already-failed, never-merged worktree by
 * re-running its install without the flag is safe precisely because that
 * worktree is disposable, but whatever this returns is APPENDED to the
 * failure text a human reads — it never throws past its own boundary, and it
 * never changes what the setup itself decided (`SetupFailed` is still the
 * setup's own verdict; this only adds to its message).
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createProcess, shellCommand, type Process } from "@yrd/process"
import { DEFAULT_CHECK_BOUND_MS } from "./check.ts"

const LOCKFILE_NAME = "bun.lock"
const BINARY_LOCKFILE_NAME = "bun.lockb"
const FROZEN_FLAG = "--frozen-lockfile"

export type FrozenLockfileDiagnosis = Readonly<{
  /** The setup line that just failed; the diagnosis runs only when this names the flag. */
  setupRun: string
  /** The already-failed, disposable worktree the setup ran in. */
  cwd: string
  timeoutMs?: number
  process?: Process
  env?: NodeJS.ProcessEnv
}>

/**
 * One line naming every package whose lockfile entry differs between the
 * failed attempt and an unfrozen re-resolve, plus one line naming where this
 * looked — or `undefined` when the failing command did not name
 * `--frozen-lockfile` at all, which is most setup failures and none of this
 * business.
 */
export async function frozenLockfileDiagnosis(options: FrozenLockfileDiagnosis): Promise<string | undefined> {
  if (!options.setupRun.includes(FROZEN_FLAG)) return undefined
  try {
    return await diagnose(options)
  } catch (error) {
    // NO SILENT ERRORS: the trigger matched, so returning nothing here would
    // be exactly the defect this diagnosis exists to fix. Whatever broke, say
    // so instead of letting a second failure swallow the first one's report.
    return `frozen-lockfile diagnosis crashed while it ran: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function diagnose(options: FrozenLockfileDiagnosis): Promise<string> {
  const { cwd, setupRun } = options
  const lockfilePath = join(cwd, LOCKFILE_NAME)
  let before: string
  try {
    before = readFileSync(lockfilePath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return `frozen-lockfile diagnosis could not read ${lockfilePath}: ${error instanceof Error ? error.message : String(error)}`
    }
    if (existsSync(join(cwd, BINARY_LOCKFILE_NAME))) {
      return (
        `frozen-lockfile diagnosis: ${cwd} carries a binary ${BINARY_LOCKFILE_NAME}, which this diagnosis cannot ` +
        `text-diff; re-run \`bun install\` (without ${FROZEN_FLAG}) by hand in that worktree to see what it would change.`
      )
    }
    return `frozen-lockfile diagnosis: setup declared ${FROZEN_FLAG}, but no ${LOCKFILE_NAME} exists at ${lockfilePath} to compare against.`
  }

  // Strip only the flag (and a `--frozen-lockfile=value` form); everything
  // else about the declared command — its other flags, any `&&` it chains
  // through — stays, so this re-runs the same command the target declared,
  // minus the one flag that made it refuse.
  const rerun = setupRun.replace(new RegExp(`\\s*${FROZEN_FLAG}(?:=\\S+)?`, "gu"), "").trim()
  const runner = options.process ?? createProcess({ cwd })
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_BOUND_MS
  const where = `looked at lockfile ${lockfilePath}; worktree root ${cwd}`

  let result: Awaited<ReturnType<Process["run"]>>
  try {
    result = await runner.run({ argv: shellCommand(rerun), cwd, env: options.env, timeoutMs })
  } catch (error) {
    return (
      `frozen-lockfile diagnosis: re-running \`${rerun}\` without ${FROZEN_FLAG} in the same disposable worktree ` +
      `(to see the lockfile it would have produced) itself threw: ${error instanceof Error ? error.message : String(error)}; ${where}`
    )
  }
  if (result.timedOut || result.signal !== null || result.exitCode !== 0) {
    const why = result.timedOut
      ? `ran past its ${String(timeoutMs)} ms bound`
      : result.signal !== null
        ? `was ended by ${result.signal}`
        : `exited ${String(result.exitCode)}`
    const stderr = result.stderr.trim()
    return (
      `frozen-lockfile diagnosis: re-running \`${rerun}\` without ${FROZEN_FLAG} to compare lockfiles ${why}` +
      `${stderr === "" ? "" : `: ${stderr}`}; ${where}`
    )
  }

  let after: string
  try {
    after = readFileSync(lockfilePath, "utf8")
  } catch (error) {
    return `frozen-lockfile diagnosis: the re-resolve exited 0 but ${lockfilePath} could not be read afterwards: ${error instanceof Error ? error.message : String(error)}; ${where}`
  }

  let comparison: LockfileRead
  try {
    comparison = { after: parseLockfile(after), before: parseLockfile(before) }
  } catch (error) {
    return `frozen-lockfile diagnosis: re-resolved successfully but could not parse ${lockfilePath} to compare entries: ${error instanceof Error ? error.message : String(error)}; ${where}`
  }

  const manifestKeys = comparison.after.manifestKeys.length > 0 ? comparison.after.manifestKeys : [""]
  const manifests = manifestKeys.map((key) => (key === "" ? join(cwd, "package.json") : join(cwd, key, "package.json")))
  const lookedAt = `looked at lockfile ${lockfilePath}; manifests ${manifests.join(", ")}; worktree root ${cwd}`
  const changed = diffEntries(comparison.before.packages, comparison.after.packages)
  if (changed.length === 0) {
    return (
      `frozen-lockfile diagnosis: re-resolved without ${FROZEN_FLAG}; the lockfile ` +
      `${before === after ? "came back identical" : "changed, but no named package entry's locator differs"} — ` +
      `inspect ${lockfilePath} directly; ${lookedAt}`
    )
  }
  const lines = changed.map(({ from, name, to }) => `- ${name}: ${from} -> ${to}`)
  return (
    `frozen-lockfile diagnosis: \`${setupRun.trim()}\` refused because the lockfile would change; re-resolving ` +
    `without ${FROZEN_FLAG} in this same disposable worktree shows what changed:\n${lines.join("\n")}\n${lookedAt}`
  )
}

type LockfileRead = Readonly<{ before: ParsedLockfile; after: ParsedLockfile }>
type ParsedLockfile = Readonly<{ packages: Readonly<Record<string, unknown>>; manifestKeys: readonly string[] }>

/**
 * `bun.lock`'s own format: JSON plus trailing commas before `}`/`]`. No
 * comment syntax has been observed from bun 1.4's writer; a lockfile that
 * uses one fails to parse here, and the caller reports that rather than this
 * guessing at what changed.
 */
function parseLockfile(text: string): ParsedLockfile {
  const parsed: unknown = JSON.parse(text.replace(/,(\s*[}\]])/gu, "$1"))
  if (typeof parsed !== "object" || parsed === null) throw new Error("lockfile root is not an object")
  const root = parsed as Record<string, unknown>
  const packages = isRecord(root.packages) ? root.packages : {}
  const workspaces = isRecord(root.workspaces) ? root.workspaces : {}
  return { manifestKeys: Object.keys(workspaces), packages }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

type ChangedEntry = Readonly<{ name: string; from: string; to: string }>

/** Every `packages` key whose locator differs, or is new or gone, between two reads of the same lockfile. */
function diffEntries(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): readonly ChangedEntry[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)])
  const changed: ChangedEntry[] = []
  for (const name of names) {
    const from = locatorOf(before[name])
    const to = locatorOf(after[name])
    if (from !== to) changed.push({ from: from ?? "(absent)", name, to: to ?? "(absent)" })
  }
  // The lockfile's own key order is not something JSON.parse promises to keep
  // stable across engines, and a reader comparing two runs of one fixture
  // needs the same order both times.
  return changed.sort((a, b) => a.name.localeCompare(b.name))
}

/** One `packages` entry's locator: the first element of bun's `[locator, ...]` tuple, or the value itself when it is already a string. */
function locatorOf(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (Array.isArray(value) && typeof value[0] === "string") return value[0]
  return undefined
}
