/**
 * @failure 28661 C4: the merge-closes-bay cleanup that meets a close REFUSED to protect a private submodule
 *          store must skip that tree, name it once, and continue — dropping the request as "retired" would
 *          erase who asked for the close and wedge the cure.
 * @level   l2
 * @consumer the queue round's post-judgment environment cleanup
 * @reach   fs-walk <fixture-only: close-request and retained-environment directories the fixture makes under the OS temp root>
 * @testonly closeEnvironment is replaced by a stub that throws the wrapped refusal the real close produces
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as removely from "removely"
import { afterAll, expect, it, vi } from "vitest"
import { createEnvironmentCleanup } from "../src/env-cleanup.ts"
import { closeRequestFile, writeCloseRequest } from "../src/env-close-requests.ts"
import type { QueueConfig } from "@yrd/queue-core"
import { testGitIn } from "../../../tests/support/test-git-in.ts"

// Spies need a mutable facade when standalone CI loads removely as native ESM.
vi.mock("removely", async (original) => ({ ...(await original<typeof import("removely")>()) }))

// The REAL refusal class, wrapped exactly as `closeEnvironment` wraps a git-super failure it cannot rehome.
vi.mock("../src/env-commands.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/env-commands.ts")>()
  const { PrivateStoreRefusalError } = await import("git-super/worktree")
  return {
    ...actual,
    closeEnvironment: vi.fn(async () => {
      throw new Error(
        "environment could not close through git super worktree remove: worktree removal would destroy a private submodule store: vendor/secret (section vendor/secret) store <admin>/modules/vendor/secret, declared private at <head>; worktree preserved; take custody of each store first, then retry",
        { cause: new PrivateStoreRefusalError("worktree removal would destroy a private submodule store") },
      )
    }),
  }
})

const roots: string[] = []
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

/** A registry repo with one registered environment, and the round's workdir that holds its close request. */
async function world(): Promise<
  Readonly<{ env: string; git: ReturnType<typeof testGitIn>; head: string; repo: string; workdir: string }>
> {
  const root = mkdtempSync(join(tmpdir(), "yrd-cleanup-private-"))
  roots.push(root)
  const repo = join(root, "product")
  mkdirSync(repo, { recursive: true })
  const git = testGitIn(repo)
  await git(["init", "--quiet", "--initial-branch=main"])
  await git(["config", "user.email", "cleanup@yrd.test"])
  await git(["config", "user.name", "yrd"])
  writeFileSync(join(repo, "root.txt"), "root\n")
  await git(["add", "root.txt"])
  await git(["commit", "--quiet", "-m", "root"])
  // Under `.bays`, the root the registry sweeps: one of the three places environmentInventory reads.
  const env = join(repo, ".bays", "env-refused")
  mkdirSync(join(repo, ".bays"), { recursive: true })
  await git(["worktree", "add", "--quiet", "--detach", env, "HEAD"])
  const head = (await git(["rev-parse", "HEAD"])).trim()
  const workdir = join(root, "queue")
  mkdirSync(workdir, { recursive: true })
  return { env, git, head, repo, workdir }
}

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

it("keeps the close request standing and continues when a private store refuses the close", async () => {
  const w = await world()
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error("this cleanup case needs a real unix uid")
  const file = closeRequestFile(w.workdir, w.env)
  writeCloseRequest(w.workdir, {
    name: "env-refused",
    path: w.env,
    requester: "@dev/luna2",
    uid,
    at: new Date().toISOString(),
    predicate: "direct-admission",
    options: { noRehome: true },
    head: w.head,
  })
  expect(existsSync(file)).toBe(true)
  const log = join(w.workdir, "journal.jsonl")
  const cleanup = createEnvironmentCleanup()
  // The same-UID cwd census is a different refusal; this arm is about the private store. Certify it so the
  // close reaches the guard under test rather than the incomplete-census ladder.
  const census = vi
    .spyOn(removely, "inspectProcessCwds")
    .mockResolvedValue({ complete: true, unreadable: [], mechanism: "proc", rows: [] })

  // cleanupEnvironments reads config for the store/history it only touches on the sweep path; the refused
  // close is consumed before that, but the contract requires a config, so give it a minimal one.
  const config: QueueConfig = {
    target: { remote: "origin", branch: "main" },
    archiveAfter: "never",
    revertGuard: "observe",
    ignore: [],
    checks: [],
    notify: [],
    health: { stallAfterMs: 0, declared: false },
    blob: w.head,
  }
  await cleanup({
    repo: w.repo,
    git: w.git,
    config,
    workdir: w.workdir,
    io: {
      localBranchProtections: null,
      cwd: w.repo,
      stdout: () => {},
      stderr: () => {},
    },
    selection: w.git.selection,
    // Nothing merged in this round: the request already stands, as the merged-close filer leaves it.
    outcome: { run: "cleanup-private-store", log, merged: [] } as never,
  })

  // Skipped and NAMED, never retired: the tree stays, the request stays, and the round returns.
  expect(existsSync(w.env), "the refused environment is kept").toBe(true)
  expect(existsSync(file), "the close request a refused close must not erase").toBe(true)
  const rows = cleanupRows(w.workdir)
  const named = rows.find((row) => row.result === "kept")
  expect(named, JSON.stringify(rows)).toBeDefined()
  expect(String(named?.why)).toContain("private submodule store")
  expect(String(named?.why)).toContain("retried next round")
  census.mockRestore()
  expect(rows.some((row) => row.result === "retired")).toBe(false)
})
