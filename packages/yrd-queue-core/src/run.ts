/**
 * One queue run ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design,
 * The queue run and Attribution).
 *
 * Read the checks from the target. For every queued change, oldest first: a
 * fresh worktree of the head and the on-submit checks; pass writes checked,
 * fail writes failed and tells the submitter, stuck writes stuck and stops the
 * run. Then the first checked change in line: the target plus its head in a
 * worktree (a conflict is a fail, the submitter's), the on-merge checks, and
 * for a failing check the same check again and at the target; pass with the
 * target still at the checked base and the branch still at the head
 * fast-forwards the target to the merge commit. Every ended change sends one
 * message, after its ended fact is written, with that fact's sha as the id.
 *
 * Exit 0 when nothing ended failed or stuck, 1 when a change ended failed,
 * 2 on stuck. A stuck change stays open and the run stops there: the queue
 * could not do its own job, and the next thing to happen is a person.
 */

import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { createProcess, shellCommand, type Process } from "@yrd/process"
import { runCheck, type CheckResult, type CheckSpec } from "./check.ts"
import { appendFact, readFacts, type Fact, type Git } from "./facts.ts"
import { gitIn, isAncestor } from "./git.ts"
import { openLog, type QueueRunLog } from "./log.ts"
import { changeRef } from "./refs.ts"
import { lane, type LaneEntry } from "./remote.ts"
import { inLine } from "./state.ts"
import { freshWorktree } from "./worktree.ts"

export type QueueCheck = CheckSpec & Readonly<{ on?: readonly ("submit" | "merge")[] }>

export type QueueRunOptions = Readonly<{
  /** The working repository the run reads and writes through. */
  repo: string
  /** The queue's remote, where branches and changes live. */
  remote: string
  /** The branch the queue lands on. */
  target: string
  /** The checks the target declares, read from the target commit by the caller. A check with no `on` runs at merge. */
  checks: readonly QueueCheck[]
  /** The blob the checks were read from, recorded on every checked fact. */
  configBlob: string
  /** The command that delivers one message, a JSON record on stdin. Absent, messages are logged and not sent. */
  notify?: string
  /** Who hears about a stuck change. */
  owner: string
  /** Where logs, worktrees and scratch live; on the root filesystem. */
  workdir: string
  git?: Git
  process?: Process
  env?: NodeJS.ProcessEnv
}>

export type QueueRunOutcome = Readonly<{
  exitCode: 0 | 1 | 2
  log: string
  run: string
  /** The target after the run. */
  target: string
  merged: readonly string[]
  failed: readonly string[]
  stuck: readonly string[]
}>

/** Everything one run's steps share. */
type Run = Readonly<{
  options: QueueRunOptions
  git: Git
  log: QueueRunLog
  scratch: string
  worktrees: string
  /** The target the run read at its start; every judgement is against it. */
  targetSha: string
}>

type Ended = "checked" | "failed" | "stuck" | "merged"

export async function queueRun(options: QueueRunOptions): Promise<QueueRunOutcome> {
  const git = options.git ?? gitIn(options.repo, options.process)
  const log = openLog(join(options.workdir, "logs"))
  const targetSha = await targetAt(git, options.remote, options.target)
  const run: Run = {
    git,
    log,
    options,
    scratch: join(options.workdir, "scratch"),
    targetSha,
    worktrees: join(options.workdir, "worktrees", log.id),
  }
  mkdirSync(run.worktrees, { recursive: true })
  const merged: string[] = []
  const failed: string[] = []
  const stuck: string[] = []

  const entries = await lane(git, options.remote, options.target)
  log.write({ checks: options.checks.map((check) => check.name), config: options.configBlob, kind: "run", target: options.target, targetSha })
  for (const entry of entries) {
    log.write({ branch: entry.branch, head: entry.change.head, kind: "change", reason: entry.reading.reason, state: entry.reading.state })
  }

  // On-submit: every queued change, oldest first, in a fresh worktree of its head.
  for (const entry of ordered(entries, "queued")) {
    const outcome = await judge(run, entry)
    if (outcome === "stuck") {
      stuck.push(entry.branch)
      return finish(run, 2, { failed, merged, stuck })
    }
    if (outcome === "failed") failed.push(entry.branch)
  }

  // On-merge: the first checked change in line, re-read so this run's own
  // checked facts count.
  const checked = ordered(await lane(git, options.remote, options.target), "checked")[0]
  if (checked !== undefined) {
    const outcome = await land(run, checked)
    if (outcome === "stuck") stuck.push(checked.branch)
    else if (outcome === "failed") failed.push(checked.branch)
    else if (outcome === "merged") merged.push(checked.branch)
  }

  return finish(run, stuck.length > 0 ? 2 : failed.length > 0 ? 1 : 0, { failed, merged, stuck })
}

/** The entries in one state, in line order. */
function ordered(entries: readonly LaneEntry[], state: "queued" | "checked"): readonly LaneEntry[] {
  const byHead = new Map(entries.map((entry) => [entry.change.head, entry]))
  return inLine(entries.map((entry) => entry.change))
    .map((change) => byHead.get(change.head))
    .filter((entry): entry is LaneEntry => entry !== undefined && entry.reading.state === state)
}

/** The on-submit phase for one queued change. */
async function judge(run: Run, entry: LaneEntry): Promise<Ended> {
  const { branch, change } = entry
  const head = change.head
  // The built-in check: the head descends from the target, or a merge could
  // rewrite history the target already carries.
  if (!(await isAncestor(run.git, run.targetSha, head))) {
    return end(run, entry, "failed", {
      remedy: `rebase ${branch} onto ${run.options.target} and submit again`,
      subject: `${branch} does not descend from ${run.options.target}`,
      trailers: [["Reason", "not-descending"], ["Attribution", "submitter"]],
    })
  }
  const worktree = await freshWorktree(run.git, run.options.repo, head, join(run.worktrees, "submit", head.slice(0, 12)))
  try {
    const results = await runPhase(run, entry, "submit", worktree.path)
    const stuckOne = results.find((result) => result.result === "stuck")
    if (stuckOne !== undefined) {
      return end(run, entry, "stuck", {
        subject: `the queue could not judge ${branch}: ${stuckOne.name} ${stuckOne.why ?? ""}`.trim(),
        trailers: [["Why", stuckOne.why ?? stuckOne.name], ...checkTrailers(results)],
      })
    }
    const failedOne = results.find((result) => result.result === "fail")
    if (failedOne !== undefined) {
      return end(run, entry, "failed", {
        remedy: `fix ${failedOne.name} (log: ${failedOne.log}), push, and submit again`,
        subject: `${branch} failed ${failedOne.name}`,
        trailers: [["Reason", failedOne.name], ["Attribution", "submitter"], ...checkTrailers(results)],
      })
    }
    await appendFact(run.git, {
      branch,
      head,
      kind: "checked",
      subject: `${branch} passed the on-submit checks at ${run.options.target} ${run.targetSha.slice(0, 12)}`,
      trailers: [["Config", run.options.configBlob], ["Base", run.targetSha], ...checkTrailers(results)],
    })
    await pushChange(run, branch, head)
    return "checked"
  } finally {
    await worktree.remove()
  }
}

/** The on-merge phase for the first checked change. */
async function land(run: Run, entry: LaneEntry): Promise<Ended> {
  const { branch, change } = entry
  const head = change.head
  const worktree = await freshWorktree(run.git, run.options.repo, run.targetSha, join(run.worktrees, "merge", head.slice(0, 12)))
  try {
    const wt = gitIn(worktree.path, run.options.process)
    let mergeCommit: string
    try {
      await wt(["merge", "--quiet", "--no-ff", "--no-edit", "-m", `yrd: merge ${branch} at ${head.slice(0, 12)}`, head])
      mergeCommit = (await wt(["rev-parse", "HEAD"])).trim()
    } catch (error) {
      // A conflict is the submitter's: the branch does not fit the target. The
      // worktree is thrown away whole, so nothing needs aborting.
      return end(run, entry, "failed", {
        remedy: `rebase ${branch} onto ${run.options.target}, resolve the conflict, push, and submit again`,
        subject: `${branch} conflicts with ${run.options.target}`,
        trailers: [["Reason", "conflict"], ["Attribution", "submitter"], ["Detail", String(error).slice(0, 200)]],
      })
    }
    const results = await runPhase(run, entry, "merge", worktree.path)
    const stuckOne = results.find((result) => result.result === "stuck")
    if (stuckOne !== undefined) {
      return end(run, entry, "stuck", {
        subject: `the queue could not judge ${branch} at merge: ${stuckOne.name} ${stuckOne.why ?? ""}`.trim(),
        trailers: [["Why", stuckOne.why ?? stuckOne.name], ...checkTrailers(results)],
      })
    }
    const failing = results.filter((result) => result.result === "fail")
    if (failing.length > 0) {
      const verdict = await attribute(run, entry, failing, worktree.path)
      if (verdict.result === "stuck") {
        return end(run, entry, "stuck", {
          subject: `${branch}: ${verdict.why}`,
          trailers: [["Why", verdict.why], ["Attribution", verdict.kind], ...checkTrailers(results)],
        })
      }
      return end(run, entry, "failed", {
        remedy: `fix ${failing[0]?.name ?? "the check"} (log: ${failing[0]?.log ?? ""}), push, and submit again`,
        subject: `${branch} failed ${failing.map((result) => result.name).join(", ")} at merge`,
        trailers: [["Reason", failing[0]?.name ?? "check"], ["Attribution", "submitter"], ...checkTrailers(results)],
      })
    }
    // Pass. The merge is ours to make only while the target is still where this
    // change was checked against and the branch still at the head; otherwise the
    // change keeps its place and is checked again at the new target next run.
    const remoteNow = await remoteHeads(run, branch)
    if (remoteNow.target !== run.targetSha || remoteNow.branch !== head) {
      run.log.write({ branch, head, kind: "change", reason: remoteNow.target !== run.targetSha ? "target-moved" : "branch-moved", state: "checked" })
      return "checked"
    }
    await run.git(["fetch", "--quiet", worktree.path, mergeCommit])
    const mergedFact = await appendFact(run.git, {
      branch,
      head,
      kind: "merged",
      subject: `${branch} merged into ${run.options.target} as ${mergeCommit.slice(0, 12)}`,
      trailers: [["Merge", mergeCommit], ["Base", run.targetSha], ...checkTrailers(results)],
    })
    const ref = changeRef(branch, head)
    await run.git([
      "push",
      "--quiet",
      "--atomic",
      `--force-with-lease=refs/heads/${run.options.target}:${run.targetSha}`,
      run.options.remote,
      `${mergeCommit}:refs/heads/${run.options.target}`,
      `${ref}:${ref}`,
    ])
    run.log.write({ branch, head, kind: "merge", merge: mergeCommit })
    await send(run, entry, mergedFact, "merged", `close your bead: ${branch} at ${head.slice(0, 12)} merged as ${mergeCommit.slice(0, 12)}`)
    return "merged"
  } finally {
    await worktree.remove()
  }
}

/**
 * A failing check is the submitter's only if it fails again in the change's
 * worktree and does not fail at the target on the same check; otherwise the
 * change ends stuck, the queue's. Nobody is billed for a coin flip or for a
 * red target.
 */
async function attribute(
  run: Run,
  entry: LaneEntry,
  failing: readonly CheckResult[],
  mergeWorktree: string,
): Promise<Readonly<{ result: "fail" | "stuck"; kind: string; why: string }>> {
  for (const first of failing) {
    const spec = run.options.checks.find((check) => check.name === first.name)
    if (spec === undefined) return { kind: "no-evidence", result: "stuck", why: `${first.name} is not a declared check` }
    const again = await check(run, entry, spec, mergeWorktree, "again")
    if (again.result !== "fail") {
      return { kind: "flake", result: "stuck", why: `${first.name} failed once and passed once in the change's worktree; the queue does not merge on a coin flip; fix or remove the test` }
    }
    const targetTree = await freshWorktree(run.git, run.options.repo, run.targetSha, join(run.worktrees, "target", first.name))
    try {
      const atTarget = await check(run, entry, spec, targetTree.path, "target")
      if (atTarget.result !== "pass") {
        return { kind: "inherited", result: "stuck", why: `${first.name} fails at the target ${run.targetSha.slice(0, 12)} too; the target is red, not the change; fix the target first, then the queue resumes` }
      }
    } finally {
      await targetTree.remove()
    }
  }
  return { kind: "submitter", result: "fail", why: "" }
}

async function runPhase(run: Run, entry: LaneEntry, phase: "submit" | "merge", cwd: string): Promise<readonly CheckResult[]> {
  const results: CheckResult[] = []
  for (const spec of run.options.checks.filter((candidate) => (candidate.on ?? ["merge"]).includes(phase))) {
    results.push(await check(run, entry, spec, cwd, phase))
    if (results.at(-1)?.result !== "pass") break
  }
  return results
}

async function check(run: Run, entry: LaneEntry, spec: CheckSpec, cwd: string, phase: string): Promise<CheckResult> {
  run.log.write({ branch: entry.branch, check: spec.name, head: entry.change.head, kind: "check", phase })
  const result = await runCheck({
    cwd,
    env: run.options.env,
    logDir: join(run.options.workdir, "checks", run.log.id, phase),
    process: run.options.process,
    scratch: run.scratch,
    spec,
  })
  run.log.write({ branch: entry.branch, check: spec.name, durationMs: result.durationMs, exit: String(result.exit), head: entry.change.head, kind: "result", log: result.log, phase, result: result.result })
  return result
}

async function end(
  run: Run,
  entry: LaneEntry,
  kind: "failed" | "stuck",
  ended: Readonly<{ subject: string; trailers: readonly (readonly [string, string])[]; remedy?: string }>,
): Promise<Ended> {
  const trailers = ended.remedy === undefined ? ended.trailers : [...ended.trailers, ["Remedy", ended.remedy] as const]
  const fact = await appendFact(run.git, { branch: entry.branch, head: entry.change.head, kind, subject: ended.subject, trailers })
  await pushChange(run, entry.branch, entry.change.head)
  run.log.write({ branch: entry.branch, head: entry.change.head, kind: "change", reason: ended.subject, state: kind })
  const text =
    kind === "stuck"
      ? `yrd broken: ${ended.subject}; the queue stays down until a person fixes it`
      : `send it back: ${ended.subject}; ${ended.remedy ?? ""}`.trim()
  await send(run, entry, fact, kind, text)
  return kind
}

/** One message per ended change, after its ended fact; the fact's sha is the id. */
async function send(run: Run, entry: LaneEntry, endedFact: string, kind: "merged" | "failed" | "stuck", text: string): Promise<void> {
  const facts = await readFacts(run.git, entry.branch, entry.change.head)
  const opened = facts.find((fact) => fact.kind === "opened")
  const ended = [...facts].reverse().find((fact) => fact.sha === endedFact)
  const recipient = kind === "stuck" ? run.options.owner : (trailerOf(opened, "Submitter") ?? run.options.owner)
  // The record the configured notifier reads, unchanged from today's contract
  // (kind, attempt_id, pr, recipient, command required; the rest optional): the
  // plan's three messages map onto its three kinds, the branch stands where a
  // PR number stood, and the ended fact's sha is the attempt id, so a resend
  // after a crash is the same message.
  const record = {
    attempt_id: endedFact,
    base: run.options.target,
    branch: entry.branch,
    code: kind === "merged" ? undefined : (trailerOf(ended, "Reason") ?? trailerOf(ended, "Why")),
    command: text,
    disposition: kind === "failed" ? "author" : undefined,
    head: entry.change.head,
    id: endedFact,
    kind: kind === "merged" ? "landed" : kind === "failed" ? "send-back" : "yrd-broken",
    pr: entry.branch,
    recipient,
    sha: entry.change.head,
    text,
    workItem: trailerOf(opened, "Work-Item"),
  }
  if (run.options.notify !== undefined) {
    const runner = run.options.process ?? createProcess({ cwd: run.options.repo })
    const result = await runner.run({ argv: shellCommand(run.options.notify), cwd: run.options.repo, env: run.options.env, stdin: `${JSON.stringify(record)}\n`, timeoutMs: 60_000 })
    if (result.exitCode !== 0) throw new Error(`the notifier exited ${result.exitCode} for ${entry.branch}: ${result.stderr.trim()}`)
  }
  await appendFact(run.git, {
    branch: entry.branch,
    head: entry.change.head,
    kind: "sent",
    subject: `told ${recipient}: ${text}`.slice(0, 200),
    trailers: [["Message-Id", endedFact], ["Recipient", recipient]],
  })
  await pushChange(run, entry.branch, entry.change.head)
  run.log.write({ branch: entry.branch, head: entry.change.head, id: endedFact, kind: "message", recipient })
}

function checkTrailers(results: readonly CheckResult[]): readonly (readonly [string, string])[] {
  return results.map((result) => ["Check", `${result.name} exit=${result.exit} ms=${result.durationMs} log=${result.log}`] as const)
}

async function pushChange(run: Run, branch: string, head: string): Promise<void> {
  const ref = changeRef(branch, head)
  await run.git(["push", "--quiet", run.options.remote, `${ref}:${ref}`])
}

/** Where the target and one branch stand at the remote right now. */
async function remoteHeads(run: Run, branch: string): Promise<Readonly<{ target?: string; branch?: string }>> {
  const rows = (await run.git(["ls-remote", "--refs", run.options.remote, `refs/heads/${run.options.target}`, `refs/heads/${branch}`])).split("\n")
  const at = new Map(rows.map((row) => row.trim().split(/\s+/u)).map(([sha, ref]) => [ref ?? "", sha ?? ""]))
  return { branch: at.get(`refs/heads/${branch}`), target: at.get(`refs/heads/${run.options.target}`) }
}

async function targetAt(git: Git, remote: string, target: string): Promise<string> {
  const sha = (await git(["ls-remote", "--refs", remote, `refs/heads/${target}`])).trim().split(/\s+/u)[0]
  if (sha === undefined || sha === "") throw new Error(`the target ${target} is not at ${remote}`)
  await git(["fetch", "--quiet", remote, `+refs/heads/${target}:refs/remotes/${remote}/${target}`])
  return sha
}

function trailerOf(fact: Fact | undefined, name: string): string | undefined {
  return fact?.trailers.find(([key]) => key === name)?.[1]
}

function finish(run: Run, exitCode: 0 | 1 | 2, lists: Readonly<{ merged: string[]; failed: string[]; stuck: string[] }>): QueueRunOutcome {
  return { exitCode, log: run.log.path, run: run.log.id, target: run.targetSha, ...lists }
}
