/**
 * The queue commands ([plan](../../../../pm/@i/10-yrd/plan.md) § The final
 * design, Commands).
 *
 * One switch selects the queue: a `.yrd.yml` at HEAD that names `remote:` is
 * the declaration, and the target it names must carry the line too. That
 * switch was flag day's knob (§ Cutover), and the incumbent it used to fall
 * through to is gone at M6 — so `undefined` from here is no longer a
 * fallthrough, and the CLI turns it into a refusal naming the missing line.
 */

import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ConditionalLogger } from "loggily"
import {
  byHandCommits,
  changeName,
  handMovedLine,
  prepareWorktree,
  gitIn,
  hintsIn,
  list,
  queueRun,
  readConfig,
  readHints,
  readQueue,
  refAt,
  resolveRemote,
  runCheck,
  show,
  refuseTarget,
  submit,
  workItemOf,
  type CheckResult,
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
  | Readonly<{ command: "submit"; branch?: string; submitter: string; workItem?: string; dryRun?: boolean }>
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
  list: "queue list",
  run: "queue run",
  show: "queue show",
  submit: "submit",
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
  const notSelected = (): YrdCliExitCode => {
    io.stderr(
      `yrd: ${NAMED[request.command]} needs a queue, and no declaration here selects one. ` +
        "Add a `remote:` line to the `.yrd.yml` of this repository AND of the target it names.\n",
    )
    return 2
  }
  // The switch: the declaration checked out where the command stands names
  // `remote:`, or this queue is not selected and no git runs at all. The
  // PARSED declaration is that switch, and the only reader of this file: a
  // regex for `^remote:` used to answer first and the parser two lines below
  // answered again, so a `.yrd.yml` that named `remote:` and did not parse
  // passed the regex, lost its `remote` to the parser, and went on against
  // origin/main with the problem said once at debug level.
  //
  // A file that does not parse hints NOTHING and says so on stderr, once: the
  // defaults stand, because the local declaration is a hint and the target's
  // is the authority — a branch that breaks its own `.yrd.yml` still submits,
  // and D2 bills it at merge (config.ts). What it may not do is go quiet.
  const here = declarationHere(repo)
  if (here === undefined) return notSelected()
  const hints = hintsIn(here.text, join(here.root, ".yrd.yml"))
  if (hints.problem !== undefined) {
    io.stderr(`yrd: ${hints.problem}; it hints nothing, so this asks origin/main, which must declare the queue itself\n`)
  } else if (hints.remote === undefined) {
    return notSelected()
  }
  const git = gitIn(here.root)
  const log = options.log?.child("queue")
  // The declaration here only hints where the queue is (`remote:`, `target:`);
  // the target's declaration is the authority for every judgement, and it has
  // to name `remote:` itself, or a branch alone could opt into this core. A
  // branch that rewrote or broke its own `.yrd.yml` is judged by the target's
  // rules all the same (ruling D2 bills it at merge).
  const hinted = await resolveRemote(git, hints.remote ?? "origin")
  const hintedTarget = hints.target ?? "main"
  const targetRef = `${hinted}/${hintedTarget}`
  // The target's declaration as the target holds it now: fetched, then the
  // switch (the target names `remote:`; only then is its declaration read in
  // full and held to its keys), then the remote it names resolved. Undefined when the target does not
  // select this core; a declaration that exists and cannot be read throws.
  // One reading serves a one-shot command; the service reads again before
  // every round, so an edit at the target takes effect on the next round.
  const declaration = async (): Promise<QueueConfig | undefined> => {
    await git(["fetch", "--quiet", hinted, `+refs/heads/${hintedTarget}:refs/remotes/${targetRef}`])
    if ((await readHints(git, targetRef)).remote === undefined) return undefined
    const declared = await readConfig(git, targetRef)
    if (declared === undefined) return undefined
    return { ...declared, remote: await resolveRemote(git, declared.remote) }
  }
  const config = await declaration()
  if (config === undefined) return notSelected()
  // A worktree's `.git` is a file, so the queue's own directory lives under the
  // common git dir the whole repository shares, never under a path guessed from it.
  const commonDir = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
  const workdir = options.workdir ?? join(commonDir, "yrd-core")
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
    case "submit": {
      const branch = request.branch ?? (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim()
      // The preview refuses exactly what the action refuses, first.
      refuseTarget(branch, config.target)
      // A dry run says what it would open and touches nothing: no push, no
      // fact, no ref anywhere. The wrapper used to take `--dry-run` on its own
      // surface and hand the core an ordinary submit, so a dry run opened a
      // real change (task/owner-field-item13@22b2741a, two opened facts). The
      // flag belongs to the command that pushes, or to no command at all.
      if (request.dryRun === true) {
        const head = (await git(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`])).trim()
        const workItem = await workItemOf(git, branch, head, request.workItem)
        emit(
          io,
          options.json,
          {
            change: changeName({ branch, head }),
            dryRun: true,
            submitter: request.submitter,
            target: config.target,
            ...(workItem === undefined ? {} : { workItem }),
          },
          `would open ${changeName({ branch, head })} on ${config.target} for ${request.submitter}` +
            `${workItem === undefined ? "" : ` (work item ${workItem})`}; nothing was pushed`,
        )
        return 0
      }
      const submitted = await submit(git, config.remote, {
        branch,
        submitter: request.submitter,
        target: config.target,
        ...(request.workItem === undefined ? {} : { workItem: request.workItem }),
      })
      emit(io, options.json, submitted, `${submitted.retry ? "retried" : "submitted"} ${branch} at ${submitted.head.slice(0, 12)} to ${config.target}`)
      return 0
    }
    case "run": {
      const outcome = await oneRound(config)
      return outcome?.exitCode ?? 2
    }
    case "up": {
      // The service: the same round on a loop, what hab runs. It has ONE
      // permanent exit, 2: a round is stuck, or the target's declaration can no
      // longer be read or no longer selects this core, and the queue stays down
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
            if (next === undefined) why = "the target's declaration no longer selects this core"
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
        await new Promise((resolve) => setTimeout(resolve, interval))
        if (stopped()) return 0
      }
    }
    case "list": {
      // The commits the target gained by hand are rows too (E5), judged at the
      // target the queue read itself saw, so the rows and the reading are about
      // one and the same tip and no second reading can disagree with it.
      const queue = await readQueue(git, config.remote, config.target)
      const rows = list(queue.changes, {
        byHand: await byHandCommits(git, config.target, queue.target, queue.changes),
      })
      emit(io, options.json, { changes: rows }, table(rows))
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
          throw new Error(`${name} is not a check the target declares (declared: ${config.checks.map((check) => check.name).join(", ") || "none"})`)
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
      const unjudged = dirty === "" ? "" : `\n${String(dirty.split("\n").length)} uncommitted path(s) were NOT judged; this measured HEAD ${head.slice(0, 12)}`
      // Every invocation writes its logs under a directory of its own, named by
      // the instant it started and printed with each result: a check log is
      // written once and never replaced, here as in a queue run, so two seats
      // checking at once — or one seat checking twice — keep both readings
      // instead of the second silently overwriting the first (24101).
      const logDir = join(workdir, "checks", "head", new Date().toISOString())
      // Prepared exactly as a queue run prepares one: materialized, the
      // declaration's setup run once, and told the same three values.
      const prepared = await prepareWorktree(git, repo, head, join(workdir, "check", `${head.slice(0, 12)}-${String(globalThis.process.pid)}`), {
        env: options.env,
        plumbing: options.log?.child("worktree"),
        ...(config.setup === undefined ? {} : { setup: { logDir, run: config.setup, tmpdir: join(workdir, "tmp") } }),
        targetSha: await targetAt(git, config),
      })
      const results: CheckResult[] = []
      try {
        for (const spec of specs) {
          const result = await runCheck({ cwd: prepared.path, env: options.env, logDir, spec, tmpdir: join(workdir, "tmp"), tree: prepared.tree })
          results.push(result)
          if (result.result !== "pass") break
        }
      } finally {
        await prepared.remove()
      }
      emit(
        io,
        options.json,
        { checks: results, command: "check", head, ...(dirty === "" ? {} : { uncommitted: dirty.split("\n").length }) },
        `${results.map((result) => `${result.name} ${result.result} exit=${String(result.exit)} ${String(result.durationMs)} ms (log ${result.log})${result.why === undefined ? "" : `: ${result.why}`}`).join("\n")}${unjudged}`,
      )
      return results.some((result) => result.result === "stuck") ? 2 : results.some((result) => result.result === "fail") ? 1 : 0
    }
    case "show": {
      const changes = show((await readQueue(git, config.remote, config.target)).changes, request.branch)
      emit(
        io,
        options.json,
        { changes: changes.map((change) => ({ ...change.row, checks: change.checks, facts: change.facts.map((fact) => ({ at: fact.at, kind: fact.kind, sha: fact.sha, subject: fact.subject })) })) },
        changes.length === 0 ? `no change for ${request.branch}` : changes.map((change) => [line(change.row), ...change.checks.map((check) => `  ${check}`)].join("\n")).join("\n"),
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
  const ref = `refs/remotes/${config.remote}/${config.target}`
  const sha = await refAt(git, ref)
  if (sha === undefined) throw new Error(`${config.target} is not here: ${ref} is absent`)
  return sha
}

/**
 * The pin the service runs from: the gitlink at the target that carries the
 * very commit this yrd's code runs from, found once at start. Off — said once,
 * at info — when this yrd runs from no git checkout, or when the target pins
 * no gitlink at its commit; then no round can see the pin move, and the
 * relaunch onto a new pin is a person's hand again.
 */
async function pinOf(git: Git, targetRef: string, log: ConditionalLogger | undefined): Promise<Readonly<{ path: string; sha: string }> | undefined> {
  let running: string
  try {
    running = (await gitIn(dirname(fileURLToPath(import.meta.url)))(["rev-parse", "--verify", "HEAD^{commit}"])).trim()
  } catch (error) {
    log?.info?.("the pin exit is off: this yrd runs from no git checkout", { error: error instanceof Error ? error.message : String(error) })
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

function runOptions(repo: string, config: QueueConfig, workdir: string, env?: NodeJS.ProcessEnv, log?: ConditionalLogger) {
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
    remote: config.remote,
    render: renderer(log),
    repo,
    // A fresh worktree has submodules and no dependencies; `setup:` is what
    // finishes it, once per worktree, before any check runs in it.
    setup: config.setup,
    target: config.target,
    workdir: config.workdir ?? workdir,
  }
}

/**
 * The human line is a rendering of the record, and the CLI's own logger is the
 * one place it is rendered: one debug row per fact, named by the fact's kind,
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
  const where = [rest.branch, typeof rest.head === "string" ? rest.head.slice(0, 12) : undefined].filter(Boolean).join(" at ")
  switch (kind) {
    case "run":
      return `queue run at ${rest.target} ${String(rest.pin).slice(0, 12)}`
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
    case "by-hand":
      return handMovedLine({
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
    byHand: readonly string[]
    log: string
    garage?: string
  }>,
): string {
  const words = ["pass", "fail", "stuck"][outcome.exitCode] ?? String(outcome.exitCode)
  const parts = [
    outcome.merged.length > 0 ? `merged ${outcome.merged.join(", ")}` : undefined,
    outcome.failed.length > 0 ? `failed ${outcome.failed.join(", ")}` : undefined,
    outcome.stuck.length > 0 ? `stuck ${outcome.stuck.join(", ")}` : undefined,
    outcome.byHand.length > 0
      ? `${String(outcome.byHand.length)} ${outcome.byHand.length === 1 ? "commit" : "commits"} by hand at ${outcome.byHand.map((sha) => sha.slice(0, 12)).join(", ")}`
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
  return `${position} ${row.state.padEnd(7)} ${row.branch} ${row.head.slice(0, 12)} ${result}${row.workItem === undefined ? "" : ` ${row.workItem}`}`.trimEnd()
}

function emit(io: YrdCliIO, json: boolean | undefined, data: unknown, human: string): void {
  if (json === true) io.stdout(`${JSON.stringify(data)}\n`)
  else io.stdout(`${human}\n`)
}
