import { randomUUID } from "node:crypto"
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs"
import { join } from "node:path"

const PR_MINT_FILE = "pr-mint.json"
const PR_MINT_VERSION = 1

/** Durable authority for the next PR number.
 *
 * `max(existing) + 1` over the live record set cannot survive the record set
 * being emptied — a checkpoint-identity bump with evicted history bootstraps
 * the store "fresh" and the scan restarts at 1, re-issuing numbers that
 * already name landed changes (22986: one number named two different PRs four
 * weeks apart). The mint is the asymmetry ruling made mechanical: durable
 * minting is reversible — a skipped number costs nothing — while renumbering
 * retroactively poisons every citation of the old number and cannot be taken
 * back. So the high-water is persisted BEFORE an id escapes, and every
 * failure of the backing store refuses loudly rather than falling back to a
 * record-set scan.
 */
export type PrNumberMint = Readonly<{
  /** Highest PR number this store has ever committed; 0 when it has never
   * minted. Throws when the backing store exists but cannot be read or does
   * not parse — a present-but-broken store must never read as "never minted". */
  highWater(): number
  /** Durably record `highWater` as spent. Callers persist before letting the
   * covered id escape, so a crash between commit and use skips a number but
   * can never re-issue one. Throws when the store cannot be written. */
  commit(highWater: number): void
}>

type MintFailure = Readonly<{ path: string; action: string }>

function mintError(failure: MintFailure, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new Error(`yrd: PR-number mint store at '${failure.path}' ${failure.action}: ${detail}`, { cause })
}

function parseHighWater(path: string, raw: string): number {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw mintError({ path, action: "holds malformed JSON" }, error)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw mintError({ path, action: "holds an unexpected shape" }, `expected an object, got ${JSON.stringify(parsed)}`)
  }
  const { v, prHighWater } = parsed as Readonly<{ v?: unknown; prHighWater?: unknown }>
  if (v !== PR_MINT_VERSION) {
    throw mintError(
      { path, action: "declares an unsupported version" },
      `expected v ${PR_MINT_VERSION}, got ${JSON.stringify(v)}`,
    )
  }
  if (typeof prHighWater !== "number" || !Number.isSafeInteger(prHighWater) || prHighWater < 1) {
    throw mintError(
      { path, action: "holds an invalid high-water" },
      `expected a positive safe integer, got ${JSON.stringify(prHighWater)}`,
    )
  }
  return prHighWater
}

function readHighWater(path: string): number {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (error) {
    // A store that has never minted has no file — that is the one expected
    // absence. Every other failure is a present store this process cannot
    // read, and guessing 0 there is exactly the recycling this mint exists
    // to prevent.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0
    throw mintError({ path, action: "is unreadable" }, error)
  }
  return parseHighWater(path, raw)
}

/** A `PrNumberMint` backed by a file BESIDE the journal database, deliberately
 * not a table inside it: the re-initialization class this mint defends against
 * includes the database file being snapshot-restored or deleted and rebuilt,
 * which a table rides along with. Single-writer discipline comes from the
 * journal's own exclusivity; the mint takes no lock of its own. Writes are
 * atomic (temp file, fsync, rename, directory fsync) so a torn write can never
 * be read back as a lower high-water. */
export function createDurablePrNumberMint(options: Readonly<{ dir: string }>): PrNumberMint {
  const path = join(options.dir, PR_MINT_FILE)
  return Object.freeze({
    highWater: () => readHighWater(path),
    commit(highWater: number): void {
      if (!Number.isSafeInteger(highWater) || highWater < 1) {
        throw new Error(`yrd: PR-number mint refuses non-positive high-water ${JSON.stringify(highWater)}`)
      }
      const current = readHighWater(path)
      if (highWater <= current) {
        throw mintError(
          { path, action: "refuses to move its high-water backwards" },
          `already at ${String(current)}, asked to commit ${String(highWater)}`,
        )
      }
      try {
        mkdirSync(options.dir, { recursive: true })
      } catch (error) {
        throw mintError({ path, action: "cannot create its directory" }, error)
      }
      const candidate = join(options.dir, `.${PR_MINT_FILE}.${randomUUID()}`)
      try {
        const fd = openSync(candidate, "wx")
        try {
          writeSync(fd, JSON.stringify({ v: PR_MINT_VERSION, prHighWater: highWater }))
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        renameSync(candidate, path)
      } catch (error) {
        try {
          unlinkSync(candidate)
        } catch {
          // The temp file may never have been created; the original error is
          // the one that matters.
        }
        throw mintError({ path, action: "is unwritable" }, error)
      }
      // Rename durability: without flushing the directory entry, a power loss
      // can resurrect the previous high-water after the id was already
      // journaled — the one window where a number could be re-issued.
      try {
        const dirFd = openSync(options.dir, "r")
        try {
          fsyncSync(dirFd)
        } finally {
          closeSync(dirFd)
        }
      } catch (error) {
        throw mintError({ path, action: "cannot flush its directory entry" }, error)
      }
    },
  })
}
