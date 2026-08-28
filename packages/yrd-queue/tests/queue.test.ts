/**
 * @failure Queue composition or projection can accept corrupt runs, lose pinned plans, or misstate integration results.
 * @level l2
 * @consumer @yrd/queue
 */
import { describe, expect, expectTypeOf, it, vi } from "vitest"
import { createLogger, type ConditionalLogger, type Event as LogEvent } from "loggily"
import {
  checkRequest,
  createBayJobDefs,
  currentChangeRev,
  changeAdmission,
  changeDeliveryState,
  withBays,
  volatilePrNumberMint,
  type BayWorkspace,
  type Change,
  type PrNumberMint,
} from "@yrd/bay"
import {
  Command,
  createFailure,
  createMemoryJournal,
  createYrd,
  createYrdDef,
  parseJournalFrame,
  pipe,
  type Journal,
  type JournalCheckpoint,
  type JournalEntityKind,
  type JournalFrame,
} from "@yrd/core"
import { localRunner, withJobs, type JobResult, type Jobs, type Runner, type RunnerSubmission } from "@yrd/job"
import * as z from "zod"
import * as queueApi from "../src/index.ts"
import {
  DEFAULT_QUEUE_BATCH_SIZE,
  candidateRefFor,
  deriveRunMemberArgs,
  materializeDerivedRunMembers,
  withQueue,
  projectQueueStarted,
  withMerge,
  withStep,
  Queues,
  QueueRecordSchema,
  ChangeSnapshotSchema,
  ReplayQueueRecordSchema,
  type AddStepResult,
  type DerivedRunMember,
  type DerivedSubmitEnrichment,
  type IntegrationProof,
  type IntegratedShape,
  type Queue,
  type QueueProjectionLookup,
  type QueueProjectionLookupNode,
  type QueueRecord,
  type ChangeShape,
  type StepExecution,
  type StepRunner,
} from "@yrd/queue"
import {
  activeQueueRootIds,
  childRunId,
  emptyQueueProjectionIndex,
  indexQueueStart,
  latestExactRunId,
  latestPrefixRunId,
  projectionLookupGet,
  projectionLookupSet,
  queueLookupKey,
  recordReleasedAdmissionFailure,
  releasedAdmissionFailures,
} from "../src/projection-index.ts"
import { compactQueuesState } from "../src/retention.ts"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const UPDATED = "3".repeat(40)
const runtime = { runner: "local", leaseMs: 60_000 }

describe("queue batch policy", () => {
  it("keeps effective batch normalization out of the public Queue API", () => {
    expect("effectiveBatchSize" in queueApi).toBe(false)
  })

  it.each([
    [false, 1],
    [0, 1],
    [1, 1],
    [2, 2],
    [10, 10],
  ] as const)("normalizes %s to the effective batch size %s", async (configured, expected) => {
    await using app = await createQueueApp({ batch: configured })
    expect(app.state().queues.batchSize).toBe(expected)
  })

  it("keeps the built-in default explicit", () => {
    expect(DEFAULT_QUEUE_BATCH_SIZE).toBe(1)
  })
})

const CheckResultSchema = z.object({ checked: z.boolean() }).strict()
const ReviewResultSchema = z.object({ approved: z.boolean() }).strict()
const DeployResultSchema = z.object({ environment: z.string() }).strict()

function revisionAdmissionJob(
  jobs: Jobs,
  pr: Readonly<{ id: string; revision: number }>,
  baseSha = BASE,
  index = 0,
  stepRevision = "check-v1",
) {
  return jobs.getByKey(`admission:${pr.id}:${pr.revision}:${baseSha}:${index}:${stepRevision}`)
}

type LookupCounters = { reads: number; enumerations: number }

function deepFreeze<Value>(value: Value): Value {
  const pending: object[] = []
  const seen = new WeakSet<object>()
  if (typeof value === "object" && value !== null) pending.push(value)
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined || seen.has(current)) continue
    seen.add(current)
    for (const child of Object.values(current)) {
      if (typeof child === "object" && child !== null) pending.push(child)
    }
    Object.freeze(current)
  }
  return value
}

function observeProjectionLookup<Value>(
  lookup: Readonly<QueueProjectionLookup<Value>>,
  counters: LookupCounters,
): QueueProjectionLookup<Value> {
  const nodes = new WeakMap<object, QueueProjectionLookupNode<Value>>()
  const children = new WeakMap<object, Readonly<Record<string, QueueProjectionLookupNode<Value>>>>()
  const wrapNode = (node: Readonly<QueueProjectionLookupNode<Value>>): QueueProjectionLookupNode<Value> => {
    const cached = nodes.get(node)
    if (cached !== undefined) return cached
    const proxy = new Proxy(
      { ...node },
      {
        get(target, property, receiver) {
          counters.reads += 1
          if (property === "children") return wrapChildren(target.children)
          return Reflect.get(target, property, receiver)
        },
        ownKeys(target) {
          counters.enumerations += 1
          return Reflect.ownKeys(target)
        },
      },
    )
    nodes.set(node, proxy)
    return proxy
  }
  const wrapChildren = (
    value: Readonly<Record<string, QueueProjectionLookupNode<Value>>>,
  ): Readonly<Record<string, QueueProjectionLookupNode<Value>>> => {
    const cached = children.get(value)
    if (cached !== undefined) return cached
    const proxy = new Proxy(
      { ...value },
      {
        get(target, property, receiver) {
          counters.reads += 1
          const result = Reflect.get(target, property, receiver) as QueueProjectionLookupNode<Value> | undefined
          return result === undefined ? undefined : wrapNode(result)
        },
        ownKeys(target) {
          counters.enumerations += 1
          return Reflect.ownKeys(target)
        },
      },
    )
    children.set(value, proxy)
    return proxy
  }
  return lookup.root === undefined ? {} : { root: wrapNode(lookup.root) }
}

type CheckResult = z.infer<typeof CheckResultSchema>
type ReviewResult = z.infer<typeof ReviewResultSchema>
type DeployResult = z.infer<typeof DeployResultSchema>
type CheckedShape = AddStepResult<ChangeShape, "check", CheckResult>
type ReviewedShape = AddStepResult<CheckedShape, "review", ReviewResult>
type MergedShape = ReviewedShape & IntegratedShape
type DeployedShape = AddStepResult<MergedShape, "deploy", DeployResult>

/**
 * Post-S7 (branch-is-change, @i/10 22991) a change has no record and therefore
 * no delivery projection to read. The two facts that replace it:
 *
 * - INTEGRATED is the settlement's own terminal, `pr/integrated`, emitted from
 *   the run's `ChangeSnapshot` — {@link terminalFor}.
 * - STILL OPEN is the branch's standing submit fact: the fact IS the delivery,
 *   so a fact still at the member's sha, with no terminal for it, is exactly
 *   what `delivery === "submitted"` used to project — {@link standingSubmit}.
 */
async function terminalFor(
  app: QueueApp,
  pr: string,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  const events = await Array.fromAsync(app.events())
  const terminal = events.find(
    (event) => event.name === "pr/integrated" && (event.data as Readonly<{ pr?: unknown }>).pr === pr,
  )
  return terminal === undefined ? undefined : (terminal.data as Readonly<Record<string, unknown>>)
}

function standingSubmit(app: QueueApp, branch: string) {
  return app.state().bays.submits[branch]
}

/**
 * The admission verdict's two surviving homes. `recordRevisionAdmission` is a
 * no-op post-S7 — nothing writes an `admission` onto a change again — so a
 * PASSED verdict is read off the admission Jobs (see {@link
 * revisionAdmissionJob}) and a REFUSED one off the queues-slice refusal streak.
 */
function refusedAdmission(app: QueueApp, pr: string) {
  return app.state().queues.admissionRefusals[pr]
}

/** The `Change` the queue materializes for a derived member — the post-S7
 * stand-in for `app.bays.pr(id)`. It is a DERIVATION over the live submit fact,
 * never a record read, and it carries the synthetic standing check request the
 * fact is (design §2: the fact is the authority, so `bays.requestChecks` is
 * gone rather than replaced). */
function changeOf(app: QueueApp, member: DerivedRunMember): Change {
  const change = materializeDerivedRunMembers(app.state().bays, [member])[0]
  if (change === undefined) throw new Error(`no derived change for '${member.id}'`)
  return change
}

/** The member as the run journaled it — a derived member's only durable home
 * (recipe §4). Answers the retained `ChangeSnapshot`, never a record. */
function snapshotOf(app: QueueApp, pr: string) {
  return Queues.values(app.state().queues)
    .flatMap((run) => run.prs)
    .findLast((member) => member.id === pr)
}

function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function indexedJournal(initial: readonly JournalFrame[] = []): Journal<unknown> {
  const values = initial.map((frame) => parseJournalFrame(structuredClone(frame)))
  const entityIds = (frame: JournalFrame, kind: JournalEntityKind): readonly string[] => {
    const ids = new Set<string>()
    for (const applied of frame.events) {
      const data = applied.data as Readonly<Record<string, unknown>>
      if (applied.name === "job/requested") {
        if (kind === "job") ids.add(applied.id)
        if (kind === "job-key" && typeof data.key === "string") ids.add(data.key)
      }
      if (applied.name === "job/transitioned" && kind === "job" && typeof data.id === "string") ids.add(data.id)
      if (applied.name === "job/restored" && typeof data.job === "object" && data.job !== null) {
        const job = data.job as Readonly<{ id?: unknown; key?: unknown }>
        if (kind === "job" && typeof job.id === "string") ids.add(job.id)
        if (kind === "job-key" && typeof job.key === "string") ids.add(job.key)
      }
      if (kind === "queue") {
        if (typeof data.run === "string") ids.add(data.run)
        else if (typeof data.run === "object" && data.run !== null) {
          const run = data.run as Readonly<{ id?: unknown }>
          if (typeof run.id === "string") ids.add(run.id)
        }
        if (applied.name === "queue/batch/isolated" && typeof data.parent === "string") ids.add(data.parent)
      }
    }
    return [...ids]
  }
  return {
    async *read(after = 0, before = values.length) {
      const end = Math.min(before, values.length)
      if (after < end) yield { cursor: end, values: structuredClone(values.slice(after, end)) }
    },
    append(value, expectedCursor) {
      if (expectedCursor !== values.length) return Promise.resolve({ appended: false as const, cursor: values.length })
      values.push(parseJournalFrame(structuredClone(value)))
      return Promise.resolve({ appended: true as const, cursor: values.length })
    },
    history: {
      command(query) {
        return structuredClone(
          values.find(
            (frame) =>
              (query.id !== undefined && frame.command.id === query.id) ||
              (query.key !== undefined && frame.cause.key === query.key),
          ),
        )
      },
      hasIdentity(kind, id) {
        return values.some((frame) =>
          kind === "cause" ? frame.cause.id === id : frame.events.some((applied) => applied.id === id),
        )
      },
      entity(kind, id) {
        return values.flatMap((value, index) =>
          entityIds(value, kind).includes(id) ? [{ cursor: index + 1, value: structuredClone(value) }] : [],
        )
      },
      diagnostics() {
        return {
          pageCount: 0,
          freelistCount: 0,
          autoVacuum: "incremental" as const,
          historyFrames: 0,
          tailFrames: values.length,
          evictedThrough: 0,
          oldestRetainedCursor: values.length === 0 ? null : 1,
          archiveFallbacks: 0,
        }
      },
    },
  }
}

function checkpointJournal(base: Journal<unknown>) {
  const reads: number[] = []
  const loads: string[] = []
  let stored: JournalCheckpoint | undefined
  const journal: Journal<unknown> = {
    read(after = 0, before?: number) {
      reads.push(after)
      return base.read(after, before)
    },
    append: (value, expectedCursor) => base.append(value, expectedCursor),
    checkpoint: {
      load(identity) {
        loads.push(identity)
        return Promise.resolve(stored?.identity === identity ? structuredClone(stored) : undefined)
      },
      save(checkpoint) {
        stored = structuredClone(checkpoint)
        return Promise.resolve(true)
      },
    },
  }
  return { journal, reads, loads, stored: () => stored }
}

function queueHistoryFrames(count: number, failedRun?: number, nextId: () => string = ids()): readonly JournalFrame[] {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1
    const run = `R${number}`
    const pr = `PR${number}`
    const branch = `history/${number}`
    const headSha = number.toString(16).padStart(40, "0")
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, number)).toISOString()
    const command = { id: nextId(), op: "queue.fixture", args: { run } }
    const job = nextId()
    return parseJournalFrame({
      command,
      cause: {
        id: nextId(),
        commandId: command.id,
        op: command.op,
        commandHash: Command.hash(command),
      },
      events: [
        {
          id: nextId(),
          name: "queue/run/started",
          ts: at,
          data: {
            run: {
              id: run,
              settlement: "explicit",
              prs: [{ id: pr, branch, base: "main", revision: 1, headSha, baseSha: BASE }],
              base: "main",
              steps: [
                {
                  name: "check",
                  title: "Check",
                  revision: "check-v1",
                  kind: "check",
                },
              ],
              initialResults: {},
            },
          },
        },
        {
          id: job,
          name: "job/requested",
          ts: at,
          data: {
            definition: "queue.step.check",
            revision: "check-v1",
            input: {
              run,
              step: "check",
              index: 0,
              prs: [{ id: pr, branch, base: "main", revision: 1, headSha, baseSha: BASE }],
              shape: { results: {} },
            },
            key: `queue:${run}:0`,
          },
        },
        {
          id: nextId(),
          name: "job/transitioned",
          ts: at,
          data: { type: "start", id: job, attempt: 1, runner: "fixture", leaseExpiresAt: at },
        },
        {
          id: nextId(),
          name: "job/transitioned",
          ts: at,
          data: {
            type: "finish",
            id: job,
            attempt: 1,
            runner: "fixture",
            result:
              number === failedRun
                ? {
                    status: "completed",
                    conclusion: "failure",
                    error: { code: "fixture", message: "expected archived failure" },
                  }
                : { status: "completed", conclusion: "success", output: { checked: true } },
          },
        },
        { id: nextId(), name: "queue/run/settled", ts: at, data: { run } },
      ],
    })
  })
}

/** Turn one terminal-history fixture into the legacy failed-batch shape that
 * recovery retires when its recorded step is no longer installed. */
function staleLegacyBatchFrame(frame: JournalFrame, parent?: string): JournalFrame {
  const stale = structuredClone(frame)
  const started = stale.events.find(({ name }) => name === "queue/run/started")
  const requested = stale.events.find(({ name }) => name === "job/requested")
  const finished = stale.events.find(({ name, data }) => {
    const transition = data as { type?: unknown }
    return name === "job/transitioned" && transition.type === "finish"
  })
  if (started === undefined || requested === undefined || finished === undefined) {
    throw new Error("expected Queue start, request, and finish fixtures")
  }
  const startedData = started.data as {
    run?: {
      id?: unknown
      settlement?: unknown
      parent?: string
      isolationPart?: 0 | 1
      prs?: Array<Record<string, unknown>>
    }
  }
  const run = startedData.run
  const first = run?.prs?.[0]
  if (run === undefined || typeof run.id !== "string" || first === undefined) {
    throw new Error("expected Queue run fixture")
  }
  delete run.settlement
  if (parent !== undefined) {
    run.parent = parent
    run.isolationPart = 0
  }
  // A second, distinct member of the same run. Its id must be mint-shaped
  // (`PR<n>`) or QueueMemberIdSchema refuses it, so offset the number instead
  // of suffixing a word; the branch stays suffixed because it is free text.
  const firstNumber = /^PR(\d+)$/u.exec(String(first.id))?.[1]
  if (firstNumber === undefined) throw new Error(`expected a mint-shaped PR id, got '${String(first.id)}'`)
  const prs = [
    first,
    {
      ...first,
      id: `PR${String(Number(firstNumber) + 1_000)}`,
      branch: `${String(first.branch)}-peer`,
      headSha: MERGED,
    },
  ]
  run.prs = prs
  const requestData = requested.data as { input?: { prs?: Array<Record<string, unknown>> } }
  if (requestData.input === undefined) throw new Error("expected Queue Job input fixture")
  requestData.input.prs = prs
  const finishData = finished.data as { result?: unknown }
  finishData.result = {
    status: "completed",
    conclusion: "failure",
    error: { code: "fixture", message: "failed batch awaits isolation" },
  }
  return parseJournalFrame({
    ...stale,
    events: stale.events.filter(({ name }) => name !== "queue/run/settled"),
  })
}

function legacyQueueHistoryFrames(count: number): readonly JournalFrame[] {
  return queueHistoryFrames(count).map((frame) => {
    const legacy = structuredClone(frame)
    for (const applied of legacy.events) {
      if (applied.name !== "queue/run/started") continue
      const data = applied.data as { run?: { settlement?: unknown } }
      if (data.run !== undefined) delete data.run.settlement
    }
    return parseJournalFrame({
      ...legacy,
      events: legacy.events.filter(({ name }) => name !== "queue/run/settled"),
    })
  })
}

/** Replay-only fixture for the admission Runs written before revision verdicts
 * replaced that aggregate. Fresh code must never mint this shape. */
function legacyAdmissionRunFrame(frame: JournalFrame): JournalFrame {
  const legacy = structuredClone(frame)
  const started = legacy.events.find(({ name }) => name === "queue/run/started")
  if (started === undefined) throw new Error("expected Queue start fixture")
  const data = started.data as {
    run?: { settlement?: unknown; steps?: Array<{ name?: unknown }>; stepSelection?: unknown }
  }
  if (data.run?.steps === undefined) throw new Error("expected Queue steps fixture")
  const names = data.run.steps.map(({ name }) => {
    if (typeof name !== "string") throw new Error("expected named Queue step fixture")
    return name
  })
  delete data.run.settlement
  data.run.stepSelection = { authority: "admission", steps: names }
  return parseJournalFrame({
    ...legacy,
    events: legacy.events.filter(({ name }) => name !== "queue/run/settled"),
  })
}

function legacyFailedBeforeStartHistoryFrames(count: number): readonly JournalFrame[] {
  const nextId = ids(1_000_000)
  return queueHistoryFrames(count).map((frame) => {
    const legacy = structuredClone(frame)
    const started = legacy.events.find(({ name }) => name === "queue/run/started")
    const requested = legacy.events.find(({ name }) => name === "job/requested")
    if (started === undefined || requested === undefined) {
      throw new Error("expected Queue start and Job request fixtures")
    }
    const data = started.data as { run?: { id?: unknown; settlement?: unknown } }
    if (data.run === undefined || typeof data.run.id !== "string") {
      throw new Error("expected Queue run fixture")
    }
    delete data.run.settlement
    return parseJournalFrame({
      ...legacy,
      events: [
        started,
        requested,
        {
          id: nextId(),
          name: "queue/run/failed",
          ts: started.ts,
          data: {
            run: data.run.id,
            error: { code: "stale-pr", message: "PR changed before the requested Job started" },
          },
        },
      ],
    })
  })
}

function legacyQuiesceAfterJobEvictionHistoryFrames(count: number): readonly JournalFrame[] {
  return legacyQueueHistoryFrames(count).map((frame, index) => {
    if (index !== 0) return frame
    const recoverable = structuredClone(frame)
    const finish = recoverable.events.find((event) => {
      const data = event.data as { type?: unknown }
      return event.name === "job/transitioned" && data.type === "finish"
    })
    if (finish === undefined) {
      throw new Error("expected terminal Job fixture")
    }
    const transition = finish.data as { result?: unknown }
    transition.result = {
      status: "completed",
      conclusion: "failure",
      error: { code: "queue-environment-refused", message: "runner unavailable during legacy delivery" },
    }
    return parseJournalFrame(recoverable)
  })
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

function queuePlugin(
  options: Readonly<{
    batch?: false | number
    check?: StepRunner<ChangeShape, CheckResult>
    merge?: (input: StepExecution<ReviewedShape>) => JobResult<IntegrationProof> | Promise<JobResult<IntegrationProof>>
    deploy?: (input: StepExecution<MergedShape>) => JobResult<DeployResult>
    checkRevision?: string
    checkClassification?: "base" | "carrier"
    requires?: readonly ["review"]
    defaultSteps?: readonly ("check" | "review" | "merge" | "deploy")[]
    resolveBaseSha?: (base: string) => string | Promise<string>
    prepareCandidate?: (input: {
      id: string
      queueId: string
      baseSha: string
      revs: readonly { pr: string; n: number; head: string }[]
      prs: readonly unknown[]
    }) =>
      | Readonly<{
          id: string
          queueId: string
          baseSha: string
          revs: readonly { pr: string; n: number; head: string }[]
          sha?: string
          ref?: string
          mergeability: "mergeable" | "conflicting"
        }>
      | Promise<
          Readonly<{
            id: string
            queueId: string
            baseSha: string
            revs: readonly { pr: string; n: number; head: string }[]
            sha?: string
            ref?: string
            mergeability: "mergeable" | "conflicting"
          }>
        >
    runner?: (jobs: Jobs) => Runner
  }> = {},
  mint: PrNumberMint = volatilePrNumberMint(),
) {
  const check = withStep(
    "check",
    (input, context): JobResult<CheckResult> | Promise<JobResult<CheckResult>> =>
      options.check?.(input, context) ?? {
        status: "completed",
        conclusion: "success",
        output: { checked: true },
      },
    {
      revision: options.checkRevision ?? "check-v1",
      output: CheckResultSchema,
      ...(options.checkClassification === undefined ? {} : { classification: options.checkClassification }),
    },
  )
  const review = withStep(
    "review",
    (_input: StepExecution<CheckedShape>): JobResult<ReviewResult> => ({
      status: "completed",
      conclusion: "success",
      output: { approved: true },
    }),
    { revision: "review-v1", output: ReviewResultSchema },
  )
  const merge = withMerge(
    async (input: StepExecution<ReviewedShape>): Promise<JobResult<IntegrationProof>> =>
      options.merge?.(input) ?? {
        status: "completed",
        conclusion: "success",
        output: { commit: MERGED, baseSha: BASE },
      },
    { revision: "merge-v1" },
  )
  const deploy = withStep(
    "deploy",
    (input: StepExecution<MergedShape>): JobResult<DeployResult> =>
      options.deploy?.(input) ?? {
        status: "completed",
        conclusion: "success",
        output: { environment: "staging" },
      },
    { revision: "deploy-v1", kind: "action", output: DeployResultSchema },
  )
  return withQueue({
    steps: [check, review, merge, deploy] as const,
    batch: options.batch ?? false,
    defaultSteps: options.defaultSteps ?? ["check", "review", "merge", "deploy"],
    ...(options.requires === undefined ? {} : { requires: options.requires }),
    resolveBaseSha: options.resolveBaseSha ?? (() => BASE),
    ...(options.prepareCandidate === undefined ? {} : { prepareCandidate: options.prepareCandidate }),
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    prNumberMint: mint,
  })
}

/**
 * S7 (branch-is-change, @i/10 22991): a derived member's number comes from ONE
 * mint — the same store the queue plugin composes with — so a fixture-derived
 * member and the compose's own derivation stay one monotone sequence instead of
 * both starting at `PR1`.
 *
 * The mint is keyed by JOURNAL, not by app, because the durable high-water is
 * now its sole authority: a replayed app rebuilt from the same journal must
 * inherit the numbers the original issued, or reusing a retained snapshot's
 * already-issued id refuses ("an id escaped without its commit"). Two apps on
 * one journal are one crash-restart of one runtime, and they share a mint the
 * way they share `pr-mint.json` in production.
 */
const journalMints = new WeakMap<object, PrNumberMint>()
const appMints = new WeakMap<object, PrNumberMint>()

function mintFor(journal: object): PrNumberMint {
  const existing = journalMints.get(journal)
  if (existing !== undefined) return existing
  const minted = volatilePrNumberMint()
  journalMints.set(journal, minted)
  return minted
}

async function createQueueApp(
  options: Parameters<typeof queuePlugin>[0] = {},
  journal = createMemoryJournal(),
  clock: () => string = () => "2026-01-01T00:00:00.000Z",
  id: () => string = ids(),
  log?: ConditionalLogger,
) {
  const mint = mintFor(journal)
  const bayJobs = createBayJobDefs(workspace())
  const queue = queuePlugin(options, mint)
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ jobs: bayJobs }),
  )
  const definition = queue(base)
  const app = await createYrd(definition, {
    inject: { journal, id, clock, log: log ?? createLogger("test", [{ level: "silent" }]) },
  })
  appMints.set(app, mint)
  return app
}

type QueueApp = Awaited<ReturnType<typeof createQueueApp>>

/** Derive the admissible member of an already-submitted branch, minting off
 * the app's own mint (see {@link appMints}). */
function memberOf(app: QueueApp, branch: string, enrichment?: DerivedSubmitEnrichment) {
  const mint = appMints.get(app)
  if (mint === undefined) throw new Error("app was not created by createQueueApp — no mint registered")
  return deriveRunMemberArgs({
    bays: app.state().bays,
    queues: app.state().queues,
    mint,
    branch,
    ...(enrichment === undefined ? {} : { enrichment }),
  })
}

/**
 * The submit fixture: write the branch's standing submit fact and hand back
 * the member the queue derives from it. Post-S7 the fact IS the delivery —
 * there is no record to mint — so callers select with
 * `{ prs: [], derived: [member] }` (explicit) or `{ derived: [member] }`
 * (implicit queue, pre-derived so the compose does not mint a second number).
 */
async function submitBranch(app: QueueApp, branch: string, base = "main") {
  const digit = (Object.keys(app.state().bays.submits).length + 1).toString(16)
  await app.bays.recordBranchSubmit({ branch, sha: digit.repeat(40), base })
  return memberOf(app, branch)
}

async function replaySameHeadCandidateRemerge() {
  const journal = createMemoryJournal()
  const id = ids()
  const prepared: string[] = []
  const prepareCandidate: NonNullable<NonNullable<Parameters<typeof queuePlugin>[0]>["prepareCandidate"]> = (input) => {
    prepared.push(input.id)
    const { prs: _prs, ...candidate } = input
    return {
      ...candidate,
      sha: MERGED,
      ref: candidateRefFor(MERGED),
      mergeability: "mergeable",
    }
  }
  const branch = "topic/same-head-candidate-recut"
  const original = await createQueueApp({ prepareCandidate }, journal, undefined, id)
  const pr = await submitBranch(original, branch)
  await original.queue.run({ prs: [], derived: [pr], steps: ["check"] }, runtime)
  // Post-S7 the same-head revision bump is the derived lane's own: re-deriving
  // the branch reuses the retained snapshot's identity and continues its
  // revision count, with the submit fact (and so the head sha) unmoved. That is
  // exactly what `bays.recut` + `bays.ready` used to mint onto the record.
  const recut = memberOf(original, branch)
  expect(recut).toMatchObject({ id: pr.id, revision: 2, headSha: pr.headSha })
  await original.close()

  const app = await createQueueApp({ prepareCandidate }, journal, undefined, id)
  return { app, pr: recut, prepared }
}

describe("Queue", () => {
  it("materializes the immutable Candidate before admitting its first Job", async () => {
    const prepared: string[] = []
    await using app = await createQueueApp({
      prepareCandidate: (input) => {
        prepared.push(input.id)
        const { prs: _prs, ...candidate } = input
        return {
          ...candidate,
          sha: MERGED,
          ref: candidateRefFor(MERGED),
          mergeability: "mergeable",
        }
      },
    })
    const pr = await submitBranch(app, "topic/materialized-candidate")

    const [run] = await app.queue.run({ prs: [], derived: [pr], steps: ["check"] }, runtime)

    expect(prepared).toEqual(["C1"])
    expect(app.state().queues.candidates[run!.candidateId]).toMatchObject({
      id: "C1",
      sha: MERGED,
      ref: candidateRefFor(MERGED),
      mergeability: "mergeable",
      revs: [{ pr: pr.id, n: 1, head: HEAD }],
    })
    expect(run?.steps[0]?.job).toMatchObject({ status: "completed", conclusion: "success" })
  })

  it("mints a fresh Candidate after a same-head PR recut survives a runtime restart", async () => {
    const fixture = await replaySameHeadCandidateRemerge()
    await using app = fixture.app

    await expect(app.queue.run({ prs: [], derived: [fixture.pr], steps: ["check"] }, runtime)).resolves.toMatchObject([
      {
        candidateId: "C2",
        prs: [{ id: fixture.pr.id, revision: 2, headSha: fixture.pr.headSha }],
        status: "completed",
        conclusion: "success",
      },
    ])
    expect(fixture.prepared).toEqual(["C1", "C2"])
    // The `candidate-revision-mismatch` finding this used to also assert-absent
    // is RETIRED (queue.ts): it compared a run's pinned member against the
    // change's CURRENT record revision, and there is no second term since S7 —
    // a member's snapshot IS its revision. The live equivalent, the fact moving
    // off the pinned sha, is `stale-pr` from `pinnedChangeError`.
  })

  // 22332, the C2465 shape: two composes that produce DIFFERENT trees are
  // published without either refusing the other. There is no retry here to make
  // that work — the ref is derived from the evidence, so the second compose
  // simply merges somewhere else. The old id-named scheme sent both to
  // refs/yrd/candidates/C<n> and the second refused itself.
  it("publishes two composes with different trees to different refs, without a refusal (22332)", async () => {
    const trees = [`${"a".repeat(39)}1`, `${"b".repeat(39)}2`]
    const prepared: string[] = []
    await using app = await createQueueApp({
      prepareCandidate: (input) => {
        // Each compose produces a different tree, exactly as a recompose over a
        // moved base does.
        const sha = trees[prepared.length] ?? trees[trees.length - 1]
        if (sha === undefined) throw new Error("test fixture exhausted its trees")
        prepared.push(input.id)
        const { prs: _prs, ...candidate } = input
        return { ...candidate, sha, ref: candidateRefFor(sha), mergeability: "mergeable" as const }
      },
    })

    const first = await submitBranch(app, "topic/self-collision-a")
    const [firstRun] = await app.queue.run({ prs: [], derived: [first], steps: ["check"] }, runtime)
    const second = await submitBranch(app, "topic/self-collision-b")
    const [secondRun] = await app.queue.run({ prs: [], derived: [second], steps: ["check"] }, runtime)

    // Neither run was refused, and both steps actually ran.
    expect(firstRun?.steps[0]?.job).toMatchObject({ status: "completed", conclusion: "success" })
    expect(secondRun?.steps[0]?.job).toMatchObject({ status: "completed", conclusion: "success" })

    // The refs differ because the evidence differs — that is the whole fix.
    const candidates = app.state().queues.candidates
    const firstCandidate = candidates[firstRun?.candidateId ?? ""]
    const secondCandidate = candidates[secondRun?.candidateId ?? ""]
    expect(firstCandidate?.ref).toBe(candidateRefFor(trees[0] ?? ""))
    expect(secondCandidate?.ref).toBe(candidateRefFor(trees[1] ?? ""))
    expect(firstCandidate?.ref).not.toBe(secondCandidate?.ref)
    // And the ref states its own evidence, so a reader never has to consult the
    // journal to know what a ref holds.
    expect(firstCandidate?.ref).toBe(candidateRefFor(firstCandidate?.sha ?? ""))
    expect(secondCandidate?.ref).toBe(candidateRefFor(secondCandidate?.sha ?? ""))
  })

  // The invariant is a real gate, not decoration: a preparer that publishes an
  // id-named ref (the pre-22332 shape) is refused rather than journaled.
  it("refuses a Candidate published at a ref that does not state its evidence (22332)", async () => {
    await using app = await createQueueApp({
      prepareCandidate: (input) => {
        const { prs: _prs, ...candidate } = input
        return {
          ...candidate,
          sha: MERGED,
          ref: `refs/yrd/candidates/${input.id}`,
          mergeability: "mergeable" as const,
        }
      },
    })
    const pr = await submitBranch(app, "topic/legacy-ref-shape")

    await expect(app.queue.run({ prs: [], derived: [pr], steps: ["check"] }, runtime)).rejects.toThrow(
      /must publish refs\/yrd\/candidates\//u,
    )
  })

  it("records a conflicting Candidate without admitting an expensive Job", async () => {
    let checkCalls = 0
    let candidatePreparations = 0
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await createQueueApp(
      {
        check: () => {
          checkCalls += 1
          return { status: "completed", conclusion: "success", output: { checked: true } }
        },
        prepareCandidate: (input) => {
          candidatePreparations += 1
          const { prs: _prs, ...candidate } = input
          return { ...candidate, mergeability: "conflicting" }
        },
      },
      undefined,
      undefined,
      undefined,
      log,
    )
    const pr = await submitBranch(app, "topic/conflicting-candidate")

    const [run] = await app.queue.run({ prs: [], derived: [pr], steps: ["check"] }, runtime)

    expect(checkCalls).toBe(0)
    expect(run).toMatchObject({
      id: "R1",
      candidateId: "C1",
      status: "completed",
      conclusion: "failure",
      jobs: [],
      error: { code: "candidate-conflicting", message: "Candidate 'C1' conflicts before Job execution" },
    })
    expect(app.state().queues.candidates.C1).toMatchObject({
      id: "C1",
      mergeability: "conflicting",
      revs: [{ pr: pr.id, n: 1, head: HEAD }],
    })
    expect(app.queue.eligibility(pr.id)).toMatchObject({
      runnable: false,
      reason: { code: "candidate-conflicting", message: "change 'PR1' revision 1 conflicts in Candidate 'C1'" },
    })
    await expect(app.queue.run({ prs: [], derived: [pr], steps: ["check"] }, runtime)).rejects.toThrow(
      "conflicts in Candidate 'C1'",
    )
    const runFailures = events.filter(
      (event) =>
        event.kind === "log" &&
        event.namespace === "yrd:queue:run" &&
        event.level === "info" &&
        event.props?.run === "R1",
    )
    expect(runFailures).toHaveLength(1)
    expect(runFailures[0]?.props).toMatchObject({
      lifecycle: "run",
      outcome: "failed",
      error: { code: "candidate-conflicting" },
    })
    expect(candidatePreparations).toBe(1)
    expect(Queues.ids(app.state().queues)).toEqual(["R1"])
    log.end()
  })

  it("settles a conflicting child Candidate as a Job-free bisection Run", async () => {
    const checked: string[][] = []
    await using app = await createQueueApp({
      batch: 2,
      check: (input) => {
        checked.push(input.prs.map((pr) => pr.id))
        return input.prs.length > 1
          ? { status: "completed", conclusion: "failure", error: { code: "check-failed", message: "bisect" } }
          : { status: "completed", conclusion: "success", output: { checked: true } }
      },
      prepareCandidate: (input) => {
        const { prs: _prs, ...candidate } = input
        const conflicting = input.revs.length === 1 && input.revs[0]?.pr === "PR1"
        return {
          ...candidate,
          ...(conflicting ? {} : { sha: MERGED, ref: candidateRefFor(MERGED) }),
          mergeability: conflicting ? "conflicting" : "mergeable",
        }
      },
    })
    const first = await submitBranch(app, "topic/conflicting-child")
    const second = await submitBranch(app, "topic/passing-child")

    const runs = await app.queue.run({ prs: [], derived: [first, second], steps: ["check"] }, runtime)

    expect(runs).toMatchObject([
      { id: "R1", status: "completed", conclusion: "failure" },
      {
        id: "R2",
        candidateId: "C2",
        parent: "R1",
        status: "completed",
        conclusion: "failure",
        jobs: [],
        error: { code: "candidate-conflicting" },
      },
      { id: "R3", candidateId: "C3", parent: "R1", status: "completed", conclusion: "success" },
    ])
    expect(checked).toEqual([["PR1", "PR2"], ["PR2"]])
    expect(Object.values(app.state().queues.candidates).map(({ id, mergeability }) => ({ id, mergeability }))).toEqual([
      { id: "C1", mergeability: "mergeable" },
      { id: "C2", mergeability: "conflicting" },
      { id: "C3", mergeability: "mergeable" },
    ])
    for (const child of runs.slice(1)) expect(child).not.toHaveProperty("isolationPart")
  })

  it("submits Candidate work through the configured Runner and Context seam", async () => {
    const submissions: RunnerSubmission[] = []
    await using app = await createQueueApp({
      prepareCandidate: (input) => {
        const { prs: _prs, ...candidate } = input
        return {
          ...candidate,
          sha: MERGED,
          ref: candidateRefFor(MERGED),
          mergeability: "mergeable",
        }
      },
      runner: (jobs) => {
        const runner = localRunner({ id: "composed-runner", jobs, leaseMs: 60_000, maxInFlight: 2 })
        return {
          ...runner,
          submit(input) {
            submissions.push(input)
            return runner.submit(input)
          },
        }
      },
    })
    const pr = await submitBranch(app, "topic/runner-candidate-context")

    const [run] = await app.queue.run({ prs: [], derived: [pr], steps: ["check"] }, runtime)

    expect(submissions).toEqual([
      {
        job: run?.steps[0]?.job?.id,
        candidateRef: candidateRefFor(MERGED),
        context: { scope: "job", candidate: "rw", capabilities: ["git"] },
      },
    ])
    expect(run?.steps[0]?.job).toMatchObject({ runner: "composed-runner", context: "composed-runner:context:1" })
  })

  it("persists one StepDef kind instead of parallel integration booleans", async () => {
    await using app = await createQueueApp()

    expect(app.queue.steps()).toMatchObject([
      { name: "check", kind: "check" },
      { name: "review", kind: "check" },
      { name: "merge", kind: "merge" },
      { name: "deploy", kind: "action" },
    ])
    for (const step of app.queue.steps()) {
      expect(step).not.toHaveProperty("integrates")
      expect(step).not.toHaveProperty("needsIntegration")
    }
  })

  it("runs checks across independent bases concurrently under Runner admission", async () => {
    const entered = new Set<string>()
    const bothEntered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    await using app = await createQueueApp({
      check: async (input) => {
        const base = input.prs[0]?.base
        if (base === undefined) throw new Error("check lost its base")
        entered.add(base)
        if (entered.size === 2) bothEntered.resolve()
        await release.promise
        return { status: "completed", conclusion: "success", output: { checked: true } }
      },
    })
    const main = await submitBranch(app, "topic/main-check", "main")
    const releaseBranch = await submitBranch(app, "topic/release-check", "release")

    const running = Promise.all([
      app.queue.run({ prs: [], derived: [main], steps: ["check"] }, runtime),
      app.queue.run({ prs: [], derived: [releaseBranch], steps: ["check"] }, runtime),
    ])
    await bothEntered.promise
    expect([...entered].toSorted()).toEqual(["main", "release"])
    release.resolve()
    await expect(running).resolves.toMatchObject([
      [{ status: "completed", conclusion: "success" }],
      [{ status: "completed", conclusion: "success" }],
    ])
  })

  it("serializes merge Jobs for Candidates targeting the same base", async () => {
    let activeMerges = 0
    let peakMerges = 0
    await using app = await createQueueApp({
      merge: async () => {
        activeMerges += 1
        peakMerges = Math.max(peakMerges, activeMerges)
        await new Promise((resolve) => setTimeout(resolve, 5))
        activeMerges -= 1
        return { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
      },
    })
    const first = await submitBranch(app, "topic/first-merge")
    const second = await submitBranch(app, "topic/second-merge")

    const runs = await app.queue.run({ prs: [], derived: [first, second] }, runtime)

    expect(runs).toHaveLength(2)
    expect(runs.every((run) => run.status === "completed" && run.conclusion === "success")).toBe(true)
    expect(peakMerges).toBe(1)
  })

  it("projects immutable Candidates separately from GitHub-shaped Runs", async () => {
    await using app = await createQueueApp()
    const pr = await submitBranch(app, "topic/target-model")

    const [run] = await app.queue.run({ derived: [pr], steps: ["check"] }, runtime)

    expect(app.state().queues.candidates).toMatchObject({
      C1: {
        id: "C1",
        queueId: "main",
        baseSha: BASE,
        revs: [{ pr: "PR1", n: 1, head: HEAD }],
        mergeability: "unknown",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    })
    expect(run).toMatchObject({
      id: "R1",
      queueId: "main",
      candidateId: "C1",
      jobs: [expect.any(String)],
    })
  })

  it("replays legacy batch Runs whose PR results recorded different base SHAs", async () => {
    const nextId = ids(900)
    const command = { id: nextId(), op: "queue.run", args: { prs: ["PR1", "PR2"] } }
    const journal = createMemoryJournal([
      {
        cause: {
          id: nextId(),
          commandId: command.id,
          op: command.op,
          commandHash: Command.hash(command),
        },
        command,
        events: [
          {
            id: nextId(),
            name: "queue/run/started",
            ts: "2026-01-01T00:00:00.000Z",
            data: {
              run: {
                id: "R1",
                prs: [
                  { id: "PR1", branch: "topic/one", base: "main", revision: 1, headSha: HEAD, baseSha: BASE },
                  {
                    id: "PR2",
                    branch: "topic/two",
                    base: "main",
                    revision: 1,
                    headSha: MERGED,
                    baseSha: UPDATED,
                  },
                ],
                base: "main",
                steps: [{ name: "check", title: "Check", revision: "check-v1", kind: "check" }],
              },
            },
          },
        ],
      },
    ])

    await using app = await createQueueApp({}, journal)

    expect(app.state().queues.candidates.C1).toMatchObject({
      id: "C1",
      baseSha: BASE,
      mergeability: "unknown",
      revs: [
        { pr: "PR1", n: 1, head: HEAD },
        { pr: "PR2", n: 1, head: MERGED },
      ],
    })
    expect(Queues.get(app.state().queues, "R1")?.prs.map((pr) => pr.baseSha)).toEqual([BASE, BASE])
  })

  it("retains every live Queue aggregate and only the latest 512 terminal aggregates", () => {
    let queues = Queues.empty({ batchSize: 1 })
    const terminalOrder: Record<string, number> = {}
    const record = (id: string): QueueRecord => ({
      id,
      settlement: "explicit",
      queueId: "main",
      candidateId: `C${id.slice(1)}`,
      prs: [{ id: `PR-${id}`, branch: `task/${id}`, base: "main", revision: 1, headSha: HEAD, baseSha: BASE }],
      base: "main",
      steps: [
        {
          name: "check",
          title: "Check",
          revision: "check-v1",
          kind: "check",
        },
      ],
      initialResults: {},
      stepSelection: { authority: "admission", steps: ["check"] },
      startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, Number(id.slice(1)))).toISOString(),
      failure: {
        at: new Date(Date.UTC(2026, 0, 1, 0, 0, Number(id.slice(1)))).toISOString(),
        error: { code: "fixture", message: "terminal fixture" },
      },
    })
    for (let index = 0; index < 513; index += 1) {
      const value = record(`R${index + 1}`)
      const started = indexQueueStart(queues.index, value)
      queues = {
        ...queues,
        records: Queues.set(queues.records, value),
        index: recordReleasedAdmissionFailure(started, value),
      }
      terminalOrder[value.id] = index + 1
    }
    const live = { ...record("R514"), failure: undefined }
    queues = { ...queues, records: Queues.set(queues.records, live), index: indexQueueStart(queues.index, live) }

    const compacted = compactQueuesState({ ...queues, retention: { terminalOrder } })
    expect(Queues.get(compacted, "R1")).toBeUndefined()
    expect(Queues.get(compacted, "R2")).toBeDefined()
    expect(Queues.get(compacted, "R513")).toBeDefined()
    expect(Queues.get(compacted, "R514")).toBeDefined()
    expect(Queues.values(compacted)).toHaveLength(513)
    expect(compacted.index.nextRunNumber).toBe(515)

    const protectedCompaction = compactQueuesState({ ...queues, retention: { terminalOrder } }, new Set(["R1"]))
    const protectedRun = Queues.get(protectedCompaction, "R1")
    if (protectedRun?.prs[0] === undefined) throw new Error("expected protected R1 admission evidence")
    expect(releasedAdmissionFailures(protectedCompaction.index, protectedRun.prs[0], protectedRun.steps)).toBe(1)
    expect(Queues.values(protectedCompaction)).toHaveLength(514)

    let trees = Queues.empty({ batchSize: 1 })
    const root = record("R1")
    const child = { ...record("R2"), parent: root.id, isolationPart: 0 as const }
    for (const value of [root, child]) {
      trees = { ...trees, records: Queues.set(trees.records, value), index: indexQueueStart(trees.index, value) }
    }
    const rootOrder: Record<string, number> = { R1: 1 }
    for (let index = 0; index < 512; index += 1) {
      const value = record(`R${index + 3}`)
      trees = { ...trees, records: Queues.set(trees.records, value), index: indexQueueStart(trees.index, value) }
      rootOrder[value.id] = index + 2
    }
    const liveRoot = { ...record("R515"), failure: undefined }
    const liveChild = { ...record("R516"), failure: undefined, parent: liveRoot.id, isolationPart: 0 as const }
    for (const value of [liveRoot, liveChild]) {
      trees = { ...trees, records: Queues.set(trees.records, value), index: indexQueueStart(trees.index, value) }
    }

    const compactedTrees = compactQueuesState({ ...trees, retention: { terminalOrder: rootOrder } })
    expect(Queues.get(compactedTrees, "R1")).toBeUndefined()
    expect(Queues.get(compactedTrees, "R2")).toBeUndefined()
    expect(Queues.get(compactedTrees, "R515")).toBeDefined()
    expect(Queues.get(compactedTrees, "R516")).toBeDefined()
    expect(Queues.values(compactedTrees)).toHaveLength(514)
  })

  it("materializes an evicted Queue run and complete history without repopulating live state", async () => {
    await using app = await createQueueApp(
      { defaultSteps: ["check"] },
      indexedJournal(queueHistoryFrames(513)),
      undefined,
      undefined,
      createLogger("test", [{ level: "error" }, { write() {} }]),
    )

    expect(Queues.get(app.state().queues, "R1")).toBeUndefined()
    expect(app.state().jobs.byKey["queue:R1:0"]).toBeUndefined()
    expect(app.queue.retentionDiagnostics()).toEqual({
      retainedRuns: 512,
      unsettledTrees: 0,
      terminalTrees: 512,
      archiveAvailable: true,
    })
    expect(app.jobs.retentionDiagnostics()).toEqual({
      retainedJobs: 512,
      liveJobs: 0,
      standaloneTerminalJobs: 0,
      queueJobs: 512,
      terminalQueueRoots: 512,
    })
    expect(app.queue.get("R1")).toMatchObject({
      id: "R1",
      status: "completed",
      conclusion: "success",
      steps: [{ job: { status: "completed", conclusion: "success" } }],
    })
    expect(Queues.get(app.state().queues, "R1")).toBeUndefined()
    expect(app.state().jobs.byKey["queue:R1:0"]).toBeUndefined()
    const history = await app.queue.history()
    expect(history).toHaveLength(513)
    expect(history[0]).toMatchObject({ id: "R1", status: "completed", conclusion: "success" })
    expect(history.at(-1)).toMatchObject({ id: "R513", status: "completed", conclusion: "success" })
    expect(Queues.get(app.state().queues, "R1")).toBeUndefined()
  }, 15_000)

  it("bounds a retried archived Queue Job separately and replays the same detached classification", async () => {
    const journal = indexedJournal(queueHistoryFrames(513, 1))
    const log = createLogger("test", [{ level: "error" }, { write() {} }])
    const app = await createQueueApp({ defaultSteps: ["check"] }, journal, undefined, ids(100_000), log)
    const archived = app.queue.get("R1")
    const job = archived?.steps[0]?.job
    if (job?.status !== "completed" || job.conclusion !== "failure") {
      throw new Error("expected archived failed Queue Job")
    }

    await app.jobs.retry(job.id)
    await app.jobs.run(job.id, { runner: "retry", leaseMs: 60_000 })
    expect(Queues.get(app.state().queues, "R1")).toBeUndefined()
    expect(app.jobs.retentionDiagnostics()).toEqual({
      retainedJobs: 513,
      liveJobs: 0,
      standaloneTerminalJobs: 1,
      queueJobs: 512,
      terminalQueueRoots: 512,
    })
    expect(app.queue.get("R1")?.steps[0]?.job).toMatchObject({
      id: job.id,
      status: "completed",
      conclusion: "success",
      attempt: 2,
    })
    await app.close()

    await using replayed = await createQueueApp({ defaultSteps: ["check"] }, journal, undefined, ids(200_000), log)
    expect(Queues.get(replayed.state().queues, "R1")).toBeUndefined()
    expect(replayed.jobs.retentionDiagnostics()).toEqual({
      retainedJobs: 513,
      liveJobs: 0,
      standaloneTerminalJobs: 1,
      queueJobs: 512,
      terminalQueueRoots: 512,
    })
    expect(replayed.queue.get("R1")?.steps[0]?.job).toMatchObject({
      id: job.id,
      status: "completed",
      conclusion: "success",
      attempt: 2,
    })
  }, 15_000)

  it("bounds quiesced pre-settlement Queue history after validating the complete replay", async () => {
    await using app = await createQueueApp(
      { defaultSteps: ["check"] },
      indexedJournal(legacyQueueHistoryFrames(513)),
      undefined,
      undefined,
      createLogger("test", [{ level: "error" }, { write() {} }]),
    )

    expect(Queues.get(app.state().queues, "R1")).toBeUndefined()
    expect(app.state().jobs.byKey["queue:R1:0"]).toBeUndefined()
    expect(app.queue.retentionDiagnostics()).toMatchObject({
      retainedRuns: 512,
      unsettledTrees: 0,
      terminalTrees: 512,
    })
    expect(app.jobs.retentionDiagnostics()).toMatchObject({
      retainedJobs: 512,
      liveJobs: 0,
      queueJobs: 512,
      terminalQueueRoots: 512,
    })
    expect(app.queue.get("R1")).toMatchObject({ id: "R1", status: "completed", conclusion: "success" })
  }, 15_000)

  it("co-evicts failed legacy Queue roots and their never-started Jobs", async () => {
    await using app = await createQueueApp(
      { defaultSteps: ["check"] },
      indexedJournal(legacyFailedBeforeStartHistoryFrames(513)),
      undefined,
      undefined,
      createLogger("test", [{ level: "error" }, { write() {} }]),
    )

    expect(Queues.get(app.state().queues, "R1")).toBeUndefined()
    expect(app.state().jobs.byKey["queue:R1:0"]).toBeUndefined()
    expect(Queues.get(app.state().queues, "R2")).toBeDefined()
    expect(app.state().jobs.byKey["queue:R2:0"]).toBeDefined()
    expect(app.queue.retentionDiagnostics()).toMatchObject({ retainedRuns: 512, terminalTrees: 512 })
    expect(app.jobs.retentionDiagnostics()).toMatchObject({
      retainedJobs: 512,
      liveJobs: 0,
      queueJobs: 512,
      terminalQueueRoots: 512,
    })
  }, 15_000)

  it("gives a terminal legacy Queue fact without a Job order the oldest replay order", async () => {
    const fixture = legacyFailedBeforeStartHistoryFrames(1)[0]
    if (fixture === undefined) throw new Error("expected legacy Queue fixture")
    const terminalWithoutJob = parseJournalFrame({
      ...fixture,
      events: fixture.events.filter(({ name }) => name !== "job/requested"),
    })

    await using app = await createQueueApp(
      { defaultSteps: ["check"] },
      indexedJournal([terminalWithoutJob]),
      undefined,
      undefined,
      createLogger("test", [{ level: "error" }, { write() {} }]),
    )

    expect(app.queue.get("R1")).toMatchObject({
      id: "R1",
      status: "completed",
      conclusion: "failure",
      error: { code: "stale-pr" },
    })
    expect(app.state().queues.retention.terminalOrder.R1).toBe(0)
    expect(app.state().jobs.retention.queueTerminalOrder.R1).toBeUndefined()
  })

  it("quiesces a legacy root after its terminal Jobs aged out", async () => {
    await using app = await createQueueApp(
      { defaultSteps: ["check"] },
      indexedJournal(legacyQuiesceAfterJobEvictionHistoryFrames(513)),
      undefined,
      ids(2_000_000),
      createLogger("test", [{ level: "error" }, { write() {} }]),
    )

    expect(Queues.get(app.state().queues, "R1")).toBeDefined()
    expect(app.state().jobs.byKey["queue:R1:0"]).toBeUndefined()
    expect(app.state().jobs.retention.queueTerminalOrder.R1).toBeUndefined()

    await expect(
      app.queue.quiesceLegacyRoots({ now: "2026-01-01T01:00:00.000Z", by: "yrd/migration" }),
    ).resolves.toEqual({
      provenance: "migration/21012-legacy-quiesce",
      reason: "legacy-quiesced",
      quiesced: [{ run: "R1", jobs: [] }],
    })
    expect(app.queue.get("R1")).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "legacy-quiesced" },
    })
    expect(app.state().jobs.retention.queueTerminalOrder.R1).toBeDefined()
  }, 15_000)

  it("skips a planned legacy root that compaction evicts while quiescence is in progress", async () => {
    const history = queueHistoryFrames(514)
    const first = history[0]
    const second = history[1]
    const concurrentTerminal = history[513]
    if (first === undefined || second === undefined || concurrentTerminal === undefined) {
      throw new Error("expected legacy Queue compaction fixtures")
    }
    const legacyTarget = (frame: JournalFrame, retainTerminalOrder: boolean): JournalFrame => {
      const legacy = structuredClone(frame)
      for (const applied of legacy.events) {
        if (applied.name !== "queue/run/started") continue
        const data = applied.data as { run?: { settlement?: unknown } }
        if (data.run !== undefined) delete data.run.settlement
      }
      return parseJournalFrame({
        ...legacy,
        events: legacy.events.filter((applied) => {
          const data = applied.data as { type?: unknown }
          if (applied.name === "job/transitioned" && data.type === "finish") return false
          return retainTerminalOrder || applied.name !== "queue/run/settled"
        }),
      })
    }
    const inner = indexedJournal([legacyTarget(first, false), legacyTarget(second, true), ...history.slice(2, 513)])
    let injected = false
    const journal: Journal<unknown> = {
      ...inner,
      async append(value, expectedCursor) {
        const appended = await inner.append(value, expectedCursor)
        const frame = parseJournalFrame(value)
        if (appended.appended && !injected && frame.events.some(({ name }) => name === "queue/run/failed")) {
          injected = true
          const concurrent = await inner.append(concurrentTerminal, appended.cursor)
          if (!concurrent.appended) throw new Error("expected concurrent terminal Queue fixture to append")
        }
        return appended
      },
    }

    await using app = await createQueueApp(
      { defaultSteps: ["check"] },
      journal,
      undefined,
      ids(3_000_000),
      createLogger("test", [{ level: "error" }, { write() {} }]),
    )

    expect(app.queue.get("R1")).toMatchObject({ status: "in_progress" })
    expect(app.queue.get("R2")).toMatchObject({ status: "in_progress" })
    await expect(
      app.queue.quiesceLegacyRoots({ now: "2026-01-01T01:00:00.000Z", by: "yrd/migration" }),
    ).resolves.toMatchObject({ quiesced: [{ run: "R1" }] })
    expect(injected).toBe(true)
    expect(Queues.get(app.state().queues, "R2")).toBeUndefined()
  }, 15_000)

  it("skips a planned stale batch that an earlier retirement evicts at the retention boundary", async () => {
    const history = queueHistoryFrames(514)
    const first = history[0]
    const oldRoot = history[1]
    const oldChild = history[2]
    if (first === undefined || oldRoot === undefined || oldChild === undefined) {
      throw new Error("expected stale-plan compaction fixtures")
    }
    // R2 is the oldest retained terminal tree; its unresolved child R3 is a
    // planned stale batch. R1 is deliberately replayed last, so retiring it
    // adds the 513th terminal tree and compacts R2/R3 before recovery reaches
    // its already-planned R3 entry — the live R523 -> R533 startup sequence.
    const journal = indexedJournal([
      oldRoot,
      staleLegacyBatchFrame(oldChild, "R2"),
      ...history.slice(3),
      staleLegacyBatchFrame(first),
    ])
    await using app = await createQueueApp(
      { defaultSteps: ["check"], checkRevision: "check-v2" },
      journal,
      undefined,
      ids(4_000_000),
      createLogger("test", [{ level: "error" }, { write() {} }]),
    )

    expect(
      app.queue
        .audit()
        .findings.filter(({ code }) => code === "unisolable-stale-plan")
        .map(({ run }) => run),
    ).toEqual(["R1", "R3"])

    await expect(
      app.queue.recover({ recoveryTime: "2026-01-01T01:00:00.000Z", reason: "startup retention hygiene" }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "R1", error: expect.objectContaining({ code: "stale-plan" }) }),
      ]),
    )
    expect(Queues.get(app.state().queues, "R3")).toBeUndefined()
  }, 15_000)

  it("resolves PR, Run, and base selectors while preserving canonical records", async () => {
    await using app = await createQueueApp()
    const pr = await submitBranch(app, "Topic/Selectors")

    // The selector STAYS: this test's subject is that every selector surface
    // resolves case-insensitively to one canonical record. `derived` supplies
    // the batch the selector must resolve WITHIN (post-S7 a selector resolves
    // against the run's own derived batch, never a store).
    const runs = await app.queue.run({ prs: ["pr1"], derived: [pr], steps: ["check"] }, runtime)
    expect(runs).toMatchObject([{ id: "R1", prs: [{ id: "PR1", base: "main" }] }])
    expect(app.queue.get("r1")).toMatchObject({ id: "R1", prs: [{ id: "PR1" }] })
    expect(app.queue.status("MAIN")).toMatchObject({ base: "main", finished: [{ id: "R1" }] })
    expect(app.queue.status("ORIGIN/MAIN")).toMatchObject({ base: "main", finished: [{ id: "R1" }] })
    // GRANDFATHER (S7) — do NOT read this passing `[]` as evidence the live
    // authority projection works. `activeQueueRootIds` iterates
    // `authority.claims` only, and post-S7 `claims` is never written at all:
    // its writers are the `pr/submitted` / `pr/checks-requested` reducers,
    // which are now bare `return state`. So this assertion holds for the wrong
    // reason and would hold no matter what the queue did.
    // Left standing on @chief's instruction rather than flipped: the sibling
    // at "removes ordinary failed roots from the live authority projection
    // after settlement" is the more dangerous one, because that test is fully
    // GREEN. See its note for the measurement.
    expect(activeQueueRootIds(app.state().queues.authority)).toEqual([])
  })

  it("accepts the printed `<base>#<number>` run reference the timeline and queue views teach", async () => {
    await using app = await createQueueApp()
    const pr = await submitBranch(app, "topic/printed-run-ref")

    await app.queue.run({ derived: [pr], steps: ["check"] }, runtime)
    expect(app.queue.get("main#1")).toMatchObject({ id: "R1" })
    expect(app.queue.get("MAIN#1")).toMatchObject({ id: "R1" })
    expect(app.queue.get("other#1")).toBeUndefined()
    // The label-elided `#N` form the single-queue watch prints (operator
    // rulings 2026-08-18, items 34/38) resolves when unambiguous in this
    // repository; the shared selector machinery refuses loudly when two
    // bases share the number.
    expect(app.queue.get("#1")).toMatchObject({ id: "R1" })
  })

  it("resolves a canonical Queue run without enumerating history while preserving selector fallback", async () => {
    await using app = await createQueueApp()
    const pr = await submitBranch(app, "issue/bounded-run-resolution")
    await app.queue.run({ prs: [], derived: [pr], steps: ["check"] }, runtime)
    const target = Queues.get(app.state().queues, "R1")
    if (target === undefined) throw new Error("expected canonical R1")

    let records = app.state().queues.records
    for (let index = 0; index < 1_380; index += 1) {
      const id = `R${index + 2}`
      records = projectionLookupSet(records, id, { ...target, id })
    }
    records = deepFreeze(records)

    const exactCounters: LookupCounters = { reads: 0, enumerations: 0 }
    const exactState = {
      ...app.state().queues,
      records: observeProjectionLookup(records, exactCounters),
    }
    expect(Queues.resolve(exactState, "R1")?.id).toBe("R1")
    expect(exactCounters.enumerations).toBe(0)
    expect(exactCounters.reads).toBeLessThanOrEqual(256)

    const fallbackCounters: LookupCounters = { reads: 0, enumerations: 0 }
    const fallbackState = {
      ...app.state().queues,
      records: observeProjectionLookup(records, fallbackCounters),
    }
    expect(Queues.resolve(fallbackState, "r1")?.id).toBe("R1")
    expect(fallbackCounters.enumerations).toBeGreaterThan(0)
  })

  it("removes ordinary failed roots from the live authority projection after settlement", async () => {
    await using app = await createQueueApp({
      check: () => ({
        status: "completed",
        conclusion: "failure",
        error: { code: "check-failed", message: "tests failed" },
      }),
    })
    const pr = await submitBranch(app, "issue/settled-failure")

    await expect(app.queue.run({ prs: [], derived: [pr], steps: ["check"] }, runtime)).resolves.toMatchObject([
      { id: "R1", status: "completed", conclusion: "failure" },
    ])
    // GRANDFATHER (S7) — this test is GREEN and it is blessing a defect. The
    // `[]` below is not "the root was removed after settlement"; the live
    // authority projection is empty at ALL times post-S7, so this assertion
    // cannot distinguish a correctly-retired root from one that was never
    // recorded. Measured directly, on a root that is LIVE rather than settled
    // — a check-only run parked `waiting` on an external token, exactly the
    // shape `queue.recover` exists to reclaim:
    //     runs        [["R1","waiting"]]
    //     claims      {}
    //     activeRoots []
    //     recover()   []
    // `authority.claims` is never written because its writers, the
    // `pr/submitted` and `pr/checks-requested` reducers, are bare
    // `return state` since S7. Every consumer keyed on it reads "nothing
    // active": `activeQueueRootIds` (projection-index.ts), `queue.recover`'s
    // ownership capture, and the settled command's `claimed` guard — which is
    // why a settled run also journals no `queue/run/settled`.
    //
    // DO NOT flip this to a non-empty expectation to "fix" it. The two tests
    // that DO expect non-empty here — "releases a replayed terminal root after
    // a crash before its settled event" and "resumes one waiting deploy-only
    // run for an already integrated change" — are the real acceptance, and
    // both are red (each failing earlier, for its own reason).
    expect(activeQueueRootIds(app.state().queues.authority)).toEqual([])
  })

  it("drains the next submitted PR after releasing a passed check-only root", async () => {
    await using app = await createQueueApp({ defaultSteps: ["check"] })
    const habitantFirst = await submitBranch(app, "issue/habitant-first")

    await expect(app.queue.run({ derived: [habitantFirst] }, runtime)).resolves.toMatchObject([
      { id: "R1", status: "completed", conclusion: "success" },
    ])
    const habitantSecond = await submitBranch(app, "issue/habitant-second")

    await expect(app.queue.run({ derived: [habitantSecond] }, runtime)).resolves.toMatchObject([
      { id: "R2", status: "completed", conclusion: "success" },
    ])
    expect(Queues.ids(app.state().queues)).toEqual(["R1", "R2"])
  })

  it("releases a replayed terminal root after a crash before its settled event", async () => {
    const inner = createMemoryJournal()
    let refuseSettlement = true
    const journal: typeof inner = {
      read: (after, before) => inner.read(after, before),
      append: (value, cursor) => {
        const frame = value as { events?: readonly { name?: string }[] }
        if (refuseSettlement && frame.events?.some((event) => event.name === "queue/run/settled")) {
          refuseSettlement = false
          throw new Error("yrd: settled append refused (injected crash)")
        }
        return inner.append(value, cursor)
      },
    }
    const id = ids()

    {
      await using app = await createQueueApp({}, journal, undefined, id)
      const pr = await submitBranch(app, "issue/settled-crash-gap")
      await expect(app.queue.run({ prs: [], derived: [pr], steps: ["check"] }, runtime)).rejects.toThrow("settled append refused")
      expect(app.queue.get("R1")).toMatchObject({
        status: "completed",
        conclusion: "success",
        steps: [{ job: { status: "completed", conclusion: "success" } }],
      })
      expect(activeQueueRootIds(app.state().queues.authority)).toEqual(["R1"])
    }

    await using replayed = await createQueueApp({}, journal, undefined, id)
    expect(activeQueueRootIds(replayed.state().queues.authority)).toEqual(["R1"])
    const before = await Array.fromAsync(replayed.events())
    await expect(replayed.queue.recover({ recoveryTime: "2026-01-01T00:01:00.000Z" })).resolves.toEqual([
      expect.objectContaining({ id: "R1", status: "completed", conclusion: "success" }),
    ])
    expect(activeQueueRootIds(replayed.state().queues.authority)).toEqual([])
    expect(Queues.ids(replayed.state().queues)).toEqual(["R1"])
    const appended = (await Array.fromAsync(replayed.events())).slice(before.length)
    expect(appended.map(({ name }) => name)).toEqual(["queue/run/settled"])
  })

  it("does not manufacture active roots when replaying terminal pre-settlement journals", async () => {
    const inner = createMemoryJournal()
    let refuseSettlement = true
    const journal: typeof inner = {
      read: (after, before) => inner.read(after, before),
      append: (value, cursor) => {
        const frame = structuredClone(value) as {
          events?: { name?: string; data?: { run?: Record<string, unknown> } }[]
        }
        for (const event of frame.events ?? []) {
          if (event.name === "queue/run/started" && event.data?.run !== undefined) {
            delete event.data.run.settlement
          }
        }
        if (refuseSettlement && frame.events?.some((event) => event.name === "queue/run/settled")) {
          refuseSettlement = false
          throw new Error("yrd: settled append refused (legacy fixture boundary)")
        }
        return inner.append(frame, cursor)
      },
    }
    const id = ids()

    {
      await using app = await createQueueApp({}, journal, undefined, id)
      const pr = await submitBranch(app, "issue/legacy-terminal-root")
      await expect(app.queue.run({ prs: [], derived: [pr], steps: ["check"] }, runtime)).rejects.toThrow(
        "legacy fixture boundary",
      )
    }

    await using replayed = await createQueueApp({}, journal, undefined, id)
    expect(replayed.queue.get("R1")).toMatchObject({ status: "completed", conclusion: "success" })
    expect(activeQueueRootIds(replayed.state().queues.authority)).toEqual([])
    const before = await Array.fromAsync(replayed.events())
    await expect(replayed.queue.recover({ recoveryTime: "2026-01-01T00:01:00.000Z" })).resolves.toEqual([])
    expect(await Array.fromAsync(replayed.events())).toEqual(before)
  })

  // A legacy (pre-settlement) journal whose single writer died mid-step: the first
  // job `finish` is refused, leaving the run's cursor job `in_progress` under a
  // lease. Strips the v2 settlement marker off every started run so the root
  // replays as a v1 root. The lease clock is pinned so expiry is deterministic.
  const LEASE_AT = Date.parse("2026-01-01T00:00:00.000Z")
  const leasedRuntime = { runner: "local", leaseMs: 60_000, now: () => LEASE_AT } // lease expires at 00:01:00
  function legacyStuckJournal() {
    const inner = createMemoryJournal()
    let refuse = true
    const journal: typeof inner = {
      read: (after, before) => inner.read(after, before),
      append: (value, cursor) => {
        const frame = structuredClone(value) as {
          events?: { name?: string; data?: { run?: Record<string, unknown>; type?: string } }[]
        }
        for (const event of frame.events ?? []) {
          if (event.name === "queue/run/started" && event.data?.run !== undefined) {
            delete event.data.run.settlement
          }
        }
        if (
          refuse &&
          frame.events?.some((event) => event.name === "job/transitioned" && event.data?.type === "finish")
        ) {
          refuse = false
          throw new Error("yrd: job finish refused (legacy fixture)")
        }
        return inner.append(frame, cursor)
      },
    }
    return journal
  }

  async function seedLegacyStuckRoot(journal: ReturnType<typeof legacyStuckJournal>, id: () => string, branch: string) {
    await using app = await createQueueApp({}, journal, undefined, id)
    const pr = await submitBranch(app, branch)
    await expect(app.queue.run({ prs: [], derived: [pr], steps: ["check"] }, leasedRuntime)).rejects.toThrow("job finish refused")
  }

  it("auto-quiesces an unleased pre-settlement legacy root and results it", async () => {
    // The writer's lease (00:01:00) is long expired by migration time (00:05:00):
    // the root is abandoned, so the migration settles it itself — no verb, no
    // waiting on a writer that will never return.
    const journal = legacyStuckJournal()
    const id = ids()
    await seedLegacyStuckRoot(journal, id, "issue/legacy-unleased-root")

    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using replayed = await createQueueApp({}, journal, undefined, id, log)

    // Cold replay/migration completes: construction no longer refuses the unleased root.
    const stuck = replayed.queue.get("R1")
    expect(stuck?.status).toBe("in_progress")
    const cursorJob = stuck?.steps[stuck.cursor]?.job
    expect(cursorJob?.status).toBe("in_progress")

    const result = await replayed.queue.quiesceLegacyRoots({ now: "2026-01-01T00:05:00.000Z", by: "yrd/migration" })
    expect(result.reason).toBe("legacy-quiesced")
    expect(result.quiesced).toEqual([{ run: "R1", jobs: [cursorJob?.id] }])

    const settled = replayed.queue.get("R1")
    expect(settled).toMatchObject({ status: "completed", conclusion: "failure" })
    expect(settled?.error?.code).toBe("legacy-quiesced")
    expect(settled?.steps[0]?.job).toMatchObject({ status: "completed", conclusion: "cancelled" })

    const results = events.filter(
      (event): event is Extract<LogEvent, { kind: "log" }> =>
        event.kind === "log" && event.level === "warn" && event.namespace === "yrd:queue",
    )
    expect(results).toHaveLength(1)
    expect(results[0]?.message).toContain("R1")
    expect(results[0]?.props).toMatchObject({ reason: "legacy-quiesced", runs: ["R1"] })
    log.end()
  })

  it("refuses to quiesce a live-leased pre-settlement legacy root", async () => {
    // The old writer started the step and still holds an unexpired lease: a
    // genuinely-active previous writer must be protected, not settled out from
    // under it. The refusal names WHICH root is leased.
    const journal = legacyStuckJournal()
    const id = ids()
    await seedLegacyStuckRoot(journal, id, "issue/legacy-leased-root")

    await using replayed = await createQueueApp({}, journal, undefined, id)
    expect(replayed.state().jobs.retention.legacyQueueRoots.R1).toBe(true)
    expect(replayed.state().jobs.retention.queueRoots.R1).toBe("R1")
    expect(replayed.state().jobs.retention.queueTerminalOrder.R1).toBeUndefined()
    // Lease expires at 00:01:00; migrate at 00:00:30 while it is still live.
    await expect(
      replayed.queue.quiesceLegacyRoots({ now: "2026-01-01T00:00:30.000Z", by: "yrd/migration" }),
    ).rejects.toThrow(/live-leased legacy roots[^]*R1[^]*auto-quiesced/)
    expect(replayed.queue.get("R1")).toMatchObject({ status: "in_progress" })
  })

  it("quiesces legacy roots idempotently across replays", async () => {
    const journal = legacyStuckJournal()
    const id = ids()
    await seedLegacyStuckRoot(journal, id, "issue/legacy-idempotent-root")

    {
      await using first = await createQueueApp({}, journal, undefined, id)
      const result = await first.queue.quiesceLegacyRoots({ now: "2026-01-01T00:05:00.000Z", by: "yrd/migration" })
      expect(result.quiesced.map((entry) => entry.run)).toEqual(["R1"])
    }

    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using second = await createQueueApp({}, journal, undefined, id, log)
    // The first pass appended the terminal settlement, so the replay meets R1 already terminal.
    expect(second.queue.get("R1")).toMatchObject({ status: "completed", conclusion: "failure" })
    const before = await Array.fromAsync(second.events())
    const result = await second.queue.quiesceLegacyRoots({ now: "2026-01-01T00:06:00.000Z", by: "yrd/migration" })
    expect(result.quiesced).toEqual([])
    expect(await Array.fromAsync(second.events())).toEqual(before)
    const results = events.filter(
      (event) => event.kind === "log" && event.level === "warn" && event.namespace === "yrd:queue",
    )
    expect(results).toEqual([])
    log.end()
  })

  it.each([10, 10_000, 100_000])(
    "advances one canonical run without enumerating %i historical runs",
    async (historicalRuns) => {
      await using app = await createQueueApp()
      const pr = await submitBranch(app, "issue/bounded-advance")
      await app.queue.run({ prs: [], derived: [pr], steps: ["check"] }, runtime)
      const records = app.state().queues.records
      const target = Queues.get(app.state().queues, "R1")
      if (target === undefined) throw new Error("expected canonical R1")
      const history = Array.from(
        { length: historicalRuns },
        (_, index): QueueRecord => ({ ...target, id: `R${index + 2}` }),
      )
      let enumerations = 0
      const originalValues = Object.values
      const values = vi.spyOn(Object, "values").mockImplementation(((value: object) => {
        if (value === records) {
          enumerations += 1
          return [target, ...history]
        }
        return originalValues(value)
      }) as typeof Object.values)
      try {
        await app.dispatch(app.commands.queue.advance, { run: "R1" })
      } finally {
        values.mockRestore()
      }

      expect(enumerations).toBe(0)
    },
  )

  it("matches the former replay-order scans for every Queue projection index lookup", async () => {
    await using app = await createQueueApp()
    const pr = await submitBranch(app, "issue/index-contract")
    await app.queue.run({ prs: [], derived: [pr], steps: ["check", "review"] }, runtime)
    const seed = Queues.get(app.state().queues, "R1")
    if (seed?.prs[0] === undefined) throw new Error("expected R1 projection fixture")
    const later: QueueRecord = { ...seed, id: "R10" }
    const child: QueueRecord = { ...seed, id: "R11", parent: later.id, isolationPart: 1 }
    const replayedLast: QueueRecord = { ...seed, id: "R0" }

    const replayOrder = [seed, later, child, replayedLast]
    const formerScanOrder = replayOrder.toSorted((left, right) =>
      left.id.localeCompare(right.id, undefined, { numeric: true }),
    )
    let index = emptyQueueProjectionIndex()
    for (const record of replayOrder) index = indexQueueStart(index, record)
    const released = [
      { ...later, stepSelection: { authority: "admission" as const, steps: ["check", "review"] } },
      { ...later, stepSelection: { authority: "admission" as const, steps: ["check", "review"] } },
    ]
    for (const record of released) index = recordReleasedAdmissionFailure(index, record)

    const exactKey = queueLookupKey(seed.prs[0], seed.steps)
    const prefix = seed.steps.slice(0, 1)
    const prefixKey = queueLookupKey(seed.prs[0], prefix)
    const scanChild = formerScanOrder.find((record) => record.parent === later.id && record.isolationPart === 1)?.id
    const scanExact = formerScanOrder
      .filter(
        (record) =>
          record.prs.length === 1 &&
          record.prs[0] !== undefined &&
          queueLookupKey(record.prs[0], record.steps) === exactKey,
      )
      .at(-1)?.id
    const scanPrefix = formerScanOrder
      .filter(
        (record) =>
          record.prs.length === 1 &&
          record.prs[0] !== undefined &&
          record.steps.length >= prefix.length &&
          queueLookupKey(record.prs[0], record.steps.slice(0, prefix.length)) === prefixKey,
      )
      .at(-1)?.id
    const scanFailures = released.filter(
      (record) =>
        record.stepSelection?.authority === "admission" &&
        record.prs[0] !== undefined &&
        queueLookupKey(record.prs[0], record.steps) === exactKey,
    ).length

    expect(childRunId(index, later.id, 1)).toBe(scanChild)
    expect(latestExactRunId(index, seed.prs[0], seed.steps)).toBe(scanExact)
    expect(latestPrefixRunId(index, seed.prs[0], prefix)).toBe(scanPrefix)
    expect(releasedAdmissionFailures(index, seed.prs[0], seed.steps)).toBe(scanFailures)
    expect(index.nextRunNumber).toBe(12)
  })

  it("round-trips a projection lookup through JSON and extends a deeply frozen value immutably", () => {
    const seeded = projectionLookupSet({}, "alpha", { latestExact: "R1" })
    const restored = deepFreeze(
      JSON.parse(JSON.stringify(seeded)) as QueueProjectionLookup<Readonly<{ latestExact: string }>>,
    )

    const extended = projectionLookupSet(restored, "beta", { latestExact: "R2" })

    expect(projectionLookupGet(restored, "alpha")).toEqual({ latestExact: "R1" })
    expect(projectionLookupGet(restored, "beta")).toBeUndefined()
    expect(projectionLookupGet(extended, "alpha")).toEqual({ latestExact: "R1" })
    expect(projectionLookupGet(extended, "beta")).toEqual({ latestExact: "R2" })
  })

  it.each([10, 10_000, 100_000])(
    "looks up a canonical Queue plan with bounded radix work across %i historical keys",
    (size) => {
      const snapshot = {
        id: "PR-target",
        branch: "issue/target",
        revision: 1,
        headSha: HEAD,
        base: "main",
        baseSha: BASE,
      }
      const steps = [
        {
          name: "check",
          title: "check",
          revision: "check-v1",
          kind: "check" as const,
        },
      ]
      const key = queueLookupKey(snapshot, steps)
      let plans = emptyQueueProjectionIndex().plans
      for (let index = 0; index < size; index += 1) {
        plans = projectionLookupSet(plans, `history-${index}`, { latestExact: `R${index + 1}` })
      }
      plans = deepFreeze(projectionLookupSet(plans, key, { latestExact: "R-target" }))
      const counters: LookupCounters = { reads: 0, enumerations: 0 }
      const index = { ...emptyQueueProjectionIndex(), plans: observeProjectionLookup(plans, counters) }

      expect(latestExactRunId(index, snapshot, steps)).toBe("R-target")
      expect(counters.enumerations).toBe(0)
      expect(counters.reads).toBeLessThanOrEqual(256)
    },
  )

  it.each([10, 10_000, 100_000])(
    "indexes a new Queue run without enumerating %i historical lookup keys",
    async (size) => {
      await using app = await createQueueApp()
      const pr = await submitBranch(app, "issue/bounded-index-write")
      await app.queue.run({ prs: [], derived: [pr], steps: ["check"] }, runtime)
      const record = Queues.get(app.state().queues, "R1")
      const snapshot = record?.prs[0]
      if (record === undefined || snapshot === undefined) throw new Error("expected bounded index-write fixture")
      let plans = emptyQueueProjectionIndex().plans
      for (let index = 0; index < size; index += 1) {
        plans = projectionLookupSet(plans, `history-${index}`, { latestExact: `R${index + 2}` })
      }
      plans = deepFreeze(plans)
      const counters: LookupCounters = { reads: 0, enumerations: 0 }
      const index = Object.freeze({
        ...emptyQueueProjectionIndex(),
        plans: observeProjectionLookup(plans, counters),
      })
      const next = indexQueueStart(index, { ...record, id: `R${size + 2}` })

      expect(projectionLookupGet(index.plans, "history-0")).toEqual({ latestExact: "R2" })
      expect(latestExactRunId(index, snapshot, record.steps)).toBeUndefined()
      expect(projectionLookupGet(next.plans, "history-0")).toEqual({ latestExact: "R2" })
      expect(latestExactRunId(next, snapshot, record.steps)).toBe(`R${size + 2}`)
      expect(latestPrefixRunId(next, snapshot, record.steps)).toBe(`R${size + 2}`)
      expect(Object.isFrozen(plans.root)).toBe(true)
      expect(counters.enumerations).toBeLessThanOrEqual(128)
    },
  )

  it.each([10, 10_000, 100_000])(
    "projects an actual Queue start without enumerating %i historical records or authorities",
    async (size) => {
      await using app = await createQueueApp()
      const pr = await submitBranch(app, "issue/bounded-start-projection")
      await app.queue.run({ prs: [], derived: [pr], steps: ["check"] }, runtime)
      const seed = Queues.get(app.state().queues, "R1")
      const seedAuthority = Queues.authorityRun(app.state().queues.authority, "R1")
      if (seed === undefined || seedAuthority === undefined) throw new Error("expected Queue projection seed")

      let records = app.state().queues.records
      let runs = app.state().queues.authority.runs
      for (let index = 0; index < size; index += 1) {
        const id = `R${index + 2}`
        records = projectionLookupSet(records, id, { ...seed, id })
        runs = projectionLookupSet(runs, id, seedAuthority)
      }
      records = deepFreeze(records)
      runs = deepFreeze(runs)
      const recordCounters: LookupCounters = { reads: 0, enumerations: 0 }
      const authorityCounters: LookupCounters = { reads: 0, enumerations: 0 }
      const observed = {
        ...app.state().queues,
        records: observeProjectionLookup(records, recordCounters),
        authority: {
          ...app.state().queues.authority,
          runs: observeProjectionLookup(runs, authorityCounters),
        },
      }
      const id = `R${size + 2}`
      const projected = projectQueueStarted(observed, { ...seed, id })

      expect(Queues.get(observed, id)).toBeUndefined()
      expect(Queues.get(projected, id)?.id).toBe(id)
      expect(Queues.authorityRun(observed.authority, id)).toBeUndefined()
      expect(Queues.authorityRun(projected.authority, id)).toBeDefined()
      expect(recordCounters.enumerations).toBeLessThanOrEqual(128)
      expect(authorityCounters.enumerations).toBeLessThanOrEqual(128)
      expect(recordCounters.reads).toBeLessThanOrEqual(1_024)
      expect(authorityCounters.reads).toBeLessThanOrEqual(1_024)
    },
  )

  it("derives the no-token authority kind from the submit fact, never a stored status copy (22991 phase 2)", async () => {
    await using app = await createQueueApp()
    const pr = await submitBranch(app, "issue/authority-kind-derivation")
    await app.queue.run({ prs: [], derived: [pr], steps: ["check"] }, runtime)
    const seed = Queues.get(app.state().queues, "R1")
    const snapshot = seed?.prs[0]
    if (seed === undefined || snapshot === undefined) throw new Error("expected authority-kind fixture")
    const token = { pr: snapshot.id, revision: snapshot.revision, headSha: snapshot.headSha }

    // The stored per-change status copy is gone from the authority contract.
    expect(app.state().queues.authority).not.toHaveProperty("statuses")

    // Submit-level: a submit fact for this exact revision stands (consumed by
    // an earlier run, so no token is AVAILABLE) — the member still operates
    // under submit-level authority and a gap names the submit kind.
    const submitted = {
      ...app.state().queues,
      authority: {
        current: { [snapshot.id]: token },
        submits: { [snapshot.id]: { ...token, consumedBy: "R1" } },
        checks: {},
        claims: {},
        runs: {},
      },
    }
    const submitGap = Queues.authorityRun(projectQueueStarted(submitted, { ...seed, id: "R7" }).authority, "R7")
    expect(submitGap?.missingSubmits).toEqual([snapshot.id])
    expect(submitGap?.missingChecks).toEqual([])

    // Draft-level: no submit fact was ever recorded for the revision (its
    // checks token was consumed) — the member can only hold checks-level
    // authority, so the gap names the checks kind. The deleted status copy
    // used to make this call from its stored label; a draft that recorded a
    // passing admission was labeled "ready" and mis-demanded submit-level
    // authority it could not hold without being submitted.
    const draft = {
      ...app.state().queues,
      authority: {
        current: { [snapshot.id]: token },
        submits: {},
        checks: { [snapshot.id]: { ...token, consumedBy: "R1" } },
        claims: {},
        runs: {},
      },
    }
    const checksGap = Queues.authorityRun(projectQueueStarted(draft, { ...seed, id: "R8" }).authority, "R8")
    expect(checksGap?.missingChecks).toEqual([snapshot.id])
    expect(checksGap?.missingSubmits).toEqual([])
  })

  it("rejects a Queue start whose execution result diverges from its Candidate", async () => {
    await using app = await createQueueApp()
    const pr = await submitBranch(app, "issue/candidate-run-result")
    await app.queue.run({ prs: [], derived: [pr], steps: ["check"] }, runtime)
    const seed = Queues.get(app.state().queues, "R1")
    const snapshot = seed?.prs[0]
    if (seed === undefined || snapshot === undefined) throw new Error("expected Candidate result fixture")

    const mismatches: readonly (readonly [string, QueueRecord])[] = [
      ["queue identity", { ...seed, id: "R2", queueId: "other" }],
      ["queue target", { ...seed, id: "R3", base: "other" }],
      ["snapshot queue", { ...seed, id: "R4", prs: [{ ...snapshot, base: "other" }] }],
      ["base SHA", { ...seed, id: "R5", prs: [{ ...snapshot, baseSha: UPDATED }] }],
      ["ordered PR revisions", { ...seed, id: "R6", prs: [{ ...snapshot, headSha: UPDATED }] }],
    ]

    for (const [label, record] of mismatches) {
      expect(() => projectQueueStarted(app.state().queues, record), label).toThrow(/Queue run 'R\d+' .* Candidate 'C1'/)
    }
  })

  it.each([10, 10_000, 100_000])(
    "keeps child, prefix, retry, claim, and next-id work independent of %i terminal runs",
    async (size) => {
      await using app = await createQueueApp()
      const pr = await submitBranch(app, "issue/all-bounded-lookups")
      await app.queue.run({ prs: [], derived: [pr], steps: ["check"] }, runtime)
      const record = Queues.get(app.state().queues, "R1")
      if (record?.prs[0] === undefined) throw new Error("expected bounded lookup fixture")
      const key = queueLookupKey(record.prs[0], record.steps)
      let plans = emptyQueueProjectionIndex().plans
      let children = emptyQueueProjectionIndex().childByParentPart
      for (let index = 0; index < size; index += 1) {
        plans = projectionLookupSet(plans, `history-${index}`, {
          latestExact: `R${index + 2}`,
          latestPrefix: `R${index + 2}`,
        })
        children = projectionLookupSet(children, `history-${index}`, `R${index + 2}`)
      }
      plans = deepFreeze(
        projectionLookupSet(plans, key, {
          latestExact: "R1",
          latestPrefix: "R1",
          releasedAdmissionFailures: 2,
        }),
      )
      children = deepFreeze(projectionLookupSet(children, `R1\0${1}`, "R-child"))
      const counters: LookupCounters = { reads: 0, enumerations: 0 }
      const index = {
        ...emptyQueueProjectionIndex(),
        nextRunNumber: size + 2,
        childByParentPart: observeProjectionLookup(children, counters),
        plans: observeProjectionLookup(plans, counters),
      }

      expect(childRunId(index, "R1", 1)).toBe("R-child")
      expect(latestExactRunId(index, record.prs[0], record.steps)).toBe("R1")
      expect(latestPrefixRunId(index, record.prs[0], record.steps)).toBe("R1")
      expect(releasedAdmissionFailures(index, record.prs[0], record.steps)).toBe(2)
      expect(Queues.nextId({ ...app.state().queues, index })).toBe(`R${size + 2}`)
      expect(counters.enumerations).toBe(0)
      expect(counters.reads).toBeLessThanOrEqual(1_024)

      let historicalRunEnumerations = 0
      const runs = new Proxy(app.state().queues.authority.runs, {
        ownKeys(target) {
          historicalRunEnumerations += 1
          return Reflect.ownKeys(target)
        },
      })
      activeQueueRootIds({ ...app.state().queues.authority, runs })
      expect(historicalRunEnumerations).toBe(0)
    },
  )

  it("emits one terminal run lifecycle with lossless PR revision and props identity", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await createQueueApp({}, undefined, undefined, undefined, log)
    await app.bays.recordBranchSubmit({ branch: "issue/observable", sha: HEAD, base: "main" })
    const observable = memberOf(app, "issue/observable", { props: { review: "21125" } })

    await expect(
      app.queue.run({ prs: [], derived: [observable], steps: ["check", "review", "merge"] }, runtime),
    ).resolves.toMatchObject([{ id: "R1", status: "completed", conclusion: "success" }])

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "log",
        namespace: "yrd:queue:run",
        level: "info",
        props: expect.objectContaining({
          lifecycle: "run",
          outcome: "succeeded",
          run: "R1",
          prs: [
            expect.objectContaining({
              pr: "PR1",
              revision: 1,
              headSha: HEAD,
              props: { review: "21125" },
            }),
          ],
          durationMs: expect.any(Number),
        }),
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "log",
        namespace: "yrd:jobs:check",
        level: "info",
        props: expect.objectContaining({
          lifecycle: "check",
          outcome: "succeeded",
          run: "R1",
          step: "check",
          job: expect.any(String),
          attempt: 1,
          runner: "local",
          prs: [expect.objectContaining({ pr: "PR1", revision: 1, headSha: HEAD })],
          durationMs: expect.any(Number),
        }),
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "log",
        namespace: "yrd:jobs:merge",
        level: "info",
        props: expect.objectContaining({
          lifecycle: "merge",
          outcome: "succeeded",
          run: "R1",
          step: "merge",
          runner: "local",
          prs: [expect.objectContaining({ pr: "PR1", revision: 1, headSha: HEAD })],
          durationMs: expect.any(Number),
        }),
      }),
    )
    log.end()
  })

  it("owns the step artifact projection across output, waiting, and nested failure evidence", () => {
    const ArtifactSchema = z
      .object({
        name: z.string().optional(),
        path: z.string().optional(),
        kind: z.string().optional(),
        uri: z.string().optional(),
      })
      .strict()
    const ArtifactResultSchema = z
      .object({
        checked: z.boolean(),
        artifacts: z.array(ArtifactSchema).optional(),
        nested: z
          .object({ artifacts: z.array(ArtifactSchema) })
          .strict()
          .optional(),
      })
      .strict()
    const step = withStep(
      "check",
      async (): Promise<JobResult<z.infer<typeof ArtifactResultSchema>>> => ({
        status: "completed",
        conclusion: "success",
        output: { checked: true },
      }),
      { revision: "check-v1", output: ArtifactResultSchema },
    )
    const local = { name: "stderr", path: "/artifacts/R1/check/stderr.log" }
    const remote = { kind: "report", uri: "artifact://R1/check/report.json" }
    const unrelated = { name: "nested-output", path: "/not/a/step-artifact.log" }

    expect(
      step.job.observeResult?.({
        status: "completed",
        conclusion: "failure",
        error: {
          code: "check-failed",
          message: "candidate failed",
          evidence: { comparison: { error: { evidence: { artifacts: [remote] } } } },
        },
        output: { checked: false, artifacts: [local], nested: { artifacts: [unrelated] } },
      }),
    ).toEqual({ artifacts: [local, remote] })

    expect(
      step.job.observeResult?.({
        status: "waiting",
        token: "remote-1",
        artifacts: [remote],
      }),
    ).toEqual({ artifacts: [remote] })
  })

  it("keeps internal failure lifecycles at INFO so the CLI owns the user-facing error", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await createQueueApp(
      {
        check: () => ({
          status: "completed",
          conclusion: "failure",
          error: { code: "check-failed", message: "candidate failed" },
        }),
      },
      undefined,
      undefined,
      undefined,
      log,
    )
    const pr = await submitBranch(app, "issue/one-error")
    await app.queue.run({ derived: [pr], steps: ["check"] }, runtime)

    expect(
      events.find(
        (event): event is Extract<LogEvent, { kind: "log" }> =>
          event.kind === "log" && event.namespace === "yrd:jobs:check" && event.props?.outcome === "failed",
      ),
    ).toMatchObject({ level: "info" })

    const run = events.find(
      (event): event is Extract<LogEvent, { kind: "log" }> =>
        event.kind === "log" && event.namespace === "yrd:queue:run" && event.props?.outcome !== "started",
    )
    expect(run).toMatchObject({ level: "info", props: expect.objectContaining({ outcome: "settled", run: "R1" }) })
    const compose = events.find(
      (event): event is Extract<LogEvent, { kind: "log" }> =>
        event.kind === "log" && event.namespace === "yrd:queue:compose" && event.props?.outcome !== "started",
    )
    expect(compose).toMatchObject({ level: "info", props: expect.objectContaining({ outcome: "settled" }) })
    log.end()
  })

  it("labels a mixed compose with per-run outcomes instead of a flat compose failed", async () => {
    // A compose whose runs array carries a PASSED run alongside a failed one must
    // not read "compose failed": the message names the mix so no passing run is
    // misrepresented.
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await createQueueApp(
      {
        batch: 1,
        check: (input) =>
          input.prs.some((pr) => pr.branch.includes("fail"))
            ? { status: "completed", conclusion: "failure", error: { code: "check-failed", message: "bad candidate" } }
            : { status: "completed", conclusion: "success", output: { checked: true } },
      },
      undefined,
      undefined,
      undefined,
      log,
    )
    const passing = await submitBranch(app, "issue/pass-me")
    const failing = await submitBranch(app, "issue/fail-me")
    const runs = await app.queue.run({ derived: [passing, failing], steps: ["check"] }, runtime)
    expect(
      runs.map((run) => run.conclusion).toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
    ).toEqual(["failure", "success"])

    const compose = events.find(
      (event): event is Extract<LogEvent, { kind: "log" }> =>
        event.kind === "log" && event.namespace === "yrd:queue:compose" && event.props?.outcome === "settled",
    )
    expect(compose).toMatchObject({
      level: "info",
      message: "compose settled: 1 failed, 1 passed",
      props: expect.objectContaining({ outcome: "settled", summary: "settled: 1 failed, 1 passed" }),
    })
    log.end()
  })

  it("never re-reports an already-terminal run as a fresh settlement on a later cycle", async () => {
    // A terminal bisection parent whose isolated children are still waiting is
    // re-encountered every drain cycle. Its own outcome is fixed, so its run
    // lifecycle must emit exactly ONCE — never a fresh started/settled pair with
    // a bogus few-millisecond duration on each later cycle (the "R603 re-reported
    // 6 min later, durationMs:3" artifact).
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await createQueueApp(
      {
        batch: 2,
        // The 2-PR batch check fails (forcing a bisect); each isolated single-PR
        // child then WAITS on an external check, so the batch parent stays
        // terminal-failed with unsettled children across cycles.
        check: (input) =>
          input.prs.length > 1
            ? { status: "completed", conclusion: "failure", error: { code: "check-failed", message: "red batch" } }
            : { status: "waiting", token: `remote-${input.prs[0]?.id}` },
      },
      undefined,
      undefined,
      undefined,
      log,
    )
    const batch = [await submitBranch(app, "issue/batch-a"), await submitBranch(app, "issue/batch-b")]

    const runStartedForR1 = () =>
      events.filter(
        (event) =>
          event.kind === "log" &&
          event.namespace === "yrd:queue:run" &&
          event.props?.run === "R1" &&
          event.props?.outcome === "started",
      ).length

    await app.queue.run({ derived: batch }, runtime)
    expect(app.queue.get("R1")?.status).toBe("completed")
    expect(runStartedForR1()).toBe(1)

    // Recovery sees the same failed-parent/waiting-child tree, but neither an
    // expired lease nor a newly settled root. It must not manufacture progress.
    await expect(app.queue.recover({ recoveryTime: "2026-01-01T00:00:30.000Z" })).resolves.toEqual([])

    // A second drain cycle re-encounters the still-unsettled bisection tree.
    await app.queue.run({ derived: batch }, runtime)
    // The terminal batch parent R1 did NOT re-emit its run lifecycle.
    expect(runStartedForR1()).toBe(1)
    log.end()
  })

  it("classifies a waiting queue lifecycle as progress rather than failure", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await createQueueApp(
      { check: () => ({ status: "waiting", token: "remote-check" }) },
      undefined,
      undefined,
      undefined,
      log,
    )
    const pr = await submitBranch(app, "issue/waiting")

    await expect(app.queue.run({ derived: [pr], steps: ["check"] }, runtime)).resolves.toMatchObject([
      { id: "R1", status: "waiting" },
    ])

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "log",
        namespace: "yrd:queue:run",
        level: "trace",
        props: expect.objectContaining({ lifecycle: "run", outcome: "progress", run: "R1" }),
      }),
    )
    log.end()
  })

  it("composes one immutable typed plan and rejects a pre-merge deploy", async () => {
    await using app = await createQueueApp()
    expectTypeOf(app.queue).toMatchTypeOf<Queue<DeployedShape>>()
    expectTypeOf(app.queue.recover)
      .parameter(0)
      .toEqualTypeOf<Readonly<{ recoveryTime: string; reason?: string; runner?: string }>>()
    expect(app.queue.steps().map((step) => step.name)).toEqual(["check", "review", "merge", "deploy"])

    const check = withStep(
      "check",
      (_input: StepExecution<ChangeShape>) => ({
        status: "completed",
        conclusion: "success" as const,
        output: { checked: true },
      }),
      { revision: "check-v1", output: CheckResultSchema },
    )
    const deploy = withStep(
      "deploy",
      (_input: StepExecution<MergedShape>) => ({
        status: "completed",
        conclusion: "success" as const,
        output: { environment: "test" },
      }),
      { revision: "deploy-v1", kind: "action", output: DeployResultSchema },
    )
    const invalid = (): void => {
      // @ts-expect-error deploy requires the shape produced by withMerge
      void withQueue({ steps: [check, deploy] as const })
    }
    void invalid
  })

  it("journals exact issue joins for integrated PRs while failed Runs leave the proposal open", async () => {
    const issueRef = "@km/all/21063-steering-laser"
    const props = { request: "21091-terminal-join" }

    await using integratedApp = await createQueueApp()
    await integratedApp.bays.recordBranchSubmit({ branch: "topic/partial-2106-token", sha: HEAD, base: "main" })
    const integrating = memberOf(integratedApp, "topic/partial-2106-token", { issue: issueRef, props })
    await integratedApp.queue.run({ prs: [], derived: [integrating] }, runtime)

    expect(await Array.fromAsync(integratedApp.events())).toContainEqual(
      expect.objectContaining({
        name: "pr/integrated",
        data: {
          pr: "PR1",
          revision: 1,
          headSha: HEAD,
          issueRef,
          run: "R1",
          commit: MERGED,
          landingSha: MERGED,
          baseSha: BASE,
          changeId: expect.stringMatching(/^I[0-9a-f]{40}$/u),
          props,
        },
      }),
    )

    await using rejectedApp = await createQueueApp(
      {
        check: () => ({
          status: "completed",
          conclusion: "failure",
          error: {
            code: "check-failed",
            message: "typed bounce",
            evidence: { artifacts: [{ name: "stderr", path: "artifact://R1/check/stderr.log" }] },
          },
        }),
      },
      createMemoryJournal(),
      () => "2026-01-01T00:00:00.000Z",
      ids(),
      createLogger("test", [{ level: "silent" }]),
    )
    await rejectedApp.bays.recordBranchSubmit({ branch: "topic/unrelated-20685-subject", sha: HEAD, base: "main" })
    const rejecting = memberOf(rejectedApp, "topic/unrelated-20685-subject", { issue: issueRef, props })
    await rejectedApp.queue.run({ prs: [], derived: [rejecting] }, runtime)

    const failedEvents = await Array.fromAsync(rejectedApp.events())
    expect(failedEvents.map(({ name }) => name)).not.toContain("pr/rejected")
    expect(failedEvents).toContainEqual(
      expect.objectContaining({
        name: "queue/run/failed",
        data: {
          run: "R1",
          error: {
            code: "check-failed",
            message: "typed bounce",
            evidence: { artifacts: [{ name: "stderr", path: "artifact://R1/check/stderr.log" }] },
          },
          job: { id: expect.any(String), attempt: 1 },
          prs: [{ pr: "PR1", revision: 1, headSha: HEAD }],
        },
      }),
    )
    // "leaves the proposal open" post-S7: the branch's standing submit fact is
    // untouched by the failure — the fact IS the delivery, so an unretired fact
    // at the same sha is the open proposal the record's `state: "open"` used to
    // project.
    expect(rejectedApp.state().bays.submits["topic/unrelated-20685-subject"]).toMatchObject({
      sha: HEAD,
      base: "main",
    })
    const rejectedRun = rejectedApp.queue.get("R1")
    expect(rejectedRun).toMatchObject({
      status: "completed",
      conclusion: "failure",
      prs: [{ id: "PR1", revision: 1, headSha: HEAD, props }],
    })
    expect(rejectedRun?.steps[0]).toMatchObject({
      name: "check",
      job: {
        status: "completed",
        conclusion: "failure",
        error: {
          code: "check-failed",
          message: "typed bounce",
          evidence: { artifacts: [{ name: "stderr", path: "artifact://R1/check/stderr.log" }] },
        },
      },
    })
  })

  it("treats an explicit empty step selection as a true no-op", async () => {
    await using app = await createQueueApp()
    const pr = await submitBranch(app, "issue/no-steps")

    const result = await app.dispatch(app.commands.queue.run, { prs: [], derived: [pr], steps: [], baseSha: BASE })
    expect(result.events).toEqual([])
    await expect(app.queue.run({ prs: [], derived: [pr], steps: [] }, runtime)).resolves.toEqual([])
    expect(Queues.ids(app.state().queues)).toEqual([])
    // A true no-op consumes nothing: the branch's standing submit fact — the
    // whole of its delivery post-S7 — is exactly as it was before the run.
    expect(app.state().bays.submits["issue/no-steps"]).toMatchObject({ sha: pr.headSha, base: "main" })
  })

  it("persists configured omissions without mislabeling unconfigured steps", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    const expectedSelection = {
      authority: "explicit",
      steps: ["merge"],
      omittedSteps: [
        { name: "check", index: 0, revision: "check-v1", status: "skipped", reason: "not-selected" },
        { name: "deploy", index: 2, revision: "deploy-v1", status: "skipped", reason: "not-selected" },
      ],
    }

    {
      await using app = await createQueueApp({ defaultSteps: ["check", "merge", "deploy"] }, journal, undefined, id)
      const pr = await submitBranch(app, "issue/auditable-merge-only")
      await app.dispatch(app.commands.queue.run, { prs: [], derived: [pr], steps: ["merge"], baseSha: BASE })
      expect(JSON.parse(JSON.stringify(Queues.get(app.state().queues, "R1")?.stepSelection))).toMatchObject(
        expectedSelection,
      )
      const record = Queues.get(app.state().queues, "R1")
      if (record === undefined) throw new Error("expected a durable merge-only Run")
      const legacyRecord = {
        ...record,
        stepSelection: { authority: "explicit", steps: ["merge"], omittedChecks: ["check"] },
      }
      expect(() => QueueRecordSchema.parse(legacyRecord)).toThrow()
      expect(ReplayQueueRecordSchema.parse(legacyRecord).stepSelection).toEqual(legacyRecord.stepSelection)
    }

    await using replayed = await createQueueApp({ defaultSteps: ["check", "merge", "deploy"] }, journal, undefined, id)
    expect(JSON.parse(JSON.stringify(replayed.queue.get("R1")?.stepSelection))).toMatchObject(expectedSelection)
  })

  it("keeps recovery execution-free for requested merge work", async () => {
    let mergeCalls = 0
    await using app = await createQueueApp({
      merge: () => {
        mergeCalls += 1
        return { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
      },
    })
    const pr = await submitBranch(app, "issue/requested-merge")
    await app.dispatch(app.commands.queue.run, { prs: [], derived: [pr], steps: ["merge"], baseSha: BASE })
    const before = await Array.fromAsync(app.events())

    await expect(app.queue.recover({ recoveryTime: "2026-01-01T00:01:00.000Z" })).resolves.toEqual([])

    expect(await Array.fromAsync(app.events())).toEqual(before)
    expect(app.queue.get("R1")?.steps[0]?.job?.status).toBe("queued")
    // Nothing integrated and the branch's submit fact still stands: post-S7
    // those two together ARE `delivery === "submitted"`.
    expect(await terminalFor(app, pr.id)).toBeUndefined()
    expect(standingSubmit(app, pr.branch)).toMatchObject({ sha: pr.headSha })
    expect(mergeCalls).toBe(0)
  })

  it.each(["requested", "passed"] as const)(
    "resumes a replayed %s Job only when queue.run grants execution authority",
    async (crashPoint) => {
      const journal = createMemoryJournal()
      const id = ids()
      let checkCalls = 0
      let mergeCalls = 0
      const options = {
        check: () => {
          checkCalls += 1
          return { status: "completed" as const, conclusion: "success" as const, output: { checked: true } }
        },
        merge: () => {
          mergeCalls += 1
          return {
            status: "completed" as const,
            conclusion: "success" as const,
            output: { commit: MERGED, baseSha: BASE },
          }
        },
      }

      {
        await using app = await createQueueApp(options, journal, undefined, id)
        const pr = await submitBranch(app, `issue/${crashPoint}-resume`)
        await app.dispatch(app.commands.queue.run, { prs: [], derived: [pr], steps: ["check", "merge"], baseSha: BASE })
        const job = app.queue.get("R1")?.steps[0]?.job
        if (job === undefined) throw new Error(`expected ${crashPoint} crash-window Job`)
        if (crashPoint === "passed") await app.jobs.run(job.id, runtime)
      }

      await using replayed = await createQueueApp(options, journal, undefined, id)
      // The replayed root is resumed by the selectorless drain: an explicit
      // `prs: ["PR1"]` selector needed a record to resolve, and a derived member
      // is resumed from the run's own retained snapshot instead.
      await expect(replayed.queue.run({ steps: ["check", "merge"] }, runtime)).resolves.toEqual([
        expect.objectContaining({ id: "R1", status: "completed", conclusion: "success" }),
      ])
      expect(await terminalFor(replayed, "PR1")).toMatchObject({ run: "R1", commit: MERGED, landingSha: MERGED })
      expect(checkCalls).toBe(1)
      expect(mergeCalls).toBe(1)
    },
  )

  it("refuses mismatched replayed steps before starting their configured process", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    let checkCalls = 0
    let mergeCalls = 0
    const options = {
      check: () => {
        checkCalls += 1
        return { status: "completed" as const, conclusion: "success" as const, output: { checked: true } }
      },
      merge: () => {
        mergeCalls += 1
        return {
          status: "completed" as const,
          conclusion: "success" as const,
          output: { commit: MERGED, baseSha: BASE },
        }
      },
    }

    {
      await using app = await createQueueApp(options, journal, undefined, id)
      const pr = await submitBranch(app, "issue/mismatched-resume")
      await app.dispatch(app.commands.queue.run, { prs: [], derived: [pr], steps: ["check", "merge"], baseSha: BASE })
      expect(app.queue.get("R1")?.steps[0]?.job?.status).toBe("queued")
    }

    await using replayed = await createQueueApp(options, journal, undefined, id)
    const mismatched = memberOf(replayed, "issue/mismatched-resume")
    await expect(replayed.queue.run({ prs: [], derived: [mismatched], steps: ["merge"] }, runtime)).rejects.toThrow(
      "change 'PR1' is already in active queue run 'R1'",
    )
    expect(checkCalls).toBe(0)
    expect(mergeCalls).toBe(0)
    expect(replayed.queue.get("R1")).toMatchObject({
      status: "queued",
      stepSelection: { authority: "explicit", steps: ["check", "merge"] },
      steps: [{ name: "check", job: { status: "queued" } }, { name: "merge" }],
    })
    expect(Queues.ids(replayed.state().queues)).toEqual(["R1"])
  })

  it("refuses to resume a replayed batch for only part of its pinned PR set", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    let checkCalls = 0
    let mergeCalls = 0
    const options = {
      batch: 2,
      check: () => {
        checkCalls += 1
        return { status: "completed" as const, conclusion: "success" as const, output: { checked: true } }
      },
      merge: () => {
        mergeCalls += 1
        return {
          status: "completed" as const,
          conclusion: "success" as const,
          output: { commit: MERGED, baseSha: BASE },
        }
      },
    }

    {
      await using app = await createQueueApp(options, journal, undefined, id)
      const first = await submitBranch(app, "issue/batch-one")
      const second = await submitBranch(app, "issue/batch-two")
      await app.dispatch(app.commands.queue.run, {
        prs: [],
        derived: [first, second],
        steps: ["check", "merge"],
        baseSha: BASE,
      })
      expect(app.queue.get("R1")?.steps[0]?.job?.status).toBe("queued")
    }

    await using replayed = await createQueueApp(options, journal, undefined, id)
    const partial = memberOf(replayed, "issue/batch-one")
    await expect(
      replayed.queue.run({ prs: [], derived: [partial], steps: ["check", "merge"] }, runtime),
    ).rejects.toThrow("change 'PR1' is already in active queue run 'R1'")
    expect(checkCalls).toBe(0)
    expect(mergeCalls).toBe(0)
    expect(replayed.queue.get("R1")).toMatchObject({
      status: "queued",
      prs: [{ id: "PR1" }, { id: "PR2" }],
      steps: [{ name: "check", job: { status: "queued" } }, { name: "merge" }],
    })
  })

  it("preserves an active run while a replayed journal adopts a larger future batch", async () => {
    const cache = checkpointJournal(createMemoryJournal())
    const journal = cache.journal
    const id = ids()
    const options = {
      check: () => ({ status: "completed" as const, conclusion: "success" as const, output: { checked: true } }),
      merge: () => ({
        status: "completed" as const,
        conclusion: "success" as const,
        output: { commit: MERGED, baseSha: BASE },
      }),
    }

    {
      await using app = await createQueueApp({ ...options, batch: 1 }, journal, undefined, id)
      const first = await submitBranch(app, "issue/batch-policy-one")
      await submitBranch(app, "issue/batch-policy-two")
      await submitBranch(app, "issue/batch-policy-three")
      await app.dispatch(app.commands.queue.run, { prs: [], derived: [first], steps: ["check", "merge"], baseSha: BASE })

      expect(app.state().queues.batchSize).toBe(1)
      expect(app.queue.get("R1")).toMatchObject({
        status: "queued",
        batchSize: 1,
        prs: [{ id: "PR1" }],
      })
    }

    const batchOneIdentity = cache.stored()?.identity
    expect(batchOneIdentity).toBeDefined()
    cache.reads.length = 0

    await using replayed = await createQueueApp({ ...options, batch: 2 }, journal, undefined, id)
    expect(cache.loads.at(-1)).not.toBe(batchOneIdentity)
    expect(cache.reads[0]).toBe(0)
    expect(replayed.state().queues.batchSize).toBe(2)
    expect(replayed.queue.get("R1")).toMatchObject({
      status: "queued",
      batchSize: 1,
      prs: [{ id: "PR1" }],
    })

    const runs = await replayed.queue.run({ steps: ["check", "merge"] }, runtime)

    expect(runs).toMatchObject([
      { id: "R1", status: "completed", conclusion: "success", batchSize: 1, prs: [{ id: "PR1" }] },
      {
        id: "R2",
        status: "completed",
        conclusion: "success",
        batchSize: 2,
        prs: [{ id: "PR2" }, { id: "PR3" }],
      },
    ])
    expect(replayed.queue.get("R1")).toMatchObject({ batchSize: 1, prs: [{ id: "PR1" }] })
  })

  it("refuses to relabel configured replay authority as an explicit selection", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    let checkCalls = 0
    const options = {
      check: () => {
        checkCalls += 1
        return { status: "completed" as const, conclusion: "success" as const, output: { checked: true } }
      },
    }

    {
      await using app = await createQueueApp(options, journal, undefined, id)
      const pr = await submitBranch(app, "issue/configured-authority")
      await app.dispatch(app.commands.queue.run, { prs: [], derived: [pr], baseSha: BASE })
      expect(app.queue.get("R1")).toMatchObject({
        status: "queued",
        stepSelection: { authority: "configured", steps: ["check", "review", "merge", "deploy"] },
      })
    }

    await using replayed = await createQueueApp(options, journal, undefined, id)
    const configured = memberOf(replayed, "issue/configured-authority")
    await expect(
      replayed.queue.run({ prs: [], derived: [configured], steps: ["check", "review", "merge", "deploy"] }, runtime),
    ).rejects.toThrow("change 'PR1' is already in active queue run 'R1'")
    expect(checkCalls).toBe(0)
    expect(replayed.queue.get("R1")).toMatchObject({
      status: "queued",
      stepSelection: { authority: "configured" },
    })
    expect(replayed.queue.get("R1")?.steps[0]).toMatchObject({ name: "check", job: { status: "queued" } })
  })

  it("does not mistake a configured check-only Run for supersedable admission", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    let checkCalls = 0
    const options = {
      defaultSteps: ["check"] as const,
      check: () => {
        checkCalls += 1
        return { status: "completed" as const, conclusion: "success" as const, output: { checked: true } }
      },
    }

    {
      await using app = await createQueueApp(options, journal, undefined, id)
      const pr = await submitBranch(app, "issue/configured-check-only")
      await app.dispatch(app.commands.queue.run, { prs: [], derived: [pr], baseSha: BASE })
      expect(app.queue.get("R1")).toMatchObject({
        status: "queued",
        stepSelection: { authority: "configured", steps: ["check"] },
      })
    }

    await using replayed = await createQueueApp(options, journal, undefined, id)
    const checkOnly = memberOf(replayed, "issue/configured-check-only")
    await expect(replayed.queue.run({ prs: [], derived: [checkOnly], steps: ["check"] }, runtime)).rejects.toThrow(
      "change 'PR1' is already in active queue run 'R1'",
    )
    expect(checkCalls).toBe(0)
    expect(Queues.ids(replayed.state().queues)).toEqual(["R1"])
    expect(replayed.queue.get("R1")).toMatchObject({
      status: "queued",
      stepSelection: { authority: "configured", steps: ["check"] },
    })
  })

  it("settles a stale revision and admits its resubmission in one explicit run", async () => {
    await using app = await createQueueApp({
      check: () => ({ status: "waiting", token: "shared-token" }),
    })
    const pr = await submitBranch(app, "issue/one-call-resubmit")
    const first = (await app.queue.run({ prs: [], derived: [pr], steps: ["check", "merge"] }, runtime))[0]
    expect(first).toMatchObject({ id: "R1", status: "waiting" })

    // The resubmission post-S7 is a re-push: the submit fact moves to the new
    // sha, and re-deriving the branch continues its revision count off the
    // retained snapshot. That is what `bays.intake` + `bays.submit` minted onto
    // the record.
    await app.bays.recordBranchSubmit({ branch: pr.branch, sha: UPDATED, base: "main" })
    const resubmitted = memberOf(app, pr.branch)
    expect(resubmitted).toMatchObject({ id: pr.id, revision: 2, headSha: UPDATED })

    await expect(
      app.queue.run({ prs: [], derived: [resubmitted], steps: ["check", "merge"] }, runtime),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "R1",
        status: "completed",
        conclusion: "failure",
        error: expect.objectContaining({ code: "stale-pr" }),
      }),
      expect.objectContaining({ id: "R2", status: "waiting" }),
    ])
    expect(Queues.ids(app.state().queues)).toEqual(["R1", "R2"])
    expect(snapshotOf(app, pr.id)).toMatchObject({ revision: 2, headSha: UPDATED })
    expect(standingSubmit(app, pr.branch)).toMatchObject({ sha: UPDATED })
    expect(await terminalFor(app, pr.id)).toBeUndefined()
  })

  it.each(["merge-passed", "post-merge-requested"] as const)(
    "settles a replayed %s fact once without admitting a duplicate run",
    async (crashPoint) => {
      const journal = createMemoryJournal()
      const id = ids()
      let mergeCalls = 0
      let deployCalls = 0
      const options = {
        merge: () => {
          mergeCalls += 1
          return {
            status: "completed" as const,
            conclusion: "success" as const,
            output: { commit: MERGED, baseSha: BASE },
          }
        },
        deploy: () => {
          deployCalls += 1
          return { status: "completed" as const, conclusion: "success" as const, output: { environment: "staging" } }
        },
      }

      {
        await using app = await createQueueApp(options, journal, undefined, id)
        const pr = await submitBranch(app, `issue/${crashPoint}`)
        await app.dispatch(app.commands.queue.run, {
          prs: [],
          derived: [pr],
          steps: crashPoint === "merge-passed" ? ["merge"] : ["merge", "deploy"],
          baseSha: BASE,
        })
        const mergeJob = app.queue.get("R1")?.steps[0]?.job
        if (mergeJob === undefined) throw new Error("expected requested merge")
        await app.jobs.run(mergeJob.id, runtime)
        if (crashPoint === "post-merge-requested") {
          await app.dispatch(app.commands.queue.advance, { run: "R1" })
          // S7 settlement single-writer: the advance requests the next step but
          // emits NO terminal — nothing has integrated the member until the
          // run's settlement batch carries its `pr/integrated`.
          expect(await terminalFor(app, pr.id)).toBeUndefined()
          expect(app.queue.get("R1")?.steps[1]?.job?.status).toBe("queued")
          await app.queue.pause({
            base: "main",
            reason: "maintenance",
            allowedPRs: [],
            expiresAt: "2026-01-01T01:00:00.000Z",
          })
        }
      }

      await using replayed = await createQueueApp(options, journal, undefined, id)
      await expect(replayed.queue.run({}, runtime)).resolves.toEqual([
        expect.objectContaining({ id: "R1", status: "completed", conclusion: "success" }),
      ])
      await expect(replayed.queue.run({}, runtime)).resolves.toEqual([])
      expect(Queues.ids(replayed.state().queues)).toEqual(["R1"])
      expect(await terminalFor(replayed, "PR1")).toMatchObject({ run: "R1", commit: MERGED })
      expect(mergeCalls).toBe(1)
      expect(deployCalls).toBe(crashPoint === "post-merge-requested" ? 1 : 0)
    },
  )

  it("resumes one waiting deploy-only run for an already integrated change without admitting a duplicate", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    let deployCalls = 0
    const options = {
      deploy: () => {
        deployCalls += 1
        return { status: "waiting" as const, token: "deploy-pending" }
      },
    }

    {
      await using app = await createQueueApp(options, journal, undefined, id)
      const pr = await submitBranch(app, "issue/deploy-only-resume")
      await expect(app.queue.run({ prs: [], derived: [pr], steps: ["merge"] }, runtime)).resolves.toMatchObject([
        { id: "R1", status: "completed", conclusion: "success" },
      ])
      expect(await terminalFor(app, pr.id)).toMatchObject({ run: "R1", commit: MERGED })
      await app.dispatch(app.commands.queue.run, { prs: [], derived: [pr], steps: ["deploy"], baseSha: BASE })
      expect(app.queue.get("R2")).toMatchObject({ status: "queued", steps: [{ name: "deploy" }] })
      expect(activeQueueRootIds(app.state().queues.authority)).toEqual(["R2"])
    }

    await using replayed = await createQueueApp(options, journal, undefined, id)
    await expect(replayed.queue.run({ steps: ["deploy"] }, runtime)).resolves.toMatchObject([
      { id: "R2", status: "waiting" },
    ])
    expect(Queues.ids(replayed.state().queues)).toEqual(["R1", "R2"])
    expect(activeQueueRootIds(replayed.state().queues.authority)).toEqual(["R2"])
    expect(deployCalls).toBe(1)
  })

  it.each([10, 10_000, 100_000])("allocates a Queue run id without enumerating %i historical records", (size) => {
    let enumerations = 0
    const records = new Proxy<Record<string, QueueRecord>>(
      {},
      {
        ownKeys() {
          enumerations += 1
          return Array.from({ length: size }, (_, index) => `R${index + 1}`)
        },
        getOwnPropertyDescriptor() {
          return { configurable: true, enumerable: true }
        },
      },
    )
    const state = {
      ...Queues.empty({ batchSize: 1 }),
      records,
      index: { ...emptyQueueProjectionIndex(), nextRunNumber: size + 1 },
    }

    expect(Queues.nextId(state as Parameters<typeof Queues.nextId>[0])).toBe(`R${size + 1}`)
    expect(enumerations).toBe(0)
  })

  it("returns a replayed running Job without stealing it or admitting same-base intake", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    let checkCalls = 0
    const options = {
      check: () => {
        checkCalls += 1
        return { status: "completed" as const, conclusion: "success" as const, output: { checked: true } }
      },
    }

    {
      await using app = await createQueueApp(options, journal, undefined, id)
      const active = await submitBranch(app, "issue/active")
      await submitBranch(app, "issue/queued")
      await app.dispatch(app.commands.queue.run, { prs: [], derived: [active], steps: ["check"], baseSha: BASE })
      const job = app.queue.get("R1")?.steps[0]?.job
      if (job === undefined) throw new Error("expected requested active Job")
      await app.dispatch(app.commands.job.transition, {
        type: "start",
        id: job.id,
        attempt: 1,
        runner: "active-runner",
        leaseExpiresAt: "2026-01-01T00:05:00.000Z",
      })
    }

    await using replayed = await createQueueApp(options, journal, undefined, id)
    await expect(replayed.queue.run({}, runtime)).resolves.toEqual([
      expect.objectContaining({ id: "R1", status: "in_progress" }),
    ])
    expect(Queues.ids(replayed.state().queues)).toEqual(["R1"])
    // The same-base queued branch was not admitted: no run carries it, and its
    // submit fact still stands unconsumed.
    expect(snapshotOf(replayed, "PR2")).toBeUndefined()
    expect(standingSubmit(replayed, "issue/queued")).toBeDefined()
    expect(checkCalls).toBe(0)
  })

  it("recovers an expired batch without executing, bisecting, or merge", async () => {
    let checkCalls = 0
    let mergeCalls = 0
    await using app = await createQueueApp({
      batch: 2,
      check: () => {
        checkCalls += 1
        return { status: "completed", conclusion: "success", output: { checked: true } }
      },
      merge: () => {
        mergeCalls += 1
        return { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
      },
    })
    const first = await submitBranch(app, "issue/batch-one")
    const second = await submitBranch(app, "issue/batch-two")
    await app.dispatch(app.commands.queue.run, { prs: [], derived: [first, second], steps: ["check", "merge"], baseSha: BASE })
    const job = app.queue.get("R1")?.steps[0]?.job
    if (job === undefined) throw new Error("expected requested batch check")
    await app.dispatch(app.commands.job.transition, {
      type: "start",
      id: job.id,
      attempt: 1,
      runner: "expired-runner",
      leaseExpiresAt: "2026-01-01T00:00:01.000Z",
    })

    await expect(
      app.queue.recover({ recoveryTime: "2026-01-01T00:01:00.000Z", reason: "runner disappeared" }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "R1",
        status: "completed",
        conclusion: "failure",
        steps: [
          expect.objectContaining({ job: expect.objectContaining({ status: "completed", conclusion: "timed_out" }) }),
          expect.anything(),
        ],
      }),
    ])
    expect(Queues.ids(app.state().queues)).toEqual(["R1"])
    // Neither batch member integrated, and both keep their standing submit
    // facts — the recovery consumed nothing.
    expect(await terminalFor(app, first.id)).toBeUndefined()
    expect(await terminalFor(app, second.id)).toBeUndefined()
    expect(standingSubmit(app, first.branch)).toMatchObject({ sha: first.headSha })
    expect(standingSubmit(app, second.branch)).toMatchObject({ sha: second.headSha })
    expect(checkCalls).toBe(0)
    expect(mergeCalls).toBe(0)

    const settled = await Array.fromAsync(app.events())
    await expect(app.queue.recover({ recoveryTime: "2026-01-01T00:02:00.000Z" })).resolves.toEqual([])
    expect(await Array.fromAsync(app.events())).toEqual(settled)
  })

  it("reconciles a named dead runner's live-leased run and ignores other runners", async () => {
    let checkCalls = 0
    await using app = await createQueueApp({
      check: () => {
        checkCalls += 1
        return { status: "completed", conclusion: "success", output: { checked: true } }
      },
    })
    const pr = await submitBranch(app, "issue/dead-habitant")
    await app.dispatch(app.commands.queue.run, { prs: [], derived: [pr], steps: ["check", "merge"], baseSha: BASE })
    const job = app.queue.get("R1")?.steps[0]?.job
    if (job === undefined) throw new Error("expected requested check")
    // A LIVE lease far in the future: only the named-runner reclaim releases it.
    await app.dispatch(app.commands.job.transition, {
      type: "start",
      id: job.id,
      attempt: 1,
      runner: "yrd-cli:4242",
      leaseExpiresAt: "2026-01-01T01:00:00.000Z",
    })

    // A different runner's reclaim leaves the live lease alone.
    await expect(
      app.queue.recover({ recoveryTime: "2026-01-01T00:00:30.000Z", runner: "yrd-cli:9999" }),
    ).resolves.toEqual([])
    expect(app.queue.get("R1")?.steps[0]?.job).toMatchObject({ status: "in_progress", runner: "yrd-cli:4242" })

    // The dead runner's reclaim releases the run and advances it to a terminal failure.
    await expect(
      app.queue.recover({ recoveryTime: "2026-01-01T00:00:30.000Z", runner: "yrd-cli:4242" }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "R1",
        status: "completed",
        conclusion: "failure",
        steps: [
          expect.objectContaining({ job: expect.objectContaining({ status: "completed", conclusion: "timed_out" }) }),
          expect.anything(),
        ],
      }),
    ])
    expect(checkCalls).toBe(0)
  })

  it("settles a killed habitant runner's expired-lease ghost via the unscoped lease-expiry sweep (D1b)", async () => {
    // The follow loop's per-tick sweep calls recover with NO runner: it settles a
    // running Job purely because its lease lapsed, no matter who left it. This is
    // the killed-runner ghost the one-shot startup reclaim could not settle.
    let checkCalls = 0
    await using app = await createQueueApp({
      check: () => {
        checkCalls += 1
        return { status: "completed", conclusion: "success", output: { checked: true } }
      },
    })
    const pr = await submitBranch(app, "issue/killed-habitant-ghost")
    await app.dispatch(app.commands.queue.run, { prs: [], derived: [pr], steps: ["check", "merge"], baseSha: BASE })
    const job = app.queue.get("R1")?.steps[0]?.job
    if (job === undefined) throw new Error("expected requested check")
    // A habitant started this check, then was killed; its lease already lapsed.
    await app.dispatch(app.commands.job.transition, {
      type: "start",
      id: job.id,
      attempt: 1,
      runner: "yrd-cli:31337",
      leaseExpiresAt: "2026-01-01T00:00:01.000Z",
    })

    // Unscoped sweep (the per-tick D1b call): settles the orphan to a typed
    // terminal state — job `lost`, run `failed` — without executing the step.
    await expect(
      app.queue.recover({ recoveryTime: "2026-01-01T00:01:00.000Z", reason: "habitant lease-expiry sweep" }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "R1",
        status: "completed",
        conclusion: "failure",
        steps: [
          expect.objectContaining({ job: expect.objectContaining({ status: "completed", conclusion: "timed_out" }) }),
          expect.anything(),
        ],
      }),
    ])
    expect(app.queue.get("R1")?.steps[0]?.job).toMatchObject({
      status: "completed",
      conclusion: "timed_out",
      runner: "yrd-cli:31337",
    })
    expect(checkCalls).toBe(0)

    // Idempotent + cheap: a second sweep with nothing lapsed is a no-op.
    const settled = await Array.fromAsync(app.events())
    await expect(app.queue.recover({ recoveryTime: "2026-01-01T00:02:00.000Z" })).resolves.toEqual([])
    expect(await Array.fromAsync(app.events())).toEqual(settled)
  })

  it("sweeps an orphaned running Job regardless of run/cursor, unlike cursor-only cancelRun (D1b)", async () => {
    // cancelRun (queue.ts cancelRun) is scoped to ONE named run and only its cursor
    // Job. The lease-expiry sweep is unscoped: it settles every orphaned running Job
    // across ALL base queues by lease alone, with no run/cursor target. Two runs on
    // DIFFERENT bases (the serial queue allows one active run per base) each hold a
    // killed-runner ghost; cancelRun clears only the run it names, the sweep clears
    // the untargeted one wherever its cursor sits.
    let checkCalls = 0
    await using app = await createQueueApp({
      check: () => {
        checkCalls += 1
        return { status: "completed", conclusion: "success", output: { checked: true } }
      },
    })
    const onMain = await submitBranch(app, "issue/ghost-untargeted")
    const onRelease = await submitBranch(app, "issue/ghost-canceled", "release/2.0")
    await app.dispatch(app.commands.queue.run, { prs: [], derived: [onMain], steps: ["check", "merge"], baseSha: BASE })
    await app.dispatch(app.commands.queue.run, { prs: [], derived: [onRelease], steps: ["check", "merge"], baseSha: BASE })
    const startGhost = async (run: string, runner: string) => {
      const job = app.queue.get(run)?.steps[0]?.job
      if (job === undefined) throw new Error(`expected requested check for ${run}`)
      await app.dispatch(app.commands.job.transition, {
        type: "start",
        id: job.id,
        attempt: 1,
        runner,
        leaseExpiresAt: "2026-01-01T00:00:01.000Z",
      })
    }
    await startGhost("R1", "yrd-cli:100")
    await startGhost("R2", "yrd-cli:200")

    // Operator cancel is cursor/run-scoped: it settles ONLY R2's cursor Job.
    await app.queue.cancelRun({ run: "R2", by: "operator", reason: "operator canceled" })
    expect(app.queue.get("R2")).toMatchObject({ status: "completed", conclusion: "cancelled" })
    // R1's ghost is left running — cancelRun never looked outside the run it was given.
    expect(app.queue.get("R1")?.steps[0]?.job).toMatchObject({ status: "in_progress", runner: "yrd-cli:100" })

    // The unscoped sweep settles the untargeted R1 ghost by lease expiry alone.
    await expect(app.queue.recover({ recoveryTime: "2026-01-01T00:01:00.000Z" })).resolves.toEqual([
      expect.objectContaining({
        id: "R1",
        status: "completed",
        conclusion: "failure",
        steps: [
          expect.objectContaining({ job: expect.objectContaining({ status: "completed", conclusion: "timed_out" }) }),
          expect.anything(),
        ],
      }),
    ])
    expect(app.queue.get("R1")).toMatchObject({ status: "completed", conclusion: "failure" })
    expect(checkCalls).toBe(0)
  })

  it("releases a replayed lost job before an explicit same-revision retry", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    let checkCalls = 0
    let mergeCalls = 0
    const options = {
      check: () => {
        checkCalls += 1
        return { status: "completed" as const, conclusion: "success" as const, output: { checked: true } }
      },
      merge: () => {
        mergeCalls += 1
        return {
          status: "completed" as const,
          conclusion: "success" as const,
          output: { commit: MERGED, baseSha: BASE },
        }
      },
    }

    {
      await using app = await createQueueApp(options, journal, undefined, id)
      const pr = await submitBranch(app, "issue/crash-gap")
      await app.dispatch(app.commands.queue.run, { prs: [], derived: [pr], steps: ["check", "merge"], baseSha: BASE })
      const job = app.queue.get("R1")?.steps[0]?.job
      if (job === undefined) throw new Error("expected requested crash-gap check")
      await app.dispatch(app.commands.job.transition, {
        type: "start",
        id: job.id,
        attempt: 1,
        runner: "expired-runner",
        leaseExpiresAt: "2026-01-01T00:00:01.000Z",
      })
      await expect(app.jobs.recover({ now: "2026-01-01T00:01:00.000Z" })).resolves.toEqual([job.id])
      expect(await terminalFor(app, pr.id)).toBeUndefined()
    }

    await using replayed = await createQueueApp(options, journal, undefined, id)
    const before = await Array.fromAsync(replayed.events())
    await expect(replayed.queue.recover({ recoveryTime: "2026-01-01T00:02:00.000Z" })).resolves.toEqual([
      expect.objectContaining({ id: "R1", status: "completed", conclusion: "failure" }),
    ])
    expect(await terminalFor(replayed, "PR1")).toBeUndefined()
    expect(checkCalls).toBe(0)
    expect(mergeCalls).toBe(0)
    const appended = (await Array.fromAsync(replayed.events())).slice(before.length)
    expect(appended).toMatchObject([
      {
        name: "queue/run/failed",
        data: {
          run: "R1",
          error: { code: "job-lost" },
          prs: [{ pr: "PR1", revision: 1, headSha: HEAD }],
        },
      },
    ])
    const failed = appended[0]
    if (failed === undefined) throw new Error("expected job loss to append queue/run/failed")
    const authority = Queues.authorityRun(replayed.state().queues.authority, "R1")
    expect(authority?.released).toEqual({ reason: "job-lost", ref: failed.id })
    expect(appended.map(({ name }) => name)).not.toContain("pr/rejected")

    const reconciled = await Array.fromAsync(replayed.events())
    await expect(replayed.queue.recover({ recoveryTime: "2026-01-01T00:03:00.000Z" })).resolves.toEqual([])
    expect(await Array.fromAsync(replayed.events())).toEqual(reconciled)

    // The retry runs the SAME tree: the release returned the standing submit
    // fact's authority, so the branch re-derives at an unmoved `headSha` (the
    // derived lane's ordinal continues off the retained snapshot).
    const retry = memberOf(replayed, "issue/crash-gap")
    expect(retry).toMatchObject({ id: "PR1", headSha: HEAD })
    const retried = await replayed.queue.run({ prs: [], derived: [retry], steps: ["check", "merge"] }, runtime)
    expect(retried.map(({ id: run }) => run)).toEqual(["R2"])
    expect(retried).toMatchObject([
      {
        id: "R2",
        status: "completed",
        conclusion: "success",
        prs: [{ id: "PR1", revision: retry.revision, headSha: HEAD }],
      },
    ])
    expect(await terminalFor(replayed, "PR1")).toMatchObject({ run: "R2", revision: retry.revision, headSha: HEAD })
    expect(Queues.ids(replayed.state().queues)).toEqual(["R1", "R2"])
    expect(checkCalls).toBe(1)
    expect(mergeCalls).toBe(1)
  })

  it("cooperatively aborts a claimed Job when an unsubmitted change terminalizes its Queue Run", async () => {
    const started = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    const log = createLogger("yrd", [{ level: "trace" }, { write: () => {} }])
    await using app = await createQueueApp(
      {
        check: async (_input, context) => {
          started.resolve()
          await new Promise<void>((resolve) => {
            const onAbort = () => {
              aborted.resolve()
              resolve()
            }
            if (context.signal.aborted) onAbort()
            else context.signal.addEventListener("abort", onAbort, { once: true })
          })
          return { status: "completed", conclusion: "success", output: { checked: true } }
        },
      },
      undefined,
      undefined,
      undefined,
      log,
    )
    const pr = await submitBranch(app, "issue/claimed-cancel")
    const running = app.queue.run({ prs: [], derived: [pr], steps: ["check"] }, runtime)
    await started.promise

    // Post-S7 a change is withdrawn by retiring its submit fact — there is no
    // record to close, and the fact IS the delivery.
    await app.bays.recordBranchUnsubmit({ branch: pr.branch, reason: "deleted" })
    await expect(app.queue.cancel({ prs: [pr.id], by: "@chief", reason: "PR withdrawn" })).resolves.toMatchObject([
      {
        status: "completed",
        conclusion: "failure",
        steps: [{ job: { status: "completed", conclusion: "cancelled", attempt: 1, runner: "local" } }],
      },
    ])

    await aborted.promise
    await expect(running).resolves.toMatchObject([{ status: "completed", conclusion: "failure" }])
  })

  it("cancels the run and re-queues its correlated PR when the active Job is canceled", async () => {
    const props = { request: "request-20925" } as const
    const journal = createMemoryJournal()
    const id = ids()
    await using app = await createQueueApp({}, journal, undefined, id)
    await app.bays.recordBranchSubmit({ branch: "issue/canceled", sha: HEAD, base: "main" })
    const pr = memberOf(app, "issue/canceled", { props })
    await app.dispatch(app.commands.queue.run, { prs: [], derived: [pr], steps: ["check"], baseSha: BASE })
    const job = app.queue.get("R1")?.steps[0]?.job
    if (job === undefined) throw new Error("Queue did not request a Job")
    await app.dispatch(app.commands.job.transition, {
      type: "start",
      id: job.id,
      attempt: 1,
      runner: "worker-1",
      leaseExpiresAt: "2026-01-01T00:01:00.000Z",
    })
    await app.jobs.cancel({ id: job.id, attempt: 1, by: "@chief", reason: "authorization revoked" })

    const advanced = await app.dispatch(app.commands.queue.advance, { run: "R1" })

    expect(advanced.events.map(({ name, data }) => ({ name, data }))).toEqual([
      {
        name: "queue/run/canceled",
        data: {
          pr: pr.id,
          revision: pr.revision,
          headSha: pr.headSha,
          run: "R1",
          by: "@chief",
          reason: "authorization revoked",
        },
      },
    ])
    // "Re-queues its correlated PR" post-S7: no terminal was written for the
    // member, and its standing submit fact — the whole of its delivery — is
    // untouched, so the next drain admits it again.
    expect(await terminalFor(app, pr.id)).toBeUndefined()
    expect(standingSubmit(app, pr.branch)).toMatchObject({ sha: pr.headSha, base: "main" })
    expect(app.queue.get("R1")).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
      error: { code: "run-canceled" },
      prs: [{ id: pr.id, revision: pr.revision, headSha: pr.headSha, props }],
      steps: [
        expect.objectContaining({
          job: expect.objectContaining({
            status: "completed",
            conclusion: "cancelled",
            canceledBy: "@chief",
            cancelReason: "authorization revoked",
          }),
        }),
      ],
    })
    const eventNames = (await Array.fromAsync(app.events())).map(({ name }) => name)
    expect(eventNames).not.toContain("pr/rejected")
    expect(eventNames).not.toContain("pr/canceled")
    expect(app.queue.get("R1")?.error?.code).not.toBe("job-lost")

    await using replayed = await createQueueApp({}, journal, undefined, id)
    expect(replayed.queue.get("R1")).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
      prs: [{ id: pr.id, revision: pr.revision, headSha: pr.headSha, props }],
    })
    expect(await terminalFor(replayed, pr.id)).toBeUndefined()
    expect(standingSubmit(replayed, pr.branch)).toMatchObject({ sha: pr.headSha })
    await expect(replayed.queue.run({ prs: [], derived: [pr], steps: ["check"] }, runtime)).resolves.toMatchObject([
      {
        id: "R2",
        status: "completed",
        conclusion: "success",
        prs: [{ id: pr.id, revision: pr.revision, headSha: pr.headSha, props }],
      },
    ])
  })

  it("keys a selected step suffix by run order rather than installed order", async () => {
    await using app = await createQueueApp()
    const pr = await submitBranch(app, "issue/selected-suffix")

    const run = (await app.queue.run({ prs: [], derived: [pr], steps: ["merge", "deploy"] }, runtime))[0]

    expect(run).toMatchObject({
      status: "completed",
      conclusion: "success",
      steps: [{ name: "merge" }, { name: "deploy" }],
      shape: { integration: { commit: MERGED }, results: { deploy: { environment: "staging" } } },
    })
    expect(Queues.get(app.state().queues, "R1")?.steps).toEqual([
      expect.not.objectContaining({ index: expect.anything() }),
      expect.not.objectContaining({ index: expect.anything() }),
    ])
    expect(app.state().jobs.byKey).toMatchObject({ "queue:R1:0": expect.any(String), "queue:R1:1": expect.any(String) })
  })

  it("rejects a failure event for an unknown Queue run as journal corruption", async () => {
    const journal = createMemoryJournal([
      {
        cause: {
          id: "00000000-0000-7000-8000-000000000002",
          commandId: "00000000-0000-7000-8000-000000000001",
          op: "queue.advance",
          commandHash: Command.hash({ op: "queue.advance" }),
        },
        command: { id: "00000000-0000-7000-8000-000000000001", op: "queue.advance" },
        events: [
          {
            id: "00000000-0000-7000-8000-000000000003",
            name: "queue/run/failed",
            ts: "2026-07-10T00:00:00.000Z",
            data: { run: "R404", error: { code: "missing-run", message: "missing" } },
          },
        ],
      },
    ])

    await expect(createQueueApp({}, journal)).rejects.toThrow("no queue run 'R404'")
  })

  it("runs checks, merge, and deploy across base queues and derives every Job field", async () => {
    await using app = await createQueueApp({
      batch: 2,
      deploy: (input) => ({ status: "completed", conclusion: "success", output: { environment: input.prs[0]!.base } }),
    })
    const first = await submitBranch(app, "issue/one")
    const second = await submitBranch(app, "issue/two")
    const release = await submitBranch(app, "issue/release", "release/2.0")

    const runs = await app.queue.run({ derived: [first, second, release] }, runtime)

    expect(runs.map((run) => [run.base, run.prs.map((pr) => pr.id)])).toEqual([
      ["main", [first.id, second.id]],
      ["release/2.0", [release.id]],
    ])
    for (const run of runs) {
      expect(run).toMatchObject({
        status: "completed",
        conclusion: "success",
        shape: {
          results: {
            check: { checked: true },
            review: { approved: true },
            deploy: { environment: run.base },
          },
          integration: { commit: MERGED, baseSha: BASE },
        },
      })
      expect(run.steps.every((step) => step.job?.status === "completed" && step.job.conclusion === "success")).toBe(
        true,
      )
      expect(
        run.steps.every(
          (step) =>
            step.job?.status === "completed" &&
            step.job.conclusion === "success" &&
            step.job.startedAt !== "" &&
            step.job.finishedAt !== "",
        ),
      ).toBe(true)
      const record = Queues.get(app.state().queues, run.id)
      expect(record).not.toHaveProperty("status")
      expect(record).not.toHaveProperty("jobIds")
      expect(record).not.toHaveProperty("shape")
    }
    // The integration proof reaches each member through its terminal — the
    // settlement's `pr/integrated`, which is where the record's `integration`
    // projection used to be read from.
    const proofs = (await Array.fromAsync(app.events()))
      .filter(({ name }) => name === "pr/integrated")
      .map(({ data }) => data)
    expect(proofs).toEqual([
      expect.objectContaining({ commit: MERGED, baseSha: BASE }),
      expect.objectContaining({ commit: MERGED, baseSha: BASE }),
      expect.objectContaining({ commit: MERGED, baseSha: BASE }),
    ])
    expect(app.queue.status("main").finished).toHaveLength(1)
    expect(app.queue.status("release/2.0").finished).toHaveLength(1)
  })

  it("refuses to reconcile a repository merge into the retired record index (S7: merged-truth is the authority)", async () => {
    await using app = await createQueueApp()
    const pr = await submitBranch(app, "issue/result-index-gap")
    const fact = {
      pr: pr.id,
      revision: pr.revision,
      headSha: pr.headSha,
      run: "R-recovered",
      commit: MERGED,
      landingSha: MERGED,
      baseSha: BASE,
      changeId: pr.changeId,
    }

    await expect(app.queue.reconcileMerge(fact)).rejects.toThrow(/retired/u)

    // Nothing was reconciled anywhere: the branch's submit fact still stands
    // exactly as pushed, and no terminal was written.
    expect(standingSubmit(app, pr.branch)).toMatchObject({ sha: pr.headSha, base: "main" })
    expect((await Array.fromAsync(app.events())).filter(({ name }) => name === "pr/integrated")).toHaveLength(0)
  })

  it("replays historical pr/* frames for a same-payload change without materializing a second member", async () => {
    const journal = createMemoryJournal<unknown>()
    const original = await createQueueApp({}, journal)
    const current = await submitBranch(original, "issue/current-payload")
    await original.close()

    let cursor = 0
    for await (const batch of journal.read()) cursor = batch.cursor
    const command = { id: "00000000-0000-7000-8000-000000000111", op: "fixture.canceled-duplicate" }
    expect(
      await journal.append(
        {
          command,
          cause: {
            id: "00000000-0000-7000-8000-000000000112",
            commandId: command.id,
            op: command.op,
            commandHash: Command.hash(command),
          },
          events: [
            {
              id: "00000000-0000-7000-8000-000000000113",
              name: "pr/pushed",
              ts: "2026-01-01T00:00:01.000Z",
              data: {
                pr: "PR2",
                branch: "issue/canceled-history",
                base: "main",
                baseSha: BASE,
                headSha: current.headSha,
                revision: 1,
              },
            },
            {
              id: "00000000-0000-7000-8000-000000000114",
              name: "pr/submitted",
              ts: "2026-01-01T00:00:01.001Z",
              data: { pr: "PR2", revision: 1, headSha: current.headSha },
            },
            {
              id: "00000000-0000-7000-8000-000000000115",
              name: "pr/canceled",
              ts: "2026-01-01T00:00:01.002Z",
              data: {
                pr: "PR2",
                revision: 1,
                headSha: current.headSha,
                by: "@chief",
                reason: "superseded",
              },
            },
          ],
        },
        cursor,
      ),
    ).toMatchObject({ appended: true })

    await using app = await createQueueApp({}, journal, undefined, ids(500))
    const before = (await Array.fromAsync(app.events())).length
    await app.queue.run({ prs: [], derived: [current], steps: ["check", "review", "merge"] }, runtime)
    const integrated = (await Array.fromAsync(app.events()))
      .slice(before)
      .filter((applied) => applied.name === "pr/integrated")
      .map((applied) => (applied.data as { pr: string }).pr)

    // S7: the historical `pr/pushed`/`pr/submitted`/`pr/canceled` frames still
    // PARSE on replay (the bay registries are the acceptance authority) but
    // project NOTHING — so the payload-sharing `PR2` never becomes a member,
    // and only the branch that actually has a submit fact integrates.
    expect(integrated).toEqual([current.id])
    expect(snapshotOf(app, "PR2")).toBeUndefined()
    expect(Object.keys(app.state().bays.submits)).toEqual([current.branch])
  })

  it("integrates the implicit queue in PR revision submission order", async () => {
    let tick = 0
    await using app = await createQueueApp({ batch: 1 }, createMemoryJournal(), () =>
      new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick++)).toISOString(),
    )
    // The submit CLOCK, not the identity order, decides the queue: the branch
    // whose fact is older runs first even though its number was minted second.
    await app.bays.recordBranchSubmit({ branch: "issue/submitted-first", sha: UPDATED, base: "main" })
    await app.bays.recordBranchSubmit({ branch: "issue/created-first", sha: HEAD, base: "main" })
    const createdFirst = memberOf(app, "issue/created-first")
    const submittedFirst = memberOf(app, "issue/submitted-first")
    expect([createdFirst.id, submittedFirst.id]).toEqual(["PR1", "PR2"])

    expect(app.queue.admissionOrder()).toEqual(["PR2", "PR1"])
    const runs = await app.queue.run({ derived: [createdFirst, submittedFirst] }, runtime)

    expect(runs.map((run) => run.prs.map((pr) => pr.id))).toEqual([["PR2"], ["PR1"]])
  })

  it("admits configured checks through Queue once and reuses their journaled result for integration", async () => {
    let checks = 0
    await using app = await createQueueApp({
      check: () => {
        checks++
        return { status: "completed", conclusion: "success", output: { checked: true } }
      },
    })
    const pr = await submitBranch(app, "issue/admitted")

    expect(app.queue.eligibility(pr.id)).toMatchObject({
      runnable: false,
      reason: { code: "checks-pending" },
      checks: { status: "queued", position: 1, queuedAt: expect.any(String) },
    })
    expect(await app.queue.admit({ prs: [pr.id] }, runtime)).toEqual([pr.id])
    expect(checks).toBe(1)
    // S7: `recordRevisionAdmission` writes nothing onto a change any more — the
    // verdict's durable home is the admission JOBS, keyed by
    // `admission:<pr>:<rev>:<baseSha>:<index>:<stepRevision>`.
    expect(revisionAdmissionJob(app.jobs, pr, BASE, 0, "check-v1")).toMatchObject({
      status: "completed",
      conclusion: "success",
      output: { checked: true },
    })
    expect(revisionAdmissionJob(app.jobs, pr, BASE, 1, "review-v1")).toMatchObject({
      status: "completed",
      conclusion: "success",
      output: { approved: true },
    })
    expect(Queues.ids(app.state().queues)).toEqual([])
    expect(app.queue.eligibility(pr.id)).toMatchObject({
      runnable: true,
      checks: { status: "passed" },
    })

    const integrated = (await app.queue.run({ prs: [], derived: [pr] }, runtime))[0]
    expect(integrated).toMatchObject({
      id: "R1",
      status: "completed",
      conclusion: "success",
      steps: [{ name: "merge" }, { name: "deploy" }],
      shape: {
        results: { check: { checked: true }, review: { approved: true }, deploy: { environment: "staging" } },
        integration: { commit: MERGED, baseSha: BASE },
      },
    })
    expect(checks).toBe(1)
  })

  it("names the fully reused admission prefix when a change emits no run events", async () => {
    await using app = await createQueueApp({ defaultSteps: ["check"] })
    const pr = await submitBranch(app, "issue/covered-pr")
    expect(await app.queue.admit({ prs: [pr.id] }, runtime)).toEqual([pr.id])
    expect(revisionAdmissionJob(app.jobs, pr, BASE, 0, "check-v1")).toMatchObject({
      status: "completed",
      conclusion: "success",
    })

    const result = await app.dispatch(app.commands.queue.run, { prs: [], derived: [pr], baseSha: BASE })

    expect(result.events).toEqual([])
    expect(result.value).toEqual({
      kind: "reusable-prefix-covered",
      coveredCount: 1,
      coveredSteps: ["check"],
      members: [pr.id],
      reason: "reusable prefix fully covered the selected plan",
      selectedSteps: ["check"],
      source: "revision-admission",
    })
  })

  it("owns the admission drain inside Queue before integrating the same cached proof", async () => {
    let checks = 0
    await using app = await createQueueApp({
      check: () => {
        checks++
        return { status: "completed", conclusion: "success", output: { checked: true } }
      },
    })
    const pr = await submitBranch(app, "issue/queue-owned-drain")
    expect(await app.queue.admit({ prs: [pr.id] })).toHaveLength(1)
    expect(checks).toBe(0)

    const integrated = await app.queue.run({ prs: [], derived: [pr] }, runtime)

    expect(integrated).toMatchObject([{ id: "R1", status: "completed", conclusion: "success" }])
    expect(checks).toBe(1)
  })

  it("does not drive an unrelated active admission for an explicit selection", async () => {
    const checkedPRs: string[] = []
    await using app = await createQueueApp({
      check: (input) => {
        const pr = input.prs[0]
        if (pr === undefined) throw new Error("expected one change per admission check")
        checkedPRs.push(pr.id)
        return { status: "completed", conclusion: "success", output: { checked: true } }
      },
    })
    const active = await submitBranch(app, "issue/unrelated-active-check")
    const selected = await submitBranch(app, "issue/explicitly-selected-check")

    expect(await app.queue.admit({ prs: [active.id] })).toEqual([active.id])
    expect(revisionAdmissionJob(app.jobs, active)).toMatchObject({ status: "queued" })

    await app.queue.run({ prs: [], derived: [selected] }, runtime)

    expect(checkedPRs).toEqual([selected.id])
    expect(revisionAdmissionJob(app.jobs, active)).toMatchObject({ status: "queued" })
    expect(await terminalFor(app, selected.id)).toMatchObject({ run: "R1", commit: MERGED })
  })

  it("waits for every selected check before composing a mixed-ready explicit selection", async () => {
    await using app = await createQueueApp({
      check: () => ({ status: "completed", conclusion: "success", output: { checked: true } }),
    })
    const ready = await submitBranch(app, "issue/ready-selected-check")
    const readyAdmission = (await app.queue.admit({ prs: [ready.id] }, runtime))[0]
    if (readyAdmission === undefined) throw new Error("expected a settled selected admission")
    expect(app.queue.eligibility(ready.id)).toMatchObject({ runnable: true })

    const active = await submitBranch(app, "issue/unrelated-active-check")
    const admission = (await app.queue.admit({ prs: [active.id] }))[0]
    if (admission === undefined) throw new Error("expected an unrelated active admission")

    const pending = await submitBranch(app, "issue/pending-selected-check")

    const runIdsBefore = Queues.ids(app.state().queues)
    expect(await app.queue.run({ prs: [], derived: [ready, pending] }, runtime)).toMatchObject([
      { id: "R1", status: "completed", conclusion: "success", prs: [{ id: ready.id }] },
      { id: "R2", status: "completed", conclusion: "success", prs: [{ id: pending.id }] },
    ])
    expect(Queues.ids(app.state().queues)).toEqual([...runIdsBefore, "R1", "R2"])
    expect(admission).toBe(active.id)
    expect(revisionAdmissionJob(app.jobs, active)).toMatchObject({ status: "queued" })
    expect(await terminalFor(app, ready.id)).toMatchObject({ run: "R1", commit: MERGED })
    expect(await terminalFor(app, pending.id)).toMatchObject({ run: "R2", commit: MERGED })
  })

  it("limits an explicit admission drain to the selected PR instead of older queued checks", async () => {
    const checkedPRs: string[] = []
    const journal = createMemoryJournal()
    await using app = await createQueueApp(
      {
        check: (input) => {
          const pr = input.prs[0]
          if (pr === undefined) throw new Error("expected one change per admission check")
          checkedPRs.push(pr.id)
          return { status: "completed", conclusion: "success", output: { checked: true } }
        },
      },
      journal,
    )
    const queued = await submitBranch(app, "issue/unrelated-queued-check")
    const selected = await submitBranch(app, "issue/explicitly-selected-check")

    await app.queue.run({ prs: [], derived: [selected] }, runtime)

    expect(checkedPRs).toEqual([selected.id])
    expect(app.queue.eligibility(selected.id)).toMatchObject({ checks: { status: "passed" } })
    expect(app.queue.eligibility(queued.id)).toMatchObject({
      runnable: false,
      reason: { code: "checks-pending" },
      checks: { status: "queued" },
    })
    expect(Queues.values(app.state().queues).flatMap((run) => run.prs.map((pr) => pr.id))).not.toContain(queued.id)

    // S7: `recordRevisionAdmission` no longer journals `pr/admission-recorded`
    // — the verdict lives in the admission Jobs. "Only the selected change was
    // admitted" is therefore read there: the selected member's check job ran to
    // a verdict, the unrelated queued one is still sitting at `queued`.
    const admissionEvents: string[] = []
    for await (const batch of journal.read()) {
      admissionEvents.push(
        ...batch.values
          .map((value) => parseJournalFrame(value))
          .flatMap(({ events }) => events)
          .filter(({ name }) => name === "pr/admission-recorded")
          .map(({ data }) => (data as { pr: string }).pr),
      )
    }
    expect(admissionEvents).toEqual([])
    expect(revisionAdmissionJob(app.jobs, selected)).toMatchObject({ status: "completed", conclusion: "success" })
    expect(revisionAdmissionJob(app.jobs, queued)).toMatchObject({ status: "queued" })
  })

  it("scopes an explicit Queue.admit drain after resolving a branch selector", async () => {
    const checkedPRs: string[] = []
    await using app = await createQueueApp({
      check: (input) => {
        const pr = input.prs[0]
        if (pr === undefined) throw new Error("expected one change per admission check")
        checkedPRs.push(pr.id)
        return { status: "completed", conclusion: "success", output: { checked: true } }
      },
    })
    const queued = await submitBranch(app, "issue/unrelated-queued-admit")
    const selected = await submitBranch(app, "issue/explicitly-selected-admit")

    await app.queue.admit({ prs: [selected.branch] }, runtime)

    expect(checkedPRs).toEqual([selected.id])
    expect(app.queue.eligibility(selected.id)).toMatchObject({ checks: { status: "passed" } })
    expect(app.queue.eligibility(queued.id)).toMatchObject({
      reason: { code: "checks-pending" },
      checks: { status: "queued" },
    })
  })

  it("integrates a checks-passed PR while another admission's check is still in flight", async () => {
    await using app = await createQueueApp({
      check: () => ({ status: "completed", conclusion: "success", output: { checked: true } }),
    })
    // PR A becomes merge-ready: checks requested, admitted, drained to passed.
    const ready = await submitBranch(app, "issue/merge-ready")
    await expect(app.queue.admit({ prs: [ready.id] }, runtime)).resolves.toEqual([ready.id])
    // The passed verdict's surviving home: the admission Job keyed to this
    // member, revision, and base.
    expect(revisionAdmissionJob(app.jobs, ready, BASE, 0, "check-v1")).toMatchObject({
      status: "completed",
      conclusion: "success",
    })
    expect(app.queue.eligibility(ready.id)).toMatchObject({ runnable: true })

    // PR B's admission Job is claimed by a FOREIGN runner holding a live
    // lease: a genuinely in-flight check this drain cannot settle. Under
    // continuous submissions the habitant sees one of these on every tick,
    // so an in-flight check must never gate the merge phase (2026-07-22
    // merge-starvation incidents: three independent reproductions).
    const inflight = await submitBranch(app, "issue/check-in-flight")
    const admission = (await app.queue.admit({ prs: [inflight.id] }))[0]
    if (admission === undefined) throw new Error("expected admitted PR id for the in-flight PR")
    const job = revisionAdmissionJob(app.jobs, inflight)
    if (job === undefined) throw new Error("expected requested in-flight check Job")
    await app.dispatch(app.commands.job.transition, {
      type: "start",
      id: job.id,
      attempt: 1,
      runner: "busy-foreign-runner",
      leaseExpiresAt: "2026-01-01T00:05:00.000Z",
    })

    // Habitant drain tick: the merge phase must run for the checks-passed PR
    // in this same tick, not wait for the foreign-held check to settle.
    const runs = await app.queue.run({ derived: [ready, inflight] }, runtime)
    expect(runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "completed",
          conclusion: "success",
          prs: [expect.objectContaining({ id: ready.id })],
        }),
      ]),
    )
  })

  it("bounds environment-refused admission retries and parks unchanged check authority", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    let refuseEnvironment = true
    let checks = 0
    const options = {
      resolveBaseSha: () => BASE,
      check: () => {
        checks++
        return refuseEnvironment
          ? {
              status: "completed",
              conclusion: "failure",
              error: {
                code: "queue-environment-refused",
                message: "inherited-red check environment is unavailable",
              },
            }
          : { status: "completed", conclusion: "success", output: { checked: true } }
      },
    } satisfies Parameters<typeof queuePlugin>[0]
    {
      await using app = await createQueueApp(options, journal, undefined, id)
      const pr = await submitBranch(app, "issue/bounded-admission-retry")

      let drainTurns = 0
      const refused = await app.queue.run({ prs: [], derived: [pr] }, { ...runtime, continueAdmissions: () => ++drainTurns <= 6 })

      expect(refused).toEqual([])
      expect(checks).toBe(1)
      expect(app.queue.eligibility(pr.id)).toMatchObject({
        runnable: false,
        reason: { code: "required-check-failed" },
        checks: { status: "failed" },
      })
      expect(refusedAdmission(app, pr.id)).toMatchObject({
        branch: pr.branch,
        code: "queue-environment-refused",
        kind: "failure",
      })
      expect(Queues.ids(app.state().queues)).toEqual([])
    }

    await using replayed = await createQueueApp(options, journal, undefined, id)
    expect(replayed.queue.eligibility("PR1")).toMatchObject({
      runnable: false,
      reason: { code: "required-check-failed" },
      checks: { status: "failed" },
    })

    let habitantTurns = 0
    expect(await replayed.queue.run({}, { ...runtime, continueAdmissions: () => ++habitantTurns <= 3 })).toEqual([])
    expect(checks).toBe(1)
    expect(Queues.ids(replayed.state().queues)).toEqual([])

    refuseEnvironment = false
    // Re-derived on the REPLAYED app, not selected by record id: the member is
    // rebuilt from the surviving submit fact, and the journal-keyed mint hands
    // back the same PR1 the original run issued.
    expect(
      await replayed.queue.run({ derived: [memberOf(replayed, "issue/bounded-admission-retry")] }, runtime),
    ).toMatchObject([{ id: "R1", status: "completed", conclusion: "success" }])
    expect(checks).toBe(2)
  })

  it("lets an admitted check settle but suppresses every retry once the queue is paused", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    const checkStarted = Promise.withResolvers<void>()
    const finishCheck = Promise.withResolvers<void>()
    let checks = 0
    const options = {
      resolveBaseSha: () => BASE,
      check: async () => {
        checks++
        if (checks === 1) {
          checkStarted.resolve()
          await finishCheck.promise
        }
        return {
          status: "completed" as const,
          conclusion: "failure" as const,
          error: {
            code: "queue-environment-refused",
            message: "inherited-red check environment is unavailable",
          },
        }
      },
    } satisfies Parameters<typeof queuePlugin>[0]
    await using runner = await createQueueApp(options, journal, undefined, id)
    const pr = await submitBranch(runner, "issue/pause-admitted-retry")
    await using operator = await createQueueApp(options, journal, undefined, id)

    let drainTurns = 0
    const draining = runner.queue.run({ prs: [], derived: [pr] }, { ...runtime, continueAdmissions: () => ++drainTurns <= 6 })
    await checkStarted.promise
    await operator.queue.pause({
      base: "main",
      reason: "operator freeze",
      allowedPRs: [],
      expiresAt: "2026-01-01T01:00:00.000Z",
    })
    finishCheck.resolve()

    expect(await draining).toEqual([])
    expect(checks).toBe(1)
    expect(Queues.ids(runner.state().queues)).toEqual([])
    expect(runner.queue.eligibility(pr.id)).toMatchObject({
      runnable: false,
      reason: { code: "required-check-failed" },
      checks: { status: "failed" },
    })
    expect(await runner.queue.admit({ prs: [pr.id] }, runtime)).toEqual([])
    expect(Queues.ids(runner.state().queues)).toEqual([])

    await operator.queue.resume("main")
    await runner.refresh()
    expect(await runner.queue.admit({ prs: [pr.id] }, runtime)).toEqual([])
    expect(refusedAdmission(runner, pr.id)).toMatchObject({ branch: pr.branch, kind: "failure" })
    expect(checks).toBe(1)
  })

  it("does not let an unrelated waiting admission monopolize Queue capacity", async () => {
    await using app = await createQueueApp({
      check: (input) =>
        input.prs[0]?.id === "PR1"
          ? { status: "waiting", token: "remote-one" }
          : { status: "completed", conclusion: "success", output: { checked: true } },
    })
    const waiting = await submitBranch(app, "issue/waiting-check")
    const healthy = await submitBranch(app, "issue/healthy-check")

    expect(await app.queue.admit({ prs: [waiting.id] }, runtime)).toEqual([waiting.id])
    expect(app.queue.waitingAdmission(waiting.id)?.step.job).toMatchObject({ status: "waiting" })
    expect(await app.queue.admit({ prs: [healthy.id] }, runtime)).toEqual([healthy.id])
    expect(revisionAdmissionJob(app.jobs, healthy, BASE, 0, "check-v1")).toMatchObject({
      status: "completed",
      conclusion: "success",
    })
    expect(app.queue.eligibility(waiting.id)).toMatchObject({ checks: { status: "checking" } })
    expect(app.queue.eligibility(healthy.id)).toMatchObject({ checks: { status: "passed" } })
  })

  it("does not supersede another PR's unstarted admission for an explicit merge", async () => {
    let checkCalls = 0
    let mergeCalls = 0
    await using app = await createQueueApp({
      check: () => {
        checkCalls += 1
        return { status: "completed", conclusion: "success", output: { checked: true } }
      },
      merge: () => {
        mergeCalls += 1
        return { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
      },
    })
    const first = await submitBranch(app, "issue/first-admission")
    const second = await submitBranch(app, "issue/second-merge")
    expect(await app.queue.admit({ prs: [first.id] })).toEqual([first.id])
    expect(revisionAdmissionJob(app.jobs, first)).toMatchObject({ status: "queued" })

    // The check-only admission does not gate the integrating run (2026-07-22
    // merge-starvation fix) — but it must survive UNTOUCHED: proceeding must
    // never supersede or release another PR's admission.
    await expect(app.queue.run({ prs: [], derived: [second], steps: ["merge"] }, runtime)).resolves.toMatchObject([
      { status: "completed", conclusion: "success", prs: [{ id: second.id }] },
    ])
    expect(checkCalls).toBe(0)
    expect(mergeCalls).toBe(1)
    expect(revisionAdmissionJob(app.jobs, first)).toMatchObject({ status: "queued" })
  })

  it("keys admission reuse by the freshly resolved base SHA", async () => {
    let baseSha = BASE
    let checks = 0
    const checkedBases: Array<string | undefined> = []
    await using app = await createQueueApp({
      resolveBaseSha: () => baseSha,
      check: (input) => {
        checks++
        checkedBases.push(input.prs[0]?.baseSha)
        return { status: "completed", conclusion: "success", output: { checked: true } }
      },
    })
    const pr = await submitBranch(app, "issue/base-keyed-cache")
    expect(await app.queue.admit({ prs: [pr.id] }, runtime)).toEqual([pr.id])
    expect(revisionAdmissionJob(app.jobs, pr, BASE, 0, "check-v1")).toMatchObject({
      status: "completed",
      conclusion: "success",
    })
    expect(checks).toBe(1)

    baseSha = UPDATED
    const integrated = await app.queue.run({ prs: [], derived: [pr] }, runtime)

    expect(integrated).toMatchObject([{ status: "completed", conclusion: "success" }])
    expect(checks).toBe(2)
    expect(checkedBases).toEqual([BASE, UPDATED])
    expect(app.queue.get("R1")?.prs).toMatchObject([{ baseSha: UPDATED }])
  })

  it("resolves each queue base once per cycle instead of once per change", async () => {
    const resolvedBases: string[] = []
    await using app = await createQueueApp({
      batch: 4,
      resolveBaseSha: (base) => {
        resolvedBases.push(base)
        return BASE
      },
    })
    const prs = [
      await submitBranch(app, "issue/main-a"),
      await submitBranch(app, "issue/main-b", "origin/main"),
      await submitBranch(app, "issue/release-a", "release"),
      await submitBranch(app, "issue/release-b", "refs/heads/release"),
    ]

    await app.queue.run({ derived: prs }, runtime)

    expect(resolvedBases).toEqual(["main", "release"])
  })

  it("refuses integration when a clear main-health admission turns green then same-base red", async () => {
    let mainHealth: "clear" | "green" | "red" = "clear"
    let checks = 0
    let merges = 0
    await using app = await createQueueApp({
      checkClassification: "base",
      check: () => {
        checks++
        if (mainHealth === "red") {
          return {
            status: "completed",
            conclusion: "failure",
            error: { code: "base-red", message: "same-base main-health lock is red" },
          }
        }
        mainHealth = "green"
        return { status: "completed", conclusion: "success", output: { checked: true } }
      },
      merge: () => {
        merges++
        return { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
      },
    })
    const pr = await submitBranch(app, "issue/main-health-turns-red")

    expect(mainHealth).toBe("clear")
    expect(await app.queue.admit({ prs: [pr.id] }, runtime)).toEqual([pr.id])
    expect(revisionAdmissionJob(app.jobs, pr, BASE, 0, "check-v1")).toMatchObject({
      status: "completed",
      conclusion: "success",
    })
    expect(mainHealth).toBe("green")
    expect(checks).toBe(1)

    mainHealth = "red"
    const refused = await app.queue.run({ prs: [], derived: [pr] }, runtime)

    expect(refused).toMatchObject([{ id: "R1", status: "completed", conclusion: "failure", prs: [{ baseSha: BASE }] }])
    expect(refused[0]?.steps[0]).toMatchObject({
      name: "check",
      classification: "base",
      job: { status: "completed", conclusion: "failure", error: { code: "base-red" } },
    })
    expect(refused[0]).not.toHaveProperty("reusedFrom")
    // The member's own admission verdict is untouched by the base's red: its
    // check Job still stands passed against this base.
    expect(revisionAdmissionJob(app.jobs, pr, BASE, 0, "check-v1")).toMatchObject({
      status: "completed",
      conclusion: "success",
    })
    expect(checks).toBe(2)
    expect(merges).toBe(0)
    // Nothing integrated and the submission still stands — the base-classified
    // red bills the base, never the author.
    expect(await terminalFor(app, pr.id)).toBeUndefined()
    expect(standingSubmit(app, pr.branch)).toMatchObject({ sha: pr.headSha })
    // `queue.checks` was deleted with the record lane; the run's own step Job,
    // asserted above, is the surviving home of that verdict row.
    expect(app.queue.eligibility(pr.id)).toMatchObject({ checks: { status: "failed", run: "R1" } })
  })

  it("recovery cancels an unstarted revision admission Job after its submission is retired", async () => {
    await using app = await createQueueApp()
    const pr = await submitBranch(app, "issue/stale-before-job")
    expect(await app.queue.admit({ prs: [pr.id] })).toHaveLength(1)
    const job = revisionAdmissionJob(app.jobs, pr)
    if (job === undefined) throw new Error("expected requested revision admission Job")
    // Post-S7 a change goes away by retiring its submit fact — there is no
    // record left to close.
    await app.bays.recordBranchUnsubmit({ branch: pr.branch, reason: "deleted" })

    expect(app.jobs.get(job.id)).toMatchObject({ status: "queued" })
    expect(await app.queue.recover({ recoveryTime: "2026-01-01T00:01:00.000Z" })).toEqual([])
    expect(app.jobs.get(job.id)).toMatchObject({ status: "completed", conclusion: "cancelled" })
    // `queue.checks` was deleted with the record lane; the cancelled admission
    // Job asserted above is the surviving verdict row.
    expect(refusedAdmission(app, pr.id)).toBeUndefined()
  })

  it("replays a legacy pinned-run failure before its requested Job starts", async () => {
    const journal = createMemoryJournal<unknown>()
    const id = ids()
    let prId = ""

    {
      await using app = await createQueueApp({ defaultSteps: ["check"] }, journal, undefined, id)
      const pr = await submitBranch(app, "issue/legacy-stale-before-job")
      prId = pr.id
    }

    let cursor = 0
    for await (const batch of journal.read()) cursor = batch.cursor
    const history = queueHistoryFrames(1, undefined, ids(1_000_000))[0]
    if (history === undefined) throw new Error("expected historical Queue fixture")
    const admission = structuredClone(legacyAdmissionRunFrame(history))
    const snapshot = {
      id: prId,
      branch: "issue/legacy-stale-before-job",
      base: "main",
      revision: 1,
      headSha: HEAD,
      baseSha: BASE,
    }
    for (const applied of admission.events) {
      if (applied.name === "queue/run/started") {
        const data = applied.data as { run?: { prs?: unknown } }
        if (data.run === undefined) throw new Error("expected historical Queue start")
        data.run.prs = [snapshot]
      }
      if (applied.name === "job/requested") {
        const data = applied.data as { input?: { prs?: unknown } }
        if (data.input === undefined) throw new Error("expected historical Queue Job")
        data.input.prs = [snapshot]
      }
    }
    admission.events = admission.events.filter(({ name }) => name !== "job/transitioned")
    expect(await journal.append(parseJournalFrame(admission), cursor)).toMatchObject({ appended: true })

    {
      await using app = await createQueueApp({ defaultSteps: ["check"] }, journal, undefined, id)
      expect(app.queue.get("R1")).toMatchObject({
        status: "queued",
        prs: [{ id: prId }],
        stepSelection: { authority: "admission" },
      })
      // Retiring the submit fact is what makes the pinned run stale post-S7:
      // `pinnedChangeError` asks the live fact whether it still stands at the
      // pinned sha, where it used to ask a record whether it was still open.
      await app.bays.recordBranchUnsubmit({ branch: "issue/legacy-stale-before-job", reason: "deleted" })
      const admitted = await app.queue.admit({ prs: [prId] }, runtime)
      expect(app.queue.get("R1")).toMatchObject({
        id: "R1",
        status: "completed",
        conclusion: "failure",
        error: { code: "stale-pr" },
      })
      expect(admitted).toEqual([prId])
    }

    const frames: JournalFrame[] = []
    for await (const batch of journal.read()) {
      frames.push(...batch.values.map((value) => parseJournalFrame(value)))
    }
    const lifecycle = frames
      .flatMap((frame) => frame.events)
      .filter(({ name }) =>
        ["queue/run/started", "job/requested", "branch/unsubmitted", "queue/run/failed"].includes(name),
      )
      .map(({ name }) => name)
    expect(lifecycle).toEqual(["queue/run/started", "job/requested", "branch/unsubmitted", "queue/run/failed"])

    await using replayed = await createQueueApp({ defaultSteps: ["check"] }, indexedJournal(frames), undefined, id)
    expect(replayed.queue.get("R1")).toMatchObject({
      id: "R1",
      status: "completed",
      conclusion: "failure",
      error: { code: "stale-pr" },
    })
    expect(replayed.queue.get("R1")?.steps[0]?.job).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
      canceledBy: "yrd/queue",
      cancelReason: "Legacy Queue run 'R1' failed before the Job started",
    })
    expect(replayed.state().jobs.retention.queueTerminalOrder.R1).toBeDefined()
  })

  it("keeps admission globally FIFO even when a later PR is selected explicitly", async () => {
    const checked: string[] = []
    const journal = createMemoryJournal()
    await using app = await createQueueApp(
      {
        check: (input) => {
          checked.push(input.prs[0]!.id)
          return { status: "completed", conclusion: "success", output: { checked: true } }
        },
      },
      journal,
    )
    const first = await submitBranch(app, "issue/first-check")
    const second = await submitBranch(app, "issue/second-check")

    expect(app.queue.eligibility(second.id)).toMatchObject({ checks: { status: "queued", position: 2 } })
    expect(await app.queue.admit({ prs: [second.id] })).toEqual([])
    expect(await app.queue.admit({}, runtime)).toEqual([first.id, second.id])
    expect(checked).toEqual([first.id, second.id])

    const admittedChanges: string[] = []
    for await (const batch of journal.read()) {
      admittedChanges.push(
        ...batch.values
          .map((value) => parseJournalFrame(value))
          .flatMap(({ events }) => events)
          .filter(({ name }) => name === "pr/admission-recorded")
          .map(({ data }) => (data as { pr: string }).pr),
      )
    }
    expect(admittedChanges).toStrictEqual([first.id, second.id])
  })

  it("orders admission age and position from the check request fact, not the earlier push", async () => {
    let now = "2026-01-01T00:00:00.000Z"
    await using app = await createQueueApp({}, createMemoryJournal(), () => now)
    const pushedFirst = await submitBranch(app, "issue/pushed-first")
    now = "2026-01-01T00:01:00.000Z"
    const requestedFirst = await submitBranch(app, "issue/requested-first")
    now = "2026-01-01T00:02:00.000Z"
    now = "2026-01-01T00:03:00.000Z"

    expect(app.queue.eligibility(requestedFirst.id)).toMatchObject({
      checks: { status: "queued", position: 1, queuedAt: "2026-01-01T00:02:00.000Z" },
    })
    expect(app.queue.eligibility(pushedFirst.id)).toMatchObject({
      checks: { status: "queued", position: 2, queuedAt: "2026-01-01T00:03:00.000Z" },
    })
    const admitted = (await app.queue.admit({}))[0]
    expect(admitted).toBe(requestedFirst.id)
  })

  it("naturally misses the journal cache when the installed-step identity changes", async () => {
    const journal = createMemoryJournal()
    const first = await createQueueApp({}, journal)
    const pr = await submitBranch(first, "issue/cache-identity")
    const admitted = (await first.queue.admit({ prs: [pr.id] }))[0]
    if (admitted === undefined) throw new Error("expected an admitted PR id")
    await first.queue.admit({ prs: [pr.id] }, runtime)
    await first.close()

    let changedChecks = 0
    await using changed = await createQueueApp(
      {
        checkRevision: "check-v2",
        check: () => {
          changedChecks++
          return { status: "completed", conclusion: "success", output: { checked: true } }
        },
      },
      journal,
      () => "2026-01-01T00:00:00.000Z",
      ids(100),
    )
    const readmission = (await changed.queue.admit({ prs: [pr.id] }))[0]
    if (readmission === undefined) throw new Error("expected a cache-miss admitted PR id")
    expect(readmission).toBe(pr.id)
    expect(revisionAdmissionJob(changed.jobs, pr, BASE, 0, "check-v2")).toMatchObject({
      status: "queued",
      revision: "check-v2",
    })
    await changed.queue.admit({ prs: [pr.id] }, runtime)

    const integrated = (await changed.queue.run({ prs: [], derived: [pr] }, runtime))[0]
    expect(integrated).toMatchObject({
      status: "completed",
      conclusion: "success",
      steps: [{ name: "merge" }, { name: "deploy" }],
    })
    expect(changedChecks).toBe(1)
  })

  it("releases an environment-refused run and re-admits its unchanged revision after replay", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    let mergeCalls = 0
    const options = {
      merge: () => {
        mergeCalls++
        return mergeCalls === 1
          ? {
              status: "completed" as const,
              conclusion: "failure" as const,
              error: {
                code: "queue-environment-refused",
                message: "merge environment is temporarily unavailable",
              },
            }
          : { status: "completed" as const, conclusion: "success" as const, output: { commit: MERGED, baseSha: BASE } }
      },
    }

    {
      await using app = await createQueueApp(options, journal, undefined, id)
      const pr = await submitBranch(app, "issue/environment-refused")

      expect(await app.queue.run({ prs: [], derived: [pr], steps: ["merge"] }, runtime)).toMatchObject([
        {
          id: "R1",
          status: "completed",
          conclusion: "failure",
          error: { code: "queue-environment-refused" },
          prs: [{ id: pr.id, revision: pr.revision, headSha: pr.headSha }],
        },
      ])
      // Blameless refusal: nothing integrated, and the branch's submit fact —
      // the whole of its delivery — still stands at the run's pinned sha, so
      // the released authority returns to it.
      expect(await terminalFor(app, pr.id)).toBeUndefined()
      expect(standingSubmit(app, pr.branch)).toMatchObject({ sha: pr.headSha })

      const events = await Array.fromAsync(app.events())
      const failed = events.find(
        (applied) => applied.name === "queue/run/failed" && (applied.data as Readonly<{ run?: unknown }>).run === "R1",
      )
      if (failed === undefined) throw new Error("expected the environment refusal to append queue/run/failed")
      const authority = Queues.authorityRun(app.state().queues.authority, "R1")
      expect(authority?.released).toEqual({ reason: "queue-environment-refused", ref: failed.id })
      expect(events.map(({ name }) => name)).not.toContain("pr/rejected")
    }

    await using replayed = await createQueueApp(options, journal, undefined, id)
    const replayedEvents = await Array.fromAsync(replayed.events())
    const replayedFailure = replayedEvents.find(
      (applied) => applied.name === "queue/run/failed" && (applied.data as Readonly<{ run?: unknown }>).run === "R1",
    )
    if (replayedFailure === undefined) throw new Error("expected replay to retain queue/run/failed")
    const replayedAuthority = Queues.authorityRun(replayed.state().queues.authority, "R1")
    expect(replayedAuthority?.released).toEqual({
      reason: "queue-environment-refused",
      ref: replayedFailure.id,
    })

    const retry = memberOf(replayed, "issue/environment-refused")
    expect(retry).toMatchObject({ id: "PR1", headSha: HEAD })
    const retried = await replayed.queue.run({ prs: [], derived: [retry], steps: ["merge"] }, runtime)
    expect(retried.map(({ id: run }) => run)).toEqual(["R2"])
    expect(retried).toMatchObject([
      {
        id: "R2",
        status: "completed",
        conclusion: "success",
        prs: [{ id: "PR1", revision: retry.revision, headSha: HEAD }],
      },
    ])
    expect(await terminalFor(replayed, "PR1")).toMatchObject({ run: "R2", headSha: HEAD, commit: MERGED })
    expect(Queues.ids(replayed.state().queues)).toEqual(["R1", "R2"])
    expect(mergeCalls).toBe(2)
  })

  it("keeps a failed Candidate consumed until a new revision supplies submit authority", async () => {
    let mergeCalls = 0
    await using app = await createQueueApp({
      merge: () => {
        mergeCalls++
        return mergeCalls === 1
          ? {
              status: "completed",
              conclusion: "failure",
              error: { code: "merge-conflict", message: "payload does not merge" },
            }
          : { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
      },
    })
    const pr = await submitBranch(app, "issue/merit-rejection")

    expect(await app.queue.run({ prs: [], derived: [pr], steps: ["merge"] }, runtime)).toMatchObject([
      { id: "R1", status: "completed", conclusion: "failure", error: { code: "merge-conflict" } },
    ])
    expect(await terminalFor(app, pr.id)).toBeUndefined()
    expect(standingSubmit(app, pr.branch)).toMatchObject({ sha: pr.headSha })
    expect(Queues.authorityRun(app.state().queues.authority, "R1")).not.toHaveProperty("released")
    expect((await Array.fromAsync(app.events())).map(({ name }) => name)).not.toContain("pr/rejected")

    const beforeRetry = await Array.fromAsync(app.events())
    await expect(app.queue.run({ prs: [], derived: [pr], steps: ["merge"] }, runtime)).rejects.toThrow(
      /submit authority was consumed/iu,
    )
    const afterRetry = await Array.fromAsync(app.events())
    expect(afterRetry.slice(beforeRetry.length)).toMatchObject([
      {
        name: "pr/needs-author",
        data: {
          pr: pr.id,
          revision: pr.revision,
          headSha: pr.headSha,
          run: "R1",
          receipt: {
            code: "queue-submit-authority-consumed",
            message: expect.stringContaining("tracked changes re-merge implicitly"),
          },
        },
      },
    ])
    // "needs-author" is the run-side fact now: the consumed-authority receipt
    // above is the whole durable trace a recordless member gets.
    expect(Queues.ids(app.state().queues)).toEqual(["R1"])
    expect(mergeCalls).toBe(1)

    // The new revision that supplies fresh submit authority is a RE-PUSH: the
    // fact moves, and re-deriving continues the branch's revision count.
    await app.bays.recordBranchSubmit({ branch: pr.branch, sha: UPDATED, base: "main" })
    const revision2 = memberOf(app, pr.branch)
    expect(revision2).toMatchObject({ id: pr.id, revision: 2, headSha: UPDATED })

    const revised = await app.queue.run({ prs: [], derived: [revision2], steps: ["merge"] }, runtime)
    const newRuns = revised.filter(({ id: run }) => run === "R2")
    expect(newRuns).toHaveLength(1)
    expect(newRuns).toMatchObject([
      { id: "R2", status: "completed", conclusion: "success", prs: [{ id: pr.id, revision: 2, headSha: UPDATED }] },
    ])
    expect(Queues.ids(app.state().queues)).toEqual(["R1", "R2"])
    expect(await terminalFor(app, pr.id)).toMatchObject({ run: "R2", revision: 2, headSha: UPDATED })
    expect(mergeCalls).toBe(2)
  })

  it("re-queues a base-raced (stale-base) run instead of rejecting its submitted PR", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    let mergeCalls = 0
    const options = {
      merge: () => {
        mergeCalls++
        return mergeCalls === 1
          ? {
              status: "completed" as const,
              conclusion: "failure" as const,
              error: { code: "stale-base", message: "base branch moved after the checked candidate" },
            }
          : {
              status: "completed" as const,
              conclusion: "success" as const,
              output: { commit: MERGED, baseSha: BASE },
            }
      },
    }

    await using app = await createQueueApp(options, journal, undefined, id)
    const pr = await submitBranch(app, "issue/base-raced")

    expect(await app.queue.run({ prs: [], derived: [pr], steps: ["merge"] }, runtime)).toMatchObject([
      {
        id: "R1",
        status: "completed",
        conclusion: "failure",
        error: { code: "stale-base" },
        prs: [{ id: pr.id, revision: pr.revision, headSha: pr.headSha }],
      },
    ])
    // A base race is environmental, not a change-content fault: the change must stay
    // submitted (re-admissible), NOT be terminally rejected like merge-conflict.
    // A blameless release leaves the delivery intact: no terminal for the member
    // and its standing submit fact untouched at the pinned sha — post-S7 that
    // pair IS `delivery === "submitted"`, and it is what makes the unchanged
    // revision re-admissible.
    expect(await terminalFor(app, pr.id)).toBeUndefined()
    expect(standingSubmit(app, pr.branch)).toMatchObject({ sha: pr.headSha })

    const events = await Array.fromAsync(app.events())
    const failed = events.find(
      (applied) => applied.name === "queue/run/failed" && (applied.data as Readonly<{ run?: unknown }>).run === "R1",
    )
    if (failed === undefined) throw new Error("expected the base race to append queue/run/failed")
    const authority = Queues.authorityRun(app.state().queues.authority, "R1")
    expect(authority?.released).toEqual({ reason: "stale-base", ref: failed.id })
    expect(events.map(({ name }) => name)).not.toContain("pr/rejected")

    // The unchanged revision re-admits and merges once the base settles.
    const retried = await app.queue.run({ prs: [], derived: [pr], steps: ["merge"] }, runtime)
    expect(retried.map(({ id: run }) => run)).toEqual(["R2"])
    expect(retried).toMatchObject([
      {
        id: "R2",
        status: "completed",
        conclusion: "success",
        prs: [{ id: pr.id, revision: 1, headSha: pr.headSha }],
      },
    ])
    expect(await terminalFor(app, pr.id)).toMatchObject({ run: "R2", revision: 1, commit: MERGED })
    expect(Queues.ids(app.state().queues)).toEqual(["R1", "R2"])
    expect(mergeCalls).toBe(2)
  })

  it("re-queues a stale-check run instead of rejecting its submitted PR", async () => {
    const journal = createMemoryJournal()
    const id = ids()
    let mergeCalls = 0
    const options = {
      merge: () => {
        mergeCalls++
        return mergeCalls === 1
          ? {
              status: "completed" as const,
              conclusion: "failure" as const,
              error: { code: "stale-check", message: "checked candidate ref moved" },
            }
          : {
              status: "completed" as const,
              conclusion: "success" as const,
              output: { commit: MERGED, baseSha: BASE },
            }
      },
    }

    await using app = await createQueueApp(options, journal, undefined, id)
    const pr = await submitBranch(app, "issue/stale-check-raced")

    expect(await app.queue.run({ prs: [], derived: [pr], steps: ["merge"] }, runtime)).toMatchObject([
      {
        id: "R1",
        status: "completed",
        conclusion: "failure",
        error: { code: "stale-check" },
        prs: [{ id: pr.id, revision: pr.revision }],
      },
    ])
    // A blameless release leaves the delivery intact: no terminal for the member
    // and its standing submit fact untouched at the pinned sha — post-S7 that
    // pair IS `delivery === "submitted"`, and it is what makes the unchanged
    // revision re-admissible.
    expect(await terminalFor(app, pr.id)).toBeUndefined()
    expect(standingSubmit(app, pr.branch)).toMatchObject({ sha: pr.headSha })

    const events = await Array.fromAsync(app.events())
    const failed = events.find(
      (applied) => applied.name === "queue/run/failed" && (applied.data as Readonly<{ run?: unknown }>).run === "R1",
    )
    if (failed === undefined) throw new Error("expected the stale check to append queue/run/failed")
    const authority = Queues.authorityRun(app.state().queues.authority, "R1")
    expect(authority?.released).toEqual({ reason: "stale-check", ref: failed.id })
    expect(events.map(({ name }) => name)).not.toContain("pr/rejected")

    const retried = await app.queue.run({ prs: [], derived: [pr], steps: ["merge"] }, runtime)
    expect(retried.map(({ id: run }) => run)).toEqual(["R2"])
    expect(retried).toMatchObject([
      { id: "R2", status: "completed", conclusion: "success", prs: [{ id: pr.id, revision: 1 }] },
    ])
    expect(await terminalFor(app, pr.id)).toMatchObject({ run: "R2", revision: 1, commit: MERGED })
    expect(mergeCalls).toBe(2)
  })

  it("does not bisect a base-raced batch and re-queues every member instead of rejecting", async () => {
    let mergeCalls = 0
    await using app = await createQueueApp({
      batch: 2,
      merge: () => {
        mergeCalls++
        return {
          status: "completed",
          conclusion: "failure",
          error: { code: "stale-base", message: "base branch moved under the batch" },
        }
      },
    })
    const first = await submitBranch(app, "issue/batch-race-a")
    const second = await submitBranch(app, "issue/batch-race-b")

    const runs = await app.queue.run({ prs: [], derived: [first, second], steps: ["merge"] }, runtime)

    // bisectable(): a release-reason failure is NOT bisected — the whole batch
    // re-queues rather than isolating members to find a non-existent "bad" PR.
    expect(runs.map((run) => [run.prs.map((pr) => pr.id), run.status, run.conclusion])).toEqual([
      [["PR1", "PR2"], "completed", "failure"],
    ])
    expect(Queues.ids(app.state().queues)).toEqual(["R1"])
    expect(mergeCalls).toBe(1)

    // needsAdvance(): the batch advances to release authority for every member.
    expect(await terminalFor(app, first.id)).toBeUndefined()
    expect(await terminalFor(app, second.id)).toBeUndefined()
    expect(standingSubmit(app, first.branch)).toMatchObject({ sha: first.headSha })
    expect(standingSubmit(app, second.branch)).toMatchObject({ sha: second.headSha })
    const events = await Array.fromAsync(app.events())
    const failed = events.find(
      (applied) => applied.name === "queue/run/failed" && (applied.data as Readonly<{ run?: unknown }>).run === "R1",
    )
    if (failed === undefined) throw new Error("expected the batch race to append queue/run/failed")
    expect(Queues.authorityRun(app.state().queues.authority, "R1")?.released).toEqual({
      reason: "stale-base",
      ref: failed.id,
    })
    expect(events.map(({ name }) => name)).not.toContain("pr/rejected")
    expect(events.map(({ name }) => name)).not.toContain("queue/batch/isolated")
  })

  it("re-admits a base race against an advancing base and merges once it settles", async () => {
    // A finite base race: the base advances under a finite competitor queue, so
    // merge is stale for the first attempts and merges once the base stabilizes.
    let merges = 0
    const settleOnAttempt = 3
    await using app = await createQueueApp({
      merge: () => {
        merges++
        return merges < settleOnAttempt
          ? {
              status: "completed",
              conclusion: "failure",
              error: { code: "stale-base", message: `base moved (attempt ${merges})` },
            }
          : { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
      },
    })
    const pr = await submitBranch(app, "issue/advancing-base")

    let ticks = 0
    while ((await terminalFor(app, pr.id)) === undefined && ticks < 10) {
      ticks++
      await app.queue.run({ prs: [], derived: [pr], steps: ["merge"] }, runtime)
    }

    expect(await terminalFor(app, pr.id)).toMatchObject({ commit: MERGED })
    expect(merges).toBe(settleOnAttempt)
    expect(ticks).toBe(settleOnAttempt)
    expect((await Array.fromAsync(app.events())).map(({ name }) => name)).not.toContain("pr/rejected")
  })

  it("keeps re-queuing a permanently racing base instead of terminally rejecting it", async () => {
    // A base that never settles must never terminally reject a mergeable PR. The
    // merge-path re-queue count exceeds AUTOMATIC_ADMISSION_RETRIES (1): that
    // admission-retry bound governs the CHECK path (see "bounds environment-refused
    // admission retries"), NOT the merge-side base race, which is bounded instead
    // by the base eventually settling.
    let merges = 0
    await using app = await createQueueApp({
      merge: () => {
        merges++
        return {
          status: "completed",
          conclusion: "failure",
          error: { code: "stale-base", message: "base never settles" },
        }
      },
    })
    const pr = await submitBranch(app, "issue/permanent-race")

    const TICKS = 5
    for (let tick = 0; tick < TICKS; tick++) {
      if ((await terminalFor(app, pr.id)) !== undefined) break
      await app.queue.run({ prs: [], derived: [pr], steps: ["merge"] }, runtime)
    }

    expect(merges).toBe(TICKS)
    // Never terminally rejected: no terminal, and the submission still stands
    // so the next tick re-admits it.
    expect(await terminalFor(app, pr.id)).toBeUndefined()
    expect(standingSubmit(app, pr.branch)).toMatchObject({ sha: pr.headSha })
    expect((await Array.fromAsync(app.events())).map(({ name }) => name)).not.toContain("pr/rejected")
  })

  it("audits a rejected revision retry without fresh submit ancestry and keeps authorized controls clean", async () => {
    const journal = createMemoryJournal<unknown>()
    const original = await createQueueApp(
      {
        check: () => ({
          status: "completed",
          conclusion: "failure",
          error: { code: "check-failed", message: "reject R1" },
        }),
      },
      journal,
    )
    const retried = await submitBranch(original, "issue/retry-without-submit")
    const first = (await original.queue.run({ prs: [], derived: [retried] }, runtime))[0]
    if (first === undefined) throw new Error("expected authorized R1")
    expect(first).toMatchObject({ id: "R1", status: "completed", conclusion: "failure" })
    expect(await terminalFor(original, retried.id)).toBeUndefined()
    expect(standingSubmit(original, retried.branch)).toMatchObject({ sha: retried.headSha })
    const firstRecord = Queues.get(original.state().queues, "R1")
    if (firstRecord === undefined) throw new Error("expected persisted R1")
    const uncorrelatedSnapshot = firstRecord.prs[0]
    if (uncorrelatedSnapshot === undefined) throw new Error("expected persisted uncorrelated PR snapshot")
    expect(uncorrelatedSnapshot).not.toHaveProperty("correlation")
    await original.close()

    let cursor = 0
    for await (const batch of journal.read()) cursor = batch.cursor
    const command = { id: "00000000-0000-7000-9000-000000009201", op: "fixture.r92-retry" }
    expect(
      await journal.append(
        {
          command,
          cause: {
            id: "00000000-0000-7000-9000-000000009202",
            commandId: command.id,
            op: command.op,
            commandHash: Command.hash(command),
          },
          events: [
            {
              id: "00000000-0000-7000-9000-000000009203",
              name: "queue/run/started",
              ts: "2026-01-01T00:01:00.000Z",
              data: {
                run: {
                  id: "R2",
                  prs: firstRecord.prs,
                  base: firstRecord.base,
                  steps: firstRecord.steps,
                },
              },
            },
            {
              id: "00000000-0000-7000-9000-000000009204",
              name: "queue/run/failed",
              ts: "2026-01-01T00:01:00.001Z",
              data: {
                run: "R2",
                error: { code: "legacy-retry-terminal", message: "R2 ended without a fresh submit" },
              },
            },
          ],
        },
        cursor,
      ),
    ).toMatchObject({ appended: true })

    await using app = await createQueueApp({}, journal, undefined, ids(500))
    const legacyRetry = app.queue.get("R2")
    expect(legacyRetry).toMatchObject({ status: "completed", conclusion: "failure", prs: [{ id: retried.id }] })
    const legacySnapshot = legacyRetry?.prs[0]
    if (legacySnapshot === undefined) throw new Error("expected replayed legacy PR snapshot")
    expect(legacySnapshot).not.toHaveProperty("correlation")

    const submitted = await submitBranch(app, "issue/submitted-control")
    const submittedRun = (await app.queue.run({ prs: [], derived: [submitted] }, runtime))[0]
    if (submittedRun === undefined) throw new Error("expected submitted control run")

    // The second control — a `pushed` DRAFT whose admission the audit must also
    // leave alone — is gone with the record lane: a submit fact is the whole
    // delivery, so no member can be pushed-but-not-submitted and no draft flag
    // exists to set. The submitted control above is the surviving one.
    expect(app.queue.audit().findings).toEqual([
      expect.objectContaining({ code: "run-without-submit-ancestry", run: "R2", pr: retried.id }),
    ])
  })

  it("schema-refuses queue.run retry authority without appending events", async () => {
    await using app = await createQueueApp()
    const pr = await submitBranch(app, "issue/retry-schema")
    const before = await Array.fromAsync(app.events())
    const untrusted = { prs: [pr.id], retry: true }

    await expect(app.dispatch(app.commands.queue.run, untrusted)).rejects.toThrow(/retry/iu)

    expect(await Array.fromAsync(app.events())).toEqual(before)
  })

  it.each(["pr/withdrawn", "pr/canceled"] as const)(
    "refuses stale revision-one %s before projecting a terminal result",
    async (terminal) => {
      const journal = createMemoryJournal<unknown>()
      const original = await createQueueApp({}, journal)
      const stale = await submitBranch(original, `issue/stale-${terminal}`)
      await original.close()

      let cursor = 0
      for await (const batch of journal.read()) cursor = batch.cursor
      const command = { id: "00000000-0000-7000-9000-000000009211", op: "fixture.stale-terminal" }
      expect(
        await journal.append(
          {
            command,
            cause: {
              id: "00000000-0000-7000-9000-000000009212",
              commandId: command.id,
              op: command.op,
              commandHash: Command.hash(command),
            },
            events: [
              // The queue's authority slice — NOT a record — is what the stale
              // guard compares against, and post-S7 only history writes it: no
              // live verb emits `pr/pushed` any more. Planting revision 2 here
              // is exactly the state `bays.intake` + `bays.submit` used to leave.
              {
                id: "00000000-0000-7000-9000-000000009214",
                name: "pr/pushed",
                ts: "2026-01-01T00:00:30.000Z",
                data: {
                  pr: stale.id,
                  branch: stale.branch,
                  base: "main",
                  headSha: UPDATED,
                  baseSha: BASE,
                  revision: 2,
                  changeId: stale.changeId,
                  submitter: "operator",
                },
              },
              {
                id: "00000000-0000-7000-9000-000000009213",
                name: terminal,
                ts: "2026-01-01T00:01:00.000Z",
                data: {
                  pr: stale.id,
                  revision: stale.revision,
                  headSha: stale.headSha,
                  ...(terminal === "pr/canceled" ? { by: "@chief", reason: "stale cancellation" } : {}),
                },
              },
            ],
          },
          cursor,
        ),
      ).toMatchObject({ appended: true })

      await expect(createQueueApp({}, journal, undefined, ids(500))).rejects.toThrow(
        new RegExp(`stale terminal '${terminal}'.*${stale.id}`, "iu"),
      )
    },
  )

  it("spends each exact check request once on a pre-Job admission refusal", async () => {
    let prepares = 0
    await using app = await createQueueApp({
      prepareCandidate: () => {
        prepares += 1
        throw createFailure({
          kind: "refusal",
          code: "authored-gitlink",
          message: "recut the carrier before required checks",
        })
      },
    })
    const pr = await submitBranch(app, "issue/candidate-refusal-authority")

    expect(await app.queue.run({ derived: [pr] }, runtime)).toEqual([])
    expect(prepares).toBe(1)
    expect(await app.queue.run({ derived: [pr] }, runtime)).toEqual([])
    expect(prepares).toBe(2)

    expect(await app.queue.run({ derived: [pr] }, runtime)).toEqual([])
    expect(prepares).toBe(2)
  })

  it("indexes a released canceled admission exactly like the former terminal scan", async () => {
    const history = queueHistoryFrames(1)[0]
    if (history === undefined) throw new Error("expected historical Queue fixture")
    const admission = legacyAdmissionRunFrame(history)
    const queued = parseJournalFrame({
      ...admission,
      events: admission.events.filter(({ name }) => name !== "job/transitioned"),
    })
    await using app = await createQueueApp(
      { defaultSteps: ["check"] },
      indexedJournal([queued]),
      undefined,
      ids(1_000_000),
    )
    const admitted = app.queue.get("R1")
    if (admitted?.prs[0] === undefined) throw new Error("expected admission run")
    expect(releasedAdmissionFailures(app.state().queues.index, admitted.prs[0], admitted.steps)).toBe(0)

    await app.queue.cancelRun({ run: admitted.id, by: "operator", reason: "replace runner" })

    expect(releasedAdmissionFailures(app.state().queues.index, admitted.prs[0], admitted.steps)).toBe(1)
    expect(Queues.authorityRun(app.state().queues.authority, admitted.id)?.released).toMatchObject({
      reason: "run-canceled",
    })
  })

  /**
   * QUEUE PAUSE — DELIBERATE REDS (S7). Two independent src changes, both
   * observed, neither a fixture problem:
   *
   * 1. A pause allow-list can only name a member that has ALREADY run.
   *    `queue.pause` resolves each `allowedPRs` selector through
   *    `resolveMemberById(snapshot.queues, ...)`, which reads RETAINED RUN
   *    SNAPSHOTS ("a pause allow-list member is named by its retained run
   *    snapshot"). A branch that has never been composed resolves to nothing,
   *    so `pause({ allowedPRs: [branch] })` refuses `pr-not-found` — and
   *    pausing BEFORE anything has run is exactly when an operator freezes a
   *    queue. Same seam as the known `pauseMemberStatus` defect.
   *
   * 2. A paused queue no longer REFUSES; it returns no runs. The pause is now
   *    an eligibility verdict (`code: "queue-paused"`, message
   *    "...; change 'PRn' is not in the allowed set") rather than a thrown
   *    refusal, so `queue.run` resolves `[]` where these tests expect a
   *    rejection. Checked that this is not the selectorless refusal-swallow:
   *    naming the member explicitly (`prs: [id]` beside its `derived` entry,
   *    the mode whose refusals DO propagate) still returns `[]`.
   *
   * Whether (2) is an intended contract change or a lost fail-loud guarantee
   * needs a src owner's ruling — the operator-facing effect is that
   * `yrd queue run` on a paused queue returns nothing instead of saying
   * "paused", with the reason surviving only in the `no-runnable-prs` warn.
   */
  it("persists a queue pause and refuses unlisted PRs before creating a run", async () => {
    const journal = createMemoryJournal()
    const first = await createQueueApp({}, journal)
    const allowed = await submitBranch(first, "issue/allowed")
    const blocked = await submitBranch(first, "issue/blocked")

    await first.queue.pause({
      base: "main",
      reason: "operator freeze",
      allowedPRs: [allowed.id],
      expiresAt: "2026-01-01T01:00:00.000Z",
    })

    expect(first.queue.status("main").pause).toMatchObject({
      base: "main",
      reason: "operator freeze",
      allowedPRs: [allowed.id],
    })
    await expect(first.queue.run({ prs: [], derived: [blocked] }, runtime)).rejects.toThrow(
      `queue 'main' is paused: operator freeze`,
    )
    await expect(first.dispatch(first.commands.queue.run, { prs: [], derived: [blocked], baseSha: BASE })).rejects.toThrow(
      `queue 'main' is paused: operator freeze`,
    )
    expect(Queues.ids(first.state().queues)).toEqual([])
    await expect(first.queue.run({ prs: [], derived: [allowed] }, runtime)).resolves.toHaveLength(1)
    await first.queue.resume("main")
    await expect(first.queue.run({ prs: [], derived: [blocked] }, runtime)).resolves.toHaveLength(1)
    expect(first.queue.status("main").pause).toBeUndefined()
    await first.queue.pause({
      base: "main",
      reason: "operator freeze",
      allowedPRs: [allowed.id],
      expiresAt: "2026-01-01T01:00:00.000Z",
    })
    await first.close()

    await using replay = await createQueueApp({}, journal)
    expect(replay.queue.status("main").pause).toMatchObject({ allowedPRs: [allowed.id] })
  })

  it("expires a TTL'd queue pause without stopping the habitant that clears it", async () => {
    const journal = createMemoryJournal()
    let now = "2026-01-01T00:00:00.000Z"
    const app = await createQueueApp({}, journal, () => now)
    const blocked = await submitBranch(app, "issue/ttl-hold")

    await app.queue.pause({
      base: "main",
      reason: "operator freeze",
      allowedPRs: [],
      expiresAt: "2026-01-01T00:05:00.000Z",
    })

    expect(app.queue.status("main").pause).toMatchObject({
      base: "main",
      pausedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:05:00.000Z",
    })
    now = "2026-01-01T00:04:59.999Z"
    await expect(app.queue.expirePauses(now)).resolves.toEqual([])
    expect(app.queue.audit({ now }).findings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "queue-hold-expired" })]),
    )
    await expect(app.queue.run({ prs: [], derived: [blocked] }, runtime)).rejects.toThrow(
      `queue 'main' is paused: operator freeze`,
    )

    now = "2026-01-01T00:05:00.000Z"
    expect(app.queue.audit({ now }).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "queue-hold-expired", specimen: "queue:main" })]),
    )
    await expect(app.queue.expirePauses(now)).resolves.toMatchObject([{ base: "main" }])
    expect(app.queue.status("main").pause).toBeUndefined()
    await expect(app.queue.run({ prs: [], derived: [blocked] }, runtime)).resolves.toHaveLength(1)
    await app.close()

    await using replay = await createQueueApp({}, journal)
    expect(replay.queue.status("main").pause).toBeUndefined()
  })

  it("does not bypass a canonical pause through a base alias", async () => {
    await using app = await createQueueApp()
    const pr = await submitBranch(app, "issue/alias-paused", "origin/main")
    await app.queue.pause({
      base: "main",
      reason: "operator freeze",
      allowedPRs: [],
      expiresAt: "2026-01-01T01:00:00.000Z",
    })

    await expect(app.queue.run({ prs: [], derived: [pr] }, runtime)).rejects.toThrow(`queue 'main' is paused: operator freeze`)
    await expect(app.dispatch(app.commands.queue.run, { prs: [], derived: [pr], baseSha: BASE })).rejects.toThrow(
      `queue 'main' is paused: operator freeze`,
    )
    expect(Queues.ids(app.state().queues)).toEqual([])
  })

  it("names every rejected PR when selectorless selection emits no run events", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await createQueueApp({}, createMemoryJournal(), undefined, ids(), log)
    const first = await submitBranch(app, "issue/paused-selectorless-first")
    const second = await submitBranch(app, "issue/paused-selectorless-second")
    await app.queue.pause({
      base: "main",
      reason: "operator freeze",
      allowedPRs: [],
      expiresAt: "2026-01-01T01:00:00.000Z",
    })

    const direct = await app.dispatch(app.commands.queue.run, { derived: [first, second], baseSha: BASE })
    expect(direct.events).toEqual([])
    expect(direct.value).toEqual({
      kind: "no-runnable-prs",
      considered: [
        {
          code: "queue-paused",
          pr: first.id,
          reason: "queue 'main' is paused: operator freeze; change 'PR1' is not in the allowed set",
          revision: 1,
        },
        {
          code: "queue-paused",
          pr: second.id,
          reason: "queue 'main' is paused: operator freeze; change 'PR2' is not in the allowed set",
          revision: 1,
        },
      ],
      reason: "every considered PR was ineligible for the selected plan",
      selectedSteps: ["check", "review", "merge", "deploy"],
    })

    await expect(app.queue.run({ derived: [first, second] }, runtime)).resolves.toEqual([])

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "log",
        level: "warn",
        message: "queue run emitted zero events because every considered PR was ineligible",
        props: expect.objectContaining({
          action: "queue-run-no-runnable-prs",
          considered: [
            {
              code: "queue-paused",
              pr: first.id,
              reason: "queue 'main' is paused: operator freeze; change 'PR1' is not in the allowed set",
              revision: 1,
            },
            {
              code: "queue-paused",
              pr: second.id,
              reason: "queue 'main' is paused: operator freeze; change 'PR2' is not in the allowed set",
              revision: 1,
            },
          ],
          reason: "every considered PR was ineligible for the selected plan",
          selectedSteps: ["check", "review", "merge", "deploy"],
        }),
      }),
    )
    log.end()
  })

  it("treats base aliases as one active queue before a second run starts", async () => {
    const firstEntered = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<void>()
    let checkCalls = 0
    await using app = await createQueueApp({
      batch: 1,
      check: async (input) => {
        checkCalls++
        if (input.prs[0]?.branch === "issue/active-main") {
          firstEntered.resolve()
          await releaseFirst.promise
        }
        return { status: "waiting", token: `remote-${input.prs[0]?.id}` }
      },
    })
    const main = await submitBranch(app, "issue/active-main", "main")
    const alias = await submitBranch(app, "issue/active-alias", "origin/main")

    const firstRun = app.queue.run({ prs: [], derived: [main] }, runtime)
    await firstEntered.promise
    let secondError: unknown
    try {
      await app.queue.run({ prs: [], derived: [alias] }, runtime)
    } catch (error) {
      secondError = error
    } finally {
      releaseFirst.resolve()
      await firstRun
    }

    expect(secondError).toMatchObject({ message: "yrd: queue 'main' is running 'R1'" })
    expect(checkCalls).toBe(1)
  })

  it("canonically replays historical base aliases before pause lookup", async () => {
    const command = { id: "00000000-0000-7000-8000-000000000201", op: "legacy.queue.fixture" }
    const journal = createMemoryJournal<unknown>([
      {
        command,
        cause: {
          id: "00000000-0000-7000-8000-000000000202",
          commandId: command.id,
          op: command.op,
          commandHash: Command.hash(command),
        },
        events: [
          {
            id: "00000000-0000-7000-8000-000000000203",
            name: "pr/pushed",
            ts: "2026-01-01T00:00:00.000Z",
            data: { pr: "PR1", branch: "issue/legacy-main", base: "main", headSha: HEAD, revision: 1 },
          },
          {
            id: "00000000-0000-7000-8000-000000000204",
            name: "pr/submitted",
            ts: "2026-01-01T00:00:00.001Z",
            data: { pr: "PR1", revision: 1, headSha: HEAD },
          },
          {
            id: "00000000-0000-7000-8000-000000000205",
            name: "pr/pushed",
            ts: "2026-01-01T00:00:00.002Z",
            data: { pr: "PR2", branch: "issue/legacy-alias", base: "origin/main", headSha: UPDATED, revision: 1 },
          },
          {
            id: "00000000-0000-7000-8000-000000000206",
            name: "pr/submitted",
            ts: "2026-01-01T00:00:00.003Z",
            data: { pr: "PR2", revision: 1, headSha: UPDATED },
          },
          {
            id: "00000000-0000-7000-8000-000000000207",
            name: "queue/paused",
            ts: "2026-01-01T00:00:00.004Z",
            data: {
              base: "origin/main",
              reason: "legacy freeze",
              allowedPRs: ["PR1", "PR2"],
            },
          },
        ],
      },
    ])
    await using app = await createQueueApp({ batch: 2 }, journal)

    // The two record-side legs are gone with the store: the historical
    // `pr/pushed`/`pr/submitted` frames still PARSE but project nothing, so
    // neither their canonicalized `base` nor a run partitioned out of them can
    // be observed. What replay still owes is the QUEUE slice's own alias
    // canonicalization, and that is what the rest of this test reads.
    expect(Object.keys(app.state().queues.pauses)).toEqual(["main"])
    expect(app.queue.status("origin/main")).toMatchObject({
      base: "main",
      pause: { base: "main", allowedPRs: ["PR1", "PR2"] },
    })
    expect(app.queue.audit({ now: "2026-01-01T00:01:00.000Z" }).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "queue-hold-ttl-missing", specimen: "queue:main" })]),
    )
  })

  it("selects the first queue-ordered eligible submitted PR under a pause", async () => {
    let tick = 0
    await using app = await createQueueApp({ batch: 23 }, createMemoryJournal(), () =>
      new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick++)).toISOString(),
    )
    const prs = []
    for (let index = 1; index <= 23; index++) {
      const branch = `issue/pr-${index}`
      await app.bays.recordBranchSubmit({ branch, sha: index.toString(16).padStart(40, "0"), base: "main" })
      prs.push(memberOf(app, branch))
    }
    const oldExcluded = prs[10]
    const allowed = prs[22]
    if (oldExcluded === undefined || allowed === undefined) throw new Error("PR fixture is incomplete")
    expect([oldExcluded.id, allowed.id]).toEqual(["PR11", "PR23"])

    await app.queue.run(
      {
        prs: [],
        derived: prs.filter((pr) => pr.id !== oldExcluded.id && pr.id !== allowed.id),
        steps: ["check", "review", "merge"],
      },
      runtime,
    )
    expect(await terminalFor(app, "PR11")).toBeUndefined()
    expect(await terminalFor(app, "PR23")).toBeUndefined()
    await app.queue.pause({
      base: "main",
      reason: "operator freeze",
      allowedPRs: ["PR23"],
      expiresAt: "2026-01-01T01:00:00.000Z",
    })

    const runs = await app.queue.run({ derived: [oldExcluded, allowed] }, runtime)

    expect(runs.map((run) => run.prs.map((pr) => pr.id))).toEqual([["PR23"]])
    expect(await terminalFor(app, "PR11")).toBeUndefined()
    expect(standingSubmit(app, oldExcluded.branch)).toMatchObject({ sha: oldExcluded.headSha })
    expect(await terminalFor(app, "PR23")).toMatchObject({ commit: MERGED })
  })

  it("keeps completed history readable and refuses queued work after revision drift", async () => {
    const journal = createMemoryJournal()
    const first = await createQueueApp({}, journal)
    await first.bays.recordBranchSubmit({ branch: "issue/completed", sha: HEAD, base: "main" })
    const completedMember = memberOf(first, "issue/completed")
    const completed = await first.queue.run({ prs: [], derived: [completedMember], steps: ["check"] }, runtime)
    await first.bays.recordBranchSubmit({ branch: "issue/queued", sha: UPDATED, base: "main" })
    const queuedMember = memberOf(first, "issue/queued")
    const queued = await first.dispatch(first.commands.queue.run, {
      prs: [],
      derived: [queuedMember],
      steps: ["check"],
      baseSha: BASE,
    })
    const queuedJob = first.jobs.requested(queued)[0]
    if (queuedJob === undefined) throw new Error("queue did not request a Job")
    await first.close()

    let changedExecutions = 0
    const changed = await createQueueApp(
      {
        checkRevision: "check-v2",
        check: () => {
          changedExecutions++
          return { status: "completed", conclusion: "success", output: { checked: false } }
        },
      },
      journal,
    )
    expect(changed.queue.get(completed[0]!.id)).toMatchObject({
      status: "completed",
      conclusion: "success",
      shape: { results: { check: { checked: true } } },
    })
    await expect(changed.jobs.run(queuedJob, runtime)).rejects.toThrow("definition revision")
    expect(changedExecutions).toBe(0)
    await changed.close()

    const bayJobs = createBayJobDefs(workspace())
    const withoutSteps = withQueue({ steps: [] as const })
    const historyBase = pipe(
      createYrdDef(),
      withJobs({ definitions: bayJobs }),
      withBays({ jobs: bayJobs }),
    )
    await using history = await createYrd(withoutSteps(historyBase), {
      inject: { journal, log: createLogger("test", [{ level: "silent" }]) },
    })
    expect(history.queue.get(completed[0]!.id)).toMatchObject({ status: "completed", conclusion: "success" })
  })

  it("leaves a pre-merge failure open but preserves integration when deployment fails", async () => {
    let merged = false
    await using rejectedApp = await createQueueApp({
      check: () => ({
        status: "completed",
        conclusion: "failure",
        error: { code: "check-failed", message: "tests failed" },
      }),
      merge: () => {
        merged = true
        return { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
      },
    })
    const rejected = await submitBranch(rejectedApp, "issue/rejected")
    expect((await rejectedApp.queue.run({ prs: [], derived: [rejected] }, runtime))[0]).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "check-failed" },
    })
    expect(merged).toBe(false)
    // "Left open": no terminal, and the submission still stands at the failed
    // revision's sha, so the author can push over it.
    expect(await terminalFor(rejectedApp, rejected.id)).toBeUndefined()
    expect(standingSubmit(rejectedApp, rejected.branch)).toMatchObject({ sha: HEAD })
    await rejectedApp.bays.recordBranchSubmit({ branch: "issue/rejected", sha: UPDATED, base: "main" })
    const revised = memberOf(rejectedApp, "issue/rejected")
    expect(revised).toMatchObject({ id: rejected.id, revision: 2, headSha: UPDATED })
    expect(snapshotOf(rejectedApp, rejected.id)).toMatchObject({ revision: 1, headSha: HEAD })

    let deployAttempts = 0
    await using deployApp = await createQueueApp({
      batch: 2,
      deploy: () => {
        deployAttempts += 1
        return deployAttempts === 1
          ? {
              status: "completed",
              conclusion: "failure",
              error: { code: "deploy-failed", message: "staging unavailable" },
            }
          : { status: "completed", conclusion: "success", output: { environment: "staging" } }
      },
    })
    const deployed = await submitBranch(deployApp, "issue/deploy-fails")
    const companion = await submitBranch(deployApp, "issue/deploy-companion")
    const run = (await deployApp.queue.run({ prs: [], derived: [deployed, companion] }, runtime))[0]
    expect(run).toMatchObject({ status: "completed", conclusion: "failure", error: { code: "deploy-failed" } })
    // The merge already landed, so both members carry their terminal even
    // though the post-merge action failed.
    expect(await terminalFor(deployApp, deployed.id)).toMatchObject({ commit: MERGED })
    expect(await terminalFor(deployApp, companion.id)).toMatchObject({ commit: MERGED })

    const deployJob = run?.steps.find((step) => step.name === "deploy")?.job
    if (deployJob === undefined) throw new Error("expected failed post-merge action Job")
    expect(deployJob).toMatchObject({ status: "completed", conclusion: "failure" })
    await deployApp.jobs.retry(deployJob.id)

    const retried = (await deployApp.queue.run({ prs: [], derived: [deployed, companion] }, runtime))[0]
    expect(retried).toMatchObject({ status: "completed", conclusion: "success" })
    expect(await terminalFor(deployApp, deployed.id)).toMatchObject({ commit: MERGED })
    expect(await terminalFor(deployApp, companion.id)).toMatchObject({ commit: MERGED })
    expect(deployAttempts).toBe(2)
  })

  it("allows unrelated work while waiting and refuses a completed stale revision", async () => {
    let merges = 0
    await using app = await createQueueApp({
      check: (input) =>
        input.prs[0]?.branch === "issue/next"
          ? { status: "completed", conclusion: "success", output: { checked: true } }
          : { status: "waiting", token: `remote-${input.prs[0]?.id}` },
      merge: () => {
        merges++
        return { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
      },
    })
    const remote = await submitBranch(app, "issue/remote")
    const waiting = (await app.queue.run({ prs: [], derived: [remote] }, runtime))[0]!
    const waitingJob = waiting.steps[0]?.job
    if (waitingJob?.status !== "waiting") throw new Error("check did not wait")
    expect(app.queue.waiting(remote.id)).toMatchObject({
      run: { id: waiting.id },
      step: { name: "check", job: { id: waitingJob.id, status: "waiting" } },
    })

    const next = await submitBranch(app, "issue/next")
    expect((await app.queue.run({ prs: [], derived: [next] }, runtime))[0]).toMatchObject({
      status: "completed",
      conclusion: "success",
    })

    // The stale revision post-S7 is a RE-PUSH: the submit fact moves off the
    // sha the waiting run pinned.
    await app.bays.recordBranchSubmit({ branch: remote.branch, sha: UPDATED, base: "main" })
    expect(
      await app.queue.finish(
        remote.id,
        {
          job: waitingJob.id,
          step: "check",
          attempt: waitingJob.attempt,
          runner: waitingJob.runner,
          token: waitingJob.token,
          result: { status: "completed", conclusion: "success", output: { checked: true } },
        },
        runtime,
      ),
    ).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "stale-pr" },
    })
    await expect(
      app.queue.finish(
        remote.id,
        {
          job: waitingJob.id,
          step: "check",
          attempt: waitingJob.attempt,
          runner: waitingJob.runner,
          token: waitingJob.token,
          result: { status: "completed", conclusion: "success", output: { checked: true } },
        },
        runtime,
      ),
    ).rejects.toThrow("no waiting 'check' step")
    expect(merges).toBe(1)
    expect(standingSubmit(app, remote.branch)).toMatchObject({ sha: UPDATED })
    expect(memberOf(app, remote.branch)).toMatchObject({ id: remote.id, revision: 2, headSha: UPDATED })
    expect(await terminalFor(app, remote.id)).toBeUndefined()
  })

  it("refuses a delayed completion from an earlier attempt when a retry reuses its token", async () => {
    let merges = 0
    await using app = await createQueueApp({
      check: () => ({ status: "waiting", token: "shared-token" }),
      merge: () => {
        merges += 1
        return { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
      },
    })
    const pr = await submitBranch(app, "issue/reused-token")
    const first = (
      await app.queue.run(
        { prs: [pr.id], steps: ["check", "merge"] },
        {
          runner: "runner-1",
          leaseMs: 60_000,
        },
      )
    )[0]
    const firstJob = first?.steps[0]?.job
    if (firstJob?.status !== "waiting") throw new Error("first attempt did not wait")

    await app.jobs.finish(firstJob.id, {
      attempt: firstJob.attempt,
      runner: firstJob.runner,
      token: firstJob.token,
      result: {
        status: "completed",
        conclusion: "failure",
        error: { code: "remote-failed", message: "retry requested" },
      },
    })
    await app.jobs.retry(firstJob.id)
    const retried = await app.jobs.run(firstJob.id, { runner: "runner-2", leaseMs: 60_000 })
    expect(retried).toMatchObject({
      id: firstJob.id,
      status: "waiting",
      attempt: 2,
      runner: "runner-2",
      token: "shared-token",
    })

    const delayedAttemptOne = {
      job: firstJob.id,
      step: "check",
      attempt: firstJob.attempt,
      runner: firstJob.runner,
      token: firstJob.token,
      result: { status: "completed" as const, conclusion: "success" as const, output: { checked: true } },
    }
    await expect(app.queue.finish(pr.id, delayedAttemptOne, runtime)).rejects.toThrow("attempt 1 is stale")

    expect(app.queue.get(first!.id)?.steps[0]?.job).toMatchObject({
      status: "waiting",
      attempt: 2,
      runner: "runner-2",
    })
    expect(await terminalFor(app, pr.id)).toBeUndefined()
    expect(standingSubmit(app, pr.branch)).toMatchObject({ sha: pr.headSha })
    expect(merges).toBe(0)
  })

  it("refuses a delayed completion from an earlier Job with the same owner credential", async () => {
    let merges = 0
    await using app = await createQueueApp({
      check: () => ({ status: "waiting", token: "shared-token" }),
      merge: () => {
        merges += 1
        return { status: "completed", conclusion: "success", output: { commit: MERGED, baseSha: BASE } }
      },
    })
    const pr = await submitBranch(app, "issue/reused-owner")
    const first = (await app.queue.run({ prs: [], derived: [pr], steps: ["check", "merge"] }, runtime))[0]
    const firstJob = first?.steps[0]?.job
    if (firstJob?.status !== "waiting") throw new Error("first Job did not wait")

    await app.jobs.finish(firstJob.id, {
      attempt: firstJob.attempt,
      runner: firstJob.runner,
      token: firstJob.token,
      result: {
        status: "completed",
        conclusion: "failure",
        error: { code: "remote-failed", message: "resubmit requested" },
      },
    })
    await expect(app.queue.recover({ recoveryTime: "2026-01-01T00:03:00.000Z" })).resolves.toEqual([
      expect.objectContaining({ id: first?.id, status: "completed", conclusion: "failure" }),
    ])
    expect(app.queue.get(first!.id)).toMatchObject({ status: "completed", conclusion: "failure" })

    // The resubmission is a re-push: the fact moves, and re-deriving continues
    // the branch's revision count off the retained snapshot.
    await app.bays.recordBranchSubmit({ branch: pr.branch, sha: UPDATED, base: "main" })
    const resubmitted = memberOf(app, pr.branch)
    const second = (await app.queue.run({ prs: [], derived: [resubmitted], steps: ["check", "merge"] }, runtime)).find(
      (run) => run.id === "R2",
    )
    const secondJob = second?.steps[0]?.job
    if (secondJob?.status !== "waiting") throw new Error("second Job did not wait")
    expect(secondJob).toMatchObject({
      attempt: firstJob.attempt,
      runner: firstJob.runner,
      token: firstJob.token,
    })
    expect(secondJob.id).not.toBe(firstJob.id)

    await expect(
      app.queue.finish(
        pr.id,
        {
          job: firstJob.id,
          step: "check",
          attempt: firstJob.attempt,
          runner: firstJob.runner,
          token: firstJob.token,
          result: { status: "completed", conclusion: "success", output: { checked: true } },
        },
        runtime,
      ),
    ).rejects.toThrow(firstJob.id)
    expect(app.queue.get(second!.id)?.steps[0]?.job).toMatchObject({ id: secondJob.id, status: "waiting" })
    expect(await terminalFor(app, pr.id)).toBeUndefined()
    expect(standingSubmit(app, pr.branch)).toMatchObject({ sha: pr.headSha })
    expect(merges).toBe(0)
  })

  it("recursively bisects a red batch while the isolated failing PR stays open", async () => {
    const checked: string[][] = []
    await using app = await createQueueApp({
      batch: 4,
      prepareCandidate: (input) => {
        const { prs: _prs, ...candidate } = input
        const digit = input.id.slice(1)
        // One expression feeds both the SHA and the ref, so the fixture cannot
        // drift out of the content-addressed contract the Queue enforces.
        const sha = digit.repeat(40).slice(0, 40)
        return {
          ...candidate,
          sha,
          ref: candidateRefFor(sha),
          mergeability: "mergeable",
        }
      },
      check: (input) => {
        const prs = input.prs.map((pr) => pr.id)
        checked.push(prs)
        return prs.includes("PR3")
          ? { status: "completed", conclusion: "failure", error: { code: "check-failed", message: "bad PR" } }
          : { status: "completed", conclusion: "success", output: { checked: true } }
      },
    })
    const members = [
      await submitBranch(app, "issue/one"),
      await submitBranch(app, "issue/two"),
      await submitBranch(app, "issue/bad"),
      await submitBranch(app, "issue/four"),
    ]
    const failing = members[2]
    if (failing === undefined) throw new Error("expected the red batch member")

    const runs = await app.queue.run({ derived: members }, runtime)

    expect(checked).toEqual([["PR1", "PR2", "PR3", "PR4"], ["PR1", "PR2"], ["PR3", "PR4"], ["PR3"], ["PR4"]])
    expect(runs.map((run) => [run.prs.map((pr) => pr.id), run.conclusion])).toEqual([
      [["PR1", "PR2", "PR3", "PR4"], "failure"],
      [["PR1", "PR2"], "success"],
      [["PR3", "PR4"], "failure"],
      [["PR3"], "failure"],
      [["PR4"], "success"],
    ])
    expect(
      Object.values(app.state().queues.candidates).map((candidate) => ({
        id: candidate.id,
        revs: candidate.revs.map(({ pr }) => pr),
        sha: candidate.sha,
        ref: candidate.ref,
        mergeability: candidate.mergeability,
      })),
    ).toEqual([
      {
        id: "C1",
        revs: ["PR1", "PR2", "PR3", "PR4"],
        sha: "1".repeat(40),
        ref: candidateRefFor("1".repeat(40)),
        mergeability: "mergeable",
      },
      {
        id: "C2",
        revs: ["PR1", "PR2"],
        sha: "2".repeat(40),
        ref: candidateRefFor("2".repeat(40)),
        mergeability: "mergeable",
      },
      {
        id: "C3",
        revs: ["PR3", "PR4"],
        sha: "3".repeat(40),
        ref: candidateRefFor("3".repeat(40)),
        mergeability: "mergeable",
      },
      {
        id: "C4",
        revs: ["PR3"],
        sha: "4".repeat(40),
        ref: candidateRefFor("4".repeat(40)),
        mergeability: "mergeable",
      },
      {
        id: "C5",
        revs: ["PR4"],
        sha: "5".repeat(40),
        ref: candidateRefFor("5".repeat(40)),
        mergeability: "mergeable",
      },
    ])
    expect(runs.map(({ candidateId, parent }) => ({ candidateId, parent }))).toEqual([
      { candidateId: "C1", parent: undefined },
      { candidateId: "C2", parent: "R1" },
      { candidateId: "C3", parent: "R1" },
      { candidateId: "C4", parent: "R3" },
      { candidateId: "C5", parent: "R3" },
    ])
    for (const child of runs.slice(1)) expect(child).not.toHaveProperty("isolationPart")
    // Three members integrated; the isolated red one stayed open — no terminal
    // for it, and its submit fact still stands so the next drain re-admits it.
    const terminals = (await Array.fromAsync(app.events()))
      .filter(({ name }) => name === "pr/integrated")
      .map(({ data }) => (data as { pr: string }).pr)
      .toSorted()
    expect(terminals).toEqual(["PR1", "PR2", "PR4"])
    expect(await terminalFor(app, "PR3")).toBeUndefined()
    expect(standingSubmit(app, failing.branch)).toMatchObject({ sha: failing.headSha })
    expect((await Array.fromAsync(app.events())).map(({ name }) => name)).not.toContain("pr/rejected")
  })

  it("releases root-owned authority when an isolated child is environment-refused", async () => {
    const checked: string[][] = []
    let isolatedPR1Checks = 0
    await using app = await createQueueApp({
      batch: 2,
      check: (input) => {
        const prs = input.prs.map((pr) => pr.id)
        checked.push(prs)
        if (prs.length === 2) {
          return {
            status: "completed",
            conclusion: "failure",
            error: { code: "check-failed", message: "batch is merit-red" },
          }
        }
        if (prs[0] === "PR1" && ++isolatedPR1Checks === 1) {
          return {
            status: "completed",
            conclusion: "failure",
            error: { code: "queue-environment-refused", message: "isolated runner unavailable" },
          }
        }
        return { status: "completed", conclusion: "success", output: { checked: true } }
      },
    })
    const first = await submitBranch(app, "issue/environment-child")
    const second = await submitBranch(app, "issue/passing-child")

    const runs = await app.queue.run({ prs: [], derived: [first, second] }, runtime)

    expect(runs).toMatchObject([
      { id: "R1", status: "completed", conclusion: "failure", error: { code: "check-failed" } },
      {
        id: "R2",
        parent: "R1",
        status: "completed",
        conclusion: "failure",
        error: { code: "queue-environment-refused" },
      },
      { id: "R3", parent: "R1", status: "completed", conclusion: "success" },
    ])
    expect(checked).toEqual([["PR1", "PR2"], ["PR1"], ["PR2"]])
    expect(Queues.ids(app.state().queues)).toEqual(["R1", "R2", "R3"])
    expect(await terminalFor(app, "PR1")).toBeUndefined()
    expect(standingSubmit(app, first.branch)).toMatchObject({ sha: first.headSha })
    expect(await terminalFor(app, "PR2")).toMatchObject({ commit: MERGED })

    const events = await Array.fromAsync(app.events())
    const childFailure = events.find((applied) => {
      if (applied.name !== "queue/run/failed") return false
      const data = applied.data as Readonly<{ run?: unknown; error?: Readonly<{ code?: unknown }> }>
      return data.run === "R2" && data.error?.code === "queue-environment-refused"
    })
    if (childFailure === undefined) throw new Error("expected isolated environment refusal to fail R2")
    expect(Queues.authorityRun(app.state().queues.authority, "R1")).not.toHaveProperty("released")
    expect(Queues.authorityRun(app.state().queues.authority, "R2")).toMatchObject({
      inheritedFrom: "R1",
      released: { reason: "queue-environment-refused", ref: childFailure.id },
    })
    expect(app.state().queues.authority.submits.PR1).toEqual({
      pr: first.id,
      revision: first.revision,
      headSha: first.headSha,
    })
    expect(events.filter(({ name }) => name === "queue/batch/isolated")).toHaveLength(2)

    const retried = await app.queue.run({ prs: [], derived: [first] }, runtime)
    const newRuns = retried.filter(({ id: run }) => run === "R4")
    expect(newRuns).toHaveLength(1)
    expect(newRuns).toMatchObject([
      {
        id: "R4",
        status: "completed",
        conclusion: "success",
        prs: [{ id: first.id, revision: first.revision, headSha: first.headSha }],
      },
    ])
    expect(Queues.ids(app.state().queues)).toEqual(["R1", "R2", "R3", "R4"])
    expect(await terminalFor(app, first.id)).toMatchObject({
      run: "R4",
      revision: first.revision,
      headSha: first.headSha,
    })
  })
})

describe("Queue — a peer-canceled Job mid-execution never kills the composing runner (merge-queue R43)", () => {
  it("records the raced settlement as a visible typed skip and keeps composing", async () => {
    const journal = createMemoryJournal()
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const executing = Promise.withResolvers<void>()
    const release = Promise.withResolvers<JobResult<{ checked: boolean }>>()
    let checks = 0
    await using app = await createQueueApp(
      {
        check: () => {
          checks += 1
          if (checks > 1) return { status: "completed", conclusion: "success", output: { checked: true } }
          executing.resolve()
          return release.promise
        },
      },
      journal,
      undefined,
      undefined,
      log,
    )
    const pr = await submitBranch(app, "issue/peer-canceled")
    const running = app.queue.run({ prs: [], derived: [pr], steps: ["check"] }, runtime)
    await executing.promise

    // A peer runtime over the same journal (a separate process in production)
    // cancels the change while this runtime's step executes. This runtime's
    // projection stays stale until its settlement commit re-folds the journal,
    // where the finish transition meets the already-canceled Job.
    await using peer = await createQueueApp({}, journal, undefined, ids(1000))
    await peer.queue.cancel({ prs: [pr.id], by: "@peer", reason: "superseded" })

    release.resolve({ status: "completed", conclusion: "success", output: { checked: true } })
    const runs = await running
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ steps: [{ job: { status: "completed", conclusion: "cancelled" } }] })

    // The skip is LOUD and typed — never a silent swallow.
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "log",
        namespace: "yrd:queue",
        level: "warn",
        props: expect.objectContaining({
          action: "canceled-skip",
          run: runs[0]!.id,
          status: "completed",
          conclusion: "cancelled",
        }),
      }),
    )

    // The runner keeps processing subsequent work after the raced skip.
    const next = await submitBranch(app, "issue/after-cancel")
    await expect(app.queue.run({ prs: [], derived: [next], steps: ["check"] }, runtime)).resolves.toMatchObject([
      { status: "completed", conclusion: "success" },
    ])
  })

  it("still propagates settlement failures of a live Job loudly — the skip is terminal-state-verified, not a blanket catch", async () => {
    // Refuse exactly the finish-settlement append while the Job stays RUNNING:
    // a genuine infrastructure failure must escape the R43 skip and reject the
    // composing caller — proving the catch is narrow.
    const inner = createMemoryJournal()
    const journal: typeof inner = {
      read: (after, before) => inner.read(after, before),
      append: (value, cursor) => {
        const frame = value as { events?: readonly { name?: string; data?: { type?: string } }[] }
        if (frame.events?.some((event) => event.name === "job/transitioned" && event.data?.type === "finish")) {
          throw new Error("yrd: journal write refused (injected)")
        }
        return inner.append(value, cursor)
      },
    }
    await using app = await createQueueApp({}, journal)
    const pr = await submitBranch(app, "issue/journal-refused")
    await expect(app.queue.run({ prs: [], derived: [pr], steps: ["check"] }, runtime)).rejects.toThrow(
      "journal write refused (injected)",
    )
  })
})
