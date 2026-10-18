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
import {
  appendChangeEvent,
  createEventQueue,
  createEventStore,
  readConfig,
  readEventOps,
  readStatus,
  selectionFor,
  submit,
  writeQueueEvent,
} from "../src/index.ts"
import { incidentLine, incidentTrailers } from "../src/incident.ts"
import { liftLine, stuckCures } from "../src/pause.ts"

const roots: string[] = []

describe("portable queue guidance", () => {
  /** @failure Shared event guidance is presented as an executable recipe in the reader's clone.
   * @level l0 @consumer incident displays and immutable event trailers
   * Existing pause authority cases do not distinguish recorded guidance from current actions; no new seam.
   */
  it.each(["run yrd queue resume", "repair the queue setup"])(
    "labels recorded guidance without changing its bytes: %s",
    (next) => {
      const incident = {
        code: "queue-setup",
        subject: "the queue setup failed",
        via: "the queue",
        evidence: "/producer/log.jsonl",
        next,
      }
      expect(incidentLine(incident)).toContain(`recorded guidance: ${next}`)
      expect(incidentTrailers(incident)).toContainEqual(["Next", next])
    },
  )

  /** @failure A newly persisted common cure binds a shared event to an executable command.
   * @level l0 @consumer event-run's common Next suffix
   */
  it("keeps common stuck guidance portable prose", () => {
    const guidance = stuckCures("task/change")
    expect(guidance).toContain("task/change")
    expect(guidance).toMatch(/withdraw/u)
    expect(guidance).toMatch(/resume/u)
    expect(guidance).not.toMatch(/\byrd\s+(?:queue|merge)\b|\bcd\s|(?:^|[\s"'`(])\/\S+/u)
  })
})

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

async function world(): Promise<{
  writer: Git
  reader: Git
  created: string
  target: string
  other: string
  work: string
}> {
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
  return { writer, reader, created, target, other, work }
}

/** @failure Reading an old Git event rewrites its Next or presents it as a current command.
 * @level l1 @consumer a queue reader in another clone
 * Pure incident tests cannot catch event-storage decoding or reader-side publication.
 */
it("reads historical Next from another clone without changing the Git event bytes", async () => {
  const w = await world()
  const branch = "task/historical-guidance"
  await w.writer(["checkout", "--quiet", "-b", branch, w.target])
  writeFileSync(join(w.work, "historical.txt"), "unmerged work\n")
  await w.writer(["add", "historical.txt"])
  await w.writer(["commit", "--quiet", "-m", "historical work"])
  const head = (await w.writer(["rev-parse", "HEAD"])).trim()
  await submit(w.writer, "origin", {
    branch,
    submitter: "test-submitter",
    target: { branch: "main", remote: "origin" },
  })
  const writerStore = createEventStore(w.work, "origin", selectionFor(w.writer))
  const opened = await readStatus(writerStore, "main", branch)
  if (opened.tip === undefined) throw new Error("the historical change has no opened event")
  const at = new Date("2025-01-02T03:04:05.000Z")
  const event = await appendChangeEvent(writerStore, "main", branch, opened.tip, {
    type: "stuck",
    reason: "historical setup fault",
    at,
  })
  const next = "  cd '/old producer clone' && yrd queue resume --reason 'repair then retry'  "
  const paused = await writeQueueEvent(writerStore, "main", {
    type: "paused",
    cause: "stuck",
    by: "yrd",
    reason: "historical setup fault",
    change: { branch, head, event },
    next,
    at,
  })
  const before = await w.writer(["cat-file", "commit", paused])
  const { stop } = await readEventOps(
    createEventStore(w.other, "origin", selectionFor(w.reader)),
    w.reader,
    "main",
    w.target,
  )
  expect(stop?.next).toBe(next)
  if (stop === undefined) throw new Error("the historical stuck event was not read")
  expect(liftLine(stop, "origin", "main")).toContain(`recorded guidance: ${next}`)
  expect(await w.reader(["cat-file", "commit", paused])).toBe(before)
  expect((await w.reader(["ls-remote", "origin", "refs/yrd/main/queue"])).trim().split(/\s/u)[0]).toBe(paused)
})

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
