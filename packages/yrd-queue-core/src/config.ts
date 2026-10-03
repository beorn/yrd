/**
 * The target's declaration of the queue, read from the target commit
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design, The queue run:
 * check authority lives on the protected side).
 *
 * `.yrd.yml` is read with `git show <target>:.yrd.yml`, never from a branch's
 * worktree, so a change that edits its own checks is judged by the target's
 * version and the edit takes effect for the next change. The parser is Bun's
 * own YAML, the same one the incumbent uses, so one file means one thing.
 *
 * A malformed declaration throws with the path that is wrong. A queue that
 * guessed at its own configuration would judge every change by that guess.
 */

import { refAt, type Git } from "./git.ts"
import { parseDuration } from "./duration.ts"
import { DEFAULT_STALL_AFTER_MS, STALL_AFTER_FLOOR_MS } from "./service-health.ts"
import { formatQueueKey } from "./queue-key.ts"
import type { CheckSpec } from "./check.ts"

/**
 * A queue's target: the branch it merges on, and the remote that holds it,
 * which are one thing and are declared as one — `<remote>#<branch>`.
 *
 * They were two keys, `remote:` and `target:`, and each defaulted on its own,
 * so a declaration could name a remote and mean another repository's `main`
 * without ever saying `main`. A branch name alone does not identify a branch;
 * the remote is half of the name.
 */
export type Target = Readonly<{
  /** A name from `git remote`, or a URL the CLI adds under the remote name `yrd`. */
  remote: string
  /** The branch itself, at that remote. */
  branch: string
}>

/**
 * The queue's own name: its target with the remote resolved to a URL and
 * normalized — legacy `<host>/<path>#<branch>` unless the branch contains #,
 * when the shared versioned queue-key codec spells both fields.
 *
 * A remote NAME means nothing outside the repository that holds it: two clones
 * call one queue `origin` and `yrd`, and a reader of a merge commit has neither.
 * A URL is the same everywhere, so it is what the queue calls itself in
 * anything a stranger reads. The normalizing drops what is about HOW you reach
 * it rather than WHICH it is — the scheme, the `user@`, a trailing `.git` — and
 * writes an scp-style URL's colon as a slash, so `git@github.com:beorn/hh.git`
 * and `https://github.com/beorn/hh.git` are one name. A local path is already
 * unambiguous and is kept whole.
 */
export function queueName(target: Target, remoteUrl: string): string {
  return formatQueueKey(normalizedRemote(remoteUrl), target.branch)
}

/** A remote URL as the queue's name spells it; a path is returned as it stands. */
function normalizedRemote(url: string): string {
  const text = url.trim()
  if (text.startsWith("/") || text.startsWith(".") || text.startsWith("~")) return text
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//iu
  const withoutUser = text.replace(scheme, "").replace(/^[^/@]*@/u, "")
  // scp-style `host:path`: the colon separates the host from the path, and a
  // slash says the same thing in the one spelling every other form uses. Only
  // a URL with no scheme can be scp-style, and only there is a colon not a port.
  const asPath = scheme.test(text) ? withoutUser : withoutUser.replace(/^([^/:]+):/u, "$1/")
  return asPath.replace(/\.git$/u, "").replace(/\/+$/u, "")
}

/** A target as it is written and read: `<remote>#<branch>`. */
export function targetName(target: Target): string {
  return `${target.remote}#${target.branch}`
}

/** The one line that shows what `notify:` looks like, wherever it has to be shown. */
const NOTIFY_SHAPE = "notify: [- <name>: {on: [merged, failed], run: <command>}]"

/** The endings the queue can notify about; it has no others to run a command on. */
// `override` is a merge-check override's own event (25296, @cto ccd8dfa8): the
// verb's set, clear and replace, and a round's expiry and half-window reminder.
// Not a default: only an entry that names it hears it.
export const ENDINGS = [
  "admission-warning",
  "merged",
  "failed",
  "stuck",
  "merged-direct",
  "observed",
  "deferred",
  "override",
  "cancelled",
] as const
const DEFAULT_ENDINGS = ["merged", "failed", "stuck", "merged-direct", "cancelled"] as const

export type Ending = (typeof ENDINGS)[number]

/**
 * One entry of `notify:`: a name the declaration chooses, the endings it wants,
 * and the command that gets the record on stdin.
 *
 * The queue knows no people. It knows what happened and hands that to a
 * command; who should hear about it, and how, is that command's own business
 * and its own arguments. `owner:` was the other shape — a seat name in the
 * declaration — and a seat name is exactly what the queue has no way to keep
 * true. The NAME here is the declaration's own word, read by nothing but the
 * records: a sent record says `To: <name>`, so a reader can see which entry ran.
 */
export type Notifier = Readonly<{
  name: string
  /** The endings this entry wants; absent in the declaration means all of them. */
  on: readonly Ending[]
  /** The command, run through the shell with the record as JSON on its stdin. */
  run: string
}>

export type QueueHealthConfig = Readonly<{ stallAfterMs: number; declared: boolean }>

export type QueueConfig = Readonly<{
  /** The branch the queue merges on, at the remote holding it; `origin#main` unless declared. */
  target: Target
  /** Ref deletion is halted; the only accepted retention policy is never. */
  archiveAfter: "never"
  /** Whole-branch Bun.Glob patterns that suppress unsubmitted drafts. */
  ignore: readonly string[]
  /** Target-owned command that resolves a raw issue reference to its canonical identity. */
  issueResolver?: readonly string[]
  /** Target-owned pre-submit policy command. Exit 1 refuses; failures to judge warn. */
  admission?: Readonly<{ run: string; timeoutMs: number }>
  checks: readonly CheckSpec[]
  /** One shell command run in every fresh worktree the queue makes, before any check runs in it. */
  setup?: string
  /**
   * One shell command the queue's compose runs in the merged worktree, after the gitlinks are settled and before
   * anything is verified, to regenerate files whose inputs are the merged gitlinks (see derive.ts). Only the queue
   * runs it: a submit-side compose has no final inputs.
   */
  derive?: string
  /** One shell command run before closing a retained environment. */
  teardown?: string
  /** What the queue notifies, per ending; empty when the declaration names none. */
  notify: readonly Notifier[]
  /**
   * How the service judges its own line (25669). `stallAfter` is how long waiting
   * changes may go without one being judged before health reads STALLED; the
   * default applies when the declaration names none, and `declared` says which
   * one a page is quoting.
   */
  health: QueueHealthConfig
  /** The blob the declaration was read from, recorded on every checked record. */
  blob: string
}>

/**
 * Read the declaration at one commit, or undefined when the commit has no
 * `.yrd.yml` (an honest absence, read as git's exit 1). Any other failure
 * throws with the path that is wrong.
 */
export class InvalidQueueConfig extends Error {
  override readonly name = "InvalidQueueConfig"
}

/** An undeclared key, distinguished from malformed values so the queue can name the parser upgrade order. */
export class UnknownConfigKey extends Error {
  override readonly name = "UnknownConfigKey"
}

/**
 * How a read treats a TOP-level key this parser does not know (27187). A read that
 * will RUN the declaration — the queue's round, `check`, `merge` — refuses it, because
 * running a declaration it cannot read in full is the silent error. A read that only
 * submits against the target or lists it hands the key names to `newerKeys` and reads
 * the rest: the target commit is the authority on its own declaration, and the parser
 * that must know every key is the one in the queue, not the one in the submitter's
 * environment (27176 added `derive:` on 2026-10-02 and every older environment's
 * `yrd submit` refused `unknown key derive` until this). A RETIRED key refuses in
 * every read; so does an unknown field inside `checks:` or any nested block.
 */
export type ReadConfigOptions = Readonly<{ newerKeys?: (keys: readonly string[]) => void }>

export async function readConfig(
  git: Git,
  commit: string,
  target: Target,
  options: ReadConfigOptions = {},
): Promise<QueueConfig | undefined> {
  const blob = await refAt(git, `${commit}:.yrd.yml`, "blob")
  if (blob === undefined) return undefined
  const text = await git(["show", `${commit}:.yrd.yml`])
  try {
    return parseConfig(text, { at: commit, blob, target, ...options })
  } catch (error) {
    throw new InvalidQueueConfig(error instanceof Error ? error.message : String(error), { cause: error })
  }
}

/** Parse the declaration's text with its captured source and caller-owned queue identity. */
export function parseConfig(
  text: string,
  { at, blob, target, newerKeys }: Readonly<{ at: string; blob: string; target: Target }> & ReadConfigOptions,
): QueueConfig {
  let raw: unknown
  try {
    raw = Bun.YAML.parse(text)
  } catch (error) {
    throw new Error(`.yrd.yml at ${at} does not parse: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(raw)) throw new Error(`.yrd.yml at ${at.slice(0, 12)} is not a mapping`)
  const declared = newerKeys === undefined ? strictTop(raw) : withoutNewerKeys(raw, newerKeys)
  const notify = readNotify(declared.notify)
  const setup = optionalString(declared, "setup")
  const derive = optionalString(declared, "derive")
  const teardown = optionalString(declared, "teardown")
  const issueResolver = readIssueResolver(declared.issueResolver)
  const admission = readAdmission(declared.admission)
  return {
    archiveAfter: readArchiveAfter(declared["archive-after"]),
    blob,
    checks: readChecks(declared.checks),
    health: readHealth(declared.health),
    ignore: readIgnore(declared.ignore),
    ...(issueResolver === undefined ? {} : { issueResolver }),
    ...(admission === undefined ? {} : { admission }),
    notify,
    setup,
    ...(derive === undefined ? {} : { derive }),
    teardown,
    target,
  }
}

function readArchiveAfter(value: unknown): "never" {
  if (value === undefined || value === "never") return "never"
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    throw new Error(
      `yrd-archive-after-disabled: .yrd.yml archive-after ${value} days: ref deletion is disabled; the only accepted value is never`,
    )
  }
  throw new Error(
    `yrd-archive-after-invalid: .yrd.yml archive-after: the only accepted value is never; received ${JSON.stringify(value)}`,
  )
}

/**
 * `health: { stallAfter: <duration> }` (25669, @cto fa6f3457). Validated like
 * every other key: a malformed duration, or one under the round budget (a round
 * may run that long, so a smaller threshold pages on every long round), refuses
 * by name. Absent is the documented default, never a fallback from a bad value.
 */
function readHealth(value: unknown): QueueHealthConfig {
  if (value === undefined) return { declared: false, stallAfterMs: DEFAULT_STALL_AFTER_MS }
  if (!isRecord(value)) throw new Error("yrd-health-invalid: .yrd.yml health: must be a mapping with stallAfter")
  onlyKeys(value, ["stallAfter"], ".yrd.yml health")
  const raw = value.stallAfter
  if (raw === undefined) return { declared: false, stallAfterMs: DEFAULT_STALL_AFTER_MS }
  const ms = typeof raw === "string" ? parseDuration(raw) : undefined
  if (ms === undefined) {
    throw new Error(
      `yrd-health-stall-after-invalid: .yrd.yml health.stallAfter: ${JSON.stringify(raw)} is not a duration; write one such as 45m or 1h`,
    )
  }
  if (ms < STALL_AFTER_FLOOR_MS) {
    throw new Error(
      `yrd-health-stall-after-below-floor: .yrd.yml health.stallAfter ${String(raw)} is below the round budget of ` +
        `${String(STALL_AFTER_FLOOR_MS / 60_000)}m: a round may legitimately run that long, so this would page on every long round`,
    )
  }
  return { declared: true, stallAfterMs: ms }
}

function readIgnore(value: unknown): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new Error("yrd-ignore-pattern-invalid: .yrd.yml ignore: must be a list of Bun.Glob patterns")
  }
  return value.map((pattern, index) => {
    const where = `.yrd.yml ignore entry ${index}`
    if (typeof pattern !== "string") {
      throw new Error(`yrd-ignore-pattern-invalid: ${where}: pattern must be a string`)
    }
    if (pattern.length === 0) throw new Error(`yrd-ignore-pattern-invalid: ${where}: pattern is empty`)
    if (pattern.includes("\0")) throw new Error(`yrd-ignore-pattern-invalid: ${where}: pattern contains NUL`)
    if (pattern.startsWith("!")) throw new Error(`yrd-ignore-pattern-invalid: ${where}: pattern starts with !`)
    if (pattern.startsWith("/")) throw new Error(`yrd-ignore-pattern-invalid: ${where}: pattern starts with / `)
    try {
      new Bun.Glob(pattern)
    } catch (cause) {
      throw new Error(`yrd-ignore-pattern-invalid: ${where}: invalid Bun.Glob pattern ${JSON.stringify(pattern)}`, {
        cause,
      })
    }
    return pattern
  })
}

/**
 * A named list of commands: `- name: {run, on, …}`, the one shape `checks:` and
 * `notify:` share. Both are "these commands, each for these occasions", so both
 * are written and read the same way — a reader who has learned one has learned
 * the other, and neither can drift from the other's grammar.
 *
 * `on:` is a single value or a list, held to `phases`; absent, the caller says
 * what that means. `run:` is required. `extra` names the keys this list allows
 * beyond `run` and `on`; anything else is refused with the list of what is read.
 */
function namedCommands(
  value: unknown,
  key: string,
  phases: readonly string[],
  extra: readonly string[],
): readonly Readonly<{ name: string; run: string; on?: readonly string[]; body: Record<string, unknown> }>[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new Error(`.yrd.yml ${key}: must be a list of "- <name>: {run: <command>}" entries`)
  }
  return value.map((item, index) => {
    const where = `.yrd.yml ${key}[${index}]`
    if (!isRecord(item) || Object.keys(item).length !== 1) {
      throw new Error(`${where}: must be one mapping of the entry's name to its declaration`)
    }
    const name = Object.keys(item)[0] ?? ""
    const body = item[name]
    if (!isRecord(body) || typeof body.run !== "string" || body.run === "") {
      throw new Error(`${where} ${name}: needs run: <command>`)
    }
    onlyKeys(body, ["run", "on", ...extra], `${where} ${name}`)
    const on = body.on
    if (on === undefined) return { body, name, run: body.run }
    const listed = (Array.isArray(on) ? on : [on]).map(String)
    for (const phase of listed) {
      if (!phases.includes(phase)) throw new Error(`${where} ${name}: on: must be ${phases.join(" or ")}`)
    }
    return { body, name, on: listed, run: body.run }
  })
}

/**
 * `notify:`, a named list of commands (above), each for the endings it names.
 * An entry with no `on:` wants every ending. The name is the declaration's own
 * and the queue reads nothing into it; the records carry it as `To:`.
 */
function readNotify(value: unknown): readonly Notifier[] {
  return namedCommands(value, "notify", ENDINGS, []).map((entry) => ({
    name: entry.name,
    on: (entry.on ?? DEFAULT_ENDINGS) as readonly Ending[],
    run: entry.run,
  }))
}

/**
 * `checks:`, the same named list. `on:` names the phases, `submit`, `merge` or
 * both; absent means merge.
 */
function readChecks(value: unknown): readonly CheckSpec[] {
  return namedCommands(
    value,
    "checks",
    ["submit", "merge"],
    ["timeoutMs", "environmentPassthrough", "scripts", "programRoot", "long"],
  ).map((entry, index) => {
    const { body, name } = entry
    const where = `.yrd.yml checks[${index}] ${name}`
    const scripts = body.scripts
    if (
      scripts !== undefined &&
      (!Array.isArray(scripts) || !scripts.every((path) => typeof path === "string" && path !== ""))
    ) {
      throw new Error(`${where}: scripts: must be a list of repository paths`)
    }
    const timeoutMs = body.timeoutMs
    if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || timeoutMs <= 0)) {
      throw new Error(`${where}: timeoutMs: must be a positive number`)
    }
    const passthrough = body.environmentPassthrough
    if (
      passthrough !== undefined &&
      (!Array.isArray(passthrough) || !passthrough.every((named) => typeof named === "string"))
    ) {
      throw new Error(`${where}: environmentPassthrough: must be a list of names`)
    }
    const programRoot = body.programRoot
    if (programRoot !== undefined && programRoot !== true) {
      throw new Error(`${where}: programRoot: must be true when present`)
    }
    const long = body.long
    if (long !== undefined) {
      if (!isRecord(long)) {
        throw new Error(`${where}: long: must be a mapping of long-tier options`)
      }
      onlyKeys(long, ["timeoutMs"], `${where} long`)
      if (typeof long.timeoutMs !== "number" || long.timeoutMs <= 0) {
        throw new Error(`${where} long: timeoutMs: must be a positive number`)
      }
    }
    return {
      environmentPassthrough: passthrough as readonly string[] | undefined,
      ...(long === undefined ? {} : { long: { timeoutMs: long.timeoutMs as number } }),
      name,
      on: entry.on as readonly ("submit" | "merge")[] | undefined,
      ...(programRoot === true ? { programRoot: true as const } : {}),
      run: entry.run,
      scripts: scripts as readonly string[] | undefined,
      timeoutMs,
    }
  })
}

// Ruling A6's set, plus environment setup/teardown: every key here has a
// consumer, and one nobody reads is still refused. A fresh worktree has
// submodules and nothing else, so the target says how to finish it once
// instead of every check prefixing its own `run:` with the same install.
const TOP_KEYS = [
  "admission",
  "archive-after",
  "checks",
  "derive",
  "health",
  "ignore",
  "issueResolver",
  "setup",
  "teardown",
  "notify",
] as const

function readAdmission(value: unknown): QueueConfig["admission"] {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error(".yrd.yml admission: must be a mapping with run and timeoutMs")
  onlyKeys(value, ["run", "timeoutMs"], ".yrd.yml admission")
  if (typeof value.run !== "string" || value.run.trim() === "" || value.run !== value.run.trim()) {
    throw new Error(".yrd.yml admission.run: must be a non-empty command without surrounding whitespace")
  }
  if (!Number.isSafeInteger(value.timeoutMs) || (value.timeoutMs as number) < 1) {
    throw new Error(".yrd.yml admission.timeoutMs: must be a positive integer")
  }
  return { run: value.run, timeoutMs: value.timeoutMs as number }
}

function readIssueResolver(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((part) => typeof part !== "string" || part === "" || /[\r\n\0]/.test(part))
  ) {
    throw new Error(".yrd.yml issueResolver: must be a non-empty argv list of single-line strings")
  }
  return value as string[]
}

/**
 * A key the declaration used to read, and where its meaning went. A typo is
 * refused the same way, with the known keys listed; a RETIRED key is refused
 * with the one sentence that cures it, because "unknown key workdir" tells a
 * reader that the queue forgot how to write somewhere, not where to say it now.
 */
const RETIRED: Readonly<Record<string, string>> = {
  landing: "landing: was Gitomic's protected-branch declaration; an event queue declares its gates under checks:",
  owner: `the queue addresses nobody: a notify: entry decides who hears about an ending, in its own arguments (${NOTIFY_SHAPE})`,
  remote: "select the queue with --queue <branch> at origin or --queue <repo>#<queue>",
  scratch: "the queue workdir is `git config yrd.workdir` in the repository the command runs in, not a declaration key",
  workdir: "the queue workdir is `git config yrd.workdir` in the repository the command runs in, not a declaration key",
  target: "target: is not read; submit resolves the queue from --queue or the origin head",
}

function strictTop(raw: Record<string, unknown>): Record<string, unknown> {
  onlyKeys(raw, TOP_KEYS, ".yrd.yml")
  return raw
}

/** The mapping without the top-level keys this parser postdates, after the handler heard their names; a RETIRED key still refuses. */
function withoutNewerKeys(
  raw: Record<string, unknown>,
  newerKeys: (keys: readonly string[]) => void,
): Record<string, unknown> {
  const newer = Object.keys(raw).filter((key) => !(TOP_KEYS as readonly string[]).includes(key))
  if (newer.length === 0) return raw
  onlyKeys(
    Object.fromEntries(newer.filter((key) => key in RETIRED).map((key) => [key, raw[key]])),
    TOP_KEYS,
    ".yrd.yml",
  )
  newerKeys(newer)
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !newer.includes(key)))
}

/** A key the queue does not read is a typo or a retired mechanism; either is said out loud, never ignored. */
function onlyKeys(record: Record<string, unknown>, known: readonly string[], where: string): void {
  const unknown = Object.keys(record).filter((key) => !known.includes(key))
  if (unknown.length === 0) return
  const retired = unknown.map((key) => RETIRED[key]).filter((cure): cure is string => cure !== undefined)
  const message =
    `${where}: unknown key ${unknown.join(", ")} (known: ${known.join(", ")})` +
    (retired.length === 0 ? "" : `; ${retired.join("; ")}`)
  throw retired.length === 0 ? new UnknownConfigKey(message) : new Error(message)
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== "string" || value === "") throw new Error(`.yrd.yml ${key}: must be a non-empty string`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
