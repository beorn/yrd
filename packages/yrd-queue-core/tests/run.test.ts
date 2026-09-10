/**
 * One queue run, end to end, against a real remote and a real check script.
 *
 * Every case asserts on what the plan says a reader can see: the exit code,
 * the target's commits, the change's records at the remote, and the message the
 * notifier was handed. Nothing internal.
 */

import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { createProcess } from "@yrd/process"
import { gitEnvironment } from "../src/git.ts"
import { CapturedQueueObjectsUnavailable } from "../src/remote.ts"
import {
  appendRecord,
  changeName,
  changeRef,
  checkLogPath,
  gitIn,
  list,
  mergedByRun,
  pauseRef,
  queueRefPrefix,
  queueRun,
  readRecords,
  refAt,
  readRecord,
  readQueue,
  readPause,
  runCheck,
  submit,
  trailer,
  trailers,
  writePause,
} from "../src/index.ts"
import type { ChangeRecord, CheckedTree, Git, PauseRecord, QueueRunOptions, QueueRunOutcome } from "../src/index.ts"
import { resolveGitSelection } from "../src/git.ts"

const roots: string[] = []
// The real queue child needs GitSuper even when the worker's PATH is sealed.
const gitSuperBin = resolve(Bun.resolveSync("git-super", import.meta.dirname), "../../bin")
const CHANGES = queueRefPrefix("main")
const PAUSE_REF = pauseRef("main")

const INCIDENT_FIELDS = ["Code", "Subject", "Via", "Evidence", "Next"] as const

function incidentOf(record: ChangeRecord | undefined): Readonly<Record<(typeof INCIDENT_FIELDS)[number], string>> {
  if (record === undefined) throw new Error("no incident record")
  const incident = Object.fromEntries(INCIDENT_FIELDS.map((field) => [field, trailer(record, field)]))
  for (const field of INCIDENT_FIELDS) expect(incident[field], `${field}: must be present and non-empty`).toBeTruthy()
  expect(trailer(record, "Owner")).toBe("the queue operator")
  return incident as Record<(typeof INCIDENT_FIELDS)[number], string>
}

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

type World = Readonly<{
  git: Git
  work: string
  remote: string
  target: string
  workdir: string
  notifyLog: string
  /** The command every notify entry in these cases runs: it appends the record to `notifyLog`. */
  notifier: string
  checkLog: string
  /** The target's `setup:`, exiting as the case says; it records its own cwd in `checkLog`, beside the check's. */
  setupCommand(exit: number): string
  options(
    check: Readonly<{
      exit?: number
      sleep?: number
      timeoutMs?: number
      everywhere?: boolean
      setup?: string
      /** The phases the one check runs in; absent means merge (ruling A1). */
      on?: readonly ("submit" | "merge")[]
    }>,
  ): Promise<QueueRunOptions>
}>

/**
 * A bare remote with `main`, a clone that submits, and a fake check. With
 * `declaredLater`, main carries one commit from before the declaration: the
 * old queue's history, which the E5 reading must never judge.
 */
async function world(plan: Readonly<{ declaredLater?: boolean }> = {}): Promise<World> {
  // The workdir must be a real filesystem the runner can lstat; the OS
  // temp dir is fine for a test, the plan's rule about tmpfs is for real runs.
  const root = mkdtempSync(join(tmpdir(), "yrd-core-run-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  const workdir = join(root, "queue")
  const notifyLog = join(root, "notify.log")
  const checkLog = join(root, "check.log")
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await git(["config", "user.email", "queue@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, "target.txt"), "base\n")
  if (plan.declaredLater === true) {
    await git(["add", "target.txt"])
    await git(["commit", "--quiet", "-m", "old main, before the declaration"])
  }
  // The target declares the queue, as every real target does: the merged
  // tree's declaration is a built-in check at merge (ruling D2).
  writeFileSync(join(work, ".yrd.yml"), "{}\n")
  await git(["add", "target.txt", ".yrd.yml"])
  await git(["commit", "--quiet", "-m", plan.declaredLater === true ? "declare the queue" : "base"])
  await git(["push", "--quiet", "origin", "main"])
  const target = (await git(["rev-parse", "HEAD"])).trim()
  // The check exits FAKE_EXIT only where the change's own file is present, so
  // a failure is the change's; FAKE_EVERYWHERE=1 makes it fail at the target
  // too, which is the inherited case.
  const fakeCheck = join(root, "fake-check.sh")
  writeFileSync(
    fakeCheck,
    [
      "#!/bin/sh",
      'sleep "${FAKE_SLEEP:-0}"',
      `echo "check cwd=$(pwd) exit=\${FAKE_EXIT:-0} repo=\${YRD_REPO:-none} candidate=\${YRD_CANDIDATE_SHA:-none} base=\${YRD_BASE_SHA:-none}" >> "${checkLog}"`,
      'if [ -f one.txt ] || [ "${FAKE_EVERYWHERE:-0}" = 1 ]; then exit "${FAKE_EXIT:-0}"; fi',
      "exit 0",
      "",
    ].join("\n"),
  )
  chmodSync(fakeCheck, 0o755)
  // The setup records the worktree it prepared and exits as the case says.
  // Its environment is built, not passed through, so the exit code travels as
  // an argument on the command the declaration would carry.
  const setupScript = join(root, "setup.sh")
  writeFileSync(
    setupScript,
    [
      "#!/bin/sh",
      `echo "setup cwd=$(pwd) repo=\${YRD_REPO:-none} candidate=\${YRD_CANDIDATE_SHA:-none} base=\${YRD_BASE_SHA:-none}" >> "${checkLog}"`,
      'exit "${1:-0}"',
      "",
    ].join("\n"),
  )
  chmodSync(setupScript, 0o755)
  const notifier = join(root, "notify.sh")
  writeFileSync(notifier, `#!/bin/sh\ncat >> "${notifyLog}"\n`)
  chmodSync(notifier, 0o755)
  mkdirSync(workdir, { recursive: true })
  return {
    checkLog,
    git,
    notifier,
    notifyLog,
    setupCommand: (exit) => `${setupScript} ${String(exit)}`,
    options: async (check) => ({
      checks: [
        {
          environmentPassthrough: ["FAKE_EXIT", "FAKE_SLEEP", "FAKE_EVERYWHERE"],
          name: "verify",
          on: check.on,
          run: fakeCheck,
          timeoutMs: check.timeoutMs,
        },
      ],
      configBlob: "test-config",
      env: {
        ...process.env,
        FAKE_EVERYWHERE: check.everywhere === true ? "1" : "0",
        FAKE_EXIT: String(check.exit ?? 0),
        FAKE_SLEEP: String(check.sleep ?? 0),
        PATH: `${gitSuperBin}:${process.env.PATH ?? ""}`,
      },
      notify: [{ name: "recorder", on: ["merged", "failed", "stuck", "merged-direct"], run: notifier }],
      // What the CLI passes for a queue-owned clone (`QueueLocation.owned`).
      // A run against a seat's checkout leaves that tree alone instead, which
      // is the other branch and lives in reference.test.ts.
      populateReference: true,
      repo: work,
      ...(check.setup === undefined ? {} : { setup: check.setup }),
      target: { branch: "main", remote: "origin" },
      targetSha: await remoteTarget({ git }),
      workdir,
    }),
    remote,
    target,
    work,
    workdir,
  }
}

async function submitCommit(w: World, branch: string, file: string): Promise<string> {
  await w.git(["checkout", "--quiet", "-b", branch, "main"])
  writeFileSync(join(w.work, file), `${file}\n`)
  await w.git(["add", file])
  await w.git(["commit", "--quiet", "-m", file])
  const head = (await w.git(["rev-parse", "HEAD"])).trim()
  await w.git(["checkout", "--quiet", "main"])
  await submit(w.git, "origin", {
    branch,
    submitter: "@dev/2",
    target: { branch: "main", remote: "origin" },
    issue: "@i/10-yrd/1",
  })
  return head
}

async function remoteTarget(w: Pick<World, "git">): Promise<string> {
  const target = (await w.git(["ls-remote", "--refs", "origin", "refs/heads/main"])).trim().split(/\s+/u)[0]
  if (target === undefined || target === "") throw new Error("origin/main has no declared target")
  return target
}

/** One commit on the target, pushed around the queue: the thing only the queue may do. */
async function pushAroundQueue(w: World, file: string): Promise<string> {
  await w.git(["checkout", "--quiet", "main"])
  writeFileSync(join(w.work, file), `${file}\n`)
  await w.git(["add", file])
  await w.git(["commit", "--quiet", "-m", `${file} around the queue`])
  await w.git(["push", "--quiet", "origin", "main"])
  return (await w.git(["rev-parse", "HEAD"])).trim()
}

/** The declaration itself edited on the target and pushed around the queue: the commit that used to become the boundary and hide itself. */
async function editDeclarationAroundQueue(w: World, text: string): Promise<string> {
  await w.git(["checkout", "--quiet", "main"])
  writeFileSync(join(w.work, ".yrd.yml"), text)
  await w.git(["add", ".yrd.yml"])
  await w.git(["commit", "--quiet", "-m", "edit the declaration around the queue"])
  await w.git(["push", "--quiet", "origin", "main"])
  return (await w.git(["rev-parse", "HEAD"])).trim()
}

/**
 * Main gets a real `package.json` depending on a local `file:` package at
 * `from`'s version, plus a REAL `bun.lock` a real, offline `bun install`
 * wrote for it (both committed, so every worktree the queue makes inherits
 * them already consistent). The returned branch then raises that dependency
 * to `to`'s version in `package.json` ALONE, never touching the lockfile —
 * @i/10-yrd/24140's own repro for a `bun install --frozen-lockfile` that
 * refuses without naming what moved. No network: `file:` resolves locally.
 */
async function submitRaisedDependency(
  w: World,
  branch: string,
  name: string,
  from: string,
  to: string,
): Promise<Readonly<{ head: string }>> {
  const manifest = (version: string): string =>
    `${JSON.stringify({ dependencies: { [name]: `file:./vendor-${version}` }, name: "fixture-root", version: "0.0.0" }, null, 2)}\n`
  await w.git(["checkout", "--quiet", "main"])
  for (const version of [from, to]) {
    const vendor = join(w.work, `vendor-${version}`)
    mkdirSync(vendor, { recursive: true })
    writeFileSync(join(vendor, "package.json"), `${JSON.stringify({ name, version }, null, 2)}\n`)
  }
  writeFileSync(join(w.work, "package.json"), manifest(from))
  // The only moment a lockfile is GENERATED rather than diffed: a real `bun
  // install` against the BEFORE state, offline, in the fixture's own work
  // tree.
  const install = spawnSync("bun", ["install"], { cwd: w.work, encoding: "utf8" })
  if (install.status !== 0) {
    throw new Error(`fixture setup: bun install failed seeding the lockfile: ${install.stderr}\n${install.stdout}`)
  }
  await w.git(["add", "package.json", "bun.lock", `vendor-${from}`, `vendor-${to}`])
  await w.git(["commit", "--quiet", "-m", `depend on ${name}@${from}`])
  await w.git(["push", "--quiet", "origin", "main"])

  await w.git(["checkout", "--quiet", "-b", branch, "main"])
  writeFileSync(join(w.work, "package.json"), manifest(to))
  await w.git(["add", "package.json"])
  await w.git(["commit", "--quiet", "-m", `raise ${name} to ${to}`])
  const head = (await w.git(["rev-parse", "HEAD"])).trim()
  await w.git(["checkout", "--quiet", "main"])
  await submit(w.git, "origin", {
    branch,
    submitter: "@dev/2",
    target: { branch: "main", remote: "origin" },
    issue: "@i/10-yrd/24140",
  })
  return { head }
}

/** Every record of a run's log, in order. */
function logRecords(outcome: QueueRunOutcome): readonly Record<string, unknown>[] {
  return readFileSync(outcome.log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** The log path an ended `check` row named, for one branch, phase and check name. */
function checkLogFor(outcome: QueueRunOutcome, branch: string, phase: string, name: string): string {
  const row = logRecords(outcome).find(
    (record) =>
      record.kind === "check" &&
      record.branch === branch &&
      record.phase === phase &&
      record.name === name &&
      record.end !== undefined,
  )
  const log = row?.log
  if (typeof log !== "string") {
    throw new Error(`no ended check row for ${branch} ${phase} ${name} in ${outcome.log}`)
  }
  return log
}

/** One trailer of a commit, as `git log` reads it back. */
async function trailerOn(w: World, commit: string, key: string): Promise<string> {
  return (await w.git(["log", "-1", `--format=%(trailers:key=${key},valueonly)`, commit])).trim()
}

/**
 * A change ref named after the target, planted at the remote exactly as the
 * specimen of 2026-09-03 stands there: `yrd submit` run from a checkout
 * standing on the target opened `main@0a9db9daf7eb` with `Submitter: unknown`
 * at 03:33 PDT. `submit` refuses that now, so the ref is written here instead.
 */
async function plantTargetChange(w: World, head: string): Promise<void> {
  await appendRecord(w.git, "main", {
    change: { branch: "main", head },
    kind: "opened",
    subject: "unknown submitted main to main",
    trailers: [["Submitter", "unknown"]],
  })
  const ref = changeRef("main", { branch: "main", head })
  await w.git(["push", "--quiet", "origin", `${ref}:${ref}`])
}

async function fetchChanges(w: World): Promise<void> {
  await w.git(["fetch", "--quiet", "origin", "+refs/yrd/main/*:refs/yrd/main/*"])
}

/** One program the queue ran, as it recorded itself: the name it goes by, then its `key=value` fields. */
type Recorded = Readonly<{ program: string; cwd: string; repo: string; candidate: string; base: string }>

/**
 * Every program the queue ran, in order, as each one recorded itself: what it
 * was, the directory it stood in, and the three values the queue told it about
 * the tree it was judging.
 */
function ranPrograms(w: World): readonly Recorded[] {
  let lines: readonly string[]
  try {
    lines = readFileSync(w.checkLog, "utf8").split("\n").filter(Boolean)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  return lines.map((line) => {
    const [program = "", ...rest] = line.split(" ")
    const fields = new Map(rest.map((field) => field.split("=") as [string, string]))
    return {
      base: fields.get("base") ?? "",
      candidate: fields.get("candidate") ?? "",
      cwd: fields.get("cwd") ?? "",
      program,
      repo: fields.get("repo") ?? "",
    }
  })
}

/**
 * What ran and where, in order, as `["setup" | "check", "<directory>"]`. The
 * directory is the discriminator — a worktree per judgement, so "was this tree
 * prepared before anything judged in it" has a file-shaped answer.
 */
function whereRan(w: World): readonly (readonly [string, string])[] {
  return ranPrograms(w).map((ran) => [ran.program, ran.cwd] as const)
}

/** Nothing judged a worktree the setup had not prepared first. */
function everyCheckWasPrepared(order: readonly (readonly [string, string])[]): void {
  for (const [index, [what, where]] of order.entries()) {
    if (what !== "check") continue
    const prepared = order.slice(0, index).some(([earlier, at]) => earlier === "setup" && at === where)
    expect(
      prepared,
      `a check ran in ${where}, which no setup prepared:\n${order.map((row) => row.join(" ")).join("\n")}`,
    ).toBe(true)
  }
}

function messages(w: World): readonly Record<string, string>[] {
  try {
    return readFileSync(w.notifyLog, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, string>)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

/**
 * A process id that named a process and does not any more: a child run to
 * completion and reaped. The only honest way to write a dead run's pid file,
 * since any number picked out of the air could be a process that is running.
 */
function exitedPid(): number {
  const child = spawnSync("git", ["--version"])
  const pid = child.pid
  if (pid === undefined) throw new Error("could not spawn a child to take an exited process id from")
  if (processIsRunning(pid)) throw new Error(`pid ${String(pid)} is still running, so it cannot stand for a dead run`)
  return pid
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** A worktree of `main` registered under `<workdir>/worktrees/<run>/`, as a queue run makes one, with a pid file claiming it for `pid`. */
async function worktreeOfRun(w: World, run: string, pid: number): Promise<string> {
  const directory = join(w.workdir, "worktrees", run)
  const path = join(directory, "submit", run)
  mkdirSync(directory, { recursive: true })
  await w.git(["worktree", "add", "--quiet", "--detach", path, "main"])
  // A check writes into the tree it judges, so no worktree a run left behind
  // is ever clean; `git worktree remove` refuses exactly this.
  writeFileSync(join(path, "what-a-check-left.txt"), "output\n")
  writeFileSync(join(directory, ".pid"), `${String(pid)}\n`)
  return path
}

/**
 * A merge candidate composed exactly the way `composeCandidate` composes one
 * — in a throwaway worktree of `main`, a plain `git merge --no-ff` of `head`
 * onto the target's current tip — but never pushed anywhere: what a queue run
 * would have on disk the instant after git-super hands back a commit, before
 * that run has settled anything about it (@i/10-yrd/24344).
 */
async function composeMergeCandidate(w: World, head: string, message: string): Promise<string> {
  const path = join(w.workdir, "..", "compose-scratch")
  await w.git(["worktree", "add", "--quiet", "--detach", path, "main"])
  const wt = gitIn(path)
  await wt(["merge", "--quiet", "--no-ff", "-m", message, head])
  const commit = (await wt(["rev-parse", "HEAD"])).trim()
  await w.git(["worktree", "remove", "--force", path])
  return commit
}

/**
 * A dead run's leftover on-merge worktree at `<workdir>/worktrees/<run>/merge/<head-12>`,
 * checked out at `commit` — exactly what `composeCandidate`'s own `prepare`
 * leaves behind when the run that made it dies before removing it
 * (@i/10-yrd/24344, mirroring `worktreeOfRun` above for the "merge" phase).
 */
async function deadMergeWorktree(w: World, run: string, head: string, commit: string, pid: number): Promise<string> {
  const directory = join(w.workdir, "worktrees", run)
  const path = join(directory, "merge", head.slice(0, 12))
  mkdirSync(join(directory, "merge"), { recursive: true })
  await w.git(["worktree", "add", "--quiet", "--detach", path, commit])
  writeFileSync(join(path, "what-a-check-left.txt"), "output\n")
  writeFileSync(join(directory, ".pid"), `${String(pid)}\n`)
  return path
}

describe("a check log is written once", () => {
  it("a second write to a log path that already exists throws and names it, and the first log survives", async () => {
    // Every caller writes under a directory of its own — the queue run's keyed
    // by change, run and phase, `yrd check`'s by the instant it started — so a
    // path that already exists means two programs are writing one log, and the
    // second replacing the first's bytes in silence is the whole failure.
    const root = mkdtempSync(join(tmpdir(), "yrd-core-check-log-"))
    roots.push(root)
    const tree: CheckedTree = { base: "0".repeat(40), candidate: "1".repeat(40) }
    const where = { cwd: root, logDir: join(root, "checks"), tmpdir: join(root, "tmp"), tree }
    const path = checkLogPath(where.logDir, "verify")

    const first = await runCheck({ ...where, spec: { name: "verify", run: "echo hello" } })

    expect(first.result).toBe("pass")
    expect(readFileSync(path, "utf8")).toContain("hello")
    await expect(runCheck({ ...where, spec: { name: "verify", run: "echo again" } })).rejects.toThrow(path)
    expect(readFileSync(path, "utf8")).toContain("hello")

    // Two overlapping check processes compete for a previously absent path.
    // Either may finish first; exactly one publishes, the loser names the
    // collision, and the winner's bytes survive. No timing/order assumption.
    const contenders = ["failure", "pass"] as const
    const attempts = await Promise.allSettled(
      contenders.map((word) =>
        runCheck({
          ...where,
          spec: { name: "overlap", run: `echo ${word}; exit ${word === "failure" ? "1" : "0"}` },
        }),
      ),
    )
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1)
    const overlap = checkLogPath(where.logDir, "overlap")
    for (const [index, attempt] of attempts.entries()) {
      if (attempt.status === "rejected") {
        expect(String(attempt.reason)).toContain(`a check log already exists at ${overlap}`)
      } else {
        expect(attempt.value.log).toBe(overlap)
        expect(readFileSync(overlap, "utf8")).toBe(`${contenders[index]}\n`)
        expect(attempt.value.result).toBe(contenders[index] === "failure" ? "fail" : "pass")
      }
    }
  })
})

describe("a queue run", () => {
  it("retries one typed queue read in the whole round, preserves both failures, and never retries another error", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const base = await w.options({ exit: 0, on: ["submit"] })

    const ordinary = new Error("the object reader itself broke")
    let ordinaryReads = 0
    const untypedGit: Git = async (args, input) => {
      if (args[0] === "ls-remote") {
        ordinaryReads += 1
        throw ordinary
      }
      return w.git(args, input)
    }
    await expect(queueRun({ ...base, git: untypedGit })).rejects.toBe(ordinary)
    expect(ordinaryReads).toBe(1)

    const firstCause = new Error("first upload-pack refusal")
    const secondCause = new Error("post-judge upload-pack refusal")
    let queueFetches = 0
    const fetchedTargets: boolean[] = []
    const typedGit: Git = async (args, input) => {
      if (args[0] === "fetch" && args.includes("--no-write-fetch-head") && args.includes("--refmap=")) {
        queueFetches += 1
        fetchedTargets.push(args.includes(w.target))
        if (queueFetches === 1) throw firstCause
        if (queueFetches === 3) throw secondCause
      }
      return w.git(args, input)
    }

    const error = await queueRun({ ...base, git: typedGit }).then(
      () => undefined,
      (cause: unknown) => cause,
    )

    expect(error).toBeInstanceOf(AggregateError)
    if (!(error instanceof AggregateError)) throw new Error("the second queue read unexpectedly succeeded")
    expect(error.message).toContain(firstCause.message)
    expect(error.message).toContain(secondCause.message)
    expect(error.errors).toHaveLength(2)
    const [first, second] = error.errors
    expect(first).toBeInstanceOf(CapturedQueueObjectsUnavailable)
    expect(second).toBeInstanceOf(CapturedQueueObjectsUnavailable)
    expect(first).toMatchObject({ capturedTarget: w.target, cause: firstCause, detail: firstCause.message })
    expect(second).toMatchObject({ capturedTarget: w.target, cause: secondCause, detail: secondCause.message })
    expect(error.cause).toBe(first)
    expect(queueFetches).toBe(3)
    expect(fetchedTargets).toEqual([true, true, true])
    expect(await remoteTarget(w)).toBe(w.target)
    await fetchChanges(w)
    expect(
      (await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)).map(
        (record) => record.kind,
      ),
    ).toEqual(["opened", "checked"])
  })

  // The protocol fixtures below cannot prove the actual producer accepts
  // Yrd's captured advertisement or that its opaque notice reaches notify.
  it("observes a real selected GitSuper child tip through an idle queue and its notifier", async () => {
    const w = await world()
    const child = join(w.workdir, "child")
    mkdirSync(w.workdir, { recursive: true })
    await w.git(["init", "--quiet", "--initial-branch=main", child])
    const childGit = gitIn(child)
    await childGit(["config", "user.email", "queue@yrd.test"])
    await childGit(["config", "user.name", "yrd"])
    writeFileSync(join(child, "child.txt"), "before\n")
    await childGit(["add", "."])
    await childGit(["commit", "--quiet", "-m", "child before"])
    const gitlink = (await childGit(["rev-parse", "HEAD"])).trim()
    const rootUrl = "https://example.test/acme/product.git"
    const childUrl = "https://example.test/acme/child.git"
    const config = join(w.workdir, "gitconfig")
    await w.git(["config", "--file", config, `url.${w.remote}.insteadOf`, rootUrl])
    await w.git(["config", "--file", config, `url.${child}.insteadOf`, childUrl])
    await w.git(["config", "--file", config, "protocol.file.allow", "always"])
    for (const [key, value] of [
      ["path", "packages/child"],
      ["url", childUrl],
      ["branch", "main"],
    ] as const) {
      await w.git(["config", "-f", ".gitmodules", `submodule.child.${key}`, value])
    }
    await w.git(["add", ".gitmodules"])
    await w.git(["update-index", "--add", "--cacheinfo", `160000,${gitlink},packages/child`])
    await w.git(["commit", "--quiet", "-m", "declare the product child"])
    await w.git(["push", "--quiet", "origin", "main"])
    const targetSha = (await w.git(["rev-parse", "HEAD"])).trim()
    const base = await w.options({ exit: 0 })
    await w.git(["remote", "set-url", "origin", rootUrl])
    writeFileSync(join(child, "child.txt"), "after\n")
    await childGit(["commit", "--quiet", "-am", "child committed directly to the queue"])
    const tip = (await childGit(["rev-parse", "HEAD"])).trim()
    const outcome = await queueRun({
      ...base,
      targetSha,
      env: { ...base.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" },
      selection: { executable: join(gitSuperBin, "git-super"), contract: "root-v1", scope: "local", origin: "fixture" },
      notify: [{ name: "observer", on: ["observed"], run: w.notifier }],
    })
    expect(outcome.exitCode).toBe(0)
    expect(outcome.observation).toMatchObject({ contract: "root-v1", outcome: "observed" })
    expect(outcome.observation.notices).toHaveLength(1)
    expect(outcome.observation.notices[0]?.text).toContain(tip)
    expect(outcome.observation.notices[0]?.text).toContain("packages/child")
    expect(JSON.parse(readFileSync(w.notifyLog, "utf8"))).toEqual({
      record: "observed",
      notice: outcome.observation.notices[0],
    })
    expect((await childGit(["rev-parse", "HEAD"])).trim()).toBe(tip)
    expect((await w.git(["rev-parse", "HEAD"])).trim()).toBe(targetSha)
  })

  // D1: an idle or paused run still observes; stale/unavailable observations
  // end before candidate work, and generic notices use their own opt-in payload.
  it.each([
    ["observed", 0],
    ["changed-during-read", 3],
    ["unavailable-transport", 4],
    ["invalid", 2],
  ] as const)("settles %s observation once before candidate work, including paused runs", async (outcome, exit) => {
    const w = await world()
    const notices = outcome === "observed" ? [{ id: "opaque-id", text: "producer explanation" }] : []
    const envelope = { version: 1, outcome, message: "selected root observation", notices }
    await using runner = createProcess({ cwd: w.work })
    let calls = 0
    const observed = {
      ...runner,
      run: async (request: Parameters<typeof runner.run>[0]) => {
        if (request.argv.slice(1).join(" ") !== "super observe --protocol=1") return runner.run(request)
        calls++
        expect(request.extraStdio).toBeUndefined()
        return runner.run({
          ...request,
          argv: [
            process.execPath,
            "-e",
            `process.stdout.write(${JSON.stringify(JSON.stringify(envelope))});process.exit(${exit})`,
          ],
        })
      },
    }
    const options = {
      ...(await w.options({ exit: 0 })),
      process: observed,
      git: w.git,
      selection: {
        executable: join(gitSuperBin, "git-super"),
        contract: "root-v1" as const,
        scope: "local" as const,
        origin: "fixture",
      },
      notify: [{ name: "observer", on: ["observed" as const], run: w.notifier }],
    }
    const idle = await queueRun(options)
    expect(idle.exitCode).toBe(outcome === "invalid" ? 2 : 0)
    expect(idle.observation).toEqual({ contract: "root-v1", ...envelope })
    expect(calls).toBe(1)
    const head = await submitCommit(w, "task/one", "one.txt")
    if (outcome === "observed") {
      await writePause(w.git, "origin", "main", { kind: "paused", by: "operator", reason: "observation only" })
    }
    const next = await queueRun(options)
    expect(calls).toBe(2)
    expect(next.exitCode).toBe(outcome === "invalid" ? 2 : 0)
    expect(await remoteTarget(w)).toBe(w.target)
    const ref = changeRef("main", { branch: "task/one", head })
    const tip = (await w.git(["ls-remote", "--refs", "origin", ref])).trim().split(/\s+/u)[0]!
    expect((await readRecords(w.git, tip)).map(({ kind }) => kind)).toEqual(["opened"])
    const logs = logRecords(next)
    expect(logs.some((row) => row.kind === "observation" && row.message === envelope.message)).toBe(true)
    if (outcome === "observed") {
      expect(
        readFileSync(w.notifyLog, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([
        { record: "observed", notice: notices[0] },
        { record: "observed", notice: notices[0] },
      ])
      expect(logs.some((row) => row.kind === "message" && row.id === "opaque-id" && row.delivered === true)).toBe(true)
    } else expect(existsSync(w.notifyLog)).toBe(false)
  })

  it("refuses a queue-owned hooks path that is not empty", async () => {
    const w = await world()
    const hooksPath = join(w.workdir, "hooks-disabled")
    const unexpected = join(hooksPath, "unexpected-hook")
    mkdirSync(hooksPath, { recursive: true })
    writeFileSync(unexpected, "must not run\n")

    await expect(queueRun(await w.options({ exit: 0 }))).rejects.toThrow(
      `queue-owned hooks path ${hooksPath} is not empty (unexpected-hook); remove the named entries, then run yrd queue run`,
    )
  })

  it("pass: the change is checked, merged, the target moves by one merge commit, and the submitter is told to close their bead", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const secondHead = await submitCommit(w, "task/two", "two.txt")
    const selection = await resolveGitSelection(w.work)

    const outcome = await queueRun({
      ...(await w.options({ exit: 0 })),
      selection,
      checks: [
        {
          name: "verify",
          on: ["submit", "merge"],
          run: 'if test -f one.txt; then cat one.txt; else cat two.txt; fi; printf "%s\\n" "$YRD_CANDIDATE_SHA"',
        },
      ],
    })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/one"])
    expect(outcome.directMerges).toEqual([])
    // Two changes in this SAME run and phase must not share an artifact.
    // This preserves the class witness removed with the old attribution suite.
    const oneLog = checkLogFor(outcome, "task/one", "submit", "verify")
    const twoLog = checkLogFor(outcome, "task/two", "submit", "verify")
    expect(oneLog).not.toBe(twoLog)
    expect(oneLog).toContain(changeName({ branch: "task/one", head }))
    expect(twoLog).toContain(changeName({ branch: "task/two", head: secondHead }))
    const oneOutput = readFileSync(oneLog, "utf8").trim().split("\n")
    const twoOutput = readFileSync(twoLog, "utf8").trim().split("\n")
    expect(oneOutput).toEqual(["one.txt", expect.stringMatching(/^[0-9a-f]{40}$/u)])
    expect(twoOutput).toEqual(["two.txt", expect.stringMatching(/^[0-9a-f]{40}$/u)])
    const after = await remoteTarget(w)
    expect(after).not.toBe(w.target)
    await w.git(["fetch", "--quiet", "origin", "main"])
    const parents = (await w.git(["rev-list", "--parents", "-n", "1", after])).trim().split(/\s+/u).slice(1)
    expect(parents).toEqual([w.target, head])
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/main/*:refs/yrd/main/*"])
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    // checked after the on-submit phase, merged after the on-merge phase, sent last.
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked", "merged", "sent"])
    // The queue list row names the merge commit and its base in full, for whoever proves a merge by ancestry.
    const row = list((await readQueue(w.git, "origin", "main", after)).changes).find(
      (candidate) => candidate.branch === "task/one",
    )
    expect(row?.state).toBe("merged")
    expect(row?.merge).toBe(after)
    expect(row?.base).toBe(w.target)
    const sent = messages(w)
    expect(sent).toHaveLength(1)
    // The record a notify entry reads names the ending: which record, which change,
    // who submitted it, what it is for, and the merge it made. No id, because
    // the change and the ending are the message's identity; no prose, because
    // the entry composes what it says.
    expect(sent[0]).toEqual({
      change: changeName({ branch: "task/one", head }),
      record: "merged",
      issue: "@i/10-yrd/1",
      merge: await remoteTarget(w),
      submitter: "@dev/2",
    })
    expect(
      readFileSync(outcome.log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { kind: string }).kind),
    ).toEqual(expect.arrayContaining(["run", "change", "check", "result", "merge", "message"]))
    // Addendum 2/T1: every ordinary run invocation is linked before the run
    // summarizes it, including successful calls rebound to a worktree.
    const runRecords = logRecords(outcome)
    const invocations = runRecords.filter((record) => record.kind === "git")
    expect(invocations.length).toBeGreaterThan(0)
    expect(invocations.some((record) => record.cwd !== w.work)).toBe(true)
    const checkedHeads: string[] = []
    const checkedBases: string[] = []
    for (const invocation of invocations) {
      expect(invocation).toMatchObject({ executable: selection.executable, contract: "native", complete: true })
      const evidence = JSON.parse(readFileSync(String(invocation.evidence), "utf8")) as {
        selection: typeof selection
        artifacts: { stdout: string; stderr: string }
      }
      expect(evidence.selection).toEqual(selection)
      expect(existsSync(evidence.artifacts.stdout)).toBe(true)
      expect(existsSync(evidence.artifacts.stderr)).toBe(true)
      if (
        invocation.cwd !== w.work &&
        Array.isArray(invocation.args) &&
        invocation.args.join(" ") === "rev-parse HEAD"
      ) {
        checkedHeads.push(readFileSync(evidence.artifacts.stdout, "utf8").trim())
      }
      if (invocation.cwd !== w.work && Array.isArray(invocation.args) && invocation.args[0] === "merge-base") {
        expect(readFileSync(evidence.artifacts.stdout, "utf8").trim()).toBe(w.target)
        checkedBases.push(String(invocation.args[1]))
      }
    }
    // D1/T1: worktree facts that identify each checked commit must retain the
    // same selection/evidence. Other rebound calls alone missed this escape.
    const judged = new Set([oneOutput[1], twoOutput[1], after])
    expect(new Set(checkedHeads)).toEqual(judged)
    expect(new Set(checkedBases)).toEqual(judged)
    // The final re-read must be evidenced after preparation too: its candidate
    // can equal the prepared commit, so a set of OIDs cannot prove this boundary.
    const mergeCheck = runRecords.findIndex(
      (record) => record.kind === "check" && record.phase === "merge" && record.end === undefined,
    )
    expect(mergeCheck).toBeGreaterThan(0)
    const beforeMergeCheck = runRecords
      .slice(0, mergeCheck)
      .filter((record) => record.kind === "git")
      .slice(-2)
    expect(beforeMergeCheck.map((record) => record.args)).toEqual([
      ["rev-parse", "HEAD"],
      ["merge-base", after, w.target],
    ])
    expect(beforeMergeCheck[0]?.cwd).toBe(beforeMergeCheck[1]?.cwd)
    expect(beforeMergeCheck[0]?.cwd).not.toBe(w.work)
  })

  it.each([
    ["checked", "diverged", 1],
    ["sent", "diverged", 1],
    ["sent", "behind", 1],
    ["sent", "equal", 1],
    ["sent", "ahead", 1],
    ["sent", "unknown", 1],
    ["sent", "diverged", 2],
  ] as const)(
    "a second writer racing the %s record (%s, %i refusals) preserves records and explains the tips (24096)",
    async (kind, relation, refusals) => {
      const w = await world()
      const head = await submitCommit(w, "task/one", "one.txt")
      const ref = changeRef("main", { branch: "task/one", head })
      const rivalPath = join(w.workdir, "..", "record-rival")
      await gitIn(join(w.workdir, ".."))(["clone", "--quiet", w.remote, rivalPath])
      const rival = gitIn(rivalPath)
      await rival(["config", "user.email", "rival@yrd.test"])
      await rival(["config", "user.name", "rival"])

      let concurrent: string | undefined
      let intended: string | undefined
      let raced = 0
      const git: Git = async (args, input) => {
        if (relation === "unknown" && args[0] === "merge-base" && args[1] === intended && args[2] === concurrent) {
          throw new Error("diagnostic ancestry read unavailable")
        }
        // Between the tip this run read the change at and its leased push, a
        // second queue appends a record of its own and pushes it first. A real
        // writer at the real remote, not a reading of this one's argv.
        const refspec = args.find((arg) => arg.endsWith(`:${ref}`))
        if (
          raced < refusals &&
          args.some((arg) => arg.startsWith(`--force-with-lease=${ref}:`)) &&
          refspec !== undefined &&
          (await readRecord(w.git, refspec.slice(0, -ref.length - 1))).kind === kind
        ) {
          raced += 1
          intended = refspec.slice(0, -ref.length - 1)
          await rival(["fetch", "--quiet", "origin", `${ref}:${ref}`])
          const previous = (await rival(["rev-parse", ref])).trim()
          if (relation === "behind" || relation === "equal" || relation === "ahead") {
            // A real second writer already has our intended record (or has
            // appended after it), but our captured lease still names its parent.
            await rival(["fetch", "--quiet", w.work, intended])
            await rival(["update-ref", ref, intended])
          }
          concurrent =
            relation === "ahead"
              ? (await rival(["rev-parse", `${intended}^^`])).trim()
              : relation === "equal"
                ? intended
                : await appendRecord(rival, "main", {
                    change: { branch: "task/one", head },
                    kind: "stuck",
                    subject: "another queue got there first",
                    trailers: [["Reason", "crash"]],
                  })
          // Only the disposable fixture's remote rewinds, under its exact
          // previous value, to exercise an external writer moving backwards.
          await rival([
            "push",
            "--quiet",
            ...(relation === "ahead" ? [`--force-with-lease=${ref}:${previous}`] : []),
            "origin",
            `${concurrent}:${ref}`,
          ])
        }
        return w.git(args, input)
      }

      const outcome = await queueRun({ ...(await w.options({ exit: 0, on: ["submit"] })), git })

      // The lease refused the first push, so the rival's record stands; the same
      // record was written again onto it and pushed, so neither is lost and the
      // run went on to merge.
      expect(outcome.exitCode).toBe(0)
      expect(outcome.merged).toEqual(["task/one"])
      await fetchChanges(w)
      const records = await readRecords(w.git, (await refAt(w.git, ref))!)
      expect(records.map((record) => record.kind)).toEqual(
        kind === "checked"
          ? ["opened", "stuck", "checked", "merged", "sent"]
          : relation === "equal"
            ? ["opened", "checked", "merged", "sent"]
            : relation === "ahead"
              ? ["opened", "checked", "sent"]
              : relation === "behind"
                ? ["opened", "checked", "merged", "sent", "stuck", "sent"]
                : refusals === 2
                  ? ["opened", "checked", "merged", "stuck", "stuck"]
                  : ["opened", "checked", "merged", "stuck", "sent"],
      )
      expect(records.map((record) => record.sha)).toContain(concurrent)
      expect(intended).toMatch(/^[0-9a-f]{40}$/u)
      if (relation === "equal") {
        // Git accepts an already-equal ref as up-to-date, even with the old
        // lease. There was no rejected write to diagnose or retry.
        expect(logRecords(outcome).filter((record) => record.reason === "change-ref-taken")).toEqual([])
        return
      }
      expect(logRecords(outcome)).toContainEqual(
        expect.objectContaining({
          decision: kind,
          reason: "change-ref-taken",
          ref,
          remote: concurrent,
          intended,
          relation,
        }),
      )
      const diagnostic = logRecords(outcome).findLast((record) => record.reason === "change-ref-taken")
      expect(diagnostic).not.toHaveProperty("next")
      expect(diagnostic?.text).toBe(
        `${ref}: remote ${concurrent}, intended ${intended} (${relation})${relation === "unknown" ? "; ancestry read failed: diagnostic ancestry read unavailable" : ""}; inspect: ${String(diagnostic?.inspect)}`,
      )
      // The diagnostic's read is executable in the emitting state, using the
      // exact fetched objects even though the remote ref has moved again.
      const read = spawnSync("sh", ["-c", String(diagnostic?.inspect)], { encoding: "utf8" })
      expect(read.status, read.stderr).toBe(0)
      if (relation === "ahead") expect(read.stdout).toMatch(/^</mu)
      else expect(read.stdout).toMatch(/^>/mu)
      if (relation === "diverged" || relation === "unknown") expect(read.stdout).toMatch(/^</mu)
      if (relation === "unknown") expect(diagnostic?.error).toBe("diagnostic ancestry read unavailable")
      if (refusals === 2) {
        expect(logRecords(outcome)).toContainEqual(
          expect.objectContaining({ reason: "change-ref-contended", ref, remote: concurrent, intended, relation }),
        )
        expect(logRecords(outcome)).toContainEqual(
          expect.objectContaining({ kind: "message", delivered: false, says: "merged" }),
        )
      }
    },
  )

  it("a refused record push with an unchanged remote tip rethrows its original error", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const ref = changeRef("main", { branch: "task/one", head })
    const before = (await w.git(["ls-remote", "--refs", "origin", ref])).trim().split(/\s+/u)[0]
    const refused = new Error("record transport refused")
    const git: Git = async (args, input) => {
      if (args[0] === "push" && args.some((arg) => arg.startsWith(`--force-with-lease=${ref}:`))) throw refused
      return w.git(args, input)
    }

    await expect(queueRun({ ...(await w.options({ exit: 0, on: ["submit"] })), git })).rejects.toBe(refused)
    expect((await w.git(["ls-remote", "--refs", "origin", ref])).trim().split(/\s+/u)[0]).toBe(before)
    expect(await remoteTarget(w)).toBe(w.target)
  })

  it("fail: the target stands still, the change ends failed with the check and a remedy, and the submitter gets it back", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(await w.options({ exit: 1 }))

    expect(outcome.exitCode).toBe(1)
    expect(outcome.failed).toEqual(["task/one"])
    expect(await remoteTarget(w)).toBe(w.target)
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/main/*:refs/yrd/main/*"])
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked", "failed", "sent"])
    expect(records[2]?.trailers).toEqual(
      expect.arrayContaining([
        ["Reason", "verify"],
        ["Fault", "submitter"],
      ]),
    )
    expect(messages(w)[0]).toEqual({
      change: changeName({ branch: "task/one", head }),
      record: "failed",
      failures: 1,
      issue: "@i/10-yrd/1",
      log: expect.stringContaining("verify.log"),
      reason: "verify",
      submitter: "@dev/2",
    })
  })

  it("stuck: a check that exits 2 stops the run, bills nobody, and is an ending of its own", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(await w.options({ exit: 2 }))

    expect(outcome.exitCode).toBe(2)
    expect(outcome.stuck).toEqual(["task/one"])
    expect(await remoteTarget(w)).toBe(w.target)
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/main/*:refs/yrd/main/*"])
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked", "stuck", "sent"])
    const incident = incidentOf(records[2])
    expect(incident).toMatchObject({
      Code: "yrd-check-unresolved",
      Subject: expect.stringContaining("verify"),
      Via: expect.stringContaining(outcome.run),
    })
    expect(isAbsolute(incident.Evidence)).toBe(true)
    expect(existsSync(incident.Evidence)).toBe(true)
    expect(incident.Next).toContain("yrd queue run")
    expect(records[2]?.trailers.filter(([name]) => name === "Reason" || name === "Fault" || name === "Cause")).toEqual(
      [],
    )
    expect(records[3]?.trailers).toEqual(
      expect.arrayContaining([
        ["To", "recorder"],
        ["State", "stuck"],
      ]),
    )
    expect(incidentOf(records[3])).toEqual(incident)
    expect(messages(w)[0]).toMatchObject({
      change: changeName({ branch: "task/one", head }),
      record: "stuck",
      log: expect.stringContaining("verify.log"),
      reason: expect.stringContaining("could not judge task/one"),
    })
    expect(messages(w)[0]?.failures).toBeUndefined()
  })

  it("git-super stuck preserves its worktree and carries complete failure evidence to the journal and supervisor", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/git-super-stuck", "git-super-stuck.txt")
    const bin = join(w.workdir, "bin")
    const invocationLog = join(w.workdir, "git-super-invocation.json")
    mkdirSync(bin, { recursive: true })
    const stderrTail = `hook stderr start\n${"checkout drift ".repeat(400)}\nhook stderr end`
    const detail = {
      code: "settled-merge-commit-failed",
      phase: "write-settled-merge",
      message: `settled-merge-commit-failed: the candidate merge could not be committed\n${stderrTail}`,
      subject: "the candidate merge could not be committed",
      evidence: `git -C ${w.work} status --short`,
      next: "repair the queue checkout, then run yrd queue run",
    }
    const result = {
      state: "failed",
      partial: true,
      detail,
      gitlinks: [],
      repositories: [{ repository: w.work, state: "failed", refs: [] }],
    }
    const fakeGitSuper = join(bin, "git-super")
    writeFileSync(
      fakeGitSuper,
      `#!/usr/bin/env bun\nimport { spawnSync } from "node:child_process"\nimport { writeFileSync } from "node:fs"\nconst hooksPath = spawnSync("git", ["config", "--get", "core.hooksPath"], { encoding: "utf8" }).stdout.trim()\nwriteFileSync(${JSON.stringify(invocationLog)}, JSON.stringify({ argv: process.argv.slice(2), hooksPath }))\nprocess.stdout.write(${JSON.stringify(`${JSON.stringify(result)}\n`)})\nprocess.exit(2)\n`,
    )
    chmodSync(fakeGitSuper, 0o755)
    const base = await w.options({ exit: 0 })

    const outcome = await queueRun({
      ...base,
      env: { ...base.env, PATH: `${bin}:${base.env?.PATH ?? process.env.PATH ?? ""}` },
    })

    expect(outcome).toMatchObject({ exitCode: 2, failed: [], merged: [], stuck: ["task/git-super-stuck"] })
    const composing = join(w.workdir, "worktrees", outcome.run, "compose", "submit", head.slice(0, 12))
    const hooksPath = join(w.workdir, "hooks-disabled")
    const invocation = JSON.parse(readFileSync(invocationLog, "utf8")) as {
      argv: string[]
      hooksPath: string
    }
    expect(invocation.argv).not.toContain("--no-verify")
    expect(invocation.hooksPath).toBe(hooksPath)
    expect(existsSync(hooksPath)).toBe(true)
    expect(readdirSync(hooksPath)).toEqual([])
    expect(existsSync(composing)).toBe(true)
    await fetchChanges(w)
    const records = await readRecords(
      w.git,
      (await refAt(w.git, changeRef("main", { branch: "task/git-super-stuck", head })))!,
    )
    const stuck = records.find((record) => record.kind === "stuck")
    const incident = incidentOf(stuck)
    expect(incident.Subject).toContain("hook stderr start")
    expect(incident.Subject).toContain("hook stderr end")
    expect(incident.Subject).toContain("checkout drift ".repeat(400).trim())
    expect(incident.Via).toContain(composing)
    const journal = logRecords(outcome).find(
      (record) => record.kind === "change" && record.decision === "stuck" && record.branch === "task/git-super-stuck",
    )
    expect(journal).toMatchObject({
      code: incident.Code,
      diagnosisCode: detail.code,
      subject: incident.Subject,
      via: incident.Via,
      evidence: incident.Evidence,
      next: incident.Next,
      detail: detail.message,
      worktree: composing,
    })
    expect(messages(w)[0]).toMatchObject({
      change: changeName({ branch: "task/git-super-stuck", head }),
      record: "stuck",
      reason: incident.Subject,
    })
    expect(messages(w)[0]?.reason).toContain("hook stderr end")
  })

  it("runs every notify entry that wants this ending, once each, and writes one sent record per entry", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    // Two entries want `merged`; a third wants only `stuck` and must not run.
    const outcome = await queueRun({
      ...(await w.options({ exit: 0 })),
      notify: [
        { name: "submitter", on: ["merged", "failed"], run: `${w.notifier} submitter` },
        { name: "board", on: ["merged"], run: `${w.notifier} board` },
        { name: "supervisor", on: ["stuck"], run: `${w.notifier} supervisor` },
      ],
    })

    expect(outcome.merged).toEqual(["task/one"])
    expect(messages(w).map((message) => message.record)).toEqual(["merged", "merged"])
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/main/*:refs/yrd/main/*"])
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked", "merged", "sent", "sent"])
    // One sent record per entry, each naming the entry it is about.
    expect(records.slice(-2).map((record) => trailer(record, "To"))).toEqual(["submitter", "board"])
    expect(records.slice(-2).map((record) => trailer(record, "Delivery"))).toEqual(["sent", "sent"])
    const merged = records[2]
    const firstSent = records[3]
    const secondSent = records[4]
    if (merged === undefined || firstSent === undefined || secondSent === undefined) throw new Error("missing record")
    expect(records.slice(-2).map((record) => trailer(record, "For"))).toEqual([merged.sha, merged.sha])
    expect(records.slice(-2).map((record) => trailer(record, "Message-Id"))).toEqual([merged.sha, merged.sha])
    expect((await w.git(["rev-parse", `${firstSent.sha}^`])).trim()).toBe(merged.sha)
    expect((await w.git(["rev-parse", `${secondSent.sha}^`])).trim()).toBe(firstSent.sha)
  })

  it("two refused sent appends leave both notifier results visibly unrecorded without guessing a parent", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const ref = changeRef("main", { branch: "task/one", head })
    const rivalPath = join(w.workdir, "..", "sent-record-rival")
    await gitIn(join(w.workdir, ".."))(["clone", "--quiet", w.remote, rivalPath])
    const rival = gitIn(rivalPath)
    await rival(["config", "user.email", "rival@yrd.test"])
    await rival(["config", "user.name", "rival"])

    let mergePushed = false
    const attempted: string[] = []
    const competing: string[] = []
    const git: Git = async (args, input) => {
      if (args.includes("--atomic") && args.some((arg) => arg.endsWith(":refs/heads/main"))) mergePushed = true
      const recordPush =
        mergePushed &&
        args[0] === "push" &&
        !args.includes("--atomic") &&
        args.some((arg) => arg.startsWith(`--force-with-lease=${ref}:`))
      if (recordPush) {
        const refspec = args.find((arg) => arg.endsWith(`:${ref}`))
        const record = refspec?.slice(0, -`:${ref}`.length)
        if (record === undefined || record === "") throw new Error("sent push names no record")
        attempted.push(record)
        await rival(["fetch", "--quiet", "origin", `${ref}:${ref}`])
        const competingRecord = await appendRecord(rival, "main", {
          change: { branch: "task/one", head },
          kind: "stuck",
          subject: `rival sent append ${String(competing.length + 1)}`,
          trailers: [["Reason", "crash"]],
        })
        await rival(["push", "--quiet", "origin", `${competingRecord}:${ref}`])
        competing.push(competingRecord)
      }
      return w.git(args, input)
    }

    const outcome = await queueRun({
      ...(await w.options({ exit: 0 })),
      git,
      notify: [
        { name: "first", on: ["merged"], run: w.notifier },
        { name: "second", on: ["merged"], run: w.notifier },
      ],
    })

    expect(messages(w)).toHaveLength(2)
    expect(attempted).toHaveLength(2)
    expect(competing).toHaveLength(2)
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, ref))!)
    const merged = records.find((record) => record.kind === "merged")
    if (merged === undefined) throw new Error("missing merged record")
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked", "merged", "stuck", "stuck"])
    expect(records.slice(-2).map((record) => record.sha)).toEqual(competing)
    const rows = logRecords(outcome).filter((record) => record.kind === "message")
    expect(rows.map(({ delivered, id, to }) => ({ delivered, id, to }))).toEqual([
      { delivered: false, id: merged.sha, to: "first" },
      { delivered: false, id: merged.sha, to: "second" },
    ])
    expect(rows.map((row) => row.error)).toEqual([
      expect.stringContaining("after its append contended"),
      expect.stringContaining("after a prior sent append contended"),
    ])
  })

  it("an ending nobody wants records none once, and a newly declared recipient is still owed", async () => {
    // Silence and "nobody was told" read the same in a log that writes nothing,
    // so the queue writes the second one down.
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    await queueRun({
      ...(await w.options({ exit: 0 })),
      notify: [{ name: "supervisor", on: ["stuck"], run: w.notifier }],
    })

    expect(messages(w)).toEqual([])
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/main/*:refs/yrd/main/*"])
    const ref = changeRef("main", { branch: "task/one", head })
    const records = await readRecords(w.git, (await refAt(w.git, ref))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked", "merged", "sent"])
    expect(records.at(-1)?.trailers).toEqual(
      expect.arrayContaining([
        ["To", "none"],
        ["Delivery", "none"],
        ["State", "merged"],
      ]),
    )
    const [merged, none] = [records[2]!, records[3]!]
    // An unchanged declaration neither sends nor records `none` a second time.
    const unchanged = await queueRun({
      ...(await w.options({ exit: 0 })),
      notify: [{ name: "supervisor", on: ["stuck"], run: w.notifier }],
    })
    expect(logRecords(unchanged).filter((record) => record.kind === "message")).toEqual([])
    expect(await refAt(gitIn(w.remote), ref)).toBe(none.sha)
    // `none` describes the old declaration; a newly wanted recipient is owed E.
    const added = await queueRun({
      ...(await w.options({ exit: 0 })),
      notify: [{ name: "recorder", on: ["merged"], run: w.notifier }],
    })
    expect(
      logRecords(added)
        .filter((record) => record.kind === "message")
        .map(({ delivered, id, to }) => ({ delivered, id, to })),
    ).toEqual([{ delivered: true, id: merged.sha, to: "recorder" }])
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/main/*:refs/yrd/main/*"])
    const receipt = (await readRecords(w.git, (await refAt(w.git, ref))!)).at(-1)!
    expect(receipt.kind).toBe("sent")
    expect(["To", "Delivery", "For", "Message-Id"].map((name) => trailer(receipt, name))).toEqual([
      "recorder",
      "sent",
      merged.sha,
      merged.sha,
    ])
    expect((await w.git(["rev-parse", `${receipt.sha}^`])).trim()).toBe(none.sha)
  })

  it("a check past its bound is stuck, not the submitter's", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(await w.options({ sleep: 3, timeoutMs: 500 }))

    expect(outcome.exitCode).toBe(2)
    expect(String(logRecords(outcome).find((record) => record.kind === "message")?.text)).toMatch(/ran past its bound/u)
  })

  it("a check declaring a scripts: path the target does not carry is loud: the change ends stuck and names it (D5)", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const base = await w.options({ on: ["submit"] })

    const outcome = await queueRun({
      ...base,
      checks: base.checks.map((check) => ({ ...check, scripts: ["checks/absent.sh"] })),
    })

    // A check the queue cannot restore from the protected side is the queue's
    // own ground missing, never the submitter's: stuck, and nobody is billed.
    expect(outcome.exitCode).toBe(2)
    expect(outcome.stuck).toEqual(["task/one"])
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "stuck", "sent"])
    expect(records[1]?.subject).toContain("checks/absent.sh")
    expect(messages(w)[0]).toMatchObject({ record: "stuck" })
    expect(String(logRecords(outcome).find((record) => record.kind === "message")?.text)).toContain("does not carry")
  })

  it("POSITIVE CONTROL: a declared scripts: path the target does carry is restored and judged (D5)", async () => {
    // Without this, the loud case above is satisfied just as well by a
    // `scripts:` list that can never be restored at all.
    const w = await world()
    const base = await w.options({ exit: 0, on: ["submit"] })
    await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun({
      ...base,
      checks: base.checks.map((check) => ({ ...check, scripts: [".yrd.yml"] })),
    })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/one"])
  })

  it("a check whose child exits 0 while a descendant holds its output open is stuck, not pass", async () => {
    // The live wedge shape: `sh` exits 0 immediately and the backgrounded sleep
    // inherits the run's stdout, so the driver abandons the drain at its grace
    // and hands back exit 0 with a partial log. Read as an exit code alone,
    // that is a pass on a check nobody measured.
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const base = await w.options({ on: ["submit"] })

    const outcome = await queueRun({
      ...base,
      checks: base.checks.map((check) => ({ ...check, run: "sleep 30 & exit 0" })),
    })

    expect(outcome.exitCode).toBe(2)
    expect(outcome.stuck).toEqual(["task/one"])
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "stuck", "sent"])
    const wedged = records[1]
    if (wedged === undefined) throw new Error("no stuck record")
    expect(wedged.subject).toContain("held its output open")
    // The condition is named, and so is the partial log the check did write.
    const check = trailers(wedged, "Check")[0] ?? ""
    expect(check).toContain("exit=unsettled")
    expect(existsSync(check.match(/log=(\S+)/u)?.[1] ?? "")).toBe(true)
  }, 30_000)

  it("the target moving between the merge reading and the lease keeps the change checked, not stuck (D4)", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const rivalPath = join(w.workdir, "..", "target-mover")
    await gitIn(join(w.workdir, ".."))(["clone", "--quiet", w.remote, rivalPath])
    const rival = gitIn(rivalPath)
    await rival(["config", "user.email", "rival@yrd.test"])
    await rival(["config", "user.name", "rival"])

    let moved: string | undefined
    const git: Git = async (args, input) => {
      // The window the lease exists for: the run has read the remote heads and
      // is about to push, and somebody else merges onto the target in between.
      if (moved === undefined && args.includes("--atomic") && args.some((arg) => arg.endsWith(":refs/heads/main"))) {
        writeFileSync(join(rivalPath, "rival.txt"), "rival\n")
        await rival(["add", "rival.txt"])
        await rival(["commit", "--quiet", "-m", "the target moved under the change"])
        await rival(["push", "--quiet", "origin", "main"])
        moved = (await rival(["rev-parse", "HEAD"])).trim()
      }
      return w.git(args, input)
    }

    const outcome = await queueRun({ ...(await w.options({ exit: 0 })), git })

    // The change keeps its place and is judged again at the new target next
    // run: nothing merged, nothing ended, and nobody was told anything.
    expect(outcome.exitCode).toBe(0)
    expect(outcome.stuck).toEqual([])
    expect(outcome.merged).toEqual([])
    expect(await remoteTarget(w)).toBe(moved)
    await fetchChanges(w)
    expect(
      (await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)).map(
        (record) => record.kind,
      ),
    ).toEqual(["opened", "checked"])
    expect(messages(w)).toEqual([])
    expect(logRecords(outcome)).toContainEqual(
      expect.objectContaining({ decision: "checked", reason: "target-moved", saw: moved }),
    )
  })

  it("a change tip moving before the atomic merge loses neither history nor the target", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const ref = changeRef("main", { branch: "task/one", head })
    const rivalPath = join(w.workdir, "..", "change-tip-mover")
    await gitIn(join(w.workdir, ".."))(["clone", "--quiet", w.remote, rivalPath])
    const rival = gitIn(rivalPath)
    await rival(["config", "user.email", "rival@yrd.test"])
    await rival(["config", "user.name", "rival"])

    let expected = ""
    let moved: string | undefined
    const git: Git = async (args, input) => {
      if (moved === undefined && args.includes("--atomic") && args.some((arg) => arg.endsWith(":refs/heads/main"))) {
        expected = (await rival(["ls-remote", "--refs", "origin", ref])).trim().split(/\s+/u)[0] ?? ""
        await rival(["fetch", "--quiet", "origin", `${ref}:${ref}`])
        moved = await appendRecord(rival, "main", {
          change: { branch: "task/one", head },
          kind: "stuck",
          subject: "another queue got there first",
          trailers: [["Reason", "crash"]],
        })
        await rival(["push", "--quiet", "origin", `${moved}:${ref}`])
      }
      return w.git(args, input)
    }

    const outcome = await queueRun({ ...(await w.options({ exit: 0 })), git })

    expect(moved).toBeDefined()
    expect(outcome.merged).toEqual([])
    expect(await remoteTarget(w)).toBe(w.target)
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, ref))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked", "stuck"])
    expect(records.at(-1)?.sha).toBe(moved)
    expect(logRecords(outcome)).toContainEqual(
      expect.objectContaining({ decision: "checked", expected, reason: "change-ref-moved", saw: moved }),
    )
  })

  it("a pause leaves admitted work queued without checks, and resume lets the next run merge it", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const paused = await writePause(w.git, "origin", "main", {
      by: "@chief",
      kind: "paused",
      reason: "main needs repair",
    })

    const held = await queueRun(await w.options({ exit: 0 }))

    expect(held.exitCode).toBe(0)
    expect(held.stopped?.what).toEqual(paused)
    expect(held.merged).toEqual([])
    expect(await remoteTarget(w)).toBe(w.target)
    await fetchChanges(w)
    expect(
      (await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)).map(
        (record) => record.kind,
      ),
    ).toEqual(["opened"])
    expect(logRecords(held)).toContainEqual(
      expect.objectContaining({ by: "@chief", kind: "pause", reason: "main needs repair", state: "paused" }),
    )

    await writePause(w.git, "origin", "main", { by: "@chief", kind: "resumed", reason: "repair merged" })
    const resumed = await queueRun(await w.options({ exit: 0 }))
    expect(resumed.merged).toEqual(["task/one"])
  })

  it("a foreground run merges admitted work with fresh fences and preserves the original pause facts", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")
    await submitCommit(w, "task/two", "two.txt")
    const dated = gitIn(
      w.work,
      createProcess({
        cwd: w.work,
        env: gitEnvironment({
          ...process.env,
          GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
        }),
      }),
    )
    const paused = await writePause(dated, "origin", "main", {
      by: "@chief",
      kind: "paused",
      reason: "inspect admitted set",
    })

    const outcome = await queueRun({ ...(await w.options({ exit: 0 })), foreground: true })

    expect(outcome.merged).toEqual(["task/one"])
    expect(outcome.stopped).toBeUndefined()
    const next = await queueRun({ ...(await w.options({ exit: 0 })), foreground: true })
    expect(next.merged).toEqual(["task/two"])
    const after = await readPause(w.git, "origin", "main")
    expect(after).toMatchObject({ at: paused.at, by: paused.by, reason: paused.reason, kind: "paused" })
    expect(after?.sha).not.toBe(paused.sha)
    expect((await w.git(["rev-list", "--count", `${paused.sha}..${after?.sha}`])).trim()).toBe("2")
    expect(logRecords(outcome)).toContainEqual(
      expect.objectContaining({
        kind: "pause",
        reason: paused.reason,
        by: paused.by,
        since: paused.at.toISOString(),
        state: "paused",
      }),
    )
    const automatic = await queueRun(await w.options({ exit: 0 }))
    expect(automatic.stopped?.what).toEqual(after)
  })

  it.each(["before-fence", "before-push"])(
    "a changed pause %s stops a foreground merge and preserves all remote refs",
    async (when) => {
      const w = await world()
      const head = await submitCommit(w, "task/one", "one.txt")
      await writePause(w.git, "origin", "main", { by: "@chief", kind: "paused", reason: "initial pause" })
      const ref = changeRef("main", { branch: "task/one", head })
      let reads = 0
      let raced: PauseRecord | undefined
      let changeBefore = ""
      const git: Git = async (args, input) => {
        if (args[0] === "ls-remote" && args.includes(PAUSE_REF)) reads += 1
        // Admission now comes from readQueue's broad captured advertisement;
        // this is the first separate pause read, immediately before the fence.
        const fence = when === "before-fence" && args[0] === "ls-remote" && args.includes(PAUSE_REF) && reads === 1
        const push =
          when === "before-push" && args.includes("--atomic") && args.some((arg) => arg.endsWith(":refs/heads/main"))
        if (raced === undefined && (fence || push)) {
          changeBefore = (await w.git(["ls-remote", "--refs", "origin", ref])).trim().split(/\s+/u)[0] ?? ""
          await writePause(w.git, "origin", "main", { by: "operator", kind: "resumed", reason: "new decision" })
          raced = await writePause(w.git, "origin", "main", {
            by: "operator",
            kind: "paused",
            reason: "stop this round",
          })
        }
        return w.git(args, input)
      }
      const outcome = await queueRun({ ...(await w.options({ exit: 0 })), foreground: true, git })
      expect(raced?.reason).toBe("stop this round")
      expect(outcome.merged).toEqual([])
      expect(outcome.stopped?.what).toEqual(raced)
      expect(await remoteTarget(w)).toBe(w.target)
      expect((await w.git(["ls-remote", "--refs", "origin", ref])).trim().split(/\s+/u)[0]).toBe(changeBefore)
      expect(await readPause(w.git, "origin", "main")).toEqual(raced)
    },
  )

  it("a paused run reaps and reports direct merges without retiring, catching up, resending, or judging changes", async () => {
    const w = await world()
    const queued = await submitCommit(w, "task/queued", "queued.txt")
    const deleted = await submitCommit(w, "task/deleted", "deleted.txt")
    const caughtUp = await submitCommit(w, "task/caught-up", "caught-up.txt")

    // One change is already on the target but has no merged record, so catch-up
    // would mutate it; the merge itself is also a direct merge the paused run owes.
    await w.git(["merge", "--quiet", "--no-ff", "--no-edit", "-m", "merged around the queue", caughtUp])
    const direct = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["push", "--quiet", "origin", "main"])

    // One ended change has no sent record, so resend would mutate it.
    const unsent = await submitCommit(w, "task/unsent", "unsent.txt")
    const unsentRef = changeRef("main", { branch: "task/unsent", head: unsent })
    const failed = await appendRecord(w.git, "main", {
      change: { branch: "task/unsent", head: unsent },
      kind: "failed",
      subject: "task/unsent failed verify",
      trailers: [["Reason", "verify"]],
    })
    await w.git(["push", "--quiet", "origin", `${failed}:${unsentRef}`])

    // One admitted branch is gone, so retirement would append a failed record;
    // another remains queued, so the submit phase would judge it.
    await w.git(["push", "--quiet", "origin", ":refs/heads/task/deleted"])
    const dead = await worktreeOfRun(w, "q-dead-paused", exitedPid())
    const paused = await writePause(w.git, "origin", "main", {
      by: "@chief",
      kind: "paused",
      reason: "inspect the target",
    })

    const held = await queueRun(await w.options({ exit: 0 }))

    expect(held).toMatchObject({ directMerges: [direct], exitCode: 0, failed: [], merged: [], stuck: [] })
    expect(held.stopped?.what).toEqual(paused)
    expect(existsSync(dead)).toBe(false)
    expect(logRecords(held).filter((record) => record.kind === "reap")).toHaveLength(1)
    expect(logRecords(held).filter((record) => record.kind === "merged-direct")).toHaveLength(1)
    expect(logRecords(held).filter((record) => record.kind === "change")).toEqual([])
    expect(whereRan(w)).toEqual([])
    expect(await remoteTarget(w)).toBe(direct)
    await fetchChanges(w)
    expect(
      (await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/queued", head: queued })))!)).map(
        (record) => record.kind,
      ),
    ).toEqual(["opened"])
    expect(
      (
        await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/deleted", head: deleted })))!)
      ).map((record) => record.kind),
    ).toEqual(["opened"])
    expect(
      (
        await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/caught-up", head: caughtUp })))!)
      ).map((record) => record.kind),
    ).toEqual(["opened"])
    expect(
      (await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/unsent", head: unsent })))!)).map(
        (record) => record.kind,
      ),
    ).toEqual(["opened", "failed"])
    expect(messages(w)).toEqual([{ change: direct, record: "merged-direct" }])
  })

  it("a pause placed after the last read but before the atomic merge push blocks every ref advance", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const ref = changeRef("main", { branch: "task/one", head })
    const rivalPath = join(w.workdir, "..", "pause-rival")
    await gitIn(join(w.workdir, ".."))(["clone", "--quiet", w.remote, rivalPath])
    const rival = gitIn(rivalPath)
    await rival(["config", "user.email", "rival@yrd.test"])
    await rival(["config", "user.name", "rival"])

    let paused: PauseRecord | undefined
    let targetBeforePush = ""
    let changeBeforePush = ""
    const git: Git = async (args, input) => {
      if (paused === undefined && args.includes("--atomic") && args.some((arg) => arg.endsWith(":refs/heads/main"))) {
        targetBeforePush = await remoteTarget(w)
        changeBeforePush = (await w.git(["ls-remote", "--refs", "origin", ref])).trim().split(/\s+/u)[0] ?? ""
        paused = await writePause(rival, "origin", "main", {
          by: "operator",
          kind: "paused",
          reason: "stop before merge",
        })
      }
      return await w.git(args, input)
    }

    const outcome = await queueRun({ ...(await w.options({ exit: 0 })), git })

    expect(paused).toBeDefined()
    expect(outcome.stopped?.what).toEqual(paused)
    expect(outcome.merged).toEqual([])
    expect(await remoteTarget(w)).toBe(targetBeforePush)
    expect((await w.git(["ls-remote", "--refs", "origin", ref])).trim().split(/\s+/u)[0]).toBe(changeBeforePush)
    await fetchChanges(w)
    expect(
      (await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)).map(
        (record) => record.kind,
      ),
    ).toEqual(["opened", "checked"])
    expect(logRecords(outcome)).toContainEqual(expect.objectContaining({ decision: "checked", reason: "paused" }))
  })

  it("an unreadable pause at the pre-merge authority read faults the run without ending the change", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const rivalPath = join(w.workdir, "..", "malformed-pause-rival")
    await gitIn(join(w.workdir, ".."))(["clone", "--quiet", w.remote, rivalPath])
    const rival = gitIn(rivalPath)
    await rival(["config", "user.email", "rival@yrd.test"])
    await rival(["config", "user.name", "rival"])

    let reads = 0
    let malformed = ""
    const git: Git = async (args, input) => {
      if (args[0] === "ls-remote" && args.includes(PAUSE_REF)) {
        reads += 1
        if (reads === 1) {
          const tree = (await rival(["mktree"], "")).trim()
          malformed = (
            await rival([
              "commit-tree",
              tree,
              "-m",
              "authority cannot be parsed\n\nRecord: wedged\nPaused-By: operator\n",
            ])
          ).trim()
          await rival(["push", "--quiet", "origin", `${malformed}:${PAUSE_REF}`])
        }
      }
      return await w.git(args, input)
    }

    await expect(queueRun({ ...(await w.options({ exit: 0 })), git })).rejects.toThrow(
      `origin ${PAUSE_REF} could not be read: origin ${PAUSE_REF} at`,
    )

    expect(malformed).not.toBe("")
    expect(await remoteTarget(w)).toBe(w.target)
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked"])
    expect(records.some((record) => record.kind === "stuck" || record.kind === "failed")).toBe(false)
    expect(messages(w)).toEqual([])
  })

  it("nothing submitted is nothing to do", async () => {
    const w = await world()
    const outcome = await queueRun(await w.options({}))
    expect(outcome.exitCode).toBe(0)
    expect(await remoteTarget(w)).toBe(w.target)
    expect(messages(w)).toEqual([])
  })

  it("a later successful recipient does not hide a failing notifier from the next run", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    // The first recipient is down and the second accepts the same ending. The
    // later success must not hide the earlier delivery still owed (ruling D9).
    const down = await queueRun({
      ...(await w.options({ exit: 0 })),
      notify: [
        { name: "recovering", on: ["merged"], run: "sh -c 'echo the notifier is down >&2; exit 3'" },
        { name: "recorder", on: ["merged"], run: w.notifier },
      ],
    })
    expect(down).toMatchObject({ exitCode: 0, merged: ["task/one"], stuck: [] })
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/main/*:refs/yrd/main/*"])
    let records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked", "merged", "sent", "sent"])
    const merged = records[2]
    const appendTip = records.at(-1)
    if (merged === undefined || appendTip === undefined) throw new Error("missing merged or sent record")
    expect(records.slice(-2).map((record) => trailer(record, "To"))).toEqual(["recovering", "recorder"])
    expect(records.slice(-2).map((record) => trailer(record, "Delivery"))).toEqual(["failed", "sent"])
    expect(records.slice(-2).map((record) => trailer(record, "For"))).toEqual([merged.sha, merged.sha])
    expect(records.slice(-2).map((record) => trailer(record, "Message-Id"))).toEqual([merged.sha, merged.sha])
    expect(messages(w)).toHaveLength(1)

    // With no currently matching names, the failed old name writes nothing;
    // the nonempty receipt chain also never grows a synthetic `none` receipt.
    const ref = changeRef("main", { branch: "task/one", head })
    const absent = await queueRun({ ...(await w.options({ exit: 0 })), notify: [] })
    expect(logRecords(absent).filter((record) => record.kind === "message")).toEqual([])
    expect(await refAt(gitIn(w.remote), ref)).toBe(appendTip.sha)
    expect(messages(w)).toHaveLength(1)

    // The failed recipient is back. A poisoned local ref cannot replace either
    // the immutable ending id or the captured sent tip used as append parent.
    await w.git(["update-ref", ref, head])
    const healthy = [
      { name: "recovering", on: ["merged"] as const, run: w.notifier },
      { name: "recorder", on: ["merged"] as const, run: w.notifier },
    ]
    const again = await queueRun({
      ...(await w.options({ exit: 0 })),
      notify: healthy,
    })
    expect(again.exitCode).toBe(0)
    expect(await refAt(w.git, ref)).toBe(head)
    expect(
      logRecords(again)
        .filter((record) => record.kind === "message")
        .map(({ delivered, id, to }) => ({ delivered, id, to })),
    ).toEqual([{ delivered: true, id: merged.sha, to: "recovering" }])
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/main/*:refs/yrd/main/*"])
    records = await readRecords(w.git, (await refAt(w.git, ref))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked", "merged", "sent", "sent", "sent"])
    expect(records.at(-1)?.trailers).toEqual(
      expect.arrayContaining([
        ["To", "recovering"],
        ["Delivery", "sent"],
        ["For", merged.sha],
        ["Message-Id", merged.sha],
      ]),
    )
    expect((await w.git(["rev-parse", `${records.at(-1)!.sha}^`])).trim()).toBe(appendTip.sha)
    expect(messages(w)).toHaveLength(2)
    expect(messages(w).map((message) => message.record)).toEqual(["merged", "merged"])

    const repairedTip = records.at(-1)!
    const settled = await queueRun({ ...(await w.options({ exit: 0 })), notify: healthy })
    expect(logRecords(settled).filter((record) => record.kind === "message")).toEqual([])
    expect(await refAt(gitIn(w.remote), ref)).toBe(repairedTip.sha)
    expect(messages(w)).toHaveLength(2)
  })

  it("a change merged around the queue reads merged, its catch-up record says a direct merge did it, and the direct merge is reported once (E5)", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    // The garage merges it around the queue: a merge commit on main, pushed.
    await w.git(["merge", "--quiet", "--no-ff", "--no-edit", "-m", "merged around the queue", head])
    const merge = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["push", "--quiet", "origin", "main"])

    const rivalPath = join(w.workdir, "..", "catch-up-rival")
    await gitIn(join(w.workdir, ".."))(["clone", "--quiet", w.remote, rivalPath])
    const rival = gitIn(rivalPath)
    await rival(["config", "user.email", "rival@yrd.test"])
    await rival(["config", "user.name", "rival"])
    const ref = changeRef("main", { branch: "task/one", head })
    let concurrent: string | undefined
    let advance = true
    const git: Git = async (args, input) => {
      const refspec = args.find((arg) => arg.endsWith(`:${ref}`))
      const leased = args.some((arg) => arg.startsWith(`--force-with-lease=${ref}:`))
      if (advance && leased && refspec !== undefined) {
        advance = false
        await rival(["fetch", "--quiet", "origin", `${ref}:${ref}`])
        concurrent = await appendRecord(rival, "main", {
          change: { branch: "task/one", head },
          kind: "merged",
          subject: `another queue observed the direct merge at ${merge.slice(0, 12)}`,
          trailers: [
            ["Merge", merge],
            ["Base", w.target],
            ["Merged-By", "direct"],
          ],
        })
        await rival(["push", "--quiet", "origin", `${concurrent}:${ref}`])
      }
      return w.git(args, input)
    }

    const outcome = await queueRun({ ...(await w.options({ exit: 0 })), git })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual([])
    expect(outcome.directMerges).toEqual([merge])
    expect(await remoteTarget(w)).toBe(merge)
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "merged", "merged", "sent"])
    expect(records.map((record) => record.sha)).toContain(concurrent)
    expect(records[2]?.subject).toBe(`merged around the queue at ${merge.slice(0, 12)}`)
    // `Base:` is the merge commit's first parent, a sha like every other Base.
    expect(records[2]?.trailers).toEqual(
      expect.arrayContaining([
        ["Merge", merge],
        ["Base", w.target],
        ["Merged-By", "direct"],
      ]),
    )
    expect(records[3]?.trailers).toEqual(
      expect.arrayContaining([
        ["State", "merged"],
        ["Merged-By", "direct"],
      ]),
    )
    expect(logRecords(outcome)).toContainEqual(
      expect.objectContaining({ decision: "merged", reason: "change-ref-taken", remote: concurrent }),
    )
    // Two records: one for the change that merged, one for the direct merge, the
    // second with the merge commit as its id.
    expect(messages(w).filter((message) => message.record === "merged")).toMatchObject([{ submitter: "@dev/2" }])
    const broken = messages(w).filter((message) => message.record === "merged-direct")
    expect(broken).toEqual([{ change: merge, record: "merged-direct" }])
    const told = logRecords(outcome).find((record) => record.kind === "message" && record.says === "merged-direct")
    expect(String(told?.text)).toContain(`main moved around the queue at ${merge.slice(0, 12)}`)
    expect(String(told?.text)).toContain("it carries no Change: trailer")
    expect(logRecords(outcome).filter((record) => record.kind === "merged-direct")).toMatchObject([
      { commit: merge, gitlinks: [], parents: [w.target, head], subject: "merged around the queue" },
    ])

    // The next run says nothing new: the catch-up record accounts for the commit.
    const again = await queueRun(await w.options({ exit: 0 }))
    expect(again.directMerges).toEqual([])
    expect(logRecords(again).filter((record) => record.kind === "merged-direct")).toEqual([])
    expect(messages(w).filter((message) => message.record === "merged-direct")).toHaveLength(1)
  })

  it("a change that ended failed and was then merged around the queue gets one message, the merged one, and its tip says merged", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    // It failed its check, and the notifier was down, so the send-back is owed:
    // exactly what makes the next run try to deliver it again (ruling D9).
    const down = await queueRun({
      ...(await w.options({ exit: 1 })),
      notify: [{ name: "recorder", on: ["failed"], run: "sh -c 'exit 3'" }],
    })
    expect(down.exitCode).toBe(1)
    expect(messages(w)).toEqual([])

    // The garage merged it around the queue all the same.
    await w.git(["checkout", "--quiet", "main"])
    await w.git(["merge", "--quiet", "--no-ff", "--no-edit", "-m", "merged around the queue", head])
    await w.git(["push", "--quiet", "origin", "main"])

    const outcome = await queueRun(await w.options({ exit: 0 }))

    expect(outcome.exitCode).toBe(0)
    await fetchChanges(w)
    // The catch-up merged record and its message, and no second ending on top of it.
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked", "failed", "sent", "merged", "sent"])
    expect(records.at(-1)?.trailers).toEqual(expect.arrayContaining([["State", "merged"]]))
    expect(
      messages(w)
        .filter((message) => String(message.change).startsWith("task/one@"))
        .map((message) => message.record),
    ).toEqual(["merged"])
  })

  it("a head that failed and was later superseded by a merged head of the same branch is never announced merged (@i/10-yrd/24098)", async () => {
    const w = await world()
    const headA = await submitCommit(w, "task/one", "one.txt")
    const refA = changeRef("main", { branch: "task/one", head: headA })

    // It failed its own check.
    const failedRun = await queueRun(await w.options({ exit: 1 }))
    expect(failedRun.exitCode).toBe(1)
    await fetchChanges(w)
    expect((await readRecords(w.git, (await refAt(w.git, refA))!)).map((record) => record.kind)).toEqual([
      "opened",
      "checked",
      "failed",
      "sent",
    ])

    // The submitter fixed it and pushed a new head on the SAME branch, which
    // carries the failed head as its own ancestor — the exact 2026-09-09 shape
    // (task/cto-24366-head-check's own earlier failed heads, superseded by the
    // head that actually merged).
    await w.git(["checkout", "--quiet", "task/one"])
    writeFileSync(join(w.work, "two.txt"), "two.txt\n")
    await w.git(["add", "two.txt"])
    await w.git(["commit", "--quiet", "-m", "two.txt"])
    const headB = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])
    await submit(w.git, "origin", {
      branch: "task/one",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
      issue: "@i/10-yrd/1",
    })

    // The new head passes its check and merges through the queue on its own.
    const mergedRun = await queueRun(await w.options({ exit: 0 }))
    expect(mergedRun.exitCode).toBe(0)
    expect(mergedRun.merged).toEqual(["task/one"])

    // The next run is where bare reachability used to resurrect the failed head:
    // its own catch-up runs again, now that headOnTarget has flipped true.
    const settled = await queueRun(await w.options({ exit: 0 }))
    expect(settled.exitCode).toBe(0)

    const after = await remoteTarget(w)
    const rows = list((await readQueue(w.git, "origin", "main", after)).changes)
    const rowA = rows.find((row) => row.head === headA)
    const rowB = rows.find((row) => row.head === headB)
    expect(rowB?.state).toBe("merged")
    expect(rowA?.state).toBe("failed")
    expect(rowA?.reason).toBe("superseded")
    expect(rowA?.supersededBy).toBe(headB)

    // The failed head's own record chain never gained a fabricated merged
    // record on top of its original failure.
    await fetchChanges(w)
    expect((await readRecords(w.git, (await refAt(w.git, refA))!)).map((record) => record.kind)).toEqual([
      "opened",
      "checked",
      "failed",
      "sent",
    ])

    // Nobody was told to close a bead for a head that never merged on its own:
    // exactly one message ever names it, and it is the original failure.
    const aMessages = messages(w).filter(
      (message) => message.change === changeName({ branch: "task/one", head: headA }),
    )
    expect(aMessages).toHaveLength(1)
    expect(aMessages[0]?.record).toBe("failed")
  })

  it("the target is not a change: a ref named after it is judged by nothing and messages nobody (2026-09-03 main@0a9db9daf7eb)", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")
    // The one path in refuses it now; the ref is planted the way the remote holds it.
    await expect(
      submit(w.git, "origin", { branch: "main", submitter: "unknown", target: { branch: "main", remote: "origin" } }),
    ).rejects.toThrow("main is the target, not a change")
    await plantTargetChange(w, w.target)

    // The queue merges the real change. The merge's first parent is the head
    // the planted ref is named after — which is what made the next run call
    // that ref merged, name the queue's own merge as its landing, and write a
    // `Merged-By: direct` record on it.
    const merging = await queueRun(await w.options({ exit: 0 }))
    expect(merging.merged).toEqual(["task/one"])
    const merge = await remoteTarget(w)
    expect((await w.git(["rev-parse", `${merge}^1`])).trim()).toBe(w.target)

    // The run after the merge: the one that in the specimen wrote `merged by
    // around the queue at 005a622156c7` and told its submitter to close a bead for it.
    const after = await queueRun(await w.options({ exit: 0 }))

    expect(after.exitCode).toBe(0)
    expect(after.merged).toEqual([])
    expect(after.directMerges).toEqual([])
    await fetchChanges(w)
    // The planted ref still holds the one record that was written on it, and no
    // run considered it: no record, no row, no message.
    expect(
      (await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "main", head: w.target })))!)).map(
        (record) => record.kind,
      ),
    ).toEqual(["opened"])
    for (const outcome of [merging, after]) {
      expect(logRecords(outcome).filter((record) => record.kind === "change" && record.branch === "main")).toEqual([])
      expect(logRecords(outcome).filter((record) => record.kind === "merged-direct")).toEqual([])
    }
    expect(messages(w).filter((message) => String(message.change).startsWith("main@"))).toEqual([])
    expect(messages(w).filter((message) => message.record === "merged-direct")).toEqual([])
    expect(messages(w).map((message) => message.record)).toEqual(["merged"])
  })

  it("the merge commit names its change, its submitter and its issue, and the merged record says the queue merged it and what it checked (E5)", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(await w.options({ exit: 0 }))

    expect(outcome.merged).toEqual(["task/one"])
    await w.git(["fetch", "--quiet", "origin", "main"])
    const merge = await remoteTarget(w)
    expect((await w.git(["log", "-1", "--format=%s", merge])).trim()).toBe(
      `merge task/one@${head.slice(0, 12)} into main`,
    )
    // The trailer is the change's name, which under the one prefix is its ref:
    // `git log refs/yrd/main/<that name>` prints the records.
    const named = await trailerOn(w, merge, "Change")
    expect(named).toBe(changeName({ branch: "task/one", head }))
    expect(`${CHANGES}/${named}`).toBe(changeRef("main", { branch: "task/one", head }))
    expect(await trailerOn(w, merge, "Issue")).toBe("@i/10-yrd/1")
    expect(await trailerOn(w, merge, "Submitter")).toBe("@dev/2")
    await fetchChanges(w)
    // The records and the genesis, on the ref's first-parent line (records.ts).
    expect(
      (await w.git(["log", "--first-parent", "--format=%s", `${CHANGES}/${named}`])).trim().split("\n"),
    ).toHaveLength(5)
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    const merged = records.find((record) => record.kind === "merged")
    if (merged === undefined) throw new Error("no merged record")
    // `Merged-By:` names the queue and the run of it that merged: the run id is
    // what a reader needs, and one formatter writes it on both the record and
    // the merge commit, so the two can never say different things.
    const by = trailer(merged, "Merged-By") ?? ""
    expect(by).toBe(`yrd queue main [${outcome.run}]`)
    expect(logRecords(outcome).find((record) => record.kind === "run")).toMatchObject({ queue: `${w.remote}#main` })
    expect(mergedByRun(by)).toBe(outcome.run)
    expect(await trailerOn(w, merge, "Merged-By")).toBe(by)
    // The queue commits as itself, so a reader tells its merges from a person's
    // with `git log` alone.
    expect((await w.git(["log", "-1", "--format=%cn <%ce>", merge])).trim()).toMatch(/^yrd-service <yrd-service@/u)
    expect(trailer(merged, "Merge")).toBe(merge)
    // One `Check:` per on-merge check, in the shape the checked record uses.
    expect(trailers(merged, "Check")).toEqual([expect.stringMatching(/^verify exit=0 ms=\d+ log=\S+$/u)])
    expect(records.at(-1)?.trailers).toEqual(
      expect.arrayContaining([
        ["To", "recorder"],
        ["Delivery", "sent"],
        ["Merged-By", by],
      ]),
    )
  })

  it("a commit pushed to the target around the queue is reported once, and the queue goes on from the new base (E5)", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const base = await remoteTarget(w)
    const direct = await pushAroundQueue(w, "direct.txt")

    const first = await queueRun(await w.options({ exit: 0 }))

    expect(first.exitCode).toBe(0)
    expect(first.directMerges).toEqual([direct])
    expect(first.merged).toEqual(["task/one"])
    expect(logRecords(first).filter((record) => record.kind === "merged-direct")).toMatchObject([
      { commit: direct, gitlinks: [], parents: [base], subject: "direct.txt around the queue" },
    ])
    const broken = messages(w).filter((message) => message.record === "merged-direct")
    expect(broken).toEqual([{ change: direct, record: "merged-direct" }])
    const told = logRecords(first).find((record) => record.kind === "message" && record.says === "merged-direct")
    expect(String(told?.text)).toContain(`main moved around the queue at ${direct.slice(0, 12)}`)
    expect(String(told?.text)).toContain("it is one commit, not a merge of a change")
    // The change merged on top of the direct merge, not on the base the queue read first.
    await w.git(["fetch", "--quiet", "origin", "main"])
    const parents = (await w.git(["rev-list", "--parents", "-n", "1", await remoteTarget(w)]))
      .trim()
      .split(/\s+/u)
      .slice(1)
    expect(parents).toEqual([direct, head])

    // The next run says nothing new: the queue's own merge stands on top of it.
    const second = await queueRun(await w.options({ exit: 0 }))
    expect(second.directMerges).toEqual([])
    expect(logRecords(second).filter((record) => record.kind === "merged-direct")).toEqual([])
    expect(messages(w).filter((message) => message.record === "merged-direct")).toHaveLength(1)
  })

  it("a queue that has judged nothing has no history, so it judges nothing on the target (E5)", async () => {
    // Not one change was ever submitted here, so there is no first record and no
    // instant to start from — and every commit on the target belongs to
    // whatever moved the branch before this queue existed.
    const w = await world({ declaredLater: true })
    // Operational pause history is not a submitted change's history.
    await writePause(w.git, "origin", "main", { by: "operator", kind: "paused", reason: "maintenance" })
    await writePause(w.git, "origin", "main", { by: "operator", kind: "resumed", reason: "maintenance complete" })
    await pushAroundQueue(w, "direct.txt")

    const outcome = await queueRun(await w.options({ exit: 0 }))

    expect(outcome.exitCode).toBe(0)
    expect(outcome.directMerges).toEqual([])
    expect(logRecords(outcome).filter((record) => record.kind === "merged-direct")).toEqual([])
    expect(messages(w)).toEqual([])
  })

  /**
   * THE HOLE THE PLAN NAMED AT THE CUTOVER (§ Owed after M5, E5's last line).
   *
   * Every earlier boundary was a commit in `.yrd.yml` — first the newest one
   * that TOUCHED the file, then the one that introduced `remote:` — and the
   * first of those let a direct merge hide itself: it edited the declaration,
   * became the boundary, and took every direct merge under it out of the report.
   *
   * The boundary is the queue's own first record now, which no commit on the
   * target can move at all. A direct merge that edits the declaration is judged
   * like any other first-parent commit, and everything older than that first
   * record belongs to whoever moved the branch before this queue existed.
   */
  it("a direct merge after the queue's first change is reported, declaration edits included; anything older is not (E5)", async () => {
    const w = await world({ declaredLater: true })
    const before = await pushAroundQueue(w, "before.txt")
    // A whole second, so the boundary is not a tie: a committer date is seconds.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await submitCommit(w, "task/one", "one.txt")
    const plain = await pushAroundQueue(w, "direct.txt")
    const edited = await editDeclarationAroundQueue(w, "# edited around the queue\n")

    const outcome = await queueRun(await w.options({ exit: 0 }))

    // Both direct merges, oldest first; the one from before the first change is
    // never among them.
    expect(outcome.directMerges).toEqual([plain, edited])
    expect(outcome.directMerges).not.toContain(before)
    expect(
      logRecords(outcome)
        .filter((record) => record.kind === "merged-direct")
        .map((record) => record.commit),
    ).toEqual([plain, edited])
    expect(messages(w).filter((message) => message.record === "merged-direct")).toHaveLength(2)
  })

  it("a checked change is judged again when the target's check config is not the one its checked record names", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = await submitCommit(w, "task/two", "two.txt")

    // One merge per run: task/one merges, task/two stays checked under config A.
    const first = await queueRun({ ...(await w.options({ exit: 0 })), configBlob: "config-A" })
    expect(first.merged).toEqual(["task/one"])
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/main/*:refs/yrd/main/*"])
    let records = await readRecords(
      w.git,
      (await refAt(w.git, changeRef("main", { branch: "task/two", head: second })))!,
    )
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked"])
    expect(records[1]?.trailers).toEqual(expect.arrayContaining([["Config", "config-A"]]))

    // The target's declaration changed: the on-submit checks run again under B
    // before the change merges, and the new checked record names B.
    const next = await queueRun({ ...(await w.options({ exit: 0 })), configBlob: "config-B" })
    expect(next.merged).toEqual(["task/two"])
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/main/*:refs/yrd/main/*"])
    records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/two", head: second })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked", "checked", "merged", "sent"])
    expect(records[2]?.trailers).toEqual(expect.arrayContaining([["Config", "config-B"]]))
  })
})

describe("an orphaned merge (@i/10-yrd/24344)", () => {
  it("a merge the queue itself composed, then never recorded, is caught up with its own run's attribution, not direct", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    // Two occurrences four hours apart (q-20260904T182922653Z,
    // q-20260904T145624104Z) were the run itself: this merge's own message
    // already carries the trailer a real crashed run's would.
    const message = [
      `merge task/one@${head.slice(0, 12)} into main`,
      "",
      `Change: task/one@${head}`,
      "Merged-By: yrd queue main [q-crashed-run]",
    ].join("\n")
    const merge = await composeMergeCandidate(w, head, message)
    // Simulates the atomic push having actually landed at the remote before
    // the run that made it died: the target carries it, nothing else does.
    await w.git(["push", "--quiet", "origin", `${merge}:refs/heads/main`])

    const outcome = await queueRun(await w.options({ exit: 0 }))

    expect(outcome.exitCode).toBe(0)
    expect(await remoteTarget(w)).toBe(merge)
    await fetchChanges(w)
    const ref = changeRef("main", { branch: "task/one", head })
    const records = await readRecords(w.git, (await refAt(w.git, ref))!)
    const mergedRecord = records.find((record) => record.kind === "merged")
    expect(mergedRecord).toBeDefined()
    expect(trailer(mergedRecord!, "Merge")).toBe(merge)
    // Recovered, not `direct`: the record must say which run actually made it.
    expect(trailer(mergedRecord!, "Merged-By")).toBe("yrd queue main [q-crashed-run]")
    expect(messages(w).filter((entry) => entry.record === "merged")).toHaveLength(1)
  })

  it("a merge the queue composed but never pushed before it died ends stuck with its own sha and an honest absorbed answer, never a blind retry", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const ref = changeRef("main", { branch: "task/one", head })
    // Take the change to "checked" directly, the shape a real on-submit judge
    // leaves (this run's own checks apply only at merge, ruling A1).
    const checkedRecord = await appendRecord(w.git, "main", {
      change: { branch: "task/one", head },
      kind: "checked",
      subject: `task/one passed the on-submit checks at main ${w.target.slice(0, 12)}`,
      trailers: [
        ["Config", "test-config"],
        ["Base", w.target],
      ],
    })
    await w.git(["push", "--quiet", "origin", `${checkedRecord}:${ref}`])

    // The crash window itself: composed, never pushed, its worktree left
    // standing exactly as `composeCandidate`'s `prepare` would leave it.
    const orphan = await composeMergeCandidate(w, head, `merge task/one@${head.slice(0, 12)} into main`)
    const worktreePath = await deadMergeWorktree(w, "q-dead-merge", head, orphan, exitedPid())

    const outcome = await queueRun(await w.options({ exit: 0 }))

    expect(outcome.exitCode).toBe(2)
    expect(outcome.stuck).toEqual(["task/one"])
    expect(outcome.failed).toEqual([])
    expect(outcome.merged).toEqual([])
    // Never redone: the target never moved, and the orphan worktree's commit
    // is exactly what this run found, nothing recomposed.
    expect(await remoteTarget(w)).toBe(w.target)
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, ref))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked", "stuck", "sent"])
    const stuckRecord = records[2]!
    const incident = incidentOf(stuckRecord)
    expect(incident.Code).toBe("yrd-merge-orphaned")
    expect(incident.Subject).toContain(orphan.slice(0, 12))
    expect(incident.Subject).toContain("not absorbed")
    expect(incident.Via).toContain(worktreePath)
    expect(trailer(stuckRecord, "Orphan")).toBe(orphan)
    expect(trailer(stuckRecord, "Absorbed")).toBe("no")
    expect(messages(w).filter((entry) => entry.record === "stuck")).toHaveLength(1)
  })

  it("never claims a worktree at the naming slot as this head's orphaned merge once its registration names a garbage sha, and proceeds through the ordinary path instead", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const ref = changeRef("main", { branch: "task/one", head })
    // Take the change to "checked" directly, exactly as the sibling case above.
    const checkedRecord = await appendRecord(w.git, "main", {
      change: { branch: "task/one", head },
      kind: "checked",
      subject: `task/one passed the on-submit checks at main ${w.target.slice(0, 12)}`,
      trailers: [
        ["Config", "test-config"],
        ["Base", w.target],
      ],
    })
    await w.git(["push", "--quiet", "origin", `${checkedRecord}:${ref}`])

    // A worktree at task/one's own naming slot, checked out cleanly, then its
    // OWN git-internal HEAD registration corrupted directly — the shape a
    // half-written or truncated worktree admin file leaves behind. Git's own
    // `worktree list` answers a garbage registration with the all-zero sha
    // rather than erroring, so this reaches `orphanedMergeCandidate`'s read
    // exactly as a real corrupted registration would.
    //
    // Verified separately (a scratch repo, not this fixture): a worktree
    // whose registration names an object that is simply MISSING poisons
    // every git fetch in the repository — including this run's own opening
    // fetch of its captured queue objects, which crashes long before
    // `orphanedMergeCandidate` ever runs. The all-zero sha does not, because
    // git recognizes it as its own placeholder rather than trying to resolve
    // it — the one shape of "unreadable" that isolates the read this test
    // means to exercise.
    const worktreePath = await deadMergeWorktree(w, "q-dead-merge-unreadable", head, w.target, exitedPid())
    const adminHead = join(w.work, ".git", "worktrees", head.slice(0, 12), "HEAD")
    if (!existsSync(adminHead)) {
      throw new Error(`fixture assumption failed: no worktree admin registration at ${adminHead} for ${worktreePath}`)
    }
    writeFileSync(adminHead, "this-is-not-a-sha-at-all\n")

    const outcome = await queueRun(await w.options({ exit: 0 }))

    // Not treated as an orphan recovery: the change proceeds through the
    // ordinary path and merges cleanly, exactly as if the unreadable
    // worktree were never there — never guessed into this change's evidence.
    expect(outcome.exitCode).toBe(0)
    expect(outcome.stuck).toEqual([])
    expect(outcome.merged).toEqual(["task/one"])
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, ref))!)
    expect(records.some((record) => record.kind === "stuck")).toBe(false)
    expect(records.every((record) => trailer(record, "Orphan") === undefined)).toBe(true)
  })

  it("never claims a worktree at the naming slot as this head's orphaned merge when its parents do not include this head, and proceeds through the ordinary path instead", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const ref = changeRef("main", { branch: "task/one", head })
    const checkedRecord = await appendRecord(w.git, "main", {
      change: { branch: "task/one", head },
      kind: "checked",
      subject: `task/one passed the on-submit checks at main ${w.target.slice(0, 12)}`,
      trailers: [
        ["Config", "test-config"],
        ["Base", w.target],
      ],
    })
    await w.git(["push", "--quiet", "origin", `${checkedRecord}:${ref}`])

    // A commit that never goes near the queue, purely to give the "wrong"
    // merge below a real, unrelated parent of its own.
    await w.git(["checkout", "--quiet", "-b", "shadow/other", "main"])
    writeFileSync(join(w.work, "other.txt"), "other.txt\n")
    await w.git(["add", "other.txt"])
    await w.git(["commit", "--quiet", "-m", "other.txt"])
    const otherHead = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])

    // A real merge commit, but of `otherHead`, never `head`: its parents are
    // [main tip, otherHead]. Placed at task/one's own naming slot — a stale
    // worktree left there by an entirely different head, never redone as if
    // it were task/one's own merge.
    const wrongMerge = await composeMergeCandidate(
      w,
      otherHead,
      `merge shadow/other@${otherHead.slice(0, 12)} into main`,
    )
    await deadMergeWorktree(w, "q-dead-merge-wrong-parent", head, wrongMerge, exitedPid())

    const outcome = await queueRun(await w.options({ exit: 0 }))

    expect(outcome.exitCode).toBe(0)
    expect(outcome.stuck).toEqual([])
    expect(outcome.merged).toEqual(["task/one"])
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, ref))!)
    expect(records.some((record) => record.kind === "stuck")).toBe(false)
    expect(records.every((record) => trailer(record, "Orphan") === undefined)).toBe(true)
  })
})

describe("the target's setup", () => {
  it("runs once in every worktree the run makes, before anything judges it", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(await w.options({ exit: 0, setup: w.setupCommand(0) }))

    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/one"])
    const order = whereRan(w)
    // Submit, merge, and one captured-base notification environment each run setup once.
    const prepared = order.filter(([what]) => what === "setup").map(([, where]) => where)
    expect(prepared).toHaveLength(3)
    expect(new Set(prepared).size).toBe(3)
    everyCheckWasPrepared(order)
    // The setup is recorded in a check's own shape, billed to the queue.
    expect(logRecords(outcome).filter((record) => record.kind === "result" && record.name === "setup")).toMatchObject([
      { exit: "0", name: "setup", phase: "submit", result: "pass" },
      { exit: "0", name: "setup", phase: "merge", result: "pass" },
      { exit: "0", name: "setup", phase: "notify", result: "pass" },
    ])
    // Three setups, each with a start and an end row.
    const setupRows = logRecords(outcome).filter((record) => record.kind === "check" && record.name === "setup")
    expect(setupRows).toHaveLength(6)
    expect(setupRows.filter((record) => record.end === undefined)).toHaveLength(3)
  })

  /**
   * A run that dies removes nothing, so its worktrees stay registered in the
   * repository and on disk, and every later `git worktree list` carries them:
   * R8's did (plan § Owed after M5). The next run takes them down.
   *
   * Alive means this run, or a pid file naming a process that is running —
   * nothing else, because a worktree registration outlives the process that
   * made it and git has no other answer. The pair below is the discriminating
   * read: two worktrees, identical but for whose pid claims them.
   */
  it("removes the worktrees of runs that are no longer alive, and leaves a living run's alone", async () => {
    const w = await world()
    const dead = await worktreeOfRun(w, "q-dead", exitedPid())
    const alive = await worktreeOfRun(w, "q-alive", process.pid)

    const outcome = await queueRun(await w.options({ exit: 0 }))

    expect(existsSync(dead)).toBe(false)
    expect(existsSync(join(w.workdir, "worktrees", "q-dead"))).toBe(false)
    expect(existsSync(alive)).toBe(true)
    const registered = await w.git(["worktree", "list", "--porcelain"])
    expect(registered).not.toContain(dead)
    expect(registered).toContain(alive)

    // One row per worktree taken, naming it, whose it was and why it went.
    expect(logRecords(outcome).filter((record) => record.kind === "reap")).toEqual([
      expect.objectContaining({ of: "q-dead", path: dead, why: expect.stringContaining("is not running") }),
    ])
  })

  /** A run that ends takes its own directory with it, so the reap reads exactly the runs that did not end. */
  it("leaves nothing of its own under the worktrees root when it ends", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(await w.options({ exit: 0 }))

    expect(outcome.exitCode).toBe(0)
    expect(existsSync(join(w.workdir, "worktrees", outcome.run))).toBe(false)
  })

  it("runs again in the target worktree the attribution builds", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")

    // One worktree per phase, and only two phases: the change's head at
    // submit, and the head merged onto the target at merge.
    const outcome = await queueRun(await w.options({ everywhere: true, exit: 1, setup: w.setupCommand(0) }))

    expect(outcome.exitCode).toBe(1)
    expect(outcome.failed).toEqual(["task/one"])
    const order = whereRan(w)
    const prepared = order.filter(([what]) => what === "setup").map(([, where]) => where)
    expect(prepared).toHaveLength(3)
    expect(new Set(prepared).size).toBe(3)
    everyCheckWasPrepared(order)
    expect(
      logRecords(outcome)
        .filter((record) => record.kind === "result" && record.name === "setup")
        .map((record) => record.phase),
    ).toEqual(["submit", "merge", "notify"])
  })

  it("a setup that fails ends the change stuck, never failed, and nothing is judged in that worktree", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(await w.options({ exit: 0, setup: w.setupCommand(1) }))

    // Stuck, exit 2: this setup fails on the settled base too, so the queue
    // could not build the ground a judgement stands on and nobody is billed.
    expect(outcome.exitCode).toBe(2)
    expect(outcome.stuck).toEqual(["task/one"])
    expect(outcome.failed).toEqual([])
    expect(await remoteTarget(w)).toBe(w.target)
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "stuck", "sent"])
    expect(incidentOf(records[1])).toMatchObject({ Code: "yrd-setup-unusable" })
    expect(records[1]?.trailers.filter(([name]) => name === "Fault")).toEqual([])
    // The check never ran: there was no prepared tree to run it in.
    expect(whereRan(w).filter(([what]) => what === "check")).toEqual([])
    expect(messages(w)).toEqual([])
    expect(trailer(records.at(-1)!, "Delivery")).toBe("failed")
    expect(logRecords(outcome).filter((record) => record.kind === "message")).toMatchObject([
      { delivered: false, error: expect.stringContaining("could not run") },
    ])
    expect(logRecords(outcome).filter((record) => record.kind === "result" && record.name === "setup")).toMatchObject([
      { exit: "1", phase: "base", result: "fail", whose: "queue" },
      { exit: "1", phase: "submit", result: "fail", whose: "queue" },
      { exit: "1", phase: "notify", result: "fail", whose: "queue" },
    ])
  })

  /**
   * Run q-20260910T051200413Z-adf158d1, 2026-09-09 22:12 PDT: a submitter's
   * head added a workspace package without its lockfile, the target's `bun
   * install --frozen-lockfile` refused in the submit phase, and the whole
   * service went down exit 2 with the queue billed. The same setup passed on
   * the settled base, so the queue's ground was never broken — one change's
   * content was, and every other change in line waited for a person.
   */
  it("bills the submitter when the setup fails only with the candidate's own content", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/breaks-setup", "BREAK_SETUP")
    await submitCommit(w, "task/two", "two.txt")

    // Passes on any tree but the candidate's: the settled base carries none of
    // the candidate's authored content, so it is the discriminating reading.
    const outcome = await queueRun(
      await w.options({ exit: 0, setup: `echo "setup cwd=$(pwd)" >> ${w.checkLog} && test ! -e BREAK_SETUP` }),
    )

    // The ordinary failed path: exit 1, not 2, and the run went on to judge and
    // merge the next change in line rather than stopping for a person.
    expect(outcome.exitCode).toBe(1)
    expect(outcome.failed).toEqual(["task/breaks-setup"])
    expect(outcome.stuck).toEqual([])
    expect(outcome.merged).toEqual(["task/two"])

    await fetchChanges(w)
    const ref = changeRef("main", { branch: "task/breaks-setup", head })
    const records = await readRecords(w.git, (await refAt(w.git, ref))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "failed", "sent"])
    const failed = records[1]!
    expect(trailer(failed, "Fault")).toBe("submitter")
    expect(trailer(failed, "Reason")).toBe("setup")
    // The reading the attribution stands on, in the record itself.
    expect(trailer(failed, "Base-Setup")).toBe("passed")
    expect(records[1]?.trailers.filter(([name]) => name === "Code")).toEqual([])
    // The setup's own diagnosis and the log a person reads it in.
    const log = checkLogFor(outcome, "task/breaks-setup", "submit", "setup")
    expect(failed.subject).toContain(log)
    expect(trailer(failed, "Remedy")).toContain(log)
    expect(trailer(failed, "Check")).toContain(`log=${log}`)
    expect(existsSync(log)).toBe(true)
    // The setup ran once more, in a worktree of the settled base alone.
    expect(
      whereRan(w).filter(([what, where]) => what === "setup" && where.includes(join("worktrees", outcome.run, "base"))),
    ).toHaveLength(1)
    // The base's own rows are journaled like any other setup, and the
    // candidate's verdict says who the base named.
    expect(
      logRecords(outcome).filter(
        (record) => record.kind === "result" && record.name === "setup" && record.head === head,
      ),
    ).toMatchObject([
      { exit: "0", phase: "base", result: "pass" },
      { exit: "1", phase: "submit", result: "fail", whose: "submitter" },
    ])
    expect(
      logRecords(outcome).filter(
        (record) => record.kind === "check" && record.name === "setup" && record.phase === "base",
      ),
    ).toHaveLength(2)
    expect(messages(w)[0]).toMatchObject({
      change: changeName({ branch: "task/breaks-setup", head }),
      log,
      reason: "setup",
      record: "failed",
      submitter: "@dev/2",
    })
  })

  it("keeps the queue's stuck when the same setup fails on the settled base too", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(await w.options({ exit: 0, setup: "false" }))

    // The ground itself is broken: nobody is billed and the run stops there.
    expect(outcome.exitCode).toBe(2)
    expect(outcome.stuck).toEqual(["task/one"])
    expect(outcome.failed).toEqual([])
    expect(await remoteTarget(w)).toBe(w.target)
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "stuck", "sent"])
    const incident = incidentOf(records[1])
    expect(incident.Code).toBe("yrd-setup-unusable")
    expect(incident.Via).toContain("failed on the settled base alone too")
    expect(records[1]?.trailers.filter(([name]) => name === "Fault" || name === "Base-Setup")).toEqual([])
    expect(
      logRecords(outcome).filter(
        (record) => record.kind === "result" && record.name === "setup" && record.head === head,
      ),
    ).toMatchObject([
      { exit: "1", phase: "base", result: "fail", whose: "queue" },
      { exit: "1", phase: "submit", result: "fail", whose: "queue" },
    ])
  })

  it("keeps a setup failure longer than 400 characters lossless in the authoritative incident", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const tail = "THE-END-OF-THE-SETUP-FAILURE"
    const missing = `no-such-setup-command ${"x".repeat(450)}${tail}`

    await queueRun(await w.options({ exit: 0, setup: missing }))

    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    const incident = incidentOf(records.find((record) => record.kind === "stuck"))
    expect(incident.Code).toBe("yrd-setup-unusable")
    expect(incident.Subject).toContain(tail)
    expect(incident.Subject.length).toBeGreaterThan(400)
    expect(incidentOf(records.at(-1))).toEqual(incident)
  })

  // @i/10-yrd/24140: a failed `bun install --frozen-lockfile` used to print
  // bun's own contentless "lockfile had changes, but lockfile is frozen" —
  // never naming which dependency moved. Four identical stops of that exact
  // shape cost a 3h51m outage on 2026-09-04. This drives a REAL frozen-lockfile
  // refusal (no mock, no stub setup script) and proves the entry that moved is
  // now named, with both specifiers, plus where the diagnosis looked.
  it("names every entry a frozen bun install could not, plus where it looked", async () => {
    const w = await world()
    const { head } = await submitRaisedDependency(w, "task/raise-widget", "widget", "1.0.0", "1.1.0")

    const outcome = await queueRun(await w.options({ exit: 0, setup: "bun install --frozen-lockfile" }))

    // The candidate's own manifest is what the lockfile disagrees with, and the
    // same setup passes on the settled base: the submitter's, exit 1, the queue
    // still standing. This diagnosis is advisory and never changes that
    // verdict, only what the ending says about it.
    expect(outcome.exitCode).toBe(1)
    expect(outcome.failed).toEqual(["task/raise-widget"])
    expect(outcome.stuck).toEqual([])
    await fetchChanges(w)
    const records = await readRecords(
      w.git,
      (await refAt(w.git, changeRef("main", { branch: "task/raise-widget", head })))!,
    )
    expect(records.map((record) => record.kind)).toEqual(["opened", "failed", "sent"])
    const failed = records[1]!
    expect(trailer(failed, "Fault")).toBe("submitter")
    expect(trailer(failed, "Base-Setup")).toBe("passed")
    // AC1: the entry that moved, by NAME, with its before and after specifier.
    expect(failed.subject).toContain("widget: widget@file:vendor-1.0.0 -> widget@file:vendor-1.1.0")
    // AC2: where it looked — the lockfile, the manifest(s), the worktree root.
    expect(failed.subject).toContain("bun.lock")
    expect(failed.subject).toContain("package.json")
    expect(failed.subject).toContain("worktree root")
    // AC3: the submitter hears it, rather than a person finding a stopped
    // queue. (The fixture's own lockfile seed went around the queue, so the
    // first message this run sends is that direct merge.)
    expect(messages(w).find((message) => message.record === "failed")).toMatchObject({
      reason: "setup",
      submitter: "@dev/2",
    })
  })

  it("a setup past its bound is stuck too, and the change is never billed", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    // 127 is the shell's own word for a command it could not find: a setup the
    // target names and the worktree does not have is the queue's, like any
    // other setup that did not pass.
    const outcome = await queueRun(await w.options({ exit: 0, setup: "no-such-setup-command" }))

    expect(outcome.exitCode).toBe(2)
    expect(outcome.stuck).toEqual(["task/one"])
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "stuck", "sent"])
    expect(incidentOf(records[1])).toMatchObject({ Code: "yrd-setup-unusable" })
    expect(logRecords(outcome).filter((record) => record.kind === "result" && record.name === "setup")).toMatchObject([
      { exit: "missing", phase: "base", result: "stuck", whose: "queue" },
      { exit: "missing", phase: "submit", result: "stuck", whose: "queue" },
      { exit: "missing", phase: "notify", result: "stuck", whose: "queue" },
    ])
  })
})

/**
 * A failing check ends the change failed at once, and runs ONCE.
 *
 * It used to be run again in the change's worktree and once more at the target
 * before anyone was billed, so a flake or a red target ended the change stuck.
 * Measured over 257 check runs since flag day that reading changed no verdict:
 * 7 second runs all failed again, 14 target runs all passed (operator ruling
 * 2026-09-03). What is left is the cost it charged every failure.
 */
describe("a failing check bills the submitter at once", () => {
  it("ends the change failed with the check and its log, having run the check once", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(await w.options({ exit: 1, on: ["submit"] }))

    expect(outcome.exitCode).toBe(1)
    expect(outcome.failed).toEqual(["task/one"])
    expect(outcome.stuck).toEqual([])
    expect(await remoteTarget(w)).toBe(w.target)
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "failed", "sent"])
    expect(records[1]?.trailers).toEqual(
      expect.arrayContaining([
        ["Reason", "verify"],
        ["Fault", "submitter"],
      ]),
    )
    expect(records[1]?.trailers.filter(([name]) => name === "Check").map(([, value]) => value)).toEqual([
      expect.stringMatching(/^verify exit=1 ms=\d+ log=\S+$/u),
    ])
    expect(messages(w)[0]).toMatchObject({
      record: "failed",
      failures: 1,
      reason: "verify",
      submitter: "@dev/2",
    })
    // The log the check wrote is named in the record, so a notifier says where to look.
    expect(messages(w)[0]?.log).toBe(checkLogFor(outcome, "task/one", "submit", "verify"))
    // ONE run of the one check. Two more — the second in the change's worktree
    // and one at a whole worktree of the target — is what this deleted.
    expect(whereRan(w)).toHaveLength(1)
  })

  it("counts this branch's failures, so a second send-back can raise an andon", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")
    expect((await queueRun(await w.options({ exit: 1, on: ["submit"] }))).failed).toEqual(["task/one"])
    expect(messages(w).at(-1)).toMatchObject({ record: "failed", failures: 1 })

    // The author pushes a new head on the same branch and submits it again.
    await w.git(["checkout", "--quiet", "task/one"])
    writeFileSync(join(w.work, "two.txt"), "two\n")
    await w.git(["add", "two.txt"])
    await w.git(["commit", "--quiet", "-m", "two"])
    await w.git(["checkout", "--quiet", "main"])
    await submit(w.git, "origin", {
      branch: "task/one",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
      issue: "@i/10-yrd/1",
    })

    expect((await queueRun(await w.options({ exit: 1, on: ["submit"] }))).failed).toEqual(["task/one"])

    // Two: the change that failed under the old head, and this one.
    expect(messages(w).at(-1)).toMatchObject({ record: "failed", failures: 2 })

    // A concurrent local poison must not choose either the ending's parent or
    // the immutable ending record used to count this message's failures.
    await submit(w.git, "origin", {
      branch: "task/one",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
      issue: "@i/10-yrd/1",
    })
    const currentHead = (await refAt(w.git, "refs/heads/task/one"))!
    const ref = changeRef("main", { branch: "task/one", head: currentHead })
    let poisoned = false
    const git: Git = async (args, input) => {
      const output = await w.git(args, input)
      if (!poisoned && args[0] === "merge-base") {
        await w.git(["update-ref", ref, currentHead])
        poisoned = true
      }
      return output
    }
    const retried = await queueRun({ ...(await w.options({ exit: 1, on: ["submit"] })), git })
    expect(poisoned).toBe(true)
    expect(messages(w).at(-1)).toMatchObject({ record: "failed", failures: 3 })
    expect(logRecords(retried)).not.toContainEqual(expect.objectContaining({ reason: "change-ref-taken" }))
    expect(await refAt(w.git, ref)).toBe(currentHead)
    await fetchChanges(w)
    expect((await readRecords(w.git, (await refAt(w.git, ref))!)).at(-1)?.kind).toBe("sent")
  })

  it("a check that is red at the target too still bills the submitter, and the queue keeps running", async () => {
    // The old reading called this `inherited` and stopped the queue on it. The
    // target is proven green by its own last merge; a red one is a person's
    // problem, not a reason to hold every change behind it.
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(await w.options({ everywhere: true, exit: 1, on: ["submit"] }))

    expect(outcome.exitCode).toBe(1)
    expect(outcome.failed).toEqual(["task/one"])
    expect(outcome.stuck).toEqual([])
    await fetchChanges(w)
    expect(
      (await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)).map(
        (record) => record.kind,
      ),
    ).toEqual(["opened", "failed", "sent"])
    expect(whereRan(w)).toHaveLength(1)
  })
})

/**
 * A gitlink standing at a commit its own remote does not hold has two causes
 * with opposite owners, and for one night the queue billed both to itself: a
 * component commit that never left an author's bay stopped every change in
 * line, waiting for a person (specimen 2026-09-03, km gitlink 11d9312c).
 *
 * The probe that separates them is unit-tested in reference.test.ts, both
 * branches. What these two prove is the half that only a real run can show:
 * which ENDING each cause reaches through `guarded()`, and what the change's
 * own record then says about who is billed.
 */
describe("a gitlink the component's remote does not hold", () => {
  /** The world's target, carrying one gitlink at a commit nothing pushed. */
  async function withUnpushedGitlink(w: World): Promise<Readonly<{ child: string; unpushed: string }>> {
    const child = join(w.workdir, "child")
    mkdirSync(w.workdir, { recursive: true })
    await w.git(["init", "--quiet", "--initial-branch=main", child])
    const childGit = gitIn(child)
    await childGit(["config", "user.email", "queue@yrd.test"])
    await childGit(["config", "user.name", "yrd"])
    writeFileSync(join(child, "child.txt"), "published\n")
    await childGit(["add", "."])
    await childGit(["commit", "--quiet", "-m", "child, published"])
    // The bay: a clone that commits and never pushes, which is the whole
    // specimen. The commit exists, is reachable by its author, and is on no
    // remote anywhere.
    const bay = join(w.workdir, "child-bay")
    await w.git(["clone", "--quiet", child, bay])
    const bayGit = gitIn(bay)
    await bayGit(["config", "user.email", "queue@yrd.test"])
    await bayGit(["config", "user.name", "yrd"])
    writeFileSync(join(bay, "child.txt"), "only in the bay\n")
    await bayGit(["commit", "--quiet", "-am", "child, unpushed"])
    const unpushed = (await bayGit(["rev-parse", "HEAD"])).trim()
    for (const [key, value] of [
      ["path", "packages/child"],
      ["url", child],
      ["branch", "main"],
    ] as const) {
      await w.git(["config", "-f", ".gitmodules", `submodule.child.${key}`, value])
    }
    await w.git(["add", ".gitmodules"])
    await w.git(["update-index", "--add", "--cacheinfo", `160000,${unpushed},packages/child`])
    await w.git(["commit", "--quiet", "-m", "declare a child at a commit nobody pushed"])
    await w.git(["push", "--quiet", "origin", "main"])
    return { child, unpushed }
  }

  it("fails the change and bills its submitter when the remote answers and lacks the pin", async () => {
    const w = await world()
    const { child, unpushed } = await withUnpushedGitlink(w)
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(await w.options({ exit: 0 }))

    // Exit 1, not 2: nothing about the queue is repaired by stopping it, so
    // the line moves on to the next change.
    expect(outcome.exitCode).toBe(1)
    expect(outcome.failed).toEqual(["task/one"])
    expect(outcome.stuck).toEqual([])
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "failed", "sent"])
    const failed = records[1]
    expect(failed?.subject).toContain(`packages/child at ${unpushed} is not on ${child}`)
    // What was READ, so the record answers "why is a missing pin the
    // submitter's here" without its reader going to the journal.
    expect(trailer(failed!, "Remote-Answered")).toBe("yes")
    expect(trailer(failed!, "Gitlink")).toBe(`packages/child@${unpushed}`)
    expect(trailer(failed!, "Fault")).toBe("submitter")
    expect(trailer(failed!, "Remedy")).toContain("push the component commit to its remote")
  })

  it("sticks the change on the queue when the remote cannot be reached either", async () => {
    const w = await world()
    const { child } = await withUnpushedGitlink(w)
    const head = await submitCommit(w, "task/one", "one.txt")
    // Nothing answers, so nothing can be attributed, so nobody is billed.
    rmSync(child, { force: true, recursive: true })

    const outcome = await queueRun(await w.options({ exit: 0 }))

    expect(outcome.exitCode).toBe(2)
    expect(outcome.stuck).toEqual(["task/one"])
    expect(outcome.failed).toEqual([])
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    const stuck = records.find((record) => record.kind === "stuck")
    expect(incidentOf(stuck).Code).toBe("yrd-reference-unpopulated")
    // A stuck bills nobody, and says so by saying nothing.
    expect(records.flatMap((record) => record.trailers.filter(([name]) => name === "Fault"))).toEqual([])
  })
})

/**
 * @failure A delivery failure carrying a line break is refused at record-write time and
 *          takes the whole run down, replacing the record that says what happened with none.
 *
 * One trailer is one line (`recordMessage` in records.ts). Two producers feed
 * `Delivery-Error` and only one was safe: a notifier that EXITS non-zero has
 * its output collapsed where it is read, while a notifier that could not RUN
 * carries the thrown message verbatim — and a spawn or timeout message is
 * routinely several lines.
 */
describe("a notify entry that could not run at all", () => {
  it("records its multi-line failure on one line instead of crashing the run", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const thrown = "spawn failed\n  at the first frame\n  at the second frame"
    await using runner = createProcess({ cwd: w.work })
    const failingNotifier = {
      ...runner,
      run: async (request: Parameters<typeof runner.run>[0]) => {
        if (request.argv.join(" ").includes(w.notifier)) throw new Error(thrown)
        return runner.run(request)
      },
    }

    const outcome = await queueRun({ ...(await w.options({ exit: 0 })), process: failingNotifier })

    // The ending itself is decided before anything is delivered, so a delivery
    // that could not happen must not change it — and must not lose it either.
    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/one"])
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    const sent = records.find((record) => record.kind === "sent")
    expect(sent, "the sent record was never written").toBeDefined()
    const said = trailer(sent!, "Delivery-Error")
    expect(said).not.toContain("\n")
    // Every character survives; only the line breaks became spaces, so the
    // trailer stays as loud as the message it carries.
    expect(said).toContain("spawn failed   at the first frame   at the second frame")
  })
})
