/**
 * The declared health probe reads the last completed round's document.
 * Past its deadline, the existing process census distinguishes an open round
 * from missing work. Journals can stay silent throughout a long check: their
 * timestamps never establish process liveness. No network or declaration is
 * needed, including when those resources are the service's fault.
 */

import { readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { inspectPathHolderCensus } from "@yrd/process"

import {
  absentHealthDocument,
  believableHealthDocument,
  parseQueueHealthDocument,
  QUEUE_HEALTH_DOCUMENT,
  queueHealthExitCode,
  readRunLog,
  runStartedAt,
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
export async function readQueueHealth(
  workdir: string,
  service: string,
  now: Date = new Date(),
): Promise<QueueHealthDocument> {
  const path = join(workdir, QUEUE_HEALTH_DOCUMENT)
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    return absentHealthDocument(service, `no health document at ${path}: ${why}`)
  }
  const document = parseQueueHealthDocument(text)
  // A DOCUMENT IS ONLY EVIDENCE UNTIL ITS OWN DEADLINE. Past the instant the
  // loop itself declared its next round due by, printing the stored verdict
  // would be asserting a measurement nobody took — and the longer a round hangs
  // the more confident that assertion gets (@cto 2026-09-11). The loop wrote
  // the deadline; this only reads it.
  if (document !== undefined) {
    const judged = believableHealthDocument(document, now)
    if (judged.error?.code !== "queue-round-overdue") return judged
    const trees = join(workdir, "worktrees")
    let consulted = trees
    try {
      const census = await inspectPathHolderCensus(trees)
      // Search all rounds: a newer submission journal must not hide an older
      // merge check. A loop PID alone is not evidence of work in a round.
      for (const holder of census.holders) {
        const id = relative(trees, holder.target).split(sep)[0]
        if (id === undefined || runStartedAt(id) === undefined) continue
        consulted = join(workdir, "logs", `${id}.jsonl`)
        const records = readRunLog(join(workdir, "logs"), id)
        if (!records.some((record) => record.kind === "run" && record.run === id)) {
          throw new Error(`required run header is absent from ${consulted}`)
        }
        return {
          ...document,
          facts: {
            ...document.facts,
            activeRound: id,
            observedAt: now.toISOString(),
            holder,
            coverage: census.coverage,
          },
        }
      }
      if (!census.coverage.complete) {
        throw new Error(`process ownership under ${trees} could not be fully read: ${JSON.stringify(census.coverage)}`)
      }
      return {
        ...judged,
        error: {
          ...judged.error,
          cause: `${judged.error.cause}; no live process holds a round worktree under ${trees}`,
          resolution: [
            `Read the run journals under ${join(workdir, "logs")} and the process census under ${trees}.`,
            "This clears when a round finishes or live work is observed in a round's worktree.",
          ],
        },
        facts: { ...judged.facts, coverage: census.coverage },
      }
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      const absent = consulted === trees && (error as NodeJS.ErrnoException).code === "ENOENT"
      return {
        ...judged,
        ...(absent
          ? {}
          : {
              state: "unknown" as const,
              verdict: { kind: "unknown" as const, reason: "unparsed" as const, observed: why },
            }),
        error: {
          ...judged.error,
          code: absent ? judged.error.code : "queue-round-unobserved",
          cause: `${judged.error.cause}; could not establish round ownership from ${consulted}: ${why}`,
          resolution: [
            `Inspect ${consulted} and restore access to the round's process evidence.`,
            "The last completed round is overdue; whether a round is open could not be measured.",
          ],
        },
      }
    }
  }
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
): Promise<YrdCliExitCode> {
  const document = await readQueueHealth(workdir, service, now)
  io.stdout(`${JSON.stringify(document)}\n`)
  return queueHealthExitCode(document.state)
}
