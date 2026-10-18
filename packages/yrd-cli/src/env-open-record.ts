/**
 * Opening lifetime for one environment (21122 Slice 3 follow-up).
 *
 * Lives at `$GIT_DIR/yrd-open.json` so it is outside the worktree and dies
 * with it. Field name is `lifetime`, not `kind`. `--bay` / `--issue` are
 * naming/binding only; they are copied onto the record when given and never
 * inferred as lifetime.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { atomicWriteFileSync } from "@bearly/durable-file"

export const ENV_OPEN_RECORD_FILE = "yrd-open.json"

export type EnvLifetime = "job" | "standing"

export type EnvOpenRecord = Readonly<{
  version: 1
  lifetime: EnvLifetime
  bay?: string
  issue?: string
  at: string
}>

export type EnvOpenRecordRead =
  | Readonly<{ status: "recorded"; record: EnvOpenRecord }>
  | Readonly<{ status: "unrecorded"; why: "opening lifetime unrecorded" }>
  | Readonly<{ status: "unreadable"; why: string }>

export function envOpenRecordPath(gitDir: string): string {
  return join(gitDir, ENV_OPEN_RECORD_FILE)
}

export function writeEnvOpenRecord(gitDir: string, record: EnvOpenRecord): void {
  if (gitDir.trim() === "") {
    throw new Error("yrd env open: git dir is empty; cannot write opening lifetime")
  }
  if (record.version !== 1 || (record.lifetime !== "job" && record.lifetime !== "standing")) {
    throw new Error(`yrd env open: refused to write opening lifetime ${JSON.stringify(record)}`)
  }
  atomicWriteFileSync(envOpenRecordPath(gitDir), `${JSON.stringify(record)}\n`)
}

/** MERGED-close: job continues the Slice 3 filer; standing and unreadable keep, while unrecorded defers to the general sweep. */
export function mergedCloseKeepReason(opening: EnvOpenRecordRead): string | undefined {
  if (opening.status === "unrecorded" || opening.status === "unreadable") return opening.why
  if (opening.record.lifetime === "standing") return "opening lifetime standing"
  return undefined
}

/** Sweep skips recorded standing and unreadable records; unrecorded stays eligible as today. */
export function throwIfStandingLifetime(opening: EnvOpenRecordRead): void {
  if (opening.status === "unreadable") {
    throw new Error(opening.why)
  }
  if (opening.status === "recorded" && opening.record.lifetime === "standing") {
    throw new Error("opening lifetime standing")
  }
}

export function envOpenRecordFromFlags(
  options: Readonly<{ keep?: boolean; bay?: string; issue?: string }>,
): EnvOpenRecord {
  return {
    version: 1,
    lifetime: options.keep === true ? "standing" : "job",
    at: new Date().toISOString(),
    ...(options.bay === undefined ? {} : { bay: options.bay }),
    ...(options.issue === undefined ? {} : { issue: options.issue }),
  }
}

function unreadableOpenRecord(path: string, cause: string): EnvOpenRecordRead {
  return { status: "unreadable", why: `opening record unreadable at ${path}: ${cause}` }
}

export function readEnvOpenRecord(gitDir: string): EnvOpenRecordRead {
  if (gitDir.trim() === "") return { status: "unrecorded", why: "opening lifetime unrecorded" }
  const path = envOpenRecordPath(gitDir)
  if (!existsSync(path)) return { status: "unrecorded", why: "opening lifetime unrecorded" }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (cause) {
    return unreadableOpenRecord(path, cause instanceof Error ? cause.message : String(cause))
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return unreadableOpenRecord(path, "not a JSON object")
  }
  const row = parsed as Record<string, unknown>
  if (row.version !== 1 || (row.lifetime !== "job" && row.lifetime !== "standing")) {
    return unreadableOpenRecord(
      path,
      `expected version 1 and lifetime "job" or "standing" (got version=${JSON.stringify(row.version)}, lifetime=${JSON.stringify(row.lifetime)})`,
    )
  }
  return {
    status: "recorded",
    record: {
      version: 1,
      lifetime: row.lifetime,
      at: typeof row.at === "string" ? row.at : "",
      ...(typeof row.bay === "string" ? { bay: row.bay } : {}),
      ...(typeof row.issue === "string" ? { issue: row.issue } : {}),
    },
  }
}
