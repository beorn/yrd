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
  bypassCommits,
  activeFreeze,
  changeName,
  claimWorktrees,
  configValue,
  bypassLine,
  freezeLine,
  prepareWorktree,
  gitIn,
  hintsIn,
  list,
  queueRun,
  readConfig,
  readQueue,
  runId,
  targetName,
  refAt,
  resolveRemote,
  runCheck,
  show,
  refuseTarget,
  submit,
  issueOf,
  QueueFrozen,
  QueueNotFrozen,
  requireUnfrozen,
  writeFreeze,
  type CheckResult,
  type FreezeEvent,
  type Git,
  type LogRecord,
  type QueueConfig,
  type QueueRunOutcome,
  type Row,
} from "@yrd/queue-core"
import { declarationHere } from "./declaration.ts"
import { readGarageDeclaration } from "./garage.ts"
import type { YrdCliExitCode, YrdCliIO } from "./types.ts"

export type CoreQueueCommand =
  | Readonly<{ command: "submit"; branch?: string; submitter: string; issue?: string; dryRun?: boolean }>
  | Readonly<{ command: "freeze"; by: string; reason: string }>
  | Readonly<{ command: "unfreeze"; by: string; reason?: string }>
  | Readonly<{ command: "run" }>
  | Readonly<{
      command: "up"
      intervalSeconds?: number
      stop?: AbortSignal
      /**
       * The pin: the gitlink at the target that carries the commit this yrd
       * runs from. Absent, both are found from this module's own checkout at
       * start; a test names them to move a pin without running from one.
       */
      pin?: Readonly<{ path: string; sha: string }>
      /** Awaited after each round, before the pin is read; a test mutates the world or stops the service here. */
      afterRound?: (outcome: QueueRunOutcome) => void | Promise<void>
    }>
  | Readonly<{ command: "list" }>
  | Readonly<{ command: "show"; branch: string }>
  | Readonly<{ command: "check"; names: readonly string[] }>

/** What each command is called when it has to say it needs a queue. */
const NAMED: Readonly<Record<CoreQueueCommand["command"], string>> = {
  check: "check",
  freeze: "queue freeze",
  list: "queue list",
  run: "queue run",
  show: "queue show",
  submit: "submit",
  unfreeze: "queue unfreeze",
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
    case "freeze":
    case "unfreeze": {
      try {
        const freeze = await writeFreeze(git, config.target.remote, {
          by: request.by,
          kind: request.command === "freeze" ? "frozen" : "unfrozen",
          reason: request.command === "freeze" ? request.reason : (request.reason ?? "freeze lifted"),
        })
        emit(io, options.json, freeze, freezeLine(freeze))
        return 0
      } catch (error) {
        if (error instanceof QueueFrozen || error instanceof QueueNotFrozen) {
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
          await requireUnfrozen(git, config.target.remote)
        } catch (error) {
          if (error instanceof QueueFrozen) {
            io.stderr(`yrd: ${error.message}\n`)
            return 1
          }
          throw error
        }
      }
      // A dry run says what it would open and touches nothing: no push, no
      // event, no ref anywhere. The wrapper used to take `--dry-run` on its own
      // surface and pass the core an ordinary submit, so a dry run opened a
      // real change: one submit, two opened events, 2026-09-03. The
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
        if (error instanceof QueueFrozen) {
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
      // and a pin that moved under it — exits 0, because hab classifies every
      // non-zero exit as a crash (ag hab-core, exit-classification.ts), backs
      // off, and counts it against a three-per-600-s budget: three pin advances
      // in ten minutes would have stopped the queue for the one event whose
      // whole cure is the relaunch.
      const interval = (request.intervalSeconds ?? 15) * 1000
      // Read through a call each time: the signal flips while the loop runs.
      const stopped = (): boolean => request.stop?.aborted === true
      const pin = request.pin ?? (await pinOf(git, targetRef, log))
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
        // The pin, at the target as this round left it: the round that merged
        // the change moving this yrd's own gitlink is the last one this code runs.
        if (pin !== undefined) {
          const now = await gitlinkAt(git, outcome.target, pin.path)
          if (now !== pin.sha) {
            const moved = `pin moved from ${pin.sha.slice(0, 12)} to ${now === undefined ? "no gitlink" : now.slice(0, 12)}: exiting for relaunch`
            log?.info?.(moved, { from: pin.sha, pin: pin.path, to: now })
            emit(io, options.json, { exitCode: 0, from: pin.sha, pin: pin.path, reason: "pin-moved", to: now }, moved)
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
      // The commits that went around the queue are rows too (E5), judged at the
      // target the queue read itself saw, so the rows and the reading are about
      // one and the same tip and no second reading can disagree with it.
      const queue = await readQueue(git, config.target.remote, config.target.branch)
      const rows = list(queue.changes, {
        bypasses: await bypassCommits(git, config.target.branch, queue.target, queue.changes),
      })
      const freeze = await activeFreeze(git, config.target.remote)
      emit(
        io,
        options.json,
        { changes: rows, ...(freeze === undefined ? {} : { freeze }) },
        [freeze === undefined ? undefined : freezeLine(freeze), table(rows)]
          .filter((line): line is string => line !== undefined)
          .join("\n"),
      )
      return 0
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
      const changes = show((await readQueue(git, config.target.remote, config.target.branch)).changes, request.branch)
      emit(
        io,
        options.json,
        {
          changes: changes.map((change) => ({
            ...change.row,
            checks: change.checks,
            events: change.events.map((event) => ({
              at: event.at,
              kind: event.kind,
              sha: event.sha,
              subject: event.subject,
            })),
          })),
        },
        changes.length === 0
          ? `no change for ${request.branch}`
          : changes
              .map((change) => [line(change.row), ...change.checks.map((check) => `  ${check}`)].join("\n"))
              .join("\n"),
      )
      return 0
    }
  }
}

/**
 * The queue's working directory, where everything it writes goes: whatever
 * `git config yrd.workdir` resolves to in the repository the command runs in —
 * any scope git honours, so a host says it once in `--global` and a single
 * repository can say otherwise — else `<git-common-dir>/yrd`.
 *
 * It is git configuration and not a `.yrd.yml` key because it is about THIS
 * MACHINE, not about the queue: the declaration is one file shared by every
 * clone, and a path on the queue runner's disk means nothing in a seat's
 * checkout.
 *
 * A worktree's `.git` is a file, so the default lives under the common git dir
 * the whole repository shares, never under a path guessed from it.
 */
async function workdirOf(git: Git): Promise<string> {
  const declared = await configValue(git, "yrd.workdir")
  if (declared !== undefined) return declared
  const commonDir = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
  return join(commonDir, "yrd")
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
 * The pin the service runs from: the gitlink at the target that carries the
 * very commit this yrd's code runs from, found once at start. Off — said once,
 * at info — when this yrd runs from no git checkout, or when the target pins
 * no gitlink at its commit; then no round can see the pin move, and the
 * relaunch onto a new pin is a person's again.
 */
async function pinOf(
  git: Git,
  targetRef: string,
  log: ConditionalLogger | undefined,
): Promise<Readonly<{ path: string; sha: string }> | undefined> {
  let running: string
  try {
    running = (await gitIn(dirname(fileURLToPath(import.meta.url)))(["rev-parse", "--verify", "HEAD^{commit}"])).trim()
  } catch (error) {
    log?.info?.("the pin exit is off: this yrd runs from no git checkout", {
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
  const pinned = gitlinks(await git(["ls-tree", "-r", "-z", targetRef])).find((row) => row.sha === running)
  if (pinned === undefined) {
    log?.info?.(`the pin exit is off: the target pins no gitlink at this yrd's commit ${running.slice(0, 12)}`)
    return undefined
  }
  return pinned
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
 * The human line is a rendering of the record, and the CLI's own logger is the
 * one place it is rendered: one debug row per event, named by the event's kind,
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
      return `queue run at ${String(rest.target)} ${String(rest.pin).slice(0, 12)}`
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
    case "freeze":
      return `${String(rest.state)} by ${String(rest.by)} since ${String(rest.since)}: ${String(rest.reason)}`
    case "merged-bypass":
      return bypassLine({
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
    bypasses: readonly string[]
    log: string
    garage?: string
    freeze?: FreezeEvent
  }>,
): string {
  if (outcome.freeze !== undefined) {
    return `${freezeLine(outcome.freeze)}; no merge was made (log ${outcome.log})`
  }
  const words = ["pass", "fail", "stuck"][outcome.exitCode] ?? String(outcome.exitCode)
  const parts = [
    outcome.merged.length > 0 ? `merged ${outcome.merged.join(", ")}` : undefined,
    outcome.failed.length > 0 ? `failed ${outcome.failed.join(", ")}` : undefined,
    outcome.stuck.length > 0 ? `stuck ${outcome.stuck.join(", ")}` : undefined,
    outcome.bypasses.length > 0
      ? `${String(outcome.bypasses.length)} ${outcome.bypasses.length === 1 ? "commit" : "commits"} around the queue at ${outcome.bypasses.map((sha) => sha.slice(0, 12)).join(", ")}`
      : undefined,
  ].filter((part): part is string => part !== undefined)
  const garage = outcome.garage === undefined ? "" : `; in the garage: ${outcome.garage}`
  return `${words}: ${parts.length === 0 ? "nothing to do" : parts.join("; ")}${garage} (log ${outcome.log})`
}

function table(rows: readonly Row[]): string {
  if (rows.length === 0) return "nothing in line"
  return rows.map(line).join("\n")
}

function line(row: Row): string {
  const position = row.position === undefined ? "  " : String(row.position).padStart(2)
  const result = row.result ?? row.reason ?? ""
  return `${position} ${row.state.padEnd(7)} ${row.branch} ${row.head.slice(0, 12)} ${result}${row.issue === undefined ? "" : ` ${row.issue}`}`.trimEnd()
}

function emit(io: YrdCliIO, json: boolean | undefined, data: unknown, human: string): void {
  if (json === true) io.stdout(`${JSON.stringify(data)}\n`)
  else io.stdout(`${human}\n`)
}
