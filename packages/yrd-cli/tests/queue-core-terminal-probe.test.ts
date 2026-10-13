/**
 * @failure A source-changed projection was rebuilt while its round's writer could still grow the journal, or was never repaired after the writer died.
 * @level l1 (a journal file and a judged liveness; no Git)
 * @consumer the queue's read path, which repairs only a journal proven terminal
 * @testonly none
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runTerminalProbe } from "../src/queue-core-commands.ts"

// Each row names its OWN run id: the probe remembers a terminal run for the whole
// process, so a shared id would let one row's verdict answer another's question.
const LIVE_ID = "main@live@2026-09-03T20:00:00.000Z"
const DEAD_ID = "main@dead@2026-09-03T20:00:00.000Z"
const ABSENT_ID = "main@absent@2026-09-03T20:00:00.000Z"
const PRESENT_ID = "main@present@2026-09-03T20:00:00.000Z"
const NOPID_ID = "main@nopid@2026-09-03T20:00:00.000Z"
const UNREADABLE_ID = "main@unreadable@2026-09-03T20:00:00.000Z"

const roots: string[] = []
const dir = (): string => {
  const root = mkdtempSync(join(tmpdir(), "yrd-terminal-probe-"))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

/** A run journal file whose header names `pid`, enough for the header-pid fallback. */
function journal(dir: string, id: string, header: Record<string, unknown>): void {
  writeFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify({ kind: "run", ...header })}\n`)
}

const DEAD_PID = 2_000_000_000
const NO_CLAIM = "origin refs/yrd/main/runner is absent"

describe("the terminality probe handed to the reader (28918)", () => {
  /** @failure The claim showed a live runner and a source-changed artifact was snapshotted over mid-growth. @level l1 */
  it("leaves every run alone while the claim shows a live runner", () => {
    const left: string[] = []
    const probe = runTerminalProbe({ kind: "live" }, dir(), (message) => left.push(message))
    expect(probe(LIVE_ID)).toBe(false)
    expect(left).toEqual([])
  })

  /** @failure A dead runner's finished journal kept reading source-changed forever. @level l1 */
  it("proves every run terminal once the claim shows a dead runner", () => {
    const left: string[] = []
    const probe = runTerminalProbe({ kind: "dead", why: "runner h/7: PID absent" }, dir(), (message) =>
      left.push(message),
    )
    expect(probe(DEAD_ID)).toBe(true)
    // No journal file was needed for the second one: a dead runner cannot be writing any round.
    expect(probe("main@dead2@2026-09-03T21:00:00.000Z")).toBe(true)
    expect(left).toEqual([])
  })

  /** @failure With no claim, a run whose own writer pid is gone was never repaired. @level l1 */
  it("proves a run terminal when no claim is published and its header pid is gone", () => {
    const root = dir()
    journal(root, ABSENT_ID, { pid: DEAD_PID })
    const left: string[] = []
    const probe = runTerminalProbe({ kind: "unknown", why: NO_CLAIM }, root, (m) => left.push(m))
    expect(probe(ABSENT_ID)).toBe(true)
    expect(left).toEqual([])
  })

  /** @failure A RECYCLED pid was read as terminal, licensing a rebuild over a journal that could still grow. @level l1 */
  it("leaves a run alone and reports it when no claim is published and its header pid is present", () => {
    const root = dir()
    journal(root, PRESENT_ID, { pid: process.pid })
    const left: string[] = []
    const probe = runTerminalProbe({ kind: "unknown", why: NO_CLAIM }, root, (m) => left.push(m))
    expect(probe(PRESENT_ID)).toBe(false)
    expect(left).toEqual([
      `run ${PRESENT_ID}: source-changed, left alone — ${NO_CLAIM}; PID ${String(process.pid)} is present, so its writer may still be finishing`,
    ])
  })

  /** @failure A journal naming no pid was guessed terminal, rebuilding an artifact on no evidence. @level l1 */
  it("leaves a run alone and reports it when its header names no pid", () => {
    const root = dir()
    journal(root, NOPID_ID, { base: "aaa" })
    const why = "runner h/9: claim records no start identity to compare"
    const left: string[] = []
    const probe = runTerminalProbe({ kind: "unknown", why }, root, (m) => left.push(m))
    expect(probe(NOPID_ID)).toBe(false)
    expect(left).toEqual([`run ${NOPID_ID}: source-changed, left alone — ${why}; its journal names no pid to judge`])
  })

  /** @failure An unreadable header refused the whole read, or was read as terminal. @level l1 */
  it("leaves a run alone and reports it when its header cannot be read", () => {
    const root = dir()
    const why = "runner h/9: PID absent"
    const left: string[] = []
    const probe = runTerminalProbe({ kind: "unknown", why }, root, (m) => left.push(m))
    expect(probe(UNREADABLE_ID)).toBe(false)
    expect(left).toHaveLength(1)
    expect(left[0]).toContain(`run ${UNREADABLE_ID}: source-changed, left alone — ${why}; its header could not be read`)
  })
})
