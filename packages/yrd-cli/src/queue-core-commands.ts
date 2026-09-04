/**
 * The queue commands ([plan](../../../../pm/@i/10-yrd/plan.md) § The final
 * design, Commands).
 *
 * A queue is a branch whose commit carries a `.yrd.yml` the parser can read.
 * That is the whole of the question "is there a queue here": the file at HEAD
 * says where to look (`target: <remote>#<branch>`, optional), and the file at
 * the TARGET is the declaration that judges.
 *
 * `remote:` used to be the switch — its presence chose this core over the
 * incumbent at flag day (§ Cutover) — and that made an optional key mandatory
 * in practice, with a refusal that told a repository declaring nothing else to
 * add a line it does not need. The incumbent went at M6; the switch goes here.
 */

import { mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ConditionalLogger } from "loggily"
import {
  directMergeCommits,
  activePause,
  changeName,
  checksOf,
  claimWorktrees,
  directMergeLine,
  pauseLine,
  prepareWorktree,
  gitIn,
  hintsIn,
  list,
  queueName,
  queueRun,
  readConfig,
  readJournals,
  readQueue,
  runId,
  subjects,
  targetName,
  refAt,
  resolveRemote,
  runCheck,
  show,
  refuseTarget,
  submit,
  issueOf,
  QueuePaused,
  QueueNotPaused,
  requireResumed,
  writePause,
  type CheckResult,
  type CheckSpec,
  type CheckView,
  type Journals,
  type Git,
  type LogRecord,
  type QueueConfig,
  type QueueRunOutcome,
  type Row,
} from "@yrd/queue-core"
import { declarationHere } from "./declaration.ts"
import { clocksLine, noticeLine, duration } from "./watch-notice.ts"
import { filterRows, rowLine, rowTable, watchRows, type WatchRow } from "./watch-rows.ts"
import { readGarageDeclaration } from "./garage.ts"
import type { YrdCliExitCode, YrdCliIO } from "./types.ts"
import { workdirOf } from "./workdir.ts"

export type CoreQueueCommand =
  | Readonly<{ command: "submit"; branch?: string; submitter: string; issue?: string; dryRun?: boolean }>
  | Readonly<{ command: "pause"; by: string; reason: string }>
  | Readonly<{ command: "resume"; by: string; reason?: string }>
  | Readonly<{ command: "run" }>
  | Readonly<{
      command: "up"
      intervalSeconds?: number
      stop?: AbortSignal
      /**
       * The gitlink: the gitlink at the target that carries the commit this yrd
       * runs from. Absent, both are found from this module's own checkout at
       * start; a test names them to move a gitlink without running from one.
       */
      gitlink?: Readonly<{ path: string; sha: string }>
      /** Awaited after each round, before the gitlink is read; a test mutates the world or stops the service here. */
      afterRound?: (outcome: QueueRunOutcome) => void | Promise<void>
    }>
  | Readonly<{
      command: "list"
      /** Case-insensitive OR terms over the branch, the subject, the run and the failure (S2.12). */
      terms?: readonly string[]
      /** One row per change instead of one per run (S2.13). */
      latest?: boolean
      /** Refresh until an ending, or until stopped: `yrd queue list --watch`, and `yrd watch` (README 1069). */
      watch?: boolean
      /** Seconds between refreshes while watching; the default is 5. */
      intervalSeconds?: number
      /** Stops the watch; a test ends the loop with it, a terminal ends it with a signal. */
      stop?: AbortSignal
    }>
  | Readonly<{ command: "show"; branch: string }>
  | Readonly<{ command: "check"; names: readonly string[] }>

/** What each command is called when it has to say it needs a queue. */
const NAMED: Readonly<Record<CoreQueueCommand["command"], string>> = {
  check: "check",
  pause: "queue pause",
  list: "queue list",
  run: "queue run",
  show: "queue show",
  submit: "submit",
  resume: "queue resume",
  up: "queue up",
}

/**
 * Run one queue command on the new core.
 *
 * A repository whose declaration does not select this core is refused HERE,
 * with the one line that cures it. Until M6 this answered `undefined` and every
 * one of the six call sites in cli.ts carried its own `?? notSelected(...)` —
 * six chances to forget, for a fallthrough to an incumbent that no longer
 * exists.
 */
export async function coreQueueCommand(
  repo: string,
  io: YrdCliIO,
  request: CoreQueueCommand,
  options: Readonly<{ json?: boolean; env?: NodeJS.ProcessEnv; workdir?: string; log?: ConditionalLogger }> = {},
): Promise<YrdCliExitCode> {
  /** No `.yrd.yml` where the command stands: nothing here says which queue this repository belongs to. */
  const noDeclarationHere = (): YrdCliExitCode => {
    io.stderr(
      `yrd: ${NAMED[request.command]} needs a queue, and there is no .yrd.yml at ${repo} or in any directory ` +
        "above it within this repository. A queue is a branch whose commit carries one.\n",
    )
    return 2
  }
  /** The target carries no declaration: whatever stands here, that branch runs no queue. */
  const noQueueOnTarget = (ref: string): YrdCliExitCode => {
    io.stderr(
      `yrd: ${NAMED[request.command]} needs a queue, and ${ref} carries no .yrd.yml. ` +
        "The declaration that judges lives on the branch the queue lands on; one that stands only here judges nothing.\n",
    )
    return 2
  }
  // Where to look, from the declaration checked out where the command stands:
  // `target: <remote>#<branch>`, optional, a hint. A file that does not
  // parse hints NOTHING and says so on stderr, once: the defaults stand,
  // because this file is a hint and the target's is the authority — a branch
  // that breaks its own `.yrd.yml` still submits, and D2 bills it at merge
  // (config.ts). What it may not do is go quiet.
  const here = declarationHere(repo)
  if (here === undefined) return noDeclarationHere()
  const hints = hintsIn(here.text, join(here.root, ".yrd.yml"))
  if (hints.problem !== undefined) {
    io.stderr(
      `yrd: ${hints.problem}; it hints nothing, so this asks origin/main, which must carry the declaration itself\n`,
    )
  }
  const git = gitIn(here.root)
  const log = options.log?.child("queue")
  // The declaration here only hints where the queue is (`target:`); the
  // declaration AT that target is the authority for every judgement. A branch
  // that rewrote or broke its own `.yrd.yml` is judged by the target's rules
  // all the same (ruling D2 bills it at merge).
  const hinted = await resolveRemote(git, hints.target?.remote ?? "origin")
  const hintedTarget = hints.target?.branch ?? "main"
  const targetRef = `${hinted}/${hintedTarget}`
  // The target's declaration as the target holds it now: fetched, read in full
  // and held to its keys, then the remote it names resolved. Undefined when the
  // target carries no `.yrd.yml` at all — there is no queue there; a
  // declaration that exists and cannot be read throws. One reading serves a
  // one-shot command; the service reads again before every round, so an edit at
  // the target takes effect on the next round.
  const declaration = async (): Promise<QueueConfig | undefined> => {
    await git(["fetch", "--quiet", hinted, `+refs/heads/${hintedTarget}:refs/remotes/${targetRef}`])
    const declared = await readConfig(git, targetRef)
    if (declared === undefined) return undefined
    // The declared remote may be a URL; `resolveRemote` turns it into the name
    // this repository knows it by, adding `yrd` when it has none.
    return { ...declared, target: { ...declared.target, remote: await resolveRemote(git, declared.target.remote) } }
  }
  const config = await declaration()
  if (config === undefined) return noQueueOnTarget(targetRef)
  const workdir = options.workdir ?? (await workdirOf(git))
  mkdirSync(workdir, { recursive: true })

  /** The one shape a command that could not judge answers with (plan § The queue run). */
  const stuck = (why: string): YrdCliExitCode => {
    emit(io, options.json, { exitCode: 2, failed: [], merged: [], stuck: [], why }, `stuck: ${why}`)
    return 2
  }
  /**
   * One queue run, emitted. Undefined is the one exit site from the caller's
   * side: a run that could not even judge — a bad invocation, a remote that
   * cannot be read — is stuck, and has already said so.
   */
  const oneRound = async (declared: QueueConfig): Promise<QueueRunOutcome | undefined> => {
    let outcome: QueueRunOutcome
    try {
      outcome = await queueRun(runOptions(repo, declared, workdir, options.env, options.log))
    } catch (error) {
      stuck(`the queue run could not judge: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
    emit(io, options.json, outcome, describeRun(outcome))
    return outcome
  }

  switch (request.command) {
    case "pause":
    case "resume": {
      try {
        const pause = await writePause(git, config.target.remote, {
          by: request.by,
          kind: request.command === "pause" ? "paused" : "resumed",
          reason: request.command === "pause" ? request.reason : (request.reason ?? "pause lifted"),
        })
        emit(io, options.json, pause, pauseLine(pause))
        return 0
      } catch (error) {
        if (error instanceof QueuePaused || error instanceof QueueNotPaused) {
          io.stderr(`yrd: ${error.message}\n`)
          return 1
        }
        throw error
      }
    }
    case "submit": {
      const branch = request.branch ?? (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim()
      // The preview refuses exactly what the action refuses, first.
      refuseTarget(branch, config.target.branch)
      if (request.dryRun === true) {
        try {
          await requireResumed(git, config.target.remote)
        } catch (error) {
          if (error instanceof QueuePaused) {
            io.stderr(`yrd: ${error.message}\n`)
            return 1
          }
          throw error
        }
      }
      // A dry run says what it would open and touches nothing: no push, no
      // record, no ref anywhere. The wrapper used to take `--dry-run` on its own
      // surface and pass the core an ordinary submit, so a dry run opened a
      // real change: one submit, two opened records, 2026-09-03. The
      // flag belongs to the command that pushes, or to no command at all.
      if (request.dryRun === true) {
        const head = (await git(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`])).trim()
        const issue = await issueOf(git, branch, head, request.issue)
        emit(
          io,
          options.json,
          {
            change: changeName({ branch, head }),
            dryRun: true,
            submitter: request.submitter,
            target: targetName(config.target),
            ...(issue === undefined ? {} : { issue }),
          },
          `would open ${changeName({ branch, head })} on ${targetName(config.target)} for ${request.submitter}` +
            `${issue === undefined ? "" : ` (issue ${issue})`}; nothing was pushed`,
        )
        return 0
      }
      let submitted
      try {
        submitted = await submit(git, config.target.remote, {
          branch,
          submitter: request.submitter,
          target: config.target,
          ...(request.issue === undefined ? {} : { issue: request.issue }),
        })
      } catch (error) {
        if (error instanceof QueuePaused) {
          io.stderr(`yrd: ${error.message}\n`)
          return 1
        }
        throw error
      }
      emit(
        io,
        options.json,
        submitted,
        `${submitted.retry ? "retried" : "submitted"} ${branch} at ${submitted.head.slice(0, 12)} to ${targetName(config.target)}`,
      )
      return 0
    }
    case "run": {
      const outcome = await oneRound(config)
      return outcome?.exitCode ?? 2
    }
    case "up": {
      // The service: the same round on a loop, what hab runs. It has ONE
      // permanent exit, 2: a round is stuck, or the target's declaration can no
      // longer be read or is no longer there at all, and the queue stays down
      // until a person fixes it. Everything else it does on purpose — a signal,
      // and a gitlink that moved under it — exits 0, because hab classifies every
      // non-zero exit as a crash (ag hab-core, exit-classification.ts), backs
      // off, and counts it against a three-per-600-s budget: three gitlink advances
      // in ten minutes would have stopped the queue for the one condition whose
      // whole cure is the relaunch.
      const interval = (request.intervalSeconds ?? 15) * 1000
      // Read through a call each time: the signal flips while the loop runs.
      const stopped = (): boolean => request.stop?.aborted === true
      const gitlink = request.gitlink ?? (await gitlinkOf(git, targetRef, log))
      let current = config
      for (let round = 1; ; round += 1) {
        // The declaration again, as the target holds it now: a correct edit at
        // the target is the next round's, never a restart's.
        if (round > 1) {
          let why: string | undefined
          try {
            const next = await declaration()
            if (next === undefined) why = `${targetRef} no longer carries a .yrd.yml`
            else current = next
          } catch (error) {
            why = `the target's declaration cannot be read: ${error instanceof Error ? error.message : String(error)}`
          }
          if (why !== undefined) return stuck(why)
        }
        const outcome = await oneRound(current)
        if (outcome === undefined || outcome.exitCode === 2) return 2
        await request.afterRound?.(outcome)
        // The gitlink, at the target as this round left it: the round that merged
        // the change moving this yrd's own gitlink is the last one this code runs.
        if (gitlink !== undefined) {
          const now = await gitlinkAt(git, outcome.target, gitlink.path)
          if (now !== gitlink.sha) {
            const moved = `gitlink moved from ${gitlink.sha.slice(0, 12)} to ${now === undefined ? "no gitlink" : now.slice(0, 12)}: exiting for relaunch`
            log?.info?.(moved, { from: gitlink.sha, gitlink: gitlink.path, to: now })
            emit(io, options.json, { exitCode: 0, from: gitlink.sha, gitlink: gitlink.path, reason: "gitlink-moved", to: now }, moved)
            return 0
          }
        }
        if (stopped()) return 0
        await new Promise((resolve) => {
          setTimeout(resolve, interval)
        })
        if (stopped()) return 0
      }
    }
    case "list": {
      /**
       * One reading of the queue, rendered. Everything the list and the watch
       * show comes from here, so a refresh cannot show a different table from
       * the one a plain `queue list` would print at the same instant.
       *
       * The commits that went around the queue are rows too (E5), judged at
       * the target the queue read itself saw, so the rows and the reading are
       * about one and the same tip and no second reading can disagree with it.
       */
      const round = async (): Promise<
        Readonly<{ rows: readonly WatchRow[]; text: string; data: unknown }>
      > => {
        const queue = await readQueue(git, config.target.remote, config.target.branch)
        // The run journal on THIS machine, and the head subjects in one
        // batched read: the two joins the table needs and neither of them a
        // second derivation of anything the records already say. A machine
        // that runs no queue has no journal, and `journals.absent` is the
        // sentence that says so rather than a row that reads as if nothing
        // were running.
        const journals = readJournals(join(workdir, "logs"))
        const all = list(queue.changes, {
          directMerges: await directMergeCommits(git, config.target.branch, queue.target, queue.changes),
          journals,
          subjects: await subjects(
            git,
            queue.changes.map((entry) => entry.change.head),
          ),
        })
        const rows = filterRows(
          watchRows(all, { journals, ...(request.latest === true ? { latest: true } : {}) }),
          request.terms ?? [],
        )
        const pause = await activePause(git, config.target.remote)
        // What was queried, where it looked, and what it left out — said on the
        // screen, not left for the reader to infer from an empty table.
        const scope =
          request.terms === undefined || request.terms.length === 0
            ? undefined
            : `${String(rows.length)} of ${String(all.length)} change(s) match ${request.terms.join(" or ")}`
        return {
          data: {
            changes: rows.map((row) => ({ ...row.row, ...(row.run === undefined ? {} : { runOf: row.run.id }) })),
            journal: journalFact(journals),
            pause: pause ?? null,
          },
          rows,
          text: [
            // The pause stays the FIRST line it has always been: a queue that
            // is not running is the loudest thing about it, and a reader who
            // scrolled past the name would still see it. The name follows.
            pause === undefined ? undefined : pauseLine(pause),
            queueName(config.target, await remoteUrl(git, config.target.remote)),
            // G5: journal-derived fields are absent off the queue's own
            // machine, and the watch says where it looked rather than showing
            // a blank where a fact belongs.
            journals.absent,
            scope,
            rowTable(rows),
            ...(rows.length === 1 && rows[0] !== undefined
              ? [noticeLine(rows[0].row), clocksLine(rows[0].row)].filter((part) => part !== "")
              : []),
          ]
            .filter((part): part is string => part !== undefined)
            .join("\n"),
        }
      }

      if (request.watch !== true) {
        const one = await round()
        emit(io, options.json, one.data, one.text)
        return 0
      }

      // The watch. A selector runs to an ending and exits with the ending's
      // code, exactly as `yrd check` does (0 pass, 1 fail, 2 stuck); with no
      // selector there is nothing to run TO, so it refreshes until it is
      // stopped and exits 0.
      const selected = request.terms !== undefined && request.terms.length > 0
      const interval = Math.max(1, request.intervalSeconds ?? 5) * 1000
      const stopped = (): boolean => request.stop?.aborted === true
      let first = true
      for (;;) {
        const one = await round()
        // A selector that matches nothing would otherwise wait forever for a
        // change that is not there. It is refused loudly, with what was asked
        // for and where it was looked for.
        if (first && selected && one.rows.length === 0) {
          io.stderr(
            `yrd: nothing in ${queueName(config.target, await remoteUrl(git, config.target.remote))} matches ` +
              `${(request.terms ?? []).join(" or ")}. The queue read holds ${String(one.rows.length)} matching ` +
              "change(s); ended changes older than seven days are not read.\n",
          )
          return 2
        }
        first = false
        // A real terminal is redrawn in place; a pipe or a test keeps every
        // round, because a watch whose output is being read later is a log.
        if (io.color === true) io.stdout("\u001b[H\u001b[2J")
        emit(io, options.json, one.data, one.text)
        if (selected) {
          const ending = endingCode(one.rows)
          if (ending !== undefined) return ending
        }
        if (stopped()) return 0
        await new Promise((resolve) => {
          setTimeout(resolve, interval)
        })
        if (stopped()) return 0
      }
    }
    case "check": {
      // `yrd check <name>`: the named checks as the target declares them, run
      // in a FRESH WORKTREE OF HEAD exactly as a queue run does, in the
      // queue's order and stopping where the queue would stop. The exit is the
      // result: 0 pass, 1 fail, 2 stuck.
      //
      // It ran in the invoking tree until this was measured. A checkout whose
      // dependencies are symlinked from elsewhere judges that checkout rather
      // than the commit: an uncommitted `error TS2322` there failed
      // `yrd check typecheck` while HEAD was clean, and a worktree of HEAD
      // would have passed. That is the whole point of the command — a seat
      // must be able to see what the queue will see — so the invoking tree is
      // exactly the one place it must not look.
      const specs = request.names.map((name) => {
        const spec = config.checks.find((check) => check.name === name)
        if (spec === undefined) {
          throw new Error(
            `${name} is not a check the target declares (declared: ${config.checks.map((check) => check.name).join(", ") || "none"})`,
          )
        }
        return spec
      })
      // Every name is resolved before a worktree is built: an unknown check
      // should refuse instantly, not after materializing submodules.
      const head = (await git(["rev-parse", "HEAD"])).trim()
      // Uncommitted work is NOT judged, and saying so is the point. Silently
      // measuring HEAD while a seat believes its working tree was checked is
      // the same class of mismatch this command exists to remove.
      const dirty = (await git(["status", "--porcelain", "--untracked-files=no"])).trim()
      const unjudged =
        dirty === ""
          ? ""
          : `\n${String(dirty.split("\n").length)} uncommitted path(s) were NOT judged; this measured HEAD ${head.slice(0, 12)}`
      // One run of checks, under the one layout a queue run writes (run.ts):
      // its worktree at `<workdir>/worktrees/<run>/check/<sha12>`, its logs at
      // `<workdir>/checks/<change>/<run>/check/<name>.log`, its temporary files
      // under `<workdir>/tmp`. The run id is what keeps two of them apart, so a
      // check log is written once and never replaced — two seats checking at
      // once, or one seat checking twice, keep both readings instead of the
      // second silently overwriting the first (24101).
      //
      // The change is the one this checkout would submit: the branch it stands
      // on at the head it stands at, so a seat's own check and the queue's own
      // read of the same change sit at the same path. A detached HEAD says
      // `HEAD` and is still a name nothing else takes.
      const run = runId()
      const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim()
      const logDir = join(workdir, "checks", changeName({ branch, head }), run, "check")
      // The worktrees root of this run, claimed before anything is made in it:
      // a queue run reaps the worktrees of runs that are no longer alive, and
      // reads a directory with no pid file as one of them (worktree.ts).
      const worktrees = join(workdir, "worktrees", run)
      mkdirSync(worktrees, { recursive: true })
      claimWorktrees(worktrees)
      // Prepared exactly as a queue run prepares one: materialized, the
      // declaration's setup run once, and told the same three values.
      const prepared = await prepareWorktree(git, repo, head, join(worktrees, "check", head.slice(0, 12)), {
        env: options.env,
        plumbing: options.log?.child("worktree"),
        ...(config.setup === undefined ? {} : { setup: { logDir, run: config.setup, tmpdir: join(workdir, "tmp") } }),
        targetSha: await targetAt(git, config),
      })
      const results: CheckResult[] = []
      try {
        for (const spec of specs) {
          const result = await runCheck({
            cwd: prepared.path,
            env: options.env,
            logDir,
            spec,
            tmpdir: join(workdir, "tmp"),
            tree: prepared.tree,
          })
          results.push(result)
          if (result.result !== "pass") break
        }
      } finally {
        await prepared.remove()
        rmSync(worktrees, { force: true, recursive: true })
      }
      emit(
        io,
        options.json,
        { checks: results, command: "check", head, ...(dirty === "" ? {} : { uncommitted: dirty.split("\n").length }) },
        `${results.map((result) => `${result.name} ${result.result} exit=${String(result.exit)} ${String(result.durationMs)} ms (log ${result.log})${result.why === undefined ? "" : `: ${result.why}`}`).join("\n")}${unjudged}`,
      )
      return results.some((result) => result.result === "stuck")
        ? 2
        : results.some((result) => result.result === "fail")
          ? 1
          : 0
    }
    case "show": {
      const queue = await readQueue(git, config.target.remote, config.target.branch)
      const journals = readJournals(join(workdir, "logs"))
      const changes = show(queue.changes, request.branch, {
        journals,
        subjects: await subjects(
          git,
          queue.changes.map((entry) => entry.change.head),
        ),
      })
      // The checks a change was JUDGED BY: the declaration at the commit its
      // record names in `Base:`, joined to what actually ran. `show` used to
      // print the packed `Check:` trailer as it stood, so a check that never
      // ran — every check after a failing one — was simply not on the screen,
      // and the command that produced a log was nowhere.
      const views = new Map<string, Readonly<{ checks: readonly CheckView[]; note?: string }>>()
      for (const change of changes) {
        const declared = await declarationFor(git, config, change.row.base)
        views.set(change.row.head, {
          checks: checksOf(
            change.checks,
            endingOf(change.row),
            declared.checks,
            change.row.live === undefined ? undefined : { name: change.row.live.check, ...(change.row.live.log === undefined ? {} : { log: change.row.live.log }) },
          ),
          ...(declared.note === undefined ? {} : { note: declared.note }),
        })
      }
      emit(
        io,
        options.json,
        {
          changes: changes.map((change) => ({
            ...change.row,
            checks: views.get(change.row.head)?.checks ?? [],
            ...(views.get(change.row.head)?.note === undefined ? {} : { checksNote: views.get(change.row.head)?.note }),
            records: change.records.map((record) => ({
              at: record.at,
              kind: record.kind,
              sha: record.sha,
              subject: record.subject,
            })),
          })),
          journal: journalFact(journals),
        },
        changes.length === 0
          ? `no change for ${request.branch}`
          : changes
              .map((change) => {
                const view = views.get(change.row.head)
                return [
                  rowLine({ row: change.row }),
                  ...(view?.note === undefined ? [] : [`  (${view.note})`]),
                  ...(view?.checks ?? []).flatMap(checkLines),
                ].join("\n")
              })
              .join("\n"),
      )
      return 0
    }
  }
}

/**
 * The target as this checkout has it: the remote-tracking ref the declaration
 * names, fetched by `declaration()` before any command runs here. Absent is
 * loud, because what base a check is judging against is a claim about that
 * commit. `yrd check` is the one caller: every command that reads the queue
 * takes the target from that reading instead.
 */
async function targetAt(git: Git, config: QueueConfig): Promise<string> {
  const ref = `refs/remotes/${config.target.remote}/${config.target.branch}`
  const sha = await refAt(git, ref)
  if (sha === undefined) throw new Error(`${targetName(config.target)} is not here: ${ref} is absent`)
  return sha
}

/**
 * The gitlink the service runs from: the gitlink at the target that carries the
 * very commit this yrd's code runs from, found once at start. Off — said once,
 * at info — when this yrd runs from no git checkout, or when the target carries
 * no gitlink at its commit; then no round can see the gitlink move, and the
 * relaunch onto a new gitlink is a person's again.
 */
async function gitlinkOf(
  git: Git,
  targetRef: string,
  log: ConditionalLogger | undefined,
): Promise<Readonly<{ path: string; sha: string }> | undefined> {
  let running: string
  try {
    running = (await gitIn(dirname(fileURLToPath(import.meta.url)))(["rev-parse", "--verify", "HEAD^{commit}"])).trim()
  } catch (error) {
    log?.info?.("the gitlink exit is off: this yrd runs from no git checkout", {
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
  const recorded = gitlinks(await git(["ls-tree", "-r", "-z", targetRef])).find((row) => row.sha === running)
  if (recorded === undefined) {
    log?.info?.(`the gitlink exit is off: the target carries no gitlink at this yrd's commit ${running.slice(0, 12)}`)
    return undefined
  }
  return recorded
}

/** The gitlink at `path` in `commit`, or undefined when there is none there. */
async function gitlinkAt(git: Git, commit: string, path: string): Promise<string | undefined> {
  return gitlinks(await git(["ls-tree", "-z", commit, "--", path])).find((row) => row.path === path)?.sha
}

/** The gitlink rows of one `ls-tree -z` listing: mode 160000, a commit at a path. */
function gitlinks(listing: string): readonly Readonly<{ path: string; sha: string }>[] {
  const rows: Readonly<{ path: string; sha: string }>[] = []
  for (const row of listing.split("\0")) {
    const [meta, path] = row.split("\t")
    const [mode, , sha] = (meta ?? "").split(" ")
    if (mode === "160000" && path !== undefined && sha !== undefined) rows.push({ path, sha })
  }
  return rows
}

function runOptions(
  repo: string,
  config: QueueConfig,
  workdir: string,
  env?: NodeJS.ProcessEnv,
  log?: ConditionalLogger,
) {
  // A round made while the garage is open says so on its own record, so a
  // reader of the log can tell the mechanic's rounds from the service's.
  const garage = readGarageDeclaration(repo)
  return {
    checks: config.checks,
    configBlob: config.blob,
    env,
    ...(garage === undefined ? {} : { garage: garage.reason }),
    notify: config.notify,
    // git-super narrates which submodule it borrowed and how long each phase
    // took; that is trace-level plumbing, so it gets a logger only at trace.
    plumbing: log?.trace === undefined ? undefined : log.child("submodules"),
    render: renderer(log),
    repo,
    // A fresh worktree has submodules and no dependencies; `setup:` is what
    // finishes it, once per worktree, before any check runs in it.
    setup: config.setup,
    target: config.target,
    workdir,
  }
}

/**
 * The human line is a rendering of the log record, and the CLI's own logger is the
 * one place it is rendered: one debug row per log record, named by the log record's kind,
 * at the level the invocation resolved (`--log-level`, `LOG_LEVEL`, `-v`),
 * never a second format and never a second reading of the environment. No
 * host logger, no rendering: the JSONL file is what happened either way, and
 * a logger root of this file's own would create spans the stage accounting
 * never counts.
 */
function renderer(root: ConditionalLogger | undefined): (record: LogRecord) => void {
  if (root === undefined) return () => {}
  const base = root.child("queue")
  const byKind = new Map<string, ConditionalLogger>()
  return (record) => {
    let log = byKind.get(record.kind)
    if (log === undefined) {
      log = base.child(record.kind)
      byKind.set(record.kind, log)
    }
    const { kind, run: _run, at: _at, ...rest } = record
    // A conditional logger has no debug method below its level: nothing to render.
    log.debug?.(summarize(kind, rest), rest)
  }
}

function summarize(kind: string, rest: Readonly<Record<string, unknown>>): string {
  const where = [rest.branch, typeof rest.head === "string" ? rest.head.slice(0, 12) : undefined]
    .filter(Boolean)
    .join(" at ")
  switch (kind) {
    case "run":
      return `queue run at ${String(rest.target)} ${String(rest.gitlink).slice(0, 12)}`
    case "change":
      return `${where}: ${String(rest.decision ?? rest.state)}`
    case "check":
      // Two rows per check: `ms` is the end row's, and its absence is the
      // start row, the one that says a long check is running rather than hung.
      return rest.ms === undefined
        ? `${String(rest.name)} started for ${where}`
        : `${String(rest.name)} ran for ${where} in ${String(rest.ms)} ms`
    case "result":
      return `${String(rest.name)} ${String(rest.result)} for ${where}${rest.whose === undefined ? "" : `, ${String(rest.whose)}'s`}`
    case "merge":
      return `${where} merged as ${String(rest.commit).slice(0, 12)}`
    case "message":
      return `told ${String(rest.to)} about ${where}`
    case "reap":
      return `reaped the worktree ${String(rest.path)} of the run ${String(rest.of)}: ${String(rest.why)}`
    case "pause":
      return `${String(rest.state)} by ${String(rest.by)} since ${String(rest.since)}: ${String(rest.reason)}`
    case "merged-direct":
      return directMergeLine({
        commit: String(rest.commit),
        gitlinks: Array.isArray(rest.gitlinks) ? rest.gitlinks.map(String) : [],
        subject: String(rest.subject),
        target: String(rest.branch),
      })
    default:
      return kind
  }
}

function describeRun(
  outcome: Readonly<{
    exitCode: number
    merged: readonly string[]
    failed: readonly string[]
    stuck: readonly string[]
    directMerges: readonly string[]
    log: string
    garage?: string
    stopped?: Readonly<{ says: string }>
  }>,
): string {
  const words = ["pass", "fail", "stuck"][outcome.exitCode] ?? String(outcome.exitCode)
  const parts = [
    outcome.merged.length > 0 ? `merged ${outcome.merged.join(", ")}` : undefined,
    outcome.failed.length > 0 ? `failed ${outcome.failed.join(", ")}` : undefined,
    outcome.stuck.length > 0 ? `stuck ${outcome.stuck.join(", ")}` : undefined,
    outcome.directMerges.length > 0
      ? `${String(outcome.directMerges.length)} ${outcome.directMerges.length === 1 ? "commit" : "commits"} around the queue at ${outcome.directMerges.map((sha) => sha.slice(0, 12)).join(", ")}`
      : undefined,
    outcome.stopped === undefined ? undefined : `${outcome.stopped.says}; no merge was made`,
  ].filter((part): part is string => part !== undefined)
  const garage = outcome.garage === undefined ? "" : `; in the garage: ${outcome.garage}`
  return `${words}: ${parts.length === 0 ? "nothing to do" : parts.join("; ")}${garage} (log ${outcome.log})`
}

/**
 * The code a watched set of changes ended with, or undefined while any of them
 * is still in line. It is `yrd check`'s own ladder — stuck beats failed beats
 * merged — because a watch is the same question asked over time, and the two
 * answering differently for one change is the whole failure this mirrors.
 */
function endingCode(rows: readonly WatchRow[]): YrdCliExitCode | undefined {
  const states = rows.map((row) => row.row.state)
  if (states.some((state) => state === "queued" || state === "checked")) return undefined
  if (states.some((state) => state === "stuck")) return 2
  if (states.some((state) => state === "failed")) return 1
  return 0
}

/** The URL a remote NAME stands for, which is what the queue calls itself to a stranger (config.ts). */
async function remoteUrl(git: Git, remote: string): Promise<string> {
  return (await git(["remote", "get-url", remote])).trim()
}

/**
 * Where the run journal was looked for, and what was found there — carried in
 * every JSON answer that has journal-derived fields in it, so a reader that
 * sees no `live` and no `run` can tell a queue with nothing running from a
 * machine that holds no journal at all.
 */
function journalFact(journals: Journals): Readonly<{ dir: string; absent?: string }> {
  return { dir: journals.dir, ...(journals.absent === undefined ? {} : { absent: journals.absent }) }
}

/**
 * The declaration a change was JUDGED BY: the one at the commit its record
 * names in `Base:`, not whatever the target carries now. A change judged under
 * checks that have since been renamed must still show the checks it was
 * measured against.
 *
 * When that reading cannot be had — no `Base:` on the record, or the commit is
 * not in this repository — the target's own declaration stands in AND the note
 * says so, in the same breath, because a "not run" measured against the wrong
 * list is a claim nobody made.
 */
async function declarationFor(
  git: Git,
  config: QueueConfig,
  base: string | undefined,
): Promise<Readonly<{ checks: readonly CheckSpec[]; note?: string }>> {
  if (base === undefined) {
    return { checks: config.checks, note: "the record names no base, so these are the checks the target declares now" }
  }
  try {
    const at = await readConfig(git, base)
    if (at !== undefined) return { checks: at.checks }
    return {
      checks: config.checks,
      note: `${base.slice(0, 12)} carries no .yrd.yml, so these are the checks the target declares now`,
    }
  } catch (error) {
    return {
      checks: config.checks,
      note: `the declaration at ${base.slice(0, 12)} could not be read (${error instanceof Error ? error.message : String(error)}), so these are the checks the target declares now`,
    }
  }
}

/** How the change ended, in the word `checksOf` needs to judge its last check. */
function endingOf(row: Row): "checked" | "merged" | "failed" | "stuck" | "open" {
  return row.state === "merged" || row.state === "failed" || row.state === "stuck" || row.state === "checked"
    ? row.state
    : "open"
}

/**
 * The glyphs the retired watch used for exactly these five conditions, kept
 * because the operator already reads them: passed, failed, stuck, running, and
 * a check the change never reached.
 */
const CHECK_GLYPH: Readonly<Record<CheckView["state"], string>> = {
  failed: "\u00d7",
  passed: "\u2713",
  running: "\u25c9",
  "not-run": "\u2212",
  stuck: "\u25cc",
}

/** One check, and under it the command that produced it and the log it wrote. */
function checkLines(check: CheckView): readonly string[] {
  const exit = check.result?.exit === undefined ? "" : ` exit=${check.result.exit}`
  const ms = check.result?.ms === undefined ? "" : ` ${duration(check.result.ms)}`
  const state = check.state === "not-run" ? " NOT RUN" : check.state === "running" ? " running" : ""
  return [
    `  ${CHECK_GLYPH[check.state]} ${check.name}${state}${exit}${ms}`,
    // The command above its output, which here is the path the output went to
    // (S2.21). A check the declaration no longer names has no command to show,
    // and says that rather than showing an empty one.
    check.spec === undefined ? "      (the declaration does not name this check)" : `      $ ${check.spec.run}`,
    ...(check.log === undefined ? [] : [`      log ${check.log}`]),
  ]
}

function emit(io: YrdCliIO, json: boolean | undefined, data: unknown, human: string): void {
  if (json === true) io.stdout(`${JSON.stringify(data)}\n`)
  else io.stdout(`${human}\n`)
}
