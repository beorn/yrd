/**
 * @failure An author whose checkout is older than a frame already in the journal cannot submit at all, so one newer writer anywhere in the fleet stops delivery for everyone at once.
 * @level l2
 * @consumer @yrd/cli pr submit
 *
 * The sibling of `journal-schema-skew-submit.test.ts` on the OTHER version
 * axis, and the one the 2026-08-17 incident actually named: `yrd bay in` failed
 * with "journal schema v3 exceeds this reader's compiled capability v2" and
 * `pr submit` refused from every tree. That string comes from the frame's own
 * declared vocabulary, not from the SQLite `user_version` the sibling fixed —
 * which is why the sibling's fix left this failure live.
 *
 * So the subject here is not the journal: it is `pr submit` surviving a fleet
 * spread. The fixture is a real SQLite journal carrying what a newer habitant
 * leaves behind — frames stamped one vocabulary version ahead, and the floor
 * raised to match — then met by today's reader, unchanged.
 */
import { createHash } from "node:crypto"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { safeRemove } from "removely"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { createBayJobDefs, withBays, volatilePrNumberMint } from "@yrd/bay"
import {
  CauseSchema,
  Command,
  createYrd,
  createYrdDef,
  EventSchema,
  JOURNAL_READER_VERSION,
  JsonSchema,
  pipe,
  type Journal,
  type JsonValue,
} from "@yrd/core"
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

/** The frame vocabulary this reader compiles against; the fixture sits one ahead of it. */
const AHEAD = JOURNAL_READER_VERSION + 1

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => safeRemove(root, { within: tmpdir(), allowMissing: true })))
})

function ids(initial = 0): () => string {
  let value = initial
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-frame-skew-submit-"))
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
    revision: "frame-skew-workspace-v1",
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
    runner: "frame-skew-test",
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
 * A frame the newer habitant left ABOVE the checkpoint boundary.
 *
 * It has to be appended through the journal rather than through an app, because
 * an app checkpoints as it closes and a checkpointed frame is never parsed
 * again — a fixture built only from closed apps therefore meets the reader
 * nowhere, which is what the first draft of this test did.
 */
async function appendLiveFrame(dir: string, cursor: number): Promise<void> {
  const command = Command.parse({ id: "00000000-0000-7000-8000-0000000000ff", op: "test.record" })
  const result = await fixtureJournal(dir).append(
    {
      cause: CauseSchema.parse({
        id: "00000000-0000-7000-8000-0000000000fe",
        commandId: command.id,
        op: command.op,
        commandHash: Command.hash(command),
      }),
      command,
      events: [
        EventSchema.parse({
          id: "00000000-0000-7000-8000-0000000000fd",
          name: "test/recorded",
          ts: "2026-08-30T12:05:00.000Z",
          data: { text: "written by a newer habitant" },
        }),
      ],
    },
    cursor,
  )
  if (!result.appended) throw new Error(`fixture could not append its live frame at cursor ${String(cursor)}`)
}

/**
 * What a newer habitant leaves behind for this reader to meet: every frame it
 * wrote stamped with a vocabulary version this build does not have, and the
 * journal's floor raised to match.
 *
 * The floor is not decoration. It is how the journal records that its habitants
 * are newer, and a v-ahead frame cannot legitimately exist below it — the
 * append path refuses that write. A fixture with the frames but not the floor
 * would be a state no writer can produce, so it would not be the incident.
 *
 * The live count is the fixture's own positive control: without a frame above
 * the checkpoint boundary, nothing here ever reaches `parseJournalFrame`, and
 * the test would pass while proving nothing about the frame axis.
 */
function advanceJournalOneFrameVocabularyAhead(dir: string): void {
  using database = new Database(join(dir, SQLITE), { readwrite: true, strict: true })
  const stamped = { journal_events: 0, journal_history: 0 }
  for (const table of ["journal_events", "journal_history"] as const) {
    const rows = database
      .query<{ cursor: number; value_json: string }, []>(`SELECT cursor, value_json FROM ${table}`)
      .all()
    for (const row of rows) {
      const frame = { ...(JSON.parse(row.value_json) as Record<string, unknown>), compatibility: { version: AHEAD } }
      const json = JSON.stringify(frame)
      database
        .query(`UPDATE ${table} SET value_json = ?, sha256 = ? WHERE cursor = ?`)
        .run(json, createHash("sha256").update(Buffer.from(json)).digest("hex"), row.cursor)
      stamped[table] += 1
    }
  }
  if (stamped.journal_events === 0) {
    throw new Error("fixture left no live frame above the checkpoint, so no replay would parse one")
  }
  if (stamped.journal_history === 0) throw new Error("fixture stamped no checkpointed history")
  database.query("UPDATE journal_metadata SET value = ? WHERE key = 'journal_version_floor'").run(String(AHEAD))
}

describe("pr submit against a journal whose frames are newer than this reader", () => {
  it("submits a change that needs none of the newer vocabulary", async () => {
    const dir = await directory()

    // A first process writes the journal, then leaves — the newer habitant.
    const first = await createCliApp(fixtureJournal(dir))
    await first.bays.submit({ branch: "topic/before", headSha: HEAD_SHA, base: "main", baseSha: BASE_SHA })
    await first.close()

    // …and leaves one frame above the checkpoint boundary, where an older
    // reader's replay must still meet it.
    await appendLiveFrame(dir, 1)
    advanceJournalOneFrameVocabularyAhead(dir)

    // The older reader — this code, unchanged — arrives at the newer journal.
    const second = await createCliApp(fixtureJournal(dir), 0x100)
    try {
      expect(second.bays.state().prs.PR1).toMatchObject({ state: "open" })
      // The newer frame was READ, not skipped: its event reached the projection
      // and was quarantined by name, which is where a degraded read stays
      // visible instead of going quiet.
      expect(second.unknownEventNames().map(({ name }) => name)).toContain("test/recorded")

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

    // The write reached the newer journal and left its declared vocabulary
    // alone: the older writer must not quietly demote the fleet's floor.
    using database = new Database(join(dir, SQLITE), { readonly: true, strict: true })
    expect(
      database
        .query<{ value: string }, []>("SELECT value FROM journal_metadata WHERE key = 'journal_version_floor'")
        .get(),
    ).toEqual({ value: String(AHEAD) })
    const third = await createCliApp(fixtureJournal(dir), 0x200)
    try {
      expect(third.bays.state().submits["topic/after"]).toMatchObject({ sha: AFTER_SHA, base: "main" })
    } finally {
      await third.close()
    }
  })
})
