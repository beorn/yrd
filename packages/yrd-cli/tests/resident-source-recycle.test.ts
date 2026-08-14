/**
 * @failure A resident runner that had fallen pins behind its own source checkout
 *          had no way to act on it: nothing compared its booted commit to the
 *          checkout, nothing recorded a recycle attempt, and a restart that came
 *          back on the SAME stale commit would have restarted forever.
 * @level   l1
 * @consumer @yrd/cli resident runner
 *
 * Box 1 of @yrd/core/stale-runner-never-recycles — the wiring: real git reads,
 * the durable attempt record that survives the re-exec, and the two log lines an
 * operator reads. The verdict logic itself is proved in
 * resident-source-staleness.test.ts.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { residentSourceHealth } from "../src/run.ts"
import { RESIDENT_SOURCE_STALE_OBSERVATIONS, type ResidentSourceStall } from "../src/source-staleness.ts"
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
 * The resident's source checkout and the queue repository are DIFFERENT
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
    /** Drive `count` consecutive resident cycles, carrying the window forward. */
    observe: async (count: number, threshold = 2) => {
      let stall: ResidentSourceStall | undefined
      let recycle = false
      for (let cycle = 0; cycle < count; cycle += 1) {
        const health = await residentSourceHealth(app, io, stall, true, threshold)
        stall = health.stall
        recycle = health.recycle
        if (recycle) break
      }
      return { stall, recycle }
    },
  }
}

/** A source checkout that has advanced `ahead` commits past where a resident booted. */
function staleSource(ahead: number): Readonly<{ root: string; bootedSha: string; headSha: string }> {
  const root = initRepo("yrd-source-recycle-source-")
  const bootedSha = commit(root, "the commit the resident booted from")
  let headSha = bootedSha
  for (let i = 0; i < ahead; i += 1) headSha = commit(root, `landing ${String(i + 1)}`)
  return { root, bootedSha, headSha }
}

describe("resident source recycle — noticing the gap", () => {
  it("recycles after the required consecutive observations, naming the head it is aiming at", async () => {
    const source = staleSource(3)
    const f = fixture(source.bootedSha, source.root)

    const outcome = await f.observe(RESIDENT_SOURCE_STALE_OBSERVATIONS)

    expect(outcome.recycle).toBe(true)
    expect(f.warnings).toContainEqual(
      expect.objectContaining({
        props: expect.objectContaining({
          action: "resident-source-stale-restart",
          bootedSha: source.bootedSha,
          headSha: source.headSha,
          behind: 3,
          observations: RESIDENT_SOURCE_STALE_OBSERVATIONS,
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

  it("does not recycle one commit behind — that is routinely the landing we just produced", async () => {
    const source = staleSource(1)
    const f = fixture(source.bootedSha, source.root)

    expect((await f.observe(10)).recycle).toBe(false)
  })

  it("never recycles a non-resident follow — exiting is only an actuator under a supervisor", async () => {
    const source = staleSource(5)
    const f = fixture(source.bootedSha, source.root)

    let stall: ResidentSourceStall | undefined
    for (let cycle = 0; cycle < 10; cycle += 1) {
      const health = await residentSourceHealth(f.app, f.io, stall, false, 2)
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

describe("resident source recycle — the restart that changes nothing", () => {
  it("records the attempt durably BEFORE exiting, so the next process can see it", async () => {
    const source = staleSource(3)
    const f = fixture(source.bootedSha, source.root)

    await f.observe(RESIDENT_SOURCE_STALE_OBSERVATIONS)

    expect(f.readRecycle()).toMatchObject({
      bootedSha: source.bootedSha,
      headSha: source.headSha,
      attemptedAt: "2026-08-14T22:39:00.000Z",
    })
  })

  it("refuses to recycle twice for the same gap, and names the checkout as the thing to advance", async () => {
    const source = staleSource(3)
    const first = fixture(source.bootedSha, source.root)
    expect((await first.observe(RESIDENT_SOURCE_STALE_OBSERVATIONS)).recycle).toBe(true)

    // The re-exec came back on the SAME commit — the checkout the runner boots
    // from is not the one that moved. A second process, same durable state dir.
    const second = fixture(source.bootedSha, source.root, first.stateDir)

    const outcome = await second.observe(RESIDENT_SOURCE_STALE_OBSERVATIONS + 2)

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
    await f.observe(RESIDENT_SOURCE_STALE_OBSERVATIONS)
    expect(f.readRecycle()).toMatchObject({ headSha: source.headSha })

    // Same booted sha, but the checkout advanced further while we were deciding:
    // a different head, so the recorded attempt must not suppress it.
    commit(source.root, "another landing")
    const advanced = commit(source.root, "and another")
    const outcome = await f.observe(RESIDENT_SOURCE_STALE_OBSERVATIONS)

    expect(outcome.recycle).toBe(true)
    expect(f.readRecycle()).toMatchObject({ headSha: advanced })
  })
})

describe("resident source recycle — unmeasurable is never stale", () => {
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
