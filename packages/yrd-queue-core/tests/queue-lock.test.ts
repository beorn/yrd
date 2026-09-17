/**
 * The round lock: one round at a time in a queue workdir (andon phase 2).
 *
 * Every interleaving here is driven, never timed. A contender is stalled at the
 * one seam the protocol has between listing the claims and publishing its own,
 * and released when the test says so, so the order of events is the test's and
 * not the scheduler's. Polling only decides how soon a waiter notices a change,
 * never what it concludes.
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { afterAll, describe, expect, it, vi } from "vitest"
import { processStartIdentity } from "@yrd/process"

import { ROUND_LOCK, takeRoundLock, type RoundLock, type RoundLockWait } from "../src/queue-lock.ts"

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

function workdir(): string {
  const root = mkdtempSync(join(tmpdir(), "yrd-round-lock-"))
  roots.push(root)
  return root
}

/** The lock directory's entries, sorted: claims, markers, and anything a contender left behind. */
function entries(root: string): readonly string[] {
  return readdirSync(join(root, ROUND_LOCK)).sort()
}

/**
 * A process id that named a process and does not any more: a child run to
 * completion and reaped. Any number picked out of the air could be running.
 */
function exitedPid(): number {
  const child = spawnSync("git", ["--version"])
  const pid = child.pid
  if (pid === undefined) throw new Error("could not spawn a child to take an exited process id from")
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid
  }
  throw new Error(`pid ${String(pid)} is still running, so it cannot stand for a dead holder`)
}

function deferred<T = void>(): Readonly<{ promise: Promise<T>; resolve: (value: T) => void }> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

/** A take whose settling the test can observe without awaiting it. */
function taking(root: string, options: Parameters<typeof takeRoundLock>[1]) {
  const state: { lock?: RoundLock; error?: unknown } = {}
  const promise = takeRoundLock(root, options).then(
    (lock) => {
      state.lock = lock
      return lock
    },
    (error: unknown) => {
      state.error = error
      throw error
    },
  )
  return { promise, state }
}

/** A waiter that says when it begins waiting on a given generation. */
function waitsOn() {
  const waits: RoundLockWait[] = []
  const begun = new Map<number, ReturnType<typeof deferred<RoundLockWait>>>()
  const on = (generation: number) => {
    const known = begun.get(generation) ?? deferred<RoundLockWait>()
    begun.set(generation, known)
    return known.promise
  }
  const onWait = (wait: RoundLockWait): void => {
    waits.push(wait)
    const known = begun.get(wait.generation) ?? deferred<RoundLockWait>()
    begun.set(wait.generation, known)
    known.resolve(wait)
  }
  return { on, onWait, waits }
}

/** Which came first for a stalled contender once it resumes: waiting on the holder, or holding beside it. */
async function firstOf(
  waits: Promise<unknown>,
  holds: Promise<RoundLock>,
): Promise<"waits" | "holds beside the holder"> {
  return Promise.race([waits.then(() => "waits" as const), holds.then(() => "holds beside the holder" as const)])
}

/** This process's own start, both halves, as a waiter reads it through `/proc`. */
function own(): Readonly<{ boot: string; tick: number }> {
  const { boot, tick } = processStartIdentity(process.pid)
  if (boot === undefined || tick === undefined) {
    throw new Error(`/proc does not answer in full for this process, pid ${String(process.pid)}`)
  }
  return { boot, tick }
}

/**
 * A proc root that answers for this process as `/proc` does, and a wall clock
 * the test can step. This process's own `stat` line and the boot id are copied,
 * and neither changes while the process lives. `btime` in `stat` is the kernel's
 * wall-clock reading of the boot, which a stepped clock moves. `step` moves that
 * reading and this process's own clock (`Date`) together, to an offset from the
 * real clock.
 */
function steppedClock(root: string): Readonly<{ procRoot: string; step: (offsetMs: number) => void }> {
  const procRoot = join(root, "proc")
  mkdirSync(join(procRoot, "sys", "kernel", "random"), { recursive: true })
  mkdirSync(join(procRoot, String(process.pid)))
  writeFileSync(join(procRoot, "sys", "kernel", "random", "boot_id"), readFileSync("/proc/sys/kernel/random/boot_id"))
  writeFileSync(join(procRoot, String(process.pid), "stat"), readFileSync(`/proc/${String(process.pid)}/stat`))
  const btime = /^btime (\d+)$/mu.exec(readFileSync("/proc/stat", "utf8"))?.[1]
  if (btime === undefined) throw new Error("/proc/stat carries no btime line to step")
  const step = (offsetMs: number): void => {
    writeFileSync(join(procRoot, "stat"), `btime ${String(Number(btime) + offsetMs / 1000)}\n`)
    if (offsetMs !== 0) vi.setSystemTime(vi.getRealSystemTime() + offsetMs)
  }
  step(0)
  return { procRoot, step }
}

describe("the round lock", () => {
  it("reads this process's own boot and start tick, so a live holder can be proven to be itself", () => {
    expect(own().boot).toMatch(/^[0-9a-f-]{36}$/u)
    expect(Number.isSafeInteger(own().tick)).toBe(true)
    expect(processStartIdentity(process.pid)).toEqual(own())
  })

  it("two rounds in one process wait on each other, and a released claim stays until a newer holder cleans it", async () => {
    const root = workdir()
    const first = await takeRoundLock(root, { command: "first" })
    expect(first.generation).toBe(1)
    expect(first.holder).toMatchObject({ command: "first", pid: process.pid, ...own() })

    const waiter = waitsOn()
    const second = taking(root, { command: "second", onWait: waiter.onWait, pollMs: 5 })
    const wait = await waiter.on(1)
    expect(wait).toMatchObject({ generation: 1, holder: { command: "first", pid: process.pid }, unproven: false })
    expect(second.state.lock).toBeUndefined()

    first.release()
    expect(entries(root)).toEqual(["gen-1", "gen-1.released"])
    const lock = await second.promise
    expect(lock.generation).toBe(2)
    expect(entries(root)).toEqual(["gen-2"])
    expect(waiter.waits).toHaveLength(1)
    lock.release()
  })

  it("a holder whose pid names no process is gone, and its claim is taken over without a wait", async () => {
    const root = workdir()
    await takeRoundLock(root, { command: "dead", identity: { pid: exitedPid(), ...own() } })
    const waiter = waitsOn()
    const lock = await takeRoundLock(root, { command: "next", onWait: waiter.onWait })
    expect(lock.generation).toBe(2)
    expect(waiter.waits).toEqual([])
    expect(entries(root)).toEqual(["gen-2"])
  })

  // A reused pid is a different process, and one tick apart is already a
  // different process: there is no tolerance to fall inside.
  it.each([
    { half: "boot", identity: () => ({ boot: "an-earlier-boot", tick: own().tick }) },
    { half: "start tick", identity: () => ({ boot: own().boot, tick: own().tick - 1 }) },
  ])(
    "a live pid whose $half differs from its claim's belongs to another process, and is gone",
    async ({ identity }) => {
      const root = workdir()
      await takeRoundLock(root, { command: "earlier", identity: { pid: process.pid, ...identity() } })
      const waiter = waitsOn()
      const lock = await takeRoundLock(root, { command: "next", onWait: waiter.onWait })
      expect(lock.generation).toBe(2)
      expect(waiter.waits).toEqual([])
    },
  )

  it("a claim from another boot is gone, even where the live pid's start tick cannot be read", async () => {
    const root = workdir()
    const bootOnly = join(root, "boot-only-proc")
    mkdirSync(join(bootOnly, "sys", "kernel", "random"), { recursive: true })
    writeFileSync(join(bootOnly, "sys", "kernel", "random", "boot_id"), readFileSync("/proc/sys/kernel/random/boot_id"))
    await takeRoundLock(root, {
      command: "before the reboot",
      identity: { boot: "an-earlier-boot", pid: process.pid, tick: own().tick },
    })
    const waiter = waitsOn()
    const lock = await takeRoundLock(root, { command: "next", onWait: waiter.onWait, procRoot: bootOnly })
    expect(lock.generation).toBe(2)
    expect(waiter.waits).toEqual([])
  })

  it.each([
    { side: "the waiter cannot read the holder's start", holder: {}, waiterReadsNoProc: true },
    {
      side: "the holder could not record its own start",
      holder: { identity: { pid: process.pid } },
      waiterReadsNoProc: false,
    },
  ])(
    "a live pid whose start is unproven is waited on, and said once, when $side",
    async ({ holder, waiterReadsNoProc }) => {
      const root = workdir()
      const procRoot = join(root, "no-proc")
      mkdirSync(procRoot)
      const held = await takeRoundLock(root, { command: "holder", ...holder })
      const waits = waitsOn()
      const next = taking(root, {
        command: "waiter",
        onWait: waits.onWait,
        pollMs: 5,
        ...(waiterReadsNoProc ? { procRoot } : {}),
      })
      expect(await waits.on(1)).toMatchObject({ generation: 1, holder: { command: "holder" }, unproven: true })
      // Many polls, each of which found the holder live and unproven.
      await delay(100)
      expect(next.state.lock).toBeUndefined()
      expect(waits.waits).toHaveLength(1)

      held.release()
      expect((await next.promise).generation).toBe(2)
    },
  )

  // THE PROPERTY THE LOCK EXISTS FOR (P2-set-v3). A wall clock stepped five
  // seconds either way while the lock is held, the kernel's reading of the boot
  // and this process's clock alike, never makes its live holder read as another
  // process, because no half of a start is read against the clock.
  it.each([
    { direction: "forward", offsetMs: 5_000 },
    { direction: "back", offsetMs: -5_000 },
  ])("a wall clock stepped 5 s $direction while the lock is held leaves its live holder held", async ({ offsetMs }) => {
    const root = workdir()
    const clock = steppedClock(root)
    try {
      const held = await takeRoundLock(root, { command: "holder", procRoot: clock.procRoot })
      const before = waitsOn()
      const early = taking(root, { command: "early", onWait: before.onWait, pollMs: 5, procRoot: clock.procRoot })
      expect(await before.on(1)).toMatchObject({ generation: 1, unproven: false })

      clock.step(offsetMs)
      // A waiter that first looks after the step waits on the holder, proven...
      const after = waitsOn()
      const late = taking(root, { command: "late", onWait: after.onWait, pollMs: 5, procRoot: clock.procRoot })
      expect(await firstOf(after.on(1), late.promise)).toBe("waits")
      expect(await after.on(1)).toMatchObject({ generation: 1, holder: { command: "holder" }, unproven: false })
      // ...and the waiter from before the step has looked many times since, and still waits.
      await delay(100)
      expect(early.state.lock).toBeUndefined()
      expect(late.state.lock).toBeUndefined()

      held.release()
      const next = await Promise.race([early.promise, late.promise])
      expect(next.generation).toBe(2)
      next.release()
      const last = await (early.state.lock === next ? late.promise : early.promise)
      expect(last.generation).toBe(3)
      last.release()
    } finally {
      vi.useRealTimers()
    }
  })

  it("a contender stalled between listing and publishing never holds beside a newer holder (the phase A counterexample)", async () => {
    const root = workdir()
    // D holds generation 1, and is dead.
    const d = await takeRoundLock(root, { command: "D", identity: { pid: exitedPid(), ...own() } })
    expect(d.generation).toBe(1)

    // C lists (generation 1, gone) and stalls before it publishes generation 2.
    const cListed = deferred<number>()
    const cResume = deferred()
    let stalls = 0
    const cWaits = waitsOn()
    const c = taking(root, {
      beforeLink: async (generation) => {
        if (stalls++ > 0) return
        cListed.resolve(generation)
        await cResume.promise
      },
      command: "C",
      onWait: cWaits.onWait,
      pollMs: 5,
    })
    expect(await cListed.promise).toBe(2)

    // A publishes generation 2, holds, cleans generation 1, and finishes. Its
    // claim stays, marked released: its number is never free again.
    const a = await takeRoundLock(root, { command: "A" })
    expect(a.generation).toBe(2)
    a.release()
    expect(entries(root).filter((name) => name.startsWith("gen-"))).toEqual(["gen-2", "gen-2.released"])

    // B takes generation 3 and holds; its cleanup frees the name 2.
    const b = await takeRoundLock(root, { command: "B" })
    expect(b.generation).toBe(3)
    expect(entries(root).filter((name) => name.startsWith("gen-"))).toEqual(["gen-3"])

    // C resumes and wins the freed name 2, lists again, finds generation 3
    // above its own, yields, and waits on B instead of holding beside it.
    cResume.resolve()
    expect(await firstOf(cWaits.on(3), c.promise)).toBe("waits")
    expect(await cWaits.on(3)).toMatchObject({ generation: 3, holder: { command: "B" } })
    expect(c.state.lock).toBeUndefined()
    expect(entries(root)).toEqual(["gen-3"])

    b.release()
    const held = await c.promise
    expect(held.generation).toBe(4)
    expect(entries(root)).toEqual(["gen-4"])
  })

  it("a contender stalled past a claim that is still held loses the name to it, and waits on its holder", async () => {
    const root = workdir()
    await takeRoundLock(root, { command: "D", identity: { pid: exitedPid(), ...own() } })
    const cListed = deferred<number>()
    const cResume = deferred()
    let stalls = 0
    const cWaits = waitsOn()
    const c = taking(root, {
      beforeLink: async (generation) => {
        if (stalls++ > 0) return
        cListed.resolve(generation)
        await cResume.promise
      },
      command: "C",
      onWait: cWaits.onWait,
      pollMs: 5,
    })
    expect(await cListed.promise).toBe(2)
    const a = await takeRoundLock(root, { command: "A" })
    expect(a.generation).toBe(2)

    // The name 2 exists, so C's publish fails with EEXIST and C looks again.
    cResume.resolve()
    expect(await firstOf(cWaits.on(2), c.promise)).toBe("waits")
    expect(await cWaits.on(2)).toMatchObject({ generation: 2, holder: { command: "A" } })
    expect(c.state.lock).toBeUndefined()
    expect(entries(root)).toEqual(["gen-2"])

    a.release()
    expect((await c.promise).generation).toBe(3)
    expect(entries(root)).toEqual(["gen-3"])
  })

  it("a wait past the stall budget raises one alarm and goes on waiting", async () => {
    const root = workdir()
    const held = await takeRoundLock(root, { command: "long round" })
    const stalls: unknown[] = []
    const stalled = deferred()
    const next = taking(root, {
      command: "waiter",
      onStall: (wait) => {
        stalls.push(wait)
        stalled.resolve()
      },
      pollMs: 5,
      stallMs: 20,
    })
    await stalled.promise
    await delay(60)
    expect(next.state.lock).toBeUndefined()
    expect(stalls).toHaveLength(1)
    expect(stalls[0]).toMatchObject({ generation: 1, holder: { command: "long round" }, unproven: false })
    expect((stalls[0] as { waitedMs: number }).waitedMs).toBeGreaterThanOrEqual(20)

    held.release()
    expect((await next.promise).generation).toBe(2)
    expect(stalls).toHaveLength(1)
  })

  it("an aborted wait rejects with the signal's reason and leaves nothing behind", async () => {
    const root = workdir()
    const held = await takeRoundLock(root, { command: "holder" })
    const stop = new AbortController()
    const waits = waitsOn()
    const next = taking(root, { command: "waiter", onWait: waits.onWait, pollMs: 5, signal: stop.signal })
    await waits.on(1)
    stop.abort(new Error("stopped"))
    await expect(next.promise).rejects.toThrow()
    expect(entries(root)).toEqual(["gen-1"])
    expect(existsSync(join(root, ROUND_LOCK, "gen-1.released"))).toBe(false)
    held.release()
  })
})
