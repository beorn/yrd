/**
 * @failure `yrd queue pause --help` and `resume --help` describe only checking
 *          and merging, and say nothing about ADMISSION — while the only place
 *          the pause is actually ENFORCED is `submit`. Two readers built
 *          opposite plans on that silence.
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
 * A pause refuses `submit` — `requireResumed` is called from exactly one place,
 * `submit.ts`, and the refusal's own text already says "to admit and merge work
 * again". The help said only "checking and merging", so a plan of the shape
 * "submit while paused, resume when it lands" reads as supported and deadlocks:
 * the submit is refused by the very pause that is waiting for it.
 *
 * Measured 2026-09-11: thirteen minutes of fleet-wide queue downtime, two
 * readers, one sentence.
 */
describe("the pause help says what a pause actually refuses", () => {
  // Matched on the PROMISE, not on a keyword. A bare /submit|admit/ alternation
  // passes on any sentence that happens to contain the word — mutation control
  // caught exactly that: stripping "refuse new submissions" left a later clause
  // mentioning submit, and the test stayed green over a description that no
  // longer said what a pause does.
  it("pause states that submissions are REFUSED, not only that checking and merging stop", async () => {
    const text = description(await help("queue", "pause"))
    expect(text).toMatch(/refuses?\s+new\s+submissions/iu)
    expect(text).toContain("checking and merging")
  })

  it("resume states that submissions are ADMITTED again, so the pair reads the same way", async () => {
    const text = description(await help("queue", "resume"))
    expect(text).toMatch(/admits?\s+submissions|admit\s+submissions/iu)
    expect(text).toContain("checking and merging")
  })

  it("NEGATIVE CONTROL: a command a pause does NOT refuse says nothing about admission", async () => {
    // `list` reads a paused queue perfectly well — the service keeps it visible.
    // Without this, the tests above would pass on a help text that sprayed the
    // word "submit" across every command.
    const text = description(await help("queue", "list"))
    expect(text).not.toMatch(/refuses? (new )?submissions?/iu)
  })
})
