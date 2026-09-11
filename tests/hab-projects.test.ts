/**
 * @failure Hab queue-runner declarations drift into implicit paths or commands whose argv no longer identifies the repository they operate on.
 * @level l2
 * @consumer Hallohuman Hab composition loading vendor/yrd/hab.projects.ts
 */
import { describe, expect, it } from "vitest"
import hab, { yrdQueueRunnerDeclarations } from "../hab.projects.ts"

/**
 * ASSERT THE REQUIREMENTS, NEVER THE WHOLE DECLARATION (@cto 2026-09-11).
 *
 * This file used to `toEqual` the entire object, which made it a SECOND COPY of
 * `hab.projects.ts`: every edit there had to be made twice, and the copy could
 * only ever agree with the original. What that proved was "this file did not
 * change" — which is not a requirement anybody has.
 *
 * It cost three hand-patches in one day (2026-09-11): an owner line, a health
 * probe whose arrival left a stale "no health probe" comment behind, and a
 * `garage` row. Each author found out from a red main they had never run. The
 * answer is not a co-change guard — that would make the double edit MANDATORY
 * instead of removing it — it is to stop keeping the copy.
 *
 * So every assertion below names the requirement it defends, and adding a field
 * to the declaration breaks nothing that is not one. Both halves are verified:
 * an unanticipated new field leaves all five green, and dropping exit 0 fails
 * the relaunch row.
 */
describe("Yrd Hab runner declarations", () => {
  it("names the repository it operates on, explicitly", () => {
    // The @failure above, exactly: a declaration that does not say WHICH
    // repository it runs against is the drift this file exists to catch.
    expect(yrdQueueRunnerDeclarations).toHaveLength(1)
    expect(yrdQueueRunnerDeclarations[0]).toMatchObject({
      serviceName: "yrd-service",
      repository: { name: "code", path: "." },
      queue: { base: "main" },
    })
  })

  it("runs an argv that identifies what it operates on", () => {
    // Not the cadence — that is DECLARED here, and re-spelling it made every
    // interval change a two-repository atomic landing (measured 2026-09-10).
    // What must hold is that the argv names the runtime entry and the verb.
    expect(hab.services["yrd-service"]?.command).toMatch(/^bun tools\/yrd-runtime\.mjs yrd queue up\b/u)
  })

  it("declares a health probe", () => {
    // Added by @i/10-yrd/24395. M7's 2026-09-03 objection — a probe is noise
    // with a SECOND OPINION — is answered rather than overruled: this one
    // re-derives nothing, reads the one document the loop itself wrote, touches
    // no network and captures no declaration. Its COMMAND is the requirement;
    // what it prints belongs to the health contract, not to this file.
    expect(hab.services["yrd-service"]?.health?.command).toBeDefined()
  })

  it("relaunches only on endings the loop chose, and stays down on the rest", () => {
    const service = hab.services["yrd-service"]
    expect(service?.restart).toBe("on-codes")
    // 0 is the SELF-RELAUNCH exit (@i/10-yrd/24515): the loop exits 0 when its
    // own gitlink moves and the supervisor respawns it on the new code. That
    // ran in production three times on 2026-09-11 with nobody's hands on it,
    // and it stops working the moment 0 leaves this list.
    expect(service?.relaunchExitCodes).toContain(0)
    // 1 is a candidate failure — the next round clears it.
    expect(service?.relaunchExitCodes).toContain(1)
    // 2 must NOT be here. It is reserved for what no round can fix — an absent
    // or unreadable declaration, an absent runtime gitlink — because 24395 made
    // a stuck ROUND a round outcome rather than a process one. Listing 2 would
    // restart the service into the same unfixable state forever.
    expect(service?.relaunchExitCodes).not.toContain(2)
  })

  it("names an owner who can be woken", () => {
    // The owner decides who is PAGED. An undeclared owner silently resolves to
    // the fleet-wide default, so a service that means to name someone must.
    expect(hab.services["yrd-service"]?.owner).toBeDefined()
  })
})
