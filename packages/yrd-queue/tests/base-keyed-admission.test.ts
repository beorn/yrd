/**
 * @failure Admission proof is keyed to the base it was proved at, and every merge moves the base, so each surviving candidate discards a passing proof and re-earns it — once per merge that lands ahead of it.
 * @level l2
 * @consumer @yrd/queue admission reuse
 */
import { describe, expect, it } from "vitest"
import { createLogger } from "loggily"
import {
  changeAdmission,
  checkRequest,
  createBayJobDefs,
  withBays,
  volatilePrNumberMint,
  type BayWorkspace,
} from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import * as z from "zod"
import { candidateRefFor, withMerge, withQueue, withStep, type CandidatePreparer } from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const CheckResultSchema = z.object({ checked: z.boolean() }).strict()

/** The habitant runner's shape, as the fleet installs it. */
const HABITANT = { runner: "local", leaseMs: 60_000, continueAdmissions: () => true }

/** Main after `n` merges. A merge is the only thing that moves it. */
function mainAfter(merges: number): string {
  return (merges + 1).toString(16).repeat(40).slice(0, 40)
}

function ids(initial = 0): () => string {
  let value = initial
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

/** A distinct carrier per (base, member set), the way a real compose produces a
 * distinct merge commit for every base it is rebuilt on. */
const preparer: CandidatePreparer = (input) => {
  const sha = `${input.baseSha.slice(0, 8)}${input.revs.map((rev) => rev.pr).join("")}`
    .toLowerCase()
    .replaceAll(/[^0-9a-f]/gu, "0")
    .padEnd(40, "0")
    .slice(0, 40)
  const { prs: _prs, ...candidate } = input
  return { ...candidate, sha, ref: candidateRefFor(sha), mergeability: "mergeable" }
}

/** One check execution and the base it was executed against. The LEDGER, not a
 * count: the whole subject here is one unchanged tree being proved over and
 * over at a base that keeps moving underneath it, and a bare count cannot tell
 * that apart from a retry. */
type Execution = Readonly<{ pr: string; baseSha: string | undefined }>

function harness(options: Readonly<{ onMerge?: () => void }> = {}) {
  const executions: Execution[] = []
  let merges = 0
  let mainSha = BASE

  const check = withStep(
    "check",
    (input): JobResult<{ checked: boolean }> => {
      for (const pr of input.prs) executions.push({ pr: pr.id, baseSha: pr.baseSha })
      return { status: "completed", conclusion: "success", output: { checked: true } }
    },
    { revision: "check-v1", output: CheckResultSchema },
  )
  const merge = withMerge(
    (input): JobResult<{ commit: string; baseSha: string }> => {
      const composedAt = input.candidate?.baseSha
      merges += 1
      options.onMerge?.()
      mainSha = mainAfter(merges)
      return { status: "completed", conclusion: "success", output: { commit: mainSha, baseSha: composedAt ?? BASE } }
    },
    { revision: "merge-v1" },
  )
  const queue = withQueue({
    steps: [check, merge] as const,
    batch: false,
    defaultSteps: ["check", "merge"],
    resolveBaseSha: () => mainSha,
    prepareCandidate: preparer,
  })
  return { executions, queue, main: () => mainSha, merges: () => merges }
}

async function createApp(queue: ReturnType<typeof harness>["queue"]) {
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
      clock: () => "2026-01-01T00:00:00.000Z",
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
}

async function submitBranch(app: Awaited<ReturnType<typeof createApp>>, branch: string) {
  const digit = (Object.keys(app.state().bays.prs).length + 1).toString(16)
  await app.bays.submit({ branch, headSha: digit.repeat(40), base: "main", baseSha: BASE })
  const pr = Object.values(app.state().bays.prs).find((item) => item.branch === branch)
  if (pr === undefined) throw new Error("PR was not recorded")
  return pr
}

describe("base-keyed admission — a merge invalidates every other candidate's proof", () => {
  it("re-executes the check of an untouched candidate after a sibling merge moves the base", async () => {
    const { executions, queue, main } = harness()
    await using app = await createApp(queue)

    const a = await submitBranch(app, "issue/merges-first")
    const b = await submitBranch(app, "issue/waits-behind")
    await app.bays.requestChecks({ pr: a.id, baseSha: BASE })
    await app.bays.requestChecks({ pr: b.id, baseSha: BASE })

    // Both changes prove themselves against the base main is at right now.
    await app.queue.admit({}, HABITANT)
    expect(executions).toEqual([
      { pr: a.id, baseSha: BASE },
      { pr: b.id, baseSha: BASE },
    ])
    expect(changeAdmission(app.bays.pr(b.id)!)).toMatchObject({ status: "passed", baseSha: BASE })

    // A merges. Nothing else happens to B: not re-pushed, not recut, not
    // touched. Its head, its revision and its tree are exactly what they were
    // when it passed.
    const before = app.bays.pr(b.id)!.revs
    await app.queue.run({ prs: [a.branch] }, HABITANT)
    expect(main(), "the merge advanced main").toBe(mainAfter(1))
    expect(app.bays.pr(b.id)!.revs, "B's own facts did not move").toEqual(before)

    // The next drain turn.
    await app.queue.run({}, HABITANT)

    // THE DEFECT, pinned. B ran its check a SECOND time over the identical
    // tree, because the compose pass re-points every ready carrier's check
    // request at the cycle base (queue.ts `refreshCheckIdentities`), and an
    // admission proved at any other base is not reusable (queue.ts
    // `admitChangeRevision`, `reusableRevisionAdmission`).
    expect(executions).toEqual([
      { pr: a.id, baseSha: BASE },
      { pr: b.id, baseSha: BASE },
      { pr: b.id, baseSha: mainAfter(1) },
    ])
    expect(checkRequest(app.bays.pr(b.id)!)).toMatchObject({ baseSha: mainAfter(1) })
    expect(changeAdmission(app.bays.pr(b.id)!)).toMatchObject({ status: "passed", baseSha: mainAfter(1) })
  })

  it("discards a passing proof for every change still waiting when a merge lands", async () => {
    // The measured shape: PR2059 admitted at 14 distinct bases across 56
    // attempts, PR1073 at 13, PR2145 at 8 over 25. Every merge moves the base;
    // the compose pass re-points EVERY ready carrier at the new base
    // (queue.ts `refreshCheckIdentities`, over `[...checked, ...admissible]`),
    // and a proof at any other base is unusable — so a change pays one check
    // execution for every merge that lands ahead of it while it waits.
    const { executions, queue, merges } = harness()
    await using app = await createApp(queue)

    const changes = []
    for (const name of ["issue/one", "issue/two", "issue/three"]) {
      changes.push(await submitBranch(app, name))
    }
    for (const change of changes) await app.bays.requestChecks({ pr: change.id, baseSha: BASE })

    // One cycle proves all three against the base main is at right now.
    await app.queue.admit({}, HABITANT)
    expect(executions.map((execution) => execution.baseSha)).toEqual([BASE, BASE, BASE])

    // Then they merge one at a time, as the serialized landing lane takes them.
    for (const change of changes) await app.queue.run({ prs: [change.branch] }, HABITANT)
    expect(merges(), "every change merged").toBe(changes.length)

    // The claim: five check executions to land three changes. The first change
    // spent its proof; the other two had theirs discarded by a merge they were
    // not part of, and re-earned it against a base that had moved for reasons
    // that had nothing to do with them.
    const perChange = new Map<string, number>()
    for (const execution of executions) {
      perChange.set(execution.pr, (perChange.get(execution.pr) ?? 0) + 1)
    }
    expect([...perChange.values()]).toEqual([1, 2, 2])
    expect(executions).toHaveLength(5)

    // Each repeat was proved against a DIFFERENT base. The changes never moved;
    // only the branch they were measured against did.
    for (const change of changes.slice(1)) {
      const bases = executions.filter((execution) => execution.pr === change.id).map((execution) => execution.baseSha)
      expect(new Set(bases).size, `${change.id} proved the same tree at two distinct bases`).toBe(2)
    }
  })

  it("leaves a passing verdict alone while its change cannot land, and spends it when it can", async () => {
    // The fix. `batchSize` serializes one candidate per base, so a cycle can
    // land exactly one change; re-pointing the others discards verdicts the
    // cycle had no way to spend. The compose pass now re-points only the
    // carriers inside that landing window, plus every carrier that holds no
    // passing verdict yet — a first proof is author feedback and is never
    // withheld.
    let mergedThisCycle = 0
    const { executions, queue, merges } = harness({
      onMerge: () => {
        mergedThisCycle += 1
      },
    })
    await using app = await createApp(queue)

    // A runner that composes ONE candidate per turn: the serialized landing
    // lane, in process. The admission phase runs before any merge, so the gate
    // is open throughout it and closes only after the cycle's single merge.
    const serial = { runner: "local", leaseMs: 60_000, continueAdmissions: () => mergedThisCycle < 1 }

    const changes = []
    for (const name of ["issue/first", "issue/second", "issue/third"]) {
      changes.push(await submitBranch(app, name))
    }
    for (const change of changes) await app.bays.requestChecks({ pr: change.id, baseSha: BASE })

    for (let cycle = 0; cycle < 8 && merges() < changes.length; cycle += 1) {
      mergedThisCycle = 0
      await app.queue.run({}, serial)
    }
    expect(merges(), "every change merged").toBe(changes.length)

    const perChange = new Map<string, number>()
    for (const execution of executions) {
      perChange.set(execution.pr, (perChange.get(execution.pr) ?? 0) + 1)
    }
    // Each change proves itself once for its author and once for the base it
    // actually merges onto — never for a base move it could not have used.
    // Before this filter the third change also proved itself at the base the
    // FIRST merge produced, a verdict the second merge destroyed unspent.
    expect([...perChange.values()]).toEqual([1, 2, 2])
    expect(executions).toHaveLength(5)
  })
})
