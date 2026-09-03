/**
 * The target's declaration of the queue, read from the target commit
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design, The queue run:
 * gate authority lives on the protected side).
 *
 * `.yrd.yml` is read with `git show <target>:.yrd.yml`, never from a branch's
 * worktree, so a change that edits its own checks is judged by the target's
 * version and the edit takes effect for the next change. The parser is Bun's
 * own YAML, the same one the incumbent uses, so one file means one thing.
 *
 * A malformed declaration throws with the path that is wrong. A queue that
 * guessed at its own configuration would judge every change by that guess.
 */

import type { Git } from "./facts.ts"
import { refAt } from "./git.ts"
import type { QueueCheck } from "./run.ts"

export type QueueConfig = Readonly<{
  /** The queue's remote: a remote name, or a URL the CLI adds under the name `yrd`; `origin` unless declared. */
  remote: string
  /** Whether the declaration names `remote:` itself — the line that selects this core while the incumbent still exists (§ Cutover). */
  declaresRemote: boolean
  /** The branch the queue lands on; `main` unless declared. */
  target: string
  checks: readonly QueueCheck[]
  /** The command that delivers one message, a JSON record on stdin. */
  notify?: string
  /** Who hears about a stuck change. */
  owner: string
  /** Where checks write their temporary files; on the root filesystem. */
  scratch?: string
  /** The blob the declaration was read from, recorded on every checked fact. */
  blob: string
}>

/**
 * Read the declaration at one commit, or undefined when the commit has no
 * `.yrd.yml` (an honest absence, read as git's exit 1). Any other failure
 * throws with the path that is wrong.
 */
export async function readConfig(git: Git, commit: string): Promise<QueueConfig | undefined> {
  const blob = await refAt(git, `${commit}:.yrd.yml`, "blob")
  if (blob === undefined) return undefined
  const text = await git(["show", `${commit}:.yrd.yml`])
  const raw: unknown = Bun.YAML.parse(text)
  if (!isRecord(raw)) throw new Error(`.yrd.yml at ${commit.slice(0, 12)} is not a mapping`)
  const remote = raw.remote ?? "origin"
  if (typeof remote !== "string" || remote === "") throw new Error(`.yrd.yml remote: must be a remote name or URL`)
  const target = raw.target ?? "main"
  if (typeof target !== "string" || target === "") throw new Error(`.yrd.yml target: must be a branch name`)
  const owner = raw.owner ?? "operator"
  if (typeof owner !== "string" || owner === "") throw new Error(`.yrd.yml owner: must be a seat name`)
  const notify = optionalString(raw, "notify")
  const scratch = optionalString(raw, "scratch")
  return { blob, checks: readChecks(raw.checks), declaresRemote: raw.remote !== undefined, notify, owner, remote, scratch, target }
}

export type Hints = Readonly<{
  remote?: string
  target?: string
  /** Why the commit's `.yrd.yml` hinted nothing, when it exists and could not be read. */
  problem?: string
}>

/**
 * What a submitter's own commit says about where its queue is: `remote:` and
 * `target:` (or the incumbent's `base:`) from its `.yrd.yml`, when that file
 * exists and reads. Hints for finding the target, never authority: the target's
 * declaration judges, so a branch that rewrites or breaks its own `.yrd.yml`
 * still submits and is judged by the target's rules, and D2 bills it at merge.
 * A file that exists and cannot be read hints nothing and says so in `problem`.
 */
export async function readHints(git: Git, commit: string): Promise<Hints> {
  const blob = await refAt(git, `${commit}:.yrd.yml`, "blob")
  if (blob === undefined) return {}
  let raw: unknown
  try {
    raw = Bun.YAML.parse(await git(["show", `${commit}:.yrd.yml`]))
  } catch (error) {
    return { problem: `.yrd.yml at ${commit.slice(0, 12)} does not parse: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!isRecord(raw)) return { problem: `.yrd.yml at ${commit.slice(0, 12)} is not a mapping` }
  const remote = typeof raw.remote === "string" && raw.remote !== "" ? raw.remote : undefined
  const target = typeof raw.target === "string" && raw.target !== "" ? raw.target : typeof raw.base === "string" && raw.base !== "" ? raw.base : undefined
  return { ...(remote === undefined ? {} : { remote }), ...(target === undefined ? {} : { target }) }
}

/**
 * Today's shape, kept: a list of single-key mappings, `- name: {run, …}`.
 * `on:` names the phases, `submit`, `merge` or both; absent means merge.
 */
function readChecks(value: unknown): readonly QueueCheck[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(".yrd.yml checks: must be a list")
  return value.map((item, index) => {
    if (!isRecord(item) || Object.keys(item).length !== 1) {
      throw new Error(`.yrd.yml checks[${index}]: must be one mapping of the check's name to its declaration`)
    }
    const name = Object.keys(item)[0] ?? ""
    const body = item[name]
    if (!isRecord(body) || typeof body.run !== "string" || body.run === "") {
      throw new Error(`.yrd.yml checks[${index}] ${name}: needs run: <command>`)
    }
    const on = body.on
    if (on !== undefined) {
      const phases = Array.isArray(on) ? on : [on]
      for (const phase of phases) {
        if (phase !== "submit" && phase !== "merge") throw new Error(`.yrd.yml checks[${index}] ${name}: on: must be submit or merge`)
      }
    }
    const timeoutMs = body.timeoutMs
    if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || timeoutMs <= 0)) {
      throw new Error(`.yrd.yml checks[${index}] ${name}: timeoutMs: must be a positive number`)
    }
    const passthrough = body.environmentPassthrough
    if (passthrough !== undefined && (!Array.isArray(passthrough) || !passthrough.every((entry) => typeof entry === "string"))) {
      throw new Error(`.yrd.yml checks[${index}] ${name}: environmentPassthrough: must be a list of names`)
    }
    return {
      environmentPassthrough: passthrough as readonly string[] | undefined,
      name,
      on: on === undefined ? undefined : ((Array.isArray(on) ? on : [on]) as readonly ("submit" | "merge")[]),
      run: body.run,
      timeoutMs,
    }
  })
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
