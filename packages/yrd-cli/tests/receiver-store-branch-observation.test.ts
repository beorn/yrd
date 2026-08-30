/**
 * @failure A `git push bay HEAD:refs/for/main/<issue>` minted change PR2081 and
 * the habitant's tracked-observation pass WITHDREW it the same second: the
 * branch-liveness observation asked the GitHub origin about the receiver-minted
 * `issue/…` carrier, origin answered an authoritative "absent" about a branch
 * it never hosted, and `evictUnobservableCandidate` swept the change. Reopening
 * with `yrd pr submit` was withdrawn again 27s later by the same arm
 * (@i/10-merge-queue/refsfor-withdrawn-carrier).
 * @level l2
 * @consumer @yrd/cli habitant runner, `yrd pr view`
 *
 * Drives the REAL observation arm exactly like habitant-tracked-observation:
 * no `io.pruneGit`, a real repository with a real origin AND a real receiver
 * store at `<git-common-dir>/yrd/prs.git`, and the installed `@yrd/process`.
 */
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { createBayJobDefs, withBays, volatilePrNumberMint } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, JsonSchema, pipe, type JsonValue } from "@yrd/core"
import { runYrd } from "@yrd/cli"
import { testQueueReadModel } from "./queue-read-model-test-helper.ts"
import { withJobs, type JobResult } from "@yrd/job"
import { createProcess } from "@yrd/process"
import { withMerge, withQueue, withStep, type ChangeShape, type StepExecution } from "@yrd/queue"
import { createLogger, type Event as LogEvent } from "loggily"
import { observeLiveBranch } from "../src/remote-branch.ts"
import * as runInternals from "../src/run.ts"
import type { YrdCliApp, YrdCliIO, YrdCliServices } from "../src/types.ts"

/** The live incident's shape: a carrier the refs/for push named after its issue. */
const CARRIER = "issue/@i/10-merge-queue/22991-branch-is-change-delete-the-pr-record"
/** Negative control: a branch neither origin nor the store owns must still evict. */
const GONE = "task/gone-everywhere"

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
 * A real repository whose `origin` carries ONLY `main`, whose receiver store at
 * `.git/yrd/prs.git` owns the refs/for-minted carrier as its accepted
 * `refs/yrd/submit/<branch>` approval, and whose local `refs/heads/<carrier>`
 * is the intake-materialized carrier — the exact post-push state PR2081 was
 * withdrawn from. GONE exists locally only: not on origin, not in the store.
 */
async function repository() {
  const root = await mkdtemp(join(tmpdir(), "yrd-receiver-store-observation-"))
  const origin = join(root, "origin.git")
  const repo = join(root, "repo")
  await git(root, ["init", "-q", "--bare", "origin.git"])
  await git(root, ["init", "-q", "-b", "main", "repo"])
  const commit = async (file: string, message: string): Promise<string> => {
    await Bun.write(join(repo, file), `${file}\n`)
    await git(repo, ["add", "--", file])
    await git(repo, ["commit", "-q", "-m", message])
    return git(repo, ["rev-parse", "HEAD"])
  }
  const mainSha = await commit("base.txt", "base")
  await git(repo, ["remote", "add", "origin", origin])
  await git(repo, ["push", "-q", "origin", "main"])

  // The receiver-minted carrier: real content, materialized as a local branch
  // (what `materializeCarrier` does at intake), never pushed to origin.
  await git(repo, ["checkout", "-q", "-b", CARRIER])
  const carrierHead = await commit("carrier.txt", "refs/for payload")

  // The receiver store, at the layout `discoverYrdRepository` names, owning the
  // carrier as its accepted submit ref — the refs/for mint's store-side fact.
  const store = join(repo, ".git", "yrd", "prs.git")
  await git(root, ["init", "-q", "--bare", store])
  await git(repo, ["push", "-q", store, `refs/heads/${CARRIER}:refs/yrd/submit/${CARRIER}`])

  // The genuinely-gone branch: local commit only, absent on origin and in the store.
  await git(repo, ["checkout", "-q", "-b", GONE, "main"])
  const goneHead = await commit("gone.txt", "gone-everywhere work")
  await git(repo, ["checkout", "-q", "main"])
  return { repo, mainSha, carrierHead, goneHead }
}

function ids(): () => string {
  let value = 0
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

/** Composes only the plugins the tracking pass touches, exactly like
 * habitant-tracked-observation.test.ts. */
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
    async (_input: StepExecution<ChangeShape>): Promise<JobResult<{ commit: string; baseSha: string }>> => ({
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
    withBays({
      prNumberMint: volatilePrNumberMint(),
      jobs: bayJobs,
      defaultBase: "main",
      resolveBase: () => ({ base: "main", baseSha: mainSha }),
    }),
  )
  return createYrd(queue(base), {
    inject: {
      journal: createMemoryJournal(),
      clock: () => "2026-08-26T18:18:39.850Z",
      id: ids(),
      log,
    },
  })
}

function liveIO(repo: string): YrdCliIO {
  return {
    stdout: () => {},
    stderr: () => {},
    cwd: repo,
    runner: "yrd-cli:receiver-store-observation-test",
    leaseMs: 60_000,
    now: () => Date.parse("2026-08-26T18:18:57.794Z"),
  } as unknown as YrdCliIO
}

describe("a receiver-owned carrier survives the habitant's tracked-observation pass", () => {
  it("keeps the refs/for-minted change submitted while still evicting a branch that is gone everywhere", async () => {
    const fixture = await repository()
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const app = await trackedApp(fixture.mainSha, log)
    const cliApp = app as unknown as YrdCliApp

    // The live incident's sequence: intake submitted the carrier and requested
    // its checks; the observation pass ran seconds later.
    await app.bays.submit({ branch: CARRIER, headSha: fixture.carrierHead, base: "main", baseSha: fixture.mainSha })
    await app.bays.submit({ branch: GONE, headSha: fixture.goneHead, base: "main", baseSha: fixture.mainSha })
    await app.bays.editPr({ pr: "PR1", track: true })
    await app.bays.editPr({ pr: "PR2", track: true })
    await app.bays.review({ pr: "PR1", by: "@reviewer", decision: "approve", ref: "approved-carrier" })
    await app.bays.review({ pr: "PR2", by: "@reviewer", decision: "approve", ref: "approved-gone" })
    await app.bays.requestChecks({ pr: "PR1" })
    await app.bays.requestChecks({ pr: "PR2" })

    const io = liveIO(fixture.repo)
    await using process = createProcess({ env: { PATH: Bun.env.PATH } })
    const services = { process, recut: { recut: vi.fn() } } as unknown as YrdCliServices

    const outcomes = await runInternals.refreshTrackedQueueRevisions(cliApp, services, io)

    // THE DEFECT: before the store-first observation, this pass returned
    // {status:"evicted", code:"recut-branch-absent"} for the carrier and closed
    // it — origin's authoritative "absent" was true of the wrong remote. The
    // store owns the branch, so its recorded head is fresh and the change must
    // stay exactly where intake left it.
    expect(outcomes.find((outcome) => outcome.branch === CARRIER)).toBeUndefined()
    const carrier = Object.values(app.state().bays.prs).find((pr) => pr.branch === CARRIER)
    expect(carrier).toMatchObject({ state: "open", merged: false })

    // Negative control, and proof eviction itself still works: a branch that
    // neither origin nor the store owns is still swept, with the store named in
    // the recorded reason so the next reader knows both authorities answered.
    const evicted = outcomes.find((outcome) => outcome.branch === GONE)
    expect(evicted).toMatchObject({ status: "evicted", pr: "PR2", code: "recut-branch-absent" })
    if (evicted?.status !== "evicted") throw new Error("expected the gone-everywhere branch to evict")
    expect(evicted.message).toContain("gone from origin")
    expect(evicted.message).toContain("the receiver store does not own")
    const gone = Object.values(app.state().bays.prs).find((pr) => pr.branch === GONE)
    expect(gone).toMatchObject({ state: "closed", merged: false })
    log.end()
  })

  it("refuses an absent branch on `pr view --json`, exactly as the human path does", async () => {
    // The observation used to run only under `!json`, so the machine-readable
    // path skipped it entirely: `pr view PR1` refused for a person and
    // `pr view PR1 --json` answered as if the change were ordinary, for every
    // script and every robot — which are what act on a stuck head
    // (@i/10-yrd/absent-branch-is-terminal). Same branch, same repository, both
    // shapes must refuse.
    const fixture = await repository()
    const log = createLogger("yrd", [{ level: "silent" }])
    const app = await trackedApp(fixture.mainSha, log)
    const cliApp = app as unknown as YrdCliApp
    await app.bays.submit({ branch: GONE, headSha: fixture.goneHead, base: "main", baseSha: fixture.mainSha })

    await using process = createProcess({ env: { PATH: Bun.env.PATH } })
    const services = {
      process,
      queueReadModel: testQueueReadModel(cliApp),
    } as unknown as YrdCliServices

    for (const argv of [
      ["pr", "view", "PR1"],
      ["pr", "view", "PR1", "--json"],
    ]) {
      const out: string[] = []
      const err: string[] = []
      const io = {
        ...liveIO(fixture.repo),
        stdout: (text: string) => out.push(text),
        stderr: (text: string) => err.push(text),
      } as unknown as YrdCliIO

      const exit = await runYrd(cliApp, argv, io, services)

      const shape = argv.join(" ")
      expect(exit, `expected '${shape}' to exit nonzero`).not.toBe(0)
      expect(err.join(""), `expected '${shape}' to name the absent branch`).toContain(GONE)
      expect(err.join(""), `expected '${shape}' to say the source is gone`).toContain("gone from origin")
      // Nothing renderable escaped: a caller parsing stdout must not get a
      // document describing a change whose source does not exist.
      expect(out.join(""), `expected '${shape}' to print no change document`).toBe("")
    }
    log.end()
  })

  it("resolves the carrier for read surfaces (`pr view`) from the store, not origin", async () => {
    // `viewPr` refuses with pr-view-branch-absent purely on this observation's
    // verdict, so the mechanism-level assertion covers the surface: a
    // store-owned branch observes ok at the store's accepted head.
    const fixture = await repository()
    await using process = createProcess({ env: { PATH: Bun.env.PATH } })
    const observed = await observeLiveBranch(process, fixture.repo, CARRIER)
    expect(observed).toEqual({
      ok: true,
      head: fixture.carrierHead,
      target: `refs/yrd/submit/${CARRIER}`,
    })
  })
})
