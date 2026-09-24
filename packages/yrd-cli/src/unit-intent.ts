/**
 * The supervisor's intent file, read (25430).
 *
 * hab writes `{verb, by, reason, at}` to the file named by
 * `HAB_UNIT_INTENT_FILE` BEFORE it signals or spawns this service, so a stop
 * can say who stopped it and why. The file holds the LATEST intent only. A start
 * without a reason leaves the previous stop's record in place; keying on `verb`
 * protects the start reader, and requiring that a stop intent's `at` is at or
 * after this process's start (`startedAt`) protects the stop reader against
 * reading a previous stop's record as this stop's reason (@cto 16ab7d00).
 *
 * Anything else — no variable, no file, a different verb, a malformed record,
 * a missing or unparseable `at`, or a stale `at` written before this process
 * started — is "no intent", and the caller says "no stop reason was recorded"
 * rather than guessing or falling back to `now`. The literal name is spoken
 * here on purpose: yrd does not depend on the host that supervises it.
 */

import { readFileSync } from "node:fs"
import type { ServiceIntentFact } from "@yrd/queue-core"

export const UNIT_INTENT_FILE_ENV = "HAB_UNIT_INTENT_FILE"

export type UnitIntentRead =
  | Readonly<{ kind: "intent"; fact: ServiceIntentFact }>
  | Readonly<{ kind: "none"; why: string }>

/**
 * The record for `verb`, or why there is none. Never throws: a stopping
 * service must still write its document.
 *
 * Under @cto ruling 16ab7d00, the reader keys on verb, and on an `at` from this
 * run. A stop intent is accepted only when its `at` is at or after this run's
 * `startedAt`. A missing, unparseable, or stale `at` reads as no intent (no
 * fallback to `now`).
 */
export function readUnitIntent(
  verb: "stop" | "start",
  env: NodeJS.ProcessEnv,
  startedAt?: Date | string,
): UnitIntentRead {
  const path = env[UNIT_INTENT_FILE_ENV]?.trim()
  if (path === undefined || path === "") {
    return { kind: "none", why: `${UNIT_INTENT_FILE_ENV} is not set, so the supervisor gave no intent channel` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    return {
      kind: "none",
      why: `no readable intent at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}
  if (record.verb !== verb) {
    return { kind: "none", why: `the intent at ${path} is for ${JSON.stringify(record.verb)}, not ${verb}` }
  }
  if (typeof record.by !== "string" || typeof record.reason !== "string" || record.reason.trim() === "") {
    return { kind: "none", why: `the ${verb} intent at ${path} has no by and reason` }
  }
  if (typeof record.at !== "string") {
    return { kind: "none", why: `the ${verb} intent at ${path} has no valid timestamp` }
  }
  const atMs = Date.parse(record.at)
  if (Number.isNaN(atMs)) {
    return { kind: "none", why: `the ${verb} intent at ${path} has an unparseable timestamp: ${JSON.stringify(record.at)}` }
  }
  if (verb === "stop") {
    if (startedAt === undefined) {
      return { kind: "none", why: `the stop intent at ${path} cannot be verified without the process start time` }
    }
    const startedAtMs = typeof startedAt === "string" ? Date.parse(startedAt) : startedAt.getTime()
    const startedAtIso = typeof startedAt === "string" ? startedAt : startedAt.toISOString()
    if (Number.isNaN(startedAtMs)) {
      return { kind: "none", why: `the process start time is unparseable: ${String(startedAt)}` }
    }
    if (atMs < startedAtMs) {
      return {
        kind: "none",
        why: `the stop intent at ${path} was written at ${record.at}, before this process started at ${startedAtIso}`,
      }
    }
  }
  return { kind: "intent", fact: { by: record.by, reason: record.reason, since: record.at } }
}
