/**
 * A change's facts, which are its commits ([plan](../../../../pm/@i/10-yrd/plan.md)
 * § The final design, The change).
 *
 * A change is the ref `refs/yrd/changes/<branch>/<sha>`. Its commits are the
 * only record the queue keeps: opened, then checked, then ended, then sent.
 * Each fact is ONE commit, written once and never amended, so the ref only
 * moves forward and a reader can prove what happened from git alone.
 *
 * Shape of a fact commit, and why:
 * - the tree is empty, because yrd stores no content of its own;
 * - the opened fact has two parents, the genesis commit first and the change's
 *   head second, so the head stays reachable from the ref and survives every
 *   prune, and `git log --first-parent` from the tip reads exactly the facts
 *   and stops at the genesis (measured 2026-09-02: with the head as the only
 *   parent, a plain log walks the whole project history);
 * - every later fact has one parent, the fact before it; the merge commit is
 *   never a parent;
 * - the message is a prose first line, then trailers, one meaning each, with
 *   `Fact:` naming the kind and `Branch:`, `Head:`, `Target:` on every fact,
 *   so the tip fact's trailers are the whole answer about the change.
 *
 * The genesis is one object: an empty-tree commit with a fixed author and
 * time, so it has the same sha in every repository and is written at most
 * once per repository.
 *
 * Writing uses `update-ref` with the expected old value, so two writers racing
 * on one change lose loudly instead of interleaving.
 */

import { refAt } from "./git.ts"
import { changeRef } from "./refs.ts"

/** The kinds a fact can be. The vocabulary is closed. */
export const FACT_KINDS = ["opened", "checked", "merged", "failed", "stuck", "sent"] as const

export type FactKind = (typeof FACT_KINDS)[number]

export type Fact = Readonly<{
  kind: FactKind
  /** The fact commit's own sha — the id of what happened. */
  sha: string
  /** When the fact was written, from the commit itself. */
  at: Date
  /** The prose first line. */
  subject: string
  /** Trailers in order, repeats kept: a change can carry many `Check:` lines. */
  trailers: readonly (readonly [string, string])[]
}>

/** One git invocation, returning its stdout; `input` is its stdin. Throws on a non-zero exit. */
export type Git = (args: readonly string[], input?: string) => Promise<string>

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
const ABSENT = "0".repeat(40)
/** The one genesis object, byte for byte as git stores it; its sha follows from these bytes. */
const GENESIS_OBJECT = `tree ${EMPTY_TREE}\nauthor yrd <yrd@yrd> 0 +0000\ncommitter yrd <yrd@yrd> 0 +0000\n\nyrd: genesis\n`

export type WriteFact = Readonly<{
  branch: string
  head: string
  target: string
  kind: FactKind
  subject: string
  trailers?: readonly (readonly [string, string])[]
}>

/**
 * Append one fact to a change, creating the change when this is its first.
 * Returns the new fact's sha, which is the id of what happened — a message
 * about an ended change carries it, so a resend after a crash is the same
 * message rather than a second one.
 */
export async function appendFact(git: Git, write: WriteFact): Promise<string> {
  const ref = changeRef(write.branch, write.head)
  const tip = await refAt(git, ref)
  const parents = tip === undefined ? [await genesis(git), write.head] : [tip]
  const message = factMessage(write)
  const args = ["commit-tree", EMPTY_TREE]
  for (const parent of parents) args.push("-p", parent)
  const sha = (await git([...args, "-m", message])).trim()
  // The expected old value makes this a compare-and-swap: a second writer that
  // read the same tip fails here instead of silently overwriting the first.
  // Git spells "the ref must not exist yet" as the zero sha.
  await git(["update-ref", ref, sha, tip ?? ABSENT])
  return sha
}

/** Write the genesis object if this repository lacks it, and return its sha. */
async function genesis(git: Git): Promise<string> {
  return (await git(["hash-object", "-w", "-t", "commit", "--stdin"], GENESIS_OBJECT)).trim()
}

/** Every fact of a change, oldest first. An unknown change reads as no facts. */
export async function readFacts(git: Git, branch: string, head: string): Promise<readonly Fact[]> {
  const ref = changeRef(branch, head)
  if ((await refAt(git, ref)) === undefined) return []
  // %x00 separates the fields and %x01 the records, because a commit message
  // holds newlines and a naive split would cut a fact in half.
  const format = "%H%x00%cI%x00%B%x01"
  const out = await git(["log", "--first-parent", `--format=${format}`, ref])
  const facts: Fact[] = []
  for (const record of out.split("\x01")) {
    const row = record.trim()
    if (row === "") continue
    const [sha, at, body] = row.split("\x00")
    if (sha === undefined || at === undefined || body === undefined) continue
    const parsed = parseFact(sha, at, body)
    // The first-parent walk ends at the genesis, which carries no `Fact:`
    // trailer. That is where this change's history ends.
    if (parsed === undefined) break
    facts.push(parsed)
  }
  return facts.reverse()
}

/** The message one fact commit carries. */
export function factMessage(write: WriteFact): string {
  const lines = [write.subject, "", `Fact: ${write.kind}`, `Branch: ${write.branch}`, `Head: ${write.head}`, `Target: ${write.target}`]
  for (const [name, value] of write.trailers ?? []) {
    if (value.includes("\n")) throw new Error(`trailer ${name} carries a newline; one trailer is one line`)
    lines.push(`${name}: ${value}`)
  }
  return `${lines.join("\n")}\n`
}

/** The first value of a trailer, or undefined. */
export function trailer(fact: Fact, name: string): string | undefined {
  return fact.trailers.find(([key]) => key === name)?.[1]
}

/** Every value of a trailer, in order. */
export function trailers(fact: Fact, name: string): readonly string[] {
  return fact.trailers.filter(([key]) => key === name).map(([, value]) => value)
}

function parseFact(sha: string, at: string, body: string): Fact | undefined {
  const lines = body.split("\n")
  const subject = lines[0]?.trim() ?? ""
  const found: (readonly [string, string])[] = []
  for (const line of lines.slice(1)) {
    const match = /^([A-Za-z][A-Za-z0-9-]*): (.*)$/u.exec(line.trim())
    if (match?.[1] !== undefined && match[2] !== undefined) found.push([match[1], match[2]])
  }
  const kind = found.find(([name]) => name === "Fact")?.[1]
  if (kind === undefined || !isFactKind(kind)) return undefined
  return { at: new Date(at), kind, sha, subject, trailers: found }
}

function isFactKind(value: string): value is FactKind {
  return (FACT_KINDS as readonly string[]).includes(value)
}
