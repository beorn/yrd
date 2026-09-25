// @failure an event queue lists a branch with an old record state or silently omits a change without a submitted commit.
// @level l1
// @consumer yrd list, show and watch on event queues

import { describe, expect, it } from "vitest"
import type { Event } from "gitomic/events"
import { evolve, initial, type EventChange } from "../src/events.ts"
import { eventListRows, eventRows } from "../src/event-table.ts"
import { clocks } from "../src/table.ts"

const QUEUE = "a".repeat(40)
const HEAD = "b".repeat(40)
const TIME = "2026-09-22T14:00:00.000Z"

function event(
  type: string,
  id: string,
  props: readonly (readonly [string, string])[] = [],
  links: string[] = [],
): Pick<Event, "id" | "type" | "props" | "links"> {
  return { id, type, props: [["Queue", QUEUE] as const, ["Time", TIME] as const, ...props], links }
}

describe("event changes use the shared table row", () => {
  it("keeps the default seven-day table current and JSON historical, with drafts and older endings opt-in", () => {
    const recent = new Date("2026-09-23T14:00:00.000Z")
    const old = new Date("2026-09-01T14:00:00.000Z")
    const now = new Date("2026-09-24T14:00:00.000Z")
    const current = { status: "queued" as const, commit: HEAD, since: recent, at: recent }
    const prior = { status: "merged" as const, commit: "c".repeat(40), since: old, at: recent, endedAt: recent }
    const ancient = { status: "failed" as const, commit: "d".repeat(40), since: old, at: old, endedAt: old }
    const histories = new Map([["task/change", [ancient, prior, current]]])
    const drafts = [
      { branch: "task/draft", head: "e".repeat(40), committedAt: recent, author: "dev", movedSinceSubmit: false },
    ]
    const normal = eventListRows(histories, drafts, { now })
    expect(normal.table.map((row) => row.head)).toEqual([HEAD])
    expect(normal.document.map((row) => row.head)).toEqual([HEAD, prior.commit])
    const expanded = eventListRows(histories, drafts, { now, all: true, drafts: true })
    expect(expanded.table.map((row) => row.head)).toEqual([HEAD, drafts[0]!.head])
    expect(expanded.document.map((row) => row.head)).toEqual([HEAD, prior.commit, ancient.commit, drafts[0]!.head])
  })
  it("folds a head merged twice into one row that names the later ending (25718)", () => {
    // A re-submit after the merge (25708) opened a second segment on the same
    // head, and the queue merged it again: one change, two equal endings. As
    // two rows with two `since` values, every strict reader refused the list.
    const first = new Date("2026-09-24T23:18:31.002Z")
    const second = new Date("2026-09-24T23:20:49.151Z")
    const ended = new Date("2026-09-24T23:21:21.000Z")
    const now = new Date("2026-09-24T23:30:00.000Z")
    const merged = {
      status: "merged" as const,
      commit: HEAD,
      since: first,
      at: first,
      endedAt: first,
      ending: { kind: "merged" as const, id: "e".repeat(40) },
    }
    const again = {
      status: "merged" as const,
      commit: HEAD,
      since: second,
      at: ended,
      endedAt: ended,
      ending: { kind: "merged" as const, id: "f".repeat(40) },
    }
    const listed = eventListRows(new Map([["task/twice", [merged, again]]]), [], { now })
    expect(listed.document.map((row) => [row.head, row.since])).toEqual([[HEAD, first]])
    expect(listed.document[0]?.duplicates).toEqual([{ ending: "f".repeat(40), endedAt: ended }])
    expect(listed.table.map((row) => row.since)).toEqual([first])

    // A head that failed and then merged is two endings, not one: both rows stay.
    const failed = { ...merged, status: "failed" as const, ending: { kind: "failed" as const, id: "e".repeat(40) } }
    expect(eventListRows(new Map([["task/retry", [failed, again]]]), [], { now }).document).toHaveLength(2)
  })
  it("projects one row per branch with the fold's current status, submitted head and ending reason", () => {
    const opened = evolve(
      initial,
      event(
        "opened",
        QUEUE,
        [
          ["Commit", HEAD],
          ["Issue", "25040"],
          ["By", "@dev/2"],
        ],
        [HEAD],
      ),
    )
    const verifying = evolve(opened, event("verifying", "c".repeat(40), [["Commit", HEAD]], [HEAD]))
    const checking = evolve(verifying, event("checking", "d".repeat(40)))
    const cancelled = evolve(
      opened,
      event(
        "cancelled",
        "e".repeat(40),
        [
          ["Reason", "dropped"],
          ["Commit", HEAD],
        ],
        [HEAD],
      ),
    )
    const rows = eventRows(
      new Map([
        ["task/check", checking],
        ["task/drop", cancelled],
      ]),
    )

    expect(rows).toEqual([
      {
        branch: "task/check",
        head: HEAD,
        state: "checking",
        format: "event",
        issue: "25040",
        submitter: "@dev/2",
        since: new Date(TIME),
        at: new Date(TIME),
        position: 1,
      },
      {
        branch: "task/drop",
        head: HEAD,
        state: "cancelled",
        format: "event",
        issue: "25040",
        reason: "dropped",
        submitter: "@dev/2",
        since: new Date(TIME),
        at: new Date(TIME),
        endedAt: new Date(TIME),
      },
    ])
  })

  it("names a branch whose selected chain has no submitted commit", () => {
    expect(() => eventRows(new Map([["task/missing", initial]]))).toThrow(/task\/missing.*submitted commit/)
    expect(() => eventRows(new Map([["task/no-time", { status: "queued", commit: HEAD }]]))).toThrow(
      /task\/no-time.*Time/,
    )
  })

  it("shows the deferred check beside queued without inventing a status", () => {
    const opened = evolve(
      initial,
      event(
        "opened",
        QUEUE,
        [
          ["Commit", HEAD],
          ["By", "@dev/2"],
        ],
        [HEAD],
      ),
    )
    const deferred = {
      ...opened,
      deferred: {
        id: "c".repeat(40),
        check: "affected-tests",
        phase: "merge" as const,
        reason: "outside short window",
        projectedMs: 60000,
        boundMs: 10000,
        at: new Date(TIME),
      },
    }
    expect(eventRows(new Map([["task/long", deferred]]))[0]).toMatchObject({
      state: "queued",
      reason: "deferred affected-tests: outside short window",
    })
  })

  it("keeps an ignored open change visible with actor and reason but no place in line", () => {
    const opened = evolve(
      initial,
      event(
        "opened",
        QUEUE,
        [
          ["Commit", HEAD],
          ["By", "@dev/2"],
        ],
        [HEAD],
      ),
    )
    const ignored = evolve(
      opened,
      event("ignored", "c".repeat(40), [
        ["Reason", "waiting"],
        ["By", "@dev/3"],
      ]),
    )
    const rows = eventRows(
      new Map([
        ["task/ignored", ignored],
        ["task/queued", opened],
      ]),
    )
    expect(rows).toEqual([
      expect.objectContaining({ branch: "task/queued", position: 1 }),
      expect.objectContaining({ branch: "task/ignored", ignored: { reason: "waiting", by: "@dev/3" } }),
    ])
    expect(rows[1]?.position).toBeUndefined()
    expect(rows[1]?.reason).toBeUndefined()
  })

  it("puts unsubmitted branch heads after folded changes as draft rows", () => {
    const opened = evolve(
      initial,
      event(
        "opened",
        QUEUE,
        [
          ["Commit", HEAD],
          ["By", "@dev/2"],
        ],
        [HEAD],
      ),
    )
    const draftHead = "f".repeat(40)
    const committedAt = new Date("2026-09-22T15:00:00.000Z")

    expect(
      eventRows(new Map([["task/change", opened]]), [
        { branch: "task/draft", head: draftHead, committedAt, author: "dev", movedSinceSubmit: false },
      ]),
    ).toEqual([
      expect.objectContaining({ branch: "task/change", state: "queued", format: "event" }),
      {
        branch: "task/draft",
        head: draftHead,
        state: "draft",
        format: "event",
        at: committedAt,
        author: "dev",
      },
    ])
  })

  it("uses opening time for working states and ending time for cancellation", () => {
    const since = new Date("2026-09-22T14:00:00.000Z")
    const at = new Date("2026-09-22T14:03:00.000Z")
    const endedAt = new Date("2026-09-22T14:04:00.000Z")
    const now = new Date("2026-09-22T14:10:00.000Z")
    for (const state of ["verifying", "checking", "merging"] as const) {
      const clock = clocks({ branch: "task/phase", head: HEAD, state, format: "event", since, at }, now)
      expect(clock.clockAt).toEqual(since)
      expect(clock.waitingMs).toBeUndefined()
    }
    expect(
      clocks({ branch: "task/drop", head: HEAD, state: "cancelled", format: "event", since, at, endedAt }, now),
    ).toMatchObject({
      clockAt: endedAt,
      tookMs: 240_000,
    })
  })

  it("projects the merged event's run trailer onto row.run and guards row.merge to merged status (25716 row 9)", () => {
    const runId = "2026-09-25T12:00:00.000Z-42"
    const targetMerge = "c".repeat(40)
    const candidate = "d".repeat(40)
    const checking = {
      status: "checking" as const,
      commit: HEAD,
      candidate,
      since: new Date(TIME),
      at: new Date(TIME),
    }
    const merged = {
      status: "merged" as const,
      commit: HEAD,
      candidate,
      merge: targetMerge,
      run: runId,
      since: new Date(TIME),
      at: new Date(TIME),
      endedAt: new Date(TIME),
    }
    const rows = eventRows(
      new Map<string, EventChange>([
        ["task/checking", checking],
        ["task/merged", merged],
      ]),
    )
    expect(rows[0]?.merge).toBeUndefined()
    expect(rows[0]?.run).toBeUndefined()
    expect(rows[1]?.merge).toBe(targetMerge)
    expect(rows[1]?.run).toBe(runId)
  })
})
