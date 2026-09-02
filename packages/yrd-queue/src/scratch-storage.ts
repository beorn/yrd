import { constants } from "node:fs"
import { access, lstat, mkdir, readdir, readFile, rm, statfs, writeFile } from "node:fs/promises"
import { dirname, join, resolve, sep } from "node:path"
import { createFailure, systemClock } from "@yrd/core"
import type { JobError } from "@yrd/job"
import { recordedPidIsRunning, recordedPidLiveness } from "@yrd/process"
import type { Git } from "git-super/worktree"

/**
 * Queue scratch — merge worktrees, source rebases, patch-id diffs, union
 * proofs — belongs on the repository's own filesystem, never on the system
 * temp dir.
 *
 * A merge worktree materializes the entire tree, which is tens of thousands of
 * inodes per run. When that merged on a tmpfs `/tmp`, an unrelated session's
 * test scratch could exhaust the tmpfs INODE table (bytes still half free) and
 * every merge on every queue failed with `No space left on device` — a total
 * merge outage for ~65 minutes on 2026-08-14 (R2224-R2235), which cleared by
 * itself the moment the unrelated holder released its inodes.
 *
 * `.git/yrd/` already hosts the queue's artifacts, deployments and pre-submit
 * worktrees, so the queue's own state directory is the conventional home; it
 * shares the repository's disk, which is orders of magnitude larger than a
 * tmpfs and is not shared with unrelated scratch.
 *
 * Derived from `--git-common-dir` rather than `join(repo, ".git")` because the
 * callers include submodule worktrees and linked worktrees,
 * where `.git` is a FILE and the naive join is not a directory at all.
 *
 * The git handle is PROJECTED from the one `Git` view rather than redeclared:
 * a narrowing cannot drift from what it narrows, and a locally-declared
 * `run(repo, args) -> { stdout }` shape is where the next rival transport is
 * born.
 */
export async function queueScratchParent(git: Pick<Git, "run">, repo: string): Promise<string> {
  const key = resolve(repo)
  const memoized = commonDirs.get(key)
  if (memoized !== undefined) return join(memoized, "yrd", "scratch")
  const common = (await git.run(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim()
  if (common === "") throw new Error(`yrd: git returned an empty common directory for '${repo}'`)
  const root = resolve(repo, common)
  commonDirs.set(key, root)
  return join(root, "yrd", "scratch")
}

/**
 * A repository's common directory does not move under a running process, and
 * every scratch preparation asked git for it again — a fork per merge worktree,
 * per source rebase, per union proof. The CLI already memoizes the same lookup
 * (`queueGitDir` in `yrd-cli/src/run.ts`), for the sharper reason that forking
 * on the watch UI's render path stalls it; that memo cannot be shared across
 * the package boundary, so the queue keeps its own. Only a proven answer is
 * cached: a failed lookup leaves the memo empty and is raised to the caller.
 */
const commonDirs = new Map<string, string>()

/**
 * The two errno with which a filesystem answers "no room", as the kernel names
 * them (`code`) and as libc's `strerror` prints them (the phrases): ENOSPC,
 * the device itself is full — bytes or inodes — and EDQUOT, the device has
 * room but THIS user's quota does not. EDQUOT is the shape a quota'd tmpfs
 * gives while `df` still shows the device half empty (PR3159, 2026-09-01:
 * `fatal: unable to write loose object file: Disk quota exceeded`, then Node's
 * own `EDQUOT: unknown error, write`), and an ENOSPC-only classifier let it
 * retire the submission as the author's `affected-tests-failed`.
 */
const STORAGE_EXHAUSTION_CODES: ReadonlySet<unknown> = new Set(["ENOSPC", "EDQUOT"])
const STORAGE_EXHAUSTION_PHRASE = "no space left on device|disk quota exceeded"
const STORAGE_EXHAUSTION_ERRNO = String.raw`\bE(?:NOSPC|DQUOT)\b`
/** Any mention at all — the bar a THROWN cause is judged by. */
const STORAGE_EXHAUSTION_MENTION = new RegExp(`${STORAGE_EXHAUSTION_PHRASE}|${STORAGE_EXHAUSTION_ERRNO}`, "iu")
/**
 * A line in which a tool STATED the errno: strerror's phrase, or the code in
 * the position Node and Bun print it (`EDQUOT: unknown error, write`,
 * `code: 'EDQUOT',`) — never the bare word. Free text is held to this
 * stricter bar because a check's output quotes things that are not its own
 * failures: a vitest `FAIL` row naming a test called "…ENOSPC error by its
 * code" is the author's red, and reading it as the filesystem's would
 * re-admit that red forever. A test NAME must therefore never quote the
 * strerror phrase itself.
 */
const STORAGE_EXHAUSTION_STATEMENT = new RegExp(
  `${STORAGE_EXHAUSTION_PHRASE}|${STORAGE_EXHAUSTION_ERRNO}['"]?\\s*[:,]`,
  "iu",
)

/**
 * Storage exhaustion reaches us three ways: as a Node filesystem error carrying
 * `code`, as the queue git helper's thrown `Error` whose message is git's own
 * stderr, and — the command runner throws one when the process and its
 * artifact stream both fail — as an `AggregateError` whose members carry it.
 * All must classify, because the outages surfaced through `worktree add`
 * stderr, submodule checkout stderr and a check child's writes alike.
 */
export function isStorageExhaustion(cause: unknown): boolean {
  if (cause === null || cause === undefined) return false
  if (typeof cause === "object") {
    if (STORAGE_EXHAUSTION_CODES.has((cause as Readonly<{ code?: unknown }>).code)) return true
    const nested = (cause as Readonly<{ cause?: unknown }>).cause
    if (nested !== undefined && nested !== cause && isStorageExhaustion(nested)) return true
    if (cause instanceof AggregateError && cause.errors.some((member) => isStorageExhaustion(member))) return true
  }
  const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : ""
  return STORAGE_EXHAUSTION_MENTION.test(message)
}

export type StorageExhaustionStatement = Readonly<{
  /** The line, trimmed, exactly as the tool printed it. */
  line: string
  /** `quota`: the user's quota is spent (EDQUOT); `space`: the device is (ENOSPC). */
  kind: "quota" | "space"
}>

/**
 * The first line of `output` in which a tool stated that the filesystem ran
 * out, or `undefined` when none did in a shape this recognizes. First in the
 * text: the earliest statement started the failure and the later ones are its
 * consequences. Reads the capture it is handed, so a statement that fell in
 * the dropped middle of a head-and-tail truncated capture is not seen here.
 */
export function storageExhaustionStatement(output: string): StorageExhaustionStatement | undefined {
  for (const raw of output.split("\n")) {
    const line = raw.trim()
    if (line === "" || !STORAGE_EXHAUSTION_STATEMENT.test(line)) continue
    return { line, kind: /quota|EDQUOT/iu.test(line) ? "quota" : "space" }
  }
  return undefined
}

/**
 * The first ABSOLUTE path the output named as the write that failed, or
 * `undefined` when it named none — never a guess, and never a relative path,
 * which cannot be read for its filesystem. Two shapes, both from PR3159:
 * git's `cannot copy '<src>' to '<dst>'` (the dst is the failed write; that
 * line carries no errno itself, the `copy-fd` line before it does), and a
 * quoted or bare absolute path on a statement line (`cannot create directory
 * at '/tmp/x': No space left on device`, `write /tmp/x: disk quota exceeded`).
 * `fatal: unable to write loose object file: Disk quota exceeded` names
 * nothing, so it yields nothing.
 */
export function storageExhaustionPath(output: string): string | undefined {
  for (const raw of output.split("\n")) {
    const line = raw.trim()
    const copied = /cannot copy '[^']*' to '(\/[^']+)'/u.exec(line)
    if (copied?.[1] !== undefined) return copied[1]
    if (!STORAGE_EXHAUSTION_STATEMENT.test(line)) continue
    const named = /'(\/[^']+)'|(?:^|[\s:])(\/[^\s'":]+)/u.exec(line)
    const path = named?.[1] ?? named?.[2]
    if (path !== undefined) return path
  }
  return undefined
}

export type StorageState = Readonly<{
  path: string
  inodes: Readonly<{ total: number; free: number; used: number; usedPercent: number }>
  bytes: Readonly<{ total: number; free: number; used: number; usedPercent: number }>
}>

const percent = (used: number, total: number): number => (total <= 0 ? 0 : Math.round((used / total) * 1000) / 10)

function formatBytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"]
  let scaled = value
  let unit = 0
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024
    unit += 1
  }
  return `${unit === 0 ? scaled : scaled.toFixed(1)} ${units[unit]}`
}

/**
 * Read the filesystem backing `path`. The scratch directory is often already
 * gone (or was never created) by the time a failure is classified, so walk up
 * to the nearest ancestor that still resolves rather than losing the numbers.
 */
export async function readStorageState(path: string): Promise<StorageState | undefined> {
  let probe = resolve(path)
  for (;;) {
    try {
      const stats = await statfs(probe)
      const inodesTotal = Number(stats.files)
      const inodesFree = Number(stats.ffree)
      const blockSize = Number(stats.bsize)
      const bytesTotal = Number(stats.blocks) * blockSize
      const bytesFree = Number(stats.bavail) * blockSize
      return {
        path: probe,
        inodes: {
          total: inodesTotal,
          free: inodesFree,
          used: inodesTotal - inodesFree,
          usedPercent: percent(inodesTotal - inodesFree, inodesTotal),
        },
        bytes: {
          total: bytesTotal,
          free: bytesFree,
          used: bytesTotal - bytesFree,
          usedPercent: percent(bytesTotal - bytesFree, bytesTotal),
        },
      }
    } catch (error) {
      const code =
        error !== null && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error
      const parent = dirname(probe)
      if (parent === probe) return undefined
      probe = parent
    }
  }
}

export function describeStorageState(state: StorageState): string {
  return (
    `filesystem backing '${state.path}' is exhausted: ` +
    `inodes ${state.inodes.used}/${state.inodes.total} used (${state.inodes.usedPercent}%), ${state.inodes.free} free; ` +
    `bytes ${formatBytes(state.bytes.used)}/${formatBytes(state.bytes.total)} used ` +
    `(${state.bytes.usedPercent}%), ${formatBytes(state.bytes.free)} free`
  )
}

/** The typed code for storage exhaustion during scratch/worktree preparation. */
export const WORKTREE_STORAGE_EXHAUSTED = "worktree-storage-exhausted"

/**
 * The typed code for storage exhaustion a check's own output stated, or that
 * the command runner hit writing its own artifacts — the check-time twin of
 * {@link WORKTREE_STORAGE_EXHAUSTED}. Registered in `YRD_REFUSAL_CODES` and
 * bucketed `infra-retry` (queue.ts): the queue re-admits the submission on
 * its next pass and never retires its submit fact (PR3159, 2026-09-01).
 */
export const CHECK_STORAGE_EXHAUSTED = "check-storage-exhausted"

/**
 * The typed code for a repository-declared scratch root (`.yrd.yml`
 * `scratch:`) that could not be created or is not writable when a step child
 * was about to be spawned with it as TMPDIR (@i/10-yrd/24031). Registered in
 * `YRD_REFUSAL_CODES` and bucketed `infra-retry` (queue.ts): the root is a
 * host fact — a path the repository owner chose and the runner's user cannot
 * write — never a verdict on the submitted content.
 */
export const SCRATCH_ROOT_UNAVAILABLE = "scratch-root-unavailable"

/**
 * Bring the declared scratch root into being before a step child is spawned
 * with it as TMPDIR, and refuse loudly — before any child exists — when it
 * cannot be. `mkdir -p`, then a writability probe: a regular file where a
 * directory must be, a read-only mount, a directory the runner's user cannot
 * write, all refuse here with the path and the kernel's own reason, instead of
 * surfacing later as a child's confusing ENOENT/EACCES under TMPDIR — or not
 * at all, as a tool that quietly fell back to `/tmp`. An ENOSPC/EDQUOT on the
 * mkdir itself names the ROOT's filesystem, as every other storage-exhaustion
 * failure here names the one it read.
 */
export async function ensureScratchRoot(purpose: string, root: string): Promise<void> {
  const refuse = async (problem: string, cause: unknown): Promise<never> => {
    const reason = cause instanceof Error ? cause.message : String(cause)
    const exhausted = isStorageExhaustion(cause) ? `; ${(await storageExhaustionReport(root)).detail}` : ""
    throw createFailure(
      {
        kind: "infrastructure",
        code: SCRATCH_ROOT_UNAVAILABLE,
        message:
          `yrd: ${purpose}: the repository's declared scratch root '${root}' (.yrd.yml scratch:) ${problem}: ` +
          `${reason}${exhausted}. Every step child gets it as TMPDIR, so no child was spawned. Cure: make it a ` +
          "directory the runner's user can write, or point scratch: at one (a root-filesystem path, never a " +
          "quota'd tmpfs), then re-run the queue pass",
      },
      cause,
    )
  }
  try {
    await mkdir(root, { recursive: true })
  } catch (cause) {
    await refuse("cannot be created", cause)
  }
  try {
    await access(root, constants.W_OK | constants.X_OK)
  } catch (cause) {
    await refuse("is not writable", cause)
  }
}

/** The machine-readable half of a storage-exhaustion failure: the filesystem's inode/byte split. */
export type StorageExhaustionEvidence = Readonly<{
  kind: "storage-exhaustion"
  path: string
  inodesTotal: number
  inodesFree: number
  inodesUsedPercent: number
  bytesTotal: number
  bytesFree: number
  bytesUsedPercent: number
}>

/**
 * The filesystem's own account of `path` — the sentence a failure message
 * carries and the evidence beside it — or the sentence alone when no ancestor
 * of `path` resolves. ONE reading for every storage-exhaustion failure, the
 * scratch-preparation one and the check-output one alike, so the two cannot
 * describe the same filesystem differently. Naming the inode/byte split is
 * the whole point: the 2026-08-14 outage looked like bytes were fine (51%
 * used) while inodes sat at 100%, so a byte-only report would have sent the
 * reader looking in the wrong place. It reads the DEVICE: a spent per-user
 * quota (EDQUOT) leaves these totals looking healthy, which is the caller's
 * to say.
 */
export async function storageExhaustionReport(
  path: string,
): Promise<Readonly<{ detail: string; evidence?: StorageExhaustionEvidence }>> {
  const state = await readStorageState(path)
  if (state === undefined) return { detail: `filesystem backing '${path}' is exhausted` }
  return {
    detail: describeStorageState(state),
    evidence: {
      kind: "storage-exhaustion",
      path: state.path,
      inodesTotal: state.inodes.total,
      inodesFree: state.inodes.free,
      inodesUsedPercent: state.inodes.usedPercent,
      bytesTotal: state.bytes.total,
      bytesFree: state.bytes.free,
      bytesUsedPercent: state.bytes.usedPercent,
    },
  }
}

/**
 * Build the typed failure for an ENOSPC that struck while preparing scratch.
 *
 * This must never be reported as a content merge conflict: nothing about the
 * candidate is wrong, no author can act on it, and the very same candidate
 * merges first try once the filesystem has room.
 */
export async function storageExhaustionError(path: string, cause: unknown): Promise<JobError> {
  const report = await storageExhaustionReport(path)
  const original = cause instanceof Error ? cause.message : String(cause)
  return {
    code: WORKTREE_STORAGE_EXHAUSTED,
    message: `yrd: scratch preparation ran out of space — ${report.detail}. Underlying error: ${original}`,
    ...(report.evidence === undefined ? {} : { evidence: report.evidence }),
  }
}

const STORAGE_EXHAUSTION_TAG = Symbol.for("yrd.queue.scratch-storage-exhaustion")

/**
 * Carry the typed failure on the thrown error itself, so classification happens
 * once — at the scratch primitive, while the directory still exists and its
 * inode/byte split is still true — and every catch downstream reads the answer
 * instead of re-deriving it. Re-deriving later is not equivalent:
 * `readStorageState` walks up to the nearest surviving ancestor, so a catch that
 * classifies after cleanup can report a different filesystem than the one that
 * ran out.
 */
export function tagStorageExhaustion<E extends Error>(error: E, failure: JobError): E {
  return Object.assign(error, { [STORAGE_EXHAUSTION_TAG]: failure })
}

/** The typed failure a scratch primitive already prepared for this cause, if any. */
export function taggedStorageExhaustion(cause: unknown): JobError | undefined {
  if (cause === null || typeof cause !== "object") return undefined
  const tagged = (cause as Readonly<Record<symbol, unknown>>)[STORAGE_EXHAUSTION_TAG]
  if (tagged !== undefined) return tagged as JobError
  const nested = (cause as Readonly<{ cause?: unknown }>).cause
  return nested === undefined || nested === cause ? undefined : taggedStorageExhaustion(nested)
}

/**
 * How long an entry under the scratch root may sit before it is treated as
 * abandoned. Queue jobs are bounded well below this by their own timeouts, so a
 * full day of no writes cannot describe live work.
 */
export const ORPHANED_SCRATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Every queue scratch directory is `mkdtemp`-ed with a `yrd-` prefix
 * (`yrd-queue-`, `yrd-source-`, `yrd-union-proof-`, `yrd-component-main-`). It is
 * the only thing that identifies an entry as the queue's own to delete.
 */
export const SCRATCH_NAME_PREFIX = "yrd-"

export type ScratchReapReport = Readonly<{
  root: string
  /** The denominator: every entry directly under the scratch root. */
  entries: number
  reaped: number
  /** Entries left alone because they are younger than the threshold or still live. */
  kept: number
  /**
   * Why each kept entry was kept, because the totals answer opposite questions.
   * A sweep that keeps everything as live is a reaper that has gone inert —
   * which is exactly what 27 GB of abandoned pre-submit checkouts looked like
   * from the outside — while one that keeps everything as young is a sweep
   * running too often. Folded into a single `kept`, the two are the same number.
   */
  keptLive: number
  keptYoung: number
  /** Entries under a shared parent that were never ours to delete. */
  keptForeign: number
  bytes: number
  /** Removals that failed, kept loud rather than folded into `kept`. */
  failures: readonly string[]
}>

/**
 * The newest write anywhere under `path`, including `path` itself.
 *
 * A directory's own mtime says when its immediate children last changed, which
 * for a run's artifact directory is when it was created and never again — the
 * step logs are appended to two levels down. That is the reading that would
 * delete work still in progress, so the age of a tree is the newest write in
 * it, not the age of its root.
 */
async function newestMtimeMs(path: string): Promise<number> {
  let newest = (await lstat(path)).mtimeMs
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = join(current, entry.name)
      const stats = await lstat(child)
      if (stats.mtimeMs > newest) newest = stats.mtimeMs
      if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(child)
    }
  }
  await walk(path)
  return newest
}

async function directorySize(path: string): Promise<number> {
  let total = 0
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const child = join(current, entry.name)
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(child)
        continue
      }
      total += (await lstat(child)).size
    }
  }
  await walk(path)
  return total
}

/**
 * The entries under `root` git still lists as live worktrees, keyed by the
 * scratch entry itself rather than the worktree path one level down.
 *
 * Every caller of `reapOrphanedScratch` that mkdtemps a `<root>/<name>/worktree`
 * shape needs this same read to build `keep`: a queue merge scratch entry
 * (`yrd-queue-*`) and a CLI pre-submit checkout (`check-*`) both put the actual
 * `git worktree add` one level below the entry `reapOrphanedScratch` decides
 * on, so `git worktree list`'s path has to be walked back up one segment
 * before it names the same thing the reaper is comparing against. Extracted
 * from the queue's own private copy (`command.ts`'s `liveScratchEntries`, the
 * `withScratchRoot`/`scratchIn` caller) so a second caller with the identical
 * shape — the CLI's `pre-submit-worktrees` — does not have to re-derive or
 * fork this logic; the queue's own copy is untouched; nothing here changes its
 * behavior.
 *
 * `listed` is the whole point of the return shape. A bare set cannot tell
 * "git answered, and nothing here is live" from "git could not answer", and
 * those two demand OPPOSITE actions from a caller that is about to DELETE:
 * the first says every entry is fair game, the second says the keep set is
 * unknown and nothing may be reaped on it. Collapsing them into an empty set
 * is a silent error with teeth — one transient `git worktree list` failure
 * and the reaper deletes a live worktree it merely failed to see. Callers
 * must branch on `listed` and skip the sweep, loudly, when it is false.
 */
export async function liveWorktreeEntries(
  git: Pick<Git, "run">,
  repo: string,
  root: string,
): Promise<Readonly<{ listed: boolean; live: ReadonlySet<string> }>> {
  const listed = await git.run(repo, ["worktree", "list", "--porcelain"], true)
  if (listed.code !== 0) return { listed: false, live: new Set() }
  const live = new Set<string>()
  const rootPrefix = `${resolve(root)}${sep}`
  for (const line of listed.stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue
    const path = resolve(line.slice("worktree ".length).trim())
    if (!path.startsWith(rootPrefix)) continue
    const segment = path.slice(rootPrefix.length).split(sep)[0]
    if (segment !== undefined && segment !== "") live.add(join(resolve(root), segment))
  }
  return { listed: true, live }
}

/**
 * The file a pre-submit checkout writes into its own scratch entry, naming the
 * process that owns it and whether the entry was deliberately retained.
 *
 * It exists because the fact it records has no other honest source. Liveness
 * was previously inferred from `git worktree list`: an entry git still listed
 * was treated as live. Measured on the live queue state dir 2026-09-01, all 94
 * abandoned entries under `pre-submit-worktrees` were still registered — the
 * `.git` file named an admin directory that existed, and that directory's
 * `gitdir` named the entry back — because the process that died between
 * `worktree add` and its `finally` left the registration behind exactly the way
 * it left the directory behind. Registration and abandonment are the same
 * on-disk state, so no reading of the worktree list can separate them, and the
 * reaper freed nothing while 27 GB accumulated over 13 days.
 *
 * A recorded owner separates them, because it records the two facts the reaper
 * actually needs and the filesystem cannot infer: which process is using this
 * entry, and whether a human asked for it to be kept.
 */
export const SCRATCH_OWNER_FILE = "owner.json"

export type ScratchOwner = Readonly<{
  /** The process that created the entry and is using it. */
  pid: number
  /** When the record was written — the moment the recorded owner precedes. */
  startedAtMs: number
  /**
   * Set when the entry's creator ran under `--keep-on-failure`, so an entry
   * that survives its run survived deliberately. Written at creation rather
   * than at each failure site: every ordinary path removes the whole entry, so
   * a flag set upfront can only be read on an entry that was kept on purpose.
   */
  retained?: boolean
}>

/** Record the owner of a freshly created scratch entry. */
export async function writeScratchOwner(entry: string, owner: ScratchOwner): Promise<void> {
  await writeFile(join(entry, SCRATCH_OWNER_FILE), `${JSON.stringify(owner)}\n`, "utf8")
}

/**
 * The owner an entry recorded, or `undefined` when it recorded none.
 *
 * A malformed record reads as absent rather than raising: the sweep must not be
 * held hostage by one unparseable file, and absence is already the conservative
 * arm for everything except age.
 */
export async function readScratchOwner(entry: string): Promise<ScratchOwner | undefined> {
  let text: string
  try {
    text = await readFile(join(entry, SCRATCH_OWNER_FILE), "utf8")
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(text) as Partial<ScratchOwner>
    if (typeof parsed.pid !== "number" || typeof parsed.startedAtMs !== "number") return undefined
    return Object.freeze({
      pid: parsed.pid,
      startedAtMs: parsed.startedAtMs,
      ...(parsed.retained === true ? { retained: true } : {}),
    })
  } catch {
    return undefined
  }
}

export type ScratchOwnerCensus = Readonly<{
  /** Entries no sweep may remove, whatever their age. */
  live: ReadonlySet<string>
  /** Kept because `--keep-on-failure` asked for them. */
  retained: number
  /** Kept because the process that recorded them is still running. */
  running: number
  /** Released: the recorded owner has provably exited. */
  exited: number
  /** Released: nothing recorded an owner (an entry from before this record, or one abandoned mid-creation). */
  unowned: number
}>

/**
 * Which entries under `root` are still owned, derived per entry from what each
 * one recorded.
 *
 * No global listing, and no git call at all — which is the second half of the
 * fix. The keep set was previously built from one `git worktree list` over a
 * repository with 448 registered worktrees, and when that read failed or timed
 * out the whole sweep was skipped: the keep set was unknown, reaping against an
 * unknown keep set is unsafe, and skipping was the only safe move left. A
 * per-entry record has no such failure mode, so there is no longer a state in
 * which the sweep declines to run.
 *
 * Conservative in the one direction that matters: `unknown` liveness counts as
 * running (`recordedPidIsRunning`), so an unprovable identity keeps the entry.
 * Only proof — no such process, or a start time that refutes the record —
 * releases one.
 */
export async function liveScratchOwners(
  root: string,
  options: Readonly<{ procRoot?: string }> = {},
): Promise<ScratchOwnerCensus> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch (cause) {
    if ((cause as Readonly<{ code?: unknown }>).code === "ENOENT") {
      return { live: new Set(), retained: 0, running: 0, exited: 0, unowned: 0 }
    }
    throw cause
  }
  const live = new Set<string>()
  let retained = 0
  let running = 0
  let exited = 0
  let unowned = 0
  for (const name of names) {
    const entry = join(root, name)
    const owner = await readScratchOwner(entry)
    if (owner === undefined) {
      unowned += 1
      continue
    }
    if (owner.retained === true) {
      retained += 1
      live.add(entry)
      continue
    }
    const liveness = await recordedPidLiveness(
      { pid: owner.pid, runningSinceMs: owner.startedAtMs },
      options.procRoot === undefined ? {} : { procRoot: options.procRoot },
    )
    if (recordedPidIsRunning(liveness)) {
      running += 1
      live.add(entry)
      continue
    }
    exited += 1
  }
  return { live, retained, running, exited, unowned }
}

/**
 * Remove scratch left behind by a queue process that died between creating a
 * worktree and its `finally`. `withScratchRoot` cleans up on every ordinary
 * path, including failures, but a SIGKILL or a host crash has no `finally` — and
 * this scratch lives on the repository's own disk (`<git-common-dir>/yrd/scratch`,
 * chosen over a tmpfs after the 2026-08-14 inode outage), so nothing clears it at
 * reboot either. Each abandoned merge worktree is a materialized tree: tens of
 * thousands of inodes, on the very filesystem whose exhaustion this module
 * exists to report.
 *
 * Bounded and conservative: one non-recursive listing of the root, and an entry
 * is removed only when all three hold — its name carries `namePrefix`, it is
 * older than `olderThanMs`, and it is absent from `keep`, the paths git still
 * lists as live worktrees, which is the read that separates an abandoned
 * worktree from a slow one. The name check is not decoration: the scratch parent
 * is the queue's own state dir by default but a host may point it at a bays
 * root it shares with other work, and only the `mkdtemp` prefix says an entry is
 * ours to delete. A missing root is a legitimate absence (nothing has prepared
 * scratch yet) and reports zero entries; anything else about the root is raised.
 */
export async function reapOrphanedScratch(
  root: string,
  options: Readonly<{
    olderThanMs?: number
    now?: number
    keep?: ReadonlySet<string>
    namePrefix?: string
    /**
     * Which mtime decides an entry's age. `"entry"` (the default) reads the
     * entry directory's own mtime, which is right for a scratch checkout: it is
     * created, used and removed as a unit. `"tree"` reads the newest write
     * anywhere inside it, which is what an artifact directory needs — its root
     * is stamped once at creation while its logs keep being appended to, so the
     * entry reading would condemn the longest-running work first.
     */
    ageFrom?: "entry" | "tree"
  }> = {},
): Promise<ScratchReapReport> {
  const olderThanMs = options.olderThanMs ?? ORPHANED_SCRATCH_MAX_AGE_MS
  const now = options.now ?? systemClock.now()
  const keep = options.keep ?? new Set<string>()
  const namePrefix = options.namePrefix ?? SCRATCH_NAME_PREFIX
  const ageFrom = options.ageFrom ?? "entry"
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch (cause) {
    if ((cause as Readonly<{ code?: unknown }>).code === "ENOENT") {
      return { root, entries: 0, reaped: 0, kept: 0, keptLive: 0, keptYoung: 0, keptForeign: 0, bytes: 0, failures: [] }
    }
    throw cause
  }
  let reaped = 0
  let keptLive = 0
  let keptYoung = 0
  let keptForeign = 0
  let bytes = 0
  const failures: string[] = []
  for (const name of entries) {
    const path = join(root, name)
    try {
      const stats = await lstat(path)
      if (!name.startsWith(namePrefix)) {
        keptForeign += 1
        continue
      }
      if (keep.has(path)) {
        keptLive += 1
        continue
      }
      if (now - stats.mtimeMs <= olderThanMs) {
        keptYoung += 1
        continue
      }
      // Only for an entry that already looks old: a recent root mtime is
      // already proof of a recent write, so the walk is paid solely by the
      // candidates for removal.
      if (ageFrom === "tree" && now - (await newestMtimeMs(path)) <= olderThanMs) {
        keptYoung += 1
        continue
      }
      const size = await directorySize(path)
      await rm(path, { recursive: true, force: true })
      reaped += 1
      bytes += size
    } catch (cause) {
      failures.push(`${path}: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  return {
    root,
    entries: entries.length,
    reaped,
    kept: keptLive + keptYoung + keptForeign,
    keptLive,
    keptYoung,
    keptForeign,
    bytes,
    failures,
  }
}

/**
 * One line naming every outcome of one sweep, against the denominator they were
 * drawn from.
 *
 * Every count is spelled even when it is zero, so the line reads the same shape
 * every time and an inert sweep is legible as inert: `reaped 0 ... 94 kept live`
 * says the keep rule is swallowing the whole population, which is the failure
 * that hid 27 GB behind a reaper that ran on schedule and did nothing.
 */
export function describeScratchReap(report: ScratchReapReport): string {
  return (
    `yrd: swept '${report.root}': reaped ${report.reaped} of ${report.entries} scanned ` +
    `(${formatBytes(report.bytes)} freed), ${report.keptLive} kept live, ${report.keptYoung} kept young, ` +
    `${report.keptForeign} kept foreign, ${report.failures.length} failed` +
    `${report.failures.length === 0 ? "" : `: ${report.failures.join("; ")}`}`
  )
}
/**
 * How long a run's artifacts are kept once the run has stopped writing them.
 *
 * The store had no retention at all: `createArtifactSink` writes one directory
 * per run, per step, per attempt, holding `stdout.log`, `stderr.log`,
 * `output.log` and `terminal.json`, and nothing has ever removed one. Measured
 * on the live queue state dir 2026-09-01: 694 MB across 5,684 run directories,
 * zero removals in 31 days.
 *
 * Fourteen days because the artifacts answer one question — what did this run
 * actually print — and that question is asked while the change is still in
 * play. A fortnight covers a change that sat over two weekends; past that the
 * run has landed or been withdrawn and the journal holds its verdict.
 */
export const DEFAULT_ARTIFACT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000

/** Operator override for the artifact retention floor, in milliseconds. */
export const ARTIFACT_RETENTION_ENV = "YRD_ARTIFACT_RETENTION_MS"

/**
 * How often one process re-sweeps the artifact root.
 *
 * The sibling reapers here sweep once per root per process, which is right for
 * scratch a short CLI invocation leaves behind and wrong for a resident that
 * runs for weeks: it would sweep at boot and never again. Hourly, gated on the
 * clock rather than scheduled, so a resident sweeps at its first artifact write
 * after boot and roughly hourly while it works — no timer, no second scheduler,
 * and no sweep at all on a process that writes no artifacts, which is also a
 * process that is not growing the store.
 */
export const ARTIFACT_PRUNE_INTERVAL_MS = 60 * 60 * 1000

/**
 * Resolve the retention floor from the host environment. An unset or blank
 * override yields the default; anything else that is not a positive integer of
 * milliseconds refuses loudly. Zero is refused with the rest: a silent
 * fallback, or a zero read as "keep nothing", is how a retention knob deletes
 * a store it was meant to bound.
 */
export function resolveArtifactRetentionMs(environment: Readonly<Partial<Record<string, string>>>): number {
  const raw = environment[ARTIFACT_RETENTION_ENV]
  if (raw === undefined || raw.trim() === "") return DEFAULT_ARTIFACT_RETENTION_MS
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`yrd: ${ARTIFACT_RETENTION_ENV} must be a positive integer of milliseconds, got '${raw}'`)
  }
  return parsed
}

/** When each artifact root was last swept, so the hourly gate needs no timer. */
const artifactSweepAt = new Map<string, number>()

/**
 * Remove run artifacts nothing has written for `olderThanMs`, at most once an
 * hour per root. Returns the sweep's report, or `undefined` when the hourly
 * gate is closed and no sweep ran — which a caller must not log as a clean
 * sweep, because it is not a sweep.
 *
 * Age is read from the whole tree (`ageFrom: "tree"`), and that is what keeps a
 * run still in flight. A long admission's run directory is created once and
 * never touched again while its step logs are appended to for hours or days, so
 * the directory's own mtime is ancient the entire time the run is alive.
 * Reading it alone would delete the artifacts of running work, longest runs
 * first. The journal knows which admissions are open, but it does not reach
 * this seam — `createArtifactSink` is called from a step body, which carries no
 * journal — so this uses the newest write anywhere in the tree instead. That is
 * the weaker signal the brief allows, and it is sound in the direction that
 * matters: anything being written to is young, whatever the journal says.
 *
 * No name filter. Every entry directly under an artifact root is a run key
 * `createArtifactSink` minted, so unlike the scratch roots there is no foreign
 * population to protect — the root is not shared with anything.
 */
export async function reapAgedArtifacts(
  root: string,
  options: Readonly<{ olderThanMs?: number; now?: number }> = {},
): Promise<ScratchReapReport | undefined> {
  const key = resolve(root)
  const now = options.now ?? systemClock.now()
  const last = artifactSweepAt.get(key)
  if (last !== undefined && now - last < ARTIFACT_PRUNE_INTERVAL_MS) return undefined
  artifactSweepAt.set(key, now)
  return reapOrphanedScratch(key, {
    olderThanMs: options.olderThanMs ?? DEFAULT_ARTIFACT_RETENTION_MS,
    now,
    namePrefix: "",
    ageFrom: "tree",
  })
}
