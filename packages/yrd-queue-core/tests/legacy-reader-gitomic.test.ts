/**
 * @failure A queue read starts one history process per legacy change, making
 *          queue cost grow with the number of submitted branches.
 * @level   l2 (one real remote through Gitomic's shell backend)
 * @consumer Yrd queue list and queue run
 *
 * The existing injected-Git ancestry assertion cannot see Gitomic's native
 * processes. This test observes that boundary directly and proves the E5
 * contract: one head listing, one queue-prefix fetch and one multi-tip history.
 */

import childProcess from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, it, vi } from "vitest"
import { appendRecord, changeRef, gitIn, queueRefPrefix, readQueue, writePause } from "../src/index.ts"
import { ABSENT, legacyStore } from "../src/legacy-records.ts"
import type { Git } from "../src/index.ts"

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

type World = Readonly<{ git: Git; work: string; target: string }>

async function world(): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "yrd-legacy-reader-gitomic-"))
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
  return { git, target: (await git(["rev-parse", "HEAD"])).trim(), work }
}

async function publishChange(world: World, branch: string, file: string): Promise<string> {
  await world.git(["checkout", "--quiet", "-b", branch, "main"])
  writeFileSync(join(world.work, file), `${file}\n`)
  await world.git(["add", file])
  await world.git(["commit", "--quiet", "-m", file])
  const head = (await world.git(["rev-parse", "HEAD"])).trim()
  await world.git(["checkout", "--quiet", "main"])

  const change = { branch, head }
  const opened = await appendRecord(world.git, "main", {
    change,
    kind: "opened",
    subject: `@dev/2 submitted ${branch} to main`,
    trailers: [["Submitter", "@dev/2"]],
  })
  const store = await legacyStore(world.git)
  // Submit establishes its lease by fetching this exact legacy ref before it
  // publishes. Preserve that real reader precondition before the later queue
  // prefix fetch.
  await store.backend.fetchRefs(store.repo, changeRef("main", change), "origin")
  await store.backend.publish(
    store.repo,
    [
      { ref: `refs/heads/${branch}`, expect: ABSENT, oid: head },
      { ref: changeRef("main", change), expect: ABSENT, oid: opened },
    ],
    "origin",
  )
  return opened
}

it("reads every legacy change through one Gitomic multi-tip history process", async () => {
  const w = await world()
  const opened = [await publishChange(w, "task/one", "one.txt"), await publishChange(w, "task/two", "two.txt")]
  const paused = await writePause(w.git, "origin", "main", {
    by: "@chief",
    kind: "paused",
    reason: "maintenance",
  })
  const spawn = vi.spyOn(childProcess, "spawn")
  try {
    const reading = await readQueue(w.git, "origin", "main", w.target)
    expect(reading.changes.map(({ change }) => change.branch)).toEqual(["task/one", "task/two"])
    expect(reading.pause).toEqual(paused)

    const gitArgs = spawn.mock.calls
      .filter(([command]) => command === "git")
      .map(([, args]) => args as readonly string[])
    const headListings = gitArgs.filter((args) => args.includes("ls-remote") && args.includes("refs/heads/*"))
    const queueFetches = gitArgs.filter(
      (args) => args.includes("fetch") && args.some((arg) => arg.startsWith(`+${queueRefPrefix("main")}*:`)),
    )
    const historyReads = gitArgs.filter((args) => args.includes("rev-list") && args.includes("--first-parent"))

    expect(headListings).toHaveLength(1)
    expect(queueFetches).toHaveLength(1)
    expect(historyReads).toHaveLength(1)
    expect(historyReads[0]).toEqual(expect.arrayContaining([...opened, paused.sha]))
  } finally {
    spawn.mockRestore()
  }
})
