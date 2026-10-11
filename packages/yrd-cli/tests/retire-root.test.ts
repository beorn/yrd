/**
 * @failure A retired percent-escaped queue root is left in place, so the sweep keeps
 *   reading it as a permanent unreadable root and a stale pre-cutover client keeps
 *   recreating the module-load bug 27065 fixed (28601, @cto ruling eff85d6d0ff8).
 *   The verb must archive first, refuse the four one-way doors by name, be idempotent,
 *   and leave a tombstone the sweep reads as intentional retirement.
 * @level l1 (a filesystem operation over a temporary host workdir)
 * @consumer the operator running `yrd queue retire-root` after @chief's word
 * @testonly none: the verb and the sweep helpers are production API
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { legacyQueueRoot, queueRoot, type QueueAddress } from "../src/address.ts"
import { retiredRootSweep } from "../src/retired-root.ts"
import { RETIRE_ROOT_CODES, retiredArchivePath, retireRetiredRoot } from "../src/retire-root.ts"

const address: QueueAddress = {
  kind: "remote",
  canonical: "github.com/beorn/hh#main",
  host: "github.com",
  path: "beorn/hh",
  queue: "main",
  transport: "https://github.com/beorn/hh.git",
}
const AT = new Date("2026-10-10T12:00:00Z")

function hostIn(): Readonly<{ host: string; live: string; root: string }> {
  const host = mkdtempSync(join(tmpdir(), "yrd-retire-root-"))
  const live = queueRoot(host, address)
  const root = legacyQueueRoot(host, address)
  mkdirSync(join(live, "repo"), { recursive: true })
  mkdirSync(root, { recursive: true })
  return { host, live, root }
}

const plant = (root: string): void => {
  mkdirSync(join(root, "logs", "environments", "b1", "q-1"), { recursive: true })
  writeFileSync(join(root, "logs", "environments", "b1", "q-1", "setup.log"), "hello\n")
  writeFileSync(join(root, "repo.lock"), "")
}

/** The refusal code a call threw, or undefined when it did not throw. */
async function codeOf(work: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await work()
    return undefined
  } catch (error) {
    return /^([a-z-]+):/u.exec(error instanceof Error ? error.message : String(error))?.[1]
  }
}

describe("yrd queue retire-root (28601)", () => {
  it("archives the tree, leaves a regular-file tombstone, and lets the sweep read it as retirement", async () => {
    const { host, root } = hostIn()
    plant(root)
    const archive = retiredArchivePath(root, AT)
    const result = await retireRetiredRoot({ host, address, at: AT })
    expect(result.action).toBe("archived")
    expect(result.files).toBe(2)
    // The root is now a NON-directory file, so a pre-cutover mkdir fails by name here.
    expect(lstatSync(root).isFile()).toBe(true)
    expect(existsSync(archive)).toBe(true)
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(result.tombstone).toContain(`archive=${archive}`)
    expect(result.tombstone).toContain(`sha256=${result.sha256}`)
    // The moved-aside tree is gone.
    expect(existsSync(join(dirname(archive), `${basename(root)}.retiring`))).toBe(false)
    const sweep = retiredRootSweep(root)
    expect(sweep.files).toBe(0)
    expect(sweep.unreadable).toEqual([])
    expect(sweep.live).toBe(false)
  })

  it("a dry run writes nothing and reports the plan and the net bytes freed", async () => {
    const { host, root } = hostIn()
    plant(root)
    const result = await retireRetiredRoot({ host, address, at: AT, dryRun: true })
    expect(result.dryRun).toBe(true)
    expect(result.action).toBe("archived")
    expect(result.files).toBe(2)
    expect(lstatSync(root).isDirectory()).toBe(true)
    expect(existsSync(retiredArchivePath(root, AT))).toBe(false)
  })

  it("is idempotent: a matching tombstone is `skipped`, never re-archived", async () => {
    const { host, root } = hostIn()
    plant(root)
    await retireRetiredRoot({ host, address, at: AT })
    const again = await retireRetiredRoot({ host, address, at: AT })
    expect(again.action).toBe("skipped")
    expect(again.files).toBe(0)
  })

  it("refuses when the live tilde root is absent: the legacy root may be the only copy", async () => {
    const { host, live } = hostIn()
    rmSync(live, { recursive: true, force: true })
    expect(await codeOf(() => retireRetiredRoot({ host, address, at: AT }))).toBe(RETIRE_ROOT_CODES.noLiveRoot)
  })

  it("refuses an absent root with no intermediate names: a success would be a false record", async () => {
    const { host, root } = hostIn()
    rmSync(root, { recursive: true, force: true })
    expect(await codeOf(() => retireRetiredRoot({ host, address, at: AT }))).toBe(RETIRE_ROOT_CODES.absent)
  })

  it("refuses a foreign file at the root: overwriting it would destroy a record", async () => {
    const { host, root } = hostIn()
    rmSync(root, { recursive: true, force: true })
    writeFileSync(root, "someone else's file\n")
    expect(await codeOf(() => retireRetiredRoot({ host, address, at: AT }))).toBe(RETIRE_ROOT_CODES.foreignFile)
  })

  it("refuses a symlink at the root: retiring it would destroy an unknown node", async () => {
    const { host, root } = hostIn()
    rmSync(root, { recursive: true, force: true })
    const target = join(host, "elsewhere")
    writeFileSync(target, "x\n")
    symlinkSync(target, root)
    expect(await codeOf(() => retireRetiredRoot({ host, address, at: AT }))).toBe(RETIRE_ROOT_CODES.foreignFile)
  })

  it("refuses an existing archive whose listing differs: writing it would overwrite a record", async () => {
    const { host, root } = hostIn()
    plant(root)
    const archive = retiredArchivePath(root, AT)
    mkdirSync(dirname(archive), { recursive: true })
    writeFileSync(archive, "not a tar at all\n")
    expect(await codeOf(() => retireRetiredRoot({ host, address, at: AT }))).toBe(RETIRE_ROOT_CODES.archiveDiffers)
  })

  it("leaves the .retired dot sibling inert to the yrd reader (the sweep never lists the owner dir)", async () => {
    const { host, root } = hostIn()
    plant(root)
    await retireRetiredRoot({ host, address, at: AT })
    // The archive dir exists beside the roots, yet the sweep reads only the %23 sibling.
    expect(existsSync(join(dirname(root), ".retired"))).toBe(true)
    const sweep = retiredRootSweep(root)
    expect(sweep.unreadable).toEqual([])
    expect(sweep.files).toBe(0)
    // And no yrd source enumerates the owner/host directory: the address builders compute
    // paths directly, so a dot entry can never be mistaken for a queue root by yrd itself.
    expect(existsSync(queueRoot(host, address))).toBe(true)
  })
})
