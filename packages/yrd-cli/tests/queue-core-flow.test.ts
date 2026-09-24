/**
 * What the service knows about its line after one round (25669).
 *
 * @failure  the line stops flowing and health still reads healthy: rounds of
 *           five records ran every few minutes and judged nothing while 11 to
 *           22 changes waited (09-24 20:45 to 21:09Z), and no reading said so
 * @level    l1 (the fold alone; the page it feeds is service-health's `withLineFlow`)
 * @consumer the `up` loop, which re-judges this reading on every health write
 * @testonly none
 *
 * The stall clock runs from the last JUDGEMENT (merged, failed, stuck), never
 * from the last completed round, so a round that judged nothing must not move
 * it; and a round that ended before it could read the line must not erase
 * what the previous round saw.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { runId, type QueueRunOutcome, type RoundLine } from "@yrd/queue-core"
import { flowAfterRound, roundPhase } from "../src/queue-core-commands.ts"

/** A round's outcome, with only the fields this fold reads. */
const round = (
  judged: Partial<Record<"merged" | "failed" | "stuck", readonly string[]>>,
  line?: RoundLine,
): QueueRunOutcome =>
  ({
    merged: [],
    failed: [],
    stuck: [],
    ...judged,
    ...(line === undefined ? {} : { line }),
  }) as unknown as QueueRunOutcome

const now = new Date("2026-09-24T21:09:00.000Z")
const oldest = { branch: "task/a", openedAt: "2026-09-24T20:10:00.000Z" }

describe("the line's flow after one service round", () => {
  it("takes the waiting count and the oldest waiting change from the round's own reading", () => {
    const flow = flowAfterRound(
      { waiting: 3, roundOpen: { startedAt: "2026-09-24T21:05:00.000Z" } },
      round({}, { waiting: 11, oldest }),
      now,
    )
    expect(flow).toEqual({ waiting: 11, oldestWaiting: oldest, lastRoundEndedAt: now.toISOString() })
  })

  it("does not move the judgement clock for a round that judged nothing", () => {
    const flow = flowAfterRound(
      { waiting: 11, oldestWaiting: oldest, lastJudgedAt: "2026-09-24T20:20:00.000Z" },
      round({}, { waiting: 12, oldest }),
      now,
    )
    expect(flow?.lastJudgedAt).toBe("2026-09-24T20:20:00.000Z")
    expect(flow?.lastRoundEndedAt).toBe(now.toISOString())
  })

  it("moves the judgement clock to the round's end for a merge, a failure or a stuck record", () => {
    for (const judged of [{ merged: ["task/a"] }, { failed: ["task/a"] }, { stuck: ["task/a"] }]) {
      const flow = flowAfterRound({ waiting: 11, lastJudgedAt: "2026-09-24T20:20:00.000Z" }, round(judged), now)
      expect(flow?.lastJudgedAt).toBe(now.toISOString())
    }
  })

  it("keeps the latest judgement of the chains' and its own", () => {
    const chains = flowAfterRound(
      { waiting: 2, lastJudgedAt: "2026-09-24T20:20:00.000Z" },
      round({}, { waiting: 2, oldest, lastJudgedAt: "2026-09-24T20:50:00.000Z" }),
      now,
    )
    expect(chains?.lastJudgedAt).toBe("2026-09-24T20:50:00.000Z")
    const own = flowAfterRound(
      { waiting: 2, lastJudgedAt: "2026-09-24T20:55:00.000Z" },
      round({}, { waiting: 2, oldest, lastJudgedAt: "2026-09-24T20:50:00.000Z" }),
      now,
    )
    expect(own?.lastJudgedAt).toBe("2026-09-24T20:55:00.000Z")
  })

  it("keeps the previous reading when the round ended before it could read the line", () => {
    const flow = flowAfterRound({ waiting: 11, oldestWaiting: oldest }, round({}), now)
    expect(flow).toEqual({ waiting: 11, oldestWaiting: oldest, lastRoundEndedAt: now.toISOString() })
  })

  it("states no flow at all until a round has read the line, never a count of zero nobody took", () => {
    expect(flowAfterRound(undefined, round({ merged: ["task/a"] }), now)).toBeUndefined()
    expect(flowAfterRound(undefined, round({}, { waiting: 4, oldest }), now)).toEqual({
      lastRoundEndedAt: now.toISOString(),
      oldestWaiting: oldest,
      waiting: 4,
    })
  })

  it("drops the oldest waiting change once the round reads an empty line", () => {
    const flow = flowAfterRound(
      { waiting: 1, oldestWaiting: oldest },
      round({ merged: ["task/a"] }, { waiting: 0 }),
      now,
    )
    expect(flow?.waiting).toBe(0)
    expect(flow?.oldestWaiting).toBeUndefined()
  })
})

// 25669 row 2: queue health names the phase an open round is in, from that
// round's own journal, and says why when the journal cannot say.
describe("the open round's phase", () => {
  it("is the newest journal's open step and the change it works", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "yrd-round-phase-"))
    mkdirSync(join(workdir, "logs"))
    const started = new Date()
    const id = runId(started)
    const records = [
      { at: started.toISOString(), kind: "run", pid: process.pid, queue: "main", run: id, target: "main" },
      { branch: "task/a", kind: "check", name: "typecheck", phase: "submit", start: started.toISOString() },
    ]
    writeFileSync(join(workdir, "logs", `${id}.jsonl`), records.map((r) => `${JSON.stringify(r)}\n`).join(""))
    expect(await roundPhase(workdir)).toEqual({ branch: "task/a", phase: "submit typecheck" })
  })

  it("says where it looked when there is no journal to read", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "yrd-round-phase-"))
    const phase = await roundPhase(workdir)
    expect(phase).toEqual({ phaseUnread: expect.stringContaining(`no run journal was read: ${join(workdir, "logs")}`) })
  })
})
