/**
 * The supervisor's intent file, read (25430).
 *
 * hab writes `{verb, by, reason, at}` to the file named by
 * `HAB_UNIT_INTENT_FILE` BEFORE it signals or spawns this service, so a stop
 * can say who stopped it and why. The file holds the LATEST intent only, so the
 * reader keys on `verb` and never on the file's presence: a start without a
 * reason leaves the previous stop's record in place, and reading that as this
 * start's reason would invent one. Anything else — no variable, no file, a
 * different verb, a malformed record — is "no intent", and the caller says so
 * rather than guessing. The literal name is spoken here on purpose: yrd does not
 * depend on the host that supervises it.
 */

import { readFileSync } from "node:fs"
import type { ServiceIntentFact } from "@yrd/queue-core"

export const UNIT_INTENT_FILE_ENV = "HAB_UNIT_INTENT_FILE"

export type UnitIntentRead =
  | Readonly<{ kind: "intent"; fact: ServiceIntentFact }>
  | Readonly<{ kind: "none"; why: string }>

/** The record for `verb`, or why there is none. Never throws: a stopping service must still write its document. */
export function readUnitIntent(verb: "stop" | "start", env: NodeJS.ProcessEnv, now: Date): UnitIntentRead {
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
  const at = typeof record.at === "string" && !Number.isNaN(Date.parse(record.at)) ? record.at : now.toISOString()
  return { kind: "intent", fact: { by: record.by, reason: record.reason, since: at } }
}
