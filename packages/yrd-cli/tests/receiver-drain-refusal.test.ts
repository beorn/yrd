/**
 * @failure The runtime dies on an undrained receiver inbox with one bare `error:` stderr line naming an
 *          opaque 64-hex id — no ERROR-level row for a log reader to count, no branch, ref, head, age or
 *          file, and no word that a re-push does not clear an ambiguous entry (2026-09-01, entry 816c247d…
 *          blocked every queue pass for an hour while its owner re-pushed).
 * @level l1
 * @consumer @yrd/cli queue-run operators reading a pass log
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event } from "loggily"
import type { ReceiverAmbiguousResult } from "@yrd/bay"
import { reportReceiverDrainRefusal } from "../src/receiver-drain-refusal.ts"

const NOW = Date.parse("2026-09-01T17:50:05.000-07:00")

function ambiguous(id: string, branch: string, minutesOld: number): ReceiverAmbiguousResult {
  return {
    id,
    path: `/srv/code/.yrd/receiver-inbox/${id}.prepared.json`,
    ref: `refs/heads/${branch}`,
    branch,
    headSha: `${id.slice(0, 8)}0000000000000000000000000000000a`,
    receivedAt: new Date(NOW - minutesOld * 60_000).toISOString(),
  }
}

type LogEvent = Extract<Event, { kind: "log" }>

describe("receiver drain refusal", () => {
  it("logs one ERROR row per entry naming id, ref, branch, head, age, file and the re-push fact, then refuses", () => {
    const events: Event[] = []
    const root = createLogger("yrd", [{ level: "trace" }, { write: (event: Event) => events.push(event) }])
    const log = root.child("receiver")
    const stranded = ambiguous(
      "816c247dbbf34deb36dd4348fb3c9d417c1c4bda44dfdbf65d797b759d79c563",
      "issue/23300-drain",
      27,
    )
    const fresh = ambiguous("2e9f1c0a5d7b4e8f9a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071", "issue/23301-other", 3)

    const refusal = reportReceiverDrainRefusal(
      log,
      { ambiguous: [stranded, fresh], failed: [{ id: "f00d".repeat(16), error: "authorization changed" }] },
      NOW,
    )
    log.end()

    const rows = events.filter((event): event is LogEvent => event.kind === "log" && event.level === "error")
    expect(rows).toHaveLength(3)

    // The ambiguous entry: the instance in the message, the constant action plus
    // every fact the prepared JSON carries in the fields.
    expect(rows[0]).toMatchObject({
      namespace: "yrd:receiver",
      props: {
        action: "receiver-drain-ambiguous",
        id: stranded.id,
        path: stranded.path,
        ref: "refs/heads/issue/23300-drain",
        branch: "issue/23300-drain",
        headSha: stranded.headSha,
        receivedAt: stranded.receivedAt,
        ageMinutes: 27,
      },
    })
    const message = String(rows[0]?.message)
    expect(message).toContain("entry 816c247dbbf3 ")
    expect(message).toContain("branch 'issue/23300-drain'")
    expect(message).toContain("27 min ago")
    expect(message).toContain("refs/heads/issue/23300-drain does not contain 816c247d0000")
    expect(message).toContain(stranded.path)
    expect(message).toContain("pushing the branch again does NOT clear it")
    expect(message).not.toContain("\n")

    // The uniqueness test: two rows of the same kind never read identically.
    expect(rows[1]?.props).toMatchObject({ action: "receiver-drain-ambiguous", id: fresh.id, ageMinutes: 3 })
    expect(String(rows[1]?.message)).not.toBe(message)
    expect(String(rows[1]?.message)).toContain("3 min ago")

    // A failed entry names its own cause, never the ambiguous wording.
    expect(rows[2]).toMatchObject({
      props: { action: "receiver-drain-failed", id: "f00d".repeat(16), error: "authorization changed" },
    })
    expect(String(rows[2]?.message)).toContain("failed to drain: authorization changed")
    expect(String(rows[2]?.message)).not.toContain("ambiguous")

    // The refusal the runtime dies with keeps the old lead-in (log readers grep
    // for it) and names every entry and the cure, no longer a JSON blob of ids.
    expect(refusal.message).toMatch(/^yrd: receiver inbox did not drain cleanly: 2 ambiguous prepared entries/u)
    expect(refusal.message).toContain("816c247dbbf3 (branch 'issue/23300-drain', 27 min old)")
    expect(refusal.message).toContain("2e9f1c0a5d7b (branch 'issue/23301-other', 3 min old)")
    expect(refusal.message).toContain("a re-push does NOT clear them")
    expect(refusal.message).toContain("1 failed entry — f00df00df00d (authorization changed)")
    expect(refusal.message).not.toContain("{")
  })
})
