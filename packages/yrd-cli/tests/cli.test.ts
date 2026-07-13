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
  type QueueRun,
  type QueueSummary,
  withQueue,
  withMerge,
  withStep,
  type AddStepResult,
  type PRShape,
  type StepExecution,
} from "@yrd/queue"
import { withIssues } from "@yrd/issue"
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
  QueueShowView,
  QueueLogView,
  QueueWatchView,
  activeWatchRow,
  humanQueueProjection,
  queueLogAttempts,
  queueLogRows,
  queueRevisionKey,
  queueShowData,
  queueStatusRows,
  watchQueueRows,
  type QueueLogCoverage,
  type QueueStatusResult,
} from "../src/queue-status-view.tsx"
import { withLiveRenderer } from "../src/live-renderer.ts"
import * as runInternals from "../src/run.ts"
import { QueueWatchFrame, QueueWatchPane, reduceWatchControl, type QueueWatchPaneProps } from "../src/watch-pane.tsx"

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
  const queue = withQueue({ steps: [check, merge] as const, batch: options.batch ?? false })
  const contests = withContests({ runners: [contest.runner], evaluators: [contest.evaluator], git: contest.git })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs, contests.jobDefs] }),
    withIssues({ sources: [{ id: "km", resolve: (ref) => ({ ref, title: "Issue one" }) }] }),
    withBays({ jobs: bayJobs, defaultBase: "main" }),
  )
  return createYrd(contests(queue(base)), {
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
    runner: "cli-test",
    leaseMs: 60_000,
    now: () => Date.parse("2026-07-09T12:01:00.000Z"),
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
}): QueueRun["steps"][number]["job"] {
  const status = input.status
  return {
    id: input.id,
    definition: "queue.step",
    revision: "test-v1",
    input: {},
    attempt: input.attempt ?? 1,
    requestedAt: input.requestedAt ?? "2026-07-09T12:00:00.000Z",
    changedAt: input.requestedAt ?? "2026-07-09T12:00:00.000Z",
    ...(status === "requested"
      ? {}
      : {
          startedAt: input.startedAt ?? "2026-07-09T12:00:00.000Z",
          runner: "queue-test",
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
          runner: "queue-test",
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
  } as QueueRun["steps"][number]["job"]
}

function fakeStep(
  name: string,
  status: Parameters<typeof fakeJob>[0]["status"],
  job: QueueRun["steps"][number]["job"],
) {
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
}): QueueRun {
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

function fakeSummary(runs: readonly QueueRun[]): QueueSummary {
  return {
    base: runs[0]?.base ?? "main",
    running: [],
    waiting: [],
    finished: runs,
  }
}

function coverageFixture(path: string, frames = 185): QueueLogCoverage {
  return {
    since: "2026-07-09T12:00:00.000Z",
    completeness: "queue-only",
    legacy: [{ path, frames }],
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
    expect(gitHelp.stdout()).not.toMatch(/^\s+queue /mu)
    expect(gitHelp.stdout()).not.toMatch(/^\s+issue /mu)
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
    expect(yrdHelp.stdout()).toContain("view")
    expect(yrdHelp.stdout()).toContain("eval")
    expect(yrdHelp.stdout()).toContain("finish")
    expect(yrdHelp.stdout()).toContain("select")
    expect(yrdHelp.stdout()).toContain("promote")
    expect(yrdHelp.stdout()).not.toMatch(/^\s+run \[/mu)
    expect(yrdHelp.stdout()).not.toMatch(/^\s+help /mu)
  })

  it("uses concise layered help with examples on the root and queue surfaces", async () => {
    const app = await createApp()
    const root = outputIO({ columns: 100 })
    expect(await runYrd(app, yrd("--help"), root.io)).toBe(0)
    expect(root.stdout()).toContain("yrd (shipyard) — agentic software delivery")
    expect(root.stdout()).toContain("Model:")
    expect(root.stdout()).toContain("Objects:")
    expect(root.stdout()).toContain("Boundaries:")
    expect(root.stdout()).toContain("Pick an issue")
    expect(root.stdout()).toContain("The tracker holds the pen; yrd never creates or edits issues.")
    expect(root.stdout()).toContain("Examples:")
    expect(root.stdout()).toContain("$ yrd bay open fix --from topic")
    expect(root.stdout()).not.toMatch(/\b(?:pr\|prs|bay\|bays|issue\|issues|contest\|contests|queue\|queues)\b/u)

    const queue = outputIO({ columns: 100 })
    expect(await runYrd(app, yrd("queue", "--help"), queue.io)).toBe(0)
    expect(queue.stdout()).toContain("manage integration queues")
    expect(queue.stdout()).toMatch(/^\s+init \[options\] \[base\]\s+prepare queue resources$/mu)
    expect(queue.stdout()).toMatch(/^\s+deinit \[options\] \[base\]\s+release queue resources$/mu)
    expect(queue.stdout()).not.toMatch(/^\s+(?:provision|deprovision)\b/mu)
    expect(queue.stdout()).toContain("Examples:")
    expect(queue.stdout()).toContain("$ yrd queue run PR7 --steps check,merge")
  })

  it("exposes the locked noun-cutover surface and teaches that only the queue merges", async () => {
    const app = await createApp()
    const root = outputIO({ columns: 100 })
    expect(await runYrd(app, yrd("--help"), root.io)).toBe(0)
    expect(root.stdout()).toContain("Pick an issue")
    for (const command of ["pr", "bay", "issue", "contest", "queue", "log", "watch", "prime"]) {
      expect(root.stdout()).toMatch(new RegExp(`^\\s+${command}\\b`, "mu"))
    }
    const retiredQueueNoun = ["li", "ne"].join("")
    const retiredIssueNoun = ["ta", "sk"].join("")
    const retiredVerbs = [
      ["inte", "grate"].join(""),
      ["ho", "ld"].join(""),
      ["re", "lease"].join(""),
      ["ad", "min"].join(""),
    ]
    for (const removed of [retiredQueueNoun, retiredIssueNoun, ...retiredVerbs]) {
      expect(root.stdout()).not.toMatch(new RegExp(`^\\s+${removed}\\b`, "mu"))
    }

    const queue = outputIO()
    expect(await runYrd(app, yrd("queue", "--help"), queue.io)).toBe(0)
    for (const command of ["run", "pause", "resume", "recover", "finish", "init", "deinit", "audit"]) {
      expect(queue.stdout()).toMatch(new RegExp(`^\\s+${command}\\b`, "mu"))
    }
    const queueRun = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "--help"), queueRun.io)).toBe(0)
    expect(queueRun.stdout()).not.toContain("--retry")

    const pr = outputIO()
    expect(await runYrd(app, yrd("pr", "--help"), pr.io)).toBe(0)
    for (const command of ["submit", "view", "runs", "diff", "checkout", "status", "edit", "retry", "close"]) {
      expect(pr.stdout()).toMatch(new RegExp(`^\\s+${command}\\b`, "mu"))
    }

    const contest = outputIO()
    expect(await runYrd(app, yrd("contest", "--help"), contest.io)).toBe(0)
    expect(contest.stdout()).toMatch(/^\s+eval\b/mu)
    expect(contest.stdout()).toMatch(/^\s+view\b/mu)
    expect(contest.stdout()).not.toMatch(/^\s+(?:evaluate|show)\b/mu)

    const before = await Array.fromAsync(app.events()).then((events) => events.length)
    const direct = outputIO()
    expect(await runYrd(app, yrd("pr", "merge", "topic/direct", "--json"), direct.io)).toBe(1)
    expect(direct.stdout()).toBe("")
    expect(JSON.parse(direct.stderr())).toMatchObject({
      command: "pr.merge",
      branch: "topic/direct",
      status: "not-submitted",
      next: "yrd pr submit topic/direct",
      guidance: { submit: "yrd pr submit topic/direct" },
      failure: { kind: "refusal", code: "queue-only-merger" },
    })
    expect(await Array.fromAsync(app.events()).then((events) => events.length)).toBe(before)

    await openAndSubmit(app)
    const submitted = await Array.fromAsync(app.events()).then((events) => events.length)
    const merge = outputIO()
    expect(await runYrd(app, yrd("pr", "merge", "PR1"), merge.io)).toBe(1)
    expect(merge.stdout()).toBe("")
    expect(merge.stderr()).toContain("the queue is the only merger")
    expect(merge.stderr()).toContain("queued at position 1")
    expect(merge.stderr()).toContain("yrd watch --pr PR1")
    expect(await Array.fromAsync(app.events()).then((events) => events.length)).toBe(submitted)

    const mergeJson = outputIO()
    expect(await runYrd(app, yrd("pr", "merge", "PR1", "--json"), mergeJson.io)).toBe(1)
    expect(mergeJson.stdout()).toBe("")
    expect(JSON.parse(mergeJson.stderr())).toMatchObject({
      command: "pr.merge",
      pr: "PR1",
      position: 1,
      next: "yrd watch --pr PR1",
      guidance: { watch: "yrd watch --pr PR1" },
      failure: { kind: "refusal", code: "queue-only-merger" },
    })
    expect(await Array.fromAsync(app.events()).then((events) => events.length)).toBe(submitted)
  })

  it("keeps JSON discriminators faithful and finds a direct-branch PR for status", async () => {
    const app = await createApp()
    const submit = outputIO({ resolveRevision: async () => HEAD_SHA })
    expect(
      await runYrd(app, yrd("pr", "submit", "topic/direct", "--base", "main", "--json"), submit.io),
      submit.stderr(),
    ).toBe(0)
    expect(JSON.parse(submit.stdout())).toMatchObject({ command: "pr.submit", prs: [{ branch: "topic/direct" }] })

    const status = outputIO({ currentBranch: () => "topic/direct" })
    expect(await runYrd(app, yrd("pr", "status", "--json"), status.io), status.stderr()).toBe(0)
    expect(JSON.parse(status.stdout())).toMatchObject({ command: "pr.status", pr: { branch: "topic/direct" } })

    const prime = outputIO({ currentBranch: () => "topic/direct" })
    expect(await runYrd(app, yrd("prime", "--json"), prime.io), prime.stderr()).toBe(0)
    expect(JSON.parse(prime.stdout())).toMatchObject({ command: "prime", live: { pr: "PR1", base: "main" } })

    const checkout = outputIO()
    expect(await runYrd(app, yrd("pr", "checkout", "PR1", "--json"), checkout.io), checkout.stderr()).toBe(0)
    expect(JSON.parse(checkout.stdout())).toMatchObject({
      command: "pr.checkout",
      pr: "PR1",
      bay: { status: "active" },
    })

    const dashboard = outputIO()
    expect(await runYrd(app, yrd("--json"), dashboard.io), dashboard.stderr()).toBe(0)
    expect(JSON.parse(dashboard.stdout())).toMatchObject({ command: "dashboard" })
  })

  it("keeps queue positions lossless beyond the rendered row budget", async () => {
    const app = await createApp()
    for (const index of Array.from({ length: 6 }, (_, offset) => offset + 1)) {
      await app.bays.submit({ branch: `topic/${index}`, headSha: String(index).repeat(40), base: "main" })
    }
    expect(app.state().bays.prs.PR1?.submittedAt).toBe(app.state().bays.prs.PR6?.submittedAt)

    const humanStatus = outputIO({
      currentBranch: () => "topic/6",
      now: () => Date.parse("2026-07-09T12:01:00.000Z"),
    })
    expect(await runYrd(app, yrd("pr", "status"), humanStatus.io), humanStatus.stderr()).toBe(0)
    expect(humanStatus.stdout()).toContain("6. [ ] PR6")

    const status = outputIO({ currentBranch: () => "topic/6" })
    expect(await runYrd(app, yrd("pr", "status", "--json"), status.io), status.stderr()).toBe(0)
    expect(JSON.parse(status.stdout())).toMatchObject({ command: "pr.status", pr: { id: "PR6" }, position: 6 })

    const prime = outputIO({ currentBranch: () => "topic/6" })
    expect(await runYrd(app, yrd("prime", "--json"), prime.io), prime.stderr()).toBe(0)
    expect(JSON.parse(prime.stdout())).toMatchObject({ command: "prime", live: { pr: "PR6", position: 6 } })

    const refusal = outputIO()
    expect(await runYrd(app, yrd("pr", "merge", "PR6", "--json"), refusal.io)).toBe(1)
    expect(JSON.parse(refusal.stderr())).toMatchObject({ command: "pr.merge", pr: "PR6", position: 6 })
  })

  it("executes bare projections with their canonical JSON discriminators", async () => {
    const app = await createApp()
    const surfaces = [
      { args: ["--json"], command: "dashboard" },
      { args: ["queue", "--json"], command: "queue.list" },
      { args: ["pr", "--json"], command: "pr.list" },
      { args: ["issue", "--json"], command: "issue.list" },
      { args: ["log", "--json"], command: "log" },
      { args: ["prime", "--json"], command: "prime" },
    ] as const

    for (const surface of surfaces) {
      const output = outputIO()
      expect(await runYrd(app, yrd(...surface.args), output.io), output.stderr()).toBe(0)
      expect(JSON.parse(output.stdout())).toMatchObject({ command: surface.command })
      expect(output.stdout()).not.toContain("Usage:")
    }
  })

  it("emits lossless queue runs and attempt history only when log --all is requested", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    await app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 })

    const ordinary = outputIO()
    expect(await runYrd(app, yrd("log", "--json"), ordinary.io), ordinary.stderr()).toBe(0)
    expect(JSON.parse(ordinary.stdout())).not.toHaveProperty("results")
    expect(JSON.parse(ordinary.stdout())).not.toHaveProperty("attempts")

    const lossless = outputIO()
    expect(await runYrd(app, yrd("log", "--all", "--json"), lossless.io), lossless.stderr()).toBe(0)
    expect(JSON.parse(lossless.stdout())).toMatchObject({
      command: "log",
      results: [
        {
          base: "main",
          finished: [
            {
              id: "R1",
              prs: [{ id: "PR1", revision: 1 }],
              shape: { results: { check: expect.any(Object) } },
              steps: [{ name: "check" }, { name: "merge" }],
              integration: expect.any(Object),
            },
          ],
        },
      ],
      attempts: [
        expect.objectContaining({
          run: "R1",
          step: "check",
          attempt: 1,
          revision: "check-v1",
          result: { status: "passed", output: { checked: true } },
        }),
        expect.objectContaining({
          run: "R1",
          step: "merge",
          attempt: 1,
          revision: "merge-v1",
          result: { status: "passed", output: expect.any(Object) },
        }),
      ],
    })
  })

  it("keeps lossless log results and attempts inside base and PR scopes", async () => {
    const app = await createApp()
    await app.bays.submit({ branch: "topic/main-one", headSha: "1".repeat(40), base: "main" })
    await app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 })
    await app.bays.submit({ branch: "topic/main-two", headSha: "2".repeat(40), base: "main" })
    await app.queue.run({ prs: ["PR2"] }, { runner: "test", leaseMs: 60_000 })
    await app.bays.submit({ branch: "topic/release", headSha: "3".repeat(40), base: "release/2.0" })
    await app.queue.run({ prs: ["PR3"] }, { runner: "test", leaseMs: 60_000 })

    const assertScope = async (args: readonly string[], expectedRuns: readonly string[]) => {
      const output = outputIO()
      expect(await runYrd(app, yrd("log", "--all", "--json", ...args), output.io), output.stderr()).toBe(0)
      const parsed = JSON.parse(output.stdout()) as {
        results: readonly QueueStatusResult[]
        attempts: readonly { run: string }[]
      }
      expect(parsed.results.flatMap((result) => result.finished.map((run) => run.id))).toEqual(expectedRuns)
      expect([...new Set(parsed.attempts.map((attempt) => attempt.run))]).toEqual(expectedRuns)
    }

    await assertScope(["--base", "main"], ["R1", "R2"])
    await assertScope(["--pr", "PR1"], ["R1"])
  })

  it("preserves failed output and lost retry evidence in lossless log JSON", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    await app.dispatch(app.commands.queue.run, { prs: ["PR1"], steps: ["check", "merge"] })
    const check = app.queue.get("R1")?.steps[0]?.job
    if (check === undefined) throw new Error("expected requested check")
    await app.dispatch(app.commands.job.transition, {
      type: "start",
      id: check.id,
      attempt: 1,
      runner: "first-runner",
      leaseExpiresAt: "2026-07-09T12:00:01.000Z",
    })
    await app.jobs.finish(check.id, {
      attempt: 1,
      runner: "first-runner",
      result: {
        status: "failed",
        error: { code: "check-failed", message: "candidate failed" },
        output: { exitCode: 17, artifacts: [{ name: "stderr", path: "/tmp/check.stderr" }] },
      },
    })
    await app.jobs.retry(check.id)
    await app.dispatch(app.commands.job.transition, {
      type: "start",
      id: check.id,
      attempt: 2,
      runner: "second-runner",
      leaseExpiresAt: "2026-07-09T12:00:01.000Z",
    })
    await app.jobs.recover({ now: "2026-07-09T12:00:02.000Z", reason: "runner disappeared" })

    const output = outputIO()
    expect(await runYrd(app, yrd("log", "--all", "--json"), output.io), output.stderr()).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({
      command: "log",
      attempts: [
        {
          job: check.id,
          run: "R1",
          step: "check",
          index: 0,
          requestedAt: "2026-07-09T12:00:00.000Z",
          revision: "check-v1",
          attempt: 1,
          runner: "first-runner",
          outcome: "failed",
          result: {
            status: "failed",
            error: { code: "check-failed", message: "candidate failed" },
            output: { exitCode: 17, artifacts: [{ name: "stderr", path: "/tmp/check.stderr" }] },
          },
        },
        {
          job: check.id,
          run: "R1",
          step: "check",
          index: 0,
          requestedAt: "2026-07-09T12:00:00.000Z",
          revision: "check-v1",
          attempt: 2,
          runner: "second-runner",
          outcome: "lost",
          result: { status: "lost", reason: "runner disappeared" },
        },
      ],
    })
  })

  it("teaches PR-owned retry when pr merge is invoked for rejected work", async () => {
    const app = await createApp({ failingCheck: true })
    await openAndSubmit(app)
    await app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 })
    const before = await Array.fromAsync(app.events()).then((events) => events.length)
    const output = outputIO()
    expect(await runYrd(app, yrd("pr", "merge", "PR1", "--json"), output.io)).toBe(1)
    expect(JSON.parse(output.stderr())).toMatchObject({
      command: "pr.merge",
      status: "rejected",
      next: "yrd pr runs PR1",
      guidance: {
        inspect: "yrd pr runs PR1",
        retry: "yrd pr retry PR1",
        resubmit: "fix the branch and run yrd pr submit again",
      },
    })
    expect(await Array.fromAsync(app.events()).then((events) => events.length)).toBe(before)
  })

  it("keeps submission observational and gives queue run sole ownership of execution", async () => {
    const mergeRuns: string[] = []
    const app = await createApp({ mergeRuns })
    const open = outputIO()
    expect(await runYrd(app, yrd("bay", "open", "one"), open.io), open.stderr()).toBe(0)

    const submit = outputIO({ cwd: "/repo/.bays/B1" })
    expect(await runYrd(app, yrd("pr", "submit"), submit.io), submit.stderr()).toBe(0)
    expect(app.state().bays.prs.PR1).toMatchObject({ status: "submitted" })
    expect(Object.values(app.state().queues.records)).toHaveLength(0)
    expect(mergeRuns).toEqual([])

    const beforeRejectedWait = await Array.fromAsync(app.events()).then((events) => events.length)
    const rejectedWait = outputIO({ cwd: "/repo/.bays/B1" })
    const retiredWait = `--${["wa", "it"].join("")}`
    expect(await runYrd(app, yrd("bay", "submit", retiredWait), rejectedWait.io)).toBe(2)
    expect(await Array.fromAsync(app.events()).then((events) => events.length)).toBe(beforeRejectedWait)

    const run = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "PR1", "--json"), run.io), run.stderr()).toBe(0)
    expect(mergeRuns).toEqual(["merge"])
    expect(app.state().bays.prs.PR1).toMatchObject({ status: "integrated" })
    expect(Object.values(app.state().queues.records)).toHaveLength(1)
  })

  it("rejects every retired route without journaling an event", async () => {
    const app = await createApp()
    const retiredQueueNoun = ["li", "ne"].join("")
    const retiredIssueNoun = ["ta", "sk"].join("")
    const retiredIntegrate = ["inte", "grate"].join("")
    const retiredHold = ["ho", "ld"].join("")
    const retiredRelease = ["re", "lease"].join("")
    const retiredAdmin = ["ad", "min"].join("")
    const retiredRetry = `--${["re", "try"].join("")}`
    for (const args of [
      [retiredQueueNoun],
      [retiredIssueNoun],
      ["run"],
      [retiredIntegrate],
      [retiredHold],
      [retiredRelease],
      [retiredAdmin],
      ["queue", "run", retiredRetry],
    ]) {
      const before = await Array.fromAsync(app.events()).then((events) => events.length)
      const output = outputIO()
      expect(await runYrd(app, yrd(...args), output.io), args.join(" ")).not.toBe(0)
      expect(await Array.fromAsync(app.events()).then((events) => events.length), args.join(" ")).toBe(before)
    }
  })

  it("renders bare read surfaces and accepts only silent plural noun aliases", async () => {
    const app = await createApp()
    await openAndSubmit(app)

    const dashboard = outputIO()
    expect(await runYrd(app, yrd(), dashboard.io), dashboard.stderr()).toBe(0)
    expect(dashboard.stdout()).toContain("OPEN")
    expect(dashboard.stdout()).not.toContain("Usage: yrd")

    const prs = outputIO()
    expect(await runYrd(app, yrd("pr"), prs.io), prs.stderr()).toBe(0)
    expect(prs.stdout()).toContain("PR1")

    const queues = outputIO()
    expect(await runYrd(app, yrd("queue"), queues.io), queues.stderr()).toBe(0)
    expect(queues.stdout()).toContain("main")

    for (const noun of ["prs", "bays", "issues", "contests", "queues"]) {
      const alias = outputIO()
      expect(await runYrd(app, yrd(noun, "--help"), alias.io), noun).toBe(0)
      expect(alias.stdout(), noun).not.toMatch(new RegExp(`^\\s+${noun}\\b`, "mu"))
    }
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

  it("records tracker-neutral issue and actor links when opening a bay", async () => {
    const app = await createApp()
    const output = outputIO({ color: true, columns: 96 })

    expect(
      await runYrd(
        app,
        yrd("bay", "open", "linked-work", "--issue", "github:beorn/yrd#42", "--actor", "codex:apex"),
        output.io,
      ),
      output.stderr(),
    ).toBe(0)
    expect(app.state().bays.byId.B1).toMatchObject({
      name: "linked-work",
      issue: "github:beorn/yrd#42",
      actor: "codex:apex",
    })
    expect(output.stdout()).toContain("ISSUE")
    expect(output.stdout()).toContain("github:beorn/yrd#42")
    expect(output.stdout()).toContain("ACTOR")
    expect(output.stdout()).toContain("codex:apex")
  })

  it("submits inferred bays and runs selected queue steps instead of merely enqueueing jobs", async () => {
    const app = await createApp()
    await openAndSubmit(app)

    const before = app.state()
    expect(before.bays.prs.PR1).toMatchObject({ bay: "B1", status: "submitted", headSha: HEAD_SHA })

    const integrated = outputIO()
    expect(
      await runYrd(app, yrd("queue", "run", "PR1", "--steps", "check,merge", "--json"), integrated.io),
      integrated.stderr(),
    ).toBe(0)
    expect(JSON.parse(integrated.stdout())).toMatchObject({
      command: "queue.run",
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

  it("requires the exact waiting Job owner to finish and resume the same durable run", async () => {
    const app = await createApp({ waitingCheck: true })
    await openAndSubmit(app)

    const run = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "PR1"), run.io)).toBe(0)
    expect(app.queue.get("R1")?.status).toBe("waiting")
    const waitingJob = app.queue.get("R1")?.steps[0]?.job
    if (waitingJob?.status !== "waiting") throw new Error("expected waiting check Job")
    const waiting = outputIO({ color: true })
    expect(await runYrd(app, yrd(), waiting.io)).toBe(0)
    expect(waiting.stdout()).toContain("https://ci.invalid/run/1")

    const incomplete = outputIO()
    expect(
      await runYrd(app, yrd("queue", "finish", "PR1", "--ok", "--token", "remote-check", "--json"), incomplete.io),
    ).toBe(2)
    expect(incomplete.stderr()).toContain("queue finish requires --job, --runner, --attempt, and --token")
    expect(app.queue.get("R1")?.status).toBe("waiting")

    const invalidAttempt = outputIO()
    expect(
      await runYrd(
        app,
        yrd(
          "queue",
          "finish",
          "PR1",
          "--ok",
          "--job",
          waitingJob.id,
          "--runner",
          "cli-test",
          "--attempt",
          "0",
          "--token",
          "remote-check",
        ),
        invalidAttempt.io,
      ),
    ).toBe(2)
    expect(invalidAttempt.stderr()).toContain("--attempt must be a positive integer")
    expect(app.queue.get("R1")?.status).toBe("waiting")

    const staleJob = outputIO()
    expect(
      await runYrd(
        app,
        yrd(
          "queue",
          "finish",
          "PR1",
          "--ok",
          "--job",
          "stale-job",
          "--runner",
          "cli-test",
          "--attempt",
          "1",
          "--token",
          "remote-check",
        ),
        staleJob.io,
      ),
    ).toBe(1)
    expect(staleJob.stderr()).toContain("Job 'stale-job' is not the waiting 'check' Job")
    expect(app.queue.get("R1")?.status).toBe("waiting")

    const finish = outputIO()
    expect(
      await runYrd(
        app,
        yrd(
          "queue",
          "finish",
          "PR1",
          "--ok",
          "--job",
          waitingJob.id,
          "--runner",
          "cli-test",
          "--attempt",
          "1",
          "--token",
          "remote-check",
          "--json",
        ),
        finish.io,
      ),
      finish.stderr(),
    ).toBe(0)
    expect(JSON.parse(finish.stdout())).toMatchObject({ command: "queue.finish", run: { id: "R1", status: "passed" } })
    expect(app.queue.get("R1")?.shape).toMatchObject({
      results: { check: { baseSha: BASE_SHA, candidateSha: HEAD_SHA } },
    })
    expect(app.queue.get("R1")?.steps.map((step) => step.job?.status)).toEqual(["passed", "passed"])
  })

  it("recovers only expired queue work through the public JSON command", async () => {
    const mergeRuns: string[] = []
    const app = await createApp({ mergeRuns, failingCheck: true })
    await openAndSubmit(app)
    const beforeNoop = await Array.fromAsync(app.events()).then((events) => events.length)
    const noop = outputIO({ now: () => Date.parse("2026-07-09T12:00:00.000Z") })
    expect(await runYrd(app, yrd("queue", "recover", "--json"), noop.io), noop.stderr()).toBe(0)
    expect(JSON.parse(noop.stdout())).toEqual({ command: "queue.recover", results: [] })
    expect(await Array.fromAsync(app.events()).then((events) => events.length)).toBe(beforeNoop)

    expect((await app.queue.run({ prs: ["PR1"] }, { runner: "first-runner", leaseMs: 60_000 }))[0]?.status).toBe(
      "failed",
    )
    expect(app.state().bays.prs.PR1).toMatchObject({ status: "rejected" })
    await app.dispatch(app.commands.queue.run, { prs: ["PR1"], retry: true })

    const checkJob = app.queue.get("R2")?.steps[0]?.job
    expect(checkJob?.status).toBe("requested")
    if (checkJob === undefined) throw new Error("expected requested check job")
    await app.dispatch(app.commands.job.transition, {
      type: "start",
      id: checkJob.id,
      attempt: 1,
      runner: "interrupted-runner",
      leaseExpiresAt: "2026-07-09T12:00:01.000Z",
    })
    expect(app.queue.get("R2")?.status).toBe("running")

    const recovery = outputIO({ now: () => Date.parse("2026-07-09T12:00:02.000Z") })
    expect(
      await runYrd(app, yrd("queue", "recover", "--reason", "runner interrupted", "--json"), recovery.io),
      recovery.stderr(),
    ).toBe(0)
    expect(JSON.parse(recovery.stdout())).toMatchObject({
      command: "queue.recover",
      results: [{ id: "R2", status: "failed", steps: [{ job: { status: "lost" } }, {}] }],
    })
    expect(app.state().bays.prs.PR1).toMatchObject({ status: "rejected" })
    expect(app.queue.get("R2")?.steps[1]?.job).toBeUndefined()
    expect(mergeRuns).toEqual([])
  })

  it("records an external failing verdict successfully while the queue run becomes failed", async () => {
    const temp = mkdtempSync(join(tmpdir(), "yrd-external-verdict-"))
    const artifact = join(temp, "private-tests.log")
    writeFileSync(artifact, "private tests failed\n")
    const app = await createApp({ waitingCheck: true })
    await openAndSubmit(app)
    expect(await runYrd(app, yrd("queue", "run", "PR1"), outputIO().io)).toBe(0)
    const waitingJob = app.queue.get("R1")?.steps[0]?.job
    if (waitingJob?.status !== "waiting") throw new Error("expected waiting check Job")

    const finish = outputIO()
    expect(
      await runYrd(
        app,
        yrd(
          "queue",
          "finish",
          "PR1",
          "--step",
          "check",
          "--fail",
          "--job",
          waitingJob.id,
          "--runner",
          "cli-test",
          "--attempt",
          "1",
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
      finish.stderr(),
    ).toBe(0)
    expect(JSON.parse(finish.stdout())).toMatchObject({ run: { id: "R1", status: "failed" } })
    expect(app.state().bays.prs.PR1).toMatchObject({
      status: "rejected",
      detail: "private tests failed",
    })
    const status = outputIO({ color: true })
    expect(await runYrd(app, yrd(), status.io)).toBe(0)
    expect(status.stdout()).toContain(pathToFileURL(artifact).href)
    rmSync(temp, { recursive: true, force: true })
  })

  it("preserves zero-selector and explicitly empty step selection semantics", async () => {
    const app = await createApp()
    await openAndSubmit(app)

    const integrated = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "--steps", "--json"), integrated.io)).toBe(0)
    expect(JSON.parse(integrated.stdout())).toEqual({ command: "queue.run", results: [] })
    expect(app.state().bays.prs.PR1?.status).toBe("submitted")

    const idle = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "--json"), idle.io)).toBe(0)
    expect(JSON.parse(idle.stdout())).toMatchObject({
      command: "queue.run",
      results: [{ id: "R1", prs: [{ id: "PR1" }], steps: [{ name: "check" }, { name: "merge" }], status: "passed" }],
    })

    const drained = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "--json"), drained.io)).toBe(0)
    expect(JSON.parse(drained.stdout())).toEqual({ command: "queue.run", results: [] })
  })

  it("persists and releases queue pauses through the operator CLI", async () => {
    const app = await createApp()
    await app.bays.submit({ branch: "issue/blocked", headSha: "1".repeat(40), base: "main" })
    await app.bays.submit({ branch: "issue/allowed", headSha: "2".repeat(40), base: "main" })
    const beforeRead = await Array.fromAsync(app.events()).then((events) => events.length)
    const unpaused = outputIO()
    expect(await runYrd(app, yrd("queue", "pause", "--json"), unpaused.io)).toBe(0)
    expect(JSON.parse(unpaused.stdout())).toEqual({ command: "queue.pause", pauses: [] })
    expect(await Array.fromAsync(app.events()).then((events) => events.length)).toBe(beforeRead)

    const pause = outputIO()

    expect(
      await runYrd(
        app,
        yrd("queue", "pause", "main", "--reason", "operator freeze", "--allow", "PR2", "--json"),
        pause.io,
      ),
    ).toBe(0)
    expect(JSON.parse(pause.stdout())).toMatchObject({
      command: "queue.pause",
      pause: { base: "main", reason: "operator freeze", allowedPRs: ["PR2"] },
    })
    const afterPause = await Array.fromAsync(app.events()).then((events) => events.length)
    const paused = outputIO()
    expect(await runYrd(app, yrd("queue", "pause", "--json"), paused.io)).toBe(0)
    expect(JSON.parse(paused.stdout())).toMatchObject({
      command: "queue.pause",
      pauses: [{ base: "main", reason: "operator freeze", allowedPRs: ["PR2"] }],
    })
    expect(await Array.fromAsync(app.events()).then((events) => events.length)).toBe(afterPause)

    const blocked = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "PR1", "--json"), blocked.io)).toBe(1)
    expect(blocked.stderr()).toContain("queue 'main' is paused: operator freeze")
    expect(app.state().queues.records).toEqual({})

    const eligible = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "--json"), eligible.io), eligible.stderr()).toBe(0)
    expect(JSON.parse(eligible.stdout())).toMatchObject({ results: [{ prs: [{ id: "PR2" }], status: "passed" }] })
    expect(app.state().bays.prs.PR1?.status).toBe("submitted")
    expect(app.state().bays.prs.PR2?.status).toBe("integrated")

    const status = outputIO()
    expect(await runYrd(app, yrd("--json"), status.io)).toBe(0)
    expect(JSON.parse(status.stdout())).toMatchObject({
      results: [{ base: "main", pause: { reason: "operator freeze", allowedPRs: ["PR2"] } }],
    })

    const humanStatus = outputIO({ columns: 100 })
    expect(await runYrd(app, yrd(), humanStatus.io)).toBe(0)
    expect(humanStatus.stdout()).toContain("PAUSE")
    expect(humanStatus.stdout()).toContain("operator freeze")
    expect(humanStatus.stdout()).toContain("PR2")

    const resume = outputIO()
    expect(await runYrd(app, yrd("queue", "resume", "main", "--json"), resume.io)).toBe(0)
    expect(JSON.parse(resume.stdout())).toEqual({ command: "queue.resume", base: "main" })
    expect(app.queue.status("main").pause).toBeUndefined()
  })

  it("passes zero-or-more selectors to the queue as one batch-capable candidate set", async () => {
    const app = await createApp({ batch: 2 })
    await openAndSubmit(app)
    expect(await runYrd(app, yrd("bay", "open", "two"), outputIO().io)).toBe(0)
    expect(await runYrd(app, yrd("bay", "submit"), outputIO({ cwd: "/repo/.bays/B2" }).io)).toBe(0)

    const integrated = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "--json"), integrated.io), integrated.stderr()).toBe(0)
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

  it("uses read capabilities for the dashboard and contest view without appending events", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    await app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000, now: () => 0 })
    const base = await app.contests.resolveBase()
    await app.dispatch(app.commands.issue.compete, {
      issue: { ref: { source: "km", id: "T1" }, title: "Issue one" },
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
    expect(await runYrd(app, yrd("pr", "view", "PR1", "--json"), status.io)).toBe(0)
    expect(JSON.parse(status.stdout())).toMatchObject({
      command: "pr.view",
      results: [{ base: "main", headSha: MERGED_SHA, prs: [{ id: "PR1" }] }],
    })
    expect(resolved).toEqual(["main"])

    const human = outputIO({
      now: () => Date.parse("2026-07-09T12:01:00.000Z"),
      color: true,
      columns: 80,
      resolveRevision: async () => MERGED_SHA,
    })
    expect(await runYrd(app, yrd("pr", "view", "PR1"), human.io)).toBe(0)
    expect(human.stdout()).toContain("PR1")
    expect(human.stdout()).toContain("[x]")
    expect(human.stdout()).toContain("one")
    expect(human.stdout()).toContain("integrated")
    expect(human.stdout()).toContain(MERGED_SHA.slice(0, 12))
    expect(human.stdout()).toContain("file:///repo/.bays/B1")

    const show = outputIO()
    expect(await runYrd(app, yrd("contest", "view", "C1", "--json"), show.io)).toBe(0)
    expect(JSON.parse(show.stdout())).toMatchObject({ command: "contest.view", contest: { id: "C1" } })
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
    expect(mounted?.type).toBe(QueueWatchPane)
    const props = mounted?.props as QueueWatchPaneProps
    expect(props.intervalMs).toBe(1_000)
    const frame = stripOsc8Targets(
      await renderString(createElement(QueueWatchFrame, { snapshot: props.initial, paused: false })),
    )
    expect(frame).toContain("QUEUE")
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

  it("renders pause and drain health in watch output", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    await app.queue.pause({ base: "main", reason: "operator freeze", allowedPRs: [] })

    let mounted: ReactElement | undefined
    const watch = outputIO({
      now: () => Date.parse("2026-07-09T12:01:00.000Z"),
    })
    const io = withLiveRenderer(watch.io, async (element) => {
      mounted = element
    })
    expect(await runYrd(app, yrd("watch"), io)).toBe(0)
    const props = mounted?.props as QueueWatchPaneProps
    const frame = stripOsc8Targets(await renderString(createElement(QueueWatchView, props.initial)))
    expect(frame).toContain("PAUSE")
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
          branch: "issue/watch",
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
    } as unknown as QueueStatusResult
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
          branch: "issue/watch",
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
    } as unknown as QueueStatusResult

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
          branch: "issue/watch",
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
    } as unknown as QueueStatusResult

    const frame = stripOsc8Targets(
      await renderString(
        createElement(QueueWatchView, { results: [result], now: Date.parse("2026-07-09T12:10:00.000Z") }),
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
        } as unknown as QueueStatusResult,
      ],
      now: 0,
    }
    const handle = await run(
      createElement(QueueWatchPane, {
        initial,
        load: async () => initial,
        intervalMs: 60_000,
      }),
      { writable: { write: () => {} }, cols: 40, rows: 8 },
    )
    try {
      expect(handle.text).toContain("QUEUE")
      expect(handle.text).toContain("main")
      expect(handle.text).toContain("PAUSE")
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

  it("monitors the dashboard continuously from root watch", async () => {
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

  it("renders the literal empty queue summary within 80- and 120-column budgets", async () => {
    const app = await createApp()

    const renderStatus = async (columns: number): Promise<string> => {
      const status = outputIO({
        columns,
        resolveRevision: async () => "3".repeat(40),
      })
      expect(await runYrd(app, yrd(), status.io), status.stderr()).toBe(0)
      return status.stdout()
    }

    const expected = [
      "QUEUE main@333333333333 OPEN 0 ACTIVE 0 INTEGRATED 0 REJECTED 0 DRAIN -",
      "No runnable or recent rejected PRs.",
    ].join("\n")
    for (const columns of [80, 120]) {
      const rendered = await renderStatus(columns)
      const physical = rendered.trimEnd().split("\n")
      expect(rendered.trimEnd()).toBe(expected)
      expect(physical).toHaveLength(2)
      expect(Math.max(...physical.map((row) => row.length))).toBeLessThanOrEqual(columns)
    }
  })

  it("projects runnable work and bounded rejection evidence without stale holds or unsafe retry teaching", async () => {
    const temp = mkdtempSync("/tmp/yrd-output-polish-")
    const artifact = join(temp, "failure.log")
    const failure = [
      "PR 'PR1' could not be applied: hint: Recursive merging with submodules currently only supports trivial cases.",
      "hint: Please manually handle the merging of each conflicted submodule.",
      "hint: This can be accomplished with the following steps:",
      "hint:   git add vendor/yrd",
      "hint:   git commit",
      "    at applyCandidate (/repo/packages/yrd-queue/src/command.ts:404:12)",
    ].join("\n")
    writeFileSync(artifact, `${failure}\n`)
    const app = await createApp({ checkFailure: { code: "apply-conflict", message: failure, artifact } })
    await app.bays.submit({
      branch: "issue/failing",
      name: "fix(cli): bound operator failures",
      headSha: HEAD_SHA,
      base: "main",
      baseSha: BASE_SHA,
    })
    expect((await app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 }))[0]?.status).toBe("failed")
    const resolveQueueTarget = async () => ({ base: "main", sha: BASE_SHA })
    const now = () => Date.parse("2026-07-09T12:01:00.000Z")
    const rejectedOnly = outputIO({ columns: 120, now, resolveQueueTarget })
    expect(await runYrd(app, yrd(), rejectedOnly.io), rejectedOnly.stderr()).toBe(0)
    expect.soft(rejectedOnly.stdout()).toMatch(/main@[a-f0-9]{12} OPEN 0 ACTIVE 0 INTEGRATED 0 REJECTED 1/u)

    await app.bays.submit({
      branch: "issue/runnable",
      name: "feat(cli): keep runnable work visible",
      headSha: "2".repeat(40),
      base: "origin/main",
      baseSha: BASE_SHA,
    })

    // Historical aliases can retain a pause after the canonical queue was resumed.
    await app.queue.pause({ base: "origin/main", reason: "released maintenance", allowedPRs: [] })
    await app.queue.resume("main")

    for (const columns of [80, 120]) {
      const status = outputIO({ columns, now, resolveQueueTarget })
      expect(await runYrd(app, yrd(), status.io), status.stderr()).toBe(0)
      const rows = status.stdout().trimEnd().split("\n")
      expect.soft(rows.length).toBeLessThanOrEqual(14)
      expect.soft(Math.max(...rows.map((row) => row.length))).toBeLessThanOrEqual(columns)
      expect.soft(status.stdout()).toMatch(/main@[a-f0-9]{12} OPEN 1 ACTIVE 0 INTEGRATED 0 REJECTED 1/u)
      expect.soft(status.stdout()).toContain("feat(cli): keep runnable work visible")
      expect.soft(status.stdout()).toContain("fix(cli): bound operator failures")
      expect.soft(status.stdout()).toContain("[!]")
      expect.soft(status.stdout()).toContain("apply-conflict: PR 'PR1' could not be applied")
      expect.soft(status.stdout()).toContain(`evidence: ${artifact}`)
      expect.soft(status.stdout()).not.toContain("next:")
      expect.soft(status.stdout()).not.toContain("hint:")
      expect.soft(status.stdout()).not.toContain("released maintenance")
    }
    const tty = outputIO({ columns: 80, color: true, now, resolveQueueTarget })
    expect(await runYrd(app, yrd(), tty.io), tty.stderr()).toBe(0)
    expect.soft(tty.stdout()).toContain(pathToFileURL(artifact).href)

    let mounted: ReactElement | undefined
    const watch = outputIO({ now, resolveQueueTarget })
    const live = withLiveRenderer(watch.io, async (element) => {
      mounted = element
    })
    expect(await runYrd(app, yrd("watch"), live), watch.stderr()).toBe(0)
    if (mounted === undefined) throw new Error("expected watch pane to mount")
    const snapshot = (mounted.props as QueueWatchPaneProps).initial
    expect.soft(snapshot.results[0]?.pause).toBeUndefined()
    expect.soft(watchQueueRows(snapshot.results[0]!, now()).map((row) => row.pr)).toEqual(["PR2"])
    for (const width of [80, 120]) {
      const frame = await renderString(createElement(QueueWatchView, snapshot), { width, height: 24, plain: true })
      const rows = frame.trimEnd().split("\n")
      expect.soft(rows.length).toBeLessThanOrEqual(16)
      expect.soft(Math.max(...rows.map((row) => row.length))).toBeLessThanOrEqual(width)
      expect.soft(frame).toContain("OPEN 1")
      expect.soft(frame).toContain("feat(cli): keep runnable work visible")
      expect.soft(frame).toContain("apply-conflict: PR 'PR1' could not be applied")
      expect.soft(frame).toContain(`evidence: ${artifact}`)
      expect.soft(frame).not.toContain("next:")
      expect.soft(frame).not.toContain("released maintenance")
      expect.soft(frame).not.toContain("hint:")
    }

    const json = outputIO({ now, resolveQueueTarget })
    expect(await runYrd(app, yrd("--json"), json.io), json.stderr()).toBe(0)
    const parsed = JSON.parse(json.stdout()) as { results: readonly QueueStatusResult[] }
    expect.soft(parsed.results[0]?.pause).toBeUndefined()
    expect(parsed.results[0]?.finished[0]?.error?.message).toBe(failure)
    expect(parsed.results[0]?.finished[0]?.steps[0]?.job).toMatchObject({
      output: { artifacts: [{ name: "failure", path: artifact }] },
    })

    const controller = new AbortController()
    const jsonl = outputIO({
      now,
      resolveQueueTarget,
      scope: {
        signal: controller.signal,
        sleep: async () => controller.abort(),
      },
    })
    expect(await runYrd(app, yrd("watch", "--json"), jsonl.io), jsonl.stderr()).toBe(0)
    const records = jsonl
      .stdout()
      .trimEnd()
      .split("\n")
      .map((entry) => JSON.parse(entry) as { results: readonly QueueStatusResult[] })
    expect(records).toHaveLength(1)
    expect(records[0]?.results[0]?.finished[0]?.error?.message).toBe(failure)
    expect(records[0]?.results[0]?.finished[0]?.steps[0]?.job).toMatchObject({
      output: { artifacts: [{ name: "failure", path: artifact }] },
    })
    rmSync(temp, { recursive: true, force: true })
  })

  it("does not derive next-action teaching without typed eligibility facts", () => {
    const failedRun = (id: string, revision: number, headSha: string, startedAt: string): QueueRun =>
      fakeRun({
        id,
        status: "failed",
        pr: { id: "PR1", revision, headSha, baseSha: BASE_SHA },
        startedAt,
        finishedAt: new Date(Date.parse(startedAt) + 1_000).toISOString(),
        steps: [
          fakeStep(
            "check",
            "failed",
            fakeJob({
              id: `00000000-0000-7000-8000-${String(Number(id.slice(1)) + 400).padStart(12, "0")}`,
              status: "failed",
              error: { code: "runner-lost", message: "runner disappeared" },
            }),
          ),
        ],
      })
    const positive = failedRun("R1", 1, HEAD_SHA, "2026-07-09T12:00:00.000Z")
    const superseded = failedRun("R2", 1, HEAD_SHA, "2026-07-09T12:02:00.000Z")
    const stale = failedRun("R3", 1, HEAD_SHA, "2026-07-09T12:04:00.000Z")
    const cases = [
      { name: "positive", status: "rejected" as const, revision: 1, headSha: HEAD_SHA, runs: [positive] },
      { name: "stale", status: "rejected" as const, revision: 2, headSha: "2".repeat(40), runs: [stale] },
      {
        name: "superseded",
        status: "rejected" as const,
        revision: 1,
        headSha: HEAD_SHA,
        runs: [positive, superseded],
      },
      { name: "retired", status: "withdrawn" as const, revision: 1, headSha: HEAD_SHA, runs: [positive] },
      { name: "unchanged", status: "pushed" as const, revision: 1, headSha: HEAD_SHA, runs: [positive] },
    ]

    for (const item of cases) {
      const pr = {
        id: "PR1",
        branch: "issue/failure",
        base: "main",
        baseSha: BASE_SHA,
        status: item.status,
        revision: item.revision,
        headSha: item.headSha,
        revisions: [],
      } as PR
      const selected = item.status === "rejected" ? new Set<string>() : new Set([pr.id])
      const projection = humanQueueProjection(
        { base: "main", headSha: BASE_SHA, prs: [pr], running: [], waiting: [], finished: item.runs },
        Date.parse("2026-07-09T12:10:00.000Z"),
        { selected },
      )
      expect(projection.recent, item.name).not.toHaveLength(0)
      for (const row of projection.recent) {
        if (row.failure !== undefined) {
          expect(row.failure, item.name).not.toHaveProperty("next")
          expect(row.failure, item.name).not.toHaveProperty("evidence")
        }
      }
    }
  })

  it("freezes recent rejected age at the terminal timestamp", () => {
    const terminalAt = "2026-07-09T12:06:00.000Z"
    const pr = {
      id: "PR1",
      branch: "issue/failure",
      base: "main",
      baseSha: BASE_SHA,
      status: "rejected",
      revision: 1,
      headSha: HEAD_SHA,
      revisions: [],
      submittedAt: "2026-07-09T12:00:00.000Z",
      rejectedAt: terminalAt,
    } as PR
    const run = fakeRun({
      id: "R1",
      status: "failed",
      pr: { id: pr.id, revision: pr.revision, headSha: pr.headSha, baseSha: pr.baseSha },
      startedAt: "2026-07-09T12:05:00.000Z",
      finishedAt: terminalAt,
      steps: [],
      error: { code: "check-failed", message: "check failed" },
    })
    const result = {
      base: "main",
      headSha: BASE_SHA,
      prs: [pr],
      running: [],
      waiting: [],
      finished: [run],
    } as QueueStatusResult

    const first = humanQueueProjection(result, Date.parse("2026-07-09T13:00:00.000Z")).recent[0]
    const later = humanQueueProjection(result, Date.parse("2026-07-10T13:00:00.000Z")).recent[0]
    expect(first?.age).toBe("6m")
    expect(later?.age).toBe(first?.age)
  })

  it("projects failure evidence only from the causative failed step", () => {
    const temp = mkdtempSync(join(tmpdir(), "yrd-causal-evidence-"))
    const prior = join(temp, "prepare.log")
    const causal = join(temp, "check.log")
    writeFileSync(prior, "prepare passed\n")
    writeFileSync(causal, "check failed\n")
    const pr = {
      id: "PR1",
      branch: "issue/failure",
      base: "main",
      status: "rejected",
      revision: 1,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      revisions: [],
    } as PR
    const run = fakeRun({
      id: "R1",
      status: "failed",
      pr: { id: pr.id, revision: pr.revision, headSha: pr.headSha, baseSha: pr.baseSha },
      startedAt: "2026-07-09T12:00:00.000Z",
      finishedAt: "2026-07-09T12:01:00.000Z",
      steps: [
        fakeStep(
          "prepare",
          "passed",
          fakeJob({ id: JOB_PREPARE_PASS_ID, status: "passed", output: { artifacts: [{ path: prior }] } }),
        ),
        fakeStep(
          "check",
          "failed",
          fakeJob({
            id: JOB_CHECK_FAILED_ID,
            status: "failed",
            error: { code: "check-failed", message: "check failed" },
            output: { artifacts: [{ path: causal }] },
          }),
        ),
      ],
    })

    const failure = humanQueueProjection(
      { base: "main", headSha: BASE_SHA, prs: [pr], running: [], waiting: [], finished: [run] },
      Date.parse("2026-07-09T12:02:00.000Z"),
    ).recent[0]?.failure
    expect(failure?.evidence).toEqual({ text: causal, href: pathToFileURL(causal).href })
    rmSync(temp, { recursive: true, force: true })
  })

  it("spotlights the active run in bounded status output", async () => {
    const app = await createApp({ waitingCheck: true })
    await app.bays.submit({
      branch: "issue/active",
      name: "fix(cli): show the active queue check",
      headSha: HEAD_SHA,
      base: "main",
      baseSha: BASE_SHA,
    })
    expect((await app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 }))[0]?.status).toBe("waiting")

    for (const columns of [80, 120]) {
      const status = outputIO({
        columns,
        now: () => Date.parse("2026-07-09T12:01:00.000Z"),
        resolveQueueTarget: async () => ({ base: "main", sha: BASE_SHA }),
      })
      expect(await runYrd(app, yrd(), status.io), status.stderr()).toBe(0)
      expect(status.stdout()).toContain("ACTIVE R1 PR1 fix(cli): show the active queue check")
      expect(
        Math.max(
          ...status
            .stdout()
            .split("\n")
            .map((row) => row.length),
        ),
      ).toBeLessThanOrEqual(columns)
    }
  })

  it("restricts the selected status spotlight to the selected PR ids", () => {
    const prs = [
      {
        id: "PR1",
        name: "unrelated active run",
        branch: "issue/unrelated",
        base: "main",
        status: "submitted",
        revision: 1,
        headSha: HEAD_SHA,
        revisions: [],
        submittedAt: "2026-07-09T12:00:00.000Z",
      },
      {
        id: "PR2",
        name: "selected active run",
        branch: "issue/selected",
        base: "main",
        status: "submitted",
        revision: 1,
        headSha: "2".repeat(40),
        revisions: [],
        submittedAt: "2026-07-09T12:01:00.000Z",
      },
    ] as PR[]
    const result = {
      base: "main",
      prs,
      running: [
        fakeRun({
          id: "R1",
          pr: { id: "PR1", revision: 1, headSha: HEAD_SHA },
          status: "running",
          steps: [],
          startedAt: "2026-07-09T12:02:00.000Z",
        }),
        fakeRun({
          id: "R2",
          pr: { id: "PR2", revision: 1, headSha: "2".repeat(40) },
          status: "running",
          steps: [],
          startedAt: "2026-07-09T12:03:00.000Z",
        }),
      ],
      waiting: [],
      finished: [],
    } as QueueStatusResult

    expect(
      humanQueueProjection(result, Date.parse("2026-07-09T12:04:00.000Z"), {
        selected: new Set(["PR2"]),
      }).active,
    ).toMatchObject({ run: "R2", pr: "PR2", subject: "selected active run" })
  })

  it("caps queue and rejection projections independently at 80 and 120 columns", async () => {
    const submitted = Array.from({ length: 7 }, (_, index) => ({
      id: `PR${index + 1}`,
      name: `feat(cli): runnable ${index + 1}`,
      branch: `issue/runnable-${index + 1}`,
      base: "main",
      baseSha: BASE_SHA,
      headSha: String(index + 1).repeat(40),
      revision: 1,
      revisions: [],
      status: "submitted",
      submittedAt: `2026-07-09T12:0${index}:00.000Z`,
    }))
    const rejected = Array.from({ length: 5 }, (_, index) => ({
      id: `PR${index + 8}`,
      name: `fix(cli): rejected ${index + 1}`,
      branch: `issue/rejected-${index + 1}`,
      base: "main",
      baseSha: BASE_SHA,
      headSha: String(index + 8).repeat(40),
      revision: 1,
      revisions: [],
      status: "rejected",
      submittedAt: `2026-07-09T11:0${index}:00.000Z`,
      rejectedAt: `2026-07-09T12:1${index}:00.000Z`,
    }))
    const finished = rejected.map((pr, index) =>
      fakeRun({
        id: `R${index + 1}`,
        pr: { id: pr.id, revision: 1, headSha: pr.headSha, baseSha: BASE_SHA },
        status: "failed",
        steps: [],
        startedAt: `2026-07-09T12:0${index}:00.000Z`,
        finishedAt: `2026-07-09T12:1${index}:00.000Z`,
        error: {
          code: "check-failed",
          message: `failure ${index + 1}\nhint: repeated advice\n    at check (/repo/check.ts:1:1)`,
        },
      }),
    )
    const result = {
      base: "main",
      headSha: BASE_SHA,
      prs: [...submitted, ...rejected],
      running: [],
      waiting: [],
      finished,
    } as unknown as QueueStatusResult
    const now = Date.parse("2026-07-09T13:00:00.000Z")
    const projection = humanQueueProjection(result, now)
    expect(projection).toMatchObject({ open: 7, rejected: 5, queueOverflow: 2 })
    expect(projection.queue).toHaveLength(5)
    expect(projection.recent).toHaveLength(3)
    expect(projection.recent.map((row) => row.runId)).toEqual(["R5", "R4", "R3"])

    for (const width of [80, 120]) {
      const frame = await renderString(createElement(QueueWatchView, { results: [result], now }), {
        width,
        height: 30,
        plain: true,
      })
      const rows = frame.trimEnd().split("\n")
      expect(rows).toHaveLength(16)
      expect(Math.max(...rows.map((row) => row.length))).toBeLessThanOrEqual(width)
      expect(frame).toContain("... 2 more runnable")
      expect(frame).not.toContain("hint:")
    }
  })

  it("projects local and remote spellings as one queue with command position parity", async () => {
    const app = await createApp()
    await app.bays.submit({ branch: "issue/one", headSha: "1".repeat(40), base: "main" })
    await app.bays.submit({ branch: "issue/two", headSha: "2".repeat(40), base: "origin/main" })
    const now = () => Date.parse("2026-07-09T12:01:00.000Z")
    const resolveQueueTarget = (ref: string) =>
      Promise.resolve({ base: ref === "origin/main" ? "main" : ref, sha: "a".repeat(40) })

    const dashboard = outputIO({ now, resolveQueueTarget })
    expect(await runYrd(app, yrd(), dashboard.io), dashboard.stderr()).toBe(0)
    expect.soft(dashboard.stdout()).toContain("1. [ ] PR1")
    expect.soft(dashboard.stdout()).toContain("2. [ ] PR2")

    const status = outputIO({ now, resolveQueueTarget, currentBranch: () => "issue/two" })
    expect(await runYrd(app, yrd("pr", "status"), status.io), status.stderr()).toBe(0)
    expect.soft(status.stdout()).toContain("2. [ ] PR2")

    const prime = outputIO({ now, resolveQueueTarget, currentBranch: () => "issue/two" })
    expect(await runYrd(app, yrd("prime", "--json"), prime.io), prime.stderr()).toBe(0)
    expect.soft(JSON.parse(prime.stdout())).toMatchObject({ command: "prime", live: { pr: "PR2", position: 2 } })

    const refusal = outputIO({ now, resolveQueueTarget })
    expect(await runYrd(app, yrd("pr", "merge", "PR2", "--json"), refusal.io)).toBe(1)
    expect.soft(JSON.parse(refusal.stderr())).toMatchObject({ command: "pr.merge", pr: "PR2", position: 2 })

    const json = outputIO({ now, resolveQueueTarget })
    expect(await runYrd(app, yrd("--json"), json.io), json.stderr()).toBe(0)
    expect(JSON.parse(json.stdout())).toMatchObject({
      results: [{ base: "main", headSha: "a".repeat(40), prs: [{ id: "PR1" }, { id: "PR2" }] }],
    })
  })

  it("sorts deduplicated alias and canonical run collections by startedAt then run id", async () => {
    const merge = (
      runInternals as typeof runInternals & {
        mergedQueueRuns?: (
          canonical: QueueSummary,
          aliases: readonly QueueSummary[],
        ) => Pick<QueueSummary, "running" | "waiting" | "finished">
      }
    ).mergedQueueRuns
    expect(merge).toBeTypeOf("function")
    if (merge === undefined) return
    const tied = ["R10", "R1", "R2"].map((id) =>
      fakeRun({ id, status: "failed", steps: [], startedAt: "2026-07-09T12:00:00.000Z" }),
    )
    expect(
      merge(fakeSummary([tied[2]!]), [fakeSummary([tied[0]!, tied[1]!, tied[2]!])]).finished.map(({ id }) => id),
    ).toEqual(["R1", "R2", "R10"])

    const app = await createApp()
    await app.bays.submit({ branch: "issue/canonical", headSha: "1".repeat(40), base: "main" })
    expect((await app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 }))[0]?.status).toBe("passed")
    await app.bays.submit({ branch: "issue/alias", headSha: "2".repeat(40), base: "origin/main" })
    expect((await app.queue.run({ prs: ["PR2"] }, { runner: "test", leaseMs: 60_000 }))[0]?.status).toBe("passed")
    const log = outputIO({
      resolveQueueTarget: (ref) => Promise.resolve({ base: ref === "origin/main" ? "main" : ref, sha: BASE_SHA }),
    })

    expect(await runYrd(app, yrd("log", "--json"), log.io), log.stderr()).toBe(0)
    const rows = (JSON.parse(log.stdout()) as { rows: ReturnType<typeof queueLogRows> }).rows
    expect(rows.map((row) => row.run)).toEqual(["R1", "R2"])
    expect(new Set(rows.map((row) => `${row.run}:${row.pr}`)).size).toBe(rows.length)
  })

  it("streams terminal log rows with stable revision/SHA proof and scope options", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    expect(await runYrd(app, yrd("queue", "run", "PR1"), outputIO().io)).toBe(0)

    const scoped = outputIO()
    expect(await runYrd(app, yrd("log", "--base", "main", "--pr", "PR1", "--json"), scoped.io)).toBe(0)
    const parsed = JSON.parse(scoped.stdout()) as {
      command: string
      rows: ReturnType<typeof queueLogRows>
    }
    expect(parsed.command).toBe("log")
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
    expect(await runYrd(app, yrd("log", "--base", "main"), human.io)).toBe(0)
    expect(human.stdout()).toContain("RUN")
    expect(human.stdout()).toContain("OUTCOME")
    expect(human.stdout()).toContain("PR1")
    expect(human.stdout()).toContain("integrated")
  })

  it("shows run proof slices, revisions, timings, evidence, checkpoint, and landing proof", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    expect(await runYrd(app, yrd("queue", "run", "PR1"), outputIO().io)).toBe(0)

    const human = outputIO({ color: true, columns: 200 })
    expect(await runYrd(app, yrd("pr", "runs", "PR1"), human.io)).toBe(0)
    expect(human.stdout()).toContain("RUN")
    expect(human.stdout()).toContain("STEP")
    expect(human.stdout()).toContain("REV")
    expect(human.stdout()).toContain("OUTPUT")
    expect(human.stdout()).toContain("CHECKPOINT")
    expect(human.stdout()).toContain("EVIDENCE")
    expect(human.stdout()).toContain("LANDING")
    expect(human.stdout()).toContain("check")

    const json = outputIO()
    expect(await runYrd(app, yrd("pr", "runs", "PR1", "--json"), json.io)).toBe(0)
    const parsed = JSON.parse(json.stdout()) as {
      command: string
      runs: ReturnType<typeof queueShowData>[]
    }
    expect(parsed.command).toBe("pr.runs")
    expect(parsed.runs[0]?.run).toBe("R1")
    expect(parsed.runs[0]?.steps).toHaveLength(2)
    expect(parsed.runs[0]?.steps[0]).toMatchObject({
      step: "check",
      revision: "check-v1",
      status: "passed",
    })
    expect(parsed.runs[0]?.steps[0]).toHaveProperty("detail")
    expect(parsed.runs[0]?.steps[0]).toHaveProperty("output")
    expect(parsed.runs[0]?.steps[0]).toHaveProperty("landing")
  })

  it("maps the 10-row log and PR-run contract matrix directly from canonical fields", async () => {
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
    const rows = queueLogRows([summary], new Set<string>(), undefined, statusByPr)
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
    const statusRows = queueStatusRows(
      { byId: {}, prs: { PR1: statusPr }, receipts: {} },
      { ...fakeSummary([runMissingLocation]), prs: [statusPr] },
      new Set(),
      Date.parse("2026-07-10T12:01:00.000Z"),
    )
    expect(statusRows[0]).toMatchObject({ artifactCount: 1 })
    expect(statusRows[0]).not.toHaveProperty("artifact")

    const failureShow = queueShowData(runChronologyFailure, [runChronologyFailure, runRetryAttemptTwo])
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

    const missingShow = queueShowData(runMissingLocation, [runMissingLocation])
    expect(missingShow.steps[0]).not.toHaveProperty("location")

    const retiredRows = queueLogRows([summary], new Set(["PR-retired"]), "PR-retired", statusByPr)
    expect(retiredRows).toHaveLength(1)
    expect(retiredRows[0]).toMatchObject({ outcome: "retired", run: "-", pr: "PR-retired" })
    expect(prRows.some((row) => row.outcome === "retired")).toBe(false)

    const show = queueShowData(runRetryAttemptTwo, [runChronologyFailure, runRetryAttemptTwo, runMissingLocation])
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
    const firstJournal = join(temp, ".git", "yrd", "events.jsonl")
    mkdirSync(join(temp, ".git", "bay"), { recursive: true })
    mkdirSync(join(temp, ".git", "yrd"), { recursive: true })
    writeFileSync(
      journal,
      Array.from({ length: 185 }, (_value, index) =>
        JSON.stringify({ ts: `2026-07-01T12:00:${String(index).padStart(2, "0")}.000Z` }),
      ).join("\n"),
    )
    writeFileSync(firstJournal, `${JSON.stringify({ ts: "2026-06-30T12:00:00.000Z" })}\n`)

    execFileSync("git", ["init", "-q", temp])
    const coverageApp = await createApp()
    await openAndSubmit(coverageApp)
    const liveLog = outputIO({ cwd: temp })
    expect(await runYrd(coverageApp, yrd("log", "--json"), liveLog.io), liveLog.stderr()).toBe(0)
    expect((JSON.parse(liveLog.stdout()) as { coverage: QueueLogCoverage }).coverage).toMatchObject({
      since: "2026-07-09T12:00:00.000Z",
      completeness: "queue-only",
      legacy: [
        { path: join(realpathSync(temp), ".git", "yrd", "events.jsonl"), frames: 1 },
        { path: join(realpathSync(temp), ".git", "bay", "journal.jsonl"), frames: 185 },
      ],
    })

    const withCoverage = coverageFixture(journal, 185)
    const renderedLogWithCoverage = await renderString(createElement(QueueLogView, { rows, coverage: withCoverage }), {
      width: 140,
      height: 24,
    })
    expect(renderedLogWithCoverage).not.toContain("Legacy queue coverage")
    expect(renderedLogWithCoverage).not.toContain("185")
    expect(renderedLogWithCoverage).toContain("R10")
    expect(renderedLogWithCoverage).not.toContain("c".repeat(40))

    const renderedLogNoCoverage = await renderString(createElement(QueueLogView, { rows }), {
      width: 140,
      height: 24,
    })
    expect(renderedLogNoCoverage).not.toContain("Legacy queue coverage")
    expect(renderedLogNoCoverage).not.toContain(missingArtifact)

    const ttyLog = await renderString(createElement(QueueLogView, { rows, coverage: withCoverage }), {
      width: 140,
      height: 24,
      plain: false,
    })
    const plainLog = await renderString(createElement(QueueLogView, { rows, coverage: withCoverage }), {
      width: 140,
      height: 24,
      plain: true,
    })
    expect(ttyLog).toContain("\u001b]8;;")
    expect(ttyLog).toContain(pathToFileURL(attemptOne).href)
    expect(ttyLog).toContain(pathToFileURL(attemptTwo).href)
    expect(ttyLog).toContain("https://ci.invalid/check")
    expect(plainLog).not.toContain("\u001b]8;;")
    const coverageOnlyTty = await renderString(createElement(QueueLogView, { rows: [], coverage: withCoverage }), {
      width: 140,
      height: 4,
      plain: false,
    })
    expect(coverageOnlyTty).not.toContain("\u001b]8;;")
    expect(JSON.parse(JSON.stringify({ command: "log", rows, coverage: withCoverage }))).toEqual({
      command: "log",
      rows,
      coverage: withCoverage,
    })

    const renderedShow = await renderString(createElement(QueueShowView, { data: show }), { width: 140, height: 40 })
    expect(renderedShow).toContain("check")
    expect(renderedShow).not.toContain(JOB_CHECK_PASS_ID)
    const ttyShow = await renderString(createElement(QueueShowView, { data: show }), {
      width: 140,
      height: 40,
      plain: false,
    })
    const plainShow = await renderString(createElement(QueueShowView, { data: show }), {
      width: 140,
      height: 40,
      plain: true,
    })
    expect(ttyShow).toContain("\u001b]8;;")
    expect(ttyShow).toContain(pathToFileURL(attemptTwo).href)
    expect(ttyShow).toContain("https://ci.invalid/check")
    expect(plainShow).not.toContain("\u001b]8;;")
    const queueShowJson = JSON.parse(JSON.stringify(show)) as typeof show
    expect(queueShowJson.steps[0]).toMatchObject({
      uuid: JOB_CHECK_PASS_ID,
      attempt: "2",
      duration: "2.0s",
    })

    rmSync(temp, { recursive: true, force: true })
  })

  it("fails loud when a legacy journal pointer cannot be read", async () => {
    const temp = mkdtempSync(join(tmpdir(), "yrd-legacy-unreadable-"))
    try {
      execFileSync("git", ["init", "-q", temp])
      mkdirSync(join(temp, ".git", "yrd", "events.jsonl"), { recursive: true })
      const app = await createApp()
      const output = outputIO({ cwd: temp })
      expect(await runYrd(app, yrd("log", "--json"), output.io)).toBe(3)
      expect(output.stdout()).toBe("")
      expect(output.stderr()).toMatch(/(?:EISDIR|illegal operation on a directory)/iu)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
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
    const attempts = await queueLogAttempts([
      EventSchema.parse({
        id: JOB_CHECK_PASS_ID,
        name: "job/requested",
        ts: "2026-07-12T11:01:16.930Z",
        data: {
          definition: "queue.step.check",
          revision: "check-v1",
          input: { run: "R4", step: "check", index: 0 },
          key: "queue:R4:0",
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
          runner: "yrd-cli",
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
          runner: "yrd-cli",
          result: { status: "passed", output: {} },
        },
      }),
      EventSchema.parse({
        id: JOB_PREPARE_PASS_ID,
        name: "job/requested",
        ts: "2026-07-12T11:08:36.216Z",
        data: {
          definition: "queue.step.merge",
          revision: "merge-v1",
          input: { run: "R4", step: "merge", index: 1 },
          key: "queue:R4:1",
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
          runner: "yrd-cli",
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
          runner: "yrd-cli",
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
          runner: "yrd-native-bootstrap",
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
          runner: "yrd-native-bootstrap",
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
        runner: "yrd-cli",
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
        runner: "yrd-cli",
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
        runner: "yrd-native-bootstrap",
        outcome: "passed",
        startedAt: "2026-07-12T11:48:59.829Z",
        finishedAt: "2026-07-12T11:49:24.335Z",
        durationMs: 24_506,
        result: { status: "passed", output: {} },
      },
    ])
    const show = queueShowData(run, [run], attempts)
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

    const showHuman = await renderString(createElement(QueueShowView, { data: show }), {
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
    expect(showHuman).toContain("ART art:stdout+stderr")
    expect(showHuman.split("\n").filter((row) => row.trimStart().startsWith("merge"))).toHaveLength(2)

    const showTty = await renderString(createElement(QueueShowView, { data: show }), {
      width: 200,
      height: 20,
      plain: false,
    })
    expect(showTty).toContain(pathToFileURL(stdout).href)
    expect(showTty).toContain(pathToFileURL(stderr).href)
    expect(JSON.parse(JSON.stringify({ command: "pr.runs", run: show }))).toMatchObject({
      command: "pr.runs",
      run: {
        totalDurationMs: 2_887_405,
        activeDurationMs: 685_869,
        waitDurationMs: 2_201_536,
        attempts: [{ attempt: 1 }, { attempt: 1 }, { attempt: 2 }],
      },
    })
    const rows = queueLogRows(
      [fakeSummary([run])],
      new Set<string>(),
      undefined,
      new Map([["PR23", "integrated"]]),
      attempts,
      new Map(),
      new Map([[queueRevisionKey(run.prs[0]!), "2026-07-12T10:49:24.335Z"]]),
    )

    const row = rows[0]
    if (row === undefined) throw new Error("missing history row")
    expect(row).toMatchObject({
      run: "R4",
      pr: "PR23",
      revision: "4",
      startedAt: "2026-07-12T11:01:16.930Z",
      ageMs: 3_600_000,
      totalDurationMs: 2_887_405,
      activeDurationMs: 685_869,
      waitDurationMs: 2_201_536,
      attempts: attempts.map(
        ({ job, run: attemptRun, step, index, attempt, runner, outcome, startedAt, finishedAt, durationMs }) => ({
          job,
          run: attemptRun,
          step,
          index,
          attempt,
          runner,
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

    const expectedHistory = new Map([
      [
        80,
        [
          "GLYPH TIME PR REV RUN OUTCOME ART SUBJECT AGE TOTAL",
          "[x] 11:01 PR23 r4 R4 integrated art:12 topic/R4 age=1h total=48:07 active=11:26…",
        ].join("\n"),
      ],
      [
        120,
        [
          "GLYPH TIME LEVEL [BASE] PR (REV,RUN) OUTCOME ART SUBJECT AGE TOTAL ACTIVE WAIT",
          "[x] 11:01:16 INFO [main] PR23 (rev4, run4) integrated art:12 topic/R4 age=1h total=48:07 active=11:26 wait=36:42",
        ].join("\n"),
      ],
    ])
    for (const width of [80, 120]) {
      const human = await renderString(createElement(QueueLogView, { rows, columns: width }), {
        width,
        height: 8,
        plain: true,
      })
      const physicalRows = human.split("\n").filter((row) => row.includes("R4"))
      expect(human).toBe(expectedHistory.get(width))
      expect(physicalRows).toHaveLength(1)
      expect(physicalRows[0]?.length).toBeLessThanOrEqual(width)
      expect(physicalRows[0]).toContain(width === 80 ? "PR23 r4 R4 integrated" : "PR23 (rev4, run4) integrated")
      expect(physicalRows[0]).toContain("48:07")
      expect(physicalRows[0]).toContain("11:26")
      if (width === 120) expect(physicalRows[0]).toContain("36:42")
      expect(physicalRows[0]).toContain("art:12")
      expect(human).not.toMatch(/\n\s*\n\s*\n/u)
      expect(human).not.toContain("stdout=/")
    }

    const hourRow = {
      ...row,
      subject: "topic",
      locations: [],
      totalDurationMs: 3_600_000,
      waitDurationMs: 0,
    }
    for (const width of [80, 120]) {
      const human = await renderString(createElement(QueueLogView, { rows: [hourRow], columns: width }), {
        width,
        height: 4,
        plain: true,
      })
      expect(human).toContain("total=1:00:00")
    }

    const crossDayRows = [
      {
        ...row,
        run: "R3",
        pr: "PR22",
        startedAt: "2026-07-11T23:59:58.000Z",
        started: "2026-07-11T23:59:58.000Z",
        locations: [],
      },
      row,
    ]
    for (const width of [80, 120]) {
      const human = await renderString(createElement(QueueLogView, { rows: crossDayRows, columns: width }), {
        width,
        height: 8,
        plain: true,
      })
      const physicalRows = human.split("\n").filter((row) => row.startsWith("[x]"))
      expect(physicalRows).toHaveLength(2)
      expect(physicalRows[0]).toContain("2026-07-12T11:01:16Z")
      expect(physicalRows[1]).toContain("2026-07-11T23:59:58Z")
      expect(Math.max(...physicalRows.map((row) => row.length))).toBeLessThanOrEqual(width)
    }

    const tty = await renderString(createElement(QueueLogView, { rows, columns: 80 }), {
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

  it("preserves the raw pinned-revision subject and immutable submitted-to-terminal age in machine history", () => {
    const headSha = "7".repeat(40)
    const subject = `fix(cli): ${"preserve the complete raw commit subject ".repeat(4).trim()}`
    const run = fakeRun({
      id: "R42",
      status: "failed",
      pr: { id: "PR42", revision: 7, headSha, baseSha: BASE_SHA },
      startedAt: "2026-07-12T11:10:00.000Z",
      finishedAt: "2026-07-12T11:20:00.000Z",
      steps: [
        fakeStep(
          "check",
          "failed",
          fakeJob({
            id: JOB_CHECK_FAILED_ID,
            status: "failed",
            error: { code: "check-failed", message: "failed" },
          }),
        ),
      ],
    })
    const key = queueRevisionKey(run.prs[0]!)
    const subjects = new Map([[key, subject]])
    const submissions = new Map([[key, "2026-07-12T11:00:00.000Z"]])
    const project = () =>
      queueLogRows(
        [fakeSummary([run])],
        new Set<string>(),
        undefined,
        new Map([["PR42", "rejected"]]),
        [],
        subjects,
        submissions,
      )[0]

    const first = project()
    const later = project()
    expect(first).toMatchObject({ subject, ageMs: 20 * 60_000, age: "20m00s" })
    expect(later).toMatchObject({ subject, ageMs: 20 * 60_000, age: "20m00s" })
    expect(first?.subject.length).toBeGreaterThan(80)
  })

  it("fails loud when attempt, run, step, or submission chronology goes backwards", async () => {
    const job = "00000000-0000-7000-8000-000000000901"
    await expect(
      queueLogAttempts([
        EventSchema.parse({
          id: job,
          name: "job/requested",
          ts: "2026-07-12T12:00:00.000Z",
          data: {
            definition: "queue.step.check",
            revision: "check-v1",
            input: { run: "R90", step: "check", index: 0 },
            key: "queue:R90:0",
          },
        }),
        EventSchema.parse({
          id: "00000000-0000-7000-8000-000000000902",
          name: "job/transitioned",
          ts: "2026-07-12T12:02:00.000Z",
          data: {
            type: "start",
            id: job,
            attempt: 1,
            runner: "clock-skewed",
            leaseExpiresAt: "2026-07-12T12:03:00.000Z",
          },
        }),
        EventSchema.parse({
          id: "00000000-0000-7000-8000-000000000903",
          name: "job/transitioned",
          ts: "2026-07-12T12:01:00.000Z",
          data: {
            type: "finish",
            id: job,
            attempt: 1,
            runner: "clock-skewed",
            result: { status: "passed", output: {} },
          },
        }),
      ]),
    ).rejects.toThrow(/precedes/u)

    const failedStep = (startedAt: string, finishedAt: string) =>
      fakeStep("check", "failed", fakeJob({ id: job, status: "failed", startedAt, finishedAt }))
    const project = (run: QueueRun, submittedAt = "2026-07-12T11:59:00.000Z") =>
      queueLogRows(
        [fakeSummary([run])],
        new Set<string>(),
        undefined,
        new Map([["PR1", "rejected"]]),
        [],
        new Map(),
        new Map([[queueRevisionKey(run.prs[0]!), submittedAt]]),
      )

    expect(() =>
      project(
        fakeRun({
          id: "R91",
          status: "failed",
          startedAt: "2026-07-12T12:02:00.000Z",
          finishedAt: "2026-07-12T12:01:00.000Z",
          steps: [failedStep("2026-07-12T12:00:00.000Z", "2026-07-12T12:01:00.000Z")],
        }),
      ),
    ).toThrow(/precedes/u)

    expect(() =>
      project(
        fakeRun({
          id: "R92",
          status: "failed",
          startedAt: "2026-07-12T12:00:00.000Z",
          finishedAt: "2026-07-12T12:03:00.000Z",
          steps: [failedStep("2026-07-12T12:02:00.000Z", "2026-07-12T12:01:00.000Z")],
        }),
      ),
    ).toThrow(/precedes/u)

    const valid = fakeRun({
      id: "R93",
      status: "failed",
      startedAt: "2026-07-12T12:00:00.000Z",
      finishedAt: "2026-07-12T12:01:00.000Z",
      steps: [failedStep("2026-07-12T12:00:00.000Z", "2026-07-12T12:01:00.000Z")],
    })
    expect(() => project(valid, "2026-07-12T12:02:00.000Z")).toThrow(/precedes/u)
  })

  it("fails loud when human projection chronology goes backwards", () => {
    const future = {
      id: "PR94",
      branch: "issue/future",
      base: "main",
      baseSha: BASE_SHA,
      status: "submitted",
      revision: 1,
      headSha: HEAD_SHA,
      revisions: [],
      submittedAt: "2026-07-12T12:05:00.000Z",
    } as PR
    const futureResult = {
      base: "main",
      prs: [future],
      running: [],
      waiting: [],
      finished: [],
    } as QueueStatusResult
    expect.soft(() => humanQueueProjection(futureResult, Date.parse("2026-07-12T12:00:00.000Z"))).toThrow(/precedes/u)

    const rejected = {
      ...future,
      id: "PR95",
      branch: "issue/backwards-run",
      status: "rejected",
      submittedAt: "2026-07-12T11:59:00.000Z",
      rejectedAt: "2026-07-12T12:01:00.000Z",
    } as PR
    const backwards = fakeRun({
      id: "R95",
      pr: { id: rejected.id, revision: rejected.revision, headSha: rejected.headSha, baseSha: rejected.baseSha },
      status: "failed",
      startedAt: "2026-07-12T12:02:00.000Z",
      finishedAt: "2026-07-12T12:01:00.000Z",
      steps: [],
      error: { code: "check-failed", message: "check failed" },
    })
    const backwardsResult = {
      base: "main",
      prs: [rejected],
      running: [],
      waiting: [],
      finished: [backwards],
    } as QueueStatusResult
    expect
      .soft(() => humanQueueProjection(backwardsResult, Date.parse("2026-07-12T12:03:00.000Z")))
      .toThrow(/precedes/u)
  })

  it("renders the newest twenty history records with subject, glyph, and bounded physical rows", async () => {
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
    const rows = queueLogRows([fakeSummary(runs)], new Set<string>(), undefined, new Map([["PR1", "rejected"]]), [])
    expect(rows).toHaveLength(22)
    expect(rows[0]).toMatchObject({
      branch: "fix(cli): bounded operator history",
      subject: "fix(cli): bounded operator history",
      glyph: "[!]",
    })

    for (const width of [80, 120]) {
      const human = await renderString(createElement(QueueLogView, { rows, columns: width }), {
        width,
        height: 24,
        plain: true,
      })
      const physicalRows = human.split("\n").filter((row) => /\bPR1\b/u.test(row))
      expect(physicalRows).toHaveLength(20)
      expect(physicalRows[0]).toContain(width === 80 ? "PR1 r1 R22 rejected" : "PR1 (rev1, run22) rejected")
      expect(physicalRows.at(-1)).toContain(width === 80 ? "PR1 r1 R3 rejected" : "PR1 (rev1, run3) rejected")
      expect(physicalRows[0]).toContain("[!]")
      expect(physicalRows[0]).toContain("fix(cli): bounded operator history")
      expect(Math.max(...human.split("\n").map((row) => row.length))).toBeLessThanOrEqual(width)
      expect(human).not.toContain(width === 80 ? "PR1 r1 R2 rejected" : "PR1 (rev1, run2) rejected")
      expect(human).not.toContain(width === 80 ? "PR1 r1 R1 rejected" : "PR1 (rev1, run1) rejected")
    }
  })

  it("runs a real issue contest to durable evidence, then selects and promotes the exact winner", async () => {
    const baseResolutions: string[] = []
    const app = await createApp({ baseResolutions })
    const compete = outputIO()
    expect(
      await runYrd(app, yrd("contest", "open", "km:T1", "--agents", "ag codex/claude", "--json"), compete.io),
    ).toBe(0)
    expect(JSON.parse(compete.stdout())).toMatchObject({
      command: "contest.open",
      contest: { id: "C1", status: "ready", attemptOrder: ["A1", "A2"], base: "main", baseSha: BASE_SHA },
    })
    expect(baseResolutions).toEqual(["main"])

    const human = outputIO({ columns: 96, color: true })
    expect(await runYrd(app, yrd("contest", "view", "C1"), human.io)).toBe(0)
    expect(human.stdout()).toContain("ATTEMPT")
    expect(human.stdout()).toContain("AGENT")
    expect(human.stdout()).toContain("TIME")
    expect(human.stdout()).toContain("TOKENS")
    expect(human.stdout()).toContain("COST")
    expect(human.stdout()).toContain("codex")
    expect(human.stdout()).toContain("claude")

    const evaluate = outputIO()
    expect(await runYrd(app, yrd("contest", "eval", "C1", "--json"), evaluate.io)).toBe(0)
    expect(JSON.parse(evaluate.stdout())).toMatchObject({
      command: "contest.eval",
      contest: { id: "C1", status: "ready" },
    })

    const select = outputIO()
    expect(await runYrd(app, yrd("contest", "select", "C1", "--winner", "A1", "--json"), select.io)).toBe(0)
    expect(JSON.parse(select.stdout())).toMatchObject({ contest: { selection: { attempt: "A1", method: "manual" } } })

    const frozen = outputIO()
    expect(await runYrd(app, yrd("contest", "eval", "C1", "--retry"), frozen.io)).toBe(1)
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
      await runYrd(app, yrd("contest", "open", "km:T1", "--agents", "ag codex/claude", "--json"), compete.io),
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
      await runYrd(app, yrd("contest", "open", "km:T1", "--agents", "ag codex/claude", "--json"), outputIO().io),
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

    expect(await runYrd(app, yrd("contest", "open", "km:T1", "--agents", "ag codex/claude"), compete.io)).toBe(0)
    expect(probe.max("bay")).toBe(2)
    expect(probe.max("runner")).toBe(2)
    expect(probe.max("evaluator")).toBe(2)
  })

  it("uses the documented exit taxonomy and keeps diagnostics off stdout", async () => {
    const app = await createApp()

    const usage = outputIO()
    expect(await runYrd(app, yrd("bay", "adopt", "old-branch"), usage.io)).toBe(2)
    expect(usage.stdout()).toBe("")
    expect(usage.stderr()).toContain("too many arguments")

    const refusal = outputIO()
    expect(await runYrd(app, yrd("bay", "close", "missing"), refusal.io)).toBe(1)
    expect(refusal.stdout()).toBe("")
    expect(refusal.stderr()).toContain("no bay 'missing'")

    const missingPR = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "PR404"), missingPR.io)).toBe(1)
    expect(missingPR.stderr()).toContain("no PR 'PR404'")

    const missingWaitingRun = outputIO()
    expect(
      await runYrd(
        app,
        yrd(
          "queue",
          "finish",
          "PR404",
          "--ok",
          "--job",
          "missing-job",
          "--runner",
          "missing-runner",
          "--attempt",
          "1",
          "--token",
          "missing-token",
        ),
        missingWaitingRun.io,
      ),
    ).toBe(1)
    expect(missingWaitingRun.stderr()).toContain("no queue run or PR 'PR404'")

    const unsupported = outputIO()
    expect(await runYrd(app, yrd("queue", "init"), unsupported.io)).toBe(2)
    expect(unsupported.stderr()).toContain("queue.init capability is not installed")

    const missingIssueSource = outputIO()
    expect(
      await runYrd(app, yrd("contest", "open", "github:42", "--agents", "ag codex/claude"), missingIssueSource.io),
    ).toBe(2)
    expect(missingIssueSource.stderr()).toContain("no issue source 'github' is registered")

    const infrastructure = outputIO({
      resolveRevision: async () => {
        throw new Error("corrupt event log at row 4")
      },
    })
    expect(await runYrd(app, yrd(), infrastructure.io)).toBe(3)
    expect(infrastructure.stdout()).toBe("")
    expect(infrastructure.stderr()).toContain("corrupt event log")
  })

  it("projects installed queue administration and cancels an idle watch deterministically", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    await app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 })

    const coreAudit = outputIO()
    expect(await runYrd(app, yrd("queue", "audit", "--json"), coreAudit.io)).toBe(0)
    expect(JSON.parse(coreAudit.stdout())).toMatchObject({ findings: [] })

    const services: YrdCliServices = {
      queue: {
        auditEnvironment: async () => ({ findings: [{ code: "operator-finding", message: "inspect runner" }] }),
        provision: async (base?: string) => ({ base: base ?? "main", ready: true }),
        deprovision: async (base?: string) => ({ base: base ?? "main", released: true }),
      },
    }

    const init = outputIO()
    expect(await runYrd(app, yrd("queue", "init", "release/2.0", "--json"), init.io, services)).toBe(0)
    expect(JSON.parse(init.stdout())).toEqual({
      base: "release/2.0",
      command: "queue.init",
      result: { base: "release/2.0", ready: true },
    })

    const deinit = outputIO()
    expect(await runYrd(app, yrd("queue", "deinit", "release/2.0", "--json"), deinit.io, services)).toBe(0)
    expect(JSON.parse(deinit.stdout())).toEqual({
      base: "release/2.0",
      command: "queue.deinit",
      result: { base: "release/2.0", released: true },
    })

    const audit = outputIO()
    expect(await runYrd(app, yrd("queue", "audit", "--json"), audit.io, services)).toBe(1)
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
    expect(await runYrd(app, yrd("queue", "run", "--watch", "--interval", "1"), watch.io)).toBe(0)
    expect(watch.stdout()).toBe("")
    expect(sleeps).toEqual([1_000])
  })
})
