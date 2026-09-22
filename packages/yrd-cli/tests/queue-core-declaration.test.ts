/**
 * @failure A command reads config from the caller's checkout or a retired
 * target: hint instead of the selected queue branch at origin, so it judges
 * against the wrong rules or guesses after malformed authority.
 * @level l2 (`coreQueueCommand` against a real remote and clone)
 * @consumer Every queue command.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  CHANGE_STATUSES,
  assertPlainEventQueueConfig,
  changeInput,
  changeRef,
  changesRef,
  createEventQueue,
  drop,
  eventRows,
  gitIn,
  listChanges,
  queueRef,
  readConfig,
  readEventQueue,
  readQueue,
  writePause,
  watchRows,
} from "@yrd/queue-core"
import { openEvents } from "gitomic/events"
import { assertEventListingFence, coreQueueCommand, openEventDetail, readListing } from "../src/queue-core-commands.ts"
import { runYrdProcess } from "../src/cli.ts"
import { eventHistoryEntries } from "../src/watch-change.ts"
import type { YrdCliIO } from "../src/types.ts"
import type { QueueConfig } from "@yrd/queue-core"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

it("refuses future event queue and check keys by name", () => {
  const plain: QueueConfig = {
    target: { remote: "origin", branch: "main" },
    checks: [{ name: "verify", run: "true" }],
    notify: [],
    blob: "a".repeat(40),
  }
  expect(() => assertPlainEventQueueConfig({ ...plain, futureQueueFeature: true } as QueueConfig, "run")).toThrow(
    /queue key futureQueueFeature:.*#25040.*25065/u,
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
  ).toThrow(/check key futureCheckFeature:.*#25040.*25065/u)
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

async function createQueue(repo: string, queue: string, commit: string, at: Date): Promise<string> {
  const git = gitIn(repo)
  const config = await readConfig(git, commit, { branch: queue, remote: "origin" })
  if (config === undefined) throw new Error(`fixture target ${commit} lost .yrd.yml`)
  return createEventQueue({ repo, remote: "origin" }, queue, commit, config, at)
}

describe("a queue is the selected origin branch carrying config", () => {
  it("creates and runs an event queue from a parsed plain-check declaration", async () => {
    // Literal QueueConfig fixtures omit absent optional keys. A real
    // declaration materializes some of them as undefined, and those must not
    // be mistaken for configured features or unknown future keys.
    const repo = await world('checks:\n  - lab-gate: {run: "true"}\n')
    const git = gitIn(repo)
    const store = { repo, remote: "origin" }
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

  it.each([
    ["setup:", 'setup: "true"\n'],
    ["teardown:", 'teardown: "true"\n'],
    ["notify:", 'notify:\n  - recorder: {on: [merged], run: "true"}\n'],
    ["submit-phase", 'checks:\n  - verify: {run: "true", on: submit}\n'],
    ["programRoot", 'checks:\n  - verify: {run: "true", programRoot: true}\n'],
    ["scripts", 'checks:\n  - verify: {run: "true", scripts: [tools/check.ts]}\n'],
    ["deferred-capable", 'checks:\n  - verify: {run: "true", long: {timeoutMs: 60000}}\n'],
  ])("refuses event queue creation with %s before writing a queue ref", async (feature, declaration) => {
    const repo = await world(declaration)
    const git = gitIn(repo)
    const target = (await git(["rev-parse", "HEAD"])).trim()
    const config = await readConfig(git, target, { branch: "main", remote: "origin" })
    if (config === undefined) throw new Error("fixture declaration is absent")
    const before = await git(["ls-remote", "--refs", "origin", "refs/yrd/main/*"])

    await expect(
      createEventQueue({ repo, remote: "origin" }, "main", target, config, new Date("2026-09-22T14:00:00.000Z")),
    ).rejects.toThrow(new RegExp(`${feature}.*#25040.*25065`))

    expect(await git(["ls-remote", "--refs", "origin", queueRef("main")])).toBe("")
    expect(await git(["ls-remote", "--refs", "origin", "refs/yrd/main/*"])).toBe(before)
  })

  it("refuses event queue creation when config came from another blob", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const target = (await git(["rev-parse", "HEAD"])).trim()
    const config = await readConfig(git, target, { branch: "main", remote: "origin" })
    if (config === undefined) throw new Error("fixture declaration is absent")

    await expect(
      createEventQueue(
        { repo, remote: "origin" },
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
        { repo, remote: "origin" },
        "main",
        target,
        undefined as unknown as QueueConfig,
        new Date("2026-09-22T14:00:00.000Z"),
      ),
    ).rejects.toThrow(/no declared QueueConfig.*#25040 does not invent a default/u)
    expect(await git(["ls-remote", "--refs", "origin", "refs/yrd/main/*"])).toBe("")
  })

  it("refuses a moved or newly added event ref between history and observation", () => {
    const before = "a".repeat(40)
    const changeTip = "b".repeat(40)
    const moved = "c".repeat(40)
    const queue = { created: before, declaration: before, tip: before }
    const changes = new Map([
      ["task/one", { status: "queued" as const, commit: before, tip: changeTip, ignored: false }],
    ])
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
    const store = { repo, remote: "origin" }
    const targetOid = (await git(["rev-parse", "HEAD"])).trim()
    const created = await createQueue(repo, "main", targetOid, new Date("2026-09-22T14:00:00.000Z"))
    const declaration = await readConfig(git, targetOid, { remote: "origin", branch: "main" })
    if (declaration === undefined) throw new Error("fixture target lost .yrd.yml")
    await expect(readListing(git, declaration, repo, targetOid)).rejects.toThrow(/event format/)
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
    expect(detail.records).toBeUndefined()
    await chain.append(
      [changeInput("verifying", { queueTip: created, at: new Date("2026-09-22T14:02:00.000Z"), commit })],
      { expect: selected.tip as string },
    )
    await expect(openEventDetail(git, declaration, row, "main", repo, selected)).rejects.toThrow(
      /moved after the selected reading/,
    )
  }, 15_000)

  it("uses every event change status unchanged in JSON, the table, and status filters", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const store = { repo, remote: "origin" }
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
      if (status === "merging") events.push(changeInput("merging", { queueTip, at: at(index * 5 + 4) }))
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
    expect(await coreQueueCommand(repo, json.io, { command: "list" }, { json: true, queue: "main" })).toBe(0)
    expect(
      (JSON.parse(json.stdout()) as { changes: readonly { state: string }[] }).changes.map((row) => row.state).sort(),
    ).toEqual([...CHANGE_STATUSES].sort())

    const table = capture(repo)
    expect(await coreQueueCommand(repo, table.io, { command: "list" }, { queue: "main" })).toBe(0)
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
          { command: "list", terms: [status] },
          { json: true, queue: "main" },
        ),
      ).toBe(0)
      expect(
        (JSON.parse(filteredJson.stdout()) as { changes: readonly { branch: string; state: string }[] }).changes,
      ).toEqual([expect.objectContaining({ branch, state: status })])
      const filteredTable = capture(repo)
      expect(
        await coreQueueCommand(repo, filteredTable.io, { command: "list", terms: [status] }, { queue: "main" }),
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
    const store = { repo, remote: "origin" }
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

  it("submits an unpublished branch, then drops its open change and branch atomically", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const store = { repo, remote: "origin" }
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
    const refusedWithdraw = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "withdraw", "task/event-submit", "--queue", "main"], refusedWithdraw.io),
    ).toBe(1)
    expect(refusedWithdraw.stderr()).toContain("use yrd drop")
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

    const store = { repo, remote: "origin" }
    const dropped = await drop(store, { queue: "main", branch: "task/remote-draft", by: "@dev/2" })
    expect(dropped).toMatchObject({ branch: "task/remote-draft", head })
    expect((await listChanges({ repo, remote: "origin" }, "main")).get("task/remote-draft")).toMatchObject({
      status: "cancelled",
      commit: head,
      reason: "dropped",
    })
    expect(await git(["ls-remote", "--heads", "origin", "task/remote-draft"])).toBe("")
    const events = await (
      await openEvents({ repo, remote: "origin", ref: changesRef("main", "task/remote-draft") })
    ).events()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: "cancelled", links: [head] })

    expect(await drop(store, { queue: "main", branch: "task/remote-draft", by: "@dev/2" })).toEqual(dropped)
  }, 15_000)

  it("refuses notify configuration when submitting to an event queue until 25065", async () => {
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
    expect(await runYrdProcess(["bun", "yrd", "submit", "--queue", "main"], submitted.io)).toBe(2)
    expect(submitted.stderr()).toMatch(/notify:.*#25040.*25065/u)
    expect(await git(["ls-remote", "--refs", "origin", "refs/heads/task/event-notify"])).toBe("")
  })

  it("directs drop on a legacy queue to the existing withdraw command", async () => {
    const repo = await world("{}\n")
    const refused = capture(repo)
    const exit = await runYrdProcess(["bun", "yrd", "drop", "task/example", "--queue", "main"], refused.io)
    expect(refused.stderr()).toContain("yrd withdraw")
    expect(exit).toBe(2)
  })

  it("pause and resume an event queue on its queue chain without a legacy pause ref", async () => {
    const repo = await world("{}\n")
    const git = gitIn(repo)
    const head = (await git(["rev-parse", "HEAD"])).trim()
    const store = { repo, remote: "origin" }
    await createQueue(repo, "main", head, new Date("2026-09-22T14:00:00.000Z"))
    const paused = capture(repo)
    expect(
      await runYrdProcess(
        ["bun", "yrd", "queue", "pause", "--queue", "main", "--reason", "repair", "--json"],
        paused.io,
      ),
      paused.stderr(),
    ).toBe(0)
    expect(JSON.parse(paused.stdout())).toMatchObject({ kind: "paused", reason: "repair" })
    expect((await readEventQueue(store, "main")).pause?.reason).toBe("repair")
    const resumed = capture(repo)
    expect(
      await runYrdProcess(["bun", "yrd", "queue", "resume", "--queue", "main", "--json"], resumed.io),
      resumed.stderr(),
    ).toBe(0)
    expect((await readEventQueue(store, "main")).pause).toBeUndefined()
    expect(await git(["ls-remote", "--refs", "origin", "refs/yrd/main/pause"])).toBe("")
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
    const tree = (await git(["rev-parse", `${release}^{tree}`])).trim()
    const advanced = (await git(["commit-tree", tree, "-p", release, "-m", "advance the queue target"])).trim()
    await remote(["fetch", "--quiet", "--no-tags", repo, advanced])
    await remote(["update-ref", "refs/heads/release/1.x", advanced])
    const malformedRef = changeRef("release/1.x", { branch: "task/unreadable", head: advanced })
    await remote(["update-ref", malformedRef, advanced])
    const refs = ["for-each-ref", "--format=%(refname) %(objectname)"]
    const yrdRefs = async (): Promise<readonly string[]> =>
      (await remote(["for-each-ref", "--format=%(refname)", "refs/yrd/"])).trim().split("\n").sort()
    const expectedYrdRefs = ["refs/yrd/release%2F1.x/pause", malformedRef].sort()
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
    await expect(readQueue(git, "origin", "release/1.x", advanced)).rejects.toThrow(malformedRef)
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
      expect(run.stderr()).toContain("inside a clone or pass --queue <repo>#<queue>")
    }
    const operand = "https://forge.example/team/repo.git#"
    const malformed = capture(outside)
    expect(
      await runYrdProcess(["bun", "yrd", "queue", verb, "--queue", operand, ...reason, "--json"], malformed.io),
    ).toBe(2)
    expect(malformed.stderr()).toContain(`queue address '${operand}' must be <repo>#<queue>`)
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
    await writePause(git, destination, "main", { by: "@dev/3", kind: "paused", reason: "inspect destination" })
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
          await runYrdProcess(["bun", "yrd", ...command, "--queue", selector, "--json"], run.io),
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
