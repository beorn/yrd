/**
 * @failure An explicit round cannot process admitted work while paused, clears
 *          the pause, or loses its reason in the run log.
 * @level   l3
 * @consumer explicit queue run under frozen automatic admission
 */
import { readFile } from "node:fs/promises"
import { afterEach, describe, expect, it } from "vitest"
import {
  boundaryRepository,
  type QueueRunResult,
  queueRunOnce,
  removeTemporaryRoots,
  submitOneCommit,
  runYrd,
} from "./fixture.ts"

afterEach(removeTemporaryRoots)

/** The records in the log the round itself named. */
async function runRecordsOf(run: QueueRunResult): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const reported = (JSON.parse(run.stdout) as { log?: unknown }).log
  if (typeof reported !== "string" || reported === "") {
    throw new Error(`the queue run named no log\n${run.report}`)
  }
  const records = (await readFile(reported, "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>)
  const record = records.find((candidate) => candidate["kind"] === "run")
  if (record === undefined) throw new Error(`the queue run's log has no run record\n${run.report}`)
  return records
}

describe("an explicit round keeps its pause", () => {
  it("merges admitted work, logs the pause reason and leaves admission paused", async () => {
    const { repo } = await boundaryRepository({ exit: 0 })
    const submitted = await submitOneCommit(repo, "paused1")
    const pause = await runYrd(repo, "queue", "pause", "--reason", "rebuilding the core", "--notify", "@cto", "--json")
    expect(pause.exitCode, pause.report).toBe(0)

    const run = await queueRunOnce(repo)

    expect(JSON.parse(run.stdout), run.report).toMatchObject({ exitCode: 0, merged: [submitted.branch] })
    expect(await runRecordsOf(run), run.report).toContainEqual(
      expect.objectContaining({ kind: "pause", state: "paused", reason: "rebuilding the core", by: "@cto" }),
    )
    const listed = await runYrd(repo, "queue", "list", "--json")
    expect(listed.exitCode, listed.report).toBe(0)
    expect(JSON.parse(listed.stdout)).toMatchObject({
      pause: { kind: "paused", reason: "rebuilding the core", by: "@cto" },
    })
  })

  it("carries no retired garage field on the result or log", async () => {
    const { repo } = await boundaryRepository({ exit: 0 })
    await submitOneCommit(repo, "paused2")

    const run = await queueRunOnce(repo)

    expect(JSON.parse(run.stdout) as Readonly<Record<string, unknown>>, run.report).not.toHaveProperty("garage")
    for (const record of await runRecordsOf(run)) expect(record, run.report).not.toHaveProperty("garage")
  })
})
