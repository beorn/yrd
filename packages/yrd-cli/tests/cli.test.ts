// @failure CLI projection diverges from installed Yrd capabilities or its documented process contract
// @level l2
// @consumer @yrd/cli

import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { createBayJobDefs, withBays, type BayWorkspace, type PR } from "@yrd/bay"
import { runYrd, type YrdCliIO, type YrdCliServices } from "@yrd/cli"
import { createMemoryJournal, createYrd, createYrdDef, EventSchema, JsonSchema, pipe, type JsonValue } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import {
  type LineRun,
  type LineSummary,
  withLine,
  withMerge,
  withStep,
  type AddStepResult,
  type PRShape,
  type StepExecution,
} from "@yrd/line"
import { withTasks } from "@yrd/task"
import { createElement, type ReactElement } from "react"
import { renderString } from "silvery"
import { run } from "silvery/runtime"
import {
  withContests,
  type AttemptRunOutput,
  type ContestEvaluatorDef,
  type ContestGit,
  type ContestRunnerDef,
} from "@yrd/contest"
import {
  LineShowView,
  LineLogView,
  LineWatchView,
  activeWatchRow,
  lineLogAttempts,
  lineLogRows,
  lineShowData,
  lineStatusRows,
  watchQueueRows,
  type LineLogCoverage,
  type LineStatusResult,
} from "../src/line-status-view.tsx"
import { withLiveRenderer } from "../src/live-renderer.ts"
import { LineWatchFrame, LineWatchPane, reduceWatchControl, type LineWatchPaneProps } from "../src/watch-pane.tsx"

const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "1".repeat(40)
const MERGED_SHA = "b".repeat(40)
const JOB_PREPARE_PASS_ID = "00000000-0000-7000-8000-000000000101"
const JOB_CHECK_FAILED_ID = "00000000-0000-7000-8000-000000000102"
const JOB_DEPLOY_LOST_ID = "00000000-0000-7000-8000-000000000103"
const JOB_CHECK_PASS_ID = "00000000-0000-7000-8000-000000000104"
const JOB_CHECK_MISSING_ID = "00000000-0000-7000-8000-000000000105"

type CheckedShape = AddStepResult<PRShape, "check", JsonValue>
type ProbeKind = "bay" | "runner" | "evaluator"
type OverlapProbe = {
  pause(kind: ProbeKind): Promise<void>
  max(kind: ProbeKind): number
}

function ids(): () => string {
  let value = 0
  return () => `00000000-0000-7000-8000-${String(++value).padStart(12, "0")}`
}

function stripOsc8Targets(value: string): string {
  const opener = "\u001b]8;;"
  const terminator = "\u001b\\"
  let cursor = 0
  let visible = ""
  while (cursor < value.length) {
    const start = value.indexOf(opener, cursor)
    if (start === -1) return visible + value.slice(cursor)
    visible += value.slice(cursor, start)
    const end = value.indexOf(terminator, start + opener.length)
    if (end === -1) return visible + value.slice(start)
    cursor = end + terminator.length
  }
  return visible
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
          headSha: options.refreshedHead ?? (input.bay === "B2" ? "2".repeat(40) : HEAD_SHA),
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

function contestAdapters(probe?: OverlapProbe, baseResolutions?: string[], waitingEvaluator?: string) {
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
    async evaluate(input) {
      await probe?.pause("evaluator")
      if (input.attempt === waitingEvaluator) {
        return {
          status: "waiting",
          token: `remote-evaluator-${input.attempt}`,
          url: `https://ci.invalid/evaluations/${input.attempt}`,
        }
      }
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
    waitingEvaluator?: string
    mergeRuns?: string[]
    failingCheck?: boolean
    checkFailure?: Readonly<{ code: string; message: string; artifact?: string }>
  } = {},
) {
  const contest = contestAdapters(options.probe, options.baseResolutions, options.waitingEvaluator)
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
        : options.checkFailure !== undefined
          ? {
              status: "failed",
              error: { code: options.checkFailure.code, message: options.checkFailure.message },
              output: {
                artifacts:
                  options.checkFailure.artifact === undefined
                    ? []
                    : [{ name: "failure", path: options.checkFailure.artifact }],
              },
            }
          : options.failingCheck
            ? { status: "failed", error: { code: "check-failed", message: "check failed" } }
            : { status: "passed", output: { checked: true } },
    { revision: "check-v1", output: JsonSchema },
  )
  const merge = withMerge(
    (_input: StepExecution<CheckedShape>): JobResult<{ commit: string; baseSha: string }> => {
      options.mergeRuns?.push("merge")
      return {
        status: "passed",
        output: { commit: MERGED_SHA, baseSha: MERGED_SHA },
      }
    },
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

function finishRemoteEvaluator(...args: string[]): string[] {
  return yrd(
    "contest",
    "finish",
    "C1",
    "--attempt",
    "A2",
    "--evaluator",
    "held-out",
    ...args,
    "--token",
    "remote-evaluator-A2",
  )
}

async function openAndSubmit(app: TestApp): Promise<void> {
  const open = outputIO()
  expect(await runYrd(app, yrd("bay", "open", "one"), open.io)).toBe(0)
  const submit = outputIO({ cwd: "/repo/.bays/B1" })
  expect(await runYrd(app, yrd("bay", "submit"), submit.io)).toBe(0)
}

function fakeJob(input: {
  id: string
  status: "requested" | "running" | "waiting" | "passed" | "failed" | "lost"
  attempt?: number
  requestedAt?: string
  startedAt?: string
  finishedAt?: string
  url?: string
  detail?: string
  checkpoint?: unknown
  error?: { code: string; message: string }
  output?: unknown
  artifacts?: readonly unknown[]
  lostReason?: string
}): LineRun["steps"][number]["job"] {
  const status = input.status
  return {
    id: input.id,
    definition: "line.step",
    revision: "test-v1",
    input: {},
    attempt: input.attempt ?? 1,
    requestedAt: input.requestedAt ?? "2026-07-09T12:00:00.000Z",
    changedAt: input.requestedAt ?? "2026-07-09T12:00:00.000Z",
    ...(status === "requested"
      ? {}
      : {
          startedAt: input.startedAt ?? "2026-07-09T12:00:00.000Z",
          executor: "line-test",
          leaseExpiresAt: "2026-07-09T12:00:10.000Z",
        }),
    ...(status === "waiting"
      ? {
          token: "run-job",
          detail: input.detail ?? "waiting for downstream",
          ...(input.url === undefined ? {} : { url: input.url }),
        }
      : {}),
    ...(status === "passed"
      ? {
          status,
          finishedAt: input.finishedAt ?? "2026-07-09T12:00:02.000Z",
          output: input.output ?? {},
          ...(input.url === undefined ? {} : { url: input.url }),
          ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
        }
      : {}),
    ...(status === "failed"
      ? {
          status,
          finishedAt: input.finishedAt ?? "2026-07-09T12:00:03.000Z",
          output: input.output ?? {},
          error: input.error ?? { code: "check-failed", message: "failed" },
          ...(input.url === undefined ? {} : { url: input.url }),
          ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
        }
      : {}),
    ...(status === "lost"
      ? {
          status,
          finishedAt: input.finishedAt ?? "2026-07-09T12:00:04.000Z",
          lostReason: input.lostReason ?? "lost while running",
          ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
        }
      : {}),
    ...(status === "running"
      ? {
          status,
          startedAt: input.startedAt ?? "2026-07-09T12:00:01.000Z",
          executor: "line-test",
          leaseExpiresAt: "2026-07-09T12:00:10.000Z",
          ...(input.url === undefined ? {} : { url: input.url }),
        }
      : {}),
    ...(status !== "passed" && status !== "failed" && status !== "lost" && status !== "running" && status !== "waiting"
      ? { status }
      : {}),
    ...(input.checkpoint === undefined || status === "requested" || status === "running"
      ? {}
      : { checkpoint: input.checkpoint }),
    ...(input.detail === undefined || status !== "passed" ? {} : { detail: input.detail }),
  } as LineRun["steps"][number]["job"]
}

function fakeStep(name: string, status: Parameters<typeof fakeJob>[0]["status"], job: LineRun["steps"][number]["job"]) {
  return {
    name,
    title: `${name} test step`,
    revision: "step-v1",
    integrates: false,
    needsIntegration: false,
    job,
  }
}

function fakeRun(input: {
  id: string
  base?: string
  pr?: { id: string; revision: number; headSha: string; baseSha?: string }
  status: "running" | "waiting" | "passed" | "failed"
  steps: readonly ReturnType<typeof fakeStep>[]
  startedAt: string
  finishedAt?: string
  parent?: string
  isolationPart?: 0 | 1
  integration?: { commit: string; baseSha: string }
  error?: { code: string; message: string }
  subject?: string
}): LineRun {
  const startedAt = input.startedAt
  return {
    id: input.id,
    prs: [
      {
        id: input.pr?.id ?? "PR1",
        branch: input.subject ?? `topic/${input.id}`,
        base: input.base ?? "main",
        revision: input.pr?.revision ?? 1,
        headSha: input.pr?.headSha ?? HEAD_SHA,
        ...(input.pr?.baseSha === undefined ? {} : { baseSha: input.pr?.baseSha }),
      },
    ],
    base: input.base ?? "main",
    steps: input.steps,
    startedAt,
    cursor: 0,
    integration: input.integration,
    shape: {
      results: {},
      ...(input.integration === undefined ? {} : { integration: input.integration }),
    },
    status: input.status,
    ...(input.parent === undefined ? {} : { parent: input.parent }),
    ...(input.isolationPart === undefined ? {} : { isolationPart: input.isolationPart }),
    ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
    ...(input.error === undefined ? {} : { error: input.error }),
  }
}

function fakeSummary(runs: readonly LineRun[]): LineSummary {
  return {
    base: runs[0]?.base ?? "main",
    running: [],
    waiting: [],
    finished: runs,
  }
}

function coverageFixture(path: string, frames = 185): LineLogCoverage {
  return {
    since: "2026-07-09T12:00:00.000Z",
    completeness: "queue-only",
    legacy: { path, frames },
  }
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
    expect(yrdHelp.stdout()).toContain("finish")
    expect(yrdHelp.stdout()).toContain("select")
    expect(yrdHelp.stdout()).toContain("promote")
    expect(yrdHelp.stdout()).not.toMatch(/^\s+run \[/mu)
    expect(yrdHelp.stdout()).not.toMatch(/^\s+help /mu)
  })

  it("uses concise layered help with examples on the root and line surfaces", async () => {
    const app = await createApp()
    const root = outputIO({ columns: 100 })
    expect(await runYrd(app, yrd("--help"), root.io)).toBe(0)
    expect(root.stdout()).toContain("software delivery orchestration")
    expect(root.stdout()).toContain("Help:")
    expect(root.stdout()).toContain("Yrd coordinates software work from task to delivery.")
    expect(root.stdout()).toContain("Examples:")
    expect(root.stdout()).toContain("$ yrd bay open fix --from topic")

    const line = outputIO({ columns: 100 })
    expect(await runYrd(app, yrd("line", "--help"), line.io)).toBe(0)
    expect(line.stdout()).toContain("manage integration lines")
    expect(line.stdout()).toMatch(/^\s+init \[options\] \[base\]\s+prepare line resources$/mu)
    expect(line.stdout()).toMatch(/^\s+deinit \[options\] \[base\]\s+release line resources$/mu)
    expect(line.stdout()).not.toMatch(/^\s+(?:provision|deprovision)\b/mu)
    expect(line.stdout()).toContain("Examples:")
    expect(line.stdout()).toContain("$ yrd line status release/2.0")
    expect(line.stdout()).toContain("$ yrd line integrate PR7 --steps check,merge")
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

  it("records tracker-neutral task and actor links when opening a bay", async () => {
    const app = await createApp()
    const output = outputIO({ color: true, columns: 96 })

    expect(
      await runYrd(
        app,
        yrd("bay", "open", "linked-work", "--task", "github:beorn/yrd#42", "--actor", "codex:apex"),
        output.io,
      ),
      output.stderr(),
    ).toBe(0)
    expect(app.state().bays.byId.B1).toMatchObject({
      name: "linked-work",
      task: "github:beorn/yrd#42",
      actor: "codex:apex",
    })
    expect(output.stdout()).toContain("TASK")
    expect(output.stdout()).toContain("github:beorn/yrd#42")
    expect(output.stdout()).toContain("ACTOR")
    expect(output.stdout()).toContain("codex:apex")
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

  it("submits and revises an existing source branch through the injected Git revision boundary", async () => {
    const app = await createApp()
    const resolved: string[] = []
    let resolvedHead = HEAD_SHA
    const resolveRevision = (ref: string) => {
      resolved.push(ref)
      return Promise.resolve(resolvedHead)
    }
    const submit = outputIO({ resolveRevision })
    expect(await runYrd(app, yrd("bay", "submit", "topic/direct", "--base", "release/2.0", "--json"), submit.io)).toBe(
      0,
    )
    expect(resolved).toEqual(["topic/direct"])
    expect(JSON.parse(submit.stdout())).toMatchObject({
      prs: [{ id: "PR1", branch: "topic/direct", base: "release/2.0", headSha: HEAD_SHA, status: "submitted" }],
    })

    resolvedHead = MERGED_SHA
    const revision = outputIO({ resolveRevision })
    expect(
      await runYrd(app, yrd("bay", "submit", "topic/direct", "--base", "release/2.0", "--json"), revision.io),
    ).toBe(0)
    expect(resolved).toEqual(["topic/direct", "topic/direct"])
    expect(JSON.parse(revision.stdout())).toMatchObject({
      prs: [
        {
          id: "PR1",
          branch: "topic/direct",
          revision: 2,
          headSha: MERGED_SHA,
          status: "submitted",
          revisions: [
            { revision: 1, headSha: HEAD_SHA },
            { revision: 2, headSha: MERGED_SHA },
          ],
        },
      ],
    })

    const human = outputIO({ columns: 64, resolveRevision })
    expect(await runYrd(app, yrd("bay", "submit", "topic/direct", "--base", "release/2.0"), human.io)).toBe(0)
    expect(human.stdout()).toContain("PR")
    expect(human.stdout()).toContain("STATUS")
    expect(human.stdout()).toContain("submitted")
    expect(human.stdout()).toContain("topic/direct")
    expect(human.stdout()).toContain("release/2.0")
  })

  it("closes a direct bayless PR through the `pr close` CLI without a bay", async () => {
    const app = await createApp()
    const resolveRevision = () => Promise.resolve(HEAD_SHA)

    const submit = outputIO({ resolveRevision })
    expect(await runYrd(app, yrd("bay", "submit", "topic/superseded", "--json"), submit.io), submit.stderr()).toBe(0)
    expect(JSON.parse(submit.stdout())).toMatchObject({ prs: [{ id: "PR1", status: "submitted" }] })

    const close = outputIO()
    expect(await runYrd(app, yrd("pr", "close", "PR1", "--json"), close.io), close.stderr()).toBe(0)
    expect(JSON.parse(close.stdout())).toMatchObject({
      command: "pr.close",
      prs: [{ id: "PR1", status: "withdrawn" }],
    })

    // A terminal PR refuses re-close with a nonzero exit — never a silent no-op.
    const again = outputIO()
    expect(await runYrd(app, yrd("pr", "close", "PR1"), again.io)).not.toBe(0)
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

  it("recovers an expired interrupted line lease without advancing to merge", async () => {
    const mergeRuns: string[] = []
    const app = await createApp({ mergeRuns, failingCheck: true })
    await openAndSubmit(app)
    expect((await app.line.integrate({ prs: ["PR1"] }, { executor: "first-runner", leaseMs: 60_000 }))[0]?.status).toBe(
      "failed",
    )
    expect(app.state().bays.prs.PR1).toMatchObject({ status: "rejected" })
    await app.dispatch(app.commands.line.integrate, { prs: ["PR1"], retry: true })

    const checkJob = app.line.get("R2")?.steps[0]?.job
    expect(checkJob?.status).toBe("requested")
    if (checkJob === undefined) throw new Error("expected requested check job")
    await app.dispatch(app.commands.job.transition, {
      type: "start",
      id: checkJob.id,
      attempt: 1,
      executor: "interrupted-runner",
      leaseExpiresAt: "2026-07-09T12:00:01.000Z",
    })
    expect(app.line.get("R2")?.status).toBe("running")

    const recover = outputIO({ now: () => Date.parse("2026-07-09T12:00:02.000Z") })
    expect(
      await runYrd(app, yrd("line", "recover", "--reason", "runner interrupted", "--json"), recover.io),
      recover.stderr(),
    ).toBe(0)
    expect(JSON.parse(recover.stdout())).toMatchObject({
      command: "line.recover",
      results: [{ id: "R2", status: "failed", steps: [{ job: { status: "lost" } }, {}] }],
    })
    expect(app.state().bays.prs.PR1).toMatchObject({ status: "rejected" })
    expect(app.line.get("R2")?.steps[1]?.job).toBeUndefined()
    expect(mergeRuns).toEqual([])
  })

  it("records an external failing verdict successfully while the line run becomes failed", async () => {
    const temp = mkdtempSync(join(tmpdir(), "yrd-external-verdict-"))
    const artifact = join(temp, "private-tests.log")
    writeFileSync(artifact, "private tests failed\n")
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
          `report=${artifact}`,
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
    expect(status.stdout()).toContain(pathToFileURL(artifact).href)
    rmSync(temp, { recursive: true, force: true })
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

  it("persists and releases line holds through the operator CLI", async () => {
    const app = await createApp()
    await app.bays.submit({ branch: "task/blocked", headSha: "1".repeat(40), base: "main" })
    await app.bays.submit({ branch: "task/allowed", headSha: "2".repeat(40), base: "main" })
    const hold = outputIO()

    expect(
      await runYrd(
        app,
        yrd("line", "hold", "main", "--reason", "operator freeze", "--allow", "PR2", "--json"),
        hold.io,
      ),
    ).toBe(0)
    expect(JSON.parse(hold.stdout())).toMatchObject({
      command: "line.hold",
      hold: { base: "main", reason: "operator freeze", allowedPRs: ["PR2"] },
    })

    const blocked = outputIO()
    expect(await runYrd(app, yrd("line", "integrate", "PR1", "--json"), blocked.io)).toBe(1)
    expect(blocked.stderr()).toContain("line 'main' is held: operator freeze")
    expect(app.state().lines.records).toEqual({})

    const eligible = outputIO()
    expect(await runYrd(app, yrd("line", "integrate", "--json"), eligible.io), eligible.stderr()).toBe(0)
    expect(JSON.parse(eligible.stdout())).toMatchObject({ results: [{ prs: [{ id: "PR2" }], status: "passed" }] })
    expect(app.state().bays.prs.PR1?.status).toBe("submitted")
    expect(app.state().bays.prs.PR2?.status).toBe("integrated")

    const status = outputIO()
    expect(await runYrd(app, yrd("line", "status", "--json"), status.io)).toBe(0)
    expect(JSON.parse(status.stdout())).toMatchObject({
      results: [{ base: "main", hold: { reason: "operator freeze", allowedPRs: ["PR2"] } }],
    })

    const humanStatus = outputIO({ columns: 100 })
    expect(await runYrd(app, yrd("line", "status"), humanStatus.io)).toBe(0)
    expect(humanStatus.stdout()).toContain("HOLD")
    expect(humanStatus.stdout()).toContain("operator freeze")
    expect(humanStatus.stdout()).toContain("PR2")

    const release = outputIO()
    expect(await runYrd(app, yrd("line", "release", "main", "--json"), release.io)).toBe(0)
    expect(JSON.parse(release.stdout())).toEqual({ command: "line.release", base: "main" })
    expect(app.line.status("main").hold).toBeUndefined()
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
    await app.dispatch(app.commands.task.compete, {
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

  it("mounts watch as one read-only queue-focused live pane", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    const before = await Array.fromAsync(app.events()).then((events) => events.length)

    let mounted: ReactElement | undefined
    const watch = outputIO({
      now: () => Date.parse("2026-07-09T12:01:00.000Z"),
    })
    const io = withLiveRenderer(watch.io, async (element) => {
      mounted = element
    })
    expect(await runYrd(app, yrd("watch"), io)).toBe(0)
    expect(watch.stdout()).toBe("")
    expect(mounted?.type).toBe(LineWatchPane)
    const props = mounted?.props as LineWatchPaneProps
    expect(props.intervalMs).toBe(1_000)
    const frame = stripOsc8Targets(
      await renderString(createElement(LineWatchFrame, { snapshot: props.initial, paused: false })),
    )
    expect(frame).toContain("LINE")
    expect(frame).toContain("OPEN")
    expect(frame).toContain("ACTIVE")
    expect(frame).toContain("INTEGRATED")
    expect(frame).toContain("REJECTED")
    expect(frame).toContain("POS")
    expect(frame).toContain("PR1")
    expect(frame).toContain("LIVE")
    expect(frame).toContain("p pause")
    expect(frame).toContain("q quit")
    expect(frame).not.toContain("PATH")
    expect(frame).not.toContain("file:///repo/.bays/B1")
    expect(await Array.fromAsync(app.events()).then((events) => events.length)).toBe(before)
  })

  it("renders hold and drain health in watch output", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    await app.line.hold({ base: "main", reason: "operator freeze", allowedPRs: [] })

    let mounted: ReactElement | undefined
    const watch = outputIO({
      now: () => Date.parse("2026-07-09T12:01:00.000Z"),
    })
    const io = withLiveRenderer(watch.io, async (element) => {
      mounted = element
    })
    expect(await runYrd(app, yrd("watch"), io)).toBe(0)
    const props = mounted?.props as LineWatchPaneProps
    const frame = stripOsc8Targets(await renderString(createElement(LineWatchView, props.initial)))
    expect(frame).toContain("HOLD")
    expect(frame).toContain("operator freeze")
    expect(frame).toContain("DRAIN")
  })

  it("projects watch controls, oldest-open drain age, and the active spotlight", () => {
    expect(reduceWatchControl({ paused: false }, "p")).toEqual({ paused: true })
    expect(reduceWatchControl({ paused: true }, "p")).toEqual({ paused: false })
    expect(reduceWatchControl({ paused: false }, "q")).toBe("exit")

    const result = {
      base: "main",
      prs: [
        {
          id: "PR1",
          name: "Watch the queue",
          branch: "task/watch",
          base: "main",
          status: "submitted",
          submittedAt: "2026-07-09T12:00:00.000Z",
        },
      ],
      running: [
        {
          id: "R1",
          status: "running",
          startedAt: "2026-07-09T12:09:00.000Z",
          prs: [{ id: "PR1" }],
          steps: [{ name: "review" }],
        },
      ],
      waiting: [],
      finished: [],
    } as unknown as LineStatusResult
    const now = Date.parse("2026-07-09T12:10:00.000Z")

    expect(watchQueueRows(result, now)[0]).toMatchObject({ age: "10m", touched: "1m" })
    expect(activeWatchRow(result, now)).toMatchObject({
      run: "R1",
      pr: "PR1",
      subject: "Watch the queue",
      step: "review",
      elapsed: "1m",
    })
  })

  it("falls back to job status when a watch queue job carries no evidence detail", () => {
    const result = {
      base: "main",
      prs: [
        {
          id: "PR1",
          name: "Watch the queue",
          branch: "task/watch",
          base: "main",
          status: "submitted",
          submittedAt: "2026-07-09T12:00:00.000Z",
        },
      ],
      running: [],
      waiting: [
        {
          id: "R1",
          status: "waiting",
          startedAt: "2026-07-09T12:09:00.000Z",
          prs: [{ id: "PR1" }],
          steps: [{ name: "check", job: { status: "waiting", detail: undefined } }],
        },
      ],
      finished: [],
    } as unknown as LineStatusResult

    expect(watchQueueRows(result, Date.parse("2026-07-09T12:10:00.000Z"))[0]).toMatchObject({
      step: "check",
      result: "waiting",
    })
  })

  it("names the failing job reason for each recent watch failure", async () => {
    const result = {
      base: "main",
      prs: [
        {
          id: "PR1",
          name: "Watch the queue",
          branch: "task/watch",
          base: "main",
          status: "rejected",
          submittedAt: "2026-07-09T12:00:00.000Z",
        },
      ],
      running: [],
      waiting: [],
      finished: [
        {
          id: "R1",
          status: "failed",
          startedAt: "2026-07-09T12:00:00.000Z",
          finishedAt: "2026-07-09T12:01:00.000Z",
          prs: [{ id: "PR1" }],
          steps: [{ name: "check", job: { status: "lost", lostReason: "lease expired" } }],
        },
        {
          id: "R2",
          status: "failed",
          startedAt: "2026-07-09T12:02:00.000Z",
          finishedAt: "2026-07-09T12:03:00.000Z",
          prs: [{ id: "PR1" }],
          steps: [{ name: "check", job: { status: "failed", error: { message: "cold typecheck" } } }],
        },
      ],
    } as unknown as LineStatusResult

    const frame = stripOsc8Targets(
      await renderString(
        createElement(LineWatchView, { results: [result], now: Date.parse("2026-07-09T12:10:00.000Z") }),
        { width: 120 },
      ),
    )
    expect(frame).toContain("Recent failures")
    expect(frame).toContain("lease expired")
    expect(frame).toContain("cold typecheck")
  })

  it("handles pause and quit inside the live Silvery runtime", async () => {
    const initial = {
      results: [
        {
          base: "main",
          headSha: "a".repeat(40),
          prs: [],
          running: [],
          waiting: [],
          finished: [],
        } as unknown as LineStatusResult,
      ],
      now: 0,
    }
    const handle = await run(
      createElement(LineWatchPane, {
        initial,
        load: async () => initial,
        intervalMs: 60_000,
      }),
      { writable: { write: () => {} }, cols: 40, rows: 8 },
    )
    try {
      expect(handle.text).toContain("LINE")
      expect(handle.text).toContain("main")
      expect(handle.text).toContain("HOLD")
      expect(handle.text).toContain("DRAIN")
      expect(handle.text).toContain("LIVE")
      await handle.press("p")
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("PAUSED")

      const exited = handle.waitUntilExit()
      await handle.press("q")
      await exited
    } finally {
      handle.unmount()
    }
  })

  it("monitors line status continuously from root watch", async () => {
    const app = await createApp()
    await openAndSubmit(app)

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
    expect(await runYrd(app, yrd("watch", "--json"), watch.io)).toBe(0)
    expect(watch.stdout()).toContain('"command":"watch"')
    expect(watch.stdout()).toContain('"base":"main"')
    expect(watch.stdout()).toContain('"id":"PR1"')
    expect(sleeps).toEqual([1_000])
  })

  it("keeps the line summary readable at 40 columns and bounded at 120 and 240 columns", async () => {
    const app = await createApp()

    const renderStatus = async (columns: number): Promise<string> => {
      const status = outputIO({
        columns,
        resolveRevision: async () => "3".repeat(40),
      })
      expect(await runYrd(app, yrd("line", "status"), status.io), status.stderr()).toBe(0)
      return status.stdout()
    }

    const narrow = await renderStatus(40)
    const narrowLines = narrow.split("\n")
    const narrowHeader = narrowLines.find((line) => line.startsWith("LINE"))
    expect(narrowHeader).toBe("LINE    OPEN ACTIVE INTEGRATED  REJECTED")
    expect(Math.max(...narrowLines.map((line) => line.length))).toBeLessThanOrEqual(40)

    const standardLines = (await renderStatus(120)).split("\n")
    expect(Math.max(...standardLines.map((line) => line.length))).toBeLessThanOrEqual(120)

    const wideLines = (await renderStatus(240)).split("\n")
    const wideHeader = wideLines.find((line) => line.startsWith("LINE"))
    const wideSummary = wideLines.find((line) => line.startsWith("main@"))
    expect(wideHeader).toBeDefined()
    expect(wideSummary).toBeDefined()
    expect(Math.max(...wideLines.map((line) => line.length))).toBeLessThanOrEqual(120)
    expect(wideHeader).toBe("LINE                    OPEN ACTIVE INTEGRATED  REJECTED")
    expect(wideSummary).toBe("main@333333333333          0      0          0         0")
    expect(wideHeader?.trimEnd().length).toBeLessThan(64)
    expect(wideSummary?.trimEnd().length).toBe(wideHeader?.trimEnd().length)
  })

  it.fails("projects runnable work and bounded rejection evidence without stale holds or unsafe retry teaching", async () => {
    const temp = mkdtempSync("/tmp/yrd-output-polish-")
    const artifact = join(temp, "failure.log")
    const failure = [
      "PR 'PR1' could not be applied: hint: Recursive merging with submodules currently only supports trivial cases.",
      "hint: Please manually handle the merging of each conflicted submodule.",
      "hint: This can be accomplished with the following steps:",
      "hint:   git add vendor/yrd",
      "hint:   git commit",
      "    at applyCandidate (/repo/packages/yrd-line/src/command.ts:404:12)",
    ].join("\n")
    writeFileSync(artifact, `${failure}\n`)
    const app = await createApp({ checkFailure: { code: "apply-conflict", message: failure, artifact } })
    await app.bays.submit({
      branch: "task/failing",
      name: "fix(cli): bound operator failures",
      headSha: HEAD_SHA,
      base: "main",
      baseSha: BASE_SHA,
    })
    expect((await app.line.integrate({ prs: ["PR1"] }, { executor: "test", leaseMs: 60_000 }))[0]?.status).toBe(
      "failed",
    )
    const resolveLineTarget = async () => ({ base: "main", sha: BASE_SHA })
    const now = () => Date.parse("2026-07-09T12:01:00.000Z")
    const rejectedOnly = outputIO({ columns: 120, now, resolveLineTarget })
    expect(await runYrd(app, yrd("line", "status"), rejectedOnly.io), rejectedOnly.stderr()).toBe(0)
    expect.soft(rejectedOnly.stdout()).toMatch(/main@[a-f0-9]{12}\s+0\s+0\s+0\s+1/u)

    await app.bays.submit({
      branch: "task/runnable",
      name: "feat(cli): keep runnable work visible",
      headSha: "2".repeat(40),
      base: "origin/main",
      baseSha: BASE_SHA,
    })

    // Historical aliases can retain a hold after the canonical line was released.
    await app.line.hold({ base: "origin/main", reason: "released maintenance", allowedPRs: [] })
    await app.line.release("main")

    for (const columns of [80, 120]) {
      const status = outputIO({ columns, now, resolveLineTarget })
      expect(await runYrd(app, yrd("line", "status"), status.io), status.stderr()).toBe(0)
      const lines = status.stdout().trimEnd().split("\n")
      expect.soft(lines.length).toBeLessThanOrEqual(14)
      expect.soft(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(columns)
      expect.soft(status.stdout()).toMatch(/main@[a-f0-9]{12}\s+1\s+0\s+0\s+1/u)
      expect.soft(status.stdout()).toContain("feat(cli): keep runnable work visible")
      expect.soft(status.stdout()).toContain("fix(cli): bound operator failures")
      expect.soft(status.stdout()).toContain("[!]")
      expect.soft(status.stdout()).toContain("apply-conflict: PR 'PR1' could not be applied")
      expect.soft(status.stdout()).toContain(`evidence: ${artifact}`)
      expect.soft(status.stdout()).toContain("next: fix task/failing; yrd bay submit task/failing --base main")
      expect.soft(status.stdout()).not.toContain("hint:")
      expect.soft(status.stdout()).not.toContain("released maintenance")
      expect.soft(status.stdout()).not.toContain("yrd line integrate PR1 --retry")
    }
    const tty = outputIO({ columns: 80, color: true, now, resolveLineTarget })
    expect(await runYrd(app, yrd("line", "status"), tty.io), tty.stderr()).toBe(0)
    expect.soft(tty.stdout()).toContain(pathToFileURL(artifact).href)

    let mounted: ReactElement | undefined
    const watch = outputIO({ now, resolveLineTarget })
    const live = withLiveRenderer(watch.io, async (element) => {
      mounted = element
    })
    expect(await runYrd(app, yrd("watch"), live), watch.stderr()).toBe(0)
    if (mounted === undefined) throw new Error("expected watch pane to mount")
    const snapshot = (mounted.props as LineWatchPaneProps).initial
    expect.soft(snapshot.results[0]?.hold).toBeUndefined()
    expect.soft(watchQueueRows(snapshot.results[0]!, now()).map((row) => row.pr)).toEqual(["PR2"])
    for (const width of [80, 120]) {
      const frame = await renderString(createElement(LineWatchView, snapshot), { width, height: 24, plain: true })
      const lines = frame.trimEnd().split("\n")
      expect.soft(lines.length).toBeLessThanOrEqual(16)
      expect.soft(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(width)
      expect.soft(frame).toContain("OPEN 1")
      expect.soft(frame).toContain("feat(cli): keep runnable work visible")
      expect.soft(frame).toContain("apply-conflict: PR 'PR1' could not be applied")
      expect.soft(frame).toContain(`evidence: ${artifact}`)
      expect.soft(frame).toContain("next: fix task/failing; yrd bay submit task/failing --base main")
      expect.soft(frame).not.toContain("released maintenance")
      expect.soft(frame).not.toContain("hint:")
      expect.soft(frame).not.toContain("yrd line integrate PR1 --retry")
    }

    const json = outputIO({ now, resolveLineTarget })
    expect(await runYrd(app, yrd("line", "status", "--json"), json.io), json.stderr()).toBe(0)
    const parsed = JSON.parse(json.stdout()) as { results: readonly LineStatusResult[] }
    expect.soft(parsed.results[0]?.hold).toBeUndefined()
    expect(parsed.results[0]?.finished[0]?.error?.message).toBe(failure)
    expect(parsed.results[0]?.finished[0]?.steps[0]?.job).toMatchObject({
      output: { artifacts: [{ name: "failure", path: artifact }] },
    })
    rmSync(temp, { recursive: true, force: true })
  })

  it.fails("spotlights the active run in bounded status output", async () => {
    const app = await createApp({ waitingCheck: true })
    await app.bays.submit({
      branch: "task/active",
      name: "fix(cli): show the active queue check",
      headSha: HEAD_SHA,
      base: "main",
      baseSha: BASE_SHA,
    })
    expect((await app.line.integrate({ prs: ["PR1"] }, { executor: "test", leaseMs: 60_000 }))[0]?.status).toBe(
      "waiting",
    )

    for (const columns of [80, 120]) {
      const status = outputIO({
        columns,
        now: () => Date.parse("2026-07-09T12:01:00.000Z"),
        resolveLineTarget: async () => ({ base: "main", sha: BASE_SHA }),
      })
      expect(await runYrd(app, yrd("line", "status"), status.io), status.stderr()).toBe(0)
      expect(status.stdout()).toContain("ACTIVE R1 PR1 fix(cli): show the active queue check")
      expect(
        Math.max(
          ...status
            .stdout()
            .split("\n")
            .map((line) => line.length),
        ),
      ).toBeLessThanOrEqual(columns)
    }
  })

  it("projects local and remote spellings of one target as a single logical line", async () => {
    const app = await createApp()
    await app.bays.submit({ branch: "task/one", headSha: "1".repeat(40), base: "main" })
    await app.bays.submit({ branch: "task/two", headSha: "2".repeat(40), base: "origin/main" })
    const status = outputIO({
      resolveLineTarget: (ref) => Promise.resolve({ base: ref === "origin/main" ? "main" : ref, sha: "a".repeat(40) }),
    })

    expect(await runYrd(app, yrd("line", "status", "--json"), status.io), status.stderr()).toBe(0)

    expect(JSON.parse(status.stdout())).toMatchObject({
      results: [{ base: "main", headSha: "a".repeat(40), prs: [{ id: "PR1" }, { id: "PR2" }] }],
    })
  })

  it("streams terminal log rows with stable revision/SHA proof and scope options", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    expect(await runYrd(app, yrd("line", "integrate", "PR1"), outputIO().io)).toBe(0)

    const scoped = outputIO()
    expect(await runYrd(app, yrd("line", "log", "--base", "main", "--pr", "PR1", "--json"), scoped.io)).toBe(0)
    const parsed = JSON.parse(scoped.stdout()) as {
      command: string
      rows: ReturnType<typeof lineLogRows>
    }
    expect(parsed.command).toBe("line.log")
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.rows[0]).toMatchObject({
      run: "R1",
      pr: "PR1",
      base: "main",
      revision: "1",
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      outcome: "integrated",
    })
    expect(parsed.rows[0]).not.toHaveProperty("location")

    const human = outputIO({ color: true, columns: 120 })
    expect(await runYrd(app, yrd("line", "log", "--base", "main"), human.io)).toBe(0)
    expect(human.stdout()).toContain("RUN")
    expect(human.stdout()).toContain("OUTCOME")
    expect(human.stdout()).toContain("PR1")
    expect(human.stdout()).toContain("integrated")
  })

  it("shows run proof slices, revisions, timings, evidence, checkpoint, and landing proof", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    expect(await runYrd(app, yrd("line", "integrate", "PR1"), outputIO().io)).toBe(0)

    const human = outputIO({ color: true, columns: 200 })
    expect(await runYrd(app, yrd("line", "show", "R1"), human.io)).toBe(0)
    expect(human.stdout()).toContain("RUN")
    expect(human.stdout()).toContain("STEP")
    expect(human.stdout()).toContain("REV")
    expect(human.stdout()).toContain("OUTPUT")
    expect(human.stdout()).toContain("CHECKPOINT")
    expect(human.stdout()).toContain("EVIDENCE")
    expect(human.stdout()).toContain("LANDING")
    expect(human.stdout()).toContain("check")

    const json = outputIO()
    expect(await runYrd(app, yrd("line", "show", "R1", "--json"), json.io)).toBe(0)
    const parsed = JSON.parse(json.stdout()) as {
      command: string
      run: ReturnType<typeof lineShowData>
    }
    expect(parsed.command).toBe("line.show")
    expect(parsed.run.run).toBe("R1")
    expect(parsed.run.steps).toHaveLength(2)
    expect(parsed.run.steps[0]).toMatchObject({
      step: "check",
      revision: "check-v1",
      status: "passed",
    })
    expect(parsed.run.steps[0]).toHaveProperty("detail")
    expect(parsed.run.steps[0]).toHaveProperty("output")
    expect(parsed.run.steps[0]).toHaveProperty("landing")
  })

  it("maps the 10-row line log/show contract matrix directly from canonical fields", async () => {
    const temp = mkdtempSync(join(tmpdir(), "yrd-legacy-log-"))
    const artifacts = join(temp, "artifacts")
    const attemptOne = join(artifacts, "attempt-1", "output.log")
    const attemptTwo = join(artifacts, "attempt-2", "output.log")
    const missingArtifact = join(artifacts, "attempt-missing", "output.log")
    mkdirSync(artifacts, { recursive: true })
    mkdirSync(join(artifacts, "attempt-1"), { recursive: true })
    mkdirSync(join(artifacts, "attempt-2"), { recursive: true })
    mkdirSync(join(artifacts, "attempt-missing"), { recursive: true })
    writeFileSync(attemptOne, "attempt one\n")
    writeFileSync(attemptTwo, "attempt two\n")

    const runChronologyFailure = fakeRun({
      id: "R10",
      status: "failed",
      startedAt: "2026-07-10T10:00:00.000Z",
      finishedAt: "2026-07-10T10:00:02.000Z",
      pr: { id: "PR1", revision: 2, headSha: "c".repeat(40), baseSha: BASE_SHA },
      steps: [
        fakeStep("prepare", "passed", fakeJob({ id: JOB_PREPARE_PASS_ID, status: "passed", attempt: 1 })),
        fakeStep(
          "check",
          "failed",
          fakeJob({
            id: JOB_CHECK_FAILED_ID,
            status: "failed",
            attempt: 1,
            error: { code: "check-failed", message: "policy mismatch" },
            output: {
              exitCode: 1,
              durationMs: 2_500,
              configHash: "0".repeat(64),
              detail: "full command diagnostic",
              artifacts: [
                { name: "stdout", path: attemptOne },
                { name: "stderr", path: attemptTwo },
              ],
            },
          }),
        ),
        fakeStep(
          "deploy",
          "lost",
          fakeJob({ id: JOB_DEPLOY_LOST_ID, status: "lost", attempt: 1, lostReason: "worker died" }),
        ),
      ],
    })

    const runRetryAttemptTwo = fakeRun({
      id: "R2",
      status: "passed",
      parent: "R10",
      isolationPart: 1,
      startedAt: "2026-07-10T12:00:00.000Z",
      finishedAt: "2026-07-10T12:00:03.000Z",
      pr: { id: "PR1", revision: 2, headSha: "c".repeat(40), baseSha: BASE_SHA },
      integration: { commit: "d".repeat(40), baseSha: "e".repeat(40) },
      steps: [
        fakeStep(
          "check",
          "passed",
          fakeJob({
            id: JOB_CHECK_PASS_ID,
            status: "passed",
            attempt: 2,
            requestedAt: "2026-07-10T12:00:00.000Z",
            startedAt: "2026-07-10T12:00:01.000Z",
            finishedAt: "2026-07-10T12:00:03.000Z",
            url: "https://ci.invalid/check",
            output: {
              artifacts: [{ uri: attemptTwo }],
            },
            checkpoint: { baseSha: BASE_SHA, candidateSha: "c".repeat(40) },
            detail: "recheck",
            artifacts: [{ uri: attemptTwo }],
          }),
        ),
      ],
    })

    const runMissingLocation = fakeRun({
      id: "R3",
      status: "passed",
      pr: { id: "PR1", revision: 3, headSha: "f".repeat(40), baseSha: BASE_SHA },
      startedAt: "2026-07-10T11:00:00.000Z",
      finishedAt: "2026-07-10T11:00:01.000Z",
      integration: { commit: "g".repeat(40), baseSha: "h".repeat(40) },
      steps: [
        fakeStep(
          "check",
          "passed",
          fakeJob({ id: JOB_CHECK_MISSING_ID, status: "passed", artifacts: [{ path: missingArtifact }] }),
        ),
      ],
    })

    const summary = fakeSummary([runChronologyFailure, runRetryAttemptTwo, runMissingLocation])
    const statusByPr = new Map<string, PR["status"]>([
      ["PR1", "integrated"],
      ["PR-retired", "withdrawn"],
    ])
    const rows = lineLogRows([summary], new Set<string>(), undefined, statusByPr)
    const prRows = rows.filter((row) => row.pr === "PR1")
    const revision2Rows = prRows.filter((row) => row.revision === "2")

    expect(revision2Rows.map((row) => row.run)).toEqual(["R10", "R2"])
    expect(revision2Rows[0]).toMatchObject({
      outcome: "rejected",
      error: "policy mismatch",
      retries: "1",
      parent: "-",
      durationMs: 2_000,
      locations: [
        { label: "stdout", location: { path: attemptOne } },
        { label: "stderr", location: { path: attemptTwo } },
      ],
    })
    expect(revision2Rows[0]?.location).toMatchObject({ path: attemptOne })
    expect(revision2Rows[1]).toMatchObject({
      outcome: "integrated",
      retries: "2",
      parent: "R10",
      isolationPart: "1",
      integration: { commit: "d".repeat(40), baseSha: "e".repeat(40) },
      location: { path: attemptTwo },
    })
    expect(prRows.find((row) => row.run === "R3")?.location).toBeUndefined()

    const statusPr: PR = {
      id: "PR1",
      branch: "topic/R3",
      base: "main",
      status: "submitted",
      revision: 3,
      headSha: "f".repeat(40),
      baseSha: BASE_SHA,
      revisions: [
        {
          revision: 3,
          headSha: "f".repeat(40),
          base: "main",
          baseSha: BASE_SHA,
          pushedAt: "2026-07-10T10:59:00.000Z",
        },
      ],
      submittedAt: "2026-07-10T10:59:00.000Z",
    }
    const statusRows = lineStatusRows(
      { byId: {}, prs: { PR1: statusPr }, receipts: {} },
      { ...fakeSummary([runMissingLocation]), prs: [statusPr] },
      new Set(),
      Date.parse("2026-07-10T12:01:00.000Z"),
    )
    expect(statusRows[0]).toMatchObject({ artifactCount: 1 })
    expect(statusRows[0]).not.toHaveProperty("artifact")

    const failureShow = lineShowData(runChronologyFailure, [runChronologyFailure, runRetryAttemptTwo])
    expect(failureShow).toMatchObject({
      durationMs: 2_000,
      prs: [{ id: "PR1", revision: 2, headSha: "c".repeat(40), baseSha: BASE_SHA }],
    })
    expect(failureShow.steps).toHaveLength(3)
    expect(failureShow.steps[1]).toMatchObject({
      status: "failed",
      attempt: "1",
      error: "policy mismatch",
      detail: "full command diagnostic",
      durationMs: 3_000,
      location: { path: attemptOne },
      locations: [
        { label: "stdout", location: { path: attemptOne } },
        { label: "stderr", location: { path: attemptTwo } },
      ],
    })
    expect(failureShow.steps[2]).toMatchObject({ status: "lost", lost: "worker died" })

    const missingShow = lineShowData(runMissingLocation, [runMissingLocation])
    expect(missingShow.steps[0]).not.toHaveProperty("location")

    const retiredRows = lineLogRows([summary], new Set(["PR-retired"]), "PR-retired", statusByPr)
    expect(retiredRows).toHaveLength(1)
    expect(retiredRows[0]).toMatchObject({ outcome: "retired", run: "-", pr: "PR-retired" })
    expect(prRows.some((row) => row.outcome === "retired")).toBe(false)

    const show = lineShowData(runRetryAttemptTwo, [runChronologyFailure, runRetryAttemptTwo, runMissingLocation])
    expect(show).toMatchObject({
      run: "R2",
      retries: 2,
      integration: { commit: "d".repeat(40), baseSha: "e".repeat(40) },
      parent: "R10",
      isolationPart: "1",
    })
    expect(show.steps[0]).toMatchObject({
      step: "check",
      attempt: "2",
      status: "passed",
      uuid: JOB_CHECK_PASS_ID,
      evidence: {
        url: "https://ci.invalid/check",
        artifacts: [{ uri: attemptTwo }],
      },
      location: { path: attemptTwo },
      checkpoint: `base:${BASE_SHA.slice(0, 12)} candidate:${"c".repeat(40).slice(0, 12)}`,
    })

    const journal = join(temp, ".git", "bay", "journal.jsonl")
    mkdirSync(join(temp, ".git", "bay"), { recursive: true })
    writeFileSync(
      journal,
      Array.from({ length: 185 }, (_value, index) =>
        JSON.stringify({ ts: `2026-07-01T12:00:${String(index).padStart(2, "0")}.000Z` }),
      ).join("\n"),
    )

    execFileSync("git", ["init", "-q", temp])
    const coverageApp = await createApp()
    await openAndSubmit(coverageApp)
    const liveLog = outputIO({ cwd: temp })
    expect(await runYrd(coverageApp, yrd("line", "log", "--json"), liveLog.io), liveLog.stderr()).toBe(0)
    expect((JSON.parse(liveLog.stdout()) as { coverage: LineLogCoverage }).coverage).toMatchObject({
      since: "2026-07-09T12:00:00.000Z",
      completeness: "queue-only",
      legacy: { path: join(realpathSync(temp), ".git", "bay", "journal.jsonl"), frames: 185 },
    })

    const withCoverage = coverageFixture(journal, 185)
    const renderedLogWithCoverage = await renderString(createElement(LineLogView, { rows, coverage: withCoverage }), {
      width: 140,
      height: 24,
    })
    expect(renderedLogWithCoverage).toContain("Legacy queue coverage")
    expect(renderedLogWithCoverage).toContain("185")
    expect(renderedLogWithCoverage).toContain("R10")
    expect(renderedLogWithCoverage).toContain("c".repeat(12))
    expect(renderedLogWithCoverage).not.toContain("c".repeat(40))

    const renderedLogNoCoverage = await renderString(createElement(LineLogView, { rows }), {
      width: 140,
      height: 24,
    })
    expect(renderedLogNoCoverage).not.toContain("Legacy queue coverage")
    expect(renderedLogNoCoverage).not.toContain(missingArtifact)

    const ttyLog = await renderString(createElement(LineLogView, { rows, coverage: withCoverage }), {
      width: 140,
      height: 24,
      plain: false,
    })
    const plainLog = await renderString(createElement(LineLogView, { rows, coverage: withCoverage }), {
      width: 140,
      height: 24,
      plain: true,
    })
    expect(ttyLog).toContain("\u001b]8;;")
    expect(ttyLog).toContain(pathToFileURL(attemptOne).href)
    expect(ttyLog).toContain(pathToFileURL(attemptTwo).href)
    expect(ttyLog).toContain("https://ci.invalid/check")
    expect(plainLog).not.toContain("\u001b]8;;")
    const coverageOnlyTty = await renderString(createElement(LineLogView, { rows: [], coverage: withCoverage }), {
      width: 140,
      height: 4,
      plain: false,
    })
    expect(coverageOnlyTty).toContain("\u001b]8;;")
    expect(JSON.parse(JSON.stringify({ command: "line.log", rows, coverage: withCoverage }))).toEqual({
      command: "line.log",
      rows,
      coverage: withCoverage,
    })

    const renderedShow = await renderString(createElement(LineShowView, { data: show }), { width: 140, height: 40 })
    expect(renderedShow).toContain("check")
    expect(renderedShow).not.toContain(JOB_CHECK_PASS_ID)
    const ttyShow = await renderString(createElement(LineShowView, { data: show }), {
      width: 140,
      height: 40,
      plain: false,
    })
    const plainShow = await renderString(createElement(LineShowView, { data: show }), {
      width: 140,
      height: 40,
      plain: true,
    })
    expect(ttyShow).toContain("\u001b]8;;")
    expect(ttyShow).toContain(pathToFileURL(attemptTwo).href)
    expect(ttyShow).toContain("https://ci.invalid/check")
    expect(plainShow).not.toContain("\u001b]8;;")
    const lineShowJson = JSON.parse(JSON.stringify(show)) as typeof show
    expect(lineShowJson.steps[0]).toMatchObject({
      uuid: JOB_CHECK_PASS_ID,
      attempt: "2",
      duration: "2.0s",
    })

    rmSync(temp, { recursive: true, force: true })
  })

  it("renders each history run as one width-safe row with typed time decomposition and recoverable artifacts", async () => {
    const temp = mkdtempSync(join(tmpdir(), "yrd-history-row-"))
    const artifactDir = join(temp, "R4", "0-check", "attempt-1")
    const stdout = join(artifactDir, "stdout.log")
    const stderr = join(artifactDir, "stderr.log")
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync(stdout, "stdout\n")
    writeFileSync(stderr, "stderr\n")

    const run = fakeRun({
      id: "R4",
      status: "passed",
      pr: { id: "PR23", revision: 4, headSha: "4".repeat(40), baseSha: BASE_SHA },
      startedAt: "2026-07-12T11:01:16.930Z",
      finishedAt: "2026-07-12T11:49:24.335Z",
      integration: { commit: "5".repeat(40), baseSha: "6".repeat(40) },
      steps: [
        fakeStep(
          "check",
          "passed",
          fakeJob({
            id: JOB_CHECK_PASS_ID,
            status: "passed",
            requestedAt: "2026-07-12T11:01:16.930Z",
            startedAt: "2026-07-12T11:01:16.934Z",
            finishedAt: "2026-07-12T11:08:36.215Z",
            output: {
              durationMs: 426_008.048_209,
              detail: [1_309, 0, 53, 73, 21, 102, 0, 108, 326].map((length) => "x".repeat(length)).join("\n"),
              artifacts: [
                { name: "stdout", path: stdout },
                { name: "stderr", path: stderr },
              ],
            },
          }),
        ),
        fakeStep(
          "merge",
          "passed",
          fakeJob({
            id: JOB_PREPARE_PASS_ID,
            status: "passed",
            attempt: 2,
            requestedAt: "2026-07-12T11:08:36.216Z",
            startedAt: "2026-07-12T11:48:59.829Z",
            finishedAt: "2026-07-12T11:49:24.335Z",
          }),
        ),
      ],
    })
    const attempts = await lineLogAttempts([
      EventSchema.parse({
        id: JOB_CHECK_PASS_ID,
        name: "job/requested",
        ts: "2026-07-12T11:01:16.930Z",
        data: {
          definition: "line.step.check",
          revision: "check-v1",
          input: { run: "R4", step: "check", index: 0 },
          key: "line:R4:0",
        },
      }),
      EventSchema.parse({
        id: "00000000-0000-7000-8000-000000000201",
        name: "job/transitioned",
        ts: "2026-07-12T11:01:16.934Z",
        data: {
          type: "start",
          id: JOB_CHECK_PASS_ID,
          attempt: 1,
          executor: "yrd-cli",
          leaseExpiresAt: "2026-07-12T11:03:16.934Z",
        },
      }),
      EventSchema.parse({
        id: "00000000-0000-7000-8000-000000000202",
        name: "job/transitioned",
        ts: "2026-07-12T11:08:36.215Z",
        data: {
          type: "finish",
          id: JOB_CHECK_PASS_ID,
          attempt: 1,
          executor: "yrd-cli",
          result: { status: "passed", output: {} },
        },
      }),
      EventSchema.parse({
        id: JOB_PREPARE_PASS_ID,
        name: "job/requested",
        ts: "2026-07-12T11:08:36.216Z",
        data: {
          definition: "line.step.merge",
          revision: "merge-v1",
          input: { run: "R4", step: "merge", index: 1 },
          key: "line:R4:1",
        },
      }),
      EventSchema.parse({
        id: "00000000-0000-7000-8000-000000000203",
        name: "job/transitioned",
        ts: "2026-07-12T11:08:36.218Z",
        data: {
          type: "start",
          id: JOB_PREPARE_PASS_ID,
          attempt: 1,
          executor: "yrd-cli",
          leaseExpiresAt: "2026-07-12T11:10:36.218Z",
        },
      }),
      EventSchema.parse({
        id: "00000000-0000-7000-8000-000000000204",
        name: "job/transitioned",
        ts: "2026-07-12T11:12:18.300Z",
        data: {
          type: "finish",
          id: JOB_PREPARE_PASS_ID,
          attempt: 1,
          executor: "yrd-cli",
          result: { status: "failed", error: { code: "merge-stalled", message: "merge stalled" } },
        },
      }),
      EventSchema.parse({
        id: "00000000-0000-7000-8000-000000000205",
        name: "job/transitioned",
        ts: "2026-07-12T11:48:59.827Z",
        data: { type: "retry", id: JOB_PREPARE_PASS_ID },
      }),
      EventSchema.parse({
        id: "00000000-0000-7000-8000-000000000206",
        name: "job/transitioned",
        ts: "2026-07-12T11:48:59.829Z",
        data: {
          type: "start",
          id: JOB_PREPARE_PASS_ID,
          attempt: 2,
          executor: "yrd-native-bootstrap",
          leaseExpiresAt: "2026-07-12T11:50:59.829Z",
        },
      }),
      EventSchema.parse({
        id: "00000000-0000-7000-8000-000000000207",
        name: "job/transitioned",
        ts: "2026-07-12T11:49:24.335Z",
        data: {
          type: "finish",
          id: JOB_PREPARE_PASS_ID,
          attempt: 2,
          executor: "yrd-native-bootstrap",
          result: { status: "passed", output: {} },
        },
      }),
    ])
    expect(attempts).toEqual([
      {
        job: JOB_CHECK_PASS_ID,
        run: "R4",
        step: "check",
        index: 0,
        requestedAt: "2026-07-12T11:01:16.930Z",
        revision: "check-v1",
        attempt: 1,
        executor: "yrd-cli",
        outcome: "passed",
        startedAt: "2026-07-12T11:01:16.934Z",
        finishedAt: "2026-07-12T11:08:36.215Z",
        durationMs: 439_281,
        result: { status: "passed", output: {} },
      },
      {
        job: JOB_PREPARE_PASS_ID,
        run: "R4",
        step: "merge",
        index: 1,
        requestedAt: "2026-07-12T11:08:36.216Z",
        revision: "merge-v1",
        attempt: 1,
        executor: "yrd-cli",
        outcome: "failed",
        startedAt: "2026-07-12T11:08:36.218Z",
        finishedAt: "2026-07-12T11:12:18.300Z",
        durationMs: 222_082,
        result: { status: "failed", error: { code: "merge-stalled", message: "merge stalled" } },
      },
      {
        job: JOB_PREPARE_PASS_ID,
        run: "R4",
        step: "merge",
        index: 1,
        requestedAt: "2026-07-12T11:08:36.216Z",
        revision: "merge-v1",
        attempt: 2,
        executor: "yrd-native-bootstrap",
        outcome: "passed",
        startedAt: "2026-07-12T11:48:59.829Z",
        finishedAt: "2026-07-12T11:49:24.335Z",
        durationMs: 24_506,
        result: { status: "passed", output: {} },
      },
    ])
    const show = lineShowData(run, [run], attempts)
    expect(show).toMatchObject({
      run: "R4",
      totalDuration: "48m07s",
      totalDurationMs: 2_887_405,
      activeDuration: "11m26s",
      activeDurationMs: 685_869,
      waitDuration: "36m42s",
      waitDurationMs: 2_201_536,
    })
    expect(show.attempts).toHaveLength(3)
    expect(show.attempts[1]).toMatchObject({
      step: "merge",
      attempt: 1,
      outcome: "failed",
      startedAt: "2026-07-12T11:08:36.218Z",
      finishedAt: "2026-07-12T11:12:18.300Z",
      durationMs: 222_082,
      result: { status: "failed", error: { code: "merge-stalled", message: "merge stalled" } },
    })
    expect(show.steps).toHaveLength(3)
    expect(show.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ step: "check", attempt: "1", status: "passed", duration: "7m19s" }),
        expect.objectContaining({
          step: "merge",
          attempt: "1",
          status: "failed",
          duration: "3m42s",
          error: "merge stalled",
        }),
        expect.objectContaining({ step: "merge", attempt: "2", status: "passed", duration: "25s" }),
      ]),
    )

    const showHuman = await renderString(createElement(LineShowView, { data: show }), {
      width: 120,
      height: 20,
      plain: true,
    })
    expect(showHuman).toContain("TOTAL")
    expect(showHuman).toContain("ACTIVE")
    expect(showHuman).toContain("WAIT")
    expect(showHuman).toContain("48m07s")
    expect(showHuman).toContain("11m26s")
    expect(showHuman).toContain("36m42s")
    expect(showHuman).toContain("merge-stalled")
    expect(showHuman.split("\n").filter((line) => line.trimStart().startsWith("merge"))).toHaveLength(2)

    const showTty = await renderString(createElement(LineShowView, { data: show }), {
      width: 200,
      height: 20,
      plain: false,
    })
    expect(showTty).toContain(pathToFileURL(stdout).href)
    expect(showTty).toContain(pathToFileURL(stderr).href)
    expect(JSON.parse(JSON.stringify({ command: "line.show", run: show }))).toMatchObject({
      command: "line.show",
      run: {
        totalDurationMs: 2_887_405,
        activeDurationMs: 685_869,
        waitDurationMs: 2_201_536,
        attempts: [{ attempt: 1 }, { attempt: 1 }, { attempt: 2 }],
      },
    })
    const rows = lineLogRows(
      [fakeSummary([run])],
      new Set<string>(),
      undefined,
      new Map([["PR23", "integrated"]]),
      Date.parse("2026-07-12T12:49:24.335Z"),
      attempts,
    )

    expect(rows[0]).toMatchObject({
      run: "R4",
      pr: "PR23",
      revision: "4",
      startedAt: "2026-07-12T11:01:16.930Z",
      ageMs: 3_600_000,
      totalDurationMs: 2_887_405,
      activeDurationMs: 685_869,
      waitDurationMs: 2_201_536,
      attempts: attempts.map(
        ({ job, run: attemptRun, step, index, attempt, executor, outcome, startedAt, finishedAt, durationMs }) => ({
          job,
          run: attemptRun,
          step,
          index,
          attempt,
          executor,
          outcome,
          startedAt,
          finishedAt,
          durationMs,
        }),
      ),
      locations: [
        { label: "stdout", location: { path: stdout } },
        { label: "stderr", location: { path: stderr } },
      ],
    })

    for (const width of [80, 120]) {
      const human = await renderString(createElement(LineLogView, { rows, columns: width }), {
        width,
        height: 8,
        plain: true,
      })
      const physicalRows = human.split("\n").filter((line) => line.includes("R4"))
      expect(physicalRows).toHaveLength(1)
      expect(physicalRows[0]?.length).toBeLessThanOrEqual(width)
      expect(physicalRows[0]).toContain("R4/PR23@4/integrated")
      expect(physicalRows[0]).toContain(width === 80 ? "20260712T1101Z" : "2026-07-12T11:01Z")
      expect(physicalRows[0]).toContain(width === 80 ? "1h" : "1h00m")
      expect(physicalRows[0]).toContain(width === 80 ? "48m7s" : "48m07s")
      expect(physicalRows[0]).toContain(width === 80 ? "11m26s" : "11m26s")
      expect(physicalRows[0]).toContain("36m42s")
      expect(physicalRows[0]).toContain(width === 80 ? "art:12" : "art:stdout+stderr")
      expect(human).not.toMatch(/\n\s*\n\s*\n/u)
      expect(human).not.toContain("stdout=/")
    }

    const tty = await renderString(createElement(LineLogView, { rows, columns: 80 }), {
      width: 80,
      height: 8,
      plain: false,
    })
    expect(tty).toContain(pathToFileURL(stdout).href)
    expect(tty).toContain(pathToFileURL(stderr).href)
    const visibleTty = stripOsc8Targets(tty)
    expect(visibleTty).not.toContain(stdout)
    expect(visibleTty).not.toContain(stderr)

    rmSync(temp, { recursive: true, force: true })
  })

  it.fails("renders the newest twenty history records with subject, glyph, and bounded physical rows", async () => {
    const runs = Array.from({ length: 22 }, (_, index) => {
      const minute = String(index).padStart(2, "0")
      return fakeRun({
        id: `R${index + 1}`,
        status: "failed",
        subject: "fix(cli): bounded operator history",
        startedAt: `2026-07-09T12:${minute}:00.000Z`,
        finishedAt: `2026-07-09T12:${minute}:30.000Z`,
        steps: [
          fakeStep(
            "check",
            "failed",
            fakeJob({
              id: `00000000-0000-7000-8000-${String(index + 200).padStart(12, "0")}`,
              status: "failed",
              error: { code: "check-failed", message: `failure ${index + 1}` },
            }),
          ),
        ],
      })
    })
    const rows = lineLogRows(
      [fakeSummary(runs)],
      new Set<string>(),
      undefined,
      new Map([["PR1", "rejected"]]),
      Date.parse("2026-07-09T13:00:00.000Z"),
      [],
    )
    expect(rows).toHaveLength(22)
    expect(rows[0]).toMatchObject({ subject: "fix(cli): bounded operator history" })

    for (const width of [80, 120]) {
      const human = await renderString(createElement(LineLogView, { rows, columns: width }), {
        width,
        height: 24,
        plain: true,
      })
      const physicalRows = human.split("\n").filter((line) => /R\d+\/PR1/u.test(line))
      expect(physicalRows).toHaveLength(20)
      expect(physicalRows[0]).toContain("R22/PR1@1/rejected")
      expect(physicalRows.at(-1)).toContain("R3/PR1@1/rejected")
      expect(physicalRows[0]).toContain("[!]")
      expect(physicalRows[0]).toContain("fix(cli): bounded operator history")
      expect(Math.max(...human.split("\n").map((line) => line.length))).toBeLessThanOrEqual(width)
      expect(human).not.toContain("R2/PR1@1/rejected")
      expect(human).not.toContain("R1/PR1@1/rejected")
    }
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

  it("finishes a waiting remote evaluator through the Contest surface", async () => {
    const app = await createApp({ waitingEvaluator: "A2" })
    const compete = outputIO()
    expect(
      await runYrd(app, yrd("task", "compete", "km:T1", "--agents", "ag codex/claude", "--json"), compete.io),
    ).toBe(0)
    expect(JSON.parse(compete.stdout())).toMatchObject({
      contest: {
        status: "running",
        attempts: { A2: { status: "waiting" } },
      },
    })

    const finish = outputIO()
    expect(
      await runYrd(
        app,
        finishRemoteEvaluator(
          "--fail",
          "--detail",
          "private tests failed",
          "--artifact",
          "report=https://ci.invalid/evaluations/A2/report",
          "--json",
        ),
        finish.io,
      ),
    ).toBe(0)
    expect(JSON.parse(finish.stdout())).toMatchObject({
      command: "contest.finish",
      contest: {
        status: "ready",
        attempts: {
          A2: {
            status: "rejected",
            evaluations: {
              "held-out": {
                runs: [{ job: { status: "passed" }, result: { verdict: "failed", summary: "private tests failed" } }],
              },
            },
          },
        },
      },
    })
  })

  it("records remote evaluator infrastructure failure separately from a failed verdict", async () => {
    const app = await createApp({ waitingEvaluator: "A2" })
    expect(
      await runYrd(app, yrd("task", "compete", "km:T1", "--agents", "ag codex/claude", "--json"), outputIO().io),
    ).toBe(0)

    const ambiguous = outputIO()
    expect(await runYrd(app, finishRemoteEvaluator("--fail", "--error", "remote-timeout"), ambiguous.io)).toBe(2)
    expect(ambiguous.stderr()).toContain("exactly one of --ok, --fail, or --error")

    const finish = outputIO()
    expect(
      await runYrd(
        app,
        finishRemoteEvaluator("--error", "remote-timeout", "--detail", "remote evaluator timed out", "--json"),
        finish.io,
      ),
    ).toBe(0)
    expect(JSON.parse(finish.stdout())).toMatchObject({
      command: "contest.finish",
      contest: {
        status: "ready",
        attempts: {
          A2: {
            status: "failed",
            evaluations: {
              "held-out": {
                runs: [
                  {
                    job: {
                      status: "failed",
                      error: { code: "remote-timeout", message: "remote evaluator timed out" },
                    },
                  },
                ],
              },
            },
          },
        },
      },
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

    const missingPR = outputIO()
    expect(await runYrd(app, yrd("line", "integrate", "PR404"), missingPR.io)).toBe(1)
    expect(missingPR.stderr()).toContain("no PR 'PR404'")

    const missingWaitingRun = outputIO()
    expect(await runYrd(app, yrd("line", "finish", "PR404", "--ok"), missingWaitingRun.io)).toBe(1)
    expect(missingWaitingRun.stderr()).toContain("no line run or PR 'PR404'")

    const unsupported = outputIO()
    expect(await runYrd(app, yrd("line", "init"), unsupported.io)).toBe(2)
    expect(unsupported.stderr()).toContain("line.init capability is not installed")

    const missingTaskSource = outputIO()
    expect(
      await runYrd(app, yrd("task", "compete", "github:42", "--agents", "ag codex/claude"), missingTaskSource.io),
    ).toBe(2)
    expect(missingTaskSource.stderr()).toContain("no task source 'github' is registered")

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

    const init = outputIO()
    expect(await runYrd(app, yrd("line", "init", "release/2.0", "--json"), init.io, services)).toBe(0)
    expect(JSON.parse(init.stdout())).toEqual({
      base: "release/2.0",
      command: "line.init",
      result: { base: "release/2.0", ready: true },
    })

    const deinit = outputIO()
    expect(await runYrd(app, yrd("line", "deinit", "release/2.0", "--json"), deinit.io, services)).toBe(0)
    expect(JSON.parse(deinit.stdout())).toEqual({
      base: "release/2.0",
      command: "line.deinit",
      result: { base: "release/2.0", released: true },
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
