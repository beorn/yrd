// @failure Queue history commands rescan the immutable Journal instead of querying a bounded read model.
// @level l2
// @consumer @yrd/cli

import { createHash } from "node:crypto"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { CauseSchema, Command, EventSchema, type Event } from "@yrd/core"
import { parseJobTransitionForReplay } from "@yrd/job"
import { createJournal } from "@yrd/persistence"
import { createQueueReadModel, QUEUE_ATTEMPTS_SQL } from "../src/queue-read-model.ts"
import { queueLogAttempts } from "../src/queue-status-view.tsx"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-queue-read-model-"))
  roots.push(root)
  return root
}

function uuid(label: string): string {
  const hex = createHash("sha256").update(label).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function journalFrame(label: string, events: readonly Event[]) {
  const command = Command.parse({ id: uuid(`command:${label}`), op: "test.queue-read-model" })
  return {
    command,
    cause: CauseSchema.parse({
      id: uuid(`cause:${label}`),
      commandId: command.id,
      op: command.op,
      commandHash: Command.hash(command),
    }),
    events,
  }
}

function attemptEvents(label: string): readonly Event[] {
  const job = uuid(`job:${label}`)
  return [
    EventSchema.parse({
      id: job,
      name: "job/requested",
      ts: "2026-07-28T12:00:00.000Z",
      data: {
        definition: "queue.step.check",
        revision: "check-v1",
        input: { run: "R1", step: "check", index: 0 },
        key: "queue:R1:0",
      },
    }),
    EventSchema.parse({
      id: uuid(`start:${label}`),
      name: "job/transitioned",
      ts: "2026-07-28T12:00:01.000Z",
      data: {
        type: "start",
        id: job,
        attempt: 1,
        runner: "yrd-test",
        leaseExpiresAt: "2026-07-28T12:01:01.000Z",
      },
    }),
    EventSchema.parse({
      id: uuid(`finish:${label}`),
      name: "job/transitioned",
      ts: "2026-07-28T12:00:04.000Z",
      data: {
        type: "finish",
        id: job,
        attempt: 1,
        runner: "yrd-test",
        result: { status: "completed", conclusion: "success", output: { ok: true } },
      },
    }),
  ]
}

function legacyAttemptEvents(): readonly Event[] {
  return [
    EventSchema.parse({
      id: "019f5d11-2c5b-7191-a89e-c935529fdf65",
      name: "job/requested",
      ts: "2026-07-13T20:00:34.395Z",
      data: {
        definition: "queue.step.check",
        revision: "03848543a26fa5253440e69e6825fe5380f5301c840f9f883b8a045b1d576297",
        input: { run: "R1", step: "check", index: 0 },
        key: "queue:R1:0",
      },
    }),
    EventSchema.parse({
      id: "019f5d11-2c60-77d8-9584-c3b8b2dd56b3",
      name: "job/transitioned",
      ts: "2026-07-13T20:00:34.400Z",
      data: {
        type: "start",
        id: "019f5d11-2c5b-7191-a89e-c935529fdf65",
        attempt: 1,
        runner: "yrd-cli",
        leaseExpiresAt: "2026-07-13T20:05:34.399Z",
      },
    }),
    EventSchema.parse({
      id: "019f5d11-8af5-750f-94ac-79e0f2dbeab4",
      name: "job/transitioned",
      ts: "2026-07-13T20:00:58.613Z",
      data: {
        type: "finish",
        id: "019f5d11-2c5b-7191-a89e-c935529fdf65",
        attempt: 1,
        runner: "yrd-cli",
        result: {
          status: "failed",
          error: {
            code: "check-failed",
            message:
              "fatal: update_ref failed for ref 'refs/yrd/candidates/R1/check/attempt-1': cannot lock ref 'refs/yrd/candidates/R1/check/attempt-1': reference already exists",
          },
        },
      },
    }),
  ]
}

/** A check attempt the habitant runner never got to interpret: the runner
 * disappeared mid-run (a restart, matching the runner respawn shape) and
 * `jobs.recover()` closes it with a "lose" transition instead of a "finish".
 * @i/10-yrd/every-attempt-records-a-verdict — this completed-but-uninterpreted
 * attempt must record a coded machine failure, never a bare `lost` outcome
 * with no code to classify it by. */
function lostAttemptEvents(): readonly Event[] {
  const job = uuid("job:lost")
  return [
    EventSchema.parse({
      id: job,
      name: "job/requested",
      ts: "2026-08-30T12:00:00.000Z",
      data: {
        definition: "queue.step.check",
        revision: "check-v1",
        input: { run: "R1", step: "check", index: 0 },
        key: "queue:R1:0",
      },
    }),
    EventSchema.parse({
      id: uuid("start:lost"),
      name: "job/transitioned",
      ts: "2026-08-30T12:00:01.000Z",
      data: {
        type: "start",
        id: job,
        attempt: 1,
        runner: "yrd-test",
        leaseExpiresAt: "2026-08-30T12:01:01.000Z",
      },
    }),
    EventSchema.parse({
      id: uuid("lose:lost"),
      name: "job/transitioned",
      ts: "2026-08-30T12:00:05.000Z",
      data: {
        type: "lose",
        id: job,
        attempt: 1,
        runner: "yrd-test",
        leaseExpiresAt: "2026-08-30T12:01:01.000Z",
        reason: "runner disappeared",
      },
    }),
  ]
}

describe("queue read model", () => {
  it("answers an empty repository without creating Journal authority", async () => {
    const dir = await directory()
    const model = createQueueReadModel({ dir })

    await expect(model.snapshot()).resolves.toMatchObject({ attempts: [] })
    await expect(stat(join(dir, "journal.sqlite"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("waits for a held SQLite writer instead of failing the queue reader", async () => {
    const dir = await directory()
    const model = createQueueReadModel({ dir })
    const path = join(dir, "journal.sqlite")
    {
      using database = new Database(path, { create: true, strict: true })
      database.run(`
        CREATE TABLE journal_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT;
        CREATE TABLE journal_views (
          view_id TEXT PRIMARY KEY NOT NULL,
          version INTEGER NOT NULL,
          fingerprint TEXT NOT NULL,
          cursor INTEGER NOT NULL
        ) STRICT;
        INSERT INTO journal_metadata(key, value) VALUES
          ('head_cursor', '0'),
          ('journal_views_generation', '1');
      `)
      model.view.install(database)
      database
        .query("INSERT INTO journal_views(view_id, version, fingerprint, cursor) VALUES (?, ?, ?, 0)")
        .run(model.view.id, model.view.version, model.view.fingerprint)
    }
    const source = `
      import { Database } from "bun:sqlite"
      using database = new Database(${JSON.stringify(path)}, { readwrite: true, strict: true })
      database.run("BEGIN EXCLUSIVE")
      database.run("UPDATE journal_metadata SET value = value WHERE key = 'head_cursor'")
      console.log("locked")
      await Bun.sleep(250)
      database.run("COMMIT")
    `
    const bun = Bun.which("bun")
    if (!bun) throw new Error("bun executable not found")
    const writer = Bun.spawn([bun, "--eval", source], { stdout: "pipe", stderr: "pipe" })
    const stderr = new Response(writer.stderr).text()
    const reader = writer.stdout.getReader()
    const ready = await reader.read()
    if (!ready.value) throw new Error(`writer exited before locking: ${await stderr}`)
    expect(new TextDecoder().decode(ready.value)).toContain("locked")

    try {
      await expect(model.snapshot()).resolves.toMatchObject({ attempts: [] })
    } finally {
      const [exitCode, writerError] = await Promise.all([writer.exited, stderr])
      expect(exitCode, writerError).toBe(0)
    }
  })

  it("projects the same attempt facts as the historical Journal scan", async () => {
    const dir = await directory()
    const model = createQueueReadModel({ dir })
    const journal = createJournal({
      dir,
      views: [model.view],
      writerVersion: 4,
    })
    const [requested, started, finished] = attemptEvents("parity")
    if (requested === undefined || started === undefined || finished === undefined) {
      throw new Error("expected complete Queue attempt fixture")
    }
    const retryJob = uuid("job:parity-retry")
    const events = [
      requested,
      started,
      EventSchema.parse({
        ...finished,
        data: {
          type: "finish",
          id: requested.id,
          attempt: 1,
          runner: "yrd-test",
          result: {
            status: "completed",
            conclusion: "failure",
            error: { code: "runner-lost", message: "runner disappeared", verdictless: true },
          },
          verdictless: true,
        },
      }),
      EventSchema.parse({
        id: retryJob,
        name: "job/requested",
        ts: "2026-07-28T12:00:05.000Z",
        data: { definition: "queue.step.check", revision: "check-v1", input: { message: "cancelled" } },
      }),
      EventSchema.parse({
        id: uuid("cancel:parity-retry"),
        name: "job/transitioned",
        ts: "2026-07-28T12:00:06.000Z",
        data: { type: "cancel", id: retryJob, attempt: 0, by: "operator", reason: "retry me" },
      }),
      EventSchema.parse({
        id: uuid("retry:parity-retry"),
        name: "job/transitioned",
        ts: "2026-07-28T12:00:07.000Z",
        data: { type: "retry", id: retryJob, retryConclusion: "cancelled" },
      }),
    ]

    await expect(
      journal.append({ ...journalFrame("parity", events), compatibility: { version: 4 } }, 0),
    ).resolves.toEqual({
      appended: true,
      cursor: 1,
    })

    await expect(model.snapshot()).resolves.toMatchObject({ attempts: await queueLogAttempts(events) })
  })

  it("normalizes legacy Job finish results while rebuilding real Journal history", async () => {
    const dir = await directory()
    const model = createQueueReadModel({ dir })
    const journal = createJournal({
      dir,
      views: [model.view],
    })

    const events = legacyAttemptEvents()
    expect(parseJobTransitionForReplay(events[2]?.data)).toMatchObject({
      type: "finish",
      result: {
        status: "completed",
        conclusion: "failure",
        error: { code: "check-failed" },
      },
    })

    await expect(journal.append(journalFrame("legacy", events), 0)).resolves.toMatchObject({
      appended: true,
    })
    await expect(model.snapshot()).resolves.toMatchObject({
      attempts: [
        {
          outcome: "failed",
          result: { status: "failed", error: { code: "check-failed" } },
        },
      ],
    })
  })

  it("records a coded machine failure for a runner-lost attempt, never a bare lost outcome", async () => {
    const dir = await directory()
    const model = createQueueReadModel({ dir })
    const journal = createJournal({
      dir,
      views: [model.view],
    })
    const events = lostAttemptEvents()

    await journal.append(journalFrame("lost", events), 0)

    // The SQL-backed production read model and the pure-fold parity oracle
    // (queueLogAttempts, the explicit fallback for Journals that cannot
    // contribute views) must agree on the shape — a change touching only
    // one of the two would pass this file's other parity test while still
    // shipping a divergent, uncoded "lost" attempt through the other path.
    const parity = await queueLogAttempts(events)
    await expect(model.snapshot()).resolves.toMatchObject({ attempts: parity })

    const expected = {
      outcome: "lost",
      result: { status: "lost", reason: "runner disappeared", code: "job-lost" },
    }
    expect(parity).toMatchObject([expected])
    await expect(model.snapshot()).resolves.toMatchObject({ attempts: [expected] })
  })

  it("caches an unchanged cursor and invalidates the cache after an explicit rebuild", async () => {
    const dir = await directory()
    const model = createQueueReadModel({ dir })
    const journal = createJournal({
      dir,
      views: [model.view],
    })
    const events = attemptEvents("cache")
    await journal.append(journalFrame("cache", events), 0)

    const first = await model.snapshot()
    const unchanged = await model.snapshot()
    expect(unchanged).toMatchObject({ cursor: first.cursor, generation: first.generation })
    expect(unchanged.attempts).toBe(first.attempts)

    await journal.views.rebuild()

    const rebuilt = await model.snapshot()
    expect(rebuilt.cursor).toBe(first.cursor)
    expect(rebuilt.generation).toBeGreaterThan(first.generation)
    expect(rebuilt.attempts).toEqual(first.attempts)
    expect(rebuilt.attempts).not.toBe(first.attempts)
  })

  it("keeps the production attempt read as a rowid scan without secondary indexes", async () => {
    const dir = await directory()
    const model = createQueueReadModel({ dir })
    const journal = createJournal({
      dir,
      views: [model.view],
    })
    await journal.append(journalFrame("query-plan", attemptEvents("query-plan")), 0)

    using database = new Database(join(dir, "journal.sqlite"), { readonly: true, strict: true })
    database.run("PRAGMA automatic_index = OFF")
    const indexes = database
      .query<{ name: string }, []>("SELECT name FROM pragma_index_list('queue_attempts') ORDER BY name")
      .all()
      .map(({ name }) => name)
    const plan = database
      .query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${QUEUE_ATTEMPTS_SQL}`)
      .all()
      .map(({ detail }) => detail)
      .join("\n")
    expect(indexes).toEqual([])
    expect(plan).toContain("SCAN queue_attempts")
    expect(plan).not.toContain("USE TEMP B-TREE")
  })

  it("refuses a derived attempt row whose result no longer matches the domain shape", async () => {
    const dir = await directory()
    const model = createQueueReadModel({ dir })
    const journal = createJournal({
      dir,
      views: [model.view],
    })
    await journal.append(journalFrame("integrity", attemptEvents("integrity")), 0)

    using database = new Database(join(dir, "journal.sqlite"), { readwrite: true, strict: true })
    expect(() => database.query("UPDATE queue_attempts SET result_json = '{}'").run()).toThrow(
      "CHECK constraint failed",
    )
  })
})
