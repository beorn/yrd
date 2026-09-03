/**
 * @failure  The service (`yrd queue up`) reads the target's declaration once,
 *           at start, and runs every later round on that reading: an edit at
 *           the target — a check added, a key mistyped, the switch removed —
 *           takes effect only after a hand restart, and a correct edit looks
 *           like a wrong one until then. And when the change it merges is the
 *           one that moves its own pin, it keeps running the old code against
 *           a target that pins the new: the relaunch onto the new pin is a
 *           person's hand again (plan § Commands: the service's three exits;
 *           § Milestones M7).
 * @level    l2 (a real remote and a clone under a temporary root;
 *           `coreQueueCommand` driven directly, no process boundary)
 * @consumer hab, which runs `yrd queue up` as the service and relaunches it on
 *           a pin-move exit · the mechanic, who edits the target's declaration and
 *           expects the next round to read it
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { gitIn, submit, type Git } from "@yrd/queue-core"
import { createLogger, type ConditionalLogger, type Event } from "loggily"
import { coreQueueCommand } from "../src/queue-core-commands.ts"
import type { YrdCliIO } from "../src/types.ts"

// A component at a local path: git refuses file transport for submodule clones
// unless every git in the chain is told. Every git runner below and the
// queue's own git children read this process's environment when they are
// made, so it is said here, first.
process.env.GIT_CONFIG_COUNT = "1"
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow"
process.env.GIT_CONFIG_VALUE_0 = "always"

const roots: string[] = []

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
      write: (event: Event) => {
        if (event.kind === "log") rows.push({ level: event.level, message: event.message })
      },
    },
  ])
  return { log, rows }
}

const DECLARATION = "target: origin#main\n"

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
async function world(): Promise<World> {
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

type PinnedWorld = World &
  Readonly<{
    /** The component's commit the root pins at start. */
    a: string
    /** The component's next commit, on its main; the root does not pin it yet. */
    b: string
  }>

/**
 * A component whose main is `a` then `b`; a root whose main pins the component
 * at `a`. Modelled on the queue core's own gitlink case: `b` is on the
 * component's main, so the built-in gitlink check passes a change that pins it.
 */
async function pinnedWorld(): Promise<PinnedWorld> {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-up-pin-"))
  roots.push(root)
  const seed = gitIn(root)

  const component = join(root, "component.git")
  const componentWork = join(root, "component-work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", component])
  await seed(["clone", "--quiet", component, componentWork])
  const cg = gitIn(componentWork)
  await identity(cg)
  await cg(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(componentWork, "lib.txt"), "a\n")
  await cg(["add", "lib.txt"])
  await cg(["commit", "--quiet", "-m", "a"])
  const a = (await cg(["rev-parse", "HEAD"])).trim()
  await cg(["push", "--quiet", "origin", "main"])

  const remote = join(root, "remote.git")
  const work = join(root, "work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await identity(git)
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, ".yrd.yml"), DECLARATION)
  // The root pins the component at its main as it stands now: `a`.
  await git(["submodule", "add", "--quiet", component, "component"])
  await git(["add", ".yrd.yml", ".gitmodules", "component"])
  await git(["commit", "--quiet", "-m", "main, with the component at a"])
  await git(["push", "--quiet", "origin", "main"])

  // The component's main moves on to `b`; the root still pins `a`.
  writeFileSync(join(componentWork, "lib.txt"), "b\n")
  await cg(["commit", "--quiet", "-am", "b"])
  const b = (await cg(["rev-parse", "HEAD"])).trim()
  await cg(["push", "--quiet", "origin", "main"])

  const workdir = join(root, "queue")
  mkdirSync(workdir, { recursive: true })
  return { a, b, git, work, workdir }
}

/** A change that moves the component's pin to `sha`, submitted to the queue. */
async function submitPin(w: PinnedWorld, branch: string, sha: string): Promise<void> {
  await w.git(["checkout", "--quiet", "-b", branch, "main"])
  const sub = gitIn(join(w.work, "component"))
  await sub(["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"])
  await sub(["checkout", "--quiet", sha])
  await w.git(["add", "component"])
  await w.git(["commit", "--quiet", "-m", `pin the component at ${sha.slice(0, 12)}`])
  await w.git(["checkout", "--quiet", "main"])
  await submit(w.git, "origin", { branch, submitter: "@dev/2", target: { branch: "main", remote: "origin" } })
}

/** This checkout's own commit: what the service finds when nothing names the pin. */
async function thisCheckout(): Promise<string> {
  return (await gitIn(resolve(import.meta.dirname, "../../.."))(["rev-parse", "--verify", "HEAD^{commit}"])).trim()
}

const STUCK = { exitCode: 2, failed: [], merged: [], stuck: [] }

describe("yrd queue up, the service", () => {
  it("reads the target's declaration again every round: a key the target's edit mistyped ends it stuck, naming the key", async () => {
    const w = await world()
    const run = capture(w.work)
    let rounds = 0

    const exit = await coreQueueCommand(
      w.work,
      run.io,
      {
        afterRound: async () => {
          rounds += 1
          if (rounds === 1) await redeclare(w, `${DECLARATION}batch: 1\n`)
        },
        command: "up",
        intervalSeconds: 0,
      },
      { json: true, workdir: w.workdir },
    )

    expect(exit, run.stdout()).toBe(2)
    // The second round never ran: the declaration is read before it, not after.
    expect(rounds).toBe(1)
    const written = records(run)
    expect(written).toHaveLength(2)
    expect(written[0]).toMatchObject({ exitCode: 0, merged: [] })
    expect(written[1]).toEqual({ ...STUCK, why: expect.stringContaining("batch") as string })
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

  it("ends the loop, exit 0, when the round it ran merged the change that moves its own pin", async () => {
    const w = await pinnedWorld()
    await submitPin(w, "task/pin", w.b)
    const run = capture(w.work)

    const exit = await coreQueueCommand(
      w.work,
      run.io,
      { command: "up", intervalSeconds: 0, pin: { path: "component", sha: w.a } },
      { json: true, workdir: w.workdir },
    )

    // Zero, not 18: hab reads every non-zero exit as a crash and spends a
    // restart budget on it, and a pin advance is the one thing the service is
    // MEANT to end for.
    expect(exit, run.stdout()).toBe(0)
    const written = records(run)
    expect(written).toHaveLength(2)
    expect(written[0]).toMatchObject({ exitCode: 0, merged: ["task/pin"] })
    expect(written[1]).toEqual({ exitCode: 0, from: w.a, pin: "component", reason: "pin-moved", to: w.b })
    // The target really moved the pin: the exit reports the world, not the request.
    expect((await w.git(["ls-tree", "origin/main", "--", "component"])).trim()).toBe(`160000 commit ${w.b}\tcomponent`)
  })

  it("a signal ends it, exit 0; and with no pin named, it finds its own commit and says the target pins no gitlink at it", async () => {
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
    // The pin exit is off in this world, said once at info with the commit it
    // looked for: this suite's own checkout, which the world's target does not pin.
    const commit = await thisCheckout()
    expect(rows.filter((row) => row.message.startsWith("the pin exit is off"))).toEqual([
      {
        level: "info",
        message: `the pin exit is off: the target pins no gitlink at this yrd's commit ${commit.slice(0, 12)}`,
      },
    ])
  })
})

describe("yrd queue list, the table", () => {
  it("a commit the target gained around the queue is a row of its own, in the JSON and on the line (E5)", async () => {
    const w = await world()
    // The queue's history starts at its first fact, so there is one change
    // before the bypass: a queue that has judged nothing has no history
    // and reports nothing (by-hand.ts).
    await w.git(["checkout", "--quiet", "-b", "task/first", "main"])
    writeFileSync(join(w.work, "first.txt"), "first\n")
    await w.git(["add", "first.txt"])
    await w.git(["commit", "--quiet", "-m", "task/first"])
    await w.git(["checkout", "--quiet", "main"])
    await submit(w.git, "origin", { branch: "task/first", submitter: "@dev/2", target: { branch: "main", remote: "origin" } })
    // The target moves around the queue: one commit after that, pushed.
    writeFileSync(join(w.work, "hand.txt"), "hand\n")
    await w.git(["add", "hand.txt"])
    await w.git(["commit", "--quiet", "-m", "hand.txt around the queue"])
    await w.git(["push", "--quiet", "origin", "main"])
    const hand = (await w.git(["rev-parse", "HEAD"])).trim()
    const sentence = `main moved around the queue at ${hand.slice(0, 12)} (hand.txt around the queue)`

    const asJson = capture(w.work)
    expect(await coreQueueCommand(w.work, asJson.io, { command: "list" }, { json: true, workdir: w.workdir })).toBe(0)
    const listed = records(asJson)[0] as Readonly<{ changes: readonly Record<string, unknown>[] }>
    expect(listed.changes).toMatchObject([
      { branch: "task/first", state: "queued" },
      { branch: "main", head: hand, reason: sentence, state: "bypass" },
    ])

    const asText = capture(w.work)
    expect(await coreQueueCommand(w.work, asText.io, { command: "list" }, { workdir: w.workdir })).toBe(0)
    expect(asText.stdout()).toContain(`   bypass  main ${hand.slice(0, 12)} ${sentence}\n`)
  })
})
