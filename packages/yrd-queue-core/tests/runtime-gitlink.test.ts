import { relative, sep } from "node:path"

import { describe, expect, test } from "vitest"

import { runtimeGitlinkPath } from "../src/runtime-gitlink.ts"

/**
 * @failure  M7's relaunch exit — "the round that merges my own gitlink is the
 *           last one this code runs" — has been OFF in production since M8, so
 *           no yrd change goes live until a person restarts the service by hand,
 *           and nothing anywhere says so (@i/10-yrd/24515).
 * @level    l1 (paths in, decision out)
 * @consumer the loop's own relaunch, and everyone whose landed change is not
 *           actually running
 *
 * THE PRODUCTION CONFIGURATION IS THE FIRST CASE, deliberately. No test covered
 * it: the old answer asked whether the runtime sits inside the QUEUE checkout,
 * every test placed it there, and M8 moved the queue into its own clone without
 * anyone noticing the answer depended on that colocation.
 */
describe("where this runtime's own gitlink lives", () => {
  // The real deployment, measured 2026-09-11: the service loads yrd from the
  // shared checkout while the queue works from its own clone.
  const RUNTIME = "/hh/dev/vendor/yrd"
  const SUPERPROJECT = "/hh/dev"

  test("THE PRODUCTION CASE: the runtime is a submodule of a checkout the queue is not in", () => {
    expect(runtimeGitlinkPath(RUNTIME, SUPERPROJECT)).toEqual({ kind: "gitlink", path: "vendor/yrd" })
  })

  // The pre-M8 colocated case must keep working: this is a fix, not a swap.
  test("a runtime inside the queue's own checkout still resolves", () => {
    expect(runtimeGitlinkPath("/w/repo/vendor/yrd", "/w/repo")).toEqual({ kind: "gitlink", path: "vendor/yrd" })
  })

  test("a nested path keeps every segment", () => {
    expect(runtimeGitlinkPath("/hh/dev/a/b/yrd", "/hh/dev")).toEqual({ kind: "gitlink", path: "a/b/yrd" })
  })

  test("a trailing-whitespace superproject, as git's own output arrives", () => {
    expect(runtimeGitlinkPath(RUNTIME, `${SUPERPROJECT}\n`)).toEqual({ kind: "gitlink", path: "vendor/yrd" })
  })

  describe("and when it does not live in one, the answer says WHY", () => {
    // A standalone clone genuinely has no gitlink to watch. That is the one
    // legitimate `off`, and it must still be legible rather than silent.
    test("no superproject at all", () => {
      const off = runtimeGitlinkPath("/home/x/yrd", undefined)
      expect(off.kind).toBe("off")
      expect(off).toMatchObject({ reason: "no-superproject" })
      expect("why" in off && off.why).toContain("/home/x/yrd")
      expect("why" in off && off.why).toContain("standalone clone")
    })

    test("an empty superproject, which is what git prints when nothing records it", () => {
      expect(runtimeGitlinkPath("/home/x/yrd", "")).toMatchObject({ reason: "no-superproject" })
      expect(runtimeGitlinkPath("/home/x/yrd", "  \n")).toMatchObject({ reason: "no-superproject" })
    })

    // A superproject that does not contain the checkout it reported is a broken
    // world, and the answer says so instead of quietly disarming.
    test("a superproject that does not contain the runtime", () => {
      const off = runtimeGitlinkPath("/elsewhere/yrd", "/hh/dev")
      expect(off).toMatchObject({ reason: "runtime-outside-superproject" })
      expect("why" in off && off.why).toContain("/hh/dev")
    })

    test("the runtime IS the superproject", () => {
      expect(runtimeGitlinkPath("/hh/dev", "/hh/dev")).toMatchObject({ reason: "runtime-outside-superproject" })
    })
  })

  /**
   * THE REPRODUCTION, kept in the suite rather than in a commit message.
   *
   * This is the OLD predicate, reproduced exactly as it stood at
   * queue-core-commands.ts:1078-1083 — `relative(queueCheckout, runtime)`,
   * off when the result escapes. Run against the measured production inputs it
   * answers OFF, which is the defect; run against the pre-M8 colocated inputs
   * it answers correctly, which is why nobody noticed for a month.
   *
   * It stays here because "the old code was wrong" is a claim, and a claim
   * about deleted code cannot be checked by anyone reading later.
   */
  describe("the defect, reproduced", () => {
    const oldAnswer = (queueCheckout: string, runtime: string): "off" | string => {
      const path = relative(queueCheckout, runtime).split(sep).join("/")
      return path === "" || path === ".." || path.startsWith("../") ? "off" : path
    }

    const QUEUE_CLONE = "/hh/var/yrd-workdir/github.com/beorn/hh-dev%23main/repo"

    test("the OLD answer is off for the production configuration", () => {
      expect(oldAnswer(QUEUE_CLONE, RUNTIME)).toBe("off")
    })

    test("the NEW answer is the gitlink for those same inputs", () => {
      expect(runtimeGitlinkPath(RUNTIME, SUPERPROJECT)).toEqual({ kind: "gitlink", path: "vendor/yrd" })
    })

    // Why it survived M8 unnoticed: before the queue moved to its own clone,
    // the old predicate was RIGHT. The change that broke it touched neither
    // this function nor any test of it.
    test("the OLD answer was correct while the queue ran from the repository it checked", () => {
      expect(oldAnswer("/w/repo", "/w/repo/vendor/yrd")).toBe("vendor/yrd")
    })
  })

  /**
   * THE REGRESSION GUARD, and it is the whole bead in one assertion. The queue
   * checkout is not passed to this function AT ALL. It cannot be: an answer
   * that depends on where the queue happens to be working is the defect, and
   * the signature is what makes that unrepresentable rather than merely
   * discouraged.
   */
  test("the decision cannot depend on where the queue is working", () => {
    expect(runtimeGitlinkPath.length).toBe(2)
    // The same runtime resolves the same way whatever clone the queue uses,
    // because the queue is not an input.
    expect(runtimeGitlinkPath(RUNTIME, SUPERPROJECT)).toEqual(runtimeGitlinkPath(RUNTIME, SUPERPROJECT))
  })

  // Every `off` carries a reason code AND prose. The code is for a fact in the
  // health document; the prose is for the person the page wakes.
  test.each([
    [runtimeGitlinkPath("/home/x/yrd", undefined)],
    [runtimeGitlinkPath("/elsewhere/yrd", "/hh/dev")],
  ])("an off decision is legible, not a bare undefined", (off) => {
    expect(off.kind).toBe("off")
    expect("reason" in off && off.reason).toMatch(/^[a-z-]+$/u)
    expect("why" in off && String(off.why).length).toBeGreaterThan(40)
    expect("why" in off && off.why).toContain("the relaunch exit is off")
  })
})
