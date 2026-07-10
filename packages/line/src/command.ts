import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import type { EffectOutcome } from "@yrd/core"
import type { IntegratedShape, IntegrationProof, SubmissionShape } from "./model.ts"
import type { StepExecution, StepRunner } from "./line.ts"

export type StepArtifact = {
  name: string
  path: string
}

export type CommandEvidence = {
  exitCode: number
  durationMs: number
  configHash: string
  artifacts: StepArtifact[]
  detail?: string
}

export type GitCheckEvidence = CommandEvidence & {
  baseSha: string
  candidateSha: string
  candidateRef: string
}

export type ConfiguredCommandOptions<Shape extends SubmissionShape> = {
  command: string
  cwd: string | ((input: StepExecution<Shape>) => string | Promise<string>)
  purpose: string
  artifactRoot?: string
  variables?: (input: StepExecution<Shape>) => Record<string, string | undefined>
}

export type ConfiguredWaitingCommandOptions<Shape extends SubmissionShape> = ConfiguredCommandOptions<Shape>

function failed(code: string, message: string) {
  return { status: "failed" as const, error: { code, message } }
}

const RETIRED_PLACEHOLDERS = new Map([
  ["{name}", "$YRD_TASK"],
  ["{pr}", "$YRD_SUBMISSION"],
  ["{changeset}", "$YRD_SUBMISSION"],
  ["{sha}", "$YRD_SHA"],
  ["{target}", "$YRD_TARGET"],
  ["{base}", "$YRD_BASE"],
])

function commandEnvironment(variables: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("YRD_") || key.startsWith("GIT_")) continue
    env[key] = value
  }
  for (const [key, value] of Object.entries(variables)) {
    if (!key.startsWith("YRD_")) throw new Error(`yrd: configured command variable '${key}' must start with YRD_`)
    if (value !== undefined) env[key] = value
  }
  return env
}

function validateCommand(command: string, purpose: string): void {
  if (command.trim() === "") throw new Error(`yrd: ${purpose} command must not be empty`)
  for (const [placeholder, replacement] of RETIRED_PLACEHOLDERS) {
    if (command.includes(placeholder)) {
      throw new Error(`yrd: ${purpose} command placeholder ${placeholder} is retired; use ${replacement}`)
    }
  }
}

async function writeArtifacts(
  root: string,
  input: StepExecution,
  attempt: number,
  stdout: string,
  stderr: string,
): Promise<StepArtifact[]> {
  const dir = join(root, input.run, `${input.index}-${input.step}`, `attempt-${attempt}`)
  await mkdir(dir, { recursive: true })
  const artifacts: StepArtifact[] = []
  for (const [name, content] of [
    ["stdout", stdout],
    ["stderr", stderr],
  ] as const) {
    if (content === "") continue
    const path = join(dir, `${name}.log`)
    await writeFile(path, content)
    artifacts.push({ name, path })
  }
  return artifacts
}

export function configuredCommandStep<Shape extends SubmissionShape>(
  options: ConfiguredCommandOptions<Shape>,
): StepRunner<Shape, CommandEvidence> {
  return configuredCommand(options, false)
}

/** Launch a remote step and retain the launch evidence as its durable checkpoint. */
export function configuredWaitingCommandStep<Shape extends SubmissionShape>(
  options: ConfiguredWaitingCommandOptions<Shape>,
): StepRunner<Shape, CommandEvidence> {
  return configuredCommand(options, true)
}

function configuredCommand<Shape extends SubmissionShape>(
  options: ConfiguredCommandOptions<Shape>,
  waiting: boolean,
): StepRunner<Shape, CommandEvidence> {
  validateCommand(options.command, options.purpose)
  const configHash = createHash("sha256")
    .update(options.purpose)
    .update("\0")
    .update(options.command.trim())
    .digest("hex")
  return async (input, context): Promise<EffectOutcome<CommandEvidence>> => {
    const { result, evidence } = await executeConfiguredCommand(options, configHash, input, context.attempt)
    if (result.exitCode !== 0) {
      const action = waiting ? "launcher" : "command"
      return failed(
        `${options.purpose}${waiting ? "-launcher" : ""}-failed`,
        `${options.purpose} ${action} exited ${result.exitCode}${evidence.detail ? `: ${evidence.detail}` : ""}`,
      )
    }
    if (!waiting) return { status: "passed", output: evidence }
    try {
      const launch = waitingLaunch(result.stdout)
      return {
        status: "waiting",
        token: launch.token,
        ...(launch.url === undefined ? {} : { url: launch.url }),
        ...(launch.detail === undefined ? {} : { detail: launch.detail }),
        artifacts: [...evidence.artifacts, ...launch.artifacts],
        checkpoint: evidence,
      }
    } catch (cause) {
      return failed(`${options.purpose}-launcher-invalid`, cause instanceof Error ? cause.message : String(cause))
    }
  }
}

async function executeConfiguredCommand<Shape extends SubmissionShape>(
  options: ConfiguredCommandOptions<Shape>,
  configHash: string,
  input: StepExecution<Shape>,
  attempt: number,
) {
  const cwd = resolve(typeof options.cwd === "function" ? await options.cwd(input) : options.cwd)
  const variables = {
    YRD_BASE: input.submission.base,
    YRD_BASE_SHA: input.submission.baseSha,
    YRD_RUN: input.run,
    YRD_SHA: input.submission.headSha,
    YRD_SHAS: JSON.stringify(input.submissions.map((submission) => submission.headSha)),
    YRD_STEP: input.step,
    YRD_SUBMISSION: input.submission.id,
    YRD_SUBMISSIONS: JSON.stringify(input.submissions.map((submission) => submission.id)),
    YRD_TARGET: input.targetSha ?? input.submission.headSha,
    ...options.variables?.(input),
  }
  const startedAt = Date.now()
  const child = Bun.spawn(["sh", "-c", options.command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: commandEnvironment(variables),
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const durationMs = Date.now() - startedAt
  const artifacts = await writeArtifacts(
    resolve(options.artifactRoot ?? join(cwd, ".yrd-artifacts")),
    input,
    attempt,
    stdout,
    stderr,
  )
  const message = (stdout || stderr).trimEnd()
  const detail = message.length <= 2_000 ? message : message.slice(-2_000)
  return {
    result: { exitCode, stdout },
    evidence: {
      exitCode,
      durationMs,
      configHash,
      artifacts,
      ...(detail === "" ? {} : { detail }),
    },
  }
}

function waitingLaunch(stdout: string) {
  let parsed: unknown
  for (const line of stdout.trim().split(/\r?\n/u).reverse()) {
    try {
      parsed = JSON.parse(line)
      break
    } catch {}
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("waiting step launcher must print a JSON object containing token")
  }
  const value = parsed as Record<string, unknown>
  if (typeof value.token !== "string" || value.token.trim() === "") {
    throw new Error("waiting step launcher JSON token must be a non-empty string")
  }
  for (const field of ["url", "detail"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new Error(`waiting step launcher JSON ${field} must be a string`)
    }
  }
  if (value.artifacts !== undefined && !Array.isArray(value.artifacts)) {
    throw new Error("waiting step launcher JSON artifacts must be an array")
  }
  return {
    token: value.token,
    ...(value.url === undefined ? {} : { url: value.url as string }),
    ...(value.detail === undefined ? {} : { detail: value.detail as string }),
    artifacts: (value.artifacts ?? []) as readonly unknown[],
  }
}

type GitResult = { code: number; stdout: string; stderr: string }

async function git(repo: string, args: readonly string[], allowFailure = false): Promise<GitResult> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe", env: process.env })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (!allowFailure && code !== 0) throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed`)
  return { code, stdout: stdout.trim(), stderr: stderr.trim() }
}

async function commit(repo: string, ref: string): Promise<string> {
  return (await git(repo, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).stdout
}

async function withScratch<Result>(repo: string, ref: string, run: (path: string) => Promise<Result>): Promise<Result> {
  const root = await mkdtemp(join(tmpdir(), "yrd-line-"))
  const path = join(root, "worktree")
  let added = false
  try {
    await git(repo, ["worktree", "add", "--detach", path, ref])
    added = true
    return await run(path)
  } finally {
    if (added) await git(repo, ["worktree", "remove", "--force", path], true)
    await rm(root, { recursive: true, force: true })
  }
}

async function prepareCandidate(path: string, input: StepExecution): Promise<EffectOutcome<string>> {
  for (const submission of input.submissions) {
    const merged = await git(path, ["merge", "--no-ff", "--no-edit", submission.headSha], true)
    if (merged.code !== 0) {
      await git(path, ["merge", "--abort"], true)
      return failed(
        "candidate-conflict",
        `submission '${submission.id}' could not be applied to the line candidate: ${merged.stderr || merged.stdout}`,
      )
    }
  }
  return { status: "passed", output: await commit(path, "HEAD") }
}

export type GitCheckOptions = {
  repo: string
  command: string
  artifactRoot?: string
  purpose?: string
  runner?: "local" | "waiting"
  environment?: string
}

async function pinCandidate(repo: string, ref: string, sha: string): Promise<void> {
  const created = await git(repo, ["update-ref", "--create-reflog", ref, sha, "0".repeat(sha.length)], true)
  if (created.code === 0) return
  if ((await commit(repo, ref)) === sha) return
  throw new Error(created.stderr || created.stdout || `candidate ref '${ref}' already exists with a different commit`)
}

export function gitCheckStep(options: GitCheckOptions): StepRunner<SubmissionShape, GitCheckEvidence> {
  const repo = resolve(options.repo)
  return async (input, context) => {
    try {
      const purpose = options.purpose ?? "check"
      const branch = input.submission.base
      await git(repo, ["check-ref-format", "--branch", branch])
      const baseSha = await commit(repo, `refs/heads/${branch}`)
      return await withScratch(repo, baseSha, async (path) => {
        const candidate = await prepareCandidate(path, input)
        if (candidate.status !== "passed") return candidate
        const candidateRef = `refs/yrd/candidates/${input.run}/${input.step}/attempt-${context.attempt}`
        await pinCandidate(repo, candidateRef, candidate.output)
        const configured: ConfiguredCommandOptions<SubmissionShape> = {
          command: options.command,
          cwd: path,
          purpose,
          artifactRoot: options.artifactRoot ?? join(repo, ".git", "yrd", "artifacts"),
          variables: () => ({
            YRD_BASE_SHA: baseSha,
            YRD_CANDIDATE_SHA: candidate.output,
            ...(options.environment === undefined ? {} : { YRD_ENVIRONMENT: options.environment }),
          }),
        }
        const runner =
          options.runner === "waiting" ? configuredWaitingCommandStep(configured) : configuredCommandStep(configured)
        const outcome = await runner({ ...input, targetSha: candidate.output }, context)
        const evidence = { baseSha, candidateSha: candidate.output, candidateRef }
        if (outcome.status === "passed") return { ...outcome, output: { ...outcome.output, ...evidence } }
        if (outcome.status === "waiting") {
          return { ...outcome, checkpoint: { ...(outcome.checkpoint as CommandEvidence), ...evidence } }
        }
        return outcome
      })
    } catch (cause) {
      return failed("check-failed", cause instanceof Error ? cause.message : String(cause))
    }
  }
}

export type GitMergeOptions<_Shape extends SubmissionShape = SubmissionShape> = {
  repo: string
  command?: string
}

function checkedCandidate(shape: SubmissionShape): GitCheckEvidence | undefined {
  for (const value of Object.values(shape.results).reverse()) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue
    const evidence = value as Partial<GitCheckEvidence>
    if (
      typeof evidence.baseSha === "string" &&
      typeof evidence.candidateSha === "string" &&
      typeof evidence.candidateRef === "string" &&
      /^[0-9a-f]{40,64}$/iu.test(evidence.baseSha) &&
      /^[0-9a-f]{40,64}$/iu.test(evidence.candidateSha)
    ) {
      return evidence as GitCheckEvidence
    }
  }
  return undefined
}

async function checkedOutWorktree(repo: string, branchRef: string): Promise<string | undefined> {
  const listing = await git(repo, ["worktree", "list", "--porcelain"])
  for (const record of listing.stdout.split(/\n\n+/u)) {
    const lines = record.split("\n")
    if (lines.includes(`branch ${branchRef}`)) return lines.find((line) => line.startsWith("worktree "))?.slice(9)
  }
  return undefined
}

export function gitMergeStep<Shape extends SubmissionShape>(
  options: GitMergeOptions<Shape>,
): StepRunner<Shape, IntegrationProof> {
  if (options.command !== undefined) {
    throw new Error("yrd: custom integrations must be installed with withMerge()")
  }
  const repo = resolve(options.repo)
  return async (input): Promise<EffectOutcome<IntegrationProof>> => {
    try {
      const branch = input.submission.base
      await git(repo, ["check-ref-format", "--branch", branch])
      const baseRef = `refs/heads/${branch}`
      const baseSha = await commit(repo, baseRef)
      const checked = checkedCandidate(input.shape)
      if (checked === undefined) {
        return failed("check-missing", "merge requires a pinned check")
      }
      if (checked.baseSha !== baseSha) {
        return failed("stale-check", `line '${branch}' moved from checked base '${checked.baseSha}' to '${baseSha}'`)
      }
      if ((await commit(repo, checked.candidateRef)) !== checked.candidateSha) {
        return failed("stale-check", "checked candidate ref moved")
      }
      for (const sha of [checked.baseSha, ...input.submissions.map((submission) => submission.headSha)]) {
        if ((await git(repo, ["merge-base", "--is-ancestor", sha, checked.candidateSha], true)).code !== 0) {
          return failed("invalid-candidate", `checked candidate does not contain '${sha}'`)
        }
      }
      const checkedOut = await checkedOutWorktree(repo, baseRef)
      if (checkedOut !== undefined) {
        const status = await git(checkedOut, ["status", "--porcelain"])
        if (status.stdout !== "") {
          return failed("dirty-base", status.stdout)
        }
        if ((await commit(checkedOut, "HEAD")) !== baseSha) {
          return failed("stale-base", `${branch} moved before merge`)
        }
        const moved = await git(checkedOut, ["merge", "--ff-only", checked.candidateSha], true)
        if (moved.code !== 0) {
          return failed("stale-base", moved.stderr || "base branch moved")
        }
      } else {
        const moved = await git(repo, ["update-ref", baseRef, checked.candidateSha, baseSha], true)
        if (moved.code !== 0) {
          return failed("stale-base", moved.stderr || "base branch moved")
        }
      }
      return { status: "passed", output: { commit: checked.candidateSha, baseSha: checked.candidateSha } }
    } catch (cause) {
      return failed("merge-failed", cause instanceof Error ? cause.message : String(cause))
    }
  }
}

export function deployCommandStep(
  options: Omit<ConfiguredCommandOptions<IntegratedShape>, "purpose">,
): StepRunner<IntegratedShape, CommandEvidence> {
  return configuredCommandStep({
    ...options,
    purpose: "deploy",
    variables(input) {
      return {
        YRD_INTEGRATED_SHA: input.shape.integration.commit,
        ...options.variables?.(input),
      }
    },
  })
}
