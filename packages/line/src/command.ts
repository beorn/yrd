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
  candidateRef?: string
}

export type ConfiguredCommandOptions<Shape extends SubmissionShape> = {
  command: string
  cwd: string | ((input: StepExecution<Shape>) => string | Promise<string>)
  purpose: string
  artifactRoot?: string
  variables?: (input: StepExecution<Shape>) => Record<string, string | undefined>
}

export type ConfiguredWaitingCommandOptions<Shape extends SubmissionShape> = ConfiguredCommandOptions<Shape>

const RETIRED_PLACEHOLDERS = new Map([
  ["{name}", "$YRD_TASK"],
  ["{pr}", "$YRD_SUBMISSION"],
  ["{changeset}", "$YRD_SUBMISSION"],
  ["{sha}", "$YRD_SHA"],
  ["{target}", "$YRD_TARGET"],
  ["{base}", "$YRD_BASE"],
])

function commandHash(purpose: string, command: string): string {
  return createHash("sha256").update(purpose).update("\0").update(command.trim()).digest("hex")
}

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

async function runCommand(
  command: string,
  cwd: string,
  variables: Record<string, string | undefined>,
): Promise<{ exitCode: number; durationMs: number; stdout: string; stderr: string }> {
  const startedAt = Date.now()
  const child = Bun.spawn(["sh", "-c", command], {
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
  return { exitCode, durationMs: Date.now() - startedAt, stdout, stderr }
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
  if (stdout !== "") {
    const path = join(dir, "stdout.log")
    await writeFile(path, stdout)
    artifacts.push({ name: "stdout", path })
  }
  if (stderr !== "") {
    const path = join(dir, "stderr.log")
    await writeFile(path, stderr)
    artifacts.push({ name: "stderr", path })
  }
  return artifacts
}

function tail(text: string, max = 2_000): string {
  const trimmed = text.trimEnd()
  return trimmed.length <= max ? trimmed : trimmed.slice(-max)
}

export function configuredCommandStep<Shape extends SubmissionShape>(
  options: ConfiguredCommandOptions<Shape>,
): StepRunner<Shape, CommandEvidence> {
  validateCommand(options.command, options.purpose)
  const configHash = commandHash(options.purpose, options.command)
  return async (input, context): Promise<EffectOutcome<CommandEvidence>> => {
    const { result, evidence } = await executeConfiguredCommand(options, configHash, input, context.attempt)
    return result.exitCode === 0
      ? { status: "passed", output: evidence }
      : {
          status: "failed",
          error: {
            code: `${options.purpose}-failed`,
            message: `${options.purpose} command exited ${result.exitCode}${evidence.detail ? `: ${evidence.detail}` : ""}`,
          },
        }
  }
}

async function executeConfiguredCommand<Shape extends SubmissionShape>(
  options: ConfiguredCommandOptions<Shape>,
  configHash: string,
  input: StepExecution<Shape>,
  attempt: number,
): Promise<{
  result: { exitCode: number; durationMs: number; stdout: string; stderr: string }
  evidence: CommandEvidence
}> {
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
  const result = await runCommand(options.command, cwd, variables)
  const artifactRoot = resolve(options.artifactRoot ?? join(cwd, ".yrd-artifacts"))
  const artifacts = await writeArtifacts(artifactRoot, input, attempt, result.stdout, result.stderr)
  return {
    result,
    evidence: {
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      configHash,
      artifacts,
      ...(tail(result.stdout || result.stderr) === "" ? {} : { detail: tail(result.stdout || result.stderr) }),
    },
  }
}

type WaitingLaunch = {
  token: string
  url?: string
  detail?: string
  artifacts: readonly unknown[]
}

function waitingLaunch(stdout: string): WaitingLaunch {
  let parsed: unknown
  for (const line of stdout.trim().split(/\r?\n/u).reverse()) {
    if (line.trim() === "") continue
    try {
      parsed = JSON.parse(line)
      break
    } catch {
      continue
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("waiting step launcher must print a JSON object containing token")
  }
  const value = parsed as Record<string, unknown>
  if (typeof value.token !== "string" || value.token.trim() === "") {
    throw new Error("waiting step launcher JSON token must be a non-empty string")
  }
  if (value.url !== undefined && typeof value.url !== "string") {
    throw new Error("waiting step launcher JSON url must be a string")
  }
  if (value.detail !== undefined && typeof value.detail !== "string") {
    throw new Error("waiting step launcher JSON detail must be a string")
  }
  if (value.artifacts !== undefined && !Array.isArray(value.artifacts)) {
    throw new Error("waiting step launcher JSON artifacts must be an array")
  }
  return {
    token: value.token,
    ...(value.url === undefined ? {} : { url: value.url }),
    ...(value.detail === undefined ? {} : { detail: value.detail }),
    artifacts: value.artifacts ?? [],
  }
}

/** Launch a remote step and park its durable effect. The local command is only
 * a launcher; its immutable evidence is retained as the waiting checkpoint. */
export function configuredWaitingCommandStep<Shape extends SubmissionShape>(
  options: ConfiguredWaitingCommandOptions<Shape>,
): StepRunner<Shape, CommandEvidence> {
  validateCommand(options.command, options.purpose)
  const configHash = commandHash(options.purpose, options.command)
  return async (input, context): Promise<EffectOutcome<CommandEvidence>> => {
    const { result, evidence } = await executeConfiguredCommand(options, configHash, input, context.attempt)
    if (result.exitCode !== 0) {
      return {
        status: "failed",
        error: {
          code: `${options.purpose}-launcher-failed`,
          message: `${options.purpose} launcher exited ${result.exitCode}${evidence.detail ? `: ${evidence.detail}` : ""}`,
        },
      }
    }
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
      return {
        status: "failed",
        error: {
          code: `${options.purpose}-launcher-invalid`,
          message: cause instanceof Error ? cause.message : String(cause),
        },
      }
    }
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
  return (await git(repo, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout
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
      return {
        status: "failed",
        error: {
          code: "candidate-conflict",
          message: `submission '${submission.id}' could not be applied to the line candidate: ${merged.stderr || merged.stdout}`,
        },
      }
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
  const existing = await git(repo, ["rev-parse", "--verify", `${ref}^{commit}`], true)
  if (existing.code === 0 && existing.stdout === sha) return
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
        const configured = {
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
        if (options.runner === "waiting") {
          const candidateRef = `refs/yrd/candidates/${input.run}/${input.step}/attempt-${context.attempt}`
          await pinCandidate(repo, candidateRef, candidate.output)
          const outcome = await configuredWaitingCommandStep<SubmissionShape>(configured)(
            { ...input, targetSha: candidate.output },
            context,
          )
          if (outcome.status === "waiting") {
            return {
              ...outcome,
              checkpoint: {
                ...(outcome.checkpoint as CommandEvidence),
                baseSha,
                candidateSha: candidate.output,
                candidateRef,
              },
            }
          }
          return outcome.status === "passed"
            ? {
                status: "passed",
                output: { ...outcome.output, baseSha, candidateSha: candidate.output, candidateRef },
              }
            : outcome
        }
        const runner = configuredCommandStep<SubmissionShape>(configured)
        const outcome = await runner({ ...input, targetSha: candidate.output }, context)
        return outcome.status === "passed"
          ? {
              status: "passed",
              output: { ...outcome.output, baseSha, candidateSha: candidate.output },
            }
          : outcome
      })
    } catch (cause) {
      return {
        status: "failed",
        error: { code: "check-failed", message: cause instanceof Error ? cause.message : String(cause) },
      }
    }
  }
}

export type GitMergeOptions<Shape extends SubmissionShape = SubmissionShape> = {
  repo: string
  command?: string
  checkedBaseSha?: (input: StepExecution<Shape>) => string | undefined
}

function checkedBaseFrom(shape: SubmissionShape): string | undefined {
  const values = Object.values(shape.results).reverse()
  for (const value of values) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue
    const baseSha = (value as { baseSha?: unknown }).baseSha
    if (typeof baseSha === "string" && /^[0-9a-f]{40,64}$/iu.test(baseSha)) return baseSha
  }
  return undefined
}

async function checkedOutWorktree(repo: string, branchRef: string): Promise<string | undefined> {
  const listing = await git(repo, ["worktree", "list", "--porcelain"])
  for (const record of listing.stdout.split(/\n\n+/u)) {
    const fields = new Map(
      record.split("\n").map((line) => [line.split(" ", 1)[0]!, line.slice(line.indexOf(" ") + 1)]),
    )
    if (fields.get("branch") === branchRef) return fields.get("worktree")
  }
  return undefined
}

async function mergeAt(
  path: string,
  input: StepExecution,
  branch: string,
  baseSha: string,
  command: string | undefined,
): Promise<EffectOutcome<IntegrationProof>> {
  if (command === undefined) {
    const candidate = await prepareCandidate(path, input)
    if (candidate.status !== "passed") return candidate
  } else {
    validateCommand(command, "merge")
    const result = await runCommand(command, path, {
      YRD_BASE: branch,
      YRD_BASE_SHA: baseSha,
      YRD_SHA: input.submission.headSha,
      YRD_SHAS: JSON.stringify(input.submissions.map((submission) => submission.headSha)),
      YRD_SUBMISSION: input.submission.id,
      YRD_SUBMISSIONS: JSON.stringify(input.submissions.map((submission) => submission.id)),
      YRD_TARGET: input.submission.headSha,
    })
    if (result.exitCode !== 0) {
      return {
        status: "failed",
        error: { code: "merge-command-failed", message: tail(result.stderr || result.stdout) },
      }
    }
  }
  const landed = await commit(path, "HEAD")
  for (const submission of input.submissions) {
    const ancestor = await git(path, ["merge-base", "--is-ancestor", submission.headSha, landed], true)
    if (ancestor.code !== 0) {
      return {
        status: "failed",
        error: { code: "lying-merge", message: `submitted commit '${submission.headSha}' is not in merge result` },
      }
    }
  }
  return { status: "passed", output: { commit: landed, baseSha: landed } }
}

export function gitMergeStep<Shape extends SubmissionShape>(
  options: GitMergeOptions<Shape>,
): StepRunner<Shape, IntegrationProof> {
  const repo = resolve(options.repo)
  return async (input): Promise<EffectOutcome<IntegrationProof>> => {
    try {
      const branch = input.submission.base
      await git(repo, ["check-ref-format", "--branch", branch])
      const baseRef = `refs/heads/${branch}`
      const baseSha = await commit(repo, baseRef)
      const checkedBaseSha = options.checkedBaseSha?.(input) ?? checkedBaseFrom(input.shape)
      if (checkedBaseSha !== undefined && checkedBaseSha !== baseSha) {
        return {
          status: "failed",
          error: {
            code: "stale-check",
            message: `line '${branch}' moved from checked base '${checkedBaseSha}' to '${baseSha}'`,
          },
        }
      }
      const checkedOut = await checkedOutWorktree(repo, baseRef)
      if (checkedOut !== undefined) {
        const status = await git(checkedOut, ["status", "--porcelain"])
        if (status.stdout !== "") {
          return { status: "failed", error: { code: "dirty-base", message: status.stdout } }
        }
        if ((await commit(checkedOut, "HEAD")) !== baseSha) {
          return { status: "failed", error: { code: "stale-base", message: `${branch} moved before merge` } }
        }
      }
      return await withScratch(repo, baseSha, async (path) => {
        const result = await mergeAt(path, input, branch, baseSha, options.command)
        if (result.status !== "passed") return result
        const landed = result.output.commit
        if (checkedOut !== undefined) {
          const status = await git(checkedOut, ["status", "--porcelain"])
          if (status.stdout !== "" || (await commit(checkedOut, "HEAD")) !== baseSha) {
            return { status: "failed", error: { code: "stale-base", message: `${branch} moved before merge` } }
          }
          const moved = await git(checkedOut, ["merge", "--ff-only", landed], true)
          if (moved.code !== 0) {
            return { status: "failed", error: { code: "stale-base", message: moved.stderr || "base branch moved" } }
          }
          return result
        }
        const moved = await git(repo, ["update-ref", baseRef, landed, baseSha], true)
        if (moved.code !== 0) {
          return { status: "failed", error: { code: "stale-base", message: moved.stderr || "base branch moved" } }
        }
        return result
      })
    } catch (cause) {
      return {
        status: "failed",
        error: { code: "merge-failed", message: cause instanceof Error ? cause.message : String(cause) },
      }
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
