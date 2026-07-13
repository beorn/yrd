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
import type { StepExecution, StepRunner } from "./queue.ts"

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
    stageVerdict: z.enum(["EXITED", "TIMED_OUT", "STALLED"]).optional(),
    lastProgressAtMs: z.number().nonnegative().optional(),
    lastProgressBytes: z.number().int().nonnegative().optional(),
    sweepFailure: z.string().min(1).optional(),
  })
  .strict()
export type CommandEvidence = Readonly<z.infer<typeof CommandEvidenceSchema>>

export const GitCheckEvidenceSchema = CommandEvidenceSchema.extend({
  baseSha: z.string().regex(/^[0-9a-f]{40,64}$/iu),
  candidateSha: z.string().regex(/^[0-9a-f]{40,64}$/iu),
  candidateRef: z.string().min(1),
}).strict()
export type GitCheckEvidence = Readonly<z.infer<typeof GitCheckEvidenceSchema>>

export const GitCheckFailureEvidenceSchema = z.object({ artifacts: z.array(StepArtifactSchema) }).strict()
export type GitCheckFailureEvidence = Readonly<z.infer<typeof GitCheckFailureEvidenceSchema>>

export const GitCheckResultEvidenceSchema = z.union([GitCheckEvidenceSchema, GitCheckFailureEvidenceSchema])
export type GitCheckResultEvidence = Readonly<z.infer<typeof GitCheckResultEvidenceSchema>>

type ProcessDependency = Readonly<{ inject: Readonly<{ process: Pick<Process, "run"> }> }>
type ProgressResult = Readonly<{
  verdict?: "EXITED" | "TIMED_OUT" | "STALLED"
  stalled?: boolean
  lastProgressAtMs?: number
  lastProgressBytes?: number
}>

export type ConfiguredCommandOptions<Shape extends PRShape> = ProcessDependency &
  Readonly<{
    command: readonly string[]
    cwd: string | ((input: StepExecution<Shape>) => string | Promise<string>)
    purpose: string
    artifactRoot?: string
    env?: NodeJS.ProcessEnv
    timeoutMs?: number
    noProgressTimeoutMs?: number
    variables?: (input: StepExecution<Shape>) => Readonly<Record<string, string | undefined>>
  }>

export type ConfiguredWaitingCommandOptions<Shape extends PRShape> = ConfiguredCommandOptions<Shape>

const RETIRED_PLACEHOLDERS = new Map([
  ["{name}", "$YRD_ISSUE"],
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
  const argv = validateCommand(options.command, options.purpose)
  const configHash = createHash("sha256")
    .update(options.purpose)
    .update("\0")
    .update(JSON.stringify(argv))
    .digest("hex")
  return async (input, context): Promise<JobResult<CommandEvidence>> => {
    context.observeProgress?.()
    const { process } = options.inject
    const primary = primaryPR(input)
    const cwd = resolve(typeof options.cwd === "function" ? await options.cwd(input) : options.cwd)
    const variables = {
      YRD_BASE: primary.base,
      YRD_BASE_SHA: primary.baseSha,
      YRD_JOB: context.id,
      YRD_ATTEMPT: String(context.attempt),
      YRD_RUNNER: context.runner,
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
      argv,
      cwd,
      env: commandEnvironment(options.env ?? globalThis.process.env, variables),
      signal: context.signal,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.noProgressTimeoutMs === undefined ? {} : { noProgressTimeoutMs: options.noProgressTimeoutMs }),
      onOutput: () => context.reportProgress?.(),
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
    const progress = result as typeof result & ProgressResult
    const evidence = CommandEvidenceSchema.parse({
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      configHash,
      artifacts,
      ...(detail === "" ? {} : { detail }),
      ...(result.timedOut ? { timedOut: true } : {}),
      ...(progress.verdict === undefined ? {} : { stageVerdict: progress.verdict }),
      ...(progress.lastProgressAtMs === undefined ? {} : { lastProgressAtMs: progress.lastProgressAtMs }),
      ...(progress.lastProgressBytes === undefined ? {} : { lastProgressBytes: progress.lastProgressBytes }),
      ...(result.sweepFailure === undefined ? {} : { sweepFailure: result.sweepFailure }),
    })
    if (progress.stalled === true) {
      if (options.noProgressTimeoutMs === undefined) {
        throw new Error(`${options.purpose} reported an unconfigured output-progress stall`)
      }
      return failed(
        `${options.purpose}-stalled`,
        `${options.purpose} stalled after ${options.noProgressTimeoutMs}ms without progress`,
        evidence,
      )
    }
    // 21012 S1: a wall-clock settlement is a NAMED failure class, never a
    // generic exit red — the journal evidence must say the bound fired (and
    // whether the tree sweep itself failed), so a wedged step self-diagnoses.
    if (result.timedOut) {
      const action = waiting ? "launcher" : "command"
      return failed(
        `${options.purpose}-timeout`,
        `${options.purpose} ${action} exceeded its ${options.timeoutMs ?? result.durationMs}ms wall-clock bound`,
        evidence,
      )
    }
    if (result.exitCode !== 0) {
      const action = waiting ? "launcher" : "command"
      return failed(
        `${options.purpose}${waiting ? "-launcher" : ""}-failed`,
        `${options.purpose} ${action} exited ${result.exitCode}`,
        evidence,
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
      return failed(`${options.purpose}-launcher-invalid`, messageOf(cause), evidence)
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

function validateCommand(command: unknown, purpose: string): readonly string[] {
  if (!Array.isArray(command)) {
    throw new TypeError(`yrd: ${purpose} command must be an argv array; wrap shell text with shellCommand()`)
  }
  const argv: string[] = []
  for (const arg of command as readonly unknown[]) {
    if (typeof arg !== "string" || arg.length === 0) {
      throw new TypeError(`yrd: ${purpose} command argv must contain non-empty strings`)
    }
    argv.push(arg)
  }
  if (argv.length === 0) throw new TypeError(`yrd: ${purpose} command argv must contain non-empty strings`)
  for (const [placeholder, replacement] of RETIRED_PLACEHOLDERS) {
    if (argv.some((arg) => arg.includes(placeholder))) {
      throw new Error(`yrd: ${purpose} command placeholder ${placeholder} is retired; use ${replacement}`)
    }
  }
  return Object.freeze(argv)
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

export type GitQueueTarget = Readonly<{
  branch: string
  branchRef: string
  sha: string
  local: boolean
  localSha?: string
  remote?: string
  remoteSha?: string
  diverged: boolean
}>

async function inspectQueueBase(git: Git, repo: string, branch: string): Promise<GitQueueTarget> {
  await git.run(repo, ["check-ref-format", "--branch", branch])
  const branchRef = `refs/heads/${branch}`
  const local = await git.optionalCommit(repo, branchRef)
  const sourceRef = `refs/remotes/origin/${branch}`
  const remote = await git.optionalCommit(repo, sourceRef)
  const configuredRemote = await git.run(repo, ["config", "--get", "remote.origin.url"], true)
  const remoteIsAuthoritative = configuredRemote.code === 0 && configuredRemote.stdout !== "" && remote !== undefined
  if (remoteIsAuthoritative) {
    return {
      branch,
      branchRef,
      sha: remote,
      local: false,
      ...(local === undefined ? {} : { localSha: local }),
      remote: "origin",
      remoteSha: remote,
      diverged: local !== undefined && local !== remote,
    }
  }
  if (local !== undefined) {
    return {
      branch,
      branchRef,
      sha: local,
      local: true,
      localSha: local,
      ...(remote === undefined ? {} : { remoteSha: remote }),
      diverged: false,
    }
  }
  if (remote !== undefined) {
    return {
      branch,
      branchRef,
      sha: remote,
      local: false,
      remoteSha: remote,
      diverged: false,
    }
  }
  throw new Error(`yrd: queue base '${branch}' does not resolve as '${branchRef}' or '${sourceRef}'`)
}

export async function inspectGitQueueTarget(options: {
  inject: Readonly<{ process: Pick<Process, "run"> }>
  repo: string
  branch: string
  env?: NodeJS.ProcessEnv
}): Promise<GitQueueTarget> {
  const repo = resolve(options.repo)
  return inspectQueueBase(createGit(options.inject.process, options.env), repo, options.branch)
}

async function withScratch<Output extends JsonValue>(
  git: Git,
  repo: string,
  ref: string,
  parent: string,
  run: (path: string) => Promise<JobResult<Output>>,
): Promise<JobResult<Output>> {
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(await realpath(parent), "yrd-queue-"))
  const path = join(root, "worktree")
  let added = false
  let outcome: JobResult<Output> | undefined
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

async function prepareCandidate(
  git: Git,
  path: string,
  input: StepExecution,
  attempt: number,
  artifactRoot: string,
): Promise<
  | Readonly<{ status: "passed"; output: string }>
  | Readonly<{ status: "failed"; error: Readonly<{ code: string; message: string }>; output: GitCheckFailureEvidence }>
> {
  for (const pr of input.prs) {
    const merged = await git.run(path, ["merge", "--no-ff", "--no-edit", pr.headSha], true)
    if (merged.code !== 0) {
      const artifacts = await writeArtifacts(artifactRoot, input, attempt, merged.stdout, merged.stderr)
      await git.run(path, ["merge", "--abort"], true)
      return {
        status: "failed",
        error: {
          code: "candidate-conflict",
          message: `PR '${pr.id}' could not be applied: ${merged.stderr || merged.stdout}`,
        },
        output: GitCheckFailureEvidenceSchema.parse({ artifacts }),
      }
    }
  }
  return { status: "passed", output: await git.commit(path, "HEAD") }
}

export type GitCheckOptions = ProcessDependency &
  Readonly<{
    repo: string
    command: readonly string[]
    checkoutParent?: string
    artifactRoot?: string
    purpose?: string
    runner?: "local" | "waiting"
    environment?: string
    env?: NodeJS.ProcessEnv
    timeoutMs?: number
    noProgressTimeoutMs?: number
  }>

async function pinCandidate(git: Git, repo: string, ref: string, sha: string): Promise<void> {
  const created = await git.run(repo, ["update-ref", "--create-reflog", ref, sha, "0".repeat(sha.length)], true)
  if (created.code === 0 || (await git.commit(repo, ref)) === sha) return
  throw new Error(created.stderr || created.stdout || `candidate ref '${ref}' has a different commit`)
}

function candidateRef(input: Pick<StepExecution, "run" | "step">, job: string, attempt: number, sha: string): string {
  const identity = createHash("sha256")
    .update(job)
    .update("\0")
    .update(String(attempt))
    .update("\0")
    .update(sha)
    .digest("hex")
  return `refs/yrd/candidates/${input.run}/${input.step}/attempt-${attempt}-${identity}`
}

export function gitCheckStep(options: GitCheckOptions): StepRunner<PRShape, GitCheckResultEvidence> {
  const repo = resolve(options.repo)
  const git = createGit(options.inject.process, options.env)
  return async (input, context): Promise<JobResult<GitCheckResultEvidence>> => {
    try {
      const purpose = options.purpose ?? "check"
      const branch = primaryPR(input).base
      const target = await authoritativeQueueBase(git, repo, branch)
      if (target.diverged) {
        return failed(
          "queue-target-diverged",
          `queue '${branch}' local ${target.localSha?.slice(0, 12)} differs from authoritative ` +
            `${target.remote}/${branch} ${target.remoteSha?.slice(0, 12)}; align the local branch before integration`,
        )
      }
      const baseSha = target.sha
      return await withScratch(
        git,
        repo,
        baseSha,
        options.checkoutParent ?? tmpdir(),
        async (path): Promise<JobResult<GitCheckResultEvidence>> => {
          const candidate = await prepareCandidate(
            git,
            path,
            input,
            context.attempt,
            resolve(options.artifactRoot ?? join(repo, ".git", "yrd", "artifacts")),
          )
          if (candidate.status === "failed") return candidate
          const ref = candidateRef(input, context.id, context.attempt, candidate.output)
          await pinCandidate(git, repo, ref, candidate.output)
          const configured: ConfiguredCommandOptions<PRShape> = {
            inject: options.inject,
            command: options.command,
            cwd: path,
            purpose,
            artifactRoot: options.artifactRoot ?? join(repo, ".git", "yrd", "artifacts"),
            ...(options.env === undefined ? {} : { env: options.env }),
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            ...(options.noProgressTimeoutMs === undefined ? {} : { noProgressTimeoutMs: options.noProgressTimeoutMs }),
            variables: () => ({
              YRD_BASE_SHA: baseSha,
              YRD_CANDIDATE_SHA: candidate.output,
              ...(options.environment === undefined ? {} : { YRD_ENVIRONMENT: options.environment }),
            }),
          }
          const runner =
            options.runner === "waiting" ? configuredWaitingCommandStep(configured) : configuredCommandStep(configured)
          const outcome = await runner({ ...input, targetSha: candidate.output }, context)
          const evidence = { baseSha, candidateSha: candidate.output, candidateRef: ref }
          if (outcome.status === "passed") {
            return { status: "passed", output: GitCheckEvidenceSchema.parse({ ...outcome.output, ...evidence }) }
          }
          if (outcome.status === "waiting") {
            return {
              ...outcome,
              checkpoint: GitCheckEvidenceSchema.parse({ ...(outcome.checkpoint as CommandEvidence), ...evidence }),
            }
          }
          return {
            status: "failed",
            error: outcome.error,
            ...(outcome.output === undefined
              ? {}
              : { output: GitCheckEvidenceSchema.parse({ ...outcome.output, ...evidence }) }),
          }
        },
      )
    } catch (cause) {
      return failed("check-failed", messageOf(cause))
    }
  }
}

export type GitMergeOptions = ProcessDependency & Readonly<{ repo: string; env?: NodeJS.ProcessEnv }>

export type ConfiguredMergeOptions = ProcessDependency &
  Readonly<{
    repo: string
    command: readonly string[]
    artifactRoot?: string
    environment?: string
    env?: NodeJS.ProcessEnv
    timeoutMs?: number
  }>

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
    const entries = record.split("\n")
    if (entries.includes(`branch ${branchRef}`)) {
      return entries.find((entry) => entry.startsWith("worktree "))?.slice(9)
    }
  }
  return undefined
}

type CheckedCandidateResult =
  | Readonly<{ checked: GitCheckEvidence }>
  | Readonly<{ error: Readonly<{ code: string; message: string }> }>

async function validateCheckedCandidate(
  git: Git,
  repo: string,
  input: StepExecution,
  baseSha: string,
): Promise<CheckedCandidateResult> {
  const checked = checkedCandidate(input.shape)
  if (checked === undefined) return { error: { code: "check-missing", message: "merge requires a pinned check" } }
  if (checked.baseSha !== baseSha) {
    return {
      error: {
        code: "stale-check",
        message: `queue '${primaryPR(input).base}' moved from checked base '${checked.baseSha}' to '${baseSha}'`,
      },
    }
  }
  if ((await git.commit(repo, checked.candidateRef)) !== checked.candidateSha) {
    return { error: { code: "stale-check", message: "checked candidate ref moved" } }
  }
  for (const sha of [checked.baseSha, ...input.prs.map((pr) => pr.headSha)]) {
    if ((await git.run(repo, ["merge-base", "--is-ancestor", sha, checked.candidateSha], true)).code !== 0) {
      return { error: { code: "invalid-candidate", message: `checked candidate does not contain '${sha}'` } }
    }
  }
  return { checked }
}

async function authoritativeQueueBase(git: Git, repo: string, branch: string): Promise<GitQueueTarget> {
  const remote = await git.run(repo, ["config", "--get", "remote.origin.url"], true)
  if (remote.code !== 0 || remote.stdout === "") return inspectQueueBase(git, repo, branch)
  const source = `refs/heads/${branch}`
  const target = `refs/remotes/origin/${branch}`
  const fetched = await git.run(repo, ["fetch", "--quiet", "origin", `+${source}:${target}`], true)
  if (fetched.code !== 0) {
    throw new Error(fetched.stderr || fetched.stdout || `could not refresh origin/${branch}`)
  }
  return inspectQueueBase(git, repo, branch)
}

export async function resolveGitQueueTarget(options: {
  inject: Readonly<{ process: Pick<Process, "run"> }>
  repo: string
  branch: string
  env?: NodeJS.ProcessEnv
}): Promise<GitQueueTarget> {
  const repo = resolve(options.repo)
  return authoritativeQueueBase(createGit(options.inject.process, options.env), repo, options.branch)
}

async function landingError(
  git: Git,
  repo: string,
  input: StepExecution,
  checked: GitCheckEvidence,
  landingSha: string,
): Promise<string | undefined> {
  for (const sha of [checked.baseSha, ...input.prs.map((pr) => pr.headSha)]) {
    if ((await git.run(repo, ["merge-base", "--is-ancestor", sha, landingSha], true)).code !== 0) return sha
  }
  return undefined
}

export function gitMergeStep<Shape extends PRShape>(options: GitMergeOptions): StepRunner<Shape, IntegrationProof> {
  const repo = resolve(options.repo)
  const git = createGit(options.inject.process, options.env)
  return async (input): Promise<JobResult<IntegrationProof>> => {
    try {
      const branch = primaryPR(input).base
      const base = await authoritativeQueueBase(git, repo, branch)
      const baseSha = base.sha
      const candidate = await validateCheckedCandidate(git, repo, input, baseSha)
      if ("error" in candidate) return failed(candidate.error.code, candidate.error.message)
      const { checked } = candidate
      const remote = base.remote
      if (remote !== undefined) {
        const branchRef = `refs/heads/${branch}`
        const attempted = await withScratch(
          git,
          repo,
          checked.candidateSha,
          tmpdir(),
          async (path): Promise<JobResult<IntegrationProof>> => {
            const submodules = await git.run(path, ["submodule", "update", "--init", "--recursive"], true)
            if (submodules.code !== 0) {
              return failed(
                "candidate-submodules-failed",
                submodules.stderr || submodules.stdout || "could not materialize candidate submodules",
              )
            }
            if ((await git.commit(path, "HEAD")) !== checked.candidateSha) {
              return failed("invalid-candidate", "candidate checkout does not match its pinned commit")
            }
            const pushed = await git.run(
              path,
              ["push", "--porcelain", remote, `${checked.candidateSha}:${branchRef}`],
              true,
            )
            if (pushed.code !== 0) {
              return failed("merge-push-failed", pushed.stderr || pushed.stdout || `could not update '${branch}'`)
            }
            return {
              status: "passed",
              output: IntegrationProofSchema.parse({ commit: checked.candidateSha, baseSha: checked.candidateSha }),
            }
          },
        )
        const landing = await authoritativeQueueBase(git, repo, branch)
        const missing = await landingError(git, repo, input, checked, landing.sha)
        if (missing === undefined) {
          return {
            status: "passed",
            output: IntegrationProofSchema.parse({ commit: landing.sha, baseSha: landing.sha }),
          }
        }
        if (landing.sha !== baseSha) {
          return failed(
            "stale-base",
            `queue '${branch}' moved from '${baseSha}' to '${landing.sha}' before the candidate could land`,
          )
        }
        if (attempted.status === "failed") return attempted
        if (attempted.status === "waiting") throw new Error("native merge cannot wait")
        return failed("merge-verification-failed", `landed '${branch}' does not contain '${missing}'`)
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

export function configuredMergeStep<Shape extends PRShape>(
  options: ConfiguredMergeOptions,
): StepRunner<Shape, IntegrationProof> {
  const repo = resolve(options.repo)
  const git = createGit(options.inject.process, options.env)
  const command = configuredCommandStep<Shape>({
    inject: options.inject,
    command: options.command,
    cwd: repo,
    purpose: "merge",
    artifactRoot: options.artifactRoot ?? join(repo, ".git", "yrd", "artifacts"),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    variables: (input) => {
      const checked = checkedCandidate(input.shape)
      return {
        YRD_CANDIDATE_SHA: checked?.candidateSha,
        YRD_CANDIDATE_REF: checked?.candidateRef,
        ...(options.environment === undefined ? {} : { YRD_ENVIRONMENT: options.environment }),
      }
    },
  })
  return async (input, context): Promise<JobResult<IntegrationProof>> => {
    try {
      const branch = primaryPR(input).base
      const base = await authoritativeQueueBase(git, repo, branch)
      const candidate = await validateCheckedCandidate(git, repo, input, base.sha)
      if ("error" in candidate) return failed(candidate.error.code, candidate.error.message)

      const outcome = await command(input, context)
      let landing: GitQueueTarget
      try {
        landing = await authoritativeQueueBase(git, repo, branch)
      } catch (cause) {
        return outcome.status === "failed"
          ? failed(outcome.error.code, outcome.error.message)
          : failed("merge-verification-failed", messageOf(cause))
      }
      const missing = await landingError(git, repo, input, candidate.checked, landing.sha)
      if (missing === undefined) {
        return {
          status: "passed",
          output: IntegrationProofSchema.parse({ commit: landing.sha, baseSha: landing.sha }),
        }
      }
      if (outcome.status === "failed") return failed(outcome.error.code, outcome.error.message)
      if (outcome.status === "waiting") {
        return failed("merge-command-waited", "merge commands cannot leave a waiting external effect")
      }
      return failed(
        "merge-command-did-not-land",
        `merge command exited successfully but '${branch}' does not contain '${missing}'`,
      )
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
  if (primary === undefined) throw new Error(`yrd: queue run '${input.run}' has no PR`)
  return primary
}

function failed<Output extends JsonValue = JsonValue>(
  code: string,
  message: string,
  output?: Output,
): JobResult<Output> {
  return { status: "failed", error: { code, message }, ...(output === undefined ? {} : { output }) }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
