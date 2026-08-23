/**
 * Turning a remote ref into the facts `classifyPushedRef` judges.
 *
 * The predicate is pure and this is the only place that touches git, which is
 * the split that makes the judgement testable without a repository. Everything
 * here is a deliberate answer to a way one of us got it wrong in one evening.
 */
import type { PayloadKind, PinDirection, PushedRefFact } from "./uncarried.ts"

/** The git reads this gatherer needs, injected so the caller owns process
 * spawning and tests need no repository. Each returns raw stdout. */
export type RefGit = Readonly<{
  /** `git -C <repo> <args...>`, trimmed stdout; throws on non-zero. */
  run(repo: string, args: readonly string[]): Promise<string>
  /** Same, but a non-zero exit yields undefined instead of throwing — for the
   * questions where "cannot answer" is a real answer rather than a fault. */
  optional(repo: string, args: readonly string[]): Promise<string | undefined>
}>

export type GatherOptions = Readonly<{
  repo: string
  base: string
  /** Ref-local observation/update clock selected once by the enumerator. */
  observedAtMs: number
  /** Refs already carried by a change, so the sweep can skip them. */
  carriedBranches: ReadonlySet<string>
  /** Gitlink paths standing on the base, discovered from tree mode 160000 —
   * never guessed from a path shape. */
  gitlinkPaths: ReadonlySet<string>
  /** Earlier revisions of this ref's series the sweep collapsed into it. Only
   * the enumerator can know this; it is carried through rather than derived. */
  absorbedRevisions: number
}>

/**
 * Which way a submodule pin moves, answered IN THE SUBMODULE REPO.
 *
 * Running this from the superproject is the trap that cost two seats an evening:
 * the superproject's object store cannot read submodule objects at all — not the
 * branch's, and not even the base's own current pin — so every comparison there
 * fails structurally and the failure looks like a verdict.
 */
async function pinDirection(
  git: RefGit,
  submoduleRepo: string,
  basePin: string,
  branchPin: string,
): Promise<PinDirection> {
  if (basePin === branchPin) return "aligned"
  const contains = async (ancestor: string, descendant: string): Promise<boolean | undefined> => {
    const out = await git.optional(submoduleRepo, ["merge-base", "--is-ancestor", ancestor, descendant])
    return out === undefined ? undefined : true
  }
  // A missing object is NOT a direction. If either side is unreadable here the
  // honest answer is that we could not compare, and the caller must not receive
  // a cheerful "aligned" for it.
  const forward = await contains(basePin, branchPin)
  const backward = await contains(branchPin, basePin)
  if (forward === true) return "forward"
  if (backward === true) return "backward"
  return "diverged"
}

/**
 * Gather the facts for one remote ref.
 *
 * The ordering matters: cheap disqualifiers first, so a sweep over thousands of
 * refs does no submodule-repo work for the ones it will discard anyway. On this
 * fleet 1,502 of 1,546 uncarried refs are older than a week and die at the age
 * bound before any git object is read.
 */
export async function gatherPushedRefFact(git: RefGit, ref: string, options: GatherOptions): Promise<PushedRefFact> {
  const { repo, base, observedAtMs, carriedBranches, gitlinkPaths, absorbedRevisions } = options
  const tipSha = await git.run(repo, ["rev-parse", `${ref}^{commit}`])

  // Three-dot: what this ref CHANGED relative to the merge base. Two-dot would
  // include everything the base gained since, and would call a ref that touched
  // nothing a gitlink change.
  const changed = (await git.run(repo, ["diff", "--name-only", `${base}...${ref}`]))
    .split("\n")
    .filter((line) => line !== "")
  const changedGitlinks = changed.filter((path) => gitlinkPaths.has(path))
  const payloadKind: PayloadKind =
    changed.length > 0 && changedGitlinks.length === changed.length ? "gitlink-only" : "content"

  // ONLY the gitlinks this ref actually modified. A pin the ref never touched
  // is irrelevant: git's three-way merge keeps the base's side, so comparing a
  // recorded-but-untouched pin invents a revert that a real merge would not do.
  let direction: PinDirection = "none"
  for (const path of changedGitlinks) {
    const basePin = await git.optional(repo, ["rev-parse", `${base}:${path}`])
    const branchPin = await git.optional(repo, ["rev-parse", `${ref}:${path}`])
    if (basePin === undefined || branchPin === undefined) {
      direction = "diverged"
      break
    }
    const one = await pinDirection(git, `${repo}/${path}`, basePin, branchPin)
    // Worst case wins across multiple submodules: one backward pin is enough to
    // make the whole ref unsafe to carry as-is.
    if (one === "diverged") {
      direction = "diverged"
      break
    }
    if (one === "backward") direction = "backward"
    else if (direction === "none") direction = one
  }

  // Patch-equivalence, and it is meaningless for a gitlink payload — a pointer
  // bump is a unique patch by construction even when the content behind it
  // merged. The predicate ignores these for gitlink-only refs; they are gathered
  // anyway so a finding can report them without a second pass.
  const cherry = (await git.optional(repo, ["cherry", base, ref])) ?? ""
  const lines = cherry.split("\n").filter((line) => line !== "")
  return {
    ref,
    tipSha,
    observedAtMs,
    carried: carriedBranches.has(ref),
    uniqueCommits: lines.filter((line) => line.startsWith("+")).length,
    equivalentCommits: lines.filter((line) => line.startsWith("-")).length,
    payloadKind,
    pinDirection: direction,
    absorbedRevisions,
  }
}
