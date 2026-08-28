/**
 * @failure `pr submit` reports success for a submission that wrote nothing, or
 * refuses a resubmit whose branch's previous delivery ended — so exit 0 stops
 * meaning "a submit fact was written", and a re-push after a rejection has no
 * way back into the queue.
 * @level l2
 * @consumer @yrd/cli pr submit
 *
 * Since S7 (branch-is-change, @i/10 22991) there is one lane and one durable
 * effect: `pr submit` writes the branch's submit fact. Exit 0 is truthful
 * exactly when that fact was written, and that is what these tests pin. The
 * delivery-state arms this file used to fence — needs-author billing, the
 * already-merged advisory, the per-change `prs[].eligibility` envelope — all
 * read the change record and died with it; a record's terminal state can no
 * longer refuse, reopen, or annotate a submission.
 */
import { describe, expect, it } from "vitest"
import { createBayJobDefs, volatilePrNumberMint, withBays } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type JsonValue } from "@yrd/core"
import { seededChangesEntry, type ChangeSeed } from "./support/seeded-changes.ts"
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
    seeds?: readonly ChangeSeed[]
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
  // S7 (branch-is-change, @i/10 22991): a derived member's identity mints at
  // ADMISSION, and it carries no baseSha of its own. Without both, derived
  // admission refuses, the compose swallows the refusal as an empty batch,
  // and every surface below sees zero retained run members.
  const queue = withQueue({
    steps: [check, merge] as const,
    batch: false,
    prNumberMint: volatilePrNumberMint(),
    resolveBaseSha: () => BASE_SHA,
  })
  const git: ContestGit = { revision: "git-v1", resolveCommit: () => BASE_SHA }
  const contests = withContests({ runners: [], evaluators: [], git })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs, contests.jobDefs] }),
    withIssues({ sources: [{ id: "km", resolve: (ref) => ({ ref, title: "Issue one" }) }] }),
    withBays({
      jobs: bayJobs,
      defaultBase: "main",
      resolveBase: (ref) => ({ base: ref, baseSha: BASE_SHA }),
    }),
  )
  return createYrd(contests(queue(base)), {
    inject: {
      journal:
        options.seeds === undefined ? createMemoryJournal() : createMemoryJournal([seededChangesEntry(options.seeds)]),
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
        // The standing submit fact IS the branch's head since S7 — the
        // record's revision list is gone, and `submits[branch]` is the one
        // place a live head is written down.
        const observed = branch === undefined ? undefined : app.bays.state().submits[branch]
        return {
          stdout: request.argv.includes("merge-base")
            ? `${"0".repeat(39)}1\n`
            : // The pre-admission gitlink gate enumerates the merge base's tree
              // (`ls-tree -r -z --full-tree`). This fixture's repository has no
              // submodules, so that listing is empty — a bare newline is not an
              // empty listing, it is a malformed entry.
              request.argv.includes("ls-tree")
              ? ""
              : `${observed?.sha ?? ""}\n`,
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

/** A branch whose delivery ENDED: the journal carries its whole record history
 * (pushed, submitted, then a legacy `pr/rejected`), and no submit fact stands
 * for it — which is exactly how such a branch exists in the fleet now. No live
 * command emits `pr/rejected` any more, so the frame can only be replayed. */
async function endedDeliveryApp(): Promise<CliApp> {
  const app = await createCliApp({
    idStart: 0x100,
    seeds: [
      {
        pr: "PR1",
        branch: "topic/rejected",
        base: "main",
        revs: [{ headSha: HEAD_SHA, baseSha: BASE_SHA }],
        terminal: {
          kind: "rejected",
          run: "R1",
          step: "check",
          detail: "legacy rejection: payload does not typecheck",
        },
      },
    ],
  })
  expect(app.state().bays.submits["topic/rejected"], "an ended delivery stands no submit fact").toBeUndefined()
  return app
}

/** A branch with a STANDING submit fact at `HEAD_SHA` — a live delivery, which
 * since S7 is all a submitted change is. */
async function liveApp(): Promise<CliApp> {
  const app = await createCliApp({
    seeds: [{ pr: "PR1", branch: "topic/live", base: "main", revs: [{ headSha: HEAD_SHA, baseSha: BASE_SHA }] }],
  })
  expect(app.state().bays.submits["topic/live"]).toMatchObject({ sha: HEAD_SHA, base: "main" })
  return app
}

describe("pr submit exit truthfulness — exit 0 means a submit fact was written", () => {
  it("re-enters a branch whose delivery ended, writing a fresh fact and exiting 0", async () => {
    await using app = await endedDeliveryApp()
    const output = outputIO({ resolveRevision: async () => HEAD_SHA })

    const exit = await runYrd(app, yrd("pr", "submit", "topic/rejected", "--json"), output.io, services(app))

    const envelope = JSON.parse(output.stdout()) as {
      derived?: readonly { lane: string; branch: string; sha: string; base: string }[]
    }
    // The rejection is frozen history and cannot refuse the branch: there is no
    // record left to reopen, and no terminal state left to consult.
    expect(envelope.derived).toEqual([{ lane: "derived", branch: "topic/rejected", sha: HEAD_SHA, base: "main" }])
    // Exit 0 is truthful only because the submission DID something durable:
    // the branch-submit fact is written, so the next queue pass composes it.
    expect(app.state().bays.submits["topic/rejected"]).toMatchObject({ sha: HEAD_SHA, base: "main" })
    expect(exit, "a derived acceptance is a success and exits 0").toBe(0)
  })

  it("re-writes the fact for a same-head resubmit of a live branch and exits 0", async () => {
    // Q1 (was: "a same-head resubmit of an integrated branch still exits 0").
    // The record's frozen identity is gone, so the question that survives is
    // whether a redundant-looking resubmit still lands a fact — it must, since
    // a re-push of the submit ref is the ONLY retry gesture left.
    await using app = await liveApp()
    const output = outputIO({ resolveRevision: async () => HEAD_SHA })

    const exit = await runYrd(app, yrd("pr", "submit", "topic/live", "--json"), output.io, services(app))

    expect(exit, output.stderr()).toBe(0)
    const envelope = JSON.parse(output.stdout()) as {
      derived?: readonly { lane: string; branch: string; sha: string; base: string }[]
    }
    expect(envelope.derived).toEqual([{ lane: "derived", branch: "topic/live", sha: HEAD_SHA, base: "main" }])
    expect(app.state().bays.submits["topic/live"]).toMatchObject({ sha: HEAD_SHA, base: "main" })
  })

  it("refuses instead of exiting 0 when there is no head to submit", async () => {
    // The fence the whole file exists for: a submission that produced no fact
    // must never answer 0. A branch nobody pushed resolves to no commit, so
    // the refusal lands before any fact is written. (`pr submit`'s other
    // no-write arm, `change-selection-empty`, guards a selection that resolves
    // a head but yields no submission; this fixture cannot reach it, and
    // nothing in this suite covers it.)
    await using app = await liveApp()
    const output = outputIO({ resolveRevision: async () => undefined })

    const exit = await runYrd(app, yrd("pr", "submit", "topic/unpushed", "--json"), output.io, services(app))

    expect(exit, output.stdout()).toBe(1)
    expect(output.stdout()).toBe("")
    const refusal = JSON.parse(output.stderr()) as { failure: { code: string; message: string } }
    expect(refusal.failure.code).toBe("git-commit-missing")
    expect(app.state().bays.submits["topic/unpushed"]).toBeUndefined()
    // The live branch is untouched: a refused selection writes nothing at all.
    expect(app.state().bays.submits["topic/live"]).toMatchObject({ sha: HEAD_SHA })
  })
})
