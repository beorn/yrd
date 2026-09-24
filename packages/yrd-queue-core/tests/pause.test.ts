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

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { Conflict } from "gitomic"
import {
  gitIn,
  lineStop,
  pauseRef,
  readPause,
  writePause,
  type ChangeRecord,
  type Git,
  type PauseRecord,
} from "../src/index.ts"
import { legacyPauseCommit, legacyStore } from "../src/legacy-records.ts"
import { pauseFence } from "../src/pause.ts"
import type { ChangeState } from "../src/state.ts"

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
  it("reads the latest pause through Gitomic without changing application refs or FETCH_HEAD", async () => {
    const w = await world()
    const refs = ["for-each-ref", "--format=%(refname) %(objectname)"]
    const applicationRefs = async () =>
      (await w.other(refs))
        .split("\n")
        .filter((line) => line !== "" && !line.startsWith("refs/gitomic/"))
        .join("\n")
    const before = await applicationRefs()
    const fetchHead = (await w.other(["rev-parse", "--path-format=absolute", "--git-path", "FETCH_HEAD"])).trim()
    writeFileSync(fetchHead, "another command's fetch result\n")

    expect(await readPause(w.git, "origin", "main")).toBeUndefined()
    const paused = await writePause(w.git, "origin", "main", {
      by: "@chief",
      kind: "paused",
      reason: "49 new failures on main",
    })

    expect(paused).toMatchObject({ by: "@chief", kind: "paused", reason: "49 new failures on main" })
    expect(paused.at).toBeInstanceOf(Date)
    const resumed = await writePause(w.git, "origin", "main", {
      by: "operator",
      kind: "resumed",
      reason: "the repair merged",
    })
    expect(await readPause(w.other, "origin", "main")).toEqual(resumed)
    expect(resumed).toMatchObject({ by: "operator", kind: "resumed", reason: "the repair merged" })
    expect((await w.other(["log", "-1", "--format=%(trailers:only,unfold)", resumed!.sha])).trim()).toBe(
      "Record: resumed\nPaused-By: operator",
    )
    expect(await applicationRefs()).toBe(before)
    expect(await w.other(["for-each-ref", PAUSE_REF])).toBe("")
    expect(readFileSync(fetchHead, "utf8")).toBe("another command's fetch result\n")
  })

  it("refreshes Gitomic's private fetch namespace when the pause changes", async () => {
    const w = await world()
    const paused = await writePause(w.git, "origin", "main", { by: "operator", kind: "paused", reason: "inspecting" })
    expect(await readPause(w.other, "origin", "main")).toEqual(paused)
    const resumed = await writePause(w.git, "origin", "main", {
      by: "operator",
      kind: "resumed",
      reason: "ready now",
    })
    expect(await readPause(w.other, "origin", "main")).toEqual(resumed)
    expect(await w.other(["for-each-ref", PAUSE_REF])).toBe("")
  })

  it("fails loudly when Gitomic cannot fetch the pause authority", async () => {
    const w = await world()
    await expect(readPause(w.other, "missing-queue-remote", "main")).rejects.toThrow("missing-queue-remote")
  })

  it("refuses a pause publication whose Gitomic lease moved", async () => {
    const w = await world()
    const paused = await writePause(w.git, "origin", "main", {
      by: "@chief",
      kind: "paused",
      reason: "investigating",
    })
    const stale = await legacyPauseCommit(w.git, paused, {
      by: "@chief",
      kind: "resumed",
      reason: "my stale clear",
    })
    await writePause(w.other, "origin", "main", { by: "operator", kind: "resumed", reason: "cleared elsewhere" })
    const store = await legacyStore(w.git)
    await expect(
      store.backend.publish(store.repo, [{ ref: PAUSE_REF, expect: paused.sha, oid: stale }], "origin"),
    ).rejects.toBeInstanceOf(Conflict)
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

/**
 * @failure  A stop the queue put on itself reads exactly like a person's pause,
 *           so no reader can say which act lifts it, and a record written before
 *           causes existed is refused or misread as something new.
 * @level    l1 (the record ref over one real bare remote)
 * @consumer the run, the service page, list and submit, which all derive the
 *           line's stop from this record (the andon, operator 2026-09-16)
 */
describe("a pause names its cause", () => {
  const HEAD = "a".repeat(40)

  async function planted(w: World, message: string): Promise<string> {
    const tree = (await w.git(["mktree"], "")).trim()
    const sha = (await w.git(["commit-tree", tree, "-m", message])).trim()
    await w.git(["push", "--quiet", "origin", `${sha}:${PAUSE_REF}`])
    return sha
  }

  it("a record that names no cause is an operator's, as every record written before causes existed", async () => {
    const w = await world()
    await planted(w, "49 new failures on main\n\nRecord: paused\nPaused-By: @chief\n")

    const read = await readPause(w.other, "origin", "main")

    expect(read).toMatchObject({ by: "@chief", cause: "operator", kind: "paused" })
    expect(read?.change).toBeUndefined()
  })

  it("a stuck stop names the change it stopped for, and reads back the same", async () => {
    const w = await world()
    const written = await writePause(w.git, "origin", "main", {
      by: "yrd",
      cause: "stuck",
      change: { branch: "task/one", head: HEAD },
      kind: "paused",
      reason: "the queue could not judge task/one",
    } as Parameters<typeof writePause>[3])

    const read = await readPause(w.other, "origin", "main")

    expect(read).toEqual(written)
    expect(read).toMatchObject({ by: "yrd", cause: "stuck", change: { branch: "task/one", head: HEAD } })
  })

  // The merge fence is the one other writer of a stop: an explicit round
  // admitted under a stuck stop carries it forward in its merge's atomic push.
  // A fence that dropped the cause or the change would turn the andon into an
  // operator's pause that no ending of the change could ever lift.
  it("the merge fence carries a stuck stop forward whole: its cause, its change and its cures", async () => {
    const w = await world()
    const admitted = await writePause(w.git, "origin", "main", {
      by: "yrd",
      cause: "stuck",
      change: { branch: "task/one", head: HEAD },
      kind: "paused",
      next: "withdraw task/one, replace its head with a fix, or resume the repaired queue",
      reason: "the queue could not judge task/one",
    } as Parameters<typeof writePause>[3])

    const fence = await pauseFence(w.git, "origin", "main", { by: "q-merge", reason: "merge task/two" }, admitted)
    expect(fence.previous).toEqual(admitted)
    await w.git([
      "push",
      "--quiet",
      `--force-with-lease=${PAUSE_REF}:${fence.expected}`,
      "origin",
      `${fence.sha}:${PAUSE_REF}`,
    ])

    const carried = await readPause(w.other, "origin", "main")
    expect(carried?.sha).toBe(fence.sha)
    expect(carried).toMatchObject({
      at: admitted.at,
      by: "yrd",
      cause: "stuck",
      change: { branch: "task/one", head: HEAD },
      kind: "paused",
      next: admitted.next,
      reason: admitted.reason,
    })
  })

  it("fails closed on a cause nobody defined", async () => {
    const w = await world()
    const sha = await planted(w, "who knows\n\nRecord: paused\nPaused-By: @chief\nCause: wedged\n")

    await expect(readPause(w.other, "origin", "main")).rejects.toThrow(
      `${PAUSE_REF} at ${sha.slice(0, 12)} carries an unreadable Cause`,
    )
  })

  it("fails closed on a stuck stop that names no change: no reader could say what lifts it", async () => {
    const w = await world()
    const sha = await planted(w, "stuck\n\nRecord: paused\nPaused-By: yrd\nCause: stuck\n")

    await expect(readPause(w.other, "origin", "main")).rejects.toThrow(
      `${PAUSE_REF} at ${sha.slice(0, 12)} is a stuck stop with no readable Change`,
    )
  })
})

/**
 * @failure  Two readers decide "stopped" differently, or a stop comes back by
 *           itself: an ending then a resubmit of the same head re-stops the line
 *           nobody stopped, or a same-head retry of the stuck change lifts the
 *           stop without curing anything.
 * @level    l1 (the pure derivation over constructed records)
 * @consumer every reader of a stopped line — the run, the service page, list,
 *           submit and the pause writers — which all ask `lineStop`
 */
describe("the one derivation of a stopped line", () => {
  const HEAD = "a".repeat(40)
  let sequence = 0
  const record = (kind: ChangeRecord["kind"], trailers: ChangeRecord["trailers"] = []): ChangeRecord => {
    sequence += 1
    return { at: new Date(), kind, sha: String(sequence).padStart(40, "0"), subject: kind, trailers }
  }
  const entry = (state: ChangeState, ...records: ChangeRecord[]) => ({ change: { records }, reading: { state } })
  const at = new Date("2026-09-16T12:00:00.000Z")
  const stuckStop: PauseRecord = {
    at,
    by: "yrd",
    cause: "stuck",
    change: { branch: "task/one", head: HEAD },
    kind: "paused",
    reason: "the queue could not judge task/one",
    sha: "f".repeat(40),
  }
  const operatorStop: PauseRecord = {
    at,
    by: "@chief",
    cause: "operator",
    kind: "paused",
    reason: "x",
    sha: "e".repeat(40),
  }

  it("a running line has no stop, and a resumed record is none", () => {
    expect(lineStop(undefined, undefined)).toBeUndefined()
    expect(lineStop({ ...operatorStop, kind: "resumed" }, undefined)).toBeUndefined()
  })

  it("an operator's stop stands whatever the line holds", () => {
    expect(lineStop(operatorStop, entry("merged", record("opened"), record("merged")))).toBe(operatorStop)
  })

  it("a stuck stop stands while its change is still stuck in line", () => {
    const stuck = entry("stuck", record("opened"), record("stuck"), record("sent", [["State", "stuck"]]))
    expect(lineStop(stuckStop, stuck)).toBe(stuckStop)
  })

  it("a same-head retry of the stuck change re-opens its chain and cures nothing: the stop stands", () => {
    const retried = entry(
      "queued",
      record("opened"),
      record("stuck"),
      record("sent", [["State", "stuck"]]),
      record("opened"),
    )
    expect(lineStop(stuckStop, retried)).toBe(stuckStop)
  })

  it.each([
    ["withdrawn", entry("withdrawn", record("opened"), record("stuck"), record("withdrawn"))],
    [
      "merged",
      entry("merged", record("opened"), record("stuck"), record("opened"), record("checked"), record("merged")),
    ],
    ["failed", entry("failed", record("opened"), record("stuck"), record("failed"))],
  ])("the stop lifts once its change is %s", (_why, ended) => {
    expect(lineStop(stuckStop, ended)).toBeUndefined()
  })

  // THE CASE A TIP-ONLY RULE GETS WRONG: withdrawn, then the same head submitted
  // again. That is a new submission the stop never named, and the line must
  // not stop a second time because a record from before it still sits there.
  it("an ending followed by a resubmit of the same head never stops the line again", () => {
    const resubmitted = entry("queued", record("opened"), record("stuck"), record("withdrawn"), record("opened"))
    expect(lineStop(stuckStop, resubmitted)).toBeUndefined()
  })

  // A record says the line stopped for a change the read cannot find: nothing
  // says it left, so the line stays stopped and `yrd queue resume` is the cure.
  it("a stuck stop whose change the read cannot find keeps the line stopped", () => {
    expect(lineStop(stuckStop, undefined)).toBe(stuckStop)
  })
})
