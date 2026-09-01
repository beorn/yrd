/**
 * @failure A derived member's submit fact MOVED while its admission was in
 *          flight — an author re-pushed the branch inside the compose's settle
 *          loop — and the typed refusal escaped `queue.run`. Under the
 *          yrd-runner service's `restart: "never"` andon the resident exited 1
 *          with no page raised: PR3090 `derived-submit-vanished` at 18:51:13Z
 *          on 2026-09-01, then the sibling PR3111 `derived-submit-moved` at
 *          19:12:20Z. ONE member took the whole merge queue offline, and with a
 *          fleet pushing every few minutes every later push took it offline
 *          again.
 * @level   l2
 * @consumer @yrd/cli habitant runner · @yrd/queue compose
 *
 * The acceptance test for the moved-submit fix family, and deliberately not a
 * second unit test of `retireStaleDerived` — `derived-admission.test.ts` already
 * pins the retirement at the queue seam, with a canned `queue.run` call. What no
 * test covered is the claim the incident was actually about: that the RESIDENT
 * survives it. So this drives the real `followQueueRuns` loop over a real
 * journal and asserts the things a person watching that outage wanted to be
 * true — the runner is still up, it is still composing, the event was reported
 * once and actionably, the queue can still be read, and work still flows.
 *
 * VERIFIED TO DISCRIMINATE, and the two probes are worth recording separately
 * because they show the fix family is two independent halves:
 *
 * - `retireStaleDerived` reduced to `return [...members]`: this fails at the
 *   retirement row (`expected [] to have a length of 1`) while the loop still
 *   RESOLVES — the kind-keyed cycle skip in `habitantCycleRecovery` catches
 *   the escaped refusal and keeps the runner alive. Losing the retirement
 *   alone costs the cycle, not the process.
 * - Both halves disabled: the loop rejects with the incident verbatim —
 *   `YrdFailure: yrd: derived member 'PR3' (issue/moved) was derived at 7777…
 *   but the live submit fact now stands at 8888… — re-derive admission at the
 *   live sha`, code `derived-submit-moved`. That is the 19:12:20Z exit.
 *
 * Note from the second probe, for whoever wires a refusal-loop stand-down:
 * this refusal carries `{kind, code, message}` and NO `FailureFact.pr`, so the
 * member id survives only inside the prose. Attribution keyed on the member
 * reads `undefined` for this whole family until `derived-admission.ts` sets it.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { createBayJobDefs, volatilePrNumberMint, withBays, type BayWorkspace } from "@yrd/bay"
import { withContests, type CommitResolver } from "@yrd/contest"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withIssues } from "@yrd/issue"
import { withJobs, type JobResult } from "@yrd/job"
import {
  candidateRefFor,
  queueChanges,
  withMerge,
  withQueue,
  withStep,
  type CandidatePreparer,
  type IntegrationProof,
  type StepExecution,
} from "@yrd/queue"
import * as z from "zod"
import { followQueueRuns } from "../src/run.ts"
import type { YrdCliIO } from "../src/types.ts"

const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
/** The sha the moved branch was submitted at, and derived against. */
const SUBMITTED = "7".repeat(40)
/** The sha the author re-pushed it to, mid-admission. */
const REPUSHED = "8".repeat(40)
const HOLDER_HEAD = "5".repeat(40)
const NEXT_HEAD = "6".repeat(40)
const MOVED_BRANCH = "issue/moved"
const HOLDER_BRANCH = "issue/holder"
const NEXT_BRANCH = "issue/next-first-submit"
const CheckResultSchema = z.object({ checked: z.boolean() }).strict()

function ids(): () => string {
  let value = 0
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace(): BayWorkspace {
  return {
    revision: "moved-submit-e2e-workspace-v1",
    provision: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: `/repo/.bays/${input.bay}`, headSha: SUBMITTED, baseSha: BASE },
    }),
    refresh: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: SUBMITTED, baseSha: BASE, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed",
      conclusion: "success",
      output: { headSha: SUBMITTED, pushed: true, wip: false },
    }),
    deprovision: () => ({ status: "completed", conclusion: "success", output: {} }),
  }
}

const mergeableCandidate: CandidatePreparer = (input) => {
  const { prs: _prs, ...candidate } = input
  return { ...candidate, sha: MERGED, ref: candidateRefFor(MERGED), mergeability: "mergeable" }
}

/**
 * A check step that fires a hook ONCE, from inside the settle loop.
 *
 * The settle loop is the compose's one long await between admitting a derived
 * member and selecting it, so it is the only place the incident's race exists.
 * A hook fired anywhere else models a different bug.
 */
function firingCheck(hook: () => (() => Promise<void>) | undefined, clear: () => void) {
  return withStep(
    "check",
    async (_input: StepExecution): Promise<JobResult<{ checked: boolean }>> => {
      const fire = hook()
      clear()
      if (fire !== undefined) await fire()
      return { status: "completed", conclusion: "success", output: { checked: true } }
    },
    { revision: "check-v1", output: CheckResultSchema },
  )
}

const passingMerge = () =>
  withMerge(
    async (): Promise<JobResult<IntegrationProof>> => ({
      status: "completed",
      conclusion: "success",
      output: { commit: MERGED, baseSha: BASE },
    }),
    { revision: "merge-v1" },
  )

async function createApp(
  steps: readonly ReturnType<typeof firingCheck | typeof passingMerge>[],
  log: ReturnType<typeof createLogger>,
) {
  // Production's wiring: ONE durable mint behind both lanes, which is what
  // makes a recordless submit fact derivable and keeps numbering monotone.
  const mint = volatilePrNumberMint()
  const queue = withQueue({
    steps,
    batch: false,
    defaultSteps: ["check", "merge"],
    resolveBaseSha: () => BASE,
    prepareCandidate: mergeableCandidate,
    prNumberMint: mint,
  } as never as Parameters<typeof withQueue>[0])
  const bayJobs = createBayJobDefs(workspace())
  // Issues and contests are here because the RESIDENT is: `followQueueRuns`
  // takes a whole `YrdCliApp`, so an app missing a plugin is not the thing
  // under test. A cast at the call site would have compiled and quietly tested
  // a smaller program than production runs.
  const commits: CommitResolver = { revision: "git-v1", resolveCommit: () => BASE }
  const contests = withContests({ runners: [], evaluators: [], git: commits })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs, contests.jobDefs] }),
    withIssues({ sources: [{ id: "km", resolve: (ref) => ({ ref, title: "Issue one" }) }] }),
    withBays({ prNumberMint: mint, jobs: bayJobs }),
  )
  return createYrd(contests(queue(base)), {
    inject: { journal: createMemoryJournal(), id: ids(), clock: () => "2026-09-01T00:00:00.000Z", log },
  })
}

type App = Awaited<ReturnType<typeof createApp>>

/** A branch that lives only as a submit ref: its record went terminal, and it
 * was re-submitted in git. The derived lane is the only way it can run. */
async function strandDerivedBranch(app: App, branch: string, sha: string): Promise<void> {
  await app.bays.submit({ branch, headSha: "9".repeat(40), base: "main", baseSha: BASE })
  const record = Object.values(app.state().bays.prs).find((pr) => pr.branch === branch)
  if (record === undefined) throw new Error(`no record for '${branch}'`)
  await app.bays.closePr({ pr: record.id, reason: "superseded" })
  await app.bays.recordBranchSubmit({ branch, sha, base: "main" })
}

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(repo: string, ...args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

/** A real checkout, because habitant mode is not a flag: the resident resolves
 * its config, its runner status path and its own source identity from one. */
async function queueRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-moved-submit-e2e-"))
  roots.push(root)
  const repo = join(root, "repo")
  await mkdir(repo, { recursive: true })
  await git(root, "init", "-q", "-b", "main", repo)
  await git(repo, "config", "user.name", "Yrd Test")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await writeFile(join(repo, ".yrd.yml"), 'base: main\nbatch: 1\nchecks:\n  - {check: {run: "true"}}\n')
  await git(repo, "add", ".yrd.yml")
  await git(repo, "commit", "-qm", "queue config")
  return repo
}

/**
 * The RESIDENT's IO, not a programmatic follower's.
 *
 * `runner: "yrd-cli:…"` is what makes this the habitant, and that distinction
 * is why this test can assert anything about work still flowing: the
 * maintenance tick is a LEVEL trigger that runs the queue every cycle, and it
 * fires for the habitant alone. A programmatic follower keeps the historical
 * drain-only behavior — `habitant-level-run.test.ts` pins both halves — so a
 * fixture that left `runner` off would compose exactly once and then sleep,
 * and the last assertion below would be measuring the fixture rather than the
 * queue.
 *
 * Every `now()` read advances a full maintenance interval, so every cycle is a
 * maintenance cycle; the sleep yields to real macrotasks so the loop cannot
 * starve the timers the heartbeat runs on.
 */
function residentIO(repo: string, headSha: string, cycles: number) {
  const controller = new AbortController()
  const stdout: string[] = []
  const stderr: string[] = []
  let slept = 0
  let now = Date.parse("2026-09-01T00:00:00.000Z")
  const io = {
    stdout: (text: string) => stdout.push(text),
    stderr: (text: string) => stderr.push(text),
    cwd: repo,
    repositoryRoot: repo,
    runner: "yrd-cli:moved-submit-e2e",
    implementationSource: `git:${headSha}`,
    leaseMs: 60_000,
    now: () => {
      now += 61_000
      return now
    },
    scope: {
      signal: controller.signal,
      sleep: async () => {
        slept += 1
        if (slept >= cycles) controller.abort()
        await new Promise((resolve) => setTimeout(resolve, 1))
      },
    },
  } as unknown as YrdCliIO
  return { io, stdout, stderr, ticks: () => slept }
}

function rowsFor(events: readonly LogEvent[], action: string) {
  return events.filter((event) => (event.props as Record<string, unknown> | undefined)?.action === action)
}

describe("the resident survives a submit fact that moves mid-admission", () => {
  it("retires the member once, keeps ticking, stays readable, and admits the next first-submit", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    let repush: (() => Promise<void>) | undefined
    const app = await createApp(
      [
        firingCheck(
          () => repush,
          () => {
            repush = undefined
          },
        ),
        passingMerge(),
      ],
      log,
    )
    try {
      // A ref-only branch, derived at the sha it was submitted at.
      await strandDerivedBranch(app, MOVED_BRANCH, SUBMITTED)
      // A second change, already MID-RUN when the resident starts. This is
      // load-bearing, not scenery: the settle loop is the compose's one long
      // await, and without a run to settle there the compose reaches selection
      // in the same tick and the incident's race cannot occur at all.
      await app.bays.submit({ branch: HOLDER_BRANCH, headSha: HOLDER_HEAD, base: "main", baseSha: BASE })
      const holder = Object.values(app.state().bays.prs).find((pr) => pr.branch === HOLDER_BRANCH)
      if (holder === undefined) throw new Error("no holder record")
      await app.dispatch(app.commands.queue.run, {
        prs: [holder.id],
        steps: ["check", "merge"],
        candidate: {
          id: "C9",
          queueId: "main",
          baseSha: BASE,
          revs: [{ pr: holder.id, n: 1, head: HOLDER_HEAD }],
          sha: MERGED,
          ref: candidateRefFor(MERGED),
          mergeability: "mergeable",
        },
      })
      expect(app.queue.get("R1")?.steps[0]?.job?.status, "the settle loop must have work to do").toBe("queued")

      // THE MOVE: the author re-pushes the submitted branch while the runner is
      // inside its settle loop, exactly as PR3111's author did at 19:12:20Z.
      repush = async () => {
        await app.bays.recordBranchSubmit({ branch: MOVED_BRANCH, sha: REPUSHED, base: "main" })
        // And the next branch anyone submits after the incident, so the last
        // assertion measures a queue that kept accepting work rather than one
        // that merely stopped crashing.
        await app.bays.recordBranchSubmit({ branch: NEXT_BRANCH, sha: NEXT_HEAD, base: "main" })
      }
      const repo = await queueRepository()
      const headSha = await git(repo, "rev-parse", "HEAD")
      const { io, stderr, ticks } = residentIO(repo, headSha, 6)

      // 1. THE RUNNER SURVIVES. Before the fix this rejected with the typed
      // refusal and the process exited 1 under `restart: "never"` — the queue
      // offline until a person noticed.
      await expect(
        followQueueRuns(app, [], { interval: 1 }, io, async () => undefined),
        "the resident must not die of one member's moved fact",
      ).resolves.toBe(3)

      // 2. AND KEEPS TICKING: it reached later cycles, not just the one that
      // met the move. A loop that survived by stopping is not a survivor.
      expect(ticks(), "the resident must compose again after the retirement").toBeGreaterThan(1)

      // 3. REPORTED ONCE, not per cycle: a retirement that re-fires every
      // interval is the log-and-continue shape the andon ruling removes.
      const retired = rowsFor(events, "compose-derived-retire").filter(
        (event) => (event.props as Record<string, unknown>).branch === MOVED_BRANCH,
      )
      expect(retired, "exactly one loud retirement row for the moved member").toHaveLength(1)
      expect(retired[0]?.props).toMatchObject({
        branch: MOVED_BRANCH,
        code: "derived-submit-moved",
        kind: "refusal",
        headSha: SUBMITTED,
        liveSha: REPUSHED,
      })
      // Actionable, not merely loud: the author re-pushed, so there is nothing
      // for anyone to do and the row has to say so.
      expect(String((retired[0]?.props as Record<string, unknown>).remedy)).toContain(REPUSHED)
      // Loud through the structured stream ONLY — the runner's stdout is a log
      // stream, and a bare stderr echo is the duplicate #undead pins.
      expect(stderr.join("")).toBe("")

      // 4. THE LISTING STAYS READABLE. The canonical both-lanes population read
      // behind every `pr` verb and the dashboard must ANSWER, not refuse, with
      // a retired identity in recent history.
      const changes = queueChanges(app.state().bays, app.state().queues)
      expect(changes.map((change) => change.branch)).toContain(MOVED_BRANCH)

      // 5. AND WORK STILL FLOWS: the next eligible first-submit is derived and
      // gets ONE durable id. Two would mean the retirement leaked a mint; zero
      // would mean the queue survived by going deaf.
      const admitted = changes.filter((change) => change.branch === NEXT_BRANCH)
      expect(
        admitted.map((change) => change.id),
        "one id for one first submit",
      ).toHaveLength(1)
    } finally {
      await app.close()
    }
  })
})
