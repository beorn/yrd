/**
 * @failure 28836: cleanup's close-request batch takes the first ENVIRONMENT_BATCH files and skips unreadable ones
 *   without consuming them, so 8+ unreadable head files refill the batch every round and a valid later request is
 *   never consumed.
 * @failure 29587: newer lexical head requests overtake an older ninth request; equal times need a deterministic tie.
 * @level l2
 * @consumer the queue round's post-judgment environment cleanup
 * @reach fs-walk <fixture-only: close-request and environment directories the fixture makes under the OS temp root>
 * @testonly closeEnvironment is replaced by a success stub that emits the closed result on the caller's stdout
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import * as removely from "removely"
import { afterAll, expect, it, vi } from "vitest"
import { createEnvironmentCleanup } from "../src/env-cleanup.ts"
import { closeRequestFile, listCloseRequests, writeCloseRequest } from "../src/env-close-requests.ts"
import type { QueueConfig } from "@yrd/queue-core"
import { testGitIn } from "../../../tests/support/test-git-in.ts"

// Spies need a mutable facade when standalone CI loads removely as native ESM.
vi.mock("removely", async (original) => ({ ...(await original<typeof import("removely")>()) }))

// The close SUCCEEDS: the request is consumed, which is exactly what the unreadable head must not prevent.
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

const roots: string[] = []
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

/** A registry repo with one registered environment, and the round's workdir that holds its close request. */
async function world(): Promise<
  Readonly<{ env: string; git: ReturnType<typeof testGitIn>; head: string; repo: string; workdir: string }>
> {
  const root = mkdtempSync(join(tmpdir(), "yrd-cleanup-unreadable-head-"))
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
  const env = join(repo, ".bays", "env-valid")
  mkdirSync(join(repo, ".bays"), { recursive: true })
  await git(["worktree", "add", "--quiet", "--detach", env, "HEAD"])
  const head = (await git(["rev-parse", "HEAD"])).trim()
  const workdir = join(root, "queue")
  mkdirSync(workdir, { recursive: true })
  return { env, git, head, repo, workdir }
}

async function runRound(w: Awaited<ReturnType<typeof world>>, run: string): Promise<void> {
  const census = vi
    .spyOn(removely, "inspectProcessCwds")
    .mockResolvedValue({ complete: true, unreadable: [], mechanism: "proc", rows: [] })
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
  try {
    await createEnvironmentCleanup()({
      repo: w.repo,
      git: w.git,
      config,
      workdir: w.workdir,
      io: { cwd: w.repo, stdout: () => {}, stderr: () => {} },
      selection: w.git.selection,
      outcome: { run, log: join(w.workdir, "journal.jsonl"), merged: [] } as never,
    })
  } finally {
    census.mockRestore()
  }
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

it("reads past unreadable head requests and consumes a valid later request in one pass", async () => {
  const w = await world()
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error("this cleanup case needs a real unix uid")
  const valid = closeRequestFile(w.workdir, w.env)
  const requestsDir = dirname(valid)
  mkdirSync(requestsDir, { recursive: true })
  // Eight unreadable files sort before the valid request: the old slice(0, ENVIRONMENT_BATCH) would fill on them.
  for (let index = 0; index < 8; index++) {
    writeFileSync(join(requestsDir, `a-malformed-${index}.json`), "not json")
  }
  writeCloseRequest(w.workdir, {
    name: "env-valid",
    path: w.env,
    requester: "@dev/luna2",
    uid,
    at: new Date().toISOString(),
    predicate: "direct-admission",
    options: { noRehome: true },
    head: w.head,
  })
  expect(existsSync(valid)).toBe(true)
  // The premise the row rests on (28836 cto GO fold-in): the valid request must
  // sort AFTER the eight unreadable files, or a first-ENVIRONMENT_BATCH slice
  // would fill on them even on the old code and the row would prove nothing.
  expect(listCloseRequests(w.workdir).at(-1), "the valid request is the last sorted entry").toBe(valid)
  await runRound(w, "cleanup-unreadable-head")

  expect(existsSync(valid), "the valid later request is consumed in one pass").toBe(false)
  for (let index = 0; index < 8; index++) {
    expect(existsSync(join(requestsDir, `a-malformed-${index}.json`)), "an unreadable request stays standing").toBe(
      true,
    )
  }
  const rows = cleanupRows(w.workdir)
  expect(
    rows.some((row) => row.result === "closed"),
    JSON.stringify(rows),
  ).toBe(true)
})

it.each([
  { scenario: "oldest request beyond eight newer filenames", newerAt: "2026-10-15T00:00:01.000Z", olderFirst: true },
  { scenario: "filename tie-break for equal request times", newerAt: "2026-10-15T00:00:00.000Z", olderFirst: false },
])("closes one request using $scenario", async ({ newerAt, olderFirst }) => {
  const w = await world()
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error("this cleanup case needs a real unix uid")
  const request = (path: string, at: string) =>
    writeCloseRequest(w.workdir, {
      name: path.split("/").at(-1)!,
      path,
      requester: "@dev/2",
      uid,
      at,
      predicate: "direct-admission",
      options: { noRehome: true },
      head: w.head,
    }).file
  const older = request(w.env, "2026-10-15T00:00:00.000Z")
  const newer: string[] = []
  for (let index = 0; index < 8; index++) {
    const path = join(w.repo, ".bays", `a-newer-${index}`)
    await w.git(["worktree", "add", "--quiet", "--detach", path, "HEAD"])
    request(path, newerAt)
    newer.push(path)
  }
  // All eight newer names precede the old intent, so sorting only the selected batch cannot pass this case.
  expect(listCloseRequests(w.workdir).at(-1)).toBe(older)
  await runRound(w, "cleanup-request-order")
  const expected = olderFirst ? w.env : newer[0]!
  const closed = cleanupRows(w.workdir).filter((row) => row.result === "closed")
  expect(closed.map((row) => row.path)).toEqual([expected])
  expect(existsSync(closeRequestFile(w.workdir, expected))).toBe(false)
  expect(listCloseRequests(w.workdir)).toHaveLength(8)
})
