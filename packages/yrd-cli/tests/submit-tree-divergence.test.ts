/**
 * @failure A submit gates the WORKING TREE while recording a REF that does not
 *          contain it, so a required check passes on content the queue will
 *          never carry.
 * @level   l1
 * @consumer @i/1-see-what-happened/23102-unmeasured-claims
 */
import { describe, expect, test } from "vitest"
import { submitTreeDivergenceRefusal } from "../src/run.ts"

/**
 * Measured 2026-08-21 by @fleet on PR1546, and the mechanism confirmed in the
 * source afterwards:
 *
 *   submitRequiredCheckContexts()  ->  branch === currentBranch ? { cwd } : { cwd, ref }
 *   runRequiredChecks(..., ref)    ->  ref undefined means "run against the working tree"
 *
 * So submitting the branch you are STANDING ON gates your worktree, while the
 * record names the pushed ref. @fleet had committed with `git commit --amend`
 * and not pushed: the checks read three inventory rows that were present
 * locally and ABSENT from the sha the record named, and reported the manifest
 * truthful plus a +2 identity delta that existed only in the unpushed rows.
 *
 * The other branch of that ternary is why it looked unreproducible: submitting
 * a branch you are NOT on passes a ref, and the checks correctly read the
 * pushed content (@ci, PR1547 from a bay holding a different branch).
 */
describe("a submit must not gate a tree the recorded ref does not contain", () => {
  test("refuses when local HEAD differs from the ref that will be recorded", () => {
    const refusal = submitTreeDivergenceRefusal("work/seat-liveness-fixes", "8651d9f064cc", "b06109bb9800")

    expect(refusal).toBeDefined()
    // Both shas on the line: the author is the only one who can tell these
    // apart today, and only by knowing to run `git show <ref>:<path>` on a
    // hunch. Naming them is what removes the hunch.
    expect(refusal).toContain("8651d9f064cc")
    expect(refusal).toContain("b06109bb9800")
    expect(refusal).toContain("work/seat-liveness-fixes")
  })

  test("names the consequence, not just the mismatch", () => {
    const refusal = submitTreeDivergenceRefusal("work/x", "aaaaaaaaaaaa", "bbbbbbbbbbbb") ?? ""

    // A bare "HEAD differs from origin" invites a shrug. The reason it matters
    // is that the CHECKS read the tree while the RECORD names the ref, so a
    // green verdict would describe content the queue cannot carry.
    expect(refusal).toMatch(/push/iu)
    expect(refusal).toMatch(/check|gate|verdict/iu)
  })

  test("permits the aligned case", () => {
    expect(submitTreeDivergenceRefusal("work/x", "cafebabe1234", "cafebabe1234")).toBeUndefined()
  })

  test("does not refuse when either sha is unreadable", () => {
    // Deliberate, and narrow: an unresolvable ref is not THIS check's business
    // — a branch with no pushed ref fails later in submit, naming itself. What
    // this check must never do is invent a mismatch from a failed read, which
    // would turn a git hiccup into a refusal nobody can act on.
    expect(submitTreeDivergenceRefusal("work/x", undefined, "cafebabe1234")).toBeUndefined()
    expect(submitTreeDivergenceRefusal("work/x", "cafebabe1234", undefined)).toBeUndefined()
    expect(submitTreeDivergenceRefusal("work/x", undefined, undefined)).toBeUndefined()
  })
})
