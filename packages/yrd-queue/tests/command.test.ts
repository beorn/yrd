/**
 * @failure Git-backed Queue steps can check one candidate and merge another or lose durable command evidence.
 * @level l2
 * @consumer @yrd/queue Git step adapters
 */
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createBayJobDefs, withBays, type BayWorkspace } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs } from "@yrd/job"
import { createProcess, shellCommand, type Process, type ProcessRequest, type ProcessResult } from "@yrd/process"
import * as z from "zod"
import {
  CommandEvidenceSchema,
  GitCheckEvidenceSchema,
  GitCheckResultEvidenceSchema,
  configuredCommandStep,
  configuredMergeStep,
  gitCheckStep,
  gitMergeStep,
  withQueue,
  withMerge,
  withStep,
  type AddStepResult,
  type GitCheckEvidence,
  type GitCheckResultEvidence,
  type PRShape,
  type StepExecution,
} from "@yrd/queue"

const roots: string[] = []
const runtime = { runner: "local", leaseMs: 60_000 }
type Checked = AddStepResult<PRShape, "check", GitCheckResultEvidence>

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(repo: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

async function repository<const Names extends readonly string[]>(
  ...names: Names
): Promise<{ repo: string } & Record<Names[number], string>> {
  const root = await mkdtemp(join(tmpdir(), "yrd-queue-git-"))
  roots.push(root)
  const repo = join(root, "repo")
  await Bun.$`git init -q -b main ${repo}`
  await git(repo, ["config", "user.name", "Yrd Test"])
  await git(repo, ["config", "user.email", "yrd@example.invalid"])
  await writeFile(join(repo, "README.md"), "main\n")
  await git(repo, ["add", "README.md"])
  await git(repo, ["commit", "-qm", "main"])
  const shas: Record<string, string> = {}
  for (const name of names) {
    await git(repo, ["switch", "-qc", `issue/${name}`])
    await writeFile(join(repo, `${name}.txt`), `${name}\n`)
    await git(repo, ["add", `${name}.txt`])
    await git(repo, ["commit", "-qm", name])
    shas[name] = await git(repo, ["rev-parse", "HEAD"])
    await git(repo, ["switch", "-q", "main"])
  }
  return { repo, ...shas } as { repo: string } & Record<Names[number], string>
}

async function hookedSubmoduleRepository(options: {
  baseVersion: string
  candidateVersion: string
  requiredVersion: string
}): Promise<{ repo: string; remote: string; baseSha: string; featureSha: string; moduleSha: string }> {
  const { repo } = await repository()
  const module = join(repo, "..", "module")
  await Bun.$`git init -q -b main ${module}`
  await git(module, ["config", "user.name", "Yrd Test"])
  await git(module, ["config", "user.email", "yrd@example.invalid"])
  await writeFile(join(module, "version.txt"), `${options.baseVersion}\n`)
  await git(module, ["add", "version.txt"])
  await git(module, ["commit", "-qm", "base"])
  await git(repo, ["config", "protocol.file.allow", "always"])
  await git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", module, "dep"])
  await git(repo, ["commit", "-qam", "add dependency"])
  const baseSha = await git(repo, ["rev-parse", "HEAD"])

  await writeFile(join(module, "version.txt"), `${options.candidateVersion}\n`)
  await git(module, ["commit", "-qam", "candidate"])
  const moduleSha = await git(module, ["rev-parse", "HEAD"])
  await git(repo, ["switch", "-qc", "issue/feature"])
  await git(join(repo, "dep"), ["fetch", "-q", "origin"])
  await git(join(repo, "dep"), ["checkout", "-q", moduleSha])
  await writeFile(join(repo, "feature.txt"), "feature\n")
  await git(repo, ["add", "dep", "feature.txt"])
  await git(repo, ["commit", "-qm", "feature"])
  const featureSha = await git(repo, ["rev-parse", "HEAD"])
  await git(repo, ["switch", "-q", "main"])
  await git(repo, ["submodule", "update", "--init", "--recursive"])

  const remote = join(repo, "..", "origin.git")
  await Bun.$`git init -q --bare ${remote}`
  await git(repo, ["remote", "add", "origin", remote])
  await git(repo, ["push", "-q", "origin", "main", "issue/feature"])
  const hook = join(repo, ".git", "hooks", "pre-push")
  await writeFile(
    hook,
    `#!/bin/sh\nroot=$(git rev-parse --show-toplevel)\ntest "$(cat "$root/dep/version.txt")" = ${options.requiredVersion}\n`,
  )
  await chmod(hook, 0o755)
  return { repo, remote, baseSha, featureSha, moduleSha }
}

const unusedWorkspace: BayWorkspace = {
  revision: "unused-workspace-v1",
  provision: () => ({ status: "failed", error: { code: "unused", message: "not used" } }),
  refresh: () => ({ status: "failed", error: { code: "unused", message: "not used" } }),
  deprovision: () => ({ status: "passed", output: {} }),
}

async function checkedQueue(
  process: Pick<Process, "run">,
  repo: string,
  command: readonly string[],
  options: Readonly<{
    batch?: number
    waiting?: boolean
    checkoutParent?: string
    classification?: "base" | "carrier"
  }> = {},
) {
  const bayJobs = createBayJobDefs(unusedWorkspace)
  const check = withStep(
    "check",
    gitCheckStep({
      inject: { process },
      repo,
      command,
      ...(options.classification === undefined ? {} : { classification: options.classification }),
      ...(options.waiting ? { runner: "waiting" as const } : {}),
      ...(options.checkoutParent === undefined ? {} : { checkoutParent: options.checkoutParent }),
    }),
    {
      revision: `check:${JSON.stringify(command)}:${options.waiting === true}`,
      output: GitCheckResultEvidenceSchema,
      ...(options.classification === undefined ? {} : { classification: options.classification }),
    },
  )
  const merge = withMerge(gitMergeStep<Checked>({ inject: { process }, repo }), { revision: "git-merge-v1" })
  const queue = withQueue({ steps: [check, merge] as const, batch: options.batch ?? 1 })
  const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
  return createYrd(queue(base), { inject: { journal: createMemoryJournal() } })
}

async function expectLanded(repo: string, evidence: GitCheckEvidence): Promise<void> {
  expect(await git(repo, ["rev-parse", "main"])).toBe(evidence.candidateSha)
  expect(await git(repo, ["rev-parse", evidence.candidateRef])).toBe(evidence.candidateSha)
}

function expectedCandidateRef(run: string, step: string, job: string, attempt: number, sha: string): string {
  const identity = createHash("sha256")
    .update(job)
    .update("\0")
    .update(String(attempt))
    .update("\0")
    .update(sha)
    .digest("hex")
  return `refs/yrd/candidates/${run}/${step}/attempt-${attempt}-${identity}`
}

describe("Queue command adapters", () => {
  it("renews one runner lease only on child progress and recovers a stalled child without merge", async () => {
    type CheckedCommand = AddStepResult<PRShape, "check", z.infer<typeof CommandEvidenceSchema>>
    const encoder = new TextEncoder()

    const controlledQueue = async () => {
      const cwd = await mkdtemp(join(tmpdir(), "yrd-command-lease-"))
      roots.push(cwd)
      const started = Promise.withResolvers<ProcessRequest>()
      const completed = Promise.withResolvers<ProcessResult>()
      const aborted = Promise.withResolvers<void>()
      const mergeRuns: string[] = []
      const process: Pick<Process, "run"> = {
        run(request) {
          request.signal?.addEventListener("abort", () => aborted.resolve(), { once: true })
          started.resolve(request)
          return completed.promise
        },
      }
      const bayJobs = createBayJobDefs(unusedWorkspace)
      const check = withStep(
        "check",
        configuredCommandStep<PRShape>({
          inject: { process },
          command: ["progressing-check"],
          cwd,
          purpose: "check",
          artifactRoot: join(cwd, "artifacts"),
        }),
        { revision: "progressing-check-v1", output: CommandEvidenceSchema },
      )
      const merge = withMerge(
        (_input: StepExecution<CheckedCommand>) => {
          mergeRuns.push("merge")
          return { status: "passed" as const, output: { commit: "b".repeat(40), baseSha: "b".repeat(40) } }
        },
        { revision: "merge-v1" },
      )
      const queue = withQueue({ steps: [check, merge] as const })
      const base = pipe(
        createYrdDef(),
        withJobs({ definitions: [bayJobs, queue.jobDefs] }),
        withBays({ jobs: bayJobs }),
      )
      const app = await createYrd(queue(base), { inject: { journal: createMemoryJournal() } })
      await app.bays.submit({ branch: "issue/progress", headSha: "a".repeat(40), base: "main" })
      return { aborted, app, completed, mergeRuns, started, [Symbol.asyncDispose]: () => app.close() }
    }

    const result = (stdout: string): ProcessResult => ({
      exitCode: 0,
      signal: null,
      stdout,
      stderr: "",
      durationMs: 60,
      timedOut: false,
    })
    await using progressing = await controlledQueue()
    const progressingRun = progressing.app.queue.run(
      { prs: ["PR1"] },
      { runner: "same-runner", leaseMs: 120, heartbeatMs: 30 },
    )
    const progressingRequest = await progressing.started.promise
    for (let tick = 1; tick <= 8; tick += 1) {
      progressingRequest.onOutput?.({ stream: "stdout", chunk: encoder.encode(`progress ${tick}\n`) })
      await Bun.sleep(20)
    }

    expect(await progressing.app.jobs.recover({ now: new Date().toISOString() })).toEqual([])
    progressing.completed.resolve(result("progress complete\n"))
    await expect(progressingRun).resolves.toEqual([
      expect.objectContaining({
        status: "passed",
        steps: expect.arrayContaining([expect.objectContaining({ name: "merge" })]),
      }),
    ])
    const heartbeatLeases = (await Array.fromAsync(progressing.app.events()))
      .filter(({ name }) => name === "job/transitioned")
      .map(({ data }) => data as { type?: string; leaseExpiresAt?: string })
      .filter(({ type }) => type === "heartbeat")
      .map(({ leaseExpiresAt }) => leaseExpiresAt)
    expect(heartbeatLeases.length).toBeGreaterThan(1)
    expect(progressing.mergeRuns).toEqual(["merge"])

    await using stalled = await controlledQueue()
    const stalledRun = stalled.app.queue.run({ prs: ["PR1"] }, { runner: "same-runner", leaseMs: 80, heartbeatMs: 20 })
    await stalled.started.promise
    await Bun.sleep(120)
    const recovered = await stalled.app.queue.recover({
      recoveryTime: new Date().toISOString(),
    })
    const ownershipAborted = await Promise.race([
      stalled.aborted.promise.then(() => true),
      Bun.sleep(250).then(() => false),
    ])
    stalled.completed.resolve(result("too late\n"))
    await stalledRun

    expect(ownershipAborted).toBe(true)
    expect(recovered).toEqual([
      expect.objectContaining({
        status: "failed",
        steps: [expect.objectContaining({ job: expect.objectContaining({ status: "lost" }) }), expect.anything()],
      }),
    ])
    expect(stalled.mergeRuns).toEqual([])
  })

  it("persists candidate-conflict evidence on the causative check step before scratch cleanup", async () => {
    const { repo } = await repository()
    await writeFile(join(repo, "conflict.txt"), "base\n")
    await git(repo, ["add", "conflict.txt"])
    await git(repo, ["commit", "-qm", "conflict base"])
    await git(repo, ["switch", "-qc", "issue/conflict"])
    await writeFile(join(repo, "conflict.txt"), "feature\n")
    await git(repo, ["commit", "-qam", "conflicting feature"])
    const featureSha = await git(repo, ["rev-parse", "HEAD"])
    await git(repo, ["switch", "-q", "main"])
    await writeFile(join(repo, "conflict.txt"), "main\n")
    await git(repo, ["commit", "-qam", "conflicting main"])

    const artifactRoot = join(repo, ".git", "yrd", "artifacts")
    await using process = createProcess()
    const outcome = await gitCheckStep({
      inject: { process },
      repo,
      command: ["true"],
      artifactRoot,
    })(
      {
        run: "R1",
        step: "check",
        index: 0,
        prs: [{ id: "PR1", branch: "issue/conflict", base: "main", revision: 1, headSha: featureSha }],
        shape: { results: {} },
      },
      { id: "J1", attempt: 1, runner: "test", signal: new AbortController().signal },
    )

    expect(outcome).toMatchObject({ status: "failed", error: { code: "candidate-conflict" } })
    if (outcome.status !== "failed") return
    const artifacts = (outcome.output as { artifacts?: readonly { name: string; path: string }[] } | undefined)
      ?.artifacts
    expect(artifacts).toEqual([
      expect.objectContaining({
        path: expect.stringMatching(/\/R1\/0-check\/attempt-1\/(?:stdout|stderr)\.log$/u),
      }),
    ])
    const artifact = artifacts?.[0]
    expect(artifact === undefined ? false : existsSync(artifact.path)).toBe(true)
    expect(artifact === undefined ? "" : await readFile(artifact.path, "utf8")).toContain("CONFLICT")
  })

  it("executes argv directly and requires an explicit gate for shell text", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "yrd-command-argv-"))
    roots.push(cwd)
    const requests: ProcessRequest[] = []
    const process: Pick<Process, "run"> = {
      run(request) {
        requests.push(request)
        return Promise.resolve({
          exitCode: 0,
          signal: null,
          stdout: "ok",
          stderr: "",
          durationMs: 1,
          timedOut: false,
        })
      },
    }
    const input = {
      run: "R1",
      step: "check",
      index: 0,
      prs: [{ id: "PR1", branch: "issue/feature", base: "main", revision: 1, headSha: "a".repeat(40) }],
      shape: { results: {} },
    } as StepExecution<PRShape>
    const context = { id: "J1", attempt: 1, runner: "test", signal: new AbortController().signal }

    expect(() =>
      configuredCommandStep<PRShape>({
        inject: { process },
        command: "printf unsafe" as never,
        cwd,
        purpose: "check",
      }),
    ).toThrow("shellCommand")

    const direct = configuredCommandStep<PRShape>({
      inject: { process },
      command: ["printf", "%s", "literal;$(not-expanded)"],
      cwd,
      purpose: "check",
    })
    const explicitShell = configuredCommandStep<PRShape>({
      inject: { process },
      command: shellCommand("printf shell"),
      cwd,
      purpose: "check",
    })

    await direct(input, context)
    await explicitShell(input, context)
    expect(requests.map((request) => request.argv)).toEqual([
      ["printf", "%s", "literal;$(not-expanded)"],
      ["sh", "-c", "printf shell"],
    ])
    expect(requests.map((request) => request.noProgressTimeoutMs)).toEqual([undefined, undefined])
  })

  it.each([
    {
      name: "nonzero exit",
      process: {
        exitCode: 17,
        signal: null,
        stdout: "[yrd-base-health] base aaaaaaaaaaaa green\n",
        stderr: `src/index.ts(12,4): error TS2322: Type 'string' is not assignable\n M src/formatted.ts\n${"x".repeat(2_100)}`,
        durationMs: 321,
        timedOut: false,
      } satisfies ProcessResult,
      error: { code: "check-failed", message: "check command exited 17" },
      verdict: undefined,
    },
    {
      name: "stalled process",
      process: {
        exitCode: 137,
        signal: "SIGKILL" as const,
        stdout: "partial output\n",
        stderr: "stalled stderr\n",
        durationMs: 120_123,
        timedOut: false,
        stalled: true,
        verdict: "STALLED" as const,
        lastProgressAtMs: 17_500,
        lastProgressBytes: 42,
      } satisfies ProcessResult,
      error: { code: "check-stalled", message: "check stalled after 120000ms without progress" },
      verdict: "STALLED",
    },
  ])(
    "keeps $name errors concise while retaining durable command evidence",
    async ({ process: result, error, verdict }) => {
      const cwd = await mkdtemp(join(tmpdir(), "yrd-command-failure-"))
      roots.push(cwd)
      const step = configuredCommandStep<PRShape>({
        inject: { process: { run: () => Promise.resolve(result) } },
        command: ["false"],
        cwd,
        purpose: "check",
        ...(verdict === undefined ? {} : { noProgressTimeoutMs: 120_000 }),
      })
      const outcome = await step(
        {
          run: "R1",
          step: "check",
          index: 0,
          prs: [{ id: "PR1", branch: "issue/feature", base: "main", revision: 1, headSha: "a".repeat(40) }],
          shape: { results: {} },
        },
        { id: "J1", attempt: 1, runner: "test", signal: new AbortController().signal },
      )

      expect(outcome).toMatchObject({ status: "failed", error })
      if (outcome.status !== "failed") throw new Error(`configured command was ${outcome.status}`)
      const evidence = CommandEvidenceSchema.parse(outcome.output)
      expect(evidence).toMatchObject({
        command: ["false"],
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        artifacts: [{ name: "stdout" }, { name: "stderr" }],
        ...(verdict === undefined ? {} : { stageVerdict: verdict }),
      })
      if (verdict === undefined) {
        expect(evidence.detail).toContain("[yrd-base-health]")
        expect(evidence.diagnostics).toEqual([
          { file: "src/index.ts", line: 12, column: 4, message: "error TS2322: Type 'string' is not assignable" },
          { file: "src/formatted.ts", line: 1, message: "working tree changed during check" },
        ])
      }
      expect(evidence.artifacts.every((artifact) => existsSync(artifact.path))).toBe(true)
      expect(outcome.error.message).not.toContain(evidence.detail ?? "")
      expect(outcome.error.message).not.toContain(cwd)
    },
  )

  it("retains failed configured-check output after Git candidate wrapping", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const baseSha = await git(repo, ["rev-parse", "main"])
    await using process = createProcess()
    await using app = await checkedQueue(
      process,
      repo,
      shellCommand("printf 'check stdout\\n'; printf 'check stderr\\n' >&2; exit 17"),
    )
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
    if (run === undefined) throw new Error("missing integration run")
    expect(run).toMatchObject({ status: "failed", error: { code: "check-failed" } })
    const job = run.steps[0]?.job
    if (job?.status !== "failed") throw new Error("check did not fail")
    const evidence = GitCheckEvidenceSchema.parse(job.output)
    expect(evidence).toMatchObject({
      exitCode: 17,
      baseSha,
      candidateRef: expectedCandidateRef("R1", "check", job.id, job.attempt, evidence.candidateSha),
      artifacts: [{ name: "stdout" }, { name: "stderr" }],
    })
    expect(evidence.candidateSha).toHaveLength(40)
    const artifacts = new Map(evidence.artifacts.map((artifact) => [artifact.name, artifact.path]))
    const stdoutArtifact = artifacts.get("stdout")
    const stderrArtifact = artifacts.get("stderr")
    if (stdoutArtifact === undefined || stderrArtifact === undefined) throw new Error("missing command artifacts")
    expect(await readFile(stdoutArtifact, "utf8")).toBe("check stdout\n")
    expect(await readFile(stderrArtifact, "utf8")).toBe("check stderr\n")
  })

  it("preserves a legacy R1 attempt ref when an empty journal reuses the display run id", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const baseSha = await git(repo, ["rev-parse", "main"])
    const legacyRef = "refs/yrd/candidates/R1/check/attempt-1"
    await git(repo, ["update-ref", legacyRef, baseSha])
    await using process = createProcess()
    await using app = await checkedQueue(process, repo, ["test", "-f", "feature.txt"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
    expect(run).toMatchObject({ id: "R1", status: "passed" })
    const job = run?.steps[0]?.job
    if (job?.status !== "passed") throw new Error("check did not pass")
    const evidence = GitCheckEvidenceSchema.parse(job.output)

    expect(evidence.candidateRef).toBe(expectedCandidateRef("R1", "check", job.id, job.attempt, evidence.candidateSha))
    expect(await git(repo, ["rev-parse", legacyRef])).toBe(baseSha)
    expect(await git(repo, ["rev-parse", evidence.candidateRef])).toBe(evidence.candidateSha)
    expect(app.state().bays.prs.PR1).toMatchObject({ status: "integrated", headSha: featureSha })
  })

  it("preserves an occupied derived candidate ref and publishes the candidate under a fresh identity", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const occupiedSha = await git(repo, ["rev-parse", "main"])
    await using process = createProcess()
    let occupiedRef: string | undefined
    const racingProcess: Pick<Process, "run"> = {
      async run(request) {
        if (
          occupiedRef === undefined &&
          request.argv[0] === "git" &&
          request.argv[3] === "update-ref" &&
          request.argv[4] === "--create-reflog" &&
          request.argv[5]?.startsWith("refs/yrd/candidates/")
        ) {
          occupiedRef = request.argv[5]
          await git(repo, ["update-ref", occupiedRef, occupiedSha])
        }
        return process.run(request)
      },
    }
    await using app = await checkedQueue(racingProcess, repo, ["test", "-f", "feature.txt"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
    expect(run).toMatchObject({ id: "R1", status: "passed" })
    const job = run?.steps[0]?.job
    if (job?.status !== "passed") throw new Error("check did not pass")
    const evidence = GitCheckEvidenceSchema.parse(job.output)
    if (occupiedRef === undefined) throw new Error("candidate publication was not intercepted")

    expect(evidence.candidateRef).not.toBe(occupiedRef)
    expect(await git(repo, ["rev-parse", occupiedRef])).toBe(occupiedSha)
    expect(await git(repo, ["rev-parse", evidence.candidateRef])).toBe(evidence.candidateSha)
    expect(app.state().bays.prs.PR1).toMatchObject({ status: "integrated", headSha: featureSha })
  })

  it("refuses bounded candidate ref exhaustion without rejecting or moving the submitted payload", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const occupiedSha = await git(repo, ["rev-parse", "main"])
    await using process = createProcess()
    const occupiedRefs: string[] = []
    const hostileProcess: Pick<Process, "run"> = {
      async run(request) {
        const ref = request.argv[5]
        if (
          request.argv[0] === "git" &&
          request.argv[3] === "update-ref" &&
          request.argv[4] === "--create-reflog" &&
          ref?.startsWith("refs/yrd/candidates/")
        ) {
          occupiedRefs.push(ref)
          await git(repo, ["update-ref", ref, occupiedSha])
        }
        return process.run(request)
      },
    }
    await using app = await checkedQueue(hostileProcess, repo, ["test", "-f", "feature.txt"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]
    expect(run).toMatchObject({ id: "R1", status: "waiting" })
    const job = run?.steps[0]?.job
    expect(job).toMatchObject({
      status: "waiting",
      token: expect.stringMatching(/^candidate-ref-refused:/u),
      detail: expect.stringContaining("collision identities"),
    })
    expect(occupiedRefs).toHaveLength(33)
    for (const ref of occupiedRefs) expect(await git(repo, ["rev-parse", ref])).toBe(occupiedSha)
    expect(app.state().bays.prs.PR1).toMatchObject({ status: "submitted", headSha: featureSha })
  })

  it("lands the exact audited candidate and its durable artifacts", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    await using app = await checkedQueue(
      process,
      repo,
      shellCommand('git config user.name "Changed After Check" && test -f feature.txt && echo checked'),
    )
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!
    expect(run.status).toBe("passed")
    expect(await readFile(join(repo, "feature.txt"), "utf8")).toBe("feature\n")
    expect(await git(repo, ["status", "--porcelain"])).toBe("")

    const job = run.steps[0]?.job
    if (job?.status !== "passed") throw new Error("check did not pass")
    const evidence = GitCheckEvidenceSchema.parse(job.output)
    await expectLanded(repo, evidence)
    expect(evidence.exitCode).toBe(0)
    expect(await readFile(evidence.artifacts[0]!.path, "utf8")).toBe("checked\n")
  })

  it("retains configured-command evidence when the Git check wrapper fails", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    await using app = await checkedQueue(
      process,
      repo,
      shellCommand(
        'printf "[yrd-base-health] base aaaaaaaaaaaa is red: test:fast failed\\n"; ' +
          'printf "src/model.ts:12:4 - error TS2322: type mismatch\\n" >&2; exit 17',
      ),
      { classification: "base" },
    )
    await app.bays.submit({ branch: "task/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!
    expect(run.status).toBe("failed")
    const job = run.steps[0]?.job
    if (job?.status !== "failed") throw new Error("check did not fail")
    const evidence = GitCheckEvidenceSchema.parse(job.output)
    expect(evidence).toMatchObject({
      command: ["sh", "-c", expect.stringContaining("test:fast failed")],
      exitCode: 17,
      classification: "base",
      diagnostics: [{ file: "src/model.ts", line: 12, column: 4, message: "error TS2322: type mismatch" }],
      baseSha: expect.stringMatching(/^[0-9a-f]{40}$/u),
      candidateSha: expect.stringMatching(/^[0-9a-f]{40}$/u),
      candidateRef: expect.stringContaining("refs/yrd/candidates/"),
    })
    expect(evidence.detail).toContain("[yrd-base-health]")
    expect(evidence.artifacts.every((artifact) => existsSync(artifact.path))).toBe(true)
  })

  it("lands from origin when the base has no local branch without moving detached HEAD", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const baseSha = await git(repo, ["rev-parse", "main"])
    await git(repo, ["update-ref", "refs/remotes/origin/main", baseSha])
    await git(repo, ["switch", "-q", "--detach", featureSha])
    await git(repo, ["branch", "-D", "main"])
    await using process = createProcess()
    await using app = await checkedQueue(process, repo, ["test", "-f", "feature.txt"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run.status).toBe("passed")
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(featureSha)
    expect(await git(repo, ["rev-parse", "refs/remotes/origin/main"])).toBe(baseSha)
    const job = run.steps[0]?.job
    if (job?.status !== "passed") throw new Error("check did not pass")
    await expectLanded(repo, GitCheckEvidenceSchema.parse(job.output))
  })

  it("drains from the authoritative queue base without touching dirty behind operator main", async () => {
    const branches = ["pr4", "pr5", "pr6", "pr7"] as const
    const { repo, pr4, pr5, pr6, pr7 } = await repository(...branches)
    const heads = { pr4, pr5, pr6, pr7 }
    const remote = join(repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", ...branches.map((branch) => `issue/${branch}`)])
    await git(repo, ["switch", "-qc", "issue/remote-main"])
    await writeFile(join(repo, "remote-main.txt"), "authoritative\n")
    await git(repo, ["add", "remote-main.txt"])
    await git(repo, ["commit", "-qm", "remote main"])
    const initialQueueBase = await git(repo, ["rev-parse", "HEAD"])
    await git(repo, ["push", "-q", "origin", "HEAD:main"])
    await git(repo, ["switch", "-q", "main"])
    const sentinel = join(repo, "operator-wip.txt")
    await writeFile(sentinel, "preserve these bytes\n")
    await using process = createProcess()
    await using app = await checkedQueue(process, repo, ["true"])
    for (const branch of branches) {
      await app.bays.submit({ branch: `issue/${branch}`, headSha: heads[branch], base: "main" })
    }
    const operatorSnapshot = async () => ({
      headSha: await git(repo, ["rev-parse", "--verify", "HEAD"]),
      headIdentityState: await git(repo, ["status", "--porcelain=v2", "--branch", "--untracked-files=no"]),
      status: await git(repo, ["status", "--porcelain", "--untracked-files=all"]),
      sentinelBytes: await readFile(sentinel, "utf8"),
    })
    const operatorBefore = await operatorSnapshot()
    expect(operatorBefore.headIdentityState).toContain("# branch.head main")
    expect(operatorBefore.status).toBe("?? operator-wip.txt")
    expect(operatorBefore.sentinelBytes).toBe("preserve these bytes\n")

    const runs = await app.queue.run({ prs: [] }, runtime)

    expect(runs).toHaveLength(branches.length)
    expect(runs.map((run) => [run.status, run.error?.code])).toEqual([
      ["passed", undefined],
      ["passed", undefined],
      ["passed", undefined],
      ["passed", undefined],
    ])
    expect(
      runs.flatMap((run) => run.steps.map((step) => step.job?.attempt)).filter((attempt) => attempt !== undefined),
    ).toEqual(Array.from({ length: branches.length * 2 }, () => 1))
    const checks = runs.map((run) => {
      const job = run.steps[0]?.job
      if (job?.status !== "passed") throw new Error(`run '${run.id}' check did not pass`)
      return GitCheckEvidenceSchema.parse(job.output)
    })
    expect(checks[0]?.baseSha).toBe(initialQueueBase)
    for (let index = 1; index < runs.length; index += 1) {
      expect(checks[index]?.baseSha).toBe(runs[index - 1]?.integration?.commit)
    }
    const finalLanding = runs.at(-1)?.integration?.commit
    expect(finalLanding).toBeDefined()
    expect(await git(remote, ["rev-parse", "main"])).toBe(finalLanding)
    expect(await git(repo, ["rev-parse", "refs/remotes/origin/main"])).toBe(finalLanding)
    expect(await operatorSnapshot()).toEqual(operatorBefore)
  }, 15_000)

  it("refreshes authoritative remote base divergence and evaluates the unchanged payload", async () => {
    const { repo, feature: featureSha, competing: remoteBaseSha } = await repository("feature", "competing")
    const localBaseSha = await git(repo, ["rev-parse", "main"])
    const remote = join(repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", "issue/feature", "issue/competing"])
    await git(repo, ["push", "-q", "origin", `${remoteBaseSha}:refs/heads/main`])
    await using process = createProcess()
    await using app = await checkedQueue(process, repo, ["test", "-f", "feature.txt"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({ status: "passed", prs: [{ id: "PR1", revision: 1, headSha: featureSha }] })
    const job = run.steps[0]?.job
    if (job?.status !== "passed") throw new Error("check did not pass")
    expect(GitCheckEvidenceSchema.parse(job.output).baseSha).toBe(remoteBaseSha)
    expect(await git(repo, ["rev-parse", "main"])).toBe(localBaseSha)
    expect(app.state().bays.prs.PR1).toMatchObject({ revision: 1, headSha: featureSha, status: "integrated" })
  })

  it("retries authoritative refresh at most three times without changing the PR payload", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const remote = join(repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", "issue/feature"])
    await using process = createProcess()
    let recoveryAttempts = 0
    let recovered = false
    const flakyProcess: Pick<Process, "run"> = {
      run(request) {
        const refresh = request.argv[0] === "git" && request.argv.includes("fetch")
        if (refresh && !recovered) {
          recoveryAttempts += 1
          if (recoveryAttempts < 3) {
            return Promise.resolve({
              exitCode: 1,
              signal: null,
              stdout: "",
              stderr: "temporary origin failure",
              durationMs: 1,
              timedOut: false,
            })
          }
          recovered = true
        }
        return process.run(request)
      },
    }
    await using app = await checkedQueue(flakyProcess, repo, ["test", "-f", "feature.txt"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(recoveryAttempts).toBe(3)
    expect(run).toMatchObject({ status: "passed", prs: [{ id: "PR1", revision: 1, headSha: featureSha }] })
    expect(app.state().bays.prs.PR1).toMatchObject({ revision: 1, headSha: featureSha, status: "integrated" })
  })

  it("records exhausted authority refresh as an environment refusal without rejecting the author", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const remote = join(repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", "issue/feature"])
    await using process = createProcess()
    let refreshAttempts = 0
    const unavailableOrigin: Pick<Process, "run"> = {
      run(request) {
        if (request.argv[0] === "git" && request.argv.includes("fetch")) {
          refreshAttempts += 1
          return Promise.resolve({
            exitCode: 1,
            signal: null,
            stdout: "",
            stderr: "origin unavailable",
            durationMs: 1,
            timedOut: false,
          })
        }
        return process.run(request)
      },
    }
    await using app = await checkedQueue(unavailableOrigin, repo, ["test", "-f", "feature.txt"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(refreshAttempts).toBe(3)
    expect(run).toMatchObject({ status: "failed", error: { code: "queue-environment-refused" } })
    expect(run.steps[0]?.job).toMatchObject({
      status: "failed",
      output: { kind: "queue-authority-refusal", base: "main", remote: "origin", attempts: 3 },
    })
    expect(app.state().bays.prs.PR1).toMatchObject({ revision: 1, headSha: featureSha, status: "submitted" })
    expect(await git(repo, ["for-each-ref", "--format=%(refname)", "refs/yrd/candidates"])).toBe("")
  })

  it("keeps the submitted payload when native merge cannot refresh post-push authority", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const remote = join(repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", "issue/feature"])
    await using process = createProcess()
    let successfulRefreshes = 0
    let refusalAttempts = 0
    const unavailableAfterPush: Pick<Process, "run"> = {
      run(request) {
        if (request.argv[0] === "git" && request.argv.includes("fetch")) {
          if (successfulRefreshes < 2) {
            successfulRefreshes += 1
            return process.run(request)
          }
          refusalAttempts += 1
          return Promise.resolve({
            exitCode: 1,
            signal: null,
            stdout: "",
            stderr: "origin unavailable after native push",
            durationMs: 1,
            timedOut: false,
          })
        }
        return process.run(request)
      },
    }
    await using app = await checkedQueue(unavailableAfterPush, repo, ["test", "-f", "feature.txt"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!
    const checkJob = run.steps[0]?.job
    if (checkJob?.status !== "passed") throw new Error("check did not pass")
    const checked = GitCheckEvidenceSchema.parse(checkJob.output)

    expect(successfulRefreshes).toBe(2)
    expect(refusalAttempts).toBe(3)
    expect(run).toMatchObject({
      status: "failed",
      error: { code: "queue-environment-refused", message: expect.stringContaining("after 3 attempts") },
      prs: [{ id: "PR1", revision: 1, headSha: featureSha }],
    })
    expect(run.steps[1]?.job).toMatchObject({
      status: "failed",
      error: { code: "queue-environment-refused", message: expect.stringContaining("after 3 attempts") },
    })
    expect(await git(remote, ["rev-parse", "main"])).toBe(checked.candidateSha)
    expect(app.state().bays.prs.PR1).toMatchObject({ revision: 1, headSha: featureSha, status: "submitted" })
  })

  it("materializes candidate checks under the injected trusted parent", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const parentRoot = await mkdtemp(join(tmpdir(), "yrd-queue-checkouts-"))
    const checkoutParent = join(parentRoot, "nested")
    roots.push(parentRoot)
    await using process = createProcess()
    await using app = await checkedQueue(process, repo, ["pwd"], { checkoutParent })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!
    const job = run.steps[0]?.job
    if (job?.status !== "passed") throw new Error("check did not pass")
    const evidence = GitCheckEvidenceSchema.parse(job.output)
    expect(await readFile(evidence.artifacts[0]!.path, "utf8")).toMatch(
      new RegExp(`^${await realpath(checkoutParent)}/yrd-queue-`),
    )
  })

  it("fails the check when its detached scratch worktree cannot be removed", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    const cleanupFailure: ProcessResult = {
      exitCode: 1,
      signal: null,
      stdout: "",
      stderr: "cleanup denied",
      durationMs: 1,
      timedOut: false,
    }
    const guarded = {
      run(request: Parameters<Process["run"]>[0]) {
        return request.argv.includes("remove") && request.argv.includes("worktree")
          ? Promise.resolve(cleanupFailure)
          : process.run(request)
      },
    }
    await using app = await checkedQueue(guarded, repo, ["test", "-f", "feature.txt"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!
    expect(run).toMatchObject({
      status: "failed",
      error: { code: "scratch-cleanup-failed", message: "cleanup denied" },
    })
  })

  it("passes exact YRD_* variables while scrubbing ambient YRD_* and GIT_* values", async () => {
    await using process = createProcess()
    expect(() =>
      configuredCommandStep<PRShape>({
        inject: { process },
        command: ["echo", "{target}"],
        cwd: ".",
        purpose: "check",
      }),
    ).toThrow("placeholder {target} is retired; use $YRD_TARGET")

    const { repo } = await repository()
    const headSha = "a".repeat(40)
    const baseSha = "b".repeat(40)
    const pr = { id: "PR1", branch: "issue/feature", base: "main", revision: 1, headSha, baseSha }
    const step = configuredCommandStep<PRShape>({
      inject: { process },
      command: shellCommand("env | grep -E '^(YRD_|GIT_)' | sort"),
      cwd: repo,
      purpose: "check",
      env: { ...globalThis.process.env, YRD_LEAK: "must-not-leak", GIT_DIR: "/must/not/leak" },
      variables: () => ({ YRD_CUSTOM: "custom" }),
    })
    const result = await step(
      { run: "R1", step: "check", index: 0, prs: [pr], shape: { results: {} } },
      { id: "J1", attempt: 1, runner: "test", signal: new AbortController().signal },
    )
    if (result.status !== "passed") throw new Error(`configured command was ${result.status}`)
    expect(result.output.detail?.split("\n")).toEqual([
      "YRD_ATTEMPT=1",
      "YRD_BASE=main",
      `YRD_BASE_SHA=${baseSha}`,
      "YRD_CUSTOM=custom",
      "YRD_JOB=J1",
      "YRD_PR=PR1",
      'YRD_PRS=["PR1"]',
      "YRD_RUN=R1",
      "YRD_RUNNER=test",
      `YRD_SHA=${headSha}`,
      `YRD_SHAS=["${headSha}"]`,
      "YRD_STEP=check",
      `YRD_TARGET=${headSha}`,
    ])
    expect(result.output.detail).not.toContain("YRD_LEAK")
    expect(result.output.detail).not.toContain("GIT_DIR")
  })

  it("checks and lands one combined candidate for a passing batch", async () => {
    const { repo, one: firstSha, two: secondSha } = await repository("one", "two")
    await using process = createProcess()
    await using app = await checkedQueue(
      process,
      repo,
      shellCommand("test -f one.txt && test -f two.txt && echo checked-batch"),
      { batch: 2 },
    )
    await app.bays.submit({ branch: "issue/one", headSha: firstSha, base: "main" })
    await app.bays.submit({ branch: "issue/two", headSha: secondSha, base: "main" })
    await git(repo, ["switch", "-q", "--detach", "main"])

    const runs = await app.queue.run({ prs: ["PR1", "PR2"] }, runtime)
    await git(repo, ["switch", "-q", "main"])

    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ status: "passed", prs: [{ headSha: firstSha }, { headSha: secondSha }] })
    const job = runs[0]!.steps[0]!.job
    if (job?.status !== "passed") throw new Error("check did not pass")
    await expectLanded(repo, GitCheckEvidenceSchema.parse(job.output))
  })

  it("lands the checked candidate through origin without touching a dirty local base checkout", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const remote = join(repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", "issue/feature"])
    const localMain = await git(repo, ["rev-parse", "main"])
    await writeFile(join(repo, "operator-wip.txt"), "preserve me\n")

    await using process = createProcess()
    await using app = await checkedQueue(process, repo, ["test", "-f", "feature.txt"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!
    const checkJob = run.steps[0]?.job
    const mergeJob = run.steps[1]?.job
    if (checkJob?.status !== "passed") throw new Error("check did not pass")
    const checked = GitCheckEvidenceSchema.parse(checkJob.output)

    expect(run).toMatchObject({
      status: "passed",
      integration: { commit: checked.candidateSha, baseSha: checked.candidateSha },
    })
    expect(mergeJob).toMatchObject({ status: "passed", attempt: 1, output: run.integration })
    expect(await git(remote, ["rev-parse", "main"])).toBe(checked.candidateSha)
    expect(await git(repo, ["rev-parse", "main"])).toBe(localMain)
    expect(await Bun.file(join(repo, "operator-wip.txt")).text()).toBe("preserve me\n")
  })

  it("runs remote push hooks from the checked candidate tree and submodule pins", async () => {
    const { repo, remote, featureSha, moduleSha } = await hookedSubmoduleRepository({
      baseVersion: "base",
      candidateVersion: "candidate",
      requiredVersion: "candidate",
    })

    await using process = createProcess()
    await using app = await checkedQueue(
      process,
      repo,
      shellCommand('git submodule update --init --recursive && test "$(cat dep/version.txt)" = candidate'),
    )
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({ status: "passed", prs: [{ headSha: featureSha }] })
    expect(await git(remote, ["ls-tree", "main", "dep"])).toContain(moduleSha)
  })

  it("rejects a checked candidate that fails a hook even when the operator tree passes it", async () => {
    const { repo, remote, baseSha, featureSha } = await hookedSubmoduleRepository({
      baseVersion: "accepted",
      candidateVersion: "invalid",
      requiredVersion: "accepted",
    })
    await using process = createProcess()
    await using app = await checkedQueue(process, repo, shellCommand("git submodule update --init --recursive"))
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({ status: "failed", error: { code: "merge-push-failed" } })
    expect(await git(remote, ["rev-parse", "main"])).toBe(baseSha)
  })

  it("keeps one same-base run active before the remote compare-and-push", async () => {
    const { repo, one: firstSha, two: secondSha } = await repository("one", "two")
    const remote = join(repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", "issue/one", "issue/two"])
    const localMain = await git(repo, ["rev-parse", "main"])

    await using process = createProcess()
    await using app = await checkedQueue(process, repo, ["true"])
    await app.bays.submit({ branch: "issue/one", headSha: firstSha, base: "main" })
    await app.bays.submit({ branch: "issue/two", headSha: secondSha, base: "main" })

    const settled = await Promise.allSettled([
      app.queue.run({ prs: ["PR1"] }, { runner: "worker-1", leaseMs: 60_000 }),
      app.queue.run({ prs: ["PR2"] }, { runner: "worker-2", leaseMs: 60_000 }),
    ])
    const completed = settled.find((result) => result.status === "fulfilled")
    const refused = settled.find((result) => result.status === "rejected")

    expect(completed).toMatchObject({ status: "fulfilled", value: [expect.objectContaining({ status: "passed" })] })
    expect(refused).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: expect.stringContaining("queue 'main' is running") }),
    })
    const landing = await git(remote, ["rev-parse", "main"])
    const landedPaths = (await git(remote, ["ls-tree", "--name-only", landing])).split("\n")
    expect(landedPaths.filter((path) => path === "one.txt" || path === "two.txt")).toHaveLength(1)
    expect(await git(repo, ["rev-parse", "main"])).toBe(localMain)
  })

  it("refuses an intervening remote move instead of retrying the stale Candidate", async () => {
    const { repo, feature: featureSha, competing: competingSha } = await repository("feature", "competing")
    const remote = join(repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", "issue/feature", "issue/competing"])

    await using process = createProcess()
    let raced = false
    const racingProcess: Pick<Process, "run"> = {
      async run(request) {
        if (!raced && request.argv.includes("push")) {
          raced = true
          await git(repo, ["push", "-q", "origin", `${competingSha}:refs/heads/main`])
        }
        return process.run(request)
      },
    }
    await using app = await checkedQueue(racingProcess, repo, ["true"])
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!
    const checkJob = run.steps[0]?.job
    if (checkJob?.status !== "passed") throw new Error("check did not pass")
    const checked = GitCheckEvidenceSchema.parse(checkJob.output)

    expect(raced).toBe(true)
    expect(run).toMatchObject({ status: "failed", error: { code: "stale-base" } })
    expect(await git(remote, ["rev-parse", "main"])).toBe(competingSha)
    expect(await git(repo, ["rev-parse", checked.candidateRef])).toBe(checked.candidateSha)
  })

  it("preserves remote evidence and lands its pinned candidate", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    await using app = await checkedQueue(
      process,
      repo,
      shellCommand(
        `printf '%s\\n' '{"token":"ci-1","url":"https://ci.invalid/1","detail":"queued",` +
          `"artifacts":[{"name":"remote","uri":"artifact://ci-1"}]}'`,
      ),
      { waiting: true },
    )
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!
    const waiting = run.steps[0]?.job
    if (waiting?.status !== "waiting") throw new Error("check did not wait")
    const checkpoint = GitCheckEvidenceSchema.parse(waiting.checkpoint)
    expect(waiting).toMatchObject({ token: "ci-1", url: "https://ci.invalid/1", detail: "queued" })
    expect(waiting.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ uri: "artifact://ci-1" })]))
    expect(await git(repo, ["rev-parse", checkpoint.candidateRef])).toBe(checkpoint.candidateSha)

    const finished = await app.queue.finish(
      run.id,
      {
        job: waiting.id,
        attempt: waiting.attempt,
        runner: waiting.runner,
        token: waiting.token,
        result: { status: "passed", output: checkpoint },
      },
      runtime,
    )
    expect(finished.status).toBe("passed")
    await expectLanded(repo, checkpoint)
  })

  it("refuses merge when the base moves after the checked candidate", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    const bayJobs = createBayJobDefs(unusedWorkspace)
    const check = withStep(
      "check",
      gitCheckStep({ inject: { process }, repo, command: ["test", "-f", "feature.txt"] }),
      {
        revision: "check-v1",
        output: GitCheckResultEvidenceSchema,
      },
    )
    const MovedSchema = z.object({ moved: z.literal(true) }).strict()
    type Moved = AddStepResult<Checked, "move-base", z.infer<typeof MovedSchema>>
    const move = withStep(
      "move-base",
      async (_input: StepExecution<Checked>) => {
        await writeFile(join(repo, "base-moved.txt"), "moved after check\n")
        await git(repo, ["add", "base-moved.txt"])
        await git(repo, ["commit", "-qm", "move base after check"])
        return { status: "passed" as const, output: { moved: true as const } }
      },
      { revision: "move-base-v1", output: MovedSchema },
    )
    const merge = withMerge(gitMergeStep<Moved>({ inject: { process }, repo }), { revision: "git-merge-v1" })
    const queue = withQueue({ steps: [check, move, merge] as const })
    const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
    await using app = await createYrd(queue(base), { inject: { journal: createMemoryJournal() } })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({ status: "failed", error: { code: "stale-check" } })
    expect(existsSync(join(repo, "feature.txt"))).toBe(false)
    expect(existsSync(join(repo, "base-moved.txt"))).toBe(true)
  })

  it("reconciles the authoritative landing after a delegated merge reports a post-push failure", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const remote = join(repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", "issue/feature"])
    await using process = createProcess()
    const bayJobs = createBayJobDefs(unusedWorkspace)
    const check = withStep(
      "check",
      gitCheckStep({ inject: { process }, repo, command: ["test", "-f", "feature.txt"] }),
      { revision: "check-v1", output: GitCheckResultEvidenceSchema },
    )
    const merge = withMerge(
      configuredMergeStep<Checked>({
        inject: { process },
        repo,
        command: shellCommand(
          'git merge --no-ff --no-edit "$YRD_SHA" && git commit --amend --no-edit && ' +
            "git push origin HEAD:refs/heads/main; exit 19",
        ),
      }),
      { revision: "delegated-merge-v1" },
    )
    const queue = withQueue({ steps: [check, merge] as const })
    const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
    await using app = await createYrd(queue(base), { inject: { journal: createMemoryJournal() } })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!
    const landing = await git(repo, ["rev-parse", "refs/remotes/origin/main"])
    const checkJob = run.steps[0]?.job
    if (checkJob?.status !== "passed") throw new Error("check did not pass")

    expect(run).toMatchObject({
      status: "passed",
      integration: { commit: landing, baseSha: landing },
    })
    expect(await git(repo, ["merge-base", "--is-ancestor", run.integration!.commit, "refs/remotes/origin/main"])).toBe(
      "",
    )
    expect(landing).not.toBe(GitCheckEvidenceSchema.parse(checkJob.output).candidateSha)
    expect(app.state().bays.prs.PR1).toMatchObject({
      status: "integrated",
      integration: { commit: landing, baseSha: landing },
    })
  })

  it("keeps the submitted payload when configured merge cannot refresh post-command authority", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const remote = join(repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", "issue/feature"])
    await using process = createProcess()
    let successfulRefreshes = 0
    let refusalAttempts = 0
    const unavailableAfterCommand: Pick<Process, "run"> = {
      run(request) {
        if (request.argv[0] === "git" && request.argv.includes("fetch")) {
          if (successfulRefreshes < 2) {
            successfulRefreshes += 1
            return process.run(request)
          }
          refusalAttempts += 1
          return Promise.resolve({
            exitCode: 1,
            signal: null,
            stdout: "",
            stderr: "origin unavailable after configured command",
            durationMs: 1,
            timedOut: false,
          })
        }
        return process.run(request)
      },
    }
    const bayJobs = createBayJobDefs(unusedWorkspace)
    const check = withStep(
      "check",
      gitCheckStep({ inject: { process: unavailableAfterCommand }, repo, command: ["test", "-f", "feature.txt"] }),
      { revision: "check-v1", output: GitCheckResultEvidenceSchema },
    )
    const merge = withMerge(
      configuredMergeStep<Checked>({
        inject: { process: unavailableAfterCommand },
        repo,
        command: shellCommand('git push origin "$YRD_CANDIDATE_SHA":refs/heads/main'),
      }),
      { revision: "delegated-merge-v1" },
    )
    const queue = withQueue({ steps: [check, merge] as const })
    const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
    await using app = await createYrd(queue(base), { inject: { journal: createMemoryJournal() } })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, runtime))[0]!
    const checkJob = run.steps[0]?.job
    if (checkJob?.status !== "passed") throw new Error("check did not pass")
    const checked = GitCheckEvidenceSchema.parse(checkJob.output)

    expect(successfulRefreshes).toBe(2)
    expect(refusalAttempts).toBe(3)
    expect(run).toMatchObject({
      status: "failed",
      error: { code: "queue-environment-refused", message: expect.stringContaining("after 3 attempts") },
      prs: [{ id: "PR1", revision: 1, headSha: featureSha }],
    })
    expect(run.steps[1]?.job).toMatchObject({
      status: "failed",
      error: { code: "queue-environment-refused", message: expect.stringContaining("after 3 attempts") },
    })
    expect(await git(remote, ["rev-parse", "main"])).toBe(checked.candidateSha)
    expect(app.state().bays.prs.PR1).toMatchObject({ revision: 1, headSha: featureSha, status: "submitted" })
  })

  it("fails a delegated merge command that exits zero without landing the PR", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    const bayJobs = createBayJobDefs(unusedWorkspace)
    const check = withStep(
      "check",
      gitCheckStep({ inject: { process }, repo, command: ["test", "-f", "feature.txt"] }),
      { revision: "check-v1", output: GitCheckResultEvidenceSchema },
    )
    const merge = withMerge(configuredMergeStep<Checked>({ inject: { process }, repo, command: ["true"] }), {
      revision: "delegated-merge-v1",
    })
    const queue = withQueue({ steps: [check, merge] as const })
    const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, queue.jobDefs] }), withBays({ jobs: bayJobs }))
    await using app = await createYrd(queue(base), { inject: { journal: createMemoryJournal() } })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    expect((await app.queue.run({ prs: ["PR1"] }, runtime))[0]).toMatchObject({
      status: "failed",
      error: { code: "merge-command-did-not-land" },
    })
  })
})

describe("configuredCommandStep — a timed-out command is a NAMED timeout failure (21012 S1)", () => {
  it("fails with <purpose>-timeout naming the bound, not a generic exit red", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "yrd-cmd-timeout-"))
    roots.push(cwd)
    await using process = createProcess({ cwd, killGraceMs: 500 })
    const runner = configuredCommandStep<PRShape>({
      inject: { process },
      command: ["sleep", "30"],
      cwd,
      purpose: "check",
      artifactRoot: join(cwd, "artifacts"),
      timeoutMs: 500,
    })
    const outcome = await runner(
      {
        run: "run-1",
        step: "check",
        prs: [{ id: "pr-1", base: "main", headSha: "a".repeat(40) }],
        targetSha: "a".repeat(40),
      } as unknown as StepExecution<PRShape>,
      { attempt: 1 } as never,
    )
    expect(outcome.status).toBe("failed")
    if (outcome.status !== "failed") return
    expect(outcome.error.code).toBe("check-timeout")
    expect(outcome.error.message).toContain("500ms wall-clock bound")
    const evidence = CommandEvidenceSchema.parse(outcome.output)
    expect(evidence).toMatchObject({ timedOut: true, stageVerdict: "TIMED_OUT", durationMs: expect.any(Number) })
    expect(outcome.error.message).not.toContain(cwd)
  }, 15_000)
})
