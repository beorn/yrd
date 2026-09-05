/**
 * @failure  Two glyph tables drifted apart, a home path printed expanded
 *           where the operator asked for `~`, a run's random hex tail read
 *           as a commit beside real shas, and a long command pushed the run
 *           list off a narrow pane (the 2026-08-13 regression the bounded
 *           wrap replaced).
 * @level    l1 (pure functions)
 * @consumer the operator reading `yrd watch` and `yrd queue list`
 */

import { describe, expect, it } from "vitest"
import { runId } from "@yrd/queue-core"
import { boundedHangingLines, clock, friendlyPath, runShortName, stateGlyph } from "../src/watch-format.ts"

describe("the one glyph table", () => {
  it("overlays the working glyph on any state while a check runs, and keeps the state's glyph otherwise", () => {
    expect(stateGlyph({ state: "queued" })).toBe("○")
    expect(stateGlyph({ state: "failed" })).toBe("×")
    expect(
      stateGlyph({ live: { check: "typecheck", phase: "submit", run: "q-x", since: new Date() }, state: "queued" }),
    ).toBe("◉")
  })
})

describe("friendlyPath (items 30a, 33)", () => {
  it("prints a repository under $HOME with ~, the way a shell prompt would", () => {
    expect(friendlyPath("/home/op/repo", "/home/op")).toBe("~/repo")
    expect(friendlyPath("/home/op", "/home/op")).toBe("~")
  })

  it("leaves a path outside $HOME alone, so /hh stays /hh", () => {
    expect(friendlyPath("/hh", "/home/op")).toBe("/hh")
    expect(friendlyPath("/home/operator/x", "/home/op")).toBe("/home/operator/x")
  })
})

describe("runShortName (items 34, 36, 38)", () => {
  it("names a run by its own start instant, never by its random tail", () => {
    const startedAt = new Date(2026, 8, 4, 17, 4, 6)
    const id = runId(startedAt)
    expect(runShortName("main", id)).toBe("main#170406")
    expect(runShortName("main", id)).not.toContain(id.slice(-8))
  })

  it("shows a name that is not one of ours as it is", () => {
    expect(runShortName("main", "garage-7")).toBe("main#garage-7")
  })
})

describe("clock", () => {
  it("prints local wall-clock time with and without seconds", () => {
    const at = new Date(2026, 8, 4, 9, 5, 7)
    expect(clock(at)).toBe("09:05")
    expect(clock(at, { seconds: true })).toBe("09:05:07")
  })
})

describe("boundedHangingLines (item 29)", () => {
  it("wraps whole words to the width and elides past the cap", () => {
    expect(boundedHangingLines("bun yrd queue run --interval 120", 12)).toEqual(["bun yrd", "queue run", "--interval…"])
    expect(boundedHangingLines("bun yrd queue run", 12)).toEqual(["bun yrd", "queue run"])
  })

  it("caps the height and elides, so the run list under it always survives", () => {
    const rows = boundedHangingLines("one two three four five six seven eight nine ten", 9, 2)
    expect(rows).toHaveLength(2)
    expect(rows[1]?.endsWith("…")).toBe(true)
  })

  it("hard-breaks a single word longer than the row", () => {
    expect(boundedHangingLines("abcdefghij", 4, 5)).toEqual(["abcd", "efgh", "ij"])
  })

  it("returns nothing for nothing", () => {
    expect(boundedHangingLines("   ", 10)).toEqual([])
  })
})
