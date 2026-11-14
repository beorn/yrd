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
  /** ISO instant after which a close may proceed; recorded at open, never inferred from age. */
  expiresAt?: string
  /** The commit the environment stood at when it opened; an expired close also requires HEAD to still be this. */
  openedCommit?: string
  at: string
}>

/** The longest expiry `env open --expires` accepts; named in the refusal so the cap is never a surprise. */
export const MAX_ENV_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000

const EXPIRY_DURATION = /^(\d+)([smhd])$/u

/**
 * `--expires <duration|instant>` — a duration from now (`90s`, `30m`, `12h`, `7d`) or an ISO instant.
 * A past instant and anything beyond the 7-day cap are refused by name: an expiry is permission for the
 * clock to remove a bay, and an unbounded one is the unowned bay under another name.
 */
export function parseEnvExpires(value: string, now: Date = new Date()): string {
  const raw = value.trim()
  if (raw === "") {
    throw new Error(
      "yrd env open --expires needs a duration such as 12h or 7d, or an ISO 8601 instant; got an empty value",
    )
  }
  const duration = EXPIRY_DURATION.exec(raw)
  let instant: number
  if (duration !== null) {
    const amount = Number(duration[1])
    const unit = duration[2] as "s" | "m" | "h" | "d"
    const unitMs = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000
    instant = now.getTime() + amount * unitMs
  } else {
    instant = Date.parse(raw)
    if (!Number.isFinite(instant)) {
      throw new Error(
        `yrd env open --expires ${JSON.stringify(value)} is neither a duration such as 12h or 7d nor an ISO 8601 instant`,
      )
    }
  }
  if (instant <= now.getTime()) {
    throw new Error(
      `yrd env open --expires ${JSON.stringify(value)} is at or before the current instant ${now.toISOString()}, ` +
        "so the environment would be born expired; give a future duration or instant",
    )
  }
  const cap = now.getTime() + MAX_ENV_EXPIRY_MS
  if (instant > cap) {
    throw new Error(
      `yrd env open --expires ${JSON.stringify(value)} is later than the 7-day maximum (cap ${new Date(cap).toISOString()}); ` +
        "open it again with a shorter expiry, or bind it to an issue with --issue <ref>",
    )
  }
  return new Date(instant).toISOString()
}

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

/**
 * MERGED-close: job returns undefined; standing, unrecorded, and unreadable return their keep reason
 * (`fileTerminalCloseRequests` skips recording `unrecorded` before calling this so the general sweep owns it).
 */
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
  options: Readonly<{ keep?: boolean; bay?: string; issue?: string; expiresAt?: string; openedCommit?: string }>,
): EnvOpenRecord {
  return {
    version: 1,
    lifetime: options.keep === true ? "standing" : "job",
    at: new Date().toISOString(),
    ...(options.bay === undefined ? {} : { bay: options.bay }),
    ...(options.issue === undefined ? {} : { issue: options.issue }),
    ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    ...(options.openedCommit === undefined ? {} : { openedCommit: options.openedCommit }),
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
      ...(typeof row.expiresAt === "string" ? { expiresAt: row.expiresAt } : {}),
      ...(typeof row.openedCommit === "string" ? { openedCommit: row.openedCommit } : {}),
    },
  }
}
