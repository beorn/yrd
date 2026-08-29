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
 * Patch equivalence deliberately does NOT live here — and after the
 * 2026-08-26 burn-in (hub/yrd/2026-08-26-patch-equivalence-burn-in.md,
 * vault-side) it lives nowhere: `git patch-id --stable` hashes context lines,
 * so its key moves when main edits NEAR a change and cannot bind verdicts or
 * reviews. The replacement is the normalized ±line digest in `binding-key.ts`.
 * This module never reads commit history at all — only trees.
 */
import type { RefGit } from "./stranded-facts.ts"

/** The one member `exactDelta` needs from the package's exported repository
 * handle. `run` throws on non-zero exit, which is the error contract here too:
 * an unreadable identity is a loud failure, never an empty delta. */
export type ExactDeltaGit = Pick<RefGit, "text">

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
export const EXACT_DELTA_DIFF_OPTIONS = [
  "--no-ext-diff",
  "--no-textconv",
  "--ignore-submodules=none",
  "--no-renames",
] as const

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
  const baseTree = await git.text(repo, ["rev-parse", "--verify", `${base}^{tree}`])
  const candidateTree = await git.text(repo, ["rev-parse", "--verify", `${tree}^{tree}`])
  const raw = await git.text(repo, [
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

/**
 * The change's own mode contribution, as a printable token: `=` when the
 * change leaves the mode alone, `+<mode>` for a creation, `-<mode>` for a
 * deletion, `<base>-><candidate>` for a chmod. Absolute modes of an untouched
 * entry are deliberately NOT part of this — they belong to whatever base the
 * delta was measured against, so keying them would move an identity on every
 * rebase over a chmod on main.
 */
export function exactDeltaModeDelta(entry: ExactDeltaEntry): string {
  if (entry.baseMode === undefined) {
    if (entry.candidateMode === undefined) {
      throw new Error(`yrd: exact delta entry for '${entry.path}' carries no mode on either side`)
    }
    return `+${entry.candidateMode}`
  }
  if (entry.candidateMode === undefined) return `-${entry.baseMode}`
  return entry.baseMode === entry.candidateMode ? "=" : `${entry.baseMode}->${entry.candidateMode}`
}

export type CrossBaseDifferenceReason = "missing-from-landed" | "kind" | "object" | "mode-delta" | "gitlink-target"

export type CrossBaseDifference = Readonly<{
  path: string
  reason: CrossBaseDifferenceReason
  /** The authored side's value for the disagreeing fact, printable. */
  authored: string
  /** The landed side's value; `(absent)` when the path is missing. */
  landed: string
}>

export type CrossBaseComparison = Readonly<{
  /** True only when NEITHER delta is empty and every authored path agrees.
   * An empty delta is an absence, never a key (identity.md's empty-refuses
   * clause), so emptiness on either side is never equality. */
  equal: boolean
  authoredEmpty: boolean
  landedEmpty: boolean
  /** Every disagreement over the authored path set, in authored order. */
  differing: readonly CrossBaseDifference[]
}>

/**
 * The cross-base equality clause of the net-delta witness, corrected per the
 * 2026-08-26 burn-in (hub/yrd/2026-08-26-patch-equivalence-burn-in.md § the
 * exactDelta disagreements): two deltas of the same change measured against
 * DIFFERENT bases are compared over the authored path set on (kind, object,
 * mode delta) — never on resulting blob ids, because rebasing a change onto a
 * base that also touched the file necessarily changes the resulting blob.
 * Blob comparison refused 24 ordinary rebases on real history; this predicate
 * admits 20 of them outright and still refuses all 18 real divergences —
 * gitlink entries ARE compared by recorded target, since a pin is the change's
 * own content and a conflict-free rebase never rewrites it: an absorbed pin is
 * landed code the author never submitted. The remaining 4 (a file whose whole
 * change the base absorbed) surface as `missing-from-landed`, which
 * {@link resolveAbsorbedPaths} settles with one tree read; a consumer that
 * skips that step over-refuses, never over-admits.
 *
 * Landed paths outside the authored set are invisible here: the merge
 * machinery's own contributions (the shaset commit) are not the change's.
 */
export function crossBaseDeltaEquality(authored: ExactDelta, landed: ExactDelta): CrossBaseComparison {
  const landedByPath = new Map(landed.entries.map((entry) => [entry.path, entry]))
  const differing: CrossBaseDifference[] = []
  for (const entry of authored.entries) {
    const counterpart = landedByPath.get(entry.path)
    if (counterpart === undefined) {
      differing.push({ path: entry.path, reason: "missing-from-landed", authored: entry.kind, landed: "(absent)" })
      continue
    }
    if (counterpart.kind !== entry.kind) {
      differing.push({ path: entry.path, reason: "kind", authored: entry.kind, landed: counterpart.kind })
      continue
    }
    if (counterpart.object !== entry.object) {
      differing.push({ path: entry.path, reason: "object", authored: entry.object, landed: counterpart.object })
      continue
    }
    const authoredMode = exactDeltaModeDelta(entry)
    const landedMode = exactDeltaModeDelta(counterpart)
    if (authoredMode !== landedMode) {
      differing.push({ path: entry.path, reason: "mode-delta", authored: authoredMode, landed: landedMode })
      continue
    }
    if (entry.object === "gitlink") {
      // The present side of the authored entry names the recorded commit the
      // change ships (or removes); kinds already agree, so the same side is
      // present on the landed entry.
      const side = entry.candidateOid !== undefined ? "candidateOid" : "baseOid"
      const authoredTarget = entry[side]
      const landedTarget = counterpart[side]
      if (authoredTarget !== landedTarget) {
        differing.push({
          path: entry.path,
          reason: "gitlink-target",
          authored: authoredTarget ?? "(absent)",
          landed: landedTarget ?? "(absent)",
        })
      }
    }
  }
  const authoredEmpty = authored.entries.length === 0
  const landedEmpty = landed.entries.length === 0
  return { equal: !authoredEmpty && !landedEmpty && differing.length === 0, authoredEmpty, landedEmpty, differing }
}

/**
 * Resolves the one ambiguous difference class `crossBaseDeltaEquality` cannot
 * decide from two deltas alone: a `missing-from-landed` path means EITHER the
 * landed base already absorbed that file's whole change (an ordinary rebase —
 * admit) OR the merge dropped authored work (refuse). The burn-in corpus holds
 * 4 real absorbed specimens (PR1243, PR1521, PR1874, PR2019) that pure
 * path-set comparison would wrongly refuse.
 *
 * The discriminating read is one tree lookup per missing path, against the
 * landed delta's OWN base tree: the change is absorbed exactly when that base
 * already carries the change's result — the authored candidate (mode, blob)
 * for an addition/modification, or the path's absence for a deletion. Only
 * trees are read, per this module's contract.
 *
 * A landed delta that is EMPTY stays unequal regardless (the empty-refuses
 * clause): full absorption is the redundant-change settlement's business,
 * never a witness key.
 */
export async function resolveAbsorbedPaths(
  git: ExactDeltaGit,
  repo: string,
  authored: ExactDelta,
  landed: ExactDelta,
  comparison: CrossBaseComparison,
): Promise<CrossBaseComparison> {
  const entriesByPath = new Map(authored.entries.map((entry) => [entry.path, entry]))
  const remaining: CrossBaseDifference[] = []
  for (const difference of comparison.differing) {
    if (difference.reason !== "missing-from-landed") {
      remaining.push(difference)
      continue
    }
    const entry = entriesByPath.get(difference.path)
    if (entry === undefined) {
      throw new Error(`yrd: comparison names '${difference.path}' but the authored delta does not carry it`)
    }
    const listed = await treeEntryAt(git, repo, landed.baseTree, entry.path)
    if (entry.kind === "deleted") {
      // Absorbed when the landed base no longer carries the path at all.
      if (listed === undefined) continue
      remaining.push(difference)
      continue
    }
    if (listed !== undefined && listed.mode === entry.candidateMode && listed.oid === entry.candidateOid) continue
    remaining.push(difference)
  }
  return withDiffering(comparison, remaining)
}

/**
 * The merge-time resolution of `missing-from-landed`, for a consumer that
 * holds the CANDIDATE tree (the clean rebase the queue built and tested): the
 * merged result may legitimately show no delta at an authored path when the
 * base absorbed that file's change — including absorbed-then-edited-further,
 * where the base's blob is not byte-identical to the authored candidate and
 * {@link resolveAbsorbedPaths} cannot decide (the burn-in's PR1243 and PR1874
 * are that shape). The merged tree is honest at such a path exactly when it
 * agrees with the candidate there, so each remaining missing path is settled
 * by comparing the landed delta's own result tree against `candidateTree` at
 * that path: equal resolves, disagreement stays refused.
 *
 * ABSENT ON BOTH SIDES IS NOT AGREEMENT, except for an authored deletion where
 * absence IS the change's own result. For an addition or an edit neither tree
 * carries the work, so `undefined === undefined` would admit precisely what
 * this settlement exists to refuse — a merge that dropped the path, waved
 * through by a candidate that never carried it either (a wrong or empty tree,
 * or the merged tree passed as its own witness). The agreement has to be
 * positive: the candidate must hold the path for holding it to mean anything.
 *
 * The candidate must be an artifact built independently of the merged result
 * (the queue's tested candidate). Tree IDENTITY between the two is not the
 * tell — git's merge is deterministic, so a faithful merge of the tested
 * candidate legitimately yields that very tree — which is why what settles a
 * path here is the per-path comparison above, never an equality of tree shas.
 */
export async function resolveMissingAgainstCandidate(
  git: ExactDeltaGit,
  repo: string,
  landed: ExactDelta,
  comparison: CrossBaseComparison,
  candidateTree: string,
): Promise<CrossBaseComparison> {
  const remaining: CrossBaseDifference[] = []
  for (const difference of comparison.differing) {
    if (difference.reason !== "missing-from-landed") {
      remaining.push(difference)
      continue
    }
    const merged = await treeEntryAt(git, repo, landed.candidateTree, difference.path)
    const candidate = await treeEntryAt(git, repo, candidateTree, difference.path)
    if (merged === undefined && candidate === undefined) {
      // `difference.authored` carries the authored ENTRY KIND for exactly this
      // read (see {@link crossBaseDeltaEquality}): absence settles a deletion
      // and nothing else. Any present-shaped change absent on BOTH sides is the
      // vacuous branch described above, and stays refused.
      if (difference.authored === "deleted") continue
      remaining.push(difference)
      continue
    }
    if (merged?.mode === candidate?.mode && merged?.oid === candidate?.oid) continue
    remaining.push(difference)
  }
  return withDiffering(comparison, remaining)
}

function withDiffering(comparison: CrossBaseComparison, differing: CrossBaseDifference[]): CrossBaseComparison {
  return {
    equal: !comparison.authoredEmpty && !comparison.landedEmpty && differing.length === 0,
    authoredEmpty: comparison.authoredEmpty,
    landedEmpty: comparison.landedEmpty,
    differing,
  }
}

/** One tree entry's (mode, oid) at a path, or undefined when absent — a pure
 * tree read; parse failures throw rather than reading as absence. */
async function treeEntryAt(
  git: ExactDeltaGit,
  repo: string,
  tree: string,
  path: string,
): Promise<Readonly<{ mode: string; oid: string }> | undefined> {
  const listed = await git.text(repo, ["ls-tree", "-z", tree, "--", path])
  const record = listed.split("\0").find((row) => row !== "")
  if (record === undefined) return undefined
  const match = /^([0-7]{6}) \S+ (\S+)\t/u.exec(record)
  if (match === null) throw new Error(`yrd: unparsable ls-tree record '${record}' for '${path}'`)
  const [, mode, oid] = match
  if (mode === undefined || oid === undefined) {
    throw new Error(`yrd: unparsable ls-tree record '${record}' for '${path}'`)
  }
  return { mode, oid }
}
