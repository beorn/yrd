/**
 * @failure A queue-authored submodule composition is in the round journal but absent from the change detail.
 * @level l2 (journal reader and headless watch detail)
 * @consumer the operator reading a composed change in yrd watch
 * @testonly none
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { render } from "silvery/test"
import { journalKey, readJournals, runId, type Row } from "@yrd/queue-core"
import { WatchDetail } from "../src/watch-detail.tsx"
import { MinuteContext, NowContext } from "../src/watch-clock.ts"
import { runOf } from "../src/watch-run.ts"
import { journalRun } from "../../../tests/support/journal-run.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const HEAD = "a".repeat(40)
const PLAIN = "b".repeat(40)
const BASE = "1".repeat(40)
const MAIN = "2".repeat(40)
const PIN = "3".repeat(40)
const COMPOSED = "4".repeat(40)

function fixtureJournal() {
  const dir = mkdtempSync(join(tmpdir(), "yrd-watch-composed-"))
  roots.push(dir)
  const now = new Date()
  const id = runId(now)
  const at = now.toISOString()
  const rows = [
    { kind: "run", run: id, at },
    { kind: "change", run: id, at, branch: "task/composed", head: HEAD, decision: "merged" },
    { kind: "settle", run: id, at, branch: "task/composed", head: HEAD, state: "merged", path: "vendor/yrd", base: BASE, from: MAIN, to: PIN, merged: COMPOSED },
    { kind: "change", run: id, at, branch: "task/plain", head: PLAIN, decision: "merged" },
    { kind: "change", run: id, at, branch: "task/malformed", head: PIN, decision: "merged" },
    { kind: "settle", run: id, at, branch: "task/malformed", head: PIN, state: "merged", path: "vendor/yrd", from: MAIN, to: PIN, merged: COMPOSED },
  ]
  writeFileSync(join(dir, `${id}.jsonl`), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)
  return readJournals(dir, { now })
}

describe("composed pins in watch", () => {
  it("projects complete composed settle rows, omits absent ones, and reports malformed rows", () => {
    const journals = fixtureJournal()
    const composed = journals.runs.get(journalKey("task/composed", HEAD))?.[0]
    const plain = journals.runs.get(journalKey("task/plain", PLAIN))?.[0]
    const malformed = journals.runs.get(journalKey("task/malformed", PIN))?.[0]
    expect(composed?.compositions).toEqual([{ path: "vendor/yrd", base: BASE, from: MAIN, to: PIN, merged: COMPOSED }])
    expect(plain?.compositions).toBeUndefined()
    expect(malformed?.compositions).toBeUndefined()
    expect(journals.malformed).toEqual([
      expect.objectContaining({ key: journalKey("task/malformed", PIN), message: expect.stringMatching(/settle.*vendor\/yrd.*base/u) }),
    ])
  })

  it("shows Composed with the journal's path and base, main and composed pins only when present", async () => {
    const now = new Date("2026-09-27T11:30:00.000Z")
    const row: Row = { branch: "task/composed", head: HEAD, since: now, state: "merged", subject: "a composed change" }
    const makeDetail = (compositions?: readonly { path: string; base: string; from: string; to: string; merged: string }[]) => ({
      checks: [],
      row,
      run: runOf(row, "main", [], "q-20260927T113000000Z-test"),
      journal: journalRun({
        at: now,
        branch: row.branch,
        head: row.head,
        id: "q-20260927T113000000Z-test",
        startedAt: now,
        ...(compositions === undefined ? {} : { compositions }),
      }),
    })
    async function linesOf(compositions?: readonly { path: string; base: string; from: string; to: string; merged: string }[]) {
      const app = render(
        <NowContext.Provider value={now}>
          <MinuteContext.Provider value={now}>
            <WatchDetail detail={makeDetail(compositions)} selected="changes" />
          </MinuteContext.Provider>
        </NowContext.Provider>,
        { cols: 160, rows: 45 },
      )
      await app.waitForLayoutStable()
      const text = app.text
      app.unmount()
      return text
    }
    const composed = await linesOf([{ path: "vendor/yrd", base: BASE, from: MAIN, to: PIN, merged: COMPOSED }])
    expect(composed).toContain("Composed")
    expect(composed).toContain("vendor/yrd")
    expect(composed).toContain(BASE)
    expect(composed).toContain(MAIN)
    expect(composed).toContain(COMPOSED)
    expect(await linesOf()).not.toContain("Composed")
  })
})
