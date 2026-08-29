/**
 * @failure A habitant keeps starting Runs after the base tip's declared plan moved under it, or unwinds for an in-place reload without recording why in its heartbeat — so the cause of the control transfer is lost and the supervisor reads a silent restart.
 * @level l2
 * @consumer @yrd/cli host
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { raiseFailure } from "@yrd/core"
import { strandedLine } from "../src/queue-status-view.tsx"
import { followQueueRuns, requestYrdRuntimeReload, habitantRunnerStatus } from "../src/run.ts"
import { createHabitantHarness } from "./support/habitant-harness.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(repo: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

async function queueRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-habitant-plan-gate-"))
  roots.push(root)
  const repo = join(root, "repo")
  await git(root, "init", "-q", "-b", "main", repo)
  await git(repo, "config", "user.name", "Yrd Test")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await writeFile(join(repo, ".yrd.yml"), 'base: main\nbatch: 1\nchecks:\n  - {check: {run: "true"}}\n')
  await git(repo, "add", ".yrd.yml")
  await git(repo, "commit", "-qm", "queue config")
  return repo
}

describe("the habitant's per-cycle declared-plan gate", () => {
  it("re-reads the declared plan before every working cycle, gate before run", async () => {
    let gateCalls = 0
    const harness = createHabitantHarness({ run: async () => [] })
    const gate = async (): Promise<void> => {
      gateCalls += 1
      // A config change merges between the first and the second cycle.
      if (gateCalls >= 2) throw new Error("declared plan moved mid-watch")
    }
    await expect(followQueueRuns(harness.app, [], { json: true, interval: 1 }, harness.io, gate)).rejects.toThrow(
      /moved mid-watch/u,
    )
    // Gate ran on cycle 1 (before the run) and again on cycle 2 (which refused
    // before any run started): per-cycle re-read, gate-before-run.
    expect(gateCalls).toBe(2)
    expect(harness.runCalls()).toBe(1)
  })

  it("records the stale-plan finding in the habitant heartbeat before unwinding for reload", async () => {
    const repo = await queueRepository()
    const headSha = await git(repo, "rev-parse", "HEAD")
    const harness = createHabitantHarness({ run: async () => [] })
    Object.assign(harness.io, {
      cwd: repo,
      repositoryRoot: repo,
      runner: "yrd-cli:reload-evidence",
      implementationSource: `git:${headSha}`,
    })
    const finding = {
      code: "installed-plan-stale",
      message: "this process installed check→merge, but main tip declares check→second→merge",
    } as const

    await expect(
      followQueueRuns(harness.app, [], { json: true, interval: 1 }, harness.io, async () => {
        requestYrdRuntimeReload(finding, 1)
      }),
    ).rejects.toMatchObject({ name: "YrdRuntimeReloadRequest", reloads: 1 })
    await expect(habitantRunnerStatus(repo)).resolves.toMatchObject({
      clean: false,
      queueProgress: { state: "stalled", observedAt: expect.any(String), findings: [finding] },
      // The plan this habitant built rides every heartbeat, so the supervisor
      // probe can compare it against the tip without a runtime of its own.
      installedPlan: {
        batchSize: 1,
        steps: [
          { name: "check", title: "check", revision: "check-v1", kind: "check", classification: "carrier" },
          { name: "merge", title: "merge", revision: "merge-v1", kind: "merge" },
        ],
      },
    })
  })

  it("records the reload-exhausted refusal in the heartbeat before the unclean exit", async () => {
    const repo = await queueRepository()
    const headSha = await git(repo, "rev-parse", "HEAD")
    const harness = createHabitantHarness({ run: async () => [] })
    Object.assign(harness.io, {
      cwd: repo,
      repositoryRoot: repo,
      runner: "yrd-cli:reload-exhausted",
      implementationSource: `git:${headSha}`,
    })
    const message =
      "yrd: this process was exec'd in place 3 times in a row (YRD_RUNTIME_RELOADS=3) and its installed plan is still not the one main tip declares"
    await expect(
      followQueueRuns(harness.app, [], { json: true, interval: 1 }, harness.io, async () => {
        raiseFailure("refusal", "installed-plan-reload-exhausted", message)
      }),
    ).rejects.toMatchObject({ failure: { code: "installed-plan-reload-exhausted" } })
    await expect(habitantRunnerStatus(repo)).resolves.toMatchObject({
      clean: false,
      queueProgress: {
        state: "stalled",
        observedAt: expect.any(String),
        findings: [{ code: "installed-plan-reload-exhausted", message }],
      },
    })
  })

  it("refuses a published plan that does not parse rather than reading it as unpublished", async () => {
    const repo = await queueRepository()
    const statusPath = join(repo, ".git", "yrd", "resident-runner", "status.json")
    await mkdir(join(statusPath, ".."), { recursive: true })
    const baseStatus = {
      pid: process.pid,
      startedAt: "2026-08-23T20:00:00.000Z",
      lastTickAt: "2026-08-23T20:01:00.000Z",
      implementationSource: `git:${"a".repeat(40)}`,
    }
    await writeFile(statusPath, `${JSON.stringify({ ...baseStatus, installedPlan: { batchSize: 1, steps: [] } })}\n`)
    await expect(habitantRunnerStatus(repo)).rejects.toMatchObject({
      failure: { code: "resident-runner-status-invalid" },
    })
    // Absent is a real answer: a habitant older than the field.
    await writeFile(statusPath, `${JSON.stringify(baseStatus)}\n`)
    await expect(habitantRunnerStatus(repo)).resolves.not.toHaveProperty("installedPlan")
  })
})

describe("habitant status round-trip", () => {
  it("round-trips old and current stranded observations through habitant status", async () => {
    const repo = await queueRepository()
    const statusPath = join(repo, ".git", "yrd", "resident-runner", "status.json")
    await mkdir(join(statusPath, ".."), { recursive: true })
    const baseStatus = {
      pid: process.pid,
      startedAt: "2026-08-13T20:00:00.000Z",
      lastTickAt: "2026-08-13T20:01:00.000Z",
      implementationSource: `git:${"a".repeat(40)}`,
    }

    await writeFile(
      statusPath,
      `${JSON.stringify({
        ...baseStatus,
        uncarried: { count: 2, scanned: 50, missingUpdateClocks: 7, observedAt: "2026-08-13T20:00:30.000Z" },
      })}\n`,
      "utf8",
    )
    const current = await habitantRunnerStatus(repo)
    // The stored record carries the raw counts; the READ re-mints its coverage,
    // so a status.json written before coverage existed still cannot reach a
    // renderer — or a JSON consumer — as a bare count
    // (@i/10-merge-queue/22925-watch-shows-every-pr).
    expect(current?.uncarried).toEqual({
      count: 2,
      scanned: 50,
      missingUpdateClocks: 7,
      observedAt: "2026-08-13T20:00:30.000Z",
      bounded: "≥2",
      floor: "a floor — 7 refs without retained update clocks, against an unknown candidate population",
    })
    expect(strandedLine(current?.uncarried, Date.parse(baseStatus.lastTickAt))).toContain(
      "7 refs without retained update clocks",
    )

    await writeFile(
      statusPath,
      `${JSON.stringify({
        ...baseStatus,
        uncarried: { count: 0, scanned: 50, observedAt: "2026-08-13T20:00:30.000Z" },
      })}\n`,
      "utf8",
    )
    const legacy = await habitantRunnerStatus(repo)
    expect(strandedLine(legacy?.uncarried, Date.parse(baseStatus.lastTickAt))).toContain("push-clock coverage unknown")

    for (const uncarried of [
      { count: 51, scanned: 50, missingUpdateClocks: 0, observedAt: "2026-08-13T20:00:30.000Z" },
      { count: 40, scanned: 50, missingUpdateClocks: 20, observedAt: "2026-08-13T20:00:30.000Z" },
    ]) {
      await writeFile(statusPath, `${JSON.stringify({ ...baseStatus, uncarried })}\n`, "utf8")
      await expect(habitantRunnerStatus(repo)).rejects.toMatchObject({
        failure: { code: "resident-runner-status-invalid" },
      })
    }
  })
})
