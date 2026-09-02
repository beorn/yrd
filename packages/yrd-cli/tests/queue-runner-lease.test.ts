/**
 * @failure Two `yrd queue run code --once` processes ran at once against one
 *          repository (2026-09-01, 15:11 PDT). The second cancelled the
 *          first's run ("Queue run canceled by yrd-cli:<pid>: entry checks no
 *          longer belong to a live change revision") and the first exited 3 on
 *          PR2916. A one-shot pass refused beside a RESIDENT — the resident
 *          holds a lease, and the one-shot PROBED it — but nothing refused
 *          beside another one-shot, because a one-shot took nothing for the
 *          other to observe. The probe is gone: every `queue run`, resident or
 *          one-shot, now takes the same lease for the whole of its pass.
 * @level l2
 * @consumer @yrd/cli queue run (admission exclusivity)
 */
import { readFileSync } from "node:fs"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createExclusive } from "@yrd/persistence"
import { failureFact } from "@yrd/core"
import { runYrdProcess } from "../src/host.ts"
import { installDeclaredYrdEntry } from "./support/declared-yrd-entry.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

/** The smallest repository an active `queue run` host will open. The queue is
 * empty on purpose: the lease is taken when the HOST is built, before any queue
 * work, so nothing here needs a submitted change to exercise it. */
async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-queue-runner-lease-"))
  roots.push(root)
  const repoPath = join(root, "repo")
  await git(root, "init", "-q", "-b", "main", repoPath)
  const repo = await realpath(repoPath)
  await git(repo, "config", "user.name", "Yrd Test")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await installDeclaredYrdEntry(repo)
  await writeFile(join(repo, "README.md"), "main\n")
  await writeFile(join(repo, ".yrd.yml"), 'checks:\n  - {check: {run: "true"}}\n')
  await git(repo, "add", "README.md", ".yrd.yml", "bin/yrd")
  await git(repo, "commit", "-qm", "main")
  return repo
}

function leaseDir(repo: string): string {
  return join(repo, ".git", "yrd", "resident-runner")
}

function lockBody(repo: string): Readonly<{ pid?: number; startedAt?: string; holder?: string }> {
  return JSON.parse(readFileSync(join(leaseDir(repo), "writer.lock"), "utf8")) as ReturnType<typeof lockBody>
}

type Invocation = Readonly<{ exitCode: number; stdout: string; stderr: string }>

/** One real `yrd` invocation through the process host — the same posture
 * resolution, the same host construction, and therefore the same lease
 * acquisition a spawned `bin/yrd.ts` goes through. */
async function invoke(repo: string, args: readonly string[], onStdout?: (text: string) => void): Promise<Invocation> {
  let stdout = ""
  let stderr = ""
  const exitCode = await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "--repo", repo, ...args], {
    cwd: repo,
    stdout: (text) => {
      stdout += text
      onStdout?.(text)
    },
    stderr: (text) => {
      stderr += text
    },
  })
  return { exitCode, stdout, stderr }
}

/** Take the lease the way a queue-run host takes it. Used to prove it came back
 * — a lease that was never released refuses here. */
async function leaseIsFree(repo: string): Promise<boolean> {
  try {
    await createExclusive(leaseDir(repo), { timeoutMs: 0 }).run(() => Promise.resolve(), { holder: "test-probe" })
    return true
  } catch (error) {
    if (failureFact(error)?.code === "exclusive-busy") return false
    throw error
  }
}

type Holder = Readonly<{ pid: number; stop: () => Promise<void>; kill: () => Promise<void> }>

/** A live holder in another process, with the exact holder line a real pass of
 * that mode writes. */
async function holdLease(repo: string, mode: "resident" | "once"): Promise<Holder> {
  const holder = `queue=${repo}#main epoch=11111111-1111-4111-8111-111111111111 mode=${mode}`
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dirname, "support", "hold-queue-runner-lease.ts"), leaseDir(repo), holder],
    { cwd: repo, stdout: "pipe", stderr: "pipe" },
  )
  const reader = child.stdout.getReader()
  const first = await reader.read()
  const announced = new TextDecoder().decode(first.value ?? new Uint8Array())
  if (!announced.includes("acquired")) {
    throw new Error(`lease holder did not acquire: ${announced}${await new Response(child.stderr).text()}`)
  }
  await reader.cancel()
  const pid = child.pid
  return {
    pid,
    stop: async () => {
      child.kill("SIGTERM")
      await child.exited
    },
    // SIGKILL: the holder gets no chance to release, so what comes next is the
    // kernel's doing and nothing else's.
    kill: async () => {
      child.kill("SIGKILL")
      await child.exited
    },
  }
}

describe("the queue runner lease — one lease, taken by every driver, for the whole pass", () => {
  it("a one-shot pass takes the lease, records mode=once with its own pid, and gives it back", async () => {
    const repo = await repository()
    expect(await leaseIsFree(repo)).toBe(true)

    // Read the lock body WHILE the pass is still running: stdout is written
    // from inside the command action, and the host closes (and releases) only
    // after that action returns. So a body naming this pid at this moment is a
    // lease acquired before the pass ended, and the free probe below is it
    // coming back afterwards.
    let duringPass: ReturnType<typeof lockBody> | undefined
    const run = await invoke(repo, ["queue", "run", "--json"], () => {
      duringPass ??= lockBody(repo)
    })

    expect(run.exitCode, run.stderr).toBe(0)
    expect(duringPass, `stdout was never written, so the pass was never observed:\n${run.stderr}`).toBeDefined()
    expect(duringPass?.pid).toBe(process.pid)
    expect(duringPass?.holder).toContain("mode=once")
    expect(duringPass?.startedAt).toEqual(expect.any(String))
    expect(await leaseIsFree(repo)).toBe(true)
  })

  it("refuses a second one-shot PROCESS started while the first pass is running — the specimen itself", async () => {
    const repo = await repository()
    // Spawned SYNCHRONOUSLY from inside the first pass's own command action, so
    // there is no window to lose: the first host is provably alive and holding
    // when the second one starts. Before the lease was shared, the second
    // process found nothing to refuse against, drained the same queue, and
    // cancelled the first's run.
    let second: Readonly<{ exitCode: number | null; stderr: string }> | undefined
    const first = await invoke(repo, ["queue", "run", "--json"], () => {
      if (second !== undefined) return
      const child = Bun.spawnSync(
        [
          process.execPath,
          join(import.meta.dirname, "..", "..", "..", "bin", "yrd.ts"),
          "--repo",
          repo,
          "queue",
          "run",
          "--json",
        ],
        { cwd: repo, env: process.env, stdout: "pipe", stderr: "pipe" },
      )
      second = { exitCode: child.exitCode, stderr: child.stderr.toString() }
    })

    expect(first.exitCode, first.stderr).toBe(0)
    expect(second, "the first pass never reached its own output, so no second process was started").toBeDefined()
    expect(second?.exitCode, second?.stderr).not.toBe(0)
    expect(second?.stderr).toContain("resident-runner-active")
    expect(second?.stderr).toContain("mode=once")
    expect(second?.stderr).toContain(`pid=${process.pid}`)
  }, 60_000)

  it("refuses a second one-shot while the first holds, naming the holder's mode, pid and start time", async () => {
    const repo = await repository()
    const holder = await holdLease(repo, "once")
    try {
      const run = await invoke(repo, ["queue", "run", "--json"])
      expect(run.exitCode).not.toBe(0)
      expect(run.stderr).toContain("resident-runner-active")
      // The three identity fields, together: what is holding it, which process,
      // and since when. A refusal that names none of them sends an operator
      // hunting instead of waiting.
      expect(run.stderr).toContain("mode=once")
      expect(run.stderr).toContain(`pid=${holder.pid}`)
      expect(run.stderr).toMatch(/started=\d{4}-\d{2}-\d{2}T/u)
      // The cure a one-shot holder earns: it ends on its own. Telling an
      // operator to restart a runner here points at a service that is not there.
      expect(run.stderr).toContain("Wait for that one-shot pass")
      expect(run.stderr).not.toContain("restart yrd-runner")
    } finally {
      await holder.stop()
    }
  })

  it("refuses a resident beside a one-shot", async () => {
    const repo = await repository()
    const holder = await holdLease(repo, "once")
    try {
      const run = await invoke(repo, ["queue", "up", "--interval", "1", "--json"])
      expect(run.exitCode).not.toBe(0)
      expect(run.stderr).toContain("resident-runner-active")
      expect(run.stderr).toContain("mode=once")
      expect(run.stderr).toContain(`pid=${holder.pid}`)
    } finally {
      await holder.stop()
    }
  })

  it("refuses a one-shot beside a resident, and still routes it to the resident's own drain", async () => {
    const repo = await repository()
    const holder = await holdLease(repo, "resident")
    try {
      const run = await invoke(repo, ["queue", "run", "--json"])
      expect(run.exitCode).not.toBe(0)
      expect(run.stderr).toContain("resident-runner-active")
      expect(run.stderr).toContain("mode=resident")
      expect(run.stderr).toContain(`pid=${holder.pid}`)
      expect(run.stderr).toContain("yrd pr submit <branch>")
      expect(run.stderr).toContain("hab --hab-dir <root> restart yrd-runner")
    } finally {
      await holder.stop()
    }
  })

  it("reclaims a lease left by a one-shot that died, with no sweep and no human rm", async () => {
    const repo = await repository()
    const holder = await holdLease(repo, "once")
    expect(await leaseIsFree(repo)).toBe(false)
    await holder.kill()

    const run = await invoke(repo, ["queue", "run", "--json"])
    expect(run.stderr).not.toContain("resident-runner-active")
    expect(run.exitCode, run.stderr).toBe(0)
    expect(await leaseIsFree(repo)).toBe(true)
  })

  it("gives the lease back when the pass throws, not only when it succeeds", async () => {
    const repo = await repository()
    // A selector no change answers: the host is built (lease taken), then the
    // action throws. The release is a `finally`, so this is the path that
    // matters — a lease only released on success strands the queue on the first
    // bad invocation.
    const run = await invoke(repo, ["queue", "run", "PR999", "--json"])
    expect(run.exitCode).not.toBe(0)
    expect(await leaseIsFree(repo)).toBe(true)
  })
})
