/**
 * The queue-run boundary: scratch repositories, a fake check whose exit code
 * and duration the test chooses, and one `queue run --once` process.
 *
 * Everything here is black box on purpose. A test built on this fixture may
 * look at the queue run's exit code, at the refs the repositories carry
 * afterwards, and at the tip of the base branch — nothing else. No journal
 * reads, no internal imports beyond the process entry point, no log parsing
 * except to print on failure.
 *
 * The scratch-repository shape is the one `packages/yrd-cli/tests/
 * bay-submit-selected.test.ts` proves end to end: a bare receiver plus a
 * working repository whose `origin` is that receiver, work committed in a real
 * Bay worktree, and `yrd bay submit` as the submit form. The base the queue
 * lands on is the RECEIVER's `main`, never the local ref, so every assertion
 * about "main moved" reads `origin/main`.
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
  /** Run this instead of the fake check — for the case where the check is missing. */
  command?: string
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

/** The check step as `.yrd.yml` declares it, bound included when the case sets one. */
function checkStep(plan: FakeCheckPlan, log: string): string {
  const run = `run: ${JSON.stringify(fakeCheckCommand(plan, log))}`
  const bound = plan.timeoutMs === undefined ? "" : `, timeoutMs: ${String(plan.timeoutMs)}`
  return `checks: [{check: {${run}${bound}}}]`
}

export type BoundaryRepository = Readonly<{
  /** The working repository the queue runs against. */
  repo: string
  /** The bare receiver `repo`'s `origin` points at — the base the queue lands on. */
  origin: string
  /** One line per fake-check execution. */
  checkLog: string
}>

/**
 * A scratch repository whose only check is the fake check, on a fresh bare
 * receiver holding one commit of `main`.
 */
export async function boundaryRepository(plan: FakeCheckPlan): Promise<BoundaryRepository> {
  const root = await mkdtemp(join(tmpdir(), "yrd-boundary-"))
  roots.push(root)
  const repoPath = join(root, "repo")
  const origin = join(root, "origin.git")
  const checkLog = join(root, "fake-check.log")

  await git(root, "init", "-q", "--bare", origin)
  await git(root, "init", "-q", "-b", "main", repoPath)
  const repo = await realpath(repoPath)
  await git(repo, "config", "user.name", "Yrd Boundary")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await git(repo, "remote", "add", "origin", origin)
  await installDeclaredYrdEntry(repo)
  await writeFile(join(repo, "README.md"), "main\n")
  await writeFile(join(repo, ".yrd.yml"), `base: main\nbatch: 1\n${checkStep(plan, checkLog)}\n`)
  await git(repo, "add", "README.md", ".yrd.yml", "bin/yrd")
  await git(repo, "commit", "-qm", "main")
  await git(repo, "push", "-q", "-u", "origin", "main")
  return { repo, origin, checkLog }
}

export type Submission = Readonly<{
  /** The branch the Bay opened, `task/<bay>`. */
  branch: string
  /** The one commit this submission put on top of `main`. */
  headSha: string
  /** The change id the submit recorded. */
  pr: string
}>

/**
 * One commit on top of `main`, submitted the way the current receiver wants
 * it: committed inside a real Bay worktree and delivered with `yrd bay
 * submit` from that worktree. The Bay's own commit needs no `Change-Id`
 * trailer — `bay submit` records the change, and the trailer is only what a
 * recordless `refs/for` tip must carry.
 */
export async function submitOneCommit(repo: string, bay: string): Promise<Submission> {
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
  const submission = JSON.parse(submitted.stdout()) as {
    prs: readonly { id: string; branch: string; status: string }[]
  }
  const pr = submission.prs[0]?.id
  if (pr === undefined || submission.prs[0]?.branch !== branch) {
    throw new Error(`bay submit did not record ${branch}: ${submitted.stdout()}`)
  }
  return { branch, headSha, pr }
}

export type QueueRunOutcome = Readonly<{
  exitCode: number
  stdout: string
  stderr: string
  /** Everything a failing assertion should print, as one blob. */
  report: string
}>

/** One `queue run --once` process, end to end. */
export async function queueRunOnce(repo: string): Promise<QueueRunOutcome> {
  const run = capture(repo)
  const exitCode = await yrd(repo, run.io, "queue", "run", "--once", "--json")
  return {
    exitCode,
    stdout: run.stdout(),
    stderr: run.stderr(),
    report: `queue run --once exited ${String(exitCode)}\n--- stdout ---\n${run.stdout()}\n--- stderr ---\n${run.stderr()}`,
  }
}

/** The tip of the base the queue lands on — the receiver's, not the local ref. */
export function baseTip(repo: string): Promise<string> {
  return git(repo, "rev-parse", "origin/main")
}

/** The parents of a commit, oldest first. */
export async function parentsOf(repo: string, sha: string): Promise<readonly string[]> {
  const parents = await git(repo, "log", "-1", "--format=%P", sha)
  return parents === "" ? [] : parents.split(" ")
}

/** How many commits the base advanced along its own first-parent line. */
export async function firstParentDistance(repo: string, from: string, to: string): Promise<number> {
  return Number(await git(repo, "rev-list", "--count", "--first-parent", `${from}..${to}`))
}

/** Every ref the repository carries, as `<sha> <name>` lines. */
export async function refs(repo: string): Promise<readonly string[]> {
  const listed = await git(repo, "for-each-ref", "--format=%(objectname) %(refname)")
  return listed === "" ? [] : listed.split("\n")
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
