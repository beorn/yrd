/**
 * @failure A habitant runner that had fallen pins behind its own source checkout
 *          had no way to act on it: nothing compared its booted commit to the
 *          checkout, nothing recorded a recycle attempt, and a restart that came
 *          back on the SAME stale commit would have restarted forever.
 * @level   l1
 * @consumer @yrd/cli habitant runner
 *
 * Box 1 of @yrd/core/stale-runner-never-recycles — the wiring: real git reads,
 * the durable attempt record that survives the re-exec, and the two log lines an
 * operator reads. The verdict logic itself is proved in
 * habitant-source-staleness.test.ts.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { followQueueRuns, habitantSourceHealth } from "../src/run.ts"
import { createHabitantHarness } from "./support/habitant-harness.ts"
import { HABITANT_SOURCE_STALE_OBSERVATIONS, type HabitantSourceStall } from "../src/source-staleness.ts"
import { HABITANT_EXIT } from "../src/habitant-exit.ts"
import type { YrdCliApp, YrdCliIO } from "../src/types.ts"

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

function commit(repo: string, message: string): string {
  writeFileSync(join(repo, "f.txt"), `${message}\n`)
  execFileSync("git", ["-C", repo, "add", "-A"])
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", message])
  return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim()
}

type Warn = Readonly<{ message: string; props: Record<string, unknown> }>

/**
 * The habitant's source checkout and the queue repository are DIFFERENT
 * repositories — that separation is the whole point of the fix, so the fixture
 * models both rather than one directory standing in for two.
 */
function fixture(bootedSha: string, sourceCheckout: string, existingStateDir?: string) {
  const warnings: Warn[] = []
  const queueRepo = initRepo("yrd-source-recycle-queue-")
  commit(queueRepo, "queue repository, unrelated history")
  // A successive process after a re-exec reuses the SAME durable state dir —
  // that is the only channel through which it can learn a recycle was tried.
  const stateDir = existingStateDir ?? mkdtempSync(join(tmpdir(), "yrd-source-recycle-state-"))
  if (existingStateDir === undefined) roots.push(stateDir)
  const app = {
    log: { warn: (message: string, props: Record<string, unknown>) => warnings.push({ message, props }) },
  } as unknown as YrdCliApp
  const io = {
    cwd: queueRepo,
    stateDir,
    sourceCheckout,
    implementationSource: `git:${bootedSha}`,
    now: () => Date.parse("2026-08-14T22:39:00.000Z"),
  } as unknown as YrdCliIO
  const recyclePath = join(stateDir, "resident-runner", "source-recycle.json")
  return {
    app,
    io,
    warnings,
    stateDir,
    recyclePath,
    readRecycle: () => JSON.parse(readFileSync(recyclePath, "utf8")) as Record<string, unknown>,
    /** Drive `count` consecutive habitant cycles, carrying the window forward. */
    observe: async (count: number, threshold = 2) => {
      let stall: HabitantSourceStall | undefined
      let recycle = false
      for (let cycle = 0; cycle < count; cycle += 1) {
        const health = await habitantSourceHealth(app, io, stall, true, threshold)
        stall = health.stall
        recycle = health.recycle
        if (recycle) break
      }
      return { stall, recycle }
    },
  }
}

/** A source checkout that has advanced `ahead` commits past where a habitant booted. */
function staleSource(ahead: number): Readonly<{ root: string; bootedSha: string; headSha: string }> {
  const root = initRepo("yrd-source-recycle-source-")
  const bootedSha = commit(root, "the commit the habitant booted from")
  let headSha = bootedSha
  for (let i = 0; i < ahead; i += 1) headSha = commit(root, `merge ${String(i + 1)}`)
  return { root, bootedSha, headSha }
}

describe("habitant source recycle — noticing the gap", () => {
  it("recycles after the required consecutive observations, naming the head it is aiming at", async () => {
    const source = staleSource(3)
    const f = fixture(source.bootedSha, source.root)

    const outcome = await f.observe(HABITANT_SOURCE_STALE_OBSERVATIONS)

    expect(outcome.recycle).toBe(true)
    expect(f.warnings).toContainEqual(
      expect.objectContaining({
        props: expect.objectContaining({
          action: "resident-source-stale-restart",
          bootedSha: source.bootedSha,
          headSha: source.headSha,
          behind: 3,
          observations: HABITANT_SOURCE_STALE_OBSERVATIONS,
        }),
      }),
    )
  })

  it("does not recycle on a single observation — one read can catch a checkout mid-advance", async () => {
    const source = staleSource(3)
    const f = fixture(source.bootedSha, source.root)

    const outcome = await f.observe(1)

    expect(outcome.recycle).toBe(false)
    expect(outcome.stall?.observations).toBe(1)
    expect(f.warnings).toEqual([])
  })

  it("does not recycle a runner that is current, however long it runs", async () => {
    const root = initRepo("yrd-source-recycle-source-")
    const bootedSha = commit(root, "only commit")
    const f = fixture(bootedSha, root)

    expect((await f.observe(10)).recycle).toBe(false)
    expect(f.warnings).toEqual([])
  })

  it("does not recycle below whatever threshold it was given", async () => {
    // `observe` passes 2 explicitly. The SHIPPING threshold is 1 since
    // 2026-08-30 — see HABITANT_SOURCE_STALE_BEHIND, whose old "one commit is
    // routinely the merge we just produced" defence described a comparison
    // against the queue repository that this check has not made for some time.
    const source = staleSource(1)
    const f = fixture(source.bootedSha, source.root)

    expect((await f.observe(10, 2)).recycle).toBe(false)
  })

  it("never recycles a non-habitant follow — exiting is only an actuator under a supervisor", async () => {
    const source = staleSource(5)
    const f = fixture(source.bootedSha, source.root)

    let stall: HabitantSourceStall | undefined
    for (let cycle = 0; cycle < 10; cycle += 1) {
      const health = await habitantSourceHealth(f.app, f.io, stall, false, 2)
      stall = health.stall
      expect(health.recycle).toBe(false)
    }
    expect(f.warnings).toEqual([])
  })

  it("is disabled by a zero threshold, leaving the staleness visible-only", async () => {
    const source = staleSource(9)
    const f = fixture(source.bootedSha, source.root)

    expect((await f.observe(10, 0)).recycle).toBe(false)
    expect(f.warnings).toEqual([])
  })
})

describe("habitant source recycle — the restart that changes nothing", () => {
  it("records the attempt durably BEFORE exiting, so the next process can see it", async () => {
    const source = staleSource(3)
    const f = fixture(source.bootedSha, source.root)

    await f.observe(HABITANT_SOURCE_STALE_OBSERVATIONS)

    expect(f.readRecycle()).toMatchObject({
      bootedSha: source.bootedSha,
      headSha: source.headSha,
      attemptedAt: "2026-08-14T22:39:00.000Z",
    })
  })

  it("refuses to recycle twice for the same gap, and names the checkout as the thing to advance", async () => {
    const source = staleSource(3)
    const first = fixture(source.bootedSha, source.root)
    expect((await first.observe(HABITANT_SOURCE_STALE_OBSERVATIONS)).recycle).toBe(true)

    // The re-exec came back on the SAME commit — the checkout the runner boots
    // from is not the one that moved. A second process, same durable state dir.
    const second = fixture(source.bootedSha, source.root, first.stateDir)

    const outcome = await second.observe(HABITANT_SOURCE_STALE_OBSERVATIONS + 2)

    expect(outcome.recycle).toBe(false)
    const warning = second.warnings.find((w) => w.props.action === "resident-source-stale-checkout-behind")
    expect(warning).toBeDefined()
    expect(warning?.props).toMatchObject({
      bootedSha: source.bootedSha,
      headSha: source.headSha,
      behind: 3,
      sourceRoot: source.root,
      previousAttemptAt: "2026-08-14T22:39:00.000Z",
    })
    // The remedy has to name the checkout and the by-hand restart, because
    // nothing automatic can fix it from here.
    expect(warning?.message).toContain(source.root)
    expect(warning?.message).toMatch(/advance the checkout/iu)
    expect(warning?.message).toMatch(/not restarting again/iu)
  })

  it("recycles again once the source has genuinely moved on past a prior attempt", async () => {
    const source = staleSource(3)
    const f = fixture(source.bootedSha, source.root)
    await f.observe(HABITANT_SOURCE_STALE_OBSERVATIONS)
    expect(f.readRecycle()).toMatchObject({ headSha: source.headSha })

    // Same booted sha, but the checkout advanced further while we were deciding:
    // a different head, so the recorded attempt must not suppress it.
    commit(source.root, "another merge")
    const advanced = commit(source.root, "and another")
    const outcome = await f.observe(HABITANT_SOURCE_STALE_OBSERVATIONS)

    expect(outcome.recycle).toBe(true)
    expect(f.readRecycle()).toMatchObject({ headSha: advanced })
  })
})

describe("habitant source recycle — unmeasurable is never stale", () => {
  it("does not recycle a working-tree build whose source identity is not a commit", async () => {
    const source = staleSource(5)
    const f = fixture(source.bootedSha, source.root)
    ;(f.io as { implementationSource?: string }).implementationSource = `dirty:${source.bootedSha}`

    expect((await f.observe(10)).recycle).toBe(false)
  })

  it("does not recycle when the source checkout is not a Git repository", async () => {
    const source = staleSource(5)
    const notARepo = mkdtempSync(join(tmpdir(), "yrd-source-recycle-not-a-repo-"))
    roots.push(notARepo)
    const f = fixture(source.bootedSha, notARepo)

    expect((await f.observe(10)).recycle).toBe(false)
  })

  it("does not recycle across an unrelated history, even when both commits resolve", async () => {
    // The measurement bug this fix also closes: the queue repository held the
    // source repository's objects, so a count came back for two histories that
    // never met. Recycling on that number would have restarted a current runner
    // every cycle until its restart budget was spent.
    const source = staleSource(3)
    const f = fixture(source.bootedSha, source.root)
    execFileSync("git", ["-C", source.root, "checkout", "-q", "--orphan", "unrelated"])
    commit(source.root, "unrelated root")
    commit(source.root, "unrelated second")

    expect((await f.observe(10)).recycle).toBe(false)
  })
})

describe("habitant source recycle — the quiet queue, where a runner actually goes stale", () => {
  /**
   * Every other test here drives cycles by calling `habitantSourceHealth` in a
   * hand-rolled loop, so they prove the DECISION and not the wiring. The real
   * loop reaches that call only after it has produced runs; a queue with
   * nothing to do returns earlier. A runner falls behind its pin precisely
   * while nothing is moving, so that is the one state where the exit has to
   * work — and the one no test drove.
   */
  it("recycles from an idle cycle, without waiting for work it may never get", async () => {
    const source = staleSource(5)
    const queueRepo = initRepo("yrd-source-recycle-idle-queue-")
    commit(queueRepo, "queue repository, unrelated history")
    const stateDir = mkdtempSync(join(tmpdir(), "yrd-source-recycle-idle-state-"))
    roots.push(stateDir)

    // One snapshot, returned by identity every refresh: nothing is changing,
    // so after the first cycle the loop has no reason to run the queue.
    const quiet = { bays: { prs: {} }, queues: { admissionRefusals: {} } }
    let cycles = 0
    // Filled in after construction: the state factory runs once DURING it, so
    // naming the harness directly would read it in the temporal dead zone.
    const control: { bail?: () => void } = {}
    const h = createHabitantHarness({
      run: async () => [],
      state: () => {
        cycles += 1
        // Bound the test: without the idle-path check this loop never exits,
        // and a hang reads as a timeout rather than as the failure it is.
        if (cycles > 8) control.bail?.()
        return quiet
      },
    })
    control.bail = () => {
      h.drain()
    }
    const io = {
      ...h.io,
      // The source exit is an actuator, and only a supervised habitant may
      // pull it — `habitant` is read off this identity.
      runner: "yrd-cli:idle-recycle",
      cwd: queueRepo,
      stateDir,
      sourceCheckout: source.root,
      implementationSource: `git:${source.bootedSha}`,
      // Real time, not a frozen clock: a quiet cycle only reaches the source
      // check once maintenance falls due, so a fixed `now` parks the loop at an
      // earlier return and proves nothing about the path under test.
      now: () => Date.parse("2026-08-29T21:40:00.000Z") + cycles * 61_000,
    } as unknown as YrdCliIO

    // The unclean exit hab's restart=on-failure re-execs onto the checkout —
    // and since 2026-08-30 its OWN code, not the interrupted one it used to
    // share, so a supervisor reading only the code can still tell the two
    // apart.
    await expect(followQueueRuns(h.app, [], { interval: 1 }, io, h.gate)).resolves.toBe(HABITANT_EXIT["source-stale"])

    expect(h.warnings).toContainEqual(
      expect.objectContaining({
        props: expect.objectContaining({ action: "resident-source-stale-restart", headSha: source.headSha }),
      }),
    )
    // The point of the test: it got there on IDLE cycles — the state factory
    // returns ONE stable snapshot forever, so no external delta ever fired an
    // edge, and every cycle past the first is the quiet path.
    //
    // `toBe(1)` used to stand here, and it described the edge-only scheduler:
    // only the `starting` cycle ran the queue. Since the D1b LEVEL trigger a
    // supervised habitant runs the queue once per MAINTENANCE cycle, and this
    // io advances 61s per cycle, so the count now tracks the cadence. It only
    // read as 1 at all because a state slice the heartbeat walks was missing
    // and the loop died in its first cycle (see completeState in
    // support/habitant-harness.ts) — the assertion was measuring a crash.
    // What must still hold is the bound: the queue ran on the maintenance
    // cadence and never more often than the loop cycled.
    expect(h.runCalls()).toBeGreaterThanOrEqual(1)
    expect(h.runCalls()).toBeLessThanOrEqual(cycles)
    expect(cycles).toBeLessThanOrEqual(HABITANT_SOURCE_STALE_OBSERVATIONS + 3)
  })
})
