/**
 * @failure A source-stale habitant whose stale code saw nothing to do took the
 *          idle short-circuit every cycle, and the recycle self-check — which
 *          only ran after a RUN cycle — never fired: the runner held the queue
 *          silently for 20+ minutes with a healthy heartbeat while queued/todo
 *          check requests sat undispatched, until an operator restarted it by
 *          hand (measured twice, 2026-08-27).
 * @level l2
 * @consumer @yrd/cli habitant runner
 *
 * Box 1 of @yrd/core/stale-runner-never-recycles at EVERY loop boundary. The
 * verdict logic is proved in habitant-source-staleness.test.ts and the git
 * wiring in habitant-source-recycle.test.ts; this file proves the LOOP: an
 * idle cycle evaluates the self-check too, the exit happens at a boundary
 * (never mid-run — the starting run completes first), and the drift survives
 * the exit in the heartbeat so the RUNNER panel names why the pid went away.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { followQueueRuns, habitantRunnerStatus } from "../src/run.ts"
import { createHabitantHarness } from "./support/habitant-harness.ts"

const NOW = Date.parse("2026-08-27T10:00:00.000Z")

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function initRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix))
  roots.push(repo)
  execFileSync("git", ["init", "-q", "-b", "main", repo])
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"])
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"])
  return repo
}

function commitAll(repo: string, message: string): string {
  execFileSync("git", ["-C", repo, "add", "-A"])
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", message])
  return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim()
}

function commit(repo: string, message: string): string {
  writeFileSync(join(repo, "f.txt"), `${message}\n`)
  return commitAll(repo, message)
}

/** A queue repository the heartbeat can write its status file into. */
function queueRepository(): string {
  const repo = initRepo("yrd-idle-boundary-queue-")
  writeFileSync(join(repo, ".yrd.yml"), 'base: main\nbatch: 1\nchecks:\n  - {check: {run: "true"}}\n')
  commitAll(repo, "queue config")
  return repo
}

/** A source checkout that has advanced `ahead` commits past where the habitant booted. */
function staleSource(ahead: number): Readonly<{ root: string; bootedSha: string; headSha: string }> {
  const root = initRepo("yrd-idle-boundary-source-")
  const bootedSha = commit(root, "the commit the habitant booted from")
  let headSha = bootedSha
  for (let i = 0; i < ahead; i += 1) headSha = commit(root, `merge ${String(i + 1)}`)
  return { root, bootedSha, headSha }
}

/**
 * An IDLE habitant: the state factory returns one stable object, so after the
 * starting cycle every refresh observes an unchanged world and the loop takes
 * the idle short-circuit. `expirePauses` runs on every cycle that gets past the
 * heartbeat, which makes it the cycle counter — and the bounded escape hatch
 * that drains the loop instead of hanging the suite if no exit ever fires.
 */
function idleHabitant(source: Readonly<{ root: string; bootedSha: string }>, drainAfterCycles: number) {
  const repo = queueRepository()
  const frozen = { bays: { prs: {} }, jobs: { byId: {} }, queues: { admissionRefusals: {} } }
  const harness = createHabitantHarness({ state: () => frozen, run: async () => [] })
  let cycles = 0
  Object.assign(harness.app.queue, {
    recover: async () => [],
    expirePauses: async () => {
      cycles += 1
      if (cycles >= drainAfterCycles) harness.drain()
      return []
    },
  })
  Object.assign(harness.io, {
    cwd: repo,
    repositoryRoot: repo,
    runner: "yrd-cli:idle-boundary",
    implementationSource: `git:${source.bootedSha}`,
    sourceCheckout: source.root,
    now: () => NOW,
  })
  return { ...harness, repo, cycles: () => cycles }
}

describe("habitant source staleness at the idle loop boundary", () => {
  it("exits at an IDLE boundary instead of holding silently, after the in-flight cycle completed", async () => {
    const source = staleSource(3)
    const h = idleHabitant(source, 8)

    // 3 = the unclean exit code; `restart: on-failure` re-execs on new source.
    await expect(followQueueRuns(h.app, [], { json: true, interval: 1 }, h.io, async () => {})).resolves.toBe(3)

    // The starting cycle's run completed while the source was ALREADY stale —
    // never exit mid-run — and the exit came at the NEXT (idle) boundary, not
    // via a second run and not via the drain escape.
    expect(h.runCalls()).toBe(1)
    expect(h.cycles()).toBeLessThan(8)

    const warning = h.warnings.find((w) => w.props.action === "resident-source-stale-restart")
    expect(warning).toBeDefined()
    // ONE loud line: the drift by both shas, and the cure.
    expect(warning?.message).toContain(`git:${source.bootedSha}`)
    expect(warning?.message).toContain(`git:${source.headSha}`)
    expect(warning?.message).toMatch(/supervisor restart brings the runner up on the new source/u)

    // The drift survives the exit in the heartbeat, so the RUNNER panel renders
    // NO PROGRESS with this exact finding while the pid is away.
    await expect(habitantRunnerStatus(h.repo)).resolves.toMatchObject({
      clean: false,
      queueProgress: {
        state: "stalled",
        observedAt: expect.any(String),
        findings: [
          expect.objectContaining({
            code: "resident-source-stale-restart",
            message: expect.stringMatching(/supervisor restart brings the runner up on the new source/u),
          }),
        ],
      },
    })
  })

  it("drains an already-current habitant clean through the same boundaries — no exit, no warnings", async () => {
    const source = staleSource(0)
    const h = idleHabitant(source, 6)

    await expect(followQueueRuns(h.app, [], { json: true, interval: 1 }, h.io, async () => {})).resolves.toBe(0)

    expect(h.warnings.filter((w) => String(w.props.action ?? "").startsWith("resident-source-stale"))).toEqual([])
  })
})
