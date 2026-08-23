/**
 * Content identity: the tree-tuple diff.
 *
 * `exactDelta` answers ONE question — given two tree identities in the same
 * repository, exactly which paths differ and how — and its return shape serves
 * ONE consumer: the empty-candidate refusal of the re-merge path. A rebuild
 * whose candidate tree shows NO delta against its base must be refusable, and
 * that refusal wants to print the (empty) delta together with both tree shas,
 * so both resolved tree identities ride along with the entries.
 *
 * Commit-graph reasoning is exactly what this module exists to displace:
 * `git cherry` calls a revert-then-restore history "unique commits" while the
 * trees are identical (the 23167 specimen), so counting commits or patches says
 * "has work" where the tree truth says "empty". Only the tree tuple decides.
 *
 * Consolidation note (read before adding another tree diff): yrd-queue already
 * holds ONE private two-tree diff family in `command.ts` — `changedPaths`,
 * `deletedPaths` and the raw-format payload identity — all sharing the option
 * set `CERTIFICATE_DIFF_OPTIONS`. That family is module-private, so this file
 * cannot import it; instead it mirrors the exact option set (documented below,
 * kept byte-identical on purpose) over the package's exported repository
 * handle, `RefGit`. When a later phase may edit `command.ts`, the private
 * family and this module should converge on one implementation — this one is
 * the exported home.
 *
 * Patch equivalence, equivalence classes and burn-in deliberately do NOT live
 * here: a later phase owns `patchEquivalence`. This module never reads commit
 * history at all — only trees.
 */
import type { RefGit } from "./uncarried-facts.ts"

/** The one member `exactDelta` needs from the package's exported repository
 * handle. `run` throws on non-zero exit, which is the error contract here too:
 * an unreadable identity is a loud failure, never an empty delta. */
export type ExactDeltaGit = Pick<RefGit, "run">

/**
 * How a path changed between the two trees, straight from git's raw status
 * letter. Rename and copy detection are OFF (see the option set below), so
 * these four are the complete alphabet; any other letter is a parse failure.
 */
export type ExactDeltaKind = "added" | "deleted" | "modified" | "typechange"

/** What kind of tree entry the path is — computed from the entry mode of the
 * candidate side when present, else the base side. `gitlink` is a recorded
 * submodule commit (mode 160000); a gitlink-only delta is how a submodule move
 * shows up at the superproject tree level. */
export type ExactDeltaObject = "blob" | "symlink" | "gitlink"

export type ExactDeltaEntry = Readonly<{
  /** Full path from the repository root, nested directories included. */
  path: string
  kind: ExactDeltaKind
  object: ExactDeltaObject
  /** Tree entry mode on the base side; absent when the path was added. */
  baseMode?: string
  /** Tree entry mode on the candidate side; absent when the path was deleted. */
  candidateMode?: string
  /** Object id on the base side; absent when the path was added. */
  baseOid?: string
  /** Object id on the candidate side; absent when the path was deleted. */
  candidateOid?: string
}>

export type ExactDelta = Readonly<{
  /** Resolved tree object id of the `base` argument. */
  baseTree: string
  /** Resolved tree object id of the `tree` argument. */
  candidateTree: string
  /** Changed paths in git's own (path-sorted) order. Empty means the two
   * trees are content-identical — the empty-candidate refusal condition. */
  entries: readonly ExactDeltaEntry[]
}>

/**
 * Byte-identical mirror of the private `CERTIFICATE_DIFF_OPTIONS` in
 * `command.ts` (which this new file cannot import). The reasons carry over
 * unchanged: rename/copy detection is heuristic and `diff.renameLimit`
 * dependent, so with it on the same tree pair can answer differently as the
 * repository grows; external diff drivers and textconv rewrite content; and
 * submodule changes must never be filtered out, because a gitlink-only delta
 * is a real delta.
 */
const EXACT_DELTA_DIFF_OPTIONS = ["--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--no-renames"] as const

const RAW_RECORD = /^:([0-7]{6}) ([0-7]{6}) ((?:[0-9a-f]{64}|[0-9a-f]{40})) ((?:[0-9a-f]{64}|[0-9a-f]{40})) ([A-Z])$/u

const KIND_BY_STATUS: Readonly<Record<string, ExactDeltaKind>> = {
  A: "added",
  D: "deleted",
  M: "modified",
  T: "typechange",
}

const ABSENT_MODE = "000000"

function isZeroOid(oid: string): boolean {
  return /^0+$/u.test(oid)
}

function objectOf(mode: string, path: string): ExactDeltaObject {
  switch (mode) {
    case "100644":
    case "100755":
      return "blob"
    case "120000":
      return "symlink"
    case "160000":
      return "gitlink"
    default:
      // 040000 (a directory entry) only appears under `-t`, which is never
      // passed; anything else is a tree this module does not understand and
      // must not silently classify.
      throw new Error(`yrd: exact delta cannot classify mode '${mode}' at '${path}'`)
  }
}

function parseEntry(meta: string, path: string): ExactDeltaEntry {
  const match = RAW_RECORD.exec(meta)
  if (match === null) throw new Error(`yrd: unparsable raw diff record '${meta}' for path '${path}'`)
  const [, baseMode, candidateMode, baseOid, candidateOid, status] = match
  if (
    baseMode === undefined ||
    candidateMode === undefined ||
    baseOid === undefined ||
    candidateOid === undefined ||
    status === undefined
  ) {
    throw new Error(`yrd: unparsable raw diff record '${meta}' for path '${path}'`)
  }
  const kind = KIND_BY_STATUS[status]
  if (kind === undefined) {
    throw new Error(
      `yrd: unexpected diff status '${status}' at '${path}' — rename detection is off, so only A/D/M/T can appear`,
    )
  }
  const baseAbsent = baseMode === ABSENT_MODE && isZeroOid(baseOid)
  const candidateAbsent = candidateMode === ABSENT_MODE && isZeroOid(candidateOid)
  // Coherence between the status letter and the absent side is part of the
  // format; a disagreement means the output is not what this parser believes
  // it is reading, and must fail rather than narrow.
  if ((kind === "added") !== baseAbsent || (kind === "deleted") !== candidateAbsent) {
    throw new Error(`yrd: raw diff record '${meta}' disagrees with its status letter at '${path}'`)
  }
  return {
    path,
    kind,
    object: objectOf(candidateAbsent ? baseMode : candidateMode, path),
    ...(baseAbsent ? {} : { baseMode, baseOid }),
    ...(candidateAbsent ? {} : { candidateMode, candidateOid }),
  }
}

function parseRawDiff(raw: string): readonly ExactDeltaEntry[] {
  if (raw === "") return []
  const tokens = raw.split("\0")
  const entries: ExactDeltaEntry[] = []
  let index = 0
  while (index < tokens.length) {
    const meta = tokens[index]
    if (meta === undefined) break
    if (meta === "") {
      // Only the trailing NUL terminator may leave empty tokens; an empty
      // token with real records after it would mean silent truncation.
      for (const rest of tokens.slice(index)) {
        if (rest !== "") throw new Error("yrd: malformed raw diff output — empty token before further records")
      }
      break
    }
    const path = tokens[index + 1]
    if (path === undefined || path === "") {
      throw new Error(`yrd: raw diff record '${meta}' has no path token`)
    }
    entries.push(parseEntry(meta, path))
    index += 2
  }
  return entries
}

/**
 * The exact changed-path delta between two tree identities in one repository.
 *
 * `base` and `tree` may be anything git can peel to a tree — a commit sha, a
 * ref name, a tag, or a tree object id. Both are resolved to their tree ids
 * first, the diff runs over those resolved ids, and both ride along in the
 * result so the empty-candidate refusal can print them verbatim.
 *
 * An empty `entries` array is a positive fact — the two trees are identical —
 * never a fallback: every failure to resolve, run, or parse throws.
 */
export async function exactDelta(git: ExactDeltaGit, repo: string, base: string, tree: string): Promise<ExactDelta> {
  const baseTree = await git.run(repo, ["rev-parse", "--verify", `${base}^{tree}`])
  const candidateTree = await git.run(repo, ["rev-parse", "--verify", `${tree}^{tree}`])
  const raw = await git.run(repo, [
    "diff",
    ...EXACT_DELTA_DIFF_OPTIONS,
    "--raw",
    "--no-abbrev",
    "-z",
    baseTree,
    candidateTree,
    "--",
  ])
  return { baseTree, candidateTree, entries: parseRawDiff(raw) }
}

/**
 * One canonical rendering of a delta, shaped for the empty-candidate refusal:
 * both tree shas always, then either the explicit "no changed paths" fact or
 * one line per changed path. Deterministic — entries print in the order git
 * reported them.
 */
export function formatExactDelta(delta: ExactDelta): string {
  const head = `exact delta: base tree ${delta.baseTree} -> candidate tree ${delta.candidateTree}`
  if (delta.entries.length === 0) return `${head}: no changed paths`
  const lines = delta.entries.map((entry) => `  ${entry.kind} ${entry.object} ${entry.path}`)
  return [`${head}: ${delta.entries.length} changed path(s)`, ...lines].join("\n")
}
