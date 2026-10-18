/**
 * @failure 29679 defects 1 and 2, from the 2026-10-16 Yrd garage logs:
 *   (1) a KEPT environment was described with an "Error: " prefix —
 *       `kept: Error: fresh: opened 2026-10-16T01:47:12.458Z` (round1-merge.log:112). The sweep uses
 *       `throw new Error(<keep reason>)` as control flow, and its catch stringified the Error, so a benign
 *       keep read as a failure. The reason text itself is unchanged; only the stringification is.
 *   (2) a close request that already STOOD was reported as `file-failed`
 *       (hand-start-1827.log:38) — nothing failed and nothing was written, the request simply already
 *       stood. It is a no-op that must name the standing request, never a failure.
 *   (5) every round reprinted every unchanged keep: ~50 folders every 2 minutes is writer volume, not
 *       signal (log-retention ruling, 2026-10-16, "Not archival"). A kept folder is written once per CHANGE
 *       of reason, and the map that remembers the last row per path is PERSISTED in the sweep's own state
 *       file, so a restart or a landing that advances the vendor/yrd pin does not reprint the registry
 *       either (@chief accepted that carrier, 2026-10-16).
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
import * as removely from "removely"
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

/**
 * One more environment under `.bays/`, opened `at`. An opening record older than the grace window makes
 * the row eligible for the sweep, so a charged row can be closed and the registry can shrink.
 */
async function addEnvironment(w: Awaited<ReturnType<typeof world>>, name: string, at: string): Promise<string> {
  const env = join(w.repo, ".bays", name)
  await w.git(["worktree", "add", "--quiet", "-b", `task/${name}`, env, "HEAD"])
  const envGitDir = (await w.git(["-C", env, "rev-parse", "--absolute-git-dir"])).trim()
  writeEnvOpenRecord(envGitDir, { version: 1, lifetime: "job", at })
  return env
}

/** A census that cannot rule out a holder: the WHOLE registry is refused with this one reason. */
function refusalCensus(): Awaited<ReturnType<typeof removely.inspectProcessCwds>> {
  return {
    mechanism: "proc",
    complete: false,
    rows: [],
    unreadable: [
      {
        pid: 999999,
        uid: process.getuid?.(),
        comm: "fixture-ghost",
        denied: ["process"],
        issues: [{ source: "process", resource: "cwd", reason: "denied", code: "EACCES" }],
      },
    ],
  }
}

async function runRound(
  w: Awaited<ReturnType<typeof world>>,
  cleanup: ReturnType<typeof createEnvironmentCleanup>,
  run: string,
  merged: readonly string[],
): Promise<readonly Record<string, unknown>[]> {
  readBranchHistory.mockResolvedValue({
    ref: `refs/yrd/changes/${w.branch}`,
    history: { state: { status: "merged", commit: w.head, tip: "b".repeat(40) }, events: [] },
  })
  await cleanup({
    repo: w.repo,
    git: w.git,
    config: configFor(w.head),
    workdir: w.workdir,
    io: { cwd: w.repo, localBranchProtections: null, stdout: () => {}, stderr: () => {} },
    selection: w.git.selection,
    outcome: { run, log: join(w.workdir, "journal.jsonl"), merged, target: w.head } as never,
  })
  // Rounds share one journal, so only the rows THIS round wrote are its own.
  return cleanupRows(w.workdir).filter((row) => row.run === run)
}

it("writes a refused registry once across fresh processes, with the environments still protected", async () => {
  const at = new Date().toISOString()
  const w = await world(at)
  // A census that cannot rule out a holder refuses coverage for the WHOLE registry: every registered
  // environment is preserved with that one reason BEFORE the batch runs (the census catch in
  // env-cleanup.ts). That is the shape the live service hits on a busy host — ~50 folders, every round.
  const census = vi.mocked(removely.inspectProcessCwds)
  try {
    census.mockResolvedValue({
      mechanism: "proc",
      complete: false,
      rows: [],
      unreadable: [
        {
          pid: 999999,
          uid: process.getuid?.(),
          comm: "fixture-ghost",
          denied: ["process"],
          issues: [{ source: "process", resource: "cwd", reason: "denied", code: "EACCES" }],
        },
      ],
    })
    const first = await runRound(w, createEnvironmentCleanup(), "refused-1", [])
    const kept = first.filter((row) => row.result === "kept" && row.path === w.env)
    expect(kept, JSON.stringify(first)).toHaveLength(1)
    expect(String(kept[0]?.why), "the refusal names the pid it could not read").toContain("could not read pid 999999")
    expect(existsSync(w.env), "the environment is protected, never removed on a refusal").toBe(true)

    // A FRESH process meets the same refusal for the same folder with the same reason. The row is written
    // once per change of reason ACROSS processes (#29679 row 5): no second row, and the round still counts
    // the coverage it walked. Nothing is persisted on the refusal path today, so this reprints.
    const restarted = await runRound(w, createEnvironmentCleanup(), "refused-2", [])
    expect(
      restarted.filter((row) => row.result === "kept" && row.path === w.env),
      JSON.stringify(restarted),
    ).toEqual([])
    expect(restarted.find((row) => row.run === "refused-2" && "kept" in row)?.kept).toBe(1)
  } finally {
    census.mockResolvedValue({ mechanism: "proc", complete: true, rows: [], unreadable: [] })
  }
})

it("names a kept environment's keep reason without an Error: prefix", async () => {
  const at = new Date().toISOString()
  const w = await world(at)
  const rows = await runRound(w, createEnvironmentCleanup(), "cleanup-kept-wording", [])

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

  const rows = await runRound(w, createEnvironmentCleanup(), "cleanup-close-request-wording", [w.branch])

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

it("writes a kept folder once per CHANGE of reason, never once per round", async () => {
  const at = new Date().toISOString()
  const w = await world(at)
  const cleanup = createEnvironmentCleanup()
  const keptRows = (rows: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] =>
    rows.filter((row) => row.result === "kept" && row.path === w.env)

  const first = await runRound(w, cleanup, "changed-once-1", [])
  expect(keptRows(first), JSON.stringify(first)).toHaveLength(1)
  expect(String(keptRows(first)[0]?.why)).toBe(`fresh: opened ${at}`)

  // The next round sees the same folder with the same reason: it writes no row and prints nothing.
  const second = await runRound(w, cleanup, "changed-once-2", [])
  expect(keptRows(second), JSON.stringify(second)).toEqual([])
  // …and still reports the coverage it walked, so the footer is not a silent downgrade.
  const footer = second.find((row) => row.run === "changed-once-2" && "kept" in row)
  expect(footer?.kept, JSON.stringify(second)).toBe(1)

  // The map is PERSISTED — in the state file this sweep already writes for its resume cursor, never a new
  // file kind. So a fresh process (a restart, or a landing that advances the vendor/yrd pin) does not
  // reprint the registry either: the same reason writes no row, and the round still COUNTS what it walked.
  const stateFile = join(w.workdir, "state", "yrd", "environment-cleanup.json")
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as { reported?: Record<string, string> }
  expect(state.reported, "the last row written per path is part of the sweep's own state file").toMatchObject({
    [w.env]: expect.stringContaining("fresh: opened"),
  })
  const restarted = await runRound(w, createEnvironmentCleanup(), "changed-once-3", [])
  expect(keptRows(restarted), JSON.stringify(restarted)).toEqual([])
  expect(restarted.find((row) => row.run === "changed-once-3" && "kept" in row)?.kept).toBe(1)

  // A different reason is a different row: the rule is per change of reason, not per folder forever.
  const later = new Date(Date.now() + 1_000).toISOString()
  const envGitDir = (await w.git(["-C", w.env, "rev-parse", "--absolute-git-dir"])).trim()
  writeEnvOpenRecord(envGitDir, { version: 1, lifetime: "job", at: later })
  const changed = await runRound(w, cleanup, "changed-once-4", [])
  expect(keptRows(changed), JSON.stringify(changed)).toHaveLength(1)
  expect(String(keptRows(changed)[0]?.why)).toBe(`fresh: opened ${later}`)
})

/**
 * @failure #29679 row 5, second revise (@dev/review2, 2026-10-17): `persistState` indexed
 *          `inventory.rows[progress.cursor]` and returned SILENTLY when that retained cursor sat past the
 *          end of a shrunken registry. A round that stops its batch at the registry's last row and closes
 *          an environment leaves the next, smaller registry with no row at that index; the census refusal
 *          persists BEFORE the batch re-normalizes the cursor, so the refusal map was never saved and the
 *          next process reprinted every unchanged keep. The sweep's own close supplies the shrink — no
 *          external race is required.
 * @level   l2 — a real bare remote, nine real retained worktrees, a real shrunken registry across rounds
 * @consumer the queue round's post-judgment environment cleanup, on a host that refuses census coverage
 * @reach   fs-walk <fixture-only: the registry, environments and state this fixture makes under the OS temp root>
 * @testonly none — the census and close seams are the module mocks this file already carries.
 */
it("persists a refused registry even when the retained cursor points past a shrunken registry", async () => {
  const fresh = new Date().toISOString()
  const stale = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
  const w = await world(fresh)
  // Seven fresh environments followed by one past the grace window (`env-7`), so the first seven charged
  // rows stay kept on grace, the eighth charged row (`env-7`) closes, and `env-fresh` sorts last as the
  // ninth row where the batch stops (`stoppedAt = 8` of nine).
  const added: string[] = []
  for (let index = 0; index < 8; index++) added.push(await addEnvironment(w, `env-${index}`, index < 7 ? fresh : stale))

  const cleanup = createEnvironmentCleanup()
  const census = vi.mocked(removely.inspectProcessCwds)
  try {
    // Round 1 fills the batch, closes `env-7` (the 8th charged row) and stops with the cursor on `env-fresh` (index 8).
    const first = await runRound(w, cleanup, "stale-cursor-1", [])
    expect(
      first.filter((row) => row.result === "closed").map((row) => row.path),
      JSON.stringify(first),
    ).toEqual([added[7]])
    // The sweep's OWN close retires the environment: the registry it leaves is one row smaller.
    await w.git(["worktree", "remove", "--force", added[7]!])
    const stateFile = join(w.workdir, "state", "yrd", "environment-cleanup.json")
    expect(
      (JSON.parse(readFileSync(stateFile, "utf8")) as { cursorEnv?: string }).cursorEnv,
      "the round persists its cursor on the registry's last row",
    ).toBe("env-fresh")

    // Round 2, the SAME process, meets a refusal for the SMALLER registry: the cursor still reads 8 from the
    // nine-row round and the batch has not re-normalized it. Normalizing inside `persistState` is what saves
    // the refusal map here; without it nothing is written and the restart reprints.
    census.mockResolvedValue(refusalCensus())
    const refused = await runRound(w, cleanup, "stale-cursor-2", [])
    const surviving = added.slice(0, 7)
    for (const path of surviving) {
      expect(
        refused.find((row) => row.result === "kept" && row.path === path),
        JSON.stringify(refused),
      ).toBeDefined()
    }
    const saved = JSON.parse(readFileSync(stateFile, "utf8")) as { reported?: Record<string, string> }
    expect(
      saved.reported?.[surviving[0]!],
      "the refusal reason is persisted, so a restart does not reprint it",
    ).toContain("could not read pid 999999")

    // Round 3 is a FRESH process meeting the same refusal: every surviving environment is unchanged, so the
    // round writes no kept row for it — the flood this rule exists to remove — and still counts its coverage.
    const restarted = await runRound(w, createEnvironmentCleanup(), "stale-cursor-3", [])
    expect(
      restarted.filter((row) => row.result === "kept"),
      JSON.stringify(restarted),
    ).toEqual([])
    // The refusal preserves the WHOLE eight-row registry — the seven survivors plus `env-fresh`.
    expect(restarted.find((row) => row.run === "stale-cursor-3" && "kept" in row)?.kept).toBe(surviving.length + 1)
  } finally {
    census.mockResolvedValue({ mechanism: "proc", complete: true, rows: [], unreadable: [] })
  }
})
