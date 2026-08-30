// @failure CLI projection diverges from installed Yrd capabilities or its documented process contract
// @level l2
// @consumer @yrd/cli

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { Database } from "bun:sqlite"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createLogger, type Event as LoggerEvent, type LogEvent } from "loggily"
import { safeRemoveSync } from "removely"
import {
  createBayJobDefs,
  createDeploymentJobDefs,
  currentChangeRev,
  changeAdmission,
  changeBaseSha,
  changeDeliveryState,
  changeRevisionLineage,
  withBays,
  volatilePrNumberMint,
  withDeployments,
  type BaysState,
  type BayWorkspace,
  type Change,
  type ChangeDeliveryState,
  type ChangeRev,
} from "@yrd/bay"
import {
  runYrd as runYrdRaw,
  type QueueAuditEmission,
  type QueueEnvironmentAuditComparison,
  type QueueEnvironmentAuditEmission,
  type YrdCliIO,
  type YrdCliServices,
} from "@yrd/cli"
import { testQueueReadModel } from "./queue-read-model-test-helper.ts"
import {
  Command,
  createFailure,
  createMemoryJournal,
  createYrd,
  createYrdDef,
  EventSchema,
  JsonSchema,
  pipe,
  type Journal,
  type JsonValue,
} from "@yrd/core"
import { withJobs, type Job, type JobResult } from "@yrd/job"
import { createExclusive, createJournal } from "@yrd/persistence"
import { createProcess, type ProcessRequest, type ProcessResult } from "@yrd/process"
import {
  Queues,
  type Run,
  type QueueSummary,
  type ChangeEligibility,
  type CandidateRefSweepResult,
  candidateRefFor,
  withQueue,
  withMerge,
  withStep,
  type AddStepResult,
  type CandidatePreparer,
  type SourceRewrite,
  type ChangeShape,
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
  type CommitResolver,
  type ContestRunnerDef,
} from "@yrd/contest"
import { fixturePr as timelineFixturePr } from "../dev/queue-timeline-fixtures.ts"
import {
  QueueShowView,
  QueueLogView,
  QueueRunsView,
  ChangeListView,
  ChangeDetailView,
  QueueTimelineView,
  QueueWatchView,
  activeWatchRow,
  humanQueueProjection,
  queueFlowMetrics,
  queueLogAttempts,
  queueLogRows,
  changeListRows,
  queueRevisionKey,
  createQueueTimelineProjectionClock,
  queueRunRevisionKey,
  queueTimelineAdmissionTimes,
  runRevisionClock,
  queueShowData,
  queueStatusRows,
  queueTimelineProjection,
  queueTimelineRows,
  QUEUE_TIMELINE_UNBOUNDED_WINDOW_MS,
  collapseRecomposedSources,
  watchQueueRows,
  type QueueLogCoverage,
  type QueueAttempt,
  type QueueStatusResult,
  type QueueTerminalFact,
  type QueueTimelineProjection,
} from "../src/queue-status-view.tsx"
import { withLiveRenderer } from "../src/live-renderer.ts"
import * as runInternals from "../src/run.ts"
import { MergeAuthorityBoundary } from "../src/merge-authority-boundary.ts"
import { queueStats } from "../src/time-stats.ts"
import { YRD_VERSION } from "../src/version.ts"
import {
  jobAttemptTaskStatusOf,
  changeDeliveryTaskStatusOf,
  runTaskStatusOf,
  stepTaskStatusOf,
  taskStatusGlyph,
} from "../src/task-status.ts"
import { QueueWatchFrame, QueueWatchPane, queueDetailTier, type QueueWatchPaneProps } from "../src/watch-pane.tsx"

/** An explicit EMPTY bays state: no bays, no records, and — the point — no
 * standing submit facts, so these record-lane fixtures assert the record lane
 * alone. The projections require it rather than accepting `undefined`, because
 * an absent state cannot be told from an empty derived lane (23235). */
const NO_BAYS: BaysState = { byId: {}, prs: {}, receipts: {}, submits: {} }

/** A watch snapshot always carries the bays state the projections need
 * (`run.ts` sets it from `state.bays`); saying so loudly beats a fallback that
 * would quietly project the record lane alone. */
function requiredWatchBays(snapshot: Readonly<{ state?: BaysState }>): BaysState {
  if (snapshot.state === undefined) throw new Error("watch snapshot is missing its bays state")
  return snapshot.state
}

const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "1".repeat(40)
const MERGED_SHA = "b".repeat(40)
const PR1640_RECORDED_HEAD = "4d8615400959a1443b1664e707eecee10d6ebe95"
const PR1640_LIVE_HEAD = "b3fae22ec7a08288b586a28b123a9e11ad3bca91"
const PR1640_BRANCH = "task/@yrd/core/22366-post-merge-component-main"
const JOB_PREPARE_PASS_ID = "00000000-0000-7000-8000-000000000101"
const JOB_CHECK_FAILED_ID = "00000000-0000-7000-8000-000000000102"
const JOB_DEPLOY_LOST_ID = "00000000-0000-7000-8000-000000000103"
const JOB_CHECK_PASS_ID = "00000000-0000-7000-8000-000000000104"
const JOB_CHECK_MISSING_ID = "00000000-0000-7000-8000-000000000105"
const sourceRowKey = ["li", "ne"].join("") as `${"li"}${"ne"}`
const retiredRoleNoun = ["act", "or"].join("")

function remergeGitlinkConflictReason(pr: string, targetRoot: string): string {
  return (
    `yrd: change '${pr}' could not recut: target root '${targetRoot}' pins submodule 'km' to '${"c".repeat(40)}'; ` +
    `replayed authored root '${"e".repeat(40)}' pins it to '${"d".repeat(40)}'; ancestry walk failed because ` +
    "neither submodule commit is an ancestor of the other"
  )
}

function remergeBaseDivergedReason(pr: string, targetRoot: string): string {
  return (
    `change '${pr}' revision 2 certifies base '${BASE_SHA}', but the authoritative candidate base is ` +
    `'${targetRoot}', which never descended from it; the certificate cannot become valid without a fresh revision`
  )
}

function revisionAdmissionJob(
  app: Awaited<ReturnType<typeof createApp>>,
  prId: string,
  index = 0,
  stepRevision = "check-v1",
) {
  const pr = app.bays.pr(prId)
  if (pr === undefined) return undefined
  const revision = currentChangeRev(pr)
  const baseSha = pr.checkRequests.at(-1)?.baseSha ?? changeBaseSha(pr) ?? BASE_SHA
  return app.jobs.getByKey(`admission:${pr.id}:${revision.n}:${baseSha}:${index}:${stepRevision}`)
}

function submittedRevision(
  revision: number,
  headSha: string,
  submittedAt: string,
  terminal?: ChangeRev["terminal"],
): ChangeRev {
  return {
    n: revision,
    head: headSha,
    base: "main",
    baseSha: BASE_SHA,
    pushedAt: submittedAt,
    submittedAt,
    ...(terminal === undefined ? {} : { terminal }),
  }
}

function submittedRunClock(run: Run, submittedAt: string) {
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

function currentChangeSnapshot(pr: Change) {
  const revision = currentChangeRev(pr)
  return {
    id: pr.id,
    ...(pr.name === undefined ? {} : { name: pr.name }),
    branch: pr.branch,
    base: revision.base,
    revision: revision.n,
    headSha: revision.head,
    ...(revision.baseSha === undefined ? {} : { baseSha: revision.baseSha }),
    ...(revision.props === undefined ? {} : { props: revision.props }),
    ...(revision.composition === undefined ? {} : { composition: revision.composition }),
  }
}

type CheckedShape = AddStepResult<ChangeShape, "check", JsonValue>
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
  options: {
    dirty?: boolean
    path?: string
    refreshedHead?: string
    probe?: OverlapProbe
    failingBay?: string
    provisions?: Array<Record<string, unknown>>
    provisionedHead?: string
  } = {},
): BayWorkspace {
  return {
    revision: "test-workspace-v1",
    async provision(input) {
      await options.probe?.pause("bay")
      options.provisions?.push({ ...input })
      if (input.bay === options.failingBay) {
        return {
          status: "completed",
          conclusion: "failure",
          error: { code: "provision-failed", message: `failed to provision ${input.bay}` },
        }
      }
      const from = typeof input.from === "string" ? input.from : undefined
      const headSha =
        options.provisionedHead ??
        (from !== undefined && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(from) ? from : HEAD_SHA)
      return {
        status: "completed",
        conclusion: "success",
        output: { path: options.path ?? `/repo/.bays/${input.bay}`, headSha, baseSha: BASE_SHA },
      }
    },
    refresh(input) {
      return {
        status: "completed",
        conclusion: "success",
        output: {
          path: input.path ?? `/repo/.bays/${input.bay}`,
          headSha: options.refreshedHead ?? (input.bay === "B2" ? "2".repeat(40) : HEAD_SHA),
          baseSha: BASE_SHA,
          dirty: options.dirty ?? false,
        },
      }
    },
    checkpoint() {
      return {
        status: "completed",
        conclusion: "success",
        output: { headSha: options.refreshedHead ?? HEAD_SHA, pushed: true, wip: options.dirty ?? false },
      }
    },
    deprovision() {
      return { status: "completed", conclusion: "success", output: {} }
    },
  }
}

function contestAdapters(probe?: OverlapProbe, baseResolutions?: string[], waitingEvaluator?: string) {
  const pins = new Map<string, string>()
  const runner: ContestRunnerDef = {
    id: "fixture",
    revision: "fixture-runner-v1",
    async run(input): Promise<JobResult<AttemptRunOutput>> {
      await probe?.pause("runner")
      const commit = input.competitor.id === "fast" ? "c".repeat(40) : "d".repeat(40)
      const ref = `refs/yrd/attempts/${input.contest}/${input.attempt}`
      pins.set(ref, commit)
      return {
        status: "completed",
        conclusion: "success",
        output: {
          pin: { commit, ref, bay: input.bay.id, branch: input.bay.branch, baseSha: BASE_SHA },
          wallTimeMs: input.competitor.id === "fast" ? 100 : 120,
          tokens: { input: 10, output: 4, cachedInput: 2, cacheWrite: 0, reasoning: 1 },
          cost: { kind: "reported", usd: 0.01, source: "fixture" },
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
      return { status: "completed", conclusion: "success", output: { verdict: "passed", artifacts: [] } }
    },
  }
  const git: CommitResolver = {
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
    waitingCheck?: boolean | ((input: StepExecution<ChangeShape>) => boolean)
    dirtyBay?: boolean
    bayPath?: string
    failingBay?: string
    refreshedHead?: string
    probe?: OverlapProbe
    provisions?: Array<Record<string, unknown>>
    provisionedHead?: string
    baseResolutions?: string[]
    batch?: false | number
    waitingEvaluator?: string
    mergeRuns?: string[]
    mergeRevision?: string
    failingCheck?: boolean
    checkFailure?: Readonly<{ code: string; message: string; artifact?: string }>
    requires?: readonly ["review"]
    checkRuns?: string[]
    checkedRevisions?: string[]
    baseFailure?: boolean
    clock?: () => string
    mergeCommits?: readonly string[]
    mergeAlreadyLanded?: Readonly<{
      candidateSha: string
      candidateTreeSha: string
      baseTreeSha: string
    }>
    mergeWait?: Readonly<{ started: () => void; until: Promise<void> }>
    sourceRewrites?: readonly SourceRewrite[]
    journal?: Journal<unknown>
    id?: () => string
    log?: ReturnType<typeof createLogger>
    prepareCandidate?: CandidatePreparer
    resolveBaseSha?: (base: string) => string | Promise<string>
  } = {},
) {
  const contest = contestAdapters(options.probe, options.baseResolutions, options.waitingEvaluator)
  const bayJobs = createBayJobDefs(
    workspace({
      dirty: options.dirtyBay,
      path: options.bayPath,
      failingBay: options.failingBay,
      refreshedHead: options.refreshedHead,
      probe: options.probe,
      provisions: options.provisions,
      provisionedHead: options.provisionedHead,
    }),
  )
  const deploymentJobs = createDeploymentJobDefs({
    materialize: async (input) => ({
      ...input,
      path: `/repo/.deployments/${input.deploymentId}`,
      verification: "verified" as const,
      dirty: false as const,
      loadedAt: "2026-07-09T12:00:00.000Z",
      submodules: [],
    }),
    reap: async (input) => ({ reaped: true as const, path: `/repo/.deployments/${input.deploymentId}` }),
    release: async (input) => ({ released: true as const, path: input.path }),
  })
  const check = withStep(
    "check",
    (input: StepExecution<ChangeShape>): JobResult<JsonValue> => {
      options.checkRuns?.push("check")
      options.checkedRevisions?.push(...input.prs.map((pr) => `${pr.id}@${pr.revision}`))
      const waiting =
        typeof options.waitingCheck === "function" ? options.waitingCheck(input) : options.waitingCheck === true
      return waiting
        ? {
            status: "waiting",
            token: "remote-check",
            url: "https://ci.invalid/run/1",
            checkpoint: { baseSha: BASE_SHA, candidateSha: HEAD_SHA },
          }
        : options.baseFailure
          ? {
              status: "completed",
              conclusion: "failure",
              error: { code: "base-red", message: "resolved base is red" },
              output: { detail: `[yrd-base-health] base ${BASE_SHA.slice(0, 12)} is red: test:fast failed` },
            }
          : options.checkFailure !== undefined
            ? {
                status: "completed",
                conclusion: "failure",
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
                  status: "completed",
                  conclusion: "failure",
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
              : { status: "completed", conclusion: "success", output: { checked: true } }
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
    ): Promise<
      JobResult<{
        commit: string
        baseSha: string
        alreadyLanded?: Readonly<{ candidateSha: string; candidateTreeSha: string; baseTreeSha: string }>
        sourceRewrites?: readonly SourceRewrite[]
      }>
    > => {
      options.mergeRuns?.push("merge")
      options.mergeWait?.started()
      if (options.mergeWait !== undefined) await options.mergeWait.until
      const commit = options.mergeCommits?.[mergeIndex++] ?? MERGED_SHA
      return {
        status: "completed",
        conclusion: "success",
        output: {
          commit,
          baseSha: commit,
          ...(options.mergeAlreadyLanded === undefined ? {} : { alreadyLanded: options.mergeAlreadyLanded }),
          ...(options.sourceRewrites === undefined ? {} : { sourceRewrites: options.sourceRewrites }),
        },
      }
    },
    { revision: options.mergeRevision ?? "merge-v1" },
  )
  // ONE mint for both plugins, as production wires it (S6): bays numbers its
  // records from it, and the queue mints derived-member identities from the
  // same monotone sequence when a selectorless compose admits a submit fact.
  const prNumberMint = volatilePrNumberMint()
  const queue = withQueue({
    steps: [check, merge] as const,
    batch: options.batch ?? false,
    prNumberMint,
    ...(options.requires === undefined ? {} : { requires: options.requires }),
    ...(options.prepareCandidate === undefined ? {} : { prepareCandidate: options.prepareCandidate }),
    // A derived member carries no baseSha of its own: tests that drain the
    // derived lane pass `resolveBaseSha: () => BASE_SHA` (production wires the
    // git resolver here). Not defaulted — a standing resolver re-targets
    // record check requests, which the moving-base habitant tests must own.
    ...(options.resolveBaseSha === undefined ? {} : { resolveBaseSha: options.resolveBaseSha }),
  })
  const contests = withContests({ runners: [contest.runner], evaluators: [contest.evaluator], git: contest.git })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs, contests.jobDefs, deploymentJobs] }),
    withDeployments({ jobs: deploymentJobs }),
    withIssues({ sources: [{ id: "km", resolve: (ref) => ({ ref, title: "Issue one" }) }] }),
    withBays({
      prNumberMint,
      jobs: bayJobs,
      defaultBase: "main",
      resolveBase: (base) => ({ base, baseSha: BASE_SHA }),
    }),
  )
  return createYrd(contests(queue(base)), {
    inject: {
      journal: options.journal ?? createMemoryJournal(),
      clock: options.clock ?? (() => "2026-07-09T12:00:00.000Z"),
      id: options.id ?? ids(),
      // Match production DI (host.ts injects the CLI logger). Without this the
      // app falls back to createLogger("yrd") — loggily's default console
      // transport — and incidental warn/error lifecycle logs (yrd:jobs,
      // yrd:queue) leak to console.error, tripping km's setup.ts console-output
      // gate. Silent because these tests assert on io.stdout/stderr, not logs.
      log: options.log ?? createLogger("yrd", [{ level: "silent" }]),
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
    implementationSource: `git:${"1".repeat(40)}`,
    now: () => Date.parse("2026-07-09T12:01:00.000Z"),
    // Linear by default: the linear-root gate reads parent counts on the
    // active-Bay and ready entrances; merge-tip scenarios override this.
    parents: async () => ["0".repeat(40)],
    ...overrides,
  }
  return { io, stdout: () => stdout, stderr: () => stderr }
}

function fixtureAdmissionOrder(prs: readonly Change[]): string[] {
  return prs
    .filter((pr) => {
      const state = changeDeliveryState(pr)
      return state === "submitted" || state === "ready"
    })
    .map((pr) => pr.id)
}

function remergeIO(app: TestApp, selector = "PR1", overrides: Partial<YrdCliIO> = {}) {
  const pr = app.bays.pr(selector)
  if (pr === undefined) throw new Error(`missing ${selector}`)
  const recorded = changeRevisionLineage(pr)[0]
  if (recorded === undefined) throw new Error(`missing ${selector} source lineage`)
  return outputIO({
    pruneGit: () => ({
      resolveCommit: (ref) => (ref === `origin/${pr.branch}` || ref === pr.branch ? recorded.head : undefined),
      isAncestor: () => false,
      mergeTree: () => undefined,
      treeOf: () => recorded.head,
    }),
    ...overrides,
  })
}

function yrd(...args: string[]): string[] {
  return ["/usr/bin/bun", "/repo/bin/yrd.ts", ...args]
}

function completePathReapResult() {
  return {
    targetedPids: [],
    survivorPids: [],
    survivorHolders: [],
    survivorCoverage: { platform: "darwin" as const, mechanism: "lsof" as const, complete: true as const },
    forcedKill: false,
    signalFailures: [],
  }
}

function runYrd(
  app: Parameters<typeof runYrdRaw>[0],
  argv: readonly string[],
  io: YrdCliIO,
  services: YrdCliServices = {},
) {
  return runYrdRaw(app, argv, io, {
    queueReadModel: testQueueReadModel(app),
    checks: {
      names: [],
      run: async () => ({ stdout: "", stderr: "", exitCode: 0, signal: null, durationMs: 0, timedOut: false }),
      install: async () => "/repo/.git/yrd/hooks/pre-submit",
    },
    process: {
      // The pre-admission gitlink gate asks Git where the branch diverged from
      // its base. Answering that with silence, as this stub answers everything
      // else, claims the repository has no shared history — which the gate
      // refuses rather than guess at. Give it one plausible merge base.
      run: async (request) => {
        const target = request.argv.find((arg) => arg.startsWith("refs/remotes/origin/") && arg.endsWith("^{commit}"))
        const branch = target?.slice("refs/remotes/origin/".length, -"^{commit}".length)
        const observed = branch === undefined ? undefined : app.bays.pr(branch)
        return {
          stdout: request.argv.includes("merge-base")
            ? `${"0".repeat(39)}1\n`
            : observed === undefined
              ? ""
              : `${currentChangeRev(observed).head}\n`,
          stderr: "",
          exitCode: 0,
          signal: null,
          durationMs: 0,
          timedOut: false,
        }
      },
      reapPath: async () => completePathReapResult(),
    },
    ...services,
  })
}

function yrdBay(...args: string[]): string[] {
  return yrd("bay", ...args)
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

function contestCompetitors(): string {
  return JSON.stringify([
    { id: "fast", runner: "fixture", config: { profile: "fast" } },
    { id: "thorough", runner: "fixture", config: { profile: "thorough" } },
  ])
}

async function openAndSubmit(app: TestApp): Promise<void> {
  await openTestBay(app, { name: "one" })
  await submitBayFixture(app, "B1")
}

async function submitBayFixture(app: TestApp, bay: string): Promise<void> {
  // Domain fixture: callers below explicitly control check-request and Queue
  // timing. Public `bay submit` owns the synchronous handoff behavior proved
  // by its focused regression instead of silently changing these fixtures.
  const bayResult = await app.bays.submitSelection(bay, {
    resolveRevision: async () => undefined,
    resolveParents: async () => ["0".repeat(40)],
    run: { runner: "cli-test", leaseMs: 60_000 },
  })
  if ("lane" in bayResult) throw new Error("expected a record-lane Change from a bay submit")
  expect(changeDeliveryState(bayResult)).toBe("submitted")
}

async function openTestBay(app: TestApp, input: Parameters<TestApp["bays"]["open"]>[0]): Promise<void> {
  const opened = await app.bays.open({ ...input, by: input.by ?? "test" })
  const jobs = await app.jobs.runMany(app.jobs.requested(opened), {
    runner: "cli-test",
    leaseMs: 60_000,
  })
  expect(jobs.every((job) => job.status === "completed" && job.conclusion === "success")).toBe(true)
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
  checkpoint?: JsonValue
  error?: { code: string; message: string; evidence?: JsonValue }
  output?: JsonValue
  artifacts?: readonly JsonValue[]
  lostReason?: string
}): Job {
  const base = {
    id: input.id,
    definition: "queue.step",
    revision: "test-v1",
    input: {},
    attempt: input.attempt ?? 1,
    requestedAt: input.requestedAt ?? "2026-07-09T12:00:00.000Z",
    changedAt: input.requestedAt ?? "2026-07-09T12:00:00.000Z",
  } as const
  const execution = {
    startedAt: input.startedAt ?? "2026-07-09T12:00:00.000Z",
    runner: "queue-test",
  } as const
  const evidence = {
    ...(input.url === undefined ? {} : { url: input.url }),
    ...(input.detail === undefined ? {} : { detail: input.detail }),
    ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
    ...(input.checkpoint === undefined ? {} : { checkpoint: input.checkpoint }),
  }
  switch (input.status) {
    case "requested":
      return { ...base, status: "queued" }
    case "running":
      return {
        ...base,
        ...execution,
        status: "in_progress",
        leaseExpiresAt: "2026-07-09T12:00:10.000Z",
      }
    case "waiting":
      return { ...base, ...execution, ...evidence, status: "waiting", token: "run-job" }
    case "passed":
      return {
        ...base,
        ...execution,
        ...evidence,
        status: "completed",
        conclusion: "success",
        finishedAt: input.finishedAt ?? "2026-07-09T12:00:02.000Z",
        output: input.output ?? {},
      }
    case "failed":
      return {
        ...base,
        ...execution,
        ...evidence,
        status: "completed",
        conclusion: "failure",
        finishedAt: input.finishedAt ?? "2026-07-09T12:00:03.000Z",
        output: input.output ?? {},
        error: input.error ?? { code: "check-failed", message: "failed" },
      }
    case "lost":
      return {
        ...base,
        ...execution,
        status: "completed",
        conclusion: "timed_out",
        finishedAt: input.finishedAt ?? "2026-07-09T12:00:04.000Z",
        lostReason: input.lostReason ?? "lost while running",
      }
  }
}

function fakeStep(name: string, status: Parameters<typeof fakeJob>[0]["status"], job: Run["steps"][number]["job"]) {
  return {
    name,
    title: `${name} test step`,
    revision: "step-v1",
    kind: name === "merge" ? ("merge" as const) : ("check" as const),
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
}): Run {
  const startedAt = input.startedAt
  const base = {
    id: input.id,
    queueId: `Q:${input.base ?? "main"}`,
    candidateId: `C:${input.id}`,
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
    jobs: input.steps.flatMap((step) => (step.job === undefined ? [] : [step.job.id])),
    steps: input.steps,
    startedAt,
    cursor: 0,
    integration: input.integration,
    shape: {
      results: {},
      ...(input.integration === undefined ? {} : { integration: input.integration }),
    },
    ...(input.parent === undefined ? {} : { parent: input.parent }),
    ...(input.isolationPart === undefined ? {} : { isolationPart: input.isolationPart }),
    ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
    ...(input.error === undefined ? {} : { error: input.error }),
  }
  switch (input.status) {
    case "running":
      return { ...base, status: "in_progress" }
    case "waiting":
      return { ...base, status: "waiting" }
    case "passed":
      return { ...base, status: "completed", conclusion: "success" }
    case "failed":
      return { ...base, status: "completed", conclusion: "failure" }
  }
}

function fakeSummary(runs: readonly Run[]): QueueSummary {
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

/** A stubbed plan audit still has to say WHAT IT COMPARED: the emission type
 * makes a denominator-free audit unrepresentable, because a bare
 * `findings: []` reads the same whether nothing drifted or nothing was ever
 * read (23193). Stubs declare one tip with one installed plan and no journal
 * walk unless they say otherwise. */
function stubAuditComparison(base = "main"): QueueEnvironmentAuditComparison {
  return {
    base,
    tip: {
      sha: "1".repeat(40),
      configAuthority: ".yrd.yml",
      configBlobSha: "2".repeat(40),
      steps: ["check", "merge"],
      batchSize: 1,
    },
    installed: { source: "this-process", steps: ["check", "merge"], batchSize: 1 },
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

  it("keeps the canonical bay subtree free of internal operations", async () => {
    const app = await createApp()
    const gitHelp = outputIO()
    expect(await runYrd(app, yrdBay("--help"), gitHelp.io)).toBe(0)
    expect(gitHelp.stdout()).toContain("Usage: yrd bay")
    expect(gitHelp.stdout()).toContain("list")
    expect(gitHelp.stdout()).toContain("open")
    expect(gitHelp.stdout()).toContain("in")
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
    { name: "yrd pr", argv: yrd("pr", "submit", "topic/draft", "--draft", "--json") },
    { name: "yrd bay", argv: yrd("bay", "submit", "topic/draft", "--draft", "--json") },
    { name: "yrd bay", argv: yrdBay("submit", "topic/draft", "--draft", "--json") },
  ])("rejects the deleted --draft flag through $name and teaches pr create", async ({ argv }) => {
    const app = await createApp()
    const output = outputIO({ resolveRevision: () => Promise.resolve(HEAD_SHA) })

    expect(await runYrd(app, argv, output.io)).toBe(2)
    expect(output.stderr()).toContain("unknown option '--draft'")
    expect(output.stderr()).toContain("yrd pr create")
    expect(app.bays.prs()).toEqual([])
  })

  it("bay submit of a recordless branch cannot strand a queued record: the fact is the whole write (PR1128)", async () => {
    const app = await createApp()
    // A process layer whose git always fails: the pre-admission pin gate can
    // resolve nothing. Pre-purge, bay submit staged a draft record so that
    // refusal could fire BEFORE the real submit (PR1128: refusing after it
    // stranded a SUBMITTED PR with no check request, the state that wedged
    // every queue read on 2026-08-17). The legacy record mint is retired: a
    // recordless branch writes only the branch-submit FACT, and admission
    // gating moved to queue compose — there is no record-shaped intermediate
    // state left to strand, so the submit succeeds and compose owns the gates.
    const services = {
      process: {
        run: async () => ({ stdout: "", stderr: "", exitCode: 1, signal: null, durationMs: 0, timedOut: false }),
        reapPath: async () => completePathReapResult(),
      },
    } as unknown as YrdCliServices
    const output = outputIO({ resolveRevision: () => Promise.resolve(HEAD_SHA) })

    expect(await runYrd(app, yrd("bay", "submit", "topic/wedge", "--json"), output.io, services), output.stderr()).toBe(
      0,
    )
    expect(JSON.parse(output.stdout())).toMatchObject({
      command: "bay.submit",
      prs: [],
      derived: [{ lane: "derived", branch: "topic/wedge", sha: HEAD_SHA, base: "main" }],
    })
    // The fact is the submission: no record, no check request, no refusal row.
    expect(app.bays.prs()).toEqual([])
    expect(app.bays.state().submits["topic/wedge"]).toMatchObject({ sha: HEAD_SHA, base: "main" })
    expect(app.state().queues.admissionRefusals).toEqual({})
    // And the queue still reads clean end to end.
    const audit = outputIO()
    expect(await runYrd(app, yrd("queue", "audit", "--json"), audit.io), audit.stderr()).toBe(0)
  })

  it("derives the deleted --draft remedy from the failing command instead of raw argv", async () => {
    const app = await createApp()
    const prefixed = outputIO({ resolveRevision: () => Promise.resolve(HEAD_SHA) })

    expect(
      await runInternals.runYrdHelp(
        yrd("--repo", "/tmp", "pr", "submit", "topic/draft", "--draft", "--json"),
        prefixed.io,
      ),
    ).toBe(2)
    expect(JSON.parse(prefixed.stderr())).toMatchObject({
      failure: {
        cause: "unknown option '--draft'",
        resolution: ["yrd pr create"],
      },
    })

    const optionValue = outputIO({ resolveRevision: () => Promise.resolve(HEAD_SHA) })
    expect(await runYrd(app, yrd("pr", "submit", "topic/draft", "--title", "--draft", "--bogus"), optionValue.io)).toBe(
      2,
    )
    expect(optionValue.stderr()).toContain("unknown option '--bogus'")
    expect(optionValue.stderr()).not.toContain("yrd pr create")
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
    expect(queueHelp).not.toMatch(/^\s+(?:init|deinit|provision|deprovision)\b/mu)
    expect(queueHelp).toMatch(/^Examples:\n\s+\$ yrd queue\b/mu)

    // `admin queue init/deinit` are retired (23192/23193): still routable so an
    // old runbook gets the reason, never advertised.
    const adminQueue = outputIO({ columns: 100 })
    expect(await runYrd(app, yrd("admin", "queue", "--help"), adminQueue.io)).toBe(0)
    expect(adminQueue.stdout()).toContain("retired queue administration")
    expect(adminQueue.stdout()).not.toMatch(/^\s+(?:init|deinit)\b/mu)

    // `queue recover` is retired (5e cut 6): still routable so an old runbook
    // gets the reason and the standing rails, never a silent timeline filter.
    const recover = outputIO()
    expect(await runYrd(app, yrd("queue", "recover", "--json"), recover.io)).toBe(1)
    expect(recover.stderr()).toContain("queue-recover-retired")
    expect(recover.stderr()).toContain("Restart re-derives it")
  })

  it("names the question and tense of every pr list status vocabulary", async () => {
    const app = await createApp()
    const help = outputIO({ columns: 120 })

    expect(await runYrd(app, yrd("pr", "list", "--help"), help.io), help.stderr()).toBe(0)
    expect(help.stdout()).toContain("state — answers: is the change record open or closed? tense: current")
    expect(help.stdout()).toContain("status — answers: what delivery result should a reader act on? tense: current")
    expect(help.stdout()).toContain(
      "nativeStatus — answers: what delivery status did the rebuildable index record? tense: historical",
    )
    expect(help.stdout()).toContain(
      "taskStatus — answers: how does this delivery map to the shared work-state vocabulary? tense: current",
    )
    expect(help.stdout()).toContain(
      "eligibility.reason.code — answers: why can the current revision not run now? tense: current",
    )
    expect(help.stdout()).toContain(
      "mergedOnBase.code — answers: why did repository proof override nativeStatus? tense: current",
    )
    expect(help.stdout()).toContain(
      "--state needs-author — answers: does this change currently need author action? tense: current",
    )
  })

  it("materializes immutable deployments through a keyed Journal Job", async () => {
    const app = await createApp()
    const output = outputIO()
    const generation = "@dev/1#generation-1.attempt-1"

    expect(
      await runYrd(
        app,
        yrd("deployment", "materialize", "D1", generation, HEAD_SHA, "--pin", "tip", "--json"),
        output.io,
      ),
      output.stderr(),
    ).toBe(0)

    expect(JSON.parse(output.stdout())).toMatchObject({
      command: "deployment.materialize",
      result: {
        deploymentId: "D1",
        generation,
        path: "/repo/.deployments/D1",
        sha: HEAD_SHA,
        pin: "tip",
      },
    })
    expect(app.jobs.getByKey("deployment:D1:materialize")).toMatchObject({
      definition: "deployment.materialize",
      status: "completed",
      conclusion: "success",
    })
  })

  it("releases only when the strict Hab service-generation result names the exact deployment source", async () => {
    const app = await createApp()
    const temp = mkdtempSync(join(tmpdir(), "yrd-deployment-release-"))
    const deploymentResult = join(temp, "deployment.json")
    const habReleaseResult = join(temp, "hab-release.json")
    const generation = "@dev/1#generation-1.attempt-1"
    const path = "/repo/.deployments/D1"
    writeFileSync(
      deploymentResult,
      JSON.stringify({
        deploymentId: "D1",
        generation,
        path,
        sha: HEAD_SHA,
        verification: "verified",
        dirty: false,
        loadedAt: "2026-07-09T12:00:00.000Z",
        pin: "tip",
        submodules: [],
      }),
    )
    writeFileSync(
      habReleaseResult,
      JSON.stringify({
        schema: "hab-service-generation-release/1",
        jurisdiction: "single-habitat",
        habitatRoot: "/hab",
        retiredSource: { path, sha: HEAD_SHA, verification: "verified" },
        replacementSource: { path: "/repo/.deployments/D2", sha: "2".repeat(40), verification: "verified" },
        releasedAt: "2026-08-11T20:00:00.000Z",
      }),
    )
    try {
      const output = outputIO()
      expect(
        await runYrd(app, yrd("deployment", "release", deploymentResult, habReleaseResult, "--json"), output.io),
        output.stderr(),
      ).toBe(0)
      expect(JSON.parse(output.stdout())).toMatchObject({
        command: "deployment.release",
        output: { released: true, path },
      })
      expect(app.jobs.getByKey("deployment:D1:release")).toMatchObject({
        definition: "deployment.release",
        status: "completed",
        conclusion: "success",
      })

      writeFileSync(
        habReleaseResult,
        JSON.stringify({
          schema: "hab-service-generation-release/1",
          jurisdiction: "single-habitat",
          habitatRoot: "/hab",
          retiredSource: { path, sha: HEAD_SHA, verification: "verified" },
          replacementSource: { path: "/repo/.deployments/D3", sha: "3".repeat(40), verification: "verified" },
          releasedAt: "2026-08-11T20:01:00.000Z",
        }),
      )
      const retry = outputIO()
      expect(
        await runYrd(app, yrd("deployment", "release", deploymentResult, habReleaseResult, "--json"), retry.io),
        retry.stderr(),
      ).toBe(0)
      expect(JSON.parse(retry.stdout())).toMatchObject({
        command: "deployment.release",
        output: { released: true, path },
      })
    } finally {
      safeRemoveSync(temp, { within: tmpdir(), allowMissing: true })
    }
  })

  it("exposes the locked noun-cutover surface and teaches that only the queue merges", async () => {
    const app = await createApp()
    const root = outputIO({ columns: 100 })
    expect(await runYrd(app, yrd("--help"), root.io)).toBe(0)
    expect(root.stdout()).toContain("Pick an issue")
    for (const command of ["pr", "bay", "issue", "contest", "deployment", "queue", "check", "admin", "log", "watch"]) {
      expect(root.stdout()).toMatch(new RegExp(`^\\s+${command}\\b`, "mu"))
    }
    const retiredQueueNoun = ["li", "ne"].join("")
    const retiredIssueNoun = ["ta", "sk"].join("")
    const retiredVerbs = [["inte", "grate"].join(""), ["ho", "ld"].join(""), ["re", "lease"].join("")]
    for (const removed of [retiredQueueNoun, retiredIssueNoun, ...retiredVerbs]) {
      expect(root.stdout()).not.toMatch(new RegExp(`^\\s+${removed}\\b`, "mu"))
    }

    const queue = outputIO()
    expect(await runYrd(app, yrd("queue", "--help"), queue.io)).toBe(0)
    for (const command of ["run", "pause", "resume", "finish", "audit"]) {
      expect(queue.stdout()).toMatch(new RegExp(`^\\s+${command}\\b`, "mu"))
    }
    const queueRun = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "--help"), queueRun.io)).toBe(0)
    expect(queueRun.stdout()).not.toContain("--retry")

    const adminInit = outputIO()
    expect(await runYrd(app, yrd("admin", "init", "--help"), adminInit.io)).toBe(0)
    expect(adminInit.stdout()).not.toContain("--refresh-comments")

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

    const retiredDo = outputIO()
    expect(await runYrd(app, yrd("do", "@tracker/fix-release"), retiredDo.io)).toBe(2)
    expect(retiredDo.stdout()).toBe("")
    expect(retiredDo.stderr()).toContain("unknown command 'do'")

    const retiredAg = outputIO()
    expect(await runYrd(app, yrd("ag", "@tracker/fix-release"), retiredAg.io)).toBe(2)
    expect(retiredAg.stdout()).toBe("")
    expect(retiredAg.stderr()).toContain("unknown command 'ag'")

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

  it("keeps JSON discriminators faithful for a direct-branch submit routed to the derived lane", async () => {
    // The legacy record mint is retired: a recordless direct branch submits as
    // a FACT and the envelope's `derived` rows are the acceptance. The record
    // half of the old test (pr status / pr checkout resolving a direct-branch
    // PR) died with the mint — no record exists for those surfaces to find.
    const app = await createApp()
    const submit = outputIO({ resolveRevision: async () => HEAD_SHA })
    expect(
      await runYrd(app, yrd("pr", "submit", "topic/direct", "--base", "main", "--json"), submit.io),
      submit.stderr(),
    ).toBe(0)
    expect(JSON.parse(submit.stdout())).toMatchObject({
      command: "pr.submit",
      prs: [],
      derived: [{ lane: "derived", branch: "topic/direct", sha: HEAD_SHA, base: "main" }],
    })
    expect(app.bays.state().submits["topic/direct"]).toMatchObject({ sha: HEAD_SHA, base: "main" })
    expect(await app.queue.history()).toEqual([])

    const queue = outputIO()
    expect(await runYrd(app, yrd("queue", "list", "--json"), queue.io), queue.stderr()).toBe(0)
    const queuePayload = JSON.parse(queue.stdout()) as {
      projection: { rows: readonly Readonly<{ pr: string; revision: number; status: string }>[] }
      results: readonly Readonly<{
        running: readonly unknown[]
        waiting: readonly unknown[]
        finished: readonly unknown[]
      }>[]
    }
    // Nothing composed yet: no record row, no run — and the submitted branch
    // stays loudly visible as the queue's own pending unrecorded-submit row.
    expect(queuePayload.projection.rows).toEqual([])
    expect(
      queuePayload.results.flatMap((result) => [...result.running, ...result.waiting, ...result.finished]),
    ).toEqual([])
    expect(await app.queue.unrecordedSubmits()).toMatchObject([{ branch: "topic/direct", sha: HEAD_SHA }])

    // A same-head resubmit is an idempotent fact renewal, same envelope shape.
    const resubmit = outputIO({ resolveRevision: async () => HEAD_SHA })
    expect(
      await runYrd(app, yrd("pr", "submit", "topic/direct", "--base", "main", "--json"), resubmit.io),
      resubmit.stderr(),
    ).toBe(0)
    expect(JSON.parse(resubmit.stdout())).toMatchObject({
      prs: [],
      derived: [{ lane: "derived", branch: "topic/direct", sha: HEAD_SHA, base: "main" }],
    })
    expect(await app.queue.history()).toEqual([])

    const dashboard = outputIO()
    expect(await runYrd(app, yrd("--json"), dashboard.io), dashboard.stderr()).toBe(0)
    expect(JSON.parse(dashboard.stdout())).toMatchObject({ command: "dashboard" })
  })

  it("refuses a submit into a repository that declares no merge authority", async () => {
    // A repository whose queue will never be driven accepted two carriers on
    // 2026-08-05, printed `submitted`, and passed their checks. They sat ready
    // for an hour looking byte-identical to work that would merge. The failure
    // was knowable at the call and instead became a mystery an hour later.
    //
    // The discriminator has to be DECLARED, and that is not a preference. The
    // repository in that incident had terminalAttempts=0 and earliestFactMs=null
    // — it genuinely WAS a brand-new queue, indistinguishable in its own state
    // from one whose runner is about to be armed. No predicate over queue
    // history separates them, so `merge:` says out loud what cannot be
    // inferred. Absent, it is "expected", which is why every other test here
    // (and every repository that has never heard of the key) is unaffected.
    const repo = mkdtempSync(join(tmpdir(), "yrd-merge-authority-"))
    try {
      const submitInto = async (yml: string | undefined, authoritativeMerge?: "expected" | "none") => {
        if (yml === undefined) rmSync(join(repo, ".yrd.yml"), { force: true })
        else writeFileSync(join(repo, ".yrd.yml"), yml)
        const app = await createApp()
        const output = outputIO({ cwd: repo, resolveRevision: async () => HEAD_SHA })
        const services = {
          base: "main",
          ...(authoritativeMerge === undefined ? {} : { [MergeAuthorityBoundary]: authoritativeMerge }),
        }
        const code = await runYrd(
          app,
          yrd("pr", "submit", "topic/direct", "--base", "main", "--json"),
          output.io,
          services,
        )
        return { code, ...output }
      }

      const refused = await submitInto("merge: none\n")
      expect(refused.code, refused.stderr()).toBe(1)
      expect(refused.stdout()).toBe("")
      // The message has to carry BOTH facts or it relocates the mystery instead
      // of ending it: WHICH repository, and that nothing will ever pick this up.
      expect(refused.stderr()).toContain(repo)
      expect(refused.stderr()).toContain("no merge authority")
      expect(JSON.parse(refused.stderr())).toMatchObject({
        command: "pr.submit",
        failure: { kind: "refusal", code: "no-merge-authority" },
      })

      // ...and a THIRD fact: the cure, in the message itself. Naming the route
      // only in a document is what made this recur — the component-main writer
      // bead closed 2026-08-14, acceptance verified against documents on 08-17,
      // and a seat hit this same wall again on 08-27 because the tool's own
      // refusal still read as a dead end. These assertions are the fence: a
      // future edit may reword the message freely, but it cannot silently strip
      // the two actionable steps back out and stay green.
      const { failure } = JSON.parse(refused.stderr()) as Readonly<{ failure: Readonly<{ message: string }> }>
      // Step 1 — the component's own main is the landing path, by design.
      expect(failure.message).toContain("own main")
      // Step 2 — then the pin advance, submitted from the superproject.
      expect(failure.message).toContain("gitlink bump")
      expect(failure.message).toContain("superproject")
      expect(failure.message).toContain("yrd pr submit")
      // The cure must not be spelled as a raw push to a submodule's branch ref;
      // remedy-banned-actions-guard.test.ts bans that shape across this surface,
      // so the prose above is the deliberate spelling, not an approximation.
      expect(failure.message).not.toMatch(/\bpush\b[^\n]*refs\/heads\//u)

      // The process host has already resolved the selected config from the
      // named base. Mutable worktree bytes cannot override that authority.
      const baseAuthority = await submitInto("merge: expected\n", "none")
      expect(baseAuthority.code, baseAuthority.stderr()).toBe(1)
      expect(JSON.parse(baseAuthority.stderr())).toMatchObject({
        command: "pr.submit",
        failure: { kind: "refusal", code: "no-merge-authority" },
      })

      // Declaring the authority explicitly is the ordinary case and unaffected.
      const declared = await submitInto("merge: expected\n")
      expect(declared.code, declared.stderr()).toBe(0)
      expect(JSON.parse(declared.stdout())).toMatchObject({ command: "pr.submit" })

      // Absent config is the state of every repository that predates this key,
      // and of every other test in this file. It must remain a plain success.
      const silent = await submitInto(undefined)
      expect(silent.code, silent.stderr()).toBe(0)
      expect(JSON.parse(silent.stdout())).toMatchObject({ command: "pr.submit" })
    } finally {
      safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
    }
  })

  it("22358: pr checkout provisions from the recorded head SHA, not the branch name", async () => {
    // Acceptance: bay a change while the author still holds the branch. Branch-name checkout refuses;
    // detached HEAD at the revision head is the immutable candidate @ci needs to gate.
    const mismatched = await createApp({ provisionedHead: "f".repeat(40) })
    await mismatched.bays.submit({
      branch: "topic/held-by-author",
      headSha: HEAD_SHA,
      base: "main",
      baseSha: BASE_SHA,
    })
    const refused = outputIO()
    expect(await runYrd(mismatched, yrd("pr", "checkout", "PR1", "--json"), refused.io)).toBe(1)
    expect(refused.stdout()).toBe("")
    expect(refused.stderr()).toContain(`does not match change 'PR1' revision head ${HEAD_SHA}`)
    expect(refused.stderr()).toContain("yrd bay close pr-pr1")
    expect(refused.stderr()).toContain("yrd pr checkout PR1 --bay pr-pr1")

    const provisions: Array<Record<string, unknown>> = []
    const app = await createApp({ provisions })
    await app.bays.submit({ branch: "topic/held-by-author", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })

    const checkout = outputIO()
    expect(await runYrd(app, yrd("pr", "checkout", "PR1", "--json"), checkout.io), checkout.stderr()).toBe(0)
    const payload = JSON.parse(checkout.stdout()) as Readonly<{
      command: string
      pr: string
      bay: { status: string; headSha?: string }
    }>
    expect(payload).toMatchObject({
      command: "pr.checkout",
      pr: "PR1",
      bay: { status: "active", headSha: HEAD_SHA },
    })
    expect(provisions).toHaveLength(1)
    expect(provisions[0]).toMatchObject({ from: HEAD_SHA })
    expect(provisions[0]?.from).not.toBe("topic/held-by-author")
    expect(app.bays.get("pr-pr1")).toMatchObject({ status: "active", headSha: HEAD_SHA })
  })

  it("Q1: resubmitting a merged branch reports already-merged for the same head and re-enters the derived lane for a new head", async () => {
    const app = await createApp()
    await app.bays.submit({ branch: "topic/merged", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    await app.bays.requestChecks({ pr: "PR1" })
    await app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 })
    expect(changeDeliveryState(app.bays.pr("PR1")!)).toBe("integrated")
    expect(app.bays.pr("PR1")).toMatchObject({ branch: "topic/merged", state: "closed", merged: true })
    const before = await Array.fromAsync(app.events())

    // Same merged head → informational "already merged", exit 0, no new PR, no event.
    const merged = outputIO({ resolveRevision: async () => HEAD_SHA })
    expect(await runYrd(app, yrd("pr", "submit", "topic/merged", "--json"), merged.io), merged.stderr()).toBe(0)
    const mergedOut = JSON.parse(merged.stdout()) as Readonly<{
      prs: readonly { id: string; status: string }[]
      warnings?: readonly string[]
    }>
    expect(mergedOut).toMatchObject({ command: "pr.submit", prs: [{ id: "PR1", status: "integrated" }] })
    expect((mergedOut.warnings ?? []).join("\n")).toContain("already merged as change 'PR1'")
    expect(await Array.fromAsync(app.events())).toEqual(before)

    // New head → derived re-entry (the legacy record mint is retired): the
    // submit fact is the submission, compose keys a fresh derived identity
    // from it on the next queue pass, and the integrated PR1 stays frozen —
    // no reopen, no new record, no hand-made delivery branch.
    const reentry = outputIO({ resolveRevision: async () => "2".repeat(40) })
    expect(await runYrd(app, yrd("pr", "submit", "topic/merged", "--json"), reentry.io), reentry.stderr()).toBe(0)
    expect(JSON.parse(reentry.stdout())).toMatchObject({
      command: "pr.submit",
      prs: [],
      derived: [{ lane: "derived", branch: "topic/merged", sha: "2".repeat(40), base: "main" }],
    })
    expect(app.bays.state().submits["topic/merged"]).toMatchObject({ sha: "2".repeat(40) })
    expect(Object.keys(app.state().bays.prs)).toEqual(["PR1"])
    expect(changeDeliveryState(app.bays.pr("PR1")!)).toBe("integrated")
  })

  it.each([
    {
      surface: "pr view",
      args: ["pr", "view", "pr1", "--json"],
      expected: {
        command: "pr.view",
        pr: { id: "PR1" },
        merge: { outcome: "not-merged", status: "submitted" },
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
      // This row's subject is the SELECTOR, and the canonical row it prints is
      // unchanged. The exit moved because nothing has judged this PR yet, and
      // `pr checks` no longer reads an absent verdict as a pass
      // (@i/10-merge-queue/failed-check-erased).
      exit: 1,
    },
    {
      surface: "pr close",
      args: ["pr", "close", "pr1", "--burn-payload", "--json"],
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
  ])(
    "resolves case-insensitive selectors on $surface and preserves canonical output",
    async ({ args, expected, exit }: { args: readonly string[]; expected: object; exit?: number }) => {
      const app = await createApp()
      await openAndSubmit(app)
      if (args[0] === "log") await app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 })
      const output = outputIO()

      expect(await runYrd(app, yrd(...args), output.io), output.stderr()).toBe(exit ?? 0)
      expect(JSON.parse(output.stdout())).toMatchObject(expected)
    },
  )

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

    const pause = outputIO({ now: () => Date.parse("2026-07-09T12:00:00.000Z") })
    expect(
      await runYrd(
        app,
        yrd("queue", "pause", "MAIN", "--reason", "selector proof", "--for", "30m", "--allow", "pr1", "--json"),
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
  })

  it("refuses the retired admin queue init/deinit verbs by name, never a silent no-op (23192/23193)", async () => {
    // Their one durable effect was installed-baseline.json, the stored plan
    // copy the audit compared against. The file is gone: printing
    // "initialized" without installing anything would be the silent no-op the
    // baseline itself turned out to be, so each verb refuses with the reason
    // and the replacement.
    const app = await createApp()
    for (const [verb, replacements] of [
      ["init", ["yrd admin init", "yrd queue audit"]],
      ["deinit", ["yrd queue audit"]],
    ] as const) {
      const human = outputIO()
      expect(await runYrd(app, yrd("admin", "queue", verb, "main"), human.io)).toBe(1)
      expect(human.stderr()).toContain(`error: admin queue ${verb} is retired and does nothing`)
      expect(human.stderr()).toContain("installed-baseline.json")
      for (const replacement of replacements) expect(human.stderr()).toContain(`resolve: ${replacement}`)
      // The one command the remedy must never name is the retired verb itself.
      expect(human.stderr()).not.toContain(`resolve: yrd admin queue ${verb}`)
      const json = outputIO()
      expect(await runYrd(app, yrd("admin", "queue", verb, "--json"), json.io)).toBe(1)
      expect(JSON.parse(json.stderr())).toMatchObject({
        failure: { kind: "refusal", code: "queue-administration-retired", resolution: [...replacements] },
      })
    }
    // Retired, not unknown: the verbs stay registered so an old runbook gets
    // the reason, but they no longer advertise themselves.
    const help = outputIO()
    expect(await runYrd(app, yrd("admin", "--help"), help.io)).toBe(0)
    expect(help.stdout()).not.toMatch(/^\s+queue\b/mu)
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
        changeDeliveryTaskStatusOf(status),
      ),
    ).toEqual(["todo", "wip", "blocked", "done", "dropped", "dropped"])
    expect(
      [
        { status: "pending" as const },
        { status: "queued" as const },
        { status: "in_progress" as const },
        { status: "waiting" as const },
        { status: "completed" as const, conclusion: "failure" as const },
        { status: "completed" as const, conclusion: "success" as const },
        { status: "rejected" as const },
        { status: "environment-refused" as const },
        { status: "stale" as const },
        { status: "lost" as const },
        { status: "legacy" as const },
        { status: "refused" as const },
        { status: "integrated" as const },
        { status: "retired" as const },
        { status: "canceled" as const },
      ].map(runTaskStatusOf),
    ).toEqual([
      "todo",
      "todo",
      "wip",
      "wip",
      "blocked",
      "done",
      "blocked",
      "blocked",
      "blocked",
      "blocked",
      "blocked",
      "blocked",
      "done",
      "dropped",
      "dropped",
    ])
    expect(
      [
        fakeJob({ id: "job-queued", status: "requested" }),
        { status: "started" as const },
        fakeJob({ id: "job-running", status: "running" }),
        fakeJob({ id: "job-waiting", status: "waiting" }),
        fakeJob({ id: "job-failed", status: "failed" }),
        fakeJob({ id: "job-lost", status: "lost" }),
        fakeJob({ id: "job-passed", status: "passed" }),
        { status: "superseded" as const },
      ].map(jobAttemptTaskStatusOf),
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
    const projected = (JSON.parse(json.stdout()) as { pr: { taskStatus: string } }).pr
    expect(projected).toMatchObject({ taskStatus: "wip" })

    const human = outputIO({ columns: 120 })
    expect(await runYrd(app, yrd("pr", "view", "PR1"), human.io), human.stderr()).toBe(0)
    expect(human.stdout()).toContain("▢")
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

    const refusal = outputIO()
    expect(await runYrd(app, yrd("pr", "merge", "PR6", "--json"), refusal.io)).toBe(1)
    expect(JSON.parse(refusal.stderr())).toMatchObject({ command: "pr.merge", pr: "PR6", position: 6 })
  })

  // Deliberately crosses both 8-bit wrap boundaries (256 and 512) through the
  // real journal/projection path; this is a scale correctness test, not a 5s
  // latency contract, and needs headroom on loaded CI hosts.
  // 22376 rewrote this test's human half. It used to assert the window was
  // exactly `header + 20 rows` and nothing else — which is precisely the shape
  // that let `pr list` withhold 500 rows while reading as a complete inventory.
  // The contract now runs in both directions: every windowed row is rendered,
  // AND the count it withheld is on screen.
  it("windows only the unfiltered human PR list, says what it withheld, and never wraps revision counts", async () => {
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
      const text = stripAnsi(human.stdout())
      const physical = text.split("\n").filter((row) => row !== "")
      const rows = physical.filter((row) => /pr#\d+\.\d/u.test(row))
      expect(rows.map((row) => row.match(/pr#(\d+)\.1/u)?.[1])).toEqual(expected.map((id) => id.slice(2)))
      expect(text).toMatch(/500 of 520 rows hidden/u)
      expect(text).toContain("--json")
      expect(physical).not.toContainEqual(expect.stringMatching(/^\s*\d+\s*$/u))
    }

    const json = outputIO()
    expect(await runYrd(app, yrd("pr", "list", "--json"), json.io), json.stderr()).toBe(0)
    const jsonIds = (JSON.parse(json.stdout()) as { prs: readonly Change[] }).prs.map(({ id }) => id)
    expect(jsonIds).toHaveLength(520)
    expect(jsonIds.at(0)).toBe("PR1")
    expect(jsonIds.at(-1)).toBe("PR520")

    const filtered = outputIO({ columns: 120 })
    expect(await runYrd(app, yrd("pr", "list", "--base", "main"), filtered.io), filtered.stderr()).toBe(0)
    const filteredText = stripAnsi(filtered.stdout())
    expect(filteredText.split("\n").filter(Boolean)).toHaveLength(521)
    // An unwindowed projection has nothing to disclose, and must not pretend it does.
    expect(filteredText).not.toMatch(/hidden/u)
  }, 15_000)

  it("executes bare projections with their canonical JSON discriminators", async () => {
    const app = await createApp()
    const surfaces = [
      { args: ["--json"], command: "dashboard" },
      { args: ["queue", "--json"], command: "queue.list" },
      { args: ["pr", "list", "--json"], command: "pr.list" },
      { args: ["issue", "--json"], command: "issue.list" },
      { args: ["log", "--json"], command: "log" },
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
    expect(help.stdout()).toContain("Usage: yrd change|mr [options] [command]")
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

  it("change is the printed family name, mr and pr are ruled aliases, recut is deleted, and publish/ready leave the help surface", async () => {
    const app = await createApp()

    const mrHelp = outputIO({ columns: 100 })
    expect(await runYrd(app, yrd("mr"), mrHelp.io), mrHelp.stderr()).toBe(0)
    expect(mrHelp.stdout()).toContain("Usage: yrd change|mr [options] [command]")
    expect(mrHelp.stdout()).not.toMatch(/^\s{2}recut/mu)
    expect(mrHelp.stdout()).not.toMatch(/^\s{2}publish/mu)
    expect(mrHelp.stdout()).not.toMatch(/^\s{2}ready/mu)

    // A deleted verb has to leave the help SECTIONS too, and the census above
    // cannot see them: it matches the two-space command list, so an example
    // line ("$ yrd pr recut <PR> --preflight …") kept advertising the verb on
    // `pr create --help` after the verb itself was gone.
    const createHelp = outputIO({ columns: 100 })
    expect(await runYrd(app, yrd("pr", "create", "--help"), createHelp.io), createHelp.stderr()).toBe(0)
    expect(createHelp.stdout()).not.toContain("pr recut")

    // recut is DELETED outright (the queue rebuilds by merge on its own);
    // publish/ready stay hidden-but-answering.
    const goneRecut = outputIO({ columns: 100 })
    expect(await runYrd(app, yrd("mr", "recut", "PR1"), goneRecut.io)).not.toBe(0)
    for (const verb of ["publish", "ready"]) {
      const hidden = outputIO({ columns: 100 })
      expect(await runYrd(app, yrd("mr", verb, "--help"), hidden.io), hidden.stderr()).toBe(0)
      expect(hidden.stdout()).toContain(`Usage: yrd change ${verb}`)
    }

    // The ruled alias routes the family; envelopes keep their stable names.
    const aliasJson = outputIO()
    expect(await runYrd(app, yrd("mr", "list", "--json"), aliasJson.io), aliasJson.stderr()).toBe(0)
    expect(JSON.parse(aliasJson.stdout())).toMatchObject({ command: "pr.list" })
  })

  it("queues ready's authoritative checks without minting a Run", async () => {
    const checkedRevisions: string[] = []
    const app = await createApp({ waitingCheck: true, checkedRevisions })
    await app.bays.submit({
      branch: "topic/habitant-ready",
      headSha: HEAD_SHA,
      base: "main",
      draft: true,
    })

    const ready = outputIO({ habitantLeaseHeld: () => Promise.resolve(true) })
    expect(await runYrd(app, yrd("pr", "ready", "PR1", "--json"), ready.io), ready.stderr()).toBe(0)

    expect(checkedRevisions).toEqual([])
    expect(app.queue.checks(["PR1"])).toMatchObject([{ pr: "PR1", revision: 1, status: "queued" }])
    expect(Queues.ids(app.state().queues)).toEqual([])
    expect(app.bays.checksRequested("PR1")).toBe(true)
  })

  it("run cancel re-queues a waiting run's PRs (submitted), not rejected (#59)", async () => {
    const app = await createApp({ waitingCheck: true })
    await openAndSubmit(app)
    // Drain PR1 into a habitant run: the waiting check leaves R1 non-terminal.
    expect(await app.queue.run({ prs: ["PR1"] }, { runner: "cli-test", leaseMs: 60_000 })).toMatchObject([
      { id: "R1", status: "waiting", prs: [{ id: "PR1", revision: 1 }] },
    ])

    const cancel = outputIO()
    expect(await runYrd(app, yrd("run", "cancel", "R1"), cancel.io), cancel.stderr()).toBe(0)
    expect(cancel.stdout()).toContain("re-queued")

    // The run is terminal-canceled and its active check job is aborted...
    expect(app.queue.get("R1")).toMatchObject({ status: "completed", conclusion: "cancelled" })
    expect(app.queue.get("R1")?.steps[0]?.job).toMatchObject({ status: "completed", conclusion: "cancelled" })
    // ...but the member PR is NOT rejected/canceled — it stays submitted, so a
    // future drain re-queues it. That is the cancel-vs-reject distinction.
    expect(changeDeliveryState(app.bays.pr("PR1")!)).toBe("submitted")
    expect(currentChangeRev(app.bays.pr("PR1")!)).toMatchObject({ n: 1 })
    expect(app.queue.eligibility("PR1")).toMatchObject({ runnable: true })

    // A recovery pass reconciles runs whose active job is terminal (the canceled
    // check job qualifies). The canceled run must STAY inert here — recovery must
    // not turn a cancel into a pr/canceled and strip PR1 out of the queue. This is
    // the load-bearing guard: without it, recovery rejects/cancels the member PR.
    await app.queue.recover({ recoveryTime: "2026-07-09T12:05:00.000Z", reason: "habitant restart" })
    expect(changeDeliveryState(app.bays.pr("PR1")!)).toBe("submitted")
    expect(currentChangeRev(app.bays.pr("PR1")!)).toMatchObject({ n: 1 })

    // Prove the re-queue: a fresh drain admits PR1 into a NEW run, not R1.
    const redrain = await app.queue.run({ prs: ["PR1"] }, { runner: "cli-test", leaseMs: 60_000 })
    expect(redrain.some((run) => run.id !== "R1" && run.prs.some((member) => member.id === "PR1"))).toBe(true)
  })

  it("queue cancel refuses a terminal run (#59)", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    // Drain PR1 to completion: R1 is terminal (passed/integrated), not cancelable.
    expect(await runYrd(app, yrd("queue", "run", "--once", "--json"), outputIO().io)).toBe(0)
    const cancel = outputIO()
    expect(await runYrd(app, yrd("queue", "cancel", "R1"), cancel.io)).not.toBe(0)
    expect(cancel.stderr()).toContain("only a running or waiting run")
  })

  it("collapseRecomposedSources states a run of unchanged rebuilds and leaves a healthy carrier alone", () => {
    const frozen = "3".repeat(40)
    const other = "4".repeat(40)

    // PR537 in miniature: one real change, then a run that changed nothing.
    expect(
      collapseRecomposedSources([
        { repo: ".", fromHeadSha: other, toHeadSha: frozen },
        ...Array.from({ length: 5 }, () => ({ repo: ".", fromHeadSha: frozen, toHeadSha: frozen })),
      ]),
    ).toEqual([`. ${other.slice(0, 12)}→${frozen.slice(0, 12)}`, `. ${frozen.slice(0, 12)} ×5 unchanged`])

    // PR645 and PR673 in miniature: content moves every recut, so there is no
    // run to collapse and the line renders exactly as it did before.
    const a = "a".repeat(40)
    const b = "b".repeat(40)
    const c = "c".repeat(40)
    expect(
      collapseRecomposedSources([
        { repo: ".", fromHeadSha: a, toHeadSha: b },
        { repo: ".", fromHeadSha: b, toHeadSha: c },
      ]),
    ).toEqual([`. ${a.slice(0, 12)}→${b.slice(0, 12)}`, `. ${b.slice(0, 12)}→${c.slice(0, 12)}`])

    // A single unchanged rebuild is still named, without a misleading "×1".
    expect(collapseRecomposedSources([{ repo: ".", fromHeadSha: frozen, toHeadSha: frozen }])).toEqual([
      `. ${frozen.slice(0, 12)} unchanged`,
    ])

    // Two repos never merge into one run, even with identical fingerprints.
    expect(
      collapseRecomposedSources([
        { repo: ".", fromHeadSha: frozen, toHeadSha: frozen },
        { repo: "vendor/x", fromHeadSha: frozen, toHeadSha: frozen },
      ]),
    ).toEqual([`. ${frozen.slice(0, 12)} unchanged`, `vendor/x ${frozen.slice(0, 12)} unchanged`])

    const sparse: { repo: string; fromHeadSha: string; toHeadSha: string }[] = []
    sparse.length = 1
    expect(() => collapseRecomposedSources(sparse)).toThrow("yrd: recomposed source 0 is missing")
  })

  it("mechanically recuts an admitted certificate across consecutive base advances (R1304/R1307)", async () => {
    const oldHead = "2".repeat(40)
    const nextHead = "3".repeat(40)
    const nextBase = "b".repeat(40)
    const laterHead = "4".repeat(40)
    const laterBase = "e".repeat(40)
    const treeSha = "c".repeat(40)
    const patchId = "d".repeat(40)
    const remergeInputs: unknown[] = []
    const app = await createApp({ waitingCheck: true })
    const services = {
      recut: {
        recut(input: unknown) {
          remergeInputs.push(input)
          return Promise.resolve({
            headSha: remergeInputs.length === 1 ? nextHead : laterHead,
            baseSha: remergeInputs.length === 1 ? nextBase : laterBase,
            treeSha,
            patchId,
            unchanged: false,
          })
        },
      },
    } as unknown as YrdCliServices
    const cycle = runInternals.refreshAdmittedQueueRevisions

    await app.bays.submit({ branch: "issue/auto-recut", headSha: HEAD_SHA, baseSha: BASE_SHA, draft: true })
    await app.bays.recut({
      pr: "PR1",
      fromRevision: 1,
      headSha: oldHead,
      baseSha: BASE_SHA,
      treeSha,
      patchId,
      reviewCarried: false,
    })
    await app.bays.ready({ pr: "PR1" })
    await app.bays.requestChecks({ pr: "PR1", baseSha: BASE_SHA })
    expect(await app.queue.run({ prs: ["PR1"] }, { runner: "yrd-cli", leaseMs: 60_000 })).toEqual([])
    const firstAdmissionJob = revisionAdmissionJob(app, "PR1")
    expect(firstAdmissionJob).toMatchObject({ status: "waiting" })
    const beforeCycle = await Array.fromAsync(app.events()).then((events) => events.length)
    const io = outputIO({ resolveQueueTarget: async () => ({ base: "main", sha: nextBase }) }).io

    expect(cycle, "habitant cycles need a queue-owned base-advance recut seam").toBeTypeOf("function")
    await cycle(app, services, io)
    expect(await app.queue.run({ prs: ["PR1"] }, { runner: "yrd-cli", leaseMs: 60_000 })).toEqual([])
    const secondAdmissionJob = revisionAdmissionJob(app, "PR1")
    expect(secondAdmissionJob).toMatchObject({ status: "waiting" })
    expect(secondAdmissionJob?.id).not.toBe(firstAdmissionJob?.id)

    expect(remergeInputs).toEqual([
      expect.objectContaining({
        id: "PR1",
        revision: 2,
        headSha: oldHead,
        baseSha: BASE_SHA,
        current: expect.objectContaining({ revision: 2, headSha: oldHead, baseSha: BASE_SHA, patchId }),
      }),
    ])
    const firstRefresh = app.bays.pr("PR1")!
    expect(changeDeliveryState(firstRefresh)).toBe("submitted")
    expect(currentChangeRev(firstRefresh)).toMatchObject({
      n: 3,
      head: nextHead,
      baseSha: nextBase,
      recut: {
        fromRevision: 2,
        patchId,
        treeSha,
        transition: { from: "admitted", to: "refreshed" },
      },
    })
    expect(firstRefresh.revs).toMatchObject([{ n: 1 }, { n: 2 }, { n: 3 }])
    expect(app.jobs.get(firstAdmissionJob!.id)).toMatchObject({ status: "completed", conclusion: "cancelled" })
    expect(Queues.ids(app.state().queues)).toEqual([])

    const appended = (await Array.fromAsync(app.events())).slice(beforeCycle)
    const remergeIndex = appended.findIndex(
      ({ name, data }) =>
        name === "pr/recut" && (data as { successor?: { revision?: number } }).successor?.revision === 3,
    )
    const successorJobIndex = appended.findIndex(
      ({ name, data }) =>
        name === "job/requested" && (data as { key?: string }).key?.startsWith("admission:PR1:3:") === true,
    )
    expect(remergeIndex).toBeGreaterThanOrEqual(0)
    expect(appended[remergeIndex]?.data).toMatchObject({ transition: { from: "admitted", to: "refreshed" } })
    expect(successorJobIndex).toBeGreaterThan(remergeIndex)

    const afterFirstCycle = await Array.fromAsync(app.events()).then((events) => events.length)
    await cycle(app, services, io)
    expect(remergeInputs).toHaveLength(1)
    expect(app.bays.pr("PR1")?.revs).toHaveLength(3)
    expect(await Array.fromAsync(app.events()).then((events) => events.length)).toBe(afterFirstCycle)

    await cycle(app, services, outputIO({ resolveQueueTarget: async () => ({ base: "main", sha: laterBase }) }).io)
    expect(await app.queue.run({ prs: ["PR1"] }, { runner: "yrd-cli", leaseMs: 60_000 })).toEqual([])
    const thirdAdmissionJob = revisionAdmissionJob(app, "PR1")
    expect(thirdAdmissionJob).toMatchObject({ status: "waiting" })
    expect(remergeInputs).toHaveLength(2)
    const secondRefresh = app.bays.pr("PR1")!
    expect(changeDeliveryState(secondRefresh)).toBe("submitted")
    expect(currentChangeRev(secondRefresh)).toMatchObject({
      n: 4,
      head: laterHead,
      baseSha: laterBase,
      recut: {
        fromRevision: 3,
        patchId,
        transition: { from: "admitted", to: "refreshed" },
      },
    })
    expect(secondRefresh.revs).toMatchObject([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }])
    expect(app.jobs.get(secondAdmissionJob!.id)).toMatchObject({ status: "completed", conclusion: "cancelled" })
    expect(thirdAdmissionJob?.id).not.toBe(secondAdmissionJob?.id)
  })

  it("refreshes only the next queue candidate batch after a base advance", async () => {
    let targetBase = "f".repeat(40)
    const oldHeads = ["2", "3", "4", "5", "6"].map((digit) => digit.repeat(40))
    const refreshedHeads = ["7", "8", "9", "a", "b"].map((digit) => digit.repeat(40))
    const remergeInputs: Array<{ id: string }> = []
    const app = await createApp({ batch: 2 })
    const services = {
      recut: {
        recut(input: unknown) {
          const remerge = input as { id: string }
          remergeInputs.push(remerge)
          const index = Number(remerge.id.slice(2)) - 1
          return Promise.resolve({
            headSha: refreshedHeads[index]!,
            baseSha: targetBase,
            treeSha: "c".repeat(40),
            patchId: "d".repeat(40),
            unchanged: false,
          })
        },
      },
    } as unknown as YrdCliServices
    const refresh = runInternals.refreshAdmittedQueueRevisions
    const io = outputIO({ resolveQueueTarget: async () => ({ base: "main", sha: targetBase }) }).io

    for (const [index, oldHead] of oldHeads.entries()) {
      const pr = `PR${index + 1}`
      await app.bays.submit({
        branch: `issue/convoy-${index + 1}`,
        headSha: oldHead,
        baseSha: BASE_SHA,
        draft: true,
      })
      await app.bays.recut({
        pr,
        fromRevision: 1,
        headSha: oldHead,
        baseSha: BASE_SHA,
        treeSha: "c".repeat(40),
        patchId: "d".repeat(40),
        reviewCarried: false,
      })
      await app.bays.ready({ pr })
      await app.bays.requestChecks({ pr, baseSha: BASE_SHA })
    }
    for (const pr of ["PR1", "PR2", "PR3", "PR4", "PR5"]) await app.bays.editPr({ pr, track: false })

    await refresh(app, services, io)
    expect(remergeInputs.map(({ id }) => id)).toEqual(["PR1", "PR2"])
    expect(["PR1", "PR2", "PR3", "PR4", "PR5"].map((pr) => currentChangeRev(app.bays.pr(pr)!).n)).toEqual([
      3, 3, 2, 2, 2,
    ])

    await app.bays.closePr({ pr: "PR1", reason: "candidate merged" })
    await app.bays.closePr({ pr: "PR2", reason: "candidate merged" })
    targetBase = "e".repeat(40)
    await refresh(app, services, io)
    expect(remergeInputs.map(({ id }) => id)).toEqual(["PR1", "PR2", "PR3", "PR4"])

    await app.bays.closePr({ pr: "PR3", reason: "candidate merged" })
    await app.bays.closePr({ pr: "PR4", reason: "candidate merged" })
    targetBase = "d".repeat(40)
    await refresh(app, services, io)
    expect(remergeInputs.map(({ id }) => id)).toEqual(["PR1", "PR2", "PR3", "PR4", "PR5"])
    expect(currentChangeRev(app.bays.pr("PR5")!).n).toBe(3)
  })

  it("settles an absorbed front candidate and refreshes the next PR in the same cycle (22528)", async () => {
    const absorbedHead = "2".repeat(40)
    const nextHead = "3".repeat(40)
    const refreshedNextHead = "4".repeat(40)
    const nextBase = "b".repeat(40)
    const baseTree = "c".repeat(40)
    const patchId = "d".repeat(40)
    const remergeInputs: Array<{ id: string }> = []
    const app = await createApp({ waitingCheck: (input) => input.prs.some((pr) => pr.id === "PR1") })
    const services = {
      recut: {
        recut(input: unknown) {
          const remerge = input as { id: string }
          remergeInputs.push(remerge)
          if (remerge.id === "PR2") {
            return Promise.resolve({
              headSha: refreshedNextHead,
              baseSha: nextBase,
              treeSha: "f".repeat(40),
              patchId,
              unchanged: false,
            })
          }
          return Promise.resolve({
            // The remerger has proven that the resolved Queue base already
            // contains every authored path. Nothing remains to admit or merge.
            headSha: nextBase,
            baseSha: nextBase,
            treeSha: baseTree,
            patchId,
            unchanged: false,
          })
        },
      },
    } as unknown as YrdCliServices
    const refresh = runInternals.refreshAdmittedQueueRevisions
    const io = outputIO({ resolveQueueTarget: async () => ({ base: "main", sha: nextBase }) }).io

    await app.bays.submit({ branch: "issue/absorbed", headSha: HEAD_SHA, baseSha: BASE_SHA, draft: true })
    await app.bays.recut({
      pr: "PR1",
      fromRevision: 1,
      headSha: absorbedHead,
      baseSha: BASE_SHA,
      treeSha: "e".repeat(40),
      patchId,
      reviewCarried: false,
    })
    await app.bays.ready({ pr: "PR1" })
    await app.bays.requestChecks({ pr: "PR1", baseSha: BASE_SHA })
    expect(await app.queue.run({ prs: ["PR1"] }, { runner: "yrd-cli", leaseMs: 60_000 })).toEqual([])
    const admissionJob = revisionAdmissionJob(app, "PR1")
    expect(admissionJob).toMatchObject({ status: "waiting" })

    await app.bays.submit({ branch: "issue/next", headSha: nextHead, baseSha: BASE_SHA })
    await app.bays.requestChecks({ pr: "PR2", baseSha: BASE_SHA })

    const before = await Array.fromAsync(app.events()).then((events) => events.length)
    await expect(refresh(app, services, io)).resolves.toEqual([
      expect.objectContaining({ status: "settled", pr: "PR1", proof: "payload-already-contained" }),
      expect.objectContaining({ status: "refreshed", pr: "PR2", headSha: refreshedNextHead }),
    ])

    expect(remergeInputs.map(({ id }) => id)).toEqual(["PR1", "PR2"])
    expect(changeDeliveryState(app.bays.pr("PR1")!)).toBe("already-landed")
    expect(app.jobs.get(admissionJob!.id)).toMatchObject({ status: "completed", conclusion: "cancelled" })
    expect(currentChangeRev(app.bays.pr("PR1")!)).toMatchObject({ n: 2, head: absorbedHead })
    const appended = (await Array.fromAsync(app.events())).slice(before)
    expect(appended.filter(({ name }) => name === "pr/already-landed")).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          pr: "PR1",
          revision: 2,
          headSha: absorbedHead,
          baseSha: nextBase,
          candidateSha: nextBase,
          candidateTreeSha: baseTree,
          baseTreeSha: baseTree,
          settlement: {
            kind: "refresh-superseded",
            proof: "payload-already-contained",
            patchId,
          },
        }),
      }),
    ])

    const afterSettlement = await Array.fromAsync(app.events()).then((events) => events.length)
    await expect(refresh(app, services, io)).resolves.toEqual([])
    expect(remergeInputs.map(({ id }) => id)).toEqual(["PR1", "PR2"])
    expect(await Array.fromAsync(app.events()).then((events) => events.length)).toBe(afterSettlement)

    // The same-cycle refresh proves that terminal settlement releases the
    // selector immediately instead of merely hiding PR1 for one habitant tick.
    // The in-memory app's canonical base resolver is intentionally fixed at
    // BASE_SHA, independent of the refresh seam's injected next-base oracle.
    const runs = await app.queue.run({}, { runner: "yrd-cli", leaseMs: 60_000 })
    expect(runs).toMatchObject([{ prs: [{ id: "PR2", revision: 2, headSha: refreshedNextHead }] }])
    expect(changeDeliveryState(app.bays.pr("PR2")!)).toBe("integrated")
  })

  it("runs admitted-to-refreshed as a habitant pre-run transition", async () => {
    const nextBase = "b".repeat(40)
    const nextHead = "3".repeat(40)
    const patchId = "d".repeat(40)
    const app = await createApp({ waitingCheck: true })
    await app.bays.submit({ branch: "issue/habitant-refresh", headSha: HEAD_SHA, baseSha: BASE_SHA, draft: true })
    await app.bays.editPr({ pr: "PR1", track: false })
    await app.bays.recut({
      pr: "PR1",
      fromRevision: 1,
      headSha: "2".repeat(40),
      baseSha: BASE_SHA,
      treeSha: "c".repeat(40),
      patchId,
      reviewCarried: false,
    })
    await app.bays.ready({ pr: "PR1" })
    await app.bays.requestChecks({ pr: "PR1", baseSha: BASE_SHA })
    const services = {
      recut: {
        recut() {
          return Promise.resolve({
            headSha: nextHead,
            baseSha: nextBase,
            treeSha: "e".repeat(40),
            patchId,
            unchanged: false,
          })
        },
      },
    } as unknown as YrdCliServices
    const controller = new AbortController()
    const gate = vi.fn(async () => undefined)
    const io = outputIO({
      resolveQueueTarget: async () => ({ base: "main", sha: nextBase }),
      scope: {
        signal: controller.signal,
        sleep: async () => {
          controller.abort()
        },
      } as YrdCliIO["scope"],
    }).io

    await expect(runInternals.followQueueRuns(app, [], { json: true, interval: 1 }, io, gate, services)).resolves.toBe(
      3,
    )
    expect(gate).toHaveBeenCalledTimes(2)
    const refreshed = app.bays.pr("PR1")!
    expect(changeDeliveryState(refreshed)).toBe("submitted")
    expect(currentChangeRev(refreshed)).toMatchObject({
      n: 3,
      head: nextHead,
      recut: { patchId, transition: { from: "admitted", to: "refreshed" } },
    })
    expect(revisionAdmissionJob(app, "PR1")).toMatchObject({ status: "waiting" })
    expect(Queues.ids(app.state().queues)).toEqual([])
  })

  it("keeps a five-carrier convoy tail flat until each habitant candidate batch reaches the front", async () => {
    let targetBase = "f".repeat(40)
    let now = 0
    const oldHeads = ["2", "3", "4", "5", "6"].map((digit) => digit.repeat(40))
    const refreshedHeads = ["7", "8", "9", "a", "b"].map((digit) => digit.repeat(40))
    const remergeIds: string[] = []
    const checkedRevisions: string[] = []
    const app = await createApp({ batch: 2, waitingCheck: true, checkedRevisions })

    for (const [index, oldHead] of oldHeads.entries()) {
      const pr = `PR${index + 1}`
      await app.bays.submit({
        branch: `issue/habitant-convoy-${index + 1}`,
        headSha: oldHead,
        baseSha: BASE_SHA,
        draft: true,
      })
      await app.bays.recut({
        pr,
        fromRevision: 1,
        headSha: oldHead,
        baseSha: BASE_SHA,
        treeSha: "c".repeat(40),
        patchId: "d".repeat(40),
        reviewCarried: false,
      })
      await app.bays.ready({ pr })
      await app.bays.requestChecks({ pr, baseSha: BASE_SHA })
    }

    const remerge = vi.fn((input: unknown) => {
      const candidate = input as { id: string }
      remergeIds.push(candidate.id)
      const index = Number(candidate.id.slice(2)) - 1
      return Promise.resolve({
        headSha: refreshedHeads[index]!,
        baseSha: targetBase,
        treeSha: "e".repeat(40),
        patchId: "d".repeat(40),
        unchanged: false,
      })
    })
    const services = { recut: { recut: remerge } } as unknown as YrdCliServices
    const controller = new AbortController()
    const beforeHabitant = await Array.fromAsync(app.events()).then((events) => events.length)
    const snapshots: Array<{
      recuts: string[]
      revisions: number[]
      admissions: string[]
      jobs: string[]
      checks: string[]
    }> = []
    let sleeps = 0
    const io = outputIO({
      now: () => now,
      resolveQueueTarget: async () => ({ base: "main", sha: targetBase }),
      scope: {
        signal: controller.signal,
        sleep: async () => {
          const habitantEvents = (await Array.fromAsync(app.events())).slice(beforeHabitant)
          snapshots.push({
            recuts: [...remergeIds],
            revisions: ["PR1", "PR2", "PR3", "PR4", "PR5"].map((pr) => currentChangeRev(app.bays.pr(pr)!).n),
            admissions: ["PR1", "PR2", "PR3", "PR4", "PR5"].flatMap((pr) =>
              app.bays
                .pr(pr)!
                .checkRequests.filter(({ revision }) => revision === 3)
                .map(({ revision }) => `${pr}@${revision}`),
            ),
            jobs: habitantEvents.flatMap(({ name, data }) => {
              if (name !== "job/requested") return []
              const match = /^admission:(PR\d+):(\d+):/.exec((data as { key?: string }).key ?? "")
              return match === null ? [] : [`${match[1]}@${match[2]}`]
            }),
            checks: [...checkedRevisions],
          })
          sleeps += 1
          if (sleeps === 1) {
            await app.bays.closePr({ pr: "PR1", reason: "candidate merged" })
            await app.bays.closePr({ pr: "PR2", reason: "candidate merged" })
            targetBase = "e".repeat(40)
            now += 60_000
            return
          }
          if (sleeps === 2) {
            await app.bays.closePr({ pr: "PR3", reason: "candidate merged" })
            await app.bays.closePr({ pr: "PR4", reason: "candidate merged" })
            targetBase = "d".repeat(40)
            now += 60_000
            return
          }
          controller.abort()
        },
      } as YrdCliIO["scope"],
    }).io

    await expect(
      runInternals.followQueueRuns(app, [], { json: true, interval: 1 }, io, async () => undefined, services),
    ).resolves.toBe(3)

    // Each snapshot is taken after the habitant's refresh + admission pass and
    // before the simulated base move. The tail therefore proves zero work until
    // its candidate batch reaches the front, followed by exactly one recut/check.
    expect(snapshots).toEqual([
      {
        recuts: ["PR1", "PR2"],
        revisions: [3, 3, 2, 2, 2],
        admissions: ["PR1@3", "PR2@3"],
        jobs: ["PR1@3"],
        checks: ["PR1@3"],
      },
      {
        recuts: ["PR1", "PR2", "PR3", "PR4"],
        revisions: [3, 3, 3, 3, 2],
        admissions: ["PR1@3", "PR2@3", "PR3@3", "PR4@3"],
        jobs: ["PR1@3", "PR3@3"],
        checks: ["PR1@3", "PR3@3"],
      },
      {
        recuts: ["PR1", "PR2", "PR3", "PR4", "PR5"],
        revisions: [3, 3, 3, 3, 3],
        admissions: ["PR1@3", "PR2@3", "PR3@3", "PR4@3", "PR5@3"],
        jobs: ["PR1@3", "PR3@3", "PR5@3"],
        checks: ["PR1@3", "PR3@3", "PR5@3"],
      },
    ])
    expect(remerge).toHaveBeenCalledTimes(5)
  })

  it("re-proves the baseline when freshness mutates the change before refusing it", async () => {
    const nextBase = "b".repeat(40)
    const nextHead = "3".repeat(40)
    const unpublishedPin = "4".repeat(40)
    const app = await createApp()
    await app.bays.submit({ branch: "issue/post-recut-refusal", headSha: HEAD_SHA, baseSha: BASE_SHA, draft: true })
    await app.bays.recut({
      pr: "PR1",
      fromRevision: 1,
      headSha: "2".repeat(40),
      baseSha: BASE_SHA,
      treeSha: "c".repeat(40),
      patchId: "d".repeat(40),
      reviewCarried: false,
    })
    await app.bays.ready({ pr: "PR1" })
    await app.bays.requestChecks({ pr: "PR1", baseSha: BASE_SHA })

    const processRun = vi.fn(async (request: ProcessRequest): Promise<ProcessResult> => {
      const argv = request.argv
      const stdout = argv.includes("merge-base")
        ? `${BASE_SHA}\n`
        : argv.includes("ls-tree") && argv.includes("-r") && argv.includes(nextHead)
          ? `160000 commit ${unpublishedPin}\tdep\0`
          : argv.includes("ls-tree") && argv.includes(nextHead) && argv.includes(".gitmodules")
            ? `100644 blob ${"5".repeat(40)}\t.gitmodules\n`
            : argv.includes("config") && argv.includes(`${nextHead}:.gitmodules`)
              ? "submodule.dep.path\ndep\0"
              : argv.includes("rev-parse") && argv.includes("--show-toplevel")
                ? "/repo/dep\n"
                : ""
      return {
        exitCode: 0,
        signal: null,
        stdout,
        stderr: "",
        durationMs: 0,
        timedOut: false,
      }
    })
    const remerge = vi.fn(async () => ({
      headSha: nextHead,
      baseSha: nextBase,
      treeSha: "e".repeat(40),
      patchId: "d".repeat(40),
      unchanged: false,
    }))
    const services = {
      process: { run: processRun },
      recut: { recut: remerge },
    } as unknown as YrdCliServices
    const queueRun = vi.fn(async () => [])
    const viewer = { ...app, queue: { ...app.queue, run: queueRun } } as TestApp
    const controller = new AbortController()
    const gate = vi.fn(async () => undefined)
    let sleeps = 0
    const io = outputIO({
      cwd: "/repo",
      resolveQueueTarget: async () => ({ base: "main", sha: nextBase }),
      scope: {
        signal: controller.signal,
        sleep: async () => {
          sleeps += 1
          if (sleeps === 2) controller.abort()
        },
      } as YrdCliIO["scope"],
    }).io

    await expect(
      runInternals.followQueueRuns(viewer, [], { json: true, interval: 1 }, io, gate, services),
    ).resolves.toBe(3)

    expect(remerge).toHaveBeenCalled()
    expect(currentChangeRev(app.bays.pr("PR1")!)).toMatchObject({ n: 3, head: nextHead })
    // A recut PR is queue-carried, so the gate asks reachability (the mute stub advertises
    // zero refs → unreachable), never the author min-commit main-ancestry question.
    expect(app.state().queues.admissionRefusals.PR1).toMatchObject({
      pr: "PR1",
      revision: 3,
      headSha: nextHead,
      code: "submodule-pin-unpublished",
      count: 1,
    })
    expect(gate, "a post-mutation refusal must re-read the declared plan").toHaveBeenCalledTimes(2)
  })

  it("exits non-zero when an internal scope aborts an unchanged idle follow tick", async () => {
    const app = await createApp()
    const controller = new AbortController()
    const sleeps: number[] = []
    const queueRun = vi.fn(app.queue.run.bind(app.queue))
    const viewer = {
      ...app,
      queue: {
        ...app.queue,
        run: queueRun,
      },
    } as TestApp
    const gate = vi.fn(async () => undefined)
    const io = outputIO({
      now: () => Date.parse("2026-07-09T12:01:00.000Z"),
      scope: {
        signal: controller.signal,
        sleep: async (milliseconds: number) => {
          sleeps.push(milliseconds)
          if (sleeps.length === 2) controller.abort()
        },
      } as YrdCliIO["scope"],
    }).io

    await expect(runInternals.followQueueRuns(viewer, [], { json: true, interval: 1 }, io, gate)).resolves.toBe(3)
    expect(sleeps).toEqual([1_000, 1_000])
    expect(gate, "an unchanged idle tick must not re-run the declared-plan gate").toHaveBeenCalledTimes(1)
    expect(queueRun, "an unchanged idle tick must not traverse and compose the full queue").toHaveBeenCalledTimes(1)
  })

  it("exits non-zero on every habitant refusal, so a stopped runner is never mistaken for a drained queue", async () => {
    // A habitant that refuses has stopped serving the queue. If it exited zero,
    // every supervisor above it — hab, a shell loop, CI — would read the stop as
    // a completed drain and not restart it, and the queue would sit unattended
    // behind a green exit. Refusals classify to 1 (invocation.ts
    // `classifyFailure`); this pins the whole path from the gate to the code.
    const requested: number[] = []
    const refuse: YrdCliServices = {
      queue: {
        auditEnvironment: async (options) => {
          requested.push(options?.recordedRuns ?? -1)
          return {
            findings: [
              { code: "installed-plan-stale", message: "this process installed check→merge, but main tip declares …" },
            ],
            comparison: stubAuditComparison(),
          }
        },
      },
    }

    // The installed plan is not the one the tip declares, and no process host
    // is wired to exec a replacement in place: the habitant must die and be
    // restarted rather than refuse every candidate it prepares.
    const runtime = outputIO()
    const app = await createApp()
    expect(await runYrd(app, yrd("queue", "run"), runtime.io, refuse)).toBe(1)
    expect(runtime.stderr()).toContain("error: this process installed check→merge, but main tip declares")
    const runtimeJson = outputIO()
    expect(await runYrd(await createApp(), yrd("queue", "run", "--json"), runtimeJson.io, refuse)).toBe(1)
    expect(JSON.parse(runtimeJson.stderr())).toMatchObject({
      failure: { kind: "refusal", code: "installed-plan-stale" },
    })

    // The one-shot path shares the gate and must agree: a refusal is a refusal
    // whether or not a habitant is following.
    const once = outputIO()
    const onceApp = await createApp()
    expect(await runYrd(onceApp, yrd("queue", "run", "--once"), once.io, refuse)).toBe(1)
    expect(once.stderr()).toContain("error: this process installed check→merge, but main tip declares")
    // The gate reads the installed leg only: a journal walk is `queue audit`'s
    // job, and a stale record is not something a restart fixes.
    expect(requested).toEqual([0, 0, 0])

    // A recorded-run mismatch is an audit finding, never a reason to stop the
    // runner: the journal disagreeing with git about a PAST Run says nothing
    // about whether this process can execute the NEXT one.
    const mismatchOnly: YrdCliServices = {
      queue: {
        auditEnvironment: async () => ({
          findings: [{ code: "run-plan-mismatch", message: "run R1 recorded a plan git does not derive" }],
          comparison: stubAuditComparison(),
        }),
      },
    }
    const tolerant = outputIO()
    const tolerantApp = await createApp()
    expect(await runYrd(tolerantApp, yrd("queue", "run", "--once"), tolerant.io, mismatchOnly)).toBe(0)
  })

  it("expires a hold on an otherwise idle follow tick without exiting the runner", async () => {
    let now = Date.parse("2026-07-09T12:00:00.000Z")
    const app = await createApp()
    await app.queue.pause({
      base: "main",
      reason: "operator freeze",
      allowedPRs: [],
      expiresAt: "2026-07-09T12:00:01.500Z",
    })
    const controller = new AbortController()
    const queueRun = vi.fn(app.queue.run.bind(app.queue))
    const viewer = { ...app, queue: { ...app.queue, run: queueRun } } as TestApp
    const sleeps: number[] = []
    const io = outputIO({
      now: () => now,
      scope: {
        signal: controller.signal,
        sleep: async (milliseconds: number) => {
          sleeps.push(milliseconds)
          now += milliseconds
          if (sleeps.length === 3) controller.abort()
        },
      } as YrdCliIO["scope"],
    }).io

    await expect(
      runInternals.followQueueRuns(viewer, [], { json: true, interval: 1 }, io, async () => undefined),
    ).resolves.toBe(3)
    expect(app.queue.status("main").pause).toBeUndefined()
    expect(queueRun, "deadline expiry must wake exactly one additional drain cycle").toHaveBeenCalledTimes(2)
  })

  it("wakes an idle follow loop when the Journal advances", async () => {
    const journal = createMemoryJournal()
    const runner = await createApp({ journal })
    const writer = await createApp({ journal })
    const controller = new AbortController()
    const sleeps: number[] = []
    const queueRun = vi.fn(runner.queue.run.bind(runner.queue))
    const viewer = {
      ...runner,
      queue: {
        ...runner.queue,
        run: queueRun,
      },
    } as TestApp
    const gate = vi.fn(async () => undefined)
    const io = outputIO({
      now: () => Date.parse("2026-07-09T12:01:00.000Z"),
      scope: {
        signal: controller.signal,
        sleep: async (milliseconds: number) => {
          sleeps.push(milliseconds)
          if (sleeps.length === 1) await openAndSubmit(writer)
          else controller.abort()
        },
      } as YrdCliIO["scope"],
    }).io

    try {
      await expect(runInternals.followQueueRuns(viewer, [], { json: true, interval: 1 }, io, gate)).resolves.toBe(3)
      expect(sleeps).toEqual([1_000, 1_000])
      expect(gate, "new durable work must re-open the declared-plan gate").toHaveBeenCalledTimes(2)
      expect(queueRun, "new durable work must wake the queue compose path").toHaveBeenCalledTimes(2)
      expect(runner.bays.pr("PR1"), "the wake-up cycle must observe the appended PR").toBeDefined()
    } finally {
      await Promise.all([runner.close(), writer.close()])
    }
  })

  it("recovers a journaled freshness transition when the habitant stops before canceling its predecessor", async () => {
    const nextHead = "3".repeat(40)
    const nextBase = "b".repeat(40)
    const treeSha = "c".repeat(40)
    const patchId = "d".repeat(40)
    const app = await createApp({ waitingCheck: true })
    await app.bays.submit({ branch: "issue/refresh-crash", headSha: HEAD_SHA, baseSha: BASE_SHA, draft: true })
    await app.bays.recut({
      pr: "PR1",
      fromRevision: 1,
      headSha: "2".repeat(40),
      baseSha: BASE_SHA,
      treeSha,
      patchId,
      reviewCarried: false,
    })
    await app.bays.ready({ pr: "PR1" })
    await app.bays.requestChecks({ pr: "PR1", baseSha: BASE_SHA })
    await app.queue.run({ prs: ["PR1"] }, { runner: "yrd-cli", leaseMs: 60_000 })
    const predecessorJob = revisionAdmissionJob(app, "PR1")
    expect(predecessorJob).toMatchObject({ status: "waiting" })

    // This is the durable point after auto-recut and before the habitant's
    // best-effort predecessor cancellation. A process exit here must leave the
    // successor submitted/checkable so the next ordinary Queue drain recovers.
    await app.bays.recut({
      pr: "PR1",
      fromRevision: 2,
      headSha: nextHead,
      baseSha: nextBase,
      treeSha,
      patchId,
      reviewCarried: false,
      expectedCurrent: { revision: 2, headSha: "2".repeat(40) },
      transition: { from: "admitted", to: "refreshed" },
    })
    const interrupted = app.bays.pr("PR1")!
    expect(changeDeliveryState(interrupted)).toBe("submitted")
    expect(currentChangeRev(interrupted)).toMatchObject({ n: 3, head: nextHead })
    expect(app.bays.checksRequested("PR1")).toBe(true)

    const refresh = runInternals.refreshAdmittedQueueRevisions
    const services = {
      recut: {
        recut() {
          throw new Error("same-base recovery must not recompute Git proof")
        },
      },
    } as unknown as YrdCliServices
    await expect(
      refresh(app, services, outputIO({ resolveQueueTarget: async () => ({ base: "main", sha: nextBase }) }).io),
    ).resolves.toContainEqual({
      status: "recovered",
      pr: "PR1",
      revision: 3,
      runs: [],
      jobs: [predecessorJob!.id],
    })
    await app.queue.run({ prs: ["PR1"] }, { runner: "yrd-cli", leaseMs: 60_000 })
    expect(app.jobs.get(predecessorJob!.id)).toMatchObject({ status: "completed", conclusion: "cancelled" })
    expect(revisionAdmissionJob(app, "PR1")).toMatchObject({ status: "waiting" })
    expect(Queues.ids(app.state().queues)).toEqual([])
  })

  it("does not overwrite an authored revision that arrives while habitant freshness is computing", async () => {
    const branch = "issue/auto-recut-cas"
    const remergeHead = "2".repeat(40)
    const authoredHead = "3".repeat(40)
    const staleAutoHead = "4".repeat(40)
    const nextBase = "b".repeat(40)
    const treeSha = "c".repeat(40)
    const patchId = "d".repeat(40)
    const app = await createApp({ waitingCheck: true })
    const refresh = runInternals.refreshAdmittedQueueRevisions

    await app.bays.submit({ branch, headSha: HEAD_SHA, baseSha: BASE_SHA, draft: true })
    await app.bays.recut({
      pr: "PR1",
      fromRevision: 1,
      headSha: remergeHead,
      baseSha: BASE_SHA,
      treeSha,
      patchId,
      reviewCarried: false,
    })
    await app.bays.ready({ pr: "PR1" })
    await app.bays.requestChecks({ pr: "PR1", baseSha: BASE_SHA })

    const services = {
      recut: {
        async recut() {
          // The Git proof runs outside the journal CAS. Model a submitter pushing
          // a new authored revision before that proof tries to append.
          await app.bays.intake({ branch, headSha: authoredHead, base: "main", baseSha: BASE_SHA })
          return {
            headSha: staleAutoHead,
            baseSha: nextBase,
            treeSha: "e".repeat(40),
            patchId: "f".repeat(40),
            unchanged: false,
          }
        },
      },
    } as unknown as YrdCliServices
    const io = outputIO({ resolveQueueTarget: async () => ({ base: "main", sha: nextBase }) }).io

    await expect(refresh(app, services, io)).resolves.toEqual([
      expect.objectContaining({ status: "deferred", pr: "PR1", code: "recut-current-changed" }),
    ])
    const authored = app.bays.pr("PR1")!
    expect(changeDeliveryState(authored)).toBe("pushed")
    expect(currentChangeRev(authored)).toMatchObject({ n: 3, head: authoredHead })
    expect(authored.revs).toMatchObject([
      { n: 1, head: HEAD_SHA },
      { n: 2, head: remergeHead },
      { n: 3, head: authoredHead },
    ])
  })

  it("renders one shared PR projection at 80 and 120 columns without cropped semantic headers", async () => {
    const revision = (
      headSha: string,
      pushedAt: string,
      submittedAt?: string,
      terminal?: ChangeRev["terminal"],
      submitter?: string,
    ): ChangeRev => ({
      n: 1,
      head: headSha,
      base: "main",
      baseSha: BASE_SHA,
      pushedAt,
      ...(submittedAt === undefined ? {} : { submittedAt }),
      ...(terminal === undefined ? {} : { terminal }),
      ...(submitter === undefined ? {} : { submitter }),
    })
    const pr = (id: string, branch: string, status: ChangeDeliveryState, clock: ChangeRev): Change => ({
      id,
      branch,
      base: clock.base,
      state: status === "integrated" || status === "withdrawn" || status === "canceled" ? "closed" : "open",
      merged: status === "integrated",
      revs: [clock],
      reviews: [],
      comments: [],
      checkRequests: [],
      ...(clock.submittedAt === undefined ? {} : { submittedAt: clock.submittedAt }),
      ...(status === "rejected" ? { rejectedAt: clock.terminal?.at } : {}),
      ...(status === "integrated" ? { integratedAt: clock.terminal?.at } : {}),
    })
    const review = { required: false, approved: false, stale: false } as const
    const entries: ReadonlyArray<Readonly<{ pr: Change; eligibility: ChangeEligibility }>> = [
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
          reason: { code: "required-check-failed", message: "required check failed" },
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
            kind: "rejected",
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
            kind: "integrated",
            at: "2026-07-09T10:10:00.000Z",
          }),
        ),
        eligibility: {
          pr: "PR5",
          revision: 1,
          runnable: false,
          reason: { code: "terminal", message: "integrated" },
          review: { required: true, approved: true, stale: false, decision: "approve", by: "@cto" },
          checks: { status: "passed", run: "R5" },
        },
      },
    ]

    const rows = changeListRows(entries, [], Date.parse("2026-07-09T12:10:00.000Z"))
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
      {
        id: "PR3",
        state: "pushed",
        glyph: "▢",
        review: "n/a",
        checks: "fail",
        why: "required-check-failed",
      },
      { id: "PR4", state: "rejected", glyph: "⧗", review: "n/a", checks: "n/a", why: "rejected" },
      { id: "PR5", state: "integrated", glyph: "✓", review: "ok", checks: "pass", why: "terminal" },
    ])
    expect(rows[2]?.target).toBe("release/2.0")

    for (const columns of [80, 120]) {
      const human = await renderString(createElement(ChangeListView, { rows, columns }), {
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

    const current = app.queue.get("R1")
    if (current === undefined) throw new Error("expected R1")
    const archived: Run = {
      ...current,
      id: "R0",
      base: "retired",
      prs: current.prs.map((pr) => ({ ...pr, base: "retired" })),
    }
    const history = vi.fn(() => Promise.resolve([archived, current]))
    const historicalApp = { ...app, queue: { ...app.queue, history } }
    const lossless = outputIO()
    expect(await runYrd(historicalApp, yrd("log", "--all", "--json"), lossless.io), lossless.stderr()).toBe(0)
    expect(history).toHaveBeenCalledOnce()
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
        { base: "retired", finished: [{ id: "R0" }] },
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

  it("bounds commit subject resolution to the surviving rows and eight concurrent lookups", async () => {
    const app = await createApp()
    const refs = Array.from({ length: 9 }, (_, index) => String(index + 1).repeat(40))
    for (const [index, headSha] of refs.entries()) {
      await app.bays.submit({
        branch: `topic/log-subject-${index + 1}`,
        headSha,
        base: "main",
      })
      await app.queue.run({ prs: [`PR${index + 1}`] }, { runner: "test", leaseMs: 60_000 })
    }

    let active = 0
    let peak = 0
    const resolveCommitMeta = vi.fn(async (ref: string) => {
      active += 1
      peak = Math.max(peak, active)
      await Promise.resolve()
      active -= 1
      return { subject: `subject-${ref.slice(0, 1)}` }
    })
    const limited = outputIO({ resolveCommitMeta })
    expect(await runYrd(app, yrd("log", "--limit", "2", "--json"), limited.io), limited.stderr()).toBe(0)

    expect(resolveCommitMeta.mock.calls.map(([ref]) => ref)).toEqual(refs.slice(-2))
    expect(
      (JSON.parse(limited.stdout()) as { rows: readonly { subject: string }[] }).rows.map((row) => row.subject),
    ).toEqual(["subject-8", "subject-9"])

    resolveCommitMeta.mockClear()
    peak = 0
    const all = outputIO({ resolveCommitMeta })
    expect(await runYrd(app, yrd("log", "--all", "--json"), all.io), all.stderr()).toBe(0)
    expect(resolveCommitMeta.mock.calls.map(([ref]) => ref)).toEqual(refs)
    expect(peak).toBe(8)
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
        status: "completed",
        conclusion: "failure",
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

  it("teaches inspect-and-resubmit when pr merge is invoked after a failed Run", async () => {
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
      status: "submitted",
      run: "R1",
      outcome: "rejected",
      next: "yrd pr runs PR1",
    })
    expect(refusal.guidance).toEqual({
      inspect: "yrd pr runs PR1",
      resubmit: "fix the branch and run yrd pr submit again",
    })
    expect(await Array.fromAsync(app.events()).then((events) => events.length)).toBe(before)
  })

  it("executes no authoritative check at plain submit; compose admits the fact and runs it in the later drain", async () => {
    // The legacy record mint retired: the fact is the submission. Checks no
    // longer queue as record check-requests at submit — they queue at compose
    // time, when the selectorless queue pass admits the derived member.
    const checkRuns: string[] = []
    const app = await createApp({ checkRuns, resolveBaseSha: () => BASE_SHA })

    const ledger = outputIO({ resolveRevision: async () => HEAD_SHA })
    expect(
      await runYrd(app, yrd("pr", "submit", "topic/ledger", "--base", "main", "--json"), ledger.io),
      ledger.stderr(),
    ).toBe(0)
    expect(JSON.parse(ledger.stdout())).toMatchObject({
      command: "pr.submit",
      prs: [],
      derived: [{ lane: "derived", branch: "topic/ledger", sha: HEAD_SHA, base: "main" }],
    })
    expect(checkRuns).toEqual([])
    expect(Queues.ids(app.state().queues)).toEqual([])
    expect(await app.queue.unrecordedSubmits()).toMatchObject([{ branch: "topic/ledger", sha: HEAD_SHA }])

    await app.queue.run({}, { runner: "test", leaseMs: 60_000 })
    expect(checkRuns).toEqual(["check"])
    expect(await app.queue.unrecordedSubmits()).toEqual([])

    const second = outputIO({ resolveRevision: async () => "2".repeat(40) })
    expect(
      await runYrd(app, yrd("pr", "submit", "topic/second", "--base", "main", "--json"), second.io),
      second.stderr(),
    ).toBe(0)
    // Still nothing executes in the submitter; the next compose owns it.
    expect(app.bays.state().submits["topic/second"]).toMatchObject({ sha: "2".repeat(40) })
    expect(checkRuns).toEqual(["check"])
  })

  it("refreshes PR-id submit output after its writes commit through another live app", async () => {
    const journal = createMemoryJournal()
    const writer = await createApp({ journal })
    await writer.bays.submit({
      branch: "topic/external-writer",
      headSha: HEAD_SHA,
      base: "main",
      draft: true,
    })
    const reader = await createApp({ journal })
    const routedBays = Object.create(reader.bays) as typeof reader.bays
    Object.defineProperties(routedBays, {
      submitSelection: { value: writer.bays.submitSelection },
      requestChecks: { value: writer.bays.requestChecks },
    })
    const app = Object.create(reader) as typeof reader
    Object.defineProperty(app, "bays", { value: routedBays })

    const output = outputIO({ resolveRevision: async () => HEAD_SHA })
    expect(await runYrd(app, yrd("pr", "submit", "PR1", "--json"), output.io), output.stderr()).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({
      command: "pr.submit",
      prs: [{ id: "PR1", status: "submitted", checkRequests: [expect.any(Object)] }],
    })

    const events = await Array.fromAsync(reader.events())
    expect(events.filter((event) => event.name === "pr/submitted")).toHaveLength(1)
    expect(events.filter((event) => event.name === "pr/checks-requested")).toHaveLength(1)
    const view = outputIO()
    expect(await runYrd(reader, yrd("pr", "view", "PR1", "--json"), view.io), view.stderr()).toBe(0)
    expect(JSON.parse(view.stdout())).toMatchObject({
      command: "pr.view",
      pr: { id: "PR1", status: "submitted", checkRequests: [expect.any(Object)] },
      merge: { status: "submitted" },
    })
    expect(await Array.fromAsync(reader.events())).toHaveLength(events.length)
  })

  it("runs configured client-side checks while leaving authoritative checks and integration to queue run", async () => {
    const localChecks: string[] = []
    const checkRuns: string[] = []
    const mergeRuns: string[] = []
    const app = await createApp({ checkRuns, mergeRuns })
    await openTestBay(app, { name: "one" })

    const submit = outputIO({ cwd: "/repo/.bays/B1" })
    expect(
      await runYrd(app, yrd("pr", "submit"), submit.io, {
        checks: {
          names: ["typecheck"],
          run: async (name) => {
            localChecks.push(name)
            return { stdout: "", stderr: "", exitCode: 0, signal: null, durationMs: 1, timedOut: false }
          },
          install: async () => "/repo/.git/yrd/hooks/pre-submit",
        },
      }),
      submit.stderr(),
    ).toBe(0)
    expect(changeDeliveryState(app.state().bays.prs.PR1!)).toBe("submitted")
    expect(await app.queue.history()).toEqual([])
    expect(localChecks).toEqual(["typecheck"])
    expect(checkRuns).toEqual([])
    expect(mergeRuns).toEqual([])

    const beforeRejectedWait = await Array.fromAsync(app.events()).then((events) => events.length)
    const rejectedWait = outputIO({ cwd: "/repo/.bays/B1" })
    const retiredWait = `--${["wa", "it"].join("")}`
    expect(await runYrd(app, yrd("bay", "submit", retiredWait), rejectedWait.io)).toBe(2)
    expect(await Array.fromAsync(app.events()).then((events) => events.length)).toBe(beforeRejectedWait)

    const run = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "PR1", "--json"), run.io), run.stderr()).toBe(0)
    expect(checkRuns).toEqual(["check"])
    expect(mergeRuns).toEqual(["merge"])
    expect(changeDeliveryState(app.state().bays.prs.PR1!)).toBe("integrated")
    expect(Queues.values(app.state().queues)).toHaveLength(1)
  })

  it("gates an explicit Bay selector through its durable branch ref instead of bay.path", async () => {
    const app = await createApp()
    await openTestBay(app, { name: "bay-free-gates" })
    const branch = app.bays.get("B1")?.branch
    expect(branch).toBeDefined()
    const guardContexts: Array<Readonly<{ cwd?: string; ref?: string }> | undefined> = []
    const checkContexts: Array<Readonly<{ cwd: string; ref?: string }>> = []
    const output = outputIO({ cwd: "/repo", currentBranch: () => "main" })

    expect(
      await runYrd(app, yrd("pr", "submit", "B1"), output.io, {
        guards: {
          names: ["identity"],
          run: async (name, context) => {
            guardContexts.push(context)
            return { name, status: "passed", candidateSha: HEAD_SHA }
          },
        },
        checks: {
          names: ["typecheck"],
          run: async (_name, cwd, context) => {
            checkContexts.push({ cwd, ...(context?.ref === undefined ? {} : { ref: context.ref }) })
            return { stdout: "", stderr: "", exitCode: 0, signal: null, durationMs: 1, timedOut: false }
          },
          install: async () => "/repo/.git/yrd/hooks/pre-submit",
        },
      }),
      output.stderr(),
    ).toBe(0)
    expect(guardContexts).toEqual([{ cwd: "/repo", ref: branch }])
    expect(checkContexts).toEqual([{ cwd: "/repo", ref: branch }])
  })

  it("submits a live change after its Bay workspace directory is deleted, never touching the missing path", async () => {
    // Mirrors PR1855/PR1856/PR1826 (@i/10-merge-queue/23160, 2026-08-22): a
    // prune closed each Bay whose content was already integrated, but a live
    // change record kept pointing at the now-gone `.bays/<id>` directory, and
    // a later `pr submit` crashed with "working directory ... does not exist"
    // instead of succeeding. The test above proves the CONTEXT SHAPE submit
    // computes; this one proves the OUTCOME against a directory that is
    // actually gone from disk.
    const bayRoot = mkdtempSync(join(tmpdir(), "yrd-carrier-bay-"))
    const cwdRoot = mkdtempSync(join(tmpdir(), "yrd-carrier-cwd-"))
    try {
      const app = await createApp({ bayPath: bayRoot })
      await openTestBay(app, { name: "carrier", branch: "task/carrier" })
      await submitBayFixture(app, "B1")
      const branch = app.bays.get("B1")?.branch
      expect(branch).toBeDefined()
      expect(changeDeliveryState(app.bays.pr("PR1")!)).toBe("submitted")
      const originalHead = currentChangeRev(app.bays.pr("PR1")!).head

      // The exact fact the fix relies on: the Bay's own workspace is gone.
      safeRemoveSync(bayRoot, { within: tmpdir(), allowMissing: true })
      expect(existsSync(bayRoot)).toBe(false)

      // A real, non-mocked stand-in for yrd-process's requireSpawnDirectory
      // (packages/yrd-process/src/index.ts): it fails for the same reason a
      // real spawn would — the directory it was handed does not exist —
      // rather than a canned mock that cannot tell a real cwd from a fake one.
      const seenCwds: string[] = []
      const realWorkspaceChecks: YrdCliServices["checks"] = {
        names: ["typecheck"],
        run: async (_name, cwd) => {
          seenCwds.push(cwd)
          if (!existsSync(cwd)) {
            throw new Error(`yrd: cannot run 'typecheck' — its working directory '${cwd}' does not exist`)
          }
          return { stdout: "", stderr: "", exitCode: 0, signal: null, durationMs: 1, timedOut: false }
        },
        install: async (cwd) => {
          if (!existsSync(cwd)) {
            throw new Error(`yrd: cannot install — its working directory '${cwd}' does not exist`)
          }
          return join(cwd, ".git/yrd/hooks/pre-submit")
        },
      }
      const output = outputIO({ cwd: cwdRoot, currentBranch: () => "main" })

      const exit = await runYrd(app, yrd("pr", "submit", "B1"), output.io, { checks: realWorkspaceChecks })
      expect(exit, output.stderr()).toBe(0)

      // Required checks ran in the invoking tree against the durable branch
      // ref — never once in the deleted Bay path.
      expect(seenCwds).toEqual([cwdRoot])

      const resubmitted = app.bays.pr("PR1")
      expect(changeDeliveryState(resubmitted!)).toBe("submitted")
      expect(resubmitted?.branch).toBe(branch)
      expect(currentChangeRev(resubmitted!).head).toBe(originalHead)
    } finally {
      safeRemoveSync(bayRoot, { within: tmpdir(), allowMissing: true })
      safeRemoveSync(cwdRoot, { within: tmpdir(), allowMissing: true })
    }
  })

  it("leaves a direct submission predecessor for the Queue driver and queues the fresh revision", async () => {
    const checkedRevisions: string[] = []
    const app = await createApp({ checkedRevisions })
    await app.bays.submit({
      branch: "topic/direct",
      headSha: HEAD_SHA,
      base: "main",
    })
    await app.bays.requestChecks({ pr: "PR1" })
    expect(await app.queue.admit({ prs: ["PR1"] })).toEqual(["PR1"])
    const predecessorJob = revisionAdmissionJob(app, "PR1")
    expect(predecessorJob).toMatchObject({ status: "queued" })

    const submit = outputIO({ resolveRevision: () => Promise.resolve(MERGED_SHA) })
    expect(await runYrd(app, yrd("pr", "submit", "topic/direct", "--json"), submit.io), submit.stderr()).toBe(0)

    expect(checkedRevisions).toEqual([])
    expect(app.jobs.get(predecessorJob!.id)).toMatchObject({ status: "completed", conclusion: "cancelled" })
    const revision = currentChangeRev(app.state().bays.prs.PR1!)
    expect(revision).toMatchObject({
      n: 2,
      head: MERGED_SHA,
    })
    expect(revision).not.toHaveProperty("admission")
    expect(app.queue.checks(["PR1"])).toMatchObject([{ pr: "PR1", revision: 2, status: "queued" }])
    expect(Queues.ids(app.state().queues)).toEqual([])
  })

  it("rejects every retired route without journaling an event", async () => {
    const app = await createApp()
    const retiredQueueNoun = ["li", "ne"].join("")
    const retiredIssueNoun = ["ta", "sk"].join("")
    const retiredIntegrate = ["inte", "grate"].join("")
    const retiredHold = ["ho", "ld"].join("")
    const retiredRelease = ["re", "lease"].join("")
    const retiredRetry = `--${["re", "try"].join("")}`
    for (const args of [
      [retiredQueueNoun],
      [retiredIssueNoun],
      ["run"],
      [retiredIntegrate],
      [retiredHold],
      [retiredRelease],
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

    const changeSubmit = outputIO({ columns: 100 })
    expect(await runYrd(app, yrd("pr", "submit", "--help"), changeSubmit.io)).toBe(0)
    expect(changeSubmit.stdout()).toContain("--base <branch>")
    expect(changeSubmit.stdout()).toContain("--keep-on-failure")
    expect(changeSubmit.stdout()).not.toContain(`--${["li", "ne"].join("")} <branch>`)
  })

  it("uses one friendly Bay root and the compact BAY STATUS ISSUE BY BASE BRANCH table", async () => {
    const app = await createApp()
    await openTestBay(app, {
      name: "friendly",
      issue: "@km/test/friendly",
      by: "@dev/friendly",
      branch: "task/friendly-branch-that-uses-the-available-width",
    })
    vi.stubEnv("HOME", "/repo")
    try {
      const list = outputIO({ columns: 120 })
      expect(await runYrd(app, yrd("bay", "list"), list.io), list.stderr()).toBe(0)
      const lines = stripAnsi(list.stdout()).trimEnd().split("\n")
      expect(lines[0]).toBe("Bays in ~/.bays/")
      expect(lines[1]).toBe("")
      expect(lines[2]?.trim().split(/\s+/u)).toEqual(["BAY", "STATUS", "ISSUE", "BY", "BASE", "BRANCH"])
      expect(lines[3]).toContain("B1")
      expect(lines[3]).toContain("open")
      expect(lines[3]).toContain("@km/test/friendly")
      expect(lines[3]).toContain("@dev/friendly")
      expect(lines[3]).toContain("main")
      expect(lines[3]).toContain("task/friendly-branch-that-uses-the-available-width")
      expect(list.stdout()).not.toContain(retiredRoleNoun.toUpperCase())
      expect(list.stdout()).not.toContain("PATH")

      const json = outputIO()
      expect(await runYrd(app, yrd("bay", "list", "--json"), json.io), json.stderr()).toBe(0)
      const listed = JSON.parse(json.stdout()) as Readonly<{ bays: readonly Record<string, unknown>[] }>
      expect(listed.bays[0]).toMatchObject({ by: "@dev/friendly", status: "open", nativeStatus: "active" })
      expect(listed.bays[0]).not.toHaveProperty(retiredRoleNoun)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("lists only open Bays by default and makes terminal history explicit", async () => {
    const app = await createApp({ failingBay: "B3" })
    await openTestBay(app, { name: "open" })
    await openTestBay(app, { name: "done" })

    const close = outputIO()
    expect(await runYrd(app, yrd("bay", "close", "--force", "B2"), close.io), close.stderr()).toBe(0)

    const failedOpen = await app.bays.open({ name: "fail", by: "test" })
    const failedJobs = await app.jobs.runMany(app.jobs.requested(failedOpen), {
      runner: "cli-test",
      leaseMs: 60_000,
    })
    expect(failedJobs).toEqual([
      expect.objectContaining({
        status: "completed",
        conclusion: "failure",
        error: expect.objectContaining({ code: "provision-failed" }),
      }),
    ])
    expect(Object.values(app.state().bays.byId).map((bay) => bay.status)).toEqual(["active", "closed", "closed"])

    const open = outputIO()
    expect(await runYrd(app, yrd("bay", "list", "--json"), open.io), open.stderr()).toBe(0)
    expect(JSON.parse(open.stdout())).toMatchObject({
      bays: [{ id: "B1", status: "open", nativeStatus: "active" }],
      lifecycles: [{ bay: "B1", status: "open" }],
    })

    const closed = outputIO()
    expect(await runYrd(app, yrd("bay", "list", "--closed", "--json"), closed.io), closed.stderr()).toBe(0)
    expect(JSON.parse(closed.stdout())).toMatchObject({
      bays: [
        { id: "B2", status: "done", nativeStatus: "closed" },
        { id: "B3", status: "fail", nativeStatus: "closed" },
      ],
    })

    const all = outputIO()
    expect(await runYrd(app, yrd("bay", "list", "--all", "--json"), all.io), all.stderr()).toBe(0)
    const allListed = JSON.parse(all.stdout()) as Readonly<{ bays: readonly Record<string, unknown>[] }>
    expect(allListed.bays).toMatchObject([
      { id: "B1", status: "open" },
      { id: "B2", status: "done" },
      { id: "B3", status: "fail" },
    ])

    const conflict = outputIO()
    expect(await runYrd(app, yrd("bay", "list", "--all", "--closed"), conflict.io)).toBe(2)
    expect(conflict.stderr()).toContain("--all and --closed are mutually exclusive")
  })

  it.each([
    ["yrd bay", yrd("bay", "ls", "--json")],
    ["yrd bay", yrdBay("list", "--json")],
  ] as const)("accepts %s ls as the bay list alias", async (_surface, argv) => {
    const app = await createApp()
    const output = outputIO()
    expect(await runYrd(app, argv, output.io), output.stderr()).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({ bays: [] })
  })

  it("closes a failed provision without a workspace as closed-degenerate and releases its branch", async () => {
    const app = await createApp({ failingBay: "B1" })
    const failedOpen = await app.bays.open({ name: "pathless", branch: "task/reusable", by: "test" })
    await app.jobs.runMany(app.jobs.requested(failedOpen), {
      runner: "cli-test",
      leaseMs: 60_000,
    })
    expect(app.bays.get("B1")).toMatchObject({
      status: "closed",
      closure: { kind: "closed-degenerate" },
      failure: { code: "provision-failed" },
    })
    expect(app.bays.get("B1")).not.toHaveProperty("path")

    await app.bays.open({ name: "replacement", branch: "task/reusable", by: "test" })
    expect(app.bays.get("B2")).toMatchObject({ branch: "task/reusable", status: "opening" })
  })

  it("force-closes an already-closed (closed-degenerate) bay instead of refusing — the B280/B286 shape", async () => {
    // REGRESSION @i/10-yrd/bay-prune-without-data-loss. Provision failure already
    // auto-transitions a pathless Bay to closed-degenerate (status: "closed") at
    // failure time — the sibling test above proves that. But an operator who runs
    // `bay close --force` on that SAME bay (not knowing it already auto-closed —
    // exactly the B280/B286 incident) hit a hard, unconditional "already closed"
    // refusal regardless of --force: the escape hatch refused the one case it
    // exists to override. The branch-reuse guard already keys off `status ===
    // "closed"`, so the branch was never actually locked once closed-degenerate
    // fired — the operator only ever SAW a refusal and had no way to confirm
    // that from the CLI, so the incident routed around it with a fresh bay.
    const app = await createApp({ failingBay: "B1" })
    const failedOpen = await app.bays.open({ name: "pathless", branch: "task/already-closed", by: "test" })
    await app.jobs.runMany(app.jobs.requested(failedOpen), { runner: "cli-test", leaseMs: 60_000 })
    expect(app.bays.get("B1")).toMatchObject({
      status: "closed",
      closure: { kind: "closed-degenerate" },
    })

    const close = outputIO()
    expect(await runYrd(app, yrd("bay", "close", "--force", "B1"), close.io), close.stderr()).toBe(0)
    expect(app.bays.get("B1")).toMatchObject({ status: "closed", closure: { kind: "closed-degenerate" } })

    // Releases the lock: a fresh bay can reuse the same branch afterward.
    await app.bays.open({ name: "replacement", branch: "task/already-closed", by: "test" })
    expect(app.bays.get("B2")).toMatchObject({ branch: "task/already-closed", status: "opening" })
  })

  it("still refuses a bare (non-force) close on an already-closed bay", async () => {
    // The --force override is deliberate and announced; a bare close on an
    // already-closed bay keeps refusing with the same informative message so a
    // caller who did not ask for the override still learns the bay is done.
    const app = await createApp({ failingBay: "B1" })
    const failedOpen = await app.bays.open({ name: "pathless", branch: "task/no-force", by: "test" })
    await app.jobs.runMany(app.jobs.requested(failedOpen), { runner: "cli-test", leaseMs: 60_000 })
    expect(app.bays.get("B1")).toMatchObject({ status: "closed" })

    const close = outputIO()
    expect(await runYrd(app, yrd("bay", "close", "B1"), close.io)).not.toBe(0)
    expect(close.stderr()).toContain("already closed")
  })

  it("refuses --force on an already-closed bay whose freed branch a live change now owns", async () => {
    // REGRESSION @i/10-yrd/bay-prune-without-data-loss (lead amendment, originally
    // @yrd/submit-records-or-refuses box 3 / bead 23160: "a submitted change resolves
    // through its bay's mutable path, so deleting the bay strands it"). This is the
    // already-closed --force shortcut above COMBINED with branch reuse (the sibling
    // "closes a failed provision... releases its branch" test): B1's provision fails
    // pre-workspace and frees branch task/shared-live; B2 reuses that SAME branch and
    // submits a live, unmerged change from it. B1 is a different, already-closed bay,
    // but closeBay's own PR lookup falls back to a branch match (changeForBay(bay.id)
    // ?? resolveChange(bay.branch)) — so `close --force B1` must still resolve PR1 as
    // the live change on that branch and refuse, naming the change and both cures
    // (withdraw, or run it through the merge queue). No prune path — --force here, or
    // the timer-driven admin bay prune --apply that calls the same closeBay — may ever
    // delete a bay a live, unwithdrawn change still depends on.
    const app = await createApp({ failingBay: "B1" })
    const failedOpen = await app.bays.open({ name: "pathless", branch: "task/shared-live", by: "test" })
    await app.jobs.runMany(app.jobs.requested(failedOpen), { runner: "cli-test", leaseMs: 60_000 })
    expect(app.bays.get("B1")).toMatchObject({ status: "closed", closure: { kind: "closed-degenerate" } })

    await openTestBay(app, { name: "replacement", branch: "task/shared-live" })
    await submitBayFixture(app, "B2")
    expect(changeDeliveryState(app.bays.pr("PR1")!)).toBe("submitted")

    const close = outputIO()
    expect(await runYrd(app, yrd("bay", "close", "--force", "B1"), close.io)).not.toBe(0)
    expect(close.stderr()).toContain("PR1")
    expect(close.stderr()).toContain("merge queue")
    expect(close.stderr()).toContain("--withdraw")
    // Neither B1 nor the live change moved.
    expect(app.bays.get("B1")).toMatchObject({ status: "closed" })
    expect(changeDeliveryState(app.bays.pr("PR1")!)).toBe("submitted")
  })

  it("refuses both prune and --force on a Bay whose change is submitted and unmerged", async () => {
    // REGRESSION @i/10-yrd/bay-prune-without-data-loss (lead amendment; @yrd/submit-records-or-refuses
    // box 3, originally bead 23160). The plain, single-bay shape: no prune path — the census a
    // timer-driven `admin bay prune --apply` consults, or a direct `bay close --force` — may ever
    // delete a bay a live, unwithdrawn change still resolves through.
    const app = await createApp()
    await openTestBay(app, { name: "live-change", branch: "task/live-change" })
    await submitBayFixture(app, "B1")
    expect(changeDeliveryState(app.bays.pr("PR1")!)).toBe("submitted")

    const prune = outputIO()
    expect(await runYrd(app, yrd("admin", "bay", "prune", "--json"), prune.io), prune.stderr()).toBe(1)
    expect(JSON.parse(prune.stdout())).toMatchObject({
      dryRun: true,
      outcomes: { prunable: [], kept: [{ bay: "B1", reasons: ["pr"] }], paged: [] },
    })

    const close = outputIO()
    expect(await runYrd(app, yrd("bay", "close", "--force", "B1"), close.io)).not.toBe(0)
    expect(close.stderr()).toContain("PR1")
    expect(close.stderr()).toContain("merge queue")
    expect(close.stderr()).toContain("--withdraw")
    expect(app.bays.get("B1")).toMatchObject({ status: "active" })
    expect(changeDeliveryState(app.bays.pr("PR1")!)).toBe("submitted")
  })

  it("classifies a closed-degenerate bay as all-PASS through the status CLI, not just in the store", async () => {
    // REGRESSION @yrd/22609-bayprune. The sibling test above proves the PERSISTED state is
    // right and stops there. The consumer read it back off `status === "failed"`, a literal
    // the bay domain never assigns, so `closedDegenerate` was never derived and the all-PASS
    // path in classifyBayStatus was unreachable from every CLI surface. The store was correct
    // and the answer was still wrong, which is the half a store-only assertion cannot see.
    const app = await createApp({ failingBay: "B1" })
    const failedOpen = await app.bays.open({ name: "pathless", branch: "task/degenerate", by: "test" })
    await app.jobs.runMany(app.jobs.requested(failedOpen), { runner: "cli-test", leaseMs: 60_000 })
    expect(app.bays.get("B1")).toMatchObject({ status: "closed", closure: { kind: "closed-degenerate" } })

    const output = outputIO()
    expect(await runYrd(app, yrd("bay", "status", "B1", "--json"), output.io), output.stderr()).toBe(0)
    const report = JSON.parse(output.stdout()) as Readonly<{
      reports: ReadonlyArray<
        Readonly<{ bay: string; exit: number; safe: boolean; lines: ReadonlyArray<{ verdict: string }> }>
      >
    }>
    expect(report.reports).toHaveLength(1)
    expect(report.reports[0]).toMatchObject({ bay: "B1", exit: 0, safe: true })
    // Every class PASSes on the absence of a workspace — the absence IS the certificate.
    const verdicts = report.reports[0]?.lines.map((line) => line.verdict) ?? []
    expect(verdicts.length).toBeGreaterThan(0)
    expect(verdicts).toEqual(verdicts.map(() => "PASS"))
  })

  it("uses by, submitter, and reviewer throughout CLI help", async () => {
    const app = await createApp()
    for (const args of [
      ["pr", "list"],
      ["pr", "create"],
      ["pr", "submit"],
      ["pr", "review"],
      ["pr", "request-review"],
      ["pr", "comment"],
      ["contest", "select"],
    ]) {
      const help = outputIO()
      expect(await runYrd(app, yrd(...args, "--help"), help.io), args.join(" ")).toBe(0)
      expect(help.stdout(), args.join(" ")).not.toMatch(new RegExp(`\\b${retiredRoleNoun}s?\\b`, "iu"))
    }
  })

  it("refreshes and closes an active Bay through installed command refs while driving jobs", async () => {
    const app = await createApp()
    await openTestBay(app, { name: "fix-readme", branch: "topic/readme" })

    const state = app.state()
    expect(state.bays.byId.B1).toMatchObject({
      name: "fix-readme",
      branch: "topic/readme",
      status: "active",
      path: "/repo/.bays/B1",
    })
    expect(Object.values(state.jobs.byId)).toContainEqual(
      expect.objectContaining({ definition: "bay.provision", status: "completed", conclusion: "success" }),
    )

    const refresh = outputIO({ cwd: "/repo/.bays/B1" })
    expect(await runYrd(app, yrd("bay", "refresh"), refresh.io)).toBe(0)
    expect(refresh.stdout()).toContain("B1")
    expect(refresh.stdout()).toContain("active")
    const refreshed = app.state()
    expect(Object.values(refreshed.jobs.byId)).toContainEqual(
      expect.objectContaining({ definition: "bay.refresh", status: "completed", conclusion: "success" }),
    )

    const close = outputIO({ cwd: "/repo/.bays/B1" })
    expect(await runYrd(app, yrd("bay", "close", "--force", "B1"), close.io)).toBe(0)
    expect(close.stdout()).toContain("closed fix-readme\n")
    expect(app.state().bays.byId.B1?.status).toBe("closed")
  })

  it("reaps the current Bay root when the recorded path predates a repository move", async () => {
    const app = await createApp()
    await openTestBay(app, { name: "moved-root", branch: "topic/moved-root" })
    const currentPath = "/repo/current/.bays/B1"
    const reaped: string[] = []
    const services = {
      resolveBayWorkspacePath: () => currentPath,
      process: {
        run: async () => ({
          stdout: `${"0".repeat(39)}1\n`,
          stderr: "",
          exitCode: 0,
          signal: null,
          durationMs: 0,
          timedOut: false,
        }),
        reapPath: async (path: string) => {
          reaped.push(path)
          return completePathReapResult()
        },
      },
    } as unknown as YrdCliServices
    const close = outputIO()

    expect(await runYrd(app, yrd("bay", "close", "--force", "B1"), close.io, services), close.stderr()).toBe(0)
    expect(reaped).toEqual([currentPath, currentPath])
  })

  it("refuses Bay deletion when the final holder census is incomplete", async () => {
    const app = await createApp()
    await openTestBay(app, { name: "blind-holder-census", branch: "topic/blind-holder-census" })
    const source = () => ({ readable: 1, unavailable: { exited: 0, denied: 0 } })
    const services = {
      process: {
        reapPath: async () => ({
          targetedPids: [],
          survivorPids: [],
          survivorHolders: [],
          survivorCoverage: {
            platform: "linux",
            scope: "same-uid",
            procRoot: "/proc",
            complete: false,
            processes: { enumerated: 1, sameUid: 1, otherUid: 0, unavailable: { exited: 0, denied: 0 } },
            sources: {
              cwd: source(),
              exe: source(),
              root: source(),
              maps: source(),
              fd: { readable: 0, unavailable: { exited: 0, denied: 1 } },
            },
          },
          forcedKill: false,
          signalFailures: [],
        }),
      },
    } as unknown as YrdCliServices
    const close = outputIO()

    expect(await runYrd(app, yrd("bay", "close", "--force", "B1"), close.io, services)).toBe(3)
    expect(close.stderr()).toMatch(/census incomplete.*same-uid.*denied/iu)
    expect(app.state().bays.byId.B1?.status).toBe("active")
  })

  it("admin bay prune refuses a Bay protected by a live external consumer", async () => {
    const app = await createApp()
    await openTestBay(app, { name: "protected", branch: "topic/protected" })
    const output = outputIO({
      bayProtections: [
        {
          bay: "B1",
          path: "/repo/.bays/B1",
          source: "inhab-status",
          evidence: "Inhab status home @dev.1 last state is ready",
        },
      ],
    })

    expect(await runYrd(app, yrd("admin", "bay", "prune", "--json"), output.io), output.stderr()).toBe(1)
    const result = JSON.parse(output.stdout()) as {
      examined: number
      outcomes: {
        prunable: readonly string[]
        kept: readonly unknown[]
        paged: readonly unknown[]
      }
      histogram: {
        prunable: number
        keptByReason: Readonly<Record<string, number>>
        pagedByReason: Readonly<Record<string, number>>
      }
    }
    expect(result).toMatchObject({
      command: "bay.prune",
      dryRun: true,
      examined: 1,
      closed: [],
      outcomes: {
        prunable: [],
        kept: [{ bay: "B1", reasons: ["consumer"] }],
        paged: [],
      },
      histogram: {
        prunable: 0,
        keptByReason: { consumer: 1 },
        pagedByReason: {},
      },
    })
    expect(result.outcomes.prunable.length + result.outcomes.kept.length + result.outcomes.paged.length).toBe(
      result.examined,
    )
    expect(
      result.histogram.prunable +
        Object.values(result.histogram.keptByReason).reduce((sum, count) => sum + count, 0) +
        Object.values(result.histogram.pagedByReason).reduce((sum, count) => sum + count, 0),
    ).toBe(result.examined)
    expect(app.state().bays.byId.B1?.status).toBe("active")
  })

  it("reports the repository scope when the prune census is empty", async () => {
    const app = await createApp()
    const output = outputIO({ cwd: "/repo" })

    expect(await runYrd(app, yrd("admin", "bay", "prune", "--json"), output.io), output.stderr()).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({
      command: "bay.prune",
      dryRun: true,
      repository: "/repo",
      examined: 0,
      excluded: [],
      outcomes: { prunable: [], kept: [], paged: [] },
    })
  })

  it("admin bay prune decides a missing worktree from its persisted head", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-bay-prune-missing-worktree-"))
    const remote = join(root, "remote.git")
    const repo = join(root, "repo")
    const missingBay = join(root, "missing-bay")
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
    try {
      execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" })
      execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" })
      git(repo, "config", "user.name", "Yrd Test")
      git(repo, "config", "user.email", "yrd@example.invalid")
      writeFileSync(join(repo, "README.md"), "base\n")
      git(repo, "add", "README.md")
      git(repo, "commit", "-qm", "base")
      git(repo, "remote", "add", "origin", remote)
      git(repo, "push", "-u", "origin", "main")

      const headSha = git(repo, "rev-parse", "HEAD")
      const app = await createApp({ bayPath: missingBay, provisionedHead: headSha })
      await openTestBay(app, { name: "missing-worktree", branch: "task/missing-worktree" })
      await openTestBay(app, { name: "missing-worktree-two", branch: "task/missing-worktree-two" })
      await openTestBay(app, { name: "missing-worktree-three", branch: "task/missing-worktree-three" })
      const now = () => Date.parse("2026-07-12T12:01:00.000Z")
      const statusOutput = outputIO({ cwd: repo, now })

      expect(await runYrd(app, yrd("bay", "status", "B1", "--json"), statusOutput.io)).toBe(0)
      const status = JSON.parse(statusOutput.stdout()) as Readonly<{
        reports: ReadonlyArray<Readonly<{ lines: ReadonlyArray<Readonly<{ evidence: string }>> }>>
      }>
      expect(status.reports[0]?.lines).toContainEqual({
        class: "commits",
        verdict: "PASS",
        evidence:
          "branch is absent from origin after a fresh pruned fetch and the tip has no unique commits (proof used persisted Bay head)",
      })

      const output = outputIO({ cwd: repo, now })

      const exit = await runYrd(app, yrd("admin", "bay", "prune", "--json"), output.io)
      expect(JSON.parse(output.stdout())).toMatchObject({
        examined: 3,
        outcomes: { prunable: ["B1", "B2", "B3"], kept: [], paged: [] },
        histogram: { prunable: 3, keptByReason: {}, pagedByReason: {} },
      })
      expect(exit, output.stderr()).toBe(0)

      const help = outputIO({ cwd: repo, now })
      expect(await runYrd(app, yrd("admin", "bay", "prune", "--help"), help.io), help.stderr()).toBe(0)
      expect(help.stdout()).toContain("--save-approval <path>")
      expect(help.stdout()).toContain("--approval <path>")
      expect(help.stdout()).toContain("--exclude <bay>")

      const excludedApprovalPath = join(root, "excluded-approval.json")
      const excludedApproval = outputIO({ cwd: repo, now })
      expect(
        await runYrd(
          app,
          yrd(
            "admin",
            "bay",
            "prune",
            "--exclude",
            "B2",
            "--exclude",
            "B3",
            "--save-approval",
            excludedApprovalPath,
            "--json",
          ),
          excludedApproval.io,
        ),
        excludedApproval.stderr(),
      ).toBe(0)
      const excludedArtifact = JSON.parse(readFileSync(excludedApprovalPath, "utf8"))
      const excludedFingerprint = createHash("sha256")
        .update('version=1\nprunable=["B1"]\nexcluded=["B2","B3"]\n')
        .digest("hex")
      expect(excludedArtifact).toEqual({
        version: 1,
        prunable: ["B1"],
        excluded: ["B2", "B3"],
        fingerprint: `sha256:${excludedFingerprint}`,
      })

      const approvalPath = join(root, "approval.json")
      const approval = outputIO({ cwd: repo, now })
      expect(
        await runYrd(app, yrd("admin", "bay", "prune", "--save-approval", approvalPath, "--json"), approval.io),
        approval.stderr(),
      ).toBe(0)

      const bareApply = outputIO({ cwd: repo, now })
      expect(await runYrd(app, yrd("admin", "bay", "prune", "--apply", "--json"), bareApply.io)).toBe(2)
      expect(bareApply.stderr()).toContain("--apply requires --approval <path>")

      const missingApprovalPath = join(root, "missing-approval.json")
      const missingApproval = outputIO({ cwd: repo, now })
      expect(
        await runYrd(
          app,
          yrd("admin", "bay", "prune", "--apply", "--approval", missingApprovalPath, "--json"),
          missingApproval.io,
        ),
      ).toBe(2)
      expect(missingApproval.stderr()).toContain(missingApprovalPath)
      expect(missingApproval.stderr()).toContain("cannot read bay prune approval")

      const tamperedApprovalPath = join(root, "tampered-approval.json")
      const approvalArtifact = JSON.parse(readFileSync(approvalPath, "utf8")) as Record<string, unknown>
      writeFileSync(
        tamperedApprovalPath,
        JSON.stringify({
          ...approvalArtifact,
          fingerprint: `sha256:${"0".repeat(64)}`,
        }),
      )
      const tamperedApproval = outputIO({ cwd: repo, now })
      expect(
        await runYrd(
          app,
          yrd("admin", "bay", "prune", "--apply", "--approval", tamperedApprovalPath, "--json"),
          tamperedApproval.io,
        ),
      ).toBe(1)
      expect(tamperedApproval.stderr()).toContain(tamperedApprovalPath)
      expect(tamperedApproval.stderr()).toContain("fingerprint mismatch")

      const excludedApply = outputIO({ cwd: repo, now })
      expect(
        await runYrd(
          app,
          yrd("admin", "bay", "prune", "--apply", "--approval", approvalPath, "--exclude", "B3", "--json"),
          excludedApply.io,
        ),
      ).toBe(2)
      expect(excludedApply.stderr()).toContain("--exclude cannot be combined with --apply")

      const protectedApprovalPath = join(root, "protected-approval.json")
      const protectedApproval = outputIO({
        cwd: repo,
        now,
        bayProtections: [
          {
            bay: "B3",
            path: "/repo/.bays/B3",
            source: "inhab-status",
            evidence: "Inhab status home @dev.3 last state is ready",
          },
        ],
      })
      expect(
        await runYrd(
          app,
          yrd("admin", "bay", "prune", "--save-approval", protectedApprovalPath, "--json"),
          protectedApproval.io,
        ),
        protectedApproval.stderr(),
      ).toBe(0)
      const becamePrunable = outputIO({ cwd: repo, now })
      expect(
        await runYrd(
          app,
          yrd("admin", "bay", "prune", "--apply", "--approval", protectedApprovalPath, "--json"),
          becamePrunable.io,
        ),
      ).toBe(1)
      expect(becamePrunable.stderr()).toContain(protectedApprovalPath)
      expect(becamePrunable.stderr()).toContain("becamePrunable: B3")
      expect(becamePrunable.stderr()).toContain("becameProtected: none")

      const driftedApply = outputIO({
        cwd: repo,
        now,
        bayProtections: [
          {
            bay: "B2",
            path: "/repo/.bays/B2",
            source: "inhab-status",
            evidence: "Inhab status home @dev.2 last state is ready",
          },
        ],
      })
      expect(
        await runYrd(
          app,
          yrd("admin", "bay", "prune", "--apply", "--approval", approvalPath, "--json"),
          driftedApply.io,
        ),
      ).toBe(1)
      expect(driftedApply.stderr()).toContain(approvalPath)
      expect(driftedApply.stderr()).toContain("becamePrunable: none")
      expect(driftedApply.stderr()).toContain("becameProtected: B2")
      expect(app.state().bays.byId.B1?.status).toBe("active")

      const apply = outputIO({ cwd: repo, now })
      let reapAttempts = 0
      const failingServices = {
        process: {
          reapPath: async () => {
            reapAttempts += 1
            if (reapAttempts === 3) throw new Error("simulated reap failure")
            return completePathReapResult()
          },
        },
      } as unknown as YrdCliServices

      expect(
        await runYrd(
          app,
          yrd("admin", "bay", "prune", "--apply", "--approval", approvalPath, "--json"),
          apply.io,
          failingServices,
        ),
      ).toBe(3)
      expect(JSON.parse(apply.stdout())).toMatchObject({
        closed: ["B1"],
        failed: [{ bay: "B2", error: "Bay 'missing-worktree-two' was not closed: simulated reap failure" }],
        notAttempted: ["B3"],
        outcomes: { prunable: ["B1", "B2", "B3"], kept: [], paged: [] },
      })
      expect(apply.stderr()).toContain("simulated reap failure")
      expect(app.state().bays.byId.B1?.status).toBe("closed")
      expect(app.state().bays.byId.B2?.status).toBe("active")
      expect(app.state().bays.byId.B3?.status).toBe("active")

      const remainingApprovalPath = join(root, "remaining-approval.json")
      const remainingApproval = outputIO({ cwd: repo, now })
      expect(
        await runYrd(
          app,
          yrd("admin", "bay", "prune", "--save-approval", remainingApprovalPath, "--json"),
          remainingApproval.io,
        ),
        remainingApproval.stderr(),
      ).toBe(0)

      const successfulApply = outputIO({ cwd: repo, now })
      const successfulServices = {
        process: {
          reapPath: async () => completePathReapResult(),
        },
      } as unknown as YrdCliServices

      expect(
        await runYrd(
          app,
          yrd("admin", "bay", "prune", "--apply", "--approval", remainingApprovalPath, "--json"),
          successfulApply.io,
          successfulServices,
        ),
        successfulApply.stderr(),
      ).toBe(0)
      expect(successfulApply.stdout().trim().split("\n")).toHaveLength(1)
      expect(JSON.parse(successfulApply.stdout())).toMatchObject({
        closed: ["B2", "B3"],
        failed: [],
        notAttempted: [],
        outcomes: { prunable: ["B2", "B3"], kept: [], paged: [] },
      })
      expect(app.state().bays.byId.B2?.status).toBe("closed")
      expect(app.state().bays.byId.B3?.status).toBe("closed")
    } finally {
      safeRemoveSync(root, { within: tmpdir(), allowMissing: true })
    }
  })

  it("counts a multi-reason Bay once in the conservation histogram", () => {
    const result = runInternals.bayPruneOutcomes(
      [
        {
          bay: "B1",
          name: "multiply-blocked",
          branch: "task/multiply-blocked",
          wrapper: "git",
          lines: [
            { class: "consumer", verdict: "BLOCK", evidence: "live consumer" },
            { class: "worktree", verdict: "BLOCK", evidence: "dirty worktree" },
          ],
          exit: 1,
          safe: false,
        },
      ],
      new Set(),
    )

    expect(result.rows.kept).toEqual([{ bay: "B1", reasons: ["consumer", "worktree"] }])
    expect(result.histogram).toEqual({ pruned: 0, keptByReason: { consumer: 1 }, pagedByReason: {} })
    expect(
      result.histogram.pruned +
        Object.values(result.histogram.keptByReason).reduce((sum, count) => sum + count, 0) +
        Object.values(result.histogram.pagedByReason).reduce((sum, count) => sum + count, 0),
    ).toBe(1)
  })

  it("pages with conservation JSON when the host process-CWD census is unavailable", async () => {
    const app = await createApp()
    await openTestBay(app, { name: "census-gap", branch: "task/census-gap" })
    const output = outputIO({
      bayProtections: [
        {
          bay: "*",
          path: "/repo/.bays",
          source: "live-process-cwd-unavailable",
          evidence: "process CWD census unavailable: permission denied",
        },
      ],
    })

    expect(await runYrd(app, yrd("admin", "bay", "prune", "--json"), output.io), output.stderr()).toBe(1)
    const result = JSON.parse(output.stdout()) as {
      examined: number
      outcomes: { prunable: readonly string[]; kept: readonly unknown[]; paged: readonly { reasons: string[] }[] }
      histogram: {
        prunable: number
        keptByReason: Readonly<Record<string, number>>
        pagedByReason: Readonly<Record<string, number>>
      }
    }
    expect(result).toMatchObject({
      command: "bay.prune",
      dryRun: true,
      examined: 1,
      outcomes: { prunable: [], kept: [], paged: [{ bay: "B1", reasons: expect.arrayContaining(["consumer"]) }] },
    })
    expect(
      result.histogram.prunable +
        Object.values(result.histogram.keptByReason).reduce((sum, count) => sum + count, 0) +
        Object.values(result.histogram.pagedByReason).reduce((sum, count) => sum + count, 0),
    ).toBe(result.examined)
  })

  it("admin bay prune preserves a dirty Bay and pages it for the next pass", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-bay-prune-dirty-"))
    const remote = join(root, "remote.git")
    const repo = join(root, "repo")
    const bay = join(root, "bay")
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
    try {
      execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" })
      execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" })
      git(repo, "config", "user.name", "Yrd Test")
      git(repo, "config", "user.email", "yrd@example.invalid")
      writeFileSync(join(repo, "README.md"), "base\n")
      git(repo, "add", "README.md")
      git(repo, "commit", "-qm", "base")
      git(repo, "remote", "add", "origin", remote)
      git(repo, "push", "-u", "origin", "main")
      execFileSync("git", ["clone", "-q", remote, bay], { stdio: "ignore" })
      writeFileSync(join(bay, "dirty.txt"), "preserve me\n")

      const app = await createApp({ bayPath: bay, dirtyBay: true })
      await openTestBay(app, { name: "dirty", branch: "task/dirty" })
      const now = () => Date.parse("2026-07-11T12:01:00.000Z")
      const protectedOutput = outputIO({
        cwd: repo,
        now,
        bayProtections: [
          {
            bay: "B1",
            path: bay,
            source: "inhab-status",
            evidence: "Inhab status home @dev.1 last state is ready",
          },
        ],
      })

      expect(
        await runYrd(app, yrd("admin", "bay", "prune", "--json"), protectedOutput.io),
        protectedOutput.stderr(),
      ).toBe(1)
      expect(JSON.parse(protectedOutput.stdout())).toMatchObject({
        preserved: [],
        outcomes: { kept: [{ bay: "B1", reasons: expect.arrayContaining(["consumer", "worktree"]) }] },
      })
      expect(Object.values(app.state().jobs.byId).filter((job) => job.definition === "bay.checkpoint")).toHaveLength(0)
      expect(app.bays.get("B1")).toMatchObject({ status: "active" })

      const approvalPath = join(root, "dirty-approval.json")
      const approval = outputIO({ cwd: repo, now })
      expect(
        await runYrd(app, yrd("admin", "bay", "prune", "--save-approval", approvalPath, "--json"), approval.io),
        approval.stderr(),
      ).toBe(1)

      const output = outputIO({ cwd: repo, now })

      expect(
        await runYrd(app, yrd("admin", "bay", "prune", "--apply", "--approval", approvalPath, "--json"), output.io),
        output.stderr(),
      ).toBe(1)
      expect(JSON.parse(output.stdout())).toMatchObject({
        command: "bay.prune",
        preserved: ["B1"],
        outcomes: { prunable: [], kept: [], paged: [{ bay: "B1", reasons: ["worktree"] }] },
        histogram: { prunable: 0, keptByReason: {}, pagedByReason: { worktree: 1 } },
      })
      expect(app.bays.get("B1")).toMatchObject({ status: "active", dirty: false })
      expect(readFileSync(join(bay, "dirty.txt"), "utf8")).toBe("preserve me\n")
    } finally {
      safeRemoveSync(root, { within: tmpdir(), allowMissing: true })
    }
  })

  it("closes a draft-backed Bay without withdrawing its PR", async () => {
    const app = await createApp({ waitingCheck: true })
    await openTestBay(app, { name: "draft-close" })

    const create = outputIO({ cwd: "/repo/.bays/B1" })
    expect(await runYrd(app, yrd("pr", "create"), create.io), create.stderr()).toBe(0)
    expect(changeDeliveryState(app.bays.pr("PR1")!)).toBe("pushed")
    expect(app.bays.pr("PR1")).toMatchObject({ bay: "B1" })
    await app.bays.requestChecks({ pr: "PR1" })
    expect(await app.queue.admit({ prs: ["PR1"] })).toEqual(["PR1"])
    const checkJob = revisionAdmissionJob(app, "PR1")
    expect(checkJob).toMatchObject({ status: "queued" })

    const close = outputIO({ cwd: "/repo/.bays/B1" })
    expect(await runYrd(app, yrd("bay", "close", "--force", "B1"), close.io), close.stderr()).toBe(0)
    expect(app.bays.get("B1")?.status).toBe("closed")
    expect(changeDeliveryState(app.bays.pr("PR1")!)).toBe("pushed")
    expect(app.jobs.get(checkJob!.id)).toMatchObject({ status: "queued" })
  })

  it("names the bay binding and the branch remedy when bare create resolves a finished PR", async () => {
    const checkRuns: string[] = []
    const mergeRuns: string[] = []
    const app = await createApp({ checkRuns, mergeRuns })
    await openTestBay(app, { name: "finished" })

    const submit = outputIO({ cwd: "/repo/.bays/B1" })
    expect(await runYrd(app, yrd("pr", "submit"), submit.io), submit.stderr()).toBe(0)
    const run = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "PR1", "--json"), run.io), run.stderr()).toBe(0)
    expect(changeDeliveryState(app.state().bays.prs.PR1!)).toBe("integrated")

    // The B94 shape (2026-08-19): the bay still binds its finished PR, and a
    // bare `pr create` refused by naming that change — a record the caller never
    // mentioned, on a branch it never named — without saying the bay binding
    // caused the resolution or that a branch selector is the fix.
    const create = outputIO({ cwd: "/repo/.bays/B1" })
    expect(await runYrd(app, yrd("pr", "create"), create.io)).toBe(1)
    expect(create.stderr()).toContain("bay 'B1' is bound to change 'PR1' (integrated)")
    expect(create.stderr()).toContain("pass a branch — yrd pr create <branch>")
  })

  it("refuses a stale implicit Bay binding before gates and names the explicit submit escape", async () => {
    const app = await createApp()
    await openTestBay(app, { name: "withdrawn-binding" })
    await submitBayFixture(app, "B1")
    await app.bays.closePr({ pr: "PR1" })
    await app.bays.submit({ branch: "topic/replacement", headSha: MERGED_SHA, base: "main", draft: true })

    const localChecks: string[] = []
    const checks: YrdCliServices["checks"] = {
      names: ["typecheck"],
      run: async (name) => {
        localChecks.push(name)
        return { stdout: "", stderr: "", exitCode: 0, signal: null, durationMs: 1, timedOut: false }
      },
      install: async () => "/repo/.git/yrd/hooks/pre-submit",
    }
    const bare = outputIO({ cwd: "/repo/.bays/B1", currentBranch: () => "topic/replacement" })

    expect(await runYrd(app, yrd("pr", "submit"), bare.io, { checks })).toBe(1)
    expect(bare.stderr()).toContain("bay 'B1' is bound to change 'PR1' (withdrawn)")
    expect(bare.stderr()).toContain("yrd pr submit PR2")
    expect(localChecks).toEqual([])

    // The escape must resolve the record's branch tip: post-purge the staging
    // pass previews the same resolution path as the real submit, and a live
    // record whose branch cannot be resolved refuses rather than reusing the
    // recorded head.
    const explicit = outputIO({
      cwd: "/repo/.bays/B1",
      currentBranch: () => "topic/replacement",
      resolveRevision: async () => MERGED_SHA,
    })
    expect(await runYrd(app, yrd("pr", "submit", "PR2"), explicit.io, { checks }), explicit.stderr()).toBe(0)
    expect(localChecks).toEqual(["typecheck"])
  })

  it("tells a bayless author which step is missing instead of that a lookup failed", async () => {
    const app = await createApp()

    // The author has a branch, a head and a packet, and no reason to know a Bay
    // was ever involved. `no bay 'X'` is true and useless — it reads as a broken
    // tool, and it cost one seat three escalations and most of a day.
    const refusal = outputIO()
    expect(
      await runYrd(
        app,
        yrd(
          "bay",
          "handoff",
          "task/22716-runner-supervision",
          "--branch",
          "task/22716-runner-supervision",
          "--head",
          HEAD_SHA,
          "--evidence",
          "@km/handoff/bayless.md",
        ),
        refusal.io,
      ),
    ).toBe(1)
    const stderr = refusal.stderr()
    // The remedy, runnable as printed, carrying the author's own branch. The
    // previous pin here certified `bay open --bay <name> --branch …` — a flag
    // `bay open` never had, so the "runnable as printed" claim was false in
    // the field (23055 flavour 2). handoff-remedy-flags.test.ts now validates
    // the remedy's flags against live `bay open --help`.
    expect(stderr).toContain("yrd bay open --pr task/22716-runner-supervision")
    // And WHY a Bay, so the step reads as a requirement rather than a ritual:
    // the workspace is the evidence being certified, which is also why this
    // command must not open one for you.
    expect(stderr).toContain("materialized workspace")
    expect(refusal.stdout()).toBe("")
  })

  it("certifies exact-head handoff readiness and exposes the shared lifecycle projection", async () => {
    const app = await createApp()
    await openTestBay(app, { name: "handoff-cli" })

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

  it("--check resolves the bay read-only: no certification write, same refusal when bayless", async () => {
    const app = await createApp()
    await openTestBay(app, { name: "handoff-check" })

    // With a live bay: the preflight reports the resolution facts…
    const check = outputIO()
    expect(
      await runYrd(
        app,
        yrd(
          "bay",
          "handoff",
          "B1",
          "--branch",
          "issue/handoff-check",
          "--head",
          HEAD_SHA,
          "--evidence",
          "@km/handoff/handoff-check.md",
          "--check",
          "--json",
        ),
        check.io,
      ),
      check.stderr(),
    ).toBe(0)
    expect(JSON.parse(check.stdout())).toMatchObject({
      command: "bay.handoff",
      check: { bay: "B1", branch: "issue/handoff-check", branchMatches: true },
    })

    // …and writes nothing: the lifecycle is still "open", not "handoff-ready".
    const after = outputIO()
    expect(await runYrd(app, yrd("bay", "--json"), after.io), after.stderr()).toBe(0)
    expect(JSON.parse(after.stdout())).toMatchObject({
      command: "bay.list",
      lifecycles: [{ bay: "B1", status: "open" }],
    })

    // Bayless: --check raises the SAME handoff-bay-missing refusal the real
    // certification would, which is what lets a caller refuse BEFORE writing
    // a durable packet instead of write-then-unwind (23055 flavours 1 and 4).
    const bayless = outputIO()
    expect(
      await runYrd(
        app,
        yrd(
          "bay",
          "handoff",
          "task/no-such-bay",
          "--branch",
          "task/no-such-bay",
          "--head",
          HEAD_SHA,
          "--evidence",
          "@km/handoff/no-such-bay.md",
          "--check",
          "--json",
        ),
        bayless.io,
      ),
    ).toBe(1)
    expect(bayless.stderr()).toContain("yrd bay open --pr task/no-such-bay")
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
    await openTestBay(app, { name: "submitted-retry" })
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
    await openTestBay(app, { name: "fresh-handoff" })
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
      expect.objectContaining({ definition: "bay.refresh", status: "completed", conclusion: "success" }),
    )
  })

  it.each([
    { surface: "yrd bay", command: (...args: string[]) => yrd("bay", ...args) },
    { surface: "yrd bay", command: (...args: string[]) => yrdBay(...args) },
  ])("projects one active Bay path through canonical selectors on $surface", async ({ command }) => {
    const app = await createApp()
    await openTestBay(app, { name: "fix-readme", branch: "topic/readme" })
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
    await openTestBay(longApp, { name: "long-path" })
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

    await openTestBay(app, { name: "shared", branch: "topic/one" })
    await openTestBay(app, { name: "other", branch: "shared" })
    const before = await Array.fromAsync(app.events()).then((events) => events.length)

    const ambiguous = outputIO()
    expect(await runYrd(app, yrd("bay", "path", "shared"), ambiguous.io)).toBe(1)
    expect(ambiguous.stderr()).toContain("Bay selector 'shared' is ambiguous: B1, B2")
    expect(await Array.fromAsync(app.events()).then((events) => events.length)).toBe(before)

    const closed = outputIO()
    expect(await runYrd(app, yrd("bay", "close", "--force", "B1"), closed.io), closed.stderr()).toBe(0)
    const afterClose = await Array.fromAsync(app.events()).then((events) => events.length)
    const inactive = outputIO()
    expect(await runYrd(app, yrd("bay", "path", "B1"), inactive.io)).toBe(1)
    expect(inactive.stderr()).toContain("bay 'B1' is closed; expected an active bay")
    expect(inactive.stderr()).toContain("yrd bay open --bay <name>")
    expect(await Array.fromAsync(app.events()).then((events) => events.length)).toBe(afterClose)

    const relativeApp = await createApp({ bayPath: "relative/B1" })
    await openTestBay(relativeApp, { name: "relative" })
    const beforeRelative = await Array.fromAsync(relativeApp.events()).then((events) => events.length)
    const relative = outputIO()
    expect(await runYrd(relativeApp, yrd("bay", "path", "B1"), relative.io)).toBe(1)
    expect(relative.stderr()).toContain("bay 'B1' has no absolute worktree path")
    expect(relative.stderr()).toContain("yrd bay --json")
    expect(await Array.fromAsync(relativeApp.events()).then((events) => events.length)).toBe(beforeRelative)
  })

  it("rejects retired persistent-open configuration flags without writing state", async () => {
    const app = await createApp()
    const before = await Array.fromAsync(app.events()).then((events) => events.length)
    for (const option of [`--${retiredRoleNoun}`, "--from", "--base", "--json"]) {
      const output = outputIO()
      expect(await runYrd(app, yrd("bay", "open", "--bay", "linked-work", option, "retired"), output.io)).toBe(2)
      expect(output.stderr(), option).toContain(`unknown option '${option}'`)
    }
    expect(await Array.fromAsync(app.events()).then((events) => events.length)).toBe(before)
  })

  it("submits inferred bays and runs selected queue steps instead of merely enqueueing jobs", async () => {
    const app = await createApp()
    await openAndSubmit(app)

    const before = app.state()
    expect(changeDeliveryState(before.bays.prs.PR1!)).toBe("submitted")
    expect(before.bays.prs.PR1).toMatchObject({ bay: "B1", revs: [{ head: HEAD_SHA }] })

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
          status: "completed",
          conclusion: "success",
          steps: [{ name: "check" }, { name: "merge" }],
          prs: [{ id: "PR1", headSha: HEAD_SHA }],
        },
      ],
    })
    expect(app.state().bays.prs.PR1).toMatchObject({
      state: "closed",
      merged: true,
      integration: { commit: MERGED_SHA },
    })

    const merged = outputIO()
    expect(await runYrd(app, yrd("pr", "view", "PR1", "--json"), merged.io), merged.stderr()).toBe(0)
    expect(JSON.parse(merged.stdout())).toMatchObject({
      command: "pr.view",
      pr: { id: "PR1", state: "closed", merged: true, taskStatus: "done" },
      merge: {
        outcome: "landed",
        landingSha: MERGED_SHA,
        baseSha: MERGED_SHA,
        run: "R1",
      },
    })
  })

  it("refreshes an active bay before submit and warns while using the committed head for dirty work", async () => {
    const refreshedHead = "2".repeat(40)
    const clean = await createApp({ refreshedHead })
    await openTestBay(clean, { name: "fresh-head" })
    const submit = outputIO({ cwd: "/repo/.bays/B1" })
    expect(await runYrd(clean, yrd("bay", "submit"), submit.io)).toBe(0)
    expect(clean.state().bays.prs.PR1).toMatchObject({
      bay: "B1",
      state: "open",
      merged: false,
      revs: [{ head: refreshedHead, submittedAt: expect.any(String) }],
    })

    const dirty = await createApp({ dirtyBay: true })
    await openTestBay(dirty, { name: "dirty" })
    const warned = outputIO({ cwd: "/repo/.bays/B1" })
    expect(await runYrd(dirty, yrd("bay", "submit", "--json"), warned.io), warned.stderr()).toBe(0)
    expect(JSON.parse(warned.stdout())).toMatchObject({
      command: "bay.submit",
      prs: [{ id: "PR1", revs: [{ head: HEAD_SHA }] }],
      warnings: [expect.any(String)],
    })
    expect(dirty.state().bays.prs.PR1).toMatchObject({ revs: [{ head: HEAD_SHA }] })
  })

  it("requests checks when bay submit hands off a carrier", async () => {
    const app = await createApp()
    await openTestBay(app, { name: "handoff" })

    const submit = outputIO({ cwd: "/repo/.bays/B1" })
    expect(await runYrd(app, yrd("bay", "submit", "--json"), submit.io), submit.stderr()).toBe(0)

    // PR685/PR687/PR688 waited 100m/24m/2m because the handoff depended on
    // unrelated runner activity. Submission must create authority now.
    expect(app.bays.checksRequested("PR1")).toBe(true)
    expect(app.state().bays.prs.PR1?.checkRequests).toHaveLength(1)
    expect(Queues.ids(app.state().queues)).toEqual([])
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
    // Two resolutions per submit: the staged preview pass (where refusals merge
    // before anything is written — the PR1128 ordering) and the real submit,
    // the same shape pr.submit has always had.
    expect(resolved).toEqual(["topic/direct", "topic/direct"])
    // The legacy record mint is retired: the acceptance is the derived row and
    // the branch-submit fact, carrying the explicit base.
    expect(JSON.parse(submit.stdout())).toMatchObject({
      command: "bay.submit",
      prs: [],
      derived: [{ lane: "derived", branch: "topic/direct", sha: HEAD_SHA, base: "release/2.0" }],
    })
    expect(app.bays.state().submits["topic/direct"]).toMatchObject({ sha: HEAD_SHA, base: "release/2.0" })

    resolvedHead = MERGED_SHA
    const revision = outputIO({ resolveRevision })
    expect(
      await runYrd(app, yrd("bay", "submit", "topic/direct", "--base", "release/2.0", "--json"), revision.io),
    ).toBe(0)
    expect(resolved).toEqual(["topic/direct", "topic/direct", "topic/direct", "topic/direct"])
    // A moved tip re-submits as the SAME branch's renewed fact; the queue's
    // next compose keys the new revision of the derived identity from it.
    expect(JSON.parse(revision.stdout())).toMatchObject({
      command: "bay.submit",
      prs: [],
      derived: [{ lane: "derived", branch: "topic/direct", sha: MERGED_SHA, base: "release/2.0" }],
    })
    expect(app.bays.state().submits["topic/direct"]).toMatchObject({ sha: MERGED_SHA, base: "release/2.0" })

    const human = outputIO({ columns: 64, resolveRevision })
    expect(await runYrd(app, yrd("bay", "submit", "topic/direct", "--base", "release/2.0"), human.io)).toBe(0)
    // Human mode: the derived acceptance line rides the advisory stream so the
    // submit's outcome is never silent.
    expect(human.stderr()).toContain("submitted to the derived lane: topic/direct")
    expect(human.stderr()).toContain(`@ ${MERGED_SHA.slice(0, 12)} (base release/2.0)`)
  })

  // Record-lane surface deleted with the legacy record mint: `pr create` no
  // longer mints a direct-branch record, so every flow below it became
  // unreachable from the CLI; the record store itself is scheduled for
  // deletion (S7, @i/10 22991). Deleted tests:
  // - "drives create, review, ready, needs-review, and cached checks through
  //   the change surface" (create minted the record the comment/review/ready/
  //   cached-checks flow ran on),
  // - "drives reviewer requests through submit, request-review, and the
  //   reviewer-scoped inbox" (reviewer requests bind to records),
  // - "sends a terminal change to a fresh ref, not to another revision of a
  //   spent branch" (the redelivery refusal presupposes a record identity to
  //   spend; a terminal-record branch now re-enters the DERIVED lane),
  // - "closes a direct bayless PR through the `pr close` CLI without a bay"
  //   (a direct branch mints no record for `pr close` to withdraw),
  // - "projects an authoritative check failure after the later Queue run" and
  //   "classifies the read-only main-health evidence as a base failure"
  //   (`pr checks` projects records; a derived member's failed required check
  //   now refuses ADMISSION at compose — see the required-check-failed
  //   resubmit test below for the surviving derived-lane shape).
  it("refuses pr create on a direct branch: the record mint is retired, and the cure is a plain submit", async () => {
    const app = await createApp()
    const resolveRevision = () => Promise.resolve(HEAD_SHA)
    const before = await Array.fromAsync(app.events()).then((events) => events.length)

    const create = outputIO({ resolveRevision })
    expect(await runYrd(app, yrd("pr", "create", "topic/review-me", "--json"), create.io)).toBe(1)
    expect(JSON.parse(create.stderr())).toMatchObject({
      failure: { kind: "refusal", code: "record-mint-retired" },
    })
    // The cure rides the refusal itself: submit plainly, run as a derived member.
    expect(create.stderr()).toContain("yrd pr submit topic/review-me")
    // Refused before any write: no record, no submit fact, no events.
    expect(app.state().bays.prs).toEqual({})
    expect(app.bays.state().submits).toEqual({})
    expect(await Array.fromAsync(app.events()).then((events) => events.length)).toBe(before)
  })

  it("records the submit fact for a plain submit, and pr create refuses even on the fact-bearing branch", async () => {
    // The legacy record mint retired: the fact IS the submitted revision, and
    // checks queue at compose time, not as a record check-request at submit.
    const app = await createApp()
    const output = outputIO({ resolveRevision: () => Promise.resolve(HEAD_SHA) })

    expect(await runYrd(app, yrd("pr", "submit", "topic/ready-on-arrival", "--json"), output.io), output.stderr()).toBe(
      0,
    )
    expect(JSON.parse(output.stdout())).toMatchObject({
      command: "pr.submit",
      prs: [],
      derived: [{ lane: "derived", branch: "topic/ready-on-arrival", sha: HEAD_SHA, base: "main" }],
    })
    expect(app.bays.pr("topic/ready-on-arrival")).toBeUndefined()
    expect(app.bays.state().submits["topic/ready-on-arrival"]).toMatchObject({ sha: HEAD_SHA })

    // A standing fact is not a record: create still has nothing to draft, and
    // the refusal names the plain submit as the cure. The fact stays untouched.
    const create = outputIO({ resolveRevision: () => Promise.resolve(HEAD_SHA) })
    expect(await runYrd(app, yrd("pr", "create", "topic/ready-on-arrival", "--title", "mutated"), create.io)).toBe(1)
    expect(create.stderr()).toContain("draft records are retired")
    expect(create.stderr()).toContain("resolve: yrd pr submit topic/ready-on-arrival")
    expect(app.bays.pr("topic/ready-on-arrival")).toBeUndefined()
    expect(app.bays.state().submits["topic/ready-on-arrival"]).toMatchObject({ sha: HEAD_SHA })
  })

  it("resubmits a required-check-failed branch as a renewed fact that the next compose admits and lands", async () => {
    // The legacy record mint retired: the fact is the submission. The required
    // check runs at compose-admit; a failure refuses ADMISSION — no run
    // record, no rejected record — and the branch's unrecorded-submit row
    // stays loudly visible until a fixed head is re-submitted.
    const checkRuns: string[] = []
    const behavior = { failingCheck: true, checkRuns, resolveBaseSha: () => BASE_SHA }
    const app = await createApp(behavior)
    const first = outputIO({ resolveRevision: () => Promise.resolve(HEAD_SHA) })
    expect(await runYrd(app, yrd("pr", "submit", "topic/retry", "--json"), first.io)).toBe(0)
    expect(checkRuns).toEqual([])
    expect(await app.queue.run({}, { runner: "cli-test", leaseMs: 60_000 })).toEqual([])
    // The check executed and failed during admit: nothing ran, nothing was
    // rejected, and the branch is still the queue's own visible pending row.
    expect(checkRuns).toEqual(["check"])
    expect(Queues.ids(app.state().queues)).toEqual([])
    expect(app.state().bays.prs).toEqual({})
    expect(await app.queue.unrecordedSubmits()).toMatchObject([{ branch: "topic/retry", sha: HEAD_SHA }])

    behavior.failingCheck = false
    const submit = outputIO({ resolveRevision: () => Promise.resolve(MERGED_SHA) })
    expect(await runYrd(app, yrd("pr", "submit", "topic/retry", "--json"), submit.io), submit.stderr()).toBe(0)
    expect(JSON.parse(submit.stdout())).toMatchObject({
      command: "pr.submit",
      prs: [],
      derived: [{ lane: "derived", branch: "topic/retry", sha: MERGED_SHA, base: "main" }],
    })
    expect(app.bays.state().submits["topic/retry"]).toMatchObject({ sha: MERGED_SHA })

    // A refused admit journals no snapshot, so the retry derives a FRESH
    // identity from the renewed fact, passes its check, and lands.
    expect(await app.queue.run({}, { runner: "cli-test", leaseMs: 60_000 })).toMatchObject([
      { status: "completed", conclusion: "success" },
    ])
    const retried = Queues.values(app.state().queues).find((run) => run.prs.some((pr) => pr.branch === "topic/retry"))
    expect(retried?.prs).toMatchObject([{ branch: "topic/retry", revision: 1, headSha: MERGED_SHA }])
    expect(app.state().bays.prs).toEqual({})
  })

  // An unrecognized --state used to fall through to a row filter that matches
  // nothing — `prs: []`, exit 0 — indistinguishable from "no PRs currently in
  // that state" for a typo like `--state pushed ` (trailing space) or a
  // half-remembered v1 name. The filter must refuse loudly instead: it names
  // the exact value it rejected and the full valid set, and a real state
  // value keeps listing exactly as before.
  it("refuses an unrecognized pr list --state value, naming the valid set", async () => {
    const app = await createApp()
    await app.bays.intake({ branch: "issue/state-value", headSha: HEAD_SHA, base: "main" })

    const invalid = outputIO()
    expect(await runYrd(app, yrd("pr", "list", "--state", "bogus-value", "--json"), invalid.io)).toBe(2)
    expect(invalid.stderr()).toContain(
      "--state 'bogus-value' is invalid; expected a record state (open, closed) or a delivery status " +
        "(pushed, submitted, ready, needs-author, rejected, integrated, already-landed, withdrawn, canceled)",
    )
    // A refusal must never silently pass through as an empty success either —
    // confirm no `pr.list` result reached stdout at all.
    expect(invalid.stdout()).toBe("")
  })

  // Every `pr list` row carries TWO state words: `state` from PR.state
  // (yrd-bay/src/model.ts:643, open | closed) and `status` from
  // ChangeDeliveryState (yrd-bay/src/model.ts:317). `--state` filtered only
  // the second, so `--state open` — the record's own word for the field the
  // flag is named after — matched nothing and returned an empty list. It has
  // to accept both vocabularies and filter whichever field defines the value.
  it("filters pr list --state on whichever field defines the value", async () => {
    const app = await createApp()
    await app.bays.intake({ branch: "issue/still-open", headSha: HEAD_SHA, base: "main" })
    await app.bays.submit({ branch: "topic/gone", headSha: MERGED_SHA, base: "main" })
    await app.bays.closePr({ pr: "PR2" })
    expect(app.bays.pr("PR1")!.state).toBe("open")
    expect(changeDeliveryState(app.bays.pr("PR1")!)).toBe("pushed")
    expect(app.bays.pr("PR2")!.state).toBe("closed")
    expect(changeDeliveryState(app.bays.pr("PR2")!)).toBe("withdrawn")

    const open = outputIO()
    expect(await runYrd(app, yrd("pr", "list", "--state", "open", "--json"), open.io), open.stderr()).toBe(0)
    expect(JSON.parse(open.stdout())).toMatchObject({ command: "pr.list", prs: [{ id: "PR1", state: "open" }] })
    expect((JSON.parse(open.stdout()) as { prs: readonly unknown[] }).prs).toHaveLength(1)

    const closed = outputIO()
    expect(await runYrd(app, yrd("pr", "list", "--state", "closed", "--json"), closed.io), closed.stderr()).toBe(0)
    expect(JSON.parse(closed.stdout())).toMatchObject({ command: "pr.list", prs: [{ id: "PR2", state: "closed" }] })
    expect((JSON.parse(closed.stdout()) as { prs: readonly unknown[] }).prs).toHaveLength(1)

    // The delivery vocabulary keeps filtering the status field, unchanged.
    const pushed = outputIO()
    expect(await runYrd(app, yrd("pr", "list", "--state", "pushed", "--json"), pushed.io), pushed.stderr()).toBe(0)
    expect(JSON.parse(pushed.stdout())).toMatchObject({ command: "pr.list", prs: [{ id: "PR1" }] })
    expect((JSON.parse(pushed.stdout()) as { prs: readonly unknown[] }).prs).toHaveLength(1)

    const withdrawn = outputIO()
    expect(
      await runYrd(app, yrd("pr", "list", "--state", "withdrawn", "--json"), withdrawn.io),
      withdrawn.stderr(),
    ).toBe(0)
    expect(JSON.parse(withdrawn.stdout())).toMatchObject({ command: "pr.list", prs: [{ id: "PR2" }] })
    expect((JSON.parse(withdrawn.stdout()) as { prs: readonly unknown[] }).prs).toHaveLength(1)

    // A valid value that matches nothing is still a success with an empty
    // list — the duality the refusal exists to protect, not to replace.
    const none = outputIO()
    expect(await runYrd(app, yrd("pr", "list", "--state", "integrated", "--json"), none.io), none.stderr()).toBe(0)
    expect(JSON.parse(none.stdout())).toMatchObject({ command: "pr.list", prs: [] })
  })

  it("still lists PRs in a valid state after the --state value is validated", async () => {
    const app = await createApp()
    await app.bays.intake({ branch: "issue/state-value", headSha: HEAD_SHA, base: "main" })
    expect(changeDeliveryState(app.bays.pr("PR1")!)).toBe("pushed")

    const matching = outputIO()
    expect(await runYrd(app, yrd("pr", "list", "--state", "pushed", "--json"), matching.io), matching.stderr()).toBe(0)
    expect(JSON.parse(matching.stdout())).toMatchObject({ command: "pr.list", prs: [{ id: "PR1" }] })

    const nonMatching = outputIO()
    expect(
      await runYrd(app, yrd("pr", "list", "--state", "integrated", "--json"), nonMatching.io),
      nonMatching.stderr(),
    ).toBe(0)
    expect(JSON.parse(nonMatching.stdout())).toMatchObject({ command: "pr.list", prs: [] })
  })

  it("pr checks --follow waits for a not-yet-observable check request instead of refusing", async () => {
    // A submit's check request may not be observable yet when the follower
    // arrives; --follow means WAIT, so the not-requested state enters the same
    // 1s poll loop as a queued one (it used to hard-refuse, forcing the
    // submit→follow racer to hand-retry).
    const app = await createApp()
    await app.bays.submit({ branch: "topic/not-requested", headSha: HEAD_SHA, base: "main" })
    let polls = 0
    const controller = new AbortController()
    const following = outputIO({
      scope: {
        signal: controller.signal,
        sleep: async () => {
          polls += 1
          // The request becomes observable between polls, then completes.
          if (polls === 1) {
            await app.bays.requestChecks({ pr: "PR1" })
            await app.queue.run({ prs: ["PR1"] }, { runner: "cli-test", leaseMs: 60_000 })
          }
        },
      },
    })

    expect(await runYrd(app, yrd("pr", "checks", "PR1", "--follow", "--json"), following.io)).toBe(0)
    expect(polls).toBeGreaterThan(0)
    expect(app.queue.eligibility("PR1")).toMatchObject({ checks: { status: "passed" } })
  })

  it("keeps an aborted pr checks --follow read-only while nothing was requested", async () => {
    // The poll loop itself must never write a fact: an aborted follow leaves
    // the journal exactly as it found it and reports the not-requested rows.
    //
    // It also exits 1, and the two halves are separate claims. Read-only is
    // this test's subject and is asserted on the journal below. The exit is
    // the D1 rule: an aborted follow obtained NO verdict, and `pr checks` no
    // longer spells that 0 (@i/10-merge-queue/failed-check-erased — `f35125b1`
    // made `not-requested` followable, which entrenched exit-0-on-nothing).
    const app = await createApp()
    await app.bays.submit({ branch: "topic/not-requested", headSha: HEAD_SHA, base: "main" })
    const before = await Array.fromAsync(app.events())
    const controller = new AbortController()
    const checks = outputIO({
      scope: {
        signal: controller.signal,
        sleep: async () => {
          controller.abort()
        },
      },
    })

    expect(await runYrd(app, yrd("pr", "checks", "PR1", "--follow", "--json"), checks.io)).toBe(1)
    expect(await Array.fromAsync(app.events())).toEqual(before)
    expect(app.queue.eligibility("PR1")).toMatchObject({ checks: { status: "not-requested" } })
  })

  it("runs a plain submission's authoritative check and merge in the later selectorless drain", async () => {
    // The legacy record mint retired: nothing is checkable at submit. The
    // one-shot selectorless drain composes the derived member, runs its
    // required check at admit, and merges it — all in the drain.
    const checkRuns: string[] = []
    const app = await createApp({ checkRuns, resolveBaseSha: () => BASE_SHA })
    const submit = outputIO({ resolveRevision: () => Promise.resolve(HEAD_SHA) })
    expect(await runYrd(app, yrd("pr", "submit", "topic/plain", "--json"), submit.io), submit.stderr()).toBe(0)
    expect(checkRuns).toEqual([])
    expect(app.state().bays.prs).toEqual({})
    expect(await app.queue.history()).toEqual([])

    const drain = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "--once", "--json"), drain.io), drain.stderr()).toBe(0)
    expect(JSON.parse(drain.stdout())).toMatchObject({
      results: [
        {
          id: "R1",
          status: "completed",
          conclusion: "success",
          prs: [{ branch: "topic/plain", headSha: HEAD_SHA }],
        },
      ],
    })
    expect(checkRuns).toEqual(["check"])
    expect(app.state().bays.prs).toEqual({})
  })

  it("records each direct submission as a fact without executing Queue work in the submitter", async () => {
    // The legacy record mint retired: each submit writes its branch fact and
    // nothing more — no record, no check request, no queue activity. The
    // submitted branches wait as the queue's own visible pending rows.
    const checkRuns: string[] = []
    const app = await createApp({ checkRuns })
    const resolveRevision = (ref: string) => Promise.resolve(ref.endsWith("first") ? HEAD_SHA : MERGED_SHA)

    const first = outputIO({ resolveRevision })
    expect(await runYrd(app, yrd("pr", "submit", "topic/first", "--json"), first.io), first.stderr()).toBe(0)
    expect(app.bays.state().submits["topic/first"]).toMatchObject({ sha: HEAD_SHA })
    expect(await app.queue.history()).toEqual([])

    const second = outputIO({ resolveRevision })
    expect(await runYrd(app, yrd("pr", "submit", "topic/second", "--json"), second.io), second.stderr()).toBe(0)
    expect(app.bays.state().submits["topic/second"]).toMatchObject({ sha: MERGED_SHA })
    expect(app.state().bays.prs).toEqual({})
    expect((await app.queue.unrecordedSubmits()).map((row) => row.branch)).toEqual(["topic/first", "topic/second"])
    expect(checkRuns).toEqual([])
    expect(await app.queue.history()).toEqual([])
  })

  it("rejects the retired pr submit --follow option without journaling", async () => {
    const app = await createApp({ waitingCheck: true })
    const before = await Array.fromAsync(app.events())
    const submit = outputIO({ resolveRevision: () => Promise.resolve(HEAD_SHA) })

    expect(await runYrd(app, yrd("pr", "submit", "topic/wait", "--follow", "--json"), submit.io)).toBe(2)
    expect(submit.stderr()).toContain("unknown option '--follow'")
    expect(await Array.fromAsync(app.events())).toEqual(before)
  })

  it("terminalizes unclaimed Queue work when `bay close --withdraw` closes its PR", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    await expect(
      app.queue.run({ prs: ["PR1"], steps: ["check"] }, { runner: "history-runner", leaseMs: 60_000 }),
    ).resolves.toMatchObject([{ id: "R1", status: "completed", conclusion: "success" }])
    await app.dispatch(app.commands.queue.run, { prs: ["PR1"], steps: ["merge"] })

    const close = outputIO({ cwd: "/repo/.bays/B1" })
    expect(
      await runYrd(app, yrd("bay", "close", "--withdraw", "--force", "B1", "--json"), close.io),
      close.stderr(),
    ).toBe(0)

    expect(changeDeliveryState(app.state().bays.prs.PR1!)).toBe("withdrawn")
    expect(app.queue.get("R1")).toMatchObject({ status: "completed", conclusion: "success" })
    expect(app.queue.get("R2")).toMatchObject({
      status: "completed",
      conclusion: "failure",
      steps: [{ job: { status: "completed", conclusion: "cancelled", attempt: 0, cancelReason: "PR withdrawn" } }],
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
    expect(JSON.parse(finish.stdout())).toMatchObject({
      command: "queue.finish",
      run: { id: "R1", status: "completed", conclusion: "success" },
    })
    expect(app.queue.get("R1")?.shape).toMatchObject({
      results: { check: { baseSha: BASE_SHA, candidateSha: HEAD_SHA } },
    })
    expect(app.queue.get("R1")?.steps).toMatchObject([
      { job: { status: "completed", conclusion: "success" } },
      { job: { status: "completed", conclusion: "success" } },
    ])
  })

  it("self-quarantines an immutable admission refusal instead of manufacturing a refusal loop", async () => {
    let now = "2026-07-09T12:00:00.000Z"
    await using app = await createApp({
      clock: () => now,
      // A typed refusal belongs to this immutable revision and must settle it
      // once; later cycles cannot manufacture duplicate refusal observations.
      prepareCandidate: () => {
        throw createFailure({
          kind: "refusal",
          code: "authored-gitlink",
          message:
            "yrd: change 'PR1' authors a gitlink bump; get the commit onto vendor/yrd's own main, then submit an " +
            "ordinary change whose diff is the gitlink bump",
        })
      },
    })
    await openAndSubmit(app)
    await app.bays.requestChecks({ pr: "PR1" })

    for (const at of ["2026-07-09T12:00:00.000Z", "2026-07-09T14:00:00.000Z", "2026-07-09T17:46:00.000Z"]) {
      now = at
      await app.queue.run({}, { runner: "cli-test", leaseMs: 60_000 })
    }
    expect(Queues.ids(app.state().queues)).toEqual([])
    expect(changeDeliveryState(app.bays.pr("PR1")!)).toBe("needs-author")
    expect(changeAdmission(app.bays.pr("PR1")!)).toMatchObject({
      status: "refused",
      receipt: { code: "authored-gitlink" },
    })
    // The quarantine is intact and is what this test is about: three cycles
    // produced ONE refusal observation, never three. What changed (23236) is
    // that the audit now NAMES an unsettled verdict on the content from its
    // first refusal instead of only at the third — so it no longer goes silent
    // about the single change nobody can act on. This is the same conflation
    // the settled-refusal branch of `admissionRefusalAuditFindings` already
    // fixed once: "stop retrying" and "stop REPORTING" are different facts.
    expect(app.state().queues.admissionRefusals.PR1).toMatchObject({ code: "authored-gitlink", count: 1 })
    expect(app.queue.audit().findings).toEqual([
      expect.objectContaining({
        code: "admission-refusal-loop",
        pr: "PR1",
        refusal: "authored-gitlink",
        count: 1,
      }),
    ])
  })

  it("makes a same-head base refresh with zero runs actionable instead of reporting queue idle", async () => {
    let currentBaseSha = BASE_SHA
    const advancedBaseSha = "e".repeat(40)
    await using app = await createApp({
      resolveBaseSha: () => currentBaseSha,
      prepareCandidate: (input) => {
        if (input.prs.some((pr) => pr.id === "PR1")) {
          throw createFailure({
            kind: "refusal",
            code: "carrier-drops-landed",
            message: "the branch does not contain the merge-queue base; recut and requeue the root branch",
          })
        }
        const { prs: _prs, ...candidate } = input
        return {
          ...candidate,
          sha: MERGED_SHA,
          ref: candidateRefFor(MERGED_SHA),
          mergeability: "mergeable",
        }
      },
    })
    await app.bays.submit({ branch: "topic/base-chase", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    await app.bays.requestChecks({ pr: "PR1", baseSha: BASE_SHA })
    await app.queue.run({}, { runner: "cli-test", leaseMs: 60_000 })
    expect(Queues.ids(app.state().queues)).toEqual([])
    expect(app.queue.eligibility("PR1")).toMatchObject({ reason: { code: "admission-refused" } })

    currentBaseSha = advancedBaseSha
    await app.queue.run({}, { runner: "cli-test", leaseMs: 60_000 })
    expect(changeAdmission(app.bays.pr("PR1")!)).toMatchObject({
      status: "refused",
      baseSha: advancedBaseSha,
      receipt: { code: "carrier-drops-landed" },
    })
    expect(app.bays.pr("PR1")?.checkRequests).toMatchObject([
      { revision: 1, headSha: HEAD_SHA, baseSha: BASE_SHA },
      { revision: 1, headSha: HEAD_SHA, baseSha: advancedBaseSha },
    ])
    expect(Queues.ids(app.state().queues)).toEqual([])

    const once = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "--once"), once.io), once.stderr()).toBe(0)

    expect(once.stdout()).not.toContain("Queue idle")
    expect(once.stdout()).toContain("carrier-drops-landed")
    expect(once.stdout()).toContain("tracked changes re-merge implicitly")

    const json = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "--once", "--json"), json.io), json.stderr()).toBe(0)
    expect(JSON.parse(json.stdout())).toMatchObject({
      command: "queue.run",
      results: [],
      blocked: [
        {
          pr: { id: "PR1" },
          eligibility: {
            reason: {
              code: "admission-refused",
              message: expect.stringContaining("tracked changes re-merge implicitly"),
            },
          },
        },
      ],
    })

    await app.bays.submit({ branch: "topic/progresses", headSha: MERGED_SHA, base: "main", baseSha: BASE_SHA })
    await app.bays.requestChecks({ pr: "PR2", baseSha: BASE_SHA })

    const targeted = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "PR2", "--json"), targeted.io), targeted.stderr()).toBe(0)
    expect(JSON.parse(targeted.stdout())).toMatchObject({
      command: "queue.run",
      results: [{ prs: [{ id: "PR2" }] }],
    })
    expect(JSON.parse(targeted.stdout())).not.toHaveProperty("blocked")

    await app.bays.submit({ branch: "topic/also-progresses", headSha: "c".repeat(40), base: "main", baseSha: BASE_SHA })
    await app.bays.requestChecks({ pr: "PR3", baseSha: BASE_SHA })
    const mixed = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "--once", "--json"), mixed.io), mixed.stderr()).toBe(0)
    expect(JSON.parse(mixed.stdout())).toMatchObject({
      command: "queue.run",
      results: [{ prs: [{ id: "PR3" }] }],
      blocked: [{ pr: { id: "PR1" }, eligibility: { reason: { code: "admission-refused" } } }],
    })
  })

  it("does not report a no-merge stall after an immutable revision refusal settles", async () => {
    await using app = await createApp({
      prepareCandidate: () => {
        throw createFailure({
          kind: "refusal",
          code: "authored-gitlink",
          message:
            "yrd: change 'PR1' authors a gitlink bump; get the commit onto vendor/yrd's own main, then submit an " +
            "ordinary change whose diff is the gitlink bump",
        })
      },
    })
    await openAndSubmit(app)
    await app.bays.requestChecks({ pr: "PR1" })
    await app.queue.run({}, { runner: "cli-test", leaseMs: 60_000 })

    const audit = outputIO({ now: () => Date.parse("2026-07-09T12:10:00.000Z") })
    // Exit 1, not 0: `queue audit` exits non-zero whenever it has findings, and
    // under 23236 a content verdict IS a finding on its first refusal. That is
    // the whole operational point — the exit code is how a heartbeat learns
    // about an immutable refusal, and it now learns one cycle in instead of
    // three (or, in this shape, never, since the streak cannot advance).
    expect(await runYrd(app, yrd("queue", "audit", "--json"), audit.io), audit.stderr()).toBe(1)
    // The STALL finding is this test's subject: an immutable refusal that
    // settled must never read as a stalled queue, and an exact code list keeps
    // that assertion as strict as `findings: []` was.
    const audited = JSON.parse(audit.stdout()) as Readonly<{
      command: string
      findings: readonly Readonly<{ code: string }>[]
    }>
    expect(audited.command).toBe("queue.audit")
    expect(audited.findings.map((finding) => finding.code)).toEqual(["admission-refusal-loop"])
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
    expect(JSON.parse(finish.stdout())).toMatchObject({
      run: { id: "R1", status: "completed", conclusion: "failure" },
    })
    expect(changeDeliveryState(app.state().bays.prs.PR1!)).toBe("submitted")
    expect(app.state().bays.prs.PR1).not.toHaveProperty("detail")
    const status = outputIO({ color: true })
    expect(await runYrd(app, yrd(), status.io)).toBe(0)
    expect(status.stdout()).toContain(pathToFileURL(artifact).href)
    safeRemoveSync(temp, { within: tmpdir(), allowMissing: true })
  })

  it("preserves zero-selector and explicitly empty step selection semantics", async () => {
    const app = await createApp()
    await openAndSubmit(app)

    const integrated = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "--once", "--steps", "--json"), integrated.io)).toBe(0)
    expect(JSON.parse(integrated.stdout())).toEqual({ command: "queue.run", publications: [], results: [] })
    expect(changeDeliveryState(app.state().bays.prs.PR1!)).toBe("submitted")

    const idle = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "--once", "--json"), idle.io)).toBe(0)
    expect(JSON.parse(idle.stdout())).toMatchObject({
      command: "queue.run",
      results: [
        {
          id: "R1",
          prs: [{ id: "PR1" }],
          steps: [{ name: "check" }, { name: "merge" }],
          status: "completed",
          conclusion: "success",
        },
      ],
    })

    const drained = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "--once", "--json"), drained.io)).toBe(0)
    expect(JSON.parse(drained.stdout())).toEqual({ command: "queue.run", publications: [], results: [] })
  })

  it("persists and releases queue pauses through the operator CLI", async () => {
    const app = await createApp()
    await app.bays.submit({ branch: "issue/blocked", headSha: "1".repeat(40), base: "main" })
    await app.bays.submit({ branch: "issue/allowed", headSha: "2".repeat(40), base: "main" })
    await app.bays.submit({ branch: "issue/also-allowed", headSha: "3".repeat(40), base: "main" })
    const pause = outputIO({ now: () => Date.parse("2026-07-09T12:00:00.000Z") })

    expect(
      await runYrd(
        app,
        yrd("queue", "pause", "main", "--reason", "operator freeze", "--for", "30m", "--allow", "PR2", "PR3", "--json"),
        pause.io,
      ),
    ).toBe(0)
    expect(JSON.parse(pause.stdout())).toMatchObject({
      command: "queue.pause",
      pause: {
        base: "main",
        reason: "operator freeze",
        allowedPRs: ["PR2", "PR3"],
        expiresAt: "2026-07-09T12:30:00.000Z",
      },
    })
    const blocked = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "PR1", "--json"), blocked.io)).toBe(1)
    expect(blocked.stderr()).toContain("queue 'main' is paused: operator freeze")
    expect(Queues.ids(app.state().queues)).toEqual([])

    const eligible = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "PR2", "--json"), eligible.io), eligible.stderr()).toBe(0)
    expect(JSON.parse(eligible.stdout())).toMatchObject({
      results: [{ prs: [{ id: "PR2" }], status: "completed", conclusion: "success" }],
    })
    expect(changeDeliveryState(app.state().bays.prs.PR1!)).toBe("submitted")
    expect(changeDeliveryState(app.state().bays.prs.PR2!)).toBe("integrated")

    const partiallyStale = outputIO({ columns: 120 })
    expect(await runYrd(app, yrd(), partiallyStale.io)).toBe(0)
    expect(partiallyStale.stdout()).toContain("PR2 integrated")
    expect(partiallyStale.stdout()).toContain("PR3 submitted")
    expect(partiallyStale.stdout()).not.toContain("BLOCKING EVERYTHING")

    const secondEligible = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "PR3", "--json"), secondEligible.io)).toBe(0)
    expect(JSON.parse(secondEligible.stdout())).toMatchObject({
      results: [{ prs: [{ id: "PR3" }], status: "completed", conclusion: "success" }],
    })
    expect(changeDeliveryState(app.state().bays.prs.PR3!)).toBe("integrated")

    await app.bays.submit({ branch: "issue/newly-blocked", headSha: "4".repeat(40), base: "main" })

    const status = outputIO()
    expect(await runYrd(app, yrd("--json"), status.io)).toBe(0)
    expect(JSON.parse(status.stdout())).toMatchObject({
      warnings: [
        "[pause-blocks-all] queue 'main' pause blocks every change: all allowed PRs are terminal (PR2 integrated, PR3 integrated)",
      ],
      results: [{ base: "main", pause: { reason: "operator freeze", allowedPRs: ["PR2", "PR3"] } }],
    })

    const humanStatus = outputIO({ columns: 120 })
    expect(await runYrd(app, yrd(), humanStatus.io)).toBe(0)
    expect(humanStatus.stdout()).toContain("BLOCKING EVERYTHING")
    expect(humanStatus.stdout()).toContain("operator freeze")
    expect(humanStatus.stdout()).toContain("PR2 integrated")
    expect(humanStatus.stdout()).toContain("PR3 integrated")
    expect(humanStatus.stdout()).toContain("pr#4.1 issue/newly-blocked submitted")

    const queueList = outputIO({
      columns: 120,
      resolveQueueTarget: async () => ({ base: "main", sha: BASE_SHA }),
    })
    expect(await runYrd(app, yrd("queue", "ls"), queueList.io), queueList.stderr()).toBe(0)
    expect(queueList.stdout()).toContain("PAUSE BLOCKING EVERYTHING")
    expect(queueList.stdout()).toContain("PR2 integrated")
    expect(queueList.stdout()).toContain("PR3 integrated")

    const queueListJson = outputIO({
      resolveQueueTarget: async () => ({ base: "main", sha: BASE_SHA }),
    })
    expect(await runYrd(app, yrd("queue", "ls", "--json"), queueListJson.io), queueListJson.stderr()).toBe(0)
    expect(JSON.parse(queueListJson.stdout())).toMatchObject({
      warnings: [
        "[pause-blocks-all] queue 'main' pause blocks every change: all allowed PRs are terminal (PR2 integrated, PR3 integrated)",
      ],
    })

    const newlyBlocked = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "PR4", "--json"), newlyBlocked.io)).toBe(1)
    expect(newlyBlocked.stderr()).toContain("queue 'main' is paused: operator freeze")

    const resume = outputIO()
    expect(await runYrd(app, yrd("queue", "resume", "main", "--json"), resume.io)).toBe(0)
    expect(JSON.parse(resume.stdout())).toEqual({ command: "queue.resume", base: "main" })
    expect(app.queue.status("main").pause).toBeUndefined()
  })

  it("requires a nonempty reason for every public queue pause", async () => {
    const app = await createApp()
    for (const argv of [
      yrd("queue", "pause", "main"),
      yrd("queue", "pause", "--json"),
      yrd("queue", "pause", "main", "--reason", ""),
    ]) {
      const output = outputIO()
      expect(await runYrd(app, argv, output.io)).toBe(2)
      expect(output.stderr()).toContain("--reason requires text")
      expect(app.queue.status("main").pause).toBeUndefined()
    }
  })

  it("requires a finite positive TTL for every public queue pause", async () => {
    const app = await createApp()
    for (const argv of [
      yrd("queue", "pause", "main", "--reason", "operator freeze"),
      yrd("queue", "pause", "main", "--reason", "operator freeze", "--for", "0s"),
      yrd("queue", "pause", "main", "--reason", "operator freeze", "--for", "forever"),
    ]) {
      const output = outputIO()
      expect(await runYrd(app, argv, output.io)).toBe(2)
      expect(output.stderr()).toContain("--for must be a positive duration")
      expect(app.queue.status("main").pause).toBeUndefined()
    }
  })

  it("passes zero-or-more selectors to the queue as one batch-capable candidate set", async () => {
    const app = await createApp({ batch: 2 })
    await openAndSubmit(app)
    await openTestBay(app, { name: "two" })
    expect(await runYrd(app, yrd("bay", "submit"), outputIO({ cwd: "/repo/.bays/B2" }).io)).toBe(0)

    const integrated = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "--once", "--json"), integrated.io), integrated.stderr()).toBe(0)
    expect(JSON.parse(integrated.stdout())).toMatchObject({
      results: [
        {
          id: "R1",
          status: "completed",
          conclusion: "success",
          prs: [{ id: "PR1" }, { id: "PR2" }],
        },
      ],
    })
  })

  it("prints public queue positions in Queue admission order", async () => {
    let tick = 0
    const app = await createApp({
      batch: 1,
      clock: () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick++)).toISOString(),
    })
    await app.bays.intake({ branch: "issue/created-first", headSha: "1".repeat(40), base: "main" })
    await app.bays.intake({ branch: "issue/submitted-first", headSha: "2".repeat(40), base: "main" })
    await app.bays.submit({ pr: "PR2" })
    await app.bays.submit({ pr: "PR1" })
    expect(app.queue.admissionOrder()).toEqual(["PR2", "PR1"])

    const output = outputIO({
      columns: 120,
      resolveQueueTarget: async () => ({ base: "main", sha: BASE_SHA }),
    })
    expect(await runYrd(app, yrd("queue", "list"), output.io), output.stderr()).toBe(0)
    const frame = output.stdout()
    expect(frame.indexOf("pr#2.1")).toBeLessThan(frame.indexOf("pr#1.1"))
  })

  it("uses read capabilities for the dashboard and contest view without appending events", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    await app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000, now: () => 0 })
    const base = await app.contests.resolveBase()
    await app.dispatch(app.commands.issue.compete, {
      issue: { ref: { source: "km", id: "T1" }, title: "Issue one" },
      competitors: [
        { id: "fast", runner: "fixture", config: { profile: "fast" } },
        { id: "thorough", runner: "fixture", config: { profile: "thorough" } },
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
      failureClass: outcome === "integrated" ? null : "other",
      activeMs: activeMinutes * minute,
      queueWaitMs: waitMinutes.map((value) => value * minute),
      members: [],
    })
    const facts = [
      fact("R1", "integrated", 10, [5, 15], now - 6 * 60 * minute),
      fact("R2", "rejected", 20, [25]),
      fact("R3", "environment-refused", 30, [35]),
      fact("R-deduped", "already-landed", 40, [45]),
      fact("R4", "integrated", 100, [95]),
      fact("R-old", "rejected", 1_000, [1_000], now - 6 * 60 * minute - 1),
      fact("R-future", "rejected", 1_000, [1_000], now + 1),
    ]

    // windowMs = 6h so the per-24h projection is 4× the merged count (2 → 8);
    // oldestOpenMs is a live-queue fact the caller supplies, null when absent.
    expect(queueFlowMetrics(facts, { now, windowMs: 6 * 60 * minute })).toEqual({
      windowMs: 6 * 60 * minute,
      terminalAttempts: 5,
      outcomes: {
        integrated: 2,
        alreadyMerged: 1,
        passed: 0,
        rejected: 1,
        environmentRefused: 1,
        stale: 0,
        lost: 0,
        legacy: 0,
        refused: 0,
        canceled: 0,
      },
      decisionRejection: { rejected: 1, decisions: 4, rate: 1 / 4 },
      throughput: { merged: 2, per24h: 8 },
      oldestOpenMs: null,
      activeRun: {
        allTerminal: {
          n: 5,
          minMs: 10 * minute,
          avgMs: 40 * minute,
          p50Ms: 30 * minute,
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
        alreadyLandedOnly: {
          n: 1,
          minMs: 40 * minute,
          avgMs: 40 * minute,
          p50Ms: 40 * minute,
          p90Ms: 40 * minute,
          maxMs: 40 * minute,
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
        n: 6,
        avgMs: (220 / 6) * minute,
        p50Ms: 30 * minute,
        p90Ms: 95 * minute,
        maxMs: 95 * minute,
      },
    })
    expect(queueFlowMetrics([], { now, windowMs: 6 * 60 * minute, oldestOpenMs: 42 * minute })).toEqual({
      windowMs: 6 * 60 * minute,
      terminalAttempts: 0,
      outcomes: {
        integrated: 0,
        alreadyMerged: 0,
        passed: 0,
        rejected: 0,
        environmentRefused: 0,
        stale: 0,
        lost: 0,
        legacy: 0,
        refused: 0,
        canceled: 0,
      },
      decisionRejection: { rejected: 0, decisions: 0, rate: null },
      throughput: { merged: 0, per24h: 0 },
      oldestOpenMs: 42 * minute,
      activeRun: {
        allTerminal: { n: 0, minMs: null, avgMs: null, p50Ms: null, p90Ms: null, maxMs: null },
        integratedOnly: { n: 0, minMs: null, avgMs: null, p50Ms: null, p90Ms: null, maxMs: null },
        alreadyLandedOnly: { n: 0, minMs: null, avgMs: null, p50Ms: null, p90Ms: null, maxMs: null },
        failedOnly: { n: 0, minMs: null, avgMs: null, p50Ms: null, p90Ms: null, maxMs: null },
      },
      queueWait: { n: 0, avgMs: null, p50Ms: null, p90Ms: null, maxMs: null },
    })
  })

  it("windows flow metrics independently of the timeline row-listing window", () => {
    const minute = 60_000
    const now = Date.parse("2026-07-13T12:00:00.000Z")
    // One merged Run that finished 8h ago: outside a 6h listing window, inside 24h.
    const merged = fakeRun({
      id: "R1",
      status: "passed",
      pr: { id: "PR1", revision: 1, headSha: "1".repeat(40), baseSha: BASE_SHA },
      startedAt: "2026-07-13T03:50:00.000Z",
      finishedAt: "2026-07-13T04:00:00.000Z",
      steps: [],
      integration: { commit: MERGED_SHA, baseSha: BASE_SHA },
    })
    const prs = [
      timelineFixturePr("PR1", "integrated", "2026-07-13T03:45:00.000Z", undefined, {
        headSha: "1".repeat(40),
        integratedAt: "2026-07-13T04:00:00.000Z",
      }),
      timelineFixturePr("PR5", "submitted", "2026-07-13T11:00:00.000Z", undefined, {
        headSha: "5".repeat(40),
      }),
    ]
    const result: QueueStatusResult = {
      base: "main",
      prs,
      admissionOrder: fixtureAdmissionOrder(prs),
      running: [],
      waiting: [],
      finished: [merged],
    }
    const submissionTimes = new Map(prs.map((pr) => [queueRevisionKey(currentChangeSnapshot(pr)), pr.submittedAt!]))
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

    // The 6h listing window drops the 8h-old merge from both projections' rows.
    expect(shared.rows.map((row) => row.pr)).toEqual(["PR5"])
    expect(widened.rows.map((row) => row.pr)).toEqual(["PR5"])
    // Metrics honor their own window: 6h sees no merge, 24h counts it.
    expect(shared.metrics.terminalAttempts).toBe(0)
    expect(shared.metrics.throughput).toEqual({ merged: 0, per24h: 0 })
    expect(widened.metrics.terminalAttempts).toBe(1)
    expect(widened.metrics.outcomes.integrated).toBe(1)
    expect(widened.metrics.throughput).toEqual({ merged: 1, per24h: 1 })
    expect(widened.metrics.windowMs).toBe(24 * 60 * minute)
    // Oldest-open is a live-queue fact, independent of either window.
    expect(shared.oldestOpenMs).toBe(60 * minute)
    expect(shared.metrics.oldestOpenMs).toBe(60 * minute)
    expect(widened.metrics.oldestOpenMs).toBe(60 * minute)
  })

  it("keeps calendar-stat facts on the full horizon instead of inheriting the 24h metrics window", () => {
    const minute = 60_000
    const hour = 60 * minute
    const now = Date.parse("2026-07-13T12:00:00.000Z")
    const merge = (id: string, pr: string, sha: string, finishedAt: string) =>
      fakeRun({
        id,
        status: "passed",
        pr: { id: pr, revision: 1, headSha: sha, baseSha: BASE_SHA },
        startedAt: finishedAt,
        finishedAt,
        steps: [],
        integration: { commit: MERGED_SHA, baseSha: BASE_SHA },
      })
    // One merge 8h ago (inside the 24h metrics window) and one 3 days ago
    // (outside 24h, inside a week). Both are dropped from the 6h listing rows.
    const recent = merge("R1", "PR1", "1".repeat(40), "2026-07-13T04:00:00.000Z")
    const older = merge("R2", "PR2", "2".repeat(40), "2026-07-10T12:00:00.000Z")
    const prs = [
      timelineFixturePr("PR1", "integrated", "2026-07-13T03:45:00.000Z", undefined, {
        headSha: "1".repeat(40),
        integratedAt: "2026-07-13T04:00:00.000Z",
      }),
      timelineFixturePr("PR2", "integrated", "2026-07-10T11:55:00.000Z", undefined, {
        headSha: "2".repeat(40),
        integratedAt: "2026-07-10T12:00:00.000Z",
      }),
    ]
    const result: QueueStatusResult = {
      base: "main",
      prs,
      admissionOrder: fixtureAdmissionOrder(prs),
      running: [],
      waiting: [],
      finished: [recent, older],
    }
    const projection = queueTimelineProjection([result], {
      now,
      windowMs: 6 * hour,
      metricsWindowMs: 24 * hour,
      statuses: ["pending", "running", "rejected", "integrated", "other"],
      terms: [],
      latest: false,
      rowLimit: 20,
      submissionTimes: new Map(prs.map((pr) => [queueRevisionKey(currentChangeSnapshot(pr)), pr.submittedAt!])),
    })
    // The 24h metrics window counts only the recent merge.
    expect(projection.metrics.terminalAttempts).toBe(1)
    // timeStatsFacts span the FULL retained horizon — both merges — so the
    // calendar panel never inherits the 24h aggregate window.
    expect(projection.timeStatsFacts.map((f) => f.run).toSorted()).toEqual(["R1", "R2"])
    const buckets = queueStats(projection.timeStatsFacts, now, projection.earliestFactMs, 0)
    const attempts = (label: string) => buckets.find((bucket) => bucket.label === label)!.runs.all
    expect(attempts("TODAY")).toBe(1)
    expect(attempts("YSTRDAY")).toBe(0)
    expect(attempts("WEEK")).toBe(1)
    expect(attempts("MONTH")).toBe(2)
  })

  it("keeps failed-attempt retries on the Run that owned them", () => {
    const minute = 60_000
    const now = Date.parse("2026-07-13T12:00:00.000Z")
    const pr = timelineFixturePr("PR1", "integrated", "2026-07-13T09:00:00.000Z", undefined, {
      headSha: "1".repeat(40),
      integratedAt: "2026-07-13T10:00:00.000Z",
    })
    const merged = (id: string, finishedAt: string) =>
      fakeRun({
        id,
        status: "passed",
        pr: currentChangeSnapshot(pr),
        startedAt: new Date(Date.parse(finishedAt) - 10 * minute).toISOString(),
        finishedAt,
        steps: [],
        integration: { commit: MERGED_SHA, baseSha: BASE_SHA },
      })
    const older = merged("R-old", "2026-07-13T10:00:00.000Z")
    const newer = merged("R-new", "2026-07-13T11:00:00.000Z")
    const result: QueueStatusResult = {
      base: "main",
      prs: [pr],
      admissionOrder: fixtureAdmissionOrder([pr]),
      running: [],
      waiting: [],
      finished: [newer, older],
    }
    const failedAttempt: QueueAttempt = {
      job: "J-new-check-1",
      run: "R-new",
      step: "check",
      index: 0,
      attempt: 1,
      runner: "runner-1",
      outcome: "failed",
      requestedAt: "2026-07-13T10:51:00.000Z",
      startedAt: "2026-07-13T10:52:00.000Z",
      finishedAt: "2026-07-13T10:53:00.000Z",
      durationMs: minute,
      revision: "check-v1",
      result: {
        status: "failed",
        error: { code: "check-failed", message: "retry the newer run" },
      },
    }
    const projection = queueTimelineProjection([result], {
      now,
      windowMs: 6 * 60 * minute,
      statuses: ["pending", "running", "rejected", "integrated", "other"],
      terms: [],
      latest: false,
      rowLimit: 20,
      submissionTimes: queueTimelineAdmissionTimes([result]),
      attempts: [failedAttempt],
    })

    expect(Object.fromEntries(projection.timeStatsFacts.map((fact) => [fact.run, fact.members[0]?.retries]))).toEqual({
      "R-new": 1,
      "R-old": 0,
    })
  })

  it("keeps one recut PR card with cumulative source-ready age and revision lineage", async () => {
    const minute = 60_000
    const firstSubmittedAt = "2026-07-13T10:00:00.000Z"
    const currentSubmittedAt = "2026-07-13T11:55:00.000Z"
    const now = Date.parse("2026-07-13T12:00:00.000Z")
    const patchId = "d".repeat(40)
    const treeSha = "e".repeat(40)
    const pr: Change = {
      id: "PR1",
      branch: "topic/recut",
      base: "main",
      state: "open",
      merged: false,
      revs: [
        {
          n: 1,
          head: "1".repeat(40),
          base: "main",
          baseSha: BASE_SHA,
          pushedAt: "2026-07-13T09:59:00.000Z",
          submittedAt: firstSubmittedAt,
        },
        {
          n: 2,
          head: "2".repeat(40),
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
      admissionOrder: fixtureAdmissionOrder([pr]),
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
      submissionTimes: new Map([[queueRevisionKey(currentChangeSnapshot(pr)), currentSubmittedAt]]),
    })

    expect(projection.rows).toHaveLength(1)
    expect(projection.rows[0]).toMatchObject({
      pr: "PR1",
      revision: 2,
      status: "ready",
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
      pr: currentChangeSnapshot(pr),
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
      submissionTimes: new Map([[queueRevisionKey(currentChangeSnapshot(pr)), currentSubmittedAt]]),
    })
    expect(runningProjection.rows).toMatchObject([
      {
        run: "R1",
        pr: "PR1",
        revision: 2,
        status: "running",
        revisionLineage: [{ pr: "PR1", revisions: [1, 2], sourceReadyAt: firstSubmittedAt }],
        detail: "in_progress · rev1→rev2",
      },
    ])

    const finishedAt = "2026-07-13T12:00:00.000Z"
    const integratedPr: Change = {
      ...pr,
      state: "closed",
      merged: true,
      integratedAt: finishedAt,
      integration: { commit: MERGED_SHA, baseSha: "b".repeat(40) },
      revs: pr.revs.map((revision) =>
        revision.n === 2 ? { ...revision, terminal: { kind: "integrated", at: finishedAt, run: "R2" } } : revision,
      ),
    }
    const integratedRevision = currentChangeRev(integratedPr)
    const integratedRun = fakeRun({
      id: "R2",
      status: "passed",
      pr: {
        id: integratedPr.id,
        revision: integratedRevision.n,
        headSha: integratedRevision.head,
        baseSha: integratedRevision.baseSha,
      },
      startedAt: "2026-07-13T11:57:00.000Z",
      finishedAt,
      steps: [],
      integration: { commit: MERGED_SHA, baseSha: integratedRevision.baseSha! },
    })
    const retryAttempt: QueueAttempt = {
      job: "J-R2-check-1",
      run: "R2",
      step: "check",
      index: 0,
      attempt: 1,
      runner: "runner-1",
      outcome: "failed",
      requestedAt: "2026-07-13T11:57:00.000Z",
      startedAt: "2026-07-13T11:57:01.000Z",
      finishedAt: "2026-07-13T11:58:01.000Z",
      durationMs: minute,
      revision: "check-v1",
      result: {
        status: "failed",
        error: { code: "check-failed", message: "retry once" },
      },
    }
    const settledProjection = queueTimelineProjection([{ ...result, prs: [integratedPr], finished: [integratedRun] }], {
      now,
      windowMs: 6 * 60 * minute,
      statuses: ["pending", "running", "rejected", "integrated", "other"],
      terms: [],
      latest: false,
      rowLimit: 20,
      submissionTimes: queueTimelineAdmissionTimes([{ ...result, prs: [integratedPr], finished: [integratedRun] }]),
      attempts: [retryAttempt],
    })
    expect(settledProjection.timeStatsFacts).toMatchObject([
      {
        run: "R2",
        outcome: "integrated",
        queueWaitMs: [2 * minute],
        members: [
          {
            pr: "PR1",
            totalMs: 121 * minute,
            totalApproximate: false,
            codingMs: null,
            jobRunMs: minute,
            retries: 2,
          },
        ],
      },
    ])
  })

  it("renders every batched change revision as its own settled queue row", async () => {
    const now = Date.parse("2026-07-13T12:00:00.000Z")
    const submittedAt = "2026-07-13T11:30:00.000Z"
    const finishedAt = "2026-07-13T11:50:00.000Z"
    const pr = (id: string, submitter: string, headSha: string): Change => ({
      id,
      name: `${id} subject`,
      branch: `topic/${id}`,
      base: "main",
      state: "closed",
      merged: true,
      revs: [
        {
          n: 1,
          head: headSha,
          base: "main",
          baseSha: BASE_SHA,
          pushedAt: submittedAt,
          submittedAt,
          submitter,
          terminal: { kind: "integrated", at: finishedAt },
        },
      ],
      reviews: [],
      comments: [],
      checkRequests: [],
      submittedAt,
      integratedAt: finishedAt,
    })
    const prs = [pr("PR1", "@cto", "1".repeat(40)), pr("PR2", "@agent/3", "2".repeat(40))]
    const run: Run = {
      ...fakeRun({
        id: "R1",
        status: "passed",
        startedAt: "2026-07-13T11:40:00.000Z",
        finishedAt,
        steps: [fakeStep("check", "passed", fakeJob({ id: JOB_CHECK_PASS_ID, status: "passed" }))],
        integration: { commit: MERGED_SHA, baseSha: BASE_SHA },
      }),
      prs: prs.map(currentChangeSnapshot),
    }
    const result: QueueStatusResult = {
      base: "main",
      prs,
      admissionOrder: fixtureAdmissionOrder(prs),
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
      // Height fits the STATS panel; a standalone QueueTimelineView
      // has no fillHeight list-scroll, so a box tuned to the old short grid would
      // clip the FILTER/header rows. Production (QueueWatchFrame) scrolls the list.
      await renderString(createElement(QueueTimelineView, { projection, columns: 140 }), {
        width: 140,
        height: 44,
        plain: true,
      }),
    )
    const rows = rendered.split("\n").filter(Boolean)
    const header = rows.find((row) => row.includes("TIME") && row.includes("STATUS") && row.includes("CHANGES"))
    expect(header).toBeDefined()
    for (const label of ["TIME", "STATUS", "RUN", "CHANGES", "BY", "AGE"]) expect(header).toContain(label)
    // STEP folded into the CHANGES cell (item Q), so it is no longer a header column.
    for (const removed of ["STEP", "SUBJECT", "DETAIL", "ACTIVE", "WAIT", "TOTAL"]) {
      expect(header).not.toContain(removed)
    }
    const first = rows.find((row) => row.includes("pr#1.1"))
    const second = rows.find((row) => row.includes("pr#2.1"))
    // The status renders once, in the STATUS cell; the RUN cell is identity
    // only (amendment 2026-08-25 removed its icon-only duplicate).
    expect(first).toContain("merged")
    expect(first).toContain("#1 ")
    expect(first).toContain("@cto")
    // An adjacent member of the SAME run keeps its own TIME/STATUS cells —
    // Round 8 blanked them, making a co-merged PR print exactly like one that
    // was never attempted (@i/10-merge-queue/22925, operator 2026-08-17).
    // Item 38 refines the RUN cell only: the shared id renders on the FIRST
    // member row and the partner carries the muted `·` membership dot.
    expect(second?.trimStart()).not.toMatch(/^-\s+-\s+-\s+pr#2\.1\b/u)
    expect(second).toMatch(/merged\s+·\s+pr#2\.1/u)
    expect(second).toContain("@agent/3")
    expect(rendered).not.toContain("R1·PR1,PR2")
    expect(rendered).not.toContain("siblings none")
    // Item 2/3: the status pills row moved BELOW the list (was directly above
    // the header) and dropped its "FILTER" label — plain-word pills now.
    const pillsRowIndex = rows.findIndex((row) => /open.*running.*done.*failed/u.test(row))
    expect(pillsRowIndex, "pills row renders below the rows").toBeGreaterThan(rows.indexOf(second!))
    const statsIndex = rows.findIndex((row) => row.includes("╭─ STATS "))
    expect(statsIndex).toBeGreaterThan(pillsRowIndex)
  })

  /** A pid PROVEN absent by signal 0, rather than a large number assumed unused. */
  function unusedPid(): number {
    for (let candidate = 4_194_303; candidate > 4_190_000; candidate -= 1) {
      try {
        process.kill(candidate, 0)
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ESRCH") return candidate
      }
    }
    throw new Error("no unused pid available for the departed-runner probe")
  }

  it("projects fresh, stale, dead-pid, and absent habitant runner heartbeats", async () => {
    const repo = mkdtempSync(join(tmpdir(), "yrd-runner-status-"))
    execFileSync("git", ["init", "-q", repo])
    const statusDir = join(repo, ".git", "yrd", "resident-runner")
    const statusPath = join(statusDir, "status.json")
    mkdirSync(statusDir, { recursive: true })
    // A LIVE pid, because fresh/stale are heartbeat classifications OF a running
    // runner. This process is the only pid a test can prove is alive.
    const runner = {
      pid: process.pid,
      startedAt: "2026-07-13T11:00:00.000Z",
      lastTickAt: "2026-07-13T11:59:55.000Z",
      implementationSource: "git:35562d1579f140669a453b310340582b8cc1b42f",
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
        // 75.001s past the tick: beyond RUNNER_VIEW_STALE_MS (the
        // coalescing-ceiling bound, operator 2026-08-25).
        now: () => Date.parse("2026-07-13T12:01:10.001Z"),
        resolveQueueTarget,
      })
      expect(await runYrd(app, yrd("queue", "list"), stale.io), stale.stderr()).toBe(0)
      expect(stale.stdout()).toContain("RUNNER STALE")
      expect(stale.stdout()).toContain(runner.implementationSource)

      const { implementationSource: _legacySource, ...legacyRunner } = runner
      writeFileSync(statusPath, JSON.stringify(legacyRunner))
      const legacy = outputIO({
        cwd: repo,
        now: () => Date.parse("2026-07-13T12:00:00.000Z"),
        resolveQueueTarget,
      })
      expect(await runYrd(app, yrd("queue", "list", "--json"), legacy.io), legacy.stderr()).toBe(0)
      expect(JSON.parse(legacy.stdout())).toMatchObject({
        command: "queue.list",
        projection: { runner: { implementationSource: "unknown" } },
      })
      const legacyHuman = outputIO({
        cwd: repo,
        now: () => Date.parse("2026-07-13T12:00:00.000Z"),
        resolveQueueTarget,
      })
      expect(await runYrd(app, yrd("queue", "list"), legacyHuman.io), legacyHuman.stderr()).toBe(0)
      expect(legacyHuman.stdout()).toContain("source unknown")

      // A runner killed by SIGKILL, OOM, or a crash never writes `exitedAt`, so
      // its status file outlives it with a plausible pid and a frozen heartbeat.
      // Reading that as STALE describes a runner that is merely late; the queue
      // is in fact unattended, and the operator needs the second answer. Live
      // specimen 2026-07-25: pid 20486 gone, `queue list` said STALE, and the
      // outage was found by whoever next ran a command.
      // Three runner-absence states, three sentences. They shared one — "NO
      // RUNNER - no drained run in window" was asserted here verbatim for both
      // the dead-pid runner and the deleted status file — so the banner
      // announced that nothing drains the queue without saying whether a runner
      // had died or none was ever started, and named no remedy for either.
      const departedPid = unusedPid()
      writeFileSync(statusPath, JSON.stringify({ ...runner, pid: departedPid }))
      const dead = outputIO({
        cwd: repo,
        now: () => Date.parse("2026-07-13T12:00:20.001Z"),
        resolveQueueTarget,
      })
      expect(await runYrd(app, yrd("queue", "list"), dead.io), dead.stderr()).toBe(0)
      // Last heartbeat 11:59:55, read at 12:00:20 — a runner gone 25s with no
      // exit marker of its own.
      expect(dead.stdout()).toContain(
        `NO RUNNER - habitant runner [${departedPid}] died 0:25 ago, no exit marker; restart it: yrd queue run main`,
      )
      expect(dead.stdout(), "a departed runner is not a late one").not.toContain("RUNNER STALE")

      // A runner that wrote its own exit marker stopped on purpose; the same
      // remedy, but nothing to investigate.
      writeFileSync(
        statusPath,
        JSON.stringify({ ...runner, pid: departedPid, exitedAt: "2026-07-13T12:00:00.000Z", clean: true }),
      )
      const stopped = outputIO({
        cwd: repo,
        now: () => Date.parse("2026-07-13T12:00:20.001Z"),
        resolveQueueTarget,
      })
      expect(await runYrd(app, yrd("queue", "list"), stopped.io), stopped.stderr()).toBe(0)
      expect(stopped.stdout()).toContain(
        `NO RUNNER - habitant runner [${departedPid}] stopped 0:20 ago; restart it: yrd queue run main`,
      )

      rmSync(statusPath)
      const absent = outputIO({ cwd: repo, resolveQueueTarget })
      expect(await runYrd(app, yrd("queue", "list"), absent.io), absent.stderr()).toBe(0)
      // This io keeps the ambient clock, so the wait clause between the fact and
      // the remedy is whatever the open submission has aged to; both halves are
      // pinned exactly, on a fixed clock, in queue-no-runner-banner.test.ts.
      expect(absent.stdout()).toContain("NO RUNNER - no runner has ever drained this queue")
      expect(absent.stdout()).toContain("start one: yrd queue run main")
      // The pin that matters: no two of the three states may print the same
      // line, which is exactly what the previous assertions permitted.
      const banners = [dead, stopped, absent].map(
        (io) =>
          io
            .stdout()
            .split("\n")
            .find((line) => line.includes("NO RUNNER"))
            ?.trim() ?? "",
      )
      expect(banners.every((line) => line !== "")).toBe(true)
      expect(new Set(banners).size, `three absence states must print three sentences: ${banners.join(" | ")}`).toBe(3)
    } finally {
      safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
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
    // The checkout sits one commit ahead of the queue base's tip (`main`):
    // the distance the probe reports is measured against that tip, the ref
    // every Run resolves its plan from, never against a stored file.
    execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "local-ahead"])
    writeFileSync(join(repo, "distance.txt"), "ahead\n")
    execFileSync("git", ["-C", repo, "add", "distance.txt"])
    execFileSync("git", ["-C", repo, "commit", "-qm", "ahead"])
    writeFileSync(join(repo, "untracked-divergence.txt"), "local\n")

    const app = await createApp()
    const driver = {
      queueId: `${repo}#main`,
      epoch: "11111111-1111-4111-8111-111111111111",
      lastMerged: null,
    }
    let findings: QueueAuditEmission["findings"] = []
    const services: YrdCliServices = {
      queue: { auditEnvironment: async () => ({ findings, comparison: stubAuditComparison() }) },
    }
    const lockRelease = Promise.withResolvers<void>()
    const lockAcquired = Promise.withResolvers<void>()
    let lock: Promise<void> | undefined
    try {
      // Never the "yrd-runner" default from run.ts: an identity equal to the fallback
      // passes even with the health plumbing removed.
      const absent = outputIO({ cwd: repo, healthServiceName: "yrd-runner-under-test" })
      expect(await runYrd(app, yrd("queue", "list", "--check", "--json"), absent.io, services)).toBe(1)
      expect(JSON.parse(absent.stdout())).toMatchObject({
        schema: "hab-service-health/1",
        service: "yrd-runner-under-test",
        state: "absent",
        running: false,
        facts: { lease: "free", git: { dirty: true, base: { base: "main", baseSha, ahead: 1, behind: 0 } } },
      })

      await openAndSubmit(app)
      const stranded = outputIO({ cwd: repo })
      expect(await runYrd(app, yrd("queue", "list", "--check", "--json"), stranded.io, services)).toBe(2)
      expect(JSON.parse(stranded.stdout())).toMatchObject({
        schema: "hab-service-health/1",
        state: "unhealthy",
        running: false,
        error: {
          code: "resident-runner-missing",
          resolution: ["Start or restart the habitant queue runner."],
        },
        facts: { lease: "free", runnerStatus: "missing" },
      })

      lock = createExclusive(join(stateDir, "resident-runner"), { timeoutMs: 0 }).run(
        async () => {
          lockAcquired.resolve()
          await lockRelease.promise
        },
        { holder: `queue=${driver.queueId} epoch=${driver.epoch}` },
      )
      await lockAcquired.promise
      mkdirSync(join(stateDir, "resident-runner"), { recursive: true })
      writeFileSync(
        join(stateDir, "resident-runner", "status.json"),
        JSON.stringify({
          pid: process.pid,
          startedAt: "2026-07-09T12:00:00.000Z",
          lastTickAt: "2026-07-09T12:00:58.000Z",
          command: "yrd queue run",
        }),
      )

      const progressUnknown = outputIO({ cwd: repo })
      expect(await runYrd(app, yrd("queue", "list", "--check", "--json"), progressUnknown.io, services)).toBe(2)
      expect(JSON.parse(progressUnknown.stdout())).toMatchObject({
        schema: "hab-service-health/1",
        state: "unhealthy",
        running: true,
        error: { code: "resident-runner-driver-unknown" },
        facts: { lease: "held", runnerStatus: "fresh" },
      })

      writeFileSync(
        join(stateDir, "resident-runner", "status.json"),
        JSON.stringify({
          pid: process.pid,
          startedAt: "2026-07-09T12:00:00.000Z",
          lastTickAt: "2026-07-09T12:00:58.000Z",
          command: "yrd queue run",
          queueProgress: { state: "healthy", observedAt: "2026-07-09T12:00:58.000Z" },
          driver: { ...driver, queueId: `${repo}#release` },
        }),
      )
      const wrongDriver = outputIO({ cwd: repo })
      expect(await runYrd(app, yrd("queue", "list", "--check", "--json"), wrongDriver.io, services)).toBe(2)
      expect(JSON.parse(wrongDriver.stdout())).toMatchObject({
        schema: "hab-service-health/1",
        state: "unhealthy",
        running: true,
        error: { code: "resident-runner-driver-mismatch" },
      })

      writeFileSync(
        join(stateDir, "resident-runner", "status.json"),
        JSON.stringify({
          pid: process.pid,
          startedAt: "2026-07-09T12:00:00.000Z",
          lastTickAt: "2026-07-09T12:00:58.000Z",
          command: "yrd queue run",
          queueProgress: { state: "healthy", observedAt: "2026-07-09T12:00:58.000Z" },
          driver,
        }),
      )
      // A habitant outlives the CLI reading it, so its status is a wire between
      // two independently-versioned processes. On 2026-08-18 a rename of this
      // key (lastLanded -> lastMerged) made every fresh CLI REFUSE against a
      // habitant started minutes earlier: `queue list`, `why` and the watch
      // pane's status poll all exited 3 while the queue itself kept merging
      // fine. The old spelling is read, and an unreported position reads
      // healthy -- a live habitant omits the key until it has merged anything,
      // so absence has never meant a fault.
      writeFileSync(
        join(stateDir, "resident-runner", "status.json"),
        JSON.stringify({
          pid: process.pid,
          startedAt: "2026-07-09T12:00:00.000Z",
          lastTickAt: "2026-07-09T12:00:58.000Z",
          command: "yrd queue run",
          queueProgress: { state: "healthy", observedAt: "2026-07-09T12:00:58.000Z" },
          driver: { queueId: driver.queueId, epoch: driver.epoch, lastLanded: null },
        }),
      )
      const legacySpelling = outputIO({ cwd: repo })
      expect(await runYrd(app, yrd("queue", "list", "--check", "--json"), legacySpelling.io, services)).toBe(0)
      expect(JSON.parse(legacySpelling.stdout())).toMatchObject({
        schema: "hab-service-health/1",
        state: "healthy",
        running: true,
        facts: { lease: "held", runnerStatus: "fresh" },
      })

      writeFileSync(
        join(stateDir, "resident-runner", "status.json"),
        JSON.stringify({
          pid: process.pid,
          startedAt: "2026-07-09T12:00:00.000Z",
          lastTickAt: "2026-07-09T12:00:58.000Z",
          command: "yrd queue run",
          queueProgress: { state: "healthy", observedAt: "2026-07-09T12:00:58.000Z" },
          driver: { queueId: driver.queueId, epoch: driver.epoch },
        }),
      )
      const unreportedMerge = outputIO({ cwd: repo })
      expect(await runYrd(app, yrd("queue", "list", "--check", "--json"), unreportedMerge.io, services)).toBe(0)
      expect(JSON.parse(unreportedMerge.stdout())).toMatchObject({
        schema: "hab-service-health/1",
        state: "healthy",
        running: true,
        facts: { lease: "held", runnerStatus: "fresh" },
      })

      writeFileSync(
        join(stateDir, "resident-runner", "status.json"),
        JSON.stringify({
          pid: process.pid,
          startedAt: "2026-07-09T12:00:00.000Z",
          lastTickAt: "2026-07-09T12:00:58.000Z",
          command: "yrd queue run",
          queueProgress: { state: "healthy", observedAt: "2026-07-09T12:00:58.000Z" },
          driver,
        }),
      )
      const progressing = outputIO({ cwd: repo })
      expect(await runYrd(app, yrd("queue", "list", "--check", "--json"), progressing.io, services)).toBe(0)
      expect(JSON.parse(progressing.stdout())).toMatchObject({
        schema: "hab-service-health/1",
        state: "healthy",
        running: true,
        facts: {
          lease: "held",
          leaseDriver: { queueId: driver.queueId, epoch: driver.epoch },
          runnerStatus: "fresh",
          queueProgress: { state: "healthy", observedAt: "2026-07-09T12:00:58.000Z" },
        },
      })

      writeFileSync(
        join(stateDir, "resident-runner", "status.json"),
        JSON.stringify({
          pid: process.pid,
          startedAt: "2026-07-09T12:00:00.000Z",
          lastTickAt: "2026-07-09T12:00:58.000Z",
          command: "yrd queue run",
          queueProgress: { state: "healthy", observedAt: "2026-07-09T12:00:00.000Z" },
          driver,
        }),
      )
      const staleProgress = outputIO({ cwd: repo })
      expect(await runYrd(app, yrd("queue", "list", "--check", "--json"), staleProgress.io, services)).toBe(2)
      expect(JSON.parse(staleProgress.stdout())).toMatchObject({
        schema: "hab-service-health/1",
        state: "unhealthy",
        running: true,
        error: { code: "resident-runner-progress-stale" },
        facts: {
          runnerStatus: "fresh",
          queueProgress: { state: "healthy", observedAt: "2026-07-09T12:00:00.000Z" },
        },
      })

      const refusalFinding = {
        code: "admission-refusal-loop",
        message: "change 'PR1' failed its entry checks 160 consecutive times",
        pr: "PR1",
        specimen: "pr:PR1:refusal:base-moved",
        refusal: "base-moved",
        count: 160,
        since: "2026-07-09T11:00:00.000Z",
        blockedMs: 3_600_000,
      }
      writeFileSync(
        join(stateDir, "resident-runner", "status.json"),
        JSON.stringify({
          pid: process.pid,
          startedAt: "2026-07-09T12:00:00.000Z",
          lastTickAt: "2026-07-09T12:00:58.000Z",
          command: "yrd queue run",
          queueProgress: { state: "stalled", observedAt: "2026-07-09T12:00:58.000Z", findings: [refusalFinding] },
          driver,
        }),
      )
      const stalled = outputIO({ cwd: repo })
      expect(await runYrd(app, yrd("queue", "list", "--check", "--json"), stalled.io, services)).toBe(2)
      expect(JSON.parse(stalled.stdout())).toMatchObject({
        schema: "hab-service-health/1",
        state: "unhealthy",
        running: true,
        error: { code: "resident-runner-no-progress" },
        facts: {
          lease: "held",
          runnerStatus: "fresh",
          queueProgress: {
            state: "stalled",
            observedAt: "2026-07-09T12:00:58.000Z",
            findings: [refusalFinding],
          },
        },
      })

      await app.bays.requestChecks({ pr: "PR1", baseSha })
      const stalledHuman = outputIO({ cwd: repo })
      expect(await runYrd(app, yrd("queue", "list"), stalledHuman.io, services)).toBe(0)
      expect(stalledHuman.stdout()).toContain("position 1 · base-moved")

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
          lastTickAt: "2026-07-09T12:00:58.000Z",
          command: "yrd queue run",
          driver,
        }),
      )

      const historyIndependent = outputIO({ cwd: repo })
      const loadHistory = vi.fn(async () => {
        throw new Error("journal history must not be loaded by the supervisor probe")
      })
      expect(
        await runInternals.runYrdProcessRuntime(yrd("queue", "list", "--check", "--json"), historyIndependent.io, {
          ambientCwd: repo,
          env: process.env,
          load: loadHistory,
          probe: async () => ({ services }),
        }),
      ).toBe(2)
      expect(loadHistory).not.toHaveBeenCalled()
      expect(JSON.parse(historyIndependent.stdout())).toMatchObject({
        schema: "hab-service-health/1",
        state: "unhealthy",
        running: true,
        error: { code: "resident-runner-progress-unknown" },
        facts: { lease: "held", runnerStatus: "fresh" },
      })

      writeFileSync(
        join(stateDir, "resident-runner", "status.json"),
        JSON.stringify({
          pid: process.pid,
          startedAt: "2026-07-09T12:00:00.000Z",
          lastTickAt: "2026-07-09T12:00:40.000Z",
          driver,
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
          driver,
        }),
      )

      findings = [
        {
          code: "installed-plan-stale",
          message:
            "yrd: this process installed check→merge (batch 1), but main tip 11111111 (config blob 22222222) declares " +
            "check→affected-tests→merge (batch 1): step 'affected-tests' is declared at the tip but not installed in " +
            "this process. Restart this queue runner so it builds the declared steps.",
        },
      ]
      const unhealthy = outputIO({ cwd: repo })
      expect(await runYrd(app, yrd("queue", "list", "--check", "--json"), unhealthy.io, services)).toBe(2)
      expect(JSON.parse(unhealthy.stdout())).toMatchObject({
        schema: "hab-service-health/1",
        state: "unhealthy",
        running: true,
        error: {
          code: "installed-plan-stale",
          resolution: ["Restart the habitant queue runner so it builds the steps the base declares."],
        },
      })

      const human = outputIO({ cwd: repo })
      expect(await runYrd(app, yrd("queue", "list", "--check"), human.io, services)).toBe(2)
      expect(human.stdout()).toContain("err=installed-plan-stale")
      expect(human.stdout()).toContain("main tip 11111111 (config blob 22222222) declares")
      expect(human.stdout()).toContain("step 'affected-tests' is declared at the tip but not installed in this process")
      expect(human.stdout()).toContain(
        "resolve: Restart the habitant queue runner so it builds the steps the base declares.",
      )
      expect(human.stdout()).toContain(`git main: ahead=1 behind=0 tip=${baseSha.slice(0, 12)}`)
    } finally {
      lockRelease.resolve()
      await lock
      safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
    }
  })

  it("projects canonical queue-progress findings into the habitant heartbeat without re-deriving readiness", async () => {
    const app = await createApp()
    const project = (
      runInternals as typeof runInternals & {
        habitantQueueProgress(app: TestApp, now: string): unknown
      }
    ).habitantQueueProgress
    const noMerge = {
      code: "queue-progress-stalled",
      message: "Queue 'main' has one required-check PR queued and no merge for 30m",
      pr: "PR1",
      specimen: "queue:main",
      count: 1,
      since: "2026-07-09T12:00:00.000Z",
      blockedMs: 1_800_000,
    }
    const neverStarted = {
      code: "queue-never-started",
      message: "Queue 'main' has one submitted PR that never started required checks for 30m",
      resolution: ["Start the habitant queue runner and verify it requests checks for PR1."],
      pr: "PR1",
      specimen: "queue:main:never-started",
      count: 1,
      since: "2026-07-09T12:00:00.000Z",
      blockedMs: 1_800_000,
    }
    const refusalLoop = {
      code: "admission-refusal-loop",
      message:
        "change 'PR1' failed its entry checks 160 consecutive times; latest failure " +
        "'recut-gitlink-conflict': yrd: change 'PR1' could not recut: target root " +
        "'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' pins submodule 'dep' to " +
        "'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; replayed authored root " +
        "'cccccccccccccccccccccccccccccccccccccccc' pins it to " +
        "'dddddddddddddddddddddddddddddddddddddddd'; ancestry walk failed because neither submodule commit is " +
        "an ancestor of the other",
      pr: "PR1",
      specimen: "pr:PR1:refusal:base-moved",
      refusal: "recut-gitlink-conflict",
      count: 160,
      since: "2026-07-09T11:00:00.000Z",
      blockedMs: 3_600_000,
    }
    const expiredHold = {
      code: "queue-hold-expired",
      message: "Queue 'main' hold expired 10m ago but still blocks admission",
      specimen: "queue:main",
      since: "2026-07-09T12:00:00.000Z",
      blockedMs: 600_000,
    }
    let findings: Array<typeof noMerge | typeof neverStarted | typeof refusalLoop | typeof expiredHold> = []
    const progressApp = {
      state: () => app.state(),
      queue: { audit: () => ({ findings }) },
    } as unknown as TestApp

    expect(project(progressApp, "2026-07-09T12:10:00.000Z")).toEqual({
      state: "healthy",
      observedAt: "2026-07-09T12:10:00.000Z",
    })

    findings = [noMerge]
    expect(project(progressApp, "2026-07-09T12:10:00.000Z")).toEqual({
      state: "stalled",
      observedAt: "2026-07-09T12:10:00.000Z",
      findings: [noMerge],
    })

    findings = [neverStarted]
    expect(project(progressApp, "2026-07-09T12:10:00.000Z")).toEqual({
      state: "stalled",
      observedAt: "2026-07-09T12:10:00.000Z",
      findings: [neverStarted],
    })

    // A REFUSING CHANGE IS NOT AN UNHEALTHY SERVICE. `admission-refusal-loop` is
    // a fact about one change, and this projection gates `hab up`: admitting it
    // made a bad change brick the runner, which is the only thing that could
    // process that change's fix. Measured 2026-08-29 on PR2599 — it failed
    // `manifest-co-change` correctly, and the service then refused to start with
    // `resident-runner-no-progress` while its singleton lease stayed held.
    // `queue audit` and the `mr list` WHY column still carry the finding.
    findings = [refusalLoop]
    expect(project(progressApp, "2026-07-09T12:10:00.000Z")).toEqual({
      state: "healthy",
      observedAt: "2026-07-09T12:10:00.000Z",
    })

    // POSITIVE CONTROL: a genuine SERVICE finding alongside it still stalls, so
    // the narrowing cannot have made this projection blind to everything.
    findings = [refusalLoop, neverStarted]
    expect(project(progressApp, "2026-07-09T12:10:00.000Z")).toEqual({
      state: "stalled",
      observedAt: "2026-07-09T12:10:00.000Z",
      findings: [neverStarted],
    })

    findings = [expiredHold]
    expect(project(progressApp, "2026-07-09T12:10:00.000Z")).toEqual({
      state: "stalled",
      observedAt: "2026-07-09T12:10:00.000Z",
      findings: [expiredHold],
    })
  })

  it("runs an independent dead-man check before a normal process-runtime command", async () => {
    const repo = mkdtempSync(join(tmpdir(), "yrd-client-dead-man-"))
    execFileSync("git", ["init", "-q", "-b", "main", repo])
    execFileSync("git", ["-C", repo, "config", "user.name", "Yrd Test"])
    execFileSync("git", ["-C", repo, "config", "user.email", "yrd@example.invalid"])
    writeFileSync(join(repo, "README.md"), "base\n")
    execFileSync("git", ["-C", repo, "add", "README.md"])
    execFileSync("git", ["-C", repo, "commit", "-qm", "base"])
    const app = await createApp()
    await openAndSubmit(app)
    const output = outputIO({ cwd: repo, now: () => Date.parse("2026-07-13T12:30:00.000Z") })
    try {
      expect(
        await runInternals.runYrdProcessRuntime(yrd("pr", "list"), output.io, {
          ambientCwd: repo,
          env: process.env,
          load: async () => ({ app, services: {}, io: { cwd: repo, now: output.io.now } }),
        }),
      ).toBe(0)
      expect(output.stderr()).toContain("yrd: dead-man:")
      expect(output.stderr()).toContain("no habitant runner owns the drain lease")
    } finally {
      await app.close()
      safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
    }
  })

  it("checks the configured queue identity in the client dead-man", async () => {
    const repo = mkdtempSync(join(tmpdir(), "yrd-client-dead-man-base-"))
    execFileSync("git", ["init", "-q", "-b", "main", repo])
    const app = await createApp()
    const stateDir = join(repo, ".git", "yrd", "resident-runner")
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(
      join(stateDir, "status.json"),
      JSON.stringify({
        pid: process.pid,
        startedAt: "2026-07-13T12:00:00.000Z",
        lastTickAt: "2026-07-13T12:29:59.000Z",
        driver: {
          queueId: `${repo}#release/2.0`,
          epoch: "11111111-1111-4111-8111-111111111111",
          lastMerged: null,
        },
      }),
    )
    const output = outputIO({ cwd: repo, now: () => Date.parse("2026-07-13T12:30:00.000Z") })
    try {
      expect(
        await runInternals.runYrdProcessRuntime(yrd("pr", "list"), output.io, {
          ambientCwd: repo,
          env: process.env,
          load: async () => ({
            app,
            services: { base: "release/2.0" },
            io: { cwd: repo, now: output.io.now },
          }),
        }),
      ).toBe(0)
      expect(output.stderr()).not.toContain("dead-man")
    } finally {
      await app.close()
      safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
    }
  })

  it("writes never-started queue progress into a live habitant heartbeat", async () => {
    const repo = mkdtempSync(join(tmpdir(), "yrd-runner-never-started-"))
    execFileSync("git", ["init", "-q", repo])
    const statusPath = join(repo, ".git", "yrd", "resident-runner", "status.json")
    let now = Date.parse("2026-07-13T12:00:00.000Z")
    const app = await createApp({ clock: () => new Date(now).toISOString() })
    try {
      await openAndSubmit(app)
      const pr = app.bays.pr("PR1")
      if (pr === undefined) throw new Error("submitted PR was not recorded")
      expect(changeDeliveryState(pr)).toBe("submitted")
      expect(app.bays.checksRequested("PR1")).toBe(false)

      now += 30 * 60_000
      const heartbeat = await runInternals.startHabitantRunnerHeartbeat(
        outputIO({ cwd: repo, runner: `yrd-cli:${process.pid}`, now: () => now }).io,
        {
          intervalMs: 60_000,
          queueProgress: (observedAt) => runInternals.habitantQueueProgress(app, observedAt),
          driver: { queueId: `${repo}#main`, lastMerged: () => null },
        },
      )
      try {
        expect(JSON.parse(readFileSync(statusPath, "utf8"))).toMatchObject({
          pid: process.pid,
          startedAt: "2026-07-13T12:30:00.000Z",
          lastTickAt: "2026-07-13T12:30:00.000Z",
          queueProgress: {
            state: "stalled",
            observedAt: "2026-07-13T12:30:00.000Z",
            findings: [
              {
                code: "queue-never-started",
                pr: "PR1",
                specimen: "queue:main:never-started",
                since: "2026-07-13T12:00:00.000Z",
                blockedMs: 30 * 60_000,
                resolution: [
                  "Start or restart the habitant queue runner, then verify it requests required checks for 'PR1'.",
                ],
              },
            ],
          },
        })
        heartbeat.check()
      } finally {
        await heartbeat.close(true)
      }
    } finally {
      await app.close()
      safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
    }
  })

  /**
   * The consumption half of the same gap the previous test's neighbor
   * describes (@i/10-merge-queue/drafts-strand-silently): the DETECTOR is not
   * new (queue.audit's draft-stranded finding, proven above and in
   * orphaned-run-recovery.test.ts), but nothing that watches the queue ever
   * read it — 22 drafts sat a day unnoticed despite an audit that had the
   * answer the whole time. These three tests prove the finding actually
   * reaches a live seat: the habitant heartbeat (this test), `queue list
   * --check` (the fleet health surface), and `queue list` / `queue list
   * --watch` (the same loader `yrd watch` renders).
   */
  it("writes page-worthy stale drafts into the habitant heartbeat, gated by the page threshold", async () => {
    const repo = mkdtempSync(join(tmpdir(), "yrd-runner-stale-drafts-"))
    execFileSync("git", ["init", "-q", repo])
    const statusPath = join(repo, ".git", "yrd", "resident-runner", "status.json")
    const app = await createApp({ clock: () => "2026-07-09T12:00:00.000Z" })
    const fourHourThresholdMs = 4 * 60 * 60_000
    try {
      await app.bays.intake({
        branch: "issue/stranded-draft",
        headSha: "3".repeat(40),
        base: "main",
        baseSha: BASE_SHA,
        submitter: "@dev/11",
      })
      const pr = Object.values(app.state().bays.prs).find((candidate) => candidate.branch === "issue/stranded-draft")
      if (pr === undefined) throw new Error("intake did not record the change")
      expect(pr.revs.at(-1)?.submittedAt, "the fixture must be a true draft, never submitted").toBeUndefined()

      // One hour on: a real draft-stranded finding exists (past queue audit's
      // own 15-minute existence grace) but well under the 4-hour default page
      // threshold. It must stay OUT of the heartbeat, or every ordinary
      // push-review-submit pause would page.
      const stillQuiet = await runInternals.startHabitantRunnerHeartbeat(
        outputIO({
          cwd: repo,
          runner: `yrd-cli:${process.pid}`,
          now: () => Date.parse("2026-07-09T13:00:00.000Z"),
        }).io,
        {
          intervalMs: 60_000,
          staleDrafts: (now) => runInternals.staleDraftFindings(app, now, fourHourThresholdMs),
          driver: { queueId: `${repo}#main`, lastMerged: () => null },
        },
      )
      try {
        expect(
          (JSON.parse(readFileSync(statusPath, "utf8")) as Readonly<{ staleDrafts: unknown }>).staleDrafts,
          "a real finding exists at +1h, but must stay quiet below the page threshold",
        ).toEqual([])
      } finally {
        await stillQuiet.close(true)
      }

      // 4.5 hours on: past the page threshold. Must reach the heartbeat WITH
      // owner attribution, and must never disagree with queue audit's own
      // reading of the identical PR at the identical clock.
      const paging = await runInternals.startHabitantRunnerHeartbeat(
        outputIO({
          cwd: repo,
          runner: `yrd-cli:${process.pid}`,
          now: () => Date.parse("2026-07-09T16:30:00.000Z"),
        }).io,
        {
          intervalMs: 60_000,
          staleDrafts: (now) => runInternals.staleDraftFindings(app, now, fourHourThresholdMs),
          driver: { queueId: `${repo}#main`, lastMerged: () => null },
        },
      )
      try {
        const written = JSON.parse(readFileSync(statusPath, "utf8")) as Readonly<{ staleDrafts: unknown }>
        expect(written.staleDrafts).toMatchObject([
          {
            code: "draft-stranded",
            pr: pr.id,
            submitter: "@dev/11",
            blockedMs: Date.parse("2026-07-09T16:30:00.000Z") - Date.parse("2026-07-09T12:00:00.000Z"),
          },
        ])
        expect(app.queue.audit({ now: "2026-07-09T16:30:00.000Z" }).findings).toContainEqual(
          expect.objectContaining({ code: "draft-stranded", pr: pr.id }),
        )
        paging.check()
      } finally {
        await paging.close(true)
      }
    } finally {
      await app.close()
      safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
    }
  })

  it("surfaces a branch submitted only in git (no record) in audit, list warnings, and the considered rows", async () => {
    // branch-is-change 2a: the receiver projected a direct refs/yrd/submit push
    // as branch/submitted; nothing can run it (no PRnnn), so every surface a
    // waiting author looks at must say so — and say why.
    const app = await createApp({ clock: () => "2026-07-09T12:00:00.000Z" })
    try {
      await app.bays.recordBranchSubmit({ branch: "issue/ref-only", sha: "4".repeat(40), base: "main" })

      // audit: the finding, with the same age grace a stranded draft gets.
      expect(app.queue.audit({ now: "2026-07-09T12:05:00.000Z" }).findings).toEqual([])
      const audit = outputIO({ now: () => Date.parse("2026-07-09T13:00:00.000Z") })
      expect(await runYrd(app, yrd("queue", "audit"), audit.io), audit.stderr()).toBe(1)
      expect(audit.stdout()).toContain("err=unrecorded-submit")
      expect(audit.stdout()).toContain("issue/ref-only")
      expect(audit.stdout()).toContain("resolve: git push bay issue/ref-only:refs/for/main/<issue>")
      const json = outputIO({ now: () => Date.parse("2026-07-09T13:00:00.000Z") })
      expect(await runYrd(app, yrd("queue", "audit", "--json"), json.io)).toBe(1)
      const findings = (JSON.parse(json.stdout()) as { findings: ReadonlyArray<Record<string, unknown>> }).findings
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: "unrecorded-submit",
          specimen: "branch:issue/ref-only",
          since: "2026-07-09T12:00:00.000Z",
          blockedMs: 3_600_000,
        }),
      )

      // list/watch/health: the same finding rides the stale-draft warning
      // projection those surfaces share — one projection, never a second read.
      const paged = runInternals.staleDraftFindings(app, "2026-07-09T13:00:00.000Z", 30 * 60 * 1000)
      expect(paged.map((finding) => finding.code)).toEqual(["unrecorded-submit"])
      expect(runInternals.staleDraftWarnings(paged)).toEqual([
        expect.stringContaining("[unrecorded-submit] branch 'issue/ref-only' is submitted in git"),
      ])
      // Below the page threshold it is a correct audit finding but not page-worthy yet.
      expect(runInternals.staleDraftFindings(app, "2026-07-09T12:20:00.000Z", 30 * 60 * 1000)).toEqual([])

      // considered rows: an implicit run says the one thing submitted is unrecorded, not that nothing is.
      const direct = await app.dispatch(app.commands.queue.run, {})
      expect(direct.value).toMatchObject({
        kind: "no-runnable-prs",
        considered: [expect.objectContaining({ branch: "issue/ref-only", code: "unrecorded-submit" })],
      })
    } finally {
      await app.close()
    }
  })

  it("offers only reversible submission for a stranded draft, never payload destruction", async () => {
    const app = await createApp({ clock: () => "2026-07-09T12:00:00.000Z" })
    try {
      await app.bays.intake({
        branch: "issue/stranded-draft",
        headSha: "3".repeat(40),
        base: "main",
        baseSha: BASE_SHA,
        submitter: "@dev/11",
      })

      const audit = outputIO({ now: () => Date.parse("2026-07-09T13:00:00.000Z") })
      expect(await runYrd(app, yrd("queue", "audit"), audit.io), audit.stderr()).toBe(1)
      expect(audit.stdout()).toContain("resolve: yrd pr submit issue/stranded-draft --issue <ref>")
      expect(audit.stdout()).not.toContain("withdraw")
      expect(audit.stdout()).not.toContain("--burn-payload")
    } finally {
      await app.close()
    }
  })

  it("surfaces a habitant-observed stale draft as a non-fatal warning in `queue list --check`", async () => {
    const repo = mkdtempSync(join(tmpdir(), "yrd-runner-health-stale-drafts-"))
    execFileSync("git", ["init", "-q", "-b", "main", repo])
    execFileSync("git", ["-C", repo, "config", "user.name", "Yrd Test"])
    execFileSync("git", ["-C", repo, "config", "user.email", "yrd@example.invalid"])
    writeFileSync(join(repo, "README.md"), "base\n")
    execFileSync("git", ["-C", repo, "add", "README.md"])
    execFileSync("git", ["-C", repo, "commit", "-qm", "base"])
    const stateDir = join(repo, ".git", "yrd", "resident-runner")
    mkdirSync(stateDir, { recursive: true })
    const finding = {
      code: "draft-stranded",
      message:
        "change 'PR1' (issue/stranded) was pushed at 2026-07-09T12:00:00.000Z by @dev/7, review: unreviewed, and " +
        "nothing has submitted it; it is invisible to the queue until someone does",
      pr: "PR1",
      specimen: "pr:PR1",
      since: "2026-07-09T12:00:00.000Z",
      blockedMs: 16_200_000,
      submitter: "@dev/7",
      reviewCertification: "unreviewed",
      resolution: ["yrd pr submit issue/stranded --issue <ref>"],
    }
    writeFileSync(
      join(stateDir, "status.json"),
      JSON.stringify({
        pid: process.pid,
        startedAt: "2026-07-09T12:00:00.000Z",
        lastTickAt: "2026-07-09T16:30:00.000Z",
        staleDrafts: [finding],
      }),
    )
    const app = await createApp()
    const services: YrdCliServices = {
      queue: { auditEnvironment: async () => ({ findings: [], comparison: stubAuditComparison() }) },
    }
    try {
      // Deliberately the "absent" health state (no lease, no queued work on
      // THIS app) rather than "healthy" — a stale draft must page regardless
      // of whether anything else about the runner is fine or broken.
      const json = outputIO({ cwd: repo, now: () => Date.parse("2026-07-09T16:30:10.000Z") })
      const jsonExit = await runYrd(app, yrd("queue", "list", "--check", "--json"), json.io, services)
      const body = JSON.parse(json.stdout()) as Readonly<{
        state: unknown
        facts: Readonly<{ runner: Readonly<{ staleDrafts: unknown }> }>
        warnings: unknown
      }>
      expect(jsonExit, JSON.stringify(body)).toBe(1)
      expect(body.state).toBe("absent")
      expect(body.facts.runner.staleDrafts).toEqual([finding])
      expect(body.warnings).toEqual([`[draft-stranded] ${finding.message}`])

      const human = outputIO({ cwd: repo, now: () => Date.parse("2026-07-09T16:30:10.000Z") })
      expect(await runYrd(app, yrd("queue", "list", "--check"), human.io, services), human.stderr()).toBe(1)
      expect(human.stderr()).toContain("[draft-stranded]")
      expect(human.stderr()).toContain("@dev/7")
      expect(human.stderr()).toContain("issue/stranded")
    } finally {
      await app.close()
      safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
    }
  })

  it("pages a stranded draft past the threshold in `queue list`, quiet below it — the same loader `yrd watch` renders", async () => {
    const app = await createApp({ clock: () => "2026-07-09T12:00:00.000Z" })
    try {
      await app.bays.intake({
        branch: "issue/stranded-in-watch",
        headSha: "5".repeat(40),
        base: "main",
        baseSha: BASE_SHA,
        submitter: "@dev/7",
      })

      const quiet = outputIO({ now: () => Date.parse("2026-07-09T13:00:00.000Z") })
      expect(await runYrd(app, yrd("queue", "list", "--json"), quiet.io), quiet.stderr()).toBe(0)
      expect(
        (JSON.parse(quiet.stdout()) as Readonly<{ warnings?: unknown }>).warnings,
        "a real finding at +1h must stay quiet below the 4h default page threshold",
      ).toBeUndefined()

      const paging = outputIO({ now: () => Date.parse("2026-07-09T16:30:00.000Z") })
      expect(await runYrd(app, yrd("queue", "list", "--json"), paging.io), paging.stderr()).toBe(0)
      const pagingBody = JSON.parse(paging.stdout()) as Readonly<{ warnings: readonly string[] }>
      expect(pagingBody.warnings).toHaveLength(1)
      expect(pagingBody.warnings[0]).toContain("[draft-stranded]")
      expect(pagingBody.warnings[0]).toContain("@dev/7")
      expect(pagingBody.warnings[0]).toContain("issue/stranded-in-watch")

      const humanPaging = outputIO({ now: () => Date.parse("2026-07-09T16:30:00.000Z"), columns: 120 })
      expect(await runYrd(app, yrd("queue", "list"), humanPaging.io), humanPaging.stderr()).toBe(0)
      expect(humanPaging.stderr()).toContain("[draft-stranded]")
      expect(humanPaging.stderr()).toContain("@dev/7")

      // The interactive `yrd watch` pane and its --json twin share this exact
      // snapshot builder (buildQueueListSnapshot) — proving the data reaches
      // it here proves it reaches the pane's footer notice too.
      const snapshot = await runInternals.queueListSnapshot(
        app,
        [],
        {},
        outputIO({ now: () => Date.parse("2026-07-09T16:30:00.000Z") }).io,
        { queueReadModel: testQueueReadModel(app) },
      )
      expect(snapshot.staleDrafts).toHaveLength(1)
      expect(snapshot.staleDrafts?.[0]?.submitter).toBe("@dev/7")
    } finally {
      await app.close()
    }
  })

  /**
   * The same consumption gap as the draft-stranded family above, for the
   * OTHER disposition nothing watched (@i/10-merge-queue/22918-needs-person-unowned):
   * `applyRefusalRemedies`' judgment half already settles a refusal
   * `needs-person` (22474), but the ONE finding that used to mark it —
   * `admission-refusal-loop` — is deliberately dropped the instant it
   * settles (the loop is over), and nothing replaced it. These three tests
   * prove the `admission-refusal-needs-person` finding (@yrd/queue
   * `auditQueues`) reaches a live seat exactly like a stale draft does: the
   * habitant heartbeat (this test), `queue list --check` (the fleet health
   * surface), and `queue list` / `queue list --watch` (the same loader
   * `yrd watch` renders). Unlike a draft, there is no page-after grace: a
   * settlement already only happens once the queue gave up on its own
   * retries or mechanical remedy, so it is page-worthy immediately. The
   * finding's `owner` is the repository's `.yrd.yml` `needsPerson.owner`
   * ROLE — never the revision's recorded submitter, and never omitted: an
   * unconfigured repository shows the explicit unowned default.
   */
  it("writes an unrouted needs-person change into the habitant heartbeat", async () => {
    const repo = mkdtempSync(join(tmpdir(), "yrd-runner-needs-person-"))
    execFileSync("git", ["init", "-q", repo])
    const statusPath = join(repo, ".git", "yrd", "resident-runner", "status.json")
    const app = await createApp({ clock: () => "2026-07-09T12:00:00.000Z" })
    try {
      await app.bays.intake({
        branch: "issue/permanent-refusal",
        headSha: "3".repeat(40),
        base: "main",
        baseSha: BASE_SHA,
        submitter: "@dev/11",
        submit: true,
      })
      const pr = Object.values(app.state().bays.prs).find((candidate) => candidate.branch === "issue/permanent-refusal")
      if (pr === undefined) throw new Error("intake did not record the change")
      await app.bays.requestChecks({ pr: pr.id, baseSha: BASE_SHA })
      await app.queue.recordAdmissionRefusal({
        pr: pr.id,
        code: "authored-gitlink",
        kind: "refusal",
        reason: "the change touches generated-only gitlinks; an exact ruling is needed",
      })
      // The runner's judgment classification settles a no-mechanical-remedy
      // refusal needs-person; driven explicitly, since no code auto-parks.
      await app.queue.settleAdmissionRefusal({
        pr: pr.id,
        revision: currentChangeRev(pr).n,
        headSha: currentChangeRev(pr).head,
        disposition: "needs-person",
        reason: "the change touches generated-only gitlinks; an exact ruling is needed",
      })

      const heartbeat = await runInternals.startHabitantRunnerHeartbeat(
        outputIO({
          cwd: repo,
          runner: `yrd-cli:${process.pid}`,
          now: () => Date.parse("2026-07-09T12:05:00.000Z"),
        }).io,
        {
          intervalMs: 60_000,
          needsPerson: (now) => runInternals.needsPersonFindings(app, now),
          driver: { queueId: `${repo}#main`, lastMerged: () => null },
        },
      )
      try {
        const written = JSON.parse(readFileSync(statusPath, "utf8")) as Readonly<{ needsPerson: unknown }>
        // A recorded submitter exists ("@dev/11") and deliberately does NOT
        // become the owner: `owner` is the repository's declared ROLE, and no
        // repository config here means the explicit unowned default, never an
        // individual guessed from push identity.
        expect(written.needsPerson).toMatchObject([
          {
            code: "admission-refusal-needs-person",
            pr: pr.id,
            refusal: "authored-gitlink",
            owner: "unowned — no needsPerson.owner is configured in .yrd.yml",
          },
        ])
        // Must never disagree with queue audit's own reading of the identical
        // PR — the habitant projects the canonical audit, never a second
        // derivation of it.
        expect(app.queue.audit({ now: "2026-07-09T12:05:00.000Z" }).findings).toContainEqual(
          expect.objectContaining({ code: "admission-refusal-needs-person", pr: pr.id }),
        )
        heartbeat.check()
      } finally {
        await heartbeat.close(true)
      }
    } finally {
      await app.close()
      safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
    }
  })

  it("surfaces a habitant-observed needs-person change as a non-fatal warning in `queue list --check`", async () => {
    const repo = mkdtempSync(join(tmpdir(), "yrd-runner-health-needs-person-"))
    execFileSync("git", ["init", "-q", "-b", "main", repo])
    execFileSync("git", ["-C", repo, "config", "user.name", "Yrd Test"])
    execFileSync("git", ["-C", repo, "config", "user.email", "yrd@example.invalid"])
    writeFileSync(join(repo, "README.md"), "base\n")
    execFileSync("git", ["-C", repo, "add", "README.md"])
    execFileSync("git", ["-C", repo, "commit", "-qm", "base"])
    const stateDir = join(repo, ".git", "yrd", "resident-runner")
    mkdirSync(stateDir, { recursive: true })
    // A configured repository's habitant wrote this: `.yrd.yml`
    // `needsPerson.owner: "@ci"` flowed onto the finding (@yrd/queue
    // `auditQueues`), so the health surface must carry the role through
    // verbatim — the probe has no journal and could never re-derive it.
    const finding = {
      code: "admission-refusal-needs-person",
      message:
        "change 'PR1' needs a person: its entry-check failure 'recut-gitlink-conflict' has no " +
        "mechanical remedy — two fixed gitlink commits are non-ancestral. Owner: @ci.",
      pr: "PR1",
      specimen: "pr:PR1:needs-person",
      refusal: "recut-gitlink-conflict",
      since: "2026-07-09T12:00:00.000Z",
      owner: "@ci",
    }
    writeFileSync(
      join(stateDir, "status.json"),
      JSON.stringify({
        pid: process.pid,
        startedAt: "2026-07-09T12:00:00.000Z",
        lastTickAt: "2026-07-09T12:05:00.000Z",
        needsPerson: [finding],
      }),
    )
    const app = await createApp()
    const services: YrdCliServices = {
      queue: { auditEnvironment: async () => ({ findings: [], comparison: stubAuditComparison() }) },
    }
    try {
      // Deliberately the "absent" health state (no lease, no queued work on
      // THIS app) rather than "healthy" — an unrouted needs-person merge
      // request must page regardless of whether anything else about the
      // runner is fine or broken, exactly like a stale draft.
      const json = outputIO({ cwd: repo, now: () => Date.parse("2026-07-09T12:05:10.000Z") })
      const jsonExit = await runYrd(app, yrd("queue", "list", "--check", "--json"), json.io, services)
      const body = JSON.parse(json.stdout()) as Readonly<{
        state: unknown
        facts: Readonly<{ runner: Readonly<{ needsPerson: unknown }> }>
        warnings: unknown
      }>
      expect(jsonExit, JSON.stringify(body)).toBe(1)
      expect(body.state).toBe("absent")
      expect(body.facts.runner.needsPerson).toEqual([finding])
      expect(body.warnings).toEqual([`[admission-refusal-needs-person] ${finding.message}`])

      const human = outputIO({ cwd: repo, now: () => Date.parse("2026-07-09T12:05:10.000Z") })
      expect(await runYrd(app, yrd("queue", "list", "--check"), human.io, services), human.stderr()).toBe(1)
      expect(human.stderr()).toContain("[admission-refusal-needs-person]")
      expect(human.stderr()).toContain("Owner: @ci.")
      expect(human.stderr()).toContain("PR1")
    } finally {
      await app.close()
      safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
    }
  })

  it("surfaces a needs-person change in `queue list` — the same loader `yrd watch` renders", async () => {
    const app = await createApp({ clock: () => "2026-07-09T12:00:00.000Z" })
    try {
      await app.bays.intake({
        branch: "issue/needs-person-in-watch",
        headSha: "5".repeat(40),
        base: "main",
        baseSha: BASE_SHA,
        submitter: "@dev/7",
        submit: true,
      })
      const pr = Object.values(app.state().bays.prs).find(
        (candidate) => candidate.branch === "issue/needs-person-in-watch",
      )
      if (pr === undefined) throw new Error("intake did not record the change")
      await app.bays.requestChecks({ pr: pr.id, baseSha: BASE_SHA })
      await app.queue.recordAdmissionRefusal({
        pr: pr.id,
        code: "authored-gitlink",
        kind: "refusal",
        reason: "the change touches generated-only gitlinks; an exact ruling is needed",
      })
      // The runner's judgment classification settles a no-mechanical-remedy
      // refusal needs-person; driven explicitly, since no code auto-parks.
      await app.queue.settleAdmissionRefusal({
        pr: pr.id,
        revision: currentChangeRev(pr).n,
        headSha: currentChangeRev(pr).head,
        disposition: "needs-person",
        reason: "the change touches generated-only gitlinks; an exact ruling is needed",
      })

      // No grace period, unlike a draft: the very next read already pages.
      const listing = outputIO({ now: () => Date.parse("2026-07-09T12:05:00.000Z") })
      expect(await runYrd(app, yrd("queue", "list", "--json"), listing.io), listing.stderr()).toBe(0)
      const body = JSON.parse(listing.stdout()) as Readonly<{ warnings: readonly string[] }>
      expect(body.warnings).toHaveLength(1)
      expect(body.warnings[0]).toContain("[admission-refusal-needs-person]")
      expect(body.warnings[0]).toContain(pr.id)
      // Unconfigured repository: the empty owner slot is SHOWN, never omitted
      // and never guessed from the recorded submitter ("@dev/7").
      expect(body.warnings[0]).toContain("Owner: unowned — no needsPerson.owner is configured in .yrd.yml.")

      const humanListing = outputIO({ now: () => Date.parse("2026-07-09T12:05:00.000Z"), columns: 120 })
      expect(await runYrd(app, yrd("queue", "list"), humanListing.io), humanListing.stderr()).toBe(0)
      expect(humanListing.stderr()).toContain("[admission-refusal-needs-person]")

      // The interactive `yrd watch` pane and its --json twin share this exact
      // snapshot builder (buildQueueListSnapshot) — proving the data reaches
      // it here proves it reaches the pane's footer notice too.
      const snapshot = await runInternals.queueListSnapshot(
        app,
        [],
        {},
        outputIO({ now: () => Date.parse("2026-07-09T12:05:00.000Z") }).io,
        { queueReadModel: testQueueReadModel(app) },
      )
      expect(snapshot.needsPerson).toHaveLength(1)
      expect(snapshot.needsPerson?.[0]?.owner).toBe("unowned — no needsPerson.owner is configured in .yrd.yml")
    } finally {
      await app.close()
    }
  })

  it("writes atomic habitant runner heartbeats and leaves a reclaimable exit marker on close", async () => {
    const repo = mkdtempSync(join(tmpdir(), "yrd-runner-heartbeat-"))
    execFileSync("git", ["init", "-q", repo])
    const statusPath = join(repo, ".git", "yrd", "resident-runner", "status.json")
    const implementationSource = "git:35562d1579f140669a453b310340582b8cc1b42f"
    const merged = {
      commit: "a".repeat(40),
      at: "2026-07-13T11:59:00.000Z",
    }
    let now = Date.parse("2026-07-13T12:00:00.000Z")
    try {
      const heartbeat = await runInternals.startHabitantRunnerHeartbeat(
        Object.assign(outputIO({ cwd: repo, runner: `yrd-cli:${process.pid}`, now: () => now }).io, {
          implementationSource,
        }),
        {
          intervalMs: 5,
          queueProgress: (observedAt) => ({ state: "healthy", observedAt }),
          retention: "disabled",
          driver: { queueId: `${repo}#main`, lastMerged: () => merged },
        },
      )
      try {
        expect(JSON.parse(readFileSync(statusPath, "utf8"))).toEqual({
          pid: process.pid,
          startedAt: "2026-07-13T12:00:00.000Z",
          lastTickAt: "2026-07-13T12:00:00.000Z",
          journalVersions: [1, 2, 3],
          // The dedicated RUNNER box renders stale-runner details as `[pid] <command>`.
          command: expect.any(String),
          implementationSource,
          queueProgress: { state: "healthy", observedAt: "2026-07-13T12:00:00.000Z" },
          retention: {
            policy: "disabled",
            source: "mutable-journal",
            observedAt: "2026-07-13T12:00:00.000Z",
            generation: expect.stringMatching(/^[0-9a-f-]{36}$/u),
          },
          driver: {
            queueId: `${repo}#main`,
            epoch: expect.stringMatching(/^[0-9a-f-]{36}$/u),
            lastMerged: merged,
          },
        })
        const epoch = (JSON.parse(readFileSync(statusPath, "utf8")) as { driver: { epoch: string } }).driver.epoch
        now += 1_000
        await vi.waitFor(
          () =>
            expect(JSON.parse(readFileSync(statusPath, "utf8"))).toMatchObject({
              pid: process.pid,
              lastTickAt: "2026-07-13T12:00:01.000Z",
              driver: { queueId: `${repo}#main`, epoch, lastMerged: merged },
            }),
          { timeout: 5_000, interval: 5 },
        )
        heartbeat.check()
      } finally {
        now += 1_000
        await heartbeat.close(true)
      }
      // The status file is NEVER deleted on close: it carries an exit marker so a
      // successor's pid-scoped reclaim keeps working after a clean exit (kills the
      // null-status path that stranded ghosts). queue.recover is idempotent, so
      // reclaiming after a clean exit is a no-op.
      expect(existsSync(statusPath)).toBe(true)
      const marker = JSON.parse(readFileSync(statusPath, "utf8"))
      expect(marker).toMatchObject({ pid: process.pid, exitedAt: "2026-07-13T12:00:02.000Z", clean: true })
      // The successor reads the marker (not null) and, seeing a different dead pid,
      // reclaims — exactly what a deleted status file used to silently skip.
      const prior = await runInternals.habitantRunnerStatus(repo)
      expect(prior).toMatchObject({ pid: process.pid, exitedAt: "2026-07-13T12:00:02.000Z", clean: true })
      expect(runInternals.planHabitantRunnerReclaim(prior, process.pid + 1, () => false)).toEqual({
        reclaim: true,
        runner: `yrd-cli:${process.pid}`,
      })
    } finally {
      safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
    }
  })

  it("refuses a habitant heartbeat when startup could not identify the loaded implementation", async () => {
    const repo = mkdtempSync(join(tmpdir(), "yrd-runner-heartbeat-unknown-"))
    execFileSync("git", ["init", "-q", repo])
    try {
      const attempt = await runInternals
        .startHabitantRunnerHeartbeat(
          outputIO({ cwd: repo, runner: `yrd-cli:${process.pid}`, implementationSource: undefined }).io,
          {
            intervalMs: 5,
          },
        )
        .then(
          (heartbeat) => ({ heartbeat }),
          (error: unknown) => ({ error }),
        )
      if ("heartbeat" in attempt) await attempt.heartbeat.close(false)
      expect(attempt).toMatchObject({
        error: {
          failure: {
            kind: "refusal",
            code: "runtime-source-unavailable",
          },
        },
      })
    } finally {
      safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
    }
  })

  it("projects release, legacy, and unknown failure codes as truthful outcomes", async () => {
    const now = Date.parse("2026-07-13T12:00:00.000Z")
    const cases = [
      {
        run: "R101",
        pr: "PR101",
        code: "queue-environment-refused",
        status: "environment-refused",
        display: "environment-refused",
      },
      { run: "R102", pr: "PR102", code: "stale-pr", status: "stale", display: "stale" },
      { run: "R103", pr: "PR103", code: "stale-check", status: "stale", display: "stale" },
      { run: "R104", pr: "PR104", code: "job-lost", status: "lost", display: "lost" },
      { run: "R105", pr: "PR105", code: "stale-base", status: "stale", display: "stale" },
      { run: "R106", pr: "PR106", code: "legacy-quiesced", status: "legacy", display: "legacy" },
      { run: "R107", pr: "PR107", code: "legacy-root-leased", status: "refused", display: "refused" },
      { run: "R108", pr: "PR108", code: "check-failed", status: "rejected", display: "rejected" },
      {
        run: "R109",
        pr: "PR109",
        code: "novel-failure-code",
        status: "rejected",
        display: "novel-failure-code",
      },
    ].map((entry, index) => ({ ...entry, headSha: String(index + 1).repeat(40) }))
    const submittedAt = "2026-07-13T11:00:00.000Z"
    // Released runs leave their PR submitted for the next queue pass; a true
    // decision rejection owns the change's terminal revision clock.
    const prs: Change[] = cases.map((entry) => {
      const rejected = ["check-failed", "novel-failure-code"].includes(entry.code)
      return {
        id: entry.pr,
        branch: `topic/${entry.pr}`,
        base: "main",
        state: "open",
        merged: false,
        submittedAt,
        ...(rejected ? { rejectedAt: "2026-07-13T11:45:00.000Z" } : {}),
        revs: [
          submittedRevision(
            1,
            entry.headSha,
            submittedAt,
            rejected ? { kind: "rejected", at: "2026-07-13T11:45:00.000Z", run: entry.run } : undefined,
          ),
        ],
        reviews: [],
        comments: [],
        checkRequests: [],
      }
    })
    const finished = cases.map((entry) =>
      fakeRun({
        id: entry.run,
        status: "failed",
        pr: { id: entry.pr, revision: 1, headSha: entry.headSha, baseSha: BASE_SHA },
        startedAt: "2026-07-13T11:15:00.000Z",
        finishedAt: "2026-07-13T11:45:00.000Z",
        steps: [],
        error: { code: entry.code, message: `${entry.code} specimen` },
      }),
    )
    const result: QueueStatusResult = {
      base: "main",
      prs,
      admissionOrder: fixtureAdmissionOrder(prs),
      running: [],
      waiting: [],
      finished,
    }
    const projection = queueTimelineProjection([result], {
      now,
      windowMs: 60 * 60_000,
      statuses: ["pending", "running", "rejected", "integrated", "other"],
      terms: [],
      latest: false,
      rowLimit: 20,
      submissionTimes: new Map(prs.map((pr) => [queueRevisionKey(currentChangeSnapshot(pr)), pr.submittedAt ?? null])),
    })

    expect(
      Object.fromEntries(
        projection.rows
          .filter((row) => row.group === "completed")
          .map((row) => [row.run, { status: row.status, glyph: row.glyph }]),
      ),
    ).toEqual(Object.fromEntries(cases.map((entry) => [entry.run, { status: entry.status, glyph: "×" }])))
    expect(projection.metrics.outcomes).toEqual({
      integrated: 0,
      alreadyMerged: 0,
      passed: 0,
      rejected: 2,
      environmentRefused: 1,
      stale: 3,
      lost: 1,
      legacy: 1,
      refused: 1,
      canceled: 0,
    })
    expect(
      Object.fromEntries(queueLogRows([result], new Set(), undefined).map((row) => [row.run, row.outcome])),
    ).toEqual(Object.fromEntries(cases.map((entry) => [entry.run, entry.display])))
    expect(Object.fromEntries(finished.map((run) => [run.id, queueShowData(run).outcome]))).toEqual(
      Object.fromEntries(cases.map((entry) => [entry.run, entry.display])),
    )
    const rejectedOnly = queueTimelineProjection([result], {
      now,
      windowMs: 60 * 60_000,
      statuses: ["rejected"],
      terms: [],
      latest: false,
      rowLimit: 20,
      submissionTimes: new Map(prs.map((pr) => [queueRevisionKey(currentChangeSnapshot(pr)), pr.submittedAt ?? null])),
    })
    expect(rejectedOnly.rows.filter((row) => row.group === "completed").map((row) => row.run)).toEqual(["R108", "R109"])
    const rendered = await renderString(
      createElement(QueueTimelineView, {
        projection: { ...projection, display: { limit: 20, shown: projection.rows.length, hidden: 0 } },
        columns: 200,
      }),
      { width: 200, height: 60, plain: true },
    )
    const unknownRow = rendered
      .split("\n")
      .find((row) => row.includes("pr#109.1") && row.includes("err=novel-failure-code"))
    expect(unknownRow).toContain("× fail")
    expect(unknownRow).toContain("err=novel-failure-code")
  })

  it("builds one filtered one-revision timeline and deduplicated STATS projection", async () => {
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
    const integrated: Run = {
      ...fakeRun({
        id: "R1",
        status: "passed",
        startedAt: "2026-07-13T10:00:00.000Z",
        finishedAt: "2026-07-13T10:10:00.000Z",
        steps: [
          fakeStep(
            "merge",
            "passed",
            fakeJob({
              id: "J-R1-merge",
              status: "passed",
              startedAt: "2026-07-13T10:00:00.000Z",
              finishedAt: "2026-07-13T10:01:00.000Z",
            }),
          ),
        ],
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
    ].map((pr, index) =>
      timelineFixturePr(
        pr.id,
        pr.status as Exclude<ChangeDeliveryState, "needs-author" | "already-landed" | "ready">,
        pr.submittedAt,
        pr.name,
        {
          headSha: String(index + 1).repeat(40),
          ...(pr.status === "integrated" ? { integratedAt: "2026-07-13T10:10:00.000Z" } : {}),
          ...(pr.status === "rejected" ? { rejectedAt: "2026-07-13T11:20:00.000Z" } : {}),
        },
      ),
    )
    const result: QueueStatusResult = {
      base: "main",
      prs,
      admissionOrder: fixtureAdmissionOrder(prs),
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
    const submissionTimes = new Map(prs.map((pr) => [queueRevisionKey(currentChangeSnapshot(pr)), pr.submittedAt!]))

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
    // and a per-24h throughput projected from the merged count over the window.
    expect(projection.metrics.oldestOpenMs).toBe(80 * minute)
    expect(projection.metrics.throughput).toEqual({ merged: 1, per24h: 4 })
    expect(projection.rows.map((row) => [row.group, row.status, row.run ?? row.pr, row.pr])).toEqual([
      ["pending", "ready", "PR4", "PR4"],
      ["pending", "ready", "PR6", "PR6"],
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
        activeMs: minute,
        waitMs: 9 * minute,
        queueWaitMs: 5 * minute,
      },
      {
        pr: "PR2",
        ageMs: 25 * minute,
        totalMs: 10 * minute,
        activeMs: minute,
        waitMs: 9 * minute,
        queueWaitMs: 15 * minute,
      },
    ])
    expect(
      (JSON.parse(JSON.stringify(projection.rows)) as typeof projection.rows).filter((row) => row.run === "R1"),
    ).toMatchObject([
      { pr: "PR1", ageMs: 15 * minute, totalMs: 10 * minute, activeMs: minute, waitMs: 9 * minute },
      { pr: "PR2", ageMs: 25 * minute, totalMs: 10 * minute, activeMs: minute, waitMs: 9 * minute },
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
    expect(projection.timeStatsFacts.find((fact) => fact.run === "R1")).toMatchObject({
      outcome: "integrated",
      failureClass: null,
      queueWaitMs: [5 * minute, 15 * minute],
      members: [
        {
          pr: "PR1",
          totalMs: 15 * minute,
          totalApproximate: false,
          codingMs: null,
          jobRunMs: minute,
          retries: 0,
        },
        {
          pr: "PR2",
          totalMs: 25 * minute,
          totalApproximate: false,
          codingMs: null,
          jobRunMs: minute,
          retries: 0,
        },
      ],
    })
    expect(projection.timeStatsFacts.find((fact) => fact.run === "R3")).toMatchObject({
      failureClass: "env",
    })
    const filteredOptions = {
      now,
      windowMs: 60 * minute,
      metricsWindowMs: 2 * 60 * minute,
      statuses: ["rejected"] as const,
      terms: [] as string[],
      latest: false,
      rowLimit: 4,
      submissionTimes,
      retainedSinceMs: Date.parse("2026-07-13T07:00:00.000Z"),
      siblingBases: ["release"],
    }
    const clock = createQueueTimelineProjectionClock([result], filteredOptions)
    const filtered = clock.projection
    const later = now + 31 * minute
    const reclocked = clock.reclock(later)
    const rebuilt = queueTimelineProjection([result], { ...filteredOptions, now: later })
    expect(reclocked, "the clock-only path must be a differential oracle for a full rebuild").toEqual(rebuilt)
    expect(reclocked.timeStatsFacts).toBe(filtered.timeStatsFacts)

    const constrainedProjection = {
      ...projection,
      now: "2026-07-14T12:00:00.000Z",
      metrics: {
        ...projection.metrics,
        terminalAttempts: 44,
        outcomes: {
          integrated: 39,
          alreadyMerged: 0,
          passed: 0,
          rejected: 5,
          environmentRefused: 0,
          stale: 0,
          lost: 0,
          legacy: 0,
          refused: 0,
          canceled: 0,
        },
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
    // RUN cell is identity only (amendment 2026-08-25): the run id renders
    // without repeating the STATUS cell's glyph.
    expect(rendered).toContain("#4 ")
    expect(rendered).not.toContain("#4 ◉")
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
          // Height fits the STATS panel. The standalone
          // QueueTimelineView has no fillHeight list-scroll, so a box tuned to the
          // old short statistics surface would clip the header at a narrow tier.
          // Production (QueueWatchFrame) keeps the header via
          // the scrolling list at any height.
          { width, height: 44, plain: true },
        ),
      )
      const rows = fixed.split("\n")
      const filter = rows.find((row) => /open.*running.*done.*failed/u.test(row))
      // The pills share the row with the left-aligned coverage text ("retained
      // since …" / "... N more"), so assert the pill cluster is present rather
      // than owning the whole row (W1, 2026-07-16). Item 3: no "FILTER" label,
      // no [p] brackets — the since= dimension survives, pills are plain
      // words. `all` moved to the top line's pill group (item 32).
      expect.soft(filter).toContain("since=6:00:00 open running done failed")
      // The STATS frame reads the same retained terminal facts at every tier.
      // The merged per-24h throughput fact stays in projection.metrics for JSON.
      expect.soft(rows.some((row) => row.includes("╭─ STATS "))).toBe(true)
      expect.soft(fixed).toContain("RUNS")
      expect(Math.max(...rows.map((row) => Array.from(row).length))).toBeLessThanOrEqual(width)
      const header = rows.find((row) => row.includes("TIME") && row.includes("CHANGES"))
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
      expect(integratedLine).toContain("✓ merged")
      expect(integratedLine?.trimEnd()).toMatch(/15:00 10:00$/u)
    }
    // Height fits the calendar STATS panel so the list rows are not clipped
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
        ["◉", "pr#5.1"],
        ["−", "pr#7.1"],
        ["×", "pr#3.1"],
        // PR2 is the adjacent member of PR1's Run and carries the SAME marker,
        // so anchoring on pr#1.1 asserts the run's glyph once (22925 gave
        // co-merged members their own marker rather than suppressing it).
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

    const newerChangeOne = fakeRun({
      id: "R5",
      status: "failed",
      pr: { id: "PR1", revision: 2, headSha: "9".repeat(40), baseSha: BASE_SHA },
      startedAt: "2026-07-13T11:50:00.000Z",
      finishedAt: "2026-07-13T11:55:00.000Z",
      steps: [],
      error: { code: "check-failed", message: "newer PR1 attempt failed" },
    })
    const revisedChangeOne = timelineFixturePr("PR1", "rejected", "2026-07-13T11:49:00.000Z", "one", {
      revision: 2,
      headSha: "9".repeat(40),
      revisions: [
        submittedRevision(1, "1".repeat(40), "2026-07-13T09:55:00.000Z", {
          kind: "integrated",
          at: "2026-07-13T10:10:00.000Z",
        }),
        submittedRevision(2, "9".repeat(40), "2026-07-13T11:49:00.000Z", {
          kind: "rejected",
          at: "2026-07-13T11:55:00.000Z",
        }),
      ],
      rejectedAt: "2026-07-13T11:55:00.000Z",
    })
    const latestPrs = result.prs.map((pr) => (pr.id === revisedChangeOne.id ? revisedChangeOne : pr))
    const latestSubmissionTimes = new Map([
      ...submissionTimes,
      [queueRevisionKey(currentChangeSnapshot(revisedChangeOne)), "2026-07-13T11:49:00.000Z"] as const,
    ])
    const latest = queueTimelineProjection(
      [{ ...result, prs: latestPrs, finished: [...result.finished, newerChangeOne] }],
      {
        now,
        windowMs: 6 * 60 * minute,
        statuses: ["pending", "running", "rejected", "integrated", "other"],
        terms: [],
        latest: true,
        rowLimit: 20,
        submissionTimes: latestSubmissionTimes,
      },
    )
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
    expect(props.intervalMs).toBe(15_000)
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
      expect(frame).toContain("YRD QUEUES")
      expect(frame.split("\n").find((row) => row.includes("pr#1.1") && row.includes(" ready "))).toContain("ready")
      expect(frame).toContain("Queued at position 1")
      // Item 31: the live POSITION fact left the metadata — the status box
      // (headline + explanation) is its single home.
      expect(frame).not.toMatch(/POSITION\s+1/u)
      expect(frame).toContain("AGE")
      expect(frame).toContain("QUEUING")
      // The remedy tail truncates in this split-pane width; the fact does not.
      expect(frame).toContain("NO RUNNER - no runner has ever drained this queue")
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
        timelineFixturePr("PR1", "submitted", "2026-07-09T12:00:00.000Z", "First", { headSha: HEAD_SHA }),
        timelineFixturePr("PR2", "submitted", "2026-07-09T12:01:00.000Z", "Second", {
          headSha: "2".repeat(40),
        }),
      ],
      admissionOrder: ["PR1", "PR2"],
      running: [],
      waiting: [],
      finished: [],
    } as unknown as QueueStatusResult
    const now = Date.parse("2026-07-09T12:02:00.000Z")
    // The change-scoped detail reads projected rows (user directive 2026-07-21), so
    // the watch snapshot carries the projection production always computes; the
    // PR facts (reviews/comments/checkRequests) are present too. At the right
    // tier the detail is docked open from mount, so it follows the cursor with
    // no Enter.
    const projection = queueTimelineProjection([result], {
      now,
      windowMs: 6 * 60 * 60_000,
      statuses: ["pending", "running", "rejected", "integrated", "other"],
      terms: [],
      latest: false,
      rowLimit: 20,
      submissionTimes: queueTimelineAdmissionTimes([result]),
    })
    const handle = await run(
      createElement(QueueWatchFrame, { snapshot: { results: [result], state: NO_BAYS, now, projection } }),
      { writable: { write: () => {} }, cols: 200, rows: 50 },
    )

    try {
      // Default cursor is the first row (PR1); the detail follows it with no
      // Enter. The pane has no identity title (item 23) — the member box's
      // `pr#N.1 ⎇` header and the code group's short-sha HEAD row (item 31)
      // prove which change the detail shows.
      expect(handle.text).toContain("pr#1.1 ⎇")
      expect(handle.text).toContain(`${HEAD_SHA.slice(0, 8)} (r`)
      expect(handle.text).not.toMatch(/\bPRS\b/giu)

      await handle.press("j")
      await handle.waitForLayoutStable()
      // The cursor moved to PR2 and the detail followed — still no Enter.
      expect(handle.text).toContain("pr#2.1 ⎇")
      expect(handle.text).toContain(`${"2".repeat(8)} (r`)
      expect(handle.text).not.toContain(`${HEAD_SHA.slice(0, 8)} (r`)

      await handle.press("Enter")
      await handle.waitForLayoutStable()
      expect(handle.text).toContain(`${"2".repeat(8)} (r`)
      expect(handle.text).not.toContain(`${HEAD_SHA.slice(0, 8)} (r`)
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
          state: "open",
          merged: false,
          revs: [submittedRevision(1, HEAD_SHA, "2026-07-09T12:00:00.000Z")],
          reviews: [],
          comments: [],
          checkRequests: [],
          submittedAt: "2026-07-09T12:00:00.000Z",
        },
        {
          id: "PR2",
          name: "Second",
          branch: "topic/two",
          base: "main",
          state: "open",
          merged: false,
          revs: [submittedRevision(2, "2".repeat(40), "2026-07-09T12:01:00.000Z")],
          reviews: [],
          comments: [],
          checkRequests: [],
          submittedAt: "2026-07-09T12:01:00.000Z",
        },
      ],
      admissionOrder: ["PR1", "PR2"],
      running: [],
      waiting: [],
      finished: [],
    } satisfies QueueStatusResult
    const initial = { results: [result], state: NO_BAYS, now: Date.parse("2026-07-09T12:02:00.000Z") }
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
      expect(handle.text).toContain("> 1m ready pr#2.2")
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

    expect(queueDetailTier(200, 50)).toBe("below")
    expect(queueDetailTier(100, 40)).toBe("below")
    expect(queueDetailTier(80, 24)).toBe("full")

    // THE BOUNDARY, PINNED BY VALUE. Side-by-side needs the list at its full
    // natural width, so SplitPane's rowFits gate is
    //   LIST_NATURAL_WIDTH + DIVIDER_SIZE + DETAIL_NATURAL_WIDTH = 140 + 1 + 72
    // Both sides are asserted because only the pair fixes the number: the
    // previous version of this test asserted 200 -> "right" and nothing else,
    // which held for every threshold at or below 200 and so pinned no boundary
    // at all. That is why the gate sat at 153 for months without anyone
    // noticing it was far below the width the list actually needs.
    expect(queueDetailTier(212, 50)).toBe("below")
    expect(queueDetailTier(213, 50)).toBe("right")

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
      // Item 31: the code group's HEAD row reads `<short-sha> (rN)`.
      const headRow = `${HEAD_SHA.slice(0, 8)} (r`
      expect(wide.text).toContain("│")
      // Right-docked: the detail pane opens on its status box (item 23); the
      // member box beneath carries the selected change's identity header
      // (item 25 — a pre-run selection has no run, so no change list).
      expect(wide.text).toMatch(/pr#\d+\.\d+ ⎇/u)
      expect(wide.text).toContain(headRow)
      await wide.press("Escape")
      await wide.waitForLayoutStable()
      expect(wide.text).not.toContain(headRow)
      await wide.press("Enter")
      await wide.waitForLayoutStable()
      expect(wide.text).toContain(headRow)

      expect(below.text).toContain("─")
      // Below-docked: no identity rides row 1 (the runner border row).
      expect(below.text.split("\n")[1]).not.toMatch(/PR\d+\.\d+/u)
      // 40-row production geometry must keep the calendar box; the member
      // identity header witnesses an open detail even when HEAD clips.
      expect(below.text).toContain("╭─ STATS ")
      expect(below.text).toMatch(/pr#\d+\.\d+ ⎇/u)

      // Compact full tier: the list owns the frame (TIME header), detail
      // replaces it wholesale on Enter and returns on Escape.
      expect(compact.text).toContain("TIME")
      expect(compact.text).not.toContain(headRow)
      await compact.press("Enter")
      await compact.waitForLayoutStable()
      expect(compact.text).toContain(headRow)
      expect(compact.text).not.toContain("TIME ")
      await compact.press("Escape")
      await compact.waitForLayoutStable()
      expect(compact.text).toContain("TIME")
      expect(compact.text).not.toContain(headRow)
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
    const result = { ...fakeSummary([run]), prs: [], admissionOrder: [] } as QueueStatusResult
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
      safeRemoveSync(artifactRoot, { within: tmpdir(), allowMissing: true })
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
    const result = { ...fakeSummary([run]), prs: [], admissionOrder: [] } as QueueStatusResult
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
      safeRemoveSync(artifactRoot, { within: tmpdir(), allowMissing: true })
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
      expect(
        await runInternals.queueArtifactOutputs([{ ...fakeSummary([run]), prs: [], admissionOrder: [] }], artifactRoot),
      ).toEqual([
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
      safeRemoveSync(artifactRoot, { within: tmpdir(), allowMissing: true })
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
    expect(
      status
        .stdout()
        .split("\n")
        .find((row) => row.includes("pr#1.1")),
    ).toContain("ready")
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

    expect(
      plain
        .stdout()
        .split("\n")
        .find((row) => row.includes("pr#1.1")),
    ).toContain("ready")
    expect(
      plain
        .stdout()
        .split("\n")
        .find((row) => row.includes("pr#2.1")),
    ).toContain("ready")
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

  it("makes the queue view the exact unfiltered 24h timeline, including the newest integration", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    const integrated = outputIO()
    expect(
      await runYrd(app, yrd("queue", "run", "PR1", "--steps", "check,merge", "--json"), integrated.io),
      integrated.stderr(),
    ).toBe(0)

    const now = () => Date.parse("2026-07-09T13:00:00.000Z")
    const resolveQueueTarget = async () => ({ base: "main", sha: MERGED_SHA })
    const list = outputIO({ now, resolveQueueTarget })
    const status = outputIO({ now, resolveQueueTarget })
    expect(await runYrd(app, yrd("queue", "list", "--since", "24h", "--json"), list.io), list.stderr()).toBe(0)
    expect(await runYrd(app, yrd("queue", "status", "--since", "24h", "--json"), status.io), status.stderr()).toBe(0)

    const expected = JSON.parse(list.stdout()) as {
      projection: {
        filters: { terms: readonly string[]; windowMs: number }
        rows: readonly Readonly<{ run?: string; pr: string; status: string }>[]
      }
    }
    const actual = JSON.parse(status.stdout()) as typeof expected
    expect(actual).toEqual(expected)
    expect(actual.projection.filters).toMatchObject({ terms: [], windowMs: 24 * 60 * 60_000 })
    expect(actual.projection.rows.find((row) => row.status === "integrated")).toMatchObject({
      run: "R1",
      pr: "PR1",
      status: "integrated",
    })
  })

  it("renders pause and drain health in watch output", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    await app.queue.pause({
      base: "main",
      reason: "operator freeze",
      allowedPRs: [],
      expiresAt: "2026-07-13T12:00:00.000Z",
    })

    let mounted: ReactElement | undefined
    const watch = outputIO({
      now: () => Date.parse("2026-07-09T12:01:00.000Z"),
    })
    const io = withLiveRenderer(watch.io, async (element) => {
      mounted = element
    })
    expect(await runYrd(app, yrd("watch"), io)).toBe(0)
    const props = mounted?.props as QueueWatchPaneProps
    const frame = stripOsc8Targets(
      await renderString(createElement(QueueWatchView, { ...props.initial, state: requiredWatchBays(props.initial) })),
    )
    expect(frame).toContain("PAUSE")
    expect(frame).toContain("operator freeze")
    expect(frame).toContain("DRAIN")
  })

  it("projects watch controls, oldest-open drain age, and the active spotlight", () => {
    const result = {
      base: "main",
      prs: [
        timelineFixturePr("PR1", "submitted", "2026-07-09T12:00:00.000Z", "Watch the queue", {
          headSha: HEAD_SHA,
        }),
      ],
      admissionOrder: ["PR1"],
      running: [
        fakeRun({
          id: "R1",
          status: "running",
          pr: { id: "PR1", revision: 1, headSha: HEAD_SHA },
          subject: "Watch the queue",
          startedAt: "2026-07-09T12:09:00.000Z",
          steps: [fakeStep("review", "running", fakeJob({ id: "watch-review", status: "running" }))],
        }),
      ],
      waiting: [],
      finished: [],
    } as unknown as QueueStatusResult
    const now = Date.parse("2026-07-09T12:10:00.000Z")

    expect(watchQueueRows(NO_BAYS, result, now)[0]).toMatchObject({ age: "10m", touched: "1m" })
    expect(activeWatchRow(result, now)).toMatchObject({
      run: "R1",
      pr: "PR1",
      subject: "Watch the queue",
      step: "review",
      elapsed: "1m",
    })
  })

  it("labels skipped checks consistently in queue and watch summaries", async () => {
    const run: Run = {
      ...fakeRun({
        id: "R1",
        status: "running",
        pr: { id: "PR1", revision: 1, headSha: HEAD_SHA },
        startedAt: "2026-07-09T12:09:00.000Z",
        steps: [fakeStep("merge", "running", fakeJob({ id: "merge-only", status: "running" }))],
      }),
      stepSelection: {
        authority: "explicit",
        steps: ["merge"],
        omittedSteps: [
          {
            name: "check",
            title: "check test step",
            revision: "step-v1",
            kind: "check",
            index: 0,
            status: "skipped",
            reason: "not-selected",
          },
        ],
      },
    }
    const result = {
      base: "main",
      prs: [
        timelineFixturePr("PR1", "submitted", "2026-07-09T12:00:00.000Z", "Merge without checks", {
          headSha: HEAD_SHA,
        }),
      ],
      admissionOrder: ["PR1"],
      running: [run],
      waiting: [],
      finished: [],
    } as unknown as QueueStatusResult
    const queueFrame = await renderString(createElement(QueueRunsView, { runs: [run] }), {
      width: 120,
      plain: true,
    })
    const watchFrame = await renderString(
      createElement(QueueWatchView, { state: NO_BAYS, results: [result], now: Date.parse("2026-07-09T12:10:00.000Z") }),
      { width: 120, plain: true },
    )

    expect(queueFrame).toContain("check=skipped merge=running")
    expect(watchFrame).toContain("check=skipped merge=running")
    expect(watchFrame).not.toContain("not-selected")
  })

  it("orders queue timeline rows status-major and collapses to the latest row per change", () => {
    const result = {
      base: "main",
      headSha: BASE_SHA,
      prs: [
        timelineFixturePr("PR1", "submitted", "2026-07-09T12:00:00.000Z", "First", { headSha: HEAD_SHA }),
        timelineFixturePr("PR2", "submitted", "2026-07-09T12:01:00.000Z", "Second", {
          headSha: "2".repeat(40),
        }),
        timelineFixturePr("PR3", "submitted", "2026-07-09T12:19:00.000Z", "Third", {
          headSha: "3".repeat(40),
        }),
        timelineFixturePr("PR4", "submitted", "2026-07-09T12:04:00.000Z", "Fourth", {
          headSha: "4".repeat(40),
        }),
        timelineFixturePr("PR5", "integrated", "2026-07-09T12:05:00.000Z", "Fifth", {
          headSha: "5".repeat(40),
          integratedAt: "2026-07-09T12:15:00.000Z",
          integration: { commit: MERGED_SHA, baseSha: BASE_SHA },
        }),
      ],
      admissionOrder: ["PR1", "PR2", "PR3", "PR4"],
      running: [
        fakeRun({
          id: "R1",
          status: "running",
          pr: { id: "PR1", revision: 1, headSha: HEAD_SHA },
          startedAt: "2026-07-09T12:00:00.000Z",
          steps: [],
        }),
        fakeRun({
          id: "R3",
          status: "running",
          pr: { id: "PR4", revision: 1, headSha: "4".repeat(40) },
          startedAt: "2026-07-09T12:05:00.000Z",
          steps: [],
        }),
      ],
      waiting: [],
      finished: [
        fakeRun({
          id: "R2",
          status: "passed",
          pr: { id: "PR1", revision: 1, headSha: HEAD_SHA },
          startedAt: "2026-07-09T12:10:00.000Z",
          finishedAt: "2026-07-09T12:11:00.000Z",
          steps: [],
        }),
        fakeRun({
          id: "R4",
          status: "passed",
          pr: { id: "PR5", revision: 1, headSha: "5".repeat(40) },
          startedAt: "2026-07-09T12:14:00.000Z",
          finishedAt: "2026-07-09T12:15:00.000Z",
          steps: [],
          integration: { commit: MERGED_SHA, baseSha: BASE_SHA },
        }),
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
        timelineFixturePr("PR1", "submitted", "2026-07-09T12:15:00.000Z", "Revised", {
          revision: 2,
          headSha: "2".repeat(40),
          revisions: [
            submittedRevision(1, HEAD_SHA, "2026-07-09T12:00:00.000Z", {
              kind: "rejected",
              at: "2026-07-09T12:11:00.000Z",
            }),
            submittedRevision(2, "2".repeat(40), "2026-07-09T12:15:00.000Z"),
          ],
        }),
      ],
      admissionOrder: ["PR1"],
      running: [],
      waiting: [],
      finished: [
        fakeRun({
          id: "R1",
          status: "failed",
          pr: { id: "PR1", revision: 1, headSha: HEAD_SHA },
          startedAt: "2026-07-09T12:10:00.000Z",
          finishedAt: "2026-07-09T12:11:00.000Z",
          steps: [],
        }),
      ],
    } as unknown as QueueStatusResult

    expect(queueTimelineRows([result], Date.parse("2026-07-09T12:20:00.000Z"), true)).toMatchObject([
      { pr: "PR1", status: "ready", clock: "5m", detail: "position 1" },
    ])
  })

  it("falls back to job status when a watch queue job carries no evidence detail", () => {
    const result = {
      base: "main",
      prs: [
        timelineFixturePr("PR1", "submitted", "2026-07-09T12:00:00.000Z", "Watch the queue", {
          headSha: HEAD_SHA,
        }),
      ],
      admissionOrder: ["PR1"],
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

    expect(watchQueueRows(NO_BAYS, result, Date.parse("2026-07-09T12:10:00.000Z"))[0]).toMatchObject({
      step: "check",
      result: "waiting",
    })
  })

  it("names the failing job reason for each recent watch failure", async () => {
    const result = {
      base: "main",
      prs: [
        timelineFixturePr("PR1", "rejected", "2026-07-09T12:00:00.000Z", "Watch the queue", {
          headSha: HEAD_SHA,
          rejectedAt: "2026-07-09T12:03:00.000Z",
        }),
      ],
      admissionOrder: [],
      running: [],
      waiting: [],
      finished: [
        fakeRun({
          id: "R1",
          status: "failed",
          pr: { id: "PR1", revision: 1, headSha: HEAD_SHA },
          startedAt: "2026-07-09T12:00:00.000Z",
          finishedAt: "2026-07-09T12:01:00.000Z",
          steps: [
            fakeStep("check", "lost", fakeJob({ id: "lost-check", status: "lost", lostReason: "lease expired" })),
          ],
        }),
        fakeRun({
          id: "R2",
          status: "failed",
          pr: { id: "PR1", revision: 1, headSha: HEAD_SHA },
          startedAt: "2026-07-09T12:02:00.000Z",
          finishedAt: "2026-07-09T12:03:00.000Z",
          steps: [
            fakeStep(
              "check",
              "failed",
              fakeJob({
                id: "failed-check",
                status: "failed",
                error: { code: "check-failed", message: "cold typecheck" },
              }),
            ),
          ],
        }),
      ],
    } as unknown as QueueStatusResult

    const frame = stripOsc8Targets(
      await renderString(
        createElement(QueueWatchView, {
          state: NO_BAYS,
          results: [result],
          now: Date.parse("2026-07-09T12:10:00.000Z"),
        }),
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
          admissionOrder: [],
          running: [],
          waiting: [],
          finished: [],
        } as unknown as QueueStatusResult,
      ],
      state: NO_BAYS,
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
    expect(sleeps).toEqual([15_000])
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
      "No runnable or recent failed PRs.",
    ].join("\n")
    for (const columns of [80, 120]) {
      const rendered = await renderStatus(columns)
      const physical = rendered.trimEnd().split("\n")
      expect(rendered.trimEnd()).toBe(expected)
      expect(physical).toHaveLength(2)
      expect(Math.max(...physical.map((row) => row.length))).toBeLessThanOrEqual(columns)
    }
  })

  it("projects open work and bounded failed-Run evidence without stale holds or unsafe retry teaching", async () => {
    const temp = mkdtempSync(join(tmpdir(), "yrd-output-polish-"))
    const artifact = join(temp, "failure.log")
    const failure = [
      "change 'PR1' could not be applied: hint: Recursive merging with submodules currently only supports trivial cases.",
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
    expect((await app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 }))[0]).toMatchObject({
      status: "completed",
      conclusion: "failure",
    })
    const resolveQueueTarget = async () => ({ base: "main", sha: BASE_SHA })
    const now = () => Date.parse("2026-07-09T12:01:00.000Z")
    const failedOnly = outputIO({ columns: 120, now, resolveQueueTarget })
    expect(await runYrd(app, yrd(), failedOnly.io), failedOnly.stderr()).toBe(0)
    expect.soft(failedOnly.stdout()).toMatch(/main@[a-f0-9]{12} OPEN 1 ACTIVE 0 INTEGRATED 0 REJECTED 0/u)

    await app.bays.submit({
      branch: "issue/runnable",
      name: "feat(cli): keep runnable work visible",
      headSha: "2".repeat(40),
      base: "origin/main",
      baseSha: BASE_SHA,
    })

    // Historical aliases can retain a pause after the canonical queue was resumed.
    await app.queue.pause({
      base: "origin/main",
      reason: "released maintenance",
      allowedPRs: [],
      expiresAt: "2026-07-13T12:00:00.000Z",
    })
    await app.queue.resume("main")

    for (const columns of [80, 120]) {
      const status = outputIO({ columns, now, resolveQueueTarget })
      expect(await runYrd(app, yrd(), status.io), status.stderr()).toBe(0)
      const rows = status.stdout().trimEnd().split("\n")
      expect.soft(rows.length).toBeLessThanOrEqual(14)
      expect.soft(Math.max(...rows.map((row) => row.length))).toBeLessThanOrEqual(columns)
      expect.soft(status.stdout()).toMatch(/main@[a-f0-9]{12} OPEN 2 ACTIVE 0 INTEGRATED 0 REJECTED 0/u)
      expect.soft(status.stdout()).toContain("feat(cli): keep runnable work visible")
      expect.soft(status.stdout()).toContain("fix(cli): bound operator failures")
      expect.soft(status.stdout()).toContain("⧗")
      expect.soft(status.stdout()).toContain("err=apply-conflict — change 'PR1' could not be applied")
      expect.soft(status.stdout()).toContain("evidence:")
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
    expect
      .soft(watchQueueRows(requiredWatchBays(snapshot), snapshot.results[0]!, now()).map((row) => row.pr))
      .toEqual(["PR1", "PR2"])
    for (const width of [80, 120]) {
      const frame = await renderString(
        createElement(QueueWatchView, { ...snapshot, state: requiredWatchBays(snapshot) }),
        { width, height: 24, plain: true },
      )
      const rows = frame.trimEnd().split("\n")
      expect.soft(rows.length).toBeLessThanOrEqual(16)
      expect.soft(Math.max(...rows.map((row) => row.length))).toBeLessThanOrEqual(width)
      expect.soft(frame).toContain("OPEN 2")
      expect.soft(frame).toContain("feat(cli): keep runnable work visible")
      expect.soft(frame).toContain("err=apply-conflict — change 'PR1' could not be applied")
      expect.soft(frame).toContain("evidence:")
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
    safeRemoveSync(temp, { within: tmpdir(), allowMissing: true })
  })

  it("does not derive next-action teaching without typed eligibility facts", () => {
    const failedRun = (id: string, revision: number, headSha: string, startedAt: string): Run =>
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
    ]

    for (const item of cases) {
      const terminalAt = item.runs.at(-1)?.finishedAt ?? "2026-07-09T12:06:00.000Z"
      const terminal =
        item.status === "rejected"
          ? ({ kind: item.status, at: terminalAt } as const)
          : item.status === "withdrawn"
            ? ({ kind: item.status, at: terminalAt } as const)
            : undefined
      const identities = new Map<string, { revision: number; headSha: string }>()
      for (const run of item.runs) {
        const member = run.prs[0]!
        identities.set(`${member.revision}@${member.headSha}`, member)
      }
      identities.set(`${item.revision}@${item.headSha}`, { revision: item.revision, headSha: item.headSha })
      const pr = timelineFixturePr("PR1", item.status, "2026-07-09T11:59:00.000Z", undefined, {
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
        ...(item.status === "rejected" ? { rejectedAt: terminalAt } : {}),
      })
      const selected = item.status === "rejected" ? new Set<string>() : new Set([pr.id])
      const projection = humanQueueProjection(
        {
          base: "main",
          headSha: BASE_SHA,
          prs: [pr],
          admissionOrder: [],
          running: [],
          waiting: [],
          finished: item.runs,
        },
        Date.parse("2026-07-09T12:10:00.000Z"),
        { selected, state: NO_BAYS },
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
    const pr = timelineFixturePr("PR1", "rejected", "2026-07-09T12:10:01.000Z", undefined, {
      revision: 2,
      headSha: "2".repeat(40),
      revisions: [
        submittedRevision(1, HEAD_SHA, "2026-07-09T12:00:30.000Z", {
          kind: "rejected",
          at: "2026-07-09T12:05:00.000Z",
        }),
        submittedRevision(2, "2".repeat(40), "2026-07-09T12:10:01.000Z", {
          kind: "rejected",
          at: "2026-07-09T12:12:00.000Z",
        }),
      ],
      rejectedAt: "2026-07-09T12:12:00.000Z",
    })
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
      pr: currentChangeSnapshot(pr),
      startedAt: "2026-07-09T12:10:30.000Z",
      finishedAt: pr.rejectedAt!,
      steps: [],
      error: { code: "check-failed", message: "revision two failed" },
    })
    const result = {
      base: "main",
      headSha: BASE_SHA,
      prs: [pr],
      admissionOrder: [],
      running: [],
      waiting: [],
      finished: [prior, current],
    } as QueueStatusResult

    const projection = humanQueueProjection(result, Date.parse("2026-07-09T12:13:00.000Z"), { state: NO_BAYS })
    expect(projection.recent.map(({ runId, submittedAt, age }) => ({ runId, submittedAt, age }))).toEqual([
      { runId: "R2", submittedAt: "2026-07-09T12:10:01.000Z", age: "1m" },
      { runId: "R1", submittedAt: "2026-07-09T12:00:30.000Z", age: "4m" },
    ])

    const awaitingCurrentRun = {
      ...pr,
      revs: [pr.revs[0]!, { ...pr.revs[1]!, terminal: undefined }],
      rejectedAt: undefined,
    } satisfies Change
    const pending = humanQueueProjection(
      { ...result, prs: [awaitingCurrentRun], admissionOrder: ["PR1"], finished: [prior] },
      Date.parse("2026-07-09T12:13:00.000Z"),
      { state: NO_BAYS },
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
    const pr: Change = {
      id: "PR-clock",
      branch: "topic/clock",
      base: "main",
      state: "open",
      merged: false,
      revs: [{ n: 1, head: HEAD_SHA, base: "main", baseSha: BASE_SHA, pushedAt: "2026-07-09T12:00:00.000Z" }],
      reviews: [],
      comments: [],
      checkRequests: [],
      submittedAt: "2026-07-09T12:00:30.000Z",
      rejectedAt: "2026-07-09T12:02:00.000Z",
    }

    expect(() => runRevisionClock(pr, run)).toThrow(
      "run 'R-clock' has no causal submit/check-request clock for change 'PR-clock' revision 1@1111111111111111111111111111111111111111",
    )
    const environmentRefused = runRevisionClock(
      {
        ...pr,
        revs: [{ ...pr.revs[0]!, submittedAt: "2026-07-09T12:00:30.000Z" }],
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
          revs: [
            {
              ...pr.revs[0]!,
              submittedAt: "2026-07-09T12:00:30.000Z",
              terminal: { kind: "rejected", at: "2026-07-09T12:01:00.000Z" },
            },
          ],
        },
        run,
      ),
    ).toThrow(
      "change 'PR-clock' current revision 1@1111111111111111111111111111111111111111 rejected terminal clock contradicts current PR state",
    )

    expect(() =>
      queueLogRows(
        // prs marks PR-clock as a RECORD member: a record with no clock stays a
        // loud failure, while a recordless (derived) member tolerates instead.
        [{ ...fakeSummary([run]), prs: [pr] }],
        new Set<string>(),
        undefined,
        new Map([[pr.id, changeDeliveryState(pr)]]),
        [],
        new Map(),
        new Map(),
      ),
    ).toThrow(
      "run 'R-clock' has no causal submit/check-request clock for change 'PR-clock' revision 1@1111111111111111111111111111111111111111",
    )
  })

  it("freezes recent rejected age at the terminal timestamp", () => {
    const terminalAt = "2026-07-09T12:06:00.000Z"
    const pr = timelineFixturePr("PR1", "rejected", "2026-07-09T12:00:00.000Z", undefined, {
      revisions: [submittedRevision(1, HEAD_SHA, "2026-07-09T12:00:00.000Z", { kind: "rejected", at: terminalAt })],
      rejectedAt: terminalAt,
    })
    const run = fakeRun({
      id: "R1",
      status: "failed",
      pr: currentChangeSnapshot(pr),
      startedAt: "2026-07-09T12:05:00.000Z",
      finishedAt: terminalAt,
      steps: [],
      error: { code: "check-failed", message: "check failed" },
    })
    const result = {
      base: "main",
      headSha: BASE_SHA,
      prs: [pr],
      admissionOrder: [],
      running: [],
      waiting: [],
      finished: [run],
    } as QueueStatusResult

    const first = humanQueueProjection(result, Date.parse("2026-07-09T13:00:00.000Z"), { state: NO_BAYS }).recent[0]
    const later = humanQueueProjection(result, Date.parse("2026-07-10T13:00:00.000Z"), { state: NO_BAYS }).recent[0]
    expect(first?.age).toBe("6m")
    expect(later?.age).toBe(first?.age)
  })

  it("projects failure evidence only from the causative failed step", () => {
    const temp = mkdtempSync(join(tmpdir(), "yrd-causal-evidence-"))
    const prior = join(temp, "prepare.log")
    const causal = join(temp, "check.log")
    writeFileSync(prior, "prepare passed\n")
    writeFileSync(causal, "check failed\n")
    const pr = timelineFixturePr("PR1", "rejected", "2026-07-09T11:59:00.000Z", undefined, {
      revisions: [
        submittedRevision(1, HEAD_SHA, "2026-07-09T11:59:00.000Z", {
          kind: "rejected",
          at: "2026-07-09T12:01:00.000Z",
        }),
      ],
      rejectedAt: "2026-07-09T12:01:00.000Z",
    })
    const run = fakeRun({
      id: "R1",
      status: "failed",
      pr: currentChangeSnapshot(pr),
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
      {
        base: "main",
        headSha: BASE_SHA,
        prs: [pr],
        admissionOrder: [],
        running: [],
        waiting: [],
        finished: [run],
      },
      Date.parse("2026-07-09T12:02:00.000Z"),
      { state: NO_BAYS },
    ).recent[0]?.failure
    expect(failure?.evidence).toEqual({ text: causal, href: pathToFileURL(causal).href })
    safeRemoveSync(temp, { within: tmpdir(), allowMissing: true })
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
      timelineFixturePr("PR1", "submitted", "2026-07-09T12:00:00.000Z", "unrelated active run", {
        headSha: HEAD_SHA,
      }),
      timelineFixturePr("PR2", "submitted", "2026-07-09T12:01:00.000Z", "selected active run", {
        headSha: "2".repeat(40),
      }),
    ]
    const result = {
      base: "main",
      prs,
      admissionOrder: ["PR1", "PR2"],
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
        state: NO_BAYS,
      }).active,
    ).toMatchObject({ run: "R2", pr: "PR2", subject: "selected active run" })
  })

  it("caps queue and rejection projections independently at 80 and 120 columns", async () => {
    const submitted = Array.from({ length: 7 }, (_, index) =>
      timelineFixturePr(
        `PR${index + 1}`,
        "submitted",
        `2026-07-09T12:0${index}:00.000Z`,
        `feat(cli): runnable ${index + 1}`,
        { headSha: String(index + 1).repeat(40) },
      ),
    )
    const rejected = Array.from({ length: 5 }, (_, index) =>
      timelineFixturePr(
        `PR${index + 8}`,
        "rejected",
        `2026-07-09T11:0${index}:00.000Z`,
        `fix(cli): rejected ${index + 1}`,
        {
          headSha: String(index + 8).repeat(40),
          rejectedAt: `2026-07-09T12:1${index}:00.000Z`,
        },
      ),
    )
    const finished = rejected.map((pr, index) =>
      fakeRun({
        id: `R${index + 1}`,
        pr: currentChangeSnapshot(pr),
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
      admissionOrder: submitted.map((pr) => pr.id),
      running: [],
      waiting: [],
      finished,
    } as unknown as QueueStatusResult
    const now = Date.parse("2026-07-09T13:00:00.000Z")
    const projection = humanQueueProjection(result, now, { state: NO_BAYS })
    expect(projection).toMatchObject({ open: 7, rejected: 5, queueOverflow: 2 })
    expect(projection.queue).toHaveLength(5)
    expect(projection.recent).toHaveLength(3)
    expect(projection.recent.map((row) => row.runId)).toEqual(["R5", "R4", "R3"])

    for (const width of [80, 120]) {
      const frame = await renderString(createElement(QueueWatchView, { state: NO_BAYS, results: [result], now }), {
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
    expect((await app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 }))[0]).toMatchObject({
      status: "completed",
      conclusion: "success",
    })
    await app.bays.submit({ branch: "issue/alias", headSha: "2".repeat(40), base: "origin/main" })
    expect((await app.queue.run({ prs: ["PR2"] }, { runner: "test", leaseMs: 60_000 }))[0]).toMatchObject({
      status: "completed",
      conclusion: "success",
    })
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
          merge: expect.any(String),
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

  it("shows run proof slices, revisions, timings, evidence, checkpoint, and merge proof", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    expect(await runYrd(app, yrd("queue", "run", "PR1"), outputIO().io)).toBe(0)

    const human = outputIO({ color: true, columns: 200 })
    expect(await runYrd(app, yrd("pr", "runs", "PR1"), human.io)).toBe(0)
    expect(stripAnsi(human.stdout())).toContain("CHAIN pr#1.1 → C1 → main#1")
    expect(human.stdout()).toContain("RUN")
    expect(human.stdout()).toContain("STEP")
    expect(human.stdout()).toContain("REV")
    expect(human.stdout()).toContain("OUTPUT")
    // Present-facts rule: this run records no checkpoint, so no placeholder.
    expect(human.stdout()).not.toContain("CHECKPOINT -")
    expect(human.stdout()).toContain("EVIDENCE")
    expect(human.stdout()).toContain("MERGE")
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
    })
    expect(parsed.runs[0]).toMatchObject({ candidateId: "C1", taskStatus: "done" })
    expect(parsed.runs[0]?.steps).toHaveLength(2)
    expect(parsed.runs[0]?.steps[0]).toMatchObject({
      step: "check",
      revision: "check-v1",
      status: "passed",
      taskStatus: "done",
    })
    expect(parsed.runs[0]?.steps[0]).toHaveProperty("detail")
    expect(parsed.runs[0]?.steps[0]).toHaveProperty("output")
    expect(parsed.runs[0]?.steps[0]).toHaveProperty("merge")
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
    expect(human.stdout()).not.toContain("TERMINAL rejected")
    expect(human.stdout()).toContain("PUSHED 2026-07-09T12:10:00.000Z")
    expect(human.stdout()).toContain("SUBMITTED 2026-07-09T12:10:00.000Z")
    expect(human.stdout()).toContain("PUSHED 2026-07-09T12:20:00.000Z")
    expect(human.stdout()).toContain("No runs recorded for this revision.")

    const json = outputIO()
    expect(await runYrd(app, yrd("pr", "runs", "PR1", "--json"), json.io), json.stderr()).toBe(0)
    const parsed = JSON.parse(json.stdout()) as {
      pr: {
        revs: readonly Readonly<{
          n: number
          head: string
          pushedAt: string
          submittedAt?: string
          terminal?: Readonly<{ kind: string; at: string }>
        }>[]
      }
      runs: ReturnType<typeof queueShowData>[]
    }
    expect(parsed.pr.revs).toMatchObject([
      {
        n: 1,
        head: HEAD_SHA,
        submittedAt: "2026-07-09T12:00:00.000Z",
      },
      {
        n: 2,
        head: nextHead,
        submittedAt: "2026-07-09T12:10:00.000Z",
      },
      { n: 3, head: pushedOnlyHead, pushedAt: "2026-07-09T12:20:00.000Z" },
    ])
    expect(parsed.pr.revs.every((revision) => revision.terminal === undefined)).toBe(true)
    expect(parsed.runs.map((run) => run.revisionClock)).toMatchObject([
      { pr: "PR1", revision: 1, headSha: HEAD_SHA, submittedAt: "2026-07-09T12:00:00.000Z" },
      { pr: "PR1", revision: 2, headSha: nextHead, submittedAt: "2026-07-09T12:10:00.000Z" },
    ])
  })

  it("records repeated pushed draft-check verdicts without minting Queue runs", async () => {
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
    expect(await app.queue.admit({ prs: ["PR1"] }, { runner: "cli-test", leaseMs: 60_000 })).toEqual(["PR1"])
    expect(changeAdmission(app.bays.pr("PR1")!)).toMatchObject({
      status: "refused",
      kind: "failure",
      baseSha: BASE_SHA,
      step: "check",
    })
    now = "2026-07-09T12:10:00.000Z"
    await app.bays.requestChecks({ pr: "PR1", baseSha: BASE_SHA })
    now = "2026-07-09T12:11:00.000Z"
    expect(await app.queue.admit({ prs: ["PR1"] }, { runner: "cli-test", leaseMs: 60_000 })).toEqual(["PR1"])
    expect(changeAdmission(app.bays.pr("PR1")!)).toMatchObject({
      status: "refused",
      kind: "failure",
      baseSha: BASE_SHA,
      step: "check",
      at: "2026-07-09T12:11:00.000Z",
    })
    expect(Queues.ids(app.state().queues)).toEqual([])
    expect(changeDeliveryState(app.state().bays.prs.PR1!)).toBe("pushed")
    expect(app.state().bays.prs.PR1).not.toHaveProperty("submittedAt")

    const human = outputIO({ columns: 80 })
    expect(await runYrd(app, yrd("pr", "runs", "PR1"), human.io), human.stderr()).toBe(0)
    expect(human.stdout()).toContain(`REVISION CLOCK pr#1.1 HEAD ${HEAD_SHA}`)
    expect(human.stdout()).toContain("SUBMITTED -")
    expect(human.stdout()).toContain("CHECK REQUESTED 2026-07-09T12:01:00.000Z, 2026-07-09T12:10:00.000Z")
    expect(human.stdout()).toContain("No runs recorded for this revision.")

    const json = outputIO()
    expect(await runYrd(app, yrd("pr", "runs", "PR1", "--json"), json.io), json.stderr()).toBe(0)
    const parsed = JSON.parse(json.stdout()) as { runs: ReturnType<typeof queueShowData>[] }
    expect(parsed.runs).toEqual([])

    now = "2026-07-09T12:20:00.000Z"
    const fixedHead = "2".repeat(40)
    const fixed = outputIO({ resolveRevision: () => Promise.resolve(fixedHead) })
    expect(await runYrd(app, yrd("pr", "submit", "topic/draft-check"), fixed.io), fixed.stderr()).toBe(0)
    expect(app.state().bays.prs.PR1).toMatchObject({
      state: "open",
      merged: false,
      submittedAt: now,
      revs: [
        { n: 1, head: HEAD_SHA },
        { n: 2, head: fixedHead, submittedAt: now },
      ],
    })
    expect(app.state().bays.prs.PR1?.revs[0]).not.toHaveProperty("submittedAt")
    expect(app.state().bays.prs.PR1?.revs[0]).not.toHaveProperty("terminal")

    const laterQueue = outputIO({ columns: 120, now: () => Date.parse("2026-07-09T12:21:00.000Z") })
    expect(await runYrd(app, yrd("queue"), laterQueue.io), laterQueue.stderr()).toBe(0)
    // The old ROWS "oldest=" cell has no place in the calendar STATS surface.
    expect(laterQueue.stdout()).toContain("STATS")

    const laterHuman = outputIO({ columns: 120 })
    expect(await runYrd(app, yrd("log", "--pr", "PR1"), laterHuman.io), laterHuman.stderr()).toBe(0)
    expect(laterHuman.stdout()).toContain("No matching terminal log rows.")

    const laterJson = outputIO()
    expect(await runYrd(app, yrd("log", "--pr", "PR1", "--json"), laterJson.io), laterJson.stderr()).toBe(0)
    const rows = (JSON.parse(laterJson.stdout()) as { rows: ReturnType<typeof queueLogRows> }).rows
    expect(rows).toEqual([])
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
    const statusByPr = new Map<string, ChangeDeliveryState>([
      ["PR1", "integrated"],
      ["PR-retired", "withdrawn"],
    ])
    const rows = queueLogRows([summary], new Set<string>(), undefined, statusByPr)
    const changeRows = rows.filter((row) => row.pr === "PR1")
    const revision2Rows = changeRows.filter((row) => row.revision === "2")

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
    expect(changeRows.find((row) => row.run === "R3")?.location).toBeUndefined()

    const statusPr = timelineFixturePr("PR1", "submitted", "2026-07-10T10:59:00.000Z", undefined, {
      revision: 3,
      headSha: "f".repeat(40),
    })
    const statusRows = queueStatusRows(
      { byId: {}, prs: { PR1: statusPr }, receipts: {}, submits: {} },
      { ...fakeSummary([runMissingLocation]), prs: [statusPr], admissionOrder: ["PR1"] },
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
    expect(changeRows.some((row) => row.outcome === "retired")).toBe(false)

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
    const compactShow = await renderString(createElement(QueueShowView, { data: show, compact: true }), {
      width: 80,
      height: 40,
      plain: true,
    })
    expect(compactShow).toContain("CANDIDATE C:R2 RUN main#2")
    const queueShowJson = JSON.parse(JSON.stringify(show)) as typeof show
    expect(queueShowJson.steps[0]).toMatchObject({
      uuid: JOB_CHECK_PASS_ID,
      attempt: "2",
      duration: "2.0s",
    })

    safeRemoveSync(temp, { within: tmpdir(), allowMissing: true })
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
      safeRemoveSync(temp, { within: tmpdir(), allowMissing: true })
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
          result: { status: "completed", conclusion: "success", output: {} },
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
            status: "completed",
            conclusion: "failure",
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
          result: { status: "completed", conclusion: "success", output: {} },
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
          duration: "3m42s",
          error: "merge stalled",
        }),
        expect.objectContaining({
          step: "merge",
          attempt: "2",
          status: "passed",
          taskStatus: "done",
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
          { attempt: 1, taskStatus: "done" },
          { attempt: 1, taskStatus: "blocked" },
          { attempt: 2, taskStatus: "done" },
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

    safeRemoveSync(temp, { within: tmpdir(), allowMissing: true })
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
            result: { status: "completed", conclusion: "success", output: {} },
          },
        }),
      ]),
    ).rejects.toThrow(/precedes/u)

    const failedStep = (startedAt: string, finishedAt: string) =>
      fakeStep("check", "failed", fakeJob({ id: job, status: "failed", startedAt, finishedAt }))
    const project = (run: Run, submittedAt = "2026-07-12T11:59:00.000Z") =>
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
    const future = timelineFixturePr("PR94", "submitted", "2026-07-12T12:05:00.000Z", undefined, {
      headSha: HEAD_SHA,
    })
    const futureResult = {
      base: "main",
      prs: [future],
      admissionOrder: ["PR94"],
      running: [],
      waiting: [],
      finished: [],
    } as QueueStatusResult
    expect
      .soft(() => humanQueueProjection(futureResult, Date.parse("2026-07-12T12:00:00.000Z"), { state: NO_BAYS }))
      .toThrow(/precedes/u)

    const rejected = timelineFixturePr("PR95", "rejected", "2026-07-12T11:59:00.000Z", undefined, {
      headSha: HEAD_SHA,
      rejectedAt: "2026-07-12T12:01:00.000Z",
    })
    const backwards = fakeRun({
      id: "R95",
      pr: currentChangeSnapshot(rejected),
      status: "failed",
      startedAt: "2026-07-12T12:02:00.000Z",
      finishedAt: "2026-07-12T12:01:00.000Z",
      steps: [],
      error: { code: "check-failed", message: "check failed" },
    })
    const backwardsResult = {
      base: "main",
      prs: [rejected],
      admissionOrder: [],
      running: [],
      waiting: [],
      finished: [backwards],
    } as QueueStatusResult
    expect
      .soft(() => humanQueueProjection(backwardsResult, Date.parse("2026-07-12T12:03:00.000Z"), { state: NO_BAYS }))
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
      await runYrd(app, yrd("contest", "open", "km:T1", "--competitors", contestCompetitors(), "--json"), compete.io),
    ).toBe(0)
    expect(JSON.parse(compete.stdout())).toMatchObject({
      command: "contest.open",
      contest: { id: "C1", status: "ready", attemptOrder: ["A1", "A2"], base: "main", baseSha: BASE_SHA },
    })
    expect(baseResolutions).toEqual(["main"])

    const human = outputIO({ columns: 96, color: true })
    expect(await runYrd(app, yrd("contest", "view", "C1"), human.io)).toBe(0)
    expect(human.stdout()).toContain("ATTEMPT")
    expect(human.stdout()).toContain("COMPETITOR")
    expect(human.stdout()).toContain("RUNNER")
    expect(human.stdout()).toContain("TIME")
    expect(human.stdout()).toContain("TOKENS")
    expect(human.stdout()).toContain("COST")
    expect(human.stdout()).toContain("fast")
    expect(human.stdout()).toContain("thorough")

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
      contest: {
        status: "promoted",
        promotion: { attempt: "A1", job: { status: "completed", conclusion: "success" } },
      },
    })
  })

  it("finishes a waiting remote evaluator through the Contest surface", async () => {
    const app = await createApp({ waitingEvaluator: "A2" })
    const compete = outputIO()
    expect(
      await runYrd(app, yrd("contest", "open", "km:T1", "--competitors", contestCompetitors(), "--json"), compete.io),
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
                runs: [
                  {
                    job: { status: "completed", conclusion: "success" },
                    result: { verdict: "failed", summary: "private tests failed" },
                  },
                ],
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
      await runYrd(
        app,
        yrd("contest", "open", "km:T1", "--competitors", contestCompetitors(), "--json"),
        outputIO().io,
      ),
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
                      status: "completed",
                      conclusion: "failure",
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

    expect(await runYrd(app, yrd("contest", "open", "km:T1", "--competitors", contestCompetitors()), compete.io)).toBe(
      0,
    )
    expect(probe.max("bay")).toBe(2)
    expect(probe.max("runner")).toBe(2)
    expect(probe.max("evaluator")).toBe(2)
  })

  it("prints a suggested unknown subcommand as exactly one human line", async () => {
    const app = await createApp()
    const typo = outputIO({ columns: 20 })

    expect(await runYrd(app, yrd("pr", "crate"), typo.io)).toBe(2)
    expect(typo.stdout()).toBe("")
    expect(typo.stderr()).toBe("error: unknown command 'crate' (Did you mean 'create'?)\n")
  })

  it("offers scoped help for an unsuggested subcommand and retains the structured JSON error", async () => {
    const app = await createApp()
    const unsuggested = outputIO()

    expect(await runYrd(app, yrd("pr", "xyzzy"), unsuggested.io)).toBe(2)
    expect(unsuggested.stderr()).toBe(
      "error: unknown command 'xyzzy' (Run 'yrd change --help' for available commands.)\n",
    )

    const repoScoped = outputIO()
    expect(await runInternals.runYrdHelp(yrd("--repo", "/tmp/project", "pr", "xyzzy"), repoScoped.io)).toBe(2)
    expect(repoScoped.stderr()).toBe(
      "error: unknown command 'xyzzy' (Run 'yrd change --help' for available commands.)\n",
    )

    for (const operand of ["foo.bar", "foo,bar"]) {
      const punctuated = outputIO()
      expect(await runYrd(app, yrd("bay", operand), punctuated.io)).toBe(2)
      expect(punctuated.stderr()).toBe(
        `error: unknown command '${operand}' (Run 'yrd bay --help' for available commands.)\n`,
      )
    }

    const json = outputIO()
    expect(await runYrd(app, yrd("pr", "crate", "--json"), json.io)).toBe(2)
    expect(json.stdout()).toBe("")
    expect(JSON.parse(json.stderr())).toEqual({
      failure: {
        kind: "usage",
        code: "invalid-arguments",
        message: "error: unknown command 'crate'\n(Did you mean create?)",
        cause: "unknown command 'crate' (Did you mean create?)",
        resolution: ["Correct the cause above, then retry the same Yrd command."],
      },
    })
  })

  it("retains a concrete command remedy on a real command failure", async () => {
    const app = await createApp()
    const output = outputIO({ currentBranch: () => "topic/unsubmitted" })

    expect(await runYrd(app, yrd("pr", "status"), output.io)).toBe(1)
    expect(output.stdout()).toBe("")
    expect(output.stderr()).toBe("error: the current bay or branch has no PR\nresolve: yrd pr submit\n")
  })

  it("lets Commander, not raw argv scanning, own JSON output mode", async () => {
    const app = await createApp()
    const optionValue = outputIO()

    expect(await runYrd(app, yrd("pr", "edit", "PR404", "--title", "--json"), optionValue.io)).toBe(1)
    expect(optionValue.stdout()).toBe("")
    // The denominator is load-bearing, not decoration: it is what separates
    // "no such PR" from "the index returned nothing". This app has no PRs, so
    // `searched 0` here is HONEST ABSENCE — which is why the message reports
    // the count and does not assert a verdict at zero.
    expect(optionValue.stderr()).toBe("error: no change 'PR404' — searched 0 change(s)\n")

    const afterTerminator = outputIO()
    expect(await runYrd(app, yrd("pr", "crate", "--", "--json"), afterTerminator.io)).toBe(2)
    expect(afterTerminator.stderr()).toMatch(/^error: /u)
    expect(() => JSON.parse(afterTerminator.stderr())).toThrow()
  })

  it("uses the documented exit taxonomy and keeps diagnostics off stdout", async () => {
    const app = await createApp()

    const usage = outputIO()
    expect(await runYrd(app, yrd("bay", "adopt", "old-branch"), usage.io)).toBe(2)
    expect(usage.stdout()).toBe("")
    expect(usage.stderr()).toBe("error: unknown command 'adopt' (Run 'yrd bay --help' for available commands.)\n")

    const refusal = outputIO()
    expect(await runYrd(app, yrd("bay", "close", "missing"), refusal.io)).toBe(1)
    expect(refusal.stdout()).toBe("")
    // Exact equality on the RENDERED bytes is deliberately the fence here: the
    // selector refusal must keep naming how to find a real Bay. `no bay 'X'`
    // alone is true and useless — the same defect this file already records at
    // "tells a bayless author which step is missing", where it cost one seat
    // three escalations and most of a day.
    //
    // The `resolve:` line is not decoration and not a second message: the
    // refusal renderer lifts a quoted 'yrd ...' command out of the prose into
    // it (actionable-error.ts `embeddedYrdCommands`), so in this file a cure is
    // spelled as a quoted command or it does not reach the reader at all. The
    // surrounding prose is discarded on the way, which is why asserting the raw
    // message string here would fence something nobody ever sees.
    expect(refusal.stderr()).toBe("error: no bay 'missing'\nresolve: yrd bay\n")

    // The selectorless branch of the same helper. It had no test at all, and
    // said only that nothing was available — never that Bays are something you
    // open. A first-time caller cannot act on the bare statement.
    const noneAtAll = outputIO()
    expect(await runYrd(app, yrd("bay", "close"), noneAtAll.io)).toBe(1)
    expect(noneAtAll.stderr()).toBe("error: no bays are available to close\nresolve: yrd bay open --bay <name>\n")

    const missingPR = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "PR404"), missingPR.io)).toBe(1)
    // WIDENED: `queue run` was one of nine raw emissions inside the queue
    // package, none of which could reach the bay model's builder while it was
    // private. Exporting it collapsed eleven hand-rolled spellings onto one
    // sentence. `searched 0` is honest here — this app has no PRs.
    expect(missingPR.stderr()).toBe("error: no change 'PR404' — searched 0 change(s)\n")

    const missingChangeJson = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "PR404", "--json"), missingChangeJson.io)).toBe(1)
    expect(JSON.parse(missingChangeJson.stderr())).toEqual({
      failure: {
        kind: "refusal",
        code: "pr-not-found",
        message: "yrd: no change 'PR404' — searched 0 change(s)",
        cause: "no change 'PR404' — searched 0 change(s)",
        resolution: ["Correct the cause above, then retry the same Yrd command."],
      },
    })

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
    expect(missingWaitingRun.stderr()).toBe("error: no queue run or change 'PR404'\n")

    const unsupported = outputIO()
    expect(await runYrd(app, yrd("admin", "journal", "bump", "2"), unsupported.io)).toBe(2)
    expect(unsupported.stderr()).toBe("error: journal bump capability is not installed\n")

    const missingIssueSource = outputIO()
    expect(
      await runYrd(
        app,
        yrd("contest", "open", "github:42", "--competitors", contestCompetitors()),
        missingIssueSource.io,
      ),
    ).toBe(2)
    expect(missingIssueSource.stderr()).toBe("error: no issue source 'github' is registered\n")

    const infrastructure = outputIO({
      resolveRevision: async () => {
        throw new Error("corrupt event log at row 4")
      },
    })
    expect(await runYrd(app, yrd(), infrastructure.io)).toBe(3)
    expect(infrastructure.stdout()).toBe("")
    expect(infrastructure.stderr()).toBe("error: corrupt event log at row 4\n")
  })

  it("carries a foreign environment-audit finding and cancels an idle watch deterministically", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    await app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 })

    const coreAudit = outputIO()
    expect(await runYrd(app, yrd("queue", "audit", "--json"), coreAudit.io)).toBe(0)
    expect(JSON.parse(coreAudit.stdout())).toMatchObject({ findings: [] })
    // No environment audit is wired into this embedded app, and the denominator
    // line says so rather than printing a compared zero (23193).
    const coreHuman = outputIO()
    expect(await runYrd(app, yrd("queue", "audit"), coreHuman.io)).toBe(0)
    expect(coreHuman.stdout()).toContain("queue audit clean")
    expect(coreHuman.stdout()).toContain(
      "plan audit: not wired for this invocation — nothing was compared against git.",
    )

    const services: YrdCliServices = {
      queue: {
        // A code THIS build does not know — the finding a foreign or newer
        // producer wrote, which the CLI must carry rather than refuse. No
        // in-repo producer can write it (QueueAuditFindingEmission forbids
        // exactly that), so the cast is what makes the foreign case expressible.
        auditEnvironment: async () =>
          ({
            findings: [{ code: "operator-finding", message: "inspect runner" }],
            comparison: stubAuditComparison(),
          }) as unknown as QueueEnvironmentAuditEmission,
      },
    }

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
    expect(await runYrd(app, yrd("queue", "run", "--interval", "1"), watch.io)).toBe(3)
    expect(watch.stdout()).toBe("")
    expect(sleeps).toEqual([1_000])
  })

  it("announces one habitant runner across idle follow polls while JSON stays silent", async () => {
    const repo = mkdtempSync(join(tmpdir(), "yrd-habitant-watch-presence-"))
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
      expect(await runYrd(app, yrd("queue", "run", "--interval", "1"), human.io), human.stderr()).toBe(3)
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
      expect(await runYrd(app, yrd("queue", "run", "--interval", "1", "--json"), json.io), json.stderr()).toBe(3)
      expect(json.stdout()).toBe("")
    } finally {
      safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
    }
  })

  it("routes follow, --once, and selector runs to the right presence and projection", async () => {
    const repo = mkdtempSync(join(tmpdir(), "yrd-habitant-follow-projection-"))
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
      // A change selector is a one-shot pass: it drains, prints the interactive run
      // table, and never announces the habitant follow-runner.
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

      // Follow (the default with no selector) is the habitant runner: it
      // announces presence once and keeps stdout a loggily-only log stream — the
      // interactive run table is the `queue watch` viewer's surface, never the
      // follow-runner's.
      const automaticHuman = outputIO({ cwd: repo, runner, scope: onePassScope() })
      expect(
        await runYrd(await readyApp(), yrd("queue", "run", "--interval", "1"), automaticHuman.io),
        automaticHuman.stderr(),
      ).toBe(3)
      expect(automaticHuman.stdout()).toBe(presence)

      // Follow --json streams one run record per drained run, tagged
      // mode:"follow", with no presence banner in the JSON stream.
      const automaticJson = outputIO({ cwd: repo, runner, scope: onePassScope() })
      expect(
        await runYrd(await readyApp(), yrd("queue", "run", "--interval", "1", "--json"), automaticJson.io),
        automaticJson.stderr(),
      ).toBe(3)
      expect(automaticJson.stdout().trim().split("\n")).toHaveLength(1)
      expect(JSON.parse(automaticJson.stdout())).toMatchObject({ command: "queue.run", mode: "follow" })
      expect(automaticJson.stdout()).not.toContain("Queue runner ")
    } finally {
      safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
    }
  })

  it("explains a failed merge from repository records after the Journal is lost", async () => {
    await using app = await createApp()
    const output = outputIO()
    const changeId = `I${"e".repeat(40)}`
    const record = {
      merge: {
        id: "R-failed",
        base: "main",
        baseSha: BASE_SHA,
        candidate: "candidate:R-failed",
        result: "failed" as const,
        startedAt: "2026-08-12T20:00:00.000Z",
        finishedAt: "2026-08-12T20:01:00.000Z",
      },
      changes: [{ changeId, pr: "PR1", revision: 1, submittedHead: HEAD_SHA }],
      reason: { code: "merge-conflict", message: "candidate no longer applies to main" },
      evidence: {
        jobs: [
          {
            id: "J-merge",
            step: "merge",
            attempt: 1,
            result: "failure" as const,
            startedAt: "2026-08-12T20:00:00.000Z",
            finishedAt: "2026-08-12T20:01:00.000Z",
          },
        ],
      },
      pins: [],
      fix: "refresh the candidate on current main and retry",
    }
    const pointer = {
      ref: "refs/notes/yrd/merge-records" as const,
      target: "2".repeat(40),
      note: "3".repeat(40),
      checksum: "4".repeat(64),
    }

    expect(
      await runYrd(app, yrd("why", "PR1", "--json"), output.io, {
        mergeRecords: {
          find: async () => ({
            status: "proven" as const,
            records: [{ record, pointer }],
            unverifiable: [],
            retracted: [],
          }),
          all: async () => ({
            status: "proven" as const,
            records: [{ record, pointer }],
            unverifiable: [],
            retracted: [],
          }),
          retractUnprovable: async () => ({ proven: 0, alreadyRetracted: 0, planned: [], applied: [] }),
        },
      } as YrdCliServices),
      output.stderr(),
    ).toBe(1)
    expect(JSON.parse(output.stdout())).toMatchObject({
      command: "why",
      selector: "PR1",
      verdict: "failed",
      repaired: false,
      record: {
        merge: { id: "R-failed", result: "failed" },
        reason: { code: "merge-conflict" },
        fix: "refresh the candidate on current main and retry",
      },
      pointer,
    })
  })

  it("names a merge that joined nothing as already up to date, first-class", async () => {
    await using app = await createApp()
    const output = outputIO()
    const changeId = `I${"e".repeat(40)}`
    // The nothing-new shape: a merged result that IS its own base. The record
    // stores only the facts; the outcome is derived, and it is a SUCCESS.
    const record = {
      merge: {
        id: "R-nothing-new",
        base: "main",
        baseSha: BASE_SHA,
        candidate: "candidate:R-nothing-new",
        result: "merged" as const,
        mergedCommit: BASE_SHA,
        startedAt: "2026-08-12T20:00:00.000Z",
        finishedAt: "2026-08-12T20:01:00.000Z",
      },
      changes: [{ changeId, pr: "PR1", revision: 1, submittedHead: HEAD_SHA }],
      evidence: { jobs: [] },
      pins: [],
    }
    const pointer = {
      ref: "refs/notes/yrd/merge-records" as const,
      target: "2".repeat(40),
      note: "3".repeat(40),
      checksum: "4".repeat(64),
    }

    expect(
      await runYrd(app, yrd("why", "PR1", "--json"), output.io, {
        mergeRecords: {
          find: async () => ({
            status: "proven" as const,
            records: [{ record, pointer }],
            unverifiable: [],
            retracted: [],
          }),
          all: async () => ({
            status: "proven" as const,
            records: [{ record, pointer }],
            unverifiable: [],
            retracted: [],
          }),
          retractUnprovable: async () => ({ proven: 0, alreadyRetracted: 0, planned: [], applied: [] }),
        },
      } as YrdCliServices),
      output.stderr(),
    ).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({
      command: "why",
      selector: "PR1",
      verdict: "merged",
      nothingNew: true,
      record: { merge: { id: "R-nothing-new", mergedCommit: BASE_SHA } },
    })

    const human = outputIO()
    expect(
      await runYrd(app, yrd("why", "PR1"), human.io, {
        mergeRecords: {
          find: async () => ({
            status: "proven" as const,
            records: [{ record, pointer }],
            unverifiable: [],
            retracted: [],
          }),
          all: async () => ({
            status: "proven" as const,
            records: [{ record, pointer }],
            unverifiable: [],
            retracted: [],
          }),
          retractUnprovable: async () => ({ proven: 0, alreadyRetracted: 0, planned: [], applied: [] }),
        },
      } as YrdCliServices),
      human.stderr(),
    ).toBe(0)
    expect(human.stdout()).toContain("already up to date — joined nothing new to 'main'")
    // The line must not read as a fresh merge: no bare "at <commit>" claim.
    expect(human.stdout()).not.toContain(`at ${BASE_SHA}\n`)
  })

  it("repairs a repository-proven merge whose Journal index row is missing", async () => {
    await using app = await createApp()
    await app.bays.submit({ branch: "issue/index-gap", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    const revision = currentChangeRev(app.bays.pr("PR1")!)
    if (revision.changeId === undefined) throw new Error("expected current PR Change-Id")
    const pointer = {
      ref: "refs/notes/yrd/merge-records" as const,
      target: "2".repeat(40),
      note: "c".repeat(40),
      checksum: "d".repeat(64),
    }
    const record = {
      merge: {
        id: "R-recovered",
        base: "main",
        baseSha: BASE_SHA,
        candidate: "C1",
        result: "merged" as const,
        mergedCommit: MERGED_SHA,
        startedAt: "2026-08-12T20:00:00.000Z",
        finishedAt: "2026-08-12T20:01:00.000Z",
      },
      changes: [
        {
          pr: "PR1",
          revision: 1,
          submittedHead: HEAD_SHA,
          changeId: revision.changeId,
          generatedCommit: MERGED_SHA,
        },
      ],
      evidence: { jobs: [] },
      pins: [],
    }
    const output = outputIO()

    expect(
      await runYrd(app, yrd("why", "PR1", "--repair", "--json"), output.io, {
        mergeRecords: {
          find: async () => ({
            status: "proven" as const,
            records: [{ record, pointer }],
            unverifiable: [],
            retracted: [],
          }),
          all: async () => ({
            status: "proven" as const,
            records: [{ record, pointer }],
            unverifiable: [],
            retracted: [],
          }),
          retractUnprovable: async () => ({ proven: 0, alreadyRetracted: 0, planned: [], applied: [] }),
        },
      } as YrdCliServices),
      output.stderr(),
    ).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({
      command: "why",
      verdict: "merged",
      repaired: true,
      pointer,
    })
    expect(app.bays.pr("PR1")?.integration).toMatchObject({ commit: MERGED_SHA, changeId: revision.changeId })
  })

  // The in-toto projection is read-time and needs a builder the durable record
  // deliberately does not carry, so it can only be assembled where the journal's
  // run is also in hand. Absence is named on the payload rather than dropped:
  // a missing `statement` key alone cannot distinguish "not attestable" from
  // "nobody wired the projection".
  it("projects a merged merge record as an in-toto Statement attributed to its queue", async () => {
    await using app = await createApp()
    await app.bays.submit({ branch: "issue/attested", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    const revision = currentChangeRev(app.bays.pr("PR1")!)
    if (revision.changeId === undefined) throw new Error("expected current PR Change-Id")
    await runYrd(app, yrd("queue", "run", "--once"), outputIO().io)
    const run = Queues.values(app.state().queues).at(0)
    if (run === undefined) throw new Error("expected a queue run in the journal")
    const pointer = {
      ref: "refs/notes/yrd/merge-records" as const,
      target: "2".repeat(40),
      note: "e".repeat(40),
      checksum: "f".repeat(64),
    }
    const record = {
      merge: {
        id: run.id,
        base: "main",
        baseSha: BASE_SHA,
        candidate: "C1",
        result: "merged" as const,
        mergedCommit: MERGED_SHA,
        startedAt: "2026-08-12T20:00:00.000Z",
        finishedAt: "2026-08-12T20:01:00.000Z",
      },
      changes: [
        { pr: "PR1", revision: 1, submittedHead: HEAD_SHA, changeId: revision.changeId, generatedCommit: MERGED_SHA },
      ],
      evidence: { jobs: [] },
      pins: [],
    }
    const output = outputIO()

    await runYrd(app, yrd("why", "PR1", "--json"), output.io, {
      mergeRecords: {
        find: async () => ({
          status: "proven" as const,
          records: [{ record, pointer }],
          unverifiable: [],
          retracted: [],
        }),
        all: async () => ({
          status: "proven" as const,
          records: [{ record, pointer }],
          unverifiable: [],
          retracted: [],
        }),
        retractUnprovable: async () => ({ proven: 0, alreadyRetracted: 0, planned: [], applied: [] }),
      },
    } as YrdCliServices)

    expect(JSON.parse(output.stdout())).toMatchObject({
      command: "why",
      verdict: "merged",
      statement: {
        _type: "https://in-toto.io/Statement/v1",
        predicateType: "https://yrd.dev/attestation/merge-record/v1",
        subject: [{ name: "C1", digest: { sha1: MERGED_SHA } }],
        predicate: { builder: { id: run.queueId } },
      },
    })
  })

  it("names why a Statement is unavailable rather than dropping the key", async () => {
    await using app = await createApp()
    await app.bays.submit({ branch: "issue/unattested", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    const pointer = {
      ref: "refs/notes/yrd/merge-records" as const,
      target: "2".repeat(40),
      note: "a".repeat(40),
      checksum: "b".repeat(64),
    }
    const record = {
      merge: {
        id: "R-not-in-journal",
        base: "main",
        baseSha: BASE_SHA,
        candidate: "C1",
        result: "merged" as const,
        mergedCommit: MERGED_SHA,
        startedAt: "2026-08-12T20:00:00.000Z",
        finishedAt: "2026-08-12T20:01:00.000Z",
      },
      changes: [{ pr: "PR1", revision: 1, submittedHead: HEAD_SHA, generatedCommit: MERGED_SHA }],
      evidence: { jobs: [] },
      pins: [],
    }
    const output = outputIO()

    await runYrd(app, yrd("why", "PR1", "--json"), output.io, {
      mergeRecords: {
        find: async () => ({
          status: "proven" as const,
          records: [{ record, pointer }],
          unverifiable: [],
          retracted: [],
        }),
        all: async () => ({
          status: "proven" as const,
          records: [{ record, pointer }],
          unverifiable: [],
          retracted: [],
        }),
        retractUnprovable: async () => ({ proven: 0, alreadyRetracted: 0, planned: [], applied: [] }),
      },
    } as YrdCliServices)

    const payload = JSON.parse(output.stdout()) as { statement?: unknown; statementUnavailable?: string }
    expect(payload.statement).toBeUndefined()
    expect(payload.statementUnavailable).toContain("R-not-in-journal")
  })
})

describe("queue run — follow-by-default mode selection (#62)", () => {
  // `queue run` with no selector and no --once IS the habitant follow-runner;
  // a single pass is explicit via a change selector or --once. The retired
  // --follow/--watch flags are rejected. The loop calls scope.sleep after each
  // cycle; a one-shot pass never sleeps — the observable mode discriminator.
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

  it("enters habitant follow mode with no selector and no --once (the default)", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    const tracked = trackedScope()
    const run = outputIO({ scope: tracked.scope })
    expect(await runYrd(app, yrd("queue", "run", "--interval", "1"), run.io), run.stderr()).toBe(3)
    // Followed: the loop slept (and was aborted) rather than exiting one-shot.
    expect(tracked.sleeps).toEqual([1_000])
  })

  it("rejects the removed --follow spelling", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    const run = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "--follow"), run.io)).toBe(2)
    expect(run.stderr()).toContain("unknown option '--follow'")
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

  it("a change selector is a single pass, not a follow loop", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    const tracked = trackedScope()
    const run = outputIO({ scope: tracked.scope })
    expect(await runYrd(app, yrd("queue", "run", "PR1"), run.io), run.stderr()).toBe(0)
    expect(tracked.sleeps).toEqual([])
    expect(run.stdout()).toContain("STATE")
  })

  it("rejects the removed --watch spelling", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    const run = outputIO()
    expect(await runYrd(app, yrd("queue", "run", "--watch"), run.io)).toBe(2)
    expect(run.stderr()).toContain("unknown option '--watch'")
  })
})

describe("submit props", () => {
  it.each(["bay", "pr"] as const)("warns and proceeds when --prop rides a derived-lane %s submit", async (surface) => {
    // The legacy record mint retired: props bound to change records, and a
    // recordless direct branch routes to the derived lane. Record-only options
    // must neither refuse the submit nor drop silently — the drop rides the
    // envelope warnings and names the cure.
    const app = await createApp()
    const output = outputIO({ resolveRevision: async () => HEAD_SHA })
    const request = "review-20925/custom 61's docs:retry 2"

    expect(
      await runYrd(
        app,
        yrd(surface, "submit", "topic/correlated", "--base", "main", "--prop", `request=${request}`, "--json"),
        output.io,
      ),
      output.stderr(),
    ).toBe(0)
    const payload = JSON.parse(output.stdout()) as Readonly<{ warnings?: readonly string[] }>
    expect(payload).toMatchObject({
      command: `${surface}.submit`,
      prs: [],
      derived: [{ lane: "derived", branch: "topic/correlated", sha: HEAD_SHA, base: "main" }],
    })
    expect((payload.warnings ?? []).join("\n")).toContain("props binds to change records")
    expect((payload.warnings ?? []).join("\n")).toContain("amend the commit on 'topic/correlated'")
    expect(app.state().bays.prs).toEqual({})
    expect(app.bays.state().submits["topic/correlated"]).toMatchObject({ sha: HEAD_SHA })
  })

  it.each(["bay", "pr"] as const)("rejects malformed props before %s submit appends", async (surface) => {
    for (const props of ["request", "=orphan-value", "request=   "]) {
      const app = await createApp()
      const before = await Array.fromAsync(app.events()).then((events) => events.length)
      const output = outputIO({ resolveRevision: async () => HEAD_SHA })

      expect(
        await runYrd(app, yrd(surface, "submit", "topic/correlated", "--prop", props, "--json"), output.io),
        output.stderr(),
      ).toBe(2)
      expect(output.stdout()).toBe("")
      expect(output.stderr()).toContain("--prop requires <key>=<value>")
      expect(await Array.fromAsync(app.events()).then((events) => events.length)).toBe(before)
      expect(app.state().bays.prs).toEqual({})
    }
  })
})

const PROJECTION_PROPS = { request: "request-20925" } as const

async function correlatedTerminalRun(terminal: "integrated" | "rejected" | "canceled") {
  const app = await createApp({ failingCheck: terminal === "rejected" })
  await app.bays.submit({
    branch: `topic/${terminal}`,
    headSha: HEAD_SHA,
    base: "main",
    props: PROJECTION_PROPS,
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

describe("prop projections", () => {
  it("keeps structured props in terminal Run, show, and log JSON", async () => {
    for (const terminal of ["integrated", "rejected", "canceled"] as const) {
      const { app, pr, run } = await correlatedTerminalRun(terminal)
      const persisted = JSON.parse(JSON.stringify(run)) as Readonly<{
        prs: readonly Readonly<Record<string, unknown>>[]
      }>

      expect
        .soft(changeDeliveryState(pr))
        .toBe(terminal === "rejected" || terminal === "canceled" ? "submitted" : terminal)
      expect.soft(persisted.prs).toEqual([expect.objectContaining({ props: PROJECTION_PROPS })])
      expect.soft(queueShowData(run).prs).toEqual([expect.objectContaining({ props: PROJECTION_PROPS })])
      expect
        .soft(await projectedLogRows(app, pr.id))
        .toEqual([expect.objectContaining({ pr: pr.id, props: PROJECTION_PROPS })])
      if (terminal === "canceled") {
        const human = await renderString(createElement(QueueShowView, { data: queueShowData(run) }), {
          width: 120,
          height: 40,
          plain: true,
        })
        expect.soft(human).toContain("NEXT")
        expect.soft(human).toContain("the change remains submitted and re-queues automatically")
        expect.soft(human).not.toContain("retry the same Yrd command")
      }
    }

    const withdrawn = await createApp()
    await withdrawn.bays.submit({
      branch: "topic/withdrawn-no-run",
      headSha: HEAD_SHA,
      base: "main",
      draft: true,
      props: PROJECTION_PROPS,
    })
    await withdrawn.bays.closePr({ pr: "PR1" })
    expect.soft(withdrawn.state().bays.prs.PR1).toMatchObject({
      state: "closed",
      merged: false,
      revs: [{ props: PROJECTION_PROPS, terminal: { kind: "withdrawn" } }],
    })
    expect.soft(withdrawn.queue.status("main").finished).toEqual([])
    expect.soft(await projectedLogRows(withdrawn)).toEqual([
      expect.objectContaining({
        run: "-",
        pr: "PR1",
        outcome: "retired",
        props: PROJECTION_PROPS,
      }),
    ])
  })

  it("omits props from uncorrelated Run, show, and log JSON", async () => {
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
  it("runs one change with only the explicitly selected merge step", async () => {
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
          status: "completed",
          conclusion: "success",
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
    await openTestBay(app, { name: "two" })
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
        status: "in_progress",
        stepSelection: {
          authority: "explicit",
          steps: ["merge"],
          omittedSteps: [{ name: "check", index: 0, status: "skipped", reason: "not-selected" }],
        },
        steps: [{ name: "merge", job: { status: "in_progress" } }],
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

function trackerBridgeV2(output: string): Readonly<{
  version: number
  asOf: Readonly<{ cursor: number; at?: string }>
  deliveries: readonly Readonly<Record<string, unknown>>[]
}> {
  const parsed = JSON.parse(output) as Readonly<Record<string, unknown>>
  const bridge = parsed.trackerBridgeV2
  if (typeof bridge !== "object" || bridge === null || !("deliveries" in bridge)) {
    throw new Error("expected a trackerBridgeV2 JSON envelope")
  }
  return bridge as ReturnType<typeof trackerBridgeV2>
}

describe("typed issue merge bridge", () => {
  it("returns one immutable issue snapshot while another runtime appends to the journal", async () => {
    const journal = createMemoryJournal()
    await using reader = await createApp({ journal })
    await using writer = await createApp({ journal, id: ids(20_000) })
    let reads = 0
    const racingReader = {
      ...reader,
      async journalSnapshot() {
        const snapshot = await reader.journalSnapshot()
        reads += 1
        await writer.bays.submit({
          branch: `topic/concurrent-issue-${reads}`,
          headSha: String(reads + 1).repeat(40),
          base: "main",
          issue: `@yrd/core/concurrent-issue-${reads}`,
        })
        return snapshot
      },
    }

    const output = outputIO()
    expect(await runYrd(racingReader, yrd("issue", "--json"), output.io), output.stderr()).toBe(0)
    expect(reads).toBe(1)
    expect(JSON.parse(output.stdout())).toMatchObject({
      command: "issue.list",
      issues: [],
      trackerBridge: { asOf: { cursor: 0 }, deliveries: [] },
      trackerBridgeV2: { asOf: { cursor: 0 }, deliveries: [] },
    })
  })

  // Record-lane test deleted with the legacy record mint (record store
  // scheduled for deletion — S7, @i/10 22991). Deleted tests:
  // - "carries a literal --issue through submit and the same later
  //   shipping-config failure in pr checks" (--issue bound to the minted
  //   direct-branch record, and `pr checks` projects records).
  it("warns that --issue binds no delivery on a derived-lane submit, and the bridge stays visibly empty", async () => {
    // 22494 fenced the bridge against silently DROPPING a submitted delivery.
    // Post-purge the inverse hazard exists: a recordless direct-branch submit
    // records no delivery at all, so the drop must be loud at submit and the
    // issue must not surface as half-tracked.
    const issueRef = "@yrd/core/22494-trackerbridge-drops-submitted-delivery"
    await using app = await createApp()
    const submitted = outputIO({ resolveRevision: async () => HEAD_SHA })

    expect(
      await runYrd(app, yrd("pr", "submit", "topic/ready-tracker-bridge", "--issue", issueRef, "--json"), submitted.io),
      submitted.stderr(),
    ).toBe(0)
    const payload = JSON.parse(submitted.stdout()) as Readonly<{ warnings?: readonly string[] }>
    expect(payload).toMatchObject({
      command: "pr.submit",
      prs: [],
      derived: [{ lane: "derived", branch: "topic/ready-tracker-bridge", sha: HEAD_SHA, base: "main" }],
    })
    expect((payload.warnings ?? []).join("\n")).toContain("issue binds to change records")
    expect(app.state().bays.prs).toEqual({})

    // No record, no delivery: the issue is not in flight, and the reader is
    // told so rather than shown an empty bridge that reads as tracked.
    const output = outputIO()
    expect(await runYrd(app, yrd("issue", "view", issueRef, "--json"), output.io)).toBe(1)
    expect(output.stderr()).toContain(`no issue '${issueRef}' is in flight`)
  })

  it("projects native PR states and fresh failed Runs from one exact journal cursor", async () => {
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
        const projectedStatus = status === "rejected" || status === "canceled" ? "submitted" : status
        expect(bridge).toMatchObject({
          version: 1,
          asOf: { cursor: expect.any(Number), at: "2026-07-09T12:00:00.000Z" },
          deliveries: [
            {
              issueRef,
              pr: "PR1",
              revision: 1,
              headSha: HEAD_SHA,
              status: projectedStatus,
              at: "2026-07-09T12:00:00.000Z",
              runs: status === "rejected" || status === "integrated" || status === "canceled" ? ["R1"] : [],
            },
          ],
        })
        const delivery = bridge.deliveries[0]
        if (status === "integrated") expect(delivery).toMatchObject({ landingSha: MERGED_SHA })
        else expect(delivery).not.toHaveProperty("landingSha")
        if (status === "rejected") expect(delivery).not.toHaveProperty("bounce")

        const human = outputIO()
        expect(await runYrd(app, yrd("issue", "view", issueRef), human.io), human.stderr()).toBe(0)
        expect(human.stdout()).toContain(issueRef)
        expect(human.stdout()).toContain("DELIVERIES")
        expect(human.stdout()).toContain(`PR1 rev1 ${projectedStatus}`)
        expect(human.stdout()).toContain(`HEAD ${HEAD_SHA}`)
        if (status === "integrated") expect(human.stdout()).toContain(MERGED_SHA)
        if (status === "rejected") expect(human.stdout()).not.toContain("BOUNCE")
      } finally {
        await app.close()
      }
    }
  })

  it("preserves already-landed equivalence evidence in both tracker bridge versions", async () => {
    const issueRef = "@yrd/22207-noop-merge-dedup-at-admission"
    const equivalentTreeSha = "b".repeat(40)
    await using app = await createApp({
      mergeCommits: [BASE_SHA],
      mergeAlreadyLanded: {
        candidateSha: HEAD_SHA,
        candidateTreeSha: equivalentTreeSha,
        baseTreeSha: equivalentTreeSha,
      },
    })
    await app.bays.submit({
      branch: "topic/already-landed-bridge",
      headSha: HEAD_SHA,
      base: "main",
      issue: issueRef,
    })
    const [run] = await app.queue.run({ prs: ["PR1"] }, { runner: "cli-test", leaseMs: 60_000 })
    if (run === undefined) throw new Error("expected an already-landed Queue run")

    const mergedPr = app.bays.pr("PR1")
    expect(mergedPr).toMatchObject({
      state: "closed",
      merged: true,
      integration: { commit: BASE_SHA, baseSha: BASE_SHA },
      alreadyLanded: {
        candidateSha: HEAD_SHA,
        candidateTreeSha: equivalentTreeSha,
        baseTreeSha: equivalentTreeSha,
      },
    })
    if (mergedPr === undefined) throw new Error("expected the already-landed PR")
    expect(changeDeliveryState(mergedPr)).toBe("already-landed")
    expect(
      humanQueueProjection(
        {
          base: "main",
          prs: [...app.bays.prs()],
          admissionOrder: [],
          running: [],
          waiting: [],
          finished: [run],
        },
        Date.parse("2026-07-09T12:01:00.000Z"),
        { state: app.state().bays },
      ),
    ).toMatchObject({ integrated: 0, alreadyMerged: 1 })

    const output = outputIO()
    expect(await runYrd(app, yrd("issue", "view", issueRef, "--json"), output.io), output.stderr()).toBe(0)
    const expectedDelivery = {
      issueRef,
      pr: "PR1",
      revision: 1,
      headSha: HEAD_SHA,
      status: "already-landed",
      runs: ["R1"],
      baseSha: BASE_SHA,
      candidateSha: HEAD_SHA,
      candidateTreeSha: equivalentTreeSha,
      baseTreeSha: equivalentTreeSha,
    }
    expect(trackerBridge(output.stdout())).toMatchObject({ version: 1, deliveries: [expectedDelivery] })
    expect(trackerBridgeV2(output.stdout())).toMatchObject({ version: 2, deliveries: [expectedDelivery] })

    const human = outputIO()
    expect(await runYrd(app, yrd("issue", "view", issueRef), human.io), human.stderr()).toBe(0)
    expect(human.stdout()).toContain("PR1 rev1 already-landed")
    expect(human.stdout()).toContain(`ALREADY MERGED ${HEAD_SHA} TREE ${equivalentTreeSha} = BASE`)
    expect(human.stdout()).toContain(`${BASE_SHA} TREE ${equivalentTreeSha}`)
  })

  it("adds needs-author with its attributed result in trackerBridge v2 and degrades it explicitly in v1", async () => {
    const issueRef = "@yrd/core/21634-submit-and-stay"
    const failure = "submitted composition cannot be built"
    await using app = await createApp({
      checkFailure: { code: "composition-retired", message: failure },
    })
    await app.bays.submit({
      branch: "topic/needs-author-bridge",
      headSha: HEAD_SHA,
      base: "main",
      issue: issueRef,
    })
    await app.queue.run({ prs: ["PR1"] }, { runner: "cli-test", leaseMs: 60_000 })

    const output = outputIO()
    expect(await runYrd(app, yrd("issue", "view", issueRef, "--json"), output.io), output.stderr()).toBe(0)
    const v1 = trackerBridge(output.stdout())
    const v2 = trackerBridgeV2(output.stdout())
    expect(JSON.parse(output.stdout())).toMatchObject({
      command: "issue.view",
      issues: [{ issue: issueRef, outcome: "needs-author" }],
    })

    expect(v2).toMatchObject({
      version: 2,
      asOf: v1.asOf,
      deliveries: [
        {
          issueRef,
          pr: "PR1",
          revision: 1,
          headSha: HEAD_SHA,
          status: "needs-author",
          runs: ["R1"],
          bounce: { run: "R1", detail: failure },
          attributedResult: { code: "composition-retired", message: failure },
        },
      ],
    })
    expect(v1).toMatchObject({
      version: 1,
      asOf: v2.asOf,
      deliveries: [
        {
          issueRef,
          pr: "PR1",
          revision: 1,
          headSha: HEAD_SHA,
          status: "rejected",
          runs: ["R1"],
          bounce: { run: "R1", detail: failure },
        },
      ],
    })
    expect(v1.deliveries[0]).not.toHaveProperty("attributedResult")

    let snapshotEligibilityReads = 0
    const snapshotQueue = {
      ...app.queue,
      eligibility(selector: string, snapshot?: unknown) {
        if (snapshot === undefined) throw new Error("live eligibility read during journal snapshot projection")
        snapshotEligibilityReads += 1
        const read = app.queue.eligibility as (selected: string, state?: unknown) => ChangeEligibility
        return read(selector, snapshot)
      },
    }
    const snapshotApp = { ...app, queue: snapshotQueue } as typeof app
    const concurrent = outputIO()
    expect(
      await runYrd(snapshotApp, yrd("issue", "view", issueRef, "--json"), concurrent.io),
      concurrent.stderr(),
    ).toBe(0)
    expect(trackerBridgeV2(concurrent.stdout())).toEqual(v2)
    expect(snapshotEligibilityReads).toBeGreaterThan(0)

    const runs = outputIO()
    expect(await runYrd(app, yrd("pr", "runs", "PR1", "--json"), runs.io), runs.stderr()).toBe(0)
    expect(trackerBridgeV2(runs.stdout())).toEqual(v2)
    const runsProjection = JSON.parse(runs.stdout()) as Readonly<{ pr: unknown }>
    expect(runsProjection).toMatchObject({
      command: "pr.runs",
      pr: { id: "PR1", status: "needs-author" },
      eligibility: {
        reason: {
          code: "needs-author",
          result: { code: "composition-retired", message: failure },
        },
      },
    })
    expect(runsProjection.pr).not.toHaveProperty("nativeStatus")

    const human = outputIO()
    expect(await runYrd(app, yrd("issue", "view", issueRef), human.io), human.stderr()).toBe(0)
    expect(human.stdout()).toContain("PR1 rev1 needs-author")
    expect(human.stdout()).toContain("OUTCOME needs-author")
    expect(human.stdout()).toContain("ATTRIBUTED composition-retired")
    expect(human.stdout()).toContain(failure)

    const humanRuns = outputIO()
    expect(await runYrd(app, yrd("pr", "runs", "PR1"), humanRuns.io), humanRuns.stderr()).toBe(0)
    expect(humanRuns.stdout()).toContain("STATUS needs-author")
    expect(humanRuns.stdout()).toContain("ATTRIBUTED composition-retired")
    expect(humanRuns.stdout()).toContain("NEXT fix the branch and push; the same PR resumes automatically")

    const dashboard = outputIO({
      columns: 120,
      resolveQueueTarget: async () => ({ base: "main", sha: BASE_SHA }),
    })
    expect(await runYrd(app, yrd(), dashboard.io), dashboard.stderr()).toBe(0)
    expect(dashboard.stdout()).toContain("REJECTED 0 NEEDS-AUTHOR 1")
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
    expect(output.stderr()).toContain("cannot project rejected change 'PR1' without a typed Queue bounce run")
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
    expect({ snapshots, advances }).toEqual({ snapshots: 9, advances: 5 })
    expect(exhausted.stdout()).toBe("")
    expect(JSON.parse(exhausted.stderr())).toEqual({
      failure: {
        kind: "refusal",
        code: "request-refused",
        message: "journal changed while reading change 'PR1' runs; retry with 'yrd pr runs PR1 --json'",
        cause: "journal changed while reading change 'PR1' runs",
        resolution: ["yrd pr runs PR1 --json"],
      },
    })
  })
})

describe("journal version skew fail-loud", () => {
  // Simulates a journal written by a NEWER yrd: rows stay storage-valid but
  // carry fields this build's domain schemas do not recognize.
  const newerWriterFields = Object.freeze({
    forwardCompatProbe: "vNext",
    mergeRecord: "9".repeat(40),
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
    const history = database
      .query<{ cursor: number; value_json: string }, []>(
        "SELECT cursor, value_json FROM journal_history ORDER BY cursor",
      )
      .all()
      .map(({ cursor, value_json }) => ({ cursor, row: JSON.parse(value_json) as StoredJournalRow }))
    const tail = database
      .query<{ cursor: number; value_json: string }, []>(
        "SELECT cursor, value_json FROM journal_events ORDER BY cursor",
      )
      .all()
      .map(({ cursor, value_json }) => ({ cursor, row: JSON.parse(value_json) as StoredJournalRow }))
    return [...prefix.map(({ cursor, value }) => ({ cursor, row: value })), ...history, ...tail].sort(
      (left, right) => left.cursor - right.cursor,
    )
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
      database.exec("DELETE FROM journal_history")
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
      safeRemoveSync(dir, { within: tmpdir(), allowMissing: true })
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
      expect(stderr).toContain("mergeRecord")
      expect(stderr).toContain(`${YRD_VERSION}+`)
      expect(stderr).not.toContain("resolve:")
      expect(stderr).not.toContain("-v")
      expect(stderr).not.toContain("unrecognized_keys")
      expect(stderr).not.toContain("invalid_union")

      const json = outputIO()
      expect(await runInternals.runYrdProcessRuntime(yrd("pr", "list", "--json"), json.io, journalBootstrap(dir))).toBe(
        3,
      )
      expect(JSON.parse(json.stderr())).toMatchObject({
        failure: {
          resolution: expect.arrayContaining(["Re-run with -v to include the raw validation detail."]),
        },
      })
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
  // The habitant follow-runner (`queue run`, follow-by-default) is a background
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
    expect(await runYrd(app, yrd("queue", "run"), runHuman.io), runHuman.stderr()).toBe(3)
    expect(runHuman.stdout()).not.toContain("STATE")
    expect(runHuman.stdout()).not.toContain("STEPS")
  })

  it("still streams the run record in follow mode --json", async () => {
    const app = await createApp()
    await openAndSubmit(app)
    const runJson = outputIO({ scope: onePassScope() })
    expect(await runYrd(app, yrd("queue", "run", "--json"), runJson.io), runJson.stderr()).toBe(3)
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

  // Record-lane tests deleted with the legacy record mint: a direct-branch
  // submit mints no record, so there is no record to carry title/description/
  // issue metadata and no record for pr edit / pr list / pr view to project.
  // The record store itself is scheduled for deletion (S7, @i/10 22991).
  // Deleted tests:
  // - "defaults the change title and description from the head commit subject
  //   and body at submit" and "lets explicit --title and --description
  //   override the commit defaults" (their derived-lane successor is the
  //   forwarding test below),
  // - "appends an issue reference to the default description when --issue is
  //   given",
  // - "edits the title and description of a live change via pr edit",
  // - "prefers the change title over the branch in the pr list SUBJECT column
  //   and JSON",
  // - "shows TITLE, ISSUE, and DESCRIPTION rows in pr view",
  // - "separates the live branch head from the frozen revision in pr view",
  // - "fails loudly when human pr view cannot observe the live branch".
  it("forwards no commit-derived metadata to the derived lane, and warns only for explicit flags", async () => {
    // Commit-derived defaults exist to bind onto a record; on the derived
    // lane the head commit itself is the metadata, so a plain submit stays
    // warning-free rather than telling every author to amend a commit with
    // the title that was read from it. Explicit flags still travel — they
    // have nowhere to bind, and that drop is loud and names the cure.
    const app = await createApp()
    const submit = commitMetaIO("feat(bay): pr metadata", "Adds a durable title and description to the change record.")
    expect(await runYrd(app, yrd("pr", "submit", "topic/defaults", "--base", "main"), submit.io)).toBe(0)
    expect(app.bays.pr("topic/defaults")).toBeUndefined()
    expect(app.bays.state().submits["topic/defaults"]).toMatchObject({ sha: HEAD_SHA, base: "main" })
    expect(submit.stderr()).toContain("submitted to the derived lane: topic/defaults")
    expect(submit.stderr()).not.toContain("bind to change records")
    expect(submit.stderr()).not.toContain("binds to change records")

    const explicit = commitMetaIO("feat(bay): pr metadata", "Commit body.")
    expect(
      await runYrd(
        app,
        yrd(
          "pr",
          "submit",
          "topic/defaults",
          "--base",
          "main",
          "--title",
          "Explicit subject text",
          "--description",
          "Explicit description body.",
        ),
        explicit.io,
      ),
    ).toBe(0)
    expect(explicit.stderr()).toContain("title/description bind to change records")
    expect(explicit.stderr()).toContain("amend the commit on 'topic/defaults'")
    expect(explicit.stderr()).toContain("submitted to the derived lane: topic/defaults")
  })

  function metadataPr(overrides: Partial<Change> = {}): Change {
    return {
      id: "PR1",
      branch: "topic/metadata",
      base: "main",
      state: "open",
      merged: false,
      title: "feat(detail): pr metadata",
      description: "First row of the description.\n\nIssue: https://example.test/issues/9",
      issue: "https://example.test/issues/9",
      revs: [submittedRevision(1, HEAD_SHA, "2026-07-09T12:00:00.000Z")],
      reviews: [],
      comments: [],
      checkRequests: [],
      ...overrides,
    }
  }

  it("renders title, an OSC 8 issue hyperlink, and the description in the change detail view", async () => {
    const rendered = await renderString(
      createElement(ChangeDetailView, { pr: metadataPr(), runs: [], now: Date.parse("2026-07-09T12:10:00.000Z") }),
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
})

describe("watch viewer — frozen projection under a live clock (task #64)", () => {
  const focusedPR = {
    id: "PR1",
    branch: "topic/one",
    base: "main",
    state: "open",
    merged: false,
    revs: [submittedRevision(1, HEAD_SHA, "2026-07-09T12:00:00.000Z")],
    reviews: [],
    comments: [],
    checkRequests: [],
  } satisfies Change

  it("fails loudly when a hot queue command lacks the queue attempt read capability", async () => {
    const app = await createApp()
    try {
      const output = outputIO()

      expect(await runYrdRaw(app, yrd("queue", "list", "--json"), output.io, {})).toBe(3)
      expect(output.stderr()).toContain("missing required YrdCliServices.queueReadModel.snapshot capability")
      expect(output.stderr()).toContain("createYrdHost")
    } finally {
      await app.close()
    }
  })

  it("keeps literal one-shot queue reads fork-free", async () => {
    const repo = mkdtempSync(join(tmpdir(), "yrd-queue-read-forks-"))
    const bin = join(repo, "bin")
    const log = join(repo, "git.log")
    mkdirSync(bin)
    writeFileSync(log, "")
    execFileSync("git", ["init", "-q", repo])
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-qm", "base"])
    const baseSha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()

    const originalPath = process.env.PATH ?? ""
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nPATH=${JSON.stringify(originalPath)} exec git "$@"\n`,
    )
    chmodSync(join(bin, "git"), 0o755)

    const app = await createApp()
    try {
      await openAndSubmit(app)
      process.env.PATH = `${bin}:${originalPath}`
      const resolveQueueTarget = async (ref: string) => ({
        base: ref,
        sha: baseSha,
      })
      const services = { queueReadModel: testQueueReadModel(app) }

      for (const argv of [yrd("queue", "list", "--json"), yrd("--json")]) {
        const output = outputIO({ cwd: repo, stateDir: join(repo, ".git", "yrd"), resolveQueueTarget })
        expect(await runYrd(app, argv, output.io, services), output.stderr()).toBe(0)
      }

      expect(readFileSync(log, "utf8").trim().split("\n").filter(Boolean)).toEqual([])
    } finally {
      process.env.PATH = originalPath
      await app.close()
      safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
    }
  })

  it("keeps an unchanged watch snapshot stable between coarse clock pulses", async () => {
    const app = await createApp()
    try {
      await openAndSubmit(app)
      let now = Date.parse("2026-07-09T12:01:00.000Z")
      let targetResolutions = 0
      let mounted: ReactElement | undefined
      const output = outputIO({
        now: () => now,
        resolveQueueTarget: async () => {
          targetResolutions += 1
          return { base: "main", sha: BASE_SHA }
        },
      })
      const attempts: readonly QueueAttempt[] = Object.freeze([])
      const cursor = (await app.journalSnapshot()).asOf.cursor
      const journalSnapshot = vi.fn(app.journalSnapshot.bind(app))
      const viewer = { ...app, journalSnapshot } as TestApp
      const services = {
        queueReadModel: { snapshot: async () => ({ cursor, generation: 1, attempts }) },
      }
      const live = withLiveRenderer(output.io, async (element) => {
        mounted = element
      })

      expect(await runYrd(viewer, yrd("queue", "list", "--watch"), live, services), output.stderr()).toBe(0)
      if (mounted === undefined) throw new Error("expected queue watch pane to mount")
      const { initial, load } = mounted.props as QueueWatchPaneProps
      expect(targetResolutions).toBe(1)
      expect(journalSnapshot).toHaveBeenCalledTimes(1)

      now += 1_000
      const tick = await load()

      expect(targetResolutions, "an unchanged tick must not resolve the queue target again").toBe(1)
      expect(journalSnapshot, "an unchanged durable cursor must not fold the Journal again").toHaveBeenCalledTimes(1)
      expect(tick, "idle polling must not schedule a React render").toBe(initial)

      now += 59_000
      const clockPulse = await load()

      expect(clockPulse).not.toBe(initial)
      expect(clockPulse.results).toBe(initial.results)
      expect(clockPulse.projection?.details).toBe(initial.projection?.details)
      expect(clockPulse.projection?.timeStatsFacts).toBe(initial.projection?.timeStatsFacts)
      expect(clockPulse.projection?.rows.map((row) => row.id)).toEqual(initial.projection?.rows.map((row) => row.id))
      expect(clockPulse.projection?.rows[0]?.ageMs).toBe((initial.projection?.rows[0]?.ageMs ?? 0) + 60_000)
      expect(clockPulse.now).toBe(now)
      expect(clockPulse.projection?.now).toBe(new Date(now).toISOString())

      const focus = { pr: "PR1", revision: 1 }
      const focused = await load(focus)
      now += 1_000
      const focusedTick = await load(focus)
      expect(focusedTick, "idle detail polling must not reload or repaint the selected row").toBe(focused)
    } finally {
      await app.close()
    }
  })

  it("rebuilds on Journal cursor changes and reports clock-only cache hits in queue-read spans", async () => {
    const journal = createMemoryJournal()
    const logs: LoggerEvent[] = []
    const runner = await createApp({ journal })
    const viewer = await createApp({
      journal,
      log: createLogger("yrd", [{ level: "trace" }, { write: (event: LoggerEvent) => logs.push(event) }]),
    })
    let now = Date.parse("2026-07-09T12:01:00.000Z")
    let targetResolutions = 0
    const loader = runInternals.createQueueListSnapshotLoader(
      viewer,
      [],
      {},
      outputIO({
        now: () => now,
        resolveQueueTarget: async () => {
          targetResolutions += 1
          return { base: "main", sha: BASE_SHA }
        },
      }).io,
      { queueReadModel: testQueueReadModel(viewer) },
      false,
    )
    try {
      const empty = await loader.load()
      expect(empty.results.flatMap((result) => result.prs)).toEqual([])
      expect(targetResolutions).toBe(1)

      await openAndSubmit(runner)
      const changed = await loader.load()
      expect(changed.results.flatMap((result) => result.prs.map((pr) => pr.id))).toContain("PR1")
      expect(targetResolutions, "a new Journal cursor must rebuild the durable projection").toBe(2)

      now += 60_000
      const reclocked = await loader.load()
      expect(targetResolutions, "an unchanged cursor must reuse the durable projection").toBe(2)
      expect(reclocked.results).toBe(changed.results)
      expect(reclocked.projection.timeStatsFacts).toBe(changed.projection.timeStatsFacts)

      const spans = logs.filter(
        (event): event is Extract<LoggerEvent, { kind: "span" }> =>
          event.kind === "span" && event.namespace === "yrd:queue-read:snapshot",
      )
      expect(spans.map(({ props }) => props)).toEqual([
        expect.objectContaining({ cursor: 0, projection: "rebuilt", attempts: "changed" }),
        expect.objectContaining({ cursor: expect.any(Number), projection: "rebuilt", attempts: "changed" }),
        expect.objectContaining({ cursor: expect.any(Number), projection: "clock-only", attempts: "memory" }),
      ])
      expect(spans[1]?.props?.cursor).toBe(spans[2]?.props?.cursor)
      expect(spans[2]?.props).toMatchObject({
        generation: 0,
        state: "memory",
        runner: "unchanged",
        results: changed.results.length,
        rows: changed.projection.rows.length,
        timeStatsFacts: changed.projection.timeStatsFacts.length,
      })
    } finally {
      await Promise.all([runner.close(), viewer.close()])
    }
  })

  it("retries an append race and returns a named partial instead of throwing when the boundary keeps moving", async () => {
    const app = await createApp()
    const attempts: readonly QueueAttempt[] = Object.freeze([])
    try {
      const staleCursor = (await app.journalSnapshot()).asOf.cursor
      await openAndSubmit(app)
      const currentCursor = (await app.journalSnapshot()).asOf.cursor
      let reads = 0
      const racing = runInternals.createQueueListSnapshotLoader(
        app,
        [],
        {},
        outputIO().io,
        {
          queueReadModel: {
            snapshot: async () => ({
              cursor: reads++ === 0 ? staleCursor : currentCursor,
              generation: 0,
              attempts,
            }),
          },
        },
        false,
      )

      const recovered = await racing.load()
      expect(reads, "the read boundary must resample both moving inputs").toBe(2)
      expect(recovered.results.flatMap((result) => result.prs.map((pr) => pr.id))).toContain("PR1")
      expect(recovered).not.toHaveProperty("readFailure")

      let keepMoving = false
      const retaining = runInternals.createQueueListSnapshotLoader(
        app,
        [],
        {},
        outputIO().io,
        {
          queueReadModel: {
            snapshot: async () => ({ cursor: keepMoving ? staleCursor : currentCursor, generation: 0, attempts }),
          },
        },
        false,
      )
      const complete = await retaining.load()
      keepMoving = true
      const retained = await retaining.load()
      expect(retained.results, "a failed refresh keeps the last complete durable projection").toBe(complete.results)
      expect(retained).toMatchObject({
        readFailure: {
          code: "queue-read-boundary-moved",
          showing: "last-complete",
        },
      })

      const staleReadModel = {
        snapshot: async () => ({ cursor: staleCursor, generation: 0, attempts }),
      }
      const exhausted = runInternals.createQueueListSnapshotLoader(
        app,
        [],
        {},
        outputIO().io,
        {
          queueReadModel: staleReadModel,
        },
        false,
      )
      await expect(exhausted.load()).resolves.toMatchObject({
        readFailure: {
          code: "queue-read-boundary-moved",
          readCursor: staleCursor,
          journalCursor: currentCursor,
          showing: "bounded-partial",
        },
      })

      const output = outputIO()
      expect(
        await runYrd(app, yrd("queue", "list", "--json"), output.io, { queueReadModel: staleReadModel }),
        output.stderr(),
      ).toBe(0)
      expect(JSON.parse(output.stdout())).toMatchObject({
        command: "queue.list",
        readFailure: {
          code: "queue-read-boundary-moved",
          showing: "bounded-partial",
        },
      })
    } finally {
      await app.close()
    }
  })

  it("coalesces habitant heartbeats until a clock pulse but rebuilds on runner identity changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-watch-runner-token-"))
    const stateDir = join(root, "yrd")
    const statusPath = join(stateDir, "resident-runner", "status.json")
    mkdirSync(join(statusPath, ".."), { recursive: true })
    const app = await createApp()
    const attempts: readonly QueueAttempt[] = Object.freeze([])
    let targetResolutions = 0
    let now = Date.parse("2026-07-09T12:01:00.000Z")
    const runner = {
      pid: process.pid,
      startedAt: "2026-07-09T12:00:00.000Z",
      lastTickAt: "2026-07-09T12:00:58.000Z",
      implementationSource: `git:${"1".repeat(40)}`,
      queueProgress: { state: "healthy" as const, observedAt: "2026-07-09T12:00:58.000Z" },
      driver: {
        queueId: `${root}#main`,
        epoch: "11111111-1111-4111-8111-111111111111",
        lastMerged: null,
      },
    }
    const writeRunner = (lastTickAt: string) => writeFileSync(statusPath, JSON.stringify({ ...runner, lastTickAt }))
    writeRunner(runner.lastTickAt)
    try {
      await openAndSubmit(app)
      const loader = runInternals.createQueueListSnapshotLoader(
        app,
        [],
        {},
        outputIO({
          stateDir,
          now: () => now,
          resolveQueueTarget: async () => {
            targetResolutions += 1
            return { base: "main", sha: BASE_SHA }
          },
        }).io,
        {
          queueReadModel: {
            snapshot: async () => ({
              cursor: (await app.journalSnapshot()).asOf.cursor,
              generation: 0,
              attempts,
            }),
          },
        },
        false,
      )

      const first = await loader.load()
      now += 1_000
      const stable = await loader.load()
      expect(targetResolutions).toBe(1)
      expect(stable).toBe(first)

      writeRunner("2026-07-09T12:00:59.000Z")
      const heartbeat = await loader.load()
      expect(targetResolutions, "a heartbeat alone must not rebuild durable queue facts").toBe(1)
      expect(heartbeat).toBe(first)

      const stalledProgress = {
        state: "stalled" as const,
        observedAt: "2026-07-09T12:00:59.000Z",
        findings: [
          {
            code: "admission-refusal-loop",
            message: "PR1 is blocked",
            pr: "PR1",
            refusal: "recut-gitlink-conflict",
            count: 1,
            since: "2026-07-09T12:00:00.000Z",
            blockedMs: 0,
          },
        ],
      }
      writeFileSync(
        statusPath,
        JSON.stringify({ ...runner, lastTickAt: "2026-07-09T12:00:59.000Z", queueProgress: stalledProgress }),
      )
      const stalled = await loader.load()
      expect(targetResolutions, "progress changes must reuse durable queue facts").toBe(1)
      expect(stalled.results).toBe(first.results)
      expect(stalled.projection.runner?.queueProgress).toEqual(stalledProgress)

      const retriedProgress = {
        ...stalledProgress,
        findings: [{ ...stalledProgress.findings[0], count: 2, blockedMs: 1_000 }],
      }
      writeFileSync(
        statusPath,
        JSON.stringify({ ...runner, lastTickAt: "2026-07-09T12:00:59.000Z", queueProgress: retriedProgress }),
      )
      const retried = await loader.load()
      expect(targetResolutions, "refusal detail changes must reuse durable queue facts").toBe(1)
      expect(retried.results).toBe(first.results)
      expect(retried.projection.runner?.queueProgress).toEqual(retriedProgress)

      const successorEpoch = "22222222-2222-4222-8222-222222222222"
      writeFileSync(
        statusPath,
        JSON.stringify({
          ...runner,
          lastTickAt: "2026-07-09T12:00:59.000Z",
          driver: { ...runner.driver, epoch: successorEpoch },
        }),
      )
      const successor = await loader.load()
      expect(targetResolutions, "driver epoch changes must reuse durable queue facts").toBe(1)
      expect(successor.results).toBe(first.results)
      expect(successor.projection.runner?.driver?.epoch).toBe(successorEpoch)

      now += 60_000
      const reclocked = await loader.load()
      expect(targetResolutions).toBe(1)
      expect(reclocked).not.toBe(successor)
      expect(reclocked.results).toBe(first.results)
      expect(reclocked.projection.now).toBe(new Date(now).toISOString())
      expect(reclocked.projection.runner?.lastTickAt).toBe("2026-07-09T12:00:59.000Z")

      writeFileSync(statusPath, JSON.stringify({ ...runner, command: "yrd queue run" }))
      const replaced = await loader.load()
      expect(targetResolutions, "runner identity changes must invalidate immediately").toBe(2)
      expect(replaced.results).not.toBe(reclocked.results)
    } finally {
      await app.close()
      safeRemoveSync(root, { within: tmpdir(), allowMissing: true })
    }
  })

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
    const resolver = runInternals.createQueueChangeDiffResolver({
      runGit: (cwd, args) => runInternals.runQueueGit(process, cwd, args),
    })
    await expect(resolver.resolve("/repo", focusedPR, 1, 1_000)).rejects.toThrow(
      "yrd: git cat-file -e aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa^{commit} timed out after 30000ms",
    )
    await expect(resolver.resolve("/repo", focusedPR, 1, 2_000)).rejects.toThrow("timed out after 30000ms")
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
      writeFileSync(outputPath, "must stay unread for a change-only row\n")

      const snapshot = await runInternals.queueListSnapshot(app, [], {}, outputIO({ artifactRoot }).io, {
        includeOutputs: true,
        focus: { pr: "PR1", revision: 1 },
        queueReadModel: testQueueReadModel(app),
      })
      expect(snapshot.outputs).toBeUndefined()
    } finally {
      await app.close()
      safeRemoveSync(artifactRoot, { within: tmpdir(), allowMissing: true })
    }
  })

  it("scopes a change-focused watch snapshot before projecting older terminal runs", async () => {
    const app = await createApp({ batch: 2 })
    try {
      await openAndSubmit(app)

      const open = outputIO()
      expect(await runYrd(app, yrd("bay", "open", "two"), open.io)).toBe(0)
      const submit = outputIO({ cwd: "/repo/.bays/B2" })
      expect(await runYrd(app, yrd("bay", "submit"), submit.io)).toBe(0)
      await app.queue.run({ prs: ["PR1", "PR2"] }, { runner: "test", leaseMs: 60_000 })

      const snapshot = await runInternals.queueListSnapshot(app, [], { pr: "PR2" }, outputIO().io, {
        queueReadModel: testQueueReadModel(app),
      })
      expect(new Set(snapshot.projection.rows.map((row) => row.pr))).toEqual(new Set(["PR2"]))
    } finally {
      await app.close()
    }
  })

  it("resolves and permanently caches one async diff for an immutable focused revision", async () => {
    const calls: string[][] = []
    const resolver = runInternals.createQueueChangeDiffResolver({
      runGit: async (_cwd, args) => {
        calls.push([...args])
        if (args.includes("--numstat")) return "3\t2\tsrc/watch.ts\0-\t-\tfixture.bin\0"
        if (args[0] === "diff") return "focused patch\n"
        return ""
      },
    })
    await expect(resolver.resolve("/repo", focusedPR, 1, 1_000)).resolves.toEqual({
      pr: "PR1",
      revision: 1,
      additions: 3,
      deletions: 2,
      files: ["src/watch.ts", "fixture.bin"],
      patch: "focused patch\n",
    })
    expect(calls).toHaveLength(5)
    await resolver.resolve("/repo", focusedPR, 1, 60_000)
    expect(calls).toHaveLength(5)
  })

  it("bounds the diff cache instead of retaining every revision for the life of the process", async () => {
    // @yrd/cli/22258: the watch pane is long-lived, and this cache was written but
    // never evicted or capped, pinning a FULL git patch per (PR, revision) forever.
    // Measured on a live pane at 11h uptime: ~1 GB RSS against 149 MB for a fresh
    // process on identical inputs, burning 17-22.7% CPU with zero journal events —
    // retention is the defect and the CPU is its GC signature. The cap is what makes
    // that fail in milliseconds here instead of after hours of uptime.
    const calls: string[][] = []
    const resolver = runInternals.createQueueChangeDiffResolver({
      maxEntries: 3,
      runGit: async (_cwd, args) => {
        calls.push([...args])
        if (args.includes("--numstat")) return "1\t0\tsrc/a.ts\0"
        if (args[0] === "diff") return "patch\n"
        return ""
      },
    })
    // Four revisions with distinct heads, so each yields a distinct cache key.
    const multiPR = {
      ...focusedPR,
      revs: [1, 2, 3, 4].map((n) => submittedRevision(n, String(n).repeat(40), "2026-07-09T12:00:00.000Z")),
    } satisfies Change

    // Fill past the cap of three.
    for (const revision of [1, 2, 3, 4]) await resolver.resolve("/repo", multiPR, revision, 1_000)
    const afterFill = calls.length
    expect(afterFill, "each distinct revision must actually reach git, or this proves nothing").toBeGreaterThan(4)

    // The newest key must still be served from cache...
    await resolver.resolve("/repo", multiPR, 4, 2_000)
    expect(calls.length, "the most recent revision must stay cached").toBe(afterFill)

    // ...and the oldest must have been evicted rather than retained forever.
    await resolver.resolve("/repo", multiPR, 1, 3_000)
    expect(calls.length, "the oldest revision must be evicted once the cap is exceeded").toBeGreaterThan(afterFill)
  })

  it("holds the diff cache at its cap across many distinct (PR, revision) keys", async () => {
    // @yrd/cli/22258 acceptance. The test above proves eviction happens at the
    // boundary with one key more than the cap; it cannot distinguish "retains
    // exactly the cap" from "retains the cap plus a slow leak", which is the
    // shape the defect actually had — a pane walking hundreds of (PR, revision)
    // pairs over its lifetime. Resolving every key and classifying each as a
    // git hit or miss pins the retained set to EXACTLY the cap: the newest
    // `CAP` keys are all hits (at least the cap is kept) and every older key
    // misses (at most the cap is kept).
    const CAP = 8
    const CHANGE_COUNT = 10
    const REVS_PER_CHANGE = 5
    const calls: string[][] = []
    const resolver = runInternals.createQueueChangeDiffResolver({
      maxEntries: CAP,
      runGit: async (_cwd, args) => {
        calls.push([...args])
        if (args.includes("--numstat")) return "1\t0\tsrc/a.ts\0"
        if (args[0] === "diff") return "patch\n"
        return ""
      },
    })
    // Ten PRs of five revisions each: 50 distinct keys, every head distinct so
    // no two collapse onto one cache entry.
    const prs = Array.from({ length: CHANGE_COUNT }, (_pr, changeIndex) => {
      return {
        ...focusedPR,
        id: `PR${String(changeIndex + 1)}`,
        revs: Array.from({ length: REVS_PER_CHANGE }, (_rev, revIndex) =>
          submittedRevision(
            revIndex + 1,
            String(changeIndex * REVS_PER_CHANGE + revIndex + 1).padStart(40, "0"),
            "2026-07-09T12:00:00.000Z",
          ),
        ),
      } satisfies Change
    })
    const keys = prs.flatMap((pr) => pr.revs.map((rev) => ({ pr, revision: rev.n })))
    expect(keys, "the fill must exceed the cap by enough to expose a slow leak").toHaveLength(
      CHANGE_COUNT * REVS_PER_CHANGE,
    )

    /** Whether this resolve reached git — a cache miss — rather than being served. */
    const missed = async (key: (typeof keys)[number], now: number): Promise<boolean> => {
      const before = calls.length
      await resolver.resolve("/repo", key.pr, key.revision, now)
      return calls.length > before
    }

    for (const [index, key] of keys.entries()) {
      expect(
        await missed(key, 1_000),
        `key ${String(index)} must reach git while filling, or this proves nothing`,
      ).toBe(true)
    }

    for (const [index, key] of keys.slice(-CAP).entries()) {
      expect(
        await missed(key, 2_000),
        `the newest ${String(CAP)} keys must stay cached (offset ${String(index)})`,
      ).toBe(false)
    }

    for (const [index, key] of keys.slice(0, keys.length - CAP).entries()) {
      expect(await missed(key, 3_000), `key ${String(index)} must have been evicted, not retained`).toBe(true)
    }
  })

  it("negative-caches a missing focused diff until its retry window expires", async () => {
    const calls: string[][] = []
    const resolver = runInternals.createQueueChangeDiffResolver({
      negativeTtlMs: 30_000,
      runGit: async (_cwd, args) => {
        calls.push([...args])
        if (args[0] === "rev-parse") return ".git\n"
        throw new Error("missing object")
      },
    })
    await expect(resolver.resolve("/repo", focusedPR, 1, 1_000)).resolves.toMatchObject({ unavailable: "refs-pruned" })
    await expect(resolver.resolve("/repo", focusedPR, 1, 30_999)).resolves.toMatchObject({
      unavailable: "refs-pruned",
    })
    expect(calls).toHaveLength(2)

    await expect(resolver.resolve("/repo", focusedPR, 1, 31_000)).resolves.toMatchObject({ unavailable: "refs-pruned" })
    expect(calls).toHaveLength(4)
  })

  it("projects configured step commands into human watch snapshots", async () => {
    const repo = mkdtempSync(join(tmpdir(), "yrd-watch-commands-"))
    writeFileSync(join(repo, ".yrd.yml"), 'checks: [{check: {run: "bun vitest run"}}]\n')
    const app = await createApp()
    try {
      const snapshot = await runInternals.queueListSnapshot(app, [], {}, outputIO({ cwd: repo }).io, {
        includeOutputs: true,
        queueReadModel: testQueueReadModel(app),
      })
      expect(snapshot.commands).toEqual({ check: "bun vitest run" })
    } finally {
      await app.close()
      safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
    }
  })

  it("feeds retained journal attempts into queue statistics facts", async () => {
    const app = await createApp({ failingCheck: true })
    try {
      await openAndSubmit(app)
      await app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 })

      const snapshot = await runInternals.queueListSnapshot(app, [], {}, outputIO().io, {
        queueReadModel: testQueueReadModel(app),
      })
      expect(snapshot.projection.timeStatsFacts).toMatchObject([
        {
          run: "R1",
          members: [{ pr: "PR1", retries: 1 }],
        },
      ])
    } finally {
      await app.close()
    }
  })

  it("routes queue list attempt history through the installed read model without scanning app.events", async () => {
    const app = await createApp({ failingCheck: true })
    try {
      await openAndSubmit(app)
      await app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 })
      const attempts = await queueLogAttempts(app.events())
      let reads = 0
      const noJournalScan = new Proxy(app, {
        get(target, property, receiver) {
          if (property === "events") {
            return () => {
              throw new Error("queue list scanned app.events")
            }
          }
          return Reflect.get(target, property, receiver) as unknown
        },
      })
      const services = {
        queueReadModel: {
          async snapshot() {
            reads += 1
            return { cursor: (await app.journalSnapshot()).asOf.cursor, generation: 0, attempts }
          },
        },
      }

      await expect(runYrd(noJournalScan, yrd("queue", "list", "--json"), outputIO().io, services)).resolves.toBe(0)
      expect(reads).toBe(1)
    } finally {
      await app.close()
    }
  })

  // 22332 boxes 4 and 5: the Candidate ref namespace had no enumerator, so ~2000
  // refs accumulated unseen. These prove the two halves against a real repository
  // — doctor reports a seeded orphan, and the reaper ages out terminal evidence
  // under the stated seven-day rule while retaining everything it cannot prove.
  describe("candidate ref retention", () => {
    const gitIn = (cwd: string, args: readonly string[]) =>
      execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

    /** A repository holding one commit and one Candidate ref pointing at it. The
     * ref is named `C1` — the pre-22332 shape — because that is exactly what the
     * accumulated orphans look like. */
    const seededRepo = (): Readonly<{ repo: string; sha: string; ref: string }> => {
      const repo = mkdtempSync(join(tmpdir(), "yrd-candidate-refs-"))
      execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" })
      gitIn(repo, ["config", "user.name", "Yrd Test"])
      gitIn(repo, ["config", "user.email", "yrd@example.invalid"])
      writeFileSync(join(repo, "README.md"), "main\n")
      gitIn(repo, ["add", "README.md"])
      gitIn(repo, ["commit", "-qm", "main"])
      const sha = gitIn(repo, ["rev-parse", "HEAD"])
      const ref = "refs/yrd/candidates/C1"
      gitIn(repo, ["update-ref", ref, sha])
      return { repo, sha, ref }
    }

    it("reports a seeded orphan Candidate ref through yrd doctor", async () => {
      const { repo, ref } = seededRepo()
      const app = await createApp()
      try {
        const output = outputIO({ cwd: repo, repositoryRoot: repo })

        await runYrd(app, yrd("doctor", "--json"), output.io)

        const report = JSON.parse(output.stdout()) as Readonly<{ candidateRefs: CandidateRefSweepResult }>
        // The ref is counted, and counted in the bucket that says the journal
        // cannot explain it — not quietly dropped.
        expect(report.candidateRefs).toMatchObject({ scanned: 1, unclaimed: 1, reclaimable: 0 })
        expect(report.candidateRefs.findings).toEqual([expect.objectContaining({ ref, disposition: "unclaimed" })])
        // And the operator is told, with the denominator and the remedy.
        const said = `${output.stdout()}${output.stderr()}`
        expect(said).toContain("candidate-ref-orphans")
        expect(said).toContain("yrd admin candidate-refs prune")
      } finally {
        await app.close()
        safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
      }
    })

    it("refuses the retired queue candidate-refs spelling loudly, never as a filter term", async () => {
      const { repo, ref } = seededRepo()
      const app = await createApp()
      try {
        const output = outputIO({ cwd: repo, repositoryRoot: repo })

        // Retired verb (5e cut 7): the spelling stays routable so an old
        // runbook gets the replacements, and the ref is untouched.
        await expect(runYrd(app, yrd("queue", "candidate-refs", "--json"), output.io)).resolves.toBe(1)
        expect(output.stderr()).toContain("queue-candidate-refs-retired")
        expect(output.stderr()).toContain("yrd admin candidate-refs prune")
        expect(gitIn(repo, ["rev-parse", "--verify", ref])).not.toBe("")
      } finally {
        await app.close()
        safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
      }
    })

    it("retains an unclaimed ref even under admin candidate-refs prune, however old it is", async () => {
      // The design ruling: unknown, unmatched and unpaired refs stay. An orphan
      // whose Run the journal has forgotten cannot be PROVEN terminal, so the
      // reaper must not take it — which is why the ~2000 legacy refs need a
      // journal-backed decision rather than an age check.
      const { repo, ref } = seededRepo()
      const app = await createApp()
      try {
        const output = outputIO({ cwd: repo, repositoryRoot: repo })

        await expect(
          runYrd(app, yrd("admin", "candidate-refs", "prune", "--retention-days", "0", "--json"), output.io),
        ).resolves.toBe(0)

        expect(JSON.parse(output.stdout())).toMatchObject({
          command: "admin.candidate-refs.prune",
          deleted: [],
          unclaimed: 1,
        })
        expect(gitIn(repo, ["rev-parse", "--verify", ref])).not.toBe("")
      } finally {
        await app.close()
        safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
      }
    })
  })

  describe("doctor retention observability", () => {
    async function retentionDoctorFixture() {
      const repo = mkdtempSync(join(tmpdir(), "yrd-doctor-retention-"))
      execFileSync("git", ["init", "-q", "-b", "main", repo])
      const stateDir = join(repo, ".git", "yrd")
      const journal = createJournal({
        dir: stateDir,
        inject: { sqliteVersion: "3.53.0" },
      } as unknown as Parameters<typeof createJournal>[0])
      const app = await createApp({ journal })
      return { repo, stateDir, app }
    }

    async function withHeldHabitant<T>(
      stateDir: string,
      driver: Readonly<{ queueId: string; epoch: string }>,
      status: Readonly<Record<string, unknown>>,
      action: () => Promise<T>,
    ): Promise<T> {
      const lockRelease = Promise.withResolvers<void>()
      const lockAcquired = Promise.withResolvers<void>()
      const lock = createExclusive(join(stateDir, "resident-runner"), { timeoutMs: 0 }).run(
        async () => {
          lockAcquired.resolve()
          await lockRelease.promise
        },
        { holder: `queue=${driver.queueId} epoch=${driver.epoch}` },
      )
      try {
        await lockAcquired.promise
        mkdirSync(join(stateDir, "resident-runner"), { recursive: true })
        writeFileSync(
          join(stateDir, "resident-runner", "status.json"),
          JSON.stringify({
            pid: process.pid,
            startedAt: "2026-07-09T12:00:00.000Z",
            lastTickAt: "2026-07-09T12:00:58.000Z",
            driver: { ...driver, lastMerged: null },
            ...status,
          }),
        )
        return await action()
      } finally {
        lockRelease.resolve()
        await lock
      }
    }

    it("reports a complete advisory observation when lease and status agree there is no habitant", async () => {
      const { repo, stateDir, app } = await retentionDoctorFixture()
      try {
        const output = outputIO({ cwd: repo, stateDir })
        expect(await runYrd(app, yrd("doctor", "--json"), output.io)).toBe(0)
        expect(JSON.parse(output.stdout())).toMatchObject({
          retention: {
            advisory: true,
            floor: {
              evictedThrough: 0,
              oldestRetainedCursor: null,
              source: expect.stringContaining("journal.sqlite"),
              observedAt: "2026-07-09T12:01:00.000Z",
            },
            writer: {
              active: false,
              armed: false,
              policy: "not-applicable",
              observedAt: "2026-07-09T12:01:00.000Z",
            },
            checkpoint: { status: "covering", cursor: 0, cursorHeadroom: 0 },
          },
        })
      } finally {
        await app.close()
        safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
      }
    })

    it("refuses a live habitant whose heartbeat lacks the writer-policy observation", async () => {
      const { repo, stateDir, app } = await retentionDoctorFixture()
      const driver = { queueId: `${repo}#main`, epoch: "11111111-1111-4111-8111-111111111111" }
      const lockRelease = Promise.withResolvers<void>()
      const lockAcquired = Promise.withResolvers<void>()
      const lock = createExclusive(join(stateDir, "resident-runner"), { timeoutMs: 0 }).run(
        async () => {
          lockAcquired.resolve()
          await lockRelease.promise
        },
        { holder: `queue=${driver.queueId} epoch=${driver.epoch}` },
      )
      try {
        await lockAcquired.promise
        mkdirSync(join(stateDir, "resident-runner"), { recursive: true })
        writeFileSync(
          join(stateDir, "resident-runner", "status.json"),
          JSON.stringify({
            pid: process.pid,
            startedAt: "2026-07-09T12:00:00.000Z",
            lastTickAt: "2026-07-09T12:00:58.000Z",
            driver: { ...driver, lastMerged: null },
          }),
        )
        const output = outputIO({ cwd: repo, stateDir })
        expect(await runYrd(app, yrd("doctor", "--json"), output.io)).toBe(3)
        expect(JSON.parse(output.stderr())).toMatchObject({
          failure: { kind: "infrastructure", code: "resident-retention-observation-missing" },
        })
      } finally {
        lockRelease.resolve()
        await lock
        await app.close()
        safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
      }
    })

    it("refuses an evicted prefix without a Core-usable checkpoint", async () => {
      const { repo, stateDir, app } = await retentionDoctorFixture()
      try {
        const uncovered = {
          ...app,
          retentionDiagnostics: () => ({
            resultFrames: 0,
            causeIds: 0,
            eventIds: 0,
            journal: {
              pageCount: 1,
              freelistCount: 0,
              autoVacuum: "incremental" as const,
              historyFrames: 1,
              tailFrames: 0,
              evictedThrough: 5,
              oldestRetainedCursor: 6,
              archiveFallbacks: 0,
            },
          }),
        }
        const output = outputIO({ cwd: repo, stateDir })
        expect(await runYrd(uncovered, yrd("doctor", "--json"), output.io)).toBe(3)
        expect(JSON.parse(output.stderr())).toMatchObject({
          failure: { kind: "infrastructure", code: "journal-recovery-coverage-unavailable" },
        })
      } finally {
        await app.close()
        safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
      }
    })

    it("refuses a Core checkpoint below the durable eviction floor", async () => {
      const { repo, stateDir, app } = await retentionDoctorFixture()
      try {
        const uncovered = {
          ...app,
          retentionDiagnostics: () => ({
            resultFrames: 0,
            causeIds: 0,
            eventIds: 0,
            journal: {
              pageCount: 1,
              freelistCount: 0,
              autoVacuum: "incremental" as const,
              historyFrames: 1,
              tailFrames: 0,
              evictedThrough: 5,
              oldestRetainedCursor: 6,
              archiveFallbacks: 0,
            },
            checkpoint: { identity: "below-floor", cursor: 4 },
          }),
        }
        const output = outputIO({ cwd: repo, stateDir })
        expect(await runYrd(uncovered, yrd("doctor", "--json"), output.io)).toBe(3)
        expect(JSON.parse(output.stderr())).toMatchObject({
          failure: { kind: "infrastructure", code: "journal-recovery-coverage-invalid" },
        })
      } finally {
        await app.close()
        safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
      }
    })

    it("refuses an internally inconsistent Journal floor", async () => {
      const { repo, stateDir, app } = await retentionDoctorFixture()
      try {
        const inconsistent = {
          ...app,
          retentionDiagnostics: () => ({
            resultFrames: 0,
            causeIds: 0,
            eventIds: 0,
            journal: {
              pageCount: 1,
              freelistCount: 0,
              autoVacuum: "incremental" as const,
              historyFrames: 1,
              tailFrames: 0,
              evictedThrough: 5,
              oldestRetainedCursor: 5,
              archiveFallbacks: 0,
            },
            checkpoint: { identity: "covering", cursor: 5 },
          }),
        }
        const output = outputIO({ cwd: repo, stateDir })
        expect(await runYrd(inconsistent, yrd("doctor", "--json"), output.io)).toBe(3)
        expect(JSON.parse(output.stderr())).toMatchObject({
          failure: { kind: "infrastructure", code: "journal-retention-floor-invalid" },
        })
      } finally {
        await app.close()
        safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
      }
    })

    it("refuses when a live status record disagrees with a free writer lease", async () => {
      const { repo, stateDir, app } = await retentionDoctorFixture()
      try {
        mkdirSync(join(stateDir, "resident-runner"), { recursive: true })
        writeFileSync(
          join(stateDir, "resident-runner", "status.json"),
          JSON.stringify({
            pid: process.pid,
            startedAt: "2026-07-09T12:00:00.000Z",
            lastTickAt: "2026-07-09T12:00:58.000Z",
          }),
        )
        const output = outputIO({ cwd: repo, stateDir })
        expect(await runYrd(app, yrd("doctor", "--json"), output.io)).toBe(3)
        expect(JSON.parse(output.stderr())).toMatchObject({
          failure: { kind: "infrastructure", code: "resident-retention-source-disagreement" },
        })
      } finally {
        await app.close()
        safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
      }
    })

    it("refuses a stale writer-policy observation", async () => {
      const { repo, stateDir, app } = await retentionDoctorFixture()
      const driver = { queueId: `${repo}#main`, epoch: "11111111-1111-4111-8111-111111111111" }
      try {
        await withHeldHabitant(
          stateDir,
          driver,
          {
            startedAt: "2026-07-09T11:57:00.000Z",
            lastTickAt: "2026-07-09T11:58:00.000Z",
            retention: {
              policy: "disabled",
              source: "mutable-journal",
              observedAt: "2026-07-09T11:58:00.000Z",
              generation: driver.epoch,
            },
          },
          async () => {
            const output = outputIO({ cwd: repo, stateDir })
            expect(await runYrd(app, yrd("doctor", "--json"), output.io)).toBe(3)
            expect(JSON.parse(output.stderr())).toMatchObject({
              failure: { kind: "infrastructure", code: "resident-retention-observation-stale" },
            })
          },
        )
      } finally {
        await app.close()
        safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
      }
    })

    it("refuses a writer-policy observation from another habitant generation", async () => {
      const { repo, stateDir, app } = await retentionDoctorFixture()
      const driver = { queueId: `${repo}#main`, epoch: "11111111-1111-4111-8111-111111111111" }
      try {
        await withHeldHabitant(
          stateDir,
          driver,
          {
            retention: {
              policy: "disabled",
              source: "mutable-journal",
              observedAt: "2026-07-09T12:00:58.000Z",
              generation: "22222222-2222-4222-8222-222222222222",
            },
          },
          async () => {
            const output = outputIO({ cwd: repo, stateDir })
            expect(await runYrd(app, yrd("doctor", "--json"), output.io)).toBe(3)
            expect(JSON.parse(output.stderr())).toMatchObject({
              failure: { kind: "infrastructure", code: "resident-retention-observation-mismatch" },
            })
          },
        )
      } finally {
        await app.close()
        safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
      }
    })

    it("refuses when the writer lease and status identify different generations", async () => {
      const { repo, stateDir, app } = await retentionDoctorFixture()
      const leaseDriver = { queueId: `${repo}#main`, epoch: "11111111-1111-4111-8111-111111111111" }
      const statusEpoch = "22222222-2222-4222-8222-222222222222"
      try {
        await withHeldHabitant(
          stateDir,
          leaseDriver,
          {
            driver: { queueId: leaseDriver.queueId, epoch: statusEpoch, lastMerged: null },
            retention: {
              policy: "disabled",
              source: "mutable-journal",
              observedAt: "2026-07-09T12:00:58.000Z",
              generation: statusEpoch,
            },
          },
          async () => {
            const output = outputIO({ cwd: repo, stateDir })
            expect(await runYrd(app, yrd("doctor", "--json"), output.io)).toBe(3)
            expect(JSON.parse(output.stderr())).toMatchObject({
              failure: { kind: "infrastructure", code: "resident-retention-source-disagreement" },
            })
          },
        )
      } finally {
        await app.close()
        safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
      }
    })

    it("refuses malformed writer-policy evidence instead of treating retention as disabled", async () => {
      const { repo, stateDir, app } = await retentionDoctorFixture()
      const driver = { queueId: `${repo}#main`, epoch: "11111111-1111-4111-8111-111111111111" }
      try {
        await withHeldHabitant(
          stateDir,
          driver,
          {
            retention: {
              policy: { keepFrames: 0 },
              source: "mutable-journal",
              observedAt: "2026-07-09T12:00:58.000Z",
              generation: driver.epoch,
            },
          },
          async () => {
            const output = outputIO({ cwd: repo, stateDir })
            expect(await runYrd(app, yrd("doctor", "--json"), output.io)).toBe(3)
            expect(JSON.parse(output.stderr())).toMatchObject({
              failure: { kind: "infrastructure", code: "resident-runner-status-invalid" },
            })
          },
        )
      } finally {
        await app.close()
        safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
      }
    })

    it("refuses an invalid observation clock", async () => {
      const { repo, stateDir, app } = await retentionDoctorFixture()
      try {
        const output = outputIO({ cwd: repo, stateDir, now: () => Number.NaN })
        expect(await runYrd(app, yrd("doctor", "--json"), output.io)).toBe(3)
        expect(JSON.parse(output.stderr())).toMatchObject({
          failure: { kind: "infrastructure", code: "doctor-clock-invalid" },
        })
      } finally {
        await app.close()
        safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
      }
    })
  })

  it("rebuilds registered Journal views through the explicit doctor repair path", async () => {
    const app = await createApp()
    try {
      let rebuilds = 0
      const services: YrdCliServices = {
        journal: {
          async importOrphan() {
            throw new Error("not used")
          },
          async rebuildViews() {
            rebuilds += 1
            return { cursor: 7, frames: 6, views: 1 }
          },
        },
      }
      const output = outputIO()

      await expect(runYrd(app, yrd("doctor", "--rebuild-views", "--json"), output.io, services)).resolves.toBe(0)
      expect(JSON.parse(output.stdout())).toMatchObject({
        command: "doctor",
        rebuilt: { cursor: 7, frames: 6, views: 1 },
      })
      expect(rebuilds).toBe(1)
    } finally {
      await app.close()
    }
  })

  describe("doctor --rebuild-index-from-repo", () => {
    const mergedRecord = (changeId: string) => ({
      merge: {
        id: "R-recovered",
        base: "main",
        baseSha: BASE_SHA,
        candidate: "C1",
        result: "merged" as const,
        mergedCommit: MERGED_SHA,
        startedAt: "2026-08-12T20:00:00.000Z",
        finishedAt: "2026-08-12T20:01:00.000Z",
      },
      changes: [{ pr: "PR1", revision: 1, submittedHead: HEAD_SHA, changeId, generatedCommit: MERGED_SHA }],
      evidence: { jobs: [] },
      pins: [],
    })

    const pointer = {
      ref: "refs/notes/yrd/merge-records" as const,
      target: "2".repeat(40),
      note: "c".repeat(40),
      checksum: "d".repeat(64),
    }

    const servicesFor = (records: readonly unknown[]): YrdCliServices =>
      ({
        mergeRecords: {
          find: async () => ({ status: "proven" as const, records, unverifiable: [], retracted: [] }),
          all: async () => ({ status: "proven" as const, records, unverifiable: [], retracted: [] }),
          retractUnprovable: async () => ({ proven: 0, alreadyRetracted: 0, planned: [], applied: [] }),
        },
      }) as YrdCliServices

    it("rebuilds every missing pr/integrated row and denominates what it scanned", async () => {
      await using app = await createApp()
      await app.bays.submit({ branch: "issue/index-gap", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
      const revision = currentChangeRev(app.bays.pr("PR1")!)
      if (revision.changeId === undefined) throw new Error("expected current PR Change-Id")
      const record = mergedRecord(revision.changeId)
      const output = outputIO()

      expect(
        await runYrd(
          app,
          yrd("doctor", "--rebuild-index-from-repo", "--json"),
          output.io,
          servicesFor([{ record, pointer }]),
        ),
        output.stderr(),
      ).toBe(0)
      expect(JSON.parse(output.stdout())).toMatchObject({
        command: "doctor",
        indexRebuild: {
          ref: "refs/notes/yrd/merge-records",
          scanned: { records: 1, merged: 1, changes: 1 },
          rebuilt: [{ pr: "PR1", revision: 1, run: "R-recovered", commit: MERGED_SHA }],
          skipped: [],
        },
      })
      expect(app.bays.pr("PR1")?.integration).toMatchObject({ commit: MERGED_SHA, changeId: revision.changeId })
    })

    // `finishedAt` is `z.iso.datetime({ offset: true })`, so its text and its
    // instant can disagree. `R-earlier` reads "2026-08-12T23:00:00.000+05:00" —
    // later than "2026-08-12T20:00:00.000Z" as text, two hours EARLIER as an
    // instant (18:00Z). A string compare therefore keeps the stale attempt and
    // writes its run into the index row; so does `localeCompare` on the
    // `yrd why` side. Only an instant compare picks `R-later`.
    it("collapses attempts by instant, not by the text of an offset-bearing timestamp", async () => {
      await using app = await createApp()
      await app.bays.submit({ branch: "issue/offsets", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
      const revision = currentChangeRev(app.bays.pr("PR1")!)
      if (revision.changeId === undefined) throw new Error("expected current PR Change-Id")
      const base = mergedRecord(revision.changeId)
      const earlier = {
        ...base,
        merge: { ...base.merge, id: "R-earlier", finishedAt: "2026-08-12T23:00:00.000+05:00" },
      }
      const later = { ...base, merge: { ...base.merge, id: "R-later", finishedAt: "2026-08-12T20:00:00.000Z" } }
      const output = outputIO()

      expect(
        await runYrd(
          app,
          yrd("doctor", "--rebuild-index-from-repo", "--json"),
          output.io,
          // Stale attempt first, so it is the incumbent a text compare refuses to replace.
          servicesFor([
            { record: earlier, pointer },
            { record: later, pointer },
          ]),
        ),
        output.stderr(),
      ).toBe(0)
      expect(JSON.parse(output.stdout())).toMatchObject({
        indexRebuild: { rebuilt: [{ pr: "PR1", run: "R-later" }] },
      })
      expect(app.bays.pr("PR1")?.terminalRun).toBe("R-later")
    })

    it("reports a scan that found nothing with its denominator rather than a clean verdict", async () => {
      await using app = await createApp()
      const output = outputIO()

      expect(
        await runYrd(app, yrd("doctor", "--rebuild-index-from-repo"), output.io, servicesFor([])),
        output.stderr(),
      ).toBe(0)
      expect(output.stdout()).toContain("scanned 0 merge records under refs/notes/yrd/merge-records")
      expect(output.stdout()).toContain("0 changes collapse to 0 distinct merges — rebuilt 0, skipped 0")
    })

    it("names the change it cannot rebuild and refuses to call the run clean", async () => {
      await using app = await createApp()
      const record = mergedRecord(`I${"e".repeat(40)}`)
      const output = outputIO()

      expect(
        await runYrd(app, yrd("doctor", "--rebuild-index-from-repo"), output.io, servicesFor([{ record, pointer }])),
        output.stderr(),
      ).toBe(1)
      expect(output.stdout()).toContain("SKIPPED PR1 revision 1 pr-unknown")
      expect(output.stdout()).toContain("a merge record proves a merge, not a change's existence")
    })

    // Contract 4 / doctor-rebuild-hardening: a wiped journal reads as N identical
    // "pr-unknown" skips, one per merge, with nothing at the top of the report
    // naming the actual condition — the journal holds no PR entities at all, so
    // every skip below is the same fact repeated, not N separate gaps. An operator
    // reading this after real data loss deserves the ONE sentence that tells them
    // what happened and what the flag can and cannot do about it.
    it("names the journal itself as empty, once, instead of repeating pr-unknown per merge", async () => {
      await using app = await createApp()
      const output = outputIO()
      const prIds = ["PR1", "PR2", "PR3"]
      const records = prIds.map((prId, index) => ({
        record: {
          merge: {
            id: `R-${prId}`,
            base: "main",
            baseSha: BASE_SHA,
            candidate: `C-${prId}`,
            result: "merged" as const,
            mergedCommit: MERGED_SHA,
            startedAt: "2026-08-12T20:00:00.000Z",
            finishedAt: "2026-08-12T20:01:00.000Z",
          },
          changes: [
            {
              pr: prId,
              revision: 1,
              submittedHead: HEAD_SHA,
              changeId: `I${String(index)}${"e".repeat(39)}`,
              generatedCommit: MERGED_SHA,
            },
          ],
          evidence: { jobs: [] },
          pins: [],
        },
        pointer,
      }))

      expect(
        await runYrd(app, yrd("doctor", "--rebuild-index-from-repo", "--json"), output.io, servicesFor(records)),
        output.stderr(),
      ).toBe(1)
      expect(JSON.parse(output.stdout())).toMatchObject({
        indexRebuild: { scanned: { knownPrs: 0 }, rebuilt: [] },
      })

      const human = outputIO()
      expect(
        await runYrd(app, yrd("doctor", "--rebuild-index-from-repo"), human.io, servicesFor(records)),
        human.stderr(),
      ).toBe(1)
      expect(human.stdout()).toContain("the journal holds zero PR entities")
      expect(human.stdout()).toContain("repairs a KNOWN PR's missing index row")
      expect(human.stdout()).toContain("entity the journal has never seen")
      // Still every merge named underneath — the aggregate line is in ADDITION
      // to the per-record detail, never a replacement for it.
      for (const prId of prIds) {
        expect(human.stdout()).toContain(`SKIPPED ${prId} revision 1 pr-unknown`)
      }
    })

    it("leaves an already-indexed merge alone and says so", async () => {
      await using app = await createApp()
      await app.bays.submit({ branch: "issue/index-gap", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
      const revision = currentChangeRev(app.bays.pr("PR1")!)
      if (revision.changeId === undefined) throw new Error("expected current PR Change-Id")
      const services = servicesFor([{ record: mergedRecord(revision.changeId), pointer }])

      const first = outputIO()
      expect(await runYrd(app, yrd("doctor", "--rebuild-index-from-repo"), first.io, services), first.stderr()).toBe(0)
      const second = outputIO()
      expect(await runYrd(app, yrd("doctor", "--rebuild-index-from-repo"), second.io, services), second.stderr()).toBe(
        0,
      )
      expect(second.stdout()).toContain("1 change collapses to 1 distinct merge — rebuilt 0, skipped 1")
      expect(second.stdout()).toContain("SKIPPED PR1 revision 1 already-indexed")
    })

    it("skips a record whose revision the journal has already superseded", async () => {
      await using app = await createApp()
      await app.bays.submit({ branch: "issue/index-gap", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
      const revision = currentChangeRev(app.bays.pr("PR1")!)
      if (revision.changeId === undefined) throw new Error("expected current PR Change-Id")
      const stale = mergedRecord(revision.changeId)
      const record = { ...stale, changes: [{ ...stale.changes[0]!, submittedHead: "9".repeat(40) }] }
      const output = outputIO()

      expect(
        await runYrd(app, yrd("doctor", "--rebuild-index-from-repo"), output.io, servicesFor([{ record, pointer }])),
        output.stderr(),
      ).toBe(1)
      expect(output.stdout()).toContain("SKIPPED PR1 revision 1 revision-superseded")
      expect(app.bays.pr("PR1")?.integration).toBeUndefined()
    })

    it("refuses loudly when the merge-record ref itself is unreadable", async () => {
      await using app = await createApp()
      const output = outputIO()

      expect(
        await runYrd(app, yrd("doctor", "--rebuild-index-from-repo"), output.io, {
          mergeRecords: {
            find: async () => ({ status: "repository-corrupt" as const, reason: "merge-record ref unreadable" }),
            all: async () => ({ status: "repository-corrupt" as const, reason: "merge-record ref unreadable" }),
            retractUnprovable: async () => ({ proven: 0, alreadyRetracted: 0, planned: [], applied: [] }),
          },
        } as YrdCliServices),
      ).toBe(2)
      expect(output.stderr()).toContain("merge-record ref unreadable")
    })

    it("refuses when no repository merge-record capability is installed", async () => {
      await using app = await createApp()
      const output = outputIO()

      expect(await runYrd(app, yrd("doctor", "--rebuild-index-from-repo"), output.io, {} as YrdCliServices)).toBe(2)
      expect(output.stderr()).toContain("repository merge-record capability is not installed")
    })

    const SUBMODULE = "components/alpha"
    const CURRENT_PIN = "a".repeat(40)
    const TARGET_SHA = "b".repeat(40)

    /** A merged pin intent records its OWN id in `changes[].pr` — `mergeRecordBody` fills that
     * field from the queue member's id, and `MergeRecordChange.pr` is `QueueMemberIdSchema`, a
     * union that discriminates PR ids from intent ids. So the record itself says which kind of
     * member merged; `app.bays.pr()` returning undefined for an intent id is the expected answer,
     * never evidence of a missing PR. */
    const intentRecord = (member: string) => ({
      merge: {
        id: "R-pin",
        base: "main",
        baseSha: BASE_SHA,
        candidate: "C-pin",
        result: "merged" as const,
        mergedCommit: MERGED_SHA,
        startedAt: "2026-08-14T20:00:00.000Z",
        finishedAt: "2026-08-14T20:01:00.000Z",
      },
      changes: [{ pr: member, revision: 1, submittedHead: HEAD_SHA }],
      evidence: { jobs: [] },
      pins: [{ path: SUBMODULE, before: CURRENT_PIN, after: TARGET_SHA }],
    })

    it("buckets a merged intent carrier as a healthy skip, never a change gap", async () => {
      // The intent rail itself is retired (this carrier's own commit): there is
      // no more `app.intents` to submit through or consult, so doctor can no
      // longer distinguish "a known intent record" from "an id merely shaped
      // like one" — and it no longer needs to. Any id `IntentRecordIdSchema`
      // accepts is a pin-intent merge by construction (the mint that wrote it
      // never wrote anything else), so it is always a healthy skip, never a gap.
      await using app = await createApp()
      const output = outputIO()

      expect(
        await runYrd(
          app,
          yrd("doctor", "--rebuild-index-from-repo"),
          output.io,
          servicesFor([{ record: intentRecord("yrdpin#164"), pointer }]),
        ),
        output.stderr(),
      ).toBe(0)
      expect(output.stdout()).toContain("SKIPPED yrdpin#164 revision 1 intent-carrier")
      expect(output.stdout()).not.toContain("pr-unknown")
    })

    it("reports a record it cannot verify and keeps rebuilding the rest of the estate", async () => {
      const poisonedHead = "7".repeat(40)
      await using app = await createApp()
      await app.bays.submit({ branch: "issue/index-gap", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
      await app.bays.submit({ branch: "issue/poisoned", headSha: poisonedHead, base: "main", baseSha: BASE_SHA })
      const revision = currentChangeRev(app.bays.pr("PR1")!)
      const poisonedRevision = currentChangeRev(app.bays.pr("PR2")!)
      if (revision.changeId === undefined || poisonedRevision.changeId === undefined) {
        throw new Error("expected current PR Change-Ids")
      }
      // A merged record with no merged commit: repository truth that contradicts itself, for a change
      // the journal knows, so the scan reaches the contradiction rather than an earlier skip. It
      // comes FIRST so a scan that aborts on it never reaches the merge it could still rebuild.
      const contradictory = {
        merge: {
          id: "R-poisoned",
          base: "main",
          baseSha: BASE_SHA,
          candidate: "C-poisoned",
          result: "merged" as const,
          mergedCommit: undefined,
          startedAt: "2026-08-14T20:00:00.000Z",
          finishedAt: "2026-08-14T20:01:00.000Z",
        },
        changes: [
          {
            pr: "PR2",
            revision: 1,
            submittedHead: poisonedHead,
            changeId: poisonedRevision.changeId,
            generatedCommit: MERGED_SHA,
          },
        ],
        evidence: { jobs: [] },
        pins: [],
      }
      const output = outputIO()

      expect(
        await runYrd(
          app,
          yrd("doctor", "--rebuild-index-from-repo"),
          output.io,
          servicesFor([
            { record: contradictory, pointer },
            { record: mergedRecord(revision.changeId), pointer },
          ]),
        ),
        output.stderr(),
      ).toBe(1)
      expect(output.stdout()).toContain("SKIPPED PR2 revision 1 unverifiable")
      expect(output.stdout()).toContain("REBUILT PR1 revision 1 via R-recovered")
      expect(app.bays.pr("PR1")?.integration).toMatchObject({ commit: MERGED_SHA })
    })

    it("counts the records the bulk scan itself could not verify", async () => {
      const unverifiable = [
        {
          note: "f".repeat(40),
          status: "repository-corrupt" as const,
          reason: "merge-record is invalid: unexpected token",
          classification: "unreadable" as const,
        },
      ]
      const services = {
        mergeRecords: {
          find: async () => ({ status: "proven" as const, records: [], unverifiable: [], retracted: [] }),
          all: async () => ({ status: "proven" as const, records: [], unverifiable, retracted: [] }),
          retractUnprovable: async () => ({ proven: 0, alreadyRetracted: 0, planned: [], applied: [] }),
        },
      } as YrdCliServices

      await using app = await createApp()
      const json = outputIO()
      expect(
        await runYrd(app, yrd("doctor", "--rebuild-index-from-repo", "--json"), json.io, services),
        json.stderr(),
      ).toBe(1)
      expect(JSON.parse(json.stdout())).toMatchObject({ indexRebuild: { unverifiable } })

      const human = outputIO()
      expect(await runYrd(app, yrd("doctor", "--rebuild-index-from-repo"), human.io, services), human.stderr()).toBe(1)
      expect(human.stdout()).toContain("1 record the scan could not verify")
      expect(human.stdout()).toContain("UNVERIFIABLE")
    })
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
      // The runner submits a change AFTER the viewer app has already mounted.
      await openAndSubmit(runner)
      expect(Object.keys(runner.state().bays.prs)).toEqual(["PR1"])

      // The viewer's mount-time journal projection never tails cross-process
      // appends on its own — app.state() alone stays frozen-empty:
      expect(Object.keys(viewer.state().bays.prs)).toEqual([])

      // queueListSnapshot refreshes before reading, so its rows reflect the
      // out-of-process submission (stale WITHOUT refresh, fresh WITH it):
      const snapshot = await runInternals.queueListSnapshot(viewer, [], {}, outputIO().io, {
        queueReadModel: testQueueReadModel(viewer),
      })
      expect(snapshot.results.flatMap((result) => result.prs.map((pr) => pr.id))).toContain("PR1")

      // The refresh also published, so subsequent plain reads are fresh too:
      expect(Object.keys(viewer.state().bays.prs)).toEqual(["PR1"])
    } finally {
      await Promise.all([runner.close(), viewer.close()])
    }
  })
})
