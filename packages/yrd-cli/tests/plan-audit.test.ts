/**
 * @failure `queue audit` certifies a queue clean without comparing anything — an empty journal or an unwired leg prints the same words as "no drift" — or a resident keeps executing a step set the base tip no longer declares, and neither surface names the shas it read.
 * @level l2
 * @consumer @yrd/cli host
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { InstalledStep, QueueRecord } from "@yrd/queue"
import { failureFact } from "@yrd/core"
import { createLogger } from "loggily"
import { createYrdHost as createYrdHostRaw } from "../src/host.ts"
import { queueAuditComparisonLine, requireInstalledDeclaredPlan } from "../src/run.ts"
import {
  installedPlanStale,
  planDeltas,
  recentRootRuns,
  runPlanMismatch,
  tipSinceLatestRun,
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
    expect(finding?.resolution).toEqual(["Restart the resident queue runner so it builds the steps the base declares."])
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
      "the commands they execute and the admission projections come from the step definitions this process built at startup",
    )
  })
})

describe("leg a — a recorded Run against git at its own base sha", () => {
  const declared: DeclaredPlanAt = { sha: SHA_A, configBlobSha: BLOB_1, batchSize: 1, steps: TIP.steps }
  const recorded: RecordedRunPlan = {
    run: "R7",
    startedAt: "2026-08-23T10:00:00.000Z",
    steps: TIP.steps,
    source: "declared-at-base",
    authority: "configured",
    baseSha: SHA_A,
    configBlobSha: BLOB_1,
  }

  it("is silent when the record equals the derivation — the by-construction case", () => {
    expect(runPlanMismatch(recorded, declared)).toBeUndefined()
  })

  it("names both blob shas and both lists when the same bytes now derive a different plan", () => {
    const finding = runPlanMismatch(
      { ...recorded, steps: [step("typecheck", "tc-v0"), step("merge", "merge-v1")] },
      declared,
    )
    expect(finding?.code).toBe("run-plan-mismatch")
    expect(finding?.message).toContain("run R7 (started 2026-08-23T10:00:00.000Z) recorded the plan typecheck→merge")
    expect(finding?.message).toContain(
      `read from base ${SHA_A.slice(0, 8)}, but git at ${SHA_A.slice(0, 8)} derives typecheck→affected-tests→merge`,
    )
    expect(finding?.message).toContain("step 'typecheck' revision 'tc-v1' (git at base aaaaaaaa) vs 'tc-v0' (run R7)")
    expect(finding?.message).toContain("step 'affected-tests' is declared at that base but the run never executed it")
    expect(finding?.message).toContain(`Both name config blob ${BLOB_1.slice(0, 8)}.`)
    expect(finding?.resolution).toEqual([
      "Inspect the journal and the repository history: a Run's record must equal the config at its base.",
    ])
  })

  it("names a blob the repository does not hold at that base even when the lists agree", () => {
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
    source: "declared-at-base",
    baseSha: SHA_A,
    configBlobSha: BLOB_1,
  }

  it("says the config changed, with both blob shas and the plan the next run uses", () => {
    expect(tipSinceLatestRun("main", TIP, latest)).toBe(
      `config changed since run R9 (blob ${BLOB_1.slice(0, 8)} → ${BLOB_2.slice(0, 8)}): step 'affected-tests' is declared at the tip and did not run in that Run. The next run uses the new plan typecheck→affected-tests→merge.`,
    )
  })

  it("says nothing changed, still with the shas, and distinguishes a byte-only change", () => {
    expect(tipSinceLatestRun("main", TIP, { ...latest, steps: TIP.steps, configBlobSha: BLOB_2 })).toBe(
      `latest run R9 (base ${SHA_A.slice(0, 8)}, blob ${BLOB_2.slice(0, 8)}) ran typecheck→affected-tests→merge, the plan the tip declares.`,
    )
    expect(tipSinceLatestRun("main", TIP, { ...latest, steps: TIP.steps })).toBe(
      `latest run R9 (base ${SHA_A.slice(0, 8)}) ran typecheck→affected-tests→merge; the config blob changed since (${BLOB_1.slice(0, 8)} → ${BLOB_2.slice(0, 8)}) without changing the declared plan.`,
    )
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
      installed: { steps: ["typecheck", "merge"], batchSize: 1 },
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
        "plan audit: this invocation built no queue runtime, so no installed plan was compared against the tip.",
        "plan audit: recorded runs were not read in this invocation, so none was compared against git.",
      ].join("\n"),
    )
    expect(queueAuditComparisonLine(undefined)).toBe(
      "plan audit: not wired for this invocation — nothing was compared against git.",
    )
  })

  it("prints the population it compared and what it could not compare", () => {
    const text = queueAuditComparisonLine({
      ...comparison,
      installed: { steps: ["typecheck", "merge"], batchSize: 1 },
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
        installed: { steps: ["check", "merge"], batchSize: 1 },
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

  it("flags a resident whose installed plan the tip no longer declares, predicts the refusal, and reloads in follow mode", async () => {
    const repo = await queueRepository()
    const resident = await createYrdHost({ cwd: repo })
    try {
      const tipSha = await commitConfig(repo, TWO_CHECKS, "declare a second check")
      const blobSha = await git(repo, "rev-parse", `${tipSha}:.yrd.yml`)
      const audit = await resident.services.queue?.auditEnvironment?.({ recordedRuns: 0 })
      expect(audit?.comparison.tip).toEqual({
        sha: tipSha,
        configAuthority: ".yrd.yml",
        configBlobSha: blobSha,
        steps: ["check", "second", "merge"],
        batchSize: 1,
      })
      expect(audit?.comparison.installed).toEqual({ steps: ["check", "merge"], batchSize: 1 })
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
      const refusal = await requireInstalledDeclaredPlan(resident.services).then(
        () => undefined,
        (reason: unknown) => reason,
      )
      expect(failureFact(refusal)?.code).toBe("installed-plan-stale")

      // Follow mode: hand the finding to the process host for the in-place reload.
      const requested: string[] = []
      const reload = await requireInstalledDeclaredPlan(resident.services, {
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
      await resident.close()
    }

    // A process built after the change installs the declared plan: clean.
    const fresh = await createYrdHost({ cwd: repo })
    try {
      const audit = await fresh.services.queue?.auditEnvironment?.()
      expect(audit?.findings).toEqual([])
      expect(audit?.comparison.installed).toEqual({ steps: ["check", "second", "merge"], batchSize: 1 })
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
          "step 'second' is declared at the tip and did not run in that Run. The next run uses the new plan check→second→merge.",
      )
      const text = queueAuditComparisonLine(after?.comparison)
      expect(text).toContain("plan audit: 1 of the 1 most recent runs compared against git at their base shas.")
      expect(text).toContain(`plan audit: config changed since run ${run?.id}`)
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
})
