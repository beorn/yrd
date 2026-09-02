/**
 * @failure `yrd pr list` and `yrd queue status` say `submitted` both for a change the queue could not carry and for a change a check judged, so an operator cannot tell the queue's fault from the submitter's.
 * @level l2
 * @consumer @yrd/cli pr list, queue status
 *
 * One change is built in each of the five states through the queue's own
 * records — a submit, a passed on-submit check, a refusal the environment
 * owns, a refusal the content owns, and a head proven to be on the target —
 * and the surface is asked what it prints for each.
 *
 * The states themselves are the plan of record's (`pm/@i/10-yrd/plan.md`
 * § The words): queued, checked, stuck, merged, failed. The taxonomy they
 * replace — `env`, `job-lost`, `admission-only`, `infra-retry`, `stale-pr`
 * and their siblings — classified a FAILURE once it had one, and had nothing
 * to say about a change still in line, which is why both of the two cases
 * above came out as one word.
 */
import { createElement } from "react"
import { renderString } from "silvery"
import { describe, expect, it } from "vitest"
import { createBayJobDefs, withBays, volatilePrNumberMint, currentChangeRev, type Change } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type JsonValue } from "@yrd/core"
import { withContests, type CommitResolver } from "@yrd/contest"
import { withIssues } from "@yrd/issue"
import { withJobs, type JobResult } from "@yrd/job"
import {
  withMerge,
  withQueue,
  withStep,
  type ChangeShape,
  type SourceRewrite,
  type StepExecution,
} from "@yrd/queue"
import { runYrd, type PruneGitFacts, type YrdCliIO } from "@yrd/cli"
import { createLogger } from "loggily"
import { deriveChangeState } from "../src/derived-change-state.ts"
import { ChangeStatusView } from "../src/status-view.tsx"

const WIDTH = 160
const BASE_SHA = "a".repeat(40)
const MERGED_SHA = "b".repeat(40)

/** A distinct head per state, so no row can borrow another's ancestry answer. */
const HEADS = {
  queued: "1".repeat(40),
  checked: "2".repeat(40),
  stuck: "3".repeat(40),
  failed: "4".repeat(40),
  merged: "5".repeat(40),
} as const

function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace() {
  return {
    revision: "five-states-workspace-v1",
    provision: (input: { bay: string }) => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { path: `/repo/.bays/${input.bay}`, headSha: HEADS.queued, baseSha: BASE_SHA },
    }),
    refresh: (input: { bay: string; path?: string }) => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: {
        path: input.path ?? `/repo/.bays/${input.bay}`,
        headSha: HEADS.queued,
        baseSha: BASE_SHA,
        dirty: false,
      },
    }),
    checkpoint: () => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { headSha: HEADS.queued, pushed: true as const, wip: false },
    }),
    deprovision: () => ({ status: "completed" as const, conclusion: "success" as const, output: {} }),
  }
}

async function createCliApp() {
  const bayJobs = createBayJobDefs(workspace())
  const check = withStep(
    "check",
    (): JobResult<JsonValue> => ({ status: "completed", conclusion: "success", output: { checked: true } }),
    { revision: "check-v1", output: JsonSchema, classification: "carrier" },
  )
  const merge = withMerge(
    async (
      _input: StepExecution<ChangeShape>,
    ): Promise<JobResult<{ commit: string; baseSha: string; sourceRewrites?: readonly SourceRewrite[] }>> => ({
      status: "completed",
      conclusion: "success",
      output: { commit: MERGED_SHA, baseSha: MERGED_SHA },
    }),
    { revision: "merge-v1" },
  )
  const queue = withQueue({ steps: [check, merge] as const, batch: false })
  const git: CommitResolver = { revision: "git-v1", resolveCommit: () => BASE_SHA }
  const contests = withContests({ runners: [], evaluators: [], git })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs, contests.jobDefs] }),
    withIssues({ sources: [{ id: "km", resolve: (ref) => ({ ref, title: "Issue one" }) }] }),
    withBays({
      prNumberMint: volatilePrNumberMint(),
      jobs: bayJobs,
      defaultBase: "main",
      resolveBase: (ref) => ({ base: ref, baseSha: BASE_SHA }),
    }),
  )
  return createYrd(contests(queue(base)), {
    inject: {
      journal: createMemoryJournal(),
      clock: () => "2026-07-15T12:00:00.000Z",
      id: ids(),
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
}

type CliApp = Awaited<ReturnType<typeof createCliApp>>

function outputIO(overrides: Partial<YrdCliIO> = {}) {
  let stdout = ""
  let stderr = ""
  const io: YrdCliIO = {
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
    cwd: "/repo",
    columns: WIDTH,
    runner: "five-states-test",
    leaseMs: 60_000,
    now: () => Date.parse("2026-07-15T12:01:00.000Z"),
    ...overrides,
  }
  return { io, stdout: () => stdout, stderr: () => stderr }
}

function yrd(...args: string[]): string[] {
  return ["/usr/bin/bun", "/repo/bin/yrd.ts", ...args]
}

/** Only the merged head is on the target. Every other head is live, and any
 * capability the list should not need refuses, so a pass proves which
 * plumbing answered. */
function mergeGit(): PruneGitFacts {
  return {
    resolveCommit: (ref) =>
      ref === "origin/main" || ref === "main"
        ? BASE_SHA
        : Object.values(HEADS).includes(ref as (typeof HEADS)[keyof typeof HEADS])
          ? ref
          : undefined,
    isAncestor: (ancestor, descendant) => ancestor === HEADS.merged && descendant === BASE_SHA,
    mergeTree: () => {
      throw new Error("pr list must not need a merge-tree proof")
    },
    treeOf: () => {
      throw new Error("pr list must not need a tree OID")
    },
  }
}

async function changeOf(app: CliApp, branch: string): Promise<Change> {
  const pr = Object.values(app.state().bays.prs).find((candidate) => candidate.branch === branch)
  if (pr === undefined) throw new Error(`the store never recorded a change for '${branch}'`)
  return pr
}

/** Record the on-submit checks refusing this change, the way the queue does:
 * one refused step, with the code and the check that reached it. */
async function refuse(
  app: CliApp,
  branch: string,
  headSha: string,
  refusal: Readonly<{ kind: "refusal" | "failure" | "infrastructure"; step: string; code: string; message: string }>,
): Promise<void> {
  const change = await changeOf(app, branch)
  await app.bays.recordAdmission({
    pr: change.id,
    revision: currentChangeRev(change).n,
    headSha,
    admission: {
      status: "refused",
      kind: refusal.kind,
      baseSha: BASE_SHA,
      step: refusal.step,
      receipt: { code: refusal.code, message: refusal.message },
      steps: [
        {
          name: refusal.step,
          revision: "check-v1",
          job: `${change.id}:${refusal.step}`,
          status: "refused",
          receipt: { code: refusal.code, message: refusal.message },
        },
      ],
    },
  })
}

/**
 * One change in each of the five states, built the way the queue builds them.
 * Returns the branch each state was built on, so a caller reads rows by
 * branch rather than by an id the mint chose.
 */
async function fiveStates(app: CliApp): Promise<Record<keyof typeof HEADS, Change>> {
  // queued — submitted, its on-submit checks not yet passed.
  await app.bays.submit({ branch: "topic/queued", headSha: HEADS.queued, base: "main", baseSha: BASE_SHA })

  // checked — its on-submit checks passed, waiting its turn.
  await app.bays.submit({ branch: "topic/checked", headSha: HEADS.checked, base: "main", baseSha: BASE_SHA })
  const checked = await changeOf(app, "topic/checked")
  await app.bays.recordAdmission({
    pr: checked.id,
    revision: currentChangeRev(checked).n,
    headSha: HEADS.checked,
    admission: { status: "passed", baseSha: BASE_SHA, steps: [] },
  })

  // stuck — the check could not do its job: it ran out of room on the host,
  // which says nothing about the content.
  await app.bays.submit({ branch: "topic/stuck", headSha: HEADS.stuck, base: "main", baseSha: BASE_SHA })
  await refuse(app, "topic/stuck", HEADS.stuck, {
    kind: "infrastructure",
    step: "affected-tests",
    code: "check-storage-exhausted",
    message: "fatal: unable to write loose object file: Disk quota exceeded",
  })

  // failed — a check judged the content, and the submitter has to change it.
  await app.bays.submit({ branch: "topic/failed", headSha: HEADS.failed, base: "main", baseSha: BASE_SHA })
  await refuse(app, "topic/failed", HEADS.failed, {
    kind: "refusal",
    step: "refused-paths",
    code: "refused-path",
    message: "the change writes a path the target refuses",
  })

  // merged — the head is on the target, whatever the record says afterwards.
  await app.bays.submit({ branch: "topic/merged", headSha: HEADS.merged, base: "main", baseSha: BASE_SHA })
  const merged = await changeOf(app, "topic/merged")
  await app.bays.closePr({ pr: merged.id, reason: "the queue merged it" })

  return {
    queued: await changeOf(app, "topic/queued"),
    checked: await changeOf(app, "topic/checked"),
    stuck: await changeOf(app, "topic/stuck"),
    failed: await changeOf(app, "topic/failed"),
    merged: await changeOf(app, "topic/merged"),
  }
}

type ListedChange = Readonly<{ id: string; branch: string; changeState?: string; status: string; check?: string }>

async function listed(app: CliApp): Promise<readonly ListedChange[]> {
  const json = outputIO({ pruneGit: () => mergeGit() })
  expect(await runYrd(app, yrd("pr", "list", "--json"), json.io), json.stderr()).toBe(0)
  return (JSON.parse(json.stdout()) as { prs: readonly ListedChange[] }).prs
}

function byBranch(rows: readonly ListedChange[], branch: string): ListedChange {
  const row = rows.find((candidate) => candidate.branch === branch)
  if (row === undefined) throw new Error(`'yrd pr list' dropped the row for '${branch}'`)
  return row
}

describe("the five states a change is in", () => {
  it("gives every change exactly one of the five words, and only those five", async () => {
    const app = await createCliApp()
    await fiveStates(app)
    const rows = await listed(app)

    expect(rows).toHaveLength(5)
    expect(
      Object.fromEntries(rows.map((row) => [row.branch, row.changeState])),
    ).toEqual({
      "topic/queued": "queued",
      "topic/checked": "checked",
      "topic/stuck": "stuck",
      "topic/failed": "failed",
      "topic/merged": "merged",
    })
    // The words the surface may print are closed. A sixth would mean a state
    // nobody agreed to, which is how the taxonomy this replaces grew.
    expect(new Set(rows.map((row) => row.changeState))).toEqual(
      new Set(["queued", "checked", "stuck", "merged", "failed"]),
    )
  })

  /** The whole point: these two used to be one word. */
  it("tells the queue's fault from the submitter's", async () => {
    const app = await createCliApp()
    await fiveStates(app)
    const rows = await listed(app)

    expect(byBranch(rows, "topic/stuck").changeState).toBe("stuck")
    expect(byBranch(rows, "topic/failed").changeState).toBe("failed")
    // The specimen: the change whose check ran out of room carried the SAME
    // delivery word as a change simply waiting its turn, so the old surface
    // could not tell a broken queue from a healthy one. That word is still in
    // `--json` for one flag-day cycle, and it still cannot separate them.
    expect(byBranch(rows, "topic/stuck").status).toBe(byBranch(rows, "topic/queued").status)
    expect(byBranch(rows, "topic/stuck").changeState).not.toBe(byBranch(rows, "topic/queued").changeState)
  })

  it("names the check beside a failed change and says whose a stuck one is", async () => {
    const app = await createCliApp()
    await fiveStates(app)

    const human = outputIO({ pruneGit: () => mergeGit() })
    expect(await runYrd(app, yrd("pr", "list"), human.io), human.stderr()).toBe(0)
    const output = human.stdout()

    // The refusal's own step is what judged the content, and it is printed.
    const failedCheck = byBranch(await listed(app), "topic/failed").check
    expect(failedCheck).toBeDefined()
    expect(output).toContain(`failed ${failedCheck}`)
    expect(output).toContain("stuck the queue's")
  })

  it("derives each state from the records alone, with no ancestry probe for a live change", async () => {
    const app = await createCliApp()
    const changes = await fiveStates(app)

    expect(deriveChangeState(changes.queued).state).toBe("queued")
    expect(deriveChangeState(changes.checked).state).toBe("checked")
    expect(deriveChangeState(changes.stuck)).toMatchObject({
      state: "stuck",
      owner: "the queue's",
      code: "check-storage-exhausted",
    })
    expect(deriveChangeState(changes.failed)).toMatchObject({
      state: "failed",
      owner: "the submitter's",
      code: "refused-path",
    })
    // The record alone calls the merged one withdrawn; only the proof merges it.
    expect(deriveChangeState(changes.merged).state).toBe("failed")
    expect(deriveChangeState(changes.merged, { merged: true }).state).toBe("merged")
  })

  /**
   * Attribution is the queue's by default (plan of record, § Attribution): a
   * failing check is the submitter's only once it failed in the change's own
   * worktree and passed at the target. An ending carrying no code the queue
   * can classify has no such proof, so it is stuck, and the unclassifiable
   * code is carried rather than swallowed.
   */
  it("calls an ending it cannot attribute stuck, and keeps the code it could not read", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/unknown", headSha: HEADS.queued, base: "main", baseSha: BASE_SHA })
    await refuse(app, "topic/unknown", HEADS.queued, {
      kind: "failure",
      step: "some-check",
      code: "a-code-no-vocabulary-registers",
      message: "something ended the change and nobody registered what",
    })
    expect(deriveChangeState(await changeOf(app, "topic/unknown"))).toMatchObject({
      state: "stuck",
      owner: "the queue's",
      code: "a-code-no-vocabulary-registers",
    })
  })

  it("prints the same five words on the queue's own status surface", async () => {
    const app = await createCliApp()
    const changes = await fiveStates(app)
    const rendered = await renderString(
      createElement(ChangeStatusView, { prs: Object.values(changes), columns: WIDTH }),
      { width: WIDTH, height: 10_000, plain: true },
    )
    expect(rendered).toContain("STATE")
    for (const word of ["queued", "checked", "stuck", "failed"]) expect(rendered).toContain(word)
    // This view holds no ancestry proof, so the merged row reads from its
    // record — the surface never invents a merge it was not shown.
    expect(rendered).not.toContain("submitted")
  })
})
