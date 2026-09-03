/**
 * @failure The queue-run boundary is described in prose and pinned nowhere, so
 *          a rebuild of the queue can change what one queue run tells its
 *          caller — the exit code, whether the target moved, whether a failed
 *          change's refs survive — and every existing test still passes. Those
 *          facts are the whole contract a supervisor, a CI wrapper and an
 *          author read; nothing else about a queue run is observable from
 *          outside.
 * @level   l3
 * @consumer `yrd queue run --once` · Hab supervision · any caller of the CLI
 *
 * Black box, deliberately. A test here may read the exit code, the refs the
 * repositories carry afterwards, the tip of the target, and where the CLI says
 * each change stands — nothing else. The check is a fake whose result and
 * duration the test picks (`fake-check.sh`), so each case names one result and
 * the queue is never reached into to stage it.
 *
 * A queue run's result is pass, fail or stuck, as exit 0, 1 or 2. All three
 * are pinned as ordinary tests; the stuck cases stood as `test.fails` until M2
 * made the design hold on 2026-09-02.
 */
import { afterEach, describe, expect, it } from "vitest"
import {
  boundaryRepository,
  changeStandings,
  checkAttempts,
  type FakeCheckPlan,
  firstParentDistance,
  git,
  parentsOf,
  queueRunOnce,
  refs,
  removeScratchRoots,
  submitOneCommit,
  targetTip,
} from "./fixture.ts"

afterEach(removeScratchRoots)

describe("the queue-run boundary", { timeout: 120_000 }, () => {
  it("pass — a check that passes merges the change, and the target moves by one merge commit", async () => {
    const { repo, checkLog } = await boundaryRepository({ exit: 0 })
    const { branch, headSha } = await submitOneCommit(repo, "green")
    const before = await targetTip(repo)

    const run = await queueRunOnce(repo)

    expect(run.exitCode, run.report).toBe(0)

    // The check really ran — an exit 0 that skipped the work would satisfy
    // every assertion below on an empty queue.
    expect(await checkAttempts(checkLog), run.report).toBe(1)

    const after = await targetTip(repo)
    expect(after, run.report).not.toBe(before)
    // Exactly one merge commit, and its second parent is the change's head:
    // the target advanced by one first-parent step, and that step is the merge.
    expect(await firstParentDistance(repo, before, after), run.report).toBe(1)
    expect(await parentsOf(repo, after), run.report).toEqual([before, headSha])
    expect(branch).toBe("task/green")
  })

  it("pass — an empty queue is nothing to do, and the target stands still", async () => {
    const { repo } = await boundaryRepository({ exit: 0 })
    const before = await targetTip(repo)

    const run = await queueRunOnce(repo)

    expect(run.exitCode, run.report).toBe(0)
    expect(await targetTip(repo), run.report).toBe(before)
  })

  it("fail — a check that fails leaves the target where it was and the change's refs standing", async () => {
    const { repo, checkLog } = await boundaryRepository({ exit: 1 })
    const { branch, headSha } = await submitOneCommit(repo, "red")
    const before = await targetTip(repo)
    const refsBefore = await refs(repo)

    const run = await queueRunOnce(repo)

    // The submitter's content is what failed, so the failure is theirs and the
    // queue run itself did its job. The plan proves that before billing: the
    // same check again in the change's worktree and once at the target, three
    // attempts; the incumbent bills on the first.
    expect(run.exitCode, run.report).toBe(1)
    expect(await checkAttempts(checkLog), run.report).toBe(process.env.YRD_BOUNDARY_CORE === "new" ? 3 : 1)

    expect(await targetTip(repo), run.report).toBe(before)
    // The author's work survives: the branch still names the head that was
    // checked, and no ref the submit created was destroyed.
    expect(await refs(repo), run.report).toEqual(expect.arrayContaining([`${headSha} refs/heads/${branch}`]))
    await expectRefsKept(repo, refsBefore, run.report)
  })

  /**
   * A stuck check is the queue's own fault, so the queue run stops at exit 2,
   * nobody is billed, and the change stays where it was until someone fixes the
   * queue. Landed by M2 on 2026-09-02; these three stood as `it.fails` from
   * 9f1fff4e until then, because against 193e03f6 the triggers measured:
   *
   *   check exits 2         exit 1   check-failed    billed to the author
   *   check is not there    exit 1   check-failed    billed to the author
   *   check past its bound  exit 17  check-timeout   billed to yrd
   *
   * Two gaps, both now closed: WHOSE FAULT — a check that exits 2 and a check
   * that is not there are stuck (`check-stuck`, environment-owned), never the
   * author's content; and THE NUMBER — the queue's own fault answers 2, the
   * 17 retired by operator ruling.
   *
   * One measured fact, which is why the standing assertion below cannot carry
   * the "nobody is billed" clause on its own: `pr list` reports a stuck change
   * and a failed change identically, both still `submitted`. The exit code is
   * the ONLY place the two are told apart at this boundary.
   */
  /**
   * No ref the submit created was destroyed. The incumbent's refs stand still;
   * the plan's change ref MOVES FORWARD with every fact (opened, then checked,
   * then ended, then sent), so under the new core the invariant is that every
   * ref name survives and each one's old value is an ancestor of its new one.
   */
  async function expectRefsKept(repo: string, refsBefore: readonly string[], report: string): Promise<void> {
    const after = await refs(repo)
    if (process.env.YRD_BOUNDARY_CORE !== "new") {
      for (const ref of refsBefore) expect(after, report).toContain(ref)
      return
    }
    const now = new Map(after.map((line) => line.split(" ") as [string, string]).map(([sha, name]) => [name, sha]))
    for (const line of refsBefore) {
      const [sha, name] = line.split(" ") as [string, string]
      const current = now.get(name)
      expect(current, `${report}\n${name} was destroyed`).toBeDefined()
      if (current !== undefined && current !== sha) {
        await expect(git(repo, "merge-base", "--is-ancestor", sha, current), `${report}\n${name} moved backwards`).resolves.toBeDefined()
      }
    }
  }

  describe("stuck — the queue's own fault", () => {
    async function stuckCase(plan: FakeCheckPlan, bay: string): Promise<void> {
      const { repo, checkLog } = await boundaryRepository(plan)
      const { branch, headSha } = await submitOneCommit(repo, bay)
      const before = await targetTip(repo)
      const refsBefore = await refs(repo)
      const standingBefore = await changeStandings(repo)

      const run = await queueRunOnce(repo)

      // Exit 2 is the whole billing statement: fail is the submitter's, stuck
      // is the queue's, and nothing else at this boundary separates them.
      expect(run.exitCode, run.report).toBe(2)

      // The queue run STOPS: the check is not retried inside it.
      expect(await checkAttempts(checkLog), run.report).toBeLessThanOrEqual(1)

      // The change stays where it was until someone fixes the queue. The plan's
      // reading names that state: stuck, an ended fact that leaves the change
      // open and bills nobody (the incumbent reports it as still submitted).
      expect(await targetTip(repo), run.report).toBe(before)
      expect(await changeStandings(repo), run.report).toEqual(
        process.env.YRD_BOUNDARY_CORE === "new" ? { ...standingBefore, [`${branch}@${headSha}`]: "stuck" } : standingBefore,
      )
      expect(await refs(repo), run.report).toEqual(expect.arrayContaining([`${headSha} refs/heads/${branch}`]))
      await expectRefsKept(repo, refsBefore, run.report)
    }

    it("a check that exits 2 stops the queue run, and nobody is billed", async () => {
      await stuckCase({ exit: 2 }, "two")
    })

    // A check the author never supplied and cannot supply: the shell's own 127.
    it("a check that is not there stops the queue run, and nobody is billed", async () => {
      await stuckCase({ command: "/nonexistent/definitely-not-a-check.sh" }, "missing")
    })

    it("a check that runs past its bound stops the queue run, and nobody is billed", async () => {
      await stuckCase({ exit: 0, sleepSeconds: 5, timeoutMs: 1000 }, "slow")
    })
  })
})
