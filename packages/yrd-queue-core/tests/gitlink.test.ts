/**
 * The built-in check at submit: every gitlink the change moved reachable from
 * its component's `main` ([plan](../../../../pm/@i/10-yrd/plan.md) § The final
 * design, The queue run; ruling E4, amending D7). A change that moves a
 * component at a commit its main does not carry ends failed, the submitter's,
 * before any declared check runs; a gitlink that main carries, ahead or behind,
 * passes through. Only the gitlinks the change moved against the target are
 * asked about, and a positive answer is kept for the run, so a component is
 * fetched at most once per run per gitlink, and not at all for a change that
 * moves no gitlink.
 *
 * Measured 2026-09-02 on the old core: a root gitlink pointed at a branch
 * commit forked on the gitlink, and every later change was judged against a
 * component state no main had ever carried. Measured the same day on this
 * core before E4: asking every component of the root's tree cost 15 fetches
 * and 13.7 s per judged change.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProcess, type Process } from "@yrd/process"
import { afterAll, describe, expect, it } from "vitest"
import { gitIn, queueRun, readRecords, submit, trailer } from "../src/index.ts"
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
  /** How many times the queue asked the component for its main, so far. */
  fetches(): number
  options(): QueueRunOptions
}>

/**
 * The queue's process seam, counting every `git fetch` run inside a component
 * checkout: the one network call the gitlink check makes. Everything else
 * passes through untouched — a fake process would be a fake store.
 */
function countingFetches(
  inner: Process,
  inComponent: (cwd: string) => boolean,
): Readonly<{ process: Process; count(): number }> {
  let count = 0
  const process: Process = {
    close: () => inner.close(),
    run: (request) => {
      if (
        request.argv[0] === "git" &&
        request.argv[1] === "fetch" &&
        request.cwd !== undefined &&
        inComponent(request.cwd)
      ) {
        count += 1
      }
      return inner.run(request)
    },
    [Symbol.asyncDispose]: () => inner[Symbol.asyncDispose](),
  }
  return { count: () => count, process }
}

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
  // The component's checkout inside a judged worktree is where the check asks
  // for main; the reference checkout under `work` is the submitter's, not the queue's.
  const counting = countingFetches(
    createProcess({ cwd: work }),
    (cwd) => cwd.startsWith(workdir) && cwd.endsWith("/component"),
  )
  return {
    fetches: counting.count,
    git,
    offMain,
    onMain,
    options: () => ({
      checks: [],
      configBlob: "test-config",
      env: process.env,
      process: counting.process,
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

/** The component's gitlink moved on main itself, around the queue, and pushed: the case the gitlink check never sees (E5). */
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

describe("the built-in gitlink check", () => {
  it("a gitlink the component's main does not carry ends failed, the submitter's, naming the component", async () => {
    const w = await world()
    const head = await submitGitlink(w, "task/off", w.offMain)

    const outcome = await queueRun(w.options())

    expect(outcome.exitCode).toBe(1)
    expect(outcome.failed).toEqual(["task/off"])
    const failed = (await readRecords(w.git, { branch: "task/off", head })).find((record) => record.kind === "failed")
    if (failed === undefined) throw new Error("no failed record")
    expect(trailer(failed, "Reason")).toBe("gitlink-off-main")
    expect(trailer(failed, "Fault")).toBe("submitter")
    expect(failed.subject).toContain("component")
    expect(trailer(failed, "Remedy")).toContain("main")
    expect(w.fetches()).toBe(1)
  })

  it("a gitlink the component's main carries passes through, and the change merges", async () => {
    const w = await world()
    await submitGitlink(w, "task/on", w.onMain)

    const outcome = await queueRun(w.options())

    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/on"])
    expect(w.fetches()).toBe(1)
  })

  it("a change that moves no gitlink asks no component: the target's gitlinks are the target's, judged when they landed (E4)", async () => {
    const w = await world()
    await submitFile(w, "task/file")

    const outcome = await queueRun(w.options())

    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/file"])
    expect(w.fetches()).toBe(0)
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
    // The report reads the commit; it never judges the gitlink, so no component is asked.
    expect(w.fetches()).toBe(0)
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
    expect(w.fetches()).toBe(1)
  })
})
