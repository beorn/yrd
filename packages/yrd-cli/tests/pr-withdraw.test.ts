/**
 * @failure `pr withdraw` silently no-ops instead of refusing loud on unknown or
 * terminal selectors, drops the recorded reason from the pr/withdrawn event, or
 * `pr prune` withdraws live content / keeps superseded content / emits events
 * during --dry-run, or hides what it checked per change.
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
import { describe, expect, it, vi } from "vitest"
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
import { runYrd as runYrdRaw, type PruneGitFacts, type RemergePreflightResult, type YrdCliIO } from "@yrd/cli"
import { testQueueReadModel } from "./queue-read-model-test-helper.ts"
import {
  createGitChangeRemerger,
  withMerge,
  withQueue,
  withStep,
  type CandidatePreparer,
  type ChangeShape,
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
const PR380_MERGE_SHA = "868194792c4b2c1b07bd5a67c37ad3e21fd35ce1"
const PR473_MERGE_SHA = "b47e240a6c3091b4687de96296d39c0a610df200"
const PR476_PATCH_ID = "172a29302878f4f7fd0dcfad917ddbf434e78d04"
const PR1640_RECORDED_HEAD = "4d8615400959a1443b1664e707eecee10d6ebe95"
const PR1640_LIVE_HEAD = "b3fae22ec7a08288b586a28b123a9e11ad3bca91"
const PR1640_BRANCH = "task/@yrd/core/22366-post-merge-component-main"
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
      input: StepExecution<ChangeShape>,
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
        _input: StepExecution<ChangeShape>,
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

function sourceOnlyDivergentRemergeRepository(): {
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

type RemergePreflightGitFacts = PruneGitFacts &
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

function remergePreflightGit(overrides: Partial<RemergePreflightGitFacts> = {}): RemergePreflightGitFacts {
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
    // Linear by default: the preflight linear-root gate consults parent count,
    // and a scenario about merge tips overrides this with two parents.
    parents: () => [BASE_SHA],
    pinDistance: () => ({ sourceOnly: 0, targetOnly: 3 }),
    patchMatch: () => ({ patchId: "c".repeat(40), targetSha: MERGED_SHA }),
    ...overrides,
  }
}

describe("pr withdraw", () => {
  it("withdraws a live change, records the reason, and terminalizes its Queue work", async () => {
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
    const result = JSON.parse(output.stdout()) as RemergePreflightResult
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
      expect.objectContaining({ pr: "PR2", run: "-", outcome: "retired", taskStatus: "dropped" }),
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
    expect(unknown.stderr()).toBe("error: no change 'nope' — searched 2 change(s)\n")

    expect(await runYrd(app, yrd("pr", "withdraw", "PR2", "--burn-payload"), outputIO().io)).toBe(0)
    const terminal = outputIO()
    expect(await runYrd(app, yrd("pr", "withdraw", "PR2"), terminal.io)).toBe(1)
    expect(terminal.stderr()).toBe("error: change 'PR2' is withdrawn; a terminal change cannot be withdrawn\n")

    // A mixed batch refuses whole before the first event: PR1 stays live.
    const mixed = outputIO()
    expect(await runYrd(app, yrd("pr", "withdraw", "PR1", "PR2"), mixed.io)).toBe(1)
    expect(mixed.stderr()).toContain("change 'PR2' is withdrawn")
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

  it("root cancel stops the attempt and leaves the change open", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/one", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    await app.dispatch(app.commands.queue.run, { prs: ["PR1"], steps: ["check"] })

    const output = outputIO()
    expect(
      await runYrd(app, yrd("cancel", "PR1", "--reason", "bad attempt", "--json"), output.io),
      output.stderr(),
    ).toBe(0)
    expect(JSON.parse(output.stdout())).toMatchObject({ command: "queue.cancel" })
    // Attempt-scoped: the run is canceled, the change is NOT withdrawn.
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
 * Closing an unmerged change spends its payload identity: the commit can
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
    // Prune proves the content already merged before it withdraws; that proof
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
          expect.objectContaining({ pr: "PR1", run: "-", outcome: "retired", taskStatus: "dropped" }),
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

  it("records one change error and continues judging every later PR", async () => {
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
          error: "change 'PR2' could not be judged: simulated merge-base transport failure",
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
    expect(humanText).toContain("change 'PR2' could not be judged: simulated merge-base transport failure")
    expect(humanText).toContain("checked 3 live changes — 1 would be withdrawn, 1 kept, 1 error")
  })

  it("keeps the exact revision owned by an active merge run", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/merge", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
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
          reason: "merge run 'R1' owns the in-flight merge for revision 1 (1111111111111111111111111111111111111111)",
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

  it("does not let an active check-only run hide independently merged content", async () => {
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

  it("withdraws a change whose head is already an ancestor of the base tip", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/merged", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })

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
          branch: "topic/merged",
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

  it("withdraws a change whose merge with the base reproduces the base tree exactly", async () => {
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
    expect(human.stdout()).toContain("checked 3 live changes — 0 withdrawn, 3 kept")
  })

  it("emits nothing under --dry-run while naming what it would withdraw", async () => {
    const app = await createCliApp()
    await app.bays.submit({ branch: "topic/merged", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
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
