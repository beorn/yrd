/**
 * @failure Git-backed Line steps can check one candidate and merge another or lose durable command evidence.
 * @level l2
 * @consumer @yrd/line Git step adapters
 */
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createBayJobDefs, withBays, type BayWorkspace } from "@yrd/bay"
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs } from "@yrd/job"
import { createProcess, type Process } from "@yrd/process"
import * as z from "zod"
import {
  GitCheckEvidenceSchema,
  configuredCommandStep,
  gitCheckStep,
  gitMergeStep,
  withLine,
  withMerge,
  withStep,
  type AddStepResult,
  type GitCheckEvidence,
  type PRShape,
  type StepExecution,
} from "@yrd/line"

const roots: string[] = []
const runtime = { executor: "local", leaseMs: 60_000 }
type Checked = AddStepResult<PRShape, "check", GitCheckEvidence>

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

const unusedWorkspace: BayWorkspace = {
  revision: "unused-workspace-v1",
  provision: () => ({ status: "failed", error: { code: "unused", message: "not used" } }),
  refresh: () => ({ status: "failed", error: { code: "unused", message: "not used" } }),
  deprovision: () => ({ status: "passed", output: {} }),
}

async function checkedLine(
  process: Pick<Process, "run">,
  repo: string,
  command: string,
  options: Readonly<{ batch?: number; waiting?: boolean }> = {},
) {
  const bayJobs = createBayJobDefs(unusedWorkspace)
  const check = withStep(
    "check",
    gitCheckStep({
      inject: { process },
      repo,
      command,
      ...(options.waiting ? { runner: "waiting" as const } : {}),
    }),
    { revision: `check:${command}:${options.waiting === true}`, output: GitCheckEvidenceSchema },
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
  it("lands the exact audited candidate and its durable artifacts", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    await using app = await checkedLine(
      process,
      repo,
      'git config user.name "Changed After Check" && test -f feature.txt && echo checked',
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

  it("passes exact YRD_* variables while scrubbing ambient YRD_* and GIT_* values", async () => {
    await using process = createProcess()
    expect(() =>
      configuredCommandStep<PRShape>({
        inject: { process },
        command: "echo {target}",
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
      command: "env | grep -E '^(YRD_|GIT_)' | sort",
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
    await using app = await checkedLine(process, repo, "test -f one.txt && test -f two.txt && echo checked-batch", {
      batch: 2,
    })
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

  it("preserves remote evidence and lands its pinned candidate", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    await using process = createProcess()
    await using app = await checkedLine(
      process,
      repo,
      `printf '%s\\n' '{"token":"ci-1","url":"https://ci.invalid/1","detail":"queued",` +
        `"artifacts":[{"name":"remote","uri":"artifact://ci-1"}]}'`,
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
    const check = withStep("check", gitCheckStep({ inject: { process }, repo, command: "test -f feature.txt" }), {
      revision: "check-v1",
      output: GitCheckEvidenceSchema,
    })
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
})
