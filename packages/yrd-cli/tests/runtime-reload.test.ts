/**
 * @failure A habitant asked to reload itself in place replaces its process image before its runtime, leases and log are closed, or a failed execve exits in a way its supervisor cannot restart.
 * @level l2
 * @consumer @yrd/cli host
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { failureFact } from "@yrd/core"
import {
  MAX_CONSECUTIVE_RUNTIME_RELOADS,
  YRD_RUNTIME_RELOADS_ENV,
  consecutiveRuntimeReloads,
  execYrdProcessInPlace,
  runtimeReloadLineage,
  withRuntimeReloads,
} from "../src/runtime-reload.ts"
import {
  isYrdRuntimeReloadRequest,
  requestYrdRuntimeReload,
  requireInstalledDeclaredPlan,
  runtimeReloadEnv,
} from "../src/run.ts"
import type { YrdCliServices } from "../src/types.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

describe("in-place runtime reload", () => {
  it("is a typed control transfer carrying the installed-plan-stale finding and the replacement's count", () => {
    const finding = { code: "installed-plan-stale" as const, message: "this process installed check→merge …" }
    const request = (() => {
      try {
        requestYrdRuntimeReload(finding, 2)
      } catch (error) {
        return error
      }
      return undefined
    })()
    expect(isYrdRuntimeReloadRequest(request)).toBe(true)
    expect(request).toMatchObject({ name: "YrdRuntimeReloadRequest", finding, reloads: 2 })
    expect(isYrdRuntimeReloadRequest(new Error("not a reload"))).toBe(false)
    // The host execs the replacement with the same env plus its place in the
    // lineage, which is the only thing that lets the replacement count too.
    if (!isYrdRuntimeReloadRequest(request)) throw new Error("expected a reload request")
    expect(runtimeReloadEnv({ PATH: "/usr/bin", YRD_RUNTIME_RELOADS: "1" }, request)).toEqual({
      PATH: "/usr/bin",
      YRD_RUNTIME_RELOADS: "2",
    })
  })

  it("reads the lineage count from the exec env, absent as zero, and refuses a corrupt one", () => {
    expect(consecutiveRuntimeReloads({})).toBe(0)
    expect(consecutiveRuntimeReloads({ [YRD_RUNTIME_RELOADS_ENV]: "" })).toBe(0)
    expect(consecutiveRuntimeReloads({ [YRD_RUNTIME_RELOADS_ENV]: "3" })).toBe(3)
    expect(consecutiveRuntimeReloads(withRuntimeReloads({}, 1))).toBe(1)
    expect(() => consecutiveRuntimeReloads({ [YRD_RUNTIME_RELOADS_ENV]: "three" })).toThrow(
      /YRD_RUNTIME_RELOADS='three' is not a non-negative integer/u,
    )
    expect(() => withRuntimeReloads({}, 0)).toThrow(RangeError)
  })

  it("bounds consecutive reloads: three stale gates in a row reload, the fourth refuses instead of exec'ing", async () => {
    // A fake execve: each reload request "replaces" the process by
    // re-creating the lineage from the env the host would have exec'd with.
    const stale = {
      code: "installed-plan-stale" as const,
      message: "yrd: this process installed check→merge, but main tip declares check→second→merge",
    }
    let findings: readonly { code: string; message: string }[] = [stale]
    const services: YrdCliServices = {
      queue: {
        auditEnvironment: async () => ({
          findings: findings as never,
          comparison: {
            base: "main",
            tip: {
              sha: "b".repeat(40),
              configAuthority: ".yrd.yml",
              configBlobSha: "2".repeat(40),
              steps: ["check", "second", "merge"],
              batchSize: 1,
            },
            installed: { source: "this-process", steps: ["check", "merge"], batchSize: 1 },
          },
        }),
      },
    }
    let env: NodeJS.ProcessEnv = { PATH: "/usr/bin" }
    let lineage = runtimeReloadLineage(env)
    const execs: number[] = []
    const gate = () =>
      requireInstalledDeclaredPlan(services, {
        reloadInPlace: {
          lineage,
          request: (finding, reloads) => {
            expect(finding).toEqual(stale)
            execs.push(reloads)
            throw new Error(`execve replaced the process as reload ${String(reloads)}`)
          },
        },
      })
    const reexec = (reloads: number): void => {
      env = withRuntimeReloads(env, reloads)
      lineage = runtimeReloadLineage(env)
    }

    for (const expected of [1, 2, 3]) {
      await expect(gate()).rejects.toThrow(`execve replaced the process as reload ${String(expected)}`)
      expect(execs.at(-1)).toBe(expected)
      reexec(expected)
    }
    expect(lineage.consecutiveReloads).toBe(MAX_CONSECUTIVE_RUNTIME_RELOADS)

    // The fourth stale gate in a row is a refusal, not an exec: it names the
    // tip, the blob, the count and the by-hand cure.
    const exhausted = await gate().then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(failureFact(exhausted)).toMatchObject({ kind: "refusal", code: "installed-plan-reload-exhausted" })
    const message = exhausted instanceof Error ? exhausted.message : String(exhausted)
    expect(message).toContain("exec'd in place 3 times in a row (YRD_RUNTIME_RELOADS=3)")
    expect(message).toContain(`main tip ${"b".repeat(8)} (config blob ${"2".repeat(8)})`)
    expect(message).toContain("A 4th reload would loop forever")
    expect(message).toContain("restart the habitant by hand")
    expect(execs).toEqual([1, 2, 3])

    // A cycle that completes without a stale finding ends the chain: the next
    // stale gate reloads as number one again.
    findings = []
    await gate()
    expect(lineage.consecutiveReloads).toBe(0)
    findings = [stale]
    await expect(gate()).rejects.toThrow("execve replaced the process as reload 1")
    expect(execs).toEqual([1, 2, 3, 1])
  })

  it("closes the habitant runtime before replacing the exact process image", async () => {
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
      message: "yrd: habitant runtime reload failed: ENOENT: immutable entry disappeared",
    })
  })

  it("a failed exec leaves the exact habitant argv restartable by its supervisor", async () => {
    const root = await tempDir("yrd-reload-restart-")
    const marker = join(root, "attempts.log")
    const worker = join(root, "habitant.ts")
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
})
