/**
 * @failure A superseded revision of a change lives in TWO rows of the receiver
 * store — `refs/yrd/submit/<branch>` and `refs/for/<base>/<branch>` — and no
 * user-level verb retires both: `pr close` refuses a derived revision (no
 * record to spend), the printed cure retires only the submit fact, and the
 * receiver refuses deletion of `refs/for` by push. Measured 2026-09-01: PR3186
 * was composed from a refs/for row ten minutes after its submit fact was
 * retired, and 13 more superseded refs/for-only rows were retired by hand with
 * `git --git-dir prs.git update-ref -d`.
 * @level l2
 * @consumer @yrd/cli `pr retire`
 *
 * Drives the real `runYrd` command surface over a REAL receiver store (a bare
 * `prs.git` laid out exactly as the receiver lays it out: carrier branch,
 * landing request, submit fact) — the fixture style receiver.test.ts uses —
 * so the transaction, the expected-old-value guards and the readback run
 * against git, not a fake.
 */
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createBayJobDefs, withBays, volatilePrNumberMint } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, failureFact, JsonSchema, pipe, type JsonValue } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import { createProcess, type Process } from "@yrd/process"
import { REVISION_RETIRED_CODE, withMerge, withQueue, withStep, type IntegrationProof } from "@yrd/queue"
import { withIssues } from "@yrd/issue"
import {
  withContests,
  type AttemptRunOutput,
  type ContestEvaluatorDef,
  type CommitResolver,
  type ContestRunnerDef,
} from "@yrd/contest"
import { runYrd as runYrdRaw, type YrdCliIO, type YrdCliServices } from "@yrd/cli"
import { testQueueReadModel } from "./queue-read-model-test-helper.ts"

/** The verb's own module, loaded per test so a checkout without it reds each
 * refusal test on its own assertion rather than failing the file at import. */
async function retire(
  app: Parameters<typeof runYrdRaw>[0],
  services: YrdCliServices,
  selector: string,
  options: Readonly<{ revision?: number; burnPayload?: boolean }>,
  io: YrdCliIO,
): Promise<void> {
  const { retirePr } = await import("../src/pr-retire.ts")
  return retirePr(app, services, selector, options, io)
}

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
    revision: "retire-workspace-v1",
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

/** Minimal contest adapters so the composed app matches YrdCliApp; retire never enters a contest. */
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

/** The ref's sha, or `null` when the store has no such ref — never a thrown "missing". */
function refValue(store: string, ref: string): string | null {
  try {
    return execFileSync("git", ["--git-dir", store, "rev-parse", "--verify", "-q", `${ref}^{commit}`], {
      encoding: "utf8",
    }).trim()
  } catch {
    return null
  }
}

/** A well-formed Change-Id trailer value, keyed on `seed`. */
function changeId(seed: string): string {
  return `I${createHash("sha1").update(seed).digest("hex")}`
}

type Fixture = Readonly<{ root: string; stateDir: string; store: string; work: string }>

/** A real receiver store — bare `prs.git` under a state dir — plus a work
 * repo to author revisions in. */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "yrd-pr-retire-"))
  roots.push(root)
  const stateDir = join(root, "state")
  mkdirSync(stateDir)
  const store = join(stateDir, "prs.git")
  execFileSync("git", ["init", "-q", "--bare", store])
  const work = join(root, "work")
  execFileSync("git", ["init", "-q", "-b", "main", work])
  git(work, "config", "user.name", "Yrd Retire Test")
  git(work, "config", "user.email", "retire@example.invalid")
  writeFileSync(join(work, "README.md"), `${root}\n`)
  git(work, "add", "README.md")
  git(work, "commit", "-qm", "root")
  return { root, stateDir, store, work }
}

/** Author one revision of a change on `branch` and lay it out in the store
 * exactly as a `git push bay HEAD:refs/for/main/<branch>` leaves it: the
 * carrier `refs/heads/<branch>`, the landing request `refs/for/main/<branch>`
 * and — unless `submitFact: false` models a fact already retired — the submit
 * fact `refs/yrd/submit/<branch>` at the same sha. */
function revision(
  f: Fixture,
  branch: string,
  id: string,
  options: Readonly<{ submitFact?: boolean; trailer?: boolean }> = {},
): string {
  git(f.work, "switch", "-q", "-c", branch, "main")
  const name = branch.replace(/[^a-z0-9]+/gu, "-")
  writeFileSync(join(f.work, `${name}.txt`), `${branch}\n`)
  git(f.work, "add", `${name}.txt`)
  git(f.work, "commit", "-qm", options.trailer === false ? `add ${name}` : `add ${name}\n\nChange-Id: ${id}`)
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

describe("yrd pr retire", () => {
  it("retires one revision's two rows in one act and journals the retirement", async () => {
    const f = fixture()
    const id = changeId("prune")
    const r1 = revision(f, "task/prune-r1", id)
    const r2 = revision(f, "task/prune-r2", id)
    const app = await createCliApp()
    // The receiver projected r1's submission when its push was drained.
    await app.bays.recordBranchSubmit({ branch: "task/prune-r1", sha: r1, base: "main" })
    const output = outputIO({ stateDir: f.stateDir })

    const exit = await runYrd(
      app,
      yrd("pr", "retire", "task/prune", "--revision", "1", "--by", "@cto", "--reason", "superseded by r2", "--json"),
      output.io,
      { process: process() },
    )

    expect(exit, output.stderr()).toBe(0)
    const result = JSON.parse(output.stdout()) as Record<string, unknown>
    expect(result).toMatchObject({
      command: "pr.retire",
      changeId: id,
      revision: 1,
      branch: "task/prune-r1",
      base: "main",
      by: "@cto",
      reason: "superseded by r2",
      retired: {
        forRef: "refs/for/main/task/prune-r1",
        forSha: r1,
        submitRef: "refs/yrd/submit/task/prune-r1",
        submitSha: r1,
      },
      readback: { "refs/for/main/task/prune-r1": "absent", "refs/yrd/submit/task/prune-r1": "absent" },
      burnPayload: false,
    })
    // Both rows are gone from the store — the submit fact AND the landing
    // request, which every earlier cure left standing.
    expect(refValue(f.store, "refs/for/main/task/prune-r1")).toBeNull()
    expect(refValue(f.store, "refs/yrd/submit/task/prune-r1")).toBeNull()
    // The carrier branch itself is not this verb's to delete.
    expect(refValue(f.store, "refs/heads/task/prune-r1")).toBe(r1)
    // The successor's rows are untouched.
    expect(refValue(f.store, "refs/for/main/task/prune-r2")).toBe(r2)
    expect(refValue(f.store, "refs/yrd/submit/task/prune-r2")).toBe(r2)
    // The retirement is a journal fact: it projects into the queue's retired
    // row at the revision's sha (compose's exclusion) and retires the
    // standing submit projection in the same frame.
    expect(app.state().queues.retiredSubmits["task/prune-r1"]).toMatchObject({
      branch: "task/prune-r1",
      sha: r1,
      base: "main",
      code: REVISION_RETIRED_CODE,
      pr: id,
    })
    expect(app.state().queues.retiredSubmits["task/prune-r1"]?.reason).toBe(
      `revision 1 of change '${id}' retired by @cto: superseded by r2`,
    )
    expect(app.state().bays.submits["task/prune-r1"]).toBeUndefined()
    expect(output.stderr()).toContain("retiring revision 1 of")
    expect(output.stderr()).toContain("live successor r2")
  })

  it("refuses without a live successor of the same Change-Id unless --burn-payload is given", async () => {
    const f = fixture()
    const id = changeId("solo")
    const r1 = revision(f, "task/solo-r1", id)
    // A higher revision whose submit fact is already gone is NOT a live
    // successor: nothing stands to carry the work.
    const r2 = revision(f, "task/solo-r2", id, { submitFact: false })
    const app = await createCliApp()
    const output = outputIO({ stateDir: f.stateDir })

    const failure = await retire(app, { process: process() }, "task/solo", { revision: 1 }, output.io).then(
      () => undefined,
      (error: unknown) => failureFact(error),
    )

    expect(failure).toMatchObject({ kind: "refusal", code: "retire-no-successor" })
    const message = (failure as { message?: string }).message ?? ""
    expect(message).toContain("no live successor revision of the same Change-Id stands")
    expect(message).toContain("r2 refs/for/main/task/solo-r2 (no submit fact)")
    expect(message).toContain("--burn-payload")
    // Nothing was spent: both rows stand and nothing was journaled.
    expect(refValue(f.store, "refs/for/main/task/solo-r1")).toBe(r1)
    expect(refValue(f.store, "refs/yrd/submit/task/solo-r1")).toBe(r1)
    expect(refValue(f.store, "refs/for/main/task/solo-r2")).toBe(r2)
    expect(app.state().queues.retiredSubmits["task/solo-r1"]).toBeUndefined()
    expect(output.stdout()).toBe("")

    // The acknowledged spend goes through, and says it spent.
    const acknowledged = outputIO({ stateDir: f.stateDir })
    const exit = await runYrd(
      app,
      yrd("pr", "retire", "task/solo", "--revision", "1", "--burn-payload", "--json"),
      acknowledged.io,
      { process: process() },
    )
    expect(exit, acknowledged.stderr()).toBe(0)
    expect(JSON.parse(acknowledged.stdout())).toMatchObject({ burnPayload: true, successors: [] })
    expect(refValue(f.store, "refs/for/main/task/solo-r1")).toBeNull()
    expect(refValue(f.store, "refs/yrd/submit/task/solo-r1")).toBeNull()
    expect(acknowledged.stderr()).toContain("no live successor; the payload is spent on --burn-payload")
  })

  it("the readback names the successor's rows, in JSON and for a human", async () => {
    const f = fixture()
    const id = changeId("readback")
    // The audit's own shape: the submit fact was already retired by hand and
    // only the landing request survived.
    const r1 = revision(f, "task/readback-r1", id, { submitFact: false })
    const r2 = revision(f, "task/readback-r2", id)
    const app = await createCliApp()

    const json = outputIO({ stateDir: f.stateDir })
    const exit = await runYrd(app, yrd("pr", "retire", id, "--revision", "1", "--json"), json.io, {
      process: process(),
    })
    expect(exit, json.stderr()).toBe(0)
    const result = JSON.parse(json.stdout()) as Record<string, unknown>
    expect(result).toMatchObject({
      retired: { forRef: "refs/for/main/task/readback-r1", forSha: r1, submitRef: "refs/yrd/submit/task/readback-r1" },
      successors: [
        {
          branch: "task/readback-r2",
          revision: 2,
          forRef: "refs/for/main/task/readback-r2",
          forSha: r2,
          submitRef: "refs/yrd/submit/task/readback-r2",
          submitSha: r2,
        },
      ],
    })
    expect((result.retired as Record<string, unknown>).submitSha).toBeUndefined()
    expect(refValue(f.store, "refs/for/main/task/readback-r1")).toBeNull()

    // A second change, retired without --json: the human readback names both
    // absent rows and the successor.
    const other = changeId("human")
    const h1 = revision(f, "task/human-r1", other, { submitFact: false })
    const h2 = revision(f, "task/human-r2", other)
    const human = outputIO({ stateDir: f.stateDir })
    const humanExit = await runYrd(app, yrd("pr", "retire", "task/human", "--revision", "1"), human.io, {
      process: process(),
    })
    expect(humanExit, human.stderr()).toBe(0)
    expect(human.stdout()).toContain(`retired revision 1 of ${other} on 'task/human-r1'`)
    expect(human.stdout()).toContain(`refs/for/main/task/human-r1: absent (was ${h1.slice(0, 12)})`)
    expect(human.stdout()).toContain("refs/yrd/submit/task/human-r1: absent (had no submit fact)")
    expect(human.stdout()).toContain(
      `successor r2: refs/for/main/task/human-r2 @ ${h2.slice(0, 12)}, refs/yrd/submit/task/human-r2 @ ${h2.slice(0, 12)}`,
    )
  })

  it("refuses loudly when the revision is not in the store, naming what it scanned", async () => {
    const f = fixture()
    const id = changeId("missing")
    revision(f, "task/missing-r1", id)
    const app = await createCliApp()
    const output = outputIO({ stateDir: f.stateDir })

    const failure = await retire(app, { process: process() }, "task/missing", { revision: 3 }, output.io).then(
      () => undefined,
      (error: unknown) => failureFact(error),
    )

    expect(failure).toMatchObject({ kind: "refusal", code: "retire-target-missing" })
    const message = (failure as { message?: string }).message ?? ""
    expect(message).toContain("revision 3")
    expect(message).toContain("scanned 1 landing-request row(s) under refs/for/")
    expect(message).toContain("known revisions: r1 refs/for/main/task/missing-r1")
  })

  it("refuses when no receiver store can be seen, never scanning nothing as success", async () => {
    const app = await createCliApp()
    const output = outputIO()
    const failure = await retire(app, { process: process() }, "task/x", { revision: 1 }, output.io).then(
      () => undefined,
      (error: unknown) => failureFact(error),
    )
    expect(failure).toMatchObject({ kind: "refusal", code: "retire-store-missing" })
  })
})
