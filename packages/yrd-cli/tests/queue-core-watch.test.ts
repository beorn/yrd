/**
 * @failure  A watch that cannot be trusted to END is a watch nobody scripts
 *           against: the retired monitor exited 0 whatever became of the
 *           change, so a seat waiting on `yrd watch <branch>` learned nothing
 *           from its exit and had to grep the output. A watch given a change
 *           runs to that change's ending and exits with the ending's own code,
 *           exactly as `yrd check` does (plan.md:150).
 * @level    l2 (a real remote and a clone under a temporary root;
 *           `coreQueueCommand` driven directly, no process boundary)
 * @consumer a seat scripting `yrd watch my-branch && deploy` · the operator
 *           reading the live table
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { gitIn, submit, type Git } from "@yrd/queue-core"
import { coreQueueCommand } from "../src/queue-core-commands.ts"
import type { YrdCliIO } from "../src/types.ts"
import type { WatchSnapshot } from "../src/watch-pane.tsx"

const rendered: { snapshot: WatchSnapshot | undefined } = vi.hoisted(() => ({ snapshot: undefined }))
vi.mock("silvery/runtime", () => ({
  run: async (element: Readonly<{ props: Readonly<{ snapshot: WatchSnapshot }> }>) => {
    rendered.snapshot = element.props.snapshot
    return { waitUntilExit: async () => {} }
  },
}))

function renderedSnapshot(): WatchSnapshot | undefined {
  return rendered.snapshot
}

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

type Capture = Readonly<{ io: YrdCliIO; stdout(): string; stderr(): string }>

function capture(cwd: string): Capture {
  let stdout = ""
  let stderr = ""
  return {
    io: {
      color: false,
      cwd,
      stderr(text) {
        stderr += text
      },
      stdout(text) {
        stdout += text
      },
    },
    stderr: () => stderr,
    stdout: () => stdout,
  }
}

type World = Readonly<{ git: Git; work: string; workdir: string }>

/**
 * A bare remote whose `main` declares one check, and a clone of it. The check
 * passes or fails on a file the change itself carries, so a test decides an
 * ending by what it commits rather than by stubbing anything.
 */
async function world(check = "test -f pass.txt"): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-watch-"))
  roots.push(root)
  const seed = gitIn(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await git(["config", "user.email", "queue@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, ".yrd.yml"), `target: origin#main\nchecks:\n  - verify:\n      run: ${check}\n`)
  await git(["add", ".yrd.yml"])
  await git(["commit", "--quiet", "-m", "main declares the queue"])
  await git(["push", "--quiet", "origin", "main"])
  const workdir = join(root, "queue")
  mkdirSync(workdir, { recursive: true })
  return { git, work, workdir }
}

/** A change on its own branch, submitted; `passes` decides what the declared check will say about it. */
async function change(w: World, branch: string, passes: boolean): Promise<void> {
  await w.git(["checkout", "--quiet", "-b", branch, "main"])
  if (passes) writeFileSync(join(w.work, "pass.txt"), "pass\n")
  else writeFileSync(join(w.work, `${branch.replace(/\//gu, "-")}.txt`), "no pass file\n")
  await w.git(["add", "."])
  await w.git(["commit", "--quiet", "-m", `${branch} does its work`])
  await w.git(["checkout", "--quiet", "main"])
  await submit(w.git, "origin", {
    branch,
    submitter: "@dev/2",
    target: { branch: "main", remote: "origin" },
  })
}

/** One queue round, so the changes reach an ending before the watch reads them. */
async function drain(w: World): Promise<void> {
  const run = capture(w.work)
  await coreQueueCommand(w.work, run.io, { command: "run" }, { json: true, workdir: w.workdir })
}

describe("yrd watch, the ending's exit code", () => {
  it("exits 0 for a change the queue merged", async () => {
    const w = await world()
    await change(w, "task/good", true)
    await drain(w)
    const run = capture(w.work)

    const exit = await coreQueueCommand(
      w.work,
      run.io,
      { command: "list", terms: ["task/good"], watch: true },
      { workdir: w.workdir },
    )

    expect(exit, run.stdout()).toBe(0)
    expect(run.stdout()).toContain("task/good")
    expect(run.stdout()).toContain("merged")
  })

  it("exits 1 for a change the queue failed, so a seat can script on it", async () => {
    const w = await world()
    await change(w, "task/bad", false)
    await drain(w)
    const run = capture(w.work)

    const exit = await coreQueueCommand(
      w.work,
      run.io,
      { command: "list", terms: ["task/bad"], watch: true },
      { workdir: w.workdir },
    )

    expect(exit, run.stdout()).toBe(1)
    expect(run.stdout()).toContain("failed")
  })

  it("exits 2 for a change the queue could not judge", async () => {
    // A check the shell cannot find is the queue's own ground, not the
    // submitter's, so its ending is stuck (check.ts: exit 127 is `missing`).
    const w = await world("this-command-does-not-exist-anywhere")
    await change(w, "task/unjudgeable", true)
    await drain(w)
    const run = capture(w.work)

    const exit = await coreQueueCommand(
      w.work,
      run.io,
      { command: "list", terms: ["task/unjudgeable"], watch: true },
      { workdir: w.workdir },
    )

    expect(exit, run.stdout()).toBe(2)
    expect(run.stdout()).toContain("stuck")
  })

  it("refuses a selector that matches nothing rather than waiting forever for a change that is not there", async () => {
    const w = await world()
    await change(w, "task/good", true)
    const run = capture(w.work)

    const exit = await coreQueueCommand(
      w.work,
      run.io,
      { command: "list", terms: ["no-such-branch"], watch: true },
      { workdir: w.workdir },
    )

    expect(exit).toBe(2)
    // What was asked for, where it was looked for, and what the read leaves
    // out — on stderr, not inferred by the reader from an empty table.
    expect(run.stderr()).toContain("no-such-branch")
    expect(run.stderr()).toContain("seven days")
  })

  it("keeps refreshing with no selector, because there is no ending to run to, and stops on the signal", async () => {
    const w = await world()
    await change(w, "task/good", true)
    const run = capture(w.work)
    const stop = new AbortController()
    stop.abort()

    const exit = await coreQueueCommand(
      w.work,
      run.io,
      { command: "list", intervalSeconds: 1, stop: stop.signal, watch: true },
      { workdir: w.workdir },
    )

    expect(exit, run.stdout()).toBe(0)
    expect(run.stdout()).toContain("task/good")
  })
})

describe("what a watch says it looked at", () => {
  it("names the journal directory it read and that there was none, rather than showing a blank where a fact belongs", async () => {
    const w = await world()
    await change(w, "task/good", true)
    const run = capture(w.work)

    // No queue ran on this machine, so `<workdir>/logs` does not exist and
    // every journal-derived field is absent. G5: say where you looked.
    await coreQueueCommand(w.work, run.io, { command: "list" }, { workdir: w.workdir })

    expect(run.stdout()).toContain(join(w.workdir, "logs"))
    expect(run.stdout()).toContain("no run journal was read")
  })

  it("says how many changes a filter matched and out of how many", async () => {
    const w = await world()
    await change(w, "task/good", true)
    await change(w, "task/other", false)
    const run = capture(w.work)

    await coreQueueCommand(w.work, run.io, { command: "list", terms: ["task/good"] }, { workdir: w.workdir })

    expect(run.stdout()).toContain("1 of 2 change(s) match task/good")
  })

  it("carries the journal reading in the JSON too, so a consumer can tell no journal from nothing running", async () => {
    const w = await world()
    await change(w, "task/good", true)
    const run = capture(w.work)

    await coreQueueCommand(w.work, run.io, { command: "list" }, { json: true, workdir: w.workdir })

    const listed = JSON.parse(run.stdout().trim()) as Readonly<{ journal: Readonly<{ dir: string; absent?: string }> }>
    expect(listed.journal.dir).toBe(join(w.workdir, "logs"))
    expect(listed.journal.absent).toContain("there is no such directory")
  })

  it("puts submit- and merge-round checks into a merged change's interactive detail", async () => {
    const w = await world()
    writeFileSync(
      join(w.work, ".yrd.yml"),
      [
        "target: origin#main",
        "checks:",
        "  - repeated:",
        "      run: test -f pass.txt",
        "      on: [submit, merge]",
        "  - submit-only:",
        "      run: test -f pass.txt",
        "      on: submit",
        "  - merge-only:",
        "      run: test -f pass.txt",
        "      on: merge",
        "",
      ].join("\n"),
    )
    await w.git(["commit", "--quiet", "-am", "declare checks in both phases"])
    await w.git(["push", "--quiet", "origin", "main"])
    await change(w, "task/good", true)
    await drain(w)
    rendered.snapshot = undefined

    const run = capture(w.work)
    const exit = await coreQueueCommand(
      w.work,
      run.io,
      { command: "list", terms: ["task/good"], watch: true },
      { interactive: true, workdir: w.workdir },
    )

    expect(exit).toBe(0)
    const snapshot = renderedSnapshot()
    if (snapshot === undefined) throw new Error("interactive watch rendered no snapshot")
    const detail = snapshot.detail.values().next().value
    if (detail === undefined) throw new Error("interactive watch rendered no change detail")
    // Each measured occurrence survives, including the same name in two
    // phases; CTO b55a973f forbids collapsing the candidate/comparator pair.
    expect(detail.checks.map((check) => [check.name, check.phase, check.state])).toEqual([
      ["repeated", "submit", "passed"],
      ["submit-only", "submit", "passed"],
      ["repeated", "merge", "passed"],
      ["merge-only", "merge", "passed"],
    ])
    expect(detail.checks.find((check) => check.name === "repeated" && check.phase === "submit")?.log).toContain(
      "/submit/",
    )
    expect(detail.checks.find((check) => check.name === "repeated" && check.phase === "merge")?.log).toContain(
      "/merge/",
    )
  })

  it("keeps each historical run's result and output in JSON, text, and interactive detail", async () => {
    // One real change, first stuck then failed. The old artifact survives;
    // historical-run-rows-use-latest-result was the reader relabelling it.
    const w = await world()
    const control = join(w.workdir, "check.sh")
    writeFileSync(control, "echo FIRST_RUN_MISSING\nexit 127\n")
    writeFileSync(
      join(w.work, ".yrd.yml"),
      `target: origin#main\nchecks:\n  - verify:\n      run: ${JSON.stringify(`sh ${control}`)}\n`,
    )
    await w.git(["commit", "--quiet", "-am", "declare a repairable external check"])
    await w.git(["push", "--quiet", "origin", "main"])
    await change(w, "task/history", false)

    const first = capture(w.work)
    expect(await coreQueueCommand(w.work, first.io, { command: "run" }, { json: true, workdir: w.workdir })).toBe(2)
    const firstId = (JSON.parse(first.stdout()) as { run: string }).run
    const before = capture(w.work)
    await coreQueueCommand(w.work, before.io, { command: "list" }, { json: true, workdir: w.workdir })
    const original = (JSON.parse(before.stdout()) as { changes: Record<string, unknown>[] }).changes.find(
      (row) => row.branch === "task/history",
    )!
    expect(original.state).toBe("stuck")
    expect(readFileSync(String(original.log), "utf8")).toBe("FIRST_RUN_MISSING\n")

    writeFileSync(control, "echo SECOND_RUN_FAIL\nexit 1\n")
    const second = capture(w.work)
    expect(await coreQueueCommand(w.work, second.io, { command: "run" }, { json: true, workdir: w.workdir })).toBe(1)
    const secondId = (JSON.parse(second.stdout()) as { run: string }).run
    const listed = capture(w.work)
    await coreQueueCommand(w.work, listed.io, { command: "list" }, { json: true, workdir: w.workdir })
    const rows = (JSON.parse(listed.stdout()) as { changes: Record<string, unknown>[] }).changes.filter(
      (row) => row.branch === "task/history",
    )
    expect(rows).toHaveLength(2)
    const old = rows.find((row) => row.run === firstId)!
    const latest = rows.find((row) => row.run === secondId)!
    expect(old, listed.stdout()).toMatchObject({
      state: "failed",
      run: firstId,
      result: original.result,
      log: original.log,
    })
    expect(latest).toMatchObject({ state: "failed", run: secondId, result: "fail verify" })
    expect(rows.some((row) => "runResult" in row || "runOf" in row)).toBe(false)
    expect(old.endedAt).toBe(original.endedAt)
    expect(latest.incident).toBeUndefined()
    expect(readFileSync(String(old.log), "utf8")).toBe("FIRST_RUN_MISSING\n")
    expect(readFileSync(String(latest.log), "utf8")).toBe("SECOND_RUN_FAIL\n")

    const plain = capture(w.work)
    await coreQueueCommand(w.work, plain.io, { command: "list" }, { workdir: w.workdir })
    expect(
      plain
        .stdout()
        .split("\n")
        .find((line) => line.includes(`[${firstId}]`)),
    ).toContain(String(original.result))
    expect(
      plain
        .stdout()
        .split("\n")
        .find((line) => line.includes(`[${secondId}]`)),
    ).toContain("fail verify")

    rendered.snapshot = undefined
    const interactive = capture(w.work)
    expect(
      await coreQueueCommand(
        w.work,
        interactive.io,
        { command: "list", watch: true, terms: ["task/history"] },
        { interactive: true, workdir: w.workdir },
      ),
      interactive.stderr(),
    ).toBe(0)
    const snapshot = renderedSnapshot()
    if (snapshot === undefined) throw new Error("interactive list rendered no snapshot")
    expect(snapshot.rows.map((entry) => entry.row.run)).toEqual([secondId, firstId])
    const details = [...snapshot.detail.values()]
    expect(details).toHaveLength(2)
    expect(details.find((detail) => detail.row.run === firstId)?.checks[0]).toMatchObject({
      state: "stuck",
      log: original.log,
      output: "FIRST_RUN_MISSING\n",
    })
    expect(details.find((detail) => detail.row.run === secondId)?.checks[0]).toMatchObject({
      state: "failed",
      log: latest.log,
      output: "SECOND_RUN_FAIL\n",
    })
  })
})
