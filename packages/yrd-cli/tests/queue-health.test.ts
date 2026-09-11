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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { QUEUE_HEALTH_DOCUMENT, QUEUE_HEALTH_SCHEMA, ROUND_BUDGET_MS, roundHealthDocument } from "@yrd/queue-core"
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
  it("prints what the last round wrote, and exits on its state", () => {
    const dir = workdir()
    const written = roundHealthDocument(SERVICE, {}, undefined, 120_000, NOW)
    writeFileSync(join(dir, QUEUE_HEALTH_DOCUMENT), `${JSON.stringify(written, undefined, 2)}\n`)
    const run = capture()
    expect(queueHealthCommand(dir, SERVICE, run.io, NOW)).toBe(0)
    expect(JSON.parse(run.stdout())).toEqual(written)
  })

  it("reports a stuck round as unhealthy-and-running, exit 2", () => {
    const dir = workdir()
    const streak = { key: "stuck-changes:task/one", reason: "the code host answered 504 during setup", consecutive: 2 }
    const written = roundHealthDocument(SERVICE, { stuck: { key: streak.key, reason: streak.reason } }, streak, 240_000, NOW)
    writeFileSync(join(dir, QUEUE_HEALTH_DOCUMENT), JSON.stringify(written))
    const run = capture()
    // unhealthy + running is the pair the supervisor pages on WITHOUT a restart.
    expect(queueHealthCommand(dir, SERVICE, run.io, NOW)).toBe(2)
    expect(JSON.parse(run.stdout())).toMatchObject({ state: "unhealthy", verdict: { kind: "running" } })
  })

  // The two failure modes must stay distinguishable: they have different cures
  // and only one of them is a defect. Collapsing them is the silent-error shape.
  it("says ABSENT when no round has written one, exit 1", () => {
    const run = capture()
    const dir = workdir()
    expect(queueHealthCommand(dir, SERVICE, run.io, NOW)).toBe(1)
    const printed = JSON.parse(run.stdout()) as Record<string, unknown>
    expect(printed).toMatchObject({ state: "absent", verdict: { kind: "stopped" } })
    // It names the path it looked in — a probe that says "nothing here" without
    // saying where it looked cannot be argued with.
    expect(String((printed.error as Record<string, unknown>).cause)).toContain(QUEUE_HEALTH_DOCUMENT)
  })

  it("says UNKNOWN and quotes the text when the document is broken, exit 3", () => {
    const dir = workdir()
    writeFileSync(join(dir, QUEUE_HEALTH_DOCUMENT), '{"schema":"hab-servi')
    const run = capture()
    expect(queueHealthCommand(dir, SERVICE, run.io, NOW)).toBe(3)
    expect(JSON.parse(run.stdout())).toMatchObject({
      state: "unknown",
      verdict: { kind: "unknown", observed: '{"schema":"hab-servi', reason: "unparsed" },
    })
  })

  // Negative control on the same distinction: valid JSON that is not OUR
  // document is a writer defect too, not an absent service.
  it("treats someone else's JSON as unreadable, never as absent", () => {
    const dir = workdir()
    writeFileSync(join(dir, QUEUE_HEALTH_DOCUMENT), '{"status":"ok"}')
    expect(readQueueHealth(dir, SERVICE).state).toBe("unknown")
  })

  it("speaks the supervisor's schema, so the document is read rather than guessed at", () => {
    const dir = workdir()
    expect(readQueueHealth(dir, SERVICE).schema).toBe(QUEUE_HEALTH_SCHEMA)
    expect(QUEUE_HEALTH_SCHEMA).toBe("hab-service-health/2")
  })
})

/**
 * @failure  A round hangs, the loop stops writing, and the probe keeps printing
 *           the last round's `healthy` — so the supervisor never pages and a
 *           dead queue reads exactly like a working one (@cto follow-up F1,
 *           2026-09-11). The end-to-end half: the probe must apply the
 *           document's own deadline, not just possess it.
 * @level    l1
 */
describe("the probe applies the document's deadline", () => {
  it("prints OVERDUE and exits 2 when the loop stopped writing", () => {
    const dir = workdir()
    const written = roundHealthDocument(SERVICE, {}, undefined, 120_000, NOW)
    writeFileSync(join(dir, QUEUE_HEALTH_DOCUMENT), JSON.stringify(written))
    // Long past the instant the loop itself declared its next round due by.
    const late = new Date(NOW.getTime() + 120_000 + ROUND_BUDGET_MS + 60_000)
    const run = capture()
    expect(queueHealthCommand(dir, SERVICE, run.io, late)).toBe(2)
    const printed = JSON.parse(run.stdout()) as { state: string; error: { code: string; cause: string } }
    expect(printed.state).toBe("unhealthy")
    expect(printed.error.code).toBe("queue-round-overdue")
    expect(printed.error.cause).toContain(NOW.toISOString())
  })

  // The control: inside the deadline the stored verdict stands unaltered, so
  // the expiry cannot be mistaken for a probe that distrusts every document.
  it("prints the stored verdict unchanged while the deadline holds", () => {
    const dir = workdir()
    const written = roundHealthDocument(SERVICE, {}, undefined, 120_000, NOW)
    writeFileSync(join(dir, QUEUE_HEALTH_DOCUMENT), JSON.stringify(written))
    const run = capture()
    expect(queueHealthCommand(dir, SERVICE, run.io, new Date(NOW.getTime() + 60_000))).toBe(0)
    expect(JSON.parse(run.stdout())).toEqual(written)
  })
})
