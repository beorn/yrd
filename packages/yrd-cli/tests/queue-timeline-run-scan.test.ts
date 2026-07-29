/**
 * @failure queueTimelineProjection resolves each detail row's Run by scanning every Run and rebuilds each Run's retry-peer list from the whole finished set, so narrowing either one silently drops, renumbers, or duplicates a detail.
 * @level l2
 * @consumer @yrd/cli `queue list` / `queue list --watch` operators
 */
import { describe, expect, it } from "vitest"

import { queueTimelineStories } from "../dev/queue-timeline-fixtures.ts"
import {
  queueTimelineAdmissionTimes,
  queueTimelineProjection,
  type QueueStatusResult,
  type QueueTimelineProjection,
} from "../src/queue-status-view.tsx"

type Run = QueueStatusResult["finished"][number]

const NOW = Date.parse("2026-07-13T12:00:00.000Z")

function contractResults(): readonly QueueStatusResult[] {
  const results = queueTimelineStories["contract-overview"]?.snapshot.results
  if (results === undefined) throw new Error("contract-overview is missing its queue results")
  return results
}

function withFinished(results: readonly QueueStatusResult[], finished: readonly Run[]): readonly QueueStatusResult[] {
  const first = results[0]
  if (first === undefined) throw new Error("contract-overview has no queue result")
  return [{ ...first, finished }, ...results.slice(1)]
}

function project(results: readonly QueueStatusResult[]): QueueTimelineProjection {
  return queueTimelineProjection(results, {
    now: NOW,
    windowMs: 6 * 60 * 60_000,
    statuses: ["pending", "running", "rejected", "integrated", "other"],
    terms: [],
    latest: false,
    rowLimit: 500,
    submissionTimes: queueTimelineAdmissionTimes(results),
  })
}

/** The fixture ships one completed Run per PR revision, which makes every retry
 * ordinal 1 and hides ordering bugs. Fan its completed Run out into `peers`
 * retry peers carrying the same PR revision.
 *
 * Each clone starts one minute after the seed, in order. Starting them EARLIER
 * would be rejected outright: `runRevisionClock` requires a submit or
 * check-request that precedes the Run, and the fixture's PR has none before its
 * own Run. The projection is right to refuse that; the clones have to be
 * causally possible. */
function enlargedFinished(results: readonly QueueStatusResult[], peers: number): readonly Run[] {
  const base = results.flatMap((result) => result.finished)
  const seed = base.find((run) => run.status === "completed")
  if (seed === undefined) throw new Error("contract-overview has no completed Run to clone")
  const seedStartedMs = Date.parse(seed.startedAt)
  const clones = Array.from({ length: peers }, (_, index) => {
    const at = new Date(seedStartedMs + (index + 1) * 60_000).toISOString()
    if (Date.parse(at) > NOW) throw new Error("retry peers must stay inside the display window")
    return {
      ...seed,
      id: `${seed.id}-peer${String(index + 1)}`,
      startedAt: at,
      ...(seed.finishedAt === undefined ? {} : { finishedAt: at }),
    }
  })
  return [...base, ...clones]
}

describe("queue timeline Run scanning", () => {
  it("keeps retry ordinals correct when the peer list is narrowed per Run", () => {
    const results = contractResults()
    const finished = enlargedFinished(results, 3)
    const projection = project(withFinished(results, finished))

    const seed = finished.find((run) => run.status === "completed")
    if (seed === undefined) throw new Error("expected a completed seed Run")
    const peers = finished.filter((run) => run.id === seed.id || run.id.startsWith(`${seed.id}-peer`))
    const ordinals = peers
      .map((run) => projection.details.find((detail) => detail.run === run.id)?.retries)
      .filter((retries): retries is number => retries !== undefined)

    // Every peer gets a detail, and the ordinals are the distinct positions
    // 1..n of the start-ordered peer list. Handing `queueShowData` the grouped
    // peers instead of every finished Run must not renumber, drop, or duplicate
    // a position — that ordinal is the whole reason it wants the list.
    expect(ordinals.length).toBe(peers.length)
    expect(ordinals.toSorted((left, right) => left - right)).toEqual(peers.map((_, index) => index + 1))
  })

  it("emits exactly one detail per distinct Run named by a row", () => {
    const results = contractResults()
    const projection = project(withFinished(results, enlargedFinished(results, 5)))

    const namedRuns = [
      ...new Set(projection.rows.filter((row) => row.run !== undefined).map((row) => `${row.base}:${String(row.run)}`)),
    ]
    const detailRuns = projection.details.map((detail) => `${detail.base}:${detail.run}`)

    // Resolving a row's Run through an index rather than a scan must keep the
    // detail set identical: no duplicates, nothing dropped, and no detail for a
    // Run no row named.
    expect(detailRuns.length, "a Run must not gain a second detail").toBe(new Set(detailRuns).size)
    expect(detailRuns.toSorted()).toEqual(namedRuns.toSorted())
  })
})
