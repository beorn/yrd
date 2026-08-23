/**
 * @failure The step plan a Run executes comes from a copy the process cached at startup rather than from the config at the commit it merges onto, so a merged `.yrd.yml` change never takes effect and a Run cannot say which config judged it.
 * @level l2
 * @consumer @yrd/cli host
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createProcess } from "@yrd/process"
import { failureFact } from "@yrd/core"
import { readDeclaredPlanAtBase } from "../src/host.ts"

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

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-declared-plan-"))
  roots.push(root)
  const repo = join(root, "repo")
  await git(root, "init", "-q", "-b", "main", repo)
  await git(repo, "config", "user.name", "Yrd Test")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  return repo
}

async function commitConfig(repo: string, yaml: string, message: string): Promise<string> {
  await writeFile(join(repo, ".yrd.yml"), yaml)
  await git(repo, "add", ".yrd.yml")
  await git(repo, "commit", "-qm", message)
  return git(repo, "rev-parse", "HEAD")
}

const ONE_CHECK = 'base: main\nbatch: 1\nchecks:\n  - {typecheck: {run: "true"}}\n'
const TWO_CHECKS =
  'base: main\nbatch: 1\nchecks:\n  - {typecheck: {run: "true"}}\n  - {affected-tests: {run: "true"}}\n'

describe("the step plan is read from git at the Run's base sha", () => {
  it("answers per base sha, so a merged config change is in force for the next Run", async () => {
    const repo = await repository()
    await using process = createProcess({ cwd: repo })
    const before = await commitConfig(repo, ONE_CHECK, "one check")
    const after = await commitConfig(repo, TWO_CHECKS, "declare affected-tests")

    const older = await readDeclaredPlanAtBase(process, repo, before, ".yrd.yml")
    const newer = await readDeclaredPlanAtBase(process, repo, after, ".yrd.yml")

    expect(older.steps).toEqual(["typecheck", "merge"])
    // The whole point of 23192: the check the base now declares is IN the plan,
    // with no restart and no --steps, because the plan is read at the sha the
    // Run merges onto rather than recalled from durable state.
    expect(newer.steps).toEqual(["typecheck", "affected-tests", "merge"])
    expect(newer.configBlobSha).not.toBe(older.configBlobSha)
    expect(newer.configBlobSha).toMatch(/^[0-9a-f]{40}$/u)

    // Re-reading the OLDER sha still answers the older plan: the reader is a
    // function of the commit, not of what the branch happens to point at now.
    expect((await readDeclaredPlanAtBase(process, repo, before, ".yrd.yml")).steps).toEqual(["typecheck", "merge"])
  })

  it("refuses a base that carries no queue config instead of inventing an empty plan", async () => {
    const repo = await repository()
    await using process = createProcess({ cwd: repo })
    await writeFile(join(repo, "README.md"), "no config here\n")
    await git(repo, "add", "README.md")
    await git(repo, "commit", "-qm", "no queue config")
    const baseSha = await git(repo, "rev-parse", "HEAD")

    const error = await readDeclaredPlanAtBase(process, repo, baseSha, ".yrd.yml").then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(failureFact(error)?.code).toBe("queue-config-missing-at-base")
    const message = error instanceof Error ? error.message : String(error)
    expect(message).toContain(baseSha.slice(0, 8))
    expect(message).toContain(".yrd.yml")
  })
})
