/**
 * The binding key: a context-insensitive change-content identity.
 *
 * Replaces `patchEquivalence` (`git diff | git patch-id --stable`), which the
 * 2026-08-26 burn-in (hub/yrd/2026-08-26-patch-equivalence-burn-in.md,
 * vault-side) failed for binding: `git patch-id` hashes context lines, so its
 * key is a function of the change AND its surroundings — on real history it
 * broke on one in five rebases where main had touched a file the change
 * touches, including one case (PR1028) with byte-identical `+`/`-` lines.
 *
 * The key here is a digest over the change's OWN content only, per file:
 *
 * - text (blob and symlink) entries — the removed lines in base-file order and
 *   the added lines in result-file order, as two separate sequences. Context
 *   lines, hunk boundaries and line numbers contribute nothing, so the key
 *   survives context drift and hunk splits/joins; the two orders are the
 *   change's own and survive regrouping (interleaving -/+ by change group
 *   would not — group structure is itself context).
 * - gitlink entries — the recorded submodule commits themselves: a pin is
 *   authored content, and patch text for it would drag in nothing more.
 * - binary and typechange entries — the object ids of both sides: there is no
 *   line content to normalize, and the ids are exactly the content.
 * - every entry — the path (patch-id is blind to paths) and the mode DELTA
 *   (`exactDeltaModeDelta`): the change's chmod is keyed, the base's ambient
 *   mode is not, so a rebase over an unrelated chmod cannot move the key.
 *
 * The key moves exactly when the change's own contribution against its base
 * moves — so a rebase that absorbs part of the change re-keys (a verdict on
 * the old content does not cover the new net contribution), and pure context
 * drift does not.
 *
 * Two deliberate, bounded normalizations, inherited from `RefGit.run`'s
 * trimmed-stdout contract and Response.text() decoding: trailing whitespace on
 * the final line of the final hunk, and invalid-UTF-8 byte sequences (both
 * sides decode identically, so only files of invalid UTF-8 that git still
 * classifies as text are affected). Both are strictly narrower than
 * patch-id's whitespace-blindness everywhere.
 *
 * An EMPTY change has no key — `bindingKey` throws rather than minting a
 * value every empty change would share (identity.md: an empty content
 * identity is an absence, never evidence; it can never bind a verdict or a
 * review).
 */
import { createHash } from "node:crypto"
import {
  EXACT_DELTA_DIFF_OPTIONS,
  exactDelta,
  exactDeltaModeDelta,
  formatExactDelta,
  type ExactDelta,
  type ExactDeltaEntry,
  type ExactDeltaGit,
  type ExactDeltaKind,
  type ExactDeltaObject,
} from "./content-identity.ts"

/** Ordered `-`/`+` line material of a text entry, markers stripped; the
 * `\ No newline at end of file` marker rides in-sequence on the side it
 * qualifies, so newline-at-eof facts key like any other content. */
export type BindingKeyLineContent = Readonly<{
  form: "lines"
  removed: readonly string[]
  added: readonly string[]
}>

/** Content keyed by object id — binary and typechange entries, where there is
 * no line material and the ids are exactly the content. */
export type BindingKeyOpaqueContent = Readonly<{
  form: "opaque"
  baseOid?: string
  candidateOid?: string
}>

/** A gitlink move keyed by the recorded submodule commits themselves. */
export type BindingKeyGitlinkContent = Readonly<{
  form: "gitlink"
  baseOid?: string
  candidateOid?: string
}>

export type BindingKeyContent = BindingKeyLineContent | BindingKeyOpaqueContent | BindingKeyGitlinkContent

export type BindingKeyFile = Readonly<{
  path: string
  kind: ExactDeltaKind
  object: ExactDeltaObject
  /** The change's own mode contribution — see {@link exactDeltaModeDelta}. */
  modeDelta: string
  content: BindingKeyContent
}>

export type BindingKey = Readonly<{
  /** Resolved tree object id of the `base` argument. */
  baseTree: string
  /** Resolved tree object id of the `tip` argument. */
  candidateTree: string
  /** SHA-256 hex over the canonical serialization of `files` — the key. */
  key: string
  /** Per-file material behind the key, in git's path-sorted order. */
  files: readonly BindingKeyFile[]
}>

/** Pinned so the same change keys identically on every host: `diff.algorithm`
 * is user/repo config and histogram picks different `-`/`+` lines than myers
 * on some inputs, which would silently unbind a verdict across machines.
 * Color never reaches a pipe by default, but `color.diff=always` exists. */
const BINDING_KEY_DIFF_OPTIONS = ["--no-color", "--diff-algorithm=myers", "-U0"] as const

type ParsedZeroContextDiff = Readonly<{
  removed: readonly string[]
  added: readonly string[]
  sawHunk: boolean
}>

function parseZeroContextDiff(raw: string, path: string): ParsedZeroContextDiff {
  const removed: string[] = []
  const added: string[] = []
  let sawHunk = false
  let last: string[] | undefined
  for (const line of raw.split("\n")) {
    if (line.startsWith("@@")) {
      sawHunk = true
      last = undefined
      continue
    }
    if (!sawHunk) continue // the single header block: diff --git, index, ---/+++, mode or binary lines
    if (line.startsWith("+")) {
      added.push(line.slice(1))
      last = added
      continue
    }
    if (line.startsWith("-")) {
      removed.push(line.slice(1))
      last = removed
      continue
    }
    if (line.startsWith("\\")) {
      if (last === undefined) {
        throw new Error(`yrd: zero-context diff for '${path}' carries a '\\' marker before any content line`)
      }
      last.push(line)
      continue
    }
    if (line === "") continue // the final newline's split artifact
    // A context line cannot appear under -U0 and a second header block cannot
    // appear under a single-path literal pathspec; anything else means this is
    // not the output this parser believes it is reading.
    throw new Error(`yrd: unexpected line in the zero-context diff for '${path}': '${line}'`)
  }
  return { removed, added, sawHunk }
}

function opaqueContent(entry: ExactDeltaEntry, form: "opaque" | "gitlink"): BindingKeyContent {
  return {
    form,
    ...(entry.baseOid === undefined ? {} : { baseOid: entry.baseOid }),
    ...(entry.candidateOid === undefined ? {} : { candidateOid: entry.candidateOid }),
  }
}

async function fileMaterial(
  git: ExactDeltaGit,
  repo: string,
  delta: ExactDelta,
  entry: ExactDeltaEntry,
): Promise<BindingKeyFile> {
  const shared = { path: entry.path, kind: entry.kind, object: entry.object, modeDelta: exactDeltaModeDelta(entry) }
  if (entry.object === "gitlink") return { ...shared, content: opaqueContent(entry, "gitlink") }
  if (entry.kind === "typechange") return { ...shared, content: opaqueContent(entry, "opaque") }
  const raw = await git.text(repo, [
    "diff",
    ...EXACT_DELTA_DIFF_OPTIONS,
    ...BINDING_KEY_DIFF_OPTIONS,
    delta.baseTree,
    delta.candidateTree,
    "--",
    `:(literal)${entry.path}`,
  ])
  if (raw === "") {
    throw new Error(`yrd: the scoped diff for '${entry.path}' is empty though the raw diff listed the path`)
  }
  const parsed = parseZeroContextDiff(raw, entry.path)
  if (!parsed.sawHunk) {
    if (entry.baseOid !== undefined && entry.baseOid === entry.candidateOid) {
      // A mode-only change: same blob on both sides, the mode delta above is
      // the whole content.
      return { ...shared, content: { form: "lines", removed: [], added: [] } }
    }
    // Differing blobs with no hunks is git declining to produce text — a
    // binary entry; the object ids are the content.
    return { ...shared, content: opaqueContent(entry, "opaque") }
  }
  return { ...shared, content: { form: "lines", removed: parsed.removed, added: parsed.added } }
}

/** Length-prefixed canonical serialization: content lines are framed by their
 * byte length, so no line can impersonate the structure around it. */
function digestOf(files: readonly BindingKeyFile[]): string {
  const hash = createHash("sha256")
  const text = (piece: string): void => {
    hash.update(piece, "utf8")
  }
  const framed = (piece: string): void => {
    text(`${Buffer.byteLength(piece, "utf8")}\n`)
    text(piece)
    text("\n")
  }
  text("yrd-binding-key v1\n")
  for (const file of files) {
    text("file ")
    framed(file.path)
    text(`kind ${file.kind} object ${file.object} mode ${file.modeDelta}\n`)
    if (file.content.form === "lines") {
      text(`removed ${file.content.removed.length}\n`)
      for (const line of file.content.removed) framed(line)
      text(`added ${file.content.added.length}\n`)
      for (const line of file.content.added) framed(line)
    } else {
      text(`${file.content.form} ${file.content.baseOid ?? "-"} ${file.content.candidateOid ?? "-"}\n`)
    }
  }
  return hash.digest("hex")
}

/**
 * The binding key of the change between two tree identities in one repository.
 *
 * `base` and `tip` may be anything git can peel to a tree. Pass the change's
 * MERGE BASE as `base` for binding semantics — this function reads no commit
 * history, exactly like `exactDelta`; a caller holding a moving base ref
 * computes `git merge-base` itself. The key moves exactly when the change's
 * own contribution against the given base moves.
 *
 * Throws on an empty change: an empty content identity is an absence, never a
 * key — hashing it would mint one value every empty change shares.
 */
export async function bindingKey(git: ExactDeltaGit, repo: string, base: string, tip: string): Promise<BindingKey> {
  const delta = await exactDelta(git, repo, base, tip)
  if (delta.entries.length === 0) {
    throw new Error(
      `yrd: binding key is undefined for an empty change (${formatExactDelta(delta)}) — an empty identity is an absence and can never bind a verdict or review`,
    )
  }
  const files: BindingKeyFile[] = []
  for (const entry of delta.entries) {
    files.push(await fileMaterial(git, repo, delta, entry))
  }
  return { baseTree: delta.baseTree, candidateTree: delta.candidateTree, key: digestOf(files), files }
}
