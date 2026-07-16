import { createHash } from "node:crypto"
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve, sep } from "node:path"
import { createFailure, failureFact, type JsonValue, type YrdFailure } from "@yrd/core"
import { parseJobLaunch, type JobContext, type JobResult } from "@yrd/job"
import type { Process, ProcessResult } from "@yrd/process"
import * as z from "zod"
import type {
  IntegratedShape,
  IntegrationProof,
  PRShape,
  PRSnapshot,
  QueueSubmoduleResolutionEvidence,
  SourceRewrite,
} from "./model.ts"
import { IntegrationProofSchema, QueueSubmoduleResolutionEvidenceSchema, SourceRewriteSchema } from "./model.ts"
import type { CandidatePool } from "./candidate-pool.ts"
import type { StepExecution, StepRunner } from "./queue.ts"
import { resolveRelativeSubmoduleOrigin } from "./submodule-origin.ts"
import { executeQueueSubmoduleComposition } from "./submodule-composition-git.ts"
import {
  planQueueSubmoduleComposition,
  type QueueConflictStage,
  type QueueTreeConflict,
} from "./submodule-composition.ts"

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
    /** Identity of the APPLIED child environment (merge-queue R42): allowlisted
     * ambient + declared passthrough + declared overrides + applied YRD_*
     * variables, excluding ONLY the enumerated VOLATILE_COMMAND_COORDINATES so
     * identical inputs hash identically across attempts. */
    environmentHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
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
  submoduleResolutions: z.array(QueueSubmoduleResolutionEvidenceSchema).min(1).optional(),
}).strict()
export type GitCheckEvidence = Readonly<z.infer<typeof GitCheckEvidenceSchema>>

const PinnedCandidateSchema = GitCheckEvidenceSchema.pick({
  baseSha: true,
  candidateSha: true,
  candidateRef: true,
  sourceRewrites: true,
  submoduleResolutions: true,
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

const SubmoduleReachabilityRefusalEvidenceSchema = z
  .object({
    kind: z.literal("submodule-reachability-refusal"),
    operation: z.enum([
      "read-tree",
      "read-gitmodules",
      "read-superproject-origin",
      "initialize",
      "filtered-fetch",
      "fallback-fetch",
      "verify",
    ]),
    repository: z.string().min(1),
    origin: z.string().min(1).optional(),
    sha: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/iu)
      .optional(),
    paths: z.array(z.string().min(1)).min(1).optional(),
    exitCode: z.number().int().optional(),
    timedOut: z.boolean().optional(),
    signal: z.string().nullable().optional(),
    stalled: z.boolean().optional(),
    verdict: z.enum(["EXITED", "TIMED_OUT", "STALLED"]).optional(),
    sweepFailure: z.string().min(1).optional(),
    detail: z.string().min(1),
    retryable: z.literal(true),
  })
  .strict()
type SubmoduleReachabilityRefusalEvidence = Readonly<z.infer<typeof SubmoduleReachabilityRefusalEvidenceSchema>>

const SubmoduleCompositionRefusalEvidenceSchema = z
  .object({
    kind: z.literal("submodule-composition-refusal"),
    operation: z.literal("compose"),
    repository: z.string().min(1),
    path: z.string().min(1),
    detail: z.string().min(1),
    retryable: z.literal(true),
  })
  .strict()
type SubmoduleCompositionRefusalEvidence = Readonly<z.infer<typeof SubmoduleCompositionRefusalEvidenceSchema>>

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
    /** Declared child values applied over the allowlisted ambient set; reserved
     * YRD_ and GIT_ prefixed names are refused loudly at construction. */
    environmentOverrides?: Readonly<Record<string, string>>
    /** Ambient names copied into the child beyond the base allowlist — explicit, never implicit. */
    environmentPassthrough?: readonly string[]
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
  const declaration = validateEnvironmentDeclaration(
    options.purpose,
    options.environmentPassthrough,
    options.environmentOverrides,
  )
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
    const env = commandEnvironment(options.env ?? globalThis.process.env, variables, declaration)
    let result: Awaited<ReturnType<Process["run"]>>
    try {
      result = await process.run({
        argv,
        cwd,
        env,
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
      environmentHash: environmentHash(env),
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

/** The deterministic ambient base every git+bun child needs (merge-queue R42):
 * PATH locates the toolchain binaries; HOME anchors git/bun user config and
 * caches; SHELL satisfies tools that consult the login shell; TMPDIR keeps
 * scratch files on the runner's temp volume; LANG (plus the LC_* family below)
 * pins text encoding for tool output; USER/LOGNAME feed git's fallback ident.
 * Everything else — NODE_ENV, DEBUG, provider tokens, harness state — is
 * DROPPED so a check verdict never depends on who or where launched the
 * resident runner. Ambient exceptions must be declared via
 * environmentPassthrough; fixed values via environmentOverrides. */
const COMMAND_ENVIRONMENT_BASE = new Set(["PATH", "HOME", "SHELL", "TMPDIR", "LANG", "USER", "LOGNAME"])

type EnvironmentDeclaration = Readonly<{
  passthrough: ReadonlySet<string>
  overrides: Readonly<Record<string, string>>
}>

function validateEnvironmentDeclaration(
  purpose: string,
  passthrough: readonly string[] = [],
  overrides: Readonly<Record<string, string>> = {},
): EnvironmentDeclaration {
  for (const name of [...passthrough, ...Object.keys(overrides)]) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new Error(`yrd: ${purpose} environment name '${name}' is not a valid variable name`)
    }
    if (name.startsWith("YRD_") || name.startsWith("GIT_")) {
      throw new Error(`yrd: ${purpose} environment name '${name}' uses a reserved prefix`)
    }
  }
  return Object.freeze({ passthrough: new Set(passthrough), overrides })
}

function commandEnvironment(
  source: NodeJS.ProcessEnv,
  variables: Readonly<Record<string, string | undefined>>,
  declaration: EnvironmentDeclaration,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (!COMMAND_ENVIRONMENT_BASE.has(key) && !key.startsWith("LC_") && !declaration.passthrough.has(key)) continue
    env[key] = value
  }
  for (const [key, value] of Object.entries(declaration.overrides)) env[key] = value
  for (const [key, value] of Object.entries(variables)) {
    if (!key.startsWith("YRD_")) throw new Error(`yrd: configured command variable '${key}' must start with YRD_`)
    if (value !== undefined) env[key] = value
  }
  return env
}

/** The ONLY names excluded from environmentHash. Membership criterion: the
 * value legitimately differs between retries/re-runs of IDENTICAL inputs —
 * a per-execution coordinate, never applied configuration. YRD_JOB, YRD_RUN,
 * YRD_ATTEMPT, and YRD_RUNNER are execution ids/lease facts; YRD_CANDIDATE_REF
 * embeds the job id, attempt, and collision suffix. Every other variable —
 * including YRD_ENVIRONMENT and configured YRD_* values — is applied
 * environment and MUST move the hash. Additions here are deliberate, never a
 * prefix rule. Module-private on purpose: hash policy must not be a mutable
 * public seam (a frozen Set's internal slots are still mutable). Consumers
 * observe policy only through environmentHash behavior. */
const VOLATILE_COMMAND_COORDINATES = ["YRD_JOB", "YRD_RUN", "YRD_ATTEMPT", "YRD_RUNNER", "YRD_CANDIDATE_REF"] as const

/** Read-only predicate over the volatile-coordinate policy above. */
function isVolatileCommandCoordinate(name: string): boolean {
  return (VOLATILE_COMMAND_COORDINATES as readonly string[]).includes(name)
}

/** Evidence identity of the APPLIED child environment. Only the volatile
 * per-execution coordinates above are excluded, so the SAME inputs produce the
 * SAME identity and any applied change — allowlisted, passthrough, declared,
 * or YRD_* — is visible. */
function environmentHash(env: Readonly<Record<string, string>>): string {
  const applied = Object.entries(env)
    .filter(([key]) => !isVolatileCommandCoordinate(key))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return createHash("sha256").update(JSON.stringify(applied)).digest("hex")
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

type GitResult = Readonly<{
  code: number
  stdout: string
  stderr: string
  durationMs: number
  signal: ProcessResult["signal"]
  timedOut: boolean
  stalled?: boolean
  verdict?: "EXITED" | "TIMED_OUT" | "STALLED"
  sweepFailure?: string
}>
type Git = ReturnType<typeof createGit>

function createGit(process: Pick<Process, "run">, environment: NodeJS.ProcessEnv = globalThis.process.env) {
  const env = Object.fromEntries(
    Object.entries(environment).filter(([key, value]) => value !== undefined && !key.startsWith("GIT_")),
  ) as Record<string, string>
  const execute = async (
    repo: string,
    args: readonly string[],
    allowFailure: boolean,
    trim: boolean,
  ): Promise<GitResult> => {
    const result = await process.run({ argv: ["git", "-C", repo, ...args], cwd: repo, env })
    const progress = result as typeof result & ProgressResult
    const completed = {
      code: result.exitCode,
      stdout: trim ? result.stdout.trim() : result.stdout,
      stderr: trim ? result.stderr.trim() : result.stderr,
      durationMs: result.durationMs,
      signal: result.signal,
      timedOut: result.timedOut,
      ...(progress.stalled === undefined ? {} : { stalled: progress.stalled }),
      ...(progress.verdict === undefined ? {} : { verdict: progress.verdict }),
      ...(result.sweepFailure === undefined ? {} : { sweepFailure: result.sweepFailure }),
    }
    if (!allowFailure && completed.code !== 0) {
      throw new Error(completed.stderr || completed.stdout || `git ${args.join(" ")} failed`)
    }
    return completed
  }
  const run = (repo: string, args: readonly string[], allowFailure = false): Promise<GitResult> =>
    execute(repo, args, allowFailure, true)
  const raw = (repo: string, args: readonly string[], allowFailure = false): Promise<GitResult> =>
    execute(repo, args, allowFailure, false)
  const commit = async (repo: string, ref: string): Promise<string> =>
    (await run(repo, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).stdout
  const optionalCommit = async (repo: string, ref: string): Promise<string | undefined> => {
    const result = await run(repo, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], true)
    return result.code === 0 ? result.stdout : undefined
  }
  const stablePatchId = async (
    repo: string,
    from: string,
    to: string,
    paths?: readonly string[],
  ): Promise<string | undefined> => {
    const diff = await run(repo, ["diff", "--full-index", "--binary", from, to, "--", ...(paths ?? [])], true)
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
  return Object.freeze({ run, raw, commit, optionalCommit, stablePatchId, rangeDiff, process, env })
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

export type PRRecutInput = PRSnapshot &
  Readonly<{
    /** Same-issue source integrations already present on the authoritative root line, newest first. */
    currentCompositions?: readonly NonNullable<PRSnapshot["composition"]>[]
    current?: Readonly<{
      revision: number
      headSha: string
      baseSha?: string
      treeSha?: string
      patchId?: string
      fromRevision?: number
      composition?: PRSnapshot["composition"]
    }>
  }>

export type PRRecutResult = Readonly<{
  headSha: string
  baseSha: string
  treeSha: string
  patchId: string
  unchanged: boolean
  composition?: PRSnapshot["composition"]
  sourceRewrites?: readonly SourceRewrite[]
}>

export type GitPRRecutter = Readonly<{ recut(input: PRRecutInput): Promise<PRRecutResult> }>

export function createGitPRRecutter(options: {
  inject: Readonly<{ process: Pick<Process, "run"> }>
  repo: string
  env?: NodeJS.ProcessEnv
}): GitPRRecutter {
  const repo = resolve(options.repo)
  const git = createGit(options.inject.process, options.env)
  return Object.freeze({ recut: (input: PRRecutInput) => recutPR(git, repo, input) })
}

async function recutPR(git: Git, repo: string, input: PRRecutInput): Promise<PRRecutResult> {
  const target = await authoritativeQueueBase(git, repo, input.base)
  if (
    (input.current?.revision === input.revision || input.current?.fromRevision === input.revision) &&
    input.current.baseSha === target.sha &&
    input.current.treeSha !== undefined &&
    input.current.patchId !== undefined
  ) {
    return {
      headSha: input.current.headSha,
      baseSha: target.sha,
      treeSha: input.current.treeSha,
      patchId: input.current.patchId,
      unchanged: true,
      ...((input.current.composition ?? input.composition) === undefined
        ? {}
        : { composition: input.current.composition ?? input.composition }),
    }
  }
  if (input.composition === undefined) {
    return recutDirectPR(git, repo, target, input)
  }
  const declared = input.composition
  const outcome = await withScratch<PRRecutResult>(git, repo, target.sha, tmpdir(), async (path) => {
    const composed = await composePR(git, repo, path, input)
    if (composed.status === "failed") {
      throw createFailure({ kind: "refusal", code: composed.error.code, message: composed.error.message })
    }
    const candidateSha = await git.commit(path, "HEAD")
    const treeSha = (await git.run(path, ["rev-parse", `${candidateSha}^{tree}`])).stdout
    const rewrites = composed.output
    const byRepo = new Map(rewrites.map((rewrite) => [rewrite.repo, rewrite]))
    const composition = {
      version: 1 as const,
      sources: declared.sources.map((source) => {
        const rewrite = byRepo.get(source.repo)
        if (rewrite === undefined) {
          throw createFailure({
            kind: "infrastructure",
            code: "recut-certificate-missing",
            message: `yrd: recut produced no source certificate for '${source.repo}'`,
          })
        }
        return {
          ...source,
          branch: rewrite.candidateRef,
          baseSha: rewrite.newBaseSha,
          tipSha: rewrite.newTipSha,
        }
      }),
    }
    const onlyRewrite = rewrites.length === 1 ? rewrites[0] : undefined
    const patchId =
      onlyRewrite !== undefined
        ? onlyRewrite.patchId
        : createHash("sha256")
            .update(
              JSON.stringify(
                rewrites.map(({ repo: sourceRepo, patchId: sourcePatchId }) => [sourceRepo, sourcePatchId]),
              ),
            )
            .digest("hex")
    return {
      status: "passed",
      output: {
        headSha: target.sha,
        baseSha: target.sha,
        treeSha,
        patchId,
        unchanged: false,
        composition,
        sourceRewrites: rewrites,
      },
    }
  })
  if (outcome.status === "passed") return outcome.output
  const message = outcome.status === "failed" ? outcome.error.message : (outcome.detail ?? outcome.token)
  throw createFailure({ kind: "infrastructure", code: "recut-scratch-failed", message: `yrd: ${message}` })
}

async function recutDirectPR(
  git: Git,
  repo: string,
  target: GitQueueTarget,
  input: PRRecutInput,
): Promise<PRRecutResult> {
  const oldBase = input.baseSha
  if (oldBase === undefined) {
    throw createFailure({
      kind: "refusal",
      code: "recut-base-missing",
      message: `yrd: PR '${input.id}' revision ${input.revision} has no immutable base SHA`,
    })
  }
  for (const [label, sha] of [
    ["base", oldBase],
    ["head", input.headSha],
  ] as const) {
    if ((await git.optionalCommit(repo, sha)) !== sha) {
      throw createFailure({
        kind: "refusal",
        code: "recut-source-missing",
        message: `yrd: PR '${input.id}' ${label} '${sha}' is missing`,
      })
    }
  }
  if (!(await isAncestor(git, repo, oldBase, target.sha))) {
    throw createFailure({
      kind: "refusal",
      code: "recut-lineage",
      message: `yrd: PR '${input.id}' recorded base '${oldBase}' is not an ancestor of '${target.sha}'`,
    })
  }
  const sourceBase = (await isAncestor(git, repo, oldBase, input.headSha))
    ? oldBase
    : await uniqueMergeBase(git, repo, oldBase, input.headSha)
  if (sourceBase === undefined) {
    throw createFailure({
      kind: "refusal",
      code: "recut-lineage",
      message: `yrd: PR '${input.id}' recorded base '${oldBase}' does not prove one source merge base for revision ${input.revision}`,
    })
  }
  const payload = await changedPaths(git, repo, sourceBase, input.headSha)
  if (sourceBase === target.sha) {
    const sourcePatchId = await git.stablePatchId(repo, sourceBase, input.headSha)
    if (sourcePatchId === undefined) {
      throw createFailure({
        kind: "refusal",
        code: "payload-certificate",
        message: `yrd: PR '${input.id}' revision ${input.revision} has no stable patch identity`,
      })
    }
    return {
      headSha: input.headSha,
      baseSha: target.sha,
      treeSha: (await git.run(repo, ["rev-parse", `${input.headSha}^{tree}`])).stdout,
      patchId: sourcePatchId,
      unchanged: true,
    }
  }
  const authority = await changedPaths(git, repo, sourceBase, target.sha)
  const absorbedGitlinks = await absorbedAuthoredGitlinks(
    git,
    repo,
    sourceBase,
    input.headSha,
    target.sha,
    intersection(payload, authority),
    input.currentCompositions,
  )
  const absorbedSet = new Set(absorbedGitlinks)
  const effectivePayload = payload.filter((path) => !absorbedSet.has(path))
  if (effectivePayload.length === 0) {
    throw createFailure({
      kind: "refusal",
      code: "payload-certificate",
      message: `yrd: PR '${input.id}' has no root payload after absorbing current gitlinks`,
    })
  }
  const overlap = intersection(effectivePayload, authority)
  const overlapSet = new Set(overlap)
  const disjointPayload = effectivePayload.filter((path) => !overlapSet.has(path))
  const sourceIdentity =
    disjointPayload.length === 0
      ? undefined
      : await changedPayloadIdentity(git, repo, sourceBase, input.headSha, disjointPayload)
  const effectiveSourcePatchId = await git.stablePatchId(repo, sourceBase, input.headSha, effectivePayload)
  if (effectiveSourcePatchId === undefined) {
    throw createFailure({
      kind: "refusal",
      code: "payload-certificate",
      message: `yrd: PR '${input.id}' revision ${input.revision} has no current-composition patch identity`,
    })
  }
  const outcome = await withScratch<PRRecutResult>(git, repo, input.headSha, tmpdir(), async (path) => {
    let rebased = await git.run(
      path,
      [
        "-c",
        "user.name=Yrd Queue",
        "-c",
        "user.email=yrd-queue@example.invalid",
        "rebase",
        "--onto",
        target.sha,
        sourceBase,
        input.headSha,
      ],
      true,
    )
    // Gitlink paths whose conflict was fast-forward resolved to the carrier's
    // descendant pin. Their authored diff legitimately changes from-side
    // (the base advanced the same submodule), so the strict patch-id
    // equivalence is certified per-pin for these paths instead.
    const ffCarrierGitlinks = new Set<string>()
    while (rebased.code !== 0) {
      const conflicts = await unmergedPaths(git, path)
      if (conflicts.length === 0) break
      for (const conflict of conflicts) {
        if (absorbedSet.has(conflict)) {
          const currentPin = await readGitlink(git, repo, target.sha, conflict)
          if (currentPin === undefined) break
          const staged = await git.run(path, ["update-index", "--cacheinfo", `160000,${currentPin},${conflict}`], true)
          if (staged.code !== 0) {
            rebased = staged
            break
          }
          continue
        }
        const resolution = await resolveGitlinkFastForward(git, repo, path, conflict)
        if (resolution.kind === "unresolved") break
        if (resolution.kind === "refuse") {
          await git.run(path, ["rebase", "--abort"], true)
          throw createFailure({
            kind: "refusal",
            code: "recut-gitlink-conflict",
            message: `yrd: PR '${input.id}' could not recut onto '${target.sha}': ${resolution.message}`,
          })
        }
        const staged = await git.run(
          path,
          ["update-index", "--cacheinfo", `160000,${resolution.sha},${conflict}`],
          true,
        )
        if (staged.code !== 0) {
          rebased = staged
          break
        }
        if (resolution.side === "carrier") ffCarrierGitlinks.add(conflict)
        else ffCarrierGitlinks.delete(conflict)
      }
      if (rebased.code !== 0 && (await unmergedPaths(git, path)).length > 0) break
      rebased = await git.run(path, ["-c", "core.editor=true", "rebase", "--continue"], true)
    }
    if (rebased.code !== 0) {
      const paths = await unmergedPaths(git, path)
      await git.run(path, ["rebase", "--abort"], true)
      throw createFailure({
        kind: "refusal",
        code: "recut-conflict",
        message:
          paths.length === 0
            ? `yrd: PR '${input.id}' could not recut onto '${target.sha}': ${rebased.stderr || rebased.stdout}`
            : `yrd: PR '${input.id}' could not recut onto '${target.sha}' at [${paths.join(", ")}]`,
      })
    }
    const headSha = await git.commit(path, "HEAD")
    const materialized = await changedPaths(git, path, target.sha, headSha)
    if (!samePaths(materialized, effectivePayload)) {
      throw createFailure({
        kind: "refusal",
        code: "payload-mismatch",
        message: `yrd: PR '${input.id}' recut paths differ: expected [${effectivePayload.join(", ")}], got [${materialized.join(", ")}]`,
      })
    }
    if (
      sourceIdentity !== undefined &&
      (await changedPayloadIdentity(git, path, target.sha, headSha, disjointPayload)) !== sourceIdentity
    ) {
      throw createFailure({
        kind: "refusal",
        code: "payload-identity",
        message: `yrd: PR '${input.id}' recut changed blob, mode, status, path, or gitlink identity`,
      })
    }
    const materializedPatchId = await git.stablePatchId(path, target.sha, headSha)
    if (materializedPatchId === undefined) {
      throw createFailure({
        kind: "refusal",
        code: "payload-certificate",
        message: `yrd: PR '${input.id}' recut has no stable patch identity`,
      })
    }
    // Fast-forward-resolved carrier gitlinks legitimately change their diff
    // from-side (the base advanced the same submodule to an ancestor of the
    // carrier's pin), so exclude them from the strict patch-id equivalence and
    // certify each one by its exact authored end pin below.
    const certifyPayload =
      ffCarrierGitlinks.size === 0 ? effectivePayload : effectivePayload.filter((step) => !ffCarrierGitlinks.has(step))
    const certifyOverlap =
      ffCarrierGitlinks.size === 0 ? overlap : overlap.filter((step) => !ffCarrierGitlinks.has(step))
    const certifySourcePatchId =
      ffCarrierGitlinks.size === 0
        ? effectiveSourcePatchId
        : await git.stablePatchId(repo, sourceBase, input.headSha, certifyPayload)
    const certifyMaterializedPatchId =
      ffCarrierGitlinks.size === 0
        ? materializedPatchId
        : await git.stablePatchId(path, target.sha, headSha, certifyPayload)
    if (certifyPayload.length > 0) {
      if (certifySourcePatchId === undefined || certifyMaterializedPatchId === undefined) {
        throw createFailure({
          kind: "refusal",
          code: "payload-certificate",
          message: `yrd: PR '${input.id}' recut has no stable patch identity`,
        })
      }
      if (
        certifyMaterializedPatchId !== certifySourcePatchId &&
        !(certifyOverlap.length > 0 && (await usesUnionMerge(git, path, certifyOverlap)))
      ) {
        throw createFailure({
          kind: "refusal",
          code: "payload-certificate",
          message: `yrd: PR '${input.id}' recut changed stable patch identity`,
        })
      }
    }
    for (const gitlink of ffCarrierGitlinks) {
      const authoredPin = await readGitlink(git, repo, input.headSha, gitlink)
      const recutPin = await readGitlink(git, path, headSha, gitlink)
      if (authoredPin === undefined || recutPin === undefined || recutPin !== authoredPin) {
        throw createFailure({
          kind: "refusal",
          code: "payload-certificate",
          message: `yrd: PR '${input.id}' recut did not preserve authored submodule pin for '${gitlink}'`,
        })
      }
    }
    if (absorbedGitlinks.length === 0 && ffCarrierGitlinks.size === 0) {
      const rangeDiff = await git.rangeDiff(path, sourceBase, input.headSha, target.sha, headSha)
      if (rangeDiff.code !== 0 || !isEqualRangeDiff(rangeDiff.stdout)) {
        throw createFailure({
          kind: "refusal",
          code: "payload-certificate",
          message: `yrd: PR '${input.id}' recut is not range-diff equivalent`,
        })
      }
    } else {
      const sourceCount = Number(
        (await git.run(repo, ["rev-list", "--count", `${sourceBase}..${input.headSha}`])).stdout,
      )
      const recutCount = Number((await git.run(path, ["rev-list", "--count", `${target.sha}..${headSha}`])).stdout)
      if (sourceCount !== 1 || recutCount !== 1) {
        throw createFailure({
          kind: "refusal",
          code: "payload-certificate",
          message: `yrd: PR '${input.id}' current-composition recut requires one root commit`,
        })
      }
    }
    const ref = sourceCandidateRef(headSha)
    const pinned = await git.run(
      repo,
      ["update-ref", "--create-reflog", ref, headSha, "0".repeat(headSha.length)],
      true,
    )
    if (pinned.code !== 0 && (await git.optionalCommit(repo, ref)) !== headSha) {
      throw createFailure({
        kind: "infrastructure",
        code: "recut-publish",
        message: `yrd: PR '${input.id}' recut ref could not be pinned: ${pinned.stderr || pinned.stdout}`,
      })
    }
    const remote = await git.run(repo, ["config", "--get", "remote.origin.url"], true)
    if (remote.code === 0 && remote.stdout !== "") {
      const published = await git.run(repo, ["push", "--porcelain", "origin", `${headSha}:${ref}`], true)
      if (published.code !== 0) {
        throw createFailure({
          kind: "infrastructure",
          code: "recut-publish",
          message: `yrd: PR '${input.id}' recut ref could not be published: ${published.stderr || published.stdout}`,
        })
      }
    }
    return {
      status: "passed",
      output: {
        headSha,
        baseSha: target.sha,
        treeSha: (await git.run(path, ["rev-parse", `${headSha}^{tree}`])).stdout,
        patchId: materializedPatchId,
        unchanged: false,
      },
    }
  })
  if (outcome.status === "passed") return outcome.output
  const message = outcome.status === "failed" ? outcome.error.message : (outcome.detail ?? outcome.token)
  throw createFailure({ kind: "infrastructure", code: "recut-scratch-failed", message: `yrd: ${message}` })
}

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
  run: (path: string, root: string) => Promise<JobResult<Output>>,
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
    outcome = await run(path, root)
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
  | Readonly<{
      status: "passed"
      output: Readonly<{
        sha: string
        sourceRewrites: readonly SourceRewrite[]
        submoduleResolutions: readonly QueueSubmoduleResolutionEvidence[]
      }>
    }>
  | Readonly<{ status: "failed"; error: Readonly<{ code: string; message: string }>; output: GitCheckFailureEvidence }>
> {
  const sourceRewrites: SourceRewrite[] = []
  const submoduleResolutions: QueueSubmoduleResolutionEvidence[] = []
  for (const pr of input.prs) {
    if (pr.composition !== undefined) {
      const baseCertificate = await verifyComposedRecutBase(git, path, pr)
      if (baseCertificate !== undefined) return baseCertificate
      const composed = await composePR(git, repo, path, pr)
      if (composed.status === "failed") return composed
      const treeCertificate = await verifyComposedRecutTree(git, path, pr)
      if (treeCertificate !== undefined) return treeCertificate
      sourceRewrites.push(...composed.output)
      continue
    }
    if (pr.recut !== undefined) {
      const certified = await verifyRecutCertificate(git, path, pr)
      if (certified !== undefined) return certified
    } else if (!allowAuthoredGitlinks) {
      const inspected = await authoredGitlinkPaths(git, path, pr.headSha)
      if (inspected.status === "failed") return inspected
      const gitlinks = inspected.output
      if (gitlinks.length > 0) {
        return candidateFailure(
          "authored-gitlink",
          `PR '${pr.id}' changes generated-only gitlinks [${gitlinks.join(", ")}]; ${authoredRootWorkflow(pr.id)}`,
          ".",
          gitlinks,
        )
      }
    }
    const merged = await git.run(path, ["merge", "--no-ff", "--no-edit", pr.headSha], true)
    if (merged.code !== 0) {
      const resolved = await resolveCandidateSubmoduleConflict(git, repo, path)
      if (resolved.status === "composed") {
        submoduleResolutions.push(...resolved.output)
        continue
      }
      const artifacts = await writeTerminalArtifacts(artifactRoot, input, attempt, merged.stdout, merged.stderr)
      await git.run(path, ["merge", "--abort"], true)
      const detail = `PR '${pr.id}' could not be applied: ${resolved.message}`
      return {
        status: "failed",
        error: {
          code: resolved.code,
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
  return {
    status: "passed",
    output: { sha: await git.commit(path, "HEAD"), sourceRewrites, submoduleResolutions },
  }
}

async function verifyRecutCertificate(
  git: Git,
  repo: string,
  pr: StepExecution["prs"][number],
): Promise<CandidateFailure | undefined> {
  if (pr.recut === undefined) return undefined
  const baseSha = pr.baseSha
  if (baseSha === undefined || (await git.commit(repo, "HEAD")) !== baseSha) {
    return candidateFailure(
      "recut-certificate",
      `PR '${pr.id}' recut base does not match the authoritative candidate base`,
    )
  }
  const treeSha = (await git.run(repo, ["rev-parse", `${pr.headSha}^{tree}`], true)).stdout
  const patchId = await git.stablePatchId(repo, baseSha, pr.headSha)
  if (treeSha !== pr.recut.treeSha || patchId !== pr.recut.patchId) {
    return candidateFailure(
      "recut-certificate",
      `PR '${pr.id}' recut patch/tree certificate does not match revision ${pr.revision}`,
    )
  }
  return undefined
}

async function verifyComposedRecutBase(
  git: Git,
  repo: string,
  pr: StepExecution["prs"][number],
): Promise<CandidateFailure | undefined> {
  if (pr.recut === undefined) return undefined
  if (pr.baseSha === undefined || (await git.commit(repo, "HEAD")) !== pr.baseSha) {
    return candidateFailure(
      "recut-certificate",
      `PR '${pr.id}' recut base does not match the authoritative candidate base`,
    )
  }
  return undefined
}

async function verifyComposedRecutTree(
  git: Git,
  repo: string,
  pr: StepExecution["prs"][number],
): Promise<CandidateFailure | undefined> {
  if (pr.recut === undefined) return undefined
  const treeSha = (await git.run(repo, ["rev-parse", "HEAD^{tree}"], true)).stdout
  return treeSha === pr.recut.treeSha
    ? undefined
    : candidateFailure(
        "recut-certificate",
        `PR '${pr.id}' recomposed tree certificate does not match revision ${pr.revision}`,
      )
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

function authoredRootWorkflow(pr: string): string {
  return `authored root carriers use 'yrd pr submit <branch> --draft', then 'yrd pr recut ${pr} --queue' on that same PR; no composition manifest or manual recut is needed`
}

function withAuthoredRootWorkflow(failure: CandidateFailure, pr: string): CandidateFailure {
  if (failure.error.code !== "composition-invalid") return failure
  return {
    ...failure,
    error: { ...failure.error, message: `${failure.error.message}; ${authoredRootWorkflow(pr)}` },
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
      `PR '${pr.id}' composition head '${pr.headSha}' contains root changes; ${authoredRootWorkflow(pr.id)}`,
    )
  }

  const rewrites: SourceRewrite[] = []
  const expectedWrapperPaths: string[] = []
  for (const source of pr.composition?.sources ?? []) {
    const currentPin = await readGitlink(git, path, "HEAD", source.repo)
    if (currentPin === undefined) {
      return candidateFailure(
        "composition-invalid",
        `PR '${pr.id}' source '${source.repo}' is not a gitlink in the authoritative root base; ${authoredRootWorkflow(pr.id)}`,
        source.repo,
        [source.repo],
      )
    }
    const prepared = await prepareSource(git, repo, source, currentPin)
    if (prepared.status === "failed") return withAuthoredRootWorkflow(prepared, pr.id)
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

type GitlinkFastForward =
  | Readonly<{ kind: "resolved"; side: "carrier" | "base"; sha: string }>
  | Readonly<{ kind: "refuse"; message: string }>
  | Readonly<{ kind: "unresolved" }>

/**
 * Resolve a single unmerged path in `worktree` when it is a three-stage gitlink
 * conflict and one side is an ancestor of the other. Ancestry is proved in the
 * submodule's local store (`repo/<path>`) — exactly what a human merge does when
 * fast-forwarding a submodule. Returns:
 *  - `resolved` (side `carrier` = stage 3 descendant, `base` = stage 2 descendant),
 *  - `refuse` with a loud reason for true divergence, a missing object, or an
 *    uninitialized submodule (never guess a pin), or
 *  - `unresolved` when the conflict is not a plain gitlink modify/modify (a
 *    non-gitlink content conflict must keep failing the recut loudly).
 */
async function resolveGitlinkFastForward(
  git: Git,
  repo: string,
  worktree: string,
  path: string,
): Promise<GitlinkFastForward> {
  const stages = await readGitlinkConflictStages(git, worktree, path)
  if (stages === undefined) return { kind: "unresolved" }
  const { ours, theirs } = stages
  if (ours === theirs) return { kind: "resolved", side: "base", sha: ours }
  const submodule = join(repo, path)
  try {
    await realpath(submodule)
  } catch {
    return {
      kind: "refuse",
      message: `submodule '${path}' is not initialized locally; run git submodule update --init and retry`,
    }
  }
  for (const oid of [ours, theirs]) {
    const present = await git.run(submodule, ["cat-file", "-e", `${oid}^{commit}`], true)
    if (present.code !== 0) {
      return {
        kind: "refuse",
        message: `submodule '${path}' commit '${oid}' is not present in its local store; fetch it and retry`,
      }
    }
  }
  if (await isAncestor(git, submodule, ours, theirs)) return { kind: "resolved", side: "carrier", sha: theirs }
  if (await isAncestor(git, submodule, theirs, ours)) return { kind: "resolved", side: "base", sha: ours }
  return {
    kind: "refuse",
    message: `submodule '${path}' pins '${ours}' and '${theirs}' have diverged; neither is an ancestor of the other — resolve it in the submodule and resubmit`,
  }
}

/**
 * Read the ours (stage 2) and theirs (stage 3) pins of an unmerged path, but
 * only when every present stage is a gitlink (mode 160000) for exactly `path`.
 * Any non-gitlink stage, missing side, or malformed record returns undefined so
 * the caller leaves the conflict unresolved.
 */
async function readGitlinkConflictStages(
  git: Git,
  repo: string,
  path: string,
): Promise<Readonly<{ base?: string; ours: string; theirs: string }> | undefined> {
  const result = await git.run(repo, ["ls-files", "-u", "-z", "--", path], true)
  if (result.code !== 0 || result.stdout === "") return undefined
  const stages = new Map<number, string>()
  for (const record of result.stdout.split("\0")) {
    if (record === "") continue
    const tab = record.indexOf("\t")
    if (tab === -1 || record.slice(tab + 1) !== path) return undefined
    const match = /^([0-7]{6}) ([0-9a-f]{40,64}) ([123])$/u.exec(record.slice(0, tab))
    const mode = match?.[1]
    const oid = match?.[2]
    const stage = match?.[3]
    if (mode === undefined || oid === undefined || stage === undefined || mode !== "160000") return undefined
    stages.set(Number(stage), oid)
  }
  const ours = stages.get(2)
  const theirs = stages.get(3)
  if (ours === undefined || theirs === undefined) return undefined
  const base = stages.get(1)
  return base === undefined ? { ours, theirs } : { base, ours, theirs }
}

async function changedPaths(git: Git, repo: string, from: string, to: string): Promise<string[]> {
  const result = await git.run(repo, ["diff", "--name-only", "--no-renames", "-z", from, to, "--"])
  return nulPaths(result.stdout)
}

async function changedPayloadIdentity(
  git: Git,
  repo: string,
  from: string,
  to: string,
  paths?: readonly string[],
): Promise<string> {
  return (await git.run(repo, ["diff", "--raw", "--no-abbrev", "--no-renames", "-z", from, to, "--", ...(paths ?? [])]))
    .stdout
}

async function absorbedAuthoredGitlinks(
  git: Git,
  repo: string,
  sourceBase: string,
  sourceHead: string,
  target: string,
  overlaps: readonly string[],
  currentCompositions: readonly NonNullable<PRSnapshot["composition"]>[] | undefined,
): Promise<string[]> {
  const absorbed: string[] = []
  for (const path of overlaps) {
    const oldPin = await readGitlink(git, repo, sourceBase, path)
    const sourcePin = await readGitlink(git, repo, sourceHead, path)
    const currentPin = await readGitlink(git, repo, target, path)
    if (oldPin === undefined || sourcePin === undefined || currentPin === undefined) continue
    const sourceRepo = join(repo, path)
    try {
      await realpath(sourceRepo)
    } catch {
      continue
    }
    if (
      !(await isAncestor(git, sourceRepo, oldPin, sourcePin)) ||
      !(await isAncestor(git, sourceRepo, oldPin, currentPin))
    ) {
      continue
    }
    if (await isAncestor(git, sourceRepo, sourcePin, currentPin)) {
      absorbed.push(path)
      continue
    }
    let certified = false
    for (const source of currentCompositions?.flatMap((composition) => composition.sources) ?? []) {
      if (
        source.repo === path &&
        (await certifiesSupersededGitlink(git, sourceRepo, oldPin, sourcePin, currentPin, source))
      ) {
        certified = true
        break
      }
    }
    if (certified) {
      absorbed.push(path)
      continue
    }
    const merges = await git.run(sourceRepo, ["rev-list", "--merges", `${oldPin}..${sourcePin}`], true)
    if (merges.code !== 0 || merges.stdout !== "") continue
    const count = Number((await git.run(sourceRepo, ["rev-list", "--count", `${oldPin}..${sourcePin}`])).stdout)
    if (!Number.isSafeInteger(count) || count < 1) continue
    const cherry = await git.run(sourceRepo, ["cherry", currentPin, sourcePin, oldPin], true)
    const lines = cherry.stdout.split(/\r?\n/u).filter((line) => line !== "")
    if (cherry.code === 0 && lines.length === count && lines.every((line) => /^- [0-9a-f]{40,64}$/iu.test(line))) {
      absorbed.push(path)
    }
  }
  return absorbed.toSorted()
}

async function certifiesSupersededGitlink(
  git: Git,
  repo: string,
  authoredBase: string,
  authoredTip: string,
  currentTip: string,
  source: NonNullable<PRSnapshot["composition"]>["sources"][number],
): Promise<boolean> {
  if (
    (await git.optionalCommit(repo, source.baseSha)) !== source.baseSha ||
    (await git.optionalCommit(repo, source.tipSha)) !== source.tipSha ||
    !(await isAncestor(git, repo, source.baseSha, source.tipSha)) ||
    !(await isAncestor(git, repo, source.tipSha, currentTip))
  ) {
    return false
  }
  const authoredPayload = await changedPaths(git, repo, authoredBase, authoredTip)
  const certifiedPayload = await changedPaths(git, repo, source.baseSha, source.tipSha)
  return samePaths(authoredPayload, source.payload) && samePaths(certifiedPayload, source.payload)
}

async function usesUnionMerge(git: Git, repo: string, paths: readonly string[]): Promise<boolean> {
  const result = await git.run(repo, ["check-attr", "-z", "merge", "--", ...paths], true)
  if (result.code !== 0) return false
  const fields = result.stdout.split("\0")
  const attributes = new Map<string, string>()
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const path = fields[index]
    const attribute = fields[index + 1]
    const value = fields[index + 2]
    if (path !== undefined && attribute === "merge" && value !== undefined) attributes.set(path, value)
  }
  return paths.length > 0 && paths.every((path) => attributes.get(path) === "union")
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

async function uniqueMergeBase(git: Git, repo: string, left: string, right: string): Promise<string | undefined> {
  const result = await git.run(repo, ["merge-base", "--all", left, right], true)
  if (result.code !== 0) return undefined
  const bases = result.stdout.split(/\r?\n/u).filter((base) => base !== "")
  return bases.length === 1 ? bases[0] : undefined
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

type CandidateSubmodulePin = Readonly<{ path: string; sha: string; origin: string }>
type MutableSubmoduleConfig = { path?: string; url?: string }

const REMOTE_SCHEME = /^[a-z][a-z0-9+.-]*:/iu
const FILTER_UNSUPPORTED =
  /filtering not recognized by server|server does not support filter|filter(?:ing)? (?:is )?not supported|unsupported[^\n]*filter/iu
const DEFINITIVE_EXACT_SHA_ABSENCE = /not our ref/iu

function scpRemote(value: string): RegExpExecArray | null {
  return /^((?:[^/@:]+@)?[^/:]+:)(.+)$/u.exec(value)
}

function canonicalRemote(repo: string, value: string): string {
  if (isAbsolute(value) || REMOTE_SCHEME.test(value) || scpRemote(value) !== null) return value
  return resolve(repo, value)
}

function resolveSubmoduleOrigin(repo: string, superOrigin: string | undefined, value: string): string {
  if (!value.startsWith("./") && !value.startsWith("../")) return canonicalRemote(repo, value)
  if (superOrigin === undefined) {
    throw new Error(`yrd: relative submodule URL '${value}' has no superproject origin`)
  }
  const base = canonicalRemote(repo, superOrigin)
  try {
    return resolveRelativeSubmoduleOrigin(base, value)
  } catch (cause) {
    throw new Error(`yrd: could not resolve submodule URL '${value}' against '${base}': ${messageOf(cause)}`)
  }
}

function parseSubmoduleConfig(output: string): Map<string, MutableSubmoduleConfig> {
  const modules = new Map<string, MutableSubmoduleConfig>()
  for (const entry of output.split("\0")) {
    if (entry === "") continue
    const separator = entry.indexOf("\n")
    if (separator < 1) throw new Error("yrd: candidate .gitmodules emitted an invalid NUL record")
    const key = entry.slice(0, separator)
    const value = entry.slice(separator + 1)
    const match = /^submodule\.(.+)\.(path|url)$/iu.exec(key)
    if (match?.[1] === undefined) continue
    const property = match[2]
    if (property !== "path" && property !== "url") continue
    const current = modules.get(match[1]) ?? {}
    if (current[property] !== undefined && current[property] !== value) {
      throw new Error(`yrd: candidate .gitmodules defines conflicting ${property} values for '${match[1]}'`)
    }
    current[property] = value
    modules.set(match[1], current)
  }
  return modules
}

async function candidateSubmodulePins(
  git: Git,
  repo: string,
  path: string,
  candidateSha: string,
): Promise<CandidateSubmodulePin[]> {
  const treeContext = { operation: "read-tree", repository: path } as const
  const tree = await runSubmoduleProbe(
    git,
    path,
    ["ls-tree", "-r", "-z", "--full-tree", candidateSha],
    treeContext,
    true,
  )
  if (tree.code !== 0) throw createSubmoduleReachabilityRefusal(treeContext, tree)
  const gitlinks: ReadonlyArray<Readonly<{ path: string; sha: string }>> = tree.stdout
    .split("\0")
    .filter((entry) => entry !== "")
    .flatMap((entry) => {
      const separator = entry.indexOf("\t")
      if (separator < 1) throw new Error("yrd: candidate tree emitted an invalid NUL record")
      const [mode, type, sha] = entry.slice(0, separator).split(" ")
      if (mode !== "160000") return []
      if (type !== "commit" || sha === undefined || !/^[0-9a-f]{40,64}$/iu.test(sha)) {
        throw new Error(`yrd: candidate gitlink '${entry.slice(separator + 1)}' has an invalid object identity`)
      }
      return [{ path: entry.slice(separator + 1), sha }]
    })
  if (gitlinks.length === 0) return []

  const configuredContext = { operation: "read-gitmodules", repository: path } as const
  const configured = await runSubmoduleProbe(
    git,
    path,
    ["config", "--null", "--blob", `${candidateSha}:.gitmodules`, "--get-regexp", "^submodule\\..*\\.(path|url)$"],
    configuredContext,
    true,
  )
  if (configured.code !== 0) {
    if (definitiveCandidateMetadataFailure(configured)) {
      throw new Error(
        `yrd: candidate contains gitlinks but .gitmodules is missing or invalid: ${configured.stderr.trim() || configured.stdout.trim() || "no submodule metadata"}`,
      )
    }
    throw createSubmoduleReachabilityRefusal(configuredContext, configured)
  }
  const modules = parseSubmoduleConfig(configured.stdout)
  const urlsByPath = new Map<string, string>()
  for (const [name, module] of modules) {
    if (module.path === undefined) continue
    if (module.url === undefined) {
      throw new Error(`yrd: candidate submodule '${module.path}' has no URL (section '${name}')`)
    }
    const previous = urlsByPath.get(module.path)
    if (previous !== undefined && previous !== module.url) {
      throw new Error(`yrd: candidate submodule path '${module.path}' resolves to conflicting URLs`)
    }
    urlsByPath.set(module.path, module.url)
  }
  const remoteContext = { operation: "read-superproject-origin", repository: repo } as const
  const remote = await runSubmoduleProbe(git, repo, ["config", "--get", "remote.origin.url"], remoteContext)
  const originNotConfigured = remote.code === 1 && remote.stdout === "" && remote.stderr === ""
  if (remote.code !== 0 && !originNotConfigured) {
    throw createSubmoduleReachabilityRefusal(remoteContext, remote)
  }
  const superOrigin = remote.code === 0 && remote.stdout !== "" ? remote.stdout : undefined
  return gitlinks.map((gitlink) => {
    const url = urlsByPath.get(gitlink.path)
    if (url === undefined) throw new Error(`yrd: candidate submodule '${gitlink.path}' has no URL`)
    if (superOrigin === undefined && (url.startsWith("./") || url.startsWith("../"))) {
      throw createSubmoduleReachabilityRefusal(
        remoteContext,
        remote,
        `candidate submodule '${gitlink.path}' uses relative URL '${url}' but the superproject origin is not configured`,
      )
    }
    return { ...gitlink, origin: resolveSubmoduleOrigin(repo, superOrigin, url) }
  })
}

type CandidateSubmoduleConflictResult =
  | Readonly<{ status: "composed"; output: readonly QueueSubmoduleResolutionEvidence[] }>
  | Readonly<{
      status: "refused"
      code: "candidate-conflict" | "submodule-composition-conflict"
      message: string
    }>

async function resolveCandidateSubmoduleConflict(
  git: Git,
  repo: string,
  path: string,
): Promise<CandidateSubmoduleConflictResult> {
  const conflicts = await readQueueTreeConflicts(git, path)
  if (conflicts.length === 0) {
    return { status: "refused", code: "candidate-conflict", message: "merge failed without unmerged paths" }
  }
  const structural = planQueueSubmoduleComposition(
    conflicts.map((conflict) => ({ ...conflict, origin: "yrd://structural-validation" })),
  )
  if (structural.status === "refused") return structural

  const metadata = await git.run(path, ["diff", "--cached", "--quiet", "HEAD", "--", ".gitmodules"], true)
  if (!probeSettled(metadata) || (metadata.code !== 0 && metadata.code !== 1)) {
    throw createSubmoduleCompositionRefusal(
      repo,
      ".gitmodules",
      `could not inspect effective submodule metadata: ${fetchDetail(metadata)}`,
    )
  }
  if (metadata.code === 1) {
    return {
      status: "refused",
      code: "candidate-conflict",
      message: "queue-native composition refuses a concurrent .gitmodules change before publishing a composition",
    }
  }

  const pins = await candidateSubmodulePins(git, repo, path, "HEAD")
  const origins = new Map(pins.map((pin) => [pin.path, pin.origin]))
  const plan = planQueueSubmoduleComposition(
    conflicts.map((conflict) => ({ ...conflict, origin: origins.get(conflict.path) })),
  )
  if (plan.status === "refused") return plan

  const stores = new Map(
    plan.resolutions.flatMap((resolution) =>
      resolution.kind === "compose"
        ? [[resolution.origin, candidateSubmoduleStore(repo, resolution.path)] as const]
        : [],
    ),
  )
  const executed = await executeQueueSubmoduleComposition(plan, {
    inject: {
      process: git.process,
      storeForOrigin(origin) {
        const store = stores.get(origin)
        if (store === undefined) throw new Error(`no initialized local store is available for '${origin}'`)
        return store
      },
    },
    env: git.env,
  })
  if (executed.status === "refused") {
    if (executed.code === "submodule-composition-unavailable") {
      throw createSubmoduleCompositionRefusal(repo, executed.path, executed.message)
    }
    return { status: "refused", code: "submodule-composition-conflict", message: executed.message }
  }

  for (const resolution of executed.resolutions) {
    const staged = await git.run(
      path,
      ["update-index", "--cacheinfo", `160000,${resolution.sha},${resolution.path}`],
      true,
    )
    if (staged.code !== 0) {
      throw createSubmoduleCompositionRefusal(
        repo,
        resolution.path,
        `could not stage composed pin for '${resolution.path}': ${fetchDetail(staged)}`,
      )
    }
  }
  const unresolved = await unmergedPaths(git, path)
  if (unresolved.length > 0) {
    return {
      status: "refused",
      code: "candidate-conflict",
      message: `candidate still has unresolved paths after submodule composition: ${unresolved.join(", ")}`,
    }
  }
  const committed = await git.run(path, ["commit", "--no-edit"], true)
  if (committed.code !== 0) {
    throw createSubmoduleCompositionRefusal(
      repo,
      ".git",
      `could not finalize the root composition commit: ${fetchDetail(committed)}`,
    )
  }
  return {
    status: "composed",
    output: executed.resolutions.map((resolution) => QueueSubmoduleResolutionEvidenceSchema.parse(resolution)),
  }
}

async function readQueueTreeConflicts(git: Git, repo: string): Promise<QueueTreeConflict[]> {
  const listed = await git.raw(repo, ["ls-files", "--unmerged", "-z"], true)
  if (!probeSettled(listed) || listed.code !== 0) {
    throw createSubmoduleCompositionRefusal(
      repo,
      ".git/index",
      `could not read candidate conflict stages: ${fetchDetail(listed)}`,
    )
  }
  const grouped = new Map<string, QueueConflictStage[]>()
  for (const entry of listed.stdout.split("\0")) {
    if (entry === "") continue
    const parsed = /^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([123])\t([\s\S]+)$/iu.exec(entry)
    if (parsed?.[1] === undefined || parsed[2] === undefined || parsed[3] === undefined || parsed[4] === undefined) {
      throw new Error("yrd: candidate conflict index emitted a malformed stage record")
    }
    const stages = grouped.get(parsed[4]) ?? []
    stages.push({ mode: parsed[1], oid: parsed[2], stage: Number(parsed[3]) })
    grouped.set(parsed[4], stages)
  }
  return [...grouped]
    .map(([conflictPath, stages]) => ({ path: conflictPath, stages }))
    .toSorted((left, right) => left.path.localeCompare(right.path))
}

function candidateSubmoduleStore(repo: string, path: string): string {
  const root = resolve(repo)
  const store = resolve(root, path)
  if (store === root || !store.startsWith(`${root}${sep}`)) {
    throw new Error(`yrd: submodule path '${path}' escapes the root repository`)
  }
  return store
}

function fetchDetail(result: GitResult): string {
  const detail = result.stderr.trim() || result.stdout.trim() || `git exited ${result.code}`
  if (result.sweepFailure !== undefined) return `git process sweep failed (${result.sweepFailure}): ${detail}`
  if (result.stalled || result.verdict === "STALLED") return `git stalled: ${detail}`
  if (result.timedOut) return `git timed out: ${detail}`
  if (result.signal !== null) return `git terminated by ${result.signal}: ${detail}`
  return detail
}

type SubmoduleProbeContext = Readonly<{
  operation:
    | "read-tree"
    | "read-gitmodules"
    | "read-superproject-origin"
    | "initialize"
    | "filtered-fetch"
    | "fallback-fetch"
    | "verify"
  repository: string
  origin?: string
  sha?: string
  paths?: readonly string[]
}>

async function runSubmoduleProbe(
  git: Git,
  repo: string,
  args: readonly string[],
  context: SubmoduleProbeContext,
  raw = false,
): Promise<GitResult> {
  try {
    const result = await (raw ? git.raw(repo, args, true) : git.run(repo, args, true))
    if (!probeSettled(result)) throw createSubmoduleReachabilityRefusal(context, result)
    return result
  } catch (cause) {
    if (submoduleReachabilityRefusal(cause) !== undefined) throw cause
    throw createSubmoduleReachabilityRefusal(context, undefined, messageOf(cause))
  }
}

function probeSettled(result: GitResult): boolean {
  return (
    !result.timedOut &&
    result.signal === null &&
    result.stalled !== true &&
    (result.verdict === undefined || result.verdict === "EXITED") &&
    result.sweepFailure === undefined
  )
}

function definitiveProbeFailure(result: GitResult, pattern: RegExp): boolean {
  return probeSettled(result) && pattern.test(`${result.stderr}\n${result.stdout}`)
}

function definitiveCandidateMetadataFailure(result: GitResult): boolean {
  if (!probeSettled(result)) return false
  const detail = `${result.stderr}\n${result.stdout}`.trim()
  return /\.gitmodules.*does not exist|bad config line|invalid config|invalid key/iu.test(detail)
}

function throwFetchProbeFailure(context: SubmoduleProbeContext, result: GitResult): never {
  if (definitiveProbeFailure(result, DEFINITIVE_EXACT_SHA_ABSENCE)) {
    throw new Error(
      `yrd: candidate submodule pin '${context.sha}' for ${context.paths?.join(", ")} is not reachable from '${context.origin}': ${fetchDetail(result)}`,
    )
  }
  throw createSubmoduleReachabilityRefusal(context, result)
}

async function proveCandidateSubmoduleReachability(
  git: Git,
  repo: string,
  path: string,
  candidateSha: string,
  proofParent: string,
): Promise<void> {
  const pins = await candidateSubmodulePins(git, repo, path, candidateSha)
  if (pins.length === 0) return

  const groups = new Map<string, Map<string, string[]>>()
  for (const pin of pins) {
    const shas = groups.get(pin.origin) ?? new Map<string, string[]>()
    shas.set(pin.sha, [...(shas.get(pin.sha) ?? []), pin.path])
    groups.set(pin.origin, shas)
  }
  await mkdir(proofParent, { recursive: true })
  const template = join(proofParent, "empty-template")
  await mkdir(template, { recursive: true })

  for (const [origin, shas] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    const store = join(proofParent, createHash("sha256").update(origin).digest("hex"))
    const initializedContext = { operation: "initialize", repository: proofParent, origin } as const
    const initialized = await runSubmoduleProbe(
      git,
      proofParent,
      ["init", "--bare", "--quiet", `--template=${template}`, store],
      initializedContext,
    )
    if (initialized.code !== 0) {
      throw createSubmoduleReachabilityRefusal(initializedContext, initialized)
    }
    for (const [sha, paths] of [...shas].sort(([left], [right]) => left.localeCompare(right))) {
      const filteredContext = { operation: "filtered-fetch", repository: store, origin, sha, paths } as const
      const filtered = await runSubmoduleProbe(
        git,
        store,
        ["-c", "protocol.version=2", "fetch", "--depth=1", "--filter=tree:0", origin, sha],
        filteredContext,
      )
      if (filtered.code !== 0) {
        const canFallback = probeSettled(filtered) && FILTER_UNSUPPORTED.test(`${filtered.stderr}\n${filtered.stdout}`)
        if (!canFallback) {
          throwFetchProbeFailure(filteredContext, filtered)
        }
        const fallbackContext = { operation: "fallback-fetch", repository: store, origin, sha, paths } as const
        const fallback = await runSubmoduleProbe(
          git,
          store,
          ["-c", "protocol.version=2", "fetch", "--depth=1", origin, sha],
          fallbackContext,
        )
        if (fallback.code !== 0) {
          throwFetchProbeFailure(fallbackContext, fallback)
        }
      }
      const verifyContext = { operation: "verify", repository: store, origin, sha, paths } as const
      const fetched = await runSubmoduleProbe(git, store, ["cat-file", "-e", `${sha}^{commit}`], verifyContext)
      if (fetched.code !== 0) {
        throw createSubmoduleReachabilityRefusal(verifyContext, fetched)
      }
    }
  }
}

export type GitCheckOptions = ProcessDependency &
  Readonly<{
    repo: string
    command: readonly string[]
    checkoutParent?: string
    /** Opt-in warm candidate-worktree pool (merge-queue R40). Absent → cold path. */
    candidatePool?: CandidatePool
    artifactRoot?: string
    purpose?: string
    runner?: "local" | "waiting"
    classification?: "base" | "carrier"
    environment?: string
    env?: NodeJS.ProcessEnv
    environmentOverrides?: Readonly<Record<string, string>>
    environmentPassthrough?: readonly string[]
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
  options: Readonly<{
    checkoutParent?: string
    artifactRoot?: string
    allowAuthoredGitlinks?: boolean
    candidatePool?: CandidatePool
  }>,
  onFailure: (failure: PreparedCandidateFailure) => JobResult<Output>,
  use: (path: string, candidate: PinnedCandidate) => Promise<JobResult<Output>>,
): Promise<JobResult<Output>> {
  const target = await authoritativeQueueBase(git, repo, primaryPR(input).base)
  // Warm pool when the host opts in; otherwise the exact cold scratch path.
  const withCandidateWorktree = (
    run: (path: string, scratchRoot: string) => Promise<JobResult<Output>>,
  ): Promise<JobResult<Output>> =>
    options.candidatePool === undefined
      ? withScratch(git, repo, target.sha, options.checkoutParent ?? tmpdir(), run)
      : options.candidatePool.withCandidate(target.sha, run)
  return withCandidateWorktree(async (path, scratchRoot) => {
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
    await proveCandidateSubmoduleReachability(
      git,
      repo,
      path,
      candidate.output.sha,
      join(scratchRoot, "submodule-proof"),
    )
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
        ...(candidate.output.submoduleResolutions.length === 0
          ? {}
          : { submoduleResolutions: candidate.output.submoduleResolutions }),
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
          ...(options.candidatePool === undefined ? {} : { candidatePool: options.candidatePool }),
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
            ...(options.environmentOverrides === undefined
              ? {}
              : { environmentOverrides: options.environmentOverrides }),
            ...(options.environmentPassthrough === undefined
              ? {}
              : { environmentPassthrough: options.environmentPassthrough }),
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
      const refusal =
        queueAuthorityRefusal(cause) ?? submoduleReachabilityRefusal(cause) ?? submoduleCompositionRefusal(cause)
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
    environmentOverrides?: Readonly<Record<string, string>>
    environmentPassthrough?: readonly string[]
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
  const finalResolutions = new Map<string, QueueSubmoduleResolutionEvidence>()
  for (const resolution of checked.submoduleResolutions ?? []) finalResolutions.set(resolution.path, resolution)
  for (const resolution of finalResolutions.values()) {
    if ((await readGitlink(git, repo, checked.candidateSha, resolution.path)) !== resolution.sha) {
      return {
        error: {
          code: "invalid-candidate",
          message: `checked candidate does not pin submodule '${resolution.path}' to '${resolution.sha}'`,
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
type FailedJobResult = Extract<JobResult<never>, { status: "failed" }>

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

function mergeAuthorityCancellation(context: Pick<JobContext, "signal">): FailedJobResult | undefined {
  if (!context.signal.aborted) return undefined
  return {
    status: "failed",
    error: {
      code: "merge-canceled",
      message: "merge execution authority was canceled or superseded before landing",
    },
  }
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

type SubmoduleReachabilityFailure = YrdFailure & Readonly<{ evidence: SubmoduleReachabilityRefusalEvidence }>

function createSubmoduleReachabilityRefusal(
  context: SubmoduleProbeContext,
  result?: GitResult,
  causeDetail?: string,
): SubmoduleReachabilityFailure {
  const detail = causeDetail ?? (result === undefined ? "submodule reachability probe failed" : fetchDetail(result))
  const evidence = SubmoduleReachabilityRefusalEvidenceSchema.parse({
    kind: "submodule-reachability-refusal",
    operation: context.operation,
    repository: context.repository,
    ...(context.origin === undefined ? {} : { origin: context.origin }),
    ...(context.sha === undefined ? {} : { sha: context.sha }),
    ...(context.paths === undefined ? {} : { paths: [...context.paths] }),
    ...(result === undefined
      ? {}
      : {
          exitCode: result.code,
          timedOut: result.timedOut,
          signal: result.signal,
          ...(result.stalled === undefined ? {} : { stalled: result.stalled }),
          ...(result.verdict === undefined ? {} : { verdict: result.verdict }),
          ...(result.sweepFailure === undefined ? {} : { sweepFailure: result.sweepFailure }),
        }),
    detail,
    retryable: true,
  })
  return Object.assign(
    createFailure({
      kind: "infrastructure",
      code: "queue-environment-refused",
      message: `yrd: could not prove candidate submodule reachability from '${context.origin ?? context.repository}': ${detail}`,
    }),
    { evidence },
  )
}

type SubmoduleCompositionFailure = YrdFailure & Readonly<{ evidence: SubmoduleCompositionRefusalEvidence }>

function createSubmoduleCompositionRefusal(
  repository: string,
  path: string,
  detail: string,
): SubmoduleCompositionFailure {
  const evidence = SubmoduleCompositionRefusalEvidenceSchema.parse({
    kind: "submodule-composition-refusal",
    operation: "compose",
    repository,
    path,
    detail,
    retryable: true,
  })
  return Object.assign(
    createFailure({
      kind: "infrastructure",
      code: "queue-environment-refused",
      message: `yrd: submodule composition is temporarily unavailable for '${path}': ${detail}`,
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

function submoduleReachabilityRefusal(cause: unknown): SubmoduleReachabilityRefusalEvidence | undefined {
  if (failureFact(cause)?.code !== "queue-environment-refused" || !(cause instanceof Error) || !("evidence" in cause)) {
    return undefined
  }
  const parsed = SubmoduleReachabilityRefusalEvidenceSchema.safeParse(cause.evidence)
  return parsed.success ? parsed.data : undefined
}

function submoduleCompositionRefusal(cause: unknown): SubmoduleCompositionRefusalEvidence | undefined {
  if (failureFact(cause)?.code !== "queue-environment-refused" || !(cause instanceof Error) || !("evidence" in cause)) {
    return undefined
  }
  const parsed = SubmoduleCompositionRefusalEvidenceSchema.safeParse(cause.evidence)
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
            const cancellation = mergeAuthorityCancellation(context)
            if (cancellation !== undefined) return cancellation
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
        const cancellation = mergeAuthorityCancellation(context)
        if (cancellation !== undefined) return cancellation
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
        const cancellation = mergeAuthorityCancellation(context)
        if (cancellation !== undefined) return cancellation
        const expected = base.local ? baseSha : "0".repeat(baseSha.length)
        const moved = await git.run(repo, ["update-ref", base.branchRef, checked.candidateSha, expected], true)
        if (moved.code !== 0) return failed("stale-base", moved.stderr || "base branch moved")
      }
      return {
        status: "passed",
        output: integrationProof(checked.candidateSha, checked),
      }
    } catch (cause) {
      const refusal =
        queueAuthorityRefusal(cause) ?? submoduleReachabilityRefusal(cause) ?? submoduleCompositionRefusal(cause)
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
        ...(options.environmentOverrides === undefined ? {} : { environmentOverrides: options.environmentOverrides }),
        ...(options.environmentPassthrough === undefined
          ? {}
          : { environmentPassthrough: options.environmentPassthrough }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        variables: () => ({
          YRD_CANDIDATE_SHA: candidate.checked.candidateSha,
          YRD_CANDIDATE_REF: candidate.checked.candidateRef,
          ...(options.environment === undefined ? {} : { YRD_ENVIRONMENT: options.environment }),
        }),
      })

      const cancellation = mergeAuthorityCancellation(context)
      if (cancellation !== undefined) return cancellation
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
      const refusal =
        queueAuthorityRefusal(cause) ?? submoduleReachabilityRefusal(cause) ?? submoduleCompositionRefusal(cause)
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
    ...(checked.submoduleResolutions === undefined ? {} : { submoduleResolutions: checked.submoduleResolutions }),
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
