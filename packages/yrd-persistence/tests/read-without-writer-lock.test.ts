/**
 * @failure A journal READ takes the writer lock, parks unbounded behind a live
 * writer, cannot be interrupted, and refuses without naming what held it
 * (24019: `yrd mr list --json` returned nothing in 30 s beside a one-shot pass,
 * sat over 60 s, ignored TERM and INT, and needed a process-group KILL; the
 * lock file read `{"holder":"journal-read"}`).
 * @level l1
 * @consumer @yrd/persistence
 */
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { CauseSchema, Command, EventSchema, type Cause, type Event, type Journal } from "@yrd/core"
import { createLogger, type Event as LogEvent } from "loggily"
import { afterEach, describe, expect, it } from "vitest"
import { createExclusive, createJournal, type Exclusive } from "@yrd/persistence"

const SAFE_SQLITE = "3.53.0"
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yrd-read-no-lock-"))
  roots.push(dir)
  return dir
}

function uuid(label: string): string {
  const hex = createHash("sha256").update(label).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function frame(key: string) {
  const command = Command.parse({ id: uuid(`command:${key}`), op: "test.record" })
  const cause: Cause = CauseSchema.parse({
    id: uuid(`cause:${key}`),
    commandId: command.id,
    op: command.op,
    commandHash: Command.hash(command),
  })
  const applied: Event = EventSchema.parse({
    id: uuid(`event:${key}`),
    name: "test/recorded",
    ts: "2026-09-01T12:00:00.000Z",
    data: { text: key },
  })
  return { cause, command, events: [applied] }
}

type Options = Parameters<typeof createJournal>[0]

function mutableJournal(dir: string, extra: Partial<Options> & { inject?: Record<string, unknown> } = {}) {
  return createJournal({
    dir,
    ...extra,
    inject: { sqliteVersion: SAFE_SQLITE, ...(extra.inject ?? {}) },
  } as unknown as Options) as Journal<unknown> & {
    checkpoint: { load(identity: string): Promise<unknown>; inspect(): Promise<unknown> }
  }
}

/** Hold `<dir>/writer.lock` the way a live pass does, until `release()`. */
async function heldBy(dir: string, holder: string): Promise<() => Promise<void>> {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const held = createExclusive(dir).run(
    async () => {
      entered.resolve()
      await release.promise
    },
    { holder },
  )
  await entered.promise
  return async () => {
    release.resolve()
    await held
  }
}

async function timed<Result>(
  operation: Promise<Result>,
): Promise<{ ms: number; outcome: "resolved" | "rejected"; error?: unknown }> {
  const started = performance.now()
  try {
    await operation
    return { ms: performance.now() - started, outcome: "resolved" }
  } catch (error) {
    return { ms: performance.now() - started, outcome: "rejected", error }
  }
}

describe("journal reads and the writer lock (24019)", () => {
  it("reads and inspects a current mutable store through a snapshot with NO writer lock acquisition", async () => {
    const dir = await directory()
    const holders: string[] = []
    const exclusive: Exclusive = {
      async run<Result>(operation: () => Promise<Result>, options: { readonly holder: string }): Promise<Result> {
        holders.push(options.holder)
        return operation()
      },
    }
    const journal = mutableJournal(dir, { inject: { exclusive } })
    await expect(journal.append(frame("one"), 0)).resolves.toMatchObject({ appended: true, cursor: 1 })
    holders.length = 0

    await expect(Array.fromAsync(journal.read())).resolves.toEqual([{ cursor: 1, values: [frame("one")] }])
    await journal.checkpoint.inspect()
    await journal.checkpoint.load("any-identity")

    // Acceptance 4: read verbs read the journal through a snapshot without
    // the writer lock. Before: ["journal-read", "checkpoint-load", "checkpoint-load"].
    expect(holders).toEqual([])
  })

  it("returns a read beside a live writer holding the lock, well inside 10 s", async () => {
    const dir = await directory()
    const journal = mutableJournal(dir)
    await journal.append(frame("one"), 0)
    const release = await heldBy(dir, "queue-run pass")
    try {
      const read = await timed(Array.fromAsync(journal.read()))
      expect(read.outcome).toBe("resolved")
      expect(read.ms).toBeLessThan(10_000)
    } finally {
      await release()
    }
  })

  it("bounds a read that must wait for maintenance, refuses naming the holder pid and command, and logs one WARN row first", async () => {
    const dir = await directory()
    await mutableJournal(dir).append(frame("one"), 0)
    // An interrupted v2 maintenance: the one state where a read genuinely
    // needs the writer (VACUUM) before it can proceed.
    {
      using database = new Database(join(dir, "journal.sqlite"), { readwrite: true, strict: true })
      database.run("UPDATE journal_metadata SET value = '1' WHERE key = 'maintenance_pending'")
    }
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "warn" }, { write: (event: LogEvent) => events.push(event) }])
    const journal = mutableJournal(dir, { lock: { timeoutMs: 300 }, inject: { log } })
    const release = await heldBy(dir, "queue-run pass")
    try {
      const read = await timed(Array.fromAsync(journal.read()))
      expect(read.outcome).toBe("rejected")
      expect(read.ms).toBeLessThan(5_000)
      const message = read.error instanceof Error ? read.error.message : String(read.error)
      expect(message).toMatch(/held by pid:\d+ \(queue-run pass\)/u)
      expect(message).toMatch(/journal-read maintenance/u)

      const waiting = events.filter(
        (event): event is Extract<LogEvent, { kind: "log" }> =>
          event.kind === "log" && event.level === "warn" && /waiting up to \d+ms/u.test(event.message),
      )
      expect(waiting).toHaveLength(1)
      expect(waiting[0]?.props).toMatchObject({
        holder: "journal-read maintenance",
        boundMs: 300,
        heldBy: { holder: "queue-run pass", pid: process.pid },
      })
    } finally {
      await release()
    }
  })

  it("defaults the read-side wait to 10 s, not the writer's 30 s", { timeout: 20_000 }, async () => {
    const dir = await directory()
    await mutableJournal(dir).append(frame("one"), 0)
    {
      using database = new Database(join(dir, "journal.sqlite"), { readwrite: true, strict: true })
      database.run("UPDATE journal_metadata SET value = '1' WHERE key = 'maintenance_pending'")
    }
    const journal = mutableJournal(dir)
    const release = await heldBy(dir, "queue-run pass")
    try {
      const read = await timed(Array.fromAsync(journal.read()))
      expect(read.outcome).toBe("rejected")
      expect(read.ms).toBeGreaterThanOrEqual(9_000)
      expect(read.ms).toBeLessThan(15_000)
    } finally {
      await release()
    }
  })

  it(
    "a wait honours an AbortSignal: it rejects at once with a one-line reason naming the holder",
    { timeout: 5_000 },
    async () => {
      const dir = await directory()
      const release = await heldBy(dir, "queue-run pass")
      try {
        const controller = new AbortController()
        const contender = createExclusive(dir, { timeoutMs: 30_000, signal: controller.signal }).run(
          () => Promise.resolve("acquired"),
          { holder: "journal-append" },
        )
        await Bun.sleep(100)
        controller.abort(new Error("stopped by SIGTERM"))
        const wait = await timed(contender)
        expect(wait.outcome).toBe("rejected")
        expect(wait.ms).toBeLessThan(1_000)
        const message = wait.error instanceof Error ? wait.error.message : String(wait.error)
        expect(message.split("\n")).toHaveLength(1)
        expect(message).toMatch(
          /^yrd: journal-append stopped waiting for the writer lock held by pid:\d+ \(queue-run pass\): stopped by SIGTERM/u,
        )
      } finally {
        await release()
      }
    },
  )
})
