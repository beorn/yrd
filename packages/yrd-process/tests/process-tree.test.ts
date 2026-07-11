/**
 * @failure A timed-out run leaves descendant processes alive (or hangs forever on a pipe a descendant still holds), so a wedged grandchild outlives its step bound.
 * @level l2
 * @consumer @yrd/process createProcess
 */
import { afterEach, describe, expect, test } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProcess } from "../src/index.ts"

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
        return null
      }
    })
    const cleanup = () => {
      for (const pid of pids) {
        if (pid === null || !Number.isFinite(pid) || pid <= 1) continue
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          // ESRCH — already dead, which is what the assertion wants anyway.
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
      // included. Self-daemonizing (setsid) escapees are the documented
      // residual class — this fixture does not setsid.
      expect(await waitDead(childPid as number, 3_000), `child ${childPid} survived settlement`).toBe(true)
      expect(await waitDead(grandchildPid as number, 3_000), `grandchild ${grandchildPid} survived settlement`).toBe(
        true,
      )
    } finally {
      cleanup()
    }
  }, 30_000)
})
