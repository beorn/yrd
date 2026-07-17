import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { PRCanceledSchema, PRRejectedFactSchema, PRWithdrawnSchema, type PRRejectedFact } from "@yrd/bay"
import { parseJournalFrame, raiseFailure, type Event, type Journal } from "@yrd/core"
import { createExclusive } from "@yrd/persistence"
import type { Process } from "@yrd/process"
import { createLogger, type ConditionalLogger } from "loggily"
import * as z from "zod"
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
  | RunFailedSignal
  | WithdrawnSignal
  | CanceledSignal

/** Signals that settle a PR revision line and therefore close its open request balls. */
export type TerminalSignal = IntegratedSignal | WithdrawnSignal | CanceledSignal

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
    reviewRequired?: boolean
    adapter: SignalDeliveryAdapter
    log?: ConditionalLogger
  }>,
): SignalObserver {
  const dir = join(options.stateDir, "notifications")
  const cursorPath = join(dir, "cursor-v1.json")
  const log = options.log?.child("signals") ?? createLogger("yrd:signals", [{ level: "warn" }])
  const exclusive = createExclusive(dir, { timeoutMs: 0 }, { log })
  let requested = false
  let closed = false
  let worker: Promise<void> | undefined

  const drain = async (): Promise<void> => {
    await exclusive.run(async () => {
      let state = await readCursor(cursorPath)
      for await (const batch of options.journal.read(state.cursor)) {
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
              await options.adapter.send({ recipient, event: signal })
              state = addSent(state, signal.id, recipient)
              // Record the request ball we just opened so a later terminal signal can close this
              // exact id + recipient, even if the actor or routes drift before then.
              state = recordOpened(state, signal, recipient)
              await writeCursor(cursorPath, state)
            }
            if (isTerminalSignal(signal) && options.adapter.close !== undefined) {
              const settledPRs = new Set(terminalPRs(signal).map((pr) => pr.pr))
              const ledgerSettled = new Set<string>()
              // Authoritative: close the EXACT balls the opened-ledger recorded for these PRs — every
              // revision, both kinds — using the recipient captured at open time. Drift-immune.
              for (const ball of openedBallsFor(state, settledPRs)) {
                const key = `close:${ball.recipient}:${ball.requestId}`
                if (state.sent[signal.id]?.includes(key) !== true) {
                  await options.adapter.close({
                    recipient: ball.recipient,
                    request: ball.requestId,
                    pr: ball.pr,
                    revision: ball.revision,
                    kind: ball.kind,
                  })
                  state = addSent(state, signal.id, key)
                }
                state = forgetOpened(state, ball.requestId, ball.recipient)
                ledgerSettled.add(coverageKey(ball.pr, ball.revision, ball.kind))
                await writeCursor(cursorPath, state)
              }
              // Secondary legacy drain: best-effort close of PRE-ledger balls (the backlog opened
              // before this ledger existed) via ids synthesized from current routes. Skips anything
              // the ledger already settled; a synthesized id that was never opened is a no-op close.
              for (const closure of closuresFor(signal, options.routes)) {
                if (ledgerSettled.has(coverageKey(closure.pr, closure.revision, closure.kind))) continue
                const key = `close:${closure.recipient}:${closure.request}`
                if (state.sent[signal.id]?.includes(key) === true) continue
                await options.adapter.close(closure)
                state = addSent(state, signal.id, key)
                await writeCursor(cursorPath, state)
              }
            }
            completed.add(signal.id)
          }
        }
        state = advance(state, batch.cursor, completed)
        await writeCursor(cursorPath, state)
      }
    })
  }

  const run = async (): Promise<void> => {
    while (requested && !closed) {
      requested = false
      try {
        await drain()
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

export function createTribeSignalAdapter(process: Pick<Process, "run">): SignalDeliveryAdapter {
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
      const request = trackedRequestId(delivery.event, delivery.recipient)
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

const CursorStateSchema = z
  .object({
    version: z.literal(1),
    cursor: z.number().int().nonnegative(),
    sent: z.record(z.string().min(1), z.array(TextSchema)),
    // Durable opened-ledger: the EXACT request ball (id + recipient) recorded when each PR revision
    // was put up for review. The schema retains legacy rejection entries written before rejection
    // became evidence-only. A terminal signal closes precisely these — immune to actor/route drift.
    // Optional and defaulted so cursor files written before the ledger existed still load.
    opened: z.array(OpenedBallSchema).default([]),
  })
  .strict()
type CursorState = z.infer<typeof CursorStateSchema>

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
  return signal.kind === "pr/integrated" || signal.kind === "pr/withdrawn" || signal.kind === "pr/canceled"
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

function trackedRequestId(signal: RoutableSignal, recipient: string): string | undefined {
  if (signal.kind !== "pr/needs-review") return undefined
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

async function readCursor(path: string): Promise<CursorState> {
  try {
    return CursorStateSchema.parse(JSON.parse(await readFile(path, "utf8")))
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
    await writeFile(temporary, `${JSON.stringify(CursorStateSchema.parse(state))}\n`, { flag: "wx" })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
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

function recordOpened(state: CursorState, signal: RoutableSignal, recipient: string): CursorState {
  if (signal.kind !== "pr/needs-review") return state
  const requestId = trackedRequestId(signal, recipient)
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
    return [
      `Yrd rejected ${event.pr} revision ${event.revision} at step ${event.step}.`,
      `run=${event.run}`,
      `head=${event.headSha}`,
      ...(event.evidence === undefined ? [] : [`evidence=${event.evidence}`]),
      ...(event.detail === undefined ? [] : [`detail=${event.detail}`]),
      `event=${event.id}`,
    ].join(" ")
  }
  if (event.kind === "pr/needs-review") {
    return `Yrd needs review for ${event.pr} revision ${event.revision}. head=${event.headSha} event=${event.id}`
  }
  if (event.kind === "pr/integrated") {
    return `Yrd integrated ${event.prs.map(({ pr }) => pr).join(", ")} at ${event.landingSha}. run=${event.run} event=${event.id}`
  }
  if (event.kind === "run/failed") {
    return `Yrd failed ${event.prs.map(({ pr }) => pr).join(", ")}. run=${event.run} ${event.error.code}: ${event.error.message} event=${event.id}`
  }
  throw new Error(`yrd: ${event.kind} is a terminal closure signal and is never delivered as a message`)
}

function deliverySummary(delivery: SignalDelivery): string {
  const { event } = delivery
  if (event.kind === "pr/rejected") return `${event.pr} rejected at ${event.step}`
  if (event.kind === "pr/needs-review") return `${event.pr} needs review`
  if (event.kind === "pr/integrated") return `${event.prs.map(({ pr }) => pr).join(", ")} integrated`
  if (event.kind === "run/failed") return `${event.run} failed`
  throw new Error(`yrd: ${event.kind} is a terminal closure signal and has no delivery summary`)
}
