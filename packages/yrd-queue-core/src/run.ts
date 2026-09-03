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
 * message, after its ended event is written, with that event's sha as the id.
 *
 * A failing check sends the change back at once, with the check, its exit, its
 * duration and its log path. Stuck is what the queue could not judge at all —
 * a crash, a missing script, a check past its bound, a check that exits 2, a
 * check the driver could not measure, a component whose remote cannot be asked
 * — and nothing else.
 *
 * Every worktree this run makes is prepared before anything is judged in it:
 * the target's `setup:`, once, after materialization and before the first
 * check (worktree.ts). A setup that does not pass is the queue's own ground
 * failing, so the change ends stuck with `Reason: setup` and nobody is billed.
 *
 * A branch at the remote with no change is not a change (E2): the queue read
 * never lists it, so nothing here judges, opens or messages it. `submit` is
 * the one writer of an opened event; a run only ever appends to a change that
 * exists.
 *
 * Only the queue pushes the target, by rule, and every run proves it before
 * it judges anything: each commit on the target's first-parent line since the
 * queue's own history starts that the queue did not put there is reported
 * once, and the run goes on from the new base (E5; the reading is bypass.ts).
 *
 * Exit 0 when nothing ended failed or stuck, 1 when a change ended failed,
 * 2 on stuck. A stuck change stays open and the run stops there: the queue
 * could not do its own job, and the next thing to happen is a person.
 */

import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { createProcess, shellCommand, type Process } from "@yrd/process"
import {
  checkLogPath,
  checkTrailer,
  readCheckTrailer,
  runCheck,
  type CheckedTree,
  type CheckResult,
  type CheckSpec,
} from "./check.ts"
import {
  appendEvent,
  BYPASS_MERGE,
  endedKind,
  eventCommit,
  mergedBy,
  readEvent,
  readEvents,
  trailer,
  trailers,
  type Event,
  type Git,
  type WriteEvent,
} from "./events.ts"
import { queueName, readConfig, targetName, type Ending, type Notifier, type Target } from "./config.ts"
import { GitExit, gitIn, gitlinkRows, isAncestor, mergeBase, refAt } from "./git.ts"
import { openLog, type LogRecord, type QueueRunLog } from "./log.ts"
import { bypassCommits, bypassLine } from "./bypass.ts"
import { activeFreeze, type FreezeEvent } from "./freeze.ts"
import { changeName, changeRef } from "./refs.ts"
import { readQueue, type QueueEntry, type QueueRead } from "./remote.ts"
import { inLine, tipOf } from "./state.ts"
import {
  checkedTree,
  claimWorktrees,
  prepareWorktree,
  reapWorktrees,
  SETUP,
  SetupFailed,
  type PlumbingLog,
  type PreparedWorktree,
} from "./worktree.ts"

export type QueueRunOptions = Readonly<{
  /** The working repository the run reads and writes through. */
  repo: string
  /** The branch the queue lands on, at the remote holding it: `<remote>#<branch>`. */
  target: Target
  /** The checks the target declares, read from the target commit by the caller. A check with no `on` runs at merge. */
  checks: readonly CheckSpec[]
  /** The target's `setup:`: one shell command run in every worktree this run makes, before any check runs in it. */
  setup?: string
  /** The blob the checks were read from, recorded on every checked event. */
  configBlob: string
  /** What the queue notifies, per ending; an ending no entry wants runs nothing. */
  notify?: readonly Notifier[]
  /** The queue's working directory: its logs, its worktrees and its temp root; on the root filesystem. */
  workdir: string
  /** Why the queue is in the garage, when it is: a round the mechanic ran says so on its own record. */
  garage?: string
  /** Receives every log record as it is written, for the human rendering. */
  render?: (record: LogRecord) => void
  /** The logger the worktree plumbing narrates to; pass one only at trace. */
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
  /** The active merge freeze that made this run stop before a merge. */
  freeze?: FreezeEvent
  merged: readonly string[]
  failed: readonly string[]
  stuck: readonly string[]
  /** The commits on the target's first-parent line that the queue did not put there, reported this run (E5). */
  bypasses: readonly string[]
}>

/** Everything one run's steps share. */
type Run = {
  options: QueueRunOptions
  git: Git
  log: QueueRunLog
  /** The temp root every program this run starts gets as `TMPDIR`: `<workdir>/tmp`. */
  tmpdir: string
  worktrees: string
  /** The target the run read at its start; every judgement is against it. */
  targetSha: string
  /** What this queue calls itself wherever a stranger reads it: `<host>/<path>#<branch>`. */
  name: string
  /** The queue as this run read it: every change at the remote, and where each stood. */
  queue: QueueRead
  /** Set only when this run observed an active freeze. */
  freeze?: FreezeEvent
  /**
   * Gitlinks proven on their component's `main` this run, as `<path>@<sha>`:
   * a positive answer can only stay true, so the same pin is asked about at
   * most once per run however many changes move it (E4).
   */
  onMain: Set<string>
}

type Ended = "checked" | "failed" | "stuck" | "merged"

export async function queueRun(options: QueueRunOptions): Promise<QueueRunOutcome> {
  const git = options.git ?? gitIn(options.repo, options.process)
  const log = openLog(join(options.workdir, "logs"), undefined, options.render)
  // One reading of the remote yields both the queue and the commit the target
  // stood at when it was read, so the run never asks a second time and can
  // never judge against a target its own queue read did not see.
  const queue = await readQueue(git, options.target.remote, options.target.branch)
  const targetSha = queue.target
  const run: Run = {
    git,
    log,
    name: queueName(options.target, await remoteUrl(git, options.target.remote)),
    onMain: new Set(),
    options,
    queue: queue.changes,
    tmpdir: join(options.workdir, "tmp"),
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

  const entries = queue.changes
  // The run row: the pin (the target's commit) and the config blob the checks
  // were read from. Each change CONSIDERED writes its own row with its decision
  // when the run has made one; a change that ended in an earlier run is history,
  // and this run claims nothing about it.
  log.write({
    base: targetSha,
    checks: options.checks.map((check) => check.name),
    config: options.configBlob,
    ...(options.garage === undefined ? {} : { garage: options.garage }),
    kind: "run",
    pin: targetSha,
    queue: run.name,
    target: options.target.branch,
  })

  // A freeze already active when the round starts stops before worktree
  // cleanup, change retirement, checks or merge. It is normal queue state:
  // exit 0 keeps `queue up` ticking so an unfreeze is seen next interval.
  const frozenAtStart = await activeFreeze(git, options.target.remote)
  if (frozenAtStart !== undefined) {
    recordFreeze(run, frozenAtStart)
    return finish(run, 0, { bypasses: [], failed, merged, stuck })
  }

  // The worktrees of runs that are no longer alive, taken down before this run
  // makes any of its own: a killed run removes nothing, so its worktrees stay
  // registered in the repository and on disk until some later run clears them
  // (plan § Owed after M5; R8's stayed). One row per worktree, because a
  // directory that vanishes with nothing said about it is the silent kind of
  // cleanup nobody can audit.
  for (const taken of await reapWorktrees(git, join(options.workdir, "worktrees"), log.id)) {
    log.write({ kind: "reap", of: taken.of, path: taken.path, why: taken.why })
  }

  // Did something go around the queue? Read before any event is written, so a
  // bypass that merged a submitted head is reported before the catch-up below
  // accounts for it (E5). Nothing stops for it: the run judges every change on
  // the base it read.
  const bypasses = await reportBypasses(run, entries)

  // Bookkeeping at the edges of the events first, so every reader below reads
  // events and never reconciles: a branch that is gone or moved off a head ends
  // that head's change failed with the reason and no message (ruling B3); a
  // head the target already carries gets its merged event, so the tip catches
  // up with ancestry; an ended change whose message reached nobody is sent
  // again (at-least-once, § The queue run).
  for (const entry of entries) await retire(run, entry)
  for (const entry of entries) await catchUp(run, entry)
  for (const entry of entries) await resend(run, entry)

  // On-submit: every queued change, oldest first, in a fresh worktree of its
  // head. A stuck change kept its place, and this run takes it again from
  // here; so does a checked change whose checks ran under a check config the
  // target no longer declares (§ The queue run: a checked event is reused only
  // while the config blob is the one it names).
  for (const entry of ordered(entries, "queued", "stuck", "checked").filter(
    (entry) => entry.reading.state !== "checked" || staleChecked(run, entry),
  )) {
    const outcome = await guarded(run, entry, () => judge(run, entry))
    if (outcome === "stuck") {
      stuck.push(entry.change.branch)
      return finish(run, 2, { bypasses, failed, merged, stuck })
    }
    if (outcome === "failed") failed.push(entry.change.branch)
  }

  // On-merge: the first checked change in line, re-read so this run's own
  // checked events count.
  const checked = ordered((await readQueue(git, options.target.remote, options.target.branch)).changes, "checked").find(
    (entry) => !staleChecked(run, entry),
  )
  if (checked !== undefined) {
    const outcome = await guarded(run, checked, () => land(run, checked))
    if (outcome === "stuck") stuck.push(checked.change.branch)
    else if (outcome === "failed") failed.push(checked.change.branch)
    else if (outcome === "merged") merged.push(checked.change.branch)
  }

  return finish(run, stuck.length > 0 ? 2 : failed.length > 0 ? 1 : 0, { bypasses, failed, merged, stuck })
}

/** A checked change whose checked event names a config blob the target no longer declares. */
function staleChecked(run: Run, entry: QueueEntry): boolean {
  const tip = tipOf(entry.change)
  return tip.kind === "checked" && trailer(tip, "Config") !== run.options.configBlob
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
 * its parents, its subject and the pins it moved, and one run of the
 * `merged-bypass` hook with the commit sha as the record's id, so a resend
 * after a crash hands over the same record (E5). No event is written, because there is no change to
 * write one on; what the queue has already accounted for is read from git
 * (bypass.ts), so a second run says nothing new once the queue has landed
 * on top. The run never stops for it: the queue adapts already, judging every
 * change on the base it read.
 */
async function reportBypasses(run: Run, entries: QueueRead): Promise<readonly string[]> {
  const found = await bypassCommits(run.git, run.options.target.branch, run.targetSha, entries)
  const target = run.options.target.branch
  for (const commit of found) {
    run.log.write({
      branch: target,
      commit: commit.commit,
      gitlinks: commit.gitlinks,
      kind: "merged-bypass",
      parents: commit.parents,
      subject: commit.subject,
      why: commit.why,
    })
    const text = `${bypassLine(commit)}: ${commit.why}. The queue goes on from the new base; a rollback is a git revert, pushed through the queue.`
    // A bypass has no change, so the commit that went around the queue stands
    // where a change's name would (`NotifyEvent`).
    for (const { name, delivery, failure } of await notifyAll(run, BYPASS, {
      change: commit.commit,
      event: BYPASS,
    })) {
      run.log.write({
        about: target,
        branch: target,
        delivered: delivery === "sent",
        ...(failure === undefined ? {} : { error: failure }),
        head: commit.commit,
        id: commit.commit,
        kind: "message",
        says: BYPASS,
        text,
        to: name,
      })
    }
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
        subject: `the queue could not prepare a worktree for ${entry.change.branch}: ${message.slice(0, 200)}`,
        trailers: [["Reason", SETUP]],
      })
    }
    return end(run, entry, "stuck", {
      subject: `the queue crashed judging ${entry.change.branch}: ${message.slice(0, 200)}`,
      trailers: [["Reason", "crash"]],
    })
  }
}

/**
 * A fresh worktree of `commit`, with the target's `setup:` run in it before
 * anything judges it (§ The queue run). The setup's log and temp root are the
 * phase's own, so one worktree's records sit together, and its result is
 * recorded in the check's shape: what ran, then how it ended, billed to the
 * queue whichever way it went.
 */
async function prepare(
  run: Run,
  entry: QueueEntry,
  commit: string,
  path: string,
  phase: "submit" | "merge",
): Promise<PreparedWorktree> {
  const logDir = checkLogDir(run, entry, phase)
  const about = { branch: entry.change.branch, head: entry.change.head, name: SETUP, phase }
  return prepareWorktree(run.git, run.options.repo, commit, path, {
    env: run.options.env,
    plumbing: run.options.plumbing,
    process: run.options.process,
    record: ({ result, start, end: ended }) => record(run, { ...about, end: ended, start }, result),
    ...(run.options.setup === undefined ? {} : { setup: { logDir, run: run.options.setup, tmpdir: run.tmpdir } }),
    starting: ({ log, start }) => started(run, { ...about, log, start }),
    targetSha: run.targetSha,
  })
}

/** The on-submit phase for one queued change. */
async function judge(run: Run, entry: QueueEntry): Promise<Ended> {
  const { change } = entry
  const { branch, head } = change
  // The built-in check: the head shares ancestry with the target. The target
  // moves under every queued change by design, so "descends from the tip" would
  // fail every change behind a merge; an unrelated history is what a merge
  // must never splice in.
  if ((await mergeBase(run.git, head, run.targetSha)) === undefined) {
    return end(run, entry, "failed", {
      remedy: `rebase ${branch} onto ${run.options.target.branch} and submit again`,
      subject: `${branch} shares no history with ${run.options.target.branch}`,
      trailers: [["Reason", "unrelated-history"]],
    })
  }
  const worktree = await prepare(run, entry, head, join(run.worktrees, "submit", head.slice(0, 12)), "submit")
  try {
    // The built-in check: every gitlink the change moved reachable from its
    // component's main (E4).
    const offMain = await gitlinkOffMain(run, head, worktree.path)
    if (offMain !== undefined) {
      return await end(run, entry, "failed", {
        remedy: `land ${offMain.path}'s commit on its main first, pin that, and submit again`,
        subject: `${branch} pins ${offMain.path} at ${offMain.sha.slice(0, 12)}, which its main does not carry`,
        trailers: [
          ["Reason", "gitlink-off-main"],
          ["Gitlink", `${offMain.path} ${offMain.sha}`],
        ],
      })
    }
    const results = await runPhase(run, entry, "submit", worktree.path, worktree.tree)
    const stuckOne = results.find((result) => result.result === "stuck")
    if (stuckOne !== undefined) {
      return await end(run, entry, "stuck", {
        subject: `the queue could not judge ${branch}: ${stuckOne.name} ${stuckOne.why ?? ""}`.trim(),
        trailers: [["Reason", stuckOne.name], ...checkTrailers(results)],
      })
    }
    const failing = results.filter((result) => result.result === "fail")
    if (failing.length > 0) return await endFailing(run, entry, results, failing, "submit")
    await writeEvent(run, {
      change,
      kind: "checked",
      subject: `${branch} passed the on-submit checks at ${run.options.target.branch} ${run.targetSha.slice(0, 12)}`,
      target: targetName(run.options.target),
      trailers: [["Config", run.options.configBlob], ["Base", run.targetSha], ...checkTrailers(results)],
    })
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
  const { change } = entry
  const { branch, head } = change
  const name = changeName(change)
  const worktree = await prepare(run, entry, run.targetSha, join(run.worktrees, "merge", head.slice(0, 12)), "merge")
  try {
    const wt = gitIn(worktree.path, run.options.process)
    let mergeCommit: string
    try {
      // The merge commit names its change back, by the change's own name, so
      // `git log main` says which change every merge came from and
      // `git log refs/yrd/changes/<that name>` prints its events (E5). The
      // submitter and the issue come with it, as the opened event carried
      // them forward, one trailer per line in git's own trailer format.
      const tip = tipOf(change)
      const issue = trailer(tip, "Issue")
      const submitter = trailer(tip, "Submitter")
      const message = [
        `merge ${short(branch, head)} into ${run.options.target.branch}`,
        "",
        `Change: ${name}`,
        `Merged-By: ${mergedBy(run.name, run.log.id)}`,
        ...(issue === undefined ? [] : [`Issue: ${issue}`]),
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
      return await end(run, entry, "failed", {
        remedy: `rebase ${branch} onto ${run.options.target.branch}, resolve the conflict, push, and submit again`,
        subject: `${branch} conflicts with ${run.options.target.branch}`,
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
      return await end(run, entry, "failed", {
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
      return await end(run, entry, "stuck", {
        subject: `the queue could not judge ${branch} at merge: ${stuckOne.name} ${stuckOne.why ?? ""}`.trim(),
        trailers: [["Reason", stuckOne.name], ...checkTrailers(results)],
      })
    }
    const failing = results.filter((result) => result.result === "fail")
    if (failing.length > 0) return await endFailing(run, entry, results, failing, "merge")
    // Pass. The merge is ours to make only while the target is still where this
    // change was checked against and the branch still at the head; otherwise the
    // change keeps its place and is checked again at the new target next run.
    const remoteNow = await remoteHeads(run, branch)
    if (remoteNow.target !== run.targetSha || remoteNow.branch !== head) {
      run.log.write({
        branch,
        decision: "checked",
        head,
        kind: "change",
        reason: remoteNow.target !== run.targetSha ? "target-moved" : "branch-moved",
      })
      return "checked"
    }
    await run.git(["fetch", "--quiet", worktree.path, mergeCommit])
    // The merged event says how it was merged and what it checked: by the queue,
    // with the on-merge checks' results, in the shape the checked event uses.
    const mergedEvent = await appendEvent(run.git, {
      change,
      kind: "merged",
      subject: `${branch} merged into ${run.options.target.branch} as ${mergeCommit.slice(0, 12)}`,
      target: targetName(run.options.target),
      trailers: [
        ["Merge", mergeCommit],
        ["Base", run.targetSha],
        ["Merged-By", mergedBy(run.name, run.log.id)],
        ...checkTrailers(results),
      ],
    })
    // The last authority read before the merge push. A freeze placed while
    // checks were running leaves the change checked and in line; the service
    // sees an unfreeze on its next interval without ever stopping.
    const frozenBeforeMerge = await activeFreeze(run.git, run.options.target.remote)
    if (frozenBeforeMerge !== undefined) {
      recordFreeze(run, frozenBeforeMerge)
      run.log.write({ branch, decision: "checked", head, kind: "change", reason: "frozen" })
      return "checked"
    }
    const ref = changeRef(change)
    try {
      await run.git([
        "push",
        "--quiet",
        "--atomic",
        `--force-with-lease=refs/heads/${run.options.target.branch}:${run.targetSha}`,
        run.options.target.remote,
        `${mergeCommit}:refs/heads/${run.options.target.branch}`,
        `${mergedEvent}:${ref}`,
      ])
    } catch (error) {
      // The reading just above and this lease are two moments, and the target
      // can move between them: the lease then refuses the push and nothing
      // lands. That is ruling D4 — a target that moved under a checked change
      // keeps its place and is judged again at the new target next run — not a
      // queue that could not do its job, so it must not end the change stuck.
      // The remote decides which it was; git's rejection prose does not.
      const moved = await remoteHeads(run, branch)
      if (moved.target === run.targetSha && moved.branch === head) throw error
      run.log.write({
        branch,
        decision: "checked",
        head,
        kind: "change",
        reason: moved.target !== run.targetSha ? "target-moved" : "branch-moved",
        saw: moved.target ?? "gone",
      })
      return "checked"
    }
    run.log.write({ branch, change: name, commit: mergeCommit, head, kind: "merge", tip: mergeCommit })
    run.log.write({ branch, decision: "merged", head, kind: "change" })
    await send(
      run,
      entry,
      mergedEvent,
      "merged",
      messageFor("merged", { branch, head, merge: mergeCommit, subject: "" }),
    )
    return "merged"
  } finally {
    await worktree.remove()
  }
}

/**
 * A failing check ends the change failed, the submitter's, at once, with the
 * check, its exit, its duration and its log path.
 *
 * It used to run the same check again in the change's worktree and once more
 * at the target before billing anybody, so that a coin flip or a red target
 * ended the change stuck instead. Measured over 257 check runs since flag day,
 * that reading changed no verdict at all: all 7 second runs failed again and
 * all 14 target runs passed. What it cost was two extra check runs and a whole
 * worktree of the target for every failure, on the queue's critical path
 * (operator ruling 2026-09-03). A flake is the author's to retry; the target is
 * proven green by its own last merge.
 */
async function endFailing(
  run: Run,
  entry: QueueEntry,
  results: readonly CheckResult[],
  failing: readonly CheckResult[],
  phase: "submit" | "merge",
): Promise<Ended> {
  const first = failing[0]
  return end(run, entry, "failed", {
    remedy: `fix ${first?.name ?? "the check"} (log: ${first?.log ?? ""}), push, and submit again`,
    subject: `${entry.change.branch} failed ${failing.map((result) => result.name).join(", ")}${phase === "merge" ? " at merge" : ""}`,
    trailers: [["Reason", first?.name ?? "check"], ...checkTrailers(results)],
  })
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
  const endedAs = endedKind(tipOf(entry.change))
  if (endedAs === "failed" || endedAs === "merged") return
  const { change } = entry
  const { branch, head } = change
  const retiredEvent = await writeEvent(run, {
    change,
    kind: "failed",
    subject:
      reason === "deleted"
        ? `${branch} was deleted by its submitter`
        : `${branch} moved off ${head.slice(0, 12)}; its submitter replaced it`,
    target: targetName(run.options.target),
    trailers: [["Reason", reason]],
  })
  if (retiredEvent === undefined) return
  run.log.write({ branch, decision: "failed", head, kind: "change", reason })
}

/**
 * A head the target already carries with no merged event yet — merged around the
 * queue in the garage, or by a run that crashed after its push — gets its
 * merged event now, naming the commit that landed it and saying so, and
 * its submitter is told (§ The change: ancestry wins, and the next queue run
 * appends the merged event so the tip catches up). A retired change is left as
 * it ended.
 */
async function catchUp(run: Run, entry: QueueEntry): Promise<void> {
  if (!entry.change.headOnTarget) return
  const tip = tipOf(entry.change)
  if (endedKind(tip) === "merged") return
  const reason = trailer(tip, "Reason")
  if (reason === "replaced" || reason === "deleted") return
  const { change } = entry
  const { branch, head } = change
  // The first commit on the target's first-parent line that descends from the
  // head is the one that landed it; none means the head was fast-forwarded.
  // `--parents` names its first parent in the same reading, so `Base:` is a
  // sha like every other Base and not a revision expression a reader would
  // have to give back to git to resolve.
  const landing = (
    await run.git([
      "rev-list",
      "--reverse",
      "--first-parent",
      "--ancestry-path",
      "--parents",
      `${head}..${run.targetSha}`,
    ])
  )
    .trim()
    .split("\n")[0]
    ?.trim()
    .split(/\s+/u)
    .filter((sha) => sha !== "")
  const merge = landing?.[0] ?? head
  const base = landing?.[1] ?? head
  const mergedEvent = await writeEvent(run, {
    change,
    kind: "merged",
    subject: `merged around the queue at ${merge.slice(0, 12)}`,
    target: targetName(run.options.target),
    trailers: [
      ["Merge", merge],
      ["Base", base],
      ["Merged-By", BYPASS_MERGE],
    ],
  })
  if (mergedEvent === undefined) return
  run.log.write({ branch, decision: "merged", head, kind: "change", reason: "already on the target" })
  await send(run, entry, mergedEvent, "merged", messageFor("merged", { branch, head, merge, subject: "" }))
}

/**
 * Every ended change whose message reached nobody is sent again: an ended tip
 * with no sent event (a crash between the two), or a sent event whose delivery
 * failed. The id is the ended event's sha, so whoever hears it sees one message
 * however many times it is sent (§ The queue run, at-least-once).
 */
async function resend(run: Run, entry: QueueEntry): Promise<void> {
  const tip = tipOf(entry.change)
  // The head is on the target and this tip does not say merged: the catch-up
  // just above owns this change — it wrote the merged event and sent its message
  // this run, so this entry's tip is a reading from before that. Sending from
  // it would put `sent State: failed` on top of a merged change and tell its
  // submitter to fix what has already landed (ruling A2).
  if (entry.change.headOnTarget && endedKind(tip) !== "merged") return
  const undelivered = tip.kind === "sent" && trailer(tip, "Delivery") === "failed"
  const unsent = tip.kind === "failed" || tip.kind === "stuck" || tip.kind === "merged"
  if (!undelivered && !unsent) return
  // A retired change sends nothing (ruling B3).
  const reason = trailer(tip, "Reason")
  if (reason === "replaced" || reason === "deleted") return
  const endedSha = tip.kind === "sent" ? trailer(tip, "For") : tip.sha
  if (endedSha === undefined) {
    throw new Error(`${entry.change.branch}: sent event ${tip.sha.slice(0, 12)} names no ended event to send again`)
  }
  const ended = tip.kind === "sent" ? await readEvent(run.git, endedSha) : tip
  if (ended.kind !== "failed" && ended.kind !== "stuck" && ended.kind !== "merged") {
    throw new Error(`${entry.change.branch}: ${endedSha.slice(0, 12)} is a ${ended.kind} event, not an ended one`)
  }
  await send(
    run,
    entry,
    ended.sha,
    ended.kind,
    messageFor(ended.kind, {
      branch: entry.change.branch,
      head: entry.change.head,
      merge: trailer(ended, "Merge") ?? "",
      remedy: trailer(ended, "Remedy"),
      subject: ended.subject,
    }),
  )
}

/** A change as a person reads it: the branch and twelve characters of the head, the trailer's spelling shortened. */
function short(branch: string, head: string): string {
  return `${branch}@${head.slice(0, 12)}`
}

/** The one message an ended change sends, in the plan's three shapes (§ Commands). */
function messageFor(
  kind: "merged" | "failed" | "stuck",
  about: Readonly<{ branch: string; head: string; subject: string; merge?: string; remedy?: string }>,
): string {
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
async function restoreScripts(run: Run, spec: CheckSpec, cwd: string): Promise<void> {
  const scripts = spec.scripts ?? []
  if (scripts.length === 0) return
  const wt = gitIn(cwd, run.options.process)
  for (const path of scripts) {
    if (
      (await refAt(run.git, `${run.targetSha}:${path}`, "blob")) === undefined &&
      (await refAt(run.git, `${run.targetSha}:${path}`, "tree")) === undefined
    ) {
      throw new Error(
        `check ${spec.name} declares scripts: ${path}, which the target ${run.targetSha.slice(0, 12)} does not carry`,
      )
    }
    await wt(["checkout", "--quiet", run.targetSha, "--", path])
  }
}

/**
 * Where every log of one change's phase goes: keyed by the change, this run and
 * the phase, so no two writes can name one file and every log is written once
 * (check.ts opens them create-only). The setup and the checks that follow it
 * share the directory, and both used to spell it out for themselves.
 */
function checkLogDir(run: Run, entry: QueueEntry, phase: "submit" | "merge"): string {
  return join(run.options.workdir, "checks", changeName(entry.change), run.log.id, phase)
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

async function check(
  run: Run,
  entry: QueueEntry,
  spec: CheckSpec,
  cwd: string,
  tree: CheckedTree,
  phase: "submit" | "merge",
): Promise<CheckResult> {
  await restoreScripts(run, spec, cwd)
  const logDir = checkLogDir(run, entry, phase)
  const about = {
    branch: entry.change.branch,
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
    tmpdir: run.tmpdir,
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
  about: Readonly<{
    branch: string
    head: string
    name: string
    phase: string
    start: string
    log: string
    scripts?: readonly string[]
  }>,
): void {
  run.log.write({ ...about, kind: "check" })
}

/**
 * The two records every program the queue runs writes, one shape for all of
 * them: what ran, then how it ended. `whose` is who the result is billed to —
 * a stuck result is always the queue's, and so is anything the setup did,
 * because the setup is the queue's own ground rather than the change; a
 * failing check is the submitter's, which is the whole of the rule.
 */
function record(
  run: Run,
  about: Readonly<{
    branch: string
    head: string
    name: string
    phase: string
    start: string
    end: string
    scripts?: readonly string[]
  }>,
  result: CheckResult,
): void {
  const common = { branch: about.branch, head: about.head, name: about.name, phase: about.phase }
  run.log.write({
    ...common,
    end: about.end,
    kind: "check",
    log: result.log,
    ms: result.durationMs,
    ...(about.scripts === undefined ? {} : { scripts: about.scripts }),
    start: about.start,
  })
  const whose =
    result.result === "pass" ? undefined : result.result === "stuck" || about.name === SETUP ? "queue" : "submitter"
  run.log.write({ ...common, exit: String(result.exit), kind: "result", result: result.result, whose })
}

async function end(
  run: Run,
  entry: QueueEntry,
  kind: "failed" | "stuck",
  ended: Readonly<{ subject: string; trailers: readonly (readonly [string, string])[]; remedy?: string }>,
): Promise<Ended> {
  // Who is billed follows from the kind, once: a fail is the submitter's, and
  // says so; a stuck is always the queue's, so its event says nothing about
  // fault (a constant trailer says nothing). A `replaced` or `deleted` change
  // bills nobody and never comes through here.
  const trailers = [
    ...ended.trailers,
    ...(kind === "failed" ? [["Fault", "submitter"] as const] : []),
    ...(ended.remedy === undefined ? [] : [["Remedy", ended.remedy] as const]),
  ]
  const event = await writeEvent(run, {
    change: entry.change,
    kind,
    subject: ended.subject,
    target: targetName(run.options.target),
    trailers,
  })
  run.log.write({
    branch: entry.change.branch,
    decision: kind,
    head: entry.change.head,
    kind: "change",
    reason: ended.subject,
  })
  // No event, no message: the message's id IS that event's sha, and the next
  // run's reading of the remote is what repairs the ending (24096).
  if (event !== undefined) {
    await send(
      run,
      entry,
      event,
      kind,
      messageFor(kind, {
        branch: entry.change.branch,
        head: entry.change.head,
        remedy: ended.remedy,
        subject: ended.subject,
      }),
    )
  }
  return kind
}

/** One message per ended change, after its ended event; the event's sha is the id. */
async function send(
  run: Run,
  entry: QueueEntry,
  endedEvent: string,
  kind: "merged" | "failed" | "stuck",
  text: string,
): Promise<void> {
  const ended = await readEvent(run.git, endedEvent)
  // The queue addresses nobody. It says what happened and runs the entries that
  // want this ending; who hears about it is their own business. The submitter
  // travels with the event as the opaque string the submit gave — `unknown` is
  // what a submit with neither `--notify` nor `YRD_DEFAULT_SUBMITTER` records
  // (rulings B6 and D9), and it is not a seat.
  const submitter = trailer(ended, "Submitter")
  const known = submitter !== undefined && submitter !== "unknown"
  const issue = trailer(ended, "Issue")
  const lastCheck = trailers(ended, "Check").at(-1)
  const log = lastCheck === undefined ? run.log.path : (readCheckTrailer(lastCheck).log ?? run.log.path)
  const handed = await notifyAll(run, kind, {
    change: changeName(entry.change),
    event: kind,
    ...(issue === undefined ? {} : { issue }),
    ...(known ? { submitter } : {}),
    ...(kind === "merged" ? { merge: trailer(ended, "Merge") ?? "" } : { log, reason: reasonFor(kind, ended) }),
    ...(kind === "failed" ? { failures: await failuresOf(run, entry) } : {}),
  })
  for (const { name, delivery, failure } of handed) {
    // One sent event per entry that fired, so a reader can see which of them the
    // queue reached. The sent event repeats the ended state and carries the
    // ended event's result, so the tip event's trailers stay the whole answer
    // about the change and no reader has to walk to the event before (ruling A2).
    const sentWrite: WriteEvent = {
      change: entry.change,
      kind: "sent",
      subject: `${said(delivery)} ${name}: ${text}`.slice(0, 200),
      target: targetName(run.options.target),
      trailers: [
        ["Message-Id", endedEvent],
        ["To", name],
        ["State", kind],
        ["For", endedEvent],
        ["Delivery", delivery],
        ...(failure === undefined ? [] : [["Delivery-Error", failure] as const]),
        ...ended.trailers.filter(([key]) => RESULT_TRAILERS.has(key)),
      ],
    }
    const sentEvent = await writeEvent(run, sentWrite)
    // `delivered` is the whole truth about this message or it is worth nothing:
    // an event a notifier took whose sent event never landed WILL be handed over
    // again by the next run, so it is not delivered, and the log says which half
    // failed rather than claiming the id is settled.
    const unrecorded =
      sentEvent === undefined
        ? `the sent event for ${endedEvent.slice(0, 12)} was not written; the next run sends it again`
        : undefined
    const trouble = [failure, unrecorded].filter((why): why is string => why !== undefined).join("; ")
    run.log.write({
      about: entry.change.branch,
      branch: entry.change.branch,
      delivered: delivery === "sent" && sentEvent !== undefined,
      ...(trouble === "" ? {} : { error: trouble }),
      head: entry.change.head,
      id: endedEvent,
      kind: "message",
      says: kind,
      text,
      to: name,
    })
  }
}

/**
 * The JSON object a notify entry reads on its stdin: the event itself, the same
 * one the change's ref stores, in the fields a reader needs and nothing else.
 *
 * `event` says which ending it is and `change` which change — its name, or for
 * a bypass the commit that went around the queue. `submitter` and `issue` are
 * there when the submit gave them. `merged` carries the merge it made; `failed`
 * and `stuck` carry why and where to read it, and `failed` how many times this
 * branch has been sent back, the number the root's notifier raises an andon on.
 *
 * No id, no subject, no remedy, no prose: an entry composes what it says, and
 * the identity of a message is its change and its event — a resend after a
 * crash hands over the same object.
 */
export type NotifyEvent = Readonly<{
  event: Ending
  change: string
  submitter?: string
  issue?: string
  merge?: string
  reason?: string
  log?: string
  failures?: number
}>

/** Why a change ended, as its event says it: the check for a fail, the sentence for a stuck. */
function reasonFor(kind: "failed" | "stuck", ended: Event): string {
  return kind === "failed" ? (trailer(ended, "Reason") ?? "check") : ended.subject
}

/** The ending a bypass is; the other three are how a change itself ended. */
const BYPASS = "merged-bypass"

/** The entry name a sent event carries when the declaration wanted nobody told. */
const NOBODY = "none"

/** What a sent event's subject says about its entry, in two words. */
function said(delivery: Delivery): string {
  return delivery === "sent" ? "told" : delivery === "none" ? "told nobody:" : "could not tell"
}

/** A change ended by its submitter moving on, which is not a failure of anything. */
const MOVED_ON = new Set(["replaced", "deleted"])

/**
 * How many times this branch has been sent back, this ending included — the
 * number the notifier raises an andon on at two or more. A merged or stuck
 * ending adds nothing to it, and neither does a change the submitter replaced
 * or deleted; the count is about a branch that keeps failing its checks.
 *
 * Two readings, because a branch's failures live in two places: the tips of its
 * OTHER changes, which the queue read already holds, and this change's own
 * events, where a retry at an unchanged head appends a second opened event and a
 * second failure under one ref, so the tip alone would forget the first.
 */
async function failuresOf(run: Run, entry: QueueEntry): Promise<number> {
  const elsewhere = run.queue.filter((candidate) => {
    if (candidate.change.branch !== entry.change.branch || candidate.change.head === entry.change.head) return false
    const tip = tipOf(candidate.change)
    return endedKind(tip) === "failed" && !MOVED_ON.has(trailer(tip, "Reason") ?? "")
  }).length
  const own = await readEvents(run.git, entry.change)
  return (
    elsewhere + own.filter((event) => event.kind === "failed" && !MOVED_ON.has(trailer(event, "Reason") ?? "")).length
  )
}

/** How one notify entry went: it took the event, there was none to take it, or it exited non-zero. */
type Delivery = "sent" | "none" | "failed"

/** One entry's turn: which entry, and how it went. */
type Handed = Readonly<{ name: string; delivery: Delivery; failure?: string }>

/**
 * Give one event to every `notify:` entry that wants this ending, in the order
 * the declaration lists them, and say how each went.
 *
 * An ending no entry wants is answered by one turn under the name `none` and
 * `Delivery: none` (ruling A4): the queue still records that it had something
 * to say and nobody to say it to, because an ending with no event at all reads
 * exactly like an ending nobody has got to yet.
 */
async function notifyAll(run: Run, ending: Ending, event: NotifyEvent): Promise<readonly Handed[]> {
  const wanted = (run.options.notify ?? []).filter((entry) => entry.on.includes(ending))
  if (wanted.length === 0) return [{ delivery: "none", name: NOBODY }]
  const handed: Handed[] = []
  for (const entry of wanted) handed.push({ ...(await deliver(run, entry, event)), name: entry.name })
  return handed
}

/**
 * Run one notify entry's command, the event a JSON object on its stdin, and
 * say how it went: `sent` when it accepted the event, `failed` with why when it
 * exited non-zero. A command that fails changes nothing about what a change IS:
 * the ended event stands and the next run hands it the same event again
 * (ruling D9). Nothing here throws, so a failed notifier can never end a merged
 * change stuck.
 */
async function deliver(
  run: Run,
  entry: Notifier,
  event: NotifyEvent,
): Promise<Readonly<{ delivery: Delivery; failure?: string }>> {
  const command = entry.run
  const runner = run.options.process ?? createProcess({ cwd: run.options.repo })
  const result = await runner.run({
    argv: shellCommand(command),
    cwd: run.options.repo,
    env: run.options.env,
    stdin: `${JSON.stringify(event)}\n`,
    timeoutMs: 60_000,
  })
  if (result.exitCode === 0) return { delivery: "sent" }
  return {
    delivery: "failed",
    failure: `the notify entry ${entry.name} exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`
      .replace(/\s+/gu, " ")
      .slice(0, 300),
  }
}

/** An ended event's result, as its sent event carries it forward. */
const RESULT_TRAILERS = new Set(["Reason", "Fault", "Remedy", "Check", "Merge", "Base", "Gitlink", "Merged-By"])

function checkTrailers(results: readonly CheckResult[]): readonly (readonly [string, string])[] {
  return results.map((result) => ["Check", checkTrailer(result)] as const)
}

/**
 * The one writer of an event: the commit object appended onto the tip the run
 * read the change at, pushed under a lease for that same tip.
 *
 * There is nothing to align and no local ref to lose. The remote is the store,
 * `--force-with-lease` is what proves nobody else moved the ref between the
 * reading and the push, and the object being immutable is what makes a retry
 * cheap: on a refusal the run takes the winner's tip, writes the same event onto
 * it, and pushes once more. A second refusal is written down and left for the
 * next run's catch-up to repair, because a queue that spins on a contended ref
 * is a queue that is not judging anything (24096).
 */
async function writeEvent(run: Run, write: WriteEvent): Promise<string | undefined> {
  const ref = changeRef(write.change)
  let onto = await refAt(run.git, ref)
  if (onto === undefined) {
    throw new Error(`${ref} is not here; the queue read fetched every change ref the remote listed`)
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const event = await eventCommit(run.git, write, onto)
    try {
      await run.git([
        "push",
        "--quiet",
        `--force-with-lease=${ref}:${onto}`,
        run.options.target.remote,
        `${event}:${ref}`,
      ])
      // The local ref follows what the remote has just accepted, so a second
      // event written for this change in the same run — an ending and then its
      // sent event — starts from the tip that is really there.
      await run.git(["update-ref", ref, event])
      return event
    } catch (error) {
      // Git's rejection text varies (`stale info`, `fetch first`,
      // `non-fast-forward`), so the remote's own tip decides whether this was a
      // race. A transport or auth failure leaves the lease base standing and
      // stays loud.
      const now = await fetchRemoteChange(run, ref)
      if (now === onto) throw error
      onto = now
      run.log.write({
        branch: write.change.branch,
        decision: write.kind,
        head: write.change.head,
        kind: "change",
        reason: "change-ref-taken",
        remote: now,
      })
    }
  }
  run.log.write({
    branch: write.change.branch,
    decision: write.kind,
    head: write.change.head,
    kind: "change",
    reason: "change-ref-contended",
    remote: onto,
  })
  return undefined
}

/** Read one authoritative remote change tip and make that exact object local. */
async function fetchRemoteChange(run: Run, ref: string): Promise<string> {
  // A run-private destination says which object this fetch actually received.
  // `ls-remote` followed by a moving-ref fetch can advertise A, fetch B, then
  // leave A unavailable for the ancestry check.
  const fetchedRef = `refs/yrd/fetched/${run.log.id}`
  await run.git(["fetch", "--quiet", "--no-recurse-submodules", run.options.target.remote, `+${ref}:${fetchedRef}`])
  const remote = await refAt(run.git, fetchedRef)
  if (remote === undefined) throw new Error(`${ref}: fetch completed without a change tip`)
  await run.git(["update-ref", "-d", fetchedRef, remote])
  return remote
}

/**
 * The URL a remote name stands for, or the name itself when git has no such
 * remote — the declaration may name a URL outright, and `resolveRemote` has
 * already made it a name by the time a run sees it.
 */
async function remoteUrl(git: Git, remote: string): Promise<string> {
  try {
    return (await git(["remote", "get-url", remote])).trim()
  } catch {
    return remote
  }
}

/** Where the target and one branch stand at the remote right now. */
async function remoteHeads(run: Run, branch: string): Promise<Readonly<{ target?: string; branch?: string }>> {
  const rows = (
    await run.git([
      "ls-remote",
      "--refs",
      run.options.target.remote,
      `refs/heads/${run.options.target.branch}`,
      `refs/heads/${branch}`,
    ])
  ).split("\n")
  const at = new Map(rows.map((row) => row.trim().split(/\s+/u)).map(([sha, ref]) => [ref ?? "", sha ?? ""]))
  return { branch: at.get(`refs/heads/${branch}`), target: at.get(`refs/heads/${run.options.target.branch}`) }
}

async function finish(
  run: Run,
  exitCode: 0 | 1 | 2,
  lists: Readonly<{ merged: string[]; failed: string[]; stuck: string[]; bypasses: readonly string[] }>,
): Promise<QueueRunOutcome> {
  // A push updates the remote-tracking ref it pushed to, so after a merge the
  // target as this run left it is right there; a run that merged nothing left
  // it where it found it.
  const targetNow =
    lists.merged.length === 0
      ? run.targetSha
      : ((await refAt(run.git, `refs/remotes/${run.options.target.remote}/${run.options.target.branch}`)) ??
        run.targetSha)
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
    ...(run.freeze === undefined ? {} : { freeze: run.freeze }),
    log: run.log.path,
    run: run.log.id,
    target: targetNow,
    ...lists,
  }
}

/** Record one active freeze in the run's structured log and outcome. */
function recordFreeze(run: Run, freeze: FreezeEvent): void {
  run.freeze = freeze
  run.log.write({
    by: freeze.by,
    kind: "freeze",
    reason: freeze.reason,
    since: freeze.at.toISOString(),
    state: freeze.kind,
  })
}
