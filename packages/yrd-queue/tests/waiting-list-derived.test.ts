/**
 * @failure The queue's WAITING LIST reports a standing submit fact as pending
 * after its content has landed, and keeps reporting it on every pass until a
 * human retires the ref.
 *
 * Measured live 2026-08-28 on the hh bay: 16 standing submit facts, 11 of them
 * already ancestors of `origin/main` by `git merge-base --is-ancestor`, and the
 * change-record store said 0 had landed. `unrecordedSubmits` was a pure
 * synchronous projection over `bays.submits` filtered only by "no record" and
 * "no admitted snapshot at this sha" — it never asked git — so ~70% of the list
 * was garbage, re-detected and re-announced every few minutes, each row
 * printing `git push bay :refs/yrd/submit/<branch>` for someone to run, with
 * the five genuinely-pending changes buried among them.
 *
 * The fix these tests fence is derive-at-read, not retirement. Automatic
 * retirement (emitting `branch/unsubmitted { reason: "superseded" }`) is the
 * store-at-write shape: a second thing that must happen, silently wrong
 * whenever it is missed, and whose FALSE POSITIVE deletes a live approval
 * unrecoverably. Under derive-at-read the ref can be swept on any schedule — or
 * never — and the list stays right, because pendingness is answered from the
 * repository at the moment the question is asked.
 *
 * That argument is about the LIST, and it still holds: pendingness is derived,
 * never stored. It is not an argument against retiring a fact the queue has
 * PROVEN spent, and one narrow retirement now exists beside it — the compose
 * retires a fact whose own commit is an ancestor of its base
 * (`compose-retires-landed-facts.test.ts`). Read the two together: the false
 * positive feared here is the `via: "change-id"` arm, which that pass
 * deliberately never retires, and the retirement it does perform is a journal
 * event over a ref that still exists, so a re-push restores the consent this
 * file is protecting.
 *
 * What the submit ref still owns, and why it is narrowed rather than deleted:
 * the consent triple `{sha, base, at}`. Ancestry is relative to a base, so
 * `base` is needed to even form the query; `at` is consent time and ancestry
 * has no clock; and consent EXISTENCE cannot be derived at all — ancestry says
 * "this content is on main", never "someone approved landing it". Only the
 * pending BIT moves.
 *
 * @level l2
 * @consumer @yrd/queue `unrecordedSubmits` (the waiting list), `queue audit`'s
 *   `unrecorded-submit` finding, and the empty-run diagnostic's considered rows
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { createBayJobDefs, withBays, volatilePrNumberMint, type BaysState, type BayWorkspace } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe, type DeepReadonly } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import {
  candidateRefFor,
  withMerge,
  withQueue,
  withStep,
  type CandidatePreparer,
  type IntegrationProof,
  type LandedSubmitScan,
  type StepExecution,
} from "@yrd/queue"

const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
/** A fact whose content the repository already carries. */
const LANDED_SHA = "c".repeat(40)
/** A fact still genuinely waiting. */
const PENDING_SHA = "7".repeat(40)
/** A second head for the same branch, to prove a moved fact inherits nothing. */
const MOVED_SHA = "8".repeat(40)
const CheckResultSchema = z.object({ checked: z.boolean() }).strict()

function ids(): () => string {
  let value = 0
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace(): BayWorkspace {
  return {
    revision: "test-workspace-v1",
    provision: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: `/repo/.bays/${input.bay}`, headSha: PENDING_SHA, baseSha: BASE },
    }),
    refresh: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: input.path ?? "/repo/.bays/bay", headSha: PENDING_SHA, baseSha: BASE, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed",
      conclusion: "success",
      output: { headSha: PENDING_SHA, pushed: true, wip: false },
    }),
    deprovision: () => ({ status: "completed", conclusion: "success", output: {} }),
  }
}

const mergeableCandidate: CandidatePreparer = (input) => {
  const { prs: _prs, ...candidate } = input
  return { ...candidate, sha: MERGED, ref: candidateRefFor(MERGED), mergeability: "mergeable" }
}

type ScanInput = Readonly<{ bays: DeepReadonly<BaysState> }>

/**
 * A queue whose repository reader is supplied by the test.
 *
 * `scan` stands in for the host's `landedSubmitScanner` — one first-parent walk
 * per base plus a containment query per fact. `undefined` is the UNWIRED
 * process, which is a distinct state from "nothing landed" and must read that
 * way everywhere.
 */
async function createApp(
  options: Readonly<{ scan?: (input: ScanInput) => Promise<LandedSubmitScan>; mint?: boolean }> = {},
) {
  const check = withStep(
    "check",
    (_input: StepExecution): JobResult<z.infer<typeof CheckResultSchema>> => ({
      status: "completed",
      conclusion: "success",
      output: { checked: true },
    }),
    { revision: "check-v1", output: CheckResultSchema },
  )
  const merge = withMerge(
    async (): Promise<JobResult<IntegrationProof>> => ({
      status: "completed",
      conclusion: "success",
      output: { commit: MERGED, baseSha: BASE },
    }),
    { revision: "merge-v1" },
  )
  const queue = withQueue({
    steps: [check, merge] as const,
    batch: false,
    defaultSteps: ["check", "merge"],
    resolveBaseSha: () => BASE,
    prepareCandidate: mergeableCandidate,
    ...(options.mint === false ? {} : { prNumberMint: volatilePrNumberMint() }),
    readSubmitEnrichment: ({ sha }: Readonly<{ sha: string }>) => ({ changeId: `I${sha}` }),
    ...(options.scan === undefined ? {} : { scanLandedSubmits: options.scan }),
  })
  const bayJobs = createBayJobDefs(workspace())
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ prNumberMint: volatilePrNumberMint(), jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: {
      journal: createMemoryJournal(),
      id: ids(),
      clock: () => "2026-01-01T00:00:00.000Z",
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
}

/** The host's real answer shape: every fact whose sha is in `landed` is
 * contained in the walked tip; every other fact is absent from both lists,
 * which IS the scan's not-landed answer. */
function ancestryScan(landed: ReadonlySet<string>): (input: ScanInput) => Promise<LandedSubmitScan> {
  return ({ bays }) =>
    Promise.resolve({
      landed: Object.entries(bays.submits).flatMap(([branch, fact]) =>
        landed.has(fact.sha) ? [{ branch, sha: fact.sha, via: "ancestry" as const, mergeCommit: MERGED }] : [],
      ),
      unresolved: [],
      facts: Object.keys(bays.submits).length,
    })
}

describe("the waiting list derives pendingness from the repository (2026-08-28: 11 of 16 rows were landed)", () => {
  it("a fact whose content the repository already carries is NOT on the list, and its ref is still there", async () => {
    await using app = await createApp({ scan: ancestryScan(new Set([LANDED_SHA])) })
    await app.bays.recordBranchSubmit({ branch: "task/landed", sha: LANDED_SHA, base: "main" })
    await app.bays.recordBranchSubmit({ branch: "task/pending", sha: PENDING_SHA, base: "main" })

    const waiting = await app.queue.unrecordedSubmits()
    expect(
      waiting.map((row) => row.branch),
      "the landed fact is derived as not-pending",
    ).toEqual(["task/pending"])
    expect(waiting[0]?.landing).toEqual({ state: "pending" })

    // The whole point: nothing was retired to make that true. A store-at-write
    // fix would have had to emit `branch/unsubmitted` here, and a false positive
    // would have deleted a live approval.
    expect(Object.keys(app.state().bays.submits).toSorted(), "the refs are untouched").toEqual([
      "task/landed",
      "task/pending",
    ])
    expect(app.state().bays.submits["task/landed"]?.sha).toBe(LANDED_SHA)

    // Positive control for the zero: the SAME fixture with an empty landed set
    // puts both branches back on the list, so the absence above is the scan's
    // answer and not a broken fixture.
    await using control = await createApp({ scan: ancestryScan(new Set()) })
    await control.bays.recordBranchSubmit({ branch: "task/landed", sha: LANDED_SHA, base: "main" })
    await control.bays.recordBranchSubmit({ branch: "task/pending", sha: PENDING_SHA, base: "main" })
    expect((await control.queue.unrecordedSubmits()).map((row) => row.branch)).toEqual(["task/landed", "task/pending"])
  })

  it("the branch-keyed derivation agrees: a landed branch has no unrecorded row", async () => {
    await using app = await createApp({ scan: ancestryScan(new Set([LANDED_SHA])) })
    await app.bays.recordBranchSubmit({ branch: "task/landed", sha: LANDED_SHA, base: "main" })
    await app.queue.scanLanding()

    const derived = app.queue.deriveChange("task/landed")
    expect(derived.submit, "the fact itself is still readable — it holds the consent triple").toMatchObject({
      sha: LANDED_SHA,
      base: "main",
      at: "2026-01-01T00:00:00.000Z",
    })
    expect(derived.unrecorded, "but it is not waiting on anything").toBeUndefined()
  })

  it("an UNANSWERABLE fact is neither pending nor landed — it carries its own state and reason", async () => {
    // merged-truth's two non-answers. `degenerate` is the self-comparison
    // door-stop (the fact stands at the walked tip, so containment holds for
    // free and proves nothing); `unreadable` is a sha git could not resolve.
    // Collapsing either into pending or landed is how the list lies.
    await using app = await createApp({
      scan: ({ bays }) =>
        Promise.resolve({
          landed: [],
          unresolved: [
            { branch: "task/tip", sha: PENDING_SHA, reason: "degenerate" as const, detail: "fact IS the walked tip" },
            { branch: "task/gone", sha: MOVED_SHA, reason: "unreadable" as const, detail: "git: bad object" },
          ],
          facts: Object.keys(bays.submits).length,
        }),
    })
    await app.bays.recordBranchSubmit({ branch: "task/tip", sha: PENDING_SHA, base: "main" })
    await app.bays.recordBranchSubmit({ branch: "task/gone", sha: MOVED_SHA, base: "main" })

    const waiting = await app.queue.unrecordedSubmits()
    expect(
      waiting.map((row) => row.branch),
      "neither is dropped",
    ).toEqual(["task/gone", "task/tip"])
    expect(waiting.map((row) => row.landing)).toEqual([
      { state: "unresolved", reason: "unreadable", detail: "git: bad object" },
      { state: "unresolved", reason: "degenerate", detail: "fact IS the walked tip" },
    ])
    // The reason reaches the MESSAGE too: the audit finding and the empty-run
    // diagnostic print only that, so a row unverified in the structured field
    // and confident in its prose would still read as a verdict.
    for (const row of waiting) expect(row.reason.message).toContain("UNVERIFIED")
  })

  it("with NO repository reader, no row claims to be pending — every one says nobody asked", async () => {
    await using app = await createApp()
    await app.bays.recordBranchSubmit({ branch: "task/landed", sha: LANDED_SHA, base: "main" })

    const waiting = await app.queue.unrecordedSubmits()
    expect(waiting.map((row) => row.landing)).toEqual([
      { state: "unresolved", reason: "unscanned", detail: expect.stringContaining("no scanLandedSubmits reader") },
    ])
    expect(waiting[0]?.reason.message).toContain("UNVERIFIED")
    // Never the change-record store's answer: that store needed a terminal
    // record for the branch (post-purge a merged branch usually has none) and
    // compared the fact's sha to `integration.commit`, which a merge-time
    // rebuild does not preserve. Both failures read as "not landed", which is
    // the double-merge's own signature.
    expect(waiting[0]?.landing).not.toEqual({ state: "pending" })

    // Positive control: the same fixture WITH a reader answers pending, so the
    // `unscanned` above is the missing capability and not the fixture.
    await using wired = await createApp({ scan: ancestryScan(new Set()) })
    await wired.bays.recordBranchSubmit({ branch: "task/landed", sha: LANDED_SHA, base: "main" })
    expect((await wired.queue.unrecordedSubmits())[0]?.landing).toEqual({ state: "pending" })
  })

  it("a fact that MOVED since the scan inherits nothing from the previous head", async () => {
    // The memo that lets the sync surfaces (a pure reducer, the audit) share
    // the compose's scan is keyed by a fingerprint of the exact facts it was
    // taken over. A re-push mid-read must therefore read `unscanned`, never the
    // old head's verdict — a stale answer would be worse than no memo.
    await using app = await createApp({ scan: ancestryScan(new Set([LANDED_SHA])) })
    await app.bays.recordBranchSubmit({ branch: "task/moved", sha: LANDED_SHA, base: "main" })
    await app.queue.scanLanding()
    expect(app.queue.deriveChange("task/moved").unrecorded, "landed at the scanned sha").toBeUndefined()

    await app.bays.recordBranchSubmit({ branch: "task/moved", sha: MOVED_SHA, base: "main" })
    const moved = app.queue.deriveChange("task/moved").unrecorded
    expect(moved?.landing, "the new head is unanswered, not landed and not pending").toMatchObject({
      state: "unresolved",
      reason: "unscanned",
    })

    // Asking again re-scans, because the facts changed: the new head is
    // genuinely pending and says so.
    expect((await app.queue.unrecordedSubmits())[0]?.landing).toEqual({ state: "pending" })
  })

  it("the waiting list itself can NEVER read `unscanned` while a reader is wired — even as facts move under it", async () => {
    // The memo's fingerprint makes a MISS possible, and a miss that filled the
    // list with `unscanned` rows would be useless in a new way rather than the
    // old way. It cannot happen on this surface by construction: the scan and
    // the read take the SAME immutable snapshot in one statement, so the
    // fingerprint is computed twice over the same value and always hits. The
    // exposure is only for the sync surfaces reading a scan taken earlier in
    // the pass (the pure reducer), which is the case the moved-fact test above
    // fences.
    await using app = await createApp({ scan: ancestryScan(new Set([LANDED_SHA])) })
    await app.bays.recordBranchSubmit({ branch: "task/pending", sha: PENDING_SHA, base: "main" })
    const first = await app.queue.unrecordedSubmits()
    expect(first.map((row) => row.landing)).toEqual([{ state: "pending" }])

    // Move the fact set under it — a new branch AND a re-push of the old one,
    // which is what a busy bay does between passes — and ask again.
    await app.bays.recordBranchSubmit({ branch: "task/pending", sha: MOVED_SHA, base: "main" })
    await app.bays.recordBranchSubmit({ branch: "task/landed", sha: LANDED_SHA, base: "main" })
    const second = await app.queue.unrecordedSubmits()
    expect(
      second.map((row) => row.branch),
      "the newly landed fact is still excluded",
    ).toEqual(["task/pending"])
    expect(
      second.map((row) => row.landing),
      "and nothing degraded to unscanned",
    ).toEqual([{ state: "pending" }])
  })

  it("`queue audit` stops paging for landed facts, and the empty-run diagnostic stops considering them", async () => {
    await using app = await createApp({ scan: ancestryScan(new Set([LANDED_SHA])) })
    await app.bays.recordBranchSubmit({ branch: "task/landed", sha: LANDED_SHA, base: "main" })
    await app.bays.recordBranchSubmit({ branch: "task/pending", sha: PENDING_SHA, base: "main" })
    await app.queue.scanLanding()

    const findings = app.queue
      .audit({ now: "2026-01-01T06:00:00.000Z" })
      .findings.filter((finding) => finding.code === "unrecorded-submit")
    expect(
      findings.map((finding) => finding.specimen),
      "one page, not two",
    ).toEqual(["branch:task/pending"])

    // The considered rows of an empty run answer from the same derivation, so
    // the two surfaces can never disagree about what is waiting.
    const empty = await app.dispatch(app.commands.queue.run, {})
    expect(empty.events).toEqual([])
    expect(empty.value).toMatchObject({
      kind: "no-runnable-prs",
      considered: [{ branch: "task/pending", sha: PENDING_SHA, code: "unrecorded-submit" }],
    })
  })
})
