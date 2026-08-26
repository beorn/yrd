/**
 * The root synthetic-Candidate ref namespace: how it is named, and how it is
 * swept.
 *
 * NAMING IS THE FIX (22332). The ref used to be `refs/yrd/candidates/<id>`,
 * where `<id>` is the journal's `C<n>`. That id is allocated from the journal
 * BEFORE the evidence exists, so a compose retry for the same logical Candidate
 * reused the id, produced a different tree, and refused itself against its own
 * create-only pin. Deriving the name from the composed SHA at publish time makes
 * that impossible rather than merely recoverable: different tree, different SHA,
 * different ref. Identical evidence merges on the same name and the create is an
 * idempotent no-op. This mirrors the source side, where each rewritten tip is
 * already published content-addressed at `refs/heads/yrd/candidates/<newTipSha>`.
 *
 * SWEEPING IS THE SECOND HALF. The namespace had no enumerator at all, which is
 * why it reached ~2000 refs unobserved. `compactQueuesState` bounds terminal run
 * trees to a 512-root window, so a ref outlives the run that explains it as a
 * matter of course — an unowned ref here is the normal end state, not a defect.
 * The sweep therefore reports an aggregate reclaimable population rather than
 * crying wolf per ref, and carries its denominators so a zero is believable.
 *
 * THE SOURCE-SIDE MIRROR GOT THE SAME BUG. `refs/heads/yrd/candidates/<sha>` was
 * described above as symmetric with this namespace but never given an enumerator
 * of its own, and reached 1,613 unswept refs before this fix. `sweepCandidateRefs`
 * now reads both namespaces in one `for-each-ref` and judges them by the same
 * rule — one retention window, one command, not two sweepers to keep in sync. A
 * source-tip ref is claimed through `Candidate.sourceRewrites` (the submodule-
 * wrapper case) or `Candidate.revs[].head` (the direct-re-merge case: `remergeDirectChange`
 * publishes the ref straight from a change's certified head, with no per-source
 * record). KNOWN GAP: refs `publishSourceCandidate` pushes into a SUBMODULE's own
 * origin (`source.repo !== "."`, e.g. `vendor/silvery`) live in that submodule's
 * remote, not this one's, and are out of reach of a sweep scoped to a single
 * `repo` — this call would need to run once per submodule path to close that.
 * Not measured, not fixed here; flag it before assuming this sweep is complete.
 */
import type { DeepReadonly } from "@yrd/core"
import { Queues, type QueueRecord, type QueuesState } from "./model.ts"
import type { RefGit } from "./uncarried-facts.ts"

export const CANDIDATE_REF_NAMESPACE = "refs/yrd/candidates"

/** The one place the root Candidate ref name is formed. Both the publisher and
 * the Queue's publish invariant call it, so the two cannot drift apart. */
export function candidateRefFor(sha: string): string {
  return `${CANDIDATE_REF_NAMESPACE}/${sha}`
}

/** The source-tip mirror of `CANDIDATE_REF_NAMESPACE` — a branch-shaped ref
 * (`refs/heads/...`) because `git fetch <ref>` on the reader side
 * (`sourceCandidateRefError`) needs a fetchable branch, not a bare namespace. */
export const SOURCE_CANDIDATE_REF_NAMESPACE = "refs/heads/yrd/candidates"

/** The one place the source-tip ref name is formed — the mirror of
 * `candidateRefFor` for `remergeDirectChange` and `publishSourceCandidate`. Both used to
 * spell `refs/heads/yrd/candidates/${sha}` independently; one authored function
 * is what makes the writer and this sweep unable to drift apart. */
export function sourceCandidateRefFor(sha: string): string {
  return `${SOURCE_CANDIDATE_REF_NAMESPACE}/${sha}`
}

/**
 * Retention for root Candidate refs.
 *
 * Seven days, deliberately the SAME window `/hh/docs/design/yrd.md` already states for
 * content-addressed source-candidate refs. Operators should learn one number for
 * "how long is Candidate evidence kept", not two.
 */
export const CANDIDATE_REF_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** Why a ref is retained, or why it is reclaimable. Exactly one per ref, so the
 * buckets below sum to `scanned`. */
export type CandidateRefDisposition =
  /** A journaled Candidate owns it and its Run has not reached a terminal status. */
  | "live"
  /** Terminal (or compacted away, which only happens to terminal roots) but still
   * inside the retention window. */
  | "within-retention"
  /** Terminal, past the window, and every deletion precondition is proven. */
  | "reclaimable"
  /** No journaled Candidate claims this ref or its SHA. The journal cannot prove
   * terminality, so it is reported and never auto-deleted. */
  | "unclaimed"
  /** The ref exists but carries no usable age, so the window cannot be judged. */
  | "no-clock"

export type CandidateRefFinding = Readonly<{
  ref: string
  sha: string
  disposition: CandidateRefDisposition
  /** The journaled Candidate that owns this ref, when one does. */
  candidateId?: string
  ageMs?: number
  message: string
}>

/**
 * What the sweep saw, not just what it found.
 *
 * `scanned = live + withinRetention + reclaimable + unclaimed + noClock`. The
 * identity is asserted by the tests: a ref that merges in no bucket, or in two,
 * is a sweep that quietly under-reports, and this namespace already spent ~2000
 * refs proving nobody notices that on their own.
 */
export type CandidateRefSweepResult = Readonly<{
  findings: readonly CandidateRefFinding[]
  scanned: number
  live: number
  withinRetention: number
  reclaimable: number
  unclaimed: number
  noClock: number
}>

export type CandidateRefSweepOptions = Readonly<{
  repo: string
  queues: DeepReadonly<QueuesState>
  nowMs: number
  /** Override the retention window; defaults to `CANDIDATE_REF_RETENTION_MS`. */
  retentionMs?: number
}>

type EnumeratedCandidateRef = Readonly<{ ref: string; sha: string; clockMs?: number }>

/**
 * One `for-each-ref` for both namespaces — the root Candidate refs and their
 * source-tip mirror. `for-each-ref` accepts multiple patterns and unions the
 * matches, so this stays one round-trip and one enumerator rather than two.
 *
 * `committerdate` is the composed commit's own clock rather than a reflog read:
 * the synthetic commit is created by the same prepare that publishes the ref, so
 * the two are the same instant, and it survives reflog expiry — which the ~2000
 * refs already outlived. NUL-separated because a ref name may contain anything
 * git allows and a space split would silently truncate it.
 */
async function enumerateCandidateRefs(git: RefGit, repo: string): Promise<readonly EnumeratedCandidateRef[]> {
  const listing = await git.run(repo, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(committerdate:unix)",
    CANDIDATE_REF_NAMESPACE,
    SOURCE_CANDIDATE_REF_NAMESPACE,
  ])
  return listing
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [ref, sha, clock] = line.split("\0")
      if (ref === undefined || ref === "" || sha === undefined || sha === "") {
        throw new Error(`yrd: for-each-ref produced an unreadable Candidate ref row: '${line}'`)
      }
      const seconds = clock === undefined || clock === "" ? Number.NaN : Number(clock)
      return Number.isFinite(seconds) ? { ref, sha, clockMs: seconds * 1000 } : { ref, sha }
    })
}

/**
 * Terminality read from the RECORD, not from a projected `Run`.
 *
 * `Queues.terminal` needs a `Run` — cursor, status, jobs and shape — which the
 * retention projection does not carry. Each of the three terminal outcomes
 * stamps its own fact on the record instead: `failure` for failed, `canceledAt`
 * for cancelled, `passedAt` for passed. A legacy record written before `passedAt`
 * existed reads as non-terminal here, which retains its ref. That is the correct
 * direction to be wrong in: this predicate gates deletion.
 */
function recordIsTerminal(record: DeepReadonly<QueueRecord>): boolean {
  return record.failure !== undefined || record.canceledAt !== undefined || record.passedAt !== undefined
}

/**
 * Every SHA and ref a live Run still names, so the sweep can never propose
 * deleting evidence something in flight still points at.
 *
 * A live Candidate can hold ownership four ways: its own root ref/sha
 * (`candidate.ref`/`candidate.sha`), a source-tip ref per rewritten submodule
 * (`sourceRewrites[]`), and — for a direct PR re-merge that never went through a
 * submodule wrapper — the revision head itself (`revs[].head`), which is exactly
 * the sha `remergeDirectChange` published the source-tip ref under.
 */
function liveCandidateOwners(
  queues: DeepReadonly<QueuesState>,
): Readonly<{ liveShas: ReadonlySet<string>; liveRefs: ReadonlySet<string> }> {
  const liveShas = new Set<string>()
  const liveRefs = new Set<string>()
  for (const record of Queues.values(queues)) {
    if (recordIsTerminal(record)) continue
    const candidate = queues.candidates[record.candidateId]
    if (candidate?.sha !== undefined) liveShas.add(candidate.sha)
    if (candidate?.ref !== undefined) liveRefs.add(candidate.ref)
    for (const rev of candidate?.revs ?? []) liveShas.add(rev.head)
    for (const rewrite of candidate?.sourceRewrites ?? []) {
      liveShas.add(rewrite.newTipSha)
      liveRefs.add(rewrite.candidateRef)
    }
  }
  return { liveShas, liveRefs }
}

/**
 * Judge `refs/yrd/candidates` and its source-tip mirror `refs/heads/yrd/candidates`
 * against the journal, together.
 *
 * Read-only by construction — it proposes, and `yrd admin candidate-refs
 * prune` disposes. Deletion eligibility requires POSITIVE proof: a journaled
 * Candidate owns the ref, no live Run names it, the window has passed, and the
 * ref still resolves to the SHA this same inventory read. Unknown, unclaimed and
 * unclocked refs are reported and retained, per the retention ruling in
 * `/hh/docs/design/yrd.md`.
 */
export async function sweepCandidateRefs(
  git: RefGit,
  options: CandidateRefSweepOptions,
): Promise<CandidateRefSweepResult> {
  const retentionMs = options.retentionMs ?? CANDIDATE_REF_RETENTION_MS
  const refs = await enumerateCandidateRefs(git, options.repo)
  const { liveShas, liveRefs } = liveCandidateOwners(options.queues)

  // Both keys, because the ~2000 legacy refs are `C<n>`-named while everything
  // published after 22332 is SHA-named. One index answers for both eras, and for
  // both namespaces: a source-tip ref is claimed via `sourceRewrites[]` or, for a
  // direct re-merge with no submodule wrapper, via `revs[].head` (see
  // `liveCandidateOwners`) — claimed by ANY candidate, terminal or not, same as
  // the root ref/sha keys below.
  const byRef = new Map<string, string>()
  const bySha = new Map<string, string>()
  for (const candidate of Object.values(options.queues.candidates)) {
    if (candidate.ref !== undefined) byRef.set(candidate.ref, candidate.id)
    if (candidate.sha !== undefined) bySha.set(candidate.sha, candidate.id)
    for (const rev of candidate.revs) bySha.set(rev.head, candidate.id)
    for (const rewrite of candidate.sourceRewrites ?? []) {
      byRef.set(rewrite.candidateRef, candidate.id)
      bySha.set(rewrite.newTipSha, candidate.id)
    }
  }

  const findings: CandidateRefFinding[] = []
  const tally = { live: 0, withinRetention: 0, reclaimable: 0, unclaimed: 0, noClock: 0 }

  for (const entry of refs) {
    const candidateId = byRef.get(entry.ref) ?? bySha.get(entry.sha)
    if (candidateId === undefined) {
      tally.unclaimed += 1
      findings.push({
        ref: entry.ref,
        sha: entry.sha,
        disposition: "unclaimed",
        ...(entry.clockMs === undefined ? {} : { ageMs: options.nowMs - entry.clockMs }),
        message: "no journaled Candidate claims this ref; retained because terminality cannot be proven",
      })
      continue
    }
    if (liveRefs.has(entry.ref) || liveShas.has(entry.sha)) {
      tally.live += 1
      continue
    }
    if (entry.clockMs === undefined) {
      tally.noClock += 1
      findings.push({
        ref: entry.ref,
        sha: entry.sha,
        disposition: "no-clock",
        candidateId,
        message: "no readable commit clock; the retention window cannot be judged, so the ref is retained",
      })
      continue
    }
    const ageMs = options.nowMs - entry.clockMs
    if (ageMs < retentionMs) {
      tally.withinRetention += 1
      continue
    }
    tally.reclaimable += 1
    findings.push({
      ref: entry.ref,
      sha: entry.sha,
      disposition: "reclaimable",
      candidateId,
      ageMs,
      message: `Candidate '${candidateId}' is terminal and past the ${String(
        Math.round(retentionMs / (24 * 60 * 60 * 1000)),
      )}-day retention window`,
    })
  }

  return { findings, scanned: refs.length, ...tally }
}

export type CandidateRefPruneResult = Readonly<{
  deleted: readonly string[]
  kept: readonly Readonly<{ ref: string; reason: string }>[]
}>

/**
 * Delete exactly what a sweep just proved reclaimable — and nothing else.
 *
 * Takes findings rather than re-deciding, so the deletion can never be broader
 * than the inventory that justified it. Two gates stand between a finding and an
 * actual delete, because the sweep's reads are already seconds old by the time
 * this runs:
 *
 * 1. Re-resolve the ref. If it no longer points at the SHA the sweep judged, it
 *    is not the thing that was judged, and it is kept.
 * 2. `update-ref -d <ref> <sha>` is a compare-and-delete. A plain delete would
 *    race a publisher that legitimately reused the name between the two reads.
 *
 * Anything not classified `reclaimable` is ignored outright: unclaimed, live,
 * within-retention and unclocked refs are never candidates for deletion, per the
 * retention ruling in `/hh/docs/design/yrd.md`.
 */
export async function pruneCandidateRefs(
  git: RefGit,
  options: Readonly<{ repo: string; findings: readonly CandidateRefFinding[] }>,
): Promise<CandidateRefPruneResult> {
  const deleted: string[] = []
  const kept: Array<Readonly<{ ref: string; reason: string }>> = []
  for (const finding of options.findings) {
    if (finding.disposition !== "reclaimable") continue
    const current = await git.optional(options.repo, ["rev-parse", "--verify", `${finding.ref}^{commit}`])
    if (current !== finding.sha) {
      kept.push({ ref: finding.ref, reason: `moved since the inventory read (now ${current ?? "absent"})` })
      continue
    }
    const removed = await git.optional(options.repo, ["update-ref", "-d", finding.ref, finding.sha])
    if (removed === undefined) {
      kept.push({ ref: finding.ref, reason: "git refused the compare-and-delete" })
      continue
    }
    deleted.push(finding.ref)
  }
  return { deleted, kept }
}

/** The sentence the command and the doctor both print. Stated once so the two
 * surfaces cannot disagree about what the numbers mean. */
export function candidateRefDenominator(result: CandidateRefSweepResult): string {
  return (
    `scanned ${String(result.scanned)} · ${String(result.live)} owned by live runs · ` +
    `${String(result.withinRetention)} within retention · ${String(result.reclaimable)} reclaimable · ` +
    `${String(result.unclaimed)} unclaimed · ${String(result.noClock)} without a readable clock`
  )
}
