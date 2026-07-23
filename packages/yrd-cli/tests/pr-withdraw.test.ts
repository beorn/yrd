/**
 * @failure `pr withdraw` silently no-ops instead of refusing loud on unknown or
 * terminal selectors, drops the recorded reason from the pr/withdrawn event, or
 * `pr prune` withdraws live content / keeps superseded content / emits events
 * during --dry-run, or hides what it checked per PR.
 * @level l2
 * @consumer @yrd/cli
 *
 * Drives the real `runYrd` command surface with JSON output like
 * selector-surfaces.test.ts; Git facts for `pr prune` are injected through
 * YrdCliIO.pruneGit so every verdict is deterministic.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createBayJobDefs, withBays } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type Journal, type JsonValue } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import { createJournal } from "@yrd/persistence"
import { runYrd, type PruneGitFacts, type RecutPreflightResult, type YrdCliIO } from "@yrd/cli"
import { withMerge, withQueue, withStep, type PRShape, type SourceRewrite, type StepExecution } from "@yrd/queue"
import { withIssues } from "@yrd/issue"
import {
  withContests,
  type AttemptRunOutput,
  type ContestEvaluatorDef,
  type ContestGit,
  type ContestRunnerDef,
} from "@yrd/contest"
import { createPruneGitFacts } from "../src/pr-withdraw.ts"

const HEAD_SHA = "1".repeat(40)
const HEAD2_SHA = "2".repeat(40)
const HEAD3_SHA = "3".repeat(40)
const BASE_SHA = "a".repeat(40)
const TARGET_BASE_SHA = "d".repeat(40)
const MERGED_SHA = "b".repeat(40)
const BASE_TREE = "e".repeat(40)
const OTHER_TREE = "f".repeat(40)
const PR380_PATCH_ID = "cce1b8d2e6b8167b77aa50e0f880b74d3fa8871d"
const PR380_LANDING_SHA = "868194792c4b2c1b07bd5a67c37ad3e21fd35ce1"
const PR473_LANDING_SHA = "b47e240a6c3091b4687de96296d39c0a610df200"
const PR476_PATCH_ID = "172a29302878f4f7fd0dcfad917ddbf434e78d04"

function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function testJournal(dir: string) {
  return createJournal({
    dir,
    inject: { sqliteVersion: "3.53.0" },
  } as unknown as Parameters<typeof createJournal>[0])
}

function workspace() {
  return {
    revision: "withdraw-workspace-v1",
    provision: (input: { bay: string }) => ({
      status: "passed" as const,
      output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD_SHA, baseSha: BASE_SHA },
    }),
    refresh: (input: { bay: string; path?: string }) => ({
      status: "passed" as const,
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: HEAD_SHA, baseSha: BASE_SHA, dirty: false },
    }),
    deprovision: () => ({ status: "passed" as const, output: {} }),
  }
}

/** Minimal contest adapters so the composed app matches YrdCliApp; withdraw and
 * prune never enter a contest, so passing stubs suffice. */
function contestAdapters() {
  const runner: ContestRunnerDef = {
    harness: "ag",
    revision: "ag-runner-v1",
    async run(input): Promise<JobResult<AttemptRunOutput>> {
      return {
        status: "passed",
        output: {
          pin: {
            commit: "c".repeat(40),
            ref: `refs/yrd/attempts/${input.contest}/${input.attempt}`,
            bay: input.bay.id,
            branch: input.bay.branch,
            baseSha: BASE_SHA,
          },
          wallTimeMs: 100,
          tokens: { input: 0, output: 0, cachedInput: 0, cacheWrite: 0, reasoning: 0 },
          cost: { kind: "reported", usd: 0, source: "ag" },
          artifacts: [],
        },
      }
    },
  }
  const evaluator: ContestEvaluatorDef = {
    id: "held-out",
    revision: "held-out-v1",
    authority: "held-out",
    async evaluate() {
      return { status: "passed", output: { verdict: "passed", artifacts: [] } }
    },
  }
  const git: ContestGit = { revision: "git-v1", resolveCommit: () => BASE_SHA }
  return { runner, evaluator, git }
}

async function createCliApp(options: { journal?: Journal<unknown> } = {}) {
  const bayJobs = createBayJobDefs(workspace())
  const check = withStep("check", (): JobResult<JsonValue> => ({ status: "passed", output: { checked: true } }), {
    revision: "check-v1",
    output: JsonSchema,
    classification: "carrier",
  })
  const merge = withMerge(
    async (
      _input: StepExecution<PRShape>,
    ): Promise<JobResult<{ commit: string; baseSha: string; sourceRewrites?: readonly SourceRewrite[] }>> => ({
      status: "passed",
      output: { commit: MERGED_SHA, baseSha: MERGED_SHA },
    }),
    { revision: "merge-v1" },
  )
  const queue = withQueue({ steps: [check, merge] as const, batch: false })
  const contest = contestAdapters()
  const contests = withContests({ runners: [contest.runner], evaluators: [contest.evaluator], git: contest.git })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs, contests.jobDefs] }),
    withIssues({ sources: [{ id: "km", resolve: (ref) => ({ ref, title: "Issue one" }) }] }),
    withBays({ jobs: bayJobs, defaultBase: "main", resolveBase: (ref) => ({ base: ref, baseSha: BASE_SHA }) }),
  )
  return createYrd(contests(queue(base)), {
    inject: { journal: options.journal ?? createMemoryJournal(), clock: () => "2026-07-15T12:00:00.000Z", id: ids() },
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
    runner: "cli-test",
    leaseMs: 60_000,
    now: () => Date.parse("2026-07-15T12:01:00.000Z"),
    ...overrides,
  }
  return { io, stdout: () => stdout, stderr: () => stderr }
}

function yrd(...args: string[]): string[] {
  return ["/usr/bin/bun", "/repo/bin/yrd.ts", ...args]
}

async function journaledEvents(app: CliApp, name: string): Promise<Record<string, unknown>[]> {
  const events = await Array.fromAsync(app.events())
  return events.filter((event) => event.name === name).map((event) => event.data as Record<string, unknown>)
}

/** Deterministic Git facts: origin/main resolves to BASE_SHA, known head SHAs
 * resolve to themselves, and every check not overridden refuses to run so a
 * test proves exactly which plumbing its scenario consulted. */
function pruneGit(overrides: Partial<PruneGitFacts> = {}): PruneGitFacts {
  return {
    resolveCommit: (ref) =>
      ref === "origin/main" ? BASE_SHA : ref === HEAD_SHA || ref === HEAD2_SHA ? ref : undefined,
    isAncestor: () => false,
    mergeTree: () => {
      throw new Error("mergeTree must not run in this scenario")
    },
    treeOf: (sha) => {
      if (sha !== BASE_SHA) throw new Error(`treeOf must only inspect the base tip, got ${sha}`)
      return BASE_TREE
    },
    ...overrides,
  }
}

type RecutPreflightGitFacts = PruneGitFacts &
  Readonly<{
    pinDistance(
      sourceBaseSha: string,
      targetBaseSha: string,
    ):
      | Readonly<{ sourceOnly: number; targetOnly: number }>
      | Promise<Readonly<{ sourceOnly: number; targetOnly: number }>>
    patchMatch(
      sourceBaseSha: string,
      headSha: string,
      targetBaseSha: string,
    ): Readonly<{ patchId?: string; targetSha?: string }> | Promise<Readonly<{ patchId?: string; targetSha?: string }>>
  }>

function recutPreflightGit(overrides: Partial<RecutPreflightGitFacts> = {}): RecutPreflightGitFacts {
  return {
    ...pruneGit({
      resolveCommit: (ref) =>
        ref === "origin/main"
          ? TARGET_BASE_SHA
          : ref === BASE_SHA || ref === HEAD_SHA || ref === HEAD2_SHA
            ? ref
            : undefined,
      mergeTree: () => BASE_TREE,
      treeOf: (sha) => {
        if (sha !== TARGET_BASE_SHA) throw new Error(`treeOf must only inspect the target tip, got ${sha}`)
        return BASE_TREE
      },
    }),
    pinDistance: () => ({ sourceOnly: 0, targetOnly: 3 }),
    patchMatch: () => ({ patchId: "c".repeat(40), targetSha: MERGED_SHA }),
    ...overrides,
  }
}

describe("pr withdraw", () => {
  it("withdraws a live PR, records the reason, and terminalizes its Queue work", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/stale", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    await app.dispatch(app.commands.queue.run, { prs: ["PR1"], steps: ["check"] })

    const output = outputIO()
    expect(
      await runYrd(app, yrd("pr", "withdraw", "PR1", "--reason", "superseded by rework", "--json"), output.io),
      output.stderr(),
    ).toBe(0)
    const result = JSON.parse(output.stdout()) as RecutPreflightResult
    expect(result).toMatchObject({
      command: "pr.withdraw",
      reason: "superseded by rework",
      prs: [
        {
          id: "PR1",
          status: "withdrawn",
          withdrawReason: "superseded by rework",
          taskStatus: "dropped",
          glyph: "−",
        },
      ],
    })
    expect(app.state().bays.prs.PR1).toMatchObject({ status: "withdrawn", withdrawReason: "superseded by rework" })
    expect(await journaledEvents(app, "pr/withdrawn")).toEqual([
      expect.objectContaining({ pr: "PR1", revision: 1, headSha: HEAD_SHA, reason: "superseded by rework" }),
    ])
    expect(app.queue.get("R1")).toMatchObject({
      status: "failed",
      steps: [{ job: { status: "canceled", canceledBy: "cli-test", cancelReason: "superseded by rework" } }],
    })

    // The queue timeline renders a withdrawn PR distinctly: its Queue run row
    // is terminal, and a run-less withdrawn PR gets the dedicated retired row.
    const log = outputIO()
    expect(await runYrd(app, yrd("log", "--pr", "PR1", "--json"), log.io), log.stderr()).toBe(0)
    expect((JSON.parse(log.stdout()) as { rows: Record<string, unknown>[] }).rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ pr: "PR1", run: "R1", outcome: "rejected" })]),
    )
    await app.bays.submit({ branch: "topic/stale-norun", headSha: HEAD2_SHA, base: "main", baseSha: BASE_SHA })
    expect(await runYrd(app, yrd("pr", "withdraw", "PR2", "--reason", "never queued"), outputIO().io)).toBe(0)
    const retired = outputIO()
    expect(await runYrd(app, yrd("log", "--pr", "PR2", "--json"), retired.io), retired.stderr()).toBe(0)
    expect((JSON.parse(retired.stdout()) as { rows: Record<string, unknown>[] }).rows).toEqual([
      expect.objectContaining({ pr: "PR2", run: "-", outcome: "retired", glyph: "−" }),
    ])
  })

  it("refuses unknown selectors and terminal PRs loud, without emitting", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/one", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    await app.bays.submit({ branch: "topic/two", headSha: HEAD2_SHA, base: "main", baseSha: BASE_SHA })

    const unknown = outputIO()
    expect(await runYrd(app, yrd("pr", "withdraw", "nope"), unknown.io)).toBe(1)
    expect(unknown.stderr()).toContain("no PR 'nope'")

    expect(await runYrd(app, yrd("pr", "withdraw", "PR2"), outputIO().io)).toBe(0)
    const terminal = outputIO()
    expect(await runYrd(app, yrd("pr", "withdraw", "PR2"), terminal.io)).toBe(1)
    expect(terminal.stderr()).toContain("PR 'PR2' is withdrawn; a terminal PR cannot be withdrawn")

    // A mixed batch refuses whole before the first event: PR1 stays live.
    const mixed = outputIO()
    expect(await runYrd(app, yrd("pr", "withdraw", "PR1", "PR2"), mixed.io)).toBe(1)
    expect(mixed.stderr()).toContain("PR 'PR2' is withdrawn")
    expect(app.state().bays.prs.PR1).toMatchObject({ status: "submitted" })
    expect(await journaledEvents(app, "pr/withdrawn")).toHaveLength(1)
  })
})

describe("pr withdraw journal replay", () => {
  it("replays reason-bearing and reason-less withdrawals through a fresh session", async () => {
    // A second yrd invocation in a real repository is a FRESH app replaying the
    // persisted journal (projectFrame source="replay"), not the appending app.
    // This is the path where a strict pr/withdrawn schema without `reason`
    // would refuse the journal with the version-skew guidance.
    const dir = mkdtempSync(join(tmpdir(), "yrd-withdraw-replay-"))
    try {
      const first = await createCliApp({ journal: testJournal(dir) })
      await first.bays.submit({ branch: "topic/reasoned", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
      await first.bays.submit({ branch: "topic/reasonless", headSha: HEAD2_SHA, base: "main", baseSha: BASE_SHA })
      const withdraw = outputIO()
      expect(
        await runYrd(first, yrd("pr", "withdraw", "PR1", "--reason", "superseded by rework"), withdraw.io),
        withdraw.stderr(),
      ).toBe(0)
      expect(await runYrd(first, yrd("pr", "close", "PR2"), outputIO().io)).toBe(0)
      await first.close()

      const second = await createCliApp({ journal: testJournal(dir) })
      try {
        expect(second.state().bays.prs.PR1).toMatchObject({
          status: "withdrawn",
          withdrawReason: "superseded by rework",
        })
        expect(second.state().bays.prs.PR2).toMatchObject({ status: "withdrawn" })
        expect(second.state().bays.prs.PR2?.withdrawReason).toBeUndefined()
        const log = outputIO()
        expect(await runYrd(second, yrd("log", "--pr", "PR1", "--json"), log.io), log.stderr()).toBe(0)
        expect((JSON.parse(log.stdout()) as { rows: Record<string, unknown>[] }).rows).toEqual([
          expect.objectContaining({ pr: "PR1", run: "-", outcome: "retired", glyph: "−" }),
        ])
      } finally {
        await second.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("pr recut --preflight", () => {
  it("replays PR380 as SUBSUMED-WITHDRAW without recutting or emitting events", async () => {
    const app = await createCliApp()
    await app.bays.submit({
      branch: "specimen/PR380",
      headSha: HEAD_SHA,
      base: "main",
      baseSha: BASE_SHA,
    })
    const before = (await Array.fromAsync(app.events())).length
    const output = outputIO({
      pruneGit: () =>
        recutPreflightGit({
          patchMatch: () => ({ patchId: PR380_PATCH_ID, targetSha: PR380_LANDING_SHA }),
        }),
    })

    expect(await runYrd(app, yrd("pr", "recut", "PR1", "--preflight", "--json"), output.io), output.stderr()).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({
      command: "pr.recut.preflight",
      pr: "PR1",
      revision: 1,
      verdict: "SUBSUMED-WITHDRAW",
      evidence: {
        headSha: HEAD_SHA,
        sourceBaseSha: BASE_SHA,
        targetBaseSha: TARGET_BASE_SHA,
        pinDistance: { sourceOnly: 0, targetOnly: 3 },
        patchId: PR380_PATCH_ID,
        patchMatchTarget: PR380_LANDING_SHA,
        tree: "identical",
      },
    })
    expect((await Array.fromAsync(app.events())).length).toBe(before)
    expect(app.state().bays.prs.PR1).toMatchObject({ revision: 1, headSha: HEAD_SHA })
  })

  it.each([
    {
      specimen: "PR473",
      verdict: "SUBSUMED-WITHDRAW",
      mergeTree: BASE_TREE,
      patchId: "c".repeat(40),
      patchTarget: PR473_LANDING_SHA,
      targetOnly: 2,
    },
    {
      specimen: "PR476",
      verdict: "RECUT",
      mergeTree: OTHER_TREE,
      patchId: PR476_PATCH_ID,
      patchTarget: undefined,
      targetOnly: 4,
    },
  ] as const)(
    "replays $specimen in one preflight invocation as $verdict",
    async ({ specimen, verdict, mergeTree, patchId, patchTarget, targetOnly }) => {
      const app = await createCliApp()
      await app.bays.submit({
        branch: `specimen/${specimen}`,
        headSha: HEAD_SHA,
        base: "main",
        baseSha: BASE_SHA,
      })
      const before = (await Array.fromAsync(app.events())).length
      const output = outputIO({
        pruneGit: () =>
          recutPreflightGit({
            mergeTree: () => mergeTree,
            pinDistance: () => ({ sourceOnly: 0, targetOnly }),
            patchMatch: () => ({
              patchId,
              ...(patchTarget === undefined ? {} : { targetSha: patchTarget }),
            }),
          }),
      })

      expect(await runYrd(app, yrd("pr", "recut", "PR1", "--preflight", "--json"), output.io), output.stderr()).toBe(0)
      expect(JSON.parse(output.stdout())).toMatchObject({
        verdict,
        evidence: {
          pinDistance: { sourceOnly: 0, targetOnly },
          patchId,
          patchMatchTarget: patchTarget ?? null,
          tree: mergeTree === BASE_TREE ? "identical" : "divergent",
        },
      })
      expect((await Array.fromAsync(app.events())).length).toBe(before)
    },
  )

  it("treats a patch-id match as evidence, not withdrawal authority", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "collision/whitespace", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    const output = outputIO({
      pruneGit: () =>
        recutPreflightGit({
          mergeTree: () => OTHER_TREE,
          patchMatch: () => ({ patchId: "c".repeat(40), targetSha: MERGED_SHA }),
        }),
    })

    expect(await runYrd(app, yrd("pr", "recut", "PR1", "--preflight", "--json"), output.io), output.stderr()).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({
      verdict: "RECUT",
      evidence: { patchMatchTarget: MERGED_SHA, tree: "divergent" },
    })
  })

  it("reports FRESH-NOOP from the selected revision's exact base pin", async () => {
    const app = await createCliApp()
    await app.bays.submit({
      branch: "topic/fresh",
      headSha: HEAD_SHA,
      base: "main",
      baseSha: BASE_SHA,
      draft: true,
    })
    await app.bays.recut({
      pr: "PR1",
      fromRevision: 1,
      headSha: HEAD2_SHA,
      baseSha: BASE_SHA,
      treeSha: "7".repeat(40),
      patchId: "8".repeat(40),
      reviewCarried: false,
    })
    const output = outputIO({
      pruneGit: () =>
        recutPreflightGit({
          resolveCommit: (ref) =>
            ref === "origin/main" || ref === BASE_SHA ? BASE_SHA : ref === HEAD2_SHA ? HEAD2_SHA : undefined,
          mergeTree: () => OTHER_TREE,
          treeOf: (sha) => {
            if (sha !== BASE_SHA) throw new Error(`treeOf must only inspect the target tip, got ${sha}`)
            return BASE_TREE
          },
          pinDistance: () => ({ sourceOnly: 0, targetOnly: 0 }),
          patchMatch: () => ({ patchId: "c".repeat(40) }),
        }),
    })

    expect(await runYrd(app, yrd("pr", "recut", "PR1", "--preflight", "--json"), output.io), output.stderr()).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({
      revision: 2,
      verdict: "FRESH-NOOP",
      evidence: {
        headSha: HEAD2_SHA,
        sourceBaseSha: BASE_SHA,
        targetBaseSha: BASE_SHA,
        pinDistance: { sourceOnly: 0, targetOnly: 0 },
        certified: true,
      },
    })
  })

  it("reports RECUT-FORCE when recut would discard the current green check", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/green", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    if (!app.bays.checksRequested("PR1")) await app.bays.requestChecks({ pr: "PR1" })
    await app.queue.admit({ prs: ["PR1"] }, { runner: "cli-test", leaseMs: 60_000 })
    expect(app.queue.eligibility("PR1").checks.status).toBe("passed")
    const before = (await Array.fromAsync(app.events())).length
    const output = outputIO({
      pruneGit: () =>
        recutPreflightGit({
          mergeTree: () => OTHER_TREE,
          patchMatch: () => ({ patchId: "c".repeat(40) }),
        }),
    })

    expect(
      await runYrd(app, yrd("pr", "recut", "PR1", "--preflight", "--queue", "--json"), output.io),
      output.stderr(),
    ).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({
      verdict: "RECUT-FORCE",
      evidence: { passingCheck: true, requestedQueue: true },
      next: "yrd pr recut PR1 --queue --force",
    })
    expect((await Array.fromAsync(app.events())).length).toBe(before)
  })

  it("uses --revision evidence and refuses composed or diverged sources rather than guessing", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/revisions", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    await app.bays.intake({ branch: "topic/revisions", headSha: HEAD2_SHA, base: "main", baseSha: BASE_SHA })
    const selected = outputIO({
      pruneGit: () =>
        recutPreflightGit({
          mergeTree: () => OTHER_TREE,
          patchMatch: (_base, head) => ({ patchId: head === HEAD_SHA ? "1".repeat(40) : "2".repeat(40) }),
        }),
    })
    expect(
      await runYrd(app, yrd("pr", "recut", "PR1", "--revision", "1", "--preflight", "--json"), selected.io),
      selected.stderr(),
    ).toBe(0)
    expect(JSON.parse(selected.stdout())).toMatchObject({
      revision: 1,
      verdict: "RECUT",
      evidence: { headSha: HEAD_SHA, patchId: "1".repeat(40) },
      next: "yrd pr recut PR1 --revision 1",
    })

    const diverged = outputIO({
      pruneGit: () =>
        recutPreflightGit({
          mergeTree: () => OTHER_TREE,
          pinDistance: () => ({ sourceOnly: 1, targetOnly: 2 }),
        }),
    })
    expect(await runYrd(app, yrd("pr", "recut", "PR1", "--preflight", "--json"), diverged.io)).toBe(1)
    expect(diverged.stderr()).toContain("base aaaaaaaaaaaa diverged from target dddddddddddd")

    const composedApp = await createCliApp()
    await composedApp.bays.submit({
      branch: "topic/composed",
      headSha: HEAD_SHA,
      base: "main",
      baseSha: BASE_SHA,
      composition: {
        version: 1,
        sources: [
          {
            repo: "vendor/example",
            branch: "topic/source",
            baseSha: "4".repeat(40),
            tipSha: "5".repeat(40),
            payload: ["src/change.ts"],
          },
        ],
      },
    })
    const composed = outputIO({ pruneGit: () => recutPreflightGit() })
    expect(await runYrd(composedApp, yrd("pr", "recut", "PR1", "--preflight", "--json"), composed.io)).toBe(1)
    expect(composed.stderr()).toContain("has composed source payloads")
  })

  it("prints explicit pin-distance and patch-match evidence in human output", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/human", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    const output = outputIO({ pruneGit: () => recutPreflightGit(), columns: 160 })

    expect(await runYrd(app, yrd("pr", "recut", "PR1", "--preflight"), output.io), output.stderr()).toBe(0)
    expect(output.stdout()).toContain("SUBSUMED-WITHDRAW PR1 r1")
    expect(output.stdout()).toContain("pin-distance: source-only=0, target-only=3")
    expect(output.stdout()).toContain(`patch-id-match-target: ${MERGED_SHA.slice(0, 12)}`)
    expect(output.stdout()).toContain("tree-proof: ancestor=no, merge-tree=identical")
  })

  it("derives pin distance and a matching landing commit with real Git plumbing", () => {
    const dir = mkdtempSync(join(tmpdir(), "yrd-recut-preflight-"))
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
    try {
      git("init", "-b", "main")
      git("config", "user.name", "Yrd Test")
      git("config", "user.email", "yrd@example.test")
      writeFileSync(join(dir, "base.txt"), "base\n")
      git("add", "base.txt")
      git("commit", "-m", "base")
      const sourceBaseSha = git("rev-parse", "HEAD")

      git("switch", "-c", "candidate")
      writeFileSync(join(dir, "payload.txt"), "same payload\n")
      git("add", "payload.txt")
      git("commit", "-m", "candidate")
      const headSha = git("rev-parse", "HEAD")

      git("switch", "main")
      writeFileSync(join(dir, "payload.txt"), "same payload\n")
      git("add", "payload.txt")
      git("commit", "-m", "landed elsewhere")
      const targetBaseSha = git("rev-parse", "HEAD")

      const facts = createPruneGitFacts(dir)
      expect(facts.pinDistance?.(sourceBaseSha, targetBaseSha)).toEqual({ sourceOnly: 0, targetOnly: 1 })
      expect(facts.patchMatch?.(sourceBaseSha, headSha, targetBaseSha)).toMatchObject({
        patchId: expect.stringMatching(/^[0-9a-f]{40}$/u),
        targetSha: targetBaseSha,
      })
      expect(facts.mergeTree(targetBaseSha, headSha)).toBe(facts.treeOf(targetBaseSha))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("pr prune", () => {
  it("withdraws a PR whose head is already an ancestor of the base tip", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/landed", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })

    const checkedAncestry: string[] = []
    const output = outputIO({
      pruneGit: () =>
        pruneGit({
          isAncestor: (ancestor, descendant) => {
            checkedAncestry.push(`${ancestor}..${descendant}`)
            return ancestor === HEAD_SHA && descendant === BASE_SHA
          },
        }),
    })
    expect(await runYrd(app, yrd("pr", "prune", "--json"), output.io), output.stderr()).toBe(0)
    expect(checkedAncestry).toEqual([`${HEAD_SHA}..${BASE_SHA}`])
    expect(JSON.parse(output.stdout())).toMatchObject({
      command: "pr.prune",
      dryRun: false,
      checked: [
        {
          pr: "PR1",
          branch: "topic/landed",
          headSha: HEAD_SHA,
          base: "main",
          baseSha: BASE_SHA,
          checks: { headPresent: true, ancestorOfBase: true, mergeTree: "skipped" },
          verdict: "withdraw",
          reason: `superseded: content already in ${BASE_SHA}`,
        },
      ],
      withdrawn: [{ id: "PR1", status: "withdrawn" }],
    })
    expect(app.state().bays.prs.PR1).toMatchObject({
      status: "withdrawn",
      withdrawReason: `superseded: content already in ${BASE_SHA}`,
    })
    expect(await journaledEvents(app, "pr/withdrawn")).toEqual([
      expect.objectContaining({ pr: "PR1", reason: `superseded: content already in ${BASE_SHA}` }),
    ])
  })

  it("withdraws a PR whose merge with the base reproduces the base tree exactly", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/absorbed", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })

    const output = outputIO({
      pruneGit: () =>
        pruneGit({
          mergeTree: (baseSha, headSha) => {
            expect([baseSha, headSha]).toEqual([BASE_SHA, HEAD_SHA])
            return BASE_TREE
          },
        }),
    })
    expect(await runYrd(app, yrd("pr", "prune", "--json"), output.io), output.stderr()).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({
      checked: [
        {
          pr: "PR1",
          checks: { headPresent: true, ancestorOfBase: false, mergeTree: "identical" },
          verdict: "withdraw",
          reason: `superseded: content already in ${BASE_SHA}`,
        },
      ],
      withdrawn: [{ id: "PR1", status: "withdrawn" }],
    })
    expect(app.state().bays.prs.PR1?.status).toBe("withdrawn")
  })

  it("keeps live PRs and prints the exact check behind every verdict", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/divergent", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    await app.bays.submit({ branch: "topic/conflicted", headSha: HEAD2_SHA, base: "main", baseSha: BASE_SHA })
    await app.bays.submit({ branch: "topic/unfetched", headSha: HEAD3_SHA, base: "main", baseSha: BASE_SHA })

    const facts = pruneGit({
      // Divergent content merges clean into a non-base tree; conflicted refuses to merge.
      mergeTree: (_baseSha, headSha) => (headSha === HEAD_SHA ? OTHER_TREE : undefined),
    })
    const json = outputIO({ pruneGit: () => facts })
    expect(await runYrd(app, yrd("pr", "prune", "--json"), json.io), json.stderr()).toBe(0)
    expect(JSON.parse(json.stdout())).toMatchObject({
      checked: [
        { pr: "PR1", checks: { headPresent: true, ancestorOfBase: false, mergeTree: "divergent" }, verdict: "keep" },
        { pr: "PR2", checks: { headPresent: true, ancestorOfBase: false, mergeTree: "conflicts" }, verdict: "keep" },
        { pr: "PR3", checks: { headPresent: false }, verdict: "keep" },
      ],
      withdrawn: [],
    })
    expect(app.state().bays.prs.PR1?.status).toBe("submitted")
    expect(app.state().bays.prs.PR2?.status).toBe("submitted")
    expect(app.state().bays.prs.PR3?.status).toBe("submitted")

    const human = outputIO({ pruneGit: () => facts, columns: 400 })
    expect(await runYrd(app, yrd("pr", "prune"), human.io), human.stderr()).toBe(0)
    expect(human.stdout()).toContain("[keep] PR1 topic/divergent r1")
    expect(human.stdout()).toContain("merge-tree=divergent")
    expect(human.stdout()).toContain("[keep] PR2 topic/conflicted r1")
    expect(human.stdout()).toContain("merge-tree=conflicts")
    expect(human.stdout()).toContain("[keep] PR3 topic/unfetched r1")
    expect(human.stdout()).toContain("head commit is not present in this repository")
    expect(human.stdout()).toContain("checked 3 live PRs — 0 withdrawn, 3 kept")
  })

  it("emits nothing under --dry-run while naming what it would withdraw", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/landed", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    const before = (await Array.fromAsync(app.events())).length

    const output = outputIO({ pruneGit: () => pruneGit({ isAncestor: () => true }) })
    expect(await runYrd(app, yrd("pr", "prune", "--dry-run", "--json"), output.io), output.stderr()).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({
      command: "pr.prune",
      dryRun: true,
      checked: [{ pr: "PR1", verdict: "would-withdraw", reason: `superseded: content already in ${BASE_SHA}` }],
      withdrawn: [],
    })
    expect(app.state().bays.prs.PR1?.status).toBe("submitted")
    expect((await Array.fromAsync(app.events())).length).toBe(before)
  })
})
