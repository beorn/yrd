import { changeDeliveryState, changeRevisionLineage, type PR, type ChangeRev } from "@yrd/bay"
import { raiseFailure } from "@yrd/core"
import type { Process, ProcessResult } from "@yrd/process"
import { cleanGitEnvironment } from "./git-environment.ts"
import { observeFreshRemoteBranch } from "./remote-branch.ts"
import type { YrdCliIO, YrdCliServices } from "./types.ts"

const GIT_TIMEOUT_MS = 30_000
const MAX_COMMIT_ROWS = 20

type RemergeBranchFreshnessOptions = Readonly<{
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

async function freshRemoteBranch(
  process: Pick<Process, "run">,
  cwd: string,
  branch: string,
  remedy: string,
): Promise<string> {
  const observed = await observeFreshRemoteBranch(process, cwd, branch)
  if (!observed.ok && observed.phase === "fetch") {
    raiseFailure(
      "configuration",
      "recut-branch-refresh-failed",
      `yrd: could not refresh live branch '${branch}' from origin: ${observed.detail}\n${remedy}`,
    )
  }
  if (!observed.ok) {
    raiseFailure(
      "configuration",
      "recut-branch-head-missing",
      `yrd: refreshed live branch '${branch}' but '${observed.target}' did not resolve to a commit: ${observed.detail}`,
    )
  }
  return observed.head
}

async function liveBranchHead(
  pr: PR,
  recorded: ChangeRev,
  options: RemergeBranchFreshnessOptions,
  services: Pick<YrdCliServices, "process">,
  io: YrdCliIO,
): Promise<string> {
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
  const queueFlag = options.queue === true ? " --queue" : ""
  const remedy =
    `remedy: request credential-bearing Yrd publication for branch '${pr.branch}' on base '${recorded.base}' ` +
    `at base SHA '${recorded.baseSha ?? "unrecorded"}' and recorded head '${recorded.head}':\n` +
    `  yrd pr publish ${pr.id}${queueFlag}\n` +
    `This records a durable publication Job; without a runner it remains visible as publication-required.\n` +
    `if the publication Job cannot run: escalate to @chief for a credential-bearing publish — this branch is ` +
    `never pushed by hand, not even as an emergency fallback.\n` +
    (options.queue === true ? "" : `then retry:\n  yrd pr recut ${pr.id} --preflight`)
  return freshRemoteBranch(process, cwd, pr.branch, remedy)
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
  const distance = await runGit(process, cwd, ["rev-list", "--left-right", "--count", `${recordedHead}...${liveHead}`])
  if (distance.timedOut || distance.exitCode !== 0) {
    return `commits between: unavailable (${gitFailure(distance)})\ninspect: ${command}`
  }
  const counts = /^(\d+)\s+(\d+)$/u.exec(distance.stdout.trim())
  if (counts === null) {
    return `commits between: unavailable (invalid symmetric distance '${distance.stdout.trim()}')\ninspect: ${command}`
  }
  const recordedOnly = Number(counts[1])
  const liveOnly = Number(counts[2])
  if (recordedOnly > 0 && liveOnly > 0) {
    return (
      `commits divergent: recorded-only=${String(recordedOnly)}, live-only=${String(liveOnly)}\n` +
      `inspect: git log --oneline --left-right ${recordedHead}...${liveHead}`
    )
  }
  if (recordedOnly > 0) {
    return (
      `commits between: live branch is behind the recorded revision by ${String(recordedOnly)} commit(s)\n` +
      `inspect: git log --oneline ${liveHead}..${recordedHead}`
    )
  }
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

async function commitTree(services: Pick<YrdCliServices, "process">, io: YrdCliIO, head: string): Promise<string> {
  const cwd = io.cwd ?? globalThis.process.cwd()
  if (io.pruneGit !== undefined) return io.pruneGit(cwd).treeOf(head)
  const process = services.process
  if (process === undefined) {
    raiseFailure("configuration", "recut-tree-observer-missing", `yrd: cannot compare commit tree '${head}'`)
  }
  const result = await runGit(process, cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${head}^{tree}`])
  const tree = result.stdout.trim()
  if (result.timedOut || result.exitCode !== 0 || tree === "") {
    raiseFailure(
      "configuration",
      "recut-tree-missing",
      `yrd: commit '${head}' did not resolve to a tree: ${gitFailure(result)}`,
    )
  }
  return tree
}

/** Either the recut may proceed on its recorded source, or the PR opted into
 * tracking and its branch moved, so the caller must re-record the live head
 * before continuing. Every other drift already refused inside the check. */
export type RemergeBranchFreshness =
  | Readonly<{ status: "fresh" }>
  | Readonly<{ status: "tracked-drift"; recorded: ChangeRev; liveHead: string }>

/** Manual recut is reproducible: it operates on a recorded immutable source.
 * If the authored branch moved, implicit selection is ambiguous and must stop
 * before Git composition, journal writes, or Queue admission. Explicit
 * `--revision` is the deliberate replay spelling; resident freshness recuts
 * are already bound to admitted authority and bypass this author-facing gate.
 *
 * A TRACKED PR (`yrd pr submit --track`) answered that ambiguity up front: the
 * live head is the intended source. It returns `tracked-drift` so the caller
 * records the new revision — the same operation an operator performs by hand —
 * and continues. Reproducibility is untouched: each run still executes a
 * frozen recorded revision. */
export async function requireImplicitRemergeBranchFreshness(
  pr: PR,
  selected: ChangeRev,
  options: RemergeBranchFreshnessOptions,
  services: Pick<YrdCliServices, "process">,
  io: YrdCliIO,
): Promise<RemergeBranchFreshness> {
  if (options.transition !== undefined) return { status: "fresh" }
  const recorded = changeRevisionLineage(pr, selected.n)[0]
  if (recorded === undefined) {
    throw new Error(`yrd: PR '${pr.id}' revision ${selected.n} has no recorded source lineage`)
  }
  const liveHead = await liveBranchHead(pr, recorded, options, services, io)
  if (liveHead === recorded.head) return { status: "fresh" }
  if (options.revision !== undefined) {
    const [recordedTree, liveTree] = await Promise.all([
      commitTree(services, io, recorded.head),
      commitTree(services, io, liveHead),
    ])
    if (recordedTree === liveTree) return { status: "fresh" }
    raiseFailure(
      "refusal",
      "recut-recorded-tree-mismatch",
      `yrd: PR '${pr.id}' recorded revision ${recorded.n} tree '${recordedTree}' differs from live branch ` +
        `'${pr.branch}' tree '${liveTree}'; --revision cannot replay different content`,
    )
  }
  if (pr.track === true) return { status: "tracked-drift", recorded, liveHead }

  const queueFlag = options.queue === true ? " --queue" : ""
  const recordVerb = changeDeliveryState(pr) === "pushed" ? "create" : "submit"
  raiseFailure(
    "refusal",
    "recut-branch-moved",
    `yrd: PR '${pr.id}' recorded revision ${recorded.n} head '${recorded.head}', but live branch ` +
      `'${pr.branch}' is '${liveHead}'. Recut-by-PR is reproducible and will not silently replay stale work.\n` +
      `${await commitRangeEvidence(services, io, recorded.head, liveHead)}\n` +
      `To record the live head and finish the requested recut:\n  yrd pr ${recordVerb} ${pr.branch}\n` +
      `  yrd pr recut ${pr.id}${queueFlag}\n` +
      `To deliberately replay the recorded revision:\n` +
      `  yrd pr recut ${pr.id} --revision ${recorded.n} --preflight${queueFlag}`,
  )
}
