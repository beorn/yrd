/**
 * @failure A queue check step whose DIRECT child exits while a descendant that escaped the process-group sweep (setsid) holds the stdout pipe open wedges run() forever — Promise.all awaits an EOF only SIGKILL can free — so the runner holds the job (50–56min live queue hangs, 2026-07-15/16) until a human Ctrl-C + `yrd queue recover`.
 * @level l2
 * @consumer @yrd/process createProcess
 */
import { afterEach, describe, expect, test } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProcess, type Spawn } from "../src/index.ts"

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A fake spawn that reproduces the escaped-descendant wedge WITHOUT real
 * processes: the direct child can EXIT (or never exit) while its stdout stream
 * is deliberately held open, and kill() can be made to NOT close the stream —
 * modelling a setsid descendant the group sweep cannot reach.
 */
function escapingSpawn(opts: {
  /** When the DIRECT child's `exited` resolves; null = it never settles. */
  exitAfterMs: number | null
  exitCode?: number
  /** Close stdout when the direct child exits (a normal, non-escaped child). */
  closeStdoutOnExit?: boolean
  /** kill() closes stdout (the sweep reached the holder). false = escapee. */
  closeStdoutOnKill?: boolean
  /** kill() reaps the child, resolving `exited`. false = unkillable/escaped. */
  settleExitOnKill?: boolean
  chunks?: readonly { afterMs: number; text: string }[]
}): { spawn: Spawn; kills: NodeJS.Signals[] } {
  const kills: NodeJS.Signals[] = []
  const spawn: Spawn = () => {
    let closeStdout = () => {}
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false
        closeStdout = () => {
          if (closed) return
          closed = true
          controller.close()
        }
        for (const chunk of opts.chunks ?? []) {
          setTimeout(() => {
            if (!closed) controller.enqueue(new TextEncoder().encode(chunk.text))
          }, chunk.afterMs)
        }
      },
    })
    const stderr = new ReadableStream<Uint8Array>({ start: (controller) => controller.close() })
    let settleExit = (_code: number) => {}
    const exited = new Promise<number>((resolve) => {
      settleExit = resolve
      if (opts.exitAfterMs !== null) {
        setTimeout(() => {
          if (opts.closeStdoutOnExit === true) closeStdout()
          resolve(opts.exitCode ?? 0)
        }, opts.exitAfterMs)
      }
    })
    return {
      pid: 424_242,
      stdout,
      stderr,
      exited,
      signalCode: null,
      kill(signal = "SIGTERM") {
        kills.push(signal as NodeJS.Signals)
        if (opts.closeStdoutOnKill === true) closeStdout()
        if (opts.settleExitOnKill === true) settleExit(143)
      },
    }
  }
  return { spawn, kills }
}

const HUNG = Symbol("hung")
async function withHangGuard<T>(promise: Promise<T>, ms: number): Promise<T | typeof HUNG> {
  return Promise.race([promise, new Promise<typeof HUNG>((r) => setTimeout(() => r(HUNG), ms))])
}

describe("createProcess — escaped-descendant post-exit drain grace (queue-wedge watchdog)", () => {
  test("the DIRECT child exits but a descendant holds stdout open: run() force-fails at the grace, never wedges", async () => {
    // Direct child exits at 20ms WITHOUT closing stdout; kill() (no group
    // settlement under an injected spawn) cannot reach the escaped holder — so
    // the ONLY thing that lets run() return is the post-exit drain grace.
    const runner = escapingSpawn({
      exitAfterMs: 20,
      exitCode: 0,
      closeStdoutOnExit: false,
      closeStdoutOnKill: false,
      settleExitOnKill: false,
      chunks: [{ afterMs: 0, text: "started\n" }],
    })
    await using proc = createProcess({ inject: { spawn: runner.spawn }, killGraceMs: 20 })

    const race = await withHangGuard(proc.run({ argv: ["fake-test"], postExitDrainGraceMs: 100 }), 5_000)

    // Without the fix, Promise.all([capture, capture, exited]) awaits an EOF the
    // escaped holder never sends: run() stays pending and this is HUNG.
    expect(race).not.toBe(HUNG)
    if (race === HUNG) return
    expect(race.escapedDescendant).toBe(true)
    expect(race.stalled).toBe(true)
    expect(race.verdict).toBe("STALLED")
    expect(race.exitCode).toBe(0)
    // Partial output captured before the pipe was abandoned is retained.
    expect(race.stdout).toBe("started\n")
    // Best-effort sweep of the leaked in-group descendants was attempted.
    expect(runner.kills).toContain("SIGKILL")
  })

  test("returns within the grace, not after a long child lifetime", async () => {
    const runner = escapingSpawn({
      exitAfterMs: 5,
      closeStdoutOnExit: false,
      closeStdoutOnKill: false,
      settleExitOnKill: false,
    })
    await using proc = createProcess({ inject: { spawn: runner.spawn }, killGraceMs: 20 })

    const started = performance.now()
    const result = await withHangGuard(proc.run({ argv: ["fake-test"], postExitDrainGraceMs: 80 }), 5_000)
    const elapsed = performance.now() - started

    expect(result).not.toBe(HUNG)
    // ~grace (80ms) + child exit (5ms), comfortably under any wall-clock bound.
    expect(elapsed).toBeLessThan(1_000)
  })

  test("a normally-closing child is UNAFFECTED: no escaped marker, no grace wait", async () => {
    // Regression guard: the drain grace must never truncate or delay a child
    // that closes its own pipe on exit.
    const runner = escapingSpawn({
      exitAfterMs: 10,
      exitCode: 0,
      closeStdoutOnExit: true,
      chunks: [{ afterMs: 0, text: "clean\n" }],
    })
    await using proc = createProcess({ inject: { spawn: runner.spawn }, killGraceMs: 20 })

    const started = performance.now()
    // A LONG grace would still expose a regression if we always waited it.
    const result = await proc.run({ argv: ["fake-test"], postExitDrainGraceMs: 10_000 })
    const elapsed = performance.now() - started

    expect(result.escapedDescendant).toBeUndefined()
    expect(result.stalled).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("clean\n")
    expect(runner.kills).toEqual([])
    expect(elapsed).toBeLessThan(1_000)
  })

  test("belt-and-suspenders: an UNKILLABLE direct child (exited never settles) still returns, loud sweepFailure", async () => {
    // The child never exits and never reaps under SIGKILL (D-state / fully
    // escaped tree). The wall-clock bound fires terminate(); the reap backstop
    // must stop awaiting child.exited so run() returns instead of hanging.
    const runner = escapingSpawn({
      exitAfterMs: null,
      closeStdoutOnKill: false,
      settleExitOnKill: false,
    })
    // A small reap grace bounds the test; production defaults to seconds so the
    // backstop only fires on a genuinely stuck child, never on reap latency.
    await using proc = createProcess({
      inject: { spawn: runner.spawn },
      killGraceMs: 40,
      postKillReapGraceMs: 40,
    })

    const race = await withHangGuard(proc.run({ argv: ["fake-test"], timeoutMs: 40, postExitDrainGraceMs: 40 }), 5_000)

    expect(race).not.toBe(HUNG)
    if (race === HUNG) return
    expect(race.timedOut).toBe(true)
    expect(race.sweepFailure).toMatch(/did not exit/i)
    expect(runner.kills).toContain("SIGKILL")
  })

  test("REAL process: sh exits while a backgrounded sleep inherits stdout — run() returns at the grace", async () => {
    // End-to-end reproduction with the default (group-leader) spawn. The sh
    // exits immediately; the backgrounded `sleep` inherits fd1 (the run's pipe)
    // and holds it open. Without the drain grace, capture() awaits an EOF that
    // only arrives when sleep dies — the live wedge. NO timeoutMs/noProgressMs
    // is set, so ONLY the post-exit drain grace can un-wedge run().
    const dir = mkdtempSync(join(tmpdir(), "yrd-escaped-"))
    scratch.push(dir)
    const pidFile = join(dir, "sleep.pid")
    // `sleep 120 &` stays in the child's process group (no setsid); echo writes
    // its pid to a file (NOT to stdout, so capture reads zero bytes and blocks
    // on EOF). sh then exits, orphaning the pipe-holding sleep.
    const script = `sleep 120 & echo $! > ${JSON.stringify(pidFile)} ; exit 0`

    await using proc = createProcess({ cwd: dir, killGraceMs: 500 })
    const started = performance.now()
    const race = await withHangGuard(proc.run({ argv: ["sh", "-c", script], postExitDrainGraceMs: 500 }), 15_000)
    const elapsed = performance.now() - started

    let leakedPid: number | null = null
    try {
      leakedPid = Number(readFileSync(pidFile, "utf-8").trim())
    } catch {
      leakedPid = null
    }
    try {
      expect(race).not.toBe(HUNG)
      if (race === HUNG) return
      expect(race.escapedDescendant).toBe(true)
      // Returned at the grace (~500ms), NOT after sleep's 120s lifetime.
      expect(elapsed).toBeLessThan(5_000)
    } finally {
      // Hygiene: the escaped path SIGKILLs the in-group sleeper, but never leak.
      if (leakedPid !== null && Number.isFinite(leakedPid) && leakedPid > 1) {
        try {
          process.kill(leakedPid, "SIGKILL")
        } catch {
          // ESRCH — already swept, which is the intent anyway.
        }
      }
    }
  }, 30_000)
})
