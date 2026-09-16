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

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
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
  it("prints what the last round wrote, and exits on its state", async () => {
    const dir = workdir()
    const written = roundHealthDocument(SERVICE, {}, undefined, 120_000, NOW)
    writeFileSync(join(dir, QUEUE_HEALTH_DOCUMENT), `${JSON.stringify(written, undefined, 2)}\n`)
    const run = capture()
    expect(await queueHealthCommand(dir, SERVICE, run.io, NOW)).toBe(0)
    expect(JSON.parse(run.stdout())).toEqual(written)
  })

  it("reports a stuck round as unhealthy-and-running, exit 2", async () => {
    const dir = workdir()
    const streak = { key: "stuck-changes:task/one", reason: "the code host answered 504 during setup", consecutive: 2 }
    const written = roundHealthDocument(
      SERVICE,
      { stuck: { key: streak.key, reason: streak.reason } },
      streak,
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
 * @failure  A round hangs, the loop stops writing, and the probe keeps printing
 *           the last round's `healthy` — so the supervisor never pages and a
 *           dead queue reads exactly like a working one (@cto follow-up F1,
 *           2026-09-11). The end-to-end half: the probe must apply the
 *           document's own deadline, not just possess it.
 * @level    l1
 */
describe("the probe applies the document's deadline", () => {
  // @failure An open round pages throughout a long, journal-silent check.
  // @level l2 — real child holding the round's own worktree
  // @consumer Hab's overdue page; a live loop PID alone must not suppress it.
  it("keeps a journal-silent round open only while its worktree has a live process", async () => {
    const dir = workdir()
    const id = "q-20260911T120100000Z-12345678"
    const tree = join(dir, "worktrees", id, "merge")
    mkdirSync(tree, { recursive: true })
    mkdirSync(join(dir, "logs"))
    const journal = join(dir, "logs", `${id}.jsonl`)
    writeFileSync(journal, `${JSON.stringify({ kind: "run", target: "main", run: id, at: NOW.toISOString() })}\n`)
    // A newer submission can finish while this older merge round is running.
    writeFileSync(join(dir, "logs", "q-20260911T120200000Z-abcdef12.jsonl"), "{}\n")
    utimesSync(journal, NOW, NOW)
    writeFileSync(join(dir, "worktrees", id, ".pid"), String(process.pid))
    writeFileSync(join(dir, QUEUE_HEALTH_DOCUMENT), JSON.stringify(roundHealthDocument(SERVICE, {}, undefined, 0, NOW)))
    const late = new Date(NOW.getTime() + ROUND_BUDGET_MS + 60_000)
    const child = Bun.spawn([process.execPath, "-e", 'console.log("ready"); setInterval(() => {}, 1000)'], {
      cwd: tree,
      stdout: "pipe",
      stderr: "inherit",
    })
    try {
      const reader = child.stdout.getReader()
      await reader.read()
      reader.releaseLock()
      const health = await readQueueHealth(dir, SERVICE, late)
      expect(health.state).toBe("healthy")
      expect(health.facts?.activeRound).toBe(id)
      writeFileSync(journal, "{}\n")
      const unreadable = await readQueueHealth(dir, SERVICE, late)
      expect(unreadable.state).toBe("unknown")
      expect(unreadable.error?.cause).toContain(journal)
    } finally {
      child.kill()
      await child.exited
    }
    const ended = await readQueueHealth(dir, SERVICE, late)
    expect(["queue-round-overdue", "queue-round-unobserved"]).toContain(ended.error?.code)
    expect(ended.facts?.activeRound).toBeUndefined()
    expect(ended.error?.cause).toContain(join(dir, "worktrees"))
  })

  it("prints OVERDUE and exits 2 when the loop stopped writing", async () => {
    const dir = workdir()
    const written = roundHealthDocument(SERVICE, {}, undefined, 120_000, NOW)
    writeFileSync(join(dir, QUEUE_HEALTH_DOCUMENT), JSON.stringify(written))
    // Long past the instant the loop itself declared its next round due by.
    const late = new Date(NOW.getTime() + 120_000 + ROUND_BUDGET_MS + 60_000)
    const run = capture()
    expect(await queueHealthCommand(dir, SERVICE, run.io, late)).toBe(2)
    const printed = JSON.parse(run.stdout()) as { state: string; error: { code: string; cause: string } }
    expect(printed.state).toBe("unhealthy")
    expect(printed.error.code).toBe("queue-round-overdue")
    expect(printed.error.cause).toContain(NOW.toISOString())
  })

  // The control: inside the deadline the stored verdict stands unaltered, so
  // the expiry cannot be mistaken for a probe that distrusts every document.
  it("prints the stored verdict unchanged while the deadline holds", async () => {
    const dir = workdir()
    const written = roundHealthDocument(SERVICE, {}, undefined, 120_000, NOW)
    writeFileSync(join(dir, QUEUE_HEALTH_DOCUMENT), JSON.stringify(written))
    const run = capture()
    expect(await queueHealthCommand(dir, SERVICE, run.io, new Date(NOW.getTime() + 60_000))).toBe(0)
    expect(JSON.parse(run.stdout())).toEqual(written)
  })
})
