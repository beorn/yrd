/**
 * @failure A superseded revision whose submit fact is gone but whose
 * `refs/for/<base>/<branch>` row survives is invisible to every queue surface:
 * `queue list` shows nothing for it, compose can still derive it from a
 * re-projection, and only a hand Change-Id audit over `prs.git` finds the
 * class — 13 rows on 2026-09-01 (prune r1-r9, spike-delete r1-r2, a1-types r1,
 * one autotolerate row).
 * @level l2
 * @consumer @yrd/cli `queue list`
 *
 * `queue list` scans the real receiver store and prints one WARN row per
 * orphan — a refs/for row with no submit fact whose Change-Id has a newer
 * SUBMITTED revision — naming `yrd pr retire` as the cure. A refs/for-only row
 * with no newer submitted revision is not this class (it may be the only
 * pointer to unlanded work) and gets no row.
 */
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createBayJobDefs, withBays, volatilePrNumberMint } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type JsonValue } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import { createProcess, type Process } from "@yrd/process"
import { withMerge, withQueue, withStep, type IntegrationProof } from "@yrd/queue"
import { withIssues } from "@yrd/issue"
import {
  withContests,
  type AttemptRunOutput,
  type ContestEvaluatorDef,
  type CommitResolver,
  type ContestRunnerDef,
} from "@yrd/contest"
import { runYrd as runYrdRaw, type YrdCliIO } from "@yrd/cli"
import { testQueueReadModel } from "./queue-read-model-test-helper.ts"

const HEAD_SHA = "1".repeat(40)
const BASE_SHA = "a".repeat(40)
const MERGED_SHA = "b".repeat(40)

const roots: string[] = []
const processes: Process[] = []

afterEach(async () => {
  await Promise.all(processes.splice(0).map((process) => process.close()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function ids(): () => string {
  let value = 0
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace() {
  return {
    revision: "orphan-workspace-v1",
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
  const git: CommitResolver = { revision: "git-v1", resolveCommit: () => BASE_SHA }
  return { runner, evaluator, git }
}

async function createCliApp() {
  const bayJobs = createBayJobDefs(workspace())
  const check = withStep(
    "check",
    (): JobResult<JsonValue> => ({ status: "completed", conclusion: "success", output: { checked: true } }),
    { revision: "check-v1", output: JsonSchema, classification: "carrier" },
  )
  const merge = withMerge(
    async (): Promise<JobResult<IntegrationProof>> => ({
      status: "completed",
      conclusion: "success",
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
    withBays({
      prNumberMint: volatilePrNumberMint(),
      jobs: bayJobs,
      defaultBase: "main",
      resolveBase: (ref) => ({ base: ref, baseSha: BASE_SHA }),
    }),
  )
  return createYrd(contests(queue(base)), {
    inject: { journal: createMemoryJournal(), clock: () => "2026-09-01T20:15:00.000Z", id: ids() },
  })
}

function runYrd(
  app: Parameters<typeof runYrdRaw>[0],
  argv: readonly string[],
  io: YrdCliIO,
  services: Parameters<typeof runYrdRaw>[3] = {},
) {
  return runYrdRaw(app, argv, io, { queueReadModel: testQueueReadModel(app), ...services })
}

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
    columns: 200,
    now: () => Date.parse("2026-09-01T20:15:00.000Z"),
    ...overrides,
  }
  return { io, stdout: () => stdout, stderr: () => stderr }
}

function yrd(...args: string[]): string[] {
  return ["/usr/bin/bun", "/repo/bin/yrd.ts", ...args]
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim()
}

function storeGit(store: string, ...args: string[]): string {
  return execFileSync("git", ["--git-dir", store, ...args], { encoding: "utf8" }).trim()
}

function changeId(seed: string): string {
  return `I${createHash("sha1").update(seed).digest("hex")}`
}

type Fixture = Readonly<{ root: string; stateDir: string; store: string; work: string }>

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "yrd-queue-list-orphan-"))
  roots.push(root)
  const stateDir = join(root, "state")
  mkdirSync(stateDir)
  const store = join(stateDir, "prs.git")
  execFileSync("git", ["init", "-q", "--bare", store])
  const work = join(root, "work")
  execFileSync("git", ["init", "-q", "-b", "main", work])
  git(work, "config", "user.name", "Yrd Orphan Test")
  git(work, "config", "user.email", "orphan@example.invalid")
  writeFileSync(join(work, "README.md"), `${root}\n`)
  git(work, "add", "README.md")
  git(work, "commit", "-qm", "root")
  return { root, stateDir, store, work }
}

/** One revision laid out as the receiver leaves a refs/for push; `submitFact:
 * false` models a fact already retired, leaving the landing request alone. */
function revision(f: Fixture, branch: string, id: string, options: Readonly<{ submitFact?: boolean }> = {}): string {
  git(f.work, "switch", "-q", "-c", branch, "main")
  const name = branch.replace(/[^a-z0-9]+/gu, "-")
  writeFileSync(join(f.work, `${name}.txt`), `${branch}\n`)
  git(f.work, "add", `${name}.txt`)
  git(f.work, "commit", "-qm", `add ${name}\n\nChange-Id: ${id}`)
  const sha = git(f.work, "rev-parse", "HEAD")
  git(f.work, "push", "-q", f.store, `HEAD:refs/heads/${branch}`)
  storeGit(f.store, "update-ref", `refs/for/main/${branch}`, sha)
  if (options.submitFact !== false) storeGit(f.store, "update-ref", `refs/yrd/submit/${branch}`, sha)
  git(f.work, "switch", "-q", "main")
  return sha
}

function process(): Process {
  const created = createProcess()
  processes.push(created)
  return created
}

describe("queue list warns on every superseded refs/for-only row", () => {
  it("one WARN row per orphan, naming pr retire as the cure; a lone refs/for-only row is not the class", async () => {
    const f = fixture()
    const prune = changeId("prune")
    // The audit's shape: r1 and r2 lost their submit facts, r3 is submitted.
    revision(f, "task/prune-r1", prune, { submitFact: false })
    revision(f, "task/prune-r2", prune, { submitFact: false })
    revision(f, "task/prune-r3", prune)
    // Control: a refs/for-only row with NO newer submitted revision is the
    // only pointer to whatever it carries — not an orphan, no row.
    revision(f, "task/alone-r1", changeId("alone"), { submitFact: false })
    // Control: a fully submitted change warns about nothing.
    revision(f, "task/live-r1", changeId("live"))
    const app = await createCliApp()

    const json = outputIO({ stateDir: f.stateDir })
    const exit = await runYrd(app, yrd("queue", "list", "--json"), json.io, { process: process() })
    expect(exit, json.stderr()).toBe(0)
    const result = JSON.parse(json.stdout()) as { warnings?: string[] }
    expect(result.warnings, "two orphans, two WARN rows, nothing else").toEqual([
      `WARN refs/for/main/task/prune-r1 (revision 1 of ${prune}) has no submit fact and revision 3 is submitted ` +
        `on 'task/prune-r3' — a superseded revision compose can still derive from; retire it: ` +
        `yrd pr retire ${prune} --revision 1`,
      `WARN refs/for/main/task/prune-r2 (revision 2 of ${prune}) has no submit fact and revision 3 is submitted ` +
        `on 'task/prune-r3' — a superseded revision compose can still derive from; retire it: ` +
        `yrd pr retire ${prune} --revision 2`,
    ])

    // Human mode: the same rows reach stderr.
    const human = outputIO({ stateDir: f.stateDir })
    expect(await runYrd(app, yrd("queue", "list"), human.io, { process: process() }), human.stderr()).toBe(0)
    expect(human.stderr()).toContain("WARN refs/for/main/task/prune-r1")
    expect(human.stderr()).toContain("WARN refs/for/main/task/prune-r2")
    expect(human.stderr()).not.toContain("task/alone")
    expect(human.stderr()).not.toContain("task/live")
  })

  it("prints no orphan row when there is no receiver store to scan", async () => {
    const app = await createCliApp()
    const json = outputIO()
    expect(await runYrd(app, yrd("queue", "list", "--json"), json.io, { process: process() }), json.stderr()).toBe(0)
    const result = JSON.parse(json.stdout()) as { warnings?: string[] }
    expect((result.warnings ?? []).filter((line) => line.includes("refs/for/"))).toEqual([])
  })
})
