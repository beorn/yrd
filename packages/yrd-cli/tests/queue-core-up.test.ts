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

import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import {
  appendRecord,
  changeRef,
  gitIn,
  nextStuckStreak,
  readConfig,
  readRecords,
  readRemoteCommit,
  readRunLog,
  runId,
  submit,
  trailer,
  watchRows,
  type Git,
  type QueueHealthDocument,
  type QueueRunOutcome,
  type GitRunner,
} from "@yrd/queue-core"
import { createLogger, type ConditionalLogger, type Event } from "loggily"
import { coreQueueCommand, openDetail, readListing, roundFacts } from "../src/queue-core-commands.ts"
import { readQueueHealth, SERVICE } from "../src/queue-health.ts"
import type { YrdCliIO } from "../src/types.ts"
import { installSelectedGit } from "./support/selected-git.ts"

// A submodule at a local path: git refuses file transport for submodule clones
// unless every git in the chain is told. Every git runner below and the
// queue's own git children read this process's environment when they are
// made, so it is said here, first.
process.env.GIT_CONFIG_COUNT = "1"
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow"
process.env.GIT_CONFIG_VALUE_0 = "always"

const roots: string[] = []
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
async function gitlinkWorld(sourceReadFailure = false): Promise<GitlinkWorld> {
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
import { appendRecord, changeRef, gitIn, parseChangeName, readRecords } from ${JSON.stringify(resolve(import.meta.dirname, "../../yrd-queue-core/src/index.ts"))}
const change = parseChangeName(JSON.parse(await Bun.stdin.text()).change)
if (!change) throw new Error("notifier received no change")
const git = gitIn(${JSON.stringify(remote)})
const ref = changeRef("main", change)
const oid = (await git(["rev-parse", "--verify", ref + "^{commit}"])).trim()
const tip = (await readRecords(git, oid)).at(-1)
if (!tip || tip.kind !== "merged") throw new Error("notifier ran before the merge record landed")
await appendRecord(git, "main", { change, kind: "merged", subject: "another observer recorded the merge", trailers: tip.trailers })
`,
    )
    await redeclare(w, `notify:\n  - rival:\n      on: [merged]\n      run: ${JSON.stringify(`bun '${rival}'`)}\n`)
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

    // T1: the service fixes one executable for its lifetime. Native-only
    // rounds could not expose a fresh selection or a lost rebinding later.
    const selected = await installSelectedGit(w.work)
    const selectedCallsAfterRound: number[] = []
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
            selectedCallsAfterRound.push(selected.readCalls().filter((call) => call.marker === "up-rounds").length)
            if (rounds === 1) {
              await coreQueueCommand(
                w.work,
                capture(w.work).io,
                { by: "@chief", command: "resume", reason: "repair merged" },
                { workdir: w.workdir },
              )
              await w.git(["config", "yrd.git", JSON.stringify({ executable: "git", contract: "native" })])
            } else if (rounds === 3) {
              stop.abort()
            }
          },
        },
        {
          env: {
            ...process.env,
            PATH: `${gitSuperBin}:${process.env.PATH ?? ""}`,
            YRD_SELECTED_TEST_MARKER: "up-rounds",
          },
          json: true,
          log,
          workdir: w.workdir,
        },
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
    expect(selectedCallsAfterRound[0]).toBeGreaterThan(0)
    for (let index = 1; index < selectedCallsAfterRound.length; index += 1) {
      expect(selectedCallsAfterRound[index]).toBeGreaterThan(selectedCallsAfterRound[index - 1]!)
    }
    for (const round of records(service)) {
      const invocations = readRunLog(join(w.workdir, "logs"), String(round.run)).filter((row) => row.kind === "git")
      expect(invocations.length).toBeGreaterThan(0)
      for (const invocation of invocations) {
        expect(invocation).toMatchObject({
          executable: selected.executable,
          contract: "native",
          scope: "local",
          origin: "file:.git/config",
          complete: true,
        })
      }
    }
    for (const name of ["one", "two"]) {
      expect((await w.git(["show", `origin/main:${name}.txt`])).trim()).toBe(name)
      const head = heads.get(name)
      if (head === undefined) throw new Error(`no submitted head for ${name}`)
      const change = { branch: `task/${name}`, head }
      const ref = changeRef("main", change)
      await w.git(["fetch", "--quiet", "origin", `+${ref}:${ref}`])
      const tip = (await w.git(["rev-parse", "--verify", `${ref}^{commit}`])).trim()
      const history = await readRecords(w.git, tip)
      expect(history.map((record) => record.kind)).toEqual(["opened", "checked", "merged", "merged", "sent"])
      expect(trailer(history[4]!, "State")).toBe("merged")
      const merge = trailer(history[2]!, "Merge")
      expect(merge).toMatch(/^[0-9a-f]{40}$/u)
      await w.git(["merge-base", "--is-ancestor", merge!, "origin/main"])
      const warning = rows.find((row) => row.level === "warn" && row.message.startsWith(`${ref}:`))
      expect(warning?.message).toMatch(/remote [0-9a-f]{40}, intended [0-9a-f]{40} \(diverged\); inspect: git -C /u)
    }
    // Three rounds launch the real selected executable for every Git call.
  }, 15_000)

  it("pause is visible, refuses live and dry-run submit, and resume admits the same branch", async () => {
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
    // The pause rides the RUNNER box's last rail, once — under the title, not above it (watch-frame.tsx).
    const page = listed.stdout().split("\n")
    expect(page.filter((line) => line.includes("paused by @chief"))).toHaveLength(1)
    expect(page.findIndex((line) => line.includes("paused by @chief"))).toBeGreaterThan(
      page.findIndex((line) => line.includes("RUNNER")),
    )
    expect(page.findIndex((line) => line.includes("RUNNER"))).toBeGreaterThan(-1)
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
        { by: "@chief", command: "resume", reason: "repair merged" },
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
    const ref = changeRef("main", { branch: "task/one", head })
    const beforeRetry = await w.git(["ls-remote", "--refs", "origin", ref])
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
    expect(await w.git(["ls-remote", "--refs", "origin", ref])).toBe(beforeRetry)
  })

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
        expect(run.stderr()).toBe("")
        expect(records(run)[0]).toMatchObject({ head })
        const history = await readRecords(w.git, (records(run)[0] as { opened: string }).opened)
        expect(history.map((record) => record.kind)).toEqual(["opened"])
        expect(trailer(history[0]!, "Target")).toBeUndefined()
        expect(await w.git(["ls-remote", "--refs", "origin", changeRef("main", { branch, head })])).toContain(
          changeRef("main", { branch, head }),
        )
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

  it("keeps a round on its declaration's target, then reads the next target's declaration", async () => {
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
    const configA = (await w.git(["rev-parse", `${a}:.yrd.yml`])).trim()
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
    // advances main after declaration A is captured and fetched, immediately
    // before the queue's broad advertisement.
    writeFileSync(join(w.work, ".yrd.yml"), `checks:\n  - fixed:\n      run: ${checkB}\n      on: submit\n`)
    await w.git(["commit", "--quiet", "-am", "declaration B"])
    const b = (await w.git(["rev-parse", "HEAD"])).trim()
    const configB = (await w.git(["rev-parse", `${b}:.yrd.yml`])).trim()
    await w.git(["push", "--quiet", "origin", `${b}:refs/testing/target-b`])
    const wrapper = join(w.workdir, "upload-pack-target-race.sh")
    const calls = join(w.workdir, "upload-pack-target-race.count")
    writeFileSync(
      wrapper,
      [
        "#!/bin/sh",
        `count=0; test ! -f "${calls}" || count=$(cat "${calls}")`,
        "count=$((count + 1))",
        `printf '%s\\n' "$count" > "${calls}"`,
        // An exact fetch may be skipped when A is already local. Invocation
        // two is therefore either that fetch or the queue advertisement; in
        // both cases A has already been declared and B precedes the queue read.
        `if test "$count" -eq 2; then git --git-dir="$1" update-ref refs/heads/main ${b} ${a} || exit $?; fi`,
        'exec git-upload-pack "$@"',
        "",
      ].join("\n"),
    )
    chmodSync(wrapper, 0o755)
    await w.git(["config", "remote.origin.uploadpack", wrapper])

    const run = capture(w.work)
    let rounds = 0

    const exit = await coreQueueCommand(
      w.work,
      run.io,
      {
        afterRound: async (outcome) => {
          rounds += 1
          expect(rounds).toBeLessThanOrEqual(2)
          if (rounds === 2) {
            await w.git(["fetch", "--quiet", "origin", "main"])
            await w.git(["merge", "--quiet", "--ff-only", "origin/main"])
            await redeclare(w, "batch: 1\n")
          }
          expect(outcome.base).toBe(rounds === 1 ? a : b)
        },
        command: "up",
        intervalSeconds: 0,
      },
      { json: true, queue: "main", workdir: w.workdir },
    )

    expect(exit, run.stdout()).toBe(2)
    expect(rounds).toBe(2)
    expect(Number(readFileSync(calls, "utf8").trim())).toBeGreaterThanOrEqual(2)
    const written = records(run)
    expect(written).toHaveLength(3)
    expect(written[0]).toMatchObject({ base: a, config: configA, exitCode: 0, merged: [], target: a })
    expect(written[1]).toMatchObject({ base: b, config: configB, exitCode: 0, merged: ["task/one"] })
    expect(readFileSync(checkLog, "utf8")).toBe(`A:${a}\nB:${b}\n`)
    // The third round never ran: its malformed declaration is read before it.
    expect(written[2]).toEqual({ ...STUCK, why: expect.stringContaining("batch") as string })
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
  it("ends stuck when the shared checkout never materializes the target, and names it", async () => {
    const w = await gitlinkWorld()
    // The target records b. The runtime's own checkout is left at a and NOBODY
    // ever projects it: this is the stalled-updater world, not a lagging one.
    await w.git(["update-index", "--cacheinfo", "160000", w.b, "submodule"])
    await w.git(["commit", "--quiet", "-m", "target records b, checkout never follows"])
    await w.git(["push", "--quiet", "origin", "main"])
    const run = capture(w.work)
    const stop = new AbortController()
    const { log } = logRows()
    let rounds = 0

    const exit = await w.command(
      w.work,
      run.io,
      {
        command: "up",
        intervalSeconds: 0,
        stop: stop.signal,
        // Fifty milliseconds stands in for ten minutes. What is under test is
        // that the wait ENDS and says why, which does not depend on the number.
        relaunchWaitCapMs: 50,
        afterRound: () => {
          rounds += 1
          stop.abort()
        },
      },
      { json: true, log, workdir: w.workdir },
    )

    // Stuck, not zero and not a hang: the service could not reload, so it must
    // not run another round on the old code either.
    expect(exit, `${run.stdout()}\n${run.stderr()}`).toBe(2)
    expect(rounds).toBe(0)
    // NAMING THE CHECKOUT is the whole ask. "Stuck" that does not say which of
    // the three is behind sends a reader to the same three places every time.
    const said = `${run.stdout()}\n${run.stderr()}`
    expect(said).toContain(join(w.work, "submodule"))
    expect(said).toContain("relaunches on its own")
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
    expect(off[0]?.message).toContain("records no gitlink")
    // And it reaches stderr too, so a person watching the service sees it
    // without a log level set.
    expect(run.stderr()).toContain("the relaunch exit is off")
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
    const ended = await appendRecord(w.git, "main", {
      change,
      kind: "stuck",
      subject,
      trailers: incidentTrailers,
    })
    await appendRecord(w.git, "main", {
      change,
      kind: "sent",
      subject: "logged the incident",
      trailers: [["State", "stuck"], ["For", ended], ["To", "none"], ["Delivery", "none"], ...incidentTrailers],
    })
    await w.git(["push", "--quiet", "origin", `${changeRef("main", change)}:${changeRef("main", change)}`])

    const listedJson = capture(w.work)
    expect(await coreQueueCommand(w.work, listedJson.io, { command: "list" }, { json: true, workdir: w.workdir })).toBe(
      0,
    )
    const listed = records(listedJson)[0] as Readonly<{ changes: readonly Record<string, unknown>[] }>
    expect(listed.changes[0]).toMatchObject({ incident, reason: incident.code, state: "stuck" })
    expect(String(listed.changes[0]?.result)).toContain("THE-END-OF-THE-INCIDENT")

    const listedText = capture(w.work)
    expect(await coreQueueCommand(w.work, listedText.io, { command: "list" }, { workdir: w.workdir })).toBe(0)
    // Compact: the list's row names the incident by its code, in the status
    // suffix the pane draws (`stuck=<code>`, @cto 07b07f37); the sentence
    // itself is `show`'s, below. The status word appears once, in STATUS.
    const listedLine = listedText
      .stdout()
      .split("\n")
      .find((line) => line.includes("task/incident"))
    expect(listedLine, listedText.stdout()).toBeDefined()
    expect(listedLine, listedText.stdout()).toContain(`stuck=${incident.code}`)
    expect(listedLine).toMatch(/◌ stuck\b/u)
    expect(listedText.stdout()).not.toContain("THE-END-OF-THE-INCIDENT")

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
    // On the page: its own row — the direct glyph and word in STATUS, the
    // target as its branch and the commit's own subject as its CHANGES text;
    // the sentence is the JSON's `reason`, above.
    const directLine = asText
      .stdout()
      .split("\n")
      .find((line) => line.includes("→ direct"))
    expect(directLine, asText.stdout()).toBeDefined()
    expect(directLine).toContain("main direct.txt")
  })
})

describe("yrd queue show, one change's evidence", () => {
  it("shows the current running check without relabeling an older unresolved result as passed", async () => {
    // Reader tests supplied measured checks directly; this proves that the CLI
    // selects the current journal instead of combining all historical trailers.
    const w = await world()
    await redeclare(w, "checks:\n  - affected-tests:\n      run: test\n")
    const base = (await w.git(["rev-parse", "main"])).trim()
    const branch = "task/retry"
    await w.git(["checkout", "--quiet", "-b", branch, "main"])
    writeFileSync(join(w.work, "retry.txt"), "retry\n")
    await w.git(["add", "retry.txt"])
    await w.git(["commit", "--quiet", "-m", "retry"])
    const head = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])
    const change = { branch, head }
    await submit(w.git, "origin", {
      branch,
      submitter: "@dev/3",
      target: { branch: "main", remote: "origin" },
    })
    await appendRecord(w.git, "main", {
      change,
      kind: "stuck",
      subject: "old run could not judge",
      trailers: [
        ["Base", base],
        ["Check", "affected-tests exit=3 ms=5 log=/old/affected.log"],
      ],
    })
    await appendRecord(w.git, "main", {
      change,
      kind: "checked",
      subject: "new on-submit checks passed",
      trailers: [["Base", base]],
    })
    await w.git(["push", "--quiet", "origin", `${changeRef("main", change)}:${changeRef("main", change)}`])
    const at = new Date().toISOString()
    const run = runId(new Date(at))
    const dir = join(w.workdir, "logs")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${run}.jsonl`),
      [
        { kind: "run", base, queue: "q", target: "main", checks: ["affected-tests"] },
        { kind: "check", ...change, name: "affected-tests", phase: "merge", start: at, log: "/new/affected.log" },
      ]
        .map((record) => JSON.stringify({ ...record, at, run }))
        .join("\n") + "\n",
    )
    const output = capture(w.work)
    expect(
      await coreQueueCommand(
        w.work,
        output.io,
        { command: "show", branch },
        {
          json: true,
          workdir: w.workdir,
        },
      ),
    ).toBe(0)
    const shown = records(output)[0] as { changes: { run: string; checks: unknown[] }[] }
    expect(shown.changes[0]?.run).toBe(run)
    expect(shown.changes[0]?.checks).toEqual([
      {
        name: "affected-tests",
        phase: "merge",
        state: "running",
        log: "/new/affected.log",
        spec: { name: "affected-tests", run: "test" },
      },
    ])
  })

  it("hydrates the checked-to-sent history and leaves a genuinely missing check not run", async () => {
    const w = await world()
    await redeclare(
      w,
      [
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
    await appendRecord(w.git, "main", {
      change,
      kind: "checked",
      subject: "on-submit checks passed",
      trailers: [
        ["Base", base],
        ["Check", "typecheck exit=0 ms=12 log=/tmp/typecheck.log"],
        ["Check", "manifest-co-change exit=0 ms=13 log=/tmp/manifest.log"],
        ["Check", "substrate-pair exit=0 ms=14 log=/tmp/substrate.log"],
        ["Check", "affected-tests exit=0 ms=14 log=/tmp/submit-affected.log"],
      ],
    })
    await appendRecord(w.git, "main", {
      change,
      kind: "merged",
      subject: "merged task/evidence into main",
      trailers: [
        ["Base", base],
        ["Merge", base],
        ["Check", "affected-tests exit=0 ms=15 log=/tmp/affected.log"],
      ],
    })
    await appendRecord(w.git, "main", {
      change,
      kind: "sent",
      subject: "sent merge notice",
      trailers: [
        ["State", "merged"],
        ["Base", base],
        ["Merge", base],
        ["Check", "affected-tests exit=0 ms=15 log=/tmp/affected.log"],
      ],
    })
    await w.git(["push", "--quiet", "origin", `${changeRef("main", change)}:${changeRef("main", change)}`])

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

  it("keeps a merged change's submit evidence when this machine's own journal only names the merge phase", async () => {
    // Live specimen (@cto, 2026-09): `queue show` on an already-merged change
    // printed the correct merged verdict — "pass affected-tests" — and then
    // rendered every declared check as NOT RUN. The queue's own journal on
    // this machine had a run for this exact branch+head (it just processed
    // the merge), but that run's OWN checks list did not carry the
    // submit-phase evidence — an earlier phase ran under an earlier run this
    // one does not repeat. `change.checks` (this same fixture as the sibling
    // test above) already folds every record's `Check:` trailers correctly;
    // this proves a same-machine journal must not be trusted over that fold
    // once the change is DECIDED.
    const w = await world()
    await redeclare(
      w,
      [
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
    await w.git(["checkout", "--quiet", "-b", "task/evidence-with-journal", "main"])
    writeFileSync(join(w.work, "evidence.txt"), "evidence\n")
    await w.git(["add", "evidence.txt"])
    await w.git(["commit", "--quiet", "-m", "evidence"])
    const head = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])
    const change = { branch: "task/evidence-with-journal", head }
    await submit(w.git, "origin", {
      branch: change.branch,
      submitter: "@dev/3",
      target: { branch: "main", remote: "origin" },
    })
    await appendRecord(w.git, "main", {
      change,
      kind: "checked",
      subject: "on-submit checks passed",
      trailers: [
        ["Base", base],
        ["Check", "typecheck exit=0 ms=12 log=/tmp/typecheck.log"],
        ["Check", "manifest-co-change exit=0 ms=13 log=/tmp/manifest.log"],
        ["Check", "substrate-pair exit=0 ms=14 log=/tmp/substrate.log"],
        ["Check", "affected-tests exit=0 ms=14 log=/tmp/submit-affected.log"],
      ],
    })
    await appendRecord(w.git, "main", {
      change,
      kind: "merged",
      subject: "merged task/evidence-with-journal into main",
      trailers: [
        ["Base", base],
        ["Merge", base],
        ["Check", "affected-tests exit=0 ms=15 log=/tmp/affected.log"],
      ],
    })
    await appendRecord(w.git, "main", {
      change,
      kind: "sent",
      subject: "sent merge notice",
      trailers: [
        ["State", "merged"],
        ["Base", base],
        ["Merge", base],
        ["Check", "affected-tests exit=0 ms=15 log=/tmp/affected.log"],
      ],
    })
    await w.git(["push", "--quiet", "origin", `${changeRef("main", change)}:${changeRef("main", change)}`])

    // This machine's own run journal: it just processed the merge (so it is
    // very much "the run" the row's own bookkeeping would select), but its
    // journal names only the decision, never the individual checks — exactly
    // what a run that merged without re-running anything, or one whose
    // earlier-phase sibling has aged out of the retention window, leaves
    // behind.
    const at = new Date().toISOString()
    const run = runId(new Date(at))
    const dir = join(w.workdir, "logs")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${run}.jsonl`),
      [{ kind: "change", ...change, decision: "merged" }]
        .map((record) => JSON.stringify({ ...record, at, run }))
        .join("\n") + "\n",
    )

    const output = capture(w.work)
    expect(
      await coreQueueCommand(
        w.work,
        output.io,
        { command: "show", branch: change.branch },
        { json: true, workdir: w.workdir },
      ),
    ).toBe(0)
    const shown = records(output)[0] as Readonly<{
      changes: readonly Readonly<{ checks: readonly Readonly<{ name: string; state: string }>[] }>[]
    }>
    expect(shown.changes[0]?.checks.map((check) => [check.name, check.state])).toEqual([
      ["typecheck", "passed"],
      ["manifest-co-change", "passed"],
      ["substrate-pair", "passed"],
      ["affected-tests", "passed"],
      ["never-ran", "not-run"],
    ])
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
describe("yrd queue run, up and list agree on a stuck change (@i/10-yrd/24141)", () => {
  it("names the same branch and cure whichever of the three commands reports it", async () => {
    const w = await world()
    const check = join(w.workdir, "always-stuck.sh")
    writeFileSync(check, "#!/bin/sh\nexit 2\n")
    chmodSync(check, 0o755)
    // `on: submit` so the on-submit judge writes the "stuck" ending directly
    // (run.ts `judge`'s own `yrd-check-unresolved`), the same incident code
    // every re-judge of this change will keep writing.
    await redeclare(w, `checks:\n  - verify:\n      run: ${check}\n      on: submit\n`)
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
    // `judge`'s own literal, reproduced rather than imported: a change here
    // that silently drifts from run.ts's wording is exactly the disagreement
    // this test exists to catch.
    const cure = "repair verify or its queue environment, then run yrd queue run"

    // AC1 + AC2: `run` takes the change, cannot get past it, ends 2, and
    // names the branch and the cure on stderr.
    const ranRun = capture(w.work)
    expect(await coreQueueCommand(w.work, ranRun.io, { command: "run" }, { workdir: w.workdir })).toBe(2)
    expect(ranRun.stderr()).toContain("stuck task/stuck:")
    expect(ranRun.stderr()).toContain(cure)

    // AC3: `up`, pointed at the same still-stuck change, CLASSIFIES exactly as
    // `run` just did — it names the same branch and the same cure.
    //
    // What it no longer does is exit (@i/10-yrd/24395). This block used to
    // assert exit 2, and that assertion was the defect written down: it made
    // the stuck ALARM and the service STOP one event, so a routine recoverable
    // fault took delivery offline with relaunch disabled. The round is stuck;
    // the loop is not. 24141's subject — the three commands agreeing on the
    // branch and the cure — is untouched, and is what is asserted here.
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
    expect(ranUp.stderr()).toContain("stuck task/stuck:")
    expect(ranUp.stderr()).toContain(cure)
    // The alarm the exit used to carry, now carried by the document — and the
    // ladder proves the loop treated these as two rounds, not one.
    expect(documents.map((document) => document.state)).toEqual(["unhealthy", "unhealthy"])
    expect(documents.map((document) => document.facts?.stuckRounds)).toEqual([1, 2])
    expect(documents[0]?.error?.cause).toContain("task/stuck")
    expect(documents[0]?.verdict).toEqual({ kind: "running" })
    // And the same document is on disk where the declared probe reads it.
    expect(readQueueHealth(w.workdir, SERVICE)).toEqual(documents[1])

    // AC3: `list` already named this branch and this cure before `run` and
    // `up` did (this file's "renders one stored lossless incident" case); the
    // same fixture must show the identical code and cure through `list` too.
    const listed = capture(w.work)
    expect(await coreQueueCommand(w.work, listed.io, { command: "list" }, { json: true, workdir: w.workdir })).toBe(0)
    const rows = (records(listed)[0] as { changes: readonly Record<string, unknown>[] }).changes
    const row = rows.find((entry) => entry.branch === "task/stuck")
    expect(row, JSON.stringify(rows)).toMatchObject({ state: "stuck", reason: "yrd-check-unresolved" })
    expect(String(row?.result)).toContain(cure)
  })
})

describe("yrd watch's own detail pane (openDetail), one change's evidence", () => {
  it("keeps a merged change's submit evidence when this machine's own journal only names the merge phase", async () => {
    // The `show` sibling test above reproduces the @cto 2026-09 specimen
    // against the `show` command's own call site (fixed by 1fca452c). This is
    // the SAME specimen shape against `openDetail` — the watch pane's own
    // Enter-to-open detail loader — which 1fca452c did not touch: it still
    // unconditionally passed this machine's journal-selected run into
    // `checksOf`, with no guard for a change that is already DECIDED. Absent
    // the fix, this fails exactly like the `show` case did before 1fca452c:
    // every check but the merge-phase's own reads NOT RUN.
    const w = await world()
    await redeclare(
      w,
      [
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
    await w.git(["checkout", "--quiet", "-b", "task/evidence-open-detail", "main"])
    writeFileSync(join(w.work, "evidence.txt"), "evidence\n")
    await w.git(["add", "evidence.txt"])
    await w.git(["commit", "--quiet", "-m", "evidence"])
    const head = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])
    const change = { branch: "task/evidence-open-detail", head }
    await submit(w.git, "origin", {
      branch: change.branch,
      submitter: "@dev/3",
      target: { branch: "main", remote: "origin" },
    })
    await appendRecord(w.git, "main", {
      change,
      kind: "checked",
      subject: "on-submit checks passed",
      trailers: [
        ["Base", base],
        ["Check", "typecheck exit=0 ms=12 log=/tmp/typecheck.log"],
        ["Check", "manifest-co-change exit=0 ms=13 log=/tmp/manifest.log"],
        ["Check", "substrate-pair exit=0 ms=14 log=/tmp/substrate.log"],
        ["Check", "affected-tests exit=0 ms=14 log=/tmp/submit-affected.log"],
      ],
    })
    await appendRecord(w.git, "main", {
      change,
      kind: "merged",
      subject: "merged task/evidence-open-detail into main",
      trailers: [
        ["Base", base],
        ["Merge", base],
        ["Check", "affected-tests exit=0 ms=15 log=/tmp/affected.log"],
      ],
    })
    await appendRecord(w.git, "main", {
      change,
      kind: "sent",
      subject: "sent merge notice",
      trailers: [
        ["State", "merged"],
        ["Base", base],
        ["Merge", base],
        ["Check", "affected-tests exit=0 ms=15 log=/tmp/affected.log"],
      ],
    })
    await w.git(["push", "--quiet", "origin", `${changeRef("main", change)}:${changeRef("main", change)}`])

    // This machine's own run journal: it just processed the merge, but its
    // journal names only the decision, never the individual checks — same
    // shape as the `show` sibling fixture above.
    const at = new Date().toISOString()
    const run = runId(new Date(at))
    const dir = join(w.workdir, "logs")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${run}.jsonl`),
      [{ kind: "change", ...change, decision: "merged" }]
        .map((record) => JSON.stringify({ ...record, at, run }))
        .join("\n") + "\n",
    )

    // The exact pipeline `yrd watch` itself uses to get from a target OID to
    // the `entries`/`item` pair `openDetail` is called with (queue-core-commands.ts's
    // own `open:` callback wiring): readConfig -> readListing -> watchRows.
    const target = { branch: "main", remote: "origin" }
    const oid = await readRemoteCommit(w.git, "origin", "refs/heads/main")
    if (oid === undefined) throw new Error("test setup: origin/main was not readable")
    const config = await readConfig(w.git, oid, target)
    if (config === undefined) throw new Error("test setup: the target carries no .yrd.yml")
    // `World.git` is typed to the narrower `Git` call signature; the value
    // `world()` actually hands out comes from `gitIn()`, declared `GitRunner`
    // (the same value the CLI's own `readListing` call site is given).
    const { all, journals, queue } = await readListing(w.git as GitRunner, config, w.workdir, oid)
    const rows = watchRows(all, { journals })
    const item = rows.find((row) => row.row.branch === change.branch)
    if (item === undefined) throw new Error("test setup: the change did not appear in the watch rows")

    const detail = await openDetail(w.git, config, queue.changes, item, "main")
    expect(detail.checks.map((check) => [check.name, check.state])).toEqual([
      ["typecheck", "passed"],
      ["manifest-co-change", "passed"],
      ["substrate-pair", "passed"],
      ["affected-tests", "passed"],
      ["never-ran", "not-run"],
    ])
  })
})

/**
 * @failure  A stuck round ends the SERVICE. The stuck alarm and the stop are one
 *           event, so a routine, recoverable, submitter-independent fault — a
 *           code-host 504 during setup — takes the only fleet delivery mechanism
 *           offline with automatic relaunch disabled, and delivery stays down
 *           until a person notices. Measured 2026-09-11: run
 *           q-20260911T063507008Z-500ae413, about 24 minutes down for a fault the
 *           next round cleared (@i/10-yrd/24395, @cto ruling).
 * @level    l2 (a real remote and a clone under a temporary root; the loop driven
 *           directly, no process boundary)
 * @consumer the supervisor, which reads the declared health probe and pages on
 *           unhealthy-while-running without restarting · everyone waiting on a
 *           change behind a transient fault
 */
describe("a stuck round ends the round, not the service (@i/10-yrd/24395)", () => {
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

  /** One change waiting in the line, so a round has something to merge. */
  async function oneChange(w: World, branch: string): Promise<void> {
    await w.git(["checkout", "--quiet", "-b", branch, "main"])
    writeFileSync(join(w.work, `${branch.replace("/", "-")}.txt`), "work\n")
    await w.git(["add", "-A"])
    await w.git(["commit", "--quiet", "-m", branch])
    await w.git(["checkout", "--quiet", "main"])
    await submit(w.git, "origin", { branch, submitter: "@dev/4", target: { branch: "main", remote: "origin" } })
  }

  /** Catch the local clone up to a target the service has since advanced. */
  async function catchUp(w: World): Promise<void> {
    await w.git(["fetch", "--quiet", "origin", "main"])
    await w.git(["merge", "--quiet", "--ff-only", "origin/main"])
  }

  // ACCEPTANCE (a) and (b): the process never exits, a later round merges, and
  // the probe reads unhealthy then healthy — which is exactly the pair the
  // supervisor turns into a page and then drops, with no restart between them.
  it("survives a setup fault, merges once it clears, and its health goes unhealthy then healthy", async () => {
    const w = await world()
    const fault = faultySetup(w.workdir)
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
        afterHealth: (document) => {
          seen.push(document)
          // The outage ends after the service has already been stuck by it —
          // so the recovery is the loop's, not the fixture's timing.
          if (seen.length === 2) fault.clear()
          if (document.state === "healthy") stop.abort()
        },
      },
      // `json: true` so the rounds this test reads back are machine-readable;
      // the stuck lines it does not read stay on stderr either way.
      { json: true, workdir: w.workdir },
    )

    // Exit 0: the loop was STOPPED, never ended by the fault. Before this
    // change the first stuck round returned 2 and the service went down.
    expect(exit, run.stderr()).toBe(0)
    const states = seen.map((document) => document.state)
    expect(states.length, JSON.stringify(states)).toBeGreaterThanOrEqual(3)
    expect(states.slice(0, 2)).toEqual(["unhealthy", "unhealthy"])
    expect(states.at(-1)).toBe("healthy")
    expect(states.slice(0, -1).every((state) => state === "unhealthy")).toBe(true)
    // unhealthy + RUNNING is the combination that pages without a restart. A
    // stuck round reporting `stopped` would be claiming the loop had died.
    expect(seen[0]?.verdict).toEqual({ kind: "running" })
    expect(seen[0]?.error?.code).toBe("queue-round-stuck")
    // The ladder climbed while the fault held: proof these were separate rounds.
    expect(seen[0]?.facts?.stuckRounds).toBe(1)
    expect(seen[1]?.facts?.stuckRounds).toBe(2)
    // The page clears because the document says healthy, not because anything
    // restarted: same process, same loop, a later round.
    expect(seen.at(-1)?.error).toBeUndefined()
    expect(seen.at(-1)?.verdict).toEqual({ kind: "running" })
    // And a round did the work the stuck ones could not.
    const merged = records(run).filter((row) => Array.isArray(row.merged) && (row.merged as unknown[]).length > 0)
    expect(merged, run.stdout()).toHaveLength(1)
    expect(merged[0]?.merged).toEqual(["task/after-the-fault"])
    // The declared probe reads the same document off disk that the loop wrote.
    expect(readQueueHealth(w.workdir, SERVICE)).toEqual(seen.at(-1))
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
    const left = readQueueHealth(w.workdir, SERVICE)
    expect(left.state).toBe("healthy")
    expect(left.verdict).toEqual({ kind: "running" })
  })
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
  it("says yrd-setup-unreachable, and names the signature it matched", async () => {
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
  it("a real break still says yrd-setup-unusable and still tells you to repair it", async () => {
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
  it("a 404 is an answer, not an unreachable remote", async () => {
    const w = await world()
    const line = "error: GET https://api.github.com/repos/beorn/x/tarball/deadbeef - 404"
    await roundWithSetup(w, "task/answered-404", failingSetup(w.workdir, "answered-404", line))
    expect((await reasonFor(w, "task/answered-404")).reason).toBe("yrd-setup-unusable")
  })
})

/**
 * @failure  The ladder is keyed on the reason TEXT, and two of the reasons
 *           embed something that changes every round — the run id, and a raw
 *           error message — so `nextStuckStreak` starts over each time and the
 *           spacing never climbs for the two faults most likely to repeat. The
 *           pure ladder tests pass anyway, because they hand the ladder a
 *           stable string themselves: they prove the MECHANISM and never ask
 *           whether its real producer emits a stable key (@cto follow-up F3,
 *           2026-09-11).
 * @level    l1 (the producer, against constructed outcomes)
 * @consumer the loop's own spacing, and therefore the host it stops hammering
 */
describe("the producer emits a STABLE streak key (@i/10-yrd/24395 F3)", () => {
  const outcome = (over: Partial<QueueRunOutcome>): QueueRunOutcome =>
    ({
      observation: {} as QueueRunOutcome["observation"],
      exitCode: 2,
      log: "/w/log",
      run: "q-20260911T120000000Z-aaaaaaaa",
      base: "a".repeat(40),
      config: "b".repeat(40),
      target: "c".repeat(40),
      merged: [],
      failed: [],
      stuck: [],
      directMerges: [],
      checkedWaiting: 0,
      ...over,
    }) as QueueRunOutcome

  // THE TEST @cto ASKED FOR. Two rounds of the SAME fault, whose prose differs
  // because it names the run — the key must not.
  it("a round stuck without naming a change keys the same across rounds", () => {
    const first = roundFacts(outcome({ run: "q-20260911T120000000Z-aaaaaaaa" }))
    const second = roundFacts(outcome({ run: "q-20260911T120200000Z-bbbbbbbb" }))
    expect(first.stuck?.key).toBe(second.stuck?.key)
    // And the prose still names this round's run, so nothing was lost.
    expect(first.stuck?.reason).not.toBe(second.stuck?.reason)
    expect(first.stuck?.reason).toContain("aaaaaaaa")
    // The ladder therefore CLIMBS, which is the behaviour the key exists for.
    const one = nextStuckStreak(undefined, first)
    expect(nextStuckStreak(one, second)?.consecutive).toBe(2)
  })

  it("a round that could not judge keys the same across rounds", () => {
    const first = roundFacts({ why: "the queue run could not judge: connect ETIMEDOUT 140.82.121.3:443" })
    const second = roundFacts({ why: "the queue run could not judge: connect ETIMEDOUT 140.82.121.4:443" })
    expect(first.stuck?.key).toBe(second.stuck?.key)
    expect(first.stuck?.reason).not.toBe(second.stuck?.reason)
    expect(nextStuckStreak(nextStuckStreak(undefined, first), second)?.consecutive).toBe(2)
  })

  it("the same stuck change keys the same however the round names it", () => {
    const first = roundFacts(outcome({ stuck: ["task/one"], run: "q-1" }))
    const second = roundFacts(outcome({ stuck: ["task/one"], run: "q-2" }))
    expect(first.stuck?.key).toBe(second.stuck?.key)
    expect(nextStuckStreak(nextStuckStreak(undefined, first), second)?.consecutive).toBe(2)
  })

  // NEGATIVE CONTROLS: the key must still SEPARATE genuinely different faults,
  // or the ladder would count unrelated rounds together and space out a fault
  // that just appeared.
  it("different stuck changes key differently", () => {
    expect(roundFacts(outcome({ stuck: ["task/one"] })).stuck?.key).not.toBe(
      roundFacts(outcome({ stuck: ["task/two"] })).stuck?.key,
    )
  })

  it("a could-not-judge round and a stuck-change round key differently", () => {
    expect(roundFacts({ why: "boom" }).stuck?.key).not.toBe(roundFacts(outcome({ stuck: ["task/one"] })).stuck?.key)
  })

  it("the same changes in a different order key the same", () => {
    expect(roundFacts(outcome({ stuck: ["task/a", "task/b"] })).stuck?.key).toBe(
      roundFacts(outcome({ stuck: ["task/b", "task/a"] })).stuck?.key,
    )
  })

  // No key may carry a run id, a sha, a path or an error message — the rule the
  // type states, asserted rather than trusted.
  it("no key embeds anything that changes between rounds", () => {
    const keys = [
      roundFacts(outcome({})).stuck?.key,
      roundFacts(outcome({ stuck: ["task/one"] })).stuck?.key,
      roundFacts({ why: "the queue run could not judge: /tmp/x/y failed at deadbeefdeadbeef" }).stuck?.key,
    ]
    for (const key of keys) {
      expect(key).toBeDefined()
      // No run id, and no sha. A branch name may contain a slash, so paths are
      // not banned outright — only the two things that actually move per round.
      expect(key).not.toMatch(/q-\d{8}T/u)
      expect(key).not.toMatch(/\b[0-9a-f]{12,}\b/u)
    }
  })

  it("a clear round produces no stuck fact at all", () => {
    expect(roundFacts(outcome({ exitCode: 0, merged: ["task/one"] })).stuck).toBeUndefined()
  })
})
