/**
 * @failure `yrd queue pause --help` and `resume --help` say one thing about
 *          SUBMISSIONS while the queue does another. Once, the help was silent
 *          and the queue refused; two readers built opposite plans on that
 *          silence and the fleet's queue sat down for thirteen minutes
 *          (2026-09-11). Since the andon (operator 2026-09-16) a stopped line
 *          ACCEPTS submissions — they wait behind the stop — so help that still
 *          promised a refusal would send a submitter to wait for a resume that
 *          nothing needs.
 * @level   l1 (pure help rendering, no queue and no network)
 * @consumer anyone planning work around a paused queue
 */

import { describe, expect, it } from "vitest"

import { runYrdProcess } from "../src/cli.ts"
import type { YrdCliIO } from "../src/types.ts"

function capture(): Readonly<{ io: YrdCliIO; out(): string }> {
  let text = ""
  const io: YrdCliIO = {
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
 * The COMMAND's own description, which is everything between the usage line and
 * the `Options:` block. Scoped deliberately: asserting against the whole help
 * blob matches option descriptions too, and mutation control caught that —
 * dropping "checking and merging" from the pause description left the `--reason`
 * option's own help still carrying the phrase, and the assertion stayed green
 * over the sentence it was meant to pin.
 */
function description(text: string): string {
  const body = text.split(/^Options:/mu)[0] ?? ""
  return body.replace(/^Usage:.*$/mu, "")
}

/**
 * A pause stops checking and merging and ADMITS submissions: `submit` reads the
 * stop only to echo it (who, why, and what lifts it). The help must say both
 * halves, in the words a planner reads before choosing to wait.
 */
describe("the pause help says what a pause does to submissions", () => {
  // Matched on the PROMISE, not on a keyword. A bare /submit|admit/ alternation
  // passes on any sentence that happens to contain the word, and mutation
  // control caught exactly that on 2026-09-11.
  it("pause states that submissions are still ACCEPTED while checking and merging stop", async () => {
    const text = description(await help("queue", "pause"))
    expect(text).toMatch(/accepts?\s+(new\s+)?submissions/iu)
    expect(text).not.toMatch(/refuses?\s+(new\s+)?submissions/iu)
    expect(text).toContain("checking and merging")
  })

  it("resume states that checking and merging start again, and never that submissions were refused", async () => {
    const text = description(await help("queue", "resume"))
    expect(text).toContain("checking and merging")
    expect(text).not.toMatch(/admits?\s+submissions\s+again/iu)
  })

  it("NEGATIVE CONTROL: a command a pause does NOT refuse says nothing about admission", async () => {
    // `list` reads a paused queue perfectly well — the service keeps it visible.
    // Without this, the tests above would pass on a help text that sprayed the
    // word "submit" across every command.
    const text = description(await help("queue", "list"))
    expect(text).not.toMatch(/refuses? (new )?submissions?/iu)
  })
})
