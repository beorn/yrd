import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createMemoryEventStore, createYrd, pipe, withEffects } from "@yrd/core"
import { withBays, type BayWorkspaceAdapter } from "@yrd/bay"
import {
  configuredCommandStep,
  gitCheckStep,
  gitMergeStep,
  withBatch,
  withLine,
  withMerge,
  withStep,
  type AddStepResult,
  type GitCheckEvidence,
  type StepExecution,
  type SubmissionShape,
} from "@yrd/line"

const roots: string[] = []
const runtime = { executor: "local", leaseMs: 60_000 }
type Checked = AddStepResult<SubmissionShape, "check", GitCheckEvidence>

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

const unusedWorkspace: BayWorkspaceAdapter = {
  provision: () => ({ status: "failed", error: { code: "unused", message: "not used" } }),
  refresh: () => ({ status: "failed", error: { code: "unused", message: "not used" } }),
  deprovision: () => ({ status: "passed", output: {} }),
}

function checkedLine(repo: string, command: string, options: { batch?: number; waiting?: boolean } = {}) {
  return pipe(
    createYrd({ store: createMemoryEventStore() }),
    withEffects(),
    withBays({ workspace: unusedWorkspace }),
    withLine(),
    withBatch(options.batch ?? 1),
    withStep("check", gitCheckStep({ repo, command, ...(options.waiting ? { runner: "waiting" as const } : {}) })),
    withMerge(gitMergeStep<Checked>({ repo })),
  )
}

async function expectLanded(repo: string, evidence: GitCheckEvidence): Promise<void> {
  expect(await git(repo, ["rev-parse", "main"])).toBe(evidence.candidateSha)
  expect(await git(repo, ["rev-parse", evidence.candidateRef])).toBe(evidence.candidateSha)
}

describe("line command adapters", () => {
  it("lands the exact audited candidate and its durable artifacts", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const app = checkedLine(repo, 'git config user.name "Changed After Check" && test -f feature.txt && echo checked')
    await app.command(app.commands.bay.submit, { branch: "task/feature", headSha: featureSha, base: "main" })

    const run = await app.line.integrate({ submission: "PR1" }, runtime)
    expect(run.status).toBe("passed")
    expect(await readFile(join(repo, "feature.txt"), "utf8")).toBe("feature\n")
    expect(await git(repo, ["status", "--porcelain"])).toBe("")

    const evidence = run.steps[0]?.output as GitCheckEvidence
    await expectLanded(repo, evidence)
    expect(evidence.exitCode).toBe(0)
    expect(evidence.artifacts).toHaveLength(1)
    expect(await readFile(evidence.artifacts[0]!.path, "utf8")).toBe("checked\n")
  })

  it("keeps runtime values in YRD_* variables and rejects retired source placeholders", () => {
    expect(() =>
      configuredCommandStep<SubmissionShape>({
        command: "echo {target}",
        cwd: ".",
        purpose: "check",
      }),
    ).toThrow("placeholder {target} is retired; use $YRD_TARGET")

    expect(
      configuredCommandStep<SubmissionShape>({
        command: 'test "$YRD_SUBMISSION" = "PR1"',
        cwd: ".",
        purpose: "check",
      }),
    ).toBeTypeOf("function")
    expect(() => gitMergeStep({ repo: ".", command: "git merge task/feature" })).toThrow("withMerge")
  })

  it("checks and lands one combined Git candidate for a passing batch", async () => {
    const { repo, one: firstSha, two: secondSha } = await repository("one", "two")
    const app = checkedLine(
      repo,
      'git config user.name "Changed After Batch Check" && test -f one.txt && test -f two.txt && echo checked-batch',
      { batch: 2 },
    )
    await app.command(app.commands.bay.submit, { branch: "task/one", headSha: firstSha, base: "main" })
    await app.command(app.commands.bay.submit, { branch: "task/two", headSha: secondSha, base: "main" })
    await git(repo, ["switch", "-q", "--detach", "main"])

    const runs = await app.line.integrate({ submissions: ["PR1", "PR2"] }, runtime)
    await git(repo, ["switch", "-q", "main"])

    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ status: "passed", submissions: [{ headSha: firstSha }, { headSha: secondSha }] })
    const evidence = runs[0]!.steps[0]!.output as GitCheckEvidence
    await expectLanded(repo, evidence)
    expect(await readFile(join(repo, "one.txt"), "utf8")).toBe("one\n")
    expect(await readFile(join(repo, "two.txt"), "utf8")).toBe("two\n")
  })

  it("preserves waiting evidence and lands its pinned candidate", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    const app = checkedLine(
      repo,
      `printf '%s\\n' '{"token":"ci-1","url":"https://ci.invalid/1","detail":"queued",` +
        `"artifacts":[{"name":"remote","uri":"artifact://ci-1"}]}'`,
      { waiting: true },
    )
    await app.command(app.commands.bay.submit, { branch: "task/feature", headSha: featureSha, base: "main" })

    const run = await app.line.integrate({ submission: "PR1" }, runtime)

    expect(run.steps[0]).toMatchObject({
      status: "waiting",
      token: "ci-1",
      url: "https://ci.invalid/1",
      detail: "queued",
      checkpoint: {
        candidateRef: "refs/yrd/candidates/R1/check/attempt-1",
      },
    })
    const step = run.steps[0]!
    const checkpoint = step.checkpoint as GitCheckEvidence
    expect(await git(repo, ["rev-parse", checkpoint.candidateRef])).toBe(checkpoint.candidateSha)
    expect(checkpoint.artifacts.some((artifact) => artifact.name === "stdout")).toBe(true)
    expect(step.artifacts).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "remote", uri: "artifact://ci-1" })]),
    )
    await git(repo, ["config", "user.name", "Changed After Waiting Check"])
    await app.command(app.commands.effect.transition, {
      type: "finish",
      id: step.effectId!,
      attempt: step.attempt!,
      token: step.token!,
      outcome: { status: "passed", output: { ...checkpoint, artifacts: step.artifacts } },
    })

    const finished = await app.line.run(run.id, runtime)
    expect(finished.status).toBe("passed")
    await expectLanded(repo, checkpoint)
    expect((finished.steps[0]!.output as GitCheckEvidence).artifacts).toEqual(step.artifacts)
  })

  it("refuses merge when the base moves after the checked candidate", async () => {
    const { repo, feature: featureSha } = await repository("feature")
    type Moved = AddStepResult<Checked, "move-base", { moved: true }>
    const app = pipe(
      createYrd({ store: createMemoryEventStore() }),
      withEffects(),
      withBays({ workspace: unusedWorkspace }),
      withLine(),
      withStep("check", gitCheckStep({ repo, command: "test -f feature.txt" })),
      withStep("move-base", async (_input: StepExecution<Checked>) => {
        await writeFile(join(repo, "base-moved.txt"), "moved after check\n")
        await git(repo, ["add", "base-moved.txt"])
        await git(repo, ["commit", "-qm", "move base after check"])
        return { status: "passed", output: { moved: true as const } }
      }),
      withMerge(gitMergeStep<Moved>({ repo })),
    )
    await app.command(app.commands.bay.submit, { branch: "task/feature", headSha: featureSha, base: "main" })

    const run = await app.line.integrate({ submission: "PR1" }, runtime)

    expect(run).toMatchObject({ status: "failed", error: { code: "stale-check" } })
    expect(existsSync(join(repo, "feature.txt"))).toBe(false)
    expect(existsSync(join(repo, "base-moved.txt"))).toBe(true)
  })
})
