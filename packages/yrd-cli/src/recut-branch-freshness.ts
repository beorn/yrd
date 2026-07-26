import { prRevisionLineage, type PR, type PRRev } from "@yrd/bay"
import { raiseFailure } from "@yrd/core"
import type { Process, ProcessResult } from "@yrd/process"
import { cleanGitEnvironment } from "./git-environment.ts"
import type { YrdCliIO, YrdCliServices } from "./types.ts"

const GIT_TIMEOUT_MS = 30_000
const MAX_COMMIT_ROWS = 20

type RecutBranchFreshnessOptions = Readonly<{
  revision?: number
  queue?: boolean
  transition?: unknown
}>

async function runGit(process: Pick<Process, "run">, cwd: string, args: readonly string[]): Promise<ProcessResult> {
  return process.run({
    argv: ["git", "-C", cwd, ...args],
    cwd,
    env: cleanGitEnvironment(globalThis.process.env),
    timeoutMs: GIT_TIMEOUT_MS,
  })
}

function gitFailure(result: ProcessResult): string {
  if (result.timedOut) return `timed out after ${GIT_TIMEOUT_MS}ms`
  return result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`
}

async function freshRemoteBranch(process: Pick<Process, "run">, cwd: string, branch: string): Promise<string> {
  const source = `refs/heads/${branch}`
  const target = `refs/remotes/origin/${branch}`
  const fetched = await runGit(process, cwd, ["fetch", "--quiet", "--no-tags", "origin", `+${source}:${target}`])
  if (fetched.timedOut || fetched.exitCode !== 0) {
    raiseFailure(
      "configuration",
      "recut-branch-refresh-failed",
      `yrd: could not refresh live branch '${branch}' from origin: ${gitFailure(fetched)}`,
    )
  }
  const resolved = await runGit(process, cwd, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${target}^{commit}`,
  ])
  const head = resolved.stdout.trim()
  if (resolved.timedOut || resolved.exitCode !== 0 || head === "") {
    raiseFailure(
      "configuration",
      "recut-branch-head-missing",
      `yrd: refreshed live branch '${branch}' but '${target}' did not resolve to a commit: ${gitFailure(resolved)}`,
    )
  }
  return head
}

async function liveBranchHead(pr: PR, services: Pick<YrdCliServices, "process">, io: YrdCliIO): Promise<string> {
  const cwd = io.cwd ?? globalThis.process.cwd()
  if (io.pruneGit !== undefined) {
    const git = io.pruneGit(cwd)
    const head = (await git.resolveCommit(`origin/${pr.branch}`)) ?? (await git.resolveCommit(pr.branch))
    if (head === undefined) {
      raiseFailure(
        "configuration",
        "recut-branch-head-missing",
        `yrd: cannot verify PR '${pr.id}' because neither 'origin/${pr.branch}' nor '${pr.branch}' resolves to a commit`,
      )
    }
    return head
  }
  const process = services.process
  if (process === undefined) {
    raiseFailure(
      "configuration",
      "recut-branch-observer-missing",
      `yrd: cannot refresh live branch '${pr.branch}' before recutting PR '${pr.id}'; no Git process is installed`,
    )
  }
  return freshRemoteBranch(process, cwd, pr.branch)
}

async function commitRangeEvidence(
  services: Pick<YrdCliServices, "process">,
  io: YrdCliIO,
  recordedHead: string,
  liveHead: string,
): Promise<string> {
  const command = `git log --oneline ${recordedHead}..${liveHead}`
  const process = services.process
  if (process === undefined || io.pruneGit !== undefined) {
    return `commits between: supplied observer did not enumerate the range\ninspect: ${command}`
  }
  const cwd = io.cwd ?? globalThis.process.cwd()
  const result = await runGit(process, cwd, [
    "log",
    "--reverse",
    `--max-count=${String(MAX_COMMIT_ROWS)}`,
    "--format=%H %s",
    `${recordedHead}..${liveHead}`,
    "--",
  ])
  if (result.timedOut || result.exitCode !== 0) {
    return `commits between: unavailable (${gitFailure(result)})\ninspect: ${command}`
  }
  const rows = result.stdout.trim()
  return rows === ""
    ? `commits between: none reported by the refreshed observer\ninspect: ${command}`
    : `commits between:\n${rows
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n")}\ninspect: ${command}`
}

/** Manual recut is reproducible: it operates on a recorded immutable source.
 * If the authored branch moved, implicit selection is ambiguous and must stop
 * before Git composition, journal writes, or Queue admission. Explicit
 * `--revision` is the deliberate replay spelling; resident freshness recuts
 * are already bound to admitted authority and bypass this author-facing gate. */
export async function requireImplicitRecutBranchFreshness(
  pr: PR,
  selected: PRRev,
  options: RecutBranchFreshnessOptions,
  services: Pick<YrdCliServices, "process">,
  io: YrdCliIO,
): Promise<void> {
  if (options.revision !== undefined || options.transition !== undefined) return
  const recorded = prRevisionLineage(pr, selected.n)[0]
  if (recorded === undefined) {
    throw new Error(`yrd: PR '${pr.id}' revision ${selected.n} has no recorded source lineage`)
  }
  const liveHead = await liveBranchHead(pr, services, io)
  if (liveHead === recorded.head) return

  const queueFlag = options.queue === true ? " --queue" : ""
  raiseFailure(
    "refusal",
    "recut-branch-moved",
    `yrd: PR '${pr.id}' recorded revision ${recorded.n} head '${recorded.head}', but live branch ` +
      `'${pr.branch}' is '${liveHead}'. Recut-by-PR is reproducible and will not silently replay stale work.\n` +
      `${await commitRangeEvidence(services, io, recorded.head, liveHead)}\n` +
      `To submit the live head for fresh review:\n  yrd pr submit ${pr.branch}\n` +
      `  yrd pr recut ${pr.id} --preflight${queueFlag}\n` +
      `To deliberately replay the recorded revision:\n` +
      `  yrd pr recut ${pr.id} --revision ${recorded.n} --preflight${queueFlag}`,
  )
}
