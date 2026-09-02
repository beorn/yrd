/**
 * @failure Git's transcript prints at DEBUG, so a debug log of one queue run is
 * a git transcript with the queue's own decisions buried in it. Measured
 * 2026-09-02 on the boundary fixture's merging case: 537 rows, of which 405
 * were the git command wrapper's own two rows per invocation — a finish line
 * and a span — leaving the six kinds a reader wants at 2% of the file. The
 * plan's M2 row says "git chatter at trace".
 * @level l2
 * @consumer the mechanic reading a garage queue run at `LOG_LEVEL=debug`
 */
import { describe, expect, it } from "vitest"
import { isGitInvocation } from "../src/index.ts"

describe("git chatter is recognised by the one wrapper every command goes through", () => {
  it.each([
    ["git", true],
    ["/usr/bin/git", true],
    ["/nix/store/1k2lblqlj39azh6wn1sffa2869vrg3mr-git-2.54.0/bin/git", true],
  ])("%s is git", (executable, expected) => {
    expect(isGitInvocation([executable, "rev-parse", "HEAD"])).toBe(expected)
  })

  it.each([
    // OUR commands, which a reader at debug should see run. `git-super` is the
    // cross-submodule wrapper and `git-yrd` is the CLI's own second spelling;
    // neither is plumbing, and a substring match would have swallowed both.
    ["git-super", false],
    ["/repo/bin/git-yrd", false],
    ["sh", false],
    ["bun", false],
    // A check whose own name mentions git is a CHECK.
    ["/repo/scripts/check-gitlinks", false],
  ])("%s is not git", (executable, expected) => {
    expect(isGitInvocation([executable, "--version"])).toBe(expected)
  })

  it("an empty argv is not a git invocation", () => {
    expect(isGitInvocation([])).toBe(false)
  })
})
