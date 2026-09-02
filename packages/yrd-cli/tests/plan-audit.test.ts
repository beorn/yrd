/**
 * @failure `queue audit` certifies a queue clean without comparing anything — an empty journal or an unwired leg prints the same words as "no drift" — or a habitant keeps executing a step set the base tip no longer declares, and neither surface names the shas it read.
 * @level l2
 * @consumer @yrd/cli host
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { InstalledStep, QueueRecord } from "@yrd/queue"
import { failureFact } from "@yrd/core"
import { createLogger } from "loggily"
import { createYrdHost as createYrdHostRaw, runYrdProcess } from "../src/host.ts"
import { queueAuditComparisonLine, requireInstalledDeclaredPlan } from "../src/run.ts"
import {
  installedPlanStale,
  planDeltas,
  recentRootRuns,
  runPlanMismatch,
  tipSinceLatestRun,
  type AdmissionLookup,
  type DeclaredPlanAt,
  type RecordedRunPlan,
} from "../src/plan-audit.ts"
import type { QueueEnvironmentAuditComparison, YrdCliServices } from "../src/types.ts"

const silentLog = createLogger("test", [{ level: "silent" }])
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function createYrdHost(options: Parameters<typeof createYrdHostRaw>[0] = {}) {
  return createYrdHostRaw({ ...options, log: options.log ?? silentLog })
}

const SHA_A = "a".repeat(40)
const SHA_B = "b".repeat(40)
const BLOB_1 = "1".repeat(40)
const BLOB_2 = "2".repeat(40)

function step(name: string, revision: string, overrides: Partial<InstalledStep> = {}): InstalledStep {
  return { name, title: name, revision, kind: name === "merge" ? "merge" : "check", ...overrides }
}

const TIP: DeclaredPlanAt = {
  sha: SHA_B,
  configBlobSha: BLOB_2,
  batchSize: 1,
  steps: [step("typecheck", "tc-v1"), step("affected-tests", "at-v1"), step("merge", "merge-v1")],
}

describe("plan deltas", () => {
  it("names every way two effective plans differ, in both directions, including a pure reorder", () => {
    const deltas = planDeltas(
      { batchSize: 1, steps: [step("a", "a-v2"), step("b", "b-v1"), step("c", "c-v1")] },
      { batchSize: 2, steps: [step("c", "c-v1"), step("a", "a-v1"), step("d", "d-v1")] },
      { expected: "tip", actual: "process", missingActual: "is not installed", missingExpected: "is undeclared" },
    )
    expect(deltas).toEqual([
      "batch size 1 (tip) vs 2 (process)",
      "step 'a' revision 'a-v2' (tip) vs 'a-v1' (process)",
      "step 'b' is not installed",
      "step 'd' is undeclared",
      "step order a→c (tip) vs c→a (process)",
    ])
  })

  it("reports nothing for equal plans and flags an integration-contract change at the same revision", () => {
    const same = { batchSize: 1, steps: TIP.steps }
    const vocabulary = { expected: "x", actual: "y", missingActual: "m", missingExpected: "n" }
    expect(planDeltas(same, same, vocabulary)).toEqual([])
    expect(
      planDeltas(
        same,
        { batchSize: 1, steps: [step("typecheck", "tc-v1", { classification: "base" }), TIP.steps[1]!, TIP.steps[2]!] },
        vocabulary,
      ),
    ).toEqual(["step 'typecheck' integration contract differs between x and y"])
  })
})

describe("leg c — this process against the base tip", () => {
  it("is silent when the installed plan equals the tip's plan", () => {
    expect(installedPlanStale("main", TIP, { batchSize: 1, steps: TIP.steps })).toBeUndefined()
  })

  it("predicts the declared-step-not-installed refusal, naming the step, both shas and the restart", () => {
    const finding = installedPlanStale("main", TIP, {
      batchSize: 1,
      steps: [step("typecheck", "tc-v1"), step("merge", "merge-v1")],
    })
    expect(finding?.code).toBe("installed-plan-stale")
    expect(finding?.message).toContain("this process installed typecheck→merge (batch 1)")
    expect(finding?.message).toContain(`main tip ${SHA_B.slice(0, 8)} (config blob ${BLOB_2.slice(0, 8)}) declares`)
    expect(finding?.message).toContain("typecheck→affected-tests→merge (batch 1)")
    expect(finding?.message).toContain("step 'affected-tests' is declared at the tip but not installed in this process")
    expect(finding?.message).toContain(
      "would refuse with declared-step-not-installed because 'affected-tests' has no Job",
    )
    expect(finding?.message).toContain("Restart this queue runner so it builds the declared steps.")
    // Structured, because the remedy is not a yrd command the prose
    // projection could lift — without it `queue audit` would print "retry".
    expect(finding?.resolution).toEqual(["Restart the habitant queue runner so it builds the steps the base declares."])
  })

  it("treats a changed command revision under an unchanged name as stale, with the stale-definition consequence", () => {
    const finding = installedPlanStale("main", TIP, {
      batchSize: 1,
      steps: [step("typecheck", "tc-v0"), step("affected-tests", "at-v1"), step("merge", "merge-v1")],
    })
    expect(finding?.message).toContain(
      "step 'typecheck' revision 'tc-v1' (main tip bbbbbbbb) vs 'tc-v0' (this process)",
    )
    expect(finding?.message).not.toContain("declared-step-not-installed")
    expect(finding?.message).toContain(
      "the commands they execute and the checks-before-queueing projections come from the step definitions this process built at startup",
    )
    // The step LIST did not move, so the two arrows would have been identical.
    // Printing both opened the live exit-3 notice with
    // `installed A→B→C, but main tip … declares A→B→C` — a contradiction, with
    // the real drift after the colon. It LEADS with what differs instead.
    expect(finding?.message).toMatch(
      /^yrd: step definitions changed on main tip bbbbbbbb \(config blob 22222222\): step 'typecheck' revision/u,
    )
    expect(finding?.message).toContain("this process installed the older ones at boot")
    expect(finding?.message, "no plan arrow when the list is unchanged").not.toContain("typecheck→affected-tests→merge")
  })

  it("keeps both arrows when the step LIST is what moved — there the two plans differ on their face", () => {
    const finding = installedPlanStale("main", TIP, {
      batchSize: 1,
      steps: [step("typecheck", "tc-v1"), step("merge", "merge-v1")],
    })
    expect(finding?.message).toMatch(/^yrd: this process installed typecheck→merge \(batch 1\), but main tip/u)
    expect(finding?.message).not.toContain("step definitions changed on")
  })

  it("keeps both arrows when only the BATCH moved, so the number that changed is visible", () => {
    const finding = installedPlanStale("main", TIP, { batchSize: 4, steps: TIP.steps })
    expect(finding?.message).toContain("installed typecheck→affected-tests→merge (batch 4), but")
    expect(finding?.message).toContain("declares typecheck→affected-tests→merge (batch 1)")
    expect(finding?.message).not.toContain("step definitions changed on")
  })
})

/** The four-check plan main declares, as descriptors, matching the live shape
 * that produced the false finding (item 0). */
const FOUR_CHECK_TIP: DeclaredPlanAt = {
  sha: SHA_B,
  configBlobSha: BLOB_2,
  batchSize: 1,
  steps: [
    step("typecheck", "tc-v1"),
    step("manifest-co-change", "mc-v1"),
    step("substrate-pair", "sp-v1"),
    step("affected-tests", "at-v1"),
    step("merge", "merge-v1"),
  ],
}

/** A merge-only Run whose four checks passed at admission for its own base —
 * the DESIGNED shape of every ordinary merge (PR1946's R3404). */
const MERGE_ONLY_RUN: RecordedRunPlan = {
  run: "R3404",
  startedAt: "2026-08-23T12:13:00.000Z",
  steps: [step("merge", "merge-v1")],
  plan: ["typecheck", "manifest-co-change", "substrate-pair", "affected-tests", "merge"],
  members: [{ id: "PR1946", revision: 1 }],
  source: "declared-at-base",
  authority: "configured",
  baseSha: SHA_B,
  configBlobSha: BLOB_2,
}

const ADMISSION_AT_TIP_BASE: AdmissionLookup = (member, baseSha) =>
  member.id === "PR1946" && member.revision === 1 && baseSha === SHA_B
    ? [
        { name: "typecheck", revision: "tc-v1" },
        { name: "manifest-co-change", revision: "mc-v1" },
        { name: "substrate-pair", revision: "sp-v1" },
        { name: "affected-tests", revision: "at-v1" },
      ]
    : undefined

describe("leg a — a recorded Run against git at its own base sha", () => {
  const declared: DeclaredPlanAt = { sha: SHA_A, configBlobSha: BLOB_1, batchSize: 1, steps: TIP.steps }
  const recorded: RecordedRunPlan = {
    run: "R7",
    startedAt: "2026-08-23T10:00:00.000Z",
    steps: TIP.steps,
    plan: TIP.steps.map((planned) => planned.name),
    members: [{ id: "PR7", revision: 2 }],
    source: "declared-at-base",
    authority: "configured",
    baseSha: SHA_A,
    configBlobSha: BLOB_1,
  }

  it("is silent when the Run executed every declared step itself — the by-construction case", () => {
    expect(runPlanMismatch(recorded, declared)).toBeUndefined()
  })

  it("counts a check the admission stage executed at the Run's base as executed — no finding (item 0)", () => {
    expect(runPlanMismatch(MERGE_ONLY_RUN, { ...FOUR_CHECK_TIP, sha: SHA_B }, ADMISSION_AT_TIP_BASE)).toBeUndefined()
  })

  const carriedRun = (overrides: Record<string, unknown> = {}): RecordedRunPlan => ({
    ...MERGE_ONLY_RUN,
    initialResults: Object.fromEntries(
      ["typecheck", "manifest-co-change", "substrate-pair", "affected-tests"].map((name) => [
        name,
        { exitCode: 0, baseSha: SHA_B, ...overrides },
      ]),
    ),
  })

  it("counts a check the Run's OWN record carries at its base as executed — the derived member, which has no change record", () => {
    // Derived admission persists nothing by design: "a derived member's only
    // durable home stays the `queue/run/started` ChangeSnapshot". The
    // AdmissionLookup is therefore structurally empty, and the run record is
    // the only evidence there is. Reading the lookup alone reported four
    // executed, PASSING checks as "executed in NEITHER stage" on every derived
    // landing (R3578, R3590-R3593).
    expect(runPlanMismatch(carriedRun(), { ...FOUR_CHECK_TIP, sha: SHA_B }, () => undefined)).toBeUndefined()
  })

  it("refuses carried evidence that names another base or did not pass", () => {
    const tip = { ...FOUR_CHECK_TIP, sha: SHA_B }
    // Positive control: the same shape, unmodified, IS credited.
    expect(runPlanMismatch(carriedRun(), tip, () => undefined)).toBeUndefined()
    expect(runPlanMismatch(carriedRun({ baseSha: SHA_A }), tip, () => undefined)?.message).toContain(
      `step 'typecheck' is declared at that base and executed neither in the Run nor at admission for base ${SHA_B.slice(0, 8)}`,
    )
    expect(runPlanMismatch(carriedRun({ exitCode: 1 }), tip, () => undefined)?.code).toBe("run-plan-mismatch")
    expect(runPlanMismatch(carriedRun({ baseSha: undefined }), tip, () => undefined)?.code).toBe("run-plan-mismatch")
  })

  it("prefers admission evidence over carried evidence when both exist", () => {
    // Admission carries a step revision and is revision-checked against git;
    // carried evidence is not. A stale admission revision must still be caught
    // even though the run record also carries a passing result for that step.
    const finding = runPlanMismatch(carriedRun(), { ...FOUR_CHECK_TIP, sha: SHA_B }, (member, baseSha) =>
      ADMISSION_AT_TIP_BASE(member, baseSha)?.map((check) =>
        check.name === "typecheck" ? { ...check, revision: "tc-v0" } : check,
      ),
    )
    expect(finding?.message).toContain(
      "step 'typecheck' executed at admission at revision 'tc-v0', but git at that base derives 'tc-v1'",
    )
  })

  it("finds a check that executed in neither stage, naming the base the admission was required at", () => {
    // The admission that exists was recorded at base X (SHA_B); the Run merged
    // onto base Y (SHA_A) — its members' checks were never proven against Y.
    const runAtOtherBase: RecordedRunPlan = { ...MERGE_ONLY_RUN, baseSha: SHA_A, configBlobSha: BLOB_1 }
    const finding = runPlanMismatch(
      runAtOtherBase,
      { ...FOUR_CHECK_TIP, sha: SHA_A, configBlobSha: BLOB_1 },
      ADMISSION_AT_TIP_BASE,
    )
    expect(finding?.code).toBe("run-plan-mismatch")
    expect(finding?.message).toContain(
      `step 'typecheck' is declared at that base and executed neither in the Run nor at admission for base ${SHA_A.slice(0, 8)}`,
    )
    expect(finding?.message).toContain(
      "every declared check must have executed in the Run or at admission for that base",
    )
  })

  it("names a revision the derivation no longer holds, whichever stage executed the step", () => {
    const finding = runPlanMismatch(
      { ...recorded, steps: [step("typecheck", "tc-v0"), ...TIP.steps.slice(1)] },
      declared,
    )
    expect(finding?.code).toBe("run-plan-mismatch")
    expect(finding?.message).toContain("run R7 (started 2026-08-23T10:00:00.000Z) was judged by the plan")
    expect(finding?.message).toContain(
      "step 'typecheck' executed in the Run at revision 'tc-v0', but git at that base derives 'tc-v1'",
    )
    expect(finding?.resolution).toEqual([
      "Inspect the journal and the repository history: a Run's record must equal the config at its base.",
    ])
    const staleAdmission = runPlanMismatch(MERGE_ONLY_RUN, { ...FOUR_CHECK_TIP, sha: SHA_B }, (member, baseSha) =>
      ADMISSION_AT_TIP_BASE(member, baseSha)?.map((check) =>
        check.name === "typecheck" ? { ...check, revision: "tc-v0" } : check,
      ),
    )
    expect(staleAdmission?.message).toContain(
      "step 'typecheck' executed at admission at revision 'tc-v0', but git at that base derives 'tc-v1'",
    )
  })

  it("finds a judged plan that is not what git derives at that base", () => {
    const finding = runPlanMismatch(
      { ...recorded, plan: ["typecheck", "merge"], steps: [step("typecheck", "tc-v1"), step("merge", "merge-v1")] },
      declared,
    )
    expect(finding?.message).toContain(
      "the judged plan typecheck→merge is not the plan git derives there (typecheck→affected-tests→merge)",
    )
  })

  it("names a blob the repository does not hold at that base even when everything executed", () => {
    const finding = runPlanMismatch({ ...recorded, configBlobSha: BLOB_2 }, declared)
    expect(finding?.code).toBe("run-plan-mismatch")
    expect(finding?.message).toContain(
      `The record names config blob ${BLOB_2.slice(0, 8)}, but git holds blob ${BLOB_1.slice(0, 8)} at that base.`,
    )
  })
})

describe("leg b — the tip against the latest recorded Run, informational", () => {
  const latest: RecordedRunPlan = {
    run: "R9",
    startedAt: "2026-08-23T11:00:00.000Z",
    steps: [step("typecheck", "tc-v1"), step("merge", "merge-v1")],
    plan: ["typecheck", "merge"],
    members: [{ id: "PR9", revision: 1 }],
    source: "declared-at-base",
    baseSha: SHA_A,
    configBlobSha: BLOB_1,
  }

  it("accounts a merge-only Run's checks to the admission stage — never 'did not run' (item 0)", () => {
    expect(tipSinceLatestRun("main", FOUR_CHECK_TIP, MERGE_ONLY_RUN, ADMISSION_AT_TIP_BASE)).toBe(
      `latest run R3404 (base ${SHA_B.slice(0, 8)}, blob ${BLOB_2.slice(0, 8)}) was judged by the plan the tip ` +
        `declares: merge ran in the Run; typecheck, manifest-co-change, substrate-pair, affected-tests ran as ` +
        `checks before queueing for base ${SHA_B.slice(0, 8)}, the Run's base.`,
    )
  })

  it("claims 'config changed' ONLY when the blob differs, and still accounts the run's execution", () => {
    expect(tipSinceLatestRun("main", TIP, latest)).toBe(
      `config changed since run R9 (blob ${BLOB_1.slice(0, 8)} → ${BLOB_2.slice(0, 8)}): step 'affected-tests' is ` +
        `declared at the tip and was not in that run's plan. That run: typecheck, merge ran in the Run. ` +
        `The next run uses the new plan typecheck→affected-tests→merge.`,
    )
  })

  it("distinguishes a byte-only config change from a plan change", () => {
    expect(
      tipSinceLatestRun("main", TIP, {
        ...latest,
        steps: TIP.steps,
        plan: TIP.steps.map((planned) => planned.name),
      }),
    ).toBe(
      `config changed since run R9 (blob ${BLOB_1.slice(0, 8)} → ${BLOB_2.slice(0, 8)}) without changing the ` +
        `declared step names. That run: typecheck, affected-tests, merge ran in the Run. ` +
        `The next run uses the new plan typecheck→affected-tests→merge.`,
    )
  })

  it("flags a step that executed in neither stage instead of blaming the config", () => {
    const line = tipSinceLatestRun("main", FOUR_CHECK_TIP, MERGE_ONLY_RUN, () => undefined)
    expect(line).toContain("typecheck, manifest-co-change, substrate-pair, affected-tests executed in NEITHER stage")
    expect(line).not.toContain("config changed")
  })
})

describe("recent root runs", () => {
  it("takes the newest roots only, carrying each record's plan source and shas", () => {
    const record = (id: string, startedAt: string, extra: Partial<QueueRecord> = {}): QueueRecord =>
      ({
        id,
        queueId: "q",
        candidateId: "C1",
        prs: [],
        base: "main",
        steps: TIP.steps,
        startedAt,
        ...extra,
      }) as unknown as QueueRecord
    const recent = recentRootRuns(
      [
        record("R1", "2026-08-23T09:00:00.000Z"),
        record("R2", "2026-08-23T10:00:00.000Z", {
          stepSelection: {
            authority: "configured",
            source: "declared-at-base",
            baseSha: SHA_A,
            configBlobSha: BLOB_1,
            steps: ["typecheck"],
          },
        }),
        record("R3", "2026-08-23T10:30:00.000Z", { parent: "R2", isolationPart: 0 }),
        record("R4", "2026-08-23T11:00:00.000Z", {
          stepSelection: { authority: "explicit", source: "explicit", steps: ["merge"] },
        }),
      ],
      2,
    )
    expect(recent.map((run) => run.run)).toEqual(["R4", "R2"])
    expect(recent[1]).toMatchObject({ source: "declared-at-base", baseSha: SHA_A, configBlobSha: BLOB_1 })
    expect(recent[0]).toMatchObject({ source: "explicit", authority: "explicit" })
  })
})

describe("the denominator line", () => {
  const comparison: QueueEnvironmentAuditComparison = {
    base: "main",
    tip: {
      sha: SHA_B,
      configAuthority: ".yrd.yml",
      configBlobSha: BLOB_2,
      steps: ["typecheck", "merge"],
      batchSize: 1,
    },
  }

  it("prints an empty journal as zero runs compared against the named tip and blob, never as no drift", () => {
    const text = queueAuditComparisonLine({
      ...comparison,
      installed: { source: "this-process", steps: ["typecheck", "merge"], batchSize: 1 },
      runs: { read: 0, compared: 0, explicit: 0, unrecorded: 0 },
    })
    expect(text).toBe(
      [
        `plan audit: main tip ${SHA_B.slice(0, 8)} declares typecheck→merge (batch 1) from '.yrd.yml' blob ${BLOB_2.slice(0, 8)}.`,
        "plan audit: this process installed typecheck→merge (batch 1); compared against the tip.",
        `plan audit: 0 runs compared against tip ${SHA_B.slice(0, 8)} blob ${BLOB_2.slice(0, 8)} — the journal holds no recorded run.`,
      ].join("\n"),
    )
    expect(text).not.toMatch(/no drift/iu)
  })

  it("prints the legs an invocation could not run as unread, never as a compared zero", () => {
    expect(queueAuditComparisonLine(comparison)).toBe(
      [
        `plan audit: main tip ${SHA_B.slice(0, 8)} declares typecheck→merge (batch 1) from '.yrd.yml' blob ${BLOB_2.slice(0, 8)}.`,
        "plan audit: no installed plan was compared against the tip — this invocation built no queue runtime and read no habitant heartbeat.",
        "plan audit: recorded runs were not read in this invocation, so none was compared against git.",
      ].join("\n"),
    )
    expect(
      queueAuditComparisonLine({
        ...comparison,
        installedUnavailable: "no live habitant runner, so no installed plan was published to compare",
      }),
    ).toContain(
      "plan audit: no installed plan was compared against the tip — no live habitant runner, so no installed plan was published to compare.",
    )
    expect(queueAuditComparisonLine(undefined)).toBe(
      "plan audit: not wired for this invocation — nothing was compared against git.",
    )
  })

  it("names the habitant whose published plan the probe compared", () => {
    expect(
      queueAuditComparisonLine({
        ...comparison,
        installed: { source: "resident-heartbeat", pid: 4242, steps: ["typecheck", "merge"], batchSize: 1 },
      }),
    ).toContain(
      "plan audit: the habitant runner (pid 4242) published installed typecheck→merge (batch 1) in its heartbeat; compared against the tip.",
    )
  })

  it("prints the population it compared and what it could not compare", () => {
    const text = queueAuditComparisonLine({
      ...comparison,
      installed: { source: "this-process", steps: ["typecheck", "merge"], batchSize: 1 },
      runs: {
        read: 5,
        compared: 3,
        explicit: 1,
        unrecorded: 1,
        latest: { run: "R5", baseSha: SHA_A, configBlobSha: BLOB_1, steps: ["typecheck", "merge"] },
        sinceLatest: "config changed since run R5 (blob 11111111 → 22222222): …",
      },
    })
    expect(text).toContain(
      "plan audit: 3 of the 5 most recent runs compared against git at their base shas (1 explicit --steps selection not comparable; 1 pre-23192 record with no plan source).",
    )
    expect(text).toContain("plan audit: config changed since run R5 (blob 11111111 → 22222222): …")
  })
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

const ONE_CHECK = 'base: main\nbatch: 1\nchecks:\n  - {check: {run: "true"}}\n'
const TWO_CHECKS = 'base: main\nbatch: 1\nchecks:\n  - {check: {run: "true"}}\n  - {second: {run: "true"}}\n'

async function queueRepository(config = ONE_CHECK): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-plan-audit-"))
  roots.push(root)
  const repo = join(root, "repo")
  await git(root, "init", "-q", "-b", "main", repo)
  await git(repo, "config", "user.name", "Yrd Test")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await writeFile(join(repo, ".yrd.yml"), config)
  // `createGitPushReceiver` resolves its managed hook entry from the declared
  // main repository and refuses when it has none; the fixture supplies it.
  await mkdir(join(repo, "bin"), { recursive: true })
  await writeFile(join(repo, "bin", "yrd"), "#!/usr/bin/env bun\n")
  await git(repo, "add", ".yrd.yml", "bin/yrd")
  await git(repo, "commit", "-qm", "queue config")
  return repo
}

async function commitConfig(repo: string, config: string, message: string): Promise<string> {
  await writeFile(join(repo, ".yrd.yml"), config)
  await git(repo, "add", ".yrd.yml")
  await git(repo, "commit", "-qm", message)
  return git(repo, "rev-parse", "HEAD")
}

async function featureBranch(repo: string, name: string): Promise<string> {
  await git(repo, "switch", "-qc", name)
  await writeFile(join(repo, `${name.replaceAll("/", "-")}.txt`), `${name}\n`)
  await git(repo, "add", ".")
  await git(repo, "commit", "-qm", name)
  const sha = await git(repo, "rev-parse", "HEAD")
  await git(repo, "switch", "-q", "main")
  return sha
}

describe("the derived plan audit against a real repository", () => {
  it("prints an empty journal as zero runs compared against the tip it read, with the installed leg equal", async () => {
    const repo = await queueRepository()
    const tipSha = await git(repo, "rev-parse", "HEAD")
    const blobSha = await git(repo, "rev-parse", "HEAD:.yrd.yml")
    const host = await createYrdHost({ cwd: repo })
    try {
      const audit = await host.services.queue?.auditEnvironment?.()
      expect(audit?.findings).toEqual([])
      expect(audit?.comparison).toEqual({
        base: "main",
        tip: {
          sha: tipSha,
          configAuthority: ".yrd.yml",
          configBlobSha: blobSha,
          steps: ["check", "merge"],
          batchSize: 1,
        },
        installed: { source: "this-process", steps: ["check", "merge"], batchSize: 1 },
        runs: { read: 0, compared: 0, explicit: 0, unrecorded: 0 },
      })
      expect(queueAuditComparisonLine(audit?.comparison)).toContain(
        `plan audit: 0 runs compared against tip ${tipSha.slice(0, 8)} blob ${blobSha.slice(0, 8)} — the journal holds no recorded run.`,
      )
      // The gate reads the same leg and passes: nothing to reload into.
      await requireInstalledDeclaredPlan(host.services)
    } finally {
      await host.close()
    }
  })

  it("flags a habitant whose installed plan the tip no longer declares, predicts the refusal, and reloads in follow mode", async () => {
    const repo = await queueRepository()
    const habitant = await createYrdHost({ cwd: repo })
    try {
      const tipSha = await commitConfig(repo, TWO_CHECKS, "declare a second check")
      const blobSha = await git(repo, "rev-parse", `${tipSha}:.yrd.yml`)
      const audit = await habitant.services.queue?.auditEnvironment?.({ recordedRuns: 0 })
      expect(audit?.comparison.tip).toEqual({
        sha: tipSha,
        configAuthority: ".yrd.yml",
        configBlobSha: blobSha,
        steps: ["check", "second", "merge"],
        batchSize: 1,
      })
      expect(audit?.comparison.installed).toEqual({ source: "this-process", steps: ["check", "merge"], batchSize: 1 })
      expect(audit?.comparison.runs, "recordedRuns: 0 leaves the journal leg unread, not zero").toBeUndefined()
      expect(audit?.findings).toHaveLength(1)
      const finding = audit?.findings[0]
      expect(finding?.code).toBe("installed-plan-stale")
      expect(finding?.message).toContain(
        `main tip ${tipSha.slice(0, 8)} (config blob ${blobSha.slice(0, 8)}) declares check→second→merge`,
      )
      expect(finding?.message).toContain("step 'second' is declared at the tip but not installed in this process")
      expect(finding?.message).toContain("declared-step-not-installed")

      // One-shot: refuse by code.
      const refusal = await requireInstalledDeclaredPlan(habitant.services).then(
        () => undefined,
        (reason: unknown) => reason,
      )
      expect(failureFact(refusal)?.code).toBe("installed-plan-stale")

      // Follow mode: hand the finding to the process host for the in-place reload.
      const requested: string[] = []
      const reload = await requireInstalledDeclaredPlan(habitant.services, {
        reloadInPlace: {
          request: (stale) => {
            requested.push(stale.code)
            throw new Error("execve replaced the process")
          },
        },
      }).then(
        () => undefined,
        (reason: unknown) => reason,
      )
      expect(requested).toEqual(["installed-plan-stale"])
      expect(reload).toMatchObject({ message: "execve replaced the process" })
    } finally {
      await habitant.close()
    }

    // A process built after the change installs the declared plan: clean.
    const fresh = await createYrdHost({ cwd: repo })
    try {
      const audit = await fresh.services.queue?.auditEnvironment?.()
      expect(audit?.findings).toEqual([])
      expect(audit?.comparison.installed).toEqual({
        source: "this-process",
        steps: ["check", "second", "merge"],
        batchSize: 1,
      })
      await requireInstalledDeclaredPlan(fresh.services)
    } finally {
      await fresh.close()
    }
  })

  it("compares each recorded Run against git at its base and reports the config change since the latest", async () => {
    const repo = await queueRepository()
    const baseSha = await git(repo, "rev-parse", "HEAD")
    const baseBlob = await git(repo, "rev-parse", "HEAD:.yrd.yml")
    const featureSha = await featureBranch(repo, "issue/feature")
    const host = await createYrdHost({ cwd: repo })
    try {
      await host.app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
      const run = (await host.app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 }))[0]
      expect(run).toMatchObject({ status: "completed", conclusion: "success" })
      expect(run?.stepSelection).toMatchObject({
        source: "declared-at-base",
        baseSha,
        configBlobSha: baseBlob,
        steps: ["check", "merge"],
      })

      const before = await host.services.queue?.auditEnvironment?.()
      expect(before?.findings).toEqual([])
      expect(before?.comparison.runs).toMatchObject({
        read: 1,
        compared: 1,
        explicit: 0,
        unrecorded: 0,
        latest: { run: run?.id, baseSha, configBlobSha: baseBlob, steps: ["check", "merge"] },
      })
      expect(before?.comparison.runs?.sinceLatest).toContain("the plan the tip declares")

      // The merge moved main; a config change on top of it is the next tip.
      const tipSha = await commitConfig(repo, TWO_CHECKS, "declare a second check")
      const tipBlob = await git(repo, "rev-parse", `${tipSha}:.yrd.yml`)
      const after = await host.services.queue?.auditEnvironment?.()
      // Leg a still holds: the record is compared at ITS base sha, not the tip.
      expect(after?.findings.map((finding) => finding.code)).toEqual(["installed-plan-stale"])
      expect(after?.comparison.runs).toMatchObject({ read: 1, compared: 1 })
      expect(after?.comparison.runs?.sinceLatest).toBe(
        `config changed since run ${run?.id} (blob ${baseBlob.slice(0, 8)} → ${tipBlob.slice(0, 8)}): ` +
          "step 'second' is declared at the tip and was not in that run's plan. " +
          "That run: check, merge ran in the Run. The next run uses the new plan check→second→merge.",
      )
      const text = queueAuditComparisonLine(after?.comparison)
      expect(text).toContain("plan audit: 1 of the 1 most recent runs compared against git at their base shas.")
      expect(text).toContain(`plan audit: config changed since run ${run?.id}`)
    } finally {
      await host.close()
    }
  })

  it("audits the designed shape clean: checks at admission, then a merge-only Run reusing them (item 0)", async () => {
    const repo = await queueRepository()
    const featureSha = await featureBranch(repo, "issue/feature")
    const host = await createYrdHost({ cwd: repo })
    try {
      await host.app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
      await host.app.bays.requestChecks({ pr: "PR1" })
      // The selectorless drain runs the checks-before-queueing stage first,
      // then the integrating Run reuses that evidence and executes only merge
      // — the exact live shape (PR1946/R3404) the audit misread as "did not
      // run" before this accounting.
      let integrating
      for (let pass = 0; pass < 3 && integrating === undefined; pass += 1) {
        const runs = await host.app.queue.run({}, { runner: "test", leaseMs: 60_000 })
        integrating = runs.find((run) => run.steps.some((step) => step.kind === "merge"))
      }
      expect(integrating).toMatchObject({ status: "completed", conclusion: "success" })
      expect(integrating?.steps.map((step) => step.name)).toEqual(["merge"])
      expect(integrating?.stepSelection).toMatchObject({ source: "declared-at-base", steps: ["check", "merge"] })

      const audit = await host.services.queue?.auditEnvironment?.()
      expect(audit?.findings, JSON.stringify(audit?.findings)).toEqual([])
      const sinceLatest = audit?.comparison.runs?.sinceLatest
      expect(sinceLatest).toContain("was judged by the plan the tip declares")
      expect(sinceLatest).toContain("merge ran in the Run")
      expect(sinceLatest).toContain("check ran as checks before queueing for base")
      expect(sinceLatest).toContain("the Run's base")
      expect(sinceLatest).not.toContain("config changed")
      expect(sinceLatest).not.toContain("did not run")
    } finally {
      await host.close()
    }
  })

  it("leaves an explicit --steps Run out of the comparison and says so in the denominator", async () => {
    const repo = await queueRepository()
    const featureSha = await featureBranch(repo, "issue/feature")
    const host = await createYrdHost({ cwd: repo })
    try {
      await host.app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
      const run = (await host.app.queue.run({ prs: ["PR1"], steps: ["check"] }, { runner: "test", leaseMs: 60_000 }))[0]
      expect(run?.stepSelection).toMatchObject({ source: "explicit", steps: ["check"] })
      const audit = await host.services.queue?.auditEnvironment?.()
      expect(audit?.findings).toEqual([])
      expect(audit?.comparison.runs).toEqual({ read: 1, compared: 0, explicit: 1, unrecorded: 0 })
      expect(queueAuditComparisonLine(audit?.comparison)).toContain(
        "plan audit: 0 of the 1 most recent runs compared against git at their base shas (1 explicit --steps selection not comparable).",
      )
    } finally {
      await host.close()
    }
  })

  it("refuses a recordedRuns that is not a non-negative integer instead of guessing", async () => {
    const repo = await queueRepository()
    const host = await createYrdHost({ cwd: repo })
    try {
      await expect(host.services.queue?.auditEnvironment?.({ recordedRuns: -1 })).rejects.toThrow(
        /recordedRuns must be a non-negative integer/u,
      )
    } finally {
      await host.close()
    }
  })

  it.each([
    ["false", 1],
    ["0", 1],
    ["1", 1],
    ["2", 2],
    ["10", 10],
  ] as const)(
    "keeps configured batch %s equal to the runtime policy %s on both sides of the audit",
    async (configured, effective) => {
      const repo = await queueRepository(`base: main\nbatch: ${configured}\nchecks:\n  - {check: {run: "true"}}\n`)
      const host = await createYrdHost({ cwd: repo })
      try {
        const audit = await host.services.queue?.auditEnvironment?.()
        expect(audit?.findings).toEqual([])
        expect(audit?.comparison.tip.batchSize).toBe(effective)
        expect(audit?.comparison.installed?.batchSize).toBe(effective)
      } finally {
        await host.close()
      }
    },
  )
})

describe("the run gate without a queue administration", () => {
  it("stays a no-op when nothing is wired, and fails loud when administration lacks the audit", async () => {
    await requireInstalledDeclaredPlan({})
    const services: YrdCliServices = { queue: {} }
    await expect(requireInstalledDeclaredPlan(services)).rejects.toThrow(/queue.audit capability is not installed/u)
  })

  it("carries the comparison it read as the refusal's `cause`, for a habitant to redirect without re-auditing", async () => {
    // `failureFact` only sees kind/code/message — it never surfaces `cause`.
    // The habitant follow loop (run.ts `habitantGate`) reads `error.cause`
    // directly to build its designed-exit notice and record without a second
    // `auditEnvironment` call; this pins that the comparison actually rides
    // along, and that the ordinary refusal shape every OTHER caller reads
    // (kind/code/message) is unchanged by carrying it.
    const comparison: QueueEnvironmentAuditComparison = {
      base: "main",
      tip: {
        sha: "b".repeat(40),
        configAuthority: ".yrd.yml",
        configBlobSha: "2".repeat(40),
        steps: ["check", "second", "merge"],
        batchSize: 1,
      },
      installed: { source: "this-process", steps: ["check", "merge"], batchSize: 1 },
    }
    const services: YrdCliServices = {
      queue: {
        auditEnvironment: async () => ({
          findings: [{ code: "installed-plan-stale", message: "yrd: this process installed check→merge …" }],
          comparison,
        }),
      },
    }
    const failure = await requireInstalledDeclaredPlan(services).then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(failureFact(failure)).toMatchObject({ kind: "refusal", code: "installed-plan-stale" })
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).cause).toEqual(comparison)
  })
})

describe("the supervisor probe compares the plan the habitant published", () => {
  /** The probe reads the live habitant's heartbeat; this writes one for a
   * "habitant" whose pid is this test process (alive, no exit marker) and
   * whose installed plan is whatever the caller published. */
  async function publishHeartbeat(repo: string, installedPlan: unknown): Promise<void> {
    const statusPath = join(repo, ".git", "yrd", "resident-runner", "status.json")
    await mkdir(join(statusPath, ".."), { recursive: true })
    await writeFile(
      statusPath,
      `${JSON.stringify({
        pid: process.pid,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        lastTickAt: new Date().toISOString(),
        implementationSource: `git:${"a".repeat(40)}`,
        ...(installedPlan === undefined ? {} : { installedPlan }),
      })}\n`,
    )
  }

  async function probe(repo: string, json: boolean): Promise<Readonly<{ exit: number; stdout: string }>> {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      const exit = await runYrdProcess([
        "/usr/bin/bun",
        "/usr/local/bin/yrd",
        "--repo",
        repo,
        "queue",
        "list",
        "--check",
        ...(json ? ["--json"] : []),
      ])
      return { exit, stdout: stdout.mock.calls.map(([chunk]) => String(chunk)).join("") }
    } finally {
      stdout.mockRestore()
      stderr.mockRestore()
    }
  }

  it("reports installed-plan-stale when the tip declares a step the published set lacks, naming the habitant", async () => {
    const repo = await queueRepository()
    // The plan a habitant built at v1, captured from a real host so the
    // published revisions are the ones the probe derives for that config.
    const v1 = await createYrdHost({ cwd: repo })
    const published = { batchSize: v1.app.queue.state().batchSize, steps: v1.app.queue.steps() }
    await v1.close()
    const tipSha = await commitConfig(repo, TWO_CHECKS, "declare a second check")
    const blobSha = await git(repo, "rev-parse", `${tipSha}:.yrd.yml`)
    await publishHeartbeat(repo, published)

    const json = await probe(repo, true)
    expect(json.exit, json.stdout).toBe(2)
    const payload = JSON.parse(json.stdout) as {
      state: string
      error: { code: string; resolution: string[] }
      facts: { planAudit: QueueEnvironmentAuditComparison }
    }
    expect(payload.state).toBe("unhealthy")
    expect(payload.error.code).toBe("installed-plan-stale")
    expect(payload.error.resolution).toEqual([
      "Restart the habitant queue runner so it builds the steps the base declares.",
    ])
    expect(payload.facts.planAudit).toMatchObject({
      base: "main",
      tip: { sha: tipSha, configBlobSha: blobSha, steps: ["check", "second", "merge"] },
      installed: { source: "resident-heartbeat", pid: process.pid, steps: ["check", "merge"], batchSize: 1 },
    })
    expect(payload.facts.planAudit.runs, "the probe opens no journal").toBeUndefined()

    const human = await probe(repo, false)
    expect(human.exit).toBe(2)
    expect(human.stdout).toContain("err=installed-plan-stale")
    expect(human.stdout).toContain(`the habitant runner (pid ${String(process.pid)}) installed check→merge (batch 1)`)
    expect(human.stdout).toContain("step 'second' is declared at the tip but not installed in the habitant runner")
    // The renderer wraps long lines, so assert the head of the line only.
    expect(human.stdout).toContain(
      `plan audit: the habitant runner (pid ${String(process.pid)}) published installed check→merge (batch 1) in its heartbeat;`,
    )
  })

  it("reports the published set as compared, and an unpublished one as not compared, never as clean", async () => {
    const repo = await queueRepository()
    const host = await createYrdHost({ cwd: repo })
    const published = { batchSize: host.app.queue.state().batchSize, steps: host.app.queue.steps() }
    await host.close()
    await publishHeartbeat(repo, published)

    const compared = await probe(repo, true)
    const payload = JSON.parse(compared.stdout) as {
      state: string
      error?: { code: string }
      facts: { planAudit: QueueEnvironmentAuditComparison }
    }
    expect(payload.error?.code, compared.stdout).not.toBe("installed-plan-stale")
    expect(payload.facts.planAudit.installed).toMatchObject({
      source: "resident-heartbeat",
      pid: process.pid,
      steps: ["check", "merge"],
    })
    expect(queueAuditComparisonLine(payload.facts.planAudit)).toContain(
      `plan audit: the habitant runner (pid ${String(process.pid)}) published installed check→merge (batch 1) in its heartbeat; compared against the tip.`,
    )

    // A habitant older than the field published nothing: the probe says so
    // instead of comparing an empty set and calling it clean.
    await publishHeartbeat(repo, undefined)
    const unpublished = await probe(repo, true)
    const older = JSON.parse(unpublished.stdout) as { facts: { planAudit: QueueEnvironmentAuditComparison } }
    expect(older.facts.planAudit.installed).toBeUndefined()
    expect(older.facts.planAudit.installedUnavailable).toBe(
      `the habitant runner (pid ${String(process.pid)}) published no installed plan — it predates the field; restart it to publish one`,
    )

    // No habitant at all: nothing is published, and the line says that too.
    await rm(join(repo, ".git", "yrd", "resident-runner", "status.json"))
    const absent = await probe(repo, true)
    const none = JSON.parse(absent.stdout) as { facts: { planAudit: QueueEnvironmentAuditComparison } }
    expect(none.facts.planAudit.installedUnavailable).toBe(
      "no live habitant runner, so no installed plan was published to compare",
    )
  })
})
