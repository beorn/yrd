// @failure 25647: a one-shot old-record migration could be mistaken for a runner switch or apply without an explicit action.
// @level l1
// @consumer yrd queue adopt-legacy operator during the paused cutover
// @testonly none
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { openEvents } from "gitomic/events"
import {
  appendOpsCutover,
  appendRecord,
  changeRef,
  createEventStore,
  gitIn,
  queueRef,
  readStatus,
  writeQueueEvent,
} from "@yrd/queue-core"
import { runYrdProcess } from "../src/cli.ts"
import type { YrdCliIO } from "../src/types.ts"

async function commandHelp(): Promise<string> {
  let output = ""
  const io: YrdCliIO = {
    cwd: process.cwd(),
    color: false,
    columns: 120,
    stdout: (chunk) => void (output += chunk),
    stderr: (chunk) => void (output += chunk),
  }
  await runYrdProcess(["bun", "yrd", "queue", "adopt-legacy", "--help"], io)
  return output
}

describe("yrd queue adopt-legacy entry", () => {
  it("names the one-shot dry run and an explicit apply option", async () => {
    const help = await commandHelp()
    expect(help).toContain("adopt-legacy")
    expect(help).toContain("--apply")
    expect(help).toMatch(/dry.run by\s+default/iu)
    expect(help).toMatch(/paused/iu)
  })

  const roots: string[] = []
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })

  async function emptyEventQueue(): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), "yrd-adopt-cli-"))
    roots.push(root)
    const remote = join(root, "remote.git")
    const work = join(root, "work")
    const seed = gitIn(root)
    await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
    await seed(["clone", "--quiet", remote, work])
    const git = gitIn(work)
    await git(["config", "user.email", "queue@yrd.test"])
    await git(["config", "user.name", "yrd"])
    writeFileSync(join(work, ".yrd.yml"), 'checks:\n  - verify:\n      run: "true"\n')
    await git(["add", ".yrd.yml"])
    await git(["commit", "--quiet", "-m", "main declares queue"])
    const target = (await git(["rev-parse", "HEAD"])).trim()
    await git(["push", "--quiet", "origin", "HEAD:main"])
    const store = createEventStore(work, "origin", git.selection)
    await (
      await openEvents({ ...store, ref: queueRef("main"), writer: "yrd" })
    ).append(
      [
        {
          type: "created",
          props: [
            ["Commit", target],
            ["Time", "2026-09-24T10:00:00.000Z"],
          ],
          keeps: [target],
        },
      ],
      { expect: null },
    )
    return work
  }

  async function run(work: string, ...args: string[]) {
    let stdout = ""
    let stderr = ""
    const io: YrdCliIO = {
      cwd: work,
      color: false,
      columns: 120,
      stdout: (chunk) => void (stdout += chunk),
      stderr: (chunk) => void (stderr += chunk),
    }
    const exitCode = await runYrdProcess(["bun", "yrd", "queue", "adopt-legacy", ...args], io)
    return { exitCode, stdout, stderr }
  }

  // @failure 25647: an empty migration reported success without saying what remote/prefix it searched.
  it("prints the queried remote and prefix for an empty dry run", async () => {
    const work = await emptyEventQueue()
    const result = await run(work)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/0 legacy records under refs\/yrd\/main\/ at origin/u)
    const json = await run(work, "--json")
    expect(json.exitCode).toBe(0)
    expect(JSON.parse(json.stdout)).toMatchObject({
      mode: "dry-run",
      remote: "origin",
      prefix: "refs/yrd/main/",
      count: 0,
      branchFacts: { present: 0, absent: 0 },
      rows: [],
    })
    expect(json.stdout.trim().split("\n")).toHaveLength(1)
  })

  // @failure 25647: a one-shot writer could delete an old ref while the queue still runs.
  it("refuses apply on an unpaused event queue and names the pause command", async () => {
    const work = await emptyEventQueue()
    const result = await run(work, "--apply")
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("yrd queue pause")
  })

  // @failure 25647: the CLI could show a dry-run row yet fail to publish its chain and delete its old ref together.
  it("applies a planned legacy ref on a paused queue and reports zero on the next read", async () => {
    const work = await emptyEventQueue()
    const git = gitIn(work)
    await git(["checkout", "--quiet", "-b", "task/old"])
    writeFileSync(join(work, "old.txt"), "old\n")
    await git(["add", "old.txt"])
    await git(["commit", "--quiet", "-m", "old change"])
    const head = (await git(["rev-parse", "HEAD"])).trim()
    await git(["push", "--quiet", "origin", "HEAD:task/old"])
    const oldRef = changeRef("main", { branch: "task/old", head })
    const record = await appendRecord(git, "main", {
      change: { branch: "task/old", head },
      kind: "opened",
      subject: "old submission",
      trailers: [
        ["Submitter", "@dev/2"],
        ["Issue", "25647"],
      ],
    })
    const store = createEventStore(work, "origin", git.selection)
    if (store.backend.publish === undefined || store.backend.listRefs === undefined) {
      throw new Error("fixture Gitomic backend lacks ref operations")
    }
    await store.backend.publish(store.repo, [{ ref: oldRef, expect: "0".repeat(40), oid: record }], "origin")
    const dry = await run(work)
    expect(dry.exitCode, dry.stderr).toBe(0)
    expect(dry.stdout).toContain(`1 legacy record under refs/yrd/main/ at origin`)
    expect(dry.stdout).toContain(`${oldRef}@${record}`)
    expect(dry.stdout).toContain(`Branch: refs/heads/task/old at ${head}, lease on apply`)
    expect(dry.stdout).toContain("branch facts: 1 present, 0 absent")
    // A queue pauses on its event chain only after the ops cut-over, as live adoption did (25845).
    const main = (await git(["rev-parse", "origin/main"])).trim()
    await appendOpsCutover(store, git, "main", main, new Date("2026-09-24T10:29:00.000Z"), "@chief")
    await writeQueueEvent(store, "main", {
      type: "paused",
      by: "@chief",
      reason: "fenced adoption",
      at: new Date("2026-09-24T10:30:00.000Z"),
    })
    const applied = await run(work, "--apply")
    expect(applied.exitCode).toBe(0)
    expect(applied.stdout).toContain("1 adopted, 0 refused")
    expect(applied.stdout).toContain(`Branch: refs/heads/task/old at ${head}, leased`)
    expect((await store.backend.listRefs(store.repo, oldRef, "origin")).has(oldRef)).toBe(false)
    expect((await readStatus(store, "main", "task/old")).commit).toBe(head)
    const after = await run(work)
    expect(after.exitCode).toBe(0)
    expect(after.stdout).toMatch(/0 legacy records under refs\/yrd\/main\/ at origin/u)
  })

  // @failure 25647: the operator could not see that an absent branch fact cannot be leased.
  it("counts absent branch facts in the dry run and records the apply read", async () => {
    const work = await emptyEventQueue()
    const git = gitIn(work)
    await git(["checkout", "--quiet", "-b", "task/absent"])
    writeFileSync(join(work, "absent.txt"), "absent\n")
    await git(["add", "absent.txt"])
    await git(["commit", "--quiet", "-m", "absent branch head"])
    const head = (await git(["rev-parse", "HEAD"])).trim()
    const oldRef = changeRef("main", { branch: "task/absent", head })
    const record = await appendRecord(git, "main", {
      change: { branch: "task/absent", head },
      kind: "opened",
      subject: "old submission with a deleted branch",
      trailers: [["Submitter", "@dev/2"]],
    })
    const store = createEventStore(work, "origin", git.selection)
    if (store.backend.publish === undefined) throw new Error("fixture Gitomic backend lacks publication")
    await store.backend.publish(store.repo, [{ ref: oldRef, expect: "0".repeat(40), oid: record }], "origin")
    const dry = await run(work, "--json")
    expect(dry.exitCode, dry.stderr).toBe(0)
    const planned = JSON.parse(dry.stdout) as {
      branchFacts: { present: number; absent: number }
      rows: { branchFact: string }[]
    }
    expect(planned.branchFacts).toEqual({ present: 0, absent: 1 })
    expect(planned.rows[0]?.branchFact).toMatch(/^refs\/heads\/task\/absent absent at .*not leasable$/u)
    // A queue pauses on its event chain only after the ops cut-over, as live adoption did (25845).
    const main = (await git(["rev-parse", "origin/main"])).trim()
    await appendOpsCutover(store, git, "main", main, new Date("2026-09-24T10:29:00.000Z"), "@chief")
    await writeQueueEvent(store, "main", {
      type: "paused",
      by: "@chief",
      reason: "fenced absent branch adoption",
      at: new Date("2026-09-24T10:30:00.000Z"),
    })
    const applied = await run(work, "--apply", "--json")
    expect(applied.exitCode).toBe(0)
    const receipt = JSON.parse(applied.stdout) as { adopted: number; refused: number; rows: { branchFact: string }[] }
    expect(receipt).toMatchObject({ adopted: 1, refused: 0 })
    expect(receipt.rows[0]?.branchFact).toMatch(/^refs\/heads\/task\/absent absent at .*not leasable$/u)
  })
})
