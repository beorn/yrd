// @failure an event queue lists a branch with an old record state or silently omits a change without a submitted commit.
// @level l1
// @consumer yrd list, show and watch on event queues

import { describe, expect, it } from "vitest"
import type { Event } from "gitomic/events"
import { evolve, initial } from "../src/events.ts"
import { eventRows } from "../src/event-table.ts"

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
    const opened = evolve(initial, event("opened", QUEUE, [["Commit", HEAD]], [HEAD]))
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
      { branch: "task/check", head: HEAD, state: "checking" },
      { branch: "task/drop", head: HEAD, state: "cancelled", reason: "dropped" },
    ])
  })

  it("names a branch whose selected chain has no submitted commit", () => {
    expect(() => eventRows(new Map([["task/missing", initial]]))).toThrow(/task\/missing.*submitted commit/)
  })
})
