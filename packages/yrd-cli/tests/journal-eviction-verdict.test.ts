/**
 * @failure One journal eviction gets two verdicts — a foreground command warns and carries on while the background settlement drain it spawns treats the same permanent fact as fatal, forever.
 * @level l2
 * @consumer @yrd/cli background settlement, @yrd/persistence journal reader
 *
 * The incident this pins. `history_evicted_through` on the /hh journal has been
 * 27609 since 2026-08-22, permanently and by design: the checkpoint refusal was
 * closed by declaring the production identity and leaving the journal read-only
 * and unrewritten. Between 2026-08-24 03:3x and 06:5x PDT, five occurrences
 * across `@dev/6`, `@dev/13` and `@ci` reported the SAME cursor through the
 * background channel — "background work from a previous Yrd command for @dev/6
 * failed …: yrd: journal history through cursor 27609 was evicted by the
 * retention window" — while `pr create` exited 0 and `pr submit` only warned.
 *
 * Why the background verdict was the wrong one. Nothing a caller does brings an
 * evicted frame back, so a path that calls the eviction fatal fails identically
 * on every retry, on every future generation, forever. Worse than the evicted
 * range: `journal.read` refuses BEFORE yielding a batch, so the cursor never
 * advances, so the perfectly readable facts ABOVE the floor never settle
 * either. That is the dropped work these rows fence.
 *
 * Both paths read ONE fixture here on purpose. A verdict that lives in two
 * files drifts back apart; the point of `classifyJournalHistory` is that the
 * reader's refusal and the drain's repair are two readings of one fact.
 */
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { Command, classifyJournalHistory, event, type Journal, type JournalHistoryCoverage } from "@yrd/core"
import { createJournal, createReadOnlyJournal, type JournalOptions } from "@yrd/persistence"
import { afterEach, describe, expect, it } from "vitest"

import {
  drainSettlements,
  readSettlementCursor,
  registerSettlementCursor,
  settlementCursorPath,
  type YrdSettlementHook,
  type YrdSettlementTarget,
} from "../src/settlement.ts"

const SAFE_SQLITE = "3.53.0"
/** Frames kept by the window. Small enough that a 120-frame workload evicts most of it. */
const KEEP_FRAMES = 20
const PROP_KEY = "host-request"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-eviction-verdict-"))
  roots.push(root)
  return root
}

function uuid(label: string): string {
  const hex = createHash("sha256").update(label).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** A frame the real reader accepts, sized so one frame occupies about one page. */
function frame(label: string, events: readonly Readonly<{ name: string; data: unknown }>[]): unknown {
  const command = { id: uuid(`command:${label}`), op: "test/evict" }
  return {
    cause: { id: uuid(`cause:${label}`), commandId: command.id, op: command.op, commandHash: Command.hash(command) },
    command,
    events: events.map((draft, index) => ({
      id: uuid(`event:${label}:${index}`),
      ts: "2026-08-24T12:00:00.000Z",
      ...event(draft.name, draft.data as never),
    })),
  }
}

/** Bulk that pushes the retention window forward; carries no prop any hook owns. */
function filler(index: number): unknown {
  return frame(`filler-${String(index)}`, [{ name: "test/recorded", data: { text: "x".repeat(3800) } }])
}

/** A terminal delivery fact the settlement drain must hand to its hook. */
function integrated(label: string): unknown {
  return frame(label, [{ name: "pr/integrated", data: { props: { [PROP_KEY]: label } } }])
}

function testJournal(dir: string, retention: JournalOptions["retention"]): Journal<unknown> {
  return createJournal({
    dir,
    retention,
    inject: { sqliteVersion: SAFE_SQLITE },
  } as unknown as Parameters<typeof createJournal>[0])
}

function readOnlyJournal(dir: string): Journal<unknown> {
  return createReadOnlyJournal({
    dir,
    inject: { sqliteVersion: SAFE_SQLITE },
  } as unknown as Parameters<typeof createReadOnlyJournal>[0])
}

function storedEvictedThrough(dir: string): number {
  using database = new Database(join(dir, "journal.sqlite"), { readonly: true, strict: true })
  const row = database
    .query<{ value: string }, [string]>("SELECT value FROM journal_metadata WHERE key = ?")
    .get("history_evicted_through")
  return row === null ? 0 : Number(row.value)
}

/**
 * One journal whose retention window has overtaken part of its own history,
 * with the surviving tail carrying terminal facts a settlement hook owns.
 *
 * Built the way `retention.test.ts` builds one — repeated checkpoints at the
 * same head, so the exclusive maintenance pass actually runs — because a
 * hand-stamped `history_evicted_through` would prove only that the code reads
 * a number, not that a real eviction produces this state.
 */
async function evictedJournal(): Promise<
  Readonly<{ dir: string; evictedThrough: number; head: number; terminals: readonly string[] }>
> {
  const dir = await directory()
  const journal = testJournal(dir, { keepFrames: KEEP_FRAMES })
  const terminals = ["integrated-first", "integrated-second"] as const
  const frames = [...Array.from({ length: 120 }, (_, index) => filler(index)), ...terminals.map(integrated)]

  let cursor = 0
  for (const value of frames) {
    const appended = await journal.append(value, cursor)
    expect(appended.appended).toBe(true)
    cursor = appended.cursor
  }
  for (let round = 0; round < 4; round += 1) {
    await journal.checkpoint?.save?.({ identity: `evicted-${String(round)}`, cursor, value: { round } })
  }

  const evictedThrough = storedEvictedThrough(dir)
  // The fixture is worthless unless retention actually bit AND left the
  // terminal facts above the floor — assert the shape, never assume it.
  expect(evictedThrough).toBeGreaterThan(0)
  expect(evictedThrough).toBeLessThan(cursor - terminals.length)
  return { dir, evictedThrough, head: cursor, terminals: [...terminals] }
}

type RecordingHook = YrdSettlementHook & Readonly<{ settled: YrdSettlementTarget[] }>

function recordingHook(owner = "@seat/6"): RecordingHook {
  const settled: YrdSettlementTarget[] = []
  return {
    key: PROP_KEY,
    owner,
    settle: (targets) => {
      settled.push(...targets)
      return Promise.resolve()
    },
    get settled() {
      return settled
    },
  } as RecordingHook
}

function drainOptions(dir: string, hook: YrdSettlementHook, warnings: string[]) {
  return {
    repository: {
      stateDir: dir,
      repo: dir,
      worktree: dir,
      gitDir: dir,
      baysRoot: dir,
      defaultBase: "main",
    },
    hook,
    stateDir: dir,
    journal: readOnlyJournal(dir),
    retries: 0,
    warn: (text: string) => warnings.push(text),
  }
}

describe("journal history coverage", () => {
  it("classifies an (evictedThrough, from) pair once, for both the reader and the drain to consult", () => {
    expect(classifyJournalHistory(0, 0)).toEqual({ kind: "covered", evictedThrough: 0, from: 0 })
    expect(classifyJournalHistory(27609, 27609)).toEqual({ kind: "covered", evictedThrough: 27609, from: 27609 })
    expect(classifyJournalHistory(27609, 30000)).toEqual({ kind: "covered", evictedThrough: 27609, from: 30000 })
    expect(classifyJournalHistory(27609, 27608)).toEqual({ kind: "below-floor", evictedThrough: 27609, from: 27608 })
    expect(classifyJournalHistory(27609, 0)).toEqual({ kind: "below-floor", evictedThrough: 27609, from: 0 })
  })

  it("puts the boundary at the floor itself, because `from` is exclusive like Journal.read's `after`", () => {
    // Reading AT the floor asks for the first frame that survived, which is
    // exactly where a newly registered worker starts. Off by one here and every
    // fresh worker would refuse on its first pass.
    const describeCoverage = (coverage: JournalHistoryCoverage): string => {
      switch (coverage.kind) {
        case "covered":
          return "covered"
        case "below-floor":
          return `short by ${coverage.evictedThrough - coverage.from}`
      }
    }
    expect(describeCoverage(classifyJournalHistory(100, 100))).toBe("covered")
    expect(describeCoverage(classifyJournalHistory(100, 99))).toBe("short by 1")
  })
})

describe("one eviction, one verdict", () => {
  it("refuses to SERVE a below-floor range, because a short history with no hole marker is the worse error", async () => {
    const { dir, evictedThrough } = await evictedJournal()
    const reader = readOnlyJournal(dir)

    const drainFrom = async (after: number): Promise<number[]> => {
      const cursors: number[] = []
      for await (const batch of reader.read(after)) cursors.push(batch.cursor)
      return cursors
    }

    await expect(drainFrom(evictedThrough - 1)).rejects.toThrow(/evicted by the retention window/u)
    // Positive control: the same reader, one cursor higher, serves normally —
    // so the rejection above is the floor talking and not a broken fixture.
    expect((await drainFrom(evictedThrough)).length).toBeGreaterThan(0)
  })

  it("does NOT hard-fail the background drain on the same fact: it resumes at the floor and keeps settling", async () => {
    const { dir, evictedThrough, head, terminals } = await evictedJournal()
    const hook = recordingHook()
    const warnings: string[] = []
    const cursorPath = settlementCursorPath(dir, hook.owner)
    // Retention overtook a live worker: its cursor was legitimate when written
    // and now sits under the floor. This is the ONLY state the bug needed.
    await registerSettlementCursor(cursorPath, hook.owner, evictedThrough - 1)

    const failure = await drainSettlements(drainOptions(dir, hook, warnings))

    expect(failure).toBeUndefined()
    // The deliverable the background path OWNS: every terminal fact above the
    // floor reached the hook. Before this fix none of them did, ever.
    expect(hook.settled.map((target) => target.value)).toEqual([...terminals])
    expect(await readSettlementCursor(cursorPath, hook.owner)).toBe(head)
  })

  it("names the span it can never settle, so a repair that loses work is not a silent one", async () => {
    const { dir, evictedThrough } = await evictedJournal()
    const hook = recordingHook()
    const warnings: string[] = []
    await registerSettlementCursor(settlementCursorPath(dir, hook.owner), hook.owner, 0)

    await drainSettlements(drainOptions(dir, hook, warnings))

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`resumed at cursor ${String(evictedThrough)} instead of 0`)
    expect(warnings[0]).toContain("can never be settled by anyone")
    expect(warnings[0]).toContain(hook.owner as string)
  })

  it("stays repaired: the second drain neither fails nor repeats the warning", async () => {
    const { dir, evictedThrough, head } = await evictedJournal()
    const hook = recordingHook()
    const warnings: string[] = []
    await registerSettlementCursor(settlementCursorPath(dir, hook.owner), hook.owner, evictedThrough - 1)

    expect(await drainSettlements(drainOptions(dir, hook, warnings))).toBeUndefined()
    const afterFirst = warnings.length
    // The wedge under test was that EVERY future drain failed identically. One
    // pass proves the repair; a second proves it was durable rather than a
    // per-pass workaround that re-announces itself forever.
    expect(await drainSettlements(drainOptions(dir, hook, warnings))).toBeUndefined()

    expect(warnings).toHaveLength(afterFirst)
    expect(await readSettlementCursor(settlementCursorPath(dir, hook.owner), hook.owner)).toBe(head)
  })

  it("leaves a covered cursor exactly where it was, so the repair cannot skip live work", async () => {
    const { dir, head } = await evictedJournal()
    const hook = recordingHook()
    const warnings: string[] = []
    const cursorPath = settlementCursorPath(dir, hook.owner)
    // One frame short of the head and well above the floor: a healthy resume.
    // A repair that clamped unconditionally would swallow that last frame.
    await registerSettlementCursor(cursorPath, hook.owner, head - 1)

    expect(await drainSettlements(drainOptions(dir, hook, warnings))).toBeUndefined()

    expect(warnings).toEqual([])
    expect(hook.settled.map((target) => target.value)).toEqual(["integrated-second"])
    expect(await readSettlementCursor(cursorPath, hook.owner)).toBe(head)
  })
})
