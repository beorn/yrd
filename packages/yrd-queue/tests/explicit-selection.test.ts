/**
 * @failure `yrd queue run <selector>` cannot select. Post-S7 an explicit
 * selection resolves nothing (every selector refuses `pr-not-found`) and,
 * where a batch IS supplied, narrows nothing (the unselected members run too).
 * @level l2
 * @consumer @yrd/queue
 *
 * FAIL-FIRST ACCEPTANCE for the explicit-selection fix. Every test here is RED
 * on purpose until that fix lands; none of them is describing behaviour the
 * queue has today.
 *
 * READ THIS BEFORE FIXING EITHER HALF — the two halves have an order, and
 * getting it wrong is worse than shipping neither.
 *
 * There are two defects and they are stacked. RESOLUTION is broken: the only
 * population a selector is matched against is the caller-supplied `derived`
 * batch, and the compose fills that batch only on the path where there is no
 * selector, so `yrd queue run <anything>` refuses. NARROWING is also broken:
 * when a batch IS supplied, the selection concatenates the unselected members
 * straight back in, so naming one member runs all of them.
 *
 * Today the first defect MASKS the second. Nothing reaches the narrowing bug
 * because nothing resolves. Fix resolution alone and the mask comes off:
 * `yrd queue run <one-branch>` becomes "merge every submitted branch", with no
 * refusal, no warning, and every instrument green. The operator finds out when
 * work nobody selected is already on main.
 *
 * So: the narrowing test must be present and passing BEFORE or WITH the
 * resolution fix, never after. A selector that refuses is a bad tool and an
 * annoyance. A selector that silently merges work nobody asked for is an
 * incident, and it is not reversible the way a refusal is.
 *
 * If only one half can land, land narrowing.
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace, type PrNumberMint } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import {
  candidateRefFor,
  deriveRunMemberArgs,
  withMerge,
  withQueue,
  withStep,
  type CandidatePreparer,
  type DerivedRunMember,
  type IntegrationProof,
  type StepExecution,
} from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const runtime = { runner: "local", leaseMs: 60_000 }
const CheckResultSchema = z.object({ checked: z.boolean() }).strict()

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

const mergeableCandidate: CandidatePreparer = (input) => {
  const { prs: _prs, ...candidate } = input
  return { ...candidate, sha: MERGED, ref: candidateRefFor(MERGED), mergeability: "mergeable" }
}

/** One mint per app, reachable from the test: a fixture-derived member and the
 * compose's own derivation must draw from the same sequence, or the same branch
 * gets two numbers. */
const mints = new WeakMap<object, PrNumberMint>()

/**
 * derived-admission-execution.test.ts's reference configuration, which is the
 * production shape: a mint and an enrichment reader are both present, so a
 * selectorless compose can derive a ref-only branch by itself. That matters
 * here — the resolution tests deliberately supply NO `derived`, exactly as the
 * CLI's `runQueues` does, and a fixture without a mint would fail for the
 * boring reason instead of the one under test.
 */
async function createApp() {
  const mint = volatilePrNumberMint()
  const check = withStep(
    "check",
    (_input: StepExecution): JobResult<z.infer<typeof CheckResultSchema>> => ({
      status: "completed",
      conclusion: "success",
      output: { checked: true },
    }),
    { revision: "check-v1", output: CheckResultSchema },
  )
  const merge = withMerge(
    async (): Promise<JobResult<IntegrationProof>> => ({
      status: "completed",
      conclusion: "success",
      output: { commit: MERGED, baseSha: BASE },
    }),
    { revision: "merge-v1" },
  )
  const queue = withQueue({
    steps: [check, merge] as const,
    batch: false,
    defaultSteps: ["check", "merge"],
    resolveBaseSha: () => BASE,
    prepareCandidate: mergeableCandidate,
    prNumberMint: mint,
    readSubmitEnrichment: ({ sha }) => ({ changeId: `I${sha}` }),
  })
  const bayJobs = createBayJobDefs(workspace())
  const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
  const app = await createYrd(queue(base), {
    inject: {
      journal: createMemoryJournal(),
      id: ids(),
      clock: () => "2026-01-01T00:00:00.000Z",
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
  mints.set(app, mint)
  return app
}

type QueueApp = Awaited<ReturnType<typeof createApp>>

/** Write the branch's standing submit fact and nothing else — no member is
 * derived, so the compose must mint the identity itself. This is the state a
 * `git push bay …` leaves behind, and the state every resolution test starts
 * from. */
async function submitFact(app: QueueApp, branch: string, digit: string): Promise<void> {
  await app.bays.recordBranchSubmit({ branch, sha: digit.repeat(40), base: "main" })
}

/** The member the compose would build from an already-written submit fact,
 * minted off the app's own mint. Only the NARROWING test needs this: it has to
 * hand the run a batch in order to select one member out of it. */
function memberOf(app: QueueApp, branch: string): DerivedRunMember {
  const mint = mints.get(app)
  if (mint === undefined) throw new Error("app was not created by createApp — no mint registered")
  return deriveRunMemberArgs({ bays: app.state().bays, queues: app.state().queues, mint, branch })
}

/** Every member every run of this compose carried, as `id@branch` pairs.
 *
 * Deliberately NOT a count. A count of 1 passes when the queue runs the WRONG
 * single member, which is the same incident as running two — the operator
 * still gets work they did not select. The pair also pins the id-to-branch
 * binding, so a run that renumbered its member cannot slip through.
 */
function ranMembers(runs: readonly { prs: readonly { id: string; branch: string }[] }[]): string[] {
  return runs.flatMap((run) => run.prs.map((pr) => `${pr.id}@${pr.branch}`)).toSorted()
}

async function refusalFrom(run: Promise<unknown>): Promise<string> {
  return await run.then(
    () => "RESOLVED — expected a refusal",
    (error: Error) => error.message,
  )
}

describe("explicit selection — naming a member must run THAT member, and only it", () => {
  it("runs ONLY the selected member, never the rest of the batch it was drawn from", async () => {
    // THE CATASTROPHIC-OUTCOME GUARD. If this test is red, `yrd queue run
    // <one-branch>` can merge branches nobody selected. Do not land the
    // resolution half while this is failing — see the file header.
    await using app = await createApp()
    await submitFact(app, "issue/selected", "1")
    await submitFact(app, "issue/bystander", "2")
    const selected = memberOf(app, "issue/selected")
    const bystander = memberOf(app, "issue/bystander")

    const runs = await app.queue.run({ prs: [selected.id], derived: [selected, bystander] }, runtime)

    expect(
      ranMembers(runs),
      "naming one member must not run the other members of its batch — this is the silent-merge incident",
    ).toEqual([`${selected.id}@issue/selected`])
    // And the bystander is untouched: still submitted, never composed.
    expect(app.state().bays.submits["issue/bystander"]).toMatchObject({ sha: "2".repeat(40) })
  })

  it("selects out of a batch by BRANCH as well as by id, since both spellings resolve", async () => {
    await using app = await createApp()
    await submitFact(app, "issue/selected", "1")
    await submitFact(app, "issue/bystander", "2")
    const selected = memberOf(app, "issue/selected")
    const bystander = memberOf(app, "issue/bystander")

    const runs = await app.queue.run({ prs: ["issue/selected"], derived: [selected, bystander] }, runtime)

    expect(ranMembers(runs), "the branch spelling must narrow exactly as the id spelling does").toEqual([
      `${selected.id}@issue/selected`,
    ])
  })
})

describe("explicit selection — a selector must resolve against the live submit facts", () => {
  it("resolves a BRANCH selector with no caller-supplied batch, exactly as the CLI calls it", async () => {
    // `runQueues` in yrd-cli passes `prs: [...selectors]` and never `derived`.
    // This is that call, verbatim, against a branch that IS submitted.
    await using app = await createApp()
    await submitFact(app, "issue/lonely", "1")

    const runs = await app.queue.run({ prs: ["issue/lonely"] }, runtime)

    expect(ranMembers(runs), "a submitted branch named by an operator must run, not refuse").toEqual([
      `PR1@issue/lonely`,
    ])
  })

  it("resolves the minted ID spelling, with no caller-supplied batch, once the member HAS one", async () => {
    // The id is the spelling an operator copies off a status surface — and
    // that premise is also the whole limit on when it can resolve. A branch no
    // compose has served appears on the status surface as an
    // `UnrecordedSubmit`, which carries branch, sha, base and a reason and NO
    // id. There is no number to copy yet, so there is none to honour.
    //
    // RETRACTION, recorded because this test asserted the opposite when it
    // landed: it started from a bare submit fact and expected `PR1` to name it.
    // That passed only because resolving the id MINTED the entire derived lane
    // to look for it — the per-invocation burn `submit-intake`'s "an explicit
    // run never mints an identity for a branch it will not select" forbids, and
    // the two could not both hold. The premise sentence above is what decides
    // between them: at that starting state no surface offers the spelling this
    // test claimed an operator had copied. It is also unstable on its own
    // terms — with two un-composed branches, WHICH one is `PR1` depends on
    // derivation order, and the numbers move every run.
    //
    // So the id spelling resolves from the first state that has one, a retained
    // run snapshot, and the branch spelling covers everything before that.
    // `changeNotFoundMessage` says the same thing where the miss is reported:
    // "Branch names are the selectors that resolve."
    await using app = await createApp()
    await submitFact(app, "issue/lonely", "1")
    await app.queue.run({}, runtime)
    await submitFact(app, "issue/lonely", "2")

    const runs = await app.queue.run({ prs: ["PR1"] }, runtime)

    expect(ranMembers(runs)).toEqual([`PR1@issue/lonely`])
  })

  it("refuses an ID naming a branch no compose has served — and mints nothing to find out", async () => {
    // The fence on the retraction above. Without it, "we no longer resolve
    // that" is indistinguishable from having quietly dropped id resolution,
    // and nothing states the price we refused to pay: a miss must not burn a
    // number, because burning one is exactly what the old resolution did on
    // every hit AND every miss.
    await using app = await createApp()
    const mint = mints.get(app)
    if (mint === undefined) throw new Error("app was not created by createApp — no mint registered")
    await submitFact(app, "issue/lonely", "1")
    const before = mint.highWater()

    expect(await refusalFrom(app.queue.run({ prs: ["PR1"] }, runtime))).toContain(
      "no change 'PR1' — searched 1 submitted branch",
    )
    expect(mint.highWater(), "a miss must not burn a number").toBe(before)

    // POSITIVE CONTROL: the branch spelling resolves from this exact state, so
    // the refusal above is about the ID spelling and not about a surface that
    // refuses everything. Without this the assertion would pass against a
    // completely broken selector.
    expect(ranMembers(await app.queue.run({ prs: ["issue/lonely"] }, runtime))).toEqual([`PR1@issue/lonely`])
  })
})

describe("explicit selection — a miss must refuse, and the refusal must not overstate what it searched", () => {
  it("refuses an unmatched selector while naming a denominator every member of which DOES resolve", async () => {
    // The property is a conjunction, and only the conjunction is worth
    // anything. The message already counts the live submit facts ("searched 3
    // submitted branches"), but today the selector is matched against a
    // population that contains NONE of them — so the count describes a set that
    // was never searched, and an operator whose branch is submitted reads the
    // refusal as proof that it is not.
    //
    // Pinning the count alone would pass today and prove nothing. Pinning that
    // every counted branch resolves is what makes the denominator honest.
    await using app = await createApp()
    await submitFact(app, "issue/one", "1")
    await submitFact(app, "issue/two", "2")
    await submitFact(app, "issue/three", "3")

    expect(await refusalFrom(app.queue.run({ prs: ["issue/nope"] }, runtime))).toContain(
      "no change 'issue/nope' — searched 3 submitted branches",
    )

    // …and the denominator is truthful: each of the three IS reachable by name.
    for (const branch of ["issue/one", "issue/two", "issue/three"]) {
      await using fresh = await createApp()
      await submitFact(fresh, "issue/one", "1")
      await submitFact(fresh, "issue/two", "2")
      await submitFact(fresh, "issue/three", "3")
      const runs = await fresh.queue.run({ prs: [branch] }, runtime)
      expect(
        runs.flatMap((run) => run.prs.map((pr) => pr.branch)),
        `'${branch}' is counted in the denominator, so naming it must resolve`,
      ).toEqual([branch])
    }
  })

  it("still refuses when nothing is submitted at all, and says it searched nothing", async () => {
    // The falsifiable-empty contract: `searched 0` is honest absence. This is
    // the one case in this file that is green today, kept as the control — it
    // is what proves the refusal path itself works, so a red elsewhere is about
    // RESOLUTION rather than about refusals being broken generally.
    await using app = await createApp()

    expect(await refusalFrom(app.queue.run({ prs: ["issue/absent"] }, runtime))).toContain(
      "no change 'issue/absent' — searched 0 submitted branches",
    )
  })
})

describe("explicit selection — selector case folding", () => {
  /**
   * RULED (@chief): the two halves below deliberately disagree, and that is
   * the decision, not an oversight.
   *
   * THE ASYMMETRY IS NOT AN INCONSISTENCY — IT IS A NAMESPACE-OWNERSHIP
   * BOUNDARY. We fold what we mint, and we do not fold what git owns.
   *
   * That sentence is here because the tempting fix is the wrong one and it
   * argues well. The three selector surfaces do currently disagree —
   * `queue.get("r1")` and `queue.status("MAIN")` fold case, `explicitPRs`
   * compares with `===` — so "three surfaces should agree, make them all fold"
   * sounds like tidying. It is not tidying. It re-introduces the hazard below,
   * and it does so under a name that reads like an improvement in a diff.
   *
   * FOLD the minted id. `PR1` is OUR namespace: we mint every value in it, so
   * there is no collision to fold two distinct things together, it has no
   * meaning outside yrd, and the surfaces an operator copies it off already
   * fold. Folding removes a real papercut and can break nothing.
   *
   * DO NOT FOLD the branch. A branch name is GIT'S namespace. Refs are
   * case-sensitive, so `Topic/Selectors` and `topic/selectors` can both exist
   * at once and mean different things. A folding branch selector would resolve
   * either to a branch the operator did not name, or ambiguously between two
   * real ones — at the exact moment they are asking us to merge. Making
   * someone retype a branch is cheap. Merging the wrong branch is the same
   * catastrophic outcome the narrowing guard at the top of this file exists to
   * prevent, reached from a different direction.
   */
  it("folds case for the minted ID spelling, as every other selector surface does", async () => {
    // Composed first, for the reason recorded on "resolves the minted ID
    // spelling ... once the member HAS one": an id exists to be folded only
    // once a run has retained it. The folding rule under test is unchanged.
    await using app = await createApp()
    await submitFact(app, "Topic/Selectors", "1")
    await app.queue.run({}, runtime)
    await submitFact(app, "Topic/Selectors", "2")

    const runs = await app.queue.run({ prs: ["pr1"] }, runtime)

    expect(ranMembers(runs)).toEqual([`PR1@Topic/Selectors`])
  })

  it("does NOT fold case for the branch spelling, because git refs are case-sensitive", async () => {
    await using app = await createApp()
    await submitFact(app, "Topic/Selectors", "1")

    // POSITIVE CONTROL, and it is the whole reason this test is trustworthy.
    // Without it this test PASSES TODAY for the wrong reason: every selector
    // refuses right now, so "the wrong case refused" would be true of a
    // completely broken surface and would prove nothing about case
    // sensitivity. Asserting the exact-case spelling resolves FIRST means the
    // refusal below only counts once the surface works — the test is red today
    // and becomes a real guard the moment the fix lands, rather than a green
    // that was never armed.
    const exact = await app.queue.run({ prs: ["Topic/Selectors"] }, runtime)
    expect(
      exact.flatMap((run) => run.prs.map((pr) => pr.branch)),
      "control: the exact spelling must resolve",
    ).toEqual(["Topic/Selectors"])

    // Only now is the refusal meaningful. A branch selector that differs only
    // in case names a ref that does not exist; refuse it rather than guess
    // which real branch was meant.
    await using other = await createApp()
    await submitFact(other, "Topic/Selectors", "1")
    expect(await refusalFrom(other.queue.run({ prs: ["topic/selectors"] }, runtime))).toContain(
      "no change 'topic/selectors'",
    )
  })
})
