/**
 * One queue run, end to end, against a real remote and a real check script.
 *
 * Every case asserts on what the plan says a reader can see: the exit code,
 * the target's commits, the change's facts at the remote, and the message the
 * notifier was handed. Nothing internal.
 */

import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  CHANGES,
  appendFact,
  changeName,
  changeRef,
  checkLogPath,
  gitIn,
  list,
  queueRun,
  readFacts,
  readQueue,
  runCheck,
  submit,
  trailer,
  trailers,
} from "../src/index.ts"
import type { CheckedTree, Git, QueueRunOptions, QueueRunOutcome } from "../src/index.ts"

const roots: string[] = []

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
  checkLog: string
  /** The target's `setup:`, exiting as the case says; it records its own working directory in `checkLog`, beside the check's. */
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
  ): QueueRunOptions
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
  writeFileSync(join(work, ".yrd.yml"), "remote: origin\n")
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
    notifyLog,
    setupCommand: (exit) => `${setupScript} ${String(exit)}`,
    options: (check) => ({
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
      },
      notify: notifier,
      remote: "origin",
      repo: work,
      ...(check.setup === undefined ? {} : { setup: check.setup }),
      target: "main",
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
  await submit(w.git, "origin", { branch, submitter: "@dev/2", target: "main", workItem: "@i/10-yrd/1" })
  return head
}

async function remoteTarget(w: World): Promise<string> {
  return (await w.git(["ls-remote", "--refs", "origin", "refs/heads/main"])).trim().split(/\s+/u)[0] ?? ""
}

/** One commit on the target, pushed by hand: the thing only the queue may do. */
async function pushByHand(w: World, file: string): Promise<string> {
  await w.git(["checkout", "--quiet", "main"])
  writeFileSync(join(w.work, file), `${file}\n`)
  await w.git(["add", file])
  await w.git(["commit", "--quiet", "-m", `${file} by hand`])
  await w.git(["push", "--quiet", "origin", "main"])
  return (await w.git(["rev-parse", "HEAD"])).trim()
}

/** The declaration itself edited on the target and pushed by hand: the commit that used to become the boundary and hide itself. */
async function editDeclarationByHand(w: World, text: string): Promise<string> {
  await w.git(["checkout", "--quiet", "main"])
  writeFileSync(join(w.work, ".yrd.yml"), text)
  await w.git(["add", ".yrd.yml"])
  await w.git(["commit", "--quiet", "-m", "edit the declaration by hand"])
  await w.git(["push", "--quiet", "origin", "main"])
  return (await w.git(["rev-parse", "HEAD"])).trim()
}

/** Every record of a run's log, in order. */
function records(outcome: QueueRunOutcome): readonly Record<string, unknown>[] {
  return readFileSync(outcome.log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** The log path an ended `check` row named, for one branch, phase and check name. */
function checkLogFor(outcome: QueueRunOutcome, branch: string, phase: string, name: string): string {
  const row = records(outcome).find(
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
  await appendFact(w.git, {
    change: { branch: "main", head },
    kind: "opened",
    subject: "unknown submitted main to main",
    target: "main",
    trailers: [["Submitter", "unknown"]],
  })
  const ref = changeRef({ branch: "main", head })
  await w.git(["push", "--quiet", "origin", `${ref}:${ref}`])
}

async function fetchChanges(w: World): Promise<void> {
  await w.git(["fetch", "--quiet", "origin", "+refs/yrd/changes/*:refs/yrd/changes/*"])
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
  })
})

describe("a queue run", () => {
  it("pass: the change is checked, merged, the target moves by one merge commit, and the submitter is told to close their bead", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(w.options({ exit: 0 }))

    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/one"])
    expect(outcome.byHand).toEqual([])
    const after = await remoteTarget(w)
    expect(after).not.toBe(w.target)
    await w.git(["fetch", "--quiet", "origin", "main"])
    const parents = (await w.git(["rev-list", "--parents", "-n", "1", after])).trim().split(/\s+/u).slice(1)
    expect(parents).toEqual([w.target, head])
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/changes/*:refs/yrd/changes/*"])
    const facts = await readFacts(w.git, { branch: "task/one", head })
    // checked after the on-submit phase, merged after the on-merge phase, sent last.
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "checked", "merged", "sent"])
    // The queue list row names the merge commit and its base in full, for whoever proves a landing by ancestry.
    const row = list((await readQueue(w.git, "origin", "main")).changes).find(
      (candidate) => candidate.branch === "task/one",
    )
    expect(row?.state).toBe("merged")
    expect(row?.merge).toBe(after)
    expect(row?.base).toBe(w.target)
    const sent = messages(w)
    expect(sent).toHaveLength(1)
    // The record is the notifier's contract, unchanged: its kinds are landed, send-back and yrd-broken.
    expect(sent[0]).toMatchObject({
      branch: "task/one",
      failures: 0,
      kind: "landed",
      pr: "task/one",
      sha: head,
      submitter: "@dev/2",
      to: "submitter",
      workItem: "@i/10-yrd/1",
    })
    expect(sent[0]?.attempt_id).toBe(facts[2]?.sha)
    expect(
      readFileSync(outcome.log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { kind: string }).kind),
    ).toEqual(expect.arrayContaining(["run", "change", "check", "result", "merge", "message"]))
  })

  it("a second writer that takes the change ref between the read and the push loses neither fact", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const ref = changeRef({ branch: "task/one", head })
    const rivalPath = join(w.workdir, "..", "fact-rival")
    await gitIn(join(w.workdir, ".."))(["clone", "--quiet", w.remote, rivalPath])
    const rival = gitIn(rivalPath)
    await rival(["config", "user.email", "rival@yrd.test"])
    await rival(["config", "user.name", "rival"])

    let concurrent: string | undefined
    const git: Git = async (args, input) => {
      // Between the tip this run read the change at and its leased push, a
      // second queue appends a fact of its own and pushes it first. A real
      // writer at the real remote, not a reading of this one's argv.
      if (concurrent === undefined && args.some((arg) => arg.startsWith(`--force-with-lease=${ref}:`))) {
        await rival(["fetch", "--quiet", "origin", `${ref}:${ref}`])
        concurrent = await appendFact(rival, {
          change: { branch: "task/one", head },
          kind: "stuck",
          subject: "another queue got there first",
          target: "main",
          trailers: [["Reason", "crash"]],
        })
        await rival(["push", "--quiet", "origin", `${concurrent}:${ref}`])
      }
      return w.git(args, input)
    }

    const outcome = await queueRun({ ...w.options({ exit: 0, on: ["submit"] }), git })

    // The lease refused the first push, so the rival's fact stands; the same
    // fact was written again onto it and pushed, so neither is lost and the
    // run went on to merge.
    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/one"])
    await fetchChanges(w)
    const facts = await readFacts(w.git, { branch: "task/one", head })
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "stuck", "checked", "merged", "sent"])
    expect(facts.map((fact) => fact.sha)).toContain(concurrent)
    expect(records(outcome)).toContainEqual(
      expect.objectContaining({ decision: "checked", reason: "change-ref-taken", remote: concurrent }),
    )
  })

  it("fail: the target stands still, the change ends failed with the check and a remedy, and the submitter gets it back", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(w.options({ exit: 1 }))

    expect(outcome.exitCode).toBe(1)
    expect(outcome.failed).toEqual(["task/one"])
    expect(await remoteTarget(w)).toBe(w.target)
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/changes/*:refs/yrd/changes/*"])
    const facts = await readFacts(w.git, { branch: "task/one", head })
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "checked", "failed", "sent"])
    expect(facts[2]?.trailers).toEqual(
      expect.arrayContaining([
        ["Reason", "verify"],
        ["Fault", "submitter"],
      ]),
    )
    expect(messages(w)[0]).toMatchObject({
      code: "verify",
      disposition: "author",
      kind: "send-back",
      submitter: "@dev/2",
      to: "submitter",
    })
  })

  it("stuck: a check that exits 2 stops the run, bills nobody, and goes to the owner's role", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(w.options({ exit: 2 }))

    expect(outcome.exitCode).toBe(2)
    expect(outcome.stuck).toEqual(["task/one"])
    expect(await remoteTarget(w)).toBe(w.target)
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/changes/*:refs/yrd/changes/*"])
    const facts = await readFacts(w.git, { branch: "task/one", head })
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "checked", "stuck", "sent"])
    // A stuck fact names the check as its reason and says nothing about fault:
    // stuck is always the queue's, and a constant trailer says nothing.
    expect(facts[2]?.trailers).toEqual(expect.arrayContaining([["Reason", "verify"]]))
    expect(facts[2]?.trailers.filter(([name]) => name === "Fault" || name === "Cause")).toEqual([])
    expect(facts[3]?.trailers).toEqual(
      expect.arrayContaining([
        ["To", "owner"],
        ["State", "stuck"],
        ["Reason", "verify"],
      ]),
    )
    expect(messages(w)[0]).toMatchObject({ code: "verify", kind: "yrd-broken", to: "owner" })
  })

  it("a check past its bound is stuck, not the submitter's", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(w.options({ sleep: 3, timeoutMs: 500 }))

    expect(outcome.exitCode).toBe(2)
    expect(messages(w)[0]?.command).toMatch(/ran past its bound/u)
  })

  it("a check declaring a scripts: path the target does not carry is loud: the change ends stuck and names it (D5)", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const base = w.options({ on: ["submit"] })

    const outcome = await queueRun({
      ...base,
      checks: base.checks.map((check) => ({ ...check, scripts: ["gates/absent.sh"] })),
    })

    // A gate the queue cannot restore from the protected side is the queue's
    // own ground missing, never the submitter's: stuck, and nobody is billed.
    expect(outcome.exitCode).toBe(2)
    expect(outcome.stuck).toEqual(["task/one"])
    await fetchChanges(w)
    const facts = await readFacts(w.git, { branch: "task/one", head })
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "stuck", "sent"])
    expect(facts[1]?.subject).toContain("gates/absent.sh")
    expect(messages(w)[0]).toMatchObject({ kind: "yrd-broken", to: "owner" })
    expect(messages(w)[0]?.command).toContain("does not carry")
  })

  it("POSITIVE CONTROL: a declared scripts: path the target does carry is restored and judged (D5)", async () => {
    // Without this, the loud case above is satisfied just as well by a
    // `scripts:` list that can never be restored at all.
    const w = await world()
    const base = w.options({ exit: 0, on: ["submit"] })
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
    const base = w.options({ on: ["submit"] })

    const outcome = await queueRun({
      ...base,
      checks: base.checks.map((check) => ({ ...check, run: "sleep 30 & exit 0" })),
    })

    expect(outcome.exitCode).toBe(2)
    expect(outcome.stuck).toEqual(["task/one"])
    await fetchChanges(w)
    const facts = await readFacts(w.git, { branch: "task/one", head })
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "stuck", "sent"])
    const wedged = facts[1]
    if (wedged === undefined) throw new Error("no stuck fact")
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
      // is about to push, and somebody else lands on the target in between.
      if (moved === undefined && args.includes("--atomic") && args.some((arg) => arg.endsWith(":refs/heads/main"))) {
        writeFileSync(join(rivalPath, "rival.txt"), "rival\n")
        await rival(["add", "rival.txt"])
        await rival(["commit", "--quiet", "-m", "the target moved under the change"])
        await rival(["push", "--quiet", "origin", "main"])
        moved = (await rival(["rev-parse", "HEAD"])).trim()
      }
      return w.git(args, input)
    }

    const outcome = await queueRun({ ...w.options({ exit: 0 }), git })

    // The change keeps its place and is judged again at the new target next
    // run: nothing landed, nothing ended, and nobody was told anything.
    expect(outcome.exitCode).toBe(0)
    expect(outcome.stuck).toEqual([])
    expect(outcome.merged).toEqual([])
    expect(await remoteTarget(w)).toBe(moved)
    await fetchChanges(w)
    expect((await readFacts(w.git, { branch: "task/one", head })).map((fact) => fact.kind)).toEqual(["opened", "checked"])
    expect(messages(w)).toEqual([])
    expect(records(outcome)).toContainEqual(
      expect.objectContaining({ decision: "checked", reason: "target-moved", saw: moved }),
    )
  })

  it("nothing submitted is nothing to do", async () => {
    const w = await world()
    const outcome = await queueRun(w.options({}))
    expect(outcome.exitCode).toBe(0)
    expect(await remoteTarget(w)).toBe(w.target)
    expect(messages(w)).toEqual([])
  })

  it("a failing notifier changes nothing about the change, and the next run sends the same message again", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    // The notifier is down: the merge still happens, the sent fact says the
    // delivery failed, and the run is not stuck (ruling D9).
    const down = await queueRun({ ...w.options({ exit: 0 }), notify: "sh -c 'echo notifier down >&2; exit 3'" })
    expect(down.exitCode).toBe(0)
    expect(down.merged).toEqual(["task/one"])
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/changes/*:refs/yrd/changes/*"])
    let facts = await readFacts(w.git, { branch: "task/one", head })
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "checked", "merged", "sent"])
    expect(facts.at(-1)?.trailers).toEqual(
      expect.arrayContaining([
        ["State", "merged"],
        ["Delivery", "failed"],
      ]),
    )
    expect(messages(w)).toEqual([])

    // The notifier is back: the same message, with the merged fact's sha as its id.
    const again = await queueRun(w.options({ exit: 0 }))
    expect(again.exitCode).toBe(0)
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/changes/*:refs/yrd/changes/*"])
    facts = await readFacts(w.git, { branch: "task/one", head })
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "checked", "merged", "sent", "sent"])
    expect(facts.at(-1)?.trailers).toEqual(
      expect.arrayContaining([
        ["To", "submitter @dev/2"],
        ["Delivery", "sent"],
      ]),
    )
    const merged = facts.find((fact) => fact.kind === "merged")
    expect(messages(w)).toHaveLength(1)
    expect(messages(w)[0]).toMatchObject({ attempt_id: merged?.sha, kind: "landed", to: "submitter" })
  })

  it("a change merged by hand reads merged, its catch-up fact says a hand did it, and the hand merge is reported once (E5)", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    // The garage lands it by hand: a merge commit on main, pushed.
    await w.git(["merge", "--quiet", "--no-ff", "--no-edit", "-m", "landed by hand", head])
    const landing = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["push", "--quiet", "origin", "main"])

    const rivalPath = join(w.workdir, "..", "catch-up-rival")
    await gitIn(join(w.workdir, ".."))(["clone", "--quiet", w.remote, rivalPath])
    const rival = gitIn(rivalPath)
    await rival(["config", "user.email", "rival@yrd.test"])
    await rival(["config", "user.name", "rival"])
    const ref = changeRef({ branch: "task/one", head })
    let concurrent: string | undefined
    let advance = true
    const git: Git = async (args, input) => {
      const refspec = args.find((arg) => arg.endsWith(`:${ref}`))
      const leased = args.some((arg) => arg.startsWith(`--force-with-lease=${ref}:`))
      if (advance && leased && refspec !== undefined) {
        advance = false
        await rival(["fetch", "--quiet", "origin", `${ref}:${ref}`])
        concurrent = await appendFact(rival, {
          change: { branch: "task/one", head },
          kind: "merged",
          subject: `another queue observed the hand merge at ${landing.slice(0, 12)}`,
          target: "main",
          trailers: [
            ["Merge", landing],
            ["Base", w.target],
            ["Merged-By", "hand"],
          ],
        })
        await rival(["push", "--quiet", "origin", `${concurrent}:${ref}`])
      }
      return w.git(args, input)
    }

    const outcome = await queueRun({ ...w.options({ exit: 0 }), git })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual([])
    expect(outcome.byHand).toEqual([landing])
    expect(await remoteTarget(w)).toBe(landing)
    await fetchChanges(w)
    const facts = await readFacts(w.git, { branch: "task/one", head })
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "merged", "merged", "sent"])
    expect(facts.map((fact) => fact.sha)).toContain(concurrent)
    expect(facts[2]?.subject).toBe(`merged by hand at ${landing.slice(0, 12)}`)
    // `Base:` is the landing commit's first parent, a sha like every other Base.
    expect(facts[2]?.trailers).toEqual(
      expect.arrayContaining([
        ["Merge", landing],
        ["Base", w.target],
        ["Merged-By", "hand"],
      ]),
    )
    expect(facts[3]?.trailers).toEqual(
      expect.arrayContaining([
        ["State", "merged"],
        ["Merged-By", "hand"],
      ]),
    )
    expect(records(outcome)).toContainEqual(
      expect.objectContaining({ decision: "merged", reason: "change-ref-taken", remote: concurrent }),
    )
    // Two messages: the submitter hears the change merged; the owner's role hears the
    // target moved by hand, once, with the merge commit as the message's id.
    expect(messages(w).filter((message) => message.kind === "landed")).toMatchObject([{ submitter: "@dev/2", to: "submitter" }])
    const broken = messages(w).filter((message) => message.kind === "yrd-broken")
    expect(broken).toMatchObject([{ attempt_id: landing, pr: "main", sha: landing, to: "owner" }])
    expect(broken[0]?.command).toContain(`main moved by hand at ${landing.slice(0, 12)} (landed by hand)`)
    expect(broken[0]?.command).toContain("it carries no Change: trailer")
    expect(records(outcome).filter((record) => record.kind === "by-hand")).toMatchObject([
      { commit: landing, gitlinks: [], parents: [w.target, head], subject: "landed by hand" },
    ])

    // The next run says nothing new: the catch-up fact accounts for the commit.
    const again = await queueRun(w.options({ exit: 0 }))
    expect(again.byHand).toEqual([])
    expect(records(again).filter((record) => record.kind === "by-hand")).toEqual([])
    expect(messages(w).filter((message) => message.kind === "yrd-broken")).toHaveLength(1)
  })

  it("a change that ended failed and was then merged by hand gets one message, the merged one, and its tip says merged", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    // It failed its check, and the notifier was down, so the send-back is owed:
    // exactly what makes the next run try to deliver it again (ruling D9).
    const down = await queueRun({ ...w.options({ exit: 1 }), notify: "sh -c 'exit 3'" })
    expect(down.exitCode).toBe(1)
    expect(messages(w)).toEqual([])

    // The garage landed it by hand all the same.
    await w.git(["checkout", "--quiet", "main"])
    await w.git(["merge", "--quiet", "--no-ff", "--no-edit", "-m", "landed by hand", head])
    await w.git(["push", "--quiet", "origin", "main"])

    const outcome = await queueRun(w.options({ exit: 0 }))

    expect(outcome.exitCode).toBe(0)
    await fetchChanges(w)
    // The catch-up merged fact and its message, and no second ending on top of it.
    const facts = await readFacts(w.git, { branch: "task/one", head })
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "checked", "failed", "sent", "merged", "sent"])
    expect(facts.at(-1)?.trailers).toEqual(expect.arrayContaining([["State", "merged"]]))
    expect(messages(w).filter((message) => message.branch === "task/one").map((message) => message.kind)).toEqual([
      "landed",
    ])
  })

  it("the target is not a change: a ref named after it is judged by nothing and messages nobody (2026-09-03 main@0a9db9daf7eb)", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")
    // The one path in refuses it now; the ref is planted the way the remote holds it.
    await expect(submit(w.git, "origin", { branch: "main", submitter: "unknown", target: "main" })).rejects.toThrow(
      "main is the target, not a change",
    )
    await plantTargetChange(w, w.target)

    // The queue merges the real change. The merge's first parent is the head
    // the planted ref is named after — which is what made the next run call
    // that ref merged, name the queue's own merge as its landing, and write a
    // `Merged-By: hand` fact on it.
    const merging = await queueRun(w.options({ exit: 0 }))
    expect(merging.merged).toEqual(["task/one"])
    const merge = await remoteTarget(w)
    expect((await w.git(["rev-parse", `${merge}^1`])).trim()).toBe(w.target)

    // The run after the merge: the one that in the specimen wrote `merged by
    // hand at 005a622156c7` and told the owner's role to close a bead for it.
    const after = await queueRun(w.options({ exit: 0 }))

    expect(after.exitCode).toBe(0)
    expect(after.merged).toEqual([])
    expect(after.byHand).toEqual([])
    await fetchChanges(w)
    // The planted ref still holds the one fact that was written on it, and no
    // run considered it: no fact, no row, no message.
    expect((await readFacts(w.git, { branch: "main", head: w.target })).map((fact) => fact.kind)).toEqual(["opened"])
    for (const outcome of [merging, after]) {
      expect(records(outcome).filter((record) => record.kind === "change" && record.branch === "main")).toEqual([])
      expect(records(outcome).filter((record) => record.kind === "by-hand")).toEqual([])
    }
    expect(messages(w).filter((message) => (message.command ?? "").includes("main@"))).toEqual([])
    expect(messages(w).filter((message) => message.to === "owner")).toEqual([])
    expect(messages(w).map((message) => message.to)).toEqual(["submitter"])
  })

  it("the merge commit names its change, its submitter and its work item, and the merged fact says the queue merged it and what it checked (E5)", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(w.options({ exit: 0 }))

    expect(outcome.merged).toEqual(["task/one"])
    await w.git(["fetch", "--quiet", "origin", "main"])
    const merge = await remoteTarget(w)
    expect((await w.git(["log", "-1", "--format=%s", merge])).trim()).toBe(
      `merge task/one@${head.slice(0, 12)} into main`,
    )
    // The trailer is the change's name, which under the one prefix is its ref:
    // `git log refs/yrd/changes/<that name>` prints the facts.
    const named = await trailerOn(w, merge, "Change")
    expect(named).toBe(changeName({ branch: "task/one", head }))
    expect(`${CHANGES}/${named}`).toBe(changeRef({ branch: "task/one", head }))
    expect(await trailerOn(w, merge, "Work-Item")).toBe("@i/10-yrd/1")
    expect(await trailerOn(w, merge, "Submitter")).toBe("@dev/2")
    await fetchChanges(w)
    // The facts and the genesis, on the ref's first-parent line (facts.ts).
    expect(
      (await w.git(["log", "--first-parent", "--format=%s", `${CHANGES}/${named}`])).trim().split("\n"),
    ).toHaveLength(5)
    const facts = await readFacts(w.git, { branch: "task/one", head })
    const merged = facts.find((fact) => fact.kind === "merged")
    if (merged === undefined) throw new Error("no merged fact")
    expect(trailer(merged, "Merged-By")).toBe("queue")
    expect(trailer(merged, "Merge")).toBe(merge)
    // One `Check:` per on-merge check, in the shape the checked fact uses.
    expect(trailers(merged, "Check")).toEqual([expect.stringMatching(/^verify exit=0 ms=\d+ log=\S+$/u)])
    expect(facts.at(-1)?.trailers).toEqual(
      expect.arrayContaining([
        ["To", "submitter @dev/2"],
        ["Delivery", "sent"],
        ["Merged-By", "queue"],
      ]),
    )
  })

  it("a commit pushed to the target by hand is reported once to the owner's role, and the queue goes on from the new base (E5)", async () => {
    const w = await world()
    const hand = await pushByHand(w, "hand.txt")
    const head = await submitCommit(w, "task/one", "one.txt")

    const first = await queueRun(w.options({ exit: 0 }))

    expect(first.exitCode).toBe(0)
    expect(first.byHand).toEqual([hand])
    expect(first.merged).toEqual(["task/one"])
    expect(records(first).filter((record) => record.kind === "by-hand")).toMatchObject([
      { commit: hand, gitlinks: [], parents: [w.target], subject: "hand.txt by hand" },
    ])
    const broken = messages(w).filter((message) => message.kind === "yrd-broken")
    expect(broken).toMatchObject([
      { attempt_id: hand, kind: "yrd-broken", pr: "main", sha: hand, to: "owner" },
    ])
    expect(broken[0]?.command).toContain(`main moved by hand at ${hand.slice(0, 12)} (hand.txt by hand)`)
    expect(broken[0]?.command).toContain("it is one commit, not a merge of a change")
    // The change merged on top of the hand commit, not on the base the queue was declared at.
    await w.git(["fetch", "--quiet", "origin", "main"])
    const parents = (await w.git(["rev-list", "--parents", "-n", "1", await remoteTarget(w)]))
      .trim()
      .split(/\s+/u)
      .slice(1)
    expect(parents).toEqual([hand, head])

    // The next run says nothing new: the queue's own merge stands on top of it.
    const second = await queueRun(w.options({ exit: 0 }))
    expect(second.byHand).toEqual([])
    expect(records(second).filter((record) => record.kind === "by-hand")).toEqual([])
    expect(messages(w).filter((message) => message.kind === "yrd-broken")).toHaveLength(1)
  })

  it("a queue that has judged nothing has no history, so it judges nothing on the target (E5)", async () => {
    // Not one change was ever submitted here, so there is no first fact and no
    // instant to start from — and every commit on the target belongs to
    // whatever moved the branch before this queue existed.
    const w = await world({ declaredLater: true })
    await pushByHand(w, "hand.txt")

    const outcome = await queueRun(w.options({ exit: 0 }))

    expect(outcome.exitCode).toBe(0)
    expect(outcome.byHand).toEqual([])
    expect(records(outcome).filter((record) => record.kind === "by-hand")).toEqual([])
    expect(messages(w)).toEqual([])
  })

  /**
   * THE HOLE THE PLAN NAMED AT THE CUTOVER (§ Owed after M5, E5's last line).
   *
   * Every earlier boundary was a commit in `.yrd.yml` — first the newest one
   * that TOUCHED the file, then the one that introduced `remote:` — and the
   * first of those let a hand push hide itself: it edited the declaration,
   * became the boundary, and took every hand commit under it out of the report.
   *
   * The boundary is the queue's own first fact now, which no commit on the
   * target can move at all. A hand push that edits the declaration is judged
   * like any other first-parent commit, and everything older than that first
   * fact belongs to whoever moved the branch before this queue existed.
   */
  it("a hand push after the queue's first change is reported, declaration edits included; anything older is not (E5)", async () => {
    const w = await world({ declaredLater: true })
    const before = await pushByHand(w, "before.txt")
    // A whole second, so the boundary is not a tie: a committer date is seconds.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await submitCommit(w, "task/one", "one.txt")
    const plain = await pushByHand(w, "hand.txt")
    const edited = await editDeclarationByHand(w, "remote: origin\ntarget: main\n")

    const outcome = await queueRun(w.options({ exit: 0 }))

    // Both hand commits, oldest first; the one from before the first change is
    // never among them.
    expect(outcome.byHand).toEqual([plain, edited])
    expect(outcome.byHand).not.toContain(before)
    expect(
      records(outcome)
        .filter((record) => record.kind === "by-hand")
        .map((record) => record.commit),
    ).toEqual([plain, edited])
    expect(messages(w).filter((message) => message.kind === "yrd-broken")).toHaveLength(2)
  })

  it("a checked change is judged again when the target's check config is not the one its checked fact names", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = await submitCommit(w, "task/two", "two.txt")

    // One merge per run: task/one lands, task/two stays checked under config A.
    const first = await queueRun({ ...w.options({ exit: 0 }), configBlob: "config-A" })
    expect(first.merged).toEqual(["task/one"])
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/changes/*:refs/yrd/changes/*"])
    let facts = await readFacts(w.git, { branch: "task/two", head: second })
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "checked"])
    expect(facts[1]?.trailers).toEqual(expect.arrayContaining([["Config", "config-A"]]))

    // The target's declaration changed: the on-submit checks run again under B
    // before the change lands, and the new checked fact names B.
    const next = await queueRun({ ...w.options({ exit: 0 }), configBlob: "config-B" })
    expect(next.merged).toEqual(["task/two"])
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/changes/*:refs/yrd/changes/*"])
    facts = await readFacts(w.git, { branch: "task/two", head: second })
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "checked", "checked", "merged", "sent"])
    expect(facts[2]?.trailers).toEqual(expect.arrayContaining([["Config", "config-B"]]))
  })
})

describe("the target's setup", () => {
  it("runs once in every worktree the run makes, before anything judges it", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(w.options({ exit: 0, setup: w.setupCommand(0) }))

    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/one"])
    const order = whereRan(w)
    // Two worktrees this run made: the change's head on the submit path, and
    // the target plus that head on the merge path. One setup each, no more.
    const prepared = order.filter(([what]) => what === "setup").map(([, where]) => where)
    expect(prepared).toHaveLength(2)
    expect(new Set(prepared).size).toBe(2)
    everyCheckWasPrepared(order)
    // The setup is recorded in a check's own shape, billed to the queue.
    expect(records(outcome).filter((record) => record.kind === "result" && record.name === "setup")).toMatchObject([
      { exit: "0", name: "setup", phase: "submit", result: "pass" },
      { exit: "0", name: "setup", phase: "merge", result: "pass" },
    ])
    // Two setups, each with a start row and an end row: four `check` rows.
    const setupRows = records(outcome).filter((record) => record.kind === "check" && record.name === "setup")
    expect(setupRows).toHaveLength(4)
    expect(setupRows.filter((record) => record.end === undefined)).toHaveLength(2)
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

    const outcome = await queueRun(w.options({ exit: 0 }))

    expect(existsSync(dead)).toBe(false)
    expect(existsSync(join(w.workdir, "worktrees", "q-dead"))).toBe(false)
    expect(existsSync(alive)).toBe(true)
    const registered = await w.git(["worktree", "list", "--porcelain"])
    expect(registered).not.toContain(dead)
    expect(registered).toContain(alive)

    // One row per worktree taken, naming it, whose it was and why it went.
    expect(records(outcome).filter((record) => record.kind === "reap")).toEqual([
      expect.objectContaining({ of: "q-dead", path: dead, why: expect.stringContaining("is not running") }),
    ])
  })

  /** A run that ends takes its own directory with it, so the reap reads exactly the runs that did not end. */
  it("leaves nothing of its own under the worktrees root when it ends", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(w.options({ exit: 0 }))

    expect(outcome.exitCode).toBe(0)
    expect(existsSync(join(w.workdir, "worktrees", outcome.run))).toBe(false)
  })

  it("runs again in the target worktree the attribution builds", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")

    // One worktree per phase, and only two phases: the change's head at
    // submit, and the head merged onto the target at merge.
    const outcome = await queueRun(w.options({ everywhere: true, exit: 1, setup: w.setupCommand(0) }))

    expect(outcome.exitCode).toBe(1)
    expect(outcome.failed).toEqual(["task/one"])
    const order = whereRan(w)
    const prepared = order.filter(([what]) => what === "setup").map(([, where]) => where)
    expect(prepared).toHaveLength(2)
    expect(new Set(prepared).size).toBe(2)
    everyCheckWasPrepared(order)
    expect(
      records(outcome)
        .filter((record) => record.kind === "result" && record.name === "setup")
        .map((record) => record.phase),
    ).toEqual(["submit", "merge"])
  })

  it("a setup that fails ends the change stuck, never failed, and nothing is judged in that worktree", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(w.options({ exit: 0, setup: w.setupCommand(1) }))

    // Stuck, exit 2: the queue could not build the ground a judgement stands
    // on, which is never the submitter's fault.
    expect(outcome.exitCode).toBe(2)
    expect(outcome.stuck).toEqual(["task/one"])
    expect(outcome.failed).toEqual([])
    expect(await remoteTarget(w)).toBe(w.target)
    await fetchChanges(w)
    const facts = await readFacts(w.git, { branch: "task/one", head })
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "stuck", "sent"])
    expect(facts[1]?.trailers).toEqual(expect.arrayContaining([["Reason", "setup"]]))
    expect(facts[1]?.trailers.filter(([name]) => name === "Fault")).toEqual([])
    // The check never ran: there was no prepared tree to run it in.
    expect(whereRan(w).filter(([what]) => what === "check")).toEqual([])
    expect(messages(w)[0]).toMatchObject({ code: "setup", kind: "yrd-broken", to: "owner" })
    expect(records(outcome).filter((record) => record.kind === "result" && record.name === "setup")).toMatchObject([
      { exit: "1", result: "fail", whose: "queue" },
    ])
  })

  it("a setup past its bound is stuck too, and the change is never billed", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    // 127 is the shell's own word for a command it could not find: a setup the
    // target names and the worktree does not have is the queue's, like any
    // other setup that did not pass.
    const outcome = await queueRun(w.options({ exit: 0, setup: "no-such-setup-command" }))

    expect(outcome.exitCode).toBe(2)
    expect(outcome.stuck).toEqual(["task/one"])
    await fetchChanges(w)
    const facts = await readFacts(w.git, { branch: "task/one", head })
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "stuck", "sent"])
    expect(facts[1]?.trailers).toEqual(expect.arrayContaining([["Reason", "setup"]]))
    expect(records(outcome).filter((record) => record.kind === "result" && record.name === "setup")).toMatchObject([
      { exit: "missing", result: "stuck", whose: "queue" },
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

    const outcome = await queueRun(w.options({ exit: 1, on: ["submit"] }))

    expect(outcome.exitCode).toBe(1)
    expect(outcome.failed).toEqual(["task/one"])
    expect(outcome.stuck).toEqual([])
    expect(await remoteTarget(w)).toBe(w.target)
    await fetchChanges(w)
    const facts = await readFacts(w.git, { branch: "task/one", head })
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "failed", "sent"])
    expect(facts[1]?.trailers).toEqual(
      expect.arrayContaining([
        ["Reason", "verify"],
        ["Fault", "submitter"],
      ]),
    )
    expect(facts[1]?.trailers.filter(([name]) => name === "Check").map(([, value]) => value)).toEqual([
      expect.stringMatching(/^verify exit=1 ms=\d+ log=\S+$/u),
    ])
    expect(messages(w)[0]).toMatchObject({
      code: "verify",
      disposition: "author",
      failures: 1,
      kind: "send-back",
      submitter: "@dev/2",
      to: "submitter",
    })
    // The log the check wrote is named in the record, so the ball says where to look.
    expect(messages(w)[0]?.log_path).toBe(checkLogFor(outcome, "task/one", "submit", "verify"))
    // ONE run of the one check. Two more — the second in the change's worktree
    // and one at a whole worktree of the target — is what this deleted.
    expect(whereRan(w)).toHaveLength(1)
  })

  it("counts this branch's failures, so a second send-back can raise an andon", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")
    expect((await queueRun(w.options({ exit: 1, on: ["submit"] }))).failed).toEqual(["task/one"])
    expect(messages(w).at(-1)).toMatchObject({ failures: 1, kind: "send-back" })

    // The author pushes a new head on the same branch and submits it again.
    await w.git(["checkout", "--quiet", "task/one"])
    writeFileSync(join(w.work, "two.txt"), "two\n")
    await w.git(["add", "two.txt"])
    await w.git(["commit", "--quiet", "-m", "two"])
    await w.git(["checkout", "--quiet", "main"])
    await submit(w.git, "origin", { branch: "task/one", submitter: "@dev/2", target: "main", workItem: "@i/10-yrd/1" })

    expect((await queueRun(w.options({ exit: 1, on: ["submit"] }))).failed).toEqual(["task/one"])

    // Two: the change that failed under the old head, and this one.
    expect(messages(w).at(-1)).toMatchObject({ failures: 2, kind: "send-back" })
  })

  it("a check that is red at the target too still bills the submitter, and the queue keeps running", async () => {
    // The old reading called this `inherited` and stopped the queue on it. The
    // target is proven green by its own last merge; a red one is a person's
    // problem, not a reason to hold every change behind it.
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(w.options({ everywhere: true, exit: 1, on: ["submit"] }))

    expect(outcome.exitCode).toBe(1)
    expect(outcome.failed).toEqual(["task/one"])
    expect(outcome.stuck).toEqual([])
    await fetchChanges(w)
    expect((await readFacts(w.git, { branch: "task/one", head })).map((fact) => fact.kind)).toEqual(["opened", "failed", "sent"])
    expect(whereRan(w)).toHaveLength(1)
  })
})
