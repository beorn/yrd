/**
 * @failure A failed Queue run cannot be found by PR/revision without replaying
 * the journal, or its artifact directory has no self-describing manifest.
 * @level l2
 * @consumer @yrd/cli
 */
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { CauseSchema, Command, EventSchema, createMemoryJournal, type Event } from "@yrd/core"
import { afterEach, describe, expect, it } from "vitest"
import { createRunIndexObserver, pruneRunArtifacts } from "../src/run-index.ts"

const roots: string[] = []
const HEAD_SHA = "1".repeat(40)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function uuid(label: string): string {
  const hex = createHash("sha256").update(label).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function event(label: string, name: string, data: Event["data"], ts: string): Event {
  return EventSchema.parse({ id: uuid(`event:${label}`), name, data, ts })
}

function frame(label: string, events: readonly Event[]) {
  const command = Command.parse({ id: uuid(`command:${label}`), op: `fixture.${label}` })
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

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-run-index-"))
  roots.push(root)
  return root
}

describe("run artifact index", () => {
  it("keeps full failure bytes in the artifact while indexing only a bounded excerpt", async () => {
    const stateDir = await directory()
    const artifact = join(stateDir, "artifacts", "R44", "0-check", "attempt-1", "stderr.log")
    const full = `vitest failure ${"x".repeat(1_200)}\nsecond diagnostic line\n`
    await mkdir(join(artifact, ".."), { recursive: true })
    await writeFile(artifact, full)
    const journal = createMemoryJournal()
    const observer = createRunIndexObserver({ journal, stateDir })
    observer.start()
    const started = event(
      "bounded-started",
      "queue/run/started",
      {
        run: {
          id: "R44",
          prs: [
            {
              id: "PR9",
              revision: 1,
              headSha: HEAD_SHA,
              branch: "topic/bounded",
              base: "main",
            },
          ],
          base: "main",
          steps: [],
        },
      },
      "2026-07-20T12:00:00.000Z",
    )
    const failed = event(
      "bounded-failed",
      "queue/run/failed",
      { run: "R44", error: { code: "check-failed", message: full } },
      "2026-07-20T12:01:00.000Z",
    )
    expect(await observer.journal.append(frame("bounded", [started, failed]), 0)).toMatchObject({ appended: true })
    await observer.close()

    using database = new Database(join(stateDir, "run-index.sqlite"), { readonly: true })
    const excerpt = database
      .query<{ detail_excerpt: string }, [string]>("SELECT detail_excerpt FROM run_index WHERE run_id = ?")
      .get("R44")?.detail_excerpt
    expect(excerpt).toHaveLength(500)
    expect(excerpt?.endsWith("…")).toBe(true)
    expect(await readFile(artifact, "utf8")).toBe(full)
  })

  it("deletes only explicitly retained terminal artifacts and announces each bounded deletion", async () => {
    const stateDir = await directory()
    for (const fixture of [
      { run: "R40", status: "failed", finishedAt: "2026-07-20T12:01:00.000Z" },
      { run: "R42", status: "failed", finishedAt: "2026-07-20T12:02:00.000Z" },
      { run: "R43", status: "running", finishedAt: undefined },
    ] as const) {
      const artifactDir = join(stateDir, "artifacts", fixture.run)
      await mkdir(artifactDir, { recursive: true })
      await writeFile(
        join(artifactDir, "manifest.json"),
        JSON.stringify({
          version: 1,
          run: fixture.run,
          prs: [{ id: `PR${fixture.run.slice(1)}`, revision: 1 }],
          status: fixture.status,
          artifactDir,
          startedAt: "2026-07-20T12:00:00.000Z",
          ...(fixture.finishedAt === undefined ? {} : { finishedAt: fixture.finishedAt }),
        }),
      )
    }
    const observer = createRunIndexObserver({ journal: createMemoryJournal(), stateDir })
    observer.start()
    await observer.close()

    const lines: string[] = []
    const deleted = await pruneRunArtifacts({
      stateDir,
      retentionMs: 60_000,
      maxDeletes: 1,
      now: "2026-07-20T13:00:00.000Z",
      write: (line) => lines.push(line),
    })

    const deletedDir = join(stateDir, "artifacts", "R40")
    expect(deleted).toEqual([{ run: "R40", artifactDir: deletedDir }])
    expect(lines).toEqual([`yrd: artifact GC deleted ${deletedDir} (run R40)`])
    expect(await Bun.file(join(deletedDir, "manifest.json")).exists()).toBe(false)
    expect(await Bun.file(join(stateDir, "artifacts", "R42", "manifest.json")).exists()).toBe(true)
    expect(await Bun.file(join(stateDir, "artifacts", "R43", "manifest.json")).exists()).toBe(true)
    using database = new Database(join(stateDir, "run-index.sqlite"), { readonly: true })
    expect(
      database.query<{ run_id: string }, []>("SELECT DISTINCT run_id FROM run_index ORDER BY run_id").all(),
    ).toEqual([{ run_id: "R42" }, { run_id: "R43" }])
  })

  it("indexes the issue carried by a non-terminal Queue run snapshot", async () => {
    const stateDir = await directory()
    const observer = createRunIndexObserver({ journal: createMemoryJournal(), stateDir })
    observer.start()
    const startedAt = "2026-07-20T12:00:00.000Z"
    const started = event(
      "running-with-issue",
      "queue/run/started",
      {
        run: {
          id: "R41",
          prs: [
            {
              id: "PR7",
              revision: 2,
              headSha: HEAD_SHA,
              branch: "topic/observability",
              base: "main",
              issue: "@yrd/core/21620",
            },
          ],
          base: "main",
          steps: [],
        },
      },
      startedAt,
    )

    expect(await observer.journal.append(frame("running-with-issue", [started]), 0)).toMatchObject({
      appended: true,
    })
    await observer.close()

    using database = new Database(join(stateDir, "run-index.sqlite"), { readonly: true })
    expect(
      database
        .query("SELECT issue, status, finished_at FROM run_index WHERE run_id = ? AND pr_id = ?")
        .get("R41", "PR7"),
    ).toEqual({ issue: "@yrd/core/21620", status: "running", finished_at: null })
  })

  it("projects one failed run into a PR-queryable row and self-describing manifest", async () => {
    const stateDir = await directory()
    const journal = createMemoryJournal()
    const observer = createRunIndexObserver({ journal, stateDir })
    observer.start()

    const startedAt = "2026-07-20T12:00:00.000Z"
    const finishedAt = "2026-07-20T12:01:00.000Z"
    const started = event(
      "started",
      "queue/run/started",
      {
        run: {
          id: "R42",
          prs: [
            {
              id: "PR7",
              revision: 2,
              headSha: HEAD_SHA,
              branch: "topic/observability",
              base: "main",
              issue: "@yrd/core/21620",
            },
          ],
          base: "main",
          steps: [],
        },
      },
      startedAt,
    )
    const failed = event(
      "failed",
      "queue/run/failed",
      {
        run: "R42",
        error: { code: "check-failed", message: "vitest guard failed" },
        prs: [{ pr: "PR7", revision: 2, headSha: HEAD_SHA }],
      },
      finishedAt,
    )
    const rejected = event(
      "rejected",
      "pr/rejected",
      {
        pr: "PR7",
        revision: 2,
        headSha: HEAD_SHA,
        run: "R42",
        issueRef: "@yrd/core/21620",
        step: "check",
        detail: "expected 1 to be 2",
      },
      finishedAt,
    )

    expect(await observer.journal.append(frame("start", [started]), 0)).toMatchObject({ appended: true })
    expect(await observer.journal.append(frame("finish", [failed, rejected]), 1)).toMatchObject({ appended: true })
    await observer.close()

    using database = new Database(join(stateDir, "run-index.sqlite"), { readonly: true })
    const row = database
      .query(
        `SELECT run_id, pr_id, revision, issue, status, terminal_step,
                failure_code, detail_excerpt, artifact_dir, finished_at
           FROM run_index WHERE pr_id = ? ORDER BY finished_at DESC LIMIT 1`,
      )
      .get("PR7")
    expect(row).toEqual({
      run_id: "R42",
      pr_id: "PR7",
      revision: 2,
      issue: "@yrd/core/21620",
      status: "failed",
      terminal_step: "check",
      failure_code: "check-failed",
      detail_excerpt: "expected 1 to be 2",
      artifact_dir: join(stateDir, "artifacts", "R42"),
      finished_at: finishedAt,
    })

    expect(JSON.parse(await readFile(join(stateDir, "artifacts", "R42", "manifest.json"), "utf8"))).toEqual({
      version: 1,
      run: "R42",
      prs: [{ id: "PR7", revision: 2, issue: "@yrd/core/21620" }],
      status: "failed",
      terminalStep: "check",
      failureCode: "check-failed",
      detailExcerpt: "expected 1 to be 2",
      artifactDir: join(stateDir, "artifacts", "R42"),
      startedAt,
      finishedAt,
    })
  })

  it("rebuilds the PR lookup from manifests when the derived database is absent", async () => {
    const stateDir = await directory()
    const artifactDir = join(stateDir, "artifacts", "R42")
    await mkdir(artifactDir, { recursive: true })
    await writeFile(
      join(artifactDir, "manifest.json"),
      JSON.stringify({
        version: 1,
        run: "R42",
        prs: [{ id: "PR7", revision: 2, issue: "@yrd/core/21620" }],
        status: "failed",
        terminalStep: "check",
        failureCode: "check-failed",
        detailExcerpt: "expected 1 to be 2",
        artifactDir,
        startedAt: "2026-07-20T12:00:00.000Z",
        finishedAt: "2026-07-20T12:01:00.000Z",
      }),
    )

    const observer = createRunIndexObserver({ journal: createMemoryJournal(), stateDir })
    observer.start()
    await observer.close()

    using database = new Database(join(stateDir, "run-index.sqlite"), { readonly: true })
    expect(
      database
        .query(
          `SELECT run_id, pr_id, revision, issue, status, terminal_step,
                  failure_code, detail_excerpt, artifact_dir, finished_at
             FROM run_index WHERE pr_id = ?`,
        )
        .get("PR7"),
    ).toEqual({
      run_id: "R42",
      pr_id: "PR7",
      revision: 2,
      issue: "@yrd/core/21620",
      status: "failed",
      terminal_step: "check",
      failure_code: "check-failed",
      detail_excerpt: "expected 1 to be 2",
      artifact_dir: artifactDir,
      finished_at: "2026-07-20T12:01:00.000Z",
    })
  })

  it("keeps the cursor behind a failed manifest write and replays after repair", async () => {
    const stateDir = await directory()
    const journal = createMemoryJournal()
    const bootstrap = createRunIndexObserver({ journal, stateDir })
    bootstrap.start()
    await bootstrap.close()
    const artifactDir = join(stateDir, "artifacts", "R45")
    const blocker = join(artifactDir, "manifest.json")
    await mkdir(blocker, { recursive: true })
    const observer = createRunIndexObserver({ journal, stateDir })
    observer.start()
    const started = event(
      "manifest-retry",
      "queue/run/started",
      {
        run: {
          id: "R45",
          prs: [{ id: "PR11", revision: 1, headSha: HEAD_SHA, branch: "topic/retry", base: "main" }],
          base: "main",
          steps: [],
        },
      },
      "2026-07-20T12:00:00.000Z",
    )

    expect(await observer.journal.append(frame("manifest-retry", [started]), 0)).toMatchObject({ appended: true })
    await expect(observer.close()).rejects.toThrow()
    using failedDatabase = new Database(join(stateDir, "run-index.sqlite"), { readonly: true })
    expect(
      failedDatabase.query<{ value: string }, []>("SELECT value FROM run_index_metadata WHERE key = 'cursor'").get(),
    ).toEqual({ value: "0" })

    await rm(blocker, { recursive: true })
    const repaired = createRunIndexObserver({ journal, stateDir })
    repaired.start()
    await repaired.close()
    expect(JSON.parse(await readFile(join(artifactDir, "manifest.json"), "utf8"))).toMatchObject({
      run: "R45",
      prs: [{ id: "PR11", revision: 1 }],
    })
  })

  it("retains the run failure's terminal step across a rejection that omits it", async () => {
    const stateDir = await directory()
    const observer = createRunIndexObserver({ journal: createMemoryJournal(), stateDir })
    observer.start()
    const started = event(
      "environment-started",
      "queue/run/started",
      {
        run: {
          id: "R46",
          prs: [{ id: "PR12", revision: 1, headSha: HEAD_SHA, branch: "topic/environment", base: "main" }],
          base: "main",
          steps: [],
        },
      },
      "2026-07-20T12:00:00.000Z",
    )
    const failed = event(
      "environment-failed",
      "queue/run/failed",
      {
        run: "R46",
        step: "check",
        error: { code: "queue-environment-refused", message: "runner unavailable" },
      },
      "2026-07-20T12:01:00.000Z",
    )
    const rejected = event(
      "environment-rejected",
      "pr/rejected",
      {
        run: "R46",
        pr: "PR12",
        revision: 1,
        detail: "runner unavailable before a rejection step was recorded",
      },
      "2026-07-20T12:01:00.000Z",
    )

    expect(await observer.journal.append(frame("environment", [started, failed, rejected]), 0)).toMatchObject({
      appended: true,
    })
    await observer.close()
    using database = new Database(join(stateDir, "run-index.sqlite"), { readonly: true })
    expect(database.query("SELECT terminal_step, failure_code FROM run_index WHERE run_id = ?").get("R46")).toEqual({
      terminal_step: "check",
      failure_code: "queue-environment-refused",
    })
  })
})
