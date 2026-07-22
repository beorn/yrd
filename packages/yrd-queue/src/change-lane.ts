export type QueueLane = "pm" | "sw"

export type GitDiffStatus = "A" | "D" | "M" | "R" | "T"

/** One normalized `git diff --raw` entry. Modes stay strings so malformed Git
 * evidence reaches the fail-loud runtime boundary instead of being erased by a
 * TypeScript-only assumption. */
export type GitDiffEntry = Readonly<{
  status: GitDiffStatus
  path: string
  oldPath?: string
  oldMode: string
  newMode: string
}>

/** Data-owned PM path boundary shared by admission, write-time hygiene, and
 * state-repository promotion. Exact files are explicit exceptions; prefix
 * matches still require one of the declared documentation extensions. */
export type PmPathPolicy = Readonly<{
  exact: readonly string[]
  prefixes: readonly string[]
  extensions: readonly string[]
}>

/**
 * Derive a Queue lane from immutable Git diff facts. Callers supply evidence,
 * never a lane: every entry is validated before classification so a known SW
 * path cannot mask malformed evidence later in the diff.
 */
export function classifyQueueLane(entries: readonly GitDiffEntry[], policy: PmPathPolicy): QueueLane {
  if (entries.length === 0) refuseLane("empty Git diff")
  validatePmPathPolicy(policy)
  for (const entry of entries) validateEntry(entry)
  return entries.every((entry) => isPmEntry(entry, policy)) ? "pm" : "sw"
}

/** Shared path predicate. The concrete boundary is caller-owned data. */
export function isPmPath(path: string, policy: PmPathPolicy): boolean {
  validatePath(path)
  validatePmPathPolicy(policy)
  return matchesPmPath(path, policy)
}

/** Validate policy data once at every public predicate boundary. */
export function validatePmPathPolicy(policy: PmPathPolicy): void {
  if (policy.exact.length === 0 && policy.prefixes.length === 0) refuseLane("PM path policy matches no paths")
  if (policy.prefixes.length > 0 && policy.extensions.length === 0) {
    refuseLane("PM path policy has prefixes but no documentation extensions")
  }
  for (const [name, values] of [
    ["exact", policy.exact],
    ["prefix", policy.prefixes],
    ["extension", policy.extensions],
  ] as const) {
    const repeated = duplicates(values)
    if (repeated.length > 0) refuseLane(`PM path policy repeats ${name} '${repeated[0]}'`)
  }
  for (const path of policy.exact) validatePath(path)
  for (const prefix of policy.prefixes) {
    const normalized = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix
    if (normalized === "") refuseLane("PM path policy contains an empty prefix")
    validatePath(normalized)
  }
  for (const suffix of policy.extensions) {
    if (!/^\.[a-z0-9][a-z0-9.+-]*$/u.test(suffix)) {
      refuseLane(`PM path policy has invalid extension '${suffix}'`)
    }
  }
}

const MISSING_MODE = "000000"
const REGULAR_MODE = "100644"
const GITLINK_MODE = "160000"
const KNOWN_MODES: ReadonlySet<string> = new Set([MISSING_MODE, REGULAR_MODE, "100755", "120000", GITLINK_MODE])
const KNOWN_STATUSES: ReadonlySet<string> = new Set<GitDiffStatus>(["A", "D", "M", "R", "T"])

function refuseLane(detail: string): never {
  throw new Error(`yrd: queue lane classification refused: ${detail}`)
}

function validatePath(path: string): void {
  if (path === "" || path.startsWith("/") || /[\u0000-\u001f\u007f]/u.test(path)) {
    refuseLane(`invalid Git path ${JSON.stringify(path)}`)
  }
  const segments = path.split("/")
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    refuseLane(`non-normalized Git path ${JSON.stringify(path)}`)
  }
}

function validateModes(entry: GitDiffEntry): void {
  for (const mode of [entry.oldMode, entry.newMode]) {
    if (!KNOWN_MODES.has(mode)) refuseLane(`unsupported Git mode '${mode}' for '${entry.path}'`)
  }
  const oldMissing = entry.oldMode === MISSING_MODE
  const newMissing = entry.newMode === MISSING_MODE
  if (
    (entry.status === "A" && (!oldMissing || newMissing)) ||
    (entry.status === "D" && (oldMissing || !newMissing)) ||
    ((entry.status === "M" || entry.status === "R" || entry.status === "T") && (oldMissing || newMissing)) ||
    (entry.status === "T" && entry.oldMode === entry.newMode)
  ) {
    refuseLane(
      `Git status '${entry.status}' conflicts with modes ${entry.oldMode}->${entry.newMode} for '${entry.path}'`,
    )
  }
}

function validateEntry(entry: GitDiffEntry): void {
  if (!KNOWN_STATUSES.has(entry.status)) refuseLane(`unsupported Git diff status '${String(entry.status)}'`)
  validatePath(entry.path)
  if (entry.status === "R") {
    if (entry.oldPath === undefined) refuseLane(`rename to '${entry.path}' has no old path`)
    validatePath(entry.oldPath)
    if (entry.oldPath === entry.path) refuseLane(`rename repeats path '${entry.path}'`)
  } else if (entry.oldPath !== undefined) {
    refuseLane(`Git status '${entry.status}' unexpectedly carries old path '${entry.oldPath}'`)
  }
  validateModes(entry)
}

function extension(path: string): string {
  const leaf = path.slice(path.lastIndexOf("/") + 1)
  const dot = leaf.lastIndexOf(".")
  return dot < 0 ? "" : leaf.slice(dot).toLowerCase()
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) repeated.add(value)
    seen.add(value)
  }
  return [...repeated]
}

function matchesPmPath(path: string, policy: PmPathPolicy): boolean {
  if (policy.exact.includes(path)) return true
  const suffix = extension(path)
  return policy.extensions.includes(suffix) && policy.prefixes.some((prefix) => path.startsWith(prefix))
}

function isPmEntry(entry: GitDiffEntry, policy: PmPathPolicy): boolean {
  if (entry.oldMode === GITLINK_MODE || entry.newMode === GITLINK_MODE) return false
  if (entry.status === "R") {
    return (
      entry.oldMode === REGULAR_MODE &&
      entry.newMode === REGULAR_MODE &&
      entry.oldPath !== undefined &&
      matchesPmPath(entry.oldPath, policy) &&
      matchesPmPath(entry.path, policy)
    )
  }
  if (!matchesPmPath(entry.path, policy)) return false
  if (entry.status === "A") return entry.newMode === REGULAR_MODE
  if (entry.status === "D") return entry.oldMode === REGULAR_MODE
  if (entry.status === "M") return entry.oldMode === REGULAR_MODE && entry.newMode === REGULAR_MODE
  return false
}
