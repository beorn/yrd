/**
 * The queue's declaration of itself, read from the commit of the branch it
 * lands on ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design, The
 * queue run: gate authority lives on the protected side).
 *
 * `.yrd.yml` is read with `git show <branch>:.yrd.yml`, never from a change's
 * worktree, so a change that edits its own checks is judged by the branch's
 * version and the edit takes effect for the next change. The parser is Bun's
 * own YAML, the same one the incumbent uses, so one file means one thing.
 *
 * A malformed declaration throws with the path that is wrong. A queue that
 * guessed at its own configuration would judge every change by that guess.
 */

import type { Git } from "./facts.ts"
import { refAt } from "./git.ts"
import type { CheckSpec } from "./check.ts"

export type QueueConfig = Readonly<{
  /** The queue's remote: a remote name, or a URL the CLI adds under the name `yrd`; `origin` unless declared. */
  remote: string
  /** The branch the queue lands on; `main` unless declared. */
  branch: string
  checks: readonly CheckSpec[]
  /** One shell command run in every fresh worktree the queue makes, before any check runs in it. */
  setup?: string
  /**
   * The command that delivers one message, a JSON record on stdin. The record
   * says the ROLE it is for, `submitter` or `owner`; who the owner is belongs
   * to that command's own arguments, never to the queue.
   */
  notify?: string
  /** The queue's working directory: its checkouts, its check logs, and the temp root every check gets as `TMPDIR`; on the root filesystem. */
  workdir?: string
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
  onlyKeys(raw, TOP_KEYS, ".yrd.yml")
  const remote = raw.remote ?? "origin"
  if (typeof remote !== "string" || remote === "") throw new Error(`.yrd.yml remote: must be a remote name or URL`)
  const branch = raw.branch ?? "main"
  if (typeof branch !== "string" || branch === "") throw new Error(`.yrd.yml branch: must be a branch name`)
  const notify = optionalString(raw, "notify")
  const workdir = optionalString(raw, "workdir")
  const setup = optionalString(raw, "setup")
  return { blob, branch, checks: readChecks(raw.checks), notify, remote, setup, workdir }
}

export type Hints = Readonly<{
  remote?: string
  branch?: string
  /** Why the commit's `.yrd.yml` hinted nothing, when it exists and could not be read. */
  problem?: string
}>

/**
 * What a commit's `.yrd.yml` says about where its queue is: `remote:` and
 * `branch:`, when the file exists and reads. Read on a submitter's own commit
 * these are hints for finding the queue, never authority: the queue's branch
 * holds the declaration that judges, so a change that rewrites or breaks its
 * own `.yrd.yml` still submits and is judged by the branch's rules, and D2
 * bills it at merge. A file that exists and cannot be read hints nothing and
 * says so in `problem`.
 */
export async function readHints(git: Git, commit: string): Promise<Hints> {
  const blob = await refAt(git, `${commit}:.yrd.yml`, "blob")
  if (blob === undefined) return {}
  return hintsIn(await git(["show", `${commit}:.yrd.yml`]), `.yrd.yml at ${commit.slice(0, 12)}`)
}

/** `readHints` on the text of a declaration already in hand; `where` names it in `problem`. */
export function hintsIn(text: string, where = ".yrd.yml"): Hints {
  let raw: unknown
  try {
    raw = Bun.YAML.parse(text)
  } catch (error) {
    return { problem: `${where} does not parse: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!isRecord(raw)) return { problem: `${where} is not a mapping` }
  const remote = typeof raw.remote === "string" && raw.remote !== "" ? raw.remote : undefined
  const branch = typeof raw.branch === "string" && raw.branch !== "" ? raw.branch : undefined
  return { ...(remote === undefined ? {} : { remote }), ...(branch === undefined ? {} : { branch }) }
}

/**
 * Today's shape, kept: a list of single-key mappings, `- name: {run, …}`.
 * `on:` names the phases, `submit`, `merge` or both; absent means merge.
 */
function readChecks(value: unknown): readonly CheckSpec[] {
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
    onlyKeys(body, CHECK_KEYS, `.yrd.yml checks[${index}] ${name}`)
    const scripts = body.scripts
    if (scripts !== undefined && (!Array.isArray(scripts) || !scripts.every((entry) => typeof entry === "string" && entry !== ""))) {
      throw new Error(`.yrd.yml checks[${index}] ${name}: scripts: must be a list of repository paths`)
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
      scripts: scripts as readonly string[] | undefined,
      timeoutMs,
    }
  })
}

// Ruling A6's set, plus `setup:` (2026-09-02): every key here is read by the
// queue, and one it does not read is still refused. A fresh worktree has
// submodules and nothing else, so the declaration says how to finish it once
// instead of every check prefixing its own `run:` with the same install.
const TOP_KEYS = ["remote", "branch", "checks", "setup", "notify", "workdir"] as const
const CHECK_KEYS = ["run", "on", "timeoutMs", "environmentPassthrough", "scripts"] as const

/** A key the queue does not read is a typo or a retired mechanism; either is said out loud, never ignored. */
function onlyKeys(record: Record<string, unknown>, known: readonly string[], where: string): void {
  const unknown = Object.keys(record).filter((key) => !known.includes(key))
  if (unknown.length > 0) throw new Error(`${where}: unknown key ${unknown.join(", ")} (known: ${known.join(", ")})`)
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
