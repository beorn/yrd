// @failure an event queue lists a branch with an old record state or silently omits a change without a submitted commit.
// @level l1
// @consumer yrd list, show and watch on event queues

import { describe, expect, it } from "vitest"
import type { Event } from "gitomic/events"
import { evolve, initial, type EventChange } from "../src/events.ts"
import { eventListRows, eventRows } from "../src/event-table.ts"
import { clocks, watchRows, watchRowKey } from "../src/table.ts"

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
  it("shows a refused ending notice and gives the queue operator the next move", () => {
    const ended = "c".repeat(40)
    const failed: EventChange = {
      status: "failed",
      commit: HEAD,
      submitter: "@dev/2",
      reason: "verify",
      since: new Date(TIME),
      at: new Date(TIME),
      endedAt: new Date(TIME),
      ending: { kind: "failed", id: ended },
      notices: {
        [`${ended}:submitter`]: {
          for: ended,
          to: "submitter",
          result: "refused",
          reason: "tribe refused (24581)",
        },
      },
    }
    expect(eventRows(new Map([["task/refused", failed]]))[0]).toMatchObject({
      told: false,
      refused: "submitter refused=tribe refused (24581)",
      next: { owner: "the queue's operator", because: "submitter not told: submitter refused=tribe refused (24581)" },
    })
  })

  it("keeps the failed change with its submitter after a delivered ending notice", () => {
    const ended = "d".repeat(40)
    const failed: EventChange = {
      status: "failed",
      commit: HEAD,
      submitter: "@dev/2",
      reason: "verify",
      since: new Date(TIME),
      at: new Date(TIME),
      endedAt: new Date(TIME),
      ending: { kind: "failed", id: ended },
      notices: {
        [`${ended}:submitter`]: { for: ended, to: "submitter", result: "delivered" },
      },
    }
    expect(eventRows(new Map([["task/told", failed]]))[0]).toMatchObject({
      told: true,
      next: { owner: "@dev/2", because: "it failed (verify), and only the branch's author can move it" },
    })
  })

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
    expect(normal.table.map((row) => row.head)).toEqual([HEAD, drafts[0]!.head])
    expect(normal.document.map((row) => row.head)).toEqual([HEAD, prior.commit])
    const expanded = eventListRows(histories, drafts, { now, all: true, drafts: true })
    expect(expanded.table.map((row) => row.head)).toEqual([HEAD, drafts[0]!.head])
    expect(expanded.document.map((row) => row.head)).toEqual([HEAD, prior.commit, ancient.commit, drafts[0]!.head])
  })
  it("folds proven equal merge roots and names both endings and their root (25718)", () => {
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
      merge: "c".repeat(40),
      since: first,
      at: first,
      endedAt: first,
      ending: { kind: "merged" as const, id: "e".repeat(40) },
    }
    const again = {
      status: "merged" as const,
      commit: HEAD,
      adoptedMerge: "c".repeat(40),
      since: second,
      at: ended,
      endedAt: ended,
      ending: { kind: "merged" as const, id: "f".repeat(40) },
    }
    const listed = eventListRows(new Map([["task/twice", [merged, again]]]), [], { now })
    expect(listed.document.map((row) => [row.head, row.since])).toEqual([[HEAD, first]])
    expect(listed.document[0]?.duplicates).toEqual([
      { ending: "f".repeat(40), originalEnding: "e".repeat(40), merge: "c".repeat(40), endedAt: ended },
    ])
    expect(listed.table.map((row) => row.since)).toEqual([first])

    const reopenedHead = eventListRows(
      new Map([
        [
          "task/twice",
          [
            merged,
            {
              ...again,
              commit: "d".repeat(40),
              adoptedMerge: "d".repeat(40),
              ending: { kind: "merged" as const, id: "a".repeat(40) },
            },
            again,
          ],
        ],
      ]),
      [],
      { now },
    )
    expect(reopenedHead.table.map((row) => row.head)).toEqual([HEAD])
    expect(reopenedHead.table[0]?.duplicates).toEqual(listed.table[0]?.duplicates)

    const ancient = new Date("2026-09-01T14:00:00.000Z")
    const freshDuplicate = eventListRows(
      new Map([["task/twice", [{ ...merged, since: ancient, at: ancient, endedAt: ancient }, again]]]),
      [],
      { now },
    )
    expect(freshDuplicate.table).toHaveLength(1)
    expect(freshDuplicate.document).toHaveLength(1)
    expect(freshDuplicate.table[0]).toMatchObject({
      since: ancient,
      endedAt: ancient,
      duplicates: [{ ending: "f".repeat(40), originalEnding: "e".repeat(40), merge: "c".repeat(40), endedAt: ended }],
    })

    // A head that failed and then merged is two endings, not one: both rows stay.
    const failed = { ...merged, status: "failed" as const, ending: { kind: "failed" as const, id: "e".repeat(40) } }
    expect(eventListRows(new Map([["task/retry", [failed, again]]]), [], { now }).document).toHaveLength(2)
  })
  // A matching head is insufficient proof; the old fixture had no merge roots
  // and therefore certified the false equality that hid contradictory endings.
  it.each([
    ["different roots", "c".repeat(40), "d".repeat(40), "contradictory endings"],
    ["missing original root", undefined, "d".repeat(40), "equality unproven"],
    ["missing later root", "c".repeat(40), undefined, "equality unproven"],
  ])("retains both merged endings with %s in the list", (_case, firstRoot, laterRoot, diagnostic) => {
    const first = new Date("2026-09-01T14:00:00.000Z")
    const later = new Date("2026-09-24T14:00:00.000Z")
    const segments: EventChange[] = [
      {
        status: "merged",
        commit: HEAD,
        merge: firstRoot,
        since: first,
        at: first,
        endedAt: first,
        ending: { kind: "merged", id: "e".repeat(40) },
      },
      {
        status: "merged",
        commit: HEAD,
        merge: laterRoot,
        since: later,
        at: later,
        endedAt: later,
        ending: { kind: "merged", id: "f".repeat(40) },
      },
    ]
    const listed = eventListRows(new Map([["task/unproven", segments]]), [], { now: later })
    for (const rows of [listed.table, listed.document]) {
      expect(rows.map((row) => row.since)).toEqual([later, first])
      // Both retained endings must be independently selectable by the watch.
      expect(new Set(watchRows(rows).map(watchRowKey)).size).toBe(rows.length)
      for (const row of rows) {
        expect(row.duplicates).toBeUndefined()
        for (const evidence of [
          "task/unproven",
          diagnostic,
          "e".repeat(40),
          "f".repeat(40),
          firstRoot ?? "missing",
          laterRoot ?? "missing",
        ]) {
          expect(row.diagnostic).toContain(evidence)
        }
      }
    }
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
    const mergedWithoutMerge = {
      status: "merged" as const,
      commit: HEAD,
      candidate,
      since: new Date(TIME),
      at: new Date(TIME),
      endedAt: new Date(TIME),
    }
    const rows = eventRows(
      new Map<string, EventChange>([
        ["task/checking", checking],
        ["task/merged", merged],
        ["task/merged-without-merge", mergedWithoutMerge],
      ]),
    )
    expect(rows.find((r) => r.branch === "task/checking")?.merge).toBeUndefined()
    expect(rows.find((r) => r.branch === "task/checking")?.run).toBeUndefined()
    expect(rows.find((r) => r.branch === "task/merged")?.merge).toBe(targetMerge)
    expect(rows.find((r) => r.branch === "task/merged")?.run).toBe(runId)
    expect(rows.find((r) => r.branch === "task/merged-without-merge")?.merge).toBeUndefined()
  })
})
