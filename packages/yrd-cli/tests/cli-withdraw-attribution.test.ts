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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import { submit } from "@yrd/queue-core"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { birthEventQueue } from "./support/event-queue-birth.ts"
import { runYrdProcess } from "../src/cli.ts"
import type { YrdCliExitCode, YrdCliIO } from "../src/types.ts"

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

/** The CLI as the shell runs it: argv in, exit code and both streams out. */
async function yrd(cwd: string, ...args: string[]): Promise<Ran> {
  let stdout = ""
  let stderr = ""
  const io: YrdCliIO = {
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
async function cancelledRecord(work: string, branch: string): Promise<Readonly<{ by?: string; recipient?: string }>> {
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
  return { by: prop("By"), recipient: prop("Recipient") }
}

describe("`yrd withdraw` records the actor, not the notified seat (27262)", () => {
  it("names `--submitter` as the actor while `--notify` names another seat", async () => {
    const work = await queueWithChanges("task/one")

    const ran = await yrd(
      work,
      "withdraw",
      "task/one",
      "--submitter",
      "@dev/actor",
      "--notify",
      "@dev/notified",
      "--reason",
      "the actor ends it",
      "--json",
    )
    expect(ran.exitCode, ran.report).toBe(0)

    const record = await cancelledRecord(work, "task/one")
    expect(record.by, ran.report).toBe("@dev/actor")
    expect(record.by, ran.report).not.toBe("@dev/notified")
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
