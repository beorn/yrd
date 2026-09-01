/**
 * @failure The projection stamped a settle from a DEAD run onto a revision that
 * had already been re-submitted past it. `branch/submitted` moves `submittedAt`
 * forward and clears `terminal`; a run that died can still emit its settle
 * afterwards, carrying its own older `ts`. Stamping it put a finish on the
 * revision describing an admission that was over — which held the change out of
 * the queue (`requestedPRs` admits only `submitted`/`ready`) and made every age
 * measured to it negative.
 * @level l1
 * @consumer @yrd/bay the change projection; @yrd/queue admission
 *
 * WHAT IS PINNED — both halves.
 *
 * REFUSED: a run-attributed non-landing settle whose clock predates the
 * revision's own submit fact is not stamped. The change keeps its re-submitted
 * state, `rejectedAt` stays cleared, and it stays admissible.
 *
 * RECORDED: the refused settle is written to `supersededTerminal` on that
 * revision, carrying its kind, its clock and the run it came from — never
 * dropped. With the revision and the change it sits on, that is every field
 * needed to say what was refused and why.
 *
 * WHY IT REFUSES RATHER THAN THROWS. `projectBays` is a reducer: it runs on
 * every replay, not only on live append, and the live journal already holds
 * such a row. A throw here would make that journal unreplayable. The narrowing
 * to run-attributed non-landing settles is deliberate too — an operator's own
 * withdraw or cancel carries no run and is a decision being made now, and a
 * landing settle is a claim about the repository that outranks any submit
 * clock. Both still apply in full.
 */
import { describe, expect, it } from "vitest"
import { Command, createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs } from "@yrd/job"
import { createLogger } from "loggily"

import { changeDeliveryState, currentChangeRev } from "../src/model.ts"
import { createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace } from "../src/plugin.ts"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const RUN = "R3675"
const PUSHED_AT = "2026-08-30T21:00:00.000Z"
const FIRST_SUBMIT_AT = "2026-08-30T22:00:00.000Z"
/** The dead run's settle, stamped with its own older clock. */
const SETTLE_AT = "2026-08-30T22:56:51.000Z"
/** The re-submission that landed BEFORE the settle was applied. */
const RESUBMIT_AT = "2026-09-01T18:40:25.870Z"

const silentLog = createLogger("test", [{ level: "silent" }])

function ids(): () => string {
  let value = 0
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

const workspace: BayWorkspace = {
  revision: "test-workspace-v1",
  provision: () => ({ status: "completed", conclusion: "success", output: { path: "/repo/.bays/b", headSha: HEAD, baseSha: BASE } }),
  refresh: () => ({ status: "completed", conclusion: "success", output: { path: "/repo/.bays/b", headSha: HEAD, baseSha: BASE, dirty: false } }),
  checkpoint: () => ({ status: "completed", conclusion: "success", output: { headSha: HEAD, pushed: true, wip: false } }),
  deprovision: () => ({ status: "completed", conclusion: "success", output: { preserved: false } }),
} as unknown as BayWorkspace

/**
 * Replay one journal whose events are ordered as the live one was: push,
 * submit, the run's settle, the RE-SUBMISSION, and then the dead run's settle
 * arriving last with its original older clock.
 */
async function replay(settleLast: boolean) {
  const nextId = ids()
  const seeded = { id: nextId(), op: "fixture.late-settle" }
  const at = PUSHED_AT
  const rejected = (ts: string) => ({
    id: nextId(),
    name: "pr/rejected",
    ts,
    data: { pr: "PR1", revision: 1, headSha: HEAD, run: RUN, step: "check", detail: "check failed" },
  })
  const submitted = (ts: string) => ({
    id: nextId(),
    name: "pr/submitted",
    ts,
    data: { pr: "PR1", revision: 1, headSha: HEAD },
  })
  const journal = createMemoryJournal([
    {
      command: seeded,
      cause: { id: nextId(), commandId: seeded.id, op: seeded.op, commandHash: Command.hash(seeded) },
      events: [
        {
          id: nextId(),
          name: "pr/pushed",
          ts: at,
          data: { pr: "PR1", branch: "task/w28-silentsites", base: "main", headSha: HEAD, revision: 1 },
        },
        submitted(FIRST_SUBMIT_AT),
        // The ordinary control stamps the settle and stops there. The late
        // case re-submits first, so the settle that follows is a previous
        // admission's.
        ...(settleLast ? [submitted(RESUBMIT_AT), rejected(SETTLE_AT)] : [rejected(SETTLE_AT)]),
      ],
    },
  ] as never)

  const jobs = createBayJobDefs(workspace)
  const definition = pipe(
    createYrdDef(),
    withJobs({ definitions: jobs }),
    withBays({ prNumberMint: volatilePrNumberMint(), jobs, defaultBase: "main" }),
  )
  return createYrd(definition, {
    inject: { journal, clock: () => RESUBMIT_AT, id: ids(), log: silentLog },
  })
}

describe("late-settle writer guard — a dead run's settle is recorded, never stamped", () => {
  it("REFUSES the stamp: the re-submitted change stays submitted and admissible", async () => {
    await using app = await replay(true)
    const pr = app.bays.pr("PR1")
    expect(pr).toBeDefined()
    expect(changeDeliveryState(pr!)).toBe("submitted")
    expect(pr?.rejectedAt).toBeUndefined()
    expect(currentChangeRev(pr!).terminal).toBeUndefined()
    // The exact predicate the implicit-queue selection applies.
    const delivery = changeDeliveryState(pr!)
    expect(delivery === "submitted" || delivery === "ready").toBe(true)
  })

  it("RECORDS the refusal: kind, clock and run are all kept on the revision", async () => {
    await using app = await replay(true)
    const revision = currentChangeRev(app.bays.pr("PR1")!)
    expect(revision.supersededTerminal).toEqual({ kind: "rejected", at: SETTLE_AT, run: RUN })
    // Named alongside the revision and change that carry it, which is every
    // field a reader needs to say what was refused.
    expect(revision.n).toBe(1)
    expect(revision.head).toBe(HEAD)
    expect(revision.submittedAt).toBe(RESUBMIT_AT)
  })

  it("a settle that FOLLOWS its submit fact is stamped exactly as before", async () => {
    await using app = await replay(false)
    const pr = app.bays.pr("PR1")
    expect(changeDeliveryState(pr!)).toBe("rejected")
    expect(pr?.rejectedAt).toBe(SETTLE_AT)
    expect(currentChangeRev(pr!).terminal).toMatchObject({ kind: "rejected", at: SETTLE_AT })
    expect(currentChangeRev(pr!).supersededTerminal).toBeUndefined()
  })
})
