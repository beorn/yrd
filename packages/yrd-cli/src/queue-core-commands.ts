/**
 * The five queue commands on the new core
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design, Commands).
 *
 * One switch selects the core: a `.yrd.yml` at HEAD that names `remote:` is
 * the new design's declaration, and every `yrd queue …` command then runs
 * here; without it the incumbent handles the command as before. That switch
 * is flag day's knob (§ Cutover): adding one line to the target's declaration
 * is the cutover, and removing the incumbent at M6 removes the fallthrough.
 * Nothing is run twice and nothing is converted.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ConditionalLogger } from "loggily"
import {
  byHandCommits,
  freshWorktree,
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
  submit,
  type CheckResult,
  type Git,
  type LogRecord,
  type QueueConfig,
  type QueueRunOutcome,
  type Row,
} from "@yrd/queue-core"
import { readGarageDeclaration } from "./garage.ts"
import type { YrdCliExitCode, YrdCliIO } from "./types.ts"

export type CoreQueueCommand =
  | Readonly<{ command: "submit"; branch?: string; submitter: string; workItem?: string }>
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

/**
 * Run one queue command on the new core, or return undefined when the
 * repository's declaration does not select it.
 */
export async function coreQueueCommand(
  repo: string,
  io: YrdCliIO,
  request: CoreQueueCommand,
  options: Readonly<{ json?: boolean; env?: NodeJS.ProcessEnv; workdir?: string; log?: ConditionalLogger }> = {},
): Promise<YrdCliExitCode | undefined> {
  // The switch, at no cost to the incumbent: the declaration checked out where
  // the command stands names `remote:`, or this core is not selected and no
  // git runs at all. The incumbent's own tests drive the CLI with doubles and
  // no working tree, and its literal one-shot reads spend exactly one git
  // read; both hold because nothing below runs unless the file says so. The
  // switch goes with the incumbent at M6.
  const here = declarationHere(repo)
  if (here === undefined || !/^remote:/mu.test(here.text)) return undefined
  const git = gitIn(here.root)
  const log = options.log?.child("queue")
  // The declaration here only hints where the queue is (`remote:`, `target:`);
  // the target's declaration is the authority for every judgement, and it has
  // to name `remote:` itself, or a branch alone could opt into this core. A
  // branch that rewrote or broke its own `.yrd.yml` is judged by the target's
  // rules all the same (ruling D2 bills it at merge).
  const hints = hintsIn(here.text)
  if (hints.problem !== undefined) log?.debug?.(`${hints.problem}; asking the target`)
  const hinted = await resolveRemote(git, hints.remote ?? "origin")
  const hintedTarget = hints.target ?? "main"
  const targetRef = `${hinted}/${hintedTarget}`
  // The target's declaration as the target holds it now: fetched, then the
  // switch (the target names `remote:`; only then is its declaration read in
  // full and held to its keys, and the incumbent's file is never parsed here),
  // then the remote it names resolved. Undefined when the target does not
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
  if (config === undefined) return undefined
  // A worktree's `.git` is a file, so the queue's own directory lives under the
  // common git dir the whole repository shares, never under a path guessed from it.
  const commonDir = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
  const workdir = options.workdir ?? join(commonDir, "yrd-core")
  mkdirSync(workdir, { recursive: true })

  switch (request.command) {
    case "submit": {
      const branch = request.branch ?? (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim()
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
      // The one exit site, from the caller's side: a run that could not even judge
      // (a bad invocation, a remote that cannot be read) is stuck, exit 2.
      let outcome
      try {
        outcome = await queueRun(runOptions(repo, config, workdir, options.env, options.log))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        emit(io, options.json, { exitCode: 2, failed: [], merged: [], stuck: [], why: message }, `stuck: the queue run could not judge: ${message}`)
        return 2
      }
      emit(io, options.json, outcome, describeRun(outcome))
      return outcome.exitCode
    }
    case "up": {
      // The service: the same round on a loop, what hab runs. Three exits of
      // its own (§ Commands): 2 when a round is stuck, or when the target's
      // declaration can no longer be read or no longer selects this core,
      // because the queue stays down until a person fixes it; 18 when the pin
      // moves, so hab relaunches the service on the new pin; and a signal.
      const interval = (request.intervalSeconds ?? 15) * 1000
      // Read through a call each time: the signal flips while the loop runs.
      const stopped = (): boolean => request.stop?.aborted === true
      const pin = request.pin ?? (await pinOf(git, targetRef, log))
      let current = config
      for (let round = 1; ; round += 1) {
        // The declaration again, as the target holds it now. The incumbent
        // cached its check config at start, so a correct edit at the target
        // looked like a wrong one until a restart; here it is the next round's.
        if (round > 1) {
          let why: string | undefined
          try {
            const next = await declaration()
            if (next === undefined) why = "the target's declaration no longer selects this core"
            else current = next
          } catch (error) {
            why = `the target's declaration cannot be read: ${error instanceof Error ? error.message : String(error)}`
          }
          if (why !== undefined) {
            emit(io, options.json, { exitCode: 2, failed: [], merged: [], stuck: [], why }, `stuck: ${why}`)
            return 2
          }
        }
        let outcome: QueueRunOutcome
        try {
          outcome = await queueRun(runOptions(repo, current, workdir, options.env, options.log))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          emit(io, options.json, { exitCode: 2, failed: [], merged: [], stuck: [], why: message }, `stuck: the queue run could not judge: ${message}`)
          return 2
        }
        emit(io, options.json, outcome, describeRun(outcome))
        if (outcome.exitCode === 2) return 2
        await request.afterRound?.(outcome)
        // The pin, at the target as this round left it: the round that merged
        // the change moving this yrd's own gitlink is the last one this code runs.
        if (pin !== undefined) {
          const now = await gitlinkAt(git, outcome.target, pin.path)
          if (now !== pin.sha) {
            const moved = `the pin ${pin.path} moved from ${pin.sha.slice(0, 12)} to ${now === undefined ? "no gitlink" : now.slice(0, 12)}; exiting 18 for a relaunch on the new pin`
            log?.info?.(moved, { from: pin.sha, pin: pin.path, to: now })
            emit(io, options.json, { exitCode: 18, from: pin.sha, pin: pin.path, to: now }, moved)
            return 18
          }
        }
        if (stopped()) return 0
        await new Promise((resolve) => setTimeout(resolve, interval))
        if (stopped()) return 0
      }
    }
    case "list": {
      const entries = await readQueue(git, config.remote, config.target)
      // The commits the target gained by hand are rows too (E5), judged at the
      // target as the queue read just fetched it, so the rows and the reading
      // are about one and the same tip.
      const targetSha = await refAt(git, `refs/remotes/${config.remote}/${config.target}`)
      if (targetSha === undefined) {
        throw new Error(
          `${config.target} is not here after the queue read: refs/remotes/${config.remote}/${config.target} is absent`,
        )
      }
      const rows = list(entries, { byHand: await byHandCommits(git, config.target, targetSha, entries) })
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
      const worktree = await freshWorktree(git, repo, head, join(workdir, "check", `${head.slice(0, 12)}-${String(globalThis.process.pid)}`), options.log?.child("worktree"))
      const results: CheckResult[] = []
      try {
        for (const spec of specs) {
          const result = await runCheck({ cwd: worktree.path, env: options.env, logDir: join(workdir, "checks", "head"), scratch: join(workdir, "scratch"), spec })
          results.push(result)
          if (result.result !== "pass") break
        }
      } finally {
        await worktree.remove()
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
      const changes = show(await readQueue(git, config.remote, config.target), request.branch)
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
 * The `.yrd.yml` checked out at `start` or the nearest directory above it
 * within the same repository (the walk stops at the directory that holds
 * `.git`, a worktree's file or a repository's directory), with the directory
 * it was found in; undefined when there is none. A file that exists and
 * cannot be read is loud.
 */
function declarationHere(start: string): Readonly<{ root: string; text: string }> | undefined {
  let directory = resolve(start)
  for (;;) {
    try {
      return { root: directory, text: readFileSync(join(directory, ".yrd.yml"), "utf8") }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error
    }
    if (existsSync(join(directory, ".git"))) return undefined
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
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
    owner: config.owner,
    // git-super narrates which submodule it borrowed and how long each phase
    // took; that is trace-level plumbing, so it gets a logger only at trace.
    plumbing: log?.trace === undefined ? undefined : log.child("submodules"),
    remote: config.remote,
    render: renderer(log),
    repo,
    target: config.target,
    workdir: config.scratch === undefined ? workdir : join(config.scratch, "queue-core"),
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
      return `${String(rest.name)} ran for ${where} in ${String(rest.ms)} ms`
    case "result":
      return `${String(rest.name)} ${String(rest.result)} for ${where}${rest.whose === undefined ? "" : `, ${String(rest.whose)}'s`}`
    case "merge":
      return `${where} merged as ${String(rest.commit).slice(0, 12)}`
    case "message":
      return `told ${String(rest.to)} about ${where}`
    case "by-hand": {
      const pins =
        Array.isArray(rest.gitlinks) && rest.gitlinks.length > 0
          ? `; it moved the pin at ${rest.gitlinks.join(", ")}`
          : ""
      return `${String(rest.branch)} moved by hand at ${String(rest.commit).slice(0, 12)} (${String(rest.subject)})${pins}`
    }
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
