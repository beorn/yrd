/**
 * One queue run, end to end, against a real remote and a real check script.
 *
 * Every case asserts on what the plan says a reader can see: the exit code,
 * the target's commits, the change's records at the remote, and the message the
 * notifier was handed. Nothing internal.
 */

import { spawnSync } from "node:child_process"
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
import { dirname, isAbsolute, join, resolve } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { createProcess } from "@yrd/process"
import * as gitomic from "gitomic"
import { openEvents } from "gitomic/events"
import type { RefUpdate } from "gitomic"
import { gitEnvironment } from "../src/git.ts"
import { incidentTrailers } from "../src/incident.ts"
import { recentCasRefusals } from "../src/log.ts"
import { reminderDue } from "../src/override.ts"
import {
  changeName,
  checkLogPath,
  createEventQueue,
  createEventStore,
  changeInput,
  changesRef,
  drop,
  gitIn,
  mergedByRun,
  pauseRef,
  queueRef,
  queueRefPrefix,
  queueRun,
  readEventQueue,
  readEventOps,
  readConfig,
  readStatus,
  refAt,
  runCheck,
  runDiedInPreamble,
  selectionFor,
  submit,
  trailer,
  trailers,
  withdraw,
  writeQueueEvent,
  OverrideRefused,
  overrideRef,
  parseUntil,
  writeQueueOverride,
} from "../src/index.ts"
import type { CheckedTree, CheckSpec, Git, PauseRecord, QueueRunOptions, QueueRunOutcome } from "../src/index.ts"
import { resolveGitSelection } from "../src/git.ts"
import * as verifying from "../src/verifying.ts"
import { appendChangeEvent, appendPublishedMerge } from "../src/events.ts"
import { eventNoticeOwed } from "../src/event-run.ts"
import { settledBaseCommit } from "../src/settled-base.ts"
import { prepareWorktree, SetupFailed } from "../src/worktree.ts"
import { gitSuperBin } from "../../../tests/support/git-super-bin.ts"

const roots: string[] = []
// The real queue child needs GitSuper even when the worker's PATH is sealed.
const CHANGES = queueRefPrefix("main")
const PAUSE_REF = pauseRef("main")
// A rival writer's stuck record is a whole incident, as every real one is: since
// 25301 the round reads the queue again after its merge, and a reader refuses a
// stuck record that does not carry one.
const RIVAL_STUCK_TRAILERS = [
  ...incidentTrailers({
    code: "yrd-rival-writer",
    subject: "another queue got there first",
    via: "a rival writer in this test",
    evidence: "/dev/null",
    next: "nothing: a test fixture",
    owner: "the test",
  }),
  ["Reason", "crash"],
] as const

/** Intercept the real Gitomic publication seam while retaining its shell backend. */
function beforeGitomicPublish(
  before: (repo: string, updates: readonly RefUpdate[], remote?: string) => Promise<void>,
  beforeFetchRefs?: (repo: string, refs: string | readonly string[], remote: string) => Promise<void>,
  after?: (repo: string, updates: readonly RefUpdate[], remote?: string) => Promise<void>,
  beforeListRefs?: (repo: string, prefix: string, remote?: string) => Promise<ReadonlyMap<string, string> | undefined>,
): ReturnType<typeof vi.spyOn> {
  const createBackend = gitomic.createShellBackend
  return vi.spyOn(gitomic, "createShellBackend").mockImplementation((options) => {
    const backend = createBackend(options)
    const publish = backend.publish
    const fetchRefs = backend.fetchRefs
    const listRefs = backend.listRefs
    if (publish === undefined) throw new Error("Gitomic shell backend has no publish capability")
    if (fetchRefs === undefined) throw new Error("Gitomic shell backend has no fetchRefs capability")
    if (listRefs === undefined) throw new Error("Gitomic shell backend has no listRefs capability")
    return {
      ...backend,
      listRefs: async (repo, prefix, remote) =>
        (await beforeListRefs?.(repo, prefix, remote)) ?? listRefs(repo, prefix, remote),
      fetchRefs: async (repo, refs, remote) => {
        await beforeFetchRefs?.(repo, refs, remote)
        return fetchRefs(repo, refs, remote)
      },
      publish: async (repo, updates, remote) => {
        await before(repo, updates, remote)
        const published = await publish(repo, updates, remote)
        await after?.(repo, updates, remote)
        return published
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
  remote: string
  target: string
  workdir: string
  notifyLog: string
  /** The command every notify entry in these cases runs: it appends the record to `notifyLog`. */
  notifier: string
  checkLog: string
  /** Exists once the check has begun, before its sleep: the signal to act while a check is running. */
  startedLog: string
  /** The target's `setup:`, exiting as the case says; it records its own cwd in `checkLog`, beside the check's. */
  setupCommand(exit: number): string
  options(
    check: Readonly<{
      exit?: number
      sleep?: number
      /** A file the check waits for (bounded) after it starts: the case releases it once it has acted mid-check. */
      hold?: string
      timeoutMs?: number
      everywhere?: boolean
      setup?: string
      /** The phases the one check runs in; absent means merge (ruling A1). */
      on?: readonly ("submit" | "merge")[]
    }>,
  ): Promise<QueueRunOptions>
}>

/**
 * A bare remote with `main`, a clone that submits, and a fake check. With
 * `declaredLater`, main carries one commit from before the declaration: the
 * old queue's history, which the E5 reading must never judge.
 */
async function world(plan: Readonly<{ declaredLater?: boolean }> = {}): Promise<World> {
  // The workdir must be a real filesystem the runner can lstat; the OS
  // temp dir is fine for a test, the plan's rule about tmpfs is for real runs.
  const root = mkdtempSync(join(tmpdir(), "yrd-core-run-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  const workdir = join(root, "queue")
  const notifyLog = join(root, "notify.log")
  const checkLog = join(root, "check.log")
  // Written by the check BEFORE it sleeps, so a case that has to act while a
  // check is running waits on the check's own word instead of a fixed delay.
  const startedLog = join(root, "check-started.log")
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
  writeFileSync(join(work, ".yrd.yml"), "{}\n")
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
      `echo "started" >> "${startedLog}"`,
      'i=0; while [ -n "${FAKE_HOLD:-}" ] && [ ! -f "$FAKE_HOLD" ] && [ "$i" -lt 400 ]; do sleep 0.05; i=$((i+1)); done',
      `if [ "$i" -gt 0 ]; then echo "held" >> "${startedLog}"; fi`,
      'sleep "${FAKE_SLEEP:-0}"',
      `echo "check cwd=$(pwd) exit=\${FAKE_EXIT:-0} repo=\${YRD_REPO:-none} candidate=\${YRD_CANDIDATE_SHA:-none} base=\${YRD_BASE_SHA:-none} queue=\${HH_HEAVY_QUEUE_CALLER:-none}" >> "${checkLog}"`,
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
      `echo "setup cwd=$(pwd) repo=\${YRD_REPO:-none} candidate=\${YRD_CANDIDATE_SHA:-none} base=\${YRD_BASE_SHA:-none} queue=\${HH_HEAVY_QUEUE_CALLER:-none}" >> "${checkLog}"`,
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
    notifier,
    notifyLog,
    setupCommand: (exit) => `${setupScript} ${String(exit)}`,
    options: async (check) => ({
      checks: [
        {
          environmentPassthrough: ["FAKE_EXIT", "FAKE_SLEEP", "FAKE_EVERYWHERE", "FAKE_HOLD"],
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
        FAKE_HOLD: check.hold ?? "",
        PATH: `${gitSuperBin}:${process.env.PATH ?? ""}`,
      },
      notify: [{ name: "recorder", on: ["merged", "failed", "stuck", "merged-direct"], run: notifier }],
      // What the CLI passes for a queue-owned clone (`QueueLocation.owned`).
      // A run against a seat's checkout leaves that tree alone instead, which
      // is the other branch and lives in reference.test.ts.
      populateReference: true,
      repo: work,
      ...(check.setup === undefined ? {} : { setup: check.setup }),
      target: { branch: "main", remote: "origin" },
      targetSha: await remoteTarget({ git }),
      workdir,
    }),
    remote,
    startedLog,
    target,
    work,
    workdir,
  }
}

/** Create the event queue from the exact declaration commit it pins. */
async function createWorldEventQueue(w: World, commit = w.target, at = new Date()): Promise<string> {
  const config = await readConfig(w.git, commit, { branch: "main", remote: "origin" })
  if (config === undefined) throw new Error(`fixture target ${commit} lost .yrd.yml`)
  return createEventQueue(createEventStore(w.work, "origin", gitIn(w.work).selection), "main", commit, config, at)
}

/** Wait for the check to say it has begun, so a mid-check case never rests on a fixed delay. */
async function checkRunning(w: World): Promise<void> {
  for (let waited = 0; waited < 10_000; waited += 25) {
    if (existsSync(w.startedLog)) return
    await new Promise((done) => setTimeout(done, 25))
  }
  throw new Error(`the check never started: ${w.startedLog} was never written`)
}

async function submitCommit(w: World, branch: string, file: string): Promise<string> {
  await w.git(["checkout", "--quiet", "-b", branch, "main"])
  writeFileSync(join(w.work, file), `${file}\n`)
  await w.git(["add", file])
  await w.git(["commit", "--quiet", "-m", file])
  const head = (await w.git(["rev-parse", "HEAD"])).trim()
  await w.git(["checkout", "--quiet", "main"])
  await submit(w.git, "origin", {
    branch,
    submitter: "@dev/2",
    target: { branch: "main", remote: "origin" },
    issue: "@i/10-yrd/1",
  })
  return head
}

/** @failure Submit and the queue drift to different composition paths.
 * @level l2 @consumer the submitter and the queue runner
 * Separate behaviour tests cannot prove both entry points invoke one verifier.
 */
it("submit and the queue compose through the same git-only verifier, once per head and target in a round", async () => {
  const w = await world()
  await createWorldEventQueue(w)
  using calls = vi.spyOn(verifying, "verifyCandidate")
  const head = await submitCommit(w, "task/shared-verifier", "one.txt")
  expect(calls).toHaveBeenCalledTimes(1)
  expect(calls.mock.calls[0]?.[0]).toMatchObject({ head, targetHead: w.target })

  const outcome = await queueRun(await w.options({ exit: 0 }))
  expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/shared-verifier"] })
  // Submit and merge each enter the shared verifier once for this head.
  expect(calls).toHaveBeenCalledTimes(2)
  expect(calls.mock.calls.slice(1).map(([options]) => options.head)).toEqual([head])
})

async function remoteTarget(w: Pick<World, "git">): Promise<string> {
  const target = (await w.git(["ls-remote", "--refs", "origin", "refs/heads/main"])).trim().split(/\s+/u)[0]
  if (target === undefined || target === "") throw new Error("origin/main has no declared target")
  return target
}

/**
 * @failure  An event queue could be submitted to but its runner refused every change.
 * @level    l3 — real remote, composition and atomic target/event publication
 * @consumer queue operator and submitter
 */
it("runs a check-free event change through one atomic merge", async () => {
  const w = await world()
  await createWorldEventQueue(w)
  const head = await submitCommit(w, "task/event-run", "one.txt")
  const options = { ...(await w.options({ exit: 0 })), checks: [], notify: [] }

  const outcome = await queueRun(options)

  expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/event-run"] })
  // The line as the round read it, before its merge (25669): what the service
  // judges a stall from. Nothing was judged before this round.
  expect(outcome.line).toEqual({
    oldest: { branch: "task/event-run", openedAt: expect.any(String) },
    waiting: 1,
  })
  const state = await readStatus(createEventStore(w.work, "origin", gitIn(w.work).selection), "main", "task/event-run")
  expect(state).toMatchObject({ status: "merged", commit: head })
  expect(state.candidate).toBe(await remoteTarget(w))
  expect(state.candidate).not.toBe(head)
  expect(await w.git(["rev-parse", `${state.candidate}^1`])).toMatch(new RegExp(w.target))
  // 25685: Gate-E finds the event landing's checked change through these exact legacy trailers.
  const message = await w.git(["show", "-s", "--format=%B", state.candidate!])
  expect(message).toMatch(new RegExp(`^merge task/event-run@${head.slice(0, 12)} into main\\n\\n`))
  expect(message).toContain(`Change: task/event-run@${head}`)
  expect(message).toMatch(/Merged-By: yrd queue main \[q-[^\]]+\]/u)
  expect(message).toContain("Issue: @i/10-yrd/1")
  expect(message).toContain("Submitter: @dev/2")
  expect(await w.git(["ls-remote", "--refs", "origin", "refs/yrd/main/candidates/*"])).toBe("")
})

/** @failure One malformed change chain ended the service round before healthy changes could merge (25658).
 * @level l3 @consumer queue operator and submitter
 * The projection test cannot witness the service continuing through judgement and publication.
 */
it("merges a healthy event change beside one malformed change chain", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  const queueTip = await createWorldEventQueue(w)
  const head = await submitCommit(w, "task/healthy", "healthy.txt")
  const brokenRef = changesRef("main", "task/broken")
  await (
    await openEvents({ ...store, ref: brokenRef })
  ).append([changeInput("failed", { queueTip, at: new Date(), reason: "missing opening" })], { expect: null })

  const outcome = await queueRun({ ...(await w.options({ exit: 0 })), checks: [], notify: [] })

  expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/healthy"] })
  expect(await readStatus(store, "main", "task/healthy")).toMatchObject({ status: "merged", commit: head })
  expect(logRecords(outcome)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "observation",
        subject: "invalid-change-chain",
        branch: "task/broken",
        ref: brokenRef,
      }),
    ]),
  )
})

/** @failure A verifier refusal before checks omitted the branch's failures count, so the strict notify entry refused the record and the submitter heard nothing.
 * @level l3 @consumer event queue submitter (@i/10-yrd/25815)
 */
it("notifies the submitter when an event change fails before any check", async () => {
  const w = await world()
  await createWorldEventQueue(w)
  await w.git(["checkout", "--quiet", "-b", "task/precheck-refused", "main"])
  writeFileSync(join(w.work, "target.txt"), "change side\n")
  await w.git(["commit", "--quiet", "-am", "change the target line"])
  await w.git(["checkout", "--quiet", "main"])
  await submit(w.git, "origin", {
    branch: "task/precheck-refused",
    submitter: "@dev/2",
    target: { branch: "main", remote: "origin" },
    issue: "@i/10-yrd/25815",
  })
  writeFileSync(join(w.work, "target.txt"), "main side\n")
  await w.git(["commit", "--quiet", "-am", "move the target before queue verification"])
  await w.git(["push", "--quiet", "origin", "main"])

  const outcome = await queueRun({
    ...(await w.options({ exit: 0 })),
    notify: [{ name: "submitter", on: ["failed"], run: w.notifier }],
  })

  expect(outcome.failed).toEqual(["task/precheck-refused"])
  expect(existsSync(w.checkLog)).toBe(false)
  expect(messages(w)).toMatchObject([{ record: "failed", submitter: "@dev/2", failures: 1 }])
  const status = await readStatus(
    createEventStore(w.work, "origin", gitIn(w.work).selection),
    "main",
    "task/precheck-refused",
  )
  expect(status.status).toBe("failed")
  expect(Object.values(status.notices ?? {})).toMatchObject([{ result: "delivered" }])
})

/** @failure A second failed ending from the same branch HEAD could be hidden by the notifier's stable message id.
 * @level l3 @consumer event queue submitter (#25041)
 */
it("sends two failed endings when the same head is resubmitted", async () => {
  const w = await world()
  await createWorldEventQueue(w)
  const head = await submitCommit(w, "task/same-head-failed", "one.txt")
  const failing = await w.options({ exit: 1, on: ["submit"] })

  expect((await queueRun(failing)).failed).toEqual(["task/same-head-failed"])
  const submitted = await submit(w.git, "origin", {
    branch: "task/same-head-failed",
    submitter: "@dev/2",
    target: { branch: "main", remote: "origin" },
    issue: "@i/10-yrd/25041",
  })
  expect(submitted).toMatchObject({ head, retry: false })
  expect((await queueRun(failing)).failed).toEqual(["task/same-head-failed"])

  expect(messages(w)).toMatchObject([
    { record: "failed", change: `task/same-head-failed@${head}`, failures: 1 },
    { record: "failed", change: `task/same-head-failed@${head}`, failures: 2 },
  ])
  expect(messages(w).map((message) => message.endingId)).toEqual([expect.any(String), expect.any(String)])
  expect(messages(w)[0]?.endingId).not.toBe(messages(w)[1]?.endingId)
})

/** @failure 25041: a second stuck event for the same branch@head reused the first notice identity.
 * @level l3 @consumer queue operator and notified recipient
 */
it("gives distinct IDs to stuck, drop, resubmit, stuck at one head", async () => {
  const w = await world()
  await createWorldEventQueue(w)
  const head = await submitCommit(w, "task/repeated-stuck", "one.txt")
  const first = await queueRun(await w.options({ exit: 2, on: ["submit"] }))
  expect(first.stuck).toEqual(["task/repeated-stuck"])
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await drop(store, { queue: "main", branch: "task/repeated-stuck", by: "@chief" })
  const resubmitted = await submit(w.git, "origin", {
    branch: "task/repeated-stuck",
    submitter: "@dev/2",
    target: { branch: "main", remote: "origin" },
    issue: "@i/10-yrd/25041",
  })
  expect(resubmitted).toMatchObject({ head, retry: false })
  const second = await queueRun(await w.options({ exit: 2, on: ["submit"] }))
  expect(second.stuck).toEqual(["task/repeated-stuck"])
  const sent = messages(w)
  expect(sent).toMatchObject([
    { record: "stuck", change: `task/repeated-stuck@${head}` },
    { record: "stuck", change: `task/repeated-stuck@${head}` },
  ])
  expect(sent[0]?.endingId).toEqual(expect.any(String))
  expect(sent[1]?.endingId).toEqual(expect.any(String))
  expect(sent[0]?.endingId).not.toBe(sent[1]?.endingId)
})

/** @failure 25041 A7: skipping the runner's override clock leaves an expired check held off without a notice.
 * @level l3 @consumer event queue operator and merge runner
 */
it("expires an event override on the round's clock and tells its operator", async () => {
  const w = await world()
  await createWorldEventQueue(w)
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await submitCommit(w, "task/override-clock", "clock.txt")
  const now = Date.now()
  await writeQueueOverride(
    store,
    "main",
    {
      kind: "off",
      check: "verify",
      until: new Date(now + 3_600_000),
      reason: "window",
      actor: { by: "@chief", verified: true },
    },
    ["verify"],
    new Date(now),
  )
  const paged = join(w.workdir, "override-clock.jsonl")
  const outcome = await queueRun({
    ...(await w.options({ exit: 0, on: ["submit", "merge"] })),
    now: () => now + 2 * 3_600_000,
    notify: [{ name: "pager", on: ["override"], run: `cat >> ${paged}` }],
  })
  expect(outcome.merged).toEqual(["task/override-clock"])
  expect((await readEventOps(store, w.git, "main", await remoteTarget(w))).overrides.entries).toMatchObject([
    { check: "verify", state: "expired" },
  ])
  expect(existsSync(paged)).toBe(true)
  expect(JSON.parse(readFileSync(paged, "utf8")) as Record<string, unknown>).toMatchObject({
    action: "expired",
    check: "verify",
    owner: "@chief",
  })
  expect(readFileSync(w.checkLog, "utf8").trim().split("\n")).toHaveLength(2)
})

/** @failure A post-cutover merge could move main while its queue ops lease remained a client-only no-op.
 * @level l3 @consumer merge runner and queue operator
 */
it("publishes a named merge-fenced queue event with the target and merged change", async () => {
  const w = await world()
  await createWorldEventQueue(w)
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  const cutover = (await readEventQueue(store, "main")).tip
  const head = await submitCommit(w, "task/ops-fence", "fenced.txt")
  const outcome = await queueRun({ ...(await w.options({ exit: 0 })), checks: [], notify: [] })
  expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/ops-fence"] })
  const change = await readStatus(store, "main", "task/ops-fence")
  const queue = await readEventQueue(store, "main")
  expect(queue.tip).not.toBe(cutover)
  expect(queue.ops).toEqual({ overrides: [] })
  const events = await (await openEvents({ ...store, ref: queueRef("main") })).events()
  const fence = events.at(-1)
  expect(fence?.type).toBe("merge-fenced")
  expect(fence?.props).toEqual(
    expect.arrayContaining([
      ["For", change.ending?.id],
      ["Branch", "task/ops-fence"],
      ["Commit", change.candidate],
    ]),
  )
  expect(change.commit).toBe(head)
})

/** @failure An event merge ran a check whose active override held it off, or ignored the later clear.
 * @level l3 @consumer queue operator and merge runner
 */
it("applies an event override to merge checks and runs the check after clear", async () => {
  const w = await world()
  await createWorldEventQueue(w)
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await submitCommit(w, "task/override-off", "off.txt")
  await writeQueueOverride(
    store,
    "main",
    {
      kind: "off",
      check: "verify",
      until: new Date(Date.now() + 3_600_000),
      reason: "repair",
      actor: { by: "operator", verified: true },
    },
    ["verify"],
    new Date(),
  )
  const off = await queueRun(await w.options({ exit: 0, on: ["merge"] }))
  expect(off).toMatchObject({ exitCode: 0, merged: ["task/override-off"] })
  expect((await readStatus(store, "main", "task/override-off")).reason).toContain("verify (merge override)")
  expect(existsSync(w.checkLog) ? readFileSync(w.checkLog, "utf8").trim() : "").toBe("")
  await writeQueueOverride(
    store,
    "main",
    { kind: "clear", check: "verify", reason: "fixed", actor: { by: "operator", verified: true } },
    ["verify"],
    new Date(),
  )
  await submitCommit(w, "task/override-on", "on.txt")
  const on = await queueRun(await w.options({ exit: 0, on: ["merge"] }))
  expect(on).toMatchObject({ exitCode: 0, merged: ["task/override-on"] })
  expect(readFileSync(w.checkLog, "utf8")).toContain("check cwd=")
})

/**
 * @failure A round's remote calls were unknown: the journal named only yrd's own Git, never Gitomic's reads or
 *          git-super's children, and no row counted them (25570 row 3).
 * @level    l3 — a real round through every runner, counted from git's own trace2 log
 * @consumer the operator reading a round's GitHub login cost
 */
it("closes the round's journal with every remote call it made, counted from git's trace2 log", async () => {
  const w = await world()
  await createWorldEventQueue(w)
  await submitCommit(w, "task/event-counted", "counted.txt")
  const before = process.env.GIT_TRACE2_EVENT

  const outcome = await queueRun({ ...(await w.options({ exit: 0 })), checks: [], notify: [] })

  expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/event-counted"] })
  expect(process.env.GIT_TRACE2_EVENT).toBe(before)
  const journal = readdirSync(join(w.workdir, "logs")).find((name) => name.endsWith(".jsonl"))
  if (journal === undefined) throw new Error("queue run left no journal")
  const rows = readFileSync(join(w.workdir, "logs", journal), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  // Every round journals its waiting count (25669): the number the stall threshold is tuned from.
  expect(rows.filter((row) => row.kind === "observation" && row.subject === "line")).toEqual([
    expect.objectContaining({ oldestBranch: "task/event-counted", waiting: 1 }),
  ])
  const counted = rows.at(-1)
  expect(counted).toMatchObject({ kind: "remote-calls", unreadable: 0 })
  // The merge fetched and published: both are real remote calls, and every git process wrote its log.
  expect(counted?.fetch).toEqual(expect.any(Number))
  expect(counted?.push).toEqual(expect.any(Number))
  expect(Number(counted?.processes)).toBeGreaterThan(Number(counted?.fetch) + Number(counted?.push))
  // The trace2 log is removed once counted: the row is the evidence, and a kept log grew the workdir every round.
  expect(existsSync(join(w.workdir, "logs", journal.replace(/\.jsonl$/u, ""), "trace2"))).toBe(false)
})

/** @failure A deleted event branch stayed queued forever and blocked every change behind it.
 * @level l3 @consumer queue operator and submitter
 */
it("ends a deleted event branch with its last commit kept, then continues the line", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  const deleted = await submitCommit(w, "task/deleted-event", "deleted.txt")
  await submitCommit(w, "task/after-deleted", "after.txt")
  const standing = await readStatus(store, "main", "task/deleted-event")
  if (standing.tip === undefined) throw new Error("submitted event has no tip")
  await appendChangeEvent(store, "main", "task/deleted-event", standing.tip, {
    type: "stuck",
    at: new Date(),
    reason: "branch owner must act",
  })
  await w.git(["push", "--quiet", "origin", ":refs/heads/task/deleted-event"])

  const outcome = await queueRun({
    ...(await w.options({ exit: 0 })),
    checks: [],
    notify: [{ name: "recorder", on: ["cancelled"], run: w.notifier }],
    now: () => Date.now() + 75_001,
  })

  expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/after-deleted"], stuck: [] })
  const state = await readStatus(store, "main", "task/deleted-event")
  expect(state).toMatchObject({ status: "cancelled", commit: deleted, reason: "deleted" })
  const ending = (await (await openEvents({ ...store, ref: changesRef("main", "task/deleted-event") })).events()).find(
    (event) => event.id === state.ending?.id,
  )
  expect(ending).toMatchObject({ type: "cancelled", links: [deleted] })
  expect(state.notices?.[`${state.ending?.id}:recorder`]).toMatchObject({ result: "delivered" })
  expect(readFileSync(w.notifyLog, "utf8")).toContain('"record":"cancelled"')
  expect(messages(w)[0]?.endingId).toEqual(expect.any(String))
  expect(await w.git(["ls-remote", "--refs", "origin", "refs/heads/task/deleted-event"])).toBe("")
})

/** @failure An explicit drop was mistaken for a queue-authored cancellation notice.
 * @level l3 @consumer submitter
 */
it("keeps an explicit event drop silent even when a cancelled notifier is declared", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/dropped-event", "dropped.txt")
  await drop(store, { queue: "main", branch: "task/dropped-event", by: "operator" })

  await queueRun({
    ...(await w.options({ exit: 0 })),
    checks: [],
    notify: [{ name: "recorder", on: ["cancelled"], run: w.notifier }],
  })
  expect(await readStatus(store, "main", "task/dropped-event")).toMatchObject({
    status: "cancelled",
    reason: "dropped",
  })
  expect(existsSync(w.notifyLog)).toBe(false)
})

/** @failure A just-opened branch could be absent from remote reads during propagation.
 * @level l3 @consumer event queue submitter
 */
it("skips a just-opened event branch absent from the remote during its grace window", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  const head = await submitCommit(w, "task/grace", "grace.txt")
  await w.git(["push", "--quiet", "origin", ":refs/heads/task/grace"])

  const outcome = await queueRun({ ...(await w.options({ exit: 0 })), checks: [], notify: [] })
  expect(outcome).toMatchObject({ exitCode: 0, merged: [] })
  expect(await readStatus(store, "main", "task/grace")).toMatchObject({ status: "queued", commit: head })
  const journal = readdirSync(join(w.workdir, "logs")).find((name) => name.endsWith(".jsonl"))
  if (journal === undefined) throw new Error("queue run left no journal")
  const rows = readFileSync(join(w.workdir, "logs", journal), "utf8")
  expect(rows).toContain('"subject":"branch-list-omissions","count":1,"branches":["task/grace"]')
  expect(rows).toContain('"answer":"absent"')
  expect(rows).toContain('"protected":true')
})

/** @failure An incomplete branch listing cancelled a live event change as deleted.
 * @level l3 @consumer event queue submitter
 * The deletion case above proves the remote's exact absence still ends a change.
 */
it("keeps a live event change when its ref is omitted from the broad listing", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  const head = await submitCommit(w, "task/live-event", "live.txt")
  const wrapper = join(w.workdir, "git-omit-broad-head.sh")
  writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      'case " $* " in',
      '  *"ls-remote"*"refs/heads/*"*)',
      '    output=$(git "$@") || exit $?',
      '    printf "%s\\n" "$output" | sed "/refs\\/heads\\/task\\/live-event$/d"',
      "    exit 0;;",
      "esac",
      'exec git "$@"',
      "",
    ].join("\n"),
  )
  chmodSync(wrapper, 0o755)
  const outcome = await queueRun({
    ...(await w.options({ exit: 0 })),
    checks: [],
    notify: [],
    selection: { ...selectionFor(w.git), executable: wrapper },
  })

  expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/live-event"] })
  expect(await readStatus(store, "main", "task/live-event")).toMatchObject({ status: "merged", commit: head })
})

/** @failure A failed exact remote read was mistaken for proof that a branch was deleted.
 * @level l3 @consumer event queue submitter
 */
it("leaves an event change open when confirmation of its missing branch fails", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  const head = await submitCommit(w, "task/unconfirmed", "unconfirmed.txt")
  const wrapper = join(w.workdir, "git-fail-exact-head.sh")
  writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      'case " $* " in',
      '  *"ls-remote"*"refs/heads/*"*)',
      '    output=$(git "$@") || exit $?',
      '    printf "%s\\n" "$output" | sed "/refs\\/heads\\/task\\/unconfirmed$/d"',
      "    exit 0;;",
      '  *"ls-remote"*"refs/heads/task/unconfirmed"*) exit 42;;',
      "esac",
      'exec git "$@"',
      "",
    ].join("\n"),
  )
  chmodSync(wrapper, 0o755)
  const outcome = await queueRun({
    ...(await w.options({ exit: 0 })),
    checks: [],
    notify: [],
    selection: { ...selectionFor(w.git), executable: wrapper },
  })
  expect(outcome).toMatchObject({ exitCode: 0, merged: [] })
  expect(await readStatus(store, "main", "task/unconfirmed")).toMatchObject({ status: "queued", commit: head })
  const journal = readdirSync(join(w.workdir, "logs")).find((name) => name.endsWith(".jsonl"))
  if (journal === undefined) throw new Error("queue run left no journal")
  expect(readFileSync(join(w.workdir, "logs", journal), "utf8")).toContain("branch-list-omission")
  expect(readFileSync(join(w.workdir, "logs", journal), "utf8")).toContain('"answer":"error"')
})

/** @failure A run treated an already-stuck event change as absent and advanced the line.
 * @level l3 @consumer queue operator
 */
it("stops an event queue at a stuck change", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/a", "one.txt")
  await submitCommit(w, "task/b", "two.txt")
  await writeQueueEvent(store, "main", { type: "paused", by: "operator", reason: "earlier repair", at: new Date() })
  await writeQueueEvent(store, "main", {
    type: "resumed",
    by: "operator",
    reason: "earlier repair done",
    at: new Date(),
  })
  const first = await readStatus(store, "main", "task/a")
  if (first.tip === undefined) throw new Error("submitted event has no tip")
  await appendChangeEvent(store, "main", "task/a", first.tip, {
    type: "stuck",
    at: new Date(),
    reason: "repair needed",
  })

  const outcome = await queueRun({ ...(await w.options({ exit: 0 })), checks: [], notify: [] })

  expect(outcome).toMatchObject({ exitCode: 2, stuck: ["task/a"], merged: [] })
  expect(await remoteTarget(w)).toBe(w.target)
  expect((await readStatus(store, "main", "task/b")).status).toBe("queued")
})

/** @failure A resumed event queue still refused its stuck head, so the operator could not restart the line.
 * @level l3 @consumer queue operator
 */
it("retries a stuck event change after an operator resumes the queue", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/stuck-first", "one.txt")
  await submitCommit(w, "task/behind", "two.txt")
  const first = await readStatus(store, "main", "task/stuck-first")
  if (first.tip === undefined) throw new Error("submitted event has no tip")
  await appendChangeEvent(store, "main", "task/stuck-first", first.tip, {
    type: "stuck",
    at: new Date(),
    reason: "repair needed",
  })
  await writeQueueEvent(store, "main", { type: "paused", by: "operator", reason: "repair", at: new Date() })
  const held = await queueRun({ ...(await w.options({ exit: 0 })), checks: [], notify: [] })
  expect(held).toMatchObject({ exitCode: 0, merged: [], stopped: { ring: "pause" } })
  await writeQueueEvent(store, "main", { type: "resumed", by: "operator", reason: "repaired", at: new Date() })

  const resumed = await queueRun({ ...(await w.options({ exit: 0 })), checks: [], notify: [] })

  expect(resumed).toMatchObject({ exitCode: 0, merged: ["task/stuck-first"], stuck: [] })
  expect((await readStatus(store, "main", "task/stuck-first")).status).toBe("merged")
  expect((await readStatus(store, "main", "task/behind")).status).toBe("queued")
})

/** @failure A new round ignored a previously active event phase and left a change in limbo.
 * @level l3 @consumer queue operator and submitter
 */
it("reverifies an unfinished event phase in a later round", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  const head = await submitCommit(w, "task/reverify", "one.txt")
  const queued = await readStatus(store, "main", "task/reverify")
  if (queued.tip === undefined) throw new Error("submitted event has no tip")
  await appendChangeEvent(store, "main", "task/reverify", queued.tip, {
    type: "verifying",
    at: new Date(),
    commit: head,
  })

  const outcome = await queueRun({ ...(await w.options({ exit: 0 })), checks: [], notify: [] })

  expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/reverify"] })
  expect((await readStatus(store, "main", "task/reverify")).candidate).toBe(await remoteTarget(w))
})

/** @failure A configured event runner could report success without running the target's merge check.
 * @level l3 @consumer queue operator, submitter and check reader
 */
it("runs a configured event change's default merge check before merging", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/configured-event", "one.txt")

  const outcome = await queueRun({ ...(await w.options({ exit: 0 })), notify: [] })

  expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/configured-event"], failed: [], stuck: [] })
  expect(await remoteTarget(w)).not.toBe(w.target)
  const checkLog = checkLogFor(outcome, "task/configured-event", "merge", "verify")
  expect(await readStatus(store, "main", "task/configured-event")).toMatchObject({
    status: "merged",
    reason: expect.stringContaining(checkLog),
  })
  expect(existsSync(checkLog)).toBe(true)
  expect(readFileSync(w.checkLog, "utf8")).toContain("check cwd=")
  expect(logRecords(outcome)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "result", name: "verify", phase: "merge", result: "pass", exit: "0" }),
    ]),
  )
  const events = await (await openEvents({ ...store, ref: changesRef("main", "task/configured-event") })).events()
  const deciding = events.find((event) => event.type === "merging")
  expect(deciding?.props).toEqual(
    expect.arrayContaining([
      ["Base", w.target],
      ["Config", "test-config"],
      ["Check", expect.stringMatching(/^verify exit=0 ms=\d+ result=pass attempt=1 phase=merge log=/u)],
    ]),
  )
  expect(deciding?.links).toEqual([await remoteTarget(w)])
})

/** @failure A merged event says disabled checks passed and cites log paths that no check wrote.
 * @level l3 @consumer queue operator and submitter
 */
it("cites only measured check logs in a mixed event run (26089)", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/mixed-checks", "one.txt")

  const outcome = await queueRun({
    ...(await w.options({ exit: 0 })),
    checks: [
      { name: "off-submit", run: "true", on: ["submit"] },
      { name: "verify", run: "echo measured" },
      { name: "off-merge", run: "true" },
    ],
    notify: [],
  })

  expect(outcome.merged).toEqual(["task/mixed-checks"])
  const measured = checkLogFor(outcome, "task/mixed-checks", "merge", "verify")
  const status = await readStatus(store, "main", "task/mixed-checks")
  expect(status.reason).toContain(measured)
  expect(status.reason).toContain("off-submit (configured off)")
  expect(status.reason).toContain("off-merge (configured off)")
  expect(status.reason).not.toContain("off-submit.log")
  expect(status.reason).not.toContain("off-merge.log")
  expect(readFileSync(measured, "utf8")).toContain("measured")
})

/** @failure An absent check log throws during transport retry detection, so the queue never records its unmeasured verdict.
 * @level l3 @consumer queue operator and submitter
 */
it("records a missing event check log as stuck instead of retrying it (26089)", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/lost-check-log", "one.txt")

  const outcome = await queueRun({
    ...(await w.options({ exit: 0 })),
    checks: [{ name: "verify", run: `find "${join(w.workdir, "checks")}" -name verify.log -delete` }],
    notify: [],
  })

  expect(outcome).toMatchObject({ exitCode: 2, stuck: ["task/lost-check-log"], merged: [] })
  expect(await readStatus(store, "main", "task/lost-check-log")).toMatchObject({
    status: "stuck",
    reason: expect.stringContaining("missing after completion"),
  })
})

/** @failure Event admission or the queue-owned notification setup ran without the queue caller marker.
 * @level l3 @consumer queue operator and submitter
 */
it("runs submit and merge checks with setup before each phase and retains both verdicts", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/two-phases", "one.txt")
  const options = await w.options({ exit: 0, on: ["submit", "merge"], setup: w.setupCommand(0) })

  const outcome = await queueRun(options)

  expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/two-phases"] })
  const checkLines = readFileSync(w.checkLog, "utf8").trim().split("\n")
  expect(checkLines.filter((line) => line.startsWith("setup cwd="))).toHaveLength(3)
  expect(checkLines.find((line) => /^setup cwd=.*\/notify repo=/u.test(line))).toMatch(/ queue=1$/u)
  expect(checkLines).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/^setup cwd=.* queue=1$/u),
      expect.stringMatching(/^check cwd=.* queue=1$/u),
    ]),
  )
  expect(logRecords(outcome)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "result", name: "verify", phase: "submit", result: "pass" }),
      expect.objectContaining({ kind: "result", name: "verify", phase: "merge", result: "pass" }),
    ]),
  )
  const events = await (await openEvents({ ...store, ref: changesRef("main", "task/two-phases") })).events()
  const checks = events.find((event) => event.type === "merging")?.props.filter(([key]) => key === "Check")
  expect(checks).toEqual([
    ["Check", expect.stringMatching(/result=pass attempt=1 phase=submit/u)],
    ["Check", expect.stringMatching(/result=pass attempt=1 phase=merge/u)],
  ])
})

/** @failure Event setup failures escaped without attributing the candidate against its settled base.
 * @level l3 @consumer queue operator and submitter
 */
it("bills a candidate-only setup failure to the change and retains its result", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/setup-event", "one.txt")
  const base = await w.options({ exit: 0 })

  const outcome = await queueRun({ ...base, notify: [], checks: [], setup: "test ! -f one.txt" })

  expect(outcome).toMatchObject({ exitCode: 1, failed: ["task/setup-event"], stuck: [] })
  expect((await readStatus(store, "main", "task/setup-event")).status).toBe("failed")
  const events = await (await openEvents({ ...store, ref: changesRef("main", "task/setup-event") })).events()
  expect(events.find((event) => event.type === "failed")?.props).toContainEqual([
    "Check",
    expect.stringMatching(/^setup exit=1 .*result=fail attempt=1 phase=submit /u),
  ])
})

/** @failure A setup defect on the target base was billed to the submitted change.
 * @level l3 @consumer queue operator and submitter
 */
it("stops the event line when setup fails on the settled base too", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/base-setup-event", "one.txt")
  const base = await w.options({ exit: 0 })

  const outcome = await queueRun({ ...base, notify: [], checks: [], setup: "false" })

  expect(outcome).toMatchObject({ exitCode: 2, stuck: ["task/base-setup-event"], failed: [] })
  expect((await readStatus(store, "main", "task/base-setup-event")).status).toBe("stuck")
})

/** @failure Bare target setup passed while a candidate-raised gitlink broke the queue-owned settled base.
 * @level l3 @consumer queue operator and submitter
 */
it("judges setup on the target with raised gitlinks rather than its bare pin", async () => {
  const w = await world()
  const child = join(w.workdir, "raised-child")
  await w.git(["init", "--quiet", "--initial-branch=main", child])
  const childGit = gitIn(child)
  await childGit(["config", "user.email", "queue@yrd.test"])
  await childGit(["config", "user.name", "yrd"])
  writeFileSync(join(child, "healthy"), "ready\n")
  await childGit(["add", "healthy"])
  await childGit(["commit", "--quiet", "-m", "healthy child"])
  const healthy = (await childGit(["rev-parse", "HEAD"])).trim()
  await w.git(["config", "protocol.file.allow", "always"])
  for (const [key, value] of [
    ["path", "child"],
    ["url", child],
    ["branch", "main"],
  ] as const) {
    await w.git(["config", "-f", ".gitmodules", `submodule.child.${key}`, value])
  }
  await w.git(["add", ".gitmodules"])
  await w.git(["update-index", "--add", "--cacheinfo", `160000,${healthy},child`])
  await w.git(["commit", "--quiet", "-m", "target with healthy child"])
  const target = (await w.git(["rev-parse", "HEAD"])).trim()
  await w.git(["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--", "child"])
  await childGit(["rm", "healthy"])
  await childGit(["commit", "--quiet", "-m", "break child setup"])
  const raised = (await childGit(["rev-parse", "HEAD"])).trim()
  const git = gitIn(w.work)
  const settled = await settledBaseCommit({
    git,
    repo: w.work,
    targetSha: target,
    raises: [{ path: "child", mode: "160000", from: healthy, to: raised }],
    path: join(w.workdir, "settled-compose"),
    branch: "task/raise",
    populateReference: true,
  })
  expect(settled).not.toBe(target)
  expect(await git(["ls-tree", "--object-only", target, "child"])).toContain(healthy)
  expect(await git(["ls-tree", "--object-only", settled, "child"])).toContain(raised)
  const setup = {
    run: "test -f child/healthy",
    logDir: join(w.workdir, "settled-logs"),
    tmpdir: join(w.workdir, "tmp"),
  }
  const bare = await prepareWorktree(git, w.work, target, join(w.workdir, "bare-base"), {
    targetSha: target,
    populateReference: true,
    setup,
  })
  await bare.remove()
  await expect(
    prepareWorktree(git, w.work, settled, join(w.workdir, "raised-base"), {
      targetSha: target,
      populateReference: true,
      setup: { ...setup, logDir: join(w.workdir, "raised-logs") },
    }),
  ).rejects.toBeInstanceOf(SetupFailed)
})

/** @failure A temporary remote setup outage stopped the event line before its one in-round retry.
 * @level l3 @consumer queue operator and submitter
 */
it("retries a remote-class event setup failure after base attribution", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/setup-retry-event", "one.txt")
  const fault = faultySetup(w, UNREACHABLE_SETUP, { once: true })

  const outcome = await queueRun({ ...(await w.options({ exit: 0, setup: fault.command })), notify: [] })

  expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/setup-retry-event"], stuck: [] })
  expect(logRecords(outcome)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "warning", branch: "task/setup-retry-event", reason: "retried" }),
    ]),
  )
  const events = await (await openEvents({ ...store, ref: changesRef("main", "task/setup-retry-event") })).events()
  expect(events.find((event) => event.type === "merging")?.props).toContainEqual([
    "Check",
    expect.stringMatching(/result=pass attempt=2 phase=merge/u),
  ])
})

/** @failure A repeated remote setup outage could stop without both attempt rows or a retry marker.
 * @level l3 @consumer queue operator and Gate E
 */
it("retains both setup attempts when a remote-class outage stops the event line", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/setup-stuck-retry", "one.txt")
  const fault = faultySetup(w, UNREACHABLE_SETUP)

  const outcome = await queueRun({ ...(await w.options({ exit: 0, setup: fault.command })), notify: [] })

  expect(outcome).toMatchObject({ exitCode: 2, stuck: ["task/setup-stuck-retry"] })
  const events = await (await openEvents({ ...store, ref: changesRef("main", "task/setup-stuck-retry") })).events()
  const stuck = events.find((event) => event.type === "stuck")
  expect(stuck?.props).toContainEqual(["Retried", "1"])
  expect(stuck?.props.filter(([key]) => key === "Check")).toEqual([
    ["Check", expect.stringMatching(/^setup exit=128 .*result=stuck attempt=1 phase=submit /u)],
    ["Check", expect.stringMatching(/^setup exit=128 .*result=stuck attempt=2 phase=submit /u)],
  ])
})

/** @failure A program-root check was accepted without its protected program root and still landed.
 * @level l3 @consumer queue operator and declaration author
 */
it("runs an event program-root check through the shared protected executor", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/program-root", "one.txt")
  const base = await w.options({ exit: 0 })
  const options = {
    ...base,
    notify: [],
    checks: [
      {
        ...base.checks[0]!,
        programRoot: true as const,
        run: 'test -d "$YRD_PROGRAM_ROOT" && test "$YRD_PROGRAM_ROOT" != "$(pwd)"',
      },
    ],
  }

  const outcome = await queueRun(options)

  expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/program-root"] })
  const events = await (await openEvents({ ...store, ref: changesRef("main", "task/program-root") })).events()
  expect(events.find((event) => event.type === "merging")?.props).toContainEqual([
    "Check",
    expect.stringMatching(/^verify exit=0 .*result=pass attempt=1 phase=merge /u),
  ])
})

/** @failure A change could replace a target-owned check script before its own event check ran.
 * @level l3 @consumer queue operator and declaration author
 */
it("restores target-owned scripts before an event check runs", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await w.git(["checkout", "--quiet", "-b", "task/script-overlay", "main"])
  writeFileSync(join(w.work, ".yrd.yml"), "changed by branch\n")
  writeFileSync(join(w.work, "one.txt"), "one\n")
  await w.git(["add", ".yrd.yml", "one.txt"])
  await w.git(["commit", "--quiet", "-m", "rewrite protected script"])
  await w.git(["checkout", "--quiet", "main"])
  await submit(w.git, "origin", {
    branch: "task/script-overlay",
    submitter: "@dev/2",
    target: { branch: "main", remote: "origin" },
    issue: "@i/10-yrd/1",
  })
  const base = await w.options({ exit: 0 })
  const outcome = await queueRun({
    ...base,
    notify: [],
    checks: [{ ...base.checks[0]!, run: "grep -qx '{}' .yrd.yml", scripts: [".yrd.yml"] }],
  })

  expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/script-overlay"] })
  const events = await (await openEvents({ ...store, ref: changesRef("main", "task/script-overlay") })).events()
  expect(events.find((event) => event.type === "merging")?.props).toContainEqual([
    "Check",
    expect.stringMatching(/^verify exit=0 .*result=pass attempt=1 phase=merge /u),
  ])
})

/** @failure An event ending gave the notifier no message or repeatable receipt after the journal vanished.
 * @level l3 @consumer queue operator and notified recipient
 */
it("delivers an event ending and settles its recipient on the branch chain", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/notified-event", "one.txt")

  const outcome = await queueRun(await w.options({ exit: 0 }))

  expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/notified-event"] })
  expect(readFileSync(w.notifyLog, "utf8")).toContain('"record":"merged"')
  expect(messages(w)[0]?.endingId).toEqual(expect.any(String))
  const events = await (await openEvents({ ...store, ref: changesRef("main", "task/notified-event") })).events()
  const merged = events.find((event) => event.type === "merged")
  expect(merged).toBeDefined()
  expect(events.find((event) => event.type === "notified")?.props).toEqual(
    expect.arrayContaining([
      ["For", merged?.id],
      ["To", "recorder"],
      ["Result", "delivered"],
    ]),
  )
  expect(await readStatus(store, "main", "task/notified-event")).toMatchObject({
    status: "merged",
    notices: {
      [`${merged?.id}:recorder`]: { for: merged?.id, to: "recorder", result: "delivered" },
    },
  })
})

/** @failure Migration replayed a pre-switch merge as a fresh notification every round.
 * @level l0 @consumer queue notifier
 */
it("counts migrated endings as told and fresh endings by their receipt", () => {
  const id = "a".repeat(40)
  const fresh = { id, props: [] }
  const migrated = { id, props: [["Migrated-From", `refs/yrd/main/task/old@${"b".repeat(40)}`] as const] }
  const delivered = { [`${id}:recorder`]: { for: id, to: "recorder", result: "delivered" as const } }

  expect(eventNoticeOwed(migrated, undefined, "recorder")).toBe(false)
  expect(eventNoticeOwed(fresh, undefined, "recorder")).toBe(true)
  expect(eventNoticeOwed(fresh, delivered, "recorder")).toBe(false)
})

/** @failure Migration replayed a pre-switch merge as a fresh notification every round.
 * @level l3 @consumer submitter and queue operator
 */
it("does not notify a migrated ending again", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  const queueTip = await createWorldEventQueue(w)
  const chain = await openEvents({ ...store, ref: changesRef("main", "task/migrated-notice") })
  const source = `refs/yrd/main/task/migrated-notice@${w.target}`
  const migrated = (input: ReturnType<typeof changeInput>) => ({
    ...input,
    props: [...(input.props ?? []), ["Migrated-From", source] as const],
    keeps: [...new Set([...(input.keeps ?? []), w.target])],
  })
  await chain.append(
    [
      migrated(changeInput("opened", { queueTip, at: new Date(), commit: w.target, by: "@dev/2" })),
      migrated(changeInput("merged", { queueTip, at: new Date(), commit: w.target })),
    ],
    { expect: null },
  )

  const outcome = await queueRun({ ...(await w.options({ exit: 0 })), checks: [] })

  expect(outcome.exitCode).toBe(0)
  expect(existsSync(w.notifyLog)).toBe(false)
  expect((await chain.events()).map((event) => event.type)).toEqual(["opened", "merged"])
})

/** @failure A queue-owned stuck event could not retain a notice although the notifier received it.
 * @level l3 @consumer queue operator and notified recipient
 */
it("records a final notice for a stuck event while leaving the line stopped", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/stuck-notice", "one.txt")

  const outcome = await queueRun(await w.options({ exit: 2 }))

  expect(outcome).toMatchObject({ exitCode: 2, stuck: ["task/stuck-notice"] })
  expect(readFileSync(w.notifyLog, "utf8")).toContain('"record":"stuck"')
  expect(messages(w)[0]?.endingId).toEqual(expect.any(String))
  const change = await readStatus(store, "main", "task/stuck-notice")
  expect(change.status).toBe("stuck")
  expect(Object.values(change.notices ?? {})).toContainEqual(
    expect.objectContaining({ to: "recorder", result: "delivered" }),
  )
})

/** @failure A refused or exhausted notifier was retried forever because no final receipt settled its key.
 * @level l3 @consumer queue operator and notified recipient
 */
it("settles refused and finally failed event recipients once", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/notice-final", "one.txt")
  const base = await w.options({ exit: 0 })
  const notify = [
    { name: "refuser", on: ["merged" as const], run: "printf 'recipient refused\\n'; exit 4" },
    { name: "unreachable", on: ["merged" as const], run: "echo 'temporary outage' >&2; exit 1" },
  ]

  const first = await queueRun({ ...base, checks: [], notify })

  expect(first).toMatchObject({ exitCode: 0, merged: ["task/notice-final"] })
  const receipts = Object.values((await readStatus(store, "main", "task/notice-final")).notices ?? {})
  expect(receipts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ to: "refuser", result: "refused", reason: "recipient refused" }),
      expect.objectContaining({
        to: "unreachable",
        result: "failed",
        reason: expect.stringContaining("temporary outage"),
      }),
    ]),
  )
  expect(logRecords(first).filter((row) => row.kind === "message" && row.to === "unreachable")).toHaveLength(2)
  const second = await queueRun({ ...base, targetSha: await remoteTarget(w), checks: [], notify })
  expect(logRecords(second).filter((row) => row.kind === "message")).toHaveLength(0)
})

/** @failure An untold ending stayed silent after a crash, or its retry replaced immutable Time with the retry clock.
 * @level l3 @consumer notified recipient
 */
it("repairs an ending whose event notice was not yet recorded", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/notice-repair", "one.txt")
  const opened = await readStatus(store, "main", "task/notice-repair")
  if (opened.tip === undefined) throw new Error("submitted event has no tip")
  const ending = await appendChangeEvent(store, "main", "task/notice-repair", opened.tip, {
    type: "failed",
    at: new Date(Date.now() - 60_000),
    reason: "check failed before notice",
  })
  const events = await (await openEvents({ ...store, ref: changesRef("main", "task/notice-repair") })).events()
  const endingTime = events.find((event) => event.id === ending)?.props.find(([key]) => key === "Time")?.[1]
  if (endingTime === undefined) throw new Error(`ending ${ending} has no Time`)
  const options = { ...(await w.options({ exit: 0 })), checks: [] }
  const firstAttempt = join(dirname(w.notifyLog), "first-notice-failed")

  const outcome = await queueRun({
    ...options,
    notify: [
      {
        name: "recorder",
        on: ["failed" as const],
        run: `${w.notifier}; if [ ! -e "${firstAttempt}" ]; then : > "${firstAttempt}"; exit 1; fi`,
      },
    ],
  })

  expect(outcome.merged).toEqual([])
  expect(readFileSync(w.notifyLog, "utf8")).toContain('"record":"failed"')
  expect(messages(w)).toHaveLength(2)
  expect(messages(w)[0]).toMatchObject({ endingId: ending, endedAt: endingTime })
  expect(messages(w)[1]).toMatchObject({ endingId: ending, endedAt: endingTime })
  const change = await readStatus(store, "main", "task/notice-repair")
  expect(change.notices?.[`${ending}:recorder`]).toMatchObject({ for: ending, result: "delivered" })
  await queueRun(options)
  expect(messages(w)).toHaveLength(2)
})

/** @failure An event queue could accept teardown while no executor exists for it.
 * @level l2 @consumer queue operator and declaration author
 */
it("refuses event teardown until an executor exists", async () => {
  const w = await world()
  await createWorldEventQueue(w)
  await expect(queueRun({ ...(await w.options({ exit: 0 })), notify: [], teardown: "true" })).rejects.toThrow(
    /cannot run an event queue with teardown: this declaration feature has no event runner executor; remove teardown from \.yrd\.yml to run on an event queue/u,
  )
})

/** @failure A deferred change stayed in the queue but its submitter and supervisor never heard why (25741 P3).
 * @level l3 @consumer queue submitter and supervisor
 */
it("retains a deferred check, notifies both recipients once, and leaves it for the long tier", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/deferred-event", "one.txt")
  const base = await w.options({ exit: 0 })
  const deferred = {
    ...base,
    notify: [
      { name: "submitter", on: ["deferred" as const], run: w.notifier },
      { name: "supervisor", on: ["deferred" as const], run: w.notifier },
    ],
    checks: [
      {
        ...base.checks[0]!,
        run: `echo 'YRD-CHECK-RESULT {"result":"deferred","reason":"projection exceeded","projectedMs":3600000,"boundMs":1800000}' && exit 3`,
      },
    ],
  }

  const outcome = await queueRun(deferred)
  expect(outcome).toMatchObject({ exitCode: 0, deferred: ["task/deferred-event"], merged: [] })
  expect(messages(w)).toMatchObject([
    { record: "deferred", submitter: "@dev/2", projectedMs: 3_600_000, boundMs: 1_800_000 },
    { record: "deferred", submitter: "@dev/2", projectedMs: 3_600_000, boundMs: 1_800_000 },
  ])
  expect(Object.values((await readStatus(store, "main", "task/deferred-event")).notices ?? {})).toMatchObject([
    { to: "submitter", result: "delivered" },
    { to: "supervisor", result: "delivered" },
  ])
  expect(await readStatus(store, "main", "task/deferred-event")).toMatchObject({
    status: "queued",
    deferred: { check: "verify", phase: "merge", projectedMs: 3_600_000, boundMs: 1_800_000 },
  })
  const events = await (await openEvents({ ...store, ref: changesRef("main", "task/deferred-event") })).events()
  const decision = events.find((event) => event.type === "deferred")
  expect(decision?.props).toEqual(
    expect.arrayContaining([
      ["Base", w.target],
      ["Config", "test-config"],
      ["Check", expect.stringMatching(/^verify exit=3 ms=\d+ result=deferred attempt=1 phase=merge log=/u)],
    ]),
  )
  const tip = (await readStatus(store, "main", "task/deferred-event")).tip
  const normal = await queueRun(deferred)
  expect(normal).toMatchObject({ exitCode: 0, merged: [], failed: [], stuck: [] })
  expect((await readStatus(store, "main", "task/deferred-event")).tip).toBe(tip)
  expect(messages(w)).toHaveLength(2)
})

/** @failure A deferred change could be ignored by the long tier or lose the declared check phase.
 * @level l3 @consumer queue operator and Gate E
 */
it("resumes a deferred event in the long tier with its declared phase retained", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/long-event", "one.txt")
  const base = await w.options({ exit: 0 })
  const checks = [
    {
      ...base.checks[0]!,
      long: { timeoutMs: 60_000 },
      run: 'if [ "$YRD_CHECK_TIER" = long ]; then exit 0; fi; echo \'YRD-CHECK-RESULT {"result":"deferred","reason":"outside normal window","projectedMs":60000,"boundMs":1000}\'; exit 3',
    },
  ]
  const first = await queueRun({ ...base, notify: [], checks })
  expect(first).toMatchObject({ exitCode: 0, deferred: ["task/long-event"] })

  const resumed = await queueRun({ ...base, notify: [], checks, tier: "long" })

  expect(resumed).toMatchObject({ exitCode: 0, merged: ["task/long-event"] })
  expect((await readStatus(store, "main", "task/long-event")).deferred).toBeUndefined()
  const events = await (await openEvents({ ...store, ref: changesRef("main", "task/long-event") })).events()
  expect(events.find((event) => event.type === "merging")?.props).toContainEqual([
    "Check",
    expect.stringMatching(/result=pass attempt=1 phase=merge tier=long/u),
  ])
})

/** @failure A stop window that closed after selection still started a new event check.
 * @level l3 @consumer queue service and submitter
 */
it("records a queued deferral when the stop window closes before a check", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/window-event", "one.txt")
  const base = await w.options({ exit: 0 })
  let tick = 0

  const outcome = await queueRun({ ...base, notify: [], stopAtMs: 1, now: () => (tick++ === 0 ? 0 : 2) })

  expect(outcome).toMatchObject({ exitCode: 0, deferred: ["task/window-event"], merged: [] })
  expect((await readStatus(store, "main", "task/window-event")).deferred).toMatchObject({
    check: "verify",
    phase: "merge",
    reason: expect.stringContaining("stop-time"),
    boundMs: 0,
  })
  expect(existsSync(w.startedLog)).toBe(false)
})

/** @failure A temporary remote error stopped an event line without its one in-round retry.
 * @level l3 @consumer queue operator
 */
it("retries one remote-class event check failure before merging", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/retry-event", "one.txt")
  const marker = join(w.workdir, "remote-attempted")
  const base = await w.options({ exit: 0 })
  const run = `if [ ! -f '${marker}' ]; then : > '${marker}'; echo 'fatal: unable to access https://example.test/: The requested URL returned error: 502' >&2; exit 3; fi; exit 0`

  const outcome = await queueRun({ ...base, notify: [], checks: [{ ...base.checks[0]!, run }] })

  expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/retry-event"] })
  expect(logRecords(outcome)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "warning", reason: "retried", branch: "task/retry-event" }),
    ]),
  )
  const events = await (await openEvents({ ...store, ref: changesRef("main", "task/retry-event") })).events()
  expect(events.find((event) => event.type === "merging")?.props).toContainEqual([
    "Check",
    expect.stringMatching(/result=pass attempt=2 phase=merge/u),
  ])
})

/** @failure A second remote failure erased the first attempt and gave no durable retry evidence.
 * @level l3 @consumer queue operator and Gate E
 */
it("stops after two remote-class event check failures with both attempts retained", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/retry-stuck-event", "one.txt")
  const base = await w.options({ exit: 0 })
  const run = "echo 'fatal: unable to access https://example.test/: The requested URL returned error: 502' >&2; exit 3"

  const outcome = await queueRun({ ...base, notify: [], checks: [{ ...base.checks[0]!, run }] })

  expect(outcome).toMatchObject({ exitCode: 2, stuck: ["task/retry-stuck-event"] })
  const events = await (await openEvents({ ...store, ref: changesRef("main", "task/retry-stuck-event") })).events()
  const stuck = events.find((event) => event.type === "stuck")
  expect(stuck?.props).toContainEqual(["Retried", "1"])
  expect(stuck?.props.filter(([key]) => key === "Check")).toEqual([
    ["Check", expect.stringMatching(/result=stuck attempt=1 phase=merge/u)],
    ["Check", expect.stringMatching(/result=stuck attempt=2 phase=merge/u)],
  ])
})

/** @failure A local render failure after a successful own event append was misreported as a rival discard.
 * @level l3 @consumer queue operator
 */
it("keeps a local post-append error loud after an event ending lands", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/own-append", "one.txt")
  const options = await w.options({ exit: 1 })

  await expect(
    queueRun({
      ...options,
      notify: [],
      render: (record) => {
        if (record.kind === "change" && record.decision === "failed") throw new Error("local post-append witness")
      },
    }),
  ).rejects.toThrow(/local post-append witness/u)
  expect((await readStatus(store, "main", "task/own-append")).status).toBe("failed")
})

/** @failure A local failure after the merged event and its notice was mistaken for a rival tip move.
 * @level l3 @consumer queue operator and notified recipient
 */
it("keeps a local post-notice error loud after the receipt lands", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/own-notice", "one.txt")
  const options = await w.options({ exit: 0 })

  await expect(
    queueRun({
      ...options,
      checks: [],
      render: (record) => {
        if (record.kind === "merge") throw new Error("local post-notice witness")
      },
    }),
  ).rejects.toThrow(/local post-notice witness/u)
  const change = await readStatus(store, "main", "task/own-notice")
  expect(change.status).toBe("merged")
  expect(Object.values(change.notices ?? {})).toContainEqual(expect.objectContaining({ result: "delivered" }))
})

/** @failure A failed configured event check could stop the event line or lose its failed ending.
 * @level l3 @consumer queue operator and submitter
 */
it("ends a failed configured event check and continues with the next change", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/a", "one.txt")
  await submitCommit(w, "task/b", "two.txt")

  const outcome = await queueRun({ ...(await w.options({ exit: 1 })), notify: [] })

  expect(outcome).toMatchObject({ exitCode: 1, failed: ["task/a"], merged: ["task/b"], stuck: [] })
  expect(await remoteTarget(w)).not.toBe(w.target)
  expect((await readStatus(store, "main", "task/a")).status).toBe("failed")
  expect((await readStatus(store, "main", "task/b")).status).toBe("merged")
})

/** @failure 25708/25736: a confirmed change-ref CAS refusal killed the service's round, or a
 * staged merge retried blindly instead of leaving its judgement for the next round.
 */
it("records a typed merge-publication refusal and judges the next event change", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/cas-first", "one.txt")
  await submitCommit(w, "task/cas-next", "two.txt")
  const branches = ["task/cas-first", "task/cas-next"] as const
  let refusedBranch: (typeof branches)[number] | undefined
  let refusedRef: string | undefined
  let refusedPublishes = 0
  using _publish = beforeGitomicPublish(async (_repo, updates) => {
    if (!updates.some((update) => update.ref === "refs/heads/main")) return
    const branch = branches.find((name) => updates.some((update) => update.ref === changesRef("main", name)))
    if (branch === undefined) return
    if (branch === refusedBranch) refusedPublishes++
    if (refusedRef !== undefined) return
    const ref = changesRef("main", branch)
    const marker = updates.find((update) => update.ref === ref)?.expect
    if (marker === undefined) return
    refusedBranch = branch
    refusedRef = ref
    refusedPublishes++
    // A rival moved the target beside the change ref: after @cto a8b9146d a
    // chain-only refusal is retried inside transact, and a lost `also` lease
    // is what reaches the cas-refused path on the first attempt.
    throw new gitomic.Conflict(`lease lost, nothing published: ${ref} expected ${marker}, observed locked`, {
      refs: [ref, "refs/heads/main"],
    })
  })
  const outcome = await queueRun({ ...(await w.options({ exit: 0 })), checks: [], notify: [] })
  if (refusedBranch === undefined || refusedRef === undefined) throw new Error("fixture did not reach publication")
  expect(refusedPublishes).toBe(1)
  const next = branches.find((name) => name !== refusedBranch)
  if (next === undefined) throw new Error("fixture has no next change")
  expect(outcome).toMatchObject({ exitCode: 0, merged: [next] })
  expect((await readStatus(store, "main", refusedBranch)).status).toBe("merging")
  expect((await readStatus(store, "main", next)).status).toBe("merged")
  expect(logRecords(outcome)).toContainEqual(
    expect.objectContaining({
      kind: "warning",
      subject: "cas-refused",
      branch: refusedBranch,
      ref: refusedRef,
      count: 1,
    }),
  )
})

/** @failure 25708: a transport error before the atomic push killed the whole service instead of one row.
 * @level l3 @consumer queue operator and next submitter
 */
it("keeps an unlanded merge publication retryable and judges the next change", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/transport-first", "one.txt")
  await submitCommit(w, "task/transport-next", "two.txt")
  const branches = ["task/transport-first", "task/transport-next"] as const
  let refusedBranch: (typeof branches)[number] | undefined
  using _publish = beforeGitomicPublish(async (_repo, updates) => {
    if (refusedBranch !== undefined || !updates.some((update) => update.ref === "refs/heads/main")) return
    refusedBranch = branches.find((name) => updates.some((update) => update.ref === changesRef("main", name)))
    if (refusedBranch !== undefined) throw new Error("injected transport failure before atomic push")
  })

  const outcome = await queueRun({ ...(await w.options({ exit: 0 })), checks: [], notify: [] })
  if (refusedBranch === undefined) throw new Error("fixture did not reach merge publication")
  const next = branches.find((name) => name !== refusedBranch)
  if (next === undefined) throw new Error("fixture has no next change")
  expect(outcome).toMatchObject({ exitCode: 0, merged: [next] })
  expect((await readStatus(store, "main", refusedBranch)).status).toBe("merging")
  expect((await readStatus(store, "main", next)).status).toBe("merged")
  expect(logRecords(outcome)).toContainEqual(
    expect.objectContaining({
      kind: "warning",
      subject: "publication-not-landed",
      branch: refusedBranch,
      ref: changesRef("main", refusedBranch),
      count: 1,
    }),
  )
})

/** @failure 25789: an empty-ref Conflict after merge publication skipped readback and stopped the whole round.
 * @level l3 @consumer queue operator and next submitter
 */
it("reconciles a merge Conflict with no named refs and judges the next change", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/unknown-conflict", "one.txt")
  await submitCommit(w, "task/after-unknown-conflict", "two.txt")
  const firstRef = changesRef("main", "task/unknown-conflict")
  let refused = false
  using _publish = beforeGitomicPublish(async (_repo, updates) => {
    if (refused || !updates.some((update) => update.ref === firstRef)) return
    if (!updates.some((update) => update.ref === "refs/heads/main")) return
    refused = true
    throw new gitomic.Conflict("injected publication outcome unknown with no named refs")
  })

  const outcome = await queueRun({ ...(await w.options({ exit: 0 })), checks: [], notify: [] })
  expect(refused).toBe(true)
  expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/after-unknown-conflict"] })
  expect((await readStatus(store, "main", "task/unknown-conflict")).status).toBe("merging")
  expect(logRecords(outcome)).toContainEqual(
    expect.objectContaining({
      kind: "warning",
      subject: "publication-not-landed",
      branch: "task/unknown-conflict",
      ref: firstRef,
      count: 1,
    }),
  )
})

/** @failure 25708: losing the push acknowledgement after acceptance could replay a merge or stop the service.
 * @level l3 @consumer queue operator and submitter
 */
it("recognizes the exact staged merge event after an accepted push loses its acknowledgement", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/transport-landed", "one.txt")
  const ref = changesRef("main", "task/transport-landed")
  let injected = false
  using _publish = beforeGitomicPublish(
    async () => {},
    undefined,
    async (_repo, updates) => {
      if (
        injected ||
        !updates.some((update) => update.ref === ref) ||
        !updates.some((update) => update.ref === "refs/heads/main")
      ) {
        return
      }
      injected = true
      throw new Error("injected lost acknowledgement after atomic push")
    },
  )

  const outcome = await queueRun({ ...(await w.options({ exit: 0 })), checks: [], notify: [] })
  expect(injected).toBe(true)
  expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/transport-landed"] })
  expect((await readStatus(store, "main", "task/transport-landed")).status).toBe("merged")
  expect(logRecords(outcome)).toContainEqual(
    expect.objectContaining({
      kind: "change",
      branch: "task/transport-landed",
      decision: "merged",
      reason: "landed after unknown publication response",
    }),
  )
})

/** @failure 25708: repeated definite non-publication must page a stuck change with the transport cause.
 * @level l3 @consumer queue operator
 */
it("stops one change after three consecutive not-landed publication rounds", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  const branch = "task/transport-repeat"
  await submitCommit(w, branch, "one.txt")
  const ref = changesRef("main", branch)
  let refused = 0
  using _publish = beforeGitomicPublish(async (_repo, updates) => {
    if (!updates.some((update) => update.ref === ref) || !updates.some((update) => update.ref === "refs/heads/main")) {
      return
    }
    refused++
    throw new Error("injected transport outage before atomic push")
  })
  const options = { ...(await w.options({ exit: 0 })), checks: [], notify: [] }
  for (const count of [1, 2, 3]) {
    const outcome = await queueRun(options)
    expect(logRecords(outcome)).toContainEqual(
      expect.objectContaining({ kind: "warning", subject: "publication-not-landed", branch, ref, count }),
    )
    expect(outcome.exitCode).toBe(count === 3 ? 2 : 0)
    expect(outcome.stuck).toEqual(count === 3 ? [branch] : [])
    expect((await readStatus(store, "main", branch)).status).toBe(count === 3 ? "stuck" : "merging")
  }
  expect(refused).toBe(3)
})

/** @failure 25708: a vanished change ref must not make the runner abandon unrelated rows.
 * @level l3 @consumer queue operator and next submitter
 */
it("names a missing change chain after publication and judges the next row", async () => {
  const w = await world()
  await createWorldEventQueue(w)
  await submitCommit(w, "task/missing-first", "one.txt")
  await submitCommit(w, "task/missing-next", "two.txt")
  const ref = changesRef("main", "task/missing-first")
  let failed = false
  let omitted = false
  using _publish = beforeGitomicPublish(
    async (_repo, updates) => {
      if (
        failed ||
        !updates.some((update) => update.ref === ref) ||
        !updates.some((update) => update.ref === "refs/heads/main")
      ) {
        return
      }
      failed = true
      throw new Error("injected transport failure before atomic push")
    },
    undefined,
    undefined,
    async (_repo, prefix) => {
      if (!failed || omitted || prefix !== ref) return undefined
      omitted = true
      return new Map()
    },
  )
  const outcome = await queueRun({ ...(await w.options({ exit: 0 })), checks: [], notify: [] })
  expect(omitted).toBe(true)
  expect(outcome.merged).toContain("task/missing-next")
  expect(logRecords(outcome)).toContainEqual(
    expect.objectContaining({ kind: "warning", subject: "inconsistent-missing-chain", ref }),
  )
})

/** @failure 25708: a failed remote witness must name the ref instead of pretending the push did not land.
 * @level l3 @consumer queue operator
 */
it("fails a round with the unreadable remote ref named after publication", async () => {
  const w = await world()
  await createWorldEventQueue(w)
  await submitCommit(w, "task/read-failed", "one.txt")
  const ref = changesRef("main", "task/read-failed")
  let failed = false
  using _publish = beforeGitomicPublish(
    async (_repo, updates) => {
      if (
        failed ||
        !updates.some((update) => update.ref === ref) ||
        !updates.some((update) => update.ref === "refs/heads/main")
      ) {
        return
      }
      failed = true
      throw new Error("injected transport failure before atomic push")
    },
    undefined,
    undefined,
    async (_repo, prefix) => {
      if (failed && prefix === ref) throw new Error("injected remote reread outage")
      return undefined
    },
  )
  await expect(queueRun({ ...(await w.options({ exit: 0 })), checks: [], notify: [] })).rejects.toThrow(
    /refs\/yrd\/main\/changes\/task\/read-failed could not be read: injected remote reread outage/u,
  )
})

/** @failure 25708: the service lost its repeated-refusal count across rounds and could not clear the page. */
it("counts repeated CAS refusals in round journals and resets after publication", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  const branch = "task/cas-repeat"
  await submitCommit(w, branch, "one.txt")
  const ref = changesRef("main", branch)
  let refused = 0
  using _publish = beforeGitomicPublish(async (_repo, updates) => {
    if (refused >= 3 || !updates.some((update) => update.ref === "refs/heads/main")) return
    const marker = updates.find((update) => update.ref === ref)?.expect
    if (marker === undefined) return
    refused++
    // A rival moved the target beside the change ref: after @cto a8b9146d a
    // chain-only refusal is retried inside transact, and a lost `also` lease
    // is what reaches the cas-refused path on the first attempt.
    throw new gitomic.Conflict(`lease lost, nothing published: ${ref} expected ${marker}, observed locked`, {
      refs: [ref, "refs/heads/main"],
    })
  })
  const options = { ...(await w.options({ exit: 0 })), checks: [], notify: [] }
  for (const count of [1, 2, 3]) {
    const outcome = await queueRun(options)
    expect(outcome).toMatchObject({ exitCode: 0, merged: [] })
    expect(logRecords(outcome)).toContainEqual(
      expect.objectContaining({ kind: "warning", subject: "cas-refused", ref, count }),
    )
    expect(outcome.line?.casRefused?.count).toBe(count === 3 ? 3 : undefined)
    expect((await readStatus(store, "main", branch)).status).toBe("merging")
  }
  const before = await readStatus(store, "main", branch)
  if (before.tip === undefined || before.since === undefined) throw new Error("fixture lost its open marker")
  const published = await queueRun(options)
  expect(published.merged).toEqual([branch])
  expect(published.line?.casRefused).toBeUndefined()
  expect(logRecords(published)).toContainEqual(expect.objectContaining({ kind: "merge", ref }))
  expect(recentCasRefusals(dirname(published.log), ref, before.tip, before.since)).toBe(0)
})

/** @failure A queue-owned configured event check failure could be billed as failed or let the next change pass.
 * @level l3 @consumer queue operator and submitter
 */
it("ends a queue-owned configured event check stuck and holds the next change", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/a", "one.txt")
  await submitCommit(w, "task/b", "two.txt")

  const outcome = await queueRun({ ...(await w.options({ exit: 2 })), notify: [] })

  expect(outcome).toMatchObject({ exitCode: 2, failed: [], merged: [], stuck: ["task/a"] })
  expect(await remoteTarget(w)).toBe(w.target)
  expect((await readStatus(store, "main", "task/a")).status).toBe("stuck")
  expect((await readStatus(store, "main", "task/b")).status).toBe("queued")
})

/** @failure A drop during a configured event check could leave a stale verdict to stop the line.
 * @level l3 @consumer queue operator and submitter
 */
it("discards a dropped event check once and continues with the next change", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/a", "one.txt")
  await submitCommit(w, "task/b", "two.txt")

  // The check holds until the drop has landed, then runs its 0.25s: the drop is always mid-check.
  const hold = `${w.startedLog}.release`
  const running = queueRun({ ...(await w.options({ exit: 0, sleep: 0.25, hold })), notify: [] })
  await checkRunning(w)
  await drop(store, { queue: "main", branch: "task/a", by: "operator" })
  writeFileSync(hold, "")

  const outcome = await running
  expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/b"], failed: [], stuck: [] })
  expect(readFileSync(w.startedLog, "utf8"), "the check waited on its hold").toContain("held")
  expect((await readStatus(store, "main", "task/a")).status).toBe("cancelled")
  expect(logRecords(outcome).filter((row) => row.kind === "discarded" && row.branch === "task/a")).toHaveLength(1)
})

/** @failure A new-head resubmit racing an event check could make the stale round throw and abandon the next change.
 * @level l3 @consumer queue operator and submitter
 */
it("discards a resubmitted event check once and continues with the next change", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  const first = await submitCommit(w, "task/a", "one.txt")
  await submitCommit(w, "task/b", "two.txt")

  // The check holds until the resubmit has landed, then runs its 0.25s: always mid-check.
  const hold = `${w.startedLog}.release`
  const running = queueRun({ ...(await w.options({ exit: 0, sleep: 0.25, hold })), notify: [] })
  await checkRunning(w)
  await w.git(["checkout", "--quiet", "task/a"])
  writeFileSync(join(w.work, "resubmitted.txt"), "new head\n")
  await w.git(["add", "resubmitted.txt"])
  await w.git(["commit", "--quiet", "-m", "resubmit task/a"])
  const next = (await w.git(["rev-parse", "HEAD"])).trim()
  expect(next).not.toBe(first)
  const resubmitted = await submit(w.git, "origin", {
    branch: "task/a",
    target: { remote: "origin", branch: "main" },
    submitter: "@dev/2",
  })
  expect(resubmitted).toMatchObject({ head: next, retry: false })
  writeFileSync(hold, "")

  const outcome = await running
  expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/b"], failed: [], stuck: [] })
  expect(readFileSync(w.startedLog, "utf8"), "the check waited on its hold").toContain("held")
  expect(await readStatus(store, "main", "task/a")).toMatchObject({ status: "queued", commit: next })
  expect((await readStatus(store, "main", "task/b")).status).toBe("merged")
  expect(logRecords(outcome).filter((row) => row.kind === "discarded" && row.branch === "task/a")).toHaveLength(1)
})

/** @failure A pause published during composition killed the service on a normal queue-tip lease race.
 * @level l3 @consumer queue operator
 */
it("re-reads a pause that wins the event merge lease and keeps the service round healthy", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/paused-event", "one.txt")
  const verify = verifying.verifyCandidate
  let entered!: () => void
  const composing = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release!: () => void
  const continueRun = new Promise<void>((resolve) => {
    release = resolve
  })
  using _held = vi.spyOn(verifying, "verifyCandidate").mockImplementation(async (options) => {
    const outcome = await verify(options)
    entered()
    await continueRun
    return outcome
  })

  const running = queueRun({ ...(await w.options({ exit: 0 })), checks: [], notify: [] })
  await composing
  await writeQueueEvent(store, "main", { type: "paused", by: "operator", reason: "hold", at: new Date() })
  release()

  const outcome = await running
  expect(outcome).toMatchObject({ exitCode: 0, merged: [], stopped: { ring: "pause" } })
  expect(logRecords(outcome)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "warning",
        subject: "queue-lease-lost",
        expected: expect.any(String),
        actual: expect.any(String),
      }),
    ]),
  )
  expect(await remoteTarget(w)).toBe(w.target)
  expect((await readStatus(store, "main", "task/paused-event")).status).not.toBe("merged")
})

/** @failure A resume or override event on the queue ref was treated as a fatal merge lease loss.
 * @level l3 @consumer queue operator and service
 */
it.each(["resume", "override"] as const)(
  "defers a merge after a concurrent %s and retries with fresh ops",
  async (kind) => {
    const w = await world()
    const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
    await createWorldEventQueue(w)
    await submitCommit(w, `task/${kind}-event`, "one.txt")
    const verify = verifying.verifyCandidate
    let entered!: () => void
    const composing = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const continueRun = new Promise<void>((resolve) => {
      release = resolve
    })
    using _held = vi.spyOn(verifying, "verifyCandidate").mockImplementation(async (options) => {
      const outcome = await verify(options)
      entered()
      await continueRun
      return outcome
    })

    const running = queueRun({ ...(await w.options({ exit: 0 })), checks: [], notify: [] })
    await composing
    if (kind === "resume") {
      await writeQueueEvent(store, "main", { type: "paused", by: "operator", reason: "brief hold", at: new Date() })
      await writeQueueEvent(store, "main", { type: "resumed", by: "operator", reason: "release", at: new Date() })
    } else {
      await writeQueueOverride(
        store,
        "main",
        {
          kind: "off",
          check: "lab-gate",
          until: new Date(Date.now() + 60_000),
          reason: "operator changed merge gate",
          actor: { by: "operator", verified: false },
        },
        ["lab-gate"],
        new Date(),
      )
    }
    release()

    const outcome = await running
    expect(outcome).toMatchObject({ exitCode: 0, merged: [], deferred: [`task/${kind}-event`] })
    expect(logRecords(outcome)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "warning",
          subject: "queue-lease-lost",
          expected: expect.any(String),
          actual: expect.any(String),
        }),
      ]),
    )
    expect(await remoteTarget(w)).toBe(w.target)
    expect((await readStatus(store, "main", `task/${kind}-event`)).status).not.toBe("merged")
    if (kind === "resume") {
      const retry = await queueRun({ ...(await w.options({ exit: 0 })), checks: [], notify: [] })
      expect(retry).toMatchObject({ exitCode: 0, merged: ["task/resume-event"] })
    }
  },
)

/** @failure A drop during composition threw from the stale event write and abandoned the next change.
 * @level l3 @consumer queue operator and submitter
 */
it("discards a dropped event judgement and continues the round", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/a", "one.txt")
  await submitCommit(w, "task/b", "two.txt")
  const verify = verifying.verifyCandidate
  let entered!: () => void
  const composing = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release!: () => void
  const continueRun = new Promise<void>((resolve) => {
    release = resolve
  })
  using _held = vi.spyOn(verifying, "verifyCandidate").mockImplementation(async (options) => {
    const outcome = await verify(options)
    if (options.head === (await readStatus(store, "main", "task/a")).commit) {
      entered()
      await continueRun
    }
    return outcome
  })

  const running = queueRun({ ...(await w.options({ exit: 0 })), checks: [], notify: [] })
  await composing
  await drop(store, { queue: "main", branch: "task/a", by: "operator" })
  release()

  const outcome = await running
  expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/b"] })
  expect((await readStatus(store, "main", "task/a")).status).toBe("cancelled")
  expect(logRecords(outcome).some((row) => row.kind === "discarded" && row.branch === "task/a")).toBe(true)
})

/** @failure A local-only component could be treated as a publishable hosted child.
 * @level l3 @consumer queue operator and repository readers
 */
it("fails a local-only component event without moving root main", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  const child = join(w.workdir, "child")
  await w.git(["init", "--quiet", "--initial-branch=main", child])
  const childGit = gitIn(child)
  await childGit(["config", "user.email", "queue@yrd.test"])
  await childGit(["config", "user.name", "yrd"])
  writeFileSync(join(child, "child.txt"), "one\n")
  await childGit(["add", "child.txt"])
  await childGit(["commit", "--quiet", "-m", "child"])
  const childHead = (await childGit(["rev-parse", "HEAD"])).trim()
  await w.git(["config", "protocol.file.allow", "always"])
  for (const [key, value] of [
    ["path", "child"],
    ["url", child],
    ["branch", "main"],
  ] as const) {
    await w.git(["config", "-f", ".gitmodules", `submodule.child.${key}`, value])
  }
  await w.git(["add", ".gitmodules"])
  await w.git(["update-index", "--add", "--cacheinfo", `160000,${childHead},child`])
  await w.git(["commit", "--quiet", "-m", "declare child"])
  await w.git(["push", "--quiet", "origin", "main"])
  await w.git(["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--", "child"])
  const target = await remoteTarget(w)
  const queueTip = await createWorldEventQueue(w, target)
  await w.git(["checkout", "--quiet", "-b", "task/component", "main"])
  writeFileSync(join(w.work, "one.txt"), "one\n")
  await w.git(["add", "one.txt"])
  await w.git(["commit", "--quiet", "-m", "one"])
  const head = (await w.git(["rev-parse", "HEAD"])).trim()
  await w.git(["push", "--quiet", "origin", "task/component"])
  await w.git(["checkout", "--quiet", "main"])
  // A local-file component URL cannot pass submit's hosted-identity check;
  // record the same opened event to prove the runner still refuses its publication.
  const chain = await openEvents({ ...store, ref: changesRef("main", "task/component") })
  await chain.append([changeInput("opened", { queueTip, at: new Date(), commit: head, by: "@dev/2" })], {
    expect: null,
  })

  const outcome = await queueRun({ ...(await w.options({ exit: 0 })), checks: [], notify: [] })
  expect(outcome).toMatchObject({ exitCode: 1, failed: ["task/component"], merged: [] })
  expect(await remoteTarget(w)).toBe(target)
  expect((await readStatus(store, "main", "task/component")).status).toBe("failed")
})

/** @failure An event round reported no direct merges after the target moved around the queue.
 * @level l3 @consumer queue operator
 */
it("reports a direct merge after the declaration and still merges the queued change", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  const direct = await pushAroundQueue(w, "direct.txt")
  const secondDirect = await editDeclarationAroundQueue(w, "# edited around the queue\n{}\n")
  await submitCommit(w, "task/after-direct", "one.txt")

  const outcome = await queueRun({ ...(await w.options({ exit: 0 })), checks: [], notify: [] })

  expect(outcome).toMatchObject({ exitCode: 0, directMerges: [direct, secondDirect], merged: ["task/after-direct"] })
  expect(logRecords(outcome).filter((row) => row.kind === "merged-direct")).toMatchObject([
    { branch: "main", commit: direct },
    { branch: "main", commit: secondDirect },
  ])
  expect((await readStatus(store, "main", "task/after-direct")).status).toBe("merged")
  expect(await w.git(["rev-parse", `${await remoteTarget(w)}^1`])).toMatch(new RegExp(secondDirect))
  const later = await queueRun({ ...(await w.options({ exit: 0 })), checks: [], notify: [] })
  expect(later.directMerges).toEqual([])
})

/** @failure A direct-only target move was reported again after its durable observation.
 * @level l3 @consumer queue operator and notification consumer
 */
it("observes a direct-only commit once on the queue chain", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  const direct = await pushAroundQueue(w, "direct-only.txt")
  const options = { ...(await w.options({ exit: 0 })), checks: [], notify: [] }

  const first = await queueRun(options)
  const second = await queueRun(options)

  expect(first.directMerges).toEqual([direct])
  expect(second.directMerges).toEqual([])
  expect(logRecords(second).filter((row) => row.kind === "merged-direct")).toEqual([])
  const observed = (await readEventQueue(store, "main")).observed[direct]
  expect(observed?.id).toMatch(/^[0-9a-f]{40}$/)
  const chain = await (await openEvents({ ...store, ref: queueRef("main") })).events()
  expect(chain.find((event) => event.id === observed?.id)).toMatchObject({
    type: "observed",
    links: [direct],
    props: expect.arrayContaining([
      ["Commit", direct],
      ["Reason", "direct"],
    ]),
  })
})

/** @failure 25736: an exhausted queue-event CAS retry ended the supervised round as an unknown error,
 * and a second observation could report the round's original marker instead of the first observed event.
 * @level l2 @consumer Hab's yrd service
 */
it("bounds the queue observation retry and leaves it for the next round", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  const direct = await pushAroundQueue(w, "direct-retry.txt")
  const secondDirect = await pushAroundQueue(w, "second-direct-retry.txt")
  const ref = queueRef("main")
  let refusals = 0
  let allowedFirst = false
  using publication = beforeGitomicPublish(async (_repo, updates, remote) => {
    if (remote !== "origin" || !updates.some((update) => update.ref === ref)) return
    if (!allowedFirst) {
      allowedFirst = true
      return
    }
    refusals++
    // The second observation refuses without rival progress after the first landed.
    throw new gitomic.Conflict(`lease lost on ${ref}`, { refs: [ref] })
  })
  const options = { ...(await w.options({ exit: 0 })), checks: [], notify: [], retryBudgetMs: 1 }

  let exhausted: unknown
  try {
    await queueRun(options)
  } catch (error) {
    exhausted = error
  }
  const firstObserved = (await readEventQueue(store, "main")).observed[direct]?.id
  expect(firstObserved).toMatch(/^[0-9a-f]{40}$/u)
  expect(exhausted).toMatchObject({
    name: "QueueRunEventRetryExhausted",
    site: "observed",
    marker: firstObserved,
    budgetMs: 1,
    cause: { name: "RetriesExhausted", budgetMs: 1 },
  })
  expect(refusals).toBeGreaterThan(0)
  expect((await readEventQueue(store, "main")).observed[secondDirect]).toBeUndefined()
  const journal = readdirSync(join(w.workdir, "logs")).find((name) => name.endsWith(".jsonl"))
  if (journal === undefined) throw new Error("exhausted round left no journal")
  const rows = readFileSync(join(w.workdir, "logs", journal), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  expect(rows).toContainEqual(
    expect.objectContaining({
      kind: "warning",
      subject: "cas-refused",
      site: "observed",
      ref,
      marker: firstObserved,
      budgetMs: 1,
    }),
  )

  publication.mockRestore()
  const next = await queueRun({ ...options, retryBudgetMs: 5_000 })
  expect(next.directMerges).toEqual([secondDirect])
  expect((await readEventQueue(store, "main")).observed[secondDirect]?.id).toMatch(/^[0-9a-f]{40}$/u)
}, 60_000)

/** @failure A direct notice was kept only in the local journal and sent again after a restart.
 * @level l3 @consumer merge queue notification recipient
 */
it("settles a direct-merge notice on the queue chain across an empty journal", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  const direct = await pushAroundQueue(w, "direct-notice.txt")
  const options = {
    ...(await w.options({ exit: 0 })),
    checks: [],
    notify: [{ name: "recorder", on: ["merged-direct"], run: w.notifier }],
  } satisfies QueueRunOptions

  expect((await queueRun(options)).directMerges).toEqual([direct])
  const observed = (await readEventQueue(store, "main")).observed[direct]
  expect(observed).toBeDefined()
  expect((await readEventQueue(store, "main")).notices[`${observed?.id}:recorder`]).toMatchObject({
    for: observed?.id,
    to: "recorder",
    result: "delivered",
  })
  expect(messages(w)).toEqual([
    { change: direct, record: "merged-direct", endingId: observed?.id, endedAt: expect.any(String) },
  ])

  const restarted = await queueRun({ ...options, workdir: join(w.workdir, "fresh-journal") })
  expect(restarted.directMerges).toEqual([])
  expect(messages(w)).toEqual([
    { change: direct, record: "merged-direct", endingId: observed?.id, endedAt: expect.any(String) },
  ])
})

/** @failure An old observed event fell outside Gitomic's default 50-event read,
 * crashing every later queue round even though its notice was settled.
 * @level l2 @consumer Hab's yrd service
 */
it("reads a settled direct notice beyond the default event window", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  const direct = await pushAroundQueue(w, "direct-notice-depth.txt")
  const options = {
    ...(await w.options({ exit: 0 })),
    checks: [],
    notify: [{ name: "recorder", on: ["merged-direct"], run: w.notifier }],
  } satisfies QueueRunOptions

  expect((await queueRun(options)).directMerges).toEqual([direct])
  const observed = (await readEventQueue(store, "main")).observed[direct]
  if (observed === undefined) throw new Error("fixture did not record the direct merge")
  for (let index = 0; index < 25; index++) {
    await writeQueueEvent(store, "main", { type: "paused", by: "operator", reason: "depth", at: new Date() })
    await writeQueueEvent(store, "main", { type: "resumed", by: "operator", reason: "depth", at: new Date() })
  }
  expect(
    (await (await openEvents({ ...store, ref: queueRef("main") })).events()).some((event) => event.id === observed.id),
  ).toBe(false)

  const restarted = await queueRun({ ...options, workdir: join(w.workdir, "fresh-depth-journal") })
  expect(restarted.directMerges).toEqual([])
  expect(messages(w)).toEqual([
    { change: direct, record: "merged-direct", endingId: observed.id, endedAt: expect.any(String) },
  ])
}, 60_000)

/** @failure 25736: an exhausted direct-notice queue transaction escaped as an unknown round error.
 * @level l2 @consumer Hab's yrd service and direct-merge notification recipient
 */
it("bounds the direct-notice retry and settles it in the next round", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  const direct = await pushAroundQueue(w, "direct-notice-retry.txt")
  const base = { ...(await w.options({ exit: 0 })), checks: [] }
  expect((await queueRun({ ...base, notify: [] })).directMerges).toEqual([direct])
  const observed = (await readEventQueue(store, "main")).observed[direct]
  if (observed === undefined) throw new Error("fixture did not record the direct merge")
  const ref = queueRef("main")
  let refusals = 0
  using publication = beforeGitomicPublish(async (_repo, updates, remote) => {
    if (remote !== "origin" || !updates.some((update) => update.ref === ref)) return
    refusals++
    throw new gitomic.Conflict(`lease lost on ${ref}`, { refs: [ref] })
  })
  const options = {
    ...base,
    notify: [{ name: "recorder", on: ["merged-direct"], run: w.notifier }],
    retryBudgetMs: 1,
  } satisfies QueueRunOptions

  await expect(queueRun(options)).rejects.toMatchObject({
    name: "QueueRunEventRetryExhausted",
    site: "notified",
    budgetMs: 1,
    cause: { name: "RetriesExhausted", budgetMs: 1 },
  })
  expect(refusals).toBeGreaterThan(0)
  expect((await readEventQueue(store, "main")).notices[`${observed.id}:recorder`]).toBeUndefined()

  publication.mockRestore()
  const next = await queueRun({ ...options, retryBudgetMs: 5_000 })
  expect(next.directMerges).toEqual([])
  expect((await readEventQueue(store, "main")).notices[`${observed.id}:recorder`]).toMatchObject({
    for: observed.id,
    to: "recorder",
    result: "delivered",
  })
}, 60_000)

it("retains a failed direct-merge delivery with a reason and does not retry it next round", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  const direct = await pushAroundQueue(w, "direct-failed-notice.txt")
  const options = {
    ...(await w.options({ exit: 0 })),
    checks: [],
    notify: [{ name: "rejecting", on: ["merged-direct"], run: "exit 7" }],
  } satisfies QueueRunOptions

  expect((await queueRun(options)).directMerges).toEqual([direct])
  const state = await readEventQueue(store, "main")
  const observed = state.observed[direct]
  expect(state.notices[`${observed?.id}:rejecting`]).toMatchObject({
    for: observed?.id,
    result: "failed",
    reason: expect.stringMatching(/exit|7/),
  })
  const retry = await queueRun({ ...options, workdir: join(w.workdir, "fresh-failure-journal") })
  expect(retry.directMerges).toEqual([])
  expect((await readEventQueue(store, "main")).notices[`${observed?.id}:rejecting`]).toEqual(
    state.notices[`${observed?.id}:rejecting`],
  )
})

/** @failure A later event round mistook the queue's own merge for a direct merge.
 * @level l3 @consumer queue operator
 */
it("accounts for its earlier merged event when scanning a later round", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/first", "one.txt")
  const first = await queueRun({ ...(await w.options({ exit: 0 })), checks: [], notify: [] })
  expect(first.merged).toEqual(["task/first"])

  await w.git(["checkout", "--quiet", "main"])
  await w.git(["pull", "--ff-only", "origin", "main"])
  const direct = await pushAroundQueue(w, "later-direct.txt")
  await submitCommit(w, "task/second", "two.txt")
  const second = await queueRun({ ...(await w.options({ exit: 0 })), checks: [], notify: [] })

  expect(second).toMatchObject({ exitCode: 0, directMerges: [direct], merged: ["task/second"] })
  expect(logRecords(second).filter((row) => row.kind === "merged-direct")).toMatchObject([{ commit: direct }])
  expect((await readStatus(store, "main", "task/second")).status).toBe("merged")
})

/** @failure A prior observed merged event did not account for the direct commit it kept.
 * @level l3 @consumer queue operator
 */
it("uses an existing observed merged event as the direct boundary", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  const head = await submitCommit(w, "task/observed-direct", "one.txt")
  await w.git(["checkout", "--quiet", "main"])
  await w.git(["merge", "--ff-only", "task/observed-direct"])
  await w.git(["push", "--quiet", "origin", "main"])
  const change = await readStatus(store, "main", "task/observed-direct")
  if (change.tip === undefined) throw new Error("submitted event has no tip")
  await expect(
    appendChangeEvent(store, "main", "task/observed-direct", change.tip, {
      type: "merged",
      at: new Date(),
      commit: head,
      writer: "yrd-run",
    }),
  ).rejects.toThrow(/writer.*reserved/)
  await expect(
    appendPublishedMerge(store, "main", "task/observed-direct", change.tip, {
      at: new Date(),
      commit: head,
      targetExpect: head,
      queueTip: (await readEventQueue(store, "main")).tip,
    }),
  ).rejects.toThrow(/target.*move/)
  await appendChangeEvent(store, "main", "task/observed-direct", change.tip, {
    type: "merged",
    at: new Date(),
    commit: head,
  })

  const outcome = await queueRun({ ...(await w.options({ exit: 0 })), checks: [], notify: [] })

  expect(outcome).toMatchObject({ exitCode: 0, directMerges: [], merged: [] })
  expect(logRecords(outcome).filter((row) => row.kind === "merged-direct")).toEqual([])
  expect(await remoteTarget(w)).toBe(head)
})

/** @failure A submitted head merged around the queue stayed open and its direct merge was reported forever.
 * @level l3 @consumer queue operator and submitter
 */
it("observes a submitted head on the target, then uses its merged event as the direct boundary", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  const head = await submitCommit(w, "task/observed-by-run", "observed.txt")
  await w.git(["checkout", "--quiet", "main"])
  await w.git(["merge", "--ff-only", "task/observed-by-run"])
  await w.git(["push", "--quiet", "origin", "main"])
  const options = { ...(await w.options({ exit: 0 })), checks: [], notify: [] }

  const observed = await queueRun(options)

  expect(observed).toMatchObject({ directMerges: [head], merged: ["task/observed-by-run"] })
  expect(await readStatus(store, "main", "task/observed-by-run")).toMatchObject({
    status: "merged",
    commit: head,
  })
  expect((await readEventQueue(store, "main")).observed[head]?.branch).toBe("task/observed-by-run")
  expect((await queueRun(options)).directMerges).toEqual([])
})

it("keeps the direct merge commit when an observed submitted head landed by no-ff merge", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/observed-no-ff", "observed-no-ff.txt")
  await w.git(["checkout", "--quiet", "main"])
  await w.git(["merge", "--quiet", "--no-ff", "-m", "merge submitted head around the queue", "task/observed-no-ff"])
  const merge = (await w.git(["rev-parse", "HEAD"])).trim()
  await w.git(["push", "--quiet", "origin", "main"])
  const options = { ...(await w.options({ exit: 0 })), checks: [], notify: [] }

  const observed = await queueRun(options)

  expect(observed).toMatchObject({ directMerges: [merge], merged: ["task/observed-no-ff"] })
  const state = await readStatus(store, "main", "task/observed-no-ff")
  const ending = (await (await openEvents({ ...store, ref: changesRef("main", "task/observed-no-ff") })).events()).find(
    (event) => event.id === state.ending?.id,
  )
  expect(ending).toMatchObject({ type: "merged", links: [merge] })
  expect((await readEventQueue(store, "main")).observed[merge]?.branch).toBe("task/observed-no-ff")
  expect((await queueRun(options)).directMerges).toEqual([])
})

/** @failure A merged notice used the last failed candidate rather than the later observed merge.
 * @level l3 @consumer submitter and queue operator
 */
it("names an observed merge after a failed candidate in its notice", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/observed-after-failure", "one.txt")
  const failed = await queueRun({ ...(await w.options({ exit: 1 })), notify: [] })
  expect(failed.failed).toEqual(["task/observed-after-failure"])
  const candidate = (await readStatus(store, "main", "task/observed-after-failure")).candidate
  expect(candidate).toMatch(/^[0-9a-f]{40}$/u)

  await w.git(["checkout", "--quiet", "main"])
  await w.git(["merge", "--quiet", "--no-ff", "-m", "merge after failed queue check", "task/observed-after-failure"])
  const merge = (await w.git(["rev-parse", "HEAD"])).trim()
  expect(merge).not.toBe(candidate)
  await w.git(["push", "--quiet", "origin", "main"])

  const observed = await queueRun({ ...(await w.options({ exit: 0 })), checks: [] })
  expect(observed.merged).toEqual(["task/observed-after-failure"])
  expect(messages(w).filter((message) => message.record === "merged")).toEqual([expect.objectContaining({ merge })])
  expect(logRecords(observed).find((record) => record.kind === "message" && record.says === "merged")?.text).toContain(
    `merged as ${merge.slice(0, 12)}`,
  )
})

/** One commit on the target, pushed around the queue: the thing only the queue may do. */
async function pushAroundQueue(w: World, file: string): Promise<string> {
  await w.git(["checkout", "--quiet", "main"])
  writeFileSync(join(w.work, file), `${file}\n`)
  await w.git(["add", file])
  await w.git(["commit", "--quiet", "-m", `${file} around the queue`])
  await w.git(["push", "--quiet", "origin", "main"])
  return (await w.git(["rev-parse", "HEAD"])).trim()
}

/** The declaration itself edited on the target and pushed around the queue: the commit that used to become the boundary and hide itself. */
async function editDeclarationAroundQueue(w: World, text: string): Promise<string> {
  await w.git(["checkout", "--quiet", "main"])
  writeFileSync(join(w.work, ".yrd.yml"), text)
  await w.git(["add", ".yrd.yml"])
  await w.git(["commit", "--quiet", "-m", "edit the declaration around the queue"])
  await w.git(["push", "--quiet", "origin", "main"])
  return (await w.git(["rev-parse", "HEAD"])).trim()
}

/**
 * Main gets a real `package.json` depending on a local `file:` package at
 * `from`'s version, plus a REAL `bun.lock` a real, offline `bun install`
 * wrote for it (both committed, so every worktree the queue makes inherits
 * them already consistent). The returned branch then raises that dependency
 * to `to`'s version in `package.json` ALONE, never touching the lockfile —
 * @i/10-yrd/24140's own repro for a `bun install --frozen-lockfile` that
 * refuses without naming what moved. No network: `file:` resolves locally.
 */
async function submitRaisedDependency(
  w: World,
  branch: string,
  name: string,
  from: string,
  to: string,
): Promise<Readonly<{ head: string }>> {
  const manifest = (version: string): string =>
    `${JSON.stringify({ dependencies: { [name]: `file:./vendor-${version}` }, name: "fixture-root", version: "0.0.0" }, null, 2)}\n`
  await w.git(["checkout", "--quiet", "main"])
  for (const version of [from, to]) {
    const vendor = join(w.work, `vendor-${version}`)
    mkdirSync(vendor, { recursive: true })
    writeFileSync(join(vendor, "package.json"), `${JSON.stringify({ name, version }, null, 2)}\n`)
  }
  writeFileSync(join(w.work, "package.json"), manifest(from))
  // The only moment a lockfile is GENERATED rather than diffed: a real `bun
  // install` against the BEFORE state, offline, in the fixture's own work
  // tree.
  const install = spawnSync("bun", ["install"], { cwd: w.work, encoding: "utf8" })
  if (install.status !== 0) {
    throw new Error(`fixture setup: bun install failed seeding the lockfile: ${install.stderr}\n${install.stdout}`)
  }
  await w.git(["add", "package.json", "bun.lock", `vendor-${from}`, `vendor-${to}`])
  await w.git(["commit", "--quiet", "-m", `depend on ${name}@${from}`])
  await w.git(["push", "--quiet", "origin", "main"])

  await w.git(["checkout", "--quiet", "-b", branch, "main"])
  writeFileSync(join(w.work, "package.json"), manifest(to))
  await w.git(["add", "package.json"])
  await w.git(["commit", "--quiet", "-m", `raise ${name} to ${to}`])
  const head = (await w.git(["rev-parse", "HEAD"])).trim()
  await w.git(["checkout", "--quiet", "main"])
  await submit(w.git, "origin", {
    branch,
    submitter: "@dev/2",
    target: { branch: "main", remote: "origin" },
    issue: "@i/10-yrd/24140",
  })
  return { head }
}

/** Every record of a run's log, in order. */
function logRecords(outcome: QueueRunOutcome): readonly Record<string, unknown>[] {
  return readFileSync(outcome.log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** The log path an ended `check` row named, for one branch, phase and check name. */
function checkLogFor(outcome: QueueRunOutcome, branch: string, phase: string, name: string): string {
  const row = logRecords(outcome).find(
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

/** A remote setup fault that clears after the settled-base check when requested. */
function faultySetup(
  w: World,
  line: string,
  plan: Readonly<{ once?: boolean }> = {},
): Readonly<{ command: string; clear: () => void }> {
  const marker = join(w.workdir, "..", `fault-${String(Math.random()).slice(2)}`)
  const script = `${marker}.sh`
  writeFileSync(marker, "the fault holds\n")
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `echo "setup cwd=$(pwd) repo=\${YRD_REPO:-none} candidate=\${YRD_CANDIDATE_SHA:-none} base=\${YRD_BASE_SHA:-none}" >> "${w.checkLog}"`,
      `if [ -f "${marker}" ]; then`,
      ...(plan.once === true ? [`  if [ "$YRD_CANDIDATE_SHA" = "$YRD_BASE_SHA" ]; then rm -f "${marker}"; fi`] : []),
      `  echo '${line}' >&2`,
      "  exit 128",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  )
  chmodSync(script, 0o755)
  return { command: script, clear: () => rmSync(marker, { force: true }) }
}

const UNREACHABLE_SETUP = "fatal: unable to access 'https://example.invalid/': The requested URL returned error: 504"

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
 * A notify entry whose transport answered and refused: exit 4, the reason on
 * its last stdout line and the daemon's words on stderr, as the root's
 * notifier says a deaf mailbox refused the send (24581).
 */
const REFUSING_NOTIFIER = `sh -c 'echo "tribe refused (24581)"; echo daemon refused the send >&2; exit 4'`

/** The one line a refused entry's reason is, as the refusing notifier above prints it. */
const REFUSAL = "tribe refused (24581)"

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

/**
 * A merge candidate composed exactly the way `composeCandidate` composes one
 * — in a throwaway worktree of `main`, a plain `git merge --no-ff` of `head`
 * onto the target's current tip — but never pushed anywhere: what a queue run
 * would have on disk the instant after git-super hands back a commit, before
 * that run has settled anything about it (@i/10-yrd/24344).
 */
async function composeMergeCandidate(w: World, head: string, message: string): Promise<string> {
  const path = join(w.workdir, "..", "compose-scratch")
  await w.git(["worktree", "add", "--quiet", "--detach", path, "main"])
  const wt = gitIn(path)
  await wt(["merge", "--quiet", "--no-ff", "-m", message, head])
  const commit = (await wt(["rev-parse", "HEAD"])).trim()
  await w.git(["worktree", "remove", "--force", path])
  return commit
}

/**
 * A dead run's leftover on-merge worktree at `<workdir>/worktrees/<run>/merge/<head-12>`,
 * checked out at `commit` — exactly what `composeCandidate`'s own `prepare`
 * leaves behind when the run that made it dies before removing it
 * (@i/10-yrd/24344, mirroring `worktreeOfRun` above for the "merge" phase).
 */
async function deadMergeWorktree(w: World, run: string, head: string, commit: string, pid: number): Promise<string> {
  const directory = join(w.workdir, "worktrees", run)
  const path = join(directory, "merge", head.slice(0, 12))
  mkdirSync(join(directory, "merge"), { recursive: true })
  await w.git(["worktree", "add", "--quiet", "--detach", path, commit])
  writeFileSync(join(path, "what-a-check-left.txt"), "output\n")
  writeFileSync(join(directory, ".pid"), `${String(pid)}\n`)
  return path
}

describe("a check log is written once", () => {
  it("a second write to a log path that already exists throws and names it, and the first log survives", async () => {
    // Every caller writes under a directory of its own — the queue run's keyed
    // by change, run and phase, `yrd check`'s by the instant it started — so a
    // path that already exists means two programs are writing one log, and the
    // second replacing the first's bytes in silence is the whole failure.
    const root = mkdtempSync(join(tmpdir(), "yrd-core-check-log-"))
    roots.push(root)
    const tree: CheckedTree = { base: "0".repeat(40), candidate: "1".repeat(40) }
    const where = { cwd: root, logDir: join(root, "checks"), tmpdir: join(root, "tmp"), tree }
    const path = checkLogPath(where.logDir, "verify")

    const first = await runCheck({ ...where, spec: { name: "verify", run: "echo hello" } })

    expect(first.result).toBe("pass")
    expect(readFileSync(path, "utf8")).toContain("hello")
    await expect(runCheck({ ...where, spec: { name: "verify", run: "echo again" } })).rejects.toThrow(path)
    expect(readFileSync(path, "utf8")).toContain("hello")

    // Two overlapping check processes compete for a previously absent path.
    // Either may finish first; exactly one publishes, the loser names the
    // collision, and the winner's bytes survive. No timing/order assumption.
    const contenders = ["failure", "pass"] as const
    const attempts = await Promise.allSettled(
      contenders.map((word) =>
        runCheck({
          ...where,
          spec: { name: "overlap", run: `echo ${word}; exit ${word === "failure" ? "1" : "0"}` },
        }),
      ),
    )
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1)
    const overlap = checkLogPath(where.logDir, "overlap")
    for (const [index, attempt] of attempts.entries()) {
      if (attempt.status === "rejected") {
        expect(String(attempt.reason)).toContain(`a check log already exists at ${overlap}`)
      } else {
        expect(attempt.value.log).toBe(overlap)
        expect(readFileSync(overlap, "utf8")).toBe(`${contenders[index]}\n`)
        expect(attempt.value.result).toBe(contenders[index] === "failure" ? "fail" : "pass")
      }
    }
  })
})

describe("event queue setup and journal", () => {
  it("writes no pass result records on an event queue under noCheck when a check has a real program (25936 P2)", async () => {
    const w = await world()
    const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
    await createWorldEventQueue(w)
    await submitCommit(w, "task/nocheck-event", "nocheck-event.txt")
    const opts = await w.options({ exit: 0 })
    const outcome = await queueRun({
      ...opts,
      checks: [{ name: "real-check", run: "exit 1" }],
      noCheck: true,
      notify: [],
    })
    expect(outcome.merged).toEqual(["task/nocheck-event"])
    expect((await readStatus(store, "main", "task/nocheck-event")).reason).toContain("real-check (no-check mode)")
    const results = logRecords(outcome).filter((r) => r.kind === "result" && r.name === "real-check")
    expect(results).toEqual([])
  })

  it("performs no setup and creates no check worktree on an event queue when all checks are declared run 'true', but performs both with a real check (25716 row 5 event runner)", async () => {
    const w = await world()
    await createWorldEventQueue(w)
    await submitCommit(w, "task/one", "one.txt")
    const setupLog = join(w.workdir, "setup-marker.log")
    const setupCmd = `echo "setup-ran" >> "${setupLog}"`

    // 1. Run with checks declared run "true" on event queue
    const optsTrue = await w.options({ setup: setupCmd })
    const outcomeTrue = await queueRun({
      ...optsTrue,
      checks: [{ name: "c1", run: "true" }],
      notify: [],
    })
    expect(outcomeTrue.merged).toEqual(["task/one"])
    expect(existsSync(setupLog)).toBe(false)

    // 2. Run with one real check on event queue
    await submitCommit(w, "task/two", "two.txt")
    const optsReal = await w.options({ exit: 0, setup: setupCmd })
    const outcomeReal = await queueRun({
      ...optsReal,
      checks: [
        { name: "c1", run: "true" },
        { name: "c2", run: ":" },
      ],
      notify: [],
    })
    expect(outcomeReal.merged).toEqual(["task/two"])
    expect(existsSync(setupLog)).toBe(true)
    expect(readFileSync(setupLog, "utf8")).toContain("setup-ran")
  })

  it("journals event queue runner stages as step records across judge and merge (25716)", async () => {
    const w = await world()
    await createWorldEventQueue(w)
    await submitCommit(w, "task/event-step", "file.txt")
    const opts = await w.options({ exit: 0 })
    const outcome = await queueRun({
      ...opts,
      checks: [{ name: "c1", run: ":" }],
      notify: [],
    })
    expect(outcome.merged).toEqual(["task/event-step"])
    const journal = readdirSync(join(w.workdir, "logs")).find((name) => name.endsWith(".jsonl"))
    if (journal === undefined) throw new Error("queue run left no journal")
    const rows = readFileSync(join(w.workdir, "logs", journal), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const steps = rows.filter((row) => row.kind === "step")
    const stepNames = steps.map((s) => s.name)
    expect(stepNames).toContain("compose")
    expect(stepNames).toContain("prepare")
    expect(stepNames).toContain("remove")
    expect(stepNames).toContain("publish")
    expect(stepNames).toContain("merge")
    expect(stepNames).toContain("notify")
    for (const step of steps) {
      expect(step.start).toBeDefined()
      if (step.end !== undefined) {
        expect(typeof step.ms).toBe("number")
      }
    }
  })
})
