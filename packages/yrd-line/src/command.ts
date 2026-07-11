import { createHash } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { JsonValue } from "@yrd/core"
import { parseJobLaunch, type JobResult } from "@yrd/job"
import type { Process } from "@yrd/process"
import * as z from "zod"
import type { IntegratedShape, IntegrationProof, PRShape } from "./model.ts"
import { IntegrationProofSchema } from "./model.ts"
import type { StepExecution, StepRunner } from "./line.ts"

export const StepArtifactSchema = z.object({ name: z.string().min(1), path: z.string().min(1) }).strict()
export type StepArtifact = Readonly<z.infer<typeof StepArtifactSchema>>

export const CommandEvidenceSchema = z
  .object({
    exitCode: z.number().int(),
    durationMs: z.number().nonnegative(),
    configHash: z.string().regex(/^[0-9a-f]{64}$/u),
    artifacts: z.array(StepArtifactSchema),
    detail: z.string().optional(),
    /** True when the command was settled by its wall-clock bound (21012 S1). */
    timedOut: z.boolean().optional(),
  })
  .strict()
export type CommandEvidence = Readonly<z.infer<typeof CommandEvidenceSchema>>

export const GitCheckEvidenceSchema = CommandEvidenceSchema.extend({
  baseSha: z.string().regex(/^[0-9a-f]{40,64}$/iu),
  candidateSha: z.string().regex(/^[0-9a-f]{40,64}$/iu),
  candidateRef: z.string().min(1),
}).strict()
export type GitCheckEvidence = Readonly<z.infer<typeof GitCheckEvidenceSchema>>

type ProcessDependency = Readonly<{ inject: Readonly<{ process: Pick<Process, "run"> }> }>

export type ConfiguredCommandOptions<Shape extends PRShape> = ProcessDependency &
  Readonly<{
    command: string
    cwd: string | ((input: StepExecution<Shape>) => string | Promise<string>)
    purpose: string
    artifactRoot?: string
    env?: NodeJS.ProcessEnv
    timeoutMs?: number
    variables?: (input: StepExecution<Shape>) => Readonly<Record<string, string | undefined>>
  }>

export type ConfiguredWaitingCommandOptions<Shape extends PRShape> = ConfiguredCommandOptions<Shape>

const RETIRED_PLACEHOLDERS = new Map([
  ["{name}", "$YRD_TASK"],
  ["{pr}", "$YRD_PR"],
  ["{changeset}", "$YRD_PR"],
  ["{sha}", "$YRD_SHA"],
  ["{target}", "$YRD_TARGET"],
  ["{base}", "$YRD_BASE"],
])

export function configuredCommandStep<Shape extends PRShape>(
  options: ConfiguredCommandOptions<Shape>,
): StepRunner<Shape, CommandEvidence> {
  return configuredCommand(options, false)
}

export function configuredWaitingCommandStep<Shape extends PRShape>(
  options: ConfiguredWaitingCommandOptions<Shape>,
): StepRunner<Shape, CommandEvidence> {
  return configuredCommand(options, true)
}

function configuredCommand<Shape extends PRShape>(
  options: ConfiguredCommandOptions<Shape>,
  waiting: boolean,
): StepRunner<Shape, CommandEvidence> {
  validateCommand(options.command, options.purpose)
  const configHash = createHash("sha256")
    .update(options.purpose)
    .update("\0")
    .update(options.command.trim())
    .digest("hex")
  return async (input, context): Promise<JobResult<CommandEvidence>> => {
    const { process } = options.inject
    const primary = primaryPR(input)
    const cwd = resolve(typeof options.cwd === "function" ? await options.cwd(input) : options.cwd)
    const variables = {
      YRD_BASE: primary.base,
      YRD_BASE_SHA: primary.baseSha,
      YRD_JOB: context.id,
      YRD_ATTEMPT: String(context.attempt),
      YRD_EXECUTOR: context.executor,
      YRD_RUN: input.run,
      YRD_SHA: primary.headSha,
      YRD_SHAS: JSON.stringify(input.prs.map((pr) => pr.headSha)),
      YRD_STEP: input.step,
      YRD_PR: primary.id,
      YRD_PRS: JSON.stringify(input.prs.map((pr) => pr.id)),
      YRD_TARGET: input.targetSha ?? primary.headSha,
      ...options.variables?.(input),
    }
    const result = await process.run({
      argv: ["sh", "-c", options.command],
      cwd,
      env: commandEnvironment(options.env ?? globalThis.process.env, variables),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    })
    const artifacts = await writeArtifacts(
      resolve(options.artifactRoot ?? join(cwd, ".yrd-artifacts")),
      input,
      context.attempt,
      result.stdout,
      result.stderr,
    )
    const message = (result.stdout || result.stderr).trimEnd()
    const detail = message.length <= 2_000 ? message : message.slice(-2_000)
    const evidence = CommandEvidenceSchema.parse({
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      configHash,
      artifacts,
      ...(detail === "" ? {} : { detail }),
      ...(result.timedOut ? { timedOut: true } : {}),
    })
    // 21012 S1: a wall-clock settlement is a NAMED failure class, never a
    // generic exit red — the journal evidence must say the bound fired (and
    // whether the tree sweep itself failed), so a wedged step self-diagnoses.
    if (result.timedOut) {
      const action = waiting ? "launcher" : "command"
      return failed(
        `${options.purpose}-timeout`,
        `${options.purpose} ${action} exceeded its ${options.timeoutMs ?? result.durationMs}ms wall-clock bound — process tree settled` +
          (result.sweepFailure === undefined ? "" : ` (${result.sweepFailure})`),
      )
    }
    if (result.exitCode !== 0) {
      const action = waiting ? "launcher" : "command"
      return failed(
        `${options.purpose}${waiting ? "-launcher" : ""}-failed`,
        `${options.purpose} ${action} exited ${result.exitCode}${evidence.detail ? `: ${evidence.detail}` : ""}`,
      )
    }
    if (!waiting) return { status: "passed", output: evidence }
    try {
      const launch = parseJobLaunch(result.stdout)
      return {
        status: "waiting",
        token: launch.token,
        ...(launch.url === undefined ? {} : { url: launch.url }),
        ...(launch.detail === undefined ? {} : { detail: launch.detail }),
        artifacts: [...evidence.artifacts, ...(launch.artifacts ?? [])],
        checkpoint: evidence,
      }
    } catch (cause) {
      return failed(`${options.purpose}-launcher-invalid`, messageOf(cause))
    }
  }
}

function commandEnvironment(
  source: NodeJS.ProcessEnv,
  variables: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
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

type GitResult = Readonly<{ code: number; stdout: string; stderr: string }>
type Git = ReturnType<typeof createGit>

function createGit(process: Pick<Process, "run">, environment: NodeJS.ProcessEnv = globalThis.process.env) {
  const env = Object.fromEntries(
    Object.entries(environment).filter(([key, value]) => value !== undefined && !key.startsWith("GIT_")),
  ) as Record<string, string>
  const run = async (repo: string, args: readonly string[], allowFailure = false): Promise<GitResult> => {
    const result = await process.run({ argv: ["git", "-C", repo, ...args], cwd: repo, env })
    const completed = { code: result.exitCode, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
    if (!allowFailure && completed.code !== 0) {
      throw new Error(completed.stderr || completed.stdout || `git ${args.join(" ")} failed`)
    }
    return completed
  }
  const commit = async (repo: string, ref: string): Promise<string> =>
    (await run(repo, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).stdout
  const optionalCommit = async (repo: string, ref: string): Promise<string | undefined> => {
    const result = await run(repo, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], true)
    return result.code === 0 ? result.stdout : undefined
  }
  return Object.freeze({ run, commit, optionalCommit })
}

type LineBase = Readonly<{ branchRef: string; sha: string; local: boolean }>

async function resolveLineBase(git: Git, repo: string, branch: string): Promise<LineBase> {
  await git.run(repo, ["check-ref-format", "--branch", branch])
  const branchRef = `refs/heads/${branch}`
  const local = await git.optionalCommit(repo, branchRef)
  if (local !== undefined) return { branchRef, sha: local, local: true }
  const sourceRef = `refs/remotes/origin/${branch}`
  const remote = await git.optionalCommit(repo, sourceRef)
  if (remote !== undefined) return { branchRef, sha: remote, local: false }
  throw new Error(`yrd: line base '${branch}' does not resolve as '${branchRef}' or '${sourceRef}'`)
}

async function withScratch(
  git: Git,
  repo: string,
  ref: string,
  parent: string,
  run: (path: string) => Promise<JobResult<GitCheckEvidence>>,
): Promise<JobResult<GitCheckEvidence>> {
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(await realpath(parent), "yrd-line-"))
  const path = join(root, "worktree")
  let added = false
  let outcome: JobResult<GitCheckEvidence> | undefined
  let operationFailure: unknown
  try {
    await git.run(repo, ["worktree", "add", "--detach", path, ref])
    added = true
    outcome = await run(path)
  } catch (cause) {
    operationFailure = cause
  }

  let cleanupFailure: string | undefined
  let removed = !added
  if (added) {
    try {
      const cleanup = await git.run(repo, ["worktree", "remove", "--force", path], true)
      if (cleanup.code === 0) removed = true
      else cleanupFailure = cleanup.stderr || cleanup.stdout || "could not remove scratch worktree"
    } catch (cause) {
      cleanupFailure = messageOf(cause)
    }
  }
  if (removed) {
    try {
      await rm(root, { recursive: true, force: true })
    } catch (cause) {
      cleanupFailure ??= messageOf(cause)
    }
  }

  if (operationFailure !== undefined) throw operationFailure
  if (outcome === undefined) throw new Error("scratch worktree produced no result")
  if (outcome.status === "failed" || cleanupFailure === undefined) return outcome
  return failed("scratch-cleanup-failed", cleanupFailure)
}

async function prepareCandidate(git: Git, path: string, input: StepExecution): Promise<JobResult<string>> {
  for (const pr of input.prs) {
    const merged = await git.run(path, ["merge", "--no-ff", "--no-edit", pr.headSha], true)
    if (merged.code !== 0) {
      await git.run(path, ["merge", "--abort"], true)
      return failed("candidate-conflict", `PR '${pr.id}' could not be applied: ${merged.stderr || merged.stdout}`)
    }
  }
  return { status: "passed", output: await git.commit(path, "HEAD") }
}

export type GitCheckOptions = ProcessDependency &
  Readonly<{
    repo: string
    command: string
    checkoutParent?: string
    artifactRoot?: string
    purpose?: string
    runner?: "local" | "waiting"
    environment?: string
    env?: NodeJS.ProcessEnv
    timeoutMs?: number
  }>

async function pinCandidate(git: Git, repo: string, ref: string, sha: string): Promise<void> {
  const created = await git.run(repo, ["update-ref", "--create-reflog", ref, sha, "0".repeat(sha.length)], true)
  if (created.code === 0 || (await git.commit(repo, ref)) === sha) return
  throw new Error(created.stderr || created.stdout || `candidate ref '${ref}' has a different commit`)
}

export function gitCheckStep(options: GitCheckOptions): StepRunner<PRShape, GitCheckEvidence> {
  const repo = resolve(options.repo)
  const git = createGit(options.inject.process, options.env)
  return async (input, context): Promise<JobResult<GitCheckEvidence>> => {
    try {
      const purpose = options.purpose ?? "check"
      const branch = primaryPR(input).base
      const baseSha = (await resolveLineBase(git, repo, branch)).sha
      return await withScratch(
        git,
        repo,
        baseSha,
        options.checkoutParent ?? tmpdir(),
        async (path): Promise<JobResult<GitCheckEvidence>> => {
          const candidate = await prepareCandidate(git, path, input)
          if (candidate.status === "failed") return { status: "failed", error: candidate.error }
          if (candidate.status === "waiting") throw new Error("candidate preparation cannot wait")
          const candidateRef = `refs/yrd/candidates/${input.run}/${input.step}/attempt-${context.attempt}`
          await pinCandidate(git, repo, candidateRef, candidate.output)
          const configured: ConfiguredCommandOptions<PRShape> = {
            inject: options.inject,
            command: options.command,
            cwd: path,
            purpose,
            artifactRoot: options.artifactRoot ?? join(repo, ".git", "yrd", "artifacts"),
            ...(options.env === undefined ? {} : { env: options.env }),
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
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
          if (outcome.status === "passed") {
            return { status: "passed", output: GitCheckEvidenceSchema.parse({ ...outcome.output, ...evidence }) }
          }
          if (outcome.status === "waiting") {
            return {
              ...outcome,
              checkpoint: GitCheckEvidenceSchema.parse({ ...(outcome.checkpoint as CommandEvidence), ...evidence }),
            }
          }
          return { status: "failed", error: outcome.error }
        },
      )
    } catch (cause) {
      return failed("check-failed", messageOf(cause))
    }
  }
}

export type GitMergeOptions = ProcessDependency & Readonly<{ repo: string; env?: NodeJS.ProcessEnv }>

function checkedCandidate(shape: PRShape): GitCheckEvidence | undefined {
  for (const value of Object.values(shape.results).reverse()) {
    const parsed = GitCheckEvidenceSchema.safeParse(value)
    if (parsed.success) return parsed.data
  }
  return undefined
}

async function checkedOutWorktree(git: Git, repo: string, branchRef: string): Promise<string | undefined> {
  const listing = await git.run(repo, ["worktree", "list", "--porcelain"])
  for (const record of listing.stdout.split(/\n\n+/u)) {
    const lines = record.split("\n")
    if (lines.includes(`branch ${branchRef}`)) return lines.find((line) => line.startsWith("worktree "))?.slice(9)
  }
  return undefined
}

export function gitMergeStep<Shape extends PRShape>(options: GitMergeOptions): StepRunner<Shape, IntegrationProof> {
  const repo = resolve(options.repo)
  const git = createGit(options.inject.process, options.env)
  return async (input): Promise<JobResult<IntegrationProof>> => {
    try {
      const branch = primaryPR(input).base
      const base = await resolveLineBase(git, repo, branch)
      const baseSha = base.sha
      const checked = checkedCandidate(input.shape)
      if (checked === undefined) return failed("check-missing", "merge requires a pinned check")
      if (checked.baseSha !== baseSha) {
        return failed("stale-check", `line '${branch}' moved from checked base '${checked.baseSha}' to '${baseSha}'`)
      }
      if ((await git.commit(repo, checked.candidateRef)) !== checked.candidateSha) {
        return failed("stale-check", "checked candidate ref moved")
      }
      for (const sha of [checked.baseSha, ...input.prs.map((pr) => pr.headSha)]) {
        if ((await git.run(repo, ["merge-base", "--is-ancestor", sha, checked.candidateSha], true)).code !== 0) {
          return failed("invalid-candidate", `checked candidate does not contain '${sha}'`)
        }
      }
      const checkedOut = await checkedOutWorktree(git, repo, base.branchRef)
      if (checkedOut !== undefined) {
        const status = await git.run(checkedOut, ["status", "--porcelain"])
        if (status.stdout !== "") return failed("dirty-base", status.stdout)
        if ((await git.commit(checkedOut, "HEAD")) !== baseSha) return failed("stale-base", `${branch} moved`)
        const moved = await git.run(checkedOut, ["merge", "--ff-only", checked.candidateSha], true)
        if (moved.code !== 0) return failed("stale-base", moved.stderr || "base branch moved")
      } else {
        const expected = base.local ? baseSha : "0".repeat(baseSha.length)
        const moved = await git.run(repo, ["update-ref", base.branchRef, checked.candidateSha, expected], true)
        if (moved.code !== 0) return failed("stale-base", moved.stderr || "base branch moved")
      }
      return {
        status: "passed",
        output: IntegrationProofSchema.parse({ commit: checked.candidateSha, baseSha: checked.candidateSha }),
      }
    } catch (cause) {
      return failed("merge-failed", messageOf(cause))
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

function primaryPR(input: StepExecution): StepExecution["prs"][number] {
  const primary = input.prs[0]
  if (primary === undefined) throw new Error(`yrd: line run '${input.run}' has no PR`)
  return primary
}

function failed<Output extends JsonValue = JsonValue>(code: string, message: string): JobResult<Output> {
  return { status: "failed", error: { code, message } }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
