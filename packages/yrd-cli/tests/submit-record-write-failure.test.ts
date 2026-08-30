/**
 * @failure A submit whose durable write does not complete prints result fields anyway, or leaves the half-written revision invisible: the record says `pushed`, `queue audit` reports `findings: []`, and nothing anywhere says a submit ran and lost its write.
 * @level l2
 * @consumer @yrd/cli pr submit · @yrd/queue queue audit
 *
 * Specimens: PR2006 (2026-08-24) exited 0 printing a run number, a commit and
 * an integration sha for a submission whose record shows `submittedAt: None`;
 * PR1643 (2026-08-21) printed `submitted` and nothing ever told the author the
 * queue had refused it.
 *
 * The exit-and-print half is already closed at this revision and these tests LOCK
 * it: `@yrd/core`'s commit loop projects a candidate, appends, and publishes
 * only on a successful append (`app.ts:1235-1238`), so a failed durable write
 * unwinds before `applyChangeSelectionVerb` can print. The half that was open
 * is the wreckage it leaves — a revision pushed with no submit fact, which
 * `changeDeliveryState` labels `pushed` and the audit's draft walk therefore
 * held behind DRAFT_STRANDED_GRACE_MS as a draft nobody had submitted yet.
 *
 * The failure is injected at the journal, not at a print site, because that is
 * the one seam every submit path's durable write passes through: the record
 * lane's `pr/submitted`, the derived lane's `branch/submitted`, and the
 * check request that follows a submit all fail the same way here.
 */
import { describe, expect, it } from "vitest"
import { createBayJobDefs, withBays, volatilePrNumberMint } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type Journal, type JsonValue } from "@yrd/core"
import { withContests, type CommitResolver } from "@yrd/contest"
import { withIssues } from "@yrd/issue"
import { withJobs, type JobResult } from "@yrd/job"
import { withMerge, withQueue, withStep, type ChangeShape, type StepExecution } from "@yrd/queue"
import { runYrd, type YrdCliIO, type YrdCliServices } from "@yrd/cli"
import type { ProcessRequest } from "@yrd/process"
import { createLogger } from "loggily"
import { testQueueReadModel } from "./queue-read-model-test-helper.ts"

const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "1".repeat(40)
const NEXT_SHA = "2".repeat(40)
const MERGED_SHA = "b".repeat(40)
/** The submit runs at 12:00; every command reads 12:10 unless it says otherwise
 * — inside the 15-minute draft grace, so a finding here is this bug's, not the
 * stranded-draft walk's. */
const SUBMIT_AT = "2026-08-25T12:00:00.000Z"
const NOW = "2026-08-25T12:10:00.000Z"

function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace() {
  return {
    revision: "submit-record-write-failure-workspace-v1",
    provision: (input: { bay: string }) => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD_SHA, baseSha: BASE_SHA },
    }),
    refresh: (input: { bay: string; path?: string }) => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: HEAD_SHA, baseSha: BASE_SHA, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { headSha: HEAD_SHA, pushed: true as const, wip: false },
    }),
    deprovision: () => ({ status: "completed" as const, conclusion: "success" as const, output: {} }),
  }
}

type JournalFrame = Readonly<{ events?: readonly Readonly<{ name: string }>[] }>

/**
 * A journal that fails the append carrying `failOn`, once armed.
 *
 * Armed explicitly rather than from construction so a fixture can lay down its
 * starting record through the same journal: an always-armed wrapper fails the
 * SETUP write and the test then measures a repository that was never built.
 */
function failingJournal(failOn: string): Journal<unknown> & { arm(): void } {
  const inner = createMemoryJournal<unknown>()
  let armed = false
  const journal = {
    read: inner.read.bind(inner),
    arm() {
      armed = true
    },
    append(value: unknown, cursor: number) {
      const names = ((value as JournalFrame).events ?? []).map((event) => event.name)
      if (armed && names.includes(failOn)) {
        return Promise.reject(new Error("yrd-test: durable write failed (simulated)"))
      }
      return inner.append(value, cursor)
    },
  }
  return journal as unknown as Journal<unknown> & { arm(): void }
}

async function createCliApp(journal: Journal<unknown> = createMemoryJournal()) {
  const bayJobs = createBayJobDefs(workspace())
  const check = withStep(
    "check",
    (): JobResult<JsonValue> => ({ status: "completed", conclusion: "success", output: { checked: true } }),
    { revision: "check-v1", output: JsonSchema, classification: "carrier" },
  )
  const merge = withMerge(
    async (_input: StepExecution<ChangeShape>): Promise<JobResult<{ commit: string; baseSha: string }>> => ({
      status: "completed",
      conclusion: "success",
      output: { commit: MERGED_SHA, baseSha: MERGED_SHA },
    }),
    { revision: "merge-v1" },
  )
  const queue = withQueue({ steps: [check, merge] as const, batch: false })
  const git: CommitResolver = { revision: "git-v1", resolveCommit: () => BASE_SHA }
  const contests = withContests({ runners: [], evaluators: [], git })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs, contests.jobDefs] }),
    withIssues({ sources: [{ id: "km", resolve: (ref) => ({ ref, title: "Issue one" }) }] }),
    withBays({
      prNumberMint: volatilePrNumberMint(),
      jobs: bayJobs,
      defaultBase: "main",
      resolveBase: (ref) => ({ base: ref, baseSha: BASE_SHA }),
    }),
  )
  return createYrd(contests(queue(base)), {
    inject: {
      journal,
      clock: () => SUBMIT_AT,
      id: ids(0),
      log: createLogger("yrd", [{ level: "silent" }]),
    },
  })
}

type CliApp = Awaited<ReturnType<typeof createCliApp>>

function outputIO(overrides: Partial<YrdCliIO> = {}) {
  let stdout = ""
  let stderr = ""
  const io: YrdCliIO = {
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
    cwd: "/repo",
    columns: 120,
    runner: "submit-record-write-failure-test",
    leaseMs: 60_000,
    now: () => Date.parse(NOW),
    parents: async () => ["0".repeat(40)],
    resolveRevision: async () => NEXT_SHA,
    ...overrides,
  }
  return { io, stdout: () => stdout, stderr: () => stderr }
}

function yrd(...args: string[]): string[] {
  return ["/usr/bin/bun", "/repo/bin/yrd.ts", ...args]
}

function services(app: CliApp): YrdCliServices {
  return {
    queueReadModel: testQueueReadModel(app),
    checks: {
      names: [],
      run: async () => ({ stdout: "", stderr: "", exitCode: 0, signal: null, durationMs: 0, timedOut: false }),
      install: async () => "/repo/.git/yrd/hooks/pre-submit",
    },
    process: {
      run: async (request: ProcessRequest) => {
        const target = request.argv.find((arg) => arg.startsWith("refs/remotes/origin/") && arg.endsWith("^{commit}"))
        const branch = target?.slice("refs/remotes/origin/".length, -"^{commit}".length)
        const observed = branch === undefined ? undefined : app.bays.pr(branch)
        return {
          stdout: request.argv.includes("merge-base")
            ? `${"0".repeat(39)}1\n`
            : observed === undefined
              ? ""
              : `${observed.revs[observed.revs.length - 1]?.head ?? ""}\n`,
          stderr: "",
          exitCode: 0,
          signal: null,
          durationMs: 0,
          timedOut: false,
        }
      },
      reapPath: async () => ({
        targetedPids: [],
        survivorPids: [],
        survivorHolders: [],
        survivorCoverage: { platform: "darwin" as const, mechanism: "lsof" as const, complete: true as const },
        forcedKill: false,
        signalFailures: [],
      }),
    },
  }
}

/** A change already submitted once, whose SECOND submit loses its durable write
 * — the shape a re-submit of moved work takes when the record store fails. */
async function interruptedResubmit(json: boolean) {
  const journal = failingJournal("pr/submitted")
  const app = await createCliApp(journal)
  await app.bays.submit({ branch: "topic/one", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
  journal.arm()
  const output = outputIO()
  const exit = await runYrd(
    app,
    yrd("pr", "submit", "topic/one", ...(json ? ["--json"] : [])),
    output.io,
    services(app),
  )
  return {
    app,
    exit,
    output,
    async [Symbol.asyncDispose]() {
      await app[Symbol.asyncDispose]()
    },
  }
}

/** Every field a caller could mistake for proof the submission exists. */
function resultFieldsIn(text: string): string[] {
  return [NEXT_SHA, MERGED_SHA, "R1", '"run"', "integration"].filter((field) => text.includes(field))
}

describe("a submit whose durable write fails", () => {
  it("exits non-zero and prints no run id, commit or integration sha on ANY surface", async () => {
    await using fixture = await interruptedResubmit(false)

    expect(fixture.exit, fixture.output.stderr()).not.toBe(0)
    // Assert ABSENCE, not just non-zero: PR2006 exited 0 AND printed a run
    // number, a commit and an integration sha for a submission that never
    // happened, so "non-zero" alone would have passed on the bug that
    // mattered less than the fabricated fields.
    expect(resultFieldsIn(fixture.output.stdout())).toEqual([])
    expect(resultFieldsIn(fixture.output.stderr())).toEqual([])
  })

  it("prints no result fields under --json either, and pr view shows no submitted revision", async () => {
    await using fixture = await interruptedResubmit(true)

    expect(fixture.exit).not.toBe(0)
    expect(fixture.output.stdout(), "--json must carry no envelope for a submission that did not record").toBe("")
    expect(resultFieldsIn(fixture.output.stderr())).toEqual([])

    const view = outputIO()
    await runYrd(fixture.app, yrd("pr", "view", "PR1", "--json"), view.io, services(fixture.app))
    const detail = JSON.parse(view.stdout()) as {
      detail: { pr: { revs: readonly { n: number; submittedAt?: string }[] } }
    }
    const submitted = detail.detail.pr.revs.filter((revision) => revision.submittedAt !== undefined)
    expect(
      submitted.map((revision) => revision.n),
      "only the first submit's revision may carry a submit fact",
    ).toEqual([1])
  })

  it("queue audit lists the interrupted submit instead of reporting findings: []", async () => {
    await using fixture = await interruptedResubmit(true)

    const audit = outputIO()
    await runYrd(fixture.app, yrd("queue", "audit", "--json"), audit.io, services(fixture.app))
    const report = JSON.parse(audit.stdout()) as {
      findings: readonly { code: string; pr?: string; message: string; resolution?: readonly string[] }[]
    }

    // The bug: the revision is pushed with no submit fact, which reads as an
    // ordinary draft, so the draft walk held it behind its 15-minute grace and
    // the audit reported nothing at the one moment the author was still there.
    const finding = report.findings.find((entry) => entry.code === "submit-interrupted")
    expect(finding, `audit reported ${JSON.stringify(report.findings)}`).toBeDefined()
    expect(finding?.pr).toBe("PR1")
    expect(finding?.message).toContain("topic/one")
    expect(finding?.resolution?.join(" ")).toContain("yrd pr submit topic/one")
  })

  it("is not ALSO reported as a stranded draft — one condition, one finding", async () => {
    await using fixture = await interruptedResubmit(true)

    const audit = outputIO({ now: () => Date.parse("2026-08-25T14:00:00.000Z") })
    await runYrd(fixture.app, yrd("queue", "audit", "--json"), audit.io, services(fixture.app))
    const report = JSON.parse(audit.stdout()) as { findings: readonly { code: string }[] }

    // Two hours in, well past DRAFT_STRANDED_GRACE_MS. `draft-stranded` says
    // "nothing has submitted it", which is false here and sends the reader
    // looking for an author who never pushed the button.
    expect(report.findings.map((entry) => entry.code)).not.toContain("draft-stranded")
    expect(report.findings.map((entry) => entry.code)).toContain("submit-interrupted")
  })
})

describe("the draft walk still owns a real draft", () => {
  it("a change pushed and never submitted is a stranded draft, not an interrupted submit", async () => {
    // The false-positive control. Without it, a predicate that fired on every
    // pushed revision would pass every test above while relabelling the whole
    // draft population.
    await using app = await createCliApp()
    // The direct submit command still opens the draft door the retired
    // `pr create` used to; this is how the legacy pushed-only population in
    // the fleet's journals was written.
    await app.bays.submit({ branch: "topic/draft", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA, draft: true })

    const audit = outputIO({ now: () => Date.parse("2026-08-25T14:00:00.000Z") })
    await runYrd(app, yrd("queue", "audit", "--json"), audit.io, services(app))
    const report = JSON.parse(audit.stdout()) as { findings: readonly { code: string }[] }

    expect(report.findings.map((entry) => entry.code)).toContain("draft-stranded")
    expect(report.findings.map((entry) => entry.code)).not.toContain("submit-interrupted")
  })
})

describe("change identity across a retry", () => {
  it("a re-authored revision submits under the Change-Id the queue already holds", async () => {
    await using app = await createCliApp()
    await app.bays.submit({ branch: "topic/one", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    const minted = app.bays.pr("PR1")?.revs.at(-1)?.changeId
    expect(minted, "the first submit must mint an identity to re-attach").toBeDefined()

    const output = outputIO()
    const exit = await runYrd(app, yrd("pr", "submit", "topic/one", "--json"), output.io, services(app))

    expect(exit, output.stderr()).toBe(0)
    const revisions = app.bays.pr("PR1")?.revs ?? []
    expect(revisions.map((revision) => revision.n)).toEqual([1, 2])
    // One change, one identity: the retry re-attaches rather than minting a
    // second Change-Id for the same work (a change re-authored four times
    // minted three Change-Ids on 2026-08-24 by minting rather than re-attaching).
    expect(revisions.map((revision) => revision.changeId)).toEqual([minted, minted])
  })
})
