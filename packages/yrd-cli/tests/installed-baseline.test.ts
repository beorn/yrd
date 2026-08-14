/**
 * @failure The installed baseline goes stale silently: `yrd queue audit` reports clean and expensive Runs start after the selected repository config changed.
 * @level l2
 * @consumer @yrd/cli host
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { InstalledStep } from "@yrd/queue"
import { failureFact } from "@yrd/core"
import { createYrdHost } from "../src/host.ts"
import { uncarriedLine } from "../src/queue-status-view.tsx"
import {
  followQueueRuns,
  requestYrdRuntimeReload,
  requireFreshInstalledBaseline,
  residentRunnerStatus,
} from "../src/run.ts"
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
import { queueStepRevision } from "../src/host-revision.ts"
import { createResidentHarness } from "./support/resident-harness.ts"
import { execYrdProcessInPlace } from "../src/runtime-reload.ts"

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
  return { name, title: name, revision, kind: "check", ...overrides }
}

function baseline(steps: readonly InstalledStep[], base = "main"): InstalledBaseline & Readonly<{ batchSize: number }> {
  return {
    base,
    baseSha: "0123456789abcdef0123456789abcdef01234567",
    installedAt: "2026-07-15T00:00:00.000Z",
    batchSize: 1,
    steps,
  }
}

const queueDescriptor = (steps: readonly InstalledStep[], batchSize = 1) => ({ batchSize, steps })

function historicalV3NativeMergeRevision(env?: Readonly<Record<string, string>>): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        implementation: "yrd-native-merge-v3",
        repo: "/repo",
        stateDir: "/repo/.git/yrd",
        name: "merge",
        runner: "local",
        env,
        classification: "carrier",
        mode: "delta",
        timeoutMs: 60_000,
        noProgressMs: 600_000,
        toolchain: { bun: "1.3.11", node: "24.0.0", platform: "darwin", arch: "arm64" },
      }),
    )
    .digest("hex")
}

describe("installed baseline drift", () => {
  it("treats effective batch policy as part of both config and runtime drift", () => {
    const steps = [step("check", "check-v1"), step("merge", "merge-v1", { kind: "merge" })]
    const installed = { ...baseline(steps), batchSize: 5 }

    const configDrift = installedBaselineDrift(installed, queueDescriptor(steps, 10))
    expect(configDrift).toMatchObject({ code: "config-drift" })
    expect(configDrift?.message).toContain("batch size 5 installed, current 10")

    const runtimeDrift = runtimeBaselineDrift(installed, queueDescriptor(steps, 1))
    expect(runtimeDrift).toMatchObject({ code: "runtime-drift" })
    expect(runtimeDrift?.message).toContain("batch size 5 installed, runtime 1")

    expect(installedBaselineDrift(installed, queueDescriptor(steps, 5))).toBeUndefined()
    expect(runtimeBaselineDrift(installed, queueDescriptor(steps, 5))).toBeUndefined()
  })

  it("fails loud when a legacy baseline has no recorded batch policy", () => {
    const steps = [step("check", "check-v1"), step("merge", "merge-v1", { kind: "merge" })]
    const { batchSize: _batchSize, ...legacy } = baseline(steps)

    const finding = installedBaselineDrift(legacy, queueDescriptor(steps))

    expect(finding).toMatchObject({ code: "config-drift" })
    expect(finding?.message).toContain("batch size is absent from the installed baseline, current 1")
    expect(finding?.message).toContain("Run 'yrd admin queue deinit main' then 'yrd admin queue init main'")
  })

  it("reports no drift when the current steps match the installed baseline", () => {
    const steps = [step("check", "check-v1"), step("merge", "merge-v1", { kind: "merge" })]
    expect(installedBaselineDrift(baseline(steps), queueDescriptor(steps))).toBeUndefined()
  })

  it("collapses every delta into one config-drift finding with the migration remedy", () => {
    const installed = [
      step("check", "22adf838".padEnd(64, "0")),
      step("review", "review-v1"),
      step("merge", "merge-v1"),
    ]
    const current = [step("check", "e5f6a7b8".padEnd(64, "0")), step("merge", "merge-v1"), step("deploy", "deploy-v1")]
    const finding = installedBaselineDrift(baseline(installed), queueDescriptor(current))
    expect(finding).toMatchObject({ code: "config-drift" })
    expect(finding?.message).toContain("step 'check' revision '22adf838' installed, current 'e5f6a7b8'")
    expect(finding?.message).toContain("step 'review' (installed revision 'review-v1') is no longer configured")
    expect(finding?.message).toContain("step 'deploy' (current revision 'deploy-v1') is not in the installed baseline")
    expect(finding?.message).toContain(installedBaselineRemedy("main"))
  })

  it("flags an integration-contract change even when the revision is unchanged", () => {
    const installed = [step("merge", "merge-v1", { kind: "merge" })]
    const current = [step("merge", "merge-v1", { kind: "action" })]
    expect(installedBaselineDrift(baseline(installed), queueDescriptor(current))?.message).toContain(
      "step 'merge' integration contract changed",
    )
  })

  it("names the runtime leg with the restart remedy when the running process diverges from the baseline (merge-queue R41b)", () => {
    const installed = [step("check", "v2"), step("merge", "v2", { kind: "merge" })]
    expect(runtimeBaselineDrift(baseline(installed), queueDescriptor(installed))).toBeUndefined()
    const finding = runtimeBaselineDrift(
      baseline(installed),
      queueDescriptor([step("check", "v1"), step("merge", "v2", { kind: "merge" })]),
    )
    expect(finding).toMatchObject({ code: "runtime-drift" })
    expect(finding?.message).toContain("resident runtime diverges from the installed baseline")
    expect(finding?.message).toContain("step 'check' revision 'v2' installed, runtime 'v1'")
    expect(finding?.message).toContain("Restart this queue runner process")
  })

  it("does not treat the runner source pin as part of the native merge contract", () => {
    const input = {
      repo: "/repo",
      stateDir: "/repo/.git/yrd",
      name: "merge",
      config: { runner: "local" },
      timeoutMs: 60_000,
      noProgressMs: 600_000,
      toolchain: { bun: "1.3.11", node: "24.0.0", platform: "darwin", arch: "arm64" },
    } as const
    const loadedSource = "git:35562d1579f140669a453b310340582b8cc1b42f"
    const pinnedSource = "git:748dbd87dd6a30a5d4f41de4459b01d8014d791f"
    const revision = queueStepRevision(input)
    const installed = [step("merge", revision, { kind: "merge", implementationSource: pinnedSource })]
    const staleRuntime = [step("merge", revision, { kind: "merge", implementationSource: loadedSource })]

    expect(installedBaselineDrift(baseline(staleRuntime), queueDescriptor(installed))).toBeUndefined()
    expect(runtimeBaselineDrift(baseline(installed), queueDescriptor(staleRuntime))).toBeUndefined()
  })

  it("keeps the native merge generation transition observable to older residents", () => {
    const staleRuntime = [
      step("merge", historicalV3NativeMergeRevision(), {
        kind: "merge",
      }),
    ]
    const migrated = [
      step(
        "merge",
        historicalV3NativeMergeRevision({
          NATIVE_MERGE_IMPLEMENTATION: "post-landing-component-main-v1",
        }),
        { kind: "merge" },
      ),
    ]

    expect(runtimeBaselineDrift(baseline(migrated), queueDescriptor(staleRuntime))).toMatchObject({
      code: "runtime-drift",
      message: expect.stringContaining("Restart this queue runner process"),
    })
  })

  it("reports drift when the same steps are reordered (revisions exclude order)", () => {
    const installed = [step("check", "check-v1"), step("merge", "merge-v1", { kind: "merge" })]
    const current = [step("merge", "merge-v1", { kind: "merge" }), step("check", "check-v1")]
    const finding = installedBaselineDrift(baseline(installed), queueDescriptor(current))
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
    expect(entries.filter((name) => name.startsWith("installed-baseline.json.") && name.endsWith(".tmp"))).toEqual([])
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
  it("closes the resident runtime before replacing the exact process image", async () => {
    const calls: string[] = []
    const replacement = new Error("execve replaced the process")
    const execPath = "/usr/bin/bun"
    const argv = [execPath, "/immutable/yrd.ts", "queue", "run"]
    const env = { PATH: "/usr/bin", YRD_REPO: "/repo" }

    const failure = await execYrdProcessInPlace({
      closeRuntime: async () => {
        calls.push("close-runtime")
      },
      removeShutdownSignals: () => {
        calls.push("remove-signals")
      },
      closeLog: () => {
        calls.push("close-log")
      },
      execPath,
      argv,
      env,
      execve: (execPath, execArgv, execEnv) => {
        calls.push("execve")
        expect({ execPath, execArgv, execEnv }).toEqual({ execPath, execArgv: argv, execEnv: env })
        throw replacement
      },
    }).catch((error: unknown) => error)
    expect(failureFact(failure)).toMatchObject({
      kind: "infrastructure",
      code: "runtime-reload-exec-failed",
    })
    expect(failure).toMatchObject({ cause: replacement })
    expect(calls).toEqual(["close-runtime", "remove-signals", "close-log", "execve"])
  })

  it("classifies a failed execve as a loud infrastructure failure", async () => {
    const failure = await execYrdProcessInPlace({
      closeRuntime: async () => undefined,
      removeShutdownSignals: () => undefined,
      closeLog: () => undefined,
      execPath: "/missing/bun",
      argv: ["/missing/bun", "/immutable/yrd.ts", "queue", "run"],
      env: {},
      execve: () => {
        throw new Error("ENOENT: immutable entry disappeared")
      },
    }).catch((error: unknown) => error)

    expect(failureFact(failure)).toEqual({
      kind: "infrastructure",
      code: "runtime-reload-exec-failed",
      message: "yrd: resident runtime reload failed: ENOENT: immutable entry disappeared",
    })
  })

  it("a failed exec leaves the exact resident argv restartable by its supervisor", async () => {
    const root = await tempDir("yrd-reload-restart-")
    const marker = join(root, "attempts.log")
    const worker = join(root, "resident.ts")
    const runtimeReloadUrl = new URL("../src/runtime-reload.ts", import.meta.url).href
    await writeFile(
      worker,
      `import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { execYrdProcessInPlace } from ${JSON.stringify(runtimeReloadUrl)}
const marker = ${JSON.stringify(marker)}
const prior = existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\\n").filter(Boolean).length : 0
appendFileSync(marker, "started\\n")
if (prior === 0) {
  await execYrdProcessInPlace({
    closeRuntime: async () => undefined,
    removeShutdownSignals: () => undefined,
    closeLog: () => undefined,
    execPath: process.execPath,
    argv: process.argv,
    env: process.env,
    execve: () => { throw new Error("simulated execve ENOENT") },
  })
}
appendFileSync(marker, "ready\\n")
`,
      "utf8",
    )
    const argv = [process.execPath, worker]

    const first = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" })
    expect(await first.exited).not.toBe(0)
    expect(await new Response(first.stderr).text()).toContain("runtime-reload-exec-failed")

    const replacement = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" })
    expect(await replacement.exited, await new Response(replacement.stderr).text()).toBe(0)
    expect(await readFile(marker, "utf8")).toBe("started\nstarted\nready\n")
  })

  it("follow-mode re-provisions on config-drift via provision() and continues (22306)", async () => {
    // The resident must not exit on config-drift — re-install through the same
    // provision path as `queue init` (one descriptor recipe; 22334) and continue.
    const lifecycle: string[] = []
    let findings: { code: string; message: string }[] = [
      { code: "config-drift", message: "installed baseline is stale" },
    ]
    const services = {
      queue: {
        auditEnvironment: async () => ({ findings }),
        deprovision: async (base: string) => {
          lifecycle.push(`deinit:${base}`)
          return { base, released: ["installed-baseline"] }
        },
        provision: async (base: string) => {
          lifecycle.push(`init:${base}`)
          findings = []
          return { base }
        },
      },
    } as unknown as Parameters<typeof requireFreshInstalledBaseline>[0]

    await requireFreshInstalledBaseline(services, { reloadInPlace: { base: "main" } })
    expect(lifecycle).toEqual(["init:main"])
  })

  it("one-shot without reloadInPlace still refuses config-drift (no silent rewrite)", async () => {
    const lifecycle: string[] = []
    await expect(
      requireFreshInstalledBaseline({
        queue: {
          auditEnvironment: async () => ({ findings: [{ code: "config-drift", message: "stale baseline" }] }),
          provision: async (base: string) => {
            lifecycle.push(`init:${base}`)
            return { base }
          },
        },
      }),
    ).rejects.toMatchObject({
      failure: { kind: "refusal", code: "config-drift", message: "stale baseline" },
    })
    expect(lifecycle).toEqual([])
    await requireFreshInstalledBaseline({})
    await requireFreshInstalledBaseline({
      queue: { auditEnvironment: async () => ({ findings: [{ code: "operator-finding", message: "inspect" }] }) },
    })
  })

  it("runtime-drift requests an in-place process reload in follow mode", async () => {
    const lifecycle: string[] = []
    const reloadRequested = new Error("reload requested")
    await expect(
      requireFreshInstalledBaseline(
        {
          queue: {
            auditEnvironment: async () => ({
              findings: [{ code: "runtime-drift", message: "runtime steps diverge" }],
            }),
            provision: async (base: string) => {
              lifecycle.push(`init:${base}`)
              return { base }
            },
          },
        },
        {
          reloadInPlace: {
            base: "main",
            request: (finding) => {
              lifecycle.push("reload")
              expect(finding).toEqual({ code: "runtime-drift", message: "runtime steps diverge" })
              throw reloadRequested
            },
          },
        },
      ),
    ).rejects.toBe(reloadRequested)
    expect(lifecycle).toEqual(["reload"])
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
    const harness = createResidentHarness({ run: async () => [] })
    const gate = async (): Promise<void> => {
      gateCalls += 1
      // Simulate a config change detected on the second cycle.
      if (gateCalls >= 2) throw new Error("installed baseline drifted mid-watch")
    }
    await expect(followQueueRuns(harness.app, [], { json: true, interval: 1 }, harness.io, gate)).rejects.toThrow(
      /drifted mid-watch/u,
    )
    // Gate ran on cycle 1 (before the run) and again on cycle 2 (which refused
    // before any run started): proves per-cycle re-proof, gate-before-run.
    expect(gateCalls).toBe(2)
    expect(harness.runCalls()).toBe(1)
  })

  it("records runtime drift in the resident heartbeat before unwinding for reload", async () => {
    const repo = await queueRepository("true")
    const headSha = await git(repo, "rev-parse", "HEAD")
    const harness = createResidentHarness({ run: async () => [] })
    Object.assign(harness.io, {
      cwd: repo,
      repositoryRoot: repo,
      runner: "yrd-cli:reload-evidence",
      implementationSource: `git:${headSha}`,
    })
    const finding = { code: "runtime-drift", message: "loaded runtime no longer matches the baseline" } as const

    await expect(
      followQueueRuns(harness.app, [], { json: true, interval: 1 }, harness.io, async () => {
        requestYrdRuntimeReload(finding)
      }),
    ).rejects.toMatchObject({ name: "YrdRuntimeReloadRequest" })
    await expect(residentRunnerStatus(repo)).resolves.toMatchObject({
      clean: false,
      queueProgress: { state: "stalled", observedAt: expect.any(String), findings: [finding] },
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
  await writeFile(join(repo, ".yrd.yml"), `base: main\nbatch: 1\nchecks:\n  - {check: {run: "${check}"}}\n`)
  await git(repo, "add", ".yrd.yml")
  await git(repo, "commit", "-qm", "queue config")
  return repo
}

describe("host installed baseline", () => {
  it("round-trips old and current uncarried observations through resident status", async () => {
    const repo = await queueRepository("true")
    const statusPath = join(repo, ".git", "yrd", "resident-runner", "status.json")
    await mkdir(join(statusPath, ".."), { recursive: true })
    const baseStatus = {
      pid: process.pid,
      startedAt: "2026-08-13T20:00:00.000Z",
      lastTickAt: "2026-08-13T20:01:00.000Z",
      implementationSource: `git:${"a".repeat(40)}`,
    }

    await writeFile(
      statusPath,
      `${JSON.stringify({
        ...baseStatus,
        uncarried: { count: 2, scanned: 50, missingUpdateClocks: 7, observedAt: "2026-08-13T20:00:30.000Z" },
      })}\n`,
      "utf8",
    )
    const current = await residentRunnerStatus(repo)
    expect(current?.uncarried).toEqual({
      count: 2,
      scanned: 50,
      missingUpdateClocks: 7,
      observedAt: "2026-08-13T20:00:30.000Z",
    })
    expect(uncarriedLine(current?.uncarried, Date.parse(baseStatus.lastTickAt))).toContain(
      "7 refs without retained update clocks",
    )

    await writeFile(
      statusPath,
      `${JSON.stringify({
        ...baseStatus,
        uncarried: { count: 0, scanned: 50, observedAt: "2026-08-13T20:00:30.000Z" },
      })}\n`,
      "utf8",
    )
    const legacy = await residentRunnerStatus(repo)
    expect(uncarriedLine(legacy?.uncarried, Date.parse(baseStatus.lastTickAt))).toContain("push-clock coverage unknown")

    for (const uncarried of [
      { count: 51, scanned: 50, missingUpdateClocks: 0, observedAt: "2026-08-13T20:00:30.000Z" },
      { count: 40, scanned: 50, missingUpdateClocks: 20, observedAt: "2026-08-13T20:00:30.000Z" },
    ]) {
      await writeFile(statusPath, `${JSON.stringify({ ...baseStatus, uncarried })}\n`, "utf8")
      await expect(residentRunnerStatus(repo)).rejects.toMatchObject({
        failure: { code: "resident-runner-status-invalid" },
      })
    }
  })

  it("follow-mode heals foreign baseline drift via the same provision path as queue init (22306/22334)", async () => {
    const repo = await queueRepository("true")
    const resident = await createYrdHost({ cwd: repo })
    try {
      await resident.services.queue?.provision?.("main")
      const current = (await readInstalledBaselines(resident.repository.stateDir)).main
      if (current?.batchSize === undefined) throw new Error("expected current provisioned main baseline")
      const foreign = {
        ...current,
        batchSize: current.batchSize,
        installedAt: "2026-07-24T00:00:00.000Z",
        steps: current.steps.map((installed, index) => ({
          ...installed,
          revision: `${index}`.repeat(64),
        })),
      }
      await writeInstalledBaseline(resident.repository.stateDir, foreign)

      const before = await resident.services.queue?.auditEnvironment?.()
      expect(before?.findings).toMatchObject([{ code: "config-drift" }])

      // Follow gate re-provisions through the one true descriptor path — not a
      // second revision family — and the audit is clean afterwards.
      await requireFreshInstalledBaseline(resident.services, { reloadInPlace: { base: "main" } })
      expect(await resident.services.queue?.auditEnvironment?.()).toEqual({ findings: [] })
      const healed = (await readInstalledBaselines(resident.repository.stateDir)).main
      expect(healed?.steps.map((s) => s.revision)).toEqual(current.steps.map((s) => s.revision))
    } finally {
      await resident.close()
    }
  })

  it("re-provisions a batch-only config drift and requests an in-place runtime reload", async () => {
    const repo = await queueRepository("true")
    const resident = await createYrdHost({ cwd: repo })
    const reloadRequested = new Error("reload requested")
    try {
      await resident.services.queue?.provision?.("main")
      expect(await resident.services.queue?.auditEnvironment?.()).toEqual({ findings: [] })

      await writeFile(join(repo, ".yrd.yml"), 'base: main\nbatch: 2\nchecks:\n  - {check: {run: "true"}}\n')
      await git(repo, "add", ".yrd.yml")
      await git(repo, "commit", "-qm", "change only batch policy")

      const configLeg = await resident.services.queue?.auditEnvironment?.()
      expect(configLeg?.findings).toMatchObject([{ code: "config-drift" }])
      expect(configLeg?.findings[0]?.message).toContain("batch size 1 installed, current 2")

      await expect(
        requireFreshInstalledBaseline(resident.services, {
          reloadInPlace: {
            base: "main",
            request(finding) {
              expect(finding).toMatchObject({ code: "runtime-drift" })
              expect(finding.message).toContain("batch size 2 installed, runtime 1")
              throw reloadRequested
            },
          },
        }),
      ).rejects.toBe(reloadRequested)

      expect((await readInstalledBaselines(resident.repository.stateDir)).main?.batchSize).toBe(2)
    } finally {
      await resident.close()
    }
  })

  it("one-shot leaves foreign baseline untouched until explicit queue init (22334)", async () => {
    const repo = await queueRepository("true")
    const host = await createYrdHost({ cwd: repo })
    try {
      await host.services.queue?.provision?.("main")
      const current = (await readInstalledBaselines(host.repository.stateDir)).main
      if (current?.batchSize === undefined) throw new Error("expected current provisioned main baseline")
      const foreign = {
        ...current,
        batchSize: current.batchSize,
        installedAt: "2026-07-24T00:00:00.000Z",
        steps: current.steps.map((installed, index) => ({
          ...installed,
          revision: `${index}`.repeat(64),
        })),
      }
      await writeInstalledBaseline(host.repository.stateDir, foreign)

      await expect(requireFreshInstalledBaseline(host.services)).rejects.toMatchObject({
        failure: { kind: "refusal", code: "config-drift" },
      })
      const after = (await readInstalledBaselines(host.repository.stateDir)).main
      expect(after?.steps.map((s) => s.revision)).toEqual(foreign.steps.map((s) => s.revision))
    } finally {
      await host.close()
    }
  })

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

    await writeFile(join(repo, ".yrd.yml"), 'base: main\nbatch: 1\nchecks:\n  - {check: {run: "false"}}\n')
    await git(repo, "add", ".yrd.yml")
    await git(repo, "commit", "-qm", "change queue config")
    const drifted = await createYrdHost({ cwd: repo })
    try {
      const result = await drifted.services.queue?.auditEnvironment?.()
      expect(result?.findings).toMatchObject([{ code: "config-drift" }])
      expect(result?.findings[0]?.message).toContain("step 'check' revision")
      expect(result?.findings[0]?.message).toContain(installedBaselineRemedy("main"))
      await expect(requireFreshInstalledBaseline(drifted.services)).rejects.toThrow(
        /config drift|installed baseline is stale/u,
      )
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
      await writeFile(join(repo, ".yrd.yml"), 'base: main\nbatch: 1\nchecks:\n  - {check: {run: "false"}}\n')
      await git(repo, "add", ".yrd.yml")
      await git(repo, "commit", "-qm", "change queue config")
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
    await writeFile(join(repo, ".yrd.yml"), 'base: main\nbatch: 1\nchecks:\n  - {check: {run: "false"}}\n')
    await git(repo, "add", ".yrd.yml")
    await git(repo, "commit", "-qm", "change queue config")

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
