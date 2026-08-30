/**
 * Derived-member ADMISSION (@i/10-merge-queue/s6-door-design §2, §5 ordering
 * item 3): the machinery that lets a branch with a live submit fact and no
 * `Change` record enter selection, run checks against its submit-ref sha, and
 * start a Queue run under an admission-time minted identity.
 *
 * Everything here is a PURE DERIVATION over surviving projections
 * (`bays.submits`, `bays.prs`, `QueuesState`) plus caller-supplied identity —
 * nothing persists, nothing journals a new event type, nothing adds state
 * shape (the §3 identity trap, avoided by construction). A derived member's
 * only durable home stays the `queue/run/started` `ChangeSnapshot`.
 *
 * This is LIVE. The door's compose wires `deriveRunMemberArgs` in where the 2b
 * intake sweep used to run, and derived membership carries real landings: five
 * runs measured 2026-08-28 (R3578, R3590-R3593) each merged a derived member
 * with `QueueRunArgs.prs` empty. The header here claimed the opposite — "no
 * live caller builds `QueueRunArgs.derived`, so every path in this file is
 * reachable only from tests" — long after that stopped being true, and a
 * comment asserting unreachability over live code is worse than no comment: it
 * stops the next reader looking. It is recorded because it cost something. The
 * queue audit kept reading the mutable `Change` record for a derived member's
 * admission evidence, found none by construction, and reported four executed,
 * PASSING checks as "executed in NEITHER stage" on every one of those
 * landings. The evidence was on the run record the whole time, exactly where
 * the paragraph above says a derived member's only durable home is
 * (@yrd/cli/plan-audit.ts `carriedAtBase`).
 *
 * 2b's four loud edges re-homed here (design R2; queue.ts sweep policy
 * carried): mint-failure and duplicate-payload PROPAGATE and fail the compose;
 * a vanished/moved submit fact and a live-record collision are typed refusals
 * the selectorless compose skips loudly (the row survives into audit).
 */
import {
  changeComposition,
  changeHead,
  resolveChangeIdentity,
  baseIdentity,
  changeIdTrailerCandidates,
  findChangeId,
  CHANGE_ID_TRAILER_KEY,
  isLiveChange,
  ChangeIdSchema,
  ChangePropsSchema,
  GitRefSchema,
  GitShaSchema,
  PRIdSchema,
  hasChangeRecord,
  type BaysState,
  type Change,
  type ChangeProps,
  type PrNumberMint,
  type ProjectedBranchSubmit,
} from "@yrd/bay"
import { raiseFailure, type DeepReadonly } from "@yrd/core"
import * as z from "zod"
import { mintDerivedMemberIdentity } from "./derived-member.ts"
import {
  arbitrateDerivedChange,
  latestChangeSnapshot,
  Queues,
  type ChangeSnapshot,
  type IntegrationProof,
  type QueueRecord,
  type QueuesState,
  type RunId,
  type SubmitLanding,
} from "./model.ts"
import { mergedTruth, type MergedTruth, type MergedTruthGit, type MergedTruthIndex } from "./merged-truth.ts"
import { projectionLookupGet } from "./projection-lookup.ts"

/**
 * One derived member as it rides `QueueRunArgs.derived`: the identity the
 * driver minted (admission-time, commit-before-escape) plus the enrichment it
 * read from git — `apply` is a pure reducer and can do neither itself. The
 * submit fact's sha rides along as `headSha` so apply can CAS it against the
 * live fact: the fact IS the authority, and a fact that moved or vanished
 * between the driver's read and the dispatch refuses instead of running stale.
 *
 * `changeId` is required: 22991 makes branch+Change-Id the identity, and the
 * re-sourced `pr/integrated` cannot be emitted without one — a tip commit
 * missing its `Change-Id` trailer runs under a synthetic id minted at
 * derivation from the submission's stable facts (branch, tip sha), so the
 * terminal emitters never go dark and a trailerless push still lands.
 */
export const DerivedRunMemberSchema = z
  .object({
    branch: GitRefSchema,
    id: PRIdSchema,
    changeId: ChangeIdSchema,
    revision: z.number().int().positive(),
    headSha: GitShaSchema,
    props: ChangePropsSchema.optional(),
    issue: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1).optional(),
  })
  .strict()
export type DerivedRunMember = Readonly<z.infer<typeof DerivedRunMemberSchema>>

/**
 * Materialize `args.derived` into in-memory `Change` values the existing
 * selection/admission/run pipeline consumes unchanged. The value is a
 * derivation, not a record: it is never written to `bays.prs`, and
 * `Queues.snapshot` of it is exactly the `ChangeSnapshot` the run journals.
 *
 * Validation is the four loud edges (design R2), split by 2b's own policy:
 *
 * - no live submit fact for the branch ⇒ refusal `derived-submit-vanished`
 * - live fact whose sha ≠ the member's ⇒ refusal `derived-submit-moved`
 *   (the git-CAS: a re-push supersedes the admission that was in flight)
 * - a LIVE record for the branch ⇒ refusal `derived-record-lane` (the record
 *   lane owns the branch; never both lanes for one push — A4)
 * - the member's id already names a record ⇒ Error (mint monotonicity broken
 *   — infrastructure, propagates)
 * - another open record already carries the exact payload ⇒ Error (the 2b
 *   duplicate-payload collision: one payload under two identities needs a
 *   human, propagates and fails the compose)
 */
export function materializeDerivedRunMembers(
  bays: DeepReadonly<BaysState>,
  queues: DeepReadonly<QueuesState>,
  derived: readonly DerivedRunMember[],
): Change[] {
  const seen = new Set<string>()
  return derived.map((member) => {
    if (seen.has(member.id) || seen.has(member.branch)) {
      raiseFailure("usage", "duplicate-pr", `yrd: queue.run: duplicate derived member '${member.id}'`)
    }
    seen.add(member.id)
    seen.add(member.branch)
    return materializeDerivedRunMember(bays, queues, member)
  })
}

/**
 * The merge proof a settled run holds for exactly this (branch, sha) — the
 * projected home of a DERIVED member's merged truth.
 *
 * A derived member is recordless by design, so its `pr/integrated` is a store
 * no-op (the S6 relaxation) and no `Change` row ever records that it landed.
 * The run that merged it does: that same terminal fact stamps the proof onto
 * the run record (`stampRunIntegration`), and the pair — settled `passed`, proof
 * retained — IS the member's landing.
 *
 * Retention-bounded, deliberately: prune the merging run and the member reads
 * un-merged again, exactly as pruning it already erases the run's own history.
 * That is strictly better than the literal `merged: false` this replaced, which
 * was wrong for a member's entire life rather than only after its run aged out.
 *
 * Answers `undefined` when nothing merged this sha — the honest "still open".
 */
function derivedIntegration(
  queues: DeepReadonly<QueuesState>,
  member: Readonly<{ branch: string; headSha: string }>,
): Readonly<{ run: RunId; at: string; proof: IntegrationProof }> | undefined {
  let landed: Readonly<{ run: RunId; at: string; proof: IntegrationProof }> | undefined
  for (const record of Queues.values(queues as QueuesState) as readonly DeepReadonly<QueueRecord>[]) {
    if (record.parent !== undefined) continue
    if (record.passedAt === undefined || record.integration === undefined) continue
    if (!record.steps.some((step) => step.kind === "merge")) continue
    if (
      !record.prs.some((pr) => pr.intent === undefined && pr.branch === member.branch && pr.headSha === member.headSha)
    ) {
      continue
    }
    // Latest run wins, matching `consumingRun`'s tie-break: a re-run over the
    // same sha supersedes the proof an earlier one left.
    if (landed === undefined || record.id.localeCompare(landed.run) > 0) {
      landed = { run: record.id, at: record.passedAt, proof: record.integration as IntegrationProof }
    }
  }
  return landed
}

function materializeDerivedRunMember(
  bays: DeepReadonly<BaysState>,
  queues: DeepReadonly<QueuesState>,
  member: DerivedRunMember,
): Change {
  const submit = bays.submits[member.branch]
  if (submit === undefined) {
    raiseFailure(
      "refusal",
      "derived-submit-vanished",
      `yrd: derived member '${member.id}' (${member.branch}) has no live submit fact — ` +
        `the branch was unsubmitted since admission was derived; re-push refs/yrd/submit/${member.branch} to re-admit`,
    )
  }
  if (submit.sha !== member.headSha) {
    raiseFailure(
      "refusal",
      "derived-submit-moved",
      `yrd: derived member '${member.id}' (${member.branch}) was derived at ${member.headSha} but the live ` +
        `submit fact now stands at ${submit.sha} — re-derive admission at the live sha`,
    )
  }
  if (hasChangeRecord(bays, member.id)) {
    throw new Error(
      `yrd: derived member id '${member.id}' already names a record — the mint is monotone above the ` +
        `frozen store, so a colliding id means an identity escaped outside it; refusing to run`,
    )
  }
  const records = Object.values(bays.prs).filter((pr) => pr.branch === member.branch)
  const live = records.find(isLiveChange)
  if (live !== undefined) {
    raiseFailure(
      "refusal",
      "derived-record-lane",
      `yrd: branch '${member.branch}' has live change '${live.id}' — the record lane owns it and a derived ` +
        `member may not run beside it (never both lanes for one push)`,
    )
  }
  const duplicate = Object.values(bays.prs).find(
    (pr) =>
      pr.branch !== member.branch &&
      pr.state === "open" &&
      changeHead(pr) === member.headSha &&
      baseIdentity(pr.base) === baseIdentity(submit.base) &&
      changeComposition(pr) === undefined,
  )
  if (duplicate !== undefined) {
    throw new Error(
      `yrd: derived member '${member.id}' (${member.branch}) payload already recorded as change ` +
        `'${duplicate.id}' (${duplicate.branch}) — one payload under two identities needs a human`,
    )
  }
  // `state` and `merged` are PROJECTED, never literal: a member whose merging
  // run settled reads closed+merged, carrying the same proof shape the record
  // lane's `pr/integrated`/`pr/already-landed` reducers write. Both fields are
  // set from one source so they can never disagree — `integratedChangeShape`
  // throws on a merged change with no proof, so a half-projection is a crash.
  const landed = derivedIntegration(queues, member)
  const alreadyLanded = landed?.proof.alreadyLanded
  return {
    id: member.id,
    branch: member.branch,
    base: submit.base,
    state: landed === undefined ? "open" : "closed",
    merged: landed !== undefined,
    ...(landed === undefined
      ? {}
      : {
          terminalRun: landed.run,
          integration: { commit: landed.proof.commit, baseSha: landed.proof.baseSha },
          ...(alreadyLanded === undefined
            ? { integratedAt: landed.at }
            : {
                alreadyLandedAt: landed.at,
                alreadyLanded: { baseSha: landed.proof.baseSha, ...alreadyLanded },
              }),
        }),
    ...(member.title === undefined ? {} : { title: member.title }),
    ...(member.issue === undefined ? {} : { issue: member.issue }),
    submittedAt: submit.at,
    revs: [
      {
        n: member.revision,
        changeId: member.changeId,
        head: submit.sha,
        base: submit.base,
        ...(member.props === undefined ? {} : { props: member.props }),
        pushedAt: submit.at,
        submittedAt: submit.at,
      },
    ],
    reviews: [],
    comments: [],
    // The standing check authority a live submit fact carries for exactly its
    // sha (design §2: no event, no projection — the fact is the authority).
    checkRequests: [{ revision: member.revision, headSha: submit.sha, at: submit.at }],
  }
}

/** What a derived member's admission reads from git — the tip commit's
 * Change-Id trailer and whatever props/issue/title the host derives from the
 * commit. This layer never reads git itself; the host supplies the reader. */
export type DerivedSubmitEnrichment = Readonly<{
  changeId?: string
  props?: ChangeProps
  issue?: string
  title?: string
}>

/** The authority verdict the token machinery cannot give a recordless member. */
export type DerivedMemberAuthority = Readonly<{ standing: true }> | Readonly<{ standing: false; consumedBy: RunId }>

export type DerivedAuthorityLookup = (pr: ChangeSnapshot) => DerivedMemberAuthority | undefined

/**
 * Read-time authority derivation for derived members (design §2 stale-reads
 * table): one standing authority per live submit fact, for exactly
 * `submit.sha`; a retry is a re-push of the submit ref (git CAS actuates —
 * the @cto PURE-GIT ruling). Consumption is derived from run history, never
 * stored: a retained root run that plans a merge, names the same
 * branch+headSha, started at/after the fact was projected, and was not
 * released (released = blameless infra failure, authority returns) has spent
 * the fact. A re-push — same sha included — re-projects the fact with a newer
 * `at`, which is the per-push consent renewing the authority.
 *
 * Answers `undefined` for anything that is not a derived member (a record
 * exists for the id — token machinery owns it) or whose fact vanished/moved —
 * the caller's gap machinery then reports `missing` exactly as it would for a
 * record without its token.
 */
export function derivedAuthorityLookup(
  state: Readonly<{ bays: DeepReadonly<BaysState>; queues: DeepReadonly<QueuesState> }>,
  options: Readonly<{ excludeRun?: RunId }> = {},
): DerivedAuthorityLookup {
  return (pr) => {
    if (pr.intent !== undefined) return undefined
    if (hasChangeRecord(state.bays, pr.id)) return undefined
    const submit = state.bays.submits[pr.branch]
    if (submit === undefined || submit.sha !== pr.headSha) return undefined
    const consumer = consumingRun(state.queues, pr, submit, options.excludeRun)
    return consumer === undefined ? { standing: true } : { standing: false, consumedBy: consumer }
  }
}

function consumingRun(
  queues: DeepReadonly<QueuesState>,
  pr: ChangeSnapshot,
  submit: DeepReadonly<ProjectedBranchSubmit>,
  excludeRun: RunId | undefined,
): RunId | undefined {
  let consumer: RunId | undefined
  for (const record of Queues.values(queues as QueuesState) as readonly DeepReadonly<QueueRecord>[]) {
    if (record.id === excludeRun || record.parent !== undefined) continue
    if (!record.steps.some((step) => step.kind === "merge")) continue
    if (record.startedAt.localeCompare(submit.at) < 0) continue
    if (projectionLookupGet(queues.authority.runs, record.id)?.released !== undefined) continue
    if (
      !record.prs.some(
        (member) => member.intent === undefined && member.branch === pr.branch && member.headSha === pr.headSha,
      )
    ) {
      continue
    }
    if (consumer === undefined || record.id.localeCompare(consumer) > 0) consumer = record.id
  }
  return consumer
}

/**
 * Is this retained run member a derived member — recordless BY DESIGN — rather
 * than something the reader should refuse to render?
 *
 * The original discriminator compared the member's number to the record
 * store's max ("derived ids mint strictly above the frozen store's max", A9).
 * That assumption is FALSE while A2's fact-keyed grandfather lives: a factless
 * `yrd pr submit` still mints a legacy RECORD, so both lanes mint post-door
 * and their numbers interleave. Measured 2026-08-27: record PR2135 minted
 * after derived members PR2131-2134, moving the "frontier" past them and
 * reclassifying every earlier derived member as corruption — which crashed
 * every status view the moment the fix that relied on the number test landed.
 *
 * The sound rule needs no numbers: post-S6 records are never DELETED (the
 * grandfathered drain freezes them terminal, it does not remove them), so a
 * record the store "lost" is not a representable state. A recordless,
 * non-intent member retained by a run IS a derived member — or a member whose
 * record predates the store's own S4-certified history, which reads the same
 * way. Corruption detection belongs to the journal's hash chain, not to a
 * number heuristic that legacy mints invalidate.
 */
export function isDerivedRunMember(bays: DeepReadonly<Pick<BaysState, "prs">>, pr: ChangeSnapshot): boolean {
  return pr.intent === undefined && !hasChangeRecord(bays, pr.id)
}

/** A recordless, non-intent run member, for callers that hold a record id SET
 * rather than `BaysState` (status projections over result lists). Same rule as
 * `isDerivedRunMember`; see its doc for why there is deliberately no number
 * test here. */
export function isDerivedMemberId(id: string, recordIds: ReadonlySet<string>): boolean {
  return !recordIds.has(id)
}

/**
 * Every branch the DERIVED lane currently owns: a live submit fact on a
 * branch with NO record — in any state. This is the door compose's selection
 * universe — the exact population the retired 2b sweep used to mint records
 * for.
 *
 * Recordless-ness is a hard criterion on top of the arbitration verdict, not
 * a restatement of it. The verdict's terminal×different-sha cell still reads
 * "derived" (it is a status statement: the standing fact is newer truth than
 * the terminal record), but ADMISSION requires more — one submit fact must be
 * consumed by exactly one lane, and a branch with record history already has
 * the record lane as its consumer. Measured 2026-08-27 (PR2139): the record
 * lane merged revision 1, the submit fact survived at the merge commit's sha,
 * the terminal×different-sha cell arbitrated "derived", and the next compose
 * minted and merged an empty revision 2 — one approval, two merges. The
 * incident's signature is landed CONTENT (the fact pointing at the landing
 * commit itself), excluded via the git-derived {@link landedSubmits}; a terminal
 * branch's genuinely NEW head composes here — post-purge the derived lane is
 * the only re-entry (Q1).
 */
export function derivedLaneBranches(
  bays: DeepReadonly<BaysState>,
  landedBranches: ReadonlySet<string>,
  retiredBranches: ReadonlySet<string> = new Set(),
): string[] {
  return Object.keys(bays.submits)
    .filter((branch) => {
      const records = Object.values(bays.prs).filter((pr) => pr.branch === branch)
      // One-lane-consumes, decided by LIVE ownership plus landed content:
      // - a LIVE record owns its branch, so its standing fact is that
      //   record's own pending signal, never a derived admission;
      // - a fact whose content the repository ALREADY carries is the PR2139
      //   incident cell — a stale re-projection, not an approval of new work
      //   (the empty double-merge minted exactly there). That set is derived
      //   from git by {@link landedSubmits} and passed in: this function is
      //   pure over `BaysState`, and the question is not one `BaysState` can
      //   answer (see that function's header for why the record store's
      //   answer was wrong in both of the now-common cases);
      // - any OTHER terminal-record branch composes: post-purge (the legacy
      //   mint is retired) the derived lane IS the only re-entry for a merged
      //   or withdrawn branch's next head (Q1), and excluding record history
      //   wholesale would strand every resubmit.
      if (records.some((pr) => isLiveChange(pr as Change))) return false
      if (landedBranches.has(branch)) return false
      // - a fact the queue RETIRED at exactly this sha derives nothing more:
      //   the change it already produced cannot progress, and deriving a
      //   second one mints a number that will refuse identically. This is the
      //   derived lane's own live-ownership test, which the record test above
      //   structurally cannot make — a derived change is recordless BY DESIGN,
      //   so `bays.prs` is empty for its branch and every pass reads a fact
      //   nobody owns. Passed in, sha-matched by the caller, for the same
      //   reason `landedBranches` is: this function stays pure over
      //   `BaysState`, and the retirement lives in the queue's projection.
      if (retiredBranches.has(branch)) return false
      return arbitrateDerivedChange(records as Change[], bays.submits[branch]).lane === "derived"
    })
    .toSorted()
}

/** One standing fact whose content the repository ALREADY carries: its sha is
 * reachable from the merged-truth index's walked tip. */
export type LandedSubmit = Readonly<{
  branch: string
  sha: string
  /** The first-parent merge commit that carried the fact's sha, when the walked
   * window names one. Absent for a fact merged outside the walk. */
  mergeCommit?: string
}>

/** Why a standing fact's containment question has no answer.
 *
 * `degenerate` — the fact's sha IS the walked tip, so `is A contained in B`
 * holds for free and proves nothing (merged-truth's self-comparison door-stop).
 * The CONTENT is on the tip by construction, so this still bars admission.
 *
 * `unreadable` — git could not resolve the fact's sha here (pruned, never
 * fetched, or a synthetic sha). Nothing is proven in EITHER direction, and the
 * safe reading is the one the compose already applies to an unreadable oracle:
 * leave the fact admissible so live work is never silently dropped, and be
 * loud about it on every pass. */
export type UnresolvedSubmitReason = "degenerate" | "unreadable"

/** A standing fact git could not answer for. Never folded into landed or
 * not-landed — an unanswerable window is not a verdict. */
export type UnresolvedSubmit = Readonly<{
  branch: string
  sha: string
  reason: UnresolvedSubmitReason
  /** What was queried and what was missing, in the reader's own words. */
  detail: string
}>

/** One standing fact where the retired record-store answer and the repository
 * answer differ. Reported per fact, never counted: a disagreement names which
 * side said what and which record produced the store's claim. */
export type LandedSubmitDisagreement = Readonly<{
  branch: string
  sha: string
  store: "landed" | "not-landed"
  derived: "landed" | "not-landed" | UnresolvedSubmitReason
  /** The terminal record whose integration commit the store matched. */
  record?: string
  detail: string
}>

export type LandedSubmitScan = Readonly<{
  landed: readonly LandedSubmit[]
  unresolved: readonly UnresolvedSubmit[]
  disagreements: readonly LandedSubmitDisagreement[]
  /** Denominator for every count above: how many standing facts were asked
   * about. A zero landed over zero facts and a zero over forty are different
   * findings, and no caller may print one as the other. */
  facts: number
}>

/** Resolve the merged-truth index for ONE base branch. Supplied by the caller
 * so index building — one first-parent walk per base — is cached, bounded (a
 * production caller passes the trailer-stamping epoch as `stop`) and owned
 * where the repository is, not re-derived per fact. */
export type MergedTruthIndexFor = (base: string) => Promise<MergedTruthIndex>

/** The empty scan, for a host that supplies no repository reader. It is NOT a
 * default answer: {@link landedSubmits} is the only producer of a real one, and
 * a caller handed this must say so where it says anything. */
export const NO_LANDED_SUBMIT_SCAN: LandedSubmitScan = {
  landed: [],
  unresolved: [],
  disagreements: [],
  facts: 0,
}

/** What the RETIRED record-store reader would have claimed for one branch: a
 * terminal record on that branch whose integration commit IS the fact's sha.
 *
 * Kept for exactly one purpose — naming the disagreement in
 * {@link landedSubmits} — and never consulted for the verdict. Delete it with
 * the record store; nothing else may call it.
 */
function storeLandedClaim(bays: DeepReadonly<BaysState>, branch: string, sha: string): string | undefined {
  return Object.values(bays.prs).find(
    (pr) => pr.branch === branch && !isLiveChange(pr as Change) && pr.integration?.commit === sha,
  )?.id
}

/**
 * The change identity a standing submit fact DECLARES, read from its own tip.
 *
 * The fact projection is `{sha, base, at}` and carries no identity — the
 * trailer lives on the commit, so this is where it is read. Parsing goes
 * through the same `changeIdTrailerCandidates` + `findChangeId` pair the
 * receiver's push-time gate uses, so that gate can never accept a trailer this
 * reader would then fail to see. `change-identity.ts` states that one-source
 * contract for its first two callers; this is the third.
 *
 * `undefined` is a real answer rather than a failure: a commit from before the
 * trailer-stamping epoch carries none, and a fact without one simply keeps the
 * containment answer alone. `text` and not `optionalText` on purpose — a git
 * read that FAILS must not read back as "this commit has no trailer", which
 * would silently downgrade every fact in an unreadable repository to the
 * ancestry-only answer and say nothing. Exit 0 with empty output is the
 * trailerless case; anything else throws and the caller reports `unreadable`.
 */
async function readSubmitChangeId(git: MergedTruthGit, repo: string, sha: string): Promise<string | undefined> {
  const raw = await git.text(repo, [
    "log",
    "-1",
    `--format=%(trailers:key=${CHANGE_ID_TRAILER_KEY},valueonly,separator=%x2c)`,
    sha,
  ])
  return findChangeId(changeIdTrailerCandidates(raw))
}

/**
 * Standing submit facts whose content the repository ALREADY carries — derived
 * from git, never from the change-record store.
 *
 * This is the read that replaced `alreadyLandedSubmits`, which answered the
 * same question out of `bays.prs` and could not answer it in either of the two
 * now-common cases. It needed a terminal RECORD for the branch — post-purge a
 * merged branch usually has none — and it compared the fact's sha to that
 * record's `integration.commit`, while the queue REBUILDS a candidate at merge
 * under a new head, so the equality it tested does not survive a real merge.
 * Both failures read as "not landed", which is the PR2139 double-merge's own
 * signature: the compose derives an empty second revision for content already
 * on main.
 *
 * `bays.submits` is still read, because that projection IS the standing-fact
 * population — a git ref set, not a change record. `bays.prs` is read for ONE
 * thing, the disagreement report, and never for the verdict.
 *
 * NO SILENT ERRORS, per fact: an unresolvable sha is attributable to one
 * branch and is reported as {@link UnresolvedSubmit}, so one bad fact can
 * never starve the scan of every healthy sibling — the same per-branch
 * boundary the compose's derive loop keeps. A git failure is never an answer:
 * `mergedByAncestry` resolves BOTH endpoints through `rev-parse --verify`
 * before it asks containment, so only a resolved pair yields a not-landed.
 */
export async function landedSubmits(
  git: MergedTruthGit,
  indexFor: MergedTruthIndexFor,
  bays: DeepReadonly<BaysState>,
): Promise<LandedSubmitScan> {
  const branches = Object.keys(bays.submits).toSorted()
  const landed: LandedSubmit[] = []
  const unresolved: UnresolvedSubmit[] = []
  const disagreements: LandedSubmitDisagreement[] = []
  const indexes = new Map<string, MergedTruthIndex | Error>()
  let facts = 0

  for (const branch of branches) {
    const submit = bays.submits[branch]
    if (submit === undefined) continue
    facts += 1
    const record = storeLandedClaim(bays, branch, submit.sha)
    const store = record === undefined ? "not-landed" : "landed"
    const disagree = (derived: LandedSubmitDisagreement["derived"], detail: string): void => {
      disagreements.push({
        branch,
        sha: submit.sha,
        store,
        derived,
        ...(record === undefined ? {} : { record }),
        detail,
      })
    }
    const unreadable = (detail: string): void => {
      unresolved.push({ branch, sha: submit.sha, reason: "unreadable", detail })
      if (store === "landed") disagree("unreadable", detail)
    }

    // One index per DISTINCT base, built once and reused — a fact declares the
    // base it targets, and an index is pinned to one walked tip, so asking a
    // `main` index about a fact submitted to a release branch would answer the
    // wrong question. A base whose index cannot be built fails its own facts
    // and nobody else's; the error is cached so a broken base is not walked
    // once per fact.
    const base = baseIdentity(submit.base)
    let index = indexes.get(base)
    if (index === undefined) {
      try {
        index = await indexFor(base)
      } catch (error) {
        index = error instanceof Error ? error : new Error(String(error))
      }
      indexes.set(base, index)
    }
    if (index instanceof Error) {
      unreadable(
        `could not build the merged-truth index for base '${base}', so standing fact '${branch}' at ` +
          `${submit.sha} could not be asked about: ${index.message}`,
      )
      continue
    }

    // ASK ABOUT THE CHANGE, NOT THE COMMIT. Ancestry answers "is this COMMIT
    // contained in the base", and `mergedTruth`'s own contract names what that
    // misses: "an earlier revision of the same change is a different commit —
    // pass the changeId to ask about the change". Every abandoned revision of a
    // change that later landed is exactly that commit. An ancestry-only scan
    // therefore leaves one standing fact per abandoned revision, and the
    // compose then derives, gates and merges each of them as an empty change —
    // the PR2139 double-merge signature this function's own docstring names,
    // arriving through the one door it did not close.
    //
    // Measured 2026-08-29 on a pin advance that needed four carriers: r4
    // carried the SAME Change-Id as the r3 that landed and a zero-file diff
    // against main, and nothing on this path could see either fact. It stood
    // until a human retired it by hand.
    //
    // The index this asks is ALREADY BUILT: `landedSubmitScanner` walks one per
    // base per compose pass and, until now, consulted only its containment
    // half. This is the lineage half of a walk already paid for — no second
    // scan, no second store, no new oracle beside the one that exists.
    let answer: MergedTruth
    try {
      const changeId = await readSubmitChangeId(git, index.repo, submit.sha)
      answer = await mergedTruth(git, index, {
        authoredTip: submit.sha,
        ...(changeId === undefined ? {} : { changeId }),
      })
    } catch (error) {
      unreadable(
        `git could not resolve standing fact '${branch}' at ${submit.sha} against the walked tip ` +
          `${index.tip} in ${index.repo}: ${error instanceof Error ? error.message : String(error)}`,
      )
      continue
    }

    if (answer.kind === "merged") {
      landed.push({
        branch,
        sha: submit.sha,
        ...(answer.mergeCommit === undefined ? {} : { mergeCommit: answer.mergeCommit }),
      })
      // WHICH PROOF CONCLUDED IT, always — the two are not interchangeable and
      // only one of them means the fact's own commit is on the base. A lineage
      // landing says the CHANGE landed under a different commit, which is
      // benign for an abandoned revision and is an author error for a fact
      // carrying new work under a landed identity. Naming the proof is what
      // lets those be told apart downstream; folding them into one "landed"
      // would hide the second behind the first.
      const proof =
        answer.via === "ancestry"
          ? `the repository carries that commit on ${index.tip}` +
            (answer.mergeCommit === undefined ? "" : ` (merged by ${answer.mergeCommit})`)
          : `${submit.sha} is NOT contained in ${index.tip}, but its change ` +
            `'${String(answer.changeId)}' already landed there` +
            (answer.occurrences?.[0] === undefined
              ? ""
              : ` as ${answer.occurrences[0].commit} (${answer.occurrences[0].subject})`) +
            " — this fact is a superseded revision of a landed change"
      if (store === "not-landed") {
        disagree(
          "landed",
          `no terminal record on '${branch}' names ${submit.sha} as its integration commit, but ${proof}`,
        )
      }
      continue
    }

    if (answer.kind === "unknown") {
      // A lineage window with unresolved specimens proves NOTHING in either
      // direction, so it is `unreadable`, not `degenerate`: only the latter is
      // excluded from admission, and excluding an unanswered fact would drop a
      // live submission on a failed read — the one outcome worse than composing
      // a stale one, which `landedSubmitBranches` states in the same words.
      if (answer.reason === "trailer-absent") {
        // @i/10-yrd/queue-liveness-pair (acceptance 3, superseding
        // @i/10-yrd/audit-unverified-conflates-two-causes): UNVERIFIED is one
        // word for two states that need opposite responses — an ancient
        // trailer-poor window poisoning a recent verdict, versus this change
        // genuinely having no identity. The walk already counts both halves
        // (`index.commitsWalked`, `answer.specimens.length`); this only
        // surfaces the ratio it already paid for, so a reader can tell high
        // coverage (probably ancient window, ancestry answers alone) from low
        // coverage (probably this change, derived truth cannot see it)
        // without leaving this message to go measure it by hand.
        const walked = index.commitsWalked
        const unreadableCount = answer.specimens.length
        const coverage = walked === 0 ? undefined : Math.round(((walked - unreadableCount) / walked) * 1000) / 10
        const detail =
          `standing fact '${branch}' at ${submit.sha} declares change '${answer.changeId}', and the lineage ` +
          `index over ${index.tip} in ${index.repo} could not answer for it: ` +
          `${String(unreadableCount)} of ${String(walked)} commit(s) in the walked window carry no readable ` +
          `identity (walk coverage ${coverage === undefined ? "unknown" : `${String(coverage)}%`}; ${answer.specimens
            .slice(0, 3)
            .map((specimen) => `${specimen.commit.slice(0, 12)} ${specimen.problem}`)
            .join(", ")}), so a not-found cannot be trusted`
        unreadable(detail)
        continue
      }
      unresolved.push({ branch, sha: submit.sha, reason: "degenerate", detail: answer.detail })
      if (store === "landed") disagree("degenerate", answer.detail)
      continue
    }

    if (store === "landed") {
      disagree(
        "not-landed",
        `terminal record '${String(record)}' names ${submit.sha} as its integration commit, but that commit ` +
          `is NOT contained in ${index.tip} in ${index.repo} — the record claims a landing the repository ` +
          `does not carry`,
      )
    }
  }

  return { landed, unresolved, disagreements, facts }
}

/**
 * The branches a derived admission must not be minted for, from a scan.
 *
 * Landed content, plus the DEGENERATE facts: a fact standing at the walked tip
 * itself carries content the tip holds by construction, even though containment
 * could not prove it. An UNREADABLE fact is deliberately absent — nothing was
 * proven about it in either direction, and dropping a live submission on a
 * failed read is the one outcome worse than composing a stale one (the compose
 * applies the same asymmetry to its own unreadable oracle).
 */
export function landedSubmitBranches(scan: LandedSubmitScan): ReadonlySet<string> {
  return new Set([
    ...scan.landed.map((row) => row.branch),
    ...scan.unresolved.filter((row) => row.reason === "degenerate").map((row) => row.branch),
  ])
}

/**
 * The branches whose STANDING fact the queue has retired — matched by sha, not
 * by name.
 *
 * The sha match is the whole design. A retirement is a verdict about one
 * immutable commit ("this content's candidate conflicts against this base"),
 * and it stays true of that commit forever. The moment the author pushes a
 * rebased head the fact re-projects at a new sha, the match fails, and the
 * branch is derivable again — so the cure needs no clearing verb, no expiry,
 * and no operator remembering to unstick anything. A name-keyed retirement
 * would have needed all three, and would have silently swallowed the fix.
 */
export function retiredSubmitBranches(
  bays: DeepReadonly<BaysState>,
  queues: DeepReadonly<QueuesState>,
): ReadonlySet<string> {
  const retired = new Set<string>()
  for (const [branch, row] of Object.entries(queues.retiredSubmits)) {
    if (bays.submits[branch]?.sha === row.sha) retired.add(branch)
  }
  return retired
}

/** One fact's landing answer, read at the moment the question is asked. */
export type SubmitLandingReader = (fact: Readonly<{ branch: string; sha: string }>) => SubmitLanding

/**
 * The one derivation of "is this standing fact still pending?", from a scan the
 * repository produced.
 *
 * This is the whole point of the derive-at-read shape: the WAITING LIST asks
 * git, so a landed fact stops being reported the moment its content is on the
 * base — no `branch/unsubmitted { reason: "superseded" }` write, no second
 * thing that must happen, no false-positive retirement deleting a live
 * approval. The submit ref keeps what only it can hold — the consent triple
 * `{sha, base, at}`, since ancestry has no clock and cannot say anyone approved
 * anything — and loses only the pending BIT, which it was never the authority
 * for. The ref can then be garbage-collected on any schedule, or never, without
 * correctness depending on it.
 *
 * `scan === undefined` is NOT "nothing landed". It is `unscanned`: no reader
 * asked, so every fact answers unresolved and says which surface could not ask.
 * The change-record store is deliberately not consulted as a fallback — its
 * answer is the defect this replaced (see {@link landedSubmits}), and a quiet
 * fall-back to it would restore exactly the report this fixes.
 *
 * A scan answers only for the (branch, sha) it was taken over. A fact whose sha
 * moved since the scan is UNANSWERED, not not-landed: it re-reads as
 * `unscanned` naming the sha the scan held, so a re-push mid-read can never
 * inherit the previous head's verdict.
 */
export function submitLandingReader(
  scan: LandedSubmitScan | undefined,
  unscannedDetail = "no landing scan was taken for this read",
): SubmitLandingReader {
  if (scan === undefined) {
    return () => ({ state: "unresolved", reason: "unscanned", detail: unscannedDetail })
  }
  const landed = new Map(scan.landed.map((row) => [row.branch, row] as const))
  const unresolved = new Map(scan.unresolved.map((row) => [row.branch, row] as const))
  return ({ branch, sha }) => {
    const hit = landed.get(branch)
    if (hit !== undefined) {
      if (hit.sha !== sha) return staleScanAnswer(branch, sha, hit.sha, unscannedDetail)
      return { state: "landed", ...(hit.mergeCommit === undefined ? {} : { mergeCommit: hit.mergeCommit }) }
    }
    const open = unresolved.get(branch)
    if (open !== undefined) {
      if (open.sha !== sha) return staleScanAnswer(branch, sha, open.sha, unscannedDetail)
      return { state: "unresolved", reason: open.reason, detail: open.detail }
    }
    // Absent from BOTH lists is the scan's own not-landed answer: `landedSubmits`
    // walks every branch in `bays.submits` and pushes each to one list or
    // neither, so omission is a verdict here rather than a gap.
    return { state: "pending" }
  }
}

function staleScanAnswer(branch: string, sha: string, scanned: string, unscannedDetail: string): SubmitLanding {
  return {
    state: "unresolved",
    reason: "unscanned",
    detail:
      `the landing scan answered for '${branch}' at ${scanned}, but the standing fact now reads ${sha} — ` +
      `the fact moved since the scan, so its landing is unanswered here (${unscannedDetail})`,
  }
}

/**
 * The door-side driver step, exported so tests (and, at the door, the compose)
 * derive one branch's admissible member: arbitration guard, admission-time
 * mint (commit-before-escape — `mintChangeId`/reuse inside
 * {@link mintDerivedMemberIdentity}), and identity assembly. `enrichment` is
 * whatever the caller read from git — the tip commit's `Change-Id` trailer,
 * `Bead:`-style props, issue — because this layer never reads git itself.
 *
 * A branch whose tip carries no `Change-Id` trailer (and whose identity was
 * not reused from a retained snapshot that recorded one) runs under a
 * SYNTHETIC change id minted from the submission's stable facts (branch, tip
 * sha): deterministic, so re-composing the same push derives the same
 * identity, and the journaled snapshot then carries it to every later
 * revision of the branch — the terminal `pr/integrated` always has an
 * identity to emit, and the lane serves pushes no tooling stamped.
 * `derived-change-id-missing` remains only for submit facts too non-canonical
 * to mint from, and its cure is the trailer: amend the tip commit and re-push
 * (the record lane no longer accepts recordless branches — the mint retired).
 */
export function deriveRunMemberArgs(
  options: Readonly<{
    bays: DeepReadonly<BaysState>
    queues: DeepReadonly<QueuesState>
    mint: PrNumberMint
    branch: string
    enrichment?: DerivedSubmitEnrichment
  }>,
): DerivedRunMember {
  const { mint, branch, enrichment } = options
  const bays = options.bays as BaysState
  const queues = options.queues as QueuesState
  const records = Object.values(bays.prs).filter((pr) => pr.branch === branch)
  const submit = bays.submits[branch]
  const verdict = arbitrateDerivedChange(records, submit)
  if (verdict.lane !== "derived" || submit === undefined) {
    if (submit === undefined) {
      raiseFailure(
        "refusal",
        "derived-submit-vanished",
        `yrd: branch '${branch}' has no live submit fact — nothing to derive an admission from`,
      )
    }
    raiseFailure(
      "refusal",
      "derived-record-lane",
      `yrd: branch '${branch}' arbitrates to the ${verdict.lane} lane — only a derived-lane branch admits ` +
        `a derived member (record '${verdict.record?.id ?? "?"}' answers for it)`,
    )
  }
  // Identity source order: a retained snapshot's change id (branch continuity
  // across re-pushes) > the tip commit's Change-Id trailer > a synthetic id
  // minted from the submission's stable facts (branch, tip sha). The change id
  // settles BEFORE the number mint can commit: the one remaining refusal —
  // facts too non-canonical to mint a STABLE identity from — must not burn a
  // number per compose retry. The snapshot peek and both mint arms are pure.
  const reusable = latestChangeSnapshot(
    queues as QueuesState,
    (snapshot) => snapshot.branch === branch && !hasChangeRecord(bays, snapshot.id),
  )
  const resolved = resolveChangeIdentity({
    ...(reusable?.changeId === undefined ? {} : { snapshot: reusable.changeId }),
    ...(enrichment?.changeId === undefined ? {} : { trailer: enrichment.changeId }),
    branch,
    sha: submit.sha,
  })
  if (!resolved.ok) {
    raiseFailure(
      "refusal",
      "derived-change-id-missing",
      `yrd: branch '${branch}' tip ${submit.sha} carries no Change-Id trailer, and its submit facts are not ` +
        `canonical (a well-formed ref and a full hex sha) to mint a synthetic identity from — amend the tip ` +
        `commit with a Change-Id trailer and re-push branch + submit ref`,
    )
  }
  const identity = mintDerivedMemberIdentity({ mint, bays, queues, branch })
  const changeId = identity.changeId ?? resolved.changeId
  return {
    branch,
    id: identity.id,
    changeId,
    revision: identity.revision,
    headSha: submit.sha,
    ...(enrichment?.props === undefined ? {} : { props: enrichment.props }),
    ...(enrichment?.issue === undefined ? {} : { issue: enrichment.issue }),
    ...(enrichment?.title === undefined ? {} : { title: enrichment.title }),
  }
}
