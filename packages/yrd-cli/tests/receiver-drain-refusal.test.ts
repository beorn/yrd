/**
 * @failure Two failures of the same 2026-09-01 incident. (1) The runtime dies on an undrained receiver
 *          inbox with one bare `error:` stderr line naming an opaque 64-hex id — no ERROR-level row for a
 *          log reader to count, no branch, ref, head, age or file, and no word that a re-push does not
 *          clear an ambiguous entry. (2) It DIES AT ALL on an ambiguous entry: entry 816c247d… blocked
 *          every queue pass for an hour while eight eligible changes waited behind a row none of them had
 *          anything to do with. The level and the disposition are one decision here, so a row reported as
 *          skipped can never be followed by a refusal anyway.
 * @level l1
 * @consumer @yrd/cli queue-run operators reading a pass log
 */
import { describe, expect, it } from "vitest"
import { createLogger, type Event } from "loggily"
import type { ReceiverAmbiguousResult } from "@yrd/bay"
import { reportReceiverDrainOutcome } from "../src/receiver-drain-refusal.ts"

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

describe("receiver drain outcome", () => {
  it("logs one row per entry naming id, ref, branch, head, age, file and the re-push fact", () => {
    const events: Event[] = []
    const root = createLogger("yrd", [{ level: "trace" }, { write: (event: Event) => events.push(event) }])
    const log = root.child("receiver")
    const stranded = ambiguous(
      "816c247dbbf34deb36dd4348fb3c9d417c1c4bda44dfdbf65d797b759d79c563",
      "issue/23300-drain",
      27,
    )
    const fresh = ambiguous("2e9f1c0a5d7b4e8f9a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071", "issue/23301-other", 3)

    const refusal = reportReceiverDrainOutcome(
      log,
      { ambiguous: [stranded, fresh], failed: [{ id: "f00d".repeat(16), error: "authorization changed" }] },
      NOW,
    )
    log.end()

    // The LEVEL carries the disposition: an ambiguous entry is skipped and warns,
    // a failed entry is fatal and errors. Reading them at one level was what made
    // "the queue is down" and "one push did not land" indistinguishable.
    const skipped = events.filter((event): event is LogEvent => event.kind === "log" && event.level === "warn")
    const fatal = events.filter((event): event is LogEvent => event.kind === "log" && event.level === "error")
    expect(skipped).toHaveLength(2)
    expect(fatal).toHaveLength(1)

    // The ambiguous entry: the instance in the message, the constant action plus
    // every fact the prepared JSON carries in the fields.
    expect(skipped[0]).toMatchObject({
      namespace: "yrd:receiver",
      props: {
        action: "receiver-drain-ambiguous",
        disposition: "skipped",
        id: stranded.id,
        path: stranded.path,
        ref: "refs/heads/issue/23300-drain",
        branch: "issue/23300-drain",
        headSha: stranded.headSha,
        receivedAt: stranded.receivedAt,
        ageMinutes: 27,
      },
    })
    const message = String(skipped[0]?.message)
    expect(message).toContain("entry 816c247dbbf3 ")
    expect(message).toContain("branch 'issue/23300-drain'")
    expect(message).toContain("27 min ago")
    expect(message).toContain("refs/heads/issue/23300-drain does not contain 816c247d0000")
    expect(message).toContain(stranded.path)
    expect(message).toContain("Pushing the branch again does NOT clear it")
    // It must also say what it DID, or a reader assumes the old fatal behaviour.
    expect(message).toContain("SKIPPED")
    expect(message).toContain("the rest of the inbox drained")
    expect(message).not.toContain("\n")

    // The uniqueness test: two rows of the same kind never read identically.
    expect(skipped[1]?.props).toMatchObject({ action: "receiver-drain-ambiguous", id: fresh.id, ageMinutes: 3 })
    expect(String(skipped[1]?.message)).not.toBe(message)
    expect(String(skipped[1]?.message)).toContain("3 min ago")

    // A failed entry names its own cause, never the ambiguous wording.
    expect(fatal[0]).toMatchObject({
      props: { action: "receiver-drain-failed", disposition: "fatal", id: "f00d".repeat(16), error: "authorization changed" },
    })
    expect(String(fatal[0]?.message)).toContain("failed to drain: authorization changed")
    expect(String(fatal[0]?.message)).not.toContain("ambiguous")

    // The refusal the runtime dies with keeps the old lead-in (log readers grep
    // for it) and names the failed entries and the cure, no longer a JSON blob of
    // ids — and no longer the ambiguous ones, which did not stop anything.
    expect(refusal?.message).toMatch(/^yrd: receiver inbox did not drain cleanly: 1 failed entry/u)
    expect(refusal?.message).toContain("f00df00df00d (authorization changed)")
    expect(refusal?.message).not.toContain("816c247dbbf3")
    expect(refusal?.message).not.toContain("{")
  })

  it("does NOT refuse when every entry is merely ambiguous", () => {
    // The incident, as one assertion. An interrupted push leaves an entry no
    // later pass can confirm; `recoverPrepared` retries it every drain, so it is
    // not wreckage and must not take the runtime down with it. Eight eligible
    // changes waited an hour behind exactly this.
    const events: Event[] = []
    const root = createLogger("yrd", [{ level: "trace" }, { write: (event: Event) => events.push(event) }])
    const log = root.child("receiver")

    const refusal = reportReceiverDrainOutcome(
      log,
      { ambiguous: [ambiguous("a".repeat(64), "issue/interrupted", 61)], failed: [] },
      NOW,
    )
    log.end()

    expect(refusal).toBeUndefined()
    // Skipped, not silent: the entry is still named, at WARN, with its age.
    const rows = events.filter((event): event is LogEvent => event.kind === "log")
    expect(rows.map((row) => row.level)).toEqual(["warn"])
    expect(rows[0]?.props).toMatchObject({
      action: "receiver-drain-ambiguous",
      disposition: "skipped",
      ageMinutes: 61,
    })
  })

  it("says nothing at all when the inbox drained cleanly", () => {
    const events: Event[] = []
    const root = createLogger("yrd", [{ level: "trace" }, { write: (event: Event) => events.push(event) }])
    const log = root.child("receiver")

    expect(reportReceiverDrainOutcome(log, { ambiguous: [], failed: [] }, NOW)).toBeUndefined()
    log.end()
    expect(events.filter((event) => event.kind === "log")).toEqual([])
  })
})
