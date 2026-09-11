/**
 * @failure  A plain `git worktree add|remove` runs for a commit that DOES record
 *           .gitmodules, so the worktree is created with every submodule
 *           unmaterialized and the failure surfaces later as missing files.
 * @level    l1 (pure — the Git handles are stubs; the condition is the subject)
 * @consumer freshWorktree, and closeEnvironment in yrd-cli
 */

import { describe, expect, it } from "vitest"
import type { Git } from "../src/records.ts"
import { worktreeWithoutSubmodules } from "../src/worktree.ts"

// THE INVARIANT IS A CONDITION, NOT A SHAPE (@chief ruling 2026-09-11,
// @hh/tooling/24502). A worktree mutation must cross the git-super adapter when
// the commit declares submodules; a commit that declares none has no boundary to
// cross. A static matcher can prove the code sits in the right branch AS
// WRITTEN; only this can prove it EVERY TIME IT RUNS, including after a refactor
// moves the call out from under the probe.
describe("worktreeWithoutSubmodules proves its own precondition", () => {
  const COMMIT = "d7273ea86df701a590e5b480e7bb1eab2b6145a9"

  function recorder(lsTree: string): { git: Git; calls: string[][] } {
    const calls: string[][] = []
    const git: Git = async (args) => {
      calls.push([...args])
      return args[0] === "ls-tree" ? lsTree : ""
    }
    return { calls, git }
  }

  it("issues the plain mutation when the commit records no .gitmodules", async () => {
    const read = recorder("")
    const mutate = recorder("")

    await worktreeWithoutSubmodules(read.git, mutate.git, COMMIT, ["add", "--detach", "/tmp/wt", COMMIT])

    expect(read.calls).toEqual([["ls-tree", COMMIT, "--", ".gitmodules"]])
    expect(mutate.calls).toEqual([["worktree", "add", "--detach", "/tmp/wt", COMMIT]])
  })

  /**
   * @failure  The guard's whole subject: the plain path runs for a
   *           submodule-bearing commit and stops at the gitlink.
   * @level l1
   */
  it("NEGATIVE CONTROL: refuses, naming the commit, when the commit DOES record .gitmodules", async () => {
    const read = recorder("100644 blob 8f1a…\t.gitmodules")
    const mutate = recorder("")

    await expect(
      worktreeWithoutSubmodules(read.git, mutate.git, COMMIT, ["add", "--detach", "/tmp/wt", COMMIT]),
    ).rejects.toThrow(new RegExp(`refusing a plain git worktree add for ${COMMIT}`, "u"))

    // The refusal happens BEFORE the mutation, not after it.
    expect(mutate.calls).toEqual([])
  })

  it("refuses a removal on the same condition — the verb is not the subject", async () => {
    const read = recorder("100644 blob 8f1a…\t.gitmodules")
    const mutate = recorder("")

    await expect(worktreeWithoutSubmodules(read.git, mutate.git, COMMIT, ["remove", "/tmp/wt"])).rejects.toThrow(
      /refusing a plain git worktree remove/u,
    )
    expect(mutate.calls).toEqual([])
  })

  /**
   * @failure  The probe runs against the repository that owns the registry
   *           rather than one that can read the commit, and answers the wrong
   *           question — `closeEnvironment` reads the TREE and mutates the root.
   */
  it("asks the READ handle about the commit and issues the mutation on the other one", async () => {
    const read = recorder("")
    const mutate = recorder("")

    await worktreeWithoutSubmodules(read.git, mutate.git, COMMIT, ["remove", "/tmp/wt"])

    expect(read.calls.map((call) => call[0])).toEqual(["ls-tree"])
    expect(mutate.calls.map((call) => call[0])).toEqual(["worktree"])
  })
})
