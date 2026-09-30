/**
 * @failure The 2026-09-24 DROP quarantine contains 21 valid chains and 41 cancelled-only chains; moving the latter as-is blinds Yrd listing.
 * @level l1 — real local bare origin, queue event writer, and the one-off adoption CLI.
 * @consumer #25658 direct adoption of the quarantined drops.
 * @reach fs-walk <fixture-only: adoption CLI scans a temporary local bare remote>
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, it } from "vitest"
import { openEvents } from "gitomic/events"
import {
  changeInput,
  createEventQueue,
  createEventStore,
  listChangeHistories,
  readConfig,
  readStatus,
  type QueueLocation,
} from "../packages/yrd-queue-core/src/index.ts"
import { testGitIn as gitIn } from "../tests/support/test-git-in.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture Writer",
      GIT_AUTHOR_EMAIL: "writer@example.test",
      GIT_COMMITTER_NAME: "Fixture Writer",
      GIT_COMMITTER_EMAIL: "writer@example.test",
    },
  })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

function cli(work: string, ...args: string[]): unknown {
  const result = spawnSync("bun", [fileURLToPath(new URL("./adopt-quarantine.ts", import.meta.url)), ...args], {
    cwd: work,
    encoding: "utf8",
  })
  if (result.status !== 0) throw new Error(`adopt-quarantine exited ${result.status}: ${result.stderr}`)
  return JSON.parse(result.stdout)
}

function yrd(work: string, ...args: string[]): { changes: Array<{ branch: string; state: string }> } {
  const result = spawnSync(
    "bun",
    [
      fileURLToPath(new URL("../bin/yrd.ts", import.meta.url)),
      "queue",
      ...args,
      "--json",
      "--fresh",
      "--queue",
      "main",
    ],
    { cwd: work, encoding: "utf8" },
  )
  if (result.status !== 0) throw new Error(`yrd queue ${args.join(" ")} exited ${result.status}: ${result.stderr}`)
  return JSON.parse(result.stdout) as { changes: Array<{ branch: string; state: string }> }
}

async function fixture(): Promise<{
  work: string
  store: QueueLocation
  queueTip: string
  badTip: string
  goodTip: string
}> {
  const root = mkdtempSync(join(tmpdir(), "yrd-quarantine-adopt-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  git(root, "init", "--bare", remote)
  git(root, "init", work)
  writeFileSync(join(work, ".yrd.yml"), "{}\n")
  git(work, "add", ".yrd.yml")
  git(work, "commit", "-m", "queue base")
  git(work, "branch", "-M", "main")
  git(work, "remote", "add", "origin", remote)
  git(work, "push", "origin", "main")
  const runner = gitIn(work)
  const head = git(work, "rev-parse", "HEAD")
  const config = await readConfig(runner, head, { branch: "main", remote: "origin" })
  if (config === undefined) throw new Error("fixture queue config missing")
  const store = createEventStore(work, "origin", runner.selection)
  const queueTip = await createEventQueue(store, "main", head, config, new Date("2026-09-24T20:00:00Z"))
  const at = new Date("2026-09-24T20:25:00Z")
  const badTip = (
    await (
      await openEvents({ ...store, ref: "refs/yrd-quarantine/main/changes/task/bad", writer: "@dev/1" })
    ).append(
      [
        changeInput("cancelled", {
          queueTip,
          at,
          commit: head,
          reason: "dropped",
          by: "@dev/1",
          content: "old drop body",
        }),
      ],
      { expect: null },
    )
  ).head
  const goodTip = (
    await (
      await openEvents({ ...store, ref: "refs/yrd-quarantine/main/changes/task/good", writer: "@dev/1" })
    ).append(
      [
        changeInput("opened", { queueTip, at, commit: head, by: "@dev/1" }),
        changeInput("cancelled", { queueTip, at, commit: head, reason: "dropped", by: "@dev/1" }),
      ],
      { expect: null },
    )
  ).head
  if (badTip === null || goodTip === null) throw new Error("fixture event append wrote no head")
  return { work, store, queueTip, badTip, goodTip }
}

it("plans the exact old refs, moves the valid chain, and repairs the cancelled-only chain without deleting quarantine", async () => {
  const { work, store, queueTip, badTip, goodTip } = await fixture()
  const [existing] = await (await openEvents({ ...store, ref: "refs/yrd-quarantine/main/changes/task/good" })).events()
  if (existing === undefined || store.backend.publish === undefined) {
    throw new Error("fixture has no opened event or publisher")
  }
  await store.backend.publish(
    work,
    [{ ref: "refs/yrd/main/changes/task/good", expect: "0".repeat(existing.id.length), oid: existing.id }],
    "origin",
  )
  const common = ["--repo", work, "--remote", "origin", "--queue", "main", "--by", "@dev/2", "--json"]
  const plan = cli(work, "--plan", ...common) as { queueTip: string; items: Array<Record<string, string>> }
  expect(plan.queueTip).toBe(queueTip)
  expect(plan.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        branch: "task/good",
        kind: "move",
        state: "pending",
        sourceOid: goodTip,
        targetOid: existing.id,
      }),
      expect.objectContaining({ branch: "task/bad", kind: "repair", sourceOid: badTip }),
    ]),
  )
  const partial = spawnSync(
    "bun",
    [fileURLToPath(new URL("./adopt-quarantine.ts", import.meta.url)), "--apply", "1", ...common],
    { cwd: work, encoding: "utf8" },
  )
  expect(partial.status).toBe(2)
  expect(partial.stderr).toContain("2 pending rows matched")
  expect(partial.stdout).toBe("")
  expect(git(work, "ls-remote", "origin", "refs/yrd/main/changes/task/good")).toContain(existing.id)
  expect(git(work, "ls-remote", "origin", "refs/yrd/main/changes/task/bad")).toBe("")
  cli(work, "--apply", "1", "--only", "task/good", ...common)
  expect(git(work, "ls-remote", "origin", "refs/yrd/main/changes/task/good")).toContain(goodTip)
  expect((await readStatus(store, "main", "task/good")).status).toBe("cancelled")
  cli(work, "--apply", "1", "--only", "task/bad", ...common)
  const bad = await readStatus(store, "main", "task/bad")
  expect(bad).toMatchObject({ status: "cancelled", reason: "dropped", commit: badTip })
  const events = await (await openEvents({ ...store, ref: "refs/yrd/main/changes/task/bad" })).events()
  expect(events.map((event) => event.type)).toEqual(["opened", "cancelled"])
  expect(events[0]?.links).toContain(badTip)
  expect(events[0]?.props).toContainEqual(["By", "@dev/2"])
  expect(events[1]?.content).toContain("old drop body")
  expect(events[0]?.props.find(([key]) => key === "Time")?.[1]).not.toBe("2026-09-24T20:25:00.000Z")
  expect((await listChangeHistories(store, "main")).invalid.size).toBe(0)
  const listed = yrd(work, "list")
  expect(listed.changes.filter((row) => row.state === "invalid")).toEqual([])
  expect(listed.changes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ branch: "task/good", state: "cancelled" }),
      expect.objectContaining({ branch: "task/bad", state: "cancelled" }),
    ]),
  )
  expect(yrd(work, "show", "task/good").changes).toEqual(
    expect.arrayContaining([expect.objectContaining({ branch: "task/good", state: "cancelled" })]),
  )
  expect(yrd(work, "show", "task/bad").changes).toEqual(
    expect.arrayContaining([expect.objectContaining({ branch: "task/bad", state: "cancelled" })]),
  )
  expect(git(work, "ls-remote", "origin", "refs/yrd-quarantine/main/changes/task/bad")).toContain(badTip)
  expect(git(work, "ls-remote", "origin", "refs/yrd-quarantine/main/changes/task/good")).toBe("")
})

it("refuses a diverged live target before writing any quarantine adoption", async () => {
  const { work, store, badTip, goodTip } = await fixture()
  if (store.backend.publish === undefined) throw new Error("fixture backend cannot publish")
  await store.backend.publish(
    work,
    [{ ref: "refs/yrd/main/changes/task/good", expect: "0".repeat(badTip.length), oid: badTip }],
    "origin",
  )
  const result = spawnSync(
    "bun",
    [
      fileURLToPath(new URL("./adopt-quarantine.ts", import.meta.url)),
      "--apply",
      "1",
      "--only",
      "task/good",
      "--repo",
      work,
      "--remote",
      "origin",
      "--queue",
      "main",
      "--by",
      "@dev/2",
      "--json",
    ],
    { cwd: work, encoding: "utf8" },
  )
  expect(result.status).toBe(2)
  expect(result.stderr).toContain("code=quarantine-adoption-refused")
  expect(result.stderr).toContain("live target differs for task/good")
  expect(result.stdout).toBe("")
  expect(git(work, "ls-remote", "origin", "refs/yrd/main/changes/task/good")).toContain(badTip)
  expect(git(work, "ls-remote", "origin", "refs/yrd-quarantine/main/changes/task/good")).toContain(goodTip)
})
