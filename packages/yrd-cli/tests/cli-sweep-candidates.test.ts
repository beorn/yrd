/**
 * @failure  `yrd sweep-candidates` / `yrd queue sweep-candidates` sweeps stranded
 *           candidate refs from origin and deletes them with pinned leases (26022).
 * @level    l2 (hermetic git repositories, real remotes, real leased pushes)
 * @consumer queue operator, dark-work watchdog
 * @testonly none
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { createEventQueue, createEventStore, readConfig, submit } from "@yrd/queue-core"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { runYrdProcess } from "../src/cli.ts"
import type { YrdCliExitCode, YrdCliIO } from "../src/types.ts"

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

type Ran = Readonly<{ exitCode: YrdCliExitCode; stdout: string; stderr: string; report: string }>

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

async function createFixture(eventFormat = false) {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-sweep-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])

  const git = gitIn(work)
  await git(["config", "user.email", "queue@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, ".yrd.yml"), "checks:\n  - verify:\n      run: test -f pass.txt\n")
  await git(["add", ".yrd.yml"])
  await git(["commit", "--quiet", "-m", "main declares queue"])
  await git(["push", "--quiet", "origin", "main"])

  if (eventFormat) {
    const head = (await git(["rev-parse", "main"])).trim()
    const config = await readConfig(git, head, { branch: "main", remote: "origin" })
    if (config === undefined) throw new Error("fixture main lost .yrd.yml")
    await createEventQueue(
      createEventStore(work, "origin", git.selection),
      "main",
      head,
      config,
      new Date("2026-09-26T15:00:00.000Z"),
    )
  }

  const createCommit = async (msg: string): Promise<string> => {
    writeFileSync(join(work, `${msg}.txt`), `${msg}\n`)
    await git(["add", "."])
    await git(["commit", "--quiet", "-m", msg])
    return (await git(["rev-parse", "HEAD"])).trim()
  }

  return { root, remote, work, git, createCommit }
}

describe("`yrd sweep-candidates` CLI", () => {
  it("runs dry-run and identifies stranded candidate refs", async () => {
    const { work, git, createCommit } = await createFixture(true)
    const sha1 = await createCommit("c1")
    const sha2 = await createCommit("c2")

    await git(["push", "--quiet", "origin", `${sha1}:refs/heads/yrd/candidates/${sha1}`])
    await git(["push", "--quiet", "origin", `${sha2}:refs/heads/yrd/candidates/${sha2}`])

    const canonical = await yrd(work, "queue", "sweep-candidates", "--dry-run", "--json")
    expect(canonical.exitCode, canonical.report).toBe(0)
    const json = JSON.parse(canonical.stdout) as { scanned: number; reclaimable: number; deleted: string[] }
    expect(json.scanned).toBe(2)
    expect(json.reclaimable).toBe(2)
    expect(json.deleted).toHaveLength(0)

    const alias = await yrd(work, "sweep-candidates", "--dry-run")
    expect(alias.exitCode, alias.report).toBe(0)
    expect(alias.stdout).toContain("scanned 2 candidate refs (0 active, 2 reclaimable; dry run)")
  })

  it("deletes stranded candidate refs on origin", async () => {
    const { work, git, createCommit } = await createFixture(true)
    const sha1 = await createCommit("c1")

    await git(["push", "--quiet", "origin", `${sha1}:refs/heads/yrd/candidates/${sha1}`])

    const run = await yrd(work, "queue", "sweep-candidates")
    expect(run.exitCode, run.report).toBe(0)
    expect(run.stdout).toContain("deleted 1")

    const remoteRefs = await git(["ls-remote", "--refs", "origin", "refs/heads/yrd/candidates/*"])
    expect(remoteRefs.trim()).toBe("")
  })

  it("refuses the sweep when queue inspection fails and deletes nothing", async () => {
    const { work, git, createCommit } = await createFixture()
    const sha1 = await createCommit("c1")

    // Candidate ref on origin
    await git(["push", "--quiet", "origin", `${sha1}:refs/heads/yrd/candidates/${sha1}`])

    // Corrupt the event queue ref with a non-event commit so readEventQueue fails
    await git(["push", "--quiet", "origin", `HEAD:refs/yrd/main/queue`])

    const run = await yrd(work, "queue", "sweep-candidates")
    expect(run.exitCode, run.report).toBe(1)
    expect(run.stderr).toContain("yrd: sweep refused: could not inspect active queue changes:")

    // Candidate ref was NOT deleted
    const remoteRefs = await git(["ls-remote", "--refs", "origin", "refs/heads/yrd/candidates/*"])
    expect(remoteRefs).toContain(`refs/heads/yrd/candidates/${sha1}`)
  })

  it("preserves active candidate refs in event mode while deleting merged ones", async () => {
    const { work, git, createCommit } = await createFixture(true)

    // Submit an active change to the event queue
    await git(["checkout", "--quiet", "-b", "task/queued", "main"])
    writeFileSync(join(work, "pass.txt"), "pass\n")
    await git(["add", "."])
    await git(["commit", "--quiet", "-m", "task/queued event work"])
    const shaQueued = (await git(["rev-parse", "HEAD"])).trim()
    await git(["checkout", "--quiet", "main"])

    await submit(git, "origin", {
      branch: "task/queued",
      submitter: "@dev/10",
      target: { branch: "main", remote: "origin" },
    })

    // Create a non-active (merged/idle) commit
    const shaMerged = await createCommit("merged-event-work")

    // Push two candidate refs for queued change and two for merged change
    await git(["push", "--quiet", "origin", `${shaQueued}:refs/heads/yrd/candidates/${shaQueued}`])
    await git(["push", "--quiet", "origin", `${shaQueued}:refs/yrd/candidates/${shaQueued}`])
    await git(["push", "--quiet", "origin", `${shaMerged}:refs/heads/yrd/candidates/${shaMerged}`])
    await git(["push", "--quiet", "origin", `${shaMerged}:refs/yrd/candidates/${shaMerged}`])

    const run = await yrd(work, "queue", "sweep-candidates")
    expect(run.exitCode, run.report).toBe(0)
    expect(run.stdout).toContain("deleted 2")

    // The queued change's two candidate refs survived
    const remoteRefs = await git([
      "ls-remote",
      "--refs",
      "origin",
      "refs/heads/yrd/candidates/*",
      "refs/yrd/candidates/*",
    ])
    expect(remoteRefs).toContain(`refs/heads/yrd/candidates/${shaQueued}`)
    expect(remoteRefs).toContain(`refs/yrd/candidates/${shaQueued}`)
    // The merged change's refs were deleted
    expect(remoteRefs).not.toContain(shaMerged)
  })

  it("retains candidate refs whose object differs from its name", async () => {
    const { work, git, createCommit } = await createFixture(true)
    const sha1 = await createCommit("c1")
    const sha2 = await createCommit("c2")

    // Push a mismatched ref: name is sha1, but points to sha2
    await git(["push", "--quiet", "origin", `${sha2}:refs/heads/yrd/candidates/${sha1}`])

    const run = await yrd(work, "queue", "sweep-candidates")
    expect(run.exitCode, run.report).toBe(0)
    expect(run.stdout).toContain("deleted 0")

    // Ref should stay retained
    const remoteRefs = await git(["ls-remote", "--refs", "origin", "refs/heads/yrd/candidates/*"])
    expect(remoteRefs).toContain(`refs/heads/yrd/candidates/${sha1}`)
  })
})
