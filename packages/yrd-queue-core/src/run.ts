/**
 * One queue run ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design,
 * The queue run and Attribution).
 *
 * Read the checks from the target. For every queued change, oldest first: a
 * fresh worktree of the head and the on-submit checks; pass writes checked,
 * fail writes failed and tells the submitter, stuck writes stuck and stops the
 * run. Then the first checked change in line: the target plus its head in a
 * worktree (a conflict is a fail, the submitter's), the on-merge checks; pass
 * with the target still at the checked base and the branch still at the head
 * fast-forwards the target to the merge commit. Every ended change sends one
 * message, after its ended fact is written, with that fact's sha as the id.
 *
 * A failing check is attributed before anything is billed for it, at submit
 * and at merge alike (§ Attribution): the same check again in the change's own
 * worktree, and at the target. Only a failure that repeats there and passes at
 * the target is the submitter's; a coin flip or a red target ends the change
 * stuck, the queue's. One reading for both phases, so where in the run a
 * failure happened to show can never decide whose it is.
 *
 * Every worktree this run makes is prepared before anything is judged in it:
 * the target's `setup:`, once, after materialization and before the first
 * check (worktree.ts). A setup that does not pass is the queue's own ground
 * failing, so the change ends stuck with `Reason: setup` and nobody is billed.
 *
 * A branch at the remote with no change is not a change (E2): the queue read
 * never lists it, so nothing here judges, opens or messages it. `submit` is
 * the one writer of an opened fact; a run only ever appends to a change that
 * exists.
 *
 * Only the queue pushes the target, by rule, and every run proves it before
 * it judges anything: each commit on the target's first-parent line since the
 * cutover that the queue did not put there is reported to the queue owner,
 * once, and the run goes on from the new base (E5; the reading is by-hand.ts).
 *
 * Exit 0 when nothing ended failed or stuck, 1 when a change ended failed,
 * 2 on stuck. A stuck change stays open and the run stops there: the queue
 * could not do its own job, and the next thing to happen is a person.
 */

import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { createProcess, shellCommand, type Process } from "@yrd/process"
import { checkLogPath, runCheck, type CheckedTree, type CheckResult, type CheckSpec } from "./check.ts"
import { appendFact, endedKind, readFact, readFacts, type Fact, type Git } from "./facts.ts"
import { readConfig } from "./config.ts"
import { GitExit, gitIn, gitlinkRows, isAncestor, mergeBase, refAt } from "./git.ts"
import { openLog, type LogRecord, type QueueRunLog } from "./log.ts"
import { byHandCommits, handMovedLine } from "./by-hand.ts"
import { changeName, changeRef } from "./refs.ts"
import { readQueue, type QueueEntry, type QueueRead } from "./remote.ts"
import { inLine } from "./state.ts"
import { checkedTree, claimWorktrees, prepareWorktree, reapWorktrees, SETUP, SetupFailed, type PlumbingLog, type PreparedWorktree } from "./worktree.ts"

export type QueueCheck = CheckSpec &
  Readonly<{
    /** The phases the check runs in; absent means merge (ruling A1). */
    on?: readonly ("submit" | "merge")[]
    /** Repository paths restored from the base commit before the check runs: the check's own scripts (ruling D5). */
    scripts?: readonly string[]
  }>

export type QueueRunOptions = Readonly<{
  /** The working repository the run reads and writes through. */
  repo: string
  /** The queue's remote, where branches and changes live. */
  remote: string
  /** The branch the queue lands on. */
  target: string
  /** The checks the target declares, read from the target commit by the caller. A check with no `on` runs at merge. */
  checks: readonly QueueCheck[]
  /** The target's `setup:`: one shell command run in every worktree this run makes, before any check runs in it. */
  setup?: string
  /** The blob the checks were read from, recorded on every checked fact. */
  configBlob: string
  /** The command that delivers one message, a JSON record on stdin. Absent, messages are logged and not sent. */
  notify?: string
  /** Who hears about a stuck change. */
  owner: string
  /** Where logs, worktrees and scratch live; on the root filesystem. */
  workdir: string
  /** Why the queue is in the garage, when it is: a hand-run round says so on its own record. */
  garage?: string
  /** Receives every log record as it is written, for the human rendering. */
  render?: (record: LogRecord) => void
  /** The logger the worktree plumbing narrates to; hand one over only at trace. */
  plumbing?: PlumbingLog
  git?: Git
  process?: Process
  env?: NodeJS.ProcessEnv
}>

export type QueueRunOutcome = Readonly<{
  exitCode: 0 | 1 | 2
  log: string
  run: string
  /** The target's commit every judgement was made against, and the config blob the checks came from. */
  base: string
  config: string
  /** The target after the run. */
  target: string
  /** The garage's reason, when the round was made in the garage. */
  garage?: string
  merged: readonly string[]
  failed: readonly string[]
  stuck: readonly string[]
  /** The commits on the target's first-parent line that the queue did not put there, reported this run (E5). */
  byHand: readonly string[]
}>

/** Everything one run's steps share. */
type Run = Readonly<{
  options: QueueRunOptions
  git: Git
  log: QueueRunLog
  scratch: string
  worktrees: string
  /** The target the run read at its start; every judgement is against it. */
  targetSha: string
  /**
   * Gitlinks proven on their component's `main` this run, as `<path>@<sha>`:
   * a positive answer can only stay true, so the same pin is asked about at
   * most once per run however many changes move it (E4).
   */
  onMain: Set<string>
}>

type Ended = "checked" | "failed" | "stuck" | "merged"

export async function queueRun(options: QueueRunOptions): Promise<QueueRunOutcome> {
  const git = options.git ?? gitIn(options.repo, options.process)
  const log = openLog(join(options.workdir, "logs"), undefined, options.render)
  const targetSha = await targetAt(git, options.remote, options.target)
  const run: Run = {
    git,
    log,
    onMain: new Set(),
    options,
    scratch: join(options.workdir, "scratch"),
    targetSha,
    worktrees: join(options.workdir, "worktrees", log.id),
  }
  mkdirSync(run.worktrees, { recursive: true })
  // This run's own claim first, so a run starting alongside this one never
  // reads the absence of a pid file as this run's death.
  claimWorktrees(run.worktrees)
  const merged: string[] = []
  const failed: string[] = []
  const stuck: string[] = []

  const entries = await readQueue(git, options.remote, options.target)
  // The run row: the pin (the target's commit) and the config blob the checks
  // were read from. Each change CONSIDERED writes its own row with its decision
  // when the run has made one; a change that ended in an earlier run is history,
  // and this run claims nothing about it.
  // `built` is the Run records this queue run minted: none, ever, in this core;
  // the field stays so a reader of either core's log asks one question.
  log.write({
    base: targetSha,
    built: [],
    checks: options.checks.map((check) => check.name),
    config: options.configBlob,
    ...(options.garage === undefined ? {} : { garage: options.garage }),
    kind: "run",
    pin: targetSha,
    target: options.target,
  })

  // The worktrees of runs that are no longer alive, taken down before this run
  // makes any of its own: a killed run removes nothing, so its worktrees stay
  // registered in the repository and on disk until some later run clears them
  // (plan § Owed after M5; R8's stayed). One row per worktree, because a
  // directory that vanishes with nothing said about it is the silent kind of
  // cleanup nobody can audit.
  for (const taken of await reapWorktrees(git, join(options.workdir, "worktrees"), log.id)) {
    log.write({ kind: "reap", of: taken.of, path: taken.path, why: taken.why })
  }

  // The target moved by hand? Read before any fact is written, so a hand merge
  // of a submitted head is reported before the catch-up below accounts for it
  // (E5). Nothing stops for it: the run judges every change on the base it read.
  const byHand = await reportByHand(run, entries)

  // Bookkeeping at the edges of the facts first, so every reader below reads
  // facts and never reconciles: a branch that is gone or moved off a head ends
  // that head's change failed with the reason and no message (ruling B3); a
  // head the target already carries gets its merged fact, so the tip catches
  // up with ancestry; an ended change whose message reached nobody is sent
  // again (at-least-once, § The queue run).
  for (const entry of entries) await retire(run, entry)
  for (const entry of entries) await catchUp(run, entry)
  for (const entry of entries) await resend(run, entry)

  // On-submit: every queued change, oldest first, in a fresh worktree of its
  // head. A stuck change kept its place, and this run takes it again from
  // here; so does a checked change whose checks ran under a check config the
  // target no longer declares (§ The queue run: a checked fact is reused only
  // while the config blob is the one it names).
  for (const entry of ordered(entries, "queued", "stuck", "checked").filter((entry) => entry.reading.state !== "checked" || staleChecked(run, entry))) {
    const outcome = await guarded(run, entry, () => judge(run, entry))
    if (outcome === "stuck") {
      stuck.push(entry.branch)
      return finish(run, 2, { byHand, failed, merged, stuck })
    }
    if (outcome === "failed") failed.push(entry.branch)
  }

  // On-merge: the first checked change in line, re-read so this run's own
  // checked facts count.
  const checked = ordered(await readQueue(git, options.remote, options.target), "checked").find(
    (entry) => !staleChecked(run, entry),
  )
  if (checked !== undefined) {
    const outcome = await guarded(run, checked, () => land(run, checked))
    if (outcome === "stuck") stuck.push(checked.branch)
    else if (outcome === "failed") failed.push(checked.branch)
    else if (outcome === "merged") merged.push(checked.branch)
  }

  return finish(run, stuck.length > 0 ? 2 : failed.length > 0 ? 1 : 0, { byHand, failed, merged, stuck })
}

/** A checked change whose checked fact names a config blob the target no longer declares. */
function staleChecked(run: Run, entry: QueueEntry): boolean {
  const tip = entry.change.facts.at(-1)
  return tip !== undefined && tip.kind === "checked" && trailerOf(tip, "Config") !== run.options.configBlob
}

/** The entries in the named states, in line order. */
function ordered(entries: QueueRead, ...states: readonly ("queued" | "checked" | "stuck")[]): readonly QueueEntry[] {
  const byHead = new Map(entries.map((entry) => [entry.change.head, entry]))
  return inLine(entries.map((entry) => entry.change))
    .map((change) => byHead.get(change.head))
    .filter(
      (entry): entry is QueueEntry =>
        entry !== undefined && (states as readonly string[]).includes(entry.reading.state),
    )
}

/**
 * Every commit on the target's first-parent line since the cutover that the
 * queue did not put there, each reported once: a log record with the commit,
 * its parents, its subject and the pins it moved, and one message to the
 * queue owner with the commit sha as its id, so a resend after a crash is
 * the same message (E5). No fact is written, because there is no change to
 * write one on; what the queue has already accounted for is read from git
 * (by-hand.ts), so a second run says nothing new once the queue has landed
 * on top. The run never stops for it: the queue adapts already, judging every
 * change on the base it read.
 */
async function reportByHand(run: Run, entries: QueueRead): Promise<readonly string[]> {
  const found = await byHandCommits(run.git, run.options.target, run.targetSha, entries)
  const target = run.options.target
  for (const commit of found) {
    run.log.write({
      branch: target,
      commit: commit.commit,
      gitlinks: commit.gitlinks,
      kind: "by-hand",
      parents: commit.parents,
      subject: commit.subject,
      why: commit.why,
    })
    const text = `${handMovedLine(commit)}: ${commit.why}. The queue goes on from the new base; a rollback is a git revert, pushed through the queue.`
    const { delivery, failure } = await deliver(run, {
      attempt_id: commit.commit,
      base: target,
      branch: target,
      code: "by-hand",
      command: text,
      head: commit.commit,
      id: commit.commit,
      kind: "yrd-broken",
      pr: target,
      recipient: run.options.owner,
      sha: commit.commit,
      text,
    })
    run.log.write({
      about: target,
      branch: target,
      delivered: delivery !== "failed",
      ...(failure === undefined ? {} : { error: failure }),
      head: commit.commit,
      id: commit.commit,
      kind: "message",
      says: "by-hand",
      text,
      to: run.options.owner,
    })
  }
  return found.map((commit) => commit.commit)
}

/**
 * There is exactly one exit site (§ The queue run): a crash while judging a
 * change ends that change stuck, the queue's, with the crash as its cause, and
 * the run exits 2 like any other stuck. A crash inside that ending itself has
 * nowhere left to go and reaches the caller, which exits 2 too.
 */
async function guarded(run: Run, entry: QueueEntry, step: () => Promise<Ended>): Promise<Ended> {
  try {
    return await step()
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").trim()
    // A setup that did not pass is the one crash with a name: the queue could
    // not build the ground a judgement stands on, which is never the
    // submitter's fault, so the reason says setup and not crash.
    if (error instanceof SetupFailed) {
      return end(run, entry, "stuck", {
        subject: `the queue could not prepare a worktree for ${entry.branch}: ${message.slice(0, 200)}`,
        trailers: [["Reason", SETUP]],
      })
    }
    return end(run, entry, "stuck", {
      subject: `the queue crashed judging ${entry.branch}: ${message.slice(0, 200)}`,
      trailers: [["Reason", "crash"]],
    })
  }
}

/**
 * A fresh worktree of `commit`, with the target's `setup:` run in it before
 * anything judges it (§ The queue run). The setup's log and scratch are the
 * phase's own, so one worktree's records sit together, and its result is
 * recorded in the check's shape: what ran, then how it ended, billed to the
 * queue whichever way it went.
 */
async function prepare(run: Run, entry: QueueEntry, commit: string, path: string, phase: string): Promise<PreparedWorktree> {
  const logDir = join(run.options.workdir, "checks", run.log.id, phase)
  const about = { branch: entry.branch, head: entry.change.head, name: SETUP, phase }
  return prepareWorktree(run.git, run.options.repo, commit, path, {
    env: run.options.env,
    plumbing: run.options.plumbing,
    process: run.options.process,
    record: ({ result, start, end: ended }) => record(run, { ...about, end: ended, start }, result),
    ...(run.options.setup === undefined ? {} : { setup: { logDir, run: run.options.setup, scratch: run.scratch } }),
    starting: ({ log, start }) => started(run, { ...about, log, start }),
    targetSha: run.targetSha,
  })
}

/** The on-submit phase for one queued change. */
async function judge(run: Run, entry: QueueEntry): Promise<Ended> {
  const { branch, change } = entry
  const head = change.head
  // The built-in check: the head shares ancestry with the target. The target
  // moves under every queued change by design, so "descends from the tip" would
  // fail every change behind a merge; an unrelated history is what a merge
  // must never splice in.
  if ((await mergeBase(run.git, head, run.targetSha)) === undefined) {
    return end(run, entry, "failed", {
      remedy: `rebase ${branch} onto ${run.options.target} and submit again`,
      subject: `${branch} shares no history with ${run.options.target}`,
      trailers: [["Reason", "unrelated-history"]],
    })
  }
  const worktree = await prepare(run, entry, head, join(run.worktrees, "submit", head.slice(0, 12)), "submit")
  try {
    // The built-in check: every gitlink the change moved reachable from its
    // component's main (E4).
    const offMain = await gitlinkOffMain(run, head, worktree.path)
    if (offMain !== undefined) {
      return end(run, entry, "failed", {
        remedy: `land ${offMain.path}'s commit on its main first, pin that, and submit again`,
        subject: `${branch} pins ${offMain.path} at ${offMain.sha.slice(0, 12)}, which its main does not carry`,
        trailers: [["Reason", "gitlink-off-main"], ["Gitlink", `${offMain.path} ${offMain.sha}`]],
      })
    }
    const results = await runPhase(run, entry, "submit", worktree.path, worktree.tree)
    const stuckOne = results.find((result) => result.result === "stuck")
    if (stuckOne !== undefined) {
      return end(run, entry, "stuck", {
        subject: `the queue could not judge ${branch}: ${stuckOne.name} ${stuckOne.why ?? ""}`.trim(),
        trailers: [["Reason", stuckOne.name], ...checkTrailers(results)],
      })
    }
    const failing = results.filter((result) => result.result === "fail")
    // Awaited, not returned: the attribution runs the check again in THIS
    // worktree, and an async function runs its `finally` before it settles a
    // returned promise, so a bare return would remove the tree out from under it.
    if (failing.length > 0) return await endFailing(run, entry, results, failing, worktree.path, worktree.tree, "submit")
    await appendFact(run.git, {
      branch,
      head,
      kind: "checked",
      subject: `${branch} passed the on-submit checks at ${run.options.target} ${run.targetSha.slice(0, 12)}`,
      target: run.options.target,
      trailers: [["Config", run.options.configBlob], ["Base", run.targetSha], ...checkTrailers(results)],
    })
    await pushChange(run, branch, head)
    return "checked"
  } finally {
    await worktree.remove()
  }
}

/**
 * The first gitlink the change moved that its component's `main` does not
 * carry, or undefined when every moved pin is on its main (E4, amending D7).
 * Only a gitlink whose sha differs from the target's is asked about — added
 * or moved by the change; a pin the target already carries is the target's,
 * judged when it landed — and each component is asked at its own remote, so
 * the answer is about main as it is now, never a stale tracking ref. A
 * positive answer is kept on the run: a commit on main stays on main, so the
 * same pin is fetched at most once per run however many changes move it. A
 * component that cannot be asked throws, and the change ends stuck, because a
 * pin the queue cannot judge is not a fail.
 *
 * Measured 2026-09-02: asking every component of the root's tree cost 15
 * fetches and 13.7 s per judged change, for pins the change never touched.
 */
async function gitlinkOffMain(
  run: Run,
  head: string,
  worktree: string,
): Promise<Readonly<{ path: string; sha: string }> | undefined> {
  for (const { path, sha } of await movedGitlinks(run, head)) {
    const pin = `${path}@${sha}`
    if (run.onMain.has(pin)) continue
    const component = gitIn(join(worktree, path), run.options.process)
    await component(["fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main"])
    if (!(await isAncestor(component, sha, "refs/remotes/origin/main"))) return { path, sha }
    run.onMain.add(pin)
  }
  return undefined
}

/**
 * The gitlinks `head` carries at a sha the target does not, in tree order:
 * one diff of the two trees, keeping every entry whose new mode is a gitlink.
 * A gitlink the change took out, or turned into a file, has no pin to judge.
 */
async function movedGitlinks(run: Run, head: string): Promise<readonly Readonly<{ path: string; sha: string }>[]> {
  return (await gitlinkRows(run.git, run.targetSha, head))
    .filter((row) => row.newMode === "160000")
    .map(({ path, sha }) => ({ path, sha }))
}

/** The on-merge phase for the first checked change. */
async function land(run: Run, entry: QueueEntry): Promise<Ended> {
  const { branch, change } = entry
  const head = change.head
  const name = changeName(branch, head)
  const worktree = await prepare(run, entry, run.targetSha, join(run.worktrees, "merge", head.slice(0, 12)), "merge")
  try {
    const wt = gitIn(worktree.path, run.options.process)
    let mergeCommit: string
    try {
      // The merge commit names its change back, by the change's own name, so
      // `git log main` says which change every merge came from and
      // `git log refs/yrd/changes/<that name>` prints its facts (E5). The
      // submitter and the work item come with it, as the opened fact carried
      // them forward, one trailer per line in git's own trailer format.
      const tip = change.facts.at(-1)
      const workItem = trailerOf(tip, "Work-Item")
      const submitter = trailerOf(tip, "Submitter")
      const message = [
        `merge ${short(branch, head)} into ${run.options.target}`,
        "",
        `Change: ${name}`,
        ...(workItem === undefined ? [] : [`Work-Item: ${workItem}`]),
        ...(submitter === undefined ? [] : [`Submitter: ${submitter}`]),
      ].join("\n")
      await wt(["merge", "--quiet", "--no-ff", "--no-edit", "-m", message, head])
      mergeCommit = (await wt(["rev-parse", "HEAD"])).trim()
    } catch (error) {
      // A conflict is the submitter's: the branch does not fit the target. The
      // worktree is thrown away whole, so nothing needs aborting. What git
      // said is the detail, on one line: a trailer is one line, and the merge
      // command's own message spans several.
      const said = error instanceof GitExit ? error.detail : error instanceof Error ? error.message : String(error)
      return end(run, entry, "failed", {
        remedy: `rebase ${branch} onto ${run.options.target}, resolve the conflict, push, and submit again`,
        subject: `${branch} conflicts with ${run.options.target}`,
        trailers: [
          ["Reason", "conflict"],
          ["Detail", said.replace(/\s+/gu, " ").trim().slice(0, 200)],
        ],
      })
    }
    // The built-in check at merge (ruling D2): the merged tree's own declaration
    // reads, so no change can land a `.yrd.yml` that breaks the next queue run.
    let unreadable: string | undefined
    try {
      if ((await readConfig(wt, "HEAD")) === undefined) unreadable = "the merged tree has no .yrd.yml"
    } catch (error) {
      unreadable = String(error instanceof Error ? error.message : error).slice(0, 160)
    }
    if (unreadable !== undefined) {
      return end(run, entry, "failed", {
        remedy: `fix .yrd.yml on ${branch} (${unreadable}), push, and submit again`,
        subject: `${branch} would land a declaration the queue cannot read`,
        trailers: [["Reason", "config-invalid"]],
      })
    }
    // The merge moved this worktree's HEAD, so what a check judges here is
    // read now and not at prepare time: the candidate is the merge commit,
    // and its merge base with the target is the target itself.
    const merged = await checkedTree(worktree.path, run.targetSha, run.options.process)
    const results = await runPhase(run, entry, "merge", worktree.path, merged)
    const stuckOne = results.find((result) => result.result === "stuck")
    if (stuckOne !== undefined) {
      return end(run, entry, "stuck", {
        subject: `the queue could not judge ${branch} at merge: ${stuckOne.name} ${stuckOne.why ?? ""}`.trim(),
        trailers: [["Reason", stuckOne.name], ...checkTrailers(results)],
      })
    }
    const failing = results.filter((result) => result.result === "fail")
    // Awaited for the same reason as at submit: the attribution judges in this
    // worktree, and the `finally` below must not remove it first.
    if (failing.length > 0) return await endFailing(run, entry, results, failing, worktree.path, merged, "merge")
    // Pass. The merge is ours to make only while the target is still where this
    // change was checked against and the branch still at the head; otherwise the
    // change keeps its place and is checked again at the new target next run.
    const remoteNow = await remoteHeads(run, branch)
    if (remoteNow.target !== run.targetSha || remoteNow.branch !== head) {
      run.log.write({ branch, decision: "checked", head, kind: "change", reason: remoteNow.target !== run.targetSha ? "target-moved" : "branch-moved" })
      return "checked"
    }
    await run.git(["fetch", "--quiet", worktree.path, mergeCommit])
    // The merged fact says how it was merged and what it checked: by the queue,
    // with the on-merge checks' results, in the shape the checked fact uses.
    const mergedFact = await appendFact(run.git, {
      branch,
      head,
      kind: "merged",
      subject: `${branch} merged into ${run.options.target} as ${mergeCommit.slice(0, 12)}`,
      target: run.options.target,
      trailers: [["Merge", mergeCommit], ["Base", run.targetSha], ["Merged-By", "queue"], ...checkTrailers(results)],
    })
    const ref = changeRef(branch, head)
    await run.git([
      "push",
      "--quiet",
      "--atomic",
      `--force-with-lease=refs/heads/${run.options.target}:${run.targetSha}`,
      run.options.remote,
      `${mergeCommit}:refs/heads/${run.options.target}`,
      `${ref}:${ref}`,
    ])
    run.log.write({ branch, change: name, commit: mergeCommit, head, kind: "merge", tip: mergeCommit })
    run.log.write({ branch, decision: "merged", head, kind: "change" })
    await send(run, entry, mergedFact, "merged", messageFor("merged", { branch, head, merge: mergeCommit, subject: "" }))
    return "merged"
  } finally {
    await worktree.remove()
  }
}

/**
 * What one phase's failing checks end the change as, at submit and at merge
 * alike: the attribution decides whose the failure is, and only the
 * submitter's ends failed. The two phases share this reading, so which phase a
 * failure happened to show in can never decide who is billed for it — an
 * on-submit check that fails on a defect of the environment used to send the
 * change back the moment it failed, with no second reading at all.
 */
async function endFailing(
  run: Run,
  entry: QueueEntry,
  results: readonly CheckResult[],
  failing: readonly CheckResult[],
  changeWorktree: string,
  changeTree: CheckedTree,
  phase: "submit" | "merge",
): Promise<Ended> {
  const { branch } = entry
  const verdict = await attribute(run, entry, failing, changeWorktree, changeTree)
  if (verdict.result === "stuck") {
    // `Reason` is the attribution's own word for why nobody is billed —
    // `inherited`, `flake`, `no-evidence` — and the check that produced it is
    // in the subject and in this fact's `Check:` trailers.
    return end(run, entry, "stuck", {
      subject: `${branch}: ${verdict.why}`,
      trailers: [["Reason", verdict.kind], ...checkTrailers(results)],
    })
  }
  const first = failing[0]
  return end(run, entry, "failed", {
    remedy: `fix ${first?.name ?? "the check"} (log: ${first?.log ?? ""}), push, and submit again`,
    subject: `${branch} failed ${failing.map((result) => result.name).join(", ")}${phase === "merge" ? " at merge" : ""}`,
    trailers: [["Reason", first?.name ?? "check"], ...checkTrailers(results)],
  })
}

/**
 * A failing check is the submitter's only if it fails again in the change's
 * worktree and does not fail at the target on the same check; otherwise the
 * change ends stuck, the queue's. Nobody is billed for a coin flip or for a
 * red target.
 *
 * `changeWorktree` is whichever tree the failure came from — the head alone on
 * the submit path, the target plus the head on the merge path — because the
 * question is whether the failure is in the change, and the change is what
 * that tree carries either way. The second run and the target run cost two
 * more check runs, and they happen only for a check that already failed.
 */
async function attribute(
  run: Run,
  entry: QueueEntry,
  failing: readonly CheckResult[],
  changeWorktree: string,
  changeTree: CheckedTree,
): Promise<Readonly<{ result: "fail" | "stuck"; kind: string; why: string }>> {
  for (const first of failing) {
    const spec = run.options.checks.find((check) => check.name === first.name)
    if (spec === undefined) return { kind: "no-evidence", result: "stuck", why: `${first.name} is not a declared check` }
    const again = await check(run, entry, spec, changeWorktree, changeTree, "again")
    if (again.result !== "fail") {
      return { kind: "flake", result: "stuck", why: `${first.name} failed once and passed once in the change's worktree; the queue does not merge on a coin flip; fix or remove the test` }
    }
    const targetTree = await prepare(run, entry, run.targetSha, join(run.worktrees, "target", first.name), "target")
    try {
      const atTarget = await check(run, entry, spec, targetTree.path, targetTree.tree, "target")
      if (atTarget.result !== "pass") {
        return { kind: "inherited", result: "stuck", why: `${first.name} fails at the target ${run.targetSha.slice(0, 12)} too; the target is red, not the change; fix the target first, then the queue resumes` }
      }
    } finally {
      await targetTree.remove()
    }
  }
  return { kind: "submitter", result: "fail", why: "" }
}

/**
 * A change whose branch is gone, or whose branch moved off its head, ends
 * failed with the reason `deleted` or `replaced` and no message: the
 * submitter did it (§ The change). Written once; a change that already ended
 * is left as it ended.
 */
async function retire(run: Run, entry: QueueEntry): Promise<void> {
  const reason = entry.reading.reason
  if (entry.reading.state !== "failed" || (reason !== "deleted" && reason !== "replaced")) return
  const tip = entry.change.facts.at(-1)
  const endedAs = tip === undefined ? undefined : endedKind(tip)
  if (endedAs === "failed" || endedAs === "merged") return
  const { branch } = entry
  const head = entry.change.head
  await appendFact(run.git, {
    branch,
    head,
    kind: "failed",
    subject: reason === "deleted" ? `${branch} was deleted by its submitter` : `${branch} moved off ${head.slice(0, 12)}; its submitter replaced it`,
    target: run.options.target,
    trailers: [["Reason", reason]],
  })
  await pushChange(run, branch, head)
  run.log.write({ branch, decision: "failed", head, kind: "change", reason })
}

/**
 * A head the target already carries with no merged fact yet — merged by hand
 * in the garage, or by a run that crashed after its push — gets its merged
 * fact now, naming the commit that landed it and saying a hand did it, and
 * its submitter is told (§ The change: ancestry wins, and the next queue run
 * appends the merged fact so the tip catches up). A retired change is left as
 * it ended.
 */
async function catchUp(run: Run, entry: QueueEntry): Promise<void> {
  if (!entry.change.headOnTarget) return
  const tip = entry.change.facts.at(-1)
  const endedAs = tip === undefined ? undefined : endedKind(tip)
  if (endedAs === "merged") return
  const reason = tip === undefined ? undefined : trailerOf(tip, "Reason")
  if (reason === "replaced" || reason === "deleted") return
  const { branch } = entry
  const head = entry.change.head
  // The first commit on the target's first-parent line that descends from the
  // head is the one that landed it; none means the head was fast-forwarded.
  const landing = (await run.git(["rev-list", "--reverse", "--first-parent", "--ancestry-path", `${head}..${run.targetSha}`])).trim().split("\n")[0]
  const merge = landing === undefined || landing === "" ? head : landing
  const mergedFact = await appendFact(run.git, {
    branch,
    head,
    kind: "merged",
    subject: `merged by hand at ${merge.slice(0, 12)}`,
    target: run.options.target,
    trailers: [
      ["Merge", merge],
      ["Base", merge === head ? head : `${merge}^1`],
      ["Merged-By", "hand"],
    ],
  })
  await pushChange(run, branch, head)
  run.log.write({ branch, decision: "merged", head, kind: "change", reason: "already on the target" })
  await send(run, entry, mergedFact, "merged", messageFor("merged", { branch, head, merge, subject: "" }))
}

/**
 * Every ended change whose message reached nobody is sent again: an ended tip
 * with no sent fact (a crash between the two), or a sent fact whose delivery
 * failed. The id is the ended fact's sha, so the recipient sees one message
 * however many times it is sent (§ The queue run, at-least-once).
 */
async function resend(run: Run, entry: QueueEntry): Promise<void> {
  const tip = entry.change.facts.at(-1)
  if (tip === undefined) return
  const undelivered = tip.kind === "sent" && trailerOf(tip, "Delivery") === "failed"
  const unsent = tip.kind === "failed" || tip.kind === "stuck" || tip.kind === "merged"
  if (!undelivered && !unsent) return
  // A retired change sends nothing (ruling B3).
  const reason = trailerOf(tip, "Reason")
  if (reason === "replaced" || reason === "deleted") return
  const endedSha = tip.kind === "sent" ? trailerOf(tip, "For") : tip.sha
  if (endedSha === undefined) throw new Error(`${entry.branch}: sent fact ${tip.sha.slice(0, 12)} names no ended fact to send again`)
  const ended = tip.kind === "sent" ? await readFact(run.git, endedSha) : tip
  if (ended.kind !== "failed" && ended.kind !== "stuck" && ended.kind !== "merged") {
    throw new Error(`${entry.branch}: ${endedSha.slice(0, 12)} is a ${ended.kind} fact, not an ended one`)
  }
  await send(
    run,
    entry,
    ended.sha,
    ended.kind,
    messageFor(ended.kind, { branch: entry.branch, head: entry.change.head, merge: trailerOf(ended, "Merge") ?? "", remedy: trailerOf(ended, "Remedy"), subject: ended.subject }),
  )
}

/** A change as a person reads it: the branch and twelve characters of the head, the trailer's spelling shortened. */
function short(branch: string, head: string): string {
  return `${branch}@${head.slice(0, 12)}`
}

/** The one message an ended change sends, in the plan's three shapes (§ Commands). */
function messageFor(kind: "merged" | "failed" | "stuck", about: Readonly<{ branch: string; head: string; subject: string; merge?: string; remedy?: string }>): string {
  switch (kind) {
    case "merged":
      return `close your bead: ${short(about.branch, about.head)} merged as ${(about.merge ?? "").slice(0, 12)}`
    case "failed":
      return `send it back: ${about.subject}; ${about.remedy ?? ""}`.trim()
    case "stuck":
      return `yrd broken: ${about.subject}; the queue stays down until a person fixes it`
  }
}

/**
 * A check's scripts come from the target, never from the branch (§ The queue
 * run: gate authority lives on the protected side). The check declares them as
 * `scripts:`, files or directories of the repository; each is restored from
 * the base commit into the worktree before the check runs, so a change that
 * rewrites the gate it is judged by is judged by the target's version all the
 * same. The merge commit, already made, keeps the branch's edit: it lands, and
 * judges the next change. A declared path the base does not carry is loud,
 * because a gate that silently ran the branch's copy would be the hole itself.
 */
async function restoreScripts(run: Run, spec: QueueCheck, cwd: string): Promise<void> {
  const scripts = spec.scripts ?? []
  if (scripts.length === 0) return
  const wt = gitIn(cwd, run.options.process)
  for (const path of scripts) {
    if ((await refAt(run.git, `${run.targetSha}:${path}`, "blob")) === undefined && (await refAt(run.git, `${run.targetSha}:${path}`, "tree")) === undefined) {
      throw new Error(`check ${spec.name} declares scripts: ${path}, which the target ${run.targetSha.slice(0, 12)} does not carry`)
    }
    await wt(["checkout", "--quiet", run.targetSha, "--", path])
  }
}

async function runPhase(
  run: Run,
  entry: QueueEntry,
  phase: "submit" | "merge",
  cwd: string,
  tree: CheckedTree,
): Promise<readonly CheckResult[]> {
  const results: CheckResult[] = []
  for (const spec of run.options.checks.filter((candidate) => (candidate.on ?? ["merge"]).includes(phase))) {
    results.push(await check(run, entry, spec, cwd, tree, phase))
    if (results.at(-1)?.result !== "pass") break
  }
  return results
}

async function check(run: Run, entry: QueueEntry, spec: QueueCheck, cwd: string, tree: CheckedTree, phase: string): Promise<CheckResult> {
  await restoreScripts(run, spec, cwd)
  const logDir = join(run.options.workdir, "checks", run.log.id, phase)
  const about = {
    branch: entry.branch,
    head: entry.change.head,
    name: spec.name,
    phase,
    ...(spec.scripts === undefined || spec.scripts.length === 0 ? {} : { scripts: spec.scripts }),
  }
  const start = new Date().toISOString()
  started(run, { ...about, log: checkLogPath(logDir, spec.name), start })
  const result = await runCheck({
    cwd,
    env: run.options.env,
    logDir,
    process: run.options.process,
    scratch: run.scratch,
    spec,
    tree,
  })
  record(run, { ...about, end: new Date().toISOString(), start }, result)
  return result
}

/**
 * The row that says a program the queue runs has STARTED, written before it
 * runs: the same `check` kind, the same names, and the log file it is about to
 * write, read from the same place the driver will read it. A reader tells the
 * two rows apart by `end`, which only ending can say and which a start row
 * therefore does not carry (neither does it carry `ms`); the end row is
 * exactly what it always was, so nothing that reads one changes.
 *
 * Without this row a queue run's log is silent for the whole length of a
 * check, and a check that is merely long reads as a hung queue: R8 was stopped
 * as a hang while a 28.7-minute check ran (plan § Owed after M5).
 */
function started(
  run: Run,
  about: Readonly<{ branch: string; head: string; name: string; phase: string; start: string; log: string; scripts?: readonly string[] }>,
): void {
  run.log.write({ ...about, kind: "check" })
}

/**
 * The two records every program the queue runs writes, one shape for all of
 * them: what ran, then how it ended. `whose` is who the result is billed to —
 * a stuck result is always the queue's, and so is anything the setup did,
 * because the setup is the queue's own ground rather than the change; a
 * failing check is the submitter's until the attribution says otherwise, and
 * that later reading writes its own result row.
 */
function record(
  run: Run,
  about: Readonly<{ branch: string; head: string; name: string; phase: string; start: string; end: string; scripts?: readonly string[] }>,
  result: CheckResult,
): void {
  const common = { branch: about.branch, head: about.head, name: about.name, phase: about.phase }
  run.log.write({ ...common, end: about.end, kind: "check", log: result.log, ms: result.durationMs, ...(about.scripts === undefined ? {} : { scripts: about.scripts }), start: about.start })
  const whose = result.result === "pass" ? undefined : result.result === "stuck" || about.name === SETUP ? "queue" : "submitter"
  run.log.write({ ...common, exit: String(result.exit), kind: "result", result: result.result, whose })
}

async function end(
  run: Run,
  entry: QueueEntry,
  kind: "failed" | "stuck",
  ended: Readonly<{ subject: string; trailers: readonly (readonly [string, string])[]; remedy?: string }>,
): Promise<Ended> {
  // Who is billed follows from the kind, once: a fail is the submitter's, and
  // says so; a stuck is always the queue's, so its fact says nothing about
  // fault (§ Attribution; a constant trailer says nothing). A `replaced` or
  // `deleted` change bills nobody and never comes through here.
  const trailers = [
    ...ended.trailers,
    ...(kind === "failed" ? [["Fault", "submitter"] as const] : []),
    ...(ended.remedy === undefined ? [] : [["Remedy", ended.remedy] as const]),
  ]
  const fact = await appendFact(run.git, { branch: entry.branch, head: entry.change.head, kind, subject: ended.subject, target: run.options.target, trailers })
  await pushChange(run, entry.branch, entry.change.head)
  run.log.write({ branch: entry.branch, decision: kind, head: entry.change.head, kind: "change", reason: ended.subject })
  await send(run, entry, fact, kind, messageFor(kind, { branch: entry.branch, head: entry.change.head, remedy: ended.remedy, subject: ended.subject }))
  return kind
}

/** One message per ended change, after its ended fact; the fact's sha is the id. */
async function send(
  run: Run,
  entry: QueueEntry,
  endedFact: string,
  kind: "merged" | "failed" | "stuck",
  text: string,
): Promise<void> {
  const facts = await readFacts(run.git, entry.branch, entry.change.head)
  const opened = facts.find((fact) => fact.kind === "opened")
  const ended = [...facts].reverse().find((fact) => fact.sha === endedFact)
  // A stuck change is the queue owner's to hear about; so is a change whose
  // submitter is `unknown` — a submit with neither `--notify` nor
  // `YRD_DEFAULT_SUBMITTER` (rulings B6 and D9) — never a seat named `unknown`.
  const submitter = trailerOf(opened, "Submitter")
  const recipient = kind === "stuck" || submitter === undefined || submitter === "unknown" ? run.options.owner : submitter
  // The record the configured notifier reads, unchanged from today's contract
  // (kind, attempt_id, pr, recipient, command required; the rest optional): the
  // plan's three messages map onto its three kinds, the branch stands where a
  // PR number stood, and the ended fact's sha is the attempt id, so a resend
  // after a crash is the same message.
  const { delivery, failure } = await deliver(run, {
    attempt_id: endedFact,
    base: run.options.target,
    branch: entry.branch,
    code: kind === "merged" ? undefined : trailerOf(ended, "Reason"),
    command: text,
    disposition: kind === "failed" ? "author" : undefined,
    head: entry.change.head,
    id: endedFact,
    kind: kind === "merged" ? "landed" : kind === "failed" ? "send-back" : "yrd-broken",
    pr: entry.branch,
    recipient,
    sha: entry.change.head,
    text,
    workItem: trailerOf(opened, "Work-Item"),
  })
  // The sent fact repeats the ended state and carries the ended fact's result,
  // so the tip fact's trailers stay the whole answer about the change and no
  // reader has to walk to the fact before (ruling A2).
  await appendFact(run.git, {
    branch: entry.branch,
    head: entry.change.head,
    kind: "sent",
    subject: `${delivery === "failed" ? "could not tell" : "told"} ${recipient}: ${text}`.slice(0, 200),
    target: run.options.target,
    trailers: [
      ["Message-Id", endedFact],
      ["To", recipient],
      ["State", kind],
      ["For", endedFact],
      ["Delivery", delivery],
      ...(failure === undefined ? [] : [["Delivery-Error", failure] as const]),
      ...(ended?.trailers.filter(([name]) => RESULT_TRAILERS.has(name)) ?? []),
    ],
  })
  await pushChange(run, entry.branch, entry.change.head)
  run.log.write({
    about: entry.branch,
    branch: entry.branch,
    delivered: delivery !== "failed",
    ...(failure === undefined ? {} : { error: failure }),
    head: entry.change.head,
    id: endedFact,
    kind: "message",
    says: kind,
    text,
    to: recipient,
  })
}

/**
 * Hand one message to the configured notifier, a JSON record on its stdin,
 * and say how it went: `sent` when the notifier accepted it, `logged` when
 * the target declares none (ruling A4), `failed` with why when it exited
 * non-zero. A notifier that fails changes nothing about what a change IS:
 * the ended fact stands and the next run sends the same message again
 * (ruling D9). Nothing here throws, so a failed delivery can never end a
 * merged change stuck.
 */
async function deliver(
  run: Run,
  record: Readonly<Record<string, string | undefined>>,
): Promise<Readonly<{ delivery: "sent" | "logged" | "failed"; failure?: string }>> {
  if (run.options.notify === undefined) return { delivery: "logged" }
  const runner = run.options.process ?? createProcess({ cwd: run.options.repo })
  const result = await runner.run({
    argv: shellCommand(run.options.notify),
    cwd: run.options.repo,
    env: run.options.env,
    stdin: `${JSON.stringify(record)}\n`,
    timeoutMs: 60_000,
  })
  if (result.exitCode === 0) return { delivery: "sent" }
  return {
    delivery: "failed",
    failure: `the notifier exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`
      .replace(/\s+/gu, " ")
      .slice(0, 300),
  }
}

/** An ended fact's result, as its sent fact carries it forward. */
const RESULT_TRAILERS = new Set(["Reason", "Fault", "Remedy", "Check", "Merge", "Base", "Gitlink", "Merged-By"])

function checkTrailers(results: readonly CheckResult[]): readonly (readonly [string, string])[] {
  return results.map((result) => ["Check", `${result.name} exit=${result.exit} ms=${result.durationMs} log=${result.log}`] as const)
}

async function pushChange(run: Run, branch: string, head: string): Promise<void> {
  const ref = changeRef(branch, head)
  await run.git(["push", "--quiet", run.options.remote, `${ref}:${ref}`])
}

/** Where the target and one branch stand at the remote right now. */
async function remoteHeads(run: Run, branch: string): Promise<Readonly<{ target?: string; branch?: string }>> {
  const rows = (await run.git(["ls-remote", "--refs", run.options.remote, `refs/heads/${run.options.target}`, `refs/heads/${branch}`])).split("\n")
  const at = new Map(rows.map((row) => row.trim().split(/\s+/u)).map(([sha, ref]) => [ref ?? "", sha ?? ""]))
  return { branch: at.get(`refs/heads/${branch}`), target: at.get(`refs/heads/${run.options.target}`) }
}

async function targetAt(git: Git, remote: string, target: string): Promise<string> {
  const sha = (await git(["ls-remote", "--refs", remote, `refs/heads/${target}`])).trim().split(/\s+/u)[0]
  if (sha === undefined || sha === "") throw new Error(`the target ${target} is not at ${remote}`)
  await git(["fetch", "--quiet", remote, `+refs/heads/${target}:refs/remotes/${remote}/${target}`])
  return sha
}

function trailerOf(fact: Fact | undefined, name: string): string | undefined {
  return fact?.trailers.find(([key]) => key === name)?.[1]
}

async function finish(
  run: Run,
  exitCode: 0 | 1 | 2,
  lists: Readonly<{ merged: string[]; failed: string[]; stuck: string[]; byHand: readonly string[] }>,
): Promise<QueueRunOutcome> {
  // A push updates the remote-tracking ref it pushed to, so after a merge the
  // target as this run left it is right there; a run that merged nothing left
  // it where it found it.
  const targetNow = lists.merged.length === 0 ? run.targetSha : ((await refAt(run.git, `refs/remotes/${run.options.remote}/${run.options.target}`)) ?? run.targetSha)
  // A run that reaches here removed every worktree it made, so its own
  // directory and the pid file in it have nothing left to say. Taking them
  // leaves exactly the runs that did NOT end under the worktrees root, which
  // is what the next run's reap reads. `queue up` is one process running many
  // rounds, so without this every round of a day-long service would leave a
  // directory behind that no reap may touch: its pid is alive.
  rmSync(run.worktrees, { force: true, recursive: true })
  return {
    base: run.targetSha,
    config: run.options.configBlob,
    exitCode,
    ...(run.options.garage === undefined ? {} : { garage: run.options.garage }),
    log: run.log.path,
    run: run.log.id,
    target: targetNow,
    ...lists,
  }
}
