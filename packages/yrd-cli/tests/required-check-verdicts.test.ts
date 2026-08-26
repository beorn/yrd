/**
 * @failure A required check that RAN leaves no trace of its verdict, and `pr checks` then answers exit 0 for a change nothing ever judged.
 * @level l2
 * @consumer @yrd/cli pr submit · pr ready · check · pr checks
 *
 * The specimen is PR1970 (@i/10-merge-queue/failed-check-erased, measured by
 * `@dev/0` on 2026-08-23): `yrd pr submit` ran four required checks, FAILED
 * `affected-tests` and exited 1 — and minutes later every read surface said the
 * attempt had never happened, `pr checks` doing so with exit 0.
 *
 * Two independent defects produced that, and each gets its own describe below.
 *
 * 1. The pre-submit leg was a check authority that reported NOWHERE. Its
 *    verdicts were a return value, and the failing path leaves through a throw,
 *    so the failure AND every pass before it died with the stack. The bead asks
 *    which of the two was erased; the answer these tests pin is BOTH, because
 *    the single report was a value the thrower never returned.
 *
 * 2. `pr checks` exited 0 whenever nothing said `failed`, so "no verdict" and
 *    "passed" were one answer. That is the half that turns a lost verdict into
 *    an affirmative wrong one, and it is why the failure was unprovable from
 *    anything but one agent's `/tmp` scratch file.
 */
import { describe, expect, it } from "vitest"
import { createBayJobDefs, withBays } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type JsonValue } from "@yrd/core"
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

/** The two checks the specimen ran in this order: a cheap one that passed, then
 * the expensive one that failed. Their ORDER is the point — a report that only
 * survives the happy path loses the first one. */
const CHEAP_CHECK = "manifest-co-change"
const EXPENSIVE_CHECK = "affected-tests"

function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace() {
  return {
    revision: "required-check-verdicts-workspace-v1",
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

async function createCliApp(options: { idStart?: number } = {}) {
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
  const git: ContestGit = { revision: "git-v1", resolveCommit: () => BASE_SHA }
  const contests = withContests({ runners: [], evaluators: [], git })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs, contests.jobDefs] }),
    withIssues({ sources: [{ id: "km", resolve: (ref) => ({ ref, title: "Issue one" }) }] }),
    withBays({ jobs: bayJobs, defaultBase: "main", resolveBase: (ref) => ({ base: ref, baseSha: BASE_SHA }) }),
  )
  return createYrd(contests(queue(base)), {
    inject: {
      journal: createMemoryJournal(),
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
    runner: "required-check-verdicts-test",
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

/** Records which check names actually ran, so a test can tell "the report is
 * missing a verdict" from "the check never executed". */
type CheckLog = { ran: string[] }

/**
 * The pre-submit required-check capability, wired to fail exactly one named
 * check. `failing: undefined` is the all-green run.
 */
function services(app: CliApp, options: { failing?: string; log?: CheckLog } = {}): YrdCliServices {
  return {
    queueReadModel: testQueueReadModel(app),
    checks: {
      names: [CHEAP_CHECK, EXPENSIVE_CHECK],
      run: async (name: string) => {
        options.log?.ran.push(name)
        const failed = name === options.failing
        return {
          stdout: "",
          stderr: failed ? `${name}: 1 failed | 67 passed` : "",
          exitCode: failed ? 1 : 0,
          signal: null,
          durationMs: 1,
          timedOut: false,
        }
      },
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

async function draftedApp(branch: string): Promise<CliApp> {
  const app = await createCliApp()
  await app.bays.submit({ branch, headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
  return app
}

describe("a required check that ran cannot be erased by the throw that ends the run", () => {
  it("reports the FAILING check and every pass that preceded it", async () => {
    await using app = await draftedApp("topic/red")
    const log: CheckLog = { ran: [] }
    const output = outputIO({ resolveRevision: async () => HEAD_SHA })

    const exit = await runYrd(
      app,
      yrd("pr", "submit", "topic/red"),
      output.io,
      services(app, { failing: EXPENSIVE_CHECK, log }),
    )

    expect(exit, "a failed required check must bill the author").toBe(1)
    expect(log.ran, "both checks must have executed for this to be about reporting").toEqual([
      CHEAP_CHECK,
      EXPENSIVE_CHECK,
    ])
    // The failure diagnostic alone was never the gap — it was already printed
    // on the specimen. What died with the throw is the LEDGER: which checks
    // ran, and how each ended. It rides the raised message because that is the
    // only artifact an unwind carries.
    expect(output.stderr()).toContain(`${CHEAP_CHECK} passed`)
    expect(output.stderr()).toContain(`${EXPENSIVE_CHECK} FAILED (exit 1)`)
    // Additive: the diagnostic the author acts on, and the check's own stderr
    // inside it, both survive unchanged.
    expect(output.stderr()).toContain(`required check failed: '${EXPENSIVE_CHECK}' exited 1`)
    expect(output.stderr()).toContain("1 failed | 67 passed")
  })

  it("reports a wholly PASSING run too — the erasure was never failure-only", async () => {
    // @i/10-merge-queue/failed-check-erased asks outright whether a passing
    // check is erased as well, because the answer changes the blast radius.
    // It is: the discarded return value was the only report on BOTH paths, so
    // a green pre-submit gate left exactly as much evidence as a red one, none.
    await using app = await draftedApp("topic/green")
    const log: CheckLog = { ran: [] }
    const output = outputIO({ resolveRevision: async () => HEAD_SHA })

    const exit = await runYrd(app, yrd("pr", "submit", "topic/green", "--json"), output.io, services(app, { log }))

    expect(exit, output.stderr()).toBe(0)
    expect(log.ran).toEqual([CHEAP_CHECK, EXPENSIVE_CHECK])
    expect(JSON.parse(output.stdout()) as Record<string, unknown>).toMatchObject({
      command: "pr.submit",
      requiredChecks: [
        { name: CHEAP_CHECK, status: "passed", exitCode: 0 },
        { name: EXPENSIVE_CHECK, status: "passed", exitCode: 0 },
      ],
    })
    // A successful command stays silent on fd2. The verdicts belong in the
    // result, and the result is what a success actually produces.
    expect(output.stderr()).toBe("")
  })

  it("a --json failure keeps stderr ONE document, ledger inside it", async () => {
    // Every existing consumer does JSON.parse(stderr) on a refused submit, so
    // a second document would be a worse instrument than the erasure: it turns
    // a readable refusal into a parse error.
    await using app = await draftedApp("topic/red-json")
    const output = outputIO({ resolveRevision: async () => HEAD_SHA })

    const exit = await runYrd(
      app,
      yrd("pr", "submit", "topic/red-json", "--json"),
      output.io,
      services(app, { failing: EXPENSIVE_CHECK }),
    )

    expect(exit).toBe(1)
    const failure = JSON.parse(output.stderr()) as { failure: { message: string; cause: string } }
    expect(failure.failure.message).toContain(`${CHEAP_CHECK} passed`)
    expect(failure.failure.message).toContain(`${EXPENSIVE_CHECK} FAILED (exit 1)`)
    // A refused submit prints no result envelope at all, which is why the
    // ledger cannot live there.
    expect(output.stdout()).toBe("")
  })

  it("`pr ready` runs the same gate and had the same erasure", async () => {
    // Found by grepping the SYMBOL rather than reading the submit path alone:
    // readyPr awaited runRequiredChecks and dropped the value identically, so
    // a `pr ready` that ran four checks left no evidence any had.
    await using app = await draftedApp("topic/ready")
    const output = outputIO({ resolveRevision: async () => HEAD_SHA })

    await runYrd(app, yrd("pr", "ready", "PR1", "--json"), output.io, services(app))

    expect(JSON.parse(output.stdout()) as Record<string, unknown>).toMatchObject({
      command: "pr.ready",
      requiredChecks: [
        { name: CHEAP_CHECK, status: "passed" },
        { name: EXPENSIVE_CHECK, status: "passed" },
      ],
    })
  })
})

describe("pr checks exit 0 means a recorded pass, never merely the absence of a failure", () => {
  it("refuses for a change nothing has judged, instead of reporting not-requested with exit 0", async () => {
    await using app = await draftedApp("topic/unjudged")
    const output = outputIO()

    const exit = await runYrd(app, yrd("pr", "checks", "PR1", "--json"), output.io, services(app))

    // The row itself stays honest and unchanged — `not-requested` IS what the
    // queue-side record says. What changes is that the exit code no longer
    // translates that absence into "fine".
    expect(JSON.parse(output.stdout()) as Record<string, unknown>).toMatchObject({
      kind: "pr.check",
      pr: "PR1",
      status: "not-requested",
    })
    expect(exit, "an absent verdict is a refusal, never a silent pass").toBe(1)
  })

  it("still exits 0 once a real passing verdict exists", async () => {
    // The positive control. Without it, the assertion above is satisfied by a
    // command that simply always fails now, which would be a worse instrument
    // than the one being replaced.
    await using app = await draftedApp("topic/judged")
    await app.bays.requestChecks({ pr: "PR1" })
    await app.queue.run({ prs: ["PR1"] }, { runner: "required-check-verdicts-test", leaseMs: 60_000 })
    const output = outputIO()

    const exit = await runYrd(app, yrd("pr", "checks", "PR1", "--json"), output.io, services(app))

    expect(JSON.parse(output.stdout()) as Record<string, unknown>).toMatchObject({
      kind: "pr.check",
      pr: "PR1",
      status: "passed",
    })
    expect(exit, output.stderr()).toBe(0)
  })
})
