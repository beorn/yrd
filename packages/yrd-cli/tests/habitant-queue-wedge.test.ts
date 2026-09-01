/**
 * @failure The queue stayed liveness-wedged for 7h12m on 2026-09-01 (from
 *          12:43 PDT, 24 eligible changes, head PR2131). The habitant noticed
 *          on every tick, logged one ERROR per episode, and served another
 *          cycle — for seven hours. An ERROR a process emits and then continues
 *          past cannot terminate anything, so nothing ever escalated and the
 *          queue drained only when a person happened to look.
 * @level   l1
 * @consumer @yrd/cli habitant runner · Hab terminal-exit page
 *
 * The bound's own regression. Every assertion here fails against the
 * log-and-continue behaviour this replaces, because that behaviour has no
 * bound to assert.
 */
import { describe, expect, it } from "vitest"
import { HABITANT_EXIT, HABITANT_EXIT_DISPOSITION } from "../src/habitant-exit.ts"
import {
  decideQueueWedge,
  foldQueueWedge,
  HABITANT_QUEUE_WEDGE_ENV,
  HABITANT_QUEUE_WEDGE_OBSERVATIONS,
  HABITANT_QUEUE_WEDGE_STAND_DOWN_DEFAULT_MS,
  type HabitantQueueWedgeStall,
} from "../src/habitant-queue-wedge.ts"

const BOUND = HABITANT_QUEUE_WEDGE_STAND_DOWN_DEFAULT_MS
const SPECIMEN = "queue:main:liveness-wedged"

/** Fold `count` identical wedged observations, as consecutive cycles would. */
function foldRun(count: number, blockedMs: number, specimen = SPECIMEN): HabitantQueueWedgeStall | undefined {
  let stall: HabitantQueueWedgeStall | undefined
  for (let index = 0; index < count; index += 1) {
    stall = foldQueueWedge(stall, { specimen, blockedMs, standDownMs: BOUND })
  }
  return stall
}

describe("the declared bound", () => {
  it("is two hours — four of the 30-minute detection windows it must outlast", () => {
    expect(BOUND).toBe(2 * 60 * 60_000)
    // `DEFAULT_QUEUE_PROGRESS_POLICY.noLandingMs` is 30 minutes. Asserting the
    // RATIO rather than the raw number is what keeps the two thresholds from
    // silently converging: detection must stay sensitive, this must stay
    // certain, and a future edit that collapses them fails here.
    expect(BOUND / (30 * 60_000)).toBe(4)
  })

  it("names a host env override, not repository config", () => {
    expect(HABITANT_QUEUE_WEDGE_ENV).toBe("YRD_HABITANT_QUEUE_WEDGE_MS")
  })

  it("is shorter than the live wedge that motivated it", () => {
    const observedWedgeMs = 25_841_189 // 7h10m, resident-runner status.json, 2026-09-01T19:54Z
    expect(BOUND).toBeLessThan(observedWedgeMs)
  })
})

describe("folding a wedge into a window", () => {
  it("ignores a cycle that saw no wedge at all", () => {
    expect(foldQueueWedge(undefined, { specimen: undefined, blockedMs: undefined, standDownMs: BOUND })).toBeUndefined()
  })

  it("ignores a wedge still inside its bound", () => {
    expect(foldQueueWedge(undefined, { specimen: SPECIMEN, blockedMs: BOUND - 1, standDownMs: BOUND })).toBeUndefined()
  })

  it("opens a window the moment the wedge reaches the bound", () => {
    const stall = foldQueueWedge(undefined, { specimen: SPECIMEN, blockedMs: BOUND, standDownMs: BOUND })
    expect(stall).toEqual({ specimen: SPECIMEN, blockedMs: BOUND, standDownMs: BOUND, observations: 1 })
  })

  it("counts consecutive cycles even as the blocked duration GROWS", () => {
    // The wedge's only observable shape is a number that climbs. Requiring two
    // equal readings — as the memory window requires an equal cap — would mean
    // never acting on it.
    let stall = foldQueueWedge(undefined, { specimen: SPECIMEN, blockedMs: BOUND, standDownMs: BOUND })
    stall = foldQueueWedge(stall, { specimen: SPECIMEN, blockedMs: BOUND + 90_000, standDownMs: BOUND })
    expect(stall?.observations).toBe(2)
    expect(stall?.blockedMs).toBe(BOUND + 90_000)
  })

  it("restarts the count when a DIFFERENT wedge replaces the first", () => {
    // A merge cleared one wedge and another formed. Two episodes, not one run:
    // counting them together would stand the runner down on a window it never
    // actually held.
    let stall = foldQueueWedge(undefined, { specimen: SPECIMEN, blockedMs: BOUND, standDownMs: BOUND })
    stall = foldQueueWedge(stall, { specimen: "queue:release:liveness-wedged", blockedMs: BOUND, standDownMs: BOUND })
    expect(stall?.observations).toBe(1)
  })

  it("restarts the count when the declared bound changes under us", () => {
    // Both cycles are over their own bound — otherwise this would test the
    // inside-the-bound path instead, which is why the durations are 3x here.
    let stall = foldQueueWedge(undefined, { specimen: SPECIMEN, blockedMs: BOUND * 3, standDownMs: BOUND })
    expect(stall?.observations).toBe(1)
    stall = foldQueueWedge(stall, { specimen: SPECIMEN, blockedMs: BOUND * 3, standDownMs: BOUND * 2 })
    expect(stall?.observations).toBe(1)
    expect(stall?.standDownMs).toBe(BOUND * 2)
  })

  it("closes the window when a raised bound puts the wedge back inside it", () => {
    const stall = foldQueueWedge(undefined, { specimen: SPECIMEN, blockedMs: BOUND, standDownMs: BOUND })
    expect(foldQueueWedge(stall, { specimen: SPECIMEN, blockedMs: BOUND, standDownMs: BOUND * 2 })).toBeUndefined()
  })

  it("closes the window when the queue recovers, so a later wedge starts fresh", () => {
    const held = foldRun(HABITANT_QUEUE_WEDGE_OBSERVATIONS, BOUND)
    expect(decideQueueWedge(held).kind).toBe("stand-down")
    const recovered = foldQueueWedge(held, { specimen: undefined, blockedMs: undefined, standDownMs: BOUND })
    expect(recovered).toBeUndefined()
    const reappeared = foldQueueWedge(recovered, { specimen: SPECIMEN, blockedMs: BOUND, standDownMs: BOUND })
    expect(reappeared?.observations).toBe(1)
    expect(decideQueueWedge(reappeared).kind).toBe("serve")
  })
})

describe("a disabled bound leaves today's behaviour exactly as it is", () => {
  it("never opens a window when the bound is 0", () => {
    expect(foldQueueWedge(undefined, { specimen: SPECIMEN, blockedMs: BOUND * 10, standDownMs: 0 })).toBeUndefined()
  })

  it("never opens a window when no bound is declared", () => {
    expect(
      foldQueueWedge(undefined, { specimen: SPECIMEN, blockedMs: BOUND * 10, standDownMs: undefined }),
    ).toBeUndefined()
  })
})

describe("ruling on a closed window", () => {
  it("serves while the window is still open", () => {
    expect(decideQueueWedge(foldRun(HABITANT_QUEUE_WEDGE_OBSERVATIONS - 1, BOUND))).toEqual({ kind: "serve" })
  })

  it("serves when there is no window at all", () => {
    expect(decideQueueWedge(undefined)).toEqual({ kind: "serve" })
  })

  it("stands down once the window closes, carrying the specimen and the durations", () => {
    expect(decideQueueWedge(foldRun(HABITANT_QUEUE_WEDGE_OBSERVATIONS, BOUND + 1))).toEqual({
      kind: "stand-down",
      specimen: SPECIMEN,
      blockedMs: BOUND + 1,
      standDownMs: BOUND,
      observations: HABITANT_QUEUE_WEDGE_OBSERVATIONS,
    })
  })

  it("exits on a code the supervisor must not restart", () => {
    // The whole andon: this exit is the alarm edge, and a supervisor that
    // restarted it would erase the alarm by answering it.
    expect(HABITANT_EXIT["queue-wedged"]).toBe(14)
    expect(HABITANT_EXIT_DISPOSITION["queue-wedged"]).toBe("stand-down")
  })
})
