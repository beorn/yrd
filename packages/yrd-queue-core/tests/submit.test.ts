/**
 * Submit and the queue read, against a real remote.
 *
 * A bare repository plays the queue's remote; a working clone plays the
 * submitter. Every assertion reads the remote's refs back through git, because
 * the remote is the one store and what it holds is the only truth.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  changeName,
  changeRef,
  gitIn,
  inLine,
  inspectSubmit,
  issueOf,
  parseChangeName,
  parseChangeRef,
  pauseRef,
  queueRefPrefix,
  readRecords,
  readQueue,
  readPause,
  refusePathShapedBranch,
  selectionFor,
  refAt,
  submit,
  writePause,
} from "../src/index.ts"
import { legacyStore, recordCommit } from "../src/legacy-records.ts"
import { remoteUrl } from "../src/remote.ts"
import type { Git } from "../src/index.ts"

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

type World = Readonly<{ git: Git; work: string; remote: string; target: string }>

/** A bare remote holding `main` at one commit, and a clone of it. */
async function world(): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "yrd-core-remote-"))
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
  await git(["add", "target.txt"])
  await git(["commit", "--quiet", "-m", "base"])
  await git(["push", "--quiet", "origin", "main"])
  const target = (await git(["rev-parse", "HEAD"])).trim()
  return { git, remote, target, work }
}

// Remote identity must match the URL Git reads, while preserving the logical
// hosted identity before transport rewriting. Single-URL worlds cannot catch this.
it("the observation names the first fetch URL when a remote declares multiple URLs", async () => {
  const w = await world()
  const first = "https://example.test/owner/product.git"
  await w.git(["remote", "set-url", "origin", first])
  await w.git(["config", "--add", "remote.origin.url", "https://example.test/other/product.git"])
  await w.git(["config", `url.${w.remote}.insteadOf`, first])
  expect((await w.git(["remote", "get-url", "origin"])).trim()).toBe(w.remote)
  expect(await readQueue(w.git, "origin", "main", w.target)).toMatchObject({ changes: [] })
  expect(await remoteUrl(w.git, "origin")).toBe(first)
})

async function branchWithCommit(w: World, branch: string, file: string): Promise<string> {
  await w.git(["checkout", "--quiet", "-b", branch, "main"])
  writeFileSync(join(w.work, file), `${file}\n`)
  await w.git(["add", file])
  await w.git(["commit", "--quiet", "-m", file])
  const head = (await w.git(["rev-parse", "HEAD"])).trim()
  await w.git(["checkout", "--quiet", "main"])
  return head
}

it("a queue reading with N changes asks ancestry once", async () => {
  const w = await world()
  for (const n of [1, 2, 3]) {
    await branchWithCommit(w, `task/n${n}`, `n${n}.txt`)
    await submit(w.git, "origin", {
      branch: `task/n${n}`,
      submitter: "@dev/2",
      target: { remote: "origin", branch: "main" },
    })
  }
  let revListStdin = 0
  let mergeBaseIsAncestor = 0
  const git: Git = async (args, input) => {
    if (args[0] === "rev-list" && args.includes("--stdin")) revListStdin++
    if (args[0] === "merge-base" && args.includes("--is-ancestor")) mergeBaseIsAncestor++
    return w.git(args, input)
  }
  Object.assign(git, { selection: selectionFor(w.git) })
  const reading = await readQueue(git, "origin", "main", w.target)
  expect(reading.changes).toHaveLength(3)
  expect(revListStdin).toBe(1)
  expect(mergeBaseIsAncestor).toBe(0)
})

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

describe("submit is one atomic push of the branch and its opened record", () => {
  /** @failure Later heads/renames lose bindings, or target history assigns unrelated work.
   * @level l2 @consumer Yrd env open and submit
   */
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
    expect(await remoteRefs(w)).toEqual(["refs/heads/main"])
    expect(await w.git(["for-each-ref", "refs/yrd/main/"])).toBe("")
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
    expect(await remoteRefs(w)).toEqual(["refs/heads/main"])
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
    expect(await remoteRefs(w)).toEqual(["refs/heads/main"])
  })

  it("publishes the inspected head when local branch and remote target move before Gitomic publication", async () => {
    const w = await world()
    const head = await branchWithCommit(w, "task/race", "change.txt")
    const tree = (await w.git(["rev-parse", `${head}^{tree}`])).trim()
    const later = (await w.git(["commit-tree", tree, "-p", head, "-m", "later local commit"])).trim()
    const targetTree = (await w.git(["rev-parse", `${w.target}^{tree}`])).trim()
    const targetLater = (await w.git(["commit-tree", targetTree, "-p", w.target, "-m", "later target"])).trim()
    let raced = false
    const racing: Git = async (args, input) => {
      if (!raced && args[0] === "commit-tree" && args.some((arg) => arg.includes("submitted task/race"))) {
        raced = true
        await w.git(["update-ref", "refs/heads/task/race", later])
        await w.git(["push", "--quiet", "origin", `${targetLater}:refs/heads/main`])
      }
      return w.git(args, input)
    }
    Object.assign(racing, { selection: selectionFor(w.git) })
    const opened = await submit(racing, "origin", {
      branch: "task/race",
      submitter: "@dev/3",
      target: { remote: "origin", branch: "main" },
    })
    expect(raced).toBe(true)
    expect(opened).toMatchObject({ head, targetHead: w.target })
    expect(await refAt(gitIn(w.remote), "refs/heads/task/race")).toBe(head)
    expect(await refAt(gitIn(w.remote), "refs/heads/main")).toBe(targetLater)
    expect(await refAt(w.git, "refs/heads/task/race")).toBe(later)
  })

  it("merges both refs at the remote, and the opened record names who, where and what", async () => {
    const w = await world()
    const head = await branchWithCommit(w, "task/one", "one.txt")
    const submitted = await submit(w.git, "origin", {
      branch: "task/one",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
      issue: "@i/10-yrd/24061",
    })

    expect(submitted.head).toBe(head)
    expect(submitted.retry).toBe(false)
    const refs = await remoteRefs(w)
    expect(refs).toContain("refs/heads/task/one")
    expect(refs).toContain(changeRef("main", { branch: "task/one", head }))
    const records = await readRecords(w.git, submitted.opened)
    expect(records.map((record) => record.kind)).toEqual(["opened"])
    expect(records[0]?.trailers).toEqual(
      expect.arrayContaining([
        ["Change", `task/one@${head}`],
        ["Submitter", "@dev/2"],
        ["Issue", "@i/10-yrd/24061"],
      ]),
    )
    expect(records[0]?.trailers.some(([name]) => name === "Target" || name === "Queue")).toBe(false)
  })

  it("at an unchanged head is a retry: a second opened record, one change", async () => {
    const w = await world()
    await branchWithCommit(w, "task/one", "one.txt")
    await submit(w.git, "origin", {
      branch: "task/one",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })
    const again = await submit(w.git, "origin", {
      branch: "task/one",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })

    expect(again.retry).toBe(true)
    const records = await readRecords(w.git, again.opened)
    expect(records.map((record) => record.kind)).toEqual(["opened", "opened"])
    expect((await remoteRefs(w)).filter((ref) => ref.startsWith("refs/yrd/main/task/one@"))).toHaveLength(1)
  })

  it("refuses the target: the target is not a change, so nothing at the remote is written", async () => {
    const w = await world()

    await expect(
      submit(w.git, "origin", { branch: "main", submitter: "@dev/2", target: { branch: "main", remote: "origin" } }),
    ).rejects.toThrow("main is the target, not a change")
    expect(await remoteRefs(w)).toEqual(["refs/heads/main"])
  })

  it("a new head is a new change beside the old one", async () => {
    const w = await world()
    const first = await branchWithCommit(w, "task/one", "one.txt")
    await submit(w.git, "origin", {
      branch: "task/one",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })
    await w.git(["checkout", "--quiet", "task/one"])
    writeFileSync(join(w.work, "two.txt"), "two\n")
    await w.git(["add", "two.txt"])
    await w.git(["commit", "--quiet", "-m", "two"])
    const second = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])
    await submit(w.git, "origin", {
      branch: "task/one",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })

    const refs = await remoteRefs(w)
    expect(refs).toContain(changeRef("main", { branch: "task/one", head: first }))
    expect(refs).toContain(changeRef("main", { branch: "task/one", head: second }))
  })
})

describe("a change is named <branch>@<sha>, and that name is the last part of its ref", () => {
  it("is read from the right, so a branch may itself carry @ and slashes, and a tail that is not a full sha is not a change", () => {
    const head = "0123456789abcdef0123456789abcdef01234567"
    expect(changeName({ branch: "task/one", head })).toBe(`task/one@${head}`)
    expect(changeRef("main", { branch: "task/one", head })).toBe(`refs/yrd/main/task/one@${head}`)
    expect(parseChangeRef("main", changeRef("main", { branch: "task/one", head }))).toEqual({
      branch: "task/one",
      head,
    })
    expect(parseChangeName(changeName({ branch: "a@b/c@d", head }))).toEqual({ branch: "a@b/c@d", head })
    expect(parseChangeName(`task/one/${head}`)).toBeUndefined()
    expect(parseChangeName("a@bb/c")).toBeUndefined()
    expect(parseChangeName(`@${head}`)).toBeUndefined()
    expect(parseChangeRef("main", `refs/heads/task/one@${head}`)).toBeUndefined()
  })

  it("is a ref git accepts and reads back, @ included", async () => {
    const w = await world()
    const head = await branchWithCommit(w, "task/one@v2", "one.txt")
    const submitted = await submit(w.git, "origin", {
      branch: "task/one@v2",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })

    expect(await remoteRefs(w)).toContain(`refs/yrd/main/task/one@v2@${head}`)
    expect((await readRecords(w.git, submitted.opened)).map((record) => record.kind)).toEqual(["opened"])
    expect(
      (await readQueue(w.git, "origin", "main", w.target)).changes.map((entry) => [
        entry.change.branch,
        entry.change.head,
      ]),
    ).toEqual([["task/one@v2", head]])
  })

  it("encodes the queue as one injective component and keeps two queues' refs disjoint", async () => {
    const head = "0123456789abcdef0123456789abcdef01234567"
    expect(queueRefPrefix("release/1.x")).toBe("refs/yrd/release%2F1.x")
    expect(queueRefPrefix("release%2F1.x")).toBe("refs/yrd/release%252F1.x")
    expect(queueRefPrefix("rélease")).toBe("refs/yrd/r%C3%A9lease")
    expect(pauseRef("release/1.x")).toBe("refs/yrd/release%2F1.x/pause")
    expect(changeRef("release/1.x", { branch: "task/one", head })).toBe(`refs/yrd/release%2F1.x/task/one@${head}`)
    expect(parseChangeRef("main", changeRef("release/1.x", { branch: "task/one", head }))).toBeUndefined()

    const w = await world()
    const actualHead = await branchWithCommit(w, "task/shared", "shared.txt")
    await submit(w.git, "origin", {
      branch: "task/shared",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })
    await w.git(["push", "--quiet", "origin", `${w.target}:refs/heads/release/1.x`])
    await submit(w.git, "origin", {
      branch: "task/shared",
      submitter: "@dev/2",
      target: { branch: "release/1.x", remote: "origin" },
    })

    const refs = await remoteRefs(w)
    expect(refs).toContain(changeRef("main", { branch: "task/shared", head: actualHead }))
    expect(refs).toContain(changeRef("release/1.x", { branch: "task/shared", head: actualHead }))
  })
})

describe("the queue read is every submitted change at the remote", () => {
  // Until ruling E2 (2026-09-02 evening) this asserted the opposite: a bare
  // push read as a change in state queued, opened by the next run.
  it("a branch pushed without a submit is not a change: the queue read does not list it, and a submit later opens it (E2)", async () => {
    const w = await world()
    const head = await branchWithCommit(w, "task/bare", "bare.txt")
    await w.git(["push", "--quiet", "origin", "task/bare"])

    expect(
      (await readQueue(w.git, "origin", "main", w.target)).changes.find((entry) => entry.change.branch === "task/bare"),
    ).toBeUndefined()
    // Nothing is lost: the branch stands at the remote until its author says so.
    expect(await remoteRefs(w)).toContain("refs/heads/task/bare")

    await submit(w.git, "origin", {
      branch: "task/bare",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })
    const opened = (await readQueue(w.git, "origin", "main", w.target)).changes.find(
      (entry) => entry.change.branch === "task/bare",
    )
    expect(opened?.change.head).toBe(head)
    expect(opened?.reading.state).toBe("queued")
  })

  it("two readers fetch only submitted changes without changing shared refs or FETCH_HEAD (E3)", async () => {
    const w = await world()
    // Another clone puts a commit this clone has never seen on 200 branches.
    const other = join(dirname(w.work), "other")
    await gitIn(dirname(w.work))(["clone", "--quiet", w.remote, other])
    const og = gitIn(other)
    await og(["config", "user.email", "bulk@yrd.test"])
    await og(["config", "user.name", "bulk"])
    writeFileSync(join(other, "bulk.txt"), "bulk\n")
    await og(["add", "bulk.txt"])
    await og(["commit", "--quiet", "-m", "bulk"])
    const bulk = (await og(["rev-parse", "HEAD"])).trim()
    await og(["push", "--quiet", "origin", "HEAD:refs/heads/bulk/0"])
    await gitIn(w.remote)(
      ["update-ref", "--stdin"],
      Array.from({ length: 199 }, (_, index) => `create refs/heads/bulk/${index + 1} ${bulk}\n`).join(""),
    )
    await branchWithCommit(w, "task/one", "one.txt")
    await submit(w.git, "origin", {
      branch: "task/one",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })
    await branchWithCommit(w, "task/two", "two.txt")
    await submit(w.git, "origin", {
      branch: "task/two",
      submitter: "@dev/3",
      target: { branch: "main", remote: "origin" },
    })
    // A reading must not recreate the submitter's tracking refs.
    await w.git(["update-ref", "-d", "refs/remotes/origin/task/one"])
    await w.git(["update-ref", "-d", "refs/remotes/origin/task/two"])
    expect((await remoteRefs(w)).filter((ref) => ref.startsWith("refs/heads/bulk/"))).toHaveLength(200)
    const refs = ["for-each-ref", "--format=%(refname)%00%(objectname)"]
    const before = withoutGitomicRefs(await w.git(refs))
    const fetchHead = (await w.git(["rev-parse", "--path-format=absolute", "--git-path", "FETCH_HEAD"])).trim()
    writeFileSync(fetchHead, "caller-owned fetch evidence\n")

    const [first, second] = await Promise.all([
      readQueue(w.git, "origin", "main", w.target),
      readQueue(w.git, "origin", "main", w.target),
    ])

    expect(first.changes.map((entry) => entry.change.branch).sort()).toEqual(["task/one", "task/two"])
    expect(second).toEqual(first)
    // D1: observation fences the entire selected advertisement, including
    // unrelated heads, without fetching their objects into the caller.
    expect(first.observation.checked).toEqual([])
    expect(first.observation.fence.prefixes).toEqual(["refs/heads/", `${queueRefPrefix("main")}/`])
    expect(first.observation.fence.refs.filter(({ ref }) => ref.startsWith("refs/heads/bulk/"))).toHaveLength(200)
    expect(first.observation.fence.refs).toContainEqual({ ref: "refs/heads/main", oid: w.target })
    expect(withoutGitomicRefs(await w.git(refs))).toBe(before)
    expect(readFileSync(fetchHead, "utf8")).toBe("caller-owned fetch evidence\n")
    // Never fetched means not here at all: the bulk commit's object never arrived.
    await expect(w.git(["cat-file", "-e", bulk])).rejects.toThrow(/exited 1/u)
  })

  it("a deleted branch ignores stale local refs, and pause comes from the same captured reading (E3)", async () => {
    const w = await world()
    const head = await branchWithCommit(w, "task/gone", "gone.txt")
    await submit(w.git, "origin", {
      branch: "task/gone",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })
    expect(await refAt(w.git, "refs/remotes/origin/task/gone")).toBe(head)
    // Taken out at the remote by somebody else, so this clone's tracking ref lingers.
    await gitIn(w.remote)(["update-ref", "-d", "refs/heads/task/gone"])
    const paused = await writePause(w.git, "origin", "main", { by: "operator", kind: "paused", reason: "maintenance" })
    const refs = ["for-each-ref", "--format=%(refname)%00%(objectname)"]
    const before = withoutGitomicRefs(await w.git(refs))
    const fetchHead = (await w.git(["rev-parse", "--path-format=absolute", "--git-path", "FETCH_HEAD"])).trim()
    writeFileSync(fetchHead, "caller-owned fetch evidence\n")
    const withinGrace = await readQueue(w.git, "origin", "main", w.target)
    expect(withinGrace.changes.find((entry) => entry.change.branch === "task/gone")).toMatchObject({
      branchUnconfirmed: true,
      reading: { state: "queued" },
    })
    const reading = await readQueue(w.git, "origin", "main", w.target, { now: Date.now() + 75_001 })
    const resumed = await writePause(w.git, "origin", "main", {
      by: "operator",
      kind: "resumed",
      reason: "maintenance complete",
    })

    const gone = reading.changes.find((entry) => entry.change.branch === "task/gone")
    expect(gone?.change.head).toBe(head)
    expect(gone?.reading).toEqual({ reason: "deleted", state: "withdrawn" })
    expect(reading.pause).toEqual(paused)
    expect(reading.observation.fence.refs).toContainEqual({ ref: pauseRef("main"), oid: paused.sha })
    expect(await readPause(w.git, "origin", "main")).toEqual(resumed)
    expect(await refAt(w.git, "refs/remotes/origin/task/gone")).toBe(head)
    expect(withoutGitomicRefs(await w.git(refs))).toBe(before)
    expect(readFileSync(fetchHead, "utf8")).toBe("caller-owned fetch evidence\n")
  })

  /** @failure One incomplete remote branch listing permanently withdrew a live submitted change.
   * @level l2 @consumer Yrd queue reader and runner
   * A real deletion is covered above; this case hides the live ref only from the broad listing.
   */
  it("keeps a submitted change when an exact remote read finds the branch omitted by the broad listing", async () => {
    const w = await world()
    const head = await branchWithCommit(w, "task/live", "live.txt")
    await submit(w.git, "origin", {
      branch: "task/live",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })
    const wrapper = join(dirname(w.remote), "git-omit-broad-head.sh")
    writeFileSync(
      wrapper,
      [
        "#!/bin/sh",
        'case " $* " in',
        '  *"ls-remote"*"refs/heads/*"*)',
        '    output=$(git "$@") || exit $?',
        '    printf "%s\\n" "$output" | sed "/refs\\/heads\\/task\\/live$/d"',
        "    exit 0;;",
        "esac",
        'exec git "$@"',
        "",
      ].join("\n"),
    )
    chmodSync(wrapper, 0o755)
    const selected = { ...selectionFor(w.git), executable: wrapper }
    const reading = await readQueue(gitIn(w.work, undefined, selected), "origin", "main", w.target)
    expect(reading.changes.find(({ change }) => change.branch === "task/live")?.reading).toEqual({ state: "queued" })
    expect(reading.heads.get("task/live")).toBe(head)
    expect(await w.git(["ls-remote", "--refs", "origin", "refs/heads/task/live"])).toContain(head)
  })

  // D1: only a current checked Merge is an observation witness; unknown
  // selected ref names still fence it. Existing E3 cases have no Merge intent.
  it("binds checked observation witnesses to the captured refs and retires terminal intents", async () => {
    const w = await world()
    const head = await branchWithCommit(w, "task/one", "one.txt")
    const change = { branch: "task/one", head }
    await submit(w.git, "origin", { ...change, submitter: "@dev/3", target: { remote: "origin", branch: "main" } })
    const ref = changeRef("main", change)
    const tree = (await w.git(["rev-parse", `${head}^{tree}`])).trim()
    const merge = (await w.git(["commit-tree", tree, "-p", w.target, "-p", head, "-m", "candidate"])).trim()
    const store = await legacyStore(w.git)
    const opened = (await store.backend.fetchRefs(store.repo, ref, "origin")).get(ref)
    if (opened === undefined) throw new Error(`${ref} is absent after submit`)
    const checked = await recordCommit(
      w.git,
      {
        change,
        kind: "checked",
        subject: "checked",
        trailers: [["Merge", merge]],
      },
      opened,
    )
    await store.backend.publish(store.repo, [{ ref, expect: opened, oid: checked }], "origin")
    const unknown = `${queueRefPrefix("main")}/unknown-observation-fence`
    const excluded = `${queueRefPrefix("elsewhere")}/unknown-observation-fence`
    await gitIn(w.remote)(["update-ref", unknown, w.target])
    await gitIn(w.remote)(["update-ref", excluded, w.target])
    const first = await readQueue(w.git, "origin", "main", w.target)
    expect(first.observation.checked).toEqual([{ mergeOid: merge, recordRef: ref, recordOid: checked }])
    expect(first.observation.fence.refs).toContainEqual({ ref, oid: checked })
    expect(first.observation.fence.refs).toContainEqual({ ref: unknown, oid: w.target })
    expect(first.observation.fence.refs.some(({ ref }) => ref === excluded)).toBe(false)
    const failed = await recordCommit(w.git, { change, kind: "failed", subject: "retired" }, checked)
    await store.backend.publish(store.repo, [{ ref, expect: checked, oid: failed }], "origin")
    expect((await readQueue(w.git, "origin", "main", w.target)).observation.checked).toEqual([])
  })

  it("uses Gitomic's current fetched ref map when a change disappears before the read", async () => {
    const w = await world()
    await branchWithCommit(w, "task/one", "one.txt")
    const submitted = await submit(w.git, "origin", {
      branch: "task/one",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })
    const ref = changeRef("main", submitted)
    const reader = join(dirname(w.work), "reader")
    await gitIn(dirname(w.work))(["clone", "--quiet", "--no-local", w.remote, reader])
    const readerGit = gitIn(reader)
    const remoteGit = gitIn(w.remote)
    const refs = ["for-each-ref", "--format=%(refname)%00%(objectname)"]
    const before = withoutGitomicRefs(await readerGit(refs))
    const fetchHead = (await readerGit(["rev-parse", "--path-format=absolute", "--git-path", "FETCH_HEAD"])).trim()
    writeFileSync(fetchHead, "caller-owned fetch evidence\n")
    await remoteGit(["update-ref", "-d", ref])

    const reading = await readQueue(readerGit, "origin", "main", w.target)

    expect(reading.changes).toEqual([])
    expect(reading.observation.fence.refs.some(({ ref: observed }) => observed === ref)).toBe(false)
    expect(withoutGitomicRefs(await readerGit(refs))).toBe(before)
    expect(readFileSync(fetchHead, "utf8")).toBe("caller-owned fetch evidence\n")
    await expect(readerGit(["cat-file", "-e", submitted.opened])).rejects.toThrow(/exited 1/u)

    await w.git(["push", "--quiet", "origin", `${submitted.opened}:${ref}`])
    expect(
      (await readQueue(readerGit, "origin", "main", w.target)).changes.map((entry) => entry.change.branch),
    ).toEqual(["task/one"])
  })

  it("orders by the first opened record, and a superseded head reads failed, replaced", async () => {
    const w = await world()
    const one = await branchWithCommit(w, "task/one", "one.txt")
    await submit(w.git, "origin", {
      branch: "task/one",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })
    // A different clock tick between the two, so the order is not a tie.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await branchWithCommit(w, "task/two", "two.txt")
    await submit(w.git, "origin", {
      branch: "task/two",
      submitter: "@dev/3",
      target: { branch: "main", remote: "origin" },
    })

    // task/one is re-cut: its old change stays, the branch moves on.
    await w.git(["checkout", "--quiet", "task/one"])
    writeFileSync(join(w.work, "one.txt"), "one, amended\n")
    await w.git(["commit", "--quiet", "-am", "one, amended"])
    const oneAgain = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])
    await submit(w.git, "origin", {
      branch: "task/one",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })

    const entries = (await readQueue(w.git, "origin", "main", w.target)).changes
    const byHead = new Map(entries.map((entry) => [entry.change.head, entry]))
    expect(byHead.get(one)?.reading).toMatchObject({ reason: "replaced", state: "withdrawn" })
    expect(byHead.get(oneAgain)?.reading.state).toBe("queued")
    // Position in line is the first opened record's time OF THE CHANGE: a new
    // head is a new change (§ The change), so the re-cut task/one takes its
    // place behind task/two, and the superseded head is not in line at all.
    // Only a retry at an unchanged head keeps its place. (Until 2026-09-02
    // this asserted the opposite and passed on a same-second tie, ordered by
    // ls-remote's alphabetical listing; `Opened:` now carries milliseconds.)
    const ordered = inLine(entries.map((entry) => entry.change)).map((change) => change.head)
    expect(ordered).toEqual([(await w.git(["rev-parse", "task/two"])).trim(), oneAgain])
  })

  it("a head already on the target reads merged, whatever its records say", async () => {
    const w = await world()
    const head = await branchWithCommit(w, "task/one", "one.txt")
    await submit(w.git, "origin", {
      branch: "task/one",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })
    await w.git(["merge", "--quiet", "--no-ff", "-m", "merge task/one", head])
    await w.git(["push", "--quiet", "origin", "main"])

    const target = (await w.git(["ls-remote", "--refs", "origin", "refs/heads/main"])).trim().split(/\s+/u)[0]
    if (target === undefined || target === "") throw new Error("the remote target is absent")
    const entries = (await readQueue(w.git, "origin", "main", target)).changes
    expect(entries.find((entry) => entry.change.branch === "task/one")?.reading.state).toBe("merged")
  })

  it("refuses a task/ branch whose name is path-shaped (25716)", async () => {
    expect(() => refusePathShapedBranch("task/@i/10-yrd/25716-foo")).toThrow(
      'cannot submit path-shaped branch "task/@i/10-yrd/25716-foo": a slash after task/ is refused; use the convention task/<issue-id>-<slug>',
    )
    expect(() => refusePathShapedBranch("task/a/b")).toThrow(
      'cannot submit path-shaped branch "task/a/b": a slash after task/ is refused; use the convention task/<issue-id>-<slug>',
    )
    expect(() => refusePathShapedBranch("task/25716-title-squeeze")).not.toThrow()
    expect(() => refusePathShapedBranch("feature/nested/branch")).not.toThrow()

    const w = await world()
    const attempt = inspectSubmit(w.git, "origin", {
      branch: "task/@i/10-yrd/25716-path",
      submitter: "@dev/9",
      target: { branch: "main", remote: "origin" },
    })
    await expect(attempt).rejects.toThrow("cannot submit path-shaped branch")
    await expect(attempt).rejects.toThrow("task/<issue-id>-<slug>")
  })
})
