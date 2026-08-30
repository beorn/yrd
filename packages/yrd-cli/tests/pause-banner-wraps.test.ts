/**
 * @failure The HOLD THE LINE / PAUSE BLOCKING EVERYTHING banner truncates at
 * the pane width, and a hold's reason is where its checkable predicate and its
 * release condition live — so the narrower the pane, the earlier the sentence
 * is cut, and it is cut exactly at the part a reader needs. Measured cost:
 * four failed recovery attempts and ~90 minutes on 2026-08-01
 * (@yrd/stopline-truncates-its-predicate, @yrd/hold-status-truncates-its-own-instruction).
 * @level l2
 * @consumer @yrd/cli watch, queue status
 *
 * Asserts on RENDERED bytes at a narrow width, never on the source string —
 * the 2026-08-27 ADR's rendered-bytes obligation, and the only assertion that
 * can tell a wrapped banner from a truncated one at all.
 */
import { createElement } from "react"
import { createRenderer } from "silvery/test"
import { describe, expect, it } from "vitest"
import { fixturePr, fixtureResult } from "../dev/queue-timeline-fixtures.ts"
import {
  QueueTimelineView,
  queueTimelineAdmissionTimes,
  queueTimelineProjection,
  type QueueTimelineProjection,
} from "../src/queue-status-view.tsx"

const NOW = Date.parse("2026-07-14T12:00:00.000Z")

/** A hold reason of the shape that actually gets recorded: the condition, the
 * predicate a reader checks, and the release. Every one of those clauses is
 * past column 60. */
const REASON =
  "gitlink batches 1-3b are landing serially; hold until origin/main gitlink equals 64d85d16, " +
  "then resume with yrd queue resume main"

function pausedProjection(): QueueTimelineProjection {
  const prs = [fixturePr("PR1", "submitted", "2026-07-14T11:10:00.000Z", "Subject")]
  const result = fixtureResult(prs, [])
  const projection = queueTimelineProjection([result], {
    now: NOW,
    windowMs: 100 * 365 * 24 * 60 * 60_000,
    statuses: [],
    terms: [],
    latest: false,
    rowLimit: 20,
    submissionTimes: queueTimelineAdmissionTimes([result]),
    runner: { pid: 4242, startedAt: "2026-07-14T11:00:00.000Z", lastTickAt: "2026-07-14T11:59:58.000Z" },
  })
  return {
    ...projection,
    pause: {
      base: "main",
      reason: REASON,
      allowedPRs: [],
      pausedAt: "2026-07-14T11:30:00.000Z",
    },
  }
}

/** The screen as a reader reads it: a wrapped banner spans rows, and the box
 * frame sits between them, so both the row breaks and the frame glyphs come
 * out before matching. This is the difference between wrapped and truncated —
 * a reader reads across a wrap and cannot read across a truncation. */
function flatten(text: string): string {
  return text
    .split("\n")
    .map((row) => row.replaceAll(/[│╭╮╰╯─]/gu, " "))
    .join(" ")
    .replaceAll(/\s+/gu, " ")
}

/** Only the hold banner's own rows — the rails above it (STRANDED, PROGRESS)
 * legitimately clip, and this bead does not change them. */
function bannerRows(text: string): readonly string[] {
  const rows = text.split("\n")
  // Anchored on the label's FIRST word, not the whole phrase: at a
  // pathological width the label itself wraps ("HOLD" / "THE" / "LINE —"), and
  // a finder that needs the phrase on one row reports zero banner rows exactly
  // where the bound is being measured.
  const start = rows.findIndex((row) => /\bHOLD\b|\bPAUSE\b/u.test(row))
  if (start < 0) return []
  const rest = rows.slice(start)
  const end = rest.findIndex((row) => row.includes("╰"))
  return end < 0 ? rest : rest.slice(0, end)
}

async function bannerText(cols: number): Promise<string> {
  const render = createRenderer({ cols, rows: 40 })
  const app = render(
    createElement(QueueTimelineView, {
      projection: pausedProjection(),
      columns: cols,
      paneChrome: true,
      fillHeight: true,
      nav: true,
      cursorKey: 0,
    }),
  )
  try {
    await app.waitForLayoutStable()
    return app.text
  } finally {
    app.unmount()
  }
}

describe("the queue hold banner wraps instead of truncating", () => {
  for (const cols of [60, 80, 120]) {
    it(`renders the whole reason at ${cols} columns, ellipsis-free`, async () => {
      const text = await bannerText(cols)
      expect(text, "the banner renders at all").toContain("HOLD THE LINE")
      const flattened = flatten(text)
      expect(flattened, "the checkable predicate survives").toContain("origin/main gitlink equals 64d85d16")
      expect(flattened, "the release condition survives").toContain("yrd queue resume main")
      expect(flattened, "the allowed-list clause survives").toContain("allowed none")
      const rows = bannerRows(text)
      expect(rows.length, "the banner's own rows are found").toBeGreaterThan(0)
      expect(rows.join("\n"), "nothing in the banner is elided").not.toMatch(/…|\.\.\./u)
    })
  }

  it("bounds its rows so a pathological pane keeps its frame — wrapping must not starve the view", async () => {
    // 12 columns is not a reading width; it is the width at which an unbounded
    // wrap pushed the TIME header off a 24-row pane entirely
    // (queue-timeline-chrome). The banner still wraps to several rows there —
    // it is bounded, not returned to one truncated line.
    const text = await bannerText(12)
    const rows = bannerRows(text)
    expect(rows.length, "still wraps to multiple rows").toBeGreaterThan(1)
    expect(rows.length, "and never grows without limit").toBeLessThanOrEqual(8)
  })

  it("is the NARROW pane that used to lose it — the same reason survives 60 and 120 alike", async () => {
    const narrow = flatten(await bannerText(60))
    const wide = flatten(await bannerText(120))
    for (const clause of ["hold until", "origin/main gitlink equals 64d85d16", "yrd queue resume main"]) {
      expect(narrow, `'${clause}' at 60 columns`).toContain(clause)
      expect(wide, `'${clause}' at 120 columns`).toContain(clause)
    }
  })
})
