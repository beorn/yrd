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
  type CommandEvidence,
  type GitCheckEvidence,
  type StepExecution,
  type SubmissionShape,
} from "@yrd/line"

const roots: string[] = []

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

async function repository(): Promise<{ repo: string; featureSha: string }> {
  const root = await mkdtemp(join(tmpdir(), "yrd-line-git-"))
  roots.push(root)
  const repo = join(root, "repo")
  await Bun.$`git init -q -b main ${repo}`
  await git(repo, ["config", "user.name", "Yrd Test"])
  await git(repo, ["config", "user.email", "yrd@example.invalid"])
  await writeFile(join(repo, "README.md"), "main\n")
  await git(repo, ["add", "README.md"])
  await git(repo, ["commit", "-qm", "main"])
  await git(repo, ["switch", "-qc", "task/feature"])
  await writeFile(join(repo, "feature.txt"), "feature\n")
  await git(repo, ["add", "feature.txt"])
  await git(repo, ["commit", "-qm", "feature"])
  const featureSha = await git(repo, ["rev-parse", "HEAD"])
  await git(repo, ["switch", "-q", "main"])
  return { repo, featureSha }
}

async function batchRepository(): Promise<{ repo: string; firstSha: string; secondSha: string }> {
  const root = await mkdtemp(join(tmpdir(), "yrd-line-batch-git-"))
  roots.push(root)
  const repo = join(root, "repo")
  await Bun.$`git init -q -b main ${repo}`
  await git(repo, ["config", "user.name", "Yrd Test"])
  await git(repo, ["config", "user.email", "yrd@example.invalid"])
  await writeFile(join(repo, "README.md"), "main\n")
  await git(repo, ["add", "README.md"])
  await git(repo, ["commit", "-qm", "main"])
  await git(repo, ["switch", "-qc", "task/one"])
  await writeFile(join(repo, "one.txt"), "one\n")
  await git(repo, ["add", "one.txt"])
  await git(repo, ["commit", "-qm", "one"])
  const firstSha = await git(repo, ["rev-parse", "HEAD"])
  await git(repo, ["switch", "-q", "main"])
  await git(repo, ["switch", "-qc", "task/two"])
  await writeFile(join(repo, "two.txt"), "two\n")
  await git(repo, ["add", "two.txt"])
  await git(repo, ["commit", "-qm", "two"])
  const secondSha = await git(repo, ["rev-parse", "HEAD"])
  await git(repo, ["switch", "-q", "main"])
  return { repo, firstSha, secondSha }
}

const unusedWorkspace: BayWorkspaceAdapter = {
  provision: () => ({ status: "failed", error: { code: "unused", message: "not used" } }),
  refresh: () => ({ status: "failed", error: { code: "unused", message: "not used" } }),
  deprovision: () => ({ status: "passed", output: {} }),
}

describe("line command adapters", () => {
  it("checks the pinned submission tree, captures durable artifacts, and lands into a clean checked-out base", async () => {
    const { repo, featureSha } = await repository()
    type Checked = AddStepResult<SubmissionShape, "check", CommandEvidence>
    const app = pipe(
      createYrd({ store: createMemoryEventStore() }),
      withEffects(),
      withBays({ workspace: unusedWorkspace }),
      withLine(),
      withStep("check", gitCheckStep({ repo, command: "test -f feature.txt && echo checked" })),
      withMerge(gitMergeStep<Checked>({ repo })),
    )
    await app.command(app.commands.bay.submit, { branch: "task/feature", headSha: featureSha, base: "main" })

    const run = await app.line.integrate({ submission: "S1" }, { executor: "local", leaseMs: 60_000 })
    expect(run.status).toBe("passed")
    expect(await readFile(join(repo, "feature.txt"), "utf8")).toBe("feature\n")
    expect(await git(repo, ["status", "--porcelain"])).toBe("")
    expect(await git(repo, ["merge-base", "--is-ancestor", featureSha, "main"])).toBe("")

    const evidence = run.steps[0]?.output as CommandEvidence
    expect(evidence.exitCode).toBe(0)
    expect(evidence.artifacts).toHaveLength(1)
    expect(existsSync(evidence.artifacts[0]!.path)).toBe(true)
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

    const runner = configuredCommandStep<SubmissionShape>({
      command: 'test "$YRD_SUBMISSION" = "S1"',
      cwd: ".",
      purpose: "check",
    })
    expect(typeof runner).toBe("function")
  })

  it("checks and lands one combined Git candidate for a passing batch", async () => {
    const { repo, firstSha, secondSha } = await batchRepository()
    type Checked = AddStepResult<SubmissionShape, "check", CommandEvidence>
    const app = pipe(
      createYrd({ store: createMemoryEventStore() }),
      withEffects(),
      withBays({ workspace: unusedWorkspace }),
      withLine(),
      withBatch(2),
      withStep("check", gitCheckStep({ repo, command: "test -f one.txt && test -f two.txt && echo checked-batch" })),
      withMerge(gitMergeStep<Checked>({ repo })),
    )
    await app.command(app.commands.bay.submit, { branch: "task/one", headSha: firstSha, base: "main" })
    await app.command(app.commands.bay.submit, { branch: "task/two", headSha: secondSha, base: "main" })

    const runs = await app.line.integrate({ submissions: ["S1", "S2"] }, { executor: "local", leaseMs: 60_000 })

    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ status: "passed", submissions: [{ headSha: firstSha }, { headSha: secondSha }] })
    expect(await readFile(join(repo, "one.txt"), "utf8")).toBe("one\n")
    expect(await readFile(join(repo, "two.txt"), "utf8")).toBe("two\n")
    expect(await git(repo, ["merge-base", "--is-ancestor", firstSha, "main"])).toBe("")
    expect(await git(repo, ["merge-base", "--is-ancestor", secondSha, "main"])).toBe("")
  })

  it("refuses merge when the base moves after the checked candidate", async () => {
    const { repo, featureSha } = await repository()
    type Checked = AddStepResult<SubmissionShape, "check", GitCheckEvidence>
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

    const run = await app.line.integrate({ submission: "S1" }, { executor: "local", leaseMs: 60_000 })

    expect(run).toMatchObject({ status: "failed", error: { code: "stale-check" } })
    expect(existsSync(join(repo, "feature.txt"))).toBe(false)
    expect(existsSync(join(repo, "base-moved.txt"))).toBe(true)
  })
})
