/**
 * @failure A stale client keeps writing the pre-27065 percent-escaped queue root and
 *   nothing notices, so the module-load bug 27065 fixed recurs as a find during a
 *   verification instead of an incident (28481 layer 3, @cto 249d8327). The sweep
 *   must also stay quiet about an absent root and about one written only before the
 *   cutover — a false page on a leftover would bury the real one.
 * @level l1 (a filesystem predicate over a temporary tree)
 * @consumer the yrd service tick, before it pages `retired-root-written`
 * @testonly none: the sweep helpers are production API; this test only exercises them
 */
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { legacyQueueRoot, type QueueAddress } from "../src/address.ts"
import { RETIRED_ROOT_CUTOVER, retiredRootSweep } from "../src/retired-root.ts"

const address: QueueAddress = {
  kind: "remote",
  canonical: "github.com/beorn/hh#main",
  host: "github.com",
  path: "beorn/hh",
  queue: "main",
  transport: "https://github.com/beorn/hh.git",
}

const CUTOVER_MS = Date.parse(RETIRED_ROOT_CUTOVER)
const at = (ms: number) => new Date(ms)

function legacyRootIn(): Readonly<{ workdir: string; root: string }> {
  const workdir = mkdtempSync(join(tmpdir(), "yrd-retired-root-"))
  const root = legacyQueueRoot(workdir, address)
  mkdirSync(root, { recursive: true })
  return { workdir, root }
}

describe("the retired-root sweep over the address-owned root", () => {
  it("reports the newest write and the round-log branches after the cutover", () => {
    const { root } = legacyRootIn()
    mkdirSync(join(root, "logs", "environments", "luna2-27822-held-line", "q-1", "logs"), { recursive: true })
    const setup = join(root, "logs", "environments", "luna2-27822-held-line", "q-1", "logs", "setup.log")
    writeFileSync(setup, "setup\n")
    const lock = join(root, "repo.lock")
    writeFileSync(lock, "")
    utimesSync(setup, at(CUTOVER_MS + 60_000), at(CUTOVER_MS + 60_000))
    utimesSync(lock, at(CUTOVER_MS + 120_000), at(CUTOVER_MS + 120_000))

    const sweep = retiredRootSweep(root)
    expect(sweep.root).toBe(root)
    expect(sweep.newest?.path).toBe(lock)
    expect(sweep.branches).toEqual(["luna2-27822-held-line"])
    expect(sweep.live).toBe(true)
  })

  it("stays quiet about an absent root", () => {
    const workdir = mkdtempSync(join(tmpdir(), "yrd-retired-root-"))
    const sweep = retiredRootSweep(legacyQueueRoot(workdir, address))
    expect(sweep.newest).toBeUndefined()
    expect(sweep.live).toBe(false)
  })

  it("stays quiet when every write predates the cutover", () => {
    const { root } = legacyRootIn()
    writeFileSync(join(root, "repo.lock"), "")
    utimesSync(join(root, "repo.lock"), at(CUTOVER_MS - 60_000), at(CUTOVER_MS - 60_000))
    const sweep = retiredRootSweep(root)
    expect(sweep.newest).toBeDefined()
    expect(sweep.live).toBe(false)
  })

  it("still reports a bare repo.lock with no round logs", () => {
    const { root } = legacyRootIn()
    const lock = join(root, "repo.lock")
    writeFileSync(lock, "")
    utimesSync(lock, at(CUTOVER_MS + 1000), at(CUTOVER_MS + 1000))
    const sweep = retiredRootSweep(root)
    expect(sweep.newest?.path).toBe(lock)
    expect(sweep.branches).toEqual([])
    expect(sweep.live).toBe(true)
  })
})

/**
 * 28601 (@cto ruling eff85d6d0ff8, Piece 1): what the sweep reads at the ROOT is decided by
 * `lstatSync(root).isFile()` BEFORE the walk, never by the walk's own `ENOTDIR`. Only a REGULAR
 * file is the retirement tombstone — a symlink to a file, a FIFO and every other non-file,
 * non-directory node stay LOUD, and a deeper unreadable subtree is unchanged.
 */
describe("the retired-root sweep reads an intentional retirement tombstone (28601)", () => {
  it("is quiet when the root is a regular-file tombstone: nothing to read, nothing unreadable", () => {
    const workdir = mkdtempSync(join(tmpdir(), "yrd-retired-root-"))
    const root = legacyQueueRoot(workdir, address)
    mkdirSync(dirname(root), { recursive: true })
    writeFileSync(root, "retired 2026-10-10 (28601): archive=/x sha256=deadbeef\n")
    const sweep = retiredRootSweep(root)
    expect(sweep.files).toBe(0)
    expect(sweep.newest).toBeUndefined()
    expect(sweep.live).toBe(false)
    expect(sweep.unreadable).toEqual([])
  })

  it("stays loud when the root is a SYMLINK to a file (not the retirement mark)", () => {
    const workdir = mkdtempSync(join(tmpdir(), "yrd-retired-root-"))
    const target = join(workdir, "elsewhere")
    writeFileSync(target, "not a tombstone\n")
    const root = legacyQueueRoot(workdir, address)
    mkdirSync(dirname(root), { recursive: true })
    symlinkSync(target, root)
    const sweep = retiredRootSweep(root)
    expect(sweep.unreadable).toEqual([root])
    expect(sweep.live).toBe(false)
  })

  it("stays loud when the root is a FIFO", () => {
    const workdir = mkdtempSync(join(tmpdir(), "yrd-retired-root-"))
    const root = legacyQueueRoot(workdir, address)
    mkdirSync(dirname(root), { recursive: true })
    const made = spawnSync("mkfifo", [root], { stdio: "ignore" })
    if (made.status !== 0) return // mkfifo unavailable in this environment: the row is proven by the symlink row above
    const sweep = retiredRootSweep(root)
    expect(sweep.unreadable).toEqual([root])
  })

  it("stays loud on a DEEPER unreadable subtree, even when the root itself is readable", () => {
    const { root } = legacyRootIn()
    const blocked = join(root, "logs", "environments", "kept")
    mkdirSync(blocked, { recursive: true })
    writeFileSync(join(blocked, "setup.log"), "x\n")
    chmodSync(blocked, 0o000)
    try {
      const sweep = retiredRootSweep(root)
      expect(sweep.unreadable).toEqual([blocked])
    } finally {
      chmodSync(blocked, 0o755)
    }
  })
})
