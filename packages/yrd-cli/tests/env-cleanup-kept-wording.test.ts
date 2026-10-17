/**
 * @failure 29679 defects 1 and 2, from the 2026-10-16 Yrd garage logs:
 *   (1) a KEPT environment was described with an "Error: " prefix —
 *       `kept: Error: fresh: opened 2026-10-16T01:47:12.458Z` (round1-merge.log:112). The sweep uses
 *       `throw new Error(<keep reason>)` as control flow, and its catch stringified the Error, so a benign
 *       keep read as a failure. The reason text itself is unchanged; only the stringification is.
 *   (2) a close request that already STOOD was reported as `file-failed`
 *       (hand-start-1827.log:38) — nothing failed and nothing was written, the request simply already
 *       stood. It is a no-op that must name the standing request, never a failure.
 * @level   l2 (a real bare remote, real retained worktrees, real close-request files, a real open record)
 * @consumer the queue round's post-judgment environment cleanup
 * @reach   fs-walk <fixture-only: the registry, environment and close-request trees this fixture makes under the OS temp root>
 * @testonly none — the child-observation and census seams are module mocks (a namespace binding of an installed
 *           ESM package cannot be replaced by a spy in standalone CI); no production symbol exists for this test.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, it, vi } from "vitest"
import type { QueueConfig } from "@yrd/queue-core"
import { remoteUrl } from "@yrd/queue-core"
import { createEnvironmentCleanup } from "../src/env-cleanup.ts"
import { writeCloseRequest } from "../src/env-close-requests.ts"
import { writeEnvOpenRecord } from "../src/env-open-record.ts"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"

process.env.GIT_CONFIG_COUNT = "1"
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow"
process.env.GIT_CONFIG_VALUE_0 = "always"

// A spy cannot replace a binding of an installed ESM package's namespace in standalone CI, so the census seam
// is a module mock: complete and empty, so a row reaches its keep checks rather than the census ladder.
vi.mock("removely", async (importOriginal) => {
  const actual = await importOriginal<typeof import("removely")>()
  return {
    ...actual,
    inspectProcessCwds: vi.fn(async () => ({ mechanism: "proc", complete: true, rows: [], unreadable: [] })),
  }
})

// The close SUCCEEDS when it is reached: the subject here is what a round REPORTS, not the removal itself.
vi.mock("../src/env-commands.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/env-commands.ts")>()
  return {
    ...actual,
    closeEnvironment: vi.fn(async (path: string, _options: unknown, callIo: { stdout: (text: string) => void }) => {
      callIo.stdout(JSON.stringify({ closed: path }))
      return 0
    }),
  }
})

/** The ending reader is stubbed: this arm is about the wording of a filing, not about reading an event chain. */
const { readBranchHistory } = vi.hoisted(() => ({ readBranchHistory: vi.fn() }))
vi.mock("@yrd/queue-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@yrd/queue-core")>()
  return { ...actual, readBranchHistory }
})

const roots: string[] = []
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

/** Rows the sweep wrote to its journal: `scope: environment-cleanup` only. */
function cleanupRows(root: string, depth = 0): readonly Record<string, unknown>[] {
  if (depth > 12) return []
  const rows: Record<string, unknown>[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) rows.push(...cleanupRows(path, depth + 1))
    else if (entry.name.endsWith(".jsonl")) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.startsWith("{")) continue
        const row = JSON.parse(line) as Record<string, unknown>
        if (row.scope === "environment-cleanup") rows.push(row)
      }
    }
  }
  return rows
}

/**
 * A real bare remote, a clone of it, and one environment cut under the registry root the sweep reads —
 * `.bays/<name>` on branch `task/<name>`, which is the one shape `fileTerminalCloseRequests` accepts as
 * "opened for that branch". Its opening record is `lifetime: job` at `at`, so the row is fresh in the
 * general sweep and unlocked for the terminal filer.
 */
async function world(at: string): Promise<
  Readonly<{
    branch: string
    env: string
    git: ReturnType<typeof gitIn>
    head: string
    remote: string
    repo: string
    workdir: string
  }>
> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "yrd-cleanup-wording-")))
  roots.push(root)
  const seed = gitIn(root)
  const bare = join(root, "remote.git")
  const repo = join(root, "work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", bare])
  await seed(["clone", "--quiet", bare, repo])
  const git = gitIn(repo)
  await git(["config", "user.email", "cleanup@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(repo, "root.txt"), "root\n")
  await git(["add", "root.txt"])
  await git(["commit", "--quiet", "-m", "root"])
  await git(["push", "--quiet", "origin", "main"])
  await git(["remote", "set-head", "origin", "--auto"])

  const branch = "task/env-fresh"
  const env = join(repo, ".bays", "env-fresh")
  mkdirSync(join(repo, ".bays"), { recursive: true })
  await git(["worktree", "add", "--quiet", "-b", branch, env, "HEAD"])
  const head = (await git(["-C", env, "rev-parse", "HEAD"])).trim()
  const envGitDir = (await git(["-C", env, "rev-parse", "--absolute-git-dir"])).trim()
  writeEnvOpenRecord(envGitDir, { version: 1, lifetime: "job", at })

  const workdir = join(root, "queue")
  mkdirSync(workdir, { recursive: true })
  return { branch, env, git, head, remote: await remoteUrl(git, "origin"), repo, workdir }
}

function configFor(head: string): QueueConfig {
  return {
    target: { remote: "origin", branch: "main" },
    archiveAfter: "never",
    revertGuard: "observe",
    ignore: [],
    checks: [],
    notify: [],
    health: { stallAfterMs: 0, declared: false },
    blob: head,
  }
}

async function runRound(
  w: Awaited<ReturnType<typeof world>>,
  run: string,
  merged: readonly string[],
): Promise<readonly Record<string, unknown>[]> {
  readBranchHistory.mockResolvedValue({
    ref: `refs/yrd/changes/${w.branch}`,
    history: { state: { status: "merged", commit: w.head, tip: "b".repeat(40) }, events: [] },
  })
  await createEnvironmentCleanup()({
    repo: w.repo,
    git: w.git,
    config: configFor(w.head),
    workdir: w.workdir,
    io: { cwd: w.repo, stdout: () => {}, stderr: () => {} },
    selection: w.git.selection,
    outcome: { run, log: join(w.workdir, "journal.jsonl"), merged, target: w.head } as never,
  })
  return cleanupRows(w.workdir)
}

it("names a kept environment's keep reason without an Error: prefix", async () => {
  const at = new Date().toISOString()
  const w = await world(at)
  const rows = await runRound(w, "cleanup-kept-wording", [])

  const kept = rows.find((row) => row.result === "kept" && row.path === w.env)
  expect(kept, JSON.stringify(rows)).toBeDefined()
  // The reason TEXT is unchanged — `automaticKeep` returned exactly this for an environment inside its grace.
  expect(String(kept?.why)).toBe(`fresh: opened ${at}`)
  expect(String(kept?.why), "a keep is not a failure, so it carries no Error: prefix").not.toContain("Error: ")
  expect(existsSync(w.env), "the environment is kept, untouched").toBe(true)
})

it("reports a close request that already stands as a no-op naming it, never file-failed", async () => {
  const at = new Date().toISOString()
  const w = await world(at)
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error("this close-request arm needs a real unix uid")
  // A request for this path already stands — the same intent, recorded against an earlier ending event.
  const standing = writeCloseRequest(w.workdir, {
    name: "env-fresh",
    path: w.env,
    requester: "@dev/4",
    uid,
    at: "2026-10-16T21:25:42.050Z",
    predicate: "direct-admission",
    options: { noRehome: true },
    head: w.head,
    ending: { remote: w.remote, queue: "main", branch: w.branch, event: "a".repeat(40) },
  }).file
  expect(existsSync(standing), "the request stands before the round").toBe(true)

  const rows = await runRound(w, "cleanup-close-request-wording", [w.branch])

  expect(
    rows.filter((row) => row.result === "file-failed"),
    JSON.stringify(rows),
  ).toEqual([])
  const filed = rows.find((row) => row.result === "filed" && row.path === w.env)
  expect(filed, JSON.stringify(rows)).toBeDefined()
  expect(String(filed?.why)).toContain("close request already stood")
  expect(String(filed?.why), "the standing request is named by the file it stands in").toContain(standing)
  expect(String(filed?.why)).not.toContain("Error: ")
})
