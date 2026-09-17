/**
 * @failure  The declared health probe forms its own opinion of the queue, or
 *           collapses "nothing has started" and "the document is broken" into
 *           one answer — so a supervisor pages for a service nobody started, or
 *           reads a writer defect as an ordinary state and nobody ever fixes it
 *           (@i/10-yrd/24395; M7's second-opinion objection, 2026-09-03).
 * @level    l1 (a directory and a file; no Git, no network, no queue)
 * @consumer the supervisor, which runs this on its own tick and gates a page on
 *           the state and the exit code agreeing
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import {
  believableHealthDocument,
  HEARTBEAT_GRACE_MS,
  HEARTBEAT_INTERVAL_MS,
  QUEUE_HEALTH_DOCUMENT,
  QUEUE_HEALTH_SCHEMA,
  roundHealthDocument,
  type QueueHealthDocument,
} from "@yrd/queue-core"
import { queueHealthCommand, readQueueHealth, SERVICE } from "../src/queue-health.ts"
import type { YrdCliIO } from "../src/types.ts"

const NOW = new Date("2026-09-11T12:00:00.000Z")

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

function workdir(): string {
  const root = mkdtempSync(join(tmpdir(), "yrd-health-"))
  roots.push(root)
  return root
}

function capture(): Readonly<{ io: YrdCliIO; stdout: () => string }> {
  let stdout = ""
  return {
    io: {
      color: false,
      stdout(text) {
        stdout += text
      },
      stderr() {},
    },
    stdout: () => stdout,
  }
}

describe("the declared health probe", () => {
  it("prints what the last round wrote, and exits on its state", async () => {
    const dir = workdir()
    const written = roundHealthDocument(SERVICE, undefined, 120_000, NOW)
    writeFileSync(join(dir, QUEUE_HEALTH_DOCUMENT), `${JSON.stringify(written, undefined, 2)}\n`)
    const run = capture()
    expect(await queueHealthCommand(dir, SERVICE, run.io, NOW)).toBe(0)
    expect(JSON.parse(run.stdout())).toEqual(written)
  })

  it("reports a line a stuck change stopped as unhealthy-and-running, exit 2", async () => {
    const dir = workdir()
    const written = roundHealthDocument(
      SERVICE,
      {
        at: NOW,
        by: "yrd",
        cause: "stuck",
        change: { branch: "task/one", head: "a".repeat(40) },
        kind: "paused",
        reason: "the code host answered 504 during setup",
        sha: "b".repeat(40),
      },
      240_000,
      NOW,
    )
    writeFileSync(join(dir, QUEUE_HEALTH_DOCUMENT), JSON.stringify(written))
    const run = capture()
    // unhealthy + running is the pair the supervisor pages on WITHOUT a restart.
    expect(await queueHealthCommand(dir, SERVICE, run.io, NOW)).toBe(2)
    expect(JSON.parse(run.stdout())).toMatchObject({ state: "unhealthy", verdict: { kind: "running" } })
  })

  // The two failure modes must stay distinguishable: they have different cures
  // and only one of them is a defect. Collapsing them is the silent-error shape.
  it("says ABSENT when no round has written one, exit 1", async () => {
    const run = capture()
    const dir = workdir()
    expect(await queueHealthCommand(dir, SERVICE, run.io, NOW)).toBe(1)
    const printed = JSON.parse(run.stdout()) as Record<string, unknown>
    expect(printed).toMatchObject({ state: "absent", verdict: { kind: "stopped" } })
    // NO `error`: hab-service-health/2 refuses the whole document if `absent`
    // carries one, which is how the first live probe paged health-not-measured
    // about a service that was merely not running yet.
    expect(printed.error).toBeUndefined()
    // It still names the path it looked in — a probe that says "nothing here"
    // without saying where it looked cannot be argued with. That explanation
    // moved to `facts`, which the supervisor's parser carries through.
    expect(String((printed.facts as Record<string, unknown>).why)).toContain(QUEUE_HEALTH_DOCUMENT)
  })

  it("says UNKNOWN and quotes the text when the document is broken, exit 3", async () => {
    const dir = workdir()
    writeFileSync(join(dir, QUEUE_HEALTH_DOCUMENT), '{"schema":"hab-servi')
    const run = capture()
    expect(await queueHealthCommand(dir, SERVICE, run.io, NOW)).toBe(3)
    expect(JSON.parse(run.stdout())).toMatchObject({
      state: "unknown",
      verdict: { kind: "unknown", observed: '{"schema":"hab-servi', reason: "unparsed" },
    })
  })

  // Negative control on the same distinction: valid JSON that is not OUR
  // document is a writer defect too, not an absent service.
  it("treats someone else's JSON as unreadable, never as absent", async () => {
    const dir = workdir()
    writeFileSync(join(dir, QUEUE_HEALTH_DOCUMENT), '{"status":"ok"}')
    expect((await readQueueHealth(dir, SERVICE)).state).toBe("unknown")
  })

  it("speaks the supervisor's schema, so the document is read rather than guessed at", async () => {
    const dir = workdir()
    expect((await readQueueHealth(dir, SERVICE)).schema).toBe(QUEUE_HEALTH_SCHEMA)
    expect(QUEUE_HEALTH_SCHEMA).toBe("hab-service-health/2")
  })
})

/**
 * @failure  The writer stops writing, and the probe keeps printing its last
 *           `healthy` — so the supervisor never pages and a dead queue reads
 *           exactly like a working one (@cto follow-up F1, 2026-09-11). The
 *           end-to-end half: the probe must apply the document's own deadline,
 *           one heartbeat plus grace from the write, not just possess it.
 * @level    l1
 */
describe("the probe applies the document's deadline", () => {
  it("prints OVERDUE and exits 2 when the loop stopped writing", async () => {
    const dir = workdir()
    const written = roundHealthDocument(SERVICE, undefined, 120_000, NOW)
    writeFileSync(join(dir, QUEUE_HEALTH_DOCUMENT), JSON.stringify(written))
    // A minute past one heartbeat plus grace from the write: the writer has stopped writing.
    const late = new Date(NOW.getTime() + HEARTBEAT_INTERVAL_MS + HEARTBEAT_GRACE_MS + 60_000)
    const run = capture()
    expect(await queueHealthCommand(dir, SERVICE, run.io, late)).toBe(2)
    const printed = JSON.parse(run.stdout()) as { state: string; error: { code: string; cause: string } }
    expect(printed.state).toBe("unhealthy")
    expect(printed.error.code).toBe("queue-round-overdue")
    expect(printed.error.cause).toContain(NOW.toISOString())
  })

  // The control: through the deadline the stored verdict stands unaltered, so
  // the expiry cannot be mistaken for a probe that distrusts every document.
  it("prints the stored verdict unchanged while the deadline holds", async () => {
    const dir = workdir()
    const written = roundHealthDocument(SERVICE, undefined, 120_000, NOW)
    writeFileSync(join(dir, QUEUE_HEALTH_DOCUMENT), JSON.stringify(written))
    const run = capture()
    const deadline = new Date(NOW.getTime() + HEARTBEAT_INTERVAL_MS + HEARTBEAT_GRACE_MS)
    expect(await queueHealthCommand(dir, SERVICE, run.io, deadline)).toBe(0)
    expect(JSON.parse(run.stdout())).toEqual(written)
  })

  /**
   * @failure  Past the deadline the probe formed a SECOND OPINION: a process
   *           census over the round worktrees and a bare `kill -0` on the pid a
   *           journal names. That is a second liveness reader beside the
   *           supervisor's, and its EPERM means dead where hab's means alive
   *           (@i/4-supervision/24523 D1, @cto amendment 2: deleted, not demoted
   *           to text). Overdue now means the writer stopped writing, and the
   *           supervisor alone asks whether that writer lives.
   * @level    l1 (a directory and three files)
   * @consumer hab, which gates a start on the writer's identity and relays this
   *           verdict as the page
   */
  it("relays the stored overdue verdict unchanged, consulting no process census and no kill -0", async () => {
    const dir = workdir()
    const id = "q-20260911T120100000Z-11112222"
    // Everything a second opinion would reach for: a round worktree, and a
    // journal whose header names a runner that is alive — this very process.
    mkdirSync(join(dir, "worktrees", id), { recursive: true })
    mkdirSync(join(dir, "logs"), { recursive: true })
    writeFileSync(
      join(dir, "logs", `${id}.jsonl`),
      `${JSON.stringify({ kind: "run", run: id, at: NOW.toISOString(), target: "main", pid: process.pid })}\n` +
        `${JSON.stringify({ kind: "queue", run: id, at: NOW.toISOString(), queue: "main on origin" })}\n`,
    )
    // Written out rather than built, so the deadline is this test's and not a builder's formula.
    const stored: QueueHealthDocument = {
      schema: QUEUE_HEALTH_SCHEMA,
      service: SERVICE,
      state: "healthy",
      verdict: { kind: "running" },
      facts: {
        writtenAt: NOW.toISOString(),
        staleAfter: new Date(NOW.getTime() + 30_000).toISOString(),
        stopped: null,
      },
    }
    writeFileSync(join(dir, QUEUE_HEALTH_DOCUMENT), JSON.stringify(stored))
    const late = new Date(NOW.getTime() + 90_000)
    using kill = vi.spyOn(process, "kill")
    // The probe's answer IS the document's own deadline applied to it: nothing
    // appended to the cause, no resolution swapped, no state re-derived.
    expect(await readQueueHealth(dir, SERVICE, late)).toEqual(believableHealthDocument(stored, late))
    expect(kill).not.toHaveBeenCalled()
  })
})
