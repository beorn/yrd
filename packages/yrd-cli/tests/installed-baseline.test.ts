/**
 * @failure The installed baseline goes stale silently: `yrd queue audit` reports clean and expensive Runs start after the selected repository config changed.
 * @level l2
 * @consumer @yrd/cli host
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { InstalledStep } from "@yrd/queue"
import { createYrdHost } from "../src/host.ts"
import { requireFreshInstalledBaseline, watchQueueRuns } from "../src/run.ts"
import type { YrdCliApp, YrdCliIO } from "../src/types.ts"
import {
  installedBaselineDrift,
  installedBaselinePath,
  installedBaselineRemedy,
  readInstalledBaselines,
  removeInstalledBaseline,
  runtimeBaselineDrift,
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

  it("names the runtime leg with the restart remedy when the running process diverges from the baseline (merge-queue R41b)", () => {
    const installed = [step("check", "v2"), step("merge", "v2", { integrates: true })]
    expect(runtimeBaselineDrift(baseline(installed), installed)).toBeUndefined()
    const finding = runtimeBaselineDrift(baseline(installed), [
      step("check", "v1"),
      step("merge", "v2", { integrates: true }),
    ])
    expect(finding).toMatchObject({ code: "runtime-drift" })
    expect(finding?.message).toContain("resident runtime diverges from the installed baseline")
    expect(finding?.message).toContain("step 'check' revision 'v2' installed, runtime 'v1'")
    expect(finding?.message).toContain("Restart this queue runner process")
  })

  it("reports drift when the same steps are reordered (revisions exclude order)", () => {
    const installed = [step("check", "check-v1"), step("merge", "merge-v1", { integrates: true })]
    const current = [step("merge", "merge-v1", { integrates: true }), step("check", "check-v1")]
    const finding = installedBaselineDrift(baseline(installed), current)
    expect(finding).toMatchObject({ code: "config-drift" })
    expect(finding?.message).toContain("step order changed: installed check→merge, current merge→check")
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

  it("serializes concurrent writes and removes without losing a surviving baseline", async () => {
    const stateDir = await tempDir("yrd-baseline-")
    await writeInstalledBaseline(stateDir, baseline([step("check", "check-v1")], "main"))
    // Provision two more bases and deinit the first, all interleaved: the
    // exclusive lock + temp-file rename must let every survivor persist and the
    // authority file must always parse (never a torn/partial write).
    await Promise.all([
      writeInstalledBaseline(stateDir, baseline([step("check", "check-v2")], "release/2.0")),
      writeInstalledBaseline(stateDir, baseline([step("check", "check-v3")], "release/3.0")),
      removeInstalledBaseline(stateDir, "main"),
    ])
    const baselines = await readInstalledBaselines(stateDir)
    expect(Object.keys(baselines).sort()).toEqual(["release/2.0", "release/3.0"])
    const raw = await readFile(installedBaselinePath(stateDir), "utf8")
    expect(() => JSON.parse(raw) as unknown).not.toThrow()
  })

  async function expectNoBaselineTempFiles(stateDir: string): Promise<void> {
    const entries = await readdir(stateDir)
    expect(
      entries.filter((name) => name.startsWith("installed-baseline.json.") && name.endsWith(".tmp")),
    ).toEqual([])
  }

  it("leaves the prior authority byte-identical and cleans temp when the staging write fails", async () => {
    const stateDir = await tempDir("yrd-baseline-")
    await writeInstalledBaseline(stateDir, baseline([step("check", "check-v1")], "main"))
    const before = await readFile(installedBaselinePath(stateDir), "utf8")
    // Inject a staging write that throws after the authority already exists: the
    // rename never runs, so the live file must be untouched and still parse, and
    // no partial temp may linger. (A non-atomic direct-write impl would corrupt it.)
    await expect(
      writeInstalledBaseline(stateDir, baseline([step("check", "check-v2")], "release/2.0"), {
        writeFile: async () => {
          throw new Error("simulated staging write failure")
        },
      }),
    ).rejects.toThrow(/simulated staging write failure/u)
    const after = await readFile(installedBaselinePath(stateDir), "utf8")
    expect(after).toBe(before)
    expect(() => JSON.parse(after) as unknown).not.toThrow()
    await expectNoBaselineTempFiles(stateDir)
  })

  it("leaves the prior authority byte-identical and cleans temp when the rename fails", async () => {
    const stateDir = await tempDir("yrd-baseline-")
    await writeInstalledBaseline(stateDir, baseline([step("check", "check-v1")], "main"))
    const before = await readFile(installedBaselinePath(stateDir), "utf8")
    // Inject a rename that throws AFTER the temp file was fully written: the live
    // file must still be the prior authority (rename is what would swap it in),
    // parse cleanly, and the written-but-unrenamed temp must be swept.
    await expect(
      writeInstalledBaseline(stateDir, baseline([step("check", "check-v2")], "release/2.0"), {
        rename: async () => {
          throw new Error("simulated rename failure")
        },
      }),
    ).rejects.toThrow(/simulated rename failure/u)
    const after = await readFile(installedBaselinePath(stateDir), "utf8")
    expect(after).toBe(before)
    expect(() => JSON.parse(after) as unknown).not.toThrow()
    await expectNoBaselineTempFiles(stateDir)
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

  it("fails loud when queue administration is wired without an audit capability", async () => {
    // A host that wires queue administration but omits auditEnvironment would give
    // the gate nothing to prove; it must refuse loudly, not grant free passage.
    await expect(requireFreshInstalledBaseline({ queue: { provision: async () => ({}) } })).rejects.toThrow(
      /queue\.audit capability is not installed/u,
    )
  })

  it("stays a no-op when no queue administration is wired at all", async () => {
    // Embedded / no-administration hosts (and CLI paths passing no services) keep
    // the legacy no-op: absent administration is a valid shape, missing audit is not.
    await requireFreshInstalledBaseline({})
  })

  it("re-proves the installed baseline before every watch cycle", async () => {
    let gateCalls = 0
    let runCalls = 0
    const app = {
      scope: { signal: { aborted: false }, sleep: async () => undefined },
      queue: {
        run: async () => {
          runCalls += 1
          return []
        },
      },
    } as unknown as YrdCliApp
    const io = { stdout: () => undefined, stderr: () => undefined } as unknown as YrdCliIO
    const gate = async (): Promise<void> => {
      gateCalls += 1
      // Simulate a config change detected on the second cycle.
      if (gateCalls >= 2) throw new Error("installed baseline drifted mid-watch")
    }
    await expect(watchQueueRuns(app, [], { json: true, interval: 1 }, io, gate)).rejects.toThrow(/drifted mid-watch/u)
    // Gate ran on cycle 1 (before the run) and again on cycle 2 (which refused
    // before any run started): proves per-cycle re-proof, gate-before-run.
    expect(gateCalls).toBe(2)
    expect(runCalls).toBe(1)
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

  it("audits the RUNTIME leg: a v1 resident fails after another process migrates baseline and disk to v2 (merge-queue R41b)", async () => {
    const repo = await queueRepository("true")
    const resident = await createYrdHost({ cwd: repo })
    try {
      await resident.services.queue?.provision?.("main")
      // Three-way equal (runtime == baseline == disk) → clean.
      expect(await resident.services.queue?.auditEnvironment?.()).toEqual({ findings: [] })

      // Disk moves to v2 while runtime and baseline stay v1: the DISK leg —
      // exactly ONE finding with the migration remedy (existing class).
      await writeFile(
        join(repo, ".yrd.yml"),
        'base: main\nbatch: 1\nsteps: [check, merge]\ncheck: "false"\nmerge: {}\n',
      )
      const diskLeg = await resident.services.queue?.auditEnvironment?.()
      expect(diskLeg?.findings).toMatchObject([{ code: "config-drift" }])
      expect(diskLeg?.findings[0]?.message).toContain(installedBaselineRemedy("main"))

      // A second administration migrates the installed baseline to v2 (the
      // prescribed deinit/init) while the v1 resident keeps running. Its own
      // three legs agree, so ITS audit is clean.
      const migrator = await createYrdHost({ cwd: repo })
      try {
        await migrator.services.queue?.deprovision?.("main")
        await migrator.services.queue?.provision?.("main")
        expect(await migrator.services.queue?.auditEnvironment?.()).toEqual({ findings: [] })
      } finally {
        await migrator.close()
      }

      // Baseline == disk (both v2), but THIS resident's runtime still executes
      // v1 steps. The audit must fail on the RUNTIME leg — a baseline==disk
      // comparison alone certifies a lie.
      const runtimeLeg = await resident.services.queue?.auditEnvironment?.()
      expect(runtimeLeg?.findings).toMatchObject([{ code: "runtime-drift" }])
      expect(runtimeLeg?.findings[0]?.message).toContain("runtime")
      expect(runtimeLeg?.findings[0]?.message).toContain("step 'check' revision")
      // And the run gate refuses to start runs on it.
      await expect(requireFreshInstalledBaseline(resident.services)).rejects.toThrow(/runtime/u)
    } finally {
      await resident.close()
    }
  })

  it("deinit clears a stored baseline whose base ref was deleted, even under drift", async () => {
    const repo = await queueRepository("true")
    await git(repo, "branch", "stale/base")
    const host = await createYrdHost({ cwd: repo })
    try {
      await host.services.queue?.provision?.("stale/base")
      expect(await host.services.queue?.auditEnvironment?.()).toEqual({ findings: [] })
    } finally {
      await host.close()
    }

    // Delete the provisioned base ref AND change the check config so the stored
    // baseline is both un-resolvable and drifted — exactly the wedge that used
    // to block `queue deinit` (its own prescribed remedy) via a throwing inspect.
    await git(repo, "branch", "-D", "stale/base")
    await writeFile(join(repo, ".yrd.yml"), 'base: main\nbatch: 1\nsteps: [check, merge]\ncheck: "false"\nmerge: {}\n')

    const after = await createYrdHost({ cwd: repo })
    try {
      const audit = await after.services.queue?.auditEnvironment?.()
      expect(audit?.findings).toMatchObject([{ code: "config-drift" }])
      const deprovisioned = (await after.services.queue?.deprovision?.("stale/base")) as {
        released: string[]
        baseSha: string
      }
      expect(deprovisioned.released).toEqual(["installed-baseline"])
      expect(deprovisioned.baseSha).toMatch(/^[0-9a-f]{40}$/u)
      expect(await after.services.queue?.auditEnvironment?.()).toEqual({ findings: [] })
      await requireFreshInstalledBaseline(after.services)
    } finally {
      await after.close()
    }
  })
})
