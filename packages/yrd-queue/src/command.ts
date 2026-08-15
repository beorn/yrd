import { createHash } from "node:crypto"
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve, sep } from "node:path"
import { authoredDeltaBase } from "@yrd/bay"
import { createFailure, failureFact, type JsonValue, type YrdFailure } from "@yrd/core"
import { JobErrorSchema, parseJobLaunch, type Job, type JobContext, type JobError, type JobResult } from "@yrd/job"
import { ComponentPathSchema } from "@yrd/intent"
import { adaptProcessGit, gitSuperFailureDetail, type Process, type ProcessResult } from "@yrd/process"
import { readCommitSubmodules } from "git-super/commit-graph"
import { ensureCommitObject } from "git-super/objects"
import { pushRefUpdates } from "git-super/push"
import { resolveSubmoduleOrigin } from "git-super/submodule-origin"
import * as z from "zod"
import type {
  AlreadyLandedEvidence,
  Candidate,
  ComponentMainOutcomes,
  ComponentMainReceipt,
  ComponentMainRefusal,
  CandidateChange,
  IntegratedShape,
  IntegrationProof,
  PRShape,
  PRSnapshot,
  QueueSubmoduleResolutionEvidence,
  Run,
  SourceRewrite,
} from "./model.ts"
import {
  ComponentMainOutcomesSchema,
  CandidateChangeSchema,
  IntegrationProofSchema,
  QueueSubmoduleResolutionEvidenceSchema,
  SourceRewriteSchema,
} from "./model.ts"
import { candidateRefFor } from "./candidate-refs.ts"
import { componentMainScratchCleanupFailure } from "./component-main-outcome.ts"
import {
  describeScratchReap,
  isStorageExhaustion,
  queueScratchParent,
  reapOrphanedScratch,
  storageExhaustionError,
  tagStorageExhaustion,
  taggedStorageExhaustion,
} from "./scratch-storage.ts"
import type { CandidatePool } from "./candidate-pool.ts"
import type {
  CandidatePreparationInput,
  CandidatePreparer,
  PreparedCandidate,
  StepExecution,
  StepRunner,
} from "./queue.ts"
import {
  executeQueueSubmoduleComposition,
  planQueueSubmoduleComposition,
  type QueueConflictStage,
  type QueueTreeConflict,
} from "./submodule-composition-policy.ts"
import { materializeSubmodules } from "git-super/submodules"
import { createGitWorktreeStore } from "git-super/worktree"
import {
  CommandDiagnosticSchema as SharedCommandDiagnosticSchema,
  type CommandDiagnostic as SharedCommandDiagnostic,
} from "./check-attribution.ts"
import { deterministicParentDate } from "./deterministic-parent-date.ts"
import {
  MERGE_RECORD_NOTES_NAME,
  MERGE_RECORD_REF,
  createMergeRecord,
  parseMergeRecord,
  type MergeRecordBody,
  type MergeRecordPointer,
} from "./merge-record.ts"

const sourceRowKey = ["li", "ne"].join("") as `${"li"}${"ne"}`

export const StepArtifactSchema = z.object({ name: z.string().min(1), path: z.string().min(1) }).strict()
export type StepArtifact = Readonly<z.infer<typeof StepArtifactSchema>>

export const CommandDiagnosticSchema = SharedCommandDiagnosticSchema
export type CommandDiagnostic = SharedCommandDiagnostic

export const GateModeSchema = z.enum(["delta", "strict"])
export type GateMode = z.infer<typeof GateModeSchema>

export const GateReportSchema = z
  .object({
    version: z.literal(1),
    comparator: z
      .object({
        id: z.string().regex(/^[a-z][a-z0-9-]*$/u),
        version: z.literal(1),
      })
      .strict(),
    residual: z
      .object({
        count: z.number().int().nonnegative(),
        hash: z.string().regex(/^[0-9a-f]{64}$/u),
      })
      .strict(),
  })
  .strict()
export type GateReport = Readonly<z.infer<typeof GateReportSchema>>

export const GateCertificateSchema = z
  .object({
    version: z.literal(1),
    mode: GateModeSchema,
    baseSha: z.string().regex(/^[0-9a-f]{40,64}$/iu),
    candidateSha: z.string().regex(/^[0-9a-f]{40,64}$/iu),
    reports: z.array(GateReportSchema).min(1),
  })
  .strict()
export type GateCertificate = Readonly<z.infer<typeof GateCertificateSchema>>

export const GATE_REPORT_TRAILER = "YRD-GATE-REPORT "
export const DIAGNOSTICS_COMPARISON_READY = "diagnostics-comparison-ready"

/** Create the content-addressed, multiplicity-preserving residual report a
 * structured child emits for the host's admission certificate. */
export function createGateReport(comparatorId: string, identities: readonly string[]): GateReport {
  const ordered = [...identities].sort()
  return GateReportSchema.parse({
    version: 1,
    comparator: { id: comparatorId, version: 1 },
    residual: {
      count: ordered.length,
      hash: createHash("sha256").update(JSON.stringify(ordered)).digest("hex"),
    },
  })
}

/** Emit exactly one machine-readable trailer while keeping a tool's ordinary
 * human diagnostics unconstrained. */
export function emitGateReport(report: GateReport): void {
  console.log(`${GATE_REPORT_TRAILER}${JSON.stringify(GateReportSchema.parse(report))}`)
}

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
    mode: GateModeSchema.optional(),
    gateReports: z.array(GateReportSchema).min(1).optional(),
    detail: z.string().optional(),
    diagnostics: z.array(CommandDiagnosticSchema).optional(),
    diagnosticsTruncated: z.literal(true).optional(),
    /** True when the command was settled by its wall-clock bound (21012 S1). */
    timedOut: z.boolean().optional(),
    stageVerdict: z.enum(["EXITED", "TIMED_OUT", "STALLED"]).optional(),
    lastProgressAtMs: z.number().nonnegative().optional(),
    lastProgressBytes: z.number().int().nonnegative().optional(),
    sweepFailure: z.string().min(1).optional(),
    /** The direct child exited but a descendant held its output pipe open past
     * the post-exit drain grace (a process-group escapee); run() abandoned the
     * drain rather than wedge. Distinct from a plain output-progress stall. */
    escapedDescendant: z.boolean().optional(),
  })
  .strict()
export type CommandEvidence = Readonly<z.infer<typeof CommandEvidenceSchema>>

export const GitCheckComparisonEvidenceSchema = z
  .object({
    parent: CommandEvidenceSchema,
    netNewDiagnostics: z.array(CommandDiagnosticSchema),
    resolvedDiagnostics: z.array(CommandDiagnosticSchema),
  })
  .strict()
export type GitCheckComparisonEvidence = Readonly<z.infer<typeof GitCheckComparisonEvidenceSchema>>

export const GitCheckEvidenceSchema = CommandEvidenceSchema.extend({
  baseSha: z.string().regex(/^[0-9a-f]{40,64}$/iu),
  candidateSha: z.string().regex(/^[0-9a-f]{40,64}$/iu),
  /** Tree identity makes candidate-class evidence reusable when only the
   * synthesized commit's parent changed. Optional only for legacy journals. */
  candidateTreeSha: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/iu)
    .optional(),
  candidateRef: z.string().min(1),
  changes: z.array(CandidateChangeSchema).min(1).optional(),
  sourceRewrites: z.array(SourceRewriteSchema).optional(),
  submoduleResolutions: z.array(QueueSubmoduleResolutionEvidenceSchema).min(1).optional(),
  comparison: GitCheckComparisonEvidenceSchema.optional(),
  certificate: GateCertificateSchema.optional(),
  /** Current check attempt; absent only in replay-era Job output. */
  attempt: z.number().int().positive().optional(),
}).strict()
export type GitCheckEvidence = Readonly<z.infer<typeof GitCheckEvidenceSchema>>

const PinnedCandidateSchema = GitCheckEvidenceSchema.pick({
  baseSha: true,
  candidateSha: true,
  candidateTreeSha: true,
  candidateRef: true,
  changes: true,
  sourceRewrites: true,
  submoduleResolutions: true,
}).strict()
type PinnedCandidate = Readonly<z.infer<typeof PinnedCandidateSchema>>

export const GitCheckExecutionRefusalEvidenceSchema = PinnedCandidateSchema.extend({
  kind: z.literal("check-execution-refusal"),
  phase: z.enum(["parent", "candidate"]),
  error: JobErrorSchema,
  candidateEvidence: CommandEvidenceSchema.optional(),
  retryable: z.literal(true),
}).strict()
export type GitCheckExecutionRefusalEvidence = Readonly<z.infer<typeof GitCheckExecutionRefusalEvidenceSchema>>

export const GitCheckComparisonRefusalEvidenceSchema = PinnedCandidateSchema.extend({
  kind: z.literal("check-comparison-refusal"),
  phase: z.enum(["parent", "candidate"]),
  error: JobErrorSchema,
  parent: CommandEvidenceSchema.optional(),
  candidateEvidence: CommandEvidenceSchema.optional(),
  retryable: z.literal(true),
}).strict()
export type GitCheckComparisonRefusalEvidence = Readonly<z.infer<typeof GitCheckComparisonRefusalEvidenceSchema>>

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
  GitCheckExecutionRefusalEvidenceSchema,
  GitCheckComparisonRefusalEvidenceSchema,
])
export type GitCheckResultEvidence = Readonly<z.infer<typeof GitCheckResultEvidenceSchema>>

type ProcessDependency = Readonly<{ inject: Readonly<{ process: Pick<Process, "run"> }> }>
type ProgressResult = Readonly<{
  verdict?: "EXITED" | "TIMED_OUT" | "STALLED"
  stalled?: boolean
  /** The direct child exited but a descendant held its output pipe open past
   * the drain grace — surfaced distinctly from a plain output stall. */
  escapedDescendant?: boolean
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
    mode?: GateMode
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
  const mode = options.mode ?? "delta"
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
    .update("\0")
    .update(mode)
    .digest("hex")
  return async (input, context): Promise<JobResult<CommandEvidence>> => {
    const { process } = options.inject
    const primary = primaryPR(input)
    const cwd = resolve(typeof options.cwd === "function" ? await options.cwd(input) : options.cwd)
    const variables = {
      YRD_BASE: primary.base,
      YRD_BASE_SHA: primary.baseSha,
      YRD_GATE_MODE: mode,
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
    const gateReports = commandGateReports(message)
    const progress = result as typeof result & ProgressResult
    const evidence = CommandEvidenceSchema.parse({
      command: argv,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      configHash,
      environmentHash: environmentHash(env),
      artifacts,
      classification: options.classification ?? "carrier",
      mode,
      ...(gateReports.values.length === 0 ? {} : { gateReports: gateReports.values }),
      ...(detail === "" ? {} : { detail }),
      ...(diagnostics.values.length === 0 ? {} : { diagnostics: diagnostics.values }),
      ...(diagnostics.truncated ? { diagnosticsTruncated: true as const } : {}),
      ...(result.timedOut ? { timedOut: true } : {}),
      ...(progress.verdict === undefined ? {} : { stageVerdict: progress.verdict }),
      ...(progress.lastProgressAtMs === undefined ? {} : { lastProgressAtMs: progress.lastProgressAtMs }),
      ...(progress.lastProgressBytes === undefined ? {} : { lastProgressBytes: progress.lastProgressBytes }),
      ...(result.sweepFailure === undefined ? {} : { sweepFailure: result.sweepFailure }),
      ...(progress.escapedDescendant === true ? { escapedDescendant: true } : {}),
    })
    // A descendant that outlived the command and held its output pipe open is a
    // distinct, more-actionable failure than a plain output stall (a process
    // leaked, and it wedged the queue until run() abandoned the drain). Surface
    // it FIRST, and independently of noProgressTimeoutMs — the post-exit drain
    // grace fires even when no output-progress lease is configured.
    if (progress.escapedDescendant === true) {
      return failed(
        `${options.purpose}-stalled-escaped-descendant`,
        `${options.purpose} exited but a descendant held its output pipe open past the drain grace; the drain was abandoned to un-wedge the queue — inspect and kill the leaked process tree`,
        evidence,
      )
    }
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
    // SIGKILL has no task-level meaning: the kernel, an operator, or a memory
    // supervisor ended the process before it could return a verdict. Keeping
    // this distinct prevents exit-code normalization from turning missing
    // evidence into a terminal check failure.
    if (result.signal === "SIGKILL" || (result.signal === null && result.exitCode === 137)) {
      return failed(
        `${options.purpose}-infrastructure-signal`,
        `${options.purpose} command ended by SIGKILL (exit ${result.exitCode}) before it produced a verdict`,
        evidence,
      )
    }
    if (gateReports.error !== undefined) {
      return failed(`${options.purpose}-gate-report-invalid`, gateReports.error, evidence)
    }
    if (result.exitCode !== 0) {
      const action = waiting ? "launcher" : "command"
      return failed(
        `${options.purpose}${waiting ? "-launcher" : ""}-failed`,
        `${options.purpose} ${action} exited ${result.exitCode}`,
        evidence,
      )
    }
    if (!waiting) return { status: "completed", conclusion: "success", output: evidence }
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

function commandGateReports(output: string): Readonly<{ values: readonly GateReport[]; error?: string }> {
  const reports: GateReport[] = []
  for (const row of output.split(/\r?\n/u)) {
    const text = row.trim()
    if (!text.startsWith(GATE_REPORT_TRAILER)) continue
    const payload = text.slice(GATE_REPORT_TRAILER.length)
    try {
      reports.push(GateReportSchema.parse(JSON.parse(payload)))
    } catch {
      return { values: reports, error: "configured command emitted a malformed YRD-GATE-REPORT trailer" }
    }
  }
  return { values: reports }
}

function commandDiagnostics(output: string): Readonly<{
  values: readonly CommandDiagnostic[]
  truncated: boolean
}> {
  const diagnostics: CommandDiagnostic[] = []
  for (const row of output.split(/\r?\n/u)) {
    const text = row.trim()
    const changed = /^[ MADRCU?!]{2}\s+(.+)$/u.exec(row)
    if (changed?.[1] !== undefined) {
      if (diagnostics.length >= 20) return { values: diagnostics, truncated: true }
      diagnostics.push({ file: changed[1], [sourceRowKey]: 1, message: "working tree changed during check" })
      continue
    }
    const match =
      /^(.*?)\((\d+),(\d+)\):\s*(.+)$/u.exec(text) ?? /^(.*?):(\d+)(?::(\d+))?\s*(?:-|:)\s*(.+)$/u.exec(text)
    if (match?.[1] === undefined || match[2] === undefined || match[4] === undefined) continue
    const rowNumber = Number(match[2])
    const column = match[3] === undefined ? undefined : Number(match[3])
    if (rowNumber < 1 || (column !== undefined && column < 1)) continue
    if (diagnostics.length >= 20) return { values: diagnostics, truncated: true }
    diagnostics.push({
      file: match[1],
      [sourceRowKey]: rowNumber,
      ...(column === undefined ? {} : { column }),
      message: match[4],
    })
  }
  return { values: diagnostics, truncated: false }
}

function comparisonDiagnostic(diagnostic: CommandDiagnostic, cwd: string): CommandDiagnostic {
  const prefix = `${resolve(cwd)}${sep}`
  const offset = diagnostic.file.indexOf(prefix)
  return {
    ...diagnostic,
    file:
      offset < 0
        ? diagnostic.file
        : `${diagnostic.file.slice(0, offset)}${diagnostic.file.slice(offset + prefix.length)}`,
  }
}

function diagnosticIdentity(diagnostic: CommandDiagnostic): string {
  return JSON.stringify([diagnostic.file, diagnostic[sourceRowKey], diagnostic.column ?? null, diagnostic.message])
}

function uniqueComparisonDiagnostics(evidence: CommandEvidence, cwd: string): readonly CommandDiagnostic[] {
  const seen = new Set<string>()
  const diagnostics: CommandDiagnostic[] = []
  for (const raw of evidence.diagnostics ?? []) {
    const diagnostic = comparisonDiagnostic(raw, cwd)
    const identity = diagnosticIdentity(diagnostic)
    if (seen.has(identity)) continue
    seen.add(identity)
    diagnostics.push(diagnostic)
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
  // Snapshot BOTH declarations: retaining the caller-owned overrides object by
  // reference would let a post-construction mutation bypass the validation
  // above (a TOCTOU) — the null-prototype frozen copy is what commandEnvironment
  // applies, so only construction-time-validated entries can ever ship.
  return Object.freeze({
    passthrough: new Set(passthrough),
    overrides: Object.freeze(Object.assign(Object.create(null) as Record<string, string>, overrides)),
  })
}

function compareCommandEvidence(
  parent: CommandEvidence,
  parentCwd: string,
  candidate: CommandEvidence,
  candidateCwd: string,
): GitCheckComparisonEvidence {
  const parentDiagnostics = uniqueComparisonDiagnostics(parent, parentCwd)
  const candidateDiagnostics = uniqueComparisonDiagnostics(candidate, candidateCwd)
  const parentIdentities = new Set(parentDiagnostics.map(diagnosticIdentity))
  const candidateIdentities = new Set(candidateDiagnostics.map(diagnosticIdentity))
  return GitCheckComparisonEvidenceSchema.parse({
    parent,
    netNewDiagnostics: candidateDiagnostics.filter(
      (diagnostic) => !parentIdentities.has(diagnosticIdentity(diagnostic)),
    ),
    resolvedDiagnostics: parentDiagnostics.filter(
      (diagnostic) => !candidateIdentities.has(diagnosticIdentity(diagnostic)),
    ),
  })
}

function comparableCommandEvidence(outcome: JobResult<CommandEvidence>, purpose: string): CommandEvidence | undefined {
  if (outcome.status === "completed" && outcome.conclusion === "success") return outcome.output
  if (
    outcome.status === "completed" &&
    outcome.conclusion === "failure" &&
    outcome.error.code === `${purpose}-failed` &&
    outcome.output?.diagnostics !== undefined &&
    outcome.output.diagnostics.length > 0 &&
    outcome.output.diagnosticsTruncated !== true
  ) {
    return outcome.output
  }
  return undefined
}

function comparisonOutcomeError(
  outcome: JobResult<CommandEvidence>,
  purpose: string,
  phase: "parent" | "candidate",
): JobError {
  if (outcome.status === "completed" && outcome.conclusion === "failure") return outcome.error
  return {
    code: `${purpose}-${phase}-evidence-unavailable`,
    message: `${purpose} ${phase} command returned ${outcome.status} instead of comparable evidence`,
  }
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

const COMMAND_OUTPUT_LOGS = ["output.log", "stdout.log", "stderr.log"] as const

async function hasCommandOutput(dir: string): Promise<boolean> {
  for (const name of COMMAND_OUTPUT_LOGS) {
    const contents = await readFile(join(dir, name), "utf8").catch(() => "")
    if (contents !== "") return true
  }
  return false
}

/** Human-readable rendering of a typed step failure, for operators reading the
 * attempt directory rather than the journal. */
function renderStepFailure(error: JobError): string {
  const lines = [`yrd: step failed with '${error.code}'`, "", error.message]
  const cause = jsonRecord(jsonRecord(error.evidence)?.error)
  if (typeof cause?.code === "string") {
    lines.push("", `cause: ${cause.code}`)
    // A refusal usually quotes its cause verbatim; do not print the transcript twice.
    const detail = typeof cause.message === "string" ? cause.message : ""
    if (detail !== "" && !error.message.includes(detail)) lines.push(detail)
  }
  lines.push("", "The full typed error, including its evidence, is in error.json.")
  return `${lines.join("\n").trimEnd()}\n`
}

function jsonRecord(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Readonly<Record<string, JsonValue>>
}

/**
 * The attempt directory is the disclosure surface for a failed step. A step
 * that refuses before its command ever runs — a candidate workspace that could
 * not be provisioned, a checkout that could not be prepared — writes no stream
 * artifacts, so without this its directory is created and left empty and the
 * typed error survives only in the journal, which no CLI surfaces.
 */
async function discloseStepFailure<Output extends JsonValue>(
  root: string,
  input: StepExecution,
  attempt: number,
  result: JobResult<Output>,
): Promise<JobResult<Output>> {
  if (result.status !== "completed" || result.conclusion !== "failure") return result
  const dir = join(root, input.run, `${input.index}-${input.step}`, `attempt-${attempt}`)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "error.json"), `${JSON.stringify(result.error, undefined, 2)}\n`)
    // Never clobber the command's own streams: they are the richer evidence,
    // and error.json already carries the typed verdict alongside them.
    if (!(await hasCommandOutput(dir))) {
      await writeFile(join(dir, "output.log"), renderStepFailure(result.error))
    }
    return result
  } catch (cause) {
    // Losing the disclosure must not silently degrade to no disclosure at all.
    // The verdict survives unchanged — its code drives retry and parking — and
    // the message names the directory that refused the write.
    return {
      ...result,
      error: {
        ...result.error,
        message: `${result.error.message}\nyrd: could not disclose this failure in ${dir}: ${messageOf(cause)}`,
      },
    }
  }
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
    ...(diagnostics.values.length === 0 ? {} : { diagnostics: diagnostics.values }),
    ...(diagnostics.truncated ? { diagnosticsTruncated: true as const } : {}),
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
const CERTIFICATE_DIFF_OPTIONS = ["--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--no-renames"] as const
// Queue git operations (recut rebases, worktree admin, merges) lock the shared
// repository and scale with checkout size; 30s calibrated for an idle host was
// killing subprocesses mid-mutation under real fleet load (2026-07-23 incident).
const GIT_TIMEOUT_MS = 120_000
/** R1680: worktree-remove cleanup is correctness-critical, not latency-critical;
 * under host load it can exceed the interactive window and must not fail work.
 * Now equal to GIT_TIMEOUT_MS, but kept as a named constant so the cleanup call
 * sites (worktree remove) stay self-documenting and independently tunable. */
const GIT_CLEANUP_TIMEOUT_MS = 120_000
/** Shell convention for "the command could not be executed" (126), reused so a tolerant caller
 * reading only `code !== 0` treats an unstartable git exactly as it treats a git that ran and
 * failed. 124 is already spoken for by the timeout path. */
const GIT_UNSTARTABLE_CODE = 126

function createGit(
  process: Pick<Process, "run">,
  environment: NodeJS.ProcessEnv = globalThis.process.env,
  options: Readonly<{ noLazyFetch?: boolean }> = {},
) {
  const env = Object.fromEntries(
    Object.entries(environment).filter(([key, value]) => value !== undefined && !key.startsWith("GIT_")),
  ) as Record<string, string>
  env.GIT_NO_REPLACE_OBJECTS = "1"
  if (options.noLazyFetch === true) env.GIT_NO_LAZY_FETCH = "1"
  env.KM_NO_AUTO_SUBMODULE_UPDATE = "1"
  const execute = async (
    repo: string,
    args: readonly string[],
    allowFailure: boolean,
    trim: boolean,
    stdoutChunks?: Uint8Array[],
    preserveProcessFailure = false,
    timeoutMs = GIT_TIMEOUT_MS,
  ): Promise<GitResult> => {
    const startedAtMs = Date.now()
    let result
    try {
      result = await process.run({
        argv: ["git", "-C", repo, ...args],
        cwd: repo,
        env,
        timeoutMs,
        ...(stdoutChunks === undefined
          ? {}
          : {
              onOutput: (output: Readonly<{ stream: "stdout" | "stderr"; chunk: Uint8Array }>) => {
                if (output.stream === "stdout") stdoutChunks.push(output.chunk.slice())
              },
            }),
      })
    } catch (cause) {
      // Failing to START git is not the same event as git failing, and until now only the second
      // one was survivable: every call passes `cwd: repo` as well as `git -C repo`, so a directory
      // that does not exist makes posix_spawn throw ENOENT before git runs. `allowFailure` promises
      // its callers a RESULT to classify — a tolerant probe of an unmaterialized component checkout
      // was instead killing the whole process (the recovery scan that meets exactly that estate).
      // Same treatment as the timeout below: a failed result for tolerant callers, a named throw
      // for the rest.
      const detail = cause instanceof Error ? cause.message : String(cause)
      const message = `yrd: git ${args.join(" ")} could not be started in '${repo}': ${detail}`
      if (!allowFailure) throw new Error(message, { cause })
      return {
        code: GIT_UNSTARTABLE_CODE,
        stdout: "",
        stderr: message,
        durationMs: Math.max(0, Date.now() - startedAtMs),
        signal: null,
        timedOut: false,
      }
    }
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
    if (completed.timedOut && !preserveProcessFailure) {
      // allowFailure callers are best-effort cleanup (`rebase --abort`,
      // `worktree remove`): a timeout must surface as a failed RESULT their
      // nonzero-code handling absorbs. Throwing here escaped past the recut
      // refusal paths and killed the resident runner (2026-07-23 incident).
      const message = `yrd: git ${args.join(" ")} timed out after ${timeoutMs}ms`
      if (!allowFailure) throw new Error(message)
      return { ...completed, code: completed.code === 0 ? 124 : completed.code, stderr: message }
    }
    if (!allowFailure && completed.code !== 0) {
      throw new Error(completed.stderr || completed.stdout || `git ${args.join(" ")} failed`)
    }
    return completed
  }
  const run = (repo: string, args: readonly string[], allowFailure = false, timeoutMs?: number): Promise<GitResult> =>
    execute(repo, args, allowFailure, true, undefined, false, timeoutMs)
  const raw = (repo: string, args: readonly string[], allowFailure = false): Promise<GitResult> =>
    execute(repo, args, allowFailure, false)
  const probe = (repo: string, args: readonly string[]): Promise<GitResult> =>
    execute(repo, args, true, true, undefined, true)
  const rawProbe = (repo: string, args: readonly string[]): Promise<GitResult> =>
    execute(repo, args, true, false, undefined, true)
  const input = async (
    repo: string,
    args: readonly string[],
    stdin: string | Uint8Array,
    allowFailure = false,
  ): Promise<GitResult> => {
    const result = await process.run({
      argv: ["git", "-C", repo, ...args],
      cwd: repo,
      env,
      stdin,
      timeoutMs: GIT_TIMEOUT_MS,
    })
    const completed: GitResult = {
      code: result.exitCode,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      durationMs: result.durationMs,
      signal: result.signal,
      timedOut: result.timedOut,
      ...(result.timedOut ? { verdict: "TIMED_OUT" as const } : {}),
    }
    if (completed.timedOut) throw new Error(`yrd: git ${args.join(" ")} timed out after ${GIT_TIMEOUT_MS}ms`)
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
  const commitTree = async (
    repo: string,
    tree: string,
    parents: readonly string[],
    message: string,
  ): Promise<string> => {
    const date = await deterministicParentDate(
      parents,
      async (parent) => (await run(repo, ["show", "-s", "--format=%ct", parent])).stdout,
    )
    const result = await process.run({
      argv: ["git", "-C", repo, "commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent])],
      cwd: repo,
      env: {
        ...env,
        GIT_AUTHOR_NAME: "Yrd Queue",
        GIT_AUTHOR_EMAIL: "yrd-queue@example.invalid",
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: "Yrd Queue",
        GIT_COMMITTER_EMAIL: "yrd-queue@example.invalid",
        GIT_COMMITTER_DATE: date,
      },
      stdin: `${message}\n`,
      timeoutMs: GIT_TIMEOUT_MS,
    })
    if (result.timedOut) throw new Error(`yrd: git commit-tree timed out after ${GIT_TIMEOUT_MS}ms`)
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || "yrd: git commit-tree failed")
    }
    return result.stdout.trim()
  }
  const stablePatchId = async (
    repo: string,
    from: string,
    to: string,
    paths?: readonly string[],
  ): Promise<string | undefined> => {
    const parent = await queueScratchParent({ run }, repo)
    await mkdir(parent, { recursive: true })
    const scratch = await mkdtemp(join(await realpath(parent), "yrd-patch-id-"))
    const diffPath = join(scratch, "payload.diff")
    try {
      const diff = await execute(
        repo,
        [
          "diff",
          ...CERTIFICATE_DIFF_OPTIONS,
          "--full-index",
          "--binary",
          `--output=${diffPath}`,
          from,
          to,
          "--",
          ...(paths ?? []),
        ],
        true,
        true,
      )
      if (diff.code !== 0) return undefined
      const result = await process.run({
        argv: ["git", "-C", repo, "patch-id", "--stable"],
        cwd: repo,
        env,
        stdin: await readFile(diffPath),
        timeoutMs: GIT_TIMEOUT_MS,
      })
      if (result.timedOut) throw new Error(`yrd: git patch-id --stable timed out after ${GIT_TIMEOUT_MS}ms`)
      if (result.exitCode !== 0) return undefined
      return /^([0-9a-f]{40,64})\s+[0-9a-f]{40,64}$/iu.exec(result.stdout.trim())?.[1]
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }
  const rangeDiff = (repo: string, oldBase: string, oldTip: string, newBase: string, newTip: string) =>
    run(
      repo,
      [
        "range-diff",
        ...CERTIFICATE_DIFF_OPTIONS,
        "--no-color",
        "--no-dual-color",
        "--no-patch",
        `${oldBase}..${oldTip}`,
        `${newBase}..${newTip}`,
      ],
      true,
    )
  return Object.freeze({
    run,
    raw,
    probe,
    rawProbe,
    input,
    commit,
    optionalCommit,
    commitTree,
    stablePatchId,
    rangeDiff,
    process,
    env,
  })
}

function mergeRecordJob(job: Job, step: string): MergeRecordBody["evidence"]["jobs"][number] | undefined {
  if (job.status !== "completed") return undefined
  const command = GitCheckResultEvidenceSchema.safeParse("output" in job ? job.output : undefined)
  const evidence = command.success && "configHash" in command.data ? command.data : undefined
  return {
    id: job.id,
    step,
    attempt: job.attempt,
    ...(!("startedAt" in job) || job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
    finishedAt: job.finishedAt,
    result: job.conclusion,
    ...(evidence?.configHash === undefined ? {} : { configHash: evidence.configHash }),
    ...(evidence?.environmentHash === undefined ? {} : { environmentHash: evidence.environmentHash }),
  }
}

function mergeRecordBody(run: Run, candidate: Candidate, pins: MergeRecordBody["pins"]): MergeRecordBody | undefined {
  if (run.status !== "completed" || run.finishedAt === undefined) return undefined
  if (!run.steps.some((step) => step.kind === "merge")) return undefined
  const result = run.conclusion === "success" ? "merged" : run.conclusion === "cancelled" ? "canceled" : "failed"
  const reason =
    result === "merged"
      ? undefined
      : (run.error ??
        (result === "canceled"
          ? { code: "run-canceled", message: run.cancelReason ?? "Merge canceled" }
          : { code: "merge-failed", message: "Merge failed without a more specific reason" }))
  return {
    merge: {
      id: run.id,
      base: run.base,
      baseSha: candidate.baseSha,
      candidate: run.candidateId,
      result,
      ...(run.integration?.commit === undefined ? {} : { mergedCommit: run.integration.commit }),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    },
    changes: run.prs.map((change) => {
      const generated = candidate.changes?.find(
        (candidateChange) => candidateChange.pr === change.id && candidateChange.revision === change.revision,
      )
      return {
        ...(change.changeId === undefined ? {} : { changeId: change.changeId }),
        pr: change.id,
        revision: change.revision,
        submittedHead: change.headSha,
        ...(generated === undefined ? {} : { generatedCommit: generated.generatedCommit }),
      }
    }),
    ...(reason === undefined ? {} : { reason }),
    evidence: {
      jobs: run.steps.flatMap((step) => {
        const job = step.job === undefined ? undefined : mergeRecordJob(step.job, step.name)
        return job === undefined ? [] : [job]
      }),
    },
    pins,
    ...(result === "merged"
      ? {}
      : {
          fix:
            result === "canceled"
              ? "Submit the revision again when this merge should resume."
              : `Resolve ${reason?.code ?? "merge-failed"} and submit a new revision.`,
        }),
  }
}

export type MergeRecorder = (input: Readonly<{ run: Run; candidate: Candidate }>) => Promise<void>

type MergeRecordRemote = Readonly<{ remote: "origin"; tip?: string }>

async function synchronizeMergeRecordRef(git: Git, repo: string, run: string): Promise<MergeRecordRemote | undefined> {
  const configured = await git.run(repo, ["config", "--get", "remote.origin.url"], true)
  if (configured.code !== 0 || configured.stdout === "") return undefined
  const advertised = await git.run(repo, ["ls-remote", "--refs", "origin", MERGE_RECORD_REF], true)
  if (advertised.code !== 0) {
    throw new Error(
      `yrd: merge '${run}' could not read remote record ref '${MERGE_RECORD_REF}': ${advertised.stderr || advertised.stdout}`,
    )
  }
  if (advertised.stdout === "") return { remote: "origin" }
  const [remoteTip, advertisedRef, extra] = advertised.stdout.split(/\s+/u)
  if (remoteTip === undefined || advertisedRef !== MERGE_RECORD_REF || extra !== undefined) {
    throw new Error(`yrd: remote merge-record ref advertisement is malformed: ${advertised.stdout}`)
  }
  const stagingRef = `refs/notes/yrd/merge-record-upstream/${remoteTip}`
  const fetched = await git.run(
    repo,
    ["fetch", "--no-recurse-submodules", "--quiet", "origin", `+${MERGE_RECORD_REF}:${stagingRef}`],
    true,
  )
  if (fetched.code !== 0) {
    throw new Error(`yrd: remote merge-record ref '${remoteTip}' could not be fetched: ${fetchDetail(fetched)}`)
  }
  const materializedTip = await git.optionalCommit(repo, stagingRef)
  if (materializedTip !== remoteTip) {
    throw new Error(
      `yrd: remote merge-record ref '${remoteTip}' fetched into '${stagingRef}' but resolved to '${materializedTip ?? "missing"}'`,
    )
  }
  const localTip = await git.optionalCommit(repo, MERGE_RECORD_REF)
  if (localTip === undefined) {
    const aligned = await git.run(repo, ["update-ref", MERGE_RECORD_REF, remoteTip, "0".repeat(remoteTip.length)], true)
    if (aligned.code !== 0) throw new Error(`yrd: local merge-record ref changed while aligning to '${remoteTip}'`)
  } else if (localTip !== remoteTip) {
    const remoteContainsLocal = await git.run(repo, ["merge-base", "--is-ancestor", localTip, remoteTip], true)
    if (remoteContainsLocal.code === 0) {
      const aligned = await git.run(repo, ["update-ref", MERGE_RECORD_REF, remoteTip, localTip], true)
      if (aligned.code !== 0) throw new Error("yrd: local merge-record ref changed while fast-forwarding")
    } else if ((await git.run(repo, ["merge-base", "--is-ancestor", remoteTip, localTip], true)).code !== 0) {
      throw new Error(`yrd: local merge-record ref '${localTip}' diverges from remote '${remoteTip}'`)
    }
  }
  await git.run(repo, ["update-ref", "-d", stagingRef, remoteTip], true)
  return { remote: "origin", tip: remoteTip }
}

async function publishMergeRecordRef(
  git: Git,
  repo: string,
  run: string,
  remote: MergeRecordRemote | undefined,
): Promise<void> {
  if (remote === undefined) return
  const localTip = await git.commit(repo, MERGE_RECORD_REF)
  const pushed = await pushRefUpdates({
    root: repo,
    git: adaptProcessGit(git.process, { env: git.env, timeoutMs: GIT_TIMEOUT_MS }),
    timeoutMs: GIT_TIMEOUT_MS,
    verify: false,
    updates: [
      {
        repository: repo,
        remote: remote.remote,
        source: localTip,
        destination: MERGE_RECORD_REF,
        expectedDestination: remote.tip === undefined ? { state: "missing" } : { state: "oid", oid: remote.tip },
      },
    ],
  })
  if (pushed.state !== "updated" && pushed.state !== "unchanged") {
    throw new Error(
      `yrd: merge '${run}' could not publish merge-record ref: ${
        gitSuperFailureDetail(pushed)?.message ?? pushed.state
      }`,
    )
  }
}

/** Persist the immutable terminal account for one merge attempt.
 *
 * The note target is a content-addressed attempt anchor, not a merged commit:
 * failed and canceled merges deliberately have no merged commit to attach to.
 */
export function gitMergeRecorder(options: {
  inject: Readonly<{ process: Pick<Process, "run"> }>
  repo: string
}): MergeRecorder {
  const git = createGit(options.inject.process)
  return async ({ run, candidate }) => {
    const checkedCandidate = run.steps
      .map((step) => (step.job?.status === "completed" && "output" in step.job ? step.job.output : undefined))
      .map((output) => GitCheckEvidenceSchema.safeParse(output))
      .find((result) => result.success)?.data.candidateSha
    const candidateSha = candidate.sha ?? run.integration?.commit ?? checkedCandidate
    const payloadGitlinks =
      candidateSha === undefined ? [] : (await rawPayload(git, options.repo, candidate.baseSha, candidateSha)).gitlinks
    const resolutionPins = new Map((candidate.submoduleResolutions ?? []).map((pin) => [pin.path, pin.sha]))
    const paths = [...new Set([...payloadGitlinks, ...resolutionPins.keys()])].toSorted()
    const pins = await Promise.all(
      paths.map(async (path) => {
        const after =
          (candidateSha === undefined ? undefined : await readGitlink(git, options.repo, candidateSha, path)) ??
          resolutionPins.get(path)
        if (after === undefined) throw new Error(`yrd: merge '${run.id}' cannot read Candidate gitlink '${path}'`)
        return {
          path,
          before: (await readGitlink(git, options.repo, candidate.baseSha, path)) ?? null,
          after,
        }
      }),
    )
    const body = mergeRecordBody(run, candidate, pins)
    if (body === undefined) return
    const remote = await synchronizeMergeRecordRef(git, options.repo, run.id)
    const record = createMergeRecord(body)
    const target = (await git.input(options.repo, ["hash-object", "-w", "--stdin"], `yrd merge ${run.id}\n`)).stdout
    const existing = await git.run(options.repo, ["notes", `--ref=${MERGE_RECORD_NOTES_NAME}`, "show", target], true)
    if (existing.code === 0) {
      const parsed = parseMergeRecord(existing.stdout)
      if (createMergeRecord(parsed.record).canonical !== record.canonical) {
        throw new Error(`yrd: merge '${run.id}' already has a different immutable merge record`)
      }
      await publishMergeRecordRef(git, options.repo, run.id, remote)
      return
    }
    const blob = (await git.input(options.repo, ["hash-object", "-w", "--stdin"], record.canonical)).stdout
    const added = await git.run(
      options.repo,
      ["notes", `--ref=${MERGE_RECORD_NOTES_NAME}`, "add", "-C", blob, target],
      true,
    )
    if (added.code !== 0) {
      const raced = await git.run(options.repo, ["notes", `--ref=${MERGE_RECORD_NOTES_NAME}`, "show", target], true)
      if (raced.code === 0 && createMergeRecord(parseMergeRecord(raced.stdout).record).canonical === record.canonical) {
        return
      }
      throw new Error(`yrd: merge record for '${run.id}' could not be published: ${added.stderr || added.stdout}`)
    }
    await publishMergeRecordRef(git, options.repo, run.id, remote)
  }
}

export type RepositoryMergeRecord = Readonly<{ record: MergeRecordBody; pointer: MergeRecordPointer }>
/** One listed note the scan could not turn into verified truth, kept per record so a damaged
 * estate reports what it lost instead of losing the whole scan. */
export type UnverifiableMergeRecord = Readonly<{
  note: string
  status: "repository-incomplete" | "repository-corrupt"
  reason: string
}>
export type RepositoryMergeRecordSearchResult =
  | Readonly<{
      status: "proven"
      records: readonly RepositoryMergeRecord[]
      /** Always empty unless the caller asked for per-record isolation. */
      unverifiable: readonly UnverifiableMergeRecord[]
    }>
  | Readonly<{ status: "not-proven"; reason: "merge-record-missing" }>
  | Readonly<{ status: "repository-incomplete"; reason: string }>
  | Readonly<{ status: "repository-corrupt"; reason: string }>

type VerifiedListing =
  | Readonly<{ outcome: "verified"; record: RepositoryMergeRecord }>
  | Readonly<{ outcome: "filtered" }>
  | (UnverifiableMergeRecord & Readonly<{ outcome: "unverifiable" }>)

/** Query immutable merge attempts without requiring a live Journal projection.
 *
 * An absent `selector` returns every verified record on the base — the whole scan already runs
 * for any selector, so the bulk read is the same verification (attempt anchor, merge ancestry,
 * Change-Id trailer, pin containment) with nothing filtered out.
 *
 * `isolateUnverifiable` trades the all-or-nothing verdict for per-record reporting, and only the
 * bulk recovery scan wants that trade: answering ONE question (`yrd why <selector>`) from a
 * partially verified estate would be answering it from unproven truth, while a scan rebuilding a
 * lost index over a damaged estate must not let one bad note hide every good one behind it.
 */
export async function findRepositoryMergeRecords(
  options: Readonly<{
    inject: Readonly<{ process: Pick<Process, "run"> }>
    repo: string
    baseSha: string
    selector?: string
    isolateUnverifiable?: boolean
  }>,
): Promise<RepositoryMergeRecordSearchResult> {
  const git = createGit(options.inject.process)
  const listed = await git.run(options.repo, ["notes", `--ref=${MERGE_RECORD_NOTES_NAME}`, "list"], true)
  if (listed.code !== 0) {
    return { status: "repository-corrupt", reason: listed.stderr || listed.stdout || "merge-record ref unreadable" }
  }

  const verifyListing = async (line: string): Promise<VerifiedListing> => {
    const [note, target, extra] = line.split(/\s+/u)
    const corrupt = (reason: string): VerifiedListing =>
      ({ outcome: "unverifiable", note: note ?? line, status: "repository-corrupt", reason }) as const
    if (note === undefined || target === undefined || extra !== undefined) {
      return {
        outcome: "unverifiable",
        note: line,
        status: "repository-corrupt",
        reason: `malformed merge-record listing: ${line}`,
      }
    }
    const shown = await git.run(options.repo, ["notes", `--ref=${MERGE_RECORD_NOTES_NAME}`, "show", target], true)
    if (shown.code !== 0) return corrupt(`merge-record '${note}' is unreadable`)
    let parsed
    try {
      parsed = parseMergeRecord(shown.stdout)
    } catch (cause) {
      return corrupt(`merge-record '${note}' is invalid: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    const expectedTarget = (
      await git.input(options.repo, ["hash-object", "--stdin"], `yrd merge ${parsed.record.merge.id}\n`)
    ).stdout
    if (target !== expectedTarget) {
      return corrupt(`merge-record '${note}' has the wrong attempt anchor '${target}'`)
    }
    if (parsed.record.merge.result === "merged") {
      const merged = parsed.record.merge.mergedCommit
      if (
        merged === undefined ||
        (await git.run(options.repo, ["merge-base", "--is-ancestor", merged, options.baseSha], true)).code !== 0
      ) {
        return corrupt(`merge-record '${note}' does not prove a merge on base`)
      }
      for (const change of parsed.record.changes) {
        if (change.generatedCommit === undefined || change.changeId === undefined) continue
        const reachable = await git.run(
          options.repo,
          ["merge-base", "--is-ancestor", change.generatedCommit, merged],
          true,
        )
        const trailers = await git.run(
          options.repo,
          ["show", "-s", "--format=%(trailers:key=Change-Id,valueonly)", change.generatedCommit],
          true,
        )
        if (reachable.code !== 0 || trailers.code !== 0 || trailers.stdout !== change.changeId) {
          return corrupt(`merge-record '${note}' cannot prove ${change.changeId}`)
        }
      }
      for (const pin of parsed.record.pins) {
        const current = await readGitlink(git, options.repo, options.baseSha, pin.path)
        if (current === undefined) {
          return corrupt(`merge-record '${note}' lost gitlink '${pin.path}'`)
        }
        if (current === pin.after) continue
        const component = await componentCheckout(git, options.repo, pin.path)
        if (component === undefined) {
          return {
            outcome: "unverifiable",
            note,
            status: "repository-incomplete",
            reason: `merge-record '${note}' cannot inspect component checkout '${pin.path}'`,
          }
        }
        if (!(await isAncestor(git, component, pin.after, current))) {
          return corrupt(`merge-record '${note}' pin '${pin.after}' is not contained by '${pin.path}' at '${current}'`)
        }
      }
    }
    const selector = options.selector
    if (
      selector !== undefined &&
      parsed.record.merge.id !== selector &&
      !parsed.record.changes.some(
        (change) => change.pr === selector || change.changeId === selector || change.submittedHead === selector,
      )
    ) {
      return { outcome: "filtered" }
    }
    return {
      outcome: "verified",
      record: {
        record: parsed.record,
        pointer: { ref: MERGE_RECORD_REF, target, note, checksum: parsed.checksum },
      },
    }
  }

  const records: RepositoryMergeRecord[] = []
  const unverifiable: UnverifiableMergeRecord[] = []
  for (const line of listed.stdout === "" ? [] : listed.stdout.split("\n")) {
    const listing = await verifyListing(line)
    if (listing.outcome === "verified") {
      records.push(listing.record)
      continue
    }
    if (listing.outcome === "filtered") continue
    if (options.isolateUnverifiable !== true) return { status: listing.status, reason: listing.reason }
    unverifiable.push({ note: listing.note, status: listing.status, reason: listing.reason })
  }
  // Records that exist but could not be verified are never "missing": reporting them as an empty
  // estate would hand the caller a clean-looking zero for a repository that just failed to prove
  // itself.
  if (records.length === 0 && unverifiable.length === 0) {
    return { status: "not-proven", reason: "merge-record-missing" }
  }
  return { status: "proven", records, unverifiable }
}

export const RepositoryChangeIdentitySchema = z
  .object({
    changeId: z.string().regex(/^I[0-9a-f]{40}$/u),
    submittedHead: z.string().regex(/^[0-9a-f]{40,64}$/u),
  })
  .strict()
export type RepositoryChangeIdentity = Readonly<z.infer<typeof RepositoryChangeIdentitySchema>>

export type RepositoryChangeLandingResult =
  | Readonly<{
      status: "proven"
      fact: RepositoryChangeIdentity & Readonly<{ landingSha: string; baseSha: string }>
    }>
  | Readonly<{ status: "not-proven"; reason: "change-id-not-on-base" }>

/** Resolve a logical code change from repository truth alone.
 *
 * The submitted commit is deliberately not part of the ancestry predicate:
 * Queue may regenerate a carrier while preserving its stable Change-Id. The
 * selected base's history is the population, so a match is already ancestry
 * proof and no subject, branch name, patch-id, or Journal row participates.
 */
export async function findRepositoryChangeLanding(
  options: Readonly<{
    inject: Readonly<{ process: Pick<Process, "run"> }>
    repo: string
    baseSha: string
    identity: RepositoryChangeIdentity
  }>,
): Promise<RepositoryChangeLandingResult> {
  const identity = RepositoryChangeIdentitySchema.parse(options.identity)
  const baseSha = z
    .string()
    .regex(/^[0-9a-f]{40,64}$/u)
    .parse(options.baseSha)
  const git = createGit(options.inject.process)
  await git.commit(options.repo, baseSha)
  const history = await git.run(options.repo, [
    "log",
    "--no-show-signature",
    "--format=%H%x09%(trailers:key=Change-Id,valueonly,separator=%x2c)",
    baseSha,
    "--",
  ])
  const matches: string[] = []
  for (const row of history.stdout === "" ? [] : history.stdout.split("\n")) {
    const separator = row.indexOf("\t")
    const commit = separator === -1 ? row : row.slice(0, separator)
    if (!/^[0-9a-f]{40,64}$/u.test(commit)) {
      throw new Error(`yrd: malformed repository Change-Id row '${row}'`)
    }
    const changeIds = (separator === -1 ? "" : row.slice(separator + 1)).split(",").filter((value) => value !== "")
    if (!changeIds.includes(identity.changeId)) continue
    if (changeIds.length !== 1) {
      throw new Error(`yrd: landed commit '${commit}' carries multiple Change-Id trailers`)
    }
    matches.push(commit)
  }
  if (matches.length > 1) {
    throw new Error(
      `yrd: Change-Id '${identity.changeId}' appears in multiple commits on selected base '${baseSha}': ${matches.join(
        ", ",
      )}`,
    )
  }
  const landingSha = matches[0]
  return landingSha === undefined
    ? { status: "not-proven", reason: "change-id-not-on-base" }
    : { status: "proven", fact: { ...identity, landingSha, baseSha } }
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
    /** CLI-resolved immutable code-carrier candidate. Queue never resolves a symbolic proposal ref. */
    proposedHeadSha?: string
    /** Same-issue source integrations already present on the authoritative root history, newest first. */
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

/**
 * Base-independent composite patch identity for a composition's source rewrites.
 * A single source certifies by its own source-repo patch id; multiple sources
 * certify by a stable hash of their (repo, patchId) pairs in composition order.
 * Every source rewrite pins the fixed `source.baseSha..source.tipSha` payload, so
 * this identity does not depend on the authoritative root base — which is exactly
 * why it survives a base-chase re-anchoring while the whole-root treeSha does not.
 */
function compositionPatchId(rewrites: readonly Readonly<{ repo: string; patchId: string }>[]): string {
  const onlyRewrite = rewrites.length === 1 ? rewrites[0] : undefined
  return onlyRewrite !== undefined
    ? onlyRewrite.patchId
    : createHash("sha256")
        .update(
          JSON.stringify(rewrites.map(({ repo: sourceRepo, patchId: sourcePatchId }) => [sourceRepo, sourcePatchId])),
        )
        .digest("hex")
}

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
  if (input.proposedHeadSha !== undefined) {
    const certificateGit = createGit(git.process, git.env, { noLazyFetch: true })
    const target = await inspectLiveQueueBase(certificateGit, repo, input.base)
    if (target.diverged) {
      throw codeCarrierRefusal(
        "queue-environment-refused",
        `local '${target.branchRef}' and authoritative 'refs/remotes/origin/${target.branch}' differ; refresh or reconcile the target before certifying PR '${input.id}'`,
      )
    }
    return certifyProposedCodeCarrier(certificateGit, repo, target, input, input.proposedHeadSha)
  }
  const target = await authoritativeQueueBase(git, repo, input.base)
  const current = input.current
  // An already-landed direct revision delivers nothing beyond the base, so its
  // head IS the base and `target..head` has no patch identity to certify
  // against. Re-derive it from the immutable source instead of refusing
  // `recut-certificate` on the fast path (22373). Composed revisions legitimately
  // sit at the base and certify by wrapper replay, so they keep the fast path.
  const alreadyLandedDirect =
    (current?.composition ?? input.composition) === undefined && current?.headSha === target.sha
  if (
    (current?.revision === input.revision || current?.fromRevision === input.revision) &&
    current.baseSha === target.sha &&
    current.treeSha !== undefined &&
    current.patchId !== undefined &&
    !alreadyLandedDirect
  ) {
    await assertCurrentRecutCertificate(git, repo, target, input, current)
    return {
      headSha: current.headSha,
      baseSha: target.sha,
      treeSha: current.treeSha,
      patchId: current.patchId,
      unchanged: true,
      ...((current.composition ?? input.composition) === undefined
        ? {}
        : { composition: current.composition ?? input.composition }),
    }
  }
  let recutInput = input
  let localSourceTips: ReadonlySet<string> | undefined
  if (recutInput.composition === undefined) {
    const converted = await sourceOnlyCarrierComposition(git, repo, target, recutInput)
    if (converted === undefined) return recutDirectPR(git, repo, target, recutInput)
    recutInput = {
      ...recutInput,
      headSha: converted.sourceBase,
      composition: converted.composition,
    }
    localSourceTips = new Set(converted.composition.sources.map((source) => source.repo))
  }
  const declared = recutInput.composition
  if (declared === undefined) throw new Error("source-only carrier conversion produced no composition")
  const outcome = await withScratch<PRRecutResult>(git, repo, target.sha, undefined, async (path) => {
    const composed = await composePR(git, repo, path, recutInput, localSourceTips)
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
    const patchId = compositionPatchId(rewrites)
    return {
      status: "completed",
      conclusion: "success",
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
  if (outcome.status === "completed" && outcome.conclusion === "success") return outcome.output
  const message =
    outcome.status === "completed" && outcome.conclusion === "failure"
      ? outcome.error.message
      : (outcome.detail ?? outcome.token)
  throw createFailure({ kind: "infrastructure", code: "recut-scratch-failed", message: `yrd: ${message}` })
}

type RawPayload = Readonly<{ identity: string; paths: readonly string[]; gitlinks: readonly string[] }>

async function rawPayload(git: Git, repo: string, from: string, to: string): Promise<RawPayload> {
  const identity = await changedPayloadIdentity(git, repo, from, to)
  const fields = identity.split("\0")
  const paths: string[] = []
  const gitlinks: string[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const header = fields[index]
    const path = fields[index + 1]
    if (header === undefined || header === "" || path === undefined || path === "") continue
    const match = /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]{40,64} [0-9a-f]{40,64} [A-Z]$/u.exec(header)
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error(`yrd: git diff --raw emitted an invalid record '${header}'`)
    }
    paths.push(path)
    if (match[1] === "160000" || match[2] === "160000") gitlinks.push(path)
  }
  return { identity, paths: paths.toSorted(), gitlinks: gitlinks.toSorted() }
}

type FrozenCarrierRange = Readonly<{ baseSha: string; headSha: string }>
type FrozenCarrierFailure = Readonly<{
  kind: "commit-missing" | "lineage" | "gitlinks" | "drop" | "extra" | "identity" | "patch-id" | "tree"
  range?: "source" | "candidate"
  endpoint?: "base" | "head"
  sha?: string
  paths?: readonly string[]
}>
type FrozenCarrierProof = Readonly<{ treeSha: string; patchId: string }>

async function deriveFrozenCodeCarrier(
  git: Git,
  repo: string,
  source: FrozenCarrierRange,
  candidate: FrozenCarrierRange,
): Promise<FrozenCarrierProof | FrozenCarrierFailure> {
  for (const [range, endpoint, sha] of [
    ["source", "base", source.baseSha],
    ["source", "head", source.headSha],
    ["candidate", "base", candidate.baseSha],
    ["candidate", "head", candidate.headSha],
  ] as const) {
    if ((await git.optionalCommit(repo, sha)) !== sha) return { kind: "commit-missing", range, endpoint, sha }
  }
  for (const [range, { baseSha, headSha }] of [
    ["source", source],
    ["candidate", candidate],
  ] as const) {
    if (!(await isAncestor(git, repo, baseSha, headSha))) return { kind: "lineage", range }
  }
  const [sourcePayload, candidatePayload] = await Promise.all([
    rawPayload(git, repo, source.baseSha, source.headSha),
    rawPayload(git, repo, candidate.baseSha, candidate.headSha),
  ])
  const gitlinks = [...new Set([...sourcePayload.gitlinks, ...candidatePayload.gitlinks])].toSorted()
  if (gitlinks.length > 0) return { kind: "gitlinks", paths: gitlinks }
  const candidatePaths = new Set(candidatePayload.paths)
  const sourcePaths = new Set(sourcePayload.paths)
  const dropped = sourcePayload.paths.filter((path) => !candidatePaths.has(path))
  if (dropped.length > 0) return { kind: "drop", paths: dropped }
  const extra = candidatePayload.paths.filter((path) => !sourcePaths.has(path))
  if (extra.length > 0) return { kind: "extra", paths: extra }
  if (sourcePayload.identity !== candidatePayload.identity) return { kind: "identity" }
  const patchId = await git.stablePatchId(repo, source.baseSha, source.headSha)
  if (patchId === undefined) return { kind: "patch-id" }
  const tree = await git.run(repo, ["rev-parse", `${candidate.headSha}^{tree}`], true)
  return tree.code === 0 ? { treeSha: tree.stdout, patchId } : { kind: "tree" }
}

function codeCarrierRefusal(code: string, message: string): YrdFailure {
  return createFailure({ kind: "refusal", code, message: `yrd: ${message}` })
}

async function certifyProposedCodeCarrier(
  git: Git,
  repo: string,
  target: GitQueueTarget,
  input: PRRecutInput,
  proposedHeadSha: string,
): Promise<PRRecutResult> {
  const sourceBaseSha = input.baseSha
  if (sourceBaseSha === undefined) {
    throw codeCarrierRefusal(
      "recut-base-missing",
      `PR '${input.id}' revision ${input.revision} has no immutable source base SHA`,
    )
  }
  const proof = await deriveFrozenCodeCarrier(
    git,
    repo,
    { baseSha: sourceBaseSha, headSha: input.headSha },
    { baseSha: target.sha, headSha: proposedHeadSha },
  )
  if ("kind" in proof) {
    const paths = proof.paths ?? []
    if (proof.kind === "commit-missing") {
      if (proof.range === "candidate") {
        throw codeCarrierRefusal(
          "proposed-commit-missing",
          `PR '${input.id}' proposed commit '${proposedHeadSha}' is missing`,
        )
      }
      throw codeCarrierRefusal(
        "recut-source-missing",
        `PR '${input.id}' source ${String(proof.endpoint)} '${String(proof.sha)}' is missing`,
      )
    }
    if (proof.kind === "lineage") {
      throw proof.range === "candidate"
        ? codeCarrierRefusal(
            "carrier-drops-landed",
            `PR '${input.id}' proposed commit '${proposedHeadSha}' does not contain authoritative target '${target.sha}'`,
          )
        : codeCarrierRefusal(
            "recut-lineage",
            `PR '${input.id}' source base '${sourceBaseSha}' is not an ancestor of source head '${input.headSha}'`,
          )
    }
    if (proof.kind === "gitlinks") {
      const workflow = await intentSubmissionWorkflow(git, repo, target.sha, proposedHeadSha, paths, input.issue)
      throw codeCarrierRefusal(
        "authored-gitlink",
        `PR '${input.id}' proposed commit '${proposedHeadSha}' changes generated-only gitlinks [${paths.join(", ")}]; ${workflow}`,
      )
    }
    if (proof.kind === "drop" || proof.kind === "extra") {
      throw codeCarrierRefusal(
        `recut-certification-${proof.kind}`,
        `PR '${input.id}' proposed commit '${proposedHeadSha}' ${proof.kind === "drop" ? "drops approved" : "adds unapproved"} paths [${paths.join(", ")}]`,
      )
    }
    if (proof.kind === "identity") {
      throw codeCarrierRefusal(
        "recut-certification-corrupt",
        `PR '${input.id}' proposed commit '${proposedHeadSha}' changes approved path, mode, blob, or status identity`,
      )
    }
    if (proof.kind === "patch-id") {
      throw codeCarrierRefusal(
        "payload-certificate",
        `PR '${input.id}' revision ${input.revision} has no stable patch identity`,
      )
    }
    throw new Error(`yrd: proposed commit '${proposedHeadSha}' has no readable tree`)
  }
  const current = input.current
  const unchanged =
    current !== undefined &&
    (current.revision === input.revision || current.fromRevision === input.revision) &&
    current.headSha === proposedHeadSha &&
    current.baseSha === target.sha &&
    current.treeSha === proof.treeSha &&
    current.patchId === proof.patchId
  return { headSha: proposedHeadSha, baseSha: target.sha, ...proof, unchanged }
}

type SourceOnlyCarrierComposition = Readonly<{
  sourceBase: string
  composition: NonNullable<PRSnapshot["composition"]>
}>

/**
 * Recognize the one-source root carrier shape that can be represented as an
 * internal composition manifest. This is eligibility only: prepareSource and
 * rebaseSource still own restacking and every payload/certificate proof. Mixed,
 * multi-source, overlapping, or unproven carriers fall through so the direct
 * recutter's existing refusal remains authoritative.
 */
async function sourceOnlyCarrierComposition(
  git: Git,
  repo: string,
  target: GitQueueTarget,
  input: PRRecutInput,
): Promise<SourceOnlyCarrierComposition | undefined> {
  const oldBase = input.baseSha
  if (
    oldBase === undefined ||
    (await git.optionalCommit(repo, oldBase)) !== oldBase ||
    (await git.optionalCommit(repo, input.headSha)) !== input.headSha ||
    !(await isAncestor(git, repo, oldBase, target.sha))
  ) {
    return undefined
  }
  const sourceBase = await directRecutSourceBase(git, repo, oldBase, input.headSha)
  if (sourceBase === undefined) return undefined
  const rootPayload = await changedPaths(git, repo, sourceBase, input.headSha)
  if (rootPayload.length !== 1) return undefined

  const mergeTipFailure = await mergeTipCarrierFailure(git, repo, input.id, input.headSha, target.sha)
  if (mergeTipFailure !== undefined && mergeTipFailure.error.code !== "merge-tip-carrier") return undefined
  const mergeTip = mergeTipFailure?.error.code === "merge-tip-carrier"
  let hasDivergentPin = false
  const sources: NonNullable<PRSnapshot["composition"]>["sources"][number][] = []
  for (const path of rootPayload) {
    const basePin = await readGitlink(git, repo, sourceBase, path)
    const authoredPin = await readGitlink(git, repo, input.headSha, path)
    const currentPin = await readGitlink(git, repo, target.sha, path)
    if (basePin === undefined || authoredPin === undefined || currentPin === undefined) return undefined

    const sourceRepo = join(repo, path)
    try {
      await realpath(sourceRepo)
    } catch {
      // silent-fallback-allow: undefined is this function's "cannot certify a
      // source-only composition", and it is the FAIL-SAFE direction — six
      // sibling bail-outs above return it for ordinary non-qualifying inputs,
      // and the caller then takes the normal, more conservative recut path.
      // An unresolvable component path means we cannot certify, so declining is
      // correct; throwing would turn a non-qualifying candidate into an error.
      return undefined
    }
    if (
      (await git.optionalCommit(sourceRepo, basePin)) !== basePin ||
      (await git.optionalCommit(sourceRepo, authoredPin)) !== authoredPin ||
      (await git.optionalCommit(sourceRepo, currentPin)) !== currentPin ||
      !(await isAncestor(git, sourceRepo, basePin, authoredPin)) ||
      !(await isAncestor(git, sourceRepo, basePin, currentPin))
    ) {
      return undefined
    }

    const payload = await changedPaths(git, sourceRepo, basePin, authoredPin)
    const currentPayload = await changedPaths(git, sourceRepo, basePin, currentPin)
    if (payload.length === 0 || intersection(payload, currentPayload).length > 0) return undefined
    if (
      !(await isAncestor(git, sourceRepo, authoredPin, currentPin)) &&
      !(await isAncestor(git, sourceRepo, currentPin, authoredPin))
    ) {
      hasDivergentPin = true
    }
    sources.push({
      repo: path,
      branch: sourceCandidateRef(authoredPin),
      baseSha: basePin,
      tipSha: authoredPin,
      payload,
    })
  }
  if (!mergeTip && !hasDivergentPin) return undefined

  return {
    sourceBase,
    composition: { version: 1, sources },
  }
}

async function assertCurrentRecutCertificate(
  git: Git,
  repo: string,
  target: GitQueueTarget,
  input: PRRecutInput,
  current: NonNullable<PRRecutInput["current"]>,
): Promise<void> {
  const certifiedTreeSha = current.treeSha
  const certifiedPatchId = current.patchId
  if (certifiedTreeSha === undefined || certifiedPatchId === undefined) {
    throw createFailure({
      kind: "refusal",
      code: "recut-certificate",
      message: `yrd: PR '${input.id}' current revision ${current.revision} has no patch/tree certificate`,
    })
  }
  const composition = current.composition ?? input.composition
  if (composition === undefined) {
    const headExists = (await git.optionalCommit(repo, current.headSha)) === current.headSha
    const onTarget = headExists && (await isAncestor(git, repo, target.sha, current.headSha))
    const tree = headExists ? await git.run(repo, ["rev-parse", `${current.headSha}^{tree}`], true) : undefined
    const patchId = onTarget ? await git.stablePatchId(repo, target.sha, current.headSha) : undefined
    if (tree?.code !== 0 || tree?.stdout !== certifiedTreeSha || patchId !== certifiedPatchId) {
      throw createFailure({
        kind: "refusal",
        code: "recut-certificate",
        message: `yrd: PR '${input.id}' current patch/tree certificate does not match revision ${current.revision}`,
      })
    }
    return
  }

  if (current.headSha !== target.sha) {
    throw createFailure({
      kind: "refusal",
      code: "recut-certificate",
      message: `yrd: PR '${input.id}' current composed head does not match the authoritative base`,
    })
  }
  const currentCompositionFailure = (message: string) =>
    createFailure({
      kind: "refusal",
      code: "recut-certificate",
      message: `yrd: PR '${input.id}' current composed certificate could not replay: ${message}`,
    })
  const outcome = await withScratch<Readonly<{ treeSha: string; patchId: string }>>(
    git,
    repo,
    target.sha,
    undefined,
    async (path) => {
      const receipts: Readonly<{ repo: string; patchId: string }>[] = []
      for (const source of composition.sources) {
        const sourceRepo = join(repo, source.repo)
        try {
          await realpath(sourceRepo)
        } catch {
          throw currentCompositionFailure(`source repository '${source.repo}' is not initialized`)
        }
        const currentPin = await readGitlink(git, path, "HEAD", source.repo)
        if (currentPin !== source.baseSha) {
          throw currentCompositionFailure(`source '${source.repo}' base does not match the authoritative root pin`)
        }
        if (
          (await git.optionalCommit(sourceRepo, source.baseSha)) !== source.baseSha ||
          (await git.optionalCommit(sourceRepo, source.tipSha)) !== source.tipSha ||
          !(await isAncestor(git, sourceRepo, source.baseSha, source.tipSha))
        ) {
          throw currentCompositionFailure(`source '${source.repo}' immutable range is missing or invalid`)
        }
        const payload = await changedPaths(git, sourceRepo, source.baseSha, source.tipSha)
        const patchId = await git.stablePatchId(sourceRepo, source.baseSha, source.tipSha)
        if (!samePaths(payload, source.payload)) {
          throw currentCompositionFailure(`source '${source.repo}' payload differs`)
        }
        if (patchId === undefined) {
          throw currentCompositionFailure(`source '${source.repo}' patch certificate does not replay`)
        }
        const staged = await git.run(
          path,
          ["update-index", "--cacheinfo", `160000,${source.tipSha},${source.repo}`],
          true,
        )
        if (staged.code !== 0) throw currentCompositionFailure(`source '${source.repo}' wrapper could not be staged`)
        receipts.push({ repo: source.repo, patchId })
      }
      const tree = await git.run(path, ["write-tree"], true)
      if (tree.code !== 0) throw currentCompositionFailure("wrapper tree could not be written")
      const materialized = await changedPaths(git, path, target.sha, tree.stdout)
      if (
        !samePaths(
          materialized,
          composition.sources.map((source) => source.repo),
        )
      ) {
        throw currentCompositionFailure("wrapper paths do not match the current composition")
      }
      return {
        status: "completed",
        conclusion: "success",
        output: {
          treeSha: tree.stdout,
          patchId: compositionPatchId(receipts),
        },
      }
    },
  )
  if (outcome.status !== "completed" || outcome.conclusion !== "success") {
    const message =
      outcome.status === "completed" && outcome.conclusion === "failure"
        ? outcome.error.message
        : (outcome.detail ?? outcome.token)
    throw createFailure({ kind: "infrastructure", code: "recut-scratch-failed", message: `yrd: ${message}` })
  }
  if (outcome.output.treeSha !== certifiedTreeSha || outcome.output.patchId !== certifiedPatchId) {
    throw createFailure({
      kind: "refusal",
      code: "recut-certificate",
      message: `yrd: PR '${input.id}' current composed patch/tree certificate does not match revision ${current.revision}`,
    })
  }
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
  const mergeTip = await mergeTipCarrierFailure(git, repo, input.id, input.headSha, target.sha)
  if (mergeTip !== undefined) {
    throw createFailure({
      kind: "refusal",
      code: mergeTip.error.code,
      message: `yrd: ${mergeTip.error.message}`,
    })
  }
  if (!(await isAncestor(git, repo, oldBase, target.sha))) {
    throw createFailure({
      kind: "refusal",
      code: "recut-lineage",
      message: `yrd: PR '${input.id}' recorded base '${oldBase}' is not an ancestor of '${target.sha}'`,
    })
  }
  const sourceBase = await directRecutSourceBase(git, repo, oldBase, input.headSha)
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
  const overlapping = intersection(payload, authority)
  const absorbedGitlinks = await absorbedAuthoredGitlinks(
    git,
    repo,
    sourceBase,
    input.headSha,
    target.sha,
    overlapping,
    input.currentCompositions,
  )
  const absorbedSet = new Set(absorbedGitlinks)
  // 22373: rebasing onto a base that already landed part of this branch drops
  // those commits as patch-equivalent — the healthy outcome of a moved base,
  // not a loss. The expected payload is therefore recomposed for the new base,
  // one proven path at a time, before it is compared with what materialized.
  // The comparison itself stays exact set equality: a path that vanishes
  // WITHOUT an already-landed proof still refuses, loudly, as it must.
  const absorbedContent = await absorbedAuthoredPaths(git, repo, input.headSha, target.sha, overlapping, absorbedSet)
  const absorbedPaths = [...absorbedGitlinks, ...absorbedContent].toSorted()
  const absorbedPathSet = new Set(absorbedPaths)
  const effectivePayload = payload.filter((path) => !absorbedPathSet.has(path))
  if (effectivePayload.length === 0) {
    if (absorbedPaths.length === 0) {
      throw createFailure({
        kind: "refusal",
        code: "payload-certificate",
        message: `yrd: PR '${input.id}' revision ${input.revision} changes nothing against its recorded base`,
      })
    }
    return absorbedRecutResult(git, repo, target, input, sourceBase)
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
  const outcome = await withScratch<PRRecutResult>(git, repo, input.headSha, undefined, async (path) => {
    let rebased = await git.run(
      path,
      [
        "-c",
        "user.name=Yrd Queue",
        "-c",
        "user.email=yrd-queue@example.invalid",
        "-c",
        "core.editor=true",
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
        let resolution = await resolveGitlinkFastForward(git, repo, path, conflict)
        if (resolution.kind === "refuse") {
          resolution =
            (await resolveGitlinkByFinalPin(git, repo, path, conflict, target.sha, input.headSha)) ?? resolution
        }
        if (resolution.kind === "unresolved") break
        if (resolution.kind === "refuse") {
          const replayedRoot = (await git.optionalCommit(path, "REBASE_HEAD")) ?? input.headSha
          await git.run(path, ["rebase", "--abort"], true)
          throw createFailure({
            kind: "refusal",
            code: resolution.code,
            message:
              `yrd: PR '${input.id}' could not recut: target root '${target.sha}' pins submodule ` +
              `'${resolution.path}' to '${resolution.basePin}'; replayed authored root '${replayedRoot}' pins it to ` +
              `'${resolution.authoredPin}'; ancestry walk failed because ${resolution.message}`,
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
    // 21461: git's merge machinery fast-forwards a carrier gitlink WITHOUT a
    // conflict when the submodule is checked out where the rebase runs (ORT
    // proves the ancestry itself), so the conflict-time classification above
    // never sees it. Left unclassified, the path stays inside the strict
    // patch-id certificate whose from-side differs by construction whenever the
    // base advanced the same submodule — a guaranteed "changed stable patch
    // identity" refusal for a byte-identical payload (a0's PR541, four
    // revisions). Classify those paths post-rebase with the same ancestry
    // proof the conflict path uses; unprovable or base-won paths stay
    // unclassified and strict certification keeps owning them.
    await classifyAutoFastForwardedCarrierGitlinks(git, repo, path, {
      overlap,
      skip: absorbedSet,
      sourceBase,
      targetSha: target.sha,
      authoredHead: input.headSha,
      recutHead: headSha,
      into: ffCarrierGitlinks,
    })
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
    let usedUnionMerge = false
    if (certifyPayload.length > 0) {
      if (certifySourcePatchId === undefined || certifyMaterializedPatchId === undefined) {
        throw createFailure({
          kind: "refusal",
          code: "payload-certificate",
          message: `yrd: PR '${input.id}' recut has no stable patch identity`,
        })
      }
      const patchMatches = certifyMaterializedPatchId === certifySourcePatchId
      const unionMerged =
        !patchMatches && certifyOverlap.length > 0 && (await usesUnionMerge(git, repo, target.sha, certifyOverlap))
      if (!patchMatches && !unionMerged) {
        throw createFailure({
          kind: "refusal",
          code: "payload-certificate",
          message: `yrd: PR '${input.id}' recut changed stable patch identity`,
        })
      }
      if (
        unionMerged &&
        !(await matchesExpectedUnionMerge(git, repo, sourceBase, target.sha, input.headSha, headSha, certifyOverlap))
      ) {
        throw createFailure({
          kind: "refusal",
          code: "payload-certificate",
          message: `yrd: PR '${input.id}' recut did not preserve deterministic union identity`,
        })
      }
      usedUnionMerge = unionMerged
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
    // Absorbed paths (gitlinks by pin ancestry, ordinary paths by already-landed
    // end state) legitimately have no counterpart in the recut range, so the
    // whole-range range-diff can no longer be the certificate; the ordered
    // patch sequence over the remaining paths owns it instead.
    const hasAbsorbedExceptions = absorbedPaths.length > 0 || ffCarrierGitlinks.size > 0
    if (usedUnionMerge && hasAbsorbedExceptions) {
      const sourceCount = await git.run(repo, ["rev-list", "--count", `${sourceBase}..${input.headSha}`], true)
      const recutCount = await git.run(path, ["rev-list", "--count", `${target.sha}..${headSha}`], true)
      if (sourceCount.code !== 0 || recutCount.code !== 0 || sourceCount.stdout !== "1" || recutCount.stdout !== "1") {
        throw createFailure({
          kind: "refusal",
          code: "payload-certificate",
          message: `yrd: PR '${input.id}' union-merge recut requires one root commit`,
        })
      }
    } else if (!hasAbsorbedExceptions) {
      const rangeDiff = await git.rangeDiff(path, sourceBase, input.headSha, target.sha, headSha)
      if (rangeDiff.code !== 0 || !isEqualRangeDiff(rangeDiff.stdout)) {
        throw createFailure({
          kind: "refusal",
          code: "payload-certificate",
          message: `yrd: PR '${input.id}' recut is not range-diff equivalent`,
        })
      }
    } else {
      const ffGitlinks = [...ffCarrierGitlinks].toSorted()
      const sourceSequence = await certifiedPatchSequence(
        git,
        repo,
        sourceBase,
        input.headSha,
        absorbedPaths,
        ffGitlinks,
      )
      const recutSequence = await certifiedPatchSequence(git, path, target.sha, headSha, absorbedPaths, ffGitlinks)
      if (sourceSequence === undefined || recutSequence === undefined) {
        throw createFailure({
          kind: "refusal",
          code: "payload-certificate",
          message: `yrd: PR '${input.id}' current-composition recut has no stable commit-sequence identity`,
        })
      }
      if (
        sourceSequence.length !== recutSequence.length ||
        sourceSequence.some((patchId, index) => patchId !== recutSequence[index])
      ) {
        throw createFailure({
          kind: "refusal",
          code: "payload-certificate",
          message: `yrd: PR '${input.id}' current-composition recut is not commit-sequence equivalent`,
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
      const published = await pushRefUpdates({
        root: repo,
        git: adaptProcessGit(git.process, { env: git.env, timeoutMs: GIT_TIMEOUT_MS }),
        timeoutMs: GIT_TIMEOUT_MS,
        updates: [{ repository: repo, remote: "origin", source: headSha, destination: ref }],
      })
      if (published.state !== "updated" && published.state !== "unchanged") {
        throw createFailure({
          kind: "infrastructure",
          code: "recut-publish",
          message: `yrd: PR '${input.id}' recut ref could not be published: ${
            gitSuperFailureDetail(published)?.message ?? published.state
          }`,
        })
      }
    }
    return {
      status: "completed",
      conclusion: "success",
      output: {
        headSha,
        baseSha: target.sha,
        treeSha: (await git.run(path, ["rev-parse", `${headSha}^{tree}`])).stdout,
        patchId: materializedPatchId,
        unchanged: false,
      },
    }
  })
  if (outcome.status === "completed" && outcome.conclusion === "success") return outcome.output
  const message =
    outcome.status === "completed" && outcome.conclusion === "failure"
      ? outcome.error.message
      : (outcome.detail ?? outcome.token)
  throw createFailure({ kind: "infrastructure", code: "recut-scratch-failed", message: `yrd: ${message}` })
}

async function directRecutSourceBase(
  git: Git,
  repo: string,
  oldBase: string,
  headSha: string,
): Promise<string | undefined> {
  return (await isAncestor(git, repo, oldBase, headSha)) ? oldBase : uniqueMergeBase(git, repo, oldBase, headSha)
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
  throw new Error(`yrd: merge-queue base '${branch}' does not resolve as '${branchRef}' or '${sourceRef}'`)
}

async function inspectLiveQueueBase(git: Git, repo: string, branch: string): Promise<GitQueueTarget> {
  const cached = await inspectQueueBase(git, repo, branch)
  const configuredRemote = await git.run(repo, ["config", "--get", "remote.origin.url"], true)
  if (configuredRemote.code !== 0 || configuredRemote.stdout === "") return cached

  const sourceRef = `refs/heads/${branch}`
  const inspected = await git.run(repo, ["ls-remote", "--exit-code", "origin", sourceRef], true)
  const live = /^([0-9a-f]{40,64})\s+refs\/heads\/.+$/iu.exec(inspected.stdout)?.[1]
  if (inspected.code !== 0 || live === undefined) {
    throw codeCarrierRefusal(
      "queue-environment-refused",
      `live 'origin/${branch}' could not be proved without mutating the repository`,
    )
  }
  if (cached.remoteSha !== live || (cached.localSha !== undefined && cached.localSha !== live)) {
    throw codeCarrierRefusal(
      "queue-environment-refused",
      `live 'origin/${branch}' is '${live}', but local/cached target refs do not both resolve to that SHA; refresh or reconcile the target before certifying`,
    )
  }
  return { ...cached, sha: live, remote: "origin", remoteSha: live, diverged: false }
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

/**
 * Create a scratch directory for `repo` under `parent`, defaulting to the
 * queue's own state dir on the repository filesystem. Callers pass `parent`
 * only when the host has configured one (the bays root); nobody gets the
 * system temp dir, which on a tmpfs host is an inode budget shared with every
 * unrelated process. See `queueScratchParent`.
 */
async function scratchIn(git: Git, repo: string, prefix: string, parent?: string): Promise<string> {
  const root = parent ?? (await queueScratchParent(git, repo))
  await reapOnce(git, repo, root)
  await mkdir(root, { recursive: true })
  return mkdtemp(join(await realpath(root), prefix))
}

/** Scratch roots this process has already swept, so the reap stays one-shot. */
const reapedScratchRoots = new Set<string>()

/**
 * The scratch entries git still lists as live worktrees. A queue worktree lives
 * at `<entry>/worktree`, so a listed path under the scratch root names its
 * entry's first segment; that is what separates an abandoned tree from one a
 * concurrent run is still using.
 */
async function liveScratchEntries(git: Git, repo: string, root: string): Promise<Set<string>> {
  const listed = await git.run(repo, ["worktree", "list", "--porcelain"], true)
  if (listed.code !== 0) return new Set()
  const live = new Set<string>()
  for (const line of listed.stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue
    const path = resolve(line.slice("worktree ".length).trim())
    const prefix = `${resolve(root)}${sep}`
    if (!path.startsWith(prefix)) continue
    const segment = path.slice(prefix.length).split(sep)[0]
    if (segment !== undefined && segment !== "") live.add(join(resolve(root), segment))
  }
  return live
}

/**
 * Sweep scratch abandoned by an earlier process, once per root per process.
 * Placed at creation rather than at queue-run startup so every entry point —
 * queue run, recut, patch-id, a direct step runner in a test host — pays for the
 * cleanup it might itself leave behind.
 */
async function reapOnce(git: Git, repo: string, root: string): Promise<void> {
  const key = resolve(root)
  if (reapedScratchRoots.has(key)) return
  reapedScratchRoots.add(key)
  const report = await reapOrphanedScratch(key, { keep: await liveScratchEntries(git, repo, key) })
  if (report.reaped > 0 || report.failures.length > 0) console.warn(describeScratchReap(report))
}

/**
 * Storage exhaustion while preparing scratch is infrastructure, never a bad
 * candidate: nothing about the composition is wrong, no author can act on it,
 * and the very same candidate merges first try once the filesystem has room.
 * On 2026-08-14 R2224-R2235 all failed on an inode-exhausted tmpfs and
 * R2236/R2237 merged untouched minutes later. Reporting that as `merge-failed`
 * sent readers hunting a content conflict that did not exist, so classify it
 * into its own code carrying the filesystem's inode/byte split.
 *
 * `withScratchRoot` has normally already classified, and its answer wins: it was
 * taken while the scratch directory still existed. The re-derivation below is
 * for the causes no scratch primitive ever sees — `materializeSubmodules`
 * reports ENOSPC through an exit status, not a throw.
 */
async function storageExhaustionResult(git: Git, repo: string, cause: unknown): Promise<JobResult<never> | undefined> {
  const tagged = taggedStorageExhaustion(cause)
  if (tagged !== undefined) return { status: "completed", conclusion: "failure", error: tagged }
  if (!isStorageExhaustion(cause)) return undefined
  return {
    status: "completed",
    conclusion: "failure",
    error: await storageExhaustionError(await scratchPath(git, repo), cause),
  }
}

/**
 * The infrastructure classification a queue step's outer catch owes a thrown
 * cause, in ONE place. Returns `undefined` only when the cause is genuinely the
 * step's own domain failure, which the caller then names.
 *
 * Every step used to open its catch with the same three refusal probes and then
 * decide for itself whether to also ask about storage; `gitCheckStep` did not
 * ask, so an ENOSPC on its scratch worktree came back as `check-failed`.
 */
async function stepInfrastructureFailure(
  git: Git,
  repo: string,
  cause: unknown,
): Promise<JobResult<never> | undefined> {
  const refusal =
    queueAuthorityRefusal(cause) ?? submoduleReachabilityRefusal(cause) ?? submoduleCompositionRefusal(cause)
  if (refusal !== undefined) {
    return failedWithEvidence(failureFact(cause)?.code ?? "queue-environment-refused", messageOf(cause), refusal)
  }
  return storageExhaustionResult(git, repo, cause)
}

/**
 * `materializeSubmodules` reports ENOSPC through its exit status rather than a
 * throw, so it never reaches `withScratchRoot`'s classification and must be
 * asked about here — on the same filesystem, for the same outage.
 */
async function candidateSubmodulesFailure(git: Git, repo: string, detail: string): Promise<JobResult<never>> {
  return (await storageExhaustionResult(git, repo, detail)) ?? failed("candidate-submodules-failed", detail)
}

/** Where to read the exhausted filesystem from. */
async function scratchPath(git: Git, repo: string): Promise<string> {
  // silent-fallback-allow: the scratch parent is only ever a better PATH to
  // `statfs` than the repo itself — both sit on the filesystem being reported.
  // A `--git-common-dir` that cannot answer is exactly the case where the repo
  // root is the honest probe, and the failure being classified is already the
  // loud one this call decorates.
  return queueScratchParent(git, repo).catch(() => repo)
}

/**
 * Tag `cause` with its typed storage failure when it is an ENOSPC, so the
 * classification travels with the throw. Anything else is returned untouched.
 */
async function classifyScratchFailure(git: Git, repo: string, cause: unknown): Promise<unknown> {
  if (taggedStorageExhaustion(cause) !== undefined || !isStorageExhaustion(cause)) return cause
  const failure = await storageExhaustionError(await scratchPath(git, repo), cause)
  return tagStorageExhaustion(cause instanceof Error ? cause : new Error(String(cause)), failure)
}

/**
 * The one way to obtain a queue scratch root: creation AND the whole body run
 * under storage-exhaustion classification, so a consumer cannot forget it.
 * Before this seam existed the 2026-08-14 ENOSPC was classified at four merge-step
 * catches, while `gitCheckStep`, `rebaseSource`, `matchesExpectedUnionMerge` and
 * `withComponentMainPromotions` prepared scratch on the same filesystem and
 * reported the identical error as a content or candidate failure the author was
 * told to go fix.
 *
 * Cleanup stays with the body: the consumers differ in what they must tear down
 * (a worktree before its root, or a root alone) and in how each reports a
 * cleanup failure, and none of that is scratch classification's business.
 */
async function withScratchRoot<Output>(
  git: Git,
  repo: string,
  prefix: string,
  parent: string | undefined,
  run: (root: string) => Promise<Output>,
): Promise<Output> {
  let root: string
  try {
    root = await scratchIn(git, repo, prefix, parent)
  } catch (cause) {
    throw await classifyScratchFailure(git, repo, cause)
  }
  try {
    return await run(root)
  } catch (cause) {
    throw await classifyScratchFailure(git, repo, cause)
  }
}

async function withScratch<Output extends JsonValue>(
  git: Git,
  repo: string,
  ref: string,
  parent: string | undefined,
  run: (path: string, root: string) => Promise<JobResult<Output>>,
): Promise<JobResult<Output>> {
  return withScratchRoot(git, repo, "yrd-queue-", parent, (root) => runInScratch(git, repo, ref, root, run))
}

async function runInScratch<Output extends JsonValue>(
  git: Git,
  repo: string,
  ref: string,
  root: string,
  run: (path: string, root: string) => Promise<JobResult<Output>>,
): Promise<JobResult<Output>> {
  const worktrees = createGitWorktreeStore({
    repo,
    git,
    timeouts: { operation: GIT_TIMEOUT_MS, cleanup: GIT_CLEANUP_TIMEOUT_MS },
  })
  const path = join(root, "worktree")
  let added = false
  let outcome: JobResult<Output> | undefined
  let operationFailure: unknown
  try {
    await worktrees.add({
      kind: "detached",
      path,
      ref,
      operation: `Queue scratch worktree add ${path}`,
    })
    added = true
    outcome = await run(path, root)
  } catch (cause) {
    operationFailure = cause
  }

  let cleanupFailure: string | undefined
  let removed = !added
  if (added) {
    try {
      await worktrees.remove(path, { operation: `Queue scratch worktree remove ${path}` })
      removed = true
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
  if ((outcome.status === "completed" && outcome.conclusion === "failure") || cleanupFailure === undefined) {
    return outcome
  }
  return failed("scratch-cleanup-failed", cleanupFailure)
}

export type PinIntentProvisionInput = Readonly<{
  path: string
  baseSha: string
  provisionalCandidateSha: string
  component: string
}>

export type PinIntentProvisioner = (
  input: PinIntentProvisionInput,
) => Promise<Readonly<{ generatedPaths: readonly string[] }>>

async function prepareCandidate(
  git: Git,
  repo: string,
  path: string,
  authoritativeBase: string,
  input: StepExecution,
  attempt: number,
  artifactRoot: string,
  refuse?: RefusePathsPolicy,
  provisionPinIntent?: PinIntentProvisioner,
): Promise<
  | Readonly<{
      status: "passed"
      output: Readonly<{
        sha: string
        changes: readonly CandidateChange[]
        sourceRewrites: readonly SourceRewrite[]
        submoduleResolutions: readonly QueueSubmoduleResolutionEvidence[]
      }>
    }>
  | Readonly<{ status: "failed"; error: Readonly<{ code: string; message: string }>; output: GitCheckFailureEvidence }>
> {
  const sourceRewrites: SourceRewrite[] = []
  const submoduleResolutions: QueueSubmoduleResolutionEvidence[] = []
  const changes: CandidateChange[] = []
  const recordChange = (pr: StepExecution["prs"][number], generatedCommit: string): void => {
    if (pr.intent !== undefined || pr.changeId === undefined) return
    changes.push(
      CandidateChangeSchema.parse({
        changeId: pr.changeId,
        pr: pr.id,
        revision: pr.revision,
        submittedHead: pr.headSha,
        generatedCommit,
      }),
    )
  }
  for (const pr of input.prs) {
    if (pr.intent !== undefined) {
      if (input.prs.length !== 1) {
        return candidateFailure("intent-batch-refused", "yrd: pin intents are serial Queue members, never a batch")
      }
      if (pr.headSha !== authoritativeBase) {
        return candidateFailure(
          "intent-base-moved",
          `yrd: intent '${pr.id}' was evaluated at '${pr.headSha}', not authoritative base '${authoritativeBase}'`,
        )
      }
      const currentPin = await readGitlink(git, path, "HEAD", pr.intent.authored.component)
      if (currentPin === undefined) {
        return candidateFailure(
          "intent-component-unknown",
          `yrd: intent component '${pr.intent.authored.component}' is not a gitlink at '${authoritativeBase}'`,
          pr.intent.authored.component,
          [pr.intent.authored.component],
        )
      }
      if (currentPin !== pr.intent.evaluated.priorPin) {
        return candidateFailure(
          "intent-base-moved",
          `yrd: intent '${pr.id}' evaluated pin '${pr.intent.evaluated.priorPin}', but '${authoritativeBase}' carries '${currentPin}'`,
        )
      }
      const synthesized = await synthesizeGitlinkWrapper(
        git,
        path,
        authoritativeBase,
        currentPin === pr.intent.evaluated.target
          ? []
          : [{ path: pr.intent.authored.component, sha: pr.intent.evaluated.target }],
        pinIntentCommitMessage(pr.intent.authored.component, pr.intent.evaluated.target, pr.intent.authored.issue.id),
        provisionPinIntent,
      )
      if (synthesized.status === "failed") return synthesized
      submoduleResolutions.push({
        kind: "pin",
        path: pr.intent.authored.component,
        sha: pr.intent.evaluated.target,
      })
      continue
    }
    if (pr.composition === undefined) {
      if (pr.recut !== undefined) {
        const dropped = await carrierDropsLandedFailure(git, repo, path, pr.id, pr.headSha, authoritativeBase)
        if (dropped !== undefined) return dropped
      }
      const mergeTip = await mergeTipCarrierFailure(git, path, pr.id, pr.headSha, "HEAD")
      if (mergeTip !== undefined) return mergeTip
      if (pr.recut?.certificate === "frozen-code-carrier-v1") {
        const certified = await verifyRecutCertificate(git, path, pr)
        if (certified !== undefined) return certified
      }
      // A post-landing actuator retry carries the same immutable PR snapshot
      // against a base that already contains it. Re-checking its recut patch
      // against itself produces an empty patch and a false certificate drift.
      // Source-only compositions are excluded: their root head intentionally
      // equals the base while their component payload still needs applying.
      if (await isAncestor(git, path, pr.headSha, "HEAD")) {
        recordChange(pr, pr.headSha)
        continue
      }
    }
    if (refuse !== undefined && refuse.paths.length > 0) {
      const inspected = await refusedPayloadPaths(git, path, pr.headSha, refuse.paths)
      if (inspected.status === "failed") return inspected
      if (inspected.output.length > 0) {
        const shown = inspected.output.slice(0, 8).join(", ") + (inspected.output.length > 8 ? ", …" : "")
        return candidateFailure(
          "refused-path",
          `PR '${pr.id}' touches refused path(s) [${shown}]${refuse.reason === undefined ? "" : `; ${refuse.reason}`}`,
          ".",
          inspected.output,
        )
      }
    }
    if (pr.composition !== undefined) {
      let baseMoved = false
      if (pr.recut !== undefined) {
        const movement = await recutBaseMovement(git, path, pr)
        if (movement.status === "failed") return movement
        baseMoved = movement.moved
      }
      const composed = await composePR(git, repo, path, pr)
      if (composed.status === "failed") return composed
      const certificate = await verifyComposedRecutCertificate(git, path, pr, composed.output, baseMoved)
      if (certificate !== undefined) return certificate
      sourceRewrites.push(...composed.output)
      recordChange(pr, await git.commit(path, "HEAD"))
      continue
    }
    if (pr.recut !== undefined && pr.recut.certificate !== "frozen-code-carrier-v1") {
      const certified = await verifyRecutCertificate(git, path, pr)
      if (certified !== undefined) return certified
    } else {
      const inspected = await authoredGitlinkPaths(git, path, pr.id, pr.headSha)
      if (inspected.status === "failed") return inspected
      const gitlinks = inspected.output
      if (gitlinks.length > 0) {
        const workflow = await intentSubmissionWorkflow(git, path, "HEAD", pr.headSha, gitlinks, pr.issue)
        return candidateFailure(
          "authored-gitlink",
          `PR '${pr.id}' changes generated-only gitlinks [${gitlinks.join(", ")}]; ${workflow}`,
          ".",
          gitlinks,
        )
      }
    }
    const before = await git.commit(path, "HEAD")
    const message = candidateChangeCommitMessage("merge", pr)
    const merged = await git.run(path, ["merge", "--no-ff", "-m", message, pr.headSha], true)
    if (merged.code !== 0) {
      const resolved = await resolveCandidateSubmoduleConflict(git, repo, path)
      if (resolved.status === "composed") {
        submoduleResolutions.push(...resolved.output)
        const wrapper = await stabilizeGeneratedRootWrapper(git, path, before, message)
        if (wrapper !== undefined) return wrapper
        recordChange(pr, await git.commit(path, "HEAD"))
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
    const wrapper = await stabilizeGeneratedRootWrapper(git, path, before, message)
    if (wrapper !== undefined) return wrapper
    const landed = await git.commit(path, "HEAD")
    // The clean path only. A conflicted merge is already refused above, and the
    // submodule-composition branch resolves by re-authoring its own tree, so its
    // deletions are the policy's, not the carrier's, and this comparison would
    // measure the wrong author.
    const erased = await unauthoredDeletionFailure(git, path, pr.id, pr.headSha, before, landed)
    if (erased !== undefined) return erased
    recordChange(pr, landed)
  }
  return {
    status: "passed",
    output: { sha: await git.commit(path, "HEAD"), changes, sourceRewrites, submoduleResolutions },
  }
}

async function mergeTreeCandidate(
  git: Git,
  repo: string,
  input: CandidatePreparationInput,
): Promise<"mergeable" | "conflicting"> {
  if (input.prs.some((pr) => pr.intent !== undefined)) return "mergeable"
  let current = input.baseSha
  for (const revision of input.revs) {
    const merged = await git.run(repo, ["merge-tree", "--write-tree", current, revision.head], true)
    if (merged.code !== 0) return "conflicting"
    const tree = merged.stdout.split(/\r?\n/u)[0]
    if (tree === undefined || !/^[0-9a-f]{40,64}$/iu.test(tree)) {
      throw new Error(`yrd: git merge-tree returned no tree for Candidate '${input.id}'`)
    }
    const committed = await git.run(repo, [
      "-c",
      "user.name=Yrd",
      "-c",
      "user.email=yrd@localhost",
      "commit-tree",
      tree,
      "-p",
      current,
      "-p",
      revision.head,
      "-m",
      `yrd mergeability probe ${input.id}`,
    ])
    current = committed.stdout
  }
  return "mergeable"
}

export type GitCandidatePreparerOptions = Readonly<{
  inject: Readonly<{ process: Pick<Process, "run"> }>
  repo: string
  checkoutParent?: string
  artifactRoot?: string
  env?: NodeJS.ProcessEnv
  candidatePool?: CandidatePool
  provisionPinIntent?: PinIntentProvisioner
}>

/** Construct and publish the ONE immutable Candidate before Runner admission.
 * `git merge-tree` classifies ordinary conflicts without a checkout; the
 * existing certificate-bearing composition path is then reused only to
 * materialize the synthetic commit and source-rewrite evidence. */
export function gitCandidatePreparer(options: GitCandidatePreparerOptions): CandidatePreparer {
  const repo = resolve(options.repo)
  const git = createGit(options.inject.process, options.env)
  return async (input): Promise<PreparedCandidate> => {
    const mergeability = await mergeTreeCandidate(git, repo, input)
    const needsDomainComposition = input.prs.some((pr) => pr.composition !== undefined || pr.recut !== undefined)
    if (mergeability === "conflicting" && !needsDomainComposition) {
      return {
        id: input.id,
        queueId: input.queueId,
        baseSha: input.baseSha,
        revs: input.revs,
        mergeability: "conflicting",
      }
    }
    const execution: StepExecution = {
      run: input.id,
      step: "candidate",
      index: 0,
      prs: input.prs,
      shape: { results: {} },
    }
    const materialize = async (path: string, scratchRoot: string): Promise<PreparedCandidate> => {
      const candidate = await prepareCandidate(
        git,
        repo,
        path,
        input.baseSha,
        execution,
        1,
        resolve(options.artifactRoot ?? join(repo, ".git", "yrd", "artifacts")),
        undefined,
        options.provisionPinIntent,
      )
      if (candidate.status === "failed") {
        throw createFailure({
          kind: "refusal",
          code: candidate.error.code,
          message: candidate.error.message,
        })
      }
      await proveCandidateSubmoduleReachability(
        git,
        repo,
        path,
        candidate.output.sha,
        join(scratchRoot, "submodule-proof"),
      )
      // 22332: the ref name IS the evidence, derived here — at publish time,
      // after the tree exists — rather than from the journal id allocated before
      // it. That is what makes compose self-collision structurally impossible
      // instead of merely recoverable: a retry that composes a different tree
      // gets a different SHA and therefore a different ref, and a retry that
      // composes the SAME tree lands on the same name with the same target,
      // where the create below is an idempotent no-op.
      const ref = candidateRefFor(candidate.output.sha)
      const pinned = await git.run(
        repo,
        ["update-ref", "--create-reflog", ref, candidate.output.sha, "0".repeat(candidate.output.sha.length)],
        true,
      )
      if (pinned.code !== 0) {
        const existing = await git.optionalCommit(repo, ref)
        if (existing !== candidate.output.sha) {
          // Two genuinely different faults, never collapsed into one sentence.
          // Fail Loud: absent-ref refusals carry git's own stderr (not just exit code).
          const gitDetail = (pinned.stderr || pinned.stdout || "").replace(/\s+/gu, " ").trim()
          const message =
            existing === undefined
              ? gitDetail.length > 0
                ? `yrd: Candidate ref '${ref}' could not be created: ${gitDetail}`
                : `yrd: Candidate ref '${ref}' could not be created (code ${pinned.code})`
              : // The name is the SHA, so a mismatch is not a collision between two
                // runs — it means something wrote a ref whose name disagrees with
                // its target. Say that, rather than blaming a peer that cannot exist.
                `yrd: Candidate ref '${ref}' resolves to ${existing}, which is not the evidence its content-addressed name states`
          throw createFailure({
            kind: "infrastructure",
            code: "candidate-ref-refused",
            message,
          })
        }
      }
      return {
        id: input.id,
        queueId: input.queueId,
        baseSha: input.baseSha,
        revs: input.revs,
        sha: candidate.output.sha,
        treeSha: (await git.run(path, ["rev-parse", `${candidate.output.sha}^{tree}`])).stdout,
        ref,
        ...(candidate.output.changes.length === 0 ? {} : { changes: candidate.output.changes }),
        ...(candidate.output.sourceRewrites.length === 0 ? {} : { sourceRewrites: candidate.output.sourceRewrites }),
        ...(candidate.output.submoduleResolutions.length === 0
          ? {}
          : { submoduleResolutions: candidate.output.submoduleResolutions }),
        mergeability: "mergeable",
      }
    }
    if (options.candidatePool !== undefined) {
      return options.candidatePool.withCandidate(input.baseSha, materialize)
    }
    const outcome = await withScratch<PreparedCandidate>(
      git,
      repo,
      input.baseSha,
      options.checkoutParent,
      async (path, scratchRoot) => ({
        status: "completed",
        conclusion: "success",
        output: await materialize(path, scratchRoot),
      }),
    )
    if (outcome.status === "completed" && outcome.conclusion === "success") return outcome.output
    throw new Error("yrd: Candidate scratch construction did not complete")
  }
}

type RecutBaseMovement = CandidateFailure | Readonly<{ status: "moved"; moved: boolean; baseSha: string; head: string }>

/**
 * Classify how the authoritative candidate base relates to the reviewed recut base
 * for a `pr.recut` snapshot. `repo` is the candidate worktree; its HEAD is the base
 * this candidate is actually built on. `pr.baseSha` is the refreshable check/admission
 * identity; `pr.recut.baseSha` is the immutable base certified by the recut revision.
 * A recut certifies a mechanical rebase of the reviewed revision, so its certified base
 * must be an *ancestor* of the candidate base:
 * either the same commit (no movement) or a forward advance the reviewed change can be
 * re-anchored onto. A missing or non-ancestor base cannot be mechanically re-anchored
 * and stays a hard refusal.
 *
 * The two ways that fails are NOT the same failure, and the queue acts on the
 * difference (22647). An absent base OBJECT is an unfetched repository — the
 * 2026-07-27 partition refused 106 consecutive cycles on it and a retry cured
 * it — so it keeps the retryable `recut-certificate` code. A base that is
 * present and still not an ancestor is a lineage the authoritative base never
 * took: no retry can make it ancestral, only a fresh revision can, so it gets
 * its own `recut-base-diverged` code that parks the PR on the first refusal
 * instead of storming the queue head.
 */
async function recutBaseMovement(git: Git, repo: string, pr: StepExecution["prs"][number]): Promise<RecutBaseMovement> {
  const baseSha = pr.recut?.baseSha
  if (baseSha === undefined) {
    return candidateFailure(
      "recut-certificate",
      `PR '${pr.id}' recut revision ${pr.revision} has no immutable certified base`,
    )
  }
  const head = await git.commit(repo, "HEAD")
  if (head === baseSha) return { status: "moved", moved: false, baseSha, head }
  if (!(await isAncestor(git, repo, baseSha, head))) {
    if ((await git.optionalCommit(repo, baseSha)) !== baseSha) {
      return candidateFailure(
        "recut-certificate",
        `PR '${pr.id}' recut base '${baseSha}' is not present in the candidate repository; fetch it and retry`,
      )
    }
    return candidateFailure(
      "recut-base-diverged",
      `PR '${pr.id}' revision ${pr.revision} certifies base '${baseSha}', but the authoritative candidate base is ` +
        `'${head}', which never descended from it; the certificate cannot become valid without a fresh revision`,
    )
  }
  return { status: "moved", moved: true, baseSha, head }
}

async function verifyRecutCertificate(
  git: Git,
  repo: string,
  pr: StepExecution["prs"][number],
): Promise<CandidateFailure | undefined> {
  if (pr.recut === undefined) return undefined
  const sourceBaseSha = pr.recut.sourceBaseSha
  const sourceHeadSha = pr.recut.sourceHeadSha
  if (pr.recut.certificate === undefined && sourceBaseSha === undefined && sourceHeadSha === undefined) {
    return verifyLegacyRecutCertificate(git, repo, pr)
  }
  if (pr.recut.certificate !== "frozen-code-carrier-v1" || sourceBaseSha === undefined || sourceHeadSha === undefined) {
    return candidateFailure(
      "recut-certificate",
      `PR '${pr.id}' recut revision ${pr.revision} has no complete immutable source range`,
    )
  }
  return verifyFrozenCodeCarrierCertificate(
    createGit(git.process, git.env, { noLazyFetch: true }),
    repo,
    pr,
    sourceBaseSha,
    sourceHeadSha,
  )
}

async function verifyLegacyRecutCertificate(
  git: Git,
  repo: string,
  pr: StepExecution["prs"][number],
): Promise<CandidateFailure | undefined> {
  if (pr.recut === undefined) return undefined
  const treeSha = (await git.run(repo, ["rev-parse", `${pr.headSha}^{tree}`], true)).stdout
  if (treeSha !== pr.recut.treeSha) {
    return candidateFailure(
      "recut-certificate",
      `PR '${pr.id}' recut tree certificate does not match revision ${pr.revision}`,
    )
  }
  const movement = await recutBaseMovement(git, repo, pr)
  if (movement.status === "failed") return movement
  if (!movement.moved) {
    const patchId = await git.stablePatchId(repo, movement.baseSha, pr.headSha)
    return patchId === pr.recut.patchId
      ? undefined
      : candidateFailure(
          "recut-certificate",
          `PR '${pr.id}' recut patch certificate does not match revision ${pr.revision}`,
        )
  }
  const rederived = await rederiveRecutPatchId(git, repo, pr.headSha)
  if (rederived === undefined) {
    return candidateFailure(
      "recut-certificate",
      `PR '${pr.id}' recut could not be mechanically re-anchored onto the advanced base for revision ${pr.revision}`,
    )
  }
  return rederived === pr.recut.patchId
    ? undefined
    : candidateFailure(
        "recut-certificate",
        `PR '${pr.id}' recut change did not survive the advanced base for revision ${pr.revision}`,
      )
}

async function rederiveRecutPatchId(git: Git, repo: string, headSha: string): Promise<string | undefined> {
  const merged = await git.run(repo, ["merge-tree", "--write-tree", "HEAD", headSha], true)
  if (merged.code !== 0) return undefined
  const tree = merged.stdout.split("\n")[0]?.trim()
  if (tree === undefined || !/^[0-9a-f]{40,64}$/iu.test(tree)) return undefined
  return git.stablePatchId(repo, "HEAD", tree)
}

async function verifyFrozenCodeCarrierCertificate(
  git: Git,
  repo: string,
  pr: StepExecution["prs"][number],
  sourceBaseSha: string,
  sourceHeadSha: string,
): Promise<CandidateFailure | undefined> {
  const recut = pr.recut
  if (recut === undefined) return undefined
  const candidateBaseSha = recut.baseSha
  if (candidateBaseSha === undefined) {
    return candidateFailure(
      "recut-certificate",
      `PR '${pr.id}' recut revision ${pr.revision} has no immutable candidate base`,
    )
  }
  const proof = await deriveFrozenCodeCarrier(
    git,
    repo,
    { baseSha: sourceBaseSha, headSha: sourceHeadSha },
    { baseSha: candidateBaseSha, headSha: pr.headSha },
  )
  if ("kind" in proof) {
    if (proof.kind === "commit-missing") {
      return candidateFailure(
        "recut-certificate",
        `PR '${pr.id}' recut ${String(proof.range)} ${String(proof.endpoint)} '${String(proof.sha)}' is missing for revision ${pr.revision}`,
      )
    }
    if (proof.kind === "lineage") {
      const range =
        proof.range === "source"
          ? { baseSha: sourceBaseSha, headSha: sourceHeadSha }
          : { baseSha: candidateBaseSha, headSha: pr.headSha }
      return candidateFailure(
        "recut-certificate",
        `PR '${pr.id}' recut ${String(proof.range)} base '${range.baseSha}' is not an ancestor of ${String(proof.range)} head '${range.headSha}'`,
      )
    }
    if (proof.kind === "gitlinks") {
      const paths = proof.paths ?? []
      const workflow = await intentSubmissionWorkflow(git, repo, candidateBaseSha, pr.headSha, paths, pr.issue)
      return candidateFailure(
        "authored-gitlink",
        `PR '${pr.id}' changes generated-only gitlinks [${paths.join(", ")}]; ${workflow}`,
        ".",
        paths,
      )
    }
    if (proof.kind === "tree") {
      return candidateFailure(
        "recut-certificate",
        `PR '${pr.id}' recut tree certificate does not match candidate revision ${pr.revision}`,
      )
    }
    if (proof.kind === "patch-id") {
      return candidateFailure(
        "recut-certificate",
        `PR '${pr.id}' recut patch certificate does not match immutable source revision ${pr.revision}`,
      )
    }
    return candidateFailure(
      "recut-certificate",
      `PR '${pr.id}' recut source and candidate path, mode, blob, or status identities differ for revision ${pr.revision}`,
    )
  }
  if (proof.treeSha !== recut.treeSha) {
    return candidateFailure(
      "recut-certificate",
      `PR '${pr.id}' recut tree certificate does not match candidate revision ${pr.revision}`,
    )
  }
  return proof.patchId === recut.patchId
    ? undefined
    : candidateFailure(
        "recut-certificate",
        `PR '${pr.id}' recut patch certificate does not match immutable source revision ${pr.revision}`,
      )
}

async function verifyComposedRecutCertificate(
  git: Git,
  repo: string,
  pr: StepExecution["prs"][number],
  rewrites: readonly SourceRewrite[],
  baseMoved: boolean,
): Promise<CandidateFailure | undefined> {
  if (pr.recut === undefined) return undefined
  const patchId = compositionPatchId(rewrites)
  if (!baseMoved) {
    // Fast path: base unchanged — both the recomposed whole-root tree and the
    // base-independent source-patch identity must replay exactly.
    const treeSha = (await git.run(repo, ["rev-parse", "HEAD^{tree}"], true)).stdout
    return treeSha === pr.recut.treeSha && patchId === pr.recut.patchId
      ? undefined
      : candidateFailure(
          "recut-certificate",
          `PR '${pr.id}' recomposed patch/tree certificate does not match revision ${pr.revision}`,
        )
  }
  // Base advanced: the whole-root treeSha legitimately differs (the base moved), so certify
  // the base-independent composite source patch identity instead. composePR already re-derived
  // the source rewrites onto the current base; their identity must equal the reviewed one.
  return patchId === pr.recut.patchId
    ? undefined
    : candidateFailure(
        "recut-certificate",
        `PR '${pr.id}' recomposed change did not survive the advanced base for revision ${pr.revision}`,
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

async function intentSubmissionWorkflow(
  git: Git,
  repo: string,
  baseSha: string,
  headSha: string,
  paths: readonly string[],
  issue = "<issue-ref>",
): Promise<string> {
  const steps = await Promise.all(
    paths.map(async (component) => {
      const previous = await readGitlink(git, repo, baseSha, component)
      const target = await readGitlink(git, repo, headSha, component)
      if (previous === undefined) {
        return (
          `component '${component}' is a new component; pin intents advance existing components only; ` +
          "authorize the component-model addition before using yrd intent submit"
        )
      }
      if (target === undefined) {
        return (
          `component '${component}' is deleted; pin intents advance existing components only; ` +
          "restore it or authorize the component-model deletion separately; yrd intent submit cannot express deletion"
        )
      }
      return `submit pin work as 'yrd intent submit --component ${component} --target ${target} --issue ${issue}'`
    }),
  )
  return steps.join("; ")
}

function componentIntentWorkflow(): string {
  return "submit each component advance with 'yrd intent submit --component <path> --target <sha> --issue <issue-ref>'; Queue owns the root carrier"
}

type BaseContainment =
  | Readonly<{ status: "contained" }>
  | Readonly<{ status: "drops-landed"; commits: string }>
  | Readonly<{ status: "inspection-failed"; detail: string }>

/** A stale carrier may merge cleanly while omitting commits already on the
 * authoritative base. Conflict detection cannot witness that silent revert;
 * derive the missing commits from Git ancestry before attempting the merge. */
async function inspectBaseContainment(
  git: Git,
  repo: string,
  authoritativeBase: string,
  carrierHead: string,
): Promise<BaseContainment> {
  const contains = await git.run(repo, ["merge-base", "--is-ancestor", authoritativeBase, carrierHead], true)
  if (contains.code === 0) return { status: "contained" }
  if (contains.code !== 1) {
    return {
      status: "inspection-failed",
      detail: contains.stderr || contains.stdout || "git merge-base failed",
    }
  }

  // Post-landing actuator retries intentionally carry a head already contained
  // by current main. They cannot remove current-base commits and remain safe.
  const alreadyLanded = await git.run(repo, ["merge-base", "--is-ancestor", carrierHead, authoritativeBase], true)
  if (alreadyLanded.code === 0) return { status: "contained" }
  if (alreadyLanded.code !== 1) {
    return {
      status: "inspection-failed",
      detail: alreadyLanded.stderr || alreadyLanded.stdout || "git merge-base failed",
    }
  }

  const dropped = await git.run(
    repo,
    ["log", "--oneline", "--no-decorate", `${carrierHead}..${authoritativeBase}`],
    true,
  )
  if (dropped.code !== 0 || dropped.stdout === "") {
    return {
      status: "inspection-failed",
      detail: dropped.stderr || dropped.stdout || "git log found no base-only commits",
    }
  }
  return { status: "drops-landed", commits: dropped.stdout }
}

function linearRebuildRemedy(scope: string, base: string): string {
  return `linear rebuild required: rebuild ${scope} as a one-parent linear branch on current base '${base}', then recut and requeue the root branch`
}

/** Resolve the component checkout that can answer ancestry for a gitlink path.
 *
 * `join(root, path)` alone is not enough, and failing silently here is how this
 * check first went wrong: an uninitialized submodule directory still exists, so
 * every `git -C` against it walks UP and is answered by the superproject, which
 * knows none of the component's shas. It reports "not an ancestor" for a pin
 * that plainly is one. The toplevel comparison is what makes the wrong repo
 * loud instead of merely wrong. */
async function componentCheckout(git: Git, root: string, path: string): Promise<string | undefined> {
  const component = join(root, path)
  const toplevel = await git.run(component, ["rev-parse", "--show-toplevel"], true)
  if (toplevel.code !== 0 || toplevel.stdout === "") return undefined
  try {
    return (await realpath(toplevel.stdout)) === (await realpath(component)) ? component : undefined
  } catch {
    // silent-fallback-allow: the declared contract is `string | undefined`, and
    // undefined means "this path is not its own component checkout". The line
    // above already returns undefined for the resolvable-but-not-a-checkout
    // case, so the catch is the same answer for the unresolvable one. Declining
    // to name a checkout is the safe direction; the caller treats absence as
    // "no component here" rather than assuming one.
    return undefined
  }
}

/** Head staleness and payload spentness are different facts about a carrier, and
 * a gitlink-only carrier can carry both at once: root main moved on beneath it
 * (stale head) while the pin it authors was already promoted into that same
 * main by some other carrier.
 *
 * The head check can only witness the first, so on its own it prescribes a
 * linear rebuild — advice that cannot succeed here, because rebuilding a spent
 * pin onto current base regenerates an empty carrier that is refused again on
 * the same ground. That is the loop PR562 rode to revision 43.
 *
 * The pair is authored pin against THE PIN THE AUTHORITATIVE BASE CARRIES, which
 * is the containment `absorbedAuthoredGitlinks` already calls absorbed. Reading
 * it against component main instead answers a different question and gets this
 * exactly backwards: component main can hold the work while root main's gitlink
 * still points before it, and that carrier is the one that would perform the
 * promotion. Measured — with root's gitlink behind, a rebuild still delivers the
 * gitlink; with root's gitlink containing the pin, it delivers nothing. Only the
 * second is safe to close. */
async function spentGitlinkCarrier(
  git: Git,
  repo: string,
  candidate: string,
  headSha: string,
  authoritativeBase: string,
): Promise<Readonly<{ landings: readonly string[] }> | undefined> {
  const forkPoint = await git.run(candidate, ["merge-base", authoritativeBase, headSha], true)
  if (forkPoint.code !== 0 || forkPoint.stdout === "") return undefined
  const authored = await changedPaths(git, candidate, forkPoint.stdout, headSha)
  if (authored.length === 0) return undefined

  const landings: string[] = []
  for (const path of authored) {
    // A path that is not a gitlink on both sides carries payload this verdict
    // cannot speak for, so the carrier is not pins-only.
    const carrierPin = await readGitlink(git, candidate, headSha, path)
    const basePin = await readGitlink(git, candidate, authoritativeBase, path)
    if (carrierPin === undefined || basePin === undefined) return undefined
    if (carrierPin === basePin) {
      landings.push(`pin '${carrierPin}' for '${path}' is the pin the base already carries`)
      continue
    }
    // Below this line every failure keeps the existing refusal rather than
    // upgrading the verdict: an unprovable claim of spentness is not a reason to
    // tell an author their work landed. Only the component can answer ancestry
    // between two component shas.
    const component = await componentCheckout(git, repo, path)
    if (component === undefined) return undefined
    if (!(await isAncestor(git, component, carrierPin, basePin))) return undefined
    landings.push(`pin '${carrierPin}' for '${path}' is already contained in the base's pin '${basePin}'`)
  }
  return { landings }
}

async function carrierDropsLandedFailure(
  git: Git,
  repo: string,
  candidate: string,
  pr: string,
  headSha: string,
  authoritativeBase: string,
): Promise<CandidateFailure | undefined> {
  const containment = await inspectBaseContainment(git, candidate, authoritativeBase, headSha)
  if (containment.status === "contained") return undefined
  if (containment.status === "inspection-failed") {
    return candidateFailure(
      "carrier-inspection",
      `could not compare root branch '${headSha}' for merge request '${pr}' with the merge-queue base '${authoritativeBase}': ${containment.detail}`,
    )
  }
  const spent = await spentGitlinkCarrier(git, repo, candidate, headSha, authoritativeBase)
  if (spent !== undefined) {
    return candidateFailure(
      "carrier-pin-already-landed",
      `merge request '${pr}' branch '${headSha}' authors component pins only, and every one of them already landed: ${spent.landings.join("; ")}\nremedy: the branch has nothing left to deliver; close it, do not rebuild or requeue it`,
    )
  }
  return candidateFailure(
    "carrier-drops-landed",
    `merge request '${pr}' branch '${headSha}' does not contain the merge-queue base '${authoritativeBase}' and would drop merged commits:\n${containment.commits}\nremedy: ${linearRebuildRemedy("the branch", authoritativeBase)}`,
  )
}

/** A deletion is the one merge outcome nothing announces. Every guard above this
 * one asks whether the carrier CONTAINS the base; the residual case is a carrier
 * that does contain it and erases a landing anyway, cleanly, with no conflict.
 *
 * It happens when the carrier and the base have MORE THAN ONE merge base — the
 * criss-cross any re-merged or hand-resolved carrier can produce. `ort` then
 * resolves against a VIRTUAL base built from all of them, and that virtual tree
 * can hold a path the single `git merge-base` answer does not. `authoredDeltaBase`
 * measures the carrier's authored changes from that single answer, so a deletion
 * resolved against the virtual base appears in no diff the author ever reviewed:
 * ancestry says contained, `merge-tree` says mergeable, `git merge` exits 0, and
 * the landing is gone. Measured on git 2.54 (2026-08-14) with an empty authored
 * deletion set and the landed file missing from the merge result.
 *
 * So compare the two sets. Every path the merge removes from the base must be a
 * path the carrier's own authored diff removes too; anything extra is a rebuild
 * artifact, never a decision someone made. Where the two bases coincide — the
 * single-merge-base case — the check is a tautology and costs two diffs. */
async function unauthoredDeletionFailure(
  git: Git,
  repo: string,
  pr: string,
  headSha: string,
  before: string,
  landed: string,
): Promise<CandidateFailure | undefined> {
  const removed = await deletedPaths(git, repo, before, landed)
  if (removed.length === 0) return undefined
  const base = await authoredDeltaBase((cwd, args) => git.run(cwd, args, true), repo, before, headSha)
  if (base.status === "unreadable") {
    return candidateFailure(
      "deletion-inspection",
      `could not measure the deletions merge request '${pr}' branch '${headSha}' authors against '${before}': ` +
        `${base.detail}; restore readable history before landing a payload that deletes paths`,
    )
  }
  const authored = new Set(await deletedPaths(git, repo, base.sha, headSha))
  const unauthored = removed.filter((path) => !authored.has(path))
  if (unauthored.length === 0) return undefined
  const shown = unauthored.slice(0, 8).join(", ") + (unauthored.length > 8 ? ", …" : "")
  return candidateFailure(
    "unauthored-path-deletion",
    `merging merge request '${pr}' branch '${headSha}' deletes [${shown}], which its authored diff against ` +
      `'${base.sha}' never deletes; the merge resolved away landed work the branch never authored removing\n` +
      `remedy: ${linearRebuildRemedy("the branch", before)}`,
    ".",
    unauthored,
  )
}

async function mergeTipCarrierFailure(
  git: Git,
  repo: string,
  pr: string,
  headSha: string,
  authoritativeBase: string,
): Promise<CandidateFailure | undefined> {
  if (await isAncestor(git, repo, headSha, authoritativeBase)) return undefined
  const lineage = await git.run(repo, ["rev-list", "--parents", "-n", "1", headSha], true)
  if (lineage.code !== 0 || lineage.stdout === "") {
    return candidateFailure(
      "carrier-inspection",
      `could not inspect the root branch tip '${headSha}' for merge request '${pr}': ${lineage.stderr || lineage.stdout || "no lineage"}`,
    )
  }
  const [commit, ...parents] = lineage.stdout.split(/\s+/u)
  if (commit !== headSha) {
    return candidateFailure(
      "carrier-inspection",
      `root branch history for merge request '${pr}' returned '${commit ?? "no commit"}', expected '${headSha}'`,
    )
  }
  return parents.length > 1
    ? candidateFailure(
        "merge-tip-carrier",
        `merge request '${pr}' root branch tip '${headSha}' is a merge commit with ${parents.length} parents; ${componentIntentWorkflow()}`,
      )
    : undefined
}

async function stabilizeGeneratedRootWrapper(
  git: Git,
  path: string,
  before: string,
  message: string,
): Promise<CandidateFailure | undefined> {
  const generated = await git.commit(path, "HEAD")
  if (generated === before) return undefined
  const lineage = await git.run(path, ["rev-list", "--parents", "-n", "1", generated], true)
  const [commit, ...parents] = lineage.stdout.split(/\s+/u)
  if (lineage.code !== 0 || commit !== generated || parents.length < 2) {
    return candidateFailure(
      "wrapper-generation",
      `generated root wrapper '${generated}' has invalid lineage: ${lineage.stderr || lineage.stdout || "no lineage"}`,
    )
  }
  const tree = (await git.run(path, ["rev-parse", `${generated}^{tree}`])).stdout
  const stable = await git.commitTree(path, tree, parents, message)
  const updated = await git.run(path, ["update-ref", "HEAD", stable, generated], true)
  return updated.code === 0
    ? undefined
    : candidateFailure(
        "wrapper-generation",
        `generated root wrapper '${generated}' could not be stabilized: ${updated.stderr || updated.stdout}`,
      )
}

type GitlinkUpdate = Readonly<{ path: string; sha: string }>
type SynthesizedGitlinkWrapper = Readonly<{ commit: string; treeSha: string }>

/**
 * The ONE generated-root implementation shared by composed PRs, pin intents,
 * and the materialize escape hatch. It stages only gitlink entries and writes
 * a byte-stable commit through Git.commitTree's pinned identity and timestamp.
 */
async function synthesizeGitlinkWrapper(
  git: Git,
  path: string,
  parent: string,
  updates: readonly GitlinkUpdate[],
  message: string,
  provisionPinIntent?: PinIntentProvisioner,
): Promise<Readonly<{ status: "passed"; output: SynthesizedGitlinkWrapper }> | CandidateFailure> {
  const expectedPaths = updates.map((update) => update.path)
  for (const update of updates) {
    const staged = await git.run(path, ["update-index", "--cacheinfo", `160000,${update.sha},${update.path}`], true)
    if (staged.code !== 0) {
      return candidateFailure(
        "wrapper-mismatch",
        `generated wrapper could not stage gitlink '${update.path}': ${staged.stderr || staged.stdout}`,
        update.path,
        [update.path],
      )
    }
  }
  if (provisionPinIntent !== undefined && updates.length > 0) {
    if (updates.length !== 1) {
      return candidateFailure(
        "wrapper-mismatch",
        `pin-intent provisioning expected one gitlink update, got [${expectedPaths.join(", ")}]`,
        ".",
        expectedPaths,
      )
    }
    const update = updates[0]
    if (update === undefined) throw new Error("pin-intent provisioning lost its sole gitlink update")
    const provisionalTreeSha = (await git.run(path, ["write-tree"])).stdout
    const provisionalCandidateSha = await git.commitTree(path, provisionalTreeSha, [parent], message)
    const provisioned = await provisionPinIntent({
      path,
      baseSha: parent,
      provisionalCandidateSha,
      component: update.path,
    })
    const generatedPaths = [...new Set(provisioned.generatedPaths)].toSorted()
    const forbidden = generatedPaths.filter((generatedPath) => generatedPath !== "bun.lock")
    if (forbidden.length > 0) {
      return candidateFailure(
        "wrapper-mismatch",
        `pin-intent provisioning generated forbidden path(s) [${forbidden.join(", ")}]; allowed [bun.lock]`,
        ".",
        forbidden,
      )
    }
    for (const generatedPath of generatedPaths) {
      const staged = await git.run(path, ["add", "--", generatedPath], true)
      if (staged.code !== 0) {
        return candidateFailure(
          "wrapper-mismatch",
          `generated wrapper could not stage provisioned '${generatedPath}': ${staged.stderr || staged.stdout}`,
          generatedPath,
          [generatedPath],
        )
      }
    }
    expectedPaths.push(...generatedPaths)
  }
  const materialized = await stagedPaths(git, path)
  if (!samePaths(materialized, expectedPaths)) {
    return candidateFailure(
      "wrapper-mismatch",
      `generated wrapper paths differ: expected [${expectedPaths.join(", ")}], got [${materialized.join(", ")}]`,
      ".",
      symmetricDifference(materialized, expectedPaths),
    )
  }
  const treeSha = (await git.run(path, ["write-tree"])).stdout
  const commit = expectedPaths.length === 0 ? parent : await git.commitTree(path, treeSha, [parent], message)
  if (commit !== parent) {
    const updated = await git.run(path, ["update-ref", "HEAD", commit, parent], true)
    if (updated.code !== 0) {
      return candidateFailure(
        "wrapper-generation",
        `generated wrapper '${commit}' could not replace '${parent}': ${updated.stderr || updated.stdout}`,
      )
    }
  }
  return { status: "passed", output: { commit, treeSha } }
}

const PinIntentCarrierSynthesisInputSchema = z
  .object({
    baseSha: z.string().regex(/^[0-9a-f]{40,64}$/iu),
    component: ComponentPathSchema,
    target: z.string().regex(/^[0-9a-f]{40,64}$/iu),
    issue: z
      .string()
      .trim()
      .min(1)
      .refine((value) => !/[\r\n]/u.test(value), "issue must occupy one line"),
  })
  .strict()

export type PinIntentCarrierSynthesis = Readonly<{
  component: string
  priorPin: string
  target: string
  baseSha: string
  commit: string
  treeSha: string
}>

/** Materialize a PinIntent against one exact root base without moving any
 * authoritative ref. Queue and `yrd intent materialize` both call this. */
export async function synthesizePinIntentCarrier(options: {
  inject: Readonly<{ process: Pick<Process, "run"> }>
  repo: string
  baseSha: string
  component: string
  target: string
  issue: string
  checkoutParent?: string
  env?: NodeJS.ProcessEnv
}): Promise<PinIntentCarrierSynthesis> {
  const input = PinIntentCarrierSynthesisInputSchema.parse({
    baseSha: options.baseSha,
    component: options.component,
    target: options.target,
    issue: options.issue,
  })
  const repo = resolve(options.repo)
  const git = createGit(options.inject.process, options.env)
  const outcome = await withScratch<PinIntentCarrierSynthesis>(
    git,
    repo,
    input.baseSha,
    options.checkoutParent,
    async (path) => {
      const priorPin = await readGitlink(git, path, "HEAD", input.component)
      if (priorPin === undefined) {
        throw createFailure({
          kind: "refusal",
          code: "intent-component-unknown",
          message: `yrd: intent component '${input.component}' is not a gitlink at root base '${input.baseSha}'`,
        })
      }
      const synthesized = await synthesizeGitlinkWrapper(
        git,
        path,
        input.baseSha,
        priorPin === input.target ? [] : [{ path: input.component, sha: input.target }],
        pinIntentCommitMessage(input.component, input.target, input.issue),
      )
      if (synthesized.status === "failed") {
        throw createFailure({ kind: "refusal", code: synthesized.error.code, message: synthesized.error.message })
      }
      return {
        status: "completed",
        conclusion: "success",
        output: {
          component: input.component,
          priorPin,
          target: input.target,
          baseSha: input.baseSha,
          ...synthesized.output,
        },
      }
    },
  )
  if (outcome.status === "completed" && outcome.conclusion === "success") return outcome.output
  throw new Error("yrd: pin-intent branch synthesis did not complete")
}

function pinIntentCommitMessage(component: string, target: string, issue: string): string {
  return `chore(${component.split("/").at(-1) ?? component}): advance pin to ${target.slice(0, 12)} [${issue}]`
}

/** Marks a queue-synthesized wrapper commit as the synthesis act rather than the change itself.
 *
 * Derived from the change identity, so it needs no second minting function and stays
 * reconstructable from the Change-Id alone. Git matches a trailer key whole, so this never
 * widens what `%(trailers:key=Change-Id)` returns to the ancestry proof.
 */
function mergeChangeIdFor(operation: "compose" | "merge", changeId: string): string {
  return `${changeId}-${operation}`
}

function candidateChangeCommitMessage(operation: "compose" | "merge", pr: StepExecution["prs"][number]): string {
  const subject = `yrd: ${operation} ${pr.id} revision ${String(pr.revision)}`
  if (pr.changeId === undefined) return subject
  return `${subject}\n\nChange-Id: ${pr.changeId}\nMerge-Change-Id: ${mergeChangeIdFor(operation, pr.changeId)}`
}

async function composePR(
  git: Git,
  repo: string,
  path: string,
  pr: StepExecution["prs"][number],
  localSourceTips?: ReadonlySet<string>,
): Promise<Readonly<{ status: "passed"; output: readonly SourceRewrite[] }> | CandidateFailure> {
  if (!(await isAncestor(git, path, pr.headSha, "HEAD"))) {
    return candidateFailure(
      "composition-invalid",
      `PR '${pr.id}' composition head '${pr.headSha}' contains root changes; root code must be submitted separately from component pin intents`,
    )
  }

  const rewrites: SourceRewrite[] = []
  const updates: GitlinkUpdate[] = []
  for (const source of pr.composition?.sources ?? []) {
    const currentPin = await readGitlink(git, path, "HEAD", source.repo)
    if (currentPin === undefined) {
      return candidateFailure(
        "composition-invalid",
        `PR '${pr.id}' source '${source.repo}' is not a gitlink in the authoritative root base; pin intents advance existing components only`,
        source.repo,
        [source.repo],
      )
    }
    const prepared = await prepareSource(git, repo, source, currentPin, localSourceTips?.has(source.repo) === true)
    if (prepared.status === "failed") return prepared
    rewrites.push(prepared.output)
    if (prepared.output.newTipSha === currentPin) continue
    updates.push({ path: source.repo, sha: prepared.output.newTipSha })
  }

  const parent = await git.commit(path, "HEAD")
  const synthesized = await synthesizeGitlinkWrapper(
    git,
    path,
    parent,
    updates,
    candidateChangeCommitMessage("compose", pr),
  )
  if (synthesized.status === "failed") return synthesized
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
  allowLocalTip = false,
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
  if (!allowLocalTip) {
    const fetched = await git.run(
      sourceRepo,
      ["-c", "protocol.file.allow=always", "fetch", "--no-recurse-submodules", "--quiet", "origin", source.branch],
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
  const published = await publishSourceCandidate(git, sourceRepo, source.repo, newTipSha)
  if (published.status === "failed") return published
  const candidateRef = published.output
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

async function publishSourceCandidate(
  git: Git,
  sourceRepo: string,
  repoPath: string,
  tipSha: string,
): Promise<Readonly<{ status: "passed"; output: string }> | CandidateFailure> {
  const candidateRef = sourceCandidateRef(tipSha)
  const pinned = await git.run(
    sourceRepo,
    ["update-ref", "--create-reflog", candidateRef, tipSha, "0".repeat(tipSha.length)],
    true,
  )
  if (pinned.code !== 0 && (await git.optionalCommit(sourceRepo, candidateRef)) !== tipSha) {
    return candidateFailure(
      "source-publish",
      `source '${repoPath}' candidate ref could not be pinned: ${pinned.stderr || pinned.stdout}`,
    )
  }
  try {
    const published = await pushRefUpdates({
      root: sourceRepo,
      git: adaptProcessGit(git.process, { env: git.env, timeoutMs: GIT_TIMEOUT_MS }),
      timeoutMs: GIT_TIMEOUT_MS,
      verify: false,
      updates: [
        {
          repository: sourceRepo,
          remote: "origin",
          source: tipSha,
          destination: candidateRef,
          expectedDestination: { state: "missing" },
        },
      ],
    })
    if (published.state !== "updated" && published.state !== "unchanged") {
      throw new Error(gitSuperFailureDetail(published)?.message ?? `publication ended as ${published.state}`)
    }
  } catch (cause) {
    return candidateFailure(
      "source-publish",
      `source '${repoPath}' candidate '${tipSha}' could not be published: ${messageOf(cause)}`,
    )
  }
  return { status: "passed", output: candidateRef }
}

async function rebaseSource(
  git: Git,
  sourceRepo: string,
  source: NonNullable<StepExecution["prs"][number]["composition"]>["sources"][number],
  currentPin: string,
): Promise<Readonly<{ status: "passed"; output: string }> | CandidateFailure> {
  return withScratchRoot(git, sourceRepo, "yrd-source-", undefined, (root) =>
    rebaseSourceIn(git, sourceRepo, source, currentPin, root),
  )
}

async function rebaseSourceIn(
  git: Git,
  sourceRepo: string,
  source: NonNullable<StepExecution["prs"][number]["composition"]>["sources"][number],
  currentPin: string,
  root: string,
): Promise<Readonly<{ status: "passed"; output: string }> | CandidateFailure> {
  const worktrees = createGitWorktreeStore({
    repo: sourceRepo,
    git,
    timeouts: { operation: GIT_TIMEOUT_MS, cleanup: GIT_CLEANUP_TIMEOUT_MS },
  })
  const path = join(root, "worktree")
  let added = false
  let outcome: Readonly<{ status: "passed"; output: string }> | CandidateFailure | undefined
  let operationFailure: unknown
  try {
    await worktrees.add({
      kind: "detached",
      path,
      ref: source.tipSha,
      operation: `Queue source ${source.repo} worktree add`,
    })
    added = true
    const result = await git.run(
      path,
      [
        "-c",
        "user.name=Yrd Queue",
        "-c",
        "user.email=yrd-queue@example.invalid",
        "-c",
        "core.editor=true",
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
    try {
      await worktrees.remove(path, { operation: `Queue source ${source.repo} worktree remove` })
    } catch (cause) {
      cleanupFailure = messageOf(cause)
    }
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

type GitlinkRefusalCode = "recut-gitlink-conflict" | "recut-gitlink-object-missing" | "recut-gitlink-uninitialized"

type GitlinkFastForward =
  | Readonly<{ kind: "resolved"; side: "carrier" | "base"; sha: string }>
  | Readonly<{
      kind: "refuse"
      code: GitlinkRefusalCode
      path: string
      basePin: string
      authoredPin: string
      message: string
    }>
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
      code: "recut-gitlink-uninitialized",
      path,
      basePin: ours,
      authoredPin: theirs,
      message: `submodule '${path}' is not initialized locally; run git submodule update --init and retry`,
    }
  }
  for (const oid of [ours, theirs]) {
    const present = await git.run(submodule, ["cat-file", "-e", `${oid}^{commit}`], true)
    if (present.code !== 0) {
      return {
        kind: "refuse",
        code: "recut-gitlink-object-missing",
        path,
        basePin: ours,
        authoredPin: theirs,
        message: `submodule '${path}' commit '${oid}' is not present in its local store; fetch it and retry`,
      }
    }
  }
  if (await isAncestor(git, submodule, ours, theirs)) return { kind: "resolved", side: "carrier", sha: theirs }
  if (await isAncestor(git, submodule, theirs, ours)) return { kind: "resolved", side: "base", sha: ours }
  return {
    kind: "refuse",
    code: "recut-gitlink-conflict",
    path,
    basePin: ours,
    authoredPin: theirs,
    message: "neither submodule commit is an ancestor of the other",
  }
}

/**
 * Resolve a transient gitlink conflict from the authored range by proving the
 * transition that actually lands: the authoritative target pin must be an
 * ancestor of the authored root's final pin. This is the merge-aware sibling
 * of the ordinary pairwise resolver. It deliberately ignores the conflicting
 * intermediate pin only after the local submodule store proves the final pin
 * contains the scratch side; missing objects, non-gitlinks, reverse moves, and
 * true final divergence remain owned by the original loud refusal.
 */
async function resolveGitlinkByFinalPin(
  git: Git,
  repo: string,
  worktree: string,
  path: string,
  targetSha: string,
  authoredHead: string,
): Promise<GitlinkFastForward | undefined> {
  const stages = await readGitlinkConflictStages(git, worktree, path)
  if (stages === undefined) return undefined
  const authoritativePin = await readGitlink(git, repo, targetSha, path)
  const finalPin = await readGitlink(git, repo, authoredHead, path)
  if (authoritativePin === undefined || finalPin === undefined || finalPin === authoritativePin) return undefined
  const submodule = join(repo, path)
  try {
    await realpath(submodule)
  } catch {
    // silent-fallback-allow: an unmaterialized submodule cannot prove a gitlink fast-forward resolution.
    return undefined
  }
  for (const oid of [authoritativePin, finalPin]) {
    if ((await git.run(submodule, ["cat-file", "-e", `${oid}^{commit}`], true)).code !== 0) return undefined
  }
  return (await isAncestor(git, submodule, authoritativePin, finalPin))
    ? { kind: "resolved", side: "carrier", sha: finalPin }
    : undefined
}

/**
 * Post-rebase classification of carrier gitlinks that git fast-forwarded
 * WITHOUT a conflict (21461) — the silent sibling of resolveGitlinkFastForward's
 * "carrier" verdict, proved with the same primitive (ancestry in the
 * submodule's local store). A path in `overlap` is classified into `into` only
 * when ALL of:
 *  - the recut materialized exactly the authored end pin (git picked the
 *    carrier side),
 *  - the base actually advanced the from-side pin (the asymmetry that would
 *    otherwise fail the strict patch-id certificate), and
 *  - the target pin is an ancestor of the authored pin in the submodule's
 *    local store (the same fast-forward legitimacy proof the conflict path
 *    demands).
 * Anything unprovable — no gitlink at one of the four corners, a missing
 * submodule checkout or object, unrelated pins — is left UNCLASSIFIED so the
 * strict certificate keeps owning it; this function never widens what a
 * conflict-time "carrier" classification could have admitted.
 */
async function classifyAutoFastForwardedCarrierGitlinks(
  git: Git,
  repo: string,
  scratch: string,
  args: Readonly<{
    overlap: readonly string[]
    skip: ReadonlySet<string>
    sourceBase: string
    targetSha: string
    authoredHead: string
    recutHead: string
    into: Set<string>
  }>,
): Promise<void> {
  for (const gitlink of args.overlap) {
    if (args.into.has(gitlink) || args.skip.has(gitlink)) continue
    const authoredPin = await readGitlink(git, repo, args.authoredHead, gitlink)
    if (authoredPin === undefined) continue
    const materializedPin = await readGitlink(git, scratch, args.recutHead, gitlink)
    if (materializedPin !== authoredPin) continue
    const sourcePin = await readGitlink(git, repo, args.sourceBase, gitlink)
    const targetPin = await readGitlink(git, repo, args.targetSha, gitlink)
    if (sourcePin === undefined || targetPin === undefined) continue
    if (targetPin === sourcePin || targetPin === authoredPin) continue
    const submodule = join(repo, gitlink)
    try {
      await realpath(submodule)
    } catch {
      continue
    }
    let present = true
    for (const oid of [targetPin, authoredPin]) {
      if ((await git.run(submodule, ["cat-file", "-e", `${oid}^{commit}`], true)).code !== 0) {
        present = false
        break
      }
    }
    if (!present) continue
    if (await isAncestor(git, submodule, targetPin, authoredPin)) args.into.add(gitlink)
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
  const result = await git.run(repo, ["diff", ...CERTIFICATE_DIFF_OPTIONS, "--name-only", "-z", from, to, "--"])
  return nulPaths(result.stdout)
}

/** `CERTIFICATE_DIFF_OPTIONS` carries `--no-renames` on purpose here: rename
 * detection is heuristic and `diff.renameLimit`-dependent, so with it on, the
 * same tree pair can report a path as renamed in one diff and deleted in the
 * other, and the comparison would drift with repository size. Path level only. */
async function deletedPaths(git: Git, repo: string, from: string, to: string): Promise<string[]> {
  const result = await git.run(repo, [
    "diff",
    ...CERTIFICATE_DIFF_OPTIONS,
    "--diff-filter=D",
    "--name-only",
    "-z",
    from,
    to,
    "--",
  ])
  return nulPaths(result.stdout)
}

async function changedPayloadIdentity(
  git: Git,
  repo: string,
  from: string,
  to: string,
  paths?: readonly string[],
): Promise<string> {
  return (
    await git.run(repo, [
      "diff",
      ...CERTIFICATE_DIFF_OPTIONS,
      "--raw",
      "--no-abbrev",
      "-z",
      from,
      to,
      "--",
      ...(paths ?? []),
    ])
  ).stdout
}

/**
 * Certify every ordered non-gitlink patch after removing paths whose final pin
 * was independently ancestry-certified. Intermediate gitlink slots are not a
 * delivery fact: a branch may merge two sibling submodule histories and land their
 * common descendant, as PR928 did. The caller has already proved exact final
 * pins plus aggregate payload identity, so this sequence owns only the ordered
 * ordinary patches. Merge wrapper commits are skipped; any tree effect unique
 * to a merge remains covered by the aggregate certificate above.
 */
async function certifiedPatchSequence(
  git: Git,
  repo: string,
  from: string,
  to: string,
  absorbedPaths: readonly string[],
  ffGitlinks: readonly string[],
): Promise<readonly string[] | undefined> {
  const commitsResult = await git.run(repo, ["rev-list", "--reverse", "--topo-order", `${from}..${to}`], true)
  if (commitsResult.code !== 0) return undefined

  const excludedPaths = [...new Set([...absorbedPaths, ...ffGitlinks])].toSorted()
  const pathspec = [".", ...excludedPaths.map((path) => `:(top,literal,exclude)${path}`)]
  const slots: string[] = []
  for (const commit of commitsResult.stdout.split(/\r?\n/u).filter((candidate) => candidate !== "")) {
    const lineage = await git.run(repo, ["rev-list", "--parents", "-n", "1", commit], true)
    if (lineage.code !== 0) return undefined
    const [, ...parents] = lineage.stdout.split(" ")
    if (parents.length !== 1) continue
    const parent = parents[0]
    if (parent === undefined) return undefined
    const changed = await git.run(
      repo,
      ["diff", ...CERTIFICATE_DIFF_OPTIONS, "--quiet", parent, commit, "--", ...pathspec],
      true,
    )
    if (changed.code !== 0 && changed.code !== 1) return undefined
    const patchId = changed.code === 0 ? undefined : await git.stablePatchId(repo, parent, commit, pathspec)
    if (changed.code === 1 && patchId === undefined) return undefined
    if (patchId !== undefined) slots.push(patchId)
  }
  return slots
}

/**
 * `<mode> <type> <object>` per requested path at `ref`, or `undefined` when the
 * tree could not be read exactly. A path missing from the map is a fact the
 * caller may reason about (the tree has no such entry); an undefined map is
 * indeterminacy and must never be read as one. Any unparseable record fails the
 * whole read rather than silently narrowing it.
 */
async function readTreeEntries(
  git: Git,
  repo: string,
  ref: string,
  paths: readonly string[],
): Promise<Map<string, string> | undefined> {
  const result = await git.run(repo, ["ls-tree", "-z", ref, "--", ...paths], true)
  if (result.code !== 0) return undefined
  const entries = new Map<string, string>()
  for (const record of result.stdout.split("\0")) {
    if (record === "") continue
    const header = /^([0-7]{6} [a-z]+ [0-9a-f]{40,64})\t/u.exec(record)
    const entry = header?.[1]
    if (header === null || entry === undefined) return undefined
    entries.set(record.slice(header[0].length), entry)
  }
  return entries
}

/**
 * Payload paths the authoritative base already carries in exactly the authored
 * end state — the ordinary-file sibling of `absorbedAuthoredGitlinks`.
 *
 * A rebase onto such a base drops those commits as patch-equivalent, which is
 * correct and complete: every byte the author wrote for that path is already
 * on the base. Without this the recut compares a payload recorded against the
 * OLD base with what materialized against the NEW one and refuses for the
 * difference it just created by being right (22373, PR1646).
 *
 * The proof is the delivered end state, not the commit shape: the base's tree
 * entry for the path is identical to the authored head's (same mode, same
 * object, or absent on both sides for a delete the base also landed). Callers
 * pass only paths already known to be in both the payload and the base's own
 * authority range, so an equal entry means the base moved that path to exactly
 * where the author left it. Anything unprovable stays in the expected payload,
 * where a vanished path still refuses — the failure mode of this proof is a
 * loud refusal, never a silent drop.
 */
async function absorbedAuthoredPaths(
  git: Git,
  repo: string,
  sourceHead: string,
  target: string,
  overlaps: readonly string[],
  gitlinks: ReadonlySet<string>,
): Promise<string[]> {
  const candidates = overlaps.filter((path) => !gitlinks.has(path))
  if (candidates.length === 0) return []
  const authored = await readTreeEntries(git, repo, sourceHead, candidates)
  const current = await readTreeEntries(git, repo, target, candidates)
  if (authored === undefined || current === undefined) return []
  return candidates.filter((path) => authored.get(path) === current.get(path))
}

/**
 * The recut result for a branch whose every authored path the base already
 * landed. There is nothing left to deliver, so the recut head IS the base: the
 * merge step then proves already-landed from candidate/base tree equality and
 * closes the PR, instead of the drain wedging on a `payload-mismatch … got []`
 * that an operator has to withdraw by hand (22373). The recorded identity stays
 * the authored patch id — the patch this revision delivers, which the base now
 * carries — so a repeated recut is idempotent.
 */
async function absorbedRecutResult(
  git: Git,
  repo: string,
  target: GitQueueTarget,
  input: PRRecutInput,
  sourceBase: string,
): Promise<PRRecutResult> {
  const patchId = await git.stablePatchId(repo, sourceBase, input.headSha)
  if (patchId === undefined) {
    throw createFailure({
      kind: "refusal",
      code: "payload-certificate",
      message: `yrd: PR '${input.id}' revision ${input.revision} has no stable patch identity`,
    })
  }
  return {
    headSha: target.sha,
    baseSha: target.sha,
    treeSha: (await git.run(repo, ["rev-parse", `${target.sha}^{tree}`])).stdout,
    patchId,
    unchanged: false,
  }
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
    const rows = cherry.stdout.split(/\r?\n/u).filter((row) => row !== "")
    if (cherry.code === 0 && rows.length === count && rows.every((row) => /^- [0-9a-f]{40,64}$/iu.test(row))) {
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

async function usesUnionMerge(git: Git, repo: string, ref: string, paths: readonly string[]): Promise<boolean> {
  const result = await git.run(repo, ["check-attr", "-z", "--source", ref, "merge", "--", ...paths], true)
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

type UnionBlob = Readonly<{ mode: "100644" | "100755"; content: string }>

async function readUnionBlob(git: Git, repo: string, ref: string, path: string): Promise<UnionBlob | undefined> {
  const tree = await git.raw(repo, ["ls-tree", "-z", ref, "--", path], true)
  if (tree.code !== 0 || tree.stdout === "") return undefined
  const tab = tree.stdout.indexOf("\t")
  const match = /^(100644|100755) blob ([0-9a-f]{40,64})$/u.exec(tree.stdout.slice(0, tab))
  const mode = match?.[1] as UnionBlob["mode"] | undefined
  const oid = match?.[2]
  const end = tree.stdout.indexOf("\0", tab + 1)
  const recordPath = tree.stdout.slice(tab + 1, end === -1 ? undefined : end)
  if (tab === -1 || mode === undefined || oid === undefined || recordPath !== path) return undefined
  const blob = await git.raw(repo, ["cat-file", "blob", oid], true)
  if (blob.code !== 0) return undefined
  const roundTrip = await git.process.run({
    argv: ["git", "-C", repo, "hash-object", "--stdin"],
    cwd: repo,
    env: git.env,
    stdin: blob.stdout,
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (roundTrip.timedOut) throw new Error(`yrd: git hash-object --stdin timed out after ${GIT_TIMEOUT_MS}ms`)
  if (roundTrip.exitCode !== 0 || roundTrip.stdout.trim() !== oid) return undefined
  return { mode, content: blob.stdout }
}

function mergedUnionMode(
  base: UnionBlob["mode"],
  current: UnionBlob["mode"],
  authored: UnionBlob["mode"],
): UnionBlob["mode"] | undefined {
  if (current === authored) return current
  if (current === base) return authored
  if (authored === base) return current
  return undefined
}

async function matchesExpectedUnionMerge(
  git: Git,
  repo: string,
  baseRef: string,
  currentRef: string,
  authoredRef: string,
  recutRef: string,
  paths: readonly string[],
): Promise<boolean> {
  return withScratchRoot(git, repo, "yrd-union-proof-", undefined, async (root) => {
    try {
      for (const [index, path] of paths.entries()) {
        const base = await readUnionBlob(git, repo, baseRef, path)
        const current = await readUnionBlob(git, repo, currentRef, path)
        const authored = await readUnionBlob(git, repo, authoredRef, path)
        const recut = await readUnionBlob(git, repo, recutRef, path)
        if (base === undefined || current === undefined || authored === undefined || recut === undefined) return false
        const mode = mergedUnionMode(base.mode, current.mode, authored.mode)
        if (mode === undefined || recut.mode !== mode) return false
        const currentPath = join(root, `${index}-current`)
        const basePath = join(root, `${index}-base`)
        const authoredPath = join(root, `${index}-authored`)
        await writeFile(currentPath, current.content)
        await writeFile(basePath, base.content)
        await writeFile(authoredPath, authored.content)
        const merged = await git.raw(
          repo,
          ["merge-file", "--union", "--stdout", currentPath, basePath, authoredPath],
          true,
        )
        if (merged.code !== 0 || merged.stdout !== recut.content) return false
      }
      return paths.length > 0
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
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
  const rows = output.split(/\r?\n/u).filter((row) => row.trim() !== "")
  return (
    rows.length > 0 && rows.every((row) => /^\d+:\s+[0-9a-f]+\s+=\s+\d+:\s+[0-9a-f]+(?:\s|$)/iu.test(row.trimStart()))
  )
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
  pr: string,
  headSha: string,
): Promise<Readonly<{ status: "passed"; output: readonly string[] }> | CandidateFailure> {
  // HEAD is the composing branch, i.e. the authoritative current base.
  const base = await authoredDeltaBase((cwd, args) => git.run(cwd, args, true), repo, "HEAD", headSha)
  if (base.status === "unreadable") {
    return candidateFailure(
      "gitlink-inspection",
      `could not inspect authored gitlinks for '${headSha}': ${base.detail}; ` +
        "restore readable history before declaring component pin intents",
    )
  }
  const paths = await changedPaths(git, repo, base.sha, headSha)
  const gitlinks: string[] = []
  for (const path of paths) {
    if (
      (await readGitlink(git, repo, base.sha, path)) !== undefined ||
      (await readGitlink(git, repo, headSha, path)) !== undefined
    ) {
      gitlinks.push(path)
    }
  }
  return { status: "passed", output: gitlinks }
}

/** Refusal boundary for split-out path roots (e.g. pm state moved to a sibling
 * repo): a payload path is refused when it starts with any configured entry.
 * Entries are plain prefixes — "@" covers every top-level sigil root, "hub/"
 * covers that tree. Policy comes from trusted base config; absent config
 * disables. */
export type RefusePathsPolicy = Readonly<{
  paths: readonly string[]
  reason?: string
}>

async function refusedPayloadPaths(
  git: Git,
  repo: string,
  headSha: string,
  refused: readonly string[],
): Promise<Readonly<{ status: "passed"; output: readonly string[] }> | CandidateFailure> {
  const base = await git.run(repo, ["merge-base", "HEAD", headSha], true)
  if (base.code !== 0 || base.stdout === "") {
    return candidateFailure(
      "refused-path-inspection",
      `could not inspect payload paths for '${headSha}': ${base.stderr || base.stdout || "no merge base"}`,
    )
  }
  const paths = await changedPaths(git, repo, base.stdout, headSha)
  return { status: "passed", output: paths.filter((path) => refused.some((entry) => path.startsWith(entry))) }
}

type CandidateSubmodulePin = Readonly<{ path: string; sha: string; origin: string }>
type ComponentMainPromotion = Readonly<{
  origin: string
  repository: string
  mainSha: string
  targetSha: string
  pins: readonly CandidateSubmodulePin[]
}>
type ComponentMainPromotionFailure = Readonly<{
  code: string
  message: string
  receipts: readonly ComponentMainReceipt[]
  refusals: readonly ComponentMainRefusal[]
}>
type ComponentMainPromotionPlan =
  | Readonly<{
      status: "passed"
      promotions: readonly ComponentMainPromotion[]
      receipts: readonly ComponentMainReceipt[]
    }>
  | Readonly<{
      status: "failed"
      error: ComponentMainPromotionFailure
      /** Independent origins that remain safe to fast-forward despite the refusal. */
      promotions: readonly ComponentMainPromotion[]
      receipts: readonly ComponentMainReceipt[]
    }>

const FILTER_UNSUPPORTED =
  /filtering not recognized by server|server does not support filter|filter(?:ing)? (?:is )?not supported|unsupported[^\n]*filter/iu
const DEFINITIVE_EXACT_SHA_ABSENCE = /not our ref/iu

async function candidateSubmodulePins(
  git: Git,
  repo: string,
  path: string,
  candidateSha: string,
): Promise<CandidateSubmodulePin[]> {
  let failedRead: GitResult | undefined
  const observedProcess: Pick<Process, "run"> = {
    async run(request) {
      const result = await git.process.run(request)
      if (result.exitCode !== 0 || result.timedOut || result.stalled === true || result.sweepFailure !== undefined) {
        failedRead = {
          code: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
          signal: result.signal,
          timedOut: result.timedOut,
          ...(result.stalled === undefined ? {} : { stalled: result.stalled }),
          ...(result.verdict === undefined ? {} : { verdict: result.verdict }),
          ...(result.sweepFailure === undefined ? {} : { sweepFailure: result.sweepFailure }),
        }
      }
      return result
    },
  }
  let modules: Awaited<ReturnType<typeof readCommitSubmodules>>
  try {
    modules = await readCommitSubmodules(
      adaptProcessGit(observedProcess, { env: git.env, timeoutMs: GIT_TIMEOUT_MS }),
      path,
      candidateSha,
    )
  } catch (cause) {
    const phase =
      typeof cause === "object" &&
      cause !== null &&
      "resultDetail" in cause &&
      typeof cause.resultDetail === "object" &&
      cause.resultDetail !== null &&
      "phase" in cause.resultDetail &&
      typeof cause.resultDetail.phase === "string"
        ? cause.resultDetail.phase
        : undefined
    const operation =
      phase === "read-target-tree"
        ? "read-tree"
        : phase === "read-target-manifest" || phase === "read-target-submodules"
          ? "read-gitmodules"
          : undefined
    if (operation !== undefined && failedRead !== undefined) {
      throw createSubmoduleReachabilityRefusal({ operation, repository: path }, failedRead)
    }
    throw cause
  }
  if (modules.length === 0) return []
  const remoteContext = { operation: "read-superproject-origin", repository: repo } as const
  const remote = await runSubmoduleProbe(git, repo, ["config", "--get", "remote.origin.url"], remoteContext)
  const originNotConfigured = remote.code === 1 && remote.stdout === "" && remote.stderr === ""
  if (remote.code !== 0 && !originNotConfigured) {
    throw createSubmoduleReachabilityRefusal(remoteContext, remote)
  }
  const superOrigin = remote.code === 0 && remote.stdout !== "" ? remote.stdout : undefined
  return modules.map((module) => {
    const url = module.url
    if (url === undefined) throw new Error(`yrd: candidate submodule '${module.path}' has no URL`)
    if (superOrigin === undefined && (url.startsWith("./") || url.startsWith("../"))) {
      throw createSubmoduleReachabilityRefusal(
        remoteContext,
        remote,
        `candidate submodule '${module.path}' uses relative URL '${url}' but the superproject origin is not configured`,
      )
    }
    return { path: module.path, sha: module.target, origin: resolveSubmoduleOrigin(repo, superOrigin, url) }
  })
}

function componentMainRefusals(
  pins: readonly CandidateSubmodulePin[],
  code: string,
  message: string,
  mainSha?: string,
): readonly ComponentMainRefusal[] {
  const rendered = message.startsWith("yrd: ") ? message : `yrd: ${message}`
  return pins.map((pin) => ({
    path: pin.path,
    origin: pin.origin,
    pinSha: pin.sha,
    ...(mainSha === undefined ? {} : { mainSha }),
    code,
    message: rendered,
  }))
}

function componentMainFailure(
  code: string,
  message: string,
  receipts: readonly ComponentMainReceipt[] = [],
  refusals: readonly ComponentMainRefusal[] = [],
): ComponentMainPromotionFailure {
  return {
    code,
    message: message.startsWith("yrd: ") ? message : `yrd: ${message}`,
    receipts,
    refusals,
  }
}

function componentMainOutcomes(
  receipts: readonly ComponentMainReceipt[],
  refusals: readonly ComponentMainRefusal[],
): ComponentMainOutcomes {
  return ComponentMainOutcomesSchema.parse({
    kind: "component-main-outcomes",
    receipts,
    refusals,
  })
}

async function fetchComponentMain(
  git: Git,
  repository: string,
  origin: string,
): Promise<
  Readonly<{ status: "passed"; sha: string }> | Readonly<{ status: "failed"; error: ComponentMainPromotionFailure }>
> {
  const ref = "refs/yrd/component-main"
  const fetched = await git.run(
    repository,
    ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", origin, `+refs/heads/main:${ref}`],
    true,
  )
  if (fetched.code !== 0) {
    return {
      status: "failed",
      error: componentMainFailure(
        "component-main-inspection-failed",
        `could not refresh component main from '${origin}': ${fetched.stderr || fetched.stdout || "git fetch failed"}`,
      ),
    }
  }
  return { status: "passed", sha: await git.commit(repository, ref) }
}

async function fetchComponentPin(
  git: Git,
  repository: string,
  pin: CandidateSubmodulePin,
): Promise<ComponentMainPromotionFailure | undefined> {
  try {
    await ensureCommitObject({
      repository,
      remote: pin.origin,
      commit: pin.sha,
      timeoutMs: GIT_TIMEOUT_MS,
      git: adaptProcessGit(git.process, { env: git.env, timeoutMs: GIT_TIMEOUT_MS }),
    })
    return undefined
  } catch (cause) {
    return componentMainFailure(
      "component-main-inspection-failed",
      `could not load merged pin '${pin.sha}' for '${pin.path}' from '${pin.origin}': ${messageOf(cause)}`,
    )
  }
}

async function planComponentMainPromotionGroup(
  git: Git,
  origin: string,
  pins: readonly CandidateSubmodulePin[],
  untrustedOrigins: ReadonlySet<string>,
  repository: string,
): Promise<
  | Readonly<{
      status: "passed"
      promotion?: ComponentMainPromotion
      receipts: readonly ComponentMainReceipt[]
    }>
  | Readonly<{ status: "failed"; error: ComponentMainPromotionFailure }>
> {
  const orderedPins = pins.toSorted((left, right) => left.path.localeCompare(right.path))
  await mkdir(repository, { recursive: true })
  const initialized = await git.run(repository, ["init", "--bare"], true)
  if (initialized.code !== 0) {
    const message = `could not initialize component ancestry probe for '${origin}': ${
      initialized.stderr || initialized.stdout || "git init failed"
    }`
    return {
      status: "failed",
      error: componentMainFailure(
        "component-main-inspection-failed",
        message,
        [],
        componentMainRefusals(orderedPins, "component-main-inspection-failed", message),
      ),
    }
  }
  const componentMain = await fetchComponentMain(git, repository, origin)
  if (componentMain.status === "failed") {
    return {
      status: "failed",
      error: componentMainFailure(
        componentMain.error.code,
        componentMain.error.message,
        [],
        componentMainRefusals(orderedPins, componentMain.error.code, componentMain.error.message),
      ),
    }
  }

  const receipts: ComponentMainReceipt[] = []
  const pendingPins: CandidateSubmodulePin[] = []
  for (const pin of orderedPins) {
    const missing = await fetchComponentPin(git, repository, pin)
    if (missing !== undefined) {
      const unresolved = orderedPins.filter((candidate) => !receipts.some((receipt) => receipt.path === candidate.path))
      return {
        status: "failed",
        error: componentMainFailure(
          missing.code,
          missing.message,
          receipts,
          componentMainRefusals(unresolved, missing.code, missing.message, componentMain.sha),
        ),
      }
    }

    const reached = await git.run(repository, ["merge-base", "--is-ancestor", pin.sha, componentMain.sha], true)
    if (reached.code === 0) {
      receipts.push({
        path: pin.path,
        origin: pin.origin,
        pinSha: pin.sha,
        mainBeforeSha: componentMain.sha,
        mainAfterSha: componentMain.sha,
        action: "verified",
      })
      continue
    }
    if (reached.code !== 1) {
      const message = `could not compare merged pin '${pin.sha}' for '${pin.path}' with component main '${
        componentMain.sha
      }': ${reached.stderr || reached.stdout || "git merge-base failed"}`
      const unresolved = orderedPins.filter((candidate) => !receipts.some((receipt) => receipt.path === candidate.path))
      return {
        status: "failed",
        error: componentMainFailure(
          "component-main-inspection-failed",
          message,
          receipts,
          componentMainRefusals(unresolved, "component-main-inspection-failed", message, componentMain.sha),
        ),
      }
    }
    pendingPins.push(pin)
  }

  let targetSha = componentMain.sha
  let targetPath = "component main"
  for (const pin of pendingPins) {
    const covered = await git.run(repository, ["merge-base", "--is-ancestor", pin.sha, targetSha], true)
    if (covered.code === 0) continue
    if (covered.code !== 1) {
      const message = `could not compare merged pin '${pin.sha}' for '${pin.path}' with planned target '${targetSha}': ${
        covered.stderr || covered.stdout || "git merge-base failed"
      }`
      return {
        status: "failed",
        error: componentMainFailure(
          "component-main-inspection-failed",
          message,
          receipts,
          componentMainRefusals(pendingPins, "component-main-inspection-failed", message, componentMain.sha),
        ),
      }
    }
    const fastForward = await git.run(repository, ["merge-base", "--is-ancestor", targetSha, pin.sha], true)
    if (fastForward.code === 0) {
      targetSha = pin.sha
      targetPath = `'${pin.path}'`
      continue
    }
    if (fastForward.code !== 1) {
      const message = `could not compare '${targetSha}' with merged pin '${pin.sha}' for '${pin.path}': ${
        fastForward.stderr || fastForward.stdout || "git merge-base failed"
      }`
      return {
        status: "failed",
        error: componentMainFailure(
          "component-main-inspection-failed",
          message,
          receipts,
          componentMainRefusals(pendingPins, "component-main-inspection-failed", message, componentMain.sha),
        ),
      }
    }
    const containment = await inspectBaseContainment(git, repository, targetSha, pin.sha)
    if (containment.status === "inspection-failed") {
      const message = `could not inspect merged pin '${pin.sha}' for '${pin.path}' against planned component target '${targetSha}': ${containment.detail}`
      return {
        status: "failed",
        error: componentMainFailure(
          "component-main-inspection-failed",
          message,
          receipts,
          componentMainRefusals(pendingPins, "component-main-inspection-failed", message, componentMain.sha),
        ),
      }
    }
    if (containment.status === "drops-landed") {
      const message = `merged pin '${pin.path}' '${pin.sha}' does not contain planned component target '${targetSha}' at '${origin}' and would drop merged commits:\n${containment.commits}\nremedy: ${linearRebuildRemedy(`component work for '${pin.path}'`, targetSha)}`
      return {
        status: "failed",
        error: componentMainFailure(
          "carrier-drops-landed",
          message,
          receipts,
          componentMainRefusals(pendingPins, "carrier-drops-landed", message, componentMain.sha),
        ),
      }
    }
    const message = `NON-ANCESTRAL component lineage at '${origin}': ${targetPath} '${targetSha}' and merged pin '${pin.path}' '${pin.sha}' diverge; compose the divergent component histories before retrying`
    return {
      status: "failed",
      error: componentMainFailure(
        "component-main-non-ancestral",
        message,
        receipts,
        componentMainRefusals(pendingPins, "component-main-non-ancestral", message, componentMain.sha),
      ),
    }
  }
  if (targetSha === componentMain.sha) return { status: "passed", receipts }

  const untrusted = pendingPins.map((pin) => pin.path).filter((path) => untrustedOrigins.has(path))
  if (untrusted.length > 0) {
    const message = `new component [${untrusted.join(", ")}] requires main to advance at '${origin}'; review the new remote before granting main-update authority`
    return {
      status: "failed",
      error: componentMainFailure(
        "component-main-origin-untrusted",
        message,
        receipts,
        componentMainRefusals(pendingPins, "component-main-origin-untrusted", message, componentMain.sha),
      ),
    }
  }
  return {
    status: "passed",
    promotion: {
      origin,
      repository,
      mainSha: componentMain.sha,
      targetSha,
      pins: pendingPins,
    },
    receipts,
  }
}

async function planComponentMainPromotions(
  git: Git,
  repo: string,
  baseSha: string | undefined,
  candidateSha: string,
  scratchRoot: string,
): Promise<ComponentMainPromotionPlan> {
  const candidatePins = await candidateSubmodulePins(git, repo, repo, candidateSha)
  const basePins =
    baseSha === undefined
      ? new Map<string, CandidateSubmodulePin>()
      : new Map((await candidateSubmodulePins(git, repo, repo, baseSha)).map((pin) => [pin.path, pin] as const))
  const changed: CandidateSubmodulePin[] = []
  const untrustedOrigins = new Set<string>()
  const directRefusals: ComponentMainRefusal[] = []
  let directFailure: ComponentMainPromotionFailure | undefined
  for (const pin of candidatePins) {
    if (baseSha !== undefined && (await readGitlink(git, repo, baseSha, pin.path)) === pin.sha) continue
    const basePin = basePins.get(pin.path)
    if (baseSha === undefined) {
      // A landed root tree is the authority for its own component registry.
      // Reconciliation therefore trusts its standing .gitmodules origins and
      // audits every pin, including gaps left by earlier failed actuators.
    } else if (basePin === undefined) {
      untrustedOrigins.add(pin.path)
    } else if (basePin.origin !== pin.origin) {
      const message = `component origin for '${pin.path}' changed from '${basePin.origin}' to '${pin.origin}'; review the new remote before granting main-update authority`
      directFailure ??= componentMainFailure("component-main-origin-changed", message)
      directRefusals.push(...componentMainRefusals([pin], "component-main-origin-changed", message))
      continue
    }
    changed.push(pin)
  }
  const groups = new Map<string, CandidateSubmodulePin[]>()
  for (const pin of changed) groups.set(pin.origin, [...(groups.get(pin.origin) ?? []), pin])

  const promotions: ComponentMainPromotion[] = []
  const receipts: ComponentMainReceipt[] = []
  const refusals: ComponentMainRefusal[] = [...directRefusals]
  let failure = directFailure
  let groupIndex = 0
  for (const [origin, pins] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    const repository = join(scratchRoot, `component-${String(groupIndex)}`)
    groupIndex += 1
    const planned = await planComponentMainPromotionGroup(git, origin, pins, untrustedOrigins, repository)
    if (planned.status === "failed") {
      failure ??= planned.error
      receipts.push(...planned.error.receipts)
      refusals.push(...planned.error.refusals)
      continue
    }
    receipts.push(...planned.receipts)
    if (planned.promotion !== undefined) promotions.push(planned.promotion)
  }
  return failure === undefined
    ? { status: "passed", promotions, receipts }
    : {
        status: "failed",
        error: { ...failure, receipts, refusals },
        promotions,
        receipts,
      }
}

async function applyComponentMainPromotions(
  git: Git,
  promotions: readonly ComponentMainPromotion[],
  initialReceipts: readonly ComponentMainReceipt[],
): Promise<
  | Readonly<{ status: "passed"; receipts: readonly ComponentMainReceipt[] }>
  | Readonly<{ status: "failed"; error: ComponentMainPromotionFailure }>
> {
  const receipts = [...initialReceipts]
  const refusals: ComponentMainRefusal[] = []
  let failure: ComponentMainPromotionFailure | undefined
  const transport = adaptProcessGit(git.process, { env: git.env, timeoutMs: GIT_TIMEOUT_MS })
  for (const promotion of promotions) {
    const update = {
      repository: promotion.repository,
      remote: promotion.origin,
      source: promotion.targetSha,
      destination: "refs/heads/main",
      expectedDestination: { state: "oid", oid: promotion.mainSha } as const,
    }
    let pushed = await pushRefUpdates({
      root: promotion.repository,
      git: transport,
      timeoutMs: GIT_TIMEOUT_MS,
      updates: [update],
    })
    let pushDetail = gitSuperFailureDetail(pushed)?.message ?? `git-super push ended as ${pushed.state}`
    if (
      pushed.state !== "updated" &&
      pushed.state !== "unchanged" &&
      (isAbsolute(promotion.origin) || promotion.origin.startsWith("file://")) &&
      /refusing to update checked out branch/iu.test(pushDetail)
    ) {
      // Local integration fixtures and single-user repositories can use a
      // non-bare component origin. updateInstead is the receiver's safe mode:
      // it updates a clean checked-out branch atomically and refuses dirt.
      pushed = await pushRefUpdates({
        root: promotion.repository,
        git: transport,
        timeoutMs: GIT_TIMEOUT_MS,
        receivePack: "git -c receive.denyCurrentBranch=updateInstead receive-pack",
        updates: [update],
      })
      pushDetail = gitSuperFailureDetail(pushed)?.message ?? `git-super push ended as ${pushed.state}`
    }

    if (pushed.state === "updated" || pushed.state === "unchanged") {
      receipts.push(
        ...promotion.pins.map(
          (pin): ComponentMainReceipt => ({
            path: pin.path,
            origin: pin.origin,
            pinSha: pin.sha,
            mainBeforeSha: promotion.mainSha,
            mainAfterSha: promotion.targetSha,
            action: "fast-forwarded",
          }),
        ),
      )
      continue
    }

    const refreshed = await fetchComponentMain(git, promotion.repository, promotion.origin)
    if (refreshed.status === "failed") {
      const message = `component main promotion for [${promotion.pins.map((pin) => pin.path).join(", ")}] ${
        pushed.state
      } but its result could not be verified: ${refreshed.error.message}`
      failure ??= componentMainFailure("component-main-promotion-failed", message)
      refusals.push(
        ...componentMainRefusals(promotion.pins, "component-main-promotion-failed", message, promotion.mainSha),
      )
      continue
    }
    const reached = await git.run(
      promotion.repository,
      ["merge-base", "--is-ancestor", promotion.targetSha, refreshed.sha],
      true,
    )
    if (reached.code === 0) {
      receipts.push(
        ...promotion.pins.map(
          (pin): ComponentMainReceipt => ({
            path: pin.path,
            origin: pin.origin,
            pinSha: pin.sha,
            mainBeforeSha: promotion.mainSha,
            mainAfterSha: refreshed.sha,
            action: "fast-forwarded",
          }),
        ),
      )
      continue
    }
    if (reached.code !== 1) {
      const message = `could not verify component main after promoting [${promotion.pins
        .map((pin) => pin.path)
        .join(", ")}]: ${reached.stderr || reached.stdout || "git merge-base failed"}`
      failure ??= componentMainFailure("component-main-promotion-failed", message)
      refusals.push(...componentMainRefusals(promotion.pins, "component-main-promotion-failed", message, refreshed.sha))
      continue
    }
    const stillFastForward = await git.run(
      promotion.repository,
      ["merge-base", "--is-ancestor", refreshed.sha, promotion.targetSha],
      true,
    )
    if (stillFastForward.code === 1) {
      const message = `NON-ANCESTRAL component lineage at '${promotion.origin}': component main '${
        refreshed.sha
      }' diverged from merged pin '${promotion.targetSha}' for [${promotion.pins
        .map((pin) => pin.path)
        .join(", ")}]; compose the divergent histories`
      failure ??= componentMainFailure("component-main-diverged-after-landing", message)
      refusals.push(
        ...componentMainRefusals(promotion.pins, "component-main-diverged-after-landing", message, refreshed.sha),
      )
      continue
    }
    const message =
      stillFastForward.code === 0
        ? `could not fast-forward component main from '${promotion.mainSha}' to '${promotion.targetSha}' for [${promotion.pins
            .map((pin) => pin.path)
            .join(", ")}]: ${pushDetail}`
        : `could not compare refreshed component main '${refreshed.sha}' with '${promotion.targetSha}' for [${promotion.pins
            .map((pin) => pin.path)
            .join(", ")}]: ${stillFastForward.stderr || stillFastForward.stdout || "git merge-base failed"}`
    failure ??= componentMainFailure("component-main-promotion-failed", message)
    refusals.push(...componentMainRefusals(promotion.pins, "component-main-promotion-failed", message, refreshed.sha))
  }
  return failure === undefined
    ? { status: "passed", receipts }
    : {
        status: "failed",
        error: {
          ...failure,
          receipts,
          refusals,
        },
      }
}

function componentMainFailureResult(error: ComponentMainPromotionFailure): JobResult<never> {
  return failedWithEvidence(error.code, error.message, componentMainOutcomes(error.receipts, error.refusals))
}

function componentMainEvidence(result: JobResult<IntegrationProof>): ComponentMainOutcomes | undefined {
  if (result.status === "completed" && result.conclusion === "success") {
    return componentMainOutcomes(result.output.componentMains ?? [], [])
  }
  if (result.status !== "completed" || result.conclusion !== "failure") return undefined
  const parsed = ComponentMainOutcomesSchema.safeParse(result.error.evidence)
  return parsed.success ? parsed.data : undefined
}

const NativeRootPushFailureEvidenceSchema = z
  .object({
    kind: z.literal("native-root-push-failure"),
    branchRef: z.string().min(1),
    candidateSha: z.string().min(1),
  })
  .strict()

function nativeRootPushFailureEvidence(result: JobResult<IntegrationProof>): boolean {
  if (result.status !== "completed" || result.conclusion !== "failure") return false
  return NativeRootPushFailureEvidenceSchema.safeParse(result.error.evidence).success
}

function missingComponentMainOutcomes(
  promotions: readonly ComponentMainPromotion[],
  plannedReceipts: readonly ComponentMainReceipt[],
  recordedReceipts: readonly ComponentMainReceipt[],
): readonly CandidateSubmodulePin[] {
  const recorded = new Set(recordedReceipts.map(({ origin, path, pinSha }) => `${origin}\0${path}\0${pinSha}`))
  const expected = [
    ...plannedReceipts.map(({ origin, path, pinSha }): CandidateSubmodulePin => ({ origin, path, sha: pinSha })),
    ...promotions.flatMap(({ pins }) => pins),
  ]
  return expected.filter(({ origin, path, sha }) => !recorded.has(`${origin}\0${path}\0${sha}`))
}

async function withComponentMainPromotions(
  git: Git,
  repo: string,
  baseSha: string | undefined,
  candidateSha: string,
  run: (
    promotions: readonly ComponentMainPromotion[],
    receipts: readonly ComponentMainReceipt[],
  ) => Promise<JobResult<IntegrationProof>>,
  options: Readonly<{ settleSafePromotions?: boolean }> = {},
): Promise<JobResult<IntegrationProof>> {
  return withScratchRoot(git, repo, "yrd-component-main-", undefined, (root) =>
    componentMainPromotionsIn(git, repo, baseSha, candidateSha, run, options, root),
  )
}

async function componentMainPromotionsIn(
  git: Git,
  repo: string,
  baseSha: string | undefined,
  candidateSha: string,
  run: (
    promotions: readonly ComponentMainPromotion[],
    receipts: readonly ComponentMainReceipt[],
  ) => Promise<JobResult<IntegrationProof>>,
  options: Readonly<{ settleSafePromotions?: boolean }>,
  root: string,
): Promise<JobResult<IntegrationProof>> {
  let outcome: JobResult<IntegrationProof> | undefined
  let operationFailure: unknown
  try {
    const planned = await planComponentMainPromotions(git, repo, baseSha, candidateSha, root)
    if (planned.status === "failed" && options.settleSafePromotions !== true) {
      const abortMessage =
        "component main promotion was not attempted because another changed component failed preflight"
      const aborted = planned.promotions.flatMap((promotion) =>
        componentMainRefusals(promotion.pins, "component-main-preflight-aborted", abortMessage, promotion.mainSha),
      )
      outcome = componentMainFailureResult({
        ...planned.error,
        refusals: [...planned.error.refusals, ...aborted],
      })
    } else {
      outcome = await run(planned.promotions, planned.receipts)
      if (planned.status === "failed") {
        const settled = componentMainEvidence(outcome)
        outcome = componentMainFailureResult({
          ...planned.error,
          receipts: settled?.receipts ?? planned.receipts,
          refusals: [...planned.error.refusals, ...(settled?.refusals ?? [])],
        })
      } else if (outcome.status === "completed" && outcome.conclusion === "success") {
        const missing = missingComponentMainOutcomes(
          planned.promotions,
          planned.receipts,
          outcome.output.componentMains ?? [],
        )
        if (missing.length > 0) {
          const message = `component main action produced no receipt or refusal for [${missing
            .map(({ path }) => path)
            .join(", ")}]`
          outcome = componentMainFailureResult(
            componentMainFailure(
              "component-main-outcome-missing",
              message,
              outcome.output.componentMains ?? [],
              componentMainRefusals(missing, "component-main-outcome-missing", message),
            ),
          )
        }
      }
    }
  } catch (cause) {
    operationFailure = cause
  }
  let cleanupFailure: string | undefined
  try {
    await rm(root, { recursive: true, force: true })
  } catch (cause) {
    cleanupFailure = messageOf(cause)
  }
  if (operationFailure !== undefined) throw operationFailure
  if (outcome === undefined) throw new Error("component main promotion produced no result")
  if ((outcome.status === "completed" && outcome.conclusion === "failure") || cleanupFailure === undefined) {
    return outcome
  }
  return componentMainScratchCleanupFailure(outcome, cleanupFailure)
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

  const metadata = await git.probe(path, ["diff", "--cached", "--quiet", "HEAD", "--", ".gitmodules"])
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
      message:
        "queue-native composition does not allow a concurrent .gitmodules change before publishing a composition",
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
    const staged = await git.probe(path, ["update-index", "--cacheinfo", `160000,${resolution.sha},${resolution.path}`])
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
  const committed = await git.probe(path, ["commit", "--no-edit"])
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
  const listed = await git.rawProbe(repo, ["ls-files", "--unmerged", "-z"])
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
    const result = await (raw ? git.rawProbe(repo, args) : git.probe(repo, args))
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
    /** Opt into parent-versus-candidate comparison for diagnostics-shaped
     * lint/typecheck output. Ordinary commands use their exit code directly. */
    comparison?: "diagnostics"
    /** Delta admits only certified inherited residuals; strict requires the
     * candidate to be absolutely green and never evaluates the parent. */
    mode?: GateMode
    /** Structured report id that must prove a compound command reached its
     * diagnostics-only comparison phase. */
    comparisonReady?: string
    environment?: string
    env?: NodeJS.ProcessEnv
    environmentOverrides?: Readonly<Record<string, string>>
    environmentPassthrough?: readonly string[]
    timeoutMs?: number
    noProgressTimeoutMs?: number
    refuse?: RefusePathsPolicy
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

function gateCertificate(
  candidate: Pick<PinnedCandidate, "baseSha" | "candidateSha">,
  mode: GateMode,
  reports: readonly GateReport[],
): GateCertificate {
  return GateCertificateSchema.parse({
    version: 1,
    mode,
    baseSha: candidate.baseSha,
    candidateSha: candidate.candidateSha,
    reports,
  })
}

type PassedCommandResult = Extract<JobResult<CommandEvidence>, { status: "completed"; conclusion: "success" }>

function certifyPassingCommand(
  outcome: PassedCommandResult,
  candidate: PinnedCandidate,
  mode: GateMode,
  classification: "base" | "carrier",
  purpose: string,
  attempt: number,
  comparisonReady?: string,
): JobResult<GitCheckResultEvidence> {
  const reports = outcome.output.gateReports ?? [createGateReport("exit-code", [])]
  const evidence = GitCheckEvidenceSchema.parse({
    ...outcome.output,
    ...candidate,
    mode,
    classification,
    attempt,
  })
  if (comparisonReady !== undefined && !reports.some((report) => report.comparator.id === comparisonReady)) {
    return failed(
      `${purpose}-comparison-not-ready`,
      `${purpose} did not emit required gate report '${comparisonReady}'`,
      evidence,
    )
  }
  if (mode === "strict" && reports.some((report) => report.residual.count !== 0)) {
    return failed(
      `${purpose}-strict-residual`,
      `${purpose} strict mode received a non-empty structured residual from a green candidate`,
      evidence,
    )
  }
  return {
    status: "completed",
    conclusion: "success",
    output: GitCheckEvidenceSchema.parse({
      ...evidence,
      certificate: gateCertificate(candidate, mode, reports),
    }),
  }
}

async function withPinnedCandidate<Output extends JsonValue>(
  git: Git,
  repo: string,
  input: StepExecution,
  context: Readonly<{ id: string; attempt: number }>,
  options: Readonly<{
    checkoutParent?: string
    artifactRoot?: string
    candidatePool?: CandidatePool
    refuse?: RefusePathsPolicy
  }>,
  onFailure: (failure: PreparedCandidateFailure) => JobResult<Output>,
  runWithCandidate: (path: string, candidate: PinnedCandidate) => Promise<JobResult<Output>>,
): Promise<JobResult<Output>> {
  const target = await authoritativeQueueBase(git, repo, primaryPR(input).base)
  // Warm pool when the host opts in; otherwise the exact cold scratch path.
  const withCandidateWorktree = (
    run: (path: string, scratchRoot: string) => Promise<JobResult<Output>>,
  ): Promise<JobResult<Output>> =>
    options.candidatePool === undefined
      ? withScratch(git, repo, target.sha, options.checkoutParent, run)
      : options.candidatePool.withCandidate(target.sha, run)
  return withCandidateWorktree(async (path, scratchRoot) => {
    const candidate = await prepareCandidate(
      git,
      repo,
      path,
      target.sha,
      input,
      context.attempt,
      resolve(options.artifactRoot ?? join(repo, ".git", "yrd", "artifacts")),
      options.refuse,
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
    return runWithCandidate(
      path,
      PinnedCandidateSchema.parse({
        baseSha: target.sha,
        candidateSha: candidate.output.sha,
        candidateTreeSha: (await git.run(path, ["rev-parse", `${candidate.output.sha}^{tree}`])).stdout,
        candidateRef: pinned.ref,
        ...(candidate.output.changes.length === 0 ? {} : { changes: candidate.output.changes }),
        ...(candidate.output.sourceRewrites.length === 0 ? {} : { sourceRewrites: candidate.output.sourceRewrites }),
        ...(candidate.output.submoduleResolutions.length === 0
          ? {}
          : { submoduleResolutions: candidate.output.submoduleResolutions }),
      }),
    )
  })
}

async function withStepCandidate<Output extends JsonValue>(
  git: Git,
  repo: string,
  input: StepExecution,
  context: JobContext,
  options: Readonly<{
    checkoutParent?: string
    artifactRoot?: string
    candidatePool?: CandidatePool
  }>,
  onFailure: (failure: PreparedCandidateFailure) => JobResult<Output>,
  runWithCandidate: (path: string, candidate: PinnedCandidate) => Promise<JobResult<Output>>,
): Promise<JobResult<Output>> {
  const runtime = context.context
  if (runtime === undefined) {
    // Compatibility for direct StepRunner consumers and replay-era tests. The
    // configured Queue always supplies a Runner Context and never enters this
    // reconstruction path.
    return withPinnedCandidate(git, repo, input, context, options, onFailure, runWithCandidate)
  }
  if (runtime.request.candidate === "none") {
    if (runtime.cwd === undefined && runtime.candidateRef === undefined) {
      return withPinnedCandidate(git, repo, input, context, options, onFailure, runWithCandidate)
    }
    throw new Error(`yrd: check Job '${context.id}' requires a Candidate Context`)
  }
  if (runtime.cwd === undefined || runtime.candidateRef === undefined) {
    throw new Error(`yrd: Candidate Context '${runtime.id}' is missing its materialized worktree identity`)
  }
  const candidate = input.candidate
  if (candidate === undefined) {
    throw new Error(`yrd: check Job '${context.id}' is missing immutable Candidate facts`)
  }
  if (candidate.mergeability !== "mergeable" || candidate.sha === undefined || candidate.ref === undefined) {
    throw new Error(`yrd: check Job '${context.id}' requires a constructed mergeable Candidate`)
  }
  if (candidate.ref !== runtime.candidateRef) {
    throw new Error(
      `yrd: Candidate Context '${runtime.id}' materialized '${runtime.candidateRef}', expected '${candidate.ref}'`,
    )
  }
  if (input.prs.some((pr) => pr.baseSha !== undefined && pr.baseSha !== candidate.baseSha)) {
    throw new Error(`yrd: check Job '${context.id}' Candidate base does not match its PR revisions`)
  }
  const head = await git.commit(runtime.cwd, "HEAD")
  if (head !== candidate.sha) {
    throw new Error(`yrd: Candidate Context '${runtime.id}' materialized ${head}, expected ${candidate.sha}`)
  }
  return runWithCandidate(
    runtime.cwd,
    PinnedCandidateSchema.parse({
      baseSha: candidate.baseSha,
      candidateSha: candidate.sha,
      ...(candidate.treeSha === undefined ? {} : { candidateTreeSha: candidate.treeSha }),
      candidateRef: candidate.ref,
      ...(candidate.changes === undefined ? {} : { changes: candidate.changes }),
      ...(candidate.sourceRewrites === undefined ? {} : { sourceRewrites: candidate.sourceRewrites }),
      ...(candidate.submoduleResolutions === undefined ? {} : { submoduleResolutions: candidate.submoduleResolutions }),
    }),
  )
}

export function gitCheckStep(options: GitCheckOptions): StepRunner<PRShape, GitCheckResultEvidence> {
  const repo = resolve(options.repo)
  const git = createGit(options.inject.process, options.env)
  const mode = options.mode ?? "delta"
  const check = async (input: StepExecution, context: JobContext): Promise<JobResult<GitCheckResultEvidence>> => {
    try {
      const purpose = options.purpose ?? "check"
      return await withStepCandidate(
        git,
        repo,
        input,
        context,
        {
          checkoutParent: options.checkoutParent,
          ...(options.candidatePool === undefined ? {} : { candidatePool: options.candidatePool }),
          artifactRoot: options.artifactRoot,
          ...(options.refuse === undefined ? {} : { refuse: options.refuse }),
        },
        (failure) => failed(failure.error.code, failure.error.message, failure.output),
        async (path, candidate): Promise<JobResult<GitCheckResultEvidence>> => {
          const artifactRoot = options.artifactRoot ?? join(repo, ".git", "yrd", "artifacts")
          const configured = (
            cwd: string,
            targetSha: string,
            root: string,
            parentTree: boolean,
          ): ConfiguredCommandOptions<PRShape> => ({
            inject: options.inject,
            command: options.command,
            cwd,
            purpose,
            artifactRoot: root,
            ...(options.env === undefined ? {} : { env: options.env }),
            ...(options.environmentOverrides === undefined
              ? {}
              : { environmentOverrides: options.environmentOverrides }),
            ...(options.environmentPassthrough === undefined
              ? {}
              : { environmentPassthrough: options.environmentPassthrough }),
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            ...(options.noProgressTimeoutMs === undefined ? {} : { noProgressTimeoutMs: options.noProgressTimeoutMs }),
            classification: parentTree ? "base" : (options.classification ?? "carrier"),
            mode,
            variables: () => ({
              YRD_BASE_SHA: candidate.baseSha,
              YRD_CANDIDATE_SHA: targetSha,
              ...(parentTree ? { YRD_SHA: candidate.baseSha } : {}),
              ...(options.environment === undefined ? {} : { YRD_ENVIRONMENT: options.environment }),
            }),
          })
          const candidateConfig = configured(path, candidate.candidateSha, artifactRoot, false)
          const classification = options.classification ?? ("carrier" as const)
          const candidateMetadata = {
            ...candidate,
            mode,
            classification,
            attempt: context.attempt,
          }

          if (options.runner === "waiting") {
            const outcome = await configuredWaitingCommandStep(candidateConfig)(
              { ...input, targetSha: candidate.candidateSha },
              context,
            )
            if (outcome.status === "completed" && outcome.conclusion === "success") {
              return certifyPassingCommand(
                outcome,
                candidate,
                mode,
                classification,
                purpose,
                context.attempt,
                options.comparisonReady,
              )
            }
            if (outcome.status === "waiting") {
              return {
                ...outcome,
                checkpoint: GitCheckEvidenceSchema.parse({
                  ...(outcome.checkpoint as CommandEvidence),
                  ...candidateMetadata,
                }),
              }
            }
            if (outcome.error.code === `${purpose}-infrastructure-signal`) {
              const refusal = GitCheckExecutionRefusalEvidenceSchema.parse({
                ...candidate,
                kind: "check-execution-refusal",
                phase: "candidate",
                error: outcome.error,
                ...(outcome.output === undefined ? {} : { candidateEvidence: outcome.output }),
                retryable: true,
              })
              return failedWithEvidence(
                "queue-environment-refused",
                `${purpose} candidate launcher ended before it produced a verdict: ${outcome.error.message}`,
                refusal,
              )
            }
            return {
              status: "completed",
              conclusion: "failure",
              error: outcome.error,
              ...(outcome.output === undefined
                ? {}
                : { output: GitCheckEvidenceSchema.parse({ ...outcome.output, ...candidateMetadata }) }),
            }
          }

          let outcome: JobResult<CommandEvidence>
          try {
            outcome = await configuredCommandStep(candidateConfig)(
              { ...input, targetSha: candidate.candidateSha },
              context,
            )
          } catch (cause) {
            const fact = failureFact(cause)
            const error = JobErrorSchema.parse({
              code: fact?.code ?? `${purpose}-candidate-execution-unavailable`,
              message: fact?.message ?? messageOf(cause),
            })
            const refusal = GitCheckExecutionRefusalEvidenceSchema.parse({
              ...candidate,
              kind: "check-execution-refusal",
              phase: "candidate",
              error,
              retryable: true,
            })
            return failedWithEvidence(
              "queue-environment-refused",
              `${purpose} candidate command could not run: ${error.message}`,
              refusal,
            )
          }

          if (outcome.status === "completed" && outcome.conclusion === "success") {
            return certifyPassingCommand(
              outcome,
              candidate,
              mode,
              classification,
              purpose,
              context.attempt,
              options.comparisonReady,
            )
          }
          if (outcome.status !== "completed" || outcome.conclusion !== "failure") {
            const error = comparisonOutcomeError(outcome, purpose, "candidate")
            const refusal = GitCheckComparisonRefusalEvidenceSchema.parse({
              ...candidate,
              kind: "check-comparison-refusal",
              phase: "candidate",
              error,
              retryable: true,
            })
            return failedWithEvidence(
              "queue-environment-refused",
              `${purpose} candidate evidence could not be evaluated: ${error.message}`,
              refusal,
            )
          }

          if (outcome.error.code === `${purpose}-infrastructure-signal`) {
            const refusal = GitCheckExecutionRefusalEvidenceSchema.parse({
              ...candidate,
              kind: "check-execution-refusal",
              phase: "candidate",
              error: outcome.error,
              ...(outcome.output === undefined ? {} : { candidateEvidence: outcome.output }),
              retryable: true,
            })
            return failedWithEvidence(
              "queue-environment-refused",
              `${purpose} candidate command ended before it produced a verdict: ${outcome.error.message}`,
              refusal,
            )
          }

          const candidateFailure: JobResult<GitCheckResultEvidence> = {
            status: "completed",
            conclusion: "failure",
            error: outcome.error,
            ...(outcome.output === undefined
              ? {}
              : { output: GitCheckEvidenceSchema.parse({ ...outcome.output, ...candidateMetadata }) }),
          }
          if (mode === "strict") return candidateFailure
          if (options.comparison !== "diagnostics") return candidateFailure
          // A structured child failure is terminal. A compound command may
          // continue past successful structured children and compare a final
          // diagnostics-only failure, but it must prove every earlier child
          // reached green by emitting the readiness report last.
          const comparisonReady =
            options.comparisonReady === undefined
              ? outcome.output?.gateReports === undefined
              : outcome.output?.gateReports?.some((report) => report.comparator.id === options.comparisonReady) === true
          if (!comparisonReady) {
            return candidateFailure
          }

          const candidateEvidence = comparableCommandEvidence(outcome, purpose)
          // A command that returned a nonzero exit genuinely ran. Missing or
          // truncated diagnostics cannot turn that terminal result into an
          // infrastructure refusal: the candidate remains red by exit code.
          if (candidateEvidence === undefined) return candidateFailure

          let parentPath = ""
          let parentOutcome: JobResult<CommandEvidence>
          try {
            parentOutcome = await withScratch(
              git,
              repo,
              candidate.baseSha,
              options.checkoutParent,
              async (scratchPath) => {
                parentPath = scratchPath
                return configuredCommandStep(
                  configured(scratchPath, candidate.baseSha, join(artifactRoot, "parent"), true),
                )({ ...input, targetSha: candidate.baseSha }, context)
              },
            )
          } catch (cause) {
            const fact = failureFact(cause)
            const error = JobErrorSchema.parse({
              code: fact?.code ?? `${purpose}-parent-execution-unavailable`,
              message: fact?.message ?? messageOf(cause),
            })
            const refusal = GitCheckExecutionRefusalEvidenceSchema.parse({
              ...candidate,
              kind: "check-execution-refusal",
              phase: "parent",
              error,
              candidateEvidence,
              retryable: true,
            })
            return failedWithEvidence(
              "queue-environment-refused",
              `${purpose} parent command could not run: ${error.message}`,
              refusal,
            )
          }

          const parentEvidence = comparableCommandEvidence(parentOutcome, purpose)
          if (
            parentOutcome.status === "completed" &&
            parentOutcome.conclusion === "failure" &&
            parentOutcome.error.code === `${purpose}-infrastructure-signal`
          ) {
            const refusal = GitCheckExecutionRefusalEvidenceSchema.parse({
              ...candidate,
              kind: "check-execution-refusal",
              phase: "parent",
              error: parentOutcome.error,
              ...(candidateEvidence === undefined ? {} : { candidateEvidence }),
              retryable: true,
            })
            return failedWithEvidence(
              "queue-environment-refused",
              `${purpose} parent command ended before it produced a verdict: ${parentOutcome.error.message}`,
              refusal,
            )
          }
          if (parentEvidence === undefined) {
            // An ordinary nonzero parent exit genuinely ran and cannot become
            // an infrastructure alias just because its diagnostics are opaque.
            // Named incomplete outcomes (timeout/stall) remain retryable below.
            if (
              parentOutcome.status === "completed" &&
              parentOutcome.conclusion === "failure" &&
              parentOutcome.error.code === `${purpose}-failed`
            ) {
              return candidateFailure
            }
            const error = comparisonOutcomeError(parentOutcome, purpose, "parent")
            const refusal = GitCheckComparisonRefusalEvidenceSchema.parse({
              ...candidate,
              kind: "check-comparison-refusal",
              phase: "parent",
              error,
              ...(parentOutcome.status === "completed" &&
              parentOutcome.conclusion === "failure" &&
              parentOutcome.output !== undefined
                ? { parent: parentOutcome.output }
                : {}),
              candidateEvidence,
              retryable: true,
            })
            return failedWithEvidence(
              "queue-environment-refused",
              `${purpose} parent evidence could not be evaluated: ${error.message}`,
              refusal,
            )
          }

          const comparison = compareCommandEvidence(parentEvidence, parentPath, candidateEvidence, path)
          const evidence = GitCheckEvidenceSchema.parse({
            ...candidateEvidence,
            ...candidateMetadata,
            comparison,
            certificate: gateCertificate(candidate, mode, [
              ...(candidateEvidence.gateReports ?? []),
              createGateReport(
                "diagnostics",
                uniqueComparisonDiagnostics(candidateEvidence, path).map(diagnosticIdentity),
              ),
            ]),
          })
          if (comparison.netNewDiagnostics.length === 0) {
            return { status: "completed", conclusion: "success", output: evidence }
          }
          return { status: "completed", conclusion: "failure", error: outcome.error, output: evidence }
        },
      )
    } catch (cause) {
      const classified = await stepInfrastructureFailure(git, repo, cause)
      if (classified !== undefined) return classified
      const detail = messageOf(cause)
      try {
        return failed(
          "check-failed",
          detail,
          await failureEvidence({
            command: ["git", "-C", repo, "fetch", "--no-recurse-submodules", "--quiet", "origin"],
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
  return async (input, context): Promise<JobResult<GitCheckResultEvidence>> =>
    discloseStepFailure(
      options.artifactRoot ?? join(repo, ".git", "yrd", "artifacts"),
      input,
      context.attempt,
      await check(input, context),
    )
}

export type GitMergeOptions = ProcessDependency &
  Readonly<{ repo: string; env?: NodeJS.ProcessEnv; refuse?: RefusePathsPolicy }>

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
    refuse?: RefusePathsPolicy
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
  let pinned = checked
  if (checked.baseSha !== baseSha) {
    const attemptedLanding =
      (await landingAttemptRefs(git, repo, input, checked)).length > 0 &&
      (await git.run(repo, ["merge-base", "--is-ancestor", checked.candidateSha, baseSha], true)).code === 0
    const current = input.candidate
    const treeEquivalent =
      primaryPR(input).intent !== undefined &&
      checked.candidateTreeSha !== undefined &&
      current?.treeSha === checked.candidateTreeSha &&
      current.sha !== undefined &&
      current.ref !== undefined
    if (!treeEquivalent && !attemptedLanding) {
      return {
        error: {
          code: "stale-check",
          message: `queue '${primaryPR(input).base}' moved from checked base '${checked.baseSha}' to '${baseSha}'`,
        },
      }
    }
    if (!attemptedLanding) {
      if (current?.sha === undefined || current.treeSha === undefined || current.ref === undefined) {
        return {
          error: {
            code: "stale-check",
            message: `queue '${primaryPR(input).base}' has no replacement Candidate for moved base '${baseSha}'`,
          },
        }
      }
      pinned = PinnedCandidateSchema.parse({
        baseSha,
        candidateSha: current.sha,
        candidateTreeSha: current.treeSha,
        candidateRef: current.ref,
        ...(current.changes === undefined ? {} : { changes: current.changes }),
        ...(current.sourceRewrites === undefined ? {} : { sourceRewrites: current.sourceRewrites }),
        ...(current.submoduleResolutions === undefined ? {} : { submoduleResolutions: current.submoduleResolutions }),
      })
    }
  }
  if ((await git.commit(repo, pinned.candidateRef)) !== pinned.candidateSha) {
    return { error: { code: "stale-check", message: "checked candidate ref moved" } }
  }
  const sourceRefError = await sourceCandidateRefError(git, repo, pinned.sourceRewrites ?? [])
  if (sourceRefError !== undefined) return { error: { code: "invalid-candidate", message: sourceRefError } }
  const finalSources = new Map<string, SourceRewrite>()
  for (const source of pinned.sourceRewrites ?? []) finalSources.set(source.repo, source)
  for (const source of finalSources.values()) {
    if ((await readGitlink(git, repo, pinned.candidateSha, source.repo)) !== source.newTipSha) {
      return {
        error: {
          code: "invalid-candidate",
          message: `checked candidate does not pin source '${source.repo}' to '${source.newTipSha}'`,
        },
      }
    }
  }
  const finalResolutions = new Map<string, QueueSubmoduleResolutionEvidence>()
  for (const resolution of pinned.submoduleResolutions ?? []) finalResolutions.set(resolution.path, resolution)
  for (const resolution of finalResolutions.values()) {
    if ((await readGitlink(git, repo, pinned.candidateSha, resolution.path)) !== resolution.sha) {
      return {
        error: {
          code: "invalid-candidate",
          message: `checked candidate does not pin submodule '${resolution.path}' to '${resolution.sha}'`,
        },
      }
    }
  }
  for (const sha of [pinned.baseSha, ...input.prs.map((pr) => pr.headSha)]) {
    if ((await git.run(repo, ["merge-base", "--is-ancestor", sha, pinned.candidateSha], true)).code !== 0) {
      return { error: { code: "invalid-candidate", message: `checked candidate does not contain '${sha}'` } }
    }
  }
  return { checked: pinned }
}

type MergeCandidateResult =
  | Readonly<{
      status: "completed"
      conclusion: "success"
      base: GitQueueTarget
      checked: PinnedCandidate
    }>
  | Readonly<{
      status: "completed"
      conclusion: "failure"
      error: Readonly<{ code: string; message: string }>
    }>
  | Readonly<{ status: "waiting"; token: string; detail?: string }>
type FailedJobResult = Extract<JobResult<never>, { status: "completed"; conclusion: "failure" }>

async function mergeCandidate(
  git: Git,
  repo: string,
  input: StepExecution,
  context: Readonly<{ id: string; attempt: number }>,
  options: Readonly<{ artifactRoot?: string; refuse?: RefusePathsPolicy }>,
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
            ...(options.refuse === undefined ? {} : { refuse: options.refuse }),
          },
          (failure) => failedWithEvidence(failure.error.code, failure.error.message, failure.output),
          (_path, candidate) =>
            Promise.resolve({ status: "completed" as const, conclusion: "success" as const, output: candidate }),
        )
      : undefined
  if (prepared?.status === "completed" && prepared.conclusion === "failure") return prepared
  if (prepared?.status === "waiting") return prepared
  const checked =
    prior ?? (prepared?.status === "completed" && prepared.conclusion === "success" ? prepared.output : undefined)
  if (checked === undefined) throw new Error("yrd: merge candidate preparation produced no candidate")
  const base = await authoritativeQueueBase(git, repo, primaryPR(input).base)
  const validated = await validatePinnedCandidate(git, repo, input, base.sha, checked)
  return "error" in validated
    ? { status: "completed", conclusion: "failure", error: validated.error }
    : { status: "completed", conclusion: "success", base, checked }
}

async function alreadyLandedEvidence(
  git: Git,
  repo: string,
  baseSha: string,
  checked: PinnedCandidate,
): Promise<AlreadyLandedEvidence | undefined> {
  const candidateTreeSha = (await git.run(repo, ["rev-parse", `${checked.candidateSha}^{tree}`])).stdout
  const baseTreeSha = (await git.run(repo, ["rev-parse", `${baseSha}^{tree}`])).stdout
  return candidateTreeSha === baseTreeSha
    ? { candidateSha: checked.candidateSha, candidateTreeSha, baseTreeSha }
    : undefined
}

function mergeAuthorityCancellation(context: Pick<JobContext, "signal">): FailedJobResult | undefined {
  if (!context.signal.aborted) return undefined
  return {
    status: "completed",
    conclusion: "failure",
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
    const fetched = await git.run(
      sourceRepo,
      ["fetch", "--no-recurse-submodules", "--quiet", "origin", source.candidateRef],
      true,
    )
    if (fetched.code !== 0 || (await git.optionalCommit(sourceRepo, "FETCH_HEAD")) !== source.newTipSha) {
      return `source '${source.repo}' candidate ref no longer resolves to '${source.newTipSha}'`
    }
  }
  return undefined
}

async function authoritativeQueueBase(
  git: Git,
  repo: string,
  branch: string,
  refreshRemoteBranches: readonly string[] = [],
): Promise<GitQueueTarget> {
  const remote = await git.run(repo, ["config", "--get", "remote.origin.url"], true)
  if (remote.code !== 0 || remote.stdout === "") return inspectQueueBase(git, repo, branch)
  const source = `refs/heads/${branch}`
  const target = `refs/remotes/origin/${branch}`
  for (const additional of refreshRemoteBranches) {
    await git.run(repo, ["check-ref-format", "--branch", additional])
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let detail: string
    try {
      const fetched = await git.run(
        repo,
        refreshRemoteBranches.length === 0
          ? ["fetch", "--no-recurse-submodules", "--quiet", "origin", `+${source}:${target}`]
          : ["fetch", "--no-recurse-submodules", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"],
        true,
      )
      if (fetched.code === 0) return await inspectQueueBase(git, repo, branch)
      detail = fetched.stderr || fetched.stdout || `could not refresh origin/${branch}`
    } catch (cause) {
      detail = messageOf(cause)
    }
    if (attempt === 3) {
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
  /** Refresh these sibling remote branches in the same authoritative fetch.
   * Deleted remote branches deliberately retain their last tracking head:
   * live drafts may recover from that durable carrier and republish it. */
  refreshRemoteBranches?: readonly string[]
}): Promise<GitQueueTarget> {
  const repo = resolve(options.repo)
  return authoritativeQueueBase(
    createGit(options.inject.process, options.env),
    repo,
    options.branch,
    options.refreshRemoteBranches,
  )
}

async function landingError(
  git: Git,
  repo: string,
  input: StepExecution,
  checked: PinnedCandidate,
  landingSha: string,
): Promise<string | undefined> {
  for (const sha of [checked.baseSha, ...input.prs.map((pr) => pr.headSha)]) {
    const ancestry = await git.run(repo, ["merge-base", "--is-ancestor", sha, landingSha], true)
    if (ancestry.code === 0) continue
    if (ancestry.code === 1) return sha
    throw new Error(`yrd: could not verify landing '${landingSha}' contains '${sha}': ${fetchDetail(ancestry)}`)
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
      const rolledBack = await pushRefUpdates({
        root: repo,
        git: adaptProcessGit(git.process, { env: git.env, timeoutMs: GIT_TIMEOUT_MS }),
        timeoutMs: GIT_TIMEOUT_MS,
        updates: [
          {
            repository: repo,
            remote: base.remote,
            source: base.sha,
            destination: base.branchRef,
            expectedDestination: { state: "oid", oid: landing.sha },
            allowNonFastForward: true,
          },
        ],
      })
      const restored = await authoritativeQueueBase(git, repo, base.branch)
      return (rolledBack.state === "updated" || rolledBack.state === "unchanged") && restored.sha === base.sha
        ? undefined
        : (gitSuperFailureDetail(rolledBack)?.message ?? `could not restore '${base.branch}' after source ref loss`)
    }

    const checkedOut = await checkedOutWorktree(git, repo, base.branchRef)
    if (checkedOut !== undefined) {
      if ((await git.commit(checkedOut, "HEAD")) !== landing.sha) return `'${base.branch}' moved during rollback`
      const rolledBack = await git.run(checkedOut, ["reset", "--merge", base.sha], true)
      const restored = await materializeSubmodules(git, { worktree: checkedOut, referenceWorktree: repo })
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
      const candidate = await mergeCandidate(
        git,
        repo,
        input,
        context,
        options.refuse === undefined ? {} : { refuse: options.refuse },
      )
      if (candidate.status !== "completed" || candidate.conclusion !== "success") return candidate
      const { base, checked } = candidate
      const baseSha = base.sha
      const alreadyLanded = await alreadyLandedEvidence(git, repo, baseSha, checked)
      if (alreadyLanded !== undefined) {
        const cancellation = mergeAuthorityCancellation(context)
        if (cancellation !== undefined) return cancellation
        const recovering = (await landingAttemptRefs(git, repo, input, checked)).length > 0
        return await withComponentMainPromotions(
          git,
          repo,
          undefined,
          baseSha,
          async (promotions, receipts) => {
            const settlement = await applyComponentMainPromotions(git, promotions, receipts)
            if (settlement.status === "failed") return componentMainFailureResult(settlement.error)
            return {
              status: "completed",
              conclusion: "success",
              output: recovering
                ? await physicalIntegrationProof(git, repo, input, context, baseSha, checked, settlement.receipts)
                : integrationProof(baseSha, checked, alreadyLanded, settlement.receipts),
            }
          },
          { settleSafePromotions: true },
        )
      }
      const remote = base.remote
      if (remote !== undefined) {
        const branchRef = `refs/heads/${branch}`
        const attempted = await withScratch(
          git,
          repo,
          checked.candidateSha,
          undefined,
          async (path): Promise<JobResult<IntegrationProof>> => {
            const submodules = await materializeSubmodules(git, { worktree: path, referenceWorktree: repo })
            if (submodules.code !== 0) {
              const detail = submodules.stderr || submodules.stdout || "could not materialize candidate submodules"
              return candidateSubmodulesFailure(git, repo, detail)
            }
            if ((await git.commit(path, "HEAD")) !== checked.candidateSha) {
              return failed("invalid-candidate", "candidate checkout does not match its pinned commit")
            }
            const sourceRefError = await sourceCandidateRefError(git, repo, checked.sourceRewrites ?? [])
            if (sourceRefError !== undefined) return failed("invalid-candidate", sourceRefError)
            const cancellation = mergeAuthorityCancellation(context)
            if (cancellation !== undefined) return cancellation
            await recordLandingAttempt(git, repo, input, context, checked)
            return withComponentMainPromotions(git, repo, checked.baseSha, checked.candidateSha, async () => {
              // Component mains are promoted explicitly around this root push.
              // A caller's recursive-push config would replay the root-only SHA refspec inside each component.
              const pushed = await pushRefUpdates({
                root: path,
                git: adaptProcessGit(git.process, { env: git.env, timeoutMs: GIT_TIMEOUT_MS }),
                timeoutMs: GIT_TIMEOUT_MS,
                updates: [
                  {
                    repository: path,
                    remote,
                    source: checked.candidateSha,
                    destination: branchRef,
                    expectedDestination: { state: "oid", oid: baseSha },
                  },
                ],
              })
              if (pushed.state !== "updated" && pushed.state !== "unchanged") {
                return failedWithEvidence(
                  "merge-push-failed",
                  gitSuperFailureDetail(pushed)?.message ?? `could not update '${branch}': ${pushed.state}`,
                  NativeRootPushFailureEvidenceSchema.parse({
                    kind: "native-root-push-failure",
                    branchRef,
                    candidateSha: checked.candidateSha,
                  }),
                )
              }
              // The changed-pin plan above preserves the pre-landing trust
              // boundary for new or changed component origins. Once root is
              // authoritative, audit every pin so this landing also converges
              // gaps left by an earlier actuator.
              return withComponentMainPromotions(
                git,
                repo,
                undefined,
                checked.candidateSha,
                async (promotions, receipts) => {
                  const settlement = await applyComponentMainPromotions(git, promotions, receipts)
                  if (settlement.status === "failed") return componentMainFailureResult(settlement.error)
                  return {
                    status: "completed",
                    conclusion: "success",
                    output: await physicalIntegrationProof(
                      git,
                      repo,
                      input,
                      context,
                      checked.candidateSha,
                      checked,
                      settlement.receipts,
                    ),
                  }
                },
                { settleSafePromotions: true },
              )
            })
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
          if (
            attempted.status === "completed" &&
            attempted.conclusion === "failure" &&
            componentMainEvidence(attempted) !== undefined
          ) {
            return attempted
          }
          if (
            attempted.status === "completed" &&
            attempted.conclusion === "failure" &&
            nativeRootPushFailureEvidence(attempted)
          ) {
            const reconciled = await withComponentMainPromotions(
              git,
              repo,
              undefined,
              landing.sha,
              async (promotions, receipts) => {
                const settlement = await applyComponentMainPromotions(git, promotions, receipts)
                return settlement.status === "passed"
                  ? {
                      status: "completed" as const,
                      conclusion: "success" as const,
                      output: await physicalIntegrationProof(
                        git,
                        repo,
                        input,
                        context,
                        landing.sha,
                        checked,
                        settlement.receipts,
                      ),
                    }
                  : componentMainFailureResult(settlement.error)
              },
              { settleSafePromotions: true },
            )
            return reconciled
          }
          if (attempted.status === "completed" && attempted.conclusion === "success") return attempted
          return attempted
        }
        if (landing.sha !== baseSha) {
          return failed(
            "stale-base",
            `queue '${branch}' moved from '${baseSha}' to '${landing.sha}' before the candidate could land`,
          )
        }
        if (attempted.status === "completed" && attempted.conclusion === "failure") return attempted
        if (attempted.status === "waiting") throw new Error("native merge cannot wait")
        return failed("merge-verification-failed", `merged '${branch}' does not contain '${missing}'`)
      }
      return await withComponentMainPromotions(git, repo, checked.baseSha, checked.candidateSha, async () => {
        const checkedOut = await checkedOutWorktree(git, repo, base.branchRef)
        if (checkedOut !== undefined) {
          const status = await git.run(checkedOut, ["status", "--porcelain"])
          if (status.stdout !== "") return failed("dirty-base", status.stdout)
          if ((await git.commit(checkedOut, "HEAD")) !== baseSha) return failed("stale-base", `${branch} moved`)
          const cancellation = mergeAuthorityCancellation(context)
          if (cancellation !== undefined) return cancellation
          await recordLandingAttempt(git, repo, input, context, checked)
          const moved = await git.run(checkedOut, ["merge", "--ff-only", checked.candidateSha], true)
          if (moved.code !== 0) {
            await clearLandingAttempts(git, repo, input, checked)
            return failed("stale-base", moved.stderr || "base branch moved")
          }
          const aligned = await materializeSubmodules(git, { worktree: checkedOut, referenceWorktree: repo })
          if (aligned.code !== 0) {
            const rolledBack = await git.run(checkedOut, ["reset", "--merge", baseSha], true)
            const restored = await materializeSubmodules(git, { worktree: checkedOut, referenceWorktree: repo })
            if (rolledBack.code !== 0 || restored.code !== 0) {
              return failed(
                "merge-rollback-failed",
                [aligned.stderr, rolledBack.stderr, restored.stderr].filter((detail) => detail !== "").join("\n"),
              )
            }
            await clearLandingAttempts(git, repo, input, checked)
            const detail = aligned.stderr || aligned.stdout || "could not align merged candidate submodules"
            return candidateSubmodulesFailure(git, repo, detail)
          }
          const sourceRefError = await sourceCandidateRefError(git, repo, checked.sourceRewrites ?? [])
          if (sourceRefError !== undefined) {
            const rolledBack = await git.run(checkedOut, ["reset", "--merge", baseSha], true)
            const restored = await materializeSubmodules(git, { worktree: checkedOut, referenceWorktree: repo })
            if (rolledBack.code !== 0 || restored.code !== 0) {
              return failed(
                "merge-rollback-failed",
                [rolledBack.stderr, restored.stderr].filter((detail) => detail !== "").join("\n"),
              )
            }
            await clearLandingAttempts(git, repo, input, checked)
            return failed("invalid-candidate", sourceRefError)
          }
        } else {
          const cancellation = mergeAuthorityCancellation(context)
          if (cancellation !== undefined) return cancellation
          await recordLandingAttempt(git, repo, input, context, checked)
          const expected = base.local ? baseSha : "0".repeat(baseSha.length)
          const moved = await git.run(repo, ["update-ref", base.branchRef, checked.candidateSha, expected], true)
          if (moved.code !== 0) {
            await clearLandingAttempts(git, repo, input, checked)
            return failed("stale-base", moved.stderr || "base branch moved")
          }
        }
        return withComponentMainPromotions(
          git,
          repo,
          undefined,
          checked.candidateSha,
          async (promotions, receipts) => {
            const settlement = await applyComponentMainPromotions(git, promotions, receipts)
            if (settlement.status === "failed") return componentMainFailureResult(settlement.error)
            return {
              status: "completed",
              conclusion: "success",
              output: await physicalIntegrationProof(
                git,
                repo,
                input,
                context,
                checked.candidateSha,
                checked,
                settlement.receipts,
              ),
            }
          },
          { settleSafePromotions: true },
        )
      })
    } catch (cause) {
      const classified = await stepInfrastructureFailure(git, repo, cause)
      if (classified !== undefined) return classified
      return failed("merge-failed", messageOf(cause))
    }
  }
}

export function configuredMergeStep<Shape extends PRShape>(
  options: ConfiguredMergeOptions,
): StepRunner<Shape, IntegrationProof> {
  const repo = resolve(options.repo)
  const git = createGit(options.inject.process, options.env)
  const merge = async (input: StepExecution<Shape>, context: JobContext): Promise<JobResult<IntegrationProof>> => {
    try {
      const branch = primaryPR(input).base
      const candidate = await mergeCandidate(git, repo, input, context, {
        artifactRoot: options.artifactRoot,
        ...(options.refuse === undefined ? {} : { refuse: options.refuse }),
      })
      if (candidate.status !== "completed" || candidate.conclusion !== "success") return candidate
      const alreadyLanded = await alreadyLandedEvidence(git, repo, candidate.base.sha, candidate.checked)
      if (alreadyLanded !== undefined) {
        const cancellation = mergeAuthorityCancellation(context)
        if (cancellation !== undefined) return cancellation
        const recovering = (await landingAttemptRefs(git, repo, input, candidate.checked)).length > 0
        return await withComponentMainPromotions(
          git,
          repo,
          undefined,
          candidate.base.sha,
          async (promotions, receipts) => {
            const settlement = await applyComponentMainPromotions(git, promotions, receipts)
            if (settlement.status === "failed") return componentMainFailureResult(settlement.error)
            return {
              status: "completed",
              conclusion: "success",
              output: recovering
                ? await physicalIntegrationProof(
                    git,
                    repo,
                    input,
                    context,
                    candidate.base.sha,
                    candidate.checked,
                    settlement.receipts,
                  )
                : integrationProof(candidate.base.sha, candidate.checked, alreadyLanded, settlement.receipts),
            }
          },
          { settleSafePromotions: true },
        )
      }
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

      return await withComponentMainPromotions(
        git,
        repo,
        candidate.checked.baseSha,
        candidate.checked.candidateSha,
        async () => {
          const cancellation = mergeAuthorityCancellation(context)
          if (cancellation !== undefined) return cancellation
          await recordLandingAttempt(git, repo, input, context, candidate.checked)
          const outcome = await command(input, context)
          let landing: GitQueueTarget
          try {
            landing = await authoritativeQueueBase(git, repo, branch)
          } catch (cause) {
            const refusal = queueAuthorityRefusal(cause)
            if (refusal !== undefined) {
              return failedWithEvidence(
                failureFact(cause)?.code ?? "queue-environment-refused",
                messageOf(cause),
                refusal,
              )
            }
            return outcome.status === "completed" && outcome.conclusion === "failure"
              ? failed(outcome.error.code, outcome.error.message)
              : failed("merge-verification-failed", messageOf(cause))
          }
          const missing = await landingError(git, repo, input, candidate.checked, landing.sha)
          if (missing === undefined) {
            const sourceRefError = await sourceCandidateRefError(git, repo, candidate.checked.sourceRewrites ?? [])
            if (sourceRefError !== undefined) {
              const rollbackError = await rollbackQueueBase(git, repo, candidate.base, landing)
              if (rollbackError !== undefined) return failed("merge-rollback-failed", rollbackError)
              await clearLandingAttempts(git, repo, input, candidate.checked)
              return failed("invalid-candidate", sourceRefError)
            }
            return withComponentMainPromotions(
              git,
              repo,
              undefined,
              landing.sha,
              async (promotions, receipts) => {
                const settlement = await applyComponentMainPromotions(git, promotions, receipts)
                if (settlement.status === "failed") return componentMainFailureResult(settlement.error)
                return {
                  status: "completed",
                  conclusion: "success",
                  output: await physicalIntegrationProof(
                    git,
                    repo,
                    input,
                    context,
                    landing.sha,
                    candidate.checked,
                    settlement.receipts,
                  ),
                }
              },
              { settleSafePromotions: true },
            )
          }
          await clearLandingAttempts(git, repo, input, candidate.checked)
          if (outcome.status === "completed" && outcome.conclusion === "failure") {
            return failed(outcome.error.code, outcome.error.message)
          }
          if (outcome.status === "waiting") {
            return failed("merge-command-waited", "merge commands cannot leave a waiting external effect")
          }
          return failed(
            "merge-command-did-not-land",
            `merge command exited successfully but '${branch}' does not contain '${missing}'`,
          )
        },
      )
    } catch (cause) {
      const classified = await stepInfrastructureFailure(git, repo, cause)
      if (classified !== undefined) return classified
      return failed("merge-failed", messageOf(cause))
    }
  }
  return async (input, context): Promise<JobResult<IntegrationProof>> =>
    discloseStepFailure(
      options.artifactRoot ?? join(repo, ".git", "yrd", "artifacts"),
      input,
      context.attempt,
      await merge(input, context),
    )
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

function repositoryReceiptFailure(
  code: "repository-corrupt" | "repository-incomplete" | "unknown",
  message: string,
): never {
  throw createFailure({ kind: "infrastructure", code, message })
}

const LANDING_ATTEMPT_REF_ROOT = "refs/yrd/landing-attempts"

function landingAttemptRef(input: StepExecution, context: JobContext): string {
  const safeJob = context.id.replace(/[^a-zA-Z0-9._-]/gu, "-")
  return `${LANDING_ATTEMPT_REF_ROOT}/${input.run}/${safeJob}/attempt-${context.attempt}`
}

async function recordLandingAttempt(
  git: Git,
  repo: string,
  input: StepExecution,
  context: JobContext,
  checked: PinnedCandidate,
): Promise<void> {
  const ref = landingAttemptRef(input, context)
  const zero = "0".repeat(checked.candidateSha.length)
  const recorded = await git.run(repo, ["update-ref", "--create-reflog", ref, checked.candidateSha, zero], true)
  if (recorded.code === 0 || (await git.optionalCommit(repo, ref)) === checked.candidateSha) return
  return repositoryReceiptFailure(
    "repository-corrupt",
    `yrd: landing attempt ref '${ref}' is already occupied by different evidence`,
  )
}

async function landingAttemptRefs(
  git: Git,
  repo: string,
  input: StepExecution,
  checked: PinnedCandidate,
): Promise<readonly string[]> {
  const prefix = `${LANDING_ATTEMPT_REF_ROOT}/${input.run}/`
  const listed = await git.run(repo, ["for-each-ref", "--format=%(objectname) %(refname)", prefix], true)
  if (listed.code !== 0) {
    return repositoryReceiptFailure(
      "repository-incomplete",
      `yrd: Queue run '${input.run}' landing attempts are unreadable: ${listed.stderr || listed.stdout}`,
    )
  }
  return listed.stdout === ""
    ? []
    : listed.stdout.split("\n").flatMap((line) => {
        const [sha, ref, extra] = line.split(/\s+/u)
        if (sha === undefined || ref === undefined || extra !== undefined) {
          return repositoryReceiptFailure(
            "repository-corrupt",
            `yrd: Queue run '${input.run}' landing attempt is malformed: ${line}`,
          )
        }
        if (sha !== checked.candidateSha) {
          return repositoryReceiptFailure(
            "repository-corrupt",
            `yrd: Queue run '${input.run}' landing attempt '${ref}' targets '${sha}', expected '${checked.candidateSha}'`,
          )
        }
        return [ref]
      })
}

async function clearLandingAttempts(
  git: Git,
  repo: string,
  input: StepExecution,
  checked: PinnedCandidate,
): Promise<void> {
  for (const ref of await landingAttemptRefs(git, repo, input, checked)) {
    const deleted = await git.run(repo, ["update-ref", "-d", ref, checked.candidateSha], true)
    if (deleted.code !== 0) {
      return repositoryReceiptFailure(
        "repository-corrupt",
        `yrd: confirmed receipt could not retire landing attempt '${ref}'`,
      )
    }
  }
}

async function physicalIntegrationProof(
  git: Git,
  repo: string,
  input: StepExecution,
  _context: JobContext,
  commit: string,
  checked: PinnedCandidate,
  componentMains: readonly ComponentMainReceipt[] = [],
): Promise<IntegrationProof> {
  await clearLandingAttempts(git, repo, input, checked)
  return integrationProof(commit, checked, undefined, componentMains)
}

function integrationProof(
  commit: string,
  checked: PinnedCandidate,
  alreadyLanded?: AlreadyLandedEvidence,
  componentMains: readonly ComponentMainReceipt[] = [],
): IntegrationProof {
  return IntegrationProofSchema.parse({
    commit,
    baseSha: commit,
    ...(alreadyLanded === undefined ? {} : { alreadyLanded }),
    ...(checked.sourceRewrites === undefined ? {} : { sourceRewrites: checked.sourceRewrites }),
    ...(checked.submoduleResolutions === undefined ? {} : { submoduleResolutions: checked.submoduleResolutions }),
    ...(componentMains.length === 0 ? {} : { componentMains }),
  })
}

function failed<Output extends JsonValue = JsonValue>(
  code: string,
  message: string,
  output?: Output,
): JobResult<Output> {
  return {
    status: "completed",
    conclusion: "failure",
    error: { code, message },
    ...(output === undefined ? {} : { output }),
  }
}

function failedWithEvidence(code: string, message: string, evidence: JsonValue): JobResult<never> {
  return { status: "completed", conclusion: "failure", error: { code, message, evidence } }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
