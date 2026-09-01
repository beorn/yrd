/**
 * @failure Since 2026-09-01 every typed refusal that escapes the compose is a
 *          cycle SKIP rather than a habitant death — the fix for two derived-lane
 *          codes that each took the whole queue offline under `restart: "never"`.
 *          That fix is right, and it has no floor: a refusal that is about the
 *          WORLD rather than about one change arrives again on the next cycle,
 *          and the next, forever. The runner logs one warn per cycle and serves
 *          nothing, which reads in every instrument as a healthy process. The
 *          skip bounded the blast radius of a refusal to one cycle and left the
 *          number of cycles unbounded; nothing counts the repeats.
 * @level   l1
 * @consumer @yrd/cli habitant runner · Hab terminal-exit page
 *
 * The bound's own regression. Every assertion here fails against the
 * skip-and-continue behaviour it extends, because that behaviour has no window
 * to fold into and no bound to trip.
 */
import { describe, expect, it } from "vitest"
import { HABITANT_EXIT, HABITANT_EXIT_DISPOSITION } from "../src/habitant-exit.ts"
import {
  decideRefusalLoop,
  foldRefusalLoop,
  HABITANT_REFUSAL_LOOP_CYCLES_ENV,
  HABITANT_REFUSAL_LOOP_DEFAULT_CYCLES,
  habitantRefusalLoopCycles,
  refusalLoopStandDownRow,
  type HabitantRefusalLoopObservation,
  type HabitantRefusalLoopWindow,
} from "../src/habitant-refusal-loop.ts"

const BOUND = HABITANT_REFUSAL_LOOP_DEFAULT_CYCLES
const MEMBER = "PR3111"

const refused = (code: string, pr: string = MEMBER): HabitantRefusalLoopObservation => ({ kind: "refusal", code, pr })
/** A refusal `FailureFact.pr` could not attribute to any single member. */
const nameless = (code: string): HabitantRefusalLoopObservation => ({ kind: "refusal", code, pr: undefined })
const COMPOSED: HabitantRefusalLoopObservation = { kind: "composed" }
const WAITING: HabitantRefusalLoopObservation = { kind: "waiting" }

/** Fold a run of observations, as consecutive cycles would. */
function foldRun(...observations: readonly HabitantRefusalLoopObservation[]): HabitantRefusalLoopWindow | undefined {
  let window: HabitantRefusalLoopWindow | undefined
  for (const observation of observations) window = foldRefusalLoop(window, observation)
  return window
}

/** `count` consecutive cycles lost to the same refusal. */
function lostTo(count: number, observation: HabitantRefusalLoopObservation = refused("derived-submit-moved")) {
  return foldRun(...Array.from({ length: count }, () => observation))
}

describe("habitant refusal loop — counting the cycles one refusal costs", () => {
  it("counts consecutive cycles lost to the SAME code on the SAME member", () => {
    expect(lostTo(1)?.cycles).toBe(1)
    expect(lostTo(2)?.cycles).toBe(2)
    expect(lostTo(97)?.cycles).toBe(97)
  })

  it("keys the window on the code AND the member, never on the message", () => {
    // The message is what a reader reaches for first and the one field that
    // must not key anything: a derived-lane refusal quotes the branch head, so
    // its message changes on every push while the refusal is the same refusal.
    // Two observations that differ only in prose are one streak.
    const window = lostTo(3)
    expect(window).toMatchObject({ code: "derived-submit-moved", pr: MEMBER, cycles: 3 })
    expect(Object.keys(window ?? {}).toSorted()).toEqual(["code", "cycles", "pr"])
  })

  it("restarts the count when a DIFFERENT code starts a streak", () => {
    expect(
      foldRun(refused("derived-submit-moved"), refused("derived-submit-moved"), refused("authored-gitlink")),
    ).toMatchObject({ code: "authored-gitlink", cycles: 1 })
  })

  it("restarts the count when the same code moves to a DIFFERENT member", () => {
    // One code refusing five members in turn is five changes being refused,
    // which is the queue working. Counting it as one streak would stand the
    // runner down on a busy day.
    expect(foldRun(refused("authored-gitlink", "PR1"), refused("authored-gitlink", "PR2"))).toMatchObject({
      pr: "PR2",
      cycles: 1,
    })
  })

  it("keeps an unattributable refusal in its own streak, never continuing a member's", () => {
    // `FailureFact.pr` absent means "not attributable to a single member",
    // which is a different fact from "attributable to a member we did not
    // name". A nameless refusal must not extend PR3111's window.
    expect(foldRun(refused("some-code"), nameless("some-code"))).toMatchObject({ pr: undefined, cycles: 1 })
    expect(foldRun(nameless("some-code"), refused("some-code"))).toMatchObject({ pr: MEMBER, cycles: 1 })
    expect(foldRun(nameless("some-code"), nameless("some-code"))?.cycles).toBe(2)
  })

  it("CLOSES the window as soon as a cycle composes at all", () => {
    // The whole premise is that the runner is serving nothing. One composed
    // cycle falsifies it, whatever refused before or refuses after.
    expect(foldRun(...Array.from({ length: BOUND }, () => refused("derived-submit-moved")), COMPOSED)).toBeUndefined()
    expect(foldRun(refused("x"), refused("x"), COMPOSED, refused("x"))?.cycles).toBe(1)
  })
})

describe("habitant refusal loop — healthy waiting is not a lost cycle", () => {
  it("neither advances nor clears the window while the runner waits", () => {
    // A busy queue, a locked journal and a settlement race are the runner
    // correctly declining to act on a world that is mid-change. Counting them
    // would stand the runner down for being polite; clearing on them would let
    // one busy tick launder an unbounded refusal loop, and a queue busy every
    // other tick would never trip the bound.
    expect(foldRun(refused("x"), WAITING, refused("x"))?.cycles).toBe(2)
    expect(foldRun(WAITING, WAITING)).toBeUndefined()
    expect(foldRun(refused("x"), WAITING, WAITING)?.cycles).toBe(1)
  })

  it("trips the bound across interleaved waiting, because the refusal never stopped", () => {
    let window: HabitantRefusalLoopWindow | undefined
    for (let cycle = 0; cycle < BOUND; cycle += 1) {
      window = foldRefusalLoop(window, refused("derived-submit-moved"))
      window = foldRefusalLoop(window, WAITING)
    }
    expect(decideRefusalLoop(window).kind).toBe("stand-down")
  })
})

describe("habitant refusal loop — ruling on the window", () => {
  it("serves while the streak is SHORT of the bound", () => {
    expect(decideRefusalLoop(undefined)).toEqual({ kind: "serve" })
    expect(decideRefusalLoop(lostTo(BOUND - 1))).toEqual({ kind: "serve" })
  })

  it("stands down AT the bound, naming the code, the member and the count", () => {
    const action = decideRefusalLoop(lostTo(BOUND))
    expect(action).toEqual({
      kind: "stand-down",
      code: "derived-submit-moved",
      pr: MEMBER,
      cycles: BOUND,
      bound: BOUND,
    })
  })

  it("honours an explicit bound, and treats 0 as disabled", () => {
    expect(decideRefusalLoop(lostTo(3), 3).kind).toBe("stand-down")
    expect(decideRefusalLoop(lostTo(3), 4).kind).toBe("serve")
    // Visible-only: the per-cycle warns stay, nothing stands down.
    expect(decideRefusalLoop(lostTo(9_999), 0)).toEqual({ kind: "serve" })
    expect(decideRefusalLoop(lostTo(9_999), -1)).toEqual({ kind: "serve" })
  })

  it("defaults the bound to twenty cycles", () => {
    expect(HABITANT_REFUSAL_LOOP_DEFAULT_CYCLES).toBe(20)
  })
})

describe("habitant refusal loop — the row a stand-down leaves behind", () => {
  it("names the code, the member, the count and the bound", () => {
    const action = decideRefusalLoop(lostTo(BOUND))
    if (action.kind !== "stand-down") throw new Error("expected a stand-down")
    const row = refusalLoopStandDownRow(action)
    expect(row.props).toMatchObject({
      action: "resident-refusal-loop-stand-down",
      code: "derived-submit-moved",
      pr: MEMBER,
      cycles: BOUND,
      bound: BOUND,
    })
    // A reader who sees only the sentence must still learn all four.
    expect(row.message).toContain("derived-submit-moved")
    expect(row.message).toContain(MEMBER)
    expect(row.message).toContain(String(BOUND))
  })

  it("says so plainly when the refusal names no member", () => {
    const action = decideRefusalLoop(lostTo(BOUND, nameless("some-code")))
    if (action.kind !== "stand-down") throw new Error("expected a stand-down")
    const row = refusalLoopStandDownRow(action)
    expect(row.props.pr).toBeUndefined()
    expect(row.message).toMatch(/no single member|unattributed/u)
  })
})

describe("habitant refusal loop — the declared bound", () => {
  it("names the knob a host sets", () => {
    expect(HABITANT_REFUSAL_LOOP_CYCLES_ENV).toBe("YRD_RESIDENT_REFUSAL_LOOP_CYCLES")
  })

  it("defaults when unset or empty", () => {
    expect(habitantRefusalLoopCycles({})).toBe(BOUND)
    expect(habitantRefusalLoopCycles({ [HABITANT_REFUSAL_LOOP_CYCLES_ENV]: "  " })).toBe(BOUND)
  })

  it("reads a declared bound, including the 0 that disables the stand-down", () => {
    expect(habitantRefusalLoopCycles({ [HABITANT_REFUSAL_LOOP_CYCLES_ENV]: "5" })).toBe(5)
    expect(habitantRefusalLoopCycles({ [HABITANT_REFUSAL_LOOP_CYCLES_ENV]: " 0 " })).toBe(0)
  })

  it.each(["nope", "-1", "2.5", "20 cycles"])("RAISES on the unparseable value %s rather than defaulting", (raw) => {
    // Same reason the source-staleness and RSS knobs raise: an operator who
    // disabled a stand-down and silently got the default instead would learn
    // about it from an unexplained exit.
    expect(() => habitantRefusalLoopCycles({ [HABITANT_REFUSAL_LOOP_CYCLES_ENV]: raw })).toThrow(
      HABITANT_REFUSAL_LOOP_CYCLES_ENV,
    )
  })
})

describe("habitant refusal loop — its place in the exit taxonomy", () => {
  it("exits 15 and stands down, because a successor meets the same refusal", () => {
    // Not `restart-with-backoff`. The refusal is a verdict about the world the
    // runner reads, not about the runner: a fresh process re-reads the same
    // journal, re-derives the same member, and is refused the same way. Pacing
    // it only sets how often we rediscover that.
    expect(HABITANT_EXIT["refusal-loop"]).toBe(15)
    expect(HABITANT_EXIT_DISPOSITION["refusal-loop"]).toBe("stand-down")
  })
})
