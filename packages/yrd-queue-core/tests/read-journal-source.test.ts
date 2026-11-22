/**
 * @failure A whole journal read folds "no journal on this machine", "nothing in the window" and
 *           "a row could not be read" into one `absent` string inside the value, so an off-host
 *           reader cannot tell a measured empty window from no measurement at all.
 * @level    l1 — a real journal directory written by `openLog`, a regular file standing in for an
 *           unreadable directory, and the real `readJournals` beneath every case.
 * @consumer Yrd locality marking (#28522 slice 2; @cto disposition 6e5624aa)
 * @testonly none
 *
 * ROW 1  A missing directory is `absent`; it is not an empty read.
 * ROW 2  A path this process cannot list (a regular file) is `unreadable` with the sentence.
 * ROW 3  An existing directory with no run journal is `readable` and reports `readable-empty` —
 *        the old `absent` sentence is kept in the value as the fact it is.
 * ROW 4  A real run is `readable` and reports `readable-present`.
 * ROW 5  A journal with one corrupt line is `malformed-partial`, keeps the valid run and names the row.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { safeRemoveSync } from "removely"
import { openLog, readJournalSource, readJournals, type LocalSource } from "../src/index.ts"

const roots: string[] = []

afterAll(() => {
  for (const root of roots) safeRemoveSync(root, { within: tmpdir(), allowMissing: true })
})

function scratch(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `yrd-source-${name}-`))
  roots.push(root)
  return root
}

const AT = new Date("2026-11-21T20:00:00.000Z")
type JournalsValue = Readonly<{ runs: ReadonlyMap<string, unknown>; absent?: string }>

/** The five answers, derived the way a reader derives them: the kind, and emptiness of the value. */
function answer(source: LocalSource<JournalsValue>): string {
  switch (source.kind) {
    case "absent":
    case "unreadable":
    case "malformed-partial":
      return source.kind
    case "readable":
      return source.value.runs.size === 0 ? "readable-empty" : "readable-present"
  }
}

/** One real run journal, written the way the queue writes it. */
function oneRun(dir: string): string {
  const log = openLog(dir, () => AT)
  log.write({ base: "aaa", kind: "run", queue: "q", target: "main" })
  log.write({ branch: "task/source", head: "abc123", kind: "change" })
  return log.id
}

describe("readJournalSource", () => {
  it("marks a missing directory absent", () => {
    const dir = join(scratch("absent"), "logs")
    expect(readJournalSource(dir, { now: AT })).toEqual({ kind: "absent" })
  })

  it("marks a path it cannot list unreadable, with the sentence", () => {
    const dir = join(scratch("unreadable"), "logs")
    writeFileSync(dir, "not a directory\n")
    const source = readJournalSource(dir, { now: AT })
    expect(source.kind).toBe("unreadable")
    if (source.kind !== "unreadable") throw new Error("expected unreadable")
    expect(source.why).toContain("could not be listed")
  })

  it("reads an existing directory with no journal as readable-empty and keeps the old sentence", () => {
    const dir = join(scratch("empty"), "logs")
    mkdirSync(dir, { recursive: true })
    const source = readJournalSource(dir, { now: AT })
    expect(source.kind).toBe("readable")
    expect(answer(source)).toBe("readable-empty")
    if (source.kind !== "readable") throw new Error("expected readable")
    expect(source.value.absent).toContain("it holds no run journal")
  })

  it("reads a real run as readable-present", () => {
    const dir = join(scratch("present"), "logs")
    oneRun(dir)
    const source = readJournalSource(dir, { now: AT })
    expect(answer(source)).toBe("readable-present")
    if (source.kind !== "readable") throw new Error("expected readable")
    expect(source.value.runs.size).toBe(1)
  })

  it("marks a journal with a corrupt line malformed-partial and keeps the valid run", () => {
    const dir = join(scratch("partial"), "logs")
    const run = oneRun(dir)
    writeFileSync(
      join(dir, `${run}.jsonl`),
      `${'{"kind":"run","queue":"q","target":"main","base":"aaa"}\n'}{not json\n`,
      {
        flag: "a",
      },
    )
    const source = readJournalSource(dir, { now: AT })
    expect(source.kind).toBe("malformed-partial")
    if (source.kind !== "malformed-partial") throw new Error("expected malformed-partial")
    expect(source.why).toContain("could not be read")
    expect(source.value.runs.size).toBe(1)
    // The same read through the unmarked reader produced the same facts: this is an ingress, not a second reader.
    expect(readJournals(dir, { now: AT }).runs.size).toBe(source.value.runs.size)
  })
})
