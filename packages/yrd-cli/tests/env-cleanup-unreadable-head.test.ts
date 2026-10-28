/**
 * @failure 28836: cleanup's close-request batch takes the first ENVIRONMENT_BATCH files and skips unreadable ones
 *   without consuming them, so 8+ unreadable head files refill the batch every round and a valid later request is
 *   never consumed.
 * @failure 29587: newer lexical head requests overtake an older ninth request; equal times need a deterministic tie.
 * @failure 31184: each cleanup route gets one close attempt per invocation; stale/gone requests do not consume it,
 *   and request and sweep routes preserve independent progress across invocations.
 * @failure 31447: oldest-first put a seat's own close request behind every older automatic filing for an ended
 *   environment (rank 175 of 177 on 2026-10-28), so a seat waited hours for one attempt per round.
 * @level l2
 * @consumer the queue round's post-judgment environment cleanup
 * @reach fs-walk <fixture-only: close-request and environment directories the fixture makes under the OS temp root>
 * @testonly closeEnvironment is replaced by a success stub that emits the closed result on the caller's stdout
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import * as removely from "removely"
import { PrivateStoreRefusalError } from "git-super/worktree"
import { afterAll, expect, it, vi } from "vitest"
import { createEnvironmentCleanup } from "../src/env-cleanup.ts"
import { closeRequestFile, listCloseRequests, writeCloseRequest } from "../src/env-close-requests.ts"
import { closeEnvironment } from "../src/env-commands.ts"
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

const { readBranchHistory } = vi.hoisted(() => ({
  readBranchHistory: vi.fn(async () => ({ history: undefined })),
}))
vi.mock("@yrd/queue-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@yrd/queue-core")>()
  return { ...actual, readBranchHistory }
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
      io: {
        localBranchProtections: null,
        cwd: w.repo,
        stdout: () => {},
        stderr: () => {},
      },
      selection: w.git.selection,
      outcome: { run, log: join(w.workdir, "journal.jsonl"), merged: [], target: w.head } as never,
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
    intent: "close",
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
  const manualClose = vi.mocked(closeEnvironment).mock.calls.findLast((call) => call[0] === w.env)
  expect(manualClose?.[1], "a manual noRehome request has no automatic custody policy").not.toHaveProperty(
    "componentCustody",
  )

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
])("closes only the oldest request in order using $scenario", async ({ newerAt, olderFirst }) => {
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
      intent: "close",
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
  const expectedClosed = olderFirst ? [w.env] : [newer[0]!]
  const expectedStanding = olderFirst
    ? newer.map((path) => closeRequestFile(w.workdir, path))
    : [...newer.slice(1).map((path) => closeRequestFile(w.workdir, path)), older]
  // The independent sweep may close a different target; this is the request route's order and allowance.
  const closed = cleanupRows(w.workdir).filter((row) => row.result === "closed" && row.request !== undefined)
  expect(closed.map((row) => row.path)).toEqual(expectedClosed)
  for (const path of expectedClosed) {
    expect(existsSync(closeRequestFile(w.workdir, path))).toBe(false)
  }
  expect(listCloseRequests(w.workdir)).toEqual(expectedStanding)
})

it("attempts a seat's own request before older automatic filings, at the measured request times", async () => {
  const w = await world()
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error("this cleanup case needs a real unix uid")
  const request = (
    path: string,
    at: string,
    ending?: { remote: string; queue: string; branch: string; event: string },
  ) =>
    writeCloseRequest(w.workdir, {
      intent: "close",
      name: path.split("/").at(-1)!,
      path,
      requester: ending === undefined ? "@dev/luna5" : "unknown",
      uid,
      at,
      predicate: "direct-admission",
      options: { noRehome: true },
      head: w.head,
      ...(ending === undefined ? {} : { ending }),
    }).file
  // Measured 2026-10-28 12:00 PDT on the live queue workdir: the round's filings for ended environments stood from
  // 09:14:49.891Z; @dev/luna5's env close request was filed at 18:44:58.154Z with 167 automatic requests ahead.
  // Each `at` is that file's real write time (mtime minus at was 0 s for every automatic file), not a stale stamp.
  const automatic: string[] = []
  for (const [index, at] of ["2026-10-28T09:14:49.891Z", "2026-10-28T09:14:50.465Z"].entries()) {
    const path = join(w.repo, ".bays", `a-ended-${index}`)
    await w.git(["worktree", "add", "--quiet", "--detach", path, "HEAD"])
    automatic.push(
      request(path, at, { remote: "origin", queue: "main", branch: `task/ended-${index}`, event: "e".repeat(40) }),
    )
  }
  const seat = request(w.env, "2026-10-28T18:44:58.154Z")
  await runRound(w, "cleanup-seat-request-first")
  const closed = cleanupRows(w.workdir).filter((row) => row.result === "closed" && row.request !== undefined)
  expect(closed.map((row) => row.path)).toEqual([w.env])
  expect(existsSync(seat)).toBe(false)
  // Within the automatic class, oldest first still holds: both stand for later rounds.
  expect(listCloseRequests(w.workdir)).toEqual([...automatic].sort())
})

it("drops gone and stale requests without spending the one consumer close attempt", async () => {
  const w = await world()
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error("this cleanup case needs a real unix uid")
  const request = (path: string, at: string, head = w.head) =>
    writeCloseRequest(w.workdir, {
      name: path.split("/").at(-1)!,
      path,
      requester: "@dev/12",
      uid,
      at,
      intent: "close",
      predicate: "direct-admission",
      options: { noRehome: true },
      head,
    }).file

  for (let index = 0; index < 4; index++) {
    request(join(w.repo, ".bays", `a-gone-${index}`), `2026-10-15T00:00:00.00${index}Z`)
  }
  for (let index = 0; index < 2; index++) {
    const unregistered = join(w.repo, ".bays", `a-unregistered-${index}`)
    mkdirSync(unregistered, { recursive: true })
    request(unregistered, `2026-10-15T00:00:00.10${index}Z`)
  }
  for (let index = 0; index < 2; index++) {
    const staleHead = join(w.repo, ".bays", `a-stale-head-${index}`)
    await w.git(["worktree", "add", "--quiet", "--detach", staleHead, "HEAD"])
    request(staleHead, `2026-10-15T00:00:00.20${index}Z`, "0".repeat(40))
  }

  const valid = [w.env]
  for (let index = 1; index < 4; index++) {
    const path = join(w.repo, ".bays", `z-valid-${index}`)
    await w.git(["worktree", "add", "--quiet", "--detach", path, "HEAD"])
    valid.push(path)
  }
  for (const [index, path] of valid.entries()) {
    request(path, `2026-10-15T00:00:0${index + 1}.000Z`)
  }

  await runRound(w, "cleanup-uncharged-stale-head")
  const rows = cleanupRows(w.workdir)
  expect(rows.filter((row) => row.result === "already-removed")).toHaveLength(4)
  expect(rows.filter((row) => row.result === "stale")).toHaveLength(4)
  expect(rows.filter((row) => row.result === "closed" && row.request !== undefined).map((row) => row.path)).toEqual([
    valid[0],
  ])
  expect(listCloseRequests(w.workdir)).toEqual(valid.slice(1).map((path) => closeRequestFile(w.workdir, path)))
})

it("lets a kept consumer request leave the independent sweep close available for another environment", async () => {
  const w = await world()
  await w.git(["remote", "add", "origin", w.repo])
  await w.git(["fetch", "--quiet", "origin", "main"])
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error("this cleanup case needs a real unix uid")
  const eligible = join(w.repo, ".bays", "z-sweep-eligible")
  await w.git(["worktree", "add", "--quiet", "--detach", eligible, "HEAD"])
  writeCloseRequest(w.workdir, {
    name: "env-valid",
    path: w.env,
    requester: "@dev/12",
    uid,
    at: "2026-10-15T00:00:00.000Z",
    intent: "close",
    predicate: "direct-admission",
    options: { noRehome: true },
    head: w.head,
  })
  const attempts: string[] = []
  vi.mocked(closeEnvironment).mockImplementation(async (path, _options, callIo) => {
    attempts.push(path)
    if (path === w.env) {
      throw new Error("private store kept", {
        cause: new PrivateStoreRefusalError("worktree removal would destroy a private submodule store"),
      })
    }
    callIo.stdout(JSON.stringify({ closed: path }))
    return 0
  })
  try {
    await runRound(w, "kept-request-independent-sweep")
  } finally {
    vi.mocked(closeEnvironment).mockImplementation(async (path, _options, callIo) => {
      callIo.stdout(JSON.stringify({ closed: path }))
      return 0
    })
  }
  const rows = cleanupRows(w.workdir).filter((row) => row.run === "kept-request-independent-sweep")
  expect(attempts).toEqual([w.env, eligible])
  expect(rows.some((row) => row.result === "kept" && row.path === w.env)).toBe(true)
  expect(rows.some((row) => row.result === "closed" && row.path === eligible)).toBe(true)
  expect(rows.some((row) => row.result === "closed" && row.path === w.env)).toBe(false)
  expect(existsSync(closeRequestFile(w.workdir, w.env))).toBe(true)
})

it("counts a refused sweep close as its route attempt and resumes at the next eligible row", async () => {
  const w = await world()
  await w.git(["remote", "add", "origin", w.repo])
  await w.git(["fetch", "--quiet", "origin", "main"])
  const second = join(w.repo, ".bays", "z-second-sweep")
  await w.git(["worktree", "add", "--quiet", "-b", "task/second-sweep", second, "HEAD"])
  const attempts: string[] = []
  vi.mocked(closeEnvironment).mockImplementation(async (path, _options, callIo) => {
    attempts.push(path)
    if (path === w.env) {
      throw new Error("private store kept", {
        cause: new PrivateStoreRefusalError("worktree removal would destroy a private submodule store"),
      })
    }
    callIo.stdout(JSON.stringify({ closed: path }))
    return 0
  })
  try {
    await runRound(w, "sweep-refused-first")
    expect(attempts).toEqual([w.env])
    vi.mocked(closeEnvironment).mockImplementation(async (path, _options, callIo) => {
      attempts.push(path)
      callIo.stdout(JSON.stringify({ closed: path }))
      return 0
    })
    await runRound(w, "sweep-next-row")
  } finally {
    vi.mocked(closeEnvironment).mockImplementation(async (path, _options, callIo) => {
      callIo.stdout(JSON.stringify({ closed: path }))
      return 0
    })
  }
  expect(attempts).toEqual([w.env, second])
  const rows = cleanupRows(w.workdir)
  expect(rows.some((row) => row.run === "sweep-refused-first" && row.result === "kept" && row.path === w.env)).toBe(
    true,
  )
  expect(rows.some((row) => row.run === "sweep-refused-first" && row.result === "closed")).toBe(false)
  expect(rows.some((row) => row.run === "sweep-next-row" && row.result === "closed" && row.path === second)).toBe(true)
})

it("rechecks a pending request next round after its HEAD moves during the first close", async () => {
  const w = await world()
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error("this cleanup case needs a real unix uid")
  const request = (path: string, at: string) =>
    writeCloseRequest(w.workdir, {
      name: path.split("/").at(-1)!,
      path,
      requester: "@dev/12",
      uid,
      at,
      intent: "close",
      predicate: "direct-admission",
      options: { noRehome: true },
      head: w.head,
    }).file

  const second = join(w.repo, ".bays", "env-second-moved")
  await w.git(["worktree", "add", "--quiet", "--detach", second, "HEAD"])
  request(w.env, "2026-10-15T00:00:00.000Z")
  const secondFile = request(second, "2026-10-15T00:00:01.000Z")

  const attemptedPaths: string[] = []
  vi.mocked(closeEnvironment).mockImplementation(async (path, _options, callIo) => {
    attemptedPaths.push(path)
    if (path === w.env) {
      const secondGit = testGitIn(second)
      writeFileSync(join(second, "moved.txt"), "moved\n")
      await secondGit(["add", "moved.txt"])
      await secondGit(["commit", "--quiet", "-m", "moved during first close"])
    }
    callIo.stdout(JSON.stringify({ closed: path }))
    return 0
  })
  try {
    await runRound(w, "cleanup-refresh-inventory-per-attempt")
    await runRound(w, "cleanup-refresh-inventory-next-round")
  } finally {
    vi.mocked(closeEnvironment).mockImplementation(async (path, _options, callIo) => {
      callIo.stdout(JSON.stringify({ closed: path }))
      return 0
    })
  }

  const rows = cleanupRows(w.workdir)
  const staleRows = rows.filter((row) => row.result === "stale")
  expect(staleRows.map((row) => row.path)).toEqual([second])
  expect(String(staleRows[0]?.why)).toContain(`registered HEAD moved from ${w.head} to `)
  expect(existsSync(secondFile)).toBe(false)
  expect(attemptedPaths).not.toContain(second)
  expect(rows.filter((row) => row.result === "closed").map((row) => row.path)).toEqual([w.env])
})

it("gives consumer and sweep separate attempts while pending requests and the sweep cursor progress", async () => {
  const w = await world()
  await w.git(["remote", "add", "origin", w.repo])
  await w.git(["fetch", "--quiet", "origin", "main"])
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error("this cleanup case needs a real unix uid")
  const eligible = join(w.repo, ".bays", "z-eligible-unrecorded")
  await w.git(["worktree", "add", "--quiet", "--detach", eligible, "HEAD"])
  const secondEligible = join(w.repo, ".bays", "z-second-eligible")
  await w.git(["worktree", "add", "--quiet", "--detach", secondEligible, "HEAD"])
  const pending = join(w.repo, ".bays", "env-pending")
  await w.git(["worktree", "add", "--quiet", "--detach", pending, "HEAD"])
  writeCloseRequest(w.workdir, {
    name: "env-valid",
    path: w.env,
    requester: "@dev/12",
    uid,
    at: "2026-10-15T00:00:00.000Z",
    intent: "close",
    predicate: "direct-admission",
    options: { noRehome: true },
    head: w.head,
  })
  writeCloseRequest(w.workdir, {
    name: "env-pending",
    path: pending,
    requester: "@dev/12",
    uid,
    at: "2026-10-15T00:00:01.000Z",
    intent: "close",
    predicate: "direct-admission",
    options: { noRehome: true },
    head: w.head,
  })
  const cleanup = createEnvironmentCleanup()
  const runCleanupRound = async (run: string) => {
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
        outcome: { run, log: join(w.workdir, "journal.jsonl"), merged: [], target: w.head } as never,
      })
    } finally {
      census.mockRestore()
    }
  }
  // Point the persisted cursor directly at `z-eligible-unrecorded` before round 1.
  const statePath = join(w.workdir, "state", "yrd", "environment-cleanup.json")
  mkdirSync(dirname(statePath), { recursive: true })
  writeFileSync(
    statePath,
    `${JSON.stringify({
      cursorEnv: "z-eligible-unrecorded",
      runId: "seed",
      at: "2026-10-18T00:00:00.000Z",
      reported: {},
    })}\n`,
  )
  await runCleanupRound("round-1-closes-request")
  const stateAfterRound1 = JSON.parse(readFileSync(statePath, "utf8")) as {
    cursorEnv: string
    reported: Record<string, string>
  }
  expect(stateAfterRound1.cursorEnv).toBe("z-second-eligible")
  const round1Rows = cleanupRows(w.workdir).filter((row) => row.run === "round-1-closes-request")
  expect(round1Rows.filter((row) => row.result === "closed").map((row) => row.path)).toEqual([w.env, eligible])
  expect(listCloseRequests(w.workdir)).toEqual([closeRequestFile(w.workdir, pending)])

  await runCleanupRound("round-2-closes-eligible-unrecorded")
  const round2Rows = cleanupRows(w.workdir).filter((row) => row.run === "round-2-closes-eligible-unrecorded")
  expect(round2Rows.filter((row) => row.result === "closed").map((row) => row.path)).toEqual([pending, secondEligible])
  expect(listCloseRequests(w.workdir)).toEqual([])
})

it("stops the general sweep cursor on the second eligible row after one sweep removal", async () => {
  const w = await world()
  await w.git(["remote", "add", "origin", w.repo])
  await w.git(["fetch", "--quiet", "origin", "main"])
  const second = join(w.repo, ".bays", "z-second-eligible")
  await w.git(["worktree", "add", "--quiet", "--detach", second, "HEAD"])
  const third = join(w.repo, ".bays", "z-third-eligible")
  await w.git(["worktree", "add", "--quiet", "--detach", third, "HEAD"])

  await runRound(w, "sweep-stops-on-second-eligible")
  const rows = cleanupRows(w.workdir).filter((row) => row.run === "sweep-stops-on-second-eligible")
  expect(rows.filter((row) => row.result === "closed").map((row) => row.path)).toEqual([w.env])
  const yielded = rows.filter(
    (row) => row.result === "kept" && row.why === "eligible; yielding to the next queue round before removal",
  )
  expect(yielded.map((row) => row.path)).toEqual([second])
  const statePath = join(w.workdir, "state", "yrd", "environment-cleanup.json")
  const state = JSON.parse(readFileSync(statePath, "utf8")) as { cursorEnv: string }
  expect(state.cursorEnv).toBe("z-second-eligible")
})

it("leaves the general sweep's recorded reason in place when the terminal filing pass sees an unrecorded row", async () => {
  const w = await world()
  await w.git(["remote", "add", "origin", w.repo])
  await w.git(["fetch", "--quiet", "origin", "main"])
  await w.git(["branch", "task/env-valid", "HEAD"])
  const envGit = testGitIn(w.env)
  await envGit(["checkout", "--quiet", "task/env-valid"])
  writeFileSync(join(w.env, "untracked.txt"), "dirty\n")
  await runRound(w, "round-1-sweep-records-dirty")
  const statePath = join(w.workdir, "state", "yrd", "environment-cleanup.json")
  const afterSweep = JSON.parse(readFileSync(statePath, "utf8")) as { reported: Record<string, string> }
  expect(afterSweep.reported[w.env]).toContain("dirty root/components")

  const reqEnv = join(w.repo, ".bays", "z-req-env")
  await w.git(["worktree", "add", "--quiet", "--detach", reqEnv, "HEAD"])
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error("this cleanup case needs a real unix uid")
  writeCloseRequest(w.workdir, {
    name: "z-req-env",
    path: reqEnv,
    requester: "@dev/12",
    uid,
    at: "2026-10-15T00:00:00.000Z",
    intent: "close",
    predicate: "direct-admission",
    options: { noRehome: true },
    head: w.head,
  })
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
    readBranchHistory.mockResolvedValue({
      ref: "refs/yrd/changes/task/env-valid",
      history: { state: { status: "merged", commit: w.head, tip: "b".repeat(40) }, events: [] },
    } as never)
    await createEnvironmentCleanup()({
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
      outcome: {
        run: "round-2-merged-catchup",
        log: join(w.workdir, "journal.jsonl"),
        merged: ["task/env-valid"],
        target: w.head,
      } as never,
    })
  } finally {
    readBranchHistory.mockResolvedValue({ history: undefined })
    census.mockRestore()
  }
  const afterCatchup = JSON.parse(readFileSync(statePath, "utf8")) as { reported: Record<string, string> }
  expect(afterCatchup.reported[w.env]).not.toContain("opening lifetime unrecorded")
  expect(afterCatchup.reported[w.env]).toContain("dirty root/components")
  const round2KeepUnrecorded = cleanupRows(w.workdir).filter(
    (row) => row.run === "round-2-merged-catchup" && row.path === w.env && row.why === "opening lifetime unrecorded",
  )
  expect(round2KeepUnrecorded).toEqual([])
})

it("keeps an environment with a corrupt opening record by name and never treats it as eligible", async () => {
  const w = await world()
  await w.git(["remote", "add", "origin", w.repo])
  await w.git(["fetch", "--quiet", "origin", "main"])
  const envGit = testGitIn(w.env)
  const gitDir = (await envGit(["rev-parse", "--absolute-git-dir"])).trim()
  const recordPath = join(gitDir, "yrd-open.json")
  writeFileSync(recordPath, "{corrupt json\n")

  await runRound(w, "corrupt-opening-record")
  const rows = cleanupRows(w.workdir).filter((row) => row.run === "corrupt-opening-record")
  expect(rows.filter((row) => row.result === "closed")).toEqual([])
  const kept = rows.find((row) => row.result === "kept" && row.path === w.env)
  expect(String(kept?.why)).toContain(`opening record unreadable at ${recordPath}: `)
})

it("keeps an environment whose opening record becomes unreadable or standing before the final pre-close re-read", async () => {
  const w = await world()
  await w.git(["remote", "add", "origin", w.repo])
  await w.git(["fetch", "--quiet", "origin", "main"])
  const envGit = testGitIn(w.env)
  const gitDir = (await envGit(["rev-parse", "--absolute-git-dir"])).trim()
  const recordPath = join(gitDir, "yrd-open.json")
  // On the first census read (round start), yrd-open.json is absent; on the second census read
  // (freshHolder at line 1185, right before the final pre-close re-read), write a corrupt yrd-open.json.
  let censusCalls = 0
  const census = vi.spyOn(removely, "inspectProcessCwds").mockImplementation(async () => {
    censusCalls++
    if (censusCalls === 2) {
      writeFileSync(recordPath, "{corrupt json before close\n")
    }
    return { complete: true, unreadable: [], mechanism: "proc", rows: [] }
  })
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
      io: {
        localBranchProtections: null,
        cwd: w.repo,
        stdout: () => {},
        stderr: () => {},
      },
      selection: w.git.selection,
      outcome: { run: "corrupt-on-reread", log: join(w.workdir, "journal.jsonl"), merged: [], target: w.head } as never,
    })
  } finally {
    census.mockRestore()
  }
  const rows = cleanupRows(w.workdir).filter((row) => row.run === "corrupt-on-reread")
  expect(rows.filter((row) => row.result === "closed")).toEqual([])
  const kept = rows.find((row) => row.result === "kept" && row.path === w.env)
  expect(String(kept?.why)).toContain(`opening record unreadable at ${recordPath}: `)
})
