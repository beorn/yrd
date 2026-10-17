/**
 * @failure  `yrd withdraw <branch> --notify <seat>` records the notified seat as
 *           the change's canceller instead of the actor who ran the command
 *           (27262). Withdraw/drop expose only `--notify`, so it fills `By:`,
 *           and a reader of the cancelled record names the wrong seat.
 * @level    l2 (the public CLI, real worktrees, real queue refs)
 * @consumer the operator or agent ending a change, and every reader of the
 *           cancelled record (`yrd queue show`, bead close, the /yrd skill)
 * @testonly none
 */
import { permitCensus } from "./support/permit-census.ts"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { createEventStore, readStatus, submit, writeQueueEvent } from "@yrd/queue-core"
import * as removely from "removely"
import { archiveRefFor } from "git-super/archive-ref"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { birthEventQueue } from "./support/event-queue-birth.ts"
import { runYrdProcess } from "../src/cli.ts"
import { coreQueueCommand } from "../src/queue-core-commands.ts"
import { workdirOf } from "../src/workdir.ts"
import type { YrdCliExitCode, YrdCliIO } from "../src/types.ts"

// Standalone CI imports removely as native ESM; spies need a mutable facade over its real exports.
vi.mock("removely", async (original) => ({ ...(await original<typeof import("removely")>()) }))

const emptyCwds: Awaited<ReturnType<typeof removely.inspectProcessCwds>> = {
  complete: true,
  unreadable: [],
  mechanism: "proc",
  rows: [],
}

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

const previousSubmitter = process.env["YRD_DEFAULT_SUBMITTER"]

afterEach(() => {
  if (previousSubmitter === undefined) delete process.env["YRD_DEFAULT_SUBMITTER"]
  else process.env["YRD_DEFAULT_SUBMITTER"] = previousSubmitter
})

type Ran = Readonly<{ exitCode: YrdCliExitCode; stdout: string; stderr: string; report: string }>

/** One service round: unlike a manual queue run, the service respects the pause. */
async function serviceRound(cwd: string): Promise<string> {
  const stop = new AbortController()
  let stderr = ""
  const code = await coreQueueCommand(
    cwd,
    {
      localBranchProtections: null,
      color: false,
      cwd,
      stdout() {},
      stderr(text) {
        stderr += text
      },
    },
    { command: "up", intervalSeconds: 0, stop: stop.signal, afterRound: () => stop.abort() },
    {
      json: true,
      workdir: await workdirOf(gitIn(cwd), { cwd }),
    },
  )
  expect(code, stderr).toBe(0)
  return stderr
}

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

/** A bare remote whose `main` declares the queue, a clone of it, and one change per named branch. */
async function queueWithChanges(...branches: readonly string[]): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-withdraw-attribution-"))
  roots.push(root)
  const seed = gitIn(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work tree's")
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
  await birthEventQueue(work, "main", { localStore: false })
  for (const branch of branches) {
    await git(["checkout", "--quiet", "-b", branch, "main"])
    writeFileSync(join(work, "pass.txt"), `${branch}\n`)
    await git(["add", "."])
    await git(["commit", "--quiet", "-m", `${branch} does its work`])
    await git(["checkout", "--quiet", "main"])
    await submit(git, "origin", { branch, submitter: "@dev/submitter", target: { branch: "main", remote: "origin" } })
  }
  mkdirSync(join(root, "queue"), { recursive: true })
  return work
}

/** The `By:` and `Recipient:` the cancelled record carries, read back through `yrd queue show`. */
async function cancelledRecord(
  work: string,
  branch: string,
): Promise<Readonly<{ by?: string; recipient?: string; reason?: string }>> {
  const shown = await yrd(work, "queue", "show", branch, "--json")
  expect(shown.exitCode, shown.report).toBe(0)
  const parsed = JSON.parse(shown.stdout) as {
    changes: readonly {
      branch: string
      events: readonly { type: string; props: readonly (readonly [string, string])[] }[]
    }[]
  }
  const change = parsed.changes.find((row) => row.branch === branch)
  const cancelled = change?.events.findLast((event) => event.type === "cancelled")
  const prop = (key: string): string | undefined => cancelled?.props.find(([name]) => name === key)?.[1]
  return { by: prop("By"), recipient: prop("Recipient"), reason: prop("Reason") }
}

describe("`yrd withdraw` records the actor, not the notified seat (27262)", () => {
  // 29399: ending a change does not prove that a surviving origin branch has dated custody.
  // The existing drop cases allow event custody alone; withdrawal cannot retire an ended change.
  it("retires merged and cancelled origin branches archive-first without replacing their endings", async () => {
    const merged = "task/retire-merged'quoted"
    const cancelled = "task/retire-cancelled"
    const work = await queueWithChanges(merged, cancelled)
    const git = gitIn(work)
    const heads = new Map(
      await Promise.all(
        [merged, cancelled].map(async (branch) => [branch, (await git(["rev-parse", branch])).trim()] as const),
      ),
    )
    const withdrawn = await yrd(work, "withdraw", cancelled, "--submitter", "@dev/withdrawer", "--json")
    expect(withdrawn.exitCode, withdrawn.report).toBe(0)
    const landed = await yrd(work, "queue", "run", "--json")
    expect(landed.exitCode, landed.report).toBe(0)

    for (const [branch, status] of [
      [merged, "merged"],
      [cancelled, "cancelled"],
    ] as const) {
      const head = heads.get(branch)
      if (head === undefined) throw new Error(`fixture has no captured head for ${branch}`)
      // Recreate only the remote pointer: its queue history remains ended.
      await git(["push", "--quiet", "origin", `${head}:refs/heads/${branch}`])
      const store = createEventStore(work, "origin", git.selection, git.backend)
      const before = await readStatus(store, "main", branch)
      expect(before.status).toBe(status)
      const archive = `refs/archive/${new Date().toISOString().slice(0, 10)}/dev-retirer/${branch}`
      expect((await git(["ls-remote", "origin", archive])).trim()).toBe("")
      // 29721: copying the hint must preserve standalone authority, cwd and shell
      // arguments. The previous direct argv call could not detect a broken recipe.
      const ended = await yrd(work, "withdraw", branch)
      expect(ended.exitCode, ended.report).toBe(1)
      const printed = ended.stderr.split("retire it with: ")[1]?.trim()
      expect(printed, ended.report).toBeDefined()
      // Supply the two values the operator is asked to fill, then execute the
      // recipe verbatim through the actual standalone entry, outside any repo.
      const command = printed!
        .replace(/'?<observed-full-oid>'?/u, head)
        .replace(/'?<why>'?/u, "retire-ended-pointer")
      const retired = spawnSync("sh", ["-c", command], {
        cwd: dirname(work),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${resolve(import.meta.dirname, "../../../bin")}${delimiter}${process.env["PATH"] ?? ""}`,
          YRD_DEFAULT_SUBMITTER: "@dev/retirer",
        },
      })
      expect(retired.status, `${retired.stdout}\n${retired.stderr}`).toBe(0)
      expect((await git(["ls-remote", "origin", archive])).trim()).toBe(`${head}\t${archive}`)
      expect((await git(["ls-remote", "origin", `refs/heads/${branch}`])).trim()).toBe("")
      const after = await readStatus(store, "main", branch)
      expect(after.tip).toBe(before.tip)
      expect(after.status).toBe(before.status)
      expect(after.reason).toBe(before.reason)
    }
  })

  // AC3: a reopened change must keep its job even when HEAD is unchanged. The existing
  // advanced-head controls cannot catch a re-submit between filing and consuming the close request.
  it("keeps a withdrawn job reopened at the same head before its close request is consumed", async () => {
    const branch = "task/reopened"
    const work = await queueWithChanges(branch)
    const git = gitIn(work)
    const head = (await git(["rev-parse", `refs/heads/${branch}`])).trim()
    const opened = await yrd(work, "env", "open", "--bay", "reopened", "--json")
    expect(opened.exitCode, opened.report).toBe(0)
    const environment = JSON.parse(opened.stdout) as { path: string }
    const census = vi.spyOn(removely, "inspectProcessCwds").mockResolvedValue(emptyCwds)
    try {
      const ran = await yrd(work, "withdraw", branch, "--submitter", "@dev/actor", "--json")
      expect(ran.exitCode, ran.report).toBe(0)
      expect(existsSync(environment.path), ran.report).toBe(true)
      await submit(git, "origin", {
        branch,
        submitter: "@dev/submitter",
        target: { branch: "main", remote: "origin" },
      })
      await writeQueueEvent(createEventStore(work, "origin", git.selection, git.backend), "main", {
        type: "paused",
        at: new Date(),
        by: "@chief",
        reason: "inspect reopened job",
      })
      await serviceRound(work)
      const current = await readStatus(createEventStore(work, "origin", git.selection, git.backend), "main", branch)
      expect(current, ran.report).toMatchObject({ status: "queued", commit: head })
      expect(existsSync(environment.path), ran.report).toBe(true)
      expect((await git(["rev-parse", `refs/heads/${branch}`])).trim()).toBe(head)
    } finally {
      census.mockRestore()
    }
  })

  it("names `--submitter` as the actor while `--notify` names another seat", async () => {
    using _census = (await permitCensus()).spy
    using _cwds = vi.spyOn(removely, "inspectProcessCwds").mockResolvedValue(emptyCwds)
    // AC2: recovery must preserve the original change name, including shell quotes.
    // The former generic git/head assertions accepted a newly named change instead.
    const branch = "task/one'quoted"
    const work = await queueWithChanges(branch, "task/on-main", "task/archive-collision")
    const git = gitIn(work)
    const head = (await git(["rev-parse", `refs/heads/${branch}`])).trim()
    // AC2: the public ending must release its exact job, not only its remote ref.
    const opened = await yrd(work, "env", "open", "--bay", "one'quoted", "--json")
    expect(opened.exitCode, opened.report).toBe(0)
    const environment = JSON.parse(opened.stdout) as { path: string }
    expect(existsSync(environment.path)).toBe(true)
    expect((await gitIn(environment.path)(["rev-parse", "HEAD"])).trim()).toBe(head)

    const ran = await yrd(
      work,
      "withdraw",
      branch,
      "--submitter",
      "@dev/actor",
      "--notify",
      "@dev/notified",
      "--reason",
      "the actor ends it",
      "--json",
    )
    expect(ran.exitCode, ran.report).toBe(0)

    const record = await cancelledRecord(work, branch)
    expect(record.by, ran.report).toBe("@dev/actor")
    expect(record.by, ran.report).not.toBe("@dev/notified")
    // AC2: ending attribution alone missed the branch and unique work left behind.
    expect(record.reason, ran.report).toBe("withdrawn")
    const archives = (await git(["ls-remote", "origin", "refs/archive/*"])).trim().split("\n").filter(Boolean)
    expect(archives, ran.report).toHaveLength(1)
    const [archivedHead, archiveRef] = archives[0]!.split(/\s+/u)
    expect(archivedHead).toBe(head)
    expect((await git(["ls-remote", "origin", `refs/heads/${branch}`])).trim()).toBe("")
    const receipt = JSON.parse(ran.stdout) as {
      withdrawn: readonly { archive?: string; recovery?: string; remoteRemoved: boolean }[]
    }
    expect(receipt.withdrawn[0]?.archive).toBe(archiveRef)
    expect(receipt.withdrawn[0]?.recovery).toBe(`git branch 'task/one'\\''quoted' ${head}`)
    expect(existsSync(environment.path), ran.report).toBe(true)
    await writeQueueEvent(createEventStore(work, "origin", git.selection, git.backend), "main", {
      type: "paused",
      at: new Date(),
      by: "@chief",
      reason: "consume only terminal requests",
    })
    const cleanup = await serviceRound(work)
    expect(existsSync(environment.path), cleanup).toBe(false)
    expect((await git(["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`])).trim()).toBe("")

    // Published-main custody needs no extra archive ref.
    await git(["merge", "--quiet", "--ff-only", "task/on-main"])
    await git(["push", "--quiet", "origin", "main"])
    const onMain = await yrd(work, "withdraw", "task/on-main", "--submitter", "@dev/actor", "--json")
    expect(onMain.exitCode, onMain.report).toBe(0)
    expect((JSON.parse(onMain.stdout) as typeof receipt).withdrawn[0]?.archive).toBeUndefined()
    expect((await git(["ls-remote", "origin", "refs/archive/*"])).trim().split("\n")).toHaveLength(1)
    expect((await git(["ls-remote", "origin", "refs/heads/task/on-main"])).trim()).toBe("")

    // A custody collision keeps the branch while the explicit withdrawal still succeeds.
    const collisionHead = (await git(["rev-parse", "refs/heads/task/archive-collision"])).trim()
    const collisionArchive = archiveRefFor(
      "task/archive-collision",
      "@dev/actor",
      new Date().toISOString().slice(0, 10),
    )
    await git(["push", "--quiet", "origin", `main:${collisionArchive}`])
    const collision = await yrd(work, "withdraw", "task/archive-collision", "--submitter", "@dev/actor", "--json")
    expect(collision.exitCode, collision.report).toBe(0)
    expect((await cancelledRecord(work, "task/archive-collision")).reason).toBe("withdrawn")
    expect((await git(["ls-remote", "origin", "refs/heads/task/archive-collision"])).trim()).toContain(collisionHead)
    expect(collision.stderr).toContain(collisionArchive)
    expect(collision.stderr).toContain(collisionHead)
    expect((JSON.parse(collision.stdout) as typeof receipt).withdrawn[0]?.remoteRemoved).toBe(false)
  })

  // @cto 5753a5ce: the separate fact is the optional `Recipient:` trailer, a
  // recorded coordination target — never delivery proof (manual withdraw sends
  // no notice, README).
  it("records the notified seat separately from the actor", async () => {
    const work = await queueWithChanges("task/three")

    const ran = await yrd(
      work,
      "withdraw",
      "task/three",
      "--submitter",
      "@dev/actor",
      "--notify",
      "@dev/notified",
      "--reason",
      "the notified seat is separate",
      "--json",
    )
    expect(ran.exitCode, ran.report).toBe(0)

    const record = await cancelledRecord(work, "task/three")
    expect(record.by, ran.report).toBe("@dev/actor")
    expect(record.recipient, ran.report).toBe("@dev/notified")
  })

  it("takes the actor from YRD_DEFAULT_SUBMITTER when `--notify` names another seat", async () => {
    const work = await queueWithChanges("task/two")
    process.env["YRD_DEFAULT_SUBMITTER"] = "@dev/env-actor"

    const ran = await yrd(
      work,
      "withdraw",
      "task/two",
      "--notify",
      "@dev/notified",
      "--reason",
      "env actor ends it",
      "--json",
    )
    expect(ran.exitCode, ran.report).toBe(0)

    const record = await cancelledRecord(work, "task/two")
    expect(record.by, ran.report).toBe("@dev/env-actor")
    expect(record.by, ran.report).not.toBe("@dev/notified")
  })

  // @dev/11 27262 HOLD fba7572b: withdraw rows never traverse drop's parsing, so
  // the drop path needs its own row. `drop` carried its own option table with no
  // --submitter and a --notify help that named the actor.
  it("`yrd drop` names `--submitter` as the actor while `--notify` names another seat", async () => {
    const work = await queueWithChanges("task/four")

    const ran = await yrd(
      work,
      "drop",
      "task/four",
      "--submitter",
      "@dev/drop-actor",
      "--notify",
      "@dev/drop-notified",
      "--reason",
      "the actor drops it",
      "--json",
    )
    expect(ran.exitCode, ran.report).toBe(0)

    const record = await cancelledRecord(work, "task/four")
    expect(record.by, ran.report).toBe("@dev/drop-actor")
    expect(record.by, ran.report).not.toBe("@dev/drop-notified")
    expect(record.recipient, ran.report).toBe("@dev/drop-notified")
  })
})
