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

import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { createLogger, type ConditionalLogger } from "loggily"
import {
  gitIn,
  lane,
  list,
  queueRun,
  readConfig,
  readHints,
  remoteNames,
  resolveRemote,
  runCheck,
  show,
  submit,
  type CheckResult,
  type LogRecord,
  type QueueConfig,
  type Row,
} from "@yrd/queue-core"
import type { YrdCliExitCode, YrdCliIO } from "./types.ts"

export type CoreQueueCommand =
  | Readonly<{ command: "submit"; branch?: string; submitter: string; workItem?: string }>
  | Readonly<{ command: "run" }>
  | Readonly<{ command: "up"; intervalSeconds?: number; stop?: AbortSignal }>
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
  const git = gitIn(repo)
  // The submitter's own commit only hints where the queue is (`remote:`,
  // `target:`); the target's declaration is the authority for every judgement,
  // and for whether this core runs at all: it does when the target names
  // `remote:`. A branch that rewrote or broke its own `.yrd.yml` is judged by
  // the target's rules all the same (ruling D2 bills it at merge).
  const hints = await readHints(git, "HEAD")
  if (hints.problem !== undefined) options.log?.child("queue").debug?.(`${hints.problem}; asking the target`)
  const hinted =
    hints.remote === undefined ? ((await remoteNames(git)).includes("origin") ? "origin" : undefined) : await resolveRemote(git, hints.remote)
  if (hinted === undefined) return undefined
  const hintedTarget = hints.target ?? "main"
  await git(["fetch", "--quiet", hinted, `+refs/heads/${hintedTarget}:refs/remotes/${hinted}/${hintedTarget}`])
  const declared = await readConfig(git, `${hinted}/${hintedTarget}`)
  if (declared === undefined || !declared.declaresRemote) return undefined
  const config: QueueConfig = { ...declared, remote: await resolveRemote(git, declared.remote) }
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
      const outcome = await queueRun(runOptions(repo, config, workdir, options.env, options.log))
      emit(io, options.json, outcome, describeRun(outcome))
      return outcome.exitCode
    }
    case "up": {
      // The service: the same round on a loop. Exit 2 when a round is stuck,
      // because the queue stays down until a person fixes it; a signal ends it.
      const interval = (request.intervalSeconds ?? 15) * 1000
      // Read through a call each time: the signal flips while the loop runs.
      const stopped = (): boolean => request.stop?.aborted === true
      for (;;) {
        const outcome = await queueRun(runOptions(repo, config, workdir, options.env, options.log))
        emit(io, options.json, outcome, describeRun(outcome))
        if (outcome.exitCode === 2) return 2
        if (stopped()) return 0
        await new Promise((resolve) => setTimeout(resolve, interval))
        if (stopped()) return 0
      }
    }
    case "list": {
      const rows = list(await lane(git, config.remote, config.target))
      emit(io, options.json, { changes: rows }, table(rows))
      return 0
    }
    case "check": {
      // `yrd check <name>`: the named checks as the target declares them, run
      // here in this tree, in the queue's order and stopping where the queue
      // would stop. The exit is the result: 0 pass, 1 fail, 2 stuck.
      const results: CheckResult[] = []
      for (const name of request.names) {
        const spec = config.checks.find((check) => check.name === name)
        if (spec === undefined) {
          throw new Error(`${name} is not a check the target declares (declared: ${config.checks.map((check) => check.name).join(", ") || "none"})`)
        }
        const result = await runCheck({ cwd: repo, env: options.env, logDir: join(workdir, "checks", "here"), scratch: join(workdir, "scratch"), spec })
        results.push(result)
        if (result.result !== "pass") break
      }
      emit(
        io,
        options.json,
        { checks: results, command: "check" },
        results.map((result) => `${result.name} ${result.result} exit=${String(result.exit)} ${String(result.durationMs)} ms (log ${result.log})${result.why === undefined ? "" : `: ${result.why}`}`).join("\n"),
      )
      return results.some((result) => result.result === "stuck") ? 2 : results.some((result) => result.result === "fail") ? 1 : 0
    }
    case "show": {
      const changes = show(await lane(git, config.remote, config.target), request.branch)
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

function runOptions(repo: string, config: QueueConfig, workdir: string, env?: NodeJS.ProcessEnv, log?: ConditionalLogger) {
  return {
    checks: config.checks,
    configBlob: config.blob,
    env,
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
 * never a second format and never a second reading of the environment. The
 * app's logger carries that level; a fresh logger would read only the process
 * environment, which is not what the invocation asked for.
 */
function renderer(root: ConditionalLogger | undefined): (record: LogRecord) => void {
  const base = root?.child("queue") ?? createLogger("yrd:queue")
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
    default:
      return kind
  }
}

function describeRun(outcome: Readonly<{ exitCode: number; merged: readonly string[]; failed: readonly string[]; stuck: readonly string[]; log: string }>): string {
  const words = ["pass", "fail", "stuck"][outcome.exitCode] ?? String(outcome.exitCode)
  const parts = [
    outcome.merged.length > 0 ? `merged ${outcome.merged.join(", ")}` : undefined,
    outcome.failed.length > 0 ? `failed ${outcome.failed.join(", ")}` : undefined,
    outcome.stuck.length > 0 ? `stuck ${outcome.stuck.join(", ")}` : undefined,
  ].filter((part): part is string => part !== undefined)
  return `${words}: ${parts.length === 0 ? "nothing to do" : parts.join("; ")} (log ${outcome.log})`
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
