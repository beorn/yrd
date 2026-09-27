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

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, beforeEach, expect, it, vi } from "vitest"
import { createProcess } from "@yrd/process"
import type { Process } from "@yrd/process"
import * as gitomic from "gitomic"
import type { RefUpdate } from "gitomic"
import {
  createEventQueue,
  createEventStore,
  drop,
  gitIn,
  queueRun,
  readConfig,
  readStatus,
  setBranchIgnored,
  submit,
} from "../src/index.ts"
import type { Git, QueueRunOptions } from "../src/index.ts"
import { appendChangeEvent } from "../src/events.ts"
import { gitSuperBin, siblingGitSuperBin, superprojectRoot } from "../../../tests/support/git-super-bin.ts"

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

it("resolves the candidate workspace's git-super bin relative to this test file", async () => {
  if (superprojectRoot !== "") {
    expect(gitSuperBin).toBe(siblingGitSuperBin)
    expect(gitSuperBin).toContain("/vendor/git-super/bin")
  } else {
    expect(gitSuperBin).toContain("/node_modules/git-super/bin")
  }
  expect(existsSync(join(gitSuperBin, "git-super"))).toBe(true)
  const w = await world()
  const options = await w.options()
  expect(options.env?.PATH?.split(":")[0]).toBe(gitSuperBin)
})

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

/** @failure A gitlink compose refusal ended without one successful notice to its submitter (25741).
 * @level l3 @consumer the submitter of a change with a diverged component pin
 */
it("sends one failed notice for a gitlink that cannot compose", async () => {
  const w = await world()
  await createWorldEventQueue(w)
  const ahead = await aheadOfSubmodule(w, "submitted-feature")
  const head = await submitGitlink(w, "task/diverged-pin", ahead)
  await advanceSubmodule(w, "main changed after submit")
  const noticeLog = join(dirname(w.work), "compose-refusal-notice.jsonl")
  const options: QueueRunOptions = {
    ...(await w.options()),
    checks: [],
    notify: [{ name: "submitter", on: ["failed"], run: `cat >> ${noticeLog}` }],
  }

  const outcome = await queueRun(options)
  expect(outcome).toMatchObject({ exitCode: 1, failed: ["task/diverged-pin"], merged: [] })
  const status = await readStatus(eventStore(w), "main", "task/diverged-pin")
  expect(status).toMatchObject({ status: "failed", commit: head })
  expect(status.reason).toContain("gitlink-compose-refused")
  expect(status.reason).toContain("submodule")
  expect(Object.values(status.notices ?? {})).toMatchObject([{ result: "delivered", to: "submitter" }])
  const notices = readFileSync(noticeLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  expect(notices).toMatchObject([
    { record: "failed", change: `task/diverged-pin@${head}`, submitter: "@dev/2", failures: 1 },
  ])

  await queueRun(options)
  expect(readFileSync(noticeLog, "utf8").trim().split("\n")).toHaveLength(1)
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

/** @failure A raised component regression was charged to a candidate whose authored file was absent from the failing base.
 * @level l3 @consumer queue operator and submitter
 * The existing failed-check fixture moves an authored gitlink, so it never exercises a queue-raised pin.
 */
it.each([
  { cause: "candidate", command: "test ! -e task-raised-check.txt", status: "failed", exitCode: 1 },
  { cause: "raised pin", command: 'test "$(cat submodule/lib.txt)" = three', status: "stuck", exitCode: 2 },
])("attributes a failed check on a raised gitlink to $cause", async ({ cause, command, status, exitCode }) => {
  const w = await world()
  await createWorldEventQueue(w)
  await submitFile(w, "task/raised-check")
  const rootBefore = await remoteTip(w.git, "refs/heads/main")
  const childBefore = await advanceSubmodule(w, "four")

  const outcome = await queueRun({ ...(await w.options({ run: command, on: ["merge"] })), notify: [] })

  expect(outcome.exitCode).toBe(exitCode)
  expect(await remoteTip(w.git, "refs/heads/main")).toBe(rootBefore)
  expect(await submoduleMain(w)).toBe(childBefore)
  const state = await readStatus(eventStore(w), "main", "task/raised-check")
  expect(state.status).toBe(status)
  if (cause === "raised pin") expect(state.reason).toBe("yrd-settled-base-check-failed")
})

/** @failure Rechecking only the failed check misses an earlier phase check that prepared or validated its ground.
 * @level l3 @consumer queue operator attributing raised-pin failures
 */
it("runs the declared base phase in order through the failed check", async () => {
  const w = await world()
  await createWorldEventQueue(w)
  await submitFile(w, "task/prefix-check")
  await advanceSubmodule(w, "four")
  const rows: Array<{ kind: string; phase?: string; name?: string; result?: string; whose?: string }> = []
  const outcome = await queueRun({
    ...(await w.options()),
    checks: [
      { name: "prefix", on: ["merge"], run: "test -e task-prefix-check.txt" },
      { name: "failed", on: ["merge"], run: "exit 1" },
    ],
    notify: [],
    render: (row) => rows.push(row),
  })

  expect(outcome).toMatchObject({ exitCode: 2, stuck: ["task/prefix-check"] })
  const baseChecks = rows.filter((row) => row.kind === "result" && row.phase === "base")
  expect(baseChecks.map((row) => row.name)).toEqual(["prefix"])
  expect(baseChecks[0]).toMatchObject({ result: "fail", whose: "queue" })
})

/** @failure A final check offer could be lost or a malformed later offer could be silently treated as absent.
 * @level l3 @consumer queue operator reading the base check journal
 */
it.each([
  {
    offer: "usable",
    candidate: 'printf \'YRD-BASE-NARROWING {"env":{"YRD_SETTLED_BASE_AFFECTED_IDS":"one"}}\\n\'; exit 1',
    base: 'test "$YRD_SETTLED_BASE_AFFECTED_IDS" = one',
    scope: "narrowed",
    refused: false,
  },
  {
    offer: "malformed last",
    candidate:
      'printf \'YRD-BASE-NARROWING {"env":{"YRD_SETTLED_BASE_AFFECTED_IDS":"one"}}\\nYRD-BASE-NARROWING not-json\\n\'; exit 1',
    base: 'test -z "$YRD_SETTLED_BASE_AFFECTED_IDS"',
    scope: "full",
    refused: true,
  },
])("journals the $offer offer and base scope", async ({ candidate, base, scope, refused }) => {
  const w = await world()
  await createWorldEventQueue(w)
  await submitFile(w, "task/marker-check")
  await advanceSubmodule(w, "four")
  const rows: Array<{ kind: string; phase?: string; scope?: string }> = []
  const run = `if [ "$YRD_CHECK_SCOPE" = settled-base-attribution ]; then ${base}; else ${candidate}; fi`

  const outcome = await queueRun({
    ...(await w.options({ run, on: ["merge"] })),
    notify: [],
    render: (row) => rows.push(row),
  })

  expect(outcome).toMatchObject({ exitCode: 1, failed: ["task/marker-check"] })
  expect(rows.some((row) => row.kind === "check" && row.phase === "base" && row.scope === scope)).toBe(true)
  expect(rows.some((row) => row.kind === "narrowing")).toBe(refused)
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
  const raced = await readStatus(eventStore(w), "main", "task/event-root-race")
  expect(raced.status).toBe("verifying")
  expect(raced.reason).toContain("lease lost on refs/heads/main")

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

async function submoduleMain(w: World): Promise<string> {
  const tip = (await w.git(["ls-remote", "--refs", "https://git-super.test/owned/submodule.git", "refs/heads/main"]))
    .trim()
    .split(/\s+/u)[0]
  if (tip === undefined || tip === "") throw new Error("the submodule remote has no main")
  return tip
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
