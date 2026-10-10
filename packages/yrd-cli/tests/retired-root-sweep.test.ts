/**
 * @failure The retired-root sweep never runs, runs on the wrong sibling, or
 *   reports a leftover as live — so a stale client keeps writing the pre-27065
 *   `%23` root with nobody paged (28481 layer 3, @cto 6eb10b57). The sweep must
 *   read the sibling of the QUEUE ROOT the service holds, keep reporting a
 *   post-cutover write inside the clear window, and go quiet about one that has
 *   aged past it or never happened after the cutover. It must also never claim
 *   the clearing edge on a census it could not complete: a fresh write inside an
 *   unreadable subtree is invisible, and a clear there would withdraw a standing
 *   incident while the fault is still live (@dev/2 review).
 * @level l1 (a filesystem predicate over a temporary tree)
 * @consumer the yrd service tick, before it hands the record to `notify:`
 * @testonly none: the sweep helpers are production API; this test only exercises them
 */
import { chmodSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { RETIRED_ROOT_CUTOVER, retiredRootBeside, retiredRootSweep } from "../src/retired-root.ts"
import type { RetiredRootReading } from "../src/queue-core-commands.ts"
import {
  retiredRootObservation,
  retiredRootUnreadableKey,
  sayRetiredRoot,
  sweepRetiredRoot,
} from "../src/queue-core-commands.ts"

const CUTOVER_MS = Date.parse(RETIRED_ROOT_CUTOVER)
const HOUR = 60 * 60 * 1000

/** A queue root named the way the live service's `workdir` is, plus its retired sibling. */
function rootPair(): Readonly<{ workdir: string; retired: string }> {
  const host = mkdtempSync(join(tmpdir(), "yrd-retired-sweep-"))
  const workdir = join(host, "github.com", "beorn", "hh-dev~main")
  const retired = retiredRootBeside(workdir)
  if (retired === undefined) throw new Error("the synthetic queue root carried no tilde boundary")
  mkdirSync(retired, { recursive: true })
  return { workdir, retired }
}

/** The page branch of a sweep result, failing loudly when it is a withheld census or nothing. */
function page(
  reading: ReturnType<typeof sweepRetiredRoot>,
): Extract<NonNullable<ReturnType<typeof sweepRetiredRoot>>, { kind: "page" }> {
  if (reading === undefined || reading.kind !== "page") {
    throw new Error(`expected a page reading, got ${JSON.stringify(reading)}`)
  }
  return reading
}

function writeAt(path: string, ms: number, body = "x\n"): void {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, body)
  utimesSync(path, new Date(ms), new Date(ms))
}

describe("the retired-root sweep", () => {
  it("names the retired sibling of a queue root, and nothing for a plain path", () => {
    expect(retiredRootBeside("/w/github.com/beorn/hh-dev~main")).toBe("/w/github.com/beorn/hh-dev%23main")
    expect(retiredRootBeside("/w/github.com/beorn/hh-dev~feature~x")).toBe("/w/github.com/beorn/hh-dev~feature%23x")
    expect(retiredRootBeside("/w/not-a-queue-root")).toBeUndefined()
  })

  it("reports a live write with its newest file, instant, and round-log names", () => {
    const { workdir, retired } = rootPair()
    const lock = join(retired, "repo.lock")
    writeAt(lock, Date.now() - 60_000, "")
    writeAt(
      join(retired, "logs", "environments", "luna2-27822-held-line", "q-1", "logs", "setup.log"),
      Date.now() - 120_000,
    )

    const reading = page(sweepRetiredRoot(workdir))
    expect(reading.active).toBe(true)
    expect(reading.notice.record).toBe("retired-root-written")
    expect(reading.notice.root).toBe(retired)
    expect(reading.notice.address).toBe("hh-dev%23main")
    expect(reading.notice.path).toBe(lock)
    expect(reading.notice.cutover).toBe(RETIRED_ROOT_CUTOVER)
    expect(reading.notice.branches).toEqual(["luna2-27822-held-line"])
    expect(Number.isFinite(Date.parse(reading.notice.writtenAt))).toBe(true)
  })

  it("turns the record into the clearing edge once the newest write ages past a day", () => {
    const { workdir, retired } = rootPair()
    writeAt(join(retired, "repo.lock"), Date.now() - 25 * HOUR, "")
    const reading = page(sweepRetiredRoot(workdir))
    expect(reading.active).toBe(false)
    expect(reading.notice.active).toBe(false)
  })

  it("stays silent about a root written only before the cutover, and about an absent sibling", () => {
    const { workdir, retired } = rootPair()
    writeAt(join(retired, "repo.lock"), CUTOVER_MS - 1000, "")
    expect(sweepRetiredRoot(workdir)).toBeUndefined()

    const bare = mkdtempSync(join(tmpdir(), "yrd-retired-sweep-"))
    expect(sweepRetiredRoot(join(bare, "hh-dev~main"))).toBeUndefined()
  })

  it("cannot certify quiet when a subtree of the root could not be read", () => {
    if (process.getuid?.() === 0) return // chmod cannot deny the superuser
    const { workdir, retired } = rootPair()
    // A 25h-old lock is the only READABLE write, so a walk that ignores the
    // unreadable child reports the clearing edge while a fresh write sits in it.
    writeAt(join(retired, "repo.lock"), Date.now() - 25 * HOUR, "")
    const hidden = join(retired, "logs", "environments", "luna2-27822-held-line")
    writeAt(join(hidden, "q-1", "logs", "setup.log"), Date.now() - 60_000)
    chmodSync(hidden, 0o000)
    try {
      const census = retiredRootSweep(retired)
      expect(census.unreadable).toContain(hidden)
      expect(census.newest?.path).toBe(join(retired, "repo.lock"))
      const reading = sweepRetiredRoot(workdir)
      expect(reading?.kind).toBe("withheld")
      if (reading !== undefined && reading.kind === "withheld") expect(reading.unreadable).toContain(hidden)
    } finally {
      chmodSync(hidden, 0o755)
    }
  })

  it("reports the live write and the clear once that same census is complete", () => {
    const { workdir, retired } = rootPair()
    writeAt(
      join(retired, "logs", "environments", "luna2-27822-held-line", "q-1", "logs", "setup.log"),
      Date.now() - 60_000,
    )
    writeAt(join(retired, "repo.lock"), Date.now() - 25 * HOUR, "")
    const fresh = page(sweepRetiredRoot(workdir))
    expect(fresh.active).toBe(true)
    expect(fresh.notice.path).toContain("setup.log")
    expect(fresh.unreadable).toEqual([])

    // Now let only the old lock stand and the census is complete: the clear goes.
    const { workdir: other, retired: otherRoot } = rootPair()
    writeAt(join(otherRoot, "repo.lock"), Date.now() - 25 * HOUR, "")
    const cleared = page(sweepRetiredRoot(other))
    expect(cleared.active).toBe(false)
  })

  it("withholds a root-wide unreadable census instead of reporting no condition", () => {
    if (process.getuid?.() === 0) return
    const { workdir, retired } = rootPair()
    writeAt(join(retired, "repo.lock"), Date.now() - 60_000, "")
    chmodSync(retired, 0o000)
    try {
      const reading = sweepRetiredRoot(workdir)
      expect(reading?.kind).toBe("withheld")
      if (reading !== undefined && reading.kind === "withheld") expect(reading.unreadable).toContain(retired)
    } finally {
      chmodSync(retired, 0o755)
    }
  })

  it("keys an unreadable census so one shape is named once, not per tick", () => {
    const root = "/w/hh-dev%23main"
    const paths = ["/w/hh-dev%23main/logs", "/w/hh-dev%23main/x"]
    expect(retiredRootUnreadableKey(root, paths)).toBe(retiredRootUnreadableKey(root, [...paths].reverse()))
    expect(retiredRootUnreadableKey(root, paths)).not.toBe(retiredRootUnreadableKey(root, [paths[0] as string]))
    // A naming key is never mistaken for an observation key.
    expect(retiredRootUnreadableKey(root, paths).startsWith("unreadable")).toBe(true)
  })
})

describe("paging the retired root once per observation", () => {
  function reading(active: boolean, writtenAt: string): RetiredRootReading {
    return {
      kind: "page",
      unreadable: [],
      active,
      notice: {
        record: "retired-root-written",
        root: "/w/github.com/beorn/hh-dev%23main",
        address: "hh-dev%23main",
        path: "/w/github.com/beorn/hh-dev%23main/repo.lock",
        writtenAt,
        cutover: RETIRED_ROOT_CUTOVER,
        branches: ["luna2-27822-held-line"],
        active,
      },
    }
  }

  it("keys an observation by the page state and the newest write's instant", () => {
    expect(retiredRootObservation(reading(true, "2026-10-09T17:43:40.169Z"))).not.toBe(
      retiredRootObservation(reading(false, "2026-10-09T17:43:40.169Z")),
    )
    expect(retiredRootObservation(reading(true, "2026-10-09T17:43:40.169Z"))).not.toBe(
      retiredRootObservation(reading(true, "2026-10-09T18:00:00.000Z")),
    )
    expect(retiredRootObservation(reading(true, "2026-10-09T17:43:40.169Z"))).toBe(
      retiredRootObservation(reading(true, "2026-10-09T17:43:40.169Z")),
    )
  })

  it("does not restate the same observation, and remembers a new one it delivered", async () => {
    const first = reading(true, "2026-10-09T17:43:40.169Z")
    const second = reading(true, "2026-10-09T18:00:00.000Z")
    const told: string[] = []
    const tell = (each: RetiredRootReading) => {
      told.push(each.notice.writtenAt)
      return Promise.resolve(true)
    }
    let said = await sayRetiredRoot(undefined, first, tell)
    expect(said).toBe(retiredRootObservation(first))
    // A retry of the same observation is a no-op: the wire would upsert the row.
    said = await sayRetiredRoot(said, first, tell)
    expect(said).toBe(retiredRootObservation(first))
    // A later write is a new observation and goes out.
    said = await sayRetiredRoot(said, second, tell)
    expect(said).toBe(retiredRootObservation(second))
    expect(told).toEqual([first.notice.writtenAt, second.notice.writtenAt])
  })

  it("retries a failed delivery on the next tick instead of suppressing the incident", async () => {
    const live = reading(true, "2026-10-09T17:43:40.169Z")
    let attempts = 0
    const tell = () => {
      attempts += 1
      return Promise.resolve(attempts > 1)
    }
    const first = await sayRetiredRoot(undefined, live, tell)
    expect(first).toBeUndefined()
    const retried = await sayRetiredRoot(first, live, tell)
    expect(retried).toBe(retiredRootObservation(live))
    expect(attempts).toBe(2)
  })

  it("opens a new episode after a clear: live, clear, and a later write are three observations", async () => {
    const live = reading(true, "2026-10-09T17:43:40.169Z")
    const clear = reading(false, "2026-10-09T17:43:40.169Z")
    const again = reading(true, "2026-10-10T02:00:00.000Z")
    const seen: string[] = []
    const tell = (each: RetiredRootReading) => {
      seen.push(retiredRootObservation(each))
      return Promise.resolve(true)
    }
    const said = await sayRetiredRoot(undefined, live, tell)
    const cleared = await sayRetiredRoot(said, clear, tell)
    const reopened = await sayRetiredRoot(cleared, again, tell)
    expect(seen).toHaveLength(3)
    expect(new Set(seen).size).toBe(3)
    expect(new Set([said, cleared, reopened]).size).toBe(3)
  })
})
