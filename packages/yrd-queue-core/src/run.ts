/**
 * One queue run ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design,
 * The queue run and Attribution).
 *
 * Read the checks from the target. For every queued change, oldest first: a
 * settled composition of the target plus the head and the on-submit checks;
 * pass writes checked, fail writes failed and tells the submitter, stuck writes
 * stuck and stops the run. Then the first checked change in line is composed
 * and settled again for the on-merge checks; pass
 * with the target still at the checked base and the branch still at the head
 * fast-forwards the target to the merge commit. Every ended change sends one
 * message, after its ended record is written, with that record's sha as the id.
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
 * failing, so the change ends stuck with a complete incident and nobody is billed.
 *
 * A branch at the remote with no change is not a change (E2): the queue read
 * never lists it, so nothing here judges, opens or messages it. `submit` is
 * the one writer of an opened record; a run only ever appends to a change that
 * exists.
 *
 * Only the queue pushes the target, by rule, and every run proves it before
 * it judges anything: each commit on the target's first-parent line since the
 * queue's own history starts that the queue did not put there is reported
 * once, and the run goes on from the new base (E5; the reading is direct.ts).
 *
 * Exit 0 when nothing ended failed or stuck, 1 when a change ended failed,
 * 2 on stuck. A stuck change stays open and the run stops there: the queue
 * could not do its own job, and the next thing to happen is a person.
 */

import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { createProcess, type Process } from "@yrd/process"
import { checkLogPath, checkTrailer, runCheck, type CheckedTree, type CheckResult, type CheckSpec } from "./check.ts"
import {
  appendRecord,
  DIRECT_MERGE,
  endedKind,
  recordCommit,
  mergedBy,
  trailer,
  type Git,
  type WriteRecord,
} from "./records.ts"
import { queueName, readConfig, type Target } from "./config.ts"
import { gitEnvironment, gitIn, mergeBase, refAt } from "./git.ts"
import { incidentTrailers } from "./incident.ts"
import { openLog, type LogRecord, type QueueRunLog } from "./log.ts"
import { directMergeCommits, type DirectMerge } from "./direct.ts"
import { changeName, changeRef } from "./refs.ts"
import { composed, type RingOptions } from "./rings.ts"
import { readQueue, type QueueEntry, type QueueRead } from "./remote.ts"
import { inLine, tipOf } from "./state.ts"
import {
  checkedTree,
  claimWorktrees,
  freshWorktree,
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
  /** The blob the checks were read from, recorded on every checked record. */
  configBlob: string
  /** The queue workdir: its logs, its worktrees and its temp root; on the root filesystem. */
  workdir: string
  /** Receives every log record as it is written, for the human rendering. */
  render?: (record: LogRecord) => void
  /** The logger the worktree plumbing narrates to; pass one only at trace. */
  plumbing?: PlumbingLog
  git?: Git
  process?: Process
  env?: NodeJS.ProcessEnv
}> &
  RingOptions

export type QueueRunOutcome = Readonly<{
  exitCode: 0 | 1 | 2
  log: string
  run: string
  /** The target's commit every judgement was made against, and the config blob the checks came from. */
  base: string
  config: string
  /** The target after the run. */
  target: string
  /** What a ring stopped this round for, before any merge could be made, when one did. */
  stopped?: Stopped
  merged: readonly string[]
  failed: readonly string[]
  stuck: readonly string[]
  /** The commits on the target's first-parent line that the queue did not put there, reported this run (E5). */
  directMerges: readonly string[]
}>

/** Everything one run's steps share. */
export type Run = Readonly<{
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
  /** The steps this run is made of, rings and all: every step call goes through these. */
  steps: Steps
  /** Say a ring stopped this round before it could merge; the outcome carries what it said. */
  stop: (stopped: Stopped) => void
}>

type Ended = "checked" | "waiting" | "failed" | "stuck" | "merged"

/** Which side of a change a step is on: the head it was submitted at, or its merge with the target. */
type CandidatePhase = "submit" | "merge"
type Phase = CandidatePhase | "base"

/** What an ending record will say, before it is written. */
type EndedWrite = Readonly<{
  subject: string
  trailers: readonly (readonly [string, string])[]
  remedy?: string
}>

/**
 * A ring stopped this round before it could merge, and says so.
 *
 * `ring` names the ring, `says` is its one line for a person, and `what` is the
 * ring's own record of the stop, whose shape only that ring and its readers
 * know. The loop carries it out on the outcome and reads none of it.
 */
export type Stopped = Readonly<{ ring: string; says: string; what: unknown }>

/**
 * One atomic push as a plan, so a ring can add to it before it is made: the refs
 * it moves, `[object, ref]`, and the leases proving nobody else moved them,
 * `[ref, expected]`.
 */
export type PushPlan = Readonly<{
  updates: readonly (readonly [string, string])[]
  leases: readonly (readonly [string, string])[]
}>

/**
 * What one atomic push did. A push that did not land names what moved under it
 * when the pusher could read one; no `reason` is a push that found nothing
 * moved, and its caller raises `error` rather than inventing a race.
 */
export type Pushed =
  | Readonly<{ landed: true }>
  | Readonly<{ landed: false; reason?: string; saw?: string; error: unknown }>

/**
 * The steps one run is made of, every member a function, so a ring is a function
 * from this bundle to this bundle: a feature is one file and one line of
 * rings.ts, and deleting those two takes the whole of it.
 *
 * Every step call inside a run goes through `Run.steps`, the composed bundle,
 * so a ring sees every call rather than only the ones the loop happens to make.
 */
export type Steps = Readonly<{
  /** Once, at the top of the round. A value stops the round and becomes its outcome. */
  open: (run: Run) => Promise<Stopped | undefined>
  /** One pass per entry before anything is judged. */
  bookkeep: (run: Run, entry: QueueEntry) => Promise<void>
  prepare: (run: Run, entry: QueueEntry, commit: string, path: string, phase: Phase) => Promise<PreparedWorktree>
  judge: (run: Run, entry: QueueEntry) => Promise<Ended>
  land: (run: Run, entry: QueueEntry) => Promise<Ended>
  /** The one atomic push a merge makes; a ring adds to the plan before it is made. */
  push: (run: Run, entry: QueueEntry, plan: PushPlan) => Promise<Pushed>
  end: (run: Run, entry: QueueEntry, kind: "failed" | "stuck", ended: EndedWrite) => Promise<Ended>
  /** A change ended and its record is written; whoever wants to hear it hears it here. */
  ended: (run: Run, entry: QueueEntry, kind: "merged" | "failed" | "stuck", endedRecord: string) => Promise<void>
  /** The same, for a commit that went around the queue: there is no change to end. */
  direct: (run: Run, commit: DirectMerge) => Promise<void>
}>

/** One ring of the onion: the same bundle, with the members it owns wrapped. */
export type Ring = (steps: Steps) => Steps

/** An authority read failed outside any one change's responsibility. */
export class QueueAuthorityUnreadable extends Error {
  constructor(authority: string, error: unknown) {
    super(`${authority} could not be read: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    this.name = "QueueAuthorityUnreadable"
  }
}

export async function queueRun(options: QueueRunOptions): Promise<QueueRunOutcome> {
  const git = options.git ?? gitIn(options.repo, options.process)
  const log = openLog(join(options.workdir, "logs"), undefined, options.render)
  // One reading of the remote yields both the queue and the commit the target
  // stood at when it was read, so the run never asks a second time and can
  // never judge against a target its own queue read did not see.
  const queue = await readQueue(git, options.target.remote, options.target.branch)
  const targetSha = queue.target
  let stopped: Stopped | undefined
  const run: Run = {
    git,
    log,
    name: queueName(options.target, await remoteUrl(git, options.target.remote)),
    options,
    queue: queue.changes,
    steps: composed(BASE),
    stop: (said) => {
      stopped = said
    },
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
  // The run row: the gitlink (the target's commit) and the config blob the checks
  // were read from. Each change CONSIDERED writes its own row with its decision
  // when the run has made one; a change that ended in an earlier run is history,
  // and this run claims nothing about it.
  log.write({
    base: targetSha,
    checks: options.checks.map((check) => check.name),
    config: options.configBlob,
    kind: "run",
    gitlink: targetSha,
    queue: run.name,
    target: options.target.branch,
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

  // Did something go around the queue? Read before any record is written, so a
  // direct that merged a submitted head is reported before the catch-up below
  // accounts for it (E5). Nothing stops for it: the run judges every change on
  // the base it read.
  const directMerges = await reportDirectMerges(run, entries)

  // A ring stops the round here. Reaping only cleans local scratch, and direct
  // reporting only observes work already done outside the queue. Everything
  // below writes a change record or tells somebody about one, so a stopped round
  // leaves every change exactly as it found it while still surfacing direct merges.
  stopped = await run.steps.open(run)
  if (stopped !== undefined) return finish(run, 0, { directMerges, failed, merged, stuck }, stopped)

  // Bookkeeping at the edges of the records first, so every reader below reads
  // records and never reconciles.
  for (const entry of entries) await run.steps.bookkeep(run, entry)

  // On-submit: every queued change, oldest first, in a fresh worktree of its
  // head. A stuck change kept its place, and this run takes it again from
  // here; so does a checked change whose checks ran under a check config the
  // target no longer declares (§ The queue run: a checked record is reused only
  // while the config blob is the one it names).
  for (const entry of ordered(entries, "queued", "stuck", "checked").filter(
    (entry) => entry.reading.state !== "checked" || staleChecked(run, entry),
  )) {
    const outcome = await guarded(run, entry, () => run.steps.judge(run, entry))
    if (outcome === "stuck") {
      stuck.push(entry.change.branch)
      return finish(run, 2, { directMerges, failed, merged, stuck })
    }
    if (outcome === "failed") failed.push(entry.change.branch)
  }

  // On-merge: the first checked change in line, re-read so this run's own
  // checked records count.
  const checked = ordered((await readQueue(git, options.target.remote, options.target.branch)).changes, "checked").find(
    (entry) => !staleChecked(run, entry),
  )
  if (checked !== undefined) {
    const outcome = await guarded(run, checked, () => run.steps.land(run, checked))
    if (outcome === "stuck") stuck.push(checked.change.branch)
    else if (outcome === "failed") failed.push(checked.change.branch)
    else if (outcome === "merged") merged.push(checked.change.branch)
  }

  return finish(run, stuck.length > 0 ? 2 : failed.length > 0 ? 1 : 0, { directMerges, failed, merged, stuck }, stopped)
}

/**
 * The queue with no rings on it: the bare loop's own steps, which rings.ts
 * wraps in order. Every one of them is reached through `Run.steps` and never by
 * name, so a ring that wraps one sees every call to it.
 */
const BASE: Steps = { bookkeep, direct, end, ended, judge, land, open, prepare, push }

/** A checked change whose checked record names a config blob the target no longer declares. */
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
 * its parents, its subject and the gitlinks it moved, and then whatever a ring
 * makes of it (E5). No record is written, because there is no change to write
 * one on; what the queue has already accounted for is read from git
 * (direct.ts), so a second run says nothing new once the queue has landed
 * on top. The run never stops for it: the queue adapts already, judging every
 * change on the base it read.
 */
async function reportDirectMerges(run: Run, entries: QueueRead): Promise<readonly string[]> {
  const found = await directMergeCommits(run.git, run.options.target.branch, run.targetSha, entries)
  const target = run.options.target.branch
  for (const commit of found) {
    run.log.write({
      branch: target,
      commit: commit.commit,
      gitlinks: commit.gitlinks,
      kind: "merged-direct",
      parents: commit.parents,
      subject: commit.subject,
      why: commit.why,
    })
    await run.steps.direct(run, commit)
  }
  return found.map((commit) => commit.commit)
}

/** Nothing stops the round: a queue with no ring on it runs every round it is given. */
function open(): Promise<Stopped | undefined> {
  return Promise.resolve(undefined)
}

/**
 * One pass over one entry before anything is judged: a branch that is gone or
 * moved off a head ends that head's change failed with the reason and no
 * message (ruling B3); a head the target already carries gets its merged
 * record, so the tip catches up with ancestry.
 */
async function bookkeep(run: Run, entry: QueueEntry): Promise<void> {
  await retire(run, entry)
  await catchUp(run, entry)
}

/**
 * A change ended and its record is written. The base does nothing more with
 * that: the record IS the ending, and a reader who asks the remote sees it
 * whether or not anybody was told. Telling somebody is a ring's.
 */
async function ended(): Promise<void> {}

/** The same, for a commit that went around the queue. */
async function direct(): Promise<void> {}

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
    if (error instanceof QueueAuthorityUnreadable) throw error
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").trim()
    // A setup that did not pass is the one crash with a name: the queue could
    // not build the ground a judgement stands on, which is never the
    // submitter's fault, so the reason says setup and not crash.
    if (error instanceof SetupFailed) {
      return run.steps.end(
        run,
        entry,
        "stuck",
        stuckWrite(run, {
          code: "yrd-setup-unusable",
          next: "repair the queue setup, then run yrd queue run",
          subject: `the queue could not prepare a worktree for ${entry.change.branch}: ${message}`,
          via: SETUP,
        }),
      )
    }
    return run.steps.end(
      run,
      entry,
      "stuck",
      stuckWrite(run, {
        code: "yrd-queue-crash",
        next: "repair the queue fault, then run yrd queue run",
        subject: `the queue crashed judging ${entry.change.branch}: ${message}`,
        via: "queue run",
      }),
    )
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
  phase: Phase,
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
    return run.steps.end(run, entry, "failed", {
      remedy: `rebase ${branch} onto ${run.options.target.branch} and submit again`,
      subject: `${branch} shares no history with ${run.options.target.branch}`,
      trailers: [["Reason", "unrelated-history"]],
    })
  }
  const composed = await composeCandidate(run, entry, "submit")
  if (composed.kind === "waiting") return waiting(run, entry, composed.detail)
  if (composed.kind === "failed") return candidateFailure(run, entry, composed.detail)
  const { worktree } = composed
  try {
    const results = await runPhase(run, entry, "submit", worktree.path, worktree.tree)
    const stuckOne = results.find((result) => result.result === "stuck")
    if (stuckOne !== undefined) {
      return await run.steps.end(
        run,
        entry,
        "stuck",
        stuckWrite(run, {
          code: "yrd-check-unresolved",
          next: `repair ${stuckOne.name} or its queue environment, then run yrd queue run`,
          subject: `the queue could not judge ${branch}: ${stuckOne.name} ${stuckOne.why ?? ""}`.trim(),
          trailers: checkTrailers(results),
          via: `${stuckOne.name} during submit`,
        }),
      )
    }
    const failing = results.filter((result) => result.result === "fail")
    if (failing.length > 0) {
      return await attributedFailure(run, entry, results, failing, "submit", composed.settled)
    }
    await writeRecord(run, {
      change,
      kind: "checked",
      subject: `${branch} passed the on-submit checks at ${run.options.target.branch} ${run.targetSha.slice(0, 12)}`,
      trailers: [["Config", run.options.configBlob], ["Base", run.targetSha], ...checkTrailers(results)],
    })
    return "checked"
  } finally {
    await worktree.remove()
  }
}

type SuperMergeDetail = Readonly<{
  code: string
  phase: string
  message: string
  subject?: string
  evidence?: string
  next?: string
  owner?: string
}>

type SettledGitlink = Readonly<{
  path: string
  from: string
  to: string
  state: "raised" | "left-off-main" | "not-run"
}>

type SuperMergeResult = Readonly<{
  state: "updated" | "unchanged" | "failed" | "unknown"
  partial: boolean
  commit?: string
  detail?: SuperMergeDetail
  gitlinks: readonly SettledGitlink[]
}>

type ComposedCandidate =
  | Readonly<{ kind: "ready"; mergeCommit: string; settled: readonly SettledGitlink[]; worktree: PreparedWorktree }>
  | Readonly<{ kind: "waiting"; detail: SuperMergeDetail }>
  | Readonly<{ kind: "failed"; detail: SuperMergeDetail }>

/** Compose and settle the exact tree a phase will judge, then materialize that final commit before setup or checks run. */
async function composeCandidate(run: Run, entry: QueueEntry, phase: CandidatePhase): Promise<ComposedCandidate> {
  const { head } = entry.change
  const composing = await freshWorktree(
    run.git,
    run.options.repo,
    run.targetSha,
    join(run.worktrees, "compose", phase, head.slice(0, 12)),
    run.options.plumbing,
  )
  let result: SuperMergeResult
  try {
    result = await superMerge(run, composing.path, head, mergeMessage(run, entry))
    if (result.state !== "updated" || result.partial) {
      const detail = result.detail
      if (detail === undefined) {
        throw new Error(`git-super merge of ${head} returned ${result.state} without a failure detail`)
      }
      return { detail, kind: detail.code === "gitlink-off-main" ? "waiting" : "failed" }
    }
    if (result.commit === undefined) throw new Error(`git-super merge of ${head} reported updated without a commit`)
  } finally {
    await composing.remove()
  }

  const mergeCommit = result.commit
  if (mergeCommit === undefined) throw new Error(`git-super merge of ${head} lost its commit after composition`)
  for (const settled of result.gitlinks.filter((row) => row.state !== "not-run")) {
    run.log.write({
      branch: entry.change.branch,
      from: settled.from,
      head,
      kind: "settle",
      path: settled.path,
      phase,
      state: settled.state,
      to: settled.to,
    })
  }
  const worktree = await run.steps.prepare(
    run,
    entry,
    mergeCommit,
    join(run.worktrees, phase, head.slice(0, 12)),
    phase,
  )
  return { kind: "ready", mergeCommit, settled: result.gitlinks, worktree }
}

/** Run git-super as the ruled command boundary; malformed or truncated JSON is never treated as a verdict. */
async function superMerge(run: Run, cwd: string, commit: string, message: string): Promise<SuperMergeResult> {
  const execution = await gitSuperExecution(run, cwd, ["merge", commit, "-m", message])
  let parsed: unknown
  try {
    parsed = JSON.parse(execution.stdout)
  } catch (error) {
    throw new Error(
      `git-super merge exited ${String(execution.exitCode)} without readable JSON: ${execution.stderr.trim() || execution.stdout.trim()}`,
      { cause: error },
    )
  }
  const result = readSuperMergeResult(parsed)
  if (execution.exitCode === 0 && result.state === "updated" && !result.partial) return result
  if ((execution.exitCode === 1 || execution.exitCode === 2) && result.detail !== undefined) return result
  throw new Error(
    `git-super merge exit/result disagreement: exit=${String(execution.exitCode)} state=${result.state} partial=${String(result.partial)}`,
  )
}

async function gitSuperExecution(
  run: Run,
  cwd: string,
  argv: readonly string[],
): Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>> {
  const owned = run.options.process === undefined
  const process =
    run.options.process ?? createProcess({ cwd, env: gitEnvironment(run.options.env ?? globalThis.process.env) })
  try {
    const execution = await process.run({
      argv: ["git-super", "--json", ...argv],
      cwd,
      env: gitEnvironment(run.options.env ?? globalThis.process.env),
    })
    if (
      execution.timedOut ||
      execution.stalled === true ||
      execution.signal !== null ||
      execution.sweepFailure !== undefined ||
      execution.escapedDescendant === true
    ) {
      throw new Error(
        `git-super ${argv[0] ?? "command"} did not settle normally: exit=${String(execution.exitCode)} signal=${execution.signal ?? "none"} timedOut=${String(execution.timedOut)} stalled=${String(execution.stalled === true)}${execution.sweepFailure === undefined ? "" : `; ${execution.sweepFailure}`}`,
      )
    }
    if (execution.outputTruncation !== undefined) {
      throw new Error(
        `git-super ${argv[0] ?? "command"} output was truncated: ${JSON.stringify(execution.outputTruncation)}`,
      )
    }
    return execution
  } finally {
    if (owned) await process.close()
  }
}

function readSuperMergeResult(value: unknown): SuperMergeResult {
  if (typeof value !== "object" || value === null) throw new Error("git-super merge JSON is not an object")
  const found = value as Record<string, unknown>
  if (!new Set(["updated", "unchanged", "failed", "unknown"]).has(String(found.state))) {
    throw new Error(`git-super merge JSON has invalid state ${String(found.state)}`)
  }
  if (typeof found.partial !== "boolean") throw new Error("git-super merge JSON has no boolean partial field")
  if (!Array.isArray(found.gitlinks)) throw new Error("git-super merge JSON has no gitlinks array")
  const gitlinks = found.gitlinks.map((row, index): SettledGitlink => {
    if (typeof row !== "object" || row === null) {
      throw new Error(`git-super merge gitlink ${String(index)} is not an object`)
    }
    const entry = row as Record<string, unknown>
    if (
      typeof entry.path !== "string" ||
      typeof entry.from !== "string" ||
      typeof entry.to !== "string" ||
      !new Set(["raised", "left-off-main", "not-run"]).has(String(entry.state))
    ) {
      throw new Error(`git-super merge gitlink ${String(index)} is incomplete`)
    }
    return entry as SettledGitlink
  })
  const detail = found.detail === undefined ? undefined : readSuperMergeDetail(found.detail)
  return {
    state: found.state as SuperMergeResult["state"],
    partial: found.partial,
    ...(typeof found.commit === "string" ? { commit: found.commit } : {}),
    ...(detail === undefined ? {} : { detail }),
    gitlinks,
  }
}

function readSuperMergeDetail(value: unknown): SuperMergeDetail {
  if (typeof value !== "object" || value === null) throw new Error("git-super merge detail is not an object")
  const detail = value as Record<string, unknown>
  if (typeof detail.code !== "string" || typeof detail.phase !== "string" || typeof detail.message !== "string") {
    throw new Error("git-super merge detail has no code, phase, or message")
  }
  return {
    code: detail.code,
    phase: detail.phase,
    message: detail.message,
    ...(typeof detail.subject === "string" ? { subject: detail.subject } : {}),
    ...(typeof detail.evidence === "string" ? { evidence: detail.evidence } : {}),
    ...(typeof detail.next === "string" ? { next: detail.next } : {}),
    ...(typeof detail.owner === "string" ? { owner: detail.owner } : {}),
  }
}

function mergeMessage(run: Run, entry: QueueEntry): string {
  const { branch, head } = entry.change
  const tip = tipOf(entry.change)
  const issue = trailer(tip, "Issue")
  const submitter = trailer(tip, "Submitter")
  return [
    `merge ${short(branch, head)} into ${run.options.target.branch}`,
    "",
    `Change: ${changeName(entry.change)}`,
    `Merged-By: ${mergedBy(run.options.target.branch, run.log.id)}`,
    ...(issue === undefined ? [] : [`Issue: ${issue}`]),
    ...(submitter === undefined ? [] : [`Submitter: ${submitter}`]),
  ].join("\n")
}

async function waiting(run: Run, entry: QueueEntry, detail: SuperMergeDetail): Promise<Ended> {
  const subject = (detail.subject ?? detail.message).replace(/\s+/gu, " ").trim()
  const incident = {
    code: detail.code,
    subject,
    via: `git-super merge in yrd queue ${run.name} [${run.log.id}]`,
    evidence: run.log.path,
    next: detail.next ?? "push the named component commit to its main, then run yrd queue run",
    owner: detail.owner ?? "the component writer",
  }
  const tip = tipOf(entry.change)
  const sameWait =
    trailer(tip, "Code") === incident.code &&
    trailer(tip, "Subject") === incident.subject &&
    trailer(tip, "Next") === incident.next &&
    trailer(tip, "Owner") === incident.owner
  if (!sameWait) {
    await writeRecord(run, {
      change: entry.change,
      kind: "opened",
      subject,
      trailers: incidentTrailers(incident),
    })
  }
  run.log.write({
    branch: entry.change.branch,
    decision: entry.reading.state === "checked" ? "checked" : "queued",
    head: entry.change.head,
    kind: "change",
    reason: detail.message,
  })
  return "waiting"
}

async function candidateFailure(run: Run, entry: QueueEntry, detail: SuperMergeDetail): Promise<Ended> {
  if (detail.code === "merge-conflict") {
    return run.steps.end(run, entry, "failed", {
      remedy: detail.next ?? `rebase ${entry.change.branch} onto ${run.options.target.branch} and submit again`,
      subject: detail.subject ?? `${entry.change.branch} conflicts with ${run.options.target.branch}`,
      trailers: [
        ["Reason", "conflict"],
        ["Detail", detail.message],
      ],
    })
  }
  if (detail.phase === "prove-gitlink-on-main") {
    const reason = detail.message.replace(/\s+/gu, " ").trim()
    return run.steps.end(run, entry, "failed", {
      remedy: detail.next ?? "publish a materializable component commit, then submit again",
      subject: (detail.subject ?? detail.message).replace(/\s+/gu, " ").trim(),
      trailers: [["Reason", reason]],
    })
  }
  return run.steps.end(
    run,
    entry,
    "stuck",
    stuckWrite(run, {
      code: detail.code,
      next: detail.next ?? "repair the queue fault, then run yrd queue run",
      owner: detail.owner,
      subject: detail.subject ?? detail.message,
      via: `git-super merge (${detail.phase})`,
    }),
  )
}

async function attributedFailure(
  run: Run,
  entry: QueueEntry,
  results: readonly CheckResult[],
  failing: readonly CheckResult[],
  phase: CandidatePhase,
  settled: readonly SettledGitlink[],
): Promise<Ended> {
  const raises = settled.filter((row) => row.state === "raised")
  if (raises.length === 0) return endFailing(run, entry, results, failing, phase)
  const base = await prepareSettledBase(run, entry, raises)
  try {
    const baseResults = await runPhase(run, entry, phase, base.path, base.tree, "base")
    const unresolved = baseResults.find((result) => result.result === "stuck")
    if (unresolved !== undefined) {
      return await run.steps.end(
        run,
        entry,
        "stuck",
        stuckWrite(run, {
          code: "yrd-check-unresolved",
          next: `repair ${unresolved.name} or its queue environment, then run yrd queue run`,
          subject:
            `the queue could not judge the settled base for ${entry.change.branch}: ${unresolved.name} ${unresolved.why ?? ""}`.trim(),
          trailers: checkTrailers(baseResults),
          via: `${unresolved.name} on the settled base alone`,
        }),
      )
    }
    const baseFailure = baseResults.find((result) => result.result === "fail")
    if (baseFailure === undefined) return await endFailing(run, entry, results, failing, phase)
    const pins = raises.map((row) => `${row.path}@${row.to}`).join(", ")
    return await run.steps.end(
      run,
      entry,
      "stuck",
      stuckWrite(run, {
        code: "yrd-submodule-main-regression",
        next: `fix or revert ${pins} on component main, then run yrd queue run`,
        owner: "the component writer",
        subject: `${pins} breaks the root at the settled base`,
        trailers: checkTrailers(baseResults),
        via: `the settled base alone failed ${baseFailure.name}; the candidate's own content was absent`,
      }),
    )
  } finally {
    await base.remove()
  }
}

/** Materialize the target with the candidate's exact raises on existing gitlinks, but none of its authored content. */
async function prepareSettledBase(
  run: Run,
  entry: QueueEntry,
  raises: readonly SettledGitlink[],
): Promise<PreparedWorktree> {
  const composing = await freshWorktree(
    run.git,
    run.options.repo,
    run.targetSha,
    join(run.worktrees, "compose", "base", entry.change.head.slice(0, 12)),
    run.options.plumbing,
  )
  let commit = run.targetSha
  try {
    const wt = gitIn(composing.path, run.options.process)
    for (const raise of raises) {
      const row = await wt(["ls-tree", "-z", run.targetSha, "--", raise.path])
      const target = /^160000 commit ([0-9a-f]{40,64})\t/u.exec(row)?.[1]
      if (target === undefined || target === raise.to) continue
      const component = gitIn(join(composing.path, raise.path), run.options.process)
      await component(["fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main"])
      await superGitlinkWrite(run, composing.path, raise.path, raise.to)
    }
    const tree = (await wt(["write-tree"])).trim()
    const targetTree = (await wt(["rev-parse", `${run.targetSha}^{tree}`])).trim()
    if (tree !== targetTree) {
      commit = (
        await wt(["commit-tree", tree, "-p", run.targetSha, "-m", `settle the base for ${entry.change.branch}`])
      ).trim()
      await run.git(["fetch", "--quiet", composing.path, commit])
    }
  } finally {
    await composing.remove()
  }
  return run.steps.prepare(run, entry, commit, join(run.worktrees, "base", entry.change.head.slice(0, 12)), "base")
}

async function superGitlinkWrite(run: Run, cwd: string, path: string, commit: string): Promise<void> {
  const execution = await gitSuperExecution(run, cwd, ["gitlink", "write", path, commit])
  let parsed: unknown
  try {
    parsed = JSON.parse(execution.stdout)
  } catch (error) {
    throw new Error(
      `git-super gitlink write exited ${String(execution.exitCode)} without readable JSON: ${execution.stderr.trim() || execution.stdout.trim()}`,
      { cause: error },
    )
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("git-super gitlink write JSON is not an object")
  const result = parsed as Record<string, unknown>
  if (
    execution.exitCode !== 0 ||
    (result.state !== "updated" && result.state !== "unchanged") ||
    result.partial !== false
  ) {
    throw new Error(
      `git-super gitlink write failed for ${path}@${commit}: ${typeof (result.detail as Record<string, unknown> | undefined)?.message === "string" ? String((result.detail as Record<string, unknown>).message) : execution.stderr.trim()}`,
    )
  }
}

/** The on-merge phase for the first checked change. */
async function land(run: Run, entry: QueueEntry): Promise<Ended> {
  const { change } = entry
  const { branch, head } = change
  const name = changeName(change)
  const composed = await composeCandidate(run, entry, "merge")
  if (composed.kind === "waiting") return waiting(run, entry, composed.detail)
  if (composed.kind === "failed") return candidateFailure(run, entry, composed.detail)
  const { mergeCommit, settled, worktree } = composed
  try {
    const wt = gitIn(worktree.path, run.options.process)
    // The built-in check at merge (ruling D2): the merged tree's own declaration
    // reads, so no change can land a `.yrd.yml` that breaks the next queue run.
    let unreadable: string | undefined
    try {
      if ((await readConfig(wt, "HEAD", run.options.target)) === undefined) {
        unreadable = "the merged tree has no .yrd.yml"
      }
    } catch (error) {
      unreadable = String(error instanceof Error ? error.message : error)
    }
    if (unreadable !== undefined) {
      return await run.steps.end(run, entry, "failed", {
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
      return await run.steps.end(
        run,
        entry,
        "stuck",
        stuckWrite(run, {
          code: "yrd-check-unresolved",
          next: `repair ${stuckOne.name} or its queue environment, then run yrd queue run`,
          subject: `the queue could not judge ${branch} at merge: ${stuckOne.name} ${stuckOne.why ?? ""}`.trim(),
          trailers: checkTrailers(results),
          via: `${stuckOne.name} during merge`,
        }),
      )
    }
    const failing = results.filter((result) => result.result === "fail")
    if (failing.length > 0) {
      return await attributedFailure(run, entry, results, failing, "merge", settled)
    }
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
    // The merged record says how it was merged and what it checked: by the queue,
    // with the on-merge checks' results, in the shape the checked record uses.
    const mergedRecord = await appendRecord(run.git, run.options.target.branch, {
      change,
      kind: "merged",
      subject: `${branch} merged into ${run.options.target.branch} as ${mergeCommit.slice(0, 12)}`,
      trailers: [
        ["Merge", mergeCommit],
        ["Base", run.targetSha],
        ["Merged-By", mergedBy(run.options.target.branch, run.log.id)],
        ...checkTrailers(results),
      ],
    })
    const ref = changeRef(run.options.target.branch, change)
    const pushed = await run.steps.push(run, entry, {
      leases: [[`refs/heads/${run.options.target.branch}`, run.targetSha]],
      updates: [
        [mergeCommit, `refs/heads/${run.options.target.branch}`],
        [mergedRecord, ref],
      ],
    })
    if (!pushed.landed) {
      // Something can win after our reads, and then the atomic leases reject
      // every update. A push that read what moved says so and the change simply
      // keeps its place; one that could read nothing raises, because a queue
      // that cannot explain a refused merge has not judged anything.
      if (pushed.reason === undefined) throw pushed.error
      run.log.write({
        branch,
        decision: "checked",
        head,
        kind: "change",
        reason: pushed.reason,
        ...(pushed.saw === undefined ? {} : { saw: pushed.saw }),
      })
      return "checked"
    }
    run.log.write({
      branch,
      change: name,
      commit: mergeCommit,
      gitlinks: settled.filter((row) => row.state === "raised").map((row) => `${row.path} ${row.from} -> ${row.to}`),
      head,
      kind: "merge",
      tip: mergeCommit,
    })
    run.log.write({ branch, decision: "merged", head, kind: "change" })
    await run.steps.ended(run, entry, "merged", mergedRecord)
    return "merged"
  } finally {
    await worktree.remove()
  }
}

/**
 * The one atomic push a merge makes: every ref in the plan moves or none does,
 * and every lease proves nobody moved that ref between this run's reads and
 * this moment.
 *
 * A rejection is not an error until somebody has looked. The target or the
 * branch may have moved under us, and then the change simply keeps its place and
 * is judged again next run. What the pusher cannot read as a race it hands back
 * with the rejection, for a caller that knows more to explain or raise.
 */
async function push(run: Run, entry: QueueEntry, plan: PushPlan): Promise<Pushed> {
  try {
    await run.git([
      "push",
      "--quiet",
      "--atomic",
      ...plan.leases.map(([ref, expected]) => `--force-with-lease=${ref}:${expected}`),
      run.options.target.remote,
      ...plan.updates.map(([object, ref]) => `${object}:${ref}`),
    ])
    return { landed: true }
  } catch (error) {
    const moved = await remoteHeads(run, entry.change.branch)
    if (moved.target !== run.targetSha) {
      return { error, landed: false, reason: "target-moved", saw: moved.target ?? "gone" }
    }
    if (moved.branch !== entry.change.head) return { error, landed: false, reason: "branch-moved" }
    return { error, landed: false }
  }
}

/**
 * A failing check with no settlement to attribute ends the change failed, the
 * submitter's, at once, with the check, its exit, its duration and its log
 * path. When candidate preparation raised a gitlink, attributedFailure first
 * runs the same declared plan once on the settled base alone: red there is the
 * component writer's stuck; green leaves this submitter ending unchanged.
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
  phase: Phase,
): Promise<Ended> {
  const first = failing[0]
  return run.steps.end(run, entry, "failed", {
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
  const retiredRecord = await writeRecord(run, {
    change,
    kind: "failed",
    subject:
      reason === "deleted"
        ? `${branch} was deleted by its submitter`
        : `${branch} moved off ${head.slice(0, 12)}; its submitter replaced it`,
    trailers: [["Reason", reason]],
  })
  if (retiredRecord === undefined) return
  run.log.write({ branch, decision: "failed", head, kind: "change", reason })
}

/**
 * A head the target already carries with no merged record yet — merged around the
 * queue in the garage, or by a run that crashed after its push — gets its
 * merged record now, naming the commit that landed it and saying so, and
 * its submitter is told (§ The change: ancestry wins, and the next queue run
 * appends the merged record so the tip catches up). A retired change is left as
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
  const mergedRecord = await writeRecord(run, {
    change,
    kind: "merged",
    subject: `merged around the queue at ${merge.slice(0, 12)}`,
    trailers: [
      ["Merge", merge],
      ["Base", base],
      ["Merged-By", DIRECT_MERGE],
    ],
  })
  if (mergedRecord === undefined) return
  run.log.write({ branch, decision: "merged", head, kind: "change", reason: "already on the target" })
  await run.steps.ended(run, entry, "merged", mergedRecord)
}

/** A change as a person reads it: the branch and twelve characters of the head, the trailer's spelling shortened. */
export function short(branch: string, head: string): string {
  return `${branch}@${head.slice(0, 12)}`
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
function checkLogDir(run: Run, entry: QueueEntry, phase: Phase): string {
  return join(run.options.workdir, "checks", changeName(entry.change), run.log.id, phase)
}

async function runPhase(
  run: Run,
  entry: QueueEntry,
  declaredPhase: CandidatePhase,
  cwd: string,
  tree: CheckedTree,
  phase: Phase = declaredPhase,
): Promise<readonly CheckResult[]> {
  const results: CheckResult[] = []
  for (const spec of run.options.checks.filter((candidate) => (candidate.on ?? ["merge"]).includes(declaredPhase))) {
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
  phase: Phase,
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

async function end(run: Run, entry: QueueEntry, kind: "failed" | "stuck", ended: EndedWrite): Promise<Ended> {
  // Who is billed follows from the kind, once: a fail is the submitter's, and
  // says so; a stuck is always the queue's, so its record says nothing about
  // fault (a constant trailer says nothing). A `replaced` or `deleted` change
  // bills nobody and never comes through here.
  const trailers = [
    ...ended.trailers,
    ...(kind === "failed" ? [["Fault", "submitter"] as const] : []),
    ...(ended.remedy === undefined ? [] : [["Remedy", ended.remedy] as const]),
  ]
  const record = await writeRecord(run, {
    change: entry.change,
    kind,
    subject: ended.subject,
    trailers,
  })
  run.log.write({
    branch: entry.change.branch,
    decision: kind,
    head: entry.change.head,
    kind: "change",
    reason: ended.subject,
  })
  // No record, no message: the message's id IS that record's sha, and the next
  // run's reading of the remote is what repairs the ending (24096).
  if (record !== undefined) await run.steps.ended(run, entry, kind, record)
  return kind
}

/** One constructor for every complete queue-owned incident written to a change ref. */
function stuckWrite(
  run: Run,
  cause: Readonly<{
    code: string
    subject: string
    via: string
    next: string
    owner?: string
    trailers?: readonly (readonly [string, string])[]
  }>,
): EndedWrite {
  const subject = cause.subject.replace(/\s+/gu, " ").trim()
  return {
    subject,
    trailers: [
      ...incidentTrailers({
        code: cause.code,
        subject,
        via: `${cause.via} in yrd queue ${run.name} [${run.log.id}]`,
        evidence: run.log.path,
        next: cause.next,
        owner: cause.owner ?? "the queue operator",
      }),
      ...(cause.trailers ?? []),
    ],
  }
}

function checkTrailers(results: readonly CheckResult[]): readonly (readonly [string, string])[] {
  return results.map((result) => ["Check", checkTrailer(result)] as const)
}

/**
 * The one writer of a record: the commit object appended onto the tip the run
 * read the change at, pushed under a lease for that same tip.
 *
 * There is nothing to align and no local ref to lose. The remote is the store,
 * `--force-with-lease` is what proves nobody else moved the ref between the
 * reading and the push, and the object being immutable is what makes a retry
 * cheap: on a refusal the run takes the winner's tip, writes the same record onto
 * it, and pushes once more. A second refusal is written down and left for the
 * next run's catch-up to repair, because a queue that spins on a contended ref
 * is a queue that is not judging anything (24096).
 */
export async function writeRecord(run: Run, write: WriteRecord): Promise<string | undefined> {
  const ref = changeRef(run.options.target.branch, write.change)
  let onto = await refAt(run.git, ref)
  if (onto === undefined) {
    throw new Error(`${ref} is not here; the queue read fetched every change ref the remote listed`)
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const record = await recordCommit(run.git, write, onto)
    try {
      await run.git([
        "push",
        "--quiet",
        `--force-with-lease=${ref}:${onto}`,
        run.options.target.remote,
        `${record}:${ref}`,
      ])
      // The local ref follows what the remote has just accepted, so a second
      // record written for this change in the same run — an ending and then its
      // sent record — starts from the tip that is really there.
      await run.git(["update-ref", ref, record])
      return record
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
  lists: Readonly<{ merged: string[]; failed: string[]; stuck: string[]; directMerges: readonly string[] }>,
  stopped?: Stopped,
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
    ...(stopped === undefined ? {} : { stopped }),
    log: run.log.path,
    run: run.log.id,
    target: targetNow,
    ...lists,
  }
}
