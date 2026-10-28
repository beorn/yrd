/**
 * @reach fs-walk <fixture-only: queue declaration scans temporary remote and state fixtures>
 * @failure A command reads config from the caller's checkout or a retired
 * target: hint instead of the selected queue branch at origin, so it judges
 * against the wrong rules or guesses after malformed authority.
 * @level l2 (`coreQueueCommand` against a real remote and clone)
 * @consumer Every queue command.
 */
import { permitCensus } from "./support/permit-census.ts"
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
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import * as fs from "node:fs"
import * as removely from "removely"
import { dirname, join, resolve } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import {
  CHANGE_STATUSES,
  archivedChangesPrefix,
  readChangeEvents,
  readBranchHistory,
  MIRROR_REFRESHED_AT,
  invalidateMirrorStamp,
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
  READ_HORIZON_MS,
  watchRows,
  writeQueueEvent,
  pauseRef,
} from "@yrd/queue-core"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { GitExit } from "../../yrd-queue-core/src/git.ts"
import { outsideRepositoryRoot } from "../../../tests/support/outside-repository.ts"
import { openEvents } from "gitomic/events"
import {
  assertEventListingFence,
  coreQueueCommand,
  openEventDetail,
  readEventListing,
} from "../src/queue-core-commands.ts"
import { runYrdProcess } from "../src/cli.ts"
import { createProcess } from "@yrd/process"
import { advancedDrop, releaseRetainedCheckouts } from "../src/branch-retirement.ts"
import { archiveRefFor } from "git-super/archive-ref"
import { shellQuote } from "git-super/shell-command"
import { readEnvOpenRecord } from "../src/env-open-record.ts"
import { SERVICE } from "../src/queue-health.ts"
import { resolveQueueLocation } from "../src/queue-location.ts"
import { parseQueueAddress, queueDirectory } from "../src/address.ts"
import { eventHistoryEntries } from "../src/watch-change.ts"
import type { LocalBranchProtectionResult, YrdCliIO } from "../src/types.ts"
import type { WatchSource } from "../src/watch-pane.tsx"
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
      localBranchProtections: null,
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

async function world(config?: string, name = "repo"): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-declaration-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const repo = join(root, name)
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

    // A cached snapshot's acquisition time can precede refresh completion.
    // List and show must expose the former even when no fetch is needed.
    const stampPath = join(owned, MIRROR_REFRESHED_AT)
    const stamp = JSON.parse(readFileSync(stampPath, "utf8")) as { at: string }
    const acquiredAt = new Date(Date.parse(stamp.at) - 1_000).toISOString()
    writeFileSync(stampPath, `${JSON.stringify({ ...stamp, asOf: acquiredAt })}\n`)

    process.env.GIT_TRACE2_EVENT = warmTrace
    const warm = capture(repo)
    expect(await coreQueueCommand(repo, warm.io, { command: "list", all: true }, options), warm.stderr()).toBe(0)
    expect(JSON.parse(warm.stdout())).toMatchObject({
      asOf: acquiredAt,
      changes: [{ branch, state: "merged", merge: target }],
    })
    const shown = capture(repo)
    expect(
      await coreQueueCommand(repo, shown.io, { command: "show", branch: "task/absent" }, options),
      shown.stderr(),
    ).toBe(0)
    expect(JSON.parse(shown.stdout())).toMatchObject({ source: "local", asOf: acquiredAt })
    expect(readRemoteCalls(warmTrace).verbs).toEqual({})
    expect(readRemoteCalls(warmTrace).unreadable).toBe(0)
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT
    else process.env.GIT_TRACE2_EVENT = previousTrace
  }
  // 30419: root-v1 deadline tests cannot catch an omitted native caller bound.
  // Keep real Git for the journey; only its fetch hangs. The fixture's later
  // exit bounds the pre-fix RED without supplying the timeout under test.
  const hungGit = join(root, "hung-status-git.mjs")
  const fetchPid = join(root, "hung-fetch.pid")
  const nativeGit = Bun.which("git")
  if (nativeGit === null) throw new Error("native Git is required by the local-status journey")
  writeFileSync(
    hungGit,
    `#!${process.execPath}\n` +
      `import { writeFileSync } from "node:fs";\n` +
      `import { spawnSync } from "node:child_process";\n` +
      `const args = process.argv.slice(2);\n` +
      `if (args[0] === "fetch") {\n` +
      `  writeFileSync(${JSON.stringify(fetchPid)}, String(process.pid));\n` +
      `  setTimeout(() => { process.stderr.write("fixture fetch outlived caller deadline\\n"); process.exit(79); }, 70_000);\n` +
      `} else { process.exit(spawnSync(${JSON.stringify(nativeGit)}, args, { stdio: "inherit" }).status ?? 1); }\n`,
  )
  chmodSync(hungGit, 0o755)
  unlinkSync(join(owned, MIRROR_REFRESHED_AT))
  const failedRead = coreQueueCommand(
    repo,
    capture(repo).io,
    { command: "list" },
    {
      ...options,
      selection: { executable: hungGit, contract: "native", scope: "local", origin: "fixture" },
    },
  )
  // Observe rejection immediately, before waiting for the child to enter fetch.
  const settled = failedRead.catch((error: unknown) => error)
  await vi.waitFor(() => expect(existsSync(fetchPid)).toBe(true), { timeout: 15_000 })
  const invalidating = invalidateMirrorStamp(owned, remote)
  expect(String(await settled)).toContain("timedOut=true")
  await invalidating
  expect(existsSync(join(owned, MIRROR_REFRESHED_AT))).toBe(false)
  expect(() => process.kill(Number(readFileSync(fetchPid, "utf8")), 0)).toThrow()
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
}, 100_000)

// @failure 28925: list no longer asks the remote for the queue format when it reads a local status mirror, so the
// mirror's own check is the only refusal left for a legacy queue; no other test reaches refuseMissingEventMarker.
it("refuses a legacy queue from the local status mirror, not the remote (28925)", async () => {
  const repo = await world("{}\n")
  const git = gitIn(repo)
  const target = (await git(["rev-parse", "HEAD"])).trim()
  // The pre-event format: one ref per change, named <branch>@<head>, and no queue ref.
  const legacy = `refs/yrd/main/task/old@${target}`
  await git(["push", "--quiet", "origin", `${target}:${legacy}`])
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
  await expect(coreQueueCommand(repo, capture(repo).io, { command: "list" }, options)).rejects.toThrow(
    `queue status store ${owned} has no event marker ${queueRef("main")}; observed legacy change ref ${legacy}; use --fresh for this reading`,
  )
}, 60_000)

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
  // Direct core calls already covered closing, but could not catch a lost CLI opt-in.
  it.each(["run", "merge", "up"] as const)(
    "carries the explicit issue root through %s and stays off when absent",
    async (command) => {
      const repo = await world("checks: []\n")
      const git = gitIn(repo)
      const store = createEventStore(repo, "origin", git.selection)
      const calls = join(repo, "close-calls")
      const provider = join(import.meta.dirname, "support", "fake-issues-provider.ts")
      writeFileSync(
        join(repo, "issues.yml"),
        JSON.stringify({
          resolve: [process.execPath, provider, "resolve", "<raw>"],
          close: [process.execPath, provider, "trace", "<key>", join(repo, "output-marker"), calls, "<reason>", "<id>"],
        }),
      )
      await git(["add", "issues.yml"])
      await git(["commit", "--quiet", "-m", "declare issue provider"])
      await git(["push", "--quiet", "origin", "main"])
      await createQueue(repo, "main", (await git(["rev-parse", "HEAD"])).trim(), new Date())
      for (const enabled of [false, true]) {
        const branch = `task/${command}-${enabled}`
        const key = `issue-${command}-${enabled}`
        await git(["fetch", "--quiet", "origin", "main"])
        await git(["checkout", "--quiet", "-b", branch, "origin/main"])
        writeFileSync(join(repo, "change.txt"), branch)
        await git(["add", "change.txt"])
        await git(["commit", "--quiet", "-m", `change\n\nCloses: ${key}`])
        const submitted = capture(repo)
        expect(await runYrdProcess(["bun", "yrd", "submit", "--queue", "main"], submitted.io), submitted.stderr()).toBe(
          0,
        )
        const args =
          command === "merge" ? ["merge", branch] : ["queue", command, ...(command === "up" ? ["--interval", "0"] : [])]
        args.push("--queue", "main", "--json", ...(enabled ? ["--project-root", repo] : []))
        if (command === "up") {
          const stop = new AbortController()
          let output = ""
          let errors = ""
          await using child = createProcess({ cwd: repo })
          const running = child.run({
            argv: [process.execPath, join(import.meta.dirname, "../../../bin/yrd.ts"), ...args],
            cwd: repo,
            signal: stop.signal,
            timeoutMs: 30_000,
            onOutput: ({ stream, chunk }) => {
              const text = new TextDecoder().decode(chunk)
              output += text
              if (stream === "stderr") errors += text
            },
          })
          try {
            await vi.waitFor(
              async () => {
                expect((await readStatus(store, "main", branch)).status, output.slice(-2000)).toBe("merged")
                if (enabled) {
                  expect(
                    Object.values((await readEventQueue(store, "main")).issueEffects).some(
                      ({ effect }) => effect.issueKey === key,
                    ),
                    errors,
                  ).toBe(true)
                } else expect(output.includes("--project-root"), output.slice(-2000)).toBe(true)
              },
              { timeout: 20_000 },
            )
          } finally {
            stop.abort()
            await running
          }
        } else {
          const run = capture(repo)
          expect(await runYrdProcess(["bun", "yrd", ...args], run.io), run.stderr()).toBe(0)
          if (enabled) expect(existsSync(calls), run.stderr()).toBe(true)
        }
        expect((await readStatus(store, "main", branch)).status).toBe("merged")
        if (enabled) expect(readFileSync(calls, "utf8")).toContain(key)
        else expect(existsSync(calls)).toBe(false)
      }
    },
    60_000,
  )

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
    const queueBranch = "release"
    await git(["checkout", "--quiet", "-b", queueBranch])
    await git(["push", "--quiet", "origin", queueBranch])
    const store = createEventStore(repo, "origin", git.selection)
    const head = (await git(["rev-parse", "HEAD"])).trim()
    const at = new Date(Date.now() - 60_000)
    const queueTip = await createQueue(repo, queueBranch, head, at)
    const workdir = await workdirOf(git, {
      cwd: repo,
      address: parseQueueAddress(`${join(dirname(repo), "remote.git")}#${queueBranch}`),
    })
    const logs = join(workdir, "logs")
    const journals = ["task/sel'ected", "task/unrelated"].map((branch, index) => {
      const journal = openLog(logs, () => new Date(at.getTime() + index + 1))
      journal.write({ kind: "run", base: head })
      journal.write({ kind: "change", branch, head, decision: "failed" })
      return { branch, journal }
    })
    for (const { branch, journal } of journals) {
      await (
        await openEvents({ ...store, ref: changesRef(queueBranch, branch), writer: "yrd" })
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
          { json: true, queue: queueBranch, workdir },
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
      await coreQueueCommand(
        repo,
        bulk.io,
        { command: "show", all: true },
        { json: true, queue: queueBranch, workdir },
      ),
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
      await coreQueueCommand(
        repo,
        again.io,
        { command: "show", all: true },
        { json: true, queue: queueBranch, workdir },
      ),
      again.stderr(),
    ).toBe(0)
    const settled = JSON.parse(again.stdout()) as typeof scoped
    expect(settled.changes.map(({ branch }) => branch).sort()).toEqual(journals.map(({ branch }) => branch).sort())
    expect(settled.journal.fallbacks).toBeUndefined()
    // Prior assertions guard journal I/O scope, not live warning inspection or historical attribution (29721).
    const guidance = {
      text: "Recorded checkout: /old path; retain this explanation verbatim.\nThe command below is historical.",
      next: "git -C '/old path' show old-ref",
      inspect: "git -C '/other old path' show newer-ref",
    }
    selected.journal.write({ kind: "change", branch: selected.branch, head, reason: "change-ref-taken", ...guidance })
    selected.journal.write({
      kind: "change",
      branch: selected.branch,
      head,
      reason: "change-ref-contended",
      remote: "origin",
    })
    selected.journal.finish()
    const rawJournal = readFileSync(selected.journal.path, "utf8")
    const remote = join(dirname(repo), "remote.git")
    const queue = `${remote}#${queueBranch}`
    const remoteGit = gitIn(remote)
    const refs = await remoteGit(["for-each-ref", "--format=%(refname) %(objectname)"])
    for (const command of ["list", "detail"] as const) {
      const inspections: { argv: readonly string[]; cwd: string; recipe: string }[] = []
      const human = capture(repo)
      human.io.formatYrdCommand = (argv, cwd) => {
        const recipe = `cd ${shellQuote(cwd)} && ${shellQuote(process.execPath)} ${shellQuote(join(import.meta.dirname, "../../../bin/yrd.ts"))} ${argv.map(shellQuote).join(" ")}`
        inspections.push({ argv, cwd, recipe })
        return recipe
      }
      let text: string
      if (command === "list") {
        expect(
          await coreQueueCommand(
            repo,
            human.io,
            { command: "list", all: true, terms: [selected.branch] },
            { queue: queueBranch, workdir },
          ),
          human.stderr(),
        ).toBe(0)
        text = human.stdout()
      } else {
        const sources: WatchSource[] = []
        expect(
          await coreQueueCommand(
            repo,
            human.io,
            { command: "list", all: true, watch: true },
            {
              queue: queueBranch,
              workdir,
              watchSource: (source) => sources.push(source),
            },
          ),
          human.stderr(),
        ).toBe(0)
        expect(sources).toHaveLength(1)
        const source = sources[0]!
        const item = source.snapshot?.rows.find((item) => item.row.branch === selected.branch)
        expect(item).toBeDefined()
        expect(source.open).toBeDefined()
        const detail = await source.open!(item!)
        expect(detail.row.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining(guidance)]))
        text = detail.note ?? ""
      }
      expect(inspections.length, command).toBeGreaterThan(0)
      for (const inspection of inspections) {
        expect(inspection).toMatchObject({
          argv: ["queue", "list", "--all", "--json", selected.branch, "--queue", queue],
          cwd: repo,
        })
        expect(text).toContain(inspection.recipe)
      }
      if (command === "list") {
        expect(text).toContain("recorded guidance:")
        for (const value of Object.values(guidance)) expect(text).toContain(value)
        expect(text).toContain("The record has no explanation or inspection command")
      }
      const inspected = spawnSync("/bin/sh", ["-c", inspections[0]!.recipe], { cwd: dirname(repo), encoding: "utf8" })
      expect(inspected.status, inspected.stderr).toBe(0)
      const inspectedData = JSON.parse(inspected.stdout) as {
        changes: { branch: string; diagnostics?: readonly object[] }[]
        journal: { dir: string }
      }
      expect(inspectedData.journal.dir).toBe(logs)
      const changes = inspectedData.changes
      expect(changes).toHaveLength(1)
      expect(changes[0]!.branch).toBe(selected.branch)
      expect(changes[0]!.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining(guidance)]))
      expect(changes[0]!.diagnostics).toHaveLength(2)
      expect(await remoteGit(["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(refs)
      expect(readFileSync(selected.journal.path, "utf8")).toBe(rawJournal)
    }
  }, 15_000)

  it("keeps an equal-head duplicate inspectable in list, show and watch after contradictory endings", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const queueBranch = "release"
    await git(["checkout", "--quiet", "-b", queueBranch])
    await git(["push", "--quiet", "origin", queueBranch])
    const store = createEventStore(repo, "origin", git.selection)
    const target = (await git(["rev-parse", "HEAD"])).trim()
    const time = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000)
    const queueTip = await createQueue(repo, queueBranch, target, time(40))
    const branch = "task/twi'ce"
    await git(["checkout", "--quiet", "-b", branch])
    writeFileSync(join(repo, "twice.txt"), "twice\n")
    await git(["add", "twice.txt"])
    await git(["commit", "--quiet", "-m", "twice"])
    const head = (await git(["rev-parse", "HEAD"])).trim()
    await git(["checkout", "--quiet", queueBranch])
    await git(["merge", "--quiet", "--no-ff", "-m", "landed twice", branch])
    const merge = (await git(["rev-parse", "HEAD"])).trim()
    await git(["push", "--quiet", "origin", queueBranch])
    const workdir = await workdirOf(git, {
      cwd: repo,
      address: parseQueueAddress(`${join(dirname(repo), "remote.git")}#${queueBranch}`),
    })
    const logs = join(workdir, "logs")
    for (const minutesAgo of [29, 19]) {
      const journal = openLog(logs, () => time(minutesAgo))
      journal.write({ kind: "run", base: target })
      journal.write({ kind: "change", branch, head, decision: "merged" })
      // Only one run recorded its merge; the other must keep merge absent.
      if (minutesAgo === 29) journal.write({ kind: "merge", branch, head, commit: merge })
    }
    await (
      await openEvents({ ...store, ref: changesRef(queueBranch, branch), writer: "yrd" })
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
        { json: true, queue: queueBranch, workdir },
      ),
    ).toBe(0)
    const current = (
      JSON.parse(listed.stdout()) as { changes: readonly { head: string; duplicates?: readonly unknown[] }[] }
    ).changes
    expect(current).toEqual([expect.objectContaining({ head, duplicates: [expect.any(Object)] })])
    const shown = capture(repo)
    expect(
      await coreQueueCommand(repo, shown.io, { command: "show", branch }, { json: true, queue: queueBranch, workdir }),
    ).toBe(0)
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
        { json: true, queue: queueBranch, workdir },
      ),
    ).toBe(0)
    const runs = (JSON.parse(historical.stdout()) as { changes: readonly { merge?: string; duplicates: unknown }[] })
      .changes
    expect(runs).toHaveLength(2)
    expect(runs.map((row) => row.merge)).toEqual([undefined, merge])
    for (const row of runs) expect(row.duplicates).toEqual(proof)
    const bulk = capture(repo)
    expect(
      await coreQueueCommand(
        repo,
        bulk.io,
        { command: "show", all: true },
        { json: true, queue: queueBranch, workdir },
      ),
    ).toBe(0)
    expect(
      (JSON.parse(bulk.stdout()) as { changes: readonly { branch: string }[] }).changes.filter(
        (row) => row.branch === branch,
      ),
    ).toEqual(segments)
    // Contradictory endings keep both roots and a viewer-local inspection recipe (29721).
    writeFileSync(join(repo, "later-root.txt"), "a different retained merge root\n")
    await git(["add", "later-root.txt"])
    await git(["commit", "--quiet", "-m", "another target root"])
    const laterMerge = (await git(["rev-parse", "HEAD"])).trim()
    await git(["push", "--quiet", "origin", queueBranch])
    await (
      await openEvents({ ...store, ref: changesRef(queueBranch, branch), writer: "yrd" })
    ).append(
      [
        changeInput("opened", { queueTip, at: time(10), commit: head, by: "yrd" }),
        changeInput("merged", {
          queueTip,
          at: time(9),
          commit: laterMerge,
          reason: `observed on target at ${laterMerge}`,
        }),
      ],
      { expect: endings[0]! },
    )
    const remote = join(dirname(repo), "remote.git")
    const hosted = "https://yrd-protocol.test/org/queue.git"
    const queue = "yrd-protocol.test/org/queue#release"
    // Keep the earlier native history checks, then exercise the same printed inspections through
    // the real declared root-v1 producer. Its observation is asserted after execution from outside.
    const executable = resolve(Bun.resolveSync("git-super", import.meta.dirname), "../../bin/git-super")
    const transportConfig = join(dirname(repo), "protocol-transport.gitconfig")
    await git(["config", "--file", transportConfig, `url.${remote}.insteadOf`, hosted])
    await git(["config", `url.${remote}.insteadOf`, hosted])
    await git(["remote", "set-url", "origin", hosted])
    await git(["config", "yrd.git", JSON.stringify({ executable, contract: "root-v1" })])
    const env = { ...process.env, GIT_CONFIG_GLOBAL: transportConfig, GIT_CONFIG_NOSYSTEM: "1" }
    const inspections: { argv: readonly string[]; cwd: string; recipe: string }[] = []
    const formatCommand: NonNullable<YrdCliIO["formatYrdCommand"]> = (argv, cwd) => {
      const recipe = `cd ${shellQuote(cwd)} && ${shellQuote(process.execPath)} ${shellQuote(join(import.meta.dirname, "../../../bin/yrd.ts"))} ${argv.map(shellQuote).join(" ")}`
      inspections.push({ argv, cwd, recipe })
      return recipe
    }
    const remoteGit = gitIn(remote)
    const beforeInspection = await remoteGit(["for-each-ref", "--format=%(refname) %(objectname)"])
    for (const command of ["list", "show", "detail"] as const) {
      inspections.length = 0
      const human = capture(repo)
      human.io.formatYrdCommand = formatCommand
      let text: string
      if (command === "detail") {
        const sources: WatchSource[] = []
        expect(
          await coreQueueCommand(
            repo,
            human.io,
            { command: "list", all: true, watch: true },
            {
              queue: queueBranch,
              workdir,
              env,
              watchSource: (source) => sources.push(source),
            },
          ),
          human.stderr(),
        ).toBe(0)
        expect(sources).toHaveLength(1)
        const source = sources[0]!
        const item = source.snapshot?.rows.find(
          (item) => item.row.branch === branch && item.row.diagnostic !== undefined,
        )
        expect(item).toBeDefined()
        expect(source.open).toBeDefined()
        const detail = await source.open!(item!)
        text = detail.note ?? ""
      } else {
        expect(
          await coreQueueCommand(
            repo,
            human.io,
            command === "list" ? { command, all: true, terms: [branch] } : { command, branch },
            { queue: queueBranch, workdir, env },
          ),
          `${human.stderr()}\n${human.stdout()}`,
        ).toBe(0)
        text = human.stdout()
        expect(text).toContain("contradictory endings")
        expect(text).toContain(merge)
        expect(text).toContain(laterMerge)
      }
      expect(inspections.length, command).toBeGreaterThan(0)
      for (const inspection of inspections) {
        expect(inspection).toMatchObject({ argv: ["queue", "show", branch, "--json", "--queue", queue], cwd: repo })
        expect(text).toContain(inspection.recipe)
      }
      // Execute the displayed recipe, rather than reconstructing its argv at the assertion.
      const inspected = spawnSync("/bin/sh", ["-c", inspections[0]!.recipe], {
        cwd: dirname(repo),
        env,
        encoding: "utf8",
      })
      expect(inspected.status, inspected.stderr).toBe(0)
      // The accepted routing contract includes the declared backend, not only a filename or formatter callback.
      // Native-only fixture reads would miss a printed inspection that loses the selected root-v1 protocol.
      const inspectedData = JSON.parse(inspected.stdout) as {
        changes: readonly unknown[]
        observation: { contract: string; outcome: string }
      }
      expect(inspectedData.changes).toHaveLength(3)
      expect(inspectedData.observation).toMatchObject({ contract: "root-v1", outcome: "observed" })
      expect(inspected.stdout).toContain(merge)
      expect(inspected.stdout).toContain(laterMerge)
      expect(await remoteGit(["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(beforeInspection)
    }
  }, 25_000)

  // 25656: the event runner stores Check: evidence, and watch detail must give
  // that evidence to the existing check tabs instead of discarding it.
  // Custody bases on opened/observed-merged events do not say which checks were measured.
  it.each([true, false])(
    "projects stored event Check results into watch detail (judgment base=%s)",
    async (measured) => {
      const repo = await world('checks:\n  - unit: {run: "bun run unit"}\n')
      const git = gitIn(repo)
      const store = createEventStore(repo, "origin", git.selection)
      const head = (await git(["rev-parse", "HEAD"])).trim()
      const config = await readConfig(git, head, { branch: "main", remote: "origin" })
      if (config === undefined) throw new Error("fixture target lost its declaration")
      writeFileSync(join(repo, ".yrd.yml"), 'checks:\n  - opened-only: {run: "true"}\n')
      await git(["add", ".yrd.yml"])
      await git(["commit", "-m", "opened custody declaration"])
      const openedBase = (await git(["rev-parse", "HEAD"])).trim()
      writeFileSync(join(repo, ".yrd.yml"), 'checks:\n  - merged-only: {run: "true"}\n')
      await git(["add", ".yrd.yml"])
      await git(["commit", "-m", "merged custody declaration"])
      const mergedBase = (await git(["rev-parse", "HEAD"])).trim()
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
              {
                run: { name: "unit", result: "fail", exit: 1, durationMs: 7, log: oldLog },
                attempt: 1,
                phase: "merge",
              },
            ],
          }),
          changeInput("opened", {
            queueTip,
            at: new Date("2026-09-22T14:01:00.000Z"),
            commit: head,
            base: openedBase,
            by: "yrd",
          }),
          changeInput("verifying", { queueTip, at: new Date("2026-09-22T14:02:00.000Z"), commit: head }),
          changeInput("checking", { queueTip, at: new Date("2026-09-22T14:03:00.000Z") }),
          changeInput("merging", {
            queueTip,
            at: new Date("2026-09-22T14:04:00.000Z"),
            commit: head,
            config: config.blob,
            ...(measured
              ? {
                  base: head,
                  checks: [
                    { run: { name: "unit", result: "pass", exit: 0, durationMs: 12, log }, attempt: 1, phase: "merge" },
                  ],
                }
              : {}),
          }),
          changeInput("merged", { queueTip, at: new Date("2026-09-22T14:05:00.000Z"), commit: head, base: mergedBase }),
        ],
        { expect: null },
      )
      const selected = (await listChanges(store, "main")).get(branch)
      if (selected === undefined) throw new Error("fixture event change is missing")
      const item = watchRows(eventRows(new Map([[branch, selected]])))[0]
      if (item === undefined) throw new Error("fixture event row is missing")
      const detail = await openEventDetail(git, config, item, "main", repo, selected)
      if (measured) {
        expect(detail.checks).toEqual([
          expect.objectContaining({ name: "unit", state: "passed", log, output: "unit passed\n" }),
        ])
        expect(detail.note).toBeUndefined()
      } else {
        expect(detail.checks.map((check) => check.name)).toEqual(["unit"])
        expect(detail.note).toContain("record names no base")
      }
    },
    15_000,
  )

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
    const queueBranch = "release"
    const brokenBranch = "task/bro'ken"
    await git(["branch", queueBranch])
    await git(["push", "--quiet", "origin", queueBranch])
    const store = createEventStore(repo, "origin", git.selection)
    const head = (await git(["rev-parse", "HEAD"])).trim()
    const queueTip = await createQueue(repo, queueBranch, head, new Date("2026-09-22T14:00:00.000Z"))
    const at = new Date("2026-09-22T14:01:00.000Z")
    for (const [branch, input] of [
      ["task/healthy", changeInput("opened", { queueTip, at, commit: head, by: "yrd" })],
      ["task/old-drop", changeInput("cancelled", { queueTip, at, commit: head, reason: "dropped", by: "yrd" })],
      [brokenBranch, changeInput("failed", { queueTip, at, reason: "no opened event" })],
    ] as const) {
      await (
        await openEvents({ ...store, ref: changesRef(queueBranch, branch), writer: "yrd" })
      ).append([input], { expect: null })
    }
    const listed = capture(repo)
    expect(
      await coreQueueCommand(repo, listed.io, { command: "list", all: true }, { json: true, queue: queueBranch }),
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
          branch: brokenBranch,
          state: "invalid",
          ref: changesRef(queueBranch, brokenBranch),
          tip: expect.stringMatching(/^[0-9a-f]{40}$/u),
          error: expect.stringContaining("needs an open change"),
          diagnostic: expect.stringContaining("needs an open change"),
        }),
      ]),
    )
    const bad = capture(repo)
    expect(
      await coreQueueCommand(repo, bad.io, { command: "show", branch: brokenBranch }, { queue: queueBranch }),
      bad.stderr(),
    ).toBe(0)
    expect(bad.stdout()).toContain("diagnostic:")
    expect(bad.stdout()).toContain("needs an open change")
    const good = capture(repo)
    expect(
      await coreQueueCommand(repo, good.io, { command: "show", branch: "task/healthy" }, { queue: queueBranch }),
      good.stderr(),
    ).toBe(0)
    expect(good.stdout()).toContain("task/healthy")
    // A malformed row's raw-event remedy keeps the viewing host, checkout and queue (29721).
    const watched = capture(repo)
    const remote = join(dirname(repo), "remote.git")
    const queue = `${remote}#${queueBranch}`
    const commands: { argv: readonly string[]; cwd: string; recipe: string }[] = []
    watched.io.formatYrdCommand = (argv, cwd) => {
      const recipe = `cd ${shellQuote(cwd)} && ${shellQuote(process.execPath)} ${shellQuote(join(import.meta.dirname, "../../../bin/yrd.ts"))} ${argv.map(shellQuote).join(" ")}`
      commands.push({ argv, cwd, recipe })
      return recipe
    }
    const sources: WatchSource[] = []
    expect(
      await coreQueueCommand(
        repo,
        watched.io,
        { command: "list", all: true, watch: true },
        {
          queue: queueBranch,
          watchSource: (source) => sources.push(source),
        },
      ),
      watched.stderr(),
    ).toBe(0)
    expect(sources).toHaveLength(1)
    const source = sources[0]!
    const broken = source.snapshot?.rows.find((item) => item.row.branch === brokenBranch)
    expect(broken).toBeDefined()
    expect(source.open).toBeDefined()
    const detail = await source.open!(broken!)
    expect(commands).toEqual([
      { argv: ["queue", "show", brokenBranch, "--json", "--queue", queue], cwd: repo, recipe: expect.any(String) },
    ])
    const recipe = commands[0]!.recipe
    expect(detail.note).toBe(`Raw events: ${recipe}`)
    const remoteGit = gitIn(remote)
    const beforeInspection = await remoteGit(["for-each-ref", "--format=%(refname) %(objectname)"])
    const inspected = spawnSync("/bin/sh", ["-c", recipe], { cwd: dirname(repo), encoding: "utf8" })
    expect(inspected.status, inspected.stderr).toBe(0)
    expect(inspected.stdout).toContain(brokenBranch)
    expect(inspected.stdout).toContain("needs an open change")
    expect(await remoteGit(["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(beforeInspection)
    // Submit's preview custody names the unreadable chain out loud and keeps its anchors (27510).
    using custodyWarning = vi.spyOn(console, "warn").mockImplementation(() => {})
    await git(["checkout", "--quiet", "-b", brokenBranch])
    writeFileSync(join(repo, "broken.txt"), "cannot submit over unreadable chain\n")
    await git(["add", "broken.txt"])
    await git(["commit", "--quiet", "-m", "broken branch head"])
    const submitted = capture(repo)
    expect(await runYrdProcess(["bun", "yrd", "submit", "--queue", queueBranch, "--json"], submitted.io)).toBe(2)
    expect(submitted.stderr()).toContain(brokenBranch)
    expect(submitted.stderr()).toContain("needs an open change")
    expect(custodyWarning).toHaveBeenCalledWith(
      expect.stringContaining(`preview custody keeps ${brokenBranch}'s anchors: its change history is unreadable`),
    )
    const run = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "queue", "run", "--queue", queueBranch, "--json"], run.io),
      run.stderr(),
    ).toBe(0)
    const journal = (JSON.parse(run.stdout()) as { log: string }).log
    const records = readFileSync(journal, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(records.filter((row) => row.subject === "invalid-change-chain")).toEqual([
      expect.objectContaining({
        branch: brokenBranch,
        ref: changesRef(queueBranch, brokenBranch),
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
    const ended = new Date(now - READ_HORIZON_MS + 500)
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

  // @failure 28925: a local list read every ref three times a round. Output is identical either way, so only a count
  // of the listings catches one coming back.
  // @level l2; @consumer default queue list from a local status mirror
  it("lists every ref once per round from a local status store (28925)", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const remoteStore = createEventStore(repo, "origin", git.selection)
    const head = (await git(["rev-parse", "HEAD"])).trim()
    const config = await readConfig(git, head, { branch: "main", remote: "origin" })
    if (config === undefined) throw new Error("fixture declaration absent")
    const now = new Date()
    const old = new Date(now.getTime() - 2 * READ_HORIZON_MS)
    const queueTip = await createQueue(repo, "main", head, old)
    // One chain inside the read horizon and one outside it, so the scoped read omits a chain.
    for (const [branch, at] of [
      ["task/recent", now],
      ["task/old", old],
    ] as const) {
      await (
        await openEvents({ ...remoteStore, ref: changesRef("main", branch), writer: "yrd" })
      ).append(
        [
          changeInput("opened", { queueTip, at, commit: head, by: "yrd" }),
          changeInput("merged", { queueTip, at, commit: head }),
        ],
        { expect: null },
      )
    }
    const mirror = join(dirname(repo), "mirror")
    await gitIn(dirname(repo))(["clone", "--quiet", "--mirror", join(dirname(repo), "remote.git"), mirror])
    const backend = remoteStore.backend
    const list = backend.listRefs
    if (list === undefined) throw new Error("fixture backend cannot list refs")
    const listings: string[] = []
    const counted: typeof backend = {
      ...backend,
      listRefs: (repoPath, selection, remote) => {
        listings.push(typeof selection === "string" ? selection : "<exact names>")
        return list.call(backend, repoPath, selection, remote)
      },
    }
    const store = { repo: mirror, selection: git.selection, backend: counted }
    const workdir = await workdirOf(git, { cwd: repo })
    const listing = await readEventListing(git, config, repo, workdir, head, store, { recent: { env: process.env } })
    expect(listing.all.map((row) => row.branch)).toEqual(["task/recent"])
    expect(listings.filter((prefix) => prefix === "refs/")).toEqual(["refs/"])
  })

  // @failure 28925: the omitted-ref check is skipped only where the listing is the inventory. A listing that takes a
  // fresh inventory, as a remote store does, must still refuse a ref that vanished after its first listing.
  // @level l2; @consumer queue list read fresh from the remote
  it("refuses a ref that vanished between a remote listing and its inventory (28925)", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const remoteStore = createEventStore(repo, "origin", git.selection)
    const head = (await git(["rev-parse", "HEAD"])).trim()
    const config = await readConfig(git, head, { branch: "main", remote: "origin" })
    if (config === undefined) throw new Error("fixture declaration absent")
    const old = new Date(Date.now() - 2 * READ_HORIZON_MS)
    const queueTip = await createQueue(repo, "main", head, old)
    const ref = changesRef("main", "task/vanished")
    await (
      await openEvents({ ...remoteStore, ref, writer: "yrd" })
    ).append(
      [
        changeInput("opened", { queueTip, at: old, commit: head, by: "yrd" }),
        changeInput("merged", { queueTip, at: old, commit: head }),
      ],
      { expect: null },
    )
    const backend = remoteStore.backend
    const list = backend.listRefs
    if (list === undefined) throw new Error("fixture backend cannot list refs")
    let listings = 0
    const deleting: typeof backend = {
      ...backend,
      listRefs: async (repoPath, selection, remote) => {
        const listed = await list.call(backend, repoPath, selection, remote)
        // The chain disappears from the remote right after the round's first listing.
        if (selection === "refs/" && ++listings === 1) await git(["push", "--quiet", "origin", `:${ref}`])
        return listed
      },
    }
    const store = { ...remoteStore, backend: deleting }
    const workdir = await workdirOf(git, { cwd: repo })
    await expect(
      readEventListing(git, config, repo, workdir, head, store, { recent: { env: process.env } }),
    ).rejects.toThrow(`${ref} disappeared during event list`)
  })

  // 25655: migrated endings retain their original times. The default list's
  // read horizon must not make their full change histories unshowable.
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
  it.each([
    { compatibilityFlags: [] },
    { compatibilityFlags: ["--apply"] },
    { compatibilityFlags: ["--submodules"] },
    { compatibilityFlags: ["--submodules", "--apply"] },
  ])(
    "drop by issue covers registered stores with compatibility flags $compatibilityFlags",
    async ({ compatibilityFlags }) => {
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
      // Main's materialized child is not the private author worktree's module store.
      // The previous fixture only checked local refs in the selected checkout, missing both destinations.
      const privateRoot = join(dirname(repo), "private-author")
      await git(["worktree", "add", "--quiet", "--detach", privateRoot, "HEAD"])
      const privateGit = gitIn(privateRoot)
      await privateGit(["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--quiet"])
      const privateChild = join(privateRoot, "modules/child")
      const privateChildGit = gitIn(privateChild)
      const privateBranch = "task/1234-private"
      await privateChildGit(["branch", privateBranch, landed])
      await privateChildGit(["push", "--quiet", "origin", `refs/heads/${privateBranch}`])
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
      await childGit(["push", "--quiet", "origin", "refs/heads/task/28988-landed"])
      await childGit(["checkout", "--quiet", "-b", "task/28988-unique"])
      writeFileSync(join(child, "unique.txt"), "unpublished\n")
      await childGit(["add", "unique.txt"])
      await childGit(["commit", "--quiet", "-m", "unique work"])
      const unique = (await childGit(["rev-parse", "HEAD"])).trim()
      await childGit(["checkout", "--quiet", "task/28988-held"])
      const refs = async (read: typeof git) =>
        read(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/", "refs/archive/", "refs/yrd/"])
      const rootBranch = "task/1234-root"
      await git(["branch", rootBranch])
      await git(["push", "--quiet", "origin", `refs/heads/${rootBranch}`])
      const rootBefore = await refs(git)
      const childBefore = await refs(childGit)
      const argv = [
        "bun",
        "yrd",
        "drop",
        "--issue",
        "@example/28988-cleanup",
        ...compatibilityFlags,
        "--submitter",
        "fixture",
        "--json",
      ]
      const fixtureIssue: NonNullable<YrdCliIO["branchIssue"]> = ({ branch, recordedIssue }) => {
        const key = recordedIssue ?? /^(\d+)-/u.exec(branch.split("/").at(-1) ?? "")?.[1]
        return key === "28988" || key === "1234" ? "@example/28988-cleanup" : key
      }
      type Report = {
        inspected: string[]
        notMaterialized: unknown[]
        counts: { inspected: number; notMaterialized: number }
        excluded: { repo: string; target: number; unrelated: number; unnumbered: number }[]
        eligible: { repo: string; branch: string; head: string }[]
        removed: { repo: string; branch: string; head: string }[]
        kept: { repo: string; branch: string; reason: string }[]
        failed: { repo: string; reason: string }[]
      }
      for (const flags of [["--dry-run"]]) {
        const preview = capture(repo)
        preview.io.branchIssue = fixtureIssue
        expect(await runYrdProcess([...argv, ...flags], preview.io), preview.stderr()).toBe(0)
        const result = JSON.parse(preview.stdout()) as Report
        expect(result.counts).toEqual({
          inspected: result.inspected.length,
          notMaterialized: result.notMaterialized.length,
        })
        expect(preview.stderr()).toContain(`will inspect ${result.inspected.length} repository stores`)
        expect(result.eligible.map((row) => row.branch).sort()).toEqual([
          "exp/28988-landed",
          privateBranch,
          "task/28988-landed",
          "task/28988-moved",
        ])
        expect(result.eligible.every((row) => [child, privateChild].includes(row.repo) && row.head === landed)).toBe(
          true,
        )
        expect(result.removed).toEqual([])
        expect(result.kept).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ repo: child, branch: "task/28988-held", reason: "held" }),
            expect.objectContaining({ repo: child, branch: "task/28988-unique", reason: "unreached" }),
          ]),
        )
        expect(result.excluded).toContainEqual({ repo: child, target: 1, unrelated: 1, unnumbered: 1 })
        expect(result.kept.every((row) => /(?:28988|1234)/u.test(row.branch))).toBe(true)
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
      expect(await runYrdProcess(argv, apply.io), apply.stderr()).toBe(0)
      const result = JSON.parse(apply.stdout()) as Report
      expect(result.removed.map((row) => row.branch).sort()).toEqual([
        "exp/28988-landed",
        privateBranch,
        "task/28988-landed",
      ])
      for (const row of result.removed) {
        const owningGit = row.repo === privateChild ? privateChildGit : childGit
        expect((await owningGit(["for-each-ref", "--format=%(refname)", `refs/heads/${row.branch}`])).trim()).toBe("")
      }
      expect(
        (await childGit(["ls-remote", "origin", "refs/heads/task/28988-landed", `refs/heads/${privateBranch}`])).trim(),
      ).toBe("")
      expect(result.kept).toContainEqual(
        expect.objectContaining({ repo: child, branch: "task/28988-moved", reason: "moved" }),
      )
      expect(result.kept).toContainEqual(
        expect.objectContaining({ repo, branch: rootBranch, reason: "held", detail: expect.stringContaining("child") }),
      )
      for (const row of result.removed) {
        expect(row).toMatchObject({ custody: { kind: "published-main", ref: "refs/heads/main", tip: landed } })
      }
      const retry = capture(repo)
      retry.io.branchIssue = fixtureIssue
      expect(await runYrdProcess(argv, retry.io), retry.stderr()).toBe(0)
      expect(JSON.parse(retry.stdout())).toMatchObject({
        removed: [],
        kept: expect.arrayContaining([expect.objectContaining({ repo, branch: rootBranch, reason: "held" })]),
      })
      expect((await childGit(["rev-parse", "refs/heads/task/28988-unique"])).trim()).toBe(unique)
      expect((await childGit(["rev-parse", "refs/heads/task/28988-held"])).trim()).toBe(landed)
      expect(await refs(git)).toBe(rootBefore)
      // No component cleanup is misrepresented as a dropped root-queue change.
      expect((await listChanges(createEventStore(repo, "origin", git.selection), "main")).size).toBe(0)
      // Missing materialization must name the child, never discover and mutate the root through Git's upward search.
      const laterBranch = "task/1234-after-discovery"
      await privateChildGit(["branch", laterBranch, landed])
      const privateBeforeFailure = await refs(privateChildGit)
      fs.renameSync(join(child, ".git"), join(child, ".git-unavailable"))
      try {
        const missing = capture(repo)
        expect(await runYrdProcess(argv, missing.io), missing.stderr()).toBe(1)
        expect((JSON.parse(missing.stdout()) as Report).failed).toContainEqual(
          expect.objectContaining({ repo: child, reason: "unreadable" }),
        )
        expect(await refs(git)).toBe(rootBefore)
        expect(await refs(privateChildGit)).toBe(privateBeforeFailure)
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
    },
    60_000,
  )

  /** @failure Store discovery repeats remote reads or never retires a root after its children finish.
   * @level l3 @consumer Issue retirement's root queue arm, including exact ending-event custody
   * The private-store fixture above always keeps a child, so it never reaches root retirement.
   */
  it.each(["ended", "draft", "retry"] as const)(
    "retires children before the %s root with its real ending custody",
    async (mode) => {
      const repo = await world("checks: []\n")
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
      const rootTip = (await git(["rev-parse", "HEAD"])).trim()
      const queueTip = await createQueue(repo, "main", rootTip, new Date())
      const child = join(repo, "child")
      const childGit = gitIn(child)
      const childTip = (await childGit(["rev-parse", "HEAD"])).trim()
      const rootBranch = "task/1234-root"
      const childBranch = "task/1234-child"
      const issue = "@example/1234-retirement"
      await git(["branch", rootBranch, rootTip])
      await git(["push", "--quiet", "origin", rootBranch])
      await childGit(["branch", childBranch, childTip])
      await childGit(["push", "--quiet", "origin", childBranch])
      if (mode === "ended") {
        const chain = await openEvents({
          ...createEventStore(repo, "origin", git.selection),
          ref: changesRef("main", rootBranch),
          writer: "fixture",
        })
        await chain.append(
          [
            changeInput("opened", { queueTip, at: new Date(), commit: rootTip, by: "fixture", issue }),
            changeInput("merged", { queueTip, at: new Date(), commit: rootTip }),
          ],
          { expect: null },
        )
      }
      const argv = ["bun", "yrd", "drop", "--issue", issue, "--submodules", "--submitter", "fixture", "--json"]
      let held = mode === "retry"
      const run = async (flags: string[], format: "json" | "human" = "json") => {
        const out = capture(repo)
        out.io.branchIssue = ({ branch, recordedIssue }) =>
          recordedIssue ?? (branch.startsWith("task/1234-") ? issue : undefined)
        out.io.localBranchProtections = async ({ branch }) => ({
          protections: held && branch === childBranch ? ["fixture child hold"] : [],
          evidence: [],
        })
        const args = format === "json" ? argv : argv.filter((arg) => arg !== "--json")
        const exit = await runYrdProcess([...args, ...flags], out.io)
        return { exit, out }
      }
      let retiredWhileGone: { exit: number; stdout: string; stderr: string } | undefined
      if (mode === "ended") {
        const measure = async (name: string) => {
          const trace = join(dirname(repo), name)
          mkdirSync(trace)
          const previous = process.env.GIT_TRACE2_EVENT
          try {
            process.env.GIT_TRACE2_EVENT = trace
            const preview = await run(["--dry-run"])
            expect(preview.exit, preview.out.stderr()).toBe(0)
            const calls = readRemoteCalls(trace)
            expect(calls.unreadable).toBe(0)
            expect(calls.verbs["ls-remote"]).toBeGreaterThan(0)
            return calls.verbs
          } finally {
            if (previous === undefined) delete process.env.GIT_TRACE2_EVENT
            else process.env.GIT_TRACE2_EVENT = previous
          }
        }
        const before = await measure("one-store-trace")
        for (const name of ["private-one", "private-two"]) {
          const author = join(dirname(repo), name)
          await git(["worktree", "add", "--quiet", "--detach", author, "HEAD"])
          await gitIn(author)(["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--quiet"])
        }
        const after = await measure("three-store-trace")
        expect(after["ls-remote"]).toBe(before["ls-remote"])
        if (before.fetch === undefined) throw new Error("one-store trace lacks expected fetch calls")
        // A warm fetched queue ref can save a read; extra stores must never add one.
        expect(after.fetch).toBeLessThanOrEqual(before.fetch)

        // No checkout pointer and no module store means there is no private branch here.
        const absent = join(dirname(repo), "unmaterialized-author")
        await git(["worktree", "add", "--quiet", "--detach", absent, "HEAD"])
        const preview = await run(["--dry-run"])
        expect(preview.exit, preview.out.stderr()).toBe(0)
        expect(JSON.parse(preview.out.stdout())).toMatchObject({
          failed: [],
          notMaterialized: [],
        })
        const human = await run(["--dry-run"], "human")
        expect(human.exit, human.out.stderr()).toBe(0)
        expect(human.out.stdout()).not.toContain(join(absent, "child"))

        // A detached registered root whose directory is already gone does not fail --apply.
        // Measured: both issue branches are removed, and the gone row names the path.
        const missing = join(dirname(repo), "prunable-author")
        const saved = `${missing}-saved`
        await git(["worktree", "add", "--quiet", "--detach", missing, "HEAD"])
        fs.renameSync(missing, saved)
        try {
          const stopped = await run(["--apply"])
          const body = JSON.parse(stopped.out.stdout()) as {
            failed: unknown[]
            gone?: { path: string; adminDirectoryExists?: boolean }[]
            removed: { branch: string; archiveRef?: string }[]
            kept: unknown[]
          }
          expect(stopped.exit, stopped.out.stderr()).toBe(0)
          expect(body.failed).toEqual([])
          expect(body.kept).toEqual([])
          expect(body.gone ?? []).not.toContainEqual(expect.objectContaining({ path: missing }))
          expect(body.removed.map((row) => row.branch)).toEqual([childBranch, rootBranch])
          retiredWhileGone = { exit: stopped.exit, stdout: stopped.out.stdout(), stderr: stopped.out.stderr() }
        } finally {
          fs.renameSync(saved, missing)
        }
      }
      if (held) {
        const stopped = await run(["--apply"])
        expect(stopped.exit, stopped.out.stderr()).toBe(0)
        expect(JSON.parse(stopped.out.stdout())).toMatchObject({
          removed: [],
          kept: expect.arrayContaining([
            expect.objectContaining({ branch: childBranch, reason: "held" }),
            expect.objectContaining({ branch: rootBranch, reason: "held", detail: expect.stringContaining("child") }),
          ]),
        })
        held = false
      }
      const applied = retiredWhileGone
        ? {
            exit: retiredWhileGone.exit,
            out: { stdout: () => retiredWhileGone.stdout, stderr: () => retiredWhileGone.stderr },
          }
        : await run(["--apply"])
      expect(applied.exit, applied.out.stderr()).toBe(0)
      const result = JSON.parse(applied.out.stdout()) as {
        removed: {
          branch: string
          archiveRef?: string
          custody?: { kind: string; ref: string; tip: string; archive?: string }
        }[]
        failed: unknown[]
        kept: unknown[]
      }
      expect(result.failed).toEqual([])
      expect(result.kept).toEqual([])
      expect(result.removed.map((row) => row.branch)).toEqual([childBranch, rootBranch])
      const row = result.removed.find((entry) => entry.branch === rootBranch)
      expect(row).toMatchObject({ custody: { kind: "event", ref: changesRef("main", rootBranch) } })
      if (row?.custody === undefined) throw new Error("root receipt lacks custody")
      const state = (await listChanges(createEventStore(repo, "origin", git.selection), "main")).get(rootBranch)
      expect(state).toMatchObject({ status: mode === "ended" ? "merged" : "cancelled", commit: rootTip })
      expect(state?.ending?.id).toBe(row.custody.tip)
      expect((await git(["for-each-ref", "--format=%(refname)", `refs/heads/${rootBranch}`])).trim()).toBe("")
      expect((await childGit(["for-each-ref", "--format=%(refname)", `refs/heads/${childBranch}`])).trim()).toBe("")
      expect((await git(["ls-remote", "origin", `refs/heads/${rootBranch}`])).trim()).toBe("")
      expect((await childGit(["ls-remote", "origin", `refs/heads/${childBranch}`])).trim()).toBe("")
    },
    60_000,
  )

  /** @failure Applying issue cleanup while the issue branch is checked out in a vanished worktree fails the run.
   * @level l3 @consumer Authors whose own worktree was removed without git worktree remove
   * @testonly none
   */
  it("applies issue cleanup when the checked-out worktree has vanished", async () => {
    const repo = await world("checks: []\n")
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
    const rootTip = (await git(["rev-parse", "HEAD"])).trim()
    const queueTip = await createQueue(repo, "main", rootTip, new Date())
    const child = join(repo, "child")
    const childGit = gitIn(child)
    const childTip = (await childGit(["rev-parse", "HEAD"])).trim()
    const rootBranch = "task/1234-root"
    const childBranch = "task/1234-child"
    const issue = "@example/1234-retirement"
    await git(["branch", rootBranch, rootTip])
    await git(["push", "--quiet", "origin", rootBranch])
    await childGit(["branch", childBranch, childTip])
    await childGit(["push", "--quiet", "origin", childBranch])
    const chain = await openEvents({
      ...createEventStore(repo, "origin", git.selection),
      ref: changesRef("main", rootBranch),
      writer: "fixture",
    })
    await chain.append(
      [
        changeInput("opened", { queueTip, at: new Date(), commit: rootTip, by: "fixture", issue }),
        changeInput("merged", { queueTip, at: new Date(), commit: rootTip }),
      ],
      { expect: null },
    )
    const attached = join(dirname(repo), "attached-author")
    await git(["worktree", "add", "--quiet", attached, rootBranch])
    const saved = `${attached}-saved`
    fs.renameSync(attached, saved)
    try {
      const out = capture(repo)
      out.io.branchIssue = ({ branch, recordedIssue }) =>
        recordedIssue ?? (branch.startsWith("task/1234-") ? issue : undefined)
      out.io.localBranchProtections = async () => ({ protections: [], evidence: [] })
      const exit = await runYrdProcess(
        ["bun", "yrd", "drop", "--issue", issue, "--submodules", "--submitter", "fixture", "--json", "--apply"],
        out.io,
      )
      const body = JSON.parse(out.stdout()) as {
        failed: unknown[]
        gone?: { path: string }[]
        removed: { branch: string; archiveRef?: string; reason?: string }[]
        kept: { branch: string; reason: string; detail?: string }[]
      }
      const brief = {
        exit,
        stderr: out.stderr(),
        failed: body.failed,
        gone: body.gone,
        removed: body.removed.map((row) => ({ branch: row.branch, reason: row.reason, archiveRef: row.archiveRef })),
        kept: body.kept.map((row) => ({ branch: row.branch, reason: row.reason, detail: row.detail })),
      }
      expect(exit, JSON.stringify(brief)).toBe(0)
      expect(body.failed).toEqual([])
      expect(body.gone ?? []).not.toContainEqual(expect.objectContaining({ path: attached }))
      expect(body.removed, JSON.stringify(body.kept)).toContainEqual(expect.objectContaining({ branch: childBranch }))
      expect(body.kept, JSON.stringify(body.kept)).toContainEqual(
        expect.objectContaining({
          branch: rootBranch,
          reason: "held",
          detail: expect.stringContaining(attached),
        }),
      )
    } finally {
      if (existsSync(saved)) fs.renameSync(saved, attached)
    }
  }, 60_000)

  /** @failure Default issue cleanup omits a store-only population or continues after a retirement failure.
   * @level l3 @consumer Authors retiring root-only, component-only or shared issue branches
   * Existing journeys always have both populations and fail during discovery, before any retirement succeeds.
   */
  it.each(["root-only", "component-only", "both", "later-failure"] as const)(
    "default issue cleanup handles %s with failure-stop",
    async (population) => {
      const repo = await world("checks: []\n")
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
      const rootTip = (await git(["rev-parse", "HEAD"])).trim()
      await createQueue(repo, "main", rootTip, new Date())
      const child = join(repo, "child")
      const childGit = gitIn(child)
      const childTip = (await childGit(["rev-parse", "HEAD"])).trim()
      const rootBranch = "task/1234-root"
      const childBranches =
        population === "root-only"
          ? []
          : population === "later-failure"
            ? ["task/1234-a", "task/1234-b", "task/1234-c"]
            : ["task/1234-child"]
      const rootBranches = population === "component-only" ? [] : [rootBranch]
      for (const branch of rootBranches) {
        await git(["branch", branch, rootTip])
        await git(["push", "--quiet", "origin", branch])
      }
      for (const branch of childBranches) {
        await childGit(["branch", branch, childTip])
        await childGit(["push", "--quiet", "origin", branch])
      }
      const issue = "@example/1234-retirement"
      const argv = ["bun", "yrd", "drop", "--issue", issue, "--submitter", "fixture", "--json"]
      const run = async (preview: boolean) => {
        const out = capture(repo)
        out.io.branchIssue = ({ branch, recordedIssue }) =>
          recordedIssue ?? (branch.startsWith("task/1234-") ? issue : undefined)
        out.io.localBranchProtections = async ({ branch }) => {
          if (!preview && population === "later-failure" && branch === "task/1234-b") {
            throw new Error("fixture retirement read failed for task/1234-b")
          }
          return { protections: [], evidence: [] }
        }
        const exit = await runYrdProcess([...argv, ...(preview ? ["--dry-run"] : [])], out.io)
        const report = JSON.parse(out.stdout()) as {
          inspected: string[]
          eligible: { repo: string; branch: string }[]
          removed: { repo: string; branch: string; head: string }[]
          kept: { branch: string; reason: string }[]
          failed: { repo: string; branch: string; detail: string }[]
        }
        return { exit, out, report }
      }
      const preview = await run(true)
      expect(preview.exit, preview.out.stderr()).toBe(0)
      expect(preview.report.inspected).toEqual(expect.arrayContaining([repo, child]))
      expect(preview.report.eligible.map(({ repo: store, branch }) => [store, branch])).toEqual([
        ...childBranches.map((branch) => [child, branch]),
        ...rootBranches.map((branch) => [repo, branch]),
      ])
      expect(preview.report.removed).toEqual([])
      const applied = await run(false)
      expect(applied.exit, applied.out.stderr()).toBe(population === "later-failure" ? 1 : 0)
      const removed = population === "later-failure" ? ["task/1234-a"] : [...childBranches, ...rootBranches]
      expect(applied.report.removed.map(({ branch }) => branch)).toEqual(removed)
      for (const row of applied.report.removed) {
        const owner = row.repo === repo ? git : childGit
        expect((await owner(["for-each-ref", "--format=%(refname)", `refs/heads/${row.branch}`])).trim()).toBe("")
        expect((await owner(["ls-remote", "origin", `refs/heads/${row.branch}`])).trim()).toBe("")
      }
      if (population === "later-failure") {
        expect(applied.report.failed).toContainEqual(
          expect.objectContaining({
            repo: child,
            branch: "task/1234-b",
            detail: expect.stringContaining("fixture retirement read failed"),
          }),
        )
        expect(applied.report.kept).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ branch: "task/1234-c", reason: "held" }),
            expect.objectContaining({ branch: rootBranch, reason: "held" }),
          ]),
        )
        for (const branch of ["task/1234-b", "task/1234-c"]) {
          expect((await childGit(["rev-parse", `refs/heads/${branch}`])).trim()).toBe(childTip)
          expect((await childGit(["ls-remote", "origin", `refs/heads/${branch}`])).trim().split(/\s+/u)[0]).toBe(
            childTip,
          )
        }
        expect((await git(["rev-parse", `refs/heads/${rootBranch}`])).trim()).toBe(rootTip)
      } else expect(applied.report.failed).toEqual([])
    },
    60_000,
  )

  /** @failure A recorded root issue is discarded for same-named components, or key mismatches disappear from the receipt.
   * 31060: `yrd drop --issue 30759` kept a branch recorded as `#30759` as a mismatch although the project's
   * declared resolve verb names one issue for both spellings ("resolved" mode).
   * @level l3 @consumer The root and expanded issue retirement commands with the host's recorded-or-numeric policy
   * The ending-custody fixture above maps every fallback to its canonical key, hiding the lost root record.
   */
  it.each(["recorded", "unrecorded", "mismatch", "resolved"] as const)(
    "selects one same-named retirement set with %s issue evidence",
    async (mode) => {
      type Report = {
        mode: string
        eligible: { repo?: string; branch: string }[]
        kept: { branch: string; reason: string; detail?: string }[]
        removed: unknown[]
        failed: unknown[]
      }
      const repo = await world("checks: []\n")
      const seed = await world()
      const git = gitIn(repo)
      const childNames = ["first", "second"]
      const children = childNames.map((name) => join(repo, name))
      for (const childName of childNames) {
        await git([
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          "--quiet",
          join(dirname(seed), "remote.git"),
          childName,
        ])
      }
      const branch = "task/1234-shared"
      const recordedIssue = "@example/1234-retirement"
      if (mode === "resolved") {
        // The project's provider, read from main, names one issue for the given and the recorded spelling.
        writeFileSync(
          join(repo, "issues.yml"),
          JSON.stringify({
            resolve: [
              "sh",
              "-c",
              `case "$1" in 1234|${recordedIssue}) printf '{"keys":["issue-1234"]}\\n';; *) printf '{"keys":[]}\\n';; esac`,
              "resolve",
              "<raw>",
            ],
          }),
        )
        await git(["add", "issues.yml"])
      }
      await git(["commit", "--quiet", "-am", "register components"])
      await git(["push", "--quiet", "origin", "main"])
      const rootTip = (await git(["rev-parse", "HEAD"])).trim()
      const queueTip = await createQueue(repo, "main", rootTip, new Date())
      if (mode !== "unrecorded") {
        await git(["branch", branch, rootTip])
        await git(["push", "--quiet", "origin", branch])
        const chain = await openEvents({
          ...createEventStore(repo, "origin", git.selection),
          ref: changesRef("main", branch),
          writer: "fixture",
        })
        await chain.append(
          [
            changeInput("opened", { queueTip, at: new Date(), commit: rootTip, by: "fixture", issue: recordedIssue }),
            changeInput("merged", { queueTip, at: new Date(), commit: rootTip }),
          ],
          { expect: null },
        )
      }
      for (const child of children) {
        const childGit = gitIn(child)
        await childGit(["branch", branch])
        await childGit(["push", "--quiet", "origin", branch])
      }
      const run = async (issue: string, expanded = true, human = false) => {
        const out = capture(repo)
        out.io.branchIssue = ({ branch: name, recordedIssue: recorded }) => recorded ?? /^task\/(\d+)-/u.exec(name)?.[1]
        const exit = await runYrdProcess(
          [
            "bun",
            "yrd",
            "drop",
            "--issue",
            issue,
            "--dry-run",
            ...(expanded ? ["--submodules"] : []),
            ...(human ? [] : ["--json"]),
          ],
          out.io,
        )
        expect(exit, out.stderr()).toBe(0)
        return out.stdout()
      }
      if (mode === "recorded") {
        const report = JSON.parse(await run(recordedIssue)) as Report
        expect(report).toMatchObject({ removed: [], failed: [], kept: [] })
        expect(report.eligible.map((row) => row.repo).sort()).toEqual([repo, ...children].sort())
      } else if (mode === "unrecorded") {
        const numeric = JSON.parse(await run("1234")) as Report
        expect(numeric).toMatchObject({ removed: [], failed: [], kept: [] })
        expect(numeric.eligible.map((row) => row.repo).sort()).toEqual(children.sort())
        const canonical = JSON.parse(await run(recordedIssue)) as Report
        expect(canonical).toMatchObject({ eligible: [], removed: [], failed: [], kept: [] })
        expect(canonical.mode).toContain(`No branches matched issue key "${recordedIssue}"`)
        expect(await run(recordedIssue, true, true)).toContain(`No branches matched issue key "${recordedIssue}"`)
      } else if (mode === "resolved") {
        const report = JSON.parse(await run("1234")) as Report
        expect(report).toMatchObject({ removed: [], failed: [], kept: [] })
        expect(report.eligible.map((row) => row.repo).sort()).toEqual([repo, ...children].sort())
      } else {
        const expanded = JSON.parse(await run("1234")) as Report
        expect(expanded).toMatchObject({ eligible: [], removed: [], failed: [] })
        expect(expanded.kept).toHaveLength(3)
        for (const row of expanded.kept) {
          expect(row).toMatchObject({ branch, reason: "mismatch", detail: expect.stringContaining(recordedIssue) })
          expect(row.detail).toContain("1234")
        }
        const rootOnly = JSON.parse(await run("1234", false)) as Report
        expect(rootOnly).toMatchObject({ eligible: [], removed: [], failed: [] })
        expect(rootOnly.mode).toContain('No branches matched issue key "1234"')
        expect(rootOnly.kept).toEqual(
          [repo, ...children].map((store) =>
            expect.objectContaining({
              repo: store,
              branch,
              reason: "mismatch",
              detail: expect.stringContaining(recordedIssue),
            }),
          ),
        )
        // Receipt-only mismatches cannot become a child hold on another selected root.
        const unrelated = "task/1234-unrecorded"
        await git(["branch", unrelated, rootTip])
        const mixed = JSON.parse(await run("1234")) as Report
        expect(mixed).toMatchObject({ removed: [], failed: [] })
        expect(mixed.eligible.map((row) => row.branch)).toEqual([unrelated])
        expect(mixed.kept).toHaveLength(3)
      }
      expect((await git(["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`])).trim()).toBe(
        mode === "unrecorded" ? "" : `refs/heads/${branch}`,
      )
      for (const child of children) {
        expect((await gitIn(child)(["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`])).trim()).toBe(
          `refs/heads/${branch}`,
        )
      }
    },
    60_000,
  )

  /** @failure A root-only issue drop never inspects a component that only the issue's root change names.
   * 31081: the named component set compared raw issue strings, so a root change recorded as
   * `@example/1234-retirement`, which the declared resolve verb names as issue 1234, named nothing.
   * @level l3 @consumer The root issue retirement command naming components from the issue's root changes
   * The 31060 "resolved" mode above reaches its components through the author checkout's own tree, never this set.
   */
  it.each(["moved", "landed", "unrelated"] as const)(
    "an issue drop inspects the component a second-spelling root change %s (31081)",
    async (mode) => {
      const repo = await world("checks: []\n")
      const seed = await world()
      const git = gitIn(repo)
      const branch = "task/1234-shared"
      // "unrelated": a spelling the resolver does not name as 1234, so nothing of it may be selected.
      const recordedIssue = mode === "unrelated" ? "@example/9999-other" : "@example/1234-retirement"
      writeFileSync(
        join(repo, "issues.yml"),
        JSON.stringify({
          resolve: [
            "sh",
            "-c",
            `case "$1" in 1234|@example/1234-retirement) printf '{"keys":["issue-1234"]}\\n';; *) printf '{"keys":[]}\\n';; esac`,
            "resolve",
            "<raw>",
          ],
        }),
      )
      await git(["add", "issues.yml"])
      await git(["commit", "--quiet", "-m", "declare resolve"])
      await git(["push", "--quiet", "origin", "main"])
      const queueTip = await createQueue(repo, "main", (await git(["rev-parse", "HEAD"])).trim(), new Date())
      // The issue's root branch adds the component `third` and pins its work there; main never carries `third`.
      await git(["checkout", "--quiet", "-b", branch])
      await git([
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "--quiet",
        join(dirname(seed), "remote.git"),
        "third",
      ])
      const third = join(repo, "third")
      const thirdGit = gitIn(third)
      await thirdGit(["checkout", "--quiet", "-b", branch])
      writeFileSync(join(third, "work.txt"), "work")
      await thirdGit(["add", "work.txt"])
      await thirdGit(["commit", "--quiet", "-m", "component work"])
      await thirdGit(["push", "--quiet", "origin", branch])
      const thirdTip = (await thirdGit(["rev-parse", "HEAD"])).trim()
      await git(["add", "third"])
      await git(["commit", "--quiet", "-m", "root adds the component"])
      const rootBranchTip = (await git(["rev-parse", "HEAD"])).trim()
      // Back on main, the checkout of `third` stays on disk, as a seat's does after switching branches.
      await git(["checkout", "--quiet", "main"])
      const chain = await openEvents({
        ...createEventStore(repo, "origin", git.selection),
        ref: changesRef("main", branch),
        writer: "fixture",
      })
      const opened = changeInput("opened", {
        queueTip,
        at: new Date(),
        commit: rootBranchTip,
        by: "fixture",
        issue: recordedIssue,
      })
      if (mode !== "landed") await chain.append([opened], { expect: null })
      else {
        // Landed and retired: only the merged event's pin names the component.
        const merged = changeInput("merged", {
          queueTip,
          at: new Date(),
          commit: rootBranchTip,
          landedGitlinks: [{ path: "third", target: thirdTip }],
        })
        await chain.append([opened, merged], { expect: null })
        await git(["branch", "--quiet", "-D", branch])
      }
      const out = capture(repo)
      out.io.branchIssue = ({ branch: name, recordedIssue: recorded }) => recorded ?? /^task\/(\d+)-/u.exec(name)?.[1]
      const exit = await runYrdProcess(["bun", "yrd", "drop", "--issue", "1234", "--dry-run", "--json"], out.io)
      expect(exit, out.stderr()).toBe(0)
      const report = JSON.parse(out.stdout()) as {
        inspected: string[]
        eligible: { repo: string; branch: string }[]
        kept: { repo: string; branch: string }[]
      }
      const selected = mode === "unrelated" ? [] : [expect.objectContaining({ branch })]
      expect(report.inspected.sort(), out.stdout()).toEqual(mode === "unrelated" ? [repo] : [repo, third].sort())
      expect([...report.eligible, ...report.kept].filter((row) => row.repo === third)).toEqual(selected)
    },
    60_000,
  )

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

  /** @failure A refused local preview asks for an already supplied issue or prints a command that loses host/authority arguments.
   * @level l3 @consumer A caller copying the refusal's exact direct-apply command
   * Other custody fixtures call valid argv; none copies a refused preview through a host renderer and executes the cure.
   */
  it.each(["root", "component"])(
    "a local preview refusal supplies the exact host-rendered %s local-delete command",
    async (mode) => {
      const root = await world("checks: []\n")
      const rootGit = gitIn(root)
      let repo = root
      if (mode === "component") {
        const seed = await world()
        await rootGit([
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          "--quiet",
          join(dirname(seed), "remote.git"),
          "child with spaces",
        ])
        await rootGit(["commit", "--quiet", "-am", "register child"])
        await rootGit(["push", "--quiet", "origin", "main"])
        repo = join(root, "child with spaces")
      }
      const git = gitIn(repo)
      await createQueue(root, "main", (await rootGit(["rev-parse", "HEAD"])).trim(), new Date())
      const branch = "task/local-retirement"
      const issue = "@example/local-retirement"
      const reason = "finish unsubmitted local work"
      await git(["checkout", "--quiet", "-b", branch])
      writeFileSync(join(repo, "local.txt"), "retain through origin custody\n")
      await git(["add", "local.txt"])
      await git([
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@test.invalid",
        "commit",
        "--quiet",
        "-m",
        `local work\n\nRefs: ${issue}`,
      ])
      const tip = (await git(["rev-parse", "HEAD"])).trim()
      await git(["checkout", "--quiet", "main"])
      const out = capture(root)
      let recipe: string | undefined
      const entry = fileURLToPath(new URL("../../../bin/yrd", import.meta.url))
      out.io.formatYrdCommand = (argv, cwd) => {
        recipe = "cd " + shellQuote(cwd) + " && " + [process.execPath, entry, ...argv].map(shellQuote).join(" ")
        return recipe
      }
      expect(
        await runYrdProcess(
          [
            "bun",
            "yrd",
            "drop",
            branch,
            "--local",
            "--tip",
            tip,
            "--issue",
            issue,
            "--queue",
            "main",
            "--submitter",
            "fixture",
            "--reason",
            reason,
            "--dry-run",
            ...(mode === "component" ? ["--discard"] : []),
            "--json",
          ],
          out.io,
        ),
      ).toBe(2)
      expect(out.stderr()).toContain(
        mode === "component" ? "--local --discard has no preview" : "--local has no preview",
      )
      expect(out.stderr()).toContain(
        mode === "component" ? "keeps no Git object custody" : "writes the event that keeps the tip at origin",
      )
      expect(out.stderr()).not.toContain("require drop --issue")
      if (recipe === undefined) throw new Error("refusal did not use the host renderer")
      expect(out.stderr()).toContain(recipe)
      expect(recipe).toContain(`cd ${shellQuote(repo)} &&`)
      expect(recipe).not.toContain("--dry-run")
      expect(recipe).toContain(["--reason", reason].map(shellQuote).join(" "))
      expect((await git(["rev-parse", "refs/heads/" + branch])).trim()).toBe(tip)
      const applied = spawnSync("/bin/sh", ["-c", recipe], {
        cwd: repo,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      })
      expect(applied.status, applied.stderr).toBe(0)
      const report = JSON.parse(applied.stdout) as { removed: { branch: string; archiveRef?: string }[] }
      expect(report.removed).toEqual([expect.objectContaining({ branch })])
      const row = report.removed[0]
      if (row === undefined) throw new Error("copied command removed no branch")
      expect(row.archiveRef).toBeUndefined()
      expect((await git(["for-each-ref", "--format=%(refname)", "refs/heads/" + branch])).trim()).toBe("")
      if (mode === "component") {
        const logs = join(await workdirOf(rootGit), "logs")
        const rows = readdirSync(logs)
          .filter((name) => name.endsWith(".jsonl"))
          .flatMap((name) => readRunLog(logs, name.slice(0, -6)))
        expect(rows).toContainEqual(
          expect.objectContaining({ intent: "local-discard", repo, branch, head: tip, actor: "fixture", issue }),
        )
        expect(await git(["for-each-ref", "refs/yrd/", "refs/archive/"])).toBe("")
        return
      }
      const history = (await readBranchHistory(createEventStore(repo, "origin", git.selection), "main", branch)).history
      expect(history?.events.at(-1)?.links).toContain(tip)
      expect(history?.state.issue).toBe(issue)
      expect(history?.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ content: reason, props: expect.arrayContaining([["By", "fixture"]]) }),
        ]),
      )
    },
    60_000,
  )

  /** @failure An inapplicable --discard silently selects ordinary drop, origin retirement, issue cleanup, or checkout release.
   * @level l1 @consumer A caller expressing explicit local component-loss intent
   */
  it.each([
    ["task/30704", "--discard"],
    ["task/30704", "--discard", "--retire", "--tip", "a".repeat(40), "--reason", "reviewed"],
    ["--issue", "@i/10-yrd/30704-component-branch-owner-delete", "--discard"],
    ["task/30704", "--local", "--discard", "--retire", "--tip", "a".repeat(40), "--reason", "reviewed"],
    [
      "task/30704",
      "--local",
      "--discard",
      "--release-checkout",
      "--tip",
      "a".repeat(40),
      "--issue",
      "@i/10-yrd/30704-component-branch-owner-delete",
      "--reason",
      "reviewed",
    ],
  ])("rejects inapplicable discard options %j", async (...args) => {
    const out = capture(outsideRepositoryRoot())
    expect(await runYrdProcess(["bun", "yrd", "drop", ...args, "--json"], out.io)).toBe(2)
    expect(out.stderr()).toContain(
      "--discard requires drop <branch> --local --tip <full-commit>; it cannot combine with --retire or --release-checkout",
    )
    expect(out.stdout()).toBe("")
  })

  /** @failure A declared queue silently converts explicit component-loss intent into event-retaining root cleanup.
   * @level l2 @consumer A caller using --discard in a queue-owning repository
   */
  it("rejects discard in a declared queue without ordinary root cleanup", async () => {
    const repo = await world("checks: []\n")
    const git = gitIn(repo)
    const tip = (await git(["rev-parse", "HEAD"])).trim()
    await createQueue(repo, "main", tip, new Date())
    const branch = "task/discard-root"
    await git(["branch", branch, tip])
    const out = capture(repo)
    expect(
      await runYrdProcess(
        ["bun", "yrd", "drop", branch, "--local", "--discard", "--tip", tip, "--reason", "reviewed", "--json"],
        out.io,
      ),
    ).toBe(2)
    expect(out.stderr()).toContain(
      "--discard requires a component author checkout without its own queue declaration; ordinary queue cleanup does not apply discard intent",
    )
    expect((await git(["rev-parse", `refs/heads/${branch}`])).trim()).toBe(tip)
    expect(out.stdout()).toBe("")
  })

  /** @failure The discard no-preview message promises Git object custody that deliberate local loss does not provide.
   * @level l1 @consumer A caller copying the explicit discard apply command
   */
  it("describes discard no-preview as local loss without Git object custody", async () => {
    const out = capture(outsideRepositoryRoot())
    expect(
      await runYrdProcess(
        [
          "bun",
          "yrd",
          "drop",
          "task/discard",
          "--local",
          "--discard",
          "--tip",
          "a".repeat(40),
          "--reason",
          "reviewed",
          "--dry-run",
          "--json",
        ],
        out.io,
      ),
    ).toBe(2)
    expect(out.stderr()).toContain(
      "it logs and reads back the discard decision, then deliberately loses local component content; it keeps no Git object custody",
    )
    expect(out.stderr()).not.toContain("keeps the tip at origin")
    expect(out.stderr()).toContain("--discard")
    expect(out.stdout()).toBe("")
  })

  /** @failure Public drop help leaves the caller in the superproject when the local branch belongs to a component author store.
   * @level l1 @consumer A caller choosing the local branch command from drop help
   */
  it("drop help names the component author checkout, its local command, and the event-only --release-checkout composition", async () => {
    const out = capture(outsideRepositoryRoot())
    expect(await runYrdProcess(["bun", "yrd", "drop", "--help"], out.io), out.stderr()).toBe(0)
    expect(out.stdout()).toContain("component author checkout")
    expect(out.stdout()).toContain("drop <branch> --local --tip <full-oid>")
    expect(out.stdout()).toContain(
      "To keep the tip with that event and detach the branch while keeping checkout bytes: yrd drop <branch> --local --release-checkout --tip <full-oid> --issue <id> --reason <why> [--apply]",
    )
  })

  /** @failure drop help leaves a seat reading a correct --retire refusal as a failure when the merge already removed the branch.
   * @level l1 @consumer A seat following a cleanup instruction after its merged branch is gone at origin
   */
  it("drop help says a merged branch needs no retire", async () => {
    const out = capture(outsideRepositoryRoot())
    expect(await runYrdProcess(["bun", "yrd", "drop", "--help"], out.io), out.stderr()).toBe(0)
    expect(out.stdout()).toContain("needs no retire")
    expect(out.stdout()).toContain("custody proof")
    expect(out.stdout()).toContain(
      "For a queue-backed draft, --retire writes an ending event that keeps the exact tip as a Git parent; it creates no separate branch archive under refs/archive/. The event chain is retained, including after a manual move to refs/yrd-archive.",
    )
  })

  /** @failure The submodule-flag refusal on the BRANCH form still says "--issue <id>" is missing when the caller passed it,
   *          so a seat whose --local --tip drop refused is sent to add a binding that form does not need (30106).
   * @level l1 @consumer A seat cleaning up a local branch after its Yrd merge
   */
  it("a submodule flag on the branch form names the form, not a missing issue (30106)", async () => {
    const repo = await world("checks: []\n")
    const tip = (await gitIn(repo)(["rev-parse", "HEAD"])).trim()
    const out = capture(repo)
    expect(
      await runYrdProcess(
        ["bun", "yrd", "drop", "task/30106-branch", "--local", "--tip", tip, "--issue", "30106", "--submodules"],
        out.io,
      ),
    ).toBe(2)
    expect(out.stderr()).toContain("belong to drop --issue <id>, not the branch form")
    expect(out.stderr()).toContain("needs no issue binding")
  })

  /**
   * @failure Exact local abandonment rejects a merged descendant or already-retained sibling, or relaxes requested-tip, ancestry, state or automatic-cleanup protection.
   * @level l3 @consumer The existing local drop caller and the retained event that keeps its tip (30683)
   * The older advanced case below is still queued; it cannot exercise an already-merged chain with a later local tip.
   */
  it.each([
    "duplicate",
    "gitlink-delta",
    "wrong-tip",
    "non-descendant",
    "retained-sibling",
    "unknown-ancestry",
    "unmerged",
    "automatic",
    "automatic-sibling",
  ] as const)(
    "keeps a merged local descendant with a retained event only with its authority: %s",
    async (mode) => {
      const repo = await world("checks: []\n")
      const git = gitIn(repo)
      const branch = "task/retirement-advanced"
      const issue = "@example/retirement"
      let component: string | undefined
      if (mode === "gitlink-delta") {
        const seed = await world()
        component = join(repo, "component")
        await git([
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          "--quiet",
          join(dirname(seed), "remote.git"),
          "component",
        ])
        await git(["commit", "--quiet", "-am", "register component"])
        await git(["push", "--quiet", "origin", "main"])
      }
      if (mode === "automatic-sibling") await git(["commit", "--quiet", "--allow-empty", "-m", "submitted sibling"])
      const recorded = (await git(["rev-parse", "HEAD"])).trim()
      const queueTip = await createQueue(repo, "main", recorded, new Date())
      const store = createEventStore(repo, "origin", git.selection)
      const chain = await openEvents({ ...store, ref: changesRef("main", branch), writer: "fixture" })
      const seeded = await chain.append(
        [
          changeInput("opened", { queueTip, at: new Date(), commit: recorded, by: "fixture", issue }),
          ...(mode === "unmerged" ? [] : [changeInput("merged", { queueTip, at: new Date(), commit: recorded })]),
        ],
        { expect: null },
      )
      let head: string
      if (mode === "non-descendant" || mode === "retained-sibling" || mode === "automatic-sibling") {
        const tree = (await git(["rev-parse", "HEAD^{tree}"])).trim()
        head = (
          await git([
            "commit-tree",
            tree,
            ...(mode === "automatic-sibling" ? ["-p", `${recorded}^`] : []),
            "-m",
            "unrelated local tip",
          ])
        ).trim()
        await git(["branch", branch, head])
      } else {
        await git(["checkout", "--quiet", "-b", branch])
        if (component !== undefined) {
          const childGit = gitIn(component)
          await childGit(["commit", "--quiet", "--allow-empty", "-m", "component advancement"])
          await childGit(["push", "--quiet", "origin", "main"])
          await git(["add", "component"])
          await git(["commit", "--quiet", "-m", "advance only the gitlink"])
        } else await git(["commit", "--quiet", "--allow-empty", "-m", "local advancement"])
        head = (await git(["rev-parse", "HEAD"])).trim()
        await git(["checkout", "--quiet", "main"])
      }
      if (mode === "retained-sibling") {
        // 30122: the archive-free replacement omitted this existing-custody admission.
        // Unlike the unretained non-descendant control, this exact sibling is already kept.
        await chain.append(
          [
            changeInput("retained", {
              queueTip,
              at: new Date(),
              commit: head,
              by: "fixture",
              reason: "keep the exact sibling before local retirement",
            }),
          ],
          { expect: seeded.head },
        )
      }
      const history = (await readBranchHistory(store, "main", branch)).history
      if (history === undefined) throw new Error("fixture has no change history")
      const endingRef = await git(["ls-remote", "origin", changesRef("main", branch)])
      const localArchives = await git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/archive/"])
      const originArchives = await git(["ls-remote", "origin", "refs/archive/*"])
      const status = await git(["status", "--porcelain=v2", "-z"])
      const componentRefs =
        component === undefined
          ? undefined
          : await gitIn(component)(["for-each-ref", "--format=%(refname) %(objectname)"])
      if (mode === "unknown-ancestry") {
        // Public Git selection supplies one real failing read; no production-only seam or mocked retirement result.
        const hook = join(dirname(repo), "unreadable-ancestry")
        writeFileSync(
          hook,
          "#!/bin/sh\n" +
            'if [ "$1" = merge-base ] && [ "$2" = --is-ancestor ] && [ "$3" = "' +
            recorded +
            '" ] && [ "$4" = "' +
            head +
            '" ]; then\n' +
            '  echo "ancestry evidence intentionally unreadable" >&2\n  exit 128\nfi\n' +
            'exec git "$@"\n',
        )
        chmodSync(hook, 0o755)
        await git(["config", "yrd.git", JSON.stringify({ executable: hook, contract: "native" })])
      }
      const out = capture(repo)
      const argv =
        mode === "automatic" || mode === "automatic-sibling"
          ? ["bun", "yrd", "drop", "--issue", issue, "--dry-run", "--json"]
          : [
              "bun",
              "yrd",
              "drop",
              branch,
              "--local",
              "--tip",
              mode === "wrong-tip" ? recorded : head,
              "--issue",
              issue,
              "--submitter",
              "fixture",
              "--json",
            ]
      const exit = await runYrdProcess(argv, out.io)
      // Unreadable authority is a CLI execution error (2), rather than an ordinary kept result.
      // 30266: a kept branch is not a retirement either, so it exits non-zero.
      const retained = mode === "wrong-tip" || mode === "non-descendant" || mode === "unmerged"
      expect(exit, out.stderr()).toBe(mode === "unknown-ancestry" ? 2 : retained ? 1 : 0)
      if (mode === "unknown-ancestry") {
        expect(out.stderr()).toContain("ancestry evidence intentionally unreadable")
        expect(out.stdout()).toBe("")
      } else {
        const report = JSON.parse(out.stdout()) as {
          removed: { branch: string; head: string; archiveRef?: string; recovery?: string }[]
          kept: { branch: string; reason: string }[]
          failed: unknown[]
        }
        if (mode === "duplicate" || mode === "gitlink-delta" || mode === "retained-sibling") {
          expect(report.kept).toEqual([])
          expect(report.failed).toEqual([])
          expect(report.removed).toEqual([expect.objectContaining({ branch, head })])
          expect(report.removed[0]?.archiveRef).toBeUndefined()
          expect(report.removed[0]?.recovery).toContain(changesRef("main", branch))
          expect((await git(["for-each-ref", "--format=%(refname)", "refs/heads/" + branch])).trim()).toBe("")
        } else {
          expect(report.removed).toEqual([])
          expect(report.failed).toEqual([])
          expect(report.kept).toEqual([expect.objectContaining({ branch, reason: "advanced" })])
        }
      }
      expect(await git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/archive/"])).toBe(localArchives)
      expect(await git(["ls-remote", "origin", "refs/archive/*"])).toBe(originArchives)
      const after = (await readBranchHistory(store, "main", branch)).history
      if (mode === "duplicate" || mode === "gitlink-delta") {
        // 30683: a retained event keeps the local tip; the merge's facts are unchanged.
        expect(after?.events.slice(0, -1).map((event) => event.links)).toEqual(
          history.events.map((event) => event.links),
        )
        expect(after?.events.at(-1)).toMatchObject({ type: "retained", links: [head] })
        expect(after?.state).toEqual({ ...history.state, tip: after?.events.at(-1)?.id })
      } else if (mode === "retained-sibling") {
        expect(await git(["ls-remote", "origin", changesRef("main", branch)])).toBe(endingRef)
        expect(after?.state).toEqual(history.state)
        expect(after?.events).toEqual(history.events)
      } else {
        expect((await git(["rev-parse", "refs/heads/" + branch])).trim()).toBe(head)
        expect(await git(["ls-remote", "origin", changesRef("main", branch)])).toBe(endingRef)
        expect(after?.state).toEqual(history.state)
        expect(after?.events.map((event) => event.links)).toEqual(history.events.map((event) => event.links))
      }
      expect(await git(["status", "--porcelain=v2", "-z"])).toBe(status)
      if (component !== undefined) {
        expect(await gitIn(component)(["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(componentRefs)
      }
    },
    60_000,
  )

  /**
   * @failure Issue cleanup treats a legacy archive as permission to retire an unlinked merged head on origin, adds
   * retention to the selected history, or moves or reports a legacy archive (30683: archives are read, never written).
   * @level l3 @consumer Applied issue cleanup for a merged root whose submitted commit is distinct from its fresh-main head
   * The sibling table has no exact generated origin archive and does not snapshot the full selected event history.
   */
  it.each([
    { admission: "unlinked", keepChild: false },
    { admission: "ancestor of later kept link", keepChild: true },
  ] as const)("30432: issue cleanup beside legacy archives handles a head $admission", async ({ keepChild }) => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const branch = "task/30432-issue-boundary"
    const issue = "@example/30432-issue-boundary"
    const parent = (await git(["rev-parse", "HEAD"])).trim()
    const tree = (await git(["rev-parse", "HEAD^{tree}"])).trim()
    const recorded = (await git(["commit-tree", tree, "-p", parent, "-m", "submitted root"])).trim()
    const head = (await git(["commit-tree", tree, "-p", recorded, "-m", "fresh main head"])).trim()
    const keptLink = keepChild ? (await git(["commit-tree", tree, "-p", head, "-m", "later kept link"])).trim() : head
    await git(["update-ref", "refs/heads/main", keptLink, parent])
    await git(["push", "--quiet", "origin", "main"])
    const queueTip = await createQueue(repo, "main", keptLink, new Date())
    const eventRef = changesRef("main", branch)
    const chain = await openEvents({
      ...createEventStore(repo, "origin", git.selection),
      ref: eventRef,
      writer: "fixture",
    })
    const opened = await chain.append(
      [changeInput("opened", { queueTip, at: new Date(), commit: recorded, by: "fixture", issue })],
      { expect: null },
    )
    await chain.append([changeInput("merged", { queueTip, at: new Date(), commit: recorded })], { expect: opened.head })
    const location = createEventStore(repo, "origin", git.selection)
    if (keepChild) {
      const merged = await readBranchHistory(location, "main", branch)
      const retention = changeInput("retained", {
        queueTip,
        at: new Date(),
        commit: keptLink,
        by: "fixture",
        reason: "keep later main link for issue-retirement admission",
      })
      await (
        await openEvents({ ...location, ref: eventRef, writer: "fixture" })
      ).append([retention], { expect: merged.history!.state.tip! })
    }
    await git(["branch", branch, head])
    await git(["push", "--quiet", "origin", `refs/heads/${branch}`])
    const localArchive = `refs/archive/2000-01-01/previous-seat/${branch}`
    const originArchive = archiveRefFor(branch, "fixture", new Date().toISOString().slice(0, 10))
    await git(["update-ref", localArchive, head, "0".repeat(40)])
    await git(["push", "--quiet", "origin", `${head}:${originArchive}`])

    const before = await readBranchHistory(location, "main", branch)
    const originBranchBefore = await git(["ls-remote", "origin", `refs/heads/${branch}`])
    const originArchiveBefore = await git(["ls-remote", "origin", originArchive])
    const out = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "drop", "--issue", issue, "--submitter", "fixture", "--json"], out.io),
      out.stderr(),
    ).toBe(0)
    expect((await git(["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`])).trim()).toBe("")
    expect(await git(["ls-remote", "origin", `refs/heads/${branch}`])).toBe(keepChild ? "" : originBranchBefore)
    expect(await git(["ls-remote", "origin", originArchive])).toBe(originArchiveBefore)
    expect((await git(["rev-parse", localArchive])).trim()).toBe(head)
    const after = await readBranchHistory(location, "main", branch)
    expect(after.history).toEqual(before.history)
    expect(after.history?.events.some((event) => event.type === "retained")).toBe(keepChild)
    expect((await git(["rev-parse", "main"])).trim()).toBe(keptLink)
    const report = JSON.parse(out.stdout()) as {
      removed: { branch: string; head: string; archiveRef?: string; detail?: string }[]
      kept: unknown[]
      failed: unknown[]
    }
    expect(report.removed).toEqual([expect.objectContaining({ branch, head })])
    expect(report.removed[0]).not.toHaveProperty("archiveRef")
    if (!keepChild) {
      const remote = (await git(["remote", "get-url", "origin"])).trim()
      expect(report.removed[0]?.detail).toContain(`origin ${remote}#${branch}@${head} remains`)
      expect(report.removed[0]?.detail).toContain(`'--retire' '--tip' '${head}'`)
      expect(report.removed[0]?.detail).toContain("'--submitter' 'fixture'")
    }
    expect(report.kept).toEqual([])
    expect(report.failed).toEqual([])
  })

  /**
   * @failure Issue cleanup deletes unpublished work without origin custody, or removes an advanced submitted branch.
   * @level l3
   * @consumer The closer running yrd drop --issue after durable issue closure
   */
  it("drop by issue keeps unpublished work and advanced submitted tips; explicit abandonment retains custody", async () => {
    const repo = await world("{}\n", "work tree's")
    const outside = outsideRepositoryRoot()
    roots.push(outside)
    const git = gitIn(repo)
    const queueTip = await createQueue(repo, "main", (await git(["rev-parse", "HEAD"])).trim(), new Date())
    const issue = "@example/28791-retirement"
    const advancedBranch = "task/28791-advanced'quoted"
    const saved = new Map<string, string>()
    for (const branch of ["task/28791-local-only", "task/manual-only", advancedBranch]) {
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
      if (branch === advancedBranch) {
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
        // 30683: an open advanced change names withdrawal before any abandonment.
        expect.objectContaining({
          branch: advancedBranch,
          reason: "advanced",
          detail:
            "current tip " +
            advanced +
            " differs from recorded change tip " +
            saved.get(advancedBranch) +
            "; change is still open; withdraw it before dropping its advanced tip",
        }),
      ]),
    )
    expect((await git(["rev-parse", "refs/heads/task/28791-local-only"])).trim()).toBe(
      saved.get("task/28791-local-only"),
    )
    expect((await git(["rev-parse", `refs/heads/${advancedBranch}`])).trim()).toBe(advanced)
    expect(
      (await listChanges(createEventStore(repo, "origin", git.selection), "main")).has("task/28791-local-only"),
    ).toBe(false)
    // Manual cleanup is exact-branch/exact-tip, and does not expand to the issue's other refs.
    const manualHead = saved.get("task/manual-only")!
    // 29948: A held row that never wrote an archive ref must omit archiveRef and state that it did not archive.
    const heldManual = capture(repo)
    heldManual.io.localBranchProtections = async () => ({
      protections: [`declared cwd for @dev/5 in /hh/hh.hab.tsx: ${repo}`],
      evidence: [],
    })
    expect(
      await runYrdProcess(
        ["bun", "yrd", "drop", "task/manual-only", "--local", "--tip", manualHead, "--submitter", "fixture", "--json"],
        heldManual.io,
      ),
      heldManual.stderr(),
      // 30266: the branch was held, not retired, so the receipt cannot report success.
    ).toBe(1)
    const heldManualReport = JSON.parse(heldManual.stdout()) as {
      removed: unknown[]
      kept: { branch: string; head: string; reason: string; detail?: string; archiveRef?: string }[]
    }
    expect(heldManualReport.removed).toEqual([])
    expect(heldManualReport.kept).toEqual([
      expect.objectContaining({
        branch: "task/manual-only",
        head: manualHead,
        reason: "held",
        detail: `local ref ${fs.realpathSync(join(repo, ".git"))}#refs/heads/task/manual-only: declared cwd for @dev/5 in /hh/hh.hab.tsx: ${repo}; branch kept`,
      }),
    ])
    expect(heldManualReport.kept[0]).not.toHaveProperty("archiveRef")
    expect((await git(["for-each-ref", "refs/archive/*/*/task/manual-only"])).trim()).toBe("")

    const manual = capture(repo)
    expect(
      await runYrdProcess(
        ["bun", "yrd", "drop", "task/manual-only", "--local", "--tip", manualHead, "--submitter", "fixture", "--json"],
        manual.io,
      ),
      manual.stderr(),
    ).toBe(0)
    const manualReport = JSON.parse(manual.stdout()) as {
      removed: { branch: string; archiveRef?: string; recovery?: string }[]
    }
    expect(manualReport.removed).toEqual([expect.objectContaining({ branch: "task/manual-only" })])
    // 30683: the dropped event on the chain keeps the tip, and the recovery reads it back from there.
    expect(manualReport.removed[0]!.archiveRef).toBeUndefined()
    expect(manualReport.removed[0]!.recovery).toContain(changesRef("main", "task/manual-only"))
    const remoteRefs = await git(["ls-remote", "origin"])
    const originRecovery = manualReport.removed[0]!.recovery
    if (originRecovery === undefined) throw new Error("the dropped event supplied no recovery command")
    const restored = spawnSync("/bin/sh", ["-c", originRecovery], { cwd: outside, encoding: "utf8" })
    expect(restored.status, restored.stderr).toBe(0)
    expect((await git(["rev-parse", "refs/heads/task/manual-only"])).trim()).toBe(manualHead)
    expect(await git(["ls-remote", "origin"])).toBe(remoteRefs)
    await git(["update-ref", "-d", "refs/heads/task/manual-only", manualHead])
    expect((await git(["rev-parse", `refs/heads/${advancedBranch}`])).trim()).toBe(advanced)
    // Accepted29301: local expected=head, but the recorded change has an older head.
    // Existing assertions only check the reason token, so they miss identical SHAs in the detail.
    // End the change before exercising the existing on-main advanced-tip cure.
    const advancedStore = createEventStore(repo, "origin", git.selection)
    const advancedHistory = (await readBranchHistory(advancedStore, "main", advancedBranch)).history!
    const advancedChain = await openEvents({
      ...advancedStore,
      ref: changesRef("main", advancedBranch),
      writer: "fixture",
    })
    await advancedChain.append(
      [changeInput("cancelled", { queueTip, at: new Date(), reason: "withdrawn", by: "fixture" })],
      { expect: advancedHistory.state.tip! },
    )
    await git(["push", "--quiet", "origin", advanced + ":refs/heads/main"])
    await git(["fetch", "--quiet", "origin", "main"])
    await git(["merge-base", "--is-ancestor", advanced, "origin/main"])
    const local = capture(repo)
    expect(
      await runYrdProcess(
        ["bun", "yrd", "drop", advancedBranch, "--local", "--tip", advanced, "--submitter", "fixture", "--json"],
        local.io,
      ),
      local.stderr(),
      // 30266: kept "advanced", so the requested deletion did not happen.
    ).toBe(1)
    expect(JSON.parse(local.stdout())).toMatchObject({
      removed: [],
      kept: [
        {
          branch: advancedBranch,
          head: advanced,
          reason: "advanced",
          detail: expect.stringContaining("nothing is lost: move the branch back with "),
        },
      ],
    })
    expect((await git(["rev-parse", `refs/heads/${advancedBranch}`])).trim()).toBe(advanced)
    const requested = capture(repo)
    expect(
      await runYrdProcess(
        [
          "bun",
          "yrd",
          "drop",
          advancedBranch,
          "--local",
          "--tip",
          saved.get(advancedBranch)!,
          "--submitter",
          "fixture",
          "--json",
        ],
        requested.io,
      ),
      requested.stderr(),
      // 30266: kept "advanced" again, so this rerun also deleted nothing.
    ).toBe(1)
    expect(JSON.parse(requested.stdout())).toMatchObject({
      removed: [],
      kept: [
        {
          branch: advancedBranch,
          reason: "advanced",
          detail:
            `local ref ${fs.realpathSync(join(repo, ".git"))}#refs/heads/${advancedBranch}: current tip ` +
            advanced +
            " differs from requested tip " +
            saved.get(advancedBranch) +
            "; if " +
            advanced +
            " is the tip to retire, rerun with --tip " +
            advanced +
            ", otherwise the branch gained commits after you read it",
        },
      ],
    })
    // 29579: the named cure works. Moved back to its recorded tip, the branch the target already holds retires.
    const nativeDetail = (JSON.parse(local.stdout()) as { kept: { branch: string; detail: string }[] }).kept.find(
      (row) => row.branch === advancedBranch,
    )?.detail
    const recipe = nativeDetail?.split("move the branch back with ")[1]?.split(", then ")[0]
    expect(recipe, nativeDetail).toBeDefined()
    const originBefore = await git(["ls-remote", "origin"])
    const applied = spawnSync("/bin/sh", ["-c", recipe!], { cwd: outside, encoding: "utf8", timeout: 30_000 })
    expect(applied.status, applied.stderr).toBe(0)
    expect((await git(["rev-parse", `refs/heads/${advancedBranch}`])).trim()).toBe(saved.get(advancedBranch))
    // The copied command's old-tip lease is stale after its first successful use.
    const stale = spawnSync("/bin/sh", ["-c", recipe!], { cwd: outside, encoding: "utf8", timeout: 30_000 })
    expect(stale.status, stale.stderr).toBe(128)
    expect((await git(["rev-parse", `refs/heads/${advancedBranch}`])).trim()).toBe(saved.get(advancedBranch))
    expect(await git(["ls-remote", "origin"])).toBe(originBefore)
    const cured = capture(repo)
    expect(
      await runYrdProcess(
        [
          "bun",
          "yrd",
          "drop",
          advancedBranch,
          "--local",
          "--tip",
          saved.get(advancedBranch)!,
          "--submitter",
          "fixture",
          "--json",
        ],
        cured.io,
      ),
      cured.stderr(),
    ).toBe(0)
    const curedReport: unknown = JSON.parse(cured.stdout())
    expect(curedReport).toMatchObject({
      kept: [],
      removed: [{ branch: advancedBranch, head: saved.get(advancedBranch) }],
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
   * @failure An owner cannot drop a branch that advanced past its recorded tip; the drop keeps only one of its two
   *   commits or loses the record of what the target lacks; or a third seat, a missing reason or an unknown
   *   ancestry drops it anyway (30683).
   * @level l3
   * @consumer The branch owner or @chief running yrd drop --local --reason on an advanced branch
   */
  it.each([
    "owner",
    "queue owner",
    "no reason",
    "third seat",
    "absent main",
    "open",
    "failed",
    "merged",
    "issue open",
    "sibling",
    "issue sibling",
    "issue legacy archive",
  ] as const)(
    "an advanced branch drops only for its owner or the queue owner with a reason, keeping both commits: %s",
    async (mode) => {
      const repo = await world("{}\n")
      const git = gitIn(repo)
      await createQueue(repo, "main", (await git(["rev-parse", "HEAD"])).trim(), new Date())
      const branch = "task/30683-advanced"
      await git(["checkout", "--quiet", "-b", branch, "main"])
      writeFileSync(join(repo, "work.txt"), "submitted\n")
      await git(["add", "work.txt"])
      await git(["commit", "--quiet", "-m", "submitted work"])
      const recorded = (await git(["rev-parse", "HEAD"])).trim()
      const submitted = capture(repo)
      expect(
        await runYrdProcess(["bun", "yrd", "submit", "--submitter", "@dev/7", "--json"], submitted.io),
        submitted.stderr(),
      ).toBe(0)
      if (mode !== "open" && mode !== "issue open") {
        const location = createEventStore(repo, "origin", git.selection)
        const before = (await readBranchHistory(location, "main", branch)).history!
        const chain = await openEvents({ ...location, ref: changesRef("main", branch), writer: "fixture" })
        await chain.append(
          [
            // Open/cancelled rows alone miss a predicate that admits failed endings.
            changeInput(mode === "failed" || mode === "merged" ? mode : "cancelled", {
              queueTip: before.events[0]!.props.find(([key]) => key === "Queue")![1],
              at: new Date(),
              ...(mode === "merged" ? { commit: recorded } : {}),
              reason: "withdrawn",
              by: "@dev/7",
            }),
          ],
          { expect: before.state.tip! },
        )
      }
      writeFileSync(join(repo, "work.txt"), "advanced\n")
      await git(["commit", "--quiet", "-am", "work after submission"])
      // A merged descendant has its separate retained-history path; a sibling reaches the advanced-drop check.
      const sibling = mode === "sibling" || mode === "issue sibling" || mode === "merged"
      if (sibling) {
        const tree = (await git(["rev-parse", "HEAD^{tree}"])).trim()
        const siblingTip = (await git(["commit-tree", tree, "-p", "main", "-m", "replacement sibling"])).trim()
        await git(["update-ref", `refs/heads/${branch}`, siblingTip])
      }
      const tip = (await git(["rev-parse", "HEAD"])).trim()
      await git(["checkout", "--quiet", "main"])
      const main = (await git(["rev-parse", "main"])).trim()
      const location = createEventStore(repo, "origin", git.selection)
      const before = await readBranchHistory(location, "main", branch)
      if (mode === "absent main") {
        await gitIn(join(dirname(repo), "remote.git"))(["update-ref", "-d", "refs/heads/main"])
      }
      const by = mode === "queue owner" ? "@chief" : mode === "third seat" ? "@dev/8" : "@dev/7"
      const reason = mode === "no reason" ? [] : ["--reason", "superseded by 30704"]
      const output = capture(repo)
      const issueMode = mode.startsWith("issue ")
      if (issueMode) output.io.branchIssue = () => "@example/30683-advanced"
      if (mode === "issue legacy archive") {
        await git(["update-ref", `refs/archive/2026-10-22/fixture/${branch}`, tip])
      }
      const code = await runYrdProcess(
        [
          "bun",
          "yrd",
          "drop",
          ...(issueMode ? ["--issue", "@example/30683-advanced"] : [branch, "--local", "--tip", tip]),
          ...reason,
          "--submitter",
          by,
          "--json",
        ],
        output.io,
      )
      const localRef = issueMode ? "" : `local ref ${fs.realpathSync(join(repo, ".git"))}#refs/heads/${branch}: `
      const refused = `${localRef}current tip ${tip} differs from recorded change tip ${recorded}`
      if (mode === "absent main") {
        // Unknown ancestry refuses by name: with no published main there is nothing to count against.
        expect(code, output.stdout()).toBe(2)
        expect(output.stderr()).toContain("origin/HEAD did not name a queue branch")
        expect((await git(["rev-parse", `refs/heads/${branch}`])).trim()).toBe(tip)
        expect((await readBranchHistory(location, "main", branch)).history).toEqual(before.history)
        expect(await git(["for-each-ref", "refs/archive/"])).toBe("")
        return
      }
      const report = JSON.parse(output.stdout()) as {
        removed: { branch: string; head: string; archiveRef?: string }[]
        kept: { branch: string; head: string; reason: string; detail: string }[]
      }
      if (mode === "owner" || mode === "queue owner" || mode === "issue legacy archive" || sibling) {
        expect(code, output.stderr()).toBe(0)
        expect(report.removed).toEqual([expect.objectContaining({ branch, head: tip })])
        expect(report.removed[0]).not.toHaveProperty("archiveRef")
        expect((await git(["for-each-ref", `refs/heads/${branch}`])).trim()).toBe("")
        const after = (await readBranchHistory(location, "main", branch)).history
        const ending = after?.events.at(-1)
        if (mode === "merged") {
          // A merged chain keeps its facts: a retained event keeps the advanced tip, the merge keeps recorded (30999).
          expect(ending?.type).toBe("retained")
          expect(ending?.links).toContain(tip)
          expect(after?.state).toMatchObject({ status: "merged", ending: before.history!.state.ending })
          expect(after?.state).not.toHaveProperty("advancedDrop")
        } else {
          // The dropped event keeps the recorded commit and the advanced head, and records what main lacks.
          expect(ending?.type).toBe("cancelled")
          expect(ending?.links).toEqual(expect.arrayContaining([recorded, tip]))
          expect(ending?.content).toBe("superseded by 30704")
          expect(after?.state).toMatchObject({
            status: "cancelled",
            reason: "dropped",
            advancedDrop: { tip, uniqueCommits: sibling ? 1 : 2, target: { ref: "refs/heads/main", tip: main } },
          })
        }
      } else {
        expect(code, output.stderr()).toBe(issueMode ? 0 : 1)
        expect(report.removed).toEqual([])
        expect(report.kept).toEqual([expect.objectContaining({ branch, head: tip, reason: "advanced" })])
        const detail = report.kept[0]!.detail
        expect(detail.startsWith(refused), detail).toBe(true)
        // A third seat gets today's refusal, word for word.
        if (mode === "third seat") {
          expect(detail).toBe(
            `${refused}; it holds commits origin/main lacks: submit them, and drop the branch after they land`,
          )
        }
        if (mode === "no reason") expect(detail).toContain("--reason <why>")
        if (mode === "open" || mode === "issue open") expect(detail).toContain("withdraw")
        expect((await git(["rev-parse", `refs/heads/${branch}`])).trim()).toBe(tip)
        expect((await readBranchHistory(location, "main", branch)).history).toEqual(before.history)
      }
      if (mode === "issue legacy archive") {
        expect((await git(["rev-parse", `refs/archive/2026-10-22/fixture/${branch}`])).trim()).toBe(tip)
      } else expect(await git(["for-each-ref", "refs/archive/"])).toBe("")
      expect(await git(["ls-remote", "origin", "refs/archive/*"])).toBe("")
    },
  )

  /** @failure 30999: a change MERGED, then its same-name branch advanced with commits the owner rejected; the owner's
   * `--reason` drop accepted only a cancelled change, so Yrd kept the branch and told the owner to submit work it had
   * rejected. The same #30683 route now drops it: a retained event keeps the advanced tip, the merged ending keeps
   * the recorded commit, and origin holding the same tip goes in the same command by that event's authority
   * (@cto ruling 48b89203, option A).
   * @level l3 @consumer owners and @chief retiring rejected work left on a merged change's branch
   */
  it.each(["owner", "origin behind", "no reason", "third seat", "held"] as const)(
    "an advanced branch of a merged change drops only for its owner with a reason (30999): %s",
    async (mode) => {
      const repo = await world("{}\n")
      const git = gitIn(repo)
      await createQueue(repo, "main", (await git(["rev-parse", "HEAD"])).trim(), new Date())
      const branch = "task/30999-advanced"
      await git(["checkout", "--quiet", "-b", branch, "main"])
      writeFileSync(join(repo, "work.txt"), "merged\n")
      await git(["add", "work.txt"])
      await git(["commit", "--quiet", "-m", "merged work"])
      const recorded = (await git(["rev-parse", "HEAD"])).trim()
      const submitted = capture(repo)
      expect(
        await runYrdProcess(["bun", "yrd", "submit", "--submitter", "@dev/7", "--json"], submitted.io),
        submitted.stderr(),
      ).toBe(0)
      // The change merges: main fast-forwards to the recorded tip and the chain ends merged.
      await git(["checkout", "--quiet", "main"])
      await git(["merge", "--quiet", "--ff-only", recorded])
      await git(["push", "--quiet", "origin", "main"])
      const location = createEventStore(repo, "origin", git.selection)
      const opened = (await readBranchHistory(location, "main", branch)).history!
      const chain = await openEvents({ ...location, ref: changesRef("main", branch), writer: "fixture" })
      await chain.append(
        [
          changeInput("merged", {
            queueTip: opened.events[0]!.props.find(([key]) => key === "Queue")![1],
            at: new Date(),
            commit: recorded,
            by: "@dev/7",
          }),
        ],
        { expect: opened.state.tip! },
      )
      // Then the same-name branch advances with one commit the owner rejects, published to origin too unless behind.
      await git(["checkout", "--quiet", branch])
      writeFileSync(join(repo, "work.txt"), "rejected\n")
      await git(["commit", "--quiet", "-am", "rejected work after the merge"])
      if (mode === "held") await git(["checkout", "--quiet", "--detach", "main"])
      const advanced = (await git(["rev-parse", "HEAD"])).trim()
      if (mode !== "origin behind") await git(["push", "--quiet", "origin", `${advanced}:refs/heads/${branch}`])
      const originBefore = (await git(["ls-remote", "origin", `refs/heads/${branch}`])).trim()
      // Held: the branch moved back onto main's tip, so main already holds everything it points at.
      if (mode === "held") await git(["update-ref", `refs/heads/${branch}`, recorded])
      await git(["checkout", "--quiet", "main"])
      const tip = (await git(["rev-parse", `refs/heads/${branch}`])).trim()
      const main = (await git(["rev-parse", "main"])).trim()
      const before = await readBranchHistory(location, "main", branch)
      const by = mode === "third seat" ? "@dev/8" : "@dev/7"
      const reason = mode === "no reason" ? [] : ["--reason", "rejected after merge; chief value call"]
      const output = capture(repo)
      // The issue sweep is the route the 29936 specimen took; `--local` keeps its merged-descendant abandonment.
      const issue = "@example/30999-advanced"
      output.io.branchIssue = () => issue
      const code = await runYrdProcess(
        ["bun", "yrd", "drop", "--issue", issue, ...reason, "--submitter", by, "--json"],
        output.io,
      )
      const report = JSON.parse(output.stdout()) as {
        removed: { branch: string; head: string; detail?: string }[]
        kept: { branch: string; head: string; reason: string; detail: string }[]
      }
      if (mode === "owner" || mode === "origin behind") {
        expect(code, output.stderr() + output.stdout()).toBe(0)
        expect(report.removed, output.stdout()).toEqual([expect.objectContaining({ branch, head: tip })])
        expect((await git(["for-each-ref", `refs/heads/${branch}`])).trim()).toBe("")
        const after = (await readBranchHistory(location, "main", branch)).history
        // A retained event keeps the advanced tip and the reason; the merge's facts are unchanged.
        const retained = after?.events.at(-1)
        expect(retained?.type).toBe("retained")
        expect(retained?.links).toContain(tip)
        expect(retained?.props).toContainEqual(["Reason", "rejected after merge; chief value call"])
        expect(after?.state).toMatchObject({ status: "merged", ending: before.history!.state.ending })
        expect(after?.state).not.toHaveProperty("advancedDrop")
        const detail = report.removed[0]!.detail ?? ""
        if (mode === "owner") {
          // Origin held the same tip, so it goes in the same command, by the retained event's authority.
          expect((await git(["ls-remote", "origin", `refs/heads/${branch}`])).trim()).toBe("")
          expect(detail).toContain(`retired by event ${retained!.id}`)
        } else {
          // Origin holds another head: it stays, and the row names both heads and the explicit cure.
          expect((await git(["ls-remote", "origin", `refs/heads/${branch}`])).trim()).toBe(originBefore)
          expect(originBefore).not.toContain(tip)
          expect(detail).toContain(`${branch}@${originBefore.split("\t")[0]} remains`)
          expect(detail).toContain(`'--retire' '--tip' '${tip}'`)
        }
        const logs = join(await workdirOf(git, { cwd: repo }), "logs")
        const rows = readdirSync(logs)
          .filter((name) => name.endsWith(".jsonl"))
          .flatMap((name) => readRunLog(logs, name.slice(0, -6)))
          .map((row) => JSON.stringify(row))
        expect(
          rows.some((row) =>
            row.includes(`past merged ${recorded}; 1 unique commits relative to refs/heads/main@${main}`),
          ),
          rows.join("\n"),
        ).toBe(true)
      } else if (mode === "held") {
        // Moved back onto the merged tip, main holds everything: an ordinary merged retirement, no advanced record.
        expect(code, output.stderr()).toBe(0)
        expect(report.removed).toEqual([expect.objectContaining({ branch, head: recorded })])
        expect((await git(["for-each-ref", `refs/heads/${branch}`])).trim()).toBe("")
        expect((await readBranchHistory(location, "main", branch)).history?.state).not.toHaveProperty("advancedDrop")
      } else {
        expect(code, output.stderr()).toBe(0)
        expect(report.removed).toEqual([])
        expect(report.kept).toEqual([expect.objectContaining({ branch, head: tip, reason: "advanced" })])
        const detail = report.kept[0]!.detail
        if (mode === "no reason") expect(detail).toContain("--reason <why>")
        // A third seat gets today's refusal, word for word.
        if (mode === "third seat") {
          expect(detail).toBe(
            `current tip ${tip} differs from recorded change tip ${recorded}; it holds commits origin/main lacks: submit them, and drop the branch after they land`,
          )
        }
        expect((await git(["rev-parse", `refs/heads/${branch}`])).trim()).toBe(tip)
        expect((await git(["ls-remote", "origin", `refs/heads/${branch}`])).trim()).toBe(
          `${advanced}\trefs/heads/${branch}`,
        )
        expect((await readBranchHistory(location, "main", branch)).history).toEqual(before.history)
      }
      expect(await git(["for-each-ref", "refs/archive/"])).toBe("")
    },
  )

  /** @failure Ordinary unmerged drops omit the exact tip or number of commits main lacks (30683 R6).
   * @level l3 @consumer Authors reviewing local, issue and origin drop receipts
   * Advanced-drop metadata does not exercise these ordinary receipts.
   */
  it.each(["local", "issue", "origin", "origin count failure"] as const)(
    "reports the ordinary unmerged %s drop tip and commit count",
    async (mode) => {
      const repo = await world("{}\n")
      const git = gitIn(repo)
      const queueTip = await createQueue(repo, "main", (await git(["rev-parse", "HEAD"])).trim(), new Date())
      const branch = "task/30683-count"
      await git(["checkout", "--quiet", "-b", branch])
      await git(["commit", "--quiet", "--allow-empty", "-m", "unmerged work"])
      const tip = (await git(["rev-parse", "HEAD"])).trim()
      await git(["push", "--quiet", "origin", branch])
      await git(["checkout", "--quiet", "main"])
      const chain = await openEvents({
        ...createEventStore(repo, "origin", git.selection),
        ref: changesRef("main", branch),
        writer: "fixture",
      })
      await chain.append(
        [
          changeInput("opened", {
            queueTip,
            at: new Date(),
            commit: tip,
            by: "fixture",
            issue: "@example/30683-count",
          }),
          changeInput("cancelled", { queueTip, at: new Date(), reason: "withdrawn", by: "fixture" }),
        ],
        { expect: null },
      )
      const output = capture(repo)
      const location = createEventStore(repo, "origin", git.selection)
      const before = await readBranchHistory(location, "main", branch)
      const args =
        mode === "issue"
          ? ["--issue", "@example/30683-count"]
          : [
              branch,
              ...(mode === "local"
                ? ["--local", "--tip", tip]
                : mode === "origin count failure"
                  ? ["--retire", "--tip", tip]
                  : []),
            ]
      if (mode === "origin count failure") {
        // A receipt count must succeed before origin retirement changes the branch or its history.
        const found = spawnSync("which", ["git"], { encoding: "utf8" })
        if (found.status !== 0 || found.stdout.trim() === "") throw new Error(`which git failed: ${found.stderr}`)
        const bin = join(dirname(repo), "count-failure-bin")
        mkdirSync(bin)
        const realGit = found.stdout.trim()
        writeFileSync(
          join(bin, "git"),
          `#!/bin/sh\ncase " $* " in *" rev-list --count "*) echo 'fixture count unreadable' >&2; exit 73;; esac\nexec ${shellQuote(realGit)} "$@"\n`,
        )
        chmodSync(join(bin, "git"), 0o755)
        const previous = process.env.PATH
        process.env.PATH = `${bin}:${previous ?? ""}`
        let code: number
        try {
          code = await runYrdProcess(
            ["bun", "yrd", "drop", ...args, "--reason", "superseded", "--submitter", "fixture"],
            output.io,
          )
        } finally {
          if (previous === undefined) delete process.env.PATH
          else process.env.PATH = previous
        }
        expect(code).toBe(2)
        expect(output.stderr()).toContain("fixture count unreadable")
        expect((await git(["ls-remote", "origin", `refs/heads/${branch}`])).trim()).toBe(`${tip}\trefs/heads/${branch}`)
        expect((await readBranchHistory(location, "main", branch)).history).toEqual(before.history)
        expect(output.stderr()).not.toContain("completed")
        return
      }
      expect(
        await runYrdProcess(
          ["bun", "yrd", "drop", ...args, "--reason", "superseded", "--submitter", "fixture"],
          output.io,
        ),
        output.stderr(),
      ).toBe(0)
      expect(output.stdout()).toContain(tip)
      expect(output.stdout()).toContain("1 unique commit")
    },
  )

  /**
   * @failure An unreadable tip or a failed ancestry read unlocks the owner's advanced drop (30683).
   * @level l2
   * @consumer The owner's yrd drop --local --reason on an advanced branch
   */
  it("refuses the owner's advanced drop by name when the ancestry read fails", async () => {
    const repo = await world("{}\n")
    const real = gitIn(repo)
    const head = (await real(["rev-parse", "HEAD"])).trim()
    let firstRead = true
    const failing = Object.assign(
      async (args: readonly string[]): Promise<string> => {
        if (args[0] === "merge-base") {
          if (firstRead) {
            firstRead = false
            throw new Error("fatal: bad object")
          }
          return ""
        }
        return real([...args])
      },
      { selection: real.selection },
    ) as unknown as typeof real
    const at = new Date()
    const result = await advancedDrop(failing, {
      repo,
      branch: "task/30683-unreadable",
      head: "1".repeat(40),
      history: {
        state: {
          status: "cancelled",
          commit: head,
          submitter: "@dev/7",
          ending: { kind: "cancelled", id: "2".repeat(40) },
          at,
        },
        events: [],
      },
      queue: "main",
      target: head,
      targetLabel: "origin/main",
      by: "@dev/7",
      reason: "superseded",
    })
    expect(result).toEqual({ detail: expect.stringContaining("is unknown (fatal: bad object)") })
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
    // One branch the issue reaches by name, already held by main and eligible...
    await git(["branch", "task/26133-landed", "main"])
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
      removed: { branch: string }[]
    }
    expect(report.apply).toBe(false)
    expect(report.eligible).toEqual(
      expect.arrayContaining([expect.objectContaining({ branch: "task/29010-landed", reason: "landed" })]),
    )
    expect(report.eligible).toHaveLength(1)
    expect(report.kept).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ branch: "task/29010-active", reason: "active" }),
        expect.objectContaining({ branch: "task/29010-archived", reason: "unreached" }),
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
    expect(applied.removed.map((row: { branch: string }) => row.branch).sort()).toEqual(["task/29010-landed"])
    const location = createEventStore(repo, "origin", git.selection)
    for (const row of applied.removed) {
      // 30683: an event on the branch's chain keeps the exact tip (the landing's own, or a new dropped event),
      // and no archive is written.
      expect(row).not.toHaveProperty("archiveRef")
      const history = (await readBranchHistory(location, "main", row.branch)).history
      expect(history?.events.some((event) => event.links.includes(tips.get(row.branch)!))).toBe(true)
      expect((await git(["for-each-ref", "--format=%(refname)", `refs/heads/${row.branch}`])).trim()).toBe("")
    }
    expect((await git(["for-each-ref", "--format=%(refname)", "refs/archive/"])).trim()).toBe("")
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
    // Linux close admission reads the raw census, separately from the cwd projection.
    using rawCensus = (await permitCensus()).spy
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
        return rows.some((row) => row.kind === "observation" && row.queueRun === outcome.run) ? rows : []
      })
    const retirement = records.find((row) => row.kind === "local-branch-retirement" && row.branch === branch)
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
    const reason = "\n  target policy: keep 'literal' bytes\t\u2028Next: yrd drop example\u2029\r\n\n"
    mkdirSync(join(repo, "tools"))
    writeFileSync(join(repo, "tools", "policy.sh"), "#!/bin/sh\nprintf %s " + shellQuote(reason) + "\nexit 3\n")
    await git(["add", "tools/policy.sh"])
    await git(["commit", "--quiet", "-m", "policy"])
    await git(["push", "--quiet", "origin", "main"])
    await createQueue(repo, "main", (await git(["rev-parse", "HEAD"])).trim(), new Date())
    await git(["checkout", "--quiet", "-b", "task/warn-only"])
    writeFileSync(join(repo, "work.txt"), "warning submit\n")
    await git(["add", "work.txt"])
    await git(["commit", "--quiet", "-m", "warning submit"])
    const prepared = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "submit", "--prepare", "--queue", "main", "--json"], prepared.io),
      prepared.stderr(),
    ).toBe(0)
    expect(prepared.stderr()).toContain("target policy warning (recorded guidance)")
    expect(prepared.stderr()).toContain(reason)
    expect(JSON.parse(prepared.stdout())).toHaveProperty("admission", { kind: "warn", reason })
    const submitted = capture(repo)
    expect(await runYrdProcess(["bun", "yrd", "submit", "--queue", "main", "--json"], submitted.io)).toBe(0)
    expect(submitted.stderr()).toContain("TARGET POLICY WARNING (recorded guidance)")
    expect(submitted.stderr()).toContain(reason)
    const receipt = JSON.parse(submitted.stdout()) as { admission: { kind: string } }
    expect(receipt.admission).toEqual({ kind: "warn", reason })
    const store = createEventStore(repo, "origin", git.selection)
    const change = (await listChanges(store, "main")).get("task/warn-only")
    expect(change).toMatchObject({ status: "queued", diagnostic: expect.stringContaining("target policy warning") })
    // The fold can recover the policy text while the history reader still prints the carrier label.
    const history = await (await openEvents({ ...store, ref: changesRef("main", "task/warn-only") })).events()
    expect(eventHistoryEntries(history).find((entry) => entry.text.startsWith("admission-warning"))).toMatchObject({
      detail: expect.stringContaining(`recorded target-policy guidance: ${reason}`),
    })
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
    // The formatter's author clone differs from the queue reader: fetched commit
    // metadata proves neither a local branch nor a runnable submit instruction.
    const author = join(dirname(repo), "draft-author")
    await git(["clone", "--quiet", (await git(["remote", "get-url", "origin"])).trim(), author])
    const authorGit = gitIn(author)
    await authorGit(["branch", "task/kept", "origin/task/kept"])
    const watched = capture(author)
    const sources: WatchSource[] = []
    expect(
      await coreQueueCommand(
        repo,
        {
          ...watched.io,
          formatYrdCommand: (argv, cwd) =>
            `cd ${shellQuote(cwd)} && ${shellQuote(process.execPath)} ${shellQuote(join(import.meta.dirname, "../../../bin/yrd.ts"))} ${argv.map(shellQuote).join(" ")}`,
        },
        { command: "list", drafts: true, watch: true },
        {
          queue: "main",
          watchSource: (source) => sources.push(source),
        },
      ),
      watched.stderr(),
    ).toBe(0)
    const source = sources[0]
    if (source?.snapshot === undefined || source.formatCommand === undefined) throw new Error("watch source missing")
    const ready = source.snapshot.rows.find((item) => item.row.branch === "task/kept")
    const remoteOnly = source.snapshot.rows.find((item) => item.row.branch === "other/task/hidden")
    if (ready === undefined || remoteOnly === undefined) throw new Error("draft rows missing from watch source")
    expect(ready.localHead).toBe(ready.row.head)
    expect(remoteOnly.row.at).toBeInstanceOf(Date)
    expect(remoteOnly).not.toHaveProperty("localHead")
    const beforeRefs = await git(["ls-remote", "origin", "refs/heads/*"])
    const submitted = spawnSync("/bin/sh", ["-c", source.formatCommand(["submit", "task/kept"])], {
      cwd: dirname(repo),
      encoding: "utf8",
      timeout: 30000,
    })
    expect(submitted.status, submitted.stderr).toBe(0)
    expect((await readStatus(createEventStore(repo, "origin", git.selection), "main", "task/kept")).commit).toBe(
      ready.row.head,
    )
    expect(await git(["ls-remote", "origin", "refs/heads/*"])).toBe(beforeRefs)
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
    const formattedCommands: { argv: readonly string[]; cwd: string }[] = []
    expect(
      await runYrdProcess(["bun", "yrd", "submit", "--queue", `${destination}#main`, "--dry-run", "--json"], {
        ...accepted.io,
        formatYrdCommand: (argv, cwd) => {
          formattedCommands.push({ argv, cwd })
          return "FORMATTED_DESTINATION_RESUME"
        },
      }),
      accepted.stderr(),
    ).toBe(0)
    expect(accepted.stderr()).toContain("inspect destination")
    expect(accepted.stderr()).toContain("paused by @dev/3 since")
    expect(accepted.stderr()).toContain("FORMATTED_DESTINATION_RESUME")
    expect(formattedCommands).toEqual([
      { argv: ["queue", "resume", "--reason", "<why>", "--queue", `${destination}#main`], cwd: repo },
    ])
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
    expect(error.message).toContain("use a current build of Yrd for queue list")
    expect(error.message).toContain("if that build refuses it too, the declaration itself is malformed")
    expect(error.message).not.toContain("@in")
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
        expect(run.stderr()).toContain("'--release-checkout' '--submodules'")
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
    "discard-sync-failure",
    "discard-no-reason",
    "discard-unbound",
    "discard-bound",
    "discard-mismatch",
    "discard-conflict",
    "discard-held",
    "discard-checked-out",
    "discard-moved",
    "discard-missing",
    "discard-different",
    "discard-unreadable",
    "discard-contained",
    "origin-merged",
    "origin-only",
    "origin-equivalent",
    "origin-unmerged",
    "origin-held",
    "origin-advanced",
    "origin-stale-local-main",
    "origin-stale-default-ref",
    "merged",
    "unmerged",
    "unmerged-held",
    "held",
    "checked-out",
    "own-declared-selected-other",
    "own-malformed-selected-other",
    "root-retired",
    "advanced",
    "protection-error",
    "standalone",
    "missing-protections-reader",
    "stale-host-array",
    "malformed-declaration",
    "unreadable-declaration",
  ] as const)("retires exact %s component work through the declared root's existing log", async (mode) => {
    // The local-only fixture missed origin retirement and an absent local twin.
    // Fresh published-main custody suffices, but host holds and exact-tip races still keep the name.
    const discard = mode.startsWith("discard-")
    const issue = "@i/10-yrd/30704-component-branch-owner-delete"
    const origin = mode.startsWith("origin-")
    const contentIntegrated = mode === "origin-equivalent" || mode === "origin-held"
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
      (discard && mode !== "discard-contained") ||
      mode === "unmerged" ||
      mode === "unmerged-held" ||
      mode === "advanced" ||
      mode === "origin-advanced" ||
      contentIntegrated ||
      mode === "origin-unmerged" ||
      mode === "origin-stale-local-main" ||
      mode === "origin-stale-default-ref"
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
        [
          "unmerged component work",
          ...(discard && mode !== "discard-unbound" ? ["", `Refs: ${issue}`] : []),
          ...(mode === "discard-conflict" ? ["Refs: @i/10-yrd/other"] : []),
        ].join("\n"),
      ])
      await git(["checkout", "--quiet", "main"])
    } else {
      await git(["branch", branch])
    }
    const actualTip = (await git(["rev-parse", "refs/heads/" + branch])).trim()
    const tip = mode === "advanced" || mode === "origin-advanced" || mode === "discard-moved" ? baseTip : actualTip
    // Explicit retirement must distinguish integrated content from ancestry (30396).
    // Existing origin-only rows use ancestors, and queue-backed draft rows have an ending event.
    // Independently delivered content plus later main work also defeats direct tree equality.
    let integratedMain: string | undefined
    if (contentIntegrated) {
      const publisher = gitIn(seed)
      writeFileSync(join(seed, "private.txt"), "reviewed unmerged work\n")
      writeFileSync(join(seed, "later.txt"), "independent main work\n")
      await publisher(["add", "private.txt", "later.txt"])
      await publisher(["commit", "--quiet", "-m", "independent integration and later work"])
      await publisher(["push", "--quiet", "origin", "main"])
      integratedMain = (await publisher(["rev-parse", "HEAD"])).trim()
      await git(["fetch", "--quiet", "origin", "main"])
      await expect(git(["merge-base", "--is-ancestor", actualTip, integratedMain])).rejects.toBeInstanceOf(GitExit)
      expect(
        (
          await git([
            "-c",
            "core.commitGraph=false",
            "merge-tree",
            "--write-tree",
            "--no-messages",
            integratedMain,
            actualTip,
          ])
        ).trim(),
      ).toBe((await git(["rev-parse", `${integratedMain}^{tree}`])).trim())
      expect((await git(["rev-parse", `${actualTip}^{tree}`])).trim()).not.toBe(
        (await git(["rev-parse", `${integratedMain}^{tree}`])).trim(),
      )
    }
    if (discard) await git(["push", "--quiet", "origin", `refs/heads/${branch}:refs/heads/${branch}`])
    if (origin) {
      await git(["push", "--quiet", "origin", `refs/heads/${branch}:refs/heads/${branch}`])
      if (mode === "origin-only" || mode === "origin-equivalent" || mode === "origin-unmerged") {
        await git(["update-ref", "-d", `refs/heads/${branch}`, actualTip])
      }
      // The local main stays stale: a local-only authority reader must miss this accepted head.
      if (mode === "origin-stale-local-main") await git(["push", "--quiet", "origin", `${actualTip}:refs/heads/main`])
      if (mode === "origin-stale-default-ref") {
        await git(["push", "--quiet", "origin", `${actualTip}:refs/heads/trunk`])
        await gitIn(join(dirname(seed), "remote.git"))(["symbolic-ref", "HEAD", "refs/heads/trunk"])
        await git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"])
      }
    }
    if (mode === "checked-out" || mode === "discard-checked-out") await git(["checkout", "--quiet", branch])
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
    let protectionReads = 0
    run.io.localBranchProtections = async () => {
      if (++protectionReads === 3 && ["discard-missing", "discard-different", "discard-unreadable"].includes(mode)) {
        const logs = join(await workdirOf(rootGit), "logs")
        const path = readdirSync(logs)
          .filter((name) => name.endsWith(".jsonl"))
          .map((name) => join(logs, name))
          .find((path) => readFileSync(path, "utf8").includes("local-discard"))!
        const text = readFileSync(path, "utf8")
        writeFileSync(
          path,
          mode === "discard-unreadable"
            ? "not json\n"
            : mode === "discard-different"
              ? text.replace("explicit reviewed component drop", "different call")
              : text
                  .split("\n")
                  .filter((line) => !line.includes("local-discard"))
                  .join("\n"),
        )
      }
      if (mode === "protection-error") throw new Error("host protection authority unavailable")
      // A launcher from a checkout older than the { protections, evidence } answer still returns the bare array (30693).
      if (mode === "stale-host-array") return [] as unknown as LocalBranchProtectionResult
      return {
        protections:
          mode === "held" || mode === "unmerged-held" || mode === "origin-held" || mode === "discard-held"
            ? ["fixture owner hold"]
            : [],
        evidence: [],
      }
    }
    if (mode === "standalone") run.io.localBranchProtections = null
    let io = run.io
    if (mode === "missing-protections-reader") {
      // Missing wiring must fail statically and preserve the branch at runtime
      // when an untyped embedder bypasses the required host contract.
      // @ts-expect-error A standalone caller must explicitly select null.
      io = { cwd: child, stdout: run.io.stdout, stderr: run.io.stderr }
    }
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
    const argv = [
      "bun",
      "yrd",
      "drop",
      branch,
      origin ? "--retire" : "--local",
      "--tip",
      tip,
      ...(origin || mode === "discard-unbound"
        ? []
        : ["--issue", discard ? (mode === "discard-mismatch" ? "@i/10-yrd/other" : issue) : "28824"]),
      ...(discard ? ["--discard"] : []),
      "--reason",
      mode === "discard-no-reason" ? "" : "explicit reviewed component drop",
      "--submitter",
      "fixture",
      "--json",
      ...(selectedOther === undefined ? [] : ["--queue", `${join(dirname(selectedOther), "remote.git")}#main`]),
    ]
    let syncedDecision = false
    const nativeFsync = fs.fsyncSync
    const sync = discard
      ? vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
          const text = readFileSync(fd, "utf8")
          if (text.includes('"intent":"local-discard"')) {
            syncedDecision = true
            if (mode === "discard-sync-failure") throw new Error("injected log fsync failure")
          }
          nativeFsync(fd)
        })
      : undefined
    const exit = await runYrdProcess(argv, io).finally(() => {
      unreadable?.mockRestore()
      sync?.mockRestore()
    })
    if (discard) {
      const removed = ["discard-unbound", "discard-bound", "discard-contained"].includes(mode)
      expect(exit, run.stdout() + run.stderr()).toBe(removed ? 0 : 1)
      const report = JSON.parse(run.stdout()) as { removed: unknown[]; kept: { detail?: string }[]; failed: unknown[] }
      expect(report.failed).toEqual([])
      expect(report.removed).toHaveLength(removed ? 1 : 0)
      expect(report.kept).toHaveLength(removed ? 0 : 1)
      expect((await git(["for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`])).trim()).toBe(
        removed ? "" : actualTip,
      )
      expect((await git(["symbolic-ref", "HEAD"])).trim()).toBe(
        mode === "discard-checked-out" ? `refs/heads/${branch}` : "refs/heads/main",
      )
      expect(await git(["for-each-ref", "refs/archive/", "refs/yrd/"])).toBe("")
      expect((await git(["ls-remote", "origin", `refs/heads/${branch}`, "refs/archive/*", "refs/yrd/*"])).trim()).toBe(
        `${actualTip}\trefs/heads/${branch}`,
      )
      const logs = join(await workdirOf(rootGit), "logs")
      if (!["discard-unreadable"].includes(mode)) {
        const rows = readdirSync(logs)
          .filter((name) => name.endsWith(".jsonl"))
          .flatMap((name) => readRunLog(logs, name.slice(0, -6)))
        const decisions = rows.filter((row) => row.intent === "local-discard")
        if (["discard-unbound", "discard-bound"].includes(mode)) {
          // The procedural value call must be visible in the actual cleanup report, not only its log.
          expect(report.removed).toEqual([
            expect.objectContaining({ intent: "local-discard", actor: "fixture", uniqueCommits: 1 }),
          ])
          expect((report.removed[0] as { issue?: string }).issue).toBe(mode === "discard-bound" ? issue : undefined)
          expect(syncedDecision).toBe(true)
          expect(decisions).toEqual([
            expect.objectContaining({
              kind: "local-branch-retirement",
              repo: child,
              branch,
              head: tip,
              actor: "fixture",
              reason: "explicit reviewed component drop",
              pid: process.pid,
              uniqueCommits: 1,
            }),
          ])
          expect(decisions[0]?.issue).toBe(mode === "discard-bound" ? issue : undefined)
          const result = rows.findIndex((row) => row.kind === "local-branch-retirement" && row.outcome === "removed")
          expect(rows.indexOf(decisions[0]!)).toBeLessThan(result)
        }
        if (
          [
            "discard-contained",
            "discard-held",
            "discard-checked-out",
            "discard-moved",
            "discard-mismatch",
            "discard-conflict",
            "discard-no-reason",
          ].includes(mode)
        ) {
          expect(decisions).toEqual([])
        }
      }
      if (["discard-missing", "discard-different", "discard-unreadable", "discard-sync-failure"].includes(mode)) {
        expect(report.kept[0]?.detail).toContain(logs)
      }
      return
    }
    const failure =
      mode === "protection-error" ||
      mode === "missing-protections-reader" ||
      mode === "stale-host-array" ||
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
      if (mode === "missing-protections-reader") {
        expect(run.stdout() + run.stderr()).toContain(
          "localBranchProtections authority reader is missing; standalone callers must explicitly pass null",
        )
      }
      if (mode === "stale-host-array") {
        expect(run.stdout() + run.stderr()).toContain(
          "localBranchProtections returned an array, not { protections, evidence }",
        )
      }
      if (mode === "unreadable-declaration") expect(run.stderr()).toContain("EACCES")
      if (mode === "own-declared-selected-other") expect(run.stderr()).toContain("own origin target declares")
      if (mode === "own-malformed-selected-other") expect(run.stderr()).toContain("does not parse")
      if (ownSelectedOther) return
      if (mode === "malformed-declaration" || mode === "unreadable-declaration") return
    } else {
      const keptOnly =
        mode === "unmerged" ||
        mode === "held" ||
        mode === "unmerged-held" ||
        mode === "advanced" ||
        mode === "checked-out" ||
        mode === "origin-held" ||
        mode === "origin-equivalent" ||
        mode === "origin-unmerged" ||
        mode === "origin-advanced"
      // A kept-only retirement is not success: the component path now matches
      // the root drop --local rule (30266, 30094): kept and removed nothing exits 1.
      expect(exit, run.stdout() + run.stderr()).toBe(keptOnly ? 1 : 0)
    }
    if (mode === "origin-equivalent" || mode === "origin-unmerged") {
      const report = JSON.parse(run.stdout()) as { failed: unknown[]; removed: unknown[] }
      expect(report.failed).toEqual([])
      expect((await git(["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`])).trim()).toBe("")
      // A component store has no chain: content equality alone keeps and reports the branch (30683).
      expect(report).toMatchObject({ removed: [], kept: [{ branch, head: tip }] })
      expect((await git(["ls-remote", "origin", `refs/heads/${branch}`])).trim()).toBe(`${tip}\trefs/heads/${branch}`)
      expect((await git(["ls-remote", "origin", "refs/archive/*"])).trim()).toBe("")
      expect((await git(["ls-remote", "origin", "refs/yrd/*"])).trim()).toBe("")
      expect((await git(["rev-parse", "refs/heads/main"])).trim()).toBe(baseTip)
      return
    }
    if (origin) {
      const report = JSON.parse(run.stdout()) as {
        removed: { branch: string; head: string; custody: { kind: string; ref: string; tip: string } }[]
        kept: { branch: string }[]
        failed: unknown[]
      }
      expect(report.failed).toEqual([])
      if (mode === "origin-held" || mode === "origin-advanced") {
        expect(report.removed).toEqual([])
        expect(report.kept).toEqual([expect.objectContaining({ branch })])
        expect((await git(["ls-remote", "origin", `refs/heads/${branch}`])).trim()).toBe(
          `${actualTip}\trefs/heads/${branch}`,
        )
      } else {
        expect(report.kept).toEqual([])
        expect(report.removed).toEqual([
          expect.objectContaining({
            branch,
            head: tip,
            custody: {
              kind: "published-main",
              ref: mode === "origin-stale-default-ref" ? "refs/heads/trunk" : "refs/heads/main",
              tip: mode === "origin-stale-local-main" || mode === "origin-stale-default-ref" ? actualTip : baseTip,
            },
          }),
        ])
        expect((await git(["ls-remote", "origin", `refs/heads/${branch}`])).trim()).toBe("")
        expect((await git(["ls-remote", "origin", "refs/archive/*", "refs/yrd/*"])).trim()).toBe("")
        const retry = capture(child)
        retry.io.localBranchProtections = run.io.localBranchProtections
        expect(
          await runYrdProcess(mode === "origin-merged" ? argv.filter((arg) => arg !== "--json") : argv, retry.io),
          retry.stderr(),
        ).toBe(0)
        if (mode === "origin-merged") {
          expect(retry.stdout()).toContain(`origin retirement in ${child}: retired 1, kept 0, failed 0`)
          const logs = join(await workdirOf(rootGit), "logs")
          const records = readdirSync(logs)
            .filter((name) => name.endsWith(".jsonl"))
            .flatMap((name) => readRunLog(logs, name.slice(0, -".jsonl".length)))
          expect(records).toContainEqual(
            expect.objectContaining({
              kind: "observation",
              scope: "branch-retirement",
              branch,
              reason: expect.stringContaining("retired origin"),
            }),
          )
          expect(records).not.toContainEqual(expect.objectContaining({ kind: "local-branch-retirement", branch }))
        } else {
          expect(JSON.parse(retry.stdout())).toMatchObject({
            removed: [
              expect.objectContaining({ branch, head: tip, detail: expect.stringContaining("already retired") }),
            ],
            kept: [],
            failed: [],
          })
        }
      }
      expect((await git(["rev-parse", "refs/heads/main"])).trim()).toBe(baseTip)
      return
    }
    if (!failure) {
      const report = JSON.parse(run.stdout()) as {
        removed: { branch: string; head: string; archiveRef?: string }[]
        kept: { branch: string; detail?: string; archiveRef?: string }[]
        failed: unknown[]
      }
      expect(report.failed).toEqual([])
      if (
        mode === "unmerged" ||
        mode === "held" ||
        mode === "unmerged-held" ||
        mode === "advanced" ||
        mode === "checked-out"
      ) {
        expect(report.removed).toEqual([])
        expect(report.kept).toEqual([
          expect.objectContaining({ branch, head: actualTip, detail: expect.stringContaining("; branch kept") }),
        ])
        expect(report.kept[0]).not.toHaveProperty("archiveRef")
        expect((await git(["rev-parse", "refs/heads/" + branch])).trim()).toBe(actualTip)
        // An unmerged component branch is kept and reported, with no archive anywhere (30683).
        expect((await git(["for-each-ref", "--format=%(refname)", "refs/archive/"])).trim()).toBe("")
        expect((await git(["ls-remote", "origin", "refs/archive/*"])).trim()).toBe("")
      } else {
        expect(report.removed).toEqual([expect.objectContaining({ branch, head: tip })])
        expect((await git(["for-each-ref", "--format=%(objectname)", "refs/heads/" + branch])).trim()).toBe("")
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
          .map(
            (line) =>
              JSON.parse(line) as {
                kind?: string
                repo?: string
                branch?: string
                head?: string
                outcome?: string
                archive?: string
              },
          ),
      )
    expect(records).toContainEqual(
      expect.objectContaining({ kind: "local-branch-retirement", repo: child, branch, head: tip }),
    )
    // The list reader needs the writer's identity before any retirement outcome exists.
    expect(records).toContainEqual(expect.objectContaining({ kind: "run", command: "drop --local", pid: process.pid }))
    if (failure) {
      const failedRecord = records.find(
        (record) =>
          record.kind === "local-branch-retirement" &&
          record.repo === child &&
          record.branch === branch &&
          record.outcome === "failed",
      )
      expect(failedRecord).toBeDefined()
      if (mode === "protection-error" || mode === "missing-protections-reader" || mode === "stale-host-array") {
        expect(failedRecord).not.toHaveProperty("archive")
      }
    }
  })
})

describe("exact-tip origin retirement of a draft", () => {
  // @failure An archived, delivered origin-only draft is refused because Git's alternate-backed split graph is stale.
  // @level l2; @consumer public drop --retire; @testonly none
  // The plain-repository table below cannot exercise child graph reads. Minimal adaptation of
  // git-super/tests/merge.test.ts's stale-commit-graph fixture (a9aabea); that private test is not a package export.
  it.each(["delivered", "root-conflict", "component-conflict"] as const)(
    "preserves content and custody when retiring an alternate-backed %s draft",
    async (mode) => {
      const repo = await world("{}\n")
      const child = await world(undefined, "component-source")
      const source = gitIn(child)
      const git = gitIn(repo)
      const path = "component"
      await git(["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", child, path])
      await git(["commit", "--quiet", "-am", "declare component"])
      const base = (await git(["rev-parse", "HEAD"])).trim()
      const childBase = (await source(["rev-parse", "HEAD"])).trim()
      writeFileSync(join(child, "delivered.txt"), "delivered component work\n")
      await source(["add", "delivered.txt"])
      await source(["commit", "--quiet", "-m", "component draft"])
      const childDraft = (await source(["rev-parse", "HEAD"])).trim()
      const component = gitIn(join(repo, path))
      await component(["fetch", "--quiet", "origin"])
      await component(["checkout", "--quiet", childDraft])
      await git(["checkout", "--quiet", "--detach", base])
      writeFileSync(join(repo, "delivered.txt"), "delivered root work\n")
      await git(["add", path, "delivered.txt"])
      await git(["commit", "--quiet", "-m", "mixed root and component draft"])
      const head = (await git(["rev-parse", "HEAD"])).trim()
      const branch = "task/30206-archived-draft"
      const archive = `refs/archive/fixture/${branch}`
      await git(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`, `HEAD:${archive}`])
      await git(["checkout", "--quiet", "main"])
      await component(["checkout", "--quiet", childBase])
      const workdir = join(dirname(repo), "queue-workdir")
      await git(["config", "yrd.workdir", workdir])
      const origin = (await git(["config", "--get", "remote.origin.url"])).trim()
      // The public CLI selects this queue-owned path, not the author checkout's graph.
      const repoReader = queueDirectory(workdir, parseQueueAddress(`${origin}#main`))
      mkdirSync(dirname(repoReader), { recursive: true })
      await git(["super", "--repo", repo, "worktree", "add", repoReader, base])
      const reader = gitIn(repoReader)
      const readerChild = gitIn(join(repoReader, path))
      await readerChild(["checkout", "--quiet", mode === "component-conflict" ? childBase : childDraft])
      await readerChild(["commit-graph", "write", "--reachable", "--split"])
      for (const step of [1, 2]) {
        writeFileSync(join(repoReader, path, "later.txt"), `later component work ${step}\n`)
        await readerChild(["add", "later.txt"])
        await readerChild(["commit", "--quiet", "-m", `component work after graph ${step}`])
      }
      await readerChild(["push", "--quiet", "origin", "HEAD:refs/heads/later-delivered-work"])
      writeFileSync(
        join(repoReader, "delivered.txt"),
        mode === "root-conflict" ? "conflicting root work\n" : "delivered root work\n",
      )
      writeFileSync(join(repoReader, "later.txt"), "later independent root work\n")
      await reader(["add", path, "delivered.txt", "later.txt"])
      await reader(["commit", "--quiet", "-m", "independently delivered work and later main edits"])
      const main = (await reader(["rev-parse", "HEAD"])).trim()
      await reader(["push", "--quiet", "origin", "HEAD:refs/heads/main"])
      await createQueue(repoReader, "main", main, new Date())
      expect((await resolveQueueLocation(repoReader, undefined, process.env)).repo).toBe(repoReader)
      const mainTree = (await reader(["rev-parse", `${main}^{tree}`])).trim()
      const merge = ["merge-tree", "--write-tree", "--no-messages", main, head]
      if (mode === "delivered") {
        await expect(reader(["-c", "core.commitGraph=true", ...merge])).rejects.toThrow("Could not read")
        expect(reader.lastInvocation?.result?.exitCode).toBe(1)
        await expect(reader(merge)).rejects.toThrow("Could not read")
        expect((await reader(["-c", "core.commitGraph=false", ...merge])).trim()).toBe(mainTree)
        expect(reader.lastInvocation?.result?.stderr).toBe("")
      } else {
        await expect(reader(["-c", "core.commitGraph=false", ...merge])).rejects.toBeInstanceOf(GitExit)
        // CTO discriminator: real ordinary conflicts must be exit 1 with empty stderr under --no-messages.
        expect(reader.lastInvocation?.result).toMatchObject({ exitCode: 1, stderr: "" })
      }
      expect((await reader(["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`])).trim()).toBe("")
      expect((await reader(["ls-remote", "origin", archive])).trim()).toBe(`${head}\t${archive}`)
      const output = capture(repoReader)
      const code = await runYrdProcess(
        ["bun", "yrd", "drop", branch, "--retire", "--tip", head, "--reason", archive, "--json"],
        output.io,
      )
      const store = createEventStore(repoReader, "origin", reader.selection)
      if (mode === "delivered") {
        expect(code, output.stderr()).toBe(0)
        expect(JSON.parse(output.stdout())).toMatchObject({ head, main: { ref: "refs/heads/main", tip: main } })
        expect((await reader(["ls-remote", "origin", `refs/heads/${branch}`])).trim()).toBe("")
        expect(await readStatus(store, "main", branch)).toMatchObject({ status: "cancelled", commit: head })
        const events = await (await openEvents({ ...store, ref: changesRef("main", branch) })).events()
        expect(events.at(-1)).toMatchObject({ type: "cancelled", links: [head] })
      } else {
        expect(code).not.toBe(0)
        expect(output.stderr()).toContain(`merging into fresh refs/heads/main@${main} changes main`)
        expect((await reader(["ls-remote", "origin", `refs/heads/${branch}`])).trim()).toBe(
          `${head}\trefs/heads/${branch}`,
        )
        expect((await listChanges(store, "main")).size).toBe(0)
      }
      expect((await reader(["ls-remote", "origin", "refs/heads/main"])).trim()).toBe(`${main}\trefs/heads/main`)
      expect((await reader(["ls-remote", "origin", archive])).trim()).toBe(`${head}\t${archive}`)
      expect((await reader(["rev-parse", "HEAD^{tree}"])).trim()).toBe(mainTree)
    },
  )

  // Ended-only cases miss safe never-submitted work and its required ending fold.
  // Use the real origin and Git merge result: matching trees are not ancestry proof.
  it.each([
    "ancestor",
    "equivalent",
    "equivalent-human",
    "unmerged",
    "already-open",
    "advanced",
    "held",
    "held-later",
    "opened-later",
  ] as const)("retires a %s draft only under fresh-main custody and its exact tip", async (mode) => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const base = (await git(["rev-parse", "HEAD"])).trim()
    const queueTip = await createQueue(repo, "main", base, new Date())
    const branch = "task/1234-draft"
    await git(["checkout", "--quiet", "-b", branch])
    writeFileSync(join(repo, "draft.txt"), "already accepted work\n")
    await git(["add", "draft.txt"])
    await git(["commit", "--quiet", "-m", "draft work"])
    const head = (await git(["rev-parse", "HEAD"])).trim()
    await git(["push", "--quiet", "origin", `refs/heads/${branch}`])
    await git(["checkout", "--quiet", "main"])
    if (mode === "ancestor") await git(["merge", "--ff-only", "--quiet", head])
    else {
      const file = mode === "unmerged" ? "different.txt" : "draft.txt"
      writeFileSync(join(repo, file), "already accepted work\n")
      await git(["add", file])
      await git(["commit", "--quiet", "-m", "independent main work"])
    }
    await git(["push", "--quiet", "origin", "main"])
    const main = (await git(["rev-parse", "HEAD"])).trim()
    if (mode === "already-open") {
      const chain = await openEvents({
        ...createEventStore(repo, "origin", git.selection),
        ref: changesRef("main", branch),
      })
      await chain.append([changeInput("opened", { queueTip, at: new Date(), commit: head, by: "concurrent writer" })], {
        expect: null,
      })
    }
    const output = capture(repo)
    let reads = 0
    output.io.localBranchProtections = async () => {
      reads++
      if (mode === "held" || (mode === "held-later" && reads === 2)) {
        return { protections: ["fixture draft hold"], evidence: [] }
      }
      if (mode === "opened-later" && reads === 2) {
        const chain = await openEvents({
          ...createEventStore(repo, "origin", git.selection),
          ref: changesRef("main", branch),
        })
        await chain.append(
          [changeInput("opened", { queueTip, at: new Date(), commit: head, by: "concurrent writer" })],
          { expect: null },
        )
      }
      return { protections: [], evidence: [] }
    }
    const code = await runYrdProcess(
      [
        "bun",
        "yrd",
        "drop",
        branch,
        "--retire",
        "--tip",
        mode === "advanced" ? base : head,
        "--reason",
        "retire exact work already accepted by main",
        "--submitter",
        "fixture",
        ...(mode === "equivalent-human" ? [] : ["--json"]),
      ],
      output.io,
    )
    const store = createEventStore(repo, "origin", git.selection)
    if (
      mode === "unmerged" ||
      mode === "already-open" ||
      mode === "advanced" ||
      mode === "held" ||
      mode === "held-later" ||
      mode === "opened-later"
    ) {
      expect(code).not.toBe(0)
      expect((await git(["ls-remote", "origin", `refs/heads/${branch}`])).trim()).toBe(`${head}\trefs/heads/${branch}`)
      if (mode === "opened-later" || mode === "already-open") {
        expect(await readStatus(store, "main", branch)).toMatchObject({ status: "queued", commit: head })
      } else expect((await listChanges(store, "main")).size).toBe(0)
      if (mode === "held" || mode === "held-later") expect(output.stderr()).toContain("fixture draft hold")
      if (mode === "already-open") {
        expect(output.stderr()).toContain(`${branch}: drop --retire requires an already-ended change; found queued`)
      }
      if (mode === "unmerged") {
        expect(output.stderr()).toContain(`merging into fresh refs/heads/main@${main} changes main`)
        expect(output.stderr()).toContain("keep this draft or explicitly abandon its unmerged work with a reason")
        expect(output.stderr()).not.toContain(`yrd drop ${branch} --reason <why>`)
      }
      if (mode === "unmerged" || mode === "already-open") {
        const printed = output.stderr().split("to end and drop this branch now: ")[1]?.trim()
        expect(printed, output.stderr()).toBeDefined()
        const remedyArgv = [
          ...printed!
            .split(" && ")
            .at(-1)!
            .matchAll(/'([^']*)'/gu),
        ].map((match) => match[1]!)
        const followUp = capture(repo)
        const remedyCode = await runYrdProcess(
          ["bun", "yrd", ...remedyArgv, "--submitter", "fixture", "--json"],
          followUp.io,
        )
        expect(remedyCode, followUp.stderr()).toBe(0)
        expect((await git(["ls-remote", "origin", `refs/heads/${branch}`])).trim()).toBe("")
        expect(await readStatus(store, "main", branch)).toMatchObject({
          status: "cancelled",
          reason: "dropped",
          commit: head,
        })
        const droppedEvents = await (await openEvents({ ...store, ref: changesRef("main", branch) })).events()
        expect(droppedEvents.at(-1)).toMatchObject({ type: "cancelled", links: [head] })
      }
      if (mode === "advanced") {
        expect(output.stderr()).toContain(`expected ${base} at origin, found ${head}`)
        // 30277: a custody failure says which repository the retire read.
        expect(output.stderr()).toContain(`; resolved repository ${repo}`)
      }
      return
    }
    expect(code, output.stderr()).toBe(0)
    if (mode === "equivalent-human") expect(output.stdout()).toContain(`published main refs/heads/main@${main}`)
    else expect(JSON.parse(output.stdout())).toMatchObject({ head, main: { ref: "refs/heads/main", tip: main } })
    expect((await git(["ls-remote", "origin", `refs/heads/${branch}`])).trim()).toBe("")
    expect(await readStatus(store, "main", branch)).toMatchObject({
      status: "cancelled",
      reason: "dropped",
      commit: head,
    })
    const events = await (await openEvents({ ...store, ref: changesRef("main", branch) })).events()
    expect(events.at(-1)).toMatchObject({ type: "cancelled", links: [head] })
    expect((await git(["ls-remote", "origin", "refs/heads/main"])).trim()).toBe(`${main}\trefs/heads/main`)
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
  async function releaseWorld(
    component = false,
    unmergedChild = false,
    binding?: { issue: string; childBindings: readonly string[] },
  ) {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const branch = "task/29600-retained"
    const childMessage =
      binding === undefined
        ? "unmerged component work"
        : ["component work", "", ...binding.childBindings.map((issue) => `Refs: ${issue}`)].join("\n")
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
      if (binding !== undefined && !unmergedChild) {
        await gitIn(child)([
          "-c",
          "user.name=fixture",
          "-c",
          "user.email=fixture@test.invalid",
          "commit",
          "--quiet",
          "--allow-empty",
          "-m",
          childMessage,
        ])
        await gitIn(child)(["push", "--quiet", "origin", "HEAD:main"])
      }
      await git(["commit", "--quiet", "-am", "record exact child"])
      await git(["push", "--quiet", "origin", "main"])
    }
    const target = (await git(["rev-parse", "HEAD"])).trim()
    await createQueue(repo, "main", target, new Date())
    await git(["checkout", "--quiet", "-b", branch])
    if (unmergedChild && child !== undefined) {
      // The root tip pins a child commit that the child's published main lacks.
      writeFileSync(join(child, "unmerged.txt"), "unmerged component work\n")
      await gitIn(child)(["add", "unmerged.txt"])
      await gitIn(child)([
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@test.invalid",
        "commit",
        "--quiet",
        "-m",
        childMessage,
      ])
      // Published on its task branch, as component work is, and absent from the child's main.
      await gitIn(child)(["push", "--quiet", "origin", branch])
      await git(["add", "modules/child"])
    }
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
      binding?.issue ?? "29600",
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
  // Canonical Refs on the exact pinned child tip must survive numeric-name mapping (30704).
  // Existing release cases bind only a numeric issue and cannot expose this lost identity.
  it.each(["attached", "detached", "duplicate"] as const)(
    "selects the %s component by exact-tip binding and preserves retained bytes on root replay",
    async (kind) => {
      const issue = "@i/10-yrd/30704-component-branch-owner-delete"
      const fixture = await releaseWorld(true, false, {
        issue,
        childBindings: kind === "duplicate" ? [issue, issue] : [issue],
      })
      const { spy } = await permitCensus()
      try {
        const rootOnly = releaseCapture(fixture.repo)
        expect(
          await runYrdProcess([...fixture.argv.filter((arg) => arg !== "--submodules"), "--apply"], rootOnly.io),
          rootOnly.stderr(),
        ).toBe(0)
        expect((JSON.parse(rootOnly.stdout()) as ReleaseReport).removed).toHaveLength(1)
        const childGit = gitIn(fixture.child!)
        const childBranch = "task/30704-component-alias"
        const childTip = (await childGit(["rev-parse", "HEAD"])).trim()
        await childGit(["branch", "-m", fixture.branch, childBranch])
        if (kind === "detached") await childGit(["update-ref", "--no-deref", "HEAD", childTip, childTip])
        const before = await childGit([
          "--no-optional-locks",
          "status",
          "--porcelain=v2",
          "-z",
          "--untracked-files=all",
        ])
        const preview = releaseCapture(fixture.repo)
        expect(await runYrdProcess(fixture.argv, preview.io), preview.stderr()).toBe(0)
        const planned = JSON.parse(preview.stdout()) as ReleaseReport
        expect(planned.eligible, JSON.stringify(planned)).toEqual([
          expect.objectContaining({ path: "modules/child", branch: childBranch, head: childTip }),
        ])
        expect(planned.alreadyRetired).toHaveLength(1)
        const applied = releaseCapture(fixture.repo)
        expect(await runYrdProcess([...fixture.argv, "--apply"], applied.io), applied.stderr()).toBe(0)
        const report = JSON.parse(applied.stdout()) as ReleaseReport
        expect(report.removed).toEqual([
          expect.objectContaining({ path: "modules/child", branch: childBranch, head: childTip }),
        ])
        expect(await childGit(["for-each-ref", `refs/heads/${childBranch}`])).toBe("")
        expect((await childGit(["rev-parse", "HEAD"])).trim()).toBe(childTip)
        expect(await childGit(["symbolic-ref", "--quiet", "HEAD"]).catch(() => "")).toBe("")
        expect(await childGit(["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all"])).toBe(
          before,
        )
        expect(readFileSync(join(fixture.child!, "private.bin"))).toEqual(Buffer.from([0, 255, 12, 8]))
        for (const files of fixture.checkoutFiles.values()) {
          expect([readFileSync(files.lease), readFileSync(files.lock), readFileSync(files.index)]).toEqual(files.bytes)
        }
        expect(await childGit(["for-each-ref", "refs/heads/task/29600-unselected"])).not.toBe("")
        for (const repo of [fixture.repo, fixture.child!]) {
          expect(await gitIn(repo)(["for-each-ref", "refs/archive/"])).toBe("")
          expect(await gitIn(repo)(["ls-remote", "origin", "refs/archive/*"])).toBe("")
        }
        const events = (
          await readEventQueueWithChanges(createEventStore(fixture.repo, "origin", fixture.git.selection), "main")
        ).histories.get(fixture.branch)!.events
        expect(events.filter((event) => event.type === "cancelled")).toHaveLength(1)
      } finally {
        spy.mockRestore()
      }
    },
    60_000,
  )
  // Explicit identity must beat numeric names and root replay; discovery errors precede ALL mutation.
  it.each(["attached mismatch", "detached mismatch", "resumed mismatch", "conflicting", "ambiguous"] as const)(
    "preserves refs and checkout bytes for %s exact-tip bindings",
    async (kind) => {
      const mismatch = kind.endsWith("mismatch")
      const issue = mismatch ? "29600" : "@i/10-yrd/30704-component-branch-owner-delete"
      const other = "@i/10-yrd/29601-other"
      const fixture = await releaseWorld(true, false, {
        issue,
        childBindings: mismatch ? [other] : kind === "conflicting" ? [issue, other] : [issue],
      })
      const { spy } = await permitCensus()
      try {
        if (mismatch) {
          const rootOnly = releaseCapture(fixture.repo)
          expect(
            await runYrdProcess([...fixture.argv.filter((arg) => arg !== "--submodules"), "--apply"], rootOnly.io),
            rootOnly.stderr(),
          ).toBe(0)
          expect((JSON.parse(rootOnly.stdout()) as ReleaseReport).removed).toHaveLength(1)
        }
        const childGit = gitIn(fixture.child!)
        const childTip = (await childGit(["rev-parse", "HEAD"])).trim()
        if (kind === "detached mismatch" || kind === "ambiguous") {
          await childGit(["branch", "-m", fixture.branch, "task/29600-alias"])
        }
        if (kind === "ambiguous") await childGit(["branch", "task/30704-second"])
        if (kind === "detached mismatch" || kind === "resumed mismatch" || kind === "ambiguous") {
          await childGit(["update-ref", "--no-deref", "HEAD", childTip, childTip])
        }
        const before = new Map<string, { refs: string; head: string; status: string }>()
        for (const repo of fixture.checkoutFiles.keys()) {
          const read = gitIn(repo)
          before.set(repo, {
            refs: await read(["for-each-ref", "refs/heads/", "refs/archive/"]),
            head: await read(["symbolic-ref", "--quiet", "HEAD"]).catch(() => ""),
            status: await read(["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all"]),
          })
        }
        const applied = releaseCapture(fixture.repo)
        if (mismatch) {
          // A host's numeric-only mapper cannot override the observed explicit binding.
          applied.io.branchIssue = ({ branch }) => /^(\d+)-/u.exec(branch.split("/").at(-1) ?? "")?.[1]
        }
        expect(await runYrdProcess([...fixture.argv, "--apply"], applied.io), applied.stderr()).toBe(mismatch ? 0 : 1)
        const report = JSON.parse(applied.stdout()) as ReleaseReport
        expect(report.removed).toEqual([])
        const detail = mismatch ? report.excluded[0]?.reason : report.failed[0]?.detail
        expect(detail).toContain(fixture.child!)
        expect(detail).toContain(childTip)
        expect(detail).toContain(mismatch ? other : kind === "conflicting" ? "conflicting" : "ambiguous")
        if (kind === "conflicting") {
          expect(detail).toContain(issue)
          expect(detail).toContain(other)
        }
        for (const [repo, files] of fixture.checkoutFiles) {
          const read = gitIn(repo)
          expect(await read(["for-each-ref", "refs/heads/", "refs/archive/"])).toBe(before.get(repo)!.refs)
          expect(await read(["symbolic-ref", "--quiet", "HEAD"]).catch(() => "")).toBe(before.get(repo)!.head)
          expect(await read(["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all"])).toBe(
            before.get(repo)!.status,
          )
          expect([readFileSync(files.lease), readFileSync(files.lock), readFileSync(files.index)]).toEqual(files.bytes)
          expect(await read(["ls-remote", "origin", "refs/archive/*"])).toBe("")
        }
        expect((await childGit(["rev-parse", "HEAD"])).trim()).toBe(childTip)
        expect((await listChanges(createEventStore(fixture.repo, "origin", fixture.git.selection), "main")).size).toBe(
          mismatch ? 1 : 0,
        )
      } finally {
        spy.mockRestore()
      }
    },
    60_000,
  )
  // 29721: queue clones do not identify an author's root. Existing release
  // effect tests start at the right root and cannot detect a misdirected hint.
  it.each(["child", "standalone", "outside", "unreadable"] as const)(
    "release hint selects the author root from %s cwd",
    async (context) => {
      const component = context === "child" ? await releaseWorld(true) : undefined
      const queueRepo = component?.child ?? (await world())
      const outside =
        context === "outside" || context === "unreadable" ? outsideRepositoryRoot("yrd-release-hint-") : undefined
      if (outside !== undefined) roots.push(outside)
      if (context === "unreadable") {
        writeFileSync(join(outside!, ".git"), `gitdir: ${join(outside!, "missing-gitdir")}\n`)
      }
      const author = context === "child" ? component!.repo : context === "standalone" ? await world() : undefined
      const output = capture(outside ?? (context === "standalone" ? author! : queueRepo))
      const exit = await coreQueueCommand(
        queueRepo,
        output.io,
        {
          command: "drop-local",
          branch: "task/29600-retained",
          tip: "a".repeat(40),
          by: "fixture",
          issue: "29600",
          reason: "retain checkout",
          releaseCheckout: true,
        },
        { queue: "main" },
      )
      expect(exit, output.stderr()).toBe(2)
      const hint = output.stderr().split("For retained-checkout cleanup, ")[1]
      expect(hint, output.stderr()).toBeDefined()
      if (context === "unreadable") {
        expect(hint).toContain(`cannot read the author superproject at ${outside}`)
        // Git versions word a broken gitfile differently; preserve the failed read and cause.
        expect(hint).toContain(`git rev-parse --show-superproject-working-tree in ${outside}`)
        expect(hint).toMatch(/exited \d+: fatal: \S/u)
        expect(hint).toContain("Run from the superproject that vendors it.")
        expect(hint).not.toContain("&& yrd")
      } else if (author === undefined) {
        expect(hint).not.toContain("&& yrd")
        expect(hint).not.toContain(queueRepo)
        expect(hint).toContain("superproject that vendors it")
      } else {
        expect(hint).toContain(`cd '${author}' && yrd`)
        expect(hint).toContain("preview")
        const unfilled = capture(author)
        expect(
          await runYrdProcess(
            [
              process.execPath,
              "yrd",
              "drop",
              "<root-branch>",
              "--local",
              "--tip",
              "<root-tip>",
              "--issue",
              "29600",
              "--reason",
              "retain checkout",
              "--release-checkout",
            ],
            unfilled.io,
          ),
          unfilled.stderr(),
        ).toBe(2)
        expect(unfilled.stderr()).toContain("replace --tip <root-tip>")
      }
    },
  )

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
  it.each([
    "liveEnvironmentUse",
    "localBranchProtections",
    "standalone localBranchProtections",
    "empty liveEnvironmentUse",
  ] as const)(
    "refuses release without the %s authority reader",
    async (reader) => {
      const fixture = await releaseWorld()
      const { spy } = await permitCensus()
      try {
        const output = releaseCapture(fixture.repo)
        if (reader === "empty liveEnvironmentUse") output.io.liveEnvironmentUse = vi.fn().mockResolvedValue(undefined)
        else if (reader === "standalone localBranchProtections") output.io.localBranchProtections = null
        else Reflect.deleteProperty(output.io, reader)
        expect(await runYrdProcess([...fixture.argv, "--apply"], output.io)).toBe(1)
        const report = JSON.parse(output.stdout()) as ReleaseReport
        expect(report.failed[0]?.detail).toContain(
          reader === "empty liveEnvironmentUse"
            ? "live environment-use reader did not return an array"
            : "release-checkout needs the landing launcher's environment authority",
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
      sameIssue: async (a, b) => (a === b ? { same: true } : { same: false, resolved: true }),
      request: { branch: fixture.branch, tip: fixture.tip, issue: "29600", reason: "retain checkout", by: "fixture" },
    })
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0]?.detail).toContain("remote lookup failed: https://repo.invalid/retained.git")
    expect(JSON.stringify(report)).not.toContain("fixture-secret")
    expect(JSON.stringify(report)).not.toContain("fixture-user")
    expect((await fixture.git(["symbolic-ref", "HEAD"])).trim()).toBe(`refs/heads/${fixture.branch}`)
    expect(await fixture.git(["for-each-ref", "refs/archive/"])).toBe("")
  })
  /** @failure A sandboxed caller's incomplete census holds a clean merged
   * branch forever with no reachable cure (29772): the preview hold must carry
   * the uncleared pids and the census receipt, and name the cure a confined
   * caller can take — --apply files a release request for the queue's own
   * round (@cto c8d7113d) — never its own command as a re-run.
   * @level l2 @consumer releaseRetainedCheckouts callers, including the CLI
   */
  it("29772: an uncleared unreadable pid holds the preview and the receipt names the --apply delegation cure", async () => {
    const fixture = await releaseWorld()
    const actual = await vi.importActual<typeof import("removely")>("removely")
    const observed = await actual.inspectProcessCensus({ scope: "same-uid", sources: ["cwd"], deadlineMs: 2000 })
    const uncleared = {
      pid: 424242,
      uid: typeof process.getuid === "function" ? process.getuid() : 0,
      comm: "session-host",
      denied: ["cwd"] as const,
      issues: [{ source: "cwd" as const, resource: "cwd", reason: "denied" as const, code: "EACCES" }],
    }
    const spy = vi.spyOn(removely, "inspectProcessCensus").mockResolvedValue({
      ...observed,
      rows: [],
      coverage: { ...observed.coverage, complete: false, unreadable: [uncleared] },
    } as never)
    try {
      const output = releaseCapture(fixture.repo)
      const report = await releaseRetainedCheckouts({
        repo: fixture.repo,
        git: fixture.git,
        selection: fixture.git.selection,
        io: output.io,
        log: { write: vi.fn() },
        queue: "main",
        remote: "origin",
        sameIssue: async (a, b) => (a === b ? { same: true } : { same: false, resolved: true }),
        request: { branch: fixture.branch, tip: fixture.tip, issue: "29600", reason: "retain checkout", by: "fixture" },
      })
      expect(report.removed).toHaveLength(0)
      expect(report.eligible).toHaveLength(0)
      expect(report.kept).toHaveLength(1)
      const detail = report.kept[0]?.detail ?? ""
      // The pid and its denial stay named (never treated as absent)…
      expect(detail).toContain("needs-delegation")
      expect(detail).toContain("pid 424242 session-host (EACCES)")
      // …the census receipt rides along…
      expect(detail).toContain("census proc: 0 readable, 1 unreadable, 1 uncleared")
      // …and the cure is the one a confined caller can take: --apply files a
      // release request for the queue's own round, whose census reads every pid.
      expect(detail).toContain("--apply files a release request for the queue's own round")
      expect(detail).not.toContain(`yrd 'drop' 'task/29600-retained'`)
      expect(report.needsDelegation).toHaveLength(1)
      expect(report.delegated).toHaveLength(0)
      // 30417: the cure names the discriminator that separates a capable reader
      // from a blind one, and carries this process's own observed value, so a
      // caller cannot mistake the hold for a host-wide /proc restriction.
      expect(detail).toContain("this reader: NoNewPrivs=")
      expect(detail).toMatch(/this reader: NoNewPrivs=(0|1|absent|unreadable), CapEff=/u)
      expect(detail).not.toContain("outside any sandbox restricting /proc reads")
      // Nothing was archived or deleted under an uncertified census.
      expect(await fixture.git(["for-each-ref", "refs/archive/"])).toBe("")
      expect((await fixture.git(["symbolic-ref", "HEAD"])).trim()).toBe(`refs/heads/${fixture.branch}`)
    } finally {
      spy.mockRestore()
    }
  }, 30_000)
  /** @failure The uncertified hold exits 0, so a caller reads "done" while the branch stays (29772); a queued
   * release must read as queued (4), a re-file must match the standing request, and a store this caller
   * cannot write must fail loud and nonzero with nothing released (@cto c8d7113d tool-surface rows).
   * @level l2 @consumer every caller of `yrd drop --release-checkout`, scripts reading its exit code
   */
  it("29772: the CLI exits 1 on an uncertified preview, 4 when --apply queues, and fails loud when the store is unwritable", async () => {
    const fixture = await releaseWorld()
    const actual = await vi.importActual<typeof import("removely")>("removely")
    const observed = await actual.inspectProcessCensus({ scope: "same-uid", sources: ["cwd"], deadlineMs: 2000 })
    const spy = vi.spyOn(removely, "inspectProcessCensus").mockResolvedValue({
      ...observed,
      rows: [],
      coverage: {
        ...observed.coverage,
        complete: false,
        unreadable: [
          {
            pid: 424242,
            uid: typeof process.getuid === "function" ? process.getuid() : 0,
            comm: "session-host",
            denied: ["cwd"],
            issues: [{ source: "cwd", resource: "cwd", reason: "denied", code: "EACCES" }],
          },
          {
            pid: 777,
            uid: typeof process.getuid === "function" ? process.getuid() : 0,
            comm: "sshd-session",
            denied: ["cwd"],
            issues: [{ source: "cwd", resource: "cwd", reason: "denied", code: "EACCES" }],
          },
        ],
      },
    } as never)
    let store: string | undefined
    try {
      const preview = releaseCapture(fixture.repo)
      expect(await runYrdProcess(fixture.argv, preview.io), preview.stderr()).toBe(1)
      const held = JSON.parse(preview.stdout()) as ReleaseReport
      // A pid waived by identity is named with the identity that cleared it; the other stays uncleared.
      // sshd-session, not gpg-agent: hosted Yrd CI runs the published removely, which predates gpg-agent.
      expect(preview.stderr()).toContain(
        "identity-cleared unreadable PIDs: pid 777 sshd-session (EACCES) as sshd-session",
      )
      expect(held.needsDelegation[0]?.detail).toContain("pid 424242 session-host (EACCES)")
      expect(held.needsDelegation[0]?.detail).not.toContain("pid 777")
      expect(held.needsDelegation).toHaveLength(1)
      expect(held.delegated).toHaveLength(0)
      const applied = releaseCapture(fixture.repo)
      expect(await runYrdProcess([...fixture.argv, "--apply"], applied.io), applied.stderr()).toBe(4)
      const queued = JSON.parse(applied.stdout()) as ReleaseReport
      expect(queued.delegated).toHaveLength(1)
      const file = queued.delegated[0]?.file ?? ""
      store = dirname(file)
      expect(existsSync(file)).toBe(true)
      // Re-filing the same release matches the standing request: still queued, still one file.
      const again = releaseCapture(fixture.repo)
      expect(await runYrdProcess([...fixture.argv, "--apply"], again.io), again.stderr()).toBe(4)
      expect(again.stderr()).toContain("release request already stood")
      expect(readdirSync(store)).toEqual([file.slice(store.length + 1)])
      // A store this caller cannot write fails loud, never 0 and never 4, and releases nothing.
      unlinkSync(file)
      chmodSync(store, 0o500)
      const blocked = releaseCapture(fixture.repo)
      expect(await runYrdProcess([...fixture.argv, "--apply"], blocked.io), blocked.stderr()).toBe(1)
      const refused = JSON.parse(blocked.stdout()) as ReleaseReport
      expect(refused.delegated).toHaveLength(0)
      expect(refused.removed).toHaveLength(0)
      expect(refused.failed).toHaveLength(1)
      expect(refused.failed[0]?.detail).toContain("could not be written")
      expect(refused.failed[0]?.detail).toContain("nothing was released")
      expect((await fixture.git(["symbolic-ref", "HEAD"])).trim()).toBe(`refs/heads/${fixture.branch}`)
    } finally {
      if (store !== undefined) chmodSync(store, 0o700)
      spy.mockRestore()
    }
  }, 30_000)

  /** @failure With --apply, a confined caller whose census is incomplete still
   * cannot release the checkout itself, so the release must be delegated: one
   * durable release request, keyed apart from a close request for the same
   * path and carrying its intent, lands in the queue's request store, and
   * nothing is retired or archived by the caller (29772, @cto c8d7113d).
   * @level l2 @consumer releaseRetainedCheckouts callers, including the CLI
   */
  /** @failure 29772 (@cto 585d1eac a): a mixed hold under --apply files nothing, yet the needs-delegation
   * detail promised a release request; the detail must say the request was not filed and name the other hold.
   * @level l2 @consumer the confined seat reading why its --apply did not queue
   */
  it("29772: a mixed hold under --apply files no request and the needs-delegation detail names the other hold", async () => {
    const fixture = await releaseWorld(true, true)
    const workdir = mkdtempSync(join(tmpdir(), "yrd-29772-mixed-hold-"))
    const actual = await vi.importActual<typeof import("removely")>("removely")
    const observed = await actual.inspectProcessCensus({ scope: "same-uid", sources: ["cwd"], deadlineMs: 2000 })
    const spy = vi.spyOn(removely, "inspectProcessCensus").mockResolvedValue({
      ...observed,
      rows: [],
      coverage: {
        ...observed.coverage,
        complete: false,
        unreadable: [
          {
            pid: 424242,
            uid: typeof process.getuid === "function" ? process.getuid() : 0,
            comm: "session-host",
            denied: ["cwd"],
            issues: [{ source: "cwd", resource: "cwd", reason: "denied", code: "EACCES" }],
          },
        ],
      },
    } as never)
    try {
      const output = releaseCapture(fixture.repo)
      const report = await releaseRetainedCheckouts({
        repo: fixture.repo,
        git: fixture.git,
        selection: fixture.git.selection,
        io: output.io,
        log: { write: vi.fn() },
        queue: "main",
        remote: "origin",
        workdir,
        sameIssue: async (a, b) => (a === b ? { same: true } : { same: false, resolved: true }),
        request: {
          branch: fixture.branch,
          tip: fixture.tip,
          issue: "29600",
          reason: "retain checkout",
          by: "fixture",
          submodules: true,
          apply: true,
        },
      })
      expect(report.delegated).toEqual([])
      expect(report.removed).toEqual([])
      expect(report.kept).toContainEqual(expect.objectContaining({ path: "modules/child", reason: "unreached" }))
      const held = report.kept.find((row) => row.reason === "held")
      expect(held?.detail).toContain("needs-delegation")
      expect(held?.detail).toContain("pid 424242 session-host (EACCES)")
      expect(held?.detail).toContain("not filed: ")
      expect(held?.detail).toContain("unreached")
      expect(held?.detail).not.toContain("--apply files a release request")
      expect(report.needsDelegation[0]?.detail).toContain("not filed: ")
      expect(existsSync(join(workdir, "state", "yrd", "env-close-requests"))).toBe(false)
      expect((await fixture.git(["symbolic-ref", "HEAD"])).trim()).toBe(`refs/heads/${fixture.branch}`)
    } finally {
      spy.mockRestore()
    }
  }, 60_000)

  /** @failure 29772 (@cto 585d1eac d): an --apply that kept a row did not do what was asked, yet exited 0; a
   * preview that finds the same hold reports it and exits 0.
   * @level l2 @consumer scripts and seats reading the exit code of drop --release-checkout --apply
   */
  it("29772: --apply that keeps a live-use hold exits 1; the same hold in a preview exits 0", async () => {
    const fixture = await releaseWorld()
    const { spy } = await permitCensus()
    try {
      for (const apply of [false, true]) {
        const output = releaseCapture(fixture.repo)
        output.io.liveEnvironmentUse = async () => [{ path: fixture.repo, reason: "fixture live use" }]
        expect(await runYrdProcess([...fixture.argv, ...(apply ? ["--apply"] : [])], output.io), output.stderr()).toBe(
          apply ? 1 : 0,
        )
        const report = JSON.parse(output.stdout()) as ReleaseReport
        expect(report.removed).toEqual([])
        expect(report.kept).toEqual([
          expect.objectContaining({ reason: "held", detail: expect.stringContaining("live use: fixture live use") }),
        ])
        expect((await fixture.git(["symbolic-ref", "HEAD"])).trim()).toBe(`refs/heads/${fixture.branch}`)
      }
    } finally {
      spy.mockRestore()
    }
  }, 30_000)

  it("29772: --apply with an uncleared unreadable pid files one release request for the queue's own round", async () => {
    const fixture = await releaseWorld()
    const workdir = mkdtempSync(join(tmpdir(), "yrd-29772-release-request-"))
    const actual = await vi.importActual<typeof import("removely")>("removely")
    const observed = await actual.inspectProcessCensus({ scope: "same-uid", sources: ["cwd"], deadlineMs: 2000 })
    const uncleared = {
      pid: 424242,
      uid: typeof process.getuid === "function" ? process.getuid() : 0,
      comm: "session-host",
      denied: ["cwd"] as const,
      issues: [{ source: "cwd" as const, resource: "cwd", reason: "denied" as const, code: "EACCES" }],
    }
    const spy = vi.spyOn(removely, "inspectProcessCensus").mockResolvedValue({
      ...observed,
      rows: [],
      coverage: { ...observed.coverage, complete: false, unreadable: [uncleared] },
    } as never)
    try {
      const output = releaseCapture(fixture.repo)
      const report = await releaseRetainedCheckouts({
        repo: fixture.repo,
        git: fixture.git,
        selection: fixture.git.selection,
        io: output.io,
        log: { write: vi.fn() },
        queue: "main",
        remote: "origin",
        workdir,
        sameIssue: async (a, b) => (a === b ? { same: true } : { same: false, resolved: true }),
        request: {
          branch: fixture.branch,
          tip: fixture.tip,
          issue: "29600",
          reason: "retain checkout",
          by: "fixture",
          apply: true,
        },
      })
      expect(report.removed).toHaveLength(0)
      expect(report.failed).toHaveLength(0)
      expect(report.delegated).toHaveLength(1)
      const queued = report.delegated[0]
      const store = join(workdir, "state", "yrd", "env-close-requests")
      expect(queued?.file.startsWith(`${store}/`)).toBe(true)
      expect(queued?.file.endsWith(".release.json")).toBe(true)
      expect(readdirSync(store)).toHaveLength(1)
      const filed = JSON.parse(readFileSync(queued?.file ?? "", "utf8")) as Record<string, unknown>
      expect(filed).toMatchObject({
        intent: "release-checkout",
        path: fixture.repo,
        predicate: "direct-admission",
        release: { branch: fixture.branch, tip: fixture.tip, issue: "29600", reason: "retain checkout" },
      })
      // The pid stays named in the caller's receipt even though the round decides.
      expect(queued?.detail).toContain("pid 424242 session-host (EACCES)")
      expect(queued?.detail).toContain("queued")
      expect(await fixture.git(["for-each-ref", "refs/archive/"])).toBe("")
      expect((await fixture.git(["symbolic-ref", "HEAD"])).trim()).toBe(`refs/heads/${fixture.branch}`)
    } finally {
      spy.mockRestore()
    }
  }, 30_000)
  /** @failure A caller of `drop --release-checkout` that carries no environment
   * authority is told to use the landing launcher (30421). The message must name
   * the supported entry point, never an internal reader the caller cannot
   * supply, so the two entries cannot drift apart without the caller seeing why.
   * @level l2 @consumer releaseRetainedCheckouts callers
   */
  it("30421: a caller without the launcher's authority is pointed at the launcher", async () => {
    const fixture = await releaseWorld()
    const { spy } = await permitCensus()
    try {
      const output = releaseCapture(fixture.repo)
      delete (output.io as { liveEnvironmentUse?: () => Promise<readonly unknown[]> }).liveEnvironmentUse
      const report = await releaseRetainedCheckouts({
        repo: fixture.repo,
        git: fixture.git,
        selection: fixture.git.selection,
        io: output.io,
        log: { write: vi.fn() },
        queue: "main",
        remote: "origin",
        sameIssue: async (a, b) => (a === b ? { same: true } : { same: false, resolved: true }),
        request: { branch: fixture.branch, tip: fixture.tip, issue: "29600", reason: "retain checkout", by: "fixture" },
      })
      expect(report.failed).toHaveLength(1)
      const detail = report.failed[0]?.detail ?? ""
      expect(detail).toContain("tools/yrd-runtime.mjs")
      expect(detail).not.toContain("liveEnvironmentUse")
    } finally {
      spy.mockRestore()
    }
  }, 30_000)
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
        // The root's name selects the detached child's branch; another issue branch at its pin stays (30683).
        if (kind === "child") expect((await git(["rev-parse", "refs/heads/task/29600-unselected"])).trim()).toBe(tip)
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
  // The root's ending is published before its name goes (30683): when publication fails the root
  // branch stays, and the retry publishes exactly one ending, then removes the name.
  it("keeps the root name when its ending cannot publish, then publishes exactly one ending on retry", async () => {
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
      expect(partial.removed).toEqual([])
      expect(partial.failed).toHaveLength(1)
      expect((await fixture.git(["rev-parse", `refs/heads/${fixture.branch}`])).trim()).toBe(fixture.tip)
      expect(await remote(["for-each-ref", `refs/yrd/main/changes/${fixture.branch}`])).toBe("")
      await remote(["config", "--unset", "receive.hideRefs"])
      const retry = releaseCapture(fixture.repo)
      expect(await runYrdProcess([...fixture.argv, "--apply"], retry.io), retry.stdout() + retry.stderr()).toBe(0)
      const completed = JSON.parse(retry.stdout()) as ReleaseReport
      expect(completed.alreadyRetired).toEqual([])
      expect(completed.removed).toHaveLength(1)
      expect(await fixture.git(["for-each-ref", `refs/heads/${fixture.branch}`])).toBe("")
      const history = (
        await readEventQueueWithChanges(createEventStore(fixture.repo, "origin", fixture.git.selection), "main")
      ).histories.get(fixture.branch)!
      expect(history.events.filter((event) => event.type === "cancelled")).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  }, 30_000)
  it.each(["child", "root"])(
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
        // The root's ending precedes the root's removal and follows its descendants' (30683).
        expect((await listChanges(store, "main")).size).toBe(failedRepo === "root" ? 1 : 0)
        expect(lock).toBeTypeOf("string")
        unlinkSync(lock!)
        const retry = releaseCapture(fixture.repo)
        expect(await runYrdProcess([...fixture.argv, "--apply"], retry.io), retry.stdout() + retry.stderr()).toBe(0)
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
  it("previews by default, then retains dirty/private/index/lease/lock bytes with the root's event custody, the child's main custody and one root ending", async () => {
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
        // The root's dropped event keeps its tip before the root name goes; the child's published main
        // keeps the child's head, and nothing is archived (30683).
        if (repo === fixture.repo && (await gitIn(repo)(["symbolic-ref", "--quiet", "HEAD"]).catch(() => "")) === "") {
          const history = (
            await readEventQueueWithChanges(createEventStore(fixture.repo, "origin", fixture.git.selection), "main")
          ).histories.get(branch)
          expect(history?.events.some((event) => event.type === "cancelled" && event.links.includes(tip))).toBe(true)
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
        expect(await read(["ls-remote", "origin", "refs/archive/*"])).toBe("")
      }
      expect(await gitIn(fixture.child!)(["rev-parse", "refs/heads/task/29600-unselected"])).not.toBe("")
      const events = (
        await readEventQueueWithChanges(createEventStore(fixture.repo, "origin", fixture.git.selection), "main")
      ).histories.get(fixture.branch)!.events
      expect(events.filter((event) => event.type === "cancelled")).toHaveLength(1)
      const ending = events.find((event) => event.type === "cancelled")!
      expect(ending.content).not.toContain("fixture-secret")
      expect(ending.content).not.toContain("fixture-user")
      expect(ending.links).toContain(fixture.tip)
      for (const row of report.removed) {
        for (const value of [row.repo, row.head, row.remote]) expect(ending.content).toContain(value)
      }
    } finally {
      spy.mockRestore()
    }
  }, 60_000)
  // @failure An unmerged component branch released with --submodules is deleted with no custody (30683).
  it.each(["name", "exact-tip"] as const)(
    "keeps and reports an unmerged component with %s binding and releases nothing",
    async (kind) => {
      const issue = "@i/10-yrd/30704-component-branch-owner-delete"
      const fixture = await releaseWorld(
        true,
        true,
        kind === "exact-tip" ? { issue, childBindings: [issue] } : undefined,
      )
      fixture.argv.push("--queue", `${fixture.repo}#main`)
      const { spy } = await permitCensus()
      try {
        const applied = releaseCapture(fixture.repo)
        // A kept row is reported, not failed; an --apply that kept it did not release and exits 1 (@cto 585d1eac).
        expect(await runYrdProcess([...fixture.argv, "--apply"], applied.io), applied.stderr()).toBe(1)
        const report = JSON.parse(applied.stdout()) as ReleaseReport
        expect(report.removed).toEqual([])
        expect(report.kept).toEqual([
          expect.objectContaining({ path: "modules/child", branch: fixture.branch, reason: "unreached" }),
        ])
        expect((await gitIn(fixture.child!)(["symbolic-ref", "HEAD"])).trim()).toBe(`refs/heads/${fixture.branch}`)
        expect((await fixture.git(["symbolic-ref", "HEAD"])).trim()).toBe(`refs/heads/${fixture.branch}`)
        expect(await gitIn(fixture.child!)(["ls-remote", "origin", "refs/archive/*"])).toBe("")
        expect(await fixture.git(["ls-remote", "origin", "refs/archive/*"])).toBe("")
        expect((await listChanges(createEventStore(fixture.repo, "origin", fixture.git.selection), "main")).size).toBe(
          0,
        )
      } finally {
        spy.mockRestore()
      }
    },
    60_000,
  )
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
        expect(await runYrdProcess([...fixture.argv, "--apply"], output.io), output.stderr()).toBe(
          kind === "ancestor" ? 0 : 1,
        )
        const report = JSON.parse(output.stdout()) as ReleaseReport
        expect(report.failed).toEqual([])
        if (kind === "ancestor") {
          expect(report.kept).toEqual([])
          expect(report.removed).toHaveLength(2)
          for (const row of report.removed) {
            const git = gitIn(row.repo)
            expect(await git(["for-each-ref", `refs/heads/${row.branch}`])).toBe("")
            expect(await git(["ls-remote", "origin", "refs/archive/*"])).toBe("")
          }
        } else {
          expect(report.removed).toEqual([])
          expect(report.kept).toContainEqual(
            expect.objectContaining({
              repo: fixture.repo,
              reason: "held",
              detail: expect.stringContaining("; branch kept"),
            }),
          )
          for (const row of report.kept) expect(row).not.toHaveProperty("archiveRef")
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
        ).toBe(failed || kind === "moved" || kind === "late entrant" ? 1 : kind === "delegation" ? 4 : 0)
        const report = JSON.parse(output.stdout()) as ReleaseReport
        expect(output.stdout()).not.toContain("fixture-secret")
        expect(output.stdout()).not.toContain("fixture-user")
        expect(report.removed).toEqual([])
        // 29772 (@cto c8d7113d): an uncertified census under --apply is queued for the round (exit 4), never a
        // hold that exits 0; every other unsuccessful kind keeps its row.
        const outcomes = failed ? report.failed : kind === "delegation" ? report.delegated : report.kept
        expect(outcomes).toHaveLength(1)
        for (const other of [report.failed, report.kept, report.delegated]) {
          if (other !== outcomes) expect(other).toEqual([])
        }
        const outcomeRow = outcomes[0]
        expect(outcomeRow).not.toHaveProperty("archiveRef")
        const beforeApply =
          kind === "moved" || kind === "cwd" || kind === "delegation" || kind === "host" || kind === "preview host"
        if (beforeApply && !failed) {
          expect(outcomeRow?.detail).toContain(kind === "delegation" ? "queued release request" : "; branch kept")
        }
        expect(outcomeRow?.detail).toMatch(
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
  /**
   * @failure An excluded component with an attached branch reports 'no current attached branch mapping to the requested issue' instead of naming the attached branch and head it saw.
   * @level l2 @consumer A caller inspecting excluded component rows in a drop --local --release-checkout --submodules receipt
   */
  it.each(["attached", "detached"] as const)(
    "reports the %s component checkout reason when a submodule does not map to the requested issue",
    async (kind) => {
      const fixture = await releaseWorld(true)
      const { spy } = await permitCensus()
      try {
        const childGit = gitIn(fixture.child!)
        const childTip = (await childGit(["rev-parse", "HEAD"])).trim()
        await childGit(["checkout", "--quiet", "task/29600-unselected"])
        await childGit(["branch", "-m", "task/29600-unselected", "task/29601-other"])
        await childGit(["branch", "-D", fixture.branch])
        if (kind === "detached") {
          await childGit(["update-ref", "--no-deref", "HEAD", childTip, childTip])
        }
        const preview = releaseCapture(fixture.repo)
        expect(await runYrdProcess(fixture.argv, preview.io), preview.stderr()).toBe(0)
        const report = JSON.parse(preview.stdout()) as ReleaseReport
        expect(report.eligible).toHaveLength(1)
        expect(report.excluded).toEqual([
          {
            repo: fixture.child,
            path: "modules/child",
            reason:
              kind === "attached"
                ? `${fixture.child}@${childTip}: exact-tip issue binding absent; attached branch task/29601-other at ${childTip} does not map to 29600; not selected`
                : `${fixture.child}@${childTip}: exact-tip issue binding absent; no current attached branch mapping to the requested issue`,
          },
        ])
      } finally {
        spy.mockRestore()
      }
    },
    30_000,
  )
})
