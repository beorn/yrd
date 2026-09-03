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
import { createProcess, failureEvent, shellCommand, type Spawn } from "@yrd/process"

const silentLog = createLogger("test", [{ level: "silent" }])

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

  it("names the command, its exit code and its duration in the finished message", async () => {
    // Negative control: this line read exactly "Command finished." for every
    // process Yrd ran — a thousand identical rows whose subject, outcome and
    // cost lived only in the JSON payload. The message assertion below fails
    // against that rendering; the payload assertion holds under both, because
    // promoting a field into the headline must never move it out of `props`.
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using process = createProcess({ env: { PATH: Bun.env.PATH }, inject: { log } })

    await expect(process.run({ argv: ["printf", "%s", "one two"] })).resolves.toMatchObject({ exitCode: 0 })

    const finished = events.find(
      (event): event is Extract<LogEvent, { kind: "log" }> =>
        event.kind === "log" && event.namespace === "yrd:process" && event.message.startsWith("Command finished"),
    )
    // `<duration>ms [<exit>] <command>`, with the word that needs quoting
    // quoted, so the row can be read back as the command that ran.
    expect(finished?.message).toMatch(/^Command finished \d+ms \[0\] printf %s "one two"$/u)
    expect(finished?.props).toEqual(
      expect.objectContaining({ argv: ["printf", "%s", "one two"], exitCode: 0, durationMs: expect.any(Number) }),
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

  it("refuses new work with a typed, classifiable failure once closed", async () => {
    const process = createProcess({ env: { PATH: Bun.env.PATH } })
    await process.close()

    const error = await process.run({ argv: ["printf", "ok"] }).then(
      () => undefined,
      (cause: unknown) => cause,
    )

    // Typed, not a bare Error: a caller racing this pool's own shutdown — the
    // habitant runner's mid-cycle recovery classifier chief among them — must
    // be able to recognize "the pool already closed" and stop cleanly instead
    // of treating an expected refusal as an unclassified, fatal fault
    // (2026-08-31 SIGINT teardown race, operator terminal).
    expect(failureEvent(error)).toMatchObject({ kind: "infrastructure", code: "process-closed" })
    expect((error as Error).message).toBe("yrd: Process is closed")
  })

  // Output VOLUME is not a correctness signal. This cap used to THROW, which
  // propagated out of run() and killed the long-lived queue runner: restarts 257
  // through 261 on 2026-08-28, four of them exit code 3, each losing whatever
  // check was in flight (`job-lost`). One verbose Vitest run took the merge queue
  // down for every seat. The cap now truncates and the command still finishes.
  it("truncates a flooding stream instead of killing the child, and keeps its real exit status", async () => {
    const killed: NodeJS.Signals[] = []
    const spawn: Spawn = () => ({
      pid: 4242,
      stdout: bytes("HEAD-abcdefghijklmnopqrstuvwxyz-TAIL"),
      stderr: bytes(""),
      exited: Promise.resolve(7),
      signalCode: null,
      kill(signal = "SIGTERM") {
        killed.push(signal as NodeJS.Signals)
      },
    })
    await using process = createProcess({ maxOutputBytes: 12, inject: { spawn, log: silentLog } })

    const result = await process.run({ argv: ["noisy"] })

    expect(result.exitCode).toBe(7)
    expect(killed).toEqual([])
    expect(result.stdout).toContain("HEAD-a")
    expect(result.stdout).toContain("z-TAIL")
    expect(result.stdout).not.toContain("jklmnopq")
  })

  it("states the dropped byte count in the output a reader sees", async () => {
    const output = "x".repeat(1000)
    const spawn: Spawn = () => ({
      pid: 4242,
      stdout: bytes(output),
      stderr: bytes(""),
      exited: Promise.resolve(0),
      signalCode: null,
      kill() {},
    })
    await using process = createProcess({ maxOutputBytes: 100, inject: { spawn, log: silentLog } })

    const { stdout } = await process.run({ argv: ["noisy"] })

    // The arithmetic is checked against the bytes actually returned, not against
    // a number the notice asserts about itself: a drop notice that can disagree
    // with its own text is the silent truncation this whole change exists to
    // prevent (docs/principles.md § Fail Loud, Fail Now).
    const notice =
      /\n\n\[yrd: stdout truncated — (\d+) bytes dropped here\. The command wrote (\d+) bytes, past the (\d+)-byte capture limit, so only (\d+) bytes are kept[^\]]*\]\n\n/.exec(
        stdout,
      )
    expect(notice).not.toBeNull()
    const [, dropped, total, limit, kept] = notice as RegExpExecArray
    expect(Number(total)).toBe(1000)
    expect(Number(limit)).toBe(100)
    expect(Number(kept)).toBe(100)
    expect(Number(dropped)).toBe(900)
    expect(Number(dropped) + Number(kept)).toBe(Number(total))
    // Stripping the whole notice, blank lines included, must leave exactly the
    // retained bytes and nothing else.
    expect(stdout.replace(notice?.[0] as string, "")).toHaveLength(100)
  })

  it("reports the truncation as a structured event as well as in the text", async () => {
    const spawn: Spawn = () => ({
      pid: 4242,
      stdout: bytes("y".repeat(500)),
      stderr: bytes(""),
      exited: Promise.resolve(0),
      signalCode: null,
      kill() {},
    })
    await using process = createProcess({ maxOutputBytes: 40, inject: { spawn, log: silentLog } })

    const result = await process.run({ argv: ["noisy"] })

    expect(result.outputTruncation).toEqual([
      { stream: "stdout", totalBytes: 500, keptBytes: 40, droppedBytes: 460, limitBytes: 40 },
    ])
  })

  it("gives stdout and stderr independent budgets and reports each one", async () => {
    const spawn: Spawn = () => ({
      pid: 4242,
      stdout: bytes("o".repeat(300)),
      stderr: bytes("e".repeat(200)),
      exited: Promise.resolve(1),
      signalCode: null,
      kill() {},
    })
    await using process = createProcess({ maxOutputBytes: 50, inject: { spawn, log: silentLog } })

    const result = await process.run({ argv: ["noisy"] })

    // Independent, not shared: a chatty stdout must not shrink the stderr
    // budget, because stderr is where the failure a reader needs usually is.
    expect(result.outputTruncation).toEqual([
      { stream: "stdout", totalBytes: 300, keptBytes: 50, droppedBytes: 250, limitBytes: 50 },
      { stream: "stderr", totalBytes: 200, keptBytes: 50, droppedBytes: 150, limitBytes: 50 },
    ])
    expect(result.stdout).toContain("stdout truncated")
    expect(result.stderr).toContain("stderr truncated")
  })

  it("leaves output at or under the limit byte-identical and unannotated", async () => {
    const spawn: Spawn = () => ({
      pid: 4242,
      stdout: bytes("exactly-32-bytes-of-plain-output"),
      stderr: bytes(""),
      exited: Promise.resolve(0),
      signalCode: null,
      kill() {},
    })
    await using process = createProcess({ maxOutputBytes: 32, inject: { spawn } })

    const result = await process.run({ argv: ["quiet"] })

    expect(result.stdout).toBe("exactly-32-bytes-of-plain-output")
    expect(result.outputTruncation).toBeUndefined()
  })

  it("hands every dropped byte to the output observer so the full stream survives elsewhere", async () => {
    const spawn: Spawn = () => ({
      pid: 4242,
      stdout: bytes("z".repeat(400)),
      stderr: bytes(""),
      exited: Promise.resolve(0),
      signalCode: null,
      kill() {},
    })
    await using process = createProcess({ maxOutputBytes: 20, inject: { spawn, log: silentLog } })

    let observed = 0
    const result = await process.run({
      argv: ["noisy"],
      onOutput: ({ chunk }) => {
        observed += chunk.byteLength
      },
    })

    // What makes the notice's promise true: the queue's artievent writer holds
    // the complete stdout.log even though this capture kept 20 bytes.
    expect(observed).toBe(400)
    expect(result.outputTruncation?.[0]?.droppedBytes).toBe(380)
  })

  it("does not split a multi-byte code point across the truncation seam", async () => {
    // 3 bytes per arrow, and a 40-byte budget splits 20/20 — a boundary that
    // lands mid-character. A decoder handed half a code point emits U+FFFD,
    // which reads like corrupted program output rather than like a truncation.
    const spawn: Spawn = () => ({
      pid: 4242,
      stdout: bytes("→".repeat(100)),
      stderr: bytes(""),
      exited: Promise.resolve(0),
      signalCode: null,
      kill() {},
    })
    await using process = createProcess({ maxOutputBytes: 40, inject: { spawn, log: silentLog } })

    const result = await process.run({ argv: ["unicode"] })

    expect(result.stdout).not.toContain("\uFFFD")
    const truncation = result.outputTruncation?.[0]
    expect(truncation?.totalBytes).toBe(300)
    // Surrendering the partial code points is itself counted as dropped, so the
    // arithmetic still closes exactly.
    expect((truncation?.keptBytes as number) + (truncation?.droppedBytes as number)).toBe(300)
    expect(truncation?.keptBytes).toBeLessThan(40)
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

  it("lets a real flooding child run to completion and reports its own exit code", async () => {
    await using process = createProcess({
      env: { PATH: Bun.env.PATH },
      maxOutputBytes: 2_000,
      inject: { log: silentLog },
    })

    const result = await process.run({
      argv: shellCommand("yes FLOODLINE | head -n 20000; exit 3"),
      timeoutMs: 30_000,
    })

    // Exit 3 is the code the queue runner itself died with while this cap threw.
    expect(result.exitCode).toBe(3)
    expect(result.timedOut).toBe(false)
    expect(result.stalled).not.toBe(true)
    expect(result.stdout).toContain("FLOODLINE")
    expect(result.stdout).toContain("bytes dropped here")
    const truncation = result.outputTruncation?.[0]
    expect(truncation?.stream).toBe("stdout")
    expect(truncation?.totalBytes).toBe(200_000)
    expect(truncation?.droppedBytes).toBeGreaterThan(190_000)
  })

  it("counts dropped bytes as progress so the stall detector cannot kill a flooding child", async () => {
    const spawn: Spawn = () => ({
      pid: 4242,
      stdout: bytes("f".repeat(5_000)),
      stderr: bytes(""),
      exited: Promise.resolve(0),
      signalCode: null,
      kill() {},
    })
    await using process = createProcess({ maxOutputBytes: 100, inject: { spawn, log: silentLog } })

    const result = await process.run({ argv: ["noisy"], noProgressTimeoutMs: 500 })

    // A flooding child is the MOST active kind there is. If the no-progress
    // lease were renewed only by bytes the window keeps, the stall detector
    // would terminate exactly the process this truncation exists to let finish —
    // the same outage wearing a different costume. The lease must see all 5000.
    expect(result.lastProgressBytes).toBe(5_000)
    expect(result.stalled).not.toBe(true)
    expect(result.verdict).toBe("EXITED")
  })

  it("refuses work after close", async () => {
    const process = createProcess()
    await process.close()
    await expect(process.run({ argv: ["printf", "never"] })).rejects.toThrow("closed")
  })
})
