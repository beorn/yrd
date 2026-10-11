/**
 * `yrd queue retire-root <queue-address>` (28601, @cto ruling eff85d6d0ff8).
 *
 * Before 27065 a yrd resolved a queue's physical root with a percent-escaped
 * separator, `<workdir>/<host>/<path>%23<queue>`. That escape decodes back to a
 * hash in URL-based module loaders, so a queue materialized there corrupts module
 * loading. The fix moved the boundary to a literal `~`, leaving the old root
 * beside the new one — and a client still on the pre-cutover code writes it.
 *
 * `retired-root.ts` reads and pages; it NEVER drains. This is the sanctioned
 * drain: it ARCHIVES the retired root losslessly, then replaces it with a
 * NON-directory tombstone FILE at the exact old path. Nothing can be created
 * under a non-directory, so a pre-cutover client's `mkdir` fails by name
 * (`EEXIST` on the exact path, `ENOTDIR` on a subpath) before it opens any setup
 * log — and the sweep reads that regular file as intentional retirement.
 *
 * The archive lives in a dot-named sibling (`.retired/`), never a valid queue
 * address, so no builder can collide with it; the sweep never reads it (that
 * would be a parser or a second monitor), and the tombstone carries its path and
 * hash for the operator. The positional is the queue ADDRESS and the path is
 * derived with `legacyQueueRoot` — the same builder a pre-cutover client used —
 * so this verb can never act on an arbitrary path.
 */
import { createHash } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  type Dirent,
} from "node:fs"
import { basename, dirname, join } from "node:path"
import { createProcess, type Process } from "@yrd/process"
import { safeRemove } from "removely"
import { type QueueAddress, legacyQueueRoot, queueRoot } from "./address.ts"
import { RETIRED_ROOT_CUTOVER } from "./retired-root.ts"

/** The stable codes this verb refuses with. The subject is always the root path. */
export const RETIRE_ROOT_CODES = {
  absent: "yrd-retire-root-absent",
  foreignFile: "yrd-retire-root-foreign-file",
  archiveDiffers: "yrd-retire-archive-exists-different-bytes",
  noLiveRoot: "yrd-retire-no-live-root",
} as const

/** Every refusal names the ONE-WAY DOOR it protects (@cto step 4). */
function refuse(code: string, root: string, door: string): Error {
  return new Error(`${code}: ${root}: ${door}`)
}

export type RetireRootAction = "archived" | "resumed" | "skipped"

export type RetireRootResult = Readonly<{
  /** The retired percent-escaped root that was retired. */
  root: string
  /** The dot-sibling archive, or where it WOULD be written on a dry run. */
  archive: string
  /** The tombstone record the operator reads at the old path. */
  tombstone: string
  action: RetireRootAction
  /** Regular files in the archived tree — the census the archive listing is checked against. */
  files: number
  archiveBytes: number
  /** Net bytes this frees on the same disk: the tree minus the archive that replaces it. */
  bytesFreed: number
  sha256: string
  /** True when nothing was written (dry run). */
  dryRun: boolean
}>

/**
 * A census of the tree: regular files, and their total on-disk byte size.
 *
 * LOUD, never a silent undercount: an unreadable subtree would make this count
 * disagree with `tar`'s listing and let an incomplete archive pass the check
 * below. A tree that cannot be fully read is not archived — the reader names the
 * path instead. (`readdirSync`/`statSync` throw; we let them.)
 */
function census(root: string): Readonly<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  const walk = (dir: string): void => {
    const entries: readonly Dirent[] = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) {
        files += 1
        bytes += statSync(path).size
      }
    }
  }
  walk(root)
  return { files, bytes }
}

const sha256Of = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex")

/** The archive address rule: a dot sibling of the queue root, one archive per address and date. */
export function retiredArchivePath(root: string, at: Date): string {
  return join(dirname(root), ".retired", `${basename(root)}.${at.toISOString().slice(0, 10)}.tar.zst`)
}

export function tombstoneLine(archive: string, sha256: string, at: Date): string {
  return `retired ${at.toISOString()} (28601): archive=${archive} sha256=${sha256} cutover=${RETIRED_ROOT_CUTOVER}\n`
}

const recordedHash = (path: string): string | undefined =>
  /sha256=([0-9a-f]{64})/u.exec(readFileSync(path, "utf8"))?.[1]

/** Entries `tar -tf` lists for an archive, so an archive is checked against the census before it is trusted. */
async function archiveEntryCount(process: Process, archive: string): Promise<number> {
  const listing = await process.run({ argv: ["tar", "-tf", archive] })
  if (listing.exitCode !== 0) {
    throw new Error(
      `yrd-retire-archive-unreadable: ${archive}: tar -tf exited ${String(listing.exitCode)}: ${listing.stderr.trim()}`,
    )
  }
  return listing.stdout.split("\n").filter((line) => line.trim() !== "").length
}

export async function retireRetiredRoot(
  input: Readonly<{
    /** The host workdir the address lives under (queue-location `hostWorkdir`). */
    host: string
    address: QueueAddress
    at?: Date
    dryRun?: boolean
    /** The process runner for `tar`; tests inject one. */
    process?: Process
  }>,
): Promise<RetireRootResult> {
  const at = input.at ?? new Date()
  const dryRun = input.dryRun === true
  const liveRoot = queueRoot(input.host, input.address)
  const root = legacyQueueRoot(input.host, input.address)
  const archive = retiredArchivePath(root, at)
  const archiveDir = dirname(archive)
  const retiring = join(archiveDir, `${basename(root)}.retiring`)
  const tombstoneTemp = `${root}.tombstone-tmp`

  // The legacy root may be the ONLY copy of the queue. Refuse before touching
  // anything: archiving a root with no live sibling would then be the loss.
  if (!existsSync(liveRoot)) {
    throw refuse(
      RETIRE_ROOT_CODES.noLiveRoot,
      root,
      `the live ${liveRoot} does not exist, so the retired root may be the only copy`,
    )
  }

  const stat = lstatSync(root, { throwIfNoEntry: false })

  // Already retired: a matching tombstone at the root is the verb's own finished state.
  if (stat?.isFile() === true) {
    const recorded = recordedHash(root)
    if (recorded !== undefined && existsSync(archive) && recorded === sha256Of(archive)) {
      return {
        root,
        archive,
        tombstone: readFileSync(root, "utf8"),
        action: "skipped",
        files: 0,
        archiveBytes: statSync(archive).size,
        bytesFreed: 0,
        sha256: recorded,
        dryRun,
      }
    }
    throw refuse(
      RETIRE_ROOT_CODES.foreignFile,
      root,
      "the root is a file that is not this verb's matching tombstone, so overwriting it would destroy a record",
    )
  }
  // A symlink, a FIFO or any other node is not ours to move.
  if (stat !== undefined && !stat.isDirectory()) {
    throw refuse(
      RETIRE_ROOT_CODES.foreignFile,
      root,
      "the root is neither a directory nor a regular file, so retiring it would destroy an unknown node",
    )
  }

  // A crash after the root was moved aside but before the tombstone landed: finish that.
  const resuming = stat === undefined && existsSync(retiring) && existsSync(archive)
  if (stat === undefined && !resuming) {
    throw refuse(
      RETIRE_ROOT_CODES.absent,
      root,
      "there is no root and none of this verb's intermediate names, so a success here would be a false retirement record",
    )
  }

  const counted = stat === undefined ? { files: 0, bytes: 0 } : census(root)
  const process = input.process ?? createProcess()

  // An archive already here is kept only when it matches the tree we would archive;
  // a differing one would be OVERWRITTEN, which this verb never does.
  const archivePresent = existsSync(archive)
  if (archivePresent && !resuming) {
    // An archive we cannot even list, or one whose listing disagrees with the tree
    // we are about to archive, is a DIFFERENT record: writing over it destroys it.
    const matches = await archiveEntryCount(process, archive)
      .then((listed) => listed === counted.files)
      .catch(() => false)
    if (!matches) {
      throw refuse(
        RETIRE_ROOT_CODES.archiveDiffers,
        root,
        `an archive already exists at ${archive} whose listing differs from the census, so writing it would overwrite a record`,
      )
    }
  }

  const sha256 = archivePresent ? sha256Of(archive) : ""
  const tombstone = tombstoneLine(archive, sha256, at)
  const archiveBytes = archivePresent ? statSync(archive).size : 0
  if (dryRun) {
    return {
      root,
      archive,
      tombstone,
      action: resuming ? "resumed" : "archived",
      files: counted.files,
      archiveBytes,
      bytesFreed: counted.bytes - archiveBytes,
      sha256,
      dryRun: true,
    }
  }

  mkdirSync(archiveDir, { recursive: true })

  if (stat !== undefined) {
    if (!archivePresent) {
      // a. tar with zstd into a temporary file in .retired/, then fsync (tar's own close flushes).
      const archiveTemp = `${archive}.tmp`
      const tar = await process.run({
        argv: ["tar", "-C", dirname(root), "-c", "--zstd", "-f", archiveTemp, basename(root)],
      })
      if (tar.exitCode !== 0) {
        throw new Error(`yrd-retire-archive-failed: ${root}: tar exited ${String(tar.exitCode)}: ${tar.stderr.trim()}`)
      }
      try {
        // b. verify the listing against the census before the archive is trusted.
        const listed = await archiveEntryCount(process, archiveTemp)
        if (listed < counted.files) {
          throw new Error(
            `yrd-retire-archive-incomplete: ${root}: the archive lists ${String(listed)} entries but the census counted ${String(counted.files)} files`,
          )
        }
        // c. rename the archive into place.
        renameSync(archiveTemp, archive)
      } catch (cause) {
        await safeRemove(archiveTemp, { within: archiveDir, allowedRoots: [archiveDir] }).catch(() => undefined)
        throw cause
      }
    }
    // d. write the tombstone beside the root, with the archive's real hash.
    writeFileSync(tombstoneTemp, tombstoneLine(archive, sha256Of(archive), at))
  }

  // e. move the root aside, f. place the tombstone on the exact old path.
  if (existsSync(root) && stat !== undefined) renameSync(root, retiring)
  if (!existsSync(tombstoneTemp)) writeFileSync(tombstoneTemp, tombstoneLine(archive, sha256Of(archive), at))
  renameSync(tombstoneTemp, root)
  // g. remove the moved-aside tree through removely, never `rm`.
  if (existsSync(retiring)) await safeRemove(retiring, { within: archiveDir, allowedRoots: [archiveDir] })

  const finalBytes = statSync(archive).size
  return {
    root,
    archive,
    tombstone: readFileSync(root, "utf8"),
    action: resuming ? "resumed" : "archived",
    files: counted.files,
    archiveBytes: finalBytes,
    bytesFreed: counted.bytes - finalBytes,
    sha256: sha256Of(archive),
    dryRun: false,
  }
}
