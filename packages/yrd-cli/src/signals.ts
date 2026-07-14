import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { PRRejectedFactSchema, type PRRejectedFact } from "@yrd/bay"
import { parseJournalFrame, raiseFailure, type Event, type Journal } from "@yrd/core"
import { createExclusive } from "@yrd/persistence"
import type { Process } from "@yrd/process"
import { createLogger, type ConditionalLogger } from "loggily"
import * as z from "zod"
import type { SignalRouteTarget, SignalRoutes } from "./config.ts"

const TextSchema = z.string().trim().min(1)

export type RejectedSignal = Readonly<{
  id: string
  kind: "pr/rejected"
  at: string
}> &
  PRRejectedFact

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
  close(): Promise<void>
}>

/** Observe committed journal frames without becoming a second event owner.
 * Appends only wake background delivery; they never await the adapter. */
export function createSignalObserver(
  options: Readonly<{
    journal: Journal<unknown>
    stateDir: string
    routes: SignalRoutes
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
          for (const event of parseJournalFrame(value).events) {
            const signal = signalOf(event)
            const targets = signal === undefined ? undefined : options.routes[signal.kind]
            if (signal === undefined || targets === undefined || targets.length === 0) continue
            for (const target of targets) {
              const recipient = resolveRecipient(signal, target)
              if (recipient === undefined) {
                log.warn?.("PR signal has no recorded submitter; delivery skipped", {
                  event: signal.id,
                  pr: signal.pr,
                  revision: signal.revision,
                })
                continue
              }
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

const CursorStateSchema = z
  .object({
    version: z.literal(1),
    cursor: z.number().int().nonnegative(),
    sent: z.record(z.string().min(1), z.array(TextSchema)),
  })
  .strict()
type CursorState = z.infer<typeof CursorStateSchema>

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function signalOf(event: Event): RejectedSignal | undefined {
  if (event.name !== "pr/rejected") return undefined
  if (typeof event.data !== "object" || event.data === null || Array.isArray(event.data) || !("step" in event.data)) {
    // Rejections committed before this routable fact existed remain valid
    // history, but were never notification promises.
    return undefined
  }
  const data = PRRejectedFactSchema.parse(event.data)
  return Object.freeze({ id: event.id, kind: "pr/rejected", at: event.ts, ...data })
}

function resolveRecipient(signal: RejectedSignal, target: SignalRouteTarget): string | undefined {
  return target === "submitter" ? signal.actor : target
}

async function readCursor(path: string): Promise<CursorState> {
  try {
    return CursorStateSchema.parse(JSON.parse(await readFile(path, "utf8")))
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { version: 1, cursor: 0, sent: {} }
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
  return { version: 1, cursor, sent }
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
