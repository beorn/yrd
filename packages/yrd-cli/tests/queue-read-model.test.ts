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
import { createJournal } from "@yrd/persistence"
import { createQueueReadModel } from "../src/queue-read-model.ts"
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

describe("queue read model", () => {
  it("answers an empty repository without creating Journal authority", async () => {
    const dir = await directory()
    const model = createQueueReadModel({ dir })

    await expect(model.attempts()).resolves.toEqual([])
    await expect(stat(join(dir, "journal.sqlite"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("projects the same attempt facts as the historical Journal scan", async () => {
    const dir = await directory()
    const model = createQueueReadModel({ dir })
    const journal = createJournal({
      dir,
      views: [model.view],
    })
    const events = attemptEvents("parity")

    await expect(journal.append(journalFrame("parity", events), 0)).resolves.toEqual({
      appended: true,
      cursor: 1,
    })

    await expect(model.attempts()).resolves.toEqual(await queueLogAttempts(events))
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

    const first = await model.attempts()
    expect(await model.attempts()).toBe(first)

    await journal.views.rebuild()

    const rebuilt = await model.attempts()
    expect(rebuilt).toEqual(first)
    expect(rebuilt).not.toBe(first)
  })

  it("uses the run/sequence index for scoped attempt reads", async () => {
    const dir = await directory()
    const model = createQueueReadModel({ dir })
    const journal = createJournal({
      dir,
      views: [model.view],
    })
    await journal.append(journalFrame("query-plan", attemptEvents("query-plan")), 0)

    using database = new Database(join(dir, "journal.sqlite"), { readonly: true, strict: true })
    database.run("PRAGMA automatic_index = OFF")
    const plan = database
      .query<{ detail: string }, [string]>(
        `EXPLAIN QUERY PLAN
         SELECT * FROM queue_attempts
         WHERE run_id = ?
         ORDER BY sequence_id`,
      )
      .all("R1")
      .map(({ detail }) => detail)
      .join("\n")
    expect(plan).toContain("queue_attempts_run_sequence")
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
