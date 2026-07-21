// @failure CLI projection diverges from installed Yrd capabilities or its documented process contract
// @level l2
// @consumer @yrd/cli

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { Database } from "bun:sqlite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { createBayJobDefs, withBays, type BayWorkspace, type PR } from "@yrd/bay"
import { runYrd, type YrdCliIO, type YrdCliServices } from "@yrd/cli"
import {
  Command,
  createMemoryJournal,
  createYrd,
  createYrdDef,
  EventSchema,
  JsonSchema,
  pipe,
  type Journal,
  type JsonValue,
} from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import { createExclusive, createJournal } from "@yrd/persistence"
import type { ProcessRequest, ProcessResult } from "@yrd/process"
import {
  Queues,
  type QueueRun,
  type QueueSummary,
  type PREligibility,
  withQueue,
  withMerge,
  withStep,
  type AddStepResult,
  type SourceRewrite,
  type PRShape,
  type StepExecution,
} from "@yrd/queue"
import { withIssues } from "@yrd/issue"
import { createElement, type ReactElement } from "react"
import { renderString, stripAnsi } from "silvery"
import { createRenderer } from "silvery/test"
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
  QueueRunsView,
  PRListView,
  PRDetailView,
  QueueDetailPrFacts,
  QueueTimelineView,
  QueueWatchView,
  activeWatchRow,
  humanQueueProjection,
  queueFlowMetrics,
  queueLogAttempts,
  queueLogRows,
  prListRows,
  queueRevisionKey,
  queueRunRevisionKey,
  queueTimelineAdmissionTimes,
  runRevisionClock,
  queueShowData,
  queueStatusRows,
  queueTimelineProjection,
  queueTimelineRows,
  QUEUE_TIMELINE_UNBOUNDED_WINDOW_MS,
  watchQueueRows,
  type QueueLogCoverage,
  type QueueAttempt,
  type QueueStatusResult,
  type QueueTerminalFact,
  type QueueTimelineProjection,
} from "../src/queue-status-view.tsx"
import { withLiveRenderer } from "../src/live-renderer.ts"
import * as runInternals from "../src/run.ts"
import { queueTimeStats } from "../src/time-stats.ts"
import { YRD_VERSION } from "../src/version.ts"
import { writeInstalledBaseline } from "../src/installed-baseline.ts"
import {
  jobAttemptTaskStatusOf,
  prTaskStatusOf,
  runTaskStatusOf,
  stepTaskStatusOf,
  taskStatusGlyph,
} from "../src/task-status.ts"
import { QueueWatchFrame, QueueWatchPane, queueDetailTier, type QueueWatchPaneProps } from "../src/watch-pane.tsx"

const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "1".repeat(40)
const MERGED_SHA = "b".repeat(40)
const JOB_PREPARE_PASS_ID = "00000000-0000-7000-8000-000000000101"
const JOB_CHECK_FAILED_ID = "00000000-0000-7000-8000-000000000102"
const JOB_DEPLOY_LOST_ID = "00000000-0000-7000-8000-000000000103"
const JOB_CHECK_PASS_ID = "00000000-0000-7000-8000-000000000104"
const JOB_CHECK_MISSING_ID = "00000000-0000-7000-8000-000000000105"
const sourceRowKey = ["li", "ne"].join("") as `${"li"}${"ne"}`

function submittedRevision(
  revision: number,
  headSha: string,
  submittedAt: string,
  terminal?: PR["revisions"][number]["terminal"],
): PR["revisions"][number] {
  return {
    revision,
    headSha,
    base: "main",
    baseSha: BASE_SHA,
    pushedAt: submittedAt,
    submittedAt,
    ...(terminal === undefined ? {} : { terminal }),
  }
}

function submittedRunClock(run: QueueRun, submittedAt: string) {
  const revision = run.prs[0]!
  return [
    queueRunRevisionKey(run, revision),
    {
      pr: revision.id,
      revision: revision.revision,
      headSha: revision.headSha,
      pushedAt: submittedAt,
      submittedAt,
      admittedBy: "submission" as const,
    },
  ] as const
}

type CheckedShape = AddStepResult<PRShape, "check", JsonValue>
type ProbeKind = "bay" | "runner" | "evaluator"
type OverlapProbe = {
  pause(kind: ProbeKind): Promise<void>
  max(kind: ProbeKind): number
}

function ids(start = 0): () => string {
  let value = start
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

function workspace(
  options: { dirty?: boolean; path?: string; refreshedHead?: string; probe?: OverlapProbe } = {},
): BayWorkspace {
  return {
    revision: "test-workspace-v1",
    async provision(input) {
      await options.probe?.pause("bay")
      return {
        status: "passed",
        output: { path: options.path ?? `/repo/.bays/${input.bay}`, headSha: HEAD_SHA, baseSha: BASE_SHA },
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
    bayPath?: string
    refreshedHead?: string
    probe?: OverlapProbe
    baseResolutions?: string[]
    batch?: false | number
    waitingEvaluator?: string
    mergeRuns?: string[]
    failingCheck?: boolean
    checkFailure?: Readonly<{ code: string; message: string; artifact?: string }>
    requires?: readonly ["review"]
    checkRuns?: string[]
    checkedRevisions?: string[]
    baseFailure?: boolean
    clock?: () => string
    mergeCommits?: readonly string[]
    mergeWait?: Readonly<{ started: () => void; until: Promise<void> }>
    sourceRewrites?: readonly SourceRewrite[]
    journal?: Journal<unknown>
  } = {},
) {
  const contest = contestAdapters(options.probe, options.baseResolutions, options.waitingEvaluator)
  const bayJobs = createBayJobDefs(
    workspace({
      dirty: options.dirtyBay,
      path: options.bayPath,
      refreshedHead: options.refreshedHead,
      probe: options.probe,
    }),
  )
  const check = withStep(
    "check",
    (input: StepExecution<PRShape>): JobResult<JsonValue> => {
      options.checkRuns?.push("check")
      options.checkedRevisions?.push(...input.prs.map((pr) => `${pr.id}@${pr.revision}`))
      return options.waitingCheck
        ? {
            status: "waiting",
            token: "remote-check",
            url: "https://ci.invalid/run/1",
            checkpoint: { baseSha: BASE_SHA, candidateSha: HEAD_SHA },
          }
        : options.baseFailure
          ? {
              status: "failed",
              error: { code: "base-red", message: "resolved base is red" },
              output: { detail: `[yrd-base-health] base ${BASE_SHA.slice(0, 12)} is red: test:fast failed` },
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
              ? {
                  status: "failed",
                  error: { code: "check-failed", message: "check failed" },
                  output: {
                    detail: `[yrd-base-health] base ${BASE_SHA.slice(0, 12)} green\nsrc/model.ts:12 - type mismatch`,
                    diagnostics: [{ file: "src/model.ts", [sourceRowKey]: 12, message: "type mismatch" }],
                    artifacts: [
                      { name: "stdout", path: "/tmp/base-green.log" },
                      { name: "stderr", path: "/tmp/yrd-check.log" },
                    ],
                  },
                }
              : { status: "passed", output: { checked: true } }
    },
    {
      revision: "check-v1",
      output: JsonSchema,
      classification: options.baseFailure === true ? "base" : "carrier",
    },
  )
  let mergeIndex = 0
  const merge = withMerge(
    async (
      _input: StepExecution<CheckedShape>,
    ): Promise<JobResult<{ commit: string; baseSha: string; sourceRewrites?: readonly SourceRewrite[] }>> => {
      options.mergeRuns?.push("merge")
      options.mergeWait?.started()
      if (options.mergeWait !== undefined) await options.mergeWait.until
      const commit = options.mergeCommits?.[mergeIndex++] ?? MERGED_SHA
      return {
        status: "passed",
        output: {
          commit,
          baseSha: commit,
          ...(options.sourceRewrites === undefined ? {} : { sourceRewrites: options.sourceRewrites }),
        },
      }
    },
    { revision: "merge-v1" },
  )
  const queue = withQueue({
    steps: [check, merge] as const,
    batch: options.batch ?? false,
    ...(options.requires === undefined ? {} : { requires: options.requires }),
  })
  const contests = withContests({ runners: [contest.runner], evaluators: [contest.evaluator], git: contest.git })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs, contests.jobDefs] }),
    withIssues({ sources: [{ id: "km", resolve: (ref) => ({ ref, title: "Issue one" }) }] }),
    withBays({
      jobs: bayJobs,
      defaultBase: "main",
      resolveBase: (base) => ({ base, baseSha: BASE_SHA }),
    }),
  )
  return createYrd(contests(queue(base)), {
    inject: {
      journal: options.journal ?? createMemoryJournal(),
      clock: options.clock ?? (() => "2026-07-09T12:00:00.000Z"),
      id: ids(),
      // Match production DI (host.ts injects the CLI logger). Without this the
      // app falls back to createLogger("yrd") — loggily's default console
      // transport — and incidental warn/error lifecycle logs (yrd:jobs,
      // yrd:queue) leak to console.error, tripping km's setup.ts console-output
      // gate. Silent because these tests assert on io.stdout/stderr, not logs.
      log: createLogger("yrd", [{ level: "silent" }]),
    },
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
  error?: { code: string; message: string; evidence?: JsonValue }
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
  // Queue clocks render in the system-local timezone, so pin a deterministic,
  // DST-free zone (+5:30 catches minute-offset bugs) for the wall-clock assertions.
  let priorTZ: string | undefined
  beforeAll(() => {
    priorTZ = process.env.TZ
    process.env.TZ = "Asia/Kolkata"
  })
  afterAll(() => {
    if (priorTZ === undefined) delete process.env.TZ
    else process.env.TZ = priorTZ
  })

  it("projects git bay onto the public bay subtree and exposes no internal operations", async () => {
    const app = await createApp()
    const gitHelp = outputIO()
    expect(await runYrd(app, gitBay("--help"), gitHelp.io)).toBe(0)
    expect(gitHelp.stdout()).toContain("Usage: git bay")
    expect(gitHelp.stdout()).toContain("open")
    expect(gitHelp.stdout()).toContain("path")
    expect(gitHelp.stdout()).toContain("refresh")
    expect(gitHelp.stdout()).toContain("submit")
    expect(gitHelp.stdout()).toContain("close")
    expect(gitHelp.stdout()).not.toContain("--repo")
    expect(gitHelp.stdout()).not.toContain("--cwd")
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

  it.each([
    { name: "yrd bay", argv: yrd("bay", "submit", "topic/draft", "--draft", "--json") },
    { name: "git bay", argv: gitBay("submit", "topic/draft", "--draft", "--json") },
  ])("draft-registers a pushed PR through $name without admission", async ({ argv }) => {
    const app = await createApp()
    const output = outputIO({ resolveRevision: () => Promise.resolve(HEAD_SHA) })

    expect(await runYrd(app, argv, output.io), output.stderr()).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({
      command: "bay.submit",
      prs: [{ id: "PR1", branch: "topic/draft", status: "pushed", revision: 1 }],
    })
    expect(app.bays.checksRequested("PR1")).toBe(false)
    expect(Queues.ids(app.state().queues)).toEqual([])
  })

  it("uses concise layered help with examples on the root and queue surfaces", async () => {
    const app = await createApp()
    const root = outputIO({ columns: 100 })
    expect(await runYrd(app, yrd("--help"), root.io)).toBe(0)
    const rootHelp = root.stdout()
    expect(rootHelp).toContain("yrd (shipyard) — agentic software delivery")
    expect(rootHelp).toMatch(/^Model:\n\s+Pick an issue\b/mu)
    expect(rootHelp).toMatch(/^Objects:\n\s+issue\b/mu)
    expect(rootHelp).toMatch(/^Boundaries:\n\s+Runs\b/mu)
    expect(rootHelp).toMatch(/^Examples:\n\s+\$ yrd bay open\b/mu)
    expect(rootHelp).not.toMatch(/\b(?:pr\|prs|bay\|bays|issue\|issues|contest\|contests|queue\|queues)\b/u)

    const queue = outputIO({ columns: 100 })
    expect(await runYrd(app, yrd("queue", "--help"), queue.io)).toBe(0)
    const queueHelp = queue.stdout()
    expect(queueHelp).toContain("manage integration queues")
    expect(queueHelp).toMatch(/^\s+list\b/mu)
    expect(queueHelp).not.toMatch(/^\s+ls\b/mu)
    expect(queueHelp).toMatch(/^\s+init\b/mu)
    expect(queueHelp).toMatch(/^\s+deinit\b/mu)
    expect(queueHelp).not.toMatch(/^\s+(?:provision|deprovision)\b/mu)
    expect(queueHelp).toMatch(/^Examples:\n\s+\$ yrd queue\b/mu)
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
    for (const command of ["submit", "view", "runs", "diff", "checkout", "status", "edit", "close"]) {
      expect(pr.stdout()).toMatch(new RegExp(`^\\s+${command}\\b`, "mu"))
    }
    expect(pr.stdout()).not.toMatch(/^\s+retry\b/mu)

    const beforeRetiredRetry = await Array.fromAsync(app.events()).then((events) => events.length)
    const retiredRetry = outputIO()
    expect(await runYrd(app, yrd("pr", "retry", "PR1"), retiredRetry.io)).toBe(2)
    expect(retiredRetry.stdout()).toBe("")
    expect(retiredRetry.stderr()).toContain("unknown command 'retry'")
    expect(await Array.fromAsync(app.events()).then((events) => events.length)).toBe(beforeRetiredRetry)

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
    expect(JSON.parse(submit.stdout())).toMatchObject({
      command: "pr.submit",
      prs: [{ branch: "topic/direct", status: "submitted", taskStatus: "wip", glyph: "▢" }],
    })

    const status = outputIO({ currentBranch: () => "topic/direct" })
    expect(await runYrd(app, yrd("pr", "status", "--json"), status.io), status.stderr()).toBe(0)
    expect(JSON.parse(status.stdout())).toMatchObject({
      command: "pr.status",
      pr: { branch: "topic/direct", status: "submitted", taskStatus: "wip", glyph: "▢" },
    })

    const prime = outputIO({ currentBranch: () => "topic/direct" })
    expect(await runYrd(app, yrd("prime", "--json"), prime.io), prime.stderr()).toBe(0)
    const briefing = JSON.parse(prime.stdout()) as Readonly<{ loop: readonly string[] }>
    expect(briefing).toMatchObject({ command: "prime", live: { pr: "PR1", base: "main" } })
    expect(briefing.loop).toContain("fix the branch and run yrd pr submit again")
    expect(briefing.loop.join("\n")).not.toMatch(/\bretry\b/u)

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

  it("Q1: resubmitting a landed branch reports already-merged for the same head and mints a fresh delivery for a new head", async () => {
    const app = await createApp()
    await app.bays.submit({ branch: "topic/landed", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    await app.bays.requestChecks({ pr: "PR1" })
    await app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 })
    expect(app.bays.pr("PR1")).toMatchObject({ branch: "topic/landed", status: "integrated" })
    const before = await Array.fromAsync(app.events())

    // Same landed head → informational "already merged", exit 0, no new PR, no event.
    const merged = outputIO({ resolveRevision: async () => HEAD_SHA })
    expect(await runYrd(app, yrd("pr", "submit", "topic/landed", "--json"), merged.io), merged.stderr()).toBe(0)
    const mergedOut = JSON.parse(merged.stdout()) as Readonly<{ prs: readonly { id: string; status: string }[]; warnings?: readonly string[] }>
    expect(mergedOut).toMatchObject({ command: "pr.submit", prs: [{ id: "PR1", status: "integrated" }] })
    expect((mergedOut.warnings ?? []).join("\n")).toContain("already merged as PR 'PR1'")
    expect(await Array.fromAsync(app.events())).toEqual(before)

    // New head → mints a fresh delivery PR (revision 1), exit 0, no hand-made delivery branch.
    const minted = outputIO({ resolveRevision: async () => "2".repeat(40) })
    expect(await runYrd(app, yrd("pr", "submit", "topic/landed", "--json"), minted.io), minted.stderr()).toBe(0)
    expect(JSON.parse(minted.stdout())).toMatchObject({
      command: "pr.submit",
      prs: [{ id: "PR2", branch: "topic/landed", status: "submitted" }],
    })
  })

  it("D8: a plain submit records without draining; a later run drains; --wait opts into the synchronous drain", async () => {
    const checkRuns: string[] = []
    const app = await createApp({ checkRuns })

    // Default submit is a ledger write: record `submitted` + request checks and
    // return 0, WITHOUT composing or draining. No check runs at submit time.
    const ledger = outputIO({ resolveRevision: async () => HEAD_SHA })
    expect(
      await runYrd(app, yrd("pr", "submit", "topic/ledger", "--base", "main", "--json"), ledger.io),
      ledger.stderr(),
    ).toBe(0)
    expect(JSON.parse(ledger.stdout())).toMatchObject({
      command: "pr.submit",
      prs: [{ branch: "topic/ledger", status: "submitted" }],
    })
    expect(checkRuns).toEqual([])

    // The submission is admission-eligible; a later queue run picks it up and
    // settles the check that submit deliberately did not run.
    await app.queue.run({}, { runner: "test", leaseMs: 60_000 })
    expect(checkRuns).toEqual(["check"])

    // --wait opts back into the pre-decouple synchronous drain: the check runs
    // inline during submit.
    const drained = outputIO({ resolveRevision: async () => "2".repeat(40) })
    expect(
      await runYrd(app, yrd("pr", "submit", "topic/wait", "--base", "main", "--wait", "--json"), drained.io),
      drained.stderr(),
    ).toBe(0)
    expect(checkRuns).toEqual(["check", "check"])
  })

  it.each([
    {
      surface: "pr view",
      args: ["pr", "view", "pr1", "--json"],
      expected: {
        command: "pr.view",
        pr: { id: "PR1" },
        landing: { outcome: "not-landed", status: "submitted" },
      },
    },
    {
      surface: "pr runs",
      args: ["pr", "runs", "pr1", "--json"],
      expected: { command: "pr.runs", pr: { id: "PR1" } },
    },
    {
      surface: "pr review",
      args: ["pr", "review", "pr1", "--approve", "--by", "@cto", "--json"],
      expected: { command: "pr.review", pr: { id: "PR1" } },
    },
    {
      surface: "PR resubmission",
      args: ["pr", "submit", "pr1", "--json"],
      expected: { command: "pr.submit", prs: [{ id: "PR1" }] },
    },
    {
      surface: "pr checks",
      args: ["pr", "checks", "pr1", "--json"],
      expected: { kind: "pr.check", pr: "PR1" },
    },
    {
      surface: "pr close",
      args: ["pr", "close", "pr1", "--json"],
      expected: { command: "pr.close", prs: [{ id: "PR1" }] },
    },
    {
      surface: "queue run",
      args: ["queue", "run", "pr1", "--json"],
      expected: { command: "queue.run", results: [{ prs: [{ id: "PR1" }] }] },
    },
    {
      surface: "pr list base filter",
      args: ["pr", "list", "--base", "MAIN", "--json"],
      expected: { command: "pr.list", prs: [{ id: "PR1", base: "main" }] },
    },
    {
      surface: "queue list base filter",
      args: ["queue", "--base", "MAIN", "--json"],
      expected: { command: "queue.list", results: [{ base: "main", prs: [{ id: "PR1" }] }] },
    },
    {
      surface: "dashboard base filter",
      args: ["--base", "MAIN", "--json"],
      expected: { command: "dashboard", results: [{ base: "main", prs: [{ id: "PR1" }] }] },
    },
    {
      surface: "log PR filter",
      args: ["log", "--pr", "pr1", "--json"],
      expected: { command: "log", rows: [{ pr: "PR1", run: "R1" }] },
    },
  ])("resolves case-insensitive selectors on $surface and preserves canonical output", async ({ args, expected }) => {
    const app = await createApp()
    await openAndSubmit(app)
    if (args[0] === "log") await app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 })
    const output = outputIO()

    expect(await runYrd(app, yrd(...args), output.io), output.stderr()).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject(expected)
  })

  it("keeps merge teaching case-insensitive while naming the canonical PR", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    const output = outputIO()

    expect(await runYrd(app, yrd("pr", "merge", "pr1", "--json"), output.io)).toBe(1)
    expect(JSON.parse(output.stderr())).toMatchObject({ command: "pr.merge", pr: "PR1" })
  })

  it("applies canonical PR and base scopes to bounded watch projections", async () => {
    const app = await createApp()
    await openAndSubmit(app)

    for (const scope of [
      ["--pr", "pr1"],
      ["--base", "MAIN"],
    ] as const) {
      const controller = new AbortController()
      controller.abort()
      const output = outputIO({ scope: { signal: controller.signal, sleep: async () => {} } })
      expect(await runYrd(app, yrd("watch", ...scope, "--json"), output.io), output.stderr()).toBe(0)
      expect(JSON.parse(output.stdout())).toMatchObject({
        command: "queue.list",
        results: [{ base: "main", prs: [{ id: "PR1" }] }],
      })
    }
  })

  // Composed defaults: item K keeps the LISTING window unbounded (show
  // everything unless --since is given) while flow metrics (21089) keep their
  // own bounded 24h horizon — unbounded rates would be meaningless.
  it("defaults flow metrics to a 24h window while the listing window stays unbounded; --since wins both", async () => {
    const app = await createApp()
    await openAndSubmit(app)

    const fresh = outputIO()
    expect(await runYrd(app, yrd("queue", "list", "--json"), fresh.io), fresh.stderr()).toBe(0)
    const defaults = (JSON.parse(fresh.stdout()) as { projection: QueueTimelineProjection }).projection
    expect(defaults.filters.windowMs).toBe(QUEUE_TIMELINE_UNBOUNDED_WINDOW_MS)
    expect(defaults.metrics.windowMs).toBe(24 * 60 * 60_000)

    const scoped = outputIO()
    expect(await runYrd(app, yrd("queue", "list", "--since", "3h", "--json"), scoped.io), scoped.stderr()).toBe(0)
    const explicit = (JSON.parse(scoped.stdout()) as { projection: QueueTimelineProjection }).projection
    expect(explicit.filters.windowMs).toBe(3 * 60 * 60_000)
    expect(explicit.metrics.windowMs).toBe(3 * 60 * 60_000)
  })

  it("canonicalizes pause allowlists and queue administration base selectors", async () => {
    const app = await createApp()
    await openAndSubmit(app)

    const pause = outputIO()
    expect(
      await runYrd(
        app,
        yrd("queue", "pause", "MAIN", "--reason", "selector proof", "--allow", "pr1", "--json"),
        pause.io,
      ),
      pause.stderr(),
    ).toBe(0)
    expect(JSON.parse(pause.stdout())).toMatchObject({
      command: "queue.pause",
      pause: { base: "main", allowedPRs: ["PR1"] },
    })

    const resume = outputIO()
    expect(await runYrd(app, yrd("queue", "resume", "MAIN", "--json"), resume.io), resume.stderr()).toBe(0)
    expect(JSON.parse(resume.stdout())).toMatchObject({ command: "queue.resume", base: "main" })

    const bases: string[] = []
    const services: YrdCliServices = {
      queue: {
        provision: async (base) => {
          bases.push(base ?? "main")
          return { ready: true }
        },
      },
    }
    const init = outputIO()
    expect(await runYrd(app, yrd("queue", "init", "ORIGIN/MAIN", "--json"), init.io, services), init.stderr()).toBe(0)
    expect(JSON.parse(init.stdout())).toMatchObject({ command: "queue.init", base: "main" })
    expect(bases).toEqual(["main"])
  })

  it("reports folded selector collisions instead of choosing the first base", async () => {
    const app = await createApp()
    await app.bays.submit({ branch: "Topic/One", headSha: HEAD_SHA, base: "Main" })
    await app.bays.submit({ branch: "Topic/Two", headSha: MERGED_SHA, base: "main" })
    const output = outputIO()

    expect(await runYrd(app, yrd("queue", "--base", "MAIN", "--json"), output.io)).toBe(1)
    expect(output.stderr()).toContain("base selector 'MAIN' is ambiguous: Main, main")
  })

  it("projects every delivery object through one stable five-state vocabulary", () => {
    expect(
      (["pushed", "submitted", "rejected", "integrated", "withdrawn", "canceled"] as const).map((status) =>
        prTaskStatusOf({ status }),
      ),
    ).toEqual(["todo", "wip", "blocked", "done", "dropped", "dropped"])
    expect(
      (["queued", "running", "waiting", "failed", "passed", "retired", "canceled"] as const).map((status) =>
        runTaskStatusOf({ status }),
      ),
    ).toEqual(["todo", "wip", "wip", "blocked", "done", "dropped", "dropped"])
    expect(
      (["requested", "started", "running", "waiting", "failed", "lost", "passed", "superseded"] as const).map(
        (status) => jobAttemptTaskStatusOf({ status }),
      ),
    ).toEqual(["todo", "wip", "wip", "wip", "blocked", "blocked", "done", "dropped"])
    expect(
      (["pending", "running", "failed", "passed", "skipped"] as const).map((status) => stepTaskStatusOf({ status })),
    ).toEqual(["todo", "wip", "blocked", "done", "dropped"])
    expect((["todo", "wip", "blocked", "done", "dropped"] as const).map(taskStatusGlyph)).toEqual([
      "▢",
      "▢",
      "⧗",
      "✓",
      "−",
    ])
  })

  it("keeps the human and JSON PR status projections in parity", async () => {
    const app = await createApp()
    await openAndSubmit(app)

    const json = outputIO()
    expect(await runYrd(app, yrd("pr", "view", "PR1", "--json"), json.io), json.stderr()).toBe(0)
    const projected = (JSON.parse(json.stdout()) as { pr: { taskStatus: string; glyph: string } }).pr
    expect(projected).toMatchObject({ taskStatus: "wip", glyph: "▢" })

    const human = outputIO({ columns: 120 })
    expect(await runYrd(app, yrd("pr", "view", "PR1"), human.io), human.stderr()).toBe(0)
    expect(human.stdout()).toContain(projected.glyph)
    expect(human.stdout()).toContain("submitted")
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
    expect(humanStatus.stdout()).toContain("STATUS submitted")
    expect(humanStatus.stdout()).toContain("POSITION 6")
    expect(humanStatus.stdout()).toContain("pr#6.1")
    expect(humanStatus.stdout()).toContain("▢")

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

  it("windows only the unfiltered human PR list and never wraps revision counts", async () => {
    const app = await createApp()
    for (const index of Array.from({ length: 520 }, (_, offset) => offset + 1)) {
      await app.bays.submit({
        branch: `topic/list-${index}`,
        headSha: index.toString(16).padStart(40, "0"),
        base: "main",
      })
    }

    const expected = Array.from({ length: 20 }, (_, offset) => `PR${offset + 501}`)
    for (const columns of [80, 120]) {
      const human = outputIO({ columns })
      expect(await runYrd(app, yrd("pr", "list"), human.io), human.stderr()).toBe(0)
      const physical = stripAnsi(human.stdout())
        .split("\n")
        .filter((row) => row !== "")
      expect(physical).toHaveLength(expected.length + 1)
      expect(physical.slice(1).map((row) => row.match(/pr#(\d+)\.1/u)?.[1])).toEqual(expected.map((id) => id.slice(2)))
      expect(physical).not.toContainEqual(expect.stringMatching(/^\s*\d+\s*$/u))
    }

    const json = outputIO()
    expect(await runYrd(app, yrd("pr", "list", "--json"), json.io), json.stderr()).toBe(0)
    const jsonIds = (JSON.parse(json.stdout()) as { prs: readonly PR[] }).prs.map(({ id }) => id)
    expect(jsonIds).toHaveLength(520)
    expect(jsonIds.at(0)).toBe("PR1")
    expect(jsonIds.at(-1)).toBe("PR520")

    const filtered = outputIO({ columns: 120 })
    expect(await runYrd(app, yrd("pr", "list", "--base", "main"), filtered.io), filtered.stderr()).toBe(0)
    expect(stripAnsi(filtered.stdout()).split("\n").filter(Boolean)).toHaveLength(521)
  })

  it("executes bare projections with their canonical JSON discriminators", async () => {
    const app = await createApp()
    const surfaces = [
      { args: ["--json"], command: "dashboard" },
      { args: ["queue", "--json"], command: "queue.list" },
      { args: ["pr", "list", "--json"], command: "pr.list" },
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

  it("keeps bare pr on noun help and makes list plus ls the explicit lossless projection", async () => {
    const app = await createApp()
    await app.bays.submit({ branch: "topic/one", headSha: HEAD_SHA, base: "main" })

    const help = outputIO({ columns: 80 })
    expect(await runYrd(app, yrd("pr"), help.io), help.stderr()).toBe(0)
    expect(help.stdout()).toContain("Usage: yrd pr [options] [command]")
    expect(help.stdout()).toContain("list [options]")
    expect(help.stdout()).not.toMatch(/^PR\s+BRANCH/mu)

    for (const verb of ["list", "ls"]) {
      const json = outputIO()
      expect(await runYrd(app, yrd("pr", verb, "--json"), json.io), json.stderr()).toBe(0)
      expect(JSON.parse(json.stdout())).toMatchObject({
        command: "pr.list",
        prs: [{ id: "PR1", branch: "topic/one", eligibility: { revision: 1 } }],
      })
    }
  })

  it("exposes the canonical same-PR recut command", async () => {
    const app = await createApp()
    const submitHelp = outputIO({ columns: 100 })
    const help = outputIO({ columns: 100 })

    expect(await runYrd(app, yrd("pr", "submit", "--help"), submitHelp.io), submitHelp.stderr()).toBe(0)
    expect(submitHelp.stdout()).toContain("Authored root carrier")
    expect(submitHelp.stdout()).toContain("$ yrd pr submit <branch> --draft")
    expect(submitHelp.stdout()).toContain("$ yrd pr recut <PR> --queue")
    expect(submitHelp.stdout()).toMatch(/no\s+composition\s+manifest or manual recut/u)

    expect(await runYrd(app, yrd("pr", "recut", "--help"), help.io), help.stderr()).toBe(0)
    expect(help.stdout()).toContain("Usage: yrd pr recut [options] <selector>")
    expect(help.stdout()).toContain("--revision <number>")
    expect(help.stdout()).toContain("--queue")
    expect(help.stdout()).toContain("--json")
    expect(help.stdout()).toContain("Authored root carrier")
    expect(help.stdout()).toContain("$ yrd pr submit <branch> --draft")
    expect(help.stdout()).toContain("$ yrd pr recut <PR> --queue")
    expect(help.stdout()).toMatch(/no\s+composition\s+manifest or manual recut/u)
  })

  it("draft-registers an authored carrier and queues a recut revision on the same PR", async () => {
    const checkedRevisions: string[] = []
    const app = await createApp({ waitingCheck: true, checkedRevisions })
    const nextHead = "2".repeat(40)
    const nextBase = "b".repeat(40)
    const treeSha = "c".repeat(40)
    const patchId = "d".repeat(40)
    const services = {
      recut: {
        recut() {
          return Promise.resolve({
            headSha: nextHead,
            baseSha: nextBase,
            treeSha,
            patchId,
            unchanged: false,
          })
        },
      },
    } as unknown as YrdCliServices
    const submitted = outputIO({ resolveRevision: () => Promise.resolve(HEAD_SHA) })

    expect(
      await runYrd(app, yrd("pr", "submit", "topic/root-carrier", "--draft", "--json"), submitted.io),
      submitted.stderr(),
    ).toBe(0)
    expect(JSON.parse(submitted.stdout())).toMatchObject({
      command: "pr.submit",
      prs: [{ id: "PR1", branch: "topic/root-carrier", status: "pushed", revision: 1 }],
    })
    expect(app.bays.checksRequested("PR1")).toBe(false)
    expect(Queues.ids(app.state().queues)).toEqual([])
    expect(checkedRevisions).toEqual([])

    const recut = outputIO()
    expect(await runYrd(app, yrd("pr", "recut", "PR1", "--queue", "--json"), recut.io, services)).toBe(0)
    expect(JSON.parse(recut.stdout())).toMatchObject({
      pr: "PR1",
      revision: 2,
      baseSha: nextBase,
      treeSha,
      patchId,
      lineage: [1, 2],
      unchanged: false,
    })
    expect(app.bays.pr("PR1")).toMatchObject({
      id: "PR1",
      branch: "topic/root-carrier",
      status: "submitted",
      revision: 2,
      headSha: nextHead,
      revisions: [
        { revision: 1, headSha: HEAD_SHA },
        { revision: 2, headSha: nextHead },
      ],
    })
    expect(app.queue.get("R1")).toMatchObject({
      status: "waiting",
      prs: [{ id: "PR1", revision: 2, headSha: nextHead }],
    })
    expect(Queues.ids(app.state().queues)).toEqual(["R1"])
    expect(Object.keys(app.state().bays.prs)).toEqual(["PR1"])
    expect(checkedRevisions).toEqual(["PR1@2"])
  })

  it("forwards a same-issue integrated source composition when recutting an authored carrier", async () => {
    const issue = "@ag/super/21075-role-rotation/21142-authored-root-flow"
    const rewrite: SourceRewrite = {
      repo: "vendor/yrd",
      branch: "task/21142-source",
      oldBaseSha: "3".repeat(40),
      oldTipSha: "4".repeat(40),
      newBaseSha: "5".repeat(40),
      newTipSha: "6".repeat(40),
      candidateRef: "refs/yrd/candidates/R1/merge/attempt-1-source",
      patchId: "7".repeat(40),
      rangeDiff: "=",
      payload: ["packages/yrd-cli/src/run.ts", "packages/yrd-queue/src/command.ts"],
    }
    const shadow: SourceRewrite = {
      ...rewrite,
      branch: "task/21142-repair",
      oldBaseSha: "8".repeat(40),
      oldTipSha: "9".repeat(40),
      newBaseSha: "a".repeat(40),
      newTipSha: "b".repeat(40),
      candidateRef: "refs/yrd/candidates/R2/merge/attempt-1-repair",
      patchId: "c".repeat(40),
      payload: ["packages/yrd-cli/src/run.ts"],
    }
    const behavior = { sourceRewrites: [rewrite] }
    const app = await createApp(behavior)
    await app.bays.submit({
      branch: "task/21142-source",
      base: "main",
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      issue,
    })
    await app.bays.requestChecks({ pr: "PR1" })
    const landed = outputIO()
    expect(
      await runYrd(app, yrd("queue", "run", "PR1", "--steps", "check,merge", "--json"), landed.io),
      landed.stderr(),
    ).toBe(0)
    expect(app.bays.pr("PR1")).toMatchObject({ status: "integrated", issue })

    behavior.sourceRewrites = [shadow]
    await app.bays.submit({
      branch: "task/21142-repair",
      base: "main",
      baseSha: BASE_SHA,
      headSha: "d".repeat(40),
      issue,
    })
    await app.bays.requestChecks({ pr: "PR2" })
    const repaired = outputIO()
    expect(
      await runYrd(app, yrd("queue", "run", "PR2", "--steps", "check,merge", "--json"), repaired.io),
      repaired.stderr(),
    ).toBe(0)
    expect(app.bays.pr("PR2")).toMatchObject({ status: "integrated", issue })

    await app.bays.submit({
      branch: "task/21142-root",
      base: "main",
      baseSha: BASE_SHA,
      headSha: "2".repeat(40),
      issue,
      draft: true,
    })
    const requests: unknown[] = []
    const services = {
      recut: {
        recut(input: unknown) {
          requests.push(input)
          return Promise.resolve({
            headSha: "8".repeat(40),
            baseSha: "9".repeat(40),
            treeSha: "a".repeat(40),
            patchId: "b".repeat(40),
            unchanged: false,
          })
        },
      },
    } as unknown as YrdCliServices
    const recut = outputIO()

    expect(await runYrd(app, yrd("pr", "recut", "PR3", "--queue", "--json"), recut.io, services)).toBe(0)
    expect(requests).toEqual([
      expect.objectContaining({
        id: "PR3",
        currentCompositions: [shadow, rewrite].map((source) => ({
          version: 1,
          sources: [
            {
              repo: source.repo,
              branch: source.candidateRef,
              baseSha: source.newBaseSha,
              tipSha: source.newTipSha,
              payload: source.payload,
            },
          ],
        })),
      }),
    ])
  })

  it("certifies and queues a pin-only authored carrier after draft registration", async () => {
    const checkedRevisions: string[] = []
    const app = await createApp({ waitingCheck: true, checkedRevisions })
    const treeSha = "c".repeat(40)
    const patchId = "d".repeat(40)
    const services = {
      recut: {
        recut() {
          return Promise.resolve({
            headSha: HEAD_SHA,
            baseSha: BASE_SHA,
            treeSha,
            patchId,
            unchanged: true,
          })
        },
      },
    } as unknown as YrdCliServices
    const submitted = outputIO({ resolveRevision: () => Promise.resolve(HEAD_SHA) })

    expect(
      await runYrd(app, yrd("pr", "submit", "topic/pin-only", "--draft", "--json"), submitted.io),
      submitted.stderr(),
    ).toBe(0)
    expect(app.bays.checksRequested("PR1")).toBe(false)
    expect(Queues.ids(app.state().queues)).toEqual([])
    expect(checkedRevisions).toEqual([])

    const recut = outputIO()
    expect(await runYrd(app, yrd("pr", "recut", "PR1", "--queue", "--json"), recut.io, services)).toBe(0)
    expect(JSON.parse(recut.stdout())).toMatchObject({
      pr: "PR1",
      revision: 2,
      baseSha: BASE_SHA,
      treeSha,
      patchId,
      lineage: [1, 2],
      unchanged: false,
    })
    expect(app.bays.pr("PR1")).toMatchObject({
      status: "submitted",
      revision: 2,
      headSha: HEAD_SHA,
      recut: { fromRevision: 1, treeSha, patchId },
      revisions: [
        { revision: 1, headSha: HEAD_SHA },
        { revision: 2, headSha: HEAD_SHA, recut: { fromRevision: 1, treeSha, patchId } },
      ],
    })
    expect(app.queue.get("R1")).toMatchObject({
      status: "waiting",
      prs: [{ id: "PR1", revision: 2, headSha: HEAD_SHA, baseSha: BASE_SHA }],
    })
    expect(Queues.ids(app.state().queues)).toEqual(["R1"])
    expect(checkedRevisions).toEqual(["PR1@2"])
  })

  it("keeps unrelated members runnable when a recut supersedes their shared predecessor batch", async () => {
    const app = await createApp({ batch: 2, waitingCheck: true })
    await openAndSubmit(app)
    expect(await runYrd(app, yrd("bay", "open", "two"), outputIO().io)).toBe(0)
    expect(await runYrd(app, yrd("bay", "submit"), outputIO({ cwd: "/repo/.bays/B2" }).io)).toBe(0)
    expect(await app.queue.run({ prs: ["PR1", "PR2"] }, { runner: "cli-test", leaseMs: 60_000 })).toMatchObject([
      {
        id: "R1",
        status: "waiting",
        prs: [
          { id: "PR1", revision: 1 },
          { id: "PR2", revision: 1 },
        ],
      },
    ])

    const services = {
      recut: {
        recut() {
          return Promise.resolve({
            headSha: "3".repeat(40),
            baseSha: "b".repeat(40),
            treeSha: "c".repeat(40),
            patchId: "d".repeat(40),
            unchanged: false,
          })
        },
      },
    } as unknown as YrdCliServices
    const recut = outputIO()

    expect(await runYrd(app, yrd("pr", "recut", "PR1", "--queue", "--json"), recut.io, services)).toBe(0)
    expect(app.queue.get("R1")).toMatchObject({
      status: "failed",
      error: { code: "stale-pr" },
    })
    expect(app.queue.get("R1")?.steps[0]?.job).toMatchObject({ status: "canceled" })
    expect(app.queue.get("R2")).toMatchObject({
      status: "waiting",
      prs: [{ id: "PR1", revision: 2 }],
    })
    expect(app.bays.pr("PR2")).toMatchObject({ status: "submitted", revision: 1 })
    expect(app.queue.eligibility("PR2")).toMatchObject({ runnable: true })
  })

  it("cancels an active predecessor job before admitting a recut revision", async () => {
    const app = await createApp({ waitingCheck: true })
    await app.bays.submit({ branch: "issue/recut", headSha: HEAD_SHA, baseSha: BASE_SHA })
    await app.bays.requestChecks({ pr: "PR1" })
    expect(await app.queue.admit({ prs: ["PR1"] })).toMatchObject([
      {
        id: "R1",
        status: "running",
        prs: [{ id: "PR1", revision: 1 }],
        steps: [{ name: "check", job: { status: "requested" } }],
      },
    ])
    const services = {
      recut: {
        recut() {
          return Promise.resolve({
            headSha: "2".repeat(40),
            baseSha: "b".repeat(40),
            treeSha: "c".repeat(40),
            patchId: "d".repeat(40),
            unchanged: false,
          })
        },
      },
    } as unknown as YrdCliServices

    const output = outputIO()
    expect(await runYrd(app, yrd("pr", "recut", "PR1", "--queue", "--json"), output.io, services)).toBe(0)

    expect(app.queue.get("R1")).toMatchObject({
      status: "failed",
      error: { code: "stale-pr" },
      steps: [{ name: "check", job: { status: "canceled" } }],
    })
    expect(app.queue.get("R2")).toMatchObject({
      status: "waiting",
      prs: [{ id: "PR1", revision: 2 }],
    })
  })

  it("run cancel re-queues a waiting run's PRs (submitted), not rejected (#59)", async () => {
    const app = await createApp({ waitingCheck: true })
    await openAndSubmit(app)
    // Drain PR1 into a resident run: the waiting check leaves R1 non-terminal.
    expect(await app.queue.run({ prs: ["PR1"] }, { runner: "cli-test", leaseMs: 60_000 })).toMatchObject([
      { id: "R1", status: "waiting", prs: [{ id: "PR1", revision: 1 }] },
    ])

    const cancel = outputIO()
    expect(await runYrd(app, yrd("run", "cancel", "R1"), cancel.io), cancel.stderr()).toBe(0)
    expect(cancel.stdout()).toContain("re-queued")

    // The run is terminal-canceled and its active check job is aborted...
    expect(app.queue.get("R1")).toMatchObject({ status: "canceled" })
    expect(app.queue.get("R1")?.steps[0]?.job).toMatchObject({ status: "canceled" })
    // ...but the member PR is NOT rejected/canceled — it stays submitted, so a
    // future drain re-queues it. That is the cancel-vs-reject distinction.
    expect(app.bays.pr("PR1")).toMatchObject({ status: "submitted", revision: 1 })
    expect(app.queue.eligibility("PR1")).toMatchObject({ runnable: true })

    // A recovery pass reconciles runs whose active job is terminal (the canceled
    // check job qualifies). The canceled run must STAY inert here — recovery must
    // not turn a cancel into a pr/canceled and strip PR1 out of the queue. This is
    // the load-bearing guard: without it, recovery rejects/cancels the member PR.
    await app.queue.recover({ recoveryTime: "2026-07-09T12:05:00.000Z", reason: "resident restart" })
    expect(app.bays.pr("PR1")).toMatchObject({ status: "submitted", revision: 1 })

    // Prove the re-queue: a fresh drain admits PR1 into a NEW run, not R1.
    const redrain = await app.queue.run({ prs: ["PR1"] }, { runner: "cli-test", leaseMs: 60_000 })
    expect(redrain.some((run) => run.id !== "R1" && run.prs.some((member) => member.id === "PR1"))).toBe(true)
  })

  it("run cancel refuses a terminal run (#59)", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    // Drain PR1 to completion: R1 is terminal (passed/integrated), not cancelable.
    expect(await runYrd(app, yrd("queue", "run", "--once", "--json"), outputIO().io)).toBe(0)
    const cancel = outputIO()
    expect(await runYrd(app, yrd("run", "cancel", "R1"), cancel.io)).not.toBe(0)
    expect(cancel.stderr()).toContain("only a running or waiting run")
  })

  it("admits only the recut target when an unrelated terminal predecessor consumed checks authority", async () => {
    const behavior = { failingCheck: true, waitingCheck: false }
    const app = await createApp(behavior)
    await app.bays.submit({ branch: "issue/terminal", headSha: HEAD_SHA, baseSha: BASE_SHA })
    await app.bays.requestChecks({ pr: "PR1" })
    expect(await app.queue.admit({ prs: ["PR1"] }, { runner: "yrd-cli", leaseMs: 5 * 60_000 })).toMatchObject([
      {
        id: "R1",
        status: "failed",
        prs: [{ id: "PR1", revision: 1 }],
      },
    ])

    // Keep the recut target pending so only the unrelated predecessor is terminal.
    behavior.failingCheck = false
    behavior.waitingCheck = true
    await app.bays.submit({ branch: "issue/recut", headSha: "2".repeat(40), baseSha: BASE_SHA })
    const services = {
      recut: {
        recut() {
          return Promise.resolve({
            headSha: "3".repeat(40),
            baseSha: "b".repeat(40),
            treeSha: "c".repeat(40),
            patchId: "d".repeat(40),
            unchanged: false,
          })
        },
      },
    } as unknown as YrdCliServices

    const output = outputIO()
    expect(await runYrd(app, yrd("pr", "recut", "PR2", "--queue", "--json"), output.io, services)).toBe(0)

    expect(app.queue.get("R1")).toMatchObject({
      id: "R1",
      status: "failed",
      error: { code: "check-failed" },
      prs: [{ id: "PR1", revision: 1 }],
      steps: [{ name: "check", job: { status: "failed" } }],
    })
    expect(app.queue.get("R2")).toMatchObject({
      id: "R2",
      status: "waiting",
      prs: [{ id: "PR2", revision: 2 }],
    })
  })

  it("recuts the selected immutable revision on the same PR and optionally readies its fresh checks", async () => {
    let clockTick = 0
    const checkRuns: string[] = []
    const mergeRuns: string[] = []
    const app = await createApp({
      requires: ["review"],
      waitingCheck: true,
      checkRuns,
      mergeRuns,
      clock: () => new Date(Date.parse("2026-07-09T10:00:00.000Z") + clockTick++ * 60_000).toISOString(),
    })
    const nextHead = "2".repeat(40)
    const nextBase = "b".repeat(40)
    const treeSha = "c".repeat(40)
    const patchId = "d".repeat(40)
    const correlation = { namespace: "tribe-request", id: "recut-identity" }
    const requests: unknown[] = []
    const services = {
      recut: {
        recut(input: unknown) {
          requests.push(input)
          return Promise.resolve({
            headSha: nextHead,
            baseSha: nextBase,
            treeSha,
            patchId,
            unchanged: false,
          })
        },
      },
    } as unknown as YrdCliServices
    await app.bays.submit({ branch: "issue/recut", headSha: HEAD_SHA, baseSha: BASE_SHA, correlation })
    const sourceReadyAt = app.bays.pr("PR1")?.revisions[0]?.submittedAt
    if (sourceReadyAt === undefined) throw new Error("missing first revision submission clock")
    await app.bays.review({ pr: "PR1", actor: "@cto", decision: "approve", ref: "review-r1" })
    await app.bays.requestChecks({ pr: "PR1" })
    expect(await app.queue.admit({ prs: ["PR1"] })).toMatchObject([
      {
        id: "R1",
        status: "running",
        prs: [{ id: "PR1", revision: 1, headSha: HEAD_SHA, correlation }],
        steps: [{ name: "check", job: { status: "requested" } }],
      },
    ])
    expect(checkRuns).toEqual([])
    expect(mergeRuns).toEqual([])
    const output = outputIO()

    expect(await runYrd(app, yrd("pr", "recut", "PR1", "--queue", "--json"), output.io, services)).toBe(0)

    expect(requests).toEqual([
      expect.objectContaining({
        id: "PR1",
        branch: "issue/recut",
        base: "main",
        revision: 1,
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
        correlation,
      }),
    ])
    expect(JSON.parse(output.stdout())).toMatchObject({
      pr: "PR1",
      revision: 2,
      baseSha: nextBase,
      treeSha,
      patchId,
      reviewCarried: true,
      correlation,
      sourceReadyAt,
      lineage: [1, 2],
      unchanged: false,
    })
    expect(app.bays.pr("PR1")).toMatchObject({
      id: "PR1",
      status: "submitted",
      revision: 2,
      headSha: nextHead,
      correlation,
      recut: { fromRevision: 1, treeSha, patchId, reviewCarried: true },
      revisions: [
        { revision: 1, correlation, submittedAt: sourceReadyAt },
        { revision: 2, correlation, submittedAt: expect.any(String) },
      ],
    })
    expect(app.bays.pr("PR1")?.revisions[1]?.submittedAt).not.toBe(sourceReadyAt)
    expect(app.bays.reviewState("PR1")).toMatchObject({
      approved: true,
      current: { carriedFrom: { revision: 1, headSha: HEAD_SHA } },
    })
    expect(app.bays.checksRequested("PR1")).toBe(true)
    expect(app.queue.get("R1")).toMatchObject({
      id: "R1",
      status: "failed",
      error: { code: "stale-pr" },
      prs: [{ id: "PR1", revision: 1, headSha: HEAD_SHA, correlation }],
    })
    expect(app.queue.get("R2")).toMatchObject({
      id: "R2",
      status: "waiting",
      prs: [{ id: "PR1", revision: 2, headSha: nextHead, baseSha: nextBase, correlation }],
      steps: [{ name: "check", job: { status: "waiting" } }],
    })
    expect(Queues.ids(app.state().queues)).toEqual(["R1", "R2"])
    expect(Object.keys(app.state().bays.prs)).toEqual(["PR1"])
    expect(checkRuns).toEqual(["check"])
    expect(mergeRuns).toEqual([])

    const status = outputIO({ now: () => Date.parse("2026-07-09T12:00:00.000Z") })
    expect(await runYrd(app, yrd("pr", "list"), status.io, services)).toBe(0)
    expect(status.stdout()).toContain("LINEAGE")
    expect(status.stdout()).toContain("1→2")

    const detail = outputIO({ now: () => Date.parse("2026-07-09T12:00:00.000Z") })
    expect(await runYrd(app, yrd("pr", "view", "PR1"), detail.io, services)).toBe(0)
    expect(detail.stdout()).toContain(`SOURCE READY ${sourceReadyAt}`)
    expect(detail.stdout()).toContain("LINEAGE rev1→rev2")

    const repeated = outputIO()
    expect(await runYrd(app, yrd("pr", "recut", "PR1", "--revision", "1", "--json"), repeated.io, services)).toBe(0)
    expect(JSON.parse(repeated.stdout())).toMatchObject({ revision: 2, unchanged: true })
    expect(app.bays.pr("PR1")?.revisions).toHaveLength(2)
  })

  it("recomputes the certificate after an authored revision supersedes a recut head", async () => {
    const app = await createApp()
    const branch = "issue/recut-then-author"
    const recutHead = "2".repeat(40)
    const authoredHead = "3".repeat(40)
    const successorHead = "4".repeat(40)
    const oldTreeSha = "c".repeat(40)
    const oldPatchId = "d".repeat(40)
    const nextTreeSha = "e".repeat(40)
    const nextPatchId = "f".repeat(40)

    await app.bays.submit({ branch, headSha: HEAD_SHA, baseSha: BASE_SHA, draft: true })
    await app.bays.recut({
      pr: "PR1",
      fromRevision: 1,
      headSha: recutHead,
      baseSha: BASE_SHA,
      treeSha: oldTreeSha,
      patchId: oldPatchId,
      reviewCarried: false,
    })
    await app.bays.intake({ branch, headSha: authoredHead, base: "main", baseSha: BASE_SHA })

    const requests: unknown[] = []
    const services = {
      recut: {
        recut(input: unknown) {
          requests.push(input)
          return Promise.resolve({
            headSha: successorHead,
            baseSha: "b".repeat(40),
            treeSha: nextTreeSha,
            patchId: nextPatchId,
            unchanged: false,
          })
        },
      },
    } as unknown as YrdCliServices
    const output = outputIO()

    expect(await runYrd(app, yrd("pr", "recut", "PR1", "--json"), output.io, services)).toBe(0)

    expect(requests).toHaveLength(1)
    expect(requests[0]).not.toHaveProperty("current")
    expect(app.bays.pr("PR1")).toMatchObject({
      revision: 4,
      headSha: successorHead,
      recut: { fromRevision: 3, treeSha: nextTreeSha, patchId: nextPatchId },
      revisions: [
        { revision: 1, headSha: HEAD_SHA },
        { revision: 2, headSha: recutHead, recut: { fromRevision: 1, treeSha: oldTreeSha, patchId: oldPatchId } },
        { revision: 3, headSha: authoredHead },
        { revision: 4, headSha: successorHead, recut: { fromRevision: 3 } },
      ],
    })
  })

  it("refuses to recut a PR whose current head already holds a passing check unless forced", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    if (!app.bays.checksRequested("PR1")) await app.bays.requestChecks({ pr: "PR1" })
    // Drive the current revision's check to green: admit runs the pre-integration
    // check step (leaseMs/runner => the admission is drained, not just enqueued).
    await app.queue.admit({ prs: ["PR1"] }, { runner: "cli-test", leaseMs: 60_000 })
    expect(app.queue.eligibility("PR1").checks.status).toBe("passed")

    let recutCalls = 0
    const services = {
      recut: {
        recut() {
          recutCalls += 1
          return Promise.resolve({
            headSha: "2".repeat(40),
            baseSha: "b".repeat(40),
            treeSha: "c".repeat(40),
            patchId: "d".repeat(40),
            unchanged: false,
          })
        },
      },
    } as unknown as YrdCliServices

    // Without --force the recut is refused so nobody mechanically discards the green check.
    const refused = outputIO()
    expect(await runYrd(app, yrd("pr", "recut", "PR1"), refused.io, services)).toBe(1)
    expect(refused.stderr()).toContain("passing check")
    expect(refused.stderr()).toContain("--force")
    expect(recutCalls).toBe(0)
    // The passing check survives and the current revision is untouched.
    expect(app.queue.eligibility("PR1").checks.status).toBe("passed")
    expect(app.bays.pr("PR1")).toMatchObject({ revision: 1, headSha: HEAD_SHA })

    // With --force the recut proceeds exactly as before the guard.
    const forced = outputIO()
    expect(
      await runYrd(app, yrd("pr", "recut", "PR1", "--force", "--json"), forced.io, services),
      forced.stderr(),
    ).toBe(0)
    expect(recutCalls).toBe(1)
    expect(JSON.parse(forced.stdout())).toMatchObject({ pr: "PR1", revision: 2, unchanged: false })
  })

  it("renders one shared PR projection at 80 and 120 columns without cropped semantic headers", async () => {
    const revision = (
      headSha: string,
      pushedAt: string,
      submittedAt?: string,
      terminal?: PR["revisions"][number]["terminal"],
      actor?: string,
    ): PR["revisions"][number] => ({
      revision: 1,
      headSha,
      base: "main",
      baseSha: BASE_SHA,
      pushedAt,
      ...(submittedAt === undefined ? {} : { submittedAt }),
      ...(terminal === undefined ? {} : { terminal }),
      ...(actor === undefined ? {} : { actor }),
    })
    const pr = (id: string, branch: string, status: PR["status"], clock: PR["revisions"][number]): PR => ({
      id,
      branch,
      base: clock.base,
      status,
      revision: 1,
      headSha: clock.headSha,
      baseSha: BASE_SHA,
      revisions: [clock],
      reviews: [],
      comments: [],
      checkRequests: [],
      ...(clock.submittedAt === undefined ? {} : { submittedAt: clock.submittedAt }),
      ...(status === "rejected" ? { rejectedAt: clock.terminal?.at } : {}),
      ...(status === "integrated" ? { integratedAt: clock.terminal?.at } : {}),
    })
    const review = { required: false, approved: false, stale: false } as const
    const entries: ReadonlyArray<Readonly<{ pr: PR; eligibility: PREligibility }>> = [
      {
        pr: pr(
          "PR1",
          "task/a-branch-name-that-is-deliberately-long-enough-to-yield-before-semantic-columns",
          "pushed",
          revision("1".repeat(40), "2026-07-09T12:00:00.000Z"),
        ),
        eligibility: {
          pr: "PR1",
          revision: 1,
          runnable: false,
          reason: { code: "draft", message: "not ready" },
          review,
          checks: { status: "not-requested" },
        },
      },
      {
        pr: pr(
          "PR2",
          "topic/review",
          "submitted",
          revision("2".repeat(40), "2026-07-09T12:01:00.000Z", "2026-07-09T12:01:00.000Z", undefined, "@ci"),
        ),
        eligibility: {
          pr: "PR2",
          revision: 1,
          runnable: false,
          reason: { code: "review-required", message: "needs approval" },
          review: { required: true, approved: false, stale: false },
          checks: { status: "not-requested" },
        },
      },
      {
        pr: pr("PR3", "topic/checks", "pushed", {
          ...revision("3".repeat(40), "2026-07-09T12:02:00.000Z"),
          base: "release/2.0",
        }),
        eligibility: {
          pr: "PR3",
          revision: 1,
          runnable: false,
          reason: { code: "checks-failed", message: "checks failed" },
          review,
          checks: { status: "failed", run: "R3" },
        },
      },
      {
        pr: pr(
          "PR4",
          "topic/rejected",
          "rejected",
          revision("4".repeat(40), "2026-07-09T11:00:00.000Z", "2026-07-09T11:00:00.000Z", {
            status: "rejected",
            at: "2026-07-09T11:05:00.000Z",
          }),
        ),
        eligibility: {
          pr: "PR4",
          revision: 1,
          runnable: false,
          reason: { code: "rejected", message: "rejected" },
          review,
          checks: { status: "not-requested" },
        },
      },
      {
        pr: pr(
          "PR5",
          "topic/integrated",
          "integrated",
          revision("5".repeat(40), "2026-07-09T10:00:00.000Z", "2026-07-09T10:00:00.000Z", {
            status: "integrated",
            at: "2026-07-09T10:10:00.000Z",
          }),
        ),
        eligibility: {
          pr: "PR5",
          revision: 1,
          runnable: false,
          reason: { code: "terminal", message: "integrated" },
          review: { required: true, approved: true, stale: false, decision: "approve", actor: "@cto" },
          checks: { status: "passed", run: "R5" },
        },
      },
    ]

    const rows = prListRows(entries, [], Date.parse("2026-07-09T12:10:00.000Z"))
    // The current revision's submitter surfaces in the BY column; PRs whose revision
    // predates submitter identity fall back to "-".
    expect(rows.map(({ pr: id, submitter }) => ({ id, submitter }))).toEqual([
      { id: "PR1", submitter: "-" },
      { id: "PR2", submitter: "@ci" },
      { id: "PR3", submitter: "-" },
      { id: "PR4", submitter: "-" },
      { id: "PR5", submitter: "-" },
    ])
    expect(
      rows.map(({ pr: id, state, glyph, review: reviewState, checks, why }) => ({
        id,
        state,
        glyph,
        review: reviewState,
        checks,
        why,
      })),
    ).toEqual([
      { id: "PR1", state: "pushed", glyph: "▢", review: "n/a", checks: "n/a", why: "draft" },
      { id: "PR2", state: "submitted", glyph: "▢", review: "need", checks: "n/a", why: "review-required" },
      { id: "PR3", state: "pushed", glyph: "▢", review: "n/a", checks: "fail", why: "checks-failed" },
      { id: "PR4", state: "rejected", glyph: "⧗", review: "n/a", checks: "n/a", why: "rejected" },
      { id: "PR5", state: "integrated", glyph: "✓", review: "ok", checks: "pass", why: "terminal" },
    ])
    expect(rows[2]?.target).toBe("release/2.0")

    for (const columns of [80, 120]) {
      const human = await renderString(createElement(PRListView, { rows, columns }), {
        width: columns,
        height: entries.length + 1,
        plain: true,
      })
      const physical = human.split("\n").filter((row) => row !== "")
      expect(physical).toHaveLength(entries.length + 1)
      expect(Math.max(...physical.map((row) => row.length))).toBeLessThanOrEqual(columns)
      for (const header of ["PR", "STATE", "REV", "SUBJECT", "REVIEW", "CHECKS", "WHY"]) {
        expect(physical[0]).toContain(header)
      }
      expect(physical[0]).not.toContain("READY")
      expect(physical[0]).not.toMatch(/\sC$/u)
      expect(human).toContain("⧗ rejected")
      expect(human).toContain("✓ integrated")
      expect(human).not.toContain(entries[0]!.pr.branch)
      expect(physical[0]?.trim().split(/\s+/u).includes("AGE")).toBe(columns === 120)
      expect(physical[0]?.includes("BASE")).toBe(columns === 120)
      expect(physical[0]?.includes("CHANGED")).toBe(columns === 120)
      expect(human.includes("release/2.0")).toBe(columns === 120)
      // BY is a wide-only column (>=110); it carries PR2's submitter and hides on the narrow tier.
      expect(physical[0]?.includes("BY")).toBe(columns === 120)
      expect(human.includes("@ci")).toBe(columns === 120)
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

  it("supports bounded, failed-only, and recent log projections", async () => {
    const app = await createApp()
    for (let index = 1; index <= 3; index += 1) {
      await app.bays.submit({
        branch: `topic/log-filter-${index}`,
        headSha: String(index).repeat(40),
        base: "main",
      })
      await app.queue.run({ prs: [`PR${index}`] }, { runner: "test", leaseMs: 60_000 })
    }

    const rows = (stdout: string) => (JSON.parse(stdout) as { rows: readonly { outcome: string }[] }).rows

    const limited = outputIO()
    expect(await runYrd(app, yrd("log", "-L", "2", "--json"), limited.io), limited.stderr()).toBe(0)
    expect(rows(limited.stdout())).toHaveLength(2)

    const failed = outputIO()
    expect(await runYrd(app, yrd("log", "--failed", "--json"), failed.io), failed.stderr()).toBe(0)
    expect(rows(failed.stdout())).toEqual([])

    const recent = outputIO({ now: () => Date.parse("2026-07-09T12:30:00.000Z") })
    expect(await runYrd(app, yrd("log", "--since", "1m", "--json"), recent.io), recent.stderr()).toBe(0)
    expect(rows(recent.stdout())).toEqual([])

    const all = outputIO()
    expect(await runYrd(app, yrd("log", "--all", "--json"), all.io), all.stderr()).toBe(0)
    expect(rows(all.stdout())).toHaveLength(3)
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

  it("teaches inspect-and-resubmit when pr merge is invoked for rejected work", async () => {
    const app = await createApp({ failingCheck: true })
    await openAndSubmit(app)
    await app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 })
    const before = await Array.fromAsync(app.events()).then((events) => events.length)
    const output = outputIO()
    expect(await runYrd(app, yrd("pr", "merge", "PR1", "--json"), output.io)).toBe(1)
    const refusal = JSON.parse(output.stderr()) as Readonly<{
      guidance: Readonly<{ inspect: string; resubmit: string }>
    }>
    expect(refusal).toMatchObject({
      command: "pr.merge",
      status: "rejected",
      next: "yrd pr runs PR1",
    })
    expect(refusal.guidance).toEqual({
      inspect: "yrd pr runs PR1",
      resubmit: "fix the branch and run yrd pr submit again",
    })
    expect(await Array.fromAsync(app.events()).then((events) => events.length)).toBe(before)
  })

  it("runs submission checks while leaving integration to queue run", async () => {
    const checkRuns: string[] = []
    const mergeRuns: string[] = []
    const app = await createApp({ checkRuns, mergeRuns })
    const open = outputIO()
    expect(await runYrd(app, yrd("bay", "open", "one"), open.io), open.stderr()).toBe(0)

    const submit = outputIO({ cwd: "/repo/.bays/B1" })
    expect(await runYrd(app, yrd("pr", "submit"), submit.io), submit.stderr()).toBe(0)
    expect(app.state().bays.prs.PR1).toMatchObject({ status: "submitted" })
    expect(app.queue.get("R1")).toMatchObject({ id: "R1", status: "passed", steps: [{ name: "check" }] })
    expect(checkRuns).toEqual(["check"])
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
    expect(Queues.values(app.state().queues)).toHaveLength(2)
  })

  it("settles a direct submission predecessor without running it under the executing runtime", async () => {
    const checkedRevisions: string[] = []
    const app = await createApp({ checkedRevisions })
    await app.bays.submit({
      branch: "topic/direct",
      headSha: HEAD_SHA,
      base: "main",
    })
    await app.bays.requestChecks({ pr: "PR1" })
    expect(await app.queue.admit({ prs: ["PR1"] })).toMatchObject([
      {
        id: "R1",
        prs: [{ id: "PR1", revision: 1, headSha: HEAD_SHA }],
        steps: [{ name: "check", job: { status: "requested" } }],
      },
    ])

    const submit = outputIO({ resolveRevision: () => Promise.resolve(MERGED_SHA) })
    expect(await runYrd(app, yrd("pr", "submit", "topic/direct", "--json"), submit.io), submit.stderr()).toBe(0)

    expect(checkedRevisions).toEqual(["PR1@2"])
    expect(app.queue.get("R1")).toMatchObject({
      status: "failed",
      error: { code: "stale-pr" },
      prs: [{ id: "PR1", revision: 1, headSha: HEAD_SHA }],
      steps: [{ name: "check", job: { status: "requested" } }],
    })
    const run = app.queue.get("R2")
    const runtimeRevision = app.jobs.definition("queue.step.check").revision
    expect(run).toMatchObject({
      prs: [{ id: "PR1", revision: 2, headSha: MERGED_SHA }],
      steps: [{ name: "check", revision: runtimeRevision, job: { revision: runtimeRevision, status: "passed" } }],
    })
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
    expect(await runYrd(app, yrd("pr", "list"), prs.io), prs.stderr()).toBe(0)
    expect(prs.stdout()).toContain("pr#1.1")

    const queues = outputIO()
    expect(await runYrd(app, yrd("queue"), queues.io), queues.stderr()).toBe(0)
    expect(queues.stdout()).toContain("main")

    for (const noun of ["prs", "bays", "issues", "contests", "queues"]) {
      const alias = outputIO()
      expect(await runYrd(app, yrd(noun, "--help"), alias.io), noun).toBe(0)
      expect(alias.stdout(), noun).not.toMatch(new RegExp(`^\\s+${noun}\\b`, "mu"))
    }

    const prSubmit = outputIO({ columns: 100 })
    expect(await runYrd(app, yrd("pr", "submit", "--help"), prSubmit.io)).toBe(0)
    expect(prSubmit.stdout()).toContain("--base <branch>")
    expect(prSubmit.stdout()).not.toContain(`--${["li", "ne"].join("")} <branch>`)
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

  it("certifies exact-head handoff readiness and exposes the shared lifecycle projection", async () => {
    const app = await createApp()
    const open = outputIO()
    expect(await runYrd(app, yrd("bay", "open", "handoff-cli", "--json"), open.io), open.stderr()).toBe(0)

    const before = outputIO()
    expect(await runYrd(app, yrd("bay", "--json"), before.io), before.stderr()).toBe(0)
    expect(JSON.parse(before.stdout())).toMatchObject({
      command: "bay.list",
      lifecycles: [{ bay: "B1", branch: "issue/handoff-cli", headSha: HEAD_SHA, status: "open" }],
    })

    const handoff = outputIO()
    expect(
      await runYrd(
        app,
        yrd(
          "bay",
          "handoff",
          "B1",
          "--branch",
          "issue/handoff-cli",
          "--head",
          HEAD_SHA,
          "--evidence",
          "@km/handoff/handoff-cli.md",
          "--json",
        ),
        handoff.io,
      ),
      handoff.stderr(),
    ).toBe(0)
    expect(JSON.parse(handoff.stdout())).toMatchObject({
      command: "bay.handoff",
      certification: { headSha: HEAD_SHA, evidence: "@km/handoff/handoff-cli.md" },
      lifecycle: {
        bay: "B1",
        branch: "issue/handoff-cli",
        headSha: HEAD_SHA,
        status: "handoff-ready",
        ready: { evidence: "@km/handoff/handoff-cli.md" },
      },
    })
  })

  it("returns the durable certification when an exact handoff retry is already submitted", async () => {
    const app = await createApp()
    const evidence = "@km/handoff/submitted-retry.md"
    const args = yrd(
      "bay",
      "handoff",
      "B1",
      "--branch",
      "issue/submitted-retry",
      "--head",
      HEAD_SHA,
      "--evidence",
      evidence,
      "--json",
    )
    const open = outputIO()
    expect(await runYrd(app, yrd("bay", "open", "submitted-retry", "--json"), open.io), open.stderr()).toBe(0)
    const first = outputIO()
    expect(await runYrd(app, args, first.io), first.stderr()).toBe(0)
    await app.bays.intake({ bay: "B1", headSha: HEAD_SHA })
    await app.bays.submit({ pr: "PR1" })

    const retry = outputIO()
    expect(await runYrd(app, args, retry.io), retry.stderr()).toBe(0)
    expect(JSON.parse(retry.stdout())).toMatchObject({
      command: "bay.handoff",
      certification: { headSha: HEAD_SHA, evidence },
      lifecycle: { bay: "B1", headSha: HEAD_SHA, status: "submitted" },
    })
  })

  it("refreshes the Bay before certifying a newly committed handoff head", async () => {
    const app = await createApp({ refreshedHead: MERGED_SHA })
    const open = outputIO()
    expect(await runYrd(app, yrd("bay", "open", "fresh-handoff", "--json"), open.io), open.stderr()).toBe(0)
    expect(app.bays.get("B1")).toMatchObject({ headSha: HEAD_SHA })

    const handoff = outputIO()
    expect(
      await runYrd(
        app,
        yrd(
          "bay",
          "handoff",
          "B1",
          "--branch",
          "issue/fresh-handoff",
          "--head",
          MERGED_SHA,
          "--evidence",
          "@km/handoff/fresh-handoff.md",
          "--json",
        ),
        handoff.io,
      ),
      handoff.stderr(),
    ).toBe(0)
    expect(app.bays.get("B1")).toMatchObject({ headSha: MERGED_SHA })
    expect(app.bays.branchLifecycles()[0]).toMatchObject({ status: "handoff-ready", headSha: MERGED_SHA })
    expect(Object.values(app.state().jobs.byId)).toContainEqual(
      expect.objectContaining({ definition: "bay.refresh", status: "passed" }),
    )
  })

  it.each([
    { surface: "yrd bay", command: (...args: string[]) => yrd("bay", ...args) },
    { surface: "git bay", command: (...args: string[]) => gitBay(...args) },
  ])("projects one active Bay path through canonical selectors on $surface", async ({ command }) => {
    const app = await createApp()
    const opened = outputIO()
    expect(await runYrd(app, command("open", "fix-readme", "--from", "topic/readme"), opened.io), opened.stderr()).toBe(
      0,
    )
    const beforePathEvents = await Array.fromAsync(app.events()).then((events) => events.length)

    for (const selector of ["B1", "fix-readme", "topic/readme"]) {
      const output = outputIO()
      expect(await runYrd(app, command("path", selector), output.io), output.stderr()).toBe(0)
      expect(output.stdout()).toBe("/repo/.bays/B1\n")
    }

    const json = outputIO()
    expect(await runYrd(app, command("path", "fix-readme", "--json"), json.io), json.stderr()).toBe(0)
    expect(JSON.parse(json.stdout())).toEqual({
      bay: "B1",
      command: "bay.path",
      path: "/repo/.bays/B1",
    })
    expect(await Array.fromAsync(app.events()).then((events) => events.length)).toBe(beforePathEvents)

    const longPath = `/repo/${"nested-segment/".repeat(12)}bay path with spaces/B1`
    const longApp = await createApp({ bayPath: longPath })
    const longOpened = outputIO()
    expect(await runYrd(longApp, command("open", "long-path"), longOpened.io), longOpened.stderr()).toBe(0)
    const narrow = outputIO({ columns: 12 })
    expect(await runYrd(longApp, command("path", "long-path"), narrow.io), narrow.stderr()).toBe(0)
    expect(narrow.stdout()).toBe(`${longPath}\n`)
  })

  it("refuses missing, ambiguous, inactive, and non-absolute Bay paths without mutating state", async () => {
    const app = await createApp()

    const missing = outputIO()
    expect(await runYrd(app, yrd("bay", "path", "missing"), missing.io)).toBe(1)
    expect(missing.stderr()).toContain("no bay 'missing'")
    expect(missing.stderr()).toContain("yrd bay")

    const first = outputIO()
    expect(await runYrd(app, yrd("bay", "open", "shared", "--from", "topic/one"), first.io), first.stderr()).toBe(0)
    const second = outputIO()
    expect(await runYrd(app, yrd("bay", "open", "other", "--from", "shared"), second.io), second.stderr()).toBe(0)
    const before = await Array.fromAsync(app.events()).then((events) => events.length)

    const ambiguous = outputIO()
    expect(await runYrd(app, yrd("bay", "path", "shared"), ambiguous.io)).toBe(1)
    expect(ambiguous.stderr()).toContain("Bay selector 'shared' is ambiguous: B1, B2")
    expect(await Array.fromAsync(app.events()).then((events) => events.length)).toBe(before)

    const closed = outputIO()
    expect(await runYrd(app, yrd("bay", "close", "B1"), closed.io), closed.stderr()).toBe(0)
    const afterClose = await Array.fromAsync(app.events()).then((events) => events.length)
    const inactive = outputIO()
    expect(await runYrd(app, yrd("bay", "path", "B1"), inactive.io)).toBe(1)
    expect(inactive.stderr()).toContain("bay 'B1' is closed; expected an active bay")
    expect(inactive.stderr()).toContain("yrd bay open <name>")
    expect(await Array.fromAsync(app.events()).then((events) => events.length)).toBe(afterClose)

    const relativeApp = await createApp({ bayPath: "relative/B1" })
    const relativeOpen = outputIO()
    expect(await runYrd(relativeApp, yrd("bay", "open", "relative"), relativeOpen.io), relativeOpen.stderr()).toBe(0)
    const beforeRelative = await Array.fromAsync(relativeApp.events()).then((events) => events.length)
    const relative = outputIO()
    expect(await runYrd(relativeApp, yrd("bay", "path", "B1"), relative.io)).toBe(1)
    expect(relative.stderr()).toContain("bay 'B1' has no absolute workspace path")
    expect(relative.stderr()).toContain("yrd bay --json")
    expect(await Array.fromAsync(relativeApp.events()).then((events) => events.length)).toBe(beforeRelative)
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

    const landed = outputIO()
    expect(await runYrd(app, yrd("pr", "view", "PR1", "--json"), landed.io), landed.stderr()).toBe(0)
    expect(JSON.parse(landed.stdout())).toMatchObject({
      command: "pr.view",
      pr: { id: "PR1", status: "integrated" },
      landing: {
        outcome: "landed",
        landingSha: MERGED_SHA,
        baseSha: MERGED_SHA,
        run: "R1",
      },
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
      prs: [{ id: "PR1", branch: "topic/direct", base: "release/2.0", headSha: HEAD_SHA }],
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

  it("drives draft, review, ready, needs-review, and cached checks through the PR surface", async () => {
    const checkRuns: string[] = []
    const app = await createApp({ requires: ["review"], checkRuns })
    const resolveRevision = () => Promise.resolve(HEAD_SHA)

    const submit = outputIO({ resolveRevision })
    expect(
      await runYrd(app, yrd("pr", "submit", "topic/review-me", "--draft", "--json"), submit.io),
      submit.stderr(),
    ).toBe(0)
    const submitted = JSON.parse(submit.stdout()) as { prs: Record<string, unknown>[] }
    expect(submitted).toMatchObject({
      command: "pr.submit",
      prs: [{ id: "PR1", branch: "topic/review-me", revision: 1, headSha: HEAD_SHA }],
    })
    expect(submitted).not.toHaveProperty("checks")
    expect(submitted.prs[0]).toMatchObject({ status: "pushed" })
    expect(app.state().bays.prs.PR1?.status).toBe("pushed")
    expect(app.bays.checksRequested("PR1")).toBe(false)
    expect(Queues.ids(app.state().queues)).toEqual([])
    expect(checkRuns).toEqual([])

    const inbox = outputIO()
    expect(await runYrd(app, yrd("pr", "list", "--needs-review", "--json"), inbox.io), inbox.stderr()).toBe(0)
    expect(JSON.parse(inbox.stdout())).toMatchObject({
      command: "pr.list",
      prs: [{ id: "PR1", revision: 1, eligibility: { review: { required: true, approved: false } } }],
    })
    const humanInbox = outputIO({ columns: 160 })
    expect(await runYrd(app, yrd("pr", "list", "--needs-review"), humanInbox.io), humanInbox.stderr()).toBe(0)
    expect(humanInbox.stdout()).toContain("WHY")
    expect(humanInbox.stdout()).toContain("draft")
    expect(humanInbox.stdout()).toContain("need")
    expect(humanInbox.stdout()).not.toContain("checking")

    const comment = outputIO()
    expect(
      await runYrd(
        app,
        yrd("pr", "comment", "PR1", "--by", "@cto", "--ref", "question-1", "--note", "Why?", "--json"),
        comment.io,
      ),
      comment.stderr(),
    ).toBe(0)
    expect(JSON.parse(comment.stdout())).toMatchObject({
      command: "pr.comment",
      comment: { actor: "@cto", ref: "question-1", note: "Why?", revision: 1 },
    })
    const secondComment = outputIO()
    expect(
      await runYrd(
        app,
        yrd("pr", "comment", "PR1", "--by", "@cto", "--ref", "question-2", "--note", "Thanks.", "--json"),
        secondComment.io,
      ),
      secondComment.stderr(),
    ).toBe(0)
    const replayedComment = outputIO()
    expect(
      await runYrd(
        app,
        yrd("pr", "comment", "PR1", "--by", "@cto", "--ref", "question-1", "--note", "Why?", "--json"),
        replayedComment.io,
      ),
      replayedComment.stderr(),
    ).toBe(0)
    expect(JSON.parse(replayedComment.stdout())).toMatchObject({
      comment: { ref: "question-1", note: "Why?" },
    })

    const review = outputIO()
    expect(
      await runYrd(
        app,
        yrd("pr", "review", "PR1", "--approve", "--by", "@cto", "--ref", "verdict-1", "--json"),
        review.io,
      ),
      review.stderr(),
    ).toBe(0)
    expect(JSON.parse(review.stdout())).toMatchObject({
      command: "pr.review",
      review: { actor: "@cto", decision: "approve", ref: "verdict-1", revision: 1, headSha: HEAD_SHA },
    })
    const replay = outputIO()
    expect(
      await runYrd(
        app,
        yrd("pr", "review", "PR1", "--approve", "--by", "@cto", "--ref", "verdict-1", "--json"),
        replay.io,
      ),
      replay.stderr(),
    ).toBe(0)
    expect(app.state().bays.prs.PR1?.reviews).toHaveLength(1)
    const secondApproval = outputIO()
    expect(
      await runYrd(
        app,
        yrd("pr", "review", "PR1", "--approve", "--by", "@cto", "--ref", "verdict-2", "--json"),
        secondApproval.io,
      ),
      secondApproval.stderr(),
    ).toBe(0)
    const replayedApproval = outputIO()
    expect(
      await runYrd(
        app,
        yrd("pr", "review", "PR1", "--approve", "--by", "@cto", "--ref", "verdict-1", "--json"),
        replayedApproval.io,
      ),
      replayedApproval.stderr(),
    ).toBe(0)
    expect(JSON.parse(replayedApproval.stdout())).toMatchObject({
      review: { ref: "verdict-1", decision: "approve" },
    })

    const ready = outputIO()
    expect(await runYrd(app, yrd("pr", "ready", "PR1", "--json"), ready.io), ready.stderr()).toBe(0)
    expect(JSON.parse(ready.stdout())).toMatchObject({
      command: "pr.ready",
      pr: { id: "PR1", revision: 1 },
      eligibility: { review: { approved: true } },
    })
    expect(app.state().bays.prs.PR1?.status).toBe("submitted")
    expect(app.queue.get("R1")).toMatchObject({ status: "passed", steps: [{ name: "check" }] })
    expect(checkRuns).toEqual(["check"])

    let followSleeps = 0
    const checks = outputIO({
      scope: {
        signal: new AbortController().signal,
        sleep: async () => {
          followSleeps++
          await app.queue.admit({ prs: ["PR1"] }, { runner: "external-check-runner", leaseMs: 60_000 })
        },
      },
    })
    expect(await runYrd(app, yrd("pr", "checks", "PR1", "--follow", "--json"), checks.io), checks.stderr()).toBe(0)
    expect(JSON.parse(checks.stdout())).toMatchObject({
      kind: "pr.check",
      command: ["queue.step.check"],
      pr: "PR1",
      revision: 1,
      run: "R1",
      step: "check",
      status: "passed",
      queuedAt: expect.any(String),
    })
    expect(followSleeps).toBe(0)
    expect(checkRuns).toEqual(["check"])

    const integrate = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "PR1", "--json"), integrate.io), integrate.stderr()).toBe(0)
    expect(JSON.parse(integrate.stdout())).toMatchObject({
      results: [{ id: "R2", status: "passed", steps: [{ name: "merge" }], reusedFrom: "R1" }],
    })
    expect(checkRuns).toEqual(["check"])

    await app.bays.submit({ branch: "topic/withdrawn", headSha: MERGED_SHA, base: "main", draft: true })
    await app.bays.closePr({ pr: "PR2" })
    const terminalInbox = outputIO()
    expect(await runYrd(app, yrd("pr", "list", "--needs-review", "--json"), terminalInbox.io)).toBe(0)
    expect(JSON.parse(terminalInbox.stdout())).toMatchObject({ command: "pr.list", prs: [] })
  })

  it("drives reviewer requests through submit, request-review, and the reviewer-scoped inbox", async () => {
    const app = await createApp()
    const resolveRevision = () => Promise.resolve(HEAD_SHA)

    const submit = outputIO({ resolveRevision })
    expect(
      await runYrd(
        app,
        yrd("pr", "submit", "topic/request-me", "--draft", "--reviewer", "@cto", "--reviewer", "@agent/5", "--json"),
        submit.io,
      ),
      submit.stderr(),
    ).toBe(0)
    expect(app.bays.pr("PR1")).toMatchObject({ status: "pushed", requestedReviewers: ["@cto", "@agent/5"] })

    const draftInbox = outputIO()
    expect(await runYrd(app, yrd("pr", "list", "--needs-review", "--json"), draftInbox.io), draftInbox.stderr()).toBe(0)
    expect(JSON.parse(draftInbox.stdout())).toMatchObject({ command: "pr.list", prs: [] })

    await app.bays.ready({ pr: "PR1" })
    const inbox = outputIO()
    expect(await runYrd(app, yrd("pr", "list", "--needs-review", "--json"), inbox.io), inbox.stderr()).toBe(0)
    expect(JSON.parse(inbox.stdout())).toMatchObject({
      command: "pr.list",
      prs: [{ id: "PR1", requestedReviewers: ["@cto", "@agent/5"], needsReview: true }],
    })

    const strangerInbox = outputIO()
    expect(
      await runYrd(app, yrd("pr", "list", "--needs-review", "--reviewer", "@stranger", "--json"), strangerInbox.io),
      strangerInbox.stderr(),
    ).toBe(0)
    expect(JSON.parse(strangerInbox.stdout())).toMatchObject({ command: "pr.list", prs: [] })

    const review = outputIO()
    expect(
      await runYrd(
        app,
        yrd("pr", "review", "PR1", "--approve", "--by", "@cto", "--ref", "verdict-9", "--json"),
        review.io,
      ),
      review.stderr(),
    ).toBe(0)
    const settled = outputIO()
    expect(await runYrd(app, yrd("pr", "list", "--needs-review", "--json"), settled.io), settled.stderr()).toBe(0)
    expect(JSON.parse(settled.stdout())).toMatchObject({ command: "pr.list", prs: [] })
    const openForAgent5 = outputIO()
    expect(
      await runYrd(app, yrd("pr", "list", "--needs-review", "--reviewer", "@agent/5", "--json"), openForAgent5.io),
      openForAgent5.stderr(),
    ).toBe(0)
    expect(JSON.parse(openForAgent5.stdout())).toMatchObject({
      prs: [{ id: "PR1", needsReview: true }],
    })

    const replaced = outputIO()
    expect(
      await runYrd(app, yrd("pr", "request-review", "PR1", "@agent/9", "--by", "@chief", "--json"), replaced.io),
      replaced.stderr(),
    ).toBe(0)
    expect(JSON.parse(replaced.stdout())).toMatchObject({
      command: "pr.request-review",
      requestedReviewers: ["@agent/9"],
      needsReview: true,
    })

    const cleared = outputIO()
    expect(
      await runYrd(app, yrd("pr", "request-review", "PR1", "--clear", "--json"), cleared.io),
      cleared.stderr(),
    ).toBe(0)
    expect(JSON.parse(cleared.stdout())).toMatchObject({
      command: "pr.request-review",
      requestedReviewers: [],
      needsReview: false,
    })

    const missingActors = outputIO()
    expect(await runYrd(app, yrd("pr", "request-review", "PR1"), missingActors.io)).toBe(2)
    expect(missingActors.stderr()).toContain("requires reviewer actors or --clear")
    const conflictingClear = outputIO()
    expect(await runYrd(app, yrd("pr", "request-review", "PR1", "@cto", "--clear"), conflictingClear.io)).toBe(2)
    expect(conflictingClear.stderr()).toContain("cannot combine with reviewer actors")
    const reviewerWithoutInbox = outputIO()
    expect(await runYrd(app, yrd("pr", "list", "--reviewer", "@cto", "--json"), reviewerWithoutInbox.io)).toBe(2)
    expect(reviewerWithoutInbox.stderr()).toContain("--reviewer requires --needs-review")
  })

  it("keeps pr checks --follow read-only when no check fact was requested", async () => {
    const app = await createApp()
    await app.bays.submit({ branch: "topic/not-requested", headSha: HEAD_SHA, base: "main" })
    const before = await Array.fromAsync(app.events())
    const checks = outputIO()

    expect(await runYrd(app, yrd("pr", "checks", "PR1", "--follow", "--json"), checks.io)).toBe(1)

    expect(checks.stderr()).toContain("has no requested checks")
    expect(await Array.fromAsync(app.events())).toEqual(before)
    expect(app.queue.eligibility("PR1")).toMatchObject({ checks: { status: "not-requested" } })
  })

  it("returns an admitted check failure to a following submitter as one typed record", async () => {
    const behavior = { failingCheck: true }
    const app = await createApp(behavior)
    const submit = outputIO({ resolveRevision: () => Promise.resolve(HEAD_SHA) })

    expect(await runYrd(app, yrd("pr", "submit", "topic/red", "--follow", "--json"), submit.io), submit.stderr()).toBe(
      1,
    )
    expect(JSON.parse(submit.stdout())).toMatchObject({
      command: "pr.submit",
      checks: [
        {
          pr: "PR1",
          revision: 1,
          run: "R1",
          step: "check",
          status: "failed",
          command: ["queue.step.check"],
          classification: "carrier",
          diagnostics: [{ file: "src/model.ts", [sourceRowKey]: 12, message: "type mismatch" }],
          artifact: "/tmp/yrd-check.log",
          error: { code: "check-failed", message: "check failed" },
        },
      ],
    })
    expect(app.state().bays.prs.PR1).toMatchObject({ status: "rejected", detail: "check failed" })

    const human = outputIO({ color: true, columns: 160 })
    expect(await runYrd(app, yrd("pr", "checks", "PR1"), human.io), human.stderr()).toBe(1)
    expect(human.stdout()).toContain("COMMAND")
    expect(human.stdout()).toContain("AGE")
    expect(human.stdout()).toContain("queue.step.check")
    expect(human.stdout()).toContain("carrier")
    expect(human.stdout()).toContain("src/model.ts")
    expect(human.stdout()).toContain("/tmp/yrd-check.log")
    expect(human.stdout()).toContain("\u001b]8;;file:///tmp/yrd-check.log")

    const plain = outputIO({ color: false, columns: 160 })
    expect(await runYrd(app, yrd("pr", "checks", "PR1"), plain.io), plain.stderr()).toBe(1)
    expect(plain.stdout()).toContain("src/model.ts:12")
    expect(plain.stdout()).toContain("/tmp/yrd-check.log")
    expect(plain.stdout()).not.toContain("\u001b]")

    behavior.failingCheck = false
    const rejected = app.state().bays.prs.PR1
    if (rejected === undefined) throw new Error("expected rejected PR")
    await app.bays.intake({
      branch: rejected.branch,
      headSha: MERGED_SHA,
      base: rejected.base,
      ...(rejected.baseSha === undefined ? {} : { baseSha: rejected.baseSha }),
    })
    await app.bays.submit({ pr: "PR1" })
    await app.bays.requestChecks({ pr: "PR1" })
    const reauthorized = (await app.queue.admit({ prs: ["PR1"] }))[0]
    if (reauthorized === undefined) throw new Error("expected a fresh-revision check run")
    await app.queue.run({ prs: ["PR1"] }, { runner: "cli-test", leaseMs: 60_000 })
    expect(app.state().bays.prs.PR1).toMatchObject({ revision: 2, headSha: MERGED_SHA })
    const recovered = outputIO()
    expect(await runYrd(app, yrd("pr", "checks", "PR1", "--json"), recovered.io), recovered.stderr()).toBe(0)
    const currentChecks = recovered
      .stdout()
      .trim()
      .split("\n")
      .map((record) => JSON.parse(record))
    expect(currentChecks).toHaveLength(1)
    expect(currentChecks[0]).toMatchObject({
      kind: "pr.check",
      revision: 2,
      run: reauthorized.id,
      status: "passed",
    })
  })

  it("runs a plain submission check before integrating its cached proof", async () => {
    const checkRuns: string[] = []
    const app = await createApp({ checkRuns })
    const submit = outputIO({ resolveRevision: () => Promise.resolve(HEAD_SHA) })
    expect(await runYrd(app, yrd("pr", "submit", "topic/plain", "--json"), submit.io), submit.stderr()).toBe(0)
    expect(checkRuns).toEqual(["check"])
    expect(app.queue.get("R1")).toMatchObject({ status: "passed", steps: [{ name: "check" }] })

    const drain = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "PR1", "--json"), drain.io), drain.stderr()).toBe(0)
    expect(JSON.parse(drain.stdout())).toMatchObject({
      results: [{ id: "R2", status: "passed", steps: [{ name: "merge" }], reusedFrom: "R1" }],
    })
    expect(checkRuns).toEqual(["check"])
  })

  it("runs each direct submission without replaying completed Queue work", async () => {
    const checkRuns: string[] = []
    const app = await createApp({ checkRuns })
    const resolveRevision = (ref: string) => Promise.resolve(ref.endsWith("first") ? HEAD_SHA : MERGED_SHA)

    const first = outputIO({ resolveRevision })
    expect(await runYrd(app, yrd("pr", "submit", "topic/first", "--json"), first.io), first.stderr()).toBe(0)
    expect(app.queue.get("R1")).toMatchObject({ status: "passed", prs: [{ id: "PR1" }] })

    const second = outputIO({ resolveRevision })
    expect(
      await runYrd(app, yrd("pr", "submit", "topic/second", "--follow", "--json"), second.io),
      second.stderr(),
    ).toBe(0)
    expect(JSON.parse(second.stdout())).toMatchObject({
      checks: [{ pr: "PR2", status: "passed" }],
    })
    expect(checkRuns).toEqual(["check", "check"])
  })

  it("keeps --follow on the journal-tail path until an externally waiting check settles", async () => {
    const app = await createApp({ waitingCheck: true })
    let sleeps = 0
    const controller = new AbortController()
    const submit = outputIO({
      resolveRevision: () => Promise.resolve(HEAD_SHA),
      scope: {
        signal: controller.signal,
        sleep: async () => {
          sleeps++
          const waiting = app.queue.waiting("PR1", "check").step.job
          await app.queue.finish(
            "PR1",
            {
              job: waiting.id,
              step: "check",
              attempt: waiting.attempt,
              runner: waiting.runner,
              token: waiting.token,
              result: { status: "passed", output: { baseSha: BASE_SHA, candidateSha: HEAD_SHA } },
            },
            { runner: "remote-check", leaseMs: 60_000 },
          )
        },
      },
    })

    expect(await runYrd(app, yrd("pr", "submit", "topic/wait", "--follow", "--json"), submit.io), submit.stderr()).toBe(
      0,
    )
    expect(sleeps).toBe(1)
    expect(JSON.parse(submit.stdout())).toMatchObject({
      checks: [{ pr: "PR1", step: "check", status: "passed" }],
    })
  })

  it("classifies the read-only main-health evidence as a base failure", async () => {
    const app = await createApp({ baseFailure: true })
    const submit = outputIO({ resolveRevision: () => Promise.resolve(HEAD_SHA) })
    expect(await runYrd(app, yrd("pr", "submit", "topic/base-red", "--follow", "--json"), submit.io)).toBe(1)
    expect(JSON.parse(submit.stdout())).toMatchObject({
      checks: [
        {
          pr: "PR1",
          status: "failed",
          classification: "base",
          diagnostics: `[yrd-base-health] base ${BASE_SHA.slice(0, 12)} is red: test:fast failed`,
          error: { code: "base-red" },
        },
      ],
    })
  })

  it("submits an immutable source composition from a JSON manifest", async () => {
    const app = await createApp()
    const root = mkdtempSync(join(tmpdir(), "yrd-composition-"))
    const manifest = join(root, "composition.json")
    writeFileSync(
      manifest,
      JSON.stringify({
        version: 1,
        sources: [
          {
            repo: "dep",
            branch: "issue/source",
            baseSha: "2".repeat(40),
            tipSha: "3".repeat(40),
            payload: ["src/candidate.ts"],
          },
        ],
      }),
    )
    const submit = outputIO({ cwd: root, resolveRevision: () => Promise.resolve(HEAD_SHA) })

    try {
      expect(
        await runYrd(
          app,
          yrd("bay", "submit", "issue/source", "--base", "main", "--composition", "composition.json", "--json"),
          submit.io,
        ),
        submit.stderr(),
      ).toBe(0)
      expect(JSON.parse(submit.stdout())).toMatchObject({
        prs: [
          {
            branch: "issue/source",
            headSha: HEAD_SHA,
            composition: {
              version: 1,
              sources: [
                {
                  repo: "dep",
                  branch: "issue/source",
                  baseSha: "2".repeat(40),
                  tipSha: "3".repeat(40),
                  payload: ["src/candidate.ts"],
                },
              ],
            },
          },
        ],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("closes a direct bayless PR through the `pr close` CLI without a bay", async () => {
    const app = await createApp()
    const resolveRevision = () => Promise.resolve(HEAD_SHA)

    const submit = outputIO({ resolveRevision })
    expect(await runYrd(app, yrd("bay", "submit", "topic/superseded", "--json"), submit.io), submit.stderr()).toBe(0)
    const submitted = JSON.parse(submit.stdout()) as { prs: Record<string, unknown>[] }
    expect(submitted).toMatchObject({ prs: [{ id: "PR1", revision: 1, headSha: HEAD_SHA }] })
    expect(submitted.prs[0]).toMatchObject({ status: "submitted" })

    await app.dispatch(app.commands.queue.run, { prs: ["PR1"], steps: ["check"] })
    expect(app.queue.get("R1")).toMatchObject({
      status: "running",
      steps: [{ job: { status: "requested", attempt: 0 } }],
    })

    const close = outputIO()
    expect(await runYrd(app, yrd("pr", "close", "PR1", "--json"), close.io), close.stderr()).toBe(0)
    const closed = JSON.parse(close.stdout()) as { prs: Record<string, unknown>[] }
    expect(closed).toMatchObject({
      command: "pr.close",
      prs: [{ id: "PR1", revision: 1, headSha: HEAD_SHA }],
    })
    expect(closed.prs[0]).toMatchObject({ status: "withdrawn" })
    expect(app.queue.get("R1")).toMatchObject({
      status: "failed",
      steps: [
        {
          job: {
            status: "canceled",
            attempt: 0,
            canceledBy: "cli-test",
            cancelReason: "PR withdrawn",
          },
        },
      ],
    })

    await app.bays.submit({ branch: "topic/next", headSha: MERGED_SHA, base: "main", baseSha: BASE_SHA })
    await expect(app.dispatch(app.commands.queue.run, { prs: ["PR2"], steps: ["check"] })).resolves.toMatchObject({
      events: [
        expect.objectContaining({ name: "queue/run/started" }),
        expect.objectContaining({ name: "job/requested" }),
      ],
    })

    // A terminal PR refuses re-close with a nonzero exit — never a silent no-op.
    const again = outputIO()
    expect(await runYrd(app, yrd("pr", "close", "PR1"), again.io)).not.toBe(0)
  })

  it("terminalizes unclaimed Queue work when `bay close --withdraw` closes its PR", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    await expect(
      app.queue.run({ prs: ["PR1"], steps: ["check"] }, { runner: "history-runner", leaseMs: 60_000 }),
    ).resolves.toMatchObject([{ id: "R1", status: "passed" }])
    await app.dispatch(app.commands.queue.run, { prs: ["PR1"], steps: ["merge"] })

    const close = outputIO({ cwd: "/repo/.bays/B1" })
    expect(await runYrd(app, yrd("bay", "close", "--withdraw", "--json"), close.io), close.stderr()).toBe(0)

    expect(app.state().bays.prs.PR1?.status).toBe("withdrawn")
    expect(app.queue.get("R1")).toMatchObject({ status: "passed" })
    expect(app.queue.get("R2")).toMatchObject({
      status: "failed",
      steps: [{ job: { status: "canceled", attempt: 0, cancelReason: "PR withdrawn" } }],
    })
  })

  it("requires the exact waiting Job owner to finish and resume the same durable run", async () => {
    const app = await createApp({ waitingCheck: true })
    await openAndSubmit(app)

    const run = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "PR1"), run.io)).toBe(0)
    expect(app.queue.get("R1")?.status).toBe("waiting")
    expect(app.queue.get("r1")?.status).toBe("waiting")
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
          "r1",
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
    const rejected = app.state().bays.prs.PR1
    if (rejected === undefined) throw new Error("expected rejected PR")
    await app.bays.intake({
      branch: rejected.branch,
      headSha: MERGED_SHA,
      base: rejected.base,
      ...(rejected.baseSha === undefined ? {} : { baseSha: rejected.baseSha }),
    })
    await app.bays.submit({ pr: "PR1" })
    await app.dispatch(app.commands.queue.advance, { run: "R1" })
    await app.bays.requestChecks({ pr: "PR1" })
    expect(app.state().bays.prs.PR1).toMatchObject({ status: "submitted", revision: 2, headSha: MERGED_SHA })
    expect((await app.queue.admit({ prs: ["PR1"] }))[0]?.id).toBe("R2")

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

    const beforeRecovery = await Array.fromAsync(app.events()).then((events) => events.length)
    const recovery = outputIO({ now: () => Date.parse("2026-07-09T12:00:02.000Z") })
    expect(
      await runYrd(app, yrd("queue", "recover", "--reason", "runner interrupted", "--json"), recovery.io),
      recovery.stderr(),
    ).toBe(0)
    expect(JSON.parse(recovery.stdout())).toMatchObject({
      command: "queue.recover",
      results: [{ id: "R2", status: "failed", steps: [{ job: { status: "lost" } }] }],
    })
    expect(app.state().bays.prs.PR1).toMatchObject({ status: "submitted" })
    expect(app.queue.get("R2")?.steps[1]?.job).toBeUndefined()
    expect(mergeRuns).toEqual([])
    const events = (await Array.fromAsync(app.events())).slice(beforeRecovery)
    const failed = events.find((applied) => {
      if (applied.name !== "queue/run/failed") return false
      const data = applied.data as Readonly<{ run?: unknown; error?: Readonly<{ code?: unknown }> }>
      return data.run === "R2" && data.error?.code === "job-lost"
    })
    if (failed === undefined) throw new Error("expected job loss to append queue/run/failed")
    expect(Queues.authorityRun(app.state().queues.authority, "R2")?.released).toEqual({
      reason: "job-lost",
      ref: failed.id,
    })
    expect(events.map(({ name }) => name)).not.toContain("pr/rejected")
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
          "r1",
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
    expect(await runYrd(app, yrd("queue", "run", "--once", "--steps", "--json"), integrated.io)).toBe(0)
    expect(JSON.parse(integrated.stdout())).toEqual({ command: "queue.run", results: [] })
    expect(app.state().bays.prs.PR1?.status).toBe("submitted")

    const idle = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "--once", "--json"), idle.io)).toBe(0)
    expect(JSON.parse(idle.stdout())).toMatchObject({
      command: "queue.run",
      results: [{ id: "R1", prs: [{ id: "PR1" }], steps: [{ name: "check" }, { name: "merge" }], status: "passed" }],
    })

    const drained = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "--once", "--json"), drained.io)).toBe(0)
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
    expect(Queues.ids(app.state().queues)).toEqual([])

    const eligible = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "--once", "--json"), eligible.io), eligible.stderr()).toBe(0)
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
    expect(await runYrd(app, yrd("queue", "run", "--once", "--json"), integrated.io), integrated.stderr()).toBe(0)
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
    expect(stripAnsi(human.stdout())).toContain("pr#1.1")
    expect(human.stdout()).toContain("STATUS")
    expect(human.stdout()).toContain("integrated")
    expect(human.stdout()).toContain("one")
    expect(human.stdout()).toContain("integrated")
    expect(human.stdout()).toContain(MERGED_SHA.slice(0, 12))
    expect(human.stdout()).not.toContain("file:///repo/.bays/B1")

    const show = outputIO()
    expect(await runYrd(app, yrd("contest", "view", "C1", "--json"), show.io)).toBe(0)
    expect(JSON.parse(show.stdout())).toMatchObject({ command: "contest.view", contest: { id: "C1" } })
    expect(await Array.fromAsync(app.events()).then((events) => events.length)).toBe(before)
  })

  it("projects FLOW from one terminal fact per Run while keeping per-PR queue waits", () => {
    const minute = 60_000
    const now = Date.parse("2026-07-13T12:00:00.000Z")
    const fact = (
      run: string,
      outcome: QueueTerminalFact["outcome"],
      activeMinutes: number,
      waitMinutes: readonly number[],
      terminalAtMs = now,
    ): QueueTerminalFact => ({
      run,
      outcome,
      terminalAtMs,
      activeMs: activeMinutes * minute,
      queueWaitMs: waitMinutes.map((value) => value * minute),
    })
    const facts = [
      fact("R1", "integrated", 10, [5, 15], now - 6 * 60 * minute),
      fact("R2", "rejected", 20, [25]),
      fact("R3", "environment-refused", 30, [35]),
      fact("R4", "integrated", 100, [95]),
      fact("R-old", "rejected", 1_000, [1_000], now - 6 * 60 * minute - 1),
      fact("R-future", "rejected", 1_000, [1_000], now + 1),
    ]

    // windowMs = 6h so the per-24h projection is 4× the landed count (2 → 8);
    // oldestOpenMs is a live-queue fact the caller supplies, null when absent.
    expect(queueFlowMetrics(facts, { now, windowMs: 6 * 60 * minute })).toEqual({
      windowMs: 6 * 60 * minute,
      terminalAttempts: 4,
      outcomes: { integrated: 2, rejected: 1, environmentRefused: 1, canceled: 0 },
      decisionRejection: { rejected: 1, decisions: 3, rate: 1 / 3 },
      throughput: { landed: 2, per24h: 8 },
      oldestOpenMs: null,
      activeRun: {
        allTerminal: {
          n: 4,
          minMs: 10 * minute,
          avgMs: 40 * minute,
          p50Ms: 25 * minute,
          p90Ms: 100 * minute,
          maxMs: 100 * minute,
        },
        integratedOnly: {
          n: 2,
          minMs: 10 * minute,
          avgMs: 55 * minute,
          p50Ms: 55 * minute,
          p90Ms: 100 * minute,
          maxMs: 100 * minute,
        },
        // R2 (rejected, 20m) + R3 (env-refused, 30m); the failed complement.
        failedOnly: {
          n: 2,
          minMs: 20 * minute,
          avgMs: 25 * minute,
          p50Ms: 25 * minute,
          p90Ms: 30 * minute,
          maxMs: 30 * minute,
        },
      },
      queueWait: {
        n: 5,
        avgMs: 35 * minute,
        p50Ms: 25 * minute,
        p90Ms: 95 * minute,
        maxMs: 95 * minute,
      },
    })
    expect(queueFlowMetrics([], { now, windowMs: 6 * 60 * minute, oldestOpenMs: 42 * minute })).toEqual({
      windowMs: 6 * 60 * minute,
      terminalAttempts: 0,
      outcomes: { integrated: 0, rejected: 0, environmentRefused: 0, canceled: 0 },
      decisionRejection: { rejected: 0, decisions: 0, rate: null },
      throughput: { landed: 0, per24h: 0 },
      oldestOpenMs: 42 * minute,
      activeRun: {
        allTerminal: { n: 0, minMs: null, avgMs: null, p50Ms: null, p90Ms: null, maxMs: null },
        integratedOnly: { n: 0, minMs: null, avgMs: null, p50Ms: null, p90Ms: null, maxMs: null },
        failedOnly: { n: 0, minMs: null, avgMs: null, p50Ms: null, p90Ms: null, maxMs: null },
      },
      queueWait: { n: 0, avgMs: null, p50Ms: null, p90Ms: null, maxMs: null },
    })
  })

  it("windows flow metrics independently of the timeline row-listing window", () => {
    const minute = 60_000
    const now = Date.parse("2026-07-13T12:00:00.000Z")
    // One landed Run that finished 8h ago: outside a 6h listing window, inside 24h.
    const landed = fakeRun({
      id: "R1",
      status: "passed",
      pr: { id: "PR1", revision: 1, headSha: "1".repeat(40), baseSha: BASE_SHA },
      startedAt: "2026-07-13T03:50:00.000Z",
      finishedAt: "2026-07-13T04:00:00.000Z",
      steps: [],
      integration: { commit: MERGED_SHA, baseSha: BASE_SHA },
    })
    const prs = [
      { id: "PR1", status: "integrated", submittedAt: "2026-07-13T03:45:00.000Z" },
      { id: "PR5", status: "submitted", submittedAt: "2026-07-13T11:00:00.000Z" },
    ].map((pr) => ({
      ...pr,
      branch: `topic/${pr.id}`,
      base: "main",
      revision: 1,
      headSha: pr.id === "PR1" ? "1".repeat(40) : "5".repeat(40),
    })) as unknown as PR[]
    const result: QueueStatusResult = { base: "main", prs, running: [], waiting: [], finished: [landed] }
    const submissionTimes = new Map(prs.map((pr) => [queueRevisionKey(pr), pr.submittedAt!]))
    const base = {
      now,
      statuses: ["pending", "running", "rejected", "integrated", "other"] as const,
      terms: [] as string[],
      latest: false,
      rowLimit: 20,
      submissionTimes,
    }

    const shared = queueTimelineProjection([result], { ...base, windowMs: 6 * 60 * minute })
    const widened = queueTimelineProjection([result], {
      ...base,
      windowMs: 6 * 60 * minute,
      metricsWindowMs: 24 * 60 * minute,
    })

    // The 6h listing window drops the 8h-old landing from both projections' rows.
    expect(shared.rows.map((row) => row.pr)).toEqual(["PR5"])
    expect(widened.rows.map((row) => row.pr)).toEqual(["PR5"])
    // Metrics honor their own window: 6h sees no landing, 24h counts it.
    expect(shared.metrics.terminalAttempts).toBe(0)
    expect(shared.metrics.throughput).toEqual({ landed: 0, per24h: 0 })
    expect(widened.metrics.terminalAttempts).toBe(1)
    expect(widened.metrics.outcomes.integrated).toBe(1)
    expect(widened.metrics.throughput).toEqual({ landed: 1, per24h: 1 })
    expect(widened.metrics.windowMs).toBe(24 * 60 * minute)
    // Oldest-open is a live-queue fact, independent of either window.
    expect(shared.oldestOpenMs).toBe(60 * minute)
    expect(shared.metrics.oldestOpenMs).toBe(60 * minute)
    expect(widened.metrics.oldestOpenMs).toBe(60 * minute)
  })

  it("keeps time-stats facts on the full horizon so WK/MON never inherit the 24h metrics window", () => {
    const minute = 60_000
    const hour = 60 * minute
    const now = Date.parse("2026-07-13T12:00:00.000Z")
    const landing = (id: string, pr: string, sha: string, finishedAt: string) =>
      fakeRun({
        id,
        status: "passed",
        pr: { id: pr, revision: 1, headSha: sha, baseSha: BASE_SHA },
        startedAt: finishedAt,
        finishedAt,
        steps: [],
        integration: { commit: MERGED_SHA, baseSha: BASE_SHA },
      })
    // One landing 8h ago (inside the 24h metrics window) and one 3 days ago
    // (outside 24h, inside a week). Both are dropped from the 6h listing rows.
    const recent = landing("R1", "PR1", "1".repeat(40), "2026-07-13T04:00:00.000Z")
    const older = landing("R2", "PR2", "2".repeat(40), "2026-07-10T12:00:00.000Z")
    const prs = [
      { id: "PR1", status: "integrated", submittedAt: "2026-07-13T03:45:00.000Z", headSha: "1".repeat(40) },
      { id: "PR2", status: "integrated", submittedAt: "2026-07-10T11:55:00.000Z", headSha: "2".repeat(40) },
    ].map((pr) => ({ ...pr, branch: `topic/${pr.id}`, base: "main", revision: 1 })) as unknown as PR[]
    const result: QueueStatusResult = { base: "main", prs, running: [], waiting: [], finished: [recent, older] }
    const projection = queueTimelineProjection([result], {
      now,
      windowMs: 6 * hour,
      metricsWindowMs: 24 * hour,
      statuses: ["pending", "running", "rejected", "integrated", "other"],
      terms: [],
      latest: false,
      rowLimit: 20,
      submissionTimes: new Map(prs.map((pr) => [queueRevisionKey(pr), pr.submittedAt!])),
    })
    // The 24h metrics window counts only the recent landing.
    expect(projection.metrics.terminalAttempts).toBe(1)
    // timeStatsFacts span the FULL retained horizon — both landings — so the
    // TimeStatsBox windows read their own spans off it, never the 24h default.
    expect(projection.timeStatsFacts.map((f) => f.run).toSorted()).toEqual(["R1", "R2"])
    const windows = queueTimeStats(projection.timeStatsFacts, now, projection.earliestEventMs)
    const attempts = (key: string) => windows.find((w) => w.key === key)!.metrics.terminalAttempts
    expect(attempts("HR")).toBe(0) // last hour: neither
    expect(attempts("DAY")).toBe(1) // 24h: the recent landing only
    expect(attempts("WK")).toBe(2) // 7d: both, including the landing the 24h window drops
    expect(attempts("MON")).toBe(2) // 30d: both
  })

  it("keeps one recut PR card with cumulative source-ready age and revision lineage", async () => {
    const minute = 60_000
    const firstSubmittedAt = "2026-07-13T10:00:00.000Z"
    const currentSubmittedAt = "2026-07-13T11:55:00.000Z"
    const now = Date.parse("2026-07-13T12:00:00.000Z")
    const patchId = "d".repeat(40)
    const treeSha = "e".repeat(40)
    const pr: PR = {
      id: "PR1",
      branch: "topic/recut",
      base: "main",
      status: "submitted",
      revision: 2,
      headSha: "2".repeat(40),
      baseSha: "b".repeat(40),
      recut: { fromRevision: 1, patchId, treeSha, reviewCarried: true },
      revisions: [
        {
          revision: 1,
          headSha: "1".repeat(40),
          base: "main",
          baseSha: BASE_SHA,
          pushedAt: "2026-07-13T09:59:00.000Z",
          submittedAt: firstSubmittedAt,
        },
        {
          revision: 2,
          headSha: "2".repeat(40),
          base: "main",
          baseSha: "b".repeat(40),
          pushedAt: "2026-07-13T11:54:00.000Z",
          submittedAt: currentSubmittedAt,
          recut: { fromRevision: 1, patchId, treeSha, reviewCarried: true },
        },
      ],
      reviews: [],
      comments: [],
      checkRequests: [],
      submittedAt: currentSubmittedAt,
    }
    const result: QueueStatusResult = {
      base: "main",
      prs: [pr],
      running: [],
      waiting: [],
      finished: [],
    }
    const projection = queueTimelineProjection([result], {
      now,
      windowMs: 6 * 60 * minute,
      statuses: ["pending", "running", "rejected", "integrated", "other"],
      terms: [],
      latest: false,
      rowLimit: 20,
      submissionTimes: new Map([[queueRevisionKey(pr), currentSubmittedAt]]),
    })

    expect(projection.rows).toHaveLength(1)
    expect(projection.rows[0]).toMatchObject({
      pr: "PR1",
      revision: 2,
      status: "pending",
      timestamp: currentSubmittedAt,
      sourceReadyAt: firstSubmittedAt,
      revisionLineage: [{ pr: "PR1", revisions: [1, 2], sourceReadyAt: firstSubmittedAt }],
      detail: "position 1 · rev1→rev2",
      ageMs: 120 * minute,
      totalMs: null,
      activeMs: null,
      waitMs: 5 * minute,
    })
    const rendered = await renderString(createElement(QueueTimelineView, { projection }), {
      width: 200,
      height: 30,
      plain: true,
    })
    // The cumulative source-ready age (2h, not the 5m of the current
    // revision) is the visible AGE; lineage stays in the row detail/JSON.
    expect(rendered).toContain("pr#1.2")
    expect(rendered).toContain("2:00:00")

    const running = fakeRun({
      id: "R1",
      status: "running",
      pr: { id: pr.id, revision: pr.revision, headSha: pr.headSha, baseSha: pr.baseSha },
      subject: pr.branch,
      startedAt: "2026-07-13T11:57:00.000Z",
      steps: [],
    })
    const runningProjection = queueTimelineProjection([{ ...result, running: [running] }], {
      now,
      windowMs: 6 * 60 * minute,
      statuses: ["pending", "running", "rejected", "integrated", "other"],
      terms: [],
      latest: false,
      rowLimit: 20,
      submissionTimes: new Map([[queueRevisionKey(pr), currentSubmittedAt]]),
    })
    expect(runningProjection.rows).toMatchObject([
      {
        run: "R1",
        pr: "PR1",
        revision: 2,
        status: "running",
        revisionLineage: [{ pr: "PR1", revisions: [1, 2], sourceReadyAt: firstSubmittedAt }],
        detail: "running · rev1→rev2",
      },
    ])
  })

  it("renders every batched PR revision as its own settled queue row", async () => {
    const now = Date.parse("2026-07-13T12:00:00.000Z")
    const submittedAt = "2026-07-13T11:30:00.000Z"
    const finishedAt = "2026-07-13T11:50:00.000Z"
    const pr = (id: string, actor: string, headSha: string): PR => ({
      id,
      name: `${id} subject`,
      branch: `topic/${id}`,
      base: "main",
      status: "integrated",
      revision: 1,
      headSha,
      baseSha: BASE_SHA,
      revisions: [
        {
          revision: 1,
          headSha,
          base: "main",
          baseSha: BASE_SHA,
          pushedAt: submittedAt,
          submittedAt,
          actor,
          terminal: { status: "integrated", at: finishedAt },
        },
      ],
      reviews: [],
      comments: [],
      checkRequests: [],
      submittedAt,
      integratedAt: finishedAt,
    })
    const prs = [pr("PR1", "@cto", "1".repeat(40)), pr("PR2", "@agent/3", "2".repeat(40))]
    const run: QueueRun = {
      ...fakeRun({
        id: "R1",
        status: "passed",
        startedAt: "2026-07-13T11:40:00.000Z",
        finishedAt,
        steps: [fakeStep("check", "passed", fakeJob({ id: JOB_CHECK_PASS_ID, status: "passed" }))],
        integration: { commit: MERGED_SHA, baseSha: BASE_SHA },
      }),
      prs: prs.map(({ id, branch, base, revision, headSha, baseSha }) => ({
        id,
        branch,
        base,
        revision,
        headSha,
        baseSha,
      })),
    }
    const result: QueueStatusResult = {
      base: "main",
      prs,
      running: [],
      waiting: [],
      finished: [run],
    }
    const projection = queueTimelineProjection([result], {
      now,
      windowMs: 6 * 60 * 60_000,
      statuses: ["pending", "running", "rejected", "integrated", "other"],
      terms: [],
      latest: false,
      rowLimit: 20,
      submissionTimes: queueTimelineAdmissionTimes([result]),
    })

    expect(projection.rows).toMatchObject([
      { id: "main:run:R1:PR1:1", run: "R1", pr: "PR1", revision: 1, submitter: "@cto" },
      { id: "main:run:R1:PR2:1", run: "R1", pr: "PR2", revision: 1, submitter: "@agent/3" },
    ])
    expect(projection.metrics).toMatchObject({ terminalAttempts: 1, outcomes: { integrated: 1 } })

    const rendered = stripOsc8Targets(
      // Height fits the FLOW + TIME boxes; a standalone QueueTimelineView
      // has no fillHeight list-scroll, so a box tuned to the old short grid would
      // clip the FILTER/header rows. Production (QueueWatchFrame) scrolls the list.
      await renderString(createElement(QueueTimelineView, { projection, columns: 140 }), {
        width: 140,
        height: 44,
        plain: true,
      }),
    )
    const rows = rendered.split("\n").filter(Boolean)
    const header = rows.find((row) => row.includes("TIME") && row.includes("STATUS") && row.includes("PR"))
    expect(header).toBeDefined()
    for (const label of ["TIME", "STATUS", "RUN", "PR", "BY", "AGE"]) expect(header).toContain(label)
    // STEP folded into the PR cell (item Q), so it is no longer a header column.
    for (const removed of ["STEP", "SUBJECT", "DETAIL", "ACTIVE", "WAIT", "TOTAL"]) {
      expect(header).not.toContain(removed)
    }
    const first = rows.find((row) => row.includes("pr#1.1"))
    const second = rows.find((row) => row.includes("pr#2.1"))
    expect(first).toContain("main#1")
    expect(first).toContain("@cto")
    // Adjacent members retain their own PR facts while Run-level cells become
    // continuation placeholders (Round 8 presentation contract).
    expect(second?.trimStart()).toMatch(/^-\s+-\s+-\s+pr#2\.1\b/u)
    expect(second).not.toContain("main#1")
    expect(second).toContain("@agent/3")
    expect(rendered).not.toContain("R1·PR1,PR2")
    expect(rendered).not.toContain("siblings none")
    // Item 2/3: the status pills row moved BELOW the list (was directly above
    // the header) and dropped its "FILTER" label — plain-word pills now.
    const pillsRowIndex = rows.findIndex((row) => /pending.*running.*failed.*done/u.test(row))
    expect(pillsRowIndex, "pills row renders below the rows").toBeGreaterThan(rows.indexOf(second!))
    const flowIndex = rows.findIndex((row) => row.includes("╭─ FLOW "))
    expect(flowIndex).toBeGreaterThan(pillsRowIndex)
  })

  it("projects fresh, stale, and absent resident runner heartbeats", async () => {
    const repo = mkdtempSync(join(tmpdir(), "yrd-runner-status-"))
    execFileSync("git", ["init", "-q", repo])
    const statusDir = join(repo, ".git", "yrd", "resident-runner")
    const statusPath = join(statusDir, "status.json")
    mkdirSync(statusDir, { recursive: true })
    const runner = {
      pid: 4242,
      startedAt: "2026-07-13T11:00:00.000Z",
      lastTickAt: "2026-07-13T11:59:55.000Z",
    }
    writeFileSync(statusPath, JSON.stringify(runner))

    try {
      const app = await createApp()
      await openAndSubmit(app)
      const resolveQueueTarget = async () => ({ base: "main", sha: BASE_SHA })
      const fresh = outputIO({
        cwd: repo,
        now: () => Date.parse("2026-07-13T12:00:00.000Z"),
        resolveQueueTarget,
      })
      expect(await runYrd(app, yrd("queue", "list", "--json"), fresh.io), fresh.stderr()).toBe(0)
      expect(JSON.parse(fresh.stdout())).toMatchObject({ command: "queue.list", projection: { runner } })

      const stale = outputIO({
        cwd: repo,
        now: () => Date.parse("2026-07-13T12:00:20.001Z"),
        resolveQueueTarget,
      })
      expect(await runYrd(app, yrd("queue", "list"), stale.io), stale.stderr()).toBe(0)
      expect(stale.stdout()).toContain("RUNNER STALE")

      rmSync(statusPath)
      const absent = outputIO({ cwd: repo, resolveQueueTarget })
      expect(await runYrd(app, yrd("queue", "list"), absent.io), absent.stderr()).toBe(0)
      expect(absent.stdout()).toContain("NO RUNNER - no drained run in window")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it("queue list --check is a typed lease probe with drift remedies and git distance", async () => {
    const repo = mkdtempSync(join(tmpdir(), "yrd-runner-health-check-"))
    execFileSync("git", ["init", "-q", "-b", "main", repo])
    execFileSync("git", ["-C", repo, "config", "user.name", "Yrd Test"])
    execFileSync("git", ["-C", repo, "config", "user.email", "yrd@example.invalid"])
    writeFileSync(join(repo, "README.md"), "base\n")
    execFileSync("git", ["-C", repo, "add", "README.md"])
    execFileSync("git", ["-C", repo, "commit", "-qm", "base"])
    const baseSha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
    const stateDir = join(repo, ".git", "yrd")
    await writeInstalledBaseline(stateDir, {
      base: "main",
      baseSha,
      installedAt: "2026-07-09T11:00:00.000Z",
      steps: [{ name: "check", title: "check", revision: "check-v1", integrates: false, needsIntegration: false }],
    })
    writeFileSync(join(repo, "distance.txt"), "ahead\n")
    execFileSync("git", ["-C", repo, "add", "distance.txt"])
    execFileSync("git", ["-C", repo, "commit", "-qm", "ahead"])
    writeFileSync(join(repo, "untracked-divergence.txt"), "local\n")

    const app = await createApp()
    let findings: Array<{ code: string; message: string }> = []
    const services: YrdCliServices = { queue: { auditEnvironment: async () => ({ findings }) } }
    const lockRelease = Promise.withResolvers<void>()
    const lockAcquired = Promise.withResolvers<void>()
    let lock: Promise<void> | undefined
    try {
      const absent = outputIO({ cwd: repo })
      expect(await runYrd(app, yrd("queue", "list", "--check", "--json"), absent.io, services)).toBe(1)
      expect(JSON.parse(absent.stdout())).toMatchObject({
        schema: "hab-service-health/1",
        service: "yrd-runner",
        state: "absent",
        running: false,
        facts: { lease: "free", git: { dirty: true, baselines: [{ base: "main", ahead: 1, behind: 0 }] } },
      })

      lock = createExclusive(join(stateDir, "resident-runner"), { timeoutMs: 0 }).run(async () => {
        lockAcquired.resolve()
        await lockRelease.promise
      })
      await lockAcquired.promise
      mkdirSync(join(stateDir, "resident-runner"), { recursive: true })
      writeFileSync(
        join(stateDir, "resident-runner", "status.json"),
        JSON.stringify({
          pid: process.pid,
          startedAt: "2026-07-09T12:00:00.000Z",
          lastTickAt: "2026-07-09T12:00:58.000Z",
          command: "yrd queue run --follow",
        }),
      )

      const healthy = outputIO({ cwd: repo })
      expect(await runYrd(app, yrd("queue", "list", "--check", "--json"), healthy.io, services)).toBe(0)
      expect(JSON.parse(healthy.stdout())).toMatchObject({
        schema: "hab-service-health/1",
        state: "healthy",
        running: true,
        facts: { lease: "held", runnerStatus: "fresh" },
      })

      const failedAudit = outputIO({ cwd: repo })
      const failedAuditServices: YrdCliServices = {
        queue: {
          auditEnvironment: async () => {
            throw new Error("audit unavailable")
          },
        },
      }
      expect(await runYrd(app, yrd("queue", "list", "--check", "--json"), failedAudit.io, failedAuditServices)).toBe(2)
      expect(JSON.parse(failedAudit.stdout())).toMatchObject({
        state: "unhealthy",
        running: true,
        error: { code: "runner-health-failed" },
        facts: { lease: "held" },
      })

      const failedBootstrap = outputIO({ cwd: repo })
      expect(
        await runInternals.runYrdProcessRuntime(yrd("queue", "list", "--check", "--json"), failedBootstrap.io, {
          ambientCwd: repo,
          env: process.env,
          load: async () => {
            throw new Error("no event definition for 'bay/handoff-certified'")
          },
        }),
      ).toBe(2)
      expect(JSON.parse(failedBootstrap.stdout())).toMatchObject({
        schema: "hab-service-health/1",
        state: "unhealthy",
        running: true,
        error: { code: "runner-health-failed", cause: "no event definition for 'bay/handoff-certified'" },
        facts: { lease: "held" },
      })

      writeFileSync(
        join(stateDir, "resident-runner", "status.json"),
        JSON.stringify({
          pid: process.pid,
          startedAt: "2026-07-09T12:00:00.000Z",
          lastTickAt: "2026-07-09T12:00:40.000Z",
        }),
      )
      const stale = outputIO({ cwd: repo })
      expect(await runYrd(app, yrd("queue", "list", "--check", "--json"), stale.io, services)).toBe(2)
      expect(JSON.parse(stale.stdout())).toMatchObject({
        state: "unhealthy",
        running: true,
        error: { code: "resident-runner-unhealthy" },
        facts: { lease: "held", runnerStatus: "stale", runnerAgeMs: 20_000 },
      })

      writeFileSync(
        join(stateDir, "resident-runner", "status.json"),
        JSON.stringify({
          pid: process.pid,
          startedAt: "2026-07-09T12:00:00.000Z",
          lastTickAt: "2026-07-09T12:00:58.000Z",
        }),
      )

      findings = [
        {
          code: "config-drift",
          message:
            "queue base 'main' installed baseline is stale. Run 'yrd queue deinit main' then 'yrd queue init main' to migrate it.",
        },
      ]
      const unhealthy = outputIO({ cwd: repo })
      expect(await runYrd(app, yrd("queue", "list", "--check", "--json"), unhealthy.io, services)).toBe(2)
      expect(JSON.parse(unhealthy.stdout())).toMatchObject({
        schema: "hab-service-health/1",
        state: "unhealthy",
        running: true,
        error: {
          code: "config-drift",
          resolution: ["yrd queue deinit main", "yrd queue init main"],
        },
      })

      const human = outputIO({ cwd: repo })
      expect(await runYrd(app, yrd("queue", "list", "--check"), human.io, services)).toBe(2)
      expect(human.stdout()).toContain("err=config-drift")
      expect(human.stdout()).toContain("resolve: yrd queue deinit main")
      expect(human.stdout()).toContain("resolve: yrd queue init main")
    } finally {
      lockRelease.resolve()
      await lock
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it("writes atomic resident runner heartbeats and removes them on close", async () => {
    const repo = mkdtempSync(join(tmpdir(), "yrd-runner-heartbeat-"))
    execFileSync("git", ["init", "-q", repo])
    const statusPath = join(repo, ".git", "yrd", "resident-runner", "status.json")
    let now = Date.parse("2026-07-13T12:00:00.000Z")
    try {
      const heartbeat = await runInternals.startResidentRunnerHeartbeat(
        outputIO({ cwd: repo, runner: `yrd-cli:${process.pid}`, now: () => now }).io,
        { intervalMs: 5 },
      )
      try {
        expect(JSON.parse(readFileSync(statusPath, "utf8"))).toEqual({
          pid: process.pid,
          startedAt: "2026-07-13T12:00:00.000Z",
          lastTickAt: "2026-07-13T12:00:00.000Z",
          // The dedicated RUNNER box renders stale-runner details as `[pid] <command>`.
          command: expect.any(String),
        })
        now += 1_000
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(JSON.parse(readFileSync(statusPath, "utf8"))).toMatchObject({
          pid: process.pid,
          lastTickAt: "2026-07-13T12:00:01.000Z",
        })
        heartbeat.check()
      } finally {
        await heartbeat.close()
      }
      expect(existsSync(statusPath)).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it("builds one filtered one-revision timeline and deduplicated FLOW/TIME projection", async () => {
    const minute = 60_000
    const now = Date.parse("2026-07-13T12:00:00.000Z")
    const member = (id: string, revision: number, headSha: string) => ({
      id,
      branch: `topic/${id}`,
      base: "main",
      revision,
      headSha,
      baseSha: BASE_SHA,
    })
    const integrated: QueueRun = {
      ...fakeRun({
        id: "R1",
        status: "passed",
        startedAt: "2026-07-13T10:00:00.000Z",
        finishedAt: "2026-07-13T10:10:00.000Z",
        steps: [],
        integration: { commit: MERGED_SHA, baseSha: BASE_SHA },
      }),
      prs: [member("PR1", 1, "1".repeat(40)), member("PR2", 1, "2".repeat(40))],
    }
    const rejected = fakeRun({
      id: "R2",
      status: "failed",
      pr: { id: "PR3", revision: 1, headSha: "3".repeat(40), baseSha: BASE_SHA },
      startedAt: "2026-07-13T11:00:00.000Z",
      finishedAt: "2026-07-13T11:20:00.000Z",
      steps: [],
      error: { code: "typecheck-failed", message: "payload does not typecheck" },
    })
    const environment = fakeRun({
      id: "R3",
      status: "failed",
      pr: { id: "PR4", revision: 1, headSha: "4".repeat(40), baseSha: BASE_SHA },
      startedAt: "2026-07-13T11:15:00.000Z",
      finishedAt: "2026-07-13T11:45:00.000Z",
      steps: [],
      error: { code: "queue-environment-refused", message: "origin was unavailable" },
    })
    const canceled = fakeRun({
      id: "R6",
      status: "failed",
      pr: { id: "PR7", revision: 1, headSha: "7".repeat(40), baseSha: BASE_SHA },
      startedAt: "2026-07-13T11:27:00.000Z",
      finishedAt: "2026-07-13T11:47:00.000Z",
      steps: [],
      error: { code: "canceled", message: "operator canceled the run" },
    })
    const running = fakeRun({
      id: "R4",
      status: "running",
      pr: { id: "PR5", revision: 1, headSha: "5".repeat(40), baseSha: BASE_SHA },
      startedAt: "2026-07-13T11:50:00.000Z",
      steps: [],
    })
    const prs = [
      { id: "PR1", status: "integrated", name: "one", submittedAt: "2026-07-13T09:55:00.000Z" },
      { id: "PR2", status: "integrated", name: "two", submittedAt: "2026-07-13T09:45:00.000Z" },
      { id: "PR3", status: "rejected", name: "three", submittedAt: "2026-07-13T10:35:00.000Z" },
      { id: "PR4", status: "submitted", name: "four", submittedAt: "2026-07-13T10:40:00.000Z" },
      { id: "PR5", status: "submitted", name: "five", submittedAt: "2026-07-13T11:40:00.000Z" },
      { id: "PR6", status: "submitted", name: "six", submittedAt: "2026-07-13T11:55:00.000Z" },
      { id: "PR7", status: "withdrawn", name: "seven", submittedAt: "2026-07-13T11:20:00.000Z" },
    ].map((pr, index) => ({
      ...pr,
      branch: `topic/${pr.id}`,
      base: "main",
      revision: 1,
      headSha: String(index + 1).repeat(40),
    })) as unknown as PR[]
    const result: QueueStatusResult = {
      base: "main",
      prs,
      running: [running],
      waiting: [],
      finished: [integrated, rejected, environment, canceled],
      pause: {
        base: "main",
        reason: "operator freeze",
        allowedPRs: ["PR6"],
        pausedAt: "2026-07-13T11:30:00.000Z",
      },
    }
    const submissionTimes = new Map(prs.map((pr) => [queueRevisionKey(pr), pr.submittedAt!]))

    const projection = queueTimelineProjection([result], {
      now,
      windowMs: 6 * 60 * minute,
      statuses: ["pending", "running", "rejected", "integrated", "other"],
      terms: [],
      latest: false,
      rowLimit: 4,
      submissionTimes,
      retainedSinceMs: Date.parse("2026-07-13T07:00:00.000Z"),
      siblingBases: ["release"],
    })

    expect(projection.base).toBe("main")
    expect(projection.siblingBases).toEqual(["release"])
    expect(projection.pause).toMatchObject({ reason: "operator freeze", allowedPRs: ["PR6"] })
    expect(projection.oldestOpenMs).toBe(80 * minute)
    // The flow aggregate is self-contained: it carries the same oldest-open age
    // and a per-24h throughput projected from the landed count over the window.
    expect(projection.metrics.oldestOpenMs).toBe(80 * minute)
    expect(projection.metrics.throughput).toEqual({ landed: 1, per24h: 4 })
    expect(projection.rows.map((row) => [row.group, row.status, row.run ?? row.pr, row.pr])).toEqual([
      ["pending", "pending", "PR4", "PR4"],
      ["pending", "pending", "PR6", "PR6"],
      ["running", "running", "R4", "PR5"],
      ["completed", "canceled", "R6", "PR7"],
      ["completed", "environment-refused", "R3", "PR4"],
      ["completed", "rejected", "R2", "PR3"],
      ["completed", "integrated", "R1", "PR1"],
      ["completed", "integrated", "R1", "PR2"],
    ])
    expect(projection.rows.find((row) => row.group === "pending" && row.pr === "PR4")).toMatchObject({
      ageMs: 80 * minute,
      totalMs: null,
      activeMs: null,
      waitMs: 80 * minute,
    })
    // A running member's AGE measures its own source-readiness, not run recency.
    expect(projection.rows.find((row) => row.run === "R4")).toMatchObject({
      pr: "PR5",
      ageMs: 20 * minute,
      totalMs: 10 * minute,
      activeMs: null,
      waitMs: null,
    })
    // One physical row per batched member: Run facts repeat, member facts differ.
    expect(
      projection.rows
        .filter((row) => row.run === "R1")
        .map((row) => ({
          pr: row.pr,
          ageMs: row.ageMs,
          totalMs: row.totalMs,
          activeMs: row.activeMs,
          waitMs: row.waitMs,
          queueWaitMs: row.queueWaitMs,
        })),
    ).toEqual([
      {
        pr: "PR1",
        ageMs: 15 * minute,
        totalMs: 10 * minute,
        activeMs: 0,
        waitMs: 10 * minute,
        queueWaitMs: 5 * minute,
      },
      {
        pr: "PR2",
        ageMs: 25 * minute,
        totalMs: 10 * minute,
        activeMs: 0,
        waitMs: 10 * minute,
        queueWaitMs: 15 * minute,
      },
    ])
    expect(
      (JSON.parse(JSON.stringify(projection.rows)) as typeof projection.rows).filter((row) => row.run === "R1"),
    ).toMatchObject([
      { pr: "PR1", ageMs: 15 * minute, totalMs: 10 * minute, activeMs: 0, waitMs: 10 * minute },
      { pr: "PR2", ageMs: 25 * minute, totalMs: 10 * minute, activeMs: 0, waitMs: 10 * minute },
    ])
    expect(projection.display).toEqual({ limit: 4, shown: 4, hidden: 4 })
    expect(projection.coverage).toEqual({
      requestedSince: "2026-07-13T06:00:00.000Z",
      retainedSince: "2026-07-13T07:00:00.000Z",
      complete: false,
    })
    expect(projection.metrics).toMatchObject({
      terminalAttempts: 4,
      outcomes: { integrated: 1, rejected: 1, environmentRefused: 1, canceled: 1 },
      decisionRejection: { rejected: 1, decisions: 2, rate: 0.5 },
      activeRun: {
        allTerminal: { n: 4, minMs: 10 * minute, avgMs: 20 * minute, p50Ms: 20 * minute },
        integratedOnly: { n: 1, minMs: 10 * minute, avgMs: 10 * minute },
      },
      queueWait: { n: 5, avgMs: 1_044_000, p50Ms: 15 * minute, p90Ms: 35 * minute },
    })
    const constrainedProjection = {
      ...projection,
      now: "2026-07-14T12:00:00.000Z",
      metrics: {
        ...projection.metrics,
        terminalAttempts: 44,
        outcomes: { integrated: 39, rejected: 5, environmentRefused: 0, canceled: 0 },
        decisionRejection: { rejected: 5, decisions: 44, rate: 5 / 44 },
      },
    }
    const rendered = await renderString(
      createElement(QueueTimelineView, {
        projection: { ...constrainedProjection, display: { limit: 20, shown: projection.rows.length, hidden: 0 } },
        columns: 200,
      }),
      // Round 5 groups three TIME distributions under explicit headings. Give
      // the complete static surface enough rows; production printHuman uses a
      // 10,000-row render target and is never terminal-height clipped.
      { width: 200, height: 44, plain: true },
    )
    expect(rendered).toContain("TIME")
    expect(rendered).toContain("STATUS")
    expect(rendered).toContain("AGE")
    expect(rendered).toContain("main#4")
    expect(rendered).toContain("pr#5.1")
    expect(rendered).toContain("typecheck-failed")
    expect(rendered).not.toContain("R4·PR5")
    expect(rendered).not.toContain("SUBJECT")
    for (const width of [80, 120]) {
      const fixed = stripOsc8Targets(
        await renderString(
          createElement(QueueTimelineView, {
            projection: {
              ...constrainedProjection,
              display: { limit: 20, shown: projection.rows.length, hidden: 0 },
            },
            columns: width,
          }),
          // Height fits the FLOW + TIME boxes. The standalone
          // QueueTimelineView has no fillHeight list-scroll, so a box tuned to the
          // old short statistics surface would clip the header at a narrow tier.
          // Production (QueueWatchFrame) keeps the header via
          // the scrolling list at any height.
          { width, height: 44, plain: true },
        ),
      )
      const rows = fixed.split("\n")
      const filter = rows.find((row) => /pending.*running.*failed.*done/u.test(row))
      // The pills share the row with the left-aligned coverage text ("retained
      // since …" / "... N more"), so assert the pill cluster is present rather
      // than owning the whole row (W1, 2026-07-16). Item 3: no "FILTER" label,
      // no [p] brackets — the since= dimension survives, pills are plain words.
      expect.soft(filter).toContain("since=6:00:00 pending running failed done")
      // The FLOW + TIME boxes read the SAME consolidated queueFlowMetrics
      // aggregate at every tier. The landed per-24h throughput fact stays in the
      // aggregate (projection.metrics.throughput) for --json consumers.
      expect.soft(rows.some((row) => row.includes("╭─ FLOW "))).toBe(true)
      expect.soft(fixed).toContain("RUNS")
      expect(Math.max(...rows.map((row) => Array.from(row).length))).toBeLessThanOrEqual(width)
      const header = rows.find((row) => row.includes("TIME") && row.includes("PR"))
      expect(header).not.toContain("STEP")
      expect(header).toContain("AGE")
      expect(header?.trimEnd()).toMatch(/RUN$/u)
      expect(header).not.toContain("TOTAL")
      expect(header).toContain("STATUS")
      expect(header).not.toContain("ACTIVE")
      expect(header).not.toContain("WAIT")
      expect(header).not.toContain("SUBJECT")
      expect(header).not.toContain("DETAIL")
      // The BY submitter column drops first on the narrow tier.
      if (width === 80) expect(header).not.toContain("BY")
      else expect(header).toContain("BY")
      const integratedLine = rows.find((row) => row.includes("pr#1.1"))
      expect(integratedLine).toBeDefined()
      // Local wall clock (suite pins Asia/Kolkata): 10:10Z renders 15:40:00,
      // date-qualified but never truncated below seconds.
      expect(integratedLine).toContain("2026-07-13T15:40:00")
      expect(integratedLine).toContain("✓ done")
      expect(integratedLine?.trimEnd()).toMatch(/15:00 10:00$/u)
    }
    // Height fits the FLOW + stacked-TIME grid so the list rows are not clipped
    // by the taller stats block (standalone view has no fillHeight list-scroll).
    const renderStyledTimeline = createRenderer({ cols: 200, rows: 44 })
    const styled = renderStyledTimeline(
      createElement(QueueTimelineView, {
        projection: { ...projection, display: { limit: 20, shown: projection.rows.length, hidden: 0 } },
        columns: 200,
      }),
    )
    await styled.waitForLayoutStable()
    try {
      // Markers are semantic-foreground only — the canonical km/ag glyphs,
      // never a colored STATUS background band.
      for (const [glyph, anchor] of [
        ["○", "pr#6.1"],
        ["●", "pr#5.1"],
        ["−", "pr#7.1"],
        ["×", "pr#3.1"],
        // PR2 is the adjacent continuation member of PR1's Run, so its
        // Run-level status marker is intentionally suppressed.
        ["✓", "pr#1.1"],
      ] as const) {
        const row = styled.lines.findIndex((row) => row.includes(anchor))
        expect(row, anchor).toBeGreaterThan(0)
        const column = styled.lines[row]?.indexOf(glyph) ?? -1
        expect(column, `${anchor} marker`).toBeGreaterThanOrEqual(0)
        expect(styled.cell(column, row).bg, `${anchor} is foreground-only`).toBeNull()
      }
    } finally {
      styled.unmount()
    }

    const integratedOnly = queueTimelineProjection([result], {
      now,
      windowMs: 6 * 60 * minute,
      statuses: ["integrated"],
      terms: ["PR2"],
      latest: false,
      rowLimit: 20,
      submissionTimes,
    })
    // Term filtering is per member row; metrics come from the already-filtered
    // snapshot, so only the visible member's queue wait is counted.
    expect(integratedOnly.rows.map((row) => [row.run, row.pr])).toEqual([["R1", "PR2"]])
    expect(integratedOnly.metrics).toMatchObject({
      terminalAttempts: 1,
      outcomes: { integrated: 1, rejected: 0, environmentRefused: 0, canceled: 0 },
      queueWait: { n: 1 },
    })

    const newerPrOne = fakeRun({
      id: "R5",
      status: "failed",
      pr: { id: "PR1", revision: 2, headSha: "9".repeat(40), baseSha: BASE_SHA },
      startedAt: "2026-07-13T11:50:00.000Z",
      finishedAt: "2026-07-13T11:55:00.000Z",
      steps: [],
      error: { code: "check-failed", message: "newer PR1 attempt failed" },
    })
    const latest = queueTimelineProjection([{ ...result, finished: [...result.finished, newerPrOne] }], {
      now,
      windowMs: 6 * 60 * minute,
      statuses: ["pending", "running", "rejected", "integrated", "other"],
      terms: [],
      latest: true,
      rowLimit: 20,
      submissionTimes,
    })
    expect(latest.rows.find((row) => row.run === "R5")?.pr).toBe("PR1")
    expect(latest.rows.filter((row) => row.run === "R1").map((row) => row.pr)).toEqual(["PR2"])
    expect(latest.rows.filter((row) => row.pr === "PR1")).toHaveLength(1)
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
    expect(watch.stderr()).toMatch(/^yrd watch runtime: yrd 0\.0\.1\+[0-9a-f]{10}(?:-dirty)?\n$/u)
    expect(mounted?.type).toBe(QueueWatchPane)
    const props = mounted?.props as QueueWatchPaneProps
    expect(props.intervalMs).toBe(1_000)
    expect(props.initial.diffs, "initial paint must not synchronously probe every visible PR").toBeUndefined()
    await expect(props.load({ pr: "PR1", revision: 1 })).resolves.toMatchObject({
      diffs: [{ pr: "PR1", revision: 1, unavailable: "git-error" }],
    })
    // Exercise the live runtime so useWindowSize sees the mounted 200×50
    // viewport; renderString's first synchronous frame intentionally reports
    // the fallback 80×24 hook size and cannot certify responsive watch IA.
    const frameHandle = await run(createElement(QueueWatchFrame, { snapshot: props.initial }), {
      writable: { write: () => {} },
      cols: 200,
      rows: 50,
    })
    try {
      await frameHandle.waitForLayoutStable()
      const frame = stripOsc8Targets(frameHandle.text)
      expect(frame).toContain("pr#1.1")
      expect(frame).toContain("QUEUE main")
      expect(frame).toContain("pending")
      expect(frame).not.toContain("position 1")
      expect(frame).toContain("AGE")
      expect(frame).toContain("WAIT")
      expect(frame).toContain("NO RUNNER - no drained run in window")
      // The bottom keybindings footer row was removed entirely (item h).
      expect(frame).not.toContain("q quit")
      expect(frame).not.toContain("LIVE")
      expect(frame).not.toContain("p pause")
      expect(frame).not.toContain("PATH")
      expect(frame).not.toContain("file:///repo/.bays/B1")
    } finally {
      frameHandle.unmount()
    }
    expect(await Array.fromAsync(app.events()).then((events) => events.length)).toBe(before)
  })

  it("keeps the detail pane on the timeline cursor without requiring Enter", async () => {
    const result = {
      base: "main",
      headSha: BASE_SHA,
      prs: [
        {
          id: "PR1",
          name: "First",
          branch: "topic/one",
          base: "main",
          status: "submitted",
          revision: 1,
          headSha: HEAD_SHA,
          revisions: [submittedRevision(1, HEAD_SHA, "2026-07-09T12:00:00.000Z")],
          submittedAt: "2026-07-09T12:00:00.000Z",
        },
        {
          id: "PR2",
          name: "Second",
          branch: "topic/two",
          base: "main",
          status: "submitted",
          revision: 1,
          headSha: "2".repeat(40),
          revisions: [submittedRevision(1, "2".repeat(40), "2026-07-09T12:01:00.000Z")],
          submittedAt: "2026-07-09T12:01:00.000Z",
        },
      ],
      running: [],
      waiting: [],
      finished: [],
    } as unknown as QueueStatusResult
    const handle = await run(
      createElement(QueueWatchFrame, {
        snapshot: { results: [result], now: Date.parse("2026-07-09T12:02:00.000Z") },
      }),
      { writable: { write: () => {} }, cols: 120, rows: 30 },
    )

    try {
      expect(handle.text).toContain("> 2m submitted pr#1.1")
      expect(handle.text).toContain(`HEAD     ${HEAD_SHA}`)
      expect(handle.text).not.toMatch(/\bPRS\b/giu)

      await handle.press("j")
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("> 1m submitted pr#2.1")
      expect(handle.text).toContain(`HEAD     ${"2".repeat(40)}`)
      expect(handle.text).not.toContain(`HEAD     ${HEAD_SHA}`)

      await handle.press("Enter")
      await handle.waitForLayoutStable()
      expect(handle.text).toContain(`HEAD     ${"2".repeat(40)}`)
      expect(handle.text).not.toContain(`HEAD     ${HEAD_SHA}`)
    } finally {
      handle.unmount()
    }
  })

  it("loads watch details only for the row that currently owns the cursor", async () => {
    const result = {
      base: "main",
      headSha: BASE_SHA,
      prs: [
        {
          id: "PR1",
          name: "First",
          branch: "topic/one",
          base: "main",
          status: "submitted",
          revision: 1,
          headSha: HEAD_SHA,
          revisions: [submittedRevision(1, HEAD_SHA, "2026-07-09T12:00:00.000Z")],
          submittedAt: "2026-07-09T12:00:00.000Z",
        },
        {
          id: "PR2",
          name: "Second",
          branch: "topic/two",
          base: "main",
          status: "submitted",
          revision: 2,
          headSha: "2".repeat(40),
          revisions: [submittedRevision(2, "2".repeat(40), "2026-07-09T12:01:00.000Z")],
          submittedAt: "2026-07-09T12:01:00.000Z",
        },
      ],
      running: [],
      waiting: [],
      finished: [],
    } as unknown as QueueStatusResult
    const initial = { results: [result], now: Date.parse("2026-07-09T12:02:00.000Z") }
    const requested: Array<{ pr: string; revision: number; run?: string } | undefined> = []
    let activeLoads = 0
    let maxActiveLoads = 0
    let releaseFirstFocus = (): void => undefined
    const firstFocusBlocked = new Promise<void>((resolve) => {
      releaseFirstFocus = resolve
    })
    let announceFirstFocus = (): void => undefined
    const firstFocusStarted = new Promise<void>((resolve) => {
      announceFirstFocus = resolve
    })
    const handle = await run(
      createElement(QueueWatchPane, {
        initial,
        load: async (focus?: { pr: string; revision: number; run?: string }) => {
          activeLoads++
          maxActiveLoads = Math.max(maxActiveLoads, activeLoads)
          requested.push(focus)
          try {
            if (focus?.pr === "PR1") {
              announceFirstFocus()
              await firstFocusBlocked
            }
            return initial
          } finally {
            activeLoads--
          }
        },
        intervalMs: 5,
      }),
      { writable: { write: () => {} }, cols: 120, rows: 30 },
    )

    try {
      await firstFocusStarted
      await handle.press("j")
      await handle.waitForLayoutStable()
      expect(handle.text).toContain("> 1m submitted pr#2.2")
      // The focused PR1 load is still pending, but keyboard input has already
      // moved the cursor. Releasing it must coalesce one PR2 refresh rather than
      // overlap or commit stale PR1 detail.
      releaseFirstFocus()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(requested).toContainEqual({ pr: "PR2", revision: 2 })
      expect(maxActiveLoads).toBe(1)
    } finally {
      releaseFirstFocus()
      handle.unmount()
    }
  })

  it("uses the natural-size right, below, and full-area detail ladder", async () => {
    const source = readFileSync(new URL("../src/watch-pane.tsx", import.meta.url), "utf8")
    expect(source).toMatch(/import\s*\{[^}]*\bSplitPane\b[^}]*\}\s*from\s*"silvery"/su)
    expect(source).toContain("resolveSplitPaneLayout")
    expect(source).not.toContain("PaneDivider")
    expect(source).not.toContain("queueSplitRatioAfterDrag")

    expect(queueDetailTier(200, 50)).toBe("right")
    expect(queueDetailTier(100, 40)).toBe("below")
    expect(queueDetailTier(80, 24)).toBe("full")

    const app = await createApp()
    await openAndSubmit(app)
    let mounted: ReactElement | undefined
    const output = outputIO({
      now: () => Date.parse("2026-07-09T12:01:00.000Z"),
      resolveQueueTarget: async () => ({ base: "main", sha: BASE_SHA }),
    })
    const live = withLiveRenderer(output.io, async (element) => {
      mounted = element
    })
    expect(await runYrd(app, yrd("queue", "ls", "--watch"), live), output.stderr()).toBe(0)
    if (mounted === undefined) throw new Error("expected queue watch pane to mount")
    const snapshot = (mounted.props as QueueWatchPaneProps).initial

    const wide = await run(createElement(QueueWatchFrame, { snapshot }), {
      writable: { write: () => {} },
      cols: 200,
      rows: 50,
    })
    const below = await run(createElement(QueueWatchFrame, { snapshot }), {
      writable: { write: () => {} },
      cols: 100,
      rows: 40,
    })
    const compact = await run(createElement(QueueWatchFrame, { snapshot }), {
      writable: { write: () => {} },
      cols: 80,
      rows: 24,
    })

    try {
      expect(wide.text).toContain("│")
      // Right-docked: the DETAIL pane's identity title (item M — the selected
      // `PR.rev`) shares the top row with the QUEUE tab.
      expect(wide.text.split("\n")[0]).toMatch(/pr#\d+\.\d+/u)
      expect(wide.text).toContain(`HEAD     ${HEAD_SHA}`)
      await wide.press("Escape")
      await wide.waitForLayoutStable()
      expect(wide.text).not.toContain(`HEAD     ${HEAD_SHA}`)
      await wide.press("Enter")
      await wide.waitForLayoutStable()
      expect(wide.text).toContain(`HEAD     ${HEAD_SHA}`)

      expect(below.text).toContain("─")
      // Below-docked: the detail identity title is not on the top row.
      expect(below.text.split("\n")[0]).not.toMatch(/PR\d+\.\d+/u)
      expect(below.text).toContain(`HEAD     ${HEAD_SHA}`)

      expect(compact.text).toContain("QUEUE main")
      expect(compact.text).not.toContain(`HEAD     ${HEAD_SHA}`)
      await compact.press("Enter")
      await compact.waitForLayoutStable()
      expect(compact.text).toContain(`HEAD     ${HEAD_SHA}`)
      expect(compact.text).not.toContain("QUEUE main")
      await compact.press("Escape")
      await compact.waitForLayoutStable()
      expect(compact.text).toContain("QUEUE main")
      expect(compact.text).not.toContain(`HEAD     ${HEAD_SHA}`)
    } finally {
      wide.unmount()
      below.unmount()
      compact.unmount()
    }
  })

  it("reads the merged step artifact into successive watch snapshots", async () => {
    const artifactRoot = mkdtempSync(join(tmpdir(), "yrd-watch-output-"))
    const outputPath = join(artifactRoot, "R-output", "0-check", "attempt-2", "output.log")
    mkdirSync(dirname(outputPath), { recursive: true })
    const run = fakeRun({
      id: "R-output",
      status: "running",
      startedAt: "2026-07-13T11:59:00.000Z",
      steps: [
        fakeStep(
          "check",
          "running",
          fakeJob({
            id: JOB_CHECK_PASS_ID,
            status: "running",
            attempt: 2,
            startedAt: "2026-07-13T11:59:00.000Z",
          }),
        ),
      ],
    })
    const result = { ...fakeSummary([run]), prs: [] } as QueueStatusResult
    try {
      writeFileSync(outputPath, "checking one\n")
      expect(await runInternals.queueArtifactOutputs([result], artifactRoot)).toEqual([
        {
          source: "recorded",
          run: "R-output",
          step: "check",
          attempt: 2,
          path: outputPath,
          text: "checking one\n",
        },
      ])
      writeFileSync(outputPath, "checking one\nchecking two\n")
      expect((await runInternals.queueArtifactOutputs([result], artifactRoot))[0]?.text).toBe(
        "checking one\nchecking two\n",
      )
    } finally {
      rmSync(artifactRoot, { recursive: true, force: true })
    }
  })

  it("loads stdout/stderr-only files for every recorded retry attempt", async () => {
    const artifactRoot = mkdtempSync(join(tmpdir(), "yrd-watch-retry-output-"))
    const firstPath = join(artifactRoot, "R-history", "0-check", "attempt-1", "stderr.log")
    const secondPath = join(artifactRoot, "R-history", "0-check", "attempt-2", "stdout.log")
    mkdirSync(dirname(firstPath), { recursive: true })
    mkdirSync(dirname(secondPath), { recursive: true })
    writeFileSync(firstPath, "first attempt failed\n")
    writeFileSync(secondPath, "second attempt passed\n")
    const run = fakeRun({
      id: "R-history",
      status: "passed",
      startedAt: "2026-07-13T11:59:00.000Z",
      steps: [
        fakeStep(
          "check",
          "passed",
          fakeJob({
            id: JOB_CHECK_PASS_ID,
            status: "passed",
            attempt: 2,
            startedAt: "2026-07-13T12:00:00.000Z",
          }),
        ),
      ],
    })
    const result = { ...fakeSummary([run]), prs: [] } as QueueStatusResult
    const attempts: readonly QueueAttempt[] = [
      {
        job: JOB_CHECK_FAILED_ID,
        run: "R-history",
        step: "check",
        index: 0,
        attempt: 1,
        runner: "runner-1",
        outcome: "failed",
        requestedAt: "2026-07-13T11:59:00.000Z",
        startedAt: "2026-07-13T11:59:01.000Z",
        finishedAt: "2026-07-13T11:59:02.000Z",
        durationMs: 1_000,
        revision: "check-v1",
        result: {
          status: "failed",
          error: { code: "check-failed", message: "first attempt failed" },
          output: { artifacts: [{ name: "stderr", path: firstPath }] },
        },
      },
      {
        job: JOB_CHECK_PASS_ID,
        run: "R-history",
        step: "check",
        index: 0,
        attempt: 2,
        runner: "runner-2",
        outcome: "passed",
        requestedAt: "2026-07-13T12:00:00.000Z",
        startedAt: "2026-07-13T12:00:01.000Z",
        finishedAt: "2026-07-13T12:00:02.000Z",
        durationMs: 1_000,
        revision: "check-v1",
        result: { status: "passed", output: { artifacts: [{ name: "stdout", path: secondPath }] } },
      },
    ]
    try {
      expect(await runInternals.queueArtifactOutputs([result], artifactRoot, attempts)).toEqual([
        {
          source: "recorded",
          run: "R-history",
          step: "check",
          attempt: 1,
          path: firstPath,
          text: "first attempt failed\n",
        },
        {
          source: "recorded",
          run: "R-history",
          step: "check",
          attempt: 2,
          path: secondPath,
          text: "second attempt passed\n",
        },
      ])
    } finally {
      rmSync(artifactRoot, { recursive: true, force: true })
    }
  })

  it("bounds each inline watch artifact tail at 64 KiB and reports omitted bytes", async () => {
    const artifactRoot = mkdtempSync(join(tmpdir(), "yrd-watch-bounded-output-"))
    const outputPath = join(artifactRoot, "R-bounded", "0-check", "attempt-1", "output.log")
    mkdirSync(dirname(outputPath), { recursive: true })
    const omitted = "x".repeat(4 * 1_024)
    const retained = "y".repeat(64 * 1_024)
    writeFileSync(outputPath, `${omitted}${retained}`)
    const run = fakeRun({
      id: "R-bounded",
      status: "running",
      startedAt: "2026-07-13T12:00:00.000Z",
      steps: [fakeStep("check", "running", fakeJob({ id: JOB_CHECK_PASS_ID, status: "running" }))],
    })
    try {
      expect(await runInternals.queueArtifactOutputs([{ ...fakeSummary([run]), prs: [] }], artifactRoot)).toEqual([
        {
          source: "recorded",
          run: "R-bounded",
          step: "check",
          attempt: 1,
          path: outputPath,
          text: retained,
          truncatedBytes: 4 * 1_024,
        },
      ])
    } finally {
      rmSync(artifactRoot, { recursive: true, force: true })
    }
  })

  it("accepts queue ls --latest as the canonical queue list lens", async () => {
    const app = await createApp()
    await openAndSubmit(app)

    const status = outputIO({
      now: () => Date.parse("2026-07-09T12:01:00.000Z"),
      resolveQueueTarget: async () => ({ base: "main", sha: BASE_SHA }),
    })
    expect(await runYrd(app, yrd("queue", "ls", "--latest"), status.io), status.stderr()).toBe(0)
    expect(status.stdout()).toContain("pr#1.1")
    expect(status.stdout()).toContain("pending")
  })

  it("uses the queue timeline by default while --latest only changes row projection", async () => {
    const app = await createApp()
    await app.bays.submit({ branch: "topic/one", headSha: "1".repeat(40), base: "main" })
    await app.bays.submit({ branch: "topic/two", headSha: "2".repeat(40), base: "main" })

    const plain = outputIO({
      now: () => Date.parse("2026-07-09T12:01:00.000Z"),
      resolveQueueTarget: async () => ({ base: "main", sha: BASE_SHA }),
    })
    expect(await runYrd(app, yrd("queue", "ls"), plain.io), plain.stderr()).toBe(0)

    const latest = outputIO({
      now: () => Date.parse("2026-07-09T12:01:00.000Z"),
      resolveQueueTarget: async () => ({ base: "main", sha: BASE_SHA }),
    })
    expect(await runYrd(app, yrd("queue", "ls", "--latest"), latest.io), latest.stderr()).toBe(0)

    expect(plain.stdout()).toContain("pr#1.1")
    expect(plain.stdout()).toContain("pr#2.1")
    expect(plain.stdout()).toContain("pending")
    expect(latest.stdout()).toContain("pr#1.1")
    expect(latest.stdout()).toContain("pr#2.1")
    // Non-default-only FILTER row (user respec 2026-07-15): `latest` renders
    // only when the collapse is on — no `latest=no` placeholder.
    expect(plain.stdout()).not.toContain("latest")
    expect(latest.stdout()).toContain("latest")
  })

  it("renders queue --watch identically to root watch", async () => {
    const app = await createApp()
    await openAndSubmit(app)

    let rootMounted: ReactElement | undefined
    const watchVariants: Array<{ argv: readonly string[]; mounted?: ReactElement }> = [
      { argv: yrd("queue", "--watch") },
      { argv: yrd("queue", "ls", "--watch") },
    ]

    const rootWatch = outputIO({
      now: () => Date.parse("2026-07-09T12:01:00.000Z"),
    })
    const rootLive = withLiveRenderer(rootWatch.io, async (element) => {
      rootMounted = element
    })
    expect(await runYrd(app, yrd("watch"), rootLive)).toBe(0)
    if (rootMounted === undefined) throw new Error("expected root watch pane to mount")

    const rootFrame = stripOsc8Targets(
      await renderString(
        createElement(QueueWatchFrame, { snapshot: (rootMounted.props as QueueWatchPaneProps).initial }),
      ),
    )
    for (const variant of watchVariants) {
      let mounted: ReactElement | undefined
      const watch = outputIO({
        now: () => Date.parse("2026-07-09T12:01:00.000Z"),
      })
      const live = withLiveRenderer(watch.io, async (element) => {
        mounted = element
      })
      expect(await runYrd(app, variant.argv, live)).toBe(0)
      if (mounted === undefined) throw new Error("expected watch panes to mount")
      const frame = stripOsc8Targets(
        await renderString(
          createElement(QueueWatchFrame, { snapshot: (mounted.props as QueueWatchPaneProps).initial }),
        ),
      )
      expect(frame).toBe(rootFrame)
    }
  })

  it("keeps queue aliases and plural filters on one lossless JSON projection", async () => {
    const app = await createApp()
    await app.bays.submit({ branch: "topic/alpha", headSha: "1".repeat(40), base: "main" })
    await app.bays.submit({ branch: "topic/beta", headSha: "2".repeat(40), base: "main" })
    const now = () => Date.parse("2026-07-09T12:01:00.000Z")
    const resolveQueueTarget = async () => ({ base: "main", sha: BASE_SHA })

    const filtered = outputIO({ now, resolveQueueTarget })
    expect(
      await runYrd(
        app,
        yrd("queue", "list", "does-not-match", "TOPIC/ALPHA", "--status", "PENDING", "--since", "6h", "--json"),
        filtered.io,
      ),
      filtered.stderr(),
    ).toBe(0)
    const expectedFiltered = JSON.parse(filtered.stdout()) as Record<string, unknown>
    expect(expectedFiltered).toMatchObject({
      command: "queue.list",
      projection: {
        base: "main",
        filters: { terms: ["does-not-match", "topic/alpha"], statuses: ["pending"], windowMs: 21_600_000 },
        rows: [{ pr: "PR1", branch: "topic/alpha" }],
        metrics: { terminalAttempts: 0 },
      },
    })

    const filteredAlias = outputIO({ now, resolveQueueTarget })
    expect(
      await runYrd(
        app,
        yrd("queue", "ls", "does-not-match", "TOPIC/ALPHA", "--status", "PENDING", "--since", "6h", "--json"),
        filteredAlias.io,
      ),
      filteredAlias.stderr(),
    ).toBe(0)
    expect(JSON.parse(filteredAlias.stdout())).toEqual(expectedFiltered)

    const canonical = outputIO({ now, resolveQueueTarget })
    expect(await runYrd(app, yrd("queue", "list", "--json"), canonical.io), canonical.stderr()).toBe(0)
    const expected = JSON.parse(canonical.stdout()) as Record<string, unknown>
    for (const args of [
      ["queue", "ls", "--json"],
      ["queue", "--json"],
    ] as const) {
      const output = outputIO({ now, resolveQueueTarget })
      expect(await runYrd(app, yrd(...args), output.io), output.stderr()).toBe(0)
      expect(JSON.parse(output.stdout())).toEqual(expected)
    }

    for (const args of [
      ["queue", "ls", "--watch", "--json"],
      ["watch", "--json"],
    ] as const) {
      const controller = new AbortController()
      const output = outputIO({
        now,
        resolveQueueTarget,
        scope: { signal: controller.signal, sleep: async () => controller.abort() },
      })
      expect(await runYrd(app, yrd(...args), output.io), output.stderr()).toBe(0)
      expect(
        output
          .stdout()
          .trimEnd()
          .split("\n")
          .map((row) => JSON.parse(row) as Record<string, unknown>),
      ).toEqual([expected])
    }

    let mounted: ReactElement | undefined
    const interactive = outputIO({ now, resolveQueueTarget })
    const live = withLiveRenderer(interactive.io, async (element) => {
      mounted = element
    })
    expect(
      await runYrd(app, yrd("queue", "ls", "TOPIC/ALPHA", "--status", "pending", "--watch"), live),
      interactive.stderr(),
    ).toBe(0)
    if (mounted === undefined) throw new Error("expected filtered queue watch pane to mount")
    const props = mounted.props as QueueWatchPaneProps
    const frame = await renderString(createElement(QueueWatchFrame, { snapshot: props.initial }), {
      width: 120,
      height: 24,
      plain: true,
    })
    expect(frame).toContain("pr#1.1")
    expect(frame).not.toContain("pr#2.1")
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
    const result = {
      base: "main",
      prs: [
        {
          id: "PR1",
          name: "Watch the queue",
          branch: "issue/watch",
          base: "main",
          status: "submitted",
          revision: 1,
          headSha: HEAD_SHA,
          revisions: [submittedRevision(1, HEAD_SHA, "2026-07-09T12:00:00.000Z")],
          submittedAt: "2026-07-09T12:00:00.000Z",
        },
      ],
      running: [
        {
          id: "R1",
          status: "running",
          startedAt: "2026-07-09T12:09:00.000Z",
          prs: [{ id: "PR1", revision: 1, headSha: HEAD_SHA }],
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

  it("labels skipped checks consistently in queue and watch summaries", async () => {
    const run = {
      id: "R1",
      status: "running",
      startedAt: "2026-07-09T12:09:00.000Z",
      prs: [{ id: "PR1", revision: 1, headSha: HEAD_SHA }],
      stepSelection: {
        authority: "explicit",
        steps: ["merge"],
        omittedSteps: [{ name: "check", index: 0, status: "skipped", reason: "not-selected" }],
      },
      steps: [{ name: "merge", job: { status: "running" } }],
    } as unknown as QueueRun
    const result = {
      base: "main",
      prs: [
        {
          id: "PR1",
          name: "Merge without checks",
          branch: "issue/merge-only",
          base: "main",
          status: "submitted",
          revision: 1,
          headSha: HEAD_SHA,
          revisions: [submittedRevision(1, HEAD_SHA, "2026-07-09T12:00:00.000Z")],
          submittedAt: "2026-07-09T12:00:00.000Z",
        },
      ],
      running: [run],
      waiting: [],
      finished: [],
    } as unknown as QueueStatusResult
    const queueFrame = await renderString(createElement(QueueRunsView, { runs: [run] }), {
      width: 120,
      plain: true,
    })
    const watchFrame = await renderString(
      createElement(QueueWatchView, { results: [result], now: Date.parse("2026-07-09T12:10:00.000Z") }),
      { width: 120, plain: true },
    )

    expect(queueFrame).toContain("check=skipped merge=running")
    expect(watchFrame).toContain("check=skipped merge=running")
    expect(watchFrame).not.toContain("not-selected")
  })

  it("orders queue timeline rows status-major and collapses to the latest row per PR", () => {
    const result = {
      base: "main",
      headSha: BASE_SHA,
      prs: [
        {
          id: "PR1",
          name: "First",
          branch: "topic/one",
          base: "main",
          status: "submitted",
          revision: 1,
          headSha: HEAD_SHA,
        },
        {
          id: "PR2",
          name: "Second",
          branch: "topic/two",
          base: "main",
          status: "submitted",
          revision: 1,
          headSha: "2".repeat(40),
          submittedAt: "2026-07-09T12:01:00.000Z",
        },
        {
          id: "PR3",
          name: "Third",
          branch: "topic/three",
          base: "main",
          status: "submitted",
          revision: 1,
          headSha: "3".repeat(40),
          submittedAt: "2026-07-09T12:19:00.000Z",
        },
        {
          id: "PR4",
          name: "Fourth",
          branch: "topic/four",
          base: "main",
          status: "submitted",
          revision: 1,
          headSha: "4".repeat(40),
        },
        {
          id: "PR5",
          name: "Fifth",
          branch: "topic/five",
          base: "main",
          status: "integrated",
          revision: 1,
          headSha: "5".repeat(40),
        },
      ],
      running: [
        {
          id: "R1",
          base: "main",
          status: "running",
          startedAt: "2026-07-09T12:00:00.000Z",
          shape: {},
          prs: [{ id: "PR1", revision: 1, headSha: HEAD_SHA, branch: "topic/one" }],
          steps: [],
        },
        {
          id: "R3",
          base: "main",
          status: "running",
          startedAt: "2026-07-09T12:05:00.000Z",
          shape: {},
          prs: [{ id: "PR4", revision: 1, headSha: "4".repeat(40), branch: "topic/four" }],
          steps: [],
        },
      ],
      waiting: [],
      finished: [
        {
          id: "R2",
          base: "main",
          status: "passed",
          startedAt: "2026-07-09T12:10:00.000Z",
          finishedAt: "2026-07-09T12:11:00.000Z",
          shape: {},
          prs: [{ id: "PR1", revision: 1, headSha: HEAD_SHA, branch: "topic/one" }],
          steps: [],
        },
        {
          id: "R4",
          base: "main",
          status: "passed",
          startedAt: "2026-07-09T12:14:00.000Z",
          finishedAt: "2026-07-09T12:15:00.000Z",
          shape: {},
          prs: [{ id: "PR5", revision: 1, headSha: "5".repeat(40), branch: "topic/five" }],
          steps: [],
        },
      ],
    } as unknown as QueueStatusResult

    const allRows = queueTimelineRows([result], Date.parse("2026-07-09T12:20:00.000Z"), false)
    const latestRows = queueTimelineRows([result], Date.parse("2026-07-09T12:20:00.000Z"), true)

    expect(allRows.map((row) => row.run ?? row.pr)).toEqual(["PR2", "PR3", "R1", "R3", "R4", "R2"])
    expect(latestRows.map((row) => row.run ?? row.pr)).toEqual(["PR2", "PR3", "R3", "R4", "R2"])
    expect(latestRows.find((row) => row.pr === "PR1")?.run).toBe("R2")
  })

  it("keeps a fresh submitted revision newer than its prior finished run", () => {
    const result = {
      base: "main",
      headSha: BASE_SHA,
      prs: [
        {
          id: "PR1",
          name: "Revised",
          branch: "topic/revised",
          base: "main",
          status: "submitted",
          revision: 2,
          headSha: "2".repeat(40),
          submittedAt: "2026-07-09T12:15:00.000Z",
        },
      ],
      running: [],
      waiting: [],
      finished: [
        {
          id: "R1",
          base: "main",
          status: "failed",
          startedAt: "2026-07-09T12:10:00.000Z",
          finishedAt: "2026-07-09T12:11:00.000Z",
          shape: {},
          prs: [{ id: "PR1", revision: 1, headSha: HEAD_SHA, branch: "topic/revised", base: "main" }],
          steps: [],
        },
      ],
    } as unknown as QueueStatusResult

    expect(queueTimelineRows([result], Date.parse("2026-07-09T12:20:00.000Z"), true)).toMatchObject([
      { pr: "PR1", status: "submitted", clock: "5m", detail: "position 1" },
    ])
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
          revision: 1,
          headSha: HEAD_SHA,
          revisions: [submittedRevision(1, HEAD_SHA, "2026-07-09T12:00:00.000Z")],
          submittedAt: "2026-07-09T12:00:00.000Z",
        },
      ],
      running: [],
      waiting: [
        {
          id: "R1",
          status: "waiting",
          startedAt: "2026-07-09T12:09:00.000Z",
          prs: [{ id: "PR1", revision: 1, headSha: HEAD_SHA }],
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
          revision: 1,
          headSha: HEAD_SHA,
          revisions: [
            submittedRevision(1, HEAD_SHA, "2026-07-09T12:00:00.000Z", {
              status: "rejected",
              at: "2026-07-09T12:03:00.000Z",
            }),
          ],
          submittedAt: "2026-07-09T12:00:00.000Z",
          rejectedAt: "2026-07-09T12:03:00.000Z",
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
          prs: [{ id: "PR1", revision: 1, headSha: HEAD_SHA }],
          steps: [{ name: "check", job: { status: "lost", lostReason: "lease expired" } }],
        },
        {
          id: "R2",
          status: "failed",
          startedAt: "2026-07-09T12:02:00.000Z",
          finishedAt: "2026-07-09T12:03:00.000Z",
          prs: [{ id: "PR1", revision: 1, headSha: HEAD_SHA }],
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

  it("quits with q inside the live Silvery runtime with pause removed", async () => {
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
      expect(handle.text).toContain("No matching queue rows.")
      // Pause/resume is removed (user respec 2026-07-15): the watch is
      // always live and `p` is a status-filter toggle, never a pause.
      expect(handle.text).not.toContain("LIVE")
      await handle.press("p")
      await handle.waitForLayoutStable()
      expect(handle.text).not.toContain("PAUSED")

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
    expect(watch.stdout()).toContain('"command":"queue.list"')
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
      expect.soft(status.stdout()).toContain("⧗")
      expect.soft(status.stdout()).toContain("err=apply-conflict — PR 'PR1' could not be applied")
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
      expect.soft(frame).toContain("err=apply-conflict — PR 'PR1' could not be applied")
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
      const terminalAt = item.runs.at(-1)?.finishedAt ?? "2026-07-09T12:06:00.000Z"
      const terminal =
        item.status === "rejected"
          ? ({ status: item.status, at: terminalAt } as const)
          : item.status === "withdrawn"
            ? ({ status: item.status, at: terminalAt } as const)
            : undefined
      const identities = new Map<string, { revision: number; headSha: string }>()
      for (const run of item.runs) {
        const member = run.prs[0]!
        identities.set(`${member.revision}@${member.headSha}`, member)
      }
      identities.set(`${item.revision}@${item.headSha}`, { revision: item.revision, headSha: item.headSha })
      const pr = {
        id: "PR1",
        branch: "issue/failure",
        base: "main",
        baseSha: BASE_SHA,
        status: item.status,
        revision: item.revision,
        headSha: item.headSha,
        revisions: [...identities.values()].map((identity) =>
          submittedRevision(
            identity.revision,
            identity.headSha,
            "2026-07-09T11:59:00.000Z",
            identity.revision === item.revision && identity.headSha === item.headSha ? terminal : undefined,
          ),
        ),
        reviews: [],
        comments: [],
        checkRequests: [],
        submittedAt: "2026-07-09T11:59:00.000Z",
        ...(item.status === "rejected" ? { rejectedAt: terminalAt } : {}),
        ...(item.status === "withdrawn" ? { withdrawnAt: terminalAt } : {}),
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

  it("keeps a later revision clock out of prior run history", () => {
    const pr = {
      id: "PR1",
      branch: "issue/failure",
      base: "main",
      baseSha: BASE_SHA,
      status: "rejected",
      revision: 2,
      headSha: "2".repeat(40),
      revisions: [
        {
          revision: 1,
          headSha: HEAD_SHA,
          base: "main",
          baseSha: BASE_SHA,
          pushedAt: "2026-07-09T12:00:00.000Z",
          submittedAt: "2026-07-09T12:00:30.000Z",
          terminal: { status: "rejected", at: "2026-07-09T12:05:00.000Z" },
        },
        {
          revision: 2,
          headSha: "2".repeat(40),
          base: "main",
          baseSha: BASE_SHA,
          pushedAt: "2026-07-09T12:10:00.000Z",
          submittedAt: "2026-07-09T12:10:01.000Z",
          terminal: { status: "rejected", at: "2026-07-09T12:12:00.000Z" },
        },
      ],
      reviews: [],
      comments: [],
      checkRequests: [],
      submittedAt: "2026-07-09T12:10:01.000Z",
      rejectedAt: "2026-07-09T12:12:00.000Z",
    } as PR
    const prior = fakeRun({
      id: "R1",
      status: "failed",
      pr: { id: pr.id, revision: 1, headSha: HEAD_SHA, baseSha: BASE_SHA },
      startedAt: "2026-07-09T12:01:00.000Z",
      finishedAt: "2026-07-09T12:05:00.000Z",
      steps: [],
      error: { code: "check-failed", message: "revision one failed" },
    })
    const current = fakeRun({
      id: "R2",
      status: "failed",
      pr: { id: pr.id, revision: 2, headSha: pr.headSha, baseSha: BASE_SHA },
      startedAt: "2026-07-09T12:10:30.000Z",
      finishedAt: pr.rejectedAt!,
      steps: [],
      error: { code: "check-failed", message: "revision two failed" },
    })
    const result = {
      base: "main",
      headSha: BASE_SHA,
      prs: [pr],
      running: [],
      waiting: [],
      finished: [prior, current],
    } as QueueStatusResult

    const projection = humanQueueProjection(result, Date.parse("2026-07-09T12:13:00.000Z"))
    expect(projection.recent.map(({ runId, submittedAt, age }) => ({ runId, submittedAt, age }))).toEqual([
      { runId: "R2", submittedAt: "2026-07-09T12:10:01.000Z", age: "1m" },
      { runId: "R1", submittedAt: "2026-07-09T12:00:30.000Z", age: "4m" },
    ])

    const awaitingCurrentRun = {
      ...pr,
      status: "submitted",
      revisions: [pr.revisions[0]!, { ...pr.revisions[1]!, terminal: undefined }],
      rejectedAt: undefined,
    } as PR
    const pending = humanQueueProjection(
      { ...result, prs: [awaitingCurrentRun], finished: [prior] },
      Date.parse("2026-07-09T12:13:00.000Z"),
    )
    expect(pending.queue).toHaveLength(1)
    expect(pending.queue[0]).toMatchObject({
      pr: "PR1",
      state: "submitted",
      submittedAt: "2026-07-09T12:10:01.000Z",
    })
    expect(pending.queue[0]).not.toHaveProperty("runId")
  })

  it("fails loud when a pinned run has no causal admission clock or contradicts the current terminal fact", () => {
    const run = fakeRun({
      id: "R-clock",
      status: "failed",
      pr: { id: "PR-clock", revision: 1, headSha: HEAD_SHA, baseSha: BASE_SHA },
      startedAt: "2026-07-09T12:01:00.000Z",
      finishedAt: "2026-07-09T12:02:00.000Z",
      steps: [],
      error: { code: "check-failed", message: "failed" },
    })
    const pr = {
      id: "PR-clock",
      branch: "topic/clock",
      base: "main",
      baseSha: BASE_SHA,
      status: "rejected",
      revision: 1,
      headSha: HEAD_SHA,
      revisions: [
        { revision: 1, headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA, pushedAt: "2026-07-09T12:00:00.000Z" },
      ],
      reviews: [],
      comments: [],
      checkRequests: [],
      submittedAt: "2026-07-09T12:00:30.000Z",
      rejectedAt: "2026-07-09T12:02:00.000Z",
    } as PR

    expect(() => runRevisionClock(pr, run)).toThrow(
      "run 'R-clock' has no causal submit/check-request clock for PR 'PR-clock' revision 1@1111111111111111111111111111111111111111",
    )
    const environmentRefused = runRevisionClock(
      {
        ...pr,
        status: "submitted",
        revisions: [{ ...pr.revisions[0]!, submittedAt: "2026-07-09T12:00:30.000Z" }],
        rejectedAt: undefined,
      },
      {
        ...run,
        error: { code: "queue-environment-refused", message: "stale base" },
      },
    )
    expect(environmentRefused).toMatchObject({ submittedAt: "2026-07-09T12:00:30.000Z" })
    expect(environmentRefused).not.toHaveProperty("terminal")
    expect(() =>
      runRevisionClock(
        {
          ...pr,
          revisions: [{ ...pr.revisions[0]!, submittedAt: "2026-07-09T12:00:30.000Z" }],
        },
        run,
      ),
    ).toThrow(
      "PR 'PR-clock' current revision 1@1111111111111111111111111111111111111111 has no rejected terminal clock",
    )

    expect(() =>
      queueLogRows(
        [fakeSummary([run])],
        new Set<string>(),
        undefined,
        new Map([[pr.id, pr.status]]),
        [],
        new Map(),
        new Map(),
      ),
    ).toThrow(
      "run 'R-clock' has no causal submit/check-request clock for PR 'PR-clock' revision 1@1111111111111111111111111111111111111111",
    )
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
      revisions: [submittedRevision(1, HEAD_SHA, "2026-07-09T12:00:00.000Z", { status: "rejected", at: terminalAt })],
      reviews: [],
      comments: [],
      checkRequests: [],
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
      revisions: [
        submittedRevision(1, HEAD_SHA, "2026-07-09T11:59:00.000Z", {
          status: "rejected",
          at: "2026-07-09T12:01:00.000Z",
        }),
      ],
      reviews: [],
      comments: [],
      checkRequests: [],
      submittedAt: "2026-07-09T11:59:00.000Z",
      rejectedAt: "2026-07-09T12:01:00.000Z",
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
      expect(status.stdout()).toContain("ACTIVE RUN main#1 pr#1.1 fix(cli): show the active queue check")
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
        revisions: [submittedRevision(1, HEAD_SHA, "2026-07-09T12:00:00.000Z")],
        reviews: [],
        comments: [],
        checkRequests: [],
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
        revisions: [submittedRevision(1, "2".repeat(40), "2026-07-09T12:01:00.000Z")],
        reviews: [],
        comments: [],
        checkRequests: [],
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
      revisions: [submittedRevision(1, String(index + 1).repeat(40), `2026-07-09T12:0${index}:00.000Z`)],
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
      revisions: [
        submittedRevision(1, String(index + 8).repeat(40), `2026-07-09T11:0${index}:00.000Z`, {
          status: "rejected",
          at: `2026-07-09T12:1${index}:00.000Z`,
        }),
      ],
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
    expect.soft(dashboard.stdout()).toContain("1. ▢ pr#1.1")
    expect.soft(dashboard.stdout()).toContain("2. ▢ pr#2.1")

    const status = outputIO({ now, resolveQueueTarget, currentBranch: () => "issue/two" })
    expect(await runYrd(app, yrd("pr", "status"), status.io), status.stderr()).toBe(0)
    expect.soft(status.stdout()).toContain("STATUS submitted")
    expect.soft(status.stdout()).toContain("POSITION 2")
    expect.soft(status.stdout()).toContain("▢")

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

    const detailJson = outputIO()
    expect(await runYrd(app, yrd("pr", "view", "PR1", "--json"), detailJson.io)).toBe(0)
    expect(JSON.parse(detailJson.stdout())).toMatchObject({
      command: "pr.view",
      detail: {
        runs: [{ run: "R1" }],
        run: {
          run: "R1",
          prs: [{ id: "PR1" }],
          landing: expect.any(String),
          steps: expect.arrayContaining([
            expect.objectContaining({
              uuid: expect.any(String),
              runner: expect.any(String),
              lease: "-",
              changed: expect.any(String),
            }),
          ]),
        },
      },
    })
    const detailHuman = outputIO({ columns: 80 })
    expect(await runYrd(app, yrd("pr", "view", "PR1"), detailHuman.io)).toBe(0)
    expect(detailHuman.stdout()).toContain("RUN main#1")
    expect(detailHuman.stdout()).not.toContain("RELATED RUNS")
    // Round 6 exposes only the stable job noun and drops runner internals.
    expect(detailHuman.stdout()).toContain("JOB yrd#")
    expect(detailHuman.stdout()).not.toContain("RUNNER")
    expect(detailHuman.stdout()).not.toContain("DETAILS")
    // This run records no artifacts or evidence: no legacy log chrome is
    // emitted under the present-facts rule (item e).
    expect(detailHuman.stdout()).not.toContain("RUN LOGS")
    // NEXT is a failure-only cue now (item g): an integrated run never shows it.
    expect(detailHuman.stdout()).not.toContain("NEXT")

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
      submittedAt: "2026-07-09T12:00:00.000Z",
      outcome: "integrated",
    })
    expect(parsed.rows[0]).not.toHaveProperty("location")

    const human = outputIO({ color: true, columns: 120 })
    expect(await runYrd(app, yrd("log", "--base", "main"), human.io)).toBe(0)
    expect(human.stdout()).not.toMatch(/^\s*(?:TIME|RUN|OUTCOME)\b/mu)
    expect(human.stdout()).not.toContain("✓")
    expect(human.stdout()).toContain("main#1")
    expect(stripAnsi(human.stdout())).toContain("pr#1.1")
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
    // Present-facts rule: this run records no checkpoint, so no placeholder.
    expect(human.stdout()).not.toContain("CHECKPOINT -")
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
    expect((parsed as { pr?: { taskStatus?: string; glyph?: string } }).pr).toMatchObject({
      taskStatus: "done",
      glyph: "✓",
    })
    expect(parsed.runs[0]).toMatchObject({ taskStatus: "done", glyph: "✓" })
    expect(parsed.runs[0]?.steps).toHaveLength(2)
    expect(parsed.runs[0]?.steps[0]).toMatchObject({
      step: "check",
      revision: "check-v1",
      status: "passed",
      taskStatus: "done",
      glyph: "✓",
    })
    expect(parsed.runs[0]?.steps[0]).toHaveProperty("detail")
    expect(parsed.runs[0]?.steps[0]).toHaveProperty("output")
    expect(parsed.runs[0]?.steps[0]).toHaveProperty("landing")
  })

  it("keeps every submitted revision clock lossless in pr runs", async () => {
    const nextHead = "2".repeat(40)
    const pushedOnlyHead = "3".repeat(40)
    let now = "2026-07-09T12:00:00.000Z"
    const app = await createApp({ failingCheck: true, clock: () => now })
    await app.bays.submit({ branch: "topic/history", headSha: HEAD_SHA, base: "main" })
    expect(await runYrd(app, yrd("queue", "run", "PR1"), outputIO().io)).toBe(1)

    now = "2026-07-09T12:10:00.000Z"
    await app.bays.intake({ branch: "topic/history", headSha: nextHead, base: "main" })
    await app.bays.ready({ pr: "PR1" })
    expect(await runYrd(app, yrd("queue", "run", "PR1"), outputIO().io)).toBe(1)

    now = "2026-07-09T12:20:00.000Z"
    await app.bays.intake({ branch: "topic/history", headSha: pushedOnlyHead, base: "main" })

    const human = outputIO({ columns: 80 })
    expect(await runYrd(app, yrd("pr", "runs", "PR1"), human.io), human.stderr()).toBe(0)
    expect(human.stdout()).toContain(`REVISION CLOCK pr#1.1 HEAD ${HEAD_SHA}`)
    expect(human.stdout()).toContain(`REVISION CLOCK pr#1.2 HEAD ${nextHead}`)
    expect(human.stdout()).toContain(`REVISION CLOCK pr#1.3 HEAD ${pushedOnlyHead}`)
    expect(human.stdout()).toContain("PUSHED 2026-07-09T12:00:00.000Z")
    expect(human.stdout()).toContain("SUBMITTED 2026-07-09T12:00:00.000Z")
    expect(human.stdout()).toContain("TERMINAL rejected AT 2026-07-09T12:00:00.000Z")
    expect(human.stdout()).toContain("PUSHED 2026-07-09T12:10:00.000Z")
    expect(human.stdout()).toContain("SUBMITTED 2026-07-09T12:10:00.000Z")
    expect(human.stdout()).toContain("TERMINAL rejected AT 2026-07-09T12:10:00.000Z")
    expect(human.stdout()).toContain("PUSHED 2026-07-09T12:20:00.000Z")
    expect(human.stdout()).toContain("No runs recorded for this revision.")

    const json = outputIO()
    expect(await runYrd(app, yrd("pr", "runs", "PR1", "--json"), json.io), json.stderr()).toBe(0)
    const parsed = JSON.parse(json.stdout()) as {
      pr: PR
      runs: ReturnType<typeof queueShowData>[]
    }
    expect(parsed.pr.revisions).toMatchObject([
      {
        revision: 1,
        headSha: HEAD_SHA,
        submittedAt: "2026-07-09T12:00:00.000Z",
        terminal: { status: "rejected", at: "2026-07-09T12:00:00.000Z" },
      },
      {
        revision: 2,
        headSha: nextHead,
        submittedAt: "2026-07-09T12:10:00.000Z",
        terminal: { status: "rejected", at: "2026-07-09T12:10:00.000Z" },
      },
      { revision: 3, headSha: pushedOnlyHead, pushedAt: "2026-07-09T12:20:00.000Z" },
    ])
    expect(parsed.runs.map((run) => run.revisionClock)).toMatchObject([
      { pr: "PR1", revision: 1, headSha: HEAD_SHA, submittedAt: "2026-07-09T12:00:00.000Z" },
      { pr: "PR1", revision: 2, headSha: nextHead, submittedAt: "2026-07-09T12:10:00.000Z" },
    ])
  })

  it("pins repeated pushed draft-check runs to their causal request clocks", async () => {
    let now = "2026-07-09T12:00:00.000Z"
    const app = await createApp({ baseFailure: true, clock: () => now })
    await app.bays.submit({
      branch: "topic/draft-check",
      headSha: HEAD_SHA,
      base: "main",
      baseSha: BASE_SHA,
      draft: true,
    })
    now = "2026-07-09T12:01:00.000Z"
    await app.bays.requestChecks({ pr: "PR1", baseSha: BASE_SHA })
    now = "2026-07-09T12:02:00.000Z"
    expect(await app.queue.admit({ prs: ["PR1"] }, { runner: "cli-test", leaseMs: 60_000 })).toMatchObject([
      { id: "R1", status: "failed" },
    ])
    now = "2026-07-09T12:10:00.000Z"
    await app.bays.requestChecks({ pr: "PR1", baseSha: BASE_SHA })
    now = "2026-07-09T12:11:00.000Z"
    expect(await app.queue.admit({ prs: ["PR1"] }, { runner: "cli-test", leaseMs: 60_000 })).toMatchObject([
      { id: "R2", status: "failed" },
    ])
    expect(app.state().bays.prs.PR1).toMatchObject({ status: "pushed" })
    expect(app.state().bays.prs.PR1).not.toHaveProperty("submittedAt")

    const human = outputIO({ columns: 80 })
    expect(await runYrd(app, yrd("pr", "runs", "PR1"), human.io), human.stderr()).toBe(0)
    expect(human.stdout()).toContain(`REVISION CLOCK pr#1.1 HEAD ${HEAD_SHA}`)
    expect(human.stdout()).toContain("SUBMITTED -")
    expect(human.stdout()).toContain("CHECK REQUESTED 2026-07-09T12:01:00.000Z, 2026-07-09T12:10:00.000Z")
    expect(human.stdout()).toContain("RUN main#1 ADMITTED check-request AT 2026-07-09T12:01:00.000Z")
    expect(human.stdout()).toContain("RUN main#2 ADMITTED check-request AT 2026-07-09T12:10:00.000Z")
    expect(human.stdout()).toContain("main#1")

    const json = outputIO()
    expect(await runYrd(app, yrd("pr", "runs", "PR1", "--json"), json.io), json.stderr()).toBe(0)
    const parsed = JSON.parse(json.stdout()) as { runs: ReturnType<typeof queueShowData>[] }
    expect(parsed.runs.map((run) => run.revisionClock)).toMatchObject([
      {
        pr: "PR1",
        revision: 1,
        headSha: HEAD_SHA,
        pushedAt: "2026-07-09T12:00:00.000Z",
        admittedBy: "check-request",
        checkRequestedAt: "2026-07-09T12:01:00.000Z",
      },
      {
        pr: "PR1",
        revision: 1,
        headSha: HEAD_SHA,
        pushedAt: "2026-07-09T12:00:00.000Z",
        admittedBy: "check-request",
        checkRequestedAt: "2026-07-09T12:10:00.000Z",
      },
    ])
    expect(parsed.runs.every((run) => !("submittedAt" in (run.revisionClock ?? {})))).toBe(true)

    now = "2026-07-09T12:20:00.000Z"
    await app.bays.ready({ pr: "PR1" })
    expect(app.state().bays.prs.PR1).toMatchObject({
      status: "submitted",
      submittedAt: now,
      revisions: [{ submittedAt: now, terminal: undefined }],
    })

    const laterQueue = outputIO({ columns: 120, now: () => Date.parse("2026-07-09T12:21:00.000Z") })
    expect(await runYrd(app, yrd("queue"), laterQueue.io), laterQueue.stderr()).toBe(0)
    // The old ROWS "oldest=" cell has no place in the windowed FLOW surface.
    expect(laterQueue.stdout()).toContain("FLOW")

    const laterHuman = outputIO({ columns: 120 })
    expect(await runYrd(app, yrd("log", "--pr", "PR1"), laterHuman.io), laterHuman.stderr()).toBe(0)
    expect(laterHuman.stdout()).toContain("main#1")
    expect(laterHuman.stdout()).toContain("main#2")

    const laterJson = outputIO()
    expect(await runYrd(app, yrd("log", "--pr", "PR1", "--json"), laterJson.io), laterJson.stderr()).toBe(0)
    const rows = (JSON.parse(laterJson.stdout()) as { rows: ReturnType<typeof queueLogRows> }).rows
    expect(rows.map(({ run, submittedAt, ageMs }) => ({ run, submittedAt, ageMs }))).toEqual([
      { run: "R1", submittedAt: undefined, ageMs: undefined },
      { run: "R2", submittedAt: undefined, ageMs: undefined },
    ])
    expect(rows.every((row) => !("submittedAt" in row))).toBe(true)
  })

  it("maps the 10-row log and PR-run contract matrix directly from canonical fields", async () => {
    const temp = mkdtempSync(join(tmpdir(), "yrd-legacy-log-"))
    const artifacts = join(temp, "artifacts")
    const attemptOne = join(artifacts, "attempt-1", "output.log")
    const attemptTwo = join(artifacts, "attempt-2", "output.log")
    const comparisonStderr = join(artifacts, "attempt-comparison", "stderr.log")
    const missingArtifact = join(artifacts, "attempt-missing", "output.log")
    mkdirSync(artifacts, { recursive: true })
    mkdirSync(join(artifacts, "attempt-1"), { recursive: true })
    mkdirSync(join(artifacts, "attempt-2"), { recursive: true })
    mkdirSync(join(artifacts, "attempt-comparison"), { recursive: true })
    mkdirSync(join(artifacts, "attempt-missing"), { recursive: true })
    writeFileSync(attemptOne, "attempt one\n")
    writeFileSync(attemptTwo, "attempt two\n")
    writeFileSync(comparisonStderr, "comparison refusal\n")

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
            error: {
              code: "check-failed",
              message: "policy mismatch",
              evidence: {
                candidateEvidence: {
                  artifacts: [{ name: "comparison-stderr", path: comparisonStderr }],
                },
              },
            },
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
        { label: "comparison-stderr", location: { path: comparisonStderr } },
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
          submittedAt: "2026-07-10T10:59:00.000Z",
        },
      ],
      reviews: [],
      comments: [],
      checkRequests: [],
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
        { label: "comparison-stderr", location: { path: comparisonStderr } },
      ],
    })
    expect(failureShow.steps[2]).toMatchObject({ status: "lost", lost: "worker died" })

    const missingShow = queueShowData(runMissingLocation, [runMissingLocation])
    expect(missingShow.steps[0]).not.toHaveProperty("location")

    const failureTty = await renderString(createElement(QueueShowView, { data: failureShow }), {
      width: 140,
      height: 40,
      plain: false,
    })
    expect(failureTty).toContain(pathToFileURL(attemptOne).href)
    expect(failureTty).toContain(pathToFileURL(attemptTwo).href)
    expect(failureTty).toContain(pathToFileURL(comparisonStderr).href)

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
    expect(renderedLogWithCoverage).toContain("main#10")
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
          result: {
            status: "failed",
            error: {
              code: "merge-stalled",
              message: "merge stalled",
              evidence: { kind: "queue-authority-refusal", attempts: 3 },
            },
          },
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
        result: {
          status: "failed",
          error: {
            code: "merge-stalled",
            message: "merge stalled",
            evidence: { kind: "queue-authority-refusal", attempts: 3 },
          },
        },
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
      taskStatus: "done",
      glyph: "✓",
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
      taskStatus: "blocked",
      glyph: "⧗",
      startedAt: "2026-07-12T11:08:36.218Z",
      finishedAt: "2026-07-12T11:12:18.300Z",
      durationMs: 222_082,
      result: {
        status: "failed",
        error: {
          code: "merge-stalled",
          message: "merge stalled",
          evidence: { kind: "queue-authority-refusal", attempts: 3 },
        },
      },
    })
    expect(show.steps).toHaveLength(3)
    expect(show.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ step: "check", attempt: "1", status: "passed", duration: "7m19s" }),
        expect.objectContaining({
          step: "merge",
          attempt: "1",
          status: "failed",
          taskStatus: "blocked",
          glyph: "⧗",
          duration: "3m42s",
          error: "merge stalled",
        }),
        expect.objectContaining({
          step: "merge",
          attempt: "2",
          status: "passed",
          taskStatus: "done",
          glyph: "✓",
          duration: "25s",
        }),
      ]),
    )

    const showHuman = await renderString(createElement(QueueShowView, { data: show }), {
      width: 120,
      height: 40,
      plain: true,
    })
    expect(showHuman).toContain("TOTAL")
    expect(showHuman).toContain("ACTIVE")
    expect(showHuman).toContain("WAIT")
    expect(showHuman).toContain("48m07s")
    expect(showHuman).toContain("11m26s")
    expect(showHuman).toContain("36m42s")
    expect(showHuman).toContain("merge-stalled")
    expect(showHuman).toContain("⧗ failed")
    expect(showHuman).toContain("✓ passed")
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
        attempts: [
          { attempt: 1, taskStatus: "done", glyph: "✓" },
          { attempt: 1, taskStatus: "blocked", glyph: "⧗" },
          { attempt: 2, taskStatus: "done", glyph: "✓" },
        ],
      },
    })
    const rows = queueLogRows(
      [fakeSummary([run])],
      new Set<string>(),
      undefined,
      new Map([["PR23", "integrated"]]),
      attempts,
      new Map(),
      new Map([submittedRunClock(run, "2026-07-12T10:49:24.335Z")]),
    )

    const row = rows[0]
    if (row === undefined) throw new Error("missing history row")
    expect(row).toMatchObject({
      run: "R4",
      pr: "PR23",
      revision: "4",
      startedAt: "2026-07-12T11:01:16.930Z",
      submittedAt: "2026-07-12T10:49:24.335Z",
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
    expect(JSON.parse(JSON.stringify(row))).toMatchObject({ submittedAt: "2026-07-12T10:49:24.335Z" })

    for (const width of [80, 120]) {
      const human = await renderString(createElement(QueueLogView, { rows, columns: width }), {
        width,
        height: 8,
        plain: true,
      })
      const physicalRows = human.split("\n").filter((row) => row.includes("main#4"))
      expect(human).not.toMatch(/^\s*(?:TIME|LEVEL|BASE|PR|REV·RUN|OUTCOME|SUBJECT|AGE|TOTAL|ACTIVE|WAIT)\b/mu)
      expect(human).not.toContain("GLYPH")
      expect(human).not.toContain("✓")
      expect(physicalRows).toHaveLength(1)
      expect(physicalRows[0]?.length).toBeLessThanOrEqual(width)
      expect(physicalRows[0]).toContain("pr#23.4")
      expect(physicalRows[0]).toContain("main#4")
      expect(physicalRows[0]).toContain("integrated")
      expect(physicalRows[0]).toContain("age=1h")
      expect(physicalRows[0]).toContain("total=48:07")
      expect(physicalRows[0]).toContain("active=11:26")
      expect(physicalRows[0]).toContain("wait=36:42")
      if (width === 120) expect(physicalRows[0]).toContain("art:12")
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
      const physicalRows = human.split("\n").filter((row) => /pr#2[23]\.[0-9]+/u.test(row))
      expect(physicalRows).toHaveLength(2)
      // Rendered in Asia/Kolkata (+5:30): 11:01:16Z → 16:31:16, 23:59:58Z → next local day 05:29:58.
      expect(physicalRows[0]).toContain("2026-07-12T16:31:16")
      expect(physicalRows[1]).toContain("2026-07-12T05:29:58")
      expect(Math.max(...physicalRows.map((row) => row.length))).toBeLessThanOrEqual(width)
    }

    const tty = await renderString(createElement(QueueLogView, { rows, columns: 120 }), {
      width: 120,
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
    const revisionClocks = new Map([submittedRunClock(run, "2026-07-12T11:00:00.000Z")])
    const project = () =>
      queueLogRows(
        [fakeSummary([run])],
        new Set<string>(),
        undefined,
        new Map([["PR42", "rejected"]]),
        [],
        subjects,
        revisionClocks,
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
        new Map([submittedRunClock(run, submittedAt)]),
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
      revisions: [submittedRevision(1, HEAD_SHA, "2026-07-12T12:05:00.000Z")],
      reviews: [],
      comments: [],
      checkRequests: [],
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
      revisions: [
        submittedRevision(1, HEAD_SHA, "2026-07-12T11:59:00.000Z", {
          status: "rejected",
          at: "2026-07-12T12:01:00.000Z",
        }),
      ],
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

  it("renders the newest twenty history records as honest columnar rows without list glyphs", async () => {
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
      glyph: "⧗",
    })

    for (const width of [80, 120]) {
      const human = await renderString(createElement(QueueLogView, { rows, columns: width }), {
        width,
        height: 24,
        plain: true,
      })
      const physicalRows = human.split("\n").filter((row) => /pr#1\.1/u.test(row))
      expect(physicalRows).toHaveLength(20)
      expect(physicalRows[0]).toContain("main#22")
      expect(physicalRows.at(-1)).toContain("main#3")
      expect(physicalRows[0]).not.toContain("⧗")
      expect(physicalRows[0]).toContain("fix(")
      expect(Math.max(...human.split("\n").map((row) => row.length))).toBeLessThanOrEqual(width)
      expect(human).not.toMatch(/main#2\s/u)
      expect(human).not.toMatch(/main#1\s/u)
      expect(human).toContain("... 2 more")
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
    expect(usage.stderr()).toContain("err=invalid-arguments")
    expect(usage.stderr()).toContain("resolve:")

    const refusal = outputIO()
    expect(await runYrd(app, yrd("bay", "close", "missing"), refusal.io)).toBe(1)
    expect(refusal.stdout()).toBe("")
    expect(refusal.stderr()).toContain("no bay 'missing'")
    expect(refusal.stderr()).toContain("err=request-refused")
    expect(refusal.stderr()).toContain("cause:")

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
    expect(infrastructure.stderr()).toContain("err=unexpected")
    expect(infrastructure.stderr()).toContain("resolve:")
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
    expect(JSON.parse(audit.stdout())).toMatchObject({
      findings: [
        {
          code: "operator-finding",
          cause: "inspect runner",
          resolution: ["Correct the cause above, then retry the same Yrd command."],
        },
      ],
    })
    const auditHuman = outputIO()
    expect(await runYrd(app, yrd("queue", "audit"), auditHuman.io, services)).toBe(1)
    expect(auditHuman.stdout()).toContain("err=operator-finding")
    expect(auditHuman.stdout()).toContain("cause: inspect runner")
    expect(auditHuman.stdout()).toContain("resolve:")

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
    expect(await runYrd(app, yrd("queue", "run", "--interval", "1"), watch.io)).toBe(0)
    expect(watch.stdout()).toBe("")
    expect(sleeps).toEqual([1_000])
  })

  it("announces one resident runner across idle follow polls while JSON stays silent", async () => {
    const repo = mkdtempSync(join(tmpdir(), "yrd-resident-watch-presence-"))
    execFileSync("git", ["init", "-q", repo])
    const runner = `yrd-cli:${process.pid}`
    const presence = `Queue runner ${runner} active; following the default queue every 1s (Ctrl-C drains).\n`

    try {
      const app = await createApp()
      await openAndSubmit(app)
      await app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 })

      const controller = new AbortController()
      const sleeps: number[] = []
      const human = outputIO({
        cwd: repo,
        runner,
        scope: {
          signal: controller.signal,
          sleep: async (milliseconds) => {
            sleeps.push(milliseconds)
            if (sleeps.length === 2) controller.abort()
          },
        },
      })
      expect(await runYrd(app, yrd("queue", "run", "--interval", "1"), human.io), human.stderr()).toBe(0)
      expect(human.stdout()).toBe(presence)
      expect(sleeps).toEqual([1_000, 1_000])

      const jsonController = new AbortController()
      const json = outputIO({
        cwd: repo,
        runner,
        scope: {
          signal: jsonController.signal,
          sleep: async () => jsonController.abort(),
        },
      })
      expect(await runYrd(app, yrd("queue", "run", "--interval", "1", "--json"), json.io), json.stderr()).toBe(0)
      expect(json.stdout()).toBe("")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it("routes follow, --once, and selector runs to the right presence and projection", async () => {
    const repo = mkdtempSync(join(tmpdir(), "yrd-resident-follow-projection-"))
    execFileSync("git", ["init", "-q", repo])
    const runner = `yrd-cli:${process.pid}`
    const presence = `Queue runner ${runner} active; following the default queue every 1s (Ctrl-C drains).\n`

    const readyApp = async () => {
      const app = await createApp()
      await openAndSubmit(app)
      return app
    }
    const onePassScope = () => {
      const controller = new AbortController()
      return {
        signal: controller.signal,
        sleep: async () => controller.abort(),
      }
    }

    try {
      // A PR selector is a one-shot pass: it drains, prints the interactive run
      // table, and never announces the resident follow-runner.
      const selectedHuman = outputIO({ cwd: repo, runner })
      expect(await runYrd(await readyApp(), yrd("queue", "run", "PR1"), selectedHuman.io), selectedHuman.stderr()).toBe(
        0,
      )
      expect(selectedHuman.stdout()).not.toContain("Queue runner ")
      expect(selectedHuman.stdout()).toContain("STATE")

      // `--once` is a one-shot pass over the whole default queue — also no
      // presence banner, and the same interactive table projection.
      const onceHuman = outputIO({ cwd: repo, runner })
      expect(await runYrd(await readyApp(), yrd("queue", "run", "--once"), onceHuman.io), onceHuman.stderr()).toBe(0)
      expect(onceHuman.stdout()).not.toContain("Queue runner ")
      expect(onceHuman.stdout()).toContain("STATE")

      // Follow (the default with no selector) is the resident runner: it
      // announces presence once and keeps stdout a loggily-only log stream — the
      // interactive run table is the `queue watch` viewer's surface, never the
      // follow-runner's.
      const automaticHuman = outputIO({ cwd: repo, runner, scope: onePassScope() })
      expect(
        await runYrd(await readyApp(), yrd("queue", "run", "--interval", "1"), automaticHuman.io),
        automaticHuman.stderr(),
      ).toBe(0)
      expect(automaticHuman.stdout()).toBe(presence)

      // Follow --json streams one run record per drained run, tagged
      // mode:"follow", with no presence banner in the JSON stream.
      const automaticJson = outputIO({ cwd: repo, runner, scope: onePassScope() })
      expect(
        await runYrd(await readyApp(), yrd("queue", "run", "--interval", "1", "--json"), automaticJson.io),
        automaticJson.stderr(),
      ).toBe(0)
      expect(automaticJson.stdout().trim().split("\n")).toHaveLength(1)
      expect(JSON.parse(automaticJson.stdout())).toMatchObject({ command: "queue.run", mode: "follow" })
      expect(automaticJson.stdout()).not.toContain("Queue runner ")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe("queue run — follow-by-default mode selection (#62)", () => {
  // user respec 2026-07-15: "instead of --watch use --follow"; "not confused
  // with the watch command"; "by default it should be follow". `queue run` with
  // no selector and no --once IS the resident follow-runner (the old --watch
  // loop); a single pass is explicit — via a PR selector or --once. --watch is
  // gone. The follow loop calls scope.sleep after each cycle; a one-shot pass
  // never sleeps — that is the observable follow-vs-once discriminator here.
  const trackedScope = () => {
    const controller = new AbortController()
    const sleeps: number[] = []
    return {
      sleeps,
      scope: {
        signal: controller.signal,
        sleep: async (ms: number) => {
          sleeps.push(ms)
          controller.abort()
        },
      },
    }
  }

  it("enters resident follow mode with no selector and no --once (the default)", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    const tracked = trackedScope()
    const run = outputIO({ scope: tracked.scope })
    expect(await runYrd(app, yrd("queue", "run", "--interval", "1"), run.io), run.stderr()).toBe(0)
    // Followed: the loop slept (and was aborted) rather than exiting one-shot.
    expect(tracked.sleeps).toEqual([1_000])
  })

  it("treats explicit --follow as the same resident follow mode", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    const tracked = trackedScope()
    const run = outputIO({ scope: tracked.scope })
    expect(await runYrd(app, yrd("queue", "run", "--follow", "--interval", "1"), run.io), run.stderr()).toBe(0)
    expect(tracked.sleeps).toEqual([1_000])
  })

  it("--once drains the default queue exactly once and exits without looping", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    const tracked = trackedScope()
    const run = outputIO({ scope: tracked.scope })
    expect(await runYrd(app, yrd("queue", "run", "--once"), run.io), run.stderr()).toBe(0)
    // One-shot: never entered the follow loop, so it never slept.
    expect(tracked.sleeps).toEqual([])
    expect(run.stdout()).toContain("STATE")
  })

  it("a PR selector is a single pass, not a follow loop", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    const tracked = trackedScope()
    const run = outputIO({ scope: tracked.scope })
    expect(await runYrd(app, yrd("queue", "run", "PR1"), run.io), run.stderr()).toBe(0)
    expect(tracked.sleeps).toEqual([])
    expect(run.stdout()).toContain("STATE")
  })

  it("accepts --watch as a deprecated no-op alias that enters follow mode", async () => {
    // #62 removed --watch outright; the alias amendment keeps it one release so
    // the live resident runner + relaunch recipes survive the cutover. The parser
    // must ACCEPT --watch (exit 0, never the exit-2 unknown-option refusal) and
    // route it to the same resident follow loop as --follow: the loop sleeps once,
    // then the tracked scope aborts it. The single deprecation warn is a loggily
    // warn asserted at the followQueueRuns unit level (queue-run-watch-alias.test).
    const app = await createApp()
    await openAndSubmit(app)
    const tracked = trackedScope()
    const run = outputIO({ scope: tracked.scope })
    expect(await runYrd(app, yrd("queue", "run", "--watch", "--interval", "1"), run.io), run.stderr()).toBe(0)
    expect(tracked.sleeps).toEqual([1_000])
  })

  it("refuses --follow combined with --once", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    const run = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "--follow", "--once"), run.io)).toBe(2)
    expect(run.stderr()).toContain("mutually exclusive")
  })

  it("refuses --follow combined with a PR selector", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    const run = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "--follow", "PR1"), run.io)).toBe(2)
    expect(run.stderr()).toContain("cannot target")
  })
})

describe("submit correlation", () => {
  it.each(["bay", "pr"] as const)("persists an opaque correlation through %s submit", async (surface) => {
    const app = await createApp()
    const output = outputIO({ resolveRevision: async () => HEAD_SHA })
    const correlation = {
      namespace: "tribe-request",
      id: "review-20925/custom 61's docs:retry 2",
    }

    expect(
      await runYrd(
        app,
        yrd(
          surface,
          "submit",
          "topic/correlated",
          "--base",
          "main",
          "--correlation",
          `${correlation.namespace}:${correlation.id}`,
          "--json",
        ),
        output.io,
      ),
      output.stderr(),
    ).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({
      command: `${surface}.submit`,
      prs: [{ correlation }],
    })
    expect(app.state().bays.prs.PR1).toMatchObject({
      correlation,
      revisions: [{ correlation }],
    })
  })

  it.each(["bay", "pr"] as const)("rejects malformed correlation before %s submit appends", async (surface) => {
    for (const correlation of ["tribe-request", "tribe-request:   "]) {
      const app = await createApp()
      const before = await Array.fromAsync(app.events()).then((events) => events.length)
      const output = outputIO({ resolveRevision: async () => HEAD_SHA })

      expect(
        await runYrd(
          app,
          yrd(surface, "submit", "topic/correlated", "--correlation", correlation, "--json"),
          output.io,
        ),
        output.stderr(),
      ).toBe(2)
      expect(output.stdout()).toBe("")
      expect(output.stderr()).toContain("--correlation requires <namespace:id>")
      expect(await Array.fromAsync(app.events()).then((events) => events.length)).toBe(before)
      expect(app.state().bays.prs).toEqual({})
    }
  })
})

const PROJECTION_CORRELATION = { namespace: "tribe-request", id: "request-20925" } as const

async function correlatedTerminalRun(terminal: "integrated" | "rejected" | "canceled") {
  const app = await createApp({ failingCheck: terminal === "rejected" })
  await app.bays.submit({
    branch: `topic/${terminal}`,
    headSha: HEAD_SHA,
    base: "main",
    correlation: PROJECTION_CORRELATION,
  })

  if (terminal === "canceled") {
    await app.dispatch(app.commands.queue.run, { prs: ["PR1"], steps: ["check"] })
    const job = app.queue.get("R1")?.steps[0]?.job
    if (job === undefined) throw new Error("expected a requested Queue Job to cancel")
    await app.dispatch(app.commands.job.transition, {
      type: "start",
      id: job.id,
      attempt: 1,
      runner: "cli-test",
      leaseExpiresAt: "2026-07-09T12:02:00.000Z",
    })
    await app.jobs.cancel({ id: job.id, attempt: 1, by: "@chief", reason: "authorization revoked" })
    await app.dispatch(app.commands.queue.advance, { run: "R1" })
  } else {
    await app.queue.run({ prs: ["PR1"] }, { runner: "cli-test", leaseMs: 60_000 })
  }

  const pr = app.state().bays.prs.PR1
  const run = app.queue.get("R1")
  if (pr === undefined || run === undefined) throw new Error(`expected ${terminal} PR and Run fixtures`)
  return { app, pr, run }
}

async function projectedLogRows(app: TestApp, pr = "PR1"): Promise<Record<string, unknown>[]> {
  const output = outputIO()
  expect(await runYrd(app, yrd("log", "--pr", pr, "--json"), output.io), output.stderr()).toBe(0)
  return (JSON.parse(output.stdout()) as { rows: Record<string, unknown>[] }).rows
}

describe("correlation projections", () => {
  it("keeps structured correlation in terminal Run, show, and log JSON", async () => {
    for (const terminal of ["integrated", "rejected", "canceled"] as const) {
      const { app, pr, run } = await correlatedTerminalRun(terminal)
      const persisted = JSON.parse(JSON.stringify(run)) as Readonly<{
        prs: readonly Readonly<Record<string, unknown>>[]
      }>

      expect.soft(pr.status).toBe(terminal)
      expect.soft(persisted.prs).toEqual([expect.objectContaining({ correlation: PROJECTION_CORRELATION })])
      expect.soft(queueShowData(run).prs).toEqual([expect.objectContaining({ correlation: PROJECTION_CORRELATION })])
      expect
        .soft(await projectedLogRows(app, pr.id))
        .toEqual([expect.objectContaining({ pr: pr.id, correlation: PROJECTION_CORRELATION })])
    }

    const withdrawn = await createApp()
    await withdrawn.bays.submit({
      branch: "topic/withdrawn-no-run",
      headSha: HEAD_SHA,
      base: "main",
      draft: true,
      correlation: PROJECTION_CORRELATION,
    })
    await withdrawn.bays.closePr({ pr: "PR1" })
    expect.soft(withdrawn.state().bays.prs.PR1).toMatchObject({
      status: "withdrawn",
      correlation: PROJECTION_CORRELATION,
    })
    expect.soft(withdrawn.queue.status("main").finished).toEqual([])
    expect.soft(await projectedLogRows(withdrawn)).toEqual([
      expect.objectContaining({
        run: "-",
        pr: "PR1",
        outcome: "retired",
        correlation: PROJECTION_CORRELATION,
      }),
    ])
  })

  it("omits correlation from uncorrelated Run, show, and log JSON", async () => {
    const app = await createApp()
    await app.bays.submit({ branch: "topic/uncorrelated", headSha: HEAD_SHA, base: "main" })
    await app.queue.run({ prs: ["PR1"] }, { runner: "cli-test", leaseMs: 60_000 })
    const run = app.queue.get("R1")
    if (run === undefined) throw new Error("expected an uncorrelated Run fixture")
    const persisted = JSON.parse(JSON.stringify(run)) as Readonly<{
      prs: readonly Readonly<Record<string, unknown>>[]
    }>

    expect(persisted.prs[0]).not.toHaveProperty("correlation")
    expect(queueShowData(run).prs[0]).not.toHaveProperty("correlation")
    expect((await projectedLogRows(app))[0]).not.toHaveProperty("correlation")
  })
})

describe("explicit queue step authority", () => {
  it("runs one PR with only the explicitly selected merge step", async () => {
    const checkRuns: string[] = []
    const mergeRuns: string[] = []
    const app = await createApp({ checkRuns, mergeRuns })
    await openAndSubmit(app)

    const output = outputIO()
    expect(
      await runYrd(app, yrd("queue", "run", "PR1", "--steps", "merge", "--json"), output.io),
      output.stderr(),
    ).toBe(0)
    expect(checkRuns).toEqual([])
    expect(mergeRuns).toEqual(["merge"])
    expect(JSON.parse(output.stdout())).toMatchObject({
      command: "queue.run",
      results: [
        {
          status: "passed",
          stepSelection: {
            authority: "explicit",
            steps: ["merge"],
            omittedSteps: [{ name: "check", index: 0, status: "skipped", reason: "not-selected" }],
          },
          steps: [{ name: "merge" }],
          prs: [{ id: "PR1" }],
        },
      ],
    })
  })

  it("renders a merge-only PR batch with a concise skipped check", async () => {
    const checkRuns: string[] = []
    const mergeRuns: string[] = []
    const mergeStarted = Promise.withResolvers<void>()
    const releaseMerge = Promise.withResolvers<void>()
    const app = await createApp({
      batch: 2,
      checkRuns,
      mergeRuns,
      mergeWait: { started: () => mergeStarted.resolve(), until: releaseMerge.promise },
    })
    await openAndSubmit(app)
    expect(await runYrd(app, yrd("bay", "open", "two"), outputIO().io)).toBe(0)
    expect(await runYrd(app, yrd("bay", "submit"), outputIO({ cwd: "/repo/.bays/B2" }).io)).toBe(0)

    const completed = outputIO()
    const running = runYrd(app, yrd("queue", "run", "PR1", "PR2", "--steps", "merge"), completed.io)
    await mergeStarted.promise

    try {
      const output = outputIO()
      expect(
        await runYrd(app, yrd("pr", "edit", "PR1", "--note", "render running steps"), output.io),
        output.stderr(),
      ).toBe(0)
      expect(checkRuns).toEqual([])
      expect(mergeRuns).toEqual(["merge"])
      expect(output.stdout()).toContain("check=skipped merge=running")
      expect(app.queue.get("R1")).toMatchObject({
        status: "running",
        stepSelection: {
          authority: "explicit",
          steps: ["merge"],
          omittedSteps: [{ name: "check", index: 0, status: "skipped", reason: "not-selected" }],
        },
        steps: [{ name: "merge", job: { status: "running" } }],
        prs: [{ id: "PR1" }, { id: "PR2" }],
      })
    } finally {
      releaseMerge.resolve()
      await running
    }
    expect(await running, completed.stderr()).toBe(0)
  })
})

function trackerBridge(output: string): Readonly<{
  version: number
  asOf: Readonly<{ cursor: number; at?: string }>
  deliveries: readonly Readonly<Record<string, unknown>>[]
}> {
  const parsed = JSON.parse(output) as Readonly<Record<string, unknown>>
  const bridge = parsed.trackerBridge
  if (typeof bridge !== "object" || bridge === null || !("deliveries" in bridge)) {
    throw new Error("expected a trackerBridge JSON envelope")
  }
  return bridge as ReturnType<typeof trackerBridge>
}

function legacyRejectedJournal(runIds: readonly string[] = ["R1"], terminalAt = "2026-07-09T12:00:30.000Z") {
  const nextId = ids(9_000)
  const command = { id: nextId(), op: "fixture.legacy-rejected-run" }
  const cause = {
    id: nextId(),
    commandId: command.id,
    op: command.op,
    commandHash: Command.hash(command),
  }
  const issueRef = "@yrd/core/21091-legacy-run"
  const pr = {
    id: "PR1",
    branch: "topic/legacy-rejected-run",
    base: "main",
    revision: 1,
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
  }
  const startedAt = (index: number) => `2026-07-09T12:00:${String(index * 10 + 1).padStart(2, "0")}.000Z`
  const requestedAt = (index: number) => `2026-07-09T12:00:${String(index * 10 + 2).padStart(2, "0")}.000Z`
  const runningAt = (index: number) => `2026-07-09T12:00:${String(index * 10 + 3).padStart(2, "0")}.000Z`
  const finishedAt = (index: number) => `2026-07-09T12:00:${String(index * 10 + 4).padStart(2, "0")}.000Z`
  const runEvents = runIds.flatMap((run, index) => {
    const job = nextId()
    return [
      {
        id: nextId(),
        name: "queue/run/started",
        ts: startedAt(index),
        data: {
          run: {
            id: run,
            prs: [pr],
            base: "main",
            steps: [
              {
                name: "check",
                title: "check",
                revision: "check-v1",
                integrates: false,
                needsIntegration: false,
                classification: "carrier",
              },
            ],
          },
        },
      },
      {
        id: job,
        name: "job/requested",
        ts: requestedAt(index),
        data: {
          definition: "queue.step.check",
          revision: "check-v1",
          input: { run, step: "check", index: 0, prs: [pr], shape: { results: {} } },
          key: `queue:${run}:0`,
        },
      },
      {
        id: nextId(),
        name: "job/transitioned",
        ts: runningAt(index),
        data: {
          type: "start",
          id: job,
          attempt: 1,
          runner: "yrd-cli",
          leaseExpiresAt: "2026-07-09T12:30:00.000Z",
        },
      },
      {
        id: nextId(),
        name: "job/transitioned",
        ts: finishedAt(index),
        data: {
          type: "finish",
          id: job,
          attempt: 1,
          runner: "yrd-cli",
          result: { status: "failed", error: { code: "check-failed", message: "historical check failure" } },
        },
      },
    ]
  })
  const terminalEvent = nextId()
  return {
    issueRef,
    terminalEvent,
    journal: createMemoryJournal([
      {
        command,
        cause,
        events: [
          {
            id: nextId(),
            name: "pr/pushed",
            ts: "2026-07-09T12:00:00.000Z",
            data: { pr: pr.id, branch: pr.branch, base: pr.base, headSha: pr.headSha, issue: issueRef, revision: 1 },
          },
          {
            id: nextId(),
            name: "pr/submitted",
            ts: "2026-07-09T12:00:00.001Z",
            data: { pr: pr.id, revision: 1, headSha: pr.headSha },
          },
          ...runEvents,
          {
            id: terminalEvent,
            name: "pr/rejected",
            ts: terminalAt,
            data: { pr: pr.id, revision: 1, detail: "historical check failure" },
          },
        ],
      },
    ]),
  }
}

describe("typed issue landing bridge", () => {
  it("projects every native PR state in JSON and human views from one exact journal cursor", async () => {
    for (const status of ["pushed", "submitted", "rejected", "integrated", "withdrawn", "canceled"] as const) {
      const issueRef = `@km/all/21091-${status}`
      const app = await createApp({ failingCheck: status === "rejected" })
      try {
        await app.bays.submit({
          branch: `topic/mentions-2109-${status}`,
          headSha: HEAD_SHA,
          base: "main",
          issue: issueRef,
          ...(status === "pushed" || status === "withdrawn" ? { draft: true } : {}),
        })

        if (status === "withdrawn") {
          await app.bays.closePr({ pr: "PR1" })
        } else if (status === "rejected" || status === "integrated") {
          await app.queue.run({ prs: ["PR1"] }, { runner: "cli-test", leaseMs: 60_000 })
        } else if (status === "canceled") {
          await app.dispatch(app.commands.queue.run, { prs: ["PR1"], steps: ["check"] })
          const job = app.queue.get("R1")?.steps[0]?.job
          if (job === undefined) throw new Error("expected a requested Queue Job to cancel")
          await app.dispatch(app.commands.job.transition, {
            type: "start",
            id: job.id,
            attempt: 1,
            runner: "cli-test",
            leaseExpiresAt: "2026-07-09T12:02:00.000Z",
          })
          await app.jobs.cancel({ id: job.id, attempt: 1, by: "@chief", reason: "authorization revoked" })
          await app.dispatch(app.commands.queue.advance, { run: "R1" })
        }

        const output = outputIO()
        expect(await runYrd(app, yrd("issue", "view", issueRef, "--json"), output.io), output.stderr()).toBe(0)
        const bridge = trackerBridge(output.stdout())
        expect(bridge).toMatchObject({
          version: 1,
          asOf: { cursor: expect.any(Number), at: "2026-07-09T12:00:00.000Z" },
          deliveries: [
            {
              issueRef,
              pr: "PR1",
              revision: 1,
              headSha: HEAD_SHA,
              status,
              at: "2026-07-09T12:00:00.000Z",
              runs: status === "rejected" || status === "integrated" || status === "canceled" ? ["R1"] : [],
            },
          ],
        })
        const delivery = bridge.deliveries[0]
        if (status === "integrated") expect(delivery).toMatchObject({ landingSha: MERGED_SHA })
        else expect(delivery).not.toHaveProperty("landingSha")
        if (status === "rejected") {
          expect(delivery).toMatchObject({ bounce: { run: "R1", detail: "check failed" } })
        }

        const human = outputIO()
        expect(await runYrd(app, yrd("issue", "view", issueRef), human.io), human.stderr()).toBe(0)
        expect(human.stdout()).toContain(issueRef)
        expect(human.stdout()).toContain("DELIVERIES")
        expect(human.stdout()).toContain(`PR1 rev1 ${status}`)
        expect(human.stdout()).toContain(`HEAD ${HEAD_SHA}`)
        if (status === "integrated") expect(human.stdout()).toContain(MERGED_SHA)
        if (status === "rejected") expect(human.stdout()).toContain("BOUNCE R1 check failed")
      } finally {
        await app.close()
      }
    }
  })

  it("carries a literal --issue through pr submit --follow and the same shipping-config failure in pr checks", async () => {
    const issueRef = "@yrd/core/21096-cli-ux/21091-shipping-config"
    await using app = await createApp({
      checkFailure: { code: "shipping-config-invalid", message: "shipping config rejects candidate" },
    })
    const submit = outputIO({ resolveRevision: async () => HEAD_SHA })

    expect(
      await runYrd(
        app,
        yrd("pr", "submit", "topic/shipping-config", "--issue", issueRef, "--follow", "--json"),
        submit.io,
      ),
      submit.stderr(),
    ).toBe(1)
    expect(JSON.parse(submit.stdout())).toMatchObject({
      command: "pr.submit",
      prs: [{ id: "PR1", issue: issueRef, status: "rejected" }],
      checks: [{ error: { code: "shipping-config-invalid", message: "shipping config rejects candidate" } }],
    })

    const checks = outputIO()
    expect(await runYrd(app, yrd("pr", "checks", "PR1", "--json"), checks.io), checks.stderr()).toBe(1)
    expect(checks.stdout()).toContain("shipping-config-invalid")

    const issue = outputIO()
    expect(await runYrd(app, yrd("issue", "view", issueRef, "--json"), issue.io), issue.stderr()).toBe(0)
    expect(trackerBridge(issue.stdout()).deliveries).toEqual([
      expect.objectContaining({
        issueRef,
        pr: "PR1",
        revision: 1,
        headSha: HEAD_SHA,
        status: "rejected",
        bounce: { run: "R1", detail: "shipping config rejects candidate" },
      }),
    ])
  })

  it("refuses to label a historical rejection without a typed Queue bounce as trackerBridge v1", async () => {
    const nextId = ids()
    const issueRef = "@yrd/core/21091-legacy-rejection"
    const at = "2026-07-09T12:00:00.000Z"
    const seededCommand = { id: nextId(), op: "fixture.legacy-rejected" }
    const journal = createMemoryJournal([
      {
        command: seededCommand,
        cause: {
          id: nextId(),
          commandId: seededCommand.id,
          op: seededCommand.op,
          commandHash: Command.hash(seededCommand),
        },
        events: [
          {
            id: nextId(),
            name: "pr/pushed",
            ts: at,
            data: {
              pr: "PR1",
              branch: "topic/legacy-rejected",
              base: "main",
              headSha: HEAD_SHA,
              issue: issueRef,
              revision: 1,
            },
          },
          {
            id: nextId(),
            name: "pr/rejected",
            ts: at,
            data: { pr: "PR1", revision: 1, detail: "historical check failure" },
          },
        ],
      },
    ])
    await using app = await createApp({ journal })
    const output = outputIO()

    expect(await runYrd(app, yrd("issue", "view", issueRef, "--json"), output.io)).toBe(1)
    expect(output.stdout()).toBe("")
    expect(output.stderr()).toContain("cannot project rejected PR 'PR1' without a typed Queue bounce run")
  })

  it("dry-runs a unique failed Queue run association for a legacy rejection without writing", async () => {
    const seeded = legacyRejectedJournal()
    await using app = await createApp({ journal: seeded.journal })
    const before = await Array.fromAsync(app.events())
    const output = outputIO()

    expect(await runYrd(app, yrd("migrate", "terminal-associations", "--json"), output.io), output.stderr()).toBe(0)
    expect(await Array.fromAsync(app.events())).toEqual(before)
    expect(JSON.parse(output.stdout())).toMatchObject({
      command: "migrate.terminal-associations",
      mode: "dry-run",
      provenance: "migration/21091",
      summary: { unprojectable: 1, ready: 1, refused: 0, appended: 0 },
      rows: [
        {
          status: "ready",
          terminal: {
            event: seeded.terminalEvent,
            pr: "PR1",
            revision: 1,
            headSha: HEAD_SHA,
            at: "2026-07-09T12:00:30.000Z",
          },
          association: {
            pr: "PR1",
            revision: 1,
            headSha: HEAD_SHA,
            run: "R1",
            provenance: "migration/21091",
            evidence: { terminalEvent: seeded.terminalEvent, run: "R1" },
          },
        },
      ],
    })
  })

  it("appends one strict terminal association, replays its bounce, and applies idempotently", async () => {
    const seeded = legacyRejectedJournal()
    {
      await using app = await createApp({ journal: seeded.journal })
      const before = await Array.fromAsync(app.events())
      const output = outputIO()

      expect(
        await runYrd(app, yrd("migrate", "terminal-associations", "--apply", "--json"), output.io),
        output.stderr(),
      ).toBe(0)
      expect(JSON.parse(output.stdout())).toMatchObject({
        command: "migrate.terminal-associations",
        mode: "apply",
        summary: { unprojectable: 1, ready: 1, refused: 0, appended: 1 },
      })
      const appended = (await Array.fromAsync(app.events())).slice(before.length)
      expect(appended).toEqual([
        expect.objectContaining({
          name: "pr/terminal-associated",
          data: {
            pr: "PR1",
            revision: 1,
            headSha: HEAD_SHA,
            run: "R1",
            provenance: "migration/21091",
            evidence: { terminalEvent: seeded.terminalEvent, run: "R1" },
          },
        }),
      ])
    }

    await using replayed = await createApp({ journal: seeded.journal })
    const issue = outputIO()
    expect(await runYrd(replayed, yrd("issue", "view", seeded.issueRef, "--json"), issue.io), issue.stderr()).toBe(0)
    expect(trackerBridge(issue.stdout()).deliveries).toEqual([
      expect.objectContaining({
        issueRef: seeded.issueRef,
        pr: "PR1",
        revision: 1,
        headSha: HEAD_SHA,
        status: "rejected",
        bounce: { run: "R1", detail: "historical check failure" },
      }),
    ])

    const beforeSecondApply = await Array.fromAsync(replayed.events())
    const second = outputIO()
    expect(
      await runYrd(replayed, yrd("migrate", "terminal-associations", "--apply", "--json"), second.io),
      second.stderr(),
    ).toBe(0)
    expect(JSON.parse(second.stdout())).toMatchObject({
      mode: "apply",
      rows: [],
      summary: { unprojectable: 0, ready: 0, refused: 0, appended: 0 },
    })
    expect(await Array.fromAsync(replayed.events())).toEqual(beforeSecondApply)
  })

  it("reports two matching failed Queue runs as a typed ambiguity and never guesses on apply", async () => {
    const seeded = legacyRejectedJournal(["R1", "R2"])
    await using app = await createApp({ journal: seeded.journal })
    const before = await Array.fromAsync(app.events())
    const dryRun = outputIO()

    expect(await runYrd(app, yrd("migrate", "terminal-associations", "--json"), dryRun.io)).toBe(1)
    expect(JSON.parse(dryRun.stdout())).toMatchObject({
      mode: "dry-run",
      summary: { unprojectable: 1, ready: 0, refused: 1, appended: 0 },
      rows: [
        {
          status: "refused",
          terminal: { event: seeded.terminalEvent, pr: "PR1", revision: 1, headSha: HEAD_SHA },
          refusal: { code: "terminal-run-ambiguous" },
          candidates: [
            { run: "R1", status: "failed", eligible: true },
            { run: "R2", status: "failed", eligible: true },
          ],
        },
      ],
    })
    expect(await Array.fromAsync(app.events())).toEqual(before)

    const apply = outputIO()
    expect(await runYrd(app, yrd("migrate", "terminal-associations", "--apply", "--json"), apply.io)).toBe(1)
    expect(JSON.parse(apply.stdout())).toMatchObject({
      mode: "apply",
      summary: { unprojectable: 1, ready: 0, refused: 1, appended: 0 },
    })
    expect(await Array.fromAsync(app.events())).toEqual(before)
  })

  it("refuses a failed Queue run whose completion postdates the legacy rejection", async () => {
    const terminalAt = "2026-07-09T12:00:03.500Z"
    const seeded = legacyRejectedJournal(["R1"], terminalAt)
    await using app = await createApp({ journal: seeded.journal })
    const before = await Array.fromAsync(app.events())
    const output = outputIO()

    expect(await runYrd(app, yrd("migrate", "terminal-associations", "--apply", "--json"), output.io)).toBe(1)
    expect(JSON.parse(output.stdout())).toMatchObject({
      mode: "apply",
      summary: { unprojectable: 1, ready: 0, refused: 1, appended: 0 },
      rows: [
        {
          status: "refused",
          terminal: { event: seeded.terminalEvent, at: terminalAt, pr: "PR1", revision: 1 },
          refusal: { code: "terminal-run-chronology" },
          candidates: [
            {
              run: "R1",
              status: "failed",
              finishedAt: "2026-07-09T12:00:04.000Z",
              eligible: false,
            },
          ],
        },
      ],
    })
    expect(await Array.fromAsync(app.events())).toEqual(before)
  })

  it("records a completed escaped regression without rewriting either integration", async () => {
    const originalIssue = "@yrd/core/21090-original"
    const repairIssue = "@yrd/core/21091-repair"
    const originalLanding = "c".repeat(40)
    const repairLanding = "d".repeat(40)
    const repairHead = "2".repeat(40)
    let now = "2026-07-09T12:00:00.000Z"
    await using app = await createApp({ mergeCommits: [originalLanding, repairLanding], clock: () => now })
    await app.bays.submit({ branch: "topic/original", headSha: HEAD_SHA, base: "main", issue: originalIssue })
    await app.queue.run({ prs: ["PR1"] }, { runner: "cli-test", leaseMs: 60_000 })
    now = "2026-07-09T14:00:00.000Z"
    await app.bays.submit({ branch: "topic/repair", headSha: repairHead, base: "main", issue: repairIssue })
    await app.queue.run({ prs: ["PR2"] }, { runner: "cli-test", leaseMs: 60_000 })
    now = "2026-07-09T15:00:00.000Z"

    const command = (run = "r1", repairRun = "r2", detectedAt = "2026-07-09T13:00:00.000Z") =>
      yrd(
        "pr",
        "regression",
        "pr1",
        "--run",
        run,
        "--detected-at",
        detectedAt,
        "--severity",
        "high",
        "--evidence",
        "artifact://tty/21091-red",
        "--implementation-run",
        "hab:turn/original-implementation",
        "--review",
        "tribe:verdict/original-review",
        "--repair-pr",
        "pr2",
        "--repair-run",
        repairRun,
        "--json",
      )
    const expected = {
      pr: "PR1",
      issueRef: originalIssue,
      revision: 1,
      headSha: HEAD_SHA,
      run: "R1",
      landingSha: originalLanding,
      detectedAt: "2026-07-09T13:00:00.000Z",
      severity: "high",
      evidence: "artifact://tty/21091-red",
      implementationRunRef: "hab:turn/original-implementation",
      reviewRef: "tribe:verdict/original-review",
      repairIssueRef: repairIssue,
      repairPr: "PR2",
      repairRun: "R2",
      repairLandingSha: repairLanding,
    }
    for (const impossible of ["2026-07-09T11:59:59.999Z", "2026-07-09T14:00:00.001Z"]) {
      const refusedChronology = outputIO()
      expect(await runYrd(app, command("R1", "R2", impossible), refusedChronology.io)).toBe(1)
      expect(refusedChronology.stdout()).toBe("")
      expect(refusedChronology.stderr()).toContain("regression chronology")
    }

    const recorded = outputIO()
    expect(await runYrd(app, command(), recorded.io), recorded.stderr()).toBe(0)
    expect(JSON.parse(recorded.stdout())).toEqual({ command: "pr.regression", regression: expected })
    expect(app.bays.pr("PR1")).toMatchObject({
      status: "integrated",
      integration: { commit: originalLanding },
      regressions: [{ ...expected, recordedAt: "2026-07-09T15:00:00.000Z" }],
    })
    expect(app.bays.pr("PR2")).toMatchObject({ status: "integrated", integration: { commit: repairLanding } })

    const repeated = outputIO()
    expect(await runYrd(app, command(), repeated.io), repeated.stderr()).toBe(0)
    expect((await Array.fromAsync(app.events())).filter(({ name }) => name === "pr/regression-recorded")).toHaveLength(
      1,
    )

    const refused = outputIO()
    expect(await runYrd(app, command("R2"), refused.io)).toBe(1)
    expect(refused.stdout()).toBe("")

    const issue = outputIO()
    const runs = outputIO()
    expect(await runYrd(app, yrd("issue", "view", originalIssue, "--json"), issue.io), issue.stderr()).toBe(0)
    expect(await runYrd(app, yrd("pr", "runs", "PR1", "--json"), runs.io), runs.stderr()).toBe(0)
    expect(trackerBridge(issue.stdout())).toEqual(trackerBridge(runs.stdout()))
    expect(trackerBridge(issue.stdout()).deliveries).toEqual([
      expect.objectContaining({
        issueRef: originalIssue,
        pr: "PR1",
        status: "integrated",
        landingSha: originalLanding,
        regressions: [{ ...expected, recordedAt: "2026-07-09T15:00:00.000Z" }],
      }),
    ])

    const human = outputIO()
    expect(await runYrd(app, yrd("issue", "view", originalIssue), human.io), human.stderr()).toBe(0)
    for (const visibleFact of [
      "REGRESSION high DETECTED 2026-07-09T13:00:00.000Z RECORDED 2026-07-09T15:00:00.000Z",
      `ORIGINAL ${originalIssue} PR1 R1 LANDING ${originalLanding}`,
      "artifact://tty/21091-red",
      "hab:turn/original-implementation",
      "tribe:verdict/original-review",
      `REPAIR ${repairIssue} PR2 R2 LANDING ${repairLanding}`,
    ]) {
      expect(human.stdout()).toContain(visibleFact)
    }
  })

  it("retries a racing pr runs snapshot and refuses three exhausted cuts without partial JSON", async () => {
    const issueRef = "@yrd/core/21091-snapshot-race"
    await using app = await createApp()
    await app.bays.submit({ branch: "topic/snapshot-race", headSha: HEAD_SHA, base: "main", issue: issueRef })

    let raced = false
    const racingApp = {
      ...app,
      async journalSnapshot() {
        const snapshot = await app.journalSnapshot()
        if (!raced) {
          raced = true
          await app.queue.run({ prs: ["PR1"] }, { runner: "cli-test", leaseMs: 60_000 })
        }
        return snapshot
      },
    }
    const racedOutput = outputIO()
    expect(await runYrd(racingApp, yrd("pr", "runs", "PR1", "--json"), racedOutput.io)).toBe(0)
    expect(trackerBridge(racedOutput.stdout())).toMatchObject({
      asOf: (await app.journalSnapshot()).asOf,
      deliveries: [{ issueRef, pr: "PR1", status: "integrated", landingSha: MERGED_SHA, runs: ["R1"] }],
    })

    let snapshots = 0
    let advances = 0
    const exhaustingApp = {
      ...app,
      async journalSnapshot() {
        const snapshot = await app.journalSnapshot()
        if (snapshots++ % 2 === 0) {
          advances += 1
          await app.bays.submit({
            branch: `topic/concurrent-${advances}`,
            headSha: String(advances + 2).repeat(40),
            base: "main",
          })
        }
        return snapshot
      },
    }
    const exhausted = outputIO()
    expect(await runYrd(exhaustingApp, yrd("pr", "runs", "PR1", "--json"), exhausted.io)).toBe(1)
    expect({ snapshots, advances }).toEqual({ snapshots: 6, advances: 3 })
    expect(exhausted.stdout()).toBe("")
    expect(exhausted.stderr()).toBe(
      [
        "yrd: err=request-refused",
        "cause: journal changed while reading PR 'PR1' runs; retry with 'yrd pr runs PR1 --json'",
        "resolve: yrd pr runs PR1 --json",
        "",
      ].join("\n"),
    )
  })
})

describe("journal version skew fail-loud", () => {
  // Simulates a journal written by a NEWER yrd: rows stay storage-valid but
  // carry fields this build's domain schemas do not recognize.
  const newerWriterFields = Object.freeze({
    forwardCompatProbe: "vNext",
    landingReceipt: "9".repeat(40),
  })

  /** RFC 8785-shaped JSON for journal frame data (strings, ints, arrays,
   * objects only). Any divergence from the journal's own canonicalization
   * fails loud as a frame checksum mismatch, never a silent pass. */
  function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
    if (typeof value !== "object" || value === null) return JSON.stringify(value)
    const record = value as Record<string, unknown>
    const entries = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    return `{${entries.join(",")}}`
  }

  type StoredJournalRow = Record<string, unknown> & {
    events?: (Record<string, unknown> & { name: string; data: unknown })[]
  }

  function testJournal(dir: string) {
    return createJournal({
      dir,
      inject: { sqliteVersion: "3.53.0" },
    } as unknown as Parameters<typeof createJournal>[0])
  }

  function authoritativeJournalRows(dir: string): Array<{ cursor: number; row: StoredJournalRow }> {
    using database = new Database(join(dir, "journal.sqlite"), { readonly: true, strict: true })
    const snapshot = database
      .query<{ prefix_json: string }, []>("SELECT prefix_json FROM journal_snapshot WHERE singleton = 1")
      .get()
    if (snapshot === null) throw new Error("expected SQLite journal snapshot")
    const prefix = JSON.parse(snapshot.prefix_json) as Array<{ cursor: number; value: StoredJournalRow }>
    const tail = database
      .query<{ cursor: number; value_json: string }, []>(
        "SELECT cursor, value_json FROM journal_events ORDER BY cursor",
      )
      .all()
      .map(({ cursor, value_json }) => ({ cursor, row: JSON.parse(value_json) as StoredJournalRow }))
    return [...prefix.map(({ cursor, value }) => ({ cursor, row: value })), ...tail]
  }

  async function seededJournalDir(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "yrd-journal-skew-"))
    const seeded = await createApp({ journal: testJournal(dir) })
    await openAndSubmit(seeded)
    await seeded.close()
    return dir
  }

  function rewriteJournalRows(dir: string, poison: (row: StoredJournalRow) => boolean): number {
    const rows = authoritativeJournalRows(dir)
    let poisoned = 0
    for (const entry of rows) {
      if (poison(entry.row)) poisoned += 1
    }
    using database = new Database(join(dir, "journal.sqlite"), { readwrite: true, strict: true })
    database.exec("BEGIN IMMEDIATE")
    try {
      const emptyPrefix = "[]"
      database
        .query(
          `UPDATE journal_snapshot
           SET cursor = 0, prefix_json = ?, prefix_sha256 = ?, prefix_last_cursor = 0,
               checkpoint_identity = NULL, checkpoint_json = NULL, checkpoint_sha256 = NULL
           WHERE singleton = 1`,
        )
        .run(emptyPrefix, createHash("sha256").update(canonicalJson([])).digest("hex"))
      database.exec("DELETE FROM journal_events")
      const insert = database.query("INSERT INTO journal_events(cursor, value_json, sha256) VALUES (?, ?, ?)")
      for (const { cursor, row } of rows) {
        const encoded = JSON.stringify(row)
        insert.run(cursor, encoded, createHash("sha256").update(encoded).digest("hex"))
      }
      database.exec("COMMIT")
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }
    return poisoned
  }

  function poisonPrEventData(row: StoredJournalRow): boolean {
    let hit = false
    for (const event of row.events ?? []) {
      if (!event.name.startsWith("pr/")) continue
      if (typeof event.data !== "object" || event.data === null || Array.isArray(event.data)) continue
      event.data = { ...event.data, ...newerWriterFields }
      hit = true
    }
    return hit
  }

  function journalBootstrap(dir: string) {
    return {
      ambientCwd: "/repo",
      env: {} as NodeJS.ProcessEnv,
      load: async () => ({ app: await createApp({ journal: testJournal(dir) }), services: {} }),
    }
  }

  async function withPoisonedJournal(
    poison: (row: StoredJournalRow) => boolean,
    read: (dir: string) => Promise<void>,
  ): Promise<void> {
    const dir = await seededJournalDir()
    try {
      expect(rewriteJournalRows(dir, poison)).toBeGreaterThan(0)
      await read(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it("exits nonzero and keeps stdout clean when replayed rows fail domain schema validation", async () => {
    await withPoisonedJournal(poisonPrEventData, async (dir) => {
      const out = outputIO()
      const exit = await runInternals.runYrdProcessRuntime(yrd("pr", "list"), out.io, journalBootstrap(dir))
      expect(exit).toBe(3)
      expect(out.stdout()).toBe("")
      expect(out.stderr()).not.toBe("")
    })
  })

  it("explains newer-writer rows as version skew instead of dumping raw zod issues", async () => {
    await withPoisonedJournal(poisonPrEventData, async (dir) => {
      const out = outputIO()
      const exit = await runInternals.runYrdProcessRuntime(yrd("pr", "list"), out.io, journalBootstrap(dir))
      expect(exit).toBe(3)
      const stderr = out.stderr()
      expect(stderr).toContain("newer")
      expect(stderr).toContain("forwardCompatProbe")
      expect(stderr).toContain("landingReceipt")
      expect(stderr).toContain(`${YRD_VERSION}+`)
      expect(stderr).toContain("-v")
      expect(stderr).not.toContain("unrecognized_keys")
      expect(stderr).not.toContain("invalid_union")
    })
  })

  it("keeps the raw validation detail available behind --verbose", async () => {
    await withPoisonedJournal(poisonPrEventData, async (dir) => {
      const out = outputIO()
      const exit = await runInternals.runYrdProcessRuntime(yrd("-v", "pr", "list"), out.io, journalBootstrap(dir))
      expect(exit).toBe(3)
      const stderr = out.stderr()
      expect(stderr).toContain("forwardCompatProbe")
      expect(stderr).toContain("unrecognized_keys")
    })
  })

  it("gives the same skew guidance when stored frames carry unknown top-level fields", async () => {
    await withPoisonedJournal(
      (row) => {
        row.writerBuild = "yrd 9.9.9+ffffffffff"
        return true
      },
      async (dir) => {
        const out = outputIO()
        const exit = await runInternals.runYrdProcessRuntime(yrd("pr", "list"), out.io, journalBootstrap(dir))
        expect(exit).toBe(3)
        expect(out.stdout()).toBe("")
        const stderr = out.stderr()
        expect(stderr).toContain("newer")
        expect(stderr).toContain("writerBuild")
        expect(stderr).toContain(`${YRD_VERSION}+`)
        expect(stderr).not.toContain("unrecognized_keys")
      },
    )
  })
})

describe("queue run — follow-runner output is loggily/JSON only (#undead runner-loggily-only)", () => {
  // The resident follow-runner (`queue run`, follow-by-default) is a background
  // service whose stdout is a log. The QueueRunsView table (RUN/PRS/STATE/STEPS)
  // is the interactive `queue watch` viewer's surface, not the follow-runner's —
  // it must never be dumped into the log stream. In human mode the follow-runner
  // emits nothing to stdout but loggily; `--json` still streams the run record.
  const onePassScope = () => {
    const controller = new AbortController()
    return { signal: controller.signal, sleep: async () => controller.abort() }
  }

  it("does not print the QueueRunsView table on human stdout in follow mode", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    const runHuman = outputIO({ scope: onePassScope() })
    expect(await runYrd(app, yrd("queue", "run"), runHuman.io), runHuman.stderr()).toBe(0)
    expect(runHuman.stdout()).not.toContain("STATE")
    expect(runHuman.stdout()).not.toContain("STEPS")
  })

  it("still streams the run record in follow mode --json", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    const runJson = outputIO({ scope: onePassScope() })
    expect(await runYrd(app, yrd("queue", "run", "--json"), runJson.io), runJson.stderr()).toBe(0)
    expect(runJson.stdout()).toContain("queue.run")
  })
})

describe("PR metadata — title, description, and issue link", () => {
  function commitMetaIO(subject: string, body?: string, overrides: Partial<YrdCliIO> = {}) {
    return outputIO({
      resolveRevision: async () => HEAD_SHA,
      resolveCommitMeta: async () => ({ subject, ...(body === undefined ? {} : { body }) }),
      ...overrides,
    })
  }

  it("defaults the PR title and description from the head commit subject and body at submit", async () => {
    const app = await createApp()
    const submit = commitMetaIO("feat(bay): pr metadata", "Adds a durable title and description to the PR record.")
    expect(await runYrd(app, yrd("pr", "submit", "topic/defaults", "--base", "main"), submit.io), submit.stderr()).toBe(
      0,
    )
    expect(app.bays.pr("topic/defaults")).toMatchObject({
      title: "feat(bay): pr metadata",
      description: "Adds a durable title and description to the PR record.",
    })
  })

  it("appends an issue reference to the default description when --issue is given", async () => {
    const app = await createApp()
    const submit = commitMetaIO("feat: linked change", "Commit body text.")
    expect(
      await runYrd(
        app,
        yrd("pr", "submit", "topic/linked", "--base", "main", "--issue", "@km/all/21091-metadata"),
        submit.io,
      ),
      submit.stderr(),
    ).toBe(0)
    const pr = app.bays.pr("topic/linked")
    expect(pr?.title).toBe("feat: linked change")
    expect(pr?.description).toContain("Commit body text.")
    expect(pr?.description).toContain("Issue: @km/all/21091-metadata")
    expect(pr?.issue).toBe("@km/all/21091-metadata")
  })

  it("lets explicit --title and --description override the commit defaults", async () => {
    const app = await createApp()
    const submit = commitMetaIO("feat: from commit subject", "Commit body.")
    expect(
      await runYrd(
        app,
        yrd(
          "pr",
          "submit",
          "topic/explicit",
          "--base",
          "main",
          "--title",
          "Explicit subject text",
          "--description",
          "Explicit description body.",
        ),
        submit.io,
      ),
      submit.stderr(),
    ).toBe(0)
    expect(app.bays.pr("topic/explicit")).toMatchObject({
      title: "Explicit subject text",
      description: "Explicit description body.",
    })
  })

  it("edits the title and description of a live PR via pr edit", async () => {
    const app = await createApp()
    const submit = commitMetaIO("feat: original subject", "Original body.")
    expect(await runYrd(app, yrd("pr", "submit", "topic/edit", "--base", "main"), submit.io), submit.stderr()).toBe(0)
    const edit = outputIO()
    expect(
      await runYrd(
        app,
        yrd("pr", "edit", "topic/edit", "--title", "feat: renamed subject", "--description", "New body."),
        edit.io,
      ),
      edit.stderr(),
    ).toBe(0)
    expect(app.bays.pr("topic/edit")).toMatchObject({ title: "feat: renamed subject", description: "New body." })
  })

  it("prefers the PR title over the branch in the pr list SUBJECT column and JSON", async () => {
    const app = await createApp()
    // Short enough to survive the SUBJECT column budget so the branch never wins.
    const submit = commitMetaIO("add pr metadata")
    expect(await runYrd(app, yrd("pr", "submit", "topic/list", "--base", "main"), submit.io), submit.stderr()).toBe(0)

    const list = outputIO({ columns: 120 })
    expect(await runYrd(app, yrd("pr", "list"), list.io), list.stderr()).toBe(0)
    expect(list.stdout()).toContain("add pr metadata")
    expect(list.stdout()).not.toContain("topic/list")

    const json = outputIO()
    expect(await runYrd(app, yrd("pr", "list", "--json"), json.io), json.stderr()).toBe(0)
    expect(JSON.parse(json.stdout())).toMatchObject({ prs: [{ title: "add pr metadata" }] })
  })

  it("shows TITLE, ISSUE, and DESCRIPTION rows in pr view", async () => {
    const app = await createApp()
    const submit = commitMetaIO("feat(view): pr metadata", "The description body.")
    expect(
      await runYrd(
        app,
        yrd("pr", "submit", "topic/view", "--base", "main", "--issue", "https://example.test/issues/7"),
        submit.io,
      ),
      submit.stderr(),
    ).toBe(0)

    const view = outputIO({ columns: 120, color: true })
    expect(await runYrd(app, yrd("pr", "view", "topic/view"), view.io), view.stderr()).toBe(0)
    const visible = stripOsc8Targets(view.stdout())
    expect(visible).toContain("TITLE")
    expect(visible).toContain("feat(view): pr metadata")
    expect(visible).toContain("ISSUE")
    expect(visible).toContain("DESCRIPTION")
    expect(visible).toContain("The description body.")
    // The issue URL is an OSC 8 hyperlink target in the detail identity area.
    expect(view.stdout()).toContain("]8;;https://example.test/issues/7")
  })

  function metadataPr(overrides: Partial<PR> = {}): PR {
    return {
      id: "PR1",
      branch: "topic/metadata",
      base: "main",
      status: "submitted",
      revision: 1,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      title: "feat(detail): pr metadata",
      description: "First row of the description.\n\nIssue: https://example.test/issues/9",
      issue: "https://example.test/issues/9",
      revisions: [submittedRevision(1, HEAD_SHA, "2026-07-09T12:00:00.000Z")],
      reviews: [],
      comments: [],
      checkRequests: [],
      ...overrides,
    }
  }

  it("renders title, an OSC 8 issue hyperlink, and the description in the PR detail view", async () => {
    const rendered = await renderString(
      createElement(PRDetailView, { pr: metadataPr(), runs: [], now: Date.parse("2026-07-09T12:10:00.000Z") }),
      { width: 120, height: 40 },
    )
    const visible = stripOsc8Targets(rendered)
    expect(visible).toContain("TITLE")
    expect(visible).toContain("feat(detail): pr metadata")
    expect(visible).toContain("ISSUE")
    expect(visible).toContain("DESCRIPTION")
    expect(visible).toContain("First row of the description.")
    expect(rendered).toContain("]8;;https://example.test/issues/9")
  })

  it("renders title, issue hyperlink, and description per member in the batched PRS facts", async () => {
    const rendered = await renderString(createElement(QueueDetailPrFacts, { prs: [metadataPr()] }), {
      width: 120,
      height: 40,
    })
    const visible = stripOsc8Targets(rendered)
    expect(visible).toContain("TITLE feat(detail): pr metadata")
    expect(visible).toContain("ISSUE")
    expect(visible).toContain("DESCRIPTION")
    expect(rendered).toContain("]8;;https://example.test/issues/9")
  })

  it("renders a path-form issue reference as a km-style internal link", async () => {
    const rendered = await renderString(
      createElement(QueueDetailPrFacts, {
        prs: [metadataPr({ issue: "@km/all/21091-plain", description: undefined })],
      }),
      { width: 120, height: 20 },
    )
    expect(rendered).toContain("@km/all/21091-plain")
    expect(rendered).toContain("]8;;km:@km/all/21091-plain")
  })
})

describe("watch viewer — frozen projection under a live clock (task #64)", () => {
  it("bounds the watch Git runner and reports a timeout", async () => {
    const requests: ProcessRequest[] = []
    const process = {
      async run(request: ProcessRequest): Promise<ProcessResult> {
        requests.push(request)
        return {
          exitCode: 143,
          signal: "SIGTERM",
          stdout: "",
          stderr: "",
          durationMs: 30_000,
          timedOut: true,
          verdict: "TIMED_OUT",
        }
      },
    }

    await expect(runInternals.runQueueGit(process, "/repo", ["diff", "HEAD"])).rejects.toThrow(
      "yrd: git diff HEAD timed out after 30000ms",
    )
    expect(requests).toEqual([
      expect.objectContaining({
        argv: ["git", "-C", "/repo", "diff", "HEAD"],
        cwd: "/repo",
        timeoutMs: 30_000,
      }),
    ])
  })

  it("never caches a timed-out focused diff as missing refs", async () => {
    let calls = 0
    const process = {
      async run(): Promise<ProcessResult> {
        calls++
        if (calls % 2 === 1) {
          return {
            exitCode: 0,
            signal: null,
            stdout: ".git\n",
            stderr: "",
            durationMs: 1,
            timedOut: false,
            verdict: "EXITED",
          }
        }
        return {
          exitCode: 143,
          signal: "SIGTERM",
          stdout: "",
          stderr: "",
          durationMs: 30_000,
          timedOut: true,
          verdict: "TIMED_OUT",
        }
      },
    }
    const resolver = runInternals.createQueuePrDiffResolver({
      runGit: (cwd, args) => runInternals.runQueueGit(process, cwd, args),
    })
    const pr = {
      id: "PR1",
      revision: 1,
      base: "main",
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      revisions: [submittedRevision(1, HEAD_SHA, "2026-07-09T12:00:00.000Z")],
    } as unknown as PR

    await expect(resolver.resolve("/repo", pr, 1, 1_000)).rejects.toThrow(
      "yrd: git cat-file -e aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa^{commit} timed out after 30000ms",
    )
    await expect(resolver.resolve("/repo", pr, 1, 2_000)).rejects.toThrow("timed out after 30000ms")
    expect(calls).toBe(4)
  })

  it("does not read run artifacts for a focused PR row without a run", async () => {
    const artifactRoot = mkdtempSync(join(tmpdir(), "yrd-watch-focused-output-"))
    const app = await createApp()
    try {
      await openAndSubmit(app)
      await app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 })
      const outputPath = join(artifactRoot, "R1", "0-check", "attempt-1", "output.log")
      mkdirSync(join(outputPath, ".."), { recursive: true })
      writeFileSync(outputPath, "must stay unread for a PR-only row\n")

      const snapshot = await runInternals.queueListSnapshot(app, [], {}, outputIO({ artifactRoot }).io, {
        includeOutputs: true,
        focus: { pr: "PR1", revision: 1 },
      })
      expect(snapshot.outputs).toBeUndefined()
    } finally {
      await app.close()
      rmSync(artifactRoot, { recursive: true, force: true })
    }
  })

  it("resolves and permanently caches one async diff for an immutable focused revision", async () => {
    const calls: string[][] = []
    const resolver = runInternals.createQueuePrDiffResolver({
      runGit: async (_cwd, args) => {
        calls.push([...args])
        if (args.includes("--numstat")) return "3\t2\tsrc/watch.ts\0-\t-\tfixture.bin\0"
        if (args[0] === "diff") return "focused patch\n"
        return ""
      },
    })
    const pr = {
      id: "PR1",
      revision: 1,
      base: "main",
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      revisions: [submittedRevision(1, HEAD_SHA, "2026-07-09T12:00:00.000Z")],
    } as unknown as PR

    await expect(resolver.resolve("/repo", pr, 1, 1_000)).resolves.toEqual({
      pr: "PR1",
      revision: 1,
      additions: 3,
      deletions: 2,
      files: ["src/watch.ts", "fixture.bin"],
      patch: "focused patch\n",
    })
    expect(calls).toHaveLength(5)
    await resolver.resolve("/repo", pr, 1, 60_000)
    expect(calls).toHaveLength(5)
  })

  it("negative-caches a missing focused diff until its retry window expires", async () => {
    const calls: string[][] = []
    const resolver = runInternals.createQueuePrDiffResolver({
      negativeTtlMs: 30_000,
      runGit: async (_cwd, args) => {
        calls.push([...args])
        if (args[0] === "rev-parse") return ".git\n"
        throw new Error("missing object")
      },
    })
    const pr = {
      id: "PR1",
      revision: 1,
      base: "main",
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      revisions: [submittedRevision(1, HEAD_SHA, "2026-07-09T12:00:00.000Z")],
    } as unknown as PR

    await expect(resolver.resolve("/repo", pr, 1, 1_000)).resolves.toMatchObject({ unavailable: "refs-pruned" })
    await expect(resolver.resolve("/repo", pr, 1, 30_999)).resolves.toMatchObject({ unavailable: "refs-pruned" })
    expect(calls).toHaveLength(2)

    await expect(resolver.resolve("/repo", pr, 1, 31_000)).resolves.toMatchObject({ unavailable: "refs-pruned" })
    expect(calls).toHaveLength(4)
  })

  it("projects configured step commands into human watch snapshots", async () => {
    const repo = mkdtempSync(join(tmpdir(), "yrd-watch-commands-"))
    writeFileSync(join(repo, ".yrd.yml"), 'steps: [check, merge]\ncheck: "bun vitest run"\nmerge: {}\n')
    const app = await createApp()
    try {
      const snapshot = await runInternals.queueListSnapshot(app, [], {}, outputIO({ cwd: repo }).io, {
        includeOutputs: true,
      })
      expect(snapshot.commands).toEqual({ check: "bun vitest run" })
    } finally {
      await app.close()
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it("queueListSnapshot tails out-of-process journal appends instead of serving the mount-time projection", async () => {
    // `queue watch` builds ONE long-lived app and reloads on a timer, while a
    // separate resident-runner process appends to the shared journal. The viewer
    // must see those appends each tick — otherwise its rows freeze at mount while
    // `now`/`runner` keep ticking (the reported "live clock over hours-old rows").
    const journal = createMemoryJournal()
    const runner = await createApp({ journal })
    const viewer = await createApp({ journal })
    try {
      // The runner submits a PR AFTER the viewer app has already mounted.
      await openAndSubmit(runner)
      expect(Object.keys(runner.state().bays.prs)).toEqual(["PR1"])

      // The viewer's mount-time journal projection never tails cross-process
      // appends on its own — app.state() alone stays frozen-empty:
      expect(Object.keys(viewer.state().bays.prs)).toEqual([])

      // queueListSnapshot refreshes before reading, so its rows reflect the
      // out-of-process submission (stale WITHOUT refresh, fresh WITH it):
      const snapshot = await runInternals.queueListSnapshot(viewer, [], {}, outputIO().io)
      expect(snapshot.results.flatMap((result) => result.prs.map((pr) => pr.id))).toContain("PR1")

      // The refresh also published, so subsequent plain reads are fresh too:
      expect(Object.keys(viewer.state().bays.prs)).toEqual(["PR1"])
    } finally {
      await Promise.all([runner.close(), viewer.close()])
    }
  })
})
