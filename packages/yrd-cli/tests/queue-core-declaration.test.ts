/**
 * @reach fs-walk <fixture-only: queue declaration scans temporary remote and state fixtures>
 * @failure A command reads config from the caller's checkout or a retired
 * target: hint instead of the selected queue branch at origin, so it judges
 * against the wrong rules or guesses after malformed authority.
 * @level l2 (`coreQueueCommand` against a real remote and clone)
 * @consumer Every queue command.
 */
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import * as fs from "node:fs"
import * as removely from "removely"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import {
  CHANGE_STATUSES,
  archivedChangesPrefix,
  readChangeEvents,
  MIRROR_REFRESHED_AT,
  assertPlainEventQueueConfig,
  changeInput,
  changesRef,
  createEventQueue,
  createEventStore,
  drop,
  eventRows,
  openLog,
  gracefulStopHealthDocument,
  listChanges,
  queueRef,
  runIndexRef,
  readConfig,
  readEventQueue,
  readEventQueueWithChanges,
  readRemoteCalls,
  readRunLog,
  readStatus,
  QUEUE_HEALTH_DOCUMENT,
  QUEUE_HEALTH_SCHEMA,
  watchRows,
  writeQueueEvent,
  pauseRef,
} from "@yrd/queue-core"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { outsideRepositoryRoot } from "../../../tests/support/outside-repository.ts"
import { openEvents } from "gitomic/events"
import {
  assertEventListingFence,
  coreQueueCommand,
  openEventDetail,
  readEventListing,
} from "../src/queue-core-commands.ts"
import { runYrdProcess } from "../src/cli.ts"
import { releaseRetainedCheckouts } from "../src/branch-retirement.ts"
import { archiveRefFor } from "git-super/archive-ref"
import { readEnvOpenRecord } from "../src/env-open-record.ts"
import { SERVICE } from "../src/queue-health.ts"
import { resolveQueueLocation } from "../src/queue-location.ts"
import { eventHistoryEntries } from "../src/watch-change.ts"
import type { YrdCliIO } from "../src/types.ts"
import { workdirOf } from "../src/workdir.ts"
import type { QueueConfig } from "@yrd/queue-core"

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

vi.mock("removely", async (original) => ({ ...(await original<typeof import("removely")>()) }))

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

it("refuses future event queue and check keys by name", () => {
  const plain: QueueConfig = {
    target: { remote: "origin", branch: "main" },
    archiveAfter: "never",
    revertGuard: "observe",
    checks: [{ name: "verify", run: "true" }],
    health: { declared: false, stallAfterMs: 45 * 60_000 },
    ignore: [],
    notify: [],
    blob: "a".repeat(40),
  }
  expect(() => assertPlainEventQueueConfig({ ...plain, futureQueueFeature: true } as QueueConfig, "run")).toThrow(
    /queue key futureQueueFeature: this declaration feature has no event runner executor; remove queue key futureQueueFeature from \.yrd\.yml to run on an event queue/u,
  )
  expect(() =>
    assertPlainEventQueueConfig({ ...plain, futureQueueFeature: undefined } as QueueConfig, "run"),
  ).not.toThrow()
  expect(() => assertPlainEventQueueConfig({ ...plain, futureQueueFeature: null } as QueueConfig, "run")).toThrow(
    /queue key futureQueueFeature:/u,
  )
  expect(() =>
    assertPlainEventQueueConfig(
      {
        ...plain,
        checks: [{ ...plain.checks[0]!, futureCheckFeature: true } as unknown as (typeof plain.checks)[number]],
      },
      "run",
    ),
  ).toThrow(
    /check key futureCheckFeature: \(verify\): this declaration feature has no event runner executor; remove check key futureCheckFeature from \.yrd\.yml to run on an event queue/u,
  )
  expect(() =>
    assertPlainEventQueueConfig(
      {
        ...plain,
        checks: [{ ...plain.checks[0]!, futureCheckFeature: undefined } as unknown as (typeof plain.checks)[number]],
      },
      "run",
    ),
  ).not.toThrow()
  expect(() =>
    assertPlainEventQueueConfig(
      {
        ...plain,
        checks: [{ ...plain.checks[0]!, futureCheckFeature: "" } as unknown as (typeof plain.checks)[number]],
      },
      "run",
    ),
  ).toThrow(/check key futureCheckFeature:/u)
})

it("accepts a declared admission command for event queue submission", () => {
  const config: QueueConfig = {
    target: { remote: "origin", branch: "main" },
    archiveAfter: "never",
    revertGuard: "observe",
    checks: [],
    health: { declared: false, stallAfterMs: 45 * 60_000 },
    ignore: [],
    notify: [],
    admission: { run: "bun tools/yrd-admission.ts", timeoutMs: 15_000 },
    blob: "a".repeat(40),
  }
  expect(() => assertPlainEventQueueConfig(config, "submit")).not.toThrow()
  expect(() => assertPlainEventQueueConfig(config, "run")).not.toThrow()
})

function capture(cwd: string): Readonly<{ io: YrdCliIO; stderr(): string; stdout(): string }> {
  let stderr = ""
  let stdout = ""
  return {
    io: {
      color: false,
      cwd,
      stderr: (text) => void (stderr += text),
      stdout: (text) => void (stdout += text),
      // These custody fixtures declare their host's naming policy explicitly.
      // Generic Yrd no longer guesses an issue from these fixture branch names.
      branchIssue: ({ branch, recordedIssue }) => recordedIssue ?? /^(\d+)-/u.exec(branch.split("/").at(-1) ?? "")?.[1],
    },
    stderr: () => stderr,
    stdout: () => stdout,
  }
}

async function world(config?: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-declaration-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const repo = join(root, "repo")
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, repo])
  const git = gitIn(repo)
  await git(["config", "user.name", "yrd test"])
  await git(["config", "user.email", "yrd@test.invalid"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(repo, "README.md"), "queue\n")
  if (config !== undefined) writeFileSync(join(repo, ".yrd.yml"), config)
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "queue"])
  await git(["push", "--quiet", "origin", "main"])
  return repo
}

async function createQueue(repo: string, queue: string, commit: string, at: Date, remote = "origin"): Promise<string> {
  const git = gitIn(repo)
  const config = await readConfig(git, commit, { branch: queue, remote })
  if (config === undefined) throw new Error(`fixture target ${commit} lost .yrd.yml`)
  return createEventQueue(createEventStore(repo, remote, git.selection), queue, commit, config, at)
}

it("archives through the CLI and retains event and payload objects after fresh clone and GC (27957)", async () => {
  const repo = await world('checks:\n  - verify: {run: "true"}\n')
  const git = gitIn(repo)
  const target = (await git(["rev-parse", "HEAD"])).trim()
  const at = new Date("2020-01-01T00:00:00.000Z")
  const queueTip = await createQueue(repo, "main", target, at)
  // The payload has no branch at origin: only the event's keeps edge can retain it.
  writeFileSync(join(repo, "payload.txt"), "retained only by change history\n")
  await git(["add", "payload.txt"])
  await git(["commit", "--quiet", "-m", "unreferenced payload"])
  const payload = (await git(["rev-parse", "HEAD"])).trim()
  const tree = (await git(["rev-parse", "HEAD^{tree}"])).trim()
  const blob = (await git(["rev-parse", "HEAD:payload.txt"])).trim()
  const branch = "task/archive-proof"
  const hot = changesRef("main", branch)
  const cold = `${archivedChangesPrefix("main")}${branch}`
  const location = createEventStore(repo, "origin", git.selection)
  const written = await (
    await openEvents({ ...location, ref: hot })
  ).append(
    [
      changeInput("opened", { queueTip, at, commit: payload, by: "@dev/6" }),
      changeInput("merged", { queueTip, at, commit: payload }),
    ],
    { expect: null },
  )
  if (written.head === null) throw new Error("fixture event head missing")
  const original = await readChangeEvents(location, "main", branch, written.head)
  const before = await git(["ls-remote", "origin"])
  const preview = capture(repo)
  const args = [
    "bun",
    "yrd",
    "queue",
    "archive",
    "--queue",
    "main",
    "--notify",
    "@dev/6",
    "--json",
    "--min-age",
    "30",
    "--state",
    "merged",
    "--limit",
    "1",
  ]
  expect(await runYrdProcess([...args, "--dry-run"], preview.io), preview.stderr()).toBe(0)
  expect(JSON.parse(preview.stdout())).toMatchObject({
    examined: 1,
    protected: 0,
    recent: 0,
    eligible: 1,
    bounds: { minAgeDays: 30, states: ["merged"], limit: 1 },
    candidates: [{ branch, ref: hot, coldRef: cold }],
    archived: [],
  })
  expect(await git(["ls-remote", "origin"])).toBe(before)
  for (const [flag, value] of [
    ["--min-age", "6"],
    ["--limit", "0"],
    ["--state", "other"],
  ] as const) {
    const refused = capture(repo)
    expect(await runYrdProcess([...args, flag, value], refused.io), refused.stderr()).toBe(2)
    expect(refused.stderr()).toContain(flag)
    expect(await git(["ls-remote", "origin"])).toBe(before)
  }
  const execute = capture(repo)
  expect(await runYrdProcess(args, execute.io), execute.stderr()).toBe(0)
  expect(JSON.parse(execute.stdout())).toMatchObject({
    archived: [expect.any(String)],
    eligible: 1,
    bounds: { minAgeDays: 30, states: ["merged"], limit: 1 },
    candidates: [{ branch, ref: hot, tip: written.head, coldRef: cold }],
  })
  expect(await git(["ls-remote", "origin", hot])).toBe("")
  const root = dirname(repo)
  const remote = join(root, "remote.git")
  await gitIn(remote)(["reflog", "expire", "--expire=now", "--all"])
  await gitIn(remote)(["gc", "--prune=now"])
  const fresh = join(root, "fresh")
  await gitIn(root)(["clone", "--quiet", "--no-local", remote, fresh])
  const reader = gitIn(fresh)
  await reader(["fetch", "--quiet", "origin", `+${cold}:${cold}`, `+${queueRef("main")}:${queueRef("main")}`])
  await reader(["reflog", "expire", "--expire=now", "--all"])
  await reader(["gc", "--prune=now"])
  for (const oid of [...original.map((event) => event.id), payload, tree, blob]) {
    expect((await reader(["cat-file", "-t", oid])).trim()).toMatch(/^(commit|tree|blob)$/u)
  }
  const archivedTip = (await reader(["rev-parse", cold])).trim()
  const retained = await readChangeEvents(
    createEventStore(fresh, "origin", reader.selection),
    "main",
    branch,
    archivedTip,
  )
  expect(retained.slice(0, -1).map((event) => event.id)).toEqual(original.map((event) => event.id))
  expect(retained.at(-1)).toMatchObject({ type: "archived", parent: original.at(-1)?.id })
  const listed = capture(fresh)
  expect(
    await coreQueueCommand(fresh, listed.io, { command: "list", all: true }, { queue: "main", json: true }),
    listed.stderr(),
  ).toBe(0)
  expect(JSON.parse(listed.stdout())).toMatchObject({ changes: [{ branch, state: "merged", merge: payload }] })
  const repeat = capture(repo)
  expect(await runYrdProcess([...args, "--dry-run"], repeat.io), repeat.stderr()).toBe(0)
  expect(JSON.parse(repeat.stdout())).toMatchObject({ queue: "main", examined: 0, candidates: [], archived: [] })
})

it("reads a fresh queue-owned store without remote Git calls and refreshes once on a miss (25626)", async () => {
  const repo = await world('checks:\n  - verify: {run: "true"}\n')
  const git = gitIn(repo)
  const target = (await git(["rev-parse", "HEAD"])).trim()
  const at = new Date("2026-09-22T14:00:00.000Z")
  const queueTip = await createQueue(repo, "main", target, at)
  // @failure 27957: a local status mirror must fetch cold histories as well as hot events.
  // The original empty queue proved refresh frequency but could not detect archived rows disappearing.
  const location = createEventStore(repo, "origin", git.selection)
  const branch = "task/retained"
  const hot = changesRef("main", branch)
  const cold = `refs/yrd-archive/main/${branch}`
  const written = await (
    await openEvents({ ...location, ref: hot })
  ).append(
    [
      changeInput("opened", { queueTip, at, commit: target, by: "@dev/6" }),
      changeInput("merged", { queueTip, at, commit: target }),
    ],
    { expect: null },
  )
  if (written.head === null || location.backend.publish === undefined) throw new Error("fixture lacks cold custody")
  await location.backend.publish(
    repo,
    [
      { ref: cold, expect: "0".repeat(40), oid: written.head },
      { ref: hot, expect: written.head, oid: null },
    ],
    "origin",
  )
  const root = dirname(repo)
  const remote = join(root, "remote.git")
  const owned = join(root, "owned")
  await gitIn(root)(["clone", "--quiet", "--no-checkout", remote, owned])
  const options = {
    json: true,
    queue: "main",
    workdir: join(root, "queue"),
    localStatusStore: { path: owned, transport: remote },
  } as const
  const previousTrace = process.env.GIT_TRACE2_EVENT
  const firstTrace = join(root, "first-trace")
  const warmTrace = join(root, "warm-trace")
  mkdirSync(firstTrace)
  mkdirSync(warmTrace)
  try {
    process.env.GIT_TRACE2_EVENT = firstTrace
    const first = capture(repo)
    expect(await coreQueueCommand(repo, first.io, { command: "list", all: true }, options), first.stderr()).toBe(0)
    expect(JSON.parse(first.stdout())).toMatchObject({
      source: "local",
      asOf: expect.any(String),
      changes: [{ branch, state: "merged", merge: target }],
    })
    expect(readRemoteCalls(firstTrace).verbs.fetch).toBe(1)

    process.env.GIT_TRACE2_EVENT = warmTrace
    const warm = capture(repo)
    expect(await coreQueueCommand(repo, warm.io, { command: "list", all: true }, options), warm.stderr()).toBe(0)
    expect(JSON.parse(warm.stdout())).toMatchObject({ changes: [{ branch, state: "merged", merge: target }] })
    const shown = capture(repo)
    expect(
      await coreQueueCommand(repo, shown.io, { command: "show", branch: "task/absent" }, options),
      shown.stderr(),
    ).toBe(0)
    expect(JSON.parse(shown.stdout())).toMatchObject({ source: "local", asOf: expect.any(String) })
    expect(readRemoteCalls(warmTrace).verbs).toEqual({})
    expect(readRemoteCalls(warmTrace).unreadable).toBe(0)
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT
    else process.env.GIT_TRACE2_EVENT = previousTrace
  }
  await expect(
    coreQueueCommand(
      repo,
      capture(repo).io,
      { command: "list" },
      {
        ...options,
        localStatusStore: { path: join(root, "absent"), transport: remote },
      },
    ),
  ).rejects.toThrow(join(root, "absent"))
  writeFileSync(join(owned, MIRROR_REFRESHED_AT), "{broken\n")
  await expect(coreQueueCommand(repo, capture(repo).io, { command: "list" }, options)).rejects.toThrow(
    join(owned, MIRROR_REFRESHED_AT),
  )
  await gitIn(owned)(["checkout", "--quiet", "main"])
  unlinkSync(join(owned, MIRROR_REFRESHED_AT))
  await expect(coreQueueCommand(repo, capture(repo).io, { command: "list" }, options)).rejects.toThrow(
    "index with checked-out files",
  )
})

it("refreshes local status after an event queue write in the same workdir (25626)", async () => {
  const repo = await world("{}\n")
  const git = gitIn(repo)
  const target = (await git(["rev-parse", "HEAD"])).trim()
  await createQueue(repo, "main", target, new Date("2026-09-22T14:00:00.000Z"))
  const workdir = join(dirname(repo), "queue")
  const owned = join(workdir, "repo")
  const remote = join(dirname(repo), "remote.git")
  mkdirSync(workdir)
  await gitIn(workdir)(["clone", "--quiet", "--no-checkout", remote, owned])
  const options = { json: true, queue: "main", workdir, localStatusStore: { path: owned, transport: remote } } as const
  const before = capture(repo)
  expect(await coreQueueCommand(repo, before.io, { command: "list" }, options), before.stderr()).toBe(0)
  expect(JSON.parse(before.stdout())).toMatchObject({ stopped: null })

  const paused = capture(repo)
  expect(
    await coreQueueCommand(
      repo,
      paused.io,
      { command: "pause", by: "@dev/11", reason: "repair" },
      { json: true, queue: "main", workdir },
    ),
    paused.stderr(),
  ).toBe(0)
  const previousTrace = process.env.GIT_TRACE2_EVENT
  const trace = join(dirname(repo), "after-write-trace")
  mkdirSync(trace)
  try {
    process.env.GIT_TRACE2_EVENT = trace
    const after = capture(repo)
    expect(await coreQueueCommand(repo, after.io, { command: "list" }, options), after.stderr()).toBe(0)
    expect(JSON.parse(after.stdout())).toMatchObject({ source: "local", stopped: { by: "@dev/11", cause: "operator" } })
    const warm = capture(repo)
    expect(await coreQueueCommand(repo, warm.io, { command: "list" }, options), warm.stderr()).toBe(0)
    expect(readRemoteCalls(trace).verbs).toEqual({ fetch: 1 })
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT
    else process.env.GIT_TRACE2_EVENT = previousTrace
  }
})

describe("a queue is the selected origin branch carrying config", () => {
  it("creates and runs an event queue from a parsed plain-check declaration", async () => {
    // Literal QueueConfig fixtures omit absent optional keys. A real
    // declaration materializes some of them as undefined, and those must not
    // be mistaken for configured features or unknown future keys.
    const repo = await world('checks:\n  - lab-gate: {run: "true"}\n')
    const git = gitIn(repo)
    const store = createEventStore(repo, "origin", gitIn(repo).selection)
    const target = (await git(["rev-parse", "HEAD"])).trim()
    await createQueue(repo, "main", target, new Date("2026-09-22T14:00:00.000Z"))
    await git(["checkout", "--quiet", "-b", "task/plain-check"])
    writeFileSync(join(repo, "plain-check.txt"), "plain check\n")
    await git(["add", "plain-check.txt"])
    await git(["commit", "--quiet", "-m", "plain check change"])
    const head = (await git(["rev-parse", "HEAD"])).trim()

    const submitted = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "submit", "--queue", "main", "--json"], submitted.io),
      submitted.stderr(),
    ).toBe(0)
    const run = capture(repo)
    expect(await runYrdProcess(["bun", "yrd", "queue", "run", "--queue", "main", "--json"], run.io), run.stderr()).toBe(
      0,
    )
    expect((await listChanges(store, "main")).get("task/plain-check")).toMatchObject({
      commit: head,
      status: "merged",
    })
    const published = (await git(["ls-remote", "--heads", "origin", "main"])).split("\t")[0]
    expect(await git(["show", `${published}:plain-check.txt`])).toBe("plain check\n")
  }, 15_000)

  // 25065 (f478ef49e1) gave the event runner an executor for these, so a declaration using
  // them creates its queue; teardown alone still has none.
  it.each([
    ["setup:", 'setup: "true"\n'],
    ["notify:", 'notify:\n  - recorder: {on: [merged], run: "true"}\n'],
    ["submit-phase", 'checks:\n  - verify: {run: "true", on: submit}\n'],
    ["programRoot", 'checks:\n  - verify: {run: "true", programRoot: true}\n'],
    ["scripts", 'checks:\n  - verify: {run: "true", scripts: [tools/check.ts]}\n'],
    ["deferred-capable", 'checks:\n  - verify: {run: "true", long: {timeoutMs: 60000}}\n'],
  ])(
    "creates an event queue whose declaration uses %s, which the event runner executes",
    async (_feature, declaration) => {
      const repo = await world(declaration)
      const git = gitIn(repo)
      const target = (await git(["rev-parse", "HEAD"])).trim()
      await createQueue(repo, "main", target, new Date("2026-09-22T14:00:00.000Z"))
      expect(await git(["ls-remote", "--refs", "origin", queueRef("main")])).not.toBe("")
    },
  )

  it.each([["teardown:", 'teardown: "true"\n']])(
    "refuses event queue creation with %s before writing a queue ref",
    async (feature, declaration) => {
      const repo = await world(declaration)
      const git = gitIn(repo)
      const target = (await git(["rev-parse", "HEAD"])).trim()
      const config = await readConfig(git, target, { branch: "main", remote: "origin" })
      if (config === undefined) throw new Error("fixture declaration is absent")
      const before = await git(["ls-remote", "--refs", "origin", "refs/yrd/main/*"])

      await expect(
        createEventQueue(
          createEventStore(repo, "origin", gitIn(repo).selection),
          "main",
          target,
          config,
          new Date("2026-09-22T14:00:00.000Z"),
        ),
      ).rejects.toThrow(
        /cannot create an event queue with teardown: this declaration feature has no event runner executor; remove teardown from \.yrd\.yml to run on an event queue/u,
      )

      expect(await git(["ls-remote", "--refs", "origin", queueRef("main")])).toBe("")
      expect(await git(["ls-remote", "--refs", "origin", "refs/yrd/main/*"])).toBe(before)
    },
  )

  it("refuses event queue creation when config came from another blob", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const target = (await git(["rev-parse", "HEAD"])).trim()
    const config = await readConfig(git, target, { branch: "main", remote: "origin" })
    if (config === undefined) throw new Error("fixture declaration is absent")

    await expect(
      createEventQueue(
        createEventStore(repo, "origin", gitIn(repo).selection),
        "main",
        target,
        { ...config, blob: "f".repeat(40) },
        new Date("2026-09-22T14:00:00.000Z"),
      ),
    ).rejects.toThrow(/config blob .* does not match .*\.yrd\.yml/u)
    expect(await git(["ls-remote", "--refs", "origin", "refs/yrd/main/*"])).toBe("")
  })

  it("refuses event queue creation without a declaration instead of inventing defaults", async () => {
    const repo = await world()
    const git = gitIn(repo)
    const target = (await git(["rev-parse", "HEAD"])).trim()
    expect(await readConfig(git, target, { branch: "main", remote: "origin" })).toBeUndefined()

    await expect(
      createEventQueue(
        createEventStore(repo, "origin", gitIn(repo).selection),
        "main",
        target,
        undefined as unknown as QueueConfig,
        new Date("2026-09-22T14:00:00.000Z"),
      ),
    ).rejects.toThrow(
      /cannot create event queue main at .*: the pinned commit has no declared QueueConfig; declare checks in \.yrd\.yml at that commit before creating an event queue/u,
    )
    expect(await git(["ls-remote", "--refs", "origin", "refs/yrd/main/*"])).toBe("")
  })

  it("refuses event queue creation when the pinned commit has no .yrd.yml", async () => {
    const repo = await world()
    const git = gitIn(repo)
    const target = (await git(["rev-parse", "HEAD"])).trim()
    const config: QueueConfig = {
      target: { remote: "origin", branch: "main" },
      archiveAfter: "never",
      revertGuard: "observe",
      checks: [{ name: "verify", run: "true" }],
      health: { declared: false, stallAfterMs: 45 * 60_000 },
      ignore: [],
      notify: [],
      blob: "a".repeat(40),
    }

    await expect(
      createEventQueue(
        createEventStore(repo, "origin", gitIn(repo).selection),
        "main",
        target,
        config,
        new Date("2026-09-22T14:00:00.000Z"),
      ),
    ).rejects.toThrow(
      /cannot create event queue main at .*: the pinned \.yrd\.yml could not be validated in .*; declare checks there and restore its public objects before creating an event queue/u,
    )
    expect(await git(["ls-remote", "--refs", "origin", "refs/yrd/main/*"])).toBe("")
  })

  it("refuses a moved or newly added event ref between history and observation", () => {
    const before = "a".repeat(40)
    const changeTip = "b".repeat(40)
    const moved = "c".repeat(40)
    const queue = { created: before, declaration: before, tip: before }
    const changes = new Map([["task/one", { status: "queued" as const, commit: before, tip: changeTip }]])
    const advertised = new Map([
      [queueRef("main"), before],
      [changesRef("main", "task/one"), changeTip],
    ])
    expect(() => assertEventListingFence("main", queue, changes, advertised)).not.toThrow()
    advertised.set(changesRef("main", "task/one"), moved)
    expect(() => assertEventListingFence("main", queue, changes, advertised)).toThrow(/task\/one moved.*read.*observed/)
    advertised.set(changesRef("main", "task/one"), changeTip)
    advertised.set(changesRef("main", "task/two"), moved)
    expect(() => assertEventListingFence("main", queue, changes, advertised)).toThrow(/task\/two appeared/)
  })

  it("reads event changes from the remote in one selected format", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const store = createEventStore(repo, "origin", gitIn(repo).selection)
    const targetOid = (await git(["rev-parse", "HEAD"])).trim()
    const created = await createQueue(repo, "main", targetOid, new Date("2026-09-22T14:00:00.000Z"))
    const declaration = await readConfig(git, targetOid, { remote: "origin", branch: "main" })
    if (declaration === undefined) throw new Error("fixture target lost .yrd.yml")
    await git(["checkout", "--quiet", "-b", "task/event"])
    writeFileSync(join(repo, "work.txt"), "event work\n")
    await git(["add", "work.txt"])
    await git(["commit", "--quiet", "-m", "event work"])
    const commit = (await git(["rev-parse", "HEAD"])).trim()
    const chain = await openEvents({ ...store, ref: changesRef("main", "task/event"), writer: "yrd" })
    await chain.append(
      [changeInput("opened", { queueTip: created, at: new Date("2026-09-22T14:01:00.000Z"), commit, by: "yrd" })],
      { expect: null },
    )
    expect((await listChanges(store, "main")).get("task/event")).toMatchObject({ status: "queued", commit })
    // A queue selected by its queue chain must display the fold's state. The
    // legacy ref reader finds zero changes here and would print an empty list.
    const listed = capture(repo)
    expect(await coreQueueCommand(repo, listed.io, { command: "list" }, { json: true, queue: "main" })).toBe(0)
    expect(JSON.parse(listed.stdout())).toMatchObject({
      changes: [{ branch: "task/event", head: commit, state: "queued", format: "event" }],
    })
    const table = capture(repo)
    expect(await coreQueueCommand(repo, table.io, { command: "list", terms: ["queued"] }, { queue: "main" })).toBe(0)
    expect(table.stdout()).toContain("task/event")
    expect(table.stdout()).toContain("queued")
    // Existing list checks cannot catch show falling back to the legacy ref
    // reader and silently claiming this event-only branch has no history.
    const shown = capture(repo)
    expect(
      await coreQueueCommand(repo, shown.io, { command: "show", branch: "task/event" }, { json: true, queue: "main" }),
    ).toBe(0)
    expect(JSON.parse(shown.stdout())).toMatchObject({
      changes: [{ branch: "task/event", head: commit, state: "queued", format: "event", events: [{ type: "opened" }] }],
    })
    const human = capture(repo)
    expect(await coreQueueCommand(repo, human.io, { command: "show", branch: "task/event" }, { queue: "main" })).toBe(0)
    expect(human.stdout()).toContain("task/event")
    expect(human.stdout()).toContain("opened by yrd")
    const selected = (await listChanges(store, "main")).get("task/event")
    if (selected === undefined) throw new Error("fixture event change is missing")
    const row = watchRows(eventRows(new Map([["task/event", selected]])))[0]
    if (row === undefined) throw new Error("fixture event row is missing")
    const detail = await openEventDetail(git, declaration, row, "main", repo, selected)
    expect(detail.events?.map((event) => event.type)).toEqual(["opened"])
    expect(eventHistoryEntries(detail.events ?? []).map((entry) => entry.text)).toEqual(["opened by yrd"])
    await chain.append(
      [changeInput("verifying", { queueTip: created, at: new Date("2026-09-22T14:02:00.000Z"), commit })],
      { expect: selected.tip as string },
    )
    await expect(openEventDetail(git, declaration, row, "main", repo, selected)).rejects.toThrow(
      /moved after the selected reading/,
    )
  }, 15_000)

  // 25607: the branch's event chain can hold several heads. List answers
  // where the branch stands now; show answers what happened to each head.
  it("lists only a reused branch's current head and shows every landed or cancelled head", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const store = createEventStore(repo, "origin", git.selection)
    const target = (await git(["rev-parse", "HEAD"])).trim()
    const time = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000)
    const queueTip = await createQueue(repo, "main", target, time(60))
    const branch = "task/reused"
    await git(["checkout", "--quiet", "-b", branch])
    const commit = async (name: string) => {
      writeFileSync(join(repo, name), `${name}\n`)
      await git(["add", name])
      await git(["commit", "--quiet", "-m", name])
      return (await git(["rev-parse", "HEAD"])).trim()
    }
    const first = await commit("first.txt")
    await git(["checkout", "--quiet", "main"])
    await git(["merge", "--quiet", "--no-ff", "-m", "first landing", branch])
    const firstMerge = (await git(["rev-parse", "HEAD"])).trim()
    await git(["checkout", "--quiet", branch])
    const cancelled = await commit("cancelled.txt")
    const current = await commit("current.txt")
    await git(["checkout", "--quiet", "main"])
    await git(["merge", "--quiet", "--no-ff", "-m", "current landing", branch])
    const currentMerge = (await git(["rev-parse", "HEAD"])).trim()
    await git(["push", "--quiet", "origin", "main"])
    await (
      await openEvents({ ...store, ref: changesRef("main", branch), writer: "yrd" })
    ).append(
      [
        changeInput("opened", { queueTip, at: time(50), commit: first, by: "yrd" }),
        changeInput("merged", {
          queueTip,
          at: time(49),
          commit: firstMerge,
          reason: `observed on target at ${firstMerge}`,
        }),
        changeInput("opened", { queueTip, at: time(40), commit: cancelled, by: "yrd" }),
        changeInput("cancelled", { queueTip, at: time(39), reason: "resubmitted" }),
        changeInput("opened", { queueTip, at: time(30), commit: current, by: "yrd" }),
        changeInput("merged", {
          queueTip,
          at: time(29),
          commit: currentMerge,
          reason: `observed on target at ${currentMerge}`,
        }),
      ],
      { expect: null },
    )
    const list = async (latest: boolean) => {
      const output = capture(repo)
      expect(
        await coreQueueCommand(
          repo,
          output.io,
          { command: "list", terms: [branch], ...(latest ? { latest: true } : {}) },
          { json: true, queue: "main" },
        ),
        output.stderr(),
      ).toBe(0)
      return (JSON.parse(output.stdout()) as { changes: readonly { branch: string; head: string }[] }).changes
    }
    expect(new Set((await list(false)).map((row) => row.head))).toEqual(new Set([current]))
    expect(await list(true)).toEqual([expect.objectContaining({ branch, head: current })])
    const shown = capture(repo)
    expect(await coreQueueCommand(repo, shown.io, { command: "show", branch }, { json: true, queue: "main" })).toBe(0)
    const history = (
      JSON.parse(shown.stdout()) as { changes: readonly { head: string; state: string; merge?: string }[] }
    ).changes
    expect(history.map(({ head, state, merge }) => [head, state, merge])).toEqual([
      [current, "merged", currentMerge],
      [cancelled, "cancelled", undefined],
      [first, "merged", firstMerge],
    ])
    const bulk = capture(repo)
    expect(await coreQueueCommand(repo, bulk.io, { command: "show", all: true }, { json: true, queue: "main" })).toBe(0)
    const allHistory = (
      JSON.parse(bulk.stdout()) as { changes: readonly { branch: string; events: readonly { type: string }[] }[] }
    ).changes
    expect(allHistory.filter((row) => row.branch === branch)).toEqual(history)
    const cliBulk = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "queue", "show", "--all", "--json", "--fresh", "--queue", "main"], cliBulk.io),
    ).toBe(0)
    expect(
      (JSON.parse(cliBulk.stdout()) as { changes: readonly { branch: string }[] }).changes.filter(
        (row) => row.branch === branch,
      ),
    ).toEqual(history)
    expect(
      allHistory.filter((row) => row.branch === branch).map((row) => row.events.map((event) => event.type)),
    ).toEqual([
      ["opened", "merged"],
      ["opened", "cancelled"],
      ["opened", "merged"],
    ])
    const withBranch = capture(repo)
    expect(
      await coreQueueCommand(
        repo,
        withBranch.io,
        { command: "show", branch, all: true },
        { json: true, queue: "main" },
      ),
    ).toBe(2)
    expect(withBranch.stderr()).toContain("--all cannot take a branch")
    const withoutJson = capture(repo)
    expect(await coreQueueCommand(repo, withoutJson.io, { command: "show", all: true }, { queue: "main" })).toBe(2)
    expect(withoutJson.stderr()).toContain("--all requires --json")
    const human = capture(repo)
    expect(await coreQueueCommand(repo, human.io, { command: "show", branch }, { queue: "main" })).toBe(0)
    for (const head of [current, cancelled, first]) expect(human.stdout()).toContain(head.slice(0, 12))
  }, 25_000)

  // @failure Branch show reads unrelated raw journals and returns their fallback diagnostics (28615).
  // @level l2 — existing command boundary with real event refs and observable journal reads.
  // @consumer A user asking queue show for one branch; bulk show retains global diagnostics.
  it("reads only the selected branch's journals and keeps bulk show's global diagnostics", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const store = createEventStore(repo, "origin", git.selection)
    const head = (await git(["rev-parse", "HEAD"])).trim()
    const at = new Date(Date.now() - 60_000)
    const queueTip = await createQueue(repo, "main", head, at)
    const logs = join(await workdirOf(git, { cwd: repo }), "logs")
    const journals = ["task/selected", "task/unrelated"].map((branch, index) => {
      const journal = openLog(logs, () => new Date(at.getTime() + index + 1))
      journal.write({ kind: "run", base: head })
      journal.write({ kind: "change", branch, head, decision: "failed" })
      return { branch, journal }
    })
    for (const { branch, journal } of journals) {
      await (
        await openEvents({ ...store, ref: changesRef("main", branch), writer: "yrd" })
      ).append(
        [
          changeInput("opened", { queueTip, at, commit: head, by: "yrd" }),
          changeInput("cancelled", { queueTip, at, commit: head, reason: "dropped", run: journal.id }),
        ],
        { expect: null },
      )
    }
    const selected = journals[0]!
    const paths = new Set(journals.map(({ journal }) => journal.path))
    const read = vi.spyOn(fs, "readFileSync")
    const shown = capture(repo)
    try {
      expect(
        await coreQueueCommand(
          repo,
          shown.io,
          { command: "show", branch: selected.branch },
          { json: true, queue: "main" },
        ),
        shown.stderr(),
      ).toBe(0)
      // Observe I/O, so filtering the broad result after reading everything cannot pass.
      // The one selected journal may be read more than once (the raw rebuild
      // and the projection write it now persists, 28908); the unrelated
      // journal must never be touched.
      const touched = read.mock.calls.map(([path]) => String(path)).filter((path) => paths.has(path))
      expect(touched.length, shown.stdout()).toBeGreaterThan(0)
      expect(new Set(touched), shown.stdout()).toEqual(new Set([selected.journal.path]))
    } finally {
      read.mockRestore()
    }
    const scoped = JSON.parse(shown.stdout()) as {
      changes: { branch: string; state: string }[]
      journal: { fallbacks?: { count: number; reasons: readonly { count: number }[] } }
    }
    expect(scoped.changes.map(({ branch }) => branch)).toEqual([selected.branch])
    expect(scoped.changes[0]?.state).toBe("cancelled")
    expect(scoped.journal.fallbacks).toMatchObject({ count: 1, reasons: [{ count: 1 }] })
    const bulk = capture(repo)
    expect(
      await coreQueueCommand(repo, bulk.io, { command: "show", all: true }, { json: true, queue: "main" }),
      bulk.stderr(),
    ).toBe(0)
    const global = JSON.parse(bulk.stdout()) as typeof scoped
    expect(global.changes.map(({ branch }) => branch).sort()).toEqual(journals.map(({ branch }) => branch).sort())
    // The scoped read above rebuilt the selected journal and persisted its
    // projection (28908), so the bulk read still names only the unrelated
    // journal's fallback — and its own rebuild persists that one too, so a
    // further bulk read names none.
    expect(global.journal.fallbacks).toMatchObject({ count: 1, reasons: [{ count: 1 }] })
    expect(Buffer.byteLength(shown.stdout())).toBeLessThan(Buffer.byteLength(bulk.stdout()))
    const again = capture(repo)
    expect(
      await coreQueueCommand(repo, again.io, { command: "show", all: true }, { json: true, queue: "main" }),
      again.stderr(),
    ).toBe(0)
    const settled = JSON.parse(again.stdout()) as typeof scoped
    expect(settled.changes.map(({ branch }) => branch).sort()).toEqual(journals.map(({ branch }) => branch).sort())
    expect(settled.journal.fallbacks).toBeUndefined()
  }, 15_000)

  it("keeps an equal-head duplicate in the current list and both submissions in show", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const store = createEventStore(repo, "origin", git.selection)
    const target = (await git(["rev-parse", "HEAD"])).trim()
    const time = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000)
    const queueTip = await createQueue(repo, "main", target, time(40))
    const branch = "task/twice"
    await git(["checkout", "--quiet", "-b", branch])
    writeFileSync(join(repo, "twice.txt"), "twice\n")
    await git(["add", "twice.txt"])
    await git(["commit", "--quiet", "-m", "twice"])
    const head = (await git(["rev-parse", "HEAD"])).trim()
    await git(["checkout", "--quiet", "main"])
    await git(["merge", "--quiet", "--no-ff", "-m", "landed twice", branch])
    const merge = (await git(["rev-parse", "HEAD"])).trim()
    await git(["push", "--quiet", "origin", "main"])
    const logs = join(await workdirOf(git, { cwd: repo }), "logs")
    for (const minutesAgo of [29, 19]) {
      const journal = openLog(logs, () => time(minutesAgo))
      journal.write({ kind: "run", base: target })
      journal.write({ kind: "change", branch, head, decision: "merged" })
      // Only one run recorded its merge; the other must keep merge absent.
      if (minutesAgo === 29) journal.write({ kind: "merge", branch, head, commit: merge })
    }
    await (
      await openEvents({ ...store, ref: changesRef("main", branch), writer: "yrd" })
    ).append(
      [
        changeInput("opened", { queueTip, at: time(30), commit: head, by: "yrd" }),
        changeInput("merged", { queueTip, at: time(29), commit: merge, reason: `observed on target at ${merge}` }),
        changeInput("opened", { queueTip, at: time(20), commit: head, by: "yrd" }),
        changeInput("merged", { queueTip, at: time(19), commit: merge, reason: `observed on target at ${merge}` }),
      ],
      { expect: null },
    )
    const listed = capture(repo)
    expect(
      await coreQueueCommand(
        repo,
        listed.io,
        { command: "list", latest: true, terms: [branch] },
        { json: true, queue: "main" },
      ),
    ).toBe(0)
    const current = (
      JSON.parse(listed.stdout()) as { changes: readonly { head: string; duplicates?: readonly unknown[] }[] }
    ).changes
    expect(current).toEqual([expect.objectContaining({ head, duplicates: [expect.any(Object)] })])
    const shown = capture(repo)
    expect(await coreQueueCommand(repo, shown.io, { command: "show", branch }, { json: true, queue: "main" })).toBe(0)
    const segments = (
      JSON.parse(shown.stdout()) as {
        changes: readonly { head: string; events: readonly { type: string; id: string }[] }[]
      }
    ).changes
    expect(segments.map(({ head: shownHead, events }) => [shownHead, events.map((event) => event.type)])).toEqual([
      [head, ["opened", "merged"]],
      [head, ["opened", "merged"]],
    ])
    const endings = segments.map(({ events }) => {
      const ending = events.find((event) => event.type === "merged")
      if (ending === undefined) throw new Error("queue show lost a fixture's merged ending")
      return ending.id
    })
    const proof = [{ ending: endings[0], originalEnding: endings[1], merge, endedAt: expect.any(String) }]
    expect(current).toEqual([expect.objectContaining({ head, merge, duplicates: proof })])
    const historical = capture(repo)
    expect(
      // Unlinked historical journals belong to the explicit full-scope reader.
      await coreQueueCommand(
        repo,
        historical.io,
        { command: "list", all: true, terms: [branch] },
        { json: true, queue: "main" },
      ),
    ).toBe(0)
    const runs = (JSON.parse(historical.stdout()) as { changes: readonly { merge?: string; duplicates: unknown }[] })
      .changes
    expect(runs).toHaveLength(2)
    expect(runs.map((row) => row.merge)).toEqual([undefined, merge])
    for (const row of runs) expect(row.duplicates).toEqual(proof)
    const bulk = capture(repo)
    expect(await coreQueueCommand(repo, bulk.io, { command: "show", all: true }, { json: true, queue: "main" })).toBe(0)
    expect(
      (JSON.parse(bulk.stdout()) as { changes: readonly { branch: string }[] }).changes.filter(
        (row) => row.branch === branch,
      ),
    ).toEqual(segments)
  }, 25_000)

  // 25656: the event runner stores Check: evidence, and watch detail must give
  // that evidence to the existing check tabs instead of discarding it.
  it("projects stored event Check results into watch detail", async () => {
    const repo = await world('checks:\n  - unit: {run: "bun run unit"}\n')
    const git = gitIn(repo)
    const store = createEventStore(repo, "origin", git.selection)
    const head = (await git(["rev-parse", "HEAD"])).trim()
    const config = await readConfig(git, head, { branch: "main", remote: "origin" })
    if (config === undefined) throw new Error("fixture target lost its declaration")
    const queueTip = await createQueue(repo, "main", head, new Date("2026-09-22T14:00:00.000Z"))
    const branch = "task/judged-event"
    const log = join(repo, "unit.log")
    const oldLog = join(repo, "old-unit.log")
    writeFileSync(log, "unit passed\n")
    writeFileSync(oldLog, "old attempt failed\n")
    await (
      await openEvents({ ...store, ref: changesRef("main", branch), writer: "yrd" })
    ).append(
      [
        changeInput("opened", { queueTip, at: new Date("2026-09-22T14:00:30.000Z"), commit: head, by: "yrd" }),
        changeInput("verifying", { queueTip, at: new Date("2026-09-22T14:00:35.000Z"), commit: head }),
        changeInput("checking", { queueTip, at: new Date("2026-09-22T14:00:40.000Z") }),
        changeInput("failed", {
          queueTip,
          at: new Date("2026-09-22T14:00:45.000Z"),
          commit: head,
          base: head,
          config: config.blob,
          checks: [
            { run: { name: "unit", result: "fail", exit: 1, durationMs: 7, log: oldLog }, attempt: 1, phase: "merge" },
          ],
        }),
        changeInput("opened", { queueTip, at: new Date("2026-09-22T14:01:00.000Z"), commit: head, by: "yrd" }),
        changeInput("verifying", { queueTip, at: new Date("2026-09-22T14:02:00.000Z"), commit: head }),
        changeInput("checking", { queueTip, at: new Date("2026-09-22T14:03:00.000Z") }),
        changeInput("merging", {
          queueTip,
          at: new Date("2026-09-22T14:04:00.000Z"),
          commit: head,
          base: head,
          config: config.blob,
          checks: [{ run: { name: "unit", result: "pass", exit: 0, durationMs: 12, log }, attempt: 1, phase: "merge" }],
        }),
        changeInput("merged", { queueTip, at: new Date("2026-09-22T14:05:00.000Z"), commit: head }),
      ],
      { expect: null },
    )
    const selected = (await listChanges(store, "main")).get(branch)
    if (selected === undefined) throw new Error("fixture event change is missing")
    const item = watchRows(eventRows(new Map([[branch, selected]])))[0]
    if (item === undefined) throw new Error("fixture event row is missing")
    const detail = await openEventDetail(git, config, item, "main", repo, selected)
    expect(detail.checks).toEqual([
      expect.objectContaining({ name: "unit", state: "passed", log, output: "unit passed\n" }),
    ])
    expect(detail.note).toBeUndefined()
  }, 15_000)

  it("names retained evidence and old check logs when a migrated event has no check detail", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const store = createEventStore(repo, "origin", git.selection)
    const head = (await git(["rev-parse", "HEAD"])).trim()
    const queueTip = await createQueue(repo, "main", head, new Date("2026-09-22T14:00:00.000Z"))
    const config = await readConfig(git, head, { branch: "main", remote: "origin" })
    if (config === undefined) throw new Error("fixture target lost its declaration")
    const branch = "task/migrated-without-checks"
    const source = `refs/yrd/main/${branch}@${head}@${head}`
    const opened = changeInput("opened", {
      queueTip,
      at: new Date("2026-09-22T14:01:00.000Z"),
      commit: head,
      by: "yrd-migration",
    })
    await (
      await openEvents({ ...store, ref: changesRef("main", branch), writer: "yrd-migration" })
    ).append(
      [
        { ...opened, props: [...(opened.props ?? []), ["Migrated-From", source]], keeps: [head] },
        changeInput("merged", { queueTip, at: new Date("2026-09-22T14:02:00.000Z"), commit: head }),
      ],
      { expect: null },
    )
    const selected = (await listChanges(store, "main")).get(branch)
    if (selected === undefined) throw new Error("fixture event change is missing")
    const item = watchRows(eventRows(new Map([[branch, selected]])))[0]
    if (item === undefined) throw new Error("fixture event row is missing")
    const detail = await openEventDetail(git, config, item, "main", repo, selected)
    expect(detail.checks).toEqual([])
    expect(detail.note).toContain(source)
    // The old logs sit under the queue's workdir, whose resolution workdir.test.ts owns (25716 row 9).
    expect(detail.note).toContain(join(await workdirOf(git), "checks", `${branch}@${head}`))
  }, 15_000)

  // @failure a listing printed ~100 KB of gap prose per reverted-paths row, and one show printed the
  //          same stored report twice (28195).
  it("states a reverted-paths warning as one line in the listing and the stored reason once in show (28195)", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const store = createEventStore(repo, "origin", git.selection)
    const head = (await git(["rev-parse", "HEAD"])).trim()
    const queueTip = await createQueue(repo, "main", head, new Date("2026-09-22T14:00:00.000Z"))
    const branch = "task/reverted"
    const policyReason = "the compose touched a protected path"
    const reason =
      '0 reverted/swallowed path(s); {"count":0,"counts":{"reverted":0,"swallowed":0,"gaps":684,' +
      '"unjudged":684,"bounded":0},"coverage":"incomplete","paths":[],"swallowed":[],"gaps":' +
      '[{"kind":"unjudged","depth":1,"reason":"path cap P_max=500","path":"content/a.json"}]}; ' +
      "gaps: path cap P_max=500 [content/a.json@d1]"
    await (
      await openEvents({ ...store, ref: changesRef("main", branch), writer: "yrd" })
    ).append(
      [
        changeInput("opened", { queueTip, at: new Date("2026-09-22T14:01:00.000Z"), commit: head, by: "yrd" }),
        changeInput("admission-warning", {
          queueTip,
          at: new Date("2026-09-22T14:01:30.000Z"),
          commit: head,
          reason: policyReason,
          warningKind: "policy-warning",
        }),
        changeInput("admission-warning", {
          queueTip,
          at: new Date("2026-09-22T14:02:00.000Z"),
          commit: head,
          reason,
          warningKind: "reverted-paths",
        }),
      ],
      { expect: null },
    )
    const listed = capture(repo)
    expect(
      await coreQueueCommand(repo, listed.io, { command: "list", all: true }, { json: true, queue: "main" }),
      listed.stderr(),
    ).toBe(0)
    const row = (
      JSON.parse(listed.stdout()) as {
        changes: readonly { branch: string; diagnostic?: string; diagnosticSummary?: string }[]
      }
    ).changes.find((candidate) => candidate.branch === branch)
    // A change carrying BOTH kinds: the policy warning folds into `diagnostic`, the revert finding is
    // the one line, and each reaches the listing exactly once.
    expect(row).toMatchObject({
      diagnostic: expect.stringContaining(policyReason),
      diagnosticSummary: expect.stringContaining(
        "reverted paths: 0 reverted, 0 swallowed, 684 gap(s) (684 unjudged, 0 bounded) · coverage incomplete",
      ),
    })
    // ONE line per row: neither the stored payload nor its gap prose reaches the listing.
    expect(listed.stdout().split(policyReason).length - 1).toBe(1)
    expect(listed.stdout()).not.toContain("path cap P_max=500")
    // `show` renders that stored reason in FULL, exactly once, beside the same one-line finding.
    const shown = capture(repo)
    expect(await coreQueueCommand(repo, shown.io, { command: "show", branch }, { queue: "main" }), shown.stderr()).toBe(
      0,
    )
    expect(shown.stdout().split(reason).length - 1).toBe(1)
    expect(shown.stdout().split(policyReason).length - 1).toBe(1)
    expect(shown.stdout()).toContain("coverage incomplete · diagnostic ")
  })

  // @failure a malformed event ref took down list/show/watch and hid healthy changes (25658).
  it("lists an invalid chain by name beside healthy and no-opened chains, with show and fence parity", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const store = createEventStore(repo, "origin", git.selection)
    const head = (await git(["rev-parse", "HEAD"])).trim()
    const queueTip = await createQueue(repo, "main", head, new Date("2026-09-22T14:00:00.000Z"))
    const at = new Date("2026-09-22T14:01:00.000Z")
    for (const [branch, input] of [
      ["task/healthy", changeInput("opened", { queueTip, at, commit: head, by: "yrd" })],
      ["task/old-drop", changeInput("cancelled", { queueTip, at, commit: head, reason: "dropped", by: "yrd" })],
      ["task/broken", changeInput("failed", { queueTip, at, reason: "no opened event" })],
    ] as const) {
      await (
        await openEvents({ ...store, ref: changesRef("main", branch), writer: "yrd" })
      ).append([input], { expect: null })
    }
    const listed = capture(repo)
    expect(
      await coreQueueCommand(repo, listed.io, { command: "list", all: true }, { json: true, queue: "main" }),
      listed.stderr(),
    ).toBe(0)
    const rows = (
      JSON.parse(listed.stdout()) as { changes: readonly { branch: string; state: string; diagnostic?: string }[] }
    ).changes
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ branch: "task/healthy", state: "queued" }),
        expect.objectContaining({
          branch: "task/old-drop",
          state: "cancelled",
          diagnostic: expect.stringContaining("no opened event"),
        }),
        expect.objectContaining({
          branch: "task/broken",
          state: "invalid",
          ref: changesRef("main", "task/broken"),
          tip: expect.stringMatching(/^[0-9a-f]{40}$/u),
          error: expect.stringContaining("needs an open change"),
          diagnostic: expect.stringContaining("needs an open change"),
        }),
      ]),
    )
    const bad = capture(repo)
    expect(
      await coreQueueCommand(repo, bad.io, { command: "show", branch: "task/broken" }, { queue: "main" }),
      bad.stderr(),
    ).toBe(0)
    expect(bad.stdout()).toContain("diagnostic:")
    expect(bad.stdout()).toContain("needs an open change")
    const good = capture(repo)
    expect(
      await coreQueueCommand(repo, good.io, { command: "show", branch: "task/healthy" }, { queue: "main" }),
      good.stderr(),
    ).toBe(0)
    expect(good.stdout()).toContain("task/healthy")
    // Submit's preview custody names the unreadable chain out loud and keeps its anchors (27510).
    using custodyWarning = vi.spyOn(console, "warn").mockImplementation(() => {})
    await git(["checkout", "--quiet", "-b", "task/broken"])
    writeFileSync(join(repo, "broken.txt"), "cannot submit over unreadable chain\n")
    await git(["add", "broken.txt"])
    await git(["commit", "--quiet", "-m", "broken branch head"])
    const submitted = capture(repo)
    expect(await runYrdProcess(["bun", "yrd", "submit", "--queue", "main", "--json"], submitted.io)).toBe(2)
    expect(submitted.stderr()).toContain("task/broken")
    expect(submitted.stderr()).toContain("needs an open change")
    expect(custodyWarning).toHaveBeenCalledWith(
      expect.stringContaining("preview custody keeps task/broken's anchors: its change history is unreadable"),
    )
    const run = capture(repo)
    expect(await runYrdProcess(["bun", "yrd", "queue", "run", "--queue", "main", "--json"], run.io), run.stderr()).toBe(
      0,
    )
    const journal = (JSON.parse(run.stdout()) as { log: string }).log
    const records = readFileSync(journal, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(records.filter((row) => row.subject === "invalid-change-chain")).toEqual([
      expect.objectContaining({
        branch: "task/broken",
        ref: changesRef("main", "task/broken"),
        error: expect.stringContaining("needs an open change"),
      }),
    ])
  }, 20_000)

  /** @failure Final ops reuse decodes twice or masks a queue move after the listing's earlier fences.
   * @level l2 @consumer actual queue list reading (28925 AC2/AC3)
   * The earlier pure fence test never reaches final acquisition or the listing retry error.
   */
  it("decodes a stable listed queue once and retains the exact final moved-tip error", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const store = createEventStore(repo, "origin", git.selection)
    const head = (await git(["rev-parse", "HEAD"])).trim()
    const config = await readConfig(git, head, { branch: "main", remote: "origin" })
    if (config === undefined) throw new Error("fixture declaration absent")
    await createQueue(repo, "main", head, new Date())
    const tip = (await readEventQueue(store, "main")).tip
    const workdir = await workdirOf(git, { cwd: repo })
    const history = vi.spyOn(store.backend, "readHistory")
    await readEventListing(git, config, repo, workdir, head, store, { forceFresh: true })
    expect(history).toHaveBeenCalledTimes(1)
    history.mockRestore()
    const fetch = store.backend.fetchRefs
    if (fetch === undefined) throw new Error("fixture backend lacks remote acquisition")
    let moved: string | undefined
    using acquisition = vi.spyOn(store.backend, "fetchRefs").mockImplementation(async (...args) => {
      const refs = args[1]
      if (
        moved === undefined &&
        Array.isArray(refs) &&
        refs.includes(queueRef("main")) &&
        refs.includes(pauseRef("main"))
      ) {
        moved = await writeQueueEvent(store, "main", {
          type: "paused",
          by: "yrd",
          reason: "late operator pause",
          at: new Date(),
        })
      }
      return fetch(...args)
    })
    let failure: unknown
    try {
      await readEventListing(git, config, repo, workdir, head, store, { forceFresh: true })
    } catch (error) {
      failure = error
    }
    expect(moved).not.toBeUndefined()
    expect(moved).not.toBe(tip)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe(
      `${queueRef("main")} moved from ${tip} to ${moved} during listing; retry the read`,
    )
  })

  // @failure A reopened change reads journals belonging to an older, undisplayed segment.
  // @level l2; @consumer default queue list and full branch detail
  it("reads journals for the listed current segment while branch detail retains older runs", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const store = createEventStore(repo, "origin", git.selection)
    const head = (await git(["rev-parse", "HEAD"])).trim()
    const config = await readConfig(git, head, { branch: "main", remote: "origin" })
    if (config === undefined) throw new Error("fixture declaration absent")
    const now = new Date()
    const queueTip = await createQueue(repo, "main", head, now)
    await git(["commit", "--allow-empty", "-m", "new submission"])
    const nextHead = (await git(["rev-parse", "HEAD"])).trim()
    const branch = "task/reopened-journals"
    const oldRun = "q-20261001T100000000Z-12345678"
    const currentRun = "q-20261013T100000000Z-87654321"
    await (
      await openEvents({ ...store, ref: changesRef("main", branch), writer: "yrd" })
    ).append(
      [
        changeInput("opened", { queueTip, at: now, commit: head, by: "yrd" }),
        changeInput("merged", { queueTip, at: now, commit: head, run: oldRun }),
        changeInput("opened", { queueTip, at: now, commit: nextHead, by: "yrd" }),
        changeInput("verifying", { queueTip, at: now, commit: nextHead, run: currentRun }),
      ],
      { expect: null },
    )
    const workdir = await workdirOf(git, { cwd: repo })
    const recent = await readEventListing(git, config, repo, workdir, head, store, { recent: { env: process.env } })
    expect(recent.journals.absent).toContain(currentRun)
    expect(recent.journals.absent).not.toContain(oldRun)
    const detail = await readEventListing(git, config, repo, workdir, head, store, { branch })
    expect(detail.journals.absent).toContain(oldRun)
    expect(detail.journals.absent).toContain(currentRun)
  })

  // @failure A warm recent-history cache keeps an ending visible after its recorded Time leaves the window.
  // @level l2; @consumer queue list/watch using an unchanged event inventory
  it("expires cached endings at the recorded-time window boundary", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const store = createEventStore(repo, "origin", git.selection)
    const head = (await git(["rev-parse", "HEAD"])).trim()
    const config = await readConfig(git, head, { branch: "main", remote: "origin" })
    if (config === undefined) throw new Error("fixture declaration absent")
    const now = Date.now()
    const ended = new Date(now - 7 * 86400000 + 500)
    const queueTip = await createQueue(repo, "main", head, new Date(ended.getTime() - 60_000))
    const branch = "task/window-boundary"
    await (
      await openEvents({ ...store, ref: changesRef("main", branch), writer: "yrd" })
    ).append(
      [
        changeInput("opened", { queueTip, at: ended, commit: head, by: "yrd" }),
        changeInput("merged", { queueTip, at: ended, commit: head }),
      ],
      { expect: null },
    )
    const workdir = await workdirOf(git, { cwd: repo })
    const first = await readEventListing(git, config, repo, workdir, head, store, { now, recent: { env: process.env } })
    expect(first.all.map((row) => row.branch)).toContain(branch)
    const warm = await readEventListing(git, config, repo, workdir, head, store, {
      now: now + 1000,
      recent: { env: process.env },
    })
    expect(warm.all.map((row) => row.branch)).not.toContain(branch)
  })

  // 25655: migrated endings retain their original times. The default list's
  // seven-day window must not make their full change histories unshowable.
  it("shows an old ended event change without widening a later default list", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const store = createEventStore(repo, "origin", git.selection)
    const head = (await git(["rev-parse", "HEAD"])).trim()
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    const queueTip = await createQueue(repo, "main", head, old)
    const branch = "task/old-merged"
    await (
      await openEvents({ ...store, ref: changesRef("main", branch), writer: "yrd" })
    ).append(
      [
        changeInput("opened", { queueTip, at: old, commit: head, by: "yrd" }),
        changeInput("merged", { queueTip, at: old, commit: head }),
      ],
      { expect: null },
    )
    const list = async () => {
      const output = capture(repo)
      expect(await coreQueueCommand(repo, output.io, { command: "list" }, { json: true, queue: "main" })).toBe(0)
      const result = JSON.parse(output.stdout()) as { changes: readonly { branch: string }[]; scope: string }
      expect(result.scope).toContain("Read 0 of 1 retained change histories")
      expect(result.scope).toContain("recorded ending Time")
      expect(result.scope).toContain("Global history diagnostics and direct target commits were not checked")
      return result.changes
    }
    expect((await list()).some((row) => row.branch === branch)).toBe(false)
    const shown = capture(repo)
    expect(
      await coreQueueCommand(repo, shown.io, { command: "show", branch }, { json: true, queue: "main" }),
      shown.stderr(),
    ).toBe(0)
    expect((JSON.parse(shown.stdout()) as { changes: readonly { branch: string; state: string }[] }).changes).toEqual([
      expect.objectContaining({ branch, state: "merged" }),
    ])
    const complete = capture(repo)
    expect(
      await coreQueueCommand(repo, complete.io, { command: "list", all: true }, { json: true, queue: "main" }),
    ).toBe(0)
    expect((JSON.parse(complete.stdout()) as { changes: readonly { branch: string }[] }).changes).toEqual([
      expect.objectContaining({ branch }),
    ])
    expect((await list()).some((row) => row.branch === branch)).toBe(false)
  }, 15_000)

  it("uses every event change status unchanged in JSON, the table, and status filters", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const store = createEventStore(repo, "origin", gitIn(repo).selection)
    const commit = (await git(["rev-parse", "HEAD"])).trim()
    const queueTip = await createQueue(repo, "main", commit, new Date("2026-09-22T14:00:00.000Z"))
    const statuses = CHANGE_STATUSES.filter((status) => status !== "draft")
    await git(["checkout", "--quiet", "-b", "task/draft"])
    writeFileSync(join(repo, "draft.txt"), "draft\n")
    await git(["add", "draft.txt"])
    await git(["commit", "--quiet", "-m", "unsubmitted draft"])
    await git(["push", "--quiet", "origin", "task/draft"])
    await git(["checkout", "--quiet", "main"])

    for (const [index, status] of statuses.entries()) {
      const branch = `task/status-${String(index)}`
      const at = (minute: number): Date => new Date(`2026-09-22T14:${String(minute).padStart(2, "0")}:00.000Z`)
      const events = [changeInput("opened", { queueTip, at: at(index * 5 + 1), commit, by: "yrd" })]
      if (status === "verifying" || status === "checking" || status === "merging") {
        events.push(changeInput("verifying", { queueTip, at: at(index * 5 + 2), commit }))
      }
      if (status === "checking" || status === "merging") {
        events.push(changeInput("checking", { queueTip, at: at(index * 5 + 3) }))
      }
      if (status === "merging") events.push(changeInput("merging", { queueTip, at: at(index * 5 + 4), commit }))
      if (status === "merged") events.push(changeInput("merged", { queueTip, at: at(index * 5 + 2), commit }))
      if (status === "failed") {
        events.push(changeInput("failed", { queueTip, at: at(index * 5 + 2), reason: "check failed" }))
      }
      if (status === "stuck") {
        events.push(changeInput("stuck", { queueTip, at: at(index * 5 + 2), reason: "operator" }))
      }
      if (status === "cancelled") {
        events.push(changeInput("cancelled", { queueTip, at: at(index * 5 + 2), reason: "resubmitted" }))
      }
      await (
        await openEvents({ ...store, ref: changesRef("main", branch), writer: "yrd" })
      ).append(events, {
        expect: null,
      })
    }

    const json = capture(repo)
    expect(
      await coreQueueCommand(
        repo,
        json.io,
        { command: "list", all: true, drafts: true },
        { json: true, queue: "main" },
      ),
    ).toBe(0)
    expect(
      (JSON.parse(json.stdout()) as { changes: readonly { state: string }[] }).changes.map((row) => row.state).sort(),
    ).toEqual([...CHANGE_STATUSES].sort())

    const table = capture(repo)
    expect(
      await coreQueueCommand(repo, table.io, { command: "list", all: true, drafts: true }, { queue: "main" }),
    ).toBe(0)
    for (const [index, status] of CHANGE_STATUSES.entries()) {
      const branch = status === "draft" ? "task/draft" : `task/status-${String(index - 1)}`
      const rowLabel = status === "draft" ? `draft ${branch}` : `queue ${branch}`
      expect(
        table
          .stdout()
          .split("\n")
          .find((line) => line.includes(rowLabel)),
      ).toMatch(new RegExp(`\\b${status}\\b`, "u"))
      const filteredJson = capture(repo)
      expect(
        await coreQueueCommand(
          repo,
          filteredJson.io,
          { command: "list", terms: [status], all: true, drafts: status === "draft" },
          { json: true, queue: "main" },
        ),
      ).toBe(0)
      expect(
        (JSON.parse(filteredJson.stdout()) as { changes: readonly { branch: string; state: string }[] }).changes,
      ).toEqual([expect.objectContaining({ branch, state: status })])
      const filteredTable = capture(repo)
      expect(
        await coreQueueCommand(
          repo,
          filteredTable.io,
          { command: "list", terms: [status], all: true, drafts: status === "draft" },
          { queue: "main" },
        ),
      ).toBe(0)
      expect(
        filteredTable
          .stdout()
          .split("\n")
          .find((line) => line.includes(rowLabel)),
      ).toMatch(new RegExp(`\\b${status}\\b`, "u"))
    }
  }, 15_000)

  it("lists direct commits after the declaration until a merged event accounts for the line", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const store = createEventStore(repo, "origin", gitIn(repo).selection)
    const declaration = (await git(["rev-parse", "HEAD"])).trim()
    const queueTip = await createQueue(repo, "main", declaration, new Date("2026-09-22T14:00:00.000Z"))

    writeFileSync(join(repo, "direct.txt"), "around the queue\n")
    await git(["add", "direct.txt"])
    await git(["commit", "--quiet", "-m", "direct target commit"])
    const direct = (await git(["rev-parse", "HEAD"])).trim()
    await git(["push", "--quiet", "origin", "main"])

    const listed = capture(repo)
    expect(
      await coreQueueCommand(
        repo,
        listed.io,
        { command: "list", all: true, terms: ["direct"] },
        { json: true, queue: "main" },
      ),
    ).toBe(0)
    expect((JSON.parse(listed.stdout()) as { changes: readonly { head: string; state: string }[] }).changes).toEqual([
      expect.objectContaining({ head: direct, state: "direct" }),
    ])
    expect(listed.stdout()).not.toContain(declaration)

    const table = capture(repo)
    expect(
      await coreQueueCommand(repo, table.io, { command: "list", all: true, terms: ["direct"] }, { queue: "main" }),
    ).toBe(0)
    expect(table.stdout()).toContain(direct.slice(0, 12))
    expect(table.stdout()).toMatch(/\bdirect\b/u)

    writeFileSync(join(repo, "queued.txt"), "queue publication\n")
    await git(["add", "queued.txt"])
    await git(["commit", "--quiet", "-m", "queue publication"])
    const published = (await git(["rev-parse", "HEAD"])).trim()
    await git(["push", "--quiet", "origin", "main"])
    await (
      await openEvents({ ...store, ref: changesRef("main", "task/accounted"), writer: "yrd" })
    ).append(
      [
        changeInput("opened", {
          queueTip,
          at: new Date("2026-09-22T14:01:00.000Z"),
          commit: published,
          by: "yrd",
        }),
        changeInput("merged", {
          queueTip,
          at: new Date("2026-09-22T14:02:00.000Z"),
          commit: published,
        }),
      ],
      { expect: null },
    )

    const accounted = capture(repo)
    expect(
      await coreQueueCommand(
        repo,
        accounted.io,
        { command: "list", all: true, terms: ["direct"] },
        { json: true, queue: "main" },
      ),
    ).toBe(0)
    expect((JSON.parse(accounted.stdout()) as { changes: readonly unknown[] }).changes).toEqual([])
  }, 15_000)

  it("shows an older direct commit after an accounted queue publication", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const store = createEventStore(repo, "origin", git.selection)
    const declaration = (await git(["rev-parse", "HEAD"])).trim()
    const queueTip = await createQueue(repo, "main", declaration, new Date("2026-09-22T14:00:00.000Z"))
    writeFileSync(join(repo, "older.txt"), "direct\n")
    await git(["add", "older.txt"])
    await git(["commit", "--quiet", "-m", "older direct"])
    const direct = (await git(["rev-parse", "HEAD"])).trim()
    writeFileSync(join(repo, "accounted.txt"), "queue\n")
    await git(["add", "accounted.txt"])
    await git(["commit", "--quiet", "-m", "accounted queue publication"])
    const published = (await git(["rev-parse", "HEAD"])).trim()
    await git(["push", "--quiet", "origin", "main"])
    await (
      await openEvents({ ...store, ref: changesRef("main", "task/accounted"), writer: "yrd" })
    ).append(
      [
        changeInput("opened", { queueTip, at: new Date("2026-09-22T14:01:00.000Z"), commit: published, by: "yrd" }),
        changeInput("merged", { queueTip, at: new Date("2026-09-22T14:02:00.000Z"), commit: published }),
      ],
      { expect: null },
    )
    const shown = capture(repo)
    expect(await coreQueueCommand(repo, shown.io, { command: "show", all: true }, { json: true, queue: "main" })).toBe(
      0,
    )
    const rows = (JSON.parse(shown.stdout()) as { changes: readonly { head: string; state: string }[] }).changes
    expect(rows).toContainEqual(expect.objectContaining({ head: direct, state: "direct" }))
  }, 15_000)

  it("shows every direct commit by its commit identity", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const declaration = (await git(["rev-parse", "HEAD"])).trim()
    await createQueue(repo, "main", declaration, new Date("2026-09-22T14:00:00.000Z"))
    const direct: string[] = []
    for (const name of ["first", "second"]) {
      writeFileSync(join(repo, `${name}.txt`), `${name}\n`)
      await git(["add", `${name}.txt`])
      const at = name === "first" ? "2026-09-22T14:01:00Z" : "2026-09-22T14:02:00Z"
      await gitIn(repo, undefined, git.selection, {
        env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
      })(["commit", "--quiet", "-m", `${name} direct`])
      direct.push((await git(["rev-parse", "HEAD"])).trim())
    }
    await git(["push", "--quiet", "origin", "main"])
    const shown = capture(repo)
    expect(await coreQueueCommand(repo, shown.io, { command: "show", all: true }, { json: true, queue: "main" })).toBe(
      0,
    )
    const rows = (JSON.parse(shown.stdout()) as { changes: readonly { head: string; state: string }[] }).changes
    // The listing is newest first; distinct fixed times expose the order even on a fast host.
    expect(rows.filter((row) => row.state === "direct").map((row) => row.head)).toEqual([direct[1], direct[0]])
  }, 15_000)

  /**
   * @failure Expanded drop misses submodule refs, mutates during preview, or deletes unlanded/held/moved work.
   * @level l3
   * @consumer An author previewing and applying issue cleanup in their own submodule stores
   */
  it("drop by issue previews registered submodules without issue lookup and applies exact landed tips", async () => {
    // A configured resolver that always fails proves this mode never consults issue status.
    const repo = await world('issuesProvider: {read: ["false"]}\n')
    const seed = await world()
    const git = gitIn(repo)
    await git([
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--quiet",
      join(dirname(seed), "remote.git"),
      "modules/child",
    ])
    await git(["commit", "--quiet", "-am", "register child"])
    await git(["push", "--quiet", "origin", "main"])
    await createQueue(repo, "main", (await git(["rev-parse", "HEAD"])).trim(), new Date())
    const child = join(repo, "modules/child")
    const childGit = gitIn(child)
    await childGit(["config", "user.name", "yrd test"])
    await childGit(["config", "user.email", "yrd@test.invalid"])
    const landed = (await childGit(["rev-parse", "HEAD"])).trim()
    for (const branch of [
      "task/28988-landed",
      "exp/28988-landed",
      "task/28988-held",
      "task/28988-moved",
      "task/99999-other",
      "task/no-number",
    ]) {
      await childGit(["branch", branch, landed])
    }
    await childGit(["checkout", "--quiet", "-b", "task/28988-unique"])
    writeFileSync(join(child, "unique.txt"), "unpublished\n")
    await childGit(["add", "unique.txt"])
    await childGit(["commit", "--quiet", "-m", "unique work"])
    const unique = (await childGit(["rev-parse", "HEAD"])).trim()
    await childGit(["checkout", "--quiet", "task/28988-held"])
    const refs = async (read: typeof git) =>
      read(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/", "refs/archive/", "refs/yrd/"])
    const rootBefore = await refs(git)
    const childBefore = await refs(childGit)
    const argv = [
      "bun",
      "yrd",
      "drop",
      "--issue",
      "@example/28988-cleanup",
      "--submodules",
      "--submitter",
      "fixture",
      "--json",
    ]
    const fixtureIssue: NonNullable<YrdCliIO["branchIssue"]> = ({ branch, recordedIssue }) => {
      const key = recordedIssue ?? /^(\d+)-/u.exec(branch.split("/").at(-1) ?? "")?.[1]
      return key === "28988" ? "@example/28988-cleanup" : key
    }
    type Report = {
      excluded: { repo: string; target: number; unrelated: number; unnumbered: number }[]
      eligible: { repo: string; branch: string; head: string }[]
      removed: { repo: string; branch: string; head: string; archiveRef: string }[]
      kept: { repo: string; branch: string; reason: string }[]
      failed: { repo: string; reason: string }[]
    }
    for (const flags of [[], ["--dry-run"]]) {
      const preview = capture(repo)
      preview.io.branchIssue = fixtureIssue
      expect(await runYrdProcess([...argv, ...flags], preview.io), preview.stderr()).toBe(0)
      const result = JSON.parse(preview.stdout()) as Report
      expect(result.eligible.map((row) => row.branch).sort()).toEqual([
        "exp/28988-landed",
        "task/28988-landed",
        "task/28988-moved",
      ])
      expect(result.eligible.every((row) => row.repo === child && row.head === landed)).toBe(true)
      expect(result.removed).toEqual([])
      expect(result.kept).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ repo: child, branch: "task/28988-held", reason: "held" }),
          expect.objectContaining({ repo: child, branch: "task/28988-unique", reason: "unreached" }),
        ]),
      )
      expect(result.excluded).toContainEqual({ repo: child, target: 1, unrelated: 1, unnumbered: 1 })
      expect(result.kept.every((row) => row.branch.includes("28988"))).toBe(true)
      expect(await refs(git)).toBe(rootBefore)
      expect(await refs(childGit)).toBe(childBefore)
    }
    const apply = capture(repo)
    apply.io.branchIssue = fixtureIssue
    let moved = false
    apply.io.localBranchProtections = async (input) => {
      if (input.repo === child && input.branch === "task/28988-moved" && !moved) {
        moved = true
        await childGit(["update-ref", "refs/heads/task/28988-moved", unique, landed])
      }
      return { protections: [], evidence: [] }
    }
    expect(await runYrdProcess([...argv, "--apply"], apply.io), apply.stderr()).toBe(0)
    const result = JSON.parse(apply.stdout()) as Report
    expect(result.removed.map((row) => row.branch).sort()).toEqual(["exp/28988-landed", "task/28988-landed"])
    for (const row of result.removed) {
      expect((await childGit(["rev-parse", row.archiveRef])).trim()).toBe(landed)
      expect((await childGit(["for-each-ref", "--format=%(refname)", `refs/heads/${row.branch}`])).trim()).toBe("")
    }
    expect(result.kept).toContainEqual(
      expect.objectContaining({ repo: child, branch: "task/28988-moved", reason: "moved" }),
    )
    expect((await childGit(["rev-parse", "refs/heads/task/28988-unique"])).trim()).toBe(unique)
    expect((await childGit(["rev-parse", "refs/heads/task/28988-held"])).trim()).toBe(landed)
    expect(await refs(git)).toBe(rootBefore)
    // No component cleanup is misrepresented as a dropped root-queue change.
    expect((await listChanges(createEventStore(repo, "origin", git.selection), "main")).size).toBe(0)
    // Missing materialization must name the child, never discover and mutate the root through Git's upward search.
    fs.renameSync(join(child, ".git"), join(child, ".git-unavailable"))
    try {
      const missing = capture(repo)
      expect(await runYrdProcess(argv, missing.io), missing.stderr()).toBe(1)
      expect((JSON.parse(missing.stdout()) as Report).failed).toContainEqual(
        expect.objectContaining({ repo: child, reason: "unreadable" }),
      )
      expect(await refs(git)).toBe(rootBefore)
    } finally {
      fs.renameSync(join(child, ".git-unavailable"), join(child, ".git"))
    }
    // AC5 (29060): like the --local path (28791), the --submodules path must leave a
    // journal the projection reader can persist. A writer that omits the run header
    // writes an unreadable journal and a journal-projection warning, and every
    // reader — this one or an older build — then refuses the whole queue on that
    // single record. Custody assertions above miss it.
    const dropLogs = join(await workdirOf(git, { cwd: repo }), "logs")
    const dropJournals = readdirSync(dropLogs).filter((name) => name.endsWith(".jsonl"))
    expect(dropJournals.length).toBeGreaterThan(0)
    const dropRecords = dropJournals.flatMap((name) => readRunLog(dropLogs, name.slice(0, -".jsonl".length)))
    for (const name of dropJournals) {
      expect(readRunLog(dropLogs, name.slice(0, -".jsonl".length))[0]?.kind).toBe("run")
    }
    expect(dropRecords.filter((row) => row.subject === "journal-projection")).toEqual([])
    expect(dropRecords).toContainEqual(
      expect.objectContaining({ kind: "local-branch-retirement", branch: "task/28988-landed", outcome: "removed" }),
    )
  }, 60_000)

  /**
   * @failure Landing evidence disappears after resubmission, or a root pin without component origin custody permits deletion.
   * @level l3
   * @consumer The expanded drop command retiring component work beyond origin/main
   */
  it("drop by issue keeps historical landing pins without exact-head main ancestry", async () => {
    const repo = await world('issuesProvider: {read: ["false"]}\n')
    const seed = await world()
    const git = gitIn(repo)
    await git([
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--quiet",
      join(dirname(seed), "remote.git"),
      "child",
    ])
    await git(["commit", "--quiet", "-am", "register child"])
    await git(["push", "--quiet", "origin", "main"])
    const queueTip = await createQueue(repo, "main", (await git(["rev-parse", "HEAD"])).trim(), new Date())
    const child = join(repo, "child")
    const childGit = gitIn(child)
    await childGit(["config", "user.name", "yrd test"])
    await childGit(["config", "user.email", "yrd@test.invalid"])
    const chain = await openEvents({
      ...createEventStore(repo, "origin", git.selection),
      ref: changesRef("main", "task/28988-root"),
      writer: "yrd",
    })
    const tips = new Map<string, string>()
    let eventHead: string | null = null
    for (const kind of ["recorded", "pin-only", "old-event"]) {
      const branch = `task/28988-${kind}`
      await childGit(["checkout", "--quiet", "-b", branch, "main"])
      writeFileSync(join(child, `${kind}.txt`), kind)
      await childGit(["add", `${kind}.txt`])
      await childGit(["commit", "--quiet", "-m", kind])
      const tip = (await childGit(["rev-parse", "HEAD"])).trim()
      tips.set(branch, tip)
      if (kind !== "pin-only") await childGit(["push", "--quiet", "origin", `${branch}:refs/heads/${kind}`])
      await git(["add", "child"])
      await git(["commit", "--quiet", "-m", `root carries ${kind}`])
      await git(["push", "--quiet", "origin", "main"])
      const rootTip = (await git(["rev-parse", "HEAD"])).trim()
      const written = await chain.append(
        [
          changeInput("opened", { queueTip, at: new Date(), commit: rootTip, by: "fixture" }),
          changeInput("merged", {
            queueTip,
            at: new Date(),
            commit: rootTip,
            ...(kind === "old-event" ? {} : { landedGitlinks: [{ path: "child", target: tip }] }),
          }),
        ],
        { expect: eventHead },
      )
      eventHead = written.head
    }
    // The latest state has no pins: cleanup must read each historical merged event through the existing fold.
    await chain.append(
      [
        changeInput("opened", {
          queueTip,
          at: new Date(),
          commit: (await git(["rev-parse", "HEAD"])).trim(),
          by: "fixture",
        }),
      ],
      { expect: eventHead },
    )
    await childGit(["checkout", "--quiet", "main"])
    const argv = ["bun", "yrd", "drop", "--issue", "28988", "--submodules", "--submitter", "fixture", "--json"]
    const preview = capture(repo)
    expect(await runYrdProcess(argv, preview.io), preview.stderr()).toBe(0)
    const report = JSON.parse(preview.stdout()) as {
      eligible: { branch: string }[]
      kept: { branch: string; reason: string }[]
    }
    expect(report.eligible).toEqual([])
    expect(report.kept).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ branch: "task/28988-recorded", reason: "unreached" }),
        expect.objectContaining({ branch: "task/28988-pin-only", reason: "unreached" }),
        expect.objectContaining({ branch: "task/28988-old-event", reason: "unreached" }),
      ]),
    )
    const apply = capture(repo)
    expect(await runYrdProcess([...argv, "--apply"], apply.io), apply.stderr()).toBe(0)
    const removed = (JSON.parse(apply.stdout()) as { removed: { branch: string; archiveRef: string }[] }).removed
    expect(removed).toEqual([])
    expect((await childGit(["rev-parse", "refs/heads/task/28988-recorded"])).trim()).toBe(
      tips.get("task/28988-recorded"),
    )
    for (const branch of ["task/28988-pin-only", "task/28988-old-event"]) {
      expect((await childGit(["rev-parse", `refs/heads/${branch}`])).trim()).toBe(tips.get(branch))
    }
  }, 60_000)

  /**
   * @failure Issue cleanup deletes unpublished work without origin custody, or removes an advanced submitted branch.
   * @level l3
   * @consumer The closer running yrd drop --issue after durable issue closure
   */
  it("drop by issue keeps unpublished work and advanced submitted tips; explicit abandonment retains custody", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    await createQueue(repo, "main", (await git(["rev-parse", "HEAD"])).trim(), new Date())
    const issue = "@example/28791-retirement"
    const saved = new Map<string, string>()
    for (const branch of ["task/28791-local-only", "task/manual-only", "task/28791-advanced"]) {
      await git(["checkout", "--quiet", "-b", branch, "main"])
      writeFileSync(join(repo, "work.txt"), branch)
      await git(["add", "work.txt"])
      await git([
        "commit",
        "--quiet",
        "-m",
        `work\n\nRefs: ${branch === "task/manual-only" ? "@example/other-issue" : issue}`,
      ])
      saved.set(branch, (await git(["rev-parse", "HEAD"])).trim())
      if (branch === "task/28791-advanced") {
        const submitted = capture(repo)
        expect(await runYrdProcess(["bun", "yrd", "submit", "--json"], submitted.io), submitted.stderr()).toBe(0)
        await git(["commit", "--quiet", "--allow-empty", "-m", "new work after submission"])
      }
    }
    const advanced = (await git(["rev-parse", "HEAD"])).trim()
    await git(["checkout", "--quiet", "main"])
    const output = capture(repo)
    output.io.branchIssue = ({ branch, recordedIssue }) =>
      recordedIssue ?? (saved.has(branch) && branch !== "task/manual-only" ? issue : undefined)
    expect(
      await runYrdProcess(["bun", "yrd", "drop", "--issue", issue, "--submitter", "fixture", "--json"], output.io),
      output.stderr(),
    ).toBe(0)
    const report = JSON.parse(output.stdout()) as {
      removed: { branch: string; head: string; archiveRef: string }[]
      kept: { branch: string; reason: string }[]
    }
    expect(report.removed).toEqual([])
    expect(report.kept).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ branch: "task/28791-local-only", reason: "unreached" }),
        // 29579: a branch with work the target lacks names that cure, never a ref move.
        expect.objectContaining({
          branch: "task/28791-advanced",
          reason: "advanced",
          detail:
            "current tip " +
            advanced +
            " differs from recorded change tip " +
            saved.get("task/28791-advanced") +
            "; it holds commits origin/main lacks: submit them, and drop the branch after they land",
        }),
      ]),
    )
    expect((await git(["rev-parse", "refs/heads/task/28791-local-only"])).trim()).toBe(
      saved.get("task/28791-local-only"),
    )
    expect((await git(["rev-parse", "refs/heads/task/28791-advanced"])).trim()).toBe(advanced)
    expect(
      (await listChanges(createEventStore(repo, "origin", git.selection), "main")).has("task/28791-local-only"),
    ).toBe(false)
    // Manual cleanup is exact-branch/exact-tip, and does not expand to the issue's other refs.
    const manual = capture(repo)
    const manualHead = saved.get("task/manual-only")!
    expect(
      await runYrdProcess(
        ["bun", "yrd", "drop", "task/manual-only", "--local", "--tip", manualHead, "--submitter", "fixture", "--json"],
        manual.io,
      ),
      manual.stderr(),
    ).toBe(0)
    const manualReport = JSON.parse(manual.stdout()) as { removed: { branch: string; archiveRef: string }[] }
    expect(manualReport.removed).toEqual([expect.objectContaining({ branch: "task/manual-only" })])
    expect((await git(["ls-remote", "origin", manualReport.removed[0]!.archiveRef])).split("\t")[0]).toBe(manualHead)
    expect((await git(["rev-parse", "refs/heads/task/28791-advanced"])).trim()).toBe(advanced)
    // Accepted29301: local expected=head, but the recorded change has an older head.
    // Existing assertions only check the reason token, so they miss identical SHAs in the detail.
    await git(["push", "--quiet", "origin", advanced + ":refs/heads/main"])
    await git(["fetch", "--quiet", "origin", "main"])
    await git(["merge-base", "--is-ancestor", advanced, "origin/main"])
    const local = capture(repo)
    expect(
      await runYrdProcess(
        ["bun", "yrd", "drop", "task/28791-advanced", "--local", "--tip", advanced, "--submitter", "fixture", "--json"],
        local.io,
      ),
      local.stderr(),
    ).toBe(0)
    expect(JSON.parse(local.stdout())).toMatchObject({
      removed: [],
      kept: [
        {
          branch: "task/28791-advanced",
          head: advanced,
          reason: "advanced",
          // 29579: the target already holds the tip, so the detail names the move back and the rerun.
          detail:
            "current tip " +
            advanced +
            " differs from recorded change tip " +
            saved.get("task/28791-advanced") +
            "; origin/main already holds " +
            advanced +
            ", so nothing is lost: move the branch back with git update-ref refs/heads/task/28791-advanced " +
            saved.get("task/28791-advanced") +
            " " +
            advanced +
            ", then rerun with --tip " +
            saved.get("task/28791-advanced"),
        },
      ],
    })
    expect((await git(["rev-parse", "refs/heads/task/28791-advanced"])).trim()).toBe(advanced)
    const requested = capture(repo)
    expect(
      await runYrdProcess(
        [
          "bun",
          "yrd",
          "drop",
          "task/28791-advanced",
          "--local",
          "--tip",
          saved.get("task/28791-advanced")!,
          "--submitter",
          "fixture",
          "--json",
        ],
        requested.io,
      ),
      requested.stderr(),
    ).toBe(0)
    expect(JSON.parse(requested.stdout())).toMatchObject({
      removed: [],
      kept: [
        {
          branch: "task/28791-advanced",
          reason: "advanced",
          detail:
            "current tip " +
            advanced +
            " differs from requested tip " +
            saved.get("task/28791-advanced") +
            "; if " +
            advanced +
            " is the tip to retire, rerun with --tip " +
            advanced +
            ", otherwise the branch gained commits after you read it",
        },
      ],
    })
    // 29579: the named cure works. Moved back to its recorded tip, the branch the target already holds retires.
    await git(["update-ref", "refs/heads/task/28791-advanced", saved.get("task/28791-advanced")!, advanced])
    const cured = capture(repo)
    expect(
      await runYrdProcess(
        [
          "bun",
          "yrd",
          "drop",
          "task/28791-advanced",
          "--local",
          "--tip",
          saved.get("task/28791-advanced")!,
          "--submitter",
          "fixture",
          "--json",
        ],
        cured.io,
      ),
      cured.stderr(),
    ).toBe(0)
    expect(JSON.parse(cured.stdout())).toMatchObject({
      kept: [],
      removed: [{ branch: "task/28791-advanced", head: saved.get("task/28791-advanced") }],
    })
    // AC5: the command's journal must remain readable by the existing projection reader.
    // Custody assertions alone miss a writer that omits the required run header.
    const logs = join(await workdirOf(git, { cwd: repo }), "logs")
    const records = readdirSync(logs)
      .filter((name) => name.endsWith(".jsonl"))
      .flatMap((name) => readRunLog(logs, name.slice(0, -".jsonl".length)))
    expect(records.filter((row) => row.subject === "journal-projection")).toEqual([])
    expect(records).toContainEqual(
      expect.objectContaining({
        kind: "local-branch-retirement",
        branch: "task/manual-only",
        head: manualHead,
        outcome: "removed",
      }),
    )
  })

  /**
   * @failure `yrd drop --issue` silently excludes a named branch it cannot bind (no yrd
   *   submission and a trailing segment that cannot match by name) and only counts it, so
   *   the caller reading the exit code believes its named row was handled (29291).
   * @level l3
   * @consumer The closer running yrd drop --issue after durable issue closure
   */
  it("drop by issue names a caller-named branch it excludes because it has no submission binding (29291)", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    await createQueue(repo, "main", (await git(["rev-parse", "HEAD"])).trim(), new Date())
    // No yrd submission, and the trailing segment `dev12-26133-sweep-tests` cannot match by name
    // (`issueFromBranchName` anchors digits at the start of the last path segment), so the branch is
    // excluded — and its `Refs:` trailer is never read.
    await git(["checkout", "--quiet", "-b", "task/dev12-26133-sweep-tests", "main"])
    writeFileSync(join(repo, "unbound.txt"), "unbound\n")
    await git(["add", "unbound.txt"])
    await git([
      "commit",
      "--quiet",
      "-m",
      "unbound work\n\nRefs: @i/22-harness-waist/26133-agents-md-is-the-one-instruction-file",
    ])
    await git(["checkout", "--quiet", "main"])
    const output = capture(repo)
    expect(
      await runYrdProcess(
        ["bun", "yrd", "drop", "--issue", "26133", "--dry-run", "--submitter", "fixture", "--json"],
        output.io,
      ),
      output.stderr(),
    ).toBe(0)
    const report = JSON.parse(output.stdout()) as {
      excluded: { repo: string; target: number; unrelated: number; unnumbered: number }[]
      unnumbered: { branch: string; head: string }[]
    }
    // The command cannot classify this branch, so it must be NAMED with its head, not folded into the count.
    expect(report.excluded).toEqual([
      expect.objectContaining({ repo: expect.any(String), target: 1, unrelated: 0, unnumbered: 1 }),
    ])
    expect(report.unnumbered).toEqual([
      expect.objectContaining({ branch: "task/dev12-26133-sweep-tests", head: expect.any(String) }),
    ])
  })

  /**
   * @failure A run that retires or previews some branches and cannot classify others reports a
   *   bare success (`eligible N, kept M, failed 0`, exit 0) with only a count, so a caller whose
   *   fallback is "if every branch was excluded, do something else" takes the wrong path precisely
   *   on a partial match (29291).
   * @level l3
   * @consumer The closer running yrd drop --issue after durable issue closure
   */
  it("drop by issue names the unnumbered branch in a partial match and keeps exit 0 (29291)", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    await createQueue(repo, "main", (await git(["rev-parse", "HEAD"])).trim(), new Date())
    // One branch the issue reaches by name, archived so the preview lists it as eligible...
    await git(["checkout", "--quiet", "-b", "task/26133-archived", "main"])
    writeFileSync(join(repo, "archived.txt"), "archived\n")
    await git(["add", "archived.txt"])
    await git(["commit", "--quiet", "-m", "archived work"])
    const archivedTip = (await git(["rev-parse", "HEAD"])).trim()
    await git(["push", "--quiet", "origin", `${archivedTip}:refs/archive/2026-10-12/fixture/task/26133-archived`])
    // ...and one it cannot bind at all.
    await git(["checkout", "--quiet", "-b", "task/dev12-26133-sweep-tests", "main"])
    writeFileSync(join(repo, "unbound.txt"), "unbound\n")
    await git(["add", "unbound.txt"])
    await git(["commit", "--quiet", "-m", "unbound work"])
    await git(["checkout", "--quiet", "main"])
    const output = capture(repo)
    expect(
      await runYrdProcess(
        ["bun", "yrd", "drop", "--issue", "26133", "--dry-run", "--submitter", "fixture", "--json"],
        output.io,
      ),
      output.stderr(),
    ).toBe(0)
    const report = JSON.parse(output.stdout()) as {
      eligible: unknown[]
      unnumbered: { branch: string; head: string }[]
    }
    expect(report.eligible.length).toBeGreaterThan(0)
    // The unnumbered branch is named; there is no partial flag and the exit stays 0.
    expect(report.unnumbered).toEqual([
      expect.objectContaining({ branch: "task/dev12-26133-sweep-tests", head: expect.any(String) }),
    ])
    expect(report).not.toHaveProperty("partial")
    // The human summary names it and says so rather than reporting a bare success.
    const human = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "drop", "--issue", "26133", "--dry-run", "--submitter", "fixture"], human.io),
      human.stderr(),
    ).toBe(0)
    expect(human.stdout()).toContain("task/dev12-26133-sweep-tests")
    expect(human.stdout()).toContain("unnumbered")
    expect(human.stdout()).toContain("(named below)")
  })

  /** @failure Root cleanup accepts custody for another branch or tip, ignores an active reopening,
   * or lets a failing issue resolver change what is removed (29450: the resolver is consulted for the
   * issue's status only). Existing component cases prove only gitlink custody.
   * @level l3 @consumer A closer previewing and applying exact root branch cleanup
   */
  it("drop by issue requires exact root custody and preserves active, held and unreadable branches", async () => {
    const repo = await world('issuesProvider: {read: ["sh", "-c", "touch resolver-ran; exit 1"]}\n')
    const git = gitIn(repo)
    const queueTip = await createQueue(repo, "main", (await git(["rev-parse", "HEAD"])).trim(), new Date())
    const tips = new Map<string, string>()
    for (const kind of ["landed", "archived", "wrong-branch", "wrong-tip", "active", "held", "unreadable", "invalid"]) {
      const branch = `task/29010-${kind}`
      await git(["checkout", "--quiet", "-b", branch, "main"])
      await git(["commit", "--quiet", "--allow-empty", "-m", kind])
      const tip = (await git(["rev-parse", "HEAD"])).trim()
      tips.set(branch, tip)
      if (["landed", "active", "held", "unreadable", "invalid"].includes(kind)) {
        const chain = await openEvents({
          ...createEventStore(repo, "origin", git.selection),
          ref: changesRef("main", branch),
          writer: "yrd",
        })
        const written = await chain.append(
          [
            changeInput("opened", {
              queueTip,
              at: new Date(),
              commit: tip,
              by: "fixture",
              issue: "@example/29010-custody",
            }),
            changeInput("merged", { queueTip, at: new Date(), commit: tip }),
          ],
          { expect: null },
        )
        if (kind === "active") {
          await chain.append(
            [
              changeInput("opened", {
                queueTip,
                at: new Date(),
                commit: tip,
                by: "fixture",
                issue: "@example/29010-custody",
              }),
            ],
            { expect: written.head },
          )
        }
        if (kind === "invalid") await chain.append([{ type: "merged" }], { expect: written.head })
        if (kind === "unreadable") await chain.append([{ type: "not-a-yrd-event" }], { expect: written.head })
      }
      if (kind === "archived" || kind === "wrong-branch") {
        const archivedBranch = kind === "archived" ? branch : `prefix/${branch}`
        await git(["push", "--quiet", "origin", `${tip}:refs/archive/2026-10-12/fixture/${archivedBranch}`])
      }
      if (kind === "wrong-tip") {
        await git(["push", "--quiet", "origin", `main:refs/archive/2026-10-12/fixture/${branch}`])
      }
    }
    await git(["checkout", "--quiet", "main"])
    const args = ["bun", "yrd", "drop", "--issue", "@example/29010-custody", "--submitter", "fixture", "--json"]
    const preview = capture(repo)
    preview.io.branchIssue = ({ branch, recordedIssue }) =>
      recordedIssue ?? (tips.has(branch) ? "@example/29010-custody" : undefined)
    preview.io.localBranchProtections = async ({ branch }) => ({
      protections: branch.endsWith("-held") ? ["fixture hold"] : [],
      evidence: [],
    })
    expect(await runYrdProcess([...args, "--dry-run"], preview.io), preview.stderr()).toBe(1)
    const report = JSON.parse(preview.stdout()) as {
      apply: boolean
      eligible: { branch: string; reason: string }[]
      kept: { branch: string; reason: string }[]
      failed: { branch: string; reason: string; detail: string }[]
      removed: { branch: string; archiveRef: string }[]
    }
    expect(report.apply).toBe(false)
    expect(report.eligible).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ branch: "task/29010-landed", reason: "landed" }),
        expect.objectContaining({ branch: "task/29010-archived", reason: "archived" }),
      ]),
    )
    expect(report.eligible).toHaveLength(2)
    expect(report.kept).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ branch: "task/29010-active", reason: "active" }),
        expect.objectContaining({ branch: "task/29010-held", reason: "held" }),
        expect.objectContaining({ branch: "task/29010-wrong-branch", reason: "unreached" }),
        expect.objectContaining({ branch: "task/29010-wrong-tip", reason: "unreached" }),
      ]),
    )
    expect(report.failed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          branch: "task/29010-unreadable",
          reason: "unreadable",
          detail: expect.stringContaining("not-a-yrd-event"),
        }),
        expect.objectContaining({ branch: "task/29010-invalid", reason: "unreadable" }),
      ]),
    )
    expect(report.failed).toHaveLength(2)
    expect((await git(["for-each-ref", "--format=%(refname)", "refs/archive/"])).trim()).toBe("")
    for (const [branch, tip] of tips) expect((await git(["rev-parse", `refs/heads/${branch}`])).trim()).toBe(tip)
    const apply = capture(repo)
    apply.io.branchIssue = preview.io.branchIssue
    apply.io.localBranchProtections = preview.io.localBranchProtections
    expect(await runYrdProcess(args, apply.io), apply.stderr()).toBe(1)
    const applied = JSON.parse(apply.stdout()) as typeof report
    expect(applied.removed.map((row: { branch: string }) => row.branch).sort()).toEqual([
      "task/29010-archived",
      "task/29010-landed",
    ])
    for (const row of applied.removed) {
      expect((await git(["rev-parse", row.archiveRef])).trim()).toBe(tips.get(row.branch))
      expect((await git(["for-each-ref", "--format=%(refname)", `refs/heads/${row.branch}`])).trim()).toBe("")
    }
    // Provider display never participates in retirement.
    expect(existsSync(join(repo, "resolver-ran"))).toBe(false)
    expect(applied).not.toHaveProperty("unclassified")
  })

  /** @failure Migrated merged history loses its root-tip custody during cleanup.
   * @level l3 @consumer Cleanup of a branch whose old ending was adopted into the event chain
   */
  it("drop by issue accepts validated adopted root landing history", async () => {
    const repo = await world('issuesProvider: {read: ["false"]}\n')
    const git = gitIn(repo)
    const base = (await git(["rev-parse", "HEAD"])).trim()
    const queueTip = await createQueue(repo, "main", base, new Date())
    const branch = "custom/adopted"
    await git(["checkout", "--quiet", "-b", branch])
    await git(["commit", "--quiet", "--allow-empty", "-m", "old work"])
    const tip = (await git(["rev-parse", "HEAD"])).trim()
    await git(["checkout", "--quiet", "main"])
    const chain = await openEvents({
      ...createEventStore(repo, "origin", git.selection),
      ref: changesRef("main", branch),
      writer: "yrd",
    })
    await chain.append(
      [
        changeInput("opened", {
          queueTip,
          at: new Date(),
          commit: tip,
          by: "fixture",
          issue: "@example/29010-custody",
        }),
        changeInput("cancelled", { queueTip, at: new Date(), reason: "withdrawn" }),
        {
          type: "adopted",
          props: [
            ["Queue", queueTip],
            ["Time", new Date().toISOString()],
            ["By", "yrd-adopter"],
            ["Adopted-Opened", "2026-10-01T12:00:00.000Z"],
            ["Adopted-Head", tip],
            ["Adopted-Status", "merged"],
            ["Adopted-Ended", "2026-10-01T12:30:00.000Z"],
            ["Adopted-Submitter", "fixture"],
            ["Adopted-Merge", base],
            ["Migrated-From", `refs/yrd/main/${branch}@${tip}@${base}`],
          ],
          keeps: [tip, base, queueTip],
        },
      ],
      { expect: null },
    )
    const output = capture(repo)
    expect(
      await runYrdProcess(
        ["bun", "yrd", "drop", "--issue", "@example/29010-custody", "--apply", "--submitter", "fixture", "--json"],
        output.io,
      ),
      output.stderr(),
    ).toBe(0)
    expect(JSON.parse(output.stdout()), output.stdout()).toMatchObject({
      removed: [{ branch, head: tip, reason: "landed" }],
    })
  })

  /** @failure A host's pure branch mapping is ignored or recorded issue identity requires a lookup.
   * @level l3 @consumer Standalone repositories using nonconventional branch names
   */
  it("drop by issue uses the host's pure mapping for root and expanded cleanup", async () => {
    const repo = await world('issuesProvider: {read: ["false"]}\n')
    const git = gitIn(repo)
    const tip = (await git(["rev-parse", "HEAD"])).trim()
    await createQueue(repo, "main", tip, new Date())
    await git(["branch", "custom/work", tip])
    await git(["push", "--quiet", "origin", `${tip}:refs/archive/2026-10-12/fixture/custom/work`])
    for (const expanded of [false, true]) {
      const preview = capture(repo)
      preview.io.branchIssue = ({ branch }) => (branch === "custom/work" ? "@example/29010-custody" : undefined)
      const args = [
        "bun",
        "yrd",
        "drop",
        "--issue",
        "@example/29010-custody",
        "--submitter",
        "fixture",
        "--json",
        "--dry-run",
        ...(expanded ? ["--submodules"] : []),
      ]
      expect(await runYrdProcess(args, preview.io), preview.stderr()).toBe(0)
      expect(JSON.parse(preview.stdout())).toMatchObject({ eligible: [{ branch: "custom/work" }] })
    }
  })

  /** @failure Retirement runs before bay cleanup, leaving the merged author ref forever.
   * @level l3 @consumer queue run's author cleanup and retained change history
   * Existing core fixtures have no checked-out author worktree.
   */
  it.each(["bay", "pool"])("retires after merged %s cleanup in the same native CLI round", async (kind) => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    await git(["config", "yrd.workdir", join(dirname(repo), "retirement-state")])
    await createQueue(repo, "main", (await git(["rev-parse", "HEAD"])).trim(), new Date())
    const branch = "task/merge-retirement"
    let author: string
    if (kind === "bay") {
      const opened = capture(repo)
      expect(
        await runYrdProcess(["bun", "yrd", "env", "open", "--bay", "merge-retirement", "--json"], opened.io),
        opened.stderr(),
      ).toBe(0)
      author = (JSON.parse(opened.stdout()) as { path: string }).path
      const gitDir = (await gitIn(author)(["rev-parse", "--absolute-git-dir"])).trim()
      const opening = join(gitDir, "yrd-open.json")
      const recorded = readEnvOpenRecord(gitDir)
      if (recorded.status !== "recorded") throw new Error("fixture bay omitted its opening record")
      writeFileSync(opening, JSON.stringify({ ...recorded.record, at: "2026-01-01T00:00:00.000Z" }))
    } else {
      author = join(dirname(repo), "pool-slot")
      await git(["worktree", "add", "--quiet", "-b", branch, author, "main"])
    }
    const authorGit = gitIn(author)
    writeFileSync(join(author, "work.txt"), kind)
    await authorGit(["add", "work.txt"])
    await authorGit(["commit", "--quiet", "-m", "work\n\nRefs: @example/28791-merge"])
    const head = (await authorGit(["rev-parse", "HEAD"])).trim()
    const submitted = capture(author)
    expect(await runYrdProcess(["bun", "yrd", "submit", "--json"], submitted.io), submitted.stderr()).toBe(0)
    using census = vi
      .spyOn(removely, "inspectProcessCwds")
      .mockResolvedValue({ complete: true, unreadable: [], mechanism: "proc", rows: [] })
    const run = capture(repo)
    expect(await runYrdProcess(["bun", "yrd", "queue", "run", "--queue", "main", "--json"], run.io), run.stderr()).toBe(
      0,
    )
    const outcome = JSON.parse(run.stdout()) as { log: string; run: string; merged: string[] }
    expect(outcome.merged).toEqual([branch])
    expect(existsSync(author), run.stderr()).toBe(kind === "pool")
    expect((await git(["for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`])).trim()).toBe(
      kind === "pool" ? head : "",
    )
    const cleanupLogs = join(dirname(outcome.log), "post-merge")
    const records = readdirSync(cleanupLogs)
      .filter((name) => name.endsWith(".jsonl"))
      .flatMap((name) => {
        const rows = readRunLog(cleanupLogs, name.slice(0, -".jsonl".length))
        return rows.some((row) => row.kind === "run" && row.queueRun === outcome.run) ? rows : []
      })
    const retirement = records.find((row) => row.kind === "local-branch-retirement" && row.branch === branch)
    if (kind === "bay") {
      const archive = retirement?.archive
      if (typeof archive !== "string") throw new Error("retirement journal omitted its archive ref")
      expect((await git(["rev-parse", archive])).trim()).toBe(head)
    }
    const releaseRows = readdirSync(dirname(outcome.log))
      .filter((name) => name.endsWith(".jsonl") && name !== `${outcome.run}.jsonl`)
      .flatMap((name) => readRunLog(dirname(outcome.log), name.slice(0, -6)))
    expect(
      retirement,
      JSON.stringify({
        release: releaseRows.filter((row) => row.kind === "local-branch-retirement" && row.branch === branch),
        queue: records.filter((row) => row.kind === "local-branch-retirement" && row.branch === branch),
      }),
    ).toMatchObject({ outcome: kind === "pool" ? "kept" : "removed", branch, head })
    if (kind === "bay") {
      const archive = retirement!.archive
      if (typeof archive !== "string") throw new Error("retirement journal omitted its archive ref")
      expect((await git(["rev-parse", archive])).trim()).toBe(head)
      const closed = records.findIndex(
        (row) => row.scope === "environment-cleanup" && row.path === author && row.result === "closed",
      )
      expect(closed).toBeGreaterThanOrEqual(0)
      expect(records.indexOf(retirement!)).toBeGreaterThan(closed)
    } else expect(retirement!.reason).toContain("checked out")
    expect(await readStatus(createEventStore(repo, "origin", git.selection), "main", branch)).toMatchObject({
      status: "merged",
      commit: head,
      issue: "@example/28791-merge",
    })
  })

  /** @failure A publication failure is labelled kept or exits successfully, hiding the need to retry.
   * @level l3 @consumer issue closer and the persisted cleanup journal
   */
  it("reports failed origin custody with exit 1 and succeeds when retried", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const issue = "@example/28791-retry"
    await createQueue(repo, "main", (await git(["rev-parse", "HEAD"])).trim(), new Date())
    await git(["checkout", "--quiet", "-b", "task/retry"])
    await git(["commit", "--quiet", "--allow-empty", "-m", `work\n\nRefs: ${issue}`])
    const head = (await git(["rev-parse", "HEAD"])).trim()
    await git(["checkout", "--quiet", "main"])
    const hook = join(dirname(repo), "remote.git", "hooks", "pre-receive")
    writeFileSync(hook, "#!/bin/sh\necho fixture-origin-refusal >&2\nexit 1\n")
    chmodSync(hook, 0o755)
    const args = [
      "bun",
      "yrd",
      "drop",
      "task/retry",
      "--local",
      "--tip",
      head,
      "--issue",
      issue,
      "--submitter",
      "fixture",
      "--json",
    ]
    const failed = capture(repo)
    expect(await runYrdProcess(args, failed.io), failed.stderr()).toBe(1)
    expect(JSON.parse(failed.stdout())).toMatchObject({
      removed: [],
      kept: [],
      failed: [
        { branch: "task/retry", head, reason: "failed", detail: expect.stringContaining("fixture-origin-refusal") },
      ],
    })
    expect((await git(["rev-parse", "refs/heads/task/retry"])).trim()).toBe(head)
    const logs = join(await workdirOf(git, { cwd: repo }), "logs")
    const records = readdirSync(logs)
      .filter((name) => name.endsWith(".jsonl"))
      .flatMap((name) => readRunLog(logs, name.slice(0, -6)))
    expect(records).toContainEqual(
      expect.objectContaining({ kind: "local-branch-retirement", branch: "task/retry", outcome: "failed" }),
    )
    unlinkSync(hook)
    const retry = capture(repo)
    expect(await runYrdProcess(args, retry.io), retry.stderr()).toBe(0)
    expect(JSON.parse(retry.stdout())).toMatchObject({
      removed: [{ branch: "task/retry", head }],
      kept: [],
      failed: [],
    })
  })

  it("submits an unpublished branch, then drops its open change and branch atomically", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const store = createEventStore(repo, "origin", gitIn(repo).selection)
    const created = await createQueue(
      repo,
      "main",
      (await git(["rev-parse", "HEAD"])).trim(),
      new Date("2026-09-22T14:00:00.000Z"),
    )
    await git(["checkout", "--quiet", "-b", "task/event-submit"])
    writeFileSync(join(repo, "work.txt"), "event submit\n")
    await git(["add", "work.txt"])
    await git(["commit", "--quiet", "-m", "event submit"])
    const head = (await git(["rev-parse", "HEAD"])).trim()
    const submitted = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "submit", "--queue", "main", "--json"], submitted.io),
      submitted.stderr(),
    ).toBe(0)
    expect(JSON.parse(submitted.stdout())).toMatchObject({ branch: "task/event-submit", head })
    expect((await readEventQueue(store, "main")).tip).toBe(created)
    expect((await listChanges(store, "main")).get("task/event-submit")).toMatchObject({
      status: "queued",
      commit: head,
    })
    expect(
      (await (await openEvents({ ...store, ref: changesRef("main", "task/event-submit") })).events())[0]?.links,
    ).toContain(head)
    const beforeRetry = await (await openEvents({ ...store, ref: changesRef("main", "task/event-submit") })).events()
    const beforeState = (await listChanges(store, "main")).get("task/event-submit")
    const beforePosition = eventRows(await listChanges(store, "main")).find(
      (row) => row.branch === "task/event-submit",
    )?.position
    expect((await git(["ls-remote", "--refs", "origin", "refs/heads/task/event-submit"])).split("\t")[0]).toBe(head)
    expect(await git(["ls-remote", "--refs", "origin", "refs/yrd/main/task/event-submit@*"])).toBe("")
    const retried = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "submit", "--queue", "main", "--json"], retried.io),
      retried.stderr(),
    ).toBe(0)
    expect(JSON.parse(retried.stdout())).toMatchObject({
      branch: "task/event-submit",
      head,
      retry: true,
      opened: beforeRetry[0]?.id,
    })
    const afterRetry = await (await openEvents({ ...store, ref: changesRef("main", "task/event-submit") })).events()
    expect(afterRetry).toEqual(beforeRetry)
    expect((await listChanges(store, "main")).get("task/event-submit")).toEqual(beforeState)
    expect(
      eventRows(await listChanges(store, "main")).find((row) => row.branch === "task/event-submit")?.position,
    ).toBe(beforePosition)
    const dropped = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "drop", "task/event-submit", "--queue", "main", "--json"], dropped.io),
      dropped.stderr(),
    ).toBe(0)
    expect(JSON.parse(dropped.stdout())).toMatchObject({ branch: "task/event-submit", head })
    expect((await listChanges(store, "main")).get("task/event-submit")).toMatchObject({
      status: "cancelled",
      reason: "dropped",
    })
    expect(await git(["ls-remote", "--refs", "origin", "refs/heads/task/event-submit"])).toBe("")
    expect(
      (await (await openEvents({ ...store, ref: changesRef("main", "task/event-submit") })).events()).at(-1)?.links,
    ).toContain(head)
    const repeated = capture(repo)
    expect(await runYrdProcess(["bun", "yrd", "drop", "task/event-submit", "--queue", "main"], repeated.io)).toBe(0)
    expect(repeated.stdout()).toContain(head.slice(0, 12))
  })

  it("prints the policy cure and submits through the event queue on admission exit 3", async () => {
    const repo = await world('admission:\n  run: "sh tools/policy.sh"\n  timeoutMs: 5000\n')
    const git = gitIn(repo)
    mkdirSync(join(repo, "tools"))
    writeFileSync(
      join(repo, "tools", "policy.sh"),
      "#!/bin/sh\necho 'Start 3 is not ticked; complete and tick it'\nexit 3\n",
    )
    await git(["add", "tools/policy.sh"])
    await git(["commit", "--quiet", "-m", "policy"])
    await git(["push", "--quiet", "origin", "main"])
    await createQueue(repo, "main", (await git(["rev-parse", "HEAD"])).trim(), new Date())
    await git(["checkout", "--quiet", "-b", "task/warn-only"])
    writeFileSync(join(repo, "work.txt"), "warning submit\n")
    await git(["add", "work.txt"])
    await git(["commit", "--quiet", "-m", "warning submit"])
    const submitted = capture(repo)
    expect(await runYrdProcess(["bun", "yrd", "submit", "--queue", "main", "--json"], submitted.io)).toBe(0)
    expect(submitted.stderr()).toContain("POLICY WARNING")
    expect(submitted.stderr()).toContain("Start 3 is not ticked; complete and tick it")
    const receipt = JSON.parse(submitted.stdout()) as { admission: { kind: string } }
    expect(receipt.admission.kind).toBe("warn")
    const store = createEventStore(repo, "origin", git.selection)
    const change = (await listChanges(store, "main")).get("task/warn-only")
    expect(change).toMatchObject({ status: "queued", diagnostic: expect.stringContaining("policy warning") })
  })

  /** @failure 25708: a same-head submit reopened a merged chain while the service published against its old tip. */
  it.each(["merging", "merged"] as const)("refuses a same-head submit when its change is %s", async (status) => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const store = createEventStore(repo, "origin", git.selection)
    const queueTip = await createQueue(
      repo,
      "main",
      (await git(["rev-parse", "HEAD"])).trim(),
      new Date("2026-09-24T23:00:00.000Z"),
    )
    const branch = `task/event-${status}`
    await git(["checkout", "--quiet", "-b", branch])
    writeFileSync(join(repo, "work.txt"), `${status}\n`)
    await git(["add", "work.txt"])
    await git(["commit", "--quiet", "-m", status])
    const head = (await git(["rev-parse", "HEAD"])).trim()
    const first = capture(repo)
    expect(await runYrdProcess(["bun", "yrd", "submit", "--queue", "main", "--json"], first.io)).toBe(0)
    const chain = await openEvents({ ...store, ref: changesRef("main", branch), writer: "yrd" })
    const at = new Date("2026-09-24T23:01:00.000Z")
    const inputs =
      status === "merging"
        ? [
            changeInput("verifying", { queueTip, at, commit: head }),
            changeInput("checking", { queueTip, at }),
            changeInput("merging", { queueTip, at, commit: head }),
          ]
        : [changeInput("merged", { queueTip, at, commit: head, reason: `observed on target at ${head}` })]
    await chain.append(inputs, { expect: await chain.head() })
    const before = await chain.events()
    const refused = capture(repo)
    expect(await runYrdProcess(["bun", "yrd", "submit", "--queue", "main", "--json"], refused.io)).toBe(2)
    expect(refused.stderr()).toContain(branch)
    expect(refused.stderr()).toContain(status === "merging" ? "retry after the merge" : "push a new head or nothing")
    expect(await chain.events()).toEqual(before)
    expect((await git(["ls-remote", "--refs", "origin", `refs/heads/${branch}`])).split("\t")[0]).toBe(head)
  })

  it("names the retained merge when the target already contains the submitted head", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const store = createEventStore(repo, "origin", git.selection)
    const base = (await git(["rev-parse", "HEAD"])).trim()
    const queueTip = await createQueue(repo, "main", base, new Date("2026-09-24T23:00:00.000Z"))
    const branch = "task/landed-head"
    await git(["checkout", "--quiet", "-b", branch])
    writeFileSync(join(repo, "landed.txt"), "landed\n")
    await git(["add", "landed.txt"])
    await git(["commit", "--quiet", "-m", "landed"])
    const head = (await git(["rev-parse", "HEAD"])).trim()
    const first = capture(repo)
    expect(await runYrdProcess(["bun", "yrd", "submit", "--queue", "main", "--json"], first.io)).toBe(0)
    await git(["checkout", "--quiet", "main"])
    await git(["merge", "--quiet", "--no-ff", "-m", "land change", branch])
    const landing = (await git(["rev-parse", "HEAD"])).trim()
    await git(["push", "--quiet", "origin", "main"])
    const chain = await openEvents({ ...store, ref: changesRef("main", branch), writer: "yrd" })
    await chain.append(
      [
        changeInput("merged", {
          queueTip,
          at: new Date(),
          commit: landing,
          reason: `observed on target at ${landing}`,
        }),
      ],
      { expect: await chain.head() },
    )
    const before = await chain.events()
    await git(["checkout", "--quiet", branch])
    const refused = capture(repo)
    expect(await runYrdProcess(["bun", "yrd", "submit", "--queue", "main", "--json"], refused.io)).toBe(2)
    expect(refused.stderr()).toContain(`already merged at ${landing}`)
    expect(refused.stderr()).toContain("push a new head or nothing")
    expect(await chain.events()).toEqual(before)
    expect(head).not.toBe(landing)
  })

  it("hides only matching draft heads in an event listing", async () => {
    const repo = await world("ignore: [task/hidden*, 'scratch/**']\n")
    const git = gitIn(repo)
    const commit = (await git(["rev-parse", "HEAD"])).trim()
    const store = { repo, remote: "origin" }
    const queueTip = await createQueue(repo, "main", commit, new Date("2026-09-22T14:00:00.000Z"))
    for (const branch of ["task/hidden", "scratch/nested", "task/kept", "other/task/hidden"]) {
      await git(["checkout", "--quiet", "-b", branch, "main"])
      writeFileSync(join(repo, `${branch.replaceAll("/", "-")}.txt`), `${branch}\n`)
      await git(["add", "."])
      await git(["commit", "--quiet", "-m", branch])
      await git(["push", "--quiet", "origin", branch])
    }
    await git(["checkout", "--quiet", "main"])
    await (
      await openEvents({ ...store, ref: changesRef("main", "task/hidden-submitted"), writer: "yrd" })
    ).append([changeInput("opened", { queueTip, at: new Date(), commit, by: "@dev/2" })], { expect: null })
    const run = capture(repo)
    expect(
      await coreQueueCommand(repo, run.io, { command: "list", drafts: true }, { json: true, queue: "main" }),
      run.stderr(),
    ).toBe(0)
    const shown = (JSON.parse(run.stdout()) as { changes: readonly { branch: string }[] }).changes.map(
      (row) => row.branch,
    )
    expect(shown).toContain("task/kept")
    expect(shown).toContain("other/task/hidden")
    expect((JSON.parse(run.stdout()) as { scope: string }).scope).toContain("task/hidden*")
    expect(shown).not.toContain("task/hidden")
    expect(shown).not.toContain("scratch/nested")
    expect(shown).toContain("task/hidden-submitted")
  }, 30_000)

  it("requires reason and actor for ignore, then returns byte-clean JSON for both verbs", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const commit = (await git(["rev-parse", "HEAD"])).trim()
    const queueTip = await createQueue(repo, "main", commit, new Date("2026-09-22T14:00:00.000Z"))
    await (
      await openEvents({ repo, remote: "origin", ref: changesRef("main", "task/one"), writer: "yrd" })
    ).append([changeInput("opened", { queueTip, at: new Date(), commit, by: "@dev/2" })], { expect: null })
    const missing = capture(repo)
    expect(await runYrdProcess(["bun", "yrd", "ignore", "task/one", "--json"], missing.io)).toBe(2)
    expect(missing.stderr()).toContain("yrd-ignore-reason-required")
    expect(missing.stdout()).toBe("")
    const conflict = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "unignore", "task/one", "--reason", "wrong", "--json"], conflict.io),
    ).toBe(2)
    expect(conflict.stderr()).toContain("yrd-ignore-reason-conflict")
    expect(conflict.stdout()).toBe("")
    const ignored = capture(repo)
    expect(
      await runYrdProcess(
        ["bun", "yrd", "ignore", "task/one", "--reason", "waiting", "--notify", "@dev/2", "--json"],
        ignored.io,
      ),
      ignored.stderr(),
    ).toBe(0)
    expect(ignored.stderr()).toBe("")
    expect(JSON.parse(ignored.stdout())).toEqual({ branch: "task/one", ignored: { reason: "waiting", by: "@dev/2" } })
    const cleared = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "unignore", "task/one", "--notify", "@dev/3", "--json"], cleared.io),
      cleared.stderr(),
    ).toBe(0)
    expect(cleared.stderr()).toBe("")
    expect(JSON.parse(cleared.stdout())).toEqual({ branch: "task/one", ignored: null })
    const human = capture(repo)
    expect(
      await runYrdProcess(
        ["bun", "yrd", "ignore", "task/one", "--reason", "second hold", "--notify", "@dev/4"],
        human.io,
      ),
      human.stderr(),
    ).toBe(0)
    expect(human.stdout()).toContain("ignored task/one by @dev/4: second hold")
  }, 30_000)

  it("drops a draft pushed by another clone after fetching its kept head", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const remote = join(dirname(repo), "remote.git")
    const target = (await git(["rev-parse", "HEAD"])).trim()
    await createQueue(repo, "main", target, new Date("2026-09-22T14:00:00.000Z"))

    const author = join(dirname(repo), "author")
    await gitIn(dirname(repo))(["clone", "--quiet", remote, author])
    const authorGit = gitIn(author)
    await authorGit(["config", "user.name", "yrd author"])
    await authorGit(["config", "user.email", "author@yrd.invalid"])
    await authorGit(["checkout", "--quiet", "-b", "task/remote-draft"])
    writeFileSync(join(author, "remote-draft.txt"), "remote draft\n")
    await authorGit(["add", "remote-draft.txt"])
    await authorGit(["commit", "--quiet", "-m", "remote draft"])
    const head = (await authorGit(["rev-parse", "HEAD"])).trim()
    await authorGit(["push", "--quiet", "origin", "task/remote-draft"])
    await expect(git(["cat-file", "-e", `${head}^{commit}`])).rejects.toThrow()

    const store = createEventStore(repo, "origin", gitIn(repo).selection)
    const dropped = await drop(store, { queue: "main", branch: "task/remote-draft", by: "@dev/2" })
    expect(dropped).toMatchObject({ branch: "task/remote-draft", head })
    expect(
      (await listChanges(createEventStore(repo, "origin", gitIn(repo).selection), "main")).get("task/remote-draft"),
    ).toMatchObject({
      status: "cancelled",
      commit: head,
      reason: "dropped",
    })
    expect(await git(["ls-remote", "--heads", "origin", "task/remote-draft"])).toBe("")
    const events = await (
      await openEvents({ repo, remote: "origin", ref: changesRef("main", "task/remote-draft") })
    ).events()
    expect(events).toHaveLength(2)
    expect(events.map((event) => event.type)).toEqual(["opened", "cancelled"])
    expect(events[1]).toMatchObject({ type: "cancelled", links: [head] })

    expect(await drop(store, { queue: "main", branch: "task/remote-draft", by: "@dev/2" })).toEqual(dropped)
  }, 15_000)

  it("accepts a change to an event queue whose declaration configures notify (25065)", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const target = (await git(["rev-parse", "HEAD"])).trim()
    await createQueue(repo, "main", target, new Date("2026-09-22T14:00:00.000Z"))
    writeFileSync(join(repo, ".yrd.yml"), 'notify:\n  - recorder: {on: [merged], run: "true"}\n')
    await git(["add", ".yrd.yml"])
    await git(["commit", "--quiet", "-m", "configure event notification"])
    await git(["push", "--quiet", "origin", "main"])
    await git(["checkout", "--quiet", "-b", "task/event-notify"])
    writeFileSync(join(repo, "work.txt"), "event notify\n")
    await git(["add", "work.txt"])
    await git(["commit", "--quiet", "-m", "event notify"])

    const submitted = capture(repo)
    expect(await runYrdProcess(["bun", "yrd", "submit", "--queue", "main"], submitted.io), submitted.stderr()).toBe(0)
  })

  it("refuses drop on a queue without an event declaration", async () => {
    const repo = await world("{}\n")
    const refused = capture(repo)
    const exit = await runYrdProcess(["bun", "yrd", "drop", "task/example", "--queue", "main"], refused.io)
    expect(refused.stderr()).toContain("expected refs/yrd/main/queue")
    expect(exit).toBe(2)
  })

  /** @failure The operator cannot set the intake fence or dry-run claims a fenced submit would open.
   * @level l2 @consumer yrd queue pause --maintenance and yrd submit --dry-run
   */
  it("sets a maintenance intake stop with one reason and refuses dry-run submit", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    await createQueue(repo, "main", (await git(["rev-parse", "HEAD"])).trim(), new Date())
    await git(["checkout", "--quiet", "-b", "task/fenced"])
    writeFileSync(join(repo, "fenced.txt"), "change\n")
    await git(["add", "fenced.txt"])
    await git(["commit", "--quiet", "-m", "fenced change"])
    const paused = capture(repo)
    expect(
      await runYrdProcess(
        [
          "bun",
          "yrd",
          "queue",
          "pause",
          "--queue",
          "main",
          "--maintenance",
          "25041 lab",
          "--notify",
          "@chief",
          "--json",
        ],
        paused.io,
      ),
      paused.stderr(),
    ).toBe(0)
    expect(JSON.parse(paused.stdout())).toMatchObject({ cause: "maintenance", by: "@chief", reason: "25041 lab" })
    const before = await git(["ls-remote", "--refs", "origin"])
    const attempted = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "submit", "--queue", "main", "--dry-run", "--json"], attempted.io),
      attempted.stderr(),
    ).toBe(2)
    expect(attempted.stderr()).toContain("25041 lab")
    expect(attempted.stderr()).toContain("@chief")
    expect(attempted.stderr()).toContain("submit after resume")
    expect(await git(["ls-remote", "--refs", "origin"])).toBe(before)
  })

  it("reports a healthy service after resume without suggesting a restart", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const head = (await git(["rev-parse", "HEAD"])).trim()
    await createQueue(repo, "main", head, new Date("2026-09-22T14:00:00.000Z"))
    const { workdir } = await resolveQueueLocation(repo, "main", process.env)
    mkdirSync(workdir, { recursive: true })
    writeFileSync(
      join(workdir, QUEUE_HEALTH_DOCUMENT),
      JSON.stringify({ schema: QUEUE_HEALTH_SCHEMA, service: SERVICE, state: "healthy", verdict: { kind: "running" } }),
    )
    const paused = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "queue", "pause", "--queue", "main", "--reason", "repair"], paused.io),
      paused.stderr(),
    ).toBe(0)
    const resumed = capture(repo)
    expect(await runYrdProcess(["bun", "yrd", "queue", "resume", "--queue", "main", "--json"], resumed.io)).toBe(0)
    expect((JSON.parse(resumed.stdout()) as { service: unknown }).service).toEqual({ running: true, health: "healthy" })
    const pausedAgain = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "queue", "pause", "--queue", "main", "--reason", "repair"], pausedAgain.io),
    ).toBe(0)
    const line = capture(repo)
    expect(await runYrdProcess(["bun", "yrd", "queue", "resume", "--queue", "main"], line.io)).toBe(0)
    expect(line.stdout()).toContain("yrd service is running")
  })

  it("reports an unreadable service document as unknown after resume", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const head = (await git(["rev-parse", "HEAD"])).trim()
    await createQueue(repo, "main", head, new Date("2026-09-22T14:00:00.000Z"))
    const { workdir } = await resolveQueueLocation(repo, "main", process.env)
    mkdirSync(workdir, { recursive: true })
    writeFileSync(join(workdir, QUEUE_HEALTH_DOCUMENT), "not a health document\n")
    const paused = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "queue", "pause", "--queue", "main", "--reason", "repair"], paused.io),
      paused.stderr(),
    ).toBe(0)
    const resumed = capture(repo)
    expect(await runYrdProcess(["bun", "yrd", "queue", "resume", "--queue", "main", "--json"], resumed.io)).toBe(0)
    expect((JSON.parse(resumed.stdout()) as { service: unknown }).service).toEqual({
      running: null,
      health: "unknown",
      check: "hab ps yrd",
    })
    const pausedAgain = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "queue", "pause", "--queue", "main", "--reason", "repair"], pausedAgain.io),
    ).toBe(0)
    const line = capture(repo)
    expect(await runYrdProcess(["bun", "yrd", "queue", "resume", "--queue", "main"], line.io)).toBe(0)
    expect(line.stdout()).toContain("yrd service status is unknown (unreadable health document)")
    expect(line.stdout()).toContain("inspect with hab ps yrd")
  })

  /** @failure An overdue heartbeat or dead writer previously printed a running service after resume.
   * @level l2 @consumer queue operator (@i/10-yrd/25816)
   */
  it.each([
    {
      name: "overdue with live writer",
      pid: process.pid,
      overdue: true,
      running: null,
      check: "hab ps yrd",
      start: undefined,
    },
    {
      name: "overdue with dead writer",
      pid: 2_147_483_647,
      overdue: true,
      running: false,
      check: "hab ps yrd",
      start: "hab up yrd",
    },
    {
      name: "fresh unhealthy writer",
      pid: process.pid,
      overdue: false,
      running: true,
      check: undefined,
      start: undefined,
    },
  ])("reports $name from the one service reader after resume", async ({ pid, overdue, running, check, start }) => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const head = (await git(["rev-parse", "HEAD"])).trim()
    await createQueue(repo, "main", head, new Date("2026-09-22T14:00:00.000Z"))
    const { workdir } = await resolveQueueLocation(repo, "main", process.env)
    mkdirSync(workdir, { recursive: true })
    writeFileSync(
      join(workdir, QUEUE_HEALTH_DOCUMENT),
      JSON.stringify({
        schema: QUEUE_HEALTH_SCHEMA,
        service: SERVICE,
        state: overdue ? "healthy" : "unhealthy",
        verdict: { kind: "running" },
        facts: {
          writtenAt: new Date(Date.now() - 120_000).toISOString(),
          staleAfter: new Date(Date.now() + (overdue ? -60_000 : 60_000)).toISOString(),
          runner: { pid },
        },
      }),
    )
    const paused = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "queue", "pause", "--queue", "main", "--reason", "repair"], paused.io),
    ).toBe(0)
    const resumed = capture(repo)
    expect(await runYrdProcess(["bun", "yrd", "queue", "resume", "--queue", "main", "--json"], resumed.io)).toBe(0)
    expect((JSON.parse(resumed.stdout()) as { service: unknown }).service).toEqual({
      running,
      health: "unhealthy",
      ...(check === undefined ? {} : { check }),
      ...(start === undefined ? {} : { start }),
    })
    const pausedAgain = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "queue", "pause", "--queue", "main", "--reason", "repair"], pausedAgain.io),
    ).toBe(0)
    const line = capture(repo)
    expect(await runYrdProcess(["bun", "yrd", "queue", "resume", "--queue", "main"], line.io)).toBe(0)
    expect(line.stdout()).toContain(
      running === null ? "service status is unknown" : running === false ? "service is stopped" : "service is running",
    )
    if (overdue) expect(line.stdout()).toContain("hab ps yrd")
    if (running === null) expect(line.stdout()).toContain("if stopped run hab up yrd")
  })

  /** @failure A graceful stop document was reported as missing, hiding who stopped the service and why.
   * @level l2 @consumer queue operator (@i/10-yrd/25816)
   */
  it("reports the attributed graceful stop after resume", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const head = (await git(["rev-parse", "HEAD"])).trim()
    await createQueue(repo, "main", head, new Date("2026-09-22T14:00:00.000Z"))
    const { workdir } = await resolveQueueLocation(repo, "main", process.env)
    mkdirSync(workdir, { recursive: true })
    writeFileSync(
      join(workdir, QUEUE_HEALTH_DOCUMENT),
      JSON.stringify(
        gracefulStopHealthDocument(SERVICE, {
          by: "@chief",
          reason: "maintenance",
          since: new Date(Date.now() - 30_000).toISOString(),
        }),
      ),
    )
    const paused = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "queue", "pause", "--queue", "main", "--reason", "repair"], paused.io),
    ).toBe(0)
    const resumed = capture(repo)
    expect(await runYrdProcess(["bun", "yrd", "queue", "resume", "--queue", "main", "--json"], resumed.io)).toBe(0)
    expect((JSON.parse(resumed.stdout()) as { service: unknown }).service).toEqual({
      running: false,
      health: "absent",
      start: "hab up yrd",
    })
    const pausedAgain = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "queue", "pause", "--queue", "main", "--reason", "repair"], pausedAgain.io),
    ).toBe(0)
    const line = capture(repo)
    expect(await runYrdProcess(["bun", "yrd", "queue", "resume", "--queue", "main"], line.io)).toBe(0)
    expect(line.stdout()).toContain("stopped by @chief")
    expect(line.stdout()).toContain("maintenance")
    expect(line.stdout()).toContain("run hab up yrd")
  })

  it("routes pause and override commands to queue events without moving legacy refs", async () => {
    const repo = await world('checks:\n  - verify: {run: "true", on: [merge]}\n')
    const git = gitIn(repo)
    const head = (await git(["rev-parse", "HEAD"])).trim()
    const store = createEventStore(repo, "origin", git.selection)
    await createQueue(repo, "main", head, new Date("2026-09-22T14:00:00.000Z"))
    const legacyRefs = async () =>
      (await git(["ls-remote", "--refs", "origin", "refs/yrd/main/pause", "refs/yrd/main/override"])).trim()
    const legacyBefore = await legacyRefs()
    const paused = capture(repo)
    expect(
      await runYrdProcess(
        ["bun", "yrd", "queue", "pause", "--queue", "main", "--reason", "repair", "--json"],
        paused.io,
      ),
      paused.stderr(),
    ).toBe(0)
    expect(JSON.parse(paused.stdout())).toMatchObject({ kind: "paused", reason: "repair" })
    const until = new Date(Date.now() + 3_600_000).toISOString()
    const set = capture(repo)
    expect(
      await runYrdProcess(
        [
          "bun",
          "yrd",
          "queue",
          "override",
          "--queue",
          "main",
          "--check",
          "verify",
          "--off",
          "--until",
          until,
          "--reason",
          "flaky gate",
          "--json",
        ],
        set.io,
      ),
      set.stderr(),
    ).toBe(0)
    expect(JSON.parse(set.stdout())).toMatchObject({ kind: "set", overrides: [{ check: "verify", state: "active" }] })
    const listed = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "queue", "override", "--queue", "main", "--list", "--json"], listed.io),
      listed.stderr(),
    ).toBe(0)
    expect(JSON.parse(listed.stdout())).toMatchObject({ overrides: [{ check: "verify", state: "active" }] })
    expect((await readEventQueue(store, "main")).ops?.pause?.reason).toBe("repair")
    expect(await legacyRefs()).toBe(legacyBefore)
    const resumed = capture(repo)
    expect(await runYrdProcess(["bun", "yrd", "queue", "resume", "--queue", "main"], resumed.io)).toBe(0)
    expect(resumed.stdout()).toContain("yrd service is stopped (no health document); run hab up yrd")
    expect((await readEventQueue(store, "main")).ops?.pause).toBeUndefined()
    expect(await legacyRefs()).toBe(legacyBefore)
  })

  /** @failure Event-format intake ignores an ops maintenance pause.
   * @level l2 @consumer addressed submit and its dry run
   */
  it("refuses event-format submit under maintenance without opening a change", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const target = (await git(["rev-parse", "HEAD"])).trim()
    const store = createEventStore(repo, "origin", git.selection)
    await createQueue(repo, "main", target, new Date("2026-09-22T14:00:00.000Z"))
    await git(["checkout", "--quiet", "-b", "task/event-fenced"])
    writeFileSync(join(repo, "event-fenced.txt"), "change\n")
    await git(["add", "event-fenced.txt"])
    await git(["commit", "--quiet", "-m", "event fenced change"])
    const paused = capture(repo)
    expect(
      await runYrdProcess(
        ["bun", "yrd", "queue", "pause", "--queue", "main", "--maintenance", "25041 ops cutover", "--notify", "@chief"],
        paused.io,
      ),
      paused.stderr(),
    ).toBe(0)
    const before = await git(["ls-remote", "--refs", "origin"])
    for (const args of [["--dry-run"], []]) {
      const attempted = capture(repo)
      expect(
        await runYrdProcess(["bun", "yrd", "submit", "--queue", "main", ...args], attempted.io),
        attempted.stderr(),
      ).toBe(2)
      expect(attempted.stderr()).toContain("25041 ops cutover")
      expect(attempted.stderr()).toContain("@chief")
      expect(attempted.stderr()).toContain("submit after resume")
    }
    expect(await git(["ls-remote", "--refs", "origin"])).toBe(before)
    const resumed = capture(repo)
    expect(
      await runYrdProcess(
        ["bun", "yrd", "queue", "resume", "--queue", "main", "--reason", "lab proved", "--notify", "@chief"],
        resumed.io,
      ),
      resumed.stderr(),
    ).toBe(0)
    const operator = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "queue", "pause", "--queue", "main", "--reason", "inspect"], operator.io),
      operator.stderr(),
    ).toBe(0)
    const accepted = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "submit", "--queue", "main", "--json"], accepted.io),
      accepted.stderr(),
    ).toBe(0)
    expect(JSON.parse(accepted.stdout())).toMatchObject({ stopped: { cause: "operator" } })
  })

  it.each(["open", "close"])("refuses the retired garage %s command without changing local refs", async (verb) => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    if (verb === "close") {
      const tree = (await git(["mktree"], "")).trim()
      const commit = (
        await git(["commit-tree", tree, "-m", "garage: historical declaration\n\nOpened-By: @chief\n"])
      ).trim()
      await git(["update-ref", "refs/yrd/garage", commit])
    }
    const before = await git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/yrd/"])
    const run = capture(repo)
    expect(
      await runYrdProcess(
        ["bun", "yrd", "queue", "garage", verb, ...(verb === "open" ? ["--reason", "repair"] : [])],
        run.io,
      ),
    ).toBe(2)
    expect(await git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/yrd/"])).toBe(before)
  })

  it.each(["default", "bare"])("pause/resume select the %s queue without treating it as a reason", async (mode) => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const remote = gitIn(join(dirname(repo), "remote.git"))
    await git(["branch", "release/1.x"])
    await git(["push", "--quiet", "origin", "release/1.x"])
    await remote(["symbolic-ref", "HEAD", "refs/heads/release/1.x"])
    // Administration captures the selected target object without borrowing a
    // queue read: even an unreadable change must not prevent the operator from
    // pausing it, and the capture must not rewrite this clone's refs/FETCH_HEAD.
    const release = (await git(["rev-parse", "release/1.x"])).trim()
    const queueTip = await createQueue(repo, "release/1.x", release, new Date())
    const tree = (await git(["rev-parse", `${release}^{tree}`])).trim()
    const advanced = (await git(["commit-tree", tree, "-p", release, "-m", "advance the queue target"])).trim()
    await remote(["fetch", "--quiet", "--no-tags", repo, advanced])
    await remote(["update-ref", "refs/heads/release/1.x", advanced])
    const malformedRef = changesRef("release/1.x", "task/unreadable")
    await (
      await openEvents({ ...createEventStore(repo, "origin", git.selection), ref: malformedRef, writer: "yrd" })
    ).append([changeInput("verifying", { queueTip, at: new Date(), commit: advanced })], { expect: null })
    const refs = ["for-each-ref", "--format=%(refname) %(objectname)"]
    const yrdRefs = async (): Promise<readonly string[]> =>
      (await remote(["for-each-ref", "--format=%(refname)", "refs/yrd/"])).trim().split("\n").sort()
    const expectedYrdRefs = [queueRef("release/1.x"), runIndexRef("release/1.x"), malformedRef].sort()
    const before = await git(refs)
    const fetchHead = (await git(["rev-parse", "--path-format=absolute", "--git-path", "FETCH_HEAD"])).trim()
    writeFileSync(fetchHead, "another command's fetch result\n")
    const operand = mode === "default" ? [] : ["--queue", "release/1.x"]
    await git(["config", "yrd.workdir", "relative-state"])
    const nested = join(repo, "nested")
    mkdirSync(nested)
    const paused = capture(nested)
    expect(
      await runYrdProcess(
        ["bun", "yrd", "queue", "pause", ...operand, "--reason", "checking release", "--notify", "@dev/3", "--json"],
        paused.io,
      ),
      paused.stderr(),
    ).toBe(0)
    expect(JSON.parse(paused.stdout())).toMatchObject({ kind: "paused", reason: "checking release" })
    const owned = join(
      repo,
      "relative-state",
      "local",
      `${join(dirname(repo), "remote.git").slice(1)}~release%2F1.x`,
      "repo",
    )
    expect(existsSync(owned)).toBe(true)
    expect(await git(refs)).toBe(before)
    expect(readFileSync(fetchHead, "utf8")).toBe("another command's fetch result\n")
    expect(await yrdRefs()).toEqual(expectedYrdRefs)
    const resumed = capture(repo)
    const reason = mode === "default" ? [] : ["--reason", "release checked"]
    expect(
      await runYrdProcess(["bun", "yrd", "queue", "resume", ...operand, ...reason, "--json"], resumed.io),
      resumed.stderr(),
    ).toBe(0)
    expect(JSON.parse(resumed.stdout())).toMatchObject({
      kind: "resumed",
      reason: mode === "default" ? "pause lifted" : "release checked",
    })
    expect(await yrdRefs()).toEqual(expectedYrdRefs)
    expect(await git(refs)).toBe(before)
    expect(readFileSync(fetchHead, "utf8")).toBe("another command's fetch result\n")
    expect(
      (await readEventQueueWithChanges(createEventStore(repo, "origin", git.selection), "release/1.x")).invalid.get(
        "task/unreadable",
      )?.ref,
    ).toBe(malformedRef)
  })

  // 25296: the verb end to end, against the FETCHED target's declaration.
  it("queue override sets, lists, refuses an unknown check and clears through queue events", async () => {
    const repo = await world('checks:\n  - verify: {run: "true", on: [merge]}\n  - lint: {run: "true", on: [submit]}\n')
    const git = gitIn(repo)
    await createQueue(repo, "main", (await git(["rev-parse", "HEAD"])).trim(), new Date())
    const yrd = async (...args: string[]) => {
      const run = capture(repo)
      const code = await runYrdProcess(["bun", "yrd", "queue", "override", "--queue", "main", ...args], run.io)
      return { code, stderr: run.stderr(), stdout: run.stdout() }
    }
    const refs = async (): Promise<string> =>
      (await gitIn(join(dirname(repo), "remote.git"))(["for-each-ref", "--format=%(refname)", "refs/yrd/"])).trim()

    const until = new Date(Date.now() + 3_600_000).toISOString()
    const unknown = await yrd("--check", "nope", "--off", "--until", until, "--reason", "x")
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain("no merge check named 'nope' is declared; the declared merge checks are: verify")
    // A submit-only check is not a merge check, so it cannot be held off at merge.
    expect((await yrd("--check", "lint", "--off", "--until", until, "--reason", "x")).stderr).toContain(
      "the declared merge checks are: verify",
    )
    expect((await yrd("--check", "verify", "--off", "--reason", "x")).stderr).toContain("needs --until <time>")
    const refsBefore = await refs()

    const set = await yrd("--check", "verify", "--off", "--until", until, "--reason", "flaky gate", "--json")
    expect(set.code, set.stderr).toBe(0)
    expect(JSON.parse(set.stdout)).toMatchObject({
      kind: "set",
      overrides: [{ check: "verify", reason: "flaky gate", state: "active", until, verified: false }],
    })
    expect(await refs()).toBe(refsBefore)
    // No notify entry wants `override`: the verb says so once, naming the record that stands in for the page.
    expect(set.stderr.match(/no notify entry in \.yrd\.yml wants override events/gu)).toHaveLength(1)

    const listed = await yrd("--list")
    expect(listed.code).toBe(0)
    expect(listed.stdout).toContain(`verify OFF until ${until}`)

    const cleared = await yrd("--check", "verify", "--clear", "--reason", "gate fixed", "--json")
    expect(cleared.code, cleared.stderr).toBe(0)
    expect(JSON.parse(cleared.stdout)).toMatchObject({ kind: "clear", overrides: [] })
    const again = await yrd("--check", "verify", "--clear", "--reason", "twice")
    expect(again.code).toBe(1)
    expect(again.stderr).toContain("no override stands on 'verify' to clear")
  })

  // 28880: clearing ends a stored decision even after its check leaves the fetched declaration.
  it("clears a stored override after its check leaves the declaration", async () => {
    const repo = await world('checks:\n  - verify: {run: "true", on: [merge]}\n')
    const git = gitIn(repo)
    await createQueue(repo, "main", (await git(["rev-parse", "HEAD"])).trim(), new Date())
    const yrd = async (...args: string[]) => {
      const run = capture(repo)
      const code = await runYrdProcess(["bun", "yrd", "queue", "override", "--queue", "main", ...args], run.io)
      return { code, stderr: run.stderr(), stdout: run.stdout() }
    }
    const until = new Date(Date.now() + 3_600_000).toISOString()
    const set = await yrd("--check", "verify", "--off", "--until", until, "--reason", "investigate", "--json")
    expect(set.code, set.stderr).toBe(0)
    expect(JSON.parse(set.stdout)).toMatchObject({ kind: "set", overrides: [{ check: "verify" }] })

    writeFileSync(join(repo, ".yrd.yml"), "{}\n")
    await git(["add", ".yrd.yml"])
    await git(["commit", "--quiet", "-m", "remove the merge check"])
    await git(["push", "--quiet", "origin", "main"])

    const cleared = await yrd("--check", "verify", "--clear", "--reason", "check removed")
    expect(cleared.code, cleared.stderr).toBe(0)
    expect(cleared.stdout).toContain("check is no longer declared")
    const listed = await yrd("--list", "--json")
    expect(listed.code, listed.stderr).toBe(0)
    expect(JSON.parse(listed.stdout)).toMatchObject({ overrides: [] })

    const off = await yrd("--check", "verify", "--off", "--until", until, "--reason", "still removed")
    expect(off.code).toBe(1)
    expect(off.stderr).toContain("no merge check named 'verify' is declared")
  })

  // 25296 (@cto ccd8dfa8, ruling A): the verb pages set, replace and clear; a
  // notifier that fails is said on stderr and journaled, and the override stands.
  it("queue override hands each write to the notify entries that want it, and a failing one never blocks the override", async () => {
    const paged = join(tmpdir(), `yrd-override-paged-${String(process.pid)}-${String(Date.now())}.jsonl`)
    const repo = await world(
      'checks:\n  - verify: {run: "true", on: [merge]}\n' +
        `notify:\n  - pager: {on: [override], run: "cat >> ${paged}"}\n` +
        '  - broken: {on: [override], run: "echo pager down >&2; exit 3"}\n' +
        '  - merges: {on: [merged], run: "exit 9"}\n',
    )
    const git = gitIn(repo)
    await createQueue(repo, "main", (await git(["rev-parse", "HEAD"])).trim(), new Date())
    const state = join(dirname(repo), "state")
    await gitIn(repo)(["config", "yrd.workdir", state])
    const yrd = async (...args: string[]) => {
      const run = capture(repo)
      const code = await runYrdProcess(["bun", "yrd", "queue", "override", "--queue", "main", ...args], run.io)
      return { code, stderr: run.stderr(), stdout: run.stdout() }
    }
    const until = new Date(Date.now() + 3_600_000).toISOString()
    const target = (await gitIn(join(dirname(repo), "remote.git"))(["rev-parse", "refs/heads/main"])).trim()

    const set = await yrd("--check", "verify", "--off", "--until", until, "--reason", "flaky gate", "--json")
    expect(set.code, set.stderr).toBe(0)
    expect(set.stderr).toContain("yrd: could not tell broken about the override (it stands)")
    expect(set.stderr).toContain("pager down")
    expect(set.stderr).not.toContain("no notify entry")
    const record = JSON.parse(set.stdout) as { record: string; told: readonly { name: string; delivery: string }[] }
    expect(record.told.map(({ name, delivery }) => `${name} ${delivery}`)).toEqual(["pager sent", "broken failed"])
    const replaced = await yrd("--check", "verify", "--off", "--until", until, "--reason", "still flaky")
    expect(replaced.code, replaced.stderr).toBe(0)
    const cleared = await yrd("--check", "verify", "--clear", "--reason", "gate fixed")
    expect(cleared.code, cleared.stderr).toBe(0)
    // The failing notifier blocked nothing: the chain holds set, replace and clear.
    expect(JSON.parse((await yrd("--list", "--json")).stdout)).toMatchObject({ overrides: [] })

    const notices = readFileSync(paged, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(notices).toEqual([
      expect.objectContaining({
        action: "set",
        check: "verify",
        owner: expect.any(String),
        reason: "flaky gate",
        record: "override",
        target: `main@${target}`,
        until,
        verified: false,
      }),
      expect.objectContaining({ action: "replace", reason: "still flaky", until }),
      expect.objectContaining({ action: "clear", reason: "gate fixed", until }),
    ])
    expect(notices.every((notice) => notice["round"] === undefined)).toBe(true)
    expect(notices[0]?.["override"]).toBe(record.record)
    // The journal sits in the queue's own workdir, beside (never among) the run journals under logs/.
    const journals = readdirSync(state, { recursive: true, encoding: "utf8" }).filter((path) =>
      path.endsWith("override-notify.jsonl"),
    )
    expect(journals).toHaveLength(1)
    const journal = readFileSync(join(state, journals[0] ?? ""), "utf8")
      .trim()
      .split("\n")
    expect(journal.map((line) => (JSON.parse(line) as { notice: { action: string } }).notice.action)).toEqual([
      "set",
      "replace",
      "clear",
    ])
    expect(JSON.parse(journal[0] ?? "{}")).toMatchObject({
      told: [
        { delivery: "sent", name: "pager" },
        { delivery: "failed", name: "broken" },
      ],
    })
    rmSync(paged, { force: true })
  })

  it("requires pause --reason before any pause ref changes", async () => {
    const repo = await world("{}\n")
    const run = capture(repo)
    expect(await runYrdProcess(["bun", "yrd", "queue", "pause", "--queue", "main", "--json"], run.io)).toBe(2)
    expect(await gitIn(join(dirname(repo), "remote.git"))(["for-each-ref", "--format=%(refname)", "refs/yrd/"])).toBe(
      "",
    )
  })

  it.each(["list", "show", "watch"])("%s refuses outside a clone with repository guidance", async (verb) => {
    const outside = outsideRepositoryRoot("yrd-cli-no-clone-")
    roots.push(outside)
    const command = verb === "watch" ? ["watch", "topic"] : ["queue", verb, "topic"]
    for (const selector of [[], ["--queue", "main"], ["--queue", `${outside}/no-repository#main`]]) {
      const run = capture(outside)
      expect(await runYrdProcess(["bun", "yrd", ...command, ...selector, "--json"], run.io)).toBe(2)
      expect(run.stderr()).toContain("needs a repository")
      expect(run.stderr()).toContain("inside a clone")
      expect(run.stdout()).toBe("")
    }
  })

  it.each(["run", "up", "pause", "resume"])("%s outside a clone requires an address-valued flag", async (verb) => {
    const outside = outsideRepositoryRoot("yrd-cli-no-clone-")
    roots.push(outside)
    const reason = verb === "pause" ? ["--reason", "checking"] : []
    for (const selector of [[], ["--queue", "main"]]) {
      const run = capture(outside)
      expect(await runYrdProcess(["bun", "yrd", "queue", verb, ...selector, ...reason, "--json"], run.io)).toBe(2)
      expect(run.stderr()).toContain("inside a clone or pass --queue <repo>@<branch>")
    }
    const operand = "https://forge.example/team/repo.git#"
    const malformed = capture(outside)
    expect(
      await runYrdProcess(["bun", "yrd", "queue", verb, "--queue", operand, ...reason, "--json"], malformed.io),
    ).toBe(2)
    expect(malformed.stderr()).toContain(`queue address '${operand}' must be <repo>@<branch>`)
    expect(malformed.stdout()).toBe("")
  })

  it.each(["run", "up", "pause", "resume"])("%s refuses a positional queue before remote mutation", async (verb) => {
    const repo = await world("{}\n")
    const run = capture(repo)
    const reason = verb === "pause" ? ["--reason", "checking"] : []
    expect(await runYrdProcess(["bun", "yrd", "queue", verb, "main", ...reason, "--json"], run.io)).toBe(2)
    expect(await gitIn(join(dirname(repo), "remote.git"))(["for-each-ref", "--format=%(refname)", "refs/yrd/"])).toBe(
      "",
    )
  })

  it("addressed submit sends the unpublished author head without rewriting origin", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const origin = (await git(["remote", "get-url", "origin"])).trim()
    const destination = join(dirname(repo), "destination.git")
    await git(["clone", "--quiet", "--bare", origin, destination])
    await createQueue(repo, "main", (await git(["rev-parse", "HEAD"])).trim(), new Date(), destination)
    await git(["checkout", "--quiet", "-b", "task/addressed"])
    writeFileSync(join(repo, "addressed.txt"), "unpublished author work\n")
    await git(["add", "addressed.txt"])
    await git(["commit", "--quiet", "-m", "addressed author change"])
    const head = (await git(["rev-parse", "HEAD"])).trim()
    const submitted = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "submit", "--queue", `${destination}#main`, "--json"], submitted.io),
      submitted.stderr(),
    ).toBe(0)
    expect(JSON.parse(submitted.stdout())).toMatchObject({ branch: "task/addressed", head })
    expect(await git(["remote", "get-url", "origin"])).toBe(`${origin}\n`)
    expect(await git(["ls-remote", "--refs", "origin", "refs/heads/task/addressed", "refs/yrd/main/*"])).toBe("")
    expect((await git(["ls-remote", "--refs", destination, "refs/heads/task/addressed"])).split("\t")[0]).toBe(head)
    // A paused destination still takes the submit (the andon, operator
    // 2026-09-16), and the echo names the ADDRESSED queue's resume command.
    const pause = capture(repo)
    expect(
      await runYrdProcess(
        [
          "bun",
          "yrd",
          "queue",
          "pause",
          "--queue",
          `${destination}#main`,
          "--reason",
          "inspect destination",
          "--notify",
          "@dev/3",
        ],
        pause.io,
      ),
      pause.stderr(),
    ).toBe(0)
    const accepted = capture(repo)
    expect(
      await runYrdProcess(
        ["bun", "yrd", "submit", "--queue", `${destination}#main`, "--dry-run", "--json"],
        accepted.io,
      ),
      accepted.stderr(),
    ).toBe(0)
    expect(accepted.stderr()).toContain("inspect destination")
    expect(accepted.stderr()).toContain("paused by @dev/3 since")
    expect(accepted.stderr()).toContain(`yrd queue resume --queue '${destination}#main' --reason '<text>'`)
    expect(JSON.parse(accepted.stdout())).toMatchObject({
      dryRun: true,
      stopped: { by: "@dev/3", cause: "operator", change: null },
    })
  })

  it("list/show/watch preserve their subjects while selecting a different queue from a nested cwd", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    await git(["branch", "release/1.x"])
    await git(["push", "--quiet", "origin", "release/1.x"])
    const target = (await git(["rev-parse", "HEAD"])).trim()
    await createQueue(repo, "main", target, new Date())
    await createQueue(repo, "release/1.x", target, new Date())
    for (const [branch, queue] of [
      ["task/default", "main"],
      ["task/topic", "release/1.x"],
      ["task/other", "release/1.x"],
    ] as const) {
      await git(["checkout", "--quiet", "-b", branch, "main"])
      const file = `${branch.slice("task/".length)}.txt`
      writeFileSync(join(repo, file), `${branch}\n`)
      await git(["add", file])
      await git(["commit", "--quiet", "-m", branch])
      const submitted = capture(repo)
      expect(
        await runYrdProcess(["bun", "yrd", "submit", branch, "--queue", queue, "--json"], submitted.io),
        submitted.stderr(),
      ).toBe(0)
    }
    // End the selected queue in this disposable repository so watch returns
    // immediately; no timer or live queue is involved in the parser check.
    const merged = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "queue", "run", "--queue", "release/1.x", "--json"], merged.io),
      merged.stderr(),
    ).toBe(0)
    const nested = join(repo, "nested")
    mkdirSync(nested)
    await git(["config", "yrd.workdir", join(dirname(repo), "state")])
    for (const selector of ["release/1.x", `${join(dirname(repo), "remote.git")}#release/1.x`]) {
      for (const command of [
        ["queue", "list", "topic"],
        ["queue", "show", "task/topic"],
        ["watch", "topic"],
      ]) {
        const run = capture(nested)
        expect(
          await runYrdProcess(
            ["bun", "yrd", ...command, "--queue", selector, "--json", ...(command[0] === "watch" ? [] : ["--fresh"])],
            run.io,
          ),
          run.stderr(),
        ).toBe(0)
        // Scope/journal notices may name retained histories outside the row filter.
        const rows = (JSON.parse(run.stdout()) as { changes: readonly { branch: string }[] }).changes
        expect(rows.map((row) => row.branch)).toContain("task/topic")
        expect(rows.map((row) => row.branch)).not.toContain("task/default")
        expect(rows.map((row) => row.branch)).not.toContain("task/other")
        if (command[1] === "show") {
          const shown = JSON.parse(run.stdout()) as Readonly<{ changes: readonly Readonly<{ queue: string }>[] }>
          expect(shown.changes[0]?.queue).toBe("release/1.x")
        }
      }
    }
  })

  it("refuses malformed config from the queue branch and names what it read", async () => {
    const repo = await world("checks: [{\n")
    const run = capture(repo)

    await expect(coreQueueCommand(repo, run.io, { command: "list" }, { queue: "main" })).rejects.toThrow(
      /the declaration at origin\/main cannot be read: .*\.yrd\.yml.*does not parse/u,
    )

    // The up action must forward both the addressed clone and selected branch.
    // An unusable caller origin makes borrowing that checkout observable.
    const git = gitIn(repo)
    const remote = (await git(["remote", "get-url", "origin"])).trim()
    await git(["push", "--quiet", "origin", "HEAD:refs/heads/release/uri"])
    await git(["config", "yrd.workdir", join(dirname(repo), "state")])
    await git(["remote", "set-url", "origin", join(dirname(repo), "missing.git")])
    const service = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "queue", "up", "--queue", `${remote}#release/uri`, "--json"], service.io),
    ).toBe(2)
    expect(service.stderr()).toContain("the declaration at origin/release/uri cannot be read")
    expect(service.stderr()).toContain(".yrd.yml")
    expect(service.stderr()).toContain("does not parse")
  })

  it.each([
    [
      "a newer nested value",
      'checks:\n  - verify:\n      run: "echo hi"\n      future-field: true\n',
      ".yrd.yml checks[0] verify: unknown key future-field",
    ],
    ["a malformed value", "notify: [{desk: {run: 5}}]\n", ".yrd.yml notify[0] desk: needs run: <command>"],
  ])("names the mechanism and the cure when a tolerant read refuses %s", async (_label, config, detail) => {
    // An unknown TOP-level key is a warning since 27187/27796, and an unknown notify
    // event is a warning plus a skipped entry since 28619; a newer value inside any
    // OTHER key this Yrd DOES know still refuses — and so does a simply malformed
    // value. The refusal must name the MECHANISM and the cure, never a guessed cause:
    // no line may claim this environment is older, because the same text fires for a
    // declaration main would refuse too (28510).
    const repo = await world(config)
    const run = capture(repo)

    const error = (await coreQueueCommand(repo, run.io, { command: "list" }, { queue: "main" }).catch(
      (cause: unknown) => cause,
    )) as Error
    expect(error.message).toContain("the declaration at origin/main cannot be read")
    expect(error.message).toContain(detail)
    expect(error.message).toContain("cannot read it. If origin/main's declaration is newer than this Yrd")
    expect(error.message).toContain("run main's yrd: @in main -- bun yrd queue list")
    expect(error.message).toContain("if main's yrd refuses it too, the declaration itself is malformed")
    expect(error.message).toMatch(/\(yrd \S+\+\S+\)/u)
    expect(error.message).not.toContain("is older than")
  })

  it.each(["list", "drop-local", "drop-issue"] as const)(
    "refuses %s on a selected branch with no config and names the cure",
    async (command) => {
      const repo = await world()
      const run = capture(repo)

      const request =
        command === "list"
          ? { command }
          : command === "drop-local"
            ? { command, branch: "task/29600", tip: "a".repeat(40), by: "tester", issue: "29600" }
            : { command, issue: "29600", by: "tester" }
      const exit = await coreQueueCommand(repo, run.io, request, { queue: "main" })

      expect(exit).toBe(2)
      expect(run.stderr()).toContain("needs a queue")
      expect(run.stderr()).toContain("origin/main carries no .yrd.yml")
      // The cure holds for both conditions this refusal cannot tell apart: an
      // addressed miss (re-address it) and a repository that never declared a
      // queue at all (a submodule's is its superproject's, not its own).
      expect(run.stderr()).toContain("--queue <repo>#<branch>")
      expect(run.stderr()).toContain("superproject")
      if (command !== "list") {
        expect(run.stderr()).toContain(
          "yrd drop <root-branch> --local --tip <root-tip> --issue <issue> --reason <why> --release-checkout --submodules",
        )
        expect(run.stderr()).toContain("preview")
      }
    },
  )
})

/**
 * @failure Explicit checkout release must preserve retained bytes and publish every repository's custody before deleting refs.
 * @level l2: real local remotes through the public CLI; the existing removely census boundary controls holder races.
 * @consumer Authors retaining dirty checkouts while dropping reviewed exact tips (29600).
 * Existing issue-drop tests preserve attached branches; they cannot exercise opt-in detach or one-root custody.
 */
/**
 * @failure Component-local cleanup refuses a missing queue declaration and strands work after its root retires.
 * @level l2: public CLI, real declared root, real absorbed submodule and independent local remotes.
 * @consumer Component owners and branch-triage exact-tip local retirement.
 * Existing no-config coverage has no declared parent, so it cannot observe this regression.
 */
describe("component-local retirement without a component queue", () => {
  it.each([
    "merged",
    "unmerged",
    "held",
    "checked-out",
    "publication-refused",
    "archive-readback-lost",
    "prior-day-archive",
    "own-declared-selected-other",
    "own-malformed-selected-other",
    "root-retired",
    "advanced",
    "protection-error",
    "missing-protections-reader",
    "archive-collision",
    "malformed-declaration",
    "unreadable-declaration",
  ] as const)("retires exact %s component work through the declared root's existing log", async (mode) => {
    const root = await world("{}\n")
    const rootGit = gitIn(root)
    const ownSelectedOther = mode === "own-declared-selected-other" || mode === "own-malformed-selected-other"
    const seed = await world(
      mode === "malformed-declaration" || mode === "own-malformed-selected-other"
        ? "checks: [\n"
        : mode === "own-declared-selected-other"
          ? "{}\n"
          : undefined,
    )
    await rootGit([
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--quiet",
      join(dirname(seed), "remote.git"),
      "modules/child",
    ])
    const child = join(root, "modules/child")
    const git = gitIn(child)
    await rootGit(["commit", "--quiet", "-am", "record component"])
    await rootGit(["push", "--quiet", "origin", "main"])
    const rootTip = (await rootGit(["rev-parse", "HEAD"])).trim()
    await createQueue(root, "main", rootTip, new Date())
    const branch = "task/28824-component"
    const baseTip = (await git(["rev-parse", "HEAD"])).trim()
    if (
      mode === "unmerged" ||
      mode === "advanced" ||
      mode === "archive-collision" ||
      mode === "publication-refused" ||
      mode === "archive-readback-lost" ||
      mode === "prior-day-archive"
    ) {
      await git(["checkout", "--quiet", "-b", branch])
      writeFileSync(join(child, "private.txt"), "reviewed unmerged work\n")
      await git(["add", "private.txt"])
      await git([
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@test.invalid",
        "commit",
        "--quiet",
        "-m",
        "unmerged component work",
      ])
      await git(["checkout", "--quiet", "main"])
    } else {
      await git(["branch", branch])
    }
    const actualTip = (await git(["rev-parse", "refs/heads/" + branch])).trim()
    const tip = mode === "advanced" ? baseTip : actualTip
    const collisionRef = archiveRefFor(branch, "fixture", new Date().toISOString().slice(0, 10))
    const priorRef = archiveRefFor(branch, "fixture", new Date(Date.now() - 86_400_000).toISOString().slice(0, 10))
    if (mode === "prior-day-archive") {
      // Previous-day custody survived a kept/failed deletion; retry must reuse its exact name.
      await git(["update-ref", priorRef, tip])
      await git(["push", "--quiet", "origin", tip + ":" + priorRef])
    }
    if (mode === "archive-collision") await git(["push", "--quiet", "origin", baseTip + ":" + collisionRef])
    if (mode === "checked-out") await git(["checkout", "--quiet", branch])
    if (mode === "publication-refused" || mode === "archive-readback-lost") {
      const hook = join(
        dirname(seed),
        "remote.git",
        "hooks",
        mode === "publication-refused" ? "pre-receive" : "post-receive",
      )
      writeFileSync(
        hook,
        mode === "publication-refused"
          ? "#!/bin/sh\necho 'fixture refuses archive publication' >&2\nexit 1\n"
          : '#!/bin/sh\nwhile read old new ref; do\ncase "$ref" in refs/archive/*) git update-ref -d "$ref" "$new" ;; esac\ndone\n',
      )
      chmodSync(hook, 0o755)
    }
    if (mode === "root-retired") {
      const rootBranch = "task/28824-root-already-retired"
      await rootGit(["branch", rootBranch])
      const prior = capture(root)
      expect(
        await runYrdProcess(
          ["bun", "yrd", "drop", rootBranch, "--local", "--tip", rootTip, "--submitter", "fixture", "--json"],
          prior.io,
        ),
        prior.stderr(),
      ).toBe(0)
      expect((await rootGit(["for-each-ref", "--format=%(objectname)", "refs/heads/" + rootBranch])).trim()).toBe("")
    }
    const run = capture(child)
    const selectedOther = ownSelectedOther ? await world() : undefined
    if (ownSelectedOther) unlinkSync(join(child, ".yrd.yml"))
    run.io.localBranchProtections = async () => {
      if (mode === "protection-error") throw new Error("host protection authority unavailable")
      return { protections: mode === "held" ? ["fixture owner hold"] : [], evidence: [] }
    }
    // An untyped embedder can omit wiring; that is not an explicit standalone
    // repository. Existing cases always install a reader and miss this fault.
    if (mode === "missing-protections-reader") Reflect.deleteProperty(run.io, "localBranchProtections")
    const nativeLstat = fs.lstatSync
    const unreadable =
      mode === "unreadable-declaration"
        ? vi.spyOn(fs, "lstatSync").mockImplementation((path, options) => {
            if (String(path) === join(child, ".yrd.yml")) {
              throw Object.assign(new Error("EACCES: declaration authority is unreadable"), { code: "EACCES" })
            }
            return nativeLstat(path, options)
          })
        : undefined
    if (mode === "unreadable-declaration") writeFileSync(join(child, ".yrd.yml"), "{}\n")
    const exit = await runYrdProcess(
      [
        "bun",
        "yrd",
        "drop",
        branch,
        "--local",
        "--tip",
        tip,
        "--issue",
        "28824",
        "--reason",
        "explicit reviewed component drop",
        "--submitter",
        "fixture",
        ...(mode === "publication-refused" ? [] : ["--json"]),
        ...(selectedOther === undefined ? [] : ["--queue", `${join(dirname(selectedOther), "remote.git")}#main`]),
      ],
      run.io,
    ).finally(() => unreadable?.mockRestore())
    const failure =
      mode === "protection-error" ||
      mode === "missing-protections-reader" ||
      mode === "archive-collision" ||
      mode === "publication-refused" ||
      mode === "archive-readback-lost" ||
      mode === "malformed-declaration" ||
      mode === "unreadable-declaration" ||
      ownSelectedOther
    if (failure) {
      expect(exit).not.toBe(0)
      expect((await git(["rev-parse", "refs/heads/" + branch])).trim()).toBe(actualTip)
      expect(run.stdout() + run.stderr()).toContain(child)
      if (mode === "protection-error") {
        expect(run.stdout() + run.stderr()).toContain("host protection authority unavailable")
      }
      if (mode === "missing-protections-reader") expect(run.stdout() + run.stderr()).toContain("localBranchProtections")
      if (mode === "unreadable-declaration") expect(run.stderr()).toContain("EACCES")
      if (mode === "archive-collision") {
        expect((await git(["ls-remote", "origin", collisionRef])).split("\t")[0]).toBe(baseTip)
      }
      if (mode === "publication-refused") {
        expect(run.stdout() + run.stderr()).toContain("fixture refuses archive publication")
      }
      if (mode === "archive-readback-lost") expect(run.stdout() + run.stderr()).toContain("read back")
      if (mode === "own-declared-selected-other") expect(run.stderr()).toContain("own origin target declares")
      if (mode === "own-malformed-selected-other") expect(run.stderr()).toContain("does not parse")
      if (ownSelectedOther) return
      if (mode === "malformed-declaration" || mode === "unreadable-declaration") return
    } else expect(exit, run.stderr()).toBe(0)
    if (!failure) {
      const report = JSON.parse(run.stdout()) as {
        removed: { branch: string; head: string; archiveRef: string }[]
        kept: { branch: string }[]
        failed: unknown[]
      }
      expect(report.failed).toEqual([])
      if (mode === "held" || mode === "advanced" || mode === "checked-out") {
        expect(report.removed).toEqual([])
        expect(report.kept).toEqual([expect.objectContaining({ branch, head: actualTip })])
        expect((await git(["rev-parse", "refs/heads/" + branch])).trim()).toBe(actualTip)
      } else {
        expect(report.removed).toEqual([expect.objectContaining({ branch, head: tip })])
        const archive = report.removed[0]?.archiveRef
        expect(archive).toMatch(/^refs\/archive\//u)
        if (typeof archive !== "string") throw new Error("removed component result has no archive ref")
        expect((await git(["rev-parse", archive])).trim()).toBe(tip)
        if (mode === "prior-day-archive") {
          expect(archive).toBe(priorRef)
          expect((await git(["for-each-ref", "--format=%(refname)", "refs/archive/"])).trim()).toBe(priorRef)
          expect((await git(["ls-remote", "origin", "refs/archive/*"])).trim()).toBe(`${tip}\t${priorRef}`)
        }
        expect((await git(["for-each-ref", "--format=%(objectname)", "refs/heads/" + branch])).trim()).toBe("")
        if (mode === "unmerged") expect((await git(["ls-remote", "origin", archive])).split("\t")[0]).toBe(tip)
      }
    }
    expect((await git(["ls-remote", "origin", "refs/yrd/*"])).trim()).toBe("")
    const logs = join(await workdirOf(rootGit), "logs")
    const records = readdirSync(logs)
      .filter((name) => name.endsWith(".jsonl"))
      .flatMap((name) =>
        readFileSync(join(logs, name), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { kind?: string; repo?: string; branch?: string; head?: string }),
      )
    expect(records).toContainEqual(
      expect.objectContaining({ kind: "local-branch-retirement", repo: child, branch, head: tip }),
    )
    if (failure) {
      expect(records).toContainEqual(
        expect.objectContaining({ kind: "local-branch-retirement", repo: child, branch, outcome: "failed" }),
      )
    }
  })
})

describe("drop --local --release-checkout", () => {
  function releaseCapture(repo: string) {
    const output = capture(repo)
    output.io.liveEnvironmentUse = async () => []
    output.io.localBranchProtections = async () => ({ protections: [], evidence: [] })
    return output
  }
  type ReleaseReport = Awaited<ReturnType<typeof releaseRetainedCheckouts>>
  async function releaseWorld(component = false) {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const branch = "task/29600-retained"
    let child: string | undefined
    if (component) {
      const seed = await world()
      await git([
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "--quiet",
        join(dirname(seed), "remote.git"),
        "modules/child",
      ])
      child = join(repo, "modules/child")
      await gitIn(child)(["checkout", "--quiet", "-b", branch])
      await gitIn(child)(["branch", "task/29600-unselected"])
      await git(["commit", "--quiet", "-am", "record exact child"])
      await git(["push", "--quiet", "origin", "main"])
    }
    const target = (await git(["rev-parse", "HEAD"])).trim()
    await createQueue(repo, "main", target, new Date())
    await git(["checkout", "--quiet", "-b", branch])
    writeFileSync(join(repo, "payload.txt"), "private committed work\n")
    await git(["add", "payload.txt"])
    await git(["commit", "--quiet", "-m", "unpublished author work"])
    const tip = (await git(["rev-parse", "HEAD"])).trim()
    const checkoutFiles = new Map<string, { lease: string; lock: string; index: string; bytes: Buffer[] }>()
    for (const path of [repo, ...(child === undefined ? [] : [child])]) {
      const read = gitIn(path)
      const gitdir = (await read(["rev-parse", "--absolute-git-dir"])).trim()
      writeFileSync(join(path, "README.md"), "dirty tracked bytes\n")
      writeFileSync(join(path, "private.bin"), Buffer.from([0, 255, 12, 8]))
      const lease = join(path, ".agent-lease.json")
      const lock = join(gitdir, "locked")
      const index = join(gitdir, "index")
      writeFileSync(lease, '{"bad":"retained evidence"}\n')
      writeFileSync(lock, "retained lock\n")
      checkoutFiles.set(path, {
        lease,
        lock,
        index,
        bytes: [readFileSync(lease), readFileSync(lock), readFileSync(index)],
      })
    }
    const argv = [
      "bun",
      "yrd",
      "drop",
      branch,
      "--local",
      "--tip",
      tip,
      "--issue",
      "29600",
      "--reason",
      "retain checkout",
      "--release-checkout",
      "--submitter",
      "fixture",
      "--json",
      ...(component ? ["--submodules"] : []),
    ]
    return { repo, git, branch, tip, child, checkoutFiles, argv }
  }
  async function permitCensus() {
    const actual = await vi.importActual<typeof import("removely")>("removely")
    const observed = await actual.inspectProcessCensus({ scope: "same-uid", sources: ["cwd"], deadlineMs: 2000 })
    const permitted = { ...observed, rows: [], coverage: { ...observed.coverage, complete: true, unreadable: [] } }
    const spy = vi.spyOn(removely, "inspectProcessCensus").mockResolvedValue(permitted)
    return { spy, permitted }
  }
  async function credentialOrigin(repo: string) {
    const git = gitIn(repo)
    const remote = (await git(["remote", "get-url", "origin"])).trim()
    const credential = "https://fixture-user:fixture-secret@repo.invalid/retained.git"
    await git(["config", `url.${remote}.insteadOf`, credential])
    await git(["remote", "set-url", "origin", credential])
    return credential
  }
  // Explicit release must prove both host authorities are connected; ordinary
  // drop fixtures do not exercise the missing-reader boundary.
  it.each(["liveEnvironmentUse", "localBranchProtections", "empty liveEnvironmentUse"] as const)(
    "refuses release without the %s authority reader",
    async (reader) => {
      const fixture = await releaseWorld()
      const { spy } = await permitCensus()
      try {
        const output = releaseCapture(fixture.repo)
        if (reader === "empty liveEnvironmentUse") output.io.liveEnvironmentUse = vi.fn().mockResolvedValue(undefined)
        else delete output.io[reader]
        expect(await runYrdProcess([...fixture.argv, "--apply"], output.io)).toBe(1)
        const report = JSON.parse(output.stdout()) as ReleaseReport
        expect(report.failed[0]?.detail).toContain(
          reader === "empty liveEnvironmentUse" ? "did not return an array" : reader,
        )
        expect(report.removed).toEqual([])
        expect((await fixture.git(["symbolic-ref", "HEAD"])).trim()).toBe(`refs/heads/${fixture.branch}`)
        expect(await fixture.git(["for-each-ref", "refs/archive/"])).toBe("")
      } finally {
        spy.mockRestore()
      }
    },
    30_000,
  )
  /** @failure An origin lookup error escapes the release receipt and exposes transport credentials.
   * @level l2 @consumer releaseRetainedCheckouts callers, including the CLI
   * Setup fails before the existing CLI holder fixtures reach their diagnostic boundary.
   */
  it("redacts a failed origin lookup before constructing the event store", async () => {
    const fixture = await releaseWorld()
    const output = releaseCapture(fixture.repo)
    const report = await releaseRetainedCheckouts({
      repo: fixture.repo,
      git: async () => {
        throw new Error("remote lookup failed: https://fixture-user:fixture-secret@repo.invalid/retained.git")
      },
      selection: fixture.git.selection,
      io: output.io,
      log: { write: vi.fn() },
      queue: "main",
      remote: "origin",
      issueIdentity: (value) => value,
      request: { branch: fixture.branch, tip: fixture.tip, issue: "29600", reason: "retain checkout", by: "fixture" },
    })
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0]?.detail).toContain("remote lookup failed: https://repo.invalid/retained.git")
    expect(JSON.stringify(report)).not.toContain("fixture-secret")
    expect(JSON.stringify(report)).not.toContain("fixture-user")
    expect((await fixture.git(["symbolic-ref", "HEAD"])).trim()).toBe(`refs/heads/${fixture.branch}`)
    expect(await fixture.git(["for-each-ref", "refs/archive/"])).toBe("")
  })
  // Accepted recovery contract: a real partial ref-deletion failure must remain
  // resumable through the same CLI, with exactly one final custody event.
  // The earlier golden path and single-checkout refusals never partially retire.
  it.each(["root", "child"])(
    "resumes an already detached %s with its branch still present",
    async (kind) => {
      const fixture = await releaseWorld(kind === "child")
      const { spy } = await permitCensus()
      try {
        const repo = kind === "root" ? fixture.repo : fixture.child!
        const git = gitIn(repo)
        const tip = (await git(["rev-parse", "HEAD"])).trim()
        await git(["update-ref", "--no-deref", "HEAD", tip, tip])
        if (kind === "child") {
          const ambiguous = releaseCapture(fixture.repo)
          expect(await runYrdProcess(fixture.argv, ambiguous.io)).toBe(1)
          expect((JSON.parse(ambiguous.stdout()) as ReleaseReport).failed[0]?.detail).toContain("ambiguous")
          await git(["branch", "-m", "task/29600-unselected", "task/29601-unselected"])
        }
        const preview = releaseCapture(fixture.repo)
        expect(await runYrdProcess(fixture.argv, preview.io), preview.stdout() + preview.stderr()).toBe(0)
        expect((JSON.parse(preview.stdout()) as ReleaseReport).eligible).toHaveLength(kind === "child" ? 2 : 1)
        expect(await git(["for-each-ref", "refs/archive/"])).toBe("")
        const applied = releaseCapture(fixture.repo)
        expect(await runYrdProcess([...fixture.argv, "--apply"], applied.io), applied.stdout() + applied.stderr()).toBe(
          0,
        )
        expect((JSON.parse(applied.stdout()) as ReleaseReport).removed).toHaveLength(kind === "child" ? 2 : 1)
        expect((await git(["rev-parse", "HEAD"])).trim()).toBe(tip)
        expect(await git(["for-each-ref", `refs/heads/${fixture.branch}`])).toBe("")
      } finally {
        spy.mockRestore()
      }
    },
    30_000,
  )
  // A late hold must not orphan work committed after detachment; a failed
  // reattachment must leave a same-command retry after the competing lock clears.
  it.each(["advanced HEAD", "reattach lock"])(
    "preserves recovery after %s during retirement",
    async (kind) => {
      const fixture = await releaseWorld()
      const { spy } = await permitCensus()
      try {
        let advanced: string | undefined
        let lock: string | undefined
        let reads = 0
        const first = releaseCapture(fixture.repo)
        first.io.localBranchProtections = async () => {
          if (++reads === 4) {
            if (kind === "advanced HEAD") {
              const tree = (await fixture.git(["rev-parse", "HEAD^{tree}"])).trim()
              advanced = (
                await fixture.git(["commit-tree", tree, "-p", fixture.tip, "-m", "late author commit"])
              ).trim()
              await fixture.git(["update-ref", "HEAD", advanced, fixture.tip])
            } else {
              lock = join((await fixture.git(["rev-parse", "--absolute-git-dir"])).trim(), "HEAD.lock")
              writeFileSync(lock, "fixture competing HEAD writer\n")
            }
          }
          return { protections: reads >= 4 ? ["late holder"] : [], evidence: [] }
        }
        expect(await runYrdProcess([...fixture.argv, "--apply"], first.io)).toBe(1)
        const report = JSON.parse(first.stdout()) as ReleaseReport
        expect(report.failed).toHaveLength(1)
        expect(report.failed[0]?.detail).toContain(
          kind === "advanced HEAD" ? "retained checkout receipt changed" : "late holder",
        )
        expect((await fixture.git(["rev-parse", `refs/heads/${fixture.branch}`])).trim()).toBe(fixture.tip)
        expect(await fixture.git(["symbolic-ref", "--quiet", "HEAD"]).catch(() => "")).toBe("")
        if (kind === "advanced HEAD") {
          expect((await fixture.git(["rev-parse", "HEAD"])).trim()).toBe(advanced)
          expect(report.failed[0]?.detail).toContain(advanced)
        } else {
          expect(report.failed[0]?.detail).toContain("reattach")
          expect(report.failed[0]?.detail).toContain("retry")
          unlinkSync(lock!)
          const retry = releaseCapture(fixture.repo)
          expect(await runYrdProcess([...fixture.argv, "--apply"], retry.io), retry.stdout() + retry.stderr()).toBe(0)
          expect((JSON.parse(retry.stdout()) as ReleaseReport).removed).toHaveLength(1)
        }
      } finally {
        spy.mockRestore()
      }
    },
    30_000,
  )
  // Root deletion can finish before event publication fails. The archive, rather
  // than a live branch or a premature ending event, must make that retry possible.
  it("publishes exactly one ending when retrying after root retirement", async () => {
    const fixture = await releaseWorld()
    fixture.argv.push("--queue", `${fixture.repo}#main`)
    await credentialOrigin(fixture.repo)
    const { spy } = await permitCensus()
    const remote = gitIn(join(dirname(fixture.repo), "remote.git"))
    try {
      await remote(["config", "receive.hideRefs", `refs/yrd/main/changes/${fixture.branch}`])
      const first = releaseCapture(fixture.repo)
      expect(await runYrdProcess([...fixture.argv, "--apply"], first.io), first.stdout() + first.stderr()).toBe(1)
      const partial = JSON.parse(first.stdout()) as ReleaseReport
      expect(first.stdout()).not.toContain("fixture-secret")
      expect(first.stdout()).not.toContain("fixture-user")
      expect(partial.removed).toHaveLength(1)
      expect(partial.failed).toHaveLength(1)
      expect(await fixture.git(["for-each-ref", `refs/heads/${fixture.branch}`])).toBe("")
      expect(await remote(["for-each-ref", `refs/yrd/main/changes/${fixture.branch}`])).toBe("")
      await remote(["config", "--unset", "receive.hideRefs"])
      const retry = releaseCapture(fixture.repo)
      expect(await runYrdProcess([...fixture.argv, "--apply"], retry.io), retry.stdout() + retry.stderr()).toBe(0)
      const completed = JSON.parse(retry.stdout()) as ReleaseReport
      expect(completed.alreadyRetired).toHaveLength(1)
      expect(completed.removed).toEqual([])
      const history = (
        await readEventQueueWithChanges(createEventStore(fixture.repo, "origin", fixture.git.selection), "main")
      ).histories.get(fixture.branch)!
      expect(history.events.filter((event) => event.type === "cancelled")).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  }, 30_000)
  it.each(["child", "root", "wrong archive", "ambiguous archive"])(
    "resumes after %s deletion fails and completed replay writes nothing",
    async (failedRepo) => {
      const fixture = await releaseWorld(true)
      const { spy } = await permitCensus()
      try {
        const target = failedRepo === "root" ? fixture.repo : fixture.child!
        let lock: string | undefined
        const first = releaseCapture(fixture.repo)
        first.io.localBranchProtections = async ({ repo }) => {
          if (repo === target && (await gitIn(repo)(["symbolic-ref", "--quiet", "HEAD"]).catch(() => "")) === "") {
            lock = join(
              (await gitIn(repo)(["rev-parse", "--absolute-git-dir"])).trim(),
              `refs/heads/${fixture.branch}.lock`,
            )
            writeFileSync(lock, "fixture competing ref transaction\n")
          }
          return { protections: [], evidence: [] }
        }
        expect(await runYrdProcess([...fixture.argv, "--apply"], first.io), first.stderr()).toBe(1)
        const partial = JSON.parse(first.stdout()) as ReleaseReport
        expect(partial.failed).toHaveLength(1)
        expect(partial.removed).toHaveLength(failedRepo === "root" ? 1 : 0)
        expect((await fixture.git(["rev-parse", `refs/heads/${fixture.branch}`])).trim()).toBe(fixture.tip)
        const store = createEventStore(fixture.repo, "origin", fixture.git.selection)
        expect((await listChanges(store, "main")).size).toBe(0)
        expect(lock).toBeTypeOf("string")
        unlinkSync(lock!)
        if (failedRepo === "wrong archive" || failedRepo === "ambiguous archive") {
          const childGit = gitIn(fixture.child!)
          const archive = (await childGit(["for-each-ref", "--format=%(refname)", "refs/archive/"])).trim()
          const archivedTip = (await childGit(["rev-parse", archive])).trim()
          const wrong = (
            await childGit(["commit-tree", "HEAD^{tree}", "-p", archivedTip, "-m", "different custody"])
          ).trim()
          const extra = `refs/archive/2000-01-01/fixture/${fixture.branch}`
          await childGit([
            "update-ref",
            failedRepo === "wrong archive" ? archive : extra,
            failedRepo === "wrong archive" ? wrong : archivedTip,
          ])
          const refused = releaseCapture(fixture.repo)
          expect(
            await runYrdProcess([...fixture.argv, "--apply"], refused.io),
            refused.stdout() + refused.stderr(),
          ).toBe(1)
          expect((JSON.parse(refused.stdout()) as ReleaseReport).failed[0]?.detail).toMatch(/archive.*(pinned|custody)/)
          expect((await fixture.git(["rev-parse", `refs/heads/${fixture.branch}`])).trim()).toBe(fixture.tip)
          if (failedRepo === "wrong archive") await childGit(["update-ref", archive, archivedTip, wrong])
          else await childGit(["update-ref", "-d", extra, archivedTip])
        }
        const retry = releaseCapture(fixture.repo)
        expect(await runYrdProcess([...fixture.argv, "--apply"], retry.io), retry.stderr()).toBe(0)
        const completed = JSON.parse(retry.stdout()) as ReleaseReport
        expect(completed.failed).toEqual([])
        expect(completed.kept).toEqual([])
        for (const [repo, files] of fixture.checkoutFiles) {
          const read = gitIn(repo)
          expect(await read(["for-each-ref", `refs/heads/${fixture.branch}`])).toBe("")
          expect(await read(["symbolic-ref", "--quiet", "HEAD"]).catch(() => "")).toBe("")
          expect([readFileSync(files.lease), readFileSync(files.lock), readFileSync(files.index)]).toEqual(files.bytes)
          expect(readFileSync(join(repo, "private.bin"))).toEqual(Buffer.from([0, 255, 12, 8]))
        }
        const history = (await readEventQueueWithChanges(store, "main")).histories.get(fixture.branch)!
        expect(history.events.filter((event) => event.type === "cancelled")).toHaveLength(1)
        if (failedRepo === "child") {
          const control = await releaseWorld(true)
          const oneShot = releaseCapture(control.repo)
          expect(
            await runYrdProcess([...control.argv, "--apply"], oneShot.io),
            oneShot.stdout() + oneShot.stderr(),
          ).toBe(0)
          const controlHistory = (
            await readEventQueueWithChanges(createEventStore(control.repo, "origin", control.git.selection), "main")
          ).histories.get(control.branch)!
          const normalize = async (content: string, world: typeof fixture) =>
            content
              .replaceAll(world.repo, "<checkout>")
              .replaceAll(world.tip, "<root-tip>")
              .replaceAll((await gitIn(world.child!)(["rev-parse", "HEAD"])).trim(), "<child-tip>")
              .replaceAll(join(dirname(world.repo), "remote.git"), "<root-remote>")
              .replaceAll((await gitIn(world.child!)(["remote", "get-url", "origin"])).trim(), "<child-remote>")
          expect(await normalize(history.events.find((event) => event.type === "cancelled")!.content!, fixture)).toBe(
            await normalize(controlHistory.events.find((event) => event.type === "cancelled")!.content!, control),
          )
        }
        const eventTip = await fixture.git(["ls-remote", "origin", `refs/yrd/main/changes/${fixture.branch}`])
        const replay = releaseCapture(fixture.repo)
        const replayArgs = [...fixture.argv, "--apply"]
        replayArgs[replayArgs.indexOf("--reason") + 1] = "completed replay must not rewrite the prior receipt"
        expect(await runYrdProcess(replayArgs, replay.io), replay.stdout() + replay.stderr()).toBe(0)
        expect(await fixture.git(["ls-remote", "origin", `refs/yrd/main/changes/${fixture.branch}`])).toBe(eventTip)
        expect((JSON.parse(replay.stdout()) as ReleaseReport).failed).toEqual([])
      } finally {
        spy.mockRestore()
      }
    },
    60_000,
  )
  it("previews by default, then retains dirty/private/index/lease/lock bytes with own-remote custody and one root ending", async () => {
    const fixture = await releaseWorld(true)
    fixture.argv.push("--queue", `${fixture.repo}#main`)
    const { spy } = await permitCensus()
    try {
      const before = new Map<string, string>()
      for (const path of fixture.checkoutFiles.keys()) {
        await credentialOrigin(path)
        before.set(
          path,
          await gitIn(path)(["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all"]),
        )
      }
      for (const flags of [[], ["--dry-run"]]) {
        const preview = releaseCapture(fixture.repo)
        expect(await runYrdProcess([...fixture.argv, ...flags], preview.io), preview.stderr()).toBe(0)
        const report = JSON.parse(preview.stdout()) as ReleaseReport
        expect(preview.stdout()).not.toContain("fixture-secret")
        expect(preview.stdout()).not.toContain("fixture-user")
        expect(report.eligible, JSON.stringify(report) + preview.stderr()).toHaveLength(2)
        expect(report.eligible.map((row) => row.remote)).toEqual([
          "https://repo.invalid/retained.git",
          "https://repo.invalid/retained.git",
        ])
        expect(report.removed).toEqual([])
        expect((await fixture.git(["symbolic-ref", "HEAD"])).trim()).toBe(`refs/heads/${fixture.branch}`)
        expect((await listChanges(createEventStore(fixture.repo, "origin", fixture.git.selection), "main")).size).toBe(
          0,
        )
        expect(await fixture.git(["for-each-ref", "refs/archive/"])).toBe("")
      }
      const applied = releaseCapture(fixture.repo)
      applied.io.localBranchProtections = async ({ repo, branch, tip, retainedCheckout }) => {
        expect(retainedCheckout).toBe(repo)
        // Archive custody precedes deletion; the one root ending follows the complete release.
        if ((await gitIn(repo)(["symbolic-ref", "--quiet", "HEAD"]).catch(() => "")) === "") {
          expect(
            (await listChanges(createEventStore(fixture.repo, "origin", fixture.git.selection), "main")).size,
          ).toBe(0)
          const remote = (await gitIn(repo)(["remote", "get-url", "origin"])).trim()
          expect(await gitIn(repo)(["ls-remote", remote, `refs/archive/*/*/${branch}`])).toContain(tip)
        }
        return {
          protections: [],
          evidence: [
            { kind: "malformed-lease", path: join(repo, ".agent-lease.json"), reason: "fixture malformed lease" },
          ],
        }
      }
      expect(await runYrdProcess([...fixture.argv, "--apply"], applied.io), applied.stderr()).toBe(0)
      const report = JSON.parse(applied.stdout()) as ReleaseReport
      expect(applied.stdout()).not.toContain("fixture-secret")
      expect(applied.stdout()).not.toContain("fixture-user")
      expect(report.removed).toHaveLength(2)
      expect(report.failed).toEqual([])
      // Portable Yrd must retain the host's non-blocking evidence in its JSON receipt;
      // host integration owns parsing the actual lease bytes.
      expect(report.evidence).toEqual(
        expect.arrayContaining(
          [...fixture.checkoutFiles.keys()].map((repo) => ({
            kind: "malformed-lease",
            path: join(repo, ".agent-lease.json"),
            reason: "fixture malformed lease",
          })),
        ),
      )
      for (const row of report.removed) {
        const read = gitIn(row.repo)
        expect(await read(["for-each-ref", `refs/heads/${row.branch}`])).toBe("")
        expect((await read(["rev-parse", "HEAD"])).trim()).toBe(row.head)
        expect(await read(["symbolic-ref", "--quiet", "HEAD"]).catch(() => "")).toBe("")
        expect(await read(["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all"])).toBe(
          before.get(row.repo),
        )
        expect(readFileSync(join(row.repo, "private.bin"))).toEqual(Buffer.from([0, 255, 12, 8]))
        const files = fixture.checkoutFiles.get(row.repo)!
        expect([readFileSync(files.lease), readFileSync(files.lock), readFileSync(files.index)]).toEqual(files.bytes)
        expect(await read(["ls-remote", "origin", row.archiveRef])).toContain(`${row.head}\t${row.archiveRef}`)
      }
      expect(await gitIn(fixture.child!)(["rev-parse", "refs/heads/task/29600-unselected"])).not.toBe("")
      const events = (
        await readEventQueueWithChanges(createEventStore(fixture.repo, "origin", fixture.git.selection), "main")
      ).histories.get(fixture.branch)!.events
      expect(events.filter((event) => event.type === "cancelled")).toHaveLength(1)
      const ending = events.find((event) => event.type === "cancelled")!
      expect(ending.content).not.toContain("fixture-secret")
      expect(ending.content).not.toContain("fixture-user")
      for (const row of report.removed) {
        for (const value of [row.repo, row.head, row.archiveRef, row.remote]) expect(ending.content).toContain(value)
      }
    } finally {
      spy.mockRestore()
    }
  }, 60_000)
  // The existing declared-holder case covered equality only. A container cwd
  // must not hold descendant checkouts, while a real root use holds the batch.
  it.each(["ancestor", "equal", "inside"] as const)(
    "scopes a declared %s cwd to the retained checkout",
    async (kind) => {
      const fixture = await releaseWorld(true)
      const { spy } = await permitCensus()
      try {
        const output = releaseCapture(fixture.repo)
        const path =
          kind === "ancestor" ? dirname(fixture.repo) : kind === "equal" ? fixture.repo : join(fixture.repo, "work")
        output.io.liveEnvironmentUse = async () => [{ path, reason: "declared live owner" }]
        expect(await runYrdProcess([...fixture.argv, "--apply"], output.io), output.stderr()).toBe(0)
        const report = JSON.parse(output.stdout()) as ReleaseReport
        expect(report.failed).toEqual([])
        if (kind === "ancestor") {
          expect(report.kept).toEqual([])
          expect(report.removed).toHaveLength(2)
          for (const row of report.removed) {
            const git = gitIn(row.repo)
            expect(await git(["for-each-ref", `refs/heads/${row.branch}`])).toBe("")
            expect(await git(["ls-remote", "origin", row.archiveRef])).toContain(`${row.head}\t${row.archiveRef}`)
          }
        } else {
          expect(report.removed).toEqual([])
          expect(report.kept).toContainEqual(expect.objectContaining({ repo: fixture.repo, reason: "held" }))
          for (const repo of [fixture.repo, fixture.child!]) {
            expect((await gitIn(repo)(["symbolic-ref", "HEAD"])).trim()).toBe(`refs/heads/${fixture.branch}`)
            expect(await gitIn(repo)(["for-each-ref", "refs/archive/"])).toBe("")
          }
        }
        for (const files of fixture.checkoutFiles.values()) {
          expect([readFileSync(files.lease), readFileSync(files.lock), readFileSync(files.index)]).toEqual(files.bytes)
        }
      } finally {
        spy.mockRestore()
      }
    },
    30_000,
  )
  it.each(["moved", "cwd", "delegation", "host", "preview host", "failed host", "late entrant", "failed retirement"])(
    "reports %s and preserves a recoverable checkout after unsuccessful retirement",
    async (kind) => {
      const fixture = await releaseWorld()
      const { spy, permitted } = await permitCensus()
      // Native CWD admission throws a refusal; every thrown protection read is
      // failed, while declared and returned holder reasons remain kept.
      const failed =
        kind === "cwd" ||
        kind === "failed retirement" ||
        kind === "failed host" ||
        kind === "host" ||
        kind === "preview host"
      try {
        const output = releaseCapture(fixture.repo)
        let reads = 0
        let retirementLock: string | undefined
        if (kind === "moved") {
          fixture.argv[fixture.argv.indexOf("--tip") + 1] = (await fixture.git(["rev-parse", "main"])).trim()
        }
        if (kind === "cwd") {
          spy.mockResolvedValue({
            ...permitted,
            rows: [{ pid: 987654321, ppid: 0, sources: { cwd: { availability: "readable", value: fixture.repo } } }],
          } as never)
        }
        if (kind === "delegation") {
          spy.mockResolvedValue({ ...permitted, coverage: { ...permitted.coverage, complete: false } })
        }
        output.io.localBranchProtections = async () => {
          reads++
          if (kind === "host" || kind === "preview host" || (kind === "failed host" && reads === 4)) {
            throw new Error("live lease or host hold: https://fixture-user:fixture-secret@repo.invalid/retained.git")
          }
          if (kind === "failed retirement" && reads === 4) {
            const lock = (await fixture.git(["rev-parse", "--git-path", `refs/heads/${fixture.branch}.lock`])).trim()
            retirementLock = join(fixture.repo, lock)
            writeFileSync(retirementLock, "fixture competing ref transaction\n")
          }
          if (kind === "late entrant" && reads === 4) {
            expect(await fixture.git(["symbolic-ref", "--quiet", "HEAD"]).catch(() => "")).toBe("")
          }
          return {
            protections: kind === "late entrant" && reads > 3 ? ["live lease or host hold"] : [],
            evidence: [],
          }
        }
        expect(
          await runYrdProcess([...fixture.argv, ...(kind === "preview host" ? [] : ["--apply"])], output.io),
          output.stderr(),
        ).toBe(failed ? 1 : 0)
        const report = JSON.parse(output.stdout()) as ReleaseReport
        expect(output.stdout()).not.toContain("fixture-secret")
        expect(output.stdout()).not.toContain("fixture-user")
        expect(report.removed).toEqual([])
        expect(failed ? report.failed : report.kept).toHaveLength(1)
        expect(failed ? report.kept : report.failed).toEqual([])
        expect((failed ? report.failed : report.kept)[0]?.detail).toMatch(
          kind === "moved"
            ? /tip|moved/
            : kind === "cwd"
              ? /CWD/
              : kind === "delegation"
                ? /census|delegation/
                : kind === "failed retirement"
                  ? /lock|already exists/
                  : /live lease or host hold/,
        )
        expect((await fixture.git(["rev-parse", `refs/heads/${fixture.branch}`])).trim()).toBe(fixture.tip)
        if (kind === "failed retirement") {
          // Reattachment cannot verify a branch owned by another ref writer.
          // The detached pinned checkout remains recoverable through the same command.
          expect(await fixture.git(["symbolic-ref", "--quiet", "HEAD"]).catch(() => "")).toBe("")
          expect(report.failed[0]?.detail).toContain("retry")
          unlinkSync(retirementLock!)
          const retry = releaseCapture(fixture.repo)
          expect(await runYrdProcess([...fixture.argv, "--apply"], retry.io), retry.stdout() + retry.stderr()).toBe(0)
          expect((JSON.parse(retry.stdout()) as ReleaseReport).removed).toHaveLength(1)
        } else expect((await fixture.git(["symbolic-ref", "HEAD"])).trim()).toBe(`refs/heads/${fixture.branch}`)
        for (const files of fixture.checkoutFiles.values()) {
          expect([readFileSync(files.lease), readFileSync(files.lock), readFileSync(files.index)]).toEqual(files.bytes)
        }
      } finally {
        spy.mockRestore()
      }
    },
    30_000,
  )
})
