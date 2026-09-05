/**
 * @failure An explicit round cannot process admitted work while paused, clears
 *          the pause, or loses its reason in the run log.
 * @level   l3
 * @consumer explicit queue run under frozen automatic admission
 */
import { afterEach, describe, expect, it } from "vitest"
import {
  boundaryRepository,
  logOfQueueRun,
  queueRunOnce,
  removeTemporaryRoots,
  submitOneCommit,
  runYrd,
} from "./fixture.ts"

afterEach(removeTemporaryRoots)

describe("an explicit round keeps its pause", () => {
  it("merges admitted work, logs the pause reason and leaves admission paused", async () => {
    const { repo } = await boundaryRepository({ exit: 0 })
    const submitted = await submitOneCommit(repo, "paused1")
    const pause = await runYrd(repo, "queue", "pause", "--reason", "rebuilding the core", "--notify", "@cto", "--json")
    expect(pause.exitCode, pause.report).toBe(0)

    const run = await queueRunOnce(repo)

    expect(run.exitCode, run.report).toBe(0)
    expect(JSON.parse(run.stdout), run.report).toMatchObject({ exitCode: 0, merged: [submitted.branch] })
    expect(JSON.parse(run.stdout), run.report).not.toHaveProperty("garage")
    const { records } = await logOfQueueRun(run)
    expect(records, run.report).toContainEqual(expect.objectContaining({ kind: "run" }))
    expect(records, run.report).toContainEqual(
      expect.objectContaining({ kind: "pause", state: "paused", reason: "rebuilding the core", by: "@cto" }),
    )
    for (const record of records) expect(record, run.report).not.toHaveProperty("garage")
    const listed = await runYrd(repo, "queue", "list", "--json")
    expect(listed.exitCode, listed.report).toBe(0)
    expect(JSON.parse(listed.stdout)).toMatchObject({
      pause: { kind: "paused", reason: "rebuilding the core", by: "@cto" },
    })
  })
})
