/**
 * @failure One tracked PR whose branch cannot be observed — deleted on origin after landing, or a fetch that times out — throws out of the resident's tracking pass and stops revision preparation for EVERY other tracked PR until an operator restarts the runner.
 * @level l2
 * @consumer @yrd/cli resident runner
 *
 * Drives the REAL `freshRemoteBranch` arm: no `io.pruneGit`, a real Git
 * repository with a real `origin`, and the installed `@yrd/process`. Every other
 * tracked-revision test injects `pruneGit`, which routes around the live fetch
 * (recut-branch-freshness.ts liveBranchHead) — so the arm the installed CLI
 * actually runs had zero coverage.
 */
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { createBayJobDefs, currentChangeRev, withBays } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type JsonValue } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import { createProcess } from "@yrd/process"
import { withMerge, withQueue, withStep, type changeShape, type StepExecution } from "@yrd/queue"
import { createLogger, type Event as LogEvent } from "loggily"
import * as runInternals from "../src/run.ts"
import type { YrdCliApp, YrdCliIO, YrdCliServices } from "../src/types.ts"

const DELETED = "task/deleted-on-origin"
const HEALTHY = "task/healthy"

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    env: {
      ...Bun.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString() || result.stdout.toString()}`)
  }
  return result.stdout.toString().trim()
}

/**
 * A real repository whose `origin` carries `main` and HEALTHY but NOT DELETED —
 * the routine post-landing state that makes one tracked PR unobservable while
 * every other tracked PR is perfectly fine.
 */
async function repository() {
  const root = await mkdtemp(join(tmpdir(), "yrd-tracked-observation-"))
  const origin = join(root, "origin.git")
  const repo = join(root, "repo")
  await git(root, ["init", "-q", "--bare", "origin.git"])
  await git(root, ["init", "-q", "-b", "main", "repo"])
  // Real content, not empty commits: the preflight classifies by TREE, so
  // empty commits would make every branch's payload already-landed (SUBSUMED)
  // and the drift would never reach a prepared verdict.
  const commit = async (file: string, message: string): Promise<string> => {
    await Bun.write(join(repo, file), `${file}\n`)
    await git(repo, ["add", "--", file])
    await git(repo, ["commit", "-q", "-m", message])
    return git(repo, ["rev-parse", "HEAD"])
  }
  const mainSha = await commit("base.txt", "base")
  await git(repo, ["remote", "add", "origin", origin])
  await git(repo, ["push", "-q", "origin", "main"])

  // The tracked PR whose branch still exists LOCALLY but was deleted on origin.
  await git(repo, ["checkout", "-q", "-b", DELETED])
  const deletedHead = await commit("deleted.txt", "deleted-branch work")

  // The healthy tracked PR: recorded at one head, then MOVED on origin, so the
  // pass must record the drift and prepare the fresh revision.
  await git(repo, ["checkout", "-q", "-b", HEALTHY, "main"])
  const healthyRecorded = await commit("healthy-recorded.txt", "healthy recorded")
  const healthyLive = await commit("healthy-live.txt", "healthy pushed later")
  await git(repo, ["push", "-q", "origin", `${HEALTHY}:refs/heads/${HEALTHY}`])

  // A REAL recut of the healthy payload onto main, so the installed recutter
  // stub returns genuine Git identities rather than invented SHAs.
  await git(repo, ["checkout", "-q", "-b", "recut/healthy", "main"])
  await Bun.write(join(repo, "healthy-recorded.txt"), "healthy-recorded.txt\n")
  await Bun.write(join(repo, "healthy-live.txt"), "healthy-live.txt\n")
  await git(repo, ["add", "--", "healthy-recorded.txt", "healthy-live.txt"])
  await git(repo, ["commit", "-q", "-m", "recut healthy onto main"])
  const recutHead = await git(repo, ["rev-parse", "HEAD"])
  const recutTree = await git(repo, ["rev-parse", "HEAD^{tree}"])
  await git(repo, ["checkout", "-q", "main"])
  return { repo, origin, mainSha, deletedHead, healthyRecorded, healthyLive, recutHead, recutTree }
}

function ids(): () => string {
  let value = 0
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

/** Composes only the plugins the tracking pass touches; callers cast at the
 * boundary rather than rebuilding the full CLI composition. */
async function trackedApp(mainSha: string, log: ReturnType<typeof createLogger>) {
  const bayJobs = createBayJobDefs({
    revision: "observation-workspace-v1",
    provision: (input: { bay: string }) => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { path: `/bays/${input.bay}`, headSha: mainSha, baseSha: mainSha },
    }),
    refresh: (input: { bay: string; path?: string }) => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { path: input.path ?? `/bays/${input.bay}`, headSha: mainSha, baseSha: mainSha, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed" as const,
      conclusion: "success" as const,
      output: { headSha: mainSha, pushed: true, wip: false },
    }),
    deprovision: () => ({ status: "completed" as const, conclusion: "success" as const, output: {} }),
  } as never)
  const check = withStep(
    "check",
    (): JobResult<JsonValue> => ({ status: "completed", conclusion: "success", output: {} }),
    {
      revision: "check-v1",
      output: JsonSchema,
      classification: "carrier",
    },
  )
  const merge = withMerge(
    async (_input: StepExecution<changeShape>): Promise<JobResult<{ commit: string; baseSha: string }>> => ({
      status: "completed",
      conclusion: "success",
      output: { commit: mainSha, baseSha: mainSha },
    }),
    { revision: "merge-v1" },
  )
  const queue = withQueue({ steps: [check, merge] as const, batch: false })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ jobs: bayJobs, defaultBase: "main", resolveBase: () => ({ base: "main", baseSha: mainSha }) }),
  )
  return createYrd(queue(base), {
    inject: {
      journal: createMemoryJournal(),
      clock: () => "2026-07-29T12:00:00.000Z",
      id: ids(),
      log,
    },
  })
}

/** The REAL observation arm: no pruneGit, a real cwd, the installed process. */
function liveIO(repo: string): YrdCliIO {
  return {
    stdout: () => {},
    stderr: () => {},
    cwd: repo,
    runner: "yrd-cli:observation-test",
    leaseMs: 60_000,
    now: () => Date.parse("2026-07-29T12:01:00.000Z"),
  } as unknown as YrdCliIO
}

describe("resident tracking pass — one unobservable branch never stops the others", () => {
  it("defers the PR whose branch is gone from origin and still prepares the healthy tracked PR", async () => {
    const fixture = await repository()
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const app = await trackedApp(fixture.mainSha, log)
    const cliApp = app as unknown as YrdCliApp
    // PR1 sorts before PR2 (compareNatural over ids at one base), so the
    // unobservable branch is observed FIRST: before containment it took the
    // whole pass — and the resident — down before PR2 was ever reached.
    await app.bays.submit({ branch: DELETED, headSha: fixture.deletedHead, base: "main", baseSha: fixture.mainSha })
    await app.bays.submit({ branch: HEALTHY, headSha: fixture.healthyRecorded, base: "main", baseSha: fixture.mainSha })
    // Tracking is the opt-in that makes the resident OBSERVE these branches.
    await app.bays.editPr({ pr: "PR1", track: true })
    await app.bays.editPr({ pr: "PR2", track: true })
    // Tip-era gate: observation certifies a successor revision only for an
    // APPROVED PR (review-required otherwise). Approval is part of the healthy
    // baseline this test needs, not part of what it tests.
    await app.bays.review({ pr: "PR1", by: "@reviewer", decision: "approve", ref: "approved-obs-pr1" })
    await app.bays.review({ pr: "PR2", by: "@reviewer", decision: "approve", ref: "approved-obs-pr2" })
    const submitted = () => Object.values(app.state().bays.prs)
    expect(submitted().map((pr) => pr.branch)).toEqual([DELETED, HEALTHY])

    const io = liveIO(fixture.repo)
    await using process = createProcess({ env: { PATH: Bun.env.PATH } })
    const recut = vi.fn(async () => ({
      headSha: fixture.recutHead,
      baseSha: fixture.mainSha,
      treeSha: fixture.recutTree,
      patchId: "1".repeat(40),
      unchanged: false,
    }))
    const services = { process, recut: { recut } } as unknown as YrdCliServices

    // The pass must RESOLVE. Before containment it rejected with
    // kind:"configuration" recut-branch-refresh-failed and killed the resident.
    const outcomes = await runInternals.refreshTrackedQueueRevisions(cliApp, services, io)

    // The unobservable PR carries a typed, loud, per-PR outcome…
    const deferred = outcomes.find((outcome) => outcome.branch === DELETED)
    expect(deferred).toMatchObject({ status: "deferred", pr: "PR1", code: "recut-branch-refresh-failed" })
    if (deferred?.status !== "deferred") throw new Error("expected a deferred outcome for the unobservable branch")
    expect(deferred.message).toContain(DELETED)
    const deferralWarn = events.find(
      (event) => (event.props as { action?: string } | undefined)?.action === "queue-track-observation-deferred",
    )
    expect(deferralWarn, "the deferral must be LOUD on the resident's structured stream").toBeDefined()
    expect(deferralWarn?.props).toMatchObject({ pr: "PR1", code: "recut-branch-refresh-failed", attempts: 1 })

    // …and the cycle CONTINUED past it: the healthy PR's drift was recorded, so
    // its live head is now the current revision.
    expect(outcomes.find((outcome) => outcome.branch === HEALTHY)).toMatchObject({
      status: "applied",
      pr: "PR2",
      fromHead: fixture.healthyRecorded,
      // Tip semantics: `source` is the revision drift was observed FROM; the
      // live head becomes the successor revision, asserted on `revs` below.
      sourceHead: fixture.healthyRecorded,
      recorded: true,
    })
    // The drift is durable: the observed live head became an immutable revision,
    // and the prepared recut sits on top of it.
    const healthy = submitted().find((pr) => pr.branch === HEALTHY)
    if (healthy === undefined) throw new Error("expected the healthy tracked PR")
    // Tip semantics: the live head does not become a revision head of its own —
    // it flows into the recutter as proposedHeadSha and the recut PRODUCT is the
    // successor revision. Assert the observation reached the recutter, and that
    // the successor is current.
    expect(recut).toHaveBeenCalledWith(expect.objectContaining({ proposedHeadSha: fixture.healthyLive }))
    expect(healthy.revs).toHaveLength(2)
    expect(currentChangeRev(healthy).head).toBe(fixture.recutHead)

    // Positive control that the REAL fetch arm ran for the healthy branch: git
    // created its remote-tracking ref, which only the live fetch does.
    expect(await git(fixture.repo, ["rev-parse", `refs/remotes/origin/${HEALTHY}`])).toBe(fixture.healthyLive)
    log.end()
  })

  it("backs off re-observing the same unobservable {pr, revision, head} instead of fetching every cycle", async () => {
    // Observation is a live fetch at the HEAD of the cycle, so a branch that
    // stays deleted must not spend one (or a 30s timeout) every 15 seconds.
    const fixture = await repository()
    const log = createLogger("yrd", [{ level: "silent" }])
    const app = await trackedApp(fixture.mainSha, log)
    const cliApp = app as unknown as YrdCliApp
    await app.bays.submit({ branch: DELETED, headSha: fixture.deletedHead, base: "main", baseSha: fixture.mainSha })
    await app.bays.editPr({ pr: "PR1", track: true })

    await using process = createProcess({ env: { PATH: Bun.env.PATH } })
    let fetches = 0
    const counting = {
      run: (request: Parameters<typeof process.run>[0]) => {
        if (request.argv.includes("fetch")) fetches += 1
        return process.run(request)
      },
    }
    const services = { process: counting, recut: { recut: vi.fn() } } as unknown as YrdCliServices
    const io = liveIO(fixture.repo)
    const observation: runInternals.TrackedObservationBackoff = new Map()

    const passes = []
    for (let cycle = 0; cycle < 4; cycle += 1) {
      passes.push(await runInternals.refreshTrackedQueueRevisions(cliApp, services, io, observation))
    }

    // Cycle 1 observes and fails (window 2); cycles 2-3 skip; cycle 4 observes
    // again — bounded, and never permanently parked.
    expect(fetches).toBe(2)
    expect(passes.map((outcomes) => outcomes.length)).toEqual([1, 0, 0, 1])
    expect(passes[3]?.[0]).toMatchObject({ status: "deferred", code: "recut-branch-refresh-failed" })
    log.end()
  })

  it("still fails loud when the PROCESS has no Git observer at all", async () => {
    // The containment is scoped to per-branch observation facts. A missing Git
    // observer is identical for every candidate — a misbuilt CLI, not one PR's
    // condition — so deferring it would silently park the whole tracked set.
    const fixture = await repository()
    const log = createLogger("yrd", [{ level: "silent" }])
    const app = await trackedApp(fixture.mainSha, log)
    const cliApp = app as unknown as YrdCliApp
    await app.bays.submit({ branch: HEALTHY, headSha: fixture.healthyRecorded, base: "main", baseSha: fixture.mainSha })
    await app.bays.editPr({ pr: "PR1", track: true })

    const services = { recut: { recut: vi.fn() } } as unknown as YrdCliServices
    await expect(
      runInternals.refreshTrackedQueueRevisions(cliApp, services, liveIO(fixture.repo), new Map()),
    ).rejects.toThrow("no Git process is installed")
    log.end()
  })
})
