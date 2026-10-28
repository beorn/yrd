/**
 * @failure 29720 producer rows (@cto REVISE 0a8fd2a3 item 4): post-merge
 *   environment cleanup must hand each environment it actually closed to its
 *   caller exactly once, with the retained-removal proof, at BOTH close
 *   sites (the general sweep and a consumed close request) — and never for a
 *   kept or refused environment. A telling callback that throws is named
 *   (tell-failed) at the source and never undoes or rethrows the close.
 * @level   l2 (a real bare remote, real retained worktrees, real close-request files)
 * @consumer the queue round's post-judgment environment cleanup
 * @reach   fs-walk <fixture-only: the registry, environment and close-request trees this fixture makes under the OS temp root>
 * @testonly none — census and close seams are module mocks, as in env-cleanup-kept-wording.test.ts.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, writeFileSync } from "node:fs"
import { safeRemoveSync } from "removely"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, it, vi } from "vitest"
import type { QueueConfig } from "@yrd/queue-core"
import { remoteUrl } from "@yrd/queue-core"
import { createEnvironmentCleanup, type ClosedEnvironment } from "../src/env-cleanup.ts"
import { closeEnvironment } from "../src/env-commands.ts"
import { writeCloseRequest } from "../src/env-close-requests.ts"
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

const PROOF = {
  manifest: "/retained/env-fresh/manifest.json",
  retained: "/retained/env-fresh",
  retainUntil: "2026-10-24T00:00:00.000Z",
}

// The close succeeds and reports a retained-removal proof, as the native close does.
vi.mock("../src/env-commands.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/env-commands.ts")>()
  return {
    ...actual,
    closeEnvironment: vi.fn(
      async (
        path: string,
        _options: unknown,
        callIo: { stdout: (text: string) => void },
        _a?: unknown,
        _b?: unknown,
        beforeRemove?: () => Promise<void>,
        removedProof?: (proof: typeof PROOF) => void,
      ) => {
        await beforeRemove?.()
        removedProof?.(PROOF)
        callIo.stdout(JSON.stringify({ closed: path }))
        return 0
      },
    ),
  }
})

const { readBranchHistory } = vi.hoisted(() => ({ readBranchHistory: vi.fn() }))
vi.mock("@yrd/queue-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@yrd/queue-core")>()
  return { ...actual, readBranchHistory }
})

const roots: string[] = []
afterAll(() => {
  for (const root of roots.splice(0)) safeRemoveSync(root, { within: realpathSync(tmpdir()), allowMissing: true })
})

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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "yrd-cleanup-closed-tell-")))
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
  onEnvironmentClosed?: (closed: ClosedEnvironment) => Promise<void>,
  cwd = w.repo,
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
    io: { cwd, stdout: () => {}, stderr: () => {}, localBranchProtections: null },
    selection: w.git.selection,
    outcome: { run, log: join(w.workdir, "journal.jsonl"), merged, target: w.head } as never,
    ...(onEnvironmentClosed === undefined ? {} : { onEnvironmentClosed }),
  })
  return cleanupRows(w.workdir).filter((row) => row.run === run)
}

const OLD = "2026-01-01T00:00:00.000Z"

it("reports a sweep-closed environment once, with its proof, and never a kept one", async () => {
  const closed: ClosedEnvironment[] = []
  const tell = async (entry: ClosedEnvironment): Promise<void> => {
    closed.push(entry)
  }
  const w = await world(OLD)
  const landing = join(w.repo, "..", "service-landing")
  await w.git(["worktree", "add", "--quiet", "--detach", landing, "HEAD"])
  await w.git(["config", "worktree.poolRoot", join(w.repo, ".bays")])
  const rows = await runRound(w, "tell-sweep", [w.branch], tell, landing)
  expect(
    rows.some((row) => row.result === "closed" && row.path === w.env),
    JSON.stringify(rows),
  ).toBe(true)
  expect(closed, "the sweep close is reported exactly once").toHaveLength(1)
  expect(closed[0]?.path).toBe(w.env)
  expect(closed[0]?.branch).toBe(w.branch)
  expect(closed[0]?.proof?.manifest).toBe(PROOF.manifest)
  expect(closed[0]?.proof?.retainUntil).toBe(PROOF.retainUntil)
  const sweepClose = vi.mocked(closeEnvironment).mock.calls.findLast((call) => call[0] === w.env)
  expect(sweepClose?.[1]).toMatchObject({ componentCustody: { primaryRoot: w.repo, targetBranch: "main" } })

  const kept: ClosedEnvironment[] = []
  const fresh = await world(new Date().toISOString())
  await runRound(fresh, "tell-kept", [], async (entry) => {
    kept.push(entry)
  })
  expect(existsSync(fresh.env)).toBe(true)
  expect(kept, "a kept environment is never reported closed").toEqual([])
})

it.each([true, false])("reports a consumed close request only after its ending validates (%s)", async (valid) => {
  const closed: ClosedEnvironment[] = []
  const w = await world(new Date().toISOString())
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error("this close-request arm needs a real unix uid")
  writeCloseRequest(w.workdir, {
    name: "env-fresh",
    path: w.env,
    requester: "@dev/4",
    uid,
    at: "2026-10-16T21:25:42.050Z",
    intent: "close",
    predicate: "direct-admission",
    options: { noRehome: true },
    head: w.head,
    ending: { remote: w.remote, queue: "main", branch: w.branch, event: (valid ? "b" : "a").repeat(40) },
  })
  const rows = await runRound(w, "tell-request", [w.branch], async (entry) => {
    closed.push(entry)
  })
  if (!valid) {
    expect(closed).toEqual([])
    expect(existsSync(w.env)).toBe(true)
    expect(rows).toContainEqual(
      expect.objectContaining({ result: "retired", why: expect.stringContaining("automatic close expected") }),
    )
    return
  }
  expect(
    rows.some((row) => row.result === "closed" && row.path === w.env),
    JSON.stringify(rows),
  ).toBe(true)
  expect(closed, "the consumed close is reported exactly once").toHaveLength(1)
  expect(closed[0]?.branch).toBe(w.branch)
  expect(closed[0]?.head).toBe(w.head)
  expect(closed[0]?.proof?.manifest).toBe(PROOF.manifest)
  const requestClose = vi.mocked(closeEnvironment).mock.calls.findLast((call) => call[0] === w.env)
  expect(requestClose?.[1]).toMatchObject({ componentCustody: { primaryRoot: w.repo, targetBranch: "main" } })
})

it("a throwing tell at a consumed close request is named tell-failed and never undoes the close", async () => {
  const w = await world(new Date().toISOString())
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error("this close-request arm needs a real unix uid")
  writeCloseRequest(w.workdir, {
    name: "env-fresh",
    path: w.env,
    requester: "@dev/4",
    uid,
    at: "2026-10-16T21:25:42.050Z",
    intent: "close",
    predicate: "direct-admission",
    options: { noRehome: true },
    head: w.head,
    ending: { remote: w.remote, queue: "main", branch: w.branch, event: "b".repeat(40) },
  })
  const rows = await runRound(w, "tell-request-throws", [w.branch], async () => {
    throw new Error("fixture request tell boom")
  })
  expect(
    rows.some((row) => row.result === "closed" && row.path === w.env),
    JSON.stringify(rows),
  ).toBe(true)
  const failed = rows.find((row) => row.result === "tell-failed" && row.path === w.env)
  expect(failed, JSON.stringify(rows)).toBeDefined()
  expect(String(failed?.why)).toContain("telling about it failed: fixture request tell boom")
})

it("a throwing tell is named tell-failed and never undoes the close", async () => {
  const w = await world(OLD)
  const rows = await runRound(w, "tell-throws", [w.branch], async () => {
    throw new Error("fixture tell boom")
  })
  expect(
    rows.some((row) => row.result === "closed" && row.path === w.env),
    JSON.stringify(rows),
  ).toBe(true)
  const failed = rows.find((row) => row.result === "tell-failed" && row.path === w.env)
  expect(failed, JSON.stringify(rows)).toBeDefined()
  expect(String(failed?.why)).toContain("telling about it failed: fixture tell boom")
})

it("journals elapsed close time for independent request and sweep attempts", async () => {
  const w = await world(OLD)
  const sweepEnv = join(w.repo, ".bays", "sweep-env")
  await w.git(["worktree", "add", "--quiet", "-b", "task/sweep", sweepEnv, "HEAD"])
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error("this cleanup case needs a real unix uid")
  writeCloseRequest(w.workdir, {
    name: "env-fresh",
    path: w.env,
    requester: "@dev/4",
    uid,
    at: "2026-10-16T21:25:42.050Z",
    intent: "close",
    predicate: "direct-admission",
    options: { noRehome: true },
    head: w.head,
  })

  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-10-28T12:00:00.000Z"))
  vi.mocked(closeEnvironment).mockImplementation(async (path, _options, callIo) => {
    vi.setSystemTime(Date.now() + 17)
    callIo.stdout(JSON.stringify({ closed: path }))
    return 0
  })
  try {
    const rows = await runRound(w, "timed-independent-routes", [w.branch, "task/sweep"])
    expect(rows.find((row) => row.closed !== undefined && row.charged !== undefined)).toMatchObject({
      consumer: { attempted: 1, closed: 1 },
      sweep: { attempted: 1, closed: 1 },
    })
    const attempts = rows.filter((row) => row.result === "closed")
    expect(attempts.map((row) => row.path)).toEqual([w.env, sweepEnv])
    expect(attempts.map((row) => row.started_at)).toEqual(["2026-10-28T12:00:00.000Z", "2026-10-28T12:00:00.017Z"])
    expect(attempts.map((row) => row.elapsed_ms)).toEqual([17, 17])
  } finally {
    vi.useRealTimers()
    vi.mocked(closeEnvironment).mockImplementation(async (path, _options, callIo) => {
      callIo.stdout(JSON.stringify({ closed: path }))
      return 0
    })
  }
})
