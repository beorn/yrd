/**
 * @failure The pre-submit checkout root grows without bound: every ordinary run
 * cleans up in a `finally`, but a killed process leaves a materialized tree
 * behind and nothing ever reclaims it — measured at 25 GB across 95 entries,
 * ~90 of them stale past a day and the oldest 11.8 days.
 * @level l3
 * @consumer @yrd/cli host
 */
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createProcess } from "@yrd/process"
import type { ResolvedYrdProjectConfig } from "../src/config.ts"
import { configuredChecks } from "../src/host.ts"

const DAY_MS = 24 * 60 * 60 * 1000
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(repo: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

/** HEAD on `main` and base `main`, so `checks.run(name, repo, {})` takes the in-place path. */
async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-presubmit-reap-"))
  roots.push(root)
  const path = join(root, "repo")
  await git(root, "init", "-q", "-b", "main", path)
  const repo = await realpath(path)
  await git(repo, "config", "user.name", "Yrd Test")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await writeFile(join(repo, "README.md"), "main\n")
  await git(repo, "add", "README.md")
  await git(repo, "commit", "-qm", "main")
  return repo
}

const config: ResolvedYrdProjectConfig = {
  base: "main",
  batch: 1,
  steps: ["probe"],
  requires: [],
  definitions: { probe: { run: "true", runner: "local" } },
  contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["probe"] },
}

/** A pre-submit entry as a killed run leaves it: the entry directory holding a `worktree/`. */
async function abandoned(parent: string, name: string, ageMs: number): Promise<string> {
  const path = join(parent, name)
  await mkdir(join(path, "worktree"), { recursive: true })
  await writeFile(join(path, "worktree", "file.txt"), "x".repeat(64))
  const at = new Date(Date.now() - ageMs)
  await utimes(join(path, "worktree", "file.txt"), at, at)
  await utimes(path, at, at)
  return path
}

/**
 * The SAME shape and the same age, with the one difference that decides it:
 * git still lists `<entry>/worktree`. This is the `keepOnFailure` workspace —
 * retained as evidence, so that path skips `worktrees.remove` and leaves the
 * worktree registered — and it is the only entry that legitimately outlives the
 * age floor.
 */
async function live(repo: string, parent: string, name: string, ageMs: number): Promise<string> {
  const path = join(parent, name)
  await mkdir(path, { recursive: true })
  await git(repo, "worktree", "add", "--detach", "-q", join(path, "worktree"), "HEAD")
  const at = new Date(Date.now() - ageMs)
  await utimes(path, at, at)
  return path
}

async function preSubmitRoot(repo: string): Promise<string> {
  const parent = join(repo, ".git", "yrd", "pre-submit-worktrees")
  await mkdir(parent, { recursive: true })
  return parent
}

describe("pre-submit checkout reclamation", () => {
  it("reclaims an abandoned checkout and keeps the one git still lists, at the next check", async () => {
    const repo = await repository()
    const parent = await preSubmitRoot(repo)
    const orphan = await abandoned(parent, "check-orphan", 2 * DAY_MS)
    const retained = await live(repo, parent, "check-retained", 2 * DAY_MS)
    const young = await abandoned(parent, "check-young", 60_000)
    const foreign = await abandoned(parent, "someone-elses-checkout", 2 * DAY_MS)

    await using process = createProcess({ cwd: repo })
    const checks = configuredChecks(process, join(repo, ".git", "yrd"), config, {
      PATH: globalThis.process.env.PATH,
    })
    const result = await checks.run("probe", repo, {})

    expect(result.exitCode).toBe(0)
    expect(existsSync(orphan), "an entry no `finally` ever reached must not survive a day").toBe(false)
    // The discriminating half. Same prefix, same age, reaped or kept purely on
    // whether git still holds it — so a keep set that silently went empty, or a
    // reap that never consulted one, fails HERE rather than in production on
    // someone's retained failure evidence.
    expect(existsSync(retained), "git still lists this worktree, so age alone must not condemn it").toBe(true)
    expect(existsSync(young), "younger than the age floor").toBe(true)
    expect(existsSync(foreign), "no `check-` prefix, so it was never ours to delete").toBe(true)
  })

  it("sweeps a root once per process, so an invocation running many checks re-walks nothing", async () => {
    const repo = await repository()
    const parent = await preSubmitRoot(repo)
    const first = await abandoned(parent, "check-first", 2 * DAY_MS)

    await using process = createProcess({ cwd: repo })
    const checks = configuredChecks(process, join(repo, ".git", "yrd"), config, {
      PATH: globalThis.process.env.PATH,
    })
    expect((await checks.run("probe", repo, {})).exitCode).toBe(0)
    expect(existsSync(first)).toBe(false)

    const second = await abandoned(parent, "check-second", 2 * DAY_MS)
    expect((await checks.run("probe", repo, {})).exitCode).toBe(0)
    // Identical to `first` in every respect the reaper reads, and it survives:
    // the sweep is a once-per-root backstop paid at the first creation, not a
    // scan every check pays for.
    expect(existsSync(second), "the memo must stop the second check re-walking the root").toBe(true)
  })
})
