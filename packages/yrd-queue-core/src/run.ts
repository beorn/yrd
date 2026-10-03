/** One event queue run with a journaled preamble. */
import { mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { Process } from "@yrd/process"
import { validateScripts } from "./program-root.ts"
import type { CheckSpec } from "./check.ts"
import type { Notifier, Target } from "./config.ts"
import {
  createEventStore,
  gitIn,
  resolveGitSelection,
  type Git,
  type GitInvocationOptions,
  type GitObservation,
  type GitSelection,
} from "./git.ts"
import { queueFormat, queueRef } from "./events.ts"
import { eventQueueRun } from "./event-run.ts"
import { removeEmptyWorktreeRunDirectory } from "./worktree.ts"
import { openLog, type LogRecord, type QueueRunLog } from "./log.ts"
import { overrideLine, type OverrideEntry, type OverrideTable } from "./override.ts"
import { roundRemoteCallsRow, traceRemoteCalls } from "./remote-calls.ts"
import { remoteUrl } from "./remote.ts"
import type { Change } from "./refs.ts"
import type { PlumbingLog } from "./worktree.ts"
export { readSuperMergeResult } from "./verifying.ts"

export type QueueRunOptions = Readonly<{
  /** The declaration resolved once by the command/service entry. */
  selection?: GitSelection
  /** The working repository the run reads and writes through. */
  repo: string
  /**
   * Whether `repo` is the queue's OWN clone, and may be given the submodule
   * stores every compose borrows from. Only `resolveQueueLocation` knows, so
   * only it may say; a run against a seat's checkout leaves that tree alone.
   */
  populateReference?: boolean
  /** The branch the queue merges on, at the remote holding it: `<remote>#<branch>`. */
  target: Target
  /** The target commit whose declaration supplied this round's config and checks. */
  targetSha: string
  /**
   * The one change this round works, and no other: `yrd merge`. It is judged
   * and merged wherever it stands in line, so a stuck change ahead of it does
   * not cut its line; the line this round works holds only the change named.
   */
  only?: Change
  /** The checks the target declares, read from the target commit by the caller. A check with no `on` runs at merge. */
  checks: readonly CheckSpec[]
  /** The target's `setup:`: one shell command run in every worktree this run makes, before any check runs in it. */
  setup?: string
  /** The target's `derive:`: run once in each composed merge before it is verified (derive.ts). */
  derive?: string
  /** The target's retained-environment teardown; event queues refuse it until #25065 defines its event evidence. */
  teardown?: string
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
  /** Which check tier to run: normal (default) or long. */
  tier?: "normal" | "long"
  /** Stop starting new checks after this epoch timestamp in ms (Condition 5). */
  stopAtMs?: number
  /** No-progress event-chain CAS budget. Defaults to 5,000ms in a queue run instead of Gitomic's 30,000ms: five seconds without a landed writer is a retryable round, not a healthy burst. */
  retryBudgetMs?: number
  /** Service round interval plus 60 seconds; defaults to 75 seconds for one-shot runs. */
  branchDeletionGraceMs?: number
  /** Injected clock for testing stop windows; defaults to Date.now. */
  now?: () => number
  /**
   * The override table this round is judged under (25296): expired, then read,
   * by the CALLER before the run starts, so the header carries it without a Git
   * call ahead of it. The service always passes it; absent is a caller that
   * read no override ref, which holds no check off and fences nothing.
   */
  overrides?: OverrideTable
  /** The entries whose `expired` record the caller wrote for this round; journaled after the header, and notified. */
  overridesExpired?: readonly OverrideEntry[]
  /** The entries whose half-window reminder the caller recorded for this round; notified once (25296). */
  overridesReminded?: readonly OverrideEntry[]
  /** Skip every check declared in .yrd.yml and merge with git machinery only: `yrd merge --no-check`. */
  noCheck?: boolean
  /** Recipients for event ending and direct-merge notices. */
  notify?: readonly Notifier[]
  /** An explicit foreground round may work under the observed operator pause. */
  foreground?: boolean
}>

/** What a round read of its line, for the service's stall judgement (25669). */
export type RoundLine = Readonly<{
  waiting: number
  oldest?: Readonly<{ branch: string; openedAt: string }>
  lastJudgedAt?: string
  /** A repeatedly refused publication, from this round's durable journal. */
  casRefused?: Readonly<{ branch: string; ref: string; marker: string; count: number }>
}>

export type QueueRunOutcome = Readonly<{
  observation: GitObservation
  exitCode: 0 | 1 | 2
  log: string
  run: string
  /** The target's commit every judgement was made against, and the config blob the checks came from. */
  base: string
  config: string
  /** The target after the run. */
  target: string
  /** What a ring stopped this round for, before any merge could be made, when one did. */
  stopped?: Readonly<{ ring: string; says: string; what: unknown }>
  merged: readonly string[]
  /** What became of each merged change's task branch on origin, deleted or kept and why (25568). */
  branches?: readonly string[]
  failed: readonly string[]
  stuck: readonly string[]
  /** Stuck changes still holding while an operator pause stopped this round; no new judgement occurred. */
  pendingStuck?: readonly string[]
  deferred: readonly string[]
  /** The commits on the target's first-parent line that the queue did not put there, reported this run (E5). */
  directMerges: readonly string[]
  /**
   * Checked changes still in line that this run did not act on: it merges the
   * FIRST checked change and no more (ruling D4), so a line of five leaves
   * four here. A service reads it to know it has work ready NOW rather than
   * spending its idle cadence between two ready merges. Zero when the run
   * ended before it could read the line.
   */
  checkedWaiting: number
  /**
   * The line as this round read it (25669): how many changes wait, the oldest of
   * them by opening, and when the queue last judged a change (the latest merged
   * or failed ending on any chain, read from the chains so a relaunched service
   * knows it too). The service loop judges a stall from it. Absent when the round
   * ended before it read the line (a paused line), and on the legacy format.
   */
  line?: RoundLine
  /** Present and true when this round ran with --no-check. */
  noCheck?: boolean
}>

/** True when every declared check is off (--no-check, or all checks declared run "true") (25716 row 5). When no checks are declared, returns false so any declared setup can still run. */
export function allDeclaredChecksOff(options: QueueRunOptions): boolean {
  if (options.noCheck === true) return true
  if (options.checks.length === 0) return false
  return options.checks.every((check) => check.run === "true")
}

/** An authority read failed outside any one change's responsibility. */
export class QueueAuthorityUnreadable extends Error {
  constructor(
    readonly authority: string,
    readonly readError: unknown,
    readonly publicationError?: unknown,
  ) {
    const cause =
      publicationError === undefined
        ? readError
        : new AggregateError([publicationError, readError], `${authority}: publication and remote reread both failed`)
    super(`${authority} could not be read: ${readError instanceof Error ? readError.message : String(readError)}`, {
      cause,
    })
    this.name = "QueueAuthorityUnreadable"
  }
}

function gitInvocationOptions(options: QueueRunOptions, log: QueueRunLog): GitInvocationOptions {
  return {
    ...(options.env === undefined ? {} : { env: options.env }),
    openOutput: log.openGitOutput,
    onInvocation: log.writeGitInvocation,
  }
}

function nowMs(options: QueueRunOptions): number {
  return options.now !== undefined ? options.now() : Date.now()
}

export async function queueRun(options: QueueRunOptions): Promise<QueueRunOutcome> {
  await using resources = new AsyncDisposableStack()
  const log = openLog(join(options.workdir, "logs"), undefined, options.render)
  const runWorktrees = join(options.workdir, "worktrees", log.id)
  resources.defer(() => {
    // The queue owns this scaffold; settledBaseCommit also serves callers
    // whose worktree path has unrelated parent directories.
    removeEmptyWorktreeRunDirectory(join(runWorktrees, "compose", "base"))
    removeEmptyWorktreeRunDirectory(join(runWorktrees, "compose"))
    removeEmptyWorktreeRunDirectory(runWorktrees)
  })
  // THE JOURNAL OPENS WITH ITS HEADER, before the first journaled Git call and
  // before anything here can throw. Every field below is known from the run's
  // options, so there is nothing to wait for: the run row carries the gitlink
  // (the target's commit) and the config blob the checks were read from. Each
  // change CONSIDERED writes its own row with its decision when the run has
  // made one; a change that ended in an earlier run is history, and this run
  // claims nothing about it.
  //
  // The header used to be written after the Git preamble because it carried
  // `queue`, which is computable only once the remote URL is read — so every
  // run that threw in that preamble left a journal with no header at all, and
  // both readers called that a malformed journal rather than a run that died
  // early (@i/10-yrd/24470). The queue name is now its own record below, which
  // also marks the preamble complete, and a headerless journal is structurally
  // impossible.
  // `pid` is here because the run's OTHER pid, the one `claimWorktrees` writes,
  // does not exist yet and will not until line ~476 — after the whole Git
  // preamble. A reader asking "did this run die in its preamble, or is it
  // executing one right now?" has nothing else to ask during exactly the window
  // the question matters in, and answering it from the absence of a worktree
  // would call a healthy run three seconds old a dead one.
  log.write({
    base: options.targetSha,
    checks: options.checks.map((check) => check.name),
    effectiveChecks:
      options.noCheck === true
        ? options.checks.map(() => "off")
        : options.checks.map((check) => (check.run === "true" ? "off" : check.name)),
    config: options.configBlob,
    kind: "run",
    gitlink: options.targetSha,
    ...(options.noCheck === true ? { noCheck: true } : {}),
    // Every override entry this round reads, active or expired, one line each
    // (25296 C5): the journal says a check was off before any change says so.
    overrides: (options.overrides?.entries ?? []).map((entry) => overrideLine(entry, nowMs(options))),
    pid: process.pid,
    target: options.target.branch,
  })
  // THE ROUND'S REMOTE CALLS (25570 row 3). Every git process the round starts, yrd's own, Gitomic's and
  // git-super's children, writes git's trace2 event log under the run's own directory, and one `remote-calls`
  // row counts them when the round ends, however it ends. Set in both environments a round's Git reads from; a
  // check's environment is built, never inherited, so a check's own git is not counted here.
  const traced = traceRemoteCalls(join(options.workdir, "logs", log.id, "trace2"), { refresh: true })
  if (options.env !== undefined) options = { ...options, env: { ...options.env, ...traced.env } }
  resources.defer(() => {
    try {
      log.write({ kind: "remote-calls", ...roundRemoteCallsRow(traced.end()) })
    } catch (error) {
      // The count is evidence about the round, never its outcome: an unreadable trace is a named warning row.
      log.write({
        kind: "warning",
        subject: "remote-calls",
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  })
  const gitOptions = gitInvocationOptions(options, log)
  const selection =
    options.selection ?? (await resolveGitSelection(options.repo, { process: options.process, env: options.env }))
  options = { ...options, selection }
  const selected = gitIn(options.repo, options.process, selection, gitOptions)
  const git = options.git ?? selected
  const hooksPath = join(options.workdir, "hooks-disabled")
  mkdirSync(hooksPath, { recursive: true })
  const hooks = readdirSync(hooksPath).sort()
  if (hooks.length > 0) {
    throw new Error(
      `queue-owned hooks path ${hooksPath} is not empty (${hooks.join(", ")}); remove the named entries, then run yrd queue run`,
    )
  }
  const url = await remoteUrl(git, options.target.remote)
  const store = createEventStore(options.repo, options.target.remote, selection)
  if ((await queueFormat(store, options.target.branch)) !== "event") {
    throw new Error(
      `${url}#${options.target.branch} in ${options.repo}: expected event queue ref ${queueRef(options.target.branch)}; legacy queue authority is retired`,
    )
  }
  return await eventQueueRun(options, { git, gitOptions, hooksPath, log, selected, url })
}
/**
 * Time one step of the round that is neither a check nor a program, so the
 * journal never goes silent across it (@i/10-yrd/25303 box 1): a `step` row as
 * it starts, and one with `end` and `ms` as it ends, `threw` when it threw. A
 * compose is one git-super process whose settle rows are written only after it
 * returns; without these rows it was a 20 to 28 s silence on the garage.
 */
export async function timedStep<T>(
  log: Pick<QueueRunLog, "write">,
  about: Readonly<
    { name: string; phase: string } & ({ branch: string; head: string } | { target: string; base: string })
  >,
  work: () => Promise<T>,
): Promise<T> {
  const start = new Date().toISOString()
  const began = performance.now()
  log.write({ ...about, kind: "step", start })
  const ended = (threw: boolean) =>
    log.write({
      ...about,
      end: new Date().toISOString(),
      kind: "step",
      ms: Math.round(performance.now() - began),
      start,
      ...(threw ? { threw: true } : {}),
    })
  try {
    const result = await work()
    ended(false)
    return result
  } catch (error) {
    ended(true)
    throw error
  }
}

/** A change as a person reads it: the branch and twelve characters of the head, the trailer's spelling shortened. */
export function short(branch: string, head: string): string {
  return `${branch}@${head.slice(0, 12)}`
}

/**
 * A check's scripts come from the target, never from the branch (§ The queue
 * run: check authority lives on the protected side). The check declares them as
 * `scripts:`, files or directories of the repository; each is restored from
 * the base commit into the worktree before the check runs, so a change that
 * rewrites the check it is judged by is judged by the target's version all the
 * same. The merge commit, already made, keeps the branch's edit: it merges, and
 * judges the next change. A declared path the base does not carry is loud,
 * because a check that silently ran the branch's copy would be the hole itself.
 */
export async function restoreScripts(
  run: Readonly<{
    git: Git
    targetSha: string
    process?: Process
    selection?: GitSelection
    gitOptions?: GitInvocationOptions
  }>,
  spec: CheckSpec,
  cwd: string,
): Promise<void> {
  await validateScripts(run, spec)
  const scripts = spec.scripts ?? []
  if (scripts.length === 0) return
  const selection =
    run.selection ?? (await resolveGitSelection(cwd, { process: run.process, env: run.gitOptions?.env }))
  const wt = gitIn(cwd, run.process, selection, run.gitOptions)
  for (const path of scripts) {
    await wt(["checkout", "--quiet", run.targetSha, "--", path])
  }
}
