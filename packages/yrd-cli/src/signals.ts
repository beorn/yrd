import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  CauseSchema,
  Command,
  CommandSchema,
  EventSchema,
  JsonSchema,
  raiseFailure,
  type Event,
  type Journal,
} from "@yrd/core"
import { createExclusive } from "@yrd/persistence"
import type { Process } from "@yrd/process"
import { createLogger, type ConditionalLogger } from "loggily"
import * as z from "zod"

const TextSchema = z.string().trim().min(1)
const SignalTargetSchema = z.union([z.literal("submitter"), TextSchema.regex(/^@[a-z0-9][a-z0-9/_-]*$/iu)])
const CorrelationSchema = z.object({ namespace: TextSchema, id: TextSchema }).strict()
const RejectedSignalDataSchema = z
  .object({
    pr: TextSchema,
    revision: z.number().int().positive(),
    headSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
    run: TextSchema,
    issueRef: TextSchema.optional(),
    correlation: CorrelationSchema.optional(),
    actor: TextSchema.optional(),
    step: TextSchema,
    evidence: TextSchema.optional(),
    detail: z.string().optional(),
  })
  .strict()
const ObservedJournalFrameSchema = z
  .object({
    cause: CauseSchema,
    command: CommandSchema,
    events: z.array(EventSchema),
    value: JsonSchema.optional(),
  })
  .strict()

export type SignalRouteTarget = z.infer<typeof SignalTargetSchema>
export type SignalRoutes = Readonly<Partial<Record<"pr/rejected", readonly SignalRouteTarget[]>>>

export type RejectedSignal = Readonly<{
  id: string
  kind: "pr/rejected"
  at: string
  pr: string
  revision: number
  headSha: string
  run: string
  actor?: string
  step: string
  evidence?: string
  detail?: string
}>

export type SignalDelivery = Readonly<{
  recipient: string
  event: RejectedSignal
}>

export type SignalDeliveryAdapter = Readonly<{
  send(delivery: SignalDelivery): void | Promise<void>
}>

export type SignalObserver = Readonly<{
  journal: Journal<unknown>
  start(): void
  flush(): Promise<void>
  pending(): boolean
  close(): Promise<void>
}>

const CursorStateSchema = z
  .object({
    version: z.literal(1),
    cursor: z.number().int().nonnegative(),
    sent: z.record(z.string().min(1), z.array(TextSchema)),
  })
  .strict()
type CursorState = z.infer<typeof CursorStateSchema>

const EmptyCursorState: CursorState = Object.freeze({ version: 1, cursor: 0, sent: Object.freeze({}) })

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function signalOf(event: Event): RejectedSignal | undefined {
  if (event.name !== "pr/rejected") return undefined
  if (typeof event.data !== "object" || event.data === null || Array.isArray(event.data) || !("step" in event.data)) {
    // Rejections committed before this routable surface existed remain valid
    // history, but were never notification promises.
    return undefined
  }
  const data = RejectedSignalDataSchema.parse(event.data)
  return Object.freeze({
    id: event.id,
    kind: "pr/rejected",
    at: event.ts,
    pr: data.pr,
    revision: data.revision,
    headSha: data.headSha,
    run: data.run,
    ...(data.actor === undefined ? {} : { actor: data.actor }),
    step: data.step,
    ...(data.evidence === undefined ? {} : { evidence: data.evidence }),
    ...(data.detail === undefined ? {} : { detail: data.detail }),
  })
}

function journalEvents(value: unknown): readonly Event[] {
  const frame = ObservedJournalFrameSchema.parse(value)
  Command.assertCause(frame.command, frame.cause)
  return frame.events
}

function recipients(signal: RejectedSignal, targets: readonly SignalRouteTarget[]): readonly string[] {
  return targets.map((target) => {
    if (target !== "submitter") return target
    if (signal.actor === undefined) {
      throw new Error(`yrd: PR '${signal.pr}' revision ${signal.revision} has no recorded submitter for signal ${signal.id}`)
    }
    return signal.actor
  })
}

async function readCursor(path: string): Promise<CursorState> {
  try {
    return CursorStateSchema.parse(JSON.parse(await readFile(path, "utf8")))
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return structuredClone(EmptyCursorState)
    }
    throw new Error(`yrd: notification cursor is invalid (${path}): ${errorDetail(error)}`, { cause: error })
  }
}

async function writeCursor(path: string, state: CursorState): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true })
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
  return {
    ...state,
    sent: { ...state.sent, [event]: [...recorded, recipient] },
  }
}

function advance(state: CursorState, cursor: number, completed: ReadonlySet<string>): CursorState {
  const sent = { ...state.sent }
  for (const event of completed) delete sent[event]
  return { version: 1, cursor, sent }
}

export function createSignalObserver(options: Readonly<{
  journal: Journal<unknown>
  stateDir: string
  routes: SignalRoutes
  adapter: SignalDeliveryAdapter
  log?: ConditionalLogger
}>): SignalObserver {
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
          for (const event of journalEvents(value)) {
            const signal = signalOf(event)
            const targets = signal === undefined ? undefined : options.routes[signal.kind]
            if (signal === undefined || targets === undefined || targets.length === 0) continue
            for (const recipient of recipients(signal, targets)) {
              if (state.sent[signal.id]?.includes(recipient) === true) continue
              await options.adapter.send({ recipient, event: signal })
              state = addSent(state, signal.id, recipient)
              await writeCursor(cursorPath, state)
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
        log.warn?.("PR signal delivery deferred", {
          error: errorDetail(error),
          cursor: cursorPath,
        })
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
    async flush() {
      while (worker !== undefined) await worker
    },
    pending: () => worker !== undefined,
    async close() {
      closed = true
      requested = false
      await worker
    },
  })
}

function deliveryText(delivery: SignalDelivery): string {
  const { event } = delivery
  return [
    `Yrd rejected ${event.pr} revision ${event.revision} at step ${event.step}.`,
    `run=${event.run}`,
    `head=${event.headSha}`,
    ...(event.evidence === undefined ? [] : [`evidence=${event.evidence}`]),
    ...(event.detail === undefined ? [] : [`detail=${event.detail}`]),
    `event=${event.id}`,
  ].join(" ")
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
  return Object.freeze({
    async send(delivery) {
      const result = await process.run({
        argv: [
          executable,
          "send",
          delivery.recipient,
          deliveryText(delivery),
          "--type",
          "request",
          "--summary",
          `${delivery.event.pr} rejected at ${delivery.event.step}`,
          "--request",
        ],
        timeoutMs: 5_000,
      })
      if (result.exitCode !== 0 || result.timedOut) {
        throw new Error(
          `yrd: Tribe signal delivery failed (${result.timedOut ? "timed out" : `exit ${result.exitCode}`}): ${result.stderr.trim() || result.stdout.trim()}`,
        )
      }
    },
  })
}
