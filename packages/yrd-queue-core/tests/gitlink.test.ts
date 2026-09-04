/**
 * Settling at submit and merge: git-super raises every held-back gitlink to its
 * component's newest main. An authored pin main does not carry waits without
 * ending the change or blocking the next entry; an object no remote can supply
 * is the submitter's failed change, never a queue-owned stuck.
 *
 * Measured 2026-09-02 on the old core: a root gitlink pointed at a branch
 * commit forked on the gitlink, and every later change was judged against a
 * component state no main had ever carried. Measured the same day on this
 * core before E4: asking every component of the root's tree cost 15 fetches
 * and 13.7 s per judged change.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { gitIn, list, queueRun, readQueue, readRecords, submit, trailer } from "../src/index.ts"
import type { Git, QueueRunOptions } from "../src/index.ts"

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

type World = Readonly<{
  git: Git
  work: string
  /** A commit the component's main carries (behind its tip). */
  onMain: string
  /** A commit on a branch of the component that its main does not carry. */
  offMain: string
  /** The newest commit on the component's main when the fixture was made. */
  main: string
  options(check?: Readonly<{ run: string; on: readonly ("submit" | "merge")[] }>): QueueRunOptions
}>

/**
 * A component whose main is `one` then `three`, with a branch `feature` at
 * `two` off `one`; a root whose main records the component at `three`.
 */
async function world(): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "yrd-core-gitlink-"))
  roots.push(root)
  // A component at a local path: git refuses file transport for submodule
  // clones unless every git in the chain is told. Every git runner below and
  // the queue's own git children read this process's environment when they
  // are made, so it is said here, first.
  process.env.GIT_CONFIG_COUNT = "1"
  process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow"
  process.env.GIT_CONFIG_VALUE_0 = "always"
  const seed = gitIn(root)
  const identity = async (git: Git): Promise<void> => {
    await git(["config", "user.email", "queue@yrd.test"])
    await git(["config", "user.name", "yrd"])
  }

  const component = join(root, "component.git")
  const componentWork = join(root, "component-work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", component])
  await seed(["clone", "--quiet", component, componentWork])
  const cg = gitIn(componentWork)
  await identity(cg)
  await cg(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(componentWork, "lib.txt"), "one\n")
  await cg(["add", "lib.txt"])
  await cg(["commit", "--quiet", "-m", "one"])
  const onMain = (await cg(["rev-parse", "HEAD"])).trim()
  await cg(["checkout", "--quiet", "-b", "feature"])
  writeFileSync(join(componentWork, "lib.txt"), "two\n")
  await cg(["commit", "--quiet", "-am", "two, not on main"])
  const offMain = (await cg(["rev-parse", "HEAD"])).trim()
  await cg(["checkout", "--quiet", "main"])
  writeFileSync(join(componentWork, "lib.txt"), "three\n")
  await cg(["commit", "--quiet", "-am", "three"])
  const main = (await cg(["rev-parse", "HEAD"])).trim()
  await cg(["push", "--quiet", "origin", "main", "feature"])

  const remote = join(root, "remote.git")
  const work = join(root, "work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await identity(git)
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, ".yrd.yml"), "target: origin#main\n")
  await git(["submodule", "add", "--quiet", component, "component"])
  await git(["add", ".yrd.yml", ".gitmodules", "component"])
  await git(["commit", "--quiet", "-m", "base, with the component at its main"])
  await git(["push", "--quiet", "origin", "main"])
  const workdir = join(root, "queue")
  mkdirSync(workdir, { recursive: true })
  return {
    git,
    main,
    offMain,
    onMain,
    options: (check) => ({
      checks: check === undefined ? [] : [{ name: "component-check", on: check.on, run: check.run }],
      configBlob: "test-config",
      env: process.env,
      repo: work,
      target: { branch: "main", remote: "origin" },
      workdir,
    }),
    work,
  }
}

/** A change that moves the component's gitlink to `sha`, submitted. */
async function submitGitlink(w: World, branch: string, sha: string): Promise<string> {
  await w.git(["checkout", "--quiet", "-b", branch, "main"])
  const sub = gitIn(join(w.work, "component"))
  await sub(["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"])
  await sub(["checkout", "--quiet", sha])
  await w.git(["add", "component"])
  // The branch is in the message, so two branches recording the same commit in
  // the same second are two heads, not one head under two names.
  await w.git(["commit", "--quiet", "-m", `${branch}: move the component gitlink to ${sha.slice(0, 12)}`])
  const head = (await w.git(["rev-parse", "HEAD"])).trim()
  await w.git(["checkout", "--quiet", "main"])
  await submit(w.git, "origin", { branch, submitter: "@dev/2", target: { branch: "main", remote: "origin" } })
  return head
}

/** The component's gitlink moved on main itself, around the queue, and pushed: the case candidate settling never sees (E5). */
async function gitlinkAroundQueue(w: World, sha: string): Promise<string> {
  await w.git(["checkout", "--quiet", "main"])
  const sub = gitIn(join(w.work, "component"))
  await sub(["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"])
  await sub(["checkout", "--quiet", sha])
  await w.git(["add", "component"])
  await w.git(["commit", "--quiet", "-m", `move the component gitlink to ${sha.slice(0, 12)} around the queue`])
  await w.git(["push", "--quiet", "origin", "main"])
  return (await w.git(["rev-parse", "HEAD"])).trim()
}

/** A change that touches a file and no gitlink, submitted. */
async function submitFile(w: World, branch: string): Promise<string> {
  await w.git(["checkout", "--quiet", "-b", branch, "main"])
  writeFileSync(join(w.work, `${branch.replace(/\//gu, "-")}.txt`), `${branch}\n`)
  await w.git(["add", "."])
  await w.git(["commit", "--quiet", "-m", `${branch}: a file, no gitlink`])
  const head = (await w.git(["rev-parse", "HEAD"])).trim()
  await w.git(["checkout", "--quiet", "main"])
  await submit(w.git, "origin", { branch, submitter: "@dev/2", target: { branch: "main", remote: "origin" } })
  return head
}

/** Submit a root commit whose gitlink object exists nowhere the queue can fetch. */
async function submitMissingGitlink(w: World, branch: string, missing: string): Promise<string> {
  const base = (await w.git(["rev-parse", "main"])).trim()
  await w.git(["read-tree", "main"])
  await w.git(["update-index", "--add", "--info-only", "--cacheinfo", `160000,${missing},component`])
  const tree = (await w.git(["write-tree"])).trim()
  const head = (
    await w.git(["commit-tree", tree, "-p", base, "-m", `${branch}: record an unavailable component`])
  ).trim()
  await w.git(["update-ref", `refs/heads/${branch}`, head])
  await w.git(["read-tree", "main"])
  await submit(w.git, "origin", { branch, submitter: "@dev/2", target: { branch: "main", remote: "origin" } })
  return head
}

async function remoteTarget(w: World): Promise<string> {
  return (await w.git(["ls-remote", "--refs", "origin", "refs/heads/main"])).trim().split(/\s+/u)[0] ?? ""
}

async function gitlinkAt(w: World, commit: string): Promise<string> {
  const row = (await w.git(["ls-tree", commit, "--", "component"])).trim().split(/\s+/u)
  return row[2] ?? ""
}

async function advanceComponent(w: World, contents: string): Promise<string> {
  const componentWork = join(w.work, "..", "component-work")
  const component = gitIn(componentWork)
  await component(["checkout", "--quiet", "main"])
  writeFileSync(join(componentWork, "lib.txt"), `${contents}\n`)
  await component(["commit", "--quiet", "-am", contents])
  await component(["push", "--quiet", "origin", "main"])
  return (await component(["rev-parse", "HEAD"])).trim()
}

describe("settling gitlinks", () => {
  it("an off-main gitlink waits in place while the next change proceeds", async () => {
    const w = await world()
    const head = await submitGitlink(w, "task/off", w.offMain)
    await submitFile(w, "task/next")

    const outcome = await queueRun(w.options())

    expect(outcome).toMatchObject({ exitCode: 0, failed: [], merged: ["task/next"], stuck: [] })
    const waitingRecords = await readRecords(w.git, { branch: "task/off", head })
    expect(waitingRecords.map((record) => record.kind)).toEqual(["opened", "opened"])
    expect(trailer(waitingRecords.at(-1)!, "Code")).toBe("gitlink-off-main")
    expect(trailer(waitingRecords.at(-1)!, "Next")).toContain("main")
    expect(trailer(waitingRecords.at(-1)!, "Owner")).toBe("the component writer")
    const waitingQueue = await readQueue(w.git, "origin", "main")
    expect(waitingQueue.changes.find((entry) => entry.change.head === head)?.reading.state).toBe("queued")
    const waitingRow = list(waitingQueue.changes).find((row) => row.head === head)
    expect(waitingRow).toMatchObject({
      incident: { code: "gitlink-off-main", owner: "the component writer" },
      next: { owner: "the component writer" },
      position: 1,
      state: "queued",
    })
    expect(waitingRow?.result).toContain(w.offMain)
    expect(readFileSync(outcome.log, "utf8")).toContain("gitlink-off-main")

    const componentWork = join(w.work, "..", "component-work")
    const component = gitIn(componentWork)
    await component(["checkout", "--quiet", "main"])
    await component(["merge", "--quiet", "--no-ff", "-s", "ours", "-m", "land feature", "feature"])
    await component(["push", "--quiet", "origin", "main"])
    const componentMain = (await component(["rev-parse", "HEAD"])).trim()

    const retried = await queueRun(w.options())

    expect(retried).toMatchObject({ exitCode: 0, failed: [], merged: ["task/off"], stuck: [] })
    expect((await readRecords(w.git, { branch: "task/off", head })).map((record) => record.kind)).toEqual([
      "opened",
      "opened",
      "checked",
      "merged",
      "sent",
    ])
    expect(await gitlinkAt(w, await remoteTarget(w))).toBe(componentMain)
  })

  it("a held-back authored pin merges raised and keeps the submitted Change identity", async () => {
    const w = await world()
    const head = await submitGitlink(w, "task/on", w.onMain)

    const outcome = await queueRun(w.options())

    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/on"])
    const target = await remoteTarget(w)
    expect(await gitlinkAt(w, target)).toBe(w.main)
    const message = await w.git(["show", "-s", "--format=%B", target])
    expect(message).toContain(`Change: task/on@${head}`)
    expect(message).toContain(`Settled: component@${w.main}`)
    const merge = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record.kind === "merge")
    expect(merge?.gitlinks).toContain(`component ${w.onMain} -> ${w.main}`)
  })

  it("the queue-owned merge is isolated from vetoing and observing repository hooks", async () => {
    const w = await world()
    const head = await submitGitlink(w, "task/hook-isolation", w.onMain)
    const observed = join(w.work, "..", "queue-hook-observed.log")
    for (const [hook, exit] of [
      ["prepare-commit-msg", 1],
      ["post-commit", 0],
    ] as const) {
      const path = join(w.work, ".git", "hooks", hook)
      writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${hook}' >> '${observed}'\nexit ${String(exit)}\n`)
      chmodSync(path, 0o755)
    }

    const outcome = await queueRun(w.options())

    expect(outcome).toMatchObject({ exitCode: 0, failed: [], merged: ["task/hook-isolation"], stuck: [] })
    expect(existsSync(observed)).toBe(false)
    const target = await remoteTarget(w)
    expect((await w.git(["rev-list", "--parents", "-n", "1", target])).trim().split(" ")).toHaveLength(3)
    expect(await w.git(["show", "-s", "--format=%B", target])).toContain(`Settled: component@${w.main}`)
    expect(await gitlinkAt(w, target)).toBe(w.main)
    expect((await readRecords(w.git, { branch: "task/hook-isolation", head })).map((record) => record.kind)).toEqual([
      "opened",
      "checked",
      "merged",
      "sent",
    ])
  })

  /** An anomaly already on root main is not the candidate's authorship, but every merge that passes over it must expose it. */
  it("an untouched off-main target pin stays put and is reported in the run log", async () => {
    const w = await world()
    await gitlinkAroundQueue(w, w.offMain)
    await submitFile(w, "task/pass-over-off-main")

    const outcome = await queueRun(w.options())

    expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/pass-over-off-main"] })
    const target = await remoteTarget(w)
    expect(await gitlinkAt(w, target)).toBe(w.offMain)
    expect(await w.git(["show", "-s", "--format=%(trailers:key=Settled,valueonly)", target])).toContain(
      `component@${w.offMain} left-off-main component-main@${w.main}`,
    )
    const settle = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.kind === "settle")
    expect(settle).toContainEqual(
      expect.objectContaining({
        from: w.offMain,
        path: "component",
        state: "left-off-main",
        to: w.main,
      }),
    )
  })

  it("an unfetchable candidate gitlink fails the submitter and the next change proceeds", async () => {
    const w = await world()
    const missing = "f".repeat(40)
    const head = await submitMissingGitlink(w, "task/missing", missing)
    await submitFile(w, "task/next")

    const outcome = await queueRun(w.options())

    expect(outcome).toMatchObject({ exitCode: 1, failed: ["task/missing"], merged: ["task/next"], stuck: [] })
    const records = await readRecords(w.git, { branch: "task/missing", head })
    expect(records.map((record) => record.kind)).toEqual(["opened", "failed", "sent"])
    const failed = records.find((record) => record.kind === "failed")
    expect(trailer(failed!, "Fault")).toBe("submitter")
    expect(trailer(failed!, "Reason")).toContain(missing)
    expect(failed?.subject).toContain("component")
  })

  it("a candidate failure introduced by raising component main is queue-owned stuck", async () => {
    const w = await world()
    const breaking = await advanceComponent(w, "breaking component main")
    const head = await submitFile(w, "task/base-red")

    const outcome = await queueRun(
      w.options({ on: ["submit"], run: "! grep -q 'breaking component main' component/lib.txt" }),
    )

    expect(outcome).toMatchObject({ exitCode: 2, failed: [], merged: [], stuck: ["task/base-red"] })
    const records = await readRecords(w.git, { branch: "task/base-red", head })
    const stuck = records.find((record) => record.kind === "stuck")
    expect(trailer(stuck!, "Code")).toBe("yrd-submodule-main-regression")
    expect(trailer(stuck!, "Subject")).toContain("component")
    expect(trailer(stuck!, "Subject")).toContain(breaking)
    expect(trailer(stuck!, "Fault")).toBeUndefined()
    const phases = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.kind === "result" && record.name === "component-check")
      .map((record) => record.phase)
    expect(phases).toEqual(["submit", "base"])
  })

  /** Attribution must compare candidate-minus-content even when root main's old pin is divergent, not silently keep that old tree. */
  it("the settled-base comparator applies a raise over an off-main target pin", async () => {
    const w = await world()
    await gitlinkAroundQueue(w, w.offMain)
    const head = await submitGitlink(w, "task/repair-off-main", w.onMain)

    const outcome = await queueRun(w.options({ on: ["submit"], run: "! grep -q '^three$' component/lib.txt" }))

    expect(outcome).toMatchObject({ exitCode: 2, failed: [], merged: [], stuck: ["task/repair-off-main"] })
    const records = await readRecords(w.git, { branch: "task/repair-off-main", head })
    const stuck = records.find((record) => record.kind === "stuck")
    expect(trailer(stuck!, "Code")).toBe("yrd-submodule-main-regression")
    expect(trailer(stuck!, "Subject")).toContain(`component@${w.main}`)
    const phases = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.kind === "result" && record.name === "component-check")
      .map((record) => record.phase)
    expect(phases).toEqual(["submit", "base"])
  })

  it("a candidate-only failure stays the submitter's when the settled base is green", async () => {
    const w = await world()
    await advanceComponent(w, "healthy component main")
    const head = await submitFile(w, "task/candidate-red")

    const outcome = await queueRun(w.options({ on: ["submit"], run: "test ! -f task-candidate-red.txt" }))

    expect(outcome).toMatchObject({ exitCode: 1, failed: ["task/candidate-red"], merged: [], stuck: [] })
    const records = await readRecords(w.git, { branch: "task/candidate-red", head })
    expect(records.map((record) => record.kind)).toEqual(["opened", "failed", "sent"])
    expect(trailer(records.find((record) => record.kind === "failed")!, "Fault")).toBe("submitter")
    const phases = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.kind === "result" && record.name === "component-check")
      .map((record) => record.phase)
    expect(phases).toEqual(["submit", "base"])
  })

  it("a gitlink moved on the target around the queue is reported with its path, and no component is asked about it (E5)", async () => {
    const w = await world()
    // One change first: the queue's history starts at its own first record, so a
    // queue that has judged nothing reports nothing (direct.ts). Its branch is
    // then taken away, so the run retires it without building a worktree and
    // the count below stays about the direct-merge reading alone.
    await submitFile(w, "task/first")
    await w.git(["push", "--quiet", "origin", ":task/first"])
    const direct = await gitlinkAroundQueue(w, w.offMain)

    const outcome = await queueRun(w.options())

    expect(outcome.exitCode).toBe(0)
    expect(outcome.directMerges).toEqual([direct])
    const log = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(log.filter((record) => record.kind === "merged-direct")).toMatchObject([
      { commit: direct, gitlinks: ["component"] },
    ])
    const told = log.filter((record) => record.kind === "message" && record.says === "merged-direct")
    expect(told).toMatchObject([{ id: direct, says: "merged-direct", to: "none" }])
    expect(told[0]?.text).toContain(`main moved around the queue at ${direct.slice(0, 12)}`)
    expect(told[0]?.text).toContain("it moved the gitlink at component")
  })

  it("a gitlink the reference checkout never fetched is materialized from the component's remote, and the change merges", async () => {
    const w = await world()
    // The component's main moves on in its own clone and the reference
    // checkout under `work` never fetches it; the change records it by plumbing,
    // so the reference's submodule store lacks the commit when the queue
    // builds the worktree. The queue fetches it there (2026-09-03: it refused
    // the network and stuck on @dev/2's 24089 instead).
    const componentWork = join(w.work, "..", "component-work")
    const cg = gitIn(componentWork)
    writeFileSync(join(componentWork, "lib.txt"), "four\n")
    await cg(["commit", "--quiet", "-am", "four"])
    await cg(["push", "--quiet", "origin", "main"])
    const four = (await cg(["rev-parse", "HEAD"])).trim()
    // Plumbing only: the working tree and its submodule checkout stay where
    // they are, so nothing here fetches the commit into the reference store.
    const base = (await w.git(["rev-parse", "main"])).trim()
    await w.git(["read-tree", "main"])
    await w.git(["update-index", "--add", "--cacheinfo", `160000,${four},component`])
    const tree = (await w.git(["write-tree"])).trim()
    const head = (
      await w.git([
        "commit-tree",
        tree,
        "-p",
        base,
        "-m",
        "task/unfetched: move the component gitlink to a commit this checkout never fetched",
      ])
    ).trim()
    await w.git(["update-ref", "refs/heads/task/unfetched", head])
    await w.git(["read-tree", "main"])
    await submit(w.git, "origin", {
      branch: "task/unfetched",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })

    const outcome = await queueRun(w.options())

    expect(outcome.exitCode).toBe(0)
    const kinds = (await readRecords(w.git, { branch: "task/unfetched", head })).map((record) => record.kind)
    expect(kinds).not.toContain("stuck")
    expect(kinds).toContain("merged")
  })

  it("two changes moving the same gitlink ask the component once per run: a commit on main stays on main (E4)", async () => {
    const w = await world()
    await submitGitlink(w, "task/first", w.onMain)
    const second = await submitGitlink(w, "task/second", w.onMain)

    const outcome = await queueRun(w.options())

    // Both were judged on submit — the first fetched, the second read the
    // run's answer — and one merge per run lands the first (ruling D4).
    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/first"])
    expect((await readRecords(w.git, { branch: "task/second", head: second })).map((record) => record.kind)).toEqual([
      "opened",
      "checked",
    ])
  })
})
