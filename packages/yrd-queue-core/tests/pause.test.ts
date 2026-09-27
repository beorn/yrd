/**
 * @failure  A legacy pause tip is mistaken for the approved M2 maintenance fence.
 * @level    l1 (real bare remote and Gitomic ref fetch)
 * @consumer post-cutover event queue authority read (#25041)
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { gitIn, type Git } from "../src/git.ts"
import { readM2Pause } from "../src/pause.ts"
import { pauseRef } from "../src/refs.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

async function world(): Promise<{ writer: Git; reader: Git; created: string }> {
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
  await writer(["commit", "--allow-empty", "-m", "event created"])
  return { writer, reader, created: (await writer(["rev-parse", "HEAD"])).trim() }
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

describe("the only retained legacy pause reader", () => {
  it("accepts the exact M2 tip for this event queue and leaves application refs untouched", async () => {
    const w = await world()
    expect(await readM2Pause(w.reader, "origin", "main", w.created)).toBeUndefined()
    const sha = await publish(w.writer, m2(w.created))
    const pause = await readM2Pause(w.reader, "origin", "main", w.created)
    expect(pause).toMatchObject({
      kind: "paused",
      sha,
      by: "yrd-ops-cutover",
      cause: "maintenance",
      reason: `moved to event format at ${w.created}`,
      at: new Date("2026-09-27T00:40:59.853Z"),
    })
    expect(await w.reader(["for-each-ref", pauseRef("main")])).toBe("")
  })

  it("refuses a fence naming another event-created commit", async () => {
    const w = await world()
    await publish(w.writer, m2("a".repeat(40)))
    await expect(readM2Pause(w.reader, "origin", "main", w.created)).rejects.toThrow(
      /M2 names event-created .*; expected /,
    )
  })

  it("refuses a different actor or extra field rather than treating it as M2", async () => {
    const w = await world()
    await publish(w.writer, m2(w.created, "operator"))
    await expect(readM2Pause(w.reader, "origin", "main", w.created)).rejects.toThrow(
      /exact M2 maintenance fence fields/,
    )
    await publish(w.writer, m2(w.created, "yrd-ops-cutover", "\nNext: legacy"))
    await expect(readM2Pause(w.reader, "origin", "main", w.created)).rejects.toThrow(
      /exact M2 maintenance fence fields/,
    )
  })

  it("refuses a second otherwise identical fence commit on the tip", async () => {
    const w = await world()
    await publish(w.writer, m2(w.created))
    await publish(w.writer, m2(w.created))
    await expect(readM2Pause(w.reader, "origin", "main", w.created)).rejects.toThrow(/second commit atop an M2 fence/)
  })
})
