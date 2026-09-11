/**
 * The declared health probe: print the document the service's last round wrote.
 *
 * This re-derives NOTHING. The M7 objection to a health probe (2026-09-03) was
 * that shelling the CLI every tick is noise plus a second opinion, and it was
 * right: a probe that re-reads the remote and judges for itself can disagree
 * with the loop about the very thing the loop is authoritative on. This one
 * reads a file, so there is exactly one opinion and it is the loop's.
 *
 * That is also why it touches no network and never captures a declaration. A
 * declaration that cannot be read is precisely one of the states the service is
 * allowed to be in, and a probe that threw on it would be unable to report the
 * condition it exists to report.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  absentHealthDocument,
  parseQueueHealthDocument,
  QUEUE_HEALTH_DOCUMENT,
  queueHealthExitCode,
  unreadableHealthDocument,
  type QueueHealthDocument,
} from "@yrd/queue-core"

import type { YrdCliExitCode, YrdCliIO } from "./types.ts"

/**
 * The name the service calls itself in its own health document.
 *
 * Product-generic and stable: a supervisor reads it back to label a page, and
 * this package must not learn a seat name or a deployment's spelling. It lives
 * in the PROBE rather than the loop so the probe can answer without loading the
 * queue core — the writer imports it from here, not the other way around.
 */
export const SERVICE = "yrd-service"

/** Bound on the text an `unknown` document quotes back to an operator. */
const MAX_OBSERVED = 2_000

/**
 * Read the stored document, or say — typed — why there is none to read.
 *
 * Three outcomes, three different cures, and they must stay distinguishable:
 * no file (nothing started, or no round has finished), a file that is not a
 * health document (a defect in the writer), and a document (the loop's own
 * verdict). Collapsing any two of these is the silent-error shape.
 */
export function readQueueHealth(workdir: string, service: string): QueueHealthDocument {
  const path = join(workdir, QUEUE_HEALTH_DOCUMENT)
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    return absentHealthDocument(service, `no health document at ${path}: ${why}`)
  }
  const document = parseQueueHealthDocument(text)
  if (document !== undefined) return document
  return unreadableHealthDocument(
    service,
    `the health document at ${path} is not a ${"hab-service-health/2"} document`,
    text.trim().slice(0, MAX_OBSERVED) || null,
  )
}

/**
 * Print one health document and answer with the exit code it requires.
 *
 * The state and the exit code come from the same document through the one
 * mapping ({@link queueHealthExitCode}), so the probe can never print one claim
 * and exit with another.
 */
export function queueHealthCommand(workdir: string, service: string, io: YrdCliIO): YrdCliExitCode {
  const document = readQueueHealth(workdir, service)
  io.stdout(`${JSON.stringify(document)}\n`)
  return queueHealthExitCode(document.state)
}
