/**
 * Submit and the lane, against a real remote.
 *
 * A bare repository plays the queue's remote; a working clone plays the
 * submitter. Every assertion reads the remote's refs back through git, because
 * the remote is the one store and what it holds is the only truth.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { changeRef, gitIn, inLine, lane, readFacts, submit } from "../src/index.ts"
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

describe("submit is one atomic push of the branch and its opened fact", () => {
  it("lands both refs at the remote, and the opened fact names who, where and what", async () => {
    const w = await world()
    const head = await branchWithCommit(w, "task/one", "one.txt")
    const submitted = await submit(w.git, "origin", {
      branch: "task/one",
      submitter: "@dev/2",
      target: "main",
      workItem: "@i/10-yrd/24061",
    })

    expect(submitted.head).toBe(head)
    expect(submitted.retry).toBe(false)
    const refs = await remoteRefs(w)
    expect(refs).toContain("refs/heads/task/one")
    expect(refs).toContain(changeRef("task/one", head))
    const facts = await readFacts(w.git, "task/one", head)
    expect(facts.map((fact) => fact.kind)).toEqual(["opened"])
    expect(facts[0]?.trailers).toEqual(
      expect.arrayContaining([
        ["Submitter", "@dev/2"],
        ["Target", "main"],
        ["Work-Item", "@i/10-yrd/24061"],
      ]),
    )
  })

  it("at an unchanged head is a retry: a second opened fact, one change", async () => {
    const w = await world()
    const head = await branchWithCommit(w, "task/one", "one.txt")
    await submit(w.git, "origin", { branch: "task/one", submitter: "@dev/2", target: "main" })
    const again = await submit(w.git, "origin", { branch: "task/one", submitter: "@dev/2", target: "main" })

    expect(again.retry).toBe(true)
    const facts = await readFacts(w.git, "task/one", head)
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "opened"])
    expect((await remoteRefs(w)).filter((ref) => ref.startsWith("refs/yrd/changes/task/one/"))).toHaveLength(1)
  })

  it("a new head is a new change beside the old one", async () => {
    const w = await world()
    const first = await branchWithCommit(w, "task/one", "one.txt")
    await submit(w.git, "origin", { branch: "task/one", submitter: "@dev/2", target: "main" })
    await w.git(["checkout", "--quiet", "task/one"])
    writeFileSync(join(w.work, "two.txt"), "two\n")
    await w.git(["add", "two.txt"])
    await w.git(["commit", "--quiet", "-m", "two"])
    const second = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])
    await submit(w.git, "origin", { branch: "task/one", submitter: "@dev/2", target: "main" })

    const refs = await remoteRefs(w)
    expect(refs).toContain(changeRef("task/one", first))
    expect(refs).toContain(changeRef("task/one", second))
  })
})

describe("the lane is every change at the remote, read", () => {
  it("a bare push is queued, not invisible", async () => {
    const w = await world()
    const head = await branchWithCommit(w, "task/bare", "bare.txt")
    await w.git(["push", "--quiet", "origin", "task/bare"])

    const entries = await lane(w.git, "origin", "main")
    const bare = entries.find((entry) => entry.branch === "task/bare")
    expect(bare?.change.head).toBe(head)
    expect(bare?.change.facts).toEqual([])
    expect(bare?.reading.state).toBe("queued")
  })

  it("orders by the first opened fact, and a superseded head reads failed, replaced", async () => {
    const w = await world()
    const one = await branchWithCommit(w, "task/one", "one.txt")
    await submit(w.git, "origin", { branch: "task/one", submitter: "@dev/2", target: "main" })
    // A different clock tick between the two, so the order is not a tie.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await branchWithCommit(w, "task/two", "two.txt")
    await submit(w.git, "origin", { branch: "task/two", submitter: "@dev/3", target: "main" })

    // task/one is re-cut: its old change stays, the branch moves on.
    await w.git(["checkout", "--quiet", "task/one"])
    writeFileSync(join(w.work, "one.txt"), "one, amended\n")
    await w.git(["commit", "--quiet", "-am", "one, amended"])
    const oneAgain = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])
    await submit(w.git, "origin", { branch: "task/one", submitter: "@dev/2", target: "main" })

    const entries = await lane(w.git, "origin", "main")
    const byHead = new Map(entries.map((entry) => [entry.change.head, entry]))
    expect(byHead.get(one)?.reading).toMatchObject({ reason: "replaced", state: "failed" })
    expect(byHead.get(oneAgain)?.reading.state).toBe("queued")
    // Position in line is the first opened fact's time OF THE CHANGE: a new
    // head is a new change (§ The change), so the re-cut task/one takes its
    // place behind task/two, and the superseded head is not in line at all.
    // Only a retry at an unchanged head keeps its place. (Until 2026-09-02
    // this asserted the opposite and passed on a same-second tie, ordered by
    // ls-remote's alphabetical listing; `Opened:` now carries milliseconds.)
    const ordered = inLine(entries.map((entry) => entry.change)).map((change) => change.head)
    expect(ordered).toEqual([(await w.git(["rev-parse", "task/two"])).trim(), oneAgain])
  })

  it("a head already on the target reads merged, whatever its facts say", async () => {
    const w = await world()
    const head = await branchWithCommit(w, "task/one", "one.txt")
    await submit(w.git, "origin", { branch: "task/one", submitter: "@dev/2", target: "main" })
    await w.git(["merge", "--quiet", "--no-ff", "-m", "merge task/one", head])
    await w.git(["push", "--quiet", "origin", "main"])

    const entries = await lane(w.git, "origin", "main")
    expect(entries.find((entry) => entry.branch === "task/one")?.reading.state).toBe("merged")
  })
})
