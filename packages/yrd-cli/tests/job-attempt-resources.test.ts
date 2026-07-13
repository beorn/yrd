/**
 * @failure A Yrd Job can inherit ambient runtime state or delete another
 *          attempt's resources during settlement/recovery.
 * @level l2
 * @consumer @yrd/cli job-attempt isolation
 */
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import type { JobAttempt } from "@yrd/job"
import { createJobAttemptResources } from "../src/job-attempt-resources.ts"

const roots: string[] = []
const RUNTIME_LEASE_FIXTURE = fileURLToPath(new URL("./fixtures/job-runtime-lease.ts", import.meta.url))

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("Job attempt resources", () => {
  it("isolates ambient process state under one exact durable attempt root", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "yrd-job-attempts-"))
    roots.push(stateDir)
    const resources = createJobAttemptResources({ stateDir })
    const attempt: JobAttempt = { id: "../../job/with separators", attempt: 2, executor: "worker-1" }

    await resources.prepare(attempt)

    const root = resources.path(attempt)
    expect(root.startsWith(join(stateDir, "attempts"))).toBe(true)
    expect(root).not.toContain("job/with separators")
    expect(resources.environment(attempt)).toEqual({
      YRD_JOB_ROOT: root,
      YRD_JOB_RUNTIME_REGISTRY: `${root}.runtimes`,
      TMPDIR: join(root, "tmp"),
    })
    expect(existsSync(join(root, "tmp"))).toBe(true)
  })

  it("releases only the proven attempt root and is safe to repeat after recovery", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "yrd-job-release-"))
    roots.push(stateDir)
    const resources = createJobAttemptResources({ stateDir })
    const first: JobAttempt = { id: "J1", attempt: 1, executor: "worker-1" }
    const second: JobAttempt = { id: "J1", attempt: 2, executor: "worker-2" }
    await resources.prepare(first)
    await resources.prepare(second)
    await writeFile(join(resources.path(first), "owned.txt"), "first\n")
    await writeFile(join(resources.path(second), "owned.txt"), "second\n")
    const sentinel = join(stateDir, "operator-owned.txt")
    await writeFile(sentinel, "keep\n")

    await resources.release(first)
    await resources.release(first)

    expect(existsSync(resources.path(first))).toBe(false)
    expect(existsSync(resources.path(second))).toBe(true)
    expect(existsSync(sentinel)).toBe(true)
  })

  it("does not finish release until an exact registered runtime finalizes and exits", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "yrd-job-runtime-release-"))
    roots.push(stateDir)
    const resources = createJobAttemptResources({ stateDir })
    const first: JobAttempt = { id: "J-runtime", attempt: 1, executor: "worker-1" }
    const second: JobAttempt = { id: "J-runtime", attempt: 2, executor: "worker-2" }
    await resources.prepare(first)
    await resources.prepare(second)

    const firstRoot = resources.path(first)
    const firstRegistry = `${firstRoot}.runtimes`
    const secondRegistry = `${resources.path(second)}.runtimes`
    const finalizePath = join(stateDir, "finalize-runtime")
    const sentinel = join(stateDir, "operator-owned.txt")
    await writeFile(sentinel, "keep\n")

    expect(resources.environment(first)).toMatchObject({
      YRD_JOB_ROOT: firstRoot,
      YRD_JOB_RUNTIME_REGISTRY: firstRegistry,
    })

    const runtime = spawn(process.execPath, [RUNTIME_LEASE_FIXTURE, firstRegistry, "runtime-a", finalizePath], {
      stdio: ["ignore", "pipe", "pipe"],
    })

    try {
      await waitForReady(runtime)

      let released = false
      const release = resources.release(first).then(() => {
        released = true
      })

      await waitFor(() => !existsSync(firstRoot), 1_000)
      await Bun.sleep(50)
      expect(released, "release returned while its registered runtime still held the lifetime lease").toBe(false)
      expect(existsSync(resources.path(second))).toBe(true)
      expect(existsSync(secondRegistry)).toBe(true)
      expect(existsSync(sentinel)).toBe(true)

      await writeFile(finalizePath, "finalize\n")
      await release
      await waitForExit(runtime)

      expect(existsSync(firstRegistry)).toBe(false)
      expect(existsSync(resources.path(second))).toBe(true)
      expect(existsSync(secondRegistry)).toBe(true)
      expect(existsSync(sentinel)).toBe(true)
      await expect(resources.release(first)).resolves.toBeUndefined()
    } finally {
      if (runtime.exitCode === null && runtime.signalCode === null) runtime.kill("SIGKILL")
      await waitForExit(runtime).catch(() => undefined)
    }
  })
})

async function waitForReady(child: ChildProcess, timeoutMs = 2_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      reject(new Error(`runtime fixture did not become ready (stdout=${stdout}, stderr=${stderr})`))
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
      if (!stdout.includes("READY\n")) return
      clearTimeout(timer)
      resolve()
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once("exit", (code, signal) => {
      if (stdout.includes("READY\n")) return
      clearTimeout(timer)
      reject(
        new Error(`runtime fixture exited before ready (code=${String(code)}, signal=${String(signal)}): ${stderr}`),
      )
    })
  })
}

async function waitForExit(child: ChildProcess, timeoutMs = 2_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`runtime fixture ${String(child.pid)} did not exit`)), timeoutMs)
    timer.unref?.()
    child.once("exit", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition not met before timeout")
    await Bun.sleep(10)
  }
}
