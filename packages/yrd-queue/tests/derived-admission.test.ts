/**
 * @failure The S6 door opens and a branch submitted only in git either cannot
 * run at all (selection/admission/authority all key on records), runs twice
 * under both lanes, silently loses its terminal `pr/integrated` (settlement
 * and every status surface go dark), or its identity is minted without the
 * commit-before-escape contract. Stage 3 of the door program
 * (@i/10-merge-queue/s6-door-design §5 ordering item 3): derived members are
 * selectable, admittable and runnable, and the terminal emitters re-source
 * from the run's own ChangeSnapshot — proven with the door SIMULATED, because
 * the mint arms and the 2b intake sweep still stand. The simulation vehicle is
 * the decisive terminal×different-sha cell: a branch with a terminal record is
 * invisible to the sweep, so its live re-submission is exactly the derived
 * member the door will produce. Tests that need the RELAXED reducer (applying
 * a recordless terminal event) are written and skipped "enables-at-door".
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { createBayJobDefs, volatilePrNumberMint, withBays, type BayWorkspace, type PrNumberMint } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, failureFact, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import {
  advanceQueue,
  candidateRefFor,
  deriveRunMemberArgs,
  derivedAuthorityLookup,
  isDerivedRunMember,
  materializeDerivedRunMembers,
  Queues,
  withMerge,
  withQueue,
  withStep,
  type CandidatePreparer,
  type DerivedRunMember,
  type IntegrationProof,
  type StepExecution,
} from "@yrd/queue"

const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const SHA = "7".repeat(40)
const RESUBMIT_SHA = "8".repeat(40)
const CHANGE_ID = `I${"c".repeat(40)}`
const runtime = { runner: "local", leaseMs: 60_000 }
const CheckResultSchema = z.object({ checked: z.boolean() }).strict()
type CheckResult = z.infer<typeof CheckResultSchema>

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
      output: { path: `/repo/.bays/${input.bay}`, headSha: SHA, baseSha: BASE },
    }),
    refresh: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: SHA, baseSha: BASE, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed",
      conclusion: "success",
      output: { headSha: SHA, pushed: true, wip: false },
    }),
    deprovision: () => ({ status: "completed", conclusion: "success", output: {} }),
  }
}

const mergeableCandidate: CandidatePreparer = (input) => {
  const { prs: _prs, ...candidate } = input
  return { ...candidate, sha: MERGED, ref: candidateRefFor(MERGED), mergeability: "mergeable" }
}

const passingCheck = () =>
  withStep(
    "check",
    (_input: StepExecution): JobResult<CheckResult> => ({
      status: "completed",
      conclusion: "success",
      output: { checked: true },
    }),
    { revision: "check-v1", output: CheckResultSchema },
  )

const passingMerge = () =>
  withMerge(
    async (): Promise<JobResult<IntegrationProof>> => ({
      status: "completed",
      conclusion: "success",
      output: { commit: MERGED, baseSha: BASE },
    }),
    { revision: "merge-v1" },
  )

const authorFailingMerge = () =>
  withMerge(
    async (): Promise<JobResult<IntegrationProof>> => ({
      status: "completed",
      conclusion: "failure",
      error: { code: "authored-gitlink", message: "yrd: the branch authors a gitlink bump it may not carry" },
    }),
    { revision: "merge-v1" },
  )

async function createApp(
  options: Readonly<{
    journal?: ReturnType<typeof createMemoryJournal>
    id?: () => string
    log?: ReturnType<typeof createLogger>
    steps?: readonly ReturnType<typeof passingCheck | typeof passingMerge>[]
    defaultSteps?: readonly string[]
  }> = {},
) {
  const steps = options.steps ?? ([passingCheck(), passingMerge()] as const)
  // The step set varies per test, so the tuple literal withQueue's generics
  // infer from is erased here; the runtime shape is exactly the inferred one.
  const queue = withQueue({
    steps,
    batch: false,
    defaultSteps: options.defaultSteps ?? ["check", "merge"],
    resolveBaseSha: () => BASE,
    prepareCandidate: mergeableCandidate,
  } as never as Parameters<typeof withQueue>[0])
  const bayJobs = createBayJobDefs(workspace())
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ prNumberMint: volatilePrNumberMint(), jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: {
      journal: options.journal ?? createMemoryJournal(),
      id: options.id ?? ids(),
      clock: () => "2026-01-01T00:00:00.000Z",
      log: options.log ?? createLogger("test", [{ level: "silent" }]),
    },
  })
}

type App = Awaited<ReturnType<typeof createApp>>

/**
 * The door simulation: a branch whose record went terminal, re-submitted in
 * git at a NEW sha. The 2b sweep skips it (a record in ANY state hides the
 * branch from `unrecordedSubmits`), the arbitration rules it derived
 * (terminal×different-sha — the decisive A4 cell), and the derived-admission
 * path is the only way it can ever run — exactly the post-door regime.
 */
async function strandDerivedBranch(app: App, branch: string, sha: string = SHA): Promise<void> {
  await app.bays.submit({ branch, headSha: "9".repeat(40), base: "main", baseSha: BASE })
  const record = Object.values(app.state().bays.prs).find((pr) => pr.branch === branch)
  if (record === undefined) throw new Error(`no record for '${branch}'`)
  await app.bays.closePr({ pr: record.id, reason: "superseded" })
  await app.bays.recordBranchSubmit({ branch, sha, base: "main" })
}

function doorEntry(
  app: App,
  branch: string,
  options: Readonly<{ mint?: PrNumberMint; props?: Record<string, string>; issue?: string }> = {},
): DerivedRunMember {
  return deriveRunMemberArgs({
    bays: app.state().bays,
    queues: app.state().queues,
    mint: options.mint ?? volatilePrNumberMint(1),
    branch,
    enrichment: {
      changeId: CHANGE_ID,
      ...(options.props === undefined ? {} : { props: options.props }),
      ...(options.issue === undefined ? {} : { issue: options.issue }),
    },
  })
}

function stepsMapOf(app: App): ReadonlyMap<string, never> {
  const installed = app.queue.steps()
  return new Map(installed.map((step) => [step.name, { ...step, declaredDefault: true } as never]))
}

describe("S6 stage 3 — derived-member selection, admission, run", () => {
  it("a derived member is selected, admitted against its submit-ref sha, and runs under its minted identity with zero record writes (A1 shape, check-only plan)", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    {
      await using app = await createApp({ journal, id, steps: [passingCheck()], defaultSteps: ["check"] })
      await strandDerivedBranch(app, "issue/derived")
      const prsBefore = structuredClone(app.state().bays.prs)
      const receiptsBefore = structuredClone(app.state().bays.receipts)

      // Admission-time mint (A9): terminal record PR1 is the frozen max, the
      // mint's own high-water is 1 — the derived member mints strictly above
      // both, and the revision continues the pre-door branch's count.
      const mint = volatilePrNumberMint(1)
      const entry = doorEntry(app, "issue/derived", { mint, props: { bead: "22991" }, issue: "22991" })
      expect(entry).toMatchObject({ id: "PR2", branch: "issue/derived", revision: 2, headSha: SHA })
      expect(mint.highWater()).toBe(2)

      const runs = await app.queue.run({ derived: [entry] }, runtime)
      expect(runs).toMatchObject([{ status: "completed", conclusion: "success" }])

      // The run's snapshot carries the minted identity and the submit fact's
      // exact sha — the id's first escape is this journaled snapshot.
      const record = Queues.values(app.state().queues).find((run) => run.prs.some((pr) => pr.id === "PR2"))
      if (record === undefined) throw new Error("expected a queue run for the derived member")
      expect(record.prs[0]).toMatchObject({
        id: "PR2",
        changeId: CHANGE_ID,
        branch: "issue/derived",
        revision: 2,
        headSha: SHA,
        props: { bead: "22991" },
        issue: "22991",
      })

      // Zero record writes: the store is byte-identical across the lifecycle,
      // and the submit fact still stands (nothing superseded it — the door
      // regime has no takeover act).
      expect(app.state().bays.prs).toEqual(prsBefore)
      expect(app.state().bays.receipts).toEqual(receiptsBefore)
      expect(app.state().bays.submits["issue/derived"]).toMatchObject({ sha: SHA })

      // The id-seam answers the recordless id from the retained snapshot.
      expect(app.queue.resolveMember("PR2")).toMatchObject({ source: "snapshot", id: "PR2" })

      // A10: the derived run is audit-clean — no missing-pr, no ancestry
      // finding — because a recordless member above the frozen max is derived
      // BY DESIGN, not store corruption.
      const audit = app.queue.audit()
      expect(audit.findings.filter((finding) => finding.code === "missing-pr")).toEqual([])
      expect(audit.findings.filter((finding) => finding.code === "run-without-submit-ancestry")).toEqual([])
      expect(audit.findings.filter((finding) => finding.code === "run-without-check-ancestry")).toEqual([])
    }

    // A5 (mixed eras, live half): the journal now holds a record-era terminal
    // change AND derived-member traffic (branch/submitted + queue/* snapshots
    // + admission jobs). A fresh projection over the same journal converges on
    // the same state with zero store writes for the derived era.
    await using replayed = await createApp({ journal, id, steps: [passingCheck()], defaultSteps: ["check"] })
    expect(Object.keys(replayed.state().bays.prs)).toEqual(["PR1"])
    const replayedRun = Queues.values(replayed.state().queues).find((run) => run.prs.some((pr) => pr.id === "PR2"))
    expect(replayedRun?.prs[0]).toMatchObject({ id: "PR2", headSha: SHA, revision: 2 })
  })

  it("a re-pushed derived branch reuses its retained snapshot identity through the real pipeline (A9 continuity)", async () => {
    await using app = await createApp({ steps: [passingCheck()], defaultSteps: ["check"] })
    await strandDerivedBranch(app, "issue/derived")
    const mint = volatilePrNumberMint(1)
    await app.queue.run({ derived: [doorEntry(app, "issue/derived", { mint })] }, runtime)

    // The author re-pushes the branch + submit ref at a new sha.
    await app.bays.recordBranchSubmit({ branch: "issue/derived", sha: RESUBMIT_SHA, base: "main" })
    const again = doorEntry(app, "issue/derived", { mint })
    expect(again).toMatchObject({ id: "PR2", revision: 3, headSha: RESUBMIT_SHA })
    // Reused, never re-minted: the high-water did not move again.
    expect(mint.highWater()).toBe(2)
  })

  it("the merge bookkeeping emits pr/integrated from the run's own snapshot for a recordless member — and applying it still throws until the door relaxes the reducer (A1/A8 emitter half)", async () => {
    await using app = await createApp()
    await strandDerivedBranch(app, "issue/derived")
    const entry = doorEntry(app, "issue/derived", { props: { bead: "22991" }, issue: "22991" })

    // The full lifecycle is door-gated: the terminal event for a recordless
    // member is refused by today's reducer, loudly, at apply time.
    await expect(app.queue.run({ derived: [entry] }, runtime)).rejects.toThrow(
      /terminal 'pr\/integrated' names missing change 'PR2'/,
    )

    // The state kept the run with its completed merge job (the failed apply
    // committed nothing) — advance it purely and read the drafted events: the
    // re-sourced emitter, tested at the seam the door will open.
    const record = Queues.values(app.state().queues).find((run) => run.prs.some((pr) => pr.id === "PR2"))
    if (record === undefined) throw new Error("expected the derived merge run to be retained")
    const { events } = advanceQueue(app.state(), record, stepsMapOf(app))
    const integrated = events.find((event) => event.name === "pr/integrated")
    if (integrated === undefined) throw new Error("expected a snapshot-sourced pr/integrated draft")
    expect(integrated.data).toMatchObject({
      pr: "PR2",
      revision: 2,
      headSha: SHA,
      run: record.id,
      commit: MERGED,
      landingSha: MERGED,
      baseSha: BASE,
      changeId: CHANGE_ID,
      // A8's enrichment: the trailer-sourced prop rides the terminal fact —
      // this is the exact payload settlement's hook receives post-door.
      props: { bead: "22991" },
      issueRef: "22991",
    })
    // The snapshot schema carries no submitter — the one accepted enrichment
    // delta (s6-door-preflight leg 1 names it rather than diffing it).
    expect((integrated.data as { submitter?: string }).submitter).toBeUndefined()

    // Grandfather intact in the same emission: no event names the branch's
    // TERMINAL record (different payload), and the store was not written.
    expect(events.filter((event) => event.name === "pr/integrated")).toHaveLength(1)
    expect(Object.keys(app.state().bays.prs)).toEqual(["PR1"])
  })

  it("pr/needs-author re-sources from the snapshot when a derived member's step fails author-owned (census #13)", async () => {
    await using app = await createApp({ steps: [passingCheck(), authorFailingMerge()] })
    await strandDerivedBranch(app, "issue/derived")
    const entry = doorEntry(app, "issue/derived", { props: { bead: "22991" }, issue: "22991" })

    // Same door gate: the needs-author FACT for a recordless member is refused
    // by today's reducer at apply time, loudly.
    await expect(app.queue.run({ derived: [entry] }, runtime)).rejects.toThrow(/missing change 'PR2'/)

    const record = Queues.values(app.state().queues).find((run) => run.prs.some((pr) => pr.id === "PR2"))
    if (record === undefined) throw new Error("expected the derived merge run to be retained")
    const { events } = advanceQueue(app.state(), record, stepsMapOf(app))
    const needsAuthor = events.find((event) => event.name === "pr/needs-author")
    if (needsAuthor === undefined) throw new Error("expected a snapshot-sourced pr/needs-author draft")
    expect(needsAuthor.data).toMatchObject({
      pr: "PR2",
      revision: 2,
      headSha: SHA,
      run: record.id,
      issueRef: "22991",
      props: { bead: "22991" },
      step: "merge",
      receipt: { code: "authored-gitlink" },
    })

    // The pure-git analogue of the submitted/ready gate: once the live submit
    // fact moves off the pinned sha (the author superseded the member), the
    // refusal is not emitted — only the run failure is.
    const moved = {
      ...app.state(),
      bays: {
        ...app.state().bays,
        submits: { "issue/derived": { sha: RESUBMIT_SHA, base: "main", at: "2026-01-01T00:00:00.000Z" } },
      },
    }
    const withoutFact = advanceQueue(moved, record, stepsMapOf(app))
    expect(withoutFact.events.some((event) => event.name === "pr/needs-author")).toBe(false)
    expect(withoutFact.events.some((event) => event.name === "queue/run/failed")).toBe(true)
  })

  it("derived submit authority is one-per-fact: consumed by the merge run, standing again after a re-push (design §2)", async () => {
    await using app = await createApp()
    await strandDerivedBranch(app, "issue/derived")
    // One durable mint across derivations, as production has: the re-derive
    // below reuses PR2 and must see the high-water its mint committed.
    const mint = volatilePrNumberMint(1)
    const entry = doorEntry(app, "issue/derived", { mint })
    await app.queue.run({ derived: [entry] }, runtime).catch(() => undefined)
    const record = Queues.values(app.state().queues).find((run) => run.prs.some((pr) => pr.id === "PR2"))
    if (record === undefined) throw new Error("expected the derived merge run")

    const lookup = derivedAuthorityLookup(app.state())
    const snapshot = record.prs[0]
    if (snapshot === undefined) throw new Error("run lost its member")
    expect(lookup(snapshot)).toEqual({ standing: false, consumedBy: record.id })

    // Re-push = per-push consent: the fact re-projects with a newer clock and
    // the SAME sha still renews authority (git CAS is the actuator).
    const repushed = {
      ...app.state(),
      bays: {
        ...app.state().bays,
        submits: { "issue/derived": { sha: SHA, base: "main", at: "2026-01-02T00:00:00.000Z" } },
      },
    }
    expect(derivedAuthorityLookup(repushed)(snapshot)).toEqual({ standing: true })

    // And the compose acts on consumption: the same member again is skipped
    // (consumed authority — the cure is a re-push), with the durable ledger
    // row and no phantom needs-author on a record that does not exist.
    await expect(app.queue.run({ derived: [doorEntry(app, "issue/derived", { mint })] }, runtime)).resolves.toEqual([])
    expect(app.state().queues.admissionRefusals.PR2).toMatchObject({
      pr: "PR2",
      code: "queue-submit-authority-consumed",
    })
  })

  it("a member with a live record for its branch never enters the derived lane (A4 — never both lanes)", async () => {
    await using app = await createApp()
    await strandDerivedBranch(app, "issue/derived")
    // High mint floor: the app's own mint hands the racing intake PR2, so the
    // driver's number must not collide with it (production shares ONE durable
    // mint, where this collision is impossible by monotonicity).
    const entry = doorEntry(app, "issue/derived", { mint: volatilePrNumberMint(50) })
    // A live record appears for the branch AFTER the driver derived the entry
    // (the race the receiver's conditional dispatch resolves at the door).
    await app.bays.intake({ branch: "issue/derived", headSha: "6".repeat(40), base: "main", baseSha: BASE })
    expect(() => materializeDerivedRunMembers(app.state().bays, [entry])).toThrow(/record lane owns it/)
    // The selectorless compose skips it loudly instead of running both lanes.
    await expect(app.queue.run({ derived: [entry] }, runtime)).resolves.toBeDefined()
    const run = Queues.values(app.state().queues).find((candidate) => candidate.prs.some((pr) => pr.id === entry.id))
    expect(run).toBeUndefined()
  })

  it("the four loud edges: vanished fact, moved fact, duplicate payload, mint failure (R2 re-homed)", async () => {
    await using app = await createApp()
    await strandDerivedBranch(app, "issue/derived")
    const entry = doorEntry(app, "issue/derived")

    // Moved: the CAS refuses an entry derived at a superseded sha.
    await app.bays.recordBranchSubmit({ branch: "issue/derived", sha: RESUBMIT_SHA, base: "main" })
    expect(() => materializeDerivedRunMembers(app.state().bays, [entry])).toThrow(/now stands at/)

    // Vanished: no fact at all refuses with the re-push cure.
    const gone = { ...app.state().bays, submits: {} }
    expect(() => materializeDerivedRunMembers(gone, [entry])).toThrow(/no live submit fact/)
    expect(() => doorEntry(app, "issue/never-submitted")).toThrow(/no live submit fact/)

    // Duplicate payload: another open record already carries this exact
    // base+head — one payload under two identities PROPAGATES (2b's policy).
    await app.bays.submit({ branch: "issue/other", headSha: RESUBMIT_SHA, base: "main", baseSha: BASE })
    const duplicate = doorEntry(app, "issue/derived")
    const collision = (() => {
      try {
        materializeDerivedRunMembers(app.state().bays, [duplicate])
        return undefined
      } catch (error) {
        return error
      }
    })()
    expect(String(collision)).toMatch(/payload already recorded as change/)
    expect(failureFact(collision)).toBeUndefined()
    await expect(app.queue.run({ derived: [duplicate] }, runtime)).rejects.toThrow(/payload already recorded/)

    // Mint failure: commit-before-escape means a broken mint store fails the
    // derivation loudly and mints nothing.
    const broken: PrNumberMint = Object.freeze({
      highWater: () => 0,
      commit: () => {
        throw new Error("yrd: PR-number mint store at '/broken/pr-mint.json' is unwritable: EIO")
      },
    })
    await using fresh = await createApp()
    await strandDerivedBranch(fresh, "issue/fresh")
    expect(() => doorEntry(fresh, "issue/fresh", { mint: broken })).toThrow(/PR-number mint store/)

    // Change-Id trailer missing: refused at derivation, never a dark terminal.
    await using bare = await createApp()
    await strandDerivedBranch(bare, "issue/bare")
    expect(() =>
      deriveRunMemberArgs({
        bays: bare.state().bays,
        queues: bare.state().queues,
        mint: volatilePrNumberMint(1),
        branch: "issue/bare",
      }),
    ).toThrow(/no Change-Id trailer/)
  })

  it("A10 — a derived member is a full member row: id-seam resolution, snapshot-backed run rows, derived-by-design audit accounting", async () => {
    await using app = await createApp({ steps: [passingCheck()], defaultSteps: ["check"] })
    await strandDerivedBranch(app, "issue/derived")
    await app.queue.run({ derived: [doorEntry(app, "issue/derived")] }, runtime)

    const resolved = app.queue.resolveMember("pr#2")
    expect(resolved).toMatchObject({ source: "snapshot", id: "PR2" })
    const record = Queues.values(app.state().queues).find((run) => run.prs.some((pr) => pr.id === "PR2"))
    if (record === undefined) throw new Error("expected the derived run")
    expect(isDerivedRunMember(app.state().bays, record.prs[0] as never)).toBe(true)
    // The terminal record era still answers for ITS id — both eras named.
    expect(app.queue.resolveMember("PR1")).toMatchObject({ source: "record", id: "PR1" })
  })

  // ————— enables-at-door: written for the door PR, skipped until the reducer
  // relaxations land (stage 4). Each body is the honest post-door assertion. —————

  it.skip("enables-at-door: a derived member merges end to end — pr/integrated APPLIES, prs/receipts byte-identical (A1 full)", async () => {
    await using app = await createApp()
    await strandDerivedBranch(app, "issue/derived")
    const prsBefore = structuredClone(app.state().bays.prs)
    const receiptsBefore = structuredClone(app.state().bays.receipts)
    const runs = await app.queue.run(
      { derived: [doorEntry(app, "issue/derived", { props: { bead: "22991" } })] },
      runtime,
    )
    expect(runs).toMatchObject([{ status: "completed", conclusion: "success" }])
    expect(app.state().bays.prs).toEqual(prsBefore)
    expect(app.state().bays.receipts).toEqual(receiptsBefore)
  })

  it.skip("enables-at-door: a live submit is a runnable derived row, not an unrecorded-submit refusal (A10 flip)", async () => {
    // Needs the door's compose wiring (stage 4 replaces the intake sweep with
    // self-derived admission): a branch + submit ref alone, no derived args,
    // is selected and run by one selectorless compose, and the
    // "visible, never runnable" refusal row survives only for MALFORMED facts.
    await using app = await createApp({ steps: [passingCheck()], defaultSteps: ["check"] })
    await app.bays.recordBranchSubmit({ branch: "issue/post-door", sha: SHA, base: "main" })
    const runs = await app.queue.run({}, runtime)
    expect(runs).toMatchObject([{ status: "completed", conclusion: "success" }])
    expect(app.state().bays.prs).toEqual({})
    expect(app.queue.unrecordedSubmits()).toEqual([])
    const audit = app.queue.audit({ now: "2026-01-02T00:00:00.000Z" })
    expect(audit.findings.filter((finding) => finding.code === "unrecorded-submit")).toEqual([])
  })

  it.skip("enables-at-door: replay converges over a journal holding recordless terminal events (A5 full)", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    {
      await using app = await createApp({ journal, id })
      await strandDerivedBranch(app, "issue/derived")
      await app.queue.run({ derived: [doorEntry(app, "issue/derived")] }, runtime)
    }
    await using replayed = await createApp({ journal, id })
    expect(Object.keys(replayed.state().bays.prs)).toEqual(["PR1"])
  })
})
