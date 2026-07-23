import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  PRAlreadyLandedSchema,
  PRCanceledSchema,
  PRRejectedFactSchema,
  PRWithdrawnSchema,
  type PRRejectedFact,
} from "@yrd/bay"
import { parseJournalFrame, raiseFailure, type Event, type Journal } from "@yrd/core"
import { createExclusive } from "@yrd/persistence"
import type { Process } from "@yrd/process"
import { createLogger, type ConditionalLogger } from "loggily"
import * as z from "zod"
import { actionableFailure, formatActionableFailure } from "./actionable-error.ts"
import type { SignalRouteTarget, SignalRoutes } from "./config.ts"

const TextSchema = z.string().trim().min(1)
const RevisionSchema = z.number().int().positive()
const GitShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu)
const REVIEW_BALL_TTL_MS = 10 * 60_000
const SignalPRSchema = z
  .object({
    pr: TextSchema,
    revision: RevisionSchema,
    headSha: GitShaSchema,
    actor: TextSchema.optional(),
  })
  .strict()
const SubmittedSignalDataSchema = SignalPRSchema.loose()
const IntegratedSignalDataSchema = SignalPRSchema.extend({ run: TextSchema, landingSha: GitShaSchema }).loose()
const RunFailedSignalDataSchema = z
  .object({
    run: TextSchema,
    error: z.object({ code: TextSchema, message: z.string() }).loose(),
    prs: z.array(SignalPRSchema).min(1),
  })
  .loose()

export type SignalPR = Readonly<z.infer<typeof SignalPRSchema>>

export type RejectedSignal = Readonly<{
  id: string
  kind: "pr/rejected"
  at: string
}> &
  PRRejectedFact

export type NeedsReviewSignal = Readonly<{
  id: string
  kind: "pr/needs-review"
  at: string
}> &
  SignalPR

export type WithdrawnSignal = Readonly<{
  id: string
  kind: "pr/withdrawn"
  at: string
}> &
  SignalPR

export type CanceledSignal = Readonly<{
  id: string
  kind: "pr/canceled"
  at: string
}> &
  SignalPR

export type IntegratedSignal = Readonly<{
  id: string
  kind: "pr/integrated"
  at: string
  run: string
  landingSha: string
  prs: readonly SignalPR[]
}>

export type AlreadyLandedSignal = Readonly<{
  id: string
  kind: "pr/already-landed"
  at: string
  pr: string
  revision: number
  headSha: string
  actor?: string
  run: string
  baseSha: string
  candidateSha: string
  candidateTreeSha: string
  baseTreeSha: string
}>

export type RunFailedSignal = Readonly<{
  id: string
  kind: "run/failed"
  at: string
  run: string
  error: Readonly<{ code: string; message: string }>
  prs: readonly SignalPR[]
}>

export type RoutableSignal =
  | RejectedSignal
  | NeedsReviewSignal
  | IntegratedSignal
  | AlreadyLandedSignal
  | RunFailedSignal
  | WithdrawnSignal
  | CanceledSignal

/** Signals that settle a PR revision line and therefore close its open request balls. */
export type TerminalSignal = IntegratedSignal | AlreadyLandedSignal | WithdrawnSignal | CanceledSignal

export type SignalDelivery = Readonly<{
  recipient: string
  event: RoutableSignal
}>

export type SignalClosure = Readonly<{
  recipient: string
  request: string
  pr: string
  revision: number
  kind: "pr/rejected" | "pr/needs-review"
}>

export type SignalDeliveryAdapter = Readonly<{
  send(delivery: SignalDelivery): void | Promise<void>
  close?(closure: SignalClosure): void | Promise<void>
}>

export type SignalObserver = Readonly<{
  journal: Journal<unknown>
  start(): void
  close(): Promise<void>
}>

/** Observe committed journal frames without becoming a second event owner.
 * Appends only wake background delivery; they never await the adapter. */
export function createSignalObserver(
  options: Readonly<{
    journal: Journal<unknown>
    stateDir: string
    routes: SignalRoutes
    /** Tribe identity sending deliveries; a message addressed back to this identity is informational, not a ball. */
    sender?: string
    reviewRequired?: boolean
    adapter: SignalDeliveryAdapter
    log?: ConditionalLogger
    /** Bounded per-drain delivery budget in ms. A one-shot CLI passes this so it can
     * never starve the resident: if delivery does not finish within the budget it
     * defers loudly (the resident's observer completes it) instead of holding on.
     * The resident itself passes nothing — it is the primary drainer. */
    deliveryBudgetMs?: number
  }>,
): SignalObserver {
  const dir = join(options.stateDir, "notifications")
  const cursorPath = join(dir, "cursor-v1.json")
  const log = options.log?.child("signals") ?? createLogger("yrd:signals", [{ level: "warn" }])
  // The snapshot lock fail-fasts (timeoutMs:0): only one drainer plans a batch at a
  // time, and a contender defers immediately rather than blocking. The write lock
  // takes a short, jittered-backoff hold to persist cursor progress BETWEEN
  // deliveries. Crucially, NEITHER is ever held across an `adapter.send`/`close` —
  // those `tribe` subprocesses (up to 5s each) run fully unlocked, so a one-shot can
  // no longer pin the writer.lock (or the journal read) and starve the resident.
  const snapshotLock = createExclusive(dir, { timeoutMs: 0 }, { log })
  const writeLock = createExclusive(dir, { timeoutMs: 2_000 }, { log })
  let requested = false
  let closed = false
  let worker: Promise<void> | undefined

  const drain = async (deadline?: number): Promise<void> => {
    // Phase 1 — under the snapshot lock ONLY, read the cursor and materialize the
    // pending journal frames into memory, then release. The slow delivery below never
    // runs under a lock, and the journal read never stays open across it (a pinned
    // reader defers the WAL checkpoint and stalled the resident's dispatch).
    const snapshot = await snapshotLock.run(async () => {
      const state = await readAndMigrateCursor(cursorPath)
      const batches: { values: readonly unknown[]; cursor: number }[] = []
      for await (const batch of options.journal.read(state.cursor)) {
        batches.push({ values: batch.values, cursor: batch.cursor })
      }
      return { state, batches }
    })
    let state = snapshot.state
    // Persist a single cursor mutation under a SHORT, independent write-lock hold.
    const persist = async (next: CursorState): Promise<void> => {
      state = next
      await writeLock.run(() => writeCursor(cursorPath, state))
    }
    // Budget guard: a one-shot stops delivering and defers loudly once its bounded
    // budget is spent, leaving the not-yet-advanced cursor for the resident to finish.
    const overBudget = (): boolean => deadline !== undefined && Date.now() >= deadline

    for (const batch of snapshot.batches) {
      const completed = new Set<string>()
      for (const value of batch.values) {
        const frame = parseJournalFrame(value)
        for (const signal of signalsOf(frame.events, options.reviewRequired === true)) {
          // Withdrawn/canceled are terminal-only: they close open balls but are never delivered as
          // messages, so they carry no delivery route of their own.
          const targets: readonly SignalRouteTarget[] =
            signal.kind === "pr/withdrawn" || signal.kind === "pr/canceled" ? [] : (options.routes[signal.kind] ?? [])
          const recipients = new Set(targets.flatMap((target) => resolveRecipients(signal, target)))
          if (targets.includes("submitter") && ![...recipients].some((recipient) => recipient !== "*")) {
            log.warn?.("PR signal has no recorded submitter; delivery skipped", {
              event: signal.id,
              kind: signal.kind,
              ...(signal.kind === "run/failed" ? { run: signal.run } : "pr" in signal ? { pr: signal.pr } : {}),
            })
          }
          for (const recipient of recipients) {
            if (state.sent[signal.id]?.includes(recipient) === true) continue
            if (overBudget()) return deferDelivery(log, cursorPath, deadline)
            await options.adapter.send({ recipient, event: signal }) // UNLOCKED
            state = addSent(state, signal.id, recipient)
            // Record the request ball we just opened so a later terminal signal can close this
            // exact id + recipient, even if the actor or routes drift before then.
            state = recordOpened(state, signal, recipient, options.sender)
            await persist(state)
          }
          if (isTerminalSignal(signal) && options.adapter.close !== undefined) {
            const settledPRs = new Set(terminalPRs(signal).map((pr) => pr.pr))
            const ledgerSettled = new Set<string>()
            // Authoritative: close the EXACT balls the opened-ledger recorded for these PRs — every
            // revision, both kinds — using the recipient captured at open time. Drift-immune.
            for (const ball of openedBallsFor(state, settledPRs)) {
              const key = `close:${ball.recipient}:${ball.requestId}`
              if (state.sent[signal.id]?.includes(key) !== true) {
                if (overBudget()) return deferDelivery(log, cursorPath, deadline)
                await options.adapter.close({
                  recipient: ball.recipient,
                  request: ball.requestId,
                  pr: ball.pr,
                  revision: ball.revision,
                  kind: ball.kind,
                }) // UNLOCKED
                state = addSent(state, signal.id, key)
              }
              state = forgetOpened(state, ball.requestId, ball.recipient)
              ledgerSettled.add(coverageKey(ball.pr, ball.revision, ball.kind))
              await persist(state)
            }
            // Secondary legacy drain: best-effort close of PRE-ledger balls (the backlog opened
            // before this ledger existed) via ids synthesized from current routes. Skips anything
            // the ledger already settled; a synthesized id that was never opened is a no-op close.
            for (const closure of closuresFor(signal, options.routes)) {
              if (ledgerSettled.has(coverageKey(closure.pr, closure.revision, closure.kind))) continue
              const key = `close:${closure.recipient}:${closure.request}`
              if (state.sent[signal.id]?.includes(key) === true) continue
              if (overBudget()) return deferDelivery(log, cursorPath, deadline)
              await options.adapter.close(closure) // UNLOCKED
              state = addSent(state, signal.id, key)
              await persist(state)
            }
          }
          completed.add(signal.id)
        }
      }
      state = advance(state, batch.cursor, completed)
      await persist(state)
    }
  }

  const run = async (): Promise<void> => {
    while (requested && !closed) {
      requested = false
      try {
        await drain(options.deliveryBudgetMs === undefined ? undefined : Date.now() + options.deliveryBudgetMs)
      } catch (error) {
        log.warn?.("PR signal delivery deferred", { error: errorDetail(error), cursor: cursorPath })
        requested = false
      }
    }
  }

  const wake = (): void => {
    if (closed) return
    requested = true
    if (worker !== undefined) return
    worker = run().finally(() => {
      worker = undefined
      if (requested && !closed) wake()
    })
  }

  const journal: Journal<unknown> = Object.freeze({
    read: (after, before) => options.journal.read(after, before),
    async append(value, expectedCursor) {
      const appended = await options.journal.append(value, expectedCursor)
      if (appended.appended) wake()
      return appended
    },
    // Checkpoint capability MUST pass through: this wrapper feeds every app
    // (host.ts uses signals.journal when signals are active), and dropping it
    // silently made the whole estate checkpoint-less — no writer ever flushed,
    // so every process paid the full cold fold (2026-07-20, 25s pr list).
    // Checkpoint state stays bounded while Journal.read() preserves complete
    // row history, so observer reads remain lossless.
    ...(options.journal.checkpoint === undefined ? {} : { checkpoint: options.journal.checkpoint }),
    // Immutable history/index capability must follow the same wrapper. Its
    // absence explicitly disables Core/Job/Queue live-window eviction.
    ...(options.journal.history === undefined ? {} : { history: options.journal.history }),
  })

  return Object.freeze({
    journal,
    start: wake,
    async close() {
      closed = true
      requested = false
      await worker
    },
  })
}

export function createTribeSignalAdapter(process: Pick<Process, "run">, sender?: string): SignalDeliveryAdapter {
  const executable = Bun.which("tribe")
  if (executable === null) {
    raiseFailure(
      "configuration",
      "signal-adapter-missing",
      "yrd: notify routes require the 'tribe' executable, but no live Tribe adapter is available",
    )
  }
  const execute = async (argv: readonly string[], action: string): Promise<void> => {
    const result = await process.run({ argv, timeoutMs: 5_000 })
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(
        `yrd: Tribe signal ${action} failed (${result.timedOut ? "timed out" : `exit ${result.exitCode}`}): ${result.stderr.trim() || result.stdout.trim()}`,
      )
    }
  }
  return Object.freeze({
    async send(delivery) {
      const request = trackedRequestId(delivery.event, delivery.recipient, sender)
      const tracked = request !== undefined
      await execute(
        [
          executable,
          "send",
          delivery.recipient,
          deliveryText(delivery),
          "--type",
          tracked ? "request" : "notify",
          "--summary",
          deliverySummary(delivery),
          "--delivery",
          tracked ? "push" : "pull",
          ...(request === undefined ? [] : ["--request", request]),
          ...(tracked ? ["--expires-in-ms", String(REVIEW_BALL_TTL_MS)] : []),
        ],
        "delivery",
      )
    },
    async close(closure) {
      await execute(
        [executable, "pending", "--owner", closure.recipient, "--close", closure.request],
        "terminal unsubscribe",
      )
    },
  })
}

const OpenedBallSchema = z
  .object({
    pr: TextSchema,
    revision: RevisionSchema,
    kind: z.enum(["pr/rejected", "pr/needs-review"]),
    recipient: TextSchema,
    requestId: TextSchema,
  })
  .strict()
type OpenedBall = z.infer<typeof OpenedBallSchema>

const OPENED_LEDGER_SENT_KEY = "yrd:opened:v1"
const CursorFileSchema = z
  .object({
    version: z.literal(1),
    cursor: z.number().int().nonnegative(),
    sent: z.record(z.string().min(1), z.array(TextSchema)),
  })
  .strict()
const CursorStateSchema = CursorFileSchema.extend({
  // Durable opened-ledger: the EXACT request ball (id + recipient) recorded when each PR revision
  // was put up for review. Legacy rejection entries remain readable after rejection became
  // evidence-only. A terminal signal closes precisely these — immune to actor/route drift. The
  // optional top-level field reads the short-lived drifted format and is immediately migrated into
  // the v1 `sent` record, which older worktree readers already preserve and ignore.
  opened: z.array(OpenedBallSchema).default([]),
}).strict()
type CursorState = z.infer<typeof CursorStateSchema>

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A budget-bounded drainer (a one-shot CLI) stops delivering and defers loudly once
 * its budget is spent, leaving the un-advanced cursor for the resident's observer to
 * finish. This is the "never starve the resident, defer instead of spinning" contract:
 * the one-shot exits promptly and the delivery is not lost. */
function deferDelivery(log: ConditionalLogger, cursorPath: string, deadline: number | undefined): void {
  log.warn?.("PR signal delivery deferred — delivery budget spent; a resident runner will complete it", {
    cursor: cursorPath,
    ...(deadline === undefined ? {} : { deadline: new Date(deadline).toISOString() }),
  })
}

function signalsOf(events: readonly Event[], reviewRequired: boolean): readonly RoutableSignal[] {
  const signals: RoutableSignal[] = []
  const integrated = new Map<string, IntegratedSignal>()
  for (const event of events) {
    const signal = directSignalOf(event, reviewRequired)
    if (signal !== undefined) signals.push(signal)
    if (event.name !== "pr/integrated") continue
    const parsed = IntegratedSignalDataSchema.safeParse(event.data)
    if (!parsed.success) continue
    const key = `${parsed.data.run}:${parsed.data.landingSha}`
    const current = integrated.get(key)
    const pr: SignalPR = {
      pr: parsed.data.pr,
      revision: parsed.data.revision,
      headSha: parsed.data.headSha,
      ...(parsed.data.actor === undefined ? {} : { actor: parsed.data.actor }),
    }
    integrated.set(
      key,
      current === undefined
        ? {
            id: event.id,
            kind: "pr/integrated",
            at: event.ts,
            run: parsed.data.run,
            landingSha: parsed.data.landingSha,
            prs: [pr],
          }
        : { ...current, prs: [...current.prs, pr] },
    )
  }
  return [...signals, ...integrated.values()]
}

function directSignalOf(event: Event, reviewRequired: boolean): RoutableSignal | undefined {
  if (event.name === "pr/rejected") {
    if (typeof event.data !== "object" || event.data === null || Array.isArray(event.data) || !("step" in event.data)) {
      return undefined
    }
    const data = PRRejectedFactSchema.parse(event.data)
    return Object.freeze({ id: event.id, kind: "pr/rejected", at: event.ts, ...data })
  }
  if (event.name === "pr/submitted" && reviewRequired) {
    const parsed = SubmittedSignalDataSchema.safeParse(event.data)
    if (!parsed.success) return undefined
    return Object.freeze({
      id: event.id,
      kind: "pr/needs-review",
      at: event.ts,
      pr: parsed.data.pr,
      revision: parsed.data.revision,
      headSha: parsed.data.headSha,
      ...(parsed.data.actor === undefined ? {} : { actor: parsed.data.actor }),
    })
  }
  if (event.name === "queue/run/failed") {
    const parsed = RunFailedSignalDataSchema.safeParse(event.data)
    if (!parsed.success) return undefined
    return Object.freeze({
      id: event.id,
      kind: "run/failed",
      at: event.ts,
      run: parsed.data.run,
      error: { code: parsed.data.error.code, message: parsed.data.error.message },
      prs: parsed.data.prs,
    })
  }
  if (event.name === "pr/already-landed") {
    const parsed = PRAlreadyLandedSchema.safeParse(event.data)
    if (!parsed.success) return undefined
    return Object.freeze({ id: event.id, kind: "pr/already-landed", at: event.ts, ...parsed.data })
  }
  if (event.name === "pr/withdrawn") {
    const parsed = PRWithdrawnSchema.safeParse(event.data)
    if (!parsed.success) return undefined
    return Object.freeze({
      id: event.id,
      kind: "pr/withdrawn",
      at: event.ts,
      pr: parsed.data.pr,
      revision: parsed.data.revision,
      headSha: parsed.data.headSha,
      ...(parsed.data.actor === undefined ? {} : { actor: parsed.data.actor }),
    })
  }
  if (event.name === "pr/canceled") {
    const parsed = PRCanceledSchema.safeParse(event.data)
    if (!parsed.success) return undefined
    return Object.freeze({
      id: event.id,
      kind: "pr/canceled",
      at: event.ts,
      pr: parsed.data.pr,
      revision: parsed.data.revision,
      headSha: parsed.data.headSha,
      ...(parsed.data.actor === undefined ? {} : { actor: parsed.data.actor }),
    })
  }
  return undefined
}

function resolveRecipients(signal: RoutableSignal, target: SignalRouteTarget): readonly string[] {
  if (target === "broadcast") return ["*"]
  if (target !== "submitter") return [target]
  if (signal.kind === "pr/integrated" || signal.kind === "run/failed") {
    return [...new Set(signal.prs.flatMap((pr) => (pr.actor === undefined ? [] : [pr.actor])))]
  }
  return signal.actor === undefined ? [] : [signal.actor]
}

function isTerminalSignal(signal: RoutableSignal): signal is TerminalSignal {
  return (
    signal.kind === "pr/integrated" ||
    signal.kind === "pr/already-landed" ||
    signal.kind === "pr/withdrawn" ||
    signal.kind === "pr/canceled"
  )
}

/** The PR revision lines a terminal signal settles: the whole integrated batch, or the single
 * withdrawn/canceled PR. */
function terminalPRs(signal: TerminalSignal): readonly SignalPR[] {
  if (signal.kind === "pr/integrated") return signal.prs
  return [
    {
      pr: signal.pr,
      revision: signal.revision,
      headSha: signal.headSha,
      ...(signal.actor === undefined ? {} : { actor: signal.actor }),
    },
  ]
}

function closuresFor(signal: TerminalSignal, routes: SignalRoutes): readonly SignalClosure[] {
  const closures = new Map<string, SignalClosure>()
  for (const pr of terminalPRs(signal)) {
    for (const kind of ["pr/rejected", "pr/needs-review"] as const) {
      for (const target of routes[kind] ?? []) {
        const recipients =
          target === "submitter" ? (pr.actor === undefined ? [] : [pr.actor]) : target === "broadcast" ? [] : [target]
        for (const recipient of recipients) {
          // A terminal event settles the whole revision line, so close every prior revision's
          // request id — not just the terminal revision's. Otherwise a rev-1 rejection ball outlives
          // a rev-2 integration/withdrawal. adapter.close is a required no-op on a missing/closed id.
          for (let revision = 1; revision <= pr.revision; revision += 1) {
            const request = requestIdForPR(kind, pr.pr, revision, recipient)
            closures.set(`${recipient}:${request}`, { recipient, request, pr: pr.pr, revision, kind })
          }
        }
      }
    }
  }
  return [...closures.values()]
}

function trackedRequestId(signal: RoutableSignal, recipient: string, sender?: string): string | undefined {
  if (signal.kind !== "pr/needs-review" || sender === recipient) return undefined
  return requestIdForPR(signal.kind, signal.pr, signal.revision, recipient)
}

function requestIdForPR(
  kind: "pr/rejected" | "pr/needs-review",
  pr: string,
  revision: number,
  recipient: string,
): string {
  return `yrd:${kind}:${pr}:${revision}:${recipient}`
}

async function readAndMigrateCursor(path: string): Promise<CursorState> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"))
    const state = decodeCursorState(CursorStateSchema.parse(raw))
    if (typeof raw === "object" && raw !== null && Object.hasOwn(raw, "opened")) await writeCursor(path, state)
    return state
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { version: 1, cursor: 0, sent: {}, opened: [] }
    }
    throw new Error(`yrd: notification cursor is invalid (${path}): ${errorDetail(error)}`, { cause: error })
  }
}

async function writeCursor(path: string, state: CursorState): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    const sent = { ...state.sent }
    delete sent[OPENED_LEDGER_SENT_KEY]
    if (state.opened.length > 0) {
      sent[OPENED_LEDGER_SENT_KEY] = state.opened.map((ball) => JSON.stringify(OpenedBallSchema.parse(ball)))
    }
    const file = CursorFileSchema.parse({ version: 1, cursor: state.cursor, sent })
    await writeFile(temporary, `${JSON.stringify(file)}\n`, { flag: "wx" })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

function decodeCursorState(state: CursorState): CursorState {
  const sent = { ...state.sent }
  const encoded = sent[OPENED_LEDGER_SENT_KEY] ?? []
  delete sent[OPENED_LEDGER_SENT_KEY]
  const opened = new Map<string, OpenedBall>()
  for (const ball of [...encoded.map((value) => OpenedBallSchema.parse(JSON.parse(value))), ...state.opened]) {
    opened.set(`${ball.recipient}:${ball.requestId}`, ball)
  }
  return { ...state, sent, opened: [...opened.values()] }
}

function addSent(state: CursorState, event: string, recipient: string): CursorState {
  const recorded = state.sent[event] ?? []
  if (recorded.includes(recipient)) return state
  return { ...state, sent: { ...state.sent, [event]: [...recorded, recipient] } }
}

function advance(state: CursorState, cursor: number, completed: ReadonlySet<string>): CursorState {
  const sent = { ...state.sent }
  for (const event of completed) delete sent[event]
  // The opened-ledger is durable across batches — a ball opened in one batch is closed by a terminal
  // signal in a later one — so it survives the per-batch `sent` cursor GC.
  return { version: 1, cursor, sent, opened: state.opened }
}

function coverageKey(pr: string, revision: number, kind: "pr/rejected" | "pr/needs-review"): string {
  return `${pr}:${revision}:${kind}`
}

function recordOpened(state: CursorState, signal: RoutableSignal, recipient: string, sender?: string): CursorState {
  if (signal.kind !== "pr/needs-review") return state
  const requestId = trackedRequestId(signal, recipient, sender)
  if (requestId === undefined) return state
  if (state.opened.some((ball) => ball.requestId === requestId && ball.recipient === recipient)) return state
  const ball: OpenedBall = { pr: signal.pr, revision: signal.revision, kind: signal.kind, recipient, requestId }
  return { ...state, opened: [...state.opened, ball] }
}

function openedBallsFor(state: CursorState, prs: ReadonlySet<string>): readonly OpenedBall[] {
  return state.opened.filter((ball) => prs.has(ball.pr))
}

function forgetOpened(state: CursorState, requestId: string, recipient: string): CursorState {
  const opened = state.opened.filter((ball) => !(ball.requestId === requestId && ball.recipient === recipient))
  if (opened.length === state.opened.length) return state
  return { ...state, opened }
}

function deliveryText(delivery: SignalDelivery): string {
  const { event } = delivery
  if (event.kind === "pr/rejected") {
    const failure = actionableFailure({
      code: "pr-rejected",
      message: event.detail ?? `PR ${event.pr} revision ${event.revision} was rejected at step ${event.step}`,
    })
    return [
      `Yrd rejected ${event.pr} revision ${event.revision} at step ${event.step}.`,
      `run=${event.run}`,
      `head=${event.headSha}`,
      ...(event.evidence === undefined ? [] : [`evidence=${event.evidence}`]),
      formatActionableFailure(failure),
      `event=${event.id}`,
    ].join("\n")
  }
  if (event.kind === "pr/needs-review") {
    return `Yrd needs review for ${event.pr} revision ${event.revision}. head=${event.headSha} event=${event.id}`
  }
  if (event.kind === "pr/integrated") {
    return `Yrd integrated ${event.prs.map(({ pr }) => pr).join(", ")} at ${event.landingSha}. run=${event.run} event=${event.id}`
  }
  if (event.kind === "pr/already-landed") {
    return [
      `Yrd found ${event.pr} already landed at ${event.baseSha}; no merge commit was created.`,
      `run=${event.run}`,
      `candidate=${event.candidateSha}`,
      `tree=${event.candidateTreeSha}`,
      `event=${event.id}`,
    ].join("\n")
  }
  if (event.kind === "run/failed") {
    return [
      `Yrd failed ${event.prs.map(({ pr }) => pr).join(", ")}. run=${event.run}`,
      formatActionableFailure(actionableFailure(event.error)),
      `event=${event.id}`,
    ].join("\n")
  }
  throw new Error(`yrd: ${event.kind} is a terminal closure signal and is never delivered as a message`)
}

function deliverySummary(delivery: SignalDelivery): string {
  const { event } = delivery
  if (event.kind === "pr/rejected") return `${event.pr} rejected at ${event.step}`
  if (event.kind === "pr/needs-review") return `${event.pr} needs review`
  if (event.kind === "pr/integrated") return `${event.prs.map(({ pr }) => pr).join(", ")} integrated`
  if (event.kind === "pr/already-landed") return `${event.pr} already landed`
  if (event.kind === "run/failed") return `${event.run} failed`
  throw new Error(`yrd: ${event.kind} is a terminal closure signal and has no delivery summary`)
}
