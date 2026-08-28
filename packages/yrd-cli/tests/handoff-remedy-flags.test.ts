/**
 * @failure A refusal's printed remedy prescribes a flag the named command does not have, so the operator retypes a broken command at the exact moment they are blocked — a remedy nobody can run is a refusal with extra steps.
 * @level l1
 * @consumer @yrd/cli bay handoff refusal
 */
import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { handoffBayMissingRemedy } from "../src/run.ts"

const YRD_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

// The remedy prescribes `yrd bay open …`; validate its flags against the LIVE
// help of that exact command, not a hand-copied list that can itself go stale.
function liveBayOpenHelp(): string {
  const result = spawnSync("bun", ["bin/yrd", "bay", "open", "--help"], {
    cwd: YRD_ROOT,
    encoding: "utf8",
  })
  expect(result.status, `bay open --help must be readable to validate the remedy\n${result.stderr}`).toBe(0)
  const help = `${result.stdout}\n${result.stderr}`
  expect(help, "help output must actually enumerate options").toContain("--pr")
  return help
}

function prescribedFlags(remedy: string): string[] {
  // Flags on the remedy's command lines (indented "  yrd …" lines), so prose
  // mentions like "--pr takes the change selector" don't need to re-match — but
  // include them anyway: every flag the remedy NAMES must exist.
  return [...remedy.matchAll(/--[a-z][\w-]*/gu)].map((match) => match[0])
}

describe("handoff-bay-missing remedy prescribes only flags `bay open` really has", () => {
  it("every flag the remedy names appears in live `bay open --help`", () => {
    const help = liveBayOpenHelp()
    const remedy = handoffBayMissingRemedy("task/example", "task/example")
    const flags = prescribedFlags(remedy)
    expect(flags.length, "the remedy is expected to prescribe at least one flag").toBeGreaterThan(0)
    for (const flag of flags) {
      expect(help, `remedy names '${flag}' but live \`bay open --help\` does not declare it`).toContain(flag)
    }
  })

  it("positive control: the validator catches the historical `--branch` remedy (23055 flavour 2)", () => {
    const help = liveBayOpenHelp()
    // The message this refusal shipped with before the fix — kept here as the
    // regression specimen proving this validator is capable of failing.
    const historical = "Open it first:\n  yrd bay open --bay <name> --branch task/example\n"
    const missing = prescribedFlags(historical).filter((flag) => !help.includes(flag))
    expect(missing).toContain("--branch")
  })

  it("the remedy is copy-pasteable: it embeds the packet's branch, not a placeholder", () => {
    const remedy = handoffBayMissingRemedy("task/example", "task/23055-branch")
    expect(remedy).toContain("yrd in <name> -- git switch task/23055-branch")
  })

  it("names no retired flag — the defect this remedy shipped TWICE", () => {
    // Flavour 2 round one prescribed `--branch`, which `bay open` never had.
    // The fix substituted `--pr`, which S7 then retired, so round two was
    // already false when it shipped: the flag is still DECLARED (a runbook
    // reader gets a typed refusal rather than "unknown option"), and
    // `bay open --help` therefore still lists it — which is exactly why the
    // flags-exist check above cannot catch this and this one must exist.
    const remedy = handoffBayMissingRemedy("task/example", "task/23055-branch")
    expect(remedy).not.toContain("--pr")
    expect(remedy).not.toContain("--branch")
  })

  it("prescribes a bay the operator can actually open on their own branch", () => {
    // `bay open --bay <name>` opens the workspace; `yrd in` puts the branch in
    // it. Both live, and the cure is single-sourced with `bay open --pr`'s own
    // retirement message so the next retirement is one edit, not two.
    const remedy = handoffBayMissingRemedy("task/example", "task/23055-branch")
    expect(remedy).toContain("yrd bay open --bay <name>")
    expect(liveBayOpenHelp()).toContain("--bay")
  })
})
