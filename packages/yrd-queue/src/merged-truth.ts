/**
 * Merged truth, derived from the repository — never from the change-record store.
 *
 * One question, three entry points: is this change merged on main? `merged` is
 * derived from git alone — the ANCESTRY of the unchanged authored tip (under
 * the merge model the queue merges the author's commits verbatim, so a merged
 * tip is reachable from main), plus a Change-Id lookup index built from the
 * trailers the queue stamps into every synthesis commit on main's first-parent
 * line. The persisted change record (`PR.merged`, `integratedAt`,
 * `integration.commit`) is NEVER an input; item 4 deletes it as authority, and
 * this module is the read side that replaces it. The merge-record notes under
 * `refs/notes/yrd/merge-records` are not an input either — they are an index
 * of the same truth, and an index must not certify itself.
 *
 * THE LOUD UNKNOWN (the trailer-drop door-stop): a commit that joined foreign
 * history into the walked line — any first-parent merge commit, or any commit
 * whose subject claims queue synthesis — while carrying NO readable Change-Id
 * is a SPECIMEN: it merged something this index cannot name. While specimens
 * stand in the walked window, "not found" is not "not merged": a lookup that
 * finds nothing answers `unknown: trailer-absent` naming the specimens, never
 * a silent not-merged. Specimens are cleared only by a caller-supplied named
 * exception per commit (the trailer-drop bead's "named derivation exceptions"),
 * or by bounding the walk (`stop`) above them. History that predates trailer
 * stamping makes an unbounded walk honestly — and uselessly — unknown-heavy;
 * production callers pass the epoch at which the queue began stamping.
 *
 * THE DEGENERATE COMPARISON (the collapsed-candidate door-stop): containment
 * is only evidence when the two endpoints are DIFFERENT commits. A candidate
 * that is its own base, or that is the very tip it would be merged into,
 * satisfies `is A contained in B` for free — and a free yes proves nothing
 * about a merge, exactly as `mergeJoinedNothing` records from the merge side.
 * Such a query answers the loud `unknown` naming both shas, never `merged`,
 * and the combined derivation then tries the lineage index — a real proof —
 * before it gives up. Containment itself is asked as `merge-base
 * --is-ancestor`, the predicate, never as an equality between two shas.
 *
 * Identity-neutral by construction: no journal events, no persisted schema,
 * no refs written. The index is an in-memory value pinned to a resolved tip
 * sha; the caller owns caching and rebuilds it when main moves.
 *
 * Consolidation note (read before adding another merged-truth reader): there
 * is no second implementation to reconcile with. `findRepositoryChangeMerge`
 * was the dormant predecessor — a per-query full-history scan that threw on
 * legitimate Change-Id multiplicity (a compose+merge pair stamps the same id
 * twice) and answered a silent not-proven for a trailer-dropped commit. It was
 * deleted on 2026-08-29 having never gained a production caller; this module
 * already answered both of those cases. Ask this module the question, or widen
 * it — do not reintroduce a private scan beside it.
 */
import { ChangeIdSchema, GitShaSchema } from "@yrd/bay"
import type { RefGit } from "./stranded-facts.ts"

/** The two reads this module needs from the package's exported repository
 * handle. `run` throws on non-zero — an unreadable repository is a loud
 * failure, never an empty index. `optional` serves the one question where a
 * non-zero exit is a real answer (`merge-base` on unrelated histories). */
export type MergedTruthGit = Pick<RefGit, "text" | "optionalText">

/** The synthesis acts the queue stamps into main's first-parent line. */
export type QueueSynthesisOperation = "merge" | "compose"

/** One commit on the walked line that carries a change's lineage identity. */
export type MergedTruthOccurrence = Readonly<{
  commit: string
  subject: string
  /** Parsed from the queue synthesis subject when it has that shape. */
  operation?: QueueSynthesisOperation
  /** The queue member the subject names (e.g. `PR2082`). Member ids from
   * before the durable mint can recycle, so this is context, not identity. */
  member?: string
  revision?: number
  /** Which fact produced this occurrence. `merge-change-id-trailer` recovers
   * the id from the `Merge-Change-Id` companion when `Change-Id` was dropped
   * (the companion embeds the id verbatim: `<change-id>-<operation>`). */
  source: "change-id-trailer" | "merge-change-id-trailer" | "exception"
  /** Position in the first-parent walk; 0 is the walked tip. */
  distanceFromTip: number
}>

export type MergedTruthSpecimenProblem = "trailer-absent" | "trailer-malformed"

/** A commit in the walked window whose lineage identity is UNRESOLVED — it
 * merged or claims to have synthesized something the trailer index cannot
 * name. Every specimen makes a not-found lookup unanswerable. */
export type MergedTruthSpecimen = Readonly<{
  commit: string
  subject: string
  parents: readonly string[]
  problem: MergedTruthSpecimenProblem
  /** What exactly was missing or unreadable, in the walker's own words. */
  detail: string
  operation?: QueueSynthesisOperation
  /** Parsed from the subject when it has the queue synthesis shape. A
   * specimen WITHOUT a member (a hand merge) can be any change's synthesis,
   * so member-scoped lookups never filter it out. */
  member?: string
  revision?: number
}>

/**
 * A named ruling for one specimen commit, keyed by its full sha — the
 * trailer-drop bead's "named derivation exceptions" for history that cannot
 * be rewritten. `carries-change` repairs the mapping (the commit is indexed
 * under the ruled id); `carries-no-change` records that the commit integrated
 * no lineage-tracked change (a subject-shape false positive, or content ruled
 * out of scope) and clears it from the unknown set. Exceptions are caller
 * input — config or fixture — never persisted by this module.
 */
export type TrailerAbsentException = Readonly<
  | { disposition: "carries-change"; changeId: string; note?: string }
  | { disposition: "carries-no-change"; note: string }
>

export type MergedTruthIndex = Readonly<{
  repo: string
  /** Resolved commit sha the walk started from. The index is pinned to this
   * sha; whether it still equals the live main ref is the caller's question. */
  tip: string
  /** Resolved exclusive lower bound, when the walk was bounded. */
  stop?: string
  /** Denominator for every "not found" answer: how many first-parent commits
   * the walk actually read. */
  commitsWalked: number
  /** Change-Id → occurrences, newest first. A compose+merge pair legitimately
   * yields two occurrences for one id; a multi-change synthesis commit yields
   * one occurrence under each of its ids. */
  byChangeId: ReadonlyMap<string, readonly MergedTruthOccurrence[]>
  /** Exact second-parent sha → the first-parent merge commit that carried it.
   * Newest wins when a tip was merged twice. */
  mergeBySecondParent: ReadonlyMap<string, string>
  /** Unresolved commits in the window, newest first. Non-empty means every
   * not-found lookup in this window answers unknown, not not-merged. */
  specimens: readonly MergedTruthSpecimen[]
  exceptionsApplied: number
}>

export type MergedTruthIndexOptions = Readonly<{
  /** Anything git resolves to a commit — the main tip to walk. */
  tip: string
  /** Exclusive lower bound (e.g. the epoch at which trailer stamping began);
   * the walk covers `stop..tip` restricted to tip's first-parent line. */
  stop?: string
  /** Named rulings for specimen commits, keyed by FULL sha. An exception for
   * a commit whose identity resolved from its own trailers is a contradiction
   * and refuses loudly; one for a commit outside the walk is ignored (the
   * walk may be bounded above it). */
  exceptions?: ReadonlyMap<string, TrailerAbsentException>
}>

const WALK_FORMAT =
  "%H%x09%P%x09%(trailers:key=Change-Id,valueonly,separator=%x2c)%x09%(trailers:key=Merge-Change-Id,valueonly,separator=%x2c)%x09%s"

/** Old-era subjects omit ` revision N` (`yrd: compose PR112`), so the
 * revision group is optional; the member is never optional. */
const QUEUE_SYNTHESIS_SUBJECT = /^yrd: (?<operation>merge|compose) (?<member>\S+)(?: revision (?<revision>\d+))?/u

/** Any `yrd: `-prefixed subject claims the queue lane, whatever era's verb it
 * uses; the walk must never let an unstamped queue commit pass as plain
 * history just because its verb predates the current vocabulary. */
const QUEUE_LANE_SUBJECT = /^yrd: /u

const MERGE_CHANGE_ID_VALUE = /^(?<changeId>I[0-9a-f]{40})-(?<operation>merge|compose)$/u

type ParsedSynthesisSubject = Readonly<{
  operation: QueueSynthesisOperation
  member: string
  revision?: number
}>

function parseSynthesisSubject(subject: string): ParsedSynthesisSubject | undefined {
  const match = QUEUE_SYNTHESIS_SUBJECT.exec(subject)
  const groups = match?.groups
  if (groups?.operation === undefined || groups.member === undefined) return undefined
  return {
    operation: groups.operation as QueueSynthesisOperation,
    member: groups.member,
    ...(groups["revision"] === undefined ? {} : { revision: Number(groups["revision"]) }),
  }
}

function splitTrailerValues(field: string): readonly string[] {
  return field === "" ? [] : field.split(",").filter((value) => value !== "")
}

type WalkRow = Readonly<{
  commit: string
  parents: readonly string[]
  changeIdValues: readonly string[]
  mergeChangeIdValues: readonly string[]
  subject: string
}>

function parseWalkRow(row: string): WalkRow {
  const fields = row.split("\t")
  // Five fixed fields with the subject LAST: a tab inside a subject is legal,
  // so everything past the fourth separator is subject text.
  if (fields.length < 5) throw new Error(`yrd: malformed merged-truth walk row '${row}'`)
  const [commit, parentsField, changeIdField, mergeChangeIdField] = fields
  if (
    commit === undefined ||
    parentsField === undefined ||
    changeIdField === undefined ||
    mergeChangeIdField === undefined
  ) {
    throw new Error(`yrd: malformed merged-truth walk row '${row}'`)
  }
  if (!/^[0-9a-f]{40,64}$/u.test(commit)) {
    throw new Error(`yrd: merged-truth walk row does not start with a commit sha: '${row}'`)
  }
  return {
    commit,
    parents: parentsField === "" ? [] : parentsField.split(" "),
    changeIdValues: splitTrailerValues(changeIdField),
    mergeChangeIdValues: splitTrailerValues(mergeChangeIdField),
    subject: fields.slice(4).join("\t"),
  }
}

/**
 * Build the in-memory merged-truth index by ONE first-parent walk of
 * `stop..tip`. Every commit is classified exactly once: readable Change-Id
 * trailers (or the id recovered from a readable `Merge-Change-Id` companion)
 * index it; a merge-lane commit with no readable identity becomes a specimen;
 * everything else is plain history, counted in `commitsWalked` only.
 */
export async function buildMergedTruthIndex(
  git: MergedTruthGit,
  repo: string,
  options: MergedTruthIndexOptions,
): Promise<MergedTruthIndex> {
  const exceptions = options.exceptions ?? new Map<string, TrailerAbsentException>()
  for (const [sha, exception] of exceptions) {
    GitShaSchema.parse(sha)
    if (exception.disposition === "carries-change") ChangeIdSchema.parse(exception.changeId)
  }
  const tip = await git.text(repo, ["rev-parse", "--verify", `${options.tip}^{commit}`])
  const stop =
    options.stop === undefined ? undefined : await git.text(repo, ["rev-parse", "--verify", `${options.stop}^{commit}`])
  const log = await git.text(repo, [
    "log",
    "--first-parent",
    "--no-show-signature",
    `--format=${WALK_FORMAT}`,
    tip,
    ...(stop === undefined ? [] : [`^${stop}`]),
    "--",
  ])
  const rows = log === "" ? [] : log.split("\n")
  const byChangeId = new Map<string, MergedTruthOccurrence[]>()
  const mergeBySecondParent = new Map<string, string>()
  const specimens: MergedTruthSpecimen[] = []
  let exceptionsApplied = 0

  const index = (changeId: string, occurrence: MergedTruthOccurrence): void => {
    const existing = byChangeId.get(changeId)
    if (existing === undefined) byChangeId.set(changeId, [occurrence])
    else existing.push(occurrence)
  }

  rows.forEach((row, distanceFromTip) => {
    const parsed = parseWalkRow(row)
    const synthesis = parseSynthesisSubject(parsed.subject)
    const enrichment = synthesis === undefined ? {} : synthesis

    for (const parent of parsed.parents.slice(1)) {
      // Newest wins: the walk runs newest-first, so only the first merge that
      // carried a given tip is recorded.
      if (!mergeBySecondParent.has(parent)) mergeBySecondParent.set(parent, parsed.commit)
    }

    // Resolve every lineage claim the commit makes; collect what cannot be read.
    const resolvedIds: string[] = []
    const unreadable: string[] = []
    for (const value of parsed.changeIdValues) {
      if (ChangeIdSchema.safeParse(value).success) resolvedIds.push(value)
      else unreadable.push(`Change-Id trailer value '${value}' is not a change id`)
    }
    for (const value of parsed.mergeChangeIdValues) {
      const match = MERGE_CHANGE_ID_VALUE.exec(value)
      const embedded = match?.groups?.["changeId"]
      if (embedded === undefined) {
        unreadable.push(`Merge-Change-Id trailer value '${value}' does not embed a change id`)
        continue
      }
      if (!resolvedIds.includes(embedded)) {
        if (parsed.changeIdValues.length > 0) {
          // Both trailers present but disagreeing is a synthesis whose identity
          // is ambiguous — the Change-Id claim still indexes, the disagreement
          // is surfaced as unreadable rather than silently preferring one.
          unreadable.push(
            `Merge-Change-Id trailer embeds '${embedded}' but the commit's Change-Id trailer(s) say ` +
              parsed.changeIdValues.map((id) => `'${id}'`).join(", "),
          )
        } else {
          resolvedIds.push(embedded)
        }
      }
    }

    const exception = exceptions.get(parsed.commit)
    if (exception !== undefined) {
      if (resolvedIds.length > 0) {
        throw new Error(
          `yrd: merged-truth exception for '${parsed.commit}' contradicts the commit's own readable ` +
            `lineage trailer(s) ${resolvedIds.map((id) => `'${id}'`).join(", ")} — fix the exception, not the trailer`,
        )
      }
      exceptionsApplied += 1
      if (exception.disposition === "carries-change") {
        index(exception.changeId, {
          commit: parsed.commit,
          subject: parsed.subject,
          ...enrichment,
          source: "exception",
          distanceFromTip,
        })
      }
      return
    }

    for (const changeId of resolvedIds) {
      const viaChangeIdTrailer = parsed.changeIdValues.includes(changeId)
      index(changeId, {
        commit: parsed.commit,
        subject: parsed.subject,
        ...enrichment,
        source: viaChangeIdTrailer ? "change-id-trailer" : "merge-change-id-trailer",
        distanceFromTip,
      })
    }

    if (unreadable.length > 0) {
      specimens.push({
        commit: parsed.commit,
        subject: parsed.subject,
        parents: parsed.parents,
        problem: "trailer-malformed",
        detail: unreadable.join("; "),
        ...enrichment,
      })
      return
    }
    if (resolvedIds.length > 0) return

    const mergeLane = parsed.parents.length >= 2 || QUEUE_LANE_SUBJECT.test(parsed.subject)
    if (mergeLane) {
      specimens.push({
        commit: parsed.commit,
        subject: parsed.subject,
        parents: parsed.parents,
        problem: "trailer-absent",
        detail:
          parsed.parents.length >= 2
            ? `merge commit on the first-parent line carries no Change-Id trailer`
            : `queue-lane subject carries no Change-Id trailer`,
        ...enrichment,
      })
    }
  })

  return {
    repo,
    tip,
    ...(stop === undefined ? {} : { stop }),
    commitsWalked: rows.length,
    byChangeId,
    mergeBySecondParent,
    specimens,
    exceptionsApplied,
  }
}

/** Optional lookup context that narrows which specimens can veto a not-found
 * answer. A specimen whose subject names a DIFFERENT queue member cannot be
 * the queried change's synthesis; a specimen naming no member (a hand merge)
 * always vetoes. Member ids can recycle, so the filter only ever errs toward
 * unknown, never toward not-merged. */
export type MergedTruthLookupContext = Readonly<{ member?: string }>

export type MergedByChangeId =
  | Readonly<{ kind: "merged"; changeId: string; occurrences: readonly MergedTruthOccurrence[] }>
  | Readonly<{
      kind: "unknown"
      reason: "trailer-absent"
      changeId: string
      specimens: readonly MergedTruthSpecimen[]
    }>
  | Readonly<{ kind: "not-merged"; changeId: string; commitsWalked: number }>

/** Answer merged-by-lineage from the index alone. Not-found is only
 * `not-merged` when the walked window holds no specimen that could be the
 * queried change's synthesis; otherwise it is the LOUD unknown. */
export function mergedByChangeId(
  index: MergedTruthIndex,
  changeId: string,
  context: MergedTruthLookupContext = {},
): MergedByChangeId {
  const id = ChangeIdSchema.parse(changeId)
  const occurrences = index.byChangeId.get(id)
  if (occurrences !== undefined && occurrences.length > 0) {
    return { kind: "merged", changeId: id, occurrences }
  }
  const vetoing =
    context.member === undefined
      ? index.specimens
      : index.specimens.filter((specimen) => specimen.member === undefined || specimen.member === context.member)
  if (vetoing.length > 0) {
    return { kind: "unknown", reason: "trailer-absent", changeId: id, specimens: vetoing }
  }
  return { kind: "not-merged", changeId: id, commitsWalked: index.commitsWalked }
}

/** Why a containment question could not be answered BY containment: its two
 * endpoints are the same commit, so the answer is true for free. The read-side
 * twin of `mergeJoinedNothing` — a merged result that IS its own base joined
 * nothing to history — and the shape a collapsed candidate wears. */
export type MergedTruthDegeneracy = "self-comparison" | "collapsed-onto-base"

export type MergedByAncestry =
  | Readonly<{
      kind: "merged"
      authoredTip: string
      /** The first-parent merge commit that carried the tip, when the tip is
       * one of the walked merges' exact second parents. */
      mergeCommit?: string
    }>
  | Readonly<{
      kind: "unknown"
      reason: MergedTruthDegeneracy
      authoredTip: string
      /** The commit the tip would have been compared against — the walked tip
       * for a self-comparison, the candidate's own base for a collapse. */
      comparedWith: string
      /** What was queried and what was missing, in the reader's own words. */
      detail: string
    }>
  | Readonly<{ kind: "not-merged"; authoredTip: string }>

export type MergedByAncestryOptions = Readonly<{
  /** The base the authored tip was cut against, when the caller knows it. A
   * candidate that RESOLVES TO its own base carries no commits at all, so its
   * containment in main is a property of the base and proves nothing about the
   * change; naming the base is what lets this read say so instead of agreeing.
   * Absent, only the self-comparison degeneracy is detectable. */
  base?: string
}>

/**
 * Answer commit containment: is this exact commit reachable from the walked
 * tip? Definitive in both directions — a commit either is or is not in main's
 * history, trailers or none — which is what rescues a change whose synthesis
 * dropped the trailer when the caller still knows the authored tip.
 *
 * The question goes to git as `merge-base --is-ancestor` — the containment
 * predicate itself. It is deliberately NOT an equality between two shas:
 * equality is what a candidate collapsed onto its base satisfies for free.
 *
 * BOTH endpoints are resolved through `rev-parse --verify` before the relation
 * is asked, and that is not ceremony — it is the positive control that makes a
 * NEGATIVE answer trustworthy. `text` throws, so an unreadable endpoint (a tip
 * naming no object, or an index tip the repository has since lost) is a loud
 * failure; only past that control is a non-zero `--is-ancestor` read as the
 * real answer "not contained" rather than as a fault reported as not-merged.
 *
 * A DEGENERATE comparison answers `unknown`, never `merged`: a tip that IS the
 * walked tip, or that IS its own declared base, makes containment true for
 * free. The caller gets the loud unknown naming both shas — and through
 * {@link mergedTruth} a second, real proof attempt via the lineage index.
 */
export async function mergedByAncestry(
  git: MergedTruthGit,
  index: MergedTruthIndex,
  authoredTip: string,
  options: MergedByAncestryOptions = {},
): Promise<MergedByAncestry> {
  const tip = await git.text(index.repo, ["rev-parse", "--verify", `${authoredTip}^{commit}`])
  const against = await git.text(index.repo, ["rev-parse", "--verify", `${index.tip}^{commit}`])
  if (tip === against) {
    return {
      kind: "unknown",
      reason: "self-comparison",
      authoredTip: tip,
      comparedWith: against,
      detail:
        `queried whether authored tip '${tip}' is contained in the walked tip '${against}' in ${index.repo}, and ` +
        `they are the SAME commit — containment holds for free, so no merge was proven; what is missing is a ` +
        `candidate distinct from the history it would be merged into`,
    }
  }
  if (options.base !== undefined) {
    const base = await git.text(index.repo, ["rev-parse", "--verify", `${options.base}^{commit}`])
    if (tip === base) {
      return {
        kind: "unknown",
        reason: "collapsed-onto-base",
        authoredTip: tip,
        comparedWith: base,
        detail:
          `queried whether authored tip '${tip}' is contained in the walked tip '${against}' in ${index.repo}, but ` +
          `that tip IS its own base '${base}' — the candidate carries no commits, so containment is the base's ` +
          `property and proves nothing about the change; what is missing is a candidate that carries work`,
      }
    }
  }
  const contained = await git.optionalText(index.repo, ["merge-base", "--is-ancestor", tip, against])
  if (contained === undefined) return { kind: "not-merged", authoredTip: tip }
  const mergeCommit = index.mergeBySecondParent.get(tip)
  return { kind: "merged", authoredTip: tip, ...(mergeCommit === undefined ? {} : { mergeCommit }) }
}

export type MergedTruthQuery = Readonly<{
  changeId?: string
  /** The change's unchanged authored tip, when the caller knows it. */
  authoredTip?: string
  /** The base that authored tip was cut against — see
   * {@link MergedByAncestryOptions}. Without it a collapsed candidate cannot
   * be told from a real one, and it reads as merged for free. */
  base?: string
  /** Queue member context for specimen filtering — see {@link MergedTruthLookupContext}. */
  member?: string
}>

export type MergedTruth =
  | Readonly<{
      kind: "merged"
      via: "ancestry" | "change-id"
      changeId?: string
      authoredTip?: string
      mergeCommit?: string
      occurrences?: readonly MergedTruthOccurrence[]
    }>
  | Readonly<{
      kind: "unknown"
      reason: "trailer-absent"
      changeId: string
      authoredTip?: string
      specimens: readonly MergedTruthSpecimen[]
    }>
  | Readonly<{
      kind: "unknown"
      reason: MergedTruthDegeneracy
      changeId?: string
      authoredTip: string
      comparedWith: string
      detail: string
    }>
  | Readonly<{ kind: "not-merged"; changeId?: string; authoredTip?: string; commitsWalked: number }>

/**
 * The combined derivation. Ancestry decides first when the authored tip is
 * known — a contained tip is merged whatever the trailers say. A lineage
 * lookup decides next. A query that names only the authored tip and misses on
 * ancestry is a definitive not-merged FOR THAT COMMIT (an earlier revision of
 * the same change is a different commit — pass the changeId to ask about the
 * change); a query that names the changeId and misses answers not-merged only
 * through a specimen-free window.
 */
export async function mergedTruth(
  git: MergedTruthGit,
  index: MergedTruthIndex,
  query: MergedTruthQuery,
): Promise<MergedTruth> {
  const changeId = query.changeId === undefined ? undefined : ChangeIdSchema.parse(query.changeId)
  if (changeId === undefined && query.authoredTip === undefined) {
    throw new Error("yrd: mergedTruth needs a changeId or an authoredTip; refusing to answer an empty question")
  }
  const context: MergedTruthLookupContext = query.member === undefined ? {} : { member: query.member }
  if (query.authoredTip !== undefined) {
    const ancestry = await mergedByAncestry(
      git,
      index,
      query.authoredTip,
      query.base === undefined ? {} : { base: query.base },
    )
    if (ancestry.kind === "merged") {
      const occurrences = changeId === undefined ? undefined : index.byChangeId.get(changeId)
      return {
        kind: "merged",
        via: "ancestry",
        authoredTip: ancestry.authoredTip,
        ...(changeId === undefined ? {} : { changeId }),
        ...(ancestry.mergeCommit === undefined ? {} : { mergeCommit: ancestry.mergeCommit }),
        ...(occurrences === undefined || occurrences.length === 0 ? {} : { occurrences }),
      }
    }
    if (ancestry.kind === "unknown") {
      // A degenerate containment decides NOTHING in either direction: it must
      // not certify a merge, and it must not drop out as a not-merged either.
      // The lineage index is the one other proof, so the query gets that second
      // chance; where it too fails to AFFIRM, the answer stays the loud unknown
      // naming what was queried and what was missing. A definitive lineage miss
      // cannot stand in for the containment question that was never answered.
      const lineage = changeId === undefined ? undefined : mergedByChangeId(index, changeId, context)
      if (lineage?.kind === "merged") {
        return {
          kind: "merged",
          via: "change-id",
          changeId: lineage.changeId,
          authoredTip: ancestry.authoredTip,
          occurrences: lineage.occurrences,
        }
      }
      if (lineage?.kind === "unknown") {
        return { ...lineage, authoredTip: ancestry.authoredTip }
      }
      return {
        kind: "unknown",
        reason: ancestry.reason,
        ...(changeId === undefined ? {} : { changeId }),
        authoredTip: ancestry.authoredTip,
        comparedWith: ancestry.comparedWith,
        detail:
          lineage === undefined
            ? ancestry.detail
            : `${ancestry.detail}; the lineage index then found no occurrence of '${lineage.changeId}' over its ` +
              `${String(lineage.commitsWalked)}-commit specimen-free window, which cannot answer the containment ` +
              `question that degenerated`,
      }
    }
    if (changeId === undefined) {
      return { kind: "not-merged", authoredTip: ancestry.authoredTip, commitsWalked: index.commitsWalked }
    }
    const lineage = mergedByChangeId(index, changeId, context)
    return lineage.kind === "merged"
      ? {
          kind: "merged",
          via: "change-id",
          changeId,
          authoredTip: ancestry.authoredTip,
          occurrences: lineage.occurrences,
        }
      : { ...lineage, authoredTip: ancestry.authoredTip }
  }
  if (changeId === undefined) {
    // Unreachable past the guard above; stated so the compiler and the reader
    // agree without a cast.
    throw new Error("yrd: mergedTruth lost its changeId after the empty-question guard")
  }
  const lineage = mergedByChangeId(index, changeId, context)
  return lineage.kind === "merged"
    ? { kind: "merged", via: "change-id", changeId: lineage.changeId, occurrences: lineage.occurrences }
    : lineage
}

/**
 * One store-side merged claim, in a NEUTRAL shape: the parity harness must
 * not import the change-record schemas whose deletion it exists to prove
 * safe, so the caller projects whatever store it reads into this.
 */
export type StoreMergedClaim = Readonly<{
  /** How reports name this claim — a queue member id, a bead, anything. */
  member: string
  changeId?: string
  authoredTip?: string
  /** The base that authored tip was cut against, when the store records one.
   * Supplying it is what lets a collapsed candidate be REFUSED rather than
   * certified by a containment that holds for free. */
  baseSha?: string
  merged: boolean
  /** The commit the store recorded as the merged result, when it did. */
  mergedCommit?: string
}>

export type MergedTruthAgreement = "agree" | "disagree" | "unknown"

export type MergedTruthComparison = Readonly<{
  member: string
  claim: StoreMergedClaim
  derived?: MergedTruth
  agreement: MergedTruthAgreement
  /** What was compared and why it agreed, disagreed, or could not answer. */
  detail: string
}>

/**
 * The agreement harness: derive merged truth for every store claim and name
 * each agreement, disagreement, and unknown individually — never a bare
 * count. An unknown is REPORTED, never folded into agreement: a specimen
 * window cannot certify a store row. A claim naming neither a changeId nor
 * an authored tip cannot be checked and is reported as unknown rather than
 * skipped, so the caller's denominator is always the full claim list.
 */
export async function compareMergedTruth(
  git: MergedTruthGit,
  index: MergedTruthIndex,
  claims: readonly StoreMergedClaim[],
): Promise<readonly MergedTruthComparison[]> {
  const comparisons: MergedTruthComparison[] = []
  for (const claim of claims) {
    if (claim.changeId === undefined && claim.authoredTip === undefined) {
      comparisons.push({
        member: claim.member,
        claim,
        agreement: "unknown",
        detail: "claim names neither a changeId nor an authoredTip, so the repository cannot be asked",
      })
      continue
    }
    const derived = await mergedTruth(git, index, {
      ...(claim.changeId === undefined ? {} : { changeId: claim.changeId }),
      ...(claim.authoredTip === undefined ? {} : { authoredTip: claim.authoredTip }),
      ...(claim.baseSha === undefined ? {} : { base: claim.baseSha }),
      member: claim.member,
    })
    comparisons.push(compareOne(claim, derived))
  }
  return comparisons
}

function compareOne(claim: StoreMergedClaim, derived: MergedTruth): MergedTruthComparison {
  const base = { member: claim.member, claim, derived }
  if (derived.kind === "unknown") {
    return {
      ...base,
      agreement: "unknown",
      detail:
        derived.reason === "trailer-absent"
          ? `repository window cannot answer: ${String(derived.specimens.length)} unresolved commit(s) — ` +
            derived.specimens
              .map((specimen) => `${specimen.commit} (${specimen.problem}: ${specimen.subject})`)
              .join(", ")
          : `repository cannot answer by containment (${derived.reason}): ${derived.detail}`,
    }
  }
  if (derived.kind === "not-merged") {
    return claim.merged
      ? {
          ...base,
          agreement: "disagree",
          detail: `store says merged but no commit in the ${String(derived.commitsWalked)}-commit window carries the change`,
        }
      : {
          ...base,
          agreement: "agree",
          detail: `both say not merged over a specimen-free ${String(derived.commitsWalked)}-commit window`,
        }
  }
  if (!claim.merged) {
    return {
      ...base,
      agreement: "disagree",
      detail:
        `store says not merged but the repository carries the change via ${derived.via}` +
        (derived.via === "ancestry"
          ? ` (authored tip ${String(derived.authoredTip)} is contained)`
          : ` (${(derived.occurrences ?? []).map((occurrence) => occurrence.commit).join(", ")})`),
    }
  }
  if (claim.mergedCommit !== undefined) {
    const known = new Set<string>([
      ...(derived.occurrences ?? []).map((occurrence) => occurrence.commit),
      ...(derived.mergeCommit === undefined ? [] : [derived.mergeCommit]),
    ])
    if (!known.has(claim.mergedCommit)) {
      return {
        ...base,
        agreement: "disagree",
        detail:
          `both say merged but the store's merged commit '${claim.mergedCommit}' is not among the repository's ` +
          `evidence (${[...known].join(", ") || "ancestry only"})`,
      }
    }
  }
  return {
    ...base,
    agreement: "agree",
    detail:
      `both say merged, via ${derived.via}` +
      (claim.mergedCommit === undefined ? "" : ` and the store's merged commit '${claim.mergedCommit}' matches`),
  }
}
