/**
 * The declared health probe reads the document the service last wrote, and
 * applies that document's own deadline to it. Nothing else: no process census,
 * no `kill -0`, no journal, no network and no declaration, including when those
 * resources are the service's fault. The service restates its document on a
 * heartbeat, so past the deadline its writer has stopped writing, and whether
 * that writer still lives is the supervisor's question, answered by the one
 * reader it owns (@i/4-supervision/24523 D1).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import {
  absentHealthDocument,
  believableHealthDocument,
  parseQueueHealthDocument,
  QUEUE_HEALTH_DOCUMENT,
  queueHealthExitCode,
  unreadableHealthDocument,
  type QueueHealthDocument,
} from "@yrd/queue-core"

import type { WorkdirResolution } from "./queue-location.ts"
import type { YrdCliExitCode, YrdCliIO } from "./types.ts"

/**
 * The name the service calls itself in its own health document.
 *
 * Product-generic and stable: a supervisor reads it back to label a page, and
 * this package must not learn a seat name or a deployment's spelling. It lives
 * in the PROBE rather than the loop so the probe can answer without loading the
 * queue core — the writer imports it from here, not the other way around.
 */
export const SERVICE = "yrd"

/** Bound on the text an `unknown` document quotes back to an operator. */
const MAX_OBSERVED = 2_000

/**
 * Write the document a probe later reads, ATOMICALLY and in one place: the
 * loop's every tick goes through here, and so does the start failure that has
 * no loop to run (`queue up` cannot read its own clone).
 *
 * ATOMIC, and the reason is a page nobody should ever have got: `writeFileSync`
 * truncates before it writes, so a probe landing in that window reads an EMPTY
 * file, which parses as unreadable, which becomes `unknown`, which habd pages as
 * health-not-measured. The probe runs on the supervisor's own tick, so the
 * window is hit by chance and the page names a defect that does not exist. Same
 * directory, so the rename is a rename and not a copy (@cto 2026-09-11).
 */
export function writeQueueHealth(workdir: string, document: QueueHealthDocument): void {
  const path = join(workdir, QUEUE_HEALTH_DOCUMENT)
  const staging = `${path}.${String(process.pid)}.tmp`
  mkdirSync(workdir, { recursive: true })
  writeFileSync(staging, `${JSON.stringify(document, undefined, 2)}\n`)
  renameSync(staging, path)
}

/**
 * Read the stored document, or say — typed — why there is none to read.
 *
 * Three outcomes, three different cures, and they must stay distinguishable:
 * no file (nothing started, or a starting service has not written yet), a file
 * that is not a health document (a defect in the writer), and a document (the
 * loop's own verdict). Collapsing any two of these is the silent-error shape.
 *
 * Given the `resolution` that chose the workdir, an absent answer names the root and where it came from, and a
 * default root that holds no queue at all says so and lists the declared roots it looked for — the absent document's
 * `facts.why`, never an `error` (see `absentHealthDocument`): a probe reading a third copy of the state must not
 * answer "stopped" quietly (hh 38659).
 */
export async function readQueueHealth(
  workdir: string,
  service: string,
  now: Date = new Date(),
  resolution?: WorkdirResolution,
): Promise<QueueHealthDocument> {
  const path = join(workdir, QUEUE_HEALTH_DOCUMENT)
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    if (resolution === undefined) return absentHealthDocument(service, `no health document at ${path}: ${why}`)
    const origin = `root ${resolution.root} from ${resolution.source}`
    if (existsSync(workdir)) return absentHealthDocument(service, `no health document at ${path} (${origin}): ${why}`)
    if (resolution.kind !== "default") return absentHealthDocument(service, `no queue at ${workdir} (${origin})`)
    return absentHealthDocument(
      service,
      `no queue at ${workdir} (${resolution.root} is the default); declared roots: none found — looked for ${resolution.tried.join("; ")}`,
    )
  }
  const document = parseQueueHealthDocument(text)
  // A DOCUMENT IS ONLY EVIDENCE UNTIL ITS OWN DEADLINE. Past the instant the
  // service itself declared this document believable until, printing the stored
  // verdict would be asserting a measurement nobody took (@cto 2026-09-11). The
  // service wrote the deadline; this only reads it, and relays what it finds.
  if (document !== undefined) return believableHealthDocument(document, now)
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
export async function queueHealthCommand(
  workdir: string,
  service: string,
  io: YrdCliIO,
  now: Date = new Date(),
  resolution?: WorkdirResolution,
): Promise<YrdCliExitCode> {
  const document = await readQueueHealth(workdir, service, now, resolution)
  io.stdout(`${JSON.stringify(document)}\n`)
  return queueHealthExitCode(document.state)
}
