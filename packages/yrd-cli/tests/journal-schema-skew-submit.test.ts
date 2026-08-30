/**
 * @failure An author whose checkout is one schema behind the journal cannot submit at all, so an ordinary version spread across the fleet's trees stops delivery for everyone at once.
 * @level l2
 * @consumer @yrd/cli pr submit
 *
 * Measured twice. 2026-07-17: three yrd source versions live at once, delivery
 * deferred fleet-wide. 2026-08-17 at larger scale: four live versions — a pool
 * slot, an agent worktree, the submodule's own main tip, and the recorded
 * gitlink — and `pr submit` refused from EVERY tree, because every verb opens
 * the journal and the open threw on any version mismatch.
 *
 * So the subject here is not the journal: it is `pr submit` surviving one. The
 * fixture is a real SQLite journal advanced the way a future migration would
 * advance it — a new column and a stamped `user_version` — then met by today's
 * reader, unchanged.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { createBayJobDefs, withBays, volatilePrNumberMint } from "@yrd/bay"
import { createYrd, createYrdDef, JsonSchema, pipe, type Journal, type JsonValue } from "@yrd/core"
import { withContests, type CommitResolver } from "@yrd/contest"
import { withIssues } from "@yrd/issue"
import { withJobs, type JobResult } from "@yrd/job"
import { createJournal } from "@yrd/persistence"
import { withMerge, withQueue, withStep, type ChangeShape, type StepExecution } from "@yrd/queue"
import { CURRENT_JOURNAL_COMPATIBILITY, runYrd, type YrdCliIO, type YrdCliServices } from "@yrd/cli"
import type { ProcessRequest } from "@yrd/process"
import { createLogger } from "loggily"
import { afterEach, describe, expect, it } from "vitest"
import { testQueueReadModel } from "./queue-read-model-test-helper.ts"

const BASE_SHA = "a".repeat(40)
const HEAD_SHA = "1".repeat(40)
const AFTER_SHA = "2".repeat(40)
const MERGED_SHA = "b".repeat(40)
const SQLITE = "journal.sqlite"

/** The schema this reader compiles against; the fixture below sits one ahead of it. */
const COMPILED_SCHEMA = 2

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-skew-submit-"))
  roots.push(root)
  return root
}

/** The real on-disk journal every app in this suite shares — the whole point is
 * that a second process meets what the first one left behind. */
function fixtureJournal(dir: string): Journal<unknown> {
  return createJournal({
    dir,
    writerVersion: CURRENT_JOURNAL_COMPATIBILITY.version,
    inject: { log: createLogger("yrd", [{ level: "silent" }]) },
  })
}

function workspace() {
  return {
    revision: "schema-skew-workspace-v1",
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

async function createCliApp(journal: Journal<unknown>, idStart = 0) {
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
    async (_input: StepExecution<ChangeShape>): Promise<JobResult<{ commit: string; baseSha: string }>> => ({
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
      journal,
      clock: () => "2026-08-30T12:00:00.000Z",
      id: ids(idStart),
      log: createLogger("yrd", [{ level: "silent" }]),
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
    columns: 120,
    runner: "schema-skew-test",
    leaseMs: 60_000,
    now: () => Date.parse("2026-08-30T12:10:00.000Z"),
    parents: async () => ["0".repeat(40)],
    resolveRevision: async () => HEAD_SHA,
    ...overrides,
  }
  return { io, stdout: () => stdout, stderr: () => stderr }
}

function yrd(...args: string[]): string[] {
  return ["/usr/bin/bun", "/repo/bin/yrd.ts", ...args]
}

function services(app: CliApp): YrdCliServices {
  return {
    queueReadModel: testQueueReadModel(app),
    checks: {
      names: [],
      run: async () => ({ stdout: "", stderr: "", exitCode: 0, signal: null, durationMs: 0, timedOut: false }),
      install: async () => "/repo/.git/yrd/hooks/pre-submit",
    },
    process: {
      run: async (request: ProcessRequest) => {
        const target = request.argv.find((arg) => arg.startsWith("refs/remotes/origin/") && arg.endsWith("^{commit}"))
        const branch = target?.slice("refs/remotes/origin/".length, -"^{commit}".length)
        const observed = branch === undefined ? undefined : app.bays.pr(branch)
        return {
          stdout: request.argv.includes("merge-base")
            ? `${"0".repeat(39)}1\n`
            : observed === undefined
              ? ""
              : `${observed.revs[observed.revs.length - 1]?.head ?? ""}\n`,
          stderr: "",
          exitCode: 0,
          signal: null,
          durationMs: 0,
          timedOut: false,
        }
      },
      reapPath: async () => ({
        targetedPids: [],
        survivorPids: [],
        survivorHolders: [],
        survivorCoverage: { platform: "darwin" as const, mechanism: "lsof" as const, complete: true as const },
        forcedKill: false,
        signalFailures: [],
      }),
    },
  }
}

/**
 * What a future migration leaves behind for this reader to meet: one added
 * column and the stamped version. Additive is the realistic shape, and it is
 * why the older reader still finds every column it compiled against.
 */
function advanceJournalOneSchemaAhead(dir: string): void {
  using database = new Database(join(dir, SQLITE), { readwrite: true, strict: true })
  database.run("ALTER TABLE journal_snapshot ADD COLUMN future_note TEXT")
  database.query("UPDATE journal_metadata SET value = ? WHERE key = 'schema_version'").run(String(COMPILED_SCHEMA + 1))
  database.run(`PRAGMA user_version = ${COMPILED_SCHEMA + 1}`)
}

describe("pr submit against a journal newer than this reader", () => {
  it("submits a change that needs none of the newer schema's fields", async () => {
    const dir = await directory()

    // A first process writes the journal, then leaves — the newer habitant.
    const first = await createCliApp(fixtureJournal(dir))
    await first.bays.submit({ branch: "topic/before", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    await first.close()

    advanceJournalOneSchemaAhead(dir)

    // The older reader — this code, unchanged — arrives at the newer journal.
    const second = await createCliApp(fixtureJournal(dir), 0x100)
    try {
      expect(second.bays.state().prs.PR1).toMatchObject({ state: "open" })

      const output = outputIO({ resolveRevision: async () => AFTER_SHA })
      const exit = await runYrd(second, yrd("pr", "submit", "topic/after", "--json"), output.io, services(second))
      expect(exit, `${output.stdout()}\n${output.stderr()}`).toBe(0)
      // A branch with no record of its own submits as a FACT on the derived
      // lane, so the fact — not a minted number — is what proves the write.
      expect(JSON.parse(output.stdout())).toMatchObject({
        command: "pr.submit",
        derived: [{ lane: "derived", branch: "topic/after", sha: AFTER_SHA }],
      })
      expect(second.bays.state().submits["topic/after"]).toMatchObject({ sha: AFTER_SHA, base: "main" })
    } finally {
      await second.close()
    }

    // The write reached the newer journal and left its version alone.
    using database = new Database(join(dir, SQLITE), { readonly: true, strict: true })
    expect(database.query<{ user_version: number }, []>("PRAGMA user_version").get()).toEqual({
      user_version: COMPILED_SCHEMA + 1,
    })
    const third = await createCliApp(fixtureJournal(dir), 0x200)
    try {
      expect(third.bays.state().submits["topic/after"]).toMatchObject({ sha: AFTER_SHA, base: "main" })
    } finally {
      await third.close()
    }
  })
})
