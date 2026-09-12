/**
 * @failure The queue run is described in prose — judge from the target, check
 *          the head, merge the first change in line, re-judge when the target
 *          moved, retire a head that is already in the target — and recorded
 *          nowhere. A rebuilt core can honour every existing test and still
 *          judge a branch by its own config, carry a pass across bases, or
 *          bill a submitter for a head it merged itself one minute earlier.
 * @level   l3
 * @consumer `yrd queue run` · every author whose change is in line
 *
 * Written from /hh/pm/@i/10-yrd/plan.md § The queue run, not from the code.
 * Black box: the exit code, the refs afterwards, the target's commits, and
 * what the checks recorded about what they could see. Each test names where
 * it stands today, measured 2026-09-02 against yrd main at fce445eb.
 *
 * The vocabulary is the plan's: change, check, result, queue run, target.
 */
import { existsSync } from "node:fs"
import { afterEach, describe, expect, it } from "vitest"
import {
  advanceTargetAroundQueue,
  boundaryRepositoryWith,
  checkAttempts,
  checkLines,
  FAKE_CHECK,
  firstParentDistance,
  landAroundQueue,
  mergedIntoTarget,
  parentsOf,
  PROBE_SCRIPT,
  queueRunOnce,
  refreshTarget,
  refs,
  removeTemporaryRoots,
  temporaryLog,
  submitCommitWriting,
  submitOneCommit,
  submitSameHead,
  targetTip,
} from "./fixture.ts"

afterEach(removeTemporaryRoots)

/** The fake check as one `run:` string, with the log and exit the case wants. */
function fake(log: string, exit: number): string {
  return `FAKE_CHECK_EXIT=${String(exit)} FAKE_CHECK_LOG=${log} ${FAKE_CHECK}`
}

/** A target whose one check passes and records every run.
 *
 * `notify` is on in every case in this file. The plan has every ended change
 * send one message, so a target with no notifier is a misconfigured target,
 * not a case about the queue run — and measured 2026-09-02, a run that ends
 * two changes without one stops at `notify-unconfigured`, which would answer
 * every question below with the same irrelevant stuck. */
function passing(log: string) {
  return { hooks: true, checks: [{ name: "check", run: fake(log, 0) }] }
}

type ProgramObservation = Readonly<Record<string, string>> &
  Readonly<{
    line: string
    phase: string
  }>

describe("the queue run", { timeout: 180_000 }, () => {
  /**
   * "Check authority lives on the protected side: the check config and the
   * check scripts run from the base commit on the target, never from the
   * branch." A branch that rewrites the check it will be judged by is judged
   * by the target's version all the same.
   */
  describe("judge from the target", () => {
    it("the target's check config judges a branch that rewrote it", async () => {
      // Two logs are the whole discriminator: the target's check writes one,
      // the branch's replacement the other, so "whose config ran" has a
      // file-shaped answer.
      const targetLog = await temporaryLog("target-config")
      const branchLog = await temporaryLog("branch-config")
      const { repo } = await boundaryRepositoryWith({
        hooks: true,
        checks: [{ name: "check", run: fake(targetLog, 1) }],
      })
      const before = await targetTip(repo)

      // The fake check judges content: it exits as told only where the change
      // wrote a file, so the change carries one beside its rewritten config.
      await submitCommitWriting(repo, "rewrite", {
        ".yrd.yml": `checks: [{check: {run: ${JSON.stringify(fake(branchLog, 0))}}}]\n`,
        "rewrite.txt": "the change\n",
      })

      const run = await queueRunOnce(repo)

      expect(run.exitCode, run.report).toBe(1)
      expect(await targetTip(repo), run.report).toBe(before)
      expect(await checkLines(branchLog), run.report).toEqual([])
      expect((await checkLines(targetLog)).length, run.report).toBeGreaterThan(0)
    })

    it("the target's check script judges a branch that rewrote the script", async () => {
      const log = await temporaryLog("check-script")
      const { repo } = await boundaryRepositoryWith({
        hooks: true,
        // The check names its script, and the queue restores it from the base
        // before the check runs (ruling D5, the declared `scripts:` list).
        checks: [{ name: "check", run: `CHECK_LOG=${log} sh check.sh`, scripts: ["check.sh"] }],
        // The target's check is red only where the change's marker is, so this
        // case is about WHOSE check ran and not about whose fault a red one is.
        files: {
          "check.sh": "#!/bin/sh\nprintf 'target\\n' >>\"$CHECK_LOG\"\nif [ -e script.txt ]; then exit 1; fi\nexit 0\n",
        },
      })
      const before = await targetTip(repo)

      await submitCommitWriting(repo, "script", {
        "check.sh": "#!/bin/sh\nprintf 'branch\\n' >>\"$CHECK_LOG\"\nexit 0\n",
        "script.txt": "the change\n",
      })

      const run = await queueRunOnce(repo)

      expect(run.exitCode, run.report).toBe(1)
      expect(await targetTip(repo), run.report).toBe(before)
      // Whatever else ran, the branch's version of the check did not.
      expect(await checkLines(log), run.report).not.toContain("branch")
    })

    it("a target program uses its own closure with a fresh current subject after legacy overlay, in submit and merge", async () => {
      const log = await temporaryLog("program-root")
      const { repo } = await boundaryRepositoryWith({
        hooks: true,
        // Three opted-in checks share submit/merge phases. A no-op still opens
        // a create-only setup log for each P/C root, so a colliding namespace
        // fails before this program can accidentally look green.
        setup: "true",
        checks: [
          {
            name: "legacy",
            on: "submit",
            run: `PROGRAM_LOG=${log} sh legacy.sh`,
            scripts: ["legacy.sh"],
          },
          {
            name: "program-submit",
            on: "submit",
            programRoot: true,
            run: `PROGRAM_LOG=${log} PROGRAM_PHASE=submit sh "$YRD_PROGRAM_ROOT/program.sh"`,
            scripts: ["program.sh", "program-helper.txt"],
          },
          {
            name: "program-merge",
            on: "merge",
            programRoot: true,
            run: `PROGRAM_LOG=${log} PROGRAM_PHASE=merge sh "$YRD_PROGRAM_ROOT/program.sh"`,
            scripts: ["program.sh", "program-helper.txt"],
          },
          {
            name: "program-failure",
            on: "merge",
            programRoot: true,
            run: `PROGRAM_LOG=${log} PROGRAM_PHASE=failure PROGRAM_FAIL_ON_CANDIDATE=1 sh "$YRD_PROGRAM_ROOT/program.sh"`,
            scripts: ["program.sh", "program-helper.txt"],
          },
        ],
        files: {
          "legacy.sh": `#!/bin/sh
set -eu
: "\${PROGRAM_LOG:?legacy needs a log}"
printf 'legacy cwd=%s candidate=%s\n' "$(pwd)" "\${YRD_CANDIDATE_SHA}" >>"$PROGRAM_LOG"
touch legacy-overlay.txt
`,
          "program-helper.txt": "target-helper\n",
          "program.sh": `#!/bin/sh
set -eu
: "\${PROGRAM_LOG:?program needs a log}"
helper=$(cat "\${YRD_PROGRAM_ROOT}/program-helper.txt")
legacy=absent
if [ -e legacy-overlay.txt ]; then legacy=present; fi
actual=$(git rev-parse HEAD)
psha=$(git -C "\${YRD_PROGRAM_ROOT}" rev-parse HEAD)
product=$(cat product.txt)
config=$(cat config-marker.txt)
printf '%s driver=target helper=%s psha=%s cwd=%s repo=%s candidate=%s base=%s actual=%s product=%s config=%s legacy=%s program=%s\n' "\${PROGRAM_PHASE}" "$helper" "$psha" "$(pwd)" "\${YRD_REPO}" "\${YRD_CANDIDATE_SHA}" "\${YRD_BASE_SHA}" "$actual" "$product" "$config" "$legacy" "\${YRD_PROGRAM_ROOT}" >>"$PROGRAM_LOG"
test "$helper" = target-helper
test "$product" = candidate-product || test "$product" = target-product
test "$config" = candidate-config || test "$config" = target-config
test "$legacy" = absent
if [ "\${PROGRAM_FAIL_ON_CANDIDATE:-0}" = 1 ] && [ "$product" = candidate-product ]; then exit 1; fi
`,
          "product.txt": "target-product\n",
          "config-marker.txt": "target-config\n",
        },
      })
      const capturedTarget = await targetTip(repo)

      await submitCommitWriting(repo, "program-root", {
        "program.sh": "#!/bin/sh\nprintf 'candidate program ran\\n' >>\"$PROGRAM_LOG\"\nexit 97\n",
        "program-helper.txt": "candidate-helper\n",
        "product.txt": "candidate-product\n",
        "config-marker.txt": "candidate-config\n",
      })
      const run = await queueRunOnce(repo)
      const lines = await checkLines(log)
      const seen = `${run.report}\n--- protected program observations ---\n${lines.join("\n")}`

      expect(run.exitCode, seen).toBe(1)
      const legacy = lines.find((line) => line.startsWith("legacy "))
      expect(legacy, seen).toBeDefined()
      const legacyCwd = /cwd=([^ ]+)/u.exec(legacy ?? "")?.[1]
      expect(legacyCwd, seen).toBeDefined()

      const observed: readonly ProgramObservation[] = ["submit", "merge", "failure"].map((phase) => {
        const line = lines.find(
          (candidate) => candidate.startsWith(`${phase} `) && candidate.includes("product=candidate-product"),
        )
        expect(line, seen).toBeDefined()
        const fields: Record<string, string> = Object.fromEntries(
          (line ?? "")
            .split(" ")
            .slice(1)
            .map((field) => field.split("=", 2) as [string, string]),
        )
        return { line: line ?? "", phase, ...fields }
      })

      for (const observation of observed) {
        expect(observation.line, seen).toContain("driver=target")
        expect(observation.line, seen).toContain("helper=target-helper")
        expect(observation.product, seen).toBe("candidate-product")
        expect(observation.config, seen).toBe("candidate-config")
        expect(observation.legacy, seen).toBe("absent")
        expect(observation.cwd, seen).not.toBe(legacyCwd)
        expect(observation.repo, seen).toBe(observation.cwd)
        expect(observation.candidate, seen).toBe(observation.actual)
        expect(observation.base, seen).toBe(capturedTarget)
        expect(observation.psha, seen).toBe(capturedTarget)
      }
      expect(new Set(observed.map((observation) => observation.cwd)).size, seen).toBe(3)
      const failed = observed.find((observation) => observation.phase === "failure")
      expect(failed, seen).toBeDefined()
      // The queue must tear down both roots after a failed program check; a
      // retained P or C risks becoming a later check's untracked subject.
      expect(existsSync(failed?.cwd ?? ""), seen).toBe(false)
      expect(existsSync(failed?.program ?? ""), seen).toBe(false)
    })

    it("attributes a fresh protected-program subject setup failure to its submitter", async () => {
      // The ordinary submit worktree and P must pass. Only C is both a fresh
      // protected-program root and carries the candidate product, so this
      // isolates the second setup whose failure must still read settled ground.
      const { repo } = await boundaryRepositoryWith({
        hooks: true,
        setup: `case "$YRD_REPO" in
  */program/*/C) test "$(cat product.txt)" != candidate-product ;;
esac`,
        checks: [
          {
            name: "protected",
            on: "submit",
            programRoot: true,
            run: 'sh "$YRD_PROGRAM_ROOT/program.sh"',
            scripts: ["program.sh"],
          },
        ],
        files: {
          "product.txt": "target-product\n",
          "program.sh": "#!/bin/sh\nexit 0\n",
        },
      })
      const before = await targetTip(repo)

      const change = await submitCommitWriting(repo, "program-setup", { "product.txt": "candidate-product\n" })
      const run = await queueRunOnce(repo)

      // A bare SetupFailed makes this stuck (2). The settled base passes, so
      // the same setup failure on fresh C belongs to this submitter (1).
      expect(run.exitCode, run.report).toBe(1)
      expect(await targetTip(repo), run.report).toBe(before)
      expect(run.report, run.report).toContain(change.branch)
    })
  })

  /**
   * "Then the checked change FIRST IN LINE" — singular. One queue run merges
   * one change; the next keeps its place and merges on the next run, on the
   * base the first one left behind.
   */
  it("one queue run merges the change first in line, and the next waits its turn", async () => {
    const log = await temporaryLog("inline")
    const { repo } = await boundaryRepositoryWith(passing(log))
    const first = await submitOneCommit(repo, "first")
    const second = await submitOneCommit(repo, "second")
    const before = await targetTip(repo)

    const one = await queueRunOnce(repo)

    expect(one.exitCode, one.report).toBe(0)
    const afterOne = await targetTip(repo)
    expect(await firstParentDistance(repo, before, afterOne), one.report).toBe(1)
    expect(await parentsOf(repo, afterOne), one.report).toEqual([before, first.headSha])
    expect(await mergedIntoTarget(repo, second.headSha), one.report).toBe(false)

    const two = await queueRunOnce(repo)

    expect(two.exitCode, two.report).toBe(0)
    const afterTwo = await targetTip(repo)
    expect(await firstParentDistance(repo, afterOne, afterTwo), two.report).toBe(1)
    expect(await parentsOf(repo, afterTwo), two.report).toEqual([afterOne, second.headSha])
    expect(await checkAttempts(log), one.report).toBeGreaterThan(0)
  })

  /** M7.5: candidate preparation composes onto the target before on-submit, so both phases judge what can actually merge. */
  it("the on-submit and on-merge checks both see the candidate composed onto the target", async () => {
    const log = await temporaryLog("phases")
    const { repo, origin } = await boundaryRepositoryWith({
      hooks: true,
      checks: [
        { name: "atsubmit", on: "submit", run: `PROBE_NAME=submit PROBE_LOG=${log} sh check.sh` },
        { name: "atmerge", on: "merge", run: `PROBE_NAME=merge PROBE_LOG=${log} sh check.sh` },
      ],
      files: { "check.sh": PROBE_SCRIPT },
    })
    await submitCommitWriting(repo, "phases", { "branch.txt": "branch\n" }).catch((cause: unknown) => {
      throw new Error(
        `the plan gives each check a phase, \`on: submit\` or \`on: merge\`; the target will not accept the key: ${String(cause)}`,
      )
    })
    // The target gains a file after the branch was cut. Honest candidate
    // preparation includes it before either phase judges the branch.
    await advanceTargetAroundQueue(origin, { "moved.txt": "moved\n" })
    await refreshTarget(repo)

    const run = await queueRunOnce(repo)

    const lines = await checkLines(log)
    const seen = `${run.report}\n--- what the checks saw ---\n${lines.join("\n")}`
    const submitLine = lines.find((line) => line.startsWith("submit "))
    const mergeLine = lines.find((line) => line.startsWith("merge "))
    expect(submitLine, seen).toBeDefined()
    expect(mergeLine, seen).toBeDefined()
    expect(submitLine, seen).toContain("branch.txt")
    expect(submitLine, seen).toContain("moved.txt")
    expect(mergeLine, seen).toContain("branch.txt")
    expect(mergeLine, seen).toContain("moved.txt")
  })

  /**
   * "the target plus its head in a worktree (a conflict is a fail, the
   * submitter's)". Exit 1, not 2: nothing about the queue is broken, and the
   * author's refs stand so they can rebase.
   */
  it("a change that conflicts with the target ends failed, and the queue is not the one at fault", async () => {
    const log = await temporaryLog("conflict")
    const { repo, origin } = await boundaryRepositoryWith(passing(log))
    const change = await submitCommitWriting(repo, "conflict", { "shared.txt": "from the change\n" })
    await advanceTargetAroundQueue(origin, { "shared.txt": "from the target\n" })
    const before = await refreshTarget(repo)
    const refsBefore = await refs(repo)

    const run = await queueRunOnce(repo)

    expect(run.exitCode, run.report).toBe(1)
    expect(await targetTip(repo), run.report).toBe(before)
    expect(await mergedIntoTarget(repo, change.headSha), run.report).toBe(false)
    // The author's refs stand: every ref name is still there and the branch
    // still points at the head. The change's own ref moved forward by one
    // failed record, which is the record of the refusal, not a loss.
    const after = await refs(repo)
    const names = (lines: readonly string[]): readonly string[] => lines.map((line) => line.split(" ")[1] ?? "")
    for (const name of names(refsBefore)) expect(names(after), run.report).toContain(name)
    expect(after, run.report).toContain(`${change.headSha} refs/heads/${change.branch}`)
  })

  /**
   * "A head already an ancestor of the target is retired already-merged and
   * never checked." The garage merges changes around the queue; the next queue run must
   * notice, not re-judge.
   */
  it("a head already in the target is retired already-merged and never checked", async () => {
    const log = await temporaryLog("merged")
    const { repo, origin } = await boundaryRepositoryWith(passing(log))
    const change = await submitOneCommit(repo, "merged")
    await landAroundQueue(origin, change.headSha, repo)
    const before = await refreshTarget(repo)

    const run = await queueRunOnce(repo)

    expect(run.exitCode, run.report).toBe(0)
    expect(await checkAttempts(log), run.report).toBe(0)
    expect(await targetTip(repo), run.report).toBe(before)
    expect(await mergedIntoTarget(repo, change.headSha), run.report).toBe(true)
  })

  /**
   * The measured one, 2026-09-02: the queue merged a head under one name, then
   * checked a SECOND name at the same head against the main it had just moved,
   * failed it, and billed the submitter. One head cannot be both the thing
   * that merged and a fault of its author.
   */
  it("a second branch at a head the same run merged is retired already-merged, and nobody is billed", async () => {
    const log = await temporaryLog("same-head")
    const { repo } = await boundaryRepositoryWith(passing(log))
    const one = await submitOneCommit(repo, "one")
    const two = await submitSameHead(repo, "two", one.headSha).catch((cause: unknown) => {
      // A change is a BRANCH at a head, so two names at one head are two
      // changes and the second submit is ordinary. Measured 2026-09-02: it is
      // refused as a duplicate payload, which identifies a change by content.
      throw new Error(`the second branch at this head was refused at submit: ${String(cause)}`)
    })
    expect(two.headSha).toBe(one.headSha)
    const before = await targetTip(repo)

    const run = await queueRunOnce(repo)

    // Nothing failed and nothing is stuck: one head merged, and the other name
    // is that same merged head.
    expect(run.exitCode, run.report).toBe(0)
    const after = await targetTip(repo)
    expect(await firstParentDistance(repo, before, after), run.report).toBe(1)
    expect(await mergedIntoTarget(repo, one.headSha), run.report).toBe(true)
    expect(await checkAttempts(log), run.report).toBeGreaterThan(0)
  })

  /**
   * "When the target moved under a checked change, the change keeps its place
   * and its on-merge checks run again at the new target. No result is carried
   * across bases." This check passes on either head alone and fails only on
   * the two together, so a carried pass merges a broken target and an honest
   * re-judgement refuses.
   */
  it("the target moving under a checked change re-judges it, and no earlier pass carries across bases", async () => {
    const log = await temporaryLog("bases")
    const { repo } = await boundaryRepositoryWith({
      hooks: true,
      checks: [{ name: "check", run: `PROBE_NAME=check PROBE_LOG=${log} PROBE_FAIL_IF_ALL='a.txt b.txt' sh check.sh` }],
      files: { "check.sh": PROBE_SCRIPT },
    })
    const first = await submitCommitWriting(repo, "aside", { "a.txt": "a\n" })
    const second = await submitCommitWriting(repo, "bside", { "b.txt": "b\n" })
    const before = await targetTip(repo)

    // Each head on its own is fine, so both pass their on-submit checks and
    // the first in line merges.
    const one = await queueRunOnce(repo)
    expect(one.exitCode, one.report).toBe(0)
    const afterOne = await targetTip(repo)
    expect(await parentsOf(repo, afterOne), one.report).toEqual([before, first.headSha])
    const judgedOnce = (await checkLines(log)).length

    // The second change's base is now a target it was never judged against.
    const two = await queueRunOnce(repo)

    expect(two.exitCode, two.report).toBe(1)
    expect(await mergedIntoTarget(repo, second.headSha), two.report).toBe(false)
    expect(await targetTip(repo), two.report).toBe(afterOne)
    expect((await checkLines(log)).length, two.report).toBeGreaterThan(judgedOnce)
  })

  /**
   * A built-in check: "config parses". The target's config is the check, so a
   * branch that breaks `.yrd.yml` is judged by a config that still works —
   * which is exactly why the built-in has to catch it before it merges.
   */
  it("a branch whose config cannot be parsed ends failed, and the queue keeps running", async () => {
    const log = await temporaryLog("unparseable")
    const { repo } = await boundaryRepositoryWith(passing(log))
    const change = await submitCommitWriting(repo, "broken", { ".yrd.yml": "checks: [{check: {run:\n" })
    const before = await targetTip(repo)

    const run = await queueRunOnce(repo)

    // Failed, not stuck: the branch is the broken thing, not the queue.
    expect(run.exitCode, run.report).toBe(1)
    expect(await targetTip(repo), run.report).toBe(before)
    expect(await mergedIntoTarget(repo, change.headSha), run.report).toBe(false)
  })
})
