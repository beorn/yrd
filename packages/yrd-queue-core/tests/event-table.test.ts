// @failure an event queue lists a branch with an old record state or silently omits a change without a submitted commit.
// @level l1
// @consumer yrd list, show and watch on event queues

import { describe, expect, it } from "vitest"
import type { Event } from "gitomic/events"
import { evolve, initial } from "../src/events.ts"
import { eventRows } from "../src/event-table.ts"
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
        phase: "long" as const,
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
})
