/**
 * The sweep that turns the uncarried predicate into a rail.
 *
 * `classifyPushedRef` judges ONE ref from facts, and `gatherPushedRefFact`
 * produces those facts for one ref. Neither enumerates, so until this module
 * existed the predicate had no caller and the rail it was built for could not
 * report anything. That is the whole gap this closes.
 *
 * ORDERING IS THE DESIGN, not an optimisation. One `for-each-ref` yields every
 * ref with its commit date in a single process, so the carried set and the age
 * bound disqualify the overwhelming majority before any per-ref git object is
 * read. Measured on this fleet: 1,502 of 1,546 uncarried refs are older than a
 * week. Gathering facts first would mean thousands of `diff` invocations to
 * discard almost all of them.
 */
import { classifyPushedRef, type UncarriedFinding, type UncarriedOptions } from "./uncarried.ts"
import { gatherPushedRefFact, type RefGit } from "./uncarried-facts.ts"

export type SweepOptions = UncarriedOptions &
  Readonly<{
    repo: string
    /** Base branch the refs are judged against, e.g. "main". */
    base: string
    /** Branch names that already have a merge request. */
    carriedBranches: ReadonlySet<string>
    /** Ref namespace to sweep, e.g. "refs/remotes/origin". */
    namespace: string
  }>

/**
 * What a sweep saw, not just what it found.
 *
 * `findings: []` alone cannot distinguish a healthy queue from a sweep that
 * enumerated nothing — a broken namespace, a repo with no remote refs, and a
 * genuinely clean fleet all render as "no findings". The counts are the
 * denominator that makes the zero mean something, and the rail is required to
 * show them together.
 */
export type SweepResult = Readonly<{
  findings: readonly UncarriedFinding[]
  /** Refs the namespace yielded. Zero here is a broken sweep, not a clean one. */
  scanned: number
  /** Disqualified by the carried set, before any per-ref git work. */
  carried: number
  /** Disqualified by the age bound, before any per-ref git work. */
  outsideAgeBound: number
  /** Facts gathered — the refs that actually cost git object reads. */
  examined: number
}>

/** Gitlink paths standing on the base, read from tree mode 160000. Never
 * guessed from a path shape: `vendor/` holds plain directories too. */
async function gitlinkPathsOf(git: RefGit, repo: string, base: string): Promise<ReadonlySet<string>> {
  const tree = await git.run(repo, ["ls-tree", "-r", base])
  const paths = tree
    .split("\n")
    .filter((line) => line.startsWith("160000 "))
    .map((line) => line.slice(line.indexOf("\t") + 1))
  return new Set(paths)
}

/**
 * The branch name a merge request would call this ref.
 *
 * `%(refname:short)` renders `refs/remotes/origin/task/x` as `origin/task/x`,
 * while a merge request records the branch as `task/x`. Comparing the two
 * directly matches almost nothing, and the failure is invisible in a unit test
 * whose fixture uses the same string on both sides: the sweep reports carried
 * work as stranded and the rail cries wolf on its first real run. Measured
 * before the fix — 4,784 refs scanned, 7 recognised as carried, against 810
 * live merge requests.
 */
function branchOf(ref: string, namespace: string): string {
  const remote = namespace.startsWith("refs/remotes/") ? `${namespace.slice("refs/remotes/".length)}/` : ""
  return remote !== "" && ref.startsWith(remote) ? ref.slice(remote.length) : ref
}

type DatedRef = Readonly<{ ref: string; pushedAtMs: number }>

/** One process for every ref and its commit date. The NUL separator is not
 * decoration — branch names may contain anything a ref format allows, and a
 * space-split would silently truncate them. */
async function datedRefs(git: RefGit, repo: string, namespace: string): Promise<readonly DatedRef[]> {
  const listing = await git.run(repo, ["for-each-ref", "--format=%(refname:short)%00%(committerdate:unix)", namespace])
  return listing
    .split("\n")
    .filter((line) => line !== "")
    .flatMap((line) => {
      const separator = line.lastIndexOf("\0")
      if (separator < 0) return []
      const seconds = Number(line.slice(separator + 1))
      if (!Number.isFinite(seconds)) return []
      return [{ ref: line.slice(0, separator), pushedAtMs: seconds * 1000 }]
    })
}

/**
 * Sweep a ref namespace and return every genuinely stranded ref, with the
 * counts that make an empty result readable.
 */
export async function sweepUncarriedRefs(git: RefGit, options: SweepOptions): Promise<SweepResult> {
  const { repo, base, carriedBranches, namespace } = options
  const refs = await datedRefs(git, repo, namespace)
  if (refs.length === 0) {
    // Loud on purpose. Every other zero in this result is a fact about the
    // fleet; this one is a fact about the sweep, and reporting it as "nothing
    // stranded" is the silent failure that kills monitoring rails.
    throw new Error(
      `yrd: uncarried sweep enumerated no refs under '${namespace}' in '${repo}' — the namespace is wrong or the repo has no remote refs`,
    )
  }

  let carried = 0
  let outsideAgeBound = 0
  const survivors: DatedRef[] = []
  for (const candidate of refs) {
    if (carriedBranches.has(branchOf(candidate.ref, namespace))) {
      carried += 1
      continue
    }
    const ageMs = options.nowMs - candidate.pushedAtMs
    if (ageMs < options.ttlMs || ageMs > options.ageBoundMs) {
      outsideAgeBound += 1
      continue
    }
    survivors.push(candidate)
  }

  const gitlinkPaths = survivors.length === 0 ? new Set<string>() : await gitlinkPathsOf(git, repo, base)
  const findings: UncarriedFinding[] = []
  for (const survivor of survivors) {
    const fact = await gatherPushedRefFact(git, survivor.ref, { repo, base, carriedBranches, gitlinkPaths })
    const finding = classifyPushedRef(fact, options)
    if (finding !== undefined) findings.push(finding)
  }

  return {
    findings: findings.toSorted((left, right) => right.ageMs - left.ageMs),
    scanned: refs.length,
    carried,
    outsideAgeBound,
    examined: survivors.length,
  }
}
