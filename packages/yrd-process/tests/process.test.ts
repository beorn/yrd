/**
 * @failure Child processes can outlive their Scope, buffer unbounded output, or report incomplete termination evidence.
 * @level l1
 * @consumer @yrd/process
 */
import { describe, expect, it, vi } from "vitest"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLogger, type Event as LogEvent } from "loggily"
import { createProcess, shellCommand, type Spawn } from "@yrd/process"

function bytes(value: string): ReadableStream<Uint8Array> {
  return new Blob([value]).stream()
}

describe("Process", () => {
  it("resolves bare executables from the environment supplied to the child", async () => {
    const bin = await mkdtemp(join(tmpdir(), "yrd-process-path-"))
    try {
      const executable = join(bin, "fixture-command")
      await writeFile(executable, "#!/bin/sh\nprintf fixture-path")
      await chmod(executable, 0o755)
      await using process = createProcess({ env: { PATH: bin } })

      await expect(process.run({ argv: ["fixture-command"] })).resolves.toMatchObject({
        exitCode: 0,
        stdout: "fixture-path",
      })
    } finally {
      await rm(bin, { recursive: true, force: true })
    }
  })

  it("closes each process span with terminal outcome and measured duration", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using process = createProcess({
      env: { PATH: Bun.env.PATH },
      inject: { log },
    })

    await expect(process.run({ argv: ["printf", "ok"] })).resolves.toMatchObject({ exitCode: 0 })

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "span",
        namespace: "yrd:process:run",
        props: expect.objectContaining({ outcome: "succeeded", durationMs: expect.any(Number) }),
      }),
    )
    log.end()
  })

  it("runs argv directly and makes shell parsing explicit", async () => {
    await using process = createProcess({ env: { PATH: Bun.env.PATH, GIT_DIR: "leak", YRD_JOB: "leak" } })
    const direct = await process.run({ argv: ["printf", "%s", "$GIT_DIR;$(not-expanded)"] })
    const result = await process.run({
      argv: shellCommand('printf "%s:%s" "$GIT_DIR" "$YRD_JOB"; printf error >&2'),
    })
    const isolated = await process.run({
      argv: shellCommand('printf "%s:%s" "$GIT_DIR" "$YRD_JOB"'),
      env: { PATH: Bun.env.PATH, YRD_JOB: "job-1" },
    })

    expect(direct.stdout).toBe("$GIT_DIR;$(not-expanded)")
    expect(result).toMatchObject({ exitCode: 0, stdout: "leak:leak", stderr: "error", timedOut: false })
    expect(isolated.stdout).toBe(":job-1")
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    await expect(process.run({ argv: "printf unsafe" as never })).rejects.toThrow("argv")
  })

  it("inherits terminal stdio without detaching interactive children", async () => {
    let observed: Parameters<Spawn>[1] | undefined
    const spawn: Spawn = (_argv, options) => {
      observed = options
      return {
        pid: 4242,
        stdout: bytes(""),
        stderr: bytes(""),
        exited: Promise.resolve(0),
        signalCode: null,
        kill() {},
      }
    }
    await using process = createProcess({ inject: { spawn } })

    const result = await process.run({ argv: ["editor"], interactive: true })

    expect(observed).toMatchObject({
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      detached: false,
    })
    expect(result).toMatchObject({ exitCode: 0, stdout: "", stderr: "" })
  })

  it("can inherit piped input while retaining captured output and process-group ownership", async () => {
    let observed: Parameters<Spawn>[1] | undefined
    const spawn: Spawn = (_argv, options) => {
      observed = options
      return {
        pid: 4242,
        stdout: bytes("output"),
        stderr: bytes(""),
        exited: Promise.resolve(0),
        signalCode: null,
        kill() {},
      }
    }
    await using process = createProcess({ inject: { spawn } })

    const result = await process.run({ argv: ["filter"], inheritStdin: true })

    expect(observed).toMatchObject({
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    })
    expect(result).toMatchObject({ exitCode: 0, stdout: "output" })
    await expect(process.run({ argv: ["filter"], inheritStdin: true, stdin: "buffered" })).rejects.toThrow(
      "cannot inherit stdin and provide buffered input",
    )
    await expect(process.run({ argv: ["filter"], inheritStdin: true, interactive: true })).rejects.toThrow(
      "cannot combine inheritStdin with interactive",
    )
  })

  it("reports the spawned child PID before awaiting its exit", async () => {
    const exited = Promise.withResolvers<number>()
    const events: string[] = []
    const spawn: Spawn = () => {
      events.push("spawn")
      return {
        pid: 4242,
        stdout: bytes(""),
        stderr: bytes(""),
        exited: exited.promise,
        signalCode: null,
        kill() {},
      }
    }
    await using process = createProcess({ inject: { spawn } })

    const running = process.run({
      argv: ["worker"],
      onStart(pid) {
        events.push(`start:${pid}`)
      },
    })
    try {
      await vi.waitFor(() => expect(events).toEqual(["spawn", "start:4242"]))
    } finally {
      exited.resolve(0)
    }

    await expect(running).resolves.toMatchObject({ exitCode: 0 })
  })

  it("settles the child before propagating an onStart observer failure", async () => {
    const exited = Promise.withResolvers<number>()
    const kills: NodeJS.Signals[] = []
    const spawn: Spawn = () => ({
      pid: 4242,
      stdout: bytes(""),
      stderr: bytes(""),
      exited: exited.promise,
      signalCode: "SIGTERM",
      kill(signal = "SIGTERM") {
        kills.push(signal as NodeJS.Signals)
        exited.resolve(143)
      },
    })
    await using process = createProcess({ inject: { spawn } })

    await expect(
      process.run({
        argv: ["worker"],
        onStart() {
          throw new Error("observer failed")
        },
      }),
    ).rejects.toThrow("observer failed")
    expect(kills).toEqual(["SIGTERM"])
  })

  it("owns timeout and cancellation through its Scope", async () => {
    await using process = createProcess({ env: { PATH: Bun.env.PATH } })
    const result = await process.run({ argv: shellCommand("sleep 10"), timeoutMs: 10 })

    expect(result.timedOut).toBe(true)
    expect(result.signal).not.toBeNull()
  })

  it("links an external cancellation signal to the child process", async () => {
    await using process = createProcess({ env: { PATH: Bun.env.PATH } })
    const controller = new AbortController()
    const running = process.run({ argv: shellCommand("sleep 10"), signal: controller.signal })
    controller.abort()

    const result = await running
    expect(result).toMatchObject({ timedOut: false })
    expect(result.signal).not.toBeNull()
  })

  it("settles active runs, including SIGKILL escalation, before close resolves", async () => {
    const kills: NodeJS.Signals[] = []
    const exited = Promise.withResolvers<number>()
    const spawn: Spawn = () => ({
      pid: 4242,
      stdout: bytes(""),
      stderr: bytes(""),
      exited: exited.promise,
      signalCode: "SIGKILL",
      kill(signal = "SIGTERM") {
        kills.push(signal as NodeJS.Signals)
      },
    })
    const process = createProcess({ killGraceMs: 1, inject: { spawn } })
    const running = process.run({ argv: ["stubborn"] })
    let closed = false
    const close = process.close().then(() => {
      closed = true
    })
    try {
      await vi.waitFor(() => expect(kills).toEqual(["SIGTERM", "SIGKILL"]))
      expect(closed).toBe(false)
    } finally {
      exited.resolve(137)
    }

    await close
    expect(closed).toBe(true)
    await expect(running).resolves.toMatchObject({ exitCode: 137 })
  })

  it("bounds captured stdout and terminates a process that exceeds it", async () => {
    const killed: NodeJS.Signals[] = []
    const spawn: Spawn = () => ({
      pid: 4242,
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
      pid: 4242,
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
