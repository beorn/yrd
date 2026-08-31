/**
 * @failure PR2754 passed admission inside the resident runner at 00:27:48Z and
 *          then starved ~12 minutes at ready position 1: `runRequired` was an
 *          edge detector over EXTERNAL deltas (starting/refreshed/holdExpired),
 *          so the runner's own admission completing — and a submit fact
 *          recorded mid-run — woke nothing. The same cycle LOGGED
 *          `resident-queue-liveness-wedged` for the very change it then
 *          declined to run: the alarm and the scheduler disagreed about the
 *          one question they share. (@i/10-yrd/quiet-path-starves-standing-
 *          submit-facts shapes 1 and 5; disposed 2026-08-31 by a supervised
 *          restart, cured here by a level trigger.)
 * @level l1
 * @consumer @yrd/cli habitant runner (D1b maintenance tick)
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { followQueueRuns } from "../src/run.ts"
import { createHabitantHarness } from "./support/habitant-harness.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(repo: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

async function queueRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-habitant-level-run-"))
  roots.push(root)
  const repo = join(root, "repo")
  await mkdir(repo, { recursive: true })
  await git(root, "init", "-q", "-b", "main", repo)
  await git(repo, "config", "user.name", "Yrd Test")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await writeFile(join(repo, ".yrd.yml"), 'base: main\nbatch: 1\nchecks:\n  - {check: {run: "true"}}\n')
  await git(repo, "add", ".yrd.yml")
  await git(repo, "commit", "-qm", "queue config")
  return repo
}

/** Every `io.now()` read advances one full maintenance interval, so every
 * cycle is a maintenance cycle — the cadence under test — while the harness's
 * instant `scope.sleep` keeps the loop spinning. */
function maintenanceClock(): () => number {
  let now = Date.parse("2026-08-31T00:00:00.000Z")
  return () => {
    now += 61_000
    return now
  }
}

/** One stable snapshot: the harness treats snapshot identity as durable-state
 * identity, so returning the SAME object forever models a queue where no
 * external delta ever arrives — the starved-ready shape under test. The
 * default factory mints a fresh object per refresh, which edge-fires
 * `refreshed` every cycle and would green the level test for free. */
function quietState() {
  const snapshot = { bays: { prs: {} }, jobs: { byId: {} }, queues: { admissionRefusals: {} } }
  return () => snapshot
}

/** The harness's instant `scope.sleep` turns the follow loop into an unbroken
 * microtask chain that starves every test timer; a 1ms real sleep keeps the
 * loop spinning fast while letting macrotasks (the `until` poll, the drain)
 * interleave. */
function yieldingScope(app: unknown): void {
  ;(app as { scope: { sleep: () => Promise<void> } }).scope.sleep = () =>
    new Promise((resolve) => setTimeout(resolve, 1))
}

async function until(predicate: () => boolean, label: string, attempts = 200): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe("the habitant maintenance tick is a LEVEL trigger for the queue", () => {
  it("runs the queue on every maintenance cycle even when no external edge fired", async () => {
    const repo = await queueRepository()
    const headSha = await git(repo, "rev-parse", "HEAD")
    // The state factory returns the SAME snapshot forever: nothing external
    // ever changes, which is exactly the starved-ready shape — the work is
    // visible only to the queue's own selection, never to an edge flag.
    const harness = createHabitantHarness({ run: async () => [], state: quietState() })
    yieldingScope(harness.app)
    Object.assign(harness.io, {
      cwd: repo,
      repositoryRoot: repo,
      runner: "yrd-cli:level-run",
      implementationSource: `git:${headSha}`,
      now: maintenanceClock(),
    })

    const exit = followQueueRuns(harness.app, [], { json: true, interval: 1 }, harness.io, harness.gate)
    // Cycle 1 is `starting`; cycles 2+ have NO edge — only the level trigger
    // reaches runQueues there. Three runs proves the trigger repeats rather
    // than firing once off some residual edge.
    await until(() => harness.runCalls() >= 3, "three maintenance-cycle queue runs")
    harness.drain()
    await expect(exit).resolves.toBe(0)
  })

  it("leaves non-habitant callers on the historical drain-only behavior", async () => {
    // No `io.runner`: a programmatic follower holds no lease and must not
    // gain a background run cadence it never had.
    const harness = createHabitantHarness({ run: async () => [], state: quietState() })
    yieldingScope(harness.app)
    Object.assign(harness.io, { now: maintenanceClock() })

    const exit = followQueueRuns(harness.app, [], { json: true, interval: 1 }, harness.io, harness.gate)
    // Give the loop ample cycles to (wrongly) fire a level run, then drain.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(harness.runCalls()).toBe(1)
    harness.drain()
    await expect(exit).resolves.toBe(0)
    // The drain pass itself runs the queue once — historical behavior for
    // every follower — so the total lands at 2, never more: 1 starting run
    // plus 1 drain run, and zero from any background cadence.
    expect(harness.runCalls()).toBe(2)
  })
})
