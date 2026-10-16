/**
 * @failure 27120 AC2 (@dev/review2 P2): the environment sweep met a refused private-store close as
 *          `PrivateStoreRefusalError: …` with a generic route, not as one named class carrying the real verify
 *          route. The pre-close `inspectRemoval` guard throws before `closeEnvironment` is reached, so the
 *          exit-code class formatter is bypassed and the outer catch keeps `String(cause)`. A standing close
 *          REQUEST for the same tree was worse: the request disposition tests only git-super's class, so `env
 *          close`'s own refusal fell through to `retired` and the operator's request was DELETED on its first
 *          attempt, erasing who asked for the close.
 * @level   l2 (real bare remote, real retained Git worktree, a real private store, a real close request)
 * @consumer the queue round's environment cleanup sweep
 * @reach   fs-walk <fixture-only: the registry and environment tree this test's own fixture makes under the OS temp root>
 * @testonly none
 *
 * The same-UID cwd census is a module mock in both arms — a namespace binding of an installed ESM package
 * cannot be replaced by a spy in standalone CI — and it is certified complete, so the close reaches the store
 * guard rather than the census ladder. This arm is about the private store, not about the census.
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
import { createEnvironmentCleanup } from "../src/env-cleanup.ts"
import { closeRequestFile, writeCloseRequest } from "../src/env-close-requests.ts"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"

process.env.GIT_CONFIG_COUNT = "1"
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow"
process.env.GIT_CONFIG_VALUE_0 = "always"

// A spy cannot replace a binding of an installed ESM package's namespace (standalone CI), so the census seam is
// a module mock: complete and empty, so the close reaches the store guard and not the census ladder.
vi.mock("removely", async (importOriginal) => {
  const actual = await importOriginal<typeof import("removely")>()
  return {
    ...actual,
    inspectProcessCwds: vi.fn(async () => ({ mechanism: "proc", complete: true, rows: [], unreadable: [] })),
  }
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

const SENTINEL = "preserve store bytes\n"

/**
 * The environment the sweep must meet: a real bare remote, a real linked worktree under the registry root the
 * sweep reads, and a REAL private store whose declaration NAME (`secret`) differs from its path
 * (`vendor/dependency`) — Git keys the store by name, so a path-keyed probe would miss it.
 */
async function privateStoreEnvironment(): Promise<
  Readonly<{
    env: string
    git: ReturnType<typeof gitIn>
    head: string
    repo: string
    root: string
    store: string
    workdir: string
  }>
> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "yrd-sweep-private-")))
  roots.push(root)
  const seed = gitIn(root)
  const remote = join(root, "remote.git")
  const repo = join(root, "work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, repo])
  const git = gitIn(repo)
  await git(["config", "user.email", "sweep@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(repo, ".yrd.yml"), 'setup: ":"\n')
  await git(["add", ".yrd.yml"])
  await git(["commit", "--quiet", "-m", "declare environment setup"])

  const child = join(root, "child")
  await seed(["init", "--quiet", "--initial-branch=main", child])
  const childGit = gitIn(child)
  await childGit(["config", "user.email", "sweep@yrd.test"])
  await childGit(["config", "user.name", "yrd"])
  writeFileSync(join(child, "READY"), "materialized\n")
  await childGit(["add", "READY"])
  await childGit(["commit", "--quiet", "-m", "seed materialized dependency"])
  await git(["submodule", "add", "--quiet", "--name", "secret", child, "vendor/dependency"])
  await git(["config", "-f", ".gitmodules", "submodule.secret.private", "true"])
  await git(["add", ".gitmodules", "vendor/dependency"])
  await git(["commit", "--quiet", "-m", "declare the private dependency under the name secret"])
  // The requested-close arm runs the REAL `env close`, which reads the queue branch from the remote's HEAD, so
  // main must exist there and origin/HEAD must name it (a clone made before the first push leaves it dangling).
  await git(["push", "--quiet", "origin", "main"])
  await git(["remote", "set-head", "origin", "--auto"])

  const env = join(repo, ".bays", "env-private")
  mkdirSync(join(repo, ".bays"), { recursive: true })
  await git(["worktree", "add", "--quiet", "--detach", env, "HEAD"])
  const head = (await git(["rev-parse", "HEAD"])).trim()
  await git(["-C", env, "submodule", "update", "--init", "vendor/dependency"])
  const store = (await git(["-C", env, "rev-parse", "--path-format=absolute", "--git-path", "modules/secret"])).trim()
  expect(existsSync(store)).toBe(true)
  writeFileSync(join(store, "SWEEP_SENTINEL"), SENTINEL)
  // The deinitialized shape @dev/review2 reproduced: the gitfile is gone, modules/secret remains.
  await git(["-C", env, "submodule", "deinit", "-f", "vendor/dependency"])
  expect(existsSync(join(env, "vendor/dependency/.git"))).toBe(false)
  expect(existsSync(store)).toBe(true)

  const workdir = join(root, "queue")
  mkdirSync(workdir, { recursive: true })
  return { env, git, head, repo, root, store, workdir }
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

it("names the private-store refusal by class and the real verify route in the sweep", async () => {
  const { repo, git, env, head, store, workdir } = await privateStoreEnvironment()
  const log = join(workdir, "journal.jsonl")
  await createEnvironmentCleanup()({
    repo,
    git,
    config: configFor(head),
    workdir,
    io: { cwd: repo, stdout: () => {}, stderr: () => {} },
    selection: git.selection,
    outcome: { run: "sweep-private-class", log, merged: [], target: head } as never,
  })

  const kept = cleanupRows(workdir).find((row) => row.result === "kept" && row.path === env)
  expect(kept, JSON.stringify(cleanupRows(workdir))).toBeDefined()
  const why = String(kept?.why)
  expect(why).toContain("kept: private checkout")
  expect(why).toContain(store)
  expect(why).toContain("retire with git super worktree private-store verify")
  // The bytes are untouched: the environment, the store and its sentinel all survive, and nothing is copied.
  expect(existsSync(env)).toBe(true)
  expect(existsSync(store)).toBe(true)
  expect(readFileSync(join(store, "SWEEP_SENTINEL"), "utf8")).toBe(SENTINEL)
  expect(existsSync(join(workdir, "retained-modules"))).toBe(false)
})

it("keeps a standing close request when the refusal's own class arrives on the first attempt", async () => {
  const { repo, git, env, head, store, workdir } = await privateStoreEnvironment()
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error("this close-request arm needs a real unix uid")
  const requestFile = closeRequestFile(workdir, env)
  writeCloseRequest(workdir, {
    name: "env-private",
    path: env,
    requester: "@dev/luna2",
    uid,
    at: new Date().toISOString(),
    predicate: "direct-admission",
    options: { noRehome: true },
    head,
  })
  expect(existsSync(requestFile), "the request stands before the round").toBe(true)

  const log = join(workdir, "journal.jsonl")
  await createEnvironmentCleanup()({
    repo,
    git,
    config: configFor(head),
    workdir,
    io: { cwd: repo, stdout: () => {}, stderr: () => {} },
    selection: git.selection,
    outcome: { run: "sweep-private-request", log, merged: [], target: head } as never,
  })

  const rows = cleanupRows(workdir)
  const kept = rows.find((row) => row.result === "kept" && row.path === env)
  expect(kept, JSON.stringify(rows)).toBeDefined()
  // The CLASS and the real route, on the request path exactly as on the ordinary sweep path.
  expect(String(kept?.why)).toContain("kept: private checkout")
  expect(String(kept?.why)).toContain(store)
  expect(rows.filter((row) => row.result === "retired" && row.path === env)).toHaveLength(0)
  // The operator's request is preserved under the existing retry contract, not deleted on its first refusal.
  expect(existsSync(requestFile), JSON.stringify(rows)).toBe(true)
  expect(existsSync(env)).toBe(true)
  expect(existsSync(store)).toBe(true)
  expect(readFileSync(join(store, "SWEEP_SENTINEL"), "utf8")).toBe(SENTINEL)
})
