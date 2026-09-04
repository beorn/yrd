/**
 * Every name the queue owns in the one store, which is the git repository
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design, Store).
 *
 * A change is named `<branch>@<sha>`, the branch and the full head sha, and
 * its ref is that name under `refs/yrd/<queue>/` (CTO, 2026-09-04): no
 * translation of the change name, which IS the tail of the ref. The queue is
 * exactly one percent-encoded ref component, so queues in one repository own
 * disjoint stores. Git allows `@`
 * in a ref name (only `@{` and a lone `@` are refused), so the name is read
 * from the right: the sha is the forty hex characters after the last `@`, and
 * everything before that `@` is the branch, which may itself carry `@`.
 *
 * Git refs are file paths, so a ref AT a name forbids any ref UNDER it. With
 * the sha inside the branch's last segment, one change's ref is never a
 * directory of another's, and a branch named like another change's path no
 * longer collides. The one spelling git still refuses — a branch with a
 * segment spelled exactly like an existing change's name, `<x>@<sha>`, and
 * more segments after it — fails the atomic push at submit, loudly. A branch
 * itself is `refs/heads/<branch>` at the queue's remote, git's own name.
 */

const YRD_REFS = "refs/yrd"

/**
 * Encode one queue branch as one ref/directory component. The allowed bytes
 * stay readable; every other UTF-8 byte is `%XX`, including `/` and `%`, so
 * encoding is injective and a queue can never escape its namespace.
 */
export function encodeQueueComponent(queue: string): string {
  if (queue === "") throw new Error("a queue needs a branch name; got an empty one")
  let encoded = ""
  for (const byte of new TextEncoder().encode(queue)) {
    const allowed =
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2e ||
      byte === 0x5f ||
      byte === 0x2d
    encoded += allowed ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
  }
  return encoded
}

/** The namespace one queue owns. */
export function queueRefPrefix(queue: string): string {
  return `${YRD_REFS}/${encodeQueueComponent(queue)}`
}

/** The operational pause ref one queue owns. */
export function pauseRef(queue: string): string {
  return `${queueRefPrefix(queue)}/pause`
}

/**
 * A change: a branch at a head. Everything that writes about one says both,
 * and its name — `<branch>@<head>` — is the one spelling of the pair.
 */
export type Change = Readonly<{ branch: string; head: string }>

/** The name of a change: `<branch>@<head>`. */
export function changeName(change: Change): string {
  const trimmed = change.branch.replace(/^\/+|\/+$/gu, "")
  if (trimmed === "") throw new Error("a change needs a branch name; got an empty one")
  return `${trimmed}@${change.head}`
}

/** The ref a change is: its name under its queue's namespace. */
export function changeRef(queue: string, change: Change): string {
  return refOfChange(queue, changeName(change))
}

/** The ref a change's NAME is, for a reader holding the name and not the pair. */
export function refOfChange(queue: string, name: string): string {
  return `${queueRefPrefix(queue)}/${name}`
}

/**
 * The branch and head a change name spells, or undefined when the text is not
 * one. The sha has no `@` and no `/`, so the last `@` of the whole name is the
 * one before it, and a name whose tail is not a full sha is not a change name.
 */
export function parseChangeName(name: string): Change | undefined {
  const cut = name.lastIndexOf("@")
  if (cut <= 0) return undefined
  const head = name.slice(cut + 1)
  if (!/^[0-9a-f]{40}$/u.test(head)) return undefined
  return { branch: name.slice(0, cut), head }
}

/** The change a ref names, or undefined when the ref is not one. */
export function parseChangeRef(queue: string, ref: string): Change | undefined {
  const prefix = `${queueRefPrefix(queue)}/`
  if (!ref.startsWith(prefix)) return undefined
  const name = ref.slice(prefix.length)
  if (name === "pause") return undefined
  return parseChangeName(name)
}
