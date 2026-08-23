/**
 * @failure `queue audit` iterates an absent installed baseline as an empty object and reports no drift, so an absence of INPUT is indistinguishable from an absence of drift and the one instrument that would have caught a diverged check set certifies clean.
 * @level l2
 * @consumer @yrd/cli host
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { failureFact } from "@yrd/core"
import { createYrdHost } from "../src/host.ts"
import { queueAuditComparisonLine, requireFreshInstalledBaseline } from "../src/run.ts"
import { installedBaselinePath, readInstalledBaselines } from "../src/installed-baseline.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

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

async function queueRepository(): Promise<string> {
  const root = await tempDir("yrd-baseline-absent-")
  const repo = join(root, "repo")
  await git(root, "init", "-q", "-b", "main", repo)
  await git(repo, "config", "user.name", "Yrd Test")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await writeFile(join(repo, ".yrd.yml"), 'base: main\nbatch: 1\nchecks:\n  - {check: {run: "true"}}\n')
  // `createGitPushReceiver` resolves its managed hook entry from the DECLARED
  // main repository and refuses when it has none, so an active host cannot be
  // built over a bare fixture repository without one.
  await mkdir(join(repo, "bin"), { recursive: true })
  await writeFile(join(repo, "bin", "yrd"), "#!/usr/bin/env bun\n")
  await git(repo, "add", ".yrd.yml", "bin/yrd")
  await git(repo, "commit", "-qm", "queue config")
  return repo
}

describe("an absent installed baseline is not an empty one", () => {
  it("reports the absence and the path it looked at, instead of an empty result", async () => {
    const stateDir = await tempDir("yrd-baseline-absent-read-")
    expect(await readInstalledBaselines(stateDir)).toEqual({
      path: installedBaselinePath(stateDir),
      present: false,
      baselines: {},
    })
  })

  it("refuses the environment audit, naming the resolved path and the creating command", async () => {
    const repo = await queueRepository()
    const host = await createYrdHost({ cwd: repo })
    try {
      const error = await host.services.queue?.auditEnvironment?.().then(
        (value) => value as unknown,
        (reason: unknown) => reason,
      )
      expect(failureFact(error)?.code).toBe("installed-baseline-missing")
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain(installedBaselinePath(host.repository.stateDir))
      expect(message).toContain("yrd admin queue init main")
    } finally {
      await host.close()
    }
  })

  it("blocks the run gate on the same absence rather than passing vacuously", async () => {
    const repo = await queueRepository()
    const host = await createYrdHost({ cwd: repo })
    try {
      const error = await requireFreshInstalledBaseline(host.services).then(
        () => undefined,
        (reason: unknown) => reason,
      )
      expect(failureFact(error)?.code).toBe("installed-baseline-missing")
    } finally {
      await host.close()
    }
  })

  it("states the denominator once a baseline exists, so a zero is a result", async () => {
    const repo = await queueRepository()
    const host = await createYrdHost({ cwd: repo })
    try {
      await host.services.queue?.provision?.("main")
      const audit = await host.services.queue?.auditEnvironment?.()
      expect(audit?.findings).toEqual([])
      expect(audit?.comparison).toMatchObject({
        baselinePath: installedBaselinePath(host.repository.stateDir),
        baselines: 1,
        bases: ["main"],
      })
      expect(audit?.comparison.against).toContain("configured")
    } finally {
      await host.close()
    }
  })

  it("prints a different line for a compared zero than for an unwired environment leg", () => {
    const compared = queueAuditComparisonLine({
      baselinePath: "/state/installed-baseline.json",
      baselines: 1,
      bases: ["main"],
      against: ["configured", "runtime"],
    })
    expect(compared).toContain("1 installed baseline")
    expect(compared).toContain("main")
    expect(compared).toContain("/state/installed-baseline.json")
    expect(queueAuditComparisonLine(undefined)).not.toBe(compared)
    expect(queueAuditComparisonLine(undefined)).toMatch(/not wired|no queue administration/iu)
  })
})
