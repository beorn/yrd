/**
 * @failure  `yrd queue show <branch> --json` put `position: 1` on every waiting
 *           branch: its per-branch fold built a one-element in-line set, so the
 *           rank it reported could never be anything but first. `yrd queue list`
 *           read the same two branches as 1 and 2, so an agent reading one
 *           branch mistook a constant for its place in the merge line (29342).
 * @level    l2 (a real queue in a real Git worktree, read through the CLI)
 * @consumer an agent checking where its submitted change stands in the queue
 * @testonly none
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { changeInput, changesRef, createEventStore, readEventQueue, submit } from "@yrd/queue-core"
import { openEvents } from "gitomic/events"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { runYrdProcess } from "../src/cli.ts"
import { birthEventQueue } from "./support/event-queue-birth.ts"
import type { YrdCliExitCode, YrdCliIO } from "../src/types.ts"

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

type Ran = Readonly<{ exitCode: YrdCliExitCode; stdout: string; stderr: string; report: string }>

/** The CLI as the shell runs it: argv in, exit code and both streams out. */
async function yrd(cwd: string, ...args: string[]): Promise<Ran> {
  let stdout = ""
  let stderr = ""
  const io: YrdCliIO = {
    localBranchProtections: null,
    color: false,
    cwd,
    stderr(text) {
      stderr += text
    },
    stdout(text) {
      stdout += text
    },
  }
  const exitCode = await runYrdProcess([process.execPath, "/usr/local/bin/yrd", ...args], io)
  return {
    exitCode,
    report: `yrd ${args.join(" ")} exited ${String(exitCode)}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    stderr,
    stdout,
  }
}

/**
 * A bare remote whose `main` declares the queue, a clone of it, and TWO changes
 * submitted first and second in that order, so the queue holds a two-change line.
 */
async function queueWithTwoChanges(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-show-position-"))
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
  writeFileSync(join(work, ".yrd.yml"), "checks:\n  - verify:\n      run: test -f pass.txt\n")
  await git(["add", ".yrd.yml"])
  await git(["commit", "--quiet", "-m", "main declares the queue"])
  await git(["push", "--quiet", "origin", "main"])
  await birthEventQueue(work)
  for (const name of ["one", "two"]) {
    await git(["checkout", "--quiet", "-b", `task/${name}`, "main"])
    writeFileSync(join(work, `${name}.txt`), `${name}\n`)
    await git(["add", "."])
    await git(["commit", "--quiet", "-m", `task/${name} does its work`])
    await git(["checkout", "--quiet", "main"])
    await submit(git, "origin", {
      branch: `task/${name}`,
      submitter: "@dev/10",
      target: { branch: "main", remote: "origin" },
    })
  }
  return work
}

type Change = Readonly<{ branch: string; position?: number; state: string }>

/** The line positions a reading reports, keyed by branch, for the changes holding one. */
function positions(reading: Ran): Record<string, number> {
  const parsed = JSON.parse(reading.stdout) as { changes: readonly Change[] }
  const found: Record<string, number> = {}
  for (const change of parsed.changes) {
    if (change.position !== undefined) found[change.branch] = change.position
  }
  return found
}

describe("`yrd queue show` and the merge-line position (#29342)", () => {
  /** @failure The Markdown pipe walks every branch, loses event-row values, or emits partial output on overflow.
   * @level l2 @consumer yrd queue show --markdown
   * The position journey never requests Markdown or bounds a selected chain.
   */
  it("emits a complete fixed 50-event document and names overflow without product output", async () => {
    const work = await queueWithTwoChanges()
    const git = gitIn(work)
    const store = createEventStore(work, "origin", git.selection)
    const queueTip = (await readEventQueue(store, "main")).tip!
    const head = (await git(["rev-parse", "HEAD"])).trim()
    const branch = "task/markdown"
    const ref = changesRef("main", branch)
    const chain = await openEvents({ ...store, ref })
    const times = [0, 1, 2, 3].map((hour) => new Date(`2026-09-22T0${hour}:00:00.000Z`))
    const reason = "pipe | `code` <tag> ```"
    const written = await chain.append(
      [
        changeInput("opened", { queueTip, at: times[0]!, commit: head, by: "@dev/10" }),
        ...Array.from({ length: 46 }, (_, index) =>
          changeInput(index % 2 === 0 ? "ignored" : "unignored", {
            queueTip,
            at: times[0]!,
            by: "@dev/10",
            ...(index % 2 === 0 ? { reason: "fixture" } : {}),
          }),
        ),
        changeInput("failed", { queueTip, at: times[1]!, reason }),
        changeInput("opened", { queueTip, at: times[2]!, commit: head, by: "@dev/10" }),
        changeInput("cancelled", { queueTip, at: times[3]!, reason: "withdrawn" }),
      ],
      { expect: null },
    )
    const tip = await chain.head()
    if (tip === null) throw new Error("the 50-event fixture has no tip")
    const eventIds = new Set(written.events.map((event) => event.id))
    // Optional named-ref transport may fetch a same-prefix neighbor into its
    // private cache. That must not select or walk the neighbor's malformed chain.
    await (
      await openEvents({ ...store, ref: ref + "-lookalike" })
    ).append([changeInput("ignored", { queueTip, at: times[0]!, by: "@dev/10", reason: "not the selected chain" })], {
      expect: null,
    })
    const tracePath = join(work, "markdown-git-trace.jsonl")
    const previousTrace = process.env.GIT_TRACE2_EVENT
    let read: Ran
    try {
      process.env.GIT_TRACE2_EVENT = tracePath
      read = await yrd(work, "queue", "show", branch, "--markdown")
    } finally {
      if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT
      else process.env.GIT_TRACE2_EVENT = previousTrace
    }
    const commands = readFileSync(tracePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; argv?: string[] })
      .filter((entry) => entry.event === "start" && entry.argv !== undefined)
      .map((entry) => entry.argv ?? [])
    const fetches = commands.filter((args) => args.includes("fetch"))
    expect(fetches, JSON.stringify(commands)).toHaveLength(1)
    expect(fetches[0]?.join(" ")).toContain(ref)
    expect(fetches[0]?.join(" ")).toContain(`refs/yrd-archive/main/${branch}`)
    expect(fetches[0]?.join(" ")).not.toContain("+refs/yrd/main/changes/*")
    expect(fetches[0]?.join(" ")).not.toContain("+refs/yrd-archive/main/*")
    const historyReads = commands.filter((args) => args.includes("--first-parent") && args.includes("--max-count=52"))
    expect(historyReads, JSON.stringify(commands)).toHaveLength(1)
    expect(
      commands.filter((args) => args.some((arg) => eventIds.has(arg))),
      JSON.stringify(commands),
    ).toHaveLength(0)
    expect(read.exitCode, read.report).toBe(0)
    expect(read.stderr, read.report).toBe("")
    const expectedMarkdown = readFileSync(new URL("./fixtures/queue-show-markdown.md", import.meta.url), "utf8")
      .replaceAll("{{HEAD}}", head).replaceAll("{{TIP}}", tip)
    expect(read.stdout).toBe(expectedMarkdown)
    const blocks = [...read.stdout.matchAll(/```json\n([\s\S]*?)\n```/gu)].map((match) => JSON.parse(match[1]!))
    expect(blocks).toEqual([
      { branch, ref, tip, complete: true, events: 50, maxEvents: 50 },
      [
        {
          branch,
          head,
          state: "cancelled",
          format: "event",
          submitter: "@dev/10",
          since: times[2]!.toISOString(),
          at: times[3]!.toISOString(),
          endedAt: times[3]!.toISOString(),
          reason: "withdrawn",
        },
        {
          branch,
          head,
          state: "failed",
          format: "event",
          submitter: "@dev/10",
          since: times[0]!.toISOString(),
          at: times[1]!.toISOString(),
          endedAt: times[1]!.toISOString(),
          reason,
        },
      ],
    ])
    expect(read.stdout.startsWith("# Yrd change history\n\n")).toBe(true)
    expect(read.stdout).not.toContain("Source:")
    expect(read.stdout).not.toContain("lookalike")
    expect(await chain.head()).toBe(tip)
    for (const args of [
      ["--markdown"],
      [branch, "--markdown", "--json"],
      [branch, "--markdown", "--all"],
      [branch, "--markdown", "--project-root", work],
    ]) {
      const incompatible = await yrd(work, "queue", "show", ...args)
      expect(incompatible.exitCode, incompatible.report).toBe(2)
      expect(incompatible.stdout).toBe("")
      expect(incompatible.stderr).toContain("queue show --markdown requires one branch")
    }
    const missing = await yrd(work, "queue", "show", "task/missing", "--markdown")
    expect(missing.exitCode, missing.report).not.toBe(0)
    expect(missing.stdout).toBe("")
    expect(missing.stderr).toContain("no event history for task/missing")
    const active = await yrd(work, "queue", "show", "task/two", "--markdown")
    expect(active.exitCode, active.report).toBe(0)
    const activeBlocks = [...active.stdout.matchAll(/```json\n([\s\S]*?)\n```/gu)].map((match) => JSON.parse(match[1]!))
    expect(activeBlocks[1]).toEqual([expect.objectContaining({ state: "queued" })])
    expect(activeBlocks[1]).toEqual([expect.not.objectContaining({ position: expect.anything() })])
    const invalidRef = changesRef("main", "task/invalid")
    await (
      await openEvents({ ...store, ref: invalidRef })
    ).append([changeInput("ignored", { queueTip, at: times[0]!, by: "@dev/10", reason: "invalid root fixture" })], {
      expect: null,
    })
    const invalid = await yrd(work, "queue", "show", "task/invalid", "--markdown")
    expect(invalid.exitCode, invalid.report).not.toBe(0)
    expect(invalid.stdout).toBe("")
    expect(invalid.stderr).toContain(invalidRef)
    expect(invalid.stderr).toContain("yrd-ignore-change-ended:")
    await chain.append(
      [changeInput("retained", { queueTip, at: times[3]!, commit: head, by: "@dev/10", reason: "overflow fixture" })],
      { expect: tip },
    )
    const overflow = await yrd(work, "queue", "show", branch, "--markdown")
    expect(overflow.exitCode, overflow.report).not.toBe(0)
    expect(overflow.stdout).toBe("")
    expect(overflow.stderr).toContain("event history exceeds maxEvents=50")
  })

  it("reports list's line position where it reads the line, and none where it reads one branch", async () => {
    const work = await queueWithTwoChanges()

    const list = await yrd(work, "queue", "list", "--json")
    expect(list.exitCode, list.report).toBe(0)
    expect(positions(list), list.report).toEqual({ "task/one": 1, "task/two": 2 })

    // `show --all` folds every change chain, so it knows the line and must agree with list.
    const all = await yrd(work, "queue", "show", "--all", "--json")
    expect(all.exitCode, all.report).toBe(0)
    expect(positions(all), all.report).toEqual(positions(list))

    // `show <branch>` folds one branch. It has no line to place the change in, so
    // `position` — "1-based place in line, absent otherwise" — must be absent, never
    // the constant 1 its one-element in-line set used to yield.
    for (const [branch, position] of Object.entries({ "task/one": 1, "task/two": 2 })) {
      const show = await yrd(work, "queue", "show", branch, "--json")
      expect(show.exitCode, show.report).toBe(0)
      const parsed = JSON.parse(show.stdout) as { changes: readonly Change[] }
      expect(
        parsed.changes.map((change) => change.branch),
        show.report,
      ).toContain(branch)
      expect(positions(show), show.report).toEqual({})
      expect(
        parsed.changes.every((change) => change.position === undefined),
        show.report,
      ).toBe(true)
      expect(positions(list)[branch], list.report).toBe(position)
    }
  })
})
