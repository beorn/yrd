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
import { createBayJobDefs, currentChangeRev, changeDeliveryState, withBays } from "@yrd/bay"
import {
  createFailure,
  createMemoryJournal,
  createYrd,
  createYrdDef,
  JsonSchema,
  pipe,
  type Journal,
  type JsonValue,
} from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import { createJournal } from "@yrd/persistence"
import { createProcess } from "@yrd/process"
import { runYrd as runYrdRaw, type PruneGitFacts, type RecutPreflightResult, type YrdCliIO } from "@yrd/cli"
import { testQueueReadModel } from "./queue-read-model-test-helper.ts"
import {
  createGitPRRecutter,
  withMerge,
  withQueue,
  withStep,
  type CandidatePreparer,
  type changeShape,
  type SourceRewrite,
  type StepExecution,
} from "@yrd/queue"
import { withIssues } from "@yrd/issue"
import {
  withContests,
  type AttemptRunOutput,
  type ContestEvaluatorDef,
  type ContestGit,
  type ContestRunnerDef,
} from "@yrd/contest"
import { createPruneGitFacts } from "../src/pr-withdraw.ts"
import * as runInternals from "../src/run.ts"

function runYrd(
  app: Parameters<typeof runYrdRaw>[0],
  argv: readonly string[],
  io: YrdCliIO,
  services: Parameters<typeof runYrdRaw>[3] = {},
) {
  return runYrdRaw(app, argv, io, { queueReadModel: testQueueReadModel(app), ...services })
}

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
const PR1640_RECORDED_HEAD = "4d8615400959a1443b1664e707eecee10d6ebe95"
const PR1640_LIVE_HEAD = "b3fae22ec7a08288b586a28b123a9e11ad3bca91"
const PR1640_BRANCH = "task/@yrd/core/22366-post-landing-component-main"
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
      status: "completed" as const,
      conclusion: "success" as const,
      output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD_SHA, baseSha: BASE_SHA },
    }),
    refresh: (input: { bay: string; path?: string }) => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: HEAD_SHA, baseSha: BASE_SHA, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { headSha: HEAD_SHA, pushed: true as const, wip: false },
    }),
    deprovision: () => ({ status: "completed" as const, conclusion: "success" as const, output: {} }),
  }
}

/** Minimal contest adapters so the composed app matches YrdCliApp; withdraw and
 * prune never enter a contest, so passing stubs suffice. */
function contestAdapters() {
  const runner: ContestRunnerDef = {
    id: "fixture",
    revision: "fixture-runner-v1",
    async run(input): Promise<JobResult<AttemptRunOutput>> {
      return {
        status: "completed",
        conclusion: "success",
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
          cost: { kind: "reported", usd: 0, source: "fixture" },
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
      return { status: "completed", conclusion: "success", output: { verdict: "passed", artifacts: [] } }
    },
  }
  const git: ContestGit = { revision: "git-v1", resolveCommit: () => BASE_SHA }
  return { runner, evaluator, git }
}

async function createCliApp(
  options: {
    journal?: Journal<unknown>
    resolveBase?: (ref: string) => Readonly<{ base: string; baseSha: string }>
    merge?: (
      input: StepExecution<changeShape>,
    ) => Promise<JobResult<{ commit: string; baseSha: string; sourceRewrites?: readonly SourceRewrite[] }>>
    prepareCandidate?: CandidatePreparer
  } = {},
) {
  const bayJobs = createBayJobDefs(workspace())
  const check = withStep(
    "check",
    (): JobResult<JsonValue> => ({ status: "completed", conclusion: "success", output: { checked: true } }),
    {
      revision: "check-v1",
      output: JsonSchema,
      classification: "carrier",
    },
  )
  const merge = withMerge(
    options.merge ??
      (async (
        _input: StepExecution<changeShape>,
      ): Promise<JobResult<{ commit: string; baseSha: string; sourceRewrites?: readonly SourceRewrite[] }>> => ({
        status: "completed",
        conclusion: "success",
        output: { commit: MERGED_SHA, baseSha: MERGED_SHA },
      })),
    { revision: "merge-v1" },
  )
  const queue = withQueue({
    steps: [check, merge] as const,
    batch: false,
    ...(options.prepareCandidate === undefined ? {} : { prepareCandidate: options.prepareCandidate }),
  })
  const contest = contestAdapters()
  const contests = withContests({ runners: [contest.runner], evaluators: [contest.evaluator], git: contest.git })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs, contests.jobDefs] }),
    withIssues({ sources: [{ id: "km", resolve: (ref) => ({ ref, title: "Issue one" }) }] }),
    withBays({
      jobs: bayJobs,
      defaultBase: "main",
      resolveBase: options.resolveBase ?? ((ref) => ({ base: ref, baseSha: BASE_SHA })),
    }),
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

function sourceOnlyDivergentRecutRepository(): {
  root: string
  repo: string
  module: string
  sourceBase: string
  headSha: string
  targetSha: string
  moduleC: string
} {
  const root = mkdtempSync(join(tmpdir(), "yrd-recut-apply-"))
  const repo = join(root, "repo")
  const module = join(root, "module")
  execFileSync("git", ["init", "-q", "-b", "main", module])
  git(module, "config", "user.name", "Yrd Test")
  git(module, "config", "user.email", "yrd@example.invalid")
  git(module, "config", "uploadpack.allowAnySHA1InWant", "true")
  writeFileSync(join(module, "version.txt"), "a\n")
  git(module, "add", "version.txt")
  git(module, "commit", "-qm", "module a")
  const moduleA = git(module, "rev-parse", "HEAD")

  execFileSync("git", ["init", "-q", "-b", "main", repo])
  git(repo, "config", "user.name", "Yrd Test")
  git(repo, "config", "user.email", "yrd@example.invalid")
  git(repo, "config", "protocol.file.allow", "always")
  writeFileSync(join(repo, "README.md"), "main\n")
  git(repo, "add", "README.md")
  git(repo, "commit", "-qm", "root")
  git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", module, "dep")
  git(repo, "commit", "-qam", "add dep at a")
  const sourceBase = git(repo, "rev-parse", "HEAD")

  git(module, "checkout", "-q", "-B", "carrier-row", moduleA)
  writeFileSync(join(module, "carrier.txt"), "carrier\n")
  git(module, "add", "carrier.txt")
  git(module, "commit", "-qm", "carrier payload")
  const moduleB = git(module, "rev-parse", "HEAD")
  git(module, "checkout", "-q", "-B", "base-row", moduleA)
  writeFileSync(join(module, "current.txt"), "current\n")
  git(module, "add", "current.txt")
  git(module, "commit", "-qm", "current payload")
  const moduleC = git(module, "rev-parse", "HEAD")
  git(join(repo, "dep"), "fetch", "-q", "origin", "carrier-row", "base-row")

  git(repo, "switch", "-qc", "issue/source", sourceBase)
  git(repo, "update-index", "--cacheinfo", `160000,${moduleB},dep`)
  git(repo, "commit", "-qm", "carrier: bump dep only")
  const headSha = git(repo, "rev-parse", "HEAD")
  git(repo, "switch", "-q", "main")
  git(repo, "update-index", "--cacheinfo", `160000,${moduleC},dep`)
  writeFileSync(join(repo, "upstream.txt"), "upstream\n")
  git(repo, "add", "upstream.txt")
  git(repo, "commit", "-qm", "base: bump dep + upstream")
  const targetSha = git(repo, "rev-parse", "HEAD")
  const rootOrigin = join(root, "origin.git")
  execFileSync("git", ["init", "-q", "--bare", rootOrigin])
  git(repo, "remote", "add", "origin", rootOrigin)
  git(repo, "push", "-q", "origin", "main", "issue/source")
  return { root, repo, module, sourceBase, headSha, targetSha, moduleC }
}

function codeCarrierProposalCliRepository(): {
  root: string
  repo: string
  approvedBaseSha: string
  approvedSha: string
  currentBaseSha: string
  proposedRef: string
  proposedSha: string
} {
  const root = mkdtempSync(join(tmpdir(), "yrd-recut-certification-"))
  const repo = join(root, "repo")
  execFileSync("git", ["init", "-q", "-b", "main", repo])
  git(repo, "config", "user.name", "Yrd Test")
  git(repo, "config", "user.email", "yrd@example.invalid")
  writeFileSync(join(repo, "README.md"), "main\n")
  git(repo, "add", "README.md")
  git(repo, "commit", "-qm", "base")
  const approvedBaseSha = git(repo, "rev-parse", "HEAD")

  git(repo, "switch", "-qc", "issue/approved")
  writeFileSync(join(repo, "approved-a.txt"), "approved a\n")
  git(repo, "add", "approved-a.txt")
  git(repo, "commit", "-qm", "approved a")
  writeFileSync(join(repo, "approved-b.txt"), "approved b\n")
  git(repo, "add", "approved-b.txt")
  git(repo, "commit", "-qm", "approved b")
  const approvedSha = git(repo, "rev-parse", "HEAD")

  git(repo, "switch", "-q", "main")
  writeFileSync(join(repo, "authority.txt"), "current authority\n")
  git(repo, "add", "authority.txt")
  git(repo, "commit", "-qm", "advance authority")
  const currentBaseSha = git(repo, "rev-parse", "HEAD")
  git(repo, "switch", "-qc", "proposal/human-composed", currentBaseSha)
  writeFileSync(join(repo, "approved-a.txt"), "approved a\n")
  writeFileSync(join(repo, "approved-b.txt"), "approved b\n")
  git(repo, "add", ".")
  git(repo, "commit", "-qm", "independently authored proposal")
  const proposedSha = git(repo, "rev-parse", "HEAD")
  const proposedRef = "refs/heads/proposal/human-composed"

  git(repo, "switch", "-q", "main")
  const origin = join(root, "origin.git")
  execFileSync("git", ["init", "-q", "--bare", origin])
  git(repo, "remote", "add", "origin", origin)
  git(repo, "push", "-q", "origin", "main", "issue/approved", "proposal/human-composed")
  return { root, repo, approvedBaseSha, approvedSha, currentBaseSha, proposedRef, proposedSha }
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
            : ref.includes("/")
              ? HEAD_SHA
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
      await runYrd(
        app,
        yrd("pr", "withdraw", "PR1", "--reason", "superseded by rework", "--burn-payload", "--json"),
        output.io,
      ),
      output.stderr(),
    ).toBe(0)
    const result = JSON.parse(output.stdout()) as RecutPreflightResult
    expect(result).toMatchObject({
      command: "pr.withdraw",
      reason: "superseded by rework",
      prs: [
        {
          id: "PR1",
          state: "closed",
          merged: false,
          revs: [{ terminal: { kind: "withdrawn" } }],
          withdrawReason: "superseded by rework",
          taskStatus: "dropped",
          glyph: "−",
        },
      ],
    })
    expect(changeDeliveryState(app.state().bays.prs.PR1!)).toBe("withdrawn")
    expect(app.state().bays.prs.PR1).toMatchObject({ withdrawReason: "superseded by rework" })
    expect(await journaledEvents(app, "pr/withdrawn")).toEqual([
      expect.objectContaining({ pr: "PR1", revision: 1, headSha: HEAD_SHA, reason: "superseded by rework" }),
    ])
    expect(app.queue.get("R1")).toMatchObject({
      status: "completed",
      conclusion: "failure",
      steps: [
        {
          job: {
            status: "completed",
            conclusion: "cancelled",
            canceledBy: "cli-test",
            cancelReason: "superseded by rework",
          },
        },
      ],
    })

    // The queue timeline preserves the Run's truthful stale-pr outcome, while
    // a run-less withdrawn PR gets the dedicated retired row.
    const log = outputIO()
    expect(await runYrd(app, yrd("log", "--pr", "PR1", "--json"), log.io), log.stderr()).toBe(0)
    expect((JSON.parse(log.stdout()) as { rows: Record<string, unknown>[] }).rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ pr: "PR1", run: "R1", outcome: "stale" })]),
    )
    await app.bays.submit({ branch: "topic/stale-norun", headSha: HEAD2_SHA, base: "main", baseSha: BASE_SHA })
    expect(
      await runYrd(app, yrd("pr", "withdraw", "PR2", "--reason", "never queued", "--burn-payload"), outputIO().io),
    ).toBe(0)
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
    // Two PRs exist here, so `searched 2` proves the index was populated and
    // still did not match — the discrimination an empty answer cannot make.
    expect(unknown.stderr()).toBe("error: no PR 'nope' — searched 2 pull request(s)\n")

    expect(await runYrd(app, yrd("pr", "withdraw", "PR2", "--burn-payload"), outputIO().io)).toBe(0)
    const terminal = outputIO()
    expect(await runYrd(app, yrd("pr", "withdraw", "PR2"), terminal.io)).toBe(1)
    expect(terminal.stderr()).toBe("error: PR 'PR2' is withdrawn; a terminal PR cannot be withdrawn\n")

    // A mixed batch refuses whole before the first event: PR1 stays live.
    const mixed = outputIO()
    expect(await runYrd(app, yrd("pr", "withdraw", "PR1", "PR2"), mixed.io)).toBe(1)
    expect(mixed.stderr()).toContain("PR 'PR2' is withdrawn")
    expect(changeDeliveryState(app.state().bays.prs.PR1!)).toBe("submitted")
    expect(await journaledEvents(app, "pr/withdrawn")).toHaveLength(1)
  })
})

describe("I23 close merger + root cancel (chief ruling b9bf30f2)", () => {
  it("mr close does both records — withdrawn-with-reason first, then queue terminalization", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/one", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    await app.dispatch(app.commands.queue.run, { prs: ["PR1"], steps: ["check"] })

    const output = outputIO()
    expect(
      await runYrd(
        app,
        yrd("mr", "close", "PR1", "--reason", "superseded by rework", "--burn-payload", "--json"),
        output.io,
      ),
      output.stderr(),
    ).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({
      command: "pr.close",
      reason: "superseded by rework",
      prs: [{ id: "PR1", state: "closed", merged: false }],
    })
    expect(changeDeliveryState(app.state().bays.prs.PR1!)).toBe("withdrawn")
    expect(await journaledEvents(app, "pr/withdrawn")).toEqual([
      expect.objectContaining({ pr: "PR1", reason: "superseded by rework" }),
    ])
    expect(app.queue.get("R1")).toMatchObject({ status: "completed", conclusion: "failure" })
  })

  it("withdraw answers as a hidden alias with its stable envelope name", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/one", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })

    const help = outputIO({ columns: 100 })
    expect(await runYrd(app, yrd("mr"), help.io), help.stderr()).toBe(0)
    expect(help.stdout()).not.toMatch(/^\s{2}withdraw/mu)
    expect(help.stdout()).toMatch(/^\s{2}close.*--reason|close \[options\]/mu)

    const output = outputIO()
    expect(
      await runYrd(
        app,
        yrd("pr", "withdraw", "PR1", "--reason", "old spelling", "--burn-payload", "--json"),
        output.io,
      ),
    ).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({ command: "pr.withdraw", reason: "old spelling" })
    expect(changeDeliveryState(app.state().bays.prs.PR1!)).toBe("withdrawn")
  })

  it("root cancel stops the attempt and leaves the merge request open", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/one", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    await app.dispatch(app.commands.queue.run, { prs: ["PR1"], steps: ["check"] })

    const output = outputIO()
    expect(
      await runYrd(app, yrd("cancel", "PR1", "--reason", "bad attempt", "--json"), output.io),
      output.stderr(),
    ).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({ command: "queue.cancel" })
    // Attempt-scoped: the run is canceled, the merge request is NOT withdrawn.
    expect(changeDeliveryState(app.state().bays.prs.PR1!)).toBe("submitted")
    expect(await journaledEvents(app, "pr/withdrawn")).toHaveLength(0)
  })

  it("root cancel with no active attempt fails loud and teaches close --reason", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/one", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })

    const output = outputIO()
    expect(await runYrd(app, yrd("cancel", "PR1"), output.io)).toBe(1)
    expect(output.stderr()).toContain("no running or waiting attempt")
    expect(output.stderr()).toContain("mr close --reason")
  })
})

/**
 * Closing an unlanded merge request spends its payload identity: the commit can
 * never be offered again on another branch. The verb reads like housekeeping,
 * so the spend is disclosed and acknowledged BEFORE any event is emitted.
 */
describe("pre-spend disclosure on mr close", () => {
  it("refuses without --burn-payload, naming the revision and head it would spend", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/one", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })

    const output = outputIO()
    expect(await runYrd(app, yrd("mr", "close", "PR1", "--reason", "looked stale"), output.io)).toBe(1)
    // The exact revision, so an operator acting on a STALE read sees the
    // mismatch here rather than after the spend (the PR78 specimen).
    expect(output.stderr()).toContain("PR1 r1")
    expect(output.stderr()).toContain(HEAD_SHA)
    expect(output.stderr()).toContain("topic/one")
    expect(output.stderr()).toContain("--burn-payload")
    // Nothing was spent.
    expect(changeDeliveryState(app.state().bays.prs.PR1!)).toBe("submitted")
    expect(await journaledEvents(app, "pr/withdrawn")).toHaveLength(0)
  })

  it("--burn-payload discloses the spend, then withdraws", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/one", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })

    const output = outputIO()
    expect(
      await runYrd(app, yrd("mr", "close", "PR1", "--reason", "superseded", "--burn-payload"), output.io),
      output.stderr(),
    ).toBe(0)
    expect(output.stderr()).toContain("PR1 r1")
    expect(output.stderr()).toContain(HEAD_SHA)
    // The one door that stays open, named at the moment it is being shut.
    expect(output.stderr()).toContain("yrd pr submit topic/one")
    expect(changeDeliveryState(app.state().bays.prs.PR1!)).toBe("withdrawn")
    expect(await journaledEvents(app, "pr/withdrawn")).toHaveLength(1)
  })

  it("names every revision in a batch and emits nothing when unacknowledged", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/one", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    await app.bays.submit({ branch: "topic/two", headSha: HEAD2_SHA, base: "main", baseSha: BASE_SHA })

    const output = outputIO()
    expect(await runYrd(app, yrd("mr", "close", "PR1", "PR2"), output.io)).toBe(1)
    expect(output.stderr()).toContain("PR1 r1")
    expect(output.stderr()).toContain("PR2 r1")
    expect(output.stderr()).toContain(HEAD_SHA)
    expect(output.stderr()).toContain(HEAD2_SHA)
    expect(await journaledEvents(app, "pr/withdrawn")).toHaveLength(0)
  })

  it("carries the spent revisions in the --json envelope", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/one", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })

    const output = outputIO()
    expect(await runYrd(app, yrd("mr", "close", "PR1", "--burn-payload", "--json"), output.io), output.stderr()).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({
      command: "pr.close",
      spent: [{ pr: "PR1", revision: 1, headSha: HEAD_SHA, branch: "topic/one", reopen: "yrd pr submit topic/one" }],
    })
  })

  it("the hidden withdraw alias spends under the same acknowledgement", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/one", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })

    const refused = outputIO()
    expect(await runYrd(app, yrd("pr", "withdraw", "PR1"), refused.io)).toBe(1)
    expect(refused.stderr()).toContain("--burn-payload")
    expect(await journaledEvents(app, "pr/withdrawn")).toHaveLength(0)

    const spent = outputIO()
    expect(await runYrd(app, yrd("pr", "withdraw", "PR1", "--burn-payload"), spent.io), spent.stderr()).toBe(0)
    expect(changeDeliveryState(app.state().bays.prs.PR1!)).toBe("withdrawn")
  })

  it("admin pr prune keeps spending on its own content proof, with no acknowledgement", async () => {
    // Prune proves the content already landed before it withdraws; that proof
    // IS the acknowledgement, so the interactive gate must not block it.
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/one", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })

    const output = outputIO({ pruneGit: () => pruneGit({ isAncestor: () => true }) })
    expect(await runYrd(app, yrd("admin", "pr", "prune"), output.io), output.stderr()).toBe(0)
    expect(changeDeliveryState(app.state().bays.prs.PR1!)).toBe("withdrawn")
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
        await runYrd(
          first,
          yrd("pr", "withdraw", "PR1", "--reason", "superseded by rework", "--burn-payload"),
          withdraw.io,
        ),
        withdraw.stderr(),
      ).toBe(0)
      expect(await runYrd(first, yrd("pr", "close", "PR2", "--burn-payload"), outputIO().io)).toBe(0)
      await first.close()

      const second = await createCliApp({ journal: testJournal(dir) })
      try {
        expect(second.state().bays.prs.PR1).toMatchObject({
          state: "closed",
          merged: false,
          revs: [{ terminal: { kind: "withdrawn" } }],
          withdrawReason: "superseded by rework",
        })
        expect(second.state().bays.prs.PR2).toMatchObject({
          state: "closed",
          merged: false,
          revs: [{ terminal: { kind: "withdrawn" } }],
        })
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
  it("refuses --apply on SUBSUMED-WITHDRAW with the exact withdrawal decision", async () => {
    const app = await createCliApp()
    await app.bays.submit({
      branch: "specimen/subsumed-apply",
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

    expect(await runYrd(app, yrd("pr", "recut", "PR1", "--preflight", "--queue", "--apply", "--json"), output.io)).toBe(
      1,
    )
    expect(JSON.parse(output.stderr())).toMatchObject({
      failure: {
        cause:
          `PR 'PR1' preflight verdict SUBSUMED-WITHDRAW is an operator decision; ` +
          `run: yrd pr withdraw PR1 --burn-payload --reason "superseded: content already in ${TARGET_BASE_SHA}"`,
      },
    })
    expect((await Array.fromAsync(app.events())).length).toBe(before)
  })

  it("applies RECUT and records a re-derivable receipt", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/apply", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    const recutInputs: unknown[] = []
    const output = outputIO({
      pruneGit: () =>
        recutPreflightGit({
          mergeTree: () => OTHER_TREE,
          patchMatch: () => ({ patchId: PR476_PATCH_ID }),
        }),
    })

    expect(
      await runYrd(app, yrd("pr", "recut", "PR1", "--preflight", "--queue", "--apply", "--json"), output.io, {
        recut: {
          recut: (input) => {
            recutInputs.push(input)
            return Promise.resolve({
              headSha: HEAD2_SHA,
              baseSha: TARGET_BASE_SHA,
              treeSha: OTHER_TREE,
              patchId: PR476_PATCH_ID,
              unchanged: false,
            })
          },
        },
      }),
      output.stderr(),
    ).toBe(0)
    expect(JSON.parse(output.stdout())).toEqual({
      command: "pr.recut.apply",
      pr: "PR1",
      verdict: "RECUT",
      executed: "yrd pr recut PR1 --queue",
      result: { revision: 2, headSha: HEAD2_SHA, delivery: "submitted" },
    })
    expect(recutInputs).toEqual([expect.objectContaining({ id: "PR1", revision: 1, headSha: HEAD_SHA })])
    expect(currentChangeRev(app.state().bays.prs.PR1!)).toMatchObject({ n: 2, head: HEAD2_SHA })
    expect(app.bays.checksRequested("PR1")).toBe(true)
  })

  it("re-authorizes a certified current-base revision after the Queue consumes its submit authority", async () => {
    const app = await createCliApp({
      merge: async () => ({
        status: "completed",
        conclusion: "failure",
        error: { code: "merge-failed", message: "fixture merge worktree is unavailable" },
      }),
    })
    const runtime = { runner: "cli-test", leaseMs: 60_000 }
    await app.bays.submit({ branch: "topic/consumed-authority", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    await app.bays.requestChecks({ pr: "PR1" })
    await app.queue.run({ prs: ["PR1"] }, runtime)

    const recutService = {
      recut: {
        recut: () =>
          Promise.resolve({
            headSha: HEAD_SHA,
            baseSha: BASE_SHA,
            treeSha: OTHER_TREE,
            patchId: PR476_PATCH_ID,
            unchanged: true,
          }),
      },
    }
    const gitFacts = () =>
      recutPreflightGit({
        resolveCommit: (ref) =>
          ref === "origin/main"
            ? BASE_SHA
            : ref === "origin/topic/consumed-authority" || ref === "topic/consumed-authority"
              ? HEAD_SHA
              : ref === BASE_SHA || ref === HEAD_SHA
                ? ref
                : undefined,
        pinDistance: () => ({ sourceOnly: 0, targetOnly: 0 }),
        mergeTree: () => OTHER_TREE,
        treeOf: (sha) => (sha === BASE_SHA ? BASE_TREE : OTHER_TREE),
        patchMatch: () => ({ patchId: PR476_PATCH_ID }),
      })
    const initialRecut = outputIO({ pruneGit: gitFacts, resolveRevision: async () => HEAD_SHA })
    expect(
      await runYrd(
        app,
        yrd("pr", "recut", "PR1", "--preflight", "--queue", "--apply", "--json"),
        initialRecut.io,
        recutService,
      ),
      initialRecut.stderr(),
    ).toBe(0)
    expect(currentChangeRev(app.state().bays.prs.PR1!)).toMatchObject({ n: 2, head: HEAD_SHA })

    await app.queue.run({ prs: ["PR1"] }, runtime)
    await app.queue.run({}, runtime)
    expect(app.state().bays.prs.PR1).toMatchObject({
      needsAuthor: { receipt: { code: "queue-submit-authority-consumed" } },
    })

    const remedy = outputIO({ pruneGit: gitFacts, resolveRevision: async () => HEAD_SHA })
    expect(
      await runYrd(
        app,
        yrd("pr", "recut", "PR1", "--preflight", "--queue", "--apply", "--json"),
        remedy.io,
        recutService,
      ),
      remedy.stderr(),
    ).toBe(0)
    expect(JSON.parse(remedy.stdout())).toMatchObject({
      command: "pr.recut.apply",
      pr: "PR1",
      verdict: "RECUT-FORCE",
      result: { revision: 3, delivery: "ready" },
    })
    expect(app.state().bays.prs.PR1?.needsAuthor).toBeUndefined()

    const replay = outputIO({ pruneGit: gitFacts, resolveRevision: async () => HEAD_SHA })
    expect(
      await runYrd(
        app,
        yrd("pr", "recut", "PR1", "--preflight", "--queue", "--apply", "--json"),
        replay.io,
        recutService,
      ),
      replay.stderr(),
    ).toBe(0)
    expect(JSON.parse(replay.stdout())).toMatchObject({
      verdict: "FRESH-NOOP",
      result: { revision: 3, delivery: "ready" },
    })
    expect(app.state().bays.prs.PR1?.revs).toHaveLength(3)
  })

  it("does not turn an unchanged authored-content refusal into another identical revision", async () => {
    const app = await createCliApp({
      prepareCandidate: () => {
        throw createFailure({
          kind: "refusal",
          code: "composition-invalid",
          message: "submitted composition cannot be built",
        })
      },
    })
    await app.bays.submit({ branch: "topic/invalid-composition", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    await app.bays.requestChecks({ pr: "PR1" })
    await app.queue.run({}, { runner: "cli-test", leaseMs: 60_000 })
    expect(app.state().bays.prs.PR1).toMatchObject({
      revs: [{ admission: { status: "refused", receipt: { code: "composition-invalid" } } }],
    })

    const gitFacts = () =>
      recutPreflightGit({
        resolveCommit: (ref) =>
          ref === "origin/main"
            ? BASE_SHA
            : ref === "origin/topic/invalid-composition" || ref === "topic/invalid-composition"
              ? HEAD_SHA
              : ref === BASE_SHA || ref === HEAD_SHA
                ? ref
                : undefined,
        pinDistance: () => ({ sourceOnly: 0, targetOnly: 0 }),
        mergeTree: () => OTHER_TREE,
        treeOf: (sha) => (sha === BASE_SHA ? BASE_TREE : OTHER_TREE),
        patchMatch: () => ({ patchId: PR476_PATCH_ID }),
      })
    const remedy = outputIO({ pruneGit: gitFacts, resolveRevision: async () => HEAD_SHA })
    const code = await runYrd(
      app,
      yrd("pr", "recut", "PR1", "--preflight", "--queue", "--apply", "--json"),
      remedy.io,
      {
        recut: {
          recut: () =>
            Promise.resolve({
              headSha: HEAD_SHA,
              baseSha: BASE_SHA,
              treeSha: OTHER_TREE,
              patchId: PR476_PATCH_ID,
              unchanged: true,
            }),
        },
      },
    )
    expect(code, remedy.stderr()).toBe(1)
    expect(remedy.stderr()).toContain("composition-invalid")
    expect(remedy.stderr()).toContain("push new authored content")
    expect(app.state().bays.prs.PR1?.revs).toHaveLength(1)
  })

  it("refuses --ref with --revision before resolving or mutating anything", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/ambiguous-candidate", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    await app.bays.review({ pr: "PR1", by: "@reviewer", decision: "approve", ref: "approved-r1" })
    const beforeEvents = await Array.fromAsync(app.events())
    const beforeRevisions = structuredClone(app.state().bays.prs.PR1?.revs)
    const beforeReviews = structuredClone(app.state().bays.prs.PR1?.reviews)
    const resolvedRefs: string[] = []
    const recutInputs: unknown[] = []
    const proposedRef = "refs/heads/proposal/ambiguous"
    const output = outputIO({
      resolveRevision: async (ref) => {
        resolvedRefs.push(ref)
        return HEAD2_SHA
      },
    })

    const exit = await runYrd(
      app,
      yrd("pr", "recut", "PR1", "--ref", proposedRef, "--revision", "1", "--json"),
      output.io,
      {
        recut: {
          recut: (input) => {
            recutInputs.push(input)
            return Promise.resolve({
              headSha: HEAD2_SHA,
              baseSha: TARGET_BASE_SHA,
              treeSha: OTHER_TREE,
              patchId: PR476_PATCH_ID,
              unchanged: false,
            })
          },
        },
      },
    )

    expect.soft(exit, output.stderr()).toBe(2)
    expect.soft(output.stderr()).toContain("--ref cannot combine with --revision")
    expect.soft(resolvedRefs).toEqual([])
    expect.soft(recutInputs).toEqual([])
    expect.soft(await Array.fromAsync(app.events())).toEqual(beforeEvents)
    expect.soft(app.state().bays.prs.PR1?.revs).toEqual(beforeRevisions)
    expect.soft(app.state().bays.prs.PR1?.reviews).toEqual(beforeReviews)
  })

  it.each([
    {
      review: "absent",
      expectedCode: "review-required",
      expectedMessage: "PR 'PR1' needs approval for revision 1",
    },
    {
      review: "older revision/head",
      expectedCode: "review-required",
      expectedMessage: "PR 'PR1' needs approval for revision 2",
    },
    {
      review: "current approve then reject",
      expectedCode: "review-rejected",
      expectedMessage: "PR 'PR1' was rejected by @reviewer for revision 1",
    },
  ] as const)(
    "refuses candidate mode before the recutter when effective exact-current approval is $review",
    async ({ review, expectedCode, expectedMessage }) => {
      const fixture = codeCarrierProposalCliRepository()
      git(fixture.repo, "switch", "-q", "issue/approved")
      git(fixture.repo, "branch", "-f", "main", fixture.approvedBaseSha)
      const app = await createCliApp({
        resolveBase: (ref) => ({ base: ref, baseSha: git(fixture.repo, "rev-parse", ref) }),
      })
      try {
        const olderApprovedSha = git(fixture.repo, "rev-parse", `${fixture.approvedSha}^`)
        await app.bays.submit({
          branch: "issue/approved",
          headSha: review === "older revision/head" ? olderApprovedSha : fixture.approvedSha,
          base: "main",
          baseSha: fixture.approvedBaseSha,
        })
        if (review !== "absent") {
          await app.bays.review({ pr: "PR1", by: "@reviewer", decision: "approve", ref: "approved-current" })
        }
        if (review === "older revision/head") {
          await app.bays.intake({
            branch: "issue/approved",
            headSha: fixture.approvedSha,
            base: "main",
            baseSha: fixture.approvedBaseSha,
          })
        }
        if (review === "current approve then reject") {
          await app.bays.review({ pr: "PR1", by: "@reviewer", decision: "reject", ref: "rejected-current" })
        }
        git(fixture.repo, "branch", "-f", "main", fixture.currentBaseSha)

        const beforeEvents = await Array.fromAsync(app.events())
        const before = app.state().bays.prs.PR1!
        const beforeRevisions = structuredClone(before.revs)
        const beforeReviews = structuredClone(before.reviews)
        const recutInputs: unknown[] = []
        const output = outputIO({ resolveRevision: async () => fixture.proposedSha })

        const exit = await runYrd(
          app,
          yrd("pr", "recut", "PR1", "--ref", fixture.proposedRef, "--queue", "--json"),
          output.io,
          {
            recut: {
              recut: (input) => {
                recutInputs.push(input)
                return Promise.resolve({
                  headSha: fixture.proposedSha,
                  baseSha: fixture.currentBaseSha,
                  treeSha: OTHER_TREE,
                  patchId: PR476_PATCH_ID,
                  unchanged: false,
                })
              },
            },
          },
        )

        expect.soft(exit, output.stderr()).toBe(1)
        expect.soft(output.stderr()).toContain(expectedCode)
        expect.soft(output.stderr()).toContain(expectedMessage)
        expect.soft(recutInputs).toEqual([])
        expect.soft(await Array.fromAsync(app.events())).toEqual(beforeEvents)
        expect.soft(app.state().bays.prs.PR1?.revs).toEqual(beforeRevisions)
        expect.soft(app.state().bays.prs.PR1?.reviews).toEqual(beforeReviews)
      } finally {
        await app.close()
        rmSync(fixture.root, { recursive: true, force: true })
      }
    },
  )

  it("certifies --ref exactly as r2 with the r1 approval carried and no generated r3", async () => {
    const fixture = codeCarrierProposalCliRepository()
    git(fixture.repo, "switch", "-q", "issue/approved")
    git(fixture.repo, "branch", "-f", "main", fixture.approvedBaseSha)
    const app = await createCliApp({
      resolveBase: (ref) => ({ base: ref, baseSha: git(fixture.repo, "rev-parse", ref) }),
    })
    try {
      await app.bays.submit({
        branch: "issue/approved",
        headSha: fixture.approvedSha,
        base: "main",
        baseSha: fixture.approvedBaseSha,
      })
      await app.bays.review({ pr: "PR1", by: "@reviewer", decision: "approve", ref: "approved-r1" })
      git(fixture.repo, "branch", "-f", "main", fixture.currentBaseSha)
      const recutInputs: unknown[] = []
      let proposalResolutions = 0
      await using process = createProcess({ cwd: fixture.repo })
      const realRecutter = createGitPRRecutter({ inject: { process }, repo: fixture.repo })
      const services = {
        process,
        recut: {
          recut: (input: Parameters<typeof realRecutter.recut>[0]) => {
            recutInputs.push(input)
            return realRecutter.recut(input)
          },
        },
      }
      const run = () => {
        const output = outputIO({
          cwd: fixture.repo,
          resolveRevision: async (ref) => {
            if (ref !== fixture.proposedRef) return undefined
            proposalResolutions += 1
            return fixture.proposedSha
          },
        })
        return {
          output,
          result: runYrd(
            app,
            yrd("pr", "recut", "PR1", "--ref", fixture.proposedRef, "--queue", "--json"),
            output.io,
            services,
          ),
        }
      }

      const first = run()
      expect(await first.result, first.output.stderr()).toBe(0)
      const afterFirstEvents = await Array.fromAsync(app.events())
      const afterFirstRevisions = structuredClone(app.state().bays.prs.PR1?.revs)
      const afterFirstReviews = structuredClone(app.state().bays.prs.PR1?.reviews)
      const repeated = run()
      expect(await repeated.result, repeated.output.stderr()).toBe(0)

      const pr = app.state().bays.prs.PR1!
      expect(await Array.fromAsync(app.events())).toEqual(afterFirstEvents)
      expect(pr.revs).toEqual(afterFirstRevisions)
      expect(pr.reviews).toEqual(afterFirstReviews)
      expect(proposalResolutions).toBe(2)
      expect(recutInputs).toEqual([
        expect.objectContaining({ revision: 1, headSha: fixture.approvedSha, proposedHeadSha: fixture.proposedSha }),
        expect.objectContaining({ revision: 1, headSha: fixture.approvedSha, proposedHeadSha: fixture.proposedSha }),
      ])
      expect(pr.revs.map((revision) => [revision.n, revision.head])).toEqual([
        [1, fixture.approvedSha],
        [2, fixture.proposedSha],
      ])
      expect(currentChangeRev(pr)).toMatchObject({
        n: 2,
        head: fixture.proposedSha,
        recut: { fromRevision: 1, reviewCarried: true },
      })
      expect(
        pr.reviews.map(({ revision, headSha, decision, carriedFrom }) => ({
          revision,
          headSha,
          decision,
          ...(carriedFrom === undefined ? {} : { carriedFrom }),
        })),
      ).toEqual([
        { revision: 1, headSha: fixture.approvedSha, decision: "approve" },
        {
          revision: 2,
          headSha: fixture.proposedSha,
          decision: "approve",
          carriedFrom: { revision: 1, headSha: fixture.approvedSha },
        },
      ])
      expect(pr.revs).toHaveLength(2)
    } finally {
      await app.close()
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("certifies tracked live drift directly as r2 instead of recording a provisional r2 and generated r3", async () => {
    const app = await createCliApp()
    const branch = "topic/tracked-proposal"
    await app.bays.submit({ branch, headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    await app.bays.editPr({ pr: "PR1", track: true })
    await app.bays.review({ pr: "PR1", by: "@reviewer", decision: "approve", ref: "approved-tracked-r1" })
    const recutInputs: unknown[] = []
    const output = outputIO({
      pruneGit: () =>
        recutPreflightGit({
          resolveCommit: (ref) =>
            ref === `origin/${branch}` || ref === branch
              ? HEAD2_SHA
              : ref === "origin/main"
                ? TARGET_BASE_SHA
                : ref === BASE_SHA || ref === HEAD_SHA || ref === HEAD2_SHA
                  ? ref
                  : undefined,
          mergeTree: () => OTHER_TREE,
        }),
    })

    expect(
      await runYrd(app, yrd("pr", "recut", "PR1", "--queue", "--json"), output.io, {
        recut: {
          recut: (input) => {
            recutInputs.push(input)
            return Promise.resolve({
              headSha: HEAD2_SHA,
              baseSha: TARGET_BASE_SHA,
              treeSha: OTHER_TREE,
              patchId: PR476_PATCH_ID,
              unchanged: false,
            })
          },
        },
      }),
      output.stderr(),
    ).toBe(0)

    const pr = app.state().bays.prs.PR1!
    expect(recutInputs).toEqual([
      expect.objectContaining({
        revision: 1,
        headSha: HEAD_SHA,
        proposedHeadSha: HEAD2_SHA,
      }),
    ])
    expect(pr.revs.map((revision) => [revision.n, revision.head])).toEqual([
      [1, HEAD_SHA],
      [2, HEAD2_SHA],
    ])
    expect(currentChangeRev(pr)).toMatchObject({
      n: 2,
      head: HEAD2_SHA,
      recut: {
        fromRevision: 1,
        reviewCarried: true,
        certificate: "frozen-code-carrier-v1",
        sources: [
          {
            repo: ".",
            fromHeadSha: HEAD_SHA,
            toHeadSha: HEAD2_SHA,
            patchId: PR476_PATCH_ID,
            rangeDiff: "=",
          },
        ],
      },
    })
    expect(pr.revs).toHaveLength(2)
  })

  it("certifies resident tracked drift directly without recording an intermediate authored revision", async () => {
    const app = await createCliApp()
    const branch = "topic/resident-tracked-proposal"
    await app.bays.submit({ branch, headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    await app.bays.editPr({ pr: "PR1", track: true })
    await app.bays.review({ pr: "PR1", by: "@reviewer", decision: "approve", ref: "approved-resident-r1" })
    const recutInputs: unknown[] = []
    const output = outputIO({
      pruneGit: () =>
        recutPreflightGit({
          resolveCommit: (ref) =>
            ref === `origin/${branch}` || ref === branch
              ? HEAD2_SHA
              : ref === "origin/main"
                ? TARGET_BASE_SHA
                : ref === BASE_SHA || ref === HEAD_SHA || ref === HEAD2_SHA
                  ? ref
                  : undefined,
          mergeTree: () => OTHER_TREE,
        }),
    })

    await expect(
      runInternals.refreshTrackedQueueRevisions(
        app,
        {
          recut: {
            recut: (input) => {
              recutInputs.push(input)
              return Promise.resolve({
                headSha: HEAD2_SHA,
                baseSha: TARGET_BASE_SHA,
                treeSha: OTHER_TREE,
                patchId: PR476_PATCH_ID,
                unchanged: false,
              })
            },
          },
        },
        output.io,
      ),
    ).resolves.toMatchObject([
      {
        status: "applied",
        pr: "PR1",
        fromRevision: 1,
        sourceRevision: 1,
        currentRevision: 2,
        verdict: "RECUT",
      },
    ])

    expect(recutInputs).toEqual([
      expect.objectContaining({
        revision: 1,
        headSha: HEAD_SHA,
        proposedHeadSha: HEAD2_SHA,
      }),
    ])
    const pr = app.state().bays.prs.PR1!
    expect(pr.revs.map((revision) => [revision.n, revision.head])).toEqual([
      [1, HEAD_SHA],
      [2, HEAD2_SHA],
    ])
    expect(currentChangeRev(pr)).toMatchObject({
      n: 2,
      head: HEAD2_SHA,
      recut: { fromRevision: 1, reviewCarried: true, certificate: "frozen-code-carrier-v1" },
    })
  })

  it("freezes --preflight --queue --apply --ref once and records that candidate as the sole r2", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/preflight-ref", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    await app.bays.review({ pr: "PR1", by: "@reviewer", decision: "approve", ref: "approved-preflight-r1" })
    const proposedRef = "refs/heads/human-preflight-proposal"
    const proposalResolutionInputs: string[] = []
    const downstreamProposedHeadInputs: string[] = []
    const recutInputs: unknown[] = []
    const output = outputIO({
      resolveRevision: async (ref) => {
        if (ref !== proposedRef) return undefined
        proposalResolutionInputs.push(ref)
        return proposalResolutionInputs.length === 1 ? HEAD2_SHA : HEAD3_SHA
      },
      pruneGit: () =>
        recutPreflightGit({
          resolveCommit: (ref) => {
            if (ref === proposedRef) throw new Error(`preflight leaked symbolic candidate '${ref}'`)
            if (ref === HEAD2_SHA) downstreamProposedHeadInputs.push(ref)
            return ref === "origin/main"
              ? TARGET_BASE_SHA
              : ref.includes("preflight-ref")
                ? HEAD_SHA
                : ref === BASE_SHA || ref === HEAD_SHA || ref === HEAD2_SHA
                  ? ref
                  : undefined
          },
          isAncestor: (ancestor, descendant) => {
            downstreamProposedHeadInputs.push(ancestor)
            expect(descendant).toBe(TARGET_BASE_SHA)
            return false
          },
          mergeTree: (baseSha, headSha) => {
            expect(baseSha).toBe(TARGET_BASE_SHA)
            downstreamProposedHeadInputs.push(headSha)
            return OTHER_TREE
          },
          patchMatch: (_sourceBaseSha, headSha, targetBaseSha) => {
            expect(targetBaseSha).toBe(TARGET_BASE_SHA)
            downstreamProposedHeadInputs.push(headSha)
            return { patchId: PR476_PATCH_ID }
          },
        }),
    })

    expect(
      await runYrd(
        app,
        yrd("pr", "recut", "PR1", "--preflight", "--queue", "--apply", "--ref", proposedRef, "--json"),
        output.io,
        {
          recut: {
            recut: (input) => {
              recutInputs.push(input)
              return Promise.resolve({
                headSha: HEAD2_SHA,
                baseSha: TARGET_BASE_SHA,
                treeSha: OTHER_TREE,
                patchId: PR476_PATCH_ID,
                unchanged: false,
              })
            },
          },
        },
      ),
      output.stderr(),
    ).toBe(0)

    const pr = app.state().bays.prs.PR1!
    expect(proposalResolutionInputs).toEqual([proposedRef])
    expect(downstreamProposedHeadInputs).toEqual([HEAD2_SHA, HEAD2_SHA, HEAD2_SHA, HEAD2_SHA])
    expect(recutInputs).toEqual([expect.objectContaining({ proposedHeadSha: HEAD2_SHA })])
    expect(recutInputs.map((input) => (input as { proposedHeadSha?: string }).proposedHeadSha)).toEqual([HEAD2_SHA])
    expect(pr.revs.map((revision) => [revision.n, revision.head])).toEqual([
      [1, HEAD_SHA],
      [2, HEAD2_SHA],
    ])
    expect(currentChangeRev(pr)).toMatchObject({
      n: 2,
      head: HEAD2_SHA,
      recut: { fromRevision: 1, reviewCarried: true, certificate: "frozen-code-carrier-v1" },
    })
    expect(pr.revs).toHaveLength(2)
  })

  it("retries --preflight --queue --apply --ref without adding events, revisions, or reviews", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/preflight-ref-retry", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    await app.bays.review({ pr: "PR1", by: "@reviewer", decision: "approve", ref: "approved-retry-r1" })
    const proposedRef = "refs/heads/human-preflight-retry"
    const proposalResolutionInputs: string[] = []
    const recutInputs: unknown[] = []
    const output = () =>
      outputIO({
        resolveRevision: async (ref) => {
          if (ref !== proposedRef && ref !== HEAD2_SHA) return undefined
          proposalResolutionInputs.push(ref)
          return HEAD2_SHA
        },
        pruneGit: () =>
          recutPreflightGit({
            resolveCommit: (ref) =>
              ref === "origin/main"
                ? TARGET_BASE_SHA
                : ref.includes("preflight-ref-retry")
                  ? HEAD_SHA
                  : ref === BASE_SHA || ref === HEAD_SHA || ref === HEAD2_SHA
                    ? ref
                    : undefined,
            isAncestor: () => false,
            mergeTree: () => OTHER_TREE,
            patchMatch: () => ({ patchId: PR476_PATCH_ID }),
          }),
      })
    const services = {
      recut: {
        recut: (input: unknown) => {
          recutInputs.push(input)
          return Promise.resolve({
            headSha: HEAD2_SHA,
            baseSha: TARGET_BASE_SHA,
            treeSha: OTHER_TREE,
            patchId: PR476_PATCH_ID,
            unchanged: false,
          })
        },
      },
    }

    const first = output()
    expect(
      await runYrd(
        app,
        yrd("pr", "recut", "PR1", "--preflight", "--queue", "--apply", "--ref", proposedRef, "--json"),
        first.io,
        services,
      ),
      first.stderr(),
    ).toBe(0)
    const beforeRetry = {
      events: (await Array.fromAsync(app.events())).length,
      revisions: app.state().bays.prs.PR1!.revs.length,
      reviews: app.state().bays.prs.PR1!.reviews.length,
    }

    const retry = output()
    expect(
      await runYrd(
        app,
        yrd("pr", "recut", "PR1", "--preflight", "--queue", "--apply", "--ref", proposedRef, "--json"),
        retry.io,
        services,
      ),
      retry.stderr(),
    ).toBe(0)
    const retryResult = JSON.parse(retry.stdout()) as { executed: string }
    expect(retryResult).toMatchObject({
      verdict: "RECUT",
      result: { revision: 2, headSha: HEAD2_SHA, delivery: "submitted" },
    })
    expect(retryResult.executed).toBe(`yrd pr recut PR1 --ref ${HEAD2_SHA} --queue`)

    const roundtrip = output()
    const [, ...nextArgs] = retryResult.executed.split(" ")
    expect(await runYrd(app, yrd(...nextArgs), roundtrip.io, services), roundtrip.stderr()).toBe(0)

    expect(proposalResolutionInputs).toEqual([proposedRef, proposedRef, HEAD2_SHA])
    expect(recutInputs).toEqual([
      expect.objectContaining({ revision: 1, headSha: HEAD_SHA, proposedHeadSha: HEAD2_SHA }),
      expect.objectContaining({ revision: 1, headSha: HEAD_SHA, proposedHeadSha: HEAD2_SHA }),
      expect.objectContaining({ revision: 1, headSha: HEAD_SHA, proposedHeadSha: HEAD2_SHA }),
    ])
    expect({
      events: (await Array.fromAsync(app.events())).length,
      revisions: app.state().bays.prs.PR1!.revs.length,
      reviews: app.state().bays.prs.PR1!.reviews.length,
    }).toEqual(beforeRetry)
    expect(currentChangeRev(app.state().bays.prs.PR1!)).toMatchObject({
      n: 2,
      head: HEAD2_SHA,
      recut: { fromRevision: 1, reviewCarried: true, certificate: "frozen-code-carrier-v1" },
    })
  })

  it("applies a source-only divergent recut and persists its generated composition", async () => {
    const fixture = sourceOnlyDivergentRecutRepository()
    try {
      git(fixture.repo, "switch", "-q", "issue/source")
      git(fixture.repo, "branch", "-f", "main", fixture.sourceBase)
      const app = await createCliApp({
        resolveBase: (ref) => ({ base: ref, baseSha: git(fixture.repo, "rev-parse", ref) }),
      })
      await app.bays.submit({
        branch: "issue/source",
        headSha: fixture.headSha,
        base: "main",
        baseSha: fixture.sourceBase,
      })
      git(fixture.repo, "branch", "-f", "main", fixture.targetSha)
      const output = outputIO({ cwd: fixture.repo })
      await using process = createProcess({ cwd: fixture.repo })

      expect(
        await runYrd(app, yrd("pr", "recut", "PR1", "--preflight", "--queue", "--apply", "--json"), output.io, {
          process,
          recut: createGitPRRecutter({ inject: { process }, repo: fixture.repo }),
        }),
        output.stderr(),
      ).toBe(0)
      expect(JSON.parse(output.stdout())).toMatchObject({
        command: "pr.recut.apply",
        pr: "PR1",
        verdict: "RECUT",
        result: { revision: 2, headSha: fixture.targetSha, delivery: "submitted" },
      })

      const revision = currentChangeRev(app.state().bays.prs.PR1!)
      expect(revision).toMatchObject({
        n: 2,
        head: fixture.targetSha,
        composition: {
          version: 1,
          sources: [
            {
              repo: "dep",
              branch: expect.stringMatching(/^refs\/heads\/yrd\/candidates\/[0-9a-f]{40}$/u),
              baseSha: fixture.moduleC,
              tipSha: expect.stringMatching(/^[0-9a-f]{40}$/u),
              payload: ["carrier.txt"],
            },
          ],
        },
      })
      const source = revision.composition?.sources[0]
      expect(source).toBeDefined()
      expect(git(join(fixture.repo, "dep"), "rev-parse", source!.branch)).toBe(source!.tipSha)
      expect(git(fixture.module, "rev-parse", source!.branch)).toBe(source!.tipSha)
      expect(git(fixture.repo, "show", `${revision.recut!.treeSha}:upstream.txt`)).toBe("upstream")
      expect(app.bays.checksRequested("PR1")).toBe(true)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("applies only the computed RECUT-FORCE verdict", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/apply-force", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    await app.bays.requestChecks({ pr: "PR1" })
    await app.queue.admit({ prs: ["PR1"] }, { runner: "cli-test", leaseMs: 60_000 })
    expect(app.queue.eligibility("PR1").checks.status).toBe("passed")
    const output = outputIO({
      pruneGit: () =>
        recutPreflightGit({
          mergeTree: () => OTHER_TREE,
          patchMatch: () => ({ patchId: PR476_PATCH_ID }),
        }),
    })

    expect(
      await runYrd(app, yrd("pr", "recut", "PR1", "--preflight", "--queue", "--apply", "--json"), output.io, {
        recut: {
          recut: () =>
            Promise.resolve({
              headSha: HEAD2_SHA,
              baseSha: TARGET_BASE_SHA,
              treeSha: OTHER_TREE,
              patchId: PR476_PATCH_ID,
              unchanged: false,
            }),
        },
      }),
      output.stderr(),
    ).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({
      verdict: "RECUT-FORCE",
      executed: "yrd pr recut PR1 --queue --force",
      result: { revision: 2, headSha: HEAD2_SHA, delivery: "submitted" },
    })
  })

  it("is idempotent: a second --apply records FRESH-NOOP without recutting", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/apply-twice", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    let recutCalls = 0
    const services = {
      recut: {
        recut: () => {
          recutCalls += 1
          return Promise.resolve({
            headSha: HEAD2_SHA,
            baseSha: TARGET_BASE_SHA,
            treeSha: OTHER_TREE,
            patchId: PR476_PATCH_ID,
            unchanged: false,
          })
        },
      },
    }
    const first = outputIO({
      pruneGit: () =>
        recutPreflightGit({
          mergeTree: () => OTHER_TREE,
          patchMatch: () => ({ patchId: PR476_PATCH_ID }),
        }),
    })
    expect(
      await runYrd(app, yrd("pr", "recut", "PR1", "--preflight", "--queue", "--apply", "--json"), first.io, services),
      first.stderr(),
    ).toBe(0)

    const repeated = outputIO({
      pruneGit: () =>
        recutPreflightGit({
          pinDistance: () => ({ sourceOnly: 0, targetOnly: 0 }),
          mergeTree: () => OTHER_TREE,
          patchMatch: () => ({ patchId: PR476_PATCH_ID }),
        }),
    })
    expect(
      await runYrd(
        app,
        yrd("pr", "recut", "PR1", "--preflight", "--queue", "--apply", "--json"),
        repeated.io,
        services,
      ),
      repeated.stderr(),
    ).toBe(0)
    expect(JSON.parse(repeated.stdout())).toMatchObject({
      verdict: "FRESH-NOOP",
      executed: "yrd pr ready PR1",
      result: { revision: 2, headSha: HEAD2_SHA, delivery: "submitted" },
    })
    expect(recutCalls).toBe(1)
  })

  it.each([
    { flags: ["--apply", "--queue"], reason: "--apply requires --preflight and --queue" },
    { flags: ["--apply", "--preflight"], reason: "--apply requires --preflight and --queue" },
    {
      flags: ["--apply", "--preflight", "--queue", "--revision", "1"],
      reason: "--apply computes the current revision; it cannot combine with --revision",
    },
    {
      flags: ["--apply", "--preflight", "--queue", "--force"],
      reason: "--apply computes whether force is safe; it cannot combine with --force",
    },
  ])("refuses unsafe --apply combination $flags", async ({ flags, reason }) => {
    const app = await createCliApp()
    const output = outputIO()

    expect(await runYrd(app, yrd("pr", "recut", "PR1", ...flags), output.io)).toBe(2)
    expect(output.stderr()).toContain(reason)
  })

  it("refuses PR1640's recorded revision after its reviewed branch moves unless replay is explicit", async () => {
    const app = await createCliApp()
    await app.bays.submit({
      branch: PR1640_BRANCH,
      headSha: PR1640_RECORDED_HEAD,
      base: "main",
      baseSha: BASE_SHA,
    })
    const before = (await Array.fromAsync(app.events())).length
    const facts = recutPreflightGit({
      resolveCommit: (ref) =>
        ref === "origin/main"
          ? TARGET_BASE_SHA
          : ref === `origin/${PR1640_BRANCH}` || ref === PR1640_BRANCH
            ? PR1640_LIVE_HEAD
            : ref === BASE_SHA || ref === PR1640_RECORDED_HEAD
              ? ref
              : undefined,
      treeOf: (sha) => {
        if (sha === TARGET_BASE_SHA) return BASE_TREE
        if (sha === PR1640_RECORDED_HEAD || sha === PR1640_LIVE_HEAD) return OTHER_TREE
        throw new Error(`unexpected tree lookup for ${sha}`)
      },
      mergeTree: () => OTHER_TREE,
      patchMatch: () => ({ patchId: PR476_PATCH_ID }),
    })
    const refused = outputIO({ pruneGit: () => facts })

    expect(await runYrd(app, yrd("pr", "recut", "PR1", "--preflight", "--queue", "--json"), refused.io)).toBe(1)
    expect(refused.stderr()).toContain(`recorded revision 1 head '${PR1640_RECORDED_HEAD}'`)
    expect(refused.stderr()).toContain(`live branch '${PR1640_BRANCH}' is '${PR1640_LIVE_HEAD}'`)
    expect(refused.stderr()).toContain(`git log --oneline ${PR1640_RECORDED_HEAD}..${PR1640_LIVE_HEAD}`)
    expect(refused.stderr()).toContain(`yrd pr submit ${PR1640_BRANCH}`)
    expect(refused.stderr()).toContain("yrd pr recut PR1 --revision 1 --preflight --queue")
    expect((await Array.fromAsync(app.events())).length).toBe(before)

    const replay = outputIO({ pruneGit: () => facts })
    expect(
      await runYrd(app, yrd("pr", "recut", "PR1", "--revision", "1", "--preflight", "--queue", "--json"), replay.io),
      replay.stderr(),
    ).toBe(0)
    expect(JSON.parse(replay.stdout())).toMatchObject({ pr: "PR1", revision: 1, verdict: "RECUT" })
  })

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
    expect(currentChangeRev(app.state().bays.prs.PR1!)).toMatchObject({ n: 1, head: HEAD_SHA })
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
            ref === "origin/main" || ref === BASE_SHA
              ? BASE_SHA
              : ref === "origin/topic/fresh" || ref === "topic/fresh" || ref === HEAD_SHA
                ? HEAD_SHA
                : ref === HEAD2_SHA
                  ? HEAD2_SHA
                  : undefined,
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
          resolveCommit: (ref) =>
            ref === "origin/main"
              ? TARGET_BASE_SHA
              : ref === "origin/topic/revisions" || ref === "topic/revisions"
                ? HEAD2_SHA
                : ref === BASE_SHA || ref === HEAD_SHA || ref === HEAD2_SHA
                  ? ref
                  : undefined,
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

  it("derives patch evidence for carrier diffs above the runtime default buffer", () => {
    const dir = mkdtempSync(join(tmpdir(), "yrd-recut-preflight-large-"))
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

      writeFileSync(join(dir, "large.txt"), `${"x".repeat(1_500_000)}\n`)
      git("add", "large.txt")
      git("commit", "-m", "large carrier")
      const headSha = git("rev-parse", "HEAD")

      const facts = createPruneGitFacts(dir)
      expect(facts.patchMatch?.(sourceBaseSha, headSha, headSha)).toMatchObject({
        patchId: expect.stringMatching(/^[0-9a-f]{40}$/u),
        targetSha: headSha,
      })
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
      expect(await runYrd(app, yrd("admin", "pr", "prune", "--dry-run", "--json"), output.io), output.stderr()).toBe(0)
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
      expect(await runYrd(app, yrd("admin", "pr", "prune", "--dry-run", "--json"), output.io), output.stderr()).toBe(0)
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
    expect(await runYrd(app, yrd("admin", "pr", "prune", "--dry-run", "--json"), output.io), output.stderr()).toBe(0)
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
    expect(await runYrd(app, yrd("admin", "pr", "prune", "--dry-run"), human.io), human.stderr()).toBe(0)
    const humanText = human.stdout().replace(/\s+/g, " ")
    expect(humanText).toContain("[error] PR2 topic/broken r1")
    expect(humanText).toContain("PR 'PR2' could not be judged: simulated merge-base transport failure")
    expect(humanText).toContain("checked 3 live PRs — 1 would be withdrawn, 1 kept, 1 error")
  })

  it("keeps the exact revision owned by an active merge run", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/landing", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    await app.dispatch(app.commands.queue.run, { prs: ["PR1"], steps: ["merge"] })
    expect(app.queue.get("R1")).toMatchObject({
      status: "queued",
      steps: [{ kind: "merge", job: { status: "queued" } }],
    })
    const mergeJob = app.queue.get("R1")?.steps[0]?.job
    if (mergeJob === undefined) throw new Error("expected queued merge Job")

    const checkedAncestry: string[] = []
    const output = outputIO({
      pruneGit: () =>
        pruneGit({
          isAncestor: (ancestor, descendant) => {
            checkedAncestry.push(`${ancestor}..${descendant}`)
            return true
          },
        }),
    })
    expect(await runYrd(app, yrd("admin", "pr", "prune", "--json"), output.io), output.stderr()).toBe(0)
    expect(checkedAncestry).toEqual([])
    expect(JSON.parse(output.stdout())).toMatchObject({
      checked: [
        {
          pr: "PR1",
          checks: {},
          verdict: "keep",
          reason: "merge run 'R1' owns the in-flight landing for revision 1 (1111111111111111111111111111111111111111)",
        },
      ],
      summary: { checked: 1, withdrawn: 0, kept: 1, errors: 0 },
      withdrawn: [],
    })
    expect(changeDeliveryState(app.state().bays.prs.PR1!)).toBe("submitted")
    expect(app.queue.get("R1")).toMatchObject({ status: "queued", steps: [{ job: { status: "queued" } }] })

    await app.jobs.run(mergeJob.id, { runner: "cli-test", leaseMs: 60_000 })
    expect(app.queue.get("R1")).toMatchObject({
      status: "completed",
      conclusion: "success",
      steps: [{ kind: "merge", job: { status: "completed", conclusion: "success" } }],
    })
    expect(changeDeliveryState(app.state().bays.prs.PR1!)).toBe("submitted")

    const completedOutput = outputIO({
      pruneGit: () => pruneGit({ isAncestor: () => true }),
    })
    expect(await runYrd(app, yrd("admin", "pr", "prune", "--json"), completedOutput.io), completedOutput.stderr()).toBe(
      0,
    )
    expect(JSON.parse(completedOutput.stdout())).toMatchObject({
      checked: [{ pr: "PR1", verdict: "keep" }],
      summary: { checked: 1, withdrawn: 0, kept: 1, errors: 0 },
      withdrawn: [],
    })
    expect(changeDeliveryState(app.state().bays.prs.PR1!)).toBe("submitted")

    expect(
      await app.queue.run({ prs: ["PR1"], steps: ["merge"] }, { runner: "cli-test", leaseMs: 60_000 }),
    ).toMatchObject([{ id: "R1", status: "completed", conclusion: "success" }])
    expect(changeDeliveryState(app.state().bays.prs.PR1!)).toBe("integrated")
  })

  it("rechecks merge ownership after content proof before withdrawing", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/racing", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })

    const output = outputIO({
      pruneGit: () =>
        pruneGit({
          isAncestor: async () => {
            await app.dispatch(app.commands.queue.run, { prs: ["PR1"], steps: ["merge"] })
            return true
          },
        }),
    })
    expect(await runYrd(app, yrd("admin", "pr", "prune", "--json"), output.io), output.stderr()).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({
      checked: [{ pr: "PR1", verdict: "keep" }],
      summary: { checked: 1, withdrawn: 0, kept: 1, errors: 0 },
      withdrawn: [],
    })
    expect(changeDeliveryState(app.state().bays.prs.PR1!)).toBe("submitted")
    expect(app.queue.get("R1")).toMatchObject({
      status: "queued",
      steps: [{ kind: "merge", job: { status: "queued" } }],
    })
  })

  it("keeps a newer revision that arrives after content proof", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/revised", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })

    const output = outputIO({
      pruneGit: () =>
        pruneGit({
          isAncestor: async () => {
            await app.bays.intake({
              branch: "topic/revised",
              headSha: HEAD2_SHA,
              base: "main",
              baseSha: BASE_SHA,
            })
            return true
          },
        }),
    })
    expect(await runYrd(app, yrd("admin", "pr", "prune", "--json"), output.io), output.stderr()).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({
      checked: [
        {
          pr: "PR1",
          verdict: "keep",
          reason:
            "PR changed during prune from revision 1 (1111111111111111111111111111111111111111) to revision 2 (2222222222222222222222222222222222222222)",
        },
      ],
      summary: { checked: 1, withdrawn: 0, kept: 1, errors: 0 },
      withdrawn: [],
    })
    expect(app.state().bays.prs.PR1).toMatchObject({
      state: "open",
      revs: [
        { n: 1, head: HEAD_SHA },
        { n: 2, head: HEAD2_SHA },
      ],
    })
  })

  it("does not let an active check-only run hide independently landed content", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/checked", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    await app.dispatch(app.commands.queue.run, { prs: ["PR1"], steps: ["check"] })

    const output = outputIO({
      pruneGit: () => pruneGit({ isAncestor: () => true }),
    })
    expect(await runYrd(app, yrd("admin", "pr", "prune", "--json"), output.io), output.stderr()).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({
      checked: [{ pr: "PR1", verdict: "withdraw" }],
      summary: { checked: 1, withdrawn: 1, kept: 0, errors: 0 },
      withdrawn: [{ id: "PR1", taskStatus: "dropped" }],
    })
    expect(changeDeliveryState(app.state().bays.prs.PR1!)).toBe("withdrawn")
    expect(app.queue.get("R1")).toMatchObject({
      status: "completed",
      conclusion: "failure",
      steps: [{ job: { status: "completed", conclusion: "cancelled" } }],
    })
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
    expect(await runYrd(app, yrd("admin", "pr", "prune", "--json"), output.io), output.stderr()).toBe(0)
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
      withdrawn: [{ id: "PR1", state: "closed", merged: false, taskStatus: "dropped" }],
    })
    expect(app.state().bays.prs.PR1).toMatchObject({
      state: "closed",
      merged: false,
      revs: [{ terminal: { kind: "withdrawn" } }],
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
    expect(await runYrd(app, yrd("admin", "pr", "prune", "--json"), output.io), output.stderr()).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({
      checked: [
        {
          pr: "PR1",
          checks: { headPresent: true, ancestorOfBase: false, mergeTree: "identical" },
          verdict: "withdraw",
          reason: `superseded: content already in ${BASE_SHA}`,
        },
      ],
      withdrawn: [{ id: "PR1", state: "closed", merged: false, taskStatus: "dropped" }],
    })
    expect(changeDeliveryState(app.state().bays.prs.PR1!)).toBe("withdrawn")
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
    expect(await runYrd(app, yrd("admin", "pr", "prune", "--json"), json.io), json.stderr()).toBe(0)
    expect(JSON.parse(json.stdout())).toMatchObject({
      checked: [
        { pr: "PR1", checks: { headPresent: true, ancestorOfBase: false, mergeTree: "divergent" }, verdict: "keep" },
        { pr: "PR2", checks: { headPresent: true, ancestorOfBase: false, mergeTree: "conflicts" }, verdict: "keep" },
        { pr: "PR3", checks: { headPresent: false }, verdict: "keep" },
      ],
      withdrawn: [],
    })
    expect(changeDeliveryState(app.state().bays.prs.PR1!)).toBe("submitted")
    expect(changeDeliveryState(app.state().bays.prs.PR2!)).toBe("submitted")
    expect(changeDeliveryState(app.state().bays.prs.PR3!)).toBe("submitted")

    const human = outputIO({ pruneGit: () => facts, columns: 400 })
    expect(await runYrd(app, yrd("admin", "pr", "prune"), human.io), human.stderr()).toBe(0)
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
    expect(await runYrd(app, yrd("admin", "pr", "prune", "--dry-run", "--json"), output.io), output.stderr()).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({
      command: "pr.prune",
      dryRun: true,
      checked: [{ pr: "PR1", verdict: "would-withdraw", reason: `superseded: content already in ${BASE_SHA}` }],
      withdrawn: [],
    })
    expect(changeDeliveryState(app.state().bays.prs.PR1!)).toBe("submitted")
    expect((await Array.fromAsync(app.events())).length).toBe(before)
  })
})
