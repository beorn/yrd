/**
 * @failure Git-backed Line steps can check one candidate and merge another or lose durable command evidence.
 * @level l2
 * @consumer @yrd/line Git step adapters
 */
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
  withLine,
  withMerge,
  withStep,
  type AddStepResult,
  type GitCheckEvidence,
  type GitCheckResultEvidence,
  type PRShape,
  type StepExecution,
} from "@yrd/line"

const roots: string[] = []
const runtime = { executor: "local", leaseMs: 60_000 }
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
  const root = await mkdtemp(join(tmpdir(), "yrd-line-git-"))
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
    await git(repo, ["switch", "-qc", `task/${name}`])
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
  await git(repo, ["switch", "-qc", "task/feature"])
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
  await git(repo, ["push", "-q", "origin", "main", "task/feature"])
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

async function checkedLine(
  process: Pick<Process, "run">,
  repo: string,
  command: readonly string[],
  options: Readonly<{ batch?: number; waiting?: boolean; checkoutParent?: string }> = {},
) {
  const bayJobs = createBayJobDefs(unusedWorkspace)
  const check = withStep(
    "check",
    gitCheckStep({
      inject: { process },
      repo,
      command,
      ...(options.waiting ? { runner: "waiting" as const } : {}),
      ...(options.checkoutParent === undefined ? {} : { checkoutParent: options.checkoutParent }),
    }),
    { revision: `check:${JSON.stringify(command)}:${options.waiting === true}`, output: GitCheckResultEvidenceSchema },
  )
  const merge = withMerge(gitMergeStep<Checked>({ inject: { process }, repo }), { revision: "git-merge-v1" })
  const line = withLine({ steps: [check, merge] as const, batch: options.batch ?? 1 })
  const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, line.jobDefs] }), withBays({ jobs: bayJobs }))
  return createYrd(line(base), { inject: { journal: createMemoryJournal() } })
}

async function expectLanded(repo: string, evidence: GitCheckEvidence): Promise<void> {
  expect(await git(repo, ["rev-parse", "main"])).toBe(evidence.candidateSha)
  expect(await git(repo, ["rev-parse", evidence.candidateRef])).toBe(evidence.candidateSha)
}

describe("Line command adapters", () => {
  it("persists candidate-conflict evidence on the causative check step before scratch cleanup", async () => {
    const { repo } = await repository()
    await writeFile(join(repo, "conflict.txt"), "base\n")
    await git(repo, ["add", "conflict.txt"])
    await git(repo, ["commit", "-qm", "conflict base"])
    await git(repo, ["switch", "-qc", "task/conflict"])
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
        prs: [{ id: "PR1", branch: "task/conflict", base: "main", revision: 1, headSha: featureSha }],
        shape: { results: {} },
      },
      { id: "J1", attempt: 1, executor: "test", signal: new AbortController().signal },
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
      prs: [{ id: "PR1", branch: "task/feature", base: "main", revision: 1, headSha: "a".repeat(40) }],
      shape: { results: {} },
    } as StepExecution<PRShape>
    const context = { id: "J1", attempt: 1, executor: "test", signal: new AbortController().signal }

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
        stdout: `diagnostic header\n${"x".repeat(2_100)}`,
        stderr: "stderr evidence\n",
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
          prs: [{ id: "PR1", branch: "task/feature", base: "main", revision: 1, headSha: "a".repeat(40) }],
          shape: { results: {} },
        },
        { id: "J1", attempt: 1, executor: "test", signal: new AbortController().signal },
      )

      expect(outcome).toMatchObject({ status: "failed", error })
      if (outcome.status !== "failed") throw new Error(`configured command was ${outcome.status}`)
      const evidence = CommandEvidenceSchema.parse(outcome.output)
      expect(evidence).toMatchObject({
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        artifacts: [{ name: "stdout" }, { name: "stderr" }],
        ...(verdict === undefined ? {} : { stageVerdict: verdict }),
      })
      expect(evidence.artifacts.every((artifact) => existsSync(artifact.path))).toBe(true)
      expect(outcome.error.message).not.toContain(evidence.detail ?? "")
      expect(outcome.error.message).not.toContain(cwd)
    },
  )

  it("lands the exact audited candidate and its durable artifacts", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    await using app = await checkedLine(
      process,
      repo,
      shellCommand('git config user.name "Changed After Check" && test -f feature.txt && echo checked'),
    )
    await app.bays.submit({ branch: "task/feature", headSha: featureSha, base: "main" })

    const run = (await app.line.integrate({ prs: ["PR1"] }, runtime))[0]!
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

  it("lands from origin when the base has no local branch without moving detached HEAD", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const baseSha = await git(repo, ["rev-parse", "main"])
    await git(repo, ["update-ref", "refs/remotes/origin/main", baseSha])
    await git(repo, ["switch", "-q", "--detach", featureSha])
    await git(repo, ["branch", "-D", "main"])
    await using process = createProcess()
    await using app = await checkedLine(process, repo, ["test", "-f", "feature.txt"])
    await app.bays.submit({ branch: "task/feature", headSha: featureSha, base: "main" })

    const run = (await app.line.integrate({ prs: ["PR1"] }, runtime))[0]!

    expect(run.status).toBe("passed")
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(featureSha)
    expect(await git(repo, ["rev-parse", "refs/remotes/origin/main"])).toBe(baseSha)
    const job = run.steps[0]?.job
    if (job?.status !== "passed") throw new Error("check did not pass")
    await expectLanded(repo, GitCheckEvidenceSchema.parse(job.output))
  })

  it("refuses local and authoritative remote base divergence before creating a candidate", async () => {
    const { repo, feature: featureSha, competing: remoteBaseSha } = await repository("feature", "competing")
    const remote = join(repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", "task/feature", "task/competing"])
    await git(repo, ["push", "-q", "origin", `${remoteBaseSha}:refs/heads/main`])
    await using process = createProcess()
    await using app = await checkedLine(process, repo, ["false"])
    await app.bays.submit({ branch: "task/feature", headSha: featureSha, base: "main" })

    const run = (await app.line.integrate({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({ status: "failed", error: { code: "line-target-diverged" } })
    expect(await git(repo, ["for-each-ref", "--format=%(refname)", "refs/yrd/candidates"])).toBe("")
  })

  it("materializes candidate checks under the injected trusted parent", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const parentRoot = await mkdtemp(join(tmpdir(), "yrd-line-checkouts-"))
    const checkoutParent = join(parentRoot, "nested")
    roots.push(parentRoot)
    await using process = createProcess()
    await using app = await checkedLine(process, repo, ["pwd"], { checkoutParent })
    await app.bays.submit({ branch: "task/feature", headSha: featureSha, base: "main" })

    const run = (await app.line.integrate({ prs: ["PR1"] }, runtime))[0]!
    const job = run.steps[0]?.job
    if (job?.status !== "passed") throw new Error("check did not pass")
    const evidence = GitCheckEvidenceSchema.parse(job.output)
    expect(await readFile(evidence.artifacts[0]!.path, "utf8")).toMatch(
      new RegExp(`^${await realpath(checkoutParent)}/yrd-line-`),
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
    await using app = await checkedLine(guarded, repo, ["test", "-f", "feature.txt"])
    await app.bays.submit({ branch: "task/feature", headSha: featureSha, base: "main" })

    const run = (await app.line.integrate({ prs: ["PR1"] }, runtime))[0]!
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
    const pr = { id: "PR1", branch: "task/feature", base: "main", revision: 1, headSha, baseSha }
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
      { id: "J1", attempt: 1, executor: "test", signal: new AbortController().signal },
    )
    if (result.status !== "passed") throw new Error(`configured command was ${result.status}`)
    expect(result.output.detail?.split("\n")).toEqual([
      "YRD_ATTEMPT=1",
      "YRD_BASE=main",
      `YRD_BASE_SHA=${baseSha}`,
      "YRD_CUSTOM=custom",
      "YRD_EXECUTOR=test",
      "YRD_JOB=J1",
      "YRD_PR=PR1",
      'YRD_PRS=["PR1"]',
      "YRD_RUN=R1",
      `YRD_SHA=${headSha}`,
      `YRD_SHAS=["${headSha}"]`,
      "YRD_STEP=check",
      `YRD_TARGET=${headSha}`,
    ])
  })

  it("checks and lands one combined candidate for a passing batch", async () => {
    const { repo, one: firstSha, two: secondSha } = await repository("one", "two")
    await using process = createProcess()
    await using app = await checkedLine(
      process,
      repo,
      shellCommand("test -f one.txt && test -f two.txt && echo checked-batch"),
      { batch: 2 },
    )
    await app.bays.submit({ branch: "task/one", headSha: firstSha, base: "main" })
    await app.bays.submit({ branch: "task/two", headSha: secondSha, base: "main" })
    await git(repo, ["switch", "-q", "--detach", "main"])

    const runs = await app.line.integrate({ prs: ["PR1", "PR2"] }, runtime)
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
    await git(repo, ["push", "-q", "origin", "main", "task/feature"])
    const localMain = await git(repo, ["rev-parse", "main"])
    await writeFile(join(repo, "operator-wip.txt"), "preserve me\n")

    await using process = createProcess()
    await using app = await checkedLine(process, repo, ["test", "-f", "feature.txt"])
    await app.bays.submit({ branch: "task/feature", headSha: featureSha, base: "main" })

    const run = (await app.line.integrate({ prs: ["PR1"] }, runtime))[0]!
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
    await using app = await checkedLine(
      process,
      repo,
      shellCommand('git submodule update --init --recursive && test "$(cat dep/version.txt)" = candidate'),
    )
    await app.bays.submit({ branch: "task/feature", headSha: featureSha, base: "main" })

    const run = (await app.line.integrate({ prs: ["PR1"] }, runtime))[0]!

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
    await using app = await checkedLine(process, repo, shellCommand("git submodule update --init --recursive"))
    await app.bays.submit({ branch: "task/feature", headSha: featureSha, base: "main" })

    const run = (await app.line.integrate({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({ status: "failed", error: { code: "merge-push-failed" } })
    expect(await git(remote, ["rev-parse", "main"])).toBe(baseSha)
  })

  it("keeps one same-base run active before the remote compare-and-push", async () => {
    const { repo, one: firstSha, two: secondSha } = await repository("one", "two")
    const remote = join(repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", "task/one", "task/two"])
    const localMain = await git(repo, ["rev-parse", "main"])

    await using process = createProcess()
    await using app = await checkedLine(process, repo, ["true"])
    await app.bays.submit({ branch: "task/one", headSha: firstSha, base: "main" })
    await app.bays.submit({ branch: "task/two", headSha: secondSha, base: "main" })

    const settled = await Promise.allSettled([
      app.line.integrate({ prs: ["PR1"] }, { executor: "worker-1", leaseMs: 60_000 }),
      app.line.integrate({ prs: ["PR2"] }, { executor: "worker-2", leaseMs: 60_000 }),
    ])
    const completed = settled.find((result) => result.status === "fulfilled")
    const refused = settled.find((result) => result.status === "rejected")

    expect(completed).toMatchObject({ status: "fulfilled", value: [expect.objectContaining({ status: "passed" })] })
    expect(refused).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: expect.stringContaining("line 'main' is running") }),
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
    await git(repo, ["push", "-q", "origin", "main", "task/feature", "task/competing"])

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
    await using app = await checkedLine(racingProcess, repo, ["true"])
    await app.bays.submit({ branch: "task/feature", headSha: featureSha, base: "main" })

    const run = (await app.line.integrate({ prs: ["PR1"] }, runtime))[0]!
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
    await using app = await checkedLine(
      process,
      repo,
      shellCommand(
        `printf '%s\\n' '{"token":"ci-1","url":"https://ci.invalid/1","detail":"queued",` +
          `"artifacts":[{"name":"remote","uri":"artifact://ci-1"}]}'`,
      ),
      { waiting: true },
    )
    await app.bays.submit({ branch: "task/feature", headSha: featureSha, base: "main" })

    const run = (await app.line.integrate({ prs: ["PR1"] }, runtime))[0]!
    const waiting = run.steps[0]?.job
    if (waiting?.status !== "waiting") throw new Error("check did not wait")
    const checkpoint = GitCheckEvidenceSchema.parse(waiting.checkpoint)
    expect(waiting).toMatchObject({ token: "ci-1", url: "https://ci.invalid/1", detail: "queued" })
    expect(waiting.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ uri: "artifact://ci-1" })]))
    expect(await git(repo, ["rev-parse", checkpoint.candidateRef])).toBe(checkpoint.candidateSha)

    await app.jobs.finish(waiting.id, {
      attempt: waiting.attempt,
      executor: waiting.executor,
      token: waiting.token,
      result: { status: "passed", output: checkpoint },
    })
    const finished = await app.line.run(run.id, runtime)
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
    const line = withLine({ steps: [check, move, merge] as const })
    const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, line.jobDefs] }), withBays({ jobs: bayJobs }))
    await using app = await createYrd(line(base), { inject: { journal: createMemoryJournal() } })
    await app.bays.submit({ branch: "task/feature", headSha: featureSha, base: "main" })

    const run = (await app.line.integrate({ prs: ["PR1"] }, runtime))[0]!

    expect(run).toMatchObject({ status: "failed", error: { code: "stale-check" } })
    expect(existsSync(join(repo, "feature.txt"))).toBe(false)
    expect(existsSync(join(repo, "base-moved.txt"))).toBe(true)
  })

  it("reconciles the authoritative landing after a delegated merge reports a post-push failure", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const remote = join(repo, "..", "origin.git")
    await Bun.$`git init -q --bare ${remote}`
    await git(repo, ["remote", "add", "origin", remote])
    await git(repo, ["push", "-q", "origin", "main", "task/feature"])
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
    const line = withLine({ steps: [check, merge] as const })
    const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, line.jobDefs] }), withBays({ jobs: bayJobs }))
    await using app = await createYrd(line(base), { inject: { journal: createMemoryJournal() } })
    await app.bays.submit({ branch: "task/feature", headSha: featureSha, base: "main" })

    const run = (await app.line.integrate({ prs: ["PR1"] }, runtime))[0]!
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
    const line = withLine({ steps: [check, merge] as const })
    const base = pipe(createYrdDef(), withJobs({ definitions: [bayJobs, line.jobDefs] }), withBays({ jobs: bayJobs }))
    await using app = await createYrd(line(base), { inject: { journal: createMemoryJournal() } })
    await app.bays.submit({ branch: "task/feature", headSha: featureSha, base: "main" })

    expect((await app.line.integrate({ prs: ["PR1"] }, runtime))[0]).toMatchObject({
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
