// Batch compatibility precheck: which queued PRs may share ONE batch.
//
// Two PRs are batch-compatible iff they touch no REAL (non-generated)
// path in common. Path overlap is the deliberately conservative, cheap superset
// of textual conflict — a `merge-tree --write-tree` candidate-manufacture check
// belongs to the composer stage, NOT here. Generated paths are factored out
// because a batch regenerates them ONCE, so two members both touching e.g. a
// lockfile is not a conflict.
//
// `overlap` is pure set logic (zero git); `composeBatch` folds queued targets in
// queue order against an incremental REAL-path union (pairwise disjointness is
// exactly disjoint-from-union for sets, so the fold is both the efficient and
// the correct form — first-come-wins). The one git read, `changedPaths`, lives
// in ./layers/git.ts.

import { changedPaths } from "./layers/git.ts"

/** The overlap between two changed-path sets, generated paths factored out. */
export interface Overlap {
  /** Paths touched by BOTH sides that are NOT generated — the conflict evidence. */
  readonly real: string[]
  /** True iff the sides DID overlap but ONLY on generated paths (safe to co-batch;
   *  the composer surfaces this to teach `queue.regen-paths` configuration). */
  readonly generatedOnly: boolean
}

/** A queued target held back from the current batch — it stays queued for the
 *  NEXT one (never `rejected`; rejection is a terminal changeset state). */
export interface SkippedTarget {
  readonly target: string
  readonly reason: "path-overlap" | "batch-full"
  /** For `path-overlap`: an already-accepted member it collides with (`""` for
   *  `batch-full`). */
  readonly overlapWith: string
  /** For `path-overlap`: the real overlapping paths (skip-detail evidence). */
  readonly paths: string[]
}

export interface BatchResult {
  /** Targets accepted into the batch, in queue order. */
  readonly members: string[]
  /** Targets held back, in queue order, each with its reason. */
  readonly skipped: SkippedTarget[]
}

/** Pure overlap of two changed-path sets with generated paths excluded. Zero git;
 *  fixture-tested with plain arrays. */
export function overlap(
  pathsA: ReadonlySet<string>,
  pathsB: ReadonlySet<string>,
  generatedGlobs: readonly string[],
): Overlap {
  const shared: string[] = []
  for (const p of pathsA) if (pathsB.has(p)) shared.push(p)
  const real = shared.filter((p) => !isGenerated(p, generatedGlobs))
  return { real, generatedOnly: shared.length > 0 && real.length === 0 }
}

/**
 * Fold `targets` (queue order) into ONE batch: a target joins iff its changed
 * paths share no REAL path with any already-accepted member; generated-path
 * overlap never blocks. `max` caps the batch — over-cap targets are skipped
 * (`batch-full`) and stay queued. One `changedPaths` git read per target.
 */
export async function composeBatch(
  repo: string,
  base: string,
  targets: readonly string[],
  opts: { generatedGlobs: readonly string[]; max?: number },
): Promise<BatchResult> {
  const members: string[] = []
  const skipped: SkippedTarget[] = []
  const union = new Set<string>() // REAL paths owned by accepted members
  const owner = new Map<string, string>() // real path -> the member that contributed it

  for (const target of targets) {
    if (opts.max !== undefined && members.length >= opts.max) {
      skipped.push({ target, reason: "batch-full", overlapWith: "", paths: [] })
      continue
    }
    const paths = new Set(await changedPaths(repo, base, target))
    const ov = overlap(paths, union, opts.generatedGlobs)
    if (ov.real.length > 0) {
      skipped.push({
        target,
        reason: "path-overlap",
        overlapWith: owner.get(ov.real[0]!) ?? "",
        paths: ov.real,
      })
      continue
    }
    members.push(target)
    for (const p of paths) {
      if (!isGenerated(p, opts.generatedGlobs)) {
        union.add(p)
        if (!owner.has(p)) owner.set(p, target)
      }
    }
  }
  return { members, skipped }
}

/** Does `path` match any generated glob? Empty globs => nothing is generated. */
function isGenerated(path: string, globs: readonly string[]): boolean {
  for (const g of globs) if (globToRegExp(g).test(path)) return true
  return false
}

const globCache = new Map<string, RegExp>()

/**
 * Minimal, portable glob → RegExp (works identically under Bun and Node — no
 * `Bun.Glob` dependency). Full-path, anchored match: `**` spans path segments
 * (including none), `*` and `?` stay within one segment, every other regex
 * metachar is escaped. Match a lockfile at any depth with `**` + `*.lock`.
 */
function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob)
  if (cached) return cached
  let re = "^"
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++
        if (glob[i + 1] === "/") {
          re += "(?:.*/)?" // `**/` — zero or more leading segments
          i++
        } else {
          re += ".*" // bare `**` — anything, including `/`
        }
      } else {
        re += "[^/]*" // `*` — within a single segment
      }
    } else if (c === "?") {
      re += "[^/]"
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    }
  }
  re += "$"
  const compiled = new RegExp(re)
  globCache.set(glob, compiled)
  return compiled
}
