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
import type { CheckSpec } from "./check.ts"

/**
 * A queue's target: the branch it lands on, and the remote that holds it,
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

/** A target as it is written and read: `<remote>#<branch>`. */
export function targetName(target: Target): string {
  return `${target.remote}#${target.branch}`
}

/**
 * The target a string spells, or undefined when it is not one. Read from the
 * RIGHT, because the remote may be a URL and a URL may carry a `#`, while a
 * branch name may not.
 */
export function parseTarget(text: string): Target | undefined {
  const cut = text.lastIndexOf("#")
  if (cut <= 0) return undefined
  const branch = text.slice(cut + 1)
  if (branch === "") return undefined
  return { branch, remote: text.slice(0, cut) }
}

/** What a declaration that does not spell a target is told, in one sentence. */
const TARGET_GRAMMAR = "must be <remote>#<branch>, e.g. origin#main"

export type QueueConfig = Readonly<{
  /** The branch the queue lands on, at the remote holding it; `origin#main` unless declared. */
  target: Target
  checks: readonly CheckSpec[]
  /** One shell command run in every fresh worktree the queue makes, before any check runs in it. */
  setup?: string
  /**
   * The command that delivers one message, a JSON record on stdin. The record
   * says the ROLE it is for, `submitter` or `owner`; which seat wears the
   * owner's belongs to that command's own arguments, never to the queue.
   */
  notify?: string
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
  const declared = raw.target ?? "origin#main"
  const target = typeof declared === "string" ? parseTarget(declared) : undefined
  if (target === undefined) throw new Error(`.yrd.yml target: ${TARGET_GRAMMAR}`)
  const notify = optionalString(raw, "notify")
  const setup = optionalString(raw, "setup")
  return { blob, checks: readChecks(raw.checks), notify, setup, target }
}

export type Hints = Readonly<{
  /** The target the file names, when it names one this reader understands. */
  target?: Target
  /** Why the commit's `.yrd.yml` hinted nothing, when it exists and could not be read. */
  problem?: string
}>

/**
 * What a commit's `.yrd.yml` says about where its queue is: `target:`, when the
 * file exists and reads. This is a hint for FINDING the queue, never authority:
 * the declaration at the target is what judges, so a branch that rewrites or
 * breaks its own `.yrd.yml` still submits and is judged by the target's rules,
 * and D2 bills it at merge. A file that exists and cannot be read hints nothing
 * and says so in `problem`, and so does one whose `target:` this reader does
 * not understand — including the two-key shape it used to have, where `remote:`
 * and a bare branch name each defaulted on their own.
 *
 * `where` names the file in `problem`.
 */
export function hintsIn(text: string, where = ".yrd.yml"): Hints {
  let raw: unknown
  try {
    raw = Bun.YAML.parse(text)
  } catch (error) {
    return { problem: `${where} does not parse: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!isRecord(raw)) return { problem: `${where} is not a mapping` }
  if (raw.remote !== undefined) {
    return { problem: `${where} names remote:, which is now the left side of target: ${TARGET_GRAMMAR}` }
  }
  if (raw.target === undefined) return {}
  const target = typeof raw.target === "string" ? parseTarget(raw.target) : undefined
  if (target === undefined) return { problem: `${where} target: ${TARGET_GRAMMAR}` }
  return { target }
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
// submodules and nothing else, so the target says how to finish it once
// instead of every check prefixing its own `run:` with the same install.
const TOP_KEYS = ["target", "checks", "setup", "notify"] as const

/**
 * A key the declaration used to read, and where its meaning went. A typo is
 * refused the same way, with the known keys listed; a RETIRED key is refused
 * with the one sentence that cures it, because "unknown key workdir" tells a
 * reader that the queue forgot how to write somewhere, not where to say it now.
 */
const RETIRED: Readonly<Record<string, string>> = {
  remote: `the remote is the left side of the target, which ${TARGET_GRAMMAR}`,
  scratch: "the queue's working directory is `git config yrd.workdir` in the repository the command runs in, not a declaration key",
  workdir: "the queue's working directory is `git config yrd.workdir` in the repository the command runs in, not a declaration key",
}
const CHECK_KEYS = ["run", "on", "timeoutMs", "environmentPassthrough", "scripts"] as const

/** A key the queue does not read is a typo or a retired mechanism; either is said out loud, never ignored. */
function onlyKeys(record: Record<string, unknown>, known: readonly string[], where: string): void {
  const unknown = Object.keys(record).filter((key) => !known.includes(key))
  if (unknown.length === 0) return
  const retired = unknown.map((key) => RETIRED[key]).filter((cure): cure is string => cure !== undefined)
  throw new Error(
    `${where}: unknown key ${unknown.join(", ")} (known: ${known.join(", ")})` +
      (retired.length === 0 ? "" : `; ${retired.join("; ")}`),
  )
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
