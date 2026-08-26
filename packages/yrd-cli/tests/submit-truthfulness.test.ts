/**
 * @failure `pr submit` exits 0 while the change it returns needs its author (needs-author/rejected), emits a poorer envelope on the refused branch than on success, or keeps advisory warnings --json-only so a human resubmitting a merged branch reads silence.
 * @level l2
 * @consumer @yrd/cli pr submit
 *
 * The reproduction needs no concurrency: `@yrd/bay` submitSelection short-
 * circuits an already-refused change back unmodified without throwing
 * (needs-author via the live-change early return; rejected via the identical-
 * payload `{ events: [] }` no-op), so the submit result set carries a change
 * the author must act on while the command exits 0.
 *
 * Q1 fence (cli.test.ts "Same merged head -> informational already merged,
 * exit 0"): only needs-author and rejected bill exit 1 — integrated/
 * already-landed resubmits stay informational exit 0.
 */
import { describe, expect, it } from "vitest"
import { changeDeliveryState, createBayJobDefs, withBays, volatilePrNumberMint } from "@yrd/bay"
import { Command, createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type JsonValue } from "@yrd/core"
import { withContests, type ContestGit } from "@yrd/contest"
import { withIssues } from "@yrd/issue"
import { withJobs, type JobResult } from "@yrd/job"
import { withMerge, withQueue, withStep, type ChangeShape, type StepExecution } from "@yrd/queue"
import { runYrd, type YrdCliIO, type YrdCliServices } from "@yrd/cli"
import type { ProcessRequest } from "@yrd/process"
import { createLogger } from "loggily"
import { testQueueReadModel } from "./queue-read-model-test-helper.ts"

const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "1".repeat(40)
const MERGED_SHA = "b".repeat(40)

function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace() {
  return {
    revision: "submit-truthfulness-workspace-v1",
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

/** In-memory CLI app. `failingCheckCode` makes the carrier check fail with that
 * code; a code in the queue's needs-author bucket (e.g. `composition-retired`)
 * turns the failed run into a durable `pr/needs-author`. */
async function createCliApp(
  options: {
    journal?: ReturnType<typeof createMemoryJournal<unknown>>
    failingCheckCode?: string
    idStart?: number
  } = {},
) {
  const bayJobs = createBayJobDefs(workspace())
  const check = withStep(
    "check",
    (): JobResult<JsonValue> =>
      options.failingCheckCode === undefined
        ? { status: "completed", conclusion: "success", output: { checked: true } }
        : {
            status: "completed",
            conclusion: "failure",
            error: { code: options.failingCheckCode, message: "carrier check failed: payload does not typecheck" },
          },
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
  const git: ContestGit = { revision: "git-v1", resolveCommit: () => BASE_SHA }
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
      journal: options.journal ?? createMemoryJournal(),
      clock: () => "2026-08-25T12:00:00.000Z",
      id: ids(options.idStart ?? 0),
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
    runner: "submit-truthfulness-test",
    leaseMs: 60_000,
    now: () => Date.parse("2026-08-25T12:10:00.000Z"),
    parents: async () => ["0".repeat(40)],
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
      // The pre-admission gitlink gate asks Git where the branch diverged from
      // its base; answer with one plausible merge base and the branch's own
      // recorded head for everything else (the cli.test.ts stub, verbatim).
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

/** A change whose failed run attributed the failure to its author. */
async function needsAuthorApp(): Promise<CliApp> {
  const app = await createCliApp({ failingCheckCode: "composition-retired" })
  await app.bays.submit({ branch: "topic/needs-author", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
  await app.queue.run({ prs: ["PR1"] }, { runner: "submit-truthfulness-test", leaseMs: 60_000 })
  expect(changeDeliveryState(app.bays.pr("PR1")!)).toBe("needs-author")
  return app
}

/** A change in the legacy `rejected` delivery state. No live command emits
 * `pr/rejected` any more, so the fixture replays it the way such changes really
 * exist in the fleet: from the journal. The crafted frame reuses a real op with
 * a matching command hash so replay integrity checks stay honest. */
async function rejectedApp(): Promise<CliApp> {
  const journal = createMemoryJournal<unknown>()
  const first = await createCliApp({ journal })
  await first.bays.submit({ branch: "topic/rejected", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
  let entries: unknown[] = []
  for await (const chunk of journal.read()) entries = [...entries, ...(chunk as { values: readonly unknown[] }).values]
  const op = "queue.settled"
  const args = { run: "R1" }
  const rejectedFrame = {
    cause: {
      id: "00000000-0000-7000-8000-0000000000f1",
      commandId: "00000000-0000-7000-8000-0000000000f0",
      op,
      commandHash: Command.hash({ op, args }),
    },
    command: { id: "00000000-0000-7000-8000-0000000000f0", op, args },
    events: [
      {
        id: "00000000-0000-7000-8000-0000000000f2",
        name: "pr/rejected",
        ts: "2026-08-25T12:05:00.000Z",
        data: {
          pr: "PR1",
          revision: 1,
          headSha: HEAD_SHA,
          run: "R1",
          step: "check",
          detail: "legacy rejection: payload does not typecheck",
        },
      },
    ],
  }
  const app = await createCliApp({ journal: createMemoryJournal([...entries, rejectedFrame]), idStart: 0x100 })
  expect(changeDeliveryState(app.bays.pr("PR1")!)).toBe("rejected")
  return app
}

/** A change integrated by a completed run — the Q1 frozen-identity fixture. */
async function integratedApp(): Promise<CliApp> {
  const app = await createCliApp()
  await app.bays.submit({ branch: "topic/merged", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
  await app.bays.requestChecks({ pr: "PR1" })
  await app.queue.run({ prs: ["PR1"] }, { runner: "submit-truthfulness-test", leaseMs: 60_000 })
  expect(changeDeliveryState(app.bays.pr("PR1")!)).toBe("integrated")
  return app
}

describe("pr submit exit truthfulness", () => {
  it("a resubmit that hands back a needs-author change exits 1", async () => {
    await using app = await needsAuthorApp()
    const output = outputIO({ resolveRevision: async () => HEAD_SHA })

    const exit = await runYrd(app, yrd("pr", "submit", "topic/needs-author", "--json"), output.io, services(app))
    const envelope = JSON.parse(output.stdout()) as { prs: readonly { id: string; status: string }[] }
    expect(envelope.prs).toMatchObject([{ id: "PR1", status: "needs-author" }])
    // The change still needs its author; a 0 here reads as "submitted fine".
    expect(exit, "needs-author submit must bill the author with exit 1").toBe(1)
  })

  it("a same-head resubmit of a rejected change exits 1", async () => {
    await using app = await rejectedApp()
    const output = outputIO({ resolveRevision: async () => HEAD_SHA })

    const exit = await runYrd(app, yrd("pr", "submit", "topic/rejected", "--json"), output.io, services(app))
    expect(changeDeliveryState(app.bays.pr("PR1")!)).toBe("rejected")
    const envelope = JSON.parse(output.stdout()) as { prs: readonly { id: string; status: string }[] }
    expect(envelope.prs).toMatchObject([{ id: "PR1", status: "rejected" }])
    expect(exit, "rejected submit must bill the author with exit 1").toBe(1)
  })

  it("Q1: a same-head resubmit of an integrated branch still exits 0", async () => {
    await using app = await integratedApp()
    const output = outputIO({ resolveRevision: async () => HEAD_SHA })

    const exit = await runYrd(app, yrd("pr", "submit", "topic/merged", "--json"), output.io, services(app))
    expect(exit, output.stderr()).toBe(0)
    const envelope = JSON.parse(output.stdout()) as {
      prs: readonly { id: string; status: string }[]
      warnings?: readonly string[]
    }
    expect(envelope.prs).toMatchObject([{ id: "PR1", status: "integrated" }])
    expect((envelope.warnings ?? []).join("\n")).toContain("already merged as change 'PR1'")
  })
})

describe("pr submit refused-branch envelope", () => {
  it("a refused submit's JSON carries the same per-change eligibility key as success", async () => {
    await using app = await needsAuthorApp()
    const output = outputIO({ resolveRevision: async () => HEAD_SHA })

    await runYrd(app, yrd("pr", "submit", "topic/needs-author", "--json"), output.io, services(app))
    const envelope = JSON.parse(output.stdout()) as {
      prs: readonly { id: string; eligibility?: { reason?: { code: string; message: string } } }[]
    }
    // The success branch projects projectChangeTaskStatusWithEligibility plus
    // an `eligibility` key per change; the refused branch must not be poorer.
    expect(envelope.prs[0]?.eligibility, "refused submit must carry eligibility like success does").toBeDefined()
    expect(envelope.prs[0]?.eligibility?.reason).toMatchObject({ code: "needs-author" })
  })

  it("the already-merged warning reaches human stderr, not only --json", async () => {
    await using app = await integratedApp()
    const output = outputIO({ resolveRevision: async () => HEAD_SHA })

    const exit = await runYrd(app, yrd("pr", "submit", "topic/merged"), output.io, services(app))
    expect(exit).toBe(0)
    // cli.test.ts pins the JSON half; this is the human half the JSON test
    // cannot see: without printResultWithWarnings the advisory evaporates.
    expect(output.stderr()).toContain("already merged as change 'PR1'")
  })
})
