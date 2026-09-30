/**
 * @failure  A retired legacy pause tip is still accepted by the event queue.
 * @level    l1 (real bare remote and Gitomic ref fetch)
 * @consumer post-cutover event queue authority read (#25041)
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { type Git } from "../src/git.ts"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { pauseRef } from "../src/refs.ts"
import { createEventQueue, createEventStore, readConfig, readEventOps, selectionFor } from "../src/index.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

async function world(): Promise<{ writer: Git; reader: Git; created: string; target: string; other: string }> {
  const root = mkdtempSync(join(tmpdir(), "yrd-m2-pause-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  const other = join(root, "other")
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  await seed(["clone", "--quiet", remote, other])
  const writer = gitIn(work)
  const reader = gitIn(other)
  for (const git of [writer, reader]) {
    await git(["config", "user.email", "queue@yrd.test"])
    await git(["config", "user.name", "yrd"])
  }
  writeFileSync(join(work, ".yrd.yml"), "{}\n")
  await writer(["add", ".yrd.yml"])
  await writer(["commit", "-m", "declared queue"])
  await writer(["push", "--quiet", "origin", "main"])
  const target = (await writer(["rev-parse", "HEAD"])).trim()
  const config = await readConfig(writer, target, { branch: "main", remote: "origin" })
  if (config === undefined) throw new Error("fixture queue has no config")
  const created = await createEventQueue(
    createEventStore(work, "origin", selectionFor(writer)),
    "main",
    target,
    config,
    new Date(),
  )
  return { writer, reader, created, target, other }
}

function m2(created: string, actor = "yrd-ops-cutover", extra = ""): string {
  return `moved to event format at ${created}\n\nRecord: paused\nPaused-By: ${actor}\nPaused-At: 2026-09-27T00:40:59.853Z\nCause: maintenance${extra}\n`
}

async function publish(writer: Git, message: string): Promise<string> {
  await writer(["commit", "--allow-empty", "-m", message])
  const sha = (await writer(["rev-parse", "HEAD"])).trim()
  await writer(["push", "--quiet", "origin", `HEAD:${pauseRef("main")}`])
  return sha
}

describe("retired legacy pause refs", () => {
  /** @failure A retired M2 ref is still accepted as event authority after retirement.
   * @level l1 @consumer post-cutover queue ops and submit
   * Existing parser tests accept M2, so they cannot catch retirement failure; no new production seam.
   */
  it("reads event ops without M2 and refuses the former exact fence with its leased remedy", async () => {
    const w = await world()
    const store = createEventStore(w.other, "origin", selectionFor(w.reader))
    const ops = await readEventOps(store, w.reader, "main", w.target)
    expect(ops.source).toBe("event")
    expect(ops.stop).toBeUndefined()
    const oid = await publish(w.writer, m2(w.created))
    await expect(readEventOps(store, w.reader, "main", w.target)).rejects.toThrow(pauseRef("main"))
    await expect(readEventOps(store, w.reader, "main", w.target)).rejects.toThrow(oid)
    await expect(readEventOps(store, w.reader, "main", w.target)).rejects.toThrow("--force-with-lease=")
  })
})
