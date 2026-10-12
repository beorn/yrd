/**
 * #27363 — the compose revert guard: did this candidate put a target advance back?
 *
 * The measured incident: a branch cut from a base BELOW the target's km pin landed a
 * compose whose root diff moved exactly one entry (the km gitlink, mode 160000) while
 * four files INSIDE km came back to their pre-advance content — the km write-log cap
 * 480 -> 416 MiB, which deferred every km write fleet-wide for ten minutes. The pin
 * move was a genuine FAST-FORWARD, so no ancestry check can see it; the revert is
 * CONTENT, one component store down.
 *
 * Two signals, both tree-entry OID+mode:
 *  - S2 (reverted path): the candidate sets a path to a value the TARGET's own
 *    first-parent history held before the target's own change to that path. Only the
 *    target's advances the candidate's pin does not already carry count (#28557): the
 *    level's divergence base is the merge base of the candidate and target pins, and
 *    when it sits BELOW the target pin the walk is bounded at it, so a branch that
 *    deletes lines an earlier, already-shared change added is its own deliberate
 *    deletion, never a put-back. A candidate pin that CONTAINS the target pin (the
 *    measured fast-forward pin move) keeps the full window: its ancestry carries the
 *    target's change, so an interior regression against the target is the revert this
 *    guard exists to catch.
 *  - S3 (swallowed composition): a component pin the compose moved (or reused) has a
 *    tree IDENTICAL to the target's while the incoming pin's tree DIFFERS — the
 *    correction was composed away. A commit-OID difference with equal trees is NOT
 *    this signal, and a pin the target already contains is kept-ahead, not swallowed:
 *    S3 discriminates by ancestry (isAncestor), so it is not ancestry-blind.
 *
 * A deliberate revert of a target change is indistinguishable from the incident, so
 * observation is always on and refusal is opt-in (`revert-guard: refuse`). Bounds
 * that make the guard SKIP work (path cap, depth) and a merge base that is not exactly
 * one make the proof INCOMPLETE, named, and never silently clean. A search that ran to
 * its declared history window `W` is complete relative to that declaration: it is
 * recorded, and it neither makes coverage incomplete nor warns by itself (#28000).
 */
import { join } from "node:path"
import { GitExit, isAncestor, mergeBases, runnerFor, type Git } from "./git.ts"

/** One interior path the candidate put back to a value the target's own history held before its advance. */
export type RevertedPath = Readonly<{
  /** Root-relative; a nested gitlink joins its parents with `/`. */
  path: string
  mode: string
  /** What the candidate carries at the path. */
  candidate: string
  /** What the target carries at the path. */
  target: string
  /** The earlier target value the candidate restored. */
  base: string
}>

/** A component pin whose composed tree silently equals the target's while the incoming pin differs. */
export type SwallowedComposition = Readonly<{
  path: string
  /** The pin the target records. */
  target: string
  /** The pin the change asked for. */
  incoming: string
  /** The pin the compose actually left. */
  candidate: string
}>

/**
 * A named limit on the guard's proof, typed by WHAT IT COSTS (#28000).
 *
 * `unjudged` — the guard could not run its proof at all (unreadable history or trees, a base it could not pick,
 * or a declared cap that made it skip work). This is the only kind that makes `coverage` `incomplete` and the
 * only one that raises a warning on its own, because it is the only one where nobody judged the change.
 *
 * `bounded` — the guard RAN its proof and its declared search depth (`bounds.window`) ended the walk with
 * nothing found. That is the proof the guard defines, run to its own declared bound: complete relative to that
 * declaration, not a failure to judge. It is still recorded (naming the bound reached), but it never makes
 * coverage incomplete and never warns by itself — a warning that fires on every change touching an established
 * path carries no signal, and the fact it was carrying ("the search is bounded at W") is a constant of the
 * guard, not a fact about the change.
 */
export type RevertGuardGap = Readonly<{
  kind: "unjudged" | "bounded"
  path: string
  depth: number
  reason: string
}>

/** The one merge base the root tree was judged from, or why there is not exactly one. */
export type RevertGuardBase =
  | Readonly<{ state: "single"; base: string }>
  | Readonly<{ state: "ambiguous"; count: number }>
  | Readonly<{ state: "none" }>

export type RevertGuardReport = Readonly<{
  coverage: "complete" | "incomplete"
  paths: readonly RevertedPath[]
  /** `paths.length`, named separately so the durable `Reason:` fragment reads it directly. */
  count: number
  swallowed: readonly SwallowedComposition[]
  gaps: readonly RevertGuardGap[]
  base: RevertGuardBase
}>

export type RevertGuardBounds = Readonly<{
  /**
   * Interior paths WITH target history judged before the proof is named incomplete. A path the
   * target's window never touched cannot hide a revert, so it is judged clean without spending a
   * unit and without naming a gap (#28195): the cap bounds real judgments, not the path count, so an
   * add-only landing no longer reports incomplete for paths it could never hide behind.
   */
  pathCap: number
  /** Gitlink recursion depth; the root level is 0. */
  depth: number
  /** Commits of the target's first-parent history examined per path. */
  window: number
}>

export const REVERT_GUARD_BOUNDS: RevertGuardBounds = Object.freeze({ depth: 3, pathCap: 500, window: 50 })

export type RevertGuardOptions = Readonly<{
  git: Git
  /** A checkout of the FINAL candidate with its submodules materialized. */
  root: string
  targetHead: string
  head: string
  candidate: string
  bounds?: RevertGuardBounds
}>

type RawRow = Readonly<{
  oldMode: string
  newMode: string
  oldSha: string
  newSha: string
  path: string
}>

type Level = {
  readonly git: Git
  readonly dir: string
  readonly prefix: string
  readonly target: string
  readonly incoming: string
  readonly candidate: string
  readonly depth: number
  readonly bounds: RevertGuardBounds
  readonly report: {
    paths: RevertedPath[]
    swallowed: SwallowedComposition[]
    gaps: RevertGuardGap[]
  }
  readonly budget: { remaining: number }
}

const GITLINK = "160000"
const ABSENT = /^0+$/u

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Compare the FINAL candidate against the target and the incoming head, one component
 * store down, bounded and never silent. Reads only tree entries and commits.
 */
export async function detectReverted(options: RevertGuardOptions): Promise<RevertGuardReport> {
  const bounds = options.bounds ?? REVERT_GUARD_BOUNDS
  const git = runnerFor(options.git).at(options.root)
  const report: Level["report"] = { gaps: [], paths: [], swallowed: [] }
  const bases = await mergeBases(git, options.targetHead, options.head)
  const base: RevertGuardBase =
    bases.length === 1
      ? { base: bases[0] as string, state: "single" }
      : bases.length === 0
        ? { state: "none" }
        : { count: bases.length, state: "ambiguous" }
  if (base.state === "none") {
    report.gaps.push({
      kind: "unjudged",
      depth: 0,
      path: "",
      reason: "no merge base between the target and the change",
    })
  } else if (base.state === "ambiguous") {
    report.gaps.push({ kind: "unjudged", depth: 0, path: "", reason: `base: ambiguous (${String(base.count)})` })
  }
  await walk({
    budget: { remaining: bounds.pathCap },
    bounds,
    candidate: options.candidate,
    depth: 0,
    dir: options.root,
    git,
    incoming: options.head,
    prefix: "",
    report,
    target: options.targetHead,
  })
  // A base that is not exactly one cannot judge a path: the plan's rule is one
  // ambiguous-base gap with NO per-path claim, so no claim rides on an unpicked base.
  const judged = base.state === "single"
  return {
    base,
    count: judged ? report.paths.length : 0,
    coverage: report.gaps.some((gap) => gap.kind === "unjudged") ? "incomplete" : "complete",
    gaps: report.gaps,
    paths: judged ? report.paths : [],
    swallowed: judged ? report.swallowed : [],
  }
}

async function walk(level: Level): Promise<void> {
  let toCandidate: readonly RawRow[]
  let toIncoming: readonly RawRow[]
  try {
    toCandidate = await rawDiff(level.git, level.target, level.candidate)
    toIncoming = await rawDiff(level.git, level.target, level.incoming)
  } catch (error) {
    level.report.gaps.push({
      kind: "unjudged",
      depth: level.depth,
      path: level.prefix === "" ? "." : level.prefix,
      reason: `component tree unreadable: ${detail(error)}`,
    })
    return
  }
  // Every gitlink either the candidate or the incoming side moved. An unchanged side
  // keeps the target's pin, which is exactly what a missing row means.
  const links = new Map<string, { target: string; candidate: string; incoming: string }>()
  const note = (row: RawRow, side: "candidate" | "incoming"): void => {
    if (row.oldMode !== GITLINK && row.newMode !== GITLINK) return
    const found = links.get(row.path) ?? { candidate: row.oldSha, incoming: row.oldSha, target: row.oldSha }
    found[side] = row.newSha
    found.target = row.oldSha
    links.set(row.path, found)
  }
  for (const row of toCandidate) note(row, "candidate")
  for (const row of toIncoming) note(row, "incoming")

  for (const [path, pins] of links) {
    const full = level.prefix + path
    if (ABSENT.test(pins.target) || ABSENT.test(pins.incoming) || ABSENT.test(pins.candidate)) continue
    // The pins name commits in the CHILD store, never in the level that records them.
    const dir = join(level.dir, path)
    const childGit = runnerFor(level.git).at(dir)
    // S3: the composed pin keeps the target's tree while the incoming pin is a real difference.
    if (pins.candidate !== pins.target || pins.incoming !== pins.target) {
      try {
        const targetTree = await treeOf(childGit, pins.target)
        const candidateTree = await treeOf(childGit, pins.candidate)
        const incomingTree = await treeOf(childGit, pins.incoming)
        // Only a difference the target does NOT already contain is swallowed. An incoming pin
        // that is an ANCESTOR of the target pin is the ordinary `kept-ahead` case: its tree
        // differs, but the compose correctly left the newer target pin in place (measured at
        // submit on 2026-10-04: km/ag/vendor/terminfo.dev are behind every stale-base branch).
        const incomingBehind = await isAncestor(childGit, pins.incoming, pins.target)
        if (!incomingBehind && candidateTree === targetTree && incomingTree !== targetTree) {
          level.report.swallowed.push({
            candidate: pins.candidate,
            incoming: pins.incoming,
            path: full,
            target: pins.target,
          })
        }
      } catch (error) {
        level.report.gaps.push({
          kind: "unjudged",
          depth: level.depth,
          path: full,
          reason: `component trees unreadable: ${detail(error)}`,
        })
      }
    }
    // S2: only a pin the candidate actually moved can restore interior content.
    if (pins.candidate === pins.target) continue
    if (level.depth + 1 > level.bounds.depth) {
      level.report.gaps.push({
        kind: "unjudged",
        depth: level.depth + 1,
        path: full,
        reason: `depth cap D=${String(level.bounds.depth)}`,
      })
      continue
    }
    await walk({
      ...level,
      candidate: pins.candidate,
      depth: level.depth + 1,
      dir,
      git: childGit,
      incoming: pins.incoming,
      prefix: `${full}/`,
      target: pins.target,
    })
  }

  // #28557: the target advances that count are the ones the candidate pin does not already carry. The
  // base is read only when a real path row needs it, so a pin-only compose pays no extra git call.
  const judged = toCandidate.filter(
    (row) =>
      row.oldMode !== GITLINK && row.newMode !== GITLINK && !(row.newSha === row.oldSha && row.newMode === row.oldMode),
  )
  const base = judged.length === 0 ? undefined : await advanceBase(level)
  const touched =
    judged.length === 0
      ? undefined
      : await touchedPaths(
          level,
          base,
          judged.map((row) => row.path),
        )
  for (const row of judged) await assessPath(level, row, base, touched)
}

/**
 * The paths the target's first-parent range touched, in ONE traversal per level (#28195).
 *
 * `firstParentTouching` per path is `rev-list --first-parent --max-count=W <revision> -- <path>`, so
 * for a path the range never moved git scans the WHOLE range to find nothing — before this, one such
 * walk ran per changed path up to the cap. One `log --first-parent --name-only` over the SAME
 * revision range answers "touched or not" for every changed path at once, so an untouched path costs
 * nothing and only a touched path takes the per-path walk under P_max. `-m` adds each merge's
 * first-parent diff, so the set is a superset of what that per-path walk can report: only membership
 * is proved here, never absence-by-omission. A failed traversal is a named `unjudged` gap and returns
 * undefined, so every path falls back to the per-path walk under the cap — never a silent widening of
 * the proof.
 */
async function touchedPaths(
  level: Level,
  base: string | undefined,
  paths: readonly string[],
): Promise<ReadonlySet<string> | undefined> {
  const revision = base === undefined ? level.target : `${base}..${level.target}`
  // The traversal is limited to the level's judged paths, fed on stdin so a compose with thousands of
  // changed paths never hits an argv limit and `--literal-pathspecs` keeps every path byte a name
  // rather than a pattern (a `*` or a leading `:` in a filename is a name, not a glob). `--no-renames`
  // is load-bearing: with rename detection a target that renamed a path away lists only the NEW name,
  // so a candidate that restores the OLD path's blob is wrongly called untouched and skipped (#28195).
  const input = [revision, "--", ...paths].join("\n") + "\n"
  let out: string
  try {
    out = await level.git(
      [
        "--literal-pathspecs",
        "log",
        "--first-parent",
        "-m",
        "--name-only",
        "--no-renames",
        "--format=",
        "-z",
        "--stdin",
      ],
      input,
    )
  } catch (error) {
    level.report.gaps.push({
      kind: "unjudged",
      depth: level.depth,
      path: level.prefix === "" ? "." : level.prefix,
      reason: `target first-parent range unreadable: ${detail(error)}`,
    })
    // silent-fallback-allow: the unreadable range was just recorded as a named unjudged gap; undefined keeps
    // every path on the per-path walk under the cap, the conservative proof, never a silent narrowing.
    return undefined
  }
  // `-z` names arrive verbatim, so only empty fields (and a leading newline git may emit) are dropped.
  // A `trimEnd()` here would shorten a path that legitimately ends in a space and the lookup would
  // miss it in silence (#28195).
  return new Set(
    out
      .split("\0")
      .map((row) => row.replace(/^\n+/u, ""))
      .filter((row) => row !== ""),
  )
}

/**
 * The level's divergence base, or undefined when the whole window must be judged (#28557).
 *
 * `mergeBases(target, candidate)`: a single base BELOW the target pin means the candidate pin
 * diverged and never carried the target's later advance, so only advances after the base count.
 * A base that IS the target pin means the candidate pin contains the target pin — the 27363
 * fast-forward pin move — and the full window stays. An unreadable base is a named `unjudged`
 * gap, never a silent widening or narrowing of the proof.
 */
async function advanceBase(level: Level): Promise<string | undefined> {
  try {
    const bases = await mergeBases(level.git, level.target, level.candidate)
    return bases.length === 1 && bases[0] !== level.target ? bases[0] : undefined
  } catch (error) {
    level.report.gaps.push({
      kind: "unjudged",
      depth: level.depth,
      path: level.prefix === "" ? "." : level.prefix,
      reason: `candidate/target base unreadable: ${detail(error)}`,
    })
    // silent-fallback-allow: the unreadable base was just recorded as a named unjudged gap; undefined keeps the
    // whole window under judgment, the conservative proof, rather than narrowing it.
    return undefined
  }
}

async function assessPath(
  level: Level,
  row: RawRow,
  base: string | undefined,
  touched: ReadonlySet<string> | undefined,
): Promise<void> {
  const full = level.prefix + row.path
  // #28195: only a path the target's first-parent range touched can hold a value the target put
  // back. `touched` is that set, computed in ONE traversal per level (touchedPaths); a path absent
  // from it cannot hide a revert, so it spends no P_max unit, names no gap and takes no per-path
  // walk — the cap keeps bounding real judgments and an add-only landing stays cheap. When the
  // traversal failed, `touched` is undefined: every path falls back to the per-path walk under the
  // cap (the conservative proof), with the failure already named as a gap.
  if (touched !== undefined && !touched.has(row.path)) return
  if (level.budget.remaining <= 0) {
    level.report.gaps.push({
      kind: "unjudged",
      depth: level.depth,
      path: full,
      reason: `path cap P_max=${String(level.bounds.pathCap)}`,
    })
    return
  }
  level.budget.remaining -= 1
  let viewed: readonly string[]
  try {
    viewed = await firstParentTouching(
      level.git,
      base === undefined ? level.target : `${base}..${level.target}`,
      level.bounds.window + 1,
      row.path,
    )
  } catch (error) {
    level.report.gaps.push({
      kind: "unjudged",
      depth: level.depth,
      path: full,
      reason: `target history unreadable: ${detail(error)}`,
    })
    return
  }
  // One extra commit was requested, so an exhausted window is observable below.
  const capped = viewed.length > level.bounds.window
  for (const commit of viewed.slice(0, level.bounds.window)) {
    const previous = await entryAt(level.git, `${commit}^`, row.path)
    if (previous === undefined) continue
    // OID+mode, matching the entry contract: a mode-only put-back is the same revert.
    if (previous.oid === row.newSha && previous.mode === row.newMode) {
      level.report.paths.push({
        base: previous.oid,
        candidate: row.newSha,
        mode: row.newMode,
        path: full,
        target: row.oldSha,
      })
      return
    }
  }
  // A capped NEGATIVE proof is not a clean one: name it so refusal fails closed.
  if (capped) {
    level.report.gaps.push({
      kind: "bounded",
      depth: level.depth,
      path: full,
      reason: "target history window W=" + String(level.bounds.window) + " exhausted",
    })
  }
}

async function rawDiff(git: Git, from: string, to: string): Promise<readonly RawRow[]> {
  return parseRaw(await git(["diff-tree", "-r", "-z", "--no-renames", from, to]))
}

/** `git diff` prints `:<old mode> <new mode> <old sha> <new sha> <status>\0<path>\0`. */
function parseRaw(out: string): readonly RawRow[] {
  const fields = out.split("\0")
  const rows: RawRow[] = []
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const header = (fields[at] ?? "").split(" ")
    const oldMode = header[0]?.replace(/^:/u, "")
    const newMode = header[1]
    const oldSha = header[2]
    const newSha = header[3]
    const path = fields[at + 1]
    if (oldMode === undefined || newMode === undefined || oldSha === undefined || newSha === undefined) continue
    if (oldMode === "" || path === undefined || path === "") continue
    rows.push({ newMode, newSha, oldMode, oldSha, path })
  }
  return rows
}

async function treeOf(git: Git, commit: string): Promise<string> {
  const out = (await git(["rev-parse", "--verify", `${commit}^{tree}`])).trim()
  if (out === "") throw new Error(`git rev-parse returned an empty tree for ${commit}`)
  return out
}

async function entryAt(
  git: Git,
  commit: string,
  path: string,
): Promise<Readonly<{ mode: string; oid: string }> | undefined> {
  let out: string
  try {
    out = await git(["ls-tree", "-z", commit, "--", path])
  } catch (error) {
    // A root commit has no `^`; an absent object is "no previous value", not a failure.
    if (error instanceof GitExit && error.exitCode === 128) return undefined
    throw error
  }
  const first = out.split("\0")[0] ?? ""
  if (first === "") return undefined
  const [header] = first.split("\t")
  const parts = (header ?? "").split(" ")
  const mode = parts[0]
  const oid = parts[2]
  if (mode === undefined || mode === "" || oid === undefined || oid === "") return undefined
  return { mode, oid }
}

async function firstParentTouching(
  git: Git,
  revision: string,
  window: number,
  path: string,
): Promise<readonly string[]> {
  const out = await git(["rev-list", "--first-parent", `--max-count=${String(window)}`, revision, "--", path])
  return out
    .split("\n")
    .map((row) => row.trim())
    .filter((row) => row !== "")
}

/**
 * Exact counts by kind for one report, computed BEFORE any cap (#28195). The durable
 * `reverted-paths` reason stores these beside its capped path and gap lists, so a listing can
 * state the whole finding without counting the reason’s prose back up.
 */
export type RevertedPathsCounts = Readonly<{
  /** Paths the candidate put back to a value the target’s history held before its own advance. */
  reverted: number
  /** Component pins the compose left equal to the target’s while the incoming pin differed. */
  swallowed: number
  /** Every named limit on the proof, both kinds. */
  gaps: number
  /** The `unjudged` gaps: the guard could not run its proof at all. */
  unjudged: number
  /** The `bounded` gaps: the proof ran to its declared window and found nothing. */
  bounded: number
}>

/** How many paths and gaps the reason’s payload stores; the counts above are never capped. */
export const REVERTED_PATHS_PAYLOAD_CAP = 32

/** Exact counts by kind, read from the report itself and never from its rendering. */
export function revertedPathsCounts(report: RevertGuardReport): RevertedPathsCounts {
  const ofKind = (want: RevertGuardGap["kind"]): number => report.gaps.filter((gap) => gap.kind === want).length
  return Object.freeze({
    reverted: report.paths.length,
    swallowed: report.swallowed.length,
    gaps: report.gaps.length,
    unjudged: ofKind("unjudged"),
    bounded: ofKind("bounded"),
  })
}

/**
 * The durable-warning finding for a report, or undefined when there is nothing to say.
 * A `complete` report with no hit is the ONLY silent case, and a report is `complete` when
 * every gap is `bounded` (#28000) — so a search that reached its declared window `W` warns
 * nobody, which is what makes the warning mean "nobody could judge this change". A hit, or
 * any `unjudged` gap (unreadable tree/history, an unpicked base, a cap that skipped work),
 * always names itself.
 */
export function revertedPathsFinding(report: RevertGuardReport | undefined):
  | Readonly<{
      reason: string
      count: number
      counts: RevertedPathsCounts
      coverage: "complete" | "incomplete"
    }>
  | undefined {
  if (report === undefined) return undefined
  const hit = report.paths.length > 0 || report.swallowed.length > 0
  if (!hit && report.coverage === "complete") return undefined
  return {
    coverage: report.coverage,
    count: report.paths.length,
    counts: revertedPathsCounts(report),
    reason: revertedPathsReason(report),
  }
}

/** A compact, machine-readable `Reason:` for the durable `reverted-paths` warning. */
export function revertedPathsReason(report: RevertGuardReport): string {
  const paths = [...report.paths.map((row) => row.path), ...report.swallowed.map((row) => row.path)]
  const gaps = report.gaps.slice(0, REVERTED_PATHS_PAYLOAD_CAP).map((gap) => ({
    kind: gap.kind,
    depth: gap.depth,
    reason: gap.reason,
    ...(gap.path === "" ? {} : { path: gap.path }),
  }))
  const payload = JSON.stringify({
    count: report.paths.length,
    counts: revertedPathsCounts(report),
    coverage: report.coverage,
    paths: report.paths.slice(0, REVERTED_PATHS_PAYLOAD_CAP).map((row) => row.path),
    swallowed: report.swallowed.slice(0, REVERTED_PATHS_PAYLOAD_CAP).map((row) => row.path),
    ...(gaps.length === 0 ? {} : { gaps }),
    ...(report.base.state === "single" ? {} : { base: report.base.state }),
  })
  const named = paths.slice(0, 8).join(", ")
  const gapText =
    report.gaps.length === 0
      ? ""
      : `; gaps: ${report.gaps
          .map((gap) => (gap.path === "" ? gap.reason : `${gap.reason} [${gap.path}@d${String(gap.depth)}]`))
          .join(", ")}`
  return `${String(paths.length)} reverted/swallowed path(s)${named === "" ? "" : `: ${named}`}; ${payload}${gapText}`
}

/**
 * What a stored `reverted-paths` reason says, read from its structured payload alone (#28195).
 * The prose around the payload — the leading count sentence and the trailing gap text — is never
 * parsed: the payload is the writer’s own record, and a reader that counted gap prose back up
 * would be a second derivation that breaks the day the prose is reworded. `undefined` means the
 * string carries no such payload at all.
 */
export type RevertedPathsNotice = Readonly<{
  /** Exact counts by kind, present only when the row was written by a build that recorded them. */
  counts?: RevertedPathsCounts
  /** The writer’s verdict for the change, as the payload records it. */
  coverage: "complete" | "incomplete"
  /** Gaps the payload stores, which its own writer capped at {@link REVERTED_PATHS_PAYLOAD_CAP}. */
  gapsStored: number
  /** The stored gap list reached the cap, so the true total is `gapsStored` or more. */
  truncated: boolean
}>

/** The payload’s opening bytes: the writer emits `count` first, so nothing precedes the object. */
const REVERTED_PATHS_PAYLOAD = '{"count":'

export function revertedPathsNotice(reason: string): RevertedPathsNotice | undefined {
  const start = reason.indexOf(REVERTED_PATHS_PAYLOAD)
  if (start === -1) return undefined
  const body = jsonObjectAt(reason, start)
  if (body === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    // silent-fallback-allow: a payload this reader cannot parse is reported as no payload at all,
    // and every caller then says the counts were not recorded rather than showing a guessed number.
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const fields = parsed as Record<string, unknown>
  const coverage = fields["coverage"]
  if (coverage !== "complete" && coverage !== "incomplete") return undefined
  const gaps = fields["gaps"]
  const gapsStored = Array.isArray(gaps) ? gaps.length : 0
  const counts = countsOf(fields["counts"])
  return {
    ...(counts === undefined ? {} : { counts }),
    coverage,
    gapsStored,
    truncated: gapsStored >= REVERTED_PATHS_PAYLOAD_CAP,
  }
}

/** The balanced `{...}` starting at `start`, with quoted strings and escapes respected. */
function jsonObjectAt(text: string, start: number): string | undefined {
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === "{") depth += 1
    else if (char === "}") {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  // silent-fallback-allow: an unterminated object is not a payload; the caller says the counts
  // were not recorded, which is the same word it uses for a row with no payload at all.
  return undefined
}

/** A `counts` member, or undefined when it is absent or is not five whole non-negative numbers. */
function countsOf(value: unknown): RevertedPathsCounts | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const { reverted, swallowed, gaps, unjudged, bounded } = value as Record<string, unknown>
  const each = [reverted, swallowed, gaps, unjudged, bounded]
  if (each.some((held) => typeof held !== "number" || !Number.isSafeInteger(held) || held < 0)) return undefined
  return Object.freeze({
    reverted: reverted as number,
    swallowed: swallowed as number,
    gaps: gaps as number,
    unjudged: unjudged as number,
    bounded: bounded as number,
  })
}

/** What the guard asks of a compose: nothing, a durable warning, or the named stick before CAS. */
export type RevertGuardAction = "clean" | "warn" | "stick"

/**
 * The policy table, in one place. A hit or an incomplete/ambiguous proof always warns; an
 * explicit `refuse` turns the same evidence into a stick. A complete, hit-free report is the
 * only "clean", so a skipped proof is never silently allowed.
 */
export function revertGuardAction(
  report: RevertGuardReport | undefined,
  mode: "observe" | "refuse",
): RevertGuardAction {
  const finding = revertedPathsFinding(report)
  if (finding !== undefined) return mode === "refuse" ? "stick" : "warn"
  // #28000: a search that only reached its declared window does not WARN — a warning that fires on every change
  // touching an established path carries no signal, so `observe` must mean "nobody could judge this change".
  // Refusal never loosens for it, though: a bounded search can hide a revert (the window-cap regression test
  // demonstrates exactly that), so `refuse` still sticks when any gap — bounded or unjudged — is on the report.
  if (mode === "refuse" && report?.gaps.some((gap) => gap.kind === "bounded")) return "stick"
  return "clean"
}
