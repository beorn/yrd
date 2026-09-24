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
import { isAbsolute, join, resolve } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { createProcess } from "@yrd/process"
import * as gitomic from "gitomic"
import { openEvents } from "gitomic/events"
import type { RefUpdate } from "gitomic"
import { gitEnvironment } from "../src/git.ts"
import { incidentTrailers } from "../src/incident.ts"
import { reminderDue } from "../src/override.ts"
import { CapturedQueueObjectsUnavailable } from "../src/remote.ts"
import {
  appendRecord,
  changeName,
  changeRef,
  checkLogPath,
  createEventQueue,
  createEventStore,
  changeInput,
  changesRef,
  drop,
  gitIn,
  holdsPlaceInLine,
  list,
  mergedByRun,
  pauseRef,
  queueRefPrefix,
  queueRun,
  readEventQueue,
  readConfig,
  readStatus,
  readRecords,
  refAt,
  readQueue,
  readPause,
  runCheck,
  runDiedInPreamble,
  selectionFor,
  submit,
  trailer,
  trailers,
  withdraw,
  writeQueueEvent,
  writePause,
  expireOverrides,
  OverrideRefused,
  overrideRef,
  parseUntil,
  readOverrides,
  writeOverride,
} from "../src/index.ts"
import type {
  ChangeRecord,
  CheckedTree,
  CheckSpec,
  Git,
  PauseRecord,
  QueueRunOptions,
  QueueRunOutcome,
} from "../src/index.ts"
import { resolveGitSelection } from "../src/git.ts"
import { ABSENT, legacyStore, recordCommit, type WriteRecord } from "../src/legacy-records.ts"
import * as verifying from "../src/verifying.ts"
import { appendChangeEvent, appendPublishedMerge } from "../src/events.ts"

const roots: string[] = []
// The real queue child needs GitSuper even when the worker's PATH is sealed.
const gitSuperBin = resolve(import.meta.dirname, "../../../../git-super/bin")
if (!existsSync(gitSuperBin)) {
  throw new Error(`git-super bin directory not found at ${gitSuperBin}`)
}
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
): ReturnType<typeof vi.spyOn> {
  const createBackend = gitomic.createShellBackend
  return vi.spyOn(gitomic, "createShellBackend").mockImplementation((options) => {
    const backend = createBackend(options)
    const publish = backend.publish
    const fetchRefs = backend.fetchRefs
    if (publish === undefined) throw new Error("Gitomic shell backend has no publish capability")
    if (fetchRefs === undefined) throw new Error("Gitomic shell backend has no fetchRefs capability")
    return {
      ...backend,
      fetchRefs: async (repo, refs, remote) => {
        await beforeFetchRefs?.(repo, refs, remote)
        return fetchRefs(repo, refs, remote)
      },
      publish: async (repo, updates, remote) => {
        await before(repo, updates, remote)
        return publish(repo, updates, remote)
      },
    }
  })
}

/** The record kind of a just-written commit, without requiring its carried objects to be fetched yet. */
async function recordKindOf(git: Git, oid: string): Promise<string | undefined> {
  const message = await git(["show", "-s", "--format=%B", oid])
  return /^Record: (.+)$/mu.exec(message)?.[1]
}

const INCIDENT_FIELDS = ["Code", "Subject", "Via", "Evidence", "Next"] as const

function incidentOf(record: ChangeRecord | undefined): Readonly<Record<(typeof INCIDENT_FIELDS)[number], string>> {
  if (record === undefined) throw new Error("no incident record")
  const incident = Object.fromEntries(INCIDENT_FIELDS.map((field) => [field, trailer(record, field)]))
  for (const field of INCIDENT_FIELDS) expect(incident[field], `${field}: must be present and non-empty`).toBeTruthy()
  expect(trailer(record, "Owner")).toBe("the queue operator")
  return incident as Record<(typeof INCIDENT_FIELDS)[number], string>
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
      `if [ -n "\${FAKE_HOLD:-}" ]; then echo "held" >> "${startedLog}"; fi`,
      'sleep "${FAKE_SLEEP:-0}"',
      `echo "check cwd=$(pwd) exit=\${FAKE_EXIT:-0} repo=\${YRD_REPO:-none} candidate=\${YRD_CANDIDATE_SHA:-none} base=\${YRD_BASE_SHA:-none}" >> "${checkLog}"`,
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
      `echo "setup cwd=$(pwd) repo=\${YRD_REPO:-none} candidate=\${YRD_CANDIDATE_SHA:-none} base=\${YRD_BASE_SHA:-none}" >> "${checkLog}"`,
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
it("submit and both queue phases call the same git-only verifier", async () => {
  const w = await world()
  using calls = vi.spyOn(verifying, "verifyCandidate")
  const head = await submitCommit(w, "task/shared-verifier", "one.txt")
  expect(calls).toHaveBeenCalledTimes(1)
  expect(calls.mock.calls[0]?.[0]).toMatchObject({ head, targetHead: w.target })

  const outcome = await queueRun(await w.options({ exit: 0 }))
  expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/shared-verifier"] })
  expect(calls).toHaveBeenCalledTimes(3)
  expect(calls.mock.calls.slice(1).map(([options]) => options.head)).toEqual([head, head])
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
  const state = await readStatus(createEventStore(w.work, "origin", gitIn(w.work).selection), "main", "task/event-run")
  expect(state).toMatchObject({ status: "merged", commit: head })
  expect(state.candidate).toBe(await remoteTarget(w))
  expect(state.candidate).not.toBe(head)
  expect(await w.git(["rev-parse", `${state.candidate}^1`])).toMatch(new RegExp(w.target))
  expect(await w.git(["ls-remote", "--refs", "origin", "refs/yrd/main/candidates/*"])).toBe("")
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

  const outcome = await queueRun({ ...(await w.options({ exit: 0 })), checks: [], notify: [] })

  expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/after-deleted"], stuck: [] })
  const state = await readStatus(store, "main", "task/deleted-event")
  expect(state).toMatchObject({ status: "cancelled", commit: deleted, reason: "deleted" })
  const ending = (await (await openEvents({ ...store, ref: changesRef("main", "task/deleted-event") })).events()).find(
    (event) => event.id === state.ending?.id,
  )
  expect(ending).toMatchObject({ type: "cancelled", links: [deleted] })
  expect(await w.git(["ls-remote", "--refs", "origin", "refs/heads/task/deleted-event"])).toBe("")
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
})

/** @failure An event queue could accept a declaration feature whose evidence it cannot preserve yet.
 * @level l2 @consumer queue operator and declaration author
 */
it.each([
  ["setup:", (w: World, base: QueueRunOptions) => ({ ...base, notify: [], setup: w.setupCommand(0) })],
  ["teardown:", (_w: World, base: QueueRunOptions) => ({ ...base, notify: [], teardown: "true" })],
  ["notify:", (_w: World, base: QueueRunOptions) => ({ ...base, checks: [] })],
  [
    "submit-phase",
    (_w: World, base: QueueRunOptions) => ({
      ...base,
      notify: [],
      checks: [{ ...base.checks[0]!, on: ["submit" as const] }],
    }),
  ],
  [
    "programRoot",
    (_w: World, base: QueueRunOptions) => ({
      ...base,
      notify: [],
      checks: [{ ...base.checks[0]!, programRoot: true as const }],
    }),
  ],
  [
    "scripts",
    (_w: World, base: QueueRunOptions) => ({
      ...base,
      notify: [],
      checks: [{ ...base.checks[0]!, scripts: ["checks/verify.sh"] }],
    }),
  ],
  [
    "deferred-capable",
    (_w: World, base: QueueRunOptions) => ({
      ...base,
      notify: [],
      checks: [{ ...base.checks[0]!, long: { timeoutMs: 60_000 } }],
    }),
  ],
  ["long check tier", (_w: World, base: QueueRunOptions) => ({ ...base, notify: [], tier: "long" as const })],
  [
    "deferred-capable stop window",
    (_w: World, base: QueueRunOptions) => ({ ...base, notify: [], stopAtMs: Date.now() + 60_000 }),
  ],
])("refuses event run feature %s until 25065", async (feature, configured) => {
  const w = await world()
  await createWorldEventQueue(w)
  const options = configured(w, await w.options({ exit: 0 }))

  await expect(queueRun(options)).rejects.toThrow(new RegExp(`${feature}.*#25040.*25065`))
})

it("refuses an undeclared deferred event result instead of leaving a successful outcome", async () => {
  const w = await world()
  const store = createEventStore(w.work, "origin", gitIn(w.work).selection)
  await createWorldEventQueue(w)
  await submitCommit(w, "task/deferred-event", "one.txt")
  const base = await w.options({ exit: 0 })
  const deferred = {
    ...base,
    notify: [],
    checks: [
      {
        ...base.checks[0]!,
        run: `echo 'YRD-CHECK-RESULT {"result":"deferred","reason":"projection exceeded","projectedMs":3600000,"boundMs":1800000}' && exit 3`,
      },
    ],
  }

  await expect(queueRun(deferred)).rejects.toThrow(/verify returned deferred .*#25040.*25065/u)
  expect(await readStatus(store, "main", "task/deferred-event")).toMatchObject({
    status: "checking",
    reason: expect.stringMatching(/verify\.log/u),
  })
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

/** @failure A pause published during composition was replaced by a fresh queue-tip read, so merge crossed the stop.
 * @level l3 @consumer queue operator
 */
it("leases the queue tip observed before an event merge", async () => {
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

  await expect(running).rejects.toThrow()
  expect(await remoteTarget(w)).toBe(w.target)
  expect((await readStatus(store, "main", "task/paused-event")).status).not.toBe("merged")
})

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

/** @failure A direct-only target move was reported under a different identity, or silently disappeared before a queue merge accounted for it.
 * @level l3 @consumer queue operator and notification consumer
 */
it("reports a direct-only commit again under the same sha until a queue merge lands above it", async () => {
  const w = await world()
  await createWorldEventQueue(w)
  const direct = await pushAroundQueue(w, "direct-only.txt")
  const options = { ...(await w.options({ exit: 0 })), checks: [], notify: [] }

  const first = await queueRun(options)
  const second = await queueRun(options)

  expect(first.directMerges).toEqual([direct])
  expect(second.directMerges).toEqual([direct])
  for (const outcome of [first, second]) {
    expect(logRecords(outcome).filter((row) => row.kind === "merged-direct")).toMatchObject([{ commit: direct }])
  }
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
  expect((await queueRun(options)).directMerges).toEqual([])
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

/**
 * A change ref named after the target, planted at the remote exactly as the
 * specimen of 2026-09-03 stands there: `yrd submit` run from a checkout
 * standing on the target opened `main@0a9db9daf7eb` with `Submitter: unknown`
 * at 03:33 PDT. `submit` refuses that now, so the ref is written here instead.
 */
async function plantTargetChange(w: World, head: string): Promise<void> {
  await appendRemoteRecord(w.git, "main", {
    change: { branch: "main", head },
    kind: "opened",
    subject: "unknown submitted main to main",
    trailers: [["Submitter", "unknown"]],
  })
}

async function appendRemoteRecord(git: Git, queue: string, write: WriteRecord): Promise<string> {
  const ref = changeRef(queue, write.change)
  const store = await legacyStore(git)
  const tip = (await store.backend.fetchRefs(store.repo, ref, "origin")).get(ref)
  const record = await recordCommit(git, write, tip)
  await store.backend.publish(store.repo, [{ ref, expect: tip ?? ABSENT, oid: record }], "origin")
  return record
}

async function fetchChanges(w: World): Promise<void> {
  await w.git(["fetch", "--quiet", "origin", "+refs/yrd/main/*:refs/yrd/main/*"])
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

describe("a queue run", () => {
  it("surfaces one Gitomic queue read failure without retrying retired captured-advertisement errors", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")
    const base = await w.options({ exit: 0, on: ["submit"] })
    const failure = new Error("Gitomic queue fetch refused")
    let queueFetches = 0
    using _reader = beforeGitomicPublish(
      async () => {},
      async (_repo, refs) => {
        if (refs === CHANGES) {
          queueFetches += 1
          throw failure
        }
      },
    )

    await expect(queueRun(base)).rejects.toBe(failure)
    expect(queueFetches).toBe(1)
    expect(await remoteTarget(w)).toBe(w.target)
  })

  // The protocol fixtures below cannot prove the actual producer accepts
  // Yrd's captured advertisement or that its opaque notice reaches notify.
  it("observes a real selected GitSuper child tip through an idle queue and its notifier", async () => {
    const w = await world()
    const child = join(w.workdir, "child")
    mkdirSync(w.workdir, { recursive: true })
    await w.git(["init", "--quiet", "--initial-branch=main", child])
    const childGit = gitIn(child)
    await childGit(["config", "user.email", "queue@yrd.test"])
    await childGit(["config", "user.name", "yrd"])
    writeFileSync(join(child, "child.txt"), "before\n")
    await childGit(["add", "."])
    await childGit(["commit", "--quiet", "-m", "child before"])
    const gitlink = (await childGit(["rev-parse", "HEAD"])).trim()
    const rootUrl = "https://example.test/acme/product.git"
    const childUrl = "https://example.test/acme/child.git"
    const config = join(w.workdir, "gitconfig")
    await w.git(["config", "--file", config, `url.${child}.insteadOf`, childUrl])
    await w.git(["config", "--file", config, "protocol.file.allow", "always"])
    // Queue-format detection uses Gitomic's own Git process before the runner
    // passes its environment to GitSuper. Keep the root URL reachable there too.
    await w.git(["config", `url.${w.remote}.insteadOf`, rootUrl])
    for (const [key, value] of [
      ["path", "packages/child"],
      ["url", childUrl],
      ["branch", "main"],
    ] as const) {
      await w.git(["config", "-f", ".gitmodules", `submodule.child.${key}`, value])
    }
    await w.git(["add", ".gitmodules"])
    await w.git(["update-index", "--add", "--cacheinfo", `160000,${gitlink},packages/child`])
    await w.git(["commit", "--quiet", "-m", "declare the product child"])
    await w.git(["push", "--quiet", "origin", "main"])
    const targetSha = (await w.git(["rev-parse", "HEAD"])).trim()
    const base = await w.options({ exit: 0 })
    await w.git(["remote", "set-url", "origin", rootUrl])
    writeFileSync(join(child, "child.txt"), "after\n")
    await childGit(["commit", "--quiet", "-am", "child committed directly to the queue"])
    const tip = (await childGit(["rev-parse", "HEAD"])).trim()
    const outcome = await queueRun({
      ...base,
      targetSha,
      env: { ...base.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" },
      selection: { executable: join(gitSuperBin, "git-super"), contract: "root-v1", scope: "local", origin: "fixture" },
      notify: [{ name: "observer", on: ["observed"], run: w.notifier }],
    })
    expect(outcome.exitCode).toBe(0)
    expect(outcome.observation).toMatchObject({ contract: "root-v1", outcome: "observed" })
    expect(outcome.observation.notices).toHaveLength(1)
    expect(outcome.observation.notices[0]?.text).toContain(tip)
    expect(outcome.observation.notices[0]?.text).toContain("packages/child")
    expect(JSON.parse(readFileSync(w.notifyLog, "utf8"))).toEqual({
      record: "observed",
      notice: outcome.observation.notices[0],
    })
    expect((await childGit(["rev-parse", "HEAD"])).trim()).toBe(tip)
    expect((await w.git(["rev-parse", "HEAD"])).trim()).toBe(targetSha)
  })

  // D1: an idle or paused run still observes; stale/unavailable observations
  // end before candidate work, and generic notices use their own opt-in payload.
  it.each([
    ["observed", 0],
    ["changed-during-read", 3],
    ["unavailable-transport", 4],
    ["invalid", 2],
  ] as const)("settles %s observation once before candidate work, including paused runs", async (outcome, exit) => {
    const w = await world()
    const notices = outcome === "observed" ? [{ id: "opaque-id", text: "producer explanation" }] : []
    const envelope = { version: 1, outcome, message: "selected root observation", notices }
    await using runner = createProcess({ cwd: w.work })
    let calls = 0
    const observed = {
      ...runner,
      run: async (request: Parameters<typeof runner.run>[0]) => {
        if (request.argv.slice(1).join(" ") !== "super observe --protocol=1") return runner.run(request)
        calls++
        expect(request.extraStdio).toBeUndefined()
        return runner.run({
          ...request,
          argv: [
            process.execPath,
            "-e",
            `process.stdout.write(${JSON.stringify(JSON.stringify(envelope))});process.exit(${exit})`,
          ],
        })
      },
    }
    const options = {
      ...(await w.options({ exit: 0 })),
      process: observed,
      git: w.git,
      selection: {
        executable: join(gitSuperBin, "git-super"),
        contract: "root-v1" as const,
        scope: "local" as const,
        origin: "fixture",
      },
      notify: [{ name: "observer", on: ["observed" as const], run: w.notifier }],
    }
    const idle = await queueRun(options)
    expect(idle.exitCode).toBe(outcome === "invalid" ? 2 : 0)
    expect(idle.observation).toEqual({ contract: "root-v1", ...envelope })
    expect(calls).toBe(1)
    const head = await submitCommit(w, "task/one", "one.txt")
    if (outcome === "observed") {
      await writePause(w.git, "origin", "main", { kind: "paused", by: "operator", reason: "observation only" })
    }
    const next = await queueRun(options)
    expect(calls).toBe(2)
    expect(next.exitCode).toBe(outcome === "invalid" ? 2 : 0)
    expect(await remoteTarget(w)).toBe(w.target)
    const ref = changeRef("main", { branch: "task/one", head })
    const tip = (await w.git(["ls-remote", "--refs", "origin", ref])).trim().split(/\s+/u)[0]!
    expect((await readRecords(w.git, tip)).map(({ kind }) => kind)).toEqual(["opened"])
    const logs = logRecords(next)
    expect(logs.some((row) => row.kind === "observation" && row.message === envelope.message)).toBe(true)
    if (outcome === "observed") {
      expect(
        readFileSync(w.notifyLog, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([
        { record: "observed", notice: notices[0] },
        { record: "observed", notice: notices[0] },
      ])
      expect(logs.some((row) => row.kind === "message" && row.id === "opaque-id" && row.delivered === true)).toBe(true)
    } else expect(existsSync(w.notifyLog)).toBe(false)
  })

  it("refuses a queue-owned hooks path that is not empty", async () => {
    const w = await world()
    const hooksPath = join(w.workdir, "hooks-disabled")
    const unexpected = join(hooksPath, "unexpected-hook")
    mkdirSync(hooksPath, { recursive: true })
    writeFileSync(unexpected, "must not run\n")

    await expect(queueRun(await w.options({ exit: 0 }))).rejects.toThrow(
      `queue-owned hooks path ${hooksPath} is not empty (unexpected-hook); remove the named entries, then run yrd queue run`,
    )
  })

  /**
   * @failure  A run that THREW in its Git preamble left a journal with no header
   *           at all — the census over 2309 journals found the header never at
   *           line 1 — and both readers called that a malformed journal rather
   *           than a run that died early (@i/10-yrd/24470 AC1). Red-first holds
   *           by construction: before this branch this exact run wrote no header
   *           anywhere in the file, so line 1 could not be one.
   * @level    l3 — a real remote, a real `ls-remote`, a real throw
   */
  it("a run that throws in its Git preamble still leaves a header, its Git rows, and no queue record", async () => {
    const w = await world()
    const options = await w.options({ exit: 0 })
    // `origin` is configured and `nowhere` is not, so readQueue's own
    // `ls-remote --refs` fails for real, after its one retry. Nothing is
    // stubbed: this is the preamble failing where it actually fails.
    await expect(queueRun({ ...options, target: { ...options.target, remote: "nowhere" } })).rejects.toThrow()

    const logs = join(w.workdir, "logs")
    const journals = readdirSync(logs).filter((name) => name.endsWith(".jsonl"))
    expect(journals).toHaveLength(1)
    const records = readFileSync(join(logs, journals[0] ?? ""), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)

    expect(records[0]).toMatchObject({ kind: "run", target: "main" })
    expect(records.slice(1).every((record) => record.kind === "git")).toBe(true)
    expect(records.some((record) => record.kind === "queue")).toBe(false)
    // The Git rows ARE the diagnosis, which is why journaling the preamble was
    // worth keeping: the run got far enough to try, and the last row says what
    // it tried.
    expect(records.length).toBeGreaterThan(1)
    expect(runDiedInPreamble(records as never)).toBe(true)
  })

  it("pass: the change is checked, merged, the target moves by one merge commit, and the submitter is told to close their bead", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const secondHead = await submitCommit(w, "task/two", "two.txt")
    const selection = await resolveGitSelection(w.work)

    const outcome = await queueRun({
      ...(await w.options({ exit: 0 })),
      selection,
      checks: [
        {
          name: "verify",
          on: ["submit", "merge"],
          run: 'if test -f one.txt; then cat one.txt; else cat two.txt; fi; printf "%s\\n" "$YRD_CANDIDATE_SHA"',
        },
      ],
    })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/one"])
    expect(outcome.directMerges).toEqual([])
    // The queue merges the FIRST checked change and no more (ruling D4), so
    // task/two is ready and waiting the moment this round ends. A service that
    // cannot read that spends its idle cadence between two ready merges, which
    // at `--interval 120` was two minutes per change for nothing.
    expect(outcome.checkedWaiting).toBe(1)
    // Two changes in this SAME run and phase must not share an artifact.
    // This preserves the class witness removed with the old attribution suite.
    const oneLog = checkLogFor(outcome, "task/one", "submit", "verify")
    const twoLog = checkLogFor(outcome, "task/two", "submit", "verify")
    expect(oneLog).not.toBe(twoLog)
    expect(oneLog).toContain(changeName({ branch: "task/one", head }))
    expect(twoLog).toContain(changeName({ branch: "task/two", head: secondHead }))
    const oneOutput = readFileSync(oneLog, "utf8").trim().split("\n")
    const twoOutput = readFileSync(twoLog, "utf8").trim().split("\n")
    expect(oneOutput).toEqual(["one.txt", expect.stringMatching(/^[0-9a-f]{40}$/u)])
    // Head first (25301): task/two is judged after task/one merged, as the
    // round's prefetch, on the target that merge left, so one.txt is there.
    expect(twoOutput).toEqual(["one.txt", expect.stringMatching(/^[0-9a-f]{40}$/u)])
    expect(twoOutput[1]).not.toBe(oneOutput[1])
    const after = await remoteTarget(w)
    expect(after).not.toBe(w.target)
    await w.git(["fetch", "--quiet", "origin", "main"])
    const parents = (await w.git(["rev-list", "--parents", "-n", "1", after])).trim().split(/\s+/u).slice(1)
    expect(parents).toEqual([w.target, head])
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/main/*:refs/yrd/main/*"])
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    // checked after the on-submit phase, merged after the on-merge phase, sent last.
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked", "merged", "sent"])
    // The queue list row names the merge commit and its base in full, for whoever proves a merge by ancestry.
    const row = list((await readQueue(w.git, "origin", "main", after)).changes).find(
      (candidate) => candidate.branch === "task/one",
    )
    expect(row?.state).toBe("merged")
    expect(row?.merge).toBe(after)
    expect(row?.base).toBe(w.target)
    const sent = messages(w)
    expect(sent).toHaveLength(1)
    // The record a notify entry reads names the ending: which record, which change,
    // who submitted it, what it is for, and the merge it made. No id, because
    // the change and the ending are the message's identity; no prose, because
    // the entry composes what it says.
    expect(sent[0]).toEqual({
      change: changeName({ branch: "task/one", head }),
      record: "merged",
      issue: "@i/10-yrd/1",
      merge: await remoteTarget(w),
      submitter: "@dev/2",
    })
    expect(
      readFileSync(outcome.log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { kind: string }).kind),
    ).toEqual(expect.arrayContaining(["run", "change", "check", "result", "merge", "message"]))
    // 24470: THE JOURNAL OPENS WITH ITS HEADER. Every field the header carries
    // is known from the run's options, so it is written before the first
    // journaled Git call and a headerless journal is structurally impossible.
    // The queue name is the one value that is not option-known, so it follows
    // as its own record once the remote is read — and that record doubles as
    // the mark that the Git preamble completed.
    const kinds = logRecords(outcome).map((record) => record.kind)
    expect(kinds[0]).toBe("run")
    expect(kinds.indexOf("queue")).toBeGreaterThan(0)
    expect(kinds.indexOf("queue")).toBeLessThan(kinds.indexOf("change"))
    expect(logRecords(outcome)[kinds.indexOf("queue")]).toMatchObject({ kind: "queue", queue: expect.any(String) })
    // The preamble's Git rows are still journaled: they sit between the header
    // and the queue record, which is where a died-in-preamble run's evidence is.
    // The queue read is part of that preamble and is timed as a `step` (25303 box 1).
    expect(kinds.slice(1, kinds.indexOf("queue")).every((kind) => kind === "git" || kind === "step")).toBe(true)
    // Addendum 2/T1: every ordinary run invocation is linked before the run
    // summarizes it, including successful calls rebound to a worktree.
    const runRecords = logRecords(outcome)
    const invocations = runRecords.filter((record) => record.kind === "git")
    expect(invocations.length).toBeGreaterThan(0)
    expect(invocations.some((record) => record.cwd !== w.work)).toBe(true)
    const checkedHeads: string[] = []
    const checkedBases: string[] = []
    for (const invocation of invocations) {
      expect(invocation).toMatchObject({ executable: selection.executable, contract: "native", complete: true })
      const evidence = JSON.parse(readFileSync(String(invocation.evidence), "utf8")) as {
        selection: typeof selection
        artifacts: { stdout: string; stderr: string }
      }
      expect(evidence.selection).toEqual(selection)
      expect(existsSync(evidence.artifacts.stdout)).toBe(true)
      expect(existsSync(evidence.artifacts.stderr)).toBe(true)
      if (
        invocation.cwd !== w.work &&
        Array.isArray(invocation.args) &&
        invocation.args.join(" ") === "rev-parse HEAD"
      ) {
        checkedHeads.push(readFileSync(evidence.artifacts.stdout, "utf8").trim())
      }
      if (invocation.cwd !== w.work && Array.isArray(invocation.args) && invocation.args[0] === "merge-base") {
        // task/two's prefetch stands on the target task/one's merge left (25301).
        expect(readFileSync(evidence.artifacts.stdout, "utf8").trim()).toBe(
          invocation.args[1] === twoOutput[1] ? after : w.target,
        )
        checkedBases.push(String(invocation.args[1]))
      }
    }
    // D1/T1: worktree facts that identify each checked commit must retain the
    // same selection/evidence. Other rebound calls alone missed this escape.
    const judged = new Set([oneOutput[1], twoOutput[1], after])
    expect(new Set(checkedHeads)).toEqual(judged)
    expect(new Set(checkedBases)).toEqual(judged)
    // The final re-read must be evidenced after preparation too: its candidate
    // can equal the prepared commit, so a set of OIDs cannot prove this boundary.
    const mergeCheck = runRecords.findIndex(
      (record) => record.kind === "check" && record.phase === "merge" && record.end === undefined,
    )
    expect(mergeCheck).toBeGreaterThan(0)
    // The pair is found rather than taken from the end of the list. It used to
    // be `.slice(-2)`, which silently encoded "nothing else runs between the
    // re-read and the check" — true until 24573's judged-tree digest landed
    // between them, and the assertion then failed for a reason that had nothing
    // to do with what it exists to prove. The invariant is the PAIRING and its
    // cwd, not adjacency to the check.
    const gitBeforeMergeCheck = runRecords.slice(0, mergeCheck).filter((record) => record.kind === "git")
    const mergeBaseAt = gitBeforeMergeCheck.findLastIndex(
      (record) => Array.isArray(record.args) && record.args.join(" ") === `merge-base ${after} ${w.target}`,
    )
    expect(mergeBaseAt, "the merged tree's base must be re-read before the merge check").toBeGreaterThan(0)
    const reread = gitBeforeMergeCheck[mergeBaseAt - 1]
    expect(reread?.args).toEqual(["rev-parse", "HEAD"])
    expect(reread?.cwd).toBe(gitBeforeMergeCheck[mergeBaseAt]?.cwd)
    expect(reread?.cwd).not.toBe(w.work)

    // 24573: and the digest that says WHAT the checks are about to read must
    // itself run before them. Without this the queue can judge a root whose
    // bytes are not the merge commit's and nothing records that it happened.
    const judgedRows = runRecords.filter((record) => record.kind === "judged")
    expect(judgedRows.length, "the judged-tree digest must run before the merge checks").toBeGreaterThan(0)
    expect(judgedRows.every((record) => record.same === true)).toBe(true)
    expect(runRecords.findIndex((record) => record.kind === "judged")).toBeLessThan(mergeCheck)
  })

  it.each([
    ["checked", "diverged", 1],
    ["sent", "diverged", 1],
    ["sent", "behind", 1],
    ["sent", "equal", 1],
    ["sent", "ahead", 1],
    ["sent", "unknown", 1],
    ["sent", "diverged", 2],
  ] as const)(
    "a second writer racing the %s record (%s, %i refusals) preserves records and explains the tips (24096)",
    async (kind, relation, refusals) => {
      const w = await world()
      const head = await submitCommit(w, "task/one", "one.txt")
      const ref = changeRef("main", { branch: "task/one", head })
      const queueRepo = (await w.git(["rev-parse", "--absolute-git-dir"])).trim()
      const rivalPath = join(w.workdir, "..", "record-rival")
      await gitIn(join(w.workdir, ".."))(["clone", "--quiet", w.remote, rivalPath])
      const rival = gitIn(rivalPath)
      await rival(["config", "user.email", "rival@yrd.test"])
      await rival(["config", "user.name", "rival"])

      let concurrent: string | undefined
      let intended: string | undefined
      let raced = 0
      using _publication = beforeGitomicPublish(async (repo, updates) => {
        if (repo !== queueRepo) return
        // Between the tip this run read the change at and its leased publish, a
        // second queue appends a record of its own and publishes it first.
        const update = updates.find((candidate) => candidate.ref === ref)
        if (
          raced >= refusals ||
          update?.oid === null ||
          update?.oid === undefined ||
          (await recordKindOf(w.git, update.oid)) !== kind
        ) {
          return
        }
        raced += 1
        intended = update.oid
        await rival(["fetch", "--quiet", "origin", `${ref}:${ref}`])
        const previous = (await rival(["rev-parse", ref])).trim()
        if (relation === "behind" || relation === "equal" || relation === "ahead") {
          // A real second writer already has our intended record (or has
          // appended after it), but our captured lease still names its parent.
          await rival(["fetch", "--quiet", w.work, intended])
          await rival(["update-ref", ref, intended])
        }
        concurrent =
          relation === "ahead"
            ? (await rival(["rev-parse", `${intended}^^`])).trim()
            : relation === "equal"
              ? intended
              : await appendRecord(rival, "main", {
                  change: { branch: "task/one", head },
                  kind: "stuck",
                  subject: "another queue got there first",
                  trailers: RIVAL_STUCK_TRAILERS,
                })
        // Only the disposable fixture's remote rewinds, under its exact
        // previous value, to exercise an external writer moving backwards.
        await rival([
          "push",
          "--quiet",
          ...(relation === "ahead" ? [`--force-with-lease=${ref}:${previous}`] : []),
          "origin",
          `${concurrent}:${ref}`,
        ])
      })
      const git: Git = async (args, input) => {
        if (relation === "unknown" && args[0] === "merge-base" && args[1] === intended && args[2] === concurrent) {
          throw new Error("diagnostic ancestry read unavailable")
        }
        return w.git(args, input)
      }
      Object.assign(git, { selection: selectionFor(w.git) })

      const outcome = await queueRun({ ...(await w.options({ exit: 0, on: ["submit"] })), git })

      // The lease refused the first push, so the rival's record stands; the same
      // record was written again onto it and pushed, so neither is lost and the
      // run went on to merge.
      expect(outcome.exitCode, readFileSync(outcome.log, "utf8")).toBe(0)
      expect(outcome.merged).toEqual(["task/one"])
      await fetchChanges(w)
      const records = await readRecords(w.git, (await refAt(w.git, ref))!)
      expect(records.map((record) => record.kind)).toEqual(
        kind === "checked"
          ? ["opened", "stuck", "checked", "merged", "sent"]
          : relation === "equal"
            ? ["opened", "checked", "merged", "sent"]
            : relation === "ahead"
              ? ["opened", "checked", "sent"]
              : relation === "behind"
                ? ["opened", "checked", "merged", "sent", "stuck", "sent"]
                : refusals === 2
                  ? ["opened", "checked", "merged", "stuck", "stuck"]
                  : ["opened", "checked", "merged", "stuck", "sent"],
      )
      expect(records.map((record) => record.sha)).toContain(concurrent)
      expect(intended).toMatch(/^[0-9a-f]{40}$/u)
      if (relation === "equal") {
        // Git accepts an already-equal ref as up-to-date, even with the old
        // lease. There was no rejected write to diagnose or retry.
        expect(logRecords(outcome).filter((record) => record.reason === "change-ref-taken")).toEqual([])
        return
      }
      expect(logRecords(outcome)).toContainEqual(
        expect.objectContaining({
          decision: kind,
          reason: "change-ref-taken",
          ref,
          remote: concurrent,
          intended,
          relation,
        }),
      )
      const diagnostic = logRecords(outcome).findLast((record) => record.reason === "change-ref-taken")
      expect(diagnostic).not.toHaveProperty("next")
      expect(diagnostic?.text).toBe(
        `${ref}: remote ${concurrent}, intended ${intended} (${relation})${relation === "unknown" ? "; ancestry read failed: diagnostic ancestry read unavailable" : ""}; inspect: ${String(diagnostic?.inspect)}`,
      )
      // The diagnostic's read is executable in the emitting state, using the
      // exact fetched objects even though the remote ref has moved again.
      const read = spawnSync("sh", ["-c", String(diagnostic?.inspect)], { encoding: "utf8" })
      expect(read.status, read.stderr).toBe(0)
      if (relation === "ahead") expect(read.stdout).toMatch(/^</mu)
      else expect(read.stdout).toMatch(/^>/mu)
      if (relation === "diverged" || relation === "unknown") expect(read.stdout).toMatch(/^</mu)
      if (relation === "unknown") expect(diagnostic?.error).toBe("diagnostic ancestry read unavailable")
      if (refusals === 2) {
        expect(logRecords(outcome)).toContainEqual(
          expect.objectContaining({ reason: "change-ref-contended", ref, remote: concurrent, intended, relation }),
        )
        expect(logRecords(outcome)).toContainEqual(
          expect.objectContaining({ kind: "message", delivered: false, says: "merged" }),
        )
      }
    },
  )

  it("a refused record push with an unchanged remote tip rethrows its original error", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const ref = changeRef("main", { branch: "task/one", head })
    const before = (await w.git(["ls-remote", "--refs", "origin", ref])).trim().split(/\s+/u)[0]
    const refused = new Error("record transport refused")
    using _publication = beforeGitomicPublish(async (_repo, updates) => {
      if (updates.some((update) => update.ref === ref)) throw refused
    })

    await expect(queueRun(await w.options({ exit: 0, on: ["submit"] }))).rejects.toBe(refused)
    expect((await w.git(["ls-remote", "--refs", "origin", ref])).trim().split(/\s+/u)[0]).toBe(before)
    expect(await remoteTarget(w)).toBe(w.target)
  })

  it("fail: the target stands still, the change ends failed with the check and a remedy, and the submitter gets it back", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(await w.options({ exit: 1 }))

    expect(outcome.exitCode).toBe(1)
    expect(outcome.failed).toEqual(["task/one"])
    expect(await remoteTarget(w)).toBe(w.target)
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/main/*:refs/yrd/main/*"])
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked", "failed", "sent"])
    expect(records[2]?.trailers).toEqual(
      expect.arrayContaining([
        ["Reason", "verify"],
        ["Fault", "submitter"],
      ]),
    )
    expect(messages(w)[0]).toEqual({
      change: changeName({ branch: "task/one", head }),
      record: "failed",
      failures: 1,
      issue: "@i/10-yrd/1",
      log: expect.stringContaining("verify.log"),
      reason: "verify",
      submitter: "@dev/2",
    })
  })

  // @i/10-yrd/25301 A1 (@cto c7115f0f): the head merges before the rest of the line is judged,
  // and (@cto 20a360d8, cure (a)) the round then prepares only the NEXT head: the rest of the
  // line is judged when the walk of a later round reaches it, never all at once after a merge.
  it("with 40 changes waiting, the head merges, the next head is judged, and the other 38 wait unjudged (25301 A1)", async () => {
    const w = await world()
    const branches = Array.from({ length: 40 }, (_, i) => `task/c${String(i).padStart(2, "0")}`)
    const heads: string[] = []
    for (const branch of branches) heads.push(await submitCommit(w, branch, `${branch.slice(5)}.txt`))

    const outcome = await queueRun(await w.options({ exit: 0, on: ["submit", "merge"] }))

    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/c00"])
    const mergeCommit = await remoteTarget(w)
    const lines = readFileSync(w.checkLog, "utf8").trim().split("\n")
    // The check log is in time order: the head's judge, the head's merge check
    // (whose candidate IS the merge that landed), then ONE judge, the next
    // head's, standing on that merge. Nothing else in the line is judged.
    expect(lines).toHaveLength(3)
    expect(/candidate=(\S+)/u.exec(lines[1]!)?.[1]).toBe(mergeCommit)
    expect(lines.map((line) => /base=(\S+)/u.exec(line)?.[1])).toEqual([w.target, w.target, mergeCommit])
    expect(outcome.checkedWaiting).toBe(1)
    await fetchChanges(w)
    // @cto 62ed0395 (2): the prepared head's verdict names the target it stood on.
    const next = await readRecords(
      w.git,
      (await refAt(w.git, changeRef("main", { branch: "task/c01", head: heads[1]! })))!,
    )
    expect(trailer(next.find((record) => record.kind === "checked")!, "Base")).toBe(mergeCommit)
    // The last change was never judged: its chain holds only its opening record.
    const last = await readRecords(
      w.git,
      (await refAt(w.git, changeRef("main", { branch: "task/c39", head: heads[39]! })))!,
    )
    expect(last.map((record) => record.kind)).toEqual(["opened"])
    // review2 25301 r2 record 1: each read step names the target that read stood
    // on, so the next head's read and the final re-read name the head's merge.
    const reads = readFileSync(outcome.log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind?: string; name?: string; base?: string })
      .filter((row) => row.kind === "step" && row.name === "read")
    expect([...new Set(reads.map((row) => row.base))]).toEqual([w.target, mergeCommit])
  }, 180_000)

  // @cto 62ed0395 (3): a head whose merge changes .yrd.yml leaves the tail unjudged,
  // so no verdict is written under a declaration the target no longer carries.
  it("a head whose merge edits .yrd.yml prefetches nothing, and the next round judges the tail (25301)", async () => {
    const w = await world()
    // A valid edit: the declaration stays the empty mapping, as another blob.
    await w.git(["checkout", "--quiet", "-b", "task/declaration", "main"])
    writeFileSync(join(w.work, ".yrd.yml"), "# edited by the head\n{}\n")
    await w.git(["add", ".yrd.yml"])
    await w.git(["commit", "--quiet", "-m", "edit the declaration"])
    await w.git(["checkout", "--quiet", "main"])
    await submit(w.git, "origin", {
      branch: "task/declaration",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
      issue: "@i/10-yrd/1",
    })
    const tailHead = await submitCommit(w, "task/after", "after.txt")

    const outcome = await queueRun(await w.options({ exit: 0, on: ["submit", "merge"] }))

    expect(outcome.merged).toEqual(["task/declaration"])
    expect(outcome.checkedWaiting).toBe(0)
    // The head's judge and its merge check, and nothing for the tail.
    expect(readFileSync(w.checkLog, "utf8").trim().split("\n")).toHaveLength(2)
    const journal = readFileSync(outcome.log, "utf8")
    expect(journal).toContain("the head's merge changed .yrd.yml")
    await fetchChanges(w)
    const tail = (await readQueue(w.git, "origin", "main", await remoteTarget(w))).changes.find(
      (entry) => entry.change.head === tailHead,
    )!
    expect(tail.reading.state).toBe("queued")
  })

  // @i/10-yrd/25351: after a head whose merge changes .yrd.yml, a change checked in an
  // earlier round under the old declaration is not ready; the recount compares each
  // verdict with the declaration the target ENDED on, not the one the round started under.
  it("after a head whose merge edits .yrd.yml, a change checked under the old declaration is not counted waiting (25351)", async () => {
    const w = await world()
    await w.git(["checkout", "--quiet", "-b", "task/declaration", "main"])
    writeFileSync(join(w.work, ".yrd.yml"), "# edited by the head\n{}\n")
    await w.git(["add", ".yrd.yml"])
    await w.git(["commit", "--quiet", "-m", "edit the declaration"])
    await w.git(["checkout", "--quiet", "main"])
    await submit(w.git, "origin", {
      branch: "task/declaration",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
      issue: "@i/10-yrd/1",
    })
    // The change behind it was checked in an earlier round, under the declaration this round starts under.
    const options = await w.options({ exit: 0, on: ["submit", "merge"] })
    const laterHead = await submitCommit(w, "task/later", "later.txt")
    await appendRemoteRecord(w.git, "main", {
      change: { branch: "task/later", head: laterHead },
      kind: "checked",
      subject: `task/later passed the on-submit checks at main ${w.target.slice(0, 12)}`,
      trailers: [
        ["Config", options.configBlob],
        ["Base", w.target],
      ],
    })

    const outcome = await queueRun(options)

    expect(outcome.merged).toEqual(["task/declaration"])
    expect(readFileSync(outcome.log, "utf8")).toContain("the head's merge changed .yrd.yml")
    expect(outcome.checkedWaiting).toBe(0)
  })

  // @cto ac87d1e5: a head in FRONT of a stuck row merges; the line still stops on
  // that row in the same round, and one outcome names both.
  it("a head in front of a stuck change merges, and the same round stops the line on the stuck change (25301)", async () => {
    const w = await world()
    await submitCommit(w, "task/a", "a.txt")
    await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(await w.options({ exit: 2, on: ["submit", "merge"] }))

    expect(outcome.merged).toEqual(["task/a"])
    expect(outcome.stuck).toEqual(["task/one"])
    expect(outcome.exitCode).toBe(2)
    expect(outcome.stopped).toBeDefined()
    expect(await remoteTarget(w)).not.toBe(w.target)
  })

  // @cto ac87d1e5: the prefetch is cancellable at the stop-time check and writes no partial verdict.
  it("a stop time that closes while the head merges leaves the rest of the line unjudged (25301)", async () => {
    const w = await world()
    await submitCommit(w, "task/head", "head.txt")
    await submitCommit(w, "task/tail", "tail.txt")
    const closed = join(w.workdir, "window-closed.flag")
    const submitLog = join(w.workdir, "submit-checks.log")
    const script = (name: string, body: string): string => {
      const path = join(w.workdir, name)
      writeFileSync(
        path,
        ["#!/bin/sh", body, `echo 'YRD-CHECK-RESULT {"result":"pass","exit":0}'`, "exit 0", ""].join("\n"),
      )
      chmodSync(path, 0o755)
      return path
    }
    const base = await w.options({ timeoutMs: 1800000 })
    const onSubmit: CheckSpec = {
      ...base.checks[0]!,
      name: "on-submit",
      on: ["submit"] as const,
      run: script("on-submit.sh", `echo "$YRD_CANDIDATE_SHA" >> "${submitLog}"`),
    }
    const onMerge: CheckSpec = {
      ...base.checks[0]!,
      name: "on-merge",
      on: ["merge"] as const,
      run: script("on-merge.sh", `touch "${closed}"`),
    }

    const outcome = await queueRun({
      ...base,
      checks: [onSubmit, onMerge],
      stopAtMs: 2000,
      // The window closes during the head's on-merge check, after its last stop-time gate.
      now: () => (existsSync(closed) ? 3000 : 1000),
    })

    expect(outcome.merged).toEqual(["task/head"])
    expect(outcome.failed).toEqual([])
    expect(outcome.deferred).toEqual([])
    // One on-submit check ran, the head's: the prefetch never started on the tail.
    expect(readFileSync(submitLog, "utf8").trim().split("\n")).toHaveLength(1)
    await fetchChanges(w)
    const tail = (await readQueue(w.git, "origin", "main", await remoteTarget(w))).changes.find(
      (entry) => entry.change.branch === "task/tail",
    )!
    // No partial verdict: the tail's chain holds only its opening record.
    expect(tail.reading.state).toBe("queued")
    expect(tail.change.records.map((record) => record.kind)).toEqual(["opened"])
  })

  // @i/10-yrd/25301 row 3: a withdrawn record is never composed or judged. The round
  // re-reads each change's state before it judges it; one withdrawn meanwhile is
  // skipped with one journal line (the service judged task/25314-fence-eof after it
  // had been withdrawn, 2026-09-23).
  it("a change withdrawn while an earlier change is judged is skipped with one journal line, never judged (25301 row 3)", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")
    const twoHead = await submitCommit(w, "task/two", "two.txt")

    // task/one fails its judge (its file is one.txt); while that check runs,
    // task/two is withdrawn, so the walk reaches a change that has left the line.
    const running = queueRun(await w.options({ exit: 1, sleep: 2, on: ["submit", "merge"] }))
    await checkRunning(w)
    await withdraw(w.git, "origin", { branch: "task/two", by: "@chief", target: { branch: "main", remote: "origin" } })
    const outcome = await running

    expect(outcome.failed).toEqual(["task/one"])
    expect(outcome.merged).toEqual([])
    expect(await remoteTarget(w)).toBe(w.target)
    // One judge ran, task/one's; task/two was never composed or judged.
    expect(readFileSync(w.checkLog, "utf8").trim().split("\n")).toHaveLength(1)
    const skips = logRecords(outcome).filter(
      (record) => record.kind === "observation" && String(record.why ?? "").includes("left the line"),
    )
    expect(skips).toHaveLength(1)
    expect(String(skips[0]?.why)).toContain(`task/two@${twoHead.slice(0, 12)}`)
    expect(String(skips[0]?.why)).toContain("withdrawn")
  })

  // @i/10-yrd/25301 A2 (restated by @cto ac87d1e5): a config edit re-judges no
  // change before the head merges; each stale verdict is re-judged when reached.
  it("after a config edit, the round re-judges the head, merges it, then re-judges the next against the new target (25301 A2)", async () => {
    const w = await world()
    for (const branch of ["task/c0", "task/c1", "task/c2"]) await submitCommit(w, branch, `${branch.slice(5)}.txt`)
    const first = await queueRun(await w.options({ exit: 0, on: ["submit", "merge"] }))
    expect(first.merged).toEqual(["task/c0"])
    const afterFirst = await remoteTarget(w)
    const linesBefore = readFileSync(w.checkLog, "utf8").trim().split("\n").length

    // The declared check config changes between the rounds: c1 and c2 were checked under the old one.
    const second = await queueRun({ ...(await w.options({ exit: 0, on: ["submit", "merge"] })), configBlob: "edited" })

    expect(second.merged).toEqual(["task/c1"])
    const afterSecond = await remoteTarget(w)
    const lines = readFileSync(w.checkLog, "utf8").trim().split("\n").slice(linesBefore)
    const candidates = lines.map((line) => /candidate=(\S+)/u.exec(line)?.[1])
    // Three checks this round, in time order: c1's re-judge, c1's merge check
    // (its candidate IS the merge that landed), then c2's re-judge, on the
    // target c1's merge left. One judge before the head merged: never the
    // whole line first.
    expect(lines.map((line) => /base=(\S+)/u.exec(line)?.[1])).toEqual([afterFirst, afterFirst, afterSecond])
    expect(candidates).toHaveLength(3)
    expect(candidates[1]).toBe(afterSecond)
    expect(candidates[2]).not.toBe(afterSecond)
  })

  describe("a merge-check override (25296)", () => {
    const actor = { by: "@dev/3", verified: false }
    const hour = 3_600_000
    const lines = (w: World): string[] => readFileSync(w.checkLog, "utf8").trim().split("\n").filter(Boolean)

    // @cto 842fdb30 (7): set -> the next rounds merge without the check and with
    // no .yrd.yml change; clear -> the following round runs it again.
    it("set holds the merge check off with no declaration change and no re-judge; clear turns it back on", async () => {
      const w = await world()
      const heads: string[] = []
      for (let i = 0; i < 10; i++) heads.push(await submitCommit(w, `task/o${String(i)}`, `o${String(i)}.txt`))
      const base = await w.options({ exit: 0, on: ["submit", "merge"] })
      const declared = structuredClone(base.checks)
      const set = await writeOverride(
        w.git,
        "origin",
        "main",
        { actor, check: "verify", kind: "off", reason: "a flaky gate", until: new Date(Date.now() + hour) },
        ["verify"],
      )
      expect(set.kind).toBe("set")

      const first = await queueRun({ ...base, overrides: await readOverrides(w.git, "origin", "main") })

      expect(first.merged).toEqual(["task/o0"])
      // The head's submit judge and the next head's judge (25301 cure (a)),
      // and no merge check: with the check on, this round writes three lines.
      expect(lines(w)).toHaveLength(2)
      const journal = readFileSync(first.log, "utf8")
      expect(journal).toContain('"kind":"skipped"')
      expect(journal).toContain("verify OFF until")
      await fetchChanges(w)
      const records = await readRecords(
        w.git,
        (await refAt(w.git, changeRef("main", { branch: "task/o0", head: heads[0]! })))!,
      )
      const record = records.find((entry) => entry.kind === "merged")!
      expect(trailer(record, "Skipped")).toContain(`verify override=${set.record.sha}`)
      // (C3) the declaration the run was given is untouched.
      expect(base.checks).toEqual(declared)

      // (C2) the next round re-judges nothing: o1 is checked, and its merge check is still off.
      const second = await queueRun({
        ...(await w.options({ exit: 0, on: ["submit", "merge"] })),
        overrides: await readOverrides(w.git, "origin", "main"),
      })
      expect(second.merged).toEqual(["task/o1"])
      // o1 merges on round one's verdict with no merge check; the one new line is
      // the next head's (o2's) first judge, not a re-judge of o1.
      expect(lines(w)).toHaveLength(3)

      await writeOverride(w.git, "origin", "main", { actor, check: "verify", kind: "clear", reason: "gate fixed" }, [
        "verify",
      ])
      const third = await queueRun({
        ...(await w.options({ exit: 0, on: ["submit", "merge"] })),
        overrides: await readOverrides(w.git, "origin", "main"),
      })
      expect(third.merged).toEqual(["task/o2"])
      // o2 was judged by round two, so its merge check runs with no re-judge;
      // then o3, the next head, is judged: two new lines.
      expect(lines(w)).toHaveLength(5)
    }, 180_000)

    // (C4) the next round after expiry runs the check, and the entry reads expired, never absent.
    it("an expired override is written expired by the round's caller and the check runs again", async () => {
      const w = await world()
      await submitCommit(w, "task/expiry", "expiry.txt")
      const now = Date.now()
      await writeOverride(
        w.git,
        "origin",
        "main",
        { actor, check: "verify", kind: "off", reason: "window", until: new Date(now + hour) },
        ["verify"],
      )
      const later = now + 2 * hour
      const expired = await expireOverrides(w.git, "origin", "main", later, "yrd")
      expect(expired.expired.map((entry) => entry.check)).toEqual(["verify"])
      expect(expired.table.entries).toMatchObject([{ check: "verify", state: "expired" }])

      const paged = join(w.workdir, "paged.jsonl")
      const outcome = await queueRun({
        ...(await w.options({ exit: 0, on: ["submit", "merge"] })),
        notify: [{ name: "pager", on: ["override"], run: `cat >> ${paged}` }],
        now: () => later,
        overrides: expired.table,
        overridesExpired: expired.expired,
      })

      expect(outcome.merged).toEqual(["task/expiry"])
      // @cto ccd8dfa8: the round pages the expiry once, naming itself.
      const [notice, ...more] = readFileSync(paged, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(more).toEqual([])
      expect(notice).toMatchObject({
        action: "expired",
        check: "verify",
        owner: "@dev/3",
        reason: "window",
        record: "override",
      })
      expect(notice?.["round"]).toEqual(expect.any(String))
      expect(readFileSync(outcome.log, "utf8")).toContain(String(notice?.["round"]))
      expect(readFileSync(outcome.log, "utf8")).toContain("told pager that merge check verify override expired")
      // Its submit judge and its merge check: the check ran at merge again.
      expect(lines(w)).toHaveLength(2)
      const journal = readFileSync(outcome.log, "utf8")
      expect(journal).toContain('"kind":"override"')
      expect(journal).toContain("verify override expired")
      // A second expiry pass writes nothing more.
      expect((await expireOverrides(w.git, "origin", "main", later, "yrd")).expired).toEqual([])
    })

    // @cto ccd8dfa8: the half-window reminder is recorded on the chain, so the
    // round pages it once and the next round does not page it again.
    it("pages the half-window reminder once, recorded on the override chain", async () => {
      const w = await world()
      await submitCommit(w, "task/remind", "remind.txt")
      const now = Date.now()
      await writeOverride(
        w.git,
        "origin",
        "main",
        { actor, check: "verify", kind: "off", reason: "window", until: new Date(now + 2 * hour) },
        ["verify"],
      )
      const early = await expireOverrides(w.git, "origin", "main", now + hour / 2, "yrd")
      expect(early.reminded).toEqual([])
      const halfway = now + 1.5 * hour
      const reminded = await expireOverrides(w.git, "origin", "main", halfway, "yrd")
      expect(reminded.expired).toEqual([])
      expect(reminded.reminded.map((entry) => entry.check)).toEqual(["verify"])
      expect(reminderDue(reminded.table.entries[0]!, halfway)).toBe(false)
      expect(reminded.table.entries).toMatchObject([
        { check: "verify", state: "active", remindedAt: new Date(halfway) },
      ])

      const paged = join(w.workdir, "paged.jsonl")
      const outcome = await queueRun({
        ...(await w.options({ exit: 0, on: ["submit", "merge"] })),
        notify: [{ name: "pager", on: ["override"], run: `cat >> ${paged}` }],
        now: () => halfway,
        overrides: reminded.table,
        overridesExpired: reminded.expired,
        overridesReminded: reminded.reminded,
      })

      expect(outcome.merged).toEqual(["task/remind"])
      const notices = readFileSync(paged, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(notices).toMatchObject([
        { action: "reminder", check: "verify", owner: "@dev/3", round: expect.any(String) },
      ])
      // Recorded on the chain: a later pass reminds nobody.
      expect((await expireOverrides(w.git, "origin", "main", halfway + 60_000, "yrd")).reminded).toEqual([])
    })

    // r3 triage F5: a skip is never a result, so a merge phase that stopped
    // before an un-overridden check defers on stop time instead of merging.
    it("a skipped check never counts as a result: a stop before the next merge check defers, never merges", async () => {
      const w = await world()
      await submitCommit(w, "task/f5", "f5.txt")
      const flag = join(w.workdir, "window.flag")
      const ran = join(w.workdir, "second.log")
      const script = (name: string, body: string): string => {
        const path = join(w.workdir, name)
        writeFileSync(path, ["#!/bin/sh", body, "exit 0", ""].join("\n"))
        chmodSync(path, 0o755)
        return path
      }
      const base = await w.options({ exit: 0 })
      const spec = base.checks[0]!
      const checks: CheckSpec[] = [
        { ...spec, name: "held", on: ["merge"], run: script("held.sh", "true") },
        { ...spec, name: "closer", on: ["merge"], run: script("closer.sh", `touch "${flag}"`) },
        { ...spec, name: "second", on: ["merge"], run: script("second.sh", `echo ran >> "${ran}"`) },
      ]
      await writeOverride(
        w.git,
        "origin",
        "main",
        { actor, check: "held", kind: "off", reason: "f5", until: new Date(Date.now() + hour) },
        ["held", "closer", "second"],
      )

      const outcome = await queueRun({
        ...base,
        checks,
        now: () => (existsSync(flag) ? 3000 : 1000),
        overrides: await readOverrides(w.git, "origin", "main"),
        stopAtMs: 2000,
      })

      expect(outcome.merged).toEqual([])
      expect(outcome.deferred).toEqual(["task/f5"])
      expect(existsSync(ran)).toBe(false)
    })

    // @cto e2642976 (3): probe B as a test. A rival override write after the
    // round's snapshot refuses the merge push; main does not move, and the
    // ending names the rival.
    it("a rival override write after the snapshot refuses the merge, and the ending names it", async () => {
      const w = await world()
      await submitCommit(w, "task/fenced", "fenced.txt")
      const snapshot = await readOverrides(w.git, "origin", "main")
      const rival = await writeOverride(
        w.git,
        "origin",
        "main",
        { actor, check: "verify", kind: "off", reason: "rival", until: new Date(Date.now() + hour) },
        ["verify"],
      )
      const before = await remoteTarget(w)

      const outcome = await queueRun({
        ...(await w.options({ exit: 0, on: ["submit", "merge"] })),
        overrides: snapshot,
      })

      expect(outcome.merged).toEqual([])
      expect(await remoteTarget(w)).toBe(before)
      const row = readFileSync(outcome.log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((entry) => entry.kind === "change" && entry.reason === "override-moved")
      expect(row).toMatchObject({ branch: "task/fenced", saw: rival.record.sha })
    })

    it("a merge fence advances the override ref and names the merge; the next write chains on it", async () => {
      const w = await world()
      const head = await submitCommit(w, "task/fence-audit", "audit.txt")
      const outcome = await queueRun({
        ...(await w.options({ exit: 0, on: ["submit", "merge"] })),
        overrides: await readOverrides(w.git, "origin", "main"),
      })
      expect(outcome.merged).toEqual(["task/fence-audit"])
      const table = await readOverrides(w.git, "origin", "main")
      expect(table.sha).toBeDefined()
      const subject = (await w.git(["log", "-1", "--format=%s", table.sha!])).trim()
      expect(subject).toBe(`merge fence: task/fence-audit@${head} in round ${outcome.run}`)
      expect(table.entries).toEqual([])
    })

    it("refuses an unknown check, an out-of-window --until, a clear with nothing standing, and an unreadable tip", async () => {
      const w = await world()
      const now = Date.now()
      await expect(
        writeOverride(
          w.git,
          "origin",
          "main",
          { actor, check: "nope", kind: "off", reason: "x", until: new Date(now + hour) },
          ["verify"],
        ),
      ).rejects.toThrow("no merge check named 'nope' is declared; the declared merge checks are: verify")
      expect(() => parseUntil(new Date(now + 13 * hour).toISOString(), now)).toThrow(OverrideRefused)
      expect(() => parseUntil(new Date(now - hour).toISOString(), now)).toThrow("must be after now")
      expect(() => parseUntil("tomorrow", now)).toThrow("neither an ISO instant")
      await expect(
        writeOverride(w.git, "origin", "main", { actor, check: "verify", kind: "clear", reason: "x" }, ["verify"]),
      ).rejects.toThrow("no override stands on 'verify' to clear")
      // A tip that is not an override record is loud, never read as "no overrides".
      const junk = (await w.git(["commit-tree", (await w.git(["mktree"], "")).trim(), "-m", "not a record"])).trim()
      await w.git(["push", "--quiet", "origin", `${junk}:${overrideRef("main")}`])
      await expect(readOverrides(w.git, "origin", "main")).rejects.toThrow("carries no valid Record")
    })

    it("a second --off on the same check replaces the first and names it", async () => {
      const w = await world()
      const first = await writeOverride(
        w.git,
        "origin",
        "main",
        { actor, check: "verify", kind: "off", reason: "one", until: new Date(Date.now() + hour) },
        ["verify"],
      )
      const second = await writeOverride(
        w.git,
        "origin",
        "main",
        { actor, check: "verify", kind: "off", reason: "two", until: new Date(Date.now() + 2 * hour) },
        ["verify"],
      )
      expect(second.kind).toBe("replaced")
      expect(second.replaced?.record).toBe(first.record.sha)
      expect(second.record.entries).toMatchObject([{ check: "verify", reason: "two", record: second.record.sha }])
      const body = await w.git(["log", "-1", "--format=%B", second.record.sha!])
      expect(body).toContain(`Replaces: ${first.record.sha!}`)
    })
  })

  it("stuck: a check that exits 2 stops the run, bills nobody, and is an ending of its own", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(await w.options({ exit: 2 }))

    expect(outcome.exitCode).toBe(2)
    expect(outcome.stuck).toEqual(["task/one"])
    expect(await remoteTarget(w)).toBe(w.target)
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/main/*:refs/yrd/main/*"])
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked", "stuck", "sent"])
    const incident = incidentOf(records[2])
    expect(incident).toMatchObject({
      Code: "yrd-check-unresolved",
      Subject: expect.stringContaining("verify"),
      Via: expect.stringContaining(outcome.run),
    })
    expect(isAbsolute(incident.Evidence)).toBe(true)
    expect(existsSync(incident.Evidence)).toBe(true)
    expect(incident.Next).toContain("yrd queue run")
    expect(records[2]?.trailers.filter(([name]) => name === "Reason" || name === "Fault" || name === "Cause")).toEqual(
      [],
    )
    expect(records[3]?.trailers).toEqual(
      expect.arrayContaining([
        ["To", "recorder"],
        ["State", "stuck"],
      ]),
    )
    expect(incidentOf(records[3])).toEqual(incident)
    expect(messages(w)[0]).toMatchObject({
      change: changeName({ branch: "task/one", head }),
      record: "stuck",
      log: expect.stringContaining("verify.log"),
      reason: expect.stringContaining("could not judge task/one"),
    })
    expect(messages(w)[0]?.failures).toBeUndefined()
  })

  it("git-super stuck preserves its worktree and carries complete failure evidence to the journal and supervisor", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/git-super-stuck", "git-super-stuck.txt")
    const bin = join(w.workdir, "bin")
    const invocationLog = join(w.workdir, "git-super-invocation.json")
    mkdirSync(bin, { recursive: true })
    const stderrTail = `hook stderr start\n${"checkout drift ".repeat(400)}\nhook stderr end`
    const detail = {
      code: "settled-merge-commit-failed",
      phase: "write-settled-merge",
      message: `settled-merge-commit-failed: the candidate merge could not be committed\n${stderrTail}`,
      subject: "the candidate merge could not be committed",
      evidence: `git -C ${w.work} status --short`,
      next: "repair the queue checkout, then run yrd queue run",
    }
    const result = {
      state: "failed",
      partial: true,
      detail,
      gitlinks: [],
      repositories: [{ repository: w.work, state: "failed", refs: [] }],
    }
    const fakeGitSuper = join(bin, "git-super")
    writeFileSync(
      fakeGitSuper,
      `#!/usr/bin/env bun\nimport { spawnSync } from "node:child_process"\nimport { writeFileSync } from "node:fs"\nconst hooksPath = spawnSync("git", ["config", "--get", "core.hooksPath"], { encoding: "utf8" }).stdout.trim()\nwriteFileSync(${JSON.stringify(invocationLog)}, JSON.stringify({ argv: process.argv.slice(2), hooksPath }))\nprocess.stdout.write(${JSON.stringify(`${JSON.stringify(result)}\n`)})\nprocess.exit(2)\n`,
    )
    chmodSync(fakeGitSuper, 0o755)
    const base = await w.options({ exit: 0 })

    const outcome = await queueRun({
      ...base,
      env: { ...base.env, PATH: `${bin}:${base.env?.PATH ?? process.env.PATH ?? ""}` },
    })

    expect(outcome).toMatchObject({ exitCode: 2, failed: [], merged: [], stuck: ["task/git-super-stuck"] })
    const composing = join(w.workdir, "worktrees", outcome.run, "compose", "submit", head.slice(0, 12))
    const hooksPath = join(w.workdir, "hooks-disabled")
    const invocation = JSON.parse(readFileSync(invocationLog, "utf8")) as {
      argv: string[]
      hooksPath: string
    }
    expect(invocation.argv).not.toContain("--no-verify")
    expect(invocation.hooksPath).toBe(hooksPath)
    expect(existsSync(hooksPath)).toBe(true)
    expect(readdirSync(hooksPath)).toEqual([])
    expect(existsSync(composing)).toBe(true)
    await fetchChanges(w)
    const records = await readRecords(
      w.git,
      (await refAt(w.git, changeRef("main", { branch: "task/git-super-stuck", head })))!,
    )
    const stuck = records.find((record) => record.kind === "stuck")
    const incident = incidentOf(stuck)
    expect(incident.Subject).toContain("hook stderr start")
    expect(incident.Subject).toContain("hook stderr end")
    expect(incident.Subject).toContain("checkout drift ".repeat(400).trim())
    expect(incident.Via).toContain(composing)
    const journal = logRecords(outcome).find(
      (record) => record.kind === "change" && record.decision === "stuck" && record.branch === "task/git-super-stuck",
    )
    expect(journal).toMatchObject({
      code: incident.Code,
      diagnosisCode: detail.code,
      subject: incident.Subject,
      via: incident.Via,
      evidence: incident.Evidence,
      next: incident.Next,
      detail: detail.message,
      worktree: composing,
    })
    expect(messages(w)[0]).toMatchObject({
      change: changeName({ branch: "task/git-super-stuck", head }),
      record: "stuck",
      reason: incident.Subject,
    })
    expect(messages(w)[0]?.reason).toContain("hook stderr end")
  })

  it("runs every notify entry that wants this ending, once each, and writes one sent record per entry", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    // Two entries want `merged`; a third wants only `stuck` and must not run.
    const outcome = await queueRun({
      ...(await w.options({ exit: 0 })),
      notify: [
        { name: "submitter", on: ["merged", "failed"], run: `${w.notifier} submitter` },
        { name: "board", on: ["merged"], run: `${w.notifier} board` },
        { name: "supervisor", on: ["stuck"], run: `${w.notifier} supervisor` },
      ],
    })

    expect(outcome.merged).toEqual(["task/one"])
    expect(messages(w).map((message) => message.record)).toEqual(["merged", "merged"])
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/main/*:refs/yrd/main/*"])
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked", "merged", "sent", "sent"])
    // One sent record per entry, each naming the entry it is about.
    expect(records.slice(-2).map((record) => trailer(record, "To"))).toEqual(["submitter", "board"])
    expect(records.slice(-2).map((record) => trailer(record, "Delivery"))).toEqual(["sent", "sent"])
    const merged = records[2]
    const firstSent = records[3]
    const secondSent = records[4]
    if (merged === undefined || firstSent === undefined || secondSent === undefined) throw new Error("missing record")
    expect(records.slice(-2).map((record) => trailer(record, "For"))).toEqual([merged.sha, merged.sha])
    expect(records.slice(-2).map((record) => trailer(record, "Message-Id"))).toEqual([merged.sha, merged.sha])
    expect((await w.git(["rev-parse", `${firstSent.sha}^`])).trim()).toBe(merged.sha)
    expect((await w.git(["rev-parse", `${secondSent.sha}^`])).trim()).toBe(firstSent.sha)
  })

  it("two refused sent appends leave both notifier results visibly unrecorded without guessing a parent", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const ref = changeRef("main", { branch: "task/one", head })
    const rivalPath = join(w.workdir, "..", "sent-record-rival")
    await gitIn(join(w.workdir, ".."))(["clone", "--quiet", w.remote, rivalPath])
    const rival = gitIn(rivalPath)
    await rival(["config", "user.email", "rival@yrd.test"])
    await rival(["config", "user.name", "rival"])

    let mergePushed = false
    const attempted: string[] = []
    const competing: string[] = []
    using _publication = beforeGitomicPublish(async (_repo, updates, remote) => {
      if (remote === undefined) return
      if (updates.some((update) => update.ref === "refs/heads/main")) mergePushed = true
      const update = updates.find((candidate) => candidate.ref === ref)
      if (!mergePushed || update?.oid === null || update?.oid === undefined) return
      if ((await recordKindOf(w.git, update.oid)) !== "sent") return
      attempted.push(update.oid)
      await rival(["fetch", "--quiet", "origin", `${ref}:${ref}`])
      const competingRecord = await appendRecord(rival, "main", {
        change: { branch: "task/one", head },
        kind: "stuck",
        subject: `rival sent append ${String(competing.length + 1)}`,
        trailers: RIVAL_STUCK_TRAILERS,
      })
      await rival(["push", "--quiet", "origin", `${competingRecord}:${ref}`])
      competing.push(competingRecord)
    })

    const outcome = await queueRun({
      ...(await w.options({ exit: 0 })),
      notify: [
        { name: "first", on: ["merged"], run: w.notifier },
        { name: "second", on: ["merged"], run: w.notifier },
      ],
    })

    expect(messages(w)).toHaveLength(2)
    expect(attempted).toHaveLength(2)
    expect(competing).toHaveLength(2)
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, ref))!)
    const merged = records.find((record) => record.kind === "merged")
    if (merged === undefined) throw new Error("missing merged record")
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked", "merged", "stuck", "stuck"])
    expect(records.slice(-2).map((record) => record.sha)).toEqual(competing)
    const rows = logRecords(outcome).filter((record) => record.kind === "message")
    expect(rows.map(({ delivered, id, to }) => ({ delivered, id, to }))).toEqual([
      { delivered: false, id: merged.sha, to: "first" },
      { delivered: false, id: merged.sha, to: "second" },
    ])
    expect(rows.map((row) => row.error)).toEqual([
      expect.stringContaining("after its append contended"),
      expect.stringContaining("after a prior sent append contended"),
    ])
  })

  it("an ending nobody wants records none once, and a newly declared recipient is still owed", async () => {
    // Silence and "nobody was told" read the same in a log that writes nothing,
    // so the queue writes the second one down.
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    await queueRun({
      ...(await w.options({ exit: 0 })),
      notify: [{ name: "supervisor", on: ["stuck"], run: w.notifier }],
    })

    expect(messages(w)).toEqual([])
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/main/*:refs/yrd/main/*"])
    const ref = changeRef("main", { branch: "task/one", head })
    const records = await readRecords(w.git, (await refAt(w.git, ref))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked", "merged", "sent"])
    expect(records.at(-1)?.trailers).toEqual(
      expect.arrayContaining([
        ["To", "none"],
        ["Delivery", "none"],
        ["State", "merged"],
      ]),
    )
    const [merged, none] = [records[2]!, records[3]!]
    // An unchanged declaration neither sends nor records `none` a second time.
    const unchanged = await queueRun({
      ...(await w.options({ exit: 0 })),
      notify: [{ name: "supervisor", on: ["stuck"], run: w.notifier }],
    })
    expect(logRecords(unchanged).filter((record) => record.kind === "message")).toEqual([])
    expect(await refAt(gitIn(w.remote), ref)).toBe(none.sha)
    // `none` describes the old declaration; a newly wanted recipient is owed E.
    const added = await queueRun({
      ...(await w.options({ exit: 0 })),
      notify: [{ name: "recorder", on: ["merged"], run: w.notifier }],
    })
    expect(
      logRecords(added)
        .filter((record) => record.kind === "message")
        .map(({ delivered, id, to }) => ({ delivered, id, to })),
    ).toEqual([{ delivered: true, id: merged.sha, to: "recorder" }])
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/main/*:refs/yrd/main/*"])
    const receipt = (await readRecords(w.git, (await refAt(w.git, ref))!)).at(-1)!
    expect(receipt.kind).toBe("sent")
    expect(["To", "Delivery", "For", "Message-Id"].map((name) => trailer(receipt, name))).toEqual([
      "recorder",
      "sent",
      merged.sha,
      merged.sha,
    ])
    expect((await w.git(["rev-parse", `${receipt.sha}^`])).trim()).toBe(none.sha)
  })

  it("a check past its bound is stuck, not the submitter's", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(await w.options({ sleep: 3, timeoutMs: 500 }))

    expect(outcome.exitCode).toBe(2)
    expect(String(logRecords(outcome).find((record) => record.kind === "message")?.text)).toMatch(
      /ran past its bound.*log named no usable YRD-CHECK-RESULT/u,
    )
  })

  it("a stuck change that sticks again on resume stops the line again, counted", async () => {
    // Specimen (24623): three yrd-check-unresolved rounds in a row on one head.
    // Those rounds came from the loop that re-ran a stuck change every round,
    // and a guard ended the second identical unresolved check failed without
    // running it. The andon (operator 2026-09-16) removed the loop, and the
    // guard with it: a stuck change is judged again only when someone resumes
    // the line, it runs its check again, and if it sticks again the line stops
    // again with both stuck records on the change.
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const options = await w.options({ sleep: 3, timeoutMs: 500 })

    const first = await queueRun(options)
    expect(first).toMatchObject({ exitCode: 2, failed: [], stuck: ["task/one"] })

    await writePause(w.git, "origin", "main", { by: "@chief", kind: "resumed", reason: "the check's bound was raised" })
    const second = await queueRun(options)

    expect(second).toMatchObject({ exitCode: 2, failed: [], stuck: ["task/one"] })
    // Judged, not retired from the reading: the check ran again in this round.
    expect(logRecords(second)).toContainEqual(
      expect.objectContaining({ branch: "task/one", kind: "check", name: "verify" }),
    )
    const kinds = (await recordsOf(w, "task/one", head)).map((record) => record.kind)
    expect(kinds).not.toContain("failed")
    expect(kinds.filter((kind) => kind === "stuck")).toHaveLength(2)
    expect(await readPause(w.git, "origin", "main")).toMatchObject({
      cause: "stuck",
      change: { branch: "task/one", head },
      kind: "paused",
    })
  })

  it("a timeout names the last YRD-CHECK-PROGRESS instead of only the bound constant (24623)", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")
    const check = join(w.workdir, "progress-then-hang.sh")
    writeFileSync(
      check,
      ["#!/bin/sh", `echo 'YRD-CHECK-PROGRESS {"stage":"candidate-config","files":838}'`, "sleep 3", "exit 0", ""].join(
        "\n",
      ),
    )
    chmodSync(check, 0o755)
    const base = await w.options({ timeoutMs: 500 })

    const outcome = await queueRun({
      ...base,
      checks: [{ ...base.checks[0]!, run: check, timeoutMs: 500 }],
    })

    expect(outcome.exitCode).toBe(2)
    expect(outcome.stuck).toEqual(["task/one"])
    expect(String(logRecords(outcome).find((record) => record.kind === "message")?.text)).toMatch(
      /last progress stage=candidate-config files=838/u,
    )
  })

  it("a malformed YRD-CHECK-RESULT on timeout is stuck, not rescued (24623)", async () => {
    using err = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")
    const check = join(w.workdir, "malformed-then-hang.sh")
    writeFileSync(check, ["#!/bin/sh", "echo 'YRD-CHECK-RESULT {not json}'", "sleep 3", "exit 0", ""].join("\n"))
    chmodSync(check, 0o755)
    const base = await w.options({ timeoutMs: 500 })

    const outcome = await queueRun({
      ...base,
      checks: [{ ...base.checks[0]!, run: check, timeoutMs: 500 }],
    })

    expect(outcome.exitCode).toBe(2)
    expect(outcome.stuck).toEqual(["task/one"])
    expect(outcome.merged).toEqual([])
    expect(String(logRecords(outcome).find((record) => record.kind === "message")?.text)).toMatch(
      /log named no usable YRD-CHECK-RESULT/u,
    )
    expect(err).toHaveBeenCalledWith(
      "YRD-CHECK-RESULT is unreadable; not treating it as a verdict:",
      expect.stringContaining("JSON Parse error"),
    )
  })

  it("a YRD-CHECK-RESULT naming exit 3 on timeout is stuck, not rescued as a fail (@cto 7645ec3a)", async () => {
    using err = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")
    const check = join(w.workdir, "cannot-judge-then-hang.sh")
    writeFileSync(check, ["#!/bin/sh", `echo 'YRD-CHECK-RESULT {"exit":3}'`, "sleep 3", "exit 0", ""].join("\n"))
    chmodSync(check, 0o755)
    const base = await w.options({ timeoutMs: 500 })

    const outcome = await queueRun({
      ...base,
      checks: [{ ...base.checks[0]!, run: check, timeoutMs: 500 }],
    })

    expect(outcome).toMatchObject({ exitCode: 2, failed: [], merged: [], stuck: ["task/one"] })
    expect(err).toHaveBeenCalledWith(
      "YRD-CHECK-RESULT named neither pass nor fail (exit 0 or 1); not treating it as a verdict",
    )
  })

  it.each([
    ["pass", "pass", 0, ["opened", "checked", "merged", "sent"]],
    ["fail", "fail", 1, ["opened", "checked", "failed", "sent"]],
  ] as const)(
    "a %s comparison that finished before the bound is the round's result, not yrd-check-unresolved (24623)",
    async (label, result, exit, kinds) => {
      // Specimen q-20260916T050857704Z-35569921: the protected comparison printed
      // NEW 0 / INHERITED 19 / FLAKE 0, then candidate-config kept running past
      // 1800000ms and the queue discarded the verdict as stuck. The check names
      // the computed result on its log the same way it already names a narrowing
      // offer; the bound must not throw that away.
      const w = await world()
      const head = await submitCommit(w, "task/one", "one.txt")
      const check = join(w.workdir, `finished-then-hang-${label}.sh`)
      writeFileSync(
        check,
        [
          "#!/bin/sh",
          'echo "affected-tests: NEW (candidate-attributable), 0 ids"',
          'echo "affected-tests: INHERITED (also red on base), 19 ids"',
          'echo "affected-tests: FLAKE (failed in exactly one of two candidate runs, not judged), 0 ids"',
          `echo 'YRD-CHECK-RESULT {"result":"${result}"}'`,
          "sleep 3",
          "exit 0",
          "",
        ].join("\n"),
      )
      chmodSync(check, 0o755)
      const base = await w.options({ timeoutMs: 500 })

      const outcome = await queueRun({
        ...base,
        checks: [{ ...base.checks[0]!, run: check, timeoutMs: 500 }],
      })

      expect(outcome.exitCode).toBe(exit)
      expect(outcome.stuck).toEqual([])
      if (result === "pass") {
        expect(outcome.merged).toEqual(["task/one"])
        expect(outcome.failed).toEqual([])
      } else {
        expect(outcome.failed).toEqual(["task/one"])
        expect(outcome.merged).toEqual([])
      }
      await fetchChanges(w)
      const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
      expect(records.map((record) => record.kind)).toEqual([...kinds])
      expect(trailer(records[2]!, "Check")).toMatch(result === "pass" ? /exit=0/u : /exit=1/u)
      expect(trailer(records[2]!, "Check")).not.toMatch(/exit=timeout/u)
      const again = await queueRun({
        ...base,
        checks: [{ ...base.checks[0]!, run: check, timeoutMs: 500 }],
      })
      expect(again.stuck).toEqual([])
      expect(again.merged).toEqual([])
      expect(again.failed).toEqual([])
    },
  )

  it("a deferred result writes the record, does not stop the line, and the next change in line is judged in the same round", async () => {
    const w = await world()
    const headOne = await submitCommit(w, "task/one", "one.txt")
    await submitCommit(w, "task/two", "two.txt")

    const check = join(w.workdir, "deferred-check.sh")
    writeFileSync(
      check,
      [
        "#!/bin/sh",
        'if git log -1 --format=%s "$YRD_CANDIDATE_SHA" | grep -q "task/one"; then',
        `  echo 'YRD-CHECK-RESULT {"result":"deferred","reason":"projection-exceeded","projectedMs":3480000,"boundMs":1800000}'`,
        "  exit 3",
        "else",
        "  exit 0",
        "fi",
        "",
      ].join("\n"),
    )
    chmodSync(check, 0o755)
    const base = await w.options({ timeoutMs: 1800000 })

    const outcome = await queueRun({
      ...base,
      checks: [{ ...base.checks[0]!, run: check, timeoutMs: 1800000 }],
    })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.stuck).toEqual([])
    expect(outcome.deferred).toEqual(["task/one"])
    expect(outcome.merged).toEqual(["task/two"])

    await fetchChanges(w)
    const refOne = changeRef("main", { branch: "task/one", head: headOne })
    const recordsOne = await readRecords(w.git, (await refAt(w.git, refOne))!)
    const deferredRec = recordsOne.find((r) => r.kind === "deferred")!
    expect(deferredRec).toBeDefined()
    expect(trailer(deferredRec, "Reason")).toBe("projection-exceeded")
    expect(trailer(deferredRec, "Phase")).toBe("merge")
    expect(trailer(deferredRec, "ProjectedMs")).toBe("3480000")
    expect(trailer(deferredRec, "BoundMs")).toBe("1800000")
    expect(trailer(deferredRec, "Projected")).toBeUndefined()
    expect(trailer(deferredRec, "Bound")).toBeUndefined()
    const lastOne = recordsOne.at(-1)!
    expect(lastOne.kind).toBe("sent")
    expect(trailer(lastOne, "State")).toBe("deferred")
    expect(trailer(lastOne, "ProjectedMs")).toBe("3480000")
    expect(trailer(lastOne, "BoundMs")).toBe("1800000")
  })

  it("a check that defers on submit writes Phase: submit trailer and defers before checked state", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/wide", "wide.txt")

    const check = join(w.workdir, "deferred-submit-check.sh")
    writeFileSync(
      check,
      [
        "#!/bin/sh",
        `echo 'YRD-CHECK-RESULT {"result":"deferred","reason":"projection-exceeded","projectedMs":3600000,"boundMs":1800000}'`,
        "exit 3",
        "",
      ].join("\n"),
    )
    chmodSync(check, 0o755)
    const base = await w.options({ timeoutMs: 1800000 })

    const outcome = await queueRun({
      ...base,
      checks: [{ ...base.checks[0]!, on: ["submit"] as const, run: check, timeoutMs: 1800000 }],
    })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.stuck).toEqual([])
    expect(outcome.deferred).toEqual(["task/wide"])
    expect(outcome.merged).toEqual([])

    await fetchChanges(w)
    const ref = changeRef("main", { branch: "task/wide", head })
    const records = await readRecords(w.git, (await refAt(w.git, ref))!)
    expect(records.map((r) => r.kind)).toEqual(["opened", "deferred", "sent"])
    const last = records.find((r) => r.kind === "deferred")!
    expect(trailer(last, "Phase")).toBe("submit")
    expect(trailer(last, "Reason")).toBe("projection-exceeded")
    expect(trailer(last, "ProjectedMs")).toBe("3600000")
    expect(trailer(last, "BoundMs")).toBe("1800000")
    expect(trailer(last, "Projected")).toBeUndefined()
    expect(trailer(last, "Bound")).toBeUndefined()
    const sent = records.at(-1)!
    expect(sent.kind).toBe("sent")
    expect(trailer(sent, "State")).toBe("deferred")
  })

  it("a deferred result notifies the submitter with projected and bound minutes and writes sent record", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/deferred-notify", "file.txt")
    const check = join(w.workdir, "deferred-notify-check.sh")
    writeFileSync(
      check,
      [
        "#!/bin/sh",
        `echo 'YRD-CHECK-RESULT {"result":"deferred","reason":"projection-exceeded","projectedMs":3480000,"boundMs":1800000}'`,
        "exit 3",
        "",
      ].join("\n"),
    )
    chmodSync(check, 0o755)
    const base = await w.options({ timeoutMs: 1800000 })
    const outcome = await queueRun({
      ...base,
      checks: [{ ...base.checks[0]!, on: ["submit"] as const, run: check, timeoutMs: 1800000 }],
      notify: [{ name: "recorder", on: ["deferred"], run: w.notifier }],
    })
    expect(outcome.deferred).toEqual(["task/deferred-notify"])
    const msgs = messages(w)
    expect(msgs.length).toBe(1)
    expect(msgs[0]).toMatchObject({
      change: `task/deferred-notify@${head}`,
      record: "deferred",
      reason: "projection-exceeded",
      projectedMs: 3480000,
      boundMs: 1800000,
    })
    await fetchChanges(w)
    const ref = changeRef("main", { branch: "task/deferred-notify", head })
    const records = await readRecords(w.git, (await refAt(w.git, ref))!)
    expect(records.map((r) => r.kind)).toEqual(["opened", "deferred", "sent"])
    const sent = records.at(-1)!
    expect(trailer(sent, "To")).toBe("recorder")
    expect(trailer(sent, "Delivery")).toBe("sent")
    expect(trailer(sent, "State")).toBe("deferred")
    expect(trailer(sent, "ProjectedMs")).toBe("3480000")
    expect(trailer(sent, "BoundMs")).toBe("1800000")
  })

  it("the long round takes the oldest deferred change, uses the long bound from configuration, merges on pass, records failed on fail", async () => {
    const w = await world()
    await submitCommit(w, "task/defer-one", "one.txt")
    await submitCommit(w, "task/defer-two", "two.txt")

    const deferCheck = join(w.workdir, "defer-check.sh")
    writeFileSync(
      deferCheck,
      [
        "#!/bin/sh",
        'if [ "$YRD_CHECK_TIER" = "long" ]; then',
        '  if git log -1 --format=%s "$YRD_CANDIDATE_SHA" | grep -q "task/defer-one"; then',
        "    exit 0",
        "  else",
        "    exit 1",
        "  fi",
        "else",
        `  echo 'YRD-CHECK-RESULT {"result":"deferred","reason":"projection-exceeded","projectedMs":3480000,"boundMs":1800000}'`,
        "  exit 3",
        "fi",
        "",
      ].join("\n"),
    )
    chmodSync(deferCheck, 0o755)

    const base = await w.options({ timeoutMs: 1800000 })
    const checkSpec: CheckSpec = {
      ...base.checks[0]!,
      on: ["submit", "merge"] as const,
      run: deferCheck,
      timeoutMs: 1800000,
      long: { timeoutMs: 5400000 },
    }

    // Normal round defers both changes
    const normalOutcome = await queueRun({
      ...base,
      checks: [checkSpec],
    })
    expect(normalOutcome.deferred).toEqual(["task/defer-one", "task/defer-two"])

    // Long round 1 runs oldest deferred change (task/defer-one), passes and merges it
    const longOutcome = await queueRun({
      ...base,
      checks: [checkSpec],
      tier: "long",
    })
    expect(longOutcome.exitCode).toBe(0)
    expect(longOutcome.merged).toEqual(["task/defer-one"])

    // Long round 2 runs remaining deferred change (task/defer-two), fails and records failed
    const longOutcomeTwo = await queueRun({
      ...base,
      checks: [checkSpec],
      tier: "long",
    })
    expect(longOutcomeTwo.exitCode).toBe(1)
    expect(longOutcomeTwo.failed).toEqual(["task/defer-two"])
  })

  it("a projection past the long bound is stuck and stops the line", async () => {
    const w = await world()
    await submitCommit(w, "task/too-long", "toolong.txt")

    const deferCheck = join(w.workdir, "long-defer-check.sh")
    writeFileSync(
      deferCheck,
      [
        "#!/bin/sh",
        `echo 'YRD-CHECK-RESULT {"result":"deferred","reason":"projection-exceeded","projectedMs":7200000,"boundMs":5400000}'`,
        "exit 3",
        "",
      ].join("\n"),
    )
    chmodSync(deferCheck, 0o755)

    const base = await w.options({ timeoutMs: 1800000 })
    const checkSpec: CheckSpec = {
      ...base.checks[0]!,
      on: ["submit", "merge"] as const,
      run: deferCheck,
      timeoutMs: 1800000,
      long: { timeoutMs: 5400000 },
    }

    // Normal round defers task/too-long
    await queueRun({ ...base, checks: [checkSpec] })

    // Long round on task/too-long exceeds bound -> ends stuck and stops the line
    const longOutcome = await queueRun({
      ...base,
      checks: [checkSpec],
      tier: "long",
    })
    expect(longOutcome.exitCode).toBe(2)
    expect(longOutcome.stuck).toEqual(["task/too-long"])
  })

  it("a deferred change holds no place in line; a new head returns it to normal", async () => {
    const w = await world()
    await submitCommit(w, "task/defer-retry", "one.txt")

    const deferCheck = join(w.workdir, "retry-defer-check.sh")
    writeFileSync(
      deferCheck,
      [
        "#!/bin/sh",
        "if [ -f retry.txt ]; then",
        "  exit 0",
        "else",
        `  echo 'YRD-CHECK-RESULT {"result":"deferred","reason":"projection-exceeded","projectedMs":3480000,"boundMs":1800000}'`,
        "  exit 3",
        "fi",
        "",
      ].join("\n"),
    )
    chmodSync(deferCheck, 0o755)

    const base = await w.options({ timeoutMs: 1800000 })
    const checkSpec: CheckSpec = {
      ...base.checks[0]!,
      on: ["submit", "merge"] as const,
      run: deferCheck,
      timeoutMs: 1800000,
    }

    // Normal round defers task/defer-retry
    const normalOutcome = await queueRun({ ...base, checks: [checkSpec] })
    expect(normalOutcome.deferred).toEqual(["task/defer-retry"])

    // Verify it holds no place in line
    await fetchChanges(w)
    const read = await readQueue(w.git, "origin", "main", await remoteTarget({ git: w.git }))
    const entry = read.changes.find((e) => e.change.branch === "task/defer-retry")!
    expect(entry.reading.state).toBe("deferred")
    expect(holdsPlaceInLine(entry.reading.state)).toBe(false)

    // A new head is pushed to the branch and submitted
    await w.git(["checkout", "--quiet", "task/defer-retry"])
    writeFileSync(join(w.work, "retry.txt"), "retry\n")
    await w.git(["add", "retry.txt"])
    await w.git(["commit", "--quiet", "-m", "task/defer-retry: retry"])
    await w.git(["checkout", "--quiet", "main"])
    await submit(w.git, "origin", {
      branch: "task/defer-retry",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
      issue: "@i/10-yrd/1",
    })
    // Now normal round checks the new head and it merges
    const retryOutcome = await queueRun({ ...base, checks: [checkSpec] })
    expect(retryOutcome.exitCode).toBe(0)
    expect(retryOutcome.merged).toEqual(["task/defer-retry"])
  })

  it("stop starting new checks after stopAtMs, leaving remaining changes deferred", async () => {
    const w = await world()
    await submitCommit(w, "task/defer-timeout", "timeout.txt")

    const deferCheck = join(w.workdir, "stop-defer-check.sh")
    writeFileSync(
      deferCheck,
      [
        "#!/bin/sh",
        `echo 'YRD-CHECK-RESULT {"result":"deferred","reason":"projection-exceeded","projectedMs":3480000,"boundMs":1800000}'`,
        "exit 3",
        "",
      ].join("\n"),
    )
    chmodSync(deferCheck, 0o755)

    const base = await w.options({ timeoutMs: 1800000 })
    const checkSpec: CheckSpec = {
      ...base.checks[0]!,
      on: ["submit", "merge"] as const,
      run: deferCheck,
      timeoutMs: 1800000,
      long: { timeoutMs: 5400000 },
    }

    // Defer task/defer-timeout
    await queueRun({ ...base, checks: [checkSpec] })

    // Long round with stopAtMs in the past: stops starting new checks immediately
    const longOutcome = await queueRun({
      ...base,
      checks: [checkSpec],
      tier: "long",
      stopAtMs: Date.now() - 1000,
    })
    expect(longOutcome.exitCode).toBe(0)
    expect(longOutcome.merged).toEqual([])
    expect(longOutcome.failed).toEqual([])
    expect(longOutcome.stuck).toEqual([])
  })

  it("stop starting merge checks when stopAtMs passes during submit checking in long tier", async () => {
    const w = await world()
    await submitCommit(w, "task/defer-mid-flight", "mid.txt")

    const submitRanFlag = join(w.workdir, "submit-ran.flag")
    const phaseLog = join(w.workdir, "phases-executed.log")
    const checkScript = join(w.workdir, "timed-check.sh")
    writeFileSync(
      checkScript,
      [
        "#!/bin/sh",
        `echo "$YRD_CHECK_TIER" >> "${phaseLog}"`,
        'if [ "$YRD_CHECK_TIER" = "normal" ]; then',
        `  echo 'YRD-CHECK-RESULT {"result":"deferred","reason":"projection-exceeded","projectedMs":3480000,"boundMs":1800000}'`,
        "  exit 3",
        "fi",
        `touch "${submitRanFlag}"`,
        `echo 'YRD-CHECK-RESULT {"result":"pass","exit":0}'`,
        "exit 0",
        "",
      ].join("\n"),
    )
    chmodSync(checkScript, 0o755)

    const base = await w.options({ timeoutMs: 1800000 })
    const checkSpec: CheckSpec = {
      ...base.checks[0]!,
      on: ["submit", "merge"] as const,
      run: checkScript,
      timeoutMs: 1800000,
      long: { timeoutMs: 5400000 },
    }

    // 1. Normal round defers task/defer-mid-flight
    const normalOutcome = await queueRun({ ...base, checks: [checkSpec] })
    expect(normalOutcome.deferred).toEqual(["task/defer-mid-flight"])

    // 2. Long round with controlled clock:
    // Clock starts at t0 = 1000, deadline is t = 2000.
    // When judge runs submit check, it creates submitRanFlag so now() returns 3000 >= deadline.
    const deadline = 2000
    const longOutcome = await queueRun({
      ...base,
      checks: [checkSpec],
      tier: "long",
      stopAtMs: deadline,
      now: () => (existsSync(submitRanFlag) ? 3000 : 1000),
    })

    // Assertions for R16:
    // - Merge checking was NOT started
    expect(longOutcome.exitCode).toBe(0)
    expect(longOutcome.merged).toEqual([])
    expect(longOutcome.deferred).toEqual(["task/defer-mid-flight"])

    // Check tiers executed: normal ran once (submit), long ran once (submit), merge NEVER ran
    const phases = readFileSync(phaseLog, "utf8").trim().split("\n")
    expect(phases).toEqual(["normal", "long"])

    // Inspect change records:
    await fetchChanges(w)
    const queueState = await readQueue(w.git, "origin", "main", await remoteTarget({ git: w.git }))
    const changeEntry = queueState.changes.find((e) => e.change.branch === "task/defer-mid-flight")!
    expect(changeEntry.reading.state).toBe("deferred")

    const ref = changeRef("main", changeEntry.change)
    const records = await readRecords(w.git, (await refAt(w.git, ref))!)
    const deferredRec = records.filter((r) => r.kind === "deferred").at(-1)!
    expect(deferredRec).toBeDefined()
    expect(deferredRec.subject).toContain("stop time reached before on-merge checks completed")
    expect(deferredRec.subject).not.toContain("projection exceeded normal bound")
    expect(trailer(deferredRec, "Reason")).toBe("stop-time")
    expect(trailer(deferredRec, "Phase")).toBe("merge")

    // 3. Resumption: subsequent long round with open stop window completes and merges
    rmSync(submitRanFlag, { force: true })
    const resumedOutcome = await queueRun({
      ...base,
      checks: [checkSpec],
      tier: "long",
      stopAtMs: 10000,
      now: () => 4000,
    })
    expect(resumedOutcome.exitCode).toBe(0)
    expect(resumedOutcome.merged).toEqual(["task/defer-mid-flight"])

    const finalPhases = readFileSync(phaseLog, "utf8").trim().split("\n")
    expect(finalPhases).toEqual(["normal", "long", "long", "long"])
  })

  it("stops starting subsequent checks when stopAtMs passes during multi-check phase", async () => {
    const w = await world()
    await submitCommit(w, "task/multi-check-timeout", "multi.txt")

    const flagFile = join(w.workdir, "check-a-ran.flag")
    const logA = join(w.workdir, "checkA.log")
    const logB = join(w.workdir, "checkB.log")

    const scriptA = join(w.workdir, "check-a.sh")
    writeFileSync(
      scriptA,
      [
        "#!/bin/sh",
        `echo ranA >> "${logA}"`,
        `touch "${flagFile}"`,
        `echo 'YRD-CHECK-RESULT {"result":"pass","exit":0}'`,
        "exit 0",
        "",
      ].join("\n"),
    )
    chmodSync(scriptA, 0o755)

    const scriptB = join(w.workdir, "check-b.sh")
    writeFileSync(
      scriptB,
      ["#!/bin/sh", `echo ranB >> "${logB}"`, `echo 'YRD-CHECK-RESULT {"result":"pass","exit":0}'`, "exit 0", ""].join(
        "\n",
      ),
    )
    chmodSync(scriptB, 0o755)

    const base = await w.options({ timeoutMs: 1800000 })
    const checkA: CheckSpec = {
      ...base.checks[0]!,
      name: "checkA",
      on: ["submit"] as const,
      run: scriptA,
    }
    const checkB: CheckSpec = {
      ...base.checks[0]!,
      name: "checkB",
      on: ["submit"] as const,
      run: scriptB,
    }

    const deadline = 2000
    const outcome = await queueRun({
      ...base,
      checks: [checkA, checkB],
      stopAtMs: deadline,
      now: () => (existsSync(flagFile) ? 3000 : 1000),
    })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.deferred).toEqual(["task/multi-check-timeout"])
    expect(existsSync(logA)).toBe(true)
    expect(existsSync(logB)).toBe(false)

    await fetchChanges(w)
    const queueState = await readQueue(w.git, "origin", "main", await remoteTarget({ git: w.git }))
    const changeEntry = queueState.changes.find((e) => e.change.branch === "task/multi-check-timeout")!
    expect(changeEntry.reading.state).toBe("deferred")

    const ref = changeRef("main", changeEntry.change)
    const records = await readRecords(w.git, (await refAt(w.git, ref))!)
    const deferredRec = records.find((r) => r.kind === "deferred")!
    expect(deferredRec).toBeDefined()
    expect(trailer(deferredRec, "Reason")).toBe("stop-time")
    // checkA passed and is recorded; unstarted checkB is NOT recorded
    const checkTrailers = deferredRec.trailers.filter(([k]) => k === "Check").map(([, v]) => v)
    expect(checkTrailers.some((v) => v.startsWith("checkA"))).toBe(true)
    expect(checkTrailers.some((v) => v.startsWith("checkB"))).toBe(false)
  })

  it("two checked changes, the first fails at merge, the second is not judged in that round", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")
    const headTwo = await submitCommit(w, "task/two", "two.txt")

    const check = join(w.workdir, "merge-fail-check.sh")
    writeFileSync(
      check,
      ["#!/bin/sh", 'if [ -f "one.txt" ]; then', "  exit 1", "else", "  exit 0", "fi", ""].join("\n"),
    )
    chmodSync(check, 0o755)
    const base = await w.options({ timeoutMs: 1800000 })
    const outcome = await queueRun({
      ...base,
      checks: [{ ...base.checks[0]!, on: ["merge"] as const, run: check, timeoutMs: 1800000 }],
    })

    expect(outcome.failed).toEqual(["task/one"])
    expect(outcome.merged).toEqual([])
    expect(outcome.deferred).toEqual([])

    await fetchChanges(w)
    const refTwo = changeRef("main", { branch: "task/two", head: headTwo })
    const recordsTwo = await readRecords(w.git, (await refAt(w.git, refTwo))!)
    expect(recordsTwo.map((r) => r.kind)).toEqual(["opened", "checked"])
  })

  it("a check declaring a scripts: path the target does not carry is loud: the change ends stuck and names it (D5)", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const base = await w.options({ on: ["submit"] })

    const outcome = await queueRun({
      ...base,
      checks: base.checks.map((check) => ({ ...check, programRoot: true, scripts: ["checks/absent.sh"] })),
    })

    // A check the queue cannot restore from the protected side is the queue's
    // own ground missing, never the submitter's: stuck, and nobody is billed.
    expect(outcome.exitCode).toBe(2)
    expect(outcome.stuck).toEqual(["task/one"])
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "stuck", "sent"])
    expect(records[1]?.subject).toContain("checks/absent.sh")
    expect(messages(w)[0]).toMatchObject({ record: "stuck" })
    expect(String(logRecords(outcome).find((record) => record.kind === "message")?.text)).toContain("does not carry")
  })

  it("POSITIVE CONTROL: a declared scripts: path the target does carry is restored and judged (D5)", async () => {
    // Without this, the loud case above is satisfied just as well by a
    // `scripts:` list that can never be restored at all.
    const w = await world()
    const base = await w.options({ exit: 0, on: ["submit"] })
    await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun({
      ...base,
      checks: base.checks.map((check) => ({ ...check, scripts: [".yrd.yml"] })),
    })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/one"])
  })

  /**
   * @failure target setup could rewrite source or move HEAD after generic
   * preparation, leaving an opted-in child to judge bytes or identity no
   * recorded commit describes.
   * @level L3 real queue integration: this crosses the actual worktree/setup and
   * child-run boundary; a fake Git store could not prove cleanup or identity.
   * @consumer queue checks reject a P/C root that target setup changed before runCheck.
   */
  it.each(["source", "head", "deleted"] as const)(
    "removes both fresh roots when target setup mutates candidate %s state",
    async (mode) => {
      const w = await world()
      writeFileSync(join(w.work, "program.sh"), "exit 0\n")
      writeFileSync(join(w.work, ".gitignore"), "program.sh\n")
      await w.git(["add", ".gitignore"])
      await w.git(["add", "-f", "program.sh"])
      await w.git(["commit", "--quiet", "-m", "target program"])
      await w.git(["push", "--quiet", "origin", "main"])
      const target = (await w.git(["rev-parse", "main"])).trim()
      if (mode === "deleted") {
        await w.git(["checkout", "--quiet", "-b", "task/program", "main"])
        await w.git(["rm", "--quiet", "program.sh"])
        await w.git(["commit", "--quiet", "-m", "delete program"])
        await w.git(["checkout", "--quiet", "main"])
        await submit(w.git, "origin", {
          branch: "task/program",
          submitter: "@dev/2",
          target: { branch: "main", remote: "origin" },
          issue: "@i/10-yrd/1",
        })
      } else {
        await submitCommit(w, "task/program", "program.sh")
      }
      const setup = join(w.workdir, `mutate-${mode}.sh`)
      writeFileSync(
        setup,
        [
          "#!/bin/sh",
          'if [ "$YRD_CANDIDATE_SHA" = "$1" ]; then exit 0; fi',
          mode === "head"
            ? 'printf "moved\\n" > moved-by-setup.txt && git add moved-by-setup.txt && git -c user.email=queue@yrd.test -c user.name=yrd commit --quiet -m moved-by-setup'
            : 'printf "mutated\\n" > program.sh',
          "",
        ].join("\n"),
      )
      chmodSync(setup, 0o755)
      const base = await w.options({ exit: 0, on: ["submit"], setup: `${setup} ${target}` })
      const outcome = await queueRun({
        ...base,
        checks: base.checks.map((check) => ({
          ...check,
          programRoot: true,
          run: 'sh "$YRD_PROGRAM_ROOT/program.sh"',
          scripts: ["program.sh"],
        })),
      })

      expect(outcome.exitCode).toBe(2)
      const rejected = logRecords(outcome).find(
        (record) =>
          record.kind === "judged" &&
          record.stage === (mode === "head" ? "program-subject-tree" : "program-subject-source") &&
          record.same === false,
      )
      expect(rejected).toMatchObject({ name: "verify", phase: "submit" })
      const freshRoots = [
        ...new Set(
          logRecords(outcome)
            .filter(
              (record) =>
                record.kind === "judged" && typeof record.stage === "string" && record.stage.startsWith("program-"),
            )
            .map((record) => record.root)
            .filter((root): root is string => typeof root === "string"),
        ),
      ]
      expect(freshRoots).toHaveLength(2)
      for (const root of freshRoots) expect(existsSync(root)).toBe(false)
    },
  )

  it("a check whose child exits 0 while a descendant holds its output open is stuck, not pass", async () => {
    // The live wedge shape: `sh` exits 0 immediately and the backgrounded sleep
    // inherits the run's stdout, so the driver abandons the drain at its grace
    // and hands back exit 0 with a partial log. Read as an exit code alone,
    // that is a pass on a check nobody measured.
    using warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const base = await w.options({ on: ["submit"] })

    const outcome = await queueRun({
      ...base,
      checks: base.checks.map((check) => ({ ...check, run: "sleep 30 & exit 0" })),
    })

    expect(outcome.exitCode).toBe(2)
    expect(outcome.stuck).toEqual(["task/one"])
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "stuck", "sent"])
    const wedged = records[1]
    if (wedged === undefined) throw new Error("no stuck record")
    expect(wedged.subject).toContain("held its output open")
    // The condition is named, and so is the partial log the check did write.
    const check = trailers(wedged, "Check")[0] ?? ""
    expect(check).toContain("exit=unsettled")
    expect(existsSync(check.match(/log=(\S+)/u)?.[1] ?? "")).toBe(true)
    expect(warning).toHaveBeenCalledTimes(1)
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("yrd:process"),
      expect.stringContaining("a child process kept its output open"),
      expect.objectContaining({ argv: ["sh", "-c", "sleep 30 & exit 0"], pid: expect.any(Number) }),
    )
  }, 30_000)

  it("the target moving between the merge reading and the lease keeps the change checked, not stuck (D4)", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const rivalPath = join(w.workdir, "..", "target-mover")
    await gitIn(join(w.workdir, ".."))(["clone", "--quiet", w.remote, rivalPath])
    const rival = gitIn(rivalPath)
    await rival(["config", "user.email", "rival@yrd.test"])
    await rival(["config", "user.name", "rival"])

    let moved: string | undefined
    using _publication = beforeGitomicPublish(async (_repo, updates, remote) => {
      // The window the lease exists for: the run has read the remote heads and
      // is about to publish, and somebody else merges onto the target in between.
      if (remote !== undefined && moved === undefined && updates.some((update) => update.ref === "refs/heads/main")) {
        writeFileSync(join(rivalPath, "rival.txt"), "rival\n")
        await rival(["add", "rival.txt"])
        await rival(["commit", "--quiet", "-m", "the target moved under the change"])
        await rival(["push", "--quiet", "origin", "main"])
        moved = (await rival(["rev-parse", "HEAD"])).trim()
      }
    })

    const outcome = await queueRun(await w.options({ exit: 0 }))

    // The change keeps its place and is judged again at the new target next
    // run: nothing merged, nothing ended, and nobody was told anything.
    expect(outcome.exitCode).toBe(0)
    expect(outcome.stuck).toEqual([])
    expect(outcome.merged).toEqual([])
    expect(await remoteTarget(w)).toBe(moved)
    await fetchChanges(w)
    expect(
      (await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)).map(
        (record) => record.kind,
      ),
    ).toEqual(["opened", "checked"])
    expect(messages(w)).toEqual([])
    expect(logRecords(outcome)).toContainEqual(
      expect.objectContaining({ decision: "checked", reason: "target-moved", saw: moved }),
    )
  })

  it("a change tip moving before the atomic merge loses neither history nor the target", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const ref = changeRef("main", { branch: "task/one", head })
    const rivalPath = join(w.workdir, "..", "change-tip-mover")
    await gitIn(join(w.workdir, ".."))(["clone", "--quiet", w.remote, rivalPath])
    const rival = gitIn(rivalPath)
    await rival(["config", "user.email", "rival@yrd.test"])
    await rival(["config", "user.name", "rival"])

    let expected = ""
    let moved: string | undefined
    using _publication = beforeGitomicPublish(async (_repo, updates, remote) => {
      if (remote !== undefined && moved === undefined && updates.some((update) => update.ref === "refs/heads/main")) {
        expected = (await rival(["ls-remote", "--refs", "origin", ref])).trim().split(/\s+/u)[0] ?? ""
        await rival(["fetch", "--quiet", "origin", `${ref}:${ref}`])
        moved = await appendRecord(rival, "main", {
          change: { branch: "task/one", head },
          kind: "stuck",
          subject: "another queue got there first",
          trailers: RIVAL_STUCK_TRAILERS,
        })
        await rival(["push", "--quiet", "origin", `${moved}:${ref}`])
      }
    })

    const outcome = await queueRun(await w.options({ exit: 0 }))

    expect(moved).toBeDefined()
    expect(outcome.merged).toEqual([])
    expect(await remoteTarget(w)).toBe(w.target)
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, ref))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked", "stuck"])
    expect(records.at(-1)?.sha).toBe(moved)
    expect(logRecords(outcome)).toContainEqual(
      expect.objectContaining({ decision: "checked", expected, reason: "change-ref-moved", saw: moved }),
    )
  })

  it("a pause leaves admitted work queued without checks, and resume lets the next run merge it", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const paused = await writePause(w.git, "origin", "main", {
      by: "@chief",
      kind: "paused",
      reason: "main needs repair",
    })

    const held = await queueRun(await w.options({ exit: 0 }))

    expect(held.exitCode).toBe(0)
    expect(held.stopped?.what).toEqual(paused)
    expect(held.merged).toEqual([])
    expect(await remoteTarget(w)).toBe(w.target)
    await fetchChanges(w)
    expect(
      (await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)).map(
        (record) => record.kind,
      ),
    ).toEqual(["opened"])
    expect(logRecords(held)).toContainEqual(
      expect.objectContaining({ by: "@chief", kind: "pause", reason: "main needs repair", state: "paused" }),
    )

    await writePause(w.git, "origin", "main", { by: "@chief", kind: "resumed", reason: "repair merged" })
    const resumed = await queueRun(await w.options({ exit: 0 }))
    expect(resumed.merged).toEqual(["task/one"])
  })

  it("a foreground run merges admitted work with fresh fences and preserves the original pause facts", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")
    await submitCommit(w, "task/two", "two.txt")
    const dated = gitIn(
      w.work,
      createProcess({
        cwd: w.work,
        env: gitEnvironment({
          ...process.env,
          GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
        }),
      }),
    )
    const paused = await writePause(dated, "origin", "main", {
      by: "@chief",
      kind: "paused",
      reason: "inspect admitted set",
    })

    const outcome = await queueRun({ ...(await w.options({ exit: 0 })), foreground: true })

    expect(outcome.merged).toEqual(["task/one"])
    expect(outcome.stopped).toBeUndefined()
    const next = await queueRun({ ...(await w.options({ exit: 0 })), foreground: true })
    expect(next.merged).toEqual(["task/two"])
    const after = await readPause(w.git, "origin", "main")
    expect(after).toMatchObject({ at: paused.at, by: paused.by, reason: paused.reason, kind: "paused" })
    expect(after?.sha).not.toBe(paused.sha)
    expect((await w.git(["rev-list", "--count", `${paused.sha}..${after?.sha}`])).trim()).toBe("2")
    expect(logRecords(outcome)).toContainEqual(
      expect.objectContaining({
        kind: "pause",
        reason: paused.reason,
        by: paused.by,
        since: paused.at.toISOString(),
        state: "paused",
      }),
    )
    const automatic = await queueRun(await w.options({ exit: 0 }))
    expect(automatic.stopped?.what).toEqual(after)
  })

  it.each(["before-fence", "before-push"])(
    "a changed pause %s stops a foreground merge and preserves all remote refs",
    async (when) => {
      const w = await world()
      const head = await submitCommit(w, "task/one", "one.txt")
      await writePause(w.git, "origin", "main", { by: "@chief", kind: "paused", reason: "initial pause" })
      const ref = changeRef("main", { branch: "task/one", head })
      let raceStarted = false
      let raced: PauseRecord | undefined
      let changeBefore = ""
      const racePause = async () => {
        raceStarted = true
        changeBefore = (await w.git(["ls-remote", "--refs", "origin", ref])).trim().split(/\s+/u)[0] ?? ""
        await writePause(w.git, "origin", "main", { by: "operator", kind: "resumed", reason: "new decision" })
        raced = await writePause(w.git, "origin", "main", {
          by: "operator",
          kind: "paused",
          reason: "stop this round",
        })
      }
      using _publication = beforeGitomicPublish(
        async (_repo, updates, remote) => {
          if (
            when === "before-push" &&
            remote !== undefined &&
            !raceStarted &&
            updates.some((update) => update.ref === "refs/heads/main")
          ) {
            await racePause()
          }
        },
        async (_repo, refs) => {
          // Admission comes from readQueue's broad capture; the exact pause
          // fetch is the separate authority read immediately before the fence.
          if (when === "before-fence" && !raceStarted && refs === PAUSE_REF) await racePause()
        },
      )
      const outcome = await queueRun({ ...(await w.options({ exit: 0 })), foreground: true })
      expect(raced?.reason).toBe("stop this round")
      expect(outcome.merged).toEqual([])
      expect(outcome.stopped?.what).toEqual(raced)
      expect(await remoteTarget(w)).toBe(w.target)
      expect((await w.git(["ls-remote", "--refs", "origin", ref])).trim().split(/\s+/u)[0]).toBe(changeBefore)
      expect(await readPause(w.git, "origin", "main")).toEqual(raced)
    },
  )

  it("a paused run reaps and reports direct merges without retiring, catching up, resending, or judging changes", async () => {
    const w = await world()
    const queued = await submitCommit(w, "task/queued", "queued.txt")
    const deleted = await submitCommit(w, "task/deleted", "deleted.txt")
    const caughtUp = await submitCommit(w, "task/caught-up", "caught-up.txt")

    // One change is already on the target but has no merged record, so catch-up
    // would mutate it; the merge itself is also a direct merge the paused run owes.
    await w.git(["merge", "--quiet", "--no-ff", "--no-edit", "-m", "merged around the queue", caughtUp])
    const direct = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["push", "--quiet", "origin", "main"])

    // One ended change has no sent record, so resend would mutate it.
    const unsent = await submitCommit(w, "task/unsent", "unsent.txt")
    await appendRemoteRecord(w.git, "main", {
      change: { branch: "task/unsent", head: unsent },
      kind: "failed",
      subject: "task/unsent failed verify",
      trailers: [["Reason", "verify"]],
    })

    // One admitted branch is gone, so retirement would append a failed record;
    // another remains queued, so the submit phase would judge it.
    await w.git(["push", "--quiet", "origin", ":refs/heads/task/deleted"])
    const dead = await worktreeOfRun(w, "q-dead-paused", exitedPid())
    const paused = await writePause(w.git, "origin", "main", {
      by: "@chief",
      kind: "paused",
      reason: "inspect the target",
    })

    const held = await queueRun(await w.options({ exit: 0 }))

    expect(held).toMatchObject({ directMerges: [direct], exitCode: 0, failed: [], merged: [], stuck: [] })
    expect(held.stopped?.what).toEqual(paused)
    expect(existsSync(dead)).toBe(false)
    expect(logRecords(held).filter((record) => record.kind === "reap")).toHaveLength(1)
    expect(logRecords(held).filter((record) => record.kind === "merged-direct")).toHaveLength(1)
    expect(logRecords(held).filter((record) => record.kind === "change")).toEqual([])
    expect(whereRan(w)).toEqual([])
    expect(await remoteTarget(w)).toBe(direct)
    await fetchChanges(w)
    expect(
      (await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/queued", head: queued })))!)).map(
        (record) => record.kind,
      ),
    ).toEqual(["opened"])
    expect(
      (
        await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/deleted", head: deleted })))!)
      ).map((record) => record.kind),
    ).toEqual(["opened"])
    expect(
      (
        await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/caught-up", head: caughtUp })))!)
      ).map((record) => record.kind),
    ).toEqual(["opened"])
    expect(
      (await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/unsent", head: unsent })))!)).map(
        (record) => record.kind,
      ),
    ).toEqual(["opened", "failed"])
    expect(messages(w)).toEqual([{ change: direct, record: "merged-direct" }])
  })

  it("a pause placed after the last read but before the atomic merge push blocks every ref advance", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const ref = changeRef("main", { branch: "task/one", head })
    const rivalPath = join(w.workdir, "..", "pause-rival")
    await gitIn(join(w.workdir, ".."))(["clone", "--quiet", w.remote, rivalPath])
    const rival = gitIn(rivalPath)
    await rival(["config", "user.email", "rival@yrd.test"])
    await rival(["config", "user.name", "rival"])

    let paused: PauseRecord | undefined
    let targetBeforePush = ""
    let changeBeforePush = ""
    using _publication = beforeGitomicPublish(async (_repo, updates, remote) => {
      if (remote !== undefined && paused === undefined && updates.some((update) => update.ref === "refs/heads/main")) {
        targetBeforePush = await remoteTarget(w)
        changeBeforePush = (await w.git(["ls-remote", "--refs", "origin", ref])).trim().split(/\s+/u)[0] ?? ""
        paused = await writePause(rival, "origin", "main", {
          by: "operator",
          kind: "paused",
          reason: "stop before merge",
        })
      }
    })

    const outcome = await queueRun(await w.options({ exit: 0 }))

    expect(paused).toBeDefined()
    expect(outcome.stopped?.what).toEqual(paused)
    expect(outcome.merged).toEqual([])
    expect(await remoteTarget(w)).toBe(targetBeforePush)
    expect((await w.git(["ls-remote", "--refs", "origin", ref])).trim().split(/\s+/u)[0]).toBe(changeBeforePush)
    await fetchChanges(w)
    expect(
      (await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)).map(
        (record) => record.kind,
      ),
    ).toEqual(["opened", "checked"])
    expect(logRecords(outcome)).toContainEqual(expect.objectContaining({ decision: "checked", reason: "paused" }))
  })

  it("an unreadable pause at the pre-merge authority read faults the run without ending the change", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const rivalPath = join(w.workdir, "..", "malformed-pause-rival")
    await gitIn(join(w.workdir, ".."))(["clone", "--quiet", w.remote, rivalPath])
    const rival = gitIn(rivalPath)
    await rival(["config", "user.email", "rival@yrd.test"])
    await rival(["config", "user.name", "rival"])

    let malformed = ""
    using _authority = beforeGitomicPublish(
      async () => undefined,
      async (_repo, refs) => {
        if (refs !== PAUSE_REF || malformed !== "") return
        const tree = (await rival(["mktree"], "")).trim()
        malformed = (
          await rival([
            "commit-tree",
            tree,
            "-m",
            "authority cannot be parsed\n\nRecord: wedged\nPaused-By: operator\n",
          ])
        ).trim()
        await rival(["push", "--quiet", "origin", `${malformed}:${PAUSE_REF}`])
      },
    )

    await expect(queueRun(await w.options({ exit: 0 }))).rejects.toThrow(
      `origin ${PAUSE_REF} could not be read: origin ${PAUSE_REF} at`,
    )

    expect(malformed).not.toBe("")
    expect(await remoteTarget(w)).toBe(w.target)
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked"])
    expect(records.some((record) => record.kind === "stuck" || record.kind === "failed")).toBe(false)
    expect(messages(w)).toEqual([])
  })

  it("nothing submitted is nothing to do", async () => {
    const w = await world()
    const outcome = await queueRun(await w.options({}))
    expect(outcome.exitCode).toBe(0)
    expect(await remoteTarget(w)).toBe(w.target)
    expect(messages(w)).toEqual([])
  })

  it("a later successful recipient does not hide a failing notifier from the next run", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    // The first recipient is down and the second accepts the same ending. The
    // later success must not hide the earlier delivery still owed.
    const down = await queueRun({
      ...(await w.options({ exit: 0 })),
      notify: [
        { name: "recovering", on: ["merged"], run: "sh -c 'echo the notifier is down >&2; exit 3'" },
        { name: "recorder", on: ["merged"], run: w.notifier },
      ],
    })
    expect(down).toMatchObject({ exitCode: 0, merged: ["task/one"], stuck: [] })
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/main/*:refs/yrd/main/*"])
    let records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked", "merged", "sent", "sent"])
    const merged = records[2]
    const appendTip = records.at(-1)
    if (merged === undefined || appendTip === undefined) throw new Error("missing merged or sent record")
    expect(records.slice(-2).map((record) => trailer(record, "To"))).toEqual(["recovering", "recorder"])
    expect(records.slice(-2).map((record) => trailer(record, "Delivery"))).toEqual(["failed", "sent"])
    expect(records.slice(-2).map((record) => trailer(record, "For"))).toEqual([merged.sha, merged.sha])
    expect(records.slice(-2).map((record) => trailer(record, "Message-Id"))).toEqual([merged.sha, merged.sha])
    expect(messages(w)).toHaveLength(1)

    // With no currently matching names, the failed old name writes nothing;
    // the nonempty receipt chain also never grows a synthetic `none` receipt.
    const ref = changeRef("main", { branch: "task/one", head })
    const absent = await queueRun({ ...(await w.options({ exit: 0 })), notify: [] })
    expect(logRecords(absent).filter((record) => record.kind === "message")).toEqual([])
    expect(await refAt(gitIn(w.remote), ref)).toBe(appendTip.sha)
    expect(messages(w)).toHaveLength(1)

    // The failed recipient is still down for its one more attempt. A poisoned
    // local ref cannot replace either the immutable ending id or the captured
    // sent tip used as append parent.
    await w.git(["update-ref", ref, head])
    const stillDown = [
      { name: "recovering", on: ["merged"] as const, run: "sh -c 'echo the notifier is down >&2; exit 3'" },
      { name: "recorder", on: ["merged"] as const, run: w.notifier },
    ]
    const again = await queueRun({
      ...(await w.options({ exit: 0 })),
      notify: stillDown,
    })
    expect(again.exitCode).toBe(0)
    expect(await refAt(w.git, ref)).toBe(head)
    expect(
      logRecords(again)
        .filter((record) => record.kind === "message")
        .map(({ delivered, id, to }) => ({ delivered, id, to })),
    ).toEqual([{ delivered: false, id: merged.sha, to: "recovering" }])
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/main/*:refs/yrd/main/*"])
    records = await readRecords(w.git, (await refAt(w.git, ref))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked", "merged", "sent", "sent", "sent"])
    const exhausted = records.at(-1)!
    expect(exhausted.trailers).toEqual(
      expect.arrayContaining([
        ["To", "recovering"],
        ["Delivery", "failed"],
        ["For", merged.sha],
        ["Message-Id", merged.sha],
      ]),
    )
    // The second failed attempt is the last: the record says so, and why.
    expect(trailers(exhausted, "Not-Told")).toEqual([
      expect.stringMatching(/^recovering undelivered=.*the notifier is down/u),
    ])
    expect((await w.git(["rev-parse", `${exhausted.sha}^`])).trim()).toBe(appendTip.sha)
    expect(messages(w)).toHaveLength(1)

    // Every notifier is healthy now, and the ending is still not told again.
    const healthy = [
      { name: "recovering", on: ["merged"] as const, run: w.notifier },
      { name: "recorder", on: ["merged"] as const, run: w.notifier },
    ]
    const settled = await queueRun({ ...(await w.options({ exit: 0 })), notify: healthy })
    expect(logRecords(settled).filter((record) => record.kind === "message")).toEqual([])
    expect(await refAt(gitIn(w.remote), ref)).toBe(exhausted.sha)
    expect(messages(w)).toHaveLength(1)
  })

  it("a recipient the transport refused is recorded once, never counted told, and never sent again", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const ref = changeRef("main", { branch: "task/one", head })
    const refusing = [{ name: "submitter", on: ["merged"] as const, run: REFUSING_NOTIFIER }]

    const first = await queueRun({ ...(await w.options({ exit: 0 })), notify: refusing })
    expect(first).toMatchObject({ exitCode: 0, merged: ["task/one"], stuck: [] })
    expect(
      logRecords(first)
        .filter((record) => record.kind === "message")
        .map(({ delivered, refused, to }) => ({ delivered, refused, to })),
    ).toEqual([{ delivered: false, refused: REFUSAL, to: "submitter" }])
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, ref))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked", "merged", "sent"])
    const refusal = records.at(-1)!
    expect(["To", "Delivery"].map((name) => trailer(refusal, name))).toEqual(["submitter", "failed"])
    expect(trailers(refusal, "Not-Told")).toEqual([`submitter refused=${REFUSAL}`])
    expect(trailer(refusal, "Delivery-Error")).toContain("daemon refused the send")

    // The same refusal next round: it is a receipt, so nothing runs or is written.
    const second = await queueRun({ ...(await w.options({ exit: 0 })), notify: refusing })
    expect(logRecords(second).filter((record) => record.kind === "message")).toEqual([])
    expect(await refAt(gitIn(w.remote), ref)).toBe(refusal.sha)

    // A notifier that would take it now does not undo the refusal either.
    const third = await queueRun({
      ...(await w.options({ exit: 0 })),
      notify: [{ name: "submitter", on: ["merged"], run: w.notifier }],
    })
    expect(logRecords(third).filter((record) => record.kind === "message")).toEqual([])
    expect(await refAt(gitIn(w.remote), ref)).toBe(refusal.sha)
    expect(messages(w)).toEqual([])
  })

  it("a notifier that gave no receipt gets exactly one more attempt, and a timeout is never a refusal", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const ref = changeRef("main", { branch: "task/one", head })
    // A timed-out notifier that happens to exit 4 and print a refusal: the
    // bound killed it, so nothing answered, and it must read as no receipt.
    let round = 1
    await using runner = createProcess({ cwd: w.work })
    const slowNotifiers = {
      ...runner,
      run: async (request: Parameters<typeof runner.run>[0]) => {
        const command = request.argv.join(" ")
        const late =
          (command.includes(`${w.notifier} flaky`) && round === 1) ||
          (command.includes(`${w.notifier} slow`) && round <= 2)
        if (!late) return runner.run(request)
        const killed = await runner.run({ ...request, argv: ["sh", "-c", `echo "${REFUSAL}"; exit 4`] })
        return { ...killed, stalled: false as const, timedOut: true as const, verdict: "TIMED_OUT" as const }
      },
    }
    const notify = [
      { name: "flaky", on: ["merged"] as const, run: `${w.notifier} flaky` },
      { name: "slow", on: ["merged"] as const, run: `${w.notifier} slow` },
    ]

    const first = await queueRun({ ...(await w.options({ exit: 0 })), notify, process: slowNotifiers })
    expect(first.merged).toEqual(["task/one"])
    await fetchChanges(w)
    let records = await readRecords(w.git, (await refAt(w.git, ref))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked", "merged", "sent", "sent"])
    expect(records.slice(-2).map((record) => [trailer(record, "To"), trailer(record, "Delivery")])).toEqual([
      ["flaky", "failed"],
      ["slow", "failed"],
    ])
    expect(records.slice(-2).flatMap((record) => trailers(record, "Not-Told"))).toEqual([])

    round = 2
    const second = await queueRun({ ...(await w.options({ exit: 0 })), notify, process: slowNotifiers })
    expect(
      logRecords(second)
        .filter((record) => record.kind === "message")
        .map(({ delivered, refused, to }) => ({ delivered, refused, to })),
    ).toEqual([
      { delivered: true, refused: undefined, to: "flaky" },
      { delivered: false, refused: undefined, to: "slow" },
    ])
    await fetchChanges(w)
    records = await readRecords(w.git, (await refAt(w.git, ref))!)
    expect(records.map((record) => record.kind)).toEqual([
      "opened",
      "checked",
      "merged",
      "sent",
      "sent",
      "sent",
      "sent",
    ])
    const [told, lastTry] = [records.at(-2)!, records.at(-1)!]
    expect([trailer(told, "To"), trailer(told, "Delivery")]).toEqual(["flaky", "sent"])
    expect([trailer(lastTry, "To"), trailer(lastTry, "Delivery")]).toEqual(["slow", "failed"])
    expect(trailers(lastTry, "Not-Told")).toEqual([
      expect.stringMatching(/^slow undelivered=the notify entry slow .* ran past its 60000ms bound and exited 4: /u),
    ])

    round = 3
    const third = await queueRun({ ...(await w.options({ exit: 0 })), notify, process: slowNotifiers })
    expect(logRecords(third).filter((record) => record.kind === "message")).toEqual([])
    expect(await refAt(gitIn(w.remote), ref)).toBe(lastTry.sha)
    expect(messages(w)).toHaveLength(1)
  })

  it("an ending whose telling never ran is still told on the next round", async () => {
    // A crash between the ended record and its first sent record leaves no
    // receipt at all: the repair pass owes every declared name.
    const w = await world()
    const head = await submitCommit(w, "task/unsent", "unsent.txt")
    const change = { branch: "task/unsent", head }
    const failed = await appendRemoteRecord(w.git, "main", {
      change,
      kind: "failed",
      subject: "task/unsent failed verify",
      trailers: [["Reason", "verify"]],
    })

    const repaired = await queueRun(await w.options({ exit: 0 }))

    expect(
      logRecords(repaired)
        .filter((record) => record.kind === "message")
        .map(({ delivered, id, to }) => ({ delivered, id, to })),
    ).toEqual([{ delivered: true, id: failed, to: "recorder" }])
    expect(messages(w)).toMatchObject([{ change: changeName(change), record: "failed" }])
  })

  it("a newly named recipient is still told past a refusal, and its record carries the refusal", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const ref = changeRef("main", { branch: "task/one", head })
    const refusing = { name: "submitter", on: ["merged"] as const, run: REFUSING_NOTIFIER }
    await queueRun({ ...(await w.options({ exit: 0 })), notify: [refusing] })
    await fetchChanges(w)
    const refusal = (await readRecords(w.git, (await refAt(w.git, ref))!)).at(-1)!
    expect(trailers(refusal, "Not-Told")).toEqual([`submitter refused=${REFUSAL}`])

    const added = await queueRun({
      ...(await w.options({ exit: 0 })),
      notify: [refusing, { name: "board", on: ["merged"], run: w.notifier }],
    })

    expect(
      logRecords(added)
        .filter((record) => record.kind === "message")
        .map(({ delivered, to }) => ({ delivered, to })),
    ).toEqual([{ delivered: true, to: "board" }])
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, ref))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked", "merged", "sent", "sent"])
    const board = records.at(-1)!
    expect([trailer(board, "To"), trailer(board, "Delivery")]).toEqual(["board", "sent"])
    // The tip alone still says who was not told.
    expect(trailers(board, "Not-Told")).toEqual([`submitter refused=${REFUSAL}`])
    expect((await w.git(["rev-parse", `${board.sha}^`])).trim()).toBe(refusal.sha)
    expect(messages(w)).toHaveLength(1)
  })

  it("a refused notice about a direct merge goes out once, however many runs find the commit again (E5)", async () => {
    const w = await world()
    // As in the E5 case above: one change merged through the queue first, so
    // the direct commit below has a queue history to be found against and
    // nothing of the queue's ever lands on top of it.
    await submitCommit(w, "task/one", "one.txt")
    expect((await queueRun(await w.options({ exit: 0 }))).merged).toEqual(["task/one"])
    await w.git(["fetch", "--quiet", "origin", "main"])
    await w.git(["checkout", "--quiet", "main"])
    await w.git(["merge", "--quiet", "--ff-only", "origin/main"])
    const direct = await pushAroundQueue(w, "direct.txt")
    const refusing = [{ name: "board", on: ["merged-direct"] as const, run: REFUSING_NOTIFIER }]
    const directNotices = (outcome: QueueRunOutcome) =>
      logRecords(outcome).filter((record) => record.kind === "message" && record.says === "merged-direct")

    const first = await queueRun({ ...(await w.options({ exit: 0 })), notify: refusing })
    expect(first.directMerges).toEqual([direct])
    expect(directNotices(first).map(({ delivered, head, refused, to }) => ({ delivered, head, refused, to }))).toEqual([
      { delivered: false, head: direct, refused: REFUSAL, to: "board" },
    ])

    const second = await queueRun({ ...(await w.options({ exit: 0 })), notify: refusing })
    expect(second.directMerges).toEqual([direct])
    expect(directNotices(second)).toEqual([])
  })

  it("a change merged around the queue reads merged, its catch-up record says a direct merge did it, and the direct merge is reported once (E5)", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    // The garage merges it around the queue: a merge commit on main, pushed.
    await w.git(["merge", "--quiet", "--no-ff", "--no-edit", "-m", "merged around the queue", head])
    const merge = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["push", "--quiet", "origin", "main"])

    const rivalPath = join(w.workdir, "..", "catch-up-rival")
    await gitIn(join(w.workdir, ".."))(["clone", "--quiet", w.remote, rivalPath])
    const rival = gitIn(rivalPath)
    await rival(["config", "user.email", "rival@yrd.test"])
    await rival(["config", "user.name", "rival"])
    const ref = changeRef("main", { branch: "task/one", head })
    let concurrent: string | undefined
    let advance = true
    using _publication = beforeGitomicPublish(async (_repo, updates, remote) => {
      const update = updates.find((candidate) => candidate.ref === ref)
      if (remote !== undefined && advance && update !== undefined) {
        advance = false
        await rival(["fetch", "--quiet", "origin", `${ref}:${ref}`])
        concurrent = await appendRecord(rival, "main", {
          change: { branch: "task/one", head },
          kind: "merged",
          subject: `another queue observed the direct merge at ${merge.slice(0, 12)}`,
          trailers: [
            ["Merge", merge],
            ["Base", w.target],
            ["Merged-By", "direct"],
          ],
        })
        await rival(["push", "--quiet", "origin", `${concurrent}:${ref}`])
      }
    })

    const outcome = await queueRun(await w.options({ exit: 0 }))

    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual([])
    expect(outcome.directMerges).toEqual([merge])
    expect(await remoteTarget(w)).toBe(merge)
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "merged", "merged", "sent"])
    expect(records.map((record) => record.sha)).toContain(concurrent)
    expect(records[2]?.subject).toBe(`merged around the queue at ${merge.slice(0, 12)}`)
    // `Base:` is the merge commit's first parent, a sha like every other Base.
    expect(records[2]?.trailers).toEqual(
      expect.arrayContaining([
        ["Merge", merge],
        ["Base", w.target],
        ["Merged-By", "direct"],
      ]),
    )
    expect(records[3]?.trailers).toEqual(
      expect.arrayContaining([
        ["State", "merged"],
        ["Merged-By", "direct"],
      ]),
    )
    expect(logRecords(outcome)).toContainEqual(
      expect.objectContaining({ decision: "merged", reason: "change-ref-taken", remote: concurrent }),
    )
    // Two records: one for the change that merged, one for the direct merge, the
    // second with the merge commit as its id.
    expect(messages(w).filter((message) => message.record === "merged")).toMatchObject([{ submitter: "@dev/2" }])
    const broken = messages(w).filter((message) => message.record === "merged-direct")
    expect(broken).toEqual([{ change: merge, record: "merged-direct" }])
    const told = logRecords(outcome).find((record) => record.kind === "message" && record.says === "merged-direct")
    expect(String(told?.text)).toContain(`main moved around the queue at ${merge.slice(0, 12)}`)
    expect(String(told?.text)).toContain("it carries no Change: trailer")
    expect(logRecords(outcome).filter((record) => record.kind === "merged-direct")).toMatchObject([
      { commit: merge, gitlinks: [], parents: [w.target, head], subject: "merged around the queue" },
    ])

    // The next run says nothing new: the catch-up record accounts for the commit.
    const again = await queueRun(await w.options({ exit: 0 }))
    expect(again.directMerges).toEqual([])
    expect(logRecords(again).filter((record) => record.kind === "merged-direct")).toEqual([])
    expect(messages(w).filter((message) => message.record === "merged-direct")).toHaveLength(1)
  })

  it("a change that ended failed and was then merged around the queue gets one message, the merged one, and its tip says merged", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    // It failed its check, and the notifier was down, so the send-back is owed:
    // exactly what makes the next run try to deliver it once more.
    const down = await queueRun({
      ...(await w.options({ exit: 1 })),
      notify: [{ name: "recorder", on: ["failed"], run: "sh -c 'exit 3'" }],
    })
    expect(down.exitCode).toBe(1)
    expect(messages(w)).toEqual([])

    // The garage merged it around the queue all the same.
    await w.git(["checkout", "--quiet", "main"])
    await w.git(["merge", "--quiet", "--no-ff", "--no-edit", "-m", "merged around the queue", head])
    await w.git(["push", "--quiet", "origin", "main"])

    const outcome = await queueRun(await w.options({ exit: 0 }))

    expect(outcome.exitCode).toBe(0)
    await fetchChanges(w)
    // The catch-up merged record and its message, and no second ending on top of it.
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked", "failed", "sent", "merged", "sent"])
    expect(records.at(-1)?.trailers).toEqual(expect.arrayContaining([["State", "merged"]]))
    expect(
      messages(w)
        .filter((message) => String(message.change).startsWith("task/one@"))
        .map((message) => message.record),
    ).toEqual(["merged"])
  })

  it("a head that failed and was later superseded by a merged head of the same branch is never announced merged (@i/10-yrd/24098)", async () => {
    const w = await world()
    const headA = await submitCommit(w, "task/one", "one.txt")
    const refA = changeRef("main", { branch: "task/one", head: headA })

    // It failed its own check.
    const failedRun = await queueRun(await w.options({ exit: 1 }))
    expect(failedRun.exitCode).toBe(1)
    await fetchChanges(w)
    expect((await readRecords(w.git, (await refAt(w.git, refA))!)).map((record) => record.kind)).toEqual([
      "opened",
      "checked",
      "failed",
      "sent",
    ])

    // The submitter fixed it and pushed a new head on the SAME branch, which
    // carries the failed head as its own ancestor — the exact 2026-09-09 shape
    // (task/cto-24366-head-check's own earlier failed heads, superseded by the
    // head that actually merged).
    await w.git(["checkout", "--quiet", "task/one"])
    writeFileSync(join(w.work, "two.txt"), "two.txt\n")
    await w.git(["add", "two.txt"])
    await w.git(["commit", "--quiet", "-m", "two.txt"])
    const headB = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])
    await submit(w.git, "origin", {
      branch: "task/one",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
      issue: "@i/10-yrd/1",
    })

    // The new head passes its check and merges through the queue on its own.
    const mergedRun = await queueRun(await w.options({ exit: 0 }))
    expect(mergedRun.exitCode).toBe(0)
    expect(mergedRun.merged).toEqual(["task/one"])

    // The next run is where bare reachability used to resurrect the failed head:
    // its own catch-up runs again, now that headOnTarget has flipped true.
    const settled = await queueRun(await w.options({ exit: 0 }))
    expect(settled.exitCode).toBe(0)

    const after = await remoteTarget(w)
    const rows = list((await readQueue(w.git, "origin", "main", after)).changes)
    const rowA = rows.find((row) => row.head === headA)
    const rowB = rows.find((row) => row.head === headB)
    expect(rowB?.state).toBe("merged")
    expect(rowA?.state).toBe("failed")
    expect(rowA?.reason).toBe("superseded")
    expect(rowA?.supersededBy).toBe(headB)

    // The failed head's own record chain never gained a fabricated merged
    // record on top of its original failure.
    await fetchChanges(w)
    expect((await readRecords(w.git, (await refAt(w.git, refA))!)).map((record) => record.kind)).toEqual([
      "opened",
      "checked",
      "failed",
      "sent",
    ])

    // Nobody was told to close a bead for a head that never merged on its own:
    // exactly one message ever names it, and it is the original failure.
    const aMessages = messages(w).filter(
      (message) => message.change === changeName({ branch: "task/one", head: headA }),
    )
    expect(aMessages).toHaveLength(1)
    expect(aMessages[0]?.record).toBe("failed")
  })

  it("the target is not a change: a ref named after it is judged by nothing and messages nobody (2026-09-03 main@0a9db9daf7eb)", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")
    // The one path in refuses it now; the ref is planted the way the remote holds it.
    await expect(
      submit(w.git, "origin", { branch: "main", submitter: "unknown", target: { branch: "main", remote: "origin" } }),
    ).rejects.toThrow("main is the target, not a change")
    await plantTargetChange(w, w.target)

    // The queue merges the real change. The merge's first parent is the head
    // the planted ref is named after — which is what made the next run call
    // that ref merged, name the queue's own merge as its landing, and write a
    // `Merged-By: direct` record on it.
    const merging = await queueRun(await w.options({ exit: 0 }))
    expect(merging.merged).toEqual(["task/one"])
    const merge = await remoteTarget(w)
    expect((await w.git(["rev-parse", `${merge}^1`])).trim()).toBe(w.target)

    // The run after the merge: the one that in the specimen wrote `merged by
    // around the queue at 005a622156c7` and told its submitter to close a bead for it.
    const after = await queueRun(await w.options({ exit: 0 }))

    expect(after.exitCode).toBe(0)
    expect(after.merged).toEqual([])
    expect(after.directMerges).toEqual([])
    await fetchChanges(w)
    // The planted ref still holds the one record that was written on it, and no
    // run considered it: no record, no row, no message.
    expect(
      (await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "main", head: w.target })))!)).map(
        (record) => record.kind,
      ),
    ).toEqual(["opened"])
    for (const outcome of [merging, after]) {
      expect(logRecords(outcome).filter((record) => record.kind === "change" && record.branch === "main")).toEqual([])
      expect(logRecords(outcome).filter((record) => record.kind === "merged-direct")).toEqual([])
    }
    expect(messages(w).filter((message) => String(message.change).startsWith("main@"))).toEqual([])
    expect(messages(w).filter((message) => message.record === "merged-direct")).toEqual([])
    expect(messages(w).map((message) => message.record)).toEqual(["merged"])
  })

  it("the merge commit names its change, its submitter and its issue, and the merged record says the queue merged it and what it checked (E5)", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(await w.options({ exit: 0 }))

    expect(outcome.merged).toEqual(["task/one"])
    await w.git(["fetch", "--quiet", "origin", "main"])
    const merge = await remoteTarget(w)
    expect((await w.git(["log", "-1", "--format=%s", merge])).trim()).toBe(
      `merge task/one@${head.slice(0, 12)} into main`,
    )
    // The trailer is the change's name, which under the one prefix is its ref:
    // `git log refs/yrd/main/<that name>` prints the records.
    const named = await trailerOn(w, merge, "Change")
    expect(named).toBe(changeName({ branch: "task/one", head }))
    expect(`${CHANGES}/${named}`).toBe(changeRef("main", { branch: "task/one", head }))
    expect(await trailerOn(w, merge, "Issue")).toBe("@i/10-yrd/1")
    expect(await trailerOn(w, merge, "Submitter")).toBe("@dev/2")
    await fetchChanges(w)
    // The records and the genesis, on the ref's first-parent line (legacy-records.ts).
    expect(
      (await w.git(["log", "--first-parent", "--format=%s", `${CHANGES}/${named}`])).trim().split("\n"),
    ).toHaveLength(5)
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    const merged = records.find((record) => record.kind === "merged")
    if (merged === undefined) throw new Error("no merged record")
    // `Merged-By:` names the queue and the run of it that merged: the run id is
    // what a reader needs, and one formatter writes it on both the record and
    // the merge commit, so the two can never say different things.
    const by = trailer(merged, "Merged-By") ?? ""
    expect(by).toBe(`yrd queue main [${outcome.run}]`)
    // 24470 moved the queue's name off the header, which is now written before
    // any Git call, and onto its own record written the instant the remote
    // resolves. The name itself is unchanged, and this is still the journal's
    // one statement of which queue merged the change.
    expect(logRecords(outcome).find((record) => record.kind === "queue")).toMatchObject({ queue: `${w.remote}#main` })
    expect(mergedByRun(by)).toBe(outcome.run)
    expect(await trailerOn(w, merge, "Merged-By")).toBe(by)
    // The queue commits as itself, so a reader tells its merges from a person's
    // with `git log` alone.
    expect((await w.git(["log", "-1", "--format=%cn <%ce>", merge])).trim()).toMatch(/^yrd <yrd@/u)
    expect(trailer(merged, "Merge")).toBe(merge)
    // One `Check:` per on-merge check, in the shape the checked record uses.
    expect(trailers(merged, "Check")).toEqual([expect.stringMatching(/^verify exit=0 ms=\d+ log=\S+$/u)])
    expect(records.at(-1)?.trailers).toEqual(
      expect.arrayContaining([
        ["To", "recorder"],
        ["Delivery", "sent"],
        ["Merged-By", by],
      ]),
    )
  })

  it("a commit pushed to the target around the queue is reported once, and the queue goes on from the new base (E5)", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const base = await remoteTarget(w)
    const direct = await pushAroundQueue(w, "direct.txt")

    const first = await queueRun(await w.options({ exit: 0 }))

    expect(first.exitCode).toBe(0)
    expect(first.directMerges).toEqual([direct])
    expect(first.merged).toEqual(["task/one"])
    expect(logRecords(first).filter((record) => record.kind === "merged-direct")).toMatchObject([
      { commit: direct, gitlinks: [], parents: [base], subject: "direct.txt around the queue" },
    ])
    const broken = messages(w).filter((message) => message.record === "merged-direct")
    expect(broken).toEqual([{ change: direct, record: "merged-direct" }])
    const told = logRecords(first).find((record) => record.kind === "message" && record.says === "merged-direct")
    expect(String(told?.text)).toContain(`main moved around the queue at ${direct.slice(0, 12)}`)
    expect(String(told?.text)).toContain("it is one commit, not a merge of a change")
    // The change merged on top of the direct merge, not on the base the queue read first.
    await w.git(["fetch", "--quiet", "origin", "main"])
    const parents = (await w.git(["rev-list", "--parents", "-n", "1", await remoteTarget(w)]))
      .trim()
      .split(/\s+/u)
      .slice(1)
    expect(parents).toEqual([direct, head])

    // The next run says nothing new: the queue's own merge stands on top of it.
    const second = await queueRun(await w.options({ exit: 0 }))
    expect(second.directMerges).toEqual([])
    expect(logRecords(second).filter((record) => record.kind === "merged-direct")).toEqual([])
    expect(messages(w).filter((message) => message.record === "merged-direct")).toHaveLength(1)
  })

  it("a commit around the queue with nothing of the queue's on top is found again every run, but told about only once (E5)", async () => {
    const w = await world()
    // A change merged through the queue first, in its own run, purely to give
    // `queueStarted` a history to walk from (direct.ts: no entry ever, no
    // business reporting anything). Merging it here, before either direct
    // push, keeps it off the first-parent line above them, so nothing of the
    // queue's ever lands on the direct commits below and neither is ever
    // accounted for — the scenario no existing case covers.
    await submitCommit(w, "task/one", "one.txt")
    const primed = await queueRun(await w.options({ exit: 0 }))
    expect(primed.merged).toEqual(["task/one"])
    // The run merged and pushed straight to the bare remote; `w.work`'s own
    // `main` never moved, and `pushAroundQueue` pushes from it next.
    await w.git(["fetch", "--quiet", "origin", "main"])
    await w.git(["checkout", "--quiet", "main"])
    await w.git(["merge", "--quiet", "--ff-only", "origin/main"])

    const direct = await pushAroundQueue(w, "direct.txt")

    const first = await queueRun(await w.options({ exit: 0 }))
    expect(first.directMerges).toEqual([direct])
    expect(messages(w).filter((message) => message.record === "merged-direct")).toEqual([
      { change: direct, record: "merged-direct" },
    ])

    // Nothing landed on top of it, so the walk in direct.ts never reaches an
    // accounted commit: `directMerges` and the log's own `merged-direct` row
    // legitimately repeat every run, exactly as direct.ts's own doc says they
    // must ("reported again next run, with the commit sha as its id"). What
    // must NOT repeat is the notifier's own message — direct.ts promises "the
    // notifier sees one message however many runs say it".
    const second = await queueRun(await w.options({ exit: 0 }))
    expect(second.directMerges).toEqual([direct])
    expect(logRecords(second).filter((record) => record.kind === "merged-direct")).toHaveLength(1)
    expect(messages(w).filter((message) => message.record === "merged-direct")).toHaveLength(1)

    // A third run in a row still says nothing new to the notifier.
    const third = await queueRun(await w.options({ exit: 0 }))
    expect(third.directMerges).toEqual([direct])
    expect(messages(w).filter((message) => message.record === "merged-direct")).toHaveLength(1)

    // A genuinely new direct merge, still with nothing of the queue's on top
    // of either commit, is told about exactly once, oldest first — the old
    // one stays silent.
    const secondDirect = await pushAroundQueue(w, "direct-two.txt")
    const fourth = await queueRun(await w.options({ exit: 0 }))
    expect(fourth.directMerges).toEqual([direct, secondDirect])
    expect(messages(w).filter((message) => message.record === "merged-direct")).toEqual([
      { change: direct, record: "merged-direct" },
      { change: secondDirect, record: "merged-direct" },
    ])
  })

  it("a queue that has judged nothing has no history, so it judges nothing on the target (E5)", async () => {
    // Not one change was ever submitted here, so there is no first record and no
    // instant to start from — and every commit on the target belongs to
    // whatever moved the branch before this queue existed.
    const w = await world({ declaredLater: true })
    // Operational pause history is not a submitted change's history.
    await writePause(w.git, "origin", "main", { by: "operator", kind: "paused", reason: "maintenance" })
    await writePause(w.git, "origin", "main", { by: "operator", kind: "resumed", reason: "maintenance complete" })
    await pushAroundQueue(w, "direct.txt")

    const outcome = await queueRun(await w.options({ exit: 0 }))

    expect(outcome.exitCode).toBe(0)
    expect(outcome.directMerges).toEqual([])
    expect(logRecords(outcome).filter((record) => record.kind === "merged-direct")).toEqual([])
    expect(messages(w)).toEqual([])
  })

  /**
   * THE HOLE THE PLAN NAMED AT THE CUTOVER (§ Owed after M5, E5's last line).
   *
   * Every earlier boundary was a commit in `.yrd.yml` — first the newest one
   * that TOUCHED the file, then the one that introduced `remote:` — and the
   * first of those let a direct merge hide itself: it edited the declaration,
   * became the boundary, and took every direct merge under it out of the report.
   *
   * The boundary is the queue's own first record now, which no commit on the
   * target can move at all. A direct merge that edits the declaration is judged
   * like any other first-parent commit, and everything older than that first
   * record belongs to whoever moved the branch before this queue existed.
   */
  it("a direct merge after the queue's first change is reported, declaration edits included; anything older is not (E5)", async () => {
    const w = await world({ declaredLater: true })
    const before = await pushAroundQueue(w, "before.txt")
    // A whole second, so the boundary is not a tie: a committer date is seconds.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await submitCommit(w, "task/one", "one.txt")
    const plain = await pushAroundQueue(w, "direct.txt")
    const edited = await editDeclarationAroundQueue(w, "# edited around the queue\n")

    const outcome = await queueRun(await w.options({ exit: 0 }))

    // Both direct merges, oldest first; the one from before the first change is
    // never among them.
    expect(outcome.directMerges).toEqual([plain, edited])
    expect(outcome.directMerges).not.toContain(before)
    expect(
      logRecords(outcome)
        .filter((record) => record.kind === "merged-direct")
        .map((record) => record.commit),
    ).toEqual([plain, edited])
    expect(messages(w).filter((message) => message.record === "merged-direct")).toHaveLength(2)
  })

  it("a checked change is judged again when the target's check config is not the one its checked record names", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = await submitCommit(w, "task/two", "two.txt")

    // One merge per run: task/one merges, task/two stays checked under config A.
    const first = await queueRun({ ...(await w.options({ exit: 0 })), configBlob: "config-A" })
    expect(first.merged).toEqual(["task/one"])
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/main/*:refs/yrd/main/*"])
    let records = await readRecords(
      w.git,
      (await refAt(w.git, changeRef("main", { branch: "task/two", head: second })))!,
    )
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked"])
    expect(records[1]?.trailers).toEqual(expect.arrayContaining([["Config", "config-A"]]))

    // The target's declaration changed: the on-submit checks run again under B
    // before the change merges, and the new checked record names B.
    const next = await queueRun({ ...(await w.options({ exit: 0 })), configBlob: "config-B" })
    expect(next.merged).toEqual(["task/two"])
    await w.git(["fetch", "--quiet", "origin", "+refs/yrd/main/*:refs/yrd/main/*"])
    records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/two", head: second })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked", "checked", "merged", "sent"])
    expect(records[2]?.trailers).toEqual(expect.arrayContaining([["Config", "config-B"]]))
  })
})

describe("an orphaned merge (@i/10-yrd/24344)", () => {
  it("a merge the queue itself composed, then never recorded, is caught up with its own run's attribution, not direct", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    // Two occurrences four hours apart (q-20260904T182922653Z,
    // q-20260904T145624104Z) were the run itself: this merge's own message
    // already carries the trailer a real crashed run's would.
    const message = [
      `merge task/one@${head.slice(0, 12)} into main`,
      "",
      `Change: task/one@${head}`,
      "Merged-By: yrd queue main [q-crashed-run]",
    ].join("\n")
    const merge = await composeMergeCandidate(w, head, message)
    // Simulates the atomic push having actually landed at the remote before
    // the run that made it died: the target carries it, nothing else does.
    await w.git(["push", "--quiet", "origin", `${merge}:refs/heads/main`])

    const outcome = await queueRun(await w.options({ exit: 0 }))

    expect(outcome.exitCode).toBe(0)
    expect(await remoteTarget(w)).toBe(merge)
    await fetchChanges(w)
    const ref = changeRef("main", { branch: "task/one", head })
    const records = await readRecords(w.git, (await refAt(w.git, ref))!)
    const mergedRecord = records.find((record) => record.kind === "merged")
    expect(mergedRecord).toBeDefined()
    expect(trailer(mergedRecord!, "Merge")).toBe(merge)
    // Recovered, not `direct`: the record must say which run actually made it.
    expect(trailer(mergedRecord!, "Merged-By")).toBe("yrd queue main [q-crashed-run]")
    expect(messages(w).filter((entry) => entry.record === "merged")).toHaveLength(1)
  })

  it("a merge the queue composed but never pushed before it died ends stuck with its own sha and an honest absorbed answer, never a blind retry", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const ref = changeRef("main", { branch: "task/one", head })
    // Take the change to "checked" directly, the shape a real on-submit judge
    // leaves (this run's own checks apply only at merge, ruling A1).
    await appendRemoteRecord(w.git, "main", {
      change: { branch: "task/one", head },
      kind: "checked",
      subject: `task/one passed the on-submit checks at main ${w.target.slice(0, 12)}`,
      trailers: [
        ["Config", "test-config"],
        ["Base", w.target],
      ],
    })

    // The crash window itself: composed, never pushed, its worktree left
    // standing exactly as `composeCandidate`'s `prepare` would leave it.
    const orphan = await composeMergeCandidate(w, head, `merge task/one@${head.slice(0, 12)} into main`)
    const worktreePath = await deadMergeWorktree(w, "q-dead-merge", head, orphan, exitedPid())

    const outcome = await queueRun(await w.options({ exit: 0 }))

    expect(outcome.exitCode).toBe(2)
    expect(outcome.stuck).toEqual(["task/one"])
    expect(outcome.failed).toEqual([])
    expect(outcome.merged).toEqual([])
    // Never redone: the target never moved, and the orphan worktree's commit
    // is exactly what this run found, nothing recomposed.
    expect(await remoteTarget(w)).toBe(w.target)
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, ref))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked", "stuck", "sent"])
    const stuckRecord = records[2]!
    const incident = incidentOf(stuckRecord)
    expect(incident.Code).toBe("yrd-merge-orphaned")
    expect(incident.Subject).toContain(orphan.slice(0, 12))
    expect(incident.Subject).toContain("not absorbed")
    expect(incident.Via).toContain(worktreePath)
    // The cure is the queue's recomposition, never a hand push: a reader who
    // pushes the orphan moves main around the queue and resets G1's
    // seven-day clock (@i/10-yrd/24344).
    expect(incident.Next).toContain("yrd queue run")
    expect(incident.Next).toContain("Never push")
    expect(incident.Next).not.toContain("push it onto")
    expect(trailer(stuckRecord, "Orphan")).toBe(orphan)
    expect(trailer(stuckRecord, "Absorbed")).toBe("no")
    expect(messages(w).filter((entry) => entry.record === "stuck")).toHaveLength(1)
  })

  it("never claims a worktree at the naming slot as this head's orphaned merge once its registration names a garbage sha, and proceeds through the ordinary path instead", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const ref = changeRef("main", { branch: "task/one", head })
    // Take the change to "checked" directly, exactly as the sibling case above.
    await appendRemoteRecord(w.git, "main", {
      change: { branch: "task/one", head },
      kind: "checked",
      subject: `task/one passed the on-submit checks at main ${w.target.slice(0, 12)}`,
      trailers: [
        ["Config", "test-config"],
        ["Base", w.target],
      ],
    })

    // A worktree at task/one's own naming slot, checked out cleanly, then its
    // OWN git-internal HEAD registration corrupted directly — the shape a
    // half-written or truncated worktree admin file leaves behind. Git's own
    // `worktree list` answers a garbage registration with the all-zero sha
    // rather than erroring, so this reaches `orphanedMergeCandidate`'s read
    // exactly as a real corrupted registration would.
    //
    // Verified separately (a scratch repo, not this fixture): a worktree
    // whose registration names an object that is simply MISSING poisons
    // every git fetch in the repository — including this run's own opening
    // fetch of its captured queue objects, which crashes long before
    // `orphanedMergeCandidate` ever runs. The all-zero sha does not, because
    // git recognizes it as its own placeholder rather than trying to resolve
    // it — the one shape of "unreadable" that isolates the read this test
    // means to exercise.
    const worktreePath = await deadMergeWorktree(w, "q-dead-merge-unreadable", head, w.target, exitedPid())
    const adminHead = join(w.work, ".git", "worktrees", head.slice(0, 12), "HEAD")
    if (!existsSync(adminHead)) {
      throw new Error(`fixture assumption failed: no worktree admin registration at ${adminHead} for ${worktreePath}`)
    }
    writeFileSync(adminHead, "this-is-not-a-sha-at-all\n")

    const outcome = await queueRun(await w.options({ exit: 0 }))

    // Not treated as an orphan recovery: the change proceeds through the
    // ordinary path and merges cleanly, exactly as if the unreadable
    // worktree were never there — never guessed into this change's evidence.
    expect(outcome.exitCode).toBe(0)
    expect(outcome.stuck).toEqual([])
    expect(outcome.merged).toEqual(["task/one"])
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, ref))!)
    expect(records.some((record) => record.kind === "stuck")).toBe(false)
    expect(records.every((record) => trailer(record, "Orphan") === undefined)).toBe(true)
  })

  it("never claims a worktree at the naming slot as this head's orphaned merge when its parents do not include this head, and proceeds through the ordinary path instead", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const ref = changeRef("main", { branch: "task/one", head })
    await appendRemoteRecord(w.git, "main", {
      change: { branch: "task/one", head },
      kind: "checked",
      subject: `task/one passed the on-submit checks at main ${w.target.slice(0, 12)}`,
      trailers: [
        ["Config", "test-config"],
        ["Base", w.target],
      ],
    })

    // A commit that never goes near the queue, purely to give the "wrong"
    // merge below a real, unrelated parent of its own.
    await w.git(["checkout", "--quiet", "-b", "shadow/other", "main"])
    writeFileSync(join(w.work, "other.txt"), "other.txt\n")
    await w.git(["add", "other.txt"])
    await w.git(["commit", "--quiet", "-m", "other.txt"])
    const otherHead = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])

    // A real merge commit, but of `otherHead`, never `head`: its parents are
    // [main tip, otherHead]. Placed at task/one's own naming slot — a stale
    // worktree left there by an entirely different head, never redone as if
    // it were task/one's own merge.
    const wrongMerge = await composeMergeCandidate(
      w,
      otherHead,
      `merge shadow/other@${otherHead.slice(0, 12)} into main`,
    )
    await deadMergeWorktree(w, "q-dead-merge-wrong-parent", head, wrongMerge, exitedPid())

    const outcome = await queueRun(await w.options({ exit: 0 }))

    expect(outcome.exitCode).toBe(0)
    expect(outcome.stuck).toEqual([])
    expect(outcome.merged).toEqual(["task/one"])
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, ref))!)
    expect(records.some((record) => record.kind === "stuck")).toBe(false)
    expect(records.every((record) => trailer(record, "Orphan") === undefined)).toBe(true)
  })
})

/**
 * A setup that fails wherever it runs while its marker exists, printing `line`
 * where the queue's classifier reads it. It records every run in the check log
 * beside the check's own rows, so a case can count judgements.
 *
 * With `once`, the settled base's own run — the second setup one failed
 * judgement makes, after the candidate's — clears the marker: a remote that
 * answers again by the time the round takes the change a second time. The
 * base is the worktree whose candidate IS its base, because nothing is composed
 * on top of the target there.
 */
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

/** A repository break the classifier must not read as an outage. */
const BROKEN_SETUP = "error: lockfile had changes, but lockfile is frozen"
/** Git's own line for a code host that is down: the transport signature the queue retries once. */
const UNREACHABLE_SETUP = "fatal: unable to access 'https://example.invalid/': The requested URL returned error: 504"

/**
 * How many times the queue ran its setup to JUDGE something, as the setup
 * recorded itself: the notify environment an ending prepares runs the same
 * setup, and it judges nothing.
 */
function setupRuns(w: World): number {
  return ranPrograms(w).filter((ran) => ran.program === "setup" && !ran.cwd.endsWith("/notify")).length
}

/** One change's records at the remote, oldest first. */
async function recordsOf(w: World, branch: string, head: string): Promise<readonly ChangeRecord[]> {
  await fetchChanges(w)
  return readRecords(w.git, (await refAt(w.git, changeRef("main", { branch, head })))!)
}

/**
 * @failure  A stuck head is stepped over: the round keeps judging and merging
 *           the line behind a change the queue could not judge, on ground nobody
 *           has judged since the fault, and the service keeps re-running the
 *           fault on a backoff until it clears itself. The operator's ruling
 *           (2026-09-16) is the andon: STUCK means fail loud and fix — stop the
 *           line, fix it (@i/10-yrd/a-unattended/stuck-stops-the-line).
 * @level    l2 (a real remote, a clone, a real check and setup)
 * @consumer every submitter behind a stuck change · the seat the page wakes
 */
describe("a stuck change stops the line (the andon, operator 2026-09-16)", () => {
  it("ends the round at the stuck head: nothing behind it is judged or merged, and the queue pauses naming the head", async () => {
    const w = await world()
    const headOne = await submitCommit(w, "task/one", "one.txt")
    const headTwo = await submitCommit(w, "task/two", "two.txt")

    const outcome = await queueRun(await w.options({ exit: 2, on: ["submit"] }))

    expect(outcome).toMatchObject({ exitCode: 2, failed: [], merged: [], stuck: ["task/one"] })
    expect(await remoteTarget(w)).toBe(w.target)
    // task/two was never even judged: no check ran in its head's worktree.
    const log = readFileSync(w.checkLog, "utf8")
    expect(log).toContain(`submit/${headOne.slice(0, 12)}`)
    expect(log).not.toContain(`submit/${headTwo.slice(0, 12)}`)
    expect((await recordsOf(w, "task/one", headOne)).map((record) => record.kind).slice(-2)).toEqual(["stuck", "sent"])
    expect((await recordsOf(w, "task/two", headTwo)).map((record) => record.kind)).toEqual(["opened"])
    // THE STOP IS A RECORD: the queue paused itself, and says for which change.
    const pause = await readPause(w.git, "origin", "main")
    expect(pause).toMatchObject({
      by: "yrd",
      cause: "stuck",
      change: { branch: "task/one", head: headOne },
      kind: "paused",
    })
    expect(outcome.stopped).toMatchObject({ ring: "pause", what: { cause: "stuck", sha: pause?.sha } })

    // And it holds: the next automatic round judges nothing, merges nothing.
    const held = await queueRun(await w.options({ exit: 2, on: ["submit"] }))
    expect(held).toMatchObject({ exitCode: 0, failed: [], merged: [], stuck: [] })
    expect(held.stopped?.what).toEqual(pause)
    expect(readFileSync(w.checkLog, "utf8")).toBe(log)
  })

  it("a check that exits 3, cannot-judge, stops the line too: the change is not billed and nothing behind it merges", async () => {
    // @cto 7645ec3a ruling 1: exit 3 used to end the change `failed` and keep
    // merging the line behind it, billing the submitter for a check that never
    // judged the change. It is stuck like any other could-not-judge.
    const w = await world()
    const head = await submitCommit(w, "task/cannot-judge", "one.txt")
    await submitCommit(w, "task/two", "two.txt")

    const outcome = await queueRun(await w.options({ exit: 3, on: ["submit"] }))

    expect(outcome).toMatchObject({ exitCode: 2, failed: [], merged: [], stuck: ["task/cannot-judge"] })
    expect(await remoteTarget(w)).toBe(w.target)
    const records = await recordsOf(w, "task/cannot-judge", head)
    expect(records.map((record) => record.kind)).not.toContain("failed")
    expect(records.flatMap((record) => record.trailers).filter(([name]) => name === "Fault")).toEqual([])
    expect(await readPause(w.git, "origin", "main")).toMatchObject({
      by: "yrd",
      cause: "stuck",
      change: { branch: "task/cannot-judge", head },
      kind: "paused",
    })
  })

  it("a bookkeeping stuck stops the line too, before the first judge", async () => {
    const w = await world()
    const headOne = await submitCommit(w, "task/one", "one.txt")
    await appendRemoteRecord(w.git, "main", {
      change: { branch: "task/one", head: headOne },
      kind: "checked",
      subject: `task/one passed the on-submit checks at main ${w.target.slice(0, 12)}`,
      trailers: [
        ["Config", "stale-config"],
        ["Base", w.target],
      ],
    })
    const orphan = await composeMergeCandidate(w, headOne, `merge task/one@${headOne.slice(0, 12)} into main`)
    await deadMergeWorktree(w, "q-dead-merge", headOne, orphan, exitedPid())
    const headTwo = await submitCommit(w, "task/two", "two.txt")

    const outcome = await queueRun(await w.options({ exit: 0 }))

    expect(outcome).toMatchObject({ exitCode: 2, failed: [], merged: [], stuck: ["task/one"] })
    expect(await remoteTarget(w)).toBe(w.target)
    const recordsOne = await recordsOf(w, "task/one", headOne)
    expect(recordsOne.map((record) => record.kind)).toEqual(["opened", "checked", "stuck", "sent"])
    expect(incidentOf(recordsOne[2]).Code).toBe("yrd-merge-orphaned")
    expect((await recordsOf(w, "task/two", headTwo)).map((record) => record.kind)).toEqual(["opened"])
    expect(whereRan(w)).toEqual([])
    expect(await readPause(w.git, "origin", "main")).toMatchObject({
      cause: "stuck",
      change: { branch: "task/one", head: headOne },
      kind: "paused",
    })
  })

  it("withdrawing the stuck change lifts the stop: the next round judges and merges the change behind it", async () => {
    const w = await world()
    const headOne = await submitCommit(w, "task/one", "one.txt")
    const headTwo = await submitCommit(w, "task/two", "two.txt")
    await queueRun(await w.options({ exit: 2, on: ["submit"] }))

    await withdraw(w.git, "origin", { branch: "task/one", by: "@chief", target: { branch: "main", remote: "origin" } })
    const outcome = await queueRun(await w.options({ exit: 2, on: ["submit"] }))

    expect(outcome.stopped).toBeUndefined()
    expect(outcome).toMatchObject({ exitCode: 0, failed: [], merged: ["task/two"], stuck: [] })
    expect(readFileSync(w.checkLog, "utf8")).toContain(`submit/${headTwo.slice(0, 12)}`)
    expect((await recordsOf(w, "task/one", headOne)).map((record) => record.kind).at(-1)).toBe("withdrawn")
  })

  it("merging the stuck change lifts the stop: it reaches the target, and the line behind it runs", async () => {
    const w = await world()
    const fault = faultySetup(w, BROKEN_SETUP)
    const headOne = await submitCommit(w, "task/one", "one.txt")
    await submitCommit(w, "task/two", "two.txt")
    const stuck = await queueRun(await w.options({ exit: 0, setup: fault.command }))
    expect(stuck.stuck).toEqual(["task/one"])

    // The repair, then the one round an operator may run on a stopped line.
    fault.clear()
    const repaired = await queueRun({ ...(await w.options({ exit: 0, setup: fault.command })), foreground: true })
    expect(repaired.merged).toEqual(["task/one"])
    expect(await w.git(["merge-base", "--is-ancestor", headOne, await remoteTarget(w)])).toBe("")

    // The change the stop named has left the line, so nothing holds it now.
    const after = await queueRun(await w.options({ exit: 0, setup: fault.command }))
    expect(after.stopped).toBeUndefined()
    expect(after.merged).toEqual(["task/two"])
  })

  it("a stuck change that ends failed lifts the stop too: any ending takes it out of line", async () => {
    const w = await world()
    const fault = faultySetup(w, BROKEN_SETUP)
    const headOne = await submitCommit(w, "task/one", "one.txt")
    const stuck = await queueRun(await w.options({ exit: 0, setup: fault.command }))
    expect(stuck.stuck).toEqual(["task/one"])

    // The repair, then an operator's round on the stopped line in which the
    // change's own check fails: an ending that is neither a merge nor a withdrawal.
    fault.clear()
    const judged = await queueRun({ ...(await w.options({ exit: 1, setup: fault.command })), foreground: true })
    expect(judged).toMatchObject({ failed: ["task/one"], stuck: [] })
    expect((await recordsOf(w, "task/one", headOne)).map((record) => record.kind)).toContain("failed")

    // Nothing holds the line now: a change submitted after the ending is
    // judged and merged by the next automatic round.
    await submitCommit(w, "task/two", "two.txt")
    const after = await queueRun(await w.options({ exit: 0, setup: fault.command }))
    expect(after.stopped).toBeUndefined()
    expect(after.merged).toEqual(["task/two"])
  })

  it("resume lifts a stuck stop; the line re-takes the stuck change first, and a second stuck stops it again", async () => {
    const w = await world()
    const fault = faultySetup(w, BROKEN_SETUP)
    const headOne = await submitCommit(w, "task/one", "one.txt")
    const headTwo = await submitCommit(w, "task/two", "two.txt")
    await queueRun(await w.options({ exit: 0, setup: fault.command }))
    const first = await readPause(w.git, "origin", "main")
    expect(first).toMatchObject({ cause: "stuck", kind: "paused" })

    await writePause(w.git, "origin", "main", { by: "@chief", kind: "resumed", reason: "setup repaired" })
    const again = await queueRun(await w.options({ exit: 0, setup: fault.command }))

    expect(again).toMatchObject({ exitCode: 2, merged: [], stuck: ["task/one"] })
    expect(ranPrograms(w).some((ran) => ran.cwd.includes(headTwo.slice(0, 12)))).toBe(false)
    const second = await readPause(w.git, "origin", "main")
    expect(second).toMatchObject({ cause: "stuck", change: { branch: "task/one", head: headOne }, kind: "paused" })
    expect(second?.sha).not.toBe(first?.sha)
    // The record shows the count: one stuck record per time it stopped the line.
    const kinds = (await recordsOf(w, "task/one", headOne)).map((record) => record.kind)
    expect(kinds.filter((kind) => kind === "stuck")).toHaveLength(2)
  })

  it("a remote that fails once is retried inside the round, and the change never sticks", async () => {
    const w = await world()
    const fault = faultySetup(w, UNREACHABLE_SETUP, { once: true })
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(await w.options({ exit: 0, setup: fault.command }))

    expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/one"], stuck: [] })
    expect((await recordsOf(w, "task/one", head)).some((record) => record.kind === "stuck")).toBe(false)
    // Never stopped: the only pause record is the one the merge's own fence writes.
    expect(await readPause(w.git, "origin", "main")).toMatchObject({ kind: "resumed" })
    expect(logRecords(outcome)).toContainEqual(
      expect.objectContaining({
        branch: "task/one",
        code: "yrd-setup-unreachable",
        kind: "warning",
        reason: "retried",
      }),
    )
  })

  it("a remote that fails twice sticks once, and its record says it was retried", async () => {
    const w = await world()
    const fault = faultySetup(w, UNREACHABLE_SETUP)
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(await w.options({ exit: 0, setup: fault.command }))

    expect(outcome).toMatchObject({ exitCode: 2, merged: [], stuck: ["task/one"] })
    // Two judgements, each a candidate setup and its settled base: one retry, never a third.
    expect(setupRuns(w)).toBe(4)
    const stuckRecords = (await recordsOf(w, "task/one", head)).filter((record) => record.kind === "stuck")
    expect(stuckRecords).toHaveLength(1)
    expect(incidentOf(stuckRecords[0]).Code).toBe("yrd-setup-unreachable")
    expect(trailer(stuckRecords[0]!, "Retried")).toBe("1")
  })

  it("a stuck the remote did not cause is never retried", async () => {
    const w = await world()
    const fault = faultySetup(w, BROKEN_SETUP)
    const head = await submitCommit(w, "task/one", "one.txt")

    await queueRun(await w.options({ exit: 0, setup: fault.command }))

    expect(setupRuns(w)).toBe(2)
    const stuckRecord = (await recordsOf(w, "task/one", head)).find((record) => record.kind === "stuck")
    expect(incidentOf(stuckRecord).Code).toBe("yrd-setup-unusable")
    expect(trailer(stuckRecord!, "Retried")).toBeUndefined()
  })
})

/**
 * @failure  An ended change is taken again: a failed or withdrawn chain goes
 *           back into a round because main moved under it, so a conflict is
 *           re-attempted on every new tip and judged, recorded and reported
 *           round after round.
 * @level    l2 (a real remote, a clone, the real notify entry)
 * @consumer every submitter whose change ended · stuck-stops-the-line row 5
 *           (@i/10-yrd/a-unattended/stuck-stops-the-line-revert-the-step-over-and-the-stuck-round-loop)
 */
describe("an ended change leaves the line for good", () => {
  it("an ended change is never re-judged, whatever main does", async () => {
    const w = await world()
    // The change edits the target's own line, and main edits that line first:
    // a conflict, the ending a moving main most invites the queue to retry.
    await w.git(["checkout", "--quiet", "-b", "task/conflict", "main"])
    writeFileSync(join(w.work, "target.txt"), "the change's line\n")
    await w.git(["add", "target.txt"])
    await w.git(["commit", "--quiet", "-m", "edit the target's line"])
    const head = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])
    await submit(w.git, "origin", {
      branch: "task/conflict",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
      issue: "@i/10-yrd/1",
    })
    writeFileSync(join(w.work, "target.txt"), "main's line\n")
    await w.git(["commit", "--quiet", "-am", "main edits the same line"])
    await w.git(["push", "--quiet", "origin", "main"])

    const ended = await queueRun(await w.options({ exit: 0 }))
    expect(ended).toMatchObject({ failed: ["task/conflict"], stuck: [] })
    const records = await recordsOf(w, "task/conflict", head)
    expect(trailer(records.find((record) => record.kind === "failed")!, "Reason")).toBe("conflict")
    // A WORKING notifier told the ending once, so nothing is owed a resend.
    expect(readFileSync(w.notifyLog, "utf8")).toContain("task/conflict")
    const ref = changeRef("main", { branch: "task/conflict", head })
    const endedAt = await refAt(w.git, ref)

    for (const file of ["later-one.txt", "later-two.txt"]) {
      await pushAroundQueue(w, file)
      const round = await queueRun(await w.options({ exit: 0 }))
      expect(round).toMatchObject({ failed: [], merged: [], stuck: [] })
      expect(
        logRecords(round).filter(
          (row) => row.branch === "task/conflict" && ["change", "check", "result"].includes(String(row.kind)),
        ),
      ).toEqual([])
    }
    await fetchChanges(w)
    expect(await refAt(w.git, ref)).toBe(endedAt)
  })
})

describe("withdraw takes one change out of the line (@i/10-yrd/24492)", () => {
  const TARGET = { branch: "main", remote: "origin" } as const

  it("ends the open change; the next run never judges it and merges the line behind", async () => {
    const w = await world()
    const headOne = await submitCommit(w, "task/one", "one.txt")
    await submitCommit(w, "task/two", "two.txt")

    const taken = await withdraw(w.git, "origin", {
      branch: "task/one",
      by: "@chief",
      reason: "superseded by task/two",
      target: TARGET,
    })

    expect(taken.withdrawn).toHaveLength(1)
    expect(taken.withdrawn[0]).toMatchObject({ branch: "task/one", head: headOne })
    // FAKE_EXIT=2 would stick task/one the moment it were judged, so a clean
    // exit 0 with task/two merged is the proof the withdrawn change left the
    // line rather than being stepped over.
    const outcome = await queueRun(await w.options({ exit: 2, on: ["submit"] }))
    expect(outcome).toMatchObject({ exitCode: 0, failed: [], merged: ["task/two"], stuck: [] })
    expect(readFileSync(w.checkLog, "utf8")).not.toContain(`submit/${headOne.slice(0, 12)}`)
    await fetchChanges(w)
    const records = await readRecords(
      w.git,
      (await refAt(w.git, changeRef("main", { branch: "task/one", head: headOne })))!,
    )
    expect(records.map((record) => record.kind)).toEqual(["opened", "withdrawn"])
    expect(trailer(records[1]!, "By")).toBe("@chief")
    // The operator's words are content: a Note, never the Reason vocabulary
    // the reader and the run branch on.
    expect(trailer(records[1]!, "Note")).toBe("superseded by task/two")
    expect(trailer(records[1]!, "Reason")).toBeUndefined()
  })

  it("refuses a change whose chain already ended, naming the ending", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")
    const outcome = await queueRun(await w.options({ exit: 0 }))
    expect(outcome.merged).toEqual(["task/one"])

    await expect(withdraw(w.git, "origin", { branch: "task/one", by: "@chief", target: TARGET })).rejects.toThrow(
      /already ended merged/u,
    )
  })

  // @i/10-yrd/24979. The specimen, 2026-09-18 00:34 PDT: `@dev/9` withdrew
  // task/24523-rows-5-7 on `@chief`'s ruling while round
  // q-20260918T073412029Z-de18ba52 was mid-judge on it. The check finished, the
  // `checked` write met 24635's ending rule, and the runner read that refusal
  // as a crash — pause cause=stuck, a page, and the line stopped, although the
  // ending had ALREADY lifted the stop, which is what `yrd queue resume` then
  // said. 24635's refusal is right; treating it as an unhandled error is the
  // defect. The ending wins, the verdict is discarded with a reason, the round
  // goes on.
  it("discards the verdict when a withdraw lands mid-check, and judges the rest of the round", async () => {
    const w = await world()
    const headOne = await submitCommit(w, "task/one", "one.txt")
    await submitCommit(w, "task/two", "two.txt")

    // The check is held open so the withdraw lands while the round is judging
    // task/one; `checkRunning` waits on the check's own word, not a delay.
    const running = queueRun(await w.options({ exit: 0, on: ["submit"], sleep: 2 }))
    await checkRunning(w)
    await withdraw(w.git, "origin", { branch: "task/one", by: "@chief", target: TARGET })
    const outcome = await running

    // The round did not stop: task/two was judged and merged behind it.
    expect(outcome).toMatchObject({ exitCode: 0, stuck: [] })
    expect(outcome.merged).toEqual(["task/two"])
    // Nothing paged, and no operator had to run `yrd queue resume` to be told
    // the stop was already lifted.
    expect(await refAt(w.git, PAUSE_REF)).toBeUndefined()
    // The ending stands alone: a discarded verdict writes no record, so the
    // withdrawn tip is what every reader sees.
    await fetchChanges(w)
    const records = await readRecords(
      w.git,
      (await refAt(w.git, changeRef("main", { branch: "task/one", head: headOne })))!,
    )
    expect(records.map((record) => record.kind)).toEqual(["opened", "withdrawn"])
    // Two checks each sleep FAKE_SLEEP=2s, so 4s of vitest's default 5s is fixed sleep and a loaded
    // host times out before the round ends; the budget is the check sleep plus the git work.
  }, 15_000)

  // The same race one phase later (24979 acceptance row 2). This one is worth
  // its own arm rather than a parameter, because the two phases fail
  // DIFFERENTLY if they fail: a discarded judgement loses a verdict, while a
  // merge that does not notice the ending LANDS A WITHDRAWN CHANGE on the
  // target — the ending undone by the run it raced.
  it("lets the ending win when a withdraw lands during the merge, and never lands the withdrawn change", async () => {
    const w = await world()
    const headOne = await submitCommit(w, "task/one", "one.txt")

    // No `on`, so the one check runs at merge (ruling A1): the change is
    // already judged, and the withdraw lands before the merge commits.
    const running = queueRun(await w.options({ exit: 0, sleep: 2 }))
    await checkRunning(w)
    await withdraw(w.git, "origin", { branch: "task/one", by: "@chief", target: TARGET })
    const outcome = await running

    expect(outcome).toMatchObject({ exitCode: 0, merged: [], stuck: [] })
    expect(await refAt(w.git, PAUSE_REF)).toBeUndefined()
    // The target never took it: the withdraw is an escape, and an escape the
    // queue can overrun is not an escape (ADR-0015).
    expect(await remoteTarget(w)).toBe(w.target)
    await fetchChanges(w)
    const records = await readRecords(
      w.git,
      (await refAt(w.git, changeRef("main", { branch: "task/one", head: headOne })))!,
    )
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked", "withdrawn"])
  })

  it("reports a merged change as merged, never withdrawn, once its branch has moved on", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")
    expect((await queueRun(await w.options({ exit: 0 }))).merged).toEqual(["task/one"])
    // The ordinary push after a merge: the branch moves on, the head stays merged.
    await w.git(["checkout", "--quiet", "task/one"])
    writeFileSync(join(w.work, "after.txt"), "after\n")
    await w.git(["add", "after.txt"])
    await w.git(["commit", "--quiet", "-m", "after"])
    await w.git(["push", "--quiet", "origin", "task/one"])
    await w.git(["checkout", "--quiet", "main"])

    const refused = await withdraw(w.git, "origin", { branch: "task/one", by: "@chief", target: TARGET }).then(
      () => "withdrew",
      (error: unknown) => String(error),
    )

    // The record is read before the branch, in the reader's own order.
    expect(refused).toMatch(/already ended merged at [0-9a-f]{12}/u)
    expect(refused).not.toMatch(/withdrawn \(replaced\)/u)
  })

  it("refuses a branch with no change at all, and says where it looked", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")

    await expect(withdraw(w.git, "origin", { branch: "task/ghost", by: "@chief", target: TARGET })).rejects.toThrow(
      /no change for task\/ghost/u,
    )
  })

  it("a resubmit after a withdrawal re-opens the chain and lands", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    await withdraw(w.git, "origin", { branch: "task/one", by: "@chief", target: TARGET })

    await submit(w.git, "origin", {
      branch: "task/one",
      submitter: "@dev/2",
      target: TARGET,
      issue: "@i/10-yrd/1",
    })
    const outcome = await queueRun(await w.options({ exit: 0 }))

    expect(outcome.merged).toEqual(["task/one"])
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "withdrawn", "opened", "checked", "merged", "sent"])
  })

  it("a branch deleted after its withdrawal is left as it ended, never retired on top", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    await withdraw(w.git, "origin", { branch: "task/one", by: "@chief", target: TARGET })
    await w.git(["push", "--quiet", "origin", ":refs/heads/task/one"])

    const outcome = await queueRun(await w.options({ exit: 0 }))

    expect(outcome).toMatchObject({ exitCode: 0, failed: [], merged: [], stuck: [] })
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "withdrawn"])
  })

  it("a superseded carrier: withdraw ends the head the branch still carries and leaves the replaced head to the reader", async () => {
    const w = await world()
    const first = await submitCommit(w, "task/one", "one.txt")
    await w.git(["checkout", "--quiet", "task/one"])
    writeFileSync(join(w.work, "more.txt"), "more\n")
    await w.git(["add", "more.txt"])
    await w.git(["commit", "--quiet", "-m", "more"])
    const second = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])
    await submit(w.git, "origin", { branch: "task/one", submitter: "@dev/2", target: TARGET, issue: "@i/10-yrd/1" })

    const taken = await withdraw(w.git, "origin", { branch: "task/one", by: "@chief", target: TARGET })

    // Only the open head gets the record; the replaced head already reads
    // withdrawn by derivation and the next run records that itself.
    expect(taken.withdrawn.map((one) => one.head)).toEqual([second])
    await fetchChanges(w)
    const firstRef = changeRef("main", { branch: "task/one", head: first })
    expect((await readRecords(w.git, (await refAt(w.git, firstRef))!)).map((record) => record.kind)).toEqual(["opened"])
    const outcome = await queueRun(await w.options({ exit: 0 }))
    expect(outcome).toMatchObject({ exitCode: 0, failed: [], merged: [], stuck: [] })
    await fetchChanges(w)
    const retired = await readRecords(w.git, (await refAt(w.git, firstRef))!)
    expect(retired.map((record) => record.kind)).toEqual(["opened", "withdrawn"])
    expect(trailer(retired[1]!, "Reason")).toBe("replaced")
    const queue = await readQueue(w.git, "origin", "main", await remoteTarget(w))
    const states = new Map(queue.changes.map((entry) => [entry.change.head, entry.reading]))
    expect(states.get(first)).toMatchObject({ reason: "replaced", state: "withdrawn" })
    expect(states.get(second)).toMatchObject({ state: "withdrawn" })
  })

  it("a stuck record names its four cures: withdraw it, replace its head with a fix, merge a queued fix, or resume the repaired queue", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(await w.options({ exit: 2, on: ["submit"] }))

    expect(outcome.stuck).toEqual(["task/one"])
    await fetchChanges(w)
    const records = await readRecords(
      w.git,
      (await refAt(
        w.git,
        (await w.git(["ls-remote", "--refs", "origin", `${CHANGES}/task/one@*`])).trim().split(/\s+/u)[1]!,
      ))!,
    )
    const stuckRecord = records.find((record) => record.kind === "stuck")
    const incident = incidentOf(stuckRecord)
    expect(incident.Next).toContain("yrd queue withdraw task/one")
    expect(incident.Next).toContain("clears this reason")
    expect(incident.Next).toContain("the same content sticks on the same ground")
    // The third cure is a fix already in line: merged on its own, and the stuck change judged again after it.
    expect(incident.Next).toContain("merge a queued fix with yrd merge <its branch>")
    expect(incident.Next).toContain("then task/one is judged once more")
    // The fourth cure is the operator's, for a stop the queue itself caused.
    expect(incident.Next).toContain("yrd queue resume")
  })
})

describe("the target's setup", () => {
  it("runs once in every worktree the run makes, before anything judges it", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(await w.options({ exit: 0, setup: w.setupCommand(0) }))

    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/one"])
    const order = whereRan(w)
    // Submit, merge, and one captured-base notification environment each run setup once.
    const prepared = order.filter(([what]) => what === "setup").map(([, where]) => where)
    expect(prepared).toHaveLength(3)
    expect(new Set(prepared).size).toBe(3)
    everyCheckWasPrepared(order)
    // The setup is recorded in a check's own shape, billed to the queue.
    expect(logRecords(outcome).filter((record) => record.kind === "result" && record.name === "setup")).toMatchObject([
      { exit: "0", name: "setup", phase: "submit", result: "pass" },
      { exit: "0", name: "setup", phase: "merge", result: "pass" },
      { exit: "0", name: "setup", phase: "notify", result: "pass" },
    ])
    // Three setups, each with a start and an end row.
    const setupRows = logRecords(outcome).filter((record) => record.kind === "check" && record.name === "setup")
    expect(setupRows).toHaveLength(6)
    expect(setupRows.filter((record) => record.end === undefined)).toHaveLength(3)
  })

  /**
   * @i/10-yrd/25303 box 1. A compose is one git-super process whose settle rows
   * are written only after it returns, and a prepare and the queue read had no
   * rows of their own: on the garage each was a 20 to 28 s silence in the run
   * journal. Each is now a timed `step`: a start row, then an end row with `ms`.
   * The compose here is made slow on purpose, so the end row's `ms` is shown to
   * span the step rather than to exist.
   */
  it("brackets the queue read, each compose and each prepare with timed step rows (25303 box 1)", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")
    const slowMs = 300
    await using runner = createProcess({ cwd: w.work })
    const slowCompose = {
      ...runner,
      run: async (request: Parameters<typeof runner.run>[0]) => {
        if (request.argv.includes("super") && request.argv.includes("merge")) {
          await new Promise((resolve) => setTimeout(resolve, slowMs))
        }
        return runner.run(request)
      },
    }

    const outcome = await queueRun({
      ...(await w.options({ exit: 0, setup: w.setupCommand(0) })),
      process: slowCompose,
    })

    expect(outcome.merged).toEqual(["task/one"])
    const records = logRecords(outcome)
    const at = (predicate: (record: Record<string, unknown>) => boolean) => records.findIndex(predicate)
    const bracketed = (name: string, phase: string) => {
      const start = at((row) => row.kind === "step" && row.name === name && row.phase === phase && row.ms === undefined)
      const end = at(
        (row) =>
          row.kind === "step" &&
          row.name === name &&
          row.phase === phase &&
          typeof row.ms === "number" &&
          row.start === records[start]?.start,
      )
      return { start, end, ms: records[end]?.ms }
    }
    for (const [name, phase] of [
      ["read", "run"],
      ["compose", "submit"],
      ["prepare", "submit"],
      ["compose", "merge"],
      ["prepare", "merge"],
    ] as const) {
      const step = bracketed(name, phase)
      expect({ name, phase, started: step.start >= 0 }).toEqual({ name, phase, started: true })
      expect({ name, phase, endsAfterStart: step.end > step.start }).toEqual({ name, phase, endsAfterStart: true })
    }
    // A compose ends before the prepare that uses its merge commit starts, in both phases.
    for (const phase of ["submit", "merge"]) {
      expect(bracketed("compose", phase).end).toBeLessThan(bracketed("prepare", phase).start)
      expect(bracketed("compose", phase).ms).toBeGreaterThanOrEqual(slowMs)
    }
    expect(records.filter((row) => row.kind === "step" && row.threw === true)).toEqual([])
  })

  /**
   * @i/10-yrd/25303 tier 2. Box 1's compose row spans the whole git-super call
   * and says nothing about what inside it was slow. git-super now reports each
   * of its phases with a duration, and the round writes them: one `step` row per
   * phase, `within: "compose"`, after the compose's end row and before the
   * prepare that follows it. The compose's own worktree is timed as a step
   * inside the compose, so the two together account for the whole span.
   */
  it("writes git-super's own phases after each compose and times the compose worktree (25303 tier 2)", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(await w.options({ exit: 0, setup: w.setupCommand(0) }))

    expect(outcome.merged).toEqual(["task/one"])
    const records = logRecords(outcome)
    const at = (predicate: (record: Record<string, unknown>) => boolean) => records.findIndex(predicate)
    for (const phase of ["submit", "merge"]) {
      const step = (name: string, end: boolean) =>
        at(
          (row) =>
            row.kind === "step" &&
            row.name === name &&
            row.phase === phase &&
            (row.ms !== undefined) === end &&
            row.within === undefined,
        )
      const composeStart = step("compose", false)
      const composeEnd = step("compose", true)
      const worktreeStart = step("worktree", false)
      const worktreeEnd = step("worktree", true)
      expect({
        phase,
        order: [composeStart, worktreeStart, worktreeEnd, composeEnd].every(
          (i, n, all) => i >= 0 && (n === 0 || i > (all[n - 1] ?? -1)),
        ),
      }).toEqual({ phase, order: true })

      const inside = records
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => row.kind === "step" && row.phase === phase && row.within === "compose")
      // git-super's closed list, in the order its phases run.
      expect(inside.map(({ row }) => row.name)).toEqual([
        "preflight",
        "merge-tree",
        "plan",
        "capture",
        "checkouts",
        "merge",
        "settle",
        "commit",
      ])
      for (const { row, index } of inside) {
        expect(row).toMatchObject({ branch: "task/one", head: expect.any(String), ms: expect.any(Number) })
        expect(index).toBeGreaterThan(composeEnd)
        expect(index).toBeLessThan(step("prepare", false))
      }
    }
  })

  /**
   * A run that dies removes nothing, so its worktrees stay registered in the
   * repository and on disk, and every later `git worktree list` carries them:
   * R8's did (plan § Owed after M5). The next run takes them down.
   *
   * Alive means this run, or a pid file naming a process that is running —
   * nothing else, because a worktree registration outlives the process that
   * made it and git has no other answer. The pair below is the discriminating
   * read: two worktrees, identical but for whose pid claims them.
   */
  it("removes the worktrees of runs that are no longer alive, and leaves a living run's alone", async () => {
    const w = await world()
    const dead = await worktreeOfRun(w, "q-dead", exitedPid())
    const alive = await worktreeOfRun(w, "q-alive", process.pid)

    const outcome = await queueRun(await w.options({ exit: 0 }))

    expect(existsSync(dead)).toBe(false)
    expect(existsSync(join(w.workdir, "worktrees", "q-dead"))).toBe(false)
    expect(existsSync(alive)).toBe(true)
    const registered = await w.git(["worktree", "list", "--porcelain"])
    expect(registered).not.toContain(dead)
    expect(registered).toContain(alive)

    // One row per worktree taken, naming it, whose it was and why it went.
    expect(logRecords(outcome).filter((record) => record.kind === "reap")).toEqual([
      expect.objectContaining({ of: "q-dead", path: dead, why: expect.stringContaining("is not running") }),
    ])
  })

  /** A run that ends takes its own directory with it, so the reap reads exactly the runs that did not end. */
  it("leaves nothing of its own under the worktrees root when it ends", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(await w.options({ exit: 0 }))

    expect(outcome.exitCode).toBe(0)
    expect(existsSync(join(w.workdir, "worktrees", outcome.run))).toBe(false)
  })

  it("runs again in the target worktree the attribution builds", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")

    // One worktree per phase, and only two phases: the change's head at
    // submit, and the head merged onto the target at merge.
    const outcome = await queueRun(await w.options({ everywhere: true, exit: 1, setup: w.setupCommand(0) }))

    expect(outcome.exitCode).toBe(1)
    expect(outcome.failed).toEqual(["task/one"])
    const order = whereRan(w)
    const prepared = order.filter(([what]) => what === "setup").map(([, where]) => where)
    expect(prepared).toHaveLength(3)
    expect(new Set(prepared).size).toBe(3)
    everyCheckWasPrepared(order)
    expect(
      logRecords(outcome)
        .filter((record) => record.kind === "result" && record.name === "setup")
        .map((record) => record.phase),
    ).toEqual(["submit", "merge", "notify"])
  })

  it("a setup that fails ends the change stuck, never failed, and nothing is judged in that worktree", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(await w.options({ exit: 0, setup: w.setupCommand(1) }))

    // Stuck, exit 2: this setup fails on the settled base too, so the queue
    // could not build the ground a judgement stands on and nobody is billed.
    expect(outcome.exitCode).toBe(2)
    expect(outcome.stuck).toEqual(["task/one"])
    expect(outcome.failed).toEqual([])
    expect(await remoteTarget(w)).toBe(w.target)
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "stuck", "sent"])
    expect(incidentOf(records[1])).toMatchObject({ Code: "yrd-setup-unusable" })
    expect(records[1]?.trailers.filter(([name]) => name === "Fault")).toEqual([])
    // The check never ran: there was no prepared tree to run it in.
    expect(whereRan(w).filter(([what]) => what === "check")).toEqual([])
    expect(messages(w)).toEqual([])
    expect(trailer(records.at(-1)!, "Delivery")).toBe("failed")
    expect(logRecords(outcome).filter((record) => record.kind === "message")).toMatchObject([
      { delivered: false, error: expect.stringContaining("could not run") },
    ])
    expect(logRecords(outcome).filter((record) => record.kind === "result" && record.name === "setup")).toMatchObject([
      { exit: "1", phase: "base", result: "fail", whose: "queue" },
      { exit: "1", phase: "submit", result: "fail", whose: "queue" },
      { exit: "1", phase: "notify", result: "fail", whose: "queue" },
    ])
  })

  /**
   * Run q-20260910T051200413Z-adf158d1, 2026-09-09 22:12 PDT: a submitter's
   * head added a workspace package without its lockfile, the target's `bun
   * install --frozen-lockfile` refused in the submit phase, and the whole
   * service went down exit 2 with the queue billed. The same setup passed on
   * the settled base, so the queue's ground was never broken — one change's
   * content was, and every other change in line waited for a person.
   */
  it("bills the submitter when the setup fails only with the candidate's own content", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/breaks-setup", "BREAK_SETUP")
    await submitCommit(w, "task/two", "two.txt")

    // Passes on any tree but the candidate's: the settled base carries none of
    // the candidate's authored content, so it is the discriminating reading.
    const outcome = await queueRun(
      await w.options({ exit: 0, setup: `echo "setup cwd=$(pwd)" >> ${w.checkLog} && test ! -e BREAK_SETUP` }),
    )

    // The ordinary failed path: exit 1, not 2, and the run went on to judge and
    // merge the next change in line rather than stopping for a person.
    expect(outcome.exitCode).toBe(1)
    expect(outcome.failed).toEqual(["task/breaks-setup"])
    expect(outcome.stuck).toEqual([])
    expect(outcome.merged).toEqual(["task/two"])

    await fetchChanges(w)
    const ref = changeRef("main", { branch: "task/breaks-setup", head })
    const records = await readRecords(w.git, (await refAt(w.git, ref))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "failed", "sent"])
    const failed = records[1]!
    expect(trailer(failed, "Fault")).toBe("submitter")
    expect(trailer(failed, "Reason")).toBe("setup")
    // The reading the attribution stands on, in the record itself.
    expect(trailer(failed, "Base-Setup")).toBe("passed")
    expect(records[1]?.trailers.filter(([name]) => name === "Code")).toEqual([])
    // The setup's own diagnosis and the log a person reads it in.
    const log = checkLogFor(outcome, "task/breaks-setup", "submit", "setup")
    expect(failed.subject).toContain(log)
    expect(trailer(failed, "Remedy")).toContain(log)
    expect(trailer(failed, "Check")).toContain(`log=${log}`)
    expect(existsSync(log)).toBe(true)
    // The setup ran once more, in a worktree of the settled base alone.
    expect(
      whereRan(w).filter(([what, where]) => what === "setup" && where.includes(join("worktrees", outcome.run, "base"))),
    ).toHaveLength(1)
    // The base's own rows are journaled like any other setup, and the
    // candidate's verdict says who the base named.
    expect(
      logRecords(outcome).filter(
        (record) => record.kind === "result" && record.name === "setup" && record.head === head,
      ),
    ).toMatchObject([
      { exit: "0", phase: "base", result: "pass" },
      { exit: "1", phase: "submit", result: "fail", whose: "submitter" },
    ])
    expect(
      logRecords(outcome).filter(
        (record) => record.kind === "check" && record.name === "setup" && record.phase === "base",
      ),
    ).toHaveLength(2)
    expect(messages(w)[0]).toMatchObject({
      change: changeName({ branch: "task/breaks-setup", head }),
      log,
      reason: "setup",
      record: "failed",
      submitter: "@dev/2",
    })
  })

  it("keeps the queue's stuck when the same setup fails on the settled base too", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(await w.options({ exit: 0, setup: "false" }))

    // The ground itself is broken: nobody is billed and the run stops there.
    expect(outcome.exitCode).toBe(2)
    expect(outcome.stuck).toEqual(["task/one"])
    expect(outcome.failed).toEqual([])
    expect(await remoteTarget(w)).toBe(w.target)
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "stuck", "sent"])
    const incident = incidentOf(records[1])
    expect(incident.Code).toBe("yrd-setup-unusable")
    expect(incident.Via).toContain("failed on the settled base alone too")
    expect(records[1]?.trailers.filter(([name]) => name === "Fault" || name === "Base-Setup")).toEqual([])
    expect(
      logRecords(outcome).filter(
        (record) => record.kind === "result" && record.name === "setup" && record.head === head,
      ),
    ).toMatchObject([
      { exit: "1", phase: "base", result: "fail", whose: "queue" },
      { exit: "1", phase: "submit", result: "fail", whose: "queue" },
    ])
  })

  it("keeps a setup failure longer than 400 characters lossless in the authoritative incident", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const tail = "THE-END-OF-THE-SETUP-FAILURE"
    const missing = `no-such-setup-command ${"x".repeat(450)}${tail}`

    await queueRun(await w.options({ exit: 0, setup: missing }))

    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    const incident = incidentOf(records.find((record) => record.kind === "stuck"))
    expect(incident.Code).toBe("yrd-setup-unusable")
    expect(incident.Subject).toContain(tail)
    expect(incident.Subject.length).toBeGreaterThan(400)
    expect(incidentOf(records.at(-1))).toEqual(incident)
  })

  // @i/10-yrd/24140: a failed `bun install --frozen-lockfile` used to print
  // bun's own contentless "lockfile had changes, but lockfile is frozen" —
  // never naming which dependency moved. Four identical stops of that exact
  // shape cost a 3h51m outage on 2026-09-04. This drives a REAL frozen-lockfile
  // refusal (no mock, no stub setup script) and proves the entry that moved is
  // now named, with both specifiers, plus where the diagnosis looked.
  it("names every entry a frozen bun install could not, plus where it looked", async () => {
    const w = await world()
    const { head } = await submitRaisedDependency(w, "task/raise-widget", "widget", "1.0.0", "1.1.0")

    const outcome = await queueRun(await w.options({ exit: 0, setup: "bun install --frozen-lockfile" }))

    // The candidate's own manifest is what the lockfile disagrees with, and the
    // same setup passes on the settled base: the submitter's, exit 1, the queue
    // still standing. This diagnosis is advisory and never changes that
    // verdict, only what the ending says about it.
    expect(outcome.exitCode).toBe(1)
    expect(outcome.failed).toEqual(["task/raise-widget"])
    expect(outcome.stuck).toEqual([])
    await fetchChanges(w)
    const records = await readRecords(
      w.git,
      (await refAt(w.git, changeRef("main", { branch: "task/raise-widget", head })))!,
    )
    expect(records.map((record) => record.kind)).toEqual(["opened", "failed", "sent"])
    const failed = records[1]!
    expect(trailer(failed, "Fault")).toBe("submitter")
    expect(trailer(failed, "Base-Setup")).toBe("passed")
    // AC1: the entry that moved, by NAME, with its before and after specifier.
    expect(failed.subject).toContain("widget: widget@file:vendor-1.0.0 -> widget@file:vendor-1.1.0")
    // AC2: where it looked — the lockfile, the manifest(s), the worktree root.
    expect(failed.subject).toContain("bun.lock")
    expect(failed.subject).toContain("package.json")
    expect(failed.subject).toContain("worktree root")
    // AC3: the submitter hears it, rather than a person finding a stopped
    // queue. (The fixture's own lockfile seed went around the queue, so the
    // first message this run sends is that direct merge.)
    expect(messages(w).find((message) => message.record === "failed")).toMatchObject({
      reason: "setup",
      submitter: "@dev/2",
    })
  })

  it("a setup past its bound is stuck too, and the change is never billed", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    // 127 is the shell's own word for a command it could not find: a setup the
    // target names and the worktree does not have is the queue's, like any
    // other setup that did not pass.
    const outcome = await queueRun(await w.options({ exit: 0, setup: "no-such-setup-command" }))

    expect(outcome.exitCode).toBe(2)
    expect(outcome.stuck).toEqual(["task/one"])
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "stuck", "sent"])
    expect(incidentOf(records[1])).toMatchObject({ Code: "yrd-setup-unusable" })
    expect(logRecords(outcome).filter((record) => record.kind === "result" && record.name === "setup")).toMatchObject([
      { exit: "missing", phase: "base", result: "stuck", whose: "queue" },
      { exit: "missing", phase: "submit", result: "stuck", whose: "queue" },
      { exit: "missing", phase: "notify", result: "stuck", whose: "queue" },
    ])
  })
})

/**
 * A failing check ends the change failed at once, and runs ONCE.
 *
 * It used to be run again in the change's worktree and once more at the target
 * before anyone was billed, so a flake or a red target ended the change stuck.
 * Measured over 257 check runs since flag day that reading changed no verdict:
 * 7 second runs all failed again, 14 target runs all passed (operator ruling
 * 2026-09-03). What is left is the cost it charged every failure.
 */
describe("a failing check bills the submitter at once", () => {
  it("ends the change failed with the check and its log, having run the check once", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(await w.options({ exit: 1, on: ["submit"] }))

    expect(outcome.exitCode).toBe(1)
    expect(outcome.failed).toEqual(["task/one"])
    expect(outcome.stuck).toEqual([])
    expect(await remoteTarget(w)).toBe(w.target)
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "failed", "sent"])
    expect(records[1]?.trailers).toEqual(
      expect.arrayContaining([
        ["Reason", "verify"],
        ["Fault", "submitter"],
      ]),
    )
    expect(records[1]?.trailers.filter(([name]) => name === "Check").map(([, value]) => value)).toEqual([
      expect.stringMatching(/^verify exit=1 ms=\d+ log=\S+$/u),
    ])
    expect(messages(w)[0]).toMatchObject({
      record: "failed",
      failures: 1,
      reason: "verify",
      submitter: "@dev/2",
    })
    // The log the check wrote is named in the record, so a notifier says where to look.
    expect(messages(w)[0]?.log).toBe(checkLogFor(outcome, "task/one", "submit", "verify"))
    // ONE run of the one check. Two more — the second in the change's worktree
    // and one at a whole worktree of the target — is what this deleted.
    expect(whereRan(w)).toHaveLength(1)
  })

  it("counts this branch's failures, so a second send-back can raise an andon", async () => {
    const w = await world()
    await submitCommit(w, "task/one", "one.txt")
    expect((await queueRun(await w.options({ exit: 1, on: ["submit"] }))).failed).toEqual(["task/one"])
    expect(messages(w).at(-1)).toMatchObject({ record: "failed", failures: 1 })

    // The author pushes a new head on the same branch and submits it again.
    await w.git(["checkout", "--quiet", "task/one"])
    writeFileSync(join(w.work, "two.txt"), "two\n")
    await w.git(["add", "two.txt"])
    await w.git(["commit", "--quiet", "-m", "two"])
    await w.git(["checkout", "--quiet", "main"])
    await submit(w.git, "origin", {
      branch: "task/one",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
      issue: "@i/10-yrd/1",
    })

    expect((await queueRun(await w.options({ exit: 1, on: ["submit"] }))).failed).toEqual(["task/one"])

    // Two: the change that failed under the old head, and this one.
    expect(messages(w).at(-1)).toMatchObject({ record: "failed", failures: 2 })

    // A concurrent local poison must not choose either the ending's parent or
    // the immutable ending record used to count this message's failures.
    await submit(w.git, "origin", {
      branch: "task/one",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
      issue: "@i/10-yrd/1",
    })
    const currentHead = (await refAt(w.git, "refs/heads/task/one"))!
    const ref = changeRef("main", { branch: "task/one", head: currentHead })
    let poisoned = false
    const git: Git = async (args, input) => {
      const output = await w.git(args, input)
      if (!poisoned && args[0] === "merge-base") {
        await w.git(["update-ref", ref, currentHead])
        poisoned = true
      }
      return output
    }
    Object.assign(git, { selection: selectionFor(w.git) })
    const retried = await queueRun({ ...(await w.options({ exit: 1, on: ["submit"] })), git })
    expect(poisoned).toBe(true)
    expect(messages(w).at(-1)).toMatchObject({ record: "failed", failures: 3 })
    expect(logRecords(retried)).not.toContainEqual(expect.objectContaining({ reason: "change-ref-taken" }))
    expect(await refAt(w.git, ref)).toBe(currentHead)
    await fetchChanges(w)
    expect((await readRecords(w.git, (await refAt(w.git, ref))!)).at(-1)?.kind).toBe("sent")
  })

  it("a check that is red at the target too still bills the submitter, and the queue keeps running", async () => {
    // The old reading called this `inherited` and stopped the queue on it. The
    // target is proven green by its own last merge; a red one is a person's
    // problem, not a reason to hold every change behind it.
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")

    const outcome = await queueRun(await w.options({ everywhere: true, exit: 1, on: ["submit"] }))

    expect(outcome.exitCode).toBe(1)
    expect(outcome.failed).toEqual(["task/one"])
    expect(outcome.stuck).toEqual([])
    await fetchChanges(w)
    expect(
      (await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)).map(
        (record) => record.kind,
      ),
    ).toEqual(["opened", "failed", "sent"])
    expect(whereRan(w)).toHaveLength(1)
  })
})

/**
 * A gitlink standing at a commit its own remote does not hold has two causes
 * with opposite owners, and for one night the queue billed both to itself: a
 * component commit that never left an author's bay stopped every change in
 * line, waiting for a person (specimen 2026-09-03, km gitlink 11d9312c).
 *
 * The probe that separates them is unit-tested in reference.test.ts, both
 * branches. What these two prove is the half that only a real run can show:
 * which ENDING each cause reaches through `guarded()`, and what the change's
 * own record then says about who is billed.
 */
describe("a gitlink the component's remote does not hold", () => {
  /** The world's target, carrying one gitlink at a commit nothing pushed. */
  async function withUnpushedGitlink(w: World): Promise<Readonly<{ child: string; unpushed: string }>> {
    const child = join(w.workdir, "child")
    mkdirSync(w.workdir, { recursive: true })
    await w.git(["init", "--quiet", "--initial-branch=main", child])
    const childGit = gitIn(child)
    await childGit(["config", "user.email", "queue@yrd.test"])
    await childGit(["config", "user.name", "yrd"])
    writeFileSync(join(child, "child.txt"), "published\n")
    await childGit(["add", "."])
    await childGit(["commit", "--quiet", "-m", "child, published"])
    // The bay: a clone that commits and never pushes, which is the whole
    // specimen. The commit exists, is reachable by its author, and is on no
    // remote anywhere.
    const bay = join(w.workdir, "child-bay")
    await w.git(["clone", "--quiet", child, bay])
    const bayGit = gitIn(bay)
    await bayGit(["config", "user.email", "queue@yrd.test"])
    await bayGit(["config", "user.name", "yrd"])
    writeFileSync(join(bay, "child.txt"), "only in the bay\n")
    await bayGit(["commit", "--quiet", "-am", "child, unpushed"])
    const unpushed = (await bayGit(["rev-parse", "HEAD"])).trim()
    for (const [key, value] of [
      ["path", "packages/child"],
      ["url", child],
      ["branch", "main"],
    ] as const) {
      await w.git(["config", "-f", ".gitmodules", `submodule.child.${key}`, value])
    }
    await w.git(["add", ".gitmodules"])
    await w.git(["update-index", "--add", "--cacheinfo", `160000,${unpushed},packages/child`])
    await w.git(["commit", "--quiet", "-m", "declare a child at a commit nobody pushed"])
    await w.git(["push", "--quiet", "origin", "main"])
    return { child, unpushed }
  }

  it("fails the change and bills its submitter when the remote answers and lacks the pin", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    // The change was accepted before target main gained this unavailable pin.
    const { child, unpushed } = await withUnpushedGitlink(w)

    const outcome = await queueRun(await w.options({ exit: 0 }))

    // Exit 1, not 2: nothing about the queue is repaired by stopping it, so
    // the line moves on to the next change.
    expect(outcome.exitCode).toBe(1)
    expect(outcome.failed).toEqual(["task/one"])
    expect(outcome.stuck).toEqual([])
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "failed", "sent"])
    const failed = records[1]
    expect(failed?.subject).toContain(`packages/child at ${unpushed} is not on ${child}`)
    // What was READ, so the record answers "why is a missing pin the
    // submitter's here" without its reader going to the journal.
    expect(trailer(failed!, "Remote-Answered")).toBe("yes")
    expect(trailer(failed!, "Gitlink")).toBe(`packages/child@${unpushed}`)
    expect(trailer(failed!, "Fault")).toBe("submitter")
    expect(trailer(failed!, "Remedy")).toContain("resubmit from the checkout that holds the commit")
  })

  it("sticks the change on the queue when the remote cannot be reached either", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const { child } = await withUnpushedGitlink(w)
    // Nothing answers, so nothing can be attributed, so nobody is billed.
    rmSync(child, { force: true, recursive: true })

    const outcome = await queueRun(await w.options({ exit: 0 }))

    expect(outcome.exitCode).toBe(2)
    expect(outcome.stuck).toEqual(["task/one"])
    expect(outcome.failed).toEqual([])
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    const stuck = records.find((record) => record.kind === "stuck")
    expect(incidentOf(stuck).Code).toBe("yrd-reference-unpopulated")
    // A stuck bills nobody, and says so by saying nothing.
    expect(records.flatMap((record) => record.trailers.filter(([name]) => name === "Fault"))).toEqual([])
  })
})

/**
 * @failure A delivery failure carrying a line break is refused at record-write time and
 *          takes the whole run down, replacing the record that says what happened with none.
 *
 * One trailer is one line (`recordMessage` in legacy-records.ts). Two producers feed
 * `Delivery-Error` and only one was safe: a notifier that EXITS non-zero has
 * its output collapsed where it is read, while a notifier that could not RUN
 * carries the thrown message verbatim — and a spawn or timeout message is
 * routinely several lines.
 */
describe("a notify entry that could not run at all", () => {
  it("records its multi-line failure on one line instead of crashing the run", async () => {
    const w = await world()
    const head = await submitCommit(w, "task/one", "one.txt")
    const thrown = "spawn failed\n  at the first frame\n  at the second frame"
    await using runner = createProcess({ cwd: w.work })
    const failingNotifier = {
      ...runner,
      run: async (request: Parameters<typeof runner.run>[0]) => {
        if (request.argv.join(" ").includes(w.notifier)) throw new Error(thrown)
        return runner.run(request)
      },
    }

    const outcome = await queueRun({ ...(await w.options({ exit: 0 })), process: failingNotifier })

    // The ending itself is decided before anything is delivered, so a delivery
    // that could not happen must not change it — and must not lose it either.
    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/one"])
    await fetchChanges(w)
    const records = await readRecords(w.git, (await refAt(w.git, changeRef("main", { branch: "task/one", head })))!)
    const sent = records.find((record) => record.kind === "sent")
    expect(sent, "the sent record was never written").toBeDefined()
    const said = trailer(sent!, "Delivery-Error")
    expect(said).not.toContain("\n")
    // Every character survives; only the line breaks became spaces, so the
    // trailer stays as loud as the message it carries.
    expect(said).toContain("spawn failed   at the first frame   at the second frame")
  })
})
