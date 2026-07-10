// @failure CLI projection diverges from installed Yrd capabilities or its documented process contract
// @level l2
// @consumer @yrd/cli

import { describe, expect, it } from "vitest"
import { createBayJobDefs, withBays, type BayWorkspace } from "@yrd/bay"
import { runYrd, type YrdCliIO, type YrdCliServices } from "@yrd/cli"
import { createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type JsonValue } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import { withLine, withMerge, withStep, type AddStepResult, type PRShape, type StepExecution } from "@yrd/line"
import { withTasks } from "@yrd/task"
import {
  withContests,
  type AttemptRunOutput,
  type ContestEvaluatorDef,
  type ContestGit,
  type ContestRunnerDef,
} from "@yrd/contest"

const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "1".repeat(40)
const MERGED_SHA = "b".repeat(40)

type CheckedShape = AddStepResult<PRShape, "check", JsonValue>
type ProbeKind = "bay" | "runner" | "evaluator"
type OverlapProbe = {
  pause(kind: ProbeKind): Promise<void>
  max(kind: ProbeKind): number
}

function ids(): () => string {
  let value = 0
  return () => `id-${++value}`
}

function overlapProbe(): OverlapProbe {
  const active: Record<ProbeKind, number> = { bay: 0, runner: 0, evaluator: 0 }
  const maximum: Record<ProbeKind, number> = { bay: 0, runner: 0, evaluator: 0 }
  return {
    async pause(kind) {
      active[kind] += 1
      maximum[kind] = Math.max(maximum[kind], active[kind])
      await new Promise((complete) => setTimeout(complete, 10))
      active[kind] -= 1
    },
    max(kind) {
      return maximum[kind]
    },
  }
}

function workspace(options: { dirty?: boolean; refreshedHead?: string; probe?: OverlapProbe } = {}): BayWorkspace {
  return {
    revision: "test-workspace-v1",
    async provision(input) {
      await options.probe?.pause("bay")
      return {
        status: "passed",
        output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD_SHA, baseSha: BASE_SHA },
      }
    },
    refresh(input) {
      return {
        status: "passed",
        output: {
          path: input.path ?? `/repo/.bays/${input.bay}`,
          headSha: options.refreshedHead ?? HEAD_SHA,
          baseSha: BASE_SHA,
          dirty: options.dirty ?? false,
        },
      }
    },
    deprovision() {
      return { status: "passed", output: {} }
    },
  }
}

function contestAdapters(probe?: OverlapProbe, baseResolutions?: string[]) {
  const pins = new Map<string, string>()
  const runner: ContestRunnerDef = {
    harness: "ag",
    revision: "ag-runner-v1",
    async run(input): Promise<JobResult<AttemptRunOutput>> {
      await probe?.pause("runner")
      const commit = input.competitor.model === "codex" ? "c".repeat(40) : "d".repeat(40)
      const ref = `refs/yrd/attempts/${input.contest}/${input.attempt}`
      pins.set(ref, commit)
      return {
        status: "passed",
        output: {
          pin: { commit, ref, bay: input.bay.id, branch: input.bay.branch, baseSha: BASE_SHA },
          wallTimeMs: input.competitor.model === "codex" ? 100 : 120,
          tokens: { input: 10, output: 4, cachedInput: 2, cacheWrite: 0, reasoning: 1 },
          cost: { kind: "reported", usd: 0.01, source: "ag" },
          artifacts: [],
        },
      }
    },
  }
  const evaluator: ContestEvaluatorDef = {
    id: "held-out",
    revision: "held-out-v1",
    authority: "held-out",
    async evaluate() {
      await probe?.pause("evaluator")
      return { status: "passed", output: { verdict: "passed", artifacts: [] } }
    },
  }
  const git: ContestGit = {
    revision: "git-v1",
    resolveCommit(ref) {
      const pin = pins.get(ref)
      if (pin !== undefined) return pin
      baseResolutions?.push(ref)
      return BASE_SHA
    },
  }
  return { runner, evaluator, git }
}

async function createApp(
  options: {
    waitingCheck?: boolean
    dirtyBay?: boolean
    refreshedHead?: string
    probe?: OverlapProbe
    baseResolutions?: string[]
    batch?: false | number
  } = {},
) {
  const contest = contestAdapters(options.probe, options.baseResolutions)
  const bayJobs = createBayJobDefs(
    workspace({ dirty: options.dirtyBay, refreshedHead: options.refreshedHead, probe: options.probe }),
  )
  const check = withStep(
    "check",
    (_input: StepExecution<PRShape>): JobResult<JsonValue> =>
      options.waitingCheck
        ? {
            status: "waiting",
            token: "remote-check",
            url: "https://ci.invalid/run/1",
            checkpoint: { baseSha: BASE_SHA, candidateSha: HEAD_SHA },
          }
        : { status: "passed", output: { checked: true } },
    { revision: "check-v1", output: JsonSchema },
  )
  const merge = withMerge(
    (_input: StepExecution<CheckedShape>): JobResult<{ commit: string; baseSha: string }> => ({
      status: "passed",
      output: { commit: MERGED_SHA, baseSha: MERGED_SHA },
    }),
    { revision: "merge-v1" },
  )
  const line = withLine({ steps: [check, merge] as const, batch: options.batch ?? false })
  const contests = withContests({ runners: [contest.runner], evaluators: [contest.evaluator], git: contest.git })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, line.jobDefs, contests.jobDefs] }),
    withTasks({ sources: [{ id: "km", resolve: (ref) => ({ ref, title: "Task one" }) }] }),
    withBays({ jobs: bayJobs, defaultBase: "main" }),
  )
  return createYrd(contests(line(base)), {
    inject: { journal: createMemoryJournal(), clock: () => "2026-07-09T12:00:00.000Z", id: ids() },
  })
}

type TestApp = Awaited<ReturnType<typeof createApp>>

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
    executor: "cli-test",
    leaseMs: 60_000,
    now: () => 0,
    ...overrides,
  }
  return { io, stdout: () => stdout, stderr: () => stderr }
}

function yrd(...args: string[]): string[] {
  return ["/usr/bin/bun", "/repo/bin/yrd.ts", ...args]
}

function gitBay(...args: string[]): string[] {
  return ["git", "bay", ...args]
}

async function openAndSubmit(app: TestApp): Promise<void> {
  const open = outputIO()
  expect(await runYrd(app, yrd("bay", "open", "one"), open.io)).toBe(0)
  const submit = outputIO({ cwd: "/repo/.bays/B1" })
  expect(await runYrd(app, yrd("bay", "submit"), submit.io)).toBe(0)
}

describe("runYrd", () => {
  it("projects git bay onto the public bay subtree and exposes no internal operations", async () => {
    const app = await createApp()
    const gitHelp = outputIO()
    expect(await runYrd(app, gitBay("--help"), gitHelp.io)).toBe(0)
    expect(gitHelp.stdout()).toContain("Usage: git bay")
    expect(gitHelp.stdout()).toContain("open")
    expect(gitHelp.stdout()).toContain("refresh")
    expect(gitHelp.stdout()).toContain("submit")
    expect(gitHelp.stdout()).toContain("close")
    expect(gitHelp.stdout()).not.toMatch(/^\s+line /mu)
    expect(gitHelp.stdout()).not.toMatch(/^\s+task /mu)
    expect(gitHelp.stdout()).not.toMatch(/^\s+contest /mu)
    expect(gitHelp.stdout()).not.toMatch(/^\s+help /mu)

    const opened = outputIO({ color: true, columns: 64 })
    expect(await runYrd(app, gitBay("open", "from-git"), opened.io)).toBe(0)
    expect(opened.stdout()).toContain("BAY")
    expect(opened.stdout()).toContain("STATUS")
    expect(opened.stdout()).toContain("PATH")
    expect(opened.stdout()).toContain("file:///repo/.bays/B1")

    const yrdHelp = outputIO()
    expect(await runYrd(app, yrd("contest", "--help"), yrdHelp.io)).toBe(0)
    expect(yrdHelp.stdout()).toContain("Usage: yrd contest")
    expect(yrdHelp.stdout()).toContain("show")
    expect(yrdHelp.stdout()).toContain("evaluate")
    expect(yrdHelp.stdout()).toContain("select")
    expect(yrdHelp.stdout()).toContain("promote")
    expect(yrdHelp.stdout()).not.toMatch(/^\s+run \[/mu)
    expect(yrdHelp.stdout()).not.toMatch(/^\s+help /mu)
  })

  it("opens, refreshes, and closes bays through installed command refs while driving jobs", async () => {
    const app = await createApp()
    const open = outputIO({ color: true, columns: 64 })
    expect(await runYrd(app, yrd("bay", "open", "fix-readme", "--from", "topic/readme"), open.io)).toBe(0)
    expect(open.stdout()).toContain("file:///repo/.bays/B1")

    const state = app.state()
    expect(state.bays.byId.B1).toMatchObject({
      name: "fix-readme",
      branch: "topic/readme",
      status: "active",
      path: "/repo/.bays/B1",
    })
    expect(Object.values(state.jobs.byId)).toContainEqual(
      expect.objectContaining({ definition: "bay.provision", status: "passed" }),
    )

    const refresh = outputIO({ cwd: "/repo/.bays/B1" })
    expect(await runYrd(app, yrd("bay", "refresh"), refresh.io)).toBe(0)
    expect(refresh.stdout()).toContain("B1")
    expect(refresh.stdout()).toContain("active")
    const refreshed = app.state()
    expect(Object.values(refreshed.jobs.byId)).toContainEqual(
      expect.objectContaining({ definition: "bay.refresh", status: "passed" }),
    )

    const close = outputIO({ cwd: "/repo/.bays/B1" })
    expect(await runYrd(app, yrd("bay", "close"), close.io)).toBe(0)
    expect(close.stdout()).toContain("B1")
    expect(close.stdout()).toContain("closed")
    expect(app.state().bays.byId.B1?.status).toBe("closed")
  })

  it("submits inferred bays and runs selected line steps instead of merely enqueueing jobs", async () => {
    const app = await createApp()
    await openAndSubmit(app)

    const before = app.state()
    expect(before.bays.prs.PR1).toMatchObject({ bay: "B1", status: "submitted", headSha: HEAD_SHA })

    const integrated = outputIO()
    expect(
      await runYrd(app, yrd("line", "integrate", "PR1", "--steps", "check,merge", "--json"), integrated.io),
      integrated.stderr(),
    ).toBe(0)
    expect(JSON.parse(integrated.stdout())).toMatchObject({
      command: "line.integrate",
      results: [
        {
          id: "R1",
          status: "passed",
          steps: [{ name: "check" }, { name: "merge" }],
          prs: [{ id: "PR1", headSha: HEAD_SHA }],
        },
      ],
    })
    expect(app.state().bays.prs.PR1).toMatchObject({
      status: "integrated",
      integration: { commit: MERGED_SHA },
    })
  })

  it("refreshes an active bay before submit and refuses uncommitted work", async () => {
    const refreshedHead = "2".repeat(40)
    const clean = await createApp({ refreshedHead })
    const open = outputIO()
    expect(await runYrd(clean, yrd("bay", "open", "fresh-head"), open.io)).toBe(0)
    const submit = outputIO({ cwd: "/repo/.bays/B1" })
    expect(await runYrd(clean, yrd("bay", "submit"), submit.io)).toBe(0)
    expect(clean.state().bays.prs.PR1).toMatchObject({
      bay: "B1",
      headSha: refreshedHead,
      status: "submitted",
    })

    const dirty = await createApp({ dirtyBay: true })
    expect(await runYrd(dirty, yrd("bay", "open", "dirty"), outputIO().io)).toBe(0)
    const refused = outputIO({ cwd: "/repo/.bays/B1" })
    expect(await runYrd(dirty, yrd("bay", "submit"), refused.io)).toBe(1)
    expect(refused.stdout()).toBe("")
    expect(refused.stderr()).toContain("uncommitted work")
    expect(Object.keys(dirty.state().bays.prs)).toEqual([])
  })

  it("submits an existing source branch through the injected Git revision boundary", async () => {
    const app = await createApp()
    const resolved: string[] = []
    const submit = outputIO({
      resolveRevision: async (ref) => {
        resolved.push(ref)
        return HEAD_SHA
      },
    })
    expect(await runYrd(app, yrd("bay", "submit", "topic/direct", "--base", "release/2.0", "--json"), submit.io)).toBe(
      0,
    )
    expect(resolved).toEqual(["topic/direct"])
    expect(JSON.parse(submit.stdout())).toMatchObject({
      prs: [{ id: "PR1", branch: "topic/direct", base: "release/2.0", headSha: HEAD_SHA, status: "submitted" }],
    })

    const human = outputIO({ columns: 64 })
    expect(await runYrd(app, yrd("bay", "submit", "topic/direct", "--base", "release/2.0"), human.io)).toBe(0)
    expect(human.stdout()).toContain("PR")
    expect(human.stdout()).toContain("STATUS")
    expect(human.stdout()).toContain("submitted")
    expect(human.stdout()).toContain("topic/direct")
    expect(human.stdout()).toContain("release/2.0")
  })

  it("finishes a waiting line job and resumes the same durable run", async () => {
    const app = await createApp({ waitingCheck: true })
    await openAndSubmit(app)

    const integrate = outputIO()
    expect(await runYrd(app, yrd("line", "integrate", "PR1"), integrate.io)).toBe(0)
    expect(app.line.get("R1")?.status).toBe("waiting")
    const waiting = outputIO({ color: true })
    expect(await runYrd(app, yrd("line", "status", "PR1"), waiting.io)).toBe(0)
    expect(waiting.stdout()).toContain("https://ci.invalid/run/1")

    const finish = outputIO()
    expect(
      await runYrd(app, yrd("line", "finish", "PR1", "--ok", "--token", "remote-check", "--json"), finish.io),
    ).toBe(0)
    expect(JSON.parse(finish.stdout())).toMatchObject({ command: "line.finish", run: { id: "R1", status: "passed" } })
    expect(app.line.get("R1")?.shape).toMatchObject({
      results: { check: { baseSha: BASE_SHA, candidateSha: HEAD_SHA } },
    })
    expect(app.line.get("R1")?.steps.map((step) => step.job?.status)).toEqual(["passed", "passed"])
  })

  it("records an external failing verdict successfully while the line run becomes failed", async () => {
    const app = await createApp({ waitingCheck: true })
    await openAndSubmit(app)
    expect(await runYrd(app, yrd("line", "integrate", "PR1"), outputIO().io)).toBe(0)

    const finish = outputIO()
    expect(
      await runYrd(
        app,
        yrd(
          "line",
          "finish",
          "PR1",
          "--step",
          "check",
          "--fail",
          "--token",
          "remote-check",
          "--detail",
          "private tests failed",
          "--artifact",
          "report=/tmp/private-tests.log",
          "--json",
        ),
        finish.io,
      ),
    ).toBe(0)
    expect(JSON.parse(finish.stdout())).toMatchObject({ run: { id: "R1", status: "failed" } })
    expect(app.state().bays.prs.PR1).toMatchObject({
      status: "rejected",
      detail: "private tests failed",
    })
    const status = outputIO({ color: true })
    expect(await runYrd(app, yrd("line", "status", "PR1"), status.io)).toBe(0)
    expect(status.stdout()).toContain("file:///tmp/private-tests.log")
  })

  it("preserves zero-selector and explicitly empty step selection semantics", async () => {
    const app = await createApp()
    await openAndSubmit(app)

    const integrated = outputIO()
    expect(await runYrd(app, yrd("line", "integrate", "--steps", "--json"), integrated.io)).toBe(0)
    expect(JSON.parse(integrated.stdout())).toEqual({ command: "line.integrate", results: [] })
    expect(app.state().bays.prs.PR1?.status).toBe("submitted")

    const idle = outputIO()
    expect(await runYrd(app, yrd("line", "integrate", "--json"), idle.io)).toBe(0)
    expect(JSON.parse(idle.stdout())).toMatchObject({
      command: "line.integrate",
      results: [{ id: "R1", prs: [{ id: "PR1" }], steps: [{ name: "check" }, { name: "merge" }], status: "passed" }],
    })

    const drained = outputIO()
    expect(await runYrd(app, yrd("line", "integrate", "--json"), drained.io)).toBe(0)
    expect(JSON.parse(drained.stdout())).toEqual({ command: "line.integrate", results: [] })
  })

  it("passes zero-or-more selectors to the line as one batch-capable candidate set", async () => {
    const app = await createApp({ batch: 2 })
    await openAndSubmit(app)
    expect(await runYrd(app, yrd("bay", "open", "two"), outputIO().io)).toBe(0)
    expect(await runYrd(app, yrd("bay", "submit"), outputIO({ cwd: "/repo/.bays/B2" }).io)).toBe(0)

    const integrated = outputIO()
    expect(await runYrd(app, yrd("line", "integrate", "--json"), integrated.io), integrated.stderr()).toBe(0)
    expect(JSON.parse(integrated.stdout())).toMatchObject({
      results: [
        {
          id: "R1",
          status: "passed",
          prs: [{ id: "PR1" }, { id: "PR2" }],
        },
      ],
    })
  })

  it("uses read capabilities for line status and contest show without appending events", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    await app.line.integrate({ prs: ["PR1"] }, { executor: "test", leaseMs: 60_000, now: () => 0 })
    const base = await app.contests.resolveBase()
    await app.command(app.commands.task.compete, {
      task: { ref: { source: "km", id: "T1" }, title: "Task one" },
      competitors: [
        { model: "codex", harness: "ag", config: { prompt: "Implement it" } },
        { model: "claude", harness: "ag", config: { prompt: "Implement it" } },
      ],
      base: base.base,
      baseSha: base.sha,
    })
    const before = await Array.fromAsync(app.events()).then((events) => events.length)

    const resolved: string[] = []
    const status = outputIO({
      resolveRevision: async (ref) => {
        resolved.push(ref)
        return MERGED_SHA
      },
    })
    expect(await runYrd(app, yrd("line", "status", "PR1", "--json"), status.io)).toBe(0)
    expect(JSON.parse(status.stdout())).toMatchObject({
      command: "line.status",
      results: [{ base: "main", headSha: MERGED_SHA, prs: [{ id: "PR1" }] }],
    })
    expect(resolved).toEqual(["main"])

    const human = outputIO({
      now: () => Date.parse("2026-07-09T12:01:00.000Z"),
      color: true,
      columns: 64,
      resolveRevision: async () => MERGED_SHA,
    })
    expect(await runYrd(app, yrd("line", "status", "PR1"), human.io)).toBe(0)
    expect(human.stdout()).toContain("PR1")
    expect(human.stdout()).toContain("integrated")
    expect(human.stdout()).toContain("TOUCHED")
    expect(human.stdout()).toContain("PATH")
    expect(human.stdout()).toContain(MERGED_SHA.slice(0, 12))
    expect(human.stdout()).toContain("file:///repo/.bays/B1")

    const show = outputIO()
    expect(await runYrd(app, yrd("contest", "show", "C1", "--json"), show.io)).toBe(0)
    expect(JSON.parse(show.stdout())).toMatchObject({ command: "contest.show", contest: { id: "C1" } })
    expect(await Array.fromAsync(app.events()).then((events) => events.length)).toBe(before)
  })

  it("runs a real task contest to durable evidence, then selects and promotes the exact winner", async () => {
    const baseResolutions: string[] = []
    const app = await createApp({ baseResolutions })
    const compete = outputIO()
    expect(
      await runYrd(app, yrd("task", "compete", "km:T1", "--agents", "ag codex/claude", "--json"), compete.io),
    ).toBe(0)
    expect(JSON.parse(compete.stdout())).toMatchObject({
      command: "task.compete",
      contest: { id: "C1", status: "ready", attemptOrder: ["A1", "A2"], base: "main", baseSha: BASE_SHA },
    })
    expect(baseResolutions).toEqual(["main"])

    const human = outputIO({ columns: 96, color: true })
    expect(await runYrd(app, yrd("contest", "show", "C1"), human.io)).toBe(0)
    expect(human.stdout()).toContain("ATTEMPT")
    expect(human.stdout()).toContain("AGENT")
    expect(human.stdout()).toContain("TIME")
    expect(human.stdout()).toContain("TOKENS")
    expect(human.stdout()).toContain("COST")
    expect(human.stdout()).toContain("codex")
    expect(human.stdout()).toContain("claude")

    const evaluate = outputIO()
    expect(await runYrd(app, yrd("contest", "evaluate", "C1", "--json"), evaluate.io)).toBe(0)
    expect(JSON.parse(evaluate.stdout())).toMatchObject({
      command: "contest.evaluate",
      contest: { id: "C1", status: "ready" },
    })

    const select = outputIO()
    expect(await runYrd(app, yrd("contest", "select", "C1", "--winner", "A1", "--json"), select.io)).toBe(0)
    expect(JSON.parse(select.stdout())).toMatchObject({ contest: { selection: { attempt: "A1", method: "manual" } } })

    const frozen = outputIO()
    expect(await runYrd(app, yrd("contest", "evaluate", "C1", "--retry"), frozen.io)).toBe(1)
    expect(frozen.stdout()).toBe("")
    expect(frozen.stderr()).toContain("evaluations are frozen")

    const promote = outputIO()
    expect(await runYrd(app, yrd("contest", "promote", "C1", "--json"), promote.io)).toBe(0)
    expect(JSON.parse(promote.stdout())).toMatchObject({
      command: "contest.promote",
      contest: { status: "promoted", promotion: { attempt: "A1", job: { status: "passed" } } },
    })
  })

  it("runs independent Bay, runner, and evaluator work concurrently within ordered reconciliation waves", async () => {
    const probe = overlapProbe()
    const app = await createApp({ probe })
    const compete = outputIO({ concurrency: 2 })

    expect(await runYrd(app, yrd("task", "compete", "km:T1", "--agents", "ag codex/claude"), compete.io)).toBe(0)
    expect(probe.max("bay")).toBe(2)
    expect(probe.max("runner")).toBe(2)
    expect(probe.max("evaluator")).toBe(2)
  })

  it("uses the documented exit taxonomy and keeps diagnostics off stdout", async () => {
    const app = await createApp()

    const usage = outputIO()
    expect(await runYrd(app, yrd("bay", "adopt", "old-branch"), usage.io)).toBe(2)
    expect(usage.stdout()).toBe("")
    expect(usage.stderr()).toContain("unknown command 'adopt'")

    const refusal = outputIO()
    expect(await runYrd(app, yrd("bay", "close", "missing"), refusal.io)).toBe(1)
    expect(refusal.stdout()).toBe("")
    expect(refusal.stderr()).toContain("no bay 'missing'")

    const unsupported = outputIO()
    expect(await runYrd(app, yrd("line", "provision"), unsupported.io)).toBe(2)
    expect(unsupported.stderr()).toContain("line.provision capability is not installed")

    const infrastructure = outputIO({
      resolveRevision: async () => {
        throw new Error("corrupt event log at row 4")
      },
    })
    expect(await runYrd(app, yrd("line", "status"), infrastructure.io)).toBe(3)
    expect(infrastructure.stdout()).toBe("")
    expect(infrastructure.stderr()).toContain("corrupt event log")
  })

  it("projects installed line administration and cancels an idle watch deterministically", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    await app.line.integrate({ prs: ["PR1"] }, { executor: "test", leaseMs: 60_000 })

    const coreAudit = outputIO()
    expect(await runYrd(app, yrd("line", "audit", "--json"), coreAudit.io)).toBe(0)
    expect(JSON.parse(coreAudit.stdout())).toMatchObject({ findings: [] })

    const services: YrdCliServices = {
      line: {
        auditEnvironment: async () => ({ findings: [{ code: "operator-finding", message: "inspect runner" }] }),
        provision: async (base?: string) => ({ base: base ?? "main", ready: true }),
        deprovision: async (base?: string) => ({ base: base ?? "main", released: true }),
      },
    }

    const provision = outputIO()
    expect(await runYrd(app, yrd("line", "provision", "release/2.0", "--json"), provision.io, services)).toBe(0)
    expect(JSON.parse(provision.stdout())).toEqual({
      base: "release/2.0",
      command: "line.provision",
      result: { base: "release/2.0", ready: true },
    })

    const audit = outputIO()
    expect(await runYrd(app, yrd("line", "audit", "--json"), audit.io, services)).toBe(1)
    expect(JSON.parse(audit.stdout())).toMatchObject({ findings: [{ code: "operator-finding" }] })

    const controller = new AbortController()
    const sleeps: number[] = []
    const watch = outputIO({
      scope: {
        signal: controller.signal,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds)
          controller.abort()
        },
      },
    })
    expect(await runYrd(app, yrd("line", "integrate", "--watch", "--interval", "1"), watch.io)).toBe(0)
    expect(watch.stdout()).toBe("")
    expect(sleeps).toEqual([1_000])
  })
})
