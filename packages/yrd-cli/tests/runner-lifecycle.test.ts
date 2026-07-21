/**
 * @failure Queue watch has no structured, skippable runner narration and must
 * parse raw process logs or hide step/run lifecycle entirely.
 * @level l2
 * @consumer @yrd/cli watch
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { fixtureJob, fixturePr, fixtureResult, fixtureRun, fixtureStep } from "../dev/queue-timeline-fixtures.ts"
import { queueRunnerLifecycleEvents } from "../src/run.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("structured runner lifecycle", () => {
  it("projects typed run/step highlights and links only an existing full artifact", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "yrd-runner-lifecycle-"))
    roots.push(artifactRoot)
    const output = join(artifactRoot, "R9", "0-check", "attempt-1", "output.log")
    await mkdir(join(output, ".."), { recursive: true })
    await writeFile(output, "full output remains in its artifact\n")
    const pr = fixturePr("PR9", "rejected", "2026-07-20T12:00:00.000Z")
    const run = fixtureRun("R9", [pr], "failed", "2026-07-20T12:01:00.000Z", {
      finishedAt: "2026-07-20T12:03:00.000Z",
      error: { code: "check-failed", message: "focused check failed" },
      steps: [
        fixtureStep(
          "check",
          fixtureJob("J9", "failed", {
            attempt: 1,
            startedAt: "2026-07-20T12:01:30.000Z",
            finishedAt: "2026-07-20T12:02:30.000Z",
            error: { code: "check-failed", message: "focused check failed" },
          }),
        ),
      ],
    })

    expect(await queueRunnerLifecycleEvents([fixtureResult([pr], [run])], artifactRoot)).toEqual([
      {
        id: "R9:run-started",
        run: "R9",
        base: "main",
        at: "2026-07-20T12:01:00.000Z",
        kind: "run-started",
      },
      {
        id: "R9:0:1:step-started",
        run: "R9",
        base: "main",
        at: "2026-07-20T12:01:30.000Z",
        kind: "step-started",
        step: "check",
        attempt: 1,
        artifactPath: output,
      },
      {
        id: "R9:0:1:step-failed",
        run: "R9",
        base: "main",
        at: "2026-07-20T12:02:30.000Z",
        kind: "step-failed",
        step: "check",
        attempt: 1,
        durationMs: 60_000,
        code: "check-failed",
        artifactPath: output,
      },
      {
        id: "R9:run-failed",
        run: "R9",
        base: "main",
        at: "2026-07-20T12:03:00.000Z",
        kind: "run-failed",
        durationMs: 120_000,
        code: "check-failed",
      },
    ])
  })

  it("keeps a canceled step in the structured narration", async () => {
    const pr = fixturePr("PR10", "canceled", "2026-07-20T12:00:00.000Z")
    const run = fixtureRun("R10", [pr], "canceled", "2026-07-20T12:01:00.000Z", {
      finishedAt: "2026-07-20T12:03:00.000Z",
      steps: [
        fixtureStep(
          "check",
          fixtureJob("J10", "canceled", {
            attempt: 1,
            finishedAt: "2026-07-20T12:02:30.000Z",
            canceledBy: "operator@example.test",
            cancelReason: "superseded by a newer revision",
          }),
        ),
      ],
    })

    const result = { ...fixtureResult([pr], []), finished: [run] }
    expect(await queueRunnerLifecycleEvents([result])).toContainEqual({
      id: "R10:0:1:step-canceled",
      run: "R10",
      base: "main",
      at: "2026-07-20T12:02:30.000Z",
      kind: "step-canceled",
      step: "check",
      attempt: 1,
    })
  })
})
