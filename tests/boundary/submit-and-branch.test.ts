/**
 * @failure The way in is prose. `yrd queue submit` is described as one atomic
 *          push of a branch and its opened fact, a bare `git push yrd` is
 *          described as not a change (E2), and a branch that is deleted or
 *          pushed over is described as ending its change without a message —
 *          none of it pinned. A core that pushes the branch but not the fact,
 *          that judges or opens a standing ref nobody submitted, or that bills
 *          a submitter for taking their own branch out passes every existing
 *          test.
 * @level   l3
 * @consumer `yrd queue submit` · a submitter pushing with plain git · `yrd queue run`
 *
 * Area B of the M4 gate: the submit path and the branch, written from
 * /hh/pm/@i/10-yrd/plan.md § The final design and nothing else. Black box —
 * exit codes, the refs both repositories carry afterwards, the commits on a
 * change ref, the target's tip, and what the notifier was handed.
 *
 * Every test carries a `today:` marker measured against the old core on
 * 2026-09-02 at yrd main fce445eb. Red is the expected result at this
 * milestone: it is where the old core disagrees with the design.
 *
 * Two readings the plan left open are recorded at the tests that depend on
 * them: the `.yrd.yml` key that names the `yrd` remote, and whether the
 * `--force-with-lease` of the submit path is allowed to refuse the branch-name
 * collision the plan says is "never prevented".
 */
import { afterEach, describe, expect, it } from "vitest"
import {
  addYrdRemote,
  amendHead,
  boundaryRepository,
  changeRef,
  changeStandings,
  checkAttempts,
  commitOnBranch,
  factMessages,
  git,
  gitTry,
  notifiedMessages,
  queueRunOnce,
  queueSubmit,
  refExists,
  refs,
  refSha,
  remoteNames,
  removeTemporaryRoots,
  runYrd,
  secondWorkingRepo,
  setSubmitter,
  targetTip,
} from "./fixture.ts"

afterEach(removeTemporaryRoots)

describe("the submit path", { timeout: 120_000 }, () => {
  // today: red — `queue submit` exits 0 but pushes `<branch>:refs/yrd/submit/
  // <branch>` to the `origin` remote. The yrd remote gets no branch, and no
  // ref under `refs/yrd/changes/` is ever written.
  it("one push puts the branch and its opened fact at the yrd remote", async () => {
    const { repo, origin } = await boundaryRepository({ exit: 0 })
    await addYrdRemote(repo, origin)
    const branch = "24099-widget"
    const head = await commitOnBranch(repo, branch)

    const submit = await queueSubmit(repo, branch)

    expect(submit.exitCode, submit.report).toBe(0)
    // Both, or neither: the branch is worth nothing to the queue without the
    // fact that opens its change, and the fact names a head that must be there.
    expect(await refSha(origin, `refs/heads/${branch}`), submit.report).toBe(head)
    expect(await refExists(origin, changeRef({ branch: branch, head })), submit.report).toBe(true)
  })

  /**
   * Measured 2026-09-03 on the wrapper: `yrd submit --dry-run` was accepted by
   * the wrapper's own option table, the new core's submit never received it,
   * and the dry run OPENED A REAL CHANGE — `task/owner-field-item13@22b2741a`,
   * two opened facts. An option a command does not implement must refuse; an
   * option it does implement must reach the code that acts on it.
   */
  it("a dry run of the target refuses like the submit, and puts nothing at the remote", async () => {
    const { repo, origin } = await boundaryRepository({ exit: 0 })
    await addYrdRemote(repo, origin)
    const before = await refs(origin)

    const dry = await runYrd(repo, "queue", "submit", "main", "--dry-run")

    expect(dry.exitCode, dry.report).not.toBe(0)
    expect(dry.report).toContain("main is the target, not a change")
    expect(await refs(origin), dry.report).toEqual(before)
  })

  it("a dry run says what it would open and puts nothing at the remote", async () => {
    const { repo, origin } = await boundaryRepository({ exit: 0 })
    await addYrdRemote(repo, origin)
    const branch = "24099-dry"
    const head = await commitOnBranch(repo, branch)
    const before = await refs(origin)

    const dry = await runYrd(repo, "queue", "submit", branch, "--dry-run", "--json")

    expect(dry.exitCode, dry.report).toBe(0)
    expect(JSON.parse(dry.stdout), dry.report).toMatchObject({
      change: `${branch}@${head}`,
      dryRun: true,
      target: "main",
      workItem: "24099",
    })
    // The whole point: the remote is byte-for-byte where it was.
    expect(await refs(origin), dry.report).toEqual(before)
    expect(await refExists(origin, `refs/heads/${branch}`), dry.report).toBe(false)
    expect(await refExists(origin, changeRef({ branch: branch, head })), dry.report).toBe(false)
    // Nor locally: a dry run appends no fact for the next submit to chain onto.
    expect(await refExists(repo, changeRef({ branch: branch, head })), dry.report).toBe(false)
  })

  // today: red — the config refuses the key outright: `error: config remote is
  // not supported`, exit 2. The plan wants `.yrd.yml` to name the remote and
  // today's schema has nowhere to put it.
  //
  // The plan: "It adds the `yrd` remote from `.yrd.yml` when missing." It does
  // not name the key, so the fixture writes `remote:`. If the core names it
  // something else this test is red for the key and not for the rule; the
  // rule it pins is that a repository with no `yrd` remote can still submit.
  it("adds the yrd remote from .yrd.yml when the repository has none", async () => {
    const { repo, origin } = await boundaryRepository({ exit: 0, yrdRemote: true })
    expect(await remoteNames(repo)).not.toContain("yrd")
    const branch = "24099-remote"
    const head = await commitOnBranch(repo, branch)

    const submit = await queueSubmit(repo, branch)

    expect(submit.exitCode, submit.report).toBe(0)
    expect(await remoteNames(repo), submit.report).toContain("yrd")
    expect(await refSha(origin, `refs/heads/${branch}`), submit.report).toBe(head)
  })

  // today: red — the submit writes no change ref, so there are no facts to read.
  //
  // The plan says the opened fact "names the submitter, the time, the target
  // and the work item" and does not give the trailer keys, so this asserts the
  // values are in the fact commit, not where. The time needs no assertion: a
  // commit carries one.
  it("the opened fact names the submitter, the target and the work item", async () => {
    const { repo, origin } = await boundaryRepository({ exit: 0 })
    await addYrdRemote(repo, origin)
    await setSubmitter(repo, "Ada Submitter", "ada@example.invalid")
    const branch = "24099-widget"
    const head = await commitOnBranch(repo, branch, "24099-widget: one commit\n\nResolves: 24099")

    const submit = await queueSubmit(repo, branch)

    expect(submit.exitCode, submit.report).toBe(0)
    expect(await refExists(origin, changeRef({ branch: branch, head })), submit.report).toBe(true)
    const facts = await factMessages(origin, changeRef({ branch: branch, head }))
    // Nothing has judged it yet, so opened is the whole change.
    expect(facts.length, submit.report).toBe(1)
    const opened = facts[0] ?? ""
    expect(opened, submit.report).toContain("opened")
    expect(opened, submit.report).toContain("ada@example.invalid")
    expect(opened, submit.report).toContain("main")
    expect(opened, submit.report).toContain("24099")
  })

  // today: red — `yrd submit` is a verb, and does exactly what `queue submit`
  // does today: `refs/yrd/submit/<branch>` on `origin`, no change ref.
  it("`yrd submit` is the alias, and does the same thing", async () => {
    const { repo, origin } = await boundaryRepository({ exit: 0 })
    await addYrdRemote(repo, origin)
    const branch = "24099-alias"
    const head = await commitOnBranch(repo, branch)

    const submit = await runYrd(repo, "submit", branch)

    expect(submit.exitCode, submit.report).toBe(0)
    expect(await refSha(origin, `refs/heads/${branch}`), submit.report).toBe(head)
    expect(await refExists(origin, changeRef({ branch: branch, head })), submit.report).toBe(true)
  })

  // today: red — the second submit exits 0, but both heads went to the one
  // ref `refs/yrd/submit/<branch>`, so the first head's change is gone.
  it("a new push of the branch is a new head, so a new change, and the first change stays", async () => {
    const { repo, origin } = await boundaryRepository({ exit: 0 })
    await addYrdRemote(repo, origin)
    const branch = "24099-twice"
    const head1 = await commitOnBranch(repo, branch)
    const first = await queueSubmit(repo, branch)
    expect(first.exitCode, first.report).toBe(0)

    const head2 = await commitOnBranch(repo, branch)
    const second = await queueSubmit(repo, branch)

    expect(second.exitCode, second.report).toBe(0)
    expect(await refSha(origin, `refs/heads/${branch}`), second.report).toBe(head2)
    // yrd deletes nothing: the first head's change is still there to read.
    expect(await refExists(origin, changeRef({ branch: branch, head: head1 })), second.report).toBe(true)
    expect(await refExists(origin, changeRef({ branch: branch, head: head2 })), second.report).toBe(true)
  })

  // today: red — the second push is rejected non-fast-forward and the submit
  // exits 1. There is no lease and no force; a rebase cannot be submitted.
  //
  // "pushes a rebased branch with `--force-with-lease`": the head the submitter
  // now has does not descend from the one the remote carries, and it still goes
  // up, because the submitter is the one who moved it.
  it("a rebased head that does not descend from the last one still goes up", async () => {
    const { repo, origin } = await boundaryRepository({ exit: 0 })
    await addYrdRemote(repo, origin)
    const branch = "24099-rebased"
    const head1 = await commitOnBranch(repo, branch)
    const first = await queueSubmit(repo, branch)
    expect(first.exitCode, first.report).toBe(0)

    const head2 = await amendHead(repo, branch, "24099-rebased: rewritten")
    const descends = await gitTry(repo, "merge-base", "--is-ancestor", head1, head2)
    expect(descends.exitCode, "the amended head must not descend from the old one").not.toBe(0)

    const second = await queueSubmit(repo, branch)

    expect(second.exitCode, second.report).toBe(0)
    expect(await refSha(origin, `refs/heads/${branch}`), second.report).toBe(head2)
    expect(await refExists(origin, changeRef({ branch: branch, head: head1 })), second.report).toBe(true)
    expect(await refExists(origin, changeRef({ branch: branch, head: head2 })), second.report).toBe(true)
  })

  /**
   * The plan says a name collision is "loud, never prevented, because every
   * change records who submitted which head" — so the second submitter's push
   * lands and opens its own change.
   *
   * AMBIGUITY, and the most consequential one in this area: the same section
   * says the submit path "pushes a rebased branch with `--force-with-lease`".
   * A lease is exactly the mechanism that PREVENTS this push — the second
   * submitter has no lease on a branch they never fetched. The two sentences
   * cannot both hold for this case. This test takes the explicit sentence
   * about collisions; if the core takes the lease, this goes red and the
   * design must say which.
   *
   * today: red — the second submitter's push is rejected non-fast-forward and
   * the submit exits 1: today a name collision IS prevented, by accident.
   */
  it("a branch-name collision is not prevented: the second submitter opens their own change", async () => {
    const { repo, origin } = await boundaryRepository({ exit: 0 })
    await addYrdRemote(repo, origin)
    await setSubmitter(repo, "Ada Submitter", "ada@example.invalid")
    const branch = "24099-shared"
    const head1 = await commitOnBranch(repo, branch)
    const first = await queueSubmit(repo, branch)
    expect(first.exitCode, first.report).toBe(0)

    const other = await secondWorkingRepo(origin, "Bo Submitter", "bo@example.invalid")
    const head2 = await commitOnBranch(other, branch)

    const second = await queueSubmit(other, branch)

    expect(second.exitCode, second.report).toBe(0)
    expect(await refSha(origin, `refs/heads/${branch}`), second.report).toBe(head2)
    expect(await refExists(origin, changeRef({ branch: branch, head: head1 })), second.report).toBe(true)
    expect(await refExists(origin, changeRef({ branch: branch, head: head2 })), second.report).toBe(true)
    // Loud is this: each change says who put that head there.
    expect((await factMessages(origin, changeRef({ branch: branch, head: head1 }))).at(-1) ?? "").toContain("ada@example.invalid")
    expect((await factMessages(origin, changeRef({ branch: branch, head: head2 }))).at(-1) ?? "").toContain("bo@example.invalid")
  })

  /**
   * Git refs are file paths, so a ref at a name forbids any ref under it. A
   * change is named `<branch>@<sha>`, and that name is the ref's last part
   * (operator, 2026-09-02): the sha sits inside the branch's last segment, so
   * one change's ref is never a directory of another's, and a branch named
   * like another change's `<branch>/<sha>` — the collision the earlier naming
   * refused — opens its own change beside the first. It is reachable only
   * after the first branch is taken out, because `refs/heads/` refuses the
   * name first while it stands.
   */
  it("a branch named like another change's <branch>/<sha> opens its own change beside it: the change's name is one segment", async () => {
    const { repo, origin } = await boundaryRepository({ exit: 0 })
    await addYrdRemote(repo, origin)
    const branch = "24099-widget"
    const head1 = await commitOnBranch(repo, branch)
    const first = await queueSubmit(repo, branch)
    expect(first.exitCode, first.report).toBe(0)
    const changeTip = await refSha(origin, changeRef({ branch: branch, head: head1 }))
    expect(changeTip, first.report).toBeDefined()

    // Take the branch out, so `refs/heads/` has room for the second name.
    await git(repo, "push", "-q", "yrd", `:${branch}`)

    const other = await secondWorkingRepo(origin, "Bo Submitter", "bo@example.invalid")
    const beside = `${branch}/${head1}`
    const head2 = await commitOnBranch(other, beside)

    const submit = await queueSubmit(other, beside)

    expect(submit.exitCode, submit.report).toBe(0)
    // Both changes stand, each under its own name, and the first is untouched.
    expect(await refExists(origin, `refs/heads/${beside}`), submit.report).toBe(true)
    expect(await refExists(origin, changeRef({ branch: beside, head: head2 })), submit.report).toBe(true)
    expect(await refSha(origin, changeRef({ branch: branch, head: head1 })), submit.report).toBe(changeTip)
  })
})

describe("the branch, moved by hand", { timeout: 120_000 }, () => {
  // today: green, by accident — the old core answers `"results":[]` and runs
  // no check, because a standing ref with no journal record is invisible to
  // it. Ruling E2 (2026-09-02 evening) makes that the rule and withdraws B4:
  // a change exists only when submitted, so a branch pushed with plain git is
  // neither judged nor opened nor alarmed; it stands at the remote, invisible
  // to `queue list`, until `yrd submit` opens it. (Until E2 this test asserted
  // the opposite: that the next queue run opened the change itself, with
  // `Submitter: unknown`.)
  it("a bare `git push yrd <branch>` is not a change: the queue run neither judges nor opens it, and a submit later does (E2)", async () => {
    const { repo, origin, checkLog } = await boundaryRepository({ exit: 0 })
    await addYrdRemote(repo, origin)
    const branch = "24099-bare"
    const head = await commitOnBranch(repo, branch)
    // No yrd command anywhere: the author pushed, that is all.
    await git(repo, "push", "-q", "yrd", branch)

    const run = await queueRunOnce(repo)

    expect(run.exitCode, run.report).toBe(0)
    // Not judged: no check ran. Not opened: no change ref, no fact.
    expect(await checkAttempts(checkLog), run.report).toBe(0)
    expect(await refExists(origin, changeRef({ branch: branch, head })), run.report).toBe(false)
    // Invisible to the table, and nothing lost: the branch stands at the remote.
    expect(
      Object.keys(await changeStandings(repo)).filter((key) => key.startsWith(`${branch}@`)),
      run.report,
    ).toEqual([])
    expect(await refSha(origin, `refs/heads/${branch}`), run.report).toBe(head)

    // The author says so, and only then is it a change.
    const submit = await queueSubmit(repo, branch)

    expect(submit.exitCode, submit.report).toBe(0)
    expect(await refExists(origin, changeRef({ branch: branch, head })), submit.report).toBe(true)
    expect(await changeStandings(repo), submit.report).toHaveProperty(`${branch}@${head}`)
  })

  // today: red — the submit puts nothing at `refs/heads/<branch>`, so there is
  // no branch to take out and no change ref to leave standing.
  it("`git push yrd :<branch>` takes the branch out, and its changes stay", async () => {
    const { repo, origin } = await boundaryRepository({ exit: 0 })
    await addYrdRemote(repo, origin)
    const branch = "24099-withdrawn"
    const head = await commitOnBranch(repo, branch)
    const submit = await queueSubmit(repo, branch)
    expect(submit.exitCode, submit.report).toBe(0)
    expect(await refSha(origin, `refs/heads/${branch}`), submit.report).toBe(head)
    const changeTip = await refSha(origin, changeRef({ branch: branch, head }))
    expect(changeTip, submit.report).toBeDefined()

    await git(repo, "push", "-q", "yrd", `:${branch}`)

    expect(await refExists(origin, `refs/heads/${branch}`)).toBe(false)
    expect(await refSha(origin, changeRef({ branch: branch, head }))).toBe(changeTip)
  })

  /**
   * The submitter took their own branch out, so the change is over and nobody
   * is told: "ends failed with the reason `deleted` ... and no message, since
   * the submitter did it."
   *
   * AMBIGUITY: the exit rule says a queue run exits 1 "when a change ended
   * failed", and this change ended failed — but nobody was billed and nothing
   * was sent, so 0 reads as right too. The test refuses only 2, which is the
   * one answer both readings rule out: this is not the queue's fault.
   *
   * today: red — the submit puts no branch at the yrd remote and writes no
   * change ref, so there is nothing to delete and nothing to end.
   */
  it("a change whose branch is gone ends failed with the reason `deleted`, and sends nothing", async () => {
    const { repo, origin, notifyLog } = await boundaryRepository({ exit: 0, notify: true })
    await addYrdRemote(repo, origin)
    const branch = "24099-gone"
    const head = await commitOnBranch(repo, branch)
    const submit = await queueSubmit(repo, branch)
    expect(submit.exitCode, submit.report).toBe(0)
    expect(await refSha(origin, `refs/heads/${branch}`), submit.report).toBe(head)
    expect(await refExists(origin, changeRef({ branch: branch, head })), submit.report).toBe(true)
    await git(repo, "push", "-q", "yrd", `:${branch}`)
    const before = await targetTip(repo)

    const run = await queueRunOnce(repo)

    expect(run.exitCode, run.report).not.toBe(2)
    expect(await targetTip(repo), run.report).toBe(before)
    const tip = (await factMessages(origin, changeRef({ branch: branch, head })))[0] ?? ""
    expect(tip, run.report).toContain("failed")
    expect(tip, run.report).toContain("deleted")
    expect(await notifiedMessages(notifyLog), run.report).toBe("")
  })

  /**
   * The branch is still there but points somewhere else, so the change that
   * named the old head is over — `replaced` — and again nobody is told. The
   * head that replaced it was pushed with plain git, so it is not a change
   * (E2): the same queue run neither opens nor judges it.
   *
   * today: red — the submit writes no change ref, so there is nothing to end.
   */
  it("a change whose branch no longer points at its head ends failed with `replaced`, and sends nothing about it", async () => {
    const { repo, origin, notifyLog } = await boundaryRepository({ exit: 0, notify: true })
    await addYrdRemote(repo, origin)
    const branch = "24099-moved"
    const head1 = await commitOnBranch(repo, branch)
    const submit = await queueSubmit(repo, branch)
    expect(submit.exitCode, submit.report).toBe(0)
    expect(await refExists(origin, changeRef({ branch: branch, head: head1 })), submit.report).toBe(true)

    const head2 = await commitOnBranch(repo, branch)
    await git(repo, "push", "-q", "yrd", branch)
    expect(await refSha(origin, `refs/heads/${branch}`)).toBe(head2)

    const run = await queueRunOnce(repo)

    expect(run.exitCode, run.report).not.toBe(2)
    const tip = (await factMessages(origin, changeRef({ branch: branch, head: head1 })))[0] ?? ""
    expect(tip, run.report).toContain("failed")
    expect(tip, run.report).toContain("replaced")
    expect(await notifiedMessages(notifyLog), run.report).not.toContain(head1)
    // The new head is a bare push, so no change was opened for it (E2).
    expect(await refExists(origin, changeRef({ branch: branch, head: head2 })), run.report).toBe(false)
  })
})
