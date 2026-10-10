/**
 * @failure  `yrd logs prune` journaled its one observation row as a run-shaped
 *           `logs/q-<utc>-<id>.jsonl` carrying no run header, so the runner's own
 *           facts read (readRunnerFacts -> readRunHeader) refused the newest
 *           journal and the queue's read came back unread (28499, chief 7c29e0cf).
 *           The row belongs BESIDE the run journals, never among them.
 * @level    l1
 * @consumer the yrd runner/health read of a queue workdir
 * @reach    fs-walk <fixture-only: a temporary repository and its queue workdir; no CODE checkout is walked>
 * @testonly none
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { safeRemoveSync } from "removely"
import { afterAll, describe, expect, it } from "vitest"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { runYrdProcess } from "../src/cli.ts"
import { readRunnerFacts } from "../src/watch-runner.ts"
import { workdirOf } from "../src/workdir.ts"
import { birthEventQueue } from "./support/event-queue-birth.ts"
import type { YrdCliExitCode, YrdCliIO } from "../src/types.ts"

const roots: string[] = []

afterAll(() => {
  for (const root of roots) safeRemoveSync(root, { within: realpathSync(tmpdir()), allowMissing: true })
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

/** A declared queue whose log tree holds one expired round directory to prune. */
async function queueWithAnExpiredRound(): Promise<Readonly<{ work: string; workdir: string; logs: string }>> {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-logs-prune-"))
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
  const workdir = await workdirOf(git, { cwd: work })
  const logs = join(workdir, "logs")
  mkdirSync(logs, { recursive: true })
  const expired = join(logs, "q-20260901T000000000Z-deadbeef")
  mkdirSync(join(expired, "git"), { recursive: true })
  writeFileSync(join(expired, "git", "1.stdout.bin"), "x")
  return { work, workdir, logs }
}

describe("yrd logs prune journals its observation beside the run journals (28499)", () => {
  it("writes the row to <workdir>/retention.jsonl and mints no q-* run journal", async () => {
    const { work, workdir, logs } = await queueWithAnExpiredRound()

    const prune = await yrd(work, "logs", "prune", "--json")
    expect(prune.exitCode, prune.report).toBe(0)
    const reported = JSON.parse(prune.stdout) as { removed: number }
    expect(reported.removed, prune.report).toBe(1)

    // The run-journal namespace is untouched: every `logs/*.jsonl` is a run, and
    // a q-<utc>-<id> name with no run header is what the runner refused.
    expect(readdirSync(logs).filter((name) => name.endsWith(".jsonl"))).toEqual([])

    // The drain is still on record, in one file a reader opens without touching
    // a single round directory.
    const journal = join(workdir, "retention.jsonl")
    expect(existsSync(journal), journal).toBe(true)
    const rows = readFileSync(journal, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: "observation", scope: "log-retention", removed: 1, remaining: 0 })
    expect(rows[0]?.windowDays).toBe(7)

    // The reader the run-shaped name broke: the runner's own facts read.
    const facts = await readRunnerFacts(workdir)
    expect(facts.absent, JSON.stringify(facts)).toContain("it holds no run journal")
  })

  it("exits non-zero and names a round directory it cannot remove, and still says so in the row", async () => {
    const { work, workdir, logs } = await queueWithAnExpiredRound()
    const expired = join(logs, "q-20260901T000000000Z-deadbeef")
    // The queue round must SURVIVE a stuck directory (@cto 2026-10-10T23:16Z); the
    // operator's explicit drain is the one place it is a failure. A read-only
    // parent refuses the child's removal — a real EACCES, not a missing path.
    chmodSync(logs, 0o500)
    let prune: Ran
    try {
      prune = await yrd(work, "logs", "prune", "--json")
    } finally {
      chmodSync(logs, 0o700)
    }
    expect(prune.exitCode, prune.report).toBe(1)
    expect(prune.stderr).toContain(expired)
    expect(existsSync(expired), prune.report).toBe(true)
    const reported = JSON.parse(prune.stdout) as { failures: readonly { path: string }[] }
    expect(reported.failures.map((failure) => failure.path)).toEqual([expired])
    const rows = readFileSync(join(workdir, "retention.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(JSON.stringify(rows.at(-1)?.failures)).toContain(expired)
  })
})
