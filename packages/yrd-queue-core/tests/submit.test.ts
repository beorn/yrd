/** Submit against a real event queue and remote. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { Conflict } from "gitomic"
import { openEvents } from "gitomic/events"
import * as events from "../src/events.ts"
import { createProcess, type Process } from "@yrd/process"
import * as verifying from "../src/verifying.ts"
import {
  appendNumberedChangeEvent,
  changesRef,
  createEventQueue,
  createEventStore,
  gitIn,
  inspectSubmit,
  issueOf,
  normalizeIssueReference,
  listChangeHistories,
  lookupRunIndex,
  queueFormat,
  queueRef,
  resetQueueFormatCache,
  runIndexRef,
  readConfig,
  readStatus,
  refAt,
  selectionFor,
  submit,
  writeQueueEvent,
  type Git,
} from "../src/index.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})
type World = Readonly<{ git: Git; work: string; remote: string; target: string }>
async function world(createQueue = true): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "yrd-core-submit-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await git(["config", "user.email", "queue@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, "target.txt"), "base\n")
  writeFileSync(join(work, ".yrd.yml"), "{}\n")
  await git(["add", "target.txt", ".yrd.yml"])
  await git(["commit", "--quiet", "-m", "base"])
  await git(["push", "--quiet", "origin", "main"])
  const target = (await git(["rev-parse", "HEAD"])).trim()
  const config = await readConfig(git, target, { branch: "main", remote: "origin" })
  if (config === undefined) throw new Error(`fixture target ${target} lost .yrd.yml`)
  if (createQueue) {
    await createEventQueue(createEventStore(work, "origin", selectionFor(git)), "main", target, config, new Date())
  }
  return { git, remote, target, work }
}
async function branchWithCommit(w: World, branch: string, file: string): Promise<string> {
  await w.git(["checkout", "--quiet", "-b", branch, "main"])
  writeFileSync(join(w.work, file), `${file}\n`)
  await w.git(["add", file])
  await w.git(["commit", "--quiet", "-m", file])
  const head = (await w.git(["rev-parse", "HEAD"])).trim()
  await w.git(["checkout", "--quiet", "main"])
  return head
}
async function remoteRefs(w: World): Promise<readonly string[]> {
  return (await w.git(["ls-remote", "--refs", "origin"]))
    .split("\n")
    .map((row) => row.trim().split(/\s+/u)[1] ?? "")
    .filter((ref) => ref !== "")
}
function withoutGitomicRefs(refs: string): string {
  return refs
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("refs/gitomic/"))
    .join("\n")
}
function store(w: World) {
  return createEventStore(w.work, "origin", selectionFor(w.git))
}
describe("event submit", () => {
  it("creates the event queue on first submit to an empty remote (26398)", async () => {
    resetQueueFormatCache()
    const w = await world(false)
    expect(await queueFormat(store(w), "main")).toBe("empty")
    const head = await branchWithCommit(w, "task/lifecycle", "lifecycle.txt")
    await submit(w.git, "origin", {
      branch: "task/lifecycle",
      submitter: "author",
      target: { branch: "main", remote: "origin" },
    })
    resetQueueFormatCache()
    expect(await queueFormat(store(w), "main")).toBe("event")
    const status = await readStatus(store(w), "main", "task/lifecycle")
    expect(status.status).toBe("queued")
    expect(head).toHaveLength(40)
  })

  it("refuses first submit when a legacy Record ref is present and names it (26398)", async () => {
    resetQueueFormatCache()
    const w = await world(false)
    const legacy = `refs/yrd/main/task/old@${w.target}`
    await w.git(["update-ref", legacy, w.target])
    await w.git(["push", "--quiet", "origin", legacy])
    resetQueueFormatCache()
    expect(await queueFormat(store(w), "main")).toBe("legacy")
    const head = await branchWithCommit(w, "task/legacy-remote", "legacy.txt")
    await expect(
      submit(w.git, "origin", {
        branch: "task/legacy-remote",
        submitter: "author",
        target: { branch: "main", remote: "origin" },
      }),
    ).rejects.toThrow(/legacy Record ref refs\/yrd\/main\/task\/old@/)
    expect(head).toHaveLength(40)
    resetQueueFormatCache()
    expect(await queueFormat(store(w), "main")).toBe("legacy")
  })

  it("refuses first submit over stray queue refs (26398)", async () => {
    resetQueueFormatCache()
    const w = await world(false)
    await w.git(["update-ref", "refs/yrd/main/runs", w.target])
    await w.git(["push", "--quiet", "origin", "refs/yrd/main/runs"])
    resetQueueFormatCache()
    await expect(queueFormat(store(w), "main")).rejects.toThrow(/unexpected refs.*refs\/yrd\/main\/runs/)
    const head = await branchWithCommit(w, "task/stray", "stray.txt")
    await expect(
      submit(w.git, "origin", {
        branch: "task/stray",
        submitter: "author",
        target: { branch: "main", remote: "origin" },
      }),
    ).rejects.toThrow(/unexpected refs/)
    expect(head).toHaveLength(40)
  })

  it("lets two concurrent first submits create one event queue and both proceed (26398)", async () => {
    resetQueueFormatCache()
    const w = await world(false)
    const work2 = join(dirname(w.work), "work2")
    await gitIn(dirname(w.work))(["clone", "--quiet", w.remote, work2])
    const git2 = gitIn(work2)
    await git2(["config", "user.email", "queue@yrd.test"])
    await git2(["config", "user.name", "yrd"])
    await branchWithCommit(w, "task/first-a", "a.txt")
    await git2(["checkout", "--quiet", "-b", "task/first-b", "main"])
    writeFileSync(join(work2, "b.txt"), "b\n")
    await git2(["add", "b.txt"])
    await git2(["commit", "--quiet", "-m", "b"])
    const results = await Promise.allSettled([
      submit(w.git, "origin", {
        branch: "task/first-a",
        submitter: "a",
        target: { branch: "main", remote: "origin" },
      }),
      submit(git2, "origin", {
        branch: "task/first-b",
        submitter: "b",
        target: { branch: "main", remote: "origin" },
      }),
    ])
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"])
    resetQueueFormatCache()
    expect(await queueFormat(store(w), "main")).toBe("event")
    expect((await readStatus(store(w), "main", "task/first-a")).status).toBe("queued")
    expect(
      (await readStatus(createEventStore(work2, "origin", selectionFor(git2)), "main", "task/first-b")).status,
    ).toBe("queued")
    const created = (await (await openEvents({ ...store(w), ref: queueRef("main") })).events()).filter(
      (event) => event.type === "created",
    )
    expect(created).toHaveLength(1)
  })

  it("refuses first submit without .yrd.yml at targetHead and writes no queue ref (26398)", async () => {
    resetQueueFormatCache()
    const w = await world(false)
    await w.git(["rm", "--quiet", ".yrd.yml"])
    await w.git(["commit", "--quiet", "-m", "drop declaration"])
    await w.git(["push", "--quiet", "origin", "main"])
    const head = await branchWithCommit(w, "task/no-yml", "no-yml.txt")
    await expect(
      submit(w.git, "origin", {
        branch: "task/no-yml",
        submitter: "author",
        target: { branch: "main", remote: "origin" },
      }),
    ).rejects.toThrow(/has no \.yrd\.yml/)
    expect(head).toHaveLength(40)
    resetQueueFormatCache()
    expect(await queueFormat(store(w), "main")).toBe("empty")
    expect(await remoteRefs(w)).toEqual(["refs/heads/main"])
  })

  it("refuses createEventQueue when QueueConfig targets another remote and writes no ref (26398)", async () => {
    resetQueueFormatCache()
    const w = await world(false)
    const config = await readConfig(w.git, w.target, { branch: "main", remote: "origin" })
    if (config === undefined) throw new Error("fixture lost queue config")
    await expect(
      createEventQueue(
        store(w),
        "main",
        w.target,
        { ...config, target: { remote: "other", branch: "main" } },
        new Date(),
      ),
    ).rejects.toThrow(/QueueConfig targets other#main/)
    resetQueueFormatCache()
    expect(await queueFormat(store(w), "main")).toBe("empty")
    expect(await remoteRefs(w)).toEqual(["refs/heads/main"])
  })

  it("names the swallowed create error when the re-read is not an event queue (26398)", async () => {
    resetQueueFormatCache()
    const w = await world(false)
    const head = await branchWithCommit(w, "task/lost-create", "lost.txt")
    const spy = vi.spyOn(events, "createEventQueue").mockRejectedValueOnce(new Conflict("lost create CAS"))
    try {
      const error = await submit(w.git, "origin", {
        branch: "task/lost-create",
        submitter: "author",
        target: { branch: "main", remote: "origin" },
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      )
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).toMatch(/did not become an event queue after create: classified empty/)
      expect(String(error)).toMatch(/lost create CAS/)
      expect(error).toMatchObject({ cause: expect.any(Conflict) })
      expect(head).toHaveLength(40)
      resetQueueFormatCache()
      expect(await queueFormat(store(w), "main")).toBe("empty")
    } finally {
      spy.mockRestore()
    }
  })

  it("births the queue and empty run index together; an occupied index lease leaves no queue (26193)", async () => {
    const born = await world()
    expect(await remoteRefs(born)).toEqual(["refs/heads/main", queueRef("main"), runIndexRef("main")])
    expect(await lookupRunIndex(createEventStore(born.work, "origin", selectionFor(born.git)), "main", 1)).toEqual({
      kind: "unknown",
      number: 1,
      knownThrough: 0,
    })

    const rejected = await world(false)
    await rejected.git(["push", "--quiet", "origin", `HEAD:${runIndexRef("main")}`])
    const config = await readConfig(rejected.git, rejected.target, { branch: "main", remote: "origin" })
    if (config === undefined) throw new Error("fixture lost queue config")
    await expect(
      createEventQueue(
        createEventStore(rejected.work, "origin", selectionFor(rejected.git)),
        "main",
        rejected.target,
        config,
        new Date(),
      ),
    ).rejects.toThrow()
    expect(await remoteRefs(rejected)).toEqual(["refs/heads/main", runIndexRef("main")])
  })

  it("allocates the first run number with its first durable change event (26193)", async () => {
    const w = await world()
    const head = await branchWithCommit(w, "task/numbered", "numbered.txt")
    await submit(w.git, "origin", {
      branch: "task/numbered",
      submitter: "author",
      target: { branch: "main", remote: "origin" },
    })
    const status = await readStatus(store(w), "main", "task/numbered")
    if (status.tip === undefined) throw new Error("fixture submission has no change tip")
    const before = await w.git([
      "ls-remote",
      "--refs",
      "origin",
      changesRef("main", "task/numbered"),
      runIndexRef("main"),
    ])
    const firstStore = store(w)
    const publish = firstStore.backend.publish
    if (publish === undefined) throw new Error("fixture has no atomic publisher")
    const pushes: string[][] = []
    const written = await appendNumberedChangeEvent(
      {
        ...firstStore,
        backend: {
          ...firstStore.backend,
          publish: async (...args: Parameters<typeof publish>) => {
            pushes.push(args[1].map((update) => update.ref))
            return publish(...args)
          },
        },
      },
      "main",
      "task/numbered",
      status.tip,
      { type: "verifying", at: new Date(), commit: head },
      { id: "opaque-run-1", startedAt: "2026-09-27T12:00:00.000Z", host: "hh", actor: "yrd" },
    )
    expect(written.number).toBe(1)
    expect(pushes).toEqual([[changesRef("main", "task/numbered"), runIndexRef("main")]])
    expect(written.event).toMatch(/^[0-9a-f]{40}$/u)
    expect(await lookupRunIndex(store(w), "main", 1)).toMatchObject({
      kind: "known",
      record: { id: "opaque-run-1" },
    })
    const fresh = join(dirname(w.work), "fresh-reader")
    await gitIn(dirname(w.work))(["clone", "--quiet", w.remote, fresh])
    expect(
      await lookupRunIndex(createEventStore(fresh, "origin", selectionFor(gitIn(fresh))), "main", 1),
    ).toMatchObject({
      kind: "known",
      record: { id: "opaque-run-1" },
    })
    const freshGit = gitIn(fresh)
    await freshGit(["config", "user.email", "queue@yrd.test"])
    await freshGit(["config", "user.name", "yrd"])
    const freshWorld = { ...w, git: freshGit, work: fresh }
    const secondHead = await branchWithCommit(freshWorld, "task/after-restart", "after-restart.txt")
    await submit(freshGit, "origin", {
      branch: "task/after-restart",
      submitter: "author",
      target: { branch: "main", remote: "origin" },
    })
    const secondStatus = await readStatus(store(freshWorld), "main", "task/after-restart")
    if (secondStatus.tip === undefined) throw new Error("fresh clone submission has no tip")
    const second = await appendNumberedChangeEvent(
      store(freshWorld),
      "main",
      "task/after-restart",
      secondStatus.tip,
      { type: "verifying", at: new Date(), commit: secondHead },
      { id: "opaque-run-2", startedAt: "2026-09-27T12:01:00.000Z", host: "hh", actor: "yrd" },
    )
    expect(second.number).toBe(2)
    expect(await lookupRunIndex(store(freshWorld), "main", 1)).toMatchObject({ kind: "known" })
    const after = await w.git([
      "ls-remote",
      "--refs",
      "origin",
      changesRef("main", "task/numbered"),
      runIndexRef("main"),
    ])
    expect(after).not.toBe(before)
  })

  it("refuses allocation when the remote queue survives but its index is missing (26193)", async () => {
    const w = await world()
    const head = await branchWithCommit(w, "task/missing-index", "missing-index.txt")
    await submit(w.git, "origin", {
      branch: "task/missing-index",
      submitter: "author",
      target: { branch: "main", remote: "origin" },
    })
    const status = await readStatus(store(w), "main", "task/missing-index")
    if (status.tip === undefined) throw new Error("fixture submission has no tip")
    await w.git(["push", "--quiet", "origin", `:${runIndexRef("main")}`])
    const missing = appendNumberedChangeEvent(
      store(w),
      "main",
      "task/missing-index",
      status.tip,
      { type: "verifying", at: new Date(), commit: head },
      { id: "must-not-allocate", startedAt: "2026-09-27T12:00:00.000Z", host: "hh", actor: "yrd" },
    )
    await expect(missing).rejects.toThrow(/E_RUN_INDEX_MISSING.*refs\/yrd\/main\/runs.*origin/u)
    expect((await readStatus(store(w), "main", "task/missing-index")).status).toBe("queued")
  })

  /** @failure Two writers for one queue could both claim N, or leave an index record without its change event.
   * @level l3 @consumer competing Yrd runners
   */
  it("allocates distinct numbers when two first publications race on one remote queue (26193)", async () => {
    const w = await world()
    const branches = ["task/race-one", "task/race-two"] as const
    const heads: string[] = []
    for (const branch of branches) {
      heads.push(await branchWithCommit(w, branch, `${branch.slice(5)}.txt`))
      await submit(w.git, "origin", { branch, submitter: "author", target: { branch: "main", remote: "origin" } })
    }
    const statuses = await Promise.all(branches.map((branch) => readStatus(store(w), "main", branch)))
    const publish = store(w).backend.publish
    if (publish === undefined) throw new Error("fixture has no atomic publisher")
    let rejected = 0
    let winner: Awaited<ReturnType<typeof appendNumberedChangeEvent>> | undefined
    const firstStore = store(w)
    const competingStore = {
      ...firstStore,
      backend: {
        ...firstStore.backend,
        publish: async (...args: Parameters<typeof publish>) => {
          if (winner === undefined) {
            winner = await appendNumberedChangeEvent(
              store(w),
              "main",
              branches[1],
              statuses[1]!.tip!,
              { type: "verifying", at: new Date(), commit: heads[1] },
              { id: "race-1", startedAt: "2026-09-27T12:00:00.000Z", host: "hh", actor: "yrd" },
            )
          }
          try {
            return await publish(...args)
          } catch (error) {
            if (error instanceof Conflict) {
              rejected += 1
              expect(args[1].map((update) => update.ref)).toEqual([
                changesRef("main", branches[0]),
                runIndexRef("main"),
              ])
              expect(await lookupRunIndex(store(w), "main", 2)).toEqual({ kind: "unknown", number: 2, knownThrough: 1 })
              expect((await readStatus(store(w), "main", branches[0])).status).toBe("queued")
            }
            throw error
          }
        },
      },
    }
    const first = await appendNumberedChangeEvent(
      competingStore,
      "main",
      branches[0],
      statuses[0]!.tip!,
      { type: "verifying", at: new Date(), commit: heads[0] },
      { id: "race-0", startedAt: "2026-09-27T12:00:00.000Z", host: "hh", actor: "yrd" },
    )
    if (winner === undefined) throw new Error("competing writer did not publish")
    const written = [first, winner]
    expect(rejected).toBe(1)
    expect(written.map((entry) => entry.number).sort((a, b) => a - b)).toEqual([1, 2])
    for (const [index, entry] of written.entries()) {
      expect(await lookupRunIndex(store(w), "main", entry.number)).toMatchObject({
        kind: "known",
        record: { id: `race-${index}` },
      })
      expect((await readStatus(store(w), "main", branches[index]!)).status).toBe("verifying")
    }
    expect(await lookupRunIndex(store(w), "main", 3)).toEqual({ kind: "unknown", number: 3, knownThrough: 2 })
  })

  /** @failure Maintenance admits a submit after the queue is stopped. */
  it("refuses maintenance before publishing the branch or event, including preview", async () => {
    const w = await world()
    await branchWithCommit(w, "task/maintenance", "maintenance.txt")
    await writeQueueEvent(store(w), "main", {
      type: "paused",
      by: "@chief",
      cause: "maintenance",
      reason: "25041 lab cutover",
      at: new Date(),
    })
    const before = await w.git(["ls-remote", "--refs", "origin"])
    const request = {
      branch: "task/maintenance",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    }
    for (const action of [inspectSubmit, submit]) {
      await expect(action(w.git, "origin", request)).rejects.toThrow("maintenance")
      await expect(action(w.git, "origin", request)).rejects.toThrow("@chief")
    }
    expect(await w.git(["ls-remote", "--refs", "origin"])).toBe(before)
  })
  it("retains the first branch binding across later heads and renames, excluding target history", async () => {
    const w = await world()
    await w.git(["commit", "--quiet", "--allow-empty", "-m", "target binding\n\nRefs: target-issue"])
    const target = (await w.git(["rev-parse", "HEAD"])).trim()
    await branchWithCommit(w, "task/123-old-label", "change.txt")
    await w.git(["checkout", "--quiet", "task/123-old-label"])
    await w.git(["commit", "--quiet", "--allow-empty", "-m", "bind\n\nRefs: canonical-issue"])
    const binding = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["commit", "--quiet", "--allow-empty", "-m", "repeat\n\nResolves: canonical-issue"])
    await w.git(["commit", "--quiet", "--allow-empty", "-m", "later work"])
    await w.git(["branch", "-m", "task/renamed"])
    const head = (await w.git(["rev-parse", "HEAD"])).trim()
    expect(await issueOf(w.git, "task/renamed", head, target)).toEqual({
      issue: "canonical-issue",
      source: "binding",
      commit: binding,
    })
    expect(await issueOf(w.git, "task/renamed", head, target, "canonical-issue")).toEqual({
      issue: "canonical-issue",
      source: "binding",
      commit: binding,
    })
    expect(await issueOf(w.git, "task/plain", target, target)).toBeUndefined()
    expect(await issueOf(w.git, "task/123-label", target, target)).toEqual({ issue: "123", source: "legacy-branch" })
    expect(await issueOf(w.git, "task/123-label", target, target, "requested-issue")).toEqual({
      issue: "requested-issue",
      source: "declared",
    })
    for (const invalid of ["", " ", " leading", "trailing ", "issue\nRefs: injected", "issue\u0001"]) {
      await expect(issueOf(w.git, "task/plain", target, target, invalid)).rejects.toThrow("issue")
    }
    const failed: Git = (args, input) =>
      args[0] === "log" ? w.git(["log", "missing-binding-object"]) : w.git(args, input)
    await expect(issueOf(failed, "task/123-label", head, target)).rejects.toThrow("missing-binding-object")
  })

  /** @failure Two spellings of one issue make submit refuse after an environment bind commit.
   * @level l2 @consumer Yrd submit and its opened change record
   */
  it("submits one canonical issue when branch history uses a short id and a full path", async () => {
    const w = await world()
    await branchWithCommit(w, "task/26050", "change.txt")
    await w.git(["checkout", "--quiet", "task/26050"])
    await w.git(["commit", "--quiet", "--allow-empty", "-m", "bind\n\nRefs: 26050"])
    await w.git(["commit", "--quiet", "--allow-empty", "-m", "work\n\nRefs: @km/storage/26050-full"])
    const canonical = "@km/storage/26050-full"
    const admit = vi.fn(async () => ({ kind: "admit" as const }))
    const submitted = await submit(w.git, "origin", {
      branch: "task/26050",
      submitter: "author",
      target: { remote: "origin", branch: "main" },
      admit,
      resolveIssue: async (raw) => {
        if (raw === "26050" || raw === canonical) return canonical
        throw new Error(`unknown issue ${raw}`)
      },
    })
    expect(submitted.issue?.issue).toBe(canonical)
    expect(admit).toHaveBeenCalledWith(canonical, "task/26050", submitted.head, submitted.targetHead)
    expect(submitted.admission).toEqual({ kind: "admitted" })
    expect((await readStatus(store(w), "main", "task/26050")).issue).toBe(canonical)
  })

  /** @failure An absolute vault path and a vault-relative bead reference refuse as conflicting bindings (25719).
   * @level l2 @consumer Yrd submit and its opened change record
   */
  it("submits one canonical issue when branch history uses absolute vault path and vault-relative spellings (25719)", async () => {
    const w = await world()
    const branch = "task/25488-delivery"
    await branchWithCommit(w, branch, "change.txt")
    await w.git(["checkout", "--quiet", branch])
    const canonical =
      "@ag/hab/25488-a-services-designed-relaunch-can-page-health-not-measured-when-the-probe-reads-the-runner-that-just-exited"
    await w.git(["commit", "--quiet", "--allow-empty", "-m", `first\n\nRefs: /hh/pm/${canonical}.md`])
    await w.git(["commit", "--quiet", "--allow-empty", "-m", `second\n\nRefs: ${canonical}`])
    const submitted = await submit(w.git, "origin", {
      branch,
      submitter: "author",
      target: { remote: "origin", branch: "main" },
    })
    expect(submitted.issue?.issue).toBe(canonical)
    expect((await readStatus(store(w), "main", branch)).issue).toBe(canonical)
  })

  it("refusal for conflicting issue bindings says which trailer to fix (25719)", async () => {
    const w = await world()
    await branchWithCommit(w, "task/conflict", "change.txt")
    await w.git(["checkout", "--quiet", "task/conflict"])
    await w.git(["commit", "--quiet", "--allow-empty", "-m", "first\n\nRefs: @ag/hab/25488-first"])
    await w.git(["commit", "--quiet", "--allow-empty", "-m", "second\n\nRefs: @ag/hab/25489-second"])
    const head = (await w.git(["rev-parse", "HEAD"])).trim()
    await expect(issueOf(w.git, "task/conflict", head, w.target)).rejects.toThrow(`fix trailer at ${head}`)
  })

  it("normalizes issue reference forms (25719)", () => {
    expect(normalizeIssueReference("/hh/pm/@ag/hab/25488-foo.md")).toBe("@ag/hab/25488-foo")
    expect(normalizeIssueReference("./@ag/hab/25488-foo.md")).toBe("@ag/hab/25488-foo")
    expect(normalizeIssueReference("@ag/hab/25488-foo.md")).toBe("@ag/hab/25488-foo")
    expect(normalizeIssueReference("@ag/hab/25488-foo")).toBe("@ag/hab/25488-foo")
    expect(normalizeIssueReference("/repo/pm/@scope/leaf")).toBe("@scope/leaf")
    expect(normalizeIssueReference("25488")).toBe("25488")
    expect(normalizeIssueReference("canonical-issue")).toBe("canonical-issue")
  })

  it("names both canonical issues for a real conflict and refuses resolver failure", async () => {
    const w = await world()
    await branchWithCommit(w, "task/two-issues", "change.txt")
    await w.git(["checkout", "--quiet", "task/two-issues"])
    await w.git(["commit", "--quiet", "--allow-empty", "-m", "first\n\nRefs: 26050"])
    await w.git(["commit", "--quiet", "--allow-empty", "-m", "second\n\nRefs: 26051"])
    const head = (await w.git(["rev-parse", "HEAD"])).trim()
    await expect(
      issueOf(w.git, "task/two-issues", head, w.target, undefined, async (raw) => `@km/storage/${raw}-full`),
    ).rejects.toThrow(/@km\/storage\/26050-full.*@km\/storage\/26051-full/u)
    await expect(
      issueOf(w.git, "task/two-issues", head, w.target, undefined, async () => {
        throw new Error("lookup unavailable")
      }),
    ).rejects.toThrow(/26050.*lookup unavailable/u)
  })

  /** @failure Binding conflicts publish work or a declared issue overrides explicit history.
   * @level l2 @consumer Yrd submit and dry run
   */
  it.each(["later binding", "declared issue"])(
    "refuses %s conflicts before composition or publication",
    async (kind) => {
      const w = await world()
      await branchWithCommit(w, "task/bound", "change.txt")
      await w.git(["checkout", "--quiet", "task/bound"])
      await w.git(["commit", "--quiet", "--allow-empty", "-m", "bind\n\nRefs: first-issue"])
      const first = (await w.git(["rev-parse", "HEAD"])).trim()
      if (kind === "later binding") {
        await w.git(["commit", "--quiet", "--allow-empty", "-m", "conflict\n\nResolves: other-issue"])
      }
      const head = (await w.git(["rev-parse", "HEAD"])).trim()
      await w.git(["checkout", "--quiet", "main"])
      await w.git(["commit", "--quiet", "--allow-empty", "-m", "target advanced"])
      await w.git(["push", "--quiet", "origin", "main"])
      await w.git(["checkout", "--quiet", "task/bound"])
      const beforeLocal = withoutGitomicRefs(await w.git(["for-each-ref", "--format=%(refname) %(objectname)"]))
      const beforeRemote = await w.git(["ls-remote", "--refs", "origin"])
      const calls: string[][] = []
      const observed: Git = (args, input) => {
        calls.push([...args])
        return w.git(args, input)
      }
      Object.assign(observed, { selection: selectionFor(w.git) })
      for (const call of [inspectSubmit, submit]) {
        const attempt = call(observed, "origin", {
          branch: "task/bound",
          target: { remote: "origin", branch: "main" },
          submitter: "author",
          ...(kind === "declared issue" ? { issue: "other-issue" } : {}),
        })
        await expect(attempt).rejects.toThrow("first-issue")
        await expect(attempt).rejects.toThrow("other-issue")
        await expect(attempt).rejects.toThrow(first)
        if (kind === "later binding") await expect(attempt).rejects.toThrow(head)
      }
      // This is the publication boundary: neither composition nor any root/pin push may start.
      expect(calls.some((args) => args[0] === "rebase" || args[0] === "push" || args.includes("--show-toplevel"))).toBe(
        false,
      )
      expect(withoutGitomicRefs(await w.git(["for-each-ref", "--format=%(refname) %(objectname)"]))).toBe(beforeLocal)
      expect(await w.git(["ls-remote", "--refs", "origin"])).toBe(beforeRemote)
    },
  )

  /** @failure Submit rewrites a stale branch or defers a composable change to the queue.
   * @level l2 @consumer Yrd submit and its dry run
   * Existing atomic-push cases keep main fixed, so they miss target motion.
   */
  it("verifies a stale but cleanly composable head without rewriting it", async () => {
    const w = await world()
    const head = await branchWithCommit(w, "task/stale-clean", "change.txt")
    await w.git(["commit", "--quiet", "--allow-empty", "-m", "target advanced"])
    await w.git(["push", "--quiet", "origin", "main"])
    const targetHead = (await w.git(["rev-parse", "HEAD"])).trim()
    const before = withoutGitomicRefs(await w.git(["for-each-ref", "--format=%(refname) %(objectname)"]))
    const inspected = await inspectSubmit(w.git, "origin", {
      branch: "task/stale-clean",
      submitter: "@dev/2",
      target: { remote: "origin", branch: "main" },
    })
    expect(inspected.head).toBe(head)
    expect(inspected.targetHead).toBe(targetHead)
    expect(inspected.verifying).toMatchObject({ state: "verified", head, targetHead })
    expect(withoutGitomicRefs(await w.git(["for-each-ref", "--format=%(refname) %(objectname)"]))).toBe(before)

    const opened = await submit(w.git, "origin", {
      branch: "task/stale-clean",
      submitter: "@dev/2",
      target: { remote: "origin", branch: "main" },
    })
    expect(opened.head).toBe(head)
    expect(opened.verifying).toMatchObject({ state: "verified", head, targetHead })
    expect(opened.verifying.gitlinks).toEqual(inspected.verifying.gitlinks)
    expect(await refAt(gitIn(w.remote), "refs/heads/task/stale-clean")).toBe(head)
  })

  it("refuses composition conflicts without changing the author checkout or opening a record", async () => {
    const w = await world()
    const head = await branchWithCommit(w, "task/conflict", "target.txt")
    writeFileSync(join(w.work, "target.txt"), "different target edit\n")
    await w.git(["commit", "--quiet", "-am", "target edit"])
    await w.git(["push", "--quiet", "origin", "main"])
    await w.git(["checkout", "--quiet", "task/conflict"])
    await expect(
      submit(w.git, "origin", {
        branch: "task/conflict",
        submitter: "@dev/3",
        target: { remote: "origin", branch: "main" },
      }),
    ).rejects.toThrow("target.txt")
    expect((await w.git(["status", "--porcelain"])).trim()).toBe("")
    expect(await refAt(w.git, "refs/heads/task/conflict")).toBe(head)
    expect(await remoteRefs(w)).toEqual(["refs/heads/main", queueRef("main"), runIndexRef("main")])
    expect((await remoteRefs(w)).filter((ref) => ref.includes("/changes/"))).toEqual([])
  })

  it("a contained head has nothing new to submit", async () => {
    const w = await world()
    await w.git(["branch", "task/contained", w.target])
    const attempt = submit(w.git, "origin", {
      branch: "task/contained",
      submitter: "@dev/3",
      target: { remote: "origin", branch: "main" },
    })
    await expect(attempt).rejects.toThrow("nothing new to submit")
    expect(await remoteRefs(w)).toEqual(["refs/heads/main", queueRef("main"), runIndexRef("main")])
  })

  it("refuses unrelated history without treating Git failures as a missing base", async () => {
    const w = await world()
    const tree = (await w.git(["rev-parse", "HEAD^{tree}"])).trim()
    const orphan = (await w.git(["commit-tree", tree, "-m", "unrelated history"])).trim()
    await w.git(["branch", "task/unrelated", orphan])
    await expect(
      submit(w.git, "origin", {
        branch: "task/unrelated",
        submitter: "@dev/3",
        target: { remote: "origin", branch: "main" },
      }),
    ).rejects.toThrow(`found no merge base, expected ${w.target}`)
    const broken: Git = (args, input) =>
      args[0] === "merge-base" ? w.git(["merge-base", "missing-object", w.target]) : w.git(args, input)
    Object.assign(broken, { selection: selectionFor(w.git) })
    await expect(
      inspectSubmit(broken, "origin", {
        branch: "task/unrelated",
        submitter: "@dev/3",
        target: { remote: "origin", branch: "main" },
      }),
    ).rejects.toThrow("missing-object")
    expect(await remoteRefs(w)).toEqual(["refs/heads/main", queueRef("main"), runIndexRef("main")])
  })

  /** @failure Submit publishes a branch without its opened event. */
  it("publishes a branch and one opened event with its issue and submitter", async () => {
    const w = await world()
    const head = await branchWithCommit(w, "task/one", "one.txt")
    const submitted = await submit(w.git, "origin", {
      branch: "task/one",
      submitter: "@dev/2",
      issue: "@i/10-yrd/24061",
      target: { branch: "main", remote: "origin" },
    })
    expect(submitted).toMatchObject({ head, retry: false })
    expect(await remoteRefs(w)).toContain("refs/heads/task/one")
    expect(await remoteRefs(w)).toContain(changesRef("main", "task/one"))
    const history = (await listChangeHistories(store(w), "main")).histories.get("task/one")
    expect(history?.events.map((event) => event.type)).toEqual(["opened"])
    expect(history?.state).toMatchObject({
      commit: head,
      issue: "@i/10-yrd/24061",
      submitter: "@dev/2",
      status: "queued",
    })
    expect(history?.events[0]?.id).toBe(submitted.opened)
  })

  it("retries an unchanged head without another opened event", async () => {
    const w = await world()
    const head = await branchWithCommit(w, "task/retry", "one.txt")
    const request = { branch: "task/retry", submitter: "@dev/2", target: { branch: "main", remote: "origin" } }
    const first = await submit(w.git, "origin", request)
    const again = await submit(w.git, "origin", request)
    expect(again).toMatchObject({ head, retry: true, opened: first.opened })
    expect(
      (await listChangeHistories(store(w), "main")).histories.get("task/retry")?.events.map((event) => event.type),
    ).toEqual(["opened"])
  })

  /** @failure An unticked Start row opens a change, or an unreadable policy silently admits without a recorded warning.
   * @level l2 @consumer Yrd submit and dry-run admission
   */
  it("refuses a policy exit 1 before any branch or event push", async () => {
    const w = await world()
    await branchWithCommit(w, "task/refused-admission", "one.txt")
    const request = {
      branch: "task/refused-admission",
      submitter: "@dev/2",
      issue: "@i/26273",
      target: { branch: "main", remote: "origin" },
      admit: async () => ({ kind: "refuse" as const, reason: "Start 3 is unticked; tick it with evidence" }),
    }
    await expect(inspectSubmit(w.git, "origin", request)).rejects.toThrow(/Start 3 is unticked/u)
    await expect(submit(w.git, "origin", request)).rejects.toThrow(/Start 3 is unticked/u)
    expect(await remoteRefs(w)).toEqual(["refs/heads/main", queueRef("main"), runIndexRef("main")])
  })

  it("refuses a target move before judging with a policy from the stale declaration", async () => {
    const w = await world()
    await branchWithCommit(w, "task/target-moved", "one.txt")
    const admit = vi.fn(async () => ({ kind: "admit" as const }))
    await expect(
      submit(w.git, "origin", {
        branch: "task/target-moved",
        submitter: "@dev/2",
        issue: "@i/26273",
        target: { branch: "main", remote: "origin" },
        expectedTargetHead: "a".repeat(40),
        admit,
      }),
    ).rejects.toThrow(/moved from declared .*rerun submit/u)
    expect(admit).not.toHaveBeenCalled()
    expect(await remoteRefs(w)).toEqual(["refs/heads/main", queueRef("main"), runIndexRef("main")])
  })

  it("does not apply the admission target guard when no admission command is declared", async () => {
    const w = await world()
    await branchWithCommit(w, "task/no-admission-target-moved", "one.txt")
    const submitted = await submit(w.git, "origin", {
      branch: "task/no-admission-target-moved",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
      expectedTargetHead: "a".repeat(40),
    })
    expect(submitted.admission).toEqual({ kind: "skipped", reason: "target declares no admission command" })
  })

  it("records one cannot-judge warning and deduplicates an unchanged-head retry", async () => {
    const w = await world()
    const head = await branchWithCommit(w, "task/admission-warning", "one.txt")
    const request = {
      branch: "task/admission-warning",
      submitter: "@dev/2",
      issue: "@i/26273",
      target: { branch: "main", remote: "origin" },
      admit: async () => ({ kind: "cannot-judge" as const, reason: "policy timed out after 10ms" }),
    }
    const first = await submit(w.git, "origin", request)
    expect(first.admission).toMatchObject({ kind: "cannot-judge", reason: "policy timed out after 10ms" })
    expect(first.admissionWarning).toMatchObject({ reason: "policy timed out after 10ms" })
    const firstHistory = (await listChangeHistories(store(w), "main")).histories.get(request.branch)
    expect(firstHistory?.events.map((event) => event.type)).toEqual(["opened", "admission-warning"])
    expect(firstHistory?.state).toMatchObject({ status: "queued", commit: head })
    const retry = await submit(w.git, "origin", request)
    expect(retry.retry).toBe(true)
    expect(retry.admissionWarning).toBeUndefined()
    expect((await listChangeHistories(store(w), "main")).histories.get(request.branch)?.events).toHaveLength(2)
    await w.git(["checkout", "--quiet", request.branch])
    await w.git(["commit", "--quiet", "--allow-empty", "-m", "next attempt"])
    const next = await submit(w.git, "origin", request)
    expect(next.admissionWarning?.event).toBeDefined()
    expect(next.admissionWarning?.event).not.toBe(first.admissionWarning?.event)
    expect(
      (await listChangeHistories(store(w), "main")).histories.get(request.branch)?.events.map((event) => event.type),
    ).toEqual(["opened", "admission-warning", "cancelled", "opened", "admission-warning"])
  })

  it("admits a judged policy warning and stores its label on the warning event", async () => {
    const w = await world()
    await branchWithCommit(w, "task/policy-warning", "one.txt")
    const submitted = await submit(w.git, "origin", {
      branch: "task/policy-warning",
      submitter: "@dev/2",
      issue: "@i/26273",
      target: { branch: "main", remote: "origin" },
      admit: async () => ({ kind: "warn", reason: "Start 3 is not ticked; complete and tick it" }),
    })
    expect(submitted.admission).toEqual({ kind: "warn", reason: "Start 3 is not ticked; complete and tick it" })
    expect(submitted.admissionWarning?.event).toBeDefined()
    const history = (await listChangeHistories(store(w), "main")).histories.get("task/policy-warning")
    expect(history?.events.map((event) => event.type)).toEqual(["opened", "admission-warning"])
    expect(history?.events.at(-1)?.props).toContainEqual(["Warning-Kind", "policy-warning"])
    expect(history?.state.diagnostic).toContain("policy warning")
    expect(history?.state.diagnostic).toContain("Start 3")
    const repeated = await submit(w.git, "origin", {
      branch: "task/policy-warning",
      submitter: "@dev/2",
      issue: "@i/26273",
      target: { branch: "main", remote: "origin" },
      admit: async () => ({ kind: "warn", reason: "Start 3 is not ticked; complete and tick it" }),
    })
    expect(repeated.retry).toBe(true)
    expect(repeated.admissionWarning).toBeUndefined()
  })

  it("admits an evidenced issue without writing a warning", async () => {
    const w = await world()
    await branchWithCommit(w, "task/admitted", "one.txt")
    const submitted = await submit(w.git, "origin", {
      branch: "task/admitted",
      submitter: "@dev/2",
      issue: "@i/26273",
      target: { branch: "main", remote: "origin" },
      admit: async () => ({ kind: "admit" }),
    })
    expect(submitted.admission).toEqual({ kind: "admitted" })
    expect(submitted.admissionWarning).toBeUndefined()
    expect(
      (await listChangeHistories(store(w), "main")).histories.get("task/admitted")?.events.map((event) => event.type),
    ).toEqual(["opened"])
  })

  it("records a thrown policy adapter as cannot-judge instead of losing the change", async () => {
    const w = await world()
    await branchWithCommit(w, "task/admission-unavailable", "one.txt")
    const submitted = await submit(w.git, "origin", {
      branch: "task/admission-unavailable",
      submitter: "@dev/2",
      issue: "@i/26273",
      target: { branch: "main", remote: "origin" },
      admit: async () => {
        throw new Error("target checkout unavailable")
      },
    })
    expect(submitted.admission).toMatchObject({
      kind: "cannot-judge",
      reason: expect.stringContaining("target checkout unavailable"),
    })
    expect(submitted.admissionWarning?.event).toBeDefined()
  })

  it("runs target admission with an empty issue binding and records cannot-judge", async () => {
    const w = await world()
    await branchWithCommit(w, "feature/without-issue", "one.txt")
    const admit = vi.fn(async () => ({ kind: "cannot-judge" as const, reason: "missing issue binding" }))
    const submitted = await submit(w.git, "origin", {
      branch: "feature/without-issue",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
      admit,
    })
    expect(admit).toHaveBeenCalledWith("", "feature/without-issue", submitted.head, submitted.targetHead)
    expect(submitted.admission).toEqual({ kind: "cannot-judge", reason: "missing issue binding" })
    expect(submitted.admissionWarning?.event).toBeDefined()
  })

  it("refuses to submit the target without publishing a change", async () => {
    const w = await world()
    await expect(
      submit(w.git, "origin", {
        branch: "main",
        submitter: "@dev/2",
        target: { branch: "main", remote: "origin" },
      }),
    ).rejects.toThrow("main is the target, not a change")
    expect((await remoteRefs(w)).filter((ref) => ref.includes("/changes/"))).toEqual([])
  })

  it("opens a new segment when the branch advances", async () => {
    const w = await world()
    const first = await branchWithCommit(w, "task/advance", "one.txt")
    await submit(w.git, "origin", {
      branch: "task/advance",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })
    await w.git(["checkout", "--quiet", "task/advance"])
    writeFileSync(join(w.work, "two.txt"), "two\n")
    await w.git(["add", "two.txt"])
    await w.git(["commit", "--quiet", "-m", "two"])
    const second = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])
    const result = await submit(w.git, "origin", {
      branch: "task/advance",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })
    expect(result).toMatchObject({ head: second, retry: false })
    const events = (await listChangeHistories(store(w), "main")).histories.get("task/advance")?.events
    expect(events?.map((event) => event.type)).toEqual(["opened", "cancelled", "opened"])
    expect((await readStatus(store(w), "main", "task/advance")).commit).toBe(second)
    expect(first).not.toBe(second)
  })
  it("inspects the candidate with noFetch enabled (25626)", async () => {
    const w = await world()
    await branchWithCommit(w, "task/one", "one.txt")
    using verifySpy = vi.spyOn(verifying, "verifyCandidate")
    await submit(w.git, "origin", {
      branch: "task/one",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })
    expect(verifySpy).toHaveBeenCalled()
    expect(verifySpy.mock.calls[0]?.[0]?.noFetch).toBe(true)
  })

  it("verifyCandidate passes --no-fetch in argv to git-super (25626 Arm Y2)", async () => {
    const w = await world()
    const head = await branchWithCommit(w, "task/arm-y2", "y2.txt")
    const targetHead = (await w.git(["rev-parse", "refs/heads/main"])).trim()
    await using real = createProcess({ cwd: w.work })
    const recordedArgvs: (readonly string[])[] = []
    const recording: Process = {
      ...real,
      async run(request) {
        if (request.argv.includes("super") && request.argv.includes("merge")) {
          recordedArgvs.push(request.argv)
        }
        return real.run(request)
      },
    }
    const scratch = mkdtempSync(join(tmpdir(), "arm-y2-"))
    roots.push(scratch)
    try {
      await verifying.verifyCandidate({
        git: w.git,
        repo: w.work,
        targetHead,
        head,
        path: join(scratch, "candidate"),
        message: "verify candidate with noFetch",
        noFetch: true,
        process: recording,
      })
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
    expect(recordedArgvs.length).toBeGreaterThan(0)
    for (const argv of recordedArgvs) {
      expect(argv).toContain("--no-fetch")
    }
  })
})
