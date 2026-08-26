/**
 * @failure A default listing hides live work: `pr list`'s newest-20 window
 * drops an open PR that is older than 20 terminal rows, or the queue
 * timeline's display cap evicts a draft/rev/ready row because its clock
 * anchor is old — the operator's own draft becomes invisible on every
 * default surface (live specimen 2026-08-07: PR138 and PR182, both `pushed`,
 * absent from human `pr list` and `queue list` while `--json` carried them).
 * Or the root `yrd submit` verb is missing, so the draft→ready step hides
 * behind `pr submit` and drafts accumulate unsubmitted.
 * @level l2
 * @consumer @yrd/cli
 */
import { describe, expect, it } from "vitest"
import { createBayJobDefs, withBays, volatilePrNumberMint } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type JsonValue } from "@yrd/core"
import { withContests, type ContestGit } from "@yrd/contest"
import { withIssues } from "@yrd/issue"
import { withJobs, type JobResult } from "@yrd/job"
import { withMerge, withQueue, withStep, type ChangeShape, type SourceRewrite, type StepExecution } from "@yrd/queue"
import { runYrd, type YrdCliIO } from "@yrd/cli"
import { createLogger } from "loggily"
import { timelineRetainedRows, type QueueTimelineDisplayRow } from "../src/queue-status-view.tsx"

const WIDTH = 120
const BASE_SHA = "a".repeat(40)
const MERGED_SHA = "b".repeat(40)

function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace() {
  return {
    revision: "live-visibility-workspace-v1",
    provision: (input: { bay: string }) => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { path: `/repo/.bays/${input.bay}`, headSha: BASE_SHA, baseSha: BASE_SHA },
    }),
    refresh: (input: { bay: string; path?: string }) => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: BASE_SHA, baseSha: BASE_SHA, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { headSha: BASE_SHA, pushed: true as const, wip: false },
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
  const git: ContestGit = { revision: "git-v1", resolveCommit: () => BASE_SHA }
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
      clock: () => "2026-08-07T12:00:00.000Z",
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
    runner: "live-visibility-test",
    leaseMs: 60_000,
    resolveRevision: async () => "f".repeat(40),
    now: () => Date.parse("2026-08-07T12:01:00.000Z"),
    ...overrides,
  }
  return { io, stdout: () => stdout, stderr: () => stderr }
}

function yrd(...args: string[]): string[] {
  return ["/usr/bin/bun", "/repo/bin/yrd.ts", ...args]
}

// ---------------------------------------------------------------------------
// 1. `pr list` — an open PR is never hidden by the default window.

describe("pr list never hides live work behind the default window", () => {
  it("keeps an open draft visible when 20+ newer PRs are terminal", async () => {
    const app = await createCliApp()
    // PR1 — the live draft, oldest id, `pushed` and never submitted.
    await app.bays.submit({
      branch: "task/oldest-draft",
      headSha: "1".repeat(40),
      base: "main",
      baseSha: BASE_SHA,
      draft: true,
    })
    // 21 newer PRs, all driven terminal (withdrawn) so the window is full of
    // terminal rows and PR1 sits strictly outside the newest-20 cut.
    for (const index of Array.from({ length: 21 }, (_, offset) => offset + 2)) {
      await app.bays.submit({
        branch: `topic/newer-${index}`,
        headSha: index.toString(16).padStart(40, "0"),
        base: "main",
        baseSha: BASE_SHA,
      })
      await app.bays.closePr({ pr: `PR${index}`, reason: "window filler" })
    }

    const human = outputIO()
    expect(await runYrd(app as CliApp, yrd("pr", "list"), human.io), human.stderr()).toBe(0)
    const output = human.stdout()
    // The live draft must be listed even though 21 terminal rows are newer…
    expect(output).toContain("pr#1.")
    // …and the disclosure line still tells the truth about what was withheld.
    expect(output).toMatch(/hidden/iu)
  })
})

// ---------------------------------------------------------------------------
// 2. Queue timeline — live rows (draft/rev/ready) are never evicted by the
//    display cap, no matter how old their clock anchor is.

function displayRow(overrides: Partial<QueueTimelineDisplayRow> & Pick<QueueTimelineDisplayRow, "id" | "status">) {
  return {
    base: "main",
    group: "completed",
    glyph: "✓",
    timestamp: "2026-08-07T11:00:00.000Z",
    timestampMs: Date.parse("2026-08-07T11:00:00.000Z"),
    pr: "PR999",
    revision: 1,
    headSha: "9".repeat(40),
    branch: "topic/x",
    subject: "subject",
    detail: "done",
    revisionLineage: [],
    ageMs: null,
    totalMs: null,
    activeMs: null,
    waitMs: null,
    ...overrides,
  } as QueueTimelineDisplayRow
}

describe("queue timeline display cap never evicts live rows", () => {
  it("pins a draft row older than every completed row", () => {
    const draft = displayRow({
      id: "main:pr:PR1:1:aaa",
      status: "draft",
      group: "draft",
      pr: "PR1",
      timestamp: "2026-08-01T00:00:00.000Z",
      timestampMs: Date.parse("2026-08-01T00:00:00.000Z"),
    })
    // 24 completed rows, all newer — sorted newest-first ahead of the draft.
    const history = Array.from({ length: 24 }, (_, index) =>
      displayRow({ id: `main:run:${index}`, status: "integrated", pr: `PR${100 + index}` }),
    )
    const retained = timelineRetainedRows([...history, draft], 20)
    expect(retained.map((row) => row.id)).toContain("main:pr:PR1:1:aaa")
    // The cap still binds: total retained stays at the cap.
    expect(retained).toHaveLength(20)
    // Order is preserved — the draft stays where the sort put it (last).
    expect(retained.at(-1)?.id).toBe("main:pr:PR1:1:aaa")
  })

  it("still binds the cap when live rows alone exceed it — the print path stays bounded", () => {
    const liveRows = Array.from({ length: 24 }, (_, index) =>
      displayRow({ id: `main:pr:PR${index}:1:aaa`, status: "ready", group: "pending", pr: `PR${index}` }),
    )
    const retained = timelineRetainedRows(liveRows, 20)
    expect(retained).toHaveLength(20)
    // Newest-first order wins: the first 20 live rows are kept, order preserved.
    expect(retained.map((row) => row.id)).toEqual(liveRows.slice(0, 20).map((row) => row.id))
  })

  it("applies the plain cap when nothing live is present", () => {
    const history = Array.from({ length: 24 }, (_, index) =>
      displayRow({ id: `main:run:${index}`, status: "integrated" }),
    )
    const retained = timelineRetainedRows(history, 20)
    expect(retained).toHaveLength(20)
    expect(retained.map((row) => row.id)).toEqual(history.slice(0, 20).map((row) => row.id))
  })
})

// ---------------------------------------------------------------------------
// 3. Root `yrd submit` — the everyday verb exists at the top level.

describe("root yrd submit", () => {
  /**
   * The visibility contract that put this verb at the top level SURVIVES:
   * the draft→ready step must never hide behind `yrd pr submit`. What the
   * verb DOES changed (@cto 2026-08-19, cliverbs ruling-a) — root `submit` is
   * now the branch-state verb, approving a branch by pushing
   * `refs/yrd/submit/<branch>` rather than aliasing the change path. The two are
   * the same intent at two phases: the receiver already dual-writes that ref
   * on carrier push. `yrd pr submit` is untouched and still drives the change
   * path, with all of its options.
   */
  it("exists at the top level and approves the current branch", async () => {
    const app = await createCliApp()
    const pushes: string[][] = []
    const out = outputIO({
      currentBranch: () => "topic/root-verb",
      changeStateGit: () => ({
        branches: () => ["main", "topic/root-verb"],
        remoteRef: () => undefined,
        push: (args) => {
          pushes.push([...args])
          return { ok: true, output: "" }
        },
      }),
    })

    expect(await runYrd(app as CliApp, yrd("submit"), out.io), out.stderr()).toBe(0)

    expect(pushes).toEqual([["push", "--atomic", "origin", "topic/root-verb:refs/yrd/submit/topic/root-verb"]])
  })

  it("root submit help speaks the branch-state words", async () => {
    const app = await createCliApp()
    const out = outputIO()
    await runYrd(app as CliApp, yrd("submit", "--help"), out.io)
    const help = out.stdout() + out.stderr()
    expect(help.toLowerCase()).toContain("approve")
    expect(help).toContain("--dry-run")
    // The merge-request vocabulary moved with the act, to `yrd pr submit`.
    expect(help.toLowerCase()).not.toContain("merge request")
  })
})
