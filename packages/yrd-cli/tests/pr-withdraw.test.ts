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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createBayJobDefs, withBays } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type Journal, type JsonValue } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import { createJournal } from "@yrd/persistence"
import { runYrd, type PruneGitFacts, type YrdCliIO } from "@yrd/cli"
import { withMerge, withQueue, withStep, type PRShape, type SourceRewrite, type StepExecution } from "@yrd/queue"
import { withIssues } from "@yrd/issue"
import {
  withContests,
  type AttemptRunOutput,
  type ContestEvaluatorDef,
  type ContestGit,
  type ContestRunnerDef,
} from "@yrd/contest"

const HEAD_SHA = "1".repeat(40)
const HEAD2_SHA = "2".repeat(40)
const HEAD3_SHA = "3".repeat(40)
const BASE_SHA = "a".repeat(40)
const MERGED_SHA = "b".repeat(40)
const BASE_TREE = "e".repeat(40)
const OTHER_TREE = "f".repeat(40)
const OVERSIZED_MERGE_TREE_BYTES = 1024 * 1024

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

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 8 * OVERSIZED_MERGE_TREE_BYTES,
  }).trim()
}

function gitResult(cwd: string, ...args: string[]): Readonly<{ code: number; stdout: string }> {
  try {
    return {
      code: 0,
      stdout: execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        maxBuffer: 8 * OVERSIZED_MERGE_TREE_BYTES,
      }),
    }
  } catch (error) {
    const failed = error as Readonly<{ status?: unknown; stdout?: unknown }>
    if (typeof failed.status !== "number") throw error
    const stdout =
      typeof failed.stdout === "string"
        ? failed.stdout
        : failed.stdout instanceof Uint8Array
          ? Buffer.from(failed.stdout).toString("utf8")
          : ""
    return { code: failed.status, stdout }
  }
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
    expect(JSON.parse(output.stdout())).toMatchObject({
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
    expect(unknown.stderr()).toBe("error: no PR 'nope'\n")

    expect(await runYrd(app, yrd("pr", "withdraw", "PR2"), outputIO().io)).toBe(0)
    const terminal = outputIO()
    expect(await runYrd(app, yrd("pr", "withdraw", "PR2"), terminal.io)).toBe(1)
    expect(terminal.stderr()).toBe("error: PR 'PR2' is withdrawn; a terminal PR cannot be withdrawn\n")

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

describe("pr prune", () => {
  it("does not trust --quiet when a sibling directory entry masks a content conflict", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yrd-prune-quiet-false-negative-"))
    try {
      git(dir, "init", "-q", "-b", "main")
      git(dir, "config", "user.name", "Yrd Test")
      git(dir, "config", "user.email", "yrd@example.invalid")
      writeFileSync(join(dir, "control.md"), "one\nbase\nthree\n")
      mkdirSync(join(dir, "control"))
      writeFileSync(join(dir, "control", "existing.md"), "existing\n")
      git(dir, "add", ".")
      git(dir, "commit", "-qm", "base")

      git(dir, "switch", "-q", "-c", "topic/quiet-false-negative")
      writeFileSync(join(dir, "control.md"), "one\ntopic\nthree\n")
      writeFileSync(join(dir, "control", "same.md"), "same on both sides\n")
      git(dir, "add", ".")
      git(dir, "commit", "-qm", "topic")
      const headSha = git(dir, "rev-parse", "HEAD")

      git(dir, "switch", "-q", "main")
      writeFileSync(join(dir, "control.md"), "one\nmain\nthree\n")
      writeFileSync(join(dir, "control", "same.md"), "same on both sides\n")
      git(dir, "add", ".")
      git(dir, "commit", "-qm", "main")
      const baseSha = git(dir, "rev-parse", "HEAD")
      git(dir, "update-ref", "refs/remotes/origin/main", baseSha)

      const quiet = gitResult(dir, "merge-tree", "--write-tree", "--quiet", baseSha, headSha)
      const normal = gitResult(dir, "merge-tree", "--write-tree", baseSha, headSha)
      expect({ quiet: quiet.code, normal: normal.code }).toEqual({ quiet: 0, normal: 1 })

      const app = await createCliApp()
      await app.bays.submit({ branch: "topic/quiet-false-negative", headSha, base: "main", baseSha: BASE_SHA })
      const output = outputIO({ cwd: dir })
      expect(await runYrd(app, yrd("pr", "prune", "--dry-run", "--json"), output.io), output.stderr()).toBe(0)
      expect(JSON.parse(output.stdout())).toMatchObject({
        checked: [
          {
            pr: "PR1",
            checks: { headPresent: true, ancestorOfBase: false, mergeTree: "conflicts" },
            verdict: "keep",
          },
        ],
        summary: { checked: 1, withdrawn: 0, wouldWithdraw: 0, kept: 1, errors: 0 },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("completes when one real merge-tree conflict report exceeds one MiB", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yrd-prune-large-merge-tree-"))
    try {
      git(dir, "init", "-q", "-b", "main")
      git(dir, "config", "user.name", "Yrd Test")
      git(dir, "config", "user.email", "yrd@example.invalid")
      const paths = Array.from(
        { length: 900 },
        (_, index) => `conflict-${index.toString().padStart(4, "0")}-${"x".repeat(220)}.txt`,
      )
      for (const path of paths) writeFileSync(join(dir, path), "base\n")
      git(dir, "add", ".")
      git(dir, "commit", "-qm", "base")
      git(dir, "switch", "-q", "-c", "topic/oversized")
      for (const path of paths) writeFileSync(join(dir, path), "topic\n")
      git(dir, "commit", "-qam", "topic")
      const headSha = git(dir, "rev-parse", "HEAD")
      git(dir, "switch", "-q", "main")
      for (const path of paths) writeFileSync(join(dir, path), "main\n")
      git(dir, "commit", "-qam", "main")
      const baseSha = git(dir, "rev-parse", "HEAD")
      git(dir, "update-ref", "refs/remotes/origin/main", baseSha)

      let rawConflictBytes = 0
      try {
        git(dir, "merge-tree", "--write-tree", baseSha, headSha)
        throw new Error("expected merge-tree to report conflicts")
      } catch (error) {
        const failed = error as Readonly<{ status?: unknown; stdout?: unknown }>
        expect(failed.status).toBe(1)
        const stdout =
          typeof failed.stdout === "string"
            ? failed.stdout
            : failed.stdout instanceof Uint8Array
              ? Buffer.from(failed.stdout).toString("utf8")
              : ""
        rawConflictBytes = Buffer.byteLength(stdout)
      }
      expect(rawConflictBytes).toBeGreaterThan(OVERSIZED_MERGE_TREE_BYTES)

      const app = await createCliApp()
      await app.bays.submit({ branch: "topic/oversized", headSha, base: "main", baseSha: BASE_SHA })
      const output = outputIO({ cwd: dir })
      expect(await runYrd(app, yrd("pr", "prune", "--dry-run", "--json"), output.io), output.stderr()).toBe(0)
      expect(JSON.parse(output.stdout())).toMatchObject({
        command: "pr.prune",
        checked: [
          {
            pr: "PR1",
            checks: { headPresent: true, ancestorOfBase: false, mergeTree: "conflicts" },
            verdict: "keep",
          },
        ],
        summary: { checked: 1, withdrawn: 0, wouldWithdraw: 0, kept: 1, errors: 0 },
        withdrawn: [],
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("records one PR error and continues judging every later PR", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/one", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    await app.bays.submit({ branch: "topic/broken", headSha: HEAD2_SHA, base: "main", baseSha: BASE_SHA })
    await app.bays.submit({ branch: "topic/three", headSha: HEAD3_SHA, base: "main", baseSha: BASE_SHA })

    const judged: string[] = []
    const facts = pruneGit({
      resolveCommit: (ref) =>
        ref === "origin/main" ? BASE_SHA : ref === HEAD_SHA || ref === HEAD2_SHA || ref === HEAD3_SHA ? ref : undefined,
      isAncestor: (ancestor) => {
        judged.push(ancestor)
        if (ancestor === HEAD2_SHA) throw new Error("simulated merge-base transport failure")
        return ancestor === HEAD3_SHA
      },
      mergeTree: (_baseSha, headSha) => {
        if (headSha !== HEAD_SHA) throw new Error(`mergeTree must not inspect ${headSha}`)
        return OTHER_TREE
      },
    })
    const output = outputIO({ pruneGit: () => facts })
    expect(await runYrd(app, yrd("pr", "prune", "--dry-run", "--json"), output.io), output.stderr()).toBe(0)
    expect(judged).toEqual([HEAD_SHA, HEAD2_SHA, HEAD3_SHA])
    expect(JSON.parse(output.stdout())).toMatchObject({
      checked: [
        { pr: "PR1", verdict: "keep" },
        {
          pr: "PR2",
          verdict: "error",
          error: "PR 'PR2' could not be judged: simulated merge-base transport failure",
        },
        { pr: "PR3", verdict: "would-withdraw" },
      ],
      summary: { checked: 3, withdrawn: 0, wouldWithdraw: 1, kept: 1, errors: 1 },
      withdrawn: [],
    })

    const human = outputIO({ pruneGit: () => facts, columns: 400 })
    expect(await runYrd(app, yrd("pr", "prune", "--dry-run"), human.io), human.stderr()).toBe(0)
    const humanText = human.stdout().replace(/\s+/g, " ")
    expect(humanText).toContain("[error] PR2 topic/broken r1")
    expect(humanText).toContain("PR 'PR2' could not be judged: simulated merge-base transport failure")
    expect(humanText).toContain("checked 3 live PRs — 1 would be withdrawn, 1 kept, 1 error")
  })

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
