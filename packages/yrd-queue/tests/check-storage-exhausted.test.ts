/**
 * @failure A check whose process ran out of storage (EDQUOT on a quota'd
 * tmpfs, ENOSPC on a full disk) exits non-zero, and the queue reads that exit
 * as the check's VERDICT on the change: `<step>-failed`, author disposition,
 * and — because a candidate was in hand — the standing submit fact is retired.
 * A full disk then consumes a submission nobody can re-push their way out of.
 * Measured 2026-09-01 22:24 PDT: PR3159 and PR3175 both died inside
 * `affected-tests` on `fatal: unable to write loose object file: Disk quota
 * exceeded` / `EDQUOT: unknown error, write` (the km tests under it create git
 * repos on a /tmp tmpfs whose per-user quota was full); yrd classified both
 * `affected-tests-failed` and emitted `submit-fact-retired` for each.
 *
 * Operator ruling (2026-09-01): within ten minutes of attempting a merge there
 * is a decision — yrd is broken, fix yrd; or the PR is broken, send it back.
 * Storage exhaustion is the FIRST case, never the second.
 * @level l2
 * @consumer @yrd/queue, @yrd/cli
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace, type PrNumberMint } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import { createProcess } from "@yrd/process"
import * as z from "zod"
import {
  candidateRefFor,
  gitCheckStep,
  withMerge,
  withQueue,
  withStep,
  type CandidatePreparer,
  type ChangeShape,
  type IntegrationProof,
  type StepExecution,
} from "@yrd/queue"
import { failureDisposition } from "../../yrd-cli/src/status-presentation.ts"

// ---------------------------------------------------------------------------
// Part 1 — the step: a real check process printing the outage's own lines.
// ---------------------------------------------------------------------------

const FIXTURE_CHANGE_ID = `I${"c0ffee12".repeat(5)}`

/** The exact lines PR3159's `affected-tests` output.log carried (2026-09-01 22:24 PDT). */
const GIT_QUOTA_LINE = "fatal: unable to write loose object file: Disk quota exceeded"
const GIT_QUOTA_PATH =
  "/tmp/km-vitest-3001/run-0ab3e2db-a4d8-4029-8412-86f52bee23a5/lint-bead-hygiene-delta-72eZkv/.git/info/exclude"
const GIT_COPY_LINE = `fatal: cannot copy '/nix/store/x-git-2.54.0/share/git-core/templates/info/exclude' to '${GIT_QUOTA_PATH}': Disk quota exceeded`
const NODE_QUOTA_LINE = "EDQUOT: unknown error, write"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(repo: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

async function remoteRepository(): Promise<{ repo: string; featureSha: string }> {
  const root = await mkdtemp(join(tmpdir(), "yrd-check-storage-"))
  roots.push(root)
  const repo = join(root, "repo")
  await Bun.$`git init -q -b main ${repo}`
  await git(repo, ["config", "user.name", "Yrd Test"])
  await git(repo, ["config", "user.email", "yrd@example.invalid"])
  await writeFile(join(repo, "README.md"), "main\n")
  await git(repo, ["add", "README.md"])
  await git(repo, ["commit", "-qm", "main"])
  await git(repo, ["switch", "-qc", "issue/feature"])
  await writeFile(join(repo, "feature.txt"), "feature\n")
  await git(repo, ["add", "feature.txt"])
  await git(repo, ["commit", "-qm", "feature"])
  const featureSha = await git(repo, ["rev-parse", "HEAD"])
  await git(repo, ["switch", "-q", "main"])
  const remote = join(root, "origin.git")
  await Bun.$`git init -q --bare ${remote}`
  await git(repo, ["remote", "add", "origin", remote])
  await git(repo, ["push", "-q", "origin", "main", "issue/feature"])
  return { repo, featureSha }
}

const checkInputFor = (featureSha: string) =>
  ({
    run: "R1",
    step: "affected-tests",
    index: 0,
    prs: [
      {
        id: "PR1",
        changeId: FIXTURE_CHANGE_ID,
        branch: "issue/feature",
        base: "main",
        revision: 1,
        headSha: featureSha,
      },
    ],
    shape: { results: {} },
  }) satisfies StepExecution<ChangeShape>

/** A check that prints `lines` to stderr and exits 1 — the shape of a test
 * runner whose git fixtures could not be written. */
const printingCheck = (lines: readonly string[]): readonly string[] => [
  "sh",
  "-c",
  `${lines.map((line) => `printf '%s\\n' "${line}" >&2`).join("; ")}; exit 1`,
]

async function runAffectedTests(lines: readonly string[]) {
  const { repo, featureSha } = await remoteRepository()
  await using real = createProcess()
  return await gitCheckStep({
    inject: { process: real },
    repo,
    purpose: "affected-tests",
    command: printingCheck(lines),
  })(checkInputFor(featureSha), { id: "J-check", attempt: 1, runner: "test", signal: new AbortController().signal })
}

describe("a check whose process ran out of storage reached no verdict on the change", () => {
  it("classifies git's 'Disk quota exceeded' inside the check as check-storage-exhausted, naming the path and the cure", async () => {
    const outcome = await runAffectedTests([
      GIT_QUOTA_LINE,
      "tar: @km/old.md: Cannot write: Disk quota exceeded",
      GIT_COPY_LINE,
    ])

    expect(outcome).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "check-storage-exhausted" },
    })
    if (outcome.status !== "completed" || outcome.conclusion !== "failure") throw new Error("unreachable")
    // The measured misclassification: the exit status read as the check's verdict.
    expect(outcome.error.code).not.toBe("affected-tests-failed")
    // The cure, in the row itself: WHAT filled up, and the one command that re-runs the pass.
    expect(outcome.error.message).toContain(GIT_QUOTA_PATH)
    expect(outcome.error.message).toMatch(/free /u)
    expect(outcome.error.message).toContain("yrd queue run --once")
    expect(outcome.error.message).toContain("Disk quota exceeded")
    // A red the check never judged must not be certified as judged: that flag
    // is what settles a refusal needs-person on its first sighting.
    expect(outcome.output).not.toMatchObject({ judgedFailure: true })
  })

  it("classifies Node's EDQUOT line the same way, even with no path to name", async () => {
    const outcome = await runAffectedTests([NODE_QUOTA_LINE])

    expect(outcome).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "check-storage-exhausted" },
    })
    if (outcome.status !== "completed" || outcome.conclusion !== "failure") throw new Error("unreachable")
    expect(outcome.error.message).toContain(NODE_QUOTA_LINE)
    expect(outcome.error.message).toContain("yrd queue run --once")
  })

  it("still reads an ordinary red as the check's verdict (control)", async () => {
    const outcome = await runAffectedTests(["FAIL tests/example.test.ts > example", "Tests 1 failed | 3 passed"])

    expect(outcome).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "affected-tests-failed" },
    })
  })

  it("is the queue's to retry, never the author's to re-push", () => {
    expect(failureDisposition("check-storage-exhausted")).toEqual({
      state: "env",
      automation: "auto-requeue",
      owner: "queue",
    })
  })
})

// ---------------------------------------------------------------------------
// Part 2 — the queue: an environment refusal never retires the submit fact.
// ---------------------------------------------------------------------------

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const SHA = "7".repeat(40)
const runtime = { runner: "local", leaseMs: 60_000 }
const CheckResultSchema = z.object({ checked: z.boolean() }).strict()
type CheckResult = z.infer<typeof CheckResultSchema>

function ids(): () => string {
  let value = 0
  return () => `00000000-0000-7000-8000-${(++value).toString(16).padStart(12, "0")}`
}

function workspace(): BayWorkspace {
  return {
    revision: "test-workspace-v1",
    provision: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: `/repo/.bays/${input.bay}`, headSha: HEAD, baseSha: BASE },
    }),
    refresh: (input) => ({
      status: "completed",
      conclusion: "success",
      output: { path: input.path ?? `/repo/.bays/${input.bay}`, headSha: HEAD, baseSha: BASE, dirty: false },
    }),
    checkpoint: () => ({
      status: "completed",
      conclusion: "success",
      output: { headSha: HEAD, pushed: true, wip: false },
    }),
    deprovision: () => ({ status: "completed", conclusion: "success", output: {} }),
  }
}

const mergeableCandidate: CandidatePreparer = (input) => {
  const { prs: _prs, ...candidate } = input
  return { ...candidate, sha: MERGED, ref: candidateRefFor(MERGED), mergeability: "mergeable" }
}

async function createApp(
  options: Readonly<{
    log?: ReturnType<typeof createLogger>
    queueMint?: PrNumberMint
    /** What the required check answers, per invocation, in order; a missing entry passes. */
    checkOutcomes: readonly (JobResult<CheckResult> | undefined)[]
  }>,
) {
  let invocation = 0
  const check = withStep(
    "check",
    (_input: StepExecution): JobResult<CheckResult> =>
      options.checkOutcomes[invocation++] ?? { status: "completed", conclusion: "success", output: { checked: true } },
    { revision: "check-v1", output: CheckResultSchema },
  )
  const merge = withMerge(
    async (): Promise<JobResult<IntegrationProof>> => ({
      status: "completed",
      conclusion: "success",
      output: { commit: MERGED, baseSha: BASE },
    }),
    { revision: "merge-v1" },
  )
  const queue = withQueue({
    steps: [check, merge] as const,
    batch: false,
    defaultSteps: ["check", "merge"],
    resolveBaseSha: () => BASE,
    prepareCandidate: mergeableCandidate,
    prNumberMint: options.queueMint ?? volatilePrNumberMint(),
    readSubmitEnrichment: ({ sha }) => ({ changeId: `I${sha}` }),
  })
  const bayJobs = createBayJobDefs(workspace())
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ prNumberMint: volatilePrNumberMint(), jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: {
      journal: createMemoryJournal(),
      id: ids(),
      clock: () => "2026-01-01T00:00:00.000Z",
      log: options.log ?? createLogger("test", [{ level: "silent" }]),
    },
  })
}

function actionsLogged(events: readonly LogEvent[]): string[] {
  return events.flatMap((event) =>
    event.kind === "log" && typeof event.props?.action === "string" ? [event.props.action] : [],
  )
}

const environmentRefusal = (code: string): JobResult<CheckResult> => ({
  status: "completed",
  conclusion: "failure",
  error: {
    code,
    message: `check ran out of storage and reached no verdict: ${GIT_QUOTA_LINE}. Cure: free the filesystem, then: yrd queue run --once`,
  },
})

describe("an environment refusal inside a check never retires the submission", () => {
  it.each([
    // The new code, from the step above.
    "check-storage-exhausted",
    // Its scratch-allocator twin (9092059f): ENOSPC while PREPARING the check's
    // worktree. Same bucket, and before this it retired the fact just the same —
    // the retire decision read "a candidate was in hand", never the disposition.
    "worktree-storage-exhausted",
    // The SIGKILL / could-not-run shape the check wrapper already emits.
    "queue-environment-refused",
  ])("%s keeps the fact standing: the submission survives the queue's own environment failing", async (code) => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    const queueMint = volatilePrNumberMint()
    await using app = await createApp({ log, queueMint, checkOutcomes: [environmentRefusal(code)] })

    await app.bays.recordBranchSubmit({ branch: "issue/on-a-full-disk", sha: SHA, base: "main" })

    // Pass 1: the candidate is built and its required check dies on storage.
    await app.queue.run({}, runtime)
    expect(queueMint.highWater(), "the first pass derives exactly one change").toBe(1)

    // THE REGRESSION: a candidate in hand plus a `failure` conclusion retired the
    // fact, so a full disk consumed the submission (PR3159, PR3175).
    expect(app.state().queues.retiredSubmits, "an environment refusal must not retire the fact").toEqual({})
    const actions = actionsLogged(events)
    expect(actions).not.toContain("submit-fact-retired")
    // The decision is visible, and it names the cure, not the author.
    expect(actions).toContain("submit-fact-kept")
    const kept = events.find((event) => event.kind === "log" && event.props?.action === "submit-fact-kept")
    expect(kept?.props).toMatchObject({ branch: "issue/on-a-full-disk", sha: SHA, code })

    // Pass 2: nobody re-pushed anything, and the fact is still the author's
    // standing consent — nothing retired it, and no second change was minted
    // for it. (Re-driving the held check on the next pass is the eligibility
    // ladder's business — `required-check-failed` holds a derived member until
    // its run's authority is released — and is reported, not pinned, here.)
    await app.queue.run({}, runtime)
    expect(app.state().queues.retiredSubmits).toEqual({})
    expect(app.state().bays.submits["issue/on-a-full-disk"]).toMatchObject({ sha: SHA, base: "main" })
    expect(actionsLogged(events)).not.toContain("submit-fact-retired")
  })

  it("a judged red still retires the fact (control): only an author-owned refusal can", async () => {
    const events: LogEvent[] = []
    const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
    await using app = await createApp({
      log,
      checkOutcomes: [
        {
          status: "completed",
          conclusion: "failure",
          error: { code: "check-failed", message: "the required check failed on this content" },
        },
      ],
    })
    await app.bays.recordBranchSubmit({ branch: "issue/genuinely-red", sha: SHA, base: "main" })

    await app.queue.run({}, runtime)

    expect(app.state().queues.retiredSubmits["issue/genuinely-red"]).toMatchObject({ sha: SHA, code: "check-failed" })
    expect(actionsLogged(events)).toContain("submit-fact-retired")
    expect(actionsLogged(events)).not.toContain("submit-fact-kept")
  })
})
