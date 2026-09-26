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
import { gitIn } from "@yrd/queue-core"
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

async function createFixture() {
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
    const { work, git, createCommit } = await createFixture()
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
    const { work, git, createCommit } = await createFixture()
    const sha1 = await createCommit("c1")

    await git(["push", "--quiet", "origin", `${sha1}:refs/heads/yrd/candidates/${sha1}`])

    const run = await yrd(work, "queue", "sweep-candidates")
    expect(run.exitCode, run.report).toBe(0)
    expect(run.stdout).toContain("deleted 1")

    const remoteRefs = await git(["ls-remote", "--refs", "origin", "refs/heads/yrd/candidates/*"])
    expect(remoteRefs.trim()).toBe("")
  })
})
