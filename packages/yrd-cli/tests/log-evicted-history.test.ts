/**
 * @failure `yrd log` dies with an unhandled RangeError once the journal's retention window has evicted the frames its cursor-0 readers start from.
 * @level l2
 * @consumer @yrd/cli log coverage probe, `log --all` history replay
 *
 * WHY THIS FILE EXISTS. Journal retention
 * (`@yrd/core/21584-yrd-performance/22245`) bounds history by dropping a
 * contiguous prefix of already-checkpointed frames, and the journal refuses a
 * replay that starts below the resulting floor rather than hand back a history
 * with a hole in it. Two `yrd log` readers start at cursor 0: the coverage
 * probe behind every invocation, and the full replay behind `--all`. Retention
 * therefore had to ship opt-in, because arming it would have bounded the
 * journal and broken `yrd log` in the same commit.
 *
 * WHAT IS PINNED. Not "eviction happens" — that is
 * `yrd-persistence/tests/retention.test.ts`. This file pins the READER
 * contract, on a real SQLite journal that has actually evicted: the probe
 * answers from the floor instead of throwing, `--all` refuses in the product's
 * own typed vocabulary while naming where coverage begins, and neither of those
 * disturbs the checkpoint-backed live state that ordinary `log` prints. The
 * fixture asserts its own eviction first, so a window that stopped biting fails
 * the setup rather than passing the contract vacuously.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Journal } from "@yrd/core"
import { createJournal } from "@yrd/persistence"
import { appendHistory, createCliApp, ids, runLog, type CliApp } from "./support/log-app.ts"

/** A SQLite version the journal accepts without probing the host's. */
const SAFE_SQLITE = "3.53.0"
/** Small enough that a fixture of a few dozen commands outgrows it. */
const KEEP_FRAMES = 4
const SUBMISSIONS = 24

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-log-evicted-"))
  roots.push(root)
  return root
}

function journalAt(dir: string, retention?: Readonly<{ keepFrames: number }>): Journal<unknown> {
  return createJournal({
    dir,
    ...(retention === undefined ? {} : { retention }),
    inject: { sqliteVersion: SAFE_SQLITE },
  } as unknown as Parameters<typeof createJournal>[0]) as unknown as Journal<unknown>
}

function evictedThrough(app: CliApp): number {
  return app.retentionDiagnostics().journal?.evictedThrough ?? 0
}

/**
 * A journal carrying `SUBMISSIONS` commands, reopened so the second app folds
 * the whole history and checkpoints it at head — the moment eviction runs.
 *
 * Reopening is what makes the fixture deterministic. Within one session
 * checkpoints are debt-driven and merge whenever the cadence decides; app open
 * always saves one, so the eviction happens at a known point and the returned
 * app is the one a user would be holding afterwards.
 */
async function evictedApp(retention?: Readonly<{ keepFrames: number }>): Promise<CliApp> {
  const dir = await directory()
  const seed = await createCliApp(journalAt(dir, retention), ids())
  await appendHistory(seed, "seed", SUBMISSIONS)
  await seed.close()
  // A fresh id sequence would re-mint the ids the seed already used; continuing
  // past them keeps every command in the reopened session distinct.
  return createCliApp(journalAt(dir, retention), ids(10_000))
}

describe("yrd log against an evicted journal", () => {
  it("answers the coverage probe from the retention floor instead of throwing", async () => {
    await using app = await evictedApp({ keepFrames: KEEP_FRAMES })

    // The setup's own assertion: without a floor above zero this test would
    // pass against a reader that still starts at cursor 0.
    expect(evictedThrough(app)).toBeGreaterThan(0)

    const result = await runLog(app, "log", "--json")
    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
  })

  it("tells `--all` where history coverage begins rather than failing as unexpected", async () => {
    await using app = await evictedApp({ keepFrames: KEEP_FRAMES })
    const floor = evictedThrough(app)
    expect(floor).toBeGreaterThan(0)

    const result = await runLog(app, "log", "--all", "--json")

    // A refusal, not an infrastructure surprise: exit 1 and the product's own
    // failure vocabulary. An unhandled RangeError arrives here as
    // `unexpected`/`infrastructure` and exit 3.
    expect(result.code).toBe(1)
    const failure = (JSON.parse(result.stderr) as { failure: { code: string; kind: string; message: string } }).failure
    expect(failure.code).toBe("history-evicted")
    expect(failure.kind).toBe("refusal")
    expect(failure.message).toContain(`history coverage begins at cursor ${String(floor + 1)}`)
    expect(failure.message).toContain(`${String(floor)} frames evicted`)
  })

  it("leaves the checkpoint-backed live state whole", async () => {
    await using app = await evictedApp({ keepFrames: KEEP_FRAMES })
    expect(evictedThrough(app)).toBeGreaterThan(0)

    // Eviction drops only frames the checkpoint already folded in, so the state
    // an ordinary `log` prints must be untouched by it.
    await app.refresh()
    expect(Object.keys(app.state().bays.submits)).toHaveLength(SUBMISSIONS)
  })

  it("replays the whole history for `--all` while the window has not yet bitten", async () => {
    // The contrast that gives the refusal its meaning: identical fixture, a
    // window too wide to evict anything, and `--all` answers normally.
    await using app = await evictedApp({ keepFrames: 10_000 })
    expect(evictedThrough(app)).toBe(0)

    const result = await runLog(app, "log", "--all", "--json")
    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
  })
})
