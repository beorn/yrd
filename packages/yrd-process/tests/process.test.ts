import { describe, expect, it } from "vitest"
import { createProcess, type Spawn } from "@yrd/process"

function bytes(value: string): ReadableStream<Uint8Array> {
  return new Blob([value]).stream()
}

describe("Process", () => {
  it("runs argv without a shell and returns one stable result shape", async () => {
    await using process = createProcess({ env: { PATH: Bun.env.PATH, GIT_DIR: "leak", YRD_JOB: "leak" } })
    const result = await process.run({
      argv: ["sh", "-c", 'printf "%s:%s" "$GIT_DIR" "$YRD_JOB"; printf error >&2'],
    })
    const isolated = await process.run({
      argv: ["sh", "-c", 'printf "%s:%s" "$GIT_DIR" "$YRD_JOB"'],
      env: { PATH: Bun.env.PATH, YRD_JOB: "job-1" },
    })

    expect(result).toMatchObject({ exitCode: 0, stdout: "leak:leak", stderr: "error", timedOut: false })
    expect(isolated.stdout).toBe(":job-1")
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("owns timeout and cancellation through its Scope", async () => {
    await using process = createProcess({ env: { PATH: Bun.env.PATH } })
    const result = await process.run({ argv: ["sh", "-c", "sleep 10"], timeoutMs: 10 })

    expect(result.timedOut).toBe(true)
    expect(result.signal).not.toBeNull()
  })

  it("links an external cancellation signal to the child process", async () => {
    await using process = createProcess({ env: { PATH: Bun.env.PATH } })
    const controller = new AbortController()
    const running = process.run({ argv: ["sh", "-c", "sleep 10"], signal: controller.signal })
    controller.abort()

    const result = await running
    expect(result).toMatchObject({ timedOut: false })
    expect(result.signal).not.toBeNull()
  })

  it("bounds captured stdout and terminates a process that exceeds it", async () => {
    const killed: NodeJS.Signals[] = []
    const spawn: Spawn = () => ({
      stdout: bytes("too much output"),
      stderr: bytes(""),
      exited: Promise.resolve(0),
      signalCode: null,
      kill(signal = "SIGTERM") {
        killed.push(signal as NodeJS.Signals)
      },
    })
    await using process = createProcess({ maxOutputBytes: 4, inject: { spawn } })

    await expect(process.run({ argv: ["noisy"] })).rejects.toThrow("stdout exceeded 4 bytes")
    expect(killed).toContain("SIGTERM")
  })

  it("escalates timed-out children from SIGTERM to SIGKILL after the grace period", async () => {
    const killed: NodeJS.Signals[] = []
    const spawn: Spawn = () => ({
      stdout: bytes(""),
      stderr: bytes(""),
      exited: new Promise((resolve) => setTimeout(() => resolve(137), 25)),
      signalCode: "SIGKILL",
      kill(signal = "SIGTERM") {
        killed.push(signal as NodeJS.Signals)
      },
    })
    await using process = createProcess({ killGraceMs: 1, inject: { spawn } })

    const result = await process.run({ argv: ["stubborn"], timeoutMs: 1 })

    expect(result.timedOut).toBe(true)
    expect(killed).toEqual(["SIGTERM", "SIGKILL"])
  })

  it("refuses work after close", async () => {
    const process = createProcess()
    await process.close()
    await expect(process.run({ argv: ["printf", "never"] })).rejects.toThrow("closed")
  })
})
