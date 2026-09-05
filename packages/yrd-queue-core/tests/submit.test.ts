/**
 * Submit and the queue read, against a real remote.
 *
 * A bare repository plays the queue's remote; a working clone plays the
 * submitter. Every assertion reads the remote's refs back through git, because
 * the remote is the one store and what it holds is the only truth.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  changeName,
  changeRef,
  gitIn,
  inLine,
  parseChangeName,
  parseChangeRef,
  pauseRef,
  queueRefPrefix,
  readRecords,
  readQueue,
  readPause,
  refAt,
  submit,
  writePause,
} from "../src/index.ts"
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

describe("submit is one atomic push of the branch and its opened record", () => {
  it("lands both refs at the remote, and the opened record names who and what without duplicating its queue", async () => {
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
      (await readQueue(w.git, "origin", "main")).changes.map((entry) => [entry.change.branch, entry.change.head]),
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
      (await readQueue(w.git, "origin", "main")).changes.find((entry) => entry.change.branch === "task/bare"),
    ).toBeUndefined()
    // Nothing is lost: the branch stands at the remote until its author says so.
    expect(await remoteRefs(w)).toContain("refs/heads/task/bare")

    await submit(w.git, "origin", {
      branch: "task/bare",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })
    const opened = (await readQueue(w.git, "origin", "main")).changes.find(
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
    const before = await w.git(refs)
    const fetchHead = (await w.git(["rev-parse", "--path-format=absolute", "--git-path", "FETCH_HEAD"])).trim()
    writeFileSync(fetchHead, "caller-owned fetch evidence\n")

    const [first, second] = await Promise.all([readQueue(w.git, "origin", "main"), readQueue(w.git, "origin", "main")])

    expect(first.changes.map((entry) => entry.change.branch).sort()).toEqual(["task/one", "task/two"])
    expect(second).toEqual(first)
    expect(await w.git(refs)).toBe(before)
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
    const before = await w.git(refs)
    const fetchHead = (await w.git(["rev-parse", "--path-format=absolute", "--git-path", "FETCH_HEAD"])).trim()
    writeFileSync(fetchHead, "caller-owned fetch evidence\n")
    let resumed = false
    const git: Git = async (args, input) => {
      const result = await w.git(args, input)
      if (args[0] === "ls-remote" && !resumed) {
        resumed = true
        await writePause(w.git, "origin", "main", { by: "operator", kind: "resumed", reason: "maintenance complete" })
      }
      return result
    }

    const reading = await readQueue(git, "origin", "main")

    const gone = reading.changes.find((entry) => entry.change.branch === "task/gone")
    expect(gone?.change.head).toBe(head)
    expect(gone?.reading).toEqual({ reason: "deleted", state: "failed" })
    expect(resumed).toBe(true)
    expect(reading.pause).toEqual(paused)
    expect((await readPause(w.git, "origin", "main"))?.kind).toBe("resumed")
    expect(await refAt(w.git, "refs/remotes/origin/task/gone")).toBe(head)
    expect(await w.git(refs)).toBe(before)
    expect(readFileSync(fetchHead, "utf8")).toBe("caller-owned fetch evidence\n")
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

    const entries = (await readQueue(w.git, "origin", "main")).changes
    const byHead = new Map(entries.map((entry) => [entry.change.head, entry]))
    expect(byHead.get(one)?.reading).toMatchObject({ reason: "replaced", state: "failed" })
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

    const entries = (await readQueue(w.git, "origin", "main")).changes
    expect(entries.find((entry) => entry.change.branch === "task/one")?.reading.state).toBe("merged")
  })
})
