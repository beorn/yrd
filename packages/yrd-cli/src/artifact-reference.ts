import { existsSync } from "node:fs"
import { basename, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export type ArtifactLocation = Readonly<{ path: string } | { url: string }>

type ArtifactRecord = Readonly<Record<string, unknown>>

function objectRecord(value: unknown): ArtifactRecord | undefined {
  return value === null || typeof value !== "object" || Array.isArray(value) ? undefined : (value as ArtifactRecord)
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

function hasScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/iu.test(value)
}

/** Resolve one recorded artifact location without fabricating a local target.
 * Local paths and file URLs must exist; non-file URIs remain their canonical
 * href and are never rewritten through pathToFileURL. */
export function artifactLocation(value: unknown): ArtifactLocation | undefined {
  const record = objectRecord(value)
  if (record === undefined) return undefined
  const candidate = nonemptyString(record.uri) ?? nonemptyString(record.path)
  if (candidate === undefined) return undefined
  if (!hasScheme(candidate)) {
    const path = resolve(candidate)
    return existsSync(path) ? { path } : undefined
  }
  if (!candidate.toLowerCase().startsWith("file:")) return { url: candidate }
  try {
    const path = fileURLToPath(candidate)
    return existsSync(path) ? { path } : undefined
  } catch {
    return undefined
  }
}

export function artifactHref(location: ArtifactLocation): string {
  return "path" in location ? pathToFileURL(location.path).href : location.url
}

export function artifactLabel(value: unknown, location?: ArtifactLocation): string {
  const record = objectRecord(value)
  if (record !== undefined) {
    for (const key of ["name", "kind", "file"] as const) {
      const label = nonemptyString(record[key])
      if (label !== undefined) return label
    }
  }
  if (location === undefined) return "artifact"
  if ("path" in location) return basename(location.path) || "artifact"
  try {
    return basename(new URL(location.url).pathname) || "artifact"
  } catch {
    return "artifact"
  }
}

/** Read only a value's standardized direct `artifacts` collection. */
export function directArtifacts(value: unknown): readonly unknown[] {
  const record = objectRecord(value)
  return record !== undefined && Array.isArray(record.artifacts) ? record.artifacts : []
}

/** Evidence is definition-validated before it reaches CLI projection. Walk its
 * nested typed records for standardized `artifacts` collections, never message
 * prose or arbitrary strings. */
export function nestedArtifacts(value: unknown): readonly unknown[] {
  if (value === undefined || value === null || typeof value !== "object") return []
  if (Array.isArray(value)) return value.flatMap(nestedArtifacts)
  const record = value as ArtifactRecord
  return [
    ...directArtifacts(record),
    ...Object.entries(record).flatMap(([key, nested]) => (key === "artifacts" ? [] : nestedArtifacts(nested))),
  ]
}

export function uniqueArtifacts(values: Iterable<unknown>): readonly unknown[] {
  const unique = new Map<string, unknown>()
  for (const value of values) {
    const location = artifactLocation(value)
    if (location === undefined) continue
    const key = "path" in location ? `path:${location.path}` : `url:${location.url}`
    if (!unique.has(key)) unique.set(key, value)
  }
  return [...unique.values()]
}
