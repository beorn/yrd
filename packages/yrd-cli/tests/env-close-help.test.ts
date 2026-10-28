/**
 * @failure `yrd env close --help` says a queued close "runs the same close
 *          lifecycle" without saying which keeps survive it. The queued
 *          consumer drops the ancestry predicate the automatic sweep applies,
 *          so an ancestry-only keep is closed; a RECORDED hold is checked
 *          first, journaled STALE and the request dropped. On 2026-10-18 a
 *          reader treating every sweep "kept" as a hold had an environment
 *          closed by its standing request.
 * @level   l1 (pure help rendering, no queue and no network)
 * @consumer anyone holding or closing an environment
 * @testonly none
 */

import { describe, expect, it } from "vitest"

import { runYrdProcess } from "../src/cli.ts"
import type { YrdCliIO } from "../src/types.ts"

function capture(): Readonly<{ io: YrdCliIO; out(): string }> {
  let text = ""
  const io: YrdCliIO = {
    localBranchProtections: null,
    stdout: (chunk) => void (text += chunk),
    stderr: (chunk) => void (text += chunk),
    cwd: process.cwd(),
    color: false,
    columns: 120,
  }
  return { io, out: () => text }
}

async function help(...argv: readonly string[]): Promise<string> {
  const run = capture()
  await runYrdProcess(["bun", "yrd", ...argv, "--help"], run.io)
  return run.out()
}

/**
 * The queued-close section itself, not the whole help blob: the command
 * description promises a lifecycle and the `--preserve` option mentions refusal,
 * so a whole-blob match could pass over the sentence this test exists to pin.
 */
function queuedSection(text: string): string {
  return text.split("When this caller's same-UID CWD census cannot read every pid:")[1] ?? ""
}

/**
 * A queued close is consumed under direct admission, which does NOT run the
 * sweep's ancestry check. It does honor a recorded hold: a standing request
 * against an environment whose `current.hold` is not null is journaled STALE
 * and dropped without closing, so the hold stands. The help has to say so
 * before a planner relies on the sweep's "kept" reasoning.
 */
describe("the env close help says what a queued close does to a hold", () => {
  it("names the read-only preview and the removal proofs it cannot perform", async () => {
    const text = await help("env", "close", "/tmp/unused")
    expect(text).toContain("--dry-run")
    expect(text).toMatch(/component custody.*retention.*teardown.*real close/is)
  })

  it("names direct admission, the ancestry-only keep, and the recorded hold", async () => {
    const section = queuedSection(await help("env", "close", "/tmp/unused"))
    expect(section).not.toBe("")
    expect(section).toMatch(/direct admission \(clean, unlocked, no holder\)/i)
    expect(section).toMatch(/without the sweep's ancestry check/i)
    expect(section).toMatch(/kept only for ancestry IS closed by a standing request/i)
    expect(section).toMatch(/recorded hold is not: the request is journaled STALE and dropped/i)
  })
})
