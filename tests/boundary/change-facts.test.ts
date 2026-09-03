/**
 * @failure A change's facts are the queue's whole store. The plan says a
 *          submit opens `refs/yrd/changes/<branch>@<head>`, that each fact is
 *          one commit written once and never amended, that the ref only moves
 *          forward — opened, then checked, then ended, then sent — and that
 *          the tip fact's trailers are the entire answer for that change.
 *          Nothing today pins any of it, so a core could record a change in a
 *          private store, edit a fact, or answer `queue list` from a walk, and
 *          every existing test would still pass.
 * @level   l3
 * @consumer `yrd queue list` · `yrd queue show` · anyone reading the queue
 *           with plain git · the next queue run, which reads its own writes
 *
 * Written from /hh/pm/@i/10-yrd/plan.md § The final design (Store, The change)
 * and the format it cites, @i/10-yrd/fact-commit-format-2026-09-02. Never from
 * the current source: where the two disagree, this file follows the plan and
 * goes red.
 *
 * Black box. Git is the store the plan names, so `git for-each-ref` and
 * `git log` over `refs/yrd/changes/**` in the shared repository read the
 * published surface. No journal, no database, no module.
 *
 * WHERE THE FACTS ARE READ. The plan says a branch is its ref "at the `yrd`
 * remote" and the change ref lives beside it. The fixture's shared repository
 * is the bare `origin`, and it declares no `yrd` remote, so every assertion
 * here reads the bare one; each report also prints what the working repository
 * carries, so a red case says where the refs actually landed.
 */
import { afterEach, describe, expect, it } from "vitest"
import {
  boundaryRepository,
  type BoundaryRepository,
  type Change,
  type ChangeReading,
  changeRefs,
  commitInBay,
  type FakeCheckPlan,
  git,
  queueRunOnce,
  type QueueRunResult,
  readChange,
  refs,
  removeTemporaryRoots,
  submitFromBay,
  submitOneCommit,
  targetTip,
} from "./fixture.ts"

afterEach(removeTemporaryRoots)

/** git's own empty tree. A genesis commit of one object has this tree. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

/** The six values `Fact:` may carry, and no others. */
const FACT_KINDS = new Set(["opened", "checked", "merged", "failed", "stuck", "sent"])

/** The change's ref out of the shared repository, with the working repository
 * in the report so a red case says where the refs went instead. */
async function readFacts(boundary: BoundaryRepository, change: Readonly<{ branch: string; headSha: string }>) {
  const shared = await readChange(boundary.origin, change)
  const working = await readChange(boundary.repo, change)
  return {
    ...shared,
    report: `--- shared repository ---\n${shared.report}\n--- working repository ---\n${working.report}`,
  } satisfies ChangeReading
}

/** True when `older` is an ancestor of `newer` — how "the ref only moves
 * forward" is checked without asking the ref what it used to be. */
async function isAncestor(repo: string, older: string, newer: string): Promise<boolean> {
  return (await git(repo, "rev-list", "--count", `${newer}..${older}`)) === "0"
}

/** One value per change ref, read with no history walk at all. */
async function tipTrailer(repo: string, key: string): Promise<readonly string[]> {
  const listed = await git(repo, "for-each-ref", `--format=%(trailers:key=${key},valueonly)`, "refs/yrd/changes/**")
  return listed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
}

/** A submitted change on a fresh throwaway repository. */
async function submitted(plan: FakeCheckPlan, bay: string): Promise<{ boundary: BoundaryRepository; change: Change }> {
  const boundary = await boundaryRepository(plan)
  const change = await submitOneCommit(boundary.repo, bay)
  return { boundary, change }
}

/** The queue run's outcome, short. Its `--json` stdout is tens of kilobytes of
 * the old core's own vocabulary, which buries the assertion that failed. */
function runSummary(run: QueueRunResult): string {
  const stderr = run.stderr.trim()
  return `queue run exited ${String(run.exitCode)}${stderr === "" ? "" : `\n--- stderr ---\n${stderr}`}`
}

describe("a change and its facts", { timeout: 120_000 }, () => {
  describe("the change ref", () => {
    // today: red — measured 2026-09-02: after a submit NEITHER repository
    // carries any ref under refs/yrd/. The change's record is a row in the
    // local clone's .git/yrd, so a fresh clone of the shared repository knows
    // nothing about it.
    it("a submit opens refs/yrd/changes/<branch>@<head> in the shared repository", async () => {
      const { boundary, change } = await submitted({ exit: 0 }, "opened")

      const read = await readFacts(boundary, change)

      expect(read.exists, read.report).toBe(true)
      // The branch has a slash in it, which is the case the naming rule exists
      // for: the change's name is the branch then `@` then the head sha, so
      // the sha sits inside the branch's last segment and is read from the right.
      expect(read.ref, read.report).toBe(`refs/yrd/changes/${change.branch}@${change.headSha}`)
      expect(change.branch, read.report).toContain("/")
    })

    // today: red — no change ref, so no fact commit to shape.
    it("the opened fact is one commit: a prose first line, then trailers, one meaning each", async () => {
      const { boundary, change } = await submitted({ exit: 0 }, "shape")

      const read = await readFacts(boundary, change)

      expect(read.exists, read.report).toBe(true)
      expect(read.kinds, read.report).toEqual(["opened"])

      const opened = read.facts[0]
      if (opened === undefined) throw new Error(read.report)
      expect(opened.subject.trim(), read.report).not.toBe("")
      // Line one is prose and is never parsed, so it is not itself a trailer.
      expect(opened.subject, read.report).not.toMatch(/^[A-Za-z][A-Za-z-]*:/)
      // One meaning each: a fact carries exactly one Fact: trailer.
      expect(opened.trailers.get("Fact"), read.report).toEqual(["opened"])
      // One trailer names the change, its branch and its head in one spelling.
      expect(opened.trailers.get("Change"), read.report).toEqual([`${change.branch}@${change.headSha}`])
    })

    // today: red — no change ref, so no submitter, target or work item recorded
    // anywhere a plain git reader can see.
    it("the opened fact names the submitter, the time, the target and the work item", async () => {
      // A branch under the convention `<work item>-<slug>`, so there is a work
      // item to name.
      const { boundary, change } = await submitted({ exit: 0 }, "24101-facts")

      const read = await readFacts(boundary, change)
      expect(read.exists, read.report).toBe(true)
      const opened = read.facts[0]
      if (opened === undefined) throw new Error(read.report)

      expect(opened.trailers.get("Submitter")?.[0] ?? "", read.report).not.toBe("")
      expect(opened.trailers.get("Target")?.[0] ?? "", read.report).toContain("main")
      // The key is the plan's own words (ruling B5: `Work-Item`).
      expect(opened.trailers.get("Work-Item")?.[0] ?? "", read.report).toContain("24101")

      // The time is the commit's own, because position in line is the order of
      // the opened facts by commit time — so it has to be on the commit.
      const when = Number(await git(boundary.origin, "log", "-1", "--format=%ct", opened.sha))
      expect(Math.abs(Date.now() / 1000 - when), read.report).toBeLessThan(600)
    })

    // today: red — no change ref, so no parents to check.
    it("the opened fact's parents are genesis first and the head second, so the head cannot be collected", async () => {
      const { boundary, change } = await submitted({ exit: 0 }, "parents")

      const read = await readFacts(boundary, change)
      expect(read.exists, read.report).toBe(true)
      const opened = read.facts[0]
      if (opened === undefined) throw new Error(read.report)

      expect(opened.parents, read.report).toHaveLength(2)
      expect(opened.parents[1], read.report).toBe(change.headSha)

      const genesis = opened.parents[0] ?? ""
      // One object: no parents of its own, and the empty tree.
      expect(await git(boundary.origin, "rev-list", "--count", genesis), read.report).toBe("1")
      expect(await git(boundary.origin, "rev-parse", `${genesis}^{tree}`), read.report).toBe(EMPTY_TREE)
    })

    // today: red — no change ref to walk.
    it("git log --first-parent on the change ref reads exactly the facts, never the project's history", async () => {
      const { boundary, change } = await submitted({ exit: 0 }, "walk")
      const base = await targetTip(boundary.repo)

      const read = await readFacts(boundary, change)

      expect(read.exists, read.report).toBe(true)
      // One opened fact and the genesis it hangs from. Nothing else.
      expect(read.firstParentLine, read.report).toHaveLength(read.facts.length + 1)
      expect(read.firstParentLine, read.report).not.toContain(change.headSha)
      expect(read.firstParentLine, read.report).not.toContain(base)
    })
  })

  describe("the ref only moves forward", () => {
    // today: red — no change ref, so no fact order to read. Measured: after
    // the merge the WORKING clone carries refs/yrd/candidates/<sha> and
    // refs/yrd/root-merged/<Change-Id>/<run>; the shared repository, where the
    // plan puts the store, still carries no refs/yrd/** at all.
    it("a merged change reads opened, checked, merged, sent, and the merged fact names the merge commit", async () => {
      const { boundary, change } = await submitted({ exit: 0, hooks: true }, "green")

      const run = await queueRunOnce(boundary.repo)
      expect(run.exitCode, runSummary(run)).toBe(0)

      const read = await readFacts(boundary, change)
      const report = `${runSummary(run)}\n${read.report}`
      expect(read.exists, report).toBe(true)
      expect(read.kinds, report).toEqual(["opened", "checked", "merged", "sent"])

      const merged = read.facts[2]
      if (merged === undefined) throw new Error(report)
      expect(merged.trailers.get("Merge")?.[0] ?? "", report).toBe(await targetTip(boundary.repo))
    })

    // today: red — no change ref. A failure leaves no record a git reader can
    // see: queue-run.test.ts measures that `pr list` reports a failed change
    // and a stuck one identically, both still `submitted`.
    it("a failed change ends with one failed fact carrying the check, the fault and the remedy", async () => {
      const { boundary, change } = await submitted({ exit: 1, hooks: true }, "red")

      const run = await queueRunOnce(boundary.repo)
      expect(run.exitCode, runSummary(run)).toBe(1)

      const read = await readFacts(boundary, change)
      const report = `${runSummary(run)}\n${read.report}`
      expect(read.exists, report).toBe(true)
      // Whether a `checked` fact precedes the failure depends on which stage
      // the check ran in, which the plan leaves open for a check that declares
      // no `on:`; the ORDER is the rule, and it holds either way.
      expect(read.kinds.join(">"), report).toMatch(/^opened(>checked)?>failed>sent$/)

      const failed = read.facts.find((fact) => fact.kind === "failed")
      if (failed === undefined) throw new Error(report)
      expect(failed.trailers.get("Check")?.length ?? 0, report).toBeGreaterThan(0)
      expect(failed.trailers.get("Fault")?.[0] ?? "", report).toMatch(/^(submitter|queue)$/)
      expect(failed.trailers.get("Remedy")?.[0] ?? "", report).not.toBe("")
    })

    // today: red — no change ref. The queue run exits 2 (M2 landed that) but
    // writes no ref a reader can see, so nothing records WHY it stopped.
    it("a stuck change ends with one stuck fact and its reason, with no fault line: stuck is always the queue's", async () => {
      const { boundary, change } = await submitted({ exit: 2, hooks: true }, "stuck")

      const run = await queueRunOnce(boundary.repo)
      expect(run.exitCode, runSummary(run)).toBe(2)

      const read = await readFacts(boundary, change)
      const report = `${runSummary(run)}\n${read.report}`
      expect(read.exists, report).toBe(true)
      expect(read.kinds.join(">"), report).toMatch(/^opened(>checked)?>stuck>sent$/)

      const stuck = read.facts.find((fact) => fact.kind === "stuck")
      if (stuck === undefined) throw new Error(report)
      expect(stuck.trailers.get("Fault"), report).toBeUndefined()
      expect(stuck.trailers.get("Reason")?.[0] ?? "", report).not.toBe("")
    })

    // today: red — no change ref, so no parent chain and no merge commit to
    // keep off it.
    it("every fact after the first has one parent, the fact before it, and the merge commit is never a parent", async () => {
      const { boundary, change } = await submitted({ exit: 0, hooks: true }, "chain")

      const run = await queueRunOnce(boundary.repo)
      const read = await readFacts(boundary, change)
      const report = `${runSummary(run)}\n${read.report}`
      expect(read.exists, report).toBe(true)
      expect(read.facts.length, report).toBeGreaterThan(1)

      for (const [index, fact] of read.facts.entries()) {
        if (index === 0) continue
        expect(fact.parents, `${report}\nfact ${String(index)} (${fact.kind})`).toEqual([read.facts[index - 1]?.sha])
      }

      // The merge commit is on the target. Dragging it onto the change ref
      // would drag the whole project history with it.
      const mergeCommit = await targetTip(boundary.repo)
      expect(
        read.facts.flatMap((fact) => fact.parents),
        report,
      ).not.toContain(mergeCommit)
    })

    // today: red — no change ref, so nothing to preserve or to amend.
    it("a queue run only appends: every fact it found is still there, at the same sha, and no ref was deleted", async () => {
      const { boundary, change } = await submitted({ exit: 0, hooks: true }, "append")

      const before = await readFacts(boundary, change)
      expect(before.exists, before.report).toBe(true)
      const refsBefore = await refs(boundary.origin)

      const run = await queueRunOnce(boundary.repo)

      const after = await readFacts(boundary, change)
      const report = `${runSummary(run)}\n--- before ---\n${before.report}\n--- after ---\n${after.report}`
      expect(after.exists, report).toBe(true)
      // Written once, never amended: the earlier facts are the same commits.
      expect(
        after.facts.slice(0, before.facts.length).map((fact) => fact.sha),
        report,
      ).toEqual(before.facts.map((fact) => fact.sha))
      // Forward only.
      expect(await isAncestor(boundary.origin, before.tip, after.tip), report).toBe(true)
      // yrd deletes nothing: every ref name is still there. The target and the
      // change ref moved forward, which is the run's job, not a deletion.
      const names = (lines: readonly string[]): readonly string[] => lines.map((line) => line.split(" ")[1] ?? "")
      const refsAfter = names(await refs(boundary.origin))
      for (const ref of names(refsBefore)) expect(refsAfter, report).toContain(ref)
    })

    // today: red — no change ref, so nothing bounds what a Fact: may say.
    it("every fact commit carries exactly one Fact:, and its value is one of the six", async () => {
      const { boundary, change } = await submitted({ exit: 0, hooks: true }, "kinds")

      const run = await queueRunOnce(boundary.repo)
      const read = await readFacts(boundary, change)
      const report = `${runSummary(run)}\n${read.report}`
      expect(read.exists, report).toBe(true)
      expect(read.facts.length, report).toBeGreaterThan(0)

      for (const fact of read.facts) {
        expect(fact.trailers.get("Fact"), `${report}\nfact ${fact.sha}`).toHaveLength(1)
        expect(FACT_KINDS.has(fact.kind), `${report}\nfact ${fact.sha} says Fact: ${fact.kind}`).toBe(true)
      }
      // The genesis is not a fact and carries none.
      expect(read.genesis?.trailers.get("Fact"), report).toBeUndefined()
    })
  })

  describe("a retry, and a new head", () => {
    // today: red — no change ref, so a second submit at the same head appends
    // nothing and leaves no trace that a retry happened.
    it("a submit at an unchanged head appends a second opened fact and moves nothing else", async () => {
      const { boundary, change } = await submitted({ exit: 0 }, "retry")

      const first = await readFacts(boundary, change)
      expect(first.exists, first.report).toBe(true)
      const refsBefore = await changeRefs(boundary.origin)

      const again = await submitFromBay(boundary.repo, change.bayPath)

      const second = await readFacts(boundary, change)
      const report = `${again.report}\n--- before ---\n${first.report}\n--- after ---\n${second.report}`
      expect(second.exists, report).toBe(true)
      expect(second.kinds, report).toEqual([...first.kinds, "opened"])
      // Nothing moved: the earlier facts are the same commits.
      expect(
        second.facts.slice(0, first.facts.length).map((fact) => fact.sha),
        report,
      ).toEqual(first.facts.map((fact) => fact.sha))
      // A retry's opened fact is a later fact, so it has one parent.
      expect(second.facts.at(-1)?.parents, report).toEqual([first.tip])
      // The head did not change, so no second change ref exists.
      expect(await changeRefs(boundary.origin), report).toHaveLength(refsBefore.length)
    })

    // today: red — no change ref, so there is nothing per-head to keep beside
    // anything: both heads answer to one journal row for the branch.
    it("a new head is a new change, and the change at the old head is left standing", async () => {
      const { boundary, change } = await submitted({ exit: 0 }, "second")

      const first = await readFacts(boundary, change)
      expect(first.exists, first.report).toBe(true)

      const newHead = await commitInBay(change.bayPath, "more")
      const again = await submitFromBay(boundary.repo, change.bayPath)

      const opened = await readFacts(boundary, { branch: change.branch, headSha: newHead })
      const still = await readFacts(boundary, change)
      const report = `${again.report}\n--- new head ---\n${opened.report}\n--- old head ---\n${still.report}`

      expect(opened.exists, report).toBe(true)
      expect(opened.kinds, report).toEqual(["opened"])
      expect(opened.facts[0]?.trailers.get("Change")?.[0] ?? "", report).toBe(`${change.branch}@${newHead}`)

      // yrd deletes nothing: the change at the old head is still there, whole.
      expect(still.exists, report).toBe(true)
      expect(
        still.facts.map((fact) => fact.sha),
        report,
      ).toEqual(first.facts.map((fact) => fact.sha))
      expect(await changeRefs(boundary.origin), report).toHaveLength(2)
    })
  })

  describe("the tip fact is the whole answer", () => {
    // today: red — no change ref, so no `for-each-ref` answer exists at all
    // and `queue list` must read the local store the plan deletes.
    it("one for-each-ref over the change refs answers state, change and target with no history walk", async () => {
      const { boundary } = await submitted({ exit: 0, hooks: true }, "answer")

      const run = await queueRunOnce(boundary.repo)

      // No `git log`, no walk: the ref's tip commit and its trailers, once each.
      for (const key of ["Fact", "Change", "Target"]) {
        const values = await tipTrailer(boundary.origin, key)
        expect(values, `${runSummary(run)}\ntrailer ${key} over refs/yrd/changes/**`).toHaveLength(1)
        expect(values[0], `${runSummary(run)}\ntrailer ${key} over refs/yrd/changes/**`).not.toBe("")
      }
      const state = await tipTrailer(boundary.origin, "Fact")
      expect(FACT_KINDS.has(state[0] ?? ""), `${runSummary(run)}\nFact: ${state[0] ?? "(none)"}`).toBe(true)
    })
  })
})
