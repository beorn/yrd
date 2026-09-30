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
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  CHANGE_STATUSES,
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
  QUEUE_HEALTH_DOCUMENT,
  QUEUE_HEALTH_SCHEMA,
  watchRows,
} from "@yrd/queue-core"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { openEvents } from "gitomic/events"
import { assertEventListingFence, coreQueueCommand, openEventDetail } from "../src/queue-core-commands.ts"
import { runYrdProcess } from "../src/cli.ts"
import { issueResolver } from "../src/issue-resolver.ts"
import { SERVICE } from "../src/queue-health.ts"
import { resolveQueueLocation } from "../src/queue-location.ts"
import { eventHistoryEntries } from "../src/watch-change.ts"
import type { YrdCliIO } from "../src/types.ts"
import { workdirOf } from "../src/workdir.ts"
import type { QueueConfig } from "@yrd/queue-core"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

it("refuses future event queue and check keys by name", () => {
  const plain: QueueConfig = {
    target: { remote: "origin", branch: "main" },
    archiveAfter: "never",
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
    io: { color: false, cwd, stderr: (text) => void (stderr += text), stdout: (text) => void (stdout += text) },
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

it("reads a fresh queue-owned store without remote Git calls and refreshes once on a miss (25626)", async () => {
  const repo = await world('checks:\n  - verify: {run: "true"}\n')
  const git = gitIn(repo)
  const target = (await git(["rev-parse", "HEAD"])).trim()
  await createQueue(repo, "main", target, new Date("2026-09-22T14:00:00.000Z"))
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
    expect(await coreQueueCommand(repo, first.io, { command: "list" }, options), first.stderr()).toBe(0)
    expect(JSON.parse(first.stdout())).toMatchObject({ source: "local", asOf: expect.any(String) })
    expect(readRemoteCalls(firstTrace).verbs.fetch).toBe(1)

    process.env.GIT_TRACE2_EVENT = warmTrace
    const warm = capture(repo)
    expect(await coreQueueCommand(repo, warm.io, { command: "list" }, options), warm.stderr()).toBe(0)
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
  it("refuses an option-shaped raw issue before invoking the target resolver", async () => {
    const command = ["sh", "-c", 'touch resolver-ran; printf \'{"id":"@km/storage/26050-full"}\\n\'', "resolver"]
    const repo = await world(`issueResolver: ${JSON.stringify(command)}\n`)
    const git = gitIn(repo)
    const target = (await git(["rev-parse", "HEAD"])).trim()
    const config = await readConfig(git, target, { branch: "main", remote: "origin" })
    if (config === undefined) throw new Error("fixture lost target issue resolver")
    const resolve = issueResolver(config, repo)
    if (resolve === undefined) throw new Error("fixture lost target issue resolver")
    await expect(resolve("--repo=/x/state-model")).rejects.toThrow(/raw issue reference.*starts with '-'/u)
    expect(existsSync(join(repo, "resolver-ran"))).toBe(false)
  })

  it("uses the target's issue resolver even when the candidate changes its declaration", async () => {
    const targetResolver = ["sh", "-c", 'printf \'{"id":"@km/storage/26050-full"}\\n\'', "resolver"]
    const repo = await world(`issueResolver: ${JSON.stringify(targetResolver)}\n`)
    const git = gitIn(repo)
    await createQueue(repo, "main", (await git(["rev-parse", "HEAD"])).trim(), new Date())
    await git(["checkout", "--quiet", "-b", "task/26050"])
    writeFileSync(join(repo, ".yrd.yml"), `issueResolver: ${JSON.stringify(["sh", "-c", "exit 81", "resolver"])}\n`)
    await git(["add", ".yrd.yml"])
    await git(["commit", "--quiet", "-m", "bind short\n\nRefs: 26050"])
    await git(["commit", "--quiet", "--allow-empty", "-m", "bind full\n\nRefs: @km/storage/26050-full"])
    const run = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "submit", "--queue", "main", "--dry-run", "--json"], run.io),
      run.stderr(),
    ).toBe(0)
    expect(JSON.parse(run.stdout())).toMatchObject({ issue: "@km/storage/26050-full" })
  })

  it("refuses a missing issue with the raw reference and target resolver command", async () => {
    const repo = await world(`issueResolver: ${JSON.stringify(["sh", "-c", "exit 31", "lookup"])}\n`)
    const git = gitIn(repo)
    await createQueue(repo, "main", (await git(["rev-parse", "HEAD"])).trim(), new Date())
    await git(["checkout", "--quiet", "-b", "task/unknown"])
    await git(["commit", "--quiet", "--allow-empty", "-m", "bind\n\nRefs: 26050"])
    const run = capture(repo)
    expect(await runYrdProcess(["bun", "yrd", "submit", "--queue", "main", "--dry-run"], run.io)).toBe(2)
    expect(run.stderr()).toContain("26050")
    expect(run.stderr()).toContain("exit 31")
    expect(run.stderr()).toContain("target .yrd.yml issueResolver")
  })

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
      /cannot create event queue main at .*: the pinned commit has no \.yrd\.yml; declare checks in \.yrd\.yml at that commit before creating an event queue/u,
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
      await coreQueueCommand(repo, historical.io, { command: "list", terms: [branch] }, { json: true, queue: "main" }),
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
    await git(["checkout", "--quiet", "-b", "task/broken"])
    writeFileSync(join(repo, "broken.txt"), "cannot submit over unreadable chain\n")
    await git(["add", "broken.txt"])
    await git(["commit", "--quiet", "-m", "broken branch head"])
    const submitted = capture(repo)
    expect(await runYrdProcess(["bun", "yrd", "submit", "--queue", "main", "--json"], submitted.io)).toBe(2)
    expect(submitted.stderr()).toContain("task/broken")
    expect(submitted.stderr()).toContain("needs an open change")
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
      return (JSON.parse(output.stdout()) as { changes: readonly { branch: string }[] }).changes
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
      await coreQueueCommand(repo, listed.io, { command: "list", terms: ["direct"] }, { json: true, queue: "main" }),
    ).toBe(0)
    expect((JSON.parse(listed.stdout()) as { changes: readonly { head: string; state: string }[] }).changes).toEqual([
      expect.objectContaining({ head: direct, state: "direct" }),
    ])
    expect(listed.stdout()).not.toContain(declaration)

    const table = capture(repo)
    expect(await coreQueueCommand(repo, table.io, { command: "list", terms: ["direct"] }, { queue: "main" })).toBe(0)
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
      await coreQueueCommand(repo, accounted.io, { command: "list", terms: ["direct"] }, { json: true, queue: "main" }),
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
      await git(["commit", "--quiet", "-m", `${name} direct`])
      direct.push((await git(["rev-parse", "HEAD"])).trim())
    }
    await git(["push", "--quiet", "origin", "main"])
    const shown = capture(repo)
    expect(await coreQueueCommand(repo, shown.io, { command: "show", all: true }, { json: true, queue: "main" })).toBe(
      0,
    )
    const rows = (JSON.parse(shown.stdout()) as { changes: readonly { head: string; state: string }[] }).changes
    expect(rows.filter((row) => row.state === "direct").map((row) => row.head)).toEqual(direct)
  }, 15_000)

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
      `${join(dirname(repo), "remote.git").slice(1)}%23release%2F1.x`,
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
    const outside = mkdtempSync(join(tmpdir(), "yrd-cli-no-clone-"))
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
    const outside = mkdtempSync(join(tmpdir(), "yrd-cli-no-clone-"))
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
        expect(run.stdout()).toContain("task/topic")
        expect(run.stdout()).not.toContain("task/default")
        expect(run.stdout()).not.toContain("task/other")
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

  it("refuses a selected branch with no config, names that branch, and names the cure", async () => {
    const repo = await world()
    const run = capture(repo)

    const exit = await coreQueueCommand(repo, run.io, { command: "list" }, { queue: "main" })

    expect(exit).toBe(2)
    expect(run.stderr()).toContain("queue list needs a queue")
    expect(run.stderr()).toContain("origin/main carries no .yrd.yml")
    // The cure holds for both conditions this refusal cannot tell apart: an
    // addressed miss (re-address it) and a repository that never declared a
    // queue at all (a submodule's is its superproject's, not its own).
    expect(run.stderr()).toContain("--queue <repo>#<branch>")
    expect(run.stderr()).toContain("superproject")
  })
})
