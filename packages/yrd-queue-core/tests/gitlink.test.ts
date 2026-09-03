/**
 * The built-in check at submit: every gitlink the change moved reachable from
 * its component's `main` ([plan](../../../../pm/@i/10-yrd/plan.md) § The final
 * design, The queue run; ruling E4, amending D7). A change that pins a
 * component at a commit its main does not carry ends failed, the submitter's,
 * before any declared check runs; a pin that main carries, ahead or behind,
 * passes through. Only the pins the change moved against the target are
 * asked about, and a positive answer is kept for the run, so a component is
 * fetched at most once per run per pin, and not at all for a change that
 * moves no pin.
 *
 * Measured 2026-09-02 on the old core: a root gitlink pointed at a branch
 * commit forked on the pin, and every later change was judged against a
 * component state no main had ever carried. Measured the same day on this
 * core before E4: asking every component of the root's tree cost 15 fetches
 * and 13.7 s per judged change.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProcess, type Process } from "@yrd/process"
import { afterAll, describe, expect, it } from "vitest"
import { gitIn, queueRun, readFacts, submit, trailer } from "../src/index.ts"
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
    reapPath: (path) => inner.reapPath(path),
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
 * `two` off `one`; a root whose main pins the component at `three`.
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
  writeFileSync(join(work, ".yrd.yml"), "remote: origin\n")
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
      owner: "@cto",
      process: counting.process,
      remote: "origin",
      repo: work,
      target: "main",
      workdir,
    }),
    work,
  }
}

/** A change that moves the component's pin to `sha`, submitted. */
async function submitPin(w: World, branch: string, sha: string): Promise<string> {
  await w.git(["checkout", "--quiet", "-b", branch, "main"])
  const sub = gitIn(join(w.work, "component"))
  await sub(["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"])
  await sub(["checkout", "--quiet", sha])
  await w.git(["add", "component"])
  // The branch is in the message, so two branches pinning the same commit in
  // the same second are two heads, not one head under two names.
  await w.git(["commit", "--quiet", "-m", `${branch}: pin the component at ${sha.slice(0, 12)}`])
  const head = (await w.git(["rev-parse", "HEAD"])).trim()
  await w.git(["checkout", "--quiet", "main"])
  await submit(w.git, "origin", { branch, submitter: "@dev/2", target: "main" })
  return head
}

/** The component's pin moved on main itself, by hand, and pushed: the case the gitlink check never sees (E5). */
async function pinByHand(w: World, sha: string): Promise<string> {
  await w.git(["checkout", "--quiet", "main"])
  const sub = gitIn(join(w.work, "component"))
  await sub(["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"])
  await sub(["checkout", "--quiet", sha])
  await w.git(["add", "component"])
  await w.git(["commit", "--quiet", "-m", `pin the component at ${sha.slice(0, 12)} by hand`])
  await w.git(["push", "--quiet", "origin", "main"])
  return (await w.git(["rev-parse", "HEAD"])).trim()
}

/** A change that touches a file and no gitlink, submitted. */
async function submitFile(w: World, branch: string): Promise<string> {
  await w.git(["checkout", "--quiet", "-b", branch, "main"])
  writeFileSync(join(w.work, `${branch.replace(/\//gu, "-")}.txt`), `${branch}\n`)
  await w.git(["add", "."])
  await w.git(["commit", "--quiet", "-m", `${branch}: a file, no pin`])
  const head = (await w.git(["rev-parse", "HEAD"])).trim()
  await w.git(["checkout", "--quiet", "main"])
  await submit(w.git, "origin", { branch, submitter: "@dev/2", target: "main" })
  return head
}

describe("the built-in gitlink check", () => {
  it("a pin the component's main does not carry ends failed, the submitter's, naming the component", async () => {
    const w = await world()
    const head = await submitPin(w, "task/off", w.offMain)

    const outcome = await queueRun(w.options())

    expect(outcome.exitCode).toBe(1)
    expect(outcome.failed).toEqual(["task/off"])
    const failed = (await readFacts(w.git, "task/off", head)).find((fact) => fact.kind === "failed")
    if (failed === undefined) throw new Error("no failed fact")
    expect(trailer(failed, "Reason")).toBe("gitlink-off-main")
    expect(trailer(failed, "Fault")).toBe("submitter")
    expect(failed.subject).toContain("component")
    expect(trailer(failed, "Remedy")).toContain("main")
    expect(w.fetches()).toBe(1)
  })

  it("a pin the component's main carries passes through, and the change merges", async () => {
    const w = await world()
    await submitPin(w, "task/on", w.onMain)

    const outcome = await queueRun(w.options())

    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/on"])
    expect(w.fetches()).toBe(1)
  })

  it("a change that moves no gitlink asks no component: the target's pins are the target's, judged when they landed (E4)", async () => {
    const w = await world()
    await submitFile(w, "task/file")

    const outcome = await queueRun(w.options())

    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/file"])
    expect(w.fetches()).toBe(0)
  })

  it("a pin moved on the target by hand is reported with its path, and no component is asked about it (E5)", async () => {
    const w = await world()
    const hand = await pinByHand(w, w.offMain)

    const outcome = await queueRun(w.options())

    expect(outcome.exitCode).toBe(0)
    expect(outcome.outside).toEqual([hand])
    const log = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(log.filter((record) => record.kind === "outside")).toMatchObject([{ commit: hand, gitlinks: ["component"] }])
    const told = log.filter((record) => record.kind === "message")
    expect(told).toMatchObject([{ id: hand, says: "outside", to: "@cto" }])
    expect(told[0]?.text).toContain(`main moved by hand at ${hand.slice(0, 12)}`)
    expect(told[0]?.text).toContain("it moved the pin at component")
    // The report reads the commit; it never judges the pin, so no component is asked.
    expect(w.fetches()).toBe(0)
  })

  it("two changes moving the same pin ask the component once per run: a commit on main stays on main (E4)", async () => {
    const w = await world()
    await submitPin(w, "task/first", w.onMain)
    const second = await submitPin(w, "task/second", w.onMain)

    const outcome = await queueRun(w.options())

    // Both were judged on submit — the first fetched, the second read the
    // run's answer — and one merge per run lands the first (ruling D4).
    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/first"])
    expect((await readFacts(w.git, "task/second", second)).map((fact) => fact.kind)).toEqual(["opened", "checked"])
    expect(w.fetches()).toBe(1)
  })
})
