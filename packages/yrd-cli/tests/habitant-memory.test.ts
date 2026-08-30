/**
 * @failure The habitant runner grew until the kernel's OOM killer took it: 49
 *          `signal=SIGKILL` exits in one supervision log, `oom_kill` advancing
 *          149 → 190 across a single investigation, and a live sample at 1h51m
 *          uptime reading `VmRSS` 6.2 GB against `VmHWM` 26.3 GB. Every one of
 *          those deaths took the in-flight run with it and reached the
 *          supervisor as an undeclared crash it could only count.
 * @level   l1
 * @consumer @yrd/cli habitant runner
 *
 * The pure half of the RSS cap. The loop wiring and the exit code it produces
 * are proved in the last describe below, which drives the real follow loop.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  decideHabitantMemory,
  foldMemoryCap,
  HABITANT_RSS_CAP_DEFAULT_MB,
  HABITANT_RSS_CAP_ENV,
  HABITANT_RSS_CAP_OBSERVATIONS,
  type HabitantMemoryStall,
} from "../src/habitant-memory.ts"
import { HABITANT_EXIT } from "../src/habitant-exit.ts"
import { followQueueRuns } from "../src/run.ts"
import { createHabitantHarness } from "./support/habitant-harness.ts"
import type { YrdCliIO } from "../src/types.ts"

const MB = 1024 * 1024
const CAP = 512 * MB

/** Fold the same reading `times` in a row, as consecutive cycles would. */
function after(
  times: number,
  rssBytes: number | undefined,
  capBytes: number | undefined = CAP,
): HabitantMemoryStall | undefined {
  let window: HabitantMemoryStall | undefined
  for (let cycle = 0; cycle < times; cycle += 1) window = foldMemoryCap(window, { rssBytes, capBytes })
  return window
}

describe("habitant RSS cap — the window", () => {
  it("opens no window under the cap", () => {
    expect(after(1, CAP - 1)).toBeUndefined()
    expect(after(9, CAP - 1)).toBeUndefined()
  })

  it("treats exactly-at-cap as under it — a cap is a ceiling to cross, not to touch", () => {
    expect(after(9, CAP)).toBeUndefined()
  })

  it("counts consecutive observations over the cap", () => {
    expect(after(1, CAP + 1)?.observations).toBe(1)
    expect(after(2, CAP + 1)?.observations).toBe(2)
    expect(after(9, CAP + 1)?.observations).toBe(9)
  })

  it("keeps counting while the reading GROWS — the only shape this leak has ever taken", () => {
    // Deliberately unlike the source-staleness window, which requires the head
    // to hold still. Demanding two equal byte counts here would mean never
    // acting on a process that is actively growing, which is the whole case.
    let window = foldMemoryCap(undefined, { rssBytes: CAP + MB, capBytes: CAP })
    window = foldMemoryCap(window, { rssBytes: CAP + 40 * MB, capBytes: CAP })
    expect(window?.observations).toBe(2)
    expect(window?.rssBytes).toBe(CAP + 40 * MB)
  })

  it("restarts the count when the CAP changes — a different cap is a different question", () => {
    let window = foldMemoryCap(undefined, { rssBytes: CAP + MB, capBytes: CAP })
    window = foldMemoryCap(window, { rssBytes: CAP + MB, capBytes: CAP * 2 })
    expect(window).toBeUndefined()
  })

  it("closes the window the moment the process comes back under the cap", () => {
    let window = foldMemoryCap(undefined, { rssBytes: CAP + MB, capBytes: CAP })
    expect(window?.observations).toBe(1)
    window = foldMemoryCap(window, { rssBytes: CAP - MB, capBytes: CAP })
    expect(window).toBeUndefined()
  })

  it("opens no window on an unmeasurable read — undefined is not zero and not evidence", () => {
    expect(after(9, undefined)).toBeUndefined()
  })

  it("opens no window when no cap is declared", () => {
    // Called directly: an explicit `undefined` argument takes the helper's
    // default, which would quietly re-declare the cap this case is about.
    expect(foldMemoryCap(undefined, { rssBytes: CAP * 100, capBytes: undefined })).toBeUndefined()
    expect(after(9, CAP * 100, 0)).toBeUndefined()
  })

  it("ships disabled — the number belongs to the host that can measure its machine", () => {
    expect(HABITANT_RSS_CAP_DEFAULT_MB).toBe(0)
  })
})

describe("habitant RSS cap — ruling on a closed window", () => {
  it("serves until the confirmation window closes — one spike is not a leak", () => {
    expect(decideHabitantMemory(after(1, CAP + MB))).toEqual({ kind: "serve" })
    expect(HABITANT_RSS_CAP_OBSERVATIONS).toBe(2)
  })

  it("stands down once consecutive observations agree", () => {
    expect(decideHabitantMemory(after(2, CAP + MB))).toMatchObject({
      kind: "stand-down",
      rssBytes: CAP + MB,
      capBytes: CAP,
      observations: 2,
    })
  })

  it("serves on no window at all", () => {
    expect(decideHabitantMemory(undefined)).toEqual({ kind: "serve" })
  })
})

describe("habitant RSS cap — the follow loop stands down over a forced cap", () => {
  const roots: string[] = []
  const priorCap = process.env[HABITANT_RSS_CAP_ENV]

  afterEach(() => {
    if (priorCap === undefined) delete process.env[HABITANT_RSS_CAP_ENV]
    else process.env[HABITANT_RSS_CAP_ENV] = priorCap
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  /**
   * Drive the real loop with a quiet queue and a forced resident size.
   *
   * `sourceCheckout` points at an empty temp dir and no `implementationSource`
   * is supplied, so the staleness check ahead of this one reads UNMEASURABLE
   * and serves — this test can only exit through the cap.
   */
  function drive(rssBytes: number, options: { habitant: boolean }) {
    const stateDir = mkdtempSync(join(tmpdir(), "yrd-habitant-memory-state-"))
    const sourceRoot = mkdtempSync(join(tmpdir(), "yrd-habitant-memory-source-"))
    // The heartbeat resolves its status path from the cwd's git dir, so the
    // loop cannot start outside a repository.
    const queueRepo = mkdtempSync(join(tmpdir(), "yrd-habitant-memory-queue-"))
    execFileSync("git", ["init", "-q", "-b", "main", queueRepo])
    execFileSync("git", ["init", "-q", "-b", "main", sourceRoot])
    roots.push(stateDir, sourceRoot, queueRepo)
    const quiet = { bays: { prs: {} }, queues: { admissionRefusals: {} } }
    let cycles = 0
    const control: { bail?: () => void } = {}
    const h = createHabitantHarness({
      run: async () => [],
      state: () => {
        cycles += 1
        // Bound the test: an under-cap run never exits on its own, and a hang
        // reads as a timeout rather than as the failure it would be.
        if (cycles > 8) control.bail?.()
        return quiet
      },
    })
    control.bail = () => {
      h.drain()
    }
    const io = {
      ...h.io,
      // `habitant` is read off this identity, and the cap exit is an actuator
      // only when something re-execs us.
      ...(options.habitant ? { runner: "yrd-cli:memory-cap" } : {}),
      cwd: queueRepo,
      stateDir,
      sourceCheckout: sourceRoot,
      // A sha that exists in no repository: the staleness read ahead of the cap
      // answers UNMEASURABLE and serves, so the only exit this test can take is
      // the cap's.
      implementationSource: `git:${"a".repeat(40)}`,
      rssBytes: () => rssBytes,
      // Real advancing time: a quiet cycle only reaches these self-checks once
      // maintenance falls due, so a frozen clock parks the loop earlier and
      // would prove nothing about the path under test.
      now: () => Date.parse("2026-08-30T01:00:00.000Z") + cycles * 61_000,
    } as unknown as YrdCliIO
    return { h, exit: followQueueRuns(h.app, [], { interval: 1 }, io, h.gate) }
  }

  it("exits with the memory-cap code once the forced size crosses the declared cap", async () => {
    process.env[HABITANT_RSS_CAP_ENV] = "512"
    const { h, exit } = drive(700 * MB, { habitant: true })

    await expect(exit).resolves.toBe(HABITANT_EXIT["memory-cap"])
    // Not the shared unclean code the other lifecycle exits used to speak: the
    // supervisor pacing this condition needs it separable from an interruption.
    expect(HABITANT_EXIT["memory-cap"]).not.toBe(HABITANT_EXIT.interrupted)
    expect(h.warnings).toContainEqual(
      expect.objectContaining({
        props: expect.objectContaining({
          action: "habitant-memory-cap-restart",
          rssBytes: 700 * MB,
          capBytes: 512 * MB,
          observations: HABITANT_RSS_CAP_OBSERVATIONS,
        }),
      }),
    )
  })

  it("serves on under the cap — the negative control that makes the exit above evidence", async () => {
    process.env[HABITANT_RSS_CAP_ENV] = "512"
    const { h, exit } = drive(200 * MB, { habitant: true })

    await expect(exit).resolves.not.toBe(HABITANT_EXIT["memory-cap"])
    expect(h.warnings.map((warning) => warning.props.action)).not.toContain("habitant-memory-cap-restart")
  })

  it("serves on with no cap declared, however big it is", async () => {
    delete process.env[HABITANT_RSS_CAP_ENV]
    const { h, exit } = drive(64 * 1024 * MB, { habitant: true })

    await expect(exit).resolves.not.toBe(HABITANT_EXIT["memory-cap"])
    expect(h.warnings.map((warning) => warning.props.action)).not.toContain("habitant-memory-cap-restart")
  })

  it("never stands down a non-habitant follow — exiting is only an actuator under a supervisor", async () => {
    process.env[HABITANT_RSS_CAP_ENV] = "512"
    const { h, exit } = drive(700 * MB, { habitant: false })

    await expect(exit).resolves.not.toBe(HABITANT_EXIT["memory-cap"])
    expect(h.warnings.map((warning) => warning.props.action)).not.toContain("habitant-memory-cap-restart")
  })
})
