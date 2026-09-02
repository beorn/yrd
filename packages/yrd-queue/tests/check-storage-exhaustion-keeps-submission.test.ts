/**
 * @failure An infrastructure failure INSIDE a required check retires the
 * submission. PR3159, 2026-09-01 22:24 PDT: the `affected-tests` child hit
 * EDQUOT on the scratch filesystem, printed git's own `Disk quota exceeded`
 * lines and exited 1. `configuredCommandStep` coded that `affected-tests-failed`
 * — the dynamic `<step>-failed` family `canonicalRefusalCode` folds onto
 * `check-failed`, an AUTHOR disposition — so `refuseRevisionAdmission` recorded
 * the refusal with kind "failure" and `retireDerivedSubmitFact` journaled
 * `queue/submit/retired`, consuming a submit fact for content nobody judged.
 * The author pushed nothing wrong; the filesystem was full.
 *
 * The contract (@i/10-yrd/24031): the step failure is coded
 * `check-storage-exhausted`, the refusal fact has kind "infrastructure", its
 * reason names the failing path and the cure, the submit fact STAYS STANDING,
 * and the next pass derives the same member again and re-runs the check.
 * @level l2
 * @consumer @yrd/queue admitChangeRevision / refuseRevisionAdmission,
 *   configuredCommandStep failure classification
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createLogger, type Event as LogEvent } from "loggily"
import { createBayJobDefs, withBays, volatilePrNumberMint, type BayWorkspace } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs, type JobResult } from "@yrd/job"
import { createProcess, type Process } from "@yrd/process"
import { failureDisposition } from "../../yrd-cli/src/status-presentation.ts"
import {
  candidateRefFor,
  canonicalRefusalCode,
  CHECK_GATE_REPORT_INVALID,
  CHECK_TIMEOUT,
  GATE_REPORT_TRAILER,
  COMPOSITION_FAILURE_BUCKETS,
  configuredCommandStep,
  ENVIRONMENT_OWNED_FAILURE_CODES,
  withMerge,
  withQueue,
  withStep,
  type CandidatePreparer,
  type ChangeShape,
  type IntegrationProof,
} from "@yrd/queue"

const HEAD = "1".repeat(40)
const BASE = "a".repeat(40)
const MERGED = "b".repeat(40)
const SHA = "7".repeat(40)
const BRANCH = "issue/edquot-inside-check"
const STEP = "affected-tests"
const runtime = { runner: "local", leaseMs: 60_000 }
/** Mirrors `CHECK_STORAGE_EXHAUSTED` (scratch-storage.ts) as a literal: importing a
 * constant this branch does not export would fail the whole file at link time,
 * including the author-case control that must stay green here. */
const CHECK_STORAGE_EXHAUSTED = "check-storage-exhausted"
/** The scratch path git could not write, quoted verbatim from the incident. */
const FAILING_PATH =
  "/tmp/km-vitest-3001/run-0ab3e2db-a4d8-4029-8412-86f52bee23a5/lint-bead-hygiene-delta-72eZkv/.git/info/exclude"
/** Exactly what PR3159's `affected-tests` child printed before exiting 1. */
const EDQUOT_OUTPUT = [
  "fatal: unable to write loose object file: Disk quota exceeded",
  "error: copy-fd: write returned: Disk quota exceeded",
  `fatal: cannot copy '/nix/store/1k2lblqlj39azh6wn1sffa2869vrg3mr-git-2.54.0/share/git-core/templates/info/exclude' to '${FAILING_PATH}'`,
  "affected evidence kept: /tmp/tent-affected-fe8520e8ea72/attempt-YgSeTT — the check did not pass; inspect it, then remove it",
  "EDQUOT: unknown error, write",
]
/** A check that ran to its own exit and JUDGED the content: the author case. */
const AUTHOR_OUTPUT = ["FAIL src/x.test.ts > x"]

const roots: string[] = []
const disposables: AsyncDisposable[] = []

afterEach(async () => {
  for (const disposable of disposables.splice(0)) await disposable[Symbol.asyncDispose]()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

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

/** The required check as a REAL script under a real process — the shape the
 * incident had, not a callback returning a hand-built verdict. It counts its
 * invocations; with `passOnRerun` it fails exactly once, modelling a filesystem
 * that has room again by the next pass. */
type CheckPlan = Readonly<{
  stream: "stdout" | "stderr"
  passOnRerun: boolean
  /** Seconds the check sleeps before it says anything — for the case where the
   * bound fires and the check never reaches a verdict at all. */
  sleepSeconds?: number
  /** The wall-clock bound the step gives the check, when the case is about one. */
  timeoutMs?: number
  /** The status the check exits with. Default 1 — a check that judged the
   * content — so a case about a PROTOCOL fault can exit 0 and prove the two
   * are independent. */
  exitCode?: number
}>

function checkScript(root: string, lines: readonly string[], options: CheckPlan): string {
  const marker = join(root, "already-failed-once")
  return [
    "#!/bin/sh",
    `printf 'run\\n' >> '${join(root, "invocations")}'`,
    ...(options.sleepSeconds === undefined ? [] : [`sleep ${String(options.sleepSeconds)}`]),
    ...(options.passOnRerun ? [`[ -e '${marker}' ] && exit 0`, `: > '${marker}'`] : []),
    `cat${options.stream === "stderr" ? " >&2" : ""} <<'YRD_CHECK_OUTPUT'`,
    ...lines,
    "YRD_CHECK_OUTPUT",
    `exit ${String(options.exitCode ?? 1)}`,
    "",
  ].join("\n")
}

/** derived-fact-terminal.test.ts's reference configuration, with the required
 * check swapped for `configuredCommandStep` running `script` under `process`. */
async function createApp(
  root: string,
  script: string,
  process: Process,
  log: ReturnType<typeof createLogger>,
  journal: ReturnType<typeof createMemoryJournal>,
  timeoutMs?: number,
) {
  const check = withStep(
    STEP,
    configuredCommandStep<ChangeShape>({
      inject: { process },
      command: ["sh", script],
      cwd: root,
      artifactRoot: join(root, "artifacts"),
      purpose: STEP,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }),
    { revision: `${STEP}-v1` },
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
    defaultSteps: [STEP, "merge"],
    resolveBaseSha: () => BASE,
    prepareCandidate: mergeableCandidate,
    prNumberMint: volatilePrNumberMint(),
    readSubmitEnrichment: ({ sha }) => ({ changeId: `I${sha}` }),
  })
  const bayJobs = createBayJobDefs(workspace())
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs] }),
    withBays({ prNumberMint: volatilePrNumberMint(), jobs: bayJobs }),
  )
  return createYrd(queue(base), {
    inject: { journal, id: ids(), clock: () => "2026-01-01T00:00:00.000Z", log },
  })
}

/** One standing derived-lane submit fact whose required check is `lines`. */
async function scenario(lines: readonly string[], options: CheckPlan) {
  const root = await mkdtemp(join(tmpdir(), "yrd-check-edquot-"))
  roots.push(root)
  const script = join(root, `${STEP}.sh`)
  await writeFile(script, checkScript(root, lines, options))
  const events: LogEvent[] = []
  const log = createLogger("yrd", [{ level: "trace" }, { write: (event: LogEvent) => events.push(event) }])
  const journal = createMemoryJournal()
  const process = createProcess()
  disposables.push(process)
  const app = await createApp(root, script, process, log, journal, options.timeoutMs)
  disposables.push(app)
  await app.bays.recordBranchSubmit({ branch: BRANCH, sha: SHA, base: "main" })
  const invocations = async (): Promise<number> => {
    const file = Bun.file(join(root, "invocations"))
    return (await file.exists()) ? (await file.text()).split("\n").filter((row) => row !== "").length : 0
  }
  return { app, events, journal, invocations }
}

/** Every row this pass logged under `action`. */
function rowsWith(events: readonly LogEvent[], action: string): Extract<LogEvent, { kind: "log" }>[] {
  return events.filter(
    (event): event is Extract<LogEvent, { kind: "log" }> => event.kind === "log" && event.props?.action === action,
  )
}

/** The id the compose minted for the derived member — its only durable name. */
function derivedId(events: readonly LogEvent[]): string {
  const row = rowsWith(events, "compose-derived-admitted").find((entry) => entry.props?.branch === BRANCH)
  if (row === undefined) throw new Error(`no compose-derived-admitted row for ${BRANCH}`)
  return String(row.props?.pr)
}

/** Every event name the journal holds, in order — `queue/submit/retired` is the
 * write that consumes a submit fact, and its absence is the whole contract. */
async function journaledEventNames(journal: ReturnType<typeof createMemoryJournal>): Promise<string[]> {
  const names: string[] = []
  for await (const page of journal.read()) {
    for (const frame of page.values as readonly Readonly<{ events: readonly Readonly<{ name: string }>[] }>[]) {
      names.push(...frame.events.map((event) => event.name))
    }
  }
  return names
}

describe("an infrastructure failure inside a check never retires a submission", () => {
  it("an EDQUOT inside a check is an infrastructure refusal that names the cure and keeps the submit fact standing", async () => {
    const { app, events, journal, invocations } = await scenario(EDQUOT_OUTPUT, {
      stream: "stderr",
      passOnRerun: false,
    })

    await expect(app.queue.run({}, runtime)).resolves.toEqual([])

    // Positive controls: the script really ran and the refusal path was reached.
    expect(await invocations(), "the check ran exactly once").toBe(1)
    const pr = derivedId(events)
    const refusal = app.state().queues.admissionRefusals[pr]
    expect(refusal, "the refusal is recorded against the derived member").toBeDefined()

    // The step failure is an INFRASTRUCTURE fact, never the author's `<step>-failed`.
    expect(refusal?.code, "an EDQUOT inside the check is not a verdict on the content").toBe(CHECK_STORAGE_EXHAUSTED)
    expect(refusal?.kind).toBe("infrastructure")
    // The reason names WHERE it ran out and WHAT unsticks it.
    expect(refusal?.reason).toContain(FAILING_PATH)
    expect(refusal?.reason).toContain("free the filesystem backing")
    expect(rowsWith(events, "compose-candidate-skip")).toMatchObject([
      { props: { pr, code: CHECK_STORAGE_EXHAUSTED, kind: "infrastructure" } },
    ])

    // The submission survives: same fact, same sha, nothing retired anywhere.
    expect(app.state().bays.submits[BRANCH]).toMatchObject({ sha: SHA, base: "main" })
    expect(app.state().queues.retiredSubmits[BRANCH], "the submit fact must stay standing").toBeUndefined()
    expect(await journaledEventNames(journal)).not.toContain("queue/submit/retired")
    expect(rowsWith(events, "submit-fact-retired")).toEqual([])

    // The code is a registered, infra-retry member — the disposition every reader keys on.
    expect(canonicalRefusalCode(CHECK_STORAGE_EXHAUSTED), "registered in YRD_REFUSAL_CODES").toBe(
      CHECK_STORAGE_EXHAUSTED,
    )
    expect(COMPOSITION_FAILURE_BUCKETS["infra-retry"].has(CHECK_STORAGE_EXHAUSTED)).toBe(true)
  })

  /**
   * The same contract, reached by the other road: the check ran past its bound
   * and was killed, so it reached no verdict either.
   *
   * It coded `<step>-timeout` until 2026-09-02 — outside the closed vocabulary,
   * so `failureDisposition` THREW on it and only the outcome router's
   * unregistered-code `catch` kept it off the author's ball. `admissionFailureKind`
   * reads the environment-owned SET, not that catch, so it recorded `failure`
   * and retired the author's submit fact for a bound the author never set. The
   * fixed `check-timeout` closes it: same registered, environment-owned shape
   * `check-storage-exhausted` has above.
   */
  it("a check killed by its bound is an infrastructure refusal that keeps the submit fact standing", async () => {
    const { app, events, journal, invocations } = await scenario([], {
      stream: "stdout",
      passOnRerun: false,
      sleepSeconds: 5,
      timeoutMs: 500,
    })

    await expect(app.queue.run({}, runtime)).resolves.toEqual([])

    // Positive controls: the check really started, and the refusal path was reached.
    expect(await invocations(), "the check ran exactly once").toBe(1)
    const pr = derivedId(events)
    const refusal = app.state().queues.admissionRefusals[pr]
    expect(refusal, "the refusal is recorded against the derived member").toBeDefined()

    // A bound that fired is not a verdict on the content.
    expect(refusal?.code, "a bound that fired is not the author's").toBe(CHECK_TIMEOUT)
    expect(refusal?.kind).toBe("infrastructure")
    expect(refusal?.reason).toContain("wall-clock bound")
    expect(rowsWith(events, "compose-candidate-skip")).toMatchObject([
      { props: { pr, code: CHECK_TIMEOUT, kind: "infrastructure" } },
    ])

    // The submission survives: same fact, same sha, nothing retired anywhere.
    expect(app.state().bays.submits[BRANCH]).toMatchObject({ sha: SHA, base: "main" })
    expect(app.state().queues.retiredSubmits[BRANCH], "the submit fact must stay standing").toBeUndefined()
    expect(await journaledEventNames(journal)).not.toContain("queue/submit/retired")
    expect(rowsWith(events, "submit-fact-retired")).toEqual([])

    // Registered and environment-owned — the two facts every reader keys on,
    // and neither was true while the code was the dynamic `<step>-timeout`.
    expect(canonicalRefusalCode(CHECK_TIMEOUT), "registered in YRD_REFUSAL_CODES").toBe(CHECK_TIMEOUT)
    expect(ENVIRONMENT_OWNED_FAILURE_CODES.has(CHECK_TIMEOUT)).toBe(true)
    expect(failureDisposition(CHECK_TIMEOUT)).toMatchObject({ state: "timeout", owner: "queue" })
    // NEGATIVE CONTROL for both assertions above: the author's own red is in
    // neither, so membership is doing the work and not a vacuous `has`.
    expect(ENVIRONMENT_OWNED_FAILURE_CODES.has("check-failed")).toBe(false)
    expect(failureDisposition("check-failed")).toMatchObject({ owner: "author" })
  }, 20_000)

  /**
   * The starkest member of the family, end to end: the check EXITED ZERO.
   *
   * It printed a malformed `YRD-GATE-REPORT` trailer, so the tool broke its
   * protocol with the queue and the queue cannot read the run it just did. The
   * author's content was never in question — nothing about a passing check is
   * a complaint about a change — and yet until 2026-09-02 this was
   * `<step>-gate-report-invalid`, which resolves to nothing, so
   * `admissionFailureKind` fell through to `failure` and retired the submit
   * fact. One registered, environment-owned code closes it.
   */
  it("a malformed gate report from a check that PASSED is infrastructure, and keeps the submit fact standing", async () => {
    const { app, events, journal, invocations } = await scenario([`${GATE_REPORT_TRAILER}{not json`], {
      stream: "stdout",
      passOnRerun: false,
      exitCode: 0,
    })

    await expect(app.queue.run({}, runtime)).resolves.toEqual([])

    expect(await invocations(), "the check ran exactly once").toBe(1)
    const pr = derivedId(events)
    const refusal = app.state().queues.admissionRefusals[pr]
    expect(refusal, "the refusal is recorded against the derived member").toBeDefined()
    expect(refusal?.code, "a broken trailer is the tool's, never the content's").toBe(CHECK_GATE_REPORT_INVALID)
    expect(refusal?.kind).toBe("infrastructure")
    expect(refusal?.reason, "the record names the step").toContain(STEP)
    expect(rowsWith(events, "compose-candidate-skip")).toMatchObject([
      { props: { pr, code: CHECK_GATE_REPORT_INVALID, kind: "infrastructure" } },
    ])

    // The submission survives, exactly as it does for a full filesystem.
    expect(app.state().queues.retiredSubmits[BRANCH], "the submit fact must stay standing").toBeUndefined()
    expect(await journaledEventNames(journal)).not.toContain("queue/submit/retired")
    expect(canonicalRefusalCode(CHECK_GATE_REPORT_INVALID)).toBe(CHECK_GATE_REPORT_INVALID)
    expect(ENVIRONMENT_OWNED_FAILURE_CODES.has(CHECK_GATE_REPORT_INVALID)).toBe(true)
  })

  it("the same member is re-admitted on the next pass", async () => {
    const { app, events, invocations } = await scenario(EDQUOT_OUTPUT, { stream: "stderr", passOnRerun: true })
    await app.queue.run({}, runtime)
    expect(await invocations(), "positive control: the first pass ran the check once").toBe(1)
    const seen = events.length

    // The filesystem has room again; the standing fact alone carries this pass.
    const runs = await app.queue.run({}, runtime)

    const secondPass = events.slice(seen)
    expect(
      rowsWith(secondPass, "compose-derived-admitted").map((row) => row.props?.branch),
      "the fact must be derived again, not skipped as retired",
    ).toEqual([BRANCH])
    expect(rowsWith(secondPass, "compose-derived-fact-retired")).toEqual([])
    expect(await invocations(), "the check is re-run, not re-read from the first pass's terminal Job").toBe(2)
    expect(runs, "the SAME fact integrates with no re-push").toMatchObject([
      { status: "completed", conclusion: "success", prs: [{ headSha: SHA }] },
    ])
  })

  it("NEGATIVE CONTROL: a check that judged the content still codes `<step>-failed` and retires the fact", async () => {
    const { app, events, journal, invocations } = await scenario(AUTHOR_OUTPUT, { stream: "stdout", passOnRerun: true })

    await expect(app.queue.run({}, runtime)).resolves.toEqual([])

    const pr = derivedId(events)
    expect(app.state().queues.admissionRefusals[pr]).toMatchObject({ pr, code: `${STEP}-failed`, kind: "failure" })
    expect(app.state().queues.admissionRefusals[pr]?.reason).toContain("FAIL src/x.test.ts > x")
    expect(canonicalRefusalCode(`${STEP}-failed`), "the dynamic step family is the author's").toBe("check-failed")
    expect(app.state().queues.retiredSubmits[BRANCH]).toMatchObject({
      branch: BRANCH,
      sha: SHA,
      pr,
      code: `${STEP}-failed`,
    })
    expect(
      await journaledEventNames(journal).then((names) => names.filter((name) => name === "queue/submit/retired")),
    ).toHaveLength(1)
    expect(rowsWith(events, "submit-fact-retired")).toMatchObject([{ props: { branch: BRANCH, sha: SHA, pr } }])

    // A retired fact derives nothing on the next pass, even though the script
    // would pass now: the cure is the author's re-push, never a retry.
    const seen = events.length
    await expect(app.queue.run({}, runtime)).resolves.toEqual([])
    expect(rowsWith(events.slice(seen), "compose-derived-fact-retired").map((row) => row.props?.branch)).toEqual([
      BRANCH,
    ])
    expect(await invocations(), "a retired fact is never checked again").toBe(1)
  })
})
