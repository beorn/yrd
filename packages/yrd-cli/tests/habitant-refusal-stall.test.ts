/**
 * @failure A habitant runner whose own process state went stale refuses EVERY candidate forever — 106 consecutive cycles over 1h44m while a by-hand preflight said FRESH-NOOP for the same PRs — and never restarts itself, freezing main until an operator sends SIGINT.
 * @level l1
 * @consumer @yrd/cli habitant runner
 */
import { describe, expect, it } from "vitest"
import { foldRefusalStall, HABITANT_REFUSAL_STALL_CYCLES, type HabitantRefusalStall } from "../src/refusal-remedy.ts"
import { followQueueRuns } from "../src/run.ts"
import { createHabitantHarness } from "./support/habitant-harness.ts"

const HEAD = "1".repeat(40)
const OTHER = "2".repeat(40)

function refusing(count: number, prs: readonly string[] = ["PR1800", "PR1802"]) {
  return {
    runs: 0,
    refusals: prs.map((pr) => ({ pr, code: "recut-certificate", count })),
    heads: Object.fromEntries(prs.map((pr) => [pr, HEAD])),
  }
}

function stallAfter(cycles: number, prs?: readonly string[]): HabitantRefusalStall | undefined {
  let window: HabitantRefusalStall | undefined
  for (let cycle = 1; cycle <= cycles; cycle += 1) window = foldRefusalStall(window, refusing(cycle, prs))
  return window
}

describe("habitant refusal stall — an all-candidate refusal loop with an unchanged world is poisoned observer state", () => {
  it("counts consecutive cycles in which every candidate is refused and nothing is admitted", () => {
    expect(stallAfter(1)?.cycles).toBe(1)
    expect(stallAfter(2)?.cycles).toBe(2)
    expect(stallAfter(106)?.cycles).toBe(106)
  })

  it("reaches the restart threshold only after the configured run of identical cycles", () => {
    expect(stallAfter(HABITANT_REFUSAL_STALL_CYCLES - 1)?.cycles).toBeLessThan(HABITANT_REFUSAL_STALL_CYCLES)
    expect(stallAfter(HABITANT_REFUSAL_STALL_CYCLES)?.cycles).toBe(HABITANT_REFUSAL_STALL_CYCLES)
  })

  it("resets the moment a run is produced — a runner that admits anything is not blind", () => {
    const window = foldRefusalStall(stallAfter(40), { ...refusing(41), runs: 1 })

    expect(window).toBeUndefined()
  })

  it("resets when the refusal ledger empties", () => {
    expect(foldRefusalStall(stallAfter(40), { runs: 0, refusals: [], heads: {} })).toBeUndefined()
  })

  it("resets when the refused PR SET changes — that is a different world, not a repeat", () => {
    const window = foldRefusalStall(stallAfter(40), refusing(41, ["PR1800", "PR1802", "PR1807"]))

    expect(window?.cycles).toBe(1)
  })

  it("resets when a refused PR moves to a new head — the PR changed, so the refusal is fresh evidence", () => {
    const window = foldRefusalStall(stallAfter(40), {
      ...refusing(41),
      heads: { PR1800: HEAD, PR1802: OTHER },
    })

    expect(window?.cycles).toBe(1)
  })

  it("resets when a refusal code changes — a different refusal is a different observation", () => {
    const window = foldRefusalStall(stallAfter(40), {
      runs: 0,
      refusals: [
        { pr: "PR1800", code: "recut-certificate", count: 41 },
        { pr: "PR1802", code: "authored-gitlink", count: 41 },
      ],
      heads: { PR1800: HEAD, PR1802: HEAD },
    })

    expect(window?.cycles).toBe(1)
  })

  it("resets when the ledger did NOT advance — this cycle refused nothing, so it is not a repeat", () => {
    // Same PRs, same heads, same codes, but the counts stood still: the compose
    // never reached those candidates this cycle (a paused queue, a busy peer).
    // Counting it would let an idle runner accumulate a phantom stall.
    const window = foldRefusalStall(stallAfter(40), refusing(40))

    expect(window?.cycles).toBe(1)
  })
})

/** A habitant whose compose always succeeds structurally (no throw) but never
 * admits anything, against a refusal ledger that keeps advancing — the exact
 * shape of specimen 3. */
function habitantHarness(refusing: boolean, stopAfter = Number.POSITIVE_INFINITY) {
  let cycles = 0
  const harness = createHabitantHarness({
    bays: { pr: (id: string) => ({ id, revs: [{ n: 1, head: HEAD }] }) },
    state: () => ({
      bays: { prs: { PR1800: { id: "PR1800", revs: [{ n: 1, head: HEAD }] } } },
      queues: {
        admissionRefusals: refusing
          ? {
              PR1800: {
                pr: "PR1800",
                code: "recut-certificate",
                reason: "yrd: PR 'PR1800' recut tree certificate does not match revision 1",
                count: cycles,
                firstAt: "2026-07-27T00:00:00.000Z",
                lastAt: "2026-07-27T00:00:00.000Z",
              },
            }
          : {},
      },
    }),
    run: async () => {
      cycles += 1
      if (cycles >= stopAfter) harness.drain()
      return []
    },
  })
  return { ...harness, cycles: () => cycles }
}

describe("habitant refusal stall — the runner restarts itself instead of looping for hours", () => {
  it("exits UNCLEAN with the evidence once the all-candidate refusal run hits the threshold", async () => {
    const h = habitantHarness(true)

    // 3 = the unclean/interrupted exit code; `restart: on-failure` re-execs.
    await expect(followQueueRuns(h.app, [], { interval: 1 }, h.io, h.gate)).resolves.toBe(3)

    // Restarts on the threshold cycle itself, not one later.
    expect(h.cycles()).toBe(HABITANT_REFUSAL_STALL_CYCLES)
    expect(h.warnings).toContainEqual(
      expect.objectContaining({
        props: expect.objectContaining({
          action: "resident-refusal-stall-restart",
          cycles: HABITANT_REFUSAL_STALL_CYCLES,
          prs: ["PR1800"],
        }),
      }),
    )
  })

  it("never restarts an idle runner — an empty refusal ledger is not a stall", async () => {
    // Spins well past the threshold with nothing refusing, then stops the
    // ordinary way (exit 0), never the poisoned-observer way.
    const h = habitantHarness(false, HABITANT_REFUSAL_STALL_CYCLES * 3)

    await expect(followQueueRuns(h.app, [], { interval: 1 }, h.io, h.gate)).resolves.toBe(0)

    expect(h.cycles()).toBeGreaterThan(HABITANT_REFUSAL_STALL_CYCLES)
    expect(h.warnings.filter((warning) => warning.props.action === "resident-refusal-stall-restart")).toEqual([])
  })
})
