/**
 * The sweep that turns the uncarried predicate into a rail.
 *
 * `classifyPushedRef` judges ONE ref from facts, and `gatherPushedRefFact`
 * produces those facts for one ref. Neither enumerates, so until this module
 * existed the predicate had no caller and the rail it was built for could not
 * report anything. That is the whole gap this closes.
 *
 * ORDERING IS THE DESIGN, not an optimisation. One `for-each-ref` enumerates
 * every ref and one aggregate reflog scan supplies its local update clock, so
 * the carried set and the age bound disqualify the overwhelming majority
 * before any per-ref git object is read. Gathering facts first would mean
 * thousands of `diff` invocations to discard almost all of them.
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
    /**
     * Limit the namespace to refs authored as changes. The resident and the
     * command's implicit default enable this; an explicit diagnostic
     * namespace leaves it off so the caller sees exactly what they selected.
     */
    authoredOnly?: boolean
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
  /** Refs in the selected population. Zero is valid after authored-only exclusions. */
  scanned: number
  /** Disqualified by the carried set, before any per-ref git work. */
  carried: number
  /** Disqualified by the age bound, before any per-ref git work. */
  outsideAgeBound: number
  /** Facts gathered — the refs that actually cost git object reads. */
  examined: number
  /** Legacy refs whose local update reflog is no longer retained. They cannot
   * mint TTL findings, and the coverage gap is always surfaced to operators. */
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
  const remote = namespace.startsWith("refs/remotes/") ? `${namespace.slice("refs/remotes/".length)}/` : ""
  return remote !== "" && ref.startsWith(remote) ? ref.slice(remote.length) : ref
}

type EnumeratedRef = Readonly<{
  /** Full storage identity used to match exact reflog selectors. */
  fullRef: string
  /** Stable short identity exposed by findings and matched to carrier branches. */
  ref: string
  symbolic: boolean
}>

/** One process for every ref identity. The NUL separator is not
 * decoration — branch names may contain anything a ref format allows, and a
 * space-split would silently truncate them. */
async function enumeratedRefs(git: RefGit, repo: string, namespace: string): Promise<readonly EnumeratedRef[]> {
  const listing = await git.run(repo, ["for-each-ref", "--format=%(refname)%00%(refname:short)%00%(symref)", namespace])
  return listing
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [fullRef, ref, symref, ...extra] = line.split("\0")
      if (
        fullRef === undefined ||
        fullRef === "" ||
        ref === undefined ||
        ref === "" ||
        symref === undefined ||
        extra.length > 0
      ) {
        throw new Error(
          `yrd: uncarried sweep received malformed for-each-ref row under '${namespace}': ${JSON.stringify(line)}`,
        )
      }
      return { fullRef, ref, symbolic: symref !== "" }
    })
}

/** Latest local observation of each selected ref update. Reflogs are
 * clone-local, so this is intentionally not described as server push time.
 * One aggregate scan avoids a process per ref, and taking the maximum makes
 * correctness independent of Git's output ordering. */
async function latestRefUpdates(
  git: RefGit,
  repo: string,
  refs: ReadonlySet<string>,
): Promise<ReadonlyMap<string, number>> {
  const listing = await git.run(repo, ["reflog", "show", "--all", "--date=unix", "--format=%gD"])
  const updates = new Map<string, number>()
  for (const line of listing.split("\n")) {
    if (line === "") continue
    const marker = line.lastIndexOf("@{")
    if (marker < 1 || !line.endsWith("}")) {
      throw new Error(`yrd: uncarried sweep received malformed reflog row: ${JSON.stringify(line)}`)
    }
    const ref = line.slice(0, marker)
    const rawSeconds = line.slice(marker + 2, -1)
    const seconds = Number(rawSeconds)
    if (rawSeconds === "" || !Number.isFinite(seconds)) {
      throw new Error(`yrd: uncarried sweep received malformed reflog row: ${JSON.stringify(line)}`)
    }
    if (!refs.has(ref)) continue
    const updatedAtMs = seconds * 1000
    const current = updates.get(ref)
    if (current === undefined || updatedAtMs > current) updates.set(ref, updatedAtMs)
  }
  return updates
}

function isAuthoredRef(candidate: EnumeratedRef, namespace: string, base: string): boolean {
  if (candidate.symbolic) return false
  const branch = branchOf(candidate.ref, namespace)
  return branch !== "HEAD" && branch !== base && !branch.startsWith("yrd/candidates/")
}

/**
 * Sweep a ref namespace and return every genuinely stranded ref, with the
 * counts that make an empty result readable.
 */
export async function sweepUncarriedRefs(git: RefGit, options: SweepOptions): Promise<SweepResult> {
  const { repo, base, carriedBranches, namespace } = options
  const enumerated = await enumeratedRefs(git, repo, namespace)
  if (enumerated.length === 0) {
    // Loud on purpose. Every other zero in this result is a fact about the
    // fleet; this one is a fact about the sweep, and reporting it as "nothing
    // stranded" is the silent failure that kills monitoring rails.
    throw new Error(
      `yrd: uncarried sweep enumerated no refs under '${namespace}' in '${repo}' — the namespace is wrong or the repo has no remote refs`,
    )
  }
  const refs = options.authoredOnly
    ? enumerated.filter((candidate) => isAuthoredRef(candidate, namespace, base))
    : enumerated

  let carried = 0
  let outsideAgeBound = 0
  let clockFallbacks = 0
  const uncarried: EnumeratedRef[] = []
  for (const candidate of refs) {
    if (carriedBranches.has(branchOf(candidate.ref, namespace))) {
      carried += 1
      continue
    }
    uncarried.push(candidate)
  }

  const refUpdates =
    uncarried.length === 0
      ? new Map<string, number>()
      : await latestRefUpdates(git, repo, new Set(uncarried.map(({ fullRef }) => fullRef)))
  const survivors: Array<Readonly<{ ref: string; observedAtMs: number }>> = []
  for (const candidate of uncarried) {
    const updatedAtMs = refUpdates.get(candidate.fullRef)
    if (updatedAtMs === undefined) {
      // A commit timestamp cannot prove when this clone observed the ref. Keep
      // the coverage gap loud, but never mint a TTL finding from an unrelated
      // author clock that could be older or newer than the actual ref update.
      clockFallbacks += 1
      continue
    }
    const ageMs = options.nowMs - updatedAtMs
    if (ageMs < options.ttlMs || ageMs > options.ageBoundMs) {
      outsideAgeBound += 1
      continue
    }
    survivors.push({ ref: candidate.ref, observedAtMs: updatedAtMs })
  }

  const gitlinkPaths = survivors.length === 0 ? new Set<string>() : await gitlinkPathsOf(git, repo, base)
  const findings: UncarriedFinding[] = []
  for (const survivor of survivors) {
    const fact = await gatherPushedRefFact(git, survivor.ref, {
      repo,
      base,
      observedAtMs: survivor.observedAtMs,
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
    outsideAgeBound,
    examined: survivors.length,
    clockFallbacks,
  }
}
