/**
 * @failure A resident asked to reload itself in place replaces its process image before its runtime, leases and log are closed, or a failed execve exits in a way its supervisor cannot restart.
 * @level l2
 * @consumer @yrd/cli host
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { failureFact } from "@yrd/core"
import { execYrdProcessInPlace } from "../src/runtime-reload.ts"
import { isYrdRuntimeReloadRequest, requestYrdRuntimeReload } from "../src/run.ts"

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
  it("is a typed control transfer carrying the installed-plan-stale finding", () => {
    const finding = { code: "installed-plan-stale" as const, message: "this process installed check→merge …" }
    const request = (() => {
      try {
        requestYrdRuntimeReload(finding)
      } catch (error) {
        return error
      }
      return undefined
    })()
    expect(isYrdRuntimeReloadRequest(request)).toBe(true)
    expect(request).toMatchObject({ name: "YrdRuntimeReloadRequest", finding })
    expect(isYrdRuntimeReloadRequest(new Error("not a reload"))).toBe(false)
  })

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
})
