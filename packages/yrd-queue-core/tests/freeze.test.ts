/**
 * @failure  A queue reads malformed or overwritten freeze authority as open,
 *           so admission or merge work proceeds while the operator intended
 *           it to stop.
 * @level    l1 (queue-core APIs over one real bare Git remote and two clones)
 * @consumer submit admission and queue runs, which both trust this record ref
 *           before writing
 *
 * A merge freeze is one record ref at the queue's remote. These tests use a
 * real bare remote because the lease, not an in-process flag, is the safety
 * boundary.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { FREEZE_REF, gitIn, readFreeze, writeFreeze, type Git } from "../src/index.ts"

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

type World = Readonly<{ git: Git; other: Git }>

async function world(): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "yrd-freeze-"))
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

describe("the queue freeze is one leased record ref at the remote", () => {
  it("records frozen and unfrozen records with who, when and why", async () => {
    const w = await world()

    expect(await readFreeze(w.git, "origin")).toBeUndefined()
    const frozen = await writeFreeze(w.git, "origin", {
      by: "@chief",
      kind: "frozen",
      reason: "49 new failures on main",
    })

    expect(await readFreeze(w.other, "origin")).toEqual(frozen)
    expect(frozen).toMatchObject({ by: "@chief", kind: "frozen", reason: "49 new failures on main" })
    expect(frozen.at).toBeInstanceOf(Date)

    const unfrozen = await writeFreeze(w.other, "origin", {
      by: "operator",
      kind: "unfrozen",
      reason: "the repair landed",
    })
    expect(await readFreeze(w.git, "origin")).toEqual(unfrozen)
    expect(unfrozen).toMatchObject({ by: "operator", kind: "unfrozen", reason: "the repair landed" })
    expect((await w.other(["log", "-1", "--format=%(trailers:only,unfold)", FREEZE_REF])).trim()).toBe(
      "Record: unfrozen\nFrozen-By: operator",
    )
  })

  it("refuses the second writer when two records race from one observed tip", async () => {
    const w = await world()
    await writeFreeze(w.git, "origin", { by: "@chief", kind: "frozen", reason: "investigating" })
    let raced = false
    const racingGit: Git = async (args, input) => {
      if (!raced && args[0] === "push" && args.some((argument) => argument.endsWith(`:${FREEZE_REF}`))) {
        raced = true
        await writeFreeze(w.other, "origin", { by: "operator", kind: "unfrozen", reason: "cleared elsewhere" })
      }
      return await w.git(args, input)
    }

    await expect(
      writeFreeze(racingGit, "origin", { by: "@chief", kind: "unfrozen", reason: "my stale clear" }),
    ).rejects.toThrow()
    expect(await readFreeze(w.git, "origin")).toMatchObject({ by: "operator", reason: "cleared elsewhere" })
  })

  it("teaches the one-time reset when the freeze ref uses the preceding record spelling", async () => {
    const w = await world()
    const tree = (await w.git(["mktree"], "")).trim()
    const previous = (
      await w.git([
        "commit-tree",
        tree,
        "-m",
        ["repair landed", "", ["Ev", "ent: unfrozen"].join(""), "Frozen-By: @chief", ""].join("\n"),
      ])
    ).trim()
    await w.git(["push", "--quiet", "origin", `${previous}:${FREEZE_REF}`])

    await expect(readFreeze(w.other, "origin")).rejects.toThrow(/former Event trailer/u)
    await expect(readFreeze(w.other, "origin")).rejects.toThrow(/Bundle and reset refs\/yrd\/freeze/u)
  })

  it("fails closed when the ref exists but is not a freeze record", async () => {
    const w = await world()
    const tree = (await w.git(["mktree"], "")).trim()
    const malformed = (await w.git(["commit-tree", tree, "-m", "mystery state"])).trim()
    await w.git(["push", "--quiet", "origin", `${malformed}:${FREEZE_REF}`])

    await expect(readFreeze(w.other, "origin")).rejects.toThrow(
      `${FREEZE_REF} at ${malformed.slice(0, 12)} carries no valid Record: frozen|unfrozen trailer`,
    )
  })

  it("fails closed when the ref carries conflicting freeze trailers", async () => {
    const w = await world()
    const tree = (await w.git(["mktree"], "")).trim()
    const ambiguous = (
      await w.git([
        "commit-tree",
        tree,
        "-m",
        "ambiguous state\n\nRecord: frozen\nRecord: unfrozen\nFrozen-By: @chief\n",
      ])
    ).trim()
    await w.git(["push", "--quiet", "origin", `${ambiguous}:${FREEZE_REF}`])

    await expect(readFreeze(w.other, "origin")).rejects.toThrow("found 2; exactly one is required")
  })
})
