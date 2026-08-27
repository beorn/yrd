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
 * Until the door commit retires the 2b intake sweep, no live caller builds
 * `QueueRunArgs.derived`, so every path in this file is reachable only from
 * tests — behavior today is unchanged by construction. The door's compose
 * wires `deriveRunMemberArgs` in where the sweep used to run.
 *
 * 2b's four loud edges re-homed here (design R2; queue.ts sweep policy
 * carried): mint-failure and duplicate-payload PROPAGATE and fail the compose;
 * a vanished/moved submit fact and a live-record collision are typed refusals
 * the selectorless compose skips loudly (the row survives into audit).
 */
import {
  changeComposition,
  changeHead,
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
 * missing its `Change-Id` trailer refuses at derivation, never silently later.
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
 * than a record the store lost (the `missing-pr` audit invariant)? Mechanical
 * discriminator: derived ids mint strictly above the frozen store's max and no
 * record ever mints again post-door (A9), so a recordless, non-intent member
 * whose number exceeds every record's is derived. During an S6 rollback the
 * re-adopting sweep can mint records above old derived runs and transiently
 * re-arm `missing-pr` for them — accepted: the design names S6 soft-reversible
 * and the finding is then pointing at exactly the runs the rollback orphaned.
 */
export function isDerivedRunMember(bays: DeepReadonly<Pick<BaysState, "prs">>, pr: ChangeSnapshot): boolean {
  if (pr.intent !== undefined || bays.prs[pr.id] !== undefined) return false
  const number = changeIdNumber(pr.id)
  if (number === undefined) return false
  const frozenMax = Math.max(0, ...Object.keys(bays.prs).flatMap((id) => changeIdNumber(id) ?? []))
  return number > frozenMax
}

function changeIdNumber(id: string): number | undefined {
  const match = /^PR(\d+)$/u.exec(id)
  return match === null ? undefined : Number(match[1])
}

/**
 * Every branch the DERIVED lane currently owns: a live submit fact whose
 * arbitration verdict is "derived" (no record, or only a terminal one at a
 * different sha). This is the door compose's selection universe — the exact
 * population the retired 2b sweep used to mint records for, plus the
 * terminal-branch re-submissions the sweep could never see.
 */
export function derivedLaneBranches(bays: DeepReadonly<BaysState>): string[] {
  return Object.keys(bays.submits)
    .filter((branch) => {
      const records = Object.values(bays.prs).filter((pr) => pr.branch === branch)
      return arbitrateDerivedChange(records as Change[], bays.submits[branch]).lane === "derived"
    })
    .toSorted()
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
 * not reused from a retained snapshot that recorded one) refuses
 * `derived-change-id-missing`: without it the terminal `pr/integrated` could
 * never be emitted and settlement would go dark — the exact silence the
 * re-sourced emitters exist to prevent.
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
  // Refuse a missing Change-Id BEFORE the mint can commit a number: without
  // this order every compose would burn one number per still-unenriched
  // branch. The reuse path is pure (no commit), so peeking it first is free.
  const reusable = latestChangeSnapshot(
    queues as QueuesState,
    (snapshot) => snapshot.branch === branch && bays.prs[snapshot.id] === undefined,
  )
  if (reusable?.changeId === undefined && enrichment?.changeId === undefined) {
    raiseFailure(
      "refusal",
      "derived-change-id-missing",
      `yrd: branch '${branch}' tip ${submit.sha} carries no Change-Id trailer and no retained snapshot ` +
        `supplies one — amend the commit with a Change-Id trailer and re-push branch + submit ref`,
    )
  }
  const identity = mintDerivedMemberIdentity({ mint, bays, queues, branch })
  const changeId = identity.changeId ?? enrichment?.changeId
  if (changeId === undefined) {
    throw new Error(`yrd: derived member for '${branch}' lost its change id between peek and mint`)
  }
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
