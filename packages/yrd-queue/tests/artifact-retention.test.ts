/**
 * @failure The queue's artifact store grows without bound: step stdout, stderr
 * and terminal records are written per run and per attempt and nothing ever
 * removes them — measured 2026-09-01 at 694 MB across 5,684 run directories
 * with zero removals in the 31 days the oldest had been there.
 * @level l2
 * @consumer @yrd/queue artifact retention
 */
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { configuredCommandStep, type ChangeShape } from "../src/index.ts"
import type { Process, ProcessResult } from "@yrd/process"
import {
  ARTIFACT_PRUNE_INTERVAL_MS,
  ARTIFACT_RETENTION_ENV,
  DEFAULT_ARTIFACT_RETENTION_MS,
  describeScratchReap,
  reapAgedArtifacts,
  resolveArtifactRetentionMs,
} from "../src/scratch-storage.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function artifactRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-artifacts-"))
  roots.push(root)
  return root
}

/** One run directory in the shape `createArtifactSink` builds. */
async function run(root: string, key: string, ageMs: number, bytes = 64): Promise<string> {
  const entry = join(root, key)
  const attempt = join(entry, "0-candidate", "attempt-1")
  await mkdir(attempt, { recursive: true })
  await writeFile(join(attempt, "stdout.log"), "x".repeat(bytes))
  const at = new Date(Date.now() - ageMs)
  for (const path of [join(attempt, "stdout.log"), attempt, join(entry, "0-candidate"), entry]) {
    await utimes(path, at, at)
  }
  return entry
}

const DAY_MS = 24 * 60 * 60 * 1000

describe("reapAgedArtifacts — the store nothing was ever removing from", () => {
  it("removes a run older than the retention floor and keeps a young one", async () => {
    const root = await artifactRoot()
    const old = await run(root, "R100", 30 * DAY_MS)
    const young = await run(root, "R101", 60_000)

    const report = await reapAgedArtifacts(root, { olderThanMs: 14 * DAY_MS })

    expect(report).toMatchObject({ entries: 2, reaped: 1, keptYoung: 1, failures: [] })
    expect(report?.bytes).toBeGreaterThanOrEqual(64)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(young)).toBe(true)
  })

  /**
   * The discriminating case, and the reason age is read from the whole tree.
   * An admission that has been running for weeks has an ancient run directory —
   * created once, never touched again — while its step logs are being appended
   * to right now. Reading the entry's own mtime, which is what every sibling
   * reaper here does, deletes the artifacts of a run that is still in flight
   * and does it to the longest runs first.
   */
  it("keeps an in-flight run whose directory is ancient but whose logs are being written", async () => {
    const root = await artifactRoot()
    const entry = join(root, "admission:PR2740:1:5254da42")
    const attempt = join(entry, "0-candidate", "attempt-1")
    await mkdir(attempt, { recursive: true })
    await writeFile(join(attempt, "stdout.log"), "still running\n")
    const ancient = new Date(Date.now() - 30 * DAY_MS)
    await utimes(entry, ancient, ancient)
    await utimes(join(entry, "0-candidate"), ancient, ancient)

    const report = await reapAgedArtifacts(root, { olderThanMs: 14 * DAY_MS })

    expect(existsSync(join(attempt, "stdout.log"))).toBe(true)
    expect(report).toMatchObject({ entries: 1, reaped: 0, keptYoung: 1 })
  })

  it("names the counts and the bytes it freed", async () => {
    const root = await artifactRoot()
    await run(root, "R200", 30 * DAY_MS, 2048)

    const report = await reapAgedArtifacts(root, { olderThanMs: 14 * DAY_MS })

    expect(report).toBeDefined()
    const line = describeScratchReap(report as NonNullable<typeof report>)
    expect(line).toContain("reaped 1 of 1 scanned")
    expect(line).toContain("KiB freed")
    expect(line).toContain("0 failed")
  })

  it("sweeps at most once an hour per root, and sweeps again once the hour has passed", async () => {
    const root = await artifactRoot()
    await run(root, "R300", 30 * DAY_MS)
    const start = Date.now()

    const first = await reapAgedArtifacts(root, { olderThanMs: 14 * DAY_MS, now: start })
    await run(root, "R301", 30 * DAY_MS)
    const withinTheHour = await reapAgedArtifacts(root, { olderThanMs: 14 * DAY_MS, now: start + 60_000 })
    const afterTheHour = await reapAgedArtifacts(root, {
      olderThanMs: 14 * DAY_MS,
      now: start + ARTIFACT_PRUNE_INTERVAL_MS + 1,
    })

    expect(first?.reaped).toBe(1)
    // Not "reaped 0" — no sweep ran at all, which is what the caller must not
    // log as a clean sweep.
    expect(withinTheHour).toBeUndefined()
    expect(afterTheHour?.reaped).toBe(1)
  })

  it("reports an absent root as an absence, not an error — nothing has written artifacts yet", async () => {
    const root = join(await artifactRoot(), "never-created")

    const report = await reapAgedArtifacts(root, { olderThanMs: 14 * DAY_MS })

    expect(report).toMatchObject({ entries: 0, reaped: 0, failures: [] })
  })
})

describe("resolveArtifactRetentionMs — the operator override", () => {
  it("defaults to fourteen days when nothing is set", () => {
    expect(resolveArtifactRetentionMs({})).toBe(DEFAULT_ARTIFACT_RETENTION_MS)
    expect(DEFAULT_ARTIFACT_RETENTION_MS).toBe(14 * DAY_MS)
  })

  it("takes a positive integer of milliseconds from the environment", () => {
    expect(resolveArtifactRetentionMs({ [ARTIFACT_RETENTION_ENV]: String(3 * DAY_MS) })).toBe(3 * DAY_MS)
  })

  it("refuses a malformed override loudly rather than falling back to the default", () => {
    expect(() => resolveArtifactRetentionMs({ [ARTIFACT_RETENTION_ENV]: "two weeks" })).toThrow(
      /YRD_ARTIFACT_RETENTION_MS/u,
    )
    expect(() => resolveArtifactRetentionMs({ [ARTIFACT_RETENTION_ENV]: "-1" })).toThrow(/positive integer/u)
  })

  it("treats zero as a refusal, so retention can never be silently disabled by a blank-ish value", () => {
    expect(() => resolveArtifactRetentionMs({ [ARTIFACT_RETENTION_ENV]: "0" })).toThrow(/positive integer/u)
  })
})

describe("the write path prunes — the binding, not just the primitive", () => {
  /** A check that succeeds having printed nothing, so the step only exercises the artifact seam. */
  const quiet = {
    run: async (): Promise<ProcessResult> => ({
      exitCode: 0,
      signal: null,
      stdout: "",
      stderr: "",
      durationMs: 1,
      timedOut: false,
    }),
  } as unknown as Process

  it("removes an aged run when the next step writes its own artifacts", async () => {
    const cwd = await artifactRoot()
    const root = join(cwd, "artifacts")
    const stale = await run(root, "R1-ancient", 30 * DAY_MS)

    const step = configuredCommandStep<ChangeShape>({
      inject: { process: quiet },
      command: ["true"],
      cwd,
      artifactRoot: root,
      purpose: "probe",
    })
    const outcome = await step(
      {
        run: "R2-current",
        step: "probe",
        index: 0,
        prs: [
          {
            id: "PR1",
            changeId: `I${"c0ffee12".repeat(5)}`,
            branch: "task/probe",
            base: "main",
            revision: 1,
            headSha: "a".repeat(40),
          },
        ],
        shape: { results: {} },
      },
      { id: "J1", attempt: 1, runner: "test", signal: new AbortController().signal },
    )

    expect(outcome).toMatchObject({ status: "completed", conclusion: "success" })
    // The step's own artifacts are here, and the run nobody has written to for
    // a month is not. A prune that never fires looks exactly like one that
    // found nothing, so this asserts the removal rather than the call.
    expect(existsSync(join(root, "R2-current"))).toBe(true)
    expect(existsSync(stale)).toBe(false)
  })

  it("does not fail the step when the retention override is malformed — it says so and runs", async () => {
    const cwd = await artifactRoot()
    const root = join(cwd, "artifacts")
    const stale = await run(root, "R1-ancient", 30 * DAY_MS)

    const step = configuredCommandStep<ChangeShape>({
      inject: { process: quiet },
      command: ["true"],
      cwd,
      artifactRoot: root,
      purpose: "probe",
      env: { [ARTIFACT_RETENTION_ENV]: "a fortnight" },
    })
    const outcome = await step(
      {
        run: "R2-current",
        step: "probe",
        index: 0,
        prs: [
          {
            id: "PR1",
            changeId: `I${"c0ffee12".repeat(5)}`,
            branch: "task/probe",
            base: "main",
            revision: 1,
            headSha: "a".repeat(40),
          },
        ],
        shape: { results: {} },
      },
      { id: "J1", attempt: 1, runner: "test", signal: new AbortController().signal },
    )

    // Housekeeping must never decide a verdict, and a refused override must
    // never be read as "keep everything forever" without saying so.
    expect(outcome).toMatchObject({ status: "completed", conclusion: "success" })
    expect(existsSync(stale)).toBe(true)
  })
})
