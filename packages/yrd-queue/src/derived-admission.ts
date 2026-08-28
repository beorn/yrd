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
  changeIdForDerivedSubmit,
  baseIdentity,
  isLiveChange,
  ChangeIdSchema,
  ChangePropsSchema,
  GitRefSchema,
  GitShaSchema,
  PRIdSchema,
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
} from "./model.ts"
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
  if (bays.prs[member.id] !== undefined) {
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
    if (state.bays.prs[pr.id] !== undefined) return undefined
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
  return pr.intent === undefined && bays.prs[pr.id] === undefined
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
 * commit itself), excluded via {@link alreadyLandedSubmits}; a terminal
 * branch's genuinely NEW head composes here — post-purge the derived lane is
 * the only re-entry (Q1).
 */
export function derivedLaneBranches(bays: DeepReadonly<BaysState>): string[] {
  return Object.keys(bays.submits)
    .filter((branch) => {
      const records = Object.values(bays.prs).filter((pr) => pr.branch === branch)
      // One-lane-consumes, decided by LIVE ownership plus landed content:
      // - a LIVE record owns its branch, so its standing fact is that
      //   record's own pending signal, never a derived admission;
      // - a fact pointing AT a terminal record's landing commit is the
      //   PR2139 incident cell — content already on main, a stale
      //   re-projection, not an approval of new work (the empty double-merge
      //   minted exactly there);
      // - any OTHER terminal-record branch composes: post-purge (the legacy
      //   mint is retired) the derived lane IS the only re-entry for a merged
      //   or withdrawn branch's next head (Q1), and excluding record history
      //   wholesale would strand every resubmit.
      if (records.some((pr) => isLiveChange(pr as Change))) return false
      if (alreadyLandedSubmits(bays).some((row) => row.branch === branch)) return false
      return arbitrateDerivedChange(records as Change[], bays.submits[branch]).lane === "derived"
    })
    .toSorted()
}

/**
 * Standing facts whose sha IS a terminal record's landing commit for the same
 * branch: content the queue already merged, surviving as a re-projected ref —
 * the PR2139 double-merge's exact signature. These never compose; the compose
 * warns one row per branch (NO SILENT ERRORS) and the cure is retirement of
 * the stale fact, not a resubmit.
 */
export function alreadyLandedSubmits(
  bays: DeepReadonly<BaysState>,
): Readonly<{ branch: string; sha: string; record: string }>[] {
  return Object.keys(bays.submits)
    .flatMap((branch) => {
      const submit = bays.submits[branch]
      if (submit === undefined) return []
      const landed = Object.values(bays.prs).find(
        (pr) => pr.branch === branch && !isLiveChange(pr as Change) && pr.integration?.commit === submit.sha,
      )
      return landed === undefined ? [] : [{ branch, sha: submit.sha, record: landed.id }]
    })
    .toSorted((left, right) => left.branch.localeCompare(right.branch))
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
    (snapshot) => snapshot.branch === branch && bays.prs[snapshot.id] === undefined,
  )
  const settledChangeId = reusable?.changeId ?? enrichment?.changeId ?? mintSyntheticChangeId(branch, submit.sha)
  const identity = mintDerivedMemberIdentity({ mint, bays, queues, branch })
  const changeId = identity.changeId ?? settledChangeId
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

/**
 * The synthetic arm of the identity ladder: mint a trailerless tip's change id
 * from the submission's stable facts via {@link changeIdForDerivedSubmit} —
 * deterministic, so a re-compose of the same push derives the same identity,
 * and the run's journaled `ChangeSnapshot` then anchors it for every later
 * revision of the branch. Refuses — commit-free, so the caller's number mint
 * never burns on a refused branch — only when the facts are not canonical (a
 * malformed ref or non-hex sha): an identity minted from a non-canonical fact
 * would not be stable across re-derivations, which is the mint's entire
 * contract. The cure is the trailer — amend the tip commit and re-push (the
 * record-lane out retired with the legacy mint).
 */
function mintSyntheticChangeId(branch: string, sha: string): string {
  if (!GitRefSchema.safeParse(branch).success || !GitShaSchema.safeParse(sha).success) {
    raiseFailure(
      "refusal",
      "derived-change-id-missing",
      `yrd: branch '${branch}' tip ${sha} carries no Change-Id trailer, and its submit facts are not ` +
        `canonical (a well-formed ref and a full hex sha) to mint a synthetic identity from — amend the tip ` +
        `commit with a Change-Id trailer and re-push branch + submit ref`,
    )
  }
  return changeIdForDerivedSubmit({ branch, sha })
}
