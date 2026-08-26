/**
 * @failure A refusal prints a remedy the emitting state refuses to run — the
 * PR1189 wedge: `pr recut --preflight` on a `ready` change whose origin branch
 * is gone printed `yrd pr publish <id>`, which admits `pushed` only and answers
 * `change '<id>' is ready, not pushed`. Naming a command that refuses is the
 * same defect as naming none.
 * @level l1
 * @consumer @yrd/cli refusal remedies
 */
import { describe, expect, it } from "vitest"
import { createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace, type ChangeDeliveryState } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import { withQueue, withStep, type StepExecution } from "@yrd/queue"
import { createLogger } from "loggily"
import * as z from "zod"
import {
  remedyAdmissibleIn,
  unobservableBranchRemedy,
  REMEDY_VERB_ADMISSIBLE_STATES,
  type RemedyVerb,
} from "../src/remedy-admissibility.ts"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const CheckResultSchema = z.object({ checked: z.boolean() }).strict()

/** Every delivery state, spelled out. A new state added to the union without a
 * row here fails `exhaustive` below rather than silently skipping the walk. */
const ALL_DELIVERY_STATES: readonly ChangeDeliveryState[] = [
  "pushed",
  "submitted",
  "ready",
  "needs-author",
  "rejected",
  "integrated",
  "already-landed",
  "withdrawn",
  "canceled",
]

function ids(): () => string {
  let value = 0
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace(): BayWorkspace {
  return {
    revision: "test-workspace-v1",
    provision: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD, baseSha: BASE },
    }),
    refresh: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: HEAD, baseSha: BASE, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed",
      conclusion: "success",
      output: { headSha: HEAD, pushed: true, wip: false },
    }),
    deprovision: () => ({ status: "completed", conclusion: "success", output: {} }),
  }
}

async function createApp() {
  const checkStep = withStep(
    "check",
    (_input: StepExecution): JobResult<z.infer<typeof CheckResultSchema>> => ({
      status: "completed",
      conclusion: "success",
      output: { checked: true },
    }),
    { revision: "check-v1", output: CheckResultSchema },
  )
  const queue = withQueue({ steps: [checkStep] as const, batch: false, defaultSteps: ["check"] })
  const bayJobs = createBayJobDefs(workspace())
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ prNumberMint: volatilePrNumberMint(), jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: {
      journal: createMemoryJournal(),
      id: ids(),
      clock: () => "2026-08-26T00:00:00.000Z",
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
}

const RECORDED = { base: "main", baseSha: BASE, head: HEAD, n: 1 }

describe("every printed remedy is executable in the state that emits it", () => {
  it("names no verb its own guard would refuse, for every delivery state and both observation faults", () => {
    // The walk the bead asks for: each remedy-emitting state against the named
    // command's admission preconditions. `unobservableBranchRemedy` is the ONE
    // emitter for an unobservable branch, so walking its whole domain walks
    // every site.
    const offenders: string[] = []
    for (const delivery of ALL_DELIVERY_STATES) {
      for (const reason of ["absent", "unreachable"] as const) {
        const remedy = unobservableBranchRemedy(reason, { id: "PR1189", branch: "land-row83" }, delivery, RECORDED, "")
        if (remedy.verb !== undefined && !remedyAdmissibleIn(remedy.verb, delivery)) {
          offenders.push(`${reason}/${delivery} printed 'yrd pr ${remedy.verb}', which that state refuses`)
        }
        // A remedy that names no verb must still not smuggle one into its prose:
        // a pasted command line that refuses is the defect, whatever field it sits in.
        for (const verb of Object.keys(REMEDY_VERB_ADMISSIBLE_STATES) as RemedyVerb[]) {
          if (remedy.text.includes(`yrd pr ${verb} `) && !remedyAdmissibleIn(verb, delivery)) {
            offenders.push(`${reason}/${delivery} prose contains 'yrd pr ${verb}', which that state refuses`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("covers the whole delivery-state union, so a new state cannot skip the walk", () => {
    const exhaustive: Record<ChangeDeliveryState, true> = {
      pushed: true,
      submitted: true,
      ready: true,
      "needs-author": true,
      rejected: true,
      integrated: true,
      "already-landed": true,
      withdrawn: true,
      canceled: true,
    }
    expect([...ALL_DELIVERY_STATES].toSorted()).toEqual(Object.keys(exhaustive).toSorted())
  })

  it("the admissibility table matches what the real publish guard does", async () => {
    // Not a restatement of the table: this drives the actual command and reads
    // the actual refusal, so the table cannot drift away from the guard.
    const app = await createApp()
    await app.bays.submit({ branch: "land-row83", headSha: HEAD, base: "main", baseSha: BASE })
    const pr = app.bays.pr("PR1")
    if (pr === undefined) throw new Error("expected the submitted change")
    const delivery = "submitted" as const

    expect(remedyAdmissibleIn("publish", delivery)).toBe(false)
    // The exact PR1189 refusal, from the live guard.
    await expect(
      app.bays.requestPublication({
        pr: pr.id,
        revision: 1,
        headSha: HEAD,
        baseSha: BASE,
        branch: pr.branch,
        sourceRoot: "/repo",
        components: [],
        continuation: "none",
      }),
    ).rejects.toThrow(/is submitted, not pushed/u)
  })

  it("the admissibility table matches what the real withdraw guard does", async () => {
    const app = await createApp()
    await app.bays.submit({ branch: "land-row83", headSha: HEAD, base: "main", baseSha: BASE })

    // Admissible per the table, and the live guard agrees: the close succeeds.
    expect(remedyAdmissibleIn("withdraw", "submitted")).toBe(true)
    await app.bays.closePr({ pr: "PR1", reason: "source branch gone" })
    expect(app.bays.pr("PR1")?.state).toBe("closed")

    // Positive control: the terminal state the table refuses is refused live too.
    expect(remedyAdmissibleIn("withdraw", "withdrawn")).toBe(false)
    await expect(app.bays.closePr({ pr: "PR1", reason: "again" })).rejects.toThrow()
  })

  it("the PR1189 shape: a ready change whose branch is gone is told to withdraw, never to publish", () => {
    const remedy = unobservableBranchRemedy(
      "absent",
      { id: "PR1189", branch: "land-row83" },
      "ready",
      RECORDED,
      " --queue",
    )
    expect(remedy.verb).toBe("withdraw")
    expect(remedy.text).not.toContain("yrd pr publish")
    // Acceptance box 3: the disposal verb is DISCOVERABLE from the error text,
    // spelled with the flag that makes it run as pasted.
    expect(remedy.text).toContain("yrd pr withdraw PR1189 --burn-payload")
    expect(remedy.text).toContain("land-row83")
  })

  it("still names publish for the one state publish admits", () => {
    // The remedy is not deleted, it is state-correct: a change that never left
    // `pushed` genuinely is cured by publication, and that guard admits it.
    const remedy = unobservableBranchRemedy("absent", { id: "PR7", branch: "task/draft" }, "pushed", RECORDED, "")
    expect(remedy.verb).toBe("publish")
    expect(remedy.text).toContain("yrd pr publish PR7")
  })

  it("a transport fault on a submitted change asks for no change to the change", () => {
    // Origin being unreachable is not the change's fault; printing a delivery
    // verb here would be a wrong instruction wearing a remedy's clothes.
    const remedy = unobservableBranchRemedy("unreachable", { id: "PR9", branch: "task/x" }, "ready", RECORDED, "")
    expect(remedy.verb).toBeUndefined()
    expect(remedy.text).not.toContain("yrd pr publish")
    expect(remedy.text).not.toContain("yrd pr withdraw")
  })
})
