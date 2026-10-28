/** Submit against a real event queue and remote. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, sep } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { Conflict, PublicationRejected } from "gitomic"
import { openEvents } from "gitomic/events"
import * as events from "../src/events.ts"
import { createProcess, type Process } from "@yrd/process"
import * as verifying from "../src/verifying.ts"
import {
  appendNumberedChangeEvent,
  changesRef,
  createEventQueue,
  createEventStore,
  inspectSubmit,
  issueOf,
  issueBindingsOf,
  closingReferencesOf,
  listChangeHistories,
  lookupRunIndex,
  queueFormat,
  queueRef,
  resetQueueFormatCache,
  runIndexRef,
  readConfig,
  readEventQueue,
  readStatus,
  refAt,
  selectionFor,
  submit,
  writeQueueEvent,
  type Git,
  type SameIssue,
} from "../src/index.ts"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { runnerFor } from "../src/git.ts"
import { requireFrozenGitSuper } from "../src/git-super-selection.ts"
import { transientPushRetry } from "../src/transient-push.ts"

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
  /** @failure 28187: submit creates a registered candidate inside the inherited habitat scratch root.
   * @level l2 @consumer Yrd submit verification
   * Existing submit tests verify composition but never observe the live worktree's location.
   * @reach fs-walk <fixture-only: temp world and inherited scratch; real submit verifies their candidate>
   * @testonly none
   */
  it("keeps submit verification outside the inherited scratch root", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "yrd-submit-scratch-"))
    roots.push(fixture)
    vi.stubEnv("TMPDIR", fixture)
    try {
      const w = await world()
      await branchWithCommit(w, "task/scratch-placement", "one.txt")
      const scratch = join(fixture, "hab-scratch")
      mkdirSync(scratch)
      vi.stubEnv("TMPDIR", scratch)
      const common = (await w.git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
      let candidatePath: string | undefined
      const verify = verifying.verifyCandidate
      using observer = vi.spyOn(verifying, "verifyCandidate").mockImplementation((options) =>
        verify({
          ...options,
          beforeMerge: async (candidate) => {
            candidatePath = candidate
            expect(existsSync(join(candidate, ".git"))).toBe(true)
            expect((await gitIn(candidate)(["rev-parse", "--is-inside-work-tree"])).trim()).toBe("true")
            await options.beforeMerge?.(candidate)
          },
        }),
      )
      const result = await submit(w.git, "origin", {
        branch: "task/scratch-placement",
        submitter: "@dev/2",
        target: { branch: "main", remote: "origin" },
      })
      expect(result.verifying.state).toBe("verified")
      expect(candidatePath?.startsWith(`${scratch}${sep}`)).toBe(false)
      expect(candidatePath?.startsWith(`${join(common, "yrd", "tmp")}${sep}`)).toBe(true)
      expect(readdirSync(scratch)).toEqual([])
      expect(candidatePath === undefined || existsSync(candidatePath)).toBe(false)
      expect(observer).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  /** @failure 27957: cold custody must preserve merged-head refusal and lineage when a new head reopens.
   * @level l2 @consumer yrd queue submit
   * Existing reopen coverage keeps history hot and cannot detect a cold branch being treated as new.
   */
  it("refuses a cold merged head and atomically reopens its history at a new head", async () => {
    const w = await world()
    const branch = "task/cold-reopen"
    const first = await branchWithCommit(w, branch, "one.txt")
    const location = store(w)
    const hot = changesRef("main", branch)
    const cold = `refs/yrd-archive/main/${branch}`
    const queueTip = (await events.readEventQueue(location, "main")).tip
    const chain = await openEvents({ ...location, ref: hot })
    const at = new Date("2026-09-22T14:00:00.000Z")
    const prior = await chain.append(
      [
        events.changeInput("opened", { queueTip, at, commit: first, by: "@dev/6" }),
        events.changeInput("merged", { queueTip, at, commit: first }),
      ],
      { expect: null },
    )
    if (prior.head === null || location.backend.publish === undefined) throw new Error("cold fixture lacks custody")
    const priorTip = prior.head
    const request = { branch, submitter: "@dev/6", target: { branch: "main", remote: "origin" } }
    // @failure 27957: moving hot custody after selection must not let transact replay an empty new branch.
    // Static cold histories cannot exercise the read-to-transaction boundary.
    const backend = runnerFor(w.git).backend
    const fetch = backend.fetchRefs
    const list = backend.listRefs
    const publishFixture = location.backend.publish
    if (fetch === undefined || list === undefined) throw new Error("cold fixture lacks ref reads")
    let moved = false
    let selectedHot = false
    {
      using listing = vi.spyOn(backend, "listRefs").mockImplementation(async (...args) => {
        if (selectedHot && !moved && args[1] === hot) {
          moved = true
          await publishFixture(
            w.work,
            [
              { ref: cold, expect: "0".repeat(40), oid: priorTip },
              { ref: hot, expect: priorTip, oid: null },
            ],
            "origin",
          )
        }
        return list(...args)
      })
      using moving = vi.spyOn(backend, "fetchRefs").mockImplementation(async (...args) => {
        const fetched = await fetch(...args)
        if (Array.isArray(args[1]) && args[1].includes(hot) && args[1].includes(cold) && fetched.has(hot)) {
          selectedHot = true
        }
        return fetched
      })
      await expect(submit(w.git, "origin", request)).rejects.toThrow("moved after submit selected its history")
      expect(moving).toHaveBeenCalled()
      expect(listing).toHaveBeenCalled()
    }
    expect(moved).toBe(true)
    await expect(submit(w.git, "origin", request)).rejects.toThrow("already merged")
    expect(await remoteRefs(w)).toContain(cold)
    expect(await remoteRefs(w)).not.toContain(hot)

    // A real landing also advances the target; its early ancestry refusal must still name the retained merge.
    await w.git(["merge", "--quiet", "--ff-only", first])
    await w.git(["push", "--quiet", "origin", "main"])
    await expect(submit(w.git, "origin", request)).rejects.toThrow("already merged")

    await w.git(["checkout", "--quiet", branch])
    writeFileSync(join(w.work, "two.txt"), "two\n")
    await w.git(["add", "two.txt"])
    await w.git(["commit", "--quiet", "-m", "two"])
    const second = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])
    // @failure 27957: a cold side-lease loss remains final even if the queue fence also loses.
    // Hot-only queue-race tests cannot prove that a rejected custody transition is never replayed.
    const publish = backend.publish
    if (publish === undefined) throw new Error("cold fixture lacks submit publisher")
    let custodyAttempts = 0
    {
      using rejected = vi.spyOn(backend, "publish").mockImplementation(async (...args) => {
        if (args[1].some((update) => update.ref === cold && update.oid === null)) {
          custodyAttempts++
          throw new Conflict("cold and queue leases moved", { refs: [cold, queueRef("main")] })
        }
        return publish(...args)
      })
      await expect(submit(w.git, "origin", request)).rejects.toThrow("cold and queue leases moved")
      expect(rejected).toHaveBeenCalled()
    }
    expect(custodyAttempts).toBe(1)
    expect(await remoteRefs(w)).not.toContain(`refs/heads/${branch}`)
    expect(await remoteRefs(w)).not.toContain(hot)
    expect(await readStatus(location, "main", branch)).toMatchObject({ status: "merged", tip: prior.head })
    expect(await submit(w.git, "origin", request)).toMatchObject({ head: second, retry: false })
    const refs = await remoteRefs(w)
    expect(refs).toContain(hot)
    expect(refs).not.toContain(cold)
    const history = (await listChangeHistories(location, "main", { branches: "all" })).histories.get(branch)
    expect(history?.events.slice(0, prior.events.length).map((event) => event.id)).toEqual(
      prior.events.map((event) => event.id),
    )
    expect(history?.events.map((event) => event.type)).toEqual(["opened", "merged", "opened"])
    expect(history?.state).toMatchObject({ status: "queued", commit: second })
  })

  /** @failure 29087: a history absent at previewRetirement but created and archived during composition must
   * still be seen cold at publication; a stale absence must never authorize a fresh hot chain beside it.
   * @level l2 @consumer yrd queue submit
   */
  it("re-reads an absent history that went cold during composition instead of forking custody", async () => {
    const w = await world()
    const branch = "task/absent-to-cold"
    const first = await branchWithCommit(w, branch, "one.txt")
    const location = store(w)
    const hot = changesRef("main", branch)
    const cold = `refs/yrd-archive/main/${branch}`
    const request = { branch, submitter: "@dev/6", target: { branch: "main", remote: "origin" } }
    const backend = runnerFor(w.git).backend
    const fetch = backend.fetchRefs
    const list = backend.listRefs
    const publishFixture = location.backend.publish
    if (fetch === undefined || list === undefined || publishFixture === undefined) {
      throw new Error("absent-to-cold fixture lacks custody reads")
    }
    let absentSeen = false
    let moved = false
    let priorTip: string | undefined
    {
      using watching = vi.spyOn(backend, "fetchRefs").mockImplementation(async (...args) => {
        const fetched = await fetch(...args)
        if (Array.isArray(args[1]) && args[1].includes(hot) && args[1].includes(cold) && !fetched.has(hot)) {
          absentSeen = true
        }
        return fetched
      })
      using listing = vi.spyOn(backend, "listRefs").mockImplementation(async (...args) => {
        if (absentSeen && !moved && typeof args[1] === "string" && args[1].startsWith("refs/yrd/")) {
          moved = true
          const queueTip = (await events.readEventQueue(location, "main")).tip
          const chain = await openEvents({ ...location, ref: hot })
          const at = new Date("2026-09-22T14:00:00.000Z")
          const prior = await chain.append(
            [
              events.changeInput("opened", { queueTip, at, commit: first, by: "@dev/6" }),
              events.changeInput("merged", { queueTip, at, commit: first }),
            ],
            { expect: null },
          )
          if (prior.head === null) throw new Error("absent-to-cold fixture chain did not publish")
          priorTip = prior.head
          await publishFixture(
            w.work,
            [
              { ref: cold, expect: "0".repeat(40), oid: priorTip },
              { ref: hot, expect: priorTip, oid: null },
            ],
            "origin",
          )
        }
        return list(...args)
      })
      await expect(submit(w.git, "origin", request)).rejects.toThrow("already merged")
      expect(watching).toHaveBeenCalled()
      expect(listing).toHaveBeenCalled()
    }
    expect(absentSeen).toBe(true)
    expect(moved).toBe(true)
    expect(await remoteRefs(w)).toContain(cold)
    expect(await remoteRefs(w)).not.toContain(hot)

    await w.git(["checkout", "--quiet", branch])
    writeFileSync(join(w.work, "two.txt"), "two\n")
    await w.git(["add", "two.txt"])
    await w.git(["commit", "--quiet", "-m", "two"])
    const second = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])
    expect(await submit(w.git, "origin", request)).toMatchObject({ head: second, retry: false })
    const refs = await remoteRefs(w)
    expect(refs).toContain(hot)
    expect(refs).not.toContain(cold)
    const history = (await listChangeHistories(location, "main", { branches: "all" })).histories.get(branch)
    expect(history?.events.map((event) => event.type)).toEqual(["opened", "merged", "opened"])
    expect(history?.state).toMatchObject({ status: "queued", commit: second })
  })

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
    await expect(events.drop(store(w), { queue: "main", branch: "task/legacy-remote", by: "author" })).rejects.toThrow(
      "this event reader cannot drop legacy changes",
    )
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

  /**
   * @failure a numbered append whose queue read skips its fetch — because the queue ref is already held —
   *          leaves the private index ref one allocation behind, so it allocates a run number the remote already
   *          holds and its publish dies as a final Conflict.
   * @level   l2 (real queue, real remote, two clones)
   * @consumer every yrd run-number allocation
   * @reach none
   * @testonly the second clone stands in for a second host; the private refs are gitomic's own namespace
   */
  it("a numbered append allocates from the remote's index tip when the queue ref is already held (29746)", async () => {
    const w = await world()
    const first = await branchWithCommit(w, "task/numbered-first", "first.txt")
    await submit(w.git, "origin", {
      branch: "task/numbered-first",
      submitter: "author",
      target: { branch: "main", remote: "origin" },
    })
    const firstStatus = await readStatus(store(w), "main", "task/numbered-first")
    if (firstStatus.tip === undefined) throw new Error("fixture submission has no change tip")
    const allocated = await appendNumberedChangeEvent(
      store(w),
      "main",
      "task/numbered-first",
      firstStatus.tip,
      { type: "verifying", at: new Date(), commit: first },
      { id: "opaque-run-1", startedAt: "2026-09-27T12:00:00.000Z", host: "hh", actor: "yrd" },
    )
    expect(allocated.number).toBe(1)

    // A second host allocates run 2, so the remote moves the change ref and the index ref together. The
    // queue ref does not move: its submit leases it at its own tip, and a verifying push carries only
    // the change ref and the index ref.
    const elsewhere = join(dirname(w.work), "second-host")
    await gitIn(dirname(w.work))(["clone", "--quiet", w.remote, elsewhere])
    const elsewhereGit = gitIn(elsewhere)
    await elsewhereGit(["config", "user.email", "queue@yrd.test"])
    await elsewhereGit(["config", "user.name", "yrd"])
    const elsewhereWorld = { ...w, git: elsewhereGit, work: elsewhere }
    const second = await branchWithCommit(elsewhereWorld, "task/numbered-second", "second.txt")
    await submit(elsewhereGit, "origin", {
      branch: "task/numbered-second",
      submitter: "author",
      target: { branch: "main", remote: "origin" },
    })
    const secondStatus = await readStatus(store(elsewhereWorld), "main", "task/numbered-second")
    if (secondStatus.tip === undefined) throw new Error("second host has no change tip")
    const took = await appendNumberedChangeEvent(
      store(elsewhereWorld),
      "main",
      "task/numbered-second",
      secondStatus.tip,
      { type: "verifying", at: new Date(), commit: second },
      { id: "opaque-run-2", startedAt: "2026-09-27T12:01:00.000Z", host: "elsewhere", actor: "yrd" },
    )
    expect(took.number).toBe(2)

    // Here: ONE plain read of the queue. At this head that read is HELD and fetches nothing — the queue ref came
    // over with the first submit — so this is the state that matters: the queue ref equals the remote's and the
    // private index ref is still exactly where run 1 left it.
    await readEventQueue(store(w), "main")
    const privateRef = (ref: string): string =>
      `refs/gitomic/fetched/origin/${ref.startsWith("refs/") ? ref.slice("refs/".length) : ref}`
    const held = async (ref: string): Promise<string> =>
      (await w.git(["rev-parse", "--verify", privateRef(ref)])).trim()
    const remote = async (ref: string): Promise<string> =>
      (await w.git(["ls-remote", "origin", ref])).trim().split(/\s+/u)[0] ?? ""
    expect(await held(queueRef("main"))).toBe(await remote(queueRef("main")))
    expect(await held(runIndexRef("main"))).not.toBe(await remote(runIndexRef("main")))

    // The next numbered append must read the remote's own index tip: holding the queue ref is not enough.
    const thirdStatus = await readStatus(store(w), "main", "task/numbered-first")
    if (thirdStatus.tip === undefined) throw new Error("clone lost its change tip")
    const third = await appendNumberedChangeEvent(
      store(w),
      "main",
      "task/numbered-first",
      thirdStatus.tip,
      { type: "verifying", at: new Date(), commit: first },
      { id: "opaque-run-3", startedAt: "2026-09-27T12:02:00.000Z", host: "hh", actor: "yrd" },
    )
    expect(third.number).toBe(3)
    expect(await lookupRunIndex(store(w), "main", 3)).toMatchObject({
      kind: "known",
      record: { id: "opaque-run-3" },
    })
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
    expect(await issueOf(w.git, "task/123-label", target, target)).toBeUndefined()
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

  /** @failure Provider identity policy changes an opaque submission key.
   * @level l2 @consumer Yrd submit and opened change record @testonly none
   */
  it("preserves a declared issue key verbatim without a provider", async () => {
    const w = await world()
    await branchWithCommit(w, "task/opaque", "change.txt")
    const key = "/different/vault/@opaque/key.md"
    const submitted = await submit(w.git, "origin", {
      branch: "task/opaque",
      submitter: "author",
      target: { remote: "origin", branch: "main" },
      issue: key,
    })
    expect(submitted.issue?.issue).toBe(key)
    expect((await readStatus(store(w), "main", "task/opaque")).issue).toBe(key)
  })

  /** @failure Admission drops an unparsed issue link when commit uses Refs without colon (27041).
   * @level l2 @consumer Yrd submit and its opened change record
   */
  it("submits and admits with issue binding when commit uses Refs without colon (27041)", async () => {
    const w = await world()
    await branchWithCommit(w, "task/fixer-ladder-fails", "change.txt")
    await w.git(["checkout", "--quiet", "task/fixer-ladder-fails"])
    await w.git([
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "test(maddoc): the unordered-ladder row runs as it.fails until 26335\n\nRefs 26335\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n\nChange-Id: I44e7953dd775ac9f16381cc76183ab0ee1e05f54",
    ])
    const head = (await w.git(["rev-parse", "HEAD"])).trim()
    expect(await issueOf(w.git, "task/fixer-ladder-fails", head, w.target)).toEqual({
      issue: "26335",
      source: "binding",
      commit: head,
    })
    const admit = vi.fn(async () => ({ kind: "admit" as const }))
    const submitted = await submit(w.git, "origin", {
      branch: "task/fixer-ladder-fails",
      submitter: "author",
      target: { remote: "origin", branch: "main" },
      admit,
    })
    expect(submitted.issue?.issue).toBe("26335")
    expect(admit).toHaveBeenCalledWith("26335", "task/fixer-ladder-fails", submitted.head, submitted.targetHead)
    expect(submitted.admission).toEqual({ kind: "admitted" })
    expect((await readStatus(store(w), "main", "task/fixer-ladder-fails")).issue).toBe("26335")
  })

  /** @failure A prose line starting with Resolves or Refs in subject incorrectly binds as issue (27041).
   * @level l2 @consumer Yrd submit and its opened change record
   */
  it("colonless Refs #NNNNN binds, while prose starting with Resolves or Refs in subject does not bind (27041)", async () => {
    const w = await world()
    // 1. Colonless Refs #26691 binds
    await branchWithCommit(w, "task/colonless-hash", "change1.txt")
    await w.git(["checkout", "--quiet", "task/colonless-hash"])
    await w.git(["commit", "--quiet", "--allow-empty", "-m", "fix something\n\nRefs #26691"])
    const head1 = (await w.git(["rev-parse", "HEAD"])).trim()
    expect(await issueOf(w.git, "task/colonless-hash", head1, w.target)).toEqual({
      issue: "#26691",
      source: "binding",
      commit: head1,
    })

    // 2. Prose line starting with 'resolves without a word...' plus real 'Refs: 27041' binds 27041 and does not refuse
    await branchWithCommit(w, "task/prose-resolves", "change2.txt")
    await w.git(["checkout", "--quiet", "task/prose-resolves"])
    await w.git([
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "wrapped commit\n\nresolves without a word. bun.lock loses it, ...\n\nRefs: 27041",
    ])
    const head2 = (await w.git(["rev-parse", "HEAD"])).trim()
    expect(await issueOf(w.git, "task/prose-resolves", head2, w.target)).toEqual({
      issue: "27041",
      source: "binding",
      commit: head2,
    })

    // 3. Subject starting with 'Resolves ...' or 'Refs ...' does not bind or refuse
    await branchWithCommit(w, "task/subject-resolves", "change3.txt")
    await w.git(["checkout", "--quiet", "task/subject-resolves"])
    await w.git(["commit", "--quiet", "--allow-empty", "-m", "Resolves the race in submit\n\nRefs: 27041"])
    const head3 = (await w.git(["rev-parse", "HEAD"])).trim()
    expect(await issueOf(w.git, "task/subject-resolves", head3, w.target)).toEqual({
      issue: "27041",
      source: "binding",
      commit: head3,
    })

    // 4. Prose starting with 'Refs and tags both move here' does not bind
    await branchWithCommit(w, "task/prose-refs", "change4.txt")
    await w.git(["checkout", "--quiet", "task/prose-refs"])
    await w.git(["commit", "--quiet", "--allow-empty", "-m", "commit with prose\n\nRefs and tags both move here."])
    const head4 = (await w.git(["rev-parse", "HEAD"])).trim()
    expect(await issueOf(w.git, "task/prose-refs", head4, w.target)).toBeUndefined()

    // The binding fallback still accepts colonless Resolves, while outward closing
    // intent must keep the actual Git trailer value opaque, including spaces and punctuation.
    await w.git([
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "closing controls\n\nFixes everything\nResolves colonless-binding",
    ])
    const head5 = (await w.git(["rev-parse", "HEAD"])).trim()
    expect(await issueOf(w.git, "task/prose-refs", head5, w.target)).toEqual({
      issue: "colonless-binding",
      source: "binding",
      commit: head5,
    })
    await w.git([
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "closing trailer\n\nFixes everything\n\nCloses: -opaque one, two",
    ])
    const head6 = (await w.git(["rev-parse", "HEAD"])).trim()
    const closing = []
    for await (const field of closingReferencesOf(w.git, [`${w.target}..${head6}`], "task/prose-refs")) {
      closing.push(field)
    }
    expect(closing).toEqual([{ value: "-opaque one, two", commit: head6, trailer: "Closes" }])
  })

  /** @failure An absolute vault path and a vault-relative bead reference refuse as conflicting bindings (25719).
   * @level l2 @consumer Yrd submit and its opened change record
   */
  it("refusal for conflicting issue bindings says which trailer to fix (25719)", async () => {
    const w = await world()
    await branchWithCommit(w, "task/conflict", "change.txt")
    await w.git(["checkout", "--quiet", "task/conflict"])
    await w.git(["commit", "--quiet", "--allow-empty", "-m", "first\n\nRefs: @ag/hab/25488-first"])
    await w.git(["commit", "--quiet", "--allow-empty", "-m", "second\n\nRefs: @ag/hab/25489-second"])
    const head = (await w.git(["rev-parse", "HEAD"])).trim()
    await expect(issueOf(w.git, "task/conflict", head, w.target)).rejects.toThrow(`fix trailer at ${head}`)
    // Automatic environment closure must inspect both bindings while submit still refuses the conflict.
    const bindings = []
    for await (const binding of issueBindingsOf(w.git, [`${w.target}..${head}`], "task/conflict")) {
      bindings.push(binding)
    }
    expect(bindings.map(({ issue }) => issue)).toEqual(["@ag/hab/25488-first", "@ag/hab/25489-second"])
  })

  /**
   * @failure A branch whose history spells one issue as `#N` in one commit and by its full path in the
   *          next refuses, and the refusal neither said that Yrd compares issue keys exactly nor gave the
   *          way out (29716, the #undead recurrence of 24991 and 25719 after yrd 95e40a89 retired the
   *          resolver).
   * @level   l2 (real git history through issueOf)
   * @consumer every submitter whose trailers spell one issue two ways
   */
  it("refuses two keys bound on one branch, and says keys compare exactly with the way out (29716)", async () => {
    const w = await world()
    const path = "@ag/code/29456-ag-quota-one-typed-reader-per-provider"
    await branchWithCommit(w, "task/two-keys", "change.txt")
    await w.git(["checkout", "--quiet", "task/two-keys"])
    await w.git(["commit", "--quiet", "--allow-empty", "-m", "bind\n\nRefs: #29456"])
    await w.git(["commit", "--quiet", "--allow-empty", "-m", `work\n\nRefs: ${path}`])
    const head = (await w.git(["rev-parse", "HEAD"])).trim()
    const message = await issueOf(w.git, "task/two-keys", head, w.target).then(
      () => "",
      (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
    )
    // Both keys are named, so a reader can see which two spellings met.
    expect(message).toContain("#29456")
    expect(message).toContain(path)
    // The refusal says what Yrd's comparison is, and it never claims sameness it cannot know.
    expect(message).toContain("compares issue keys exactly")
    // It gives the way out: rewrite one trailer to the other key when they name one issue.
    expect(message).toMatch(/rewrite .*trailer/u)
  })

  /**
   * @failure 29738: the split usually starts at `yrd env open --issue <slug>`, which records the
   *          caller's spelling in the bind commit; the two-key refusal named both keys but never the
   *          bind commit, so the author had to guess where the second spelling came from.
   * @level   l2 (real git history through issueOf)
   * @consumer any submitter whose bind commit and later commits spell one issue two ways
   */
  it("conflicting keys name the yrd env open bind commit as where the split starts (29738)", async () => {
    const w = await world()
    const path = "@i/1-instruments/one-seat-model/29731-status-truth-turn-marker"
    await branchWithCommit(w, "task/env-open-split", "change.txt")
    await w.git(["checkout", "--quiet", "task/env-open-split"])
    await w.git([
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "Bind work to 29731-status-truth-turn-marker\n\nRefs: 29731-status-truth-turn-marker",
    ])
    await w.git(["commit", "--quiet", "--allow-empty", "-m", `work\n\nRefs: ${path}`])
    const head = (await w.git(["rev-parse", "HEAD"])).trim()
    const message = await issueOf(w.git, "task/env-open-split", head, w.target).then(
      () => "",
      (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
    )
    expect(message).toContain("29731-status-truth-turn-marker")
    expect(message).toContain(path)
    // It names the fact a submitter needs: an env open bind commit carries the value exactly as given.
    expect(message).toContain("yrd env open")
    expect(message).toMatch(/carries the --issue value exactly as given/u)
    expect(message).toMatch(/a split between two spellings can start there/u)
    // No cure beyond the one it can stand behind: it never tells the author to re-run env open.
    expect(message).not.toMatch(/re-run .*env open/u)
  })

  /**
   * @failure 31060: `yrd submit` refused #26585 because one commit carries `Refs: 26585` and a later one
   *          `Refs: @hh/tooling/26585-vterm-trusted-publishing-proof`; the project's declared resolve verb
   *          names one issue for both, yet Yrd compared the raw strings and called them two bindings.
   * @level   l2 (real git history through issueOf, provider judgment stubbed)
   * @consumer every submitter whose trailers spell one issue two ways in a project that declares resolve
   */
  it("two spellings the provider resolves to one issue are one binding, and the first spelling is kept (31060)", async () => {
    const w = await world()
    const path = "@hh/tooling/26585-vterm-trusted-publishing-proof"
    await branchWithCommit(w, "task/one-issue-two-spellings", "change.txt")
    await w.git(["checkout", "--quiet", "task/one-issue-two-spellings"])
    await w.git(["commit", "--quiet", "--allow-empty", "-m", "bind\n\nRefs: 26585"])
    const bind = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["commit", "--quiet", "--allow-empty", "-m", `work\n\nRefs: ${path}`])
    const head = (await w.git(["rev-parse", "HEAD"])).trim()
    const asked: (readonly [string, string])[] = []
    const sameIssue: SameIssue = async (a, b) => {
      asked.push([a, b])
      return [a, b].every((raw) => raw === "26585" || raw === path) ? { same: true } : { same: false, resolved: true }
    }
    expect(await issueOf(w.git, "task/one-issue-two-spellings", head, w.target, undefined, sameIssue)).toEqual({
      issue: "26585",
      source: "binding",
      commit: bind,
    })
    // A declared spelling the provider also resolves to that issue is admitted against the binding.
    expect(await issueOf(w.git, "task/one-issue-two-spellings", head, w.target, path, sameIssue)).toEqual({
      issue: "26585",
      source: "binding",
      commit: bind,
    })
    // The provider is asked only where two raw strings differ.
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every(([a, b]) => a !== b)).toBe(true)
    const refusal = (judge: SameIssue, declared?: string) =>
      issueOf(w.git, "task/one-issue-two-spellings", head, w.target, declared, judge).then(
        () => "",
        (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
      )
    // Two different issues: the refusal says so, and drops the rewrite hint that only fits one issue.
    const different = await refusal(async () => ({ same: false, resolved: true }))
    expect(different).toContain("conflicting issue bindings")
    expect(different).toContain(`26585 and ${path} resolve to different issues`)
    expect(different).not.toMatch(/rewrite .*trailer/u)
    // A declared key the provider names as another issue than the (one) binding.
    const other = "@hh/tooling/99999-other-issue"
    const declaredDifferent = await refusal(sameIssue, other)
    expect(declaredDifferent).toContain(`${other} and 26585 resolve to different issues`)
    // No answer: exact comparison as today, plus what resolve returned.
    const why = `resolve ${path}: yrd-issues-provider-failed: provider ended with exit 1`
    const unresolved = await refusal(async () => ({ same: false, resolved: false, why }))
    expect(unresolved).toContain("compares issue keys exactly")
    expect(unresolved).toContain(why)
    expect(unresolved).toMatch(/rewrite .*trailer/u)
    const declaredUnresolved = await refusal(
      async (a, b) => ((await sameIssue(a, b)).same ? { same: true } : { same: false, resolved: false, why }),
      other,
    )
    expect(declaredUnresolved).toContain("pass it exactly as bound: 26585")
    expect(declaredUnresolved).toContain(why)
  })

  /**
   * @failure 31060: a host comparer must cost nothing on the common path; byte-equal keys never reach it.
   * @level   l2 (real git history through issueOf)
   * @consumer every submit in a project that declares resolve
   */
  it("byte-equal issue keys never ask the host comparer (31060)", async () => {
    const w = await world()
    const path = "@hh/tooling/31060-yrd-issue-ref-exact-string"
    await branchWithCommit(w, "task/one-spelling", "change.txt")
    await w.git(["checkout", "--quiet", "task/one-spelling"])
    await w.git(["commit", "--quiet", "--allow-empty", "-m", `bind\n\nRefs: ${path}`])
    await w.git(["commit", "--quiet", "--allow-empty", "-m", `work\n\nRefs: ${path}`])
    const head = (await w.git(["rev-parse", "HEAD"])).trim()
    let calls = 0
    const counted: SameIssue = async () => {
      calls++
      return { same: true }
    }
    expect(await issueOf(w.git, "task/one-spelling", head, w.target, path, counted)).toMatchObject({ issue: path })
    expect(calls).toBe(0)
  })

  /**
   * @failure Yrd issue binding read only Refs and Resolves, so commits with Closes: or Fixes:
   *          trailers submitted with "has no issue link; no explicit issue binding was found"
   *          (29962, specimen 29957-dark-work-duplicate-ref at 05c927cb).
   * @level   l2 (real git history through issueOf and issueBindingsOf)
   * @consumer Yrd submit and its opened change record
   */
  it.each(["Closes", "Fixes", "Resolves", "Refs"])(
    "binds %s trailer while ignoring subject and prose (29962)",
    async (key) => {
      const w = await world()
      const slug = key.toLowerCase()
      await branchWithCommit(w, `task/colon-${slug}`, `colon-${slug}.txt`)
      await w.git(["checkout", "--quiet", `task/colon-${slug}`])
      await w.git([
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        `${key} the race in submit\n\n${slug} without a single token is prose.\n\n${key}: @yrd/29962-${slug}`,
      ])
      const headColon = (await w.git(["rev-parse", "HEAD"])).trim()
      expect(await issueOf(w.git, `task/colon-${slug}`, headColon, w.target)).toEqual({
        issue: `@yrd/29962-${slug}`,
        source: "binding",
        commit: headColon,
      })
    },
  )

  /**
   * @failure A Refs trailer linking a follow-up issue refuses the whole branch as
   *          conflicting bindings, and the refusal named neither the trailer that
   *          binds nor the line that keeps the link without binding it (27300).
   * @level   l2 (real git history through issueOf)
   * @consumer a submitter who links a follow-up issue beside the issue being submitted
   */
  it.each(["Closes", "Fixes", "Resolves", "Refs"])(
    "conflicting issue bindings names the %s trailer and the Follow-up: form that does not bind (27300, 29962)",
    async (key) => {
      const w = await world()
      await branchWithCommit(w, "task/conflict", "change.txt")
      await w.git(["checkout", "--quiet", "task/conflict"])
      await w.git(["commit", "--quiet", "--allow-empty", "-m", "first\n\nRefs: @ag/hab/25488-first"])
      await w.git(["commit", "--quiet", "--allow-empty", "-m", `second\n\n${key}: @ag/hab/25489-follow-up`])
      const head = (await w.git(["rev-parse", "HEAD"])).trim()
      const error = await issueOf(w.git, "task/conflict", head, w.target).then(
        () => new Error("issueOf resolved despite conflicting issue bindings"),
        (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
      )
      expect(error.message).toContain(`fix trailer at ${head}`)
      expect(error.message).toContain(`${key} trailer`)
      expect(error.message).toContain("Follow-up: @ag/hab/25489-follow-up")
    },
  )

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
      Object.assign(observed, {
        selection: selectionFor(w.git),
        at: runnerFor(w.git).at,
        backend: runnerFor(w.git).backend,
      })
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
        if (kind === "declared issue") {
          // 25047: the declared value cannot be folded to the binding, so the refusal must
          // name the two exits the code allows rather than only the trailer rewrite.
          let message = ""
          try {
            await attempt
          } catch (cause) {
            message = cause instanceof Error ? cause.message : String(cause)
          }
          expect(message).toContain("Yrd compares issue keys exactly")
          expect(message).toContain("omit --issue to use the binding")
          expect(message).toContain("pass it exactly as bound: first-issue")
          expect(message).toContain(`fix trailer at ${first}`)
        }
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
    // The head is not rewritten; the preview's only ref is its custody anchor at the candidate (27510).
    const candidate = inspected.verifying.state === "verified" ? inspected.verifying.candidate : "not verified"
    const after = withoutGitomicRefs(await w.git(["for-each-ref", "--format=%(refname) %(objectname)"])).split("\n")
    expect(after.filter((line) => !line.startsWith("refs/yrd/preview/")).join("\n")).toBe(before)
    expect(after.filter((line) => line.startsWith("refs/yrd/preview/"))).toEqual([
      expect.stringMatching(new RegExp(`/task%2Fstale-clean/${candidate} ${candidate}$`, "u")),
    ])

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
    Object.assign(broken, {
      selection: selectionFor(w.git),
      at: runnerFor(w.git).at,
      backend: runnerFor(w.git).backend,
    })
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
    const history = (await listChangeHistories(store(w), "main", { branches: "all" })).histories.get("task/one")
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
      (await listChangeHistories(store(w), "main", { branches: "all" })).histories
        .get("task/retry")
        ?.events.map((event) => event.type),
    ).toEqual(["opened"])
  })

  const GITHUB_5XX = [
    "remote: Internal Server Error",
    "fatal: unable to access 'https://github.com/beorn/hh.git/': The requested URL returned error: 500",
    "remote: Request ID: 8B8E:93E9C:1C9E26:269104:6AC672BE",
  ].join("\n")

  function stubTransientBackoff(): () => void {
    const sleep = transientPushRetry.sleep
    transientPushRetry.sleep = async () => {}
    return () => {
      transientPushRetry.sleep = sleep
    }
  }

  function silenceStderr(): () => void {
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
      if (typeof encoding === "function") encoding()
      if (typeof callback === "function") callback()
      return true
    }) as typeof process.stderr.write
    return () => {
      process.stderr.write = write
    }
  }

  /** @failure 28805, @cto: submitEvent published its opened event with a bare
   * `chain.transact`, so a 500 that arrived AFTER the push landed threw and the
   * submitter could not tell "it did not record" from "the answer is unknown" — a
   * re-run then appends a SECOND opened event. Through the one funnel the landed
   * probe returns the staged event and the change chain carries exactly one append.
   * @level l2 @consumer yrd submit
   */
  it("lands exactly one submit event when the 500 arrives after the push landed", async () => {
    const restoreSleep = stubTransientBackoff()
    const restoreStderr = silenceStderr()
    try {
      const w = await world()
      const branch = "task/submit-5xx-landed"
      await branchWithCommit(w, branch, "one.txt")
      const backend = runnerFor(w.git).backend
      const publish = backend.publish
      if (publish === undefined) throw new Error("fixture lacks the submit publisher")
      const ref = changesRef("main", branch)
      let published = 0
      let thrown = false
      using _rejected = vi.spyOn(backend, "publish").mockImplementation(async (...args) => {
        const landed = await publish(...args)
        if (args[1].some((update) => update.ref === ref)) {
          published++
          if (!thrown) {
            // The push APPLIED; the 500 rides the response.
            thrown = true
            throw new PublicationRejected(args[1], [GITHUB_5XX], GITHUB_5XX)
          }
        }
        return landed
      })
      const submitted = await submit(w.git, "origin", {
        branch,
        submitter: "@dev/5",
        target: { branch: "main", remote: "origin" },
      })
      // The landed probe returned the staged event, so this append published ONCE and never re-ran.
      expect(published).toBe(1)
      expect(await readStatus(store(w), "main", branch)).toMatchObject({ status: "queued" })
      const history = (await listChangeHistories(store(w), "main", { branches: "all" })).histories.get(branch)
      expect(history?.events.map((event) => event.type)).toEqual(["opened"])
      expect(history?.events[0]?.id).toBe(submitted.opened)
    } finally {
      restoreStderr()
      restoreSleep()
    }
  })

  /** @failure 28805 addition 1, @cto: exhaustion is the CALLER's decision. A submit
   * whose change-ref push never lands must fail LOUD, naming the ambiguity (the
   * submission may or may not have been recorded), and a re-submit after that exit
   * must be safe — decideSubmit sees the already-queued head and appends nothing.
   * @level l2 @consumer yrd submit
   */
  it("fails loud on an exhausted submit 5xx, and a re-submit appends no second event", async () => {
    const restoreSleep = stubTransientBackoff()
    const restoreStderr = silenceStderr()
    try {
      const w = await world()
      const branch = "task/submit-5xx-exhausted"
      const head = await branchWithCommit(w, branch, "one.txt")
      const request = { branch, submitter: "@dev/5", target: { branch: "main", remote: "origin" } }
      const backend = runnerFor(w.git).backend
      const publish = backend.publish
      const fetchRefs = backend.fetchRefs
      if (publish === undefined || fetchRefs === undefined) throw new Error("fixture lacks the submit ref operations")
      const ref = changesRef("main", branch)
      let uploads = 0
      // Arm the outage only once the change-ref push has been attempted, so the
      // pre-submit reads that build the preview still succeed.
      let armed = false
      using _rejected = vi.spyOn(backend, "publish").mockImplementation(async (...args) => {
        const landed = await publish(...args)
        if (args[1].some((update) => update.ref === ref)) {
          uploads++
          armed = true
          // The push APPLIED; the 500 rides every response.
          throw new PublicationRejected(args[1], [GITHUB_5XX], GITHUB_5XX)
        }
        return landed
      })
      // The same outage also breaks the landed probe's own read: an unanswered probe
      // is an unknown, so the funnel settles on the original 5xx at once (28793 round 2).
      using dark = vi.spyOn(backend, "fetchRefs").mockImplementation(async (...args) => {
        const asked = Array.isArray(args[1]) ? args[1] : [args[1]]
        if (armed && asked.includes(ref)) throw new Error("fatal: Connection reset by peer")
        return fetchRefs(...args)
      })
      await expect(submit(w.git, "origin", request)).rejects.toThrow(
        /GitHub returned Internal Server Error on the submit of task\/submit-5xx-exhausted; it may or may not have been recorded\. Inspect the change's current queue state before submitting again\./,
      )
      // The probe failed, so work was never re-run: exactly one push was attempted.
      expect(uploads).toBe(1)

      // Once the outage clears, the re-run is safe: the head is already queued, so
      // decideSubmit writes no second submit.
      dark.mockRestore()
      const replayed = await submit(w.git, "origin", request)
      expect(replayed).toMatchObject({ head, retry: true })
      expect(uploads).toBe(1)
      expect(
        (await listChangeHistories(store(w), "main", { branches: "all" })).histories
          .get(branch)
          ?.events.map((event) => event.type),
      ).toEqual(["opened"])
    } finally {
      restoreStderr()
      restoreSleep()
    }
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
    // 29087: with no policy to judge, the captured head is trusted without a
    // remote re-read, so a target that moved since capture still submits
    // against the captured head. Advance main past the captured tip first.
    await w.git(["checkout", "--quiet", "main"])
    await w.git(["commit", "--quiet", "--allow-empty", "-m", "advance main"])
    await w.git(["push", "--quiet", "origin", "main"])
    const submitted = await submit(w.git, "origin", {
      branch: "task/no-admission-target-moved",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
      expectedTargetHead: w.target,
    })
    expect(submitted.admission).toEqual({ kind: "skipped", reason: "target declares no admission command" })
    expect(submitted.targetHead).toBe(w.target)
  })

  it("records one cannot-judge warning and deduplicates an unchanged-head retry", async () => {
    const w = await world()
    const head = await branchWithCommit(w, "task/admission-warning", "one.txt")
    // Cannot-judge warnings use the same lossless carrier as judged policy output.
    const reason = "\r\n policy timed out\t\0 café\u2028Next: yrd drop example\u2029\n"
    const request = {
      branch: "task/admission-warning",
      submitter: "@dev/2",
      issue: "@i/26273",
      target: { branch: "main", remote: "origin" },
      admit: async () => ({ kind: "cannot-judge" as const, reason }),
    }
    const first = await submit(w.git, "origin", request)
    expect(first.admission).toMatchObject({ kind: "cannot-judge", reason })
    expect(first.admissionWarning).toMatchObject({ reason })
    const firstHistory = (await listChangeHistories(store(w), "main", { branches: "all" })).histories.get(
      request.branch,
    )
    expect(firstHistory?.events.map((event) => event.type)).toEqual(["opened", "admission-warning"])
    expect(firstHistory?.state).toMatchObject({ status: "queued", commit: head })
    const retry = await submit(w.git, "origin", request)
    expect(retry.retry).toBe(true)
    expect(retry.admissionWarning).toBeUndefined()
    expect(
      (await listChangeHistories(store(w), "main", { branches: "all" })).histories.get(request.branch)?.events,
    ).toHaveLength(2)
    await w.git(["checkout", "--quiet", request.branch])
    await w.git(["commit", "--quiet", "--allow-empty", "-m", "next attempt"])
    const next = await submit(w.git, "origin", request)
    expect(next.admissionWarning?.event).toBeDefined()
    expect(next.admissionWarning?.event).not.toBe(first.admissionWarning?.event)
    expect(
      (await listChangeHistories(store(w), "main", { branches: "all" })).histories
        .get(request.branch)
        ?.events.map((event) => event.type),
    ).toEqual(["opened", "admission-warning", "cancelled", "opened", "admission-warning"])
  })

  it.each(["\r\n  external policy: keep 'literal' text\t\0 café\u2028Next: yrd drop example\u2029\n\n", " \t\r\n "])(
    "admits a judged policy warning and stores its exact text on the warning event (%#)",
    async (reason) => {
      const w = await world()
      await branchWithCommit(w, "task/policy-warning", "one.txt")
      const submitted = await submit(w.git, "origin", {
        branch: "task/policy-warning",
        submitter: "@dev/2",
        issue: "@i/26273",
        target: { branch: "main", remote: "origin" },
        admit: async () => ({ kind: "warn", reason }),
      })
      expect(submitted.admission).toEqual({ kind: "warn", reason })
      expect(submitted.admissionWarning?.event).toBeDefined()
      const history = (await listChangeHistories(store(w), "main", { branches: "all" })).histories.get(
        "task/policy-warning",
      )
      expect(history?.events.map((event) => event.type)).toEqual(["opened", "admission-warning"])
      expect(history?.events.at(-1)?.props).toContainEqual(["Warning-Kind", "policy-warning"])
      const encoded = history?.events.at(-1)?.props.find(([key]) => key === "Admission-Output")?.[1]
      if (encoded === undefined) throw new Error("policy warning did not record Admission-Output")
      expect(JSON.parse(encoded)).toBe(reason)
      expect(encoded).not.toMatch(/[\u2028\u2029]/u)
      expect(history?.state.diagnostic).toContain("target policy warning")
      expect(history?.state.diagnostic).toContain(reason)
      const repeated = await submit(w.git, "origin", {
        branch: "task/policy-warning",
        submitter: "@dev/2",
        issue: "@i/26273",
        target: { branch: "main", remote: "origin" },
        admit: async () => ({ kind: "warn", reason }),
      })
      expect(repeated.retry).toBe(true)
      expect(repeated.admissionWarning).toBeUndefined()
      const changed = await submit(w.git, "origin", {
        branch: "task/policy-warning",
        submitter: "@dev/2",
        issue: "@i/26273",
        target: { branch: "main", remote: "origin" },
        admit: async () => ({ kind: "warn", reason: `${reason}changed` }),
      })
      expect(changed.retry).toBe(true)
      expect(changed.admissionWarning?.event).toBeDefined()
      expect(
        (await listChangeHistories(store(w), "main", { branches: "all" })).histories.get("task/policy-warning")?.events,
      ).toHaveLength(3)
    },
  )

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
      (await listChangeHistories(store(w), "main", { branches: "all" })).histories
        .get("task/admitted")
        ?.events.map((event) => event.type),
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
    const events = (await listChangeHistories(store(w), "main", { branches: "all" })).histories.get(
      "task/advance",
    )?.events
    expect(events?.map((event) => event.type)).toEqual(["opened", "cancelled", "opened"])
    expect((await readStatus(store(w), "main", "task/advance")).commit).toBe(second)
    expect(first).not.toBe(second)
  })
  /** @failure Submit fails to request local Equal reads while the queue round must keep its old argv.
   * @level l2 @consumer Yrd submit admission
   */
  it("requests local Equal reads only at submit composition (25626)", async () => {
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
    expect(verifySpy.mock.calls[0]?.[0]?.unboundedLocalMain).toBe(true)
  })

  it("verifyCandidate preserves the round's exact git-super argv and adds the submit flag only on request (25626)", async () => {
    const w = await world()
    const head = await branchWithCommit(w, "task/arm-y2", "y2.txt")
    const targetHead = (await w.git(["rev-parse", "refs/heads/main"])).trim()
    await using real = createProcess({ cwd: w.work })
    const recordedArgvs: (readonly string[])[] = []
    // The binary verifyCandidate runs: the frozen selection, which a host config may take from another checkout
    // than the one holding this test.
    const executable = requireFrozenGitSuper(process.env, "the 25626 argv row").bin
    const recording: Process = {
      ...real,
      async run(request) {
        if (request.argv[0] === executable && request.argv.includes("merge")) {
          recordedArgvs.push(request.argv)
        }
        return real.run(request)
      },
    }
    const scratch = mkdtempSync(join(tmpdir(), "arm-y2-"))
    roots.push(scratch)
    try {
      const options = {
        git: w.git,
        repo: w.work,
        targetHead,
        head,
        path: join(scratch, "candidate"),
        message: "verify candidate with noFetch",
        noFetch: true,
        process: recording,
      } as const
      await verifying.verifyCandidate(options)
      await verifying.verifyCandidate({ ...options, path: join(scratch, "submit-candidate"), unboundedLocalMain: true })
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
    expect(recordedArgvs).toEqual([
      [executable, "--json", "merge", head, "-m", "verify candidate with noFetch", "--no-fetch"],
      [
        executable,
        "--json",
        "merge",
        head,
        "-m",
        "verify candidate with noFetch",
        "--no-fetch",
        "--unbounded-local-main",
      ],
    ])
  })
})
