/**
 * @failure 33170 (disk rule 3, operator yes 2026-11-10 12:34 PST): an environment whose issue closed WITHOUT its
 *   head landing on the target was never removed — the sweep's only route was exact-head ancestry — so /hh/var/wt
 *   kept every Refs-only, docs, decision and dropped issue's worktree forever. The route added here releases such an
 *   environment only when its recorded issue is closed or dropped AND its root commits are published, and it keeps
 *   (and names) every other case (@cto 1a7a3153 conditions 1-3, 6).
 * @level   l2 (a real bare remote, real worktrees, real open records; the issue provider and the close are seams)
 * @consumer the queue round's post-judgment environment cleanup
 * @reach   fs-walk <fixture-only: the registry, environment and journal trees this fixture makes under the OS temp root>
 * @testonly none — census, close, issue-read and child-process seams are module mocks, as in
 *           env-cleanup-kept-wording.test.ts.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeEach, expect, it, vi } from "vitest"
import type { QueueConfig } from "@yrd/queue-core"
import { createEnvironmentCleanup } from "../src/env-cleanup.ts"
import { closeEnvironment } from "../src/env-commands.ts"
import { readEnvIssueState } from "../src/env-issue-state.ts"
import { writeEnvOpenRecord } from "../src/env-open-record.ts"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"

process.env.GIT_CONFIG_COUNT = "1"
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow"
process.env.GIT_CONFIG_VALUE_0 = "always"

vi.mock("removely", async (importOriginal) => {
  const actual = await importOriginal<typeof import("removely")>()
  return {
    ...actual,
    inspectProcessCwds: vi.fn(async () => ({ mechanism: "proc", complete: true, rows: [], unreadable: [] })),
  }
})

// The close SUCCEEDS when reached: the subject is which environments the sweep decides to remove.
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

vi.mock("../src/env-issue-state.ts", () => ({ readEnvIssueState: vi.fn() }))

const { readBranchHistory } = vi.hoisted(() => ({ readBranchHistory: vi.fn() }))
vi.mock("@yrd/queue-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@yrd/queue-core")>()
  return { ...actual, readBranchHistory }
})

/**
 * The size read before a removal; `failPath` makes reading that environment's size fail so the row must read
 * "unknown", never 0. The failure starts inside the reader (a getter on the stat it gets back), because in this
 * harness a mock implementation that throws fails its test even when the error is caught.
 */
const sizeRead = vi.hoisted(() => ({ failPath: undefined as string | undefined }))
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  const lstat = (async (path: string, ...rest: unknown[]) => {
    if (sizeRead.failPath !== undefined && String(path) === sizeRead.failPath) {
      return {
        get blocks(): number {
          throw new Error("EACCES: permission denied, lstat")
        },
        isDirectory: () => false,
      }
    }
    return (actual.lstat as (...args: unknown[]) => Promise<unknown>)(path, ...rest)
  }) as typeof actual.lstat
  return { ...actual, lstat, default: { ...actual, lstat } }
})

const roots: string[] = []
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})
beforeEach(() => {
  sizeRead.failPath = undefined
  vi.mocked(closeEnvironment).mockClear()
  vi.mocked(readEnvIssueState).mockReset()
  readBranchHistory.mockResolvedValue({ ref: "refs/yrd/changes/none", history: undefined })
})

const ISSUE = "@i/10-yrd/33170-closing-an-issue-removes-its"
const OPENED = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()

function cleanupRows(root: string, run: string): readonly Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue
    for (const line of readFileSync(join(root, entry.name), "utf8").split("\n")) {
      if (!line.startsWith("{")) continue
      const row = JSON.parse(line) as Record<string, unknown>
      if (row.scope === "environment-cleanup" && row.run === run && typeof row.path === "string") rows.push(row)
    }
  }
  return rows
}

/**
 * A real bare remote and one environment `.bays/env-closed` on `task/env-closed`, one commit past `main` (so its
 * head is NOT on the target), opened two days ago (past the fresh grace) with `issue` recorded when given.
 */
async function world(options: Readonly<{ issue?: string; pushBranch: boolean }>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "yrd-cleanup-closed-issue-")))
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
  const target = (await git(["rev-parse", "HEAD"])).trim()

  const branch = "task/env-closed"
  const env = join(repo, ".bays", "env-closed")
  mkdirSync(join(repo, ".bays"), { recursive: true })
  await git(["worktree", "add", "--quiet", "-b", branch, env, "HEAD"])
  const envGit = gitIn(env)
  writeFileSync(join(env, "work.txt"), "unlanded work\n")
  await envGit(["add", "work.txt"])
  await envGit(["commit", "--quiet", "-m", "unlanded work"])
  if (options.pushBranch) await envGit(["push", "--quiet", "origin", branch])
  const head = (await envGit(["rev-parse", "HEAD"])).trim()
  const envGitDir = (await envGit(["rev-parse", "--absolute-git-dir"])).trim()
  writeEnvOpenRecord(envGitDir, {
    version: 1,
    lifetime: "job",
    at: OPENED,
    ...(options.issue === undefined ? {} : { issue: options.issue }),
  })
  const workdir = join(root, "queue")
  mkdirSync(workdir, { recursive: true })
  return { branch, env, envGit, git, head, repo, target, workdir }
}

function configFor(target: string): QueueConfig {
  return {
    target: { remote: "origin", branch: "main" },
    archiveAfter: "never",
    revertGuard: "observe",
    ignore: [],
    checks: [],
    notify: [],
    health: { stallAfterMs: 0, declared: false },
    blob: target,
  }
}

async function sweep(w: Awaited<ReturnType<typeof world>>, run: string) {
  await createEnvironmentCleanup()({
    repo: w.repo,
    git: w.git,
    config: configFor(w.target),
    workdir: w.workdir,
    io: { cwd: w.repo, localBranchProtections: null, stdout: () => {}, stderr: () => {} },
    selection: w.git.selection,
    outcome: { run, log: join(w.workdir, "journal.jsonl"), merged: [], target: w.target } as never,
  })
  const rows = cleanupRows(w.workdir, run).filter((row) => row.path === w.env)
  const closes = vi.mocked(closeEnvironment).mock.calls.filter((call) => call[0] === w.env)
  return { rows, closes }
}

it("an unlanded environment whose issue closed, with its branch published, is removed and its row names path, bytes and issue", async () => {
  const w = await world({ issue: ISSUE, pushBranch: true })
  vi.mocked(readEnvIssueState).mockResolvedValue({ kind: "closed", issue: ISSUE })
  const { rows, closes } = await sweep(w, "closed-published")
  expect(closes, JSON.stringify(rows)).toHaveLength(1)
  const closed = rows.find((row) => row.result === "closed")
  expect(closed, JSON.stringify(rows)).toMatchObject({ path: w.env, issue: ISSUE })
  expect(typeof closed?.bytes === "number" && closed.bytes > 0, JSON.stringify(closed)).toBe(true)
  expect(String(closed?.why)).toContain(`released by issue ${ISSUE} closed`)
  expect(vi.mocked(readEnvIssueState)).toHaveBeenCalledTimes(1)
  // The branch outlives the environment: a reopened issue adopts task/env-closed from the remote.
  expect((await w.git(["ls-remote", "--heads", "origin", w.branch])).trim()).toContain(w.head)
})

it("a dropped issue releases the same way", async () => {
  const w = await world({ issue: ISSUE, pushBranch: true })
  vi.mocked(readEnvIssueState).mockResolvedValue({ kind: "dropped", issue: ISSUE })
  const { rows, closes } = await sweep(w, "dropped-published")
  expect(closes, JSON.stringify(rows)).toHaveLength(1)
  expect(String(rows.find((row) => row.result === "closed")?.why)).toContain("dropped")
})

it("a closed issue whose head is on no remote is kept, naming the commit", async () => {
  const w = await world({ issue: ISSUE, pushBranch: false })
  vi.mocked(readEnvIssueState).mockResolvedValue({ kind: "closed", issue: ISSUE })
  const { rows, closes } = await sweep(w, "closed-unpublished")
  expect(closes).toEqual([])
  const kept = rows.find((row) => row.result === "kept")
  expect(String(kept?.why), JSON.stringify(rows)).toContain(`HEAD ${w.head} is on no remote`)
})

it("an open issue keeps the environment and says so", async () => {
  const w = await world({ issue: ISSUE, pushBranch: true })
  vi.mocked(readEnvIssueState).mockResolvedValue({
    kind: "keep",
    reason: `issue "${ISSUE}" is open, not closed or dropped`,
  })
  const { rows, closes } = await sweep(w, "open-issue")
  expect(closes).toEqual([])
  expect(String(rows.find((row) => row.result === "kept")?.why)).toContain("is open, not closed or dropped")
})

it("a provider failure keeps the environment with the provider's reason", async () => {
  const w = await world({ issue: ISSUE, pushBranch: true })
  vi.mocked(readEnvIssueState).mockResolvedValue({ kind: "keep", reason: `issue "${ISSUE}" state unreadable: boom` })
  const { rows, closes } = await sweep(w, "provider-failure")
  expect(closes).toEqual([])
  expect(String(rows.find((row) => row.result === "kept")?.why)).toContain("state unreadable: boom")
})

it("an environment whose open record names no issue is kept without any issue read", async () => {
  const w = await world({ pushBranch: true })
  const { rows, closes } = await sweep(w, "no-issue")
  expect(closes).toEqual([])
  expect(String(rows.find((row) => row.result === "kept")?.why)).toContain("names no issue")
  expect(vi.mocked(readEnvIssueState)).not.toHaveBeenCalled()
})

it("a closed issue never releases a held environment, and the issue is not even read", async () => {
  const w = await world({ issue: ISSUE, pushBranch: true })
  await w.git(["worktree", "lock", "--reason", "hand hold", w.env])
  vi.mocked(readEnvIssueState).mockResolvedValue({ kind: "closed", issue: ISSUE })
  const { rows, closes } = await sweep(w, "closed-held")
  expect(closes).toEqual([])
  expect(String(rows.find((row) => row.result === "kept")?.why)).toContain("held")
  expect(vi.mocked(readEnvIssueState)).not.toHaveBeenCalled()
})

it("untracked files that are not ignored keep a closed issue's environment as dirty", async () => {
  const w = await world({ issue: ISSUE, pushBranch: true })
  writeFileSync(join(w.env, "notes.txt"), "untracked\n")
  vi.mocked(readEnvIssueState).mockResolvedValue({ kind: "closed", issue: ISSUE })
  const { rows, closes } = await sweep(w, "closed-untracked")
  expect(closes, JSON.stringify(rows)).toEqual([])
  expect(String(rows.find((row) => row.result === "kept")?.why)).toContain("dirty")
  expect(vi.mocked(readEnvIssueState)).not.toHaveBeenCalled()
})

it("a size that cannot be read is named unknown, never 0, and the removal still happens", async () => {
  const w = await world({ issue: ISSUE, pushBranch: true })
  vi.mocked(readEnvIssueState).mockResolvedValue({ kind: "closed", issue: ISSUE })
  sizeRead.failPath = w.env
  const { rows, closes } = await sweep(w, "closed-size-unknown")
  expect(closes).toHaveLength(1)
  expect(rows.find((row) => row.result === "closed")?.bytes, JSON.stringify(rows)).toBe("unknown")
})
