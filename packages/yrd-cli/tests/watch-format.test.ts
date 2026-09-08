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
import {
  boundedHangingLines,
  clock,
  diagnosticLines,
  friendlyPath,
  mediaDuration,
  runShortName,
  stateGlyph,
} from "../src/watch-format.ts"

describe("ref-write diagnostic lines", () => {
  it("names an absent decision only when the run journal was actually read", () => {
    const diagnostic = {
      kind: "change" as const,
      run: "q-one",
      at: "2026-09-06T04:00:00Z",
      reason: "change-ref-contended",
      text: "ref write failed",
      inspect: "git show the-ref",
    }
    const row = { branch: "task/one", head: "abcd", diagnostics: [diagnostic] }
    const journal = {
      id: "q-one",
      branch: row.branch,
      head: row.head,
      startedAt: new Date(diagnostic.at),
      at: new Date(diagnostic.at),
      checks: [],
      diagnostics: row.diagnostics,
    }
    expect(diagnosticLines(row).join("\n")).not.toContain("no run decision recorded")
    expect(diagnosticLines(row, journal).join("\n")).toContain("no run decision recorded")
    expect(diagnosticLines(row, { ...journal, decision: "merged" }).join("\n")).not.toContain(
      "no run decision recorded",
    )
  })

  it("keeps full text and differing inspection fields, and names missing evidence", () => {
    // 24202: raw retention alone cannot prove that the human sees the recorded facts.
    const diagnostic = {
      kind: "change" as const,
      run: "q-one",
      at: "2026-09-06T04:00:00Z",
      reason: "change-ref-taken",
      ref: "refs/changes/task/one",
      text: "ref moved; " + "evidence ".repeat(200),
      next: "git show old-ref",
      inspect: "git show new-ref",
    }
    const row = { branch: "task/one", head: "abcd", diagnostics: [diagnostic] }
    const lines = diagnosticLines(row).join("\n")
    expect(lines).toContain(diagnostic.ref)
    expect(lines).toContain(diagnostic.text)
    expect(lines).toContain("next: git show old-ref")
    expect(lines).toContain("inspect: git show new-ref")
    const embedded = diagnosticLines({
      ...row,
      diagnostics: [{ ...diagnostic, text: "Inspect git show old-ref", inspect: undefined }],
    }).join("\n")
    expect(embedded.match(/git show old-ref/gu)).toHaveLength(1)
    // Older ref-write records stored the warning identity, but no explanation or command.
    for (const text of [undefined, " "]) {
      const legacy = {
        kind: "change" as const,
        run: "q-old",
        at: "2026-09-05T04:00:00Z",
        decision: "sent",
        reason: "change-ref-taken",
        remote: "origin",
        text,
      }
      const degraded = diagnosticLines({ ...row, diagnostics: [legacy] })
      expect(degraded).toHaveLength(2)
      expect(degraded[0]).toContain("task/one@abcd run q-old")
      expect(degraded[0]).toContain("ref-write warning (change-ref-taken)")
      expect(degraded[1]).toBe(
        "The record has no explanation or inspection command (remote: origin). Inspect the stored fields with `yrd list --json`.",
      )
      expect(degraded.join("\n")).not.toContain(JSON.stringify(legacy))
    }
    const withoutCommand = diagnosticLines({
      ...row,
      diagnostics: [{ ...diagnostic, next: undefined, inspect: undefined }],
    }).join("\n")
    expect(withoutCommand).toContain(diagnostic.text)
    expect(withoutCommand).toContain("The record has no inspection command.")
    expect(withoutCommand).not.toContain("no explanation")
  })
})

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

describe("mediaDuration (item 1's `34:23`)", () => {
  it("counts like a media player and steps up past six cells", () => {
    expect(mediaDuration(10_000)).toBe("0:10")
    expect(mediaDuration(34 * 60_000 + 23_000)).toBe("34:23")
    expect(mediaDuration(59 * 60_000 + 59_000)).toBe("59:59")
    // Seven cells no longer fit the column the retired pane sized for six, so an hour steps to `Hh MMm`.
    expect(mediaDuration(3_600_000 + 15 * 60_000)).toBe("1h15m")
    expect(mediaDuration(12 * 3_600_000 + 5 * 60_000)).toBe("12h05m")
    expect(mediaDuration(5 * 86_400_000 + 3 * 3_600_000)).toBe("5d03h")
    expect(mediaDuration(-5)).toBe("0:00")
  })
})
