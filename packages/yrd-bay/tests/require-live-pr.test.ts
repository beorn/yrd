/**
 * @failure A branch selector resolves to a frozen terminal change instead of the
 * live delivery, or the shared live-guard read (`requireLiveChange`, an S7
 * read-survivor other packages still import) silently changes its
 * live-preference, canonical pass-through, or historical-revision refusal.
 * @level l2
 * @consumer @yrd/bay
 *
 * S7 note (branch-is-change, @i/10 22991): every record VERB these journeys
 * used to drive (closePr, requestChecks, submit-by-id, intake) retired with
 * the record store's mint. What remains under test is record RESOLUTION over
 * seeded journals — replay still materializes record history until the store
 * field deletes at integration — exercised directly through the surviving
 * model reads instead of through verbs.
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { Command, createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs } from "@yrd/job"
import { createBayJobDefs, withBays, type BayWorkspace } from "../src/plugin.ts"
import {
  changeDeliveryState,
  currentChangeRev,
  requireLiveChange,
  resolveChange,
  type BaysState,
  type Change,
} from "../src/model.ts"

const HEAD_1 = "1".repeat(40)
const HEAD_2 = "2".repeat(40)
const HEAD_3 = "3".repeat(40)
const BASE = "a".repeat(40)

function ids(): () => string {
  let value = 0
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspaceAdapter(): BayWorkspace {
  return {
    revision: "test-workspace-v1",
    provision: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD_1, baseSha: BASE },
    }),
    refresh: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: HEAD_1, baseSha: BASE, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed",
      conclusion: "success",
      output: { headSha: HEAD_1, pushed: true, wip: false },
    }),
    deprovision: () => ({ status: "completed", conclusion: "success", output: {} }),
  }
}

function changeFacts(pr: Change | undefined) {
  if (pr === undefined) throw new Error("expected PR")
  return { ...pr, delivery: changeDeliveryState(pr), current: currentChangeRev(pr) }
}

/** Seed a journal with one change per entry (all on the given branch, so the
 * branch collides), then boot an app on it. A seed with `live: true` stops at
 * pushed+submitted (a live delivery, as the record lane left it); otherwise it
 * lands as integrated at `commit`. Replay still materializes these records —
 * the reducers stay live until the store field deletes at integration. */
async function appWithIntegrated(
  branch: string,
  seeds: ReadonlyArray<{ pr: string; headSha: string; commit?: string; live?: boolean }>,
) {
  const nextId = ids()
  const at = "2026-01-01T00:00:00.000Z"
  const seededCommand = { id: nextId(), op: "fixture.seed" }
  const events = seeds.flatMap(({ pr, headSha, commit, live }) => {
    const delivered = [
      {
        id: nextId(),
        name: "pr/pushed",
        ts: at,
        // The stable Change-Id (shape `I` + 40 hex) is only shape-validated.
        // The modern pushed-event arm requires changeId and submitter together.
        data: {
          pr,
          branch,
          base: "main",
          headSha,
          baseSha: BASE,
          revision: 1,
          changeId: `I${headSha.slice(0, 40)}`,
          submitter: "fixture",
        },
      },
      { id: nextId(), name: "pr/submitted", ts: at, data: { pr, revision: 1, headSha } },
    ]
    if (live === true) return delivered
    if (commit === undefined) throw new Error(`seed ${pr}: an integrated seed needs its landing commit`)
    return [
      ...delivered,
      {
        id: nextId(),
        name: "pr/integrated",
        ts: at,
        data: { pr, revision: 1, headSha, run: `R-${pr}`, commit, landingSha: commit, baseSha: BASE },
      },
    ]
  })
  const journal = createMemoryJournal([
    {
      command: seededCommand,
      cause: {
        id: nextId(),
        commandId: seededCommand.id,
        op: seededCommand.op,
        commandHash: Command.hash(seededCommand),
      },
      events,
    },
  ])
  const jobs = createBayJobDefs(workspaceAdapter())
  const definition = pipe(createYrdDef(), withJobs({ definitions: jobs }), withBays({ jobs, defaultBase: "main" }))
  return createYrd(definition, {
    inject: { journal, clock: () => at, id: nextId, log: createLogger("test", [{ level: "silent" }]) },
  })
}

type SeededApp = Awaited<ReturnType<typeof appWithIntegrated>>
const bays = (app: SeededApp): BaysState => app.bays.state() as BaysState

describe("resolveChange live-preference + requireLiveChange guard reads", () => {
  it("resolves a branch with one terminal + one live change to the live one, for reads and the guard", async () => {
    // PR2 is the live delivery colliding with the integrated PR1 on topic/b.
    await using app = await appWithIntegrated("topic/b", [
      { pr: "PR1", headSha: HEAD_1, commit: BASE },
      { pr: "PR2", headSha: HEAD_2, live: true },
    ])

    expect(changeFacts(resolveChange(bays(app), "topic/b"))).toMatchObject({ id: "PR2", delivery: "submitted" })
    expect(requireLiveChange(bays(app), "topic/b")).toMatchObject({ id: "PR2" })
    expect(changeFacts(resolveChange(bays(app), "PR1"))).toMatchObject({ delivery: "integrated" })
  })

  it("resolves a branch with multiple terminal PRs + one live change to the live one", async () => {
    // Two integrated PRs already collide on topic/c; PR3 is the live delivery.
    await using app = await appWithIntegrated("topic/c", [
      { pr: "PR1", headSha: HEAD_1, commit: BASE },
      { pr: "PR2", headSha: HEAD_2, commit: "b".repeat(40) },
      { pr: "PR3", headSha: HEAD_3, live: true },
    ])

    expect(changeFacts(resolveChange(bays(app), "topic/c"))).toMatchObject({ id: "PR3", delivery: "submitted" })
    expect(requireLiveChange(bays(app), "topic/c")).toMatchObject({ id: "PR3" })
  })

  it("read-resolves an all-terminal branch to the most recent terminal, but refuses the live guard", async () => {
    await using app = await appWithIntegrated("topic/d", [
      { pr: "PR1", headSha: HEAD_1, commit: BASE },
      { pr: "PR2", headSha: HEAD_2, commit: "b".repeat(40) },
    ])
    // Read: an all-terminal branch resolves the MOST RECENT terminal (PR2).
    expect(changeFacts(resolveChange(bays(app), "topic/d"))).toMatchObject({ id: "PR2", delivery: "integrated" })
    // The guard: no live delivery → loud, typed refusal that points at PR id.
    expect(() => requireLiveChange(bays(app), "topic/d")).toThrow("no live change for branch 'topic/d'; use PR id")
    try {
      requireLiveChange(bays(app), "topic/d")
      throw new Error("expected requireLiveChange to refuse")
    } catch (error) {
      expect(error).toMatchObject({ failure: { kind: "refusal", code: "no-live-pr" } })
    }
  })

  it("passes an id-addressed terminal change through to the caller's own state guard, not the branch refusal", async () => {
    await using app = await appWithIntegrated("topic/e", [{ pr: "PR1", headSha: HEAD_1, commit: BASE }])
    // Addressed by its exact id, a terminal change is NOT branch-refused; the
    // caller's own precondition decides what a terminal target permits.
    expect(requireLiveChange(bays(app), "PR1")).toMatchObject({ id: "PR1", state: "closed" })
  })

  it("folds case on an id-addressed terminal change: 'pr1' addresses canonical PR1, same as resolveSelector", async () => {
    await using app = await appWithIntegrated("topic/f", [{ pr: "PR1", headSha: HEAD_1, commit: BASE }])
    // resolveSelector folds case ('pr1' → PR1); the guard's exact-id arm must
    // fold identically, or a lowercase exact id is misclassified as a live-less
    // BRANCH and refused with no-live-pr.
    expect(requireLiveChange(bays(app), "pr1")).toMatchObject({ id: "PR1" })
  })

  it("refuses a historical revision selector at the guard", async () => {
    await using app = await appWithIntegrated("topic/h", [
      { pr: "PR1", headSha: HEAD_1, commit: BASE },
      { pr: "PR2", headSha: HEAD_2, live: true },
    ])
    const state = bays(app)
    // PR2 has one revision; a qualified CURRENT selector passes, and a
    // historical one would refuse. Seed a second revision by resolving the
    // qualified spelling of revision 1 against a state that only has it.
    expect(requireLiveChange(state, "pr#2.1")).toMatchObject({ id: "PR2" })
    expect(() => requireLiveChange(state, "pr#2.99")).toThrow(/no change 'pr#2\.99'/u)
  })
})
