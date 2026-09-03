/**
 * A change's facts, which are its commits ([plan](../../../../pm/@i/10-yrd/plan.md)
 * § The final design, The change).
 *
 * A change is the ref `refs/yrd/changes/<branch>@<sha>`, its name under the
 * one prefix. Its commits are the
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
 *   `Fact:` naming the kind, `Change:` naming the change the fact is about and
 *   `Target:` naming the branch it lands on, both on every fact,
 *   `Opened:`, `Submitter:` and `Work-Item:` carried forward from the first
 *   fact, a sent fact naming who it went to (`To:`) and how it went
 *   (`Delivery: sent`, `logged` or `failed`), and an ended fact's result
 *   carried onto its sent fact, so the tip
 *   fact's trailers are the whole answer about the change and one
 *   `for-each-ref` answers `yrd queue list` with no history walk.
 *
 * The genesis is one object: an empty-tree commit with a fixed author and
 * time, so it has the same sha in every repository and is written at most
 * once per repository.
 *
 * Writing uses `update-ref` with the expected old value, so two writers racing
 * on one change lose loudly instead of interleaving.
 */

import { refAt } from "./git.ts"
import { changeName, changeRef, type Change } from "./refs.ts"

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
  /** The change the fact is about: a branch at a head, written as the one `Change:` trailer. */
  change: Change
  target: string
  kind: FactKind
  subject: string
  trailers?: readonly (readonly [string, string])[]
}>

/**
 * The trailers every fact carries forward from the fact before it, so the tip
 * fact alone identifies the change: when it was first opened (its place in
 * line), by whom, and for which work item. Written on the first fact from the
 * write itself and copied on every later one; a later write naming one of
 * them again (a retry names its submitter) wins.
 */
const CARRIED = ["Opened", "Submitter", "Work-Item"] as const

/**
 * One fact, as every reader of a commit asks for it: the sha, the committer
 * date, git's own reading of the trailer block, and the raw message. `%B` is
 * last because it is the one field that holds newlines. `%x00` separates them.
 */
const FACT_FORMAT = "%H%x00%cI%x00%(trailers:only,unfold)%x00%B"

/**
 * The commit one fact IS, written onto `parent` — the fact the caller read this
 * change at, or undefined for a change's first fact, which gets the genesis and
 * the head instead. No ref moves: the object is the fact, and whoever pushes it
 * under a lease for `parent` is deciding whether it becomes the change's tip.
 *
 * The sha it returns is the id of what happened — a message about an ended
 * change carries it, so a resend after a crash is the same message rather than
 * a second one.
 */
export async function factCommit(git: Git, write: WriteFact, parent: string | undefined): Promise<string> {
  const parents = parent === undefined ? [await genesis(git), write.change.head] : [parent]
  const carried = parent === undefined ? [["Opened", new Date().toISOString()] as const] : await carriedFrom(git, parent)
  const named = new Set((write.trailers ?? []).map(([name]) => name))
  const message = factMessage({ ...write, trailers: [...carried.filter(([name]) => !named.has(name)), ...(write.trailers ?? [])] })
  const args = ["commit-tree", EMPTY_TREE]
  for (const on of parents) args.push("-p", on)
  return (await git([...args, "-m", message])).trim()
}

/**
 * Append one fact to a change's LOCAL ref, creating the change when this is its
 * first: read the tip, write the commit onto it, move the ref under a
 * compare-and-swap, so a second writer that read the same tip fails here
 * instead of silently overwriting the first. Git spells "the ref must not exist
 * yet" as the zero sha.
 *
 * `submit` writes this way, because the local ref is what its atomic push then
 * carries to the remote. A queue run does not: the remote's tip is its
 * authority and its own local ref is bookkeeping the next queue read
 * overwrites, so it writes the object with `factCommit` and leases the push.
 */
export async function appendFact(git: Git, write: WriteFact): Promise<string> {
  const ref = changeRef(write.change)
  const tip = await refAt(git, ref)
  const sha = await factCommit(git, write, tip)
  await git(["update-ref", ref, sha, tip ?? ABSENT])
  return sha
}

/** Write the genesis object if this repository lacks it, and return its sha. */
async function genesis(git: Git): Promise<string> {
  return (await git(["hash-object", "-w", "-t", "commit", "--stdin"], GENESIS_OBJECT)).trim()
}

/** The fact at `sha`. A commit there that is not a fact is loud: a change's ref holds only facts. */
export async function readFact(git: Git, sha: string): Promise<Fact> {
  const [id, at, block, body] = (await git(["log", "-1", `--format=${FACT_FORMAT}`, sha])).split("\x00")
  const fact =
    id === undefined || at === undefined || block === undefined || body === undefined
      ? undefined
      : factFrom(id.trim(), at, body, block)
  if (fact === undefined) throw new Error(`${sha.slice(0, 12)} is not a fact; a change's ref holds only facts`)
  return fact
}

/** The carried trailers of the fact at `sha`. */
async function carriedFrom(git: Git, sha: string): Promise<readonly (readonly [string, string])[]> {
  return (await readFact(git, sha)).trailers.filter(([name]) => (CARRIED as readonly string[]).includes(name))
}

/** Every fact of a change, oldest first. An unknown change reads as no facts. */
export async function readFacts(git: Git, change: Change): Promise<readonly Fact[]> {
  const ref = changeRef(change)
  if ((await refAt(git, ref)) === undefined) return []
  // %x00 separates the fields and %x01 the records, because a commit message
  // holds newlines and a naive split would cut a fact in half.
  const out = await git(["log", "--first-parent", `--format=${FACT_FORMAT}%x01`, ref])
  const facts: Fact[] = []
  for (const record of out.split("\x01")) {
    const row = record.trim()
    if (row === "") continue
    const [sha, at, block, body] = row.split("\x00")
    if (sha === undefined || at === undefined || block === undefined || body === undefined) continue
    const parsed = factFrom(sha, at, body, block)
    // The first-parent walk ends at the genesis, which carries no `Fact:`
    // trailer. That is where this change's history ends.
    if (parsed === undefined) break
    // The tip is the first fact this reads, so the one check that these facts
    // are in the format this code understands happens once, here.
    if (facts.length === 0) changeOf(parsed, ref)
    facts.push(parsed)
  }
  return facts.reverse()
}

/** The message one fact commit carries. */
export function factMessage(write: WriteFact): string {
  const lines = [write.subject, "", `Fact: ${write.kind}`, `Change: ${changeName(write.change)}`, `Target: ${write.target}`]
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

/**
 * The change a fact is about, from its `Change:` trailer — `<branch>@<head>`,
 * the one spelling of a change's name (refs.ts), which `parseChangeName` reads
 * back into a branch and a head. `where` names the ref, so the refusal below
 * says which change is unreadable.
 *
 * Loud when the fact carries none. Facts written before 2026-09-03 spelled the
 * change as a `Branch:` and `Head:` pair, and no reader here understands that
 * shape: reading it would mean two spellings of a change's name in the one
 * store, which is what the name exists to prevent. There is no compatibility
 * reader on purpose.
 */
export function changeOf(fact: Fact, where: string): string {
  const change = trailer(fact, "Change")
  if (change === undefined) {
    throw new Error(
      `${where} carries no Change: trailer at its fact ${fact.sha.slice(0, 12)}: these facts predate the ` +
        "2026-09-03 format and no reader understands them. The queue mechanic bundles and deletes them — " +
        "`git bundle create <file> refs/yrd/changes/*`, then delete the refs.",
    )
  }
  return change
}

/** Every value of a trailer, in order. */
export function trailers(fact: Fact, name: string): readonly string[] {
  return fact.trailers.filter(([key]) => key === name).map(([, value]) => value)
}

/** The kind a tip stands for: a sent fact stands for the ended state it repeats (`State:`, ruling A2). */
export function endedKind(tip: Fact): FactKind {
  if (tip.kind !== "sent") return tip.kind
  const state = trailer(tip, "State")
  return state === "merged" || state === "failed" || state === "stuck" ? state : "sent"
}

/**
 * The fact a commit is, from its sha, committer date, message and the trailer
 * block GIT read out of it; undefined when the commit is not one.
 *
 * The trailers are git's own reading, never a second parser of the same
 * bytes: a hand-rolled `^Key: value$` scan called every prose line that looks
 * like a trailer one — `Note: fix` in the middle of a body became a `Note`
 * trailer and stood in the derived state — while git knows a trailer block is
 * the LAST paragraph and folds a wrapped value back into one line.
 */
export function factFrom(sha: string, at: string, body: string, trailerBlock: string): Fact | undefined {
  const found: (readonly [string, string])[] = []
  for (const line of trailerBlock.split("\n")) {
    // git's own output, one trailer per line after `unfold`: the key is
    // everything before the first colon, which git has already validated.
    const colon = line.indexOf(":")
    if (colon <= 0) continue
    found.push([line.slice(0, colon), line.slice(colon + 1).replace(/^ /u, "")] as const)
  }
  const kind = found.find(([name]) => name === "Fact")?.[1]
  if (kind === undefined || !isFactKind(kind)) return undefined
  return { at: new Date(at), kind, sha, subject: body.split("\n")[0]?.trim() ?? "", trailers: found }
}

function isFactKind(value: string): value is FactKind {
  return (FACT_KINDS as readonly string[]).includes(value)
}
