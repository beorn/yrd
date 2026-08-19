// @failure A non-PR queue record renders as pr#yrdpin#357 — the tool asserting a false kind
// @level l2
// @consumer @yrd/cli

import { formatChangeRevisionSelector } from "@yrd/bay"
import { queueMemberKind } from "@yrd/queue"
import type { Event } from "loggily"
import { createElement } from "react"
import { renderString } from "silvery"
import { describe, expect, it } from "vitest"
import { fixturePr, fixtureResult, fixtureRun, fixtureSnapshot } from "../dev/queue-timeline-fixtures.ts"
import { formatResidentLogLine } from "../src/runner-timeline.ts"
import { formatQueueChangeId, QueueTimelineView, type QueueTimelineProjection } from "../src/queue-status-view.tsx"

/** A pin-advance record's real id shape, per IntentRecordIdSchema. */
const GITLINK_ID = "yrdpin#357"
const INTENT_ID = "I148"
const PR_ID = "PR182"

/** A pin-advance record that reached the queue as a run member — the row where
 * a gitlink id actually arrives at the renderer. */
function gitlinkProjection(): QueueTimelineProjection {
  const record = fixturePr(GITLINK_ID, "integrated", "2026-07-13T11:30:00.000Z", "Pin advance", {
    integratedAt: "2026-07-13T11:45:00.000Z",
  })
  const run = fixtureRun("R900", [record], "passed", "2026-07-13T11:30:00.000Z", {
    finishedAt: "2026-07-13T11:45:00.000Z",
  })
  return fixtureSnapshot(fixtureResult([record], [run])).projection
}

describe("queueMemberKind — the one discrimination, from the schemas the mints write through", () => {
  it("tells a PR from a pin-advance record", () => {
    expect(queueMemberKind(PR_ID)).toBe("pr")
    expect(queueMemberKind(GITLINK_ID)).toBe("gitlink")
    expect(queueMemberKind(INTENT_ID)).toBe("gitlink")
  })

  it("answers undefined for an id neither schema claims, rather than guessing pr", () => {
    // A silent default to "pr" is exactly the failure being fixed: the renderer
    // asserting a kind nothing established.
    expect(queueMemberKind("topic/whatever")).toBeUndefined()
    expect(queueMemberKind("")).toBeUndefined()
  })
})

describe("a renderer never asserts a kind the record does not carry", () => {
  it("does not prefix a pin-advance record with pr#", () => {
    // The reported defect verbatim: `pr#yrdpin#357`. The prefix is false AND it
    // stutters (@i/10-merge-queue/22924-pr-prefix-on-non-pr).
    const rendered = formatChangeRevisionSelector(GITLINK_ID, 1)
    expect(rendered).not.toContain("pr#")
    expect(rendered).toBe(`${GITLINK_ID}.1`)
  })

  it("does not prefix a bare intent record with pr#", () => {
    expect(formatChangeRevisionSelector(INTENT_ID, 2)).not.toContain("pr#")
  })

  it("still renders a real PR with its canonical copy-pasteable identity", () => {
    // The discrimination must not cost the PR path its selector round-trip.
    expect(formatChangeRevisionSelector(PR_ID, 1)).toBe("pr#182.1")
    expect(formatChangeRevisionSelector("182", 3)).toBe("pr#182.3")
  })

  it("covers the queue timeline call site, which shares the one formatter", () => {
    expect(formatQueueChangeId(GITLINK_ID, 1)).not.toContain("pr#")
    expect(formatQueueChangeId(PR_ID, 1)).toBe("pr#182.1")
  })

  it("covers the JSX identity cell, which asserted the kind separately", async () => {
    // The text path and the JSX path are two renderers of one identity. Fixing
    // only the formatter would leave `NounId noun="pr"` printing the same false
    // kind in the queue timeline — the surface the bead is actually about.
    const frame = await renderString(
      createElement(QueueTimelineView, { projection: gitlinkProjection(), columns: 160 }),
      {
        width: 160,
        height: 30,
        plain: true,
      },
    )

    expect(frame).toContain(GITLINK_ID)
    expect(frame).not.toContain(`pr#${GITLINK_ID}`)
  })

  it("covers the resident runner-timeline call site", () => {
    const event = {
      kind: "log",
      namespace: "yrd:queue:run",
      level: "info",
      message: "run started",
      time: "2026-08-17T12:00:00.000Z",
      props: { run: "R1", prs: [{ pr: GITLINK_ID, revision: 1 }] },
    } as unknown as Event
    expect(formatResidentLogLine(event, { color: false }) ?? "").not.toContain("pr#")
  })
})
