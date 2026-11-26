/**
 * @failure 2026-11-26: the terminfo-merge site build was killed twice at its 420 s bound at 10.7 GB, and the queue said
 *          only "could not judge (ran past its bound…)". The guard's own peak line reached one log and lost the race in
 *          the other, so the queue reads the tree's resident memory itself, once, at the kill (@cto dd0e43f2).
 * @level l2
 * @consumer @yrd/process createProcess, yrd-queue-core runCheck's bound-kill reason
 * @testonly none: drives only the exported createProcess, readRssAtKill and describeRssAtKill
 */
import { afterEach, describe, expect, test } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProcess, describeRssAtKill, readRssAtKill } from "../src/index.ts"

const temporary: string[] = []
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("RSS at kill", () => {
  test("a run the bound kills carries its group's resident memory, the allocating grandchild largest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rss-at-kill-"))
    temporary.push(dir)
    const hog = join(dir, "hog.ts")
    // The grandchild allocates and touches 64 MiB, prints its pid, then waits for the kill. How much of it the kernel
    // keeps resident is the host's business (under memory pressure 128 MiB touched read 31 MB resident, 0 swap,
    // 2026-11-26), so this pins which process the reading attributes, and the /proc fixture below pins the bytes.
    writeFileSync(
      hog,
      "const b = new Uint8Array(64 * 1024 * 1024); for (let i = 0; i < b.length; i += 4096) b[i] = 1;" +
        " console.log('ready', process.pid); setInterval(() => {}, 1000)\n",
    )
    await using runner = createProcess({ cwd: dir })
    const result = await runner.run({
      argv: ["sh", "-c", `"${process.execPath}" "${hog}" & wait`],
      cwd: dir,
      // Generous: a host at load 80 took over 8 s to start bun and fill the buffer.
      timeoutMs: 20_000,
    })
    expect(result.timedOut).toBe(true)
    const hogPid = Number(/ready (\d+)/u.exec(result.stdout)?.[1])
    expect(hogPid, `the hog never reported before the bound: ${result.stdout}`).toBeGreaterThan(0)
    expect(result.rssAtKill).toMatchObject({ readable: true })
    if (result.rssAtKill?.readable !== true) throw new Error("unreachable")
    expect(result.rssAtKill.processes).toBeGreaterThanOrEqual(2)
    expect(result.rssAtKill.largest?.pid).toBe(hogPid)
    expect(result.rssAtKill.largest?.bytes).toBeGreaterThan(0)
    expect(result.rssAtKill.totalBytes).toBeGreaterThanOrEqual(result.rssAtKill.largest?.bytes ?? 0)
    expect(describeRssAtKill(result.rssAtKill)).toMatch(/^RSS at kill \d+\.\d GiB \(largest \S+; \d+ process\(es\), /u)
  }, 60_000)

  test("a run that exits on its own carries no RSS reading", async () => {
    await using runner = createProcess({ cwd: tmpdir() })
    const result = await runner.run({ argv: ["true"], cwd: tmpdir(), timeoutMs: 8_000 })
    expect(result.timedOut).toBe(false)
    expect(result.rssAtKill).toBeUndefined()
  })

  test("reads only the named group from a /proc tree, and skips a process with no VmRSS", () => {
    const proc = mkdtempSync(join(tmpdir(), "rss-at-kill-proc-"))
    temporary.push(proc)
    const add = (pid: number, comm: string, pgrp: number, kb: number | undefined): void => {
      mkdirSync(join(proc, String(pid)))
      writeFileSync(
        join(proc, String(pid), "stat"),
        `${String(pid)} (${comm}) S 1 ${String(pgrp)} ${String(pgrp)} 0 -1\n`,
      )
      writeFileSync(
        join(proc, String(pid), "status"),
        kb === undefined ? "Name:\tz\n" : `Name:\tx\nVmRSS:\t ${String(kb)} kB\n`,
      )
    }
    add(100, "sh", 100, 1024)
    add(101, "bun build (x)", 100, 3 * 1024 * 1024)
    add(102, "zombie", 100, undefined)
    add(200, "other", 200, 9 * 1024 * 1024)
    mkdirSync(join(proc, "self"))
    expect(readRssAtKill(100, proc)).toEqual({
      readable: true,
      processes: 3,
      totalBytes: (1024 + 3 * 1024 * 1024) * 1024,
      largest: { pid: 101, comm: "bun build (x)", bytes: 3 * 1024 * 1024 * 1024 },
    })
    expect(describeRssAtKill(readRssAtKill(100, proc))).toBe(
      "RSS at kill 3.0 GiB (largest bun build (x); 3 process(es), 3.0 GiB total)",
    )
  })

  test("an unreadable /proc is named by its errno, never blank", () => {
    const missing = join(tmpdir(), "rss-at-kill-no-such-proc-root")
    expect(readRssAtKill(1, missing)).toEqual({ readable: false, error: "ENOENT" })
    expect(describeRssAtKill(readRssAtKill(1, missing))).toBe("RSS unreadable: ENOENT")
    expect(describeRssAtKill(undefined)).toBe("RSS unreadable: not measured by this process runner")
  })
})
