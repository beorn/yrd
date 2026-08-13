/**
 * The sweep that turns the uncarried predicate into a rail.
 *
 * `classifyPushedRef` judges ONE ref from facts, and `gatherPushedRefFact`
 * produces those facts for one ref. Neither enumerates, so until this module
 * existed the predicate had no caller and the rail it was built for could not
 * report anything. That is the whole gap this closes.
 *
 * ORDERING IS THE DESIGN, not an optimisation. One `for-each-ref` enumerates
 * the population, then one reflog scan supplies ref-local update clocks. The
 * carried set and age bound still disqualify the overwhelming majority before
 * any per-ref object read. Commit dates are payload metadata, not push clocks.
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
    /** Restrict the normal operator rail to authored branches. Explicit
     * diagnostic namespaces omit this and inspect every ref they selected. */
    population?: "authored"
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
  /** Non-authored refs excluded from the normal operator population. */
  excluded: number
  /** Disqualified by the age bound, before any per-ref git work. */
  outsideAgeBound: number
  /** Facts gathered — the refs that actually cost git object reads. */
  examined: number
  /** Legacy refs with no retained reflog entry, aged conservatively from their
   * tip commit and reported so a fallback can never masquerade as full proof. */
  clockFallbacks: number
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
  if (!namespace.startsWith("refs/remotes/")) return ref
  const remote = namespace.slice("refs/remotes/".length).split("/", 1)[0]
  if (remote === undefined || remote === "") return ref
  const fullPrefix = `refs/remotes/${remote}/`
  if (ref.startsWith(fullPrefix)) return ref.slice(fullPrefix.length)
  const shortPrefix = `${remote}/`
  return ref.startsWith(shortPrefix) ? ref.slice(shortPrefix.length) : ref
}

function isAuthoredBranch(branch: string, base: string): boolean {
  return branch !== "HEAD" && branch !== base && !branch.startsWith("yrd/candidates/")
}

type DatedRef = Readonly<{ ref: string; committedAtMs: number }>

/** One process for every ref and its commit date. The NUL separator is not
 * decoration — branch names may contain anything a ref format allows, and a
 * space-split would silently truncate them. */
async function datedRefs(git: RefGit, repo: string, namespace: string): Promise<readonly DatedRef[]> {
  const listing = await git.run(repo, ["for-each-ref", "--format=%(refname)%00%(committerdate:unix)", namespace])
  return listing
    .split("\n")
    .filter((line) => line !== "")
    .flatMap((line) => {
      const separator = line.lastIndexOf("\0")
      if (separator < 0) return []
      const seconds = Number(line.slice(separator + 1))
      if (!Number.isFinite(seconds)) return []
      return [{ ref: line.slice(0, separator), committedAtMs: seconds * 1000 }]
    })
}

/** Latest local observation of each ref update. `--date=unix` makes `%gD`
 * render `refs/...@{<epoch>}`; the first row for a ref is its newest entry.
 * One aggregate scan avoids a process per ref. */
async function latestRefUpdates(
  git: RefGit,
  repo: string,
  refs: ReadonlySet<string>,
): Promise<ReadonlyMap<string, number>> {
  const listing = await git.run(repo, ["reflog", "show", "--all", "--date=unix", "--format=%gD"])
  const updates = new Map<string, number>()
  for (const line of listing.split("\n")) {
    const marker = line.lastIndexOf("@{")
    if (marker < 0 || !line.endsWith("}")) continue
    const ref = line.slice(0, marker)
    if (!refs.has(ref) || updates.has(ref)) continue
    const seconds = Number(line.slice(marker + 2, -1))
    if (Number.isFinite(seconds)) updates.set(ref, seconds * 1000)
  }
  return updates
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
  let excluded = 0
  let outsideAgeBound = 0
  let clockFallbacks = 0
  const uncarried: DatedRef[] = []
  for (const candidate of refs) {
    const branch = branchOf(candidate.ref, namespace)
    if (options.population === "authored" && !isAuthoredBranch(branch, base)) {
      excluded += 1
      continue
    }
    if (carriedBranches.has(branch)) {
      carried += 1
      continue
    }
    uncarried.push(candidate)
  }

  const refUpdates =
    uncarried.length === 0
      ? new Map<string, number>()
      : await latestRefUpdates(git, repo, new Set(uncarried.map(({ ref }) => ref)))
  const survivors: Array<Readonly<{ ref: string; pushedAtMs: number }>> = []
  for (const candidate of uncarried) {
    const updatedAtMs = refUpdates.get(candidate.ref)
    if (updatedAtMs === undefined) clockFallbacks += 1
    // Old refs can predate retained reflogs. The fallback is counted in the
    // result and surfaced by both operator views; it is never a silent clock.
    const pushedAtMs = updatedAtMs ?? candidate.committedAtMs
    const ageMs = options.nowMs - pushedAtMs
    if (ageMs < options.ttlMs || ageMs > options.ageBoundMs) {
      outsideAgeBound += 1
      continue
    }
    survivors.push({ ref: candidate.ref, pushedAtMs })
  }

  const gitlinkPaths = survivors.length === 0 ? new Set<string>() : await gitlinkPathsOf(git, repo, base)
  const findings: UncarriedFinding[] = []
  for (const survivor of survivors) {
    const fact = await gatherPushedRefFact(git, survivor.ref, {
      repo,
      base,
      pushedAtMs: survivor.pushedAtMs,
      carriedBranches,
      gitlinkPaths,
    })
    const finding = classifyPushedRef(fact, options)
    if (finding !== undefined) findings.push(finding)
  }

  return {
    findings: findings.toSorted((left, right) => right.ageMs - left.ageMs),
    scanned: refs.length,
    carried,
    excluded,
    outsideAgeBound,
    examined: survivors.length,
    clockFallbacks,
  }
}
