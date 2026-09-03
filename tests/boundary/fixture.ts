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
  /** Declare the `yrd` remote in `.yrd.yml`, so the submit path has somewhere
   * to read it from when the repository has no such remote. Default off, so
   * every case that predates this knob writes the same `.yrd.yml` it always
   * did. The plan says the submit path "adds the `yrd` remote from `.yrd.yml`
   * when missing" and does not name the key; `remote:` is this fixture's
   * reading of it. */
  yrdRemote?: boolean
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

/**
 * The head of a `.yrd.yml` for the core under measurement: the new core's
 * `remote:` and `target:` (ruling A5), or the incumbent's `base:` and `batch:`.
 * `remote` names the shared repository by URL when the case asks for the
 * remote to be added from the declaration; the incumbent gets the line too,
 * since the case that asks is red there on the rule, not on the key.
 */
export function declaration(remote?: string): string {
  if (measuringNewCore()) return `remote: ${JSON.stringify(remote ?? "origin")}\ntarget: main\n`
  return `${remote === undefined ? "" : `remote: ${JSON.stringify(remote)}\n`}base: main\nbatch: 1\n`
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
  // `remote:` is the one line that selects the new core (plan § Cutover). A
  // case that asks for the yrd remote by name gets the shared repository's
  // path; otherwise YRD_BOUNDARY_CORE=new names `origin`, so the same
  // black-box cases judge both cores and the gate runs this suite once per core.
  const head = plan.yrdRemote === true ? declaration(origin) : declaration()
  await writeFile(
    join(repo, ".yrd.yml"),
    `${head}${notifyStep(plan, notifyLog)}${checkStep(plan, checkLog)}\n`,
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
  /** The Bay the branch was authored in, so a case can commit again or submit
   * again from where an author stands. */
  bayPath: string
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
  const submitted = await submitFromBay(repo, bayPath)
  if (submitted.exitCode !== 0) {
    throw new Error(`bay submit exited ${String(submitted.exitCode)}\n${submitted.stderr}\n${submitted.stdout}`)
  }
  if (submitted.id === undefined || submitted.branch !== branch) {
    throw new Error(`bay submit did not record ${branch}: ${submitted.stdout}`)
  }
  return { branch, headSha, id: submitted.id, bayPath }
}

/** What one submit from a Bay reported. Unlike `submitOneCommit` this never
 * throws on a non-zero exit, because a case about submitting twice at one head
 * wants the exit code as evidence rather than as an abort. */
export type SubmitAttempt = Readonly<{
  exitCode: number
  stdout: string
  stderr: string
  id?: string
  branch?: string
  report: string
}>

/** Which core the suite measures: `YRD_BOUNDARY_CORE=new` selects the new one (plan § Cutover). */
export function measuringNewCore(): boolean {
  return process.env.YRD_BOUNDARY_CORE === "new"
}

/**
 * One submit, run standing in the Bay, exactly as an author does: the
 * incumbent's `yrd bay submit`, or the new core's `yrd queue submit` (one atomic
 * push of the branch and its opened fact) when YRD_BOUNDARY_CORE=new selects it.
 */
export async function submitFromBay(repo: string, bayPath: string): Promise<SubmitAttempt> {
  const submitted = capture(bayPath)
  const newCore = measuringNewCore()
  const exitCode = newCore
    ? await yrd(repo, submitted.io, "queue", "submit", "--json", ...notifyArgs(repo))
    : await yrd(repo, submitted.io, "bay", "submit", "--json")
  const verb = newCore ? "queue submit" : "bay submit"
  const report = `${verb} exited ${String(exitCode)}\n--- stdout ---\n${submitted.stdout()}\n--- stderr ---\n${submitted.stderr()}`
  let id: string | undefined
  let branch: string | undefined
  try {
    if (newCore) {
      const opened = JSON.parse(submitted.stdout()) as { branch?: string; opened?: string }
      id = opened.opened
      branch = opened.branch
    } else {
      const parsed = JSON.parse(submitted.stdout()) as { prs?: readonly { id?: string; branch?: string }[] }
      id = parsed.prs?.[0]?.id
      branch = parsed.prs?.[0]?.branch
    }
  } catch {
    // Not JSON — the exit code and the text are the evidence.
  }
  return { exitCode, stdout: submitted.stdout(), stderr: submitted.stderr(), id, branch, report }
}

/** One more commit in the Bay, so the branch gets a new head. Returns it. */
export async function commitInBay(bayPath: string, name: string): Promise<string> {
  await writeFile(join(bayPath, `${name}.txt`), `${name}\n`)
  await git(bayPath, "add", `${name}.txt`)
  await git(bayPath, "commit", "-qm", `${name}: one more commit`)
  return git(bayPath, "rev-parse", "HEAD")
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
  if (process.env.YRD_BOUNDARY_CORE === "new") {
    // The new core's one table: every change keyed by branch and head, with its derived state.
    expectZero(await yrd(repo, listed.io, "queue", "list", "--json"), "queue list", listed)
    const parsed = JSON.parse(listed.stdout()) as { changes: readonly { branch: string; head: string; state: string }[] }
    return Object.fromEntries(parsed.changes.map((change) => [`${change.branch}@${change.head}`, change.state]))
  }
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

/* ---------------------------------------------------------------------------
 * The change and its facts.
 *
 * Still black box: git is the store the plan names, so reading a change's ref
 * out of the shared repository with `git for-each-ref` and `git log` is
 * reading the published surface, not an internal. Nothing below opens a
 * journal, a database or a module.
 * ------------------------------------------------------------------------- */

/** Where a change's facts live: the change's name, the branch then `@` then the head sha, under the one prefix. */
export function changeRefName(branch: string, headSha: string): string {
  return `refs/yrd/changes/${branch}@${headSha}`
}

/** Every change ref a repository carries, as `<sha> <name>` lines. */
export async function changeRefs(repo: string): Promise<readonly string[]> {
  const listed = await git(repo, "for-each-ref", "--format=%(objectname) %(refname)", "refs/yrd/changes/**")
  return listed === "" ? [] : listed.split("\n")
}

/** Every ref of yrd's own the repository carries — the breadcrumb a missing
 * change ref needs, because it says what the queue wrote instead. */
async function yrdRefs(repo: string): Promise<readonly string[]> {
  const listed = await git(repo, "for-each-ref", "--format=%(objectname) %(refname)", "refs/yrd/**")
  return listed === "" ? [] : listed.split("\n")
}

/** One commit on a change's ref. */
export type ChangeFact = Readonly<{
  sha: string
  parents: readonly string[]
  /** Line one, prose, never parsed by a reader. */
  subject: string
  /** Every trailer, in order, as `Key: value` lines. */
  trailerLines: readonly string[]
  /** Values by trailer key, repeats kept. */
  trailers: ReadonlyMap<string, readonly string[]>
  /** The `Fact:` value, or "" when the commit carries none. */
  kind: string
}>

/** A change's ref as a reader sees it. */
export type ChangeReading = Readonly<{
  /** `refs/yrd/changes/<branch>@<head>`. */
  ref: string
  exists: boolean
  /** The ref's tip sha, or "" when there is no such ref. */
  tip: string
  /** The facts, oldest first, along the ref's first-parent line, with the
   * parentless genesis commit at the end of that line left out. */
  facts: readonly ChangeFact[]
  /** The `Fact:` value of each, oldest first. */
  kinds: readonly string[]
  /** The parentless commit the first-parent line ends at, when there is one. */
  genesis?: ChangeFact
  /** Every commit on the first-parent line, newest first — including whatever
   * is NOT a fact, which is the point of the "reads exactly the facts" case. */
  firstParentLine: readonly string[]
  /** Everything a failing assertion should print. */
  report: string
}>

function parseTrailers(lines: readonly string[]): Map<string, readonly string[]> {
  const trailers = new Map<string, string[]>()
  for (const line of lines) {
    const colon = line.indexOf(":")
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    const existing = trailers.get(key)
    if (existing === undefined) trailers.set(key, [value])
    else existing.push(value)
  }
  return trailers
}

const FIELD = "\u001f"
const RECORD = "\u001e"

/** The commits on a ref's first-parent line, newest first. */
async function firstParentCommits(repo: string, ref: string): Promise<readonly ChangeFact[]> {
  const raw = await git(
    repo,
    "log",
    "--first-parent",
    `--format=%H${FIELD}%P${FIELD}%s${FIELD}%(trailers:only,unfold)${RECORD}`,
    ref,
  )
  return raw
    .split(RECORD)
    .map((record) => record.replace(/^\n+/, ""))
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const [sha = "", parents = "", subject = "", trailerBlock = ""] = record.split(FIELD)
      const trailerLines = trailerBlock.split("\n").filter((line) => line.trim() !== "")
      const trailers = parseTrailers(trailerLines)
      return {
        sha,
        parents: parents === "" ? [] : parents.split(" "),
        subject,
        trailerLines,
        trailers,
        kind: trailers.get("Fact")?.[0] ?? "",
      }
    })
}

/**
 * Read one change's ref out of `repo`. Never throws when the ref is absent —
 * the reading says so, and its report lists every ref the repository does
 * carry, so a red case names what is missing instead of stack-tracing.
 */
export async function readChange(
  repo: string,
  change: Readonly<{ branch: string; headSha: string }>,
): Promise<ChangeReading> {
  const ref = changeRefName(change.branch, change.headSha)
  const present = await changeRefs(repo)
  const tipLine = present.find((line) => line.endsWith(` ${ref}`))
  if (tipLine === undefined) {
    const yrd = await yrdRefs(repo)
    const carried = yrd.length === 0 ? "  (none)" : yrd.map((line) => `  ${line}`).join("\n")
    return {
      ref,
      exists: false,
      tip: "",
      facts: [],
      kinds: [],
      firstParentLine: [],
      report: `no change ref ${ref} in ${repo}\nrefs/yrd/** there:\n${carried}`,
    }
  }
  const tip = tipLine.split(" ")[0] ?? ""
  const line = await firstParentCommits(repo, ref)
  const genesis = line.find((commit) => commit.parents.length === 0)
  const facts = [...line].reverse().filter((commit) => commit.kind !== "")
  const shown = line
    .map(
      (commit) =>
        `  ${commit.sha.slice(0, 8)} [${commit.parents.length}p] ${commit.kind || "(no Fact:)"} — ${commit.subject}`,
    )
    .join("\n")
  return {
    ref,
    exists: true,
    tip,
    facts,
    kinds: facts.map((fact) => fact.kind),
    genesis,
    firstParentLine: line.map((commit) => commit.sha),
    report: `${ref} at ${tip}\nfirst-parent line, newest first:\n${shown}`,
  }
}

export type YrdJsonResult = Readonly<{
  exitCode: number
  /** The parsed `--json` answer, or `undefined` when the CLI printed something else. */
  json: unknown
  stdout: string
  stderr: string
  /** Everything a failing assertion should print, as one blob. */
  report: string
}>

/**
 * One CLI call whose `--json` answer the caller reads. The generic form behind
 * every reader: `queue list`, `queue show`, anything a case needs to ask.
 * Parsing never throws — a CLI that answered with prose leaves `json`
 * undefined, so the assertion that wanted a field says what it got instead.
 */
export async function yrdJson(repo: string, ...args: string[]): Promise<YrdJsonResult> {
  const call = capture(repo)
  const exitCode = await yrd(repo, call.io, ...args, "--json")
  const stdout = call.stdout()
  const stderr = call.stderr()
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    json = undefined
  }
  return {
    exitCode,
    json,
    stdout,
    stderr,
    report: `yrd ${args.join(" ")} --json exited ${String(exitCode)}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
  }
}

/**
 * The target moves without the queue: `sha` merged into it by hand and pushed,
 * as the mechanic does in the garage. Answers the target's new tip.
 */
export async function mergeByHand(repo: string, sha: string, message = "merged by hand"): Promise<string> {
  await git(repo, "fetch", "-q", "origin")
  await git(repo, "checkout", "-q", "-B", "main", "origin/main")
  await git(repo, "merge", "-q", "--no-ff", "-m", message, sha)
  await git(repo, "push", "-q", "origin", "main")
  return targetTip(repo)
}

/**
 * A second reader of the same queue holding nothing but git: a fresh working
 * copy of the shared repository with every ref fetched, including any under
 * `refs/yrd/`. It never ran the queue, so whatever it can say about a change it
 * derived from the git store alone.
 */
export async function secondReader(origin: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-second-reader-"))
  roots.push(root)
  const clonePath = join(root, "reader")
  await git(root, "clone", "-q", origin, clonePath)
  const clone = await realpath(clonePath)
  // The bare shared repository's HEAD still names git's default branch, so a
  // plain clone lands nowhere; the target is `main` and the reader stands on it.
  await git(clone, "checkout", "-q", "-B", "main", "origin/main")
  await refreshSecondReader(clone)
  return clone
}

/** Everything the shared repository has learned since, into a second reader. */
export async function refreshSecondReader(clone: string): Promise<void> {
  await git(clone, "fetch", "-q", "origin")
  await git(clone, "fetch", "-q", "origin", "+refs/yrd/*:refs/yrd/*")
  await git(clone, "checkout", "-q", "-B", "main", "origin/main")
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

// ---------------------------------------------------------------------------
// The submit path — a branch at a head pushed to the `yrd` remote, and the
// change ref that records it. Added for `submit-and-branch.test.ts`; every
// helper above keeps the signature it had.
// ---------------------------------------------------------------------------

/** The remote the plan pushes branches and their changes to. */
export const YRD_REMOTE = "yrd"

/** The ref a change is: `refs/yrd/changes/<branch>@<head sha>`, the change's name under the one prefix. */
export function changeRef(branch: string, headSha: string): string {
  return `refs/yrd/changes/${branch}@${headSha}`
}

/** A git command that is allowed to fail — for asking whether a ref is there. */
export async function gitTry(
  cwd: string,
  ...args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() }
}

/** Whether a repository carries a ref at exactly this name. */
export async function refExists(dir: string, ref: string): Promise<boolean> {
  return (await gitTry(dir, "show-ref", "--verify", "--quiet", ref)).exitCode === 0
}

/** What a ref points at, or undefined when the repository has no such ref. */
export async function refSha(dir: string, ref: string): Promise<string | undefined> {
  const read = await gitTry(dir, "rev-parse", "--verify", "--quiet", ref)
  return read.exitCode === 0 && read.stdout !== "" ? read.stdout : undefined
}

/** The remotes a repository has, by name. */
export async function remoteNames(repo: string): Promise<readonly string[]> {
  const listed = await git(repo, "remote")
  return listed === "" ? [] : listed.split("\n")
}

/** The submitter's own hand: a `yrd` remote added with plain git. */
export async function addYrdRemote(repo: string, origin: string): Promise<void> {
  await git(repo, "remote", "add", YRD_REMOTE, origin)
}

/**
 * Who the next commits and submits in this repository are by: git's identity
 * for the commits, and the seat every later submit from this repository names.
 * The submitter is told on the command line, never read from the git author
 * (ruling @i/10-yrd/24028: the fleet's git identity names nobody).
 */
const submitterOf = new Map<string, string>()
export async function setSubmitter(repo: string, name: string, email: string): Promise<void> {
  await git(repo, "config", "user.name", name)
  await git(repo, "config", "user.email", email)
  submitterOf.set(repo, email)
}

/** The `--notify <seat>` a submit from `repo` carries, when `setSubmitter` named one. */
function notifyArgs(repo: string): readonly string[] {
  const seat = submitterOf.get(repo)
  return seat === undefined ? [] : ["--notify", seat]
}

let commitCounter = 0

/**
 * One commit on `branch`, cut from the target the first time the branch is
 * named, and the repository left standing on `main` afterwards so a queue run
 * never reads the submitter's checkout as the target.
 */
export async function commitOnBranch(repo: string, branch: string, message?: string): Promise<string> {
  if (await refExists(repo, `refs/heads/${branch}`)) await git(repo, "checkout", "-q", branch)
  else await git(repo, "checkout", "-q", "-b", branch, "origin/main")

  commitCounter += 1
  const file = `${branch.replaceAll("/", "-")}-${String(commitCounter)}.txt`
  await writeFile(join(repo, file), `${file}\n`)
  await git(repo, "add", file)
  await git(repo, "commit", "-qm", message ?? `${branch}: one commit`)
  const head = await git(repo, "rev-parse", "HEAD")
  await git(repo, "checkout", "-q", "main")
  return head
}

/** The same work at a new sha that does not descend from the old one — what a
 * rebase leaves behind, without needing a second base to rebase onto. */
export async function amendHead(repo: string, branch: string, message: string): Promise<string> {
  await git(repo, "checkout", "-q", branch)
  await git(repo, "commit", "-q", "--amend", "-m", message)
  const head = await git(repo, "rev-parse", "HEAD")
  await git(repo, "checkout", "-q", "main")
  return head
}

/** One `yrd <args>` in `repo`, whatever it exits with. A verb the CLI does not
 * have comes back as a non-zero result whose report names it, which is the
 * gate doing its job rather than an unhandled rejection. */
export function runYrd(repo: string, ...args: string[]): Promise<QueueRunResult> {
  return runYrdIn(repo, repo, ...args)
}

/** `runYrd`, standing in `cwd`: a bay, for the commands that act "here". */
export async function runYrdIn(repo: string, cwd: string, ...args: string[]): Promise<QueueRunResult> {
  const run = capture(cwd)
  let exitCode: number
  try {
    exitCode = await yrd(repo, run.io, ...args)
  } catch (error) {
    exitCode = 70
    run.io.stderr(`${String(error)}\n`)
  }
  return {
    exitCode,
    stdout: run.stdout(),
    stderr: run.stderr(),
    report: `yrd ${args.join(" ")} exited ${String(exitCode)}\n--- stdout ---\n${run.stdout()}\n--- stderr ---\n${run.stderr()}`,
  }
}

/** The plan's one path in: `yrd queue submit <branch>`. */
export function queueSubmit(repo: string, branch: string): Promise<QueueRunResult> {
  return runYrd(repo, "queue", "submit", branch, ...notifyArgs(repo))
}

/**
 * A change's facts, newest first, as their commit messages on the change ref.
 * A fact carries `Fact:`; the genesis commit that ends the first-parent walk
 * carries none and is not one.
 */
export async function factMessages(dir: string, ref: string): Promise<readonly string[]> {
  const log = await git(dir, "log", "--first-parent", "--format=%B%x00", ref)
  return log
    .split("\0")
    .map((message) => message.trim())
    .filter((message) => /^Fact: /mu.test(message))
}

/** Everything the notifier was handed, as one blob; empty when nothing was sent. */
export async function notifiedMessages(notifyLog: string): Promise<string> {
  const file = Bun.file(notifyLog)
  return (await file.exists()) ? await file.text() : ""
}

/**
 * A second submitter: another working clone of the same shared repository,
 * with its own identity and its own `yrd` remote. Its scratch root is cleaned
 * up with every other.
 */
export async function secondWorkingRepo(origin: string, name: string, email: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-boundary-second-"))
  roots.push(root)
  const clonePath = join(root, "repo")
  await git(root, "clone", "-q", origin, clonePath)
  const repo = await realpath(clonePath)
  await setSubmitter(repo, name, email)
  await addYrdRemote(repo, origin)
  return repo
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
  /** Repository paths restored from the base before the check runs (ruling D5). */
  scripts?: readonly string[]
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
    if (check.scripts !== undefined) fields.push(`scripts: ${JSON.stringify(check.scripts)}`)
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
  await writeFile(join(repo, ".yrd.yml"), `${declaration()}${notify}${phasedChecks(plan.checks)}\n`)

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

  const submitted = await submitFromBay(repo, bayPath)
  if (submitted.exitCode !== 0 || submitted.id === undefined || submitted.branch !== branch) {
    throw new Error(`submit did not record ${branch}:\n${submitted.report}`)
  }
  return { bayPath, branch, headSha, id: submitted.id }
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

  const submitted = await submitFromBay(repo, bayPath)
  if (submitted.exitCode !== 0 || submitted.id === undefined) {
    throw new Error(`submit did not record ${branch}:\n${submitted.report}`)
  }
  return { bayPath, branch, headSha, id: submitted.id }
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
