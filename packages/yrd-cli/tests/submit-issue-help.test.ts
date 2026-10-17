/**
 * @failure `yrd submit --help` never said WHEN `--issue` is needed. A submitter
 *          whose commits already bind the issue passed the same issue in a second
 *          spelling, and the declared value is compared exactly - so the submit was
 *          refused with a message that named the conflict and nothing else
 *          (25047, filed 2026-09-22 from the 25055 and 24459 refusals). The help
 *          has to say the option is needed only when the commits carry no binding.
 * @level   l1 (pure help rendering, no queue and no network)
 * @consumer anyone deciding whether to pass --issue
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
  // Commander wraps option help at the column width, so a phrase can be split by
  // a newline and its run of spaces; flatten before matching on words.
  return run.out().replace(/\s+/gu, " ")
}

/**
 * Matched on the CONDITION, not on the word `binding` alone: an assertion that
 * merely finds `binding` stays green on help that never says when the option is
 * needed, which is the exact state 25047 was filed from.
 */
describe("the submit help says when --issue is needed", () => {
  it("submit states --issue is needed only when the commits carry no Refs/Resolves binding", async () => {
    const text = await help("queue", "submit")
    expect(text).toMatch(/needed only when the commits carry no Refs\/Resolves binding/u)
    expect(text).toContain("unbound legacy name fallback is reported")
  })
})
