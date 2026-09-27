/**
 * @failure  The service (`yrd queue up`) reads the target's declaration once,
 *           at start, and runs every later round on that reading: an edit at
 *           the target — a check added, a key mistyped, the switch removed —
 *           takes effect only after a restart, and a correct edit looks
 *           like a wrong one until then. And when the change it merges is the
 *           one that moves its own gitlink, it keeps running the old code against
 *           a target that records the new one: the relaunch onto the new gitlink is a
 *           person's job again (plan § Commands: the service's three exits;
 *           § Milestones M7).
 * @level    l2 (a real remote and a clone under a temporary root;
 *           `coreQueueCommand` driven directly, no process boundary)
 * @consumer hab, which runs `yrd queue up` as the service and relaunches it on
 *           a gitlink-move exit · the mechanic, who edits the target's declaration and
 *           expects the next round to read it
 */

import * as fs from "node:fs"
import { execFileSync } from "node:child_process"
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { afterAll, describe, expect, it, vi } from "vitest"
import { tryAcquireFlock } from "@bearly/flock"
import * as gitomic from "gitomic"
import { openEvents } from "gitomic/events"
import {
  appendChangeEvent,
  changeInput,
  createEventQueue,
  createEventStore,
  changesRef,
  gitIn,
  parseQueueHealthDocument,
  queueRef,
  QUEUE_HEALTH_DOCUMENT,
  readConfig,
  readEventQueue,
  readEventOps,
  readRemoteCommit,
  readRunLog,
  readStatus,
  ROUND_LOCK,
  runId,
  runIndexRef,
  setBranchIgnored,
  submit,
  trailer,
  watchRows,
  writeQueueEvent,
  writeQueueOverride,
  type Git,
  type QueueHealthDocument,
  type QueueRunOutcome,
  type GitRunner,
} from "@yrd/queue-core"
import { createLogger, type ConditionalLogger, type Event } from "loggily"
import { runYrdProcess } from "../src/cli.ts"
import { coreQueueCommand, endingCode } from "../src/queue-core-commands.ts"
import { changesSuffix } from "../src/watch-list.tsx"
import { readQueueHealth, SERVICE } from "../src/queue-health.ts"
import { readRunnerFacts } from "../src/watch-runner.ts"
import { resolveQueueLocation } from "../src/queue-location.ts"
import type { YrdCliExitCode, YrdCliIO } from "../src/types.ts"
import { installSelectedGit } from "./support/selected-git.ts"

// A mutable facade, so a test can catch each health document at the rename
// that publishes it. Every call passes through to the real filesystem.
vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()) }))

// A submodule at a local path: git refuses file transport for submodule clones
// unless every git in the chain is told. Every git runner below and the
// queue's own git children read this process's environment when they are
// made, so it is said here, first.
process.env.GIT_CONFIG_COUNT = "1"
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow"
process.env.GIT_CONFIG_VALUE_0 = "always"

const roots: string[] = []

// A selected event change must keep the watch open through every working phase.
describe("event watch selector endings", () => {
  it("waits through working phases and reports each ending", () => {
    for (const phase of ["queued", "verifying", "checking", "merging"] as const) {
      expect(endingCode([phase])).toBeUndefined()
    }
    expect(endingCode(["merged"])).toBe(0)
    expect(endingCode(["failed"])).toBe(1)
    expect(endingCode(["cancelled"])).toBe(1)
    expect(endingCode(["stuck"])).toBe(2)
    expect(endingCode(["merged", "checking"])).toBeUndefined()
  })
})
// Resolve the queue's declared dependency; the CLI need not install a second copy.
const queueCoreEntry = Bun.resolveSync("@yrd/queue-core", import.meta.dirname)
const gitSuperBin = resolve(Bun.resolveSync("git-super", dirname(queueCoreEntry)), "../../bin")

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

type Capture = Readonly<{ io: YrdCliIO; stdout(): string; stderr(): string }>

function capture(cwd: string): Capture {
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

/** The JSON records the command wrote, one per line. */
function records(run: Capture): readonly Record<string, unknown>[] {
  return run
    .stdout()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** A logger that keeps every row it is handed, so a test can read what the service said and at what level. */
function logRows(): Readonly<{
  log: ConditionalLogger
  rows: readonly Readonly<{ level: string; message: string }>[]
}> {
  const rows: Readonly<{ level: string; message: string }>[] = []
  const log = createLogger("test", [
    { level: "info" },
    {
      write: (entry: Event) => {
        if (entry.kind === "log") rows.push({ level: entry.level, message: entry.message })
      },
    },
  ])
  return { log, rows }
}

const DECLARATION = "{}\n"

/**
 * How many 0.05 s turns a fixture shell waits to be released before it gives up
 * and exits: 120 s, above this file's longest test timeout (60 s). A fixture
 * that waits without a bound outlives the run whenever the test dies before
 * releasing it, and that leak is what km-infra's test-fixture-process-leaks
 * guard reads; a bound under the timeout would cut a legitimate wait short
 * instead.
 */
const FIXTURE_WAIT_TURNS = 2400

/** The lines of a fixture's bounded wait: turn until `test` stops holding, then give up loudly. */
function waitingFor(test: string, why: string): readonly string[] {
  return [
    "turns=0",
    `while ${test}; do`,
    "  turns=$((turns + 1))",
    `  if [ "$turns" -gt ${String(FIXTURE_WAIT_TURNS)} ]; then`,
    `    echo "${why}" >&2`,
    "    exit 1",
    "  fi",
    "  sleep 0.05",
    "done",
  ]
}

async function identity(git: Git): Promise<void> {
  await git(["config", "user.email", "queue@yrd.test"])
  await git(["config", "user.name", "yrd"])
}

type World = Readonly<{
  git: Git
  /** The clone the service runs in, on `main`. */
  work: string
  /** Where the queue writes; under the world, so nothing lands elsewhere. */
  workdir: string
}>

/** A bare remote whose `main` declares the queue, and a clone of it. */
async function world(eventQueue = true): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-up-"))
  roots.push(root)
  const seed = gitIn(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await identity(git)
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, ".yrd.yml"), DECLARATION)
  await git(["add", ".yrd.yml"])
  await git(["commit", "--quiet", "-m", "main declares the queue"])
  await git(["push", "--quiet", "origin", "main"])
  if (eventQueue) {
    const target = (await git(["rev-parse", "HEAD"])).trim()
    const config = await readConfig(git, target, { branch: "main", remote: "origin" })
    if (config === undefined) throw new Error("the fixture target lost its declaration")
    await createEventQueue(createEventStore(work, "origin", git.selection), "main", target, config, new Date())
  }
  const workdir = join(root, "queue")
  mkdirSync(workdir, { recursive: true })
  return { git, work, workdir }
}

/** The target's declaration taken away at the remote: a queue that is no longer there. */
async function undeclare(w: World): Promise<void> {
  await w.git(["rm", "--quiet", ".yrd.yml"])
  await w.git(["commit", "--quiet", "-m", "the queue's declaration, taken away"])
  await w.git(["push", "--quiet", "origin", "main"])
}

/** The target's declaration replaced with `text` at the remote: a mechanic's edit, as the service sees it. */
async function redeclare(w: World, text: string): Promise<void> {
  writeFileSync(join(w.work, ".yrd.yml"), text)
  await w.git(["commit", "--quiet", "-am", "the target's declaration, edited"])
  await w.git(["push", "--quiet", "origin", "main"])
}

type GitlinkWorld = World &
  Readonly<{
    /** The submodule's commit the root records at start. */
    a: string
    /** The submodule's next commit, on its main; the root does not record it yet. */
    b: string
    /** The real CLI loaded from this world's submodule, not an injected gitlink. */
    command: typeof coreQueueCommand
  }>

/**
 * A submodule whose main is `a` then `b`; a root whose main records the submodule
 * at `a`. Modelled on the queue core's own gitlink case: `b` is on the
 * submodule's main, so candidate settling accepts a change that records it.
 */
async function gitlinkWorld(sourceReadFailure = false, eventQueue = true): Promise<GitlinkWorld> {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-up-gitlink-"))
  roots.push(root)
  // Ownership comes from hosted identities; Git transports these fixture URLs locally.
  process.env.GIT_CONFIG_COUNT = "3"
  process.env.GIT_CONFIG_KEY_1 = `url.${join(root, "submodule.git")}.insteadOf`
  process.env.GIT_CONFIG_VALUE_1 = "https://git-super.test/owned/submodule.git"
  process.env.GIT_CONFIG_KEY_2 = `url.${join(root, "remote.git")}.insteadOf`
  process.env.GIT_CONFIG_VALUE_2 = "https://git-super.test/owned/root.git"
  const seed = gitIn(root)

  const submodule = join(root, "submodule.git")
  const submoduleWork = join(root, "submodule-work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", submodule])
  await seed(["clone", "--quiet", submodule, submoduleWork])
  const cg = gitIn(submoduleWork)
  await identity(cg)
  await cg(["remote", "set-url", "origin", "https://git-super.test/owned/submodule.git"])
  await cg(["checkout", "--quiet", "-b", "main"])
  cpSync(resolve(import.meta.dirname, "../src"), join(submoduleWork, "packages/yrd-cli/src"), { recursive: true })
  writeFileSync(join(submoduleWork, "lib.txt"), "a\n")
  await cg(["add", "lib.txt", "packages"])
  await cg(["commit", "--quiet", "-m", "a"])
  const a = (await cg(["rev-parse", "HEAD"])).trim()
  await cg(["push", "--quiet", "origin", "main"])

  const remote = join(root, "remote.git")
  const work = join(root, "work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await identity(git)
  await git(["remote", "set-url", "origin", "https://git-super.test/owned/root.git"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, ".yrd.yml"), DECLARATION)
  // The root records the submodule at its main as it stands now: `a`.
  await git(["submodule", "add", "--quiet", "https://git-super.test/owned/submodule.git", "submodule"])
  await git(["add", ".yrd.yml", ".gitmodules", "submodule"])
  await git(["commit", "--quiet", "-m", "main, with the submodule at a"])
  await git(["push", "--quiet", "origin", "main"])
  if (eventQueue) {
    const target = (await git(["rev-parse", "HEAD"])).trim()
    const config = await readConfig(git, target, { branch: "main", remote: "origin" })
    if (config === undefined) throw new Error("the gitlink fixture target lost its declaration")
    await createEventQueue(createEventStore(work, "origin", git.selection), "main", target, config, new Date())
  }

  // The submodule's main moves on to `b`; the root still records `a`.
  writeFileSync(join(submoduleWork, "lib.txt"), "b\n")
  await cg(["commit", "--quiet", "-am", "b"])
  const b = (await cg(["rev-parse", "HEAD"])).trim()
  await cg(["push", "--quiet", "origin", "main"])

  const workdir = join(root, "queue")
  mkdirSync(workdir, { recursive: true })
  const cli = join(work, "submodule/packages/yrd-cli")
  symlinkSync(resolve(import.meta.dirname, "../node_modules"), join(cli, "node_modules"), "dir")
  if (sourceReadFailure) {
    // Leave real source files readable but make HEAD unborn: rev-parse must
    // fail, not turn an embedded service into an unchecked standalone one.
    await gitIn(join(work, "submodule"))(["symbolic-ref", "HEAD", "refs/heads/unborn-runtime"])
  }
  const { coreQueueCommand: command } = await import(join(cli, "src/queue-core-commands.ts"))
  return { a, b, command, git, work, workdir }
}

/** A change that moves the submodule's gitlink to `sha`, submitted to the queue. */
async function submitGitlink(w: GitlinkWorld, branch: string, sha: string): Promise<void> {
  await w.git(["checkout", "--quiet", "-b", branch, "main"])
  const sub = gitIn(join(w.work, "submodule"))
  await sub(["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"])
  await sub(["checkout", "--quiet", sha])
  await w.git(["add", "submodule"])
  await w.git(["commit", "--quiet", "-m", `move the submodule gitlink to ${sha.slice(0, 12)}`])
  await w.git(["checkout", "--quiet", "main"])
  await submit(w.git, "origin", { branch, submitter: "@dev/2", target: { branch: "main", remote: "origin" } })
}

const STUCK = { exitCode: 2, failed: [], merged: [], stuck: [] }

describe("yrd queue up, the service", () => {
  /**
   * @failure A carrier needing the runs index exits terminally when the older queue has events but no runs ref.
   * @level l2 (real Git remote and the service loop)
   * @consumer Hab's Yrd service and @chief, who activates the index after the carrier lands
   */
  it("waits on a missing remote runs index, then runs after activation without relaunch (26229)", async () => {
    const w = await world()
    const eventsRef = queueRef("main")
    const indexRef = runIndexRef("main")
    await w.git(["push", "--quiet", "origin", `:${indexRef}`])
    expect(await w.git(["ls-remote", "--refs", "origin", eventsRef])).toContain(eventsRef)
    expect(await w.git(["ls-remote", "--refs", "origin", indexRef])).toBe("")
    const run = capture(w.work)
    const stop = new AbortController()
    let rounds = 0
    let settled = false
    const service = coreQueueCommand(
      w.work,
      run.io,
      {
        command: "up",
        intervalSeconds: 0,
        stop: stop.signal,
        heartbeatIntervalMs: 100,
        heartbeatGraceMs: 500,
        afterRound: () => {
          rounds += 1
          stop.abort()
        },
      },
      { json: true, workdir: w.workdir },
    ).finally(() => {
      settled = true
    })
    try {
      await vi.waitFor(
        async () => {
          const health = await readQueueHealth(w.workdir, SERVICE)
          expect(health, run.stderr()).toMatchObject({
            state: "unhealthy",
            verdict: { kind: "running" },
            error: { code: "queue-remote-precondition-missing", cause: expect.stringContaining(indexRef) },
          })
          expect(health.error?.resolution.join(" ")).toContain("yrd runs activate")
          expect(health.error?.resolution.join(" ")).toContain("@chief")
        },
        { timeout: 5_000 },
      )
      expect(settled, run.stderr()).toBe(false)
      expect(rounds).toBe(0)
      const logs = join(w.workdir, "logs")
      expect(existsSync(logs) ? readdirSync(logs) : []).toEqual([])
      await delay(700)
      expect((await readQueueHealth(w.workdir, SERVICE)).error?.code).toBe("queue-remote-precondition-missing")

      // A transport failure is unknown, not evidence that the index is still
      // absent. Exercise the same remote read while its fixture remote is down.
      const remote = join(dirname(w.work), "remote.git")
      const offline = `${remote}.offline`
      renameSync(remote, offline)
      try {
        await vi.waitFor(
          async () => {
            const health = await readQueueHealth(w.workdir, SERVICE)
            expect(health.facts?.roundReadFailure).toMatchObject({ ref: indexRef, count: expect.any(Number) })
            expect(health.error?.code).not.toBe("queue-remote-precondition-missing")
          },
          { timeout: 5_000 },
        )
      } finally {
        renameSync(offline, remote)
      }
      expect(rounds).toBe(0)
      // Exercise the operator's exact step, not a direct call to its core.
      const address = "yrd-precondition.test/org/queue@main"
      const previous = { global: process.env.GIT_CONFIG_GLOBAL, state: process.env.XDG_STATE_HOME }
      const global = join(dirname(w.work), "gitconfig")
      writeFileSync(global, `[url "file://${remote}"]\n\tinsteadOf = https://yrd-precondition.test/org/queue.git\n`)
      process.env.GIT_CONFIG_GLOBAL = global
      process.env.XDG_STATE_HOME = join(dirname(w.work), "state")
      try {
        const activated = capture(w.work)
        expect(
          await runYrdProcess([process.execPath, "/usr/local/bin/yrd", "runs", "activate", address], activated.io),
          activated.stderr(),
        ).toBe(0)
        expect(activated.stdout()).toContain(indexRef)
      } finally {
        if (previous.global === undefined) delete process.env.GIT_CONFIG_GLOBAL
        else process.env.GIT_CONFIG_GLOBAL = previous.global
        if (previous.state === undefined) delete process.env.XDG_STATE_HOME
        else process.env.XDG_STATE_HOME = previous.state
      }
      expect(await service, run.stderr()).toBe(0)
      expect(rounds).toBe(1)
      expect(await w.git(["ls-remote", "--refs", "origin", indexRef])).toContain(indexRef)
      expect((await readQueueHealth(w.workdir, SERVICE)).state).toBe("healthy")
    } finally {
      stop.abort()
      await service.catch(() => undefined)
    }
  }, 20_000)

  /** @failure A pause published while an event round judges a change is reported as stuck; Hab does not relaunch exit 2.
   * @level l2 @consumer Hab's yrd service and its health reader
   */
  it("holds an event queue paused while judging without ending the service (25920)", async () => {
    const w = await world(false)
    const pauseCheck = join(w.workdir, "pause-during-check.ts")
    writeFileSync(
      pauseCheck,
      `import { createEventStore, gitIn, readEventQueue, writeQueueEvent } from ${JSON.stringify(queueCoreEntry)}\n` +
        `const git = gitIn(${JSON.stringify(w.work)})\n` +
        `const store = createEventStore(${JSON.stringify(w.work)}, "origin", git.selection)\n` +
        `if ((await readEventQueue(store, "main")).ops?.pause === undefined) {\n` +
        `  await writeQueueEvent(store, "main", { type: "paused", at: new Date(), by: "@chief", reason: "maintenance" })\n` +
        `}\n`,
    )
    await redeclare(w, `checks:\n  - gate:\n      on: [submit]\n      run: bun ${pauseCheck}\n`)
    const commit = (await w.git(["rev-parse", "main"])).trim()
    const config = await readConfig(w.git, commit, { branch: "main", remote: "origin" })
    if (config === undefined) throw new Error("the fixture's target lost its declaration")
    await createEventQueue(
      createEventStore(w.work, "origin", gitIn(w.work).selection),
      "main",
      commit,
      config,
      new Date(),
    )
    await w.git(["checkout", "--quiet", "-b", "task/pause-during-check", "main"])
    writeFileSync(join(w.work, "change.txt"), "change\n")
    await w.git(["add", "change.txt"])
    await w.git(["commit", "--quiet", "-m", "change"])
    await w.git(["checkout", "--quiet", "main"])
    await submit(w.git, "origin", {
      branch: "task/pause-during-check",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })

    const stop = new AbortController()
    const run = capture(w.work)
    let roundCount = 0
    const exit = await coreQueueCommand(
      w.work,
      run.io,
      {
        command: "up",
        intervalSeconds: 0,
        stop: stop.signal,
        afterRound: async () => {
          roundCount += 1
          if (roundCount === 2) stop.abort()
        },
      },
      { workdir: w.workdir, json: true },
    )
    expect(exit, JSON.stringify({ stderr: run.stderr(), stdout: run.stdout(), roundCount })).toBe(0)
    expect(roundCount).toBe(2)
    const pause = (await readEventQueue(createEventStore(w.work, "origin", gitIn(w.work).selection), "main")).ops?.pause
    if (pause === undefined) throw new Error("the fixture's pause was not published")
    expect(pause).toMatchObject({ by: "@chief", kind: "paused" })
    expect(records(run)).toHaveLength(2)
    expect(readRunLog(join(w.workdir, "logs"), String(records(run)[0]?.run))).toContainEqual(
      expect.objectContaining({ kind: "pause", by: "@chief", reason: "maintenance", sha: pause.sha }),
    )
    for (const round of records(run)) {
      expect(round).toMatchObject({
        exitCode: 0,
        merged: [],
        stuck: [],
        stopped: { ring: "pause", what: { by: "@chief" } },
      })
    }
    expect(await readQueueHealth(w.workdir, SERVICE)).toMatchObject({ facts: { stopped: { by: "@chief" } } })
  })

  // 24472: legacy branch-name inference must be visible in both submit modes;
  // the domain reader tests cannot prove the CLI tells its caller.
  it.each([true, false])("reports legacy issue fallback during submit (dryRun=%s)", async (dryRun) => {
    const w = await world()
    const branch = "task/24472-legacy"
    await w.git(["checkout", "--quiet", "-b", branch])
    await w.git(["commit", "--quiet", "--allow-empty", "-m", "legacy work without a binding"])
    const run = capture(w.work)
    expect(
      await coreQueueCommand(
        w.work,
        run.io,
        { branch, command: "submit", dryRun, submitter: "@dev/2" },
        { workdir: w.workdir, json: true },
      ),
    ).toBe(0)
    expect(run.stderr()).toContain(`legacy branch-name fallback: ${branch} -> 24472`)
    expect(records(run)[0]).toMatchObject({ issue: "24472", issueSource: "legacy-branch" })
    if (!dryRun) {
      expect(run.stderr()).toMatch(/seam\.declaration\.fetch=1/u)
      expect(run.stderr()).toMatch(/seam\.inspectSubmit\.fetch=[1-9]/u)
      expect(run.stderr()).toMatch(/seam\.submitEvent\.(?:fetch|ls-remote)=/u)
      expect(run.stderr()).not.toContain("seam.unattributed.")
      expect(run.stderr()).not.toContain("seam.submit.setup.")
    }
  })

  // THE OPERATOR'S CONDITION (2026-09-16): submits are accepted while the line
  // is stopped, echoing who stopped it, why, and what lifts it. This case used
  // to assert the refusal; its subject — what a pause does to a submit, said
  // where the submitter reads it — is unchanged.
  it("pause is visible, submit is accepted with the pause echoed, and resume lets the queue take it", async () => {
    const w = await world()
    await w.git(["checkout", "--quiet", "-b", "task/one", "main"])
    writeFileSync(join(w.work, "one.txt"), "one\n")
    await w.git(["add", "one.txt"])
    await w.git(["commit", "--quiet", "-m", "one"])
    const head = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])

    const opened = capture(w.work)
    expect(
      await coreQueueCommand(
        w.work,
        opened.io,
        { by: "@chief", command: "pause", reason: "49 new failures on main" },
        { json: true, workdir: w.workdir },
      ),
    ).toBe(0)
    expect(records(opened)[0]).toMatchObject({
      by: "@chief",
      cause: "operator",
      kind: "paused",
      reason: "49 new failures on main",
    })

    const duplicatePause = capture(w.work)
    expect(
      await coreQueueCommand(
        w.work,
        duplicatePause.io,
        { by: "operator", command: "pause", reason: "replace the active pause" },
        { workdir: w.workdir },
      ),
    ).toBe(1)
    expect(duplicatePause.stderr()).toContain("paused by @chief")
    expect(duplicatePause.stderr()).toContain("49 new failures on main")

    for (const dryRun of [true, false]) {
      const accepted = capture(w.work)
      expect(
        await coreQueueCommand(
          w.work,
          accepted.io,
          { branch: "task/one", command: "submit", dryRun, submitter: "@dev/2" },
          { workdir: w.workdir },
        ),
        accepted.stderr(),
      ).toBe(0)
      expect(accepted.stderr()).toContain("paused by @chief")
      expect(accepted.stderr()).toContain("49 new failures on main")
      expect(accepted.stderr()).toContain("yrd queue resume")
    }
    const ref = changesRef("main", "task/one")
    expect(await w.git(["ls-remote", "--refs", "origin", ref])).toContain(ref)

    const listed = capture(w.work)
    expect(await coreQueueCommand(w.work, listed.io, { command: "list" }, { workdir: w.workdir })).toBe(0)
    // The pause is the loudest state on the page and it LEADS it, once; the
    // runner's row says the WORD paused and what lifts the stop, never the
    // record's own sentence a second time (watch-frame.tsx).
    const page = listed.stdout().split("\n")
    expect(page.filter((line) => line.includes("paused by @chief"))).toHaveLength(1)
    expect(page.findIndex((line) => line.includes("paused by @chief"))).toBeLessThan(
      page.findIndex((line) => line.includes("RUNNER")),
    )
    // There is no run journal and no health document in this workdir, and the
    // row still says `paused`: a stop record is a GIT fact and reads from any
    // clone, so it outranks every host-only rung. `?` here would hide the one
    // thing an operator most needs to see behind "I am not on that machine".
    // The row says the WORD and the cure; the record's own sentence is the loud
    // line above and is said exactly once.
    // Boxed RUNNER puts `╭─ RUNNER` on its own title line; the status row
    // inside still names the WORD and the cure (24196).
    const runnerBoxStart = page.findIndex((line) => line.includes("RUNNER"))
    const runnerBoxEnd = page.findIndex((line, i) => i > runnerBoxStart && line.includes("╰"))
    const runnerBox = page.slice(runnerBoxStart, runnerBoxEnd + 1).join("\n")
    expect(runnerBox, listed.stdout()).toContain("paused")
    expect(runnerBox, listed.stdout()).toContain("resume: yrd queue resume")
    expect(runnerBox, listed.stdout()).not.toContain("refs/yrd/main/runner")
    const listedJson = capture(w.work)
    expect(await coreQueueCommand(w.work, listedJson.io, { command: "list" }, { json: true, workdir: w.workdir })).toBe(
      0,
    )
    const pausedList = records(listedJson)[0]
    expect(pausedList).toMatchObject({
      changes: [{ branch: "task/one" }],
      pause: { by: "@chief", kind: "paused", reason: "49 new failures on main" },
    })

    const closed = capture(w.work)
    expect(
      await coreQueueCommand(
        w.work,
        closed.io,
        { by: "@chief", command: "resume", reason: "repair merged" },
        { workdir: w.workdir },
      ),
    ).toBe(0)
    const listedResumed = capture(w.work)
    expect(
      await coreQueueCommand(w.work, listedResumed.io, { command: "list" }, { json: true, workdir: w.workdir }),
    ).toBe(0)
    const resumedList = records(listedResumed)[0]
    expect(resumedList).toMatchObject({ changes: [{ branch: "task/one" }], pause: null })
    expect(resumedList?.changes).toEqual(pausedList?.changes)

    // A retry on a paused line is accepted too, without changing the selected event.
    const beforeRetry = await w.git(["ls-remote", "--refs", "origin", ref])
    expect(
      await coreQueueCommand(
        w.work,
        capture(w.work).io,
        { by: "@chief", command: "pause", reason: "retry arrives while paused" },
        { workdir: w.workdir },
      ),
    ).toBe(0)
    const retried = capture(w.work)
    expect(
      await coreQueueCommand(
        w.work,
        retried.io,
        { branch: "task/one", command: "submit", submitter: "@dev/2" },
        { workdir: w.workdir },
      ),
    ).toBe(0)
    expect(retried.stderr()).toContain("retry arrives while paused")
    expect(await w.git(["ls-remote", "--refs", "origin", ref])).toBe(beforeRetry)
    // The budget of the service case above: accepted submits push where refused
    // ones did not, and under a loaded host this case measured 4-6 s, at the
    // 5 s default.
  }, 15_000)

  // Accepted: a legacy protected declaration and its absent successor cannot
  // open a submission; malformed LOCAL hints still diagnose and reach a valid
  // protected queue. Existing service rereads and parser-only tests miss this
  // command admission boundary and its no-write guarantee.
  it.each(["legacy protected declaration", "absent protected successor", "valid queue with malformed local hints"])(
    "protected declaration governs submission: %s",
    async (scenario) => {
      const w = await world()
      const valid = scenario === "valid queue with malformed local hints"
      // Gitomic's captured 14-byte declaration, unchanged from its old blob.
      const legacy = "landing: none\n"
      if (!valid) await redeclare(w, legacy)
      if (scenario === "absent protected successor") await undeclare(w)

      // Descend from the current target so freshness cannot explain refusal.
      const branch = "task/declaration"
      await w.git(["checkout", "--quiet", "-b", branch, "main"])
      writeFileSync(join(w.work, ".yrd.yml"), valid ? "target: origin#main\nchecks: [{\n" : legacy)
      writeFileSync(join(w.work, "change.txt"), "candidate\n")
      await w.git(["add", ".yrd.yml", "change.txt"])
      await w.git(["commit", "--quiet", "-m", "candidate declaration"])
      const head = (await w.git(["rev-parse", "HEAD"])).trim()
      const beforeRemote = await w.git(["ls-remote", "--refs", "origin"])
      const beforeLocal = await w.git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/yrd/main/"])
      const run = capture(w.work)
      const attempt = coreQueueCommand(
        w.work,
        run.io,
        { branch, command: "submit", submitter: "@dev/3" },
        { json: true, workdir: w.workdir },
      )

      if (valid) {
        await expect(attempt).resolves.toBe(0)
        // The one stderr line a clean submit writes is its remote-call count (25570 row 3): the queue read, the
        // event push and every fetch, from git's own trace2 log, with no torn line.
        expect(run.stderr()).toMatch(
          /^yrd: submit remote calls: processes=\d+ ssh_children=0 remote_ms=\d+ unreadable=0 (?=.*\bpush=1\b)[^\n]*\n$/u,
        )
        expect(records(run)[0]).toMatchObject({ head })
        const ref = changesRef("main", branch)
        const history = await (
          await openEvents({ ...createEventStore(w.work, "origin", gitIn(w.work).selection), ref })
        ).events()
        expect(history.map((event) => event.type)).toEqual(["opened"])
        expect(history[0]?.props.some(([key]) => key === "Target")).toBe(false)
        expect(await w.git(["ls-remote", "--refs", "origin", ref])).toContain(ref)
      } else {
        if (scenario === "legacy protected declaration") {
          await expect(attempt).rejects.toThrow(/\.yrd\.yml: unknown key landing/u)
        } else {
          await expect(attempt).resolves.toBe(2)
          expect(run.stderr()).toContain("submit needs a queue")
          expect(run.stderr()).toContain("origin/main carries no .yrd.yml")
          // Names the cure: re-address with --queue, or recognize a submodule
          // with no declaration of its own is gated by its superproject instead.
          expect(run.stderr()).toContain("--queue <repo>#<branch>")
          expect(run.stderr()).toContain("superproject")
        }
        expect(records(run)).toEqual([])
        expect(await w.git(["ls-remote", "--refs", "origin"])).toBe(beforeRemote)
        expect(await w.git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/yrd/main/"])).toBe(beforeLocal)
      }
    },
  )

  it("refuses a target that moves mid-read, then judges under the next declaration", async () => {
    const w = await world()
    const checkLog = join(w.workdir, "fixed-target-checks.log")
    const checkA = join(w.workdir, "check-a.sh")
    const checkB = join(w.workdir, "check-b.sh")
    writeFileSync(checkA, `#!/bin/sh\nprintf 'A:%s\\n' "$YRD_BASE_SHA" >> "${checkLog}"\n`)
    writeFileSync(checkB, `#!/bin/sh\nprintf 'B:%s\\n' "$YRD_BASE_SHA" >> "${checkLog}"\n`)
    chmodSync(checkA, 0o755)
    chmodSync(checkB, 0o755)
    await redeclare(w, `checks:\n  - fixed:\n      run: ${checkA}\n      on: submit\n`)
    const a = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "-b", "task/one", a])
    writeFileSync(join(w.work, "one.txt"), "one\n")
    await w.git(["add", "one.txt"])
    await w.git(["commit", "--quiet", "-m", "one"])
    await w.git(["checkout", "--quiet", "main"])
    await submit(w.git, "origin", {
      branch: "task/one",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })

    // B exists at the remote but is not main yet. The upload-pack wrapper
    // advances main after the round's declaration A is captured and fetched,
    // immediately before the queue's broad advertisement. A round reads its
    // declaration once it holds the round lock, so what the service reads
    // before that — its start-up declaration and stop — is not counted.
    writeFileSync(join(w.work, ".yrd.yml"), `checks:\n  - fixed:\n      run: ${checkB}\n      on: submit\n`)
    await w.git(["commit", "--quiet", "-am", "declaration B"])
    const b = (await w.git(["rev-parse", "HEAD"])).trim()
    const configB = (await w.git(["rev-parse", `${b}:.yrd.yml`])).trim()
    await w.git(["push", "--quiet", "origin", `${b}:refs/testing/target-b`])
    const wrapper = join(w.workdir, "upload-pack-target-race.sh")
    const calls = join(w.workdir, "upload-pack-target-race.count")
    const moved = join(w.workdir, "upload-pack-target-race.moved")
    writeFileSync(
      wrapper,
      [
        "#!/bin/sh",
        `test -e "${join(w.workdir, ROUND_LOCK)}" || exec git-upload-pack "$@"`,
        // yrd runs some ls-remotes concurrently, so the count is one appended line per invocation (an append is
        // atomic; a read-then-rewrite counter can read a truncated file and fire twice), and the move is one-shot:
        // a noclobber create (O_EXCL) succeeds for exactly one invocation. Not mkdir: this host's uutils mkdir let
        // several concurrent callers win (@dev/review2 8035e6b3, 47be3aaf44 verdict).
        `printf 'x\\n' >> "${calls}"`,
        `count=$(wc -l < "${calls}")`,
        // An exact fetch may be skipped when A is already local. Invocation
        // two is therefore either that fetch or the queue advertisement; in
        // both cases A has already been declared and B precedes the queue read.
        `if test "$count" -ge 2 && (set -C; : > "${moved}") 2>/dev/null; then git --git-dir="$1" update-ref refs/heads/main ${b} ${a} || exit $?; fi`,
        'exec git-upload-pack "$@"',
        "",
      ].join("\n"),
    )
    chmodSync(wrapper, 0o755)
    await w.git(["config", "remote.origin.uploadpack", wrapper])

    const run = capture(w.work)
    const exit = await coreQueueCommand(w.work, run.io, { command: "run" }, { json: true, workdir: w.workdir })
    expect(exit, run.stdout()).toBe(2)
    expect(
      readFileSync(calls, "utf8")
        .split("\n")
        .filter((line) => line !== "").length,
    ).toBeGreaterThanOrEqual(2)
    expect(records(run)).toEqual([{ ...STUCK, why: expect.stringContaining("target moved") as string }])
    expect(existsSync(checkLog)).toBe(false)

    await w.git(["fetch", "--quiet", "origin", "main"])
    await w.git(["merge", "--quiet", "--ff-only", "origin/main"])
    const retry = capture(w.work)
    expect(await coreQueueCommand(w.work, retry.io, { command: "run" }, { json: true, workdir: w.workdir })).toBe(0)
    expect(records(retry)[0]).toMatchObject({ base: b, config: configB, exitCode: 0, merged: ["task/one"] })
    expect(readFileSync(checkLog, "utf8")).toBe(`B:${b}\n`)
  })

  it("ends stuck when the target no longer carries a declaration at all", async () => {
    const w = await world()
    const run = capture(w.work)
    let rounds = 0

    const exit = await coreQueueCommand(
      w.work,
      run.io,
      {
        afterRound: async () => {
          rounds += 1
          if (rounds === 1) await undeclare(w)
        },
        command: "up",
        intervalSeconds: 0,
      },
      { json: true, workdir: w.workdir },
    )

    expect(exit, run.stdout()).toBe(2)
    expect(rounds).toBe(1)
    expect(records(run)[1]).toEqual({ ...STUCK, why: "origin/main no longer carries a .yrd.yml" })
  })

  it("ends the loop, exit 0, when the round it ran merged the change that moves its own gitlink", async () => {
    const w = await gitlinkWorld()
    await submitGitlink(w, "task/gitlink", w.b)
    await gitIn(join(w.work, "submodule"))(["checkout", "--quiet", w.a])
    const run = capture(w.work)

    const exit = await w.command(
      w.work,
      run.io,
      {
        command: "up",
        intervalSeconds: 0,
        afterRound: async () => {
          await w.git(["merge", "--ff-only", "origin/main"])
          await gitIn(join(w.work, "submodule"))(["checkout", "--quiet", w.b])
        },
      },
      { json: true, workdir: w.workdir },
    )

    // Zero, not 18: Hab relaunches after allowlisted exits 0 and 1, and a gitlink
    // advance is the one thing the service is MEANT to end for. Exit 2 and process
    // signals stay terminal.
    const written = records(run)
    const logPath = written[0]?.log
    const runLog = typeof logPath === "string" ? readFileSync(logPath, "utf8") : "No queue log was reported"
    expect(exit, `${run.stdout()}\n${run.stderr()}\n${runLog}`).toBe(0)
    expect(written).toHaveLength(2)
    expect(written[0]).toMatchObject({ exitCode: 0, merged: ["task/gitlink"] })
    expect(written[1]).toEqual({ exitCode: 0, from: w.a, gitlink: "submodule", reason: "gitlink-moved", to: w.b })
    // The target really moved the gitlink: the exit reports the world, not the request.
    expect((await w.git(["ls-tree", "origin/main", "--", "submodule"])).trim()).toBe(`160000 commit ${w.b}\tsubmodule`)
  })

  /**
   * @failure  THE PRODUCTION CONFIGURATION, and no test had it. Every gitlink
   *           test above runs the queue from the SAME checkout the runtime
   *           lives in — which is what the pre-M8 deployment looked like. M8
   *           moved the queue into its own clone, the old identification asked
   *           whether the runtime sits inside the QUEUE checkout, the answer
   *           became "no" permanently, and the relaunch exit was silently off
   *           in production for a month (@i/10-yrd/24515). The change that
   *           broke it touched neither the function nor any test of it, because
   *           no test described the shape it broke.
   * @level    l2 (two clones of one root, the real CLI, a real gitlink move)
   * @consumer every seat whose landed yrd change is not actually running
   */
  it("exits 0 on a gitlink move when the QUEUE runs from a different clone than the runtime", async () => {
    const w = await gitlinkWorld()
    await submitGitlink(w, "task/gitlink-elsewhere", w.b)
    await gitIn(join(w.work, "submodule"))(["checkout", "--quiet", w.a])

    // THE WHOLE POINT: the queue works from its own clone of the same root,
    // while the runtime keeps living in `w.work/submodule`. Superproject and
    // queue checkout are now two different directories, as in production.
    // Beside the world, NOT inside the queue workdir: the run owns that
    // directory and scans it for its own worktrees and journals.
    const queueClone = join(dirname(w.work), "queue-clone")
    await gitIn(dirname(w.work))(["clone", "--quiet", w.work, queueClone])
    await identity(gitIn(queueClone))
    await gitIn(queueClone)(["remote", "set-url", "origin", "https://git-super.test/owned/root.git"])
    await gitIn(queueClone)(["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"])
    // The queue borrows submodule objects from its own checkout, so that
    // checkout must carry a store for every gitlink. The refusal names this
    // exact command when it is missing, which is how this line was written.
    await gitIn(queueClone)(["submodule", "update", "--init", "--", "submodule"])

    const run = capture(queueClone)
    const stop = new AbortController()
    let rounds = 0
    const exit = await w.command(
      queueClone,
      run.io,
      {
        command: "up",
        intervalSeconds: 0,
        stop: stop.signal,
        // Every round, stuck ones included — a stuck round no longer ends the
        // loop, so without this the test hangs instead of reporting.
        afterHealth: () => {
          rounds += 1
          if (rounds >= 4) stop.abort()
        },
        afterRound: async () => {
          // The runtime's OWN superproject projects the move — which is the
          // tree this process would re-exec out of, and the one the wait must
          // follow. The queue clone advancing says nothing about it.
          await w.git(["fetch", "--quiet", "origin", "main"])
          await w.git(["merge", "--quiet", "--ff-only", "origin/main"])
          await gitIn(join(w.work, "submodule"))(["checkout", "--quiet", w.b])
        },
      },
      { json: true, workdir: w.workdir },
    )

    // EXIT 0, the allowlisted ending: hab relaunches, and the new pin runs. The
    // old identification returned undefined here and the loop ran on forever.
    const written = records(run)
    // The hang guard, and it is the failure this bead is about: with the exit
    // disarmed the loop runs forever and nothing says why. Four rounds means
    // the gitlink move was never seen.
    expect(rounds, `the loop never exited on the gitlink move; ${run.stdout()}\n${run.stderr()}`).toBeLessThan(4)
    expect(exit, `${run.stdout()}\n${run.stderr()}`).toBe(0)
    expect(written.at(-1)).toEqual({ exitCode: 0, from: w.a, gitlink: "submodule", reason: "gitlink-moved", to: w.b })
    // And the exit was never announced as disarmed.
    expect(run.stderr()).not.toContain("the relaunch exit is off")
  })

  // @cto's row, on @i/10-yrd/24515: the wait above used to have no time limit.
  // It never ran in production until the relaunch exit was repaired; now it
  // runs on every vendor/yrd move, and a shared checkout that is detached,
  // drifted or simply not coming would park the delivery service forever with
  // nothing said. The trade — no rounds rather than stale code — is right. The
  // silence was not.
  // @cto's row, on @i/10-yrd/24515: the wait above used to have no time limit.
  // It never ran in production until the relaunch exit was repaired; now it runs
  // on every vendor/yrd move, and a shared checkout that is detached, drifted or
  // simply not coming would park the delivery service forever with nothing said.
  //
  // THE CAP IS AN ALARM, NOT AN ENDING, and the first cut of this test asserted
  // the opposite. Ending on exit 2 would leave the service DOWN (exit 2 is not
  // in relaunchExitCodes) having just written unhealthy+running — the exact pair
  // hab's pre-spawn gate refuses, which is the deadlock measured at 15:31Z on
  // 2026-09-11 and broken only by deleting the document by hand.
  it("pages while it waits for a checkout that never comes, then relaunches when it lands", async () => {
    const w = await gitlinkWorld()
    // The target records b. The runtime's own checkout is left at a and NOBODY
    // projects it: the stalled-updater world, not a lagging one.
    await w.git(["update-index", "--cacheinfo", "160000", w.b, "submodule"])
    await w.git(["commit", "--quiet", "-m", "target records b, checkout does not follow"])
    await w.git(["push", "--quiet", "origin", "main"])
    const run = capture(w.work)
    const stop = new AbortController()
    let rounds = 0

    const service = w.command(
      w.work,
      run.io,
      {
        command: "up",
        intervalSeconds: 0,
        stop: stop.signal,
        // Fifty milliseconds stands in for ten minutes. What is under test is
        // that the wait ALARMS and keeps waiting, which does not depend on it.
        relaunchWaitCapMs: 50,
        afterRound: () => {
          rounds += 1
          stop.abort()
        },
      },
      { json: true, workdir: w.workdir },
    )

    try {
      // THE PAGE, while the process is still alive. `running` is true and must
      // be: it is what makes this a page rather than a tombstone, and what lets
      // habd respawn later without meeting the admission gate.
      // The poll is on a one-second tick, so a 50ms cap still alarms on the NEXT
      // pass, not instantly. Default waitFor gives up at 1000ms and lands in the
      // race; the cap under test is the alarm, never the tick.
      await vi.waitFor(() => expect(run.stdout()).toContain("relaunch-wait-stalled"), { timeout: 8000 })
      const paged = JSON.parse(readFileSync(join(w.workdir, "service-health.json"), "utf8")) as {
        state: string
        verdict: { kind: string }
        error?: { code?: string; cause?: string; resolution?: string[] }
        facts?: Record<string, unknown>
      }
      expect(paged.state).toBe("unhealthy")
      expect(paged.verdict.kind).toBe("running")
      // ITS OWN CODE. A stall is not a stuck round, and borrowing that code
      // brings prose about rounds with it.
      expect(paged.error?.code).toBe("queue-relaunch-stalled")
      // The STABLE key travels as a field and the prose as the cause — separate,
      // so a ladder counting stalls cannot be reset by wording that embeds a
      // moving sha.
      expect(paged.facts?.reasonKey).toBe("relaunch-wait:submodule")
      // And it names the checkout, not merely the fact of waiting: "stuck" that
      // does not say WHICH of the three is behind sends a reader to all three.
      expect(paged.error?.cause).toContain(join(w.work, "submodule"))

      // THE FACTS FROM THE START OF THE WAIT SURVIVE INTO THE PAGE. The first
      // cut of this rebuilt the document and destroyed them, which quietly
      // undid the reason they are written at all: `believableHealthDocument`
      // merges `facts`, so an overdue answer explains itself only if they are
      // still there.
      expect(paged.facts?.waitingForCheckout).toBe("submodule")
      expect(paged.facts?.waitingCheckout).toBe(join(w.work, "submodule"))
      expect(paged.facts?.waitingTarget).toBe(w.b)

      // AND THE ROUND PROSE IS GONE. Three lines of the stuck-round branch are
      // false here — read the round's record, the loop will run the next round
      // by itself, the next runs in N ms — and an operator following a
      // resolution line is how the evening of 2026-09-11 was lost.
      const resolution = (paged.error?.resolution ?? []).join(" ")
      expect(resolution).not.toContain("yrd queue list")
      expect(resolution).not.toContain("next round")
      // It names the checkout to make, exactly.
      expect(resolution).toContain(`Check out submodule@${w.b} in ${join(w.work, "submodule")}`)
      expect(resolution).toContain("No restart, and nothing to delete")
      // AND IT DOES NOT OVER-PROMISE. The page does not clear when the checkout
      // lands — the process exits 0 then and THIS document stays on disk until
      // the relaunched service writes its own, which it does as it starts
      // (24523 F1). I had written the easier, wrong version of that line and
      // @cto caught it.
      expect(resolution).toContain("clears when the relaunched service starts and writes its own document")
      // No prefix: a reader grepping the stuck-round code must not land here.
      expect(paged.error?.cause).not.toContain("yrd-round-stuck")
      expect(paged.facts).not.toHaveProperty("nextRoundInMs")
      // And it has not run a round on the stale code while waiting.
      expect(rounds).toBe(0)

      // THE CURE THE DOCUMENT NAMES, applied: the checkout lands.
      const sub = gitIn(join(w.work, "submodule"))
      await sub(["fetch", "--quiet", "origin", "main"])
      await sub(["checkout", "--quiet", w.b])

      // Exit 0 — the relaunch ending. No `hab up`, no deleting a file.
      expect(await service, `${run.stdout()}\n${run.stderr()}`).toBe(0)
    } finally {
      stop.abort()
      await service.catch(() => undefined)
    }
    expect(rounds).toBe(0)
    expect(records(run).at(-1)).toEqual({
      exitCode: 0,
      from: w.a,
      gitlink: "submodule",
      reason: "gitlink-moved",
      to: w.b,
    })
  })

  it.each(["stop", "project", "already projected"])("runs no stale round during checkout lag (%s)", async (ending) => {
    const w = await gitlinkWorld()
    // T1 includes the submodule checkout poll. Watching only queue outcomes
    // left its separate gitIn call free to lose the executable and environment.
    const selected = await installSelectedGit(w.work)
    // The recorded target moves first; the process still loads a from its checkout.
    await w.git(["update-index", "--cacheinfo", "160000", w.b, "submodule"])
    await w.git(["commit", "--quiet", "-m", "target records b before local projection"])
    await w.git(["push", "--quiet", "origin", "main"])
    const run = capture(w.work)
    const stop = new AbortController()
    const { log, rows } = logRows()
    let rounds = 0
    const project = async () => {
      const sub = gitIn(join(w.work, "submodule"))
      await sub(["fetch", "--quiet", "origin", "main"])
      await sub(["checkout", "--quiet", w.b])
    }
    // The module is already imported at a. Moving disk HEAD before up must not
    // re-label its cached code as b.
    if (ending === "already projected") await project()
    const service = w.command(
      w.work,
      run.io,
      {
        command: "up",
        intervalSeconds: 0,
        stop: stop.signal,
        afterRound: () => {
          rounds += 1
          stop.abort()
        },
      },
      {
        env: { ...process.env, YRD_SELECTED_TEST_MARKER: "reload-poll" },
        json: true,
        log,
        workdir: w.workdir,
      },
    )
    try {
      if (ending !== "already projected") {
        await vi.waitFor(() => expect(run.stdout()).toContain("waiting for checkout"), { timeout: 20_000 })
        expect(rounds).toBe(0)
        if (ending === "stop") stop.abort()
        else await project()
      }
      expect(await service).toBe(0)
    } finally {
      stop.abort()
      await service
    }
    expect(rounds).toBe(0)
    const checkoutReads = selected
      .readCalls()
      .filter(
        (call) => call.cwd === join(w.work, "submodule") && call.args.join(" ") === "rev-parse --verify HEAD^{commit}",
      )
    expect(checkoutReads.length).toBeGreaterThan(0)
    expect(checkoutReads.every((call) => call.marker === "reload-poll")).toBe(true)
    expect(rows.some((row) => row.message.startsWith("the gitlink exit is off"))).toBe(false)
    expect(run.stdout()).toContain(w.a)
    expect(run.stdout()).toContain(w.b)
    if (ending !== "stop") {
      expect(records(run).at(-1)).toEqual({
        exitCode: 0,
        from: w.a,
        gitlink: "submodule",
        reason: "gitlink-moved",
        to: w.b,
      })
    }
  })

  it("refuses an embedded runtime whose source identity could not be read", async () => {
    const w = await gitlinkWorld(true)
    const run = capture(w.work)
    const stop = new AbortController()
    let rounds = 0
    await expect(
      w.command(
        w.work,
        run.io,
        {
          command: "up",
          stop: stop.signal,
          afterRound: () => {
            rounds += 1
            stop.abort()
          },
        },
        { json: true, workdir: w.workdir },
      ),
    ).rejects.toThrow("cannot identify embedded runtime")
    expect(rounds).toBe(0)
  })

  /**
   * CHANGED BY @i/10-yrd/24515, and the change is the bead. This asserted that
   * the exit is off because the runtime is not inside the QUEUE checkout —
   * which is the predicate that had been silently disarming the relaunch in
   * production for a month. It is no longer the question.
   *
   * The runtime is now identified by its own superproject, so in this world the
   * exit is off for an honest reason instead: the temporary target records no
   * gitlink at the path this runtime occupies. Same outcome, different
   * question, and the reason is one a person can act on.
   */
  it("a runtime whose target records no gitlink runs normally and says so LOUDLY", async () => {
    const w = await world()
    const run = capture(w.work)
    const stop = new AbortController()
    const { log, rows } = logRows()

    const exit = await coreQueueCommand(
      w.work,
      run.io,
      { afterRound: () => stop.abort(), command: "up", intervalSeconds: 0, stop: stop.signal },
      { json: true, log, workdir: w.workdir },
    )

    expect(exit, run.stdout()).toBe(0)
    expect(records(run)).toHaveLength(1)
    // WARN, NOT INFO. The old line was an INFO that @cto could not find in
    // hab's session files at all, which is how a capability that had switched
    // itself off went a month without anyone noticing.
    const off = rows.filter((row) => row.message.startsWith("the relaunch exit is off"))
    expect(off, JSON.stringify(rows)).toHaveLength(1)
    expect(off[0]?.level).toBe("warn")
    // Inside hh a superproject records this runtime, so the captured target is what lacks the gitlink; a
    // standalone clone has no superproject at all, and the line says that instead.
    const yrdRoot = resolve(import.meta.dirname, "../../..")
    const superproject = execFileSync("git", ["-C", yrdRoot, "rev-parse", "--show-superproject-working-tree"], {
      encoding: "utf8",
    }).trim()
    expect(off[0]?.message).toContain(superproject === "" ? "no superproject records" : "records no gitlink")
    // And it reaches stderr too, so a person watching the service sees it
    // without a log level set.
    expect(run.stderr()).toContain("the relaunch exit is off")
  })
})

describe("yrd queue list, the table", () => {
  it("a commit the target gained around the queue is a row of its own, in the JSON and on the line (E5)", async () => {
    const w = await world()
    // The queue's history starts at its first record, so there is one change
    // before the direct merge: a queue that has judged nothing has no history
    // and reports nothing (direct.ts).
    await w.git(["checkout", "--quiet", "-b", "task/first", "main"])
    writeFileSync(join(w.work, "first.txt"), "first\n")
    await w.git(["add", "first.txt"])
    await w.git(["commit", "--quiet", "-m", "task/first"])
    await w.git(["checkout", "--quiet", "main"])
    await submit(w.git, "origin", {
      branch: "task/first",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })
    // The target moves around the queue: one commit after that, pushed.
    writeFileSync(join(w.work, "direct.txt"), "direct\n")
    await w.git(["add", "direct.txt"])
    await w.git(["commit", "--quiet", "-m", "direct.txt around the queue"])
    await w.git(["push", "--quiet", "origin", "main"])
    const direct = (await w.git(["rev-parse", "HEAD"])).trim()
    const sentence = `main moved around the queue at ${direct.slice(0, 12)} (direct.txt around the queue)`

    const asJson = capture(w.work)
    expect(await coreQueueCommand(w.work, asJson.io, { command: "list" }, { json: true, workdir: w.workdir })).toBe(0)
    const listed = records(asJson)[0] as Readonly<{ changes: readonly Record<string, unknown>[] }>
    expect(listed.changes).toMatchObject([
      { branch: "task/first", state: "queued" },
      { branch: "main", head: direct, reason: sentence, state: "direct" },
    ])

    const asText = capture(w.work)
    expect(await coreQueueCommand(w.work, asText.io, { command: "list" }, { workdir: w.workdir })).toBe(0)
    // On the page: its own row — the direct glyph and word in STATUS, TASK
    // leading with the commit's subject then the target branch (ia.md);
    // the sentence is the JSON's `reason`, above.
    const directLine = asText
      .stdout()
      .split("\n")
      .find((line) => line.includes("→ direct"))
    expect(directLine, asText.stdout()).toBeDefined()
    expect(directLine).toContain("direct.txt around the queue")
    expect(directLine).toMatch(/\bmain\b/u)
  })
})

/**
 * `queue run`, `queue up` and `queue list` on one stuck fixture (@i/10-yrd/24141).
 *
 * `run` used to forward `queueRun`'s exit code without ever naming what a
 * stuck round could not do about it; `up` and `list` already carried the same
 * information (the ladder for the first, the incident for the second). One
 * fixture, three commands, and every one of them must agree: the branch is
 * `task/stuck`, its state is `stuck`, and its cure is the same sentence
 * wherever it is read.
 */
/**
 * A setup that fails for as long as a fault marker exists.
 *
 * Deliberately NOT "fails the first N times": a round runs setup more than
 * once — a candidate's failure is re-run on the settled base to decide whose
 * failure it is — so a counting fixture encodes an implementation detail and
 * silently stops reproducing the fault when that detail changes. The fault is
 * a CONDITION here, exactly as a code host being unreachable is, and the test
 * clears the condition at the moment it wants to.
 */
/**
 * A setup that fails while its marker exists with a line that is NOT a
 * transport signature, so the queue reads a broken repository rather than an
 * outage: stuck, and never retried. Every run is counted, so a case can say
 * how many judgements the queue made.
 */
function brokenSetup(dir: string): Readonly<{ command: string; clear: () => void; runs: () => number }> {
  const marker = join(dir, "setup-broken")
  const counter = join(dir, "setup-runs.log")
  const script = join(dir, "broken-setup.sh")
  writeFileSync(marker, "the lockfile does not match\n")
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `echo "$(pwd)" >> ${counter}`,
      `if [ -f ${marker} ]; then`,
      "  echo 'error: lockfile had changes, but lockfile is frozen' >&2",
      "  exit 1",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  )
  chmodSync(script, 0o755)
  return {
    command: script,
    clear: () => rmSync(marker, { force: true }),
    runs: () => {
      try {
        return readFileSync(counter, "utf8").split("\n").filter(Boolean).length
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0
        throw error
      }
    },
  }
}

function faultySetup(dir: string): Readonly<{ command: string; clear: () => void }> {
  const marker = join(dir, "code-host-unreachable")
  const script = join(dir, "faulty-setup.sh")
  writeFileSync(marker, "the code host is down\n")
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `if [ -f ${marker} ]; then`,
      "  echo 'fatal: unable to access https://example.invalid/: The requested URL returned error: 504' >&2",
      "  exit 128",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  )
  chmodSync(script, 0o755)
  return { command: script, clear: () => rmSync(marker, { force: true }) }
}

describe("yrd queue show names the queue it read (@i/10-yrd/24050)", () => {
  it("an empty answer says which queue at which remote was read, on the page and in --json", async () => {
    const w = await world()
    await w.git(["checkout", "--quiet", "-b", "task/one", "main"])
    writeFileSync(join(w.work, "one.txt"), "one\n")
    await w.git(["add", "one.txt"])
    await w.git(["commit", "--quiet", "-m", "one"])
    await w.git(["checkout", "--quiet", "main"])
    await submit(w.git, "origin", {
      branch: "task/one",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })

    const page = capture(w.work)
    expect(
      await coreQueueCommand(w.work, page.io, { command: "show", branch: "task/ghost" }, { workdir: w.workdir }),
    ).toBe(0)
    const json = capture(w.work)
    expect(
      await coreQueueCommand(
        w.work,
        json.io,
        { command: "show", branch: "task/ghost" },
        { json: true, workdir: w.workdir },
      ),
    ).toBe(0)

    const shown = records(json)[0] as { queue?: unknown; changes: unknown[] }
    expect(shown.changes).toEqual([])
    expect(typeof shown.queue).toBe("string")
    expect(String(shown.queue)).toContain("main")
    // The same identity on the page as in the JSON, beside the branch it did not find.
    expect(`${page.stdout()}${page.stderr()}`).toContain(`no change for task/ghost on ${String(shown.queue)}`)

    // A found change carries the same top-level identity, so a reader never
    // has to look inside a row to learn what was queried.
    const found = capture(w.work)
    expect(
      await coreQueueCommand(
        w.work,
        found.io,
        { command: "show", branch: "task/one" },
        { json: true, workdir: w.workdir },
      ),
    ).toBe(0)
    expect((records(found)[0] as { queue?: unknown }).queue).toBe(shown.queue)
  })
})

describe("yrd queue run, up and list agree on a stuck change (@i/10-yrd/24141)", () => {
  it("26175: names the same branch and cure whichever of the three commands reports it", async () => {
    const w = await world()
    // A setup that cannot reach its remote: it sticks the same way on every
    // judgement, retried once inside the round and then written, and that is
    // the ground the three commands must agree on. (This fixture once avoided an
    // unresolved check because a guard retired the second one; the andon removed
    // that guard, and the fixture keeps the fault whose cure text is literal.)
    const fault = faultySetup(w.workdir)
    await redeclare(w, `setup: ${fault.command}\n`)
    await w.git(["checkout", "--quiet", "-b", "task/stuck", "main"])
    writeFileSync(join(w.work, "stuck.txt"), "stuck\n")
    await w.git(["add", "stuck.txt"])
    await w.git(["commit", "--quiet", "-m", "stuck"])
    await w.git(["checkout", "--quiet", "main"])
    await submit(w.git, "origin", {
      branch: "task/stuck",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })
    // setup-transport.ts's own literal, reproduced rather than imported: a
    // change here that silently drifts from its wording is exactly the
    // disagreement this test exists to catch.
    const cure = "nothing here is the change's fault: setup could not reach a remote"

    // AC1 + AC2: `run` takes the change, cannot get past it, ends 2, and
    // names the branch and the cure on stderr.
    const ranRun = capture(w.work)
    expect(await coreQueueCommand(w.work, ranRun.io, { command: "run" }, { workdir: w.workdir })).toBe(2)
    expect(ranRun.stderr()).toContain("stuck task/stuck:")
    expect(ranRun.stderr()).toContain(cure)

    // AC3: `up`, pointed at the same still-stuck change, names the same branch
    // and the same cure.
    //
    // It does so without judging it again: `run` stopped the line (the andon,
    // operator 2026-09-16), so every `up` round HOLDS the stop, and the branch
    // and the cure arrive on the stop's own line and on the page. This block
    // once asserted exit 2, then (@i/10-yrd/24395) a backoff ladder climbing
    // across stuck rounds; both were the step-over written down. 24141's
    // subject — the three commands agreeing on the branch and the cure — is
    // what is asserted here.
    const ranUp = capture(w.work)
    const stop = new AbortController()
    const documents: QueueHealthDocument[] = []
    expect(
      await coreQueueCommand(
        w.work,
        ranUp.io,
        {
          command: "up",
          intervalSeconds: 0,
          stop: stop.signal,
          afterHealth: (document) => {
            documents.push(document)
            // Two rounds, so the second proves the first did not end the loop.
            if (documents.length === 2) stop.abort()
          },
        },
        { workdir: w.workdir },
      ),
    ).toBe(0)
    expect(ranUp.stderr()).toContain("task/stuck")
    expect(ranUp.stderr()).toContain(cure)
    expect(documents.map((document) => document.state)).toEqual(["unhealthy", "unhealthy"])
    expect(documents[0]?.error?.cause).toContain("task/stuck")
    expect(documents[0]?.error?.resolution.join("\n")).toContain(cure)
    expect(documents[0]?.verdict).toEqual({ kind: "running" })
    // And the same document is on disk where the declared probe reads it.
    expect(await readQueueHealth(w.workdir, SERVICE)).toEqual(documents[1])

    // AC3: `list` already named this branch and this cure before `run` and
    // `up` did (this file's "renders one stored lossless incident" case); the
    // same fixture must show the identical code and cure through `list` too.
    const listed = capture(w.work)
    expect(await coreQueueCommand(w.work, listed.io, { command: "list" }, { json: true, workdir: w.workdir })).toBe(0)
    const rows = (records(listed)[0] as { changes: readonly Record<string, unknown>[] }).changes
    const row = rows.find((entry) => entry.branch === "task/stuck")
    expect(row, JSON.stringify(rows)).toMatchObject({ state: "stuck", reason: "yrd-setup-unreachable" })
    expect(String(row?.result)).toContain(cure)
  })
})

/**
 * @failure  A stuck change is stepped over by the service: the loop re-runs the
 *           fault on a backoff ladder, the page promises to clear itself when a
 *           round comes back clear, and a fault that clears by itself resumes
 *           the line with nobody having looked. The operator's ruling
 *           (2026-09-16) is the andon: STUCK means fail loud and fix — the line
 *           stops, the service stays up and pages, and only an act lifts it
 *           (@i/10-yrd/a-unattended/stuck-stops-the-line).
 * @level    l2 (a real remote and a clone under a temporary root; the loop driven
 *           directly, no process boundary)
 * @consumer the supervisor, which reads the declared health probe and pages on
 *           unhealthy-while-running without restarting · the seat that page wakes
 */
describe("a stuck change stops the line; the service stays up and pages (the andon, operator 2026-09-16)", () => {
  /** One change waiting in the line, so a round has something to merge. */
  async function oneChange(w: World, branch: string): Promise<string> {
    await w.git(["checkout", "--quiet", "-b", branch, "main"])
    writeFileSync(join(w.work, `${branch.replace("/", "-")}.txt`), "work\n")
    await w.git(["add", "-A"])
    await w.git(["commit", "--quiet", "-m", branch])
    const head = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])
    await submit(w.git, "origin", { branch, submitter: "@dev/4", target: { branch: "main", remote: "origin" } })
    return head
  }

  /** Catch the local clone up to a target the service has since advanced. */
  async function catchUp(w: World): Promise<void> {
    await w.git(["fetch", "--quiet", "origin", "main"])
    await w.git(["merge", "--quiet", "--ff-only", "origin/main"])
  }

  // ACCEPTANCE: one round judges the stuck change and stops the line; every
  // later round holds it — no setup runs again, nothing is judged or merged —
  // while the process stays alive and the page stays open with the cures.
  it("one round judges the stuck change, later rounds hold the line, and the page names the cures", async () => {
    const w = await world()
    const fault = brokenSetup(w.workdir)
    await redeclare(w, `setup: ${fault.command}\n`)
    const head = await oneChange(w, "task/stuck")

    const run = capture(w.work)
    const stop = new AbortController()
    const seen: QueueHealthDocument[] = []
    const exit = await coreQueueCommand(
      w.work,
      run.io,
      {
        command: "up",
        intervalSeconds: 0,
        stop: stop.signal,
        afterHealth: (document) => {
          seen.push(document)
          // Three rounds: the one that stuck, and two intervals of holding.
          if (seen.length === 3) stop.abort()
        },
      },
      { json: true, workdir: w.workdir },
    )

    // Exit 0: the loop was STOPPED by the test, never ended by the fault.
    expect(exit, run.stderr()).toBe(0)
    // ONE judgement: the candidate's setup and its settled base's, and nothing after.
    expect(fault.runs()).toBe(2)
    const rounds = records(run)
    expect(rounds).toHaveLength(3)
    expect(rounds[0]).toMatchObject({ exitCode: 2, merged: [], stuck: ["task/stuck"] })
    for (const later of rounds.slice(1)) {
      expect(later).toMatchObject({
        merged: [],
        stuck: [],
        stopped: { ring: "pause", what: { cause: "stuck", change: { branch: "task/stuck", head } } },
      })
    }
    // THE PAGE, every round, and never one that promises to clear by itself.
    expect(seen.map((document) => document.state)).toEqual(["unhealthy", "unhealthy", "unhealthy"])
    for (const document of seen) {
      expect(document.verdict).toEqual({ kind: "running" })
      expect(document.error?.code).toBe("queue-round-stuck")
      expect(document.error?.cause).toContain(`task/stuck@${head}`)
      const body = document.error?.resolution.join("\n") ?? ""
      expect(body).toContain("yrd queue withdraw task/stuck")
      expect(body).toContain("clears this reason")
      expect(body).toContain("yrd queue resume")
      expect(body).not.toMatch(/clears on its own|next round|resets the spacing/u)
      expect(document.facts).toMatchObject({ stopped: { by: "yrd", cause: "stuck", change: `task/stuck@${head}` } })
      expect(document.facts?.stuckRounds).toBeUndefined()
    }
    expect(await readQueueHealth(w.workdir, SERVICE)).toEqual(seen.at(-1))
  })

  /** @failure 25041: a process can die after writing the stuck change event and before writing its queue stop.
   * @level l2 @consumer Hab's yrd service and queue list
   */
  it("repairs a missing event stop on the first round after a stuck event", async () => {
    const w = await world(false)
    const target = (await w.git(["rev-parse", "main"])).trim()
    const config = await readConfig(w.git, target, { branch: "main", remote: "origin" })
    if (config === undefined) throw new Error("the fixture's target lost its declaration")
    const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
    await createEventQueue(store, "main", target, config, new Date())
    const branch = "task/crash-gap"
    const head = await oneChange(w, branch)
    const submitted = await readStatus(store, "main", branch)
    if (submitted.tip === undefined) throw new Error("the submitted change has no event tip")
    await appendChangeEvent(store, "main", branch, submitted.tip, {
      type: "stuck",
      at: new Date(),
      reason: "repair needed",
    })
    expect((await readEventOps(store, gitIn(w.work), "main", target)).stop).toBeUndefined()

    const first = capture(w.work)
    expect(await coreQueueCommand(w.work, first.io, { command: "run" }, { json: true, workdir: w.workdir })).toBe(2)
    const pause = (await readEventOps(store, gitIn(w.work), "main", target)).stop
    expect(pause).toMatchObject({ cause: "stuck", change: { branch, head }, reason: "repair needed" })
    const second = capture(w.work)
    expect(await coreQueueCommand(w.work, second.io, { command: "run" }, { json: true, workdir: w.workdir })).toBe(2)
    expect((await readEventOps(store, gitIn(w.work), "main", target)).stop?.sha).toBe(pause?.sha)
  })

  // NO TIMER EVER RESUMES A STOPPED LINE. The fault clears while the line is
  // stopped, and the line stays stopped; `yrd queue resume` is the act, the
  // page clears on it, and the change merges in the round after.
  it("a fault that clears does not resume the line by itself; resume does, and the next round merges", async () => {
    const w = await world()
    const fault = brokenSetup(w.workdir)
    await redeclare(w, `setup: ${fault.command}\n`)
    await oneChange(w, "task/after-the-fault")

    const run = capture(w.work)
    const stop = new AbortController()
    const seen: QueueHealthDocument[] = []
    const exit = await coreQueueCommand(
      w.work,
      run.io,
      {
        command: "up",
        intervalSeconds: 0,
        stop: stop.signal,
        afterHealth: async (document) => {
          seen.push(document)
          if (seen.length === 1) fault.clear()
          if (seen.length === 3) {
            const resumed = capture(w.work)
            expect(
              await coreQueueCommand(
                w.work,
                resumed.io,
                { by: "@chief", command: "resume", reason: "setup repaired" },
                { workdir: w.workdir },
              ),
            ).toBe(0)
          }
          if (document.state === "healthy") stop.abort()
        },
      },
      { json: true, workdir: w.workdir },
    )

    expect(exit, run.stderr()).toBe(0)
    const states = seen.map((document) => document.state)
    expect(states.slice(0, 3), JSON.stringify(states)).toEqual(["unhealthy", "unhealthy", "unhealthy"])
    expect(states.at(-1)).toBe("healthy")
    // The cleared fault ran nothing while the line was stopped.
    expect(fault.runs()).toBeGreaterThanOrEqual(2)
    const rounds = records(run)
    const merged = rounds.filter((row) => Array.isArray(row.merged) && (row.merged as unknown[]).length > 0)
    expect(merged, run.stdout()).toHaveLength(1)
    expect(merged[0]?.merged).toEqual(["task/after-the-fault"])
    // Only after the resume: the three rounds before it held the line.
    expect(rounds.indexOf(merged[0]!)).toBeGreaterThanOrEqual(3)
  })

  // @failure 25041: waiting for a moved checkout can hide a stuck change from the service health reader.
  it("keeps pending stuck changes in health while waiting for a checkout", async () => {
    const w = await gitlinkWorld(false, false)
    const target = (await w.git(["rev-parse", "main"])).trim()
    const config = await readConfig(w.git, target, { branch: "main", remote: "origin" })
    if (config === undefined) throw new Error("the fixture's target lost its declaration")
    const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
    await createEventQueue(store, "main", target, config, new Date())
    const branch = "task/stuck-before-checkout"
    await oneChange(w, branch)
    const submitted = await readStatus(store, "main", branch)
    if (submitted.tip === undefined) throw new Error("the submitted change has no event tip")
    await appendChangeEvent(store, "main", branch, submitted.tip, {
      type: "stuck",
      at: new Date(),
      reason: "repair needed",
    })
    await writeQueueEvent(store, "main", { type: "paused", at: new Date(), by: "@chief", reason: "repair" })
    const run = capture(w.work)
    const stop = new AbortController()
    let rounds = 0
    const service = w.command(
      w.work,
      run.io,
      {
        command: "up",
        intervalSeconds: 0,
        stop: stop.signal,
        afterHealth: async (document) => {
          rounds += 1
          if (rounds !== 1) return
          expect(document.facts?.stuckChanges).toEqual([branch])
          await w.git(["update-index", "--cacheinfo", "160000", w.b, "submodule"])
          await w.git(["commit", "--quiet", "-m", "target moves while the line is stuck"])
          await w.git(["push", "--quiet", "origin", "main"])
        },
      },
      { json: true, workdir: w.workdir },
    )
    try {
      await vi.waitFor(() => expect(run.stdout()).toContain("waiting for checkout"), { timeout: 20_000 })
      const waiting = JSON.parse(readFileSync(join(w.workdir, "service-health.json"), "utf8")) as QueueHealthDocument
      expect(rounds).toBe(1)
      expect(waiting.facts?.waitingForCheckout).toBe("submodule")
      expect(waiting.facts?.stuckChanges).toEqual([branch])
    } finally {
      stop.abort()
      await service
    }
  }, 60_000)

  /** @failure 25041: a stuck event change can have no legacy pause to resume.
   * @level l2 @consumer queue operator and Hab's yrd service
   */
  it("resumes a pre-cutover stuck event change without a legacy pause", async () => {
    const w = await world(false)
    const target = (await w.git(["rev-parse", "main"])).trim()
    const config = await readConfig(w.git, target, { branch: "main", remote: "origin" })
    if (config === undefined) throw new Error("the fixture's target lost its declaration")
    const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
    await createEventQueue(store, "main", target, config, new Date())
    const branch = "task/stuck-without-pause"
    await oneChange(w, branch)
    const submitted = await readStatus(store, "main", branch)
    if (submitted.tip === undefined) throw new Error("the submitted change has no event tip")
    await appendChangeEvent(store, "main", branch, submitted.tip, {
      type: "stuck",
      at: new Date(),
      reason: "repair needed",
    })
    expect((await readEventQueue(store, "main")).ops?.pause).toBeUndefined()

    const service = capture(w.work)
    const stop = new AbortController()
    const seen: QueueHealthDocument[] = []
    expect(
      await coreQueueCommand(
        w.work,
        service.io,
        {
          command: "up",
          intervalSeconds: 0,
          stop: stop.signal,
          afterHealth: (document) => {
            seen.push(document)
            stop.abort()
          },
        },
        { json: true, workdir: w.workdir },
      ),
      service.stderr(),
    ).toBe(0)
    expect(seen[0]?.error?.resolution.join(" ")).toContain("yrd queue resume")

    const resumed = capture(w.work)
    expect(
      await coreQueueCommand(
        w.work,
        resumed.io,
        { by: "@chief", command: "resume", reason: "repaired" },
        { workdir: w.workdir },
      ),
      resumed.stderr(),
    ).toBe(0)
    const releaseEvents = await (await openEvents({ ...store, ref: queueRef("main") })).events({ limit: 1024 })
    expect(releaseEvents.slice(-2).map((event) => event.type)).toEqual(["paused", "resumed"])
    const after = capture(w.work)
    expect(await coreQueueCommand(w.work, after.io, { command: "run" }, { json: true, workdir: w.workdir })).toBe(0)
    expect(records(after)[0]).toMatchObject({ exitCode: 0, merged: [branch] })
  }, 60_000)

  // @failure 25041: a resume needlessly scans every change history and refuses a sound named stop.
  it("resumes the named stuck change without scanning an unrelated unreadable history", async () => {
    const w = await world()
    const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
    const queueTip = (await readEventQueue(store, "main")).tip
    const branch = "task/readable-stuck"
    const head = await oneChange(w, branch)
    const submitted = await readStatus(store, "main", branch)
    if (submitted.tip === undefined) throw new Error("the submitted change has no event tip")
    const event = await appendChangeEvent(store, "main", branch, submitted.tip, {
      type: "stuck",
      at: new Date(),
      reason: "repair needed",
    })
    await writeQueueEvent(store, "main", {
      type: "paused",
      by: "yrd",
      cause: "stuck",
      change: { branch, head, event },
      reason: "repair needed",
      at: new Date(),
    })
    await (
      await openEvents({ ...store, ref: changesRef("main", "task/unreadable"), writer: "yrd" })
    ).append([changeInput("failed", { queueTip, at: new Date(), reason: "no opened event" })], { expect: null })
    const resumed = capture(w.work)
    expect(
      await coreQueueCommand(
        w.work,
        resumed.io,
        { by: "@chief", command: "resume", reason: "repaired" },
        { workdir: w.workdir },
      ),
      resumed.stderr(),
    ).toBe(0)
    expect(
      (await readEventOps(store, gitIn(w.work), "main", (await w.git(["rev-parse", "main"])).trim())).stop,
    ).toBeUndefined()
  }, 60_000)

  // What no round can fix still ends the service: a round that cannot even
  // read its queue has no change to stop the line on, so the loop has nothing
  // to hold and ends 2, which stays down and pages non-relaunchable.
  it("a round that cannot read its own queue ends the service with exit 2", async () => {
    const w = await world()
    const run = capture(w.work)
    const stop = new AbortController()
    let rounds = 0
    const exit = await coreQueueCommand(
      w.work,
      run.io,
      {
        command: "up",
        intervalSeconds: 0,
        stop: stop.signal,
        afterHealth: () => {
          rounds += 1
          // A stray hook in the queue-owned hooks path: every later round refuses to start.
          if (rounds === 1) {
            mkdirSync(join(w.workdir, "hooks-disabled"), { recursive: true })
            writeFileSync(join(w.workdir, "hooks-disabled", "pre-push"), "#!/bin/sh\n")
          }
          if (rounds === 3) stop.abort()
        },
      },
      { json: true, workdir: w.workdir },
    )
    expect(exit, run.stderr()).toBe(2)
    expect(rounds).toBe(1)
    expect(run.stdout()).toContain("hooks path")
  })

  // ACCEPTANCE (c), the NEGATIVE CONTROL. Exit 2 must survive for what no round
  // can fix. Without this, "the loop never exits" would be indistinguishable
  // from "the loop cannot exit", and a queue whose declaration is gone would
  // spin forever instead of paging non-relaunchable.
  it("still exits 2 when the target no longer carries a declaration", async () => {
    const w = await world()
    const run = capture(w.work)
    let rounds = 0
    const exit = await coreQueueCommand(
      w.work,
      run.io,
      {
        command: "up",
        intervalSeconds: 0,
        afterHealth: async () => {
          rounds += 1
          // The declaration goes away AFTER a first round has run, so the exit
          // is proved to come from the unreadable declaration and not from a
          // service that never started.
          if (rounds !== 1) return
          await catchUp(w)
          await undeclare(w)
        },
      },
      { workdir: w.workdir },
    )
    expect(exit, run.stderr()).toBe(2)
    expect(rounds).toBe(1)
    expect(run.stdout()).toContain("no longer carries a .yrd.yml")
  })

  // The other half of that control: a PERMANENT exit leaves the last round's
  // document behind rather than overwriting it with a claim about a loop that
  // has ended. The supervisor learns about a terminal exit from the exit, and
  // this file must not contradict it by inventing a state nobody measured.
  it("writes no document for the round it never ran", async () => {
    const w = await world()
    const run = capture(w.work)
    let rounds = 0
    await coreQueueCommand(
      w.work,
      run.io,
      {
        command: "up",
        intervalSeconds: 0,
        afterHealth: async () => {
          rounds += 1
          if (rounds !== 1) return
          await catchUp(w)
          await undeclare(w)
        },
      },
      { workdir: w.workdir },
    )
    expect(rounds).toBe(1)
    const left = await readQueueHealth(w.workdir, SERVICE)
    expect(left.state).toBe("healthy")
    expect(left.verdict).toEqual({ kind: "running" })
  })
})

/**
 * @failure  A stopped line refuses work, so a fix that would unstick it cannot
 *           even be queued behind the stop, and a plan of the shape "submit
 *           while stopped, resume when it lands" deadlocks. The operator's
 *           condition (2026-09-16): submits are accepted while the line is
 *           stopped IFF that causes no problem — so a submit runs no check, and
 *           the change is judged only once the stop lifts.
 * @level    l2 (a real remote and a clone; the commands driven directly)
 * @consumer every submitter whose change arrives while the line is stopped
 */
describe("a stopped line still takes work (the andon, operator 2026-09-16)", () => {
  it("a submit on a stuck-stopped line is accepted, echoes the stop, runs no check, and is judged once the stop lifts", async () => {
    const w = await world()
    const fault = brokenSetup(w.workdir)
    await redeclare(w, `setup: ${fault.command}\n`)
    for (const name of ["stuck", "late"]) {
      await w.git(["checkout", "--quiet", "-b", `task/${name}`, "main"])
      writeFileSync(join(w.work, `${name}.txt`), `${name}\n`)
      await w.git(["add", `${name}.txt`])
      await w.git(["commit", "--quiet", "-m", name])
      await w.git(["checkout", "--quiet", "main"])
    }
    const stuckHead = (await w.git(["rev-parse", "task/stuck"])).trim()
    const lateHead = (await w.git(["rev-parse", "task/late"])).trim()
    await submit(w.git, "origin", {
      branch: "task/stuck",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })
    expect(await coreQueueCommand(w.work, capture(w.work).io, { command: "run" }, { workdir: w.workdir })).toBe(2)
    const judgedBefore = fault.runs()

    for (const dryRun of [true, false]) {
      const accepted = capture(w.work)
      expect(
        await coreQueueCommand(
          w.work,
          accepted.io,
          { branch: "task/late", command: "submit", dryRun, submitter: "@dev/3" },
          { json: true, workdir: w.workdir },
        ),
        accepted.stderr(),
      ).toBe(0)
      // The echo: who stopped the line, why, and what lifts it.
      expect(records(accepted)[0]).toMatchObject({
        stopped: { by: "yrd", cause: "stuck", change: `task/stuck@${stuckHead}` },
      })
      expect(accepted.stderr()).toContain(`task/stuck@${stuckHead}`)
      expect(accepted.stderr()).toContain("yrd queue withdraw task/stuck")
      expect(accepted.stderr()).toContain("yrd queue resume")
    }
    // Opened, and nothing more: no check ran at submit.
    expect(
      await readStatus(createEventStore(w.work, "origin", gitIn(w.work).selection), "main", "task/late"),
    ).toMatchObject({
      commit: lateHead,
      status: "queued",
    })
    expect(fault.runs()).toBe(judgedBefore)

    // The stop lifts by an act — the stuck change withdrawn — and the late change is judged normally.
    fault.clear()
    expect(
      await coreQueueCommand(
        w.work,
        capture(w.work).io,
        { branch: "task/stuck", by: "@chief", command: "withdraw" },
        { workdir: w.workdir },
      ),
    ).toBe(0)
    const ran = capture(w.work)
    expect(await coreQueueCommand(w.work, ran.io, { command: "run" }, { json: true, workdir: w.workdir })).toBe(0)
    expect(records(ran)[0]).toMatchObject({ merged: ["task/late"], stuck: [] })
    const late = await readStatus(createEventStore(w.work, "origin", gitIn(w.work).selection), "main", "task/late")
    expect(late.status).toBe("merged")
    expect(late.ending?.kind).toBe("merged")
  })

  it("list --json says stopped: null while the line runs, and names the stop while it is stopped", async () => {
    const w = await world()
    const fault = brokenSetup(w.workdir)

    const running = capture(w.work)
    expect(await coreQueueCommand(w.work, running.io, { command: "list" }, { json: true, workdir: w.workdir })).toBe(0)
    expect(records(running)[0]).toHaveProperty("stopped", null)

    await redeclare(w, `setup: ${fault.command}\n`)
    await w.git(["checkout", "--quiet", "-b", "task/stuck", "main"])
    writeFileSync(join(w.work, "stuck.txt"), "stuck\n")
    await w.git(["add", "stuck.txt"])
    await w.git(["commit", "--quiet", "-m", "stuck"])
    const head = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])
    await submit(w.git, "origin", {
      branch: "task/stuck",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })
    expect(await coreQueueCommand(w.work, capture(w.work).io, { command: "run" }, { workdir: w.workdir })).toBe(2)

    const stuck = capture(w.work)
    expect(await coreQueueCommand(w.work, stuck.io, { command: "list" }, { json: true, workdir: w.workdir })).toBe(0)
    const stopped = (records(stuck)[0] as { stopped: Record<string, unknown> }).stopped
    expect(stopped).toEqual({ by: "yrd", cause: "stuck", change: `task/stuck@${head}`, since: expect.any(String) })
    expect(Number.isNaN(Date.parse(String(stopped.since)))).toBe(false)

    // An operator's stop names nobody's change.
    await coreQueueCommand(w.work, capture(w.work).io, { by: "@chief", command: "resume" }, { workdir: w.workdir })
    await coreQueueCommand(
      w.work,
      capture(w.work).io,
      { by: "@chief", command: "pause", reason: "inspecting" },
      { workdir: w.workdir },
    )
    const paused = capture(w.work)
    expect(await coreQueueCommand(w.work, paused.io, { command: "list" }, { json: true, workdir: w.workdir })).toBe(0)
    expect((records(paused)[0] as { stopped: unknown }).stopped).toEqual({
      by: "@chief",
      cause: "operator",
      change: null,
      since: expect.any(String),
    })
  })
})

/**
 * @failure  The loop writes its document only when a round ENDS, so freshness
 *           rides on a round budget: a live round longer than the budget reads
 *           overdue, a dead writer's document is believed for the whole budget,
 *           a first round leaves no document at all, and nothing in the file says
 *           WHICH process wrote it — so the supervisor refuses or trusts a start
 *           on a document nobody may still be writing (@i/4-supervision/24523,
 *           D2 and D6 as refined, F1–F4).
 * @level    l2 (a real remote and a clone under a temporary root; the loop driven
 *           directly, every published document caught at the rename that
 *           publishes it)
 * @consumer hab, which decides from `facts.runner` whether a start may proceed
 *           and whether the child it spawned is ready · the page an overdue
 *           document opens
 */
describe("the service keeps its document fresh and names its writer (24523)", () => {
  /**
   * The heartbeat at test scale. The behaviour under test is the same at a
   * tenth of a second as at production's cadence, and a test that waited out
   * the real one would be deleted rather than fixed (the `relaunchWaitCapMs`
   * precedent).
   */
  const HEARTBEAT = { heartbeatIntervalMs: 100, heartbeatGraceMs: 500 } as const
  /** How long one write is believed: interval plus grace, and nothing else (F4). */
  const WINDOW = HEARTBEAT.heartbeatIntervalMs + HEARTBEAT.heartbeatGraceMs

  /** One health document as it was published, and whether the held round's setup had begun by then. */
  type Published = Readonly<{ at: number; document: QueueHealthDocument; setupStarted: boolean }>

  /**
   * Every health document the service publishes, in order, caught at the rename
   * that makes it the probe's: the writer stages the file, then renames it into
   * place. Sampling the file instead misses whatever the next write replaces
   * before the next look, and "every write carries X" is then a claim only
   * about the writes somebody happened to see.
   */
  async function publishedHealth(
    workdir: string,
    started?: string,
  ): Promise<Readonly<{ writes: readonly Published[]; [Symbol.dispose](): void }>> {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
    const path = join(workdir, "service-health.json")
    const writes: Published[] = []
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === path) {
        writes.push({
          at: Date.now(),
          document: JSON.parse(actual.readFileSync(from, "utf8")) as QueueHealthDocument,
          setupStarted: started !== undefined && actual.existsSync(started),
        })
      }
      actual.renameSync(from, to)
    })
    return { writes, [Symbol.dispose]: () => rename.mockRestore() }
  }

  /** The same document, by its serialized form: what the probe reads is JSON. */
  function same(left: QueueHealthDocument | undefined, right: QueueHealthDocument | undefined): boolean {
    return JSON.stringify(left) === JSON.stringify(right)
  }

  /** What a heartbeat carries unchanged from the document it re-writes: everything but the clocks. */
  function stateOf(document: QueueHealthDocument | undefined): unknown {
    return {
      error: document?.error,
      schema: document?.schema,
      service: document?.service,
      state: document?.state,
      stopped: document?.facts?.stopped,
      verdict: document?.verdict,
    }
  }

  /**
   * hab's reader of a document's writer (`observedExternalOwner`), restated as
   * assertions because this package cannot import the host that vendors it: a
   * running verdict for this service, a pid that is a safe integer above 1,
   * `startedAt` and `lastTickAt` that both parse with `lastTickAt` at or after
   * `startedAt`, and a command that is not empty. Then D2's values: this
   * process, its own start from the runtime, the instant of this write, its argv.
   */
  function expectRunner(document: QueueHealthDocument | undefined): void {
    const why = JSON.stringify(document)
    expect(document?.service, why).toBe(SERVICE)
    expect(document?.verdict, why).toEqual({ kind: "running" })
    const runner = document?.facts?.runner as Record<string, unknown> | undefined
    expect(runner, `facts.runner is missing from ${why}`).toBeTypeOf("object")
    const { command, lastTickAt, pid, startedAt } = runner ?? {}
    expect(Number.isSafeInteger(pid) && (pid as number) > 1, why).toBe(true)
    expect(typeof startedAt === "string" && Number.isFinite(Date.parse(startedAt)), why).toBe(true)
    expect(typeof lastTickAt === "string" && Number.isFinite(Date.parse(lastTickAt)), why).toBe(true)
    expect(Date.parse(String(lastTickAt)) >= Date.parse(String(startedAt)), why).toBe(true)
    expect(typeof command === "string" && command.trim() !== "", why).toBe(true)
    expect(runner, why).toEqual({
      command: process.argv.join(" "),
      lastTickAt: document?.facts?.writtenAt,
      pid: process.pid,
      startedAt: new Date(performance.timeOrigin).toISOString(),
    })
  }

  /** A setup that holds its round open until the test releases it, and leaves a mark when it begins. */
  function heldSetup(dir: string): Readonly<{ command: string; started: string; release: () => void }> {
    const started = join(dir, "held-setup-started")
    const released = join(dir, "held-setup-released")
    const script = join(dir, "held-setup.sh")
    writeFileSync(
      script,
      [
        "#!/bin/sh",
        `echo "$(pwd)" >> ${started}`,
        ...waitingFor(`[ ! -f ${released} ]`, "held-setup: the test never released this round; giving up"),
        "exit 0",
        "",
      ].join("\n"),
    )
    chmodSync(script, 0o755)
    return { command: script, started, release: () => writeFileSync(released, "released\n") }
  }

  /** One change waiting in the line, so a round has something to judge. */
  async function oneChange(w: World, branch: string): Promise<string> {
    await w.git(["checkout", "--quiet", "-b", branch, "main"])
    writeFileSync(join(w.work, `${branch.replace("/", "-")}.txt`), "work\n")
    await w.git(["add", "-A"])
    await w.git(["commit", "--quiet", "-m", branch])
    const head = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])
    await submit(w.git, "origin", { branch, submitter: "@dev/4", target: { branch: "main", remote: "origin" } })
    return head
  }

  /**
   * Two rounds over an empty line, one second apart, stopped after the second:
   * a start, an idle sleep for the heartbeat to cover, and two round ends.
   *
   * `roundEnds` holds the index of each round's own write. A round publishes
   * its document and hands it to `afterHealth` with nothing awaited between,
   * so the write just before the hook runs is that round's, whatever else the
   * document carries.
   */
  async function idleService(): Promise<
    Readonly<{
      exit: number
      stderr: string
      roundEnds: readonly number[]
      workdir: string
      writes: readonly Published[]
    }>
  > {
    const w = await world()
    using published = await publishedHealth(w.workdir)
    const run = capture(w.work)
    const stop = new AbortController()
    const roundEnds: number[] = []
    const exit = await coreQueueCommand(
      w.work,
      run.io,
      {
        command: "up",
        intervalSeconds: 1,
        stop: stop.signal,
        ...HEARTBEAT,
        afterHealth: () => {
          roundEnds.push(published.writes.length - 1)
          if (roundEnds.length === 2) stop.abort()
        },
      },
      { json: true, workdir: w.workdir },
    )
    // The instrument, before anything is concluded from it: both rounds' own writes were caught.
    expect(
      roundEnds.filter((index) => index >= 0),
      run.stderr(),
    ).toHaveLength(2)
    // THE WRITER HAS STOPPED. Whatever is published from here on was written
    // by a loop that already returned (F2: the heartbeat is cleared on the way out).
    const written = published.writes.length
    await delay(3 * HEARTBEAT.heartbeatIntervalMs)
    expect(published.writes, "documents published after the loop returned").toHaveLength(written)
    return { exit, roundEnds, stderr: run.stderr(), workdir: w.workdir, writes: [...published.writes] }
  }

  // T1 (D6 as refined). A round is held open for three staleness windows —
  // the test-scale stand-in for a round past ROUND_BUDGET_MS, which 31 of
  // 289 measured rounds were. Freshness comes from the writer writing, never
  // from a budget on how long a round may take.
  it("a round held open past its staleness window stays fresh while the heartbeat runs", async () => {
    const w = await world()
    const held = heldSetup(w.workdir)
    await redeclare(w, `setup: ${held.command}\n`)
    using published = await publishedHealth(w.workdir)
    const run = capture(w.work)
    const stop = new AbortController()
    const seen: QueueHealthDocument[] = []
    const service = coreQueueCommand(
      w.work,
      run.io,
      {
        command: "up",
        intervalSeconds: 0,
        stop: stop.signal,
        ...HEARTBEAT,
        afterHealth: async (document) => {
          seen.push(document)
          // Round 1 found the line empty and ended at once. Round 2 gets a
          // change, and its setup holds it open until the test lets go.
          if (seen.length === 1) await oneChange(w, "task/long")
          else stop.abort()
        },
      },
      { json: true, workdir: w.workdir },
    )
    try {
      await vi.waitFor(() => expect(existsSync(held.started), run.stderr()).toBe(true), { timeout: 20_000 })
      const heldSince = Date.now()
      const readings: string[] = []
      while (Date.now() - heldSince < 3 * WINDOW) {
        const reading = await readQueueHealth(w.workdir, SERVICE)
        readings.push(reading.error?.code ?? reading.state)
        await delay(25)
      }
      expect(seen, "round 2 is still open").toHaveLength(1)
      // The instrument, before anything is concluded from it: round 1's own write was caught.
      expect(published.writes.filter((write) => write.at < heldSince).length, run.stderr()).toBeGreaterThan(0)
      // What the supervisor reads, at real time, for the whole hold: the loop's
      // own verdict, never overdue and never absent.
      expect(readings.filter((reading) => reading !== "healthy")).toEqual([])
      // And it is the heartbeat that keeps it so: documents keep being written
      // while no round ends, each carrying round 1's verdict unchanged.
      const beats = published.writes.filter((write) => write.at >= heldSince)
      expect(beats.length, "documents written while round 2 was held open").toBeGreaterThanOrEqual(2)
      for (const beat of beats) expect(stateOf(beat.document)).toEqual(stateOf(seen[0]))
      held.release()
      expect(await service, run.stderr()).toBe(0)
      expect(seen).toHaveLength(2)
    } finally {
      held.release()
      stop.abort()
      await service.catch(() => undefined)
    }
  }, 30_000)

  /** @failure 25708: three unreadable publication witnesses killed the service while its health stayed stale.
   * @level l2 @consumer Hab health probe and queue list/watch reader
   */
  it("keeps the service alive through repeated failed remote-read rounds, pages once, and clears after recovery", async () => {
    const w = await world(false)
    const commit = (await w.git(["rev-parse", "main"])).trim()
    const config = await readConfig(w.git, commit, { branch: "main", remote: "origin" })
    if (config === undefined) throw new Error("the fixture's target lost its declaration")
    await createEventQueue(
      createEventStore(w.work, "origin", gitIn(w.work).selection),
      "main",
      commit,
      config,
      new Date(),
    )
    const branch = "task/read-recovery"
    await oneChange(w, branch)
    const ref = changesRef("main", branch)
    const originalBackend = gitomic.createShellBackend
    let failures = 0
    let unreadable = false
    using _backend = vi.spyOn(gitomic, "createShellBackend").mockImplementation((options) => {
      const backend = originalBackend(options)
      const publish = backend.publish
      const listRefs = backend.listRefs
      if (publish === undefined || listRefs === undefined) {
        throw new Error("fixture needs Gitomic remote refs and publish")
      }
      return {
        ...backend,
        publish: async (repo, updates, remote) => {
          if (
            failures < 4 &&
            updates.some((update) => update.ref === ref) &&
            updates.some((update) => update.ref === "refs/heads/main")
          ) {
            failures++
            unreadable = true
            throw new Error("injected publication transport outage")
          }
          return publish(repo, updates, remote)
        },
        listRefs: async (repo, prefix, remote) => {
          if (unreadable && prefix === ref) {
            unreadable = false
            throw new Error("injected remote reread outage")
          }
          return listRefs(repo, prefix, remote)
        },
      }
    })
    const stop = new AbortController()
    const run = capture(w.work)
    const seen: QueueHealthDocument[] = []
    let listing = ""
    const exit = await coreQueueCommand(
      w.work,
      run.io,
      {
        command: "up",
        intervalSeconds: 0,
        stop: stop.signal,
        afterHealth: async (document) => {
          seen.push(document)
          if (seen.length === 3) {
            expect((await readRunnerFacts(w.workdir)).service).toMatchObject({
              kind: "beating",
              readFailure: { ref, error: "injected remote reread outage", count: 3 },
            })
            const view = capture(w.work)
            expect(await coreQueueCommand(w.work, view.io, { command: "list" }, { workdir: w.workdir })).toBe(0)
            listing = `${view.stdout()}\n${view.stderr()}`
          }
        },
        afterRound: (outcome) => {
          expect(outcome.merged).toContain(branch)
          stop.abort()
        },
      },
      { json: true, workdir: w.workdir },
    )
    expect(exit, run.stderr()).toBe(0)
    expect(failures).toBe(4)
    expect(seen.map((document) => (document.facts?.roundReadFailure as { count?: number } | undefined)?.count)).toEqual(
      [1, 2, 3, 4, undefined],
    )
    expect(seen.map((document) => document.state)).toEqual(["healthy", "healthy", "unhealthy", "unhealthy", "healthy"])
    expect(seen[2]?.error?.cause).toContain(ref)
    expect(seen[3]?.error?.code).toBe(seen[2]?.error?.code)
    expect(listing).toContain(ref)
    expect(listing).toContain("injected remote reread outage")
    const logs = readdirSync(join(w.workdir, "logs")).filter((name) => name.endsWith(".jsonl"))
    expect(
      logs.some((name) =>
        readFileSync(join(w.workdir, "logs", name), "utf8").includes('"subject":"round-read-failed"'),
      ),
    ).toBe(true)
  }, 60_000)

  /** @failure 25736: the first three event-chain retry exhaustions killed up before it read the line.
   * @level l2 @consumer Hab health probe and queue watch
   */
  it("keeps up alive and pages repeated event retry exhaustion before its first line reading", async () => {
    const w = await world(false)
    const commit = (await w.git(["rev-parse", "main"])).trim()
    const config = await readConfig(w.git, commit, { branch: "main", remote: "origin" })
    if (config === undefined) throw new Error("the fixture's target lost its declaration")
    const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
    await createEventQueue(store, "main", commit, config, new Date())
    const earlier = new Date(Date.now() - 3_600_000)
    await writeQueueOverride(
      store,
      "main",
      {
        kind: "off",
        check: "verify",
        until: new Date(Date.now() - 1_000),
        reason: "expired fixture",
        actor: { by: "operator", verified: true },
      },
      ["verify"],
      earlier,
    )
    const ref = queueRef("main")
    // An older refusal is real, but lies beyond the bounded journal window.
    // The service must name that uncertainty and still page after three new rounds.
    const marker = (await readEventQueue(store, "main")).tip
    const logs = join(w.workdir, "logs")
    mkdirSync(logs, { recursive: true })
    const oldAt = new Date(Date.now() - 3_600_000)
    const oldRun = runId(oldAt)
    writeFileSync(
      join(logs, `${oldRun}.jsonl`),
      `${JSON.stringify({ kind: "warning", run: oldRun, at: oldAt.toISOString(), subject: "cas-refused", ref, marker })}\n`,
    )
    const newer = Date.now() - 1_800_000
    for (let index = 0; index < 129; index++) {
      writeFileSync(join(logs, `${runId(new Date(newer + index * 1_000))}.jsonl`), "")
    }
    const originalBackend = gitomic.createShellBackend
    let refused = 0
    let hold = true
    using _backend = vi.spyOn(gitomic, "createShellBackend").mockImplementation((options) => {
      const backend = originalBackend(options)
      const publish = backend.publish
      if (publish === undefined) throw new Error("fixture needs Gitomic publish")
      return {
        ...backend,
        publish: async (repo, updates, remote) => {
          if (hold && updates.some((update) => update.ref === ref)) {
            refused++
            throw new gitomic.Conflict(`injected unchanged-tip refusal for ${ref}`, { refs: [ref] })
          }
          return publish(repo, updates, remote)
        },
      }
    })
    const stop = new AbortController()
    const run = capture(w.work)
    const seen: QueueHealthDocument[] = []
    const exit = await coreQueueCommand(
      w.work,
      run.io,
      {
        command: "up",
        intervalSeconds: 0,
        stop: stop.signal,
        afterHealth: async (document) => {
          seen.push(document)
          if (seen.length === 1) await delay(100)
          if (seen.length === 3) {
            expect((await readRunnerFacts(w.workdir)).service).toMatchObject({
              kind: "beating",
              flow: { casRefused: { ref, site: "expire-overrides", count: 3, budgetMs: 5_000 } },
            })
            hold = false
          }
        },
        afterRound: () => stop.abort(),
      },
      { json: true, workdir: w.workdir },
    )
    expect(exit, run.stderr()).toBe(0)
    expect(refused).toBeGreaterThanOrEqual(3)
    expect(seen).toHaveLength(4)
    expect(seen.map((document) => document.state)).toEqual(["healthy", "healthy", "unhealthy", "healthy"])
    expect(seen[2]?.error?.code).toBe("queue-line-stalled")
    expect((seen[2]?.facts?.flow as { stalledForMs?: number } | undefined)?.stalledForMs).toBeGreaterThanOrEqual(75)
    expect(seen[2]?.error?.cause).toContain("line not read this round")
    const firstRefusal = (seen[0]?.facts?.flow as { casRefused?: { firstAt?: string } } | undefined)?.casRefused
    const thirdRefusal = (seen[2]?.facts?.flow as { casRefused?: { firstAt?: string } } | undefined)?.casRefused
    expect(firstRefusal?.firstAt).toBeDefined()
    expect(thirdRefusal?.firstAt).toBe(firstRefusal?.firstAt)
    const refusalRows = readdirSync(logs)
      .filter((name) => name.startsWith("q-") && name.endsWith(".jsonl"))
      .flatMap((name) => readRunLog(logs, name.slice(0, -".jsonl".length)))
      .filter((row) => row.kind === "warning" && row.subject === "cas-refused" && row.site === "expire-overrides")
      .sort((a, b) => a.at.localeCompare(b.at))
    expect(refusalRows.map((row) => row.count)).toEqual([1, 2, 3])
    expect(refusalRows[0]).toMatchObject({
      windowBudget: "cas-history-journals",
      windowBudgetJournals: 128,
      windowExhausted: expect.stringMatching(/^q-/u),
    })
    expect(refusalRows[2]).toMatchObject({
      windowBudget: "cas-history-journals",
      windowBudgetJournals: 128,
      windowExhausted: expect.stringMatching(/^q-/u),
    })
    expect(run.stderr()).toContain("cas-history-journals budget (128 journals)")
    expect(seen[2]?.error?.cause).toContain("earlier refusals may lie beyond the cas-history-journals 128 files scan")
    expect(seen[2]?.facts?.flow).not.toHaveProperty("waiting")
    expect((seen[2]?.facts?.flow as { casRefused?: object } | undefined)?.casRefused).not.toHaveProperty("branch")
    expect(seen[3]?.facts?.flow).toHaveProperty("waiting")
    expect(seen[3]?.facts?.flow).not.toHaveProperty("casRefused")
    expect(run.stderr()).toContain("the service retries at its next interval")
  }, 60_000)

  /** @failure 25708: the read-failed retry must not turn unrelated runner faults into an endless healthy loop.
   * @level l2 @consumer Hab supervisor
   */
  it("keeps an unrelated thrown round error terminal", async () => {
    const w = await world()
    const hooks = join(w.workdir, "hooks-disabled")
    mkdirSync(hooks, { recursive: true })
    writeFileSync(join(hooks, "unexpected-hook"), "fixture\n")
    const run = capture(w.work)
    const exit = await coreQueueCommand(
      w.work,
      run.io,
      { command: "up", intervalSeconds: 0 },
      { json: true, workdir: w.workdir },
    )
    expect(exit).toBe(2)
    expect(run.stdout()).toContain("hooks-disabled")
  })

  /** @failure 25946: a second change-ref write between the rival status and its selected history read
   * escaped as an unexpected round error and ended the supervised service with exit 2.
   * The discard must carry the second tip, not the stale status read before that write.
   * @level l2 @consumer Hab's yrd service
   */
  it("keeps up alive when a rival advances the change after its status read", async () => {
    const w = await world(false)
    const commit = (await w.git(["rev-parse", "main"])).trim()
    const config = await readConfig(w.git, commit, { branch: "main", remote: "origin" })
    if (config === undefined) throw new Error("the fixture's target lost its declaration")
    await createEventQueue(
      createEventStore(w.work, "origin", gitIn(w.work).selection),
      "main",
      commit,
      config,
      new Date(),
    )
    const branch = "task/rival-after-status"
    await oneChange(w, branch)
    const ref = changesRef("main", branch)
    const rivalStore = createEventStore(w.work, "origin", gitIn(w.work).selection)
    const originalBackend = gitomic.createShellBackend
    let firstWrite = false
    let secondWrite = false
    let ignoredTip: string | undefined
    let resumedTip: string | undefined
    using _backend = vi.spyOn(gitomic, "createShellBackend").mockImplementation((options) => {
      const backend = originalBackend(options)
      const publish = backend.publish
      const readHistory = backend.readHistory
      if (publish === undefined || readHistory === undefined) {
        throw new Error("fixture needs Gitomic history and publish")
      }
      return {
        ...backend,
        publish: async (repo, updates, remote) => {
          if (!firstWrite && remote === "origin" && updates.some((update) => update.ref === ref)) {
            firstWrite = true
            await setBranchIgnored(rivalStore, { queue: "main", branch, by: "@chief", ignored: true, reason: "rival" })
            ignoredTip = (await readStatus(rivalStore, "main", branch)).tip
          }
          return publish(repo, updates, remote)
        },
        readHistory: async (repo, tips, options) => {
          const history = await readHistory(repo, tips, options)
          if (!secondWrite && ignoredTip !== undefined && tips.length === 1 && tips[0] === ignoredTip) {
            // The selected status still describes ignoredTip; the rival moves it before the next read.
            secondWrite = true
            await setBranchIgnored(rivalStore, { queue: "main", branch, by: "@chief", ignored: false })
            resumedTip = (await readStatus(rivalStore, "main", branch)).tip
          }
          return history
        },
      }
    })
    const stop = new AbortController()
    const run = capture(w.work)
    const exit = await coreQueueCommand(
      w.work,
      run.io,
      { command: "up", intervalSeconds: 0, stop: stop.signal, afterRound: () => stop.abort() },
      { json: true, workdir: w.workdir },
    )
    expect(firstWrite).toBe(true)
    expect(secondWrite).toBe(true)
    expect(resumedTip).toBeDefined()
    expect(resumedTip).not.toBe(ignoredTip)
    expect((await readStatus(rivalStore, "main", branch)).ignored).toBeUndefined()
    expect(exit, `${run.stderr()}\n${run.stdout()}`).toBe(0)
    expect(records(run)).toHaveLength(1)
    expect(records(run)[0]).toMatchObject({ exitCode: 0, merged: [], stuck: [] })
    expect(readRunLog(join(w.workdir, "logs"), String(records(run)[0]?.run))).toContainEqual(
      expect.objectContaining({ kind: "warning", subject: "change-ref-moved-during-history-read", branch, ref }),
    )
    expect(readRunLog(join(w.workdir, "logs"), String(records(run)[0]?.run))).toContainEqual(
      expect.objectContaining({ kind: "discarded", branch, reason: expect.stringContaining(`at ${resumedTip} while`) }),
    )
  }, 60_000)

  // 25669 row 2: an event round held open is named on each beat with the phase
  // its own journal says it is in, so `yrd queue health` says where it is.
  it("the beats of an open event round name its phase, from the round's own journal", async () => {
    const w = await world(false)
    const held = heldSetup(w.workdir)
    await redeclare(w, `setup: ${held.command}\n`)
    const commit = (await w.git(["rev-parse", "main"])).trim()
    const config = await readConfig(w.git, commit, { branch: "main", remote: "origin" })
    if (config === undefined) throw new Error("the fixture's target lost its declaration")
    await createEventQueue(
      createEventStore(w.work, "origin", gitIn(w.work).selection),
      "main",
      commit,
      config,
      new Date(),
    )
    using published = await publishedHealth(w.workdir)
    const run = capture(w.work)
    const stop = new AbortController()
    const seen: QueueHealthDocument[] = []
    const service = coreQueueCommand(
      w.work,
      run.io,
      {
        command: "up",
        intervalSeconds: 0,
        stop: stop.signal,
        ...HEARTBEAT,
        afterHealth: async (document) => {
          seen.push(document)
          if (seen.length === 1) await oneChange(w, "task/long")
          else stop.abort()
        },
      },
      { json: true, workdir: w.workdir },
    )
    try {
      await vi.waitFor(() => expect(existsSync(held.started), run.stderr()).toBe(true), { timeout: 20_000 })
      const heldSince = Date.now()
      const openOf = (document: QueueHealthDocument): unknown =>
        (document.facts?.flow as { roundOpen?: unknown } | undefined)?.roundOpen
      await vi.waitFor(
        () => {
          const beats = published.writes.filter((write) => write.at >= heldSince)
          expect(beats.map((beat) => openOf(beat.document)).at(-1), run.stderr()).toMatchObject({
            phase: expect.stringContaining("setup"),
          })
        },
        { timeout: 10_000 },
      )
      held.release()
      expect(await service, run.stderr()).toBe(0)
      // The round's end clears it: a closed round has no phase.
      expect(openOf(seen.at(-1) as QueueHealthDocument)).toBeUndefined()
    } finally {
      held.release()
      stop.abort()
      await service.catch(() => undefined)
    }
  }, 30_000)

  // 25669: the FIRST round after a start has no flow in the loop yet, and it is
  // the round the 09-24 cut-over stood still in. Its own journalled line makes
  // it judgeable: the beats state the waiting count and the phase it is in.
  it("the first round after a start is judged from its own journal's line", async () => {
    const w = await world(false)
    const held = heldSetup(w.workdir)
    await redeclare(w, `setup: ${held.command}\n`)
    const commit = (await w.git(["rev-parse", "main"])).trim()
    const config = await readConfig(w.git, commit, { branch: "main", remote: "origin" })
    if (config === undefined) throw new Error("the fixture's target lost its declaration")
    await createEventQueue(
      createEventStore(w.work, "origin", gitIn(w.work).selection),
      "main",
      commit,
      config,
      new Date(),
    )
    await oneChange(w, "task/first")
    using published = await publishedHealth(w.workdir)
    const run = capture(w.work)
    const stop = new AbortController()
    const service = coreQueueCommand(
      w.work,
      run.io,
      { command: "up", intervalSeconds: 0, stop: stop.signal, ...HEARTBEAT, afterHealth: async () => stop.abort() },
      { json: true, workdir: w.workdir },
    )
    try {
      await vi.waitFor(() => expect(existsSync(held.started), run.stderr()).toBe(true), { timeout: 20_000 })
      const heldSince = Date.now()
      await vi.waitFor(
        () => {
          const last = published.writes.filter((write) => write.at >= heldSince).at(-1)
          expect(last?.document.facts?.flow, run.stderr()).toMatchObject({
            oldestWaiting: { branch: "task/first" },
            roundOpen: { phase: expect.stringContaining("setup") },
            waiting: 1,
          })
        },
        { timeout: 10_000 },
      )
      held.release()
      expect(await service, run.stderr()).toBe(0)
    } finally {
      held.release()
      stop.abort()
      await service.catch(() => undefined)
    }
  }, 30_000)

  // T2 (F4). ONE freshness rule for every write, event-driven and heartbeat
  // alike, so overdue means exactly one thing: the writer stopped writing.
  it("a writer that stops writing reads overdue only after interval plus grace, never before", async () => {
    const { exit, stderr, workdir, writes } = await idleService()
    expect(exit, stderr).toBe(0)
    for (const { document } of writes) {
      const declared = Date.parse(String(document.facts?.staleAfter)) - Date.parse(String(document.facts?.writtenAt))
      expect(declared, `staleAfter - writtenAt in ${JSON.stringify(document)}`).toBe(WINDOW)
    }
    // The document left on disk is the last one published: the probe below reads the writer's final word.
    const last = writes.at(-1)?.document
    expect(same(last, parseQueueHealthDocument(readFileSync(join(workdir, "service-health.json"), "utf8")))).toBe(true)
    const writtenAt = Date.parse(String(last?.facts?.writtenAt))
    const at = (ms: number) => new Date(writtenAt + ms)
    // Believed through the instant interval plus grace runs out...
    expect((await readQueueHealth(workdir, SERVICE, at(WINDOW))).error?.code).toBeUndefined()
    // ...and overdue the millisecond after, whatever the round budget says.
    expect((await readQueueHealth(workdir, SERVICE, at(WINDOW + 1))).error?.code).toBe("queue-round-overdue")
  }, 30_000)

  // T3 (@cto amendment 2). A stuck change stops the line and the service holds
  // it. Every document across the hold, heartbeats included, reads the stop and
  // pages it — never overdue, which would say the writer died.
  it("a stopped line reads stopped, never overdue, across a long hold, heartbeat writes included", async () => {
    const w = await world()
    const fault = brokenSetup(w.workdir)
    await redeclare(w, `setup: ${fault.command}\n`)
    const head = await oneChange(w, "task/stuck")
    using published = await publishedHealth(w.workdir)
    const run = capture(w.work)
    const stop = new AbortController()
    const seen: QueueHealthDocument[] = []
    const roundEnds: number[] = []
    const service = coreQueueCommand(
      w.work,
      run.io,
      {
        command: "up",
        // A second between holding rounds: idle time only a heartbeat covers.
        intervalSeconds: 1,
        stop: stop.signal,
        ...HEARTBEAT,
        afterHealth: (document) => {
          seen.push(document)
          roundEnds.push(published.writes.length - 1)
          // The round that stuck, and two that hold the stop.
          if (seen.length === 3) stop.abort()
        },
      },
      { json: true, workdir: w.workdir },
    )
    try {
      await vi.waitFor(() => expect(seen.length, run.stderr()).toBeGreaterThan(0), { timeout: 20_000 })
      const heldSince = Date.now()
      const readings: QueueHealthDocument[] = []
      while (seen.length < 3) {
        readings.push(await readQueueHealth(w.workdir, SERVICE))
        await delay(25)
      }
      expect(await service, run.stderr()).toBe(0)
      expect(
        roundEnds.filter((index) => index >= 0),
        "the recorder caught every round's own write",
      ).toHaveLength(3)
      const stopped = { by: "yrd", cause: "stuck", change: `task/stuck@${head}`, since: expect.any(String) }
      expect(seen[0]?.error?.code).toBe("queue-round-stuck")
      expect(seen[0]?.facts?.stopped).toEqual(stopped)
      // The supervisor's reading, every 25ms of the hold: the stop's page, never an overdue one.
      expect(readings.length).toBeGreaterThan(0)
      expect([...new Set(readings.map((reading) => reading.error?.code ?? reading.state))]).toEqual([
        "queue-round-stuck",
      ])
      for (const reading of readings) expect(reading.facts?.stopped).toEqual(stopped)
      // The idle time was covered by heartbeats, and every one carried the stop.
      const beats = published.writes.filter((write, index) => write.at >= heldSince && !roundEnds.includes(index))
      expect(beats.length, "heartbeat documents published while the stopped line was held").toBeGreaterThanOrEqual(2)
      for (const beat of beats) expect(stateOf(beat.document)).toEqual(stateOf(seen[0]))
    } finally {
      stop.abort()
      await service.catch(() => undefined)
    }
  }, 30_000)

  // T4, the loop's own writes (D2). hab decides from `facts.runner` whether a
  // start may proceed; a document without it reads as absent identity, which
  // is today's conflict. The start, each heartbeat and each round's end name
  // their writer.
  it("every document names its writer in hab's shape: the start, each heartbeat, each round end", async () => {
    const { exit, roundEnds, stderr, writes } = await idleService()
    expect(exit, stderr).toBe(0)
    for (const { document } of writes) expectRunner(document)
    // Not vacuously: each kind of write was among them.
    const [firstRoundEnd = -1] = roundEnds
    expect(firstRoundEnd, "documents published before round 1 ended").toBeGreaterThan(0)
    expect(
      writes.length - firstRoundEnd - roundEnds.length,
      "heartbeat documents published after round 1 ended",
    ).toBeGreaterThan(0)
  }, 30_000)

  /**
   * A relaunch that waits for a checkout which does not come: the target
   * records b, the runtime's own checkout stays at a, and the stall alarm fires
   * on a 50ms cap. Once it has, the checkout lands and the loop exits 0.
   */
  async function stalledRelaunch(): Promise<Readonly<{ exit: number; output: string; writes: readonly Published[] }>> {
    const w = await gitlinkWorld()
    await w.git(["update-index", "--cacheinfo", "160000", w.b, "submodule"])
    await w.git(["commit", "--quiet", "-m", "target records b, checkout does not follow"])
    await w.git(["push", "--quiet", "origin", "main"])
    using published = await publishedHealth(w.workdir)
    const run = capture(w.work)
    const stop = new AbortController()
    const service = w.command(
      w.work,
      run.io,
      {
        command: "up",
        intervalSeconds: 0,
        stop: stop.signal,
        relaunchWaitCapMs: 50,
        ...HEARTBEAT,
        afterRound: () => stop.abort(),
      },
      { json: true, workdir: w.workdir },
    )
    try {
      await vi.waitFor(() => expect(run.stdout()).toContain("relaunch-wait-stalled"), { timeout: 8000 })
      const sub = gitIn(join(w.work, "submodule"))
      await sub(["fetch", "--quiet", "origin", "main"])
      await sub(["checkout", "--quiet", w.b])
      const exit = await service
      return { exit, output: `${run.stdout()}\n${run.stderr()}`, writes: [...published.writes] }
    } finally {
      stop.abort()
      await service.catch(() => undefined)
    }
  }

  // T4, the relaunch wait's writes (D2). The wait replaces a round and writes
  // its own documents — the announcement and the stall page — and a start gate
  // reading either must find the writer named there too.
  it("the relaunch wait's documents, the announcement and the stall page, name their writer too", async () => {
    const { exit, output, writes } = await stalledRelaunch()
    expect(exit, output).toBe(0)
    const announced = writes.filter(
      ({ document }) => document.state === "healthy" && document.facts?.waitingForCheckout === "submodule",
    )
    const stalled = writes.filter(({ document }) => document.error?.code === "queue-relaunch-stalled")
    expect(announced.length, "relaunch-wait announcements published").toBeGreaterThan(0)
    expect(stalled.length, "relaunch-stalled pages published").toBeGreaterThan(0)
    for (const { document } of writes) expectRunner(document)
  }, 30_000)

  // F3. The stall page is the one document that never said whether the line is
  // stopped, and the stop fact is always present precisely so that its absence
  // can never be read as running (pause.ts `stopFact`). It carries the last
  // known stop, which on a line nothing stopped is none.
  it("the relaunch-stalled page carries the stop fact, like every other document", async () => {
    const { exit, output, writes } = await stalledRelaunch()
    expect(exit, output).toBe(0)
    const stalled = writes.filter(({ document }) => document.error?.code === "queue-relaunch-stalled")
    expect(stalled.length, "relaunch-stalled pages published").toBeGreaterThan(0)
    for (const { document } of stalled) expect(document.facts, JSON.stringify(document)).toHaveProperty("stopped", null)
  }, 30_000)

  // T5 (F1). Before round 1 opens the loop has already written. Without it,
  // hab's readiness (D5) waits out a long first round against an absence or a
  // predecessor's document.
  it("writes its first document at start, before round 1 opens, saying the line runs", async () => {
    const w = await world()
    const held = heldSetup(w.workdir)
    await redeclare(w, `setup: ${held.command}\n`)
    await oneChange(w, "task/first")
    using published = await publishedHealth(w.workdir, held.started)
    const run = capture(w.work)
    const stop = new AbortController()
    const seen: QueueHealthDocument[] = []
    const service = coreQueueCommand(
      w.work,
      run.io,
      {
        command: "up",
        intervalSeconds: 0,
        stop: stop.signal,
        ...HEARTBEAT,
        afterHealth: (document) => {
          seen.push(document)
          stop.abort()
        },
      },
      { json: true, workdir: w.workdir },
    )
    try {
      await vi.waitFor(() => expect(existsSync(held.started), run.stderr()).toBe(true), { timeout: 20_000 })
      expect(seen, "round 1 is still open").toHaveLength(0)
      // What readiness reads while round 1 is open: this loop's own document, not an absence.
      const reading = await readQueueHealth(w.workdir, SERVICE)
      expect(reading.state, JSON.stringify(reading)).toBe("healthy")
      const [first] = published.writes
      expect(first?.setupStarted, "the first document was published before round 1's setup began").toBe(false)
      expect(first?.document).toMatchObject({
        state: "healthy",
        verdict: { kind: "running" },
        facts: { stopped: null },
      })
      expectRunner(first?.document)
      held.release()
      expect(await service, run.stderr()).toBe(0)
    } finally {
      held.release()
      stop.abort()
      await service.catch(() => undefined)
    }
  }, 30_000)

  // 25430 witness. The supervisor writes its stop intent BEFORE the signal; the
  // service's termination handler reads it and leaves one last document naming
  // who stopped it and why, then re-raises. The port stands in for SIGTERM: a
  // real one would end the test runner.
  it("a graceful stop writes its supervisor's stop reason into the last document, then re-raises", async () => {
    const w = await world()
    const intentFile = join(mkdtempSync(join(tmpdir(), "yrd-intent-")), "intent.json")
    const at = new Date().toISOString()
    writeFileSync(intentFile, `${JSON.stringify({ verb: "stop", by: "@chief", reason: "cutover", at })}\n`)
    let terminate: (() => void) | undefined
    let reraised = 0
    const run = capture(w.work)
    const stop = new AbortController()
    const seen: QueueHealthDocument[] = []
    expect(
      await coreQueueCommand(
        w.work,
        run.io,
        {
          command: "up",
          intervalSeconds: 0,
          startedAt: at,
          stop: stop.signal,
          ...HEARTBEAT,
          terminate: {
            on: (handler) => {
              terminate = handler
              return () => {
                terminate = undefined
              }
            },
            reraise: () => {
              reraised += 1
            },
          },
          afterHealth: (document) => {
            seen.push(document)
            terminate?.()
            stop.abort()
          },
        },
        { env: { ...process.env, HAB_UNIT_INTENT_FILE: intentFile }, json: true, workdir: w.workdir },
      ),
      run.stderr(),
    ).toBe(0)

    expect(reraised).toBe(1)
    expect(terminate, "the handler unsubscribed itself before re-raising").toBeUndefined()
    // The start read the same file and found a STOP record: keyed on the verb,
    // it is not this start's reason, so the default stands.
    expect(seen[0]?.facts).toMatchObject({ serviceStarted: { reason: "started" } })
    expect(seen[0]?.facts?.serviceStarted).not.toHaveProperty("by")
    const last = JSON.parse(readFileSync(join(w.workdir, QUEUE_HEALTH_DOCUMENT), "utf8")) as QueueHealthDocument
    expect(last).toMatchObject({
      state: "absent",
      verdict: { kind: "stopped" },
      facts: {
        serviceStopped: { by: "@chief", reason: "cutover", since: at },
        why: `stopped by @chief since ${at}: cutover`,
      },
    })
    expect(last.facts).not.toHaveProperty("staleAfter")
    expect(await readQueueHealth(w.workdir, SERVICE)).toMatchObject({ state: "absent" })
  }, 30_000)

  // 25430 fix-forward (@cto 16ab7d00). A stop intent written before this process
  // started (stale from a prior run), or one with a missing or unparseable `at`,
  // is rejected as "no intent": the document records "no stop reason was recorded"
  // without falling back to `now`.
  it("a stale or unparseable stop intent writes no stop reason into the last document (25430, @cto 16ab7d00)", async () => {
    const w = await world()
    const intentFile = join(mkdtempSync(join(tmpdir(), "yrd-intent-stale-")), "intent.json")
    // Stale: written yesterday before this process started.
    const staleAt = "2026-09-23T20:00:00.000Z"
    const startedAt = new Date().toISOString()
    writeFileSync(
      intentFile,
      `${JSON.stringify({ verb: "stop", by: "@chief", reason: "yesterday maintenance", at: staleAt })}\n`,
    )
    let terminate: (() => void) | undefined
    let reraised = 0
    const run = capture(w.work)
    const stop = new AbortController()
    expect(
      await coreQueueCommand(
        w.work,
        run.io,
        {
          command: "up",
          intervalSeconds: 0,
          startedAt,
          stop: stop.signal,
          ...HEARTBEAT,
          terminate: {
            on: (handler) => {
              terminate = handler
              return () => {
                terminate = undefined
              }
            },
            reraise: () => {
              reraised += 1
            },
          },
          afterHealth: () => {
            terminate?.()
            stop.abort()
          },
        },
        { env: { ...process.env, HAB_UNIT_INTENT_FILE: intentFile }, json: true, workdir: w.workdir },
      ),
      run.stderr(),
    ).toBe(0)

    expect(reraised).toBe(1)
    const lastStale = JSON.parse(readFileSync(join(w.workdir, QUEUE_HEALTH_DOCUMENT), "utf8")) as QueueHealthDocument
    expect(lastStale).toMatchObject({
      state: "absent",
      verdict: { kind: "stopped" },
      facts: {
        why: expect.stringMatching(/^stopped since .+: no stop reason was recorded$/),
      },
    })
    expect(lastStale.facts?.serviceStopped).not.toHaveProperty("by")
    expect(lastStale.facts?.serviceStopped).not.toHaveProperty("reason")

    // Missing / unparseable at: also treated as no intent (no fallback to now)
    const stop2 = new AbortController()
    const run2 = capture(w.work)
    writeFileSync(intentFile, `${JSON.stringify({ verb: "stop", by: "@chief", reason: "no timestamp" })}\n`)
    expect(
      await coreQueueCommand(
        w.work,
        run2.io,
        {
          command: "up",
          intervalSeconds: 0,
          startedAt,
          stop: stop2.signal,
          ...HEARTBEAT,
          terminate: {
            on: (handler) => {
              terminate = handler
              return () => {
                terminate = undefined
              }
            },
            reraise: () => {
              reraised += 1
            },
          },
          afterHealth: () => {
            terminate?.()
            stop2.abort()
          },
        },
        { env: { ...process.env, HAB_UNIT_INTENT_FILE: intentFile }, json: true, workdir: w.workdir },
      ),
      run2.stderr(),
    ).toBe(0)

    const lastMissingAt = JSON.parse(
      readFileSync(join(w.workdir, QUEUE_HEALTH_DOCUMENT), "utf8"),
    ) as QueueHealthDocument
    expect(lastMissingAt).toMatchObject({
      state: "absent",
      verdict: { kind: "stopped" },
      facts: {
        why: expect.stringMatching(/^stopped since .+: no stop reason was recorded$/),
      },
    })
    expect(lastMissingAt.facts?.serviceStopped).not.toHaveProperty("by")
    expect(lastMissingAt.facts?.serviceStopped).not.toHaveProperty("reason")
  }, 30_000)

  // 25466. `hab up yrd --reason` writes the start intent before the spawn; the
  // first document this start writes names who started it and why.
  it("the first document after a start with a reason carries that start's by and reason", async () => {
    const w = await world()
    const intentFile = join(mkdtempSync(join(tmpdir(), "yrd-intent-")), "intent.json")
    const at = new Date().toISOString()
    writeFileSync(intentFile, `${JSON.stringify({ verb: "start", by: "@chief", reason: "cutover restart", at })}\n`)
    const run = capture(w.work)
    const stop = new AbortController()
    const seen: QueueHealthDocument[] = []
    expect(
      await coreQueueCommand(
        w.work,
        run.io,
        {
          command: "up",
          intervalSeconds: 0,
          startedAt: at,
          stop: stop.signal,
          ...HEARTBEAT,
          afterHealth: (document) => {
            seen.push(document)
            stop.abort()
          },
        },
        { env: { ...process.env, HAB_UNIT_INTENT_FILE: intentFile }, json: true, workdir: w.workdir },
      ),
      run.stderr(),
    ).toBe(0)

    expect(seen[0]?.facts).toMatchObject({ serviceStarted: { by: "@chief", reason: "cutover restart", since: at } })
  }, 30_000)

  // 25502. A start intent states its own freshness bound; a respawn without a
  // fresh intent reads as no intent, attributing the runner to plain "started".
  it("a respawn without a fresh intent reads as no intent (25502)", async () => {
    const w = await world()
    const intentFile = join(mkdtempSync(join(tmpdir(), "yrd-intent-")), "intent.json")
    const at = "2026-09-24T07:00:00.000Z"
    writeFileSync(
      intentFile,
      `${JSON.stringify({ verb: "start", by: "@chief", reason: "cutover restart", at, freshnessSeconds: 60 })}\n`,
    )
    const run = capture(w.work)
    const stop = new AbortController()
    const seen: QueueHealthDocument[] = []
    const respawnStartedAt = "2026-09-24T07:01:10.000Z" // 70s later > 60s bound
    expect(
      await coreQueueCommand(
        w.work,
        run.io,
        {
          command: "up",
          intervalSeconds: 0,
          startedAt: respawnStartedAt,
          stop: stop.signal,
          ...HEARTBEAT,
          afterHealth: (document) => {
            seen.push(document)
            stop.abort()
          },
        },
        { env: { ...process.env, HAB_UNIT_INTENT_FILE: intentFile }, json: true, workdir: w.workdir },
      ),
      run.stderr(),
    ).toBe(0)

    expect(seen[0]?.facts?.serviceStarted).toEqual({ reason: "started", since: respawnStartedAt })
    expect(seen[0]?.facts?.serviceStarted).not.toHaveProperty("by")
  }, 30_000)

  // T5, the stop half (F1). A line already stopped at start says so from the
  // first document: `stopped: null` for the length of round 1 would be the lie
  // the always-present stop fact exists to prevent.
  it("the first document names a stop that already stands at start", async () => {
    const w = await world()
    expect(
      await coreQueueCommand(
        w.work,
        capture(w.work).io,
        { by: "@chief", command: "pause", reason: "inspecting" },
        { workdir: w.workdir },
      ),
    ).toBe(0)
    using published = await publishedHealth(w.workdir)
    const run = capture(w.work)
    const stop = new AbortController()
    const seen: QueueHealthDocument[] = []
    const roundEnds: number[] = []
    const exit = await coreQueueCommand(
      w.work,
      run.io,
      {
        command: "up",
        intervalSeconds: 0,
        stop: stop.signal,
        ...HEARTBEAT,
        afterHealth: (document) => {
          seen.push(document)
          roundEnds.push(published.writes.length - 1)
          stop.abort()
        },
      },
      { json: true, workdir: w.workdir },
    )
    expect(exit, run.stderr()).toBe(0)
    const [roundEnd = -1] = roundEnds
    expect(roundEnd, "the recorder caught round 1's own write").toBeGreaterThanOrEqual(0)
    const stopped = { by: "@chief", cause: "operator", change: null, since: expect.any(String) }
    expect(seen[0]?.facts?.stopped).toEqual(stopped)
    const beforeRound = published.writes.slice(0, roundEnd)
    expect(beforeRound.length, "documents published before round 1 ended").toBeGreaterThan(0)
    for (const { document } of beforeRound) {
      expect(document.facts?.stopped, JSON.stringify(document)).toEqual(seen[0]?.facts?.stopped)
    }
  }, 30_000)
})

/**
 * @failure  A code host having a bad minute and a change that must never merge
 *           are recorded with the SAME reason, `yrd-setup-unusable`, so a person
 *           reading the queue cannot tell an outage from a break — and the
 *           fleet's only delivery mechanism stops on either. Measured
 *           2026-09-11: one GitHub 504 during `bun install` cost 19m47s
 *           (@i/10-yrd/24486 rows 2 and 3).
 * @level    l2 (a real remote, a clone, and a real setup command that fails)
 * @consumer whoever reads `yrd queue list` during an outage · the submitter who
 *           would otherwise go looking for a defect in their own change
 */
describe("an unreachable remote is recorded as its own reason (@i/10-yrd/24486)", () => {
  /** A setup that fails, printing whatever the test wants it to print. */
  function failingSetup(dir: string, name: string, line: string): string {
    const script = join(dir, `${name}.sh`)
    writeFileSync(script, ["#!/bin/sh", `echo '${line}' >&2`, "exit 1", ""].join("\n"))
    chmodSync(script, 0o755)
    return script
  }

  /** The stored reason for the one change in the line, as `queue list` reports it. */
  async function reasonFor(w: World, branch: string): Promise<Readonly<{ reason?: string; result?: string }>> {
    const listed = capture(w.work)
    expect(await coreQueueCommand(w.work, listed.io, { command: "list" }, { json: true, workdir: w.workdir })).toBe(0)
    const rows = (records(listed)[0] as { changes: readonly Record<string, unknown>[] }).changes
    const row = rows.find((entry) => entry.branch === branch)
    expect(row, JSON.stringify(rows)).toBeDefined()
    return { reason: row?.reason as string | undefined, result: row?.result as string | undefined }
  }

  async function roundWithSetup(w: World, branch: string, setup: string): Promise<void> {
    await redeclare(w, `setup: ${setup}\n`)
    await w.git(["checkout", "--quiet", "-b", branch, "main"])
    writeFileSync(join(w.work, "work.txt"), "work\n")
    await w.git(["add", "-A"])
    await w.git(["commit", "--quiet", "-m", branch])
    await w.git(["checkout", "--quiet", "main"])
    await submit(w.git, "origin", { branch, submitter: "@dev/4", target: { branch: "main", remote: "origin" } })
    const run = capture(w.work)
    expect(await coreQueueCommand(w.work, run.io, { command: "run" }, { workdir: w.workdir })).toBe(2)
  }

  // ROW 2. The measured specimen, reproduced: the record says the remote could
  // not be reached, and says which signature it saw.
  it("26175: says yrd-setup-unreachable, and names the signature it matched", async () => {
    const w = await world()
    const line = "error: GET https://api.github.com/repos/beorn/verify-publishable/tarball/ef92031daa - 504"
    await roundWithSetup(w, "task/upstream-504", failingSetup(w.workdir, "upstream-504", line))
    const stored = await reasonFor(w, "task/upstream-504")
    expect(stored.reason).toBe("yrd-setup-unreachable")
    // And it tells the submitter their change is not the problem, which is the
    // whole point of separating the two reasons.
    expect(String(stored.result)).toContain("nothing here is the change's fault")
    expect(String(stored.result)).toContain("http-5xx")
  })

  // ROW 3, THE NEGATIVE CONTROL, and the half that matters: a setup failure that
  // is not transport-shaped must still be billed exactly as before. A classifier
  // that is too generous does not fail loudly — it relabels real breaks as
  // outages, and then they are retried forever instead of being fixed.
  it("26175: a real break still says yrd-setup-unusable and still tells you to repair it", async () => {
    const w = await world()
    const line = "error: lockfile had changes, but lockfile is frozen"
    await roundWithSetup(w, "task/real-break", failingSetup(w.workdir, "real-break", line))
    const stored = await reasonFor(w, "task/real-break")
    expect(stored.reason).toBe("yrd-setup-unusable")
    expect(String(stored.result)).toContain("repair the queue setup")
    expect(String(stored.result)).not.toContain("nothing here is the change's fault")
  })

  // The distinction yrd already paid for one layer up, asserted here too: a
  // remote that ANSWERED 404 holds an answer, not a fault. Retrying it forever
  // would stop the queue on a component commit that never left somebody's bay.
  it("26175: a 404 is an answer, not an unreachable remote", async () => {
    const w = await world()
    const line = "error: GET https://api.github.com/repos/beorn/x/tarball/deadbeef - 404"
    await roundWithSetup(w, "task/answered-404", failingSetup(w.workdir, "answered-404", line))
    expect((await reasonFor(w, "task/answered-404")).reason).toBe("yrd-setup-unusable")
  })
})

/**
 * @failure  A stopped line has no way out but a person's hand. The fix that
 *           would unstick it waits in line BEHIND the stuck change, which a
 *           stopped line never reaches; the one verb that runs work out of turn,
 *           `yrd queue run`, takes the whole line in order; so the operator
 *           either resumes a queue that is still broken or pushes the fix around
 *           the queue.
 * @level    l2 (a real remote and a clone; the CLI driven as the shell runs it,
 *           argv in and exit code out, with the queue's workdir named inside the
 *           world)
 * @consumer the operator, who asked to "run yrd merge without even running a
 *           queue" (2026-09-16) · every seat unsticking a stopped line · every
 *           submitter whose change waits behind a stuck one
 */
describe("yrd merge, the verb beside submit (ADR-0015 decision 5)", () => {
  type Ran = Readonly<{ exitCode: YrdCliExitCode; stdout: string; stderr: string; report: string }>

  /** The CLI as the shell runs it, standing in the world's clone: argv in, exit code and both streams out. */
  async function yrd(w: World, ...args: string[]): Promise<Ran> {
    const run = capture(w.work)
    const exitCode = await runYrdProcess([process.execPath, "/usr/local/bin/yrd", ...args], run.io)
    return {
      exitCode,
      report: `yrd ${args.join(" ")} exited ${String(exitCode)}\n--- stdout ---\n${run.stdout()}\n--- stderr ---\n${run.stderr()}`,
      stderr: run.stderr(),
      stdout: run.stdout(),
    }
  }

  /**
   * This file's world with the queue's workdir named in the clone's own config,
   * so every queue command the shell runs keeps its owned clone, journal and
   * worktrees inside the world and never under the host's state directory.
   */
  async function verbWorld(eventQueue = true): Promise<World> {
    const w = await world(eventQueue)
    await w.git(["config", "yrd.workdir", w.workdir])
    return w
  }

  /** A branch off main carrying one file of its own, not submitted; answers its head. */
  async function branchWith(w: World, branch: string, file: string): Promise<string> {
    await w.git(["checkout", "--quiet", "-b", branch, "main"])
    writeFileSync(join(w.work, file), `${file}\n`)
    await w.git(["add", file])
    await w.git(["commit", "--quiet", "-m", `${branch}: ${file}`])
    const head = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])
    return head
  }

  it("resolves both spellings of one issue before merging an unsubmitted branch", async () => {
    const w = await verbWorld()
    await redeclare(
      w,
      `issueResolver: ${JSON.stringify(["sh", "-c", 'printf \'{"id":"@km/storage/26050-full"}\\n\'', "resolver"])}\n`,
    )
    await branchWith(w, "task/26050", "change.txt")
    await w.git(["checkout", "--quiet", "task/26050"])
    await w.git(["commit", "--quiet", "--allow-empty", "-m", "bind short\n\nRefs: 26050"])
    await w.git(["commit", "--quiet", "--allow-empty", "-m", "bind full\n\nRefs: @km/storage/26050-full"])
    const head = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])
    const merged = await yrd(w, "merge", "task/26050")
    expect(merged.exitCode, merged.report).toBe(0)
    expect(await onMain(w, head)).toBe(true)
  })

  /** The same branch, submitted. */
  async function submitted(w: World, branch: string, file: string): Promise<string> {
    const head = await branchWith(w, branch, file)
    await submit(w.git, "origin", { branch, submitter: "@dev/4", target: { branch: "main", remote: "origin" } })
    return head
  }

  /** The remote's main, fetched. */
  async function mainAt(w: World): Promise<string> {
    const tip = await readRemoteCommit(w.git, "origin", "refs/heads/main")
    if (tip === undefined) throw new Error("the world's remote carries no main")
    return tip
  }

  /** Whether the remote's main carries `head`: the one reading of merged that no record can fake. */
  async function onMain(w: World, head: string): Promise<boolean> {
    return (await w.git(["merge-base", head, await mainAt(w)])).trim() === head
  }

  /** The same event stop that queue list and the runner read. */
  async function stopOf(w: World): Promise<unknown> {
    const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
    const { stop } = await readEventOps(store, w.git, "main", await mainAt(w))
    return stop === undefined
      ? null
      : {
          by: stop.by,
          cause: stop.cause,
          change: stop.change === undefined ? null : `${stop.change.branch}@${stop.change.head}`,
        }
  }

  /**
   * A check the target declares at submit whose verdict the tree decides: it
   * fails (exit 1) while the tree carries `fails.txt`, cannot judge (exit 2,
   * stuck) until the tree carries `repaired.txt`, and never while the tree
   * carries `sticks-again.txt`. Every judgement appends the worktree it ran in,
   * so a case can count how often one head was judged.
   */
  function gate(w: World): Readonly<{ declaration: string; judgements: (branch: string) => number }> {
    const log = join(dirname(w.workdir), "gate-judgements.log")
    const script = join(dirname(w.workdir), "gate.sh")
    writeFileSync(log, "")
    writeFileSync(
      script,
      [
        "#!/bin/sh",
        `pwd >> "${log}"`,
        "if [ -f fails.txt ]; then echo 'this tree fails the gate' >&2; exit 1; fi",
        "if [ -f repaired.txt ] && [ ! -f sticks-again.txt ]; then exit 0; fi",
        "echo 'the gate cannot judge this tree: it needs repaired.txt and no sticks-again.txt' >&2",
        "exit 2",
        "",
      ].join("\n"),
    )
    chmodSync(script, 0o755)
    return {
      declaration: `checks:\n  - gate:\n      on: [submit]\n      run: ${script}\n`,
      judgements: (branch) =>
        readFileSync(log, "utf8")
          .split("\n")
          .filter((line) => line.includes(`/${branch.replaceAll("/", "_")}-submit-`)).length,
    }
  }

  // ACCEPTANCE: the exit is the named change's state once merge is done — 1 when
  // it ended failed, 0 when its head is on the target, 2 for anything else.
  it.each([
    { file: "fails.txt", ending: "failed", exit: 1, verdict: "fails its check" },
    { file: "cannot-judge.txt", ending: "stuck", exit: 2, verdict: "has a check that cannot judge it" },
    { file: "passes.txt", ending: "merged", exit: 0, verdict: "passes" },
  ])("a change that $verdict ends $ending, and yrd merge exits $exit", async ({ file, ending, exit }) => {
    const w = await verbWorld()
    const script = join(dirname(w.workdir), "verdict.sh")
    writeFileSync(
      script,
      [
        "#!/bin/sh",
        "if [ -f fails.txt ]; then echo 'this change fails the verdict' >&2; exit 1; fi",
        "if [ -f cannot-judge.txt ]; then echo 'the verdict cannot judge this change' >&2; exit 2; fi",
        "exit 0",
        "",
      ].join("\n"),
    )
    chmodSync(script, 0o755)
    await redeclare(w, `checks:\n  - verdict:\n      on: [submit]\n      run: ${script}\n`)
    const head = await branchWith(w, "task/judged", file)

    // Never submitted: merge opens the change itself, then judges it.
    const merged = await yrd(w, "merge", "task/judged")

    const judged = await readStatus(createEventStore(w.work, "origin", gitIn(w.work).selection), "main", "task/judged")
    expect(judged, merged.report).toMatchObject({ commit: head, status: ending })
    expect(merged.exitCode, merged.report).toBe(exit)
  })

  // ACCEPTANCE: on a line a stuck change stopped, the fix that sits BEHIND it
  // merges through every check, then the stuck head is judged exactly once more
  // on the repaired target, and its passing lifts the stop.
  it("merging the fix re-judges the stuck head once, and the stop lifts when it passes", async () => {
    const w = await verbWorld()
    const check = gate(w)
    await redeclare(w, check.declaration)
    const stuckHead = await submitted(w, "task/stuck", "stuck.txt")
    const fixHead = await branchWith(w, "task/fix", "repaired.txt")
    const stuck = await yrd(w, "queue", "run", "--json")
    expect(stuck.exitCode, stuck.report).toBe(2)
    expect(await stopOf(w)).toMatchObject({ by: "yrd", cause: "stuck", change: `task/stuck@${stuckHead}` })
    expect(check.judgements("task/stuck"), readFileSync(join(dirname(w.workdir), "gate-judgements.log"), "utf8")).toBe(
      1,
    )

    const merged = await yrd(w, "merge", "task/fix")

    expect(await onMain(w, fixHead), merged.report).toBe(true)
    expect(check.judgements("task/stuck"), merged.report).toBe(2)
    expect(await onMain(w, stuckHead), merged.report).toBe(true)
    expect(await stopOf(w)).toBeNull()
    expect(merged.exitCode, merged.report).toBe(0)
  })

  // 25687. On an event queue, yrd merge's postcondition reads the event chain
  // through the same reader as queue show (readEventListing), and a merged round
  // exits 0 naming the landing sha.
  it("on an event queue, yrd merge merges the change, exits 0, and names the landing sha in the output line (#25687)", async () => {
    const w = await verbWorld(false)
    const commit = (await w.git(["rev-parse", "main"])).trim()
    const config = await readConfig(w.git, commit, { branch: "main", remote: "origin" })
    if (config === undefined) throw new Error("the fixture's target lost its declaration")
    const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
    await createEventQueue(store, "main", commit, config, new Date())
    const head = await submitted(w, "task/event-merge", "event.txt")
    const queued = await readStatus(store, "main", "task/event-merge")
    const verifying = await appendChangeEvent(store, "main", "task/event-merge", queued.tip!, {
      type: "verifying",
      at: new Date(),
      commit: head,
    })
    await appendChangeEvent(store, "main", "task/event-merge", verifying, {
      type: "checking",
      at: new Date(),
    })
    // Advance main so the landing merge commit differs from the verified candidate head
    writeFileSync(join(w.work, "prior.txt"), "prior\n")
    await w.git(["add", "prior.txt"])
    await w.git(["commit", "--quiet", "-m", "prior"])
    await w.git(["push", "--quiet", "origin", "main"])
    // Delete local branch so inLineState must locate the standing change in checking
    await w.git(["branch", "-D", "task/event-merge"])

    const merged = await yrd(w, "merge", "task/event-merge")

    expect(merged.exitCode, merged.report).toBe(0)
    const tip = await mainAt(w)
    expect(await onMain(w, head)).toBe(true)
    expect(tip).not.toBe(head)
    expect(merged.stdout, merged.report).toContain(`task/event-merge@${head} merged at ${tip.slice(0, 12)}`)

    const again = await yrd(w, "merge", "task/event-merge")
    expect(again.exitCode, again.report).toBe(0)
    expect(again.stdout, again.report).toContain(
      `task/event-merge@${head} is already merged into origin#main; nothing to merge`,
    )

    const jsonAgain = await yrd(w, "merge", "--json", "task/event-merge")
    expect(jsonAgain.exitCode, jsonAgain.report).toBe(0)
    const parsedAgain = JSON.parse(jsonAgain.stdout) as Record<string, unknown>
    expect(parsedAgain.landing).toBe(tip)
  })

  // 25937 (P3). On an event queue, yrd merge --json for a stuck change must not report
  // a candidate commit as its landing, and the Merge trailer must not be emitted.
  it("on an event queue, yrd merge --json on a stuck change does not report a landing (#25937)", async () => {
    const w = await verbWorld(false)
    const commit = (await w.git(["rev-parse", "main"])).trim()
    const config = await readConfig(w.git, commit, { branch: "main", remote: "origin" })
    if (config === undefined) throw new Error("the fixture's target lost its declaration")
    await createEventQueue(
      createEventStore(w.work, "origin", gitIn(w.work).selection),
      "main",
      commit,
      config,
      new Date(),
    )
    const script = join(dirname(w.workdir), "verdict.sh")
    writeFileSync(
      script,
      [
        "#!/bin/sh",
        "if [ -f cannot-judge.txt ]; then echo 'the verdict cannot judge this change' >&2; exit 2; fi",
        "exit 0",
        "",
      ].join("\n"),
    )
    chmodSync(script, 0o755)
    await redeclare(w, `checks:\n  - verdict:\n      on: [submit]\n      run: ${script}\n`)
    const head = await branchWith(w, "task/event-stuck", "cannot-judge.txt")
    const merged = await yrd(w, "merge", "--json", "task/event-stuck")

    expect(merged.exitCode, merged.report).toBe(2)
    const lines = merged.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const parsed = lines.at(-1)!
    expect(parsed.state, merged.report).toBe("stuck")
    expect(parsed.landing, merged.report).toBeUndefined()
    expect("landing" in parsed, merged.report).toBe(false)
  })
})

/**
 * @failure  Two rounds run at once in one queue workdir: the service's round and
 *           a foreground `yrd queue run` or `yrd merge` beside it judge the same
 *           change twice, race each other's records and lose at the lease, and a
 *           round that lost can exit 0 having merged nothing. Exclusion was prose
 *           in a skill, never a lock (andon phase 2 plan, finding D).
 * @level    l2 (a real remote and a clone; two rounds driven concurrently through
 *           `coreQueueCommand`, sharing one workdir as the service and a
 *           foreground command do)
 * @consumer the service and every seat that runs `yrd merge` or `yrd queue run`
 *           while it is up
 */
describe("one round at a time in a queue workdir (andon phase 2, the queue lock)", () => {
  it("two rounds started together never overlap, and each merges the first change it finds", async () => {
    const w = await world()
    const root = dirname(w.workdir)
    const inside = join(root, "a-round-is-inside")
    const holds = join(root, "holds.log")
    const overlaps = join(root, "overlaps.log")
    const hold = join(root, "hold.sh")
    writeFileSync(holds, "")
    writeFileSync(overlaps, "")
    // A merge-phase check that holds its round for a while and records any other
    // round's check that arrives while it is inside.
    // The mark is a noclobber create (O_EXCL), not mkdir: this host's uutils mkdir let
    // two concurrent callers both succeed, so a real overlap could go unrecorded.
    writeFileSync(
      hold,
      [
        "#!/bin/sh",
        `pwd >> "${holds}"`,
        `if ! (set -C; : > "${inside}") 2>/dev/null; then pwd >> "${overlaps}"; exit 0; fi`,
        "sleep 3",
        `rm -f "${inside}"`,
        "exit 0",
        "",
      ].join("\n"),
    )
    chmodSync(hold, 0o755)
    await redeclare(w, `checks:\n  - hold:\n      run: ${hold}\n`)
    for (const name of ["one", "two"]) {
      await w.git(["checkout", "--quiet", "-b", `task/${name}`, "main"])
      writeFileSync(join(w.work, `${name}.txt`), `${name}\n`)
      await w.git(["add", `${name}.txt`])
      await w.git(["commit", "--quiet", "-m", name])
      await w.git(["checkout", "--quiet", "main"])
      await submit(w.git, "origin", {
        branch: `task/${name}`,
        submitter: "@dev/4",
        target: { branch: "main", remote: "origin" },
      })
    }

    const runs = [capture(w.work), capture(w.work)]
    const exits = await Promise.all(
      runs.map((run) => coreQueueCommand(w.work, run.io, { command: "run" }, { json: true, workdir: w.workdir })),
    )
    const said = runs.map((run) => `${run.stdout()}${run.stderr()}`).join("\n---\n")

    expect(readFileSync(overlaps, "utf8"), said).toBe("")
    // Positive control: each round did a round's work in turn, one merge check and one merge each.
    expect(readFileSync(holds, "utf8").split("\n").filter(Boolean), said).toHaveLength(2)
    expect(exits, said).toEqual([0, 0])
    expect(runs.flatMap((run) => (records(run)[0]?.merged ?? []) as string[]).sort(), said).toEqual([
      "task/one",
      "task/two",
    ])
  }, 60_000)

  // O1 (phase B review). A round the service waits for is someone's work, not a
  // fault: the probe reads healthy for the whole wait, past the budget included,
  // and the document says whose round it waits for.
  it("while up waits on a held lock, its health document reads healthy and its facts name the holder", async () => {
    const w = await world()
    const holder = { command: "yrd merge task/elsewhere", pid: process.pid }
    const since = new Date().toISOString()
    // A holder in this process: the flock is taken once per process, so the service below waits on it.
    const held = tryAcquireFlock(join(w.workdir, ROUND_LOCK), { body: `${JSON.stringify({ ...holder, since })}\n` })
    if (held === null) throw new Error(`the round lock in ${w.workdir} is already held`)
    const { log, rows } = logRows()
    const run = capture(w.work)
    const stop = new AbortController()
    const seen: QueueHealthDocument[] = []
    const stallMs = 50
    const service = coreQueueCommand(
      w.work,
      run.io,
      {
        command: "up",
        // Heartbeats well inside the wait, so the fact is seen to survive them.
        heartbeatIntervalMs: 100,
        heartbeatGraceMs: 500,
        intervalSeconds: 0,
        roundLockStallMs: stallMs,
        stop: stop.signal,
        afterHealth: (document) => {
          seen.push(document)
          stop.abort()
        },
      },
      { json: true, log, workdir: w.workdir },
    )
    try {
      const waiting = { holder, since, waitingSince: expect.any(String) }
      await vi.waitFor(
        async () =>
          expect((await readQueueHealth(w.workdir, SERVICE)).facts?.waitingForRoundLock, run.stderr()).toEqual(waiting),
        { timeout: 20_000 },
      )
      const readings: QueueHealthDocument[] = []
      const from = Date.now()
      while (Date.now() - from < 10 * stallMs) {
        readings.push(await readQueueHealth(w.workdir, SERVICE))
        await delay(25)
      }
      // The instrument, before anything is concluded from it: the wait did run past its budget.
      expect(rows.filter((row) => row.level === "warn" && row.message.includes("for the round lock"))).toHaveLength(1)
      expect(seen, "round 1 has not run").toHaveLength(0)
      for (const reading of readings) {
        expect(reading, JSON.stringify(reading)).toMatchObject({
          facts: { waitingForRoundLock: waiting },
          state: "healthy",
          verdict: { kind: "running" },
        })
        expect(reading.error, JSON.stringify(reading)).toBeUndefined()
      }

      held.release()
      expect(await service, run.stderr()).toBe(0)
      // The round it waited for ran, and that round's document names no wait.
      expect(seen).toHaveLength(1)
      expect(seen[0]?.facts, JSON.stringify(seen[0])).not.toHaveProperty("waitingForRoundLock")
    } finally {
      held.release()
      stop.abort()
      await service.catch(() => undefined)
    }
  }, 30_000)

  // THE SCENARIO THE LOCK IS FOR: the service is inside a round with a slow
  // merge check, and a person merges another change beside it. The merge waits
  // and names what it waits on, runs its round only once the service's round has
  // ended, and its change is on the target before the service's next round
  // begins. The service's hook awaits the merge: the service released its lock
  // before the hook, and cannot start its next round until the hook returns.
  it("a yrd merge beside the service waits out the service's round, and lands before the service's next one", async () => {
    const w = await world()
    await w.git(["config", "yrd.workdir", w.workdir])
    const root = dirname(w.workdir)
    const holding = join(root, "the-service-round-holds")
    const entered = join(root, "the-slow-check-entered")
    const slow = join(root, "slow.sh")
    // A merge-phase check that holds the round merging task/first while `holding`
    // exists, and says it began; every other merge it passes at once.
    writeFileSync(
      slow,
      [
        "#!/bin/sh",
        "[ -f first.txt ] || exit 0",
        `touch "${entered}"`,
        ...waitingFor(`[ -f "${holding}" ]`, "slow check: the test never stopped holding this round; giving up"),
        "exit 0",
        "",
      ].join("\n"),
    )
    chmodSync(slow, 0o755)
    writeFileSync(holding, "")
    await redeclare(w, `checks:\n  - slow:\n      run: ${slow}\n`)
    const heads = new Map<string, string>()
    for (const name of ["first", "second"]) {
      await w.git(["checkout", "--quiet", "-b", `task/${name}`, "main"])
      writeFileSync(join(w.work, `${name}.txt`), `${name}\n`)
      await w.git(["add", `${name}.txt`])
      await w.git(["commit", "--quiet", "-m", name])
      heads.set(name, (await w.git(["rev-parse", "HEAD"])).trim())
      await w.git(["checkout", "--quiet", "main"])
    }
    await submit(w.git, "origin", {
      branch: "task/first",
      submitter: "@dev/4",
      target: { branch: "main", remote: "origin" },
    })
    const second = heads.get("second") ?? ""
    const carries = async (commit: string, head: string): Promise<boolean> =>
      (await w.git(["merge-base", head, commit])).trim() === head

    // The service where `yrd merge` finds it: the queue's own clone and workdir.
    const location = await resolveQueueLocation(w.work, undefined, process.env)
    const stop = new AbortController()
    const service = capture(w.work)
    const merge = capture(w.work)
    // Assigned after `up` is listening; prefer-const cannot see that write.
    // eslint-disable-next-line prefer-const -- reassigned at merge spawn
    let merging: Promise<YrdCliExitCode> | undefined
    const rounds: QueueRunOutcome[] = []
    let merged: YrdCliExitCode | undefined
    let landedBeforeNextRound: boolean | undefined
    const running = coreQueueCommand(
      location.repo,
      service.io,
      {
        afterRound: async (outcome) => {
          rounds.push(outcome)
          if (rounds.length === 1) {
            merged = await merging
            const tip = await readRemoteCommit(w.git, "origin", "refs/heads/main")
            landedBeforeNextRound = tip !== undefined && (await carries(tip, second))
          } else {
            stop.abort()
          }
        },
        command: "up",
        // Long, so the service's own cadence is never what lets the merge in.
        intervalSeconds: 3600,
        stop: stop.signal,
      },
      {
        json: true,
        populateReference: location.owned,
        queue: location.queue,
        selection: location.selection,
        workdir: location.workdir,
      },
    )

    // The service's round is inside its slow merge check, holding the lock.
    await vi.waitFor(() => expect(existsSync(entered), service.stderr()).toBe(true), { timeout: 20_000 })
    let settled = false
    merging = runYrdProcess([process.execPath, "/usr/local/bin/yrd", "merge", "task/second"], merge.io).finally(() => {
      settled = true
    })
    await vi.waitFor(
      () => expect(settled || merge.stderr().includes("waiting for the round lock"), merge.stderr()).toBe(true),
      { timeout: 20_000 },
    )
    const said = (): string =>
      `--- service ---\n${service.stdout()}${service.stderr()}\n--- merge ---\n${merge.stdout()}${merge.stderr()}`
    // Waiting, not merged beside the service's round, and saying whom it waits on.
    expect(settled, said()).toBe(false)
    expect(merge.stderr()).toMatch(/waiting for the round lock in .+: pid \d+ \(.+\) has held it since \d{4}-/u)
    const tip = await readRemoteCommit(w.git, "origin", "refs/heads/main")
    expect(tip !== undefined && (await carries(tip, second)), said()).toBe(false)

    rmSync(holding)
    expect(await running, said()).toBe(0)
    expect(
      rounds.map((round) => round.merged),
      said(),
    ).toEqual([["task/first"], []])
    expect(merged, said()).toBe(0)
    expect(landedBeforeNextRound, said()).toBe(true)
    // The service's next round judged a target that already carried the merge.
    expect(await carries(rounds[1]?.base ?? "", second), said()).toBe(true)
  }, 60_000)
})

describe("yrd queue run --tier long", () => {
  it("continues after exit 1 so younger deferred changes judge and merge when older fails", async () => {
    const w = await world()
    const checkScript = join(w.workdir, "tier-check.sh")
    writeFileSync(
      checkScript,
      [
        "#!/bin/sh",
        'if [ "$YRD_CHECK_TIER" != "long" ]; then',
        '  echo \'YRD-CHECK-RESULT {"result":"deferred","reason":"too wide","projectedMs":3600000,"boundMs":1800000}\'',
        "  exit 3",
        "fi",
        "if [ -f fail-in-long.txt ]; then",
        "  exit 1",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    )
    chmodSync(checkScript, 0o755)

    await redeclare(
      w,
      [
        "checks:",
        "  - tier-check:",
        `      run: ${checkScript}`,
        "      timeoutMs: 1800000",
        "      long:",
        "        timeoutMs: 5400000",
        "",
      ].join("\n"),
    )

    await w.git(["checkout", "--quiet", "-b", "task/older", "main"])
    writeFileSync(join(w.work, "fail-in-long.txt"), "fail\n")
    await w.git(["add", "fail-in-long.txt"])
    await w.git(["commit", "--quiet", "-m", "older change"])
    await w.git(["checkout", "--quiet", "main"])
    await submit(w.git, "origin", {
      branch: "task/older",
      submitter: "@dev/1",
      target: { branch: "main", remote: "origin" },
    })

    await w.git(["checkout", "--quiet", "-b", "task/younger", "main"])
    writeFileSync(join(w.work, "pass-in-long.txt"), "pass\n")
    await w.git(["add", "pass-in-long.txt"])
    await w.git(["commit", "--quiet", "-m", "younger change"])
    await w.git(["checkout", "--quiet", "main"])
    await submit(w.git, "origin", {
      branch: "task/younger",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })

    const normalRun = capture(w.work)
    expect(await coreQueueCommand(w.work, normalRun.io, { command: "run" }, { json: true, workdir: w.workdir })).toBe(0)
    expect((records(normalRun)[0] as { deferred: string[] }).deferred.sort()).toEqual(["task/older", "task/younger"])

    const listed = capture(w.work)
    expect(await coreQueueCommand(w.work, listed.io, { command: "list" }, { json: true, workdir: w.workdir })).toBe(0)
    const rows = (records(listed)[0] as { changes: readonly Record<string, unknown>[] }).changes.filter(
      (r) => r.branch !== "main",
    )
    // Deferred is a queued change with a visible reason in the event model.
    expect(
      rows.map((r) => [r.branch, r.state, String(r.reason).includes("deferred"), r.malformed === undefined]).sort(),
    ).toEqual([
      ["task/older", "queued", true, true],
      ["task/younger", "queued", true, true],
    ])

    const longRun = capture(w.work)
    const exitCode = await coreQueueCommand(
      w.work,
      longRun.io,
      { command: "run", tier: "long" },
      { json: true, workdir: w.workdir },
    )
    expect(exitCode).toBe(1)

    const listedAfter = capture(w.work)
    expect(
      await coreQueueCommand(w.work, listedAfter.io, { command: "list" }, { json: true, workdir: w.workdir }),
    ).toBe(0)
    const rowsAfter = (records(listedAfter)[0] as { changes: readonly Record<string, unknown>[] }).changes
    const olderRow = rowsAfter.find((r) => r.branch === "task/older")
    const youngerRow = rowsAfter.find((r) => r.branch === "task/younger")
    expect(olderRow?.state).toBe("failed")
    expect(youngerRow?.state).toBe("merged")
  })
})
