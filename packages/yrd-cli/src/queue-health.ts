/**
 * The declared health probe reads the last completed round's document.
 * Past its deadline, the existing process census distinguishes an open round
 * from missing work. Journals can stay silent throughout a long check: their
 * timestamps never establish process liveness. No network or declaration is
 * needed, including when those resources are the service's fault.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { inspectPathHolderCensus, type PathHolderCensus } from "@yrd/process"

import {
  absentHealthDocument,
  believableHealthDocument,
  parseQueueHealthDocument,
  QUEUE_HEALTH_DOCUMENT,
  queueHealthExitCode,
  readRunLog,
  runDiedInPreamble,
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
      // NO LIVE PROCESS HOLDS A ROUND. Before reporting that as something the
      // census could not measure, read the newest journal: a run that threw in
      // its Git preamble never claimed a worktree at all, so there is nothing
      // for a census to have missed about it and its own records say both that
      // the round is over and which Git call ended it (@i/10-yrd/24470). This
      // sits ABOVE the coverage check on purpose — the evidence is the journal,
      // not the process table, so an incomplete census cannot withhold it.
      const newest = newestRun(workdir)
      const unstarted = unstartedRound(newest)
      if (unstarted !== undefined) {
        return {
          ...judged,
          state: "unhealthy" as const,
          error: {
            code: "queue-round-unstarted",
            cause:
              `${judged.error.cause}; run ${unstarted.id} died in its Git preamble (${unstarted.how}): ` +
              `${unstarted.journal} holds its Git evidence and no run could be started from it`,
            resolution: [
              `Read the last Git record in ${unstarted.journal}; it names the call that failed.`,
              "This clears when a round starts and writes its own header.",
            ],
          },
        }
      }
      // AN OVERDUE ROUND READS OVERDUE WHETHER OR NOT THE CENSUS IS COMPLETE
      // (@i/10-yrd/b-wrong/24665). Completeness proves "no holder exists
      // anywhere", which this verdict never needed: overdue means the runner is
      // not making progress, and since 24470 the header names the runner, so
      // the one question that matters has a direct answer. A live-but-stalled
      // runner is overdue; a dead one is overdue and dead. Both are exit 2.
      //
      // What the completeness check used to do was turn a fact about the CENSUS
      // into a verdict about the ROUND. On any host with a systemd user session
      // three same-uid processes are non-dumpable every time, so the census is
      // never complete and every overdue round read `unobserved`/exit 3 — the
      // verdict was unreachable exactly when it mattered. The counters now go
      // in the cause as facts, where a reader can see the gap without it
      // deciding anything.
      return {
        ...judged,
        error: {
          ...judged.error,
          cause:
            `${judged.error.cause}; no live process holds a round worktree under ${trees}; ` +
            `${runnerFact(newest)}; ${coverageFact(census.coverage)}`,
          resolution: [
            `Read the run journals under ${join(workdir, "logs")} and the process census under ${trees}.`,
            "This clears when a round finishes or live work is observed in a round's worktree.",
          ],
        },
        facts: { ...judged.facts, coverage: census.coverage },
      }
    } catch (error) {
      // WHAT `queue-round-unobserved` MEANS NOW: the evidence could not be READ
      // AT ALL. Three things still land here and each is a genuine "we could not
      // look" — the census itself failing (an I/O error reading the process
      // table), a journal whose records cannot be parsed, and a live round whose
      // journal has no header. An INCOMPLETE census no longer does (24665); it
      // is a gap in one measurement, not an inability to take it, and it goes in
      // the overdue cause as a fact instead.
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

/** The newest run journal, and what it says about the run and its runner. */
type NewestRun = Readonly<{
  id: string
  journal: string
  /** The runner the header names — journals written since 24470 carry one. */
  pid?: number
  /** Whether that pid answers `kill -0`. Absent when there is no pid to ask about. */
  alive?: boolean
  /** The run never reached its queue: it died in its Git preamble, or is still in one. */
  died: boolean
  /** Did the run claim a worktree — the older, weaker evidence, for journals with no pid. */
  claimed: boolean
}>

/**
 * The newest run journal, read once and shared by every verdict below it.
 *
 * WITHOUT THE PROCESS CENSUS, which is the point: the journal names the run's
 * own pid and one `kill -0` settles it, so a census that cannot read every
 * process on the host is never consulted here and cannot withhold an answer.
 *
 * Says what it looked at and where. A missing log directory means no run has
 * ever journaled here, which the caller's own overdue fault already covers; any
 * OTHER failure to list it is thrown, because a caller deciding what became of
 * the queue must not be handed a verdict by a directory nobody could read.
 */
function newestRun(workdir: string): NewestRun | undefined {
  const logs = join(workdir, "logs")
  let names: readonly string[]
  try {
    names = readdirSync(logs)
  } catch (error) {
    // silent-fallback-allow: no log directory means no run ever journaled, and the caller's overdue fault already names that; every other listing failure throws below.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw new Error(
      `run journals under ${logs} could not be listed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  const id = names
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => name.slice(0, -".jsonl".length))
    .filter((name) => runStartedAt(name) !== undefined)
    .sort()
    .at(-1)
  if (id === undefined) return undefined
  const records = readRunLog(logs, id)
  const pid = records.find((record) => record.kind === "run")?.pid
  const named = typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
  return {
    claimed: existsSync(join(workdir, "worktrees", id)),
    died: runDiedInPreamble(records),
    id,
    journal: join(logs, `${id}.jsonl`),
    ...(named === undefined ? {} : { alive: running(named), pid: named }),
  }
}

/**
 * The newest run, when it is one that died in its Git preamble, and how we know.
 *
 * THE HEADER'S PID DECIDES IT, and nothing else can. A run claims its worktree
 * only after the whole Git preamble (queue-core run.ts:476), so for the entire
 * window in which "executing a preamble" and "died in one" must be told apart,
 * there is no `.pid` file and no worktree to read. Probing the one pid the
 * header names is the difference between naming a fault and paging about a
 * healthy run three seconds old. A journal from before 24470 carries no pid, so
 * the weaker evidence is all there is: sound for a FINISHED run, and stated as
 * what it is rather than dressed up as a liveness probe nobody took.
 */
function unstartedRound(
  newest: NewestRun | undefined,
): Readonly<{ id: string; journal: string; how: string }> | undefined {
  if (newest === undefined || !newest.died) return undefined
  const { id, journal } = newest
  if (newest.pid !== undefined) {
    return newest.alive === true
      ? undefined
      : { how: `its runner (pid ${String(newest.pid)}) is not running`, id, journal }
  }
  if (newest.claimed) return undefined
  return {
    how: "its header names no runner pid (written before the header-first writer) and it claimed no worktree",
    id,
    journal,
  }
}

/** What the newest run says about its own runner, for an overdue round's cause. */
function runnerFact(newest: NewestRun | undefined): string {
  if (newest === undefined) return "there is no run journal to name a runner"
  if (newest.pid === undefined) {
    return `the newest run ${newest.id} names no runner pid (written before the header-first writer)`
  }
  return `the newest run ${newest.id} names runner pid ${String(newest.pid)}, which ${
    newest.alive === true ? "is still running" : "is not running"
  }`
}

/**
 * What the census managed to see, as a FACT rather than as a verdict.
 *
 * An incomplete census is a statement about the host's process table, not about
 * the round, and conflating the two made every overdue round on a host with a
 * systemd user session unreadable (24665). The count goes in the sentence so a
 * reader can weigh the gap themselves.
 */
function coverageFact(coverage: PathHolderCensus["coverage"]): string {
  if (coverage.complete) return "the process census was complete"
  if (!("processes" in coverage)) return "the process census was incomplete"
  const denied = coverage.processes.sourceDenied + coverage.processes.unavailable.denied
  return (
    `the process census could not read ${String(denied)} same-uid process(es), so it is incomplete — ` +
    "a fact about the census, not about this round"
  )
}

/** Does this one process exist: `kill -0`, never a census. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // silent-fallback-allow: ESRCH and EPERM both answer the only question asked — this pid is not a process we can signal, so it is not a live runner.
    return false
  }
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
