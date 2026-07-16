/**
 * @failure The installed baseline goes stale silently: `yrd queue audit` reports clean and expensive Runs start after the selected repository config changed.
 * @level l2
 * @consumer @yrd/cli host
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { InstalledStep } from "@yrd/queue"
import { createYrdHost } from "../src/host.ts"
import { requireFreshInstalledBaseline } from "../src/run.ts"
import {
  installedBaselineDrift,
  installedBaselinePath,
  installedBaselineRemedy,
  readInstalledBaselines,
  removeInstalledBaseline,
  writeInstalledBaseline,
  type InstalledBaseline,
} from "../src/installed-baseline.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function step(name: string, revision: string, overrides: Partial<InstalledStep> = {}): InstalledStep {
  return { name, title: name, revision, integrates: false, needsIntegration: false, ...overrides }
}

function baseline(steps: readonly InstalledStep[], base = "main"): InstalledBaseline {
  return {
    base,
    baseSha: "0123456789abcdef0123456789abcdef01234567",
    installedAt: "2026-07-15T00:00:00.000Z",
    steps,
  }
}

describe("installed baseline drift", () => {
  it("reports no drift when the current steps match the installed baseline", () => {
    const steps = [step("check", "check-v1"), step("merge", "merge-v1", { integrates: true })]
    expect(installedBaselineDrift(baseline(steps), steps)).toBeUndefined()
  })

  it("collapses every delta into one config-drift finding with the migration remedy", () => {
    const installed = [step("check", "22adf838".padEnd(64, "0")), step("review", "review-v1"), step("merge", "merge-v1")]
    const current = [step("check", "e5f6a7b8".padEnd(64, "0")), step("merge", "merge-v1"), step("deploy", "deploy-v1")]
    const finding = installedBaselineDrift(baseline(installed), current)
    expect(finding).toMatchObject({ code: "config-drift" })
    expect(finding?.message).toContain("step 'check' revision '22adf838' installed, current 'e5f6a7b8'")
    expect(finding?.message).toContain("step 'review' (installed revision 'review-v1') is no longer configured")
    expect(finding?.message).toContain("step 'deploy' (current revision 'deploy-v1') is not in the installed baseline")
    expect(finding?.message).toContain(installedBaselineRemedy("main"))
  })

  it("flags an integration-contract change even when the revision is unchanged", () => {
    const installed = [step("merge", "merge-v1", { integrates: true, needsIntegration: false })]
    const current = [step("merge", "merge-v1", { integrates: false, needsIntegration: true })]
    expect(installedBaselineDrift(baseline(installed), current)?.message).toContain(
      "step 'merge' integration contract changed",
    )
  })
})

describe("installed baseline persistence", () => {
  it("reads an absent installed baseline as empty", async () => {
    expect(await readInstalledBaselines(await tempDir("yrd-baseline-"))).toEqual({})
  })

  it("round-trips baselines per base and deletes the file with the last base", async () => {
    const stateDir = await tempDir("yrd-baseline-")
    await writeInstalledBaseline(stateDir, baseline([step("check", "check-v1")]))
    await writeInstalledBaseline(stateDir, baseline([step("check", "check-v1")], "release/2.0"))
    const baselines = await readInstalledBaselines(stateDir)
    expect(Object.keys(baselines).sort()).toEqual(["main", "release/2.0"])
    expect(await removeInstalledBaseline(stateDir, "release/2.0")).toBe(true)
    expect(Object.keys(await readInstalledBaselines(stateDir))).toEqual(["main"])
    expect(await removeInstalledBaseline(stateDir, "missing")).toBe(false)
    expect(await removeInstalledBaseline(stateDir, "main")).toBe(true)
    expect(await readInstalledBaselines(stateDir)).toEqual({})
  })

  it("fails loud on a malformed installed baseline", async () => {
    const stateDir = await tempDir("yrd-baseline-")
    await writeFile(installedBaselinePath(stateDir), "not json", "utf8")
    await expect(readInstalledBaselines(stateDir)).rejects.toThrow(/installed baseline .* is not JSON/u)
    await writeFile(installedBaselinePath(stateDir), JSON.stringify({ version: 2 }), "utf8")
    await expect(readInstalledBaselines(stateDir)).rejects.toThrow(/installed baseline .* is malformed/u)
  })
})

describe("run gate", () => {
  it("refuses to start runs on config drift and passes through other findings", async () => {
    await expect(
      requireFreshInstalledBaseline({
        queue: {
          auditEnvironment: async () => ({ findings: [{ code: "config-drift", message: "stale baseline" }] }),
        },
      }),
    ).rejects.toThrow(/stale baseline/u)
    await requireFreshInstalledBaseline({})
    await requireFreshInstalledBaseline({
      queue: { auditEnvironment: async () => ({ findings: [{ code: "operator-finding", message: "inspect" }] }) },
    })
  })
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

async function queueRepository(check: string): Promise<string> {
  const root = await tempDir("yrd-baseline-host-")
  const repo = join(root, "repo")
  await git(root, "init", "-q", "-b", "main", repo)
  await git(repo, "config", "user.name", "Yrd Test")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await writeFile(join(repo, ".yrd.yml"), `base: main\nbatch: 1\nsteps: [check, merge]\ncheck: "${check}"\nmerge: {}\n`)
  await git(repo, "add", ".yrd.yml")
  await git(repo, "commit", "-qm", "queue config")
  return repo
}

describe("host installed baseline", () => {
  it("provision persists the baseline, audit stays clean, config change drifts, deinit migrates", async () => {
    const repo = await queueRepository("true")
    const host = await createYrdHost({ cwd: repo })
    try {
      await host.services.queue?.provision?.("main")
      const stored = await readFile(installedBaselinePath(host.repository.stateDir), "utf8")
      expect(JSON.parse(stored)).toMatchObject({ version: 1, baselines: { main: { base: "main" } } })
      expect(await host.services.queue?.auditEnvironment?.()).toEqual({ findings: [] })
    } finally {
      await host.close()
    }

    await writeFile(
      join(repo, ".yrd.yml"),
      'base: main\nbatch: 1\nsteps: [check, merge]\ncheck: "false"\nmerge: {}\n',
    )
    const drifted = await createYrdHost({ cwd: repo })
    try {
      const result = await drifted.services.queue?.auditEnvironment?.()
      expect(result?.findings).toMatchObject([{ code: "config-drift" }])
      expect(result?.findings[0]?.message).toContain("step 'check' revision")
      expect(result?.findings[0]?.message).toContain(installedBaselineRemedy("main"))
      await expect(requireFreshInstalledBaseline(drifted.services)).rejects.toThrow(/config drift|installed baseline is stale/u)
      const deprovisioned = (await drifted.services.queue?.deprovision?.("main")) as { released: string[] }
      expect(deprovisioned.released).toEqual(["installed-baseline"])
      expect(await drifted.services.queue?.auditEnvironment?.()).toEqual({ findings: [] })
      await drifted.services.queue?.provision?.("main")
      expect(await drifted.services.queue?.auditEnvironment?.()).toEqual({ findings: [] })
      await requireFreshInstalledBaseline(drifted.services)
    } finally {
      await drifted.close()
    }
  })
})
