/**
 * @failure The queue run's log was named by the last Run the incumbent minted,
 *          so two queue runs that built no Run wrote to ONE file under ONE
 *          name — measured 2026-09-02 on pin 0749260a, two consecutive
 *          empty-lane runs both appending 22 rows to `R700.jsonl`, each
 *          carrying a `run` row calling itself R700. The same two runs
 *          re-reported seven historical change/result/merge triplets recovered
 *          from the checkpoint, so the log claimed merges neither run made.
 * @level   l1
 * @consumer the mechanic reading a garage queue run · every later reader of the
 *           fact stream
 *
 * A queue run is one invocation of `yrd queue run` (plan of record § The queue
 * run). It always has its own log, whether or not it built a Run, so its
 * identity is minted from the invocation and never borrowed from a record the
 * invocation may not have made.
 */
import { describe, expect, it } from "vitest"
import {
  openQueueRun,
  queueRunLogFile,
  queueRunLogRecords,
  queueRunOwnRuns,
  type QueueRunSourceRun,
} from "../src/queue-run-log.ts"

/** Never stuck: these cases are about identity and ownership, not billing. */
const never = (): boolean => false

function run(id: string, startedAt: string, extra: Partial<QueueRunSourceRun> = {}): QueueRunSourceRun {
  return { id, startedAt, prs: [{ branch: `task/${id}`, headSha: `sha-${id}` }], ...extra }
}

describe("a queue run's own id", () => {
  it("is minted per invocation, not borrowed from a Run", () => {
    const first = openQueueRun()
    const second = openQueueRun()

    // Two invocations, two ids — the property the R700 collision broke.
    expect(first.id).not.toBe(second.id)
    // The instant travels with the id, so both come from one act and cannot
    // disagree about which queue run they describe.
    expect(Date.parse(first.startedAt)).not.toBeNaN()
    expect(first.startedAt).toBe(new Date(first.startedAt).toISOString())
  })

  it("carries the queue run's own instant, so a log directory lists in time order", () => {
    const opened = [openQueueRun(), openQueueRun(), openQueueRun()]

    // A mechanic lists the log directory and reads down it. The name's leading
    // field IS the queue run's instant, digits only, so sorting the names
    // sorts the queue runs — for every pair the clock can tell apart. Two
    // mints inside one millisecond are ordered by the random tail instead,
    // which is what that tail is for: the clock did not separate them, so
    // nothing here pretends it did.
    const stamps = opened.map(({ id }) => /^q-(\d{8}T\d{9}Z)-[0-9a-f]{8}$/u.exec(id)?.[1])
    for (const [index, { startedAt }] of opened.entries()) {
      expect(stamps[index]).toBe(startedAt.replaceAll(/[-:.]/gu, ""))
    }
    expect([...stamps].sort()).toEqual(stamps)
  })

  it("survives the filesystem unchanged", () => {
    const { id } = openQueueRun()

    // The id names the file, so a sanitizing pass that rewrote it would give
    // the file a different name from the `run` field inside it.
    expect(queueRunLogFile("/logs", id)).toBe(`/logs/${id}.jsonl`)
    expect(id).toMatch(/^[A-Za-z0-9._-]+$/u)
  })
})

describe("the runs a queue run owns", () => {
  const since = "2026-09-02T12:00:00.000Z"

  it("keeps the runs it started and counts the completions it recovered", () => {
    const owned = queueRunOwnRuns(
      [
        run("R698", "2026-09-02T11:00:00.000Z"),
        run("R699", "2026-09-02T11:30:00.000Z"),
        run("R700", "2026-09-02T12:00:01.000Z"),
      ],
      since,
    )

    expect(owned.own.map((entry) => entry.id)).toEqual(["R700"])
    // The recovery is visible as a COUNT on the run row, never as facts: a
    // completion of an earlier Run is not this queue run's merge.
    expect(owned.recovered).toBe(2)
    expect(owned.unreadable).toEqual([])
  })

  it("keeps a run that started at the same instant the queue run did", () => {
    // The pass stamps its instant before it composes, so a run born in the
    // same millisecond is this pass's. The boundary is inclusive.
    expect(queueRunOwnRuns([run("R1", since)], since).own.map((entry) => entry.id)).toEqual(["R1"])
  })

  it("orders by the clock, not by the text of the timestamp", () => {
    // `2026-09-02T05:00:00.000-08:00` is 13:00Z — AFTER `since`, though it
    // sorts before it as a string. Comparing ISO text would have dropped it.
    const owned = queueRunOwnRuns([run("R1", "2026-09-02T05:00:00.000-08:00")], since)

    expect(owned.own.map((entry) => entry.id)).toEqual(["R1"])
    expect(owned.recovered).toBe(0)
  })

  it("names a run whose start it cannot read instead of silently keeping or dropping it", () => {
    const owned = queueRunOwnRuns([run("R1", "not a time"), run("R2", "2026-09-02T12:00:01.000Z")], since)

    // NO SILENT ERRORS: it is not this queue run's to claim, and the id is
    // reported so the drop is never quiet.
    expect(owned.own.map((entry) => entry.id)).toEqual(["R2"])
    expect(owned.unreadable).toEqual(["R1"])
    expect(owned.recovered).toBe(0)
  })
})

describe("the run record", () => {
  it("carries the Run ids this queue run built, and the count it recovered", () => {
    const [opened] = queueRunLogRecords(
      { target: "main", runs: [run("R700", "2026-09-02T12:00:01.000Z")], recovered: 7 },
      never,
    )

    expect(opened).toMatchObject({ kind: "run", target: "main", built: ["R700"], recovered: 7 })
  })

  it("says nothing about Runs or recovery when there were none", () => {
    const [opened] = queueRunLogRecords({ target: "main", runs: [] }, never)

    // An absent field is "there were none", which is the honest shape for a
    // queue run that built nothing — not `built: []` and `recovered: 0`.
    expect(opened).toEqual({ kind: "run", target: "main" })
  })

  it("writes no change, result or merge row for a run it did not start", () => {
    // The seven historical triplets, handed to the projector the way the
    // defect handed them: already excluded by ownership, counted instead.
    const records = queueRunLogRecords({ target: "main", runs: [], recovered: 7 }, never)

    expect(records.filter((record) => record.kind !== "run")).toEqual([])
    expect(records[0]).toMatchObject({ kind: "run", recovered: 7 })
  })
})
