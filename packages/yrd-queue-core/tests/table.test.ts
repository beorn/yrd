/**
 * The table and the declaration, on the same real remote the other tests use.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  appendRecord,
  changeRef,
  checkTrailer,
  gitIn,
  list,
  directMergeCommits,
  queueName,
  readCheckTrailer,
  readConfig,
  readHistories,
  readQueue,
  show,
  submit,
} from "../src/index.ts"
import type { Git } from "../src/index.ts"

const roots: string[] = []
const MAIN = { branch: "main", remote: "origin" } as const

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
  await submit(w.git, "origin", {
    branch,
    submitter: "@dev/2",
    target: { branch: "main", remote: "origin" },
    issue: `@i/1/${file}`,
  })
  return head
}

describe("the declaration is read from the queue branch commit", () => {
  it("carries the selected queue, the checks with their phases, and who is notified of what", async () => {
    const w = await world(
      [
        "notify:",
        "  - submitter:",
        "      on: [merged, failed]",
        "      run: bun tools/yrd-notify.ts",
        "  - supervisor:",
        "      on: stuck",
        "      run: bun tools/yrd-notify.ts --to @cto",
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
    const config = await readConfig(w.git, "main", MAIN)
    expect(config).toMatchObject({ target: { branch: "main", remote: "origin" } })
    expect(config?.notify).toEqual([
      { name: "submitter", on: ["merged", "failed"], run: "bun tools/yrd-notify.ts" },
      { name: "supervisor", on: ["stuck"], run: "bun tools/yrd-notify.ts --to @cto" },
    ])
    expect(config?.checks).toEqual([
      {
        environmentPassthrough: undefined,
        name: "typecheck",
        on: ["submit", "merge"],
        run: "bun run typecheck",
        timeoutMs: undefined,
      },
      { environmentPassthrough: undefined, name: "tests", on: undefined, run: "bun run test", timeoutMs: 1_800_000 },
    ])
    expect(config?.blob).toMatch(/^[0-9a-f]{40}$/u)
  })

  it("names the setup that finishes every fresh worktree, and holds it to one command", async () => {
    // A fresh worktree has submodules and no dependencies, so the target says
    // once how to finish one instead of every check prefixing its own `run:`.
    const declared = await world("setup: bun install --frozen-lockfile\nchecks:\n  - tests:\n      run: bun run test\n")
    expect(await readConfig(declared.git, "main", MAIN)).toMatchObject({ setup: "bun install --frozen-lockfile" })

    // Optional: a target that declares none prepares nothing beyond materialization.
    const none = await world("{}\n")
    expect((await readConfig(none.git, "main", MAIN))?.setup).toBeUndefined()

    // Strict, as every key is: a typo is a setup that would silently never run.
    const typo = await world("setupp: bun install\n")
    await expect(readConfig(typo.git, "main", MAIN)).rejects.toThrow(/unknown key setupp/u)
    const empty = await world("setup: ''\n")
    await expect(readConfig(empty.git, "main", MAIN)).rejects.toThrow(/setup: must be a non-empty string/u)
  })

  it("refuses a retired key by naming where its meaning went, not just that it is unknown", async () => {
    // The workdir is a path on ONE machine, so it is git
    // configuration and never a declaration key: the declaration is one file
    // every clone shares. Both spellings it ever had are refused, and the
    // refusal says where to say it instead — "unknown key workdir" would tell a
    // reader the queue forgot how to write somewhere.
    for (const key of ["workdir", "scratch"]) {
      const retired = await world(`${key}: /var/tmp/yrd\n`)
      await expect(readConfig(retired.git, "main", MAIN)).rejects.toThrow(new RegExp(`unknown key ${key}`, "u"))
      await expect(readConfig(retired.git, "main", MAIN)).rejects.toThrow(/git config yrd\.workdir/u)
    }

    // `owner:` went too: the queue addresses the roles `submitter` and `owner`,
    // and which seat wears the owner's is the notifier's own argument.
    const owned = await world("owner: '@cto'\n")
    await expect(readConfig(owned.git, "main", MAIN)).rejects.toThrow(/unknown key owner/u)
  })

  it("takes queue identity from the caller and refuses target: and remote: by name", async () => {
    const plain = await world("{}\n")
    expect(await readConfig(plain.git, "main", MAIN)).toMatchObject({
      checks: [],
      target: { branch: "main", remote: "origin" },
    })

    for (const key of ["target", "remote"] as const) {
      const retired = await world(`${key}: origin#develop\n`)
      await expect(readConfig(retired.git, "main", MAIN)).rejects.toThrow(new RegExp(`unknown key ${key}`, "u"))
      await expect(readConfig(retired.git, "main", MAIN)).rejects.toThrow("--queue <branch>")
    }
  })

  it("holds notify: to the checks' own shape, and refuses the two keys it replaced", async () => {
    // `notify:` and `checks:` are both "these commands, each for these
    // occasions", so they are one grammar: a reader who has learned one has
    // learned the other. An entry with no `on:` wants every ending.
    const all = await world("notify:\n  - everyone:\n      run: bun tools/yrd-notify.ts\n")
    expect((await readConfig(all.git, "main", MAIN))?.notify).toEqual([
      { name: "everyone", on: ["merged", "failed", "stuck", "merged-direct"], run: "bun tools/yrd-notify.ts" },
    ])

    // The old scalar is a list of one entry now, and the refusal shows the shape.
    const scalar = await world("notify: bun tools/yrd-notify.ts\n")
    await expect(readConfig(scalar.git, "main", MAIN)).rejects.toThrow(/notify: must be a list of/u)

    // An ending the queue does not have, and a key `notify:` does not read.
    const unknownEnding = await world("notify:\n  - everyone:\n      on: landed\n      run: bun x\n")
    await expect(readConfig(unknownEnding.git, "main", MAIN)).rejects.toThrow(
      /on: must be merged or failed or stuck or merged-direct/u,
    )
    const timed = await world("notify:\n  - everyone:\n      run: bun x\n      timeoutMs: 1000\n")
    await expect(readConfig(timed.git, "main", MAIN)).rejects.toThrow(/unknown key timeoutMs/u)

    // `owner:` went with the seat name it held: a notify entry decides who
    // hears about an ending, in its own arguments.
    const owned = await world("owner: '@cto'\n")
    await expect(readConfig(owned.git, "main", MAIN)).rejects.toThrow(/unknown key owner/u)
    await expect(readConfig(owned.git, "main", MAIN)).rejects.toThrow(/the queue addresses nobody/u)
  })

  it("names itself by URL, normalized, so two clones of one queue say one name", async () => {
    // A remote NAME means nothing outside the repository that holds it, and a
    // merge commit is read by people who have neither. What is dropped is how
    // you reach it, never which it is.
    const main = { branch: "main", remote: "unused" }
    expect(queueName(main, "git@github.com:beorn/hh.git")).toBe("github.com/beorn/hh#main")
    expect(queueName(main, "https://github.com/beorn/hh.git")).toBe("github.com/beorn/hh#main")
    expect(queueName(main, "/srv/git/hh.git")).toBe("/srv/git/hh.git#main")
    expect(queueName({ branch: "develop", remote: "unused" }, "ssh://git@example.invalid:22/x/y/")).toBe(
      "example.invalid:22/x/y#develop",
    )
  })

  it("is loud about every other key it does not read", async () => {
    const old = await world("batch: 1\nchecks:\n  - verify:\n      run: bun run test\n")
    await expect(readConfig(old.git, "main", MAIN)).rejects.toThrow(/unknown key batch/u)

    const wrong = await world("checks:\n  - verify:\n      on: sometimes\n      run: bun run test\n")
    await expect(readConfig(wrong.git, "main", MAIN)).rejects.toThrow(/on: must be submit or merge/u)
  })
})

describe("the table is the queue read rendered", () => {
  it("lists changes in line with their position, then the ended ones", async () => {
    const w = await world("{}\n")
    const one = await submitCommit(w, "task/one", "one.txt")
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const two = await submitCommit(w, "task/two", "two.txt")
    const rows = list((await readQueue(w.git, "origin", "main")).changes)
    expect(rows.map((row) => [row.branch, row.position, row.state, row.issue])).toEqual([
      ["task/one", 1, "queued", "@i/1/one.txt"],
      ["task/two", 2, "queued", "@i/1/two.txt"],
    ])
    expect(rows.map((row) => row.head)).toEqual([one, two])
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

    const entries = (await readQueue(w.git, "origin", "main")).changes
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

    const shown = show((await readQueue(w.git, "origin", "main")).changes, "task/one")
    expect(shown.map((entry) => [entry.row.head, entry.row.state, entry.row.reason])).toEqual([
      [second, "queued", undefined],
      [first, "failed", "replaced"],
    ])
  })

  it("shows checks from every record after a checked change is merged and sent", async () => {
    const w = await world("{}\n")
    const head = await submitCommit(w, "task/one", "one.txt")
    const change = { branch: "task/one", head }
    const base = (await w.git(["rev-parse", "main"])).trim()
    const incident = [
      ["Code", "yrd-submodule-main-regression"],
      ["Subject", "task/one"],
      ["Via", "pre-merge"],
      ["Evidence", "/tmp/submodule-main.log"],
      ["Next", "repair the component pin"],
      ["Owner", "@cto"],
    ] as const
    for (const kind of ["stuck", "sent"] as const) {
      await appendRecord(w.git, "main", {
        change,
        kind,
        subject: kind === "stuck" ? "component pin needs repair" : "sent stuck notice",
        trailers: [...incident, ...(kind === "sent" ? [["State", "stuck"] as const] : [])],
      })
    }
    await w.git(["push", "--quiet", "origin", `${changeRef("main", change)}:${changeRef("main", change)}`])
    const beforeRecheck = (await readQueue(w.git, "origin", "main")).changes
    expect(beforeRecheck[0]?.reading.state).toBe("stuck")
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
    // A concurrent fetch can advance the local ref between the queue read
    // and opening detail. History must expand that reading, not mix moments.
    const prior = show(await readHistories(w.git, beforeRecheck, "origin", "main"), change.branch)
    expect(prior[0]?.row).toMatchObject({ state: "stuck", incident: { code: "yrd-submodule-main-regression" } })
    expect(prior[0]?.checks).toEqual([])
    await appendRecord(w.git, "main", {
      change,
      kind: "merged",
      subject: "merged task/one into main",
      trailers: [
        ["Base", base],
        ["Merge", base],
        ["Check", "affected-tests exit=0 ms=15 log=/tmp/affected.log"],
      ],
    })
    await appendRecord(w.git, "main", {
      change,
      kind: "sent",
      subject: "sent merge notice",
      trailers: [
        ["State", "merged"],
        ["Base", base],
        ["Merge", base],
        ["Check", "affected-tests exit=0 ms=15 log=/tmp/affected.log"],
      ],
    })
    await w.git(["push", "--quiet", "origin", `${changeRef("main", change)}:${changeRef("main", change)}`])

    const queue = await readQueue(w.git, "origin", "main")
    const entry = queue.changes[0]
    if (entry === undefined) throw new Error("submitted change missing from the queue read")
    const shown = show(await readHistories(w.git, [entry], "origin", "main"), change.branch)

    expect(shown[0]?.checks).toEqual([
      "typecheck exit=0 ms=12 log=/tmp/typecheck.log",
      "manifest-co-change exit=0 ms=13 log=/tmp/manifest.log",
      "substrate-pair exit=0 ms=14 log=/tmp/substrate.log",
      "affected-tests exit=0 ms=15 log=/tmp/affected.log",
      "affected-tests exit=0 ms=15 log=/tmp/affected.log",
    ])
  })
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
