/**
 * @failure Advancing a submodule's gitlink stays a hand-built sequence — a bespoke subject, a
 *          hand-cut branch, a hand-staged gitlink, a hand-driven submit — so no two advances
 *          look alike and each one costs an author the whole composition.
 * @level l3
 * @consumer @i/10-yrd/gitlink-advance-is-one-command
 *
 * Thirteen gitlink-only bumps reached hh main on 2026-08-29/30 and all thirteen were written
 * by hand. The end-to-end case below is the contract that replaces them: ONE invocation, and
 * the message, the Change-Id and the queue position all come back from it.
 *
 * The fixture lives in `gitlink-advance-fixture.ts`; `gitlink-advance-bay.test.ts` asserts
 * the bay this verb hands to the commit is ready for the repository's own hooks.
 */

import { join } from "node:path"
import { failureFact } from "@yrd/core"
import { afterEach, describe, expect, it } from "vitest"
import { gitlinkAdvanceMessage, gitlinkAdvanceName, resolveSubmoduleOperand } from "../src/gitlink-advance.ts"
import {
  cleanupGitlinkFixtures,
  fixtureAdvance as runAdvance,
  gitProbe as git,
  superprojectWithThreeCommitSubmodule,
} from "./gitlink-advance-fixture.ts"

afterEach(cleanupGitlinkFixtures)

/**
 * A refusal read from the JSON envelope, so the assertion names the typed CODE — the stable
 * contract — rather than only the prose a human sees.
 */
async function refusalFrom(repo: string, args: readonly string[]): Promise<{ exit: number; text: string }> {
  const result = await runAdvance(repo, [...args, "--json"])
  return { exit: result.exit, text: `${result.stdout}\n${result.stderr}` }
}

describe("yrd gitlink advance", { timeout: 120_000 }, () => {
  it("settles the whole advance in one invocation: message, Change-Id and queue position", async () => {
    const fixture = await superprojectWithThreeCommitSubmodule()

    const result = await runAdvance(fixture.root, ["gitlink", "advance", "dep"])
    expect(result.exit, `${result.stdout}\n${result.stderr}`).toBe(0)

    // The change id and where it sits — both back from the one call, with no `pr view`.
    expect(result.stdout).toMatch(/PR\d+ queued at position \d+ — advance dep [0-9a-f]{7}\.\.[0-9a-f]{7}/u)

    // The generated commit is real, on the pushed branch, with the generated message.
    const branch = `task/${gitlinkAdvanceName("dep", fixture.main[2])}`
    // Positive control for the pattern the refusal cases below assert is EMPTY: it matches a
    // branch that exists, so an empty result there is evidence and not a mis-typed glob.
    expect(await git(fixture.root, "branch", "--list", "task/advance-*")).not.toBe("")
    const message = await git(fixture.root, "log", "-1", "--format=%B", `refs/heads/${branch}`)
    expect(message).toContain(
      `chore(dep): advance gitlink ${fixture.main[0].slice(0, 7)}..${fixture.main[2].slice(0, 7)}`,
    )
    // The submodule's own first-parent subjects, in order, as the body.
    expect(message).toContain("- submodule: the second thing")
    expect(message).toContain("- submodule: the third thing")
    // Never the commit the gitlink already recorded.
    expect(message).not.toContain("- submodule: the first thing")
    expect(message).toMatch(/^Change-Id: I[0-9a-f]{40}$/mu)

    // And the commit actually moves the gitlink.
    expect(await git(fixture.root, "rev-parse", `refs/heads/${branch}:dep`)).toBe(fixture.main[2])
    // Exactly one commit: a gitlink advance is one gitlink and nothing else.
    expect(await git(fixture.root, "rev-list", "--count", `origin/main..refs/heads/${branch}`)).toBe("1")
    expect(await git(fixture.root, "diff", "--name-only", `origin/main..refs/heads/${branch}`)).toBe("dep")
  })

  it("refuses a target the submodule's main never took, naming min-commit-unpublished and the cure", async () => {
    const fixture = await superprojectWithThreeCommitSubmodule()

    const refusal = await refusalFrom(fixture.root, ["gitlink", "advance", "dep", fixture.offMain])

    expect(refusal.exit).not.toBe(0)
    expect(refusal.text).toContain("min-commit-unpublished")
    expect(refusal.text).toContain("merge it on that submodule's own main first")
    // Nothing was created on the way to the refusal.
    expect(await git(fixture.root, "branch", "--list", "task/advance-*")).toBe("")
  })

  it("refuses a target behind the recorded gitlink rather than composing a backwards bump", async () => {
    const fixture = await superprojectWithThreeCommitSubmodule()
    // Move the recorded gitlink forward to the third commit first.
    await git(join(fixture.root, "dep"), "checkout", "-q", fixture.main[2])
    await git(fixture.root, "add", "dep")
    await git(fixture.root, "commit", "-qm", "record dep at its third commit")
    await git(fixture.root, "push", "-q", "origin", "main")

    const refusal = await refusalFrom(fixture.root, ["gitlink", "advance", "dep", fixture.main[0]])

    expect(refusal.exit).not.toBe(0)
    expect(refusal.text).toContain("gitlink-moves-backward")
    expect(refusal.text).toContain("is behind by 2 commits")
    expect(refusal.text).toContain("re-merge this change onto current main")
    expect(await git(fixture.root, "branch", "--list", "task/advance-*")).toBe("")
  })

  it("--dry-run settles and prints the whole advance, and creates nothing", async () => {
    const fixture = await superprojectWithThreeCommitSubmodule()

    const result = await runAdvance(fixture.root, ["gitlink", "advance", "dep", "--dry-run"])

    expect(result.exit, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain("submodule dep (dep)")
    expect(result.stdout).toContain(`${fixture.main[0]} -> ${fixture.main[2]}`)
    expect(result.stdout).toMatch(/change id {2}I[0-9a-f]{40}/u)
    expect(result.stdout).toContain("chore(dep): advance gitlink")
    // Nothing published, nothing branched, nothing submitted.
    expect(await git(fixture.root, "branch", "--list", "task/advance-*")).toBe("")
    expect(await git(fixture.root, "rev-parse", "HEAD:dep")).toBe(fixture.main[0])
  })

  it("fast-forwards the submodule's own main when the target descends from it", async () => {
    const fixture = await superprojectWithThreeCommitSubmodule()
    const remote = join(fixture.root, "..", "submodule.git")
    expect(await git(remote, "rev-parse", "main")).toBe(fixture.main[2])
    // The target is local to the submodule checkout and has never been pushed anywhere.
    await git(join(fixture.root, "dep"), "fetch", "-q", fixture.submodule, fixture.descendant)

    const result = await runAdvance(fixture.root, ["gitlink", "advance", "dep", fixture.descendant])

    expect(result.exit, `${result.stdout}\n${result.stderr}`).toBe(0)
    // Submodules are `landing: none`, so the verb publishes the min commit itself — and says so.
    expect(await git(remote, "rev-parse", "main")).toBe(fixture.descendant)
    expect(result.stderr).toContain("fast-forwarded dep main")
  })

  it("names every candidate when the operand matches no submodule", async () => {
    const fixture = await superprojectWithThreeCommitSubmodule()

    const refusal = await refusalFrom(fixture.root, ["gitlink", "advance", "vendor/nope"])

    expect(refusal.exit).not.toBe(0)
    expect(refusal.text).toContain("unknown-submodule")
    expect(refusal.text).toContain("records no submodule 'vendor/nope'")
    expect(refusal.text).toContain("it records dep")
  })

  it("refuses when the gitlink is already where the advance would put it", async () => {
    const fixture = await superprojectWithThreeCommitSubmodule()

    const refusal = await refusalFrom(fixture.root, ["gitlink", "advance", "dep", fixture.main[0]])

    expect(refusal.exit).not.toBe(0)
    expect(refusal.text).toContain("gitlink-already-current")
    expect(refusal.text).toContain("nothing to advance")
    expect(await git(fixture.root, "branch", "--list", "task/advance-*")).toBe("")
  })
})

describe("gitlinkAdvanceMessage", () => {
  const from = "a".repeat(40)
  const to = "b".repeat(40)

  it("writes the subject, the submodule's subjects as the body, and the Change-Id trailer", () => {
    const message = gitlinkAdvanceMessage({
      name: "yrd",
      path: "vendor/yrd",
      from,
      to,
      subjects: ["fix(cli): one", "feat(queue): two"],
      changeId: `I${"c".repeat(40)}`,
    })

    expect(message.split("\n")[0]).toBe("chore(yrd): advance gitlink aaaaaaa..bbbbbbb")
    expect(message).toContain("Advances vendor/yrd by 2 commits:")
    expect(message).toContain("- fix(cli): one")
    expect(message).toContain("- feat(queue): two")
    expect(message.trimEnd().split("\n").at(-1)).toBe(`Change-Id: I${"c".repeat(40)}`)
  })

  it("stays singular for one commit and says so plainly when the range is empty", () => {
    expect(gitlinkAdvanceMessage({ name: "km", path: "km", from, to, subjects: ["only"], changeId: "I0" })).toContain(
      "Advances km by 1 commit:",
    )
    expect(gitlinkAdvanceMessage({ name: "km", path: "km", from, to, subjects: [], changeId: "I0" })).toContain(
      `No first-parent commits between ${from} and ${to}.`,
    )
  })
})

describe("resolveSubmoduleOperand", () => {
  const entries = [
    { name: "vendor/yrd", path: "vendor/yrd" },
    { name: "km", path: "km" },
  ]

  it("accepts the full path and the bare name for the same submodule", () => {
    expect(resolveSubmoduleOperand("vendor/yrd", entries)).toEqual({ name: "vendor/yrd", path: "vendor/yrd" })
    expect(resolveSubmoduleOperand("yrd", entries)).toEqual({ name: "vendor/yrd", path: "vendor/yrd" })
    expect(resolveSubmoduleOperand("vendor/yrd/", entries)).toEqual({ name: "vendor/yrd", path: "vendor/yrd" })
  })

  it("refuses an unknown operand by naming what this repository does record", () => {
    try {
      resolveSubmoduleOperand("ag", entries)
      throw new Error("expected a refusal")
    } catch (error) {
      const fact = failureFact(error)
      expect(fact?.code).toBe("unknown-submodule")
      expect(fact?.message).toContain("vendor/yrd, km")
    }
  })

  it("refuses an ambiguous operand instead of guessing", () => {
    try {
      resolveSubmoduleOperand("yrd", [
        { name: "vendor/yrd", path: "vendor/yrd" },
        { name: "yrd", path: "tools/yrd" },
      ])
      throw new Error("expected a refusal")
    } catch (error) {
      expect(failureFact(error)?.code).toBe("ambiguous-submodule")
    }
  })
})
