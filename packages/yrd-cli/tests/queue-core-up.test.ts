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

import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { appendRecord, changeRef, gitIn, readRecords, submit, trailer, type Git } from "@yrd/queue-core"
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
      write: (entry: Event) => {
        if (entry.kind === "log") rows.push({ level: entry.level, message: entry.message })
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

type GitlinkWorld = World &
  Readonly<{
    /** The component's commit the root records at start. */
    a: string
    /** The component's next commit, on its main; the root does not record it yet. */
    b: string
    /** The real CLI loaded from this world's component, not an injected gitlink. */
    command: typeof coreQueueCommand
  }>

/**
 * A component whose main is `a` then `b`; a root whose main records the component
 * at `a`. Modelled on the queue core's own gitlink case: `b` is on the
 * component's main, so candidate settling accepts a change that records it.
 */
async function gitlinkWorld(sourceReadFailure = false): Promise<GitlinkWorld> {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-up-gitlink-"))
  roots.push(root)
  const seed = gitIn(root)

  const component = join(root, "component.git")
  const componentWork = join(root, "component-work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", component])
  await seed(["clone", "--quiet", component, componentWork])
  const cg = gitIn(componentWork)
  await identity(cg)
  await cg(["checkout", "--quiet", "-b", "main"])
  cpSync(resolve(import.meta.dirname, "../src"), join(componentWork, "packages/yrd-cli/src"), { recursive: true })
  writeFileSync(join(componentWork, "lib.txt"), "a\n")
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
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, ".yrd.yml"), DECLARATION)
  // The root records the component at its main as it stands now: `a`.
  await git(["submodule", "add", "--quiet", component, "component"])
  await git(["add", ".yrd.yml", ".gitmodules", "component"])
  await git(["commit", "--quiet", "-m", "main, with the component at a"])
  await git(["push", "--quiet", "origin", "main"])

  // The component's main moves on to `b`; the root still records `a`.
  writeFileSync(join(componentWork, "lib.txt"), "b\n")
  await cg(["commit", "--quiet", "-am", "b"])
  const b = (await cg(["rev-parse", "HEAD"])).trim()
  await cg(["push", "--quiet", "origin", "main"])

  const workdir = join(root, "queue")
  mkdirSync(workdir, { recursive: true })
  const cli = join(work, "component/packages/yrd-cli")
  symlinkSync(resolve(import.meta.dirname, "../node_modules"), join(cli, "node_modules"), "dir")
  if (sourceReadFailure) {
    // Leave real source files readable but make HEAD unborn: rev-parse must
    // fail, not turn an embedded service into an unchecked standalone one.
    await gitIn(join(work, "component"))(["symbolic-ref", "HEAD", "refs/heads/unborn-runtime"])
  }
  const { coreQueueCommand: command } = await import(join(cli, "src/queue-core-commands.ts"))
  return { a, b, command, git, work, workdir }
}

/** A change that moves the component's gitlink to `sha`, submitted to the queue. */
async function submitGitlink(w: GitlinkWorld, branch: string, sha: string): Promise<void> {
  await w.git(["checkout", "--quiet", "-b", branch, "main"])
  const sub = gitIn(join(w.work, "component"))
  await sub(["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"])
  await sub(["checkout", "--quiet", sha])
  await w.git(["add", "component"])
  await w.git(["commit", "--quiet", "-m", `move the component gitlink to ${sha.slice(0, 12)}`])
  await w.git(["checkout", "--quiet", "main"])
  await submit(w.git, "origin", { branch, submitter: "@dev/2", target: { branch: "main", remote: "origin" } })
}

const STUCK = { exitCode: 2, failed: [], merged: [], stuck: [] }

describe("yrd queue up, the service", () => {
  it("stays alive through pause and two consecutive merges after resume (24096)", async () => {
    const w = await world()
    const heads = new Map<string, string>()
    // The notifier runs after the atomic merge and before its sent record.
    // A second writer at the real remote wins that interval for each merge.
    const remote = (await w.git(["remote", "get-url", "origin"])).trim()
    await identity(gitIn(remote))
    const rival = join(w.work, "..", "notify-rival.ts")
    writeFileSync(
      rival,
      `
import { appendRecord, gitIn, parseChangeName, readRecords } from ${JSON.stringify(resolve(import.meta.dirname, "../../yrd-queue-core/src/index.ts"))}
const change = parseChangeName(JSON.parse(await Bun.stdin.text()).change)
if (!change) throw new Error("notifier received no change")
const git = gitIn(${JSON.stringify(remote)})
const tip = (await readRecords(git, change)).at(-1)
if (!tip || tip.kind !== "merged") throw new Error("notifier ran before the merge record landed")
await appendRecord(git, { change, kind: "merged", subject: "another observer recorded the merge", target: "origin#main", trailers: tip.trailers })
`,
    )
    await redeclare(
      w,
      `${DECLARATION}notify:\n  - rival:\n      on: [merged]\n      run: ${JSON.stringify(`bun '${rival}'`)}\n`,
    )
    // One service invocation must survive its first merge's bookkeeping and
    // reach the next admitted change, not merely return success for one round.
    for (const name of ["one", "two"]) {
      await w.git(["checkout", "--quiet", "-b", `task/${name}`, "main"])
      writeFileSync(join(w.work, `${name}.txt`), `${name}\n`)
      await w.git(["add", `${name}.txt`])
      await w.git(["commit", "--quiet", "-m", name])
      heads.set(name, (await w.git(["rev-parse", "HEAD"])).trim())
      await w.git(["checkout", "--quiet", "main"])
      await submit(w.git, "origin", {
        branch: `task/${name}`,
        submitter: "@dev/2",
        target: { branch: "main", remote: "origin" },
      })
    }
    expect(
      await coreQueueCommand(
        w.work,
        capture(w.work).io,
        { by: "@chief", command: "pause", reason: "repair main" },
        { workdir: w.workdir },
      ),
    ).toBe(0)

    const stop = new AbortController()
    let rounds = 0
    const service = capture(w.work)
    const { log, rows } = logRows()
    expect(
      await coreQueueCommand(
        w.work,
        service.io,
        {
          command: "up",
          intervalSeconds: 0,
          stop: stop.signal,
          afterRound: async () => {
            rounds += 1
            if (rounds === 1) {
              await coreQueueCommand(
                w.work,
                capture(w.work).io,
                { by: "@chief", command: "resume", reason: "repair landed" },
                { workdir: w.workdir },
              )
            } else if (rounds === 3) {
              stop.abort()
            }
          },
        },
        { json: true, log, workdir: w.workdir },
      ),
    ).toBe(0)
    expect(rounds).toBe(3)
    expect(records(service)[0]).toMatchObject({
      exitCode: 0,
      merged: [],
      stopped: { ring: "pause", what: { kind: "paused" } },
    })
    expect(records(service)[1]).toMatchObject({ exitCode: 0, merged: ["task/one"] })
    expect(records(service)[2]).toMatchObject({ exitCode: 0, merged: ["task/two"] })
    for (const name of ["one", "two"]) {
      expect((await w.git(["show", `origin/main:${name}.txt`])).trim()).toBe(name)
      const head = heads.get(name)
      if (head === undefined) throw new Error(`no submitted head for ${name}`)
      const change = { branch: `task/${name}`, head }
      const ref = changeRef(change)
      await w.git(["fetch", "--quiet", "origin", `+${ref}:${ref}`])
      const history = await readRecords(w.git, change)
      expect(history.map((record) => record.kind)).toEqual(["opened", "checked", "merged", "merged", "sent"])
      expect(trailer(history[4]!, "State")).toBe("merged")
      const merge = trailer(history[2]!, "Merge")
      expect(merge).toMatch(/^[0-9a-f]{40}$/u)
      await w.git(["merge-base", "--is-ancestor", merge!, "origin/main"])
      const warning = rows.find((row) => row.level === "warn" && row.message.startsWith(`${ref}:`))
      expect(warning?.message).toMatch(/remote [0-9a-f]{40}, intended [0-9a-f]{40} \(diverged\); inspect: git -C /u)
    }
  })

  it("pause is visible, refuses live and dry-run submit, and resume admits the same branch", async () => {
    const w = await world()
    await w.git(["checkout", "--quiet", "-b", "task/one", "main"])
    writeFileSync(join(w.work, "one.txt"), "one\n")
    await w.git(["add", "one.txt"])
    await w.git(["commit", "--quiet", "-m", "one"])
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
    expect(records(opened)[0]).toMatchObject({ by: "@chief", kind: "paused", reason: "49 new failures on main" })

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
      const refused = capture(w.work)
      expect(
        await coreQueueCommand(
          w.work,
          refused.io,
          { branch: "task/one", command: "submit", dryRun, submitter: "@dev/2" },
          { workdir: w.workdir },
        ),
      ).toBe(1)
      expect(refused.stderr()).toContain("paused by @chief")
      expect(refused.stderr()).toContain("49 new failures on main")
      expect(refused.stderr()).toContain("yrd queue resume")
    }
    expect(await w.git(["ls-remote", "--heads", "origin", "task/one"])).toBe("")

    const listed = capture(w.work)
    expect(await coreQueueCommand(w.work, listed.io, { command: "list" }, { workdir: w.workdir })).toBe(0)
    expect(listed.stdout().split("\n")[0]).toContain("paused by @chief")
    const listedJson = capture(w.work)
    expect(await coreQueueCommand(w.work, listedJson.io, { command: "list" }, { json: true, workdir: w.workdir })).toBe(
      0,
    )
    expect(records(listedJson)[0]).toMatchObject({
      changes: [],
      pause: { by: "@chief", kind: "paused", reason: "49 new failures on main" },
    })

    const closed = capture(w.work)
    expect(
      await coreQueueCommand(
        w.work,
        closed.io,
        { by: "@chief", command: "resume", reason: "repair landed" },
        { workdir: w.workdir },
      ),
    ).toBe(0)
    const submitted = capture(w.work)
    expect(
      await coreQueueCommand(
        w.work,
        submitted.io,
        { branch: "task/one", command: "submit", submitter: "@dev/2" },
        { workdir: w.workdir },
      ),
    ).toBe(0)
    const listedResumed = capture(w.work)
    expect(
      await coreQueueCommand(w.work, listedResumed.io, { command: "list" }, { json: true, workdir: w.workdir }),
    ).toBe(0)
    const resumedList = records(listedResumed)[0]
    expect(resumedList).toMatchObject({ changes: [{ branch: "task/one" }], pause: null })
    const beforeRetry = await w.git(["ls-remote", "--refs", "origin", "refs/yrd/changes/*"])
    const pausedAgain = capture(w.work)
    expect(
      await coreQueueCommand(
        w.work,
        pausedAgain.io,
        { by: "@chief", command: "pause", reason: "retry must wait too" },
        { workdir: w.workdir },
      ),
    ).toBe(0)
    const listedPausedAgain = capture(w.work)
    expect(
      await coreQueueCommand(w.work, listedPausedAgain.io, { command: "list" }, { json: true, workdir: w.workdir }),
    ).toBe(0)
    const pausedAgainList = records(listedPausedAgain)[0]
    expect(pausedAgainList).toMatchObject({
      pause: { by: "@chief", kind: "paused", reason: "retry must wait too" },
    })
    expect(pausedAgainList?.changes).toEqual(resumedList?.changes)
    const retried = capture(w.work)
    expect(
      await coreQueueCommand(
        w.work,
        retried.io,
        { branch: "task/one", command: "submit", submitter: "@dev/2" },
        { workdir: w.workdir },
      ),
    ).toBe(1)
    expect(retried.stderr()).toContain("retry must wait too")
    expect(await w.git(["ls-remote", "--refs", "origin", "refs/yrd/changes/*"])).toBe(beforeRetry)
  })

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

  it("ends the loop, exit 0, when the round it ran merged the change that moves its own gitlink", async () => {
    const w = await gitlinkWorld()
    await submitGitlink(w, "task/gitlink", w.b)
    await gitIn(join(w.work, "component"))(["checkout", "--quiet", w.a])
    const run = capture(w.work)

    const exit = await w.command(
      w.work,
      run.io,
      {
        command: "up",
        intervalSeconds: 0,
        afterRound: async () => {
          await w.git(["merge", "--ff-only", "origin/main"])
          await gitIn(join(w.work, "component"))(["checkout", "--quiet", w.b])
        },
      },
      { json: true, workdir: w.workdir },
    )

    // Zero, not 18: hab reads every non-zero exit as a crash and spends a
    // restart budget on it, and a gitlink advance is the one thing the service is
    // MEANT to end for.
    expect(exit, run.stdout()).toBe(0)
    const written = records(run)
    expect(written).toHaveLength(2)
    expect(written[0]).toMatchObject({ exitCode: 0, merged: ["task/gitlink"] })
    expect(written[1]).toEqual({ exitCode: 0, from: w.a, gitlink: "component", reason: "gitlink-moved", to: w.b })
    // The target really moved the gitlink: the exit reports the world, not the request.
    expect((await w.git(["ls-tree", "origin/main", "--", "component"])).trim()).toBe(`160000 commit ${w.b}\tcomponent`)
  })

  it.each(["stop", "project", "already projected"])("runs no stale round during checkout lag (%s)", async (ending) => {
    const w = await gitlinkWorld()
    // The recorded target moves first; the process still loads a from its checkout.
    await w.git(["update-index", "--cacheinfo", "160000", w.b, "component"])
    await w.git(["commit", "--quiet", "-m", "target records b before local projection"])
    await w.git(["push", "--quiet", "origin", "main"])
    const run = capture(w.work)
    const stop = new AbortController()
    const { log, rows } = logRows()
    let rounds = 0
    const project = async () => {
      const sub = gitIn(join(w.work, "component"))
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
      { json: true, log, workdir: w.workdir },
    )
    try {
      if (ending !== "already projected") {
        await vi.waitFor(() => expect(run.stdout()).toContain("waiting for checkout"))
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
    expect(rows.some((row) => row.message.startsWith("the gitlink exit is off"))).toBe(false)
    expect(run.stdout()).toContain(w.a)
    expect(run.stdout()).toContain(w.b)
    if (ending !== "stop") {
      expect(records(run).at(-1)).toEqual({
        exitCode: 0,
        from: w.a,
        gitlink: "component",
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

  it("a standalone runtime runs normally and explicitly names the checkout outside this queue", async () => {
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
    // This CLI is outside the world's queue checkout, not an embedded stale pin.
    expect(rows.filter((row) => row.message.startsWith("the gitlink exit is off"))).toEqual([
      {
        level: "info",
        message: `the gitlink exit is off: runtime checkout ${resolve(import.meta.dirname, "../../..")} is not embedded in queue checkout ${w.work}`,
      },
    ])
  })
})

describe("yrd queue list, the table", () => {
  it("renders one stored lossless incident compactly in list and fully in show", async () => {
    const w = await world()
    await w.git(["checkout", "--quiet", "-b", "task/incident", "main"])
    writeFileSync(join(w.work, "incident.txt"), "incident\n")
    await w.git(["add", "incident.txt"])
    await w.git(["commit", "--quiet", "-m", "incident specimen"])
    const head = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])
    const change = { branch: "task/incident", head }
    await submit(w.git, "origin", {
      branch: change.branch,
      submitter: "@dev/3",
      target: { branch: "main", remote: "origin" },
    })
    const evidence = join(w.workdir, "incident", "q-lossless.jsonl")
    mkdirSync(join(w.workdir, "incident"), { recursive: true })
    writeFileSync(evidence, '{"kind":"change","decision":"stuck"}\n')
    const subject = `verify could not decide ${"x".repeat(450)}THE-END-OF-THE-INCIDENT`
    const incident = {
      code: "yrd-check-unresolved",
      subject,
      via: "verify during merge in yrd queue test [q-lossless]",
      evidence,
      next: "repair verify or its queue environment, then run yrd queue run",
      owner: "the queue operator",
    }
    const incidentTrailers = [
      ["Code", incident.code],
      ["Subject", incident.subject],
      ["Via", incident.via],
      ["Evidence", incident.evidence],
      ["Next", incident.next],
      ["Owner", incident.owner],
    ] as const
    const ended = await appendRecord(w.git, {
      change,
      kind: "stuck",
      subject,
      target: "origin#main",
      trailers: incidentTrailers,
    })
    await appendRecord(w.git, {
      change,
      kind: "sent",
      subject: "logged the incident",
      target: "origin#main",
      trailers: [["State", "stuck"], ["For", ended], ["To", "none"], ["Delivery", "none"], ...incidentTrailers],
    })
    await w.git(["push", "--quiet", "origin", `${changeRef(change)}:${changeRef(change)}`])

    const listedJson = capture(w.work)
    expect(await coreQueueCommand(w.work, listedJson.io, { command: "list" }, { json: true, workdir: w.workdir })).toBe(
      0,
    )
    const listed = records(listedJson)[0] as Readonly<{ changes: readonly Record<string, unknown>[] }>
    expect(listed.changes[0]).toMatchObject({ incident, reason: incident.code, state: "stuck" })
    expect(String(listed.changes[0]?.result)).toContain("THE-END-OF-THE-INCIDENT")

    const listedText = capture(w.work)
    expect(await coreQueueCommand(w.work, listedText.io, { command: "list" }, { workdir: w.workdir })).toBe(0)
    expect(listedText.stdout()).toContain("THE-END-OF-THE-INCIDENT")
    const listedLine = listedText
      .stdout()
      .split("\n")
      .find((line) => line.includes("task/incident"))
    expect(listedLine, listedText.stdout()).toBeDefined()
    expect(listedLine?.match(/\bstuck\b/gu), listedText.stdout()).toHaveLength(1)

    const shownJson = capture(w.work)
    expect(
      await coreQueueCommand(
        w.work,
        shownJson.io,
        { command: "show", branch: change.branch },
        { json: true, workdir: w.workdir },
      ),
    ).toBe(0)
    const shown = records(shownJson)[0] as Readonly<{ changes: readonly Record<string, unknown>[] }>
    expect(shown.changes[0]).toMatchObject({ incident, reason: incident.code, state: "stuck" })

    const shownText = capture(w.work)
    expect(
      await coreQueueCommand(w.work, shownText.io, { command: "show", branch: change.branch }, { workdir: w.workdir }),
    ).toBe(0)
    expect(shownText.stdout()).toContain(`  subject: ${subject}`)
    expect(shownText.stdout()).toContain(`  via: ${incident.via}`)
    expect(shownText.stdout()).toContain(`  evidence: ${evidence}`)
    expect(shownText.stdout()).toContain(`  next: ${incident.next}`)
    expect(shownText.stdout()).toContain(`  owner: ${incident.owner}`)
    expect(shownText.stdout().match(/\bstuck\b/gu), shownText.stdout()).toHaveLength(1)
  })

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
    expect(asText.stdout()).toContain(`   direct  main ${direct.slice(0, 12)} ${sentence}\n`)
  })
})

describe("yrd queue show, one change's evidence", () => {
  it("hydrates the checked-to-sent history and leaves a genuinely missing check not run", async () => {
    const w = await world()
    await redeclare(
      w,
      [
        "target: origin#main",
        "checks:",
        "  - typecheck:",
        "      run: bun run typecheck",
        "  - manifest-co-change:",
        "      run: bun run manifest-co-change",
        "  - substrate-pair:",
        "      run: bun run substrate-pair",
        "  - affected-tests:",
        "      run: bun run affected-tests",
        "  - never-ran:",
        "      run: bun run never-ran",
        "",
      ].join("\n"),
    )
    const base = (await w.git(["rev-parse", "main"])).trim()
    await w.git(["checkout", "--quiet", "-b", "task/evidence", "main"])
    writeFileSync(join(w.work, "evidence.txt"), "evidence\n")
    await w.git(["add", "evidence.txt"])
    await w.git(["commit", "--quiet", "-m", "evidence"])
    const head = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])
    const change = { branch: "task/evidence", head }
    await submit(w.git, "origin", {
      branch: change.branch,
      submitter: "@dev/3",
      target: { branch: "main", remote: "origin" },
    })
    await appendRecord(w.git, {
      change,
      kind: "checked",
      subject: "on-submit checks passed",
      target: "origin#main",
      trailers: [
        ["Base", base],
        ["Check", "typecheck exit=0 ms=12 log=/tmp/typecheck.log"],
        ["Check", "manifest-co-change exit=0 ms=13 log=/tmp/manifest.log"],
        ["Check", "substrate-pair exit=0 ms=14 log=/tmp/substrate.log"],
        ["Check", "affected-tests exit=0 ms=14 log=/tmp/submit-affected.log"],
      ],
    })
    await appendRecord(w.git, {
      change,
      kind: "merged",
      subject: "merged task/evidence into main",
      target: "origin#main",
      trailers: [
        ["Base", base],
        ["Merge", base],
        ["Check", "affected-tests exit=0 ms=15 log=/tmp/affected.log"],
      ],
    })
    await appendRecord(w.git, {
      change,
      kind: "sent",
      subject: "sent merge notice",
      target: "origin#main",
      trailers: [
        ["State", "merged"],
        ["Base", base],
        ["Merge", base],
        ["Check", "affected-tests exit=0 ms=15 log=/tmp/affected.log"],
      ],
    })
    await w.git(["push", "--quiet", "origin", `${changeRef(change)}:${changeRef(change)}`])

    const run = capture(w.work)
    expect(
      await coreQueueCommand(
        w.work,
        run.io,
        { command: "show", branch: change.branch },
        { json: true, workdir: w.workdir },
      ),
    ).toBe(0)
    const shown = records(run)[0] as Readonly<{
      changes: readonly Readonly<{
        checks: readonly Readonly<{ name: string; state: string }>[]
        records: readonly Readonly<{ kind: string }>[]
      }>[]
    }>

    expect(shown.changes[0]?.records.map((record) => record.kind)).toEqual(["opened", "checked", "merged", "sent"])
    expect(shown.changes[0]?.checks.map((check) => [check.name, check.state])).toEqual([
      ["typecheck", "passed"],
      ["manifest-co-change", "passed"],
      ["substrate-pair", "passed"],
      ["affected-tests", "passed"],
      ["never-ran", "not-run"],
    ])
    expect(shown.changes[0]?.checks.find((check) => check.name === "affected-tests")).toMatchObject({
      log: "/tmp/affected.log",
      result: { log: "/tmp/affected.log" },
    })
  })
})
