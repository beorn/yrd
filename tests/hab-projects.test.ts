/**
 * @failure Hab queue-runner declarations drift into implicit paths or commands whose argv no longer identifies the repository they operate on.
 * @level l2
 * @consumer Hallohuman Hab composition loading vendor/yrd/hab.projects.ts
 */
import { describe, expect, it } from "vitest"
import hab, { yrdQueueRunnerDeclarations } from "../hab.projects.ts"

describe("Yrd Hab runner declarations", () => {
  it("declares one supervised service whose repository, argv, owner and exit policy are explicit", () => {
    expect(yrdQueueRunnerDeclarations).toEqual([
      { serviceName: "yrd-service", repository: { name: "code", path: "." }, queue: { base: "main" }, owner: "@ci" },
    ])
    expect(hab.services).toEqual({
      "yrd-service": {
        command: "bun tools/yrd-runtime.mjs yrd queue up --interval 120",
        env: { TRIBE_NAME: "@yrd-service", YRD_HABITANT_RSS_CAP_MB: "24576" },
        // The declared health probe, added by @i/10-yrd/24395. M7's 2026-09-03
        // objection — a probe is noise with a SECOND OPINION — is answered
        // rather than overruled: this one re-derives nothing. It reads the one
        // document the loop itself wrote, touches no network and captures no
        // declaration, so it cannot disagree with the loop about the queue.
        health: { command: "bun tools/yrd-runtime.mjs yrd queue health" },
        // Garage eligibility, added by @dev/11 for @i/10-yrd/24147. It lives on
        // the SERVICE rather than in a /garage table, so this assertion is where
        // it is pinned.
        garage: {
          ledgerRoot: "/home/hh/scratch",
          leaveRule:
            "ten queue runs in a row that needed no explaining, with at least one merge and one fail among them",
        },
        // The queue relaunches only after an ending the loop chose: 0 for a
        // clean round/gitlink recycle, or 1 for a candidate failure. Exit 2 is
        // now reserved for what NO round can fix — an absent or unreadable
        // declaration, an absent runtime gitlink — because 24395 made a STUCK
        // ROUND a round outcome rather than a process one: the loop survives it
        // and the alarm moved to the health document above. Any signal remains
        // an unplanned host-level interruption; both stay down and page the
        // declared owner instead of repeating an unmeasured fault.
        restart: "on-codes",
        relaunchExitCodes: [0, 1],
        // @ci, not @cto, since b9ed888207 (24395 item 5): the owner decides who
        // is woken, and @cto authors nothing and cannot act on a queue page.
        owner: "@ci",
      },
    })
  })
})
