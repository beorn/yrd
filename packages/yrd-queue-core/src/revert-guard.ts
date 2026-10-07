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
 *    first-parent history held before the target's own change to that path.
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
  /** Interior paths examined before the proof is named incomplete. */
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

  for (const row of toCandidate) {
    if (row.oldMode === GITLINK || row.newMode === GITLINK) continue
    if (row.newSha === row.oldSha && row.newMode === row.oldMode) continue
    await assessPath(level, row)
  }
}

async function assessPath(level: Level, row: RawRow): Promise<void> {
  const full = level.prefix + row.path
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
    viewed = await firstParentTouching(level.git, level.target, level.bounds.window + 1, row.path)
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

async function firstParentTouching(git: Git, target: string, window: number, path: string): Promise<readonly string[]> {
  const out = await git(["rev-list", "--first-parent", `--max-count=${String(window)}`, target, "--", path])
  return out
    .split("\n")
    .map((row) => row.trim())
    .filter((row) => row !== "")
}

/**
 * The durable-warning finding for a report, or undefined when there is nothing to say.
 * A `complete` report with no hit is the ONLY silent case, and a report is `complete` when
 * every gap is `bounded` (#28000) — so a search that reached its declared window `W` warns
 * nobody, which is what makes the warning mean "nobody could judge this change". A hit, or
 * any `unjudged` gap (unreadable tree/history, an unpicked base, a cap that skipped work),
 * always names itself.
 */
export function revertedPathsFinding(
  report: RevertGuardReport | undefined,
): Readonly<{ reason: string; count: number; coverage: "complete" | "incomplete" }> | undefined {
  if (report === undefined) return undefined
  const hit = report.paths.length > 0 || report.swallowed.length > 0
  if (!hit && report.coverage === "complete") return undefined
  return { coverage: report.coverage, count: report.paths.length, reason: revertedPathsReason(report) }
}

/** A compact, machine-readable `Reason:` for the durable `reverted-paths` warning. */
export function revertedPathsReason(report: RevertGuardReport): string {
  const paths = [...report.paths.map((row) => row.path), ...report.swallowed.map((row) => row.path)]
  const gaps = report.gaps.slice(0, 32).map((gap) => ({
    kind: gap.kind,
    depth: gap.depth,
    reason: gap.reason,
    ...(gap.path === "" ? {} : { path: gap.path }),
  }))
  const payload = JSON.stringify({
    count: report.paths.length,
    coverage: report.coverage,
    paths: report.paths.slice(0, 32).map((row) => row.path),
    swallowed: report.swallowed.slice(0, 32).map((row) => row.path),
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
