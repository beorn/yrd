/**
 * @failure A queue run with no Job at its cursor step projects as `running` forever — `advance` no-ops without a Job and `jobs.recover()` has no Job to reclaim — so a finished PR keeps a phantom `● run` row whose clock ticks up indefinitely (live incident R1582: 45h over an already-integrated PR).
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { createBayJobDefs, withBays, type BayWorkspace } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe, type Journal } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import { withStep, withQueue } from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const START = "2026-01-01T00:00:00.000Z"
/** Past the orphan grace (15m) the writer is gone. */
const STALE = "2026-01-01T01:00:00.000Z"
/** Inside the grace: a run that just started is still legitimately jobless for a moment. */
const FRESH = "2026-01-01T00:01:00.000Z"

function ids(initial = 0): () => string {
  let value = initial
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

async function createApp(
  journal: Journal<unknown> = createMemoryJournal(),
  id: () => string = ids(),
  log?: ReturnType<typeof createLogger>,
) {
  const bayJobs = createBayJobDefs(workspace())
  const first = withStep(
    "first",
    (): JobResult<{ first: boolean }> => ({ status: "completed", conclusion: "success", output: { first: true } }),
    {
      revision: "first-v1",
      output: z.object({ first: z.boolean() }).strict(),
    },
  )
  const queue = withQueue({ steps: [first] as const, batch: false, defaultSteps: ["first"] })
  const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
  return createYrd(queue(base), {
    inject: { journal, id, clock: () => START, log: log ?? createLogger("test", [{ level: "silent" }]) },
  })
}

async function submitBranch(app: Awaited<ReturnType<typeof createApp>>, branch: string) {
  const digit = (Object.keys(app.state().bays.prs).length + 1).toString(16)
  await app.bays.submit({ branch, headSha: digit.repeat(40), base: "main", baseSha: BASE })
  const pr = Object.values(app.state().bays.prs).find((item) => item.branch === branch)
  if (pr === undefined) throw new Error("PR was not recorded")
  return pr
}

type Fact = Readonly<{ name: string; data?: unknown }>
type Frame = Readonly<{ events?: readonly Fact[] }>

async function frames(journal: Journal<unknown>): Promise<unknown[]> {
  const collected: unknown[] = []
  for await (const page of journal.read()) collected.push(...page.values)
  return collected
}

/** Drop every Job event from a journal, keeping the Queue's own facts.
 *
 * This is the live shape the incident produced: Job retention (`compactJobsState`)
 * prunes a finished root's Jobs while the Queue RECORD survives, so the record
 * meets a Jobs projection that no longer holds its steps' Jobs. Replaying without
 * Job events reproduces exactly that record-without-Jobs state. */
async function withoutJobEvents(journal: Journal<unknown>): Promise<Journal<unknown>> {
  const kept = (await frames(journal)).map((value) => {
    const frame = value as Frame
    if (frame.events === undefined) return value
    return { ...frame, events: frame.events.filter((event) => !event.name.startsWith("job/")) }
  })
  return createMemoryJournal(kept)
}

/** Reproduce a `pr/pushed` fact as journals wrote it before revision identity
 * existed: no `submitter` and no `changeId`. Those are ONE era, not two — the
 * legacy replay schema is strict, so a fact carrying `changeId` but no
 * `submitter` matches no schema at all and is not a shape any journal holds. */
async function withoutPushedIdentity(journal: Journal<unknown>): Promise<Journal<unknown>> {
  const kept = (await frames(journal)).map((value) => {
    const frame = value as Frame
    if (frame.events === undefined) return value
    return {
      ...frame,
      events: frame.events.map((event) => {
        if (event.name !== "pr/pushed") return event
        const { submitter: _submitter, changeId: _changeId, ...data } = event.data as Record<string, unknown>
        return { ...event, data }
      }),
    }
  })
  return createMemoryJournal(kept)
}

/** A run started but never Job-backed: the record exists, its steps have no Job. */
async function joblessRun(log?: ReturnType<typeof createLogger>) {
  const journal = createMemoryJournal()
  {
    await using seed = await createApp(journal)
    const pr = await submitBranch(seed, "issue/orphaned-run")
    await seed.dispatch(seed.commands.queue.run, { prs: [pr.id], steps: ["first"] })
    expect(seed.queue.get("R1")?.steps[0]?.job, "seed must start with a Job so the surgery is meaningful").toBeDefined()
  }
  return createApp(await withoutJobEvents(journal), ids(100), log)
}

describe("orphaned run recovery — a run with no Job at its cursor step can never settle itself", () => {
  it("projects a jobless run as queued, and neither advance nor job recovery can move it", async () => {
    await using app = await joblessRun()

    const run = app.queue.get("R1")
    expect(run?.steps[0]?.job, "the surgery must leave the run Job-less").toBeUndefined()
    // This is the defect's shape: no Job to reclaim, and advance emits nothing.
    expect(run?.status).toBe("queued")
    expect(await app.jobs.recover({ now: STALE, reason: "lease sweep" })).toEqual([])
    await app.dispatch(app.commands.queue.advance, { run: "R1" })
    expect(app.queue.get("R1")?.status, "advance cannot move a run with no job at its cursor").toBe("queued")
  })

  it("audit flags the jobless run instead of printing clean", async () => {
    await using app = await joblessRun()

    const finding = app.queue.audit().findings.find((item) => item.code === "orphaned-run")
    expect(finding, "audit must flag a run that can never advance").toBeDefined()
    expect(finding?.run).toBe("R1")
    expect(finding?.step).toBe("first")
  })

  it("recover settles a stale jobless run with a truthful reason and a loud result", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await joblessRun(log)

    await app.queue.recover({ recoveryTime: STALE, reason: "habitant restart" })

    const run = app.queue.get("R1")
    expect(run?.status).toBe("completed")
    expect(run?.finishedAt, "a settled run must carry a finish instant").toBeDefined()
    expect(run?.error?.code).toBe("orphaned-run")
    // Truthful and specific: this is NOT lease expiry — there was never a Job.
    expect(run?.error?.message).toContain("runner disappeared before step 'first' started")
    expect(run?.error?.message).toContain(START)
    expect(app.queue.audit().findings.some((item) => item.code === "orphaned-run")).toBe(false)

    const result = events.find(
      (event): event is Extract<LogEvent, { kind: "log" }> =>
        event.kind === "log" && event.level === "warn" && event.props?.action === "recover-orphan-run-settle",
    )
    expect(result, "recover must emit a loud structured result for settled orphan runs").toBeDefined()
    expect(result?.props).toMatchObject({ reason: "orphaned-run", runs: ["R1"], steps: ["first"] })
    log.end()
  })

  it("recover leaves a freshly started jobless run alone", async () => {
    await using app = await joblessRun()

    // The legitimate transient window: a run whose cursor step is between the
    // previous Job finishing and the next advance. Settling here would abort live work.
    await app.queue.recover({ recoveryTime: FRESH, reason: "habitant restart" })

    expect(app.queue.get("R1")?.status, "a run inside the orphan grace is still live").toBe("queued")
    expect(app.queue.get("R1")?.error).toBeUndefined()
  })

  it("settling an orphan twice is a no-op, not a duplicate failure", async () => {
    await using app = await joblessRun()

    await app.queue.recover({ recoveryTime: STALE, reason: "habitant restart" })
    const settled = app.queue.get("R1")
    await app.queue.recover({ recoveryTime: STALE, reason: "habitant restart" })

    expect(app.queue.get("R1")).toEqual(settled)
  })

  it("refuses to settle a run that still has a job at its cursor", async () => {
    await using app = await createApp()
    const pr = await submitBranch(app, "issue/live-run")
    await app.dispatch(app.commands.queue.run, { prs: [pr.id], steps: ["first"] })

    await expect(
      app.dispatch(app.commands.queue.settleOrphanedRun, { run: "R1", reason: "not an orphan" }),
    ).rejects.toThrow(/has a job at step 'first'/u)
  })
})

describe("a finished run stays terminal after its Jobs are pruned", () => {
  it("projects passed from the record's own settlement proof, not from retained Jobs", async () => {
    const journal = createMemoryJournal()
    {
      await using seed = await createApp(journal)
      const pr = await submitBranch(seed, "issue/passes")
      await seed.queue.run({ prs: [pr.id], steps: ["first"] }, { runner: "local", leaseMs: 60_000 })
      expect(seed.queue.get("R1")?.status, "the seed run must reach passed").toBe("completed")
    }

    // Job retention prunes a finished root's Jobs; the Queue record outlives them.
    await using pruned = await createApp(await withoutJobEvents(journal), ids(100))

    const run = pruned.queue.get("R1")
    expect(run?.status, "a settled passed run must not resurrect as a phantom `running`").toBe("completed")
    expect(run?.finishedAt).toBeDefined()
    expect(pruned.queue.audit().findings.some((item) => item.code === "orphaned-run")).toBe(false)
  })
})

/**
 * A pushed-but-never-submitted PR is invisible to the audit
 * (@i/10-merge-queue/drafts-strand-silently, #undead). The siblings above are
 * RUN-shaped gaps; this one never becomes a run at all: `pr/pushed` merges, no
 * `pr/submitted` follows, and the draft sits outside every projection the audit
 * walks — it ages nothing and pages nobody until outage forensics find it.
 * Live specimens 2026-08-13: PR846/849/856/886 stranded 9-22 HOURS, each
 * discovered by a pager CRITICAL rather than by the audit.
 */
describe("draft stranded — a pushed PR that nobody submitted must age loudly, not silently", () => {
  async function pushedDraft(options: Readonly<{ submitter?: string; journal?: Journal<unknown> }> = {}) {
    const app = await createApp(options.journal ?? createMemoryJournal())
    // bays.intake without `submit: true` records pr/pushed ONLY — no
    // pr/submitted follows, so delivery stays "pushed". That IS the specimen
    // shape. (submitBranch would be wrong here: its {branch} submit path
    // emits pr/submitted immediately — this fixture's first draft proved it
    // by flagging nothing.)
    await app.bays.intake({
      branch: "issue/stranded-draft",
      headSha: "3".repeat(40),
      base: "main",
      baseSha: BASE,
      ...(options.submitter === undefined ? {} : { submitter: options.submitter }),
    })
    const pr = Object.values(app.state().bays.prs).find((item) => item.branch === "issue/stranded-draft")
    if (pr === undefined) throw new Error("intake did not record the PR")
    expect(app.state().bays.prs[pr.id]?.revs.at(-1)?.submittedAt, "the fixture must be a true draft").toBeUndefined()
    return { app, pr }
  }

  function strandedFinding(app: Awaited<ReturnType<typeof createApp>>) {
    return app.queue.audit({ now: STALE }).findings.find((item) => item.code === "draft-stranded")
  }

  it("flags a draft past the threshold with its age", async () => {
    const { app, pr } = await pushedDraft()
    try {
      const finding = strandedFinding(app)
      expect(finding, "a draft stranded for an hour must not read as a clean queue").toBeDefined()
      expect(finding?.pr).toBe(pr.id)
      expect(finding?.since).toBe(START)
      expect(finding?.blockedMs, "the operator needs the age, not just the existence").toBe(
        Date.parse(STALE) - Date.parse(START),
      )
    } finally {
      await app[Symbol.asyncDispose]()
    }
  })

  /**
   * The age alone says a draft stranded; it never says WHO it stranded against
   * or HOW FAR it got. Both live on the PR already — the submitter recorded on
   * the revision, and the review verdicts — so a consumer that has the finding
   * must not have to re-open the PR (or guess an owner from the branch name) to
   * route it.
   */
  describe("routing facts — the finding carries who it stranded against and how far it got", () => {
    it("names the submitter RECORDED on the revision", async () => {
      const { app, pr } = await pushedDraft({ submitter: "@dev/11" })
      try {
        expect(
          app.state().bays.prs[pr.id]?.revs.at(-1)?.submitter,
          "the fixture must record the submitter the finding is expected to echo",
        ).toBe("@dev/11")
        expect(strandedFinding(app)?.submitter, "the finding must route to the recorded pusher").toBe("@dev/11")
      } finally {
        await app[Symbol.asyncDispose]()
      }
    })

    it("carries both routing facts in the MESSAGE, the only field every surface prints", async () => {
      // The structured fields above are the honest substrate, but nothing
      // renders them: the CLI's formatActionableFailure prints code/cause/
      // resolution only, and downstream JSON consumers rebuild findings field
      // by field and drop keys they do not know. Carried in the message, both
      // facts survive as the `cause` line — which is what actually reaches an
      // operator. Assert the message, not just the fields, or this finding
      // routes itself in a struct nobody reads.
      const { app, pr } = await pushedDraft({ submitter: "@dev/11" })
      try {
        await app.bays.review({ pr: pr.id, by: "@cto", decision: "approve" })
        const finding = strandedFinding(app)
        expect(finding?.message).toContain("@dev/11")
        expect(finding?.message).toContain("review: approved")
        // The fields stay too — a consumer that DOES read them keeps its
        // machine-readable route, and the two must agree.
        expect(finding?.submitter).toBe("@dev/11")
        expect(finding?.reviewCertification).toBe("approved")
      } finally {
        await app[Symbol.asyncDispose]()
      }
    })

    it("keeps the message honest when the revision records no submitter", async () => {
      // No recorded identity means no name in the message either — a stranded
      // draft with an invented owner routes to the wrong person, which is worse
      // than routing to nobody. The certification is always derivable, so it
      // stays.
      const seeded = createMemoryJournal()
      {
        const { app } = await pushedDraft({ journal: seeded })
        await app[Symbol.asyncDispose]()
      }
      await using app = await createApp(await withoutPushedIdentity(seeded), ids(100))
      const finding = strandedFinding(app)
      expect(finding?.message).toContain("review: unreviewed")
      expect(finding?.message, "no submitter means no ' by …' clause, never an empty one").not.toContain(" by ")
    })

    it("omits the submitter rather than inventing one when the revision records none", async () => {
      // A journal written before submitter identity existed replays through
      // LegacyPRPushedSchema, which has no `submitter` — the same surgery shape
      // as `withoutJobEvents` above. There is no honest fallback here: the
      // default submitter would name "operator" for a push nobody attributed.
      const seeded = createMemoryJournal()
      {
        const { app } = await pushedDraft({ journal: seeded })
        await app[Symbol.asyncDispose]()
      }
      await using app = await createApp(await withoutPushedIdentity(seeded), ids(100))
      const revision = Object.values(app.state().bays.prs)[0]?.revs.at(-1)
      expect(revision?.submitter, "the surgery must leave a genuinely unattributed revision").toBeUndefined()
      const finding = strandedFinding(app)
      expect(finding, "an unattributed draft still strands and must still flag").toBeDefined()
      expect(finding?.submitter, "no recorded identity means no field, never a plausible-looking owner").toBeUndefined()
    })

    it("certifies a draft nobody has looked at as unreviewed", async () => {
      const { app } = await pushedDraft()
      try {
        expect(strandedFinding(app)?.reviewCertification).toBe("unreviewed")
      } finally {
        await app[Symbol.asyncDispose]()
      }
    })

    it("certifies a draft with reviewers requested and no verdict as review-requested", async () => {
      const { app, pr } = await pushedDraft()
      try {
        await app.bays.requestReview({ pr: pr.id, reviewers: ["@cto"] })
        expect(strandedFinding(app)?.reviewCertification).toBe("review-requested")
      } finally {
        await app[Symbol.asyncDispose]()
      }
    })

    it("certifies a draft its reviewer rejected as changes-requested", async () => {
      const { app, pr } = await pushedDraft()
      try {
        await app.bays.requestReview({ pr: pr.id, reviewers: ["@cto"] })
        await app.bays.review({ pr: pr.id, by: "@cto", decision: "reject" })
        // The verdict outranks the standing request: this draft waits on its
        // author, and calling it review-requested would page the wrong person.
        expect(strandedFinding(app)?.reviewCertification).toBe("changes-requested")
      } finally {
        await app[Symbol.asyncDispose]()
      }
    })

    it("certifies an approved-but-unsubmitted draft as approved", async () => {
      const { app, pr } = await pushedDraft()
      try {
        await app.bays.review({ pr: pr.id, by: "@cto", decision: "approve" })
        // The worst specimen in the class: certified work, one command from the
        // queue, aging where nothing looks.
        expect(strandedFinding(app)?.reviewCertification).toBe("approved")
      } finally {
        await app[Symbol.asyncDispose]()
      }
    })

    it("re-opens certification when a new revision leaves the verdict behind", async () => {
      const { app, pr } = await pushedDraft()
      try {
        await app.bays.review({ pr: pr.id, by: "@cto", decision: "approve" })
        expect(strandedFinding(app)?.reviewCertification).toBe("approved")
        // A verdict is revision-bound. Pushing again strands NEW content, and a
        // certification that carried the old approval forward would lie about
        // what is uncertified.
        await app.bays.intake({ branch: "issue/stranded-draft", headSha: "4".repeat(40), base: "main", baseSha: BASE })
        expect(strandedFinding(app)?.reviewCertification).toBe("unreviewed")
      } finally {
        await app[Symbol.asyncDispose]()
      }
    })
  })

  it("stays silent inside the grace window", async () => {
    const { app } = await pushedDraft()
    try {
      // FRESH is 60s after the push against a 15m grace — genuinely inside the
      // window (checked below so this control cannot silently invert).
      expect(Date.parse(FRESH) - Date.parse(START)).toBeLessThan(15 * 60 * 1000)
      expect(app.queue.audit({ now: FRESH }).findings.some((item) => item.code === "draft-stranded")).toBe(false)
    } finally {
      await app[Symbol.asyncDispose]()
    }
  })

  it("never flags a submitted PR, however old", async () => {
    const { app, pr } = await pushedDraft()
    try {
      // Submit-by-id turns the pushed draft into a submitted revision — the
      // queue's world owns it from here; only true drafts may flag.
      await app.bays.submit({ pr: pr.id })
      expect(app.queue.audit({ now: STALE }).findings.some((item) => item.code === "draft-stranded")).toBe(false)
    } finally {
      await app[Symbol.asyncDispose]()
    }
  })
})

/**
 * The read side of the lease seam (@yrd/core/21085-target-model/21094, #undead).
 * The sibling defect above is a run with NO Job. This one has a Job, still
 * `in_progress`, whose executor is gone — so it projects as healthily running
 * for as long as nobody sweeps it. Live R1740: the lease expired 20:35:03.925Z
 * and the `lose` transition was not written until 20:45:27.620Z; for 10m24s
 * `queue status` showed a live run and `queue audit` reported nothing at all.
 */
describe("lapsed executor lease — a Job-backed run projects as running with nothing renewing it", () => {
  const LEASE_EXPIRES = "2026-01-01T00:00:30.000Z"

  async function leasedRun() {
    const app = await createApp()
    const pr = await submitBranch(app, "issue/lease-lapsed")
    await app.dispatch(app.commands.queue.run, { prs: [pr.id], steps: ["first"] })
    const job = app.queue.get("R1")?.steps[0]?.job
    if (job === undefined) throw new Error("the run must be Job-backed for a lease to exist at all")
    await app.dispatch(app.commands.job.transition, {
      type: "start",
      id: job.id,
      attempt: 1,
      runner: "yrd-cli:404",
      leaseExpiresAt: LEASE_EXPIRES,
    })
    expect(app.queue.get("R1")?.steps[0]?.job?.status, "the run must read as running for the gap to exist").toBe(
      "in_progress",
    )
    return app
  }

  it("flags the lapse and how long it has stood", async () => {
    await using app = await leasedRun()

    const finding = app.queue.audit({ now: STALE }).findings.find((item) => item.code === "run-lease-expired")
    expect(finding, "a lapsed lease must not read as a healthy run").toBeDefined()
    expect(finding?.run).toBe("R1")
    expect(finding?.step).toBe("first")
    expect(finding?.since).toBe(LEASE_EXPIRES)
    expect(finding?.blockedMs, "the operator needs the age of the gap, not just its existence").toBe(
      Date.parse(STALE) - Date.parse(LEASE_EXPIRES),
    )
  })

  it("stays silent while the lease is still live", async () => {
    await using app = await leasedRun()

    // The control that keeps the check honest. It must sit INSIDE the lease
    // window — note FRESH does not, it is 00:01:00 against a 00:00:30 expiry, so
    // using it here asserted the opposite of what it read. Without a control the
    // check above could pass while flagging every healthy run too.
    const live = "2026-01-01T00:00:10.000Z"
    expect(Date.parse(live)).toBeLessThan(Date.parse(LEASE_EXPIRES))
    expect(app.queue.audit({ now: live }).findings.some((item) => item.code === "run-lease-expired")).toBe(false)
  })
})
