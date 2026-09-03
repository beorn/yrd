/**
 * The table and the declaration, on the same real remote the other tests use.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  checkTrailer,
  gitIn,
  list,
  byHandCommits,
  readCheckTrailer,
  readConfig,
  readHints,
  readQueue,
  show,
  submit,
} from "../src/index.ts"
import type { Git } from "../src/index.ts"

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

type World = Readonly<{ git: Git; work: string }>

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
  return { git, work }
}

async function submitCommit(w: World, branch: string, file: string): Promise<string> {
  await w.git(["checkout", "--quiet", "-b", branch, "main"])
  writeFileSync(join(w.work, file), `${file}\n`)
  await w.git(["add", file])
  await w.git(["commit", "--quiet", "-m", file])
  const head = (await w.git(["rev-parse", "HEAD"])).trim()
  await w.git(["checkout", "--quiet", "main"])
  await submit(w.git, "origin", { branch: "main", changeBranch: branch, submitter: "@dev/2", workItem: `@i/1/${file}` })
  return head
}

describe("the declaration is read from the commit of the branch the queue lands on", () => {
  it("names the remote, the branch, the checks with their phases, and who hears about stuck", async () => {
    const w = await world(
      [
        "remote: origin",
        "owner: '@cto'",
        "notify: bun tools/notify.ts",
        "checks:",
        "  - typecheck:",
        "      run: bun run typecheck",
        "      on: [submit, merge]",
        "  - tests:",
        "      run: bun run test",
        "      timeoutMs: 1800000",
        "",
      ].join("\n"),
    )
    const config = await readConfig(w.git, "main")
    expect(config).toMatchObject({ branch: "main", notify: "bun tools/notify.ts", owner: "@cto", remote: "origin" })
    expect(config?.checks).toEqual([
      { environmentPassthrough: undefined, name: "typecheck", on: ["submit", "merge"], run: "bun run typecheck", timeoutMs: undefined },
      { environmentPassthrough: undefined, name: "tests", on: undefined, run: "bun run test", timeoutMs: 1_800_000 },
    ])
    expect(config?.blob).toMatch(/^[0-9a-f]{40}$/u)
  })

  it("names the setup that finishes every fresh worktree, and holds it to one command", async () => {
    // A fresh worktree has submodules and no dependencies, so the target says
    // once how to finish one instead of every check prefixing its own `run:`.
    const declared = await world("remote: origin\nsetup: bun install --frozen-lockfile\nchecks:\n  - tests:\n      run: bun run test\n")
    expect(await readConfig(declared.git, "main")).toMatchObject({ setup: "bun install --frozen-lockfile" })

    // Optional: a target that declares none prepares nothing beyond materialization.
    const none = await world("remote: origin\n")
    expect((await readConfig(none.git, "main"))?.setup).toBeUndefined()

    // Strict, as every key is: a typo is a setup that would silently never run.
    const typo = await world("remote: origin\nsetupp: bun install\n")
    await expect(readConfig(typo.git, "main")).rejects.toThrow(/unknown key setupp/u)
    const empty = await world("remote: origin\nsetup: ''\n")
    await expect(readConfig(empty.git, "main")).rejects.toThrow(/setup: must be a non-empty string/u)
  })

  it("names the queue's working directory as workdir:, and refuses the retired scratch: outright", async () => {
    // `workdir:` is the whole working directory — the checkouts, the check
    // logs, and the temp root every check gets as TMPDIR — so it is one word,
    // not the old `scratch:`, which named the same root after only the last of
    // those three. A declaration still carrying the old key is a queue writing
    // somewhere nobody declared, so it is refused rather than defaulted.
    const declared = await world("remote: origin\nworkdir: /var/tmp/yrd\n")
    expect(await readConfig(declared.git, "main")).toMatchObject({ workdir: "/var/tmp/yrd" })

    const old = await world("remote: origin\nscratch: /var/tmp/yrd\n")
    await expect(readConfig(old.git, "main")).rejects.toThrow(/unknown key scratch/u)
  })

  it("is not this core's when it names no remote, and is loud when it is wrong", async () => {
    const old = await world("batch: 1\nchecks:\n  - verify:\n      run: bun run test\n")
    // The switch reads only whether `remote:` is there; the full read holds the
    // file to the keys this core knows, so the incumbent's `batch:` is loud.
    expect((await readHints(old.git, "main")).remote).toBeUndefined()
    await expect(readConfig(old.git, "main")).rejects.toThrow(/unknown key batch/u)

    const wrong = await world("remote: origin\nchecks:\n  - verify:\n      on: sometimes\n      run: bun run test\n")
    await expect(readConfig(wrong.git, "main")).rejects.toThrow(/on: must be submit or merge/u)
  })
})

describe("the table is the queue read rendered", () => {
  it("lists changes in line with their position, then the ended ones", async () => {
    const w = await world("remote: origin\n")
    const one = await submitCommit(w, "task/one", "one.txt")
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const two = await submitCommit(w, "task/two", "two.txt")
    const rows = list((await readQueue(w.git, "origin", "main")).changes)
    expect(rows.map((row) => [row.branch, row.position, row.state, row.workItem])).toEqual([
      ["task/one", 1, "queued", "@i/1/one.txt"],
      ["task/two", 2, "queued", "@i/1/two.txt"],
    ])
    expect(rows.map((row) => row.head)).toEqual([one, two])
  })

  it("lists a commit the target gained by hand as its own row, as recent as it was committed (E5)", async () => {
    const w = await world("remote: origin\n")
    await submitCommit(w, "task/one", "one.txt")
    await w.git(["checkout", "--quiet", "main"])
    writeFileSync(join(w.work, "hand.txt"), "hand\n")
    await w.git(["add", "hand.txt"])
    await w.git(["commit", "--quiet", "-m", "hand.txt by hand"])
    await w.git(["push", "--quiet", "origin", "main"])
    const hand = (await w.git(["rev-parse", "HEAD"])).trim()

    const entries = (await readQueue(w.git, "origin", "main")).changes
    const byHand = await byHandCommits(w.git, "main", hand, entries)
    expect(byHand.map((commit) => [commit.commit, commit.subject, commit.gitlinks, commit.why])).toEqual([
      [hand, "hand.txt by hand", [], "it is one commit, not a merge of a change"],
    ])
    const rows = list(entries, { byHand })
    expect(rows.map((row) => [row.state, row.branch, row.head, row.position, row.reason])).toEqual([
      ["queued", "task/one", rows[0]?.head, 1, undefined],
      ["by hand", "main", hand, undefined, `main moved by hand at ${hand.slice(0, 12)} (hand.txt by hand)`],
    ])
    // Windowed like every ended row: an old hand commit is not this week's news.
    expect(list(entries, { byHand, sinceMs: 0, now: new Date(Date.now() + 60_000) }).map((row) => row.state)).toEqual([
      "queued",
    ])
  })

  it("shows one branch's changes newest first", async () => {
    const w = await world("remote: origin\n")
    const first = await submitCommit(w, "task/one", "one.txt")
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await w.git(["checkout", "--quiet", "task/one"])
    writeFileSync(join(w.work, "one.txt"), "one, again\n")
    await w.git(["commit", "--quiet", "-am", "again"])
    const second = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])
    await submit(w.git, "origin", { branch: "main", changeBranch: "task/one", submitter: "@dev/2" })

    const shown = show((await readQueue(w.git, "origin", "main")).changes, "task/one")
    expect(shown.map((entry) => [entry.row.head, entry.row.state, entry.row.reason])).toEqual([
      [second, "queued", undefined],
      [first, "failed", "replaced"],
    ])
  })
})

describe("a packed Check: trailer", () => {
  it("reads back the name and the log the writer put in it, log path and all", () => {
    // The table renders a row off this trailer, so the pair is the contract:
    // whatever the run writes, the reader has to give back.
    const packed = checkTrailer({
      durationMs: 1234,
      exit: 1,
      log: "/queue/checks/task~one@abc/q-1/merge/type=check.log",
      name: "verify",
      result: "fail",
    })

    expect(packed).toBe("verify exit=1 ms=1234 log=/queue/checks/task~one@abc/q-1/merge/type=check.log")
    expect(readCheckTrailer(packed)).toEqual({
      log: "/queue/checks/task~one@abc/q-1/merge/type=check.log",
      name: "verify",
    })
  })
})
