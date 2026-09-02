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
import {
  gitIn,
  lane,
  list,
  queueRun,
  readConfig,
  show,
  submit,
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

/**
 * Run one queue command on the new core, or return undefined when the
 * repository's declaration does not select it.
 */
export async function coreQueueCommand(
  repo: string,
  io: YrdCliIO,
  request: CoreQueueCommand,
  options: Readonly<{ json?: boolean; env?: NodeJS.ProcessEnv; workdir?: string }> = {},
): Promise<YrdCliExitCode | undefined> {
  const git = gitIn(repo)
  const declared = await readConfig(git, "HEAD")
  if (declared === undefined) return undefined
  // The target's own declaration is the authority for every judgement; HEAD's
  // only says which remote and target to ask.
  await git(["fetch", "--quiet", declared.remote, `+refs/heads/${declared.target}:refs/remotes/${declared.remote}/${declared.target}`])
  const config = (await readConfig(git, `${declared.remote}/${declared.target}`)) ?? declared
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
        workItem: request.workItem,
      })
      emit(io, options.json, submitted, `${submitted.retry ? "retried" : "submitted"} ${branch} at ${submitted.head.slice(0, 12)} to ${config.target}`)
      return 0
    }
    case "run": {
      const outcome = await queueRun(runOptions(repo, config, workdir, options.env))
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
        const outcome = await queueRun(runOptions(repo, config, workdir, options.env))
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

function runOptions(repo: string, config: QueueConfig, workdir: string, env?: NodeJS.ProcessEnv) {
  return {
    checks: config.checks,
    configBlob: config.blob,
    env,
    notify: config.notify,
    owner: config.owner,
    remote: config.remote,
    repo,
    target: config.target,
    workdir: config.scratch === undefined ? workdir : join(config.scratch, "queue-core"),
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
