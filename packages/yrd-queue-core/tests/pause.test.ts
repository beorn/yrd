/**
 * @failure  A queue reads malformed or overwritten pause authority as open,
 *           so admission or merge work proceeds while the operator intended
 *           it to stop.
 * @level    l1 (queue-core APIs over one real bare Git remote and two clones)
 * @consumer submit admission and queue runs, which both trust this record ref
 *           before writing
 *
 * A merge pause is one record ref at the queue's remote. These tests use a
 * real bare remote because the lease, not an in-process flag, is the safety
 * boundary.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { gitIn, pauseRef, readPause, writePause, type Git } from "../src/index.ts"

const PAUSE_REF = pauseRef("main")

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

type World = Readonly<{ git: Git; other: Git }>

async function world(): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "yrd-pause-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  const other = join(root, "other")
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  await seed(["clone", "--quiet", remote, other])
  for (const git of [gitIn(work), gitIn(other)]) {
    await git(["config", "user.email", "queue@yrd.test"])
    await git(["config", "user.name", "yrd"])
  }
  return { git: gitIn(work), other: gitIn(other) }
}

describe("the queue pause is one leased record ref at the remote", () => {
  it("records paused and resumed records with who, when and why", async () => {
    const w = await world()

    expect(await readPause(w.git, "origin", "main")).toBeUndefined()
    const paused = await writePause(w.git, "origin", "main", {
      by: "@chief",
      kind: "paused",
      reason: "49 new failures on main",
    })

    expect(await readPause(w.other, "origin", "main")).toEqual(paused)
    expect(paused).toMatchObject({ by: "@chief", kind: "paused", reason: "49 new failures on main" })
    expect(paused.at).toBeInstanceOf(Date)

    const resumed = await writePause(w.other, "origin", "main", {
      by: "operator",
      kind: "resumed",
      reason: "the repair landed",
    })
    expect(await readPause(w.git, "origin", "main")).toEqual(resumed)
    expect(resumed).toMatchObject({ by: "operator", kind: "resumed", reason: "the repair landed" })
    expect((await w.other(["log", "-1", "--format=%(trailers:only,unfold)", PAUSE_REF])).trim()).toBe(
      "Record: resumed\nPaused-By: operator",
    )
  })

  it("refuses the second writer when two records race from one observed tip", async () => {
    const w = await world()
    await writePause(w.git, "origin", "main", { by: "@chief", kind: "paused", reason: "investigating" })
    let raced = false
    const racingGit: Git = async (args, input) => {
      if (!raced && args[0] === "push" && args.some((argument) => argument.endsWith(`:${PAUSE_REF}`))) {
        raced = true
        await writePause(w.other, "origin", "main", { by: "operator", kind: "resumed", reason: "cleared elsewhere" })
      }
      return await w.git(args, input)
    }

    await expect(
      writePause(racingGit, "origin", "main", { by: "@chief", kind: "resumed", reason: "my stale clear" }),
    ).rejects.toThrow()
    expect(await readPause(w.git, "origin", "main")).toMatchObject({ by: "operator", reason: "cleared elsewhere" })
  })

  it("fails closed when the ref exists but is not a pause record", async () => {
    const w = await world()
    const tree = (await w.git(["mktree"], "")).trim()
    const malformed = (await w.git(["commit-tree", tree, "-m", "mystery state"])).trim()
    await w.git(["push", "--quiet", "origin", `${malformed}:${PAUSE_REF}`])

    await expect(readPause(w.other, "origin", "main")).rejects.toThrow(
      `${PAUSE_REF} at ${malformed.slice(0, 12)} carries no valid Record: paused|resumed trailer`,
    )
  })

  it("fails closed when the ref carries conflicting pause trailers", async () => {
    const w = await world()
    const tree = (await w.git(["mktree"], "")).trim()
    const ambiguous = (
      await w.git([
        "commit-tree",
        tree,
        "-m",
        "ambiguous state\n\nRecord: paused\nRecord: resumed\nPaused-By: @chief\n",
      ])
    ).trim()
    await w.git(["push", "--quiet", "origin", `${ambiguous}:${PAUSE_REF}`])

    await expect(readPause(w.other, "origin", "main")).rejects.toThrow("found 2; exactly one is required")
  })
})
