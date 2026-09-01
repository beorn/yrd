/**
 * @failure The S6 door retires record creation, so a branch's answer must
 * arbitrate between the frozen/live record store and the live submit fact —
 * and the legacy "a record in ANY state wins" filter is wrong in exactly one
 * cell: a terminal record would permanently shadow a post-door re-submission
 * of its branch ("withdrawn, nothing to run" forever — the stranded-draft
 * class 22991 exists to kill, returning through the front door). This file is
 * A4 of the S6 door design (@i/10-merge-queue/s6-door-design §3 leg 3): the
 * full 9-cell record×submit matrix as a table test, the two decisive cells
 * asserted by name, and the id-seam (store-first by id, admission-time mint
 * with commit-before-escape) proven while only tests call it.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import {
  changeHead,
  createBayJobDefs,
  volatilePrNumberMint,
  withBays,
  type BaysState,
  type BayWorkspace,
  type Change,
} from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import {
  classifyDerivedChangeCell,
  latestChangeSnapshot,
  maxChangeSnapshotRevision,
  mintDerivedMemberIdentity,
  newestTruthRecord,
  Queues,
  resolveMemberById,
  resolveQueueChange,
  withQueue,
  withStep,
  type ChangeSnapshot,
  type DerivedChangeCell,
  type DerivedChangeLane,
  type QueueRecord,
  type QueuesState,
  type StepExecution,
} from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const OTHER_SHA = "d".repeat(40)
const AT = "2026-01-01T00:00:00.000Z"
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
      output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD, baseSha: BASE },
    }),
    refresh: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: HEAD, baseSha: BASE, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed",
      conclusion: "success",
      output: { headSha: HEAD, pushed: true, wip: false },
    }),
    deprovision: () => ({ status: "completed", conclusion: "success", output: {} }),
  }
}

async function createQueueApp() {
  const checkStep = withStep(
    "check",
    (_input: StepExecution): JobResult<CheckResult> => ({
      status: "completed",
      conclusion: "success",
      output: { checked: true },
    }),
    { revision: "check-v1", output: CheckResultSchema },
  )
  const queue = withQueue({ steps: [checkStep] as const, batch: false, defaultSteps: ["check"] })
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
      clock: () => AT,
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
}

type QueueApp = Awaited<ReturnType<typeof createQueueApp>>

function nextHead(app: QueueApp): string {
  // Each PR needs its own head: an identical payload is refused as a duplicate.
  return (Object.keys(app.state().bays.prs).length + 1).toString(16).repeat(40)
}

function recorded(app: QueueApp, branch: string): Change {
  const pr = Object.values(app.state().bays.prs).findLast((item) => item.branch === branch)
  if (pr === undefined) throw new Error(`PR for '${branch}' was not recorded`)
  return pr
}

async function submitRecord(app: QueueApp, branch: string): Promise<Change> {
  await app.bays.submit({ branch, headSha: nextHead(app), base: "main", baseSha: BASE })
  return recorded(app, branch)
}

/** Build one cell of the record×submit matrix for `branch` and return the
 * record head (when a record exists) so same-sha facts can name it. */
async function buildCell(
  app: QueueApp,
  branch: string,
  cell: Readonly<{ record: "none" | "live" | "terminal"; submit: "none" | "same-sha" | "different-sha" }>,
): Promise<void> {
  let head: string | undefined
  if (cell.record !== "none") {
    const pr = await submitRecord(app, branch)
    head = changeHead(pr)
    if (cell.record === "terminal") await app.bays.closePr({ pr: pr.id, reason: "superseded" })
  }
  if (cell.submit === "same-sha") {
    if (head === undefined) throw new Error("same-sha needs a record head — the cell is zero by construction")
    await app.bays.recordBranchSubmit({ branch, sha: head, base: "main" })
  }
  if (cell.submit === "different-sha") {
    await app.bays.recordBranchSubmit({ branch, sha: OTHER_SHA, base: "main" })
  }
}

describe("A4 — the 9-cell record×submit matrix, one lane per cell", () => {
  // Every constructible cell with its ruled lane (s6-door-design §2/§3). The
  // ninth cell — none×same-sha — is zero by construction (no record head to
  // equal) and gets its own assertion below instead of a fixture.
  const CELLS = [
    { record: "none", submit: "none", lane: "none" },
    { record: "none", submit: "different-sha", lane: "derived" },
    { record: "live", submit: "none", lane: "record" },
    { record: "live", submit: "same-sha", lane: "record" },
    { record: "live", submit: "different-sha", lane: "record" },
    { record: "terminal", submit: "none", lane: "record" },
    { record: "terminal", submit: "same-sha", lane: "record" },
    { record: "terminal", submit: "different-sha", lane: "derived" },
  ] as const satisfies ReadonlyArray<DerivedChangeCell & { lane: DerivedChangeLane }>

  it.each(CELLS.map((cell) => ({ ...cell, name: `${cell.record}×${cell.submit}` })))(
    "$name ⇒ lane '$lane'",
    async ({ record, submit, lane }) => {
      await using app = await createQueueApp()
      const branch = "issue/cell"
      await buildCell(app, branch, { record, submit })
      const derived = app.queue.deriveChange(branch)
      expect(derived.authority.cell).toEqual({ record, submit })
      expect(derived.authority.lane).toBe(lane)
      // One lane per branch, never both: the verdict is a single enum, and a
      // derived verdict always stands on a live submit fact.
      if (derived.authority.lane === "derived") expect(derived.submit).toBeDefined()
      if (record === "none") expect(derived.authority.record).toBeUndefined()
      else expect(derived.authority.record?.branch).toBe(branch)
    },
  )

  it("none×same-sha is zero by construction: a submit with no record classifies as different-sha", () => {
    const cell = classifyDerivedChangeCell(undefined, { sha: OTHER_SHA, base: "main", at: AT })
    expect(cell).toEqual({ record: "none", submit: "different-sha" })
  })

  it("DECISIVE terminal×different-sha: the derived member is the live truth and the branch is NOT shadowed", async () => {
    await using app = await createQueueApp()
    const branch = "issue/resubmitted"
    await buildCell(app, branch, { record: "terminal", submit: "different-sha" })
    const derived = app.queue.deriveChange(branch)
    expect(derived.authority).toMatchObject({
      lane: "derived",
      cell: { record: "terminal", submit: "different-sha" },
    })
    expect(derived.submit).toMatchObject({ sha: OTHER_SHA, base: "main" })
    // Stage-2 boundary, stated: while record writes still flow the LEGACY
    // fields keep their pre-S6 answers — the terminal record still answers
    // `record`/`eligibility` and still hides the unrecorded row. Only the
    // verdict flips; the door flips the consumers.
    expect(derived.record).toBeDefined()
    expect(derived.eligibility?.reason?.code).toBe("terminal")
    expect(derived.unrecorded).toBeUndefined()
  })

  it("DECISIVE live×different-sha: the record lane owns the push — never both lanes", async () => {
    await using app = await createQueueApp()
    const branch = "issue/pending-revision"
    await buildCell(app, branch, { record: "live", submit: "different-sha" })
    const derived = app.queue.deriveChange(branch)
    expect(derived.authority.lane).toBe("record")
    expect(derived.authority.cell).toEqual({ record: "live", submit: "different-sha" })
    // The differing sha is the record's PENDING revision (the receiver's
    // conditional dispatch intakes it at write time), not a second member.
    expect(mintDerivedMemberIdentityRefusal(app, branch)).toMatch(/live change/)
  })

  it("a multi-record branch arbitrates newest-truth while the legacy field keeps first-match", async () => {
    await using app = await createQueueApp()
    const branch = "issue/reborn"
    const first = await submitRecord(app, branch)
    await app.bays.closePr({ pr: first.id, reason: "superseded" })
    // Intake mints a FRESH id for a terminal branch — the multi-record case.
    await app.bays.intake({ branch, headSha: nextHead(app), base: "main", baseSha: BASE })
    const second = recorded(app, branch)
    expect(second.id).not.toBe(first.id)

    const derived = app.queue.deriveChange(branch)
    expect(derived.record?.id).toBe(first.id)
    expect(derived.authority.record?.id).toBe(second.id)
    expect(derived.authority.lane).toBe("record")
    expect(newestTruthRecord(Object.values(app.state().bays.prs).filter((pr) => pr.branch === branch))?.id).toBe(
      second.id,
    )
  })
})

function mintDerivedMemberIdentityRefusal(app: QueueApp, branch: string): string {
  try {
    mintDerivedMemberIdentity({
      mint: volatilePrNumberMint(100),
      bays: app.state().bays,
      queues: app.state().queues,
      branch,
    })
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error("expected mintDerivedMemberIdentity to refuse a live-record branch")
}

// ————— id-seam: pure-state fixtures (no production path creates recordless
// snapshots yet — the door does; until then ONLY these tests call the seam). —————

function changeRecord(
  overrides: Readonly<{ id: string; branch: string; state?: "open" | "closed"; merged?: boolean; revisions?: number }>,
): Change {
  const revisions = overrides.revisions ?? 1
  return {
    id: overrides.id,
    name: `Change ${overrides.id}`,
    branch: overrides.branch,
    base: "main",
    state: overrides.state ?? "open",
    merged: overrides.merged ?? false,
    revs: Array.from({ length: revisions }, (_ignored, index) => ({
      n: index + 1,
      head: (index + 2).toString(16).repeat(40),
      base: "main",
      baseSha: BASE,
      pushedAt: AT,
      submittedAt: AT,
      submitter: "author@example.test",
    })),
    reviews: [],
    comments: [],
    checkRequests: [],
  }
}

function baysWith(...prs: readonly Change[]): BaysState {
  return { byId: {}, prs: Object.fromEntries(prs.map((pr) => [pr.id, pr])), receipts: {}, submits: {} }
}

function snapshot(
  overrides: Readonly<{ id: string; branch: string; revision: number; changeId?: string; headSha?: string }>,
): ChangeSnapshot {
  return {
    id: overrides.id,
    ...(overrides.changeId === undefined ? {} : { changeId: overrides.changeId }),
    branch: overrides.branch,
    base: "main",
    revision: overrides.revision,
    headSha: overrides.headSha ?? "b".repeat(40),
  }
}

function runRecord(id: string, prs: readonly ChangeSnapshot[]): QueueRecord {
  return { id, queueId: "main", candidateId: "C1", prs, base: "main", steps: [], startedAt: AT }
}

function queuesWith(...records: readonly QueueRecord[]): QueuesState {
  const empty = Queues.empty({ batchSize: 1 })
  return { ...empty, records: records.reduce((lookup, record) => Queues.set(lookup, record), empty.records) }
}

describe("id-seam — canonical ids before aliases", () => {
  const terminal = changeRecord({ id: "PR7", branch: "issue/old", state: "closed", merged: true, revisions: 3 })

  it("a record answers its id even when snapshots also name it; recordless ids answer from the newest snapshot", () => {
    const bays = baysWith(terminal)
    const queues = queuesWith(
      runRecord("R2", [
        snapshot({ id: "PR7", branch: "issue/old", revision: 3 }),
        snapshot({ id: "PR9", branch: "issue/new", revision: 1, changeId: "I0123abcd" }),
      ]),
      runRecord("R10", [snapshot({ id: "PR9", branch: "issue/new", revision: 2, changeId: "I0123abcd" })]),
    )
    expect(resolveMemberById(bays, queues, "PR7")).toMatchObject({ source: "record", id: "PR7" })
    expect(resolveMemberById(bays, queues, "PR7.1")).toMatchObject({
      source: "record",
      id: "PR7",
      record: { revs: [{ n: 1 }] },
    })
    expect(resolveQueueChange(bays, queues, "PR7.1")).toMatchObject({ id: "PR7", revs: [{ n: 1 }] })
    expect(resolveMemberById(bays, queues, "pr#9")).toMatchObject({
      source: "snapshot",
      id: "PR9",
      snapshot: { revision: 2, changeId: "I0123abcd" },
    })
    expect(resolveMemberById(bays, queues, "9")).toMatchObject({ source: "snapshot", id: "PR9" })
    expect(resolveMemberById(bays, queues, "PR9.1")).toMatchObject({
      source: "snapshot",
      id: "PR9",
      snapshot: { revision: 1 },
    })
    expect(resolveQueueChange(bays, queues, "PR9.1")).toMatchObject({ id: "PR9", revs: [{ n: 1 }] })
    expect(resolveMemberById(bays, queues, "PR8")).toBeUndefined()
  })

  it("the newest snapshot wins by natural run order (R10 after R2), and intent members never match", () => {
    const queues = queuesWith(
      runRecord("R2", [snapshot({ id: "PR9", branch: "issue/new", revision: 1 })]),
      runRecord("R10", [snapshot({ id: "PR9", branch: "issue/new", revision: 4 })]),
    )
    expect(latestChangeSnapshot(queues, (candidate) => candidate.id === "PR9")?.revision).toBe(4)
    expect(maxChangeSnapshotRevision(queues, "PR9")).toBe(4)
    expect(maxChangeSnapshotRevision(queues, "PR404")).toBe(0)
  })

  it("an exact derived id wins over a record alias spelling the same selector", () => {
    const alias = changeRecord({ id: "PR1", branch: "PR9", state: "closed" })
    const branch = "issue/derived"
    const bays = {
      ...baysWith(alias),
      submits: { [branch]: { sha: HEAD, base: "main", at: AT } },
    }
    const bound = {
      ...queuesWith(),
      derivedIdentities: {
        [branch]: { [HEAD]: { branch, sha: HEAD, id: "PR9", revision: 1 } },
      },
    }

    // Binding commits the canonical namespace before a Queue run can retain a
    // materializable snapshot. The old record alias may not steal that id in
    // this interval; there simply is not a Change to return yet.
    expect(resolveMemberById(bays, bound, "PR9")).toBeUndefined()
    expect(resolveQueueChange(bays, bound, "PR9")).toBeUndefined()

    const queues = {
      ...bound,
      records: queuesWith(runRecord("R1", [snapshot({ id: "PR9", branch, revision: 1, headSha: HEAD })])).records,
    }

    expect(resolveMemberById(bays, queues, "PR9")).toMatchObject({ source: "snapshot", id: "PR9" })
    expect(resolveQueueChange(bays, queues, "PR9")).toMatchObject({ id: "PR9", branch })
    expect(resolveMemberById(bays, queues, "PR1")).toMatchObject({ source: "record", id: "PR1" })
    expect(resolveQueueChange(bays, queues, "PR1")).toMatchObject({ id: "PR1", branch: "PR9" })
  })
})

describe("id-seam — admission-time mint (commit-before-escape)", () => {
  it("a fresh member mints strictly above BOTH the frozen store's max and the high-water, committing first", () => {
    const mint = volatilePrNumberMint(3)
    const bays = baysWith(changeRecord({ id: "PR7", branch: "issue/old", state: "closed", revisions: 3 }))
    const identity = mintDerivedMemberIdentity({ mint, bays, queues: queuesWith(), branch: "issue/fresh" })
    expect(identity).toEqual({ id: "PR8", revision: 1, minted: true })
    // The high-water moved BEFORE the id escaped: A9's crash window skips a
    // number, never re-issues one.
    expect(mint.highWater()).toBe(8)
  })

  it("a post-door revision of a pre-door branch continues the record's revision count", () => {
    const mint = volatilePrNumberMint(7)
    const bays = baysWith(changeRecord({ id: "PR7", branch: "issue/old", state: "closed", revisions: 3 }))
    const identity = mintDerivedMemberIdentity({ mint, bays, queues: queuesWith(), branch: "issue/old" })
    expect(identity).toEqual({ id: "PR8", revision: 4, minted: true })
  })

  it("a re-pushed derived branch reuses its snapshot identity — id, changeId, next revision — without minting", () => {
    const mint = volatilePrNumberMint(9)
    const bays = baysWith(changeRecord({ id: "PR7", branch: "issue/derived", state: "closed", revisions: 2 }))
    const queues = queuesWith(
      runRecord("R1", [snapshot({ id: "PR9", branch: "issue/derived", revision: 3, changeId: "I0123abcd" })]),
      runRecord("R2", [snapshot({ id: "PR9", branch: "issue/derived", revision: 4, changeId: "I0123abcd" })]),
    )
    const identity = mintDerivedMemberIdentity({ mint, bays, queues, branch: "issue/derived" })
    expect(identity).toEqual({ id: "PR9", changeId: "I0123abcd", revision: 5, minted: false })
    expect(mint.highWater()).toBe(9)
  })

  it("a snapshot whose id has a record is NOT reusable — it names the record era, and the mint skips past it", () => {
    const mint = volatilePrNumberMint(7)
    const record = changeRecord({ id: "PR7", branch: "issue/old", state: "closed", revisions: 3 })
    const queues = queuesWith(runRecord("R1", [snapshot({ id: "PR7", branch: "issue/old", revision: 3 })]))
    const identity = mintDerivedMemberIdentity({ mint, bays: baysWith(record), queues, branch: "issue/old" })
    expect(identity).toEqual({ id: "PR8", revision: 4, minted: true })
  })

  it("does not reuse a migrated snapshot id that an exact binding already attributes to another branch", () => {
    const mint = volatilePrNumberMint(9)
    const first = "issue/legacy-alias-one"
    const second = "issue/legacy-alias-two"
    const queues = {
      ...queuesWith(
        runRecord("R1", [
          snapshot({ id: "PR7", branch: first, revision: 1, headSha: HEAD }),
          snapshot({ id: "PR7", branch: second, revision: 1, headSha: HEAD }),
        ]),
      ),
      derivedIdentities: {
        [first]: { [HEAD]: { branch: first, sha: HEAD, id: "PR7", revision: 1 } },
      },
    }
    const bays = {
      ...baysWith(),
      submits: { [second]: { sha: HEAD, base: "main", at: AT } },
    }

    expect(mintDerivedMemberIdentity({ mint, bays, queues, branch: second })).toEqual({
      id: "PR10",
      revision: 1,
      minted: true,
    })
  })

  it("a live record refuses the derived lane loudly", () => {
    const bays = baysWith(changeRecord({ id: "PR5", branch: "issue/live" }))
    expect(() =>
      mintDerivedMemberIdentity({ mint: volatilePrNumberMint(5), bays, queues: queuesWith(), branch: "issue/live" }),
    ).toThrow(/live change 'PR5'/)
  })

  it("a reused id above the high-water is an escaped id and refuses loudly", () => {
    const queues = queuesWith(runRecord("R1", [snapshot({ id: "PR9", branch: "issue/derived", revision: 1 })]))
    expect(() =>
      mintDerivedMemberIdentity({ mint: volatilePrNumberMint(3), bays: baysWith(), queues, branch: "issue/derived" }),
    ).toThrow(/exceeds the mint high-water/)
  })
})

/**
 * Regression — the phantom-remint livelock (2026-09-01, yrd runner
 * c576de2a): `deriveRefOnlyMembers` derives+mints an identity and dispatches
 * its required-check Jobs BEFORE any Queue run exists (queue.ts's `S6 door`
 * doc). Before the exact identity binding existed, no branch-proven durable
 * trace survived until `queue/run/started`: the SHA-only Candidate could not
 * prove which branch owned its id. A branch whose checks took longer than one
 * compose pass to settle was therefore re-derived from scratch every pass: a
 * fresh number minted, a
 * fresh Job dispatched under that number's `admissionJobKey`, the PRIOR
 * pass's Job (and number) abandoned — forever, because progress never had
 * anywhere durable to survive between passes. Measured live: PR2919 minted
 * 07:59:30, still checks-pending at 08:00:26, then PR2920 minted fresh at
 * 08:01:10 for the exact same (branch, sha) — repeating every ~55s, eleven
 * branches wedged simultaneously.
 */
describe("id-seam — pending admission identity (no run has started yet)", () => {
  const SHA = "9".repeat(40)

  /** Candidate compatibility cases require the branch's live submit fact. */
  function baysWithSubmit(branch: string, sha: string, ...prs: readonly Change[]): BaysState {
    return {
      ...baysWith(...prs),
      submits: { [branch]: { sha, base: "main", at: AT } },
    }
  }

  function queuesWithCandidate(...revs: readonly { pr: string; n: number; head: string }[]): QueuesState {
    const empty = Queues.empty({ batchSize: 1 })
    return {
      ...empty,
      candidates: Object.fromEntries(
        revs.map((rev, index) => [
          `C${String(index + 1)}`,
          {
            id: `C${String(index + 1)}`,
            queueId: "main",
            baseSha: BASE,
            revs: [rev],
            mergeability: "unknown",
            createdAt: AT,
          },
        ]),
      ),
    }
  }

  it("never reuses a legacy SHA-only Candidate, even when it is the sole exact-sha match", () => {
    const mint = volatilePrNumberMint(9)
    const branch = "issue/slow-checks"
    const queues = queuesWithCandidate({ pr: "PR7", n: 1, head: SHA })
    const identity = mintDerivedMemberIdentity({ mint, bays: baysWithSubmit(branch, SHA), queues, branch })
    expect(identity).toEqual({ id: "PR10", revision: 1, minted: true })
    expect(mint.highWater()).toBe(10)
  })

  it("a branch-proven run snapshot still wins over a legacy Candidate", () => {
    const mint = volatilePrNumberMint(9)
    const branch = "issue/started"
    const queues = {
      ...queuesWithCandidate({ pr: "PR7", n: 1, head: SHA }),
      records: queuesWith(runRecord("R1", [snapshot({ id: "PR7", branch, revision: 1 })])).records,
    }
    const identity = mintDerivedMemberIdentity({ mint, bays: baysWithSubmit(branch, SHA), queues, branch })
    // Revision bumps to 2, proving the branch-proven snapshot — not the
    // SHA-only Candidate — supplied the identity.
    expect(identity).toEqual({ id: "PR7", revision: 2, minted: false })
  })
})
