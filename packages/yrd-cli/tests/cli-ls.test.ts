/**
 * @failure  `yrd ls` fails to list and group changes by status (in check,
 *           waiting, draft, ended in the last 24 h) with their issue number,
 *           title, and owner seat, or omits fail-loud empty output.
 * @level    l1
 * @consumer the operator viewing queue changes by issue status
 * @testonly none
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { submit } from "@yrd/queue-core"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { runYrdProcess } from "../src/cli.ts"
import { birthEventQueue } from "./support/event-queue-birth.ts"
import type { YrdCliExitCode, YrdCliIO } from "../src/types.ts"

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

type Ran = Readonly<{ exitCode: YrdCliExitCode; stdout: string; stderr: string; report: string }>

/** The CLI as the shell runs it: argv in, exit code and both streams out. */
async function yrd(cwd: string, ...args: string[]): Promise<Ran> {
  let stdout = ""
  let stderr = ""
  const io: YrdCliIO = {
    color: false,
    cwd,
    stderr(text) {
      stderr += text
    },
    stdout(text) {
      stdout += text
    },
  }
  const exitCode = await runYrdProcess([process.execPath, "/usr/local/bin/yrd", ...args], io)
  return {
    exitCode,
    report: `yrd ${args.join(" ")} exited ${String(exitCode)}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    stderr,
    stdout,
  }
}

/** Set up a queue with an ended (merged) change, a waiting change, and a draft change. */
async function queueWithGroupedChanges(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-ls-"))
  roots.push(root)
  const seed = gitIn(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await git(["config", "user.email", "queue@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, ".yrd.yml"), "checks:\n  - verify:\n      run: test -f pass.txt\n")
  await git(["add", ".yrd.yml"])
  await git(["commit", "--quiet", "-m", "main declares the queue"])
  await git(["push", "--quiet", "origin", "main"])
  await birthEventQueue(work)

  // 1. Change to merge (ended in the last 24 h)
  await git(["checkout", "--quiet", "-b", "task/27043-vitest-fix", "main"])
  writeFileSync(join(work, "pass.txt"), "pass\n")
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "fix(test): reference-count explicit KM_VITEST_RUN_ID (#27043)"])
  await git(["checkout", "--quiet", "main"])
  await submit(git, "origin", {
    branch: "task/27043-vitest-fix",
    submitter: "@dev/agy-other",
    issue:
      "@i/17-test-system/27043-a-focused-vitest-run-with-an-explicit-km_vitest_run_id-fails-in-global-setup-mkdir-eexist",
    target: { branch: "main", remote: "origin" },
  })
  // Run one queue round to merge it
  const round = await yrd(work, "queue", "run", "--json")
  expect(round.exitCode, round.report).toBe(0)
  await git(["fetch", "--quiet", "origin", "main"])

  // 2. Change that stays waiting in line
  await git(["checkout", "--quiet", "-b", "task/27093-ls", "origin/main"])
  writeFileSync(join(work, "feature.txt"), "feature\n")
  writeFileSync(join(work, "pass.txt"), "pass\n")
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "feat(yrd): yrd ls groups changes by status (#27093)"])
  await git(["checkout", "--quiet", "main"])
  await submit(git, "origin", {
    branch: "task/27093-ls",
    submitter: "@dev/5",
    issue: "27093",
    target: { branch: "main", remote: "origin" },
  })

  // 3. Draft change (pushed branch, not submitted)
  await git(["checkout", "--quiet", "-b", "task/27099-draft-work", "origin/main"])
  writeFileSync(join(work, "draft.txt"), "draft\n")
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "wip(draft): some unsubmitted work (#27099)"])
  await git(["push", "--quiet", "origin", "task/27099-draft-work"])
  await git(["checkout", "--quiet", "main"])

  mkdirSync(join(root, "queue"), { recursive: true })
  return work
}

describe("yrd ls", () => {
  it("groups changes by status (in check, waiting, draft, ended in the last 24 h) with issue number, title, and owner", async () => {
    const work = await queueWithGroupedChanges()
    const result = await yrd(work, "ls")
    expect(result.exitCode, result.report).toBe(0)

    // Four groups present in output
    expect(result.stdout).toContain("IN CHECK")
    expect(result.stdout).toContain("WAITING")
    expect(result.stdout).toContain("DRAFT")
    expect(result.stdout).toContain("ENDED IN THE LAST 24 H")

    // Waiting change details
    expect(result.stdout).toContain("#27093")
    expect(result.stdout).toContain("@dev/5")
    expect(result.stdout).toContain("feat(yrd): yrd ls groups changes by status (#27093)")

    // Draft change details
    expect(result.stdout).toContain("#27099")
    expect(result.stdout).toContain("wip(draft): some unsubmitted work (#27099)")

    // Ended change details
    expect(result.stdout).toContain("#27043")
    expect(result.stdout).toContain("@dev/agy-other")
    expect(result.stdout).toContain("fix(test): reference-count explicit KM_VITEST_RUN_ID (#27043)")

    // Empty group says none
    expect(result.stdout).toMatch(/IN CHECK\s*\(0\)\s*\n\s*none/u)

    // Says what it read and where per fail-loud
    expect(result.stdout).toContain("Read event change chains in")
  })

  it("emits structured JSON with --json", async () => {
    const work = await queueWithGroupedChanges()
    const result = await yrd(work, "ls", "--json")
    expect(result.exitCode, result.report).toBe(0)

    const parsed = JSON.parse(result.stdout) as import("../src/queue-ls.ts").QueueLsResult
    expect(parsed).toHaveProperty("groups")
    expect(parsed).toHaveProperty("scope")
    expect(parsed.scope).toContain("Read event change chains in")

    const waiting = parsed.groups.find((g) => g.status === "waiting")
    expect(waiting).toBeDefined()
    if (waiting === undefined) throw new Error("waiting group missing")
    expect(waiting.count).toBe(1)
    expect(waiting.changes[0]).toMatchObject({
      issue: "27093",
      owner: "@dev/5",
      title: "feat(yrd): yrd ls groups changes by status (#27093)",
      branch: "task/27093-ls",
    })

    const ended = parsed.groups.find((g) => g.status === "ended in the last 24 h")
    expect(ended).toBeDefined()
    if (ended === undefined) throw new Error("ended group missing")
    expect(ended.count).toBeGreaterThanOrEqual(1)
    expect(ended.changes[0]).toMatchObject({
      issue: "27043",
      owner: "@dev/agy-other",
      title: "fix(test): reference-count explicit KM_VITEST_RUN_ID (#27043)",
    })

    const draft = parsed.groups.find((g) => g.status === "draft")
    expect(draft).toBeDefined()
    if (draft === undefined) throw new Error("draft group missing")
    expect(draft.count).toBe(1)
    expect(draft.changes[0]).toMatchObject({
      issue: "27099",
      title: "wip(draft): some unsubmitted work (#27099)",
      branch: "task/27099-draft-work",
    })
  })

  it("filters changes by keyword", async () => {
    const work = await queueWithGroupedChanges()
    const result = await yrd(work, "ls", "27093")
    expect(result.exitCode, result.report).toBe(0)

    expect(result.stdout).toContain("#27093")
    expect(result.stdout).not.toContain("#27043")
    expect(result.stdout).not.toContain("#27099")
  })

  it("yrd queue ls is an alias for yrd ls", async () => {
    const work = await queueWithGroupedChanges()
    const result = await yrd(work, "queue", "ls")
    expect(result.exitCode, result.report).toBe(0)
    expect(result.stdout).toContain("WAITING")
    expect(result.stdout).toContain("#27093")
  })

  it("empty queue outputs fail-loud scope and none under every group", async () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-cli-ls-empty-"))
    roots.push(root)
    const seed = gitIn(root)
    const remote = join(root, "remote.git")
    const work = join(root, "work")
    await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
    await seed(["clone", "--quiet", remote, work])
    const git = gitIn(work)
    await git(["config", "user.email", "queue@yrd.test"])
    await git(["config", "user.name", "yrd"])
    await git(["checkout", "--quiet", "-b", "main"])
    writeFileSync(join(work, ".yrd.yml"), "checks:\n  - verify:\n      run: test -f pass.txt\n")
    await git(["add", ".yrd.yml"])
    await git(["commit", "--quiet", "-m", "main declares the queue"])
    await git(["push", "--quiet", "origin", "main"])
    await birthEventQueue(work)

    const result = await yrd(work, "ls")
    expect(result.exitCode, result.report).toBe(0)
    expect(result.stdout).toContain("IN CHECK (0)")
    expect(result.stdout).toContain("WAITING (0)")
    expect(result.stdout).toContain("DRAFT (0)")
    expect(result.stdout).toContain("ENDED IN THE LAST 24 H (0)")
    expect(result.stdout).toContain("Read event change chains in")
  })
})
