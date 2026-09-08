/**
 * The table and declaration authority, on a real remote.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { createProcess } from "@yrd/process"
import { gitEnvironment } from "../src/git.ts"
import {
  appendRecord,
  changeRef,
  checkTrailer,
  gitIn,
  list,
  directMergeCommits,
  readCheckTrailer,
  readConfig,
  readHistories,
  readQueue,
  show,
  submit,
  journalKey,
  watchRows,
} from "../src/index.ts"
import type { Git } from "../src/index.ts"

const roots: string[] = []
const MAIN = { branch: "main", remote: "origin" } as const

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

type World = Readonly<{ git: Git; target: string; work: string }>

async function world(config: string): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "yrd-core-table-"))
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
  writeFileSync(join(work, ".yrd.yml"), config)
  await git(["add", ".yrd.yml"])
  await git(["commit", "--quiet", "-m", "declare the queue"])
  await git(["push", "--quiet", "origin", "main"])
  const target = (await git(["rev-parse", "HEAD"])).trim()
  return { git, target, work }
}

async function submitCommit(w: World, branch: string, file: string): Promise<string> {
  await w.git(["checkout", "--quiet", "-b", branch, "main"])
  writeFileSync(join(w.work, file), `${file}\n`)
  await w.git(["add", file])
  await w.git(["commit", "--quiet", "-m", file])
  const head = (await w.git(["rev-parse", "HEAD"])).trim()
  await w.git(["checkout", "--quiet", "main"])
  await submit(w.git, "origin", {
    branch,
    submitter: "@dev/2",
    target: { branch: "main", remote: "origin" },
    issue: `@i/1/${file}`,
  })
  return head
}

describe("the declaration is read from the queue branch commit", () => {
  it("pairs each captured declaration with its own blob after the branch advances", async () => {
    const w = await world("setup: prepare-a\n")
    const a = w.target
    const aBlob = (await w.git(["rev-parse", `${a}:.yrd.yml`])).trim()
    writeFileSync(join(w.work, ".yrd.yml"), "setup: prepare-b\n")
    await w.git(["commit", "--quiet", "-am", "change the declaration"])
    const b = (await w.git(["rev-parse", "HEAD"])).trim()
    const bBlob = (await w.git(["rev-parse", `${b}:.yrd.yml`])).trim()
    const target = { branch: "release/1.x", remote: "selected" }

    // The checkout now holds B. Neither A's text nor its blob may follow it.
    expect(await readConfig(w.git, a, target)).toMatchObject({ blob: aBlob, setup: "prepare-a", target })
    expect(await readConfig(w.git, b, target)).toMatchObject({ blob: bBlob, setup: "prepare-b", target })
  })
})

describe("the table is the queue read rendered", () => {
  it("lists changes in line with their position, then the ended ones", async () => {
    const w = await world("{}\n")
    const one = await submitCommit(w, "task/one", "one.txt")
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const two = await submitCommit(w, "task/two", "two.txt")
    const entries = (await readQueue(w.git, "origin", "main", w.target)).changes
    const rows = list(entries)
    expect(rows.map((row) => [row.branch, row.position, row.state, row.issue])).toEqual([
      ["task/one", 1, "queued", "@i/1/one.txt"],
      ["task/two", 2, "queued", "@i/1/two.txt"],
    ])
    expect(rows.map((row) => row.head)).toEqual([one, two])

    // 24202: the latest-change join and per-run spread are separate surfaces.
    // Reuse this real queue read to prove warnings neither vanish nor leak.
    const at = new Date()
    const diagnostic = {
      kind: "change" as const,
      at: at.toISOString(),
      run: "new",
      reason: "change-ref-taken",
      text: "ref write failed",
    }
    const run = { branch: "task/one", head: one, at, startedAt: at, checks: [] }
    const journals = {
      dir: "/journal-fixture",
      runs: new Map([
        [
          journalKey(run.branch, run.head),
          [
            { ...run, id: "new", diagnostics: [diagnostic] },
            { ...run, id: "old" },
          ],
        ],
      ]),
    }
    const joined = list(entries, { journals })
    expect(joined[0]?.diagnostics).toEqual([diagnostic])
    expect(joined[1]?.diagnostics).toBeUndefined()
    expect(show(entries, run.branch, { journals })[0]?.row.diagnostics).toEqual([diagnostic])
    expect(watchRows(joined, { journals, latest: true })[0]?.row.diagnostics).toEqual([diagnostic])
    const split = watchRows(joined, { journals })
    expect(split[0]?.row.diagnostics).toEqual([diagnostic])
    expect(split[1]?.row.diagnostics).toBeUndefined()
  })

  it("lists a commit the target gained around the queue as its own row, as recent as it was committed (E5)", async () => {
    const w = await world("{}\n")
    await submitCommit(w, "task/one", "one.txt")
    await w.git(["checkout", "--quiet", "main"])
    writeFileSync(join(w.work, "direct.txt"), "direct\n")
    await w.git(["add", "direct.txt"])
    await w.git(["commit", "--quiet", "-m", "direct.txt around the queue"])
    await w.git(["push", "--quiet", "origin", "main"])
    const direct = (await w.git(["rev-parse", "HEAD"])).trim()

    const entries = (await readQueue(w.git, "origin", "main", direct)).changes
    // The captured reading owns its history even when no local change ref remains.
    await w.git(["update-ref", "-d", changeRef("main", entries[0]!.change)])
    const directMerges = await directMergeCommits(w.git, "main", direct, entries)
    expect(directMerges.map((commit) => [commit.commit, commit.subject, commit.gitlinks, commit.why])).toEqual([
      [direct, "direct.txt around the queue", [], "it is one commit, not a merge of a change"],
    ])
    const rows = list(entries, { directMerges })
    expect(rows.map((row) => [row.state, row.branch, row.head, row.position, row.reason])).toEqual([
      ["queued", "task/one", rows[0]?.head, 1, undefined],
      [
        "direct",
        "main",
        direct,
        undefined,
        `main moved around the queue at ${direct.slice(0, 12)} (direct.txt around the queue)`,
      ],
    ])
    // Windowed like every ended row: an old direct is not this week's news.
    expect(
      list(entries, { directMerges, sinceMs: 0, now: new Date(Date.now() + 60_000) }).map((row) => row.state),
    ).toEqual(["queued"])
  })

  it("shows one branch's changes newest first", async () => {
    const w = await world("{}\n")
    const first = await submitCommit(w, "task/one", "one.txt")
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await w.git(["checkout", "--quiet", "task/one"])
    writeFileSync(join(w.work, "one.txt"), "one, again\n")
    await w.git(["commit", "--quiet", "-am", "again"])
    const second = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])
    await submit(w.git, "origin", {
      branch: "task/one",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })

    const shown = show((await readQueue(w.git, "origin", "main", w.target)).changes, "task/one")
    expect(shown.map((entry) => [entry.row.head, entry.row.state, entry.row.reason])).toEqual([
      [second, "queued", undefined],
      [first, "failed", "replaced"],
    ])
  })

  it.each(["merged", "failed", "stuck"] as const)(
    "keeps check history and the actual %s time across later notifications",
    async (kind) => {
      const w = await world("{}\n")
      const head = await submitCommit(w, "task/one", "one.txt")
      const change = { branch: "task/one", head }
      const base = (await w.git(["rev-parse", "main"])).trim()
      await appendRecord(w.git, "main", {
        change,
        kind: "checked",
        subject: "on-submit checks passed",
        trailers: [
          ["Base", base],
          ["Check", "typecheck exit=0 ms=12 log=/tmp/typecheck.log"],
          ["Check", "manifest-co-change exit=0 ms=13 log=/tmp/manifest.log"],
          ["Check", "substrate-pair exit=0 ms=14 log=/tmp/substrate.log"],
        ],
      })
      // A real notification has its own commit time. Distinct Git instants
      // expose timestamp provenance without sleeping or mutating global env.
      const endedAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 60_000)
      const sentAt = new Date(endedAt.getTime() + 60_000)
      const gitAt = (at: Date): Git =>
        gitIn(w.work, createProcess({ env: { ...gitEnvironment(process.env), GIT_COMMITTER_DATE: at.toISOString() } }))
      const lastCheck = `affected-tests exit=${kind === "failed" ? 1 : 0} ms=15 log=/tmp/affected.log`
      const endingTrailers: (readonly [string, string])[] = [
        ["Base", base],
        ["Check", lastCheck],
      ]
      if (kind === "merged") endingTrailers.push(["Merge", base])
      if (kind === "stuck") {
        endingTrailers.push(
          ["Code", "ref-write"],
          ["Subject", "target"],
          ["Via", "push"],
          ["Evidence", "/tmp/push.log"],
          ["Next", "inspect the target"],
          ["Owner", "queue owner"],
        )
      }
      const ending = { change, kind, subject: `${kind} task/one`, trailers: endingTrailers }
      if (kind === "failed") {
        await appendRecord(gitAt(new Date(endedAt.getTime() - 30_000)), "main", ending)
        await appendRecord(w.git, "main", { change, kind: "checked", subject: "retry checked" })
        await w.git(["push", "--quiet", "origin", `${changeRef("main", change)}:${changeRef("main", change)}`])
        const retry = await readHistories(
          w.git,
          (await readQueue(w.git, "origin", "main", w.target)).changes,
          "origin",
          "main",
        )
        expect(show(retry, change.branch)[0]?.row.endedAt).toBeUndefined()
      }
      await appendRecord(gitAt(endedAt), "main", ending)
      await w.git(["push", "--quiet", "origin", `${changeRef("main", change)}:${changeRef("main", change)}`])
      const direct = list((await readQueue(w.git, "origin", "main", w.target)).changes, { now: sentAt })[0]
      expect(direct?.endedAt).toEqual(endedAt)
      await appendRecord(gitAt(sentAt), "main", {
        change,
        kind: "sent",
        subject: "sent ending notice",
        trailers: [["State", kind], ...endingTrailers],
      })
      await w.git(["push", "--quiet", "origin", `${changeRef("main", change)}:${changeRef("main", change)}`])

      const queue = await readQueue(w.git, "origin", "main", w.target)
      const entry = queue.changes[0]
      if (entry === undefined) throw new Error("submitted change missing from the queue read")
      const summary = list(queue.changes, { now: sentAt })[0]
      expect(summary?.at).toEqual(sentAt)
      expect(summary?.endedAt).toBeUndefined()
      expect(summary?.state).toBe(direct?.state)
      expect(summary?.next).toEqual(direct?.next)
      const hydrated = await readHistories(w.git, [entry], "origin", "main")
      const shown = show(hydrated, change.branch)
      expect(shown[0]?.row.endedAt).toEqual(endedAt)
      expect(list(hydrated, { now: sentAt })[0]?.endedAt).toEqual(endedAt)
      expect(shown[0]?.row.state).toBe(summary?.state)
      expect(shown[0]?.row.next).toEqual(summary?.next)
      expect(shown[0]?.checks).toEqual([
        "typecheck exit=0 ms=12 log=/tmp/typecheck.log",
        "manifest-co-change exit=0 ms=13 log=/tmp/manifest.log",
        "substrate-pair exit=0 ms=14 log=/tmp/substrate.log",
        ...(kind === "failed" ? [lastCheck] : []),
        lastCheck,
        lastCheck,
      ])
    },
  )
})

describe("a packed Check: trailer", () => {
  it("reads back every field the writer put in it, log path and all", () => {
    // The table renders a row off this trailer, so the pair is the contract:
    // whatever the run writes, the reader has to give back. It gave back two
    // of the four, so a reader that wanted the exit or the duration went to
    // the trailer text with a regex of its own.
    const packed = checkTrailer({
      durationMs: 1234,
      exit: 1,
      log: "/queue/checks/task~one@abc/q-1/merge/type=check.log",
      name: "verify",
      result: "fail",
    })

    expect(packed).toBe("verify exit=1 ms=1234 log=/queue/checks/task~one@abc/q-1/merge/type=check.log")
    expect(readCheckTrailer(packed)).toEqual({
      exit: "1",
      log: "/queue/checks/task~one@abc/q-1/merge/type=check.log",
      ms: 1234,
      name: "verify",
    })
  })

  it("reads back a word exit, which is what a check the queue could not measure carries", () => {
    const packed = checkTrailer({
      durationMs: 1_800_000,
      exit: "timeout",
      log: "/queue/checks/task~one@abc/q-1/merge/test.log",
      name: "test",
      result: "stuck",
    })

    expect(readCheckTrailer(packed)).toEqual({
      exit: "timeout",
      log: "/queue/checks/task~one@abc/q-1/merge/test.log",
      ms: 1_800_000,
      name: "test",
    })
  })
})
