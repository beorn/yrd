import { lstat, readFile, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"

export type StatePathKind = "missing" | "file" | "directory" | "symlink" | "other"

/** Read-only filesystem boundary used while deciding whether Yrd may start. */
export type StateLayoutFileSystem = Readonly<{
  kind(path: string): Promise<StatePathKind>
  readDir(path: string): Promise<readonly string[]>
  readText(path: string): Promise<string>
}>

export type LegacyStateLocation = Readonly<{
  path: string
  source: string
}>

export type StateEventFormat = "none" | "empty" | "current" | "legacy" | "mixed" | "unknown" | "corrupt"
export type StateLocationKind = "absent" | "current" | "legacy" | "mixed" | "unknown" | "corrupt"
export type StateLayoutKind = StateLocationKind

export type StateLayoutFinding = Readonly<{
  code: string
  path: string
  message: string
  marker?: string
  line?: number
}>

export type StateLocationInspection = Readonly<{
  path: string
  roles: readonly ("current" | "legacy-candidate")[]
  sources: readonly string[]
  kind: StateLocationKind
  markers: readonly string[]
  eventFormat: StateEventFormat
  findings: readonly StateLayoutFinding[]
}>

export type StateLayoutDecision =
  | Readonly<{
      action: "initialize"
      mayStart: true
      mayCreate: true
      diagnostic: string
    }>
  | Readonly<{
      action: "open-current"
      mayStart: true
      mayCreate: false
      diagnostic: string
    }>
  | Readonly<{
      action: "refuse"
      mayStart: false
      mayCreate: false
      diagnostic: string
    }>

export type StateLayoutClassification = Readonly<{
  kind: StateLayoutKind
  currentDir: string
  locations: readonly StateLocationInspection[]
  findings: readonly StateLayoutFinding[]
  decision: StateLayoutDecision
}>

export type ClassifyStateLayoutOptions = Readonly<{
  gitDir: string
  legacyLocations?: readonly LegacyStateLocation[]
  fs?: StateLayoutFileSystem
}>

type MutableLocation = {
  path: string
  current: boolean
  legacySources: Set<string>
}

type MarkerEvidence = {
  current: boolean
  legacy: boolean
  currentAnchor: boolean
  legacyAnchor: boolean
  support: boolean
  unknown: boolean
}

type EventInspection = Readonly<{
  format: StateEventFormat
  findings: readonly StateLayoutFinding[]
}>

const FILE_MARKERS = new Set([
  "events.jsonl",
  "journal.jsonl",
  "index.sqlite",
  "index.sqlite-wal",
  "index.sqlite-shm",
  "writer.lock",
  "bay.db",
  "bay.db-wal",
  "bay.db-shm",
  "bay.db-journal",
  "inbox.jsonl",
])

const DIRECTORY_MARKERS = new Set([
  "repo.git",
  "submissions.git",
  "prs.git",
  "artifacts",
  "contests",
  "worktrees",
  "receiver-inbox",
  "receiver-init",
])

const LEGACY_ONLY_MARKERS = new Set([
  "journal.jsonl",
  "bay.db",
  "bay.db-wal",
  "bay.db-shm",
  "bay.db-journal",
  "repo.git",
  "submissions.git",
  "inbox.jsonl",
])

const SHARED_ANCHORS = new Set(["index.sqlite", "prs.git"])
const SHARED_SUPPORT = new Set([
  "index.sqlite-wal",
  "index.sqlite-shm",
  "writer.lock",
  "artifacts",
  "contests",
  "worktrees",
])

const CURRENT_ONLY_MARKERS = new Set(["receiver-inbox", "receiver-init"])

function pathKind(info: Awaited<ReturnType<typeof lstat>>): StatePathKind {
  if (info.isSymbolicLink()) return "symlink"
  if (info.isFile()) return "file"
  if (info.isDirectory()) return "directory"
  return "other"
}

function isMissingError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false
  return error.code === "ENOENT" || error.code === "ENOTDIR"
}

/** Default production adapter. It deliberately exposes no write operation. */
export const nodeStateLayoutFileSystem: StateLayoutFileSystem = {
  async kind(path) {
    try {
      return pathKind(await lstat(path))
    } catch (error) {
      if (isMissingError(error)) return "missing"
      throw error
    }
  },
  readDir(path) {
    return readdir(path)
  },
  readText(path) {
    return readFile(path, "utf8")
  },
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function currentEvent(value: unknown): boolean {
  if (!record(value) || !record(value.cause)) return false
  return (
    typeof value.id === "string" &&
    typeof value.ts === "string" &&
    typeof value.name === "string" &&
    "data" in value &&
    typeof value.cause.commandId === "string" &&
    typeof value.cause.op === "string"
  )
}

function legacyEvent(value: unknown): boolean {
  if (!record(value) || typeof value.ts !== "string") return false
  if (typeof value.type === "string") return true
  if (!record(value.cause)) return false
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    "data" in value &&
    typeof value.cause.commandId === "string" &&
    !("op" in value.cause)
  )
}

function inspectEvents(path: string, text: string): EventInspection {
  let sawCurrent = false
  let sawLegacy = false
  let sawUnknown = false
  let sawRow = false
  const findings: StateLayoutFinding[] = []
  const lines = text.split(/\r?\n/u)

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line === undefined || line.trim() === "") continue
    sawRow = true
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      findings.push({
        code: "corrupt-event-json",
        path,
        marker: "events.jsonl",
        line: index + 1,
        message: `Invalid JSON in ${path} at line ${index + 1}; preserve the file and repair or migrate it before starting Yrd.`,
      })
      return { format: "corrupt", findings }
    }

    if (currentEvent(parsed)) sawCurrent = true
    else if (legacyEvent(parsed)) sawLegacy = true
    else {
      sawUnknown = true
      findings.push({
        code: "unknown-event-envelope",
        path,
        marker: "events.jsonl",
        line: index + 1,
        message: `Unrecognized event envelope in ${path} at line ${index + 1}; Yrd will not guess its generation.`,
      })
    }
  }

  if (!sawRow) return { format: "empty", findings }
  if (sawUnknown && (sawCurrent || sawLegacy)) return { format: "corrupt", findings }
  if (sawUnknown) return { format: "unknown", findings }
  if (sawCurrent && sawLegacy) {
    findings.push({
      code: "mixed-event-generations",
      path,
      marker: "events.jsonl",
      message: `${path} contains both current Yrd and legacy GitBay event envelopes; preserve it and perform an explicit migration.`,
    })
    return { format: "mixed", findings }
  }
  return { format: sawCurrent ? "current" : "legacy", findings }
}

function isLegacyBackup(name: string): boolean {
  return /^(?:events|journal)\.v[^/]*\.jsonl$/u.test(name)
}

function isLegacyInbox(name: string): boolean {
  return name.startsWith("inbox.jsonl.processing")
}

function expectedKind(name: string): "file" | "directory" | undefined {
  if (FILE_MARKERS.has(name) || isLegacyBackup(name) || isLegacyInbox(name)) return "file"
  if (DIRECTORY_MARKERS.has(name)) return "directory"
  return undefined
}

function locationRoles(location: MutableLocation): readonly ("current" | "legacy-candidate")[] {
  const roles: ("current" | "legacy-candidate")[] = []
  if (location.current) roles.push("current")
  if (location.legacySources.size > 0) roles.push("legacy-candidate")
  return roles
}

function markerEvidence(): MarkerEvidence {
  return {
    current: false,
    legacy: false,
    currentAnchor: false,
    legacyAnchor: false,
    support: false,
    unknown: false,
  }
}

async function inspectLocation(location: MutableLocation, fs: StateLayoutFileSystem): Promise<StateLocationInspection> {
  const roles = locationRoles(location)
  const sources = [...location.legacySources].sort()
  const findings: StateLayoutFinding[] = []
  let rootKind: StatePathKind
  try {
    rootKind = await fs.kind(location.path)
  } catch (error) {
    findings.push({
      code: "state-path-unreadable",
      path: location.path,
      message: `Cannot inspect ${location.path}: ${error instanceof Error ? error.message : String(error)}. Fix access before starting Yrd.`,
    })
    return { path: location.path, roles, sources, kind: "corrupt", markers: [], eventFormat: "none", findings }
  }

  if (rootKind === "missing") {
    return { path: location.path, roles, sources, kind: "absent", markers: [], eventFormat: "none", findings }
  }
  if (rootKind !== "directory") {
    findings.push({
      code: "state-path-not-directory",
      path: location.path,
      message: `${location.path} is a ${rootKind}, not a state directory; preserve or relocate it before starting Yrd.`,
    })
    return { path: location.path, roles, sources, kind: "unknown", markers: [], eventFormat: "none", findings }
  }

  let names: readonly string[]
  try {
    names = [...(await fs.readDir(location.path))].sort()
  } catch (error) {
    findings.push({
      code: "state-directory-unreadable",
      path: location.path,
      message: `Cannot list ${location.path}: ${error instanceof Error ? error.message : String(error)}. Fix access before starting Yrd.`,
    })
    return { path: location.path, roles, sources, kind: "corrupt", markers: [], eventFormat: "none", findings }
  }

  const evidence = markerEvidence()
  const markers: string[] = []
  let eventFormat: StateEventFormat = "none"

  for (const name of names) {
    const path = join(location.path, name)
    const expected = expectedKind(name)
    if (expected === undefined) {
      evidence.unknown = true
      findings.push({
        code: "unknown-state-marker",
        path,
        marker: name,
        message: `Unknown entry '${name}' in ${location.path}; Yrd will not initialize or open state beside unclassified data.`,
      })
      continue
    }

    let kind: StatePathKind
    try {
      kind = await fs.kind(path)
    } catch (error) {
      findings.push({
        code: "state-marker-unreadable",
        path,
        marker: name,
        message: `Cannot inspect state marker ${path}: ${error instanceof Error ? error.message : String(error)}.`,
      })
      return { path: location.path, roles, sources, kind: "corrupt", markers, eventFormat, findings }
    }
    if (kind !== expected) {
      evidence.unknown = true
      findings.push({
        code: "invalid-state-marker-kind",
        path,
        marker: name,
        message: `State marker ${path} must be a ${expected}, but is ${kind}; symlinks and type mismatches are refused.`,
      })
      continue
    }

    markers.push(name)
    if (name === "events.jsonl") {
      let text: string
      try {
        text = await fs.readText(path)
      } catch (error) {
        findings.push({
          code: "event-log-unreadable",
          path,
          marker: name,
          message: `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}. Fix access before starting Yrd.`,
        })
        return { path: location.path, roles, sources, kind: "corrupt", markers, eventFormat: "corrupt", findings }
      }
      const inspected = inspectEvents(path, text)
      eventFormat = inspected.format
      findings.push(...inspected.findings)
      if (eventFormat === "current") evidence.current = true
      else if (eventFormat === "legacy") evidence.legacy = true
      else if (eventFormat === "mixed") {
        evidence.current = true
        evidence.legacy = true
      } else if (eventFormat === "unknown") evidence.unknown = true
      else if (eventFormat === "corrupt") {
        return { path: location.path, roles, sources, kind: "corrupt", markers, eventFormat, findings }
      }
      continue
    }

    if (LEGACY_ONLY_MARKERS.has(name) || isLegacyBackup(name) || isLegacyInbox(name)) evidence.legacy = true
    else if (CURRENT_ONLY_MARKERS.has(name)) evidence.current = true
    else if (SHARED_ANCHORS.has(name)) {
      evidence.currentAnchor = true
      evidence.legacyAnchor = true
    } else if (SHARED_SUPPORT.has(name)) evidence.support = true
  }

  const hasCurrentRole = location.current
  const hasLegacyRole = location.legacySources.size > 0
  const hasDeterminativeEvent = eventFormat === "current" || eventFormat === "legacy" || eventFormat === "mixed"

  if (!hasDeterminativeEvent && !evidence.legacy) {
    if (evidence.currentAnchor || (eventFormat === "empty" && hasLegacyRole && !hasCurrentRole)) {
      if (hasCurrentRole && !hasLegacyRole) evidence.current = true
      else if (hasLegacyRole && !hasCurrentRole) evidence.legacy = true
      else evidence.unknown = true
    } else if (evidence.support) {
      if (hasLegacyRole && !hasCurrentRole) evidence.legacy = true
      else evidence.unknown = true
    } else if (eventFormat === "empty") evidence.unknown = true
  } else if (evidence.legacy) {
    // Shared artifacts belong to the generation identified by the event log or a legacy-only marker.
    evidence.currentAnchor = false
  }

  let kind: StateLocationKind
  if (evidence.current && evidence.legacy) kind = "mixed"
  else if (evidence.current) {
    if (!hasCurrentRole) {
      kind = "unknown"
      findings.push({
        code: "current-state-in-legacy-location",
        path: location.path,
        message: `Current Yrd event envelopes exist at unsupported location ${location.path}; configure the host to use the supported current directory instead of guessing.`,
      })
    } else kind = evidence.unknown ? "unknown" : "current"
  } else if (evidence.legacy) kind = "legacy"
  else kind = "unknown"

  if (names.length === 0) {
    findings.push({
      code: "empty-state-directory",
      path: location.path,
      message: `${location.path} exists but has no recognized state marker; Yrd will not treat an existing directory as fresh solely by name.`,
    })
  } else if (kind === "legacy") {
    findings.push({
      code: "legacy-gitbay-state",
      path: location.path,
      message: `Legacy GitBay state found at ${location.path}; preserve it and run an explicit migration before starting Yrd.`,
    })
  } else if (kind === "mixed") {
    findings.push({
      code: "mixed-state-location",
      path: location.path,
      message: `Current Yrd and legacy GitBay markers coexist at ${location.path}; preserve the directory and reconcile generations explicitly.`,
    })
  }

  return { path: location.path, roles, sources, kind, markers, eventFormat, findings }
}

function refuse(kind: Exclude<StateLayoutKind, "absent" | "current">, currentDir: string): StateLayoutDecision {
  const diagnostic: Record<typeof kind, string> = {
    legacy: `Legacy GitBay state is present. Preserve it and migrate it explicitly into ${currentDir}; Yrd will not initialize over it.`,
    mixed: `Multiple or mixed state generations are present. Preserve every location and choose one authoritative migration into ${currentDir}.`,
    unknown: `Existing state could not be classified safely. Inspect the reported paths; Yrd will not create or open state until they are resolved.`,
    corrupt: `State is unreadable or corrupt. Preserve it and repair or migrate it before starting Yrd.`,
  }
  return { action: "refuse", mayStart: false, mayCreate: false, diagnostic: diagnostic[kind] }
}

/**
 * Classify state roots without creating, renaming, deleting, or opening any
 * database. The production host must honor `decision` before constructing its
 * event store because that constructor is allowed to create current state.
 */
export async function classifyStateLayout(options: ClassifyStateLayoutOptions): Promise<StateLayoutClassification> {
  const fs = options.fs ?? nodeStateLayoutFileSystem
  const currentDir = resolve(join(options.gitDir, "yrd"))
  const locations = new Map<string, MutableLocation>()

  function location(path: string): MutableLocation {
    const key = resolve(path)
    const existing = locations.get(key)
    if (existing !== undefined) return existing
    const created: MutableLocation = { path: key, current: false, legacySources: new Set() }
    locations.set(key, created)
    return created
  }

  location(currentDir).current = true
  location(join(options.gitDir, "bay")).legacySources.add(".git/bay")
  for (const candidate of options.legacyLocations ?? []) {
    location(candidate.path).legacySources.add(candidate.source)
  }

  const inspected: StateLocationInspection[] = []
  for (const candidate of locations.values()) inspected.push(await inspectLocation(candidate, fs))
  const occupied = inspected.filter((entry) => entry.kind !== "absent")
  const current = occupied.filter((entry) => entry.kind === "current")
  const legacy = occupied.filter((entry) => entry.kind === "legacy")
  const unknown = occupied.filter((entry) => entry.kind === "unknown")
  const corrupt = occupied.filter((entry) => entry.kind === "corrupt")
  const mixed = occupied.filter((entry) => entry.kind === "mixed")

  let kind: StateLayoutKind
  if (corrupt.length > 0) kind = "corrupt"
  else if (
    mixed.length > 0 ||
    current.length > 1 ||
    legacy.length > 1 ||
    (current.length > 0 && legacy.length > 0) ||
    ((current.length > 0 || legacy.length > 0) && unknown.length > 0)
  )
    kind = "mixed"
  else if (unknown.length > 0) kind = "unknown"
  else if (legacy.length === 1) kind = "legacy"
  else if (current.length === 1) kind = "current"
  else kind = "absent"

  const decision: StateLayoutDecision =
    kind === "absent"
      ? {
          action: "initialize",
          mayStart: true,
          mayCreate: true,
          diagnostic: `No Yrd or legacy GitBay state was found; initialization may create ${currentDir}.`,
        }
      : kind === "current"
        ? {
            action: "open-current",
            mayStart: true,
            mayCreate: false,
            diagnostic: `Recognized current Yrd state at ${currentDir}; open it without reinitializing.`,
          }
        : refuse(kind, currentDir)

  const findings = inspected.flatMap((entry) => entry.findings)
  return { kind, currentDir, locations: inspected, findings, decision }
}
