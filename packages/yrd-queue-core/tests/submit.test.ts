/** Submit against a real event queue and remote. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { createProcess, type Process } from "@yrd/process"
import * as verifying from "../src/verifying.ts"
import {
  changesRef,
  createEventQueue,
  createEventStore,
  gitIn,
  inspectSubmit,
  issueOf,
  listChangeHistories,
  queueRef,
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
async function world(): Promise<World> {
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
  await createEventQueue(createEventStore(work, "origin", selectionFor(git)), "main", target, config, new Date())
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
    const submitted = await submit(w.git, "origin", {
      branch: "task/26050",
      submitter: "author",
      target: { remote: "origin", branch: "main" },
      resolveIssue: async (raw) => {
        if (raw === "26050" || raw === canonical) return canonical
        throw new Error(`unknown issue ${raw}`)
      },
    })
    expect(submitted.issue?.issue).toBe(canonical)
    expect((await readStatus(store(w), "main", "task/26050")).issue).toBe(canonical)
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
    expect(await remoteRefs(w)).toEqual(["refs/heads/main", queueRef("main")])
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
    expect(await remoteRefs(w)).toEqual(["refs/heads/main", queueRef("main")])
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
    expect(await remoteRefs(w)).toEqual(["refs/heads/main", queueRef("main")])
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
