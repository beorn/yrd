/**
 * Derived-member ADMISSION (@i/10-merge-queue/s6-door-design §2, §5 ordering
 * item 3): the machinery that lets a branch with a live submit fact and no
 * `Change` record enter selection, run checks against its submit-ref sha, and
 * start a Queue run under an admission-time minted identity.
 *
 * Everything here is a PURE DERIVATION over surviving projections
 * (`bays.submits`, `QueuesState`) plus caller-supplied identity — nothing
 * persists, nothing journals a new event type, nothing adds state shape (the
 * §3 identity trap, avoided by construction). A derived member's only durable
 * home stays the `queue/run/started` `ChangeSnapshot`.
 *
 * S7 (branch-is-change, @i/10 22991) removed the other lane this file used to
 * arbitrate against: with no `Change` record materializable, every live submit
 * fact is a derived member and "derived" stopped being a distinction. What
 * remains of 2b's loud edges is mint-failure, which PROPAGATES and fails the
 * compose, and the vanished/moved submit fact, a typed refusal the selectorless
 * compose skips loudly (the row survives into audit).
 */
import {
  changeIdForDerivedSubmit,
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
  latestChangeSnapshot,
  Queues,
  type ChangeSnapshot,
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
 * Validation is what survives S7 of the four loud edges (design R2) — both
 * remaining edges are statements about the live submit fact, which is now the
 * whole of a branch's delivery:
 *
 * - no live submit fact for the branch ⇒ refusal `derived-submit-vanished`
 * - live fact whose sha ≠ the member's ⇒ refusal `derived-submit-moved`
 *   (the git-CAS: a re-push supersedes the admission that was in flight)
 *
 * The other two edges guarded against the record store and retired with it: a
 * live record owning the branch, and a second record carrying the same payload
 * under another identity, are both unrepresentable once no record exists. The
 * within-batch duplicate guard in {@link materializeDerivedRunMembers} is what
 * still catches one branch admitted twice in one compose.
 */
export function materializeDerivedRunMembers(
  bays: DeepReadonly<BaysState>,
  derived: readonly DerivedRunMember[],
): Change[] {
  const seen = new Set<string>()
  return derived.map((member) => {
    if (seen.has(member.id) || seen.has(member.branch)) {
      raiseFailure("usage", "duplicate-pr", `yrd: queue.run: duplicate derived member '${member.id}'`)
    }
    seen.add(member.id)
    seen.add(member.branch)
    return materializeDerivedRunMember(bays, member)
  })
}

function materializeDerivedRunMember(bays: DeepReadonly<BaysState>, member: DerivedRunMember): Change {
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
  return {
    id: member.id,
    branch: member.branch,
    base: submit.base,
    state: "open",
    merged: false,
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
 * Answers `undefined` for an intent member (a pin-advance materialization, not
 * a change) and for any member whose fact vanished or moved — the caller's gap
 * machinery then reports `missing`.
 */
export function derivedAuthorityLookup(
  state: Readonly<{ bays: DeepReadonly<BaysState>; queues: DeepReadonly<QueuesState> }>,
  options: Readonly<{ excludeRun?: RunId }> = {},
): DerivedAuthorityLookup {
  return (pr) => {
    if (pr.intent !== undefined) return undefined
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
 * Every branch the DERIVED lane currently owns — which, since S7, is every
 * branch carrying a live submit fact. This is the compose's selection
 * universe.
 *
 * The three exclusions this filter used to apply were all statements about the
 * record store, and all became unrepresentable with it: no branch can have a
 * LIVE record owning it, no fact can point at a RECORD's landing commit (the
 * PR2139 double-merge cell), and `arbitrateDerivedChange` over an empty record
 * set answers "derived" for every live fact. One submit fact now has exactly
 * one possible consumer by construction rather than by filtering.
 *
 * The PR2139 hazard itself — a fact standing at content already merged, which
 * would compose an empty revision — did NOT retire with the record store; it
 * is caught downstream instead, and by a stronger rule. {@link
 * derivedAuthorityLookup} marks a fact CONSUMED once a retained root run that
 * planned a merge named the same branch+sha and was not released, so a merged
 * branch's surviving fact has no standing authority and is ejected before it
 * can run again. That test is keyed on run history rather than on a record's
 * `integration.commit`, so it covers derived merges too — the case the old
 * filter could not see. It holds for as long as the consuming run is retained.
 */
export function derivedLaneBranches(bays: DeepReadonly<BaysState>): string[] {
  return Object.keys(bays.submits).toSorted()
}

/**
 * Is this run member on the derived lane?
 *
 * S7 kept the name and dropped the argument. It used to need the bay state, to
 * ask whether the member's id also named a stored record; with the store gone
 * the only non-derived member left is an intent, so the question answers from
 * the member itself. The concept still earns a name — "a run member on the
 * derived lane" is how the queue talks about its own work — and inlining the
 * field test at each call site would spend that vocabulary to save a function.
 */
export function isDerivedRunMember(member: DeepReadonly<ChangeSnapshot>): boolean {
  return member.intent === undefined
}

/** Has this content already merged into the base? Supplied by the caller
 * because this layer never reads git itself. */
export type LandedContentOracle = (sha: string) => boolean

/**
 * Standing facts pointing at content the queue ALREADY MERGED — a submission
 * surviving as a re-projected ref, which is the PR2139 double-merge's exact
 * signature. These never compose; the compose warns one row per branch (NO
 * SILENT ERRORS) and the cure is retiring the stale fact, never a resubmit.
 *
 * S7 re-sourced the question. It used to ask "is there a terminal RECORD for
 * this branch whose integration commit equals the fact's sha" — a store lookup,
 * so with the record store deleted it could never fire again, and deleting the
 * guard with the store would have silently reopened the incident class. The
 * question it was really asking is "has this content already merged", which git
 * answers directly and for EVERY branch, including the ones that never had a
 * record — which, post-S7, is all of them. So the guard covers strictly more
 * than it did, and it takes its answer from the caller rather than reaching for
 * git from a pure layer.
 */
export function alreadyLandedSubmits(
  bays: DeepReadonly<BaysState>,
  hasLanded: LandedContentOracle,
): Readonly<{ branch: string; sha: string }>[] {
  return Object.entries(bays.submits)
    .flatMap(([branch, submit]) => (submit !== undefined && hasLanded(submit.sha) ? [{ branch, sha: submit.sha }] : []))
    .toSorted((left, right) => left.branch.localeCompare(right.branch))
}

/**
 * Branches whose standing facts collide on one payload: two or more submit
 * facts at the SAME sha. The record store used to catch this by looking the
 * payload up among live records; with no store, nothing did, and the collision
 * became invisible.
 *
 * Reported rather than refused, deliberately. Two branches at one sha is
 * legitimate more often than not — a rename, or a re-push under a new name —
 * and whichever merges second is caught by {@link alreadyLandedSubmits} on the
 * next pass. What is NOT acceptable is saying nothing, so the compose warns
 * with the branches named and lets the operator decide which one is the work.
 */
export function duplicatePayloadSubmits(
  bays: DeepReadonly<BaysState>,
): Readonly<{ sha: string; branches: readonly string[] }>[] {
  const byPayload = new Map<string, string[]>()
  for (const [branch, submit] of Object.entries(bays.submits)) {
    if (submit === undefined) continue
    const claimants = byPayload.get(submit.sha)
    if (claimants === undefined) byPayload.set(submit.sha, [branch])
    else claimants.push(branch)
  }
  return [...byPayload.entries()]
    .flatMap(([sha, branches]) => (branches.length > 1 ? [{ sha, branches: branches.toSorted() }] : []))
    .toSorted((left, right) => left.sha.localeCompare(right.sha))
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
  const submit = bays.submits[branch]
  // The live fact is the whole arbitration since S7: with no records to lose
  // to, a branch that has one admits and a branch that has none has nothing to
  // derive from.
  if (submit === undefined) {
    raiseFailure(
      "refusal",
      "derived-submit-vanished",
      `yrd: branch '${branch}' has no live submit fact — nothing to derive an admission from`,
    )
  }
  // Identity source order: a retained snapshot's change id (branch continuity
  // across re-pushes) > the tip commit's Change-Id trailer > a synthetic id
  // minted from the submission's stable facts (branch, tip sha). The change id
  // settles BEFORE the number mint can commit: the one remaining refusal —
  // facts too non-canonical to mint a STABLE identity from — must not burn a
  // number per compose retry. The snapshot peek and both mint arms are pure.
  const reusable = latestChangeSnapshot(queues as QueuesState, (snapshot) => snapshot.branch === branch)
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
