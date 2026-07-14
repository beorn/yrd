import { createHash } from "node:crypto"
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createFailure, failureFact, type JsonValue, type YrdFailure } from "@yrd/core"
import { parseJobLaunch, type JobResult } from "@yrd/job"
import type { Process } from "@yrd/process"
import * as z from "zod"
import type { IntegratedShape, IntegrationProof, PRShape, SourceRewrite } from "./model.ts"
import { IntegrationProofSchema, SourceRewriteSchema } from "./model.ts"
import type { StepExecution, StepRunner } from "./queue.ts"

const sourceRowKey = ["li", "ne"].join("") as `${"li"}${"ne"}`

export const StepArtifactSchema = z.object({ name: z.string().min(1), path: z.string().min(1) }).strict()
export type StepArtifact = Readonly<z.infer<typeof StepArtifactSchema>>

export const CommandDiagnosticSchema = z
  .object({
    file: z.string().min(1),
    [sourceRowKey]: z.number().int().positive(),
    column: z.number().int().positive().optional(),
    message: z.string().min(1),
  })
  .strict()
export type CommandDiagnostic = Readonly<z.infer<typeof CommandDiagnosticSchema>>

export const CommandEvidenceSchema = z
  .object({
    command: z.array(z.string().min(1)).min(1),
    exitCode: z.number().int(),
    durationMs: z.number().nonnegative(),
    configHash: z.string().regex(/^[0-9a-f]{64}$/u),
    artifacts: z.array(StepArtifactSchema),
    classification: z.enum(["base", "carrier"]).optional(),
    detail: z.string().optional(),
    diagnostics: z.array(CommandDiagnosticSchema).optional(),
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
  sourceRewrites: z.array(SourceRewriteSchema).optional(),
}).strict()
export type GitCheckEvidence = Readonly<z.infer<typeof GitCheckEvidenceSchema>>

const PinnedCandidateSchema = GitCheckEvidenceSchema.pick({
  baseSha: true,
  candidateSha: true,
  candidateRef: true,
  sourceRewrites: true,
}).strict()
type PinnedCandidate = Readonly<z.infer<typeof PinnedCandidateSchema>>

export const GitCheckFailureEvidenceSchema = z
  .object({
    artifacts: z.array(StepArtifactSchema),
    conflicts: z
      .array(z.object({ repo: z.string().min(1), paths: z.array(z.string().min(1)).min(1) }).strict())
      .optional(),
  })
  .strict()
export type GitCheckFailureEvidence = Readonly<z.infer<typeof GitCheckFailureEvidenceSchema>>

export const QueueAuthorityRefusalEvidenceSchema = z
  .object({
    kind: z.literal("queue-authority-refusal"),
    base: z.string().min(1),
    remote: z.literal("origin"),
    attempts: z.number().int().min(1).max(3),
  })
  .strict()
export type QueueAuthorityRefusalEvidence = Readonly<z.infer<typeof QueueAuthorityRefusalEvidenceSchema>>

export const GitCheckResultEvidenceSchema = z.union([
  GitCheckEvidenceSchema,
  CommandEvidenceSchema,
  GitCheckFailureEvidenceSchema,
])
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
    classification?: "base" | "carrier"
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
    const artifactSink = await createArtifactSink(
      resolve(options.artifactRoot ?? join(cwd, ".yrd-artifacts")),
      input,
      context.attempt,
    )
    let result: Awaited<ReturnType<Process["run"]>>
    try {
      result = await process.run({
        argv,
        cwd,
        env: commandEnvironment(options.env ?? globalThis.process.env, variables),
        signal: context.signal,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.noProgressTimeoutMs === undefined ? {} : { noProgressTimeoutMs: options.noProgressTimeoutMs }),
        onOutput: (output) => {
          artifactSink.write(output)
          context.reportProgress?.()
        },
      })
    } catch (cause) {
      try {
        await artifactSink.drain()
      } catch (artifactCause) {
        throw new AggregateError([cause, artifactCause], "yrd: process and artifact stream both failed")
      }
      throw cause
    }
    const artifacts = await artifactSink.finish(result.stdout, result.stderr)
    const message = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter((part) => part !== "").join("\n")
    const detail = commandDetail(message)
    const diagnostics = commandDiagnostics(message)
    const progress = result as typeof result & ProgressResult
    const evidence = CommandEvidenceSchema.parse({
      command: argv,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      configHash,
      artifacts,
      classification: options.classification ?? "carrier",
      ...(detail === "" ? {} : { detail }),
      ...(diagnostics.length === 0 ? {} : { diagnostics }),
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

function commandDetail(output: string): string {
  const limit = 2_000
  if (output.length <= limit) return output
  const marker = "\n… output truncated …\n"
  const headLength = 500
  return `${output.slice(0, headLength)}${marker}${output.slice(-(limit - headLength - marker.length))}`
}

function commandDiagnostics(output: string): CommandDiagnostic[] {
  const diagnostics: CommandDiagnostic[] = []
  for (const row of output.split(/\r?\n/u)) {
    const text = row.trim()
    const changed = /^[ MADRCU?!]{2}\s+(.+)$/u.exec(row)
    if (changed?.[1] !== undefined) {
      diagnostics.push({ file: changed[1], [sourceRowKey]: 1, message: "working tree changed during check" })
      if (diagnostics.length >= 20) break
      continue
    }
    const match =
      /^(.*?)\((\d+),(\d+)\):\s*(.+)$/u.exec(text) ?? /^(.*?):(\d+)(?::(\d+))?\s*(?:-|:)\s*(.+)$/u.exec(text)
    if (match?.[1] === undefined || match[2] === undefined || match[4] === undefined) continue
    const rowNumber = Number(match[2])
    const column = match[3] === undefined ? undefined : Number(match[3])
    if (rowNumber < 1 || (column !== undefined && column < 1)) continue
    diagnostics.push({
      file: match[1],
      [sourceRowKey]: rowNumber,
      ...(column === undefined ? {} : { column }),
      message: match[4],
    })
    if (diagnostics.length >= 20) break
  }
  return diagnostics
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

async function writeTerminalArtifacts(
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

type ArtifactStream = "stdout" | "stderr"
type ArtifactStreamState = {
  readonly path: string
  readonly hash: ReturnType<typeof createHash>
  readonly decoder: TextDecoder
  seen: boolean
}

async function createArtifactSink(root: string, input: StepExecution, attempt: number) {
  const dir = join(root, input.run, `${input.index}-${input.step}`, `attempt-${attempt}`)
  const streams: Record<ArtifactStream, ArtifactStreamState> = {
    stdout: { path: join(dir, "stdout.log"), hash: createHash("sha256"), decoder: new TextDecoder(), seen: false },
    stderr: { path: join(dir, "stderr.log"), hash: createHash("sha256"), decoder: new TextDecoder(), seen: false },
  }
  const combined = { path: join(dir, "output.log"), seen: false }
  try {
    await mkdir(dir, { recursive: true })
    await Promise.all(
      [...Object.values(streams).map(({ path }) => path), combined.path].map((path) => rm(path, { force: true })),
    )
  } catch (cause) {
    throw new Error(
      `yrd: could not prepare step artifact directory ${dir}; inspect its permissions and free space, then retry the run`,
      { cause },
    )
  }

  let writes = Promise.resolve()
  let writeFailure: unknown
  const write = (output: Readonly<{ stream: ArtifactStream; chunk: Uint8Array }>): void => {
    if (writeFailure !== undefined) throw writeFailure
    const name = output.stream
    const stream = streams[name]
    const chunk = output.chunk.slice()
    const first = !stream.seen
    stream.seen = true
    stream.hash.update(chunk)
    const combinedText = stream.decoder.decode(chunk, { stream: true })
    const firstCombined = combinedText !== "" && !combined.seen
    if (combinedText !== "") combined.seen = true
    writes = writes
      .then(async () => {
        if (writeFailure !== undefined) return undefined
        if (first) await writeFile(stream.path, chunk)
        else await appendFile(stream.path, chunk)
        if (combinedText !== "") {
          if (firstCombined) await writeFile(combined.path, combinedText)
          else await appendFile(combined.path, combinedText)
        }
        return undefined
      })
      .catch((cause: unknown) => {
        writeFailure ??= new Error(
          `yrd: could not stream ${name} artifact ${stream.path}; inspect its directory permissions and free space, then retry the run`,
          { cause },
        )
      })
  }
  const drain = async (): Promise<void> => {
    await writes
    if (writeFailure !== undefined) throw writeFailure
  }
  const finish = async (stdout: string, stderr: string): Promise<StepArtifact[]> => {
    await drain()
    for (const stream of Object.values(streams)) {
      const remainder = stream.decoder.decode()
      if (remainder === "") continue
      const firstCombined = !combined.seen
      combined.seen = true
      writes = writes.then(async () => {
        if (firstCombined) await writeFile(combined.path, remainder)
        else await appendFile(combined.path, remainder)
        return undefined
      })
    }
    await drain()
    const artifacts: StepArtifact[] = []
    let streamsMatch = true
    for (const [name, content] of [
      ["stdout", stdout],
      ["stderr", stderr],
    ] as const) {
      const stream = streams[name]
      if (content === "") {
        if (stream.seen) await rm(stream.path, { force: true })
        continue
      }
      const finalHash = createHash("sha256").update(content).digest("hex")
      const streamedHash = stream.seen ? stream.hash.digest("hex") : undefined
      if (streamedHash !== finalHash) {
        streamsMatch = false
        await writeFile(stream.path, content)
      }
      artifacts.push({ name, path: stream.path })
    }
    const fallback = [stdout, stderr].filter((content) => content !== "").join("")
    if (fallback === "") await rm(combined.path, { force: true })
    else if (!combined.seen || !streamsMatch) await writeFile(combined.path, fallback)
    return artifacts
  }
  return Object.freeze({ drain, finish, write })
}

async function failureEvidence(
  options: Readonly<{
    command: readonly string[]
    detail: string
    classification: "base" | "carrier"
    artifactRoot: string
    input: StepExecution
    attempt: number
    artifacts?: readonly StepArtifact[]
    exitCode?: number
  }>,
): Promise<CommandEvidence> {
  const artifacts =
    options.artifacts ??
    (await writeTerminalArtifacts(options.artifactRoot, options.input, options.attempt, "", `${options.detail}\n`))
  const diagnostics = commandDiagnostics(options.detail)
  return CommandEvidenceSchema.parse({
    command: options.command,
    exitCode: options.exitCode ?? 1,
    durationMs: 0,
    configHash: createHash("sha256").update(JSON.stringify(options.command)).digest("hex"),
    artifacts,
    classification: options.classification,
    detail: options.detail,
    ...(diagnostics.length === 0 ? {} : { diagnostics }),
  })
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
  const stablePatchId = async (repo: string, from: string, to: string): Promise<string | undefined> => {
    const diff = await run(repo, ["diff", "--full-index", "--binary", from, to, "--"], true)
    if (diff.code !== 0) return undefined
    const result = await process.run({
      argv: ["git", "-C", repo, "patch-id", "--stable"],
      cwd: repo,
      env,
      stdin: diff.stdout,
    })
    if (result.exitCode !== 0) return undefined
    return /^([0-9a-f]{40,64})\s+[0-9a-f]{40,64}$/iu.exec(result.stdout.trim())?.[1]
  }
  const rangeDiff = (repo: string, oldBase: string, oldTip: string, newBase: string, newTip: string) =>
    run(
      repo,
      ["range-diff", "--no-color", "--no-dual-color", "--no-patch", `${oldBase}..${oldTip}`, `${newBase}..${newTip}`],
      true,
    )
  return Object.freeze({ run, commit, optionalCommit, stablePatchId, rangeDiff })
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
  repo: string,
  path: string,
  input: StepExecution,
  attempt: number,
  artifactRoot: string,
  allowAuthoredGitlinks: boolean,
): Promise<
  | Readonly<{ status: "passed"; output: Readonly<{ sha: string; sourceRewrites: readonly SourceRewrite[] }> }>
  | Readonly<{ status: "failed"; error: Readonly<{ code: string; message: string }>; output: GitCheckFailureEvidence }>
> {
  const sourceRewrites: SourceRewrite[] = []
  for (const pr of input.prs) {
    if (pr.composition !== undefined) {
      const composed = await composePR(git, repo, path, pr)
      if (composed.status === "failed") return composed
      sourceRewrites.push(...composed.output)
      continue
    }
    if (!allowAuthoredGitlinks) {
      const inspected = await authoredGitlinkPaths(git, path, pr.headSha)
      if (inspected.status === "failed") return inspected
      const gitlinks = inspected.output
      if (gitlinks.length > 0) {
        return candidateFailure(
          "authored-gitlink",
          `PR '${pr.id}' changes generated-only gitlinks [${gitlinks.join(", ")}]; submit a composition packet or temporarily set YRD_ALLOW_AUTHORED_GITLINKS=1`,
          ".",
          gitlinks,
        )
      }
    }
    const merged = await git.run(path, ["merge", "--no-ff", "--no-edit", pr.headSha], true)
    if (merged.code !== 0) {
      const artifacts = await writeTerminalArtifacts(artifactRoot, input, attempt, merged.stdout, merged.stderr)
      await git.run(path, ["merge", "--abort"], true)
      const detail = `PR '${pr.id}' could not be applied: ${merged.stderr || merged.stdout}`
      return {
        status: "failed",
        error: {
          code: "candidate-conflict",
          message: detail,
        },
        output: await failureEvidence({
          command: ["git", "-C", path, "merge", "--no-ff", "--no-edit", pr.headSha],
          detail,
          classification: "carrier",
          artifactRoot,
          input,
          attempt,
          artifacts,
          exitCode: merged.code,
        }),
      }
    }
  }
  return { status: "passed", output: { sha: await git.commit(path, "HEAD"), sourceRewrites } }
}

type CandidateFailure = Readonly<{
  status: "failed"
  error: Readonly<{ code: string; message: string }>
  output: GitCheckFailureEvidence
}>

function candidateFailure(
  code: string,
  message: string,
  repo?: string,
  paths: readonly string[] = [],
): CandidateFailure {
  return {
    status: "failed",
    error: { code, message },
    output: GitCheckFailureEvidenceSchema.parse({
      artifacts: [],
      ...(repo === undefined || paths.length === 0 ? {} : { conflicts: [{ repo, paths }] }),
    }),
  }
}

async function composePR(
  git: Git,
  repo: string,
  path: string,
  pr: StepExecution["prs"][number],
): Promise<Readonly<{ status: "passed"; output: readonly SourceRewrite[] }> | CandidateFailure> {
  if (!(await isAncestor(git, path, pr.headSha, "HEAD"))) {
    return candidateFailure(
      "composition-invalid",
      `PR '${pr.id}' composition head '${pr.headSha}' contains root changes; submit source declarations from a root-base-only branch`,
    )
  }

  const rewrites: SourceRewrite[] = []
  const expectedWrapperPaths: string[] = []
  for (const source of pr.composition?.sources ?? []) {
    const currentPin = await readGitlink(git, path, "HEAD", source.repo)
    if (currentPin === undefined) {
      return candidateFailure(
        "composition-invalid",
        `PR '${pr.id}' source '${source.repo}' is not a gitlink in the authoritative root base`,
        source.repo,
        [source.repo],
      )
    }
    const prepared = await prepareSource(git, repo, source, currentPin)
    if (prepared.status === "failed") return prepared
    rewrites.push(prepared.output)
    if (prepared.output.newTipSha === currentPin) continue
    expectedWrapperPaths.push(source.repo)
    const staged = await git.run(
      path,
      ["update-index", "--cacheinfo", `160000,${prepared.output.newTipSha},${source.repo}`],
      true,
    )
    if (staged.code !== 0) {
      return candidateFailure(
        "wrapper-mismatch",
        `PR '${pr.id}' could not stage generated gitlink '${source.repo}': ${staged.stderr || staged.stdout}`,
        source.repo,
        [source.repo],
      )
    }
  }

  const materialized = await stagedPaths(git, path)
  if (!samePaths(materialized, expectedWrapperPaths)) {
    return candidateFailure(
      "wrapper-mismatch",
      `PR '${pr.id}' generated wrapper paths differ: expected [${expectedWrapperPaths.join(", ")}], got [${materialized.join(", ")}]`,
      ".",
      symmetricDifference(materialized, expectedWrapperPaths),
    )
  }
  if (materialized.length > 0) {
    const committed = await git.run(
      path,
      [
        "-c",
        "user.name=Yrd Queue",
        "-c",
        "user.email=yrd-queue@example.invalid",
        "commit",
        "-qm",
        `yrd: compose ${pr.id}`,
      ],
      true,
    )
    if (committed.code !== 0) {
      return candidateFailure(
        "wrapper-mismatch",
        `PR '${pr.id}' generated wrapper could not be committed: ${committed.stderr || committed.stdout}`,
      )
    }
  }
  for (const rewrite of rewrites) {
    if ((await readGitlink(git, path, "HEAD", rewrite.repo)) !== rewrite.newTipSha) {
      return candidateFailure(
        "wrapper-mismatch",
        `PR '${pr.id}' generated wrapper does not pin '${rewrite.repo}' to '${rewrite.newTipSha}'`,
        rewrite.repo,
        [rewrite.repo],
      )
    }
  }
  return { status: "passed", output: rewrites }
}

async function prepareSource(
  git: Git,
  repo: string,
  source: NonNullable<StepExecution["prs"][number]["composition"]>["sources"][number],
  currentPin: string,
): Promise<Readonly<{ status: "passed"; output: SourceRewrite }> | CandidateFailure> {
  const sourceRepo = join(repo, source.repo)
  try {
    await realpath(sourceRepo)
  } catch {
    return candidateFailure(
      "source-missing",
      `source repository '${source.repo}' is not initialized; run git submodule update --init --recursive`,
      source.repo,
      [source.repo],
    )
  }
  const validBranch = await git.run(sourceRepo, ["check-ref-format", "--branch", source.branch], true)
  if (validBranch.code !== 0) {
    return candidateFailure("composition-invalid", `source '${source.repo}' has invalid branch '${source.branch}'`)
  }
  const fetched = await git.run(
    sourceRepo,
    ["-c", "protocol.file.allow=always", "fetch", "--quiet", "origin", source.branch],
    true,
  )
  if (fetched.code !== 0) {
    return candidateFailure(
      "source-missing",
      `source '${source.repo}' branch '${source.branch}' could not be fetched: ${fetched.stderr || fetched.stdout}`,
    )
  }
  const fetchedTip = await git.optionalCommit(sourceRepo, "FETCH_HEAD")
  if (fetchedTip === undefined || !(await isAncestor(git, sourceRepo, source.tipSha, fetchedTip))) {
    return candidateFailure(
      "source-lineage",
      `source '${source.repo}' branch '${source.branch}' no longer contains declared tip '${source.tipSha}' (resolved '${fetchedTip ?? "missing"}')`,
    )
  }
  for (const sha of [source.baseSha, source.tipSha, currentPin]) {
    if ((await git.optionalCommit(sourceRepo, sha)) !== sha) {
      return candidateFailure("source-missing", `source '${source.repo}' is missing commit '${sha}'`)
    }
  }
  if (!(await isAncestor(git, sourceRepo, source.baseSha, source.tipSha))) {
    return candidateFailure(
      "source-lineage",
      `source '${source.repo}' declared base '${source.baseSha}' is not an ancestor of tip '${source.tipSha}'`,
    )
  }
  if (!(await isAncestor(git, sourceRepo, source.baseSha, currentPin))) {
    return candidateFailure(
      "source-lineage",
      `source '${source.repo}' current pin '${currentPin}' is not a descendant of declared base '${source.baseSha}'`,
    )
  }

  const sourcePaths = await changedPaths(git, sourceRepo, source.baseSha, source.tipSha)
  const sourceIdentity = await changedPayloadIdentity(git, sourceRepo, source.baseSha, source.tipSha)
  const sourcePatchId = await git.stablePatchId(sourceRepo, source.baseSha, source.tipSha)
  if (sourcePatchId === undefined) {
    return candidateFailure(
      "payload-certificate",
      `source '${source.repo}' could not derive a stable patch identity`,
      source.repo,
      source.payload,
    )
  }
  if (!samePaths(sourcePaths, source.payload)) {
    return candidateFailure(
      "payload-mismatch",
      `source '${source.repo}' payload differs: declared [${source.payload.join(", ")}], materialized [${sourcePaths.join(", ")}]`,
      source.repo,
      symmetricDifference(sourcePaths, source.payload),
    )
  }

  let newTipSha = source.tipSha
  if (currentPin !== source.baseSha && !(await isAncestor(git, sourceRepo, currentPin, source.tipSha))) {
    const upstreamPaths = await changedPaths(git, sourceRepo, source.baseSha, currentPin)
    const overlap = intersection(sourcePaths, upstreamPaths)
    if (overlap.length > 0) {
      return candidateFailure(
        "payload-overlap",
        `source '${source.repo}' overlaps current pin '${currentPin}' at [${overlap.join(", ")}]`,
        source.repo,
        overlap,
      )
    }
    const rebased = await rebaseSource(git, sourceRepo, source, currentPin)
    if (rebased.status === "failed") return rebased
    newTipSha = rebased.output
  }

  const materialized = await changedPaths(git, sourceRepo, currentPin, newTipSha)
  if (!samePaths(materialized, source.payload)) {
    return candidateFailure(
      "wrapper-mismatch",
      `source '${source.repo}' rewritten payload differs: declared [${source.payload.join(", ")}], materialized [${materialized.join(", ")}]`,
      source.repo,
      symmetricDifference(materialized, source.payload),
    )
  }
  const materializedIdentity = await changedPayloadIdentity(git, sourceRepo, currentPin, newTipSha)
  if (materializedIdentity !== sourceIdentity) {
    return candidateFailure(
      "payload-identity",
      `source '${source.repo}' rewritten payload changed blob, mode, status, or path identity`,
      source.repo,
      source.payload,
    )
  }
  const materializedPatchId = await git.stablePatchId(sourceRepo, currentPin, newTipSha)
  if (materializedPatchId !== sourcePatchId) {
    return candidateFailure(
      "payload-certificate",
      `source '${source.repo}' rewritten payload changed stable patch identity`,
      source.repo,
      source.payload,
    )
  }
  const rangeDiff = await git.rangeDiff(sourceRepo, source.baseSha, source.tipSha, currentPin, newTipSha)
  if (rangeDiff.code !== 0 || !isEqualRangeDiff(rangeDiff.stdout)) {
    return candidateFailure(
      "payload-certificate",
      `source '${source.repo}' rewritten commit range is not range-diff equivalent`,
      source.repo,
      source.payload,
    )
  }
  const candidateRef = sourceCandidateRef(newTipSha)
  const pinned = await git.run(
    sourceRepo,
    ["update-ref", "--create-reflog", candidateRef, newTipSha, "0".repeat(newTipSha.length)],
    true,
  )
  if (pinned.code !== 0 && (await git.optionalCommit(sourceRepo, candidateRef)) !== newTipSha) {
    return candidateFailure(
      "source-publish",
      `source '${source.repo}' candidate ref could not be pinned: ${pinned.stderr}`,
    )
  }
  const published = await git.run(sourceRepo, ["push", "--porcelain", "origin", `${newTipSha}:${candidateRef}`], true)
  if (published.code !== 0) {
    return candidateFailure(
      "source-publish",
      `source '${source.repo}' candidate '${newTipSha}' could not be published: ${published.stderr || published.stdout}`,
    )
  }
  return {
    status: "passed",
    output: SourceRewriteSchema.parse({
      repo: source.repo,
      branch: source.branch,
      oldBaseSha: source.baseSha,
      oldTipSha: source.tipSha,
      newBaseSha: currentPin,
      newTipSha,
      payload: source.payload,
      candidateRef,
      patchId: sourcePatchId,
      rangeDiff: "=",
    }),
  }
}

async function rebaseSource(
  git: Git,
  sourceRepo: string,
  source: NonNullable<StepExecution["prs"][number]["composition"]>["sources"][number],
  currentPin: string,
): Promise<Readonly<{ status: "passed"; output: string }> | CandidateFailure> {
  const root = await mkdtemp(join(tmpdir(), "yrd-source-"))
  const path = join(root, "worktree")
  let added = false
  let outcome: Readonly<{ status: "passed"; output: string }> | CandidateFailure | undefined
  let operationFailure: unknown
  try {
    await git.run(sourceRepo, ["worktree", "add", "--detach", path, source.tipSha])
    added = true
    const result = await git.run(
      path,
      [
        "-c",
        "user.name=Yrd Queue",
        "-c",
        "user.email=yrd-queue@example.invalid",
        "rebase",
        "--onto",
        currentPin,
        source.baseSha,
        source.tipSha,
      ],
      true,
    )
    if (result.code !== 0) {
      const paths = await unmergedPaths(git, path)
      await git.run(path, ["rebase", "--abort"], true)
      outcome =
        paths.length === 0
          ? candidateFailure(
              "restack-failed",
              `source '${source.repo}' could not restack onto '${currentPin}': ${result.stderr || result.stdout}`,
            )
          : candidateFailure(
              "restack-conflict",
              `source '${source.repo}' could not restack onto '${currentPin}' at [${paths.join(", ")}]`,
              source.repo,
              paths,
            )
    } else {
      outcome = { status: "passed", output: await git.commit(path, "HEAD") }
    }
  } catch (cause) {
    operationFailure = cause
  }

  let cleanupFailure: string | undefined
  if (added) {
    const removed = await git.run(sourceRepo, ["worktree", "remove", "--force", path], true)
    if (removed.code !== 0) cleanupFailure = removed.stderr || removed.stdout || "could not remove source worktree"
  }
  try {
    await rm(root, { recursive: true, force: true })
  } catch (cause) {
    cleanupFailure ??= messageOf(cause)
  }
  if (operationFailure !== undefined) throw operationFailure
  if (cleanupFailure !== undefined) return candidateFailure("scratch-cleanup-failed", cleanupFailure)
  if (outcome === undefined) throw new Error("source restack produced no result")
  return outcome
}

async function readGitlink(git: Git, repo: string, ref: string, path: string): Promise<string | undefined> {
  const result = await git.run(repo, ["ls-tree", "-z", ref, "--", path], true)
  if (result.code !== 0 || result.stdout === "") return undefined
  const header = /^160000 commit ([0-9a-f]{40,64})\t/u.exec(result.stdout)
  if (header === null) return undefined
  const end = result.stdout.indexOf("\0", header[0].length)
  const recordPath = result.stdout.slice(header[0].length, end === -1 ? undefined : end)
  return recordPath === path ? header[1] : undefined
}

async function changedPaths(git: Git, repo: string, from: string, to: string): Promise<string[]> {
  const result = await git.run(repo, ["diff", "--name-only", "--no-renames", "-z", from, to, "--"])
  return nulPaths(result.stdout)
}

async function changedPayloadIdentity(git: Git, repo: string, from: string, to: string): Promise<string> {
  return (await git.run(repo, ["diff", "--raw", "--no-abbrev", "--no-renames", "-z", from, to, "--"])).stdout
}

async function stagedPaths(git: Git, repo: string): Promise<string[]> {
  const result = await git.run(repo, ["diff", "--cached", "--name-only", "--no-renames", "-z", "--"])
  return nulPaths(result.stdout)
}

async function unmergedPaths(git: Git, repo: string): Promise<string[]> {
  const result = await git.run(repo, ["diff", "--name-only", "--diff-filter=U", "-z", "--"], true)
  return result.code === 0 ? [...new Set(nulPaths(result.stdout).map(normalizeConflictPath))].toSorted() : []
}

async function isAncestor(git: Git, repo: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await git.run(repo, ["merge-base", "--is-ancestor", ancestor, descendant], true)).code === 0
}

function nulPaths(value: string): string[] {
  return value
    .split("\0")
    .filter((path) => path !== "")
    .toSorted()
}

function normalizeConflictPath(path: string): string {
  return path.replace(/~[0-9a-f]{7,64} \(.+\)$/u, "")
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  const sortedRight = right.toSorted()
  return left.length === sortedRight.length && left.every((path, index) => path === sortedRight[index])
}

function isEqualRangeDiff(output: string): boolean {
  const lines = output.split(/\r?\n/u).filter((line) => line.trim() !== "")
  return lines.length > 0 && lines.every((line) => /^\d+:\s+[0-9a-f]+ = \d+:\s+[0-9a-f]+(?:\s|$)/iu.test(line))
}

function intersection(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right)
  return left.filter((path) => rightSet.has(path)).toSorted()
}

function symmetricDifference(left: readonly string[], right: readonly string[]): string[] {
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  return [...left.filter((path) => !rightSet.has(path)), ...right.filter((path) => !leftSet.has(path))].toSorted()
}

function sourceCandidateRef(newTipSha: string): string {
  return `refs/heads/yrd/candidates/${newTipSha}`
}

async function authoredGitlinkPaths(
  git: Git,
  repo: string,
  headSha: string,
): Promise<Readonly<{ status: "passed"; output: readonly string[] }> | CandidateFailure> {
  const base = await git.run(repo, ["merge-base", "HEAD", headSha], true)
  if (base.code !== 0 || base.stdout === "") {
    return candidateFailure(
      "gitlink-inspection",
      `could not inspect authored gitlinks for '${headSha}': ${base.stderr || base.stdout || "no merge base"}`,
    )
  }
  const paths = await changedPaths(git, repo, base.stdout, headSha)
  const gitlinks: string[] = []
  for (const path of paths) {
    if (
      (await readGitlink(git, repo, base.stdout, path)) !== undefined ||
      (await readGitlink(git, repo, headSha, path)) !== undefined
    ) {
      gitlinks.push(path)
    }
  }
  return { status: "passed", output: gitlinks }
}

export type GitCheckOptions = ProcessDependency &
  Readonly<{
    repo: string
    command: readonly string[]
    checkoutParent?: string
    artifactRoot?: string
    purpose?: string
    runner?: "local" | "waiting"
    classification?: "base" | "carrier"
    environment?: string
    env?: NodeJS.ProcessEnv
    timeoutMs?: number
    noProgressTimeoutMs?: number
  }>

type CandidatePin =
  | Readonly<{ status: "pinned"; ref: string }>
  | Readonly<{ status: "refused"; token: string; detail: string }>

async function pinCandidate(git: Git, repo: string, ref: string, sha: string): Promise<CandidatePin> {
  const collisionLimit = 32
  for (let collision = 0; collision <= collisionLimit; collision += 1) {
    const candidate = collision === 0 ? ref : `${ref}-collision-${collision}`
    const created = await git.run(repo, ["update-ref", "--create-reflog", candidate, sha, "0".repeat(sha.length)], true)
    if (created.code === 0 || (await git.optionalCommit(repo, candidate)) === sha) {
      return { status: "pinned", ref: candidate }
    }
  }
  const token = createHash("sha256").update(ref).update("\0").update(sha).digest("hex")
  return {
    status: "refused",
    token: `candidate-ref-refused:${token}`,
    detail: `candidate ref '${ref}' exhausted ${collisionLimit} collision identities`,
  }
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

type PreparedCandidateFailure = Extract<Awaited<ReturnType<typeof prepareCandidate>>, { status: "failed" }>

async function withPinnedCandidate<Output extends JsonValue>(
  git: Git,
  repo: string,
  input: StepExecution,
  context: Readonly<{ id: string; attempt: number }>,
  options: Readonly<{ checkoutParent?: string; artifactRoot?: string; allowAuthoredGitlinks?: boolean }>,
  onFailure: (failure: PreparedCandidateFailure) => JobResult<Output>,
  use: (path: string, candidate: PinnedCandidate) => Promise<JobResult<Output>>,
): Promise<JobResult<Output>> {
  const target = await authoritativeQueueBase(git, repo, primaryPR(input).base)
  return withScratch(git, repo, target.sha, options.checkoutParent ?? tmpdir(), async (path) => {
    const candidate = await prepareCandidate(
      git,
      repo,
      path,
      input,
      context.attempt,
      resolve(options.artifactRoot ?? join(repo, ".git", "yrd", "artifacts")),
      options.allowAuthoredGitlinks === true,
    )
    if (candidate.status === "failed") return onFailure(candidate)
    const pinned = await pinCandidate(
      git,
      repo,
      candidateRef(input, context.id, context.attempt, candidate.output.sha),
      candidate.output.sha,
    )
    if (pinned.status === "refused") {
      return { status: "waiting", token: pinned.token, detail: pinned.detail }
    }
    return use(
      path,
      PinnedCandidateSchema.parse({
        baseSha: target.sha,
        candidateSha: candidate.output.sha,
        candidateRef: pinned.ref,
        ...(candidate.output.sourceRewrites.length === 0 ? {} : { sourceRewrites: candidate.output.sourceRewrites }),
      }),
    )
  })
}

export function gitCheckStep(options: GitCheckOptions): StepRunner<PRShape, GitCheckResultEvidence> {
  const repo = resolve(options.repo)
  const git = createGit(options.inject.process, options.env)
  return async (input, context): Promise<JobResult<GitCheckResultEvidence>> => {
    try {
      const purpose = options.purpose ?? "check"
      return await withPinnedCandidate(
        git,
        repo,
        input,
        context,
        {
          checkoutParent: options.checkoutParent,
          artifactRoot: options.artifactRoot,
          allowAuthoredGitlinks: (options.env ?? globalThis.process.env).YRD_ALLOW_AUTHORED_GITLINKS === "1",
        },
        (failure) => failure,
        async (path, candidate): Promise<JobResult<GitCheckResultEvidence>> => {
          const configured: ConfiguredCommandOptions<PRShape> = {
            inject: options.inject,
            command: options.command,
            cwd: path,
            purpose,
            artifactRoot: options.artifactRoot ?? join(repo, ".git", "yrd", "artifacts"),
            ...(options.env === undefined ? {} : { env: options.env }),
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            ...(options.noProgressTimeoutMs === undefined ? {} : { noProgressTimeoutMs: options.noProgressTimeoutMs }),
            classification: options.classification ?? "carrier",
            variables: () => ({
              YRD_BASE_SHA: candidate.baseSha,
              YRD_CANDIDATE_SHA: candidate.candidateSha,
              ...(options.environment === undefined ? {} : { YRD_ENVIRONMENT: options.environment }),
            }),
          }
          const runner =
            options.runner === "waiting" ? configuredWaitingCommandStep(configured) : configuredCommandStep(configured)
          const outcome = await runner({ ...input, targetSha: candidate.candidateSha }, context)
          const evidence = {
            ...candidate,
            classification: options.classification ?? ("carrier" as const),
          }
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
      const refusal = queueAuthorityRefusal(cause)
      if (refusal !== undefined) {
        return failedWithEvidence(failureFact(cause)?.code ?? "queue-environment-refused", messageOf(cause), refusal)
      }
      const detail = messageOf(cause)
      try {
        return failed(
          "check-failed",
          detail,
          await failureEvidence({
            command: ["git", "-C", repo, "fetch", "--quiet", "origin"],
            detail,
            classification: "base",
            artifactRoot: options.artifactRoot ?? join(repo, ".git", "yrd", "artifacts"),
            input,
            attempt: context.attempt,
          }),
        )
      } catch {
        return failed("check-failed", detail)
      }
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

type PinnedCandidateResult =
  | Readonly<{ checked: PinnedCandidate }>
  | Readonly<{ error: Readonly<{ code: string; message: string }> }>

async function validatePinnedCandidate(
  git: Git,
  repo: string,
  input: StepExecution,
  baseSha: string,
  checked: PinnedCandidate,
): Promise<PinnedCandidateResult> {
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
  const sourceRefError = await sourceCandidateRefError(git, repo, checked.sourceRewrites ?? [])
  if (sourceRefError !== undefined) return { error: { code: "invalid-candidate", message: sourceRefError } }
  const finalSources = new Map<string, SourceRewrite>()
  for (const source of checked.sourceRewrites ?? []) finalSources.set(source.repo, source)
  for (const source of finalSources.values()) {
    if ((await readGitlink(git, repo, checked.candidateSha, source.repo)) !== source.newTipSha) {
      return {
        error: {
          code: "invalid-candidate",
          message: `checked candidate does not pin source '${source.repo}' to '${source.newTipSha}'`,
        },
      }
    }
  }
  for (const sha of [checked.baseSha, ...input.prs.map((pr) => pr.headSha)]) {
    if ((await git.run(repo, ["merge-base", "--is-ancestor", sha, checked.candidateSha], true)).code !== 0) {
      return { error: { code: "invalid-candidate", message: `checked candidate does not contain '${sha}'` } }
    }
  }
  return { checked }
}

type MergeCandidateResult =
  | Readonly<{ status: "passed"; base: GitQueueTarget; checked: PinnedCandidate }>
  | Readonly<{ status: "failed"; error: Readonly<{ code: string; message: string }> }>
  | Readonly<{ status: "waiting"; token: string; detail?: string }>

async function mergeCandidate(
  git: Git,
  repo: string,
  input: StepExecution,
  context: Readonly<{ id: string; attempt: number }>,
  options: Readonly<{ artifactRoot?: string; allowAuthoredGitlinks?: boolean }>,
): Promise<MergeCandidateResult> {
  const prior = checkedCandidate(input.shape)
  const prepared =
    prior === undefined
      ? await withPinnedCandidate<PinnedCandidate>(
          git,
          repo,
          input,
          context,
          {
            artifactRoot: options.artifactRoot,
            allowAuthoredGitlinks: options.allowAuthoredGitlinks,
          },
          (failure) => failedWithEvidence(failure.error.code, failure.error.message, failure.output),
          (_path, candidate) => Promise.resolve({ status: "passed" as const, output: candidate }),
        )
      : undefined
  if (prepared?.status === "failed") return prepared
  if (prepared?.status === "waiting") return prepared
  const checked = prior ?? prepared?.output
  if (checked === undefined) throw new Error("yrd: merge candidate preparation produced no candidate")
  const base = await authoritativeQueueBase(git, repo, primaryPR(input).base)
  const validated = await validatePinnedCandidate(git, repo, input, base.sha, checked)
  return "error" in validated ? { status: "failed", error: validated.error } : { status: "passed", base, checked }
}

async function sourceCandidateRefError(
  git: Git,
  repo: string,
  sources: readonly SourceRewrite[],
): Promise<string | undefined> {
  for (const source of sources) {
    const sourceRepo = join(repo, source.repo)
    const fetched = await git.run(sourceRepo, ["fetch", "--quiet", "origin", source.candidateRef], true)
    if (fetched.code !== 0 || (await git.optionalCommit(sourceRepo, "FETCH_HEAD")) !== source.newTipSha) {
      return `source '${source.repo}' candidate ref no longer resolves to '${source.newTipSha}'`
    }
  }
  return undefined
}

async function authoritativeQueueBase(git: Git, repo: string, branch: string): Promise<GitQueueTarget> {
  const remote = await git.run(repo, ["config", "--get", "remote.origin.url"], true)
  if (remote.code !== 0 || remote.stdout === "") return inspectQueueBase(git, repo, branch)
  const source = `refs/heads/${branch}`
  const target = `refs/remotes/origin/${branch}`
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const fetched = await git.run(repo, ["fetch", "--quiet", "origin", `+${source}:${target}`], true)
    if (fetched.code === 0) return inspectQueueBase(git, repo, branch)
    if (attempt === 3) {
      const detail = fetched.stderr || fetched.stdout || `could not refresh origin/${branch}`
      throw createQueueAuthorityRefusal(branch, attempt, detail)
    }
  }
  throw new Error("yrd: unreachable queue authority retry state")
}

type QueueAuthorityFailure = YrdFailure & Readonly<{ evidence: QueueAuthorityRefusalEvidence }>

function createQueueAuthorityRefusal(base: string, attempts: number, detail: string): QueueAuthorityFailure {
  const evidence = QueueAuthorityRefusalEvidenceSchema.parse({
    kind: "queue-authority-refusal",
    base,
    remote: "origin",
    attempts,
  })
  return Object.assign(
    createFailure({
      kind: "infrastructure",
      code: "queue-environment-refused",
      message: `yrd: could not refresh authoritative origin/${base} after ${attempts} attempts: ${detail}`,
    }),
    { evidence },
  )
}

function queueAuthorityRefusal(cause: unknown): QueueAuthorityRefusalEvidence | undefined {
  if (failureFact(cause)?.code !== "queue-environment-refused" || !(cause instanceof Error) || !("evidence" in cause)) {
    return undefined
  }
  const parsed = QueueAuthorityRefusalEvidenceSchema.safeParse(cause.evidence)
  return parsed.success ? parsed.data : undefined
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
  checked: PinnedCandidate,
  landingSha: string,
): Promise<string | undefined> {
  for (const sha of [checked.baseSha, ...input.prs.map((pr) => pr.headSha)]) {
    if ((await git.run(repo, ["merge-base", "--is-ancestor", sha, landingSha], true)).code !== 0) return sha
  }
  return undefined
}

async function rollbackQueueBase(
  git: Git,
  repo: string,
  base: GitQueueTarget,
  landing: GitQueueTarget,
): Promise<string | undefined> {
  try {
    if (base.remote !== undefined) {
      const rolledBack = await git.run(
        repo,
        [
          "push",
          "--porcelain",
          `--force-with-lease=${base.branchRef}:${landing.sha}`,
          base.remote,
          `${base.sha}:${base.branchRef}`,
        ],
        true,
      )
      const restored = await authoritativeQueueBase(git, repo, base.branch)
      return rolledBack.code === 0 && restored.sha === base.sha
        ? undefined
        : rolledBack.stderr || rolledBack.stdout || `could not restore '${base.branch}' after source ref loss`
    }

    const checkedOut = await checkedOutWorktree(git, repo, base.branchRef)
    if (checkedOut !== undefined) {
      if ((await git.commit(checkedOut, "HEAD")) !== landing.sha) return `'${base.branch}' moved during rollback`
      const rolledBack = await git.run(checkedOut, ["reset", "--merge", base.sha], true)
      const restored = await git.run(
        checkedOut,
        ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"],
        true,
      )
      if (rolledBack.code !== 0 || restored.code !== 0) {
        const detail = [rolledBack.stderr, restored.stderr].filter((value) => value !== "").join("\n")
        return detail || `could not restore '${base.branch}' after source ref loss`
      }
    } else {
      const rolledBack = await git.run(repo, ["update-ref", base.branchRef, base.sha, landing.sha], true)
      if (rolledBack.code !== 0) {
        return rolledBack.stderr || rolledBack.stdout || `'${base.branch}' moved during rollback`
      }
    }
    const restored = await authoritativeQueueBase(git, repo, base.branch)
    return restored.sha === base.sha ? undefined : `could not restore '${base.branch}' after source ref loss`
  } catch (cause) {
    return messageOf(cause)
  }
}

export function gitMergeStep<Shape extends PRShape>(options: GitMergeOptions): StepRunner<Shape, IntegrationProof> {
  const repo = resolve(options.repo)
  const git = createGit(options.inject.process, options.env)
  return async (input, context): Promise<JobResult<IntegrationProof>> => {
    try {
      const branch = primaryPR(input).base
      const candidate = await mergeCandidate(git, repo, input, context, {
        allowAuthoredGitlinks: (options.env ?? globalThis.process.env).YRD_ALLOW_AUTHORED_GITLINKS === "1",
      })
      if (candidate.status !== "passed") return candidate
      const { base, checked } = candidate
      const baseSha = base.sha
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
            const sourceRefError = await sourceCandidateRefError(git, repo, checked.sourceRewrites ?? [])
            if (sourceRefError !== undefined) return failed("invalid-candidate", sourceRefError)
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
              output: integrationProof(checked.candidateSha, checked),
            }
          },
        )
        const landing = await authoritativeQueueBase(git, repo, branch)
        const missing = await landingError(git, repo, input, checked, landing.sha)
        if (missing === undefined) {
          const sourceRefError = await sourceCandidateRefError(git, repo, checked.sourceRewrites ?? [])
          if (sourceRefError !== undefined) {
            const rollbackError = await rollbackQueueBase(git, repo, base, landing)
            if (rollbackError !== undefined) return failed("merge-rollback-failed", rollbackError)
            return failed("invalid-candidate", sourceRefError)
          }
          return {
            status: "passed",
            output: integrationProof(landing.sha, checked),
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
        const aligned = await git.run(
          checkedOut,
          ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"],
          true,
        )
        if (aligned.code !== 0) {
          const rolledBack = await git.run(checkedOut, ["reset", "--merge", baseSha], true)
          const restored = await git.run(
            checkedOut,
            ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"],
            true,
          )
          if (rolledBack.code !== 0 || restored.code !== 0) {
            return failed(
              "merge-rollback-failed",
              [aligned.stderr, rolledBack.stderr, restored.stderr].filter((detail) => detail !== "").join("\n"),
            )
          }
          return failed(
            "candidate-submodules-failed",
            aligned.stderr || aligned.stdout || "could not align landed candidate submodules",
          )
        }
        const sourceRefError = await sourceCandidateRefError(git, repo, checked.sourceRewrites ?? [])
        if (sourceRefError !== undefined) {
          const rolledBack = await git.run(checkedOut, ["reset", "--merge", baseSha], true)
          const restored = await git.run(
            checkedOut,
            ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"],
            true,
          )
          if (rolledBack.code !== 0 || restored.code !== 0) {
            return failed(
              "merge-rollback-failed",
              [rolledBack.stderr, restored.stderr].filter((detail) => detail !== "").join("\n"),
            )
          }
          return failed("invalid-candidate", sourceRefError)
        }
      } else {
        const expected = base.local ? baseSha : "0".repeat(baseSha.length)
        const moved = await git.run(repo, ["update-ref", base.branchRef, checked.candidateSha, expected], true)
        if (moved.code !== 0) return failed("stale-base", moved.stderr || "base branch moved")
      }
      return {
        status: "passed",
        output: integrationProof(checked.candidateSha, checked),
      }
    } catch (cause) {
      const refusal = queueAuthorityRefusal(cause)
      if (refusal !== undefined) {
        return failedWithEvidence(failureFact(cause)?.code ?? "queue-environment-refused", messageOf(cause), refusal)
      }
      return failed("merge-failed", messageOf(cause))
    }
  }
}

export function configuredMergeStep<Shape extends PRShape>(
  options: ConfiguredMergeOptions,
): StepRunner<Shape, IntegrationProof> {
  const repo = resolve(options.repo)
  const git = createGit(options.inject.process, options.env)
  return async (input, context): Promise<JobResult<IntegrationProof>> => {
    try {
      const branch = primaryPR(input).base
      const candidate = await mergeCandidate(git, repo, input, context, {
        artifactRoot: options.artifactRoot,
        allowAuthoredGitlinks: (options.env ?? globalThis.process.env).YRD_ALLOW_AUTHORED_GITLINKS === "1",
      })
      if (candidate.status !== "passed") return candidate
      const command = configuredCommandStep<Shape>({
        inject: options.inject,
        command: options.command,
        cwd: repo,
        purpose: "merge",
        artifactRoot: options.artifactRoot ?? join(repo, ".git", "yrd", "artifacts"),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        variables: () => ({
          YRD_CANDIDATE_SHA: candidate.checked.candidateSha,
          YRD_CANDIDATE_REF: candidate.checked.candidateRef,
          ...(options.environment === undefined ? {} : { YRD_ENVIRONMENT: options.environment }),
        }),
      })

      const outcome = await command(input, context)
      let landing: GitQueueTarget
      try {
        landing = await authoritativeQueueBase(git, repo, branch)
      } catch (cause) {
        const refusal = queueAuthorityRefusal(cause)
        if (refusal !== undefined) {
          return failedWithEvidence(failureFact(cause)?.code ?? "queue-environment-refused", messageOf(cause), refusal)
        }
        return outcome.status === "failed"
          ? failed(outcome.error.code, outcome.error.message)
          : failed("merge-verification-failed", messageOf(cause))
      }
      const missing = await landingError(git, repo, input, candidate.checked, landing.sha)
      if (missing === undefined) {
        const sourceRefError = await sourceCandidateRefError(git, repo, candidate.checked.sourceRewrites ?? [])
        if (sourceRefError !== undefined) {
          const rollbackError = await rollbackQueueBase(git, repo, candidate.base, landing)
          if (rollbackError !== undefined) return failed("merge-rollback-failed", rollbackError)
          return failed("invalid-candidate", sourceRefError)
        }
        return {
          status: "passed",
          output: integrationProof(landing.sha, candidate.checked),
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
      const refusal = queueAuthorityRefusal(cause)
      if (refusal !== undefined) {
        return failedWithEvidence(failureFact(cause)?.code ?? "queue-environment-refused", messageOf(cause), refusal)
      }
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

function integrationProof(commit: string, checked: PinnedCandidate): IntegrationProof {
  return IntegrationProofSchema.parse({
    commit,
    baseSha: commit,
    ...(checked.sourceRewrites === undefined ? {} : { sourceRewrites: checked.sourceRewrites }),
  })
}

function failed<Output extends JsonValue = JsonValue>(
  code: string,
  message: string,
  output?: Output,
): JobResult<Output> {
  return { status: "failed", error: { code, message }, ...(output === undefined ? {} : { output }) }
}

function failedWithEvidence(code: string, message: string, evidence: JsonValue): JobResult<never> {
  return { status: "failed", error: { code, message, evidence } }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
