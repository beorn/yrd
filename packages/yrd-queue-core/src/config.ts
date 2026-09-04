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

import type { Git } from "./records.ts"
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

/**
 * The queue's own name: its target with the remote resolved to a URL and
 * normalized — `<host>/<path>#<branch>`.
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
  return `${normalizedRemote(remoteUrl)}#${target.branch}`
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

/** The one line that shows what `notify:` looks like, wherever it has to be shown. */
const NOTIFY_SHAPE = 'notify: [- <name>: {on: [merged, failed], run: <command>}]'

/** The endings the queue can notify about; it has no others to run a command on. */
export const ENDINGS = ["merged", "failed", "stuck", "merged-direct"] as const

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

export type QueueConfig = Readonly<{
  /** The branch the queue lands on, at the remote holding it; `origin#main` unless declared. */
  target: Target
  checks: readonly CheckSpec[]
  /** One shell command run in every fresh worktree the queue makes, before any check runs in it. */
  setup?: string
  /** What the queue notifies, per ending; empty when the declaration names none. */
  notify: readonly Notifier[]
  /** The blob the declaration was read from, recorded on every checked record. */
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
  const notify = readNotify(raw.notify)
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
    on: (entry.on ?? ENDINGS) as readonly Ending[],
    run: entry.run,
  }))
}

/**
 * `checks:`, the same named list. `on:` names the phases, `submit`, `merge` or
 * both; absent means merge.
 */
function readChecks(value: unknown): readonly CheckSpec[] {
  return namedCommands(value, "checks", ["submit", "merge"], ["timeoutMs", "environmentPassthrough", "scripts"]).map((entry, index) => {
    const { body, name } = entry
    const where = `.yrd.yml checks[${index}] ${name}`
    const scripts = body.scripts
    if (scripts !== undefined && (!Array.isArray(scripts) || !scripts.every((path) => typeof path === "string" && path !== ""))) {
      throw new Error(`${where}: scripts: must be a list of repository paths`)
    }
    const timeoutMs = body.timeoutMs
    if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || timeoutMs <= 0)) {
      throw new Error(`${where}: timeoutMs: must be a positive number`)
    }
    const passthrough = body.environmentPassthrough
    if (passthrough !== undefined && (!Array.isArray(passthrough) || !passthrough.every((named) => typeof named === "string"))) {
      throw new Error(`${where}: environmentPassthrough: must be a list of names`)
    }
    return {
      environmentPassthrough: passthrough as readonly string[] | undefined,
      name,
      on: entry.on as readonly ("submit" | "merge")[] | undefined,
      run: entry.run,
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
  owner: `the queue addresses nobody: a notify: entry decides who hears about an ending, in its own arguments (${NOTIFY_SHAPE})`,
  remote: `the remote is the left side of the target, which ${TARGET_GRAMMAR}`,
  scratch: "the queue workdir is `git config yrd.workdir` in the repository the command runs in, not a declaration key",
  workdir: "the queue workdir is `git config yrd.workdir` in the repository the command runs in, not a declaration key",
}

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
