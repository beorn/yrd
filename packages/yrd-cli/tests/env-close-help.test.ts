/**
 * @failure `yrd env close --help` says a queued close "runs the same close
 *          lifecycle" without saying the queued consumer drops the ancestry
 *          predicate the automatic sweep applies. On 2026-10-18 an environment
 *          was placed under a hold while a close request stood against it, and
 *          the next capable round closed it anyway: a reader had no sentence
 *          saying that withdrawing the checkout is not the same as withdrawing
 *          the request.
 * @level   l1 (pure help rendering, no queue and no network)
 * @consumer anyone holding or closing an environment
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
 * sweep's ancestry check. A hold is therefore only a hold once the request is
 * withdrawn, and the help has to say so before a planner relies on the sweep's
 * "kept" reasoning.
 */
describe("the env close help says what a queued close does to a hold", () => {
  it("names direct admission, the missing ancestry check, and withdrawal", async () => {
    const section = queuedSection(await help("env", "close", "/tmp/unused"))
    expect(section).not.toBe("")
    expect(section).toMatch(/direct admission/i)
    expect(section).toMatch(/without the ancestry check/i)
    expect(section).toMatch(/withdraw the request/i)
  })
})
