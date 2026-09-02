/**
 * The queue-run boundary: scratch repositories, a fake check whose result and
 * duration the test chooses, and one `yrd queue run --once`.
 *
 * Everything here is black box on purpose. A test built on this fixture may
 * look at the queue run's exit code, at the refs the repositories carry
 * afterwards, at the tip of the target, and at where the CLI says each change
 * stands — nothing else. No journal reads, no internals, no log parsing
 * except to print on failure.
 *
 * The scratch-repository shape is the one `packages/yrd-cli/tests/
 * bay-submit-selected.test.ts` proves end to end: a bare shared repository
 * plus a working repository whose `origin` is that bare one, work committed
 * in a real Bay, and `yrd bay submit` as the submit form. The target the
 * queue lands on is the shared repository's `main`, never the local ref, so
 * every assertion about the target reads `origin/main`.
 */
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runYrdProcess } from "../../packages/yrd-cli/src/host.ts"
import type { YrdCliExitCode, YrdCliIO } from "../../packages/yrd-cli/src/types.ts"
import { installDeclaredYrdEntry } from "../../packages/yrd-cli/tests/support/declared-yrd-entry.ts"

/** The check the fixture configures. Absolute, because it runs from a
 * workspace checkout of a scratch repository, not from this directory. */
export const FAKE_CHECK = join(import.meta.dirname, "fake-check.sh")

const roots: string[] = []

/** Every scratch root this file handed out, removed. Call from `afterEach`. */
export async function removeScratchRoots(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} exited ${String(exitCode)}: ${stderr || stdout}`)
  return stdout.trim()
}

/** What the fake check should do when the queue runs it. */
export type FakeCheckPlan = Readonly<{
  /** Status the check exits with. Default 0. */
  exit?: number
  /** Seconds the check sleeps before exiting. Default 0. */
  sleepSeconds?: number
  /** The bound the queue gives the check, when the case is about running past one. */
  timeoutMs?: number
  /** Run this instead of the fake check — for the case where the check is not there. */
  command?: string
  /** Declare a notifier, so the messages the queue run sends have somewhere to go.
   * Default off, so every case that predates this knob writes the same
   * `.yrd.yml` it always did. On, the target declares a notifier that appends
   * each message to `notifyLog` and answers with a ball id. */
  notify?: boolean
}>

/** The `run:` string for a plan: the knobs travel as environment assignments
 * on the command itself, because a check runs through `sh -c`. Two tests in
 * one file therefore never share process state. */
function fakeCheckCommand(plan: FakeCheckPlan, log: string): string {
  return [
    `FAKE_CHECK_EXIT=${String(plan.exit ?? 0)}`,
    `FAKE_CHECK_SLEEP=${String(plan.sleepSeconds ?? 0)}`,
    `FAKE_CHECK_LOG=${log}`,
    plan.command ?? FAKE_CHECK,
  ].join(" ")
}

/** The check as `.yrd.yml` declares it, bound included when the case sets one. */
function checkStep(plan: FakeCheckPlan, log: string): string {
  const run = `run: ${JSON.stringify(fakeCheckCommand(plan, log))}`
  const bound = plan.timeoutMs === undefined ? "" : `, timeoutMs: ${String(plan.timeoutMs)}`
  return `checks: [{check: {${run}${bound}}}]`
}

/** The `notify:` line for a plan, or nothing when the case did not ask for one.
 * The notifier is what `.yrd.yml` documents: a command that reads the message
 * as JSON on stdin and answers with a ball id. This one keeps the message so a
 * test can count what was sent, and to whom. */
function notifyStep(plan: FakeCheckPlan, log: string): string {
  if (plan.notify !== true) return ""
  const command = `cat >>${log}; echo '{"ball_id":"b1"}'`
  return `notify: ${JSON.stringify(command)}\n`
}

export type BoundaryRepository = Readonly<{
  /** The working repository the queue runs against. */
  repo: string
  /** The bare repository `repo`'s `origin` names — where the target lives. */
  origin: string
  /** One line per fake-check execution. */
  checkLog: string
  /** One line per message the notifier was handed, when `notify` was asked for. */
  notifyLog: string
}>

/**
 * A scratch repository whose only check is the fake check, on a fresh bare
 * repository holding one commit of `main`.
 */
export async function boundaryRepository(plan: FakeCheckPlan): Promise<BoundaryRepository> {
  const root = await mkdtemp(join(tmpdir(), "yrd-boundary-"))
  roots.push(root)
  const repoPath = join(root, "repo")
  const origin = join(root, "origin.git")
  const checkLog = join(root, "fake-check.log")
  const notifyLog = join(root, "notify.log")

  await git(root, "init", "-q", "--bare", origin)
  await git(root, "init", "-q", "-b", "main", repoPath)
  const repo = await realpath(repoPath)
  await git(repo, "config", "user.name", "Yrd Boundary")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await git(repo, "remote", "add", "origin", origin)
  await installDeclaredYrdEntry(repo)
  await writeFile(join(repo, "README.md"), "main\n")
  await writeFile(
    join(repo, ".yrd.yml"),
    `base: main\nbatch: 1\n${notifyStep(plan, notifyLog)}${checkStep(plan, checkLog)}\n`,
  )
  await git(repo, "add", "README.md", ".yrd.yml", "bin/yrd")
  await git(repo, "commit", "-qm", "main")
  await git(repo, "push", "-q", "-u", "origin", "main")
  return { repo, origin, checkLog, notifyLog }
}

/** A branch at one head, submitted to the queue. */
export type Change = Readonly<{
  /** The branch the Bay opened, `task/<bay>`. */
  branch: string
  /** The head this change is the branch at — one commit on top of the target. */
  headSha: string
  /** The id the CLI gave it. */
  id: string
}>

/**
 * One commit on top of the target, submitted the way the queue wants it:
 * committed inside a real Bay and delivered with `yrd bay submit` from that
 * Bay. The Bay's own commit needs no `Change-Id` trailer — `bay submit`
 * records the change, and the trailer is only what a recordless `refs/for`
 * tip must carry.
 */
export async function submitOneCommit(repo: string, bay: string): Promise<Change> {
  const opened = capture(repo)
  expectZero(await yrd(repo, opened.io, "bay", "open", "--bay", bay), "bay open", opened)
  const bayPath = opened.stdout().trim()
  const branch = await git(bayPath, "branch", "--show-current")

  await writeFile(join(bayPath, `${bay}.txt`), `${bay}\n`)
  await git(bayPath, "add", `${bay}.txt`)
  await git(bayPath, "commit", "-qm", `${bay}: one commit`)
  const headSha = await git(bayPath, "rev-parse", "HEAD")

  // Standing IN the Bay, exactly as an author does.
  const submitted = capture(bayPath)
  expectZero(await yrd(repo, submitted.io, "bay", "submit", "--json"), "bay submit", submitted)
  const parsed = JSON.parse(submitted.stdout()) as {
    prs: readonly { id: string; branch: string; status: string }[]
  }
  const id = parsed.prs[0]?.id
  if (id === undefined || parsed.prs[0]?.branch !== branch) {
    throw new Error(`bay submit did not record ${branch}: ${submitted.stdout()}`)
  }
  return { branch, headSha, id }
}

export type QueueRunResult = Readonly<{
  exitCode: number
  stdout: string
  stderr: string
  /** Everything a failing assertion should print, as one blob. */
  report: string
}>

/** One `yrd queue run --once`, end to end. */
export async function queueRunOnce(repo: string): Promise<QueueRunResult> {
  const run = capture(repo)
  const exitCode = await yrd(repo, run.io, "queue", "run", "--json")
  return {
    exitCode,
    stdout: run.stdout(),
    stderr: run.stderr(),
    report: `queue run --once exited ${String(exitCode)}\n--- stdout ---\n${run.stdout()}\n--- stderr ---\n${run.stderr()}`,
  }
}

/**
 * Where each change stands, as the CLI itself reports it — the surface an
 * author reads. Still black box: another process, its own declared JSON, no
 * journal and no internals.
 */
export async function changeStandings(repo: string): Promise<Readonly<Record<string, string>>> {
  const listed = capture(repo)
  expectZero(await yrd(repo, listed.io, "pr", "list", "--json"), "pr list", listed)
  const parsed = JSON.parse(listed.stdout()) as { prs: readonly { id: string; status: string }[] }
  return Object.fromEntries(parsed.prs.map((change) => [change.id, change.status]))
}

/** The tip of the target the queue lands on — the shared one, not the local ref. */
export function targetTip(repo: string): Promise<string> {
  return git(repo, "rev-parse", "origin/main")
}

/** The parents of a commit, oldest first. */
export async function parentsOf(repo: string, sha: string): Promise<readonly string[]> {
  const parents = await git(repo, "log", "-1", "--format=%P", sha)
  return parents === "" ? [] : parents.split(" ")
}

/** How many commits the target advanced along its own first-parent line. */
export async function firstParentDistance(repo: string, from: string, to: string): Promise<number> {
  return Number(await git(repo, "rev-list", "--count", "--first-parent", `${from}..${to}`))
}

/** Every ref the repository carries, as `<sha> <name>` lines. */
export async function refs(repo: string): Promise<readonly string[]> {
  const listed = await git(repo, "for-each-ref", "--format=%(objectname) %(refname)")
  return listed === "" ? [] : listed.split("\n")
}

/** How many times the fake check ran. */
export async function checkAttempts(checkLog: string): Promise<number> {
  const file = Bun.file(checkLog)
  if (!(await file.exists())) return 0
  return (await file.text()).trimEnd().split("\n").filter(Boolean).length
}

function capture(cwd: string): { io: YrdCliIO; stdout(): string; stderr(): string } {
  let stdout = ""
  let stderr = ""
  return {
    io: {
      cwd,
      color: false,
      stdout(text) {
        stdout += text
      },
      stderr(text) {
        stderr += text
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  }
}

function yrd(repo: string, io: YrdCliIO, ...args: string[]): Promise<YrdCliExitCode> {
  return runYrdProcess([process.execPath, "/usr/local/bin/yrd", "--repo", repo, ...args], io)
}

function expectZero(
  exitCode: number,
  what: string,
  output: { stdout(): string; stderr(): string },
): asserts exitCode is 0 {
  if (exitCode !== 0) {
    throw new Error(`${what} exited ${String(exitCode)}\n${output.stderr()}\n${output.stdout()}`)
  }
}

/* ------------------------------------------------------------------ *
 * Additions for the run-and-merge area (§ The queue run).
 *
 * Everything below is new; nothing above it changed, because four units
 * write beside each other on this file. The shapes this area needs and
 * `boundaryRepository` cannot make: a target whose checks the case writes
 * itself (so a check can carry the plan's `on:` phase, or live inside the
 * repository), a second change, a target that moved without the queue, and
 * two branch names at one head.
 * ------------------------------------------------------------------ */

/** One check as the PLAN spells it: a name, a phase and a command. */
export type PhasedCheck = Readonly<{
  name: string
  /** `on: submit` or `on: merge`. Omitted writes no phase at all. */
  on?: "submit" | "merge"
  /** The command, verbatim — the case owns it. */
  run: string
  timeoutMs?: number
}>

export type BoundaryPlan = Readonly<{
  /** The target's checks, in order. */
  checks: readonly PhasedCheck[]
  /** Declare a notifier, as `FakeCheckPlan.notify` does. */
  notify?: boolean
  /** Files committed on the target alongside `README.md` and `.yrd.yml`.
   * A path ending in `.sh` is committed executable. */
  files?: Readonly<Record<string, string>>
}>

/**
 * A check written INTO a repository, so a case can ask what the check could
 * SEE. It records its name, its working directory and every tracked file at
 * that directory, then exits.
 *
 *   PROBE_LOG          file to append one line to (required)
 *   PROBE_NAME         the name to record (default `check`)
 *   PROBE_EXIT         status to exit with (default 0)
 *   PROBE_FAIL_IF_ALL  space-separated paths; exit 1 when all of them exist
 */
export const PROBE_SCRIPT = `#!/bin/sh
set -u
: "\${PROBE_LOG:?probe needs a log}"
files=$(git ls-files 2>/dev/null | tr '\\n' ' ')
printf '%s cwd=%s files=%s\\n' "\${PROBE_NAME:-check}" "$(pwd)" "$files" >>"\${PROBE_LOG}"
if [ -n "\${PROBE_FAIL_IF_ALL:-}" ]; then
  all=1
  for f in \${PROBE_FAIL_IF_ALL}; do
    [ -e "$f" ] || all=0
  done
  if [ "$all" = 1 ]; then exit 1; fi
fi
exit "\${PROBE_EXIT:-0}"
`

/** The `checks:` block for a plan, in `.yrd.yml`'s own YAML. */
function phasedChecks(checks: readonly PhasedCheck[]): string {
  const entries = checks.map((check) => {
    const fields = [`run: ${JSON.stringify(check.run)}`]
    if (check.on !== undefined) fields.push(`on: ${check.on}`)
    if (check.timeoutMs !== undefined) fields.push(`timeoutMs: ${String(check.timeoutMs)}`)
    return `{${check.name}: {${fields.join(", ")}}}`
  })
  return `checks: [${entries.join(", ")}]`
}

/** A scratch repository whose target carries the checks and files the case names. */
export async function boundaryRepositoryWith(plan: BoundaryPlan): Promise<BoundaryRepository> {
  const root = await mkdtemp(join(tmpdir(), "yrd-boundary-"))
  roots.push(root)
  const repoPath = join(root, "repo")
  const origin = join(root, "origin.git")
  const checkLog = join(root, "fake-check.log")
  const notifyLog = join(root, "notify.log")

  await git(root, "init", "-q", "--bare", origin)
  await git(root, "init", "-q", "-b", "main", repoPath)
  const repo = await realpath(repoPath)
  await git(repo, "config", "user.name", "Yrd Boundary")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await git(repo, "remote", "add", "origin", origin)
  await installDeclaredYrdEntry(repo)
  await writeFile(join(repo, "README.md"), "main\n")

  const extra = Object.entries(plan.files ?? {})
  for (const [path, content] of extra) {
    await writeFile(join(repo, path), content, path.endsWith(".sh") ? { mode: 0o755 } : {})
  }

  const notify =
    plan.notify === true ? `notify: ${JSON.stringify(`cat >>${notifyLog}; echo '{"ball_id":"b1"}'`)}\n` : ""
  await writeFile(join(repo, ".yrd.yml"), `base: main\nbatch: 1\n${notify}${phasedChecks(plan.checks)}\n`)

  await git(repo, "add", "README.md", ".yrd.yml", "bin/yrd", ...extra.map(([path]) => path))
  await git(repo, "commit", "-qm", "main")
  await git(repo, "push", "-q", "-u", "origin", "main")
  return { repo, origin, checkLog, notifyLog }
}

/** `submitOneCommit`, but the case chooses what the one commit writes — so
 * two changes can touch one path, or leave a marker a check looks for. */
export async function submitCommitWriting(
  repo: string,
  bay: string,
  files: Readonly<Record<string, string>>,
): Promise<Change> {
  const opened = capture(repo)
  expectZero(await yrd(repo, opened.io, "bay", "open", "--bay", bay), "bay open", opened)
  const bayPath = opened.stdout().trim()
  const branch = await git(bayPath, "branch", "--show-current")

  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(bayPath, path), content, path.endsWith(".sh") ? { mode: 0o755 } : {})
    await git(bayPath, "add", path)
  }
  await git(bayPath, "commit", "-qm", `${bay}: one commit`)
  const headSha = await git(bayPath, "rev-parse", "HEAD")

  const submitted = capture(bayPath)
  expectZero(await yrd(repo, submitted.io, "bay", "submit", "--json"), "bay submit", submitted)
  const parsed = JSON.parse(submitted.stdout()) as { prs: readonly { id: string; branch: string }[] }
  const id = parsed.prs[0]?.id
  if (id === undefined || parsed.prs[0]?.branch !== branch) {
    throw new Error(`bay submit did not record ${branch}: ${submitted.stdout()}`)
  }
  return { branch, headSha, id }
}

/** A second branch name at an existing head: one fast-forward, then a submit.
 * No commit of its own, so the two changes are the same content under two
 * names — the shape that billed a submitter on 2026-09-02. */
export async function submitSameHead(repo: string, bay: string, headSha: string): Promise<Change> {
  const opened = capture(repo)
  expectZero(await yrd(repo, opened.io, "bay", "open", "--bay", bay), "bay open", opened)
  const bayPath = opened.stdout().trim()
  const branch = await git(bayPath, "branch", "--show-current")

  await git(bayPath, "fetch", "-q", "origin")
  await git(bayPath, "merge", "--ff-only", "-q", headSha)

  const submitted = capture(bayPath)
  expectZero(await yrd(repo, submitted.io, "bay", "submit", "--json"), "bay submit", submitted)
  const parsed = JSON.parse(submitted.stdout()) as { prs: readonly { id: string; branch: string }[] }
  const id = parsed.prs[0]?.id
  if (id === undefined) throw new Error(`bay submit did not record ${branch}: ${submitted.stdout()}`)
  return { branch, headSha, id }
}

/** A throwaway clone of the shared repository, for the cases where something
 * OTHER than the queue moves the target. */
async function handClone(origin: string): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), "yrd-boundary-hand-"))
  roots.push(work)
  const clone = join(work, "clone")
  // `--branch main`, because the bare repository was made by `git init --bare`
  // and its HEAD still names the host's default branch, not the target.
  await git(work, "clone", "-q", "--branch", "main", origin, clone)
  await git(clone, "config", "user.name", "Yrd Boundary")
  await git(clone, "config", "user.email", "yrd@example.invalid")
  return clone
}

/** The target moves without the queue: one commit, pushed to `main`. */
export async function advanceTargetByHand(
  origin: string,
  files: Readonly<Record<string, string>>,
  message = "the target moved",
): Promise<string> {
  const clone = await handClone(origin)
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(clone, path), content, path.endsWith(".sh") ? { mode: 0o755 } : {})
    await git(clone, "add", path)
  }
  await git(clone, "commit", "-qm", message)
  await git(clone, "push", "-q", "origin", "main")
  return git(clone, "rev-parse", "HEAD")
}

/** A change landed by hand in the garage: its head merged into the target and
 * pushed, with no queue run involved. `from` is the working repository the
 * change was submitted in — a submitted head is not at the shared repository
 * until the queue puts it there, so the hand-clone has to fetch it. */
export async function landByHand(origin: string, headSha: string, from: string): Promise<string> {
  const clone = await handClone(origin)
  await git(clone, "fetch", "-q", from, "+refs/heads/*:refs/remotes/submitted/*")
  await git(clone, "merge", "--no-ff", "--no-edit", "-q", headSha, "-m", `landed ${headSha.slice(0, 8)} by hand`)
  await git(clone, "push", "-q", "origin", "main")
  return git(clone, "rev-parse", "HEAD")
}

/** `origin/main` as the working repository sees it after a fetch — needed
 * whenever something other than the queue moved the target. */
export async function refreshTarget(repo: string): Promise<string> {
  await git(repo, "fetch", "-q", "origin")
  return targetTip(repo)
}

/** Whether a head is in the target's history — the plan's own merged test. */
export async function mergedIntoTarget(repo: string, sha: string): Promise<boolean> {
  const child = Bun.spawn(["git", "-C", repo, "merge-base", "--is-ancestor", sha, "origin/main"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  return (await child.exited) === 0
}

/** Every line a check log carries, so a case can read WHAT ran, not just how
 * many times. */
export async function checkLines(log: string): Promise<readonly string[]> {
  const file = Bun.file(log)
  if (!(await file.exists())) return []
  return (await file.text()).trimEnd().split("\n").filter(Boolean)
}

/** A path for a log the CASE owns, under a scratch root this file removes.
 * A check's `run:` string has to name its log before the repository that
 * declares the check exists, so the log cannot come from the repository. */
export async function scratchLog(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-boundary-log-"))
  roots.push(root)
  return join(root, `${name}.log`)
}
