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
  gitIn,
  queueRun,
  readFacts,
  submit,
  trailer,
  trailers,
} from "../src/index.ts"
import type { Git, QueueRunOptions, QueueRunOutcome } from "../src/index.ts"

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
  // The scratch root must be a real filesystem the runner can lstat; the OS
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
      owner: "@cto",
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
    branch: "main",
    head,
    kind: "opened",
    subject: "unknown submitted main to main",
    target: "main",
    trailers: [["Submitter", "unknown"]],
  })
  const ref = changeRef("main", head)
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
    const facts = await readFacts(w.git, "task/one", head)
    // checked after the on-submit phase, merged after the on-merge phase, sent last.
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "checked", "merged", "sent"])
    const sent = messages(w)
    expect(sent).toHaveLength(1)
    // The record is the notifier's contract, unchanged: its kinds are landed, send-back and yrd-broken.
    expect(sent[0]).toMatchObject({
      branch: "task/one",
      head,
      kind: "landed",
      pr: "task/one",
      recipient: "@dev/2",
      workItem: "@i/10-yrd/1",
    })
    expect(sent[0]?.id).toBe(facts[2]?.sha)
    expect(
      readFileSync(outcome.log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { kind: string }).kind),
    ).toEqual(expect.arrayContaining(["run", "change", "check", "result", "merge", "message"]))
  })

  it("a stale local change ref cannot kill two consecutive merges after the remote ref moves", async () => {
    const w = await world()
    const firstHead = await submitCommit(w, "task/one", "one.txt")
    const secondHead = await submitCommit(w, "task/two", "two.txt")
    const rivalPath = join(w.workdir, "..", "rival")
    await gitIn(join(w.workdir, ".."))(["clone", "--quiet", w.remote, rivalPath])
    const rival = gitIn(rivalPath)
    await rival(["config", "user.email", "rival@yrd.test"])
    await rival(["config", "user.name", "rival"])
    let mergeNumber = 0
    let afterMerge: Readonly<{ merged: string; number: number; ref: string; stale: string }> | undefined
    let rewindBeforeAppend: Readonly<{ ref: string; remote: string; stale: string }> | undefined
    let concurrent: string | undefined
    const git: Git = async (args, input) => {
      const refspec = args.find((arg) => arg.includes(":refs/yrd/changes/"))
      const destination = refspec?.split(":").at(-1)
      const mergesTarget = args.includes("--atomic") && args.some((arg) => arg.endsWith(":refs/heads/main"))
      if (mergesTarget && refspec !== undefined && destination !== undefined) {
        const source = refspec.slice(0, -destination.length - 1)
        const intended = (await w.git(["rev-parse", `${source}^{commit}`])).trim()
        const stale = (await w.git(["rev-parse", `${intended}^`])).trim()
        mergeNumber += 1
        // The first race lands between appendFact and the atomic target push:
        // main must never land without the exact merged fact beside it.
        if (mergeNumber === 1) await w.git(["update-ref", destination, stale, intended])
        const result = await w.git(args, input)
        afterMerge = { merged: intended, number: mergeNumber, ref: destination, stale }
        return result
      }
      if (args[0] === "update-ref" && afterMerge?.number === 1 && args[1] === afterMerge.ref) {
        const result = await w.git(args, input)
        rewindBeforeAppend = { ref: afterMerge.ref, remote: afterMerge.merged, stale: afterMerge.stale }
        afterMerge = undefined
        return result
      }
      // An updater that began before the merge can finish after the helper's
      // alignment and rewind the local ref before appendFact reads its parent.
      if (
        rewindBeforeAppend !== undefined &&
        args[0] === "rev-parse" &&
        args.at(-1) === `${rewindBeforeAppend.ref}^{commit}`
      ) {
        const race = rewindBeforeAppend
        rewindBeforeAppend = undefined
        await w.git(["update-ref", race.ref, race.stale, race.remote])
      }
      // A second clone advances the remote after this clone appended its sent
      // fact. Git reports this production-shaped rejection as `fetch first`
      // or `stale info`, not necessarily `non-fast-forward`.
      if (!args.includes("--atomic") && afterMerge?.number === 2 && destination === afterMerge.ref) {
        const race = afterMerge
        afterMerge = undefined
        await rival(["fetch", "--quiet", "origin", `${race.ref}:${race.ref}`])
        concurrent = await appendFact(rival, {
          branch: "task/two",
          head: secondHead,
          kind: "sent",
          subject: "a concurrent queue recorded the delivered merge",
          target: "main",
          trailers: [
            ["Message-Id", race.merged],
            ["To", "@dev/2"],
            ["State", "merged"],
            ["For", race.merged],
            ["Delivery", "sent"],
          ],
        })
        await rival(["push", "--quiet", "origin", `${concurrent}:${race.ref}`])
      }
      return w.git(args, input)
    }

    const first = await queueRun({ ...w.options({ exit: 0 }), git })
    const second = await queueRun({ ...w.options({ exit: 0 }), git })

    expect(first).toMatchObject({ exitCode: 0, merged: ["task/one"], stuck: [] })
    expect(second).toMatchObject({ exitCode: 0, merged: ["task/two"], stuck: [] })
    expect(records(second)).toContainEqual(
      expect.objectContaining({
        intended: expect.any(String),
        reason: "change-ref-conflict",
        relation: "diverged",
        remote: concurrent,
      }),
    )
    await fetchChanges(w)
    expect((await readFacts(w.git, "task/one", firstHead)).map((fact) => fact.kind)).toEqual([
      "opened",
      "checked",
      "merged",
      "sent",
    ])
    expect((await readFacts(w.git, "task/two", secondHead)).map((fact) => fact.kind)).toEqual([
      "opened",
      "checked",
      "merged",
      "sent",
      "sent",
    ])
    expect((await readFacts(w.git, "task/two", secondHead)).map((fact) => fact.sha)).toContain(concurrent)
  })

  it("fail: the target stands still, the change ends failed with the check and a remedy, and the submitter gets it back", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(w.options({ exit: 1 }))

    expect(outcome.exitCode).toBe(1)
    expect(outcome.failed).toEqual(["task/one"])
    expect(await remoteTarget(w)).toBe(w.target)
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/changes/*:refs/yrd/changes/*"])
    const facts = await readFacts(w.git, "task/one", head)
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
      recipient: "@dev/2",
    })
  })

  it("stuck: a check that exits 2 stops the run, bills nobody, and tells the queue owner", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(w.options({ exit: 2 }))

    expect(outcome.exitCode).toBe(2)
    expect(outcome.stuck).toEqual(["task/one"])
    expect(await remoteTarget(w)).toBe(w.target)
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/changes/*:refs/yrd/changes/*"])
    const facts = await readFacts(w.git, "task/one", head)
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "checked", "stuck", "sent"])
    // A stuck fact names the check as its reason and says nothing about fault:
    // stuck is always the queue's, and a constant trailer says nothing.
    expect(facts[2]?.trailers).toEqual(expect.arrayContaining([["Reason", "verify"]]))
    expect(facts[2]?.trailers.filter(([name]) => name === "Fault" || name === "Cause")).toEqual([])
    expect(facts[3]?.trailers).toEqual(
      expect.arrayContaining([
        ["To", "@cto"],
        ["State", "stuck"],
        ["Reason", "verify"],
      ]),
    )
    expect(messages(w)[0]).toMatchObject({ code: "verify", kind: "yrd-broken", recipient: "@cto" })
  })

  it("inherited: a check that fails at the target too is the target's, so the change is stuck and nobody is billed", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(w.options({ everywhere: true, exit: 1 }))

    expect(outcome.exitCode).toBe(2)
    expect(outcome.stuck).toEqual(["task/one"])
    expect(await remoteTarget(w)).toBe(w.target)
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/changes/*:refs/yrd/changes/*"])
    const facts = await readFacts(w.git, "task/one", head)
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "checked", "stuck", "sent"])
    expect(facts[2]?.trailers).toEqual(expect.arrayContaining([["Reason", "inherited"]]))
    expect(messages(w)[0]).toMatchObject({ kind: "yrd-broken", recipient: "@cto" })
    expect(messages(w)[0]?.text).toMatch(/the target is red, not the change/u)
  })

  it("a check past its bound is stuck, not the submitter's", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(w.options({ sleep: 3, timeoutMs: 500 }))

    expect(outcome.exitCode).toBe(2)
    expect(messages(w)[0]?.text).toMatch(/ran past its bound/u)
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
    let facts = await readFacts(w.git, "task/one", head)
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
    facts = await readFacts(w.git, "task/one", head)
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "checked", "merged", "sent", "sent"])
    expect(facts.at(-1)?.trailers).toEqual(
      expect.arrayContaining([
        ["To", "@dev/2"],
        ["Delivery", "sent"],
      ]),
    )
    const merged = facts.find((fact) => fact.kind === "merged")
    expect(messages(w)).toHaveLength(1)
    expect(messages(w)[0]).toMatchObject({ attempt_id: merged?.sha, kind: "landed", recipient: "@dev/2" })
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
    const ref = changeRef("task/one", head)
    let concurrent: string | undefined
    let advance = true
    const git: Git = async (args, input) => {
      const refspec = args.find((arg) => arg.endsWith(`:${ref}`))
      const leased = args.some((arg) => arg.startsWith(`--force-with-lease=${ref}:`))
      if (advance && leased && refspec !== undefined) {
        advance = false
        await rival(["fetch", "--quiet", "origin", `${ref}:${ref}`])
        concurrent = await appendFact(rival, {
          branch: "task/one",
          head,
          kind: "merged",
          subject: `another queue observed the hand merge at ${landing.slice(0, 12)}`,
          target: "main",
          trailers: [
            ["Merge", landing],
            ["Base", `${landing}^1`],
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
    const facts = await readFacts(w.git, "task/one", head)
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "merged", "merged", "sent"])
    expect(facts.map((fact) => fact.sha)).toContain(concurrent)
    expect(facts[2]?.subject).toBe(`merged by hand at ${landing.slice(0, 12)}`)
    expect(facts[2]?.trailers).toEqual(
      expect.arrayContaining([
        ["Merge", landing],
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
      expect.objectContaining({
        intended: expect.any(String),
        reason: "change-ref-conflict",
        relation: "diverged",
        remote: concurrent,
      }),
    )
    // Two messages: the submitter hears the change merged; the owner hears the
    // target moved by hand, once, with the merge commit as the message's id.
    expect(messages(w).filter((message) => message.kind === "landed")).toMatchObject([{ recipient: "@dev/2" }])
    const broken = messages(w).filter((message) => message.kind === "yrd-broken")
    expect(broken).toMatchObject([{ attempt_id: landing, id: landing, pr: "main", recipient: "@cto", sha: landing }])
    expect(broken[0]?.text).toContain(`main moved by hand at ${landing.slice(0, 12)} (landed by hand)`)
    expect(broken[0]?.text).toContain("it carries no Change: trailer")
    expect(records(outcome).filter((record) => record.kind === "by-hand")).toMatchObject([
      { commit: landing, gitlinks: [], parents: [w.target, head], subject: "landed by hand" },
    ])

    // The next run says nothing new: the catch-up fact accounts for the commit.
    const again = await queueRun(w.options({ exit: 0 }))
    expect(again.byHand).toEqual([])
    expect(records(again).filter((record) => record.kind === "by-hand")).toEqual([])
    expect(messages(w).filter((message) => message.kind === "yrd-broken")).toHaveLength(1)
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
    // hand at 005a622156c7` and told the owner to close a bead for it.
    const after = await queueRun(w.options({ exit: 0 }))

    expect(after.exitCode).toBe(0)
    expect(after.merged).toEqual([])
    expect(after.byHand).toEqual([])
    await fetchChanges(w)
    // The planted ref still holds the one fact that was written on it, and no
    // run considered it: no fact, no row, no message.
    expect((await readFacts(w.git, "main", w.target)).map((fact) => fact.kind)).toEqual(["opened"])
    for (const outcome of [merging, after]) {
      expect(records(outcome).filter((record) => record.kind === "change" && record.branch === "main")).toEqual([])
      expect(records(outcome).filter((record) => record.kind === "by-hand")).toEqual([])
    }
    expect(messages(w).filter((message) => (message.text ?? "").includes("main@"))).toEqual([])
    expect(messages(w).filter((message) => message.recipient === "@cto")).toEqual([])
    expect(messages(w).map((message) => message.recipient)).toEqual(["@dev/2"])
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
    expect(named).toBe(changeName("task/one", head))
    expect(`${CHANGES}/${named}`).toBe(changeRef("task/one", head))
    expect(await trailerOn(w, merge, "Work-Item")).toBe("@i/10-yrd/1")
    expect(await trailerOn(w, merge, "Submitter")).toBe("@dev/2")
    await fetchChanges(w)
    // The facts and the genesis, on the ref's first-parent line (facts.ts).
    expect(
      (await w.git(["log", "--first-parent", "--format=%s", `${CHANGES}/${named}`])).trim().split("\n"),
    ).toHaveLength(5)
    const facts = await readFacts(w.git, "task/one", head)
    const merged = facts.find((fact) => fact.kind === "merged")
    if (merged === undefined) throw new Error("no merged fact")
    expect(trailer(merged, "Merged-By")).toBe("queue")
    expect(trailer(merged, "Merge")).toBe(merge)
    // One `Check:` per on-merge check, in the shape the checked fact uses.
    expect(trailers(merged, "Check")).toEqual([expect.stringMatching(/^verify exit=0 ms=\d+ log=\S+$/u)])
    expect(facts.at(-1)?.trailers).toEqual(
      expect.arrayContaining([
        ["To", "@dev/2"],
        ["Delivery", "sent"],
        ["Merged-By", "queue"],
      ]),
    )
  })

  it("a commit pushed to the target by hand is reported once to the owner, and the queue goes on from the new base (E5)", async () => {
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
      { attempt_id: hand, id: hand, kind: "yrd-broken", pr: "main", recipient: "@cto", sha: hand },
    ])
    expect(broken[0]?.text).toContain(`main moved by hand at ${hand.slice(0, 12)} (hand.txt by hand)`)
    expect(broken[0]?.text).toContain("it is one commit, not a merge of a change")
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

  it("commits on the target from before the declaration are never judged, and neither is the declaration itself (E5)", async () => {
    const w = await world({ declaredLater: true })

    const outcome = await queueRun(w.options({ exit: 0 }))

    expect(outcome.exitCode).toBe(0)
    expect(outcome.byHand).toEqual([])
    expect(records(outcome).filter((record) => record.kind === "by-hand")).toEqual([])
    expect(messages(w)).toEqual([])
  })

  /**
   * THE HOLE THE PLAN NAMED AT THE CUTOVER (§ Owed after M5, E5's last line).
   *
   * With the boundary at the newest first-parent commit that TOUCHED
   * `.yrd.yml`, a hand push that itself edits the declaration became the
   * boundary: it was excluded by the range that starts at the boundary, and so
   * was every hand commit under it. One edit and a whole stretch of the target
   * went unreported.
   *
   * The boundary is now where the `remote:` line came in, which no later edit
   * can move. A hand push that edits the declaration is judged like any other
   * first-parent commit — and the commit that introduced the line is still not
   * judged, because the queue's own history starts there.
   */
  it("a hand push that edits the declaration is reported, and the commit that introduced remote: is not (E5)", async () => {
    const w = await world({ declaredLater: true })
    const declaration = (await w.git(["rev-parse", "origin/main"])).trim()
    const plain = await pushByHand(w, "hand.txt")
    const edited = await editDeclarationByHand(w, "remote: origin\ntarget: main\n")

    const outcome = await queueRun(w.options({ exit: 0 }))

    // Both hand commits, oldest first; the declaration commit is the boundary
    // and is never among them.
    expect(outcome.byHand).toEqual([plain, edited])
    expect(outcome.byHand).not.toContain(declaration)
    expect(
      records(outcome)
        .filter((record) => record.kind === "by-hand")
        .map((record) => record.commit),
    ).toEqual([plain, edited])
    expect(messages(w).map((message) => message.recipient)).toEqual(["@cto", "@cto"])
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
    let facts = await readFacts(w.git, "task/two", second)
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "checked"])
    expect(facts[1]?.trailers).toEqual(expect.arrayContaining([["Config", "config-A"]]))

    // The target's declaration changed: the on-submit checks run again under B
    // before the change lands, and the new checked fact names B.
    const next = await queueRun({ ...w.options({ exit: 0 }), configBlob: "config-B" })
    expect(next.merged).toEqual(["task/two"])
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/changes/*:refs/yrd/changes/*"])
    facts = await readFacts(w.git, "task/two", second)
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

    // The check fails everywhere, so the attribution builds the target's own
    // worktree to ask whether the target is red — a third worktree, prepared
    // like the other two.
    const outcome = await queueRun(w.options({ everywhere: true, exit: 1, setup: w.setupCommand(0) }))

    expect(outcome.exitCode).toBe(2)
    expect(outcome.stuck).toEqual(["task/one"])
    const order = whereRan(w)
    const prepared = order.filter(([what]) => what === "setup").map(([, where]) => where)
    expect(prepared).toHaveLength(3)
    expect(new Set(prepared).size).toBe(3)
    everyCheckWasPrepared(order)
    expect(
      records(outcome)
        .filter((record) => record.kind === "result" && record.name === "setup")
        .map((record) => record.phase),
    ).toEqual(["submit", "merge", "target"])
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
    const facts = await readFacts(w.git, "task/one", head)
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "stuck", "sent"])
    expect(facts[1]?.trailers).toEqual(expect.arrayContaining([["Reason", "setup"]]))
    expect(facts[1]?.trailers.filter(([name]) => name === "Fault")).toEqual([])
    // The check never ran: there was no prepared tree to run it in.
    expect(whereRan(w).filter(([what]) => what === "check")).toEqual([])
    expect(messages(w)[0]).toMatchObject({ code: "setup", kind: "yrd-broken", recipient: "@cto" })
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
    const facts = await readFacts(w.git, "task/one", head)
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "stuck", "sent"])
    expect(facts[1]?.trailers).toEqual(expect.arrayContaining([["Reason", "setup"]]))
    expect(records(outcome).filter((record) => record.kind === "result" && record.name === "setup")).toMatchObject([
      { exit: "missing", result: "stuck", whose: "queue" },
    ])
  })
})

/**
 * § Attribution — "a failing check is the submitter's only if it failed both
 * times in the change's worktree and did not fail at the target on the same
 * check; otherwise the change ends stuck, the queue's." That reading is the
 * whole of it on BOTH paths: the on-submit path wrote failed the moment a
 * check failed, so a defect of the environment was sent back to an author who
 * could not have caused it.
 */
describe("an on-submit check is attributed before anyone is billed for it", () => {
  it("fails in the change's worktree and passes at the target: the submitter's", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    // The check fails only where the change's own file is, so it fails twice
    // in the change's worktree and passes at the target.
    const outcome = await queueRun(w.options({ exit: 1, on: ["submit"] }))

    expect(outcome.exitCode).toBe(1)
    expect(outcome.failed).toEqual(["task/one"])
    expect(outcome.stuck).toEqual([])
    expect(await remoteTarget(w)).toBe(w.target)
    await fetchChanges(w)
    const facts = await readFacts(w.git, "task/one", head)
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "failed", "sent"])
    expect(facts[1]?.trailers).toEqual(
      expect.arrayContaining([
        ["Reason", "verify"],
        ["Fault", "submitter"],
      ]),
    )
    expect(messages(w)[0]).toMatchObject({
      code: "verify",
      disposition: "author",
      kind: "send-back",
      recipient: "@dev/2",
    })
    // Three runs of the one check, and only because it failed: twice in the
    // change's worktree, once at the target.
    const ran = whereRan(w).map(([, where]) => where)
    expect(ran).toHaveLength(3)
    expect(ran[0]).toBe(ran[1])
    expect(ran[2]).not.toBe(ran[0])
  })

  it("fails at the target too: the queue's, so the change is stuck and nobody is billed", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(w.options({ everywhere: true, exit: 1, on: ["submit"] }))

    // Stuck, not failed: the target is red, and the change is not what broke it.
    expect(outcome.exitCode).toBe(2)
    expect(outcome.stuck).toEqual(["task/one"])
    expect(outcome.failed).toEqual([])
    expect(await remoteTarget(w)).toBe(w.target)
    await fetchChanges(w)
    const facts = await readFacts(w.git, "task/one", head)
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "stuck", "sent"])
    // `Reason` is the attribution's own word, the same one the merge path
    // writes; which check produced it is in the subject and in the `Check:`
    // trailers, so a reader of the fact alone still has the name.
    expect(facts[1]?.trailers).toEqual(expect.arrayContaining([["Reason", "inherited"]]))
    expect(facts[1]?.trailers.filter(([name]) => name === "Fault")).toEqual([])
    expect(facts[1]?.subject).toContain("verify")
    expect(facts[1]?.trailers.filter(([name]) => name === "Check").map(([, value]) => value)).toEqual([
      expect.stringMatching(/^verify exit=1 /u),
    ])
    expect(messages(w)[0]).toMatchObject({ kind: "yrd-broken", recipient: "@cto" })
    expect(messages(w)[0]?.text).toMatch(/the target is red, not the change/u)
  })

  it("a passing on-submit check is run once and attributes nothing", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(w.options({ exit: 0, on: ["submit"] }))

    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/one"])
    await fetchChanges(w)
    expect((await readFacts(w.git, "task/one", head)).map((fact) => fact.kind)).toEqual([
      "opened",
      "checked",
      "merged",
      "sent",
    ])
    // The cost stays honest: the second run and the target run are for a
    // FAILING check only.
    expect(whereRan(w)).toHaveLength(1)
  })
})

/**
 * A check that selects work by what changed needs to be told what it is
 * judging and what to measure it against, and the queue is the only thing
 * that knows: `YRD_REPO`, `YRD_CANDIDATE_SHA`, `YRD_BASE_SHA`, built into
 * every check's environment and read once per worktree.
 */
describe("what the queue tells a check about the tree it judges", () => {
  it("at submit: the change's head, and the merge base with the target, not the target itself", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    // The target moves after the branch was cut, so the fork point and the
    // target are different commits and a check that confused them would show.
    const hand = await pushByHand(w, "hand.txt")

    const outcome = await queueRun(w.options({ exit: 0, on: ["submit"] }))

    expect(outcome.exitCode).toBe(0)
    const [submitCheck] = ranPrograms(w).filter((ran) => ran.program === "check")
    expect(submitCheck?.candidate).toBe(head)
    expect(submitCheck?.base).toBe(w.target)
    expect(submitCheck?.base).not.toBe(hand)
    // `YRD_REPO` is the worktree the check ran in, which is its own directory.
    expect(submitCheck?.repo).toBe(submitCheck?.cwd)
    // The base is an ancestor of the candidate, which is what a diff needs.
    await expect(
      w.git(["merge-base", "--is-ancestor", submitCheck?.base ?? "", submitCheck?.candidate ?? ""]),
    ).resolves.toBeDefined()
  })

  it("at merge: the merge commit, with the target as its base", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(w.options({ exit: 0, on: ["merge"] }))

    expect(outcome.merged).toEqual(["task/one"])
    const mergeCommit = await remoteTarget(w)
    const [mergeCheck] = ranPrograms(w).filter((ran) => ran.program === "check")
    // The merge commit is what lands, so it is what the on-merge checks judge.
    expect(mergeCheck?.candidate).toBe(mergeCommit)
    expect(mergeCheck?.base).toBe(w.target)
    expect(mergeCheck?.repo).toBe(mergeCheck?.cwd)
  })

  it("the setup is told the same three, in the worktree it is preparing", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(w.options({ exit: 0, on: ["submit"], setup: w.setupCommand(0) }))

    expect(outcome.exitCode).toBe(0)
    const [setup, check] = ranPrograms(w)
    expect(setup?.program).toBe("setup")
    expect(setup?.candidate).toBe(head)
    expect(setup?.base).toBe(w.target)
    expect(setup?.repo).toBe(setup?.cwd)
    // The same tree, so the same three: read once, not once per program.
    expect([check?.candidate, check?.base, check?.repo]).toEqual([setup?.candidate, setup?.base, setup?.repo])
  })

  it("at the target, during attribution: the target itself, as its own base", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(w.options({ everywhere: true, exit: 1, on: ["submit"] }))

    expect(outcome.stuck).toEqual(["task/one"])
    // Three check runs: twice in the change's worktree, then once at the target.
    const runs = ranPrograms(w).filter((ran) => ran.program === "check")
    expect(runs).toHaveLength(3)
    expect(runs[2]?.candidate).toBe(w.target)
    expect(runs[2]?.base).toBe(w.target)
    expect(runs[2]?.repo).toBe(runs[2]?.cwd)
    expect(runs[2]?.cwd).not.toBe(runs[0]?.cwd)
  })
})

describe("a check log is keyed by its change, then the run", () => {
  it("a run that checks two changes keeps both logs", async () => {
    const w = await world()
    const firstHead = await submitCommit(w, "task/one", "one.txt")
    const secondHead = await submitCommit(w, "task/two", "two.txt")

    // Both changes are queued, so this one run's on-submit loop judges both
    // (run.ts: `for (const entry of ordered(entries, "queued", ...))`), each
    // with the same phase and the same run id — the exact collision the log
    // path must not make.
    const outcome = await queueRun({
      ...w.options({ exit: 0 }),
      checks: [{ name: "verify", on: ["submit"], run: 'echo "candidate=$YRD_CANDIDATE_SHA"' }],
    })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/one"])
    const oneLog = checkLogFor(outcome, "task/one", "submit", "verify")
    const twoLog = checkLogFor(outcome, "task/two", "submit", "verify")
    // Distinct paths: the change is in the path, not just the run and the phase.
    expect(oneLog).not.toBe(twoLog)
    expect(oneLog).toContain(changeName("task/one", firstHead))
    expect(twoLog).toContain(changeName("task/two", secondHead))
    // Each log still holds its own check's output: neither write clobbered the other.
    expect(readFileSync(oneLog, "utf8")).toContain(`candidate=${firstHead}`)
    expect(readFileSync(twoLog, "utf8")).toContain(`candidate=${secondHead}`)
  })
})
