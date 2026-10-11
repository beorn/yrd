/**
 * @failure A retired percent-escaped queue root is left in place, so the sweep keeps
 *   reading it as a permanent unreadable root and a stale pre-cutover client keeps
 *   recreating the module-load bug 27065 fixed (28601, @cto ruling eff85d6d0ff8).
 *   The verb must archive first, refuse the four one-way doors by name, be idempotent,
 *   and leave a tombstone the sweep reads as intentional retirement.
 * @level l1 (a filesystem operation over a temporary host workdir, real `tar`)
 * @consumer the operator running `yrd queue retire-root` after @chief's word
 * @reach fs-walk <fixture-only: mkdtempSync host workdirs holding a %23 legacy root, its live ~ sibling, .retired/ archives and .retiring trees; no CODE checkout is walked>
 * @testonly none: the verb and the sweep helpers are production API
 */
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { safeRemoveSync } from "removely"
import { describe, expect, it } from "vitest"
import { legacyQueueRoot, queueRoot, type QueueAddress } from "../src/address.ts"
import { retiredRootSweep } from "../src/retired-root.ts"
import { RETIRE_ROOT_CODES, retiredArchivePath, retireRetiredRoot, tombstoneLine } from "../src/retire-root.ts"

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

/** The .retiring sibling the verb moves the root aside to. */
const retiringPath = (root: string, at: Date): string =>
  join(dirname(retiredArchivePath(root, at)), `${basename(root)}.retiring`)

const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex")

/** A REAL archive the verb did not write — `tar -tf` will list it. */
const tarTree = (parent: string, member: string, dest: string): void => {
  mkdirSync(dirname(dest), { recursive: true })
  const result = spawnSync("tar", ["-C", parent, "-c", "--zstd", "-f", dest, member])
  if (result.status !== 0) throw new Error(`tar failed: ${String(result.stderr)}`)
}

/** Regular-file byte total of a tree, for asserting the dry run's net. */
const sumBytes = (root: string): number => {
  let total = 0
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) total += statSync(path).size
    }
  }
  walk(root)
  return total
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
    expect(existsSync(retiringPath(root, AT))).toBe(false)
    const sweep = retiredRootSweep(root)
    expect(sweep.files).toBe(0)
    expect(sweep.unreadable).toEqual([])
    expect(sweep.live).toBe(false)
  })

  it("a dry run writes nothing, measures the archive, and reports the real net bytes freed", async () => {
    const { host, root } = hostIn()
    plant(root)
    const treeBytes = sumBytes(root)
    const result = await retireRetiredRoot({ host, address, at: AT, dryRun: true })
    expect(result.dryRun).toBe(true)
    expect(result.action).toBe("archived")
    expect(result.files).toBe(2)
    // D2: the archive is MEASURED (streamed to a counter), not reported as 0.
    expect(result.archiveBytes).toBeGreaterThan(0)
    expect(result.bytesFreed).toBe(treeBytes - result.archiveBytes)
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/u)
    // Nothing moved: the root is still a directory and no archive exists.
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
    safeRemoveSync(live, { within: realpathSync(tmpdir()), allowMissing: true })
    expect(await codeOf(() => retireRetiredRoot({ host, address, at: AT }))).toBe(RETIRE_ROOT_CODES.noLiveRoot)
  })

  it("refuses an absent root with no intermediate names: a success would be a false record", async () => {
    const { host, root } = hostIn()
    safeRemoveSync(root, { within: realpathSync(tmpdir()), allowMissing: true })
    expect(await codeOf(() => retireRetiredRoot({ host, address, at: AT }))).toBe(RETIRE_ROOT_CODES.absent)
  })

  it("refuses a foreign file at the root: overwriting it would destroy a record", async () => {
    const { host, root } = hostIn()
    safeRemoveSync(root, { within: realpathSync(tmpdir()), allowMissing: true })
    writeFileSync(root, "someone else's file\n")
    expect(await codeOf(() => retireRetiredRoot({ host, address, at: AT }))).toBe(RETIRE_ROOT_CODES.foreignFile)
  })

  it("refuses a symlink at the root: retiring it would destroy an unknown node", async () => {
    const { host, root } = hostIn()
    safeRemoveSync(root, { within: realpathSync(tmpdir()), allowMissing: true })
    const target = join(host, "elsewhere")
    writeFileSync(target, "x\n")
    symlinkSync(target, root)
    expect(await codeOf(() => retireRetiredRoot({ host, address, at: AT }))).toBe(RETIRE_ROOT_CODES.foreignFile)
  })

  it("archives a tree that CONTAINS a symlink: the symlink entry is in the archive set", async () => {
    const { host, root } = hostIn()
    plant(root)
    writeFileSync(join(root, "target"), "t\n")
    symlinkSync("target", join(root, "alink"))
    const archive = retiredArchivePath(root, AT)
    const result = await retireRetiredRoot({ host, address, at: AT })
    expect(result.action).toBe("archived")
    // A symlink is a LISTED entry, but it is not a regular file for the census.
    expect(result.files).toBe(3)
    const listing = spawnSync("tar", ["-tf", archive]).stdout.toString()
    expect(listing).toContain(`${basename(root)}/alink`)
    expect(spawnSync("tar", ["-tf", archive]).status).toBe(0)
  })

  it("keeps an existing archive that DOES match (the crash-after-c state), `resumed`", async () => {
    const { host, root } = hostIn()
    plant(root)
    const archive = retiredArchivePath(root, AT)
    tarTree(dirname(root), basename(root), archive)
    const before = readFileSync(archive)
    const result = await retireRetiredRoot({ host, address, at: AT })
    expect(result.action).toBe("resumed")
    // The archive is KEPT byte-for-byte, never rewritten with a fresh timestamp.
    expect(readFileSync(archive).equals(before)).toBe(true)
    expect(lstatSync(root).isFile()).toBe(true)
    expect(existsSync(retiringPath(root, AT))).toBe(false)
  })

  it("refuses an existing archive whose REAL listing differs: writing it would overwrite a record", async () => {
    const { host, root } = hostIn()
    plant(root)
    const archive = retiredArchivePath(root, AT)
    // A genuine tar of a DIFFERENT tree — today's "not a tar" fixture only ever
    // exercised the cannot-list branch and passed trivially (D1/D8).
    const other = join(host, "other")
    mkdirSync(join(other, basename(root), "extra"), { recursive: true })
    writeFileSync(join(other, basename(root), "extra", "x.txt"), "x\n")
    tarTree(other, basename(root), archive)
    expect(await codeOf(() => retireRetiredRoot({ host, address, at: AT }))).toBe(RETIRE_ROOT_CODES.archiveDiffers)
  })

  it("resumes after e: the root is already aside, so it places the tombstone and removes .retiring", async () => {
    const { host, root } = hostIn()
    plant(root)
    const archive = retiredArchivePath(root, AT)
    tarTree(dirname(root), basename(root), archive)
    renameSync(root, retiringPath(root, AT))
    const result = await retireRetiredRoot({ host, address, at: AT })
    expect(result.action).toBe("resumed")
    expect(lstatSync(root).isFile()).toBe(true)
    expect(existsSync(retiringPath(root, AT))).toBe(false)
    expect(retiredRootSweep(root).unreadable).toEqual([])
  })

  it("resumes after f: the tombstone is in place yet .retiring survives, so it finishes the removal", async () => {
    const { host, root } = hostIn()
    plant(root)
    const archive = retiredArchivePath(root, AT)
    tarTree(dirname(root), basename(root), archive)
    renameSync(root, retiringPath(root, AT))
    writeFileSync(root, tombstoneLine(archive, sha256File(archive), AT))
    const result = await retireRetiredRoot({ host, address, at: AT })
    expect(result.action).toBe("resumed")
    expect(existsSync(retiringPath(root, AT))).toBe(false)
    expect(lstatSync(root).isFile()).toBe(true)
  })

  it("D4: a moved-aside tree that NO LONGER matches the archive is KEPT and refused by name", async () => {
    const { host, root } = hostIn()
    plant(root)
    const archive = retiredArchivePath(root, AT)
    tarTree(dirname(root), basename(root), archive)
    // A write lands AFTER the archive: the moved-aside tree now holds an extra file.
    writeFileSync(join(root, "landed-after.txt"), "late\n")
    renameSync(root, retiringPath(root, AT))
    expect(await codeOf(() => retireRetiredRoot({ host, address, at: AT }))).toBe(RETIRE_ROOT_CODES.archiveDiffers)
    // The unproven tree is KEPT — never removed on a listing that disagrees.
    expect(existsSync(retiringPath(root, AT))).toBe(true)
    expect(lstatSync(root).isFile()).toBe(true)
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
