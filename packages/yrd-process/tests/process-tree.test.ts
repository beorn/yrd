/**
 * @failure A timed-out run leaves descendant processes alive (or hangs forever on a pipe a descendant still holds), so a wedged grandchild outlives its step bound.
 * @level l2
 * @consumer @yrd/process createProcess
 */
import { afterEach, describe, expect, test, vi } from "vitest"
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import type { Dirent } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// This suite owns process-tree mechanics, not host /proc visibility policy.
// Keep its live census deterministic by including only this Vitest worker and
// descendants it spawns. path-reaper-permissions.test.ts separately proves
// that production refuses ambient EACCES/EPERM cases instead of certifying
// them absent.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    async readdir(path: Parameters<typeof actual.readdir>[0], options?: Parameters<typeof actual.readdir>[1]) {
      const entries = await actual.readdir(path, options as never)
      if (path !== "/proc" || !Array.isArray(entries) || entries.some((entry) => typeof entry === "string")) {
        return entries
      }
      const dirEntries = entries as unknown as Dirent[]
      const parents = new Map<number, number>()
      await Promise.all(
        dirEntries.map(async (entry) => {
          if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) return
          try {
            const status = await actual.readFile(`/proc/${entry.name}/status`, "utf8")
            const parent = status.match(/^PPid:\s+(\d+)$/mu)
            if (parent !== null) parents.set(Number(entry.name), Number(parent[1]))
          } catch {
            // A process that vanished before census is absent from this fixture.
          }
        }),
      )
      const owned = new Set([process.pid])
      let grew = true
      while (grew) {
        grew = false
        for (const [pid, parent] of parents) {
          if (!owned.has(pid) && owned.has(parent)) {
            owned.add(pid)
            grew = true
          }
        }
      }
      return dirEntries.filter((entry) => !/^\d+$/u.test(entry.name) || owned.has(Number(entry.name)))
    },
  }
})

import { createProcess, pathReapFailure, type Spawn } from "../src/index.ts"

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const bunExe = process.execPath

/** Poll until `pid` is gone or `ms` elapses; true = dead. */
async function waitDead(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return true // ESRCH — gone
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

describe("createProcess — full process-tree settlement (21012 S1)", () => {
  test("a failed path reap names every exact survivor pid (22510)", () => {
    expect(
      pathReapFailure({
        targetedPids: [41, 42],
        survivorPids: [42, 57],
        forcedKill: true,
        signalFailures: [],
      }),
    ).toBe("process-tree reap failed; survivor pids: 42, 57")
  })

  test.runIf(process.platform === "darwin" || process.platform === "linux")(
    "a protected caller holding the owned path is reported as an exact survivor (22510)",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "yrd-protected-path-"))
      scratch.push(dir)
      const heldPath = join(dir, "held.txt")
      writeFileSync(heldPath, "held\n")
      const descriptor = openSync(heldPath, "r")
      try {
        await using owner = createProcess({ killGraceMs: 25, postKillReapGraceMs: 25 })
        const result = await owner.reapPath(dir)
        expect(result.survivorPids).toContain(process.pid)
        expect(pathReapFailure(result)).toContain(`survivor pids: ${process.pid}`)
      } finally {
        closeSync(descriptor)
      }
    },
  )

  test.runIf(process.platform === "darwin" || process.platform === "linux")(
    "reaps an exec'd process that left the Bay cwd but retained an open Bay file (22510)",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "yrd-open-file-owner-"))
      scratch.push(dir)
      const heldPath = join(dir, "held.txt")
      writeFileSync(heldPath, "held\n")
      const source = `process.stdout.write("ready\\n"); setInterval(() => {}, 1_000)`
      const child = Bun.spawn(
        ["/bin/sh", "-c", `exec 3<"$1"; cd /; exec "$2" -e "$3"`, "yrd-open-file-fixture", heldPath, bunExe, source],
        {
          cwd: "/",
          detached: true,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      )

      try {
        const reader = child.stdout.getReader()
        const first = await reader.read()
        reader.releaseLock()
        expect(new TextDecoder().decode(first.value)).toBe("ready\n")

        await using owner = createProcess({ killGraceMs: 250, postKillReapGraceMs: 250 })
        const result = await owner.reapPath(dir)
        expect(result.targetedPids).toContain(child.pid)
        expect(result.survivorPids).toEqual([])
        expect(pathReapFailure(result)).toBeUndefined()
        expect(await waitDead(child.pid, 1_000), `open-file owner ${child.pid} survived path reap`).toBe(true)
      } finally {
        try {
          child.kill("SIGKILL")
        } catch {
          // silent-fallback-allow: the test cleanup target may already have exited.
        }
        await child.exited
      }
    },
  )

  test("bun canary: Bun.spawn detached:true makes the child a process-group LEADER", async () => {
    // The settlement design rests on this bun behavior (the node:child_process
    // shim IGNORES detached — probed 2026-07-10; the NATIVE API honors it —
    // probed 2026-07-11). If a bun upgrade regresses it, THIS test names the
    // cause instead of the journey test hanging mysteriously.
    const child = Bun.spawn(["perl", "-e", "print getpgrp(0)"], { stdout: "pipe", detached: true })
    const pgid = (await new Response(child.stdout).text()).trim()
    await child.exited
    expect(pgid).toBe(String(child.pid))
  })

  test("a TERM-ignoring grandchild HOLDING THE STDOUT PIPE dies at the bound; run() resolves; zero survivors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yrd-process-tree-"))
    scratch.push(dir)
    const childPidFile = join(dir, "child.pid")
    const grandchildPidFile = join(dir, "grandchild.pid")
    // Grandchild: ignores SIGTERM, INHERITS stdout (holds the run's pipe open —
    // the worst case: without group settlement the pipe never closes and
    // createProcess hangs PAST its own timeout), stays alive until SIGKILL.
    writeFileSync(
      join(dir, "grandchild.ts"),
      [
        `import { writeFileSync } from "node:fs"`,
        `process.on("SIGTERM", () => {})`,
        `writeFileSync(${JSON.stringify(grandchildPidFile)}, String(process.pid))`,
        `setInterval(() => {}, 1000)`,
      ].join("\n"),
    )
    // Child (the direct spawn): records its pid, spawns the pipe-inheriting
    // grandchild, then hangs like a wedged runner main.
    writeFileSync(
      join(dir, "child.ts"),
      [
        `import { writeFileSync } from "node:fs"`,
        `writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid))`,
        `Bun.spawn([${JSON.stringify(bunExe)}, ${JSON.stringify(join(dir, "grandchild.ts"))}], { stdout: "inherit", stderr: "ignore", stdin: "ignore" })`,
        `setInterval(() => {}, 1000)`,
      ].join("\n"),
    )

    await using proc = createProcess({ cwd: dir, killGraceMs: 1_000 })
    const HUNG = Symbol("hung")
    const race = await Promise.race([
      proc.run({ argv: [bunExe, join(dir, "child.ts")], timeoutMs: 1_500 }),
      new Promise<typeof HUNG>((r) => setTimeout(() => r(HUNG), 12_000)),
    ])

    // Hygiene BEFORE assertions: never leak the fixture tree on a red.
    const pids = [childPidFile, grandchildPidFile].map((f) => {
      try {
        return Number(readFileSync(f, "utf-8").trim())
      } catch {
        // silent-fallback-allow: a missing fixture pid file leaves no proven process to clean up.
        return null
      }
    })
    const cleanup = () => {
      for (const pid of pids) {
        if (pid === null || !Number.isFinite(pid) || pid <= 1) continue
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          // silent-fallback-allow: ESRCH means cleanup already reached the asserted dead state.
        }
      }
    }

    try {
      // Without full-tree settlement, run() HANGS despite timedOut firing:
      // the timeout kills only the direct child while capture() awaits the
      // stdout pipe the grandchild still holds. That surfaces here as HUNG.
      expect(race).not.toBe(HUNG)
      if (race === HUNG) return
      expect(race.timedOut).toBe(true)
      const [childPid, grandchildPid] = pids
      expect(childPid).not.toBeNull()
      expect(grandchildPid).not.toBeNull()
      // The whole tree must be DEAD (group swept): TERM-ignoring grandchild
      // included. This fixture pins the fast group layer; the Bay lifecycle
      // contract separately pins a new-session descendant.
      expect(await waitDead(childPid as number, 3_000), `child ${childPid} survived settlement`).toBe(true)
      expect(await waitDead(grandchildPid as number, 3_000), `grandchild ${grandchildPid} survived settlement`).toBe(
        true,
      )
    } finally {
      cleanup()
    }
  }, 30_000)
})

function fakeRunner(
  chunks: readonly { afterMs: number; text: string }[],
  finishAfterMs: number | null,
): { spawn: Spawn; kills: NodeJS.Signals[] } {
  const kills: NodeJS.Signals[] = []
  const spawn: Spawn = () => {
    let close = () => {}
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false
        close = () => {
          if (closed) return
          closed = true
          controller.close()
        }
        for (const chunk of chunks) {
          setTimeout(() => {
            if (!closed) controller.enqueue(new TextEncoder().encode(chunk.text))
          }, chunk.afterMs)
        }
      },
    })
    const stderr = new ReadableStream<Uint8Array>({ start: (controller) => controller.close() })
    let settle = (_code: number) => {}
    const exited = new Promise<number>((resolve) => {
      settle = resolve
      if (finishAfterMs !== null) {
        setTimeout(() => {
          close()
          resolve(0)
        }, finishAfterMs)
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
        close()
        settle(143)
      },
    }
  }
  return { spawn, kills }
}

describe("createProcess — explicit output-progress lease (21057)", () => {
  test("advancing output renews the lease", async () => {
    const runner = fakeRunner(
      [
        { afterMs: 0, text: "one\n" },
        { afterMs: 10, text: "two\n" },
        { afterMs: 20, text: "three\n" },
      ],
      25,
    )
    await using proc = createProcess({ inject: { spawn: runner.spawn }, killGraceMs: 10 })

    const result = await proc.run({ argv: ["fake-test"], noProgressTimeoutMs: 15 })

    expect(result).toMatchObject({ exitCode: 0, stalled: false, lastProgressBytes: 14 })
    expect(runner.kills).toEqual([])
  })

  test("queue-delayed child startup is not an output-progress stall", async () => {
    const runner = fakeRunner(
      [
        { afterMs: 30, text: "one\n" },
        { afterMs: 40, text: "two\n" },
      ],
      45,
    )
    await using proc = createProcess({ inject: { spawn: runner.spawn }, killGraceMs: 10 })

    const result = await proc.run({ argv: ["fake-test"], noProgressTimeoutMs: 15 })

    expect(result).toMatchObject({ exitCode: 0, stalled: false, stdout: "one\ntwo\n", lastProgressBytes: 8 })
    expect(runner.kills).toEqual([])
  })

  test("silent output gracefully stops only the owned runner and retains partial output", async () => {
    const runner = fakeRunner([{ afterMs: 0, text: "started\n" }], null)
    await using proc = createProcess({ inject: { spawn: runner.spawn }, killGraceMs: 10 })

    const result = await proc.run({ argv: ["fake-test"], noProgressTimeoutMs: 15 })

    expect(result).toMatchObject({ exitCode: 143, stalled: true, stdout: "started\n", lastProgressBytes: 8 })
    expect(result.lastProgressAtMs).toBeGreaterThanOrEqual(0)
    expect(runner.kills).toEqual(["SIGTERM"])
  })
})
