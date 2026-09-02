/**
 * @failure Advancing the root repository's gitlink for Yrd could not reach a
 *          running resident. The runner served the pin it booted on until a
 *          person stopped it, advanced the pin and started it again — measured
 *          2026-09-02 at best 2m43s and worst ~40 minutes, on the fleet's
 *          critical path. Neither existing self-check could see it:
 *          `source-stale` watches the local CHECKOUT, `installed-plan-stale`
 *          watches the declared STEP PLAN, and a gitlink advance moves neither
 *          until someone updates the submodule.
 * @level   l1
 * @consumer @yrd/cli habitant runner · Hab supervision
 *
 * Box 3 of the "the code moved under me" family (24047), and the boundary
 * rules are the whole risk: an exit inside an attempt abandons a merge in
 * flight, and an exit on an unreadable pin takes a healthy queue down over a
 * transient git read.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { followQueueRuns, habitantBootRootPin, habitantRootPinHealth } from "../src/run.ts"
import { HABITANT_EXIT } from "../src/habitant-exit.ts"
import { createHabitantHarness } from "./support/habitant-harness.ts"
import type { YrdCliApp, YrdCliIO } from "../src/types.ts"

const BOOT_PIN = "a".repeat(40)
const NEXT_PIN = "b".repeat(40)
const SUBMODULE_ROOT = "/queue/vendor/yrd"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type Row = Readonly<{ message: string; props: Record<string, unknown> }>

/** A minimal app/io pair for the two pure-ish entry points. The loop tests
 * below drive the real `followQueueRuns` instead. */
function probe(pin: () => ReturnType<NonNullable<YrdCliIO["recordedRootPin"]>>, habitantIdentity = true) {
  const warnings: Row[] = []
  const infos: Row[] = []
  const app = {
    log: {
      warn: (message: string, props: Record<string, unknown>) => warnings.push({ message, props }),
      info: (message: string, props: Record<string, unknown>) => infos.push({ message, props }),
    },
  } as unknown as YrdCliApp
  const io = {
    cwd: "/queue",
    ...(habitantIdentity ? { runner: "yrd-cli:pin-probe" } : {}),
    recordedRootPin: pin,
  } as unknown as YrdCliIO
  return { app, io, warnings, infos }
}

describe("recorded-pin watch — what this runner compares against", () => {
  it("captures the pin ONCE at boot and says which one it is watching", () => {
    const p = probe(() => ({ pinSha: BOOT_PIN, submoduleRoot: SUBMODULE_ROOT }))
    expect(habitantBootRootPin(p.app, p.io, true)).toEqual({ state: "watching", pinSha: BOOT_PIN })
    expect(p.infos).toContainEqual(
      expect.objectContaining({ props: expect.objectContaining({ action: "resident-root-pin-watching" }) }),
    )
  })

  it("does not watch at all outside a habitant — a one-shot has no supervisor to relaunch it", () => {
    // Deliverable 3: `yrd queue run --once` must never leave for this reason.
    // It has no next cycle and nothing re-execs it, so exiting is not an
    // actuator — the same gate every other designed exit is behind.
    const p = probe(() => ({ pinSha: BOOT_PIN, submoduleRoot: SUBMODULE_ROOT }))
    const boot = habitantBootRootPin(p.app, p.io, false)
    expect(boot.state).toBe("unwatchable")
    // And an unwatchable boot can never produce a move, whatever the pin does.
    const moved = probe(() => ({ pinSha: NEXT_PIN, submoduleRoot: SUBMODULE_ROOT }))
    expect(habitantRootPinHealth(moved.app, moved.io, boot).movedTo).toBeUndefined()
  })

  it("says so at INFO when the queue repository simply has no Yrd submodule", () => {
    // `unpinned` is structural, not a fault: a deployment with no submodule has
    // no pin to be behind. It is still SAID — a self-check that disables itself
    // in silence is the failure it exists to prevent.
    const p = probe(() => ({ state: "unpinned" }))
    expect(habitantBootRootPin(p.app, p.io, true).state).toBe("unwatchable")
    expect(p.infos).toContainEqual(
      expect.objectContaining({ props: expect.objectContaining({ action: "resident-root-pin-unpinned" }) }),
    )
    expect(p.warnings).toEqual([])
  })

  it("is LOUD when a pin that should have been readable was not", () => {
    // The asymmetry is the point: a pin that should exist and could not be read
    // disables this check for the whole process lifetime, so it warns and names
    // the reason rather than degrading to the quiet `unpinned` rendering.
    const p = probe(() => ({ state: "unknown", reason: "origin/main unresolvable in the queue repository" }))
    expect(habitantBootRootPin(p.app, p.io, true)).toEqual({
      state: "unwatchable",
      reason: "origin/main unresolvable in the queue repository",
    })
    expect(p.warnings).toContainEqual(
      expect.objectContaining({
        props: expect.objectContaining({ action: "resident-root-pin-unreadable-at-boot" }),
      }),
    )
  })
})

describe("recorded-pin watch — one pass boundary's verdict", () => {
  it("stays put while the pin is unchanged", () => {
    const p = probe(() => ({ pinSha: BOOT_PIN, submoduleRoot: SUBMODULE_ROOT }))
    const health = habitantRootPinHealth(p.app, p.io, { state: "watching", pinSha: BOOT_PIN })
    expect(health.movedTo).toBeUndefined()
    expect(p.warnings).toEqual([])
  })

  it("reports the new pin once it moves", () => {
    const p = probe(() => ({ pinSha: NEXT_PIN, submoduleRoot: SUBMODULE_ROOT }))
    expect(habitantRootPinHealth(p.app, p.io, { state: "watching", pinSha: BOOT_PIN }).movedTo).toBe(NEXT_PIN)
  })

  it("LOGS and serves on when the pin cannot be read this pass — never exits on a read failure", () => {
    // Fail loud, not fail dead. A transient unreadable pin (a fetch mid-write,
    // a busy object store) costs one skipped comparison; treating it as an
    // advance would restart a healthy runner over a torn read.
    const p = probe(() => ({ state: "unknown", reason: "queue repository root unresolvable" }))
    expect(habitantRootPinHealth(p.app, p.io, { state: "watching", pinSha: BOOT_PIN }).movedTo).toBeUndefined()
    expect(p.warnings).toContainEqual(
      expect.objectContaining({
        props: expect.objectContaining({
          action: "resident-root-pin-unreadable",
          reason: "queue repository root unresolvable",
        }),
      }),
    )
  })

  it("treats a pin that VANISHED as unreadable, not as an advance", () => {
    // A repository that recorded a pin at boot and records none now has not
    // "moved to nothing" — something is wrong with the read, and there is no
    // sha to come back on.
    const p = probe(() => ({ state: "unpinned" }))
    expect(habitantRootPinHealth(p.app, p.io, { state: "watching", pinSha: BOOT_PIN }).movedTo).toBeUndefined()
    expect(p.warnings).toContainEqual(
      expect.objectContaining({ props: expect.objectContaining({ action: "resident-root-pin-unreadable" }) }),
    )
  })

  it("reads through the REAL git resolver when nothing is injected", () => {
    // A positive control on the wiring, not on the parsing: with no
    // `recordedRootPin` the boot read must reach `queueRecordedYrdPin` and
    // answer from actual git. A fresh repository with no submodules is
    // genuinely `unpinned`, so an injected-only code path would show up here
    // as a warn about an unresolvable root instead.
    const repo = mkdtempSync(join(tmpdir(), "yrd-root-pin-real-"))
    roots.push(repo)
    execFileSync("git", ["init", "-q", "-b", "main", repo])
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"])
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"])
    writeFileSync(join(repo, "f.txt"), "queue repository\n")
    execFileSync("git", ["-C", repo, "add", "-A"])
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "root"])
    execFileSync("git", ["-C", repo, "update-ref", "refs/remotes/origin/main", "HEAD"])

    const warnings: Row[] = []
    const infos: Row[] = []
    const app = {
      log: {
        warn: (message: string, props: Record<string, unknown>) => warnings.push({ message, props }),
        info: (message: string, props: Record<string, unknown>) => infos.push({ message, props }),
      },
    } as unknown as YrdCliApp
    const io = { cwd: repo, runner: "yrd-cli:real-read" } as unknown as YrdCliIO

    expect(habitantBootRootPin(app, io, true).state).toBe("unwatchable")
    expect(infos).toContainEqual(
      expect.objectContaining({ props: expect.objectContaining({ action: "resident-root-pin-unpinned" }) }),
    )
    expect(warnings).toEqual([])
  })
})

/** Drive the real follow loop with a pin the test controls. */
function loop(
  options: Readonly<{
    pin: () => ReturnType<NonNullable<YrdCliIO["recordedRootPin"]>>
    run?: () => Promise<readonly unknown[]>
    maxCycles?: number
  }>,
) {
  const stateDir = mkdtempSync(join(tmpdir(), "yrd-root-pin-state-"))
  roots.push(stateDir)
  const queueRepo = mkdtempSync(join(tmpdir(), "yrd-root-pin-queue-"))
  roots.push(queueRepo)
  execFileSync("git", ["init", "-q", "-b", "main", queueRepo])
  execFileSync("git", ["-C", queueRepo, "config", "user.email", "test@example.com"])
  execFileSync("git", ["-C", queueRepo, "config", "user.name", "Test"])

  const quiet = { bays: { prs: {} }, queues: { admissionRefusals: {} } }
  let cycles = 0
  const control: { bail?: () => void } = {}
  const h = createHabitantHarness({
    run: options.run ?? (async () => []),
    state: () => {
      cycles += 1
      // Bound the test: a loop that never exits reads as a timeout rather than
      // as the missing exit it actually is.
      if (cycles > (options.maxCycles ?? 8)) control.bail?.()
      return quiet
    },
  })
  control.bail = () => h.drain()
  const io = {
    ...h.io,
    // The pin exit is an actuator, and only a supervised habitant may pull it.
    runner: "yrd-cli:root-pin",
    cwd: queueRepo,
    stateDir,
    // The heartbeat refuses to serve without one. Deliberately a sha unrelated
    // to either pin: the pin check compares pin-against-pin, so what this
    // process's own source happens to be must not change any verdict here —
    // that separation is the property the whole design turns on.
    implementationSource: `git:${"e".repeat(40)}`,
    recordedRootPin: options.pin,
    // Real advancing time: a quiet cycle only reaches these checks once
    // maintenance falls due, so a frozen clock parks the loop earlier and
    // proves nothing about the path under test.
    now: () => Date.parse("2026-09-02T09:00:00.000Z") + cycles * 61_000,
  } as unknown as YrdCliIO
  return {
    h,
    io,
    recyclePath: join(stateDir, "resident-runner", "source-recycle.json"),
    readRecycle: () => JSON.parse(readFileSync(join(stateDir, "resident-runner", "source-recycle.json"), "utf8")),
    follow: () => followQueueRuns(h.app, [], { interval: 1 }, io, h.gate),
    cycles: () => cycles,
  }
}

describe("recorded-pin watch — the habitant loop", () => {
  it("exits 18 at a pass boundary and leaves the shared recycle record behind", async () => {
    let reads = 0
    const l = loop({
      // Boot reads the old pin; the queue repository advances it underneath.
      pin: () => {
        reads += 1
        return { pinSha: reads === 1 ? BOOT_PIN : NEXT_PIN, submoduleRoot: SUBMODULE_ROOT }
      },
    })

    await expect(l.follow()).resolves.toBe(HABITANT_EXIT["root-pin-moved"])

    expect(l.h.warnings).toContainEqual(
      expect.objectContaining({
        props: expect.objectContaining({
          action: "resident-root-pin-moved-restart",
          bootedSha: BOOT_PIN,
          headSha: NEXT_PIN,
        }),
      }),
    )
    // The one notice shape every designed restart-exit uses, and it says what
    // happens next so an operator reading the log does not go looking.
    const notice = l.h.warnings.find((row) => row.props.action === "resident-root-pin-moved-restart")
    expect(notice?.message).toContain("notice: yrd:")
    expect(notice?.message).toContain("Resident exits for restart on pin")
    expect(notice?.message).toContain("the supervisor relaunches")
    // The durable half, in the SHARED record rather than a second file.
    expect(l.readRecycle()).toMatchObject({
      reason: "root-pin-moved",
      bootedSha: BOOT_PIN,
      headSha: NEXT_PIN,
    })
  })

  it("never exits while an attempt is in flight — the pin moves DURING the run", async () => {
    // The expensive mistake this pins: reading the pin mid-attempt and leaving
    // would abandon a merge Yrd is in the middle of performing. The pin here
    // advances inside `queue.run`, so the only correct behaviour is to finish
    // the run and leave at the boundary after it.
    let reads = 0
    let pinMovedDuringRun = false
    let attemptFinished = false
    const l = loop({
      pin: () => {
        reads += 1
        // Boot read, then the idle-boundary reads, stay on the old pin until
        // the attempt has started moving it.
        return { pinSha: pinMovedDuringRun ? NEXT_PIN : BOOT_PIN, submoduleRoot: SUBMODULE_ROOT }
      },
      run: async () => {
        pinMovedDuringRun = true
        // If the loop could leave mid-attempt it would have to do so before
        // this line; reaching it is what "the attempt was allowed to finish"
        // means.
        attemptFinished = true
        return []
      },
    })

    await expect(l.follow()).resolves.toBe(HABITANT_EXIT["root-pin-moved"])
    expect(pinMovedDuringRun).toBe(true)
    expect(attemptFinished).toBe(true)
    expect(l.h.runCalls()).toBeGreaterThanOrEqual(1)
    expect(reads).toBeGreaterThan(1)
  })

  it("serves on indefinitely while the pin is unchanged", async () => {
    const l = loop({ pin: () => ({ pinSha: BOOT_PIN, submoduleRoot: SUBMODULE_ROOT }) })
    // Nothing else stops this loop, so it runs to the harness bail and leaves
    // by the drain — never by the pin exit.
    const exit = await l.follow()
    expect(exit).not.toBe(HABITANT_EXIT["root-pin-moved"])
    expect(l.h.warnings.filter((row) => row.props.action === "resident-root-pin-moved-restart")).toEqual([])
    expect(l.cycles()).toBeGreaterThan(1)
  })

  it("keeps cycling when the pin read fails every pass, and says so each time", async () => {
    let reads = 0
    const l = loop({
      pin: () => {
        reads += 1
        // Readable at boot so the watch arms, then unreadable forever after.
        return reads === 1
          ? { pinSha: BOOT_PIN, submoduleRoot: SUBMODULE_ROOT }
          : { state: "unknown", reason: "recorded pin at vendor/yrd is not a commit id" }
      },
    })

    const exit = await l.follow()
    expect(exit).not.toBe(HABITANT_EXIT["root-pin-moved"])
    expect(l.h.warnings).toContainEqual(
      expect.objectContaining({ props: expect.objectContaining({ action: "resident-root-pin-unreadable" }) }),
    )
    // It really did keep going rather than leaving on the first bad read.
    expect(l.cycles()).toBeGreaterThan(1)
  })
})
