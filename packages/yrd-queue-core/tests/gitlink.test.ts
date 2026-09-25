/**
 * Settling at submit and merge: git-super raises every held-back gitlink to its
 * submodule's newest main. An authored gitlink main does not carry waits without
 * ending the change or blocking the next entry; an object no remote can supply
 * is the submitter's failed change, never a queue-owned stuck.
 *
 * Measured 2026-09-02 on the old core: a root gitlink pointed at a branch
 * commit forked on the gitlink, and every later change was judged against a
 * submodule state no main had ever carried. Measured the same day on this
 * core before E4: asking every submodule of the root's tree cost 15 fetches
 * and 13.7 s per judged change.
 */

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
import { dirname, join, resolve } from "node:path"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createProcess } from "@yrd/process"
import type { Process } from "@yrd/process"
import * as gitomic from "gitomic"
import type { RefUpdate } from "gitomic"
import {
  appendRecord,
  changeRef,
  checksOf,
  createEventQueue,
  createEventStore,
  drop,
  gitIn,
  inspectSubmit,
  journalKey,
  list,
  queueRun,
  readConfig,
  readJournals,
  readQueue,
  readRecords,
  readStatus,
  setBranchIgnored,
  submit,
  trailer,
  watchRows,
} from "../src/index.ts"
import type { Git, QueueRunOptions } from "../src/index.ts"
import { appendChangeEvent } from "../src/events.ts"

const gitSuperBin = resolve(import.meta.dirname, "../../../../git-super/bin")
if (!existsSync(gitSuperBin)) {
  throw new Error(`git-super bin directory not found at ${gitSuperBin}`)
}
// The root Vitest project seals PATH in its setup beforeEach. Reassert this
// test's checked-out GitSuper after that hook so both test runners use it.
beforeEach(() => {
  process.env.PATH = `${gitSuperBin}:${process.env.PATH ?? ""}`
})

const roots: string[] = []

/** Intercept the real Gitomic publication seam while retaining its shell backend. */
function beforeGitomicPublish(
  before: (repo: string, updates: readonly RefUpdate[], remote?: string) => Promise<void>,
): ReturnType<typeof vi.spyOn> {
  const createBackend = gitomic.createShellBackend
  return vi.spyOn(gitomic, "createShellBackend").mockImplementation((options) => {
    const backend = createBackend(options)
    const publish = backend.publish
    if (publish === undefined) throw new Error("Gitomic shell backend has no publish capability")
    return {
      ...backend,
      publish: async (repo, updates, remote) => {
        await before(repo, updates, remote)
        return publish(repo, updates, remote)
      },
    }
  })
}

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

type World = Readonly<{
  git: Git
  work: string
  /** A commit the submodule's main carries (behind its tip). */
  onMain: string
  /** A commit on a branch of the submodule that its main does not carry. */
  offMain: string
  /** The newest commit on the submodule's main when the fixture was made. */
  main: string
  options(check?: Readonly<{ run: string; on: readonly ("submit" | "merge")[] }>): Promise<QueueRunOptions>
}>

/**
 * A submodule whose main is `one` then `three`, with a branch `feature` at
 * `two` off `one`; a root whose main records the submodule at `three`.
 */
async function world(): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "yrd-core-gitlink-"))
  roots.push(root)
  // A submodule at a local path: git refuses file transport for submodule
  // clones unless every git in the chain is told. Every git runner below and
  // the queue's own git children read this process's environment when they
  // are made, so it is said here, first.
  process.env.GIT_CONFIG_COUNT = "3"
  // Ownership uses hosted identities; Git itself routes fixture transport locally,
  // including child checkouts created later by the real queue materializer.
  process.env.GIT_CONFIG_KEY_1 = `url.${join(root, "submodule.git")}.insteadOf`
  process.env.GIT_CONFIG_VALUE_1 = "https://git-super.test/owned/submodule.git"
  process.env.GIT_CONFIG_KEY_2 = `url.${join(root, "remote.git")}.insteadOf`
  process.env.GIT_CONFIG_VALUE_2 = "https://git-super.test/owned/root.git"
  process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow"
  process.env.GIT_CONFIG_VALUE_0 = "always"
  const seed = gitIn(root)
  const identity = async (git: Git): Promise<void> => {
    await git(["config", "user.email", "queue@yrd.test"])
    await git(["config", "user.name", "yrd"])
  }

  const submodule = join(root, "submodule.git")
  const submoduleWork = join(root, "submodule-work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", submodule])
  await seed(["clone", "--quiet", submodule, submoduleWork])
  const cg = gitIn(submoduleWork)
  await identity(cg)
  await cg(["remote", "set-url", "origin", "https://git-super.test/owned/submodule.git"])
  await cg(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(submoduleWork, "lib.txt"), "one\n")
  await cg(["add", "lib.txt"])
  await cg(["commit", "--quiet", "-m", "one"])
  const onMain = (await cg(["rev-parse", "HEAD"])).trim()
  await cg(["checkout", "--quiet", "-b", "feature"])
  writeFileSync(join(submoduleWork, "lib.txt"), "two\n")
  await cg(["commit", "--quiet", "-am", "two, not on main"])
  const offMain = (await cg(["rev-parse", "HEAD"])).trim()
  await cg(["checkout", "--quiet", "main"])
  writeFileSync(join(submoduleWork, "lib.txt"), "three\n")
  await cg(["commit", "--quiet", "-am", "three"])
  const main = (await cg(["rev-parse", "HEAD"])).trim()
  await cg(["push", "--quiet", "origin", "main", "feature"])

  const remote = join(root, "remote.git")
  const work = join(root, "work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await identity(git)
  await git(["remote", "set-url", "origin", "https://git-super.test/owned/root.git"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, ".yrd.yml"), "{}\n")
  await git(["submodule", "add", "--quiet", "https://git-super.test/owned/submodule.git", "submodule"])
  await git(["add", ".yrd.yml", ".gitmodules", "submodule"])
  await git(["commit", "--quiet", "-m", "base, with the submodule at its main"])
  await git(["push", "--quiet", "origin", "main"])
  const workdir = join(root, "queue")
  mkdirSync(workdir, { recursive: true })
  return {
    git,
    main,
    offMain,
    onMain,
    options: async (check) => {
      return {
        checks: check === undefined ? [] : [{ name: "submodule-check", on: check.on, run: check.run }],
        configBlob: "test-config",
        env: { ...process.env, PATH: `${gitSuperBin}:${process.env.PATH ?? ""}` },
        repo: work,
        target: { branch: "main", remote: "origin" },
        targetSha: await remoteTip(git, "refs/heads/main"),
        workdir,
      }
    },
    work,
  }
}

/** A change that moves the submodule's gitlink to `sha`, submitted. */
async function submitGitlink(w: World, branch: string, sha: string): Promise<string> {
  await w.git(["checkout", "--quiet", "-b", branch, "main"])
  const sub = gitIn(join(w.work, "submodule"))
  await sub(["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"])
  await sub(["checkout", "--quiet", sha])
  await w.git(["add", "submodule"])
  // The branch is in the message, so two branches recording the same commit in
  // the same second are two heads, not one head under two names.
  await w.git(["commit", "--quiet", "-m", `${branch}: move the submodule gitlink to ${sha.slice(0, 12)}`])
  const head = (await w.git(["rev-parse", "HEAD"])).trim()
  await w.git(["checkout", "--quiet", "main"])
  await submit(w.git, "origin", { branch, submitter: "@dev/2", target: { branch: "main", remote: "origin" } })
  return head
}

/** The submodule's gitlink moved on main itself, around the queue, and pushed: the case candidate settling never sees (E5). */
async function gitlinkAroundQueue(w: World, sha: string): Promise<string> {
  await w.git(["checkout", "--quiet", "main"])
  const sub = gitIn(join(w.work, "submodule"))
  await sub(["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"])
  await sub(["checkout", "--quiet", sha])
  await w.git(["add", "submodule"])
  await w.git(["commit", "--quiet", "-m", `move the submodule gitlink to ${sha.slice(0, 12)} around the queue`])
  await w.git(["push", "--quiet", "origin", "main"])
  return (await w.git(["rev-parse", "HEAD"])).trim()
}

/** The work clone's main, fast-forwarded to the remote main a queue round moved. */
async function mainAfterRound(w: World): Promise<void> {
  await w.git(["checkout", "--quiet", "main"])
  await w.git(["fetch", "--quiet", "origin", "main"])
  await w.git(["merge", "--quiet", "--ff-only", "FETCH_HEAD"])
}

/** A change that touches a file and no gitlink, submitted. */
async function submitFile(w: World, branch: string): Promise<string> {
  await w.git(["checkout", "--quiet", "-b", branch, "main"])
  writeFileSync(join(w.work, `${branch.replace(/\//gu, "-")}.txt`), `${branch}\n`)
  const file = `${branch.replace(/\//gu, "-")}.txt`
  await w.git(["add", file])
  await w.git(["commit", "--quiet", "-m", `${branch}: a file, no gitlink`])
  const head = (await w.git(["rev-parse", "HEAD"])).trim()
  await w.git(["checkout", "--quiet", "main"])
  await submit(w.git, "origin", { branch, submitter: "@dev/2", target: { branch: "main", remote: "origin" } })
  return head
}

/**
 * A change whose gitlink object exists nowhere the queue can fetch. Submit
 * itself refuses it now (24454: the pin is in no store it could publish
 * from), so the queue's own defence is exercised by opening the change by
 * hand exactly as a submit does: an older submit, or an object that vanished
 * from the remote after it, opens the same change.
 */
async function submitMissingGitlink(w: World, branch: string, missing: string): Promise<string> {
  const base = (await w.git(["rev-parse", "main"])).trim()
  await w.git(["read-tree", "main"])
  await w.git(["update-index", "--add", "--info-only", "--cacheinfo", `160000,${missing},submodule`])
  const tree = (await w.git(["write-tree"])).trim()
  const head = (
    await w.git(["commit-tree", tree, "-p", base, "-m", `${branch}: record an unavailable submodule`])
  ).trim()
  await w.git(["update-ref", `refs/heads/${branch}`, head])
  await w.git(["read-tree", "main"])
  await expect(
    submit(w.git, "origin", { branch, submitter: "@dev/2", target: { branch: "main", remote: "origin" } }),
  ).rejects.toThrow(new RegExp(`submodule.*${missing}`, "u"))
  // Nothing was opened by the refused submit; the change below is opened by hand.
  expect((await w.git(["ls-remote", "--refs", "origin", `refs/heads/${branch}`])).trim()).toBe("")
  const change = { branch, head }
  const ref = changeRef("main", change)
  await appendRecord(w.git, "main", {
    change,
    kind: "opened",
    subject: `@dev/2 submitted ${branch} to origin main`,
    trailers: [["Submitter", "@dev/2"]],
  })
  await w.git(["push", "--quiet", "--atomic", "origin", `${head}:refs/heads/${branch}`, `${ref}:${ref}`])
  return head
}

async function remoteTip(git: Git, ref: string): Promise<string> {
  const tip = (await git(["ls-remote", "--refs", "origin", ref])).trim().split(/\s+/u)[0]
  if (tip === undefined || tip === "") throw new Error(`the remote ref ${ref} is absent`)
  return tip
}

/** Declare an event queue over this fixture's gitlink-bearing main. */
async function createWorldEventQueue(w: World): Promise<void> {
  const target = await remoteTip(w.git, "refs/heads/main")
  const config = await readConfig(w.git, target, { branch: "main", remote: "origin" })
  if (config === undefined) throw new Error(`fixture target ${target} lost .yrd.yml`)
  await createEventQueue(eventStore(w), "main", target, config, new Date())
}

function eventStore(w: World): ReturnType<typeof createEventStore> {
  return createEventStore(w.work, "origin", gitIn(w.work).selection)
}

/** @failure An event queue rejected a gitlink-bearing target before verifying its candidate.
 * @level l3 @consumer queue operator and submitter
 * The flat event-run tests cannot expose the component publication refusal.
 */
it("runs a gitlink-bearing event change through the checked candidate", async () => {
  const w = await world()
  await createWorldEventQueue(w)
  const head = await submitFile(w, "task/event-gitlink")

  const outcome = await queueRun({ ...(await w.options()), checks: [], notify: [] })

  expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/event-gitlink"] })
  const state = await readStatus(eventStore(w), "main", "task/event-gitlink")
  expect(state).toMatchObject({ status: "merged", commit: head })
  expect(state.candidate).toBe(await remoteTip(w.git, "refs/heads/main"))
})

/** @failure A green root could become visible before its component main carried the checked pin.
 * @level l3 @consumer queue operator and anyone cloning root main
 * The legacy child-first cases do not exercise the event marker and root CAS.
 */
it("publishes the exact checked event component before root main and merged status", async () => {
  const w = await world()
  await createWorldEventQueue(w)
  const ahead = await aheadOfSubmodule(w, "event-ahead")
  const head = await submitGitlink(w, "task/event-ahead", ahead)
  const before = await remoteTip(w.git, "refs/heads/main")
  expect(await submoduleMain(w)).toBe(w.main)

  const outcome = await queueRun({
    ...(await w.options({ run: `test "$(git -C submodule rev-parse HEAD)" = '${ahead}'`, on: ["merge"] })),
    notify: [],
  })

  expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/event-ahead"] })
  const target = await remoteTip(w.git, "refs/heads/main")
  expect(target).not.toBe(before)
  expect(await gitlinkAt(w, target)).toBe(ahead)
  expect(await submoduleMain(w)).toBe(ahead)
  const state = await readStatus(eventStore(w), "main", "task/event-ahead")
  expect(state).toMatchObject({ status: "merged", commit: head, candidate: target })
  expect(await w.git(["ls-remote", "--refs", "origin", "refs/yrd/main/candidates/*"])).toBe("")
})

/** @failure A failed merge check could leave a component main ahead of the root target.
 * @level l3 @consumer queue operator and submitter
 * This uses a real child pin, which flat event-check tests do not have.
 */
it("keeps both event root and child mains still when the candidate check fails", async () => {
  const w = await world()
  await createWorldEventQueue(w)
  const ahead = await aheadOfSubmodule(w, "event-rejected")
  await submitGitlink(w, "task/event-rejected", ahead)
  const before = await remoteTip(w.git, "refs/heads/main")

  const outcome = await queueRun({ ...(await w.options({ run: "exit 1", on: ["merge"] })), notify: [] })

  expect(outcome).toMatchObject({ exitCode: 1, failed: ["task/event-rejected"], merged: [] })
  expect(await remoteTip(w.git, "refs/heads/main")).toBe(before)
  expect(await submoduleMain(w)).toBe(w.main)
  const state = await readStatus(eventStore(w), "main", "task/event-rejected")
  expect(state).toMatchObject({ status: "failed" })
  expect(state.candidate).toBeDefined()
})

/** @failure A third component value could be silently recomposed after a durable marker.
 * @level l3 @consumer queue operator
 * The frozen source must remain visible for repair when Git-super refuses its lease.
 */
it("keeps the event candidate and stops on a third component main value", async () => {
  const w = await world()
  await createWorldEventQueue(w)
  const ahead = await aheadOfSubmodule(w, "event-third")
  await submitGitlink(w, "task/event-third", ahead)
  const rootBefore = await remoteTip(w.git, "refs/heads/main")
  await using real = createProcess({ cwd: w.work })
  let sawMarker = false
  const racing: Process = {
    ...real,
    async run(request) {
      if (request.argv.includes("super") && request.argv.includes("push") && !sawMarker) {
        const marker = await readStatus(eventStore(w), "main", "task/event-third")
        expect(marker).toMatchObject({ status: "merging" })
        expect(marker.candidate).toBeDefined()
        sawMarker = true
        await advanceSubmodule(w, "a third main value")
      }
      return real.run(request)
    },
  }

  const outcome = await queueRun({ ...(await w.options()), checks: [], notify: [], process: racing })

  expect(sawMarker).toBe(true)
  expect(outcome).toMatchObject({ exitCode: 2, stuck: ["task/event-third"], merged: [] })
  expect(await remoteTip(w.git, "refs/heads/main")).toBe(rootBefore)
  const state = await readStatus(eventStore(w), "main", "task/event-third")
  expect(state).toMatchObject({ status: "stuck" })
  expect(state.candidate).toBeDefined()
  expect(state.reason).toMatch(/refs\/heads\/main|component|submodule/u)
})

/** @failure A root lease loss after child publication could strand the event as merging.
 * @level l3 @consumer queue operator
 * The next candidate must be checked against the new root while child main stays at its frozen source.
 */
it("re-verifies an event after a root race and finishes without another child update", async () => {
  const w = await world()
  await createWorldEventQueue(w)
  const ahead = await aheadOfSubmodule(w, "event-root-race")
  await submitGitlink(w, "task/event-root-race", ahead)
  let movedAround = ""
  let rootPushesSeen = 0
  using _publication = beforeGitomicPublish(async (_repo, updates, remote) => {
    if (remote === undefined || !updates.some((update) => update.ref === "refs/heads/main")) return
    if (rootPushesSeen++ > 0) return
    expect(await submoduleMain(w)).toBe(ahead)
    await w.git(["checkout", "--quiet", "main"])
    writeFileSync(join(w.work, "around-event.txt"), "around the queue\n")
    await w.git(["add", "around-event.txt"])
    await w.git(["commit", "--quiet", "-m", "root raced after event child publication"])
    await w.git(["push", "--quiet", "origin", "main"])
    movedAround = (await w.git(["rev-parse", "HEAD"])).trim()
  })

  const first = await queueRun({ ...(await w.options()), checks: [], notify: [] })
  expect(first).toMatchObject({ exitCode: 0, deferred: ["task/event-root-race"], merged: [], stuck: [] })
  expect(await remoteTip(w.git, "refs/heads/main")).toBe(movedAround)
  expect(await submoduleMain(w)).toBe(ahead)
  expect((await readStatus(eventStore(w), "main", "task/event-root-race")).status).toBe("verifying")

  await using real = createProcess({ cwd: w.work })
  const childUpdates: string[] = []
  const observed: Process = {
    ...real,
    async run(request) {
      const execution = await real.run(request)
      if (request.argv.includes("super") && request.argv.includes("push")) {
        const parsed = JSON.parse(execution.stdout) as { repositories?: { refs?: { state: string }[] }[] }
        for (const repository of parsed.repositories ?? []) {
          for (const ref of repository.refs ?? []) if (ref.state === "updated") childUpdates.push(ref.state)
        }
      }
      return execution
    },
  }
  const second = await queueRun({ ...(await w.options()), checks: [], notify: [], process: observed })
  expect(second).toMatchObject({ exitCode: 0, merged: ["task/event-root-race"], stuck: [] })
  expect(childUpdates).toEqual([])
  expect(await submoduleMain(w)).toBe(ahead)
})

/** @failure A killed runner after child one could lose its exact checked plan.
 * @level l3 @consumer queue operator
 * A fresh clone must replay the marker's frozen candidate, treating child one's source as identical.
 */
it("finishes a two-child event from a cold clone after the runner dies between child pushes", async () => {
  const w = await world()
  const other = await addSecondChild(w)
  await createWorldEventQueue(w)
  const subAhead = await aheadOfSubmodule(w, "event-two-child")
  await submitTwoChildren(w, "task/event-two-child", other.ahead, subAhead)
  const rootBefore = await remoteTip(w.git, "refs/heads/main")
  const root = dirname(w.work)
  const gate = join(root, "first-child-finished")
  const hooks = [join(root, "submodule.git/hooks/pre-receive"), join(other.remote, "hooks/pre-receive")]
  for (const hook of hooks) {
    writeFileSync(
      hook,
      `#!/bin/sh
trap 'exit 1' TERM INT HUP
target_main=0
while read old new ref; do
  if test "$ref" = refs/heads/main; then target_main=1; fi
done
if test "$target_main" -eq 1; then
  if ( set -C; : > '${gate}.lock' ) 2>/dev/null; then
    mkdir -p '${gate}'
    exit 0
  else
    i=0
    while test ! -e '${gate}/first-written' && test "$i" -lt 1200; do sleep 0.05; i=$((i+1)); done
    sleep 30 &
    wait $!
    exit 1
  fi
fi
exit 0
`,
    )
    chmodSync(hook, 0o755)
    const after = hook.replace("pre-receive", "post-receive")
    writeFileSync(
      after,
      `#!/bin/sh
while read old new ref; do
  if test "$ref" = refs/heads/main; then
    : > '${gate}/first-written'
  fi
done
exit 0
`,
    )
    chmodSync(after, 0o755)
  }
  const otherMain = async (): Promise<string> => {
    const row = (await gitIn(w.work)(["ls-remote", "--refs", other.remote, "refs/heads/main"])).trim().split(/\s+/u)[0]
    if (row === undefined || row === "") throw new Error("other main disappeared")
    return row
  }
  await using real = createProcess({ cwd: w.work })
  let killed = false
  const interrupting: Process = {
    ...real,
    async run(request) {
      if (!(request.argv.includes("super") && request.argv.includes("push"))) return real.run(request)
      const controller = new AbortController()
      let finished = false
      const pending = real.run({ ...request, signal: controller.signal }).finally(() => {
        finished = true
      })
      while (!finished) {
        // post-receive runs after the first ref is visible. The other child's
        // pre-receive hook waits, so this is the exact one-child crash window.
        if (existsSync(join(gate, "first-written"))) {
          killed = true
          controller.abort()
          break
        }
        await new Promise((done) => setTimeout(done, 10))
      }
      return pending
    },
  }

  await expect(queueRun({ ...(await w.options()), checks: [], notify: [], process: interrupting })).rejects.toThrow()
  expect(killed).toBe(true)
  expect(await remoteTip(w.git, "refs/heads/main")).toBe(rootBefore)
  const marker = await readStatus(eventStore(w), "main", "task/event-two-child")
  expect(marker).toMatchObject({ status: "merging" })
  expect(marker.candidate).toBeDefined()
  expect(
    [await submoduleMain(w), await otherMain()].filter((tip) => tip === subAhead || tip === other.ahead),
  ).toHaveLength(1)

  for (const hook of hooks) {
    writeFileSync(hook, "#!/bin/sh\nexit 0\n")
    writeFileSync(hook.replace("pre-receive", "post-receive"), "#!/bin/sh\nexit 0\n")
  }
  const cold = join(root, "cold-queue")
  await w.git(["clone", "--quiet", join(root, "remote.git"), cold])
  const coldGit = gitIn(cold)
  await coldGit(["remote", "set-url", "origin", "https://git-super.test/owned/root.git"])
  await coldGit(["config", "user.email", "queue@yrd.test"])
  await coldGit(["config", "user.name", "yrd"])
  const resumed = await queueRun({
    ...(await w.options()),
    repo: cold,
    workdir: join(root, "cold-workdir"),
    checks: [],
    notify: [],
  })
  expect(resumed).toMatchObject({ exitCode: 0, merged: ["task/event-two-child"], stuck: [] })
  expect(await submoduleMain(w)).toBe(subAhead)
  expect(await otherMain()).toBe(other.ahead)
  expect(await remoteTip(w.git, "refs/heads/main")).not.toBe(rootBefore)
})

/** @failure A warm queue store could hide that no remote can supply the frozen source.
 * @level l3 @consumer queue operator
 * Restarting from a cold clone must stop before moving any child branch and name the missing object.
 */
it("sticks a cold event replay when the marker's child source has vanished", async () => {
  const w = await world()
  await createWorldEventQueue(w)
  const ahead = await aheadOfSubmodule(w, "event-vanished")
  await submitGitlink(w, "task/event-vanished", ahead)
  const rootBefore = await remoteTip(w.git, "refs/heads/main")
  await using real = createProcess({ cwd: w.work })
  const interrupted: Process = {
    ...real,
    run(request) {
      if (request.argv.includes("super") && request.argv.includes("push")) {
        throw new Error("fixture killed the runner after its durable marker")
      }
      return real.run(request)
    },
  }
  await expect(queueRun({ ...(await w.options()), checks: [], notify: [], process: interrupted })).rejects.toThrow(
    /fixture killed/u,
  )
  const marker = await readStatus(eventStore(w), "main", "task/event-vanished")
  expect(marker).toMatchObject({ status: "merging" })
  expect(await submoduleMain(w)).toBe(w.main)

  const root = dirname(w.work)
  const bare = gitIn(join(root, "submodule.git"))
  await bare(["update-ref", "-d", `refs/git-super/pins/${ahead}`])
  await bare(["update-ref", "-d", "refs/heads/ahead-event-vanished"])
  await bare(["gc", "--prune=now"])
  const cold = join(root, "cold-unfetchable")
  await w.git(["clone", "--quiet", join(root, "remote.git"), cold])
  const coldGit = gitIn(cold)
  await coldGit(["remote", "set-url", "origin", "https://git-super.test/owned/root.git"])
  await coldGit(["config", "user.email", "queue@yrd.test"])
  await coldGit(["config", "user.name", "yrd"])

  const outcome = await queueRun({
    ...(await w.options()),
    repo: cold,
    workdir: join(root, "cold-unfetchable-workdir"),
    checks: [],
    notify: [],
  })
  expect(outcome).toMatchObject({ exitCode: 2, stuck: ["task/event-vanished"], merged: [] })
  expect(await remoteTip(w.git, "refs/heads/main")).toBe(rootBefore)
  expect(await submoduleMain(w)).toBe(w.main)
  const state = await readStatus(eventStore(w), "main", "task/event-vanished")
  expect(state).toMatchObject({ status: "stuck" })
  expect(state.reason).toContain(ahead)
})

/** @failure A cancellation after the marker could cause this run to write a child for a lost row.
 * @level l3 @consumer queue operator
 * A marked landing must refuse cancellation from the marker append on: the hook fires on the
 * first `rev-parse --absolute-git-dir` once the row is merging: the marker read-back
 * itself (its readRemoteCommit resolves the store through this git) or earlier, never a child write.
 */
it("refuses cancellation after the marker before child publication", async () => {
  const w = await world()
  await createWorldEventQueue(w)
  const ahead = await aheadOfSubmodule(w, "event-rival")
  await submitGitlink(w, "task/event-rival", ahead)
  const rootBefore = await remoteTip(w.git, "refs/heads/main")
  await using real = createProcess({ cwd: w.work })
  let refused = false
  const interleaved: Process = {
    ...real,
    async run(request) {
      if (!refused && request.argv.includes("rev-parse") && request.argv.includes("--absolute-git-dir")) {
        const state = await readStatus(eventStore(w), "main", "task/event-rival")
        if (state.status === "merging" && state.tip !== undefined) {
          await expect(
            appendChangeEvent(eventStore(w), "main", "task/event-rival", state.tip, {
              type: "cancelled",
              at: new Date(),
              reason: "resubmitted",
            }),
          ).rejects.toThrow(/landing in progress/u)
          await expect(
            drop(eventStore(w), { queue: "main", branch: "task/event-rival", by: "@dev/2" }),
          ).rejects.toThrow(/landing in progress/u)
          refused = true
        }
      }
      return real.run(request)
    },
  }

  const outcome = await queueRun({ ...(await w.options()), checks: [], notify: [], process: interleaved })

  expect(refused).toBe(true)
  expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/event-rival"], stuck: [] })
  expect(await remoteTip(w.git, "refs/heads/main")).not.toBe(rootBefore)
  expect(await submoduleMain(w)).toBe(ahead)
  expect((await readStatus(eventStore(w), "main", "task/event-rival")).status).toBe("merged")
  // Since 35b3d713fa a drop of an ended change keeps its ending and deletes only the branch name (25658 P3).
  await drop(eventStore(w), { queue: "main", branch: "task/event-rival", by: "@dev/2" })
  expect((await readStatus(eventStore(w), "main", "task/event-rival")).status).toBe("merged")
  await expect(remoteTip(w.git, "refs/heads/task/event-rival")).rejects.toThrow(/is absent/u)
})

/** @failure Marker read-back can become stale before Git-super starts its child write.
 * @level l3 @consumer queue operator
 * A resubmit after read-back must wait for the marked landing to settle.
 */
it("refuses resubmit between marker read-back and child push, then admits it after landing", async () => {
  const w = await world()
  await createWorldEventQueue(w)
  const ahead = await aheadOfSubmodule(w, "event-rival-after-readback")
  await submitGitlink(w, "task/event-rival-after-readback", ahead)
  const rootBefore = await remoteTip(w.git, "refs/heads/main")
  await w.git(["checkout", "--quiet", "task/event-rival-after-readback"])
  writeFileSync(join(w.work, "resubmitted-after-marker.txt"), "new head\n")
  await w.git(["add", "resubmitted-after-marker.txt"])
  await w.git(["commit", "--quiet", "-m", "resubmit after marker"])
  const newHead = (await w.git(["rev-parse", "HEAD"])).trim()
  await w.git(["checkout", "--quiet", "main"])
  await using real = createProcess({ cwd: w.work })
  let refusal: unknown
  let attempted = false
  let childBeforeAttempt = ""
  let childAfterAttempt = ""
  const interleaved: Process = {
    ...real,
    async run(request) {
      if (!attempted && request.argv.includes("super") && request.argv.includes("push")) {
        attempted = true
        const state = await readStatus(eventStore(w), "main", "task/event-rival-after-readback")
        expect(state).toMatchObject({ status: "merging" })
        childBeforeAttempt = await submoduleMain(w)
        try {
          await submit(w.git, "origin", {
            branch: "task/event-rival-after-readback",
            submitter: "@dev/2",
            target: { branch: "main", remote: "origin" },
          })
        } catch (error) {
          refusal = error
        }
        childAfterAttempt = await submoduleMain(w)
      }
      return real.run(request)
    },
  }

  const landed = await queueRun({ ...(await w.options()), checks: [], notify: [], process: interleaved })

  expect(attempted).toBe(true)
  expect(String(refusal)).toMatch(/landing in progress.*resubmit after.*merged.*failed.*stuck.*resume/u)
  expect(childBeforeAttempt).toBe(w.main)
  expect(childAfterAttempt).toBe(w.main)
  expect(landed).toMatchObject({ exitCode: 0, merged: ["task/event-rival-after-readback"] })
  expect(await remoteTip(w.git, "refs/heads/main")).not.toBe(rootBefore)
  expect(await submoduleMain(w)).toBe(ahead)
  expect((await readStatus(eventStore(w), "main", "task/event-rival-after-readback")).status).toBe("merged")
  const resubmitted = await submit(w.git, "origin", {
    branch: "task/event-rival-after-readback",
    submitter: "@dev/2",
    target: { branch: "main", remote: "origin" },
  })
  expect(resubmitted).toMatchObject({ head: newHead, retry: false })
  expect((await readStatus(eventStore(w), "main", "task/event-rival-after-readback")).status).toBe("queued")
})

/** @failure Ignoring a merging row could move its tip after marker read-back and strand a child write.
 * @level l3 @consumer queue operator
 * Ignore must wait for settlement just like a resubmit, then be admitted.
 */
it("refuses ignore between marker read-back and child push, then admits it after landing", async () => {
  const w = await world()
  await createWorldEventQueue(w)
  const ahead = await aheadOfSubmodule(w, "event-ignore-after-readback")
  await submitGitlink(w, "task/event-ignore-after-readback", ahead)
  await w.git(["checkout", "--quiet", "task/event-ignore-after-readback"])
  writeFileSync(join(w.work, "ignored-after-marker.txt"), "new head\n")
  await w.git(["add", "ignored-after-marker.txt"])
  await w.git(["commit", "--quiet", "-m", "resubmit after ignore landing"])
  await w.git(["checkout", "--quiet", "main"])
  await using real = createProcess({ cwd: w.work })
  let refusal: unknown
  let attempted = false
  let childBeforeAttempt = ""
  let childAfterAttempt = ""
  const interleaved: Process = {
    ...real,
    async run(request) {
      if (!attempted && request.argv.includes("super") && request.argv.includes("push")) {
        attempted = true
        expect(await readStatus(eventStore(w), "main", "task/event-ignore-after-readback")).toMatchObject({
          status: "merging",
        })
        childBeforeAttempt = await submoduleMain(w)
        try {
          await setBranchIgnored(eventStore(w), {
            queue: "main",
            branch: "task/event-ignore-after-readback",
            by: "@dev/2",
            ignored: true,
            reason: "operator hold",
          })
        } catch (error) {
          refusal = error
        }
        childAfterAttempt = await submoduleMain(w)
      }
      return real.run(request)
    },
  }

  const landed = await queueRun({ ...(await w.options()), checks: [], notify: [], process: interleaved })

  expect(attempted).toBe(true)
  expect(String(refusal)).toMatch(/yrd-ignore-change-landing/u)
  expect(childBeforeAttempt).toBe(w.main)
  expect(childAfterAttempt).toBe(w.main)
  expect(landed).toMatchObject({ exitCode: 0, merged: ["task/event-ignore-after-readback"], stuck: [] })
  expect(await submoduleMain(w)).toBe(ahead)
  expect((await readStatus(eventStore(w), "main", "task/event-ignore-after-readback")).status).toBe("merged")
  await submit(w.git, "origin", {
    branch: "task/event-ignore-after-readback",
    submitter: "@dev/2",
    target: { branch: "main", remote: "origin" },
  })
  expect((await readStatus(eventStore(w), "main", "task/event-ignore-after-readback")).status).toBe("queued")
  await setBranchIgnored(eventStore(w), {
    queue: "main",
    branch: "task/event-ignore-after-readback",
    by: "@dev/2",
    ignored: true,
    reason: "operator hold",
  })
  expect((await readStatus(eventStore(w), "main", "task/event-ignore-after-readback")).ignored).toEqual({
    reason: "operator hold",
    by: "@dev/2",
  })
})

/** @failure A resumed marked landing could be cancelled by the deleted-branch prepass.
 * @level l3 @consumer queue operator
 * A missing branch name must wait while the frozen candidate settles.
 */
it("finishes a marked event after its branch is deleted before resume", async () => {
  const w = await world()
  await createWorldEventQueue(w)
  const ahead = await aheadOfSubmodule(w, "event-deleted-during-landing")
  await submitGitlink(w, "task/event-deleted-during-landing", ahead)
  const rootBefore = await remoteTip(w.git, "refs/heads/main")
  await using real = createProcess({ cwd: w.work })
  const interrupted: Process = {
    ...real,
    run(request) {
      if (request.argv.includes("super") && request.argv.includes("push")) {
        throw new Error("fixture stops after merging marker")
      }
      return real.run(request)
    },
  }
  await expect(queueRun({ ...(await w.options()), checks: [], notify: [], process: interrupted })).rejects.toThrow(
    /fixture stops after merging marker/u,
  )
  expect((await readStatus(eventStore(w), "main", "task/event-deleted-during-landing")).status).toBe("merging")
  await w.git(["push", "--quiet", "origin", ":refs/heads/task/event-deleted-during-landing"])

  const resumed = await queueRun({ ...(await w.options()), checks: [], notify: [] })

  expect(resumed).toMatchObject({ exitCode: 0, merged: ["task/event-deleted-during-landing"], stuck: [] })
  expect(await remoteTip(w.git, "refs/heads/main")).not.toBe(rootBefore)
  expect(await submoduleMain(w)).toBe(ahead)
  expect((await readStatus(eventStore(w), "main", "task/event-deleted-during-landing")).status).toBe("merged")
})

/** @failure A nested pin behind its own main could be treated as a publication target.
 * @level l3 @consumer queue operator
 * A file-only event merge must leave both component branches at their observed mains.
 */
it("keeps a nested behind-main event pin without publishing either child", async () => {
  const w = await world()
  const nested = await addNestedSubmodule(w)
  await createWorldEventQueue(w)
  await submitFile(w, "task/event-nested-behind")

  const outcome = await queueRun({ ...(await w.options()), checks: [], notify: [] })

  expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/event-nested-behind"], stuck: [] })
  expect(await submoduleMain(w)).toBe(nested.submoduleMain)
  const leaf = (
    await gitIn(w.work)(["ls-remote", "--refs", "https://git-super.test/owned/leaf.git", "refs/heads/main"])
  )
    .trim()
    .split(/\s+/u)[0]
  expect(leaf).toBe(nested.leafMain)
  expect(nested.leafRecorded).not.toBe(nested.leafMain)
})

async function gitlinkAt(w: World, commit: string): Promise<string> {
  const row = (await w.git(["ls-tree", commit, "--", "submodule"])).trim().split(/\s+/u)
  return row[2] ?? ""
}

async function advanceSubmodule(w: World, contents: string): Promise<string> {
  const submoduleWork = join(w.work, "..", "submodule-work")
  const submodule = gitIn(submoduleWork)
  await submodule(["checkout", "--quiet", "main"])
  writeFileSync(join(submoduleWork, "lib.txt"), `${contents}\n`)
  await submodule(["commit", "--quiet", "-am", contents])
  await submodule(["push", "--quiet", "origin", "main"])
  return (await submodule(["rev-parse", "HEAD"])).trim()
}

/**
 * A commit on top of the submodule's main that main does not carry yet, pushed
 * under a branch so the queue can fetch it: the shape 24454 lands through the
 * root queue, with nobody fast-forwarding the submodule by hand.
 */
async function aheadOfSubmodule(w: World, contents: string): Promise<string> {
  const submoduleWork = join(w.work, "..", "submodule-work")
  const submodule = gitIn(submoduleWork)
  await submodule(["checkout", "--quiet", "-b", `ahead-${contents}`, "main"])
  writeFileSync(join(submoduleWork, "lib.txt"), `${contents}\n`)
  await submodule(["commit", "--quiet", "-am", `${contents}, ahead of main`])
  await submodule(["push", "--quiet", "origin", `ahead-${contents}`])
  await submodule(["checkout", "--quiet", "main"])
  return (await submodule(["rev-parse", `ahead-${contents}`])).trim()
}

/**
 * A commit made in the submitter's OWN submodule checkout, on top of the
 * submodule's main, and pushed nowhere: the shape an author's bay holds after
 * committing a submodule change and before anything publishes it.
 */
async function bayOnlySubmoduleCommit(w: World, contents: string): Promise<string> {
  const sub = gitIn(join(w.work, "submodule"))
  await sub(["config", "user.email", "queue@yrd.test"])
  await sub(["config", "user.name", "yrd"])
  await sub(["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"])
  await sub(["checkout", "--quiet", "--detach", w.main])
  writeFileSync(join(w.work, "submodule", "lib.txt"), `${contents}\n`)
  await sub(["commit", "--quiet", "-am", `${contents}, only in the bay`])
  return (await sub(["rev-parse", "HEAD"])).trim()
}

async function submoduleRemoteRef(w: World, ref: string): Promise<string | undefined> {
  const tip = (await w.git(["ls-remote", "--refs", "https://git-super.test/owned/submodule.git", ref]))
    .trim()
    .split(/\s+/u)[0]
  return tip === undefined || tip === "" ? undefined : tip
}

async function submoduleMain(w: World): Promise<string> {
  const tip = (await w.git(["ls-remote", "--refs", "https://git-super.test/owned/submodule.git", "refs/heads/main"]))
    .trim()
    .split(/\s+/u)[0]
  if (tip === undefined || tip === "") throw new Error("the submodule remote has no main")
  return tip
}

/** Whether the submodule remote's `of` contains `ancestor`: their merge base is `ancestor` itself. */
async function isAncestorIn(w: World, ancestor: string, of: string): Promise<boolean> {
  const submodule = gitIn(join(w.work, "..", "submodule-work"))
  await submodule(["fetch", "--quiet", "origin"])
  return (await submodule(["merge-base", ancestor, of])).trim() === ancestor
}

/** A second owned child remote, with an unpublished commit ahead of its main. */
async function addSecondChild(w: World): Promise<Readonly<{ main: string; ahead: string; remote: string }>> {
  const root = dirname(w.work)
  const remote = join(root, "other.git")
  const work = join(root, "other-work")
  process.env.GIT_CONFIG_COUNT = "4"
  process.env.GIT_CONFIG_KEY_3 = `url.${remote}.insteadOf`
  process.env.GIT_CONFIG_VALUE_3 = "https://git-super.test/owned/other.git"
  const rootGit = gitIn(w.work)
  await rootGit(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await rootGit(["clone", "--quiet", remote, work])
  const other = gitIn(work)
  await other(["config", "user.email", "queue@yrd.test"])
  await other(["config", "user.name", "yrd"])
  await other(["remote", "set-url", "origin", "https://git-super.test/owned/other.git"])
  await other(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, "other.txt"), "base\n")
  await other(["add", "other.txt"])
  await other(["commit", "--quiet", "-m", "other base"])
  const main = (await other(["rev-parse", "HEAD"])).trim()
  await other(["push", "--quiet", "origin", "main"])
  await other(["checkout", "--quiet", "-b", "ahead", "main"])
  writeFileSync(join(work, "other.txt"), "ahead\n")
  await other(["commit", "--quiet", "-am", "other ahead"])
  const ahead = (await other(["rev-parse", "HEAD"])).trim()
  await other(["push", "--quiet", "origin", "ahead"])
  await other(["checkout", "--quiet", "main"])
  await rootGit(["checkout", "--quiet", "main"])
  await rootGit(["submodule", "add", "--quiet", "https://git-super.test/owned/other.git", "other"])
  await rootGit(["add", ".gitmodules", "other"])
  await rootGit(["commit", "--quiet", "-m", "add second owned component"])
  await rootGit(["push", "--quiet", "origin", "main"])
  return { main, ahead, remote }
}

async function submitTwoChildren(w: World, branch: string, otherAhead: string, subAhead: string): Promise<void> {
  const rootGit = gitIn(w.work)
  await rootGit(["checkout", "--quiet", "-b", branch, "main"])
  for (const [path, sha] of [
    ["other", otherAhead],
    ["submodule", subAhead],
  ] as const) {
    const child = gitIn(join(w.work, path))
    await child(["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"])
    await child(["checkout", "--quiet", sha])
  }
  await rootGit(["add", "other", "submodule"])
  await rootGit(["commit", "--quiet", "-m", `${branch}: advance both components`])
  await rootGit(["checkout", "--quiet", "main"])
  await submit(rootGit, "origin", { branch, submitter: "@dev/2", target: { branch: "main", remote: "origin" } })
}

/**
 * One level deeper than `world()`: `apps/leaf` inside the submodule, which is
 * the shape `km/apps/maddoc` has in production.
 *
 * The leaf's own main is then moved ON, so the pin the submodule records for it
 * is BEHIND. That is the ordinary resting state of a nested pin -- the leaf's
 * main moves independently of the parent that records it -- and it is what
 * makes `kept-behind` the common case rather than an exotic one.
 */
async function addNestedSubmodule(
  w: World,
): Promise<Readonly<{ leafRecorded: string; leafMain: string; submoduleMain: string }>> {
  const root = join(w.work, "..")
  const seed = gitIn(root)
  // A fourth transport rewrite, beside the three `world()` declared. Ownership
  // is decided on the hosted identity, so the leaf needs one of its own or
  // git-super records it `as-written` and never asks its main anything.
  process.env.GIT_CONFIG_COUNT = "4"
  process.env.GIT_CONFIG_KEY_3 = `url.${join(root, "leaf.git")}.insteadOf`
  process.env.GIT_CONFIG_VALUE_3 = "https://git-super.test/owned/leaf.git"

  const leaf = join(root, "leaf.git")
  const leafWork = join(root, "leaf-work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", leaf])
  await seed(["clone", "--quiet", leaf, leafWork])
  const lg = gitIn(leafWork)
  await lg(["config", "user.email", "queue@yrd.test"])
  await lg(["config", "user.name", "yrd"])
  await lg(["remote", "set-url", "origin", "https://git-super.test/owned/leaf.git"])
  await lg(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(leafWork, "leaf.txt"), "leaf one\n")
  await lg(["add", "leaf.txt"])
  await lg(["commit", "--quiet", "-m", "leaf one"])
  await lg(["push", "--quiet", "origin", "main"])
  const leafRecorded = (await lg(["rev-parse", "HEAD"])).trim()

  const submoduleWork = join(root, "submodule-work")
  const sg = gitIn(submoduleWork)
  await sg(["checkout", "--quiet", "main"])
  await sg(["submodule", "add", "--quiet", "https://git-super.test/owned/leaf.git", "apps/leaf"])
  await sg(["add", ".gitmodules", "apps/leaf"])
  await sg(["commit", "--quiet", "-m", "the submodule gains a nested app"])
  await sg(["push", "--quiet", "origin", "main"])
  const submoduleMain = (await sg(["rev-parse", "HEAD"])).trim()

  // The leaf's main moves on AFTER the submodule pinned it, so the recorded
  // nested pin is behind its own main without anybody doing anything wrong.
  writeFileSync(join(leafWork, "leaf.txt"), "leaf two\n")
  await lg(["commit", "--quiet", "-am", "leaf two"])
  await lg(["push", "--quiet", "origin", "main"])
  const leafMain = (await lg(["rev-parse", "HEAD"])).trim()

  const sub = gitIn(join(w.work, "submodule"))
  await w.git(["checkout", "--quiet", "main"])
  await sub(["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"])
  await sub(["checkout", "--quiet", submoduleMain])
  // The queue BORROWS from this checkout as its reference, and git-super
  // refuses to borrow from a reference that carries no store for a gitlink --
  // at any depth. Without this the run ends stuck on "the reference holds no
  // object store for apps/leaf", which is the materializer doing its job and
  // says nothing about the state under test.
  await sub(["submodule", "update", "--init", "--recursive"])
  await w.git(["add", "submodule"])
  await w.git(["commit", "--quiet", "-m", "root records the submodule that carries the nested app"])
  await w.git(["push", "--quiet", "origin", "main"])
  return { leafMain, leafRecorded, submoduleMain }
}

describe("settling gitlinks", () => {
  it("resolves the candidate workspace's git-super bin relative to this test file", async () => {
    expect(gitSuperBin).toBe(resolve(import.meta.dirname, "../../../../git-super/bin"))
    expect(existsSync(gitSuperBin)).toBe(true)
    expect(gitSuperBin).toContain("/vendor/git-super/bin")
    expect(existsSync(join(gitSuperBin, "git-super"))).toBe(true)
    const w = await world()
    const options = await w.options()
    expect(options.env?.PATH?.split(":")[0]).toBe(gitSuperBin)
  })

  // The shared verifier applies git-super's pin verdict before opening a change. The pin forks
  // from main and both sides changed lib.txt, so git-super composes it and refuses the conflict
  // (25389), naming the file and the component merge.
  it("yrd submit refuses a forked gitlink whose component merge conflicts, naming the file", async () => {
    const w = await world()
    await expect(submitGitlink(w, "task/off", w.offMain)).rejects.toThrow(
      new RegExp(`gitlink-compose-refused.*lib\\.txt.*${w.offMain} forks from submodule main ${w.main}`, "u"),
    )
  })

  it("a pin that is an ancestor of refs/heads/main submits silently", async () => {
    const w = await world()
    await expect(submitGitlink(w, "task/behind", w.onMain)).resolves.toMatch(/^[0-9a-f]{40}$/u)
  })

  // D1 (24454, 2026-09-10): a pin that diverged from its submodule's main is
  // the submitter's defect and FAILS back to them. It used to wait (H5) for a
  // person to move main under it; the queue now moves main itself, forward only,
  // so nothing could ever clear that wait. 24463 now refuses at submit; the
  // merge-time failure remains for a change opened by hand. Since 25389 a clean fork is composed
  // instead; this one conflicts in lib.txt, so it is still the submitter's.
  it("an off-main gitlink fails back to its submitter while the next change proceeds", async () => {
    const w = await world()
    await expect(submitGitlink(w, "task/off", w.offMain)).rejects.toThrow(/gitlink-compose-refused/u)
    await submitFile(w, "task/next")

    const outcome = await queueRun(await w.options())

    // 24463: the diverged pin never entered the queue. The next change proceeds.
    expect(outcome).toMatchObject({ exitCode: 0, failed: [], merged: ["task/next"], stuck: [] })

    // The submitter's cure: put the pin on submodule main, then submit again.
    const submoduleWork = join(w.work, "..", "submodule-work")
    const submodule = gitIn(submoduleWork)
    await submodule(["checkout", "--quiet", "main"])
    await submodule(["merge", "--quiet", "--no-ff", "-s", "ours", "-m", "merge feature", "feature"])
    await submodule(["push", "--quiet", "origin", "main"])
    const submoduleMain = (await submodule(["rev-parse", "HEAD"])).trim()
    // The submitter's root checkout follows main, which task/next moved.
    await w.git(["fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main"])
    await w.git(["checkout", "--quiet", "main"])
    await w.git(["merge", "--quiet", "--ff-only", "origin/main"])
    const resubmitted = await submitGitlink(w, "task/off-rebased", w.offMain)

    const retried = await queueRun(await w.options())

    expect(retried).toMatchObject({ exitCode: 0, failed: [], merged: ["task/off-rebased"], stuck: [] })
    expect(
      (
        await readRecords(
          w.git,
          await remoteTip(w.git, changeRef("main", { branch: "task/off-rebased", head: resubmitted })),
        )
      ).map((record) => record.kind),
    ).toEqual(["opened", "checked", "merged", "sent"])
    expect(await gitlinkAt(w, await remoteTip(w.git, "refs/heads/main"))).toBe(submoduleMain)
  })

  // 24408 kept its teeth after D1: the failure's journal row must stay readable
  // by every read verb, and carries no half-written incident (a failed change
  // is the submitter's, not a queue incident).
  it("an off-main pin never opens a change, so readers see no incident", async () => {
    const w = await world()
    await expect(submitGitlink(w, "task/off", w.offMain)).rejects.toThrow(/gitlink-compose-refused/u)
    const head = await submitFile(w, "task/file")

    const outcome = await queueRun(await w.options())

    expect(outcome).toMatchObject({ exitCode: 0, failed: [], merged: ["task/file"], stuck: [] })
    const read = () => readJournals(dirname(outcome.log))
    expect(read).not.toThrow()
    expect(read().runs.get(journalKey("task/off", head))).toBeUndefined()
    expect(read().runs.get(journalKey("task/file", head))?.[0]?.incident).toBeUndefined()
  })

  // 24454: a submodule change lands through the ROOT queue. The authored pin is
  // ahead of the submodule's main; git-super keeps it (kept-ahead) and freezes
  // its publication into the merge, and the queue publishes that intent at
  // land: the submodule's main first, root main last. Nobody fast-forwards the
  // submodule by hand, and no submodule main moves before the root merge has
  // passed every check.
  it("an authored gitlink ahead of submodule main lands with that main advanced to it, children first", async () => {
    const w = await world()
    const ahead = await aheadOfSubmodule(w, "four")
    expect(await submoduleMain(w)).toBe(w.main)
    const head = await submitGitlink(w, "task/ahead", ahead)
    const outcome = await queueRun(await w.options())

    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/ahead"])
    const target = await remoteTip(w.git, "refs/heads/main")
    expect(await gitlinkAt(w, target)).toBe(ahead)
    // The queue advanced the submodule's main to the landed pin: a fresh
    // recursive clone of root main fetches it from main, not from a branch.
    expect(await submoduleMain(w)).toBe(ahead)
    const message = await w.git(["show", "-s", "--format=%B", target])
    expect(message).toContain(`Change: task/ahead@${head}`)
    expect(message).toContain(`Settled: submodule@${ahead} kept-ahead submodule-main@${w.main}`)
    const merged = (
      await readRecords(w.git, await remoteTip(w.git, changeRef("main", { branch: "task/ahead", head })))
    ).find((record) => record.kind === "merged")
    expect(merged).toBeDefined()
    expect(trailer(merged!, "Merge")).toBe(target)
    // The published child is on the record, so a reader of the record alone
    // knows which submodule main this landing moved and to what.
    expect(trailer(merged!, "Published")).toBe(`submodule ${w.main} -> ${ahead}`)
  })

  // 25570 (@cto 0de59b3c): a head judged and merged in one round is composed once. The merge phase stands on the
  // same target with the same head and message, so git-super's merge would read every child main again for the
  // commit the submit phase already made; it reuses that commit and says so in the journal.
  it("composes a head judged and merged in one round once, and lands it exactly as a second compose would", async () => {
    const w = await world()
    const ahead = await aheadOfSubmodule(w, "once")
    const head = await submitGitlink(w, "task/once", ahead)
    const outcome = await queueRun(await w.options())

    expect(outcome.merged).toEqual(["task/once"])
    const rows = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const composes = rows.filter(
      (row) => row.kind === "step" && row.name === "compose" && row.end !== undefined && row.within === undefined,
    )
    expect(composes.map((row) => row.phase)).toEqual(["submit"])
    const reused = rows.filter((row) => row.kind === "observation" && row.subject === "compose-reused")
    expect(reused).toMatchObject([{ branch: "task/once", head, phase: "merge", from: "submit" }])
    // The reused commit is the one that landed, with the same settling a fresh compose writes.
    const target = await remoteTip(w.git, "refs/heads/main")
    expect(target).toBe(reused[0]?.candidate)
    expect(await gitlinkAt(w, target)).toBe(ahead)
    expect(await submoduleMain(w)).toBe(ahead)
    expect(await w.git(["show", "-s", "--format=%B", target])).toContain(
      `Settled: submodule@${ahead} kept-ahead submodule-main@${w.main}`,
    )
  })

  // 25570: a component main that moves after the submit phase composes makes the stored compose's lease stale, so the
  // merge phase composes fresh over the moved main instead of publishing a lease the remote refuses (the edge row
  // @dev/review-adhoc5 measured stuck on the compose-once head; @cto c3facf63, 298075b8).
  it("composes fresh when a component main moved after the submit compose, and lands over the moved main", async () => {
    const w = await world()
    const ahead = await aheadOfSubmodule(w, "edge")
    await submitGitlink(w, "task/edge", ahead)
    await using real = createProcess({ cwd: w.work })
    let composes = 0
    let moved = ""
    const racing: Process = {
      ...real,
      async run(request) {
        const result = await real.run(request)
        if (request.argv.includes("super") && request.argv.includes("merge") && composes++ === 0) {
          const submoduleWork = join(w.work, "..", "submodule-work")
          const submodule = gitIn(submoduleWork)
          await submodule(["checkout", "--quiet", "main"])
          writeFileSync(join(submoduleWork, "unrelated.txt"), "moved between the phases\n")
          await submodule(["add", "unrelated.txt"])
          await submodule(["commit", "--quiet", "-m", "an unrelated commit on component main"])
          await submodule(["push", "--quiet", "origin", "main"])
          moved = (await submodule(["rev-parse", "HEAD"])).trim()
        }
        return result
      },
    }
    const outcome = await queueRun({ ...(await w.options()), process: racing })

    expect(moved).not.toBe("")
    expect(outcome.stuck).toEqual([])
    expect(outcome.merged).toEqual(["task/edge"])
    const rows = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(rows.filter((row) => row.subject === "compose-reused")).toEqual([])
    expect(rows.filter((row) => row.subject === "compose-reuse-refused")).toMatchObject([
      { branch: "task/edge", phase: "merge", path: "submodule", expected: w.main, saw: moved },
    ])
    const composed = rows.filter(
      (row) => row.kind === "step" && row.name === "compose" && row.end !== undefined && row.within === undefined,
    )
    expect(composed.map((row) => row.phase)).toEqual(["submit", "merge"])
    // The landed component main holds both the racing commit and the change's pin.
    const childMain = await submoduleMain(w)
    expect(await isAncestorIn(w, moved, childMain)).toBe(true)
    expect(await isAncestorIn(w, ahead, childMain)).toBe(true)
  })

  // 24454: the whole landing is one ordinary submit of the root. The author
  // committed inside the submodule and bumped the gitlink; nothing else was
  // pushed. Submit publishes the moved pin to the submodule's remote under
  // git-super's retention ref, create-only and named by the oid, so the queue
  // can fetch it, judge the whole tree, and move the submodule's main itself.
  it("a submit publishes a moved gitlink's commit the submodule remote lacks, and the queue lands it", async () => {
    const w = await world()
    const pin = await bayOnlySubmoduleCommit(w, "five")
    expect(await submoduleRemoteRef(w, `refs/git-super/pins/${pin}`)).toBeUndefined()
    const head = await submitGitlink(w, "task/bay-only", pin)
    // Published at submit, before the change was opened: the retention ref
    // names exactly the pin, and the submodule's main has not moved.
    expect(await submoduleRemoteRef(w, `refs/git-super/pins/${pin}`)).toBe(pin)
    expect(await submoduleMain(w)).toBe(w.main)
    const outcome = await queueRun(await w.options())

    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/bay-only"])
    const target = await remoteTip(w.git, "refs/heads/main")
    expect(await gitlinkAt(w, target)).toBe(pin)
    expect(await submoduleMain(w)).toBe(pin)
    const merged = (
      await readRecords(w.git, await remoteTip(w.git, changeRef("main", { branch: "task/bay-only", head })))
    ).find((record) => record.kind === "merged")
    expect(merged).toBeDefined()
    expect(trailer(merged!, "Published")).toBe(`submodule ${w.main} -> ${pin}`)
  })

  /**
   * @i/10-yrd/25475
   * yrd's push execution must set GIT_SUPER_PROGRESS=1 so git-super's push
   * progress and heartbeat are activated, and the CLI's stderr from that push,
   * heartbeat rows included, must be preserved in the round's evidence.
   */
  it("sets GIT_SUPER_PROGRESS=1 on push execution and preserves push stderr heartbeat rows in round evidence (25475)", async () => {
    const w = await world()
    const pin = await bayOnlySubmoduleCommit(w, "five")
    const head = await submitGitlink(w, "task/push-heartbeat", pin)

    await using real = createProcess({ cwd: w.work })
    let pushEnvProgress: string | undefined
    let publishingCount = 0
    const tracking: Process = {
      ...real,
      async run(request) {
        const publishing =
          request.argv.includes("super") &&
          request.argv.includes("push") &&
          request.argv.includes("--recurse-submodules=only")
        if (publishing) {
          publishingCount++
          pushEnvProgress = request.env?.GIT_SUPER_PROGRESS
        }
        return real.run(request)
      },
    }

    const outcome = await queueRun({ ...(await w.options()), process: tracking })
    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/push-heartbeat"])
    expect(publishingCount).toBe(1)

    // Acceptance 1: yrd sets GIT_SUPER_PROGRESS=1 on its push execution, and a test asserts the variable reaches the push.
    expect(pushEnvProgress).toBe("1")

    // Acceptance 2: The CLI's stderr from that push, heartbeat lines included, is kept in the round's evidence, with a test.
    const runRecords = readFileSync(outcome.log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)

    const pushInvocations = runRecords.filter(
      (record) =>
        record.kind === "git" &&
        Array.isArray(record.args) &&
        record.args.includes("super") &&
        record.args.includes("push") &&
        record.args.includes("--recurse-submodules=only"),
    )
    expect(pushInvocations.length).toBe(1)
    const pushRecord = pushInvocations[0]!
    expect(typeof pushRecord.evidence).toBe("string")
    expect(existsSync(String(pushRecord.evidence))).toBe(true)

    const evidence = JSON.parse(readFileSync(String(pushRecord.evidence), "utf8")) as {
      artifacts: { stdout: string; stderr: string }
    }
    expect(existsSync(evidence.artifacts.stderr)).toBe(true)
    const pushStderr = readFileSync(evidence.artifacts.stderr, "utf8")
    expect(pushStderr).toContain("git-super push:")
    expect(pushStderr).toMatch(/^git-super push: select-root \d+\/\d+/mu)
  })

  /** @failure A linked author's private module store is absent from git-super's durable scratch borrow. */
  it("previews an unpublished pin from a linked worktree without publishing it", async () => {
    const w = await world()
    const bay = join(w.work, "..", "linked-author")
    await w.git([
      "super",
      "--json",
      "worktree",
      "add",
      bay,
      await remoteTip(w.git, "refs/heads/main"),
      "--reference",
      w.work,
    ])
    const author = gitIn(bay)
    await author(["checkout", "--quiet", "-b", "task/linked-author"])
    const child = gitIn(join(bay, "submodule"))
    await child(["config", "user.email", "queue@yrd.test"])
    await child(["config", "user.name", "yrd"])
    writeFileSync(join(bay, "submodule", "lib.txt"), "private linked commit\n")
    await child(["commit", "--quiet", "-am", "private linked commit"])
    const pin = (await child(["rev-parse", "HEAD"])).trim()
    await author(["add", "submodule"])
    await author(["commit", "--quiet", "-m", "task/linked-author: move private pin"])
    const rejectingHooks = join(w.work, "..", "rejecting-hooks")
    mkdirSync(rejectingHooks)
    writeFileSync(join(rejectingHooks, "pre-commit"), "#!/bin/sh\nexit 86\n")
    chmodSync(join(rejectingHooks, "pre-commit"), 0o755)
    await author(["config", "core.hooksPath", rejectingHooks])

    const preview = await inspectSubmit(author, "origin", {
      branch: "task/linked-author",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })
    expect(preview.verifying).toMatchObject({
      state: "verified",
      gitlinks: [{ path: "submodule", state: "kept-ahead" }],
    })
    expect(await submoduleRemoteRef(w, `refs/git-super/pins/${pin}`)).toBeUndefined()
  })

  // The same submit, retried at the same head: the retention ref already
  // names the pin, which is the one identical write a create-only ref accepts.
  it("a retried submit finds its moved pin already retained and opens the retry", async () => {
    const w = await world()
    const pin = await bayOnlySubmoduleCommit(w, "six")
    const head = await submitGitlink(w, "task/bay-only-twice", pin)
    expect(await submoduleRemoteRef(w, `refs/git-super/pins/${pin}`)).toBe(pin)
    const again = await submit(w.git, "origin", {
      branch: "task/bay-only-twice",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })
    expect(again).toMatchObject({ head, retry: true })
    expect(await submoduleRemoteRef(w, `refs/git-super/pins/${pin}`)).toBe(pin)
  })

  // 24454, the partial-failure rule: the submodule main is published, then
  // the root push is refused because root main moved under its lease (a
  // direct merge, or another queue). That is the one partial state this
  // landing accepts: the change keeps its place, nothing is stuck, and the
  // next run composes on the new root main where the published pin reads as
  // Equal, so the landing finishes with no second publication.
  it("a published child under a refused root push keeps the change in place, and the next run lands it", async () => {
    const w = await world()
    const ahead = await aheadOfSubmodule(w, "seven")
    const head = await submitGitlink(w, "task/partial", ahead)
    let rootPushesSeen = 0
    let movedAround = ""
    using _publication = beforeGitomicPublish(async (_repo, updates, remote) => {
      const rootPush = remote !== undefined && updates.some((update) => update.ref === "refs/heads/main")
      if (rootPush && rootPushesSeen++ === 0) {
        // Between the children's publication and the root push, root main
        // moves around the queue: the lease must refuse, and nothing else.
        expect(await submoduleMain(w)).toBe(ahead)
        await w.git(["checkout", "--quiet", "main"])
        writeFileSync(join(w.work, "around.txt"), "around the queue\n")
        await w.git(["add", "around.txt"])
        await w.git(["commit", "--quiet", "-m", "a file landed around the queue"])
        await w.git(["push", "--quiet", "origin", "main"])
        movedAround = (await w.git(["rev-parse", "HEAD"])).trim()
      }
    })
    const first = await queueRun(await w.options())
    expect(first.exitCode).toBe(0)
    expect(first.merged).toEqual([])
    expect(first.stuck).toEqual([])
    expect(rootPushesSeen).toBe(1)
    // The partial state, exactly: submodule main moved, root main did not take the merge.
    expect(await submoduleMain(w)).toBe(ahead)
    expect(await remoteTip(w.git, "refs/heads/main")).toBe(movedAround)
    const firstRows = readFileSync(first.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(firstRows.find((row) => row.kind === "publish")).toMatchObject({
      path: "submodule",
      from: w.main,
      to: ahead,
    })
    expect(firstRows.find((row) => row.kind === "change" && row.decision === "checked")).toMatchObject({
      reason: "target-moved",
    })
    // The landing record is on the change ref, and it says what was published.
    const ref = changeRef("main", { branch: "task/partial", head })
    const landing = (await readRecords(w.git, await remoteTip(w.git, ref))).at(-1)
    expect(landing?.kind).toBe("checked")
    expect(trailer(landing!, "Publishing")).toBe(`submodule ${w.main} -> ${ahead}`)

    const second = await queueRun(await w.options())
    expect(second.exitCode).toBe(0)
    expect(second.merged).toEqual(["task/partial"])
    const target = await remoteTip(w.git, "refs/heads/main")
    expect(await gitlinkAt(w, target)).toBe(ahead)
    expect(await submoduleMain(w)).toBe(ahead)
    expect((await w.git(["rev-parse", `${target}^1`])).trim()).toBe(movedAround)
    const secondRows = readFileSync(second.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    // Nothing to publish the second time: the pin now equals the submodule's main.
    expect(secondRows.find((row) => row.kind === "publish")).toBeUndefined()
    const merged = (await readRecords(w.git, await remoteTip(w.git, ref))).find((record) => record.kind === "merged")
    expect(merged).toBeDefined()
    expect(trailer(merged!, "Published")).toBeUndefined()
  })

  it("a held-back authored gitlink merges raised and keeps the submitted Change identity", async () => {
    const w = await world()
    const head = await submitGitlink(w, "task/on", w.onMain)
    // Existing merge results cannot prove the cleanup ordering: observe real
    // producer bytes and require the remote terminal record before deletion.
    const produced = new Map<string, string>()
    let cleaned = false
    await using real = createProcess({ cwd: w.work })
    const observing: Process = {
      ...real,
      async run(request) {
        const result = await real.run(request)
        if (result.exitCode === 0 && request.argv.includes("merge") && request.argv.includes("super")) {
          const merge = (JSON.parse(result.stdout) as { commit: string }).commit
          const bytes = await w.git(["show", `refs/git-super/receipts/${merge}:receipt.json`])
          produced.set(merge, Buffer.from(bytes, "utf8").toString("base64"))
        }
        return result
      },
    }
    using _publication = beforeGitomicPublish(async (_repo, updates) => {
      const deletion = updates.find(
        (update) => update.oid === null && update.ref.startsWith("refs/git-super/receipts/"),
      )
      if (deletion === undefined) return
      const merge = deletion.ref.slice("refs/git-super/receipts/".length)
      expect(await remoteTip(w.git, "refs/heads/main")).toBe(merge)
      const record = (
        await readRecords(w.git, await remoteTip(w.git, changeRef("main", { branch: "task/on", head })))
      ).find((row) => row.kind === "merged")
      expect(record).toBeDefined()
      expect(trailer(record!, "Root-Changes")).toBe(produced.get(merge))
      cleaned = true
    })
    const outcome = await queueRun({ ...(await w.options()), process: observing })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/on"])
    const target = await remoteTip(w.git, "refs/heads/main")
    expect(await gitlinkAt(w, target)).toBe(w.main)
    const message = await w.git(["show", "-s", "--format=%B", target])
    expect(message).toContain(`Change: task/on@${head}`)
    expect(message).toContain(`Settled: submodule@${w.main}`)
    const merge = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record.kind === "merge")
    expect(merge?.gitlinks).toContain(`submodule ${w.onMain} -> ${w.main}`)
    // The durable terminal record copies the exact producer bytes, and survives
    // removal of the temporary local receipt; old merge-result tests miss this.
    const ref = changeRef("main", { branch: "task/on", head })
    const recordTip = await remoteTip(w.git, ref)
    const records = await readRecords(w.git, recordTip)
    const merged = records.find((record) => record.kind === "merged")
    expect(merged).toBeDefined()
    const receiptRef = `refs/git-super/receipts/${target}`
    const copied = produced.get(target)
    expect(copied).toBeDefined()
    expect(trailer(merged!, "Root-Changes")).toBe(copied)
    expect(cleaned).toBe(true)
    expect((await w.git(["for-each-ref", "--format=%(refname)", receiptRef])).trim()).toBe("")
    expect(
      trailer((await readRecords(w.git, recordTip)).find((record) => record.kind === "merged")!, "Root-Changes"),
    ).toBe(copied)
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

    const outcome = await queueRun(await w.options())

    expect(outcome).toMatchObject({ exitCode: 0, failed: [], merged: ["task/hook-isolation"], stuck: [] })
    expect(existsSync(observed)).toBe(false)
    const target = await remoteTip(w.git, "refs/heads/main")
    expect((await w.git(["rev-list", "--parents", "-n", "1", target])).trim().split(" ")).toHaveLength(3)
    expect(await w.git(["show", "-s", "--format=%B", target])).toContain(`Settled: submodule@${w.main}`)
    expect(await gitlinkAt(w, target)).toBe(w.main)
    expect(
      (
        await readRecords(w.git, await remoteTip(w.git, changeRef("main", { branch: "task/hook-isolation", head })))
      ).map((record) => record.kind),
    ).toEqual(["opened", "checked", "merged", "sent"])
  })

  /** An anomaly already on root main is not the candidate's authorship, but every merge that passes over it must expose it. */
  it("an untouched off-main target gitlink stays put and is reported in the run log", async () => {
    const w = await world()
    await gitlinkAroundQueue(w, w.offMain)
    await submitFile(w, "task/pass-over-off-main")

    const outcome = await queueRun(await w.options())

    expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/pass-over-off-main"] })
    const target = await remoteTip(w.git, "refs/heads/main")
    expect(await gitlinkAt(w, target)).toBe(w.offMain)
    expect(await w.git(["show", "-s", "--format=%(trailers:key=Settled,valueonly)", target])).toContain(
      `submodule@${w.offMain} left-off-main submodule-main@${w.main}`,
    )
    const settle = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.kind === "settle")
    expect(settle).toContainEqual(
      expect.objectContaining({
        from: w.offMain,
        path: "submodule",
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

    const outcome = await queueRun(await w.options())

    expect(outcome).toMatchObject({ exitCode: 1, failed: ["task/missing"], merged: ["task/next"], stuck: [] })
    const records = await readRecords(
      w.git,
      await remoteTip(w.git, changeRef("main", { branch: "task/missing", head })),
    )
    expect(records.map((record) => record.kind)).toEqual(["opened", "failed", "sent"])
    const failed = records.find((record) => record.kind === "failed")
    expect(trailer(failed!, "Fault")).toBe("submitter")
    expect(trailer(failed!, "Reason")).toContain(missing)
    expect(failed?.subject).toContain("submodule")
  })

  it("normalizes an unrecognized git-super failure without losing its boundary detail", async () => {
    const w = await world()
    const head = await submitGitlink(w, "task/unreadable-main", w.onMain)
    const missing = join(w.work, "missing-submodule.git")
    let external: Readonly<{ code: string; phase: string; message: string }> | undefined
    await using real = createProcess({ cwd: w.work })
    const observing: Process = {
      ...real,
      async run(request) {
        const merge =
          request.argv.includes("merge") && (request.argv[0] === "git-super" || request.argv.includes("super"))
        if (merge) await gitIn(join(request.cwd ?? w.work, "submodule"))(["remote", "set-url", "origin", missing])
        const result = await real.run(request)
        if (merge) {
          external = (
            JSON.parse(result.stdout) as Readonly<{
              detail?: Readonly<{ code: string; phase: string; message: string }>
            }>
          ).detail
        }
        return result
      },
    }

    const outcome = await queueRun({ ...(await w.options()), process: observing })

    expect(outcome).toMatchObject({ exitCode: 2, failed: [], merged: [], stuck: ["task/unreadable-main"] })
    expect(external).toMatchObject({ code: "git-failed", phase: "resolve-submodule-branch" })
    const records = await readRecords(
      w.git,
      await remoteTip(w.git, changeRef("main", { branch: "task/unreadable-main", head })),
    )
    expect(records.map((record) => record.kind)).toEqual(["opened", "stuck", "sent"])
    const stuck = records[1]!
    expect(trailer(stuck, "Code")).toBe("yrd-merge-unresolved")
    expect(trailer(stuck, "Subject")).toContain("submodule")
    expect(trailer(stuck, "Via")).toContain("git-failed")
    expect(trailer(stuck, "Via")).toContain("resolve-submodule-branch")
    expect(trailer(stuck, "Evidence")).toBe(outcome.log)
    expect(trailer(stuck, "Owner")).toBe("the queue operator")
    expect(trailer(records[2]!, "Owner")).toBe("the queue operator")
    if (external === undefined) throw new Error("git-super returned no failure detail")
    const evidence = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(evidence.filter((record) => record.kind === "change" && record.head === head)).toEqual([
      expect.objectContaining({
        branch: "task/unreadable-main",
        code: "yrd-merge-unresolved",
        decision: "stuck",
        diagnosisCode: external.code,
        phase: external.phase,
        reason: external.message,
      }),
    ])
  })

  it("a candidate failure introduced by raising submodule main is queue-owned stuck", async () => {
    const w = await world()
    const breaking = await advanceSubmodule(w, "breaking submodule main")
    const head = await submitFile(w, "task/base-red")

    // Attribution comes from the validated root receipt even if the old CLI
    // merge-result rows contain no raises; the real producer and refs stay intact.
    await using real = createProcess({ cwd: w.work })
    let stripped = false
    const observing: Process = {
      ...real,
      async run(request) {
        const result = await real.run(request)
        if (result.exitCode === 0 && request.argv.includes("merge") && request.argv.includes("super")) {
          stripped = true
          const merge = JSON.parse(result.stdout) as Record<string, unknown>
          return { ...result, stdout: JSON.stringify({ ...merge, gitlinks: [] }) }
        }
        return result
      },
    }
    const outcome = await queueRun({
      ...(await w.options({ on: ["submit"], run: "! grep -q 'breaking submodule main' submodule/lib.txt" })),
      process: observing,
    })

    expect(stripped).toBe(true)
    expect(outcome).toMatchObject({ exitCode: 2, failed: [], merged: [], stuck: ["task/base-red"] })
    const records = await readRecords(
      w.git,
      await remoteTip(w.git, changeRef("main", { branch: "task/base-red", head })),
    )
    const stuck = records.find((record) => record.kind === "stuck")
    expect(trailer(stuck!, "Code")).toBe("yrd-submodule-main-regression")
    expect(trailer(stuck!, "Subject")).toContain("submodule")
    expect(trailer(stuck!, "Subject")).toContain(breaking)
    expect(trailer(stuck!, "Evidence")).toBe(outcome.log)
    expect(trailer(stuck!, "Next")).toContain("yrd queue run")
    expect(
      records
        .filter((record) => record.kind === "stuck" || record.kind === "sent")
        .map((record) => trailer(record, "Owner")),
    ).toEqual(["the queue operator", "the queue operator"])
    expect(trailer(stuck!, "Fault")).toBeUndefined()
    const phases = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.kind === "result" && record.name === "submodule-check")
      .map((record) => record.phase)
    expect(phases).toEqual(["submit", "base"])
  })

  /** A missing receipt claims no automatic changes; a malformed present receipt stops before candidate checks. */
  it.each(["absent", "malformed"] as const)(
    "treats an %s root receipt according to its declared contract",
    async (fault) => {
      const w = await world()
      await advanceSubmodule(w, "breaking submodule main")
      await submitFile(w, `task/receipt-${fault}`)
      await using real = createProcess({ cwd: w.work })
      const observing: Process = {
        ...real,
        async run(request) {
          const result = await real.run(request)
          if (result.exitCode === 0 && request.argv.includes("merge") && request.argv.includes("super")) {
            const merge = (JSON.parse(result.stdout) as { commit: string }).commit
            const ref = `refs/git-super/receipts/${merge}`
            const prior = (await w.git(["rev-parse", ref])).trim()
            await w.git(fault === "absent" ? ["update-ref", "-d", ref, prior] : ["update-ref", ref, merge, prior])
          }
          return result
        },
      }
      const outcome = await queueRun({
        ...(await w.options({ on: ["submit"], run: "exit 1" })),
        process: observing,
      })
      expect(outcome.exitCode).toBe(fault === "absent" ? 1 : 2)
      const phases = readFileSync(outcome.log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((record) => record.kind === "result" && record.name === "submodule-check")
        .map((record) => record.phase)
      expect(phases).toEqual(fault === "absent" ? ["submit"] : [])
      if (fault === "malformed") expect(readFileSync(outcome.log, "utf8")).toContain("Root-Changes")
    },
  )

  /** Attribution must compare candidate-minus-content even when root main's old gitlink is divergent, not silently keep that old tree. */
  it("the settled-base comparator applies a raise over an off-main target gitlink", async () => {
    const w = await world()
    await gitlinkAroundQueue(w, w.offMain)
    const head = await submitGitlink(w, "task/repair-off-main", w.onMain)

    const outcome = await queueRun(await w.options({ on: ["submit"], run: "! grep -q '^three$' submodule/lib.txt" }))

    expect(outcome).toMatchObject({ exitCode: 2, failed: [], merged: [], stuck: ["task/repair-off-main"] })
    const records = await readRecords(
      w.git,
      await remoteTip(w.git, changeRef("main", { branch: "task/repair-off-main", head })),
    )
    const stuck = records.find((record) => record.kind === "stuck")
    expect(trailer(stuck!, "Code")).toBe("yrd-submodule-main-regression")
    expect(trailer(stuck!, "Subject")).toContain(`submodule@${w.main}`)
    const phases = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.kind === "result" && record.name === "submodule-check")
      .map((record) => record.phase)
    expect(phases).toEqual(["submit", "base"])
  })

  /** Actual receipt rows trigger comparison even when every raised path is absent or an ordinary file in the base. */
  it.each(["existing-gitlink", "new-path", "ordinary-file"] as const)(
    "a candidate-only failure stays the submitter's with a green %s comparator",
    async (baseEntry) => {
      const w = await world()
      let head: string
      if (baseEntry === "existing-gitlink") {
        await advanceSubmodule(w, "healthy submodule main")
        head = await submitFile(w, "task/candidate-red")
      } else {
        if (baseEntry === "ordinary-file") {
          writeFileSync(join(w.work, "new-submodule"), "base-owned ordinary file\n")
          await w.git(["add", "new-submodule"])
          await w.git(["commit", "--quiet", "-m", "base has an ordinary file"])
          await w.git(["push", "--quiet", "origin", "main"])
        }
        await w.git(["checkout", "--quiet", "-b", "task/candidate-red", "main"])
        if (baseEntry === "ordinary-file") await w.git(["rm", "--quiet", "new-submodule"])
        await w.git(["submodule", "add", "--quiet", "https://git-super.test/owned/submodule.git", "new-submodule"])
        await gitIn(join(w.work, "new-submodule"))(["checkout", "--quiet", w.onMain])
        writeFileSync(join(w.work, "task-candidate-red.txt"), "authored failure\n")
        await w.git(["add", ".gitmodules", "new-submodule", "task-candidate-red.txt"])
        await w.git(["commit", "--quiet", "-m", "candidate adds a held-back submodule"])
        head = (await w.git(["rev-parse", "HEAD"])).trim()
        await submit(w.git, "origin", {
          branch: "task/candidate-red",
          submitter: "@dev/2",
          target: { branch: "main", remote: "origin" },
        })
      }

      const outcome = await queueRun(
        await w.options({
          on: ["submit"],
          run: "if test -f task-candidate-red.txt || test -d new-submodule; then echo CANDIDATE_FAIL; exit 1; else echo BASE_PASS; fi",
        }),
      )

      expect(outcome, readFileSync(outcome.log, "utf8")).toMatchObject({
        exitCode: 1,
        failed: ["task/candidate-red"],
        merged: [],
        stuck: [],
      })
      const records = await readRecords(
        w.git,
        await remoteTip(w.git, changeRef("main", { branch: "task/candidate-red", head })),
      )
      expect(records.map((record) => record.kind)).toEqual(["opened", "failed", "sent"])
      expect(trailer(records.find((record) => record.kind === "failed")!, "Fault")).toBe("submitter")
      const phases = readFileSync(outcome.log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((record) => record.kind === "result" && record.name === "submodule-check")
        .map((record) => record.phase)
      expect(phases).toEqual(["submit", "base"])
      // The read-side must not relabel the green comparator as the candidate's
      // deciding artifact, nor collapse its two measured phase occurrences.
      const journals = readJournals(dirname(outcome.log))
      const queue = await readQueue(w.git, "origin", "main", outcome.target)
      const shown = watchRows(list(queue.changes, { journals }), { journals, perRun: true }).find(
        (row) => row.row.head === head,
      )!
      expect(shown.row.result).toBe("fail submodule-check")
      expect(readFileSync(shown.row.log!, "utf8")).toBe("CANDIDATE_FAIL\n")
      const detail = checksOf([], "failed", [], shown.run?.running, shown.run?.checks)
      expect(detail.map((check) => [check.phase, check.state, readFileSync(check.log!, "utf8")])).toEqual([
        ["submit", "failed", "CANDIDATE_FAIL\n"],
        ["base", "passed", "BASE_PASS\n"],
      ])
    },
  )

  it("a gitlink moved on the target around the queue is reported with its path, and no submodule is asked about it (E5)", async () => {
    const w = await world()
    // One change first: the queue's history starts at its own first record, so a
    // queue that has judged nothing reports nothing (direct.ts). Its branch is
    // then taken away, so the run retires it without building a worktree and
    // the count below stays about the direct-merge reading alone.
    await submitFile(w, "task/first")
    await w.git(["push", "--quiet", "origin", ":task/first"])
    const direct = await gitlinkAroundQueue(w, w.offMain)

    const outcome = await queueRun(await w.options())

    expect(outcome.exitCode).toBe(0)
    expect(outcome.directMerges).toEqual([direct])
    const log = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(log.filter((record) => record.kind === "merged-direct")).toMatchObject([
      { commit: direct, gitlinks: ["submodule"] },
    ])
    const told = log.filter((record) => record.kind === "message" && record.says === "merged-direct")
    expect(told).toMatchObject([{ id: direct, says: "merged-direct", to: "none" }])
    expect(told[0]?.text).toContain(`main moved around the queue at ${direct.slice(0, 12)}`)
    expect(told[0]?.text).toContain("it moved the gitlink at submodule")
  })

  it("a gitlink the reference checkout never fetched is materialized from the submodule's remote, and the change merges", async () => {
    const w = await world()
    // The submodule's main moves on in its own clone and the reference
    // checkout under `work` never fetches it; the change records it by plumbing,
    // so the reference's submodule store lacks the commit when the queue
    // builds the worktree. The queue fetches it there (2026-09-03: it refused
    // the network and stuck on @dev/2's 24089 instead).
    const submoduleWork = join(w.work, "..", "submodule-work")
    const cg = gitIn(submoduleWork)
    writeFileSync(join(submoduleWork, "lib.txt"), "four\n")
    await cg(["commit", "--quiet", "-am", "four"])
    await cg(["push", "--quiet", "origin", "main"])
    const four = (await cg(["rev-parse", "HEAD"])).trim()
    // Plumbing only: the working tree and its submodule checkout stay where
    // they are, so nothing here fetches the commit into the reference store.
    const base = (await w.git(["rev-parse", "main"])).trim()
    await w.git(["read-tree", "main"])
    await w.git(["update-index", "--add", "--cacheinfo", `160000,${four},submodule`])
    const tree = (await w.git(["write-tree"])).trim()
    const head = (
      await w.git([
        "commit-tree",
        tree,
        "-p",
        base,
        "-m",
        "task/unfetched: move the submodule gitlink to a commit this checkout never fetched",
      ])
    ).trim()
    await w.git(["update-ref", "refs/heads/task/unfetched", head])
    await w.git(["read-tree", "main"])
    await submit(w.git, "origin", {
      branch: "task/unfetched",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })

    const outcome = await queueRun(await w.options())

    expect(outcome.exitCode).toBe(0)
    const kinds = (
      await readRecords(w.git, await remoteTip(w.git, changeRef("main", { branch: "task/unfetched", head })))
    ).map((record) => record.kind)
    expect(kinds).not.toContain("stuck")
    expect(kinds).toContain("merged")
  })

  it("two changes moving the same gitlink ask the submodule once per run: a commit on main stays on main (E4)", async () => {
    const w = await world()
    await submitGitlink(w, "task/first", w.onMain)
    const second = await submitGitlink(w, "task/second", w.onMain)

    const outcome = await queueRun(await w.options())

    // Both were judged on submit — the first fetched, the second read the
    // run's answer — and one merge per run lands the first (ruling D4).
    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/first"])
    expect(
      (
        await readRecords(w.git, await remoteTip(w.git, changeRef("main", { branch: "task/second", head: second })))
      ).map((record) => record.kind),
    ).toEqual(["opened", "checked"])
  })

  /**
   * The settled-base run exists to answer one question — does the base fail
   * the same things? — and re-running the whole check to answer it is what
   * costs the queue a second full check on every failure (hh-dev, run
   * q-20260910T063044822Z-41b0c4ff: 5.3 min to name one attributable test id,
   * then 4.7 min re-running the identical plan to say it was green at base).
   * The check names the scope; the queue puts it in that same check's base
   * environment and says on the row which of the two runs it made.
   */
  describe("the scope the base run is given", () => {
    /** A check that fails where the raised submodule content is, saying `line` on its way. */
    const failingCheck = (line: string): string =>
      [
        `printf 'ONLY=%s\\n' "\${AFFECTED_TESTS_ONLY:-unset}"`,
        `printf '%s\\n' '${line}'`,
        "! grep -q 'breaking submodule main' submodule/lib.txt",
      ].join("; ")

    /** The base-phase rows this run wrote for the check, and the run's narrowing refusals. */
    const baseRows = (
      log: string,
    ): Readonly<{ rows: readonly Record<string, unknown>[]; refusals: readonly Record<string, unknown>[] }> => {
      const records = readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      return {
        refusals: records.filter((record) => record.kind === "narrowing"),
        rows: records.filter((record) => record.kind === "check" && record.phase === "base"),
      }
    }

    it("is the scope the failing check asked for, and the base run is told it", async () => {
      const w = await world()
      await advanceSubmodule(w, "breaking submodule main")
      await submitFile(w, "task/narrowed-base")

      const outcome = await queueRun(
        await w.options({
          on: ["submit"],
          run: failingCheck('YRD-BASE-NARROWING {"env":{"AFFECTED_TESTS_ONLY":"tools/pool.test.ts"}}'),
        }),
      )

      // Unchanged verdict: the base fails the same check, so the raise is the
      // fault and nobody is billed for it.
      expect(outcome).toMatchObject({ exitCode: 2, failed: [], merged: [], stuck: ["task/narrowed-base"] })
      const { refusals, rows } = baseRows(outcome.log)
      expect(refusals).toEqual([])
      expect(rows.map((row) => row.scope)).toEqual(["narrowed", "narrowed"])
      // The name is NOT in the check's `environmentPassthrough`, so the only
      // way it can reach the base run is the offer the check itself made.
      const [start] = rows
      expect(readFileSync(String(start?.log), "utf8")).toContain("ONLY=tools/pool.test.ts")
    })

    it("is the whole check when the failing check offers nothing", async () => {
      const w = await world()
      await advanceSubmodule(w, "breaking submodule main")
      await submitFile(w, "task/full-base")

      const outcome = await queueRun(await w.options({ on: ["submit"], run: failingCheck("no offer on this line") }))

      expect(outcome).toMatchObject({ exitCode: 2, failed: [], merged: [], stuck: ["task/full-base"] })
      const { refusals, rows } = baseRows(outcome.log)
      expect(refusals).toEqual([])
      expect(rows.map((row) => row.scope)).toEqual(["full", "full"])
      expect(readFileSync(String(rows[0]?.log), "utf8")).toContain("ONLY=unset")
    })

    it("is the whole check when the offer cannot be honoured, and the run says why", async () => {
      const w = await world()
      await advanceSubmodule(w, "breaking submodule main")
      await submitFile(w, "task/refused-base")

      const outcome = await queueRun(
        await w.options({ on: ["submit"], run: failingCheck("YRD-BASE-NARROWING {not json}") }),
      )

      expect(outcome).toMatchObject({ exitCode: 2, failed: [], merged: [], stuck: ["task/refused-base"] })
      const { refusals, rows } = baseRows(outcome.log)
      // A refusal is never a quiet absence: the row names the check and the
      // sentence, and the base run it fell back to is the full one.
      expect(refusals).toMatchObject([
        { name: "submodule-check", reason: expect.stringContaining("is not JSON"), scope: "full" },
      ])
      expect(rows.map((row) => row.scope)).toEqual(["full", "full"])
      expect(readFileSync(String(rows[0]?.log), "utf8")).toContain("ONLY=unset")
    })
  })

  /**
   * 24454 row 4, the consumer half. git-super now classifies NESTED gitlinks and
   * emits `kept-behind` for a nested pin behind its own main. This queue reads
   * that JSON as its ruled command boundary, so a state it does not know is a
   * throw out of `superMerge` and into composition -- and km pins maddoc, whose
   * main moves on its own, so every km change would have carried one.
   *
   * The whole point is that it is READ and LOGGED and NOT PUBLISHED. A nested pin
   * lives inside its parent's commit; publishing it would move a main no root
   * merge is entitled to move.
   */
  it("reads a nested kept-behind pin, logs it, and publishes nothing for it", async () => {
    const w = await world()
    const nested = await addNestedSubmodule(w)
    // The parent must be AHEAD or the planner does not descend into it at all,
    // and this arm would assert on a level that was never walked.
    const ahead = await aheadOfSubmodule(w, "five")
    const head = await submitGitlink(w, "task/nested-behind", ahead)

    const outcome = await queueRun(await w.options())

    expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/nested-behind"] })
    const target = await remoteTip(w.git, "refs/heads/main")

    const settle = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.kind === "settle")
    // READ, and read as itself: the nested path, on its own rung, measured
    // against the leaf's main rather than the parent's.
    expect(settle).toContainEqual(
      expect.objectContaining({
        from: nested.leafRecorded,
        path: "submodule/apps/leaf",
        state: "kept-behind",
        to: nested.leafMain,
      }),
    )
    expect(await w.git(["show", "-s", "--format=%(trailers:key=Settled,valueonly)", target])).toContain(
      `submodule/apps/leaf@${nested.leafRecorded} kept-behind submodule-main@${nested.leafMain}`,
    )

    // 24454 row 2 — THE DESCENT REACHES THE JOURNAL. git-super journals its walk
    // into every Ahead parent, and until this row that field was parsed and
    // dropped: yrd read state/partial/commit/detail/gitlinks and nothing else.
    // This is the write half, on a real round rather than a fixture; the reader
    // half is super-merge-descents.test.ts against git-super's own output.
    const descents = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.kind === "descent")
    expect(descents).toContainEqual(
      expect.objectContaining({
        parent: "submodule",
        parentTarget: ahead,
        children: [`submodule/apps/leaf kept-behind ${nested.leafRecorded}`],
      }),
    )

    // NOT PUBLISHED. The parent's main moved because the parent was Ahead; the
    // leaf's main did not move at all, and the landing record names only the
    // parent as published.
    expect(await submoduleMain(w)).toBe(ahead)
    expect((await gitIn(join(w.work, "..", "leaf-work"))(["ls-remote", "origin", "refs/heads/main"])).trim()).toContain(
      nested.leafMain,
    )
    const merged = (
      await readRecords(w.git, await remoteTip(w.git, changeRef("main", { branch: "task/nested-behind", head })))
    ).find((record) => record.kind === "merged")
    expect(merged).toBeDefined()
    expect(trailer(merged!, "Published")).toBe(`submodule ${nested.submoduleMain} -> ${ahead}`)
    expect(trailer(merged!, "Published")).not.toContain("apps/leaf")
  })

  /**
   * B2 (@cto, 24454 row 4). `candidateFailure` names three cases and sends
   * EVERYTHING ELSE to stuck as `yrd-merge-unresolved`, a queue fault needing a
   * person. `nested-pin-lowered` is built by git-super's `obviousDetail`, whose
   * phase defaults to "preflight", so before this it matched none of the three.
   *
   * A lowering is the SUBMITTER's -- its own remedy says "owner: the submodule
   * writer" -- so an unclassified one would have stopped the line for the fleet
   * instead of going back to the one person who can re-record the gitlink.
   */
  it("refuses a nested pin LOWERED below the parent's own main before opening a change", async () => {
    const w = await world()
    const nested = await addNestedSubmodule(w)
    // The submodule's main ADVANCES its nested pin, so the candidate below --
    // which keeps recording the older one -- is a lowering rather than merely
    // behind.
    const submoduleWork = join(w.work, "..", "submodule-work")
    const sg = gitIn(submoduleWork)
    await sg(["checkout", "--quiet", "main"])
    const nestedCheckout = gitIn(join(submoduleWork, "apps/leaf"))
    await nestedCheckout(["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"])
    await nestedCheckout(["checkout", "--quiet", nested.leafMain])
    await sg(["add", "apps/leaf"])
    await sg(["commit", "--quiet", "-m", "the submodule's main raises its nested pin"])
    await sg(["push", "--quiet", "origin", "main"])

    // The candidate is cut from that new submodule main -- so the PARENT is
    // Ahead and the planner descends -- and re-records the leaf at the older
    // pin, which is the lowering.
    const sub = gitIn(join(w.work, "submodule"))
    await w.git(["checkout", "--quiet", "-b", "task/nested-lowered", "main"])
    await sub(["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"])
    await sub(["checkout", "--quiet", (await sg(["rev-parse", "HEAD"])).trim()])
    const subLeaf = gitIn(join(w.work, "submodule/apps/leaf"))
    await subLeaf(["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"])
    await subLeaf(["checkout", "--quiet", nested.leafRecorded])
    await sub(["add", "apps/leaf"])
    await sub(["commit", "--quiet", "-m", "re-record the nested pin at an older commit"])
    await sub(["push", "--quiet", "origin", "HEAD:refs/git-super/pins/lowered"])
    await w.git(["add", "submodule"])
    await w.git(["commit", "--quiet", "-m", "task/nested-lowered: carry the lowered nested pin"])
    const head = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])
    await expect(
      submit(w.git, "origin", {
        branch: "task/nested-lowered",
        submitter: "@dev/2",
        target: { branch: "main", remote: "origin" },
      }),
    ).rejects.toThrow(/nested-pin-lowered.*submodule\/apps\/leaf/u)
    expect(
      (
        await w.git(["ls-remote", "--refs", "origin", changeRef("main", { branch: "task/nested-lowered", head })])
      ).trim(),
    ).toBe("")
  })

  /**
   * THE PRODUCTION LAYOUT (@cto, measured 2026-09-11). In the queue's own clone
   * `km/apps/maddoc` holds ONLY a `.git` directory and no checked-out files,
   * where `addNestedSubmodule` builds a fully populated one.
   *
   * That distinction is exactly what row 4's `gitlink-store-absent` guard keys
   * on, so an arm that only ever sees a populated nested checkout cannot say
   * whether the guard refuses real traffic. It must not: an EMPTY worktree with
   * its own `.git` is still that gitlink's own repository, and only a path with
   * NO repository at all makes Git discovery answer with the parent.
   */
  it("classifies a nested pin whose checkout holds only its .git, as production does", async () => {
    const w = await world()
    const nested = await addNestedSubmodule(w)
    const ahead = await aheadOfSubmodule(w, "eight")
    // Strip the nested checkout down to its `.git`, leaving the repository in
    // place and the working tree empty -- the queue clone's shape.
    const nestedPath = join(w.work, "submodule/apps/leaf")
    for (const entry of readdirSync(nestedPath)) {
      if (entry !== ".git") rmSync(join(nestedPath, entry), { force: true, recursive: true })
    }
    expect(readdirSync(nestedPath)).toEqual([".git"])
    await submitGitlink(w, "task/nested-bare", ahead)

    const outcome = await queueRun(await w.options())

    expect(outcome, "an empty worktree with its own .git is not an absent store").toMatchObject({
      exitCode: 0,
      merged: ["task/nested-bare"],
    })
    const settle = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.kind === "settle")
    expect(settle).toContainEqual(
      expect.objectContaining({
        from: nested.leafRecorded,
        path: "submodule/apps/leaf",
        state: "kept-behind",
        to: nested.leafMain,
      }),
    )
  })
})

/**
 * A component whose main moved under a change in flight (24951).
 *
 * The carrier pinned the component at a head that contained its main when it
 * was submitted; by its merge turn another landing had moved that main, so the
 * two sides diverged and the root merge refused the carrier outright. Where the
 * two sides changed different files the queue now merges the component itself,
 * and the carrier keeps its place.
 */
describe("a diverged component the merge composes", () => {
  /**
   * Three commits off the component's main tip, each touching a file the other
   * two do not: what the landing moves main with, and two carriers in flight.
   */
  async function divergentSubmoduleCommits(
    w: World,
  ): Promise<Readonly<{ mainSide: string; changeSide: string; secondSide: string }>> {
    const submoduleWork = join(w.work, "..", "submodule-work")
    const submodule = gitIn(submoduleWork)
    const sideCommit = async (branch: string, file: string, says: string): Promise<string> => {
      await submodule(["checkout", "--quiet", "-b", branch, "main"])
      writeFileSync(join(submoduleWork, file), `${says}\n`)
      await submodule(["add", file])
      await submodule(["commit", "--quiet", "-m", `a file only ${branch} changes`])
      return (await submodule(["rev-parse", "HEAD"])).trim()
    }
    const mainSide = await sideCommit("main-side", "main-side.txt", "the landing that moved main")
    const changeSide = await sideCommit("change-side", "change-side.txt", "the carrier in flight")
    const secondSide = await sideCommit("second-side", "second-side.txt", "the carrier behind it")
    await submodule(["checkout", "--quiet", "main"])
    await submodule(["push", "--quiet", "origin", "main-side", "change-side", "second-side"])
    return { changeSide, mainSide, secondSide }
  }

  /** The settle rows this run journaled. */
  function settleRows(log: string): Record<string, unknown>[] {
    return readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.kind === "settle")
  }

  it("lands the second of two changes moving the same gitlink, without a re-cut", async () => {
    const w = await world()
    const pins = await divergentSubmoduleCommits(w)
    const first = await submitGitlink(w, "task/first-side", pins.mainSide)
    const second = await submitGitlink(w, "task/second-side", pins.changeSide)

    // One merge per run (D4): the first lands and moves the submodule's main.
    const landing = await queueRun(await w.options())
    expect(landing).toMatchObject({ exitCode: 0, failed: [], merged: ["task/first-side"], stuck: [] })
    expect(await submoduleMain(w)).toBe(pins.mainSide)

    // The second's pin and that main have now diverged; nothing re-cut it.
    const outcome = await queueRun(await w.options())

    expect(outcome).toMatchObject({ exitCode: 0, failed: [], merged: ["task/second-side"], stuck: [] })
    const target = await remoteTip(w.git, "refs/heads/main")
    const composed = await gitlinkAt(w, target)
    expect(composed).not.toBe(pins.changeSide)
    expect(composed).not.toBe(pins.mainSide)
    // (b) retained at the component remote before the root merge recorded it.
    expect(await submoduleRemoteRef(w, `refs/git-super/pins/${composed}`)).toBe(composed)
    // (a) the component main tip is the FIRST parent and the carrier's pin the second.
    const bare = gitIn(join(w.work, "..", "submodule.git"))
    expect((await bare(["show", "-s", "--format=%P", composed])).trim()).toBe(`${pins.mainSide} ${pins.changeSide}`)
    // (c) the composed commit reached the component's main through the landing.
    expect(await submoduleMain(w)).toBe(composed)
    const message = await w.git(["show", "-s", "--format=%B", target])
    expect(message).toContain(`Settled: submodule@${composed} merged submodule-main@${pins.mainSide}`)
    expect(settleRows(outcome.log)).toMatchObject([
      {
        base: w.main,
        files: [`main 1`, `change 1`],
        from: pins.mainSide,
        merged: composed,
        path: "submodule",
        state: "merged",
        to: pins.changeSide,
      },
    ])
    const merged = (
      await readRecords(w.git, await remoteTip(w.git, changeRef("main", { branch: "task/second-side", head: second })))
    ).find((record) => record.kind === "merged")
    expect(merged).toBeDefined()
    expect(trailer(merged!, "Published")).toBe(`submodule ${pins.mainSide} -> ${composed}`)
    expect(first).not.toBe(second)
  })

  /**
   * THE ONE-SIDED FORK (25389). The carrier's component work began on an older component main, and only the
   * carrier moves the gitlink, so the ROOT merge is clean and has no conflict to compose from. Submit admits
   * the carrier as written, and the round composes it.
   */
  it("admits a forked pin without rewriting it, and the round composes it to merged (25389)", async () => {
    const w = await world()
    const submoduleWork = join(w.work, "..", "submodule-work")
    const submodule = gitIn(submoduleWork)
    await submodule(["checkout", "--quiet", "-b", "fork-side", w.onMain])
    writeFileSync(join(submoduleWork, "fork-side.txt"), "work begun on an older main\n")
    await submodule(["add", "fork-side.txt"])
    await submodule(["commit", "--quiet", "-m", "a file only the fork changes"])
    const fork = (await submodule(["rev-parse", "HEAD"])).trim()
    await submodule(["checkout", "--quiet", "main"])
    await submodule(["push", "--quiet", "origin", "fork-side"])

    const head = await submitGitlink(w, "task/fork", fork)

    // Submit opened the carrier at its own head, whose gitlink is still the fork.
    expect(await gitlinkAt(w, head)).toBe(fork)
    const changed = changeRef("main", { branch: "task/fork", head })
    expect((await readRecords(w.git, await remoteTip(w.git, changed))).map((record) => record.kind)).toEqual(["opened"])

    const outcome = await queueRun(await w.options())

    expect(outcome).toMatchObject({ exitCode: 0, failed: [], merged: ["task/fork"], stuck: [] })
    const target = await remoteTip(w.git, "refs/heads/main")
    const composed = await gitlinkAt(w, target)
    expect(composed).not.toBe(fork)
    const bare = gitIn(join(w.work, "..", "submodule.git"))
    expect((await bare(["show", "-s", "--format=%P", composed])).trim()).toBe(`${w.main} ${fork}`)
    expect(await submoduleRemoteRef(w, `refs/git-super/pins/${composed}`)).toBe(composed)
    expect(await submoduleMain(w)).toBe(composed)
    expect(await w.git(["show", "-s", "--format=%B", target])).toContain(
      `Settled: submodule@${composed} merged submodule-main@${w.main}`,
    )
    expect((await readRecords(w.git, await remoteTip(w.git, changed))).map((record) => record.kind)).toContain("merged")
  })

  /**
   * SPECIMEN 11 (24977 row 5): two carriers of a WALLED seat, which nothing can
   * re-pin. The component's main moved AROUND the queue rather than through it,
   * so no re-pin-on-signal rule reaches this carrier at all.
   */
  it("composes a carrier whose component main moved around the queue, then composes the one behind it", async () => {
    const w = await world()
    const pins = await divergentSubmoduleCommits(w)
    // Both carriers are cut and submitted while the component main is still at
    // f-base, which is the only order a submit admits: a pin that does not
    // contain the component's main is refused at submit, never at merge.
    const head = await submitGitlink(w, "task/walled", pins.changeSide)
    await submitGitlink(w, "task/walled-behind", pins.secondSide)
    // The component pin on root main moves AROUND the queue: no landing, no
    // signal, nothing that could re-pin a walled seat's carrier.
    await gitlinkAroundQueue(w, pins.mainSide)
    const bare = gitIn(join(w.work, "..", "submodule.git"))

    const outcome = await queueRun(await w.options())

    expect(outcome).toMatchObject({ exitCode: 0, failed: [], merged: ["task/walled"], stuck: [] })
    const target = await remoteTip(w.git, "refs/heads/main")
    const composed = await gitlinkAt(w, target)
    expect((await bare(["show", "-s", "--format=%P", composed])).trim()).toBe(`${pins.mainSide} ${pins.changeSide}`)
    const composedMessage = await bare(["show", "-s", "--format=%B", composed])
    expect(composedMessage).toContain(`Change: task/walled@${head}`)
    expect(composedMessage).toContain("Merged-By:")
    // A candidate is composed once where it is JUDGED and once where it MERGES,
    // and every carrier in the run is judged — so the journal carries a row per
    // carrier per phase, each naming the composition that phase built.
    const walled = settleRows(outcome.log).filter((row) => row.branch === "task/walled")
    expect(walled.map((row) => row.phase)).toEqual(["submit", "merge"])
    expect(walled.at(-1)).toMatchObject({
      base: w.main,
      files: ["main 1", "change 1"],
      from: pins.mainSide,
      merged: composed,
      path: "submodule",
      state: "merged",
      to: pins.changeSide,
    })
    // Component main was fast-forwarded to the composition AFTER the root merge.
    expect(await submoduleMain(w)).toBe(composed)

    // The carrier behind it now diverges from a main the QUEUE authored, and
    // composes against it on the next turn.
    const second = await queueRun(await w.options())

    expect(second).toMatchObject({ exitCode: 0, failed: [], merged: ["task/walled-behind"], stuck: [] })
    const secondTarget = await remoteTip(w.git, "refs/heads/main")
    const secondComposed = await gitlinkAt(w, secondTarget)
    expect((await bare(["show", "-s", "--format=%P", secondComposed])).trim()).toBe(`${composed} ${pins.secondSide}`)
    expect(await submoduleMain(w)).toBe(secondComposed)
  })

  /**
   * A PUBLICATION that is refused stops the line (design § 9 item 4). It runs
   * after the landing record is already on the change ref naming this merge, so
   * some component mains may have moved and others not; leaving the change
   * "checked" would send the next run to compose against a half-published state
   * nobody was told about.
   */
  it("sticks the run when a component main moved between compose and publish", async () => {
    const w = await world()
    const pins = await divergentSubmoduleCommits(w)
    const head = await submitGitlink(w, "task/raced-publish", pins.changeSide)
    await gitlinkAroundQueue(w, pins.mainSide)
    const rootBefore = await remoteTip(w.git, "refs/heads/main")
    await using real = createProcess({ cwd: w.work })
    let raced = 0
    const racing: Process = {
      ...real,
      async run(request) {
        const publishing =
          request.argv.includes("super") &&
          request.argv.includes("push") &&
          request.argv.includes("--recurse-submodules=only")
        if (publishing && raced++ === 0) {
          // Between compose and publish, somebody else moves component main.
          const submoduleWork = join(w.work, "..", "submodule-work")
          const submodule = gitIn(submoduleWork)
          await submodule(["checkout", "--quiet", "main"])
          writeFileSync(join(submoduleWork, "unrelated.txt"), "moved under the queue\n")
          await submodule(["add", "unrelated.txt"])
          await submodule(["commit", "--quiet", "-m", "an unrelated commit on component main"])
          await submodule(["push", "--quiet", "origin", "main"])
        }
        return real.run(request)
      },
    }

    const outcome = await queueRun({ ...(await w.options()), process: racing })

    expect(raced).toBeGreaterThan(0)
    expect(outcome).toMatchObject({ exitCode: 2, failed: [], merged: [], stuck: ["task/raced-publish"] })
    const stuck = (
      await readRecords(w.git, await remoteTip(w.git, changeRef("main", { branch: "task/raced-publish", head })))
    ).find((record) => record.kind === "stuck")
    expect(stuck).toBeDefined()
    expect(trailer(stuck!, "Code")).toBe("yrd-publication-refused")
    expect(trailer(stuck!, "Via")).toContain("git super push --recurse-submodules=only")
    // Root main did not move on this publish, and the racing commit still owns
    // component main: nothing half-landed behind the stop.
    expect(await remoteTip(w.git, "refs/heads/main")).toBe(rootBefore)
    expect(await submoduleMain(w)).not.toBe(await gitlinkAt(w, rootBefore))
  })

  /**
   * The two new refusals, classified.
   *
   * git-super's own suite proves it EMITS these codes for a real overlap and a
   * real unjudgeable store; what this proves is the half that lives here — that
   * `candidateFailure` names both, because everything it does not name ends the
   * round stuck for the whole fleet.
   */
  function refusingMerge(detail: Readonly<Record<string, string>>, real: Process): Process {
    const refusal = JSON.stringify({
      detail,
      gitlinks: [],
      partial: false,
      repositories: [],
      state: "failed",
    })
    return {
      ...real,
      async run(request) {
        if (!request.argv.includes("super") || !request.argv.includes("merge")) return real.run(request)
        return { durationMs: 1, exitCode: 1, signal: null, stderr: "", stdout: refusal, timedOut: false }
      },
    }
  }

  it("fails the change when the diverged component's two sides overlap, naming the files", async () => {
    const w = await world()
    const pins = await divergentSubmoduleCommits(w)
    const head = await submitGitlink(w, "task/overlapping", pins.changeSide)
    await using real = createProcess({ cwd: w.work })

    const outcome = await queueRun({
      ...(await w.options()),
      process: refusingMerge(
        {
          code: "gitlink-compose-refused",
          message: "gitlink submodule: diverged; files overlap: lib.txt",
          next: "rebase the submodule commit onto its own main and submit again",
          phase: "preflight-merge",
          subject: "the diverged submodule could not be merged",
        },
        real,
      ),
    })

    expect(outcome).toMatchObject({ exitCode: 1, failed: ["task/overlapping"], merged: [], stuck: [] })
    const records = await readRecords(
      w.git,
      await remoteTip(w.git, changeRef("main", { branch: "task/overlapping", head })),
    )
    const failed = records.find((record) => record.kind === "failed")
    expect(failed).toBeDefined()
    expect(trailer(failed!, "Reason")).toBe("conflict")
    expect(trailer(failed!, "Detail")).toContain("files overlap: lib.txt")
  })

  it("sticks the run, never the change, when the diverged component cannot be judged", async () => {
    const w = await world()
    const pins = await divergentSubmoduleCommits(w)
    const head = await submitGitlink(w, "task/unjudgeable", pins.changeSide)
    await using real = createProcess({ cwd: w.work })

    const outcome = await queueRun({
      ...(await w.options()),
      process: refusingMerge(
        {
          code: "gitlink-compose-unavailable",
          message: 'the diverged submodule at "submodule" could not be merged: the submodule store is shallow',
          phase: "compose-gitlinks",
          subject: "the submodule store is shallow",
        },
        real,
      ),
    })

    expect(outcome).toMatchObject({ exitCode: 2, failed: [], merged: [], stuck: ["task/unjudgeable"] })
    const records = await readRecords(
      w.git,
      await remoteTip(w.git, changeRef("main", { branch: "task/unjudgeable", head })),
    )
    const stuck = records.find((record) => record.kind === "stuck")
    expect(stuck).toBeDefined()
    expect(trailer(stuck!, "Code")).toBe("yrd-gitlink-compose-unavailable")
    expect(trailer(stuck!, "Via")).toContain("git super merge")
    expect(trailer(stuck!, "Owner")).toBe("the queue operator")
    expect(trailer(stuck!, "Subject")).toContain("shallow")
  })

  it("fails the change with named refusal when the diverged component commit could not be fetched (25011)", async () => {
    const w = await world()
    const pins = await divergentSubmoduleCommits(w)
    const head = await submitGitlink(w, "task/unfetchable", pins.changeSide)
    await using real = createProcess({ cwd: w.work })

    const outcome = await queueRun({
      ...(await w.options()),
      process: refusingMerge(
        {
          code: "gitlink-compose-refused",
          message: "gitlink submodule: diverged; component commit 22d0178b3a could not be fetched",
          next: "push the component commit to refs/git-super/pins and submit again",
          phase: "compose-gitlinks",
          subject: "the diverged submodule could not be merged",
        },
        real,
      ),
    })

    expect(outcome).toMatchObject({ exitCode: 1, failed: ["task/unfetchable"], merged: [], stuck: [] })
    const records = await readRecords(
      w.git,
      await remoteTip(w.git, changeRef("main", { branch: "task/unfetchable", head })),
    )
    const failed = records.find((record) => record.kind === "failed")
    expect(failed).toBeDefined()
    expect(trailer(failed!, "Reason")).toBe("gitlink-not-on-remote")
    expect(trailer(failed!, "Detail")).toContain("could not be fetched")
  })

  it("fetches an absent component commit and composes it when the queue clone lacks it (25011)", async () => {
    const w = await world()

    const submoduleWork = join(w.work, "..", "submodule-work")
    const submodule = gitIn(submoduleWork)

    // mainSide: on main-side branch
    await submodule(["checkout", "--quiet", "-b", "main-side", "main"])
    writeFileSync(join(submoduleWork, "main-side.txt"), "main side\n")
    await submodule(["add", "main-side.txt"])
    await submodule(["commit", "--quiet", "-m", "main side"])
    const mainSide = (await submodule(["rev-parse", "HEAD"])).trim()
    await submodule(["push", "--quiet", "origin", "main-side"])

    // changeSide: pushed only as a pin ref, never as a branch on refs/heads/*
    await submodule(["checkout", "--quiet", "-b", "change-side", "main"])
    writeFileSync(join(submoduleWork, "change-side.txt"), "change side\n")
    await submodule(["add", "change-side.txt"])
    await submodule(["commit", "--quiet", "-m", "change side"])
    const changeSide = (await submodule(["rev-parse", "HEAD"])).trim()
    await submodule(["push", "--quiet", "origin", `${changeSide}:refs/git-super/pins/${changeSide}`])

    // 1. Submit task/absent-side from authorWork while root main is still at base
    const authorRoot = mkdtempSync(join(tmpdir(), "yrd-core-author-"))
    roots.push(authorRoot)
    const seed = gitIn(authorRoot)
    const authorWork = join(authorRoot, "work")
    await seed(["clone", "--quiet", join(w.work, "..", "remote.git"), authorWork])
    const authorGit = gitIn(authorWork)
    await authorGit(["config", "user.email", "dev2@yrd.test"])
    await authorGit(["config", "user.name", "dev2"])
    await authorGit(["remote", "set-url", "origin", "https://git-super.test/owned/root.git"])
    await authorGit(["submodule", "update", "--init", "--quiet"])
    const authorSub = gitIn(join(authorWork, "submodule"))
    await authorSub(["remote", "set-url", "origin", "https://git-super.test/owned/submodule.git"])
    await authorSub([
      "fetch",
      "--quiet",
      "origin",
      `+refs/git-super/pins/${changeSide}:refs/git-super/pins/${changeSide}`,
    ])
    await authorSub(["checkout", "--quiet", changeSide])
    await authorGit(["checkout", "--quiet", "-b", "task/absent-side", "main"])
    await authorGit(["add", "submodule"])
    await authorGit(["commit", "--quiet", "-m", `task/absent-side: move submodule to ${changeSide}`])
    await submit(authorGit, "origin", {
      branch: "task/absent-side",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })

    // 2. Move root main around the queue to mainSide
    await gitlinkAroundQueue(w, mainSide)

    // 3. Assert that the queue clone w.work/submodule does NOT hold changeSide
    const queueSub = gitIn(join(w.work, "submodule"))
    await expect(queueSub(["cat-file", "-e", `${changeSide}^{commit}`])).rejects.toThrow()

    // 4. Run the queue. It must compose the diverged gitlink by fetching changeSide from submodule.git!
    const outcome = await queueRun(await w.options())

    expect(outcome).toMatchObject({ exitCode: 0, failed: [], merged: ["task/absent-side"], stuck: [] })
    const target = await remoteTip(w.git, "refs/heads/main")
    const composed = await gitlinkAt(w, target)
    expect(composed).not.toBe(changeSide)
    expect(composed).not.toBe(mainSide)
    const bareSub = gitIn(join(w.work, "..", "submodule.git"))
    expect((await bareSub(["show", "-s", "--format=%P", composed])).trim()).toBe(`${mainSide} ${changeSide}`)
    expect(await queueSub(["cat-file", "-e", `${changeSide}^{commit}`])).toBe("")
    expect(await queueSub(["cat-file", "-e", `${composed}^{commit}`])).toBe("")
  })

  /**
   * 24977 (@cto e8368e85 constraint 2; the load-bearing line of the build). The
   * change was judged while its pin still contained the component's main, so
   * the submit checks saw no composition; by its merge turn main had moved and
   * the MERGE phase composed a tree no check had read. The submit-level checks
   * run again on that composed candidate before it lands.
   */
  it("runs the submit checks again on a candidate the merge phase composed (24977)", async () => {
    const w = await world()
    const pins = await divergentSubmoduleCommits(w)
    const ran = join(w.work, "..", "submit-check-runs.txt")
    const check = { on: ["submit"], run: `echo "$YRD_CANDIDATE_SHA" >> '${ran}'` } as const
    await submitGitlink(w, "task/first-side", pins.mainSide)
    await submitGitlink(w, "task/second-side", pins.changeSide)
    const landing = await queueRun(await w.options(check))
    expect(landing).toMatchObject({ exitCode: 0, failed: [], merged: ["task/first-side"], stuck: [] })
    writeFileSync(ran, "")

    const outcome = await queueRun(await w.options(check))

    expect(outcome).toMatchObject({ exitCode: 0, failed: [], merged: ["task/second-side"], stuck: [] })
    const target = await remoteTip(w.git, "refs/heads/main")
    expect(readFileSync(ran, "utf8").split("\n").filter(Boolean)).toEqual([target])
  })

  /**
   * P0 after 24977 landed (merge 447, q-20260923T223516964Z-7c5234c0): a pin
   * already behind the component main when the change is judged is composed at
   * JUDGE, passes, and is composed again at MERGE, whose re-run of the submit
   * checks wrote into the judge's own check-log directory in the same run. A
   * check log is opened create-only, so the second open crashed the queue and
   * stopped the line. Each re-run writes beside the judge's logs, never over them.
   */
  it("lands a change judged and re-cut in one run, the recheck's logs beside the judge's (24977 P0)", async () => {
    const w = await world()
    const pins = await divergentSubmoduleCommits(w)
    // `true` is the skipped no-op check since 25716 row 5; `:` is a check that runs and passes.
    const check = { on: ["submit"], run: ":" } as const
    const head = await submitGitlink(w, "task/stale-at-judge", pins.changeSide)
    await gitlinkAroundQueue(w, pins.mainSide)

    const outcome = await queueRun(await w.options(check))

    expect(readFileSync(outcome.log, "utf8")).not.toContain("a check log already exists")
    expect(outcome).toMatchObject({ exitCode: 0, failed: [], merged: ["task/stale-at-judge"], stuck: [] })
    // The judge and the merge phase's re-run each ran the submit check once, both as phase "submit", each
    // into its own log.
    const judged = readJournals(dirname(outcome.log)).runs.get(journalKey("task/stale-at-judge", head))?.[0]
    const checks = (judged?.checks ?? []).map((check) => ({ phase: check.phase, log: check.log }))
    expect(checks.map((check) => check.phase)).toEqual(["submit", "submit"])
    expect(new Set(checks.map((check) => check.log)).size).toBe(2)
    expect(checks[1]?.log).toMatch(/\/recut-[0-9a-f]{12}\/submit\/[^/]+\.log$/u)
  })

  /** 24977 constraint 1: the re-cut is recorded, naming both heads, and nothing is amended. */
  it("journals a recut row naming the change head, the component main merged in, and both new commits (24977)", async () => {
    const w = await world()
    const pins = await divergentSubmoduleCommits(w)
    await submitGitlink(w, "task/first-side", pins.mainSide)
    const head = await submitGitlink(w, "task/second-side", pins.changeSide)
    await queueRun(await w.options())

    const outcome = await queueRun(await w.options())

    expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/second-side"] })
    const target = await remoteTip(w.git, "refs/heads/main")
    const composed = await gitlinkAt(w, target)
    const recuts = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.kind === "recut")
    expect(recuts).toMatchObject([
      {
        branch: "task/second-side",
        candidate: target,
        composed,
        head,
        main: pins.mainSide,
        path: "submodule",
        phase: "merge",
      },
    ])
    // Never an amend: the merged branch's delete was leased on the submitted
    // head, so the branch still named that head when it left (@i/10-yrd/25568).
    expect(
      readFileSync(outcome.log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    ).toContainEqual(expect.objectContaining({ kind: "branch-deleted", branch: "task/second-side", head }))
    const merged = (
      await readRecords(w.git, await remoteTip(w.git, changeRef("main", { branch: "task/second-side", head })))
    ).find((record) => record.kind === "merged")
    expect(trailer(merged!, "Recut")).toBe(`submodule ${pins.changeSide} + ${pins.mainSide} -> ${composed}`)
  })

  /**
   * The same re-cut met at JUDGE: the component main moved before the change
   * was ever judged, so its first candidate is already composed. That
   * candidate is the queue's, not the submitter's head, so its failure is the
   * re-cut's too, uncharged (@cto c6c014ba), and the line goes on.
   */
  it("bounces a change whose first, already-composed candidate fails a submit check as recut-check (24977)", async () => {
    const w = await world()
    const pins = await divergentSubmoduleCommits(w)
    const check = {
      on: ["submit"],
      run: "! { test -f submodule/main-side.txt && test -f submodule/change-side.txt; }",
    } as const
    const head = await submitGitlink(w, "task/walled-recut", pins.changeSide)
    await gitlinkAroundQueue(w, pins.mainSide)

    const outcome = await queueRun(await w.options(check))

    expect(outcome).toMatchObject({ exitCode: 1, failed: ["task/walled-recut"], merged: [], stuck: [] })
    const failed = (
      await readRecords(w.git, await remoteTip(w.git, changeRef("main", { branch: "task/walled-recut", head })))
    ).find((record) => record.kind === "failed")
    expect(trailer(failed!, "Reason")).toBe("recut-check")
    // Both heads named: the change's, and the queue's re-cut of it.
    expect(trailer(failed!, "Detail")).toContain(`task/walled-recut@${head.slice(0, 12)}`)
    expect(trailer(failed!, "Recut")).toContain(`submodule ${pins.changeSide} + ${pins.mainSide} -> `)
  })

  /**
   * 24977 Q3 (@cto 0a3e3838): a check that fails ONLY on the composed tree is a
   * semantic conflict with main. It is the submitter's bounce, named
   * `recut-check`, and the line does not stop on it.
   */
  it("bounces a recut whose re-run check fails while the head alone passes, without stopping the line (24977)", async () => {
    const w = await world()
    const pins = await divergentSubmoduleCommits(w)
    // Passes on either side alone; fails only where both files meet.
    const check = {
      on: ["submit"],
      run: "! { test -f submodule/main-side.txt && test -f submodule/change-side.txt; }",
    } as const
    // 25301: a round judges the line after its head merges, on the target that
    // merge left. The head here is a plain file, so second-side is checked on a
    // tree it alone moves, and passes; main then moves the gitlink around the
    // queue, so only the next round's merge composes the two sides.
    await submitFile(w, "task/unrelated-head")
    const head = await submitGitlink(w, "task/second-side", pins.changeSide)
    expect(await queueRun(await w.options(check))).toMatchObject({ merged: ["task/unrelated-head"], failed: [] })
    await mainAfterRound(w)
    await gitlinkAroundQueue(w, pins.mainSide)

    const outcome = await queueRun(await w.options(check))

    expect(outcome).toMatchObject({ exitCode: 1, failed: ["task/second-side"], merged: [], stuck: [] })
    const failed = (
      await readRecords(w.git, await remoteTip(w.git, changeRef("main", { branch: "task/second-side", head })))
    ).find((record) => record.kind === "failed")
    expect(failed).toBeDefined()
    expect(trailer(failed!, "Reason")).toBe("recut-check")
    expect(trailer(failed!, "Detail")).toContain("semantic conflict with main")
    expect(trailer(failed!, "Detail")).toContain("submodule-check")
  })

  // review2 witness (24977 review): the merge-phase re-run of the submit checks must be COMPLETE before a
  // composed candidate lands. A stop window that closes after the first submit check passes ends runPhase early;
  // with no merge-phase checks declared nothing else notices, and the composed candidate would land although the
  // second (walled) check never ran on it. The judge and merge phases each defer on a short result list; the
  // re-run must too.
  it("defers, never lands, a re-cut whose submit re-run a stop window cut short (24977, review2 de5a4c01)", async () => {
    const w = await world()
    const pins = await divergentSubmoduleCommits(w)
    const closed = join(w.work, "..", "review2-window-closed")
    const checks = [
      { name: "closes-the-window", on: ["submit"], run: `touch '${closed}'` },
      {
        name: "walled",
        on: ["submit"],
        run: "! { test -f submodule/main-side.txt && test -f submodule/change-side.txt; }",
      },
    ] as const
    // 25301: as above, the first round merges a plain-file head and checks
    // second-side on a tree it alone moves; main's gitlink then moves around
    // the queue, so the second round's merge is the one that composes.
    await submitFile(w, "task/unrelated-head")
    await submitGitlink(w, "task/second-side", pins.changeSide)
    const landing = await queueRun({ ...(await w.options()), checks })
    expect(landing).toMatchObject({ exitCode: 0, failed: [], merged: ["task/unrelated-head"], stuck: [] })
    await mainAfterRound(w)
    await gitlinkAroundQueue(w, pins.mainSide)
    rmSync(closed, { force: true })
    const stopAtMs = Date.now() + 3_600_000

    const outcome = await queueRun({
      ...(await w.options()),
      checks,
      stopAtMs,
      now: () => (existsSync(closed) ? stopAtMs : stopAtMs - 1),
    })

    expect(existsSync(closed)).toBe(true)
    expect(outcome).toMatchObject({ deferred: ["task/second-side"], failed: [], merged: [], stuck: [] })
  })
})
