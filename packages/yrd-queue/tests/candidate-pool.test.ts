/**
 * @failure Warm candidate worktrees leak, run checks over cross-run residue, or exceed their bound.
 * @level l2
 * @consumer @yrd/queue warm candidate pool
 */
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createProcess } from "@yrd/process"
import { createLogger, type Event as LogEvent } from "loggily"
import type { JobResult } from "@yrd/job"
import {
  createCandidatePool,
  createCandidatePoolGit,
  type CandidatePool,
  type CandidatePoolGit,
} from "../src/candidate-pool.ts"

// Real-git integration with file-protocol submodules; generous bound so heavy
// worktree/submodule fixtures do not flake near the default 5s under fleet load.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

const roots: string[] = []
const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(repo: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

async function repository(): Promise<{ repo: string; baseSha: string; baysRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "yrd-warm-pool-"))
  roots.push(root)
  const repo = join(root, "repo")
  await Bun.$`git init -q -b main ${repo}`
  await git(repo, ["config", "user.name", "Yrd Test"])
  await git(repo, ["config", "user.email", "yrd@example.invalid"])
  await writeFile(join(repo, "README.md"), "main\n")
  await git(repo, ["add", "README.md"])
  await git(repo, ["commit", "-qm", "main"])
  const baseSha = await git(repo, ["rev-parse", "HEAD"])
  const baysRoot = join(root, "bays")
  await mkdir(baysRoot, { recursive: true })
  return { repo, baseSha, baysRoot }
}

async function submoduleRepository(): Promise<{ repo: string; baysRoot: string; ref: string }> {
  const { repo, baysRoot } = await repository()
  const module = join(repo, "..", "module")
  await Bun.$`git init -q -b main ${module}`.quiet()
  await git(module, ["config", "user.name", "Yrd Test"])
  await git(module, ["config", "user.email", "yrd@example.invalid"])
  await writeFile(join(module, "version.txt"), "1\n")
  await git(module, ["add", "version.txt"])
  await git(module, ["commit", "-qm", "module"])
  await git(repo, ["config", "protocol.file.allow", "always"])
  await git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", module, "dep"])
  await git(repo, ["commit", "-qam", "add dep"])
  const ref = await git(repo, ["rev-parse", "HEAD"])
  return { repo, baysRoot, ref }
}

type CapturingLog = Readonly<{ log: ReturnType<typeof createLogger>; events: LogEvent[] }>

function capturingLog(): CapturingLog {
  const events: LogEvent[] = []
  const log = createLogger("yrd", [{ level: "trace", spans: true }, { write: (event: LogEvent) => events.push(event) }])
  return { log, events }
}

function makePool(
  repo: string,
  baysRoot: string,
  capacity: number,
  log: CapturingLog["log"],
  environment: NodeJS.ProcessEnv = process.env,
): CandidatePool {
  const process = createProcess({ cwd: repo })
  const pool = createCandidatePool({
    repo,
    parent: baysRoot,
    capacity,
    git: createCandidatePoolGit(process, environment),
    log,
  })
  disposers.push(async () => {
    await pool.close()
    await process.close()
  })
  return pool
}

type GitFault = (args: readonly string[]) => boolean

/** Wrap a real pool Git so specific argv return a nonzero result — a deterministic
 * stand-in for a clean/foreach/remove that fails on a real repository. */
function faultingGit(base: CandidatePoolGit, fault: { current: GitFault }): CandidatePoolGit {
  return {
    run: async (repo, args, allowFailure) => {
      if (fault.current(args)) return { code: 1, stdout: "", stderr: `injected fault: ${args.join(" ")}` }
      return base.run(repo, args, allowFailure)
    },
  }
}

function makeFaultingPool(
  repo: string,
  baysRoot: string,
  capacity: number,
  log: CapturingLog["log"],
  fault: { current: GitFault },
): CandidatePool {
  const process = createProcess({ cwd: repo })
  const git = faultingGit(createCandidatePoolGit(process), fault)
  const pool = createCandidatePool({ repo, parent: baysRoot, capacity, git, log })
  disposers.push(async () => {
    await pool.close()
    await process.close()
  })
  return pool
}

function spans(events: LogEvent[], name: string): Array<Extract<LogEvent, { kind: "span" }>> {
  return events.filter(
    (event): event is Extract<LogEvent, { kind: "span" }> => event.kind === "span" && event.name.endsWith(`:${name}`),
  )
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].toSorted((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index] ?? 0
}

function deferred<T = void>(): Readonly<{
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (cause: unknown) => void
}> {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const passed: JobResult<{ ok: true }> = { status: "passed", output: { ok: true } }

describe("warm candidate pool", () => {
  it("reuses one warm worktree across candidate cycles and resets dirt between runs", async () => {
    const { repo, baseSha, baysRoot } = await repository()
    const { log, events } = capturingLog()
    const pool = makePool(repo, baysRoot, 2, log)

    const paths: string[] = []
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const result = await pool.withCandidate(baseSha, async (path) => {
        paths.push(path)
        // A real check mutates the tree: an untracked artifact plus a tracked edit.
        await writeFile(join(path, "artifact.txt"), `cycle ${cycle}\n`)
        await writeFile(join(path, "README.md"), `edited ${cycle}\n`)
        return passed
      })
      expect(result).toEqual(passed)
    }

    expect(new Set(paths).size).toBe(1)
    expect(pool.stats()).toEqual({ hits: 2, misses: 1, evictions: 0 })

    const acquire = spans(events, "acquire")
    expect(acquire.map((span) => span.props?.outcome)).toEqual(["miss", "hit", "hit"])
    for (const span of acquire) expect(span.duration).toEqual(expect.any(Number))
    expect(spans(events, "check").map((span) => span.props?.outcome)).toEqual(["succeeded", "succeeded", "succeeded"])
    expect(spans(events, "reset")).toHaveLength(2)
    expect(spans(events, "release").length).toBeGreaterThanOrEqual(3)
  })

  it("rejects cross-run residue by evicting the dirty worktree and checking a fresh one", async () => {
    const { repo, baseSha, baysRoot } = await repository()
    const { log, events } = capturingLog()
    const pool = makePool(repo, baysRoot, 1, log)

    // Cycle 1 leaves an untracked nested repository — `git clean -fdx` refuses to
    // remove it, so the warm worktree cannot be reset clean and must be evicted.
    const first = await pool.withCandidate(baseSha, async (path) => {
      await Bun.$`git init -q ${join(path, "leftover")}`.quiet()
      return passed
    })
    expect(first).toEqual(passed)

    let secondPath = ""
    let sawResidue = true
    const second = await pool.withCandidate(baseSha, async (path) => {
      secondPath = path
      // The evicted-and-recreated worktree must be pristine.
      sawResidue = existsSync(join(path, "leftover"))
      const dirty = await git(path, ["status", "--porcelain", "--untracked-files=all"])
      expect(dirty).toBe("")
      return passed
    })
    expect(second).toEqual(passed)
    expect(sawResidue).toBe(false)
    expect(secondPath).not.toBe("")

    expect(pool.stats()).toEqual({ hits: 0, misses: 2, evictions: 1 })
    expect(spans(events, "acquire").map((span) => span.props?.outcome)).toEqual(["miss", "residue-evicted"])
  })

  it("bounds concurrent candidates to the configured capacity", async () => {
    const { repo, baseSha, baysRoot } = await repository()
    const { log } = capturingLog()
    const pool = makePool(repo, baysRoot, 2, log)

    let active = 0
    let peak = 0
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const livePaths = new Set<string>()

    const cycles = Array.from({ length: 4 }, () =>
      pool.withCandidate(baseSha, async (path) => {
        active += 1
        peak = Math.max(peak, active)
        livePaths.add(path)
        await gate
        active -= 1
        return passed
      }),
    )
    // Wait until the first wave saturates capacity (both worktrees created and
    // in-flight), then release everyone. Polling avoids depending on setup speed.
    for (let waited = 0; active < 2 && waited < 200; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(peak).toBe(2)
    releaseGate()
    const results = await Promise.all(cycles)

    expect(results).toEqual([passed, passed, passed, passed])
    expect(peak).toBe(2)
    expect(livePaths.size).toBeLessThanOrEqual(2)
    expect(pool.stats().misses).toBe(2)
  })

  it("materializes submodules from the local store and keeps them pinned across reuse", async () => {
    const { repo, baseSha, baysRoot } = await repository()
    const module = join(repo, "..", "module")
    await Bun.$`git init -q -b main ${module}`.quiet()
    await git(module, ["config", "user.name", "Yrd Test"])
    await git(module, ["config", "user.email", "yrd@example.invalid"])
    await writeFile(join(module, "version.txt"), "1\n")
    await git(module, ["add", "version.txt"])
    await git(module, ["commit", "-qm", "module"])
    await git(repo, ["config", "protocol.file.allow", "always"])
    await git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", module, "dep"])
    const unreachable = "never://network.example/dep.git"
    await git(repo, ["config", "-f", ".gitmodules", "submodule.dep.url", unreachable])
    await git(repo, ["config", "submodule.dep.url", unreachable])
    await git(repo, ["commit", "-qam", "add dep"])
    const withSubmodule = await git(repo, ["rev-parse", "HEAD"])
    const unexpectedHookSync = join(repo, "..", "unexpected-post-checkout-submodule-sync")
    await writeFile(
      join(repo, ".git", "hooks", "post-checkout"),
      `#!/bin/sh\n[ "\${KM_NO_AUTO_SUBMODULE_UPDATE:-}" = "1" ] || : > "${unexpectedHookSync}"\n`,
    )
    await chmod(join(repo, ".git", "hooks", "post-checkout"), 0o755)

    const { log, events } = capturingLog()
    const pool = makePool(repo, baysRoot, 1, log, { ...process.env, KM_NO_AUTO_SUBMODULE_UPDATE: "0" })

    for (const ref of [withSubmodule, withSubmodule]) {
      await pool.withCandidate(ref, async (path) => {
        expect(existsSync(join(path, "dep", "version.txt"))).toBe(true)
        const moduleGitDir = await git(join(path, "dep"), ["rev-parse", "--absolute-git-dir"])
        expect((await readFile(join(moduleGitDir, "objects", "info", "alternates"), "utf8")).trim()).toBe(
          join(await realpath(repo), ".git", "modules", "dep", "objects"),
        )
        expect(await git(join(path, "dep"), ["remote", "get-url", "origin"])).toBe(unreachable)
        const objects = join(moduleGitDir, "objects")
        expect((await readdir(objects)).filter((name) => name !== "info" && name !== "pack")).toEqual([])
        expect(existsSync(join(objects, "pack")) ? await readdir(join(objects, "pack")) : []).toEqual([])
        return passed
      })
    }

    expect(pool.stats()).toEqual({ hits: 1, misses: 1, evictions: 0 })
    expect(spans(events, "materialize").length).toBeGreaterThanOrEqual(2)
    expect(existsSync(unexpectedHookSync)).toBe(false)
    void baseSha
  })

  it("removes every warm worktree on close", async () => {
    const { repo, baseSha, baysRoot } = await repository()
    const { log } = capturingLog()
    const pool = makePool(repo, baysRoot, 2, log)

    const seen: string[] = []
    await Promise.all(
      [0, 1].map(() =>
        pool.withCandidate(baseSha, async (path) => {
          seen.push(path)
          await new Promise((resolve) => setTimeout(resolve, 20))
          return passed
        }),
      ),
    )
    expect(new Set(seen).size).toBe(2)
    for (const path of seen) expect(existsSync(path)).toBe(true)

    await pool.close()

    for (const path of seen) expect(existsSync(path)).toBe(false)
    const worktrees = await git(repo, ["worktree", "list", "--porcelain"])
    for (const path of seen) expect(worktrees).not.toContain(path)
  })

  it("fails closed when a warm reset cannot clean the tree — evicts and recreates, never reuses", async () => {
    const { repo, baseSha, baysRoot } = await repository()
    const { log, events } = capturingLog()
    const fault: { current: GitFault } = { current: () => false }
    const pool = makeFaultingPool(repo, baysRoot, 1, log, fault)

    let firstPath = ""
    await pool.withCandidate(baseSha, async (path) => {
      firstPath = path
      return passed
    })

    // Every top-level `clean -fdx` now fails: the warm tree cannot be PROVEN
    // clean, so the reused path must be discarded and a fresh one created.
    fault.current = (args) => args[0] === "clean" && args[1] === "-fdx"

    let secondPath = ""
    const result = await pool.withCandidate(baseSha, async (path) => {
      secondPath = path
      return passed
    })
    fault.current = () => false

    expect(result).toEqual(passed)
    expect(secondPath).not.toBe(firstPath) // the dirty path was NEVER handed to run
    expect(existsSync(firstPath)).toBe(false) // evicted
    expect(pool.stats()).toEqual({ hits: 0, misses: 2, evictions: 1 })
    expect(spans(events, "acquire").map((span) => span.props?.outcome)).toEqual(["miss", "residue-evicted"])
    const reset = spans(events, "reset").at(-1)
    expect(reset?.props?.outcome).toBe("unclean")
    expect(String(reset?.props?.reason)).toContain("clean")
  })

  it("fails closed when a submodule cannot be reset clean — evicts and recreates", async () => {
    const { repo, baseSha, baysRoot } = await repository()
    const module = join(repo, "..", "module")
    await Bun.$`git init -q -b main ${module}`.quiet()
    await git(module, ["config", "user.name", "Yrd Test"])
    await git(module, ["config", "user.email", "yrd@example.invalid"])
    await writeFile(join(module, "version.txt"), "1\n")
    await git(module, ["add", "version.txt"])
    await git(module, ["commit", "-qm", "module"])
    await git(repo, ["config", "protocol.file.allow", "always"])
    await git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", module, "dep"])
    await git(repo, ["commit", "-qam", "add dep"])
    const ref = await git(repo, ["rev-parse", "HEAD"])
    void baseSha

    const { log, events } = capturingLog()
    let foreachCleanFailsLeft = 0
    const fault: { current: GitFault } = {
      current: (args) => {
        if (
          args[0] === "submodule" &&
          args[1] === "foreach" &&
          args[3] === "git clean -fdx" &&
          foreachCleanFailsLeft > 0
        ) {
          foreachCleanFailsLeft -= 1
          return true
        }
        return false
      },
    }
    const pool = makeFaultingPool(repo, baysRoot, 1, log, fault)

    let firstPath = ""
    await pool.withCandidate(ref, async (path) => {
      firstPath = path
      return passed
    })

    // The next warm reset hits one failed submodule clean; recreation then
    // succeeds (the fault is one-shot), so the check still runs on a clean tree.
    foreachCleanFailsLeft = 1
    let secondPath = ""
    await pool.withCandidate(ref, async (path) => {
      secondPath = path
      return passed
    })

    expect(secondPath).not.toBe(firstPath)
    expect(existsSync(firstPath)).toBe(false)
    expect(pool.stats()).toEqual({ hits: 0, misses: 2, evictions: 1 })
    expect(spans(events, "acquire").map((span) => span.props?.outcome)).toEqual(["miss", "residue-evicted"])
  })

  it("raises loud and stays retryable when a worktree removal fails, then succeeds on retry", async () => {
    const { repo, baseSha, baysRoot } = await repository()
    const { log } = capturingLog()
    const fault: { current: GitFault } = { current: () => false }
    const pool = makeFaultingPool(repo, baysRoot, 1, log, fault)

    let warmPath = ""
    await pool.withCandidate(baseSha, async (path) => {
      warmPath = path
      return passed
    })
    expect(existsSync(warmPath)).toBe(true)

    // The Git worktree-admin removal fails: close must raise loud and leave the
    // worktree intact so a later close retries it — never a silent success.
    fault.current = (args) => args[0] === "worktree" && args[1] === "remove"
    // Loud: the reject surfaces the underlying Git failure detail, not a swallow.
    await expect(pool.close()).rejects.toThrow(/injected fault: worktree remove/u)
    expect(existsSync(warmPath)).toBe(true) // retained, retry-safe

    // A failed close stays CLOSED to new work — the retained/half-removed
    // worktree is never re-admitted; only a close() retry may proceed.
    await expect(pool.withCandidate(baseSha, async () => passed)).rejects.toThrow(/candidate pool is closed/u)
    expect(existsSync(warmPath)).toBe(true)

    // Retry with the fault cleared: the removal now succeeds and state is clean.
    fault.current = () => false
    await pool.close()
    expect(existsSync(warmPath)).toBe(false)
    const worktrees = await git(repo, ["worktree", "list", "--porcelain"])
    expect(worktrees).not.toContain(warmPath)

    // Closed reached true: a further close is a clean no-op.
    await pool.close()
  })

  it("retries the root removal after a failed close — a reported-closed pool never leaves root residue (merge-queue R40c)", async () => {
    const { repo, baseSha, baysRoot } = await repository()
    const { log } = capturingLog()
    const pool = makePool(repo, baysRoot, 1, log)

    let warmPath = ""
    await pool.withCandidate(baseSha, async (path) => {
      warmPath = path
      return passed
    })
    const root = dirname(warmPath)
    expect(existsSync(root)).toBe(true)

    // fs fault injection: the Git worktree-admin removal succeeds (root's own
    // permissions allow deleting `worktree/`), but the root directory itself
    // cannot be unlinked from the read-only Bays root.
    await chmod(baysRoot, 0o555)
    try {
      // Loud and retry-safe: the failed rm re-raises; the root stays for retry.
      await expect(pool.close()).rejects.toThrow()
      expect(existsSync(root)).toBe(true)
      // The Git admin removal DID succeed — only the filesystem residue remains.
      expect(await git(repo, ["worktree", "list", "--porcelain"])).not.toContain(warmPath)
    } finally {
      await chmod(baysRoot, 0o755)
    }

    // Fault cleared: the close RETRY must actually remove the residue and only
    // then report closed — never `closed` with the root still on disk.
    await pool.close()
    expect(existsSync(root)).toBe(false)
  })

  it("retains and surfaces both causes when creation fails and its worktree cannot be cleaned up", async () => {
    const { repo, baysRoot, ref } = await submoduleRepository()
    const { log } = capturingLog()
    // The worktree ADD succeeds, but materialization fails AND the cleanup
    // `worktree remove` also fails — the dual fault the reviewer flagged.
    const fault: { current: GitFault } = {
      current: (args) =>
        (args.includes("submodule") && args.includes("update")) || (args[0] === "worktree" && args[1] === "remove"),
    }
    const pool = makeFaultingPool(repo, baysRoot, 1, log, fault)

    const error = await pool
      .withCandidate(ref, async () => passed)
      .then(
        () => undefined,
        (cause: unknown) => cause,
      )
    expect(error).toBeInstanceOf(AggregateError)
    const aggregate = error as AggregateError
    const detail = aggregate.errors.map((cause) => String((cause as Error).message)).join(" | ")
    expect(detail).toContain("submodule update") // primary cause visible
    expect(detail).toContain("worktree remove") // cleanup failure visible
    expect(String((aggregate.cause as Error | undefined)?.message)).toContain("submodule update") // primary stays primary

    // Residue is NOT orphaned: the worktree is retained so a later close retries it.
    const before = await git(repo, ["worktree", "list", "--porcelain"])
    expect(before).toContain("bays/yrd-warm-")

    fault.current = () => false
    await pool.close()
    const after = await git(repo, ["worktree", "list", "--porcelain"])
    expect(after).not.toContain("bays/yrd-warm-")
  })

  it("cleans up and raises only the primary cause when creation fails but removal succeeds", async () => {
    const { repo, baysRoot, ref } = await submoduleRepository()
    const { log } = capturingLog()
    // Control: materialization fails but the cleanup removal succeeds.
    const fault: { current: GitFault } = { current: (args) => args.includes("submodule") && args.includes("update") }
    const pool = makeFaultingPool(repo, baysRoot, 1, log, fault)

    const error = await pool
      .withCandidate(ref, async () => passed)
      .then(
        () => undefined,
        (cause: unknown) => cause,
      )
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(AggregateError)
    expect(String((error as Error).message)).toContain("submodule update")

    // Removal succeeded: no retained entry, no orphan worktree.
    const worktrees = await git(repo, ["worktree", "list", "--porcelain"])
    expect(worktrees).not.toContain("bays/yrd-warm-")
    expect(pool.stats()).toEqual({ hits: 0, misses: 0, evictions: 0 })
  })

  it("waits for an in-flight check to settle before removing its worktree on close", async () => {
    const { repo, baseSha, baysRoot } = await repository()
    const { log } = capturingLog()
    const pool = makePool(repo, baysRoot, 1, log)

    const started = deferred()
    const gate = deferred()
    let checkPath = ""
    let worktreeAliveDuringCheck = false
    const run = pool.withCandidate(baseSha, async (path) => {
      checkPath = path
      started.resolve()
      await gate.promise
      worktreeAliveDuringCheck = existsSync(path) // the worktree is still present mid-run
      return passed
    })
    await started.promise

    const closing = pool.close()
    // close must NOT tear the worktree down while the check is still running.
    expect(existsSync(checkPath)).toBe(true)

    gate.resolve()
    expect(await run).toEqual(passed)
    await closing

    expect(worktreeAliveDuringCheck).toBe(true)
    expect(existsSync(checkPath)).toBe(false) // removed only after the check settled
  })

  it("rejects a queued waiter loud on close without ever handing it a worktree", async () => {
    const { repo, baseSha, baysRoot } = await repository()
    const { log } = capturingLog()
    const pool = makePool(repo, baysRoot, 1, log)

    const started = deferred()
    const gate = deferred()
    const holder = pool.withCandidate(baseSha, async () => {
      started.resolve()
      await gate.promise
      return passed
    })
    await started.promise

    // Capacity 1 and the holder is in-flight, so this one queues as a waiter.
    let waiterSawPath = false
    const waiter = pool.withCandidate(baseSha, async () => {
      waiterSawPath = true
      return passed
    })

    const closing = pool.close()
    await expect(waiter).rejects.toThrow(/candidate pool is closed/u)
    expect(waiterSawPath).toBe(false) // never woken into a torn-down worktree

    gate.resolve()
    expect(await holder).toEqual(passed)
    await closing
  })

  it("refuses new acquires loud after close", async () => {
    const { repo, baseSha, baysRoot } = await repository()
    const { log } = capturingLog()
    const pool = makePool(repo, baysRoot, 1, log)

    await pool.withCandidate(baseSha, async () => passed)
    await pool.close()

    await expect(pool.withCandidate(baseSha, async () => passed)).rejects.toThrow(/candidate pool is closed/u)
  })

  it("is idempotent when close is called again after draining", async () => {
    const { repo, baseSha, baysRoot } = await repository()
    const { log } = capturingLog()
    const pool = makePool(repo, baysRoot, 1, log)

    let path = ""
    await pool.withCandidate(baseSha, async (worktree) => {
      path = worktree
      return passed
    })

    await pool.close()
    await pool.close() // second close is a clean no-op
    await pool.close()

    expect(existsSync(path)).toBe(false)
  })

  it("measures cold versus warm candidate setup and reports p50/p95", async () => {
    const { repo, baseSha, baysRoot } = await repository()
    const cycles = 4
    const check = async (): Promise<JobResult<{ ok: true }>> => passed

    // Cold: a fresh pool per cycle forces full worktree creation every time.
    const cold: number[] = []
    let coldCreations = 0
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      const { log } = capturingLog()
      const pool = makePool(repo, baysRoot, 1, log)
      const started = performance.now()
      await pool.withCandidate(baseSha, check)
      cold.push(performance.now() - started)
      coldCreations += pool.stats().misses
      await pool.close()
    }

    // Warm: one pool reused — only the first cycle creates a worktree.
    const { log } = capturingLog()
    const pool = makePool(repo, baysRoot, 1, log)
    const warm: number[] = []
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      const started = performance.now()
      await pool.withCandidate(baseSha, check)
      warm.push(performance.now() - started)
    }

    expect(pool.stats()).toEqual({ hits: cycles - 1, misses: 1, evictions: 0 })
    // Warm reuse avoids worktree creation; the evidence is span hit/miss counts,
    // not wall-clock (asserting timings flakes under load — we PRINT them only).
    const report = {
      cycles,
      worktreeCreations: { cold: coldCreations, warm: pool.stats().misses },
      cold: { p50: percentile(cold, 50), p95: percentile(cold, 95) },
      warm: { p50: percentile(warm, 50), p95: percentile(warm, 95) },
    }
    console.log(`[R40] candidate setup ms ${JSON.stringify(report)}`)
  })
})
