/**
 * @failure An orphaned merge step whose commit already reached the base times out and re-queues its member instead of settling as merged, because the default host wired no `landedMerge` reader (R3747, @i/10-yrd/24030).
 * @level l3
 * @consumer @yrd/cli host
 */
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { changeDeliveryState } from "@yrd/bay"
import { createMemoryJournal } from "@yrd/core"
import { MERGE_RECORD_REF } from "@yrd/queue"
import { createProcess } from "@yrd/process"
import { createLogger, type LogEvent } from "loggily"
import { createDefaultYrdApp } from "../src/host.ts"
import type { ResolvedYrdProjectConfig } from "../src/config.ts"
import { installDeclaredYrdEntry } from "./support/declared-yrd-entry.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const CHANGE_ID = `I${"cafe".repeat(10)}`
/** The host's runner identity is pid-less, so only its lease judges it: an hour past the lease is orphaned. */
const AN_HOUR_LATER = () => Date.now() + 3_600_000

type Fact = Readonly<{ name: string; data: Record<string, unknown> }>
type Frame = Readonly<{ events?: readonly Fact[] }>

const config: ResolvedYrdProjectConfig = {
  base: "main",
  batch: 1,
  steps: ["merge"],
  requires: [],
  definitions: { merge: { runner: "local" } },
  contest: { concurrency: 1, timeoutMs: 60_000, evaluators: [] },
}

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

async function repository(): Promise<{ repo: string; featureSha: string }> {
  const root = await mkdtemp(join(tmpdir(), "yrd-landed-merge-"))
  roots.push(root)
  const repoPath = join(root, "repo")
  await git(root, "init", "-q", "-b", "main", repoPath)
  const repo = await realpath(repoPath)
  await git(repo, "config", "user.name", "Yrd Test")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await installDeclaredYrdEntry(repo)
  await writeFile(join(repo, "README.md"), "main\n")
  await writeFile(join(repo, ".yrd.yml"), "steps: [merge]\n")
  await git(repo, "add", "README.md", ".yrd.yml", "bin/yrd")
  await git(repo, "commit", "-qm", "main")
  await git(repo, "switch", "-qc", "issue/feature")
  await writeFile(join(repo, "feature.txt"), "feature\n")
  await git(repo, "add", "feature.txt")
  await git(repo, "commit", "-qm", `feature\n\nChange-Id: ${CHANGE_ID}`)
  const featureSha = await git(repo, "rev-parse", "HEAD")
  await git(repo, "switch", "-q", "main")
  return { repo, featureSha }
}

function tracing() {
  const events: LogEvent[] = []
  const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
  const rows = (action: string) =>
    events.filter(
      (event): event is Extract<LogEvent, { kind: "log" }> => event.kind === "log" && event.props?.action === action,
    )
  return { log, rows }
}

async function frames(journal: ReturnType<typeof createMemoryJournal<unknown>>): Promise<Frame[]> {
  const collected: unknown[] = []
  for await (const page of journal.read()) collected.push(...page.values)
  return collected as Frame[]
}

const facts = (all: readonly Frame[]): Fact[] => all.flatMap((frame) => frame.events ?? [])

/**
 * The R3747 shape, produced by the default host itself over a real repository:
 * a live pass merges the change (the queue's own merge commit, stamped as the
 * queue stamps it, on the base), and the journal is then cut right after the
 * merge Job's `start` row — the process died between the landing and its
 * terminal row. A second host boots over that journal; its pass-start
 * settlement is what is under test. `landed: false` moves the base back to
 * before the merge, so the same orphan has NOT reached the base. The live
 * pass's merge-record note is dropped in both shapes: it is written after the
 * terminal row the dead process never reached.
 */
async function orphanedMergeStep(input: Readonly<{ landed: boolean }>) {
  const { repo, featureSha } = await repository()
  const stateDir = join(repo, ".git", "yrd")
  const baysRoot = join(repo, ".bays")
  const runtimeProcess = createProcess({ cwd: repo })
  const silent = createLogger("test", [{ level: "silent" }])
  const baseBefore = await git(repo, "rev-parse", "main")

  const live = createMemoryJournal()
  const first = await createDefaultYrdApp({
    repo,
    stateDir,
    baysRoot,
    journal: live,
    process: runtimeProcess,
    config,
    log: silent,
  })
  await first.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
  const [merged] = await first.queue.run({ prs: ["PR1"] }, { runner: "live", leaseMs: 60_000 })
  if (merged?.status !== "completed" || merged.conclusion !== "success" || merged.integration === undefined) {
    throw new Error(`the live pass did not integrate PR1: ${JSON.stringify(merged)}`)
  }
  const mergeJob = merged.steps[0]?.job
  if (mergeJob === undefined || merged.steps[0]?.kind !== "merge") throw new Error("expected a merge step on R1")
  await first.close()
  // The live pass wrote its immutable merge record AFTER its terminal row. The
  // process under test died BEFORE that row, so the record does not exist yet:
  // drop the note the live pass left, or the recovery would be compared to it.
  await git(repo, "update-ref", "-d", MERGE_RECORD_REF)
  const landing = merged.integration.commit
  expect(await git(repo, "rev-parse", "main"), "the live merge is the base tip").toBe(landing)
  expect(await git(repo, "log", "-1", "--format=%P", landing)).toBe(`${baseBefore} ${featureSha}`)

  const history = await frames(live)
  const cut = history.findIndex((frame) =>
    (frame.events ?? []).some(
      (event) => event.name === "job/transitioned" && event.data.id === mergeJob.id && event.data.type === "start",
    ),
  )
  if (cut < 0) throw new Error("the live journal holds no start row for the merge Job")
  const truncated = history.slice(0, cut + 1)
  expect(
    facts(truncated).map((event) => event.name),
    "cut after the merge Job's start row",
  ).not.toContain("pr/integrated")

  if (!input.landed) await git(repo, "update-ref", "refs/heads/main", baseBefore, landing)

  const { log, rows } = tracing()
  const journal = createMemoryJournal(truncated)
  const app = await createDefaultYrdApp({ repo, stateDir, baysRoot, journal, process: runtimeProcess, config, log })
  expect(app.queue.get("R1")?.status, "the specimen reads as running before the pass").toBe("in_progress")
  expect(app.state().jobs.byId[mergeJob.id]).toMatchObject({ status: "in_progress", runner: "yrd-local" })

  // The pass: selectorless, exactly what a habitant cycle or a bare `queue run` does.
  await app.queue.run({ prs: [] }, { runner: "local", leaseMs: 60_000, now: AN_HOUR_LATER })

  return {
    app,
    rows,
    facts: facts(await frames(journal)),
    landing,
    mergeJob,
    async [Symbol.asyncDispose]() {
      await app.close()
      await runtimeProcess[Symbol.asyncDispose]()
      log.end()
    },
  }
}

describe("default host: an orphaned merge step that already landed (24030, R3747)", { timeout: 60_000 }, () => {
  it("settles merged (recovered) through pr/integrated, naming the landing commit the base carries", async () => {
    await using fixture = await orphanedMergeStep({ landed: true })
    const { app, rows, facts, landing, mergeJob } = fixture

    const row = rows("orphaned-run-settled")
    expect(row, "exactly one INFO row per settlement").toHaveLength(1)
    expect(row[0]?.props).toMatchObject({
      run: "R1",
      step: "merge",
      job: mergeJob.id,
      runner: "yrd-local",
      cause: "lease-expired",
      disposition: "merged-recovered",
      landedMergeReader: "consulted",
      commit: landing,
    })
    expect(app.queue.get("R1")).toMatchObject({
      status: "completed",
      conclusion: "success",
      integration: { commit: landing, baseSha: landing },
    })
    expect(app.state().jobs.byId[mergeJob.id]).toMatchObject({
      status: "completed",
      conclusion: "success",
      attempt: 1,
      runner: "yrd-local",
      output: { commit: landing, baseSha: landing },
    })
    const integrated = facts.filter((event) => event.name === "pr/integrated")
    expect(integrated, "the SAME terminal writer a live merge uses").toHaveLength(1)
    expect(integrated[0]?.data).toMatchObject({ pr: "PR1", run: "R1", commit: landing, baseSha: landing })
    expect(facts.filter((event) => event.name === "queue/run/settled").map((event) => event.data)).toContainEqual(
      expect.objectContaining({ run: "R1", status: "passed" }),
    )
    expect(changeDeliveryState(app.state().bays.prs.PR1!)).toBe("integrated")
  })

  it("control: a merge-step orphan the base does not contain still times out and re-queues its member", async () => {
    await using fixture = await orphanedMergeStep({ landed: false })
    const { app, rows, facts, mergeJob } = fixture

    expect(app.state().jobs.byId[mergeJob.id]).toMatchObject({ status: "completed", conclusion: "timed_out" })
    expect(app.queue.get("R1"), "the orphaned run fails under the timeout disposition").toMatchObject({
      status: "completed",
      conclusion: "failure",
    })
    expect(facts.filter((event) => event.name === "pr/integrated" && event.data.run === "R1")).toHaveLength(0)
    // Re-queued, never rejected: the member is still submitted (and may already be in a fresh run).
    expect(changeDeliveryState(app.state().bays.prs.PR1!)).not.toBe("rejected")

    const row = rows("orphaned-run-settled")
    expect(row).toHaveLength(1)
    expect(row[0]?.props).toMatchObject({
      run: "R1",
      step: "merge",
      job: mergeJob.id,
      runner: "yrd-local",
      cause: "lease-expired",
      disposition: "timed-out",
      landedMergeReader: "consulted",
    })
    const unproven = rows("orphaned-merge-unproven")
    expect(unproven, "the reader says what it asked and what it found").toHaveLength(1)
    expect(unproven[0]?.props).toMatchObject({ run: "R1", member: "PR1", verdict: "not-merged" })
  })
})
