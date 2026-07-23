/**
 * @failure A long software check can block cheap project-management carriers, or a PM merge can invalidate proven SW checks.
 * @level l2
 * @consumer @yrd/queue admission lanes
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import { createBayJobDefs, withBays, type BayWorkspace, type PR } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import {
  Queues,
  withMerge,
  withQueue,
  withStep,
  type GitDiffEntry,
  type PmPathPolicy,
  type PRSnapshot,
  type PRShape,
  type StepExecution,
} from "@yrd/queue"

const BASE = "a".repeat(40)
const PM_MERGED = "b".repeat(40)
const SW_MERGED = "c".repeat(40)
const runtime = { runner: "local", leaseMs: 60_000 }
const GateResultSchema = z.object({ gate: z.string() }).strict()
const PM_PATHS = {
  exact: ["AGENTS.md", "CLAUDE.md", "README.md"],
  prefixes: ["hub/", "docs/", ".claude/", ".agents/", "@"],
  extensions: [".md", ".mdx", ".txt"],
} as const satisfies PmPathPolicy

function ids(): () => string {
  let value = 0
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace(): BayWorkspace {
  return {
    revision: "queue-lanes-workspace-v1",
    provision: (input) => ({
      status: "passed",
      output: { path: `/repo/.bays/${input.bay}`, headSha: "1".repeat(40), baseSha: BASE },
    }),
    refresh: (input) => ({
      status: "passed",
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: "1".repeat(40), baseSha: BASE, dirty: false },
    }),
    deprovision: () => ({ status: "passed", output: {} }),
  }
}

type LaneFixture = Readonly<{
  changes(pr: PRSnapshot): readonly GitDiffEntry[] | Promise<readonly GitDiffEntry[]>
  swCheck?(input: StepExecution<PRShape>): JobResult<{ gate: string }> | Promise<JobResult<{ gate: string }>>
  pmCheck?(input: StepExecution<PRShape>): JobResult<{ gate: string }> | Promise<JobResult<{ gate: string }>>
  merge?(input: StepExecution<PRShape>): JobResult<{ commit: string; baseSha: string }>
  resolveBaseSha?(): string
  pmConcurrency?: number
  batch?: number
}>

async function createLaneApp(fixture: LaneFixture) {
  const swCheck = withStep<"sw-check", PRShape, { gate: string }>(
    "sw-check",
    (input) => fixture.swCheck?.(input) ?? { status: "passed", output: { gate: "sw" } },
    { revision: "sw-check-v1", output: GateResultSchema },
  )
  const pmCheck = withStep<"pm-check", PRShape, { gate: string }>(
    "pm-check",
    (input) => fixture.pmCheck?.(input) ?? { status: "passed", output: { gate: "pm" } },
    { revision: "pm-check-v1", output: GateResultSchema },
  )
  const merge = withMerge<PRShape>(
    (input) =>
      fixture.merge?.(input) ?? {
        status: "passed",
        output: { commit: SW_MERGED, baseSha: fixture.resolveBaseSha?.() ?? BASE },
      },
    { revision: "merge-v1" },
  )
  const queue = withQueue({
    steps: [swCheck, pmCheck, merge] as const,
    ...(fixture.batch === undefined ? {} : { batch: fixture.batch }),
    defaultSteps: ["sw-check", "merge"],
    lanes: {
      pm: {
        steps: ["pm-check", "merge"],
        ...(fixture.pmConcurrency === undefined ? {} : { concurrency: fixture.pmConcurrency }),
        paths: PM_PATHS,
      },
    },
    resolveChanges: fixture.changes,
    ...(fixture.resolveBaseSha === undefined ? {} : { resolveBaseSha: fixture.resolveBaseSha }),
  })
  const bayJobs = createBayJobDefs(workspace())
  const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
  return createYrd(queue(base), {
    inject: { journal: createMemoryJournal(), log: createLogger("test", [{ level: "silent" }]), id: ids() },
  })
}

async function submit(app: Awaited<ReturnType<typeof createLaneApp>>, branch: string): Promise<PR> {
  const digit = (Object.keys(app.state().bays.prs).length + 1).toString(16)
  await app.bays.submit({ branch, headSha: digit.repeat(40), base: "main", baseSha: BASE })
  const pr = Object.values(app.state().bays.prs).find((candidate) => candidate.branch === branch)
  if (pr === undefined) throw new Error(`missing submitted PR for ${branch}`)
  await app.bays.requestChecks({ pr: pr.id, baseSha: BASE })
  return pr
}

const regular = (path: string): GitDiffEntry => ({
  status: "M",
  path,
  oldMode: "100644",
  newMode: "100644",
})

describe("Queue pm/sw lanes", () => {
  it("freezes the derived lane and exact gate set for pure-docs, mixed, and gitlink admissions", async () => {
    const changes = new Map<string, readonly GitDiffEntry[]>([
      ["docs-only", [regular("@yrd/core/docs-only.md"), regular("docs/queue.md")]],
      ["mixed", [regular("docs/queue.md"), regular("packages/yrd-queue/src/queue.ts")]],
      ["gitlink", [{ status: "M", path: "vendor/yrd", oldMode: "160000", newMode: "160000" }]],
    ])
    await using app = await createLaneApp({
      changes: (pr) => changes.get(pr.branch) ?? [],
    })

    for (const [branch, expected] of [
      ["docs-only", { lane: "pm", step: "pm-check" }],
      ["mixed", { lane: "sw", step: "sw-check" }],
      ["gitlink", { lane: "sw", step: "sw-check" }],
    ] as const) {
      const pr = await submit(app, branch)
      const run = (await app.queue.admit({ prs: [pr.id] }, runtime))[0]
      expect(
        run,
        JSON.stringify({ eligibility: app.queue.eligibility(pr.id), status: app.queue.status("main") }),
      ).toMatchObject({
        lane: expected.lane,
        steps: [{ name: expected.step }],
        stepSelection: { authority: "admission", steps: [expected.step] },
      })
    }
  })

  it("binds asynchronous diff evidence to the immutable PR revision it classified", async () => {
    const firstResolution = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<void>()
    const revisions: number[] = []
    await using app = await createLaneApp({
      changes: async (pr) => {
        revisions.push(pr.revision)
        if (pr.revision === 1) {
          firstResolution.resolve()
          await releaseFirst.promise
          return [regular("docs/stale-revision.md")]
        }
        return [regular("packages/app/src/current-revision.ts")]
      },
    })
    const pr = await submit(app, "moving-revision")

    const admission = app.queue.admit({ prs: [pr.id] }, runtime)
    await firstResolution.promise
    const nextHead = "e".repeat(40)
    await app.bays.intake({ branch: pr.branch, headSha: nextHead, base: pr.base, baseSha: BASE })
    await app.bays.submit({ pr: pr.id })
    await app.bays.requestChecks({ pr: pr.id, baseSha: BASE })
    releaseFirst.resolve()

    expect(await admission).toMatchObject([
      {
        lane: "sw",
        prs: [{ id: pr.id, revision: 2, headSha: nextHead }],
        steps: [{ name: "sw-check" }],
      },
    ])
    expect(revisions).toEqual([1, 2])
  })

  it("refuses lane plans that cannot journal an admission receipt", () => {
    const merge = withMerge<PRShape>(() => ({ status: "passed", output: { commit: SW_MERGED, baseSha: SW_MERGED } }), {
      revision: "merge-only-v1",
    })

    expect(() =>
      withQueue({
        steps: [merge] as const,
        defaultSteps: ["merge"],
        lanes: { pm: { steps: ["merge"], paths: PM_PATHS } },
        resolveChanges: () => [regular("README.md")],
      }),
    ).toThrow(/lane 'pm'.*admission step/iu)
  })

  it("refuses explicit step plans when the host derives queue lanes", async () => {
    await using app = await createLaneApp({ changes: () => [regular("docs/operator.md")] })
    const pr = await submit(app, "operator-override")
    const snapshot = Queues.snapshot(pr)
    await app.dispatch(app.commands.queue.admit, {
      pr: pr.id,
      evidence: { snapshot, changes: [regular("docs/operator.md")] },
    })
    expect(app.queue.get("R1")).toMatchObject({
      lane: "pm",
      stepSelection: { authority: "admission" },
      steps: [{ name: "pm-check", job: { status: "requested" } }],
    })

    await expect(app.queue.run({ prs: [pr.id], steps: ["pm-check", "merge"] }, runtime)).rejects.toThrow(
      /lane steps are derived from diff evidence/iu,
    )
    await expect(app.dispatch(app.commands.queue.run, { prs: [pr.id], steps: ["pm-check", "merge"] })).rejects.toThrow(
      /lane steps are derived from diff evidence/iu,
    )
    expect(app.queue.get("R1")).toMatchObject({
      lane: "pm",
      status: "running",
      stepSelection: { authority: "admission" },
    })
  })

  it("admits only explicitly selected carriers", async () => {
    await using app = await createLaneApp({
      changes: (pr) => [regular(`docs/${pr.branch}.md`)],
      pmCheck: () => ({ status: "waiting", token: "remote-pm-check" }),
    })
    const unrelated = await submit(app, "unrelated-first")
    const selected = await submit(app, "selected-second")

    await app.queue.admit({ prs: [selected.branch] }, runtime)

    expect(app.queue.eligibility(unrelated.id).checks).toMatchObject({ status: "queued" })
    expect(app.queue.eligibility(unrelated.id).checks).not.toHaveProperty("run")
    expect(app.queue.eligibility(selected.id).checks).toMatchObject({ status: "checking", run: "R1" })
  })

  it("lands PM while an SW check is running, then preserves that SW proof across the PM base advance", async () => {
    let baseSha = BASE
    let swChecks = 0
    await using app = await createLaneApp({
      changes: (pr) => [regular(pr.branch === "pm-docs" ? "docs/pm.md" : "packages/app/src/index.ts")],
      swCheck: () => {
        swChecks += 1
        return { status: "waiting", token: "remote-sw-check" }
      },
      merge: (input) => {
        const pm = input.prs[0]?.branch === "pm-docs"
        baseSha = pm ? PM_MERGED : SW_MERGED
        return { status: "passed", output: { commit: baseSha, baseSha } }
      },
      resolveBaseSha: () => baseSha,
    })
    const sw = await submit(app, "sw-code")
    const pm = await submit(app, "pm-docs")

    const swAdmission = (await app.queue.admit({ prs: [sw.id] }, runtime))[0]
    const swJob = swAdmission?.steps[0]?.job
    if (swJob?.status !== "waiting") throw new Error("SW check did not enter its in-flight waiting state")
    expect(swAdmission).toMatchObject({ lane: "sw", status: "waiting" })

    const pmRuns = await app.queue.run({ prs: [pm.id] }, runtime)
    expect(
      app.state().bays.prs[pm.id],
      JSON.stringify({ runs: pmRuns, eligibility: app.queue.eligibility(pm.id), status: app.queue.status("main") }),
    ).toMatchObject({ status: "integrated" })

    await app.queue.finish(
      sw.id,
      {
        job: swJob.id,
        step: "sw-check",
        attempt: swJob.attempt,
        runner: swJob.runner,
        token: swJob.token,
        result: { status: "passed", output: { gate: "sw" } },
      },
      runtime,
    )

    const swIntegrated = await app.queue.run({ prs: [sw.id] }, runtime)
    expect(swIntegrated).toMatchObject([{ lane: "sw", status: "passed", reusedFrom: "R1" }])
    expect(swChecks).toBe(1)
    expect(app.state().bays.prs[sw.id]).toMatchObject({ status: "integrated" })
  })

  it("lets a ready PM carrier merge during an implicit drain while an SW admission is waiting", async () => {
    await using app = await createLaneApp({
      changes: (pr) => [regular(pr.branch === "pm-ready" ? "docs/ready.md" : "packages/app/src/index.ts")],
      swCheck: () => ({ status: "waiting", token: "remote-sw-check" }),
      merge: () => ({ status: "passed", output: { commit: PM_MERGED, baseSha: PM_MERGED } }),
    })
    const sw = await submit(app, "sw-waiting")
    const pm = await submit(app, "pm-ready")

    const runs = await app.queue.run({}, { ...runtime, continueAdmissions: () => true })

    expect(runs).toMatchObject([{ lane: "pm", status: "passed" }])
    expect(app.state().bays.prs[pm.id]).toMatchObject({ status: "integrated" })
    expect(app.state().bays.prs[sw.id]).toMatchObject({ status: "submitted" })
  })

  it("serializes PM and SW merge steps through one landing authority", async () => {
    const mergeStarts: string[] = []
    await using app = await createLaneApp({
      changes: (pr) => [regular(pr.branch === "pm-merge" ? "docs/merge.md" : "packages/app/src/index.ts")],
      merge: (input) => {
        const branch = input.prs[0]?.branch
        if (branch === undefined) throw new Error("merge input has no PR")
        mergeStarts.push(branch)
        return branch === "sw-merge"
          ? { status: "waiting", token: "remote-merge" }
          : { status: "passed", output: { commit: PM_MERGED, baseSha: PM_MERGED } }
      },
    })
    const sw = await submit(app, "sw-merge")
    const pm = await submit(app, "pm-merge")
    await app.queue.admit({ prs: [sw.id] }, runtime)
    await app.queue.admit({ prs: [pm.id] }, runtime)

    const swRun = (await app.queue.run({ prs: [sw.id] }, runtime))[0]
    if (swRun === undefined) throw new Error("SW integration run did not start")
    const swMerge = swRun.steps.find((step) => step.name === "merge")?.job
    if (swMerge?.status !== "waiting") throw new Error("SW merge did not enter its waiting state")

    await expect(app.queue.run({ prs: [pm.id] }, runtime)).rejects.toThrow(`yrd: queue 'main' is running '${swRun.id}'`)
    const whileLocked = await app.queue.run({}, runtime)
    expect(whileLocked).toMatchObject([{ id: swRun.id, lane: "sw", status: "waiting" }])
    expect(mergeStarts).toEqual(["sw-merge"])
    expect(app.state().bays.prs[pm.id]).toMatchObject({ status: "submitted" })

    await app.queue.finish(
      sw.id,
      {
        job: swMerge.id,
        step: "merge",
        attempt: swMerge.attempt,
        runner: swMerge.runner,
        token: swMerge.token,
        result: { status: "passed", output: { commit: SW_MERGED, baseSha: SW_MERGED } },
      },
      runtime,
    )
    expect(await app.queue.run({ prs: [pm.id] }, runtime)).toMatchObject([{ lane: "pm", status: "passed" }])
    expect(mergeStarts).toEqual(["sw-merge", "pm-merge"])
  })

  it("defaults PM check capacity to two while SW remains serialized", async () => {
    await using app = await createLaneApp({
      changes: (pr) => [regular(pr.branch.startsWith("pm-") ? `docs/${pr.branch}.md` : "packages/app/index.ts")],
    })
    for (const branch of ["sw-one", "pm-one", "pm-two", "pm-three", "sw-two"]) await submit(app, branch)

    await app.queue.admit({})
    const running = app.queue.status("main").running
    expect(running.filter((run) => run.lane === "pm")).toHaveLength(2)
    expect(running.filter((run) => run.lane === "sw")).toHaveLength(1)
  })

  it("keeps waiting PM checks inside the configured lane capacity", async () => {
    await using app = await createLaneApp({
      changes: (pr) => [regular(`docs/${pr.branch}.md`)],
      pmConcurrency: 2,
      pmCheck: () => ({ status: "waiting", token: "remote-pm-check" }),
    })
    const first = await submit(app, "pm-first")
    const second = await submit(app, "pm-second")
    const third = await submit(app, "pm-third")

    await app.queue.admit({})
    await app.queue.admit({ prs: [first.id] }, runtime)
    await app.queue.admit({ prs: [second.id] }, runtime)
    expect(app.queue.status("main").waiting.filter((run) => run.lane === "pm")).toHaveLength(2)

    await app.queue.admit({})
    const status = app.queue.status("main")
    expect([...status.running, ...status.waiting].filter((run) => run.lane === "pm")).toHaveLength(2)
    expect(app.queue.eligibility(third.id).checks).toMatchObject({ status: "queued" })
  })

  it("preserves readiness order when lane boundaries split a batch", async () => {
    const merged: string[] = []
    await using app = await createLaneApp({
      batch: 3,
      changes: (pr) => [regular(pr.branch.startsWith("pm-") ? `docs/${pr.branch}.md` : "packages/app/index.ts")],
      merge: (input) => {
        merged.push(input.prs.map((pr) => pr.branch).join(","))
        return { status: "passed", output: { commit: SW_MERGED, baseSha: SW_MERGED } }
      },
    })
    for (const branch of ["sw-first", "pm-middle", "sw-last"]) {
      const pr = await submit(app, branch)
      await app.queue.admit({ prs: [pr.id] }, runtime)
    }

    await app.queue.run({}, runtime)

    expect(merged).toEqual(["sw-first", "pm-middle", "sw-last"])
  })
})
