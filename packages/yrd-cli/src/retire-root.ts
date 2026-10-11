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
 *
 * An archive is checked against the tree by ENTRY SET, never by a count: a
 * listing includes every directory and symlink, so "as many regular files" is a
 * different list — and the archive a crash left behind is re-verified against
 * the moved-aside tree before that tree is removed (@cto D1, D4). Every write is
 * fsynced before the path is freed (@cto D3), every refusal names the one-way
 * door it protects, and no cause is ever swallowed (@cto D6).
 */
import { createHash } from "node:crypto"
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
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
  /** Regular files in the archived tree — reported beside the entry-set census. */
  files: number
  /** The archive's measured size: bytes this run wrote, or would write. */
  archiveBytes: number
  /** Bytes this run frees: the tree minus the archive that replaces it, or the moved-aside tree on a resume. */
  bytesFreed: number
  sha256: string
  /** True when nothing was written (dry run). */
  dryRun: boolean
}>

const causeText = (value: unknown): string => (value instanceof Error ? value.message : String(value))

/**
 * One walk's census: the entries EXACTLY as `tar` names them (a SET, not a
 * count), plus the regular-file count and their total byte size.
 *
 * The SET is what every archive is checked against. A count of regular files
 * compared to `tar -tf`'s full listing is not a check at all: every directory
 * and symlink makes the listing longer, so equality could never hold for a tree
 * with directories and "shorter than the listing" is near-vacuous (@cto D1).
 * Names are relative to the root's PARENT and the root itself is included
 * (`<name>/`); directories carry a trailing slash and every other node (file,
 * symlink, socket, FIFO) is its bare path — exactly `tar -tf`'s form.
 *
 * LOUD, never a silent undercount: an unreadable subtree throws, so a tree that
 * cannot be fully read is never archived on a partial listing.
 */
function census(path: string, name: string): Readonly<{ entries: Set<string>; files: number; bytes: number }> {
  const entries = new Set<string>()
  let files = 0
  let bytes = 0
  const walk = (dir: string, prefix: string): void => {
    entries.add(`${prefix}/`)
    const children: readonly Dirent[] = readdirSync(dir, { withFileTypes: true })
    for (const entry of children) {
      const childPath = join(dir, entry.name)
      const childName = `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(childPath, childName)
      else {
        entries.add(childName)
        if (entry.isFile()) {
          files += 1
          bytes += statSync(childPath).size
        }
      }
    }
  }
  walk(path, name)
  return { entries, files, bytes }
}

/** A STREAMING sha256 — never the whole archive read into memory (@cto D7). */
function sha256Of(path: string): string {
  const hash = createHash("sha256")
  const fd = openSync(path, "r")
  try {
    const buffer = Buffer.allocUnsafe(1 << 20)
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null)
      if (read <= 0) break
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest("hex")
}

/** fsync a path (file OR directory) so a rename that follows cannot outlive the bytes it leaves behind (@cto D3). */
function fsyncPath(path: string): void {
  const fd = openSync(path, "r")
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** The archive address rule: a dot sibling of the queue root, one archive per address and date. */
export function retiredArchivePath(root: string, at: Date): string {
  return join(dirname(root), ".retired", `${basename(root)}.${at.toISOString().slice(0, 10)}.tar.zst`)
}

export function tombstoneLine(archive: string, sha256: string, at: Date): string {
  return `retired ${at.toISOString()} (28601): archive=${archive} sha256=${sha256} cutover=${RETIRED_ROOT_CUTOVER}\n`
}

const recordedHash = (path: string): string | undefined =>
  /sha256=([0-9a-f]{64})/u.exec(readFileSync(path, "utf8"))?.[1]

/**
 * `tar -tf`'s entry names as a SET. A failure is RETURNED, not thrown-and-dropped,
 * so the caller can carry WHICH case it was plus tar's exit and stderr into the
 * one refusal code (@cto D6).
 */
type ArchiveListing =
  | Readonly<{ ok: true; entries: Set<string> }>
  | Readonly<{ ok: false; exitCode: number; stderr: string }>

async function listArchive(process: Process, archive: string): Promise<ArchiveListing> {
  const listing = await process.run({ argv: ["tar", "-tf", archive] })
  if (listing.exitCode !== 0) {
    return { ok: false, exitCode: listing.exitCode, stderr: listing.stderr.trim() }
  }
  return { ok: true, entries: new Set(listing.stdout.split("\n").filter((line) => line.trim() !== "")) }
}

/** A short, readable sample of a name list — never the whole listing in a message. */
function describe(names: readonly string[], cap = 8): string {
  const shown = names.slice(0, cap)
  const more = names.length > shown.length ? `, +${String(names.length - shown.length)} more` : ""
  return `[${shown.join(", ")}${more}]`
}

/**
 * The ONE comparison every archive check uses: entry SETS, not counts (@cto D1).
 * A name present in the tree but absent from the archive (a socket `tar` skips,
 * an entry it omitted) and a name in the archive but not in the tree are both
 * refused BY NAME, so the operator reads which entries disagree.
 */
function assertArchiveMatches(
  expected: Set<string>,
  actual: Set<string>,
  root: string,
  archive: string,
  door: string,
): void {
  const missing = [...expected].filter((name) => !actual.has(name)).sort()
  const extra = [...actual].filter((name) => !expected.has(name)).sort()
  if (missing.length === 0 && extra.length === 0) return
  throw refuse(
    RETIRE_ROOT_CODES.archiveDiffers,
    root,
    `${door}; ${archive} lists ${describe([...actual].sort())} but the tree holds ${describe([...expected].sort())} (missing ${describe(missing)}, extra ${describe(extra)})`,
  )
}

/**
 * Measure the archive that WOULD be written, WITHOUT writing it (@cto D2):
 * stream `tar -c --zstd -f -` into a byte counter and a sha256, so the dry run
 * reports a real archive size and a real net instead of the whole tree as if it
 * were free.
 */
async function measureArchive(process: Process, tree: string): Promise<Readonly<{ bytes: number; sha256: string }>> {
  const hash = createHash("sha256")
  let bytes = 0
  const tar = await process.run({
    argv: ["tar", "-C", dirname(tree), "-c", "--zstd", "-f", "-", basename(tree)],
    onOutput: (output) => {
      if (output.stream !== "stdout") return
      bytes += output.chunk.byteLength
      hash.update(output.chunk)
    },
  })
  if (tar.exitCode !== 0) {
    throw new Error(`yrd-retire-archive-failed: ${tree}: tar exited ${String(tar.exitCode)}: ${tar.stderr.trim()}`)
  }
  return { bytes, sha256: hash.digest("hex") }
}

/**
 * g. Remove the moved-aside tree through `removely`, never `rm` — and only after
 * re-verifying it against the archive (@cto D4). A write that landed after the
 * archive is caught here, and the tree is KEPT and refused BY NAME rather than
 * removed; the resolve state's caller re-runs the verb.
 */
async function removeRetiring(
  process: Process,
  retiring: string,
  archive: string,
  root: string,
  base: string,
): Promise<Readonly<{ files: number; bytes: number }>> {
  const moved = census(retiring, base)
  const listing = await listArchive(process, archive)
  if (!listing.ok) {
    throw refuse(
      RETIRE_ROOT_CODES.archiveDiffers,
      root,
      `the archive ${archive} cannot be listed (tar -tf exited ${String(listing.exitCode)}: ${listing.stderr}), so the moved-aside tree ${retiring} cannot be proven redundant and is KEPT`,
    )
  }
  assertArchiveMatches(
    moved.entries,
    listing.entries,
    root,
    archive,
    `the moved-aside tree ${retiring} no longer matches the archive (a write landed after it), so it is KEPT`,
  )
  await safeRemove(retiring, { within: dirname(archive), allowedRoots: [dirname(archive)] })
  return { files: moved.files, bytes: moved.bytes }
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
  const base = basename(root)
  const archive = retiredArchivePath(root, at)
  const archiveDir = dirname(archive)
  const retiring = join(archiveDir, `${base}.retiring`)
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
  const archivePresent = existsSync(archive)
  const retiringPresent = existsSync(retiring)

  // Already retired: our tombstone is a regular file whose recorded hash matches
  // the archive. A crash between f and g leaves `.retiring` behind with the
  // tombstone in place, so finish that instead of calling it done (@cto D5).
  if (stat?.isFile() === true) {
    const recorded = recordedHash(root)
    if (recorded === undefined || !archivePresent || recorded !== sha256Of(archive)) {
      throw refuse(
        RETIRE_ROOT_CODES.foreignFile,
        root,
        "the root is a file that is not this verb's matching tombstone, so overwriting it would destroy a record",
      )
    }
    const archiveBytes = statSync(archive).size
    if (!retiringPresent) {
      return {
        root,
        archive,
        tombstone: readFileSync(root, "utf8"),
        action: "skipped",
        files: 0,
        archiveBytes,
        bytesFreed: 0,
        sha256: recorded,
        dryRun,
      }
    }
    const process = input.process ?? createProcess()
    if (dryRun) {
      const moved = census(retiring, base)
      return {
        root,
        archive,
        tombstone: readFileSync(root, "utf8"),
        action: "resumed",
        files: moved.files,
        archiveBytes,
        bytesFreed: moved.bytes,
        sha256: recorded,
        dryRun: true,
      }
    }
    const moved = await removeRetiring(process, retiring, archive, root, base)
    return {
      root,
      archive,
      tombstone: readFileSync(root, "utf8"),
      action: "resumed",
      files: moved.files,
      archiveBytes,
      bytesFreed: moved.bytes,
      sha256: recorded,
      dryRun: false,
    }
  }
  // A symlink, a FIFO or any other node is not ours to move.
  if (stat !== undefined && !stat.isDirectory()) {
    throw refuse(
      RETIRE_ROOT_CODES.foreignFile,
      root,
      "the root is neither a directory nor a regular file, so retiring it would destroy an unknown node",
    )
  }

  // A crash after the root was moved aside but before the tombstone landed: the
  // root is absent and `.retiring` plus the archive are the verb's own names.
  const resuming = stat === undefined
  if (resuming && !(retiringPresent && archivePresent)) {
    throw refuse(
      RETIRE_ROOT_CODES.absent,
      root,
      "there is no root and none of this verb's intermediate names, so a success here would be a false retirement record",
    )
  }

  const tree = resuming ? retiring : root
  const counted = census(tree, base)
  const process = input.process ?? createProcess()

  // An archive already here is kept only when it matches the tree it would
  // replace; a different record would be OVERWRITTEN, which this verb never does.
  // ONE code covers "cannot list" and "differs"; the message carries WHICH (@cto D6).
  let sha256 = ""
  let archiveBytes = 0
  if (archivePresent && !resuming) {
    const listing = await listArchive(process, archive)
    if (!listing.ok) {
      throw refuse(
        RETIRE_ROOT_CODES.archiveDiffers,
        root,
        `an archive already exists at ${archive} and cannot be listed (tar -tf exited ${String(listing.exitCode)}: ${listing.stderr}), so writing it would overwrite a record`,
      )
    }
    assertArchiveMatches(
      counted.entries,
      listing.entries,
      root,
      archive,
      `an archive already exists at ${archive} whose listing differs from the tree`,
    )
  }

  if (dryRun) {
    if (archivePresent) {
      sha256 = sha256Of(archive)
      archiveBytes = statSync(archive).size
    } else {
      const measured = await measureArchive(process, tree)
      sha256 = measured.sha256
      archiveBytes = measured.bytes
    }
    return {
      root,
      archive,
      tombstone: tombstoneLine(archive, sha256, at),
      action: archivePresent ? "resumed" : "archived",
      files: counted.files,
      archiveBytes,
      bytesFreed: resuming ? counted.bytes : counted.bytes - archiveBytes,
      sha256,
      dryRun: true,
    }
  }

  mkdirSync(archiveDir, { recursive: true })

  if (!archivePresent) {
    // a. tar with zstd into a temporary file in `.retired/`.
    const archiveTemp = `${archive}.tmp`
    const tar = await process.run({
      argv: ["tar", "-C", dirname(tree), "-c", "--zstd", "-f", archiveTemp, base],
    })
    if (tar.exitCode !== 0) {
      throw new Error(`yrd-retire-archive-failed: ${root}: tar exited ${String(tar.exitCode)}: ${tar.stderr.trim()}`)
    }
    try {
      // b. verify the listing's entry SET equals the census before the archive is trusted.
      const listing = await listArchive(process, archiveTemp)
      if (!listing.ok) {
        throw new Error(
          `yrd-retire-archive-unreadable: ${archiveTemp}: tar -tf exited ${String(listing.exitCode)}: ${listing.stderr}`,
        )
      }
      assertArchiveMatches(
        counted.entries,
        listing.entries,
        root,
        archiveTemp,
        "the archive does not hold exactly the tree that was archived",
      )
      // c. rename the archive into place.
      renameSync(archiveTemp, archive)
    } catch (cause) {
      // NEVER swallow a cause: a failed cleanup is APPENDED to the error thrown (@cto D6).
      const cleanup = await safeRemove(archiveTemp, { within: archiveDir, allowedRoots: [archiveDir] }).then(
        () => undefined,
        (error: unknown) => error,
      )
      if (cleanup !== undefined) {
        if (cause instanceof Error) {
          cause.message = `${cause.message} (also: the temporary archive ${archiveTemp} could not be removed: ${causeText(cleanup)})`
        } else {
          throw new Error(
            `${causeText(cause)} (also: the temporary archive ${archiveTemp} could not be removed: ${causeText(cleanup)})`,
          )
        }
      }
      throw cause
    }
    // D3: fsync the archive and its directory BEFORE the path is freed — tar's
    // close does not fsync, and step g removes the only other copy.
    fsyncPath(archive)
    fsyncPath(archiveDir)
  }

  // The archive is now in place: newly written above, or a matching record a
  // prior run (or the after-c crash state) left behind. Read its real hash/size.
  sha256 = sha256Of(archive)
  archiveBytes = statSync(archive).size

  if (resuming) {
    // The root is already aside; place the tombstone on the exact old path, then
    // re-verify the moved-aside tree and remove it.
    writeFileSync(tombstoneTemp, tombstoneLine(archive, sha256, at))
    renameSync(tombstoneTemp, root)
    const moved = await removeRetiring(process, retiring, archive, root, base)
    return {
      root,
      archive,
      tombstone: readFileSync(root, "utf8"),
      action: "resumed",
      files: moved.files,
      archiveBytes,
      bytesFreed: moved.bytes,
      sha256,
      dryRun: false,
    }
  }

  // d. write the tombstone beside the root, with the archive's real hash.
  writeFileSync(tombstoneTemp, tombstoneLine(archive, sha256, at))
  // e. move the root aside (same filesystem, atomic), f. place the tombstone on the exact old path.
  renameSync(root, retiring)
  renameSync(tombstoneTemp, root)
  // g. remove the moved-aside tree through removely, never `rm`, and only after re-verifying it (@cto D4).
  await removeRetiring(process, retiring, archive, root, base)

  return {
    root,
    archive,
    tombstone: readFileSync(root, "utf8"),
    action: archivePresent ? "resumed" : "archived",
    files: counted.files,
    archiveBytes,
    bytesFreed: counted.bytes - archiveBytes,
    sha256,
    dryRun: false,
  }
}
