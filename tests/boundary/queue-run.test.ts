/**
 * @failure The queue-run boundary is described in prose and pinned nowhere, so
 *          a rebuild of the queue can change what one pass tells its caller —
 *          the exit code, whether the base moved, whether a refused change's
 *          refs survive — and every existing test still passes. Those three
 *          facts are the entire contract a supervisor, a CI wrapper and an
 *          author read; nothing else about a pass is observable from outside.
 * @level   l3
 * @consumer `yrd queue run --once` · Hab supervision · any caller of the CLI
 *
 * Black box, deliberately. A test here may read the process exit code, the
 * refs the repositories carry afterwards, and the tip of the base — and
 * nothing else. The check itself is a fake whose exit code and duration the
 * test picks (`fake-check.sh`), so each case names one outcome and the queue
 * is never reached into to stage it.
 *
 * This file encodes the DESIGN the queue is being rebuilt to, not today's
 * behaviour. Where the two disagree the test stays red and says so in its
 * name; see the `design-red` case below.
 */
import { afterEach, describe, expect, it } from "vitest"
import {
  baseTip,
  boundaryRepository,
  firstParentDistance,
  parentsOf,
  queueRunOnce,
  refs,
  removeScratchRoots,
  submitOneCommit,
} from "./fixture.ts"

afterEach(removeScratchRoots)

describe("the queue-run boundary: one pass, three observable facts", { timeout: 120_000 }, () => {
  it("exit 0 — a passing check lands the branch, and the base moves by exactly one merge commit", async () => {
    const { repo, checkLog } = await boundaryRepository({ exit: 0 })
    const { branch, headSha } = await submitOneCommit(repo, "green")
    const before = await baseTip(repo)

    const run = await queueRunOnce(repo)

    expect(run.exitCode, run.report).toBe(0)

    // The check really ran — an exit 0 that skipped the work would satisfy
    // every assertion below on an empty pass.
    expect(await Bun.file(checkLog).text(), run.report).toContain("fake-check exit=0")

    const after = await baseTip(repo)
    expect(after, run.report).not.toBe(before)
    // Exactly one merge commit, and its second parent is the branch head: the
    // base advanced by one first-parent step, and that step is the merge.
    expect(await firstParentDistance(repo, before, after), run.report).toBe(1)
    expect(await parentsOf(repo, after), run.report).toEqual([before, headSha])
    expect(branch).toBe("task/green")
  })

  it("exit 0 — an empty queue is nothing to do, and the base stands still", async () => {
    const { repo } = await boundaryRepository({ exit: 0 })
    const before = await baseTip(repo)

    const run = await queueRunOnce(repo)

    expect(run.exitCode, run.report).toBe(0)
    expect(await baseTip(repo), run.report).toBe(before)
  })

  it("exit 1 — a failing check leaves the base where it was and the branch's refs standing", async () => {
    const { repo, checkLog } = await boundaryRepository({ exit: 1 })
    const { branch, headSha } = await submitOneCommit(repo, "red")
    const before = await baseTip(repo)
    const refsBefore = await refs(repo)

    const run = await queueRunOnce(repo)

    // The submitter's content is what failed, so the change is refused and
    // sent back — the pass itself did its job.
    expect(run.exitCode, run.report).toBe(1)
    expect(await Bun.file(checkLog).text(), run.report).toContain("fake-check exit=1")

    expect(await baseTip(repo), run.report).toBe(before)
    // The author's work survives a refusal: the branch still names the commit
    // that was checked, and no ref the submit created was destroyed.
    expect(await refs(repo), run.report).toEqual(expect.arrayContaining([`${headSha} refs/heads/${branch}`]))
    for (const ref of refsBefore) expect(await refs(repo), run.report).toContain(ref)
  })

  // design-red — M2 of the garage plan moves this from today's code to the
  // design. The design says an ERROR is the queue failing at its own job, so
  // it gets its own code, 2: distinct from 0 (every attempted check passed)
  // and from 1 (the submitter's content was refused).
  //
  // The gap M2 closes is TWO gaps, and measuring the three triggers the design
  // names separates them (this harness, 2026-09-02, against 193e03f6):
  //
  //   check exits 2        exit 1   code check-failed     — send-back
  //   check missing        exit 1   code check-failed     — send-back
  //   check past its bound exit 17  code check-timeout    — yrd-broken
  //
  // 1. CLASSIFICATION. Only the bound reaches the queue's own failure class.
  //    A check that exits 2, and a check that is not there at all, are booked
  //    against the author's content — the pass refuses the change and tells
  //    the author to amend it, for a condition the author cannot fix.
  // 2. THE NUMBER. Even the trigger that IS classified as yrd's own failure
  //    answers 17, not 2. That one is deliberate, not an oversight:
  //    `outcome-notify.ts` records that "the design called this 2" and spends
  //    17 instead, because 2 is already the generic usage/configuration exit
  //    of every Yrd verb.
  //
  // So M2 must rule on both: which conditions are the queue's fault, and what
  // number that verdict carries. Until it does, this stays red and visible
  // rather than skipped.
  it("exit 2 — a check that ERRORs stops the pass, base unchanged, branch untouched [design-red]", async () => {
    const { repo, checkLog } = await boundaryRepository({ exit: 2 })
    const { branch, headSha } = await submitOneCommit(repo, "error")
    const before = await baseTip(repo)
    const refsBefore = await refs(repo)

    const run = await queueRunOnce(repo)

    expect(run.exitCode, run.report).toBe(2)

    // Nothing retried inside the run: the ERROR stopped the pass, so the check
    // ran once and no more.
    const attempts = (await Bun.file(checkLog).text()).trimEnd().split("\n").filter(Boolean)
    expect(attempts, run.report).toHaveLength(1)

    expect(await baseTip(repo), run.report).toBe(before)
    expect(await refs(repo), run.report).toEqual(expect.arrayContaining([`${headSha} refs/heads/${branch}`]))
    for (const ref of refsBefore) expect(await refs(repo), run.report).toContain(ref)
  })
})
