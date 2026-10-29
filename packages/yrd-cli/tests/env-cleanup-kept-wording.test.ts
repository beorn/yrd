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
import { createLocalGitWorktreeStore } from "git-super/worktree"
import { createEnvironmentCleanup } from "../src/env-cleanup.ts"
import { closeEnvironment } from "../src/env-commands.ts"
import { stageCloseRequest, writeCloseRequest } from "../src/env-close-requests.ts"
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
    intent: "close",
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

// #31360: consuming an intent is not a completed close. Exercise the existing request consumer,
// with the direct verb results observed in production and its other unsuccessful terminal shapes.
it.each(["unknown", "blocked", "native-exit", "malformed", "unproven"] as const)(
  "reports a terminal %s close request as not performed while the environment stays registered",
  async (kind) => {
    const w = await world(new Date().toISOString())
    const uid = process.getuid?.()
    if (uid === undefined) throw new Error("this close-request case needs a real unix uid")
    const file = writeCloseRequest(w.workdir, {
      name: "env-fresh",
      path: w.env,
      requester: "requester",
      uid,
      at: new Date().toISOString(),
      intent: "close",
      predicate: "direct-admission",
      options: { noRehome: true },
      head: w.head,
    }).file
    const custody = {
      component: "ag",
      source: "surviving primary Git graph",
      status: kind,
      detail: kind === "blocked" ? "component commit has no surviving witness" : "shared proof deadline is exhausted",
      ...(kind === "blocked" ? { oid: w.head } : {}),
    }
    const output =
      kind === "unknown" || kind === "blocked"
        ? JSON.stringify({ kept: w.env, reason: "component-custody", custody })
        : kind === "malformed"
          ? "not-json"
          : kind === "native-exit"
            ? "teardown failed"
            : JSON.stringify({ unexpected: true })
    vi.mocked(closeEnvironment).mockImplementationOnce(async (_path, _options, io) => {
      io.stdout(output)
      return kind === "native-exit" ? 1 : 0
    })

    const rows = await runRound(w, createEnvironmentCleanup(), "terminal-" + kind, [])
    const retired = rows.find((row) => row.result === "retired" && row.path === w.env)
    expect(retired, JSON.stringify(rows)).toBeDefined()
    const why = String(retired?.why)
    expect(why).toMatch(/^close not performed:/)
    expect(rows.filter((row) => row.result === "closed")).toEqual([])
    expect(existsSync(file), "terminal intent is consumed once, never retried").toBe(false)
    expect(existsSync(w.env), "no removal was certified").toBe(true)
    expect(await w.git(["worktree", "list", "--porcelain"])).toContain("worktree " + w.env)
    expect((retired?.request as { coverageAttempts?: number }).coverageAttempts).toBeUndefined()
    if (kind === "unknown" || kind === "blocked") {
      expect(why).toContain(custody.detail)
      expect(why).toContain(custody.source)
      expect(why).toContain("environment remains registered")
      expect(why).toMatch(/elapsed_ms=\d+/)
      if (kind === "unknown") expect(why).toContain("GitSuper custody proof budget")
      else {
        expect(why).toContain(w.head)
        expect(why).toContain("land or push ag, then re-request")
      }
    }
  },
)

/**
 * Add a real submodule `packages/alpha` to `w.repo` and `w.env` so `inspectComponentCustodyFreshness`
 * runs against a real component tree and real primary witness store.
 */
async function attachAlphaSubmodule(
  w: Awaited<ReturnType<typeof world>>,
): Promise<Readonly<{ alphaPrimary: string; alphaEnv: string; head: string }>> {
  const subRoot = realpathSync(mkdtempSync(join(tmpdir(), "yrd-cleanup-sub-")))
  roots.push(subRoot)
  const seed = gitIn(subRoot)
  const alphaBare = join(subRoot, "alpha.git")
  const alphaSeed = join(subRoot, "alpha-seed")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", alphaBare])
  await seed(["clone", "--quiet", alphaBare, alphaSeed])
  const alphaGit = gitIn(alphaSeed)
  await alphaGit(["config", "user.email", "cleanup@yrd.test"])
  await alphaGit(["config", "user.name", "yrd"])
  await alphaGit(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(alphaSeed, "alpha.ts"), "export const alpha = 1\n")
  await alphaGit(["add", "alpha.ts"])
  await alphaGit(["commit", "--quiet", "-m", "seed alpha"])
  await alphaGit(["push", "--quiet", "origin", "main"])

  await w.git(["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", alphaBare, "packages/alpha"])
  await w.git(["commit", "--quiet", "-m", "add packages/alpha"])
  await w.git(["push", "--quiet", "origin", "main"])
  const head = (await w.git(["rev-parse", "HEAD"])).trim()
  await w.git(["-C", w.env, "reset", "--hard", head])
  await w.git(["-C", w.env, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"])
  return {
    alphaPrimary: join(w.repo, "packages/alpha"),
    alphaEnv: join(w.env, "packages/alpha"),
    head,
  }
}

it("suppresses startup refiling of an unchanged blocked component-custody refusal across service starts while ignoring unrelated primary noise, and recovers on witness publication, component change, HEAD change, pending request, or fresh terminal work", async () => {
  const openedAt = new Date().toISOString()
  const w0 = await world(openedAt)
  const sub = await attachAlphaSubmodule(w0)
  const w = { ...w0, head: sub.head }

  const store = createLocalGitWorktreeStore({ repo: w.repo })
  const initialFreshness = await store.inspectComponentCustodyFreshness(w.env, {
    primaryRoot: w.repo,
    targetBranch: "main",
  })
  expect(initialFreshness).toMatchObject({
    status: "ok",
    fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
  })
  if (initialFreshness.status !== "ok") throw new Error("expected initial freshness ok")

  const closeMock = vi.mocked(closeEnvironment)
  const baseCalls = closeMock.mock.calls.length
  const blockedOutput = (fingerprint?: string, oid = w.head): string =>
    JSON.stringify({
      kept: w.env,
      reason: "component-custody",
      custody: {
        component: "packages/alpha",
        source: "surviving primary Git graph",
        status: "blocked",
        detail: "component commit has no surviving witness",
        oid,
        ...(fingerprint === undefined ? {} : { fingerprint }),
      },
    })

  // Start 1: terminal merged branch files a close request, consumeCloseRequests runs closeEnvironment (call #1),
  // consumes the request file, and records the blocked custody refusal with its freshness fingerprint.
  closeMock.mockImplementationOnce(async (_path, _options, io) => {
    io.stdout(blockedOutput(initialFreshness.fingerprint))
    return 0
  })
  const start1 = await runRound(w, createEnvironmentCleanup(), "custody-start-1", [w.branch])
  expect(closeMock.mock.calls.length - baseCalls, "Start 1 runs closeEnvironment once").toBe(1)
  expect(start1.some((row) => row.result === "filed" && row.path === w.env)).toBe(true)
  expect(start1.some((row) => row.result === "retired" && row.path === w.env)).toBe(true)

  const stateFile = join(w.workdir, "state", "yrd", "environment-cleanup.json")
  const state1 = JSON.parse(readFileSync(stateFile, "utf8")) as {
    custodyRefusals?: Record<string, { fingerprint: string; recordedAt: string; why: string }>
  }
  expect(state1.custodyRefusals?.[w.env]).toMatchObject({
    fingerprint: initialFreshness.fingerprint,
    why: expect.stringContaining("cure: land or push packages/alpha, then re-request"),
  })
  const recordedAt1 = state1.custodyRefusals?.[w.env]?.recordedAt
  expect(typeof recordedAt1).toBe("string")

  // Noise case (Test a): unrelated commit and unrelated ref updates in primaryRoot and primary submodule.
  const rootTree = (await w.git(["rev-parse", "HEAD^{tree}"])).trim()
  const rootNoise = (await w.git(["commit-tree", rootTree, "-p", w.head, "-m", "unrelated primary root commit"])).trim()
  await w.git(["update-ref", "refs/heads/unrelated-noise", rootNoise])
  await w.git(["update-ref", "refs/tags/unrelated-tag", rootNoise])
  const alphaPrimaryHead = (await w.git(["-C", sub.alphaPrimary, "rev-parse", "HEAD"])).trim()
  const alphaPrimaryTree = (await w.git(["-C", sub.alphaPrimary, "rev-parse", "HEAD^{tree}"])).trim()
  const alphaNoise = (
    await w.git(["-C", sub.alphaPrimary, "commit-tree", alphaPrimaryTree, "-p", alphaPrimaryHead, "-m", "noise"])
  ).trim()
  await w.git(["-C", sub.alphaPrimary, "update-ref", "refs/heads/unrelated-alpha", alphaNoise])

  // Start 2: same terminal head, unchanged custody freshness despite unrelated noise in primaryRoot.
  // No close request is refiled, closeEnvironment is NOT called again (count stays 1), and the replayed
  // kept row names itself: "unchanged since <recordedAt>: <why>".
  const start2 = await runRound(w, createEnvironmentCleanup(), "custody-start-2", [w.branch])
  expect(
    closeMock.mock.calls.length - baseCalls,
    "Start 2 suppresses refiling and does not call closeEnvironment",
  ).toBe(1)
  expect(start2.filter((row) => row.result === "filed" && row.path === w.env)).toEqual([])
  const kept2 = start2.filter((row) => row.result === "kept" && row.path === w.env)
  expect(kept2, JSON.stringify(start2)).toHaveLength(1)
  expect(String(kept2[0]?.why)).toBe(`unchanged since ${recordedAt1}: ${state1.custodyRefusals?.[w.env]?.why}`)

  // Start 2b: another unchanged restart does not reprint the unchanged kept row either (#29679 deduplication).
  const start2b = await runRound(w, createEnvironmentCleanup(), "custody-start-2b", [w.branch])
  expect(closeMock.mock.calls.length - baseCalls).toBe(1)
  expect(start2b.filter((row) => row.result === "kept" && row.path === w.env)).toEqual([])
  expect(start2b.find((row) => row.run === "custody-start-2b" && "kept" in row)?.kept).toBe(1)

  // AC3 recovery arm 1 — Fresh terminal work in a second environment files and closes even while w.env is suppressed.
  const env2 = await addEnvironment(w, "env-second", openedAt)
  const env2Head = (await w.git(["-C", env2, "rev-parse", "HEAD"])).trim()
  readBranchHistory.mockImplementation(async (_store: unknown, _queue: unknown, branch: string) => ({
    ref: `refs/yrd/changes/${branch}`,
    history: {
      state: { status: "merged", commit: branch === "task/env-second" ? env2Head : w.head, tip: "b".repeat(40) },
      events: [],
    },
  }))
  closeMock.mockImplementationOnce(async (path, _options, io) => {
    await w.git(["worktree", "remove", "--force", path])
    io.stdout(JSON.stringify({ closed: path }))
    return 0
  })
  const startFreshPeer = await createEnvironmentCleanup()({
    repo: w.repo,
    git: w.git,
    config: configFor(w.head),
    workdir: w.workdir,
    io: { cwd: w.repo, localBranchProtections: null, stdout: () => {}, stderr: () => {} },
    selection: w.git.selection,
    outcome: {
      run: "custody-fresh-peer",
      log: join(w.workdir, "journal.jsonl"),
      merged: [w.branch, "task/env-second"],
      target: w.head,
    } as never,
  })
  expect(startFreshPeer).toEqual([])
  expect(closeMock.mock.calls.length - baseCalls, "fresh terminal peer called closeEnvironment").toBe(2)
  expect(closeMock.mock.calls.at(-1)?.[0]).toBe(env2)

  // AC3 recovery arm 2 — Meaningful witness/publication change (publishing a yrd pin in the primary witness store)
  // changes the freshness fingerprint, invalidates the stored refusal, refiles, and calls closeEnvironment.
  await w.git(["-C", sub.alphaPrimary, "update-ref", `refs/yrd/pins/${alphaNoise}`, alphaNoise])
  const afterWitnessFreshness = await store.inspectComponentCustodyFreshness(w.env, {
    primaryRoot: w.repo,
    targetBranch: "main",
  })
  expect(afterWitnessFreshness.status).toBe("ok")
  if (afterWitnessFreshness.status !== "ok") throw new Error("expected witness freshness ok")
  expect(afterWitnessFreshness.fingerprint).not.toBe(initialFreshness.fingerprint)
  closeMock.mockImplementationOnce(async (_path, _options, io) => {
    io.stdout(blockedOutput(afterWitnessFreshness.fingerprint))
    return 0
  })
  const start3 = await runRound(w, createEnvironmentCleanup(), "custody-start-3-witness", [w.branch])
  expect(closeMock.mock.calls.length - baseCalls, "witness publication change refiles and calls closeEnvironment").toBe(
    3,
  )
  expect(start3.some((row) => row.result === "filed" && row.path === w.env)).toBe(true)

  // AC3 recovery arm 3 — Candidate component change (new ref in w.env's packages/alpha) invalidates and refiles.
  await w.git(["-C", sub.alphaEnv, "update-ref", "refs/heads/local-wip", alphaPrimaryHead])
  const afterComponentFreshness = await store.inspectComponentCustodyFreshness(w.env, {
    primaryRoot: w.repo,
    targetBranch: "main",
  })
  expect(afterComponentFreshness.status).toBe("ok")
  if (afterComponentFreshness.status !== "ok") throw new Error("expected component freshness ok")
  closeMock.mockImplementationOnce(async (_path, _options, io) => {
    io.stdout(blockedOutput(afterComponentFreshness.fingerprint))
    return 0
  })
  const start4 = await runRound(w, createEnvironmentCleanup(), "custody-start-4-component", [w.branch])
  expect(closeMock.mock.calls.length - baseCalls, "component ref change refiles and calls closeEnvironment").toBe(4)
  expect(start4.some((row) => row.result === "filed" && row.path === w.env)).toBe(true)

  // Test (c) — Schema version bump invalidates stored fingerprint and refiles.
  const currentState = JSON.parse(readFileSync(stateFile, "utf8")) as {
    custodyRefusals: Record<string, { fingerprint: string }>
  }
  currentState.custodyRefusals[w.env]!.fingerprint = "f".repeat(64)
  writeFileSync(stateFile, JSON.stringify(currentState) + "\n")
  closeMock.mockImplementationOnce(async (_path, _options, io) => {
    io.stdout(blockedOutput(afterComponentFreshness.fingerprint))
    return 0
  })
  const start5 = await runRound(w, createEnvironmentCleanup(), "custody-start-5-schema-bump", [w.branch])
  expect(closeMock.mock.calls.length - baseCalls, "schema bump invalidates stored fingerprint and refiles").toBe(5)
  expect(start5.some((row) => row.result === "filed" && row.path === w.env)).toBe(true)

  // AC3 recovery arm 4 — Interrupted pending request (in .processing/) drains on next start even when fingerprint matches.
  const uid = process.getuid?.() ?? -1
  const pendingFile = writeCloseRequest(w.workdir, {
    name: "env-fresh",
    path: w.env,
    requester: "yrd",
    uid,
    at: new Date().toISOString(),
    intent: "close",
    predicate: "direct-admission",
    options: { noRehome: true },
    head: w.head,
  }).file
  stageCloseRequest(pendingFile)
  closeMock.mockImplementationOnce(async (_path, _options, io) => {
    io.stdout(blockedOutput(afterComponentFreshness.fingerprint))
    return 0
  })
  const start6 = await runRound(w, createEnvironmentCleanup(), "custody-start-6-interrupted", [w.branch])
  expect(closeMock.mock.calls.length - baseCalls, "interrupted staged request drains on Start 6").toBe(6)
  expect(start6.some((row) => row.result === "interrupted" && row.path === w.env)).toBe(true)

  // Test (d) — Pre/post mismatch at refusal time yields status: "blocked" without fingerprint -> not cached, next start refiles.
  const stateBeforeMismatch = JSON.parse(readFileSync(stateFile, "utf8")) as {
    custodyRefusals: Record<string, unknown>
  }
  delete stateBeforeMismatch.custodyRefusals[w.env]
  writeFileSync(stateFile, JSON.stringify(stateBeforeMismatch) + "\n")
  closeMock.mockImplementationOnce(async (_path, _options, io) => {
    io.stdout(blockedOutput(undefined))
    return 0
  })
  await runRound(w, createEnvironmentCleanup(), "custody-start-7a-prepost-mismatch", [w.branch])
  expect(closeMock.mock.calls.length - baseCalls).toBe(7)
  const stateAfterMismatch = JSON.parse(readFileSync(stateFile, "utf8")) as {
    custodyRefusals?: Record<string, unknown>
  }
  expect(stateAfterMismatch.custodyRefusals?.[w.env]).toBeUndefined()
  closeMock.mockImplementationOnce(async (_path, _options, io) => {
    io.stdout(blockedOutput(afterComponentFreshness.fingerprint))
    return 0
  })
  await runRound(w, createEnvironmentCleanup(), "custody-start-7b-refiles", [w.branch])
  expect(closeMock.mock.calls.length - baseCalls, "blocked without fingerprint refiles on the next start").toBe(8)

  // AC4 + Adjustment 1 — When inspectComponentCustodyFreshness returns status: "unknown" at startup,
  // startup keeps with "UNKNOWN: ...; left to the ordinary sweep's full proof" and leaves it to the ordinary sweep.
  const alphaGitDir = (await w.git(["-C", sub.alphaEnv, "rev-parse", "--absolute-git-dir"])).trim()
  const headLogPath = join(alphaGitDir, "logs", "HEAD")
  const savedHeadLog = readFileSync(headLogPath, "utf8")
  try {
    writeFileSync(headLogPath, "corrupt-reflog-line\n")
    const start8 = await runRound(w, createEnvironmentCleanup(), "custody-start-8-unknown-freshness", [w.branch])
    expect(closeMock.mock.calls.length - baseCalls, "startup does not refile on unknown freshness").toBe(8)
    expect(start8.filter((row) => row.result === "filed" && row.path === w.env)).toEqual([])
    const keptUnknown = start8.find(
      (row) => row.result === "kept" && row.path === w.env && String(row.why).startsWith("UNKNOWN:"),
    )
    expect(keptUnknown, JSON.stringify(start8)).toBeDefined()
    expect(String(keptUnknown?.why)).toContain("component custody freshness unknown (")
    expect(String(keptUnknown?.why)).toContain("left to the ordinary sweep's full proof")
  } finally {
    writeFileSync(headLogPath, savedHeadLog)
  }

  // AC3 recovery arm 5 — Changed HEAD in the environment invalidates the stored refusal and refiles.
  writeFileSync(join(w.env, "root.txt"), "advanced\n")
  await w.git(["-C", w.env, "add", "root.txt"])
  await w.git(["-C", w.env, "commit", "--quiet", "-m", "advance env head"])
  const newHead = (await w.git(["-C", w.env, "rev-parse", "HEAD"])).trim()
  const wAdvanced = { ...w, head: newHead }
  closeMock.mockImplementationOnce(async (_path, _options, io) => {
    io.stdout(JSON.stringify({ closed: w.env }))
    return 0
  })
  const start9 = await runRound(wAdvanced, createEnvironmentCleanup(), "custody-start-9-head-moved", [w.branch])
  expect(closeMock.mock.calls.length - baseCalls, "changed HEAD invalidates stored refusal and refiles").toBe(9)
  expect(start9.some((row) => row.result === "filed" && row.path === w.env)).toBe(true)
})
