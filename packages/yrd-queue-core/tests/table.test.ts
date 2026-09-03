/**
 * The table and the declaration, on the same real remote the other tests use.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { gitIn, lane, list, readConfig, show, submit } from "../src/index.ts"
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
  await submit(w.git, "origin", { branch, submitter: "@dev/2", target: "main", workItem: `@i/1/${file}` })
  return head
}

describe("the declaration is read from the target commit", () => {
  it("names the remote, the target, the checks with their phases, and who hears about stuck", async () => {
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
    expect(config).toMatchObject({ notify: "bun tools/notify.ts", owner: "@cto", remote: "origin", target: "main" })
    expect(config?.checks).toEqual([
      { environmentPassthrough: undefined, name: "typecheck", on: ["submit", "merge"], run: "bun run typecheck", timeoutMs: undefined },
      { environmentPassthrough: undefined, name: "tests", on: undefined, run: "bun run test", timeoutMs: 1_800_000 },
    ])
    expect(config?.blob).toMatch(/^[0-9a-f]{40}$/u)
  })

  it("is not this core's when it names no remote, and is loud when it is wrong", async () => {
    const old = await world("batch: 1\nchecks:\n  - verify:\n      run: bun run test\n")
    expect((await readConfig(old.git, "main"))?.declaresRemote).toBe(false)

    const wrong = await world("remote: origin\nchecks:\n  - verify:\n      on: sometimes\n      run: bun run test\n")
    await expect(readConfig(wrong.git, "main")).rejects.toThrow(/on: must be submit or merge/u)
  })
})

describe("the table is the lane rendered", () => {
  it("lists changes in line with their position, then the ended ones", async () => {
    const w = await world("remote: origin\n")
    const one = await submitCommit(w, "task/one", "one.txt")
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const two = await submitCommit(w, "task/two", "two.txt")
    const rows = list(await lane(w.git, "origin", "main"))
    expect(rows.map((row) => [row.branch, row.position, row.state, row.workItem])).toEqual([
      ["task/one", 1, "queued", "@i/1/one.txt"],
      ["task/two", 2, "queued", "@i/1/two.txt"],
    ])
    expect(rows.map((row) => row.head)).toEqual([one, two])
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
    await submit(w.git, "origin", { branch: "task/one", submitter: "@dev/2", target: "main" })

    const shown = show(await lane(w.git, "origin", "main"), "task/one")
    expect(shown.map((entry) => [entry.row.head, entry.row.state, entry.row.reason])).toEqual([
      [second, "queued", undefined],
      [first, "failed", "replaced"],
    ])
  })
})
