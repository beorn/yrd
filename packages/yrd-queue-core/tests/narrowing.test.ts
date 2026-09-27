/**
 * @failure A failed check's malformed final marker is silently ignored or stale scope is used for base attribution.
 * @level l1
 * @consumer Yrd settled-base failure attribution (#26180)
 * @testonly none
 *
 * What a check offers its own base run, as the queue reads it off the log.
 *
 * The defect these cases stand against (hh-dev, run q-20260910T063044822Z-41b0c4ff):
 * a merge-phase check took 5.3 min and named ONE candidate-attributable test
 * id; the settled-base run that exists only to ask "is that id red here too?"
 * then re-ran the identical full plan for another 4.7 min. Every case here
 * asserts on the reading — including the three ways a present offer is
 * REFUSED rather than quietly read as absent, since a defect folded into an
 * absence is a base phase nobody can tell apart from the ordinary one.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { BASE_NARROWING_MARKER, narrowingOf, readNarrowing } from "../src/narrowing.ts"

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

/** A log file holding `text`, at a path of its own. */
function logOf(text: string): string {
  const root = mkdtempSync(join(tmpdir(), "yrd-narrowing-"))
  roots.push(root)
  const path = join(root, "check.log")
  writeFileSync(path, text)
  return path
}

const offer = (payload: string): string => `${BASE_NARROWING_MARKER} ${payload}`

describe("the scope a check offers its base run", () => {
  it("reads the names and values off the marker line", () => {
    const read = readNarrowing(
      ["running the check", offer('{"env":{"YRD_SETTLED_BASE_AFFECTED_IDS":"first,second"}}'), ""].join("\n"),
    )

    expect(read).toEqual({ env: { YRD_SETTLED_BASE_AFFECTED_IDS: "first,second" }, kind: "narrowed" })
  })

  it("takes the LAST offer, never a merge of two", () => {
    const read = readNarrowing(
      [
        offer('{"env":{"YRD_SETTLED_BASE_AFFECTED_IDS":"first","OTHER":"kept-in-the-first"}}'),
        offer('{"env":{"YRD_SETTLED_BASE_AFFECTED_IDS":"second"}}'),
      ].join("\n"),
    )

    // A merge would produce a scope neither line named: the check's last word
    // describes the run just judged, and OTHER belonged to a superseded one.
    expect(read).toEqual({ env: { YRD_SETTLED_BASE_AFFECTED_IDS: "second" }, kind: "narrowed" })
  })

  it("is absent when the check offers nothing, which is every check that does not know about this", () => {
    expect(readNarrowing("just a check writing its output\nand exiting\n")).toEqual({ kind: "none" })
    expect(readNarrowing("")).toEqual({ kind: "none" })
    // The marker as a substring of ordinary output is not an offer: the line
    // must START with it, or a check that quotes this file's name in an error
    // message would be narrowing its own base run.
    expect(readNarrowing(`see ${BASE_NARROWING_MARKER} for the format\n`)).toEqual({ kind: "none" })
  })

  it.each([
    ["not JSON at all", "not json", "is not JSON"],
    ["JSON that is not an object", "[1,2]", "is not an object"],
    ["an object with no env", '{"files":["a.test.ts"]}', "`env` is not an object"],
    ["an env naming nothing", '{"env":{}}', "`env` names nothing"],
    ["a name the environment cannot carry", '{"env":{"not a name":"x"}}', "not a usable environment name"],
    ["one of the queue's own statements", '{"env":{"YRD_BASE_SHA":"deadbeef"}}', "the queue's own statement"],
    ["a reserved name", '{"env":{"PATH":"/evil"}}', "the queue's own statement"],
    ["a value that is not a string", '{"env":{"ONLY":42}}', "is not a string"],
    ["the scope assertion", '{"env":{"YRD_CHECK_SCOPE":"settled-base-attribution"}}', "the queue's own statement"],
  ])("refuses %s, and says so rather than reading it as absent", (_case, payload, why) => {
    const read = readNarrowing(offer(payload))

    expect(read.kind).toBe("refused")
    expect(read.kind === "refused" ? read.why : "").toContain(why)
  })

  it("refuses more names than the bound allows", () => {
    const env = Object.fromEntries(Array.from({ length: 9 }, (_value, index) => [`NAME_${String(index)}`, "x"]))

    const read = readNarrowing(offer(JSON.stringify({ env })))

    expect(read.kind).toBe("refused")
    expect(read.kind === "refused" ? read.why : "").toContain("names 9 variables")
  })

  it("refuses a malformed LAST marker even after a usable earlier offer", () => {
    const read = readNarrowing(
      `${offer('{"env":{"YRD_SETTLED_BASE_AFFECTED_IDS":"first"}}')}\n${BASE_NARROWING_MARKER}\n`,
    )
    expect(read.kind).toBe("refused")
    expect(read.kind === "refused" ? read.why : "").toContain("no space")
  })

  it("refuses a tab-delimited last marker instead of using an earlier offer", () => {
    const read = readNarrowing(
      `${offer('{"env":{"YRD_SETTLED_BASE_AFFECTED_IDS":"first"}}')}\n${BASE_NARROWING_MARKER}\tbad\n`,
    )
    expect(read.kind).toBe("refused")
    expect(read.kind === "refused" ? read.why : "").toContain("no space")
  })

  it("refuses a value past the byte bound", () => {
    const read = readNarrowing(offer(JSON.stringify({ env: { ONLY: "x".repeat(4097) } })))

    expect(read.kind).toBe("refused")
    expect(read.kind === "refused" ? read.why : "").toContain("past the 4096-byte bound")
  })
})

describe("the same reading, off the check's log file", () => {
  it("finds the offer at the end of a log longer than the tail it reads", async () => {
    const path = logOf(`${"noise\n".repeat(200_000)}${offer('{"env":{"YRD_SETTLED_BASE_AFFECTED_IDS":"first"}}')}\n`)

    await expect(narrowingOf(path)).resolves.toEqual({
      env: { YRD_SETTLED_BASE_AFFECTED_IDS: "first" },
      kind: "narrowed",
    })
  })

  it("reads an empty log as no offer", async () => {
    await expect(narrowingOf(logOf(""))).resolves.toEqual({ kind: "none" })
  })

  it("refuses a log it cannot open, because the check ran and its log is the queue's own ground", async () => {
    const read = await narrowingOf(join(mkdtempSync(join(tmpdir(), "yrd-narrowing-")), "absent.log"))

    expect(read.kind).toBe("refused")
    expect(read.kind === "refused" ? read.why : "").toContain("could not be opened")
  })
})
