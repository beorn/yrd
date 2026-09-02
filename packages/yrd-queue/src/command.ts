import { createHash } from "node:crypto"
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve, sep } from "node:path"
import { createLogger } from "loggily"
import { authoredDeltaBase } from "@yrd/bay"
import {
  CheckpointMigrationManifestSchema,
  checkpointMigrationManifestHash,
  cherryFfInstruction,
  parseCherryVerbose,
  createFailure,
  digestCommandOutput,
  failureFact,
  firstJudgedFailureLine,
  markRecoverable,
  type CherryDragged,
  type JsonValue,
  type YrdFailure,
} from "@yrd/core"
import {
  INFRASTRUCTURE_SIGNAL_FAILURE_SUFFIX,
  JobErrorSchema,
  parseJobLaunch,
  type Job,
  type JobContext,
  type JobError,
  type JobResult,
} from "@yrd/job"
import {
  adaptProcessGit,
  gitSuperFailureDetail,
  withGitTimeoutRetry,
  type Process,
  type ProcessResult,
} from "@yrd/process"
import { readCommitSubmodules } from "git-super/commit-graph"
import { writeGitlink } from "git-super/gitlink"
import { ensureCommitObject } from "git-super/objects"
import { pushRefUpdates } from "git-super/push"
import { resolveSubmoduleOrigin } from "git-super/submodule-origin"
import * as z from "zod"
import type {
  AlreadyMergedEvidence,
  Candidate,
  SubmoduleMainOutcomes,
  SubmoduleMainResult,
  SubmoduleMainRefusal,
  CandidateChange,
  IntegrationProof,
  ChangeShape,
  ChangeSnapshot,
  SubmoduleModelChangeAuthorization,
  QueueSubmoduleResolutionEvidence,
  Run,
  SourceRewrite,
} from "./model.ts"
import {
  SubmoduleMainOutcomesSchema,
  CandidateChangeSchema,
  ChangeSnapshotSchema,
  SubmoduleModelChangeAuthorizationSchema,
  IntegrationProofSchema,
  QueueSubmoduleResolutionEvidenceSchema,
  SourceRewriteSchema,
} from "./model.ts"
import { candidateRefFor, sourceCandidateRefFor } from "./candidate-refs.ts"
import { submoduleMainScratchCleanupFailure } from "./submodule-main-outcome.ts"
import {
  CHECK_STORAGE_EXHAUSTED,
  checkStorageExhaustionMessage,
  describeScratchReap,
  isStorageExhaustion,
  liveWorktreeEntries,
  reapAgedArtifacts,
  queueScratchParent,
  reapOrphanedScratch,
  resolveArtifactRetentionMs,
  storageExhaustionError,
  storageExhaustionSighting,
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
  SUBMODULE_MAIN_REF,
  executeQueueSubmoduleComposition,
  planQueueSubmoduleComposition,
  resolveSubmoduleMain,
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
import { exactDelta } from "./content-identity.ts"
import {
  MERGE_RECORD_NOTES_NAME,
  MERGE_RECORD_REF,
  MERGE_RECORD_RETRACTION_NOTES_NAME,
  createMergeRecord,
  createMergeRecordRetraction,
  unprovableMergeRecordClaim,
  parseMergeRecordTolerant,
  parseMergeRecordRetraction,
  type MergeRecordBody,
  type MergeRecordPointer,
  type MergeRecordRetraction,
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

export const CheckpointMigrationAttestationSchema = z
  .object({
    version: z.literal(1),
    manifest: CheckpointMigrationManifestSchema,
    hash: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict()
  .superRefine((attestation, context) => {
    if (attestation.hash !== checkpointMigrationManifestHash(attestation.manifest)) {
      context.addIssue({ code: "custom", message: "checkpoint migration manifest hash does not match its data" })
    }
  })
export type CheckpointMigrationAttestation = Readonly<z.infer<typeof CheckpointMigrationAttestationSchema>>

export const GateCertificateSchema = z
  .object({
    version: z.literal(1),
    mode: GateModeSchema,
    baseSha: z.string().regex(/^[0-9a-f]{40,64}$/iu),
    candidateSha: z.string().regex(/^[0-9a-f]{40,64}$/iu),
    reports: z.array(GateReportSchema).min(1),
    checkpointMigration: CheckpointMigrationAttestationSchema.optional(),
  })
  .strict()
export type GateCertificate = Readonly<z.infer<typeof GateCertificateSchema>>

export const GATE_REPORT_TRAILER = "YRD-GATE-REPORT "
export const CHECKPOINT_MIGRATION_TRAILER = "YRD-CHECKPOINT-MIGRATION "
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
    checkpointMigration: CheckpointMigrationAttestationSchema.optional(),
    detail: z.string().optional(),
    diagnostics: z.array(CommandDiagnosticSchema).optional(),
    diagnosticsTruncated: z.literal(true).optional(),
    /** True when the command was settled by its wall-clock bound (21012 S1). */
    timedOut: z.boolean().optional(),
    stageVerdict: z.enum(["EXITED", "TIMED_OUT", "STALLED"]).optional(),
    /** The configured bound that produced `stageVerdict`, in ms: `noProgressTimeoutMs`
     * for STALLED, `timeoutMs` for TIMED_OUT. Absent for EXITED (no bound fired) or
     * when `stageVerdict` itself is absent — the two watchdogs share one wall-clock
     * failure shape upstream (a killed process, `timedOut: true`) and are otherwise
     * indistinguishable from durationMs alone, which only bounds the STALLED case
     * from below. */
    stageBoundMs: z.number().nonnegative().optional(),
    /** True when the check ran to its own exit AND stated a judged failure line
     * — the two halves that together make a red a verdict on the CONTENT rather
     * than a report about the run. Absent for a watchdog kill, an unreadable
     * red, and every pre-existing record. Consumers read this boolean; they must
     * never re-derive it by parsing the failure message back apart. */
    judgedFailure: z.literal(true).optional(),
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

/**
 * The small per-attempt fact stdout.log/stderr.log/output.log/error.json never
 * carried: whether the command produced a verdict at all, and what it was.
 * Written to `terminal.json` beside the streams so a reader holding only the
 * attempt directory — no journal, no queue access — can tell a green check
 * from one that never ran to completion (22896). `exitCode`/`signal` are
 * `null` together only when no process ever ran (the step refused before
 * spawning one); otherwise they are the process's own terminal facts,
 * independent of whatever business-logic verdict the step layered on top.
 *
 * `timedOut` alone answers only "did a wall-clock bound fire," collapsing the
 * no-progress watchdog and the ceiling timeout into the same `true` — the
 * PR2061-era ambiguity that cost hours reading exit 143 without knowing which
 * bound killed the process. `stageVerdict`/`stageBoundMs` carry the same
 * distinction {@link CommandEvidenceSchema} already resolves, onto this
 * narrower attempt-directory record. Both optional: a record from before this
 * field existed, or one for a step that never got as far as producing a
 * verdict, parses exactly as it did before.
 */
export const CommandTerminalSchema = z
  .object({
    status: z.enum(["success", "failure", "waiting"]),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    timedOut: z.boolean(),
    stageVerdict: z.enum(["EXITED", "TIMED_OUT", "STALLED"]).optional(),
    stageBoundMs: z.number().nonnegative().optional(),
    /** True when the check ran to its own exit AND stated a judged failure line
     * — the two halves that together make a red a verdict on the CONTENT rather
     * than a report about the run. Absent for a watchdog kill, an unreadable
     * red, and every pre-existing record. Consumers read this boolean; they must
     * never re-derive it by parsing the failure message back apart. */
    judgedFailure: z.literal(true).optional(),
    startedAt: z.string(),
    endedAt: z.string(),
    durationMs: z.number().nonnegative(),
  })
  .strict()
export type CommandTerminal = Readonly<z.infer<typeof CommandTerminalSchema>>

export const GitCheckComparisonEvidenceSchema = z
  .object({
    parent: CommandEvidenceSchema,
    netNewDiagnostics: z.array(CommandDiagnosticSchema),
    resolvedDiagnostics: z.array(CommandDiagnosticSchema),
    /** Exact parent/candidate intersection. Optional so journals written by
     * earlier Yrd revisions remain readable. */
    unchangedDiagnosticCount: z.number().int().nonnegative().optional(),
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
  componentModelChanges: z.array(SubmoduleModelChangeAuthorizationSchema).min(1).optional(),
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
  componentModelChanges: true,
  certificate: true,
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

export type ConfiguredCommandOptions<Shape extends ChangeShape> = ProcessDependency &
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

export type ConfiguredWaitingCommandOptions<Shape extends ChangeShape> = ConfiguredCommandOptions<Shape>

const RETIRED_PLACEHOLDERS = new Map([
  ["{name}", "$YRD_ISSUE"],
  ["{pr}", "$YRD_PR"],
  ["{changeset}", "$YRD_PR"],
  ["{sha}", "$YRD_SHA"],
  ["{target}", "$YRD_TARGET"],
  ["{base}", "$YRD_BASE"],
])

/** Command receipts belong under $GIT_DIR, never cwd/.yrd-artifacts — that
 * path is inside the working tree and freezes a fast-forward-only shared-main
 * projection. Fail loud when cwd is not a git work tree: a silent cwd fallback
 * would reintroduce the freeze. */
function defaultCommandArtifactRoot(cwd: string, process: Pick<Process, "run">): string {
  const probe = adaptProcessGit(process).readSync({
    repo: cwd,
    command: { verb: "rev-parse", args: ["--absolute-git-dir"] },
  })
  const gitDir = probe.stdout.trim()
  if (probe.code !== 0 || gitDir.length === 0) {
    throw createFailure({
      kind: "refusal",
      code: "artifact-root-unresolved",
      message: `yrd: cannot default artifactRoot — '${cwd}' is not a git work tree. Pass artifactRoot, or run from a repository.${probe.stderr.trim() ? ` git: ${probe.stderr.trim()}` : ""}`,
    })
  }
  return join(gitDir, "yrd", "artifacts")
}

export function configuredCommandStep<Shape extends ChangeShape>(
  options: ConfiguredCommandOptions<Shape>,
): StepRunner<Shape, CommandEvidence> {
  return configuredCommand(options, false)
}

export function configuredWaitingCommandStep<Shape extends ChangeShape>(
  options: ConfiguredWaitingCommandOptions<Shape>,
): StepRunner<Shape, CommandEvidence> {
  return configuredCommand(options, true)
}

function configuredCommand<Shape extends ChangeShape>(
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
    const artifactRoot = resolve(options.artifactRoot ?? defaultCommandArtifactRoot(cwd, process))
    await pruneArtifactsOnce(artifactRoot, options.env ?? globalThis.process.env)
    const artifactSink = await createArtifactSink(artifactRoot, input, context.attempt)
    const env = commandEnvironment(options.env ?? globalThis.process.env, variables, declaration)
    let result: Awaited<ReturnType<Process["run"]>>
    const startedAt = new Date().toISOString()
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
    const endedAt = new Date().toISOString()
    const artifacts = await artifactSink.finish(
      result.stdout,
      result.stderr,
      new Set((result.outputTruncation ?? []).map((entry) => entry.stream)),
    )
    const message = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter((part) => part !== "").join("\n")
    const detail = commandDetail(message)
    const diagnostics = commandDiagnostics(message)
    const gateReports = commandGateReports(message)
    const checkpointMigration = commandCheckpointMigration(message)
    const progress = result as typeof result & ProgressResult
    // The bound that actually fired, not both configured bounds: STALLED and
    // TIMED_OUT are mutually exclusive verdicts (yrd-process yields exactly one),
    // so naming the other stage's bound here would misattribute a failure to a
    // watchdog that never ran.
    const stageBoundMs =
      progress.verdict === "STALLED"
        ? options.noProgressTimeoutMs
        : progress.verdict === "TIMED_OUT"
          ? options.timeoutMs
          : undefined
    // The one fact the reject class turns on, decided HERE because this is the
    // only place both halves are in hand: the check itself STATED a judged
    // failure line, and no watchdog killed the process.
    //
    // Both halves are load-bearing. A red with no judged line is a check whose
    // verdict we cannot read — an infra fault, a crash, a harness that never
    // reported — and rejecting on it would dead-letter someone else's outage.
    // A watchdog kill (STALLED/TIMED_OUT) is definitionally not a verdict on
    // the content: the process never got to state one. Only a process that ran
    // to its own exit AND said what failed has judged the author's change.
    //
    // It is computed once, structurally, and read as a boolean. The read site
    // must never re-derive it by parsing this message back out of the record —
    // that string-parse-back is the anti-pattern `refusal-cure.ts` already is.
    // `timedOut` is checked as well as the verdict, not instead of it: a
    // process implementation that predates `verdict` still reports the
    // wall-clock kill, and `ProcessResult` only ties `stalled: true` to the
    // STALLED verdict, so that one needs no separate check here.
    //
    // A process whose own writes hit ENOSPC/EDQUOT is the third verdictless
    // shape, and the one that reads MOST like a verdict: the runner exits
    // non-zero and prints its failing test names, exactly as a judged red
    // does. Decided here from the same output, once, so the exit-code branch
    // below and this flag cannot disagree about whether the check judged.
    const storageExhausted = storageExhaustionSighting(message)
    const judgedFailure =
      storageExhausted === undefined &&
      firstJudgedFailureLine(message) !== undefined &&
      progress.verdict !== "STALLED" &&
      progress.verdict !== "TIMED_OUT" &&
      result.timedOut !== true
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
      ...(checkpointMigration.value === undefined ? {} : { checkpointMigration: checkpointMigration.value }),
      ...(detail === "" ? {} : { detail }),
      ...(diagnostics.values.length === 0 ? {} : { diagnostics: diagnostics.values }),
      ...(diagnostics.truncated ? { diagnosticsTruncated: true as const } : {}),
      ...(result.timedOut ? { timedOut: true } : {}),
      ...(progress.verdict === undefined ? {} : { stageVerdict: progress.verdict }),
      ...(stageBoundMs === undefined ? {} : { stageBoundMs }),
      ...(judgedFailure ? { judgedFailure: true as const } : {}),
      ...(progress.lastProgressAtMs === undefined ? {} : { lastProgressAtMs: progress.lastProgressAtMs }),
      ...(progress.lastProgressBytes === undefined ? {} : { lastProgressBytes: progress.lastProgressBytes }),
      ...(result.sweepFailure === undefined ? {} : { sweepFailure: result.sweepFailure }),
      ...(progress.escapedDescendant === true ? { escapedDescendant: true } : {}),
    })
    // Classification is decided once, here, and the terminal record is written
    // from its OUTCOME — never re-derived from the raw process facts a second
    // time, which could silently disagree with the verdict a reader trusts
    // (22896). The inner logic is exactly what this function returned before;
    // wrapping it only adds the one write point every branch now shares.
    const outcome = ((): JobResult<CommandEvidence> => {
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
          `${options.purpose}${INFRASTRUCTURE_SIGNAL_FAILURE_SUFFIX}`,
          `${options.purpose} command ended by SIGKILL (exit ${result.exitCode}) before it produced a verdict`,
          evidence,
        )
      }
      if (gateReports.error !== undefined) {
        return failed(`${options.purpose}-gate-report-invalid`, gateReports.error, evidence)
      }
      if (checkpointMigration.error !== undefined) {
        return failed(`${options.purpose}-checkpoint-migration-invalid`, checkpointMigration.error, evidence)
      }
      if (result.exitCode !== 0) {
        const action = waiting ? "launcher" : "command"
        // Storage exhaustion INSIDE the check is infrastructure, never the
        // check's verdict: the runner's fixtures, git objects or tar extracts
        // could not be written, so nothing about the change was judged. Read
        // as `${purpose}-failed` it takes the author disposition and, with a
        // candidate in hand, retires the submission — measured 2026-09-01
        // 22:24 PDT on PR3159 and PR3175, both `affected-tests-failed` on
        // `Disk quota exceeded` from a full /tmp quota. Same bucket as the
        // scratch allocator's `worktree-storage-exhausted`, and the row
        // carries the cure (the path that filled, `yrd queue run --once`)
        // because the queue owner, not the author, is who acts on it.
        if (storageExhausted !== undefined) {
          return failed(
            CHECK_STORAGE_EXHAUSTED,
            checkStorageExhaustionMessage(options.purpose, storageExhausted, artifactSink.log),
            evidence,
          )
        }
        // An exit status is a fact about the process, never about the work.
        // `affected-tests command exited 1` was the WHOLE refusal PR2695/2696/
        // 2697 carried on 2026-08-29, while the two failing test names sat in
        // `output.log`; PR2699 buried a guard's own refusal sentence the same
        // way. Both halves of the cure are already in hand here — the line the
        // check itself judged on, and the file holding the rest.
        //
        // The judged line is quoted only when the output STATED one: a
        // fabricated headline is worse than none, because a reader acts on it
        // (the {@link firstJudgedFailureLine} contract). The artifact is named
        // unconditionally, and is the cure in its own right for a check whose
        // verdict this cannot recognize.
        const judged = firstJudgedFailureLine(message)
        return failed(
          `${options.purpose}${waiting ? "-launcher" : ""}-failed`,
          `${options.purpose} ${action} exited ${result.exitCode}` +
            (judged === undefined ? "" : `: ${judged}`) +
            `; full output: ${artifactSink.log}`,
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
    })()
    await writeTerminalRecord(artifactRoot, input, context.attempt, {
      status: outcome.status === "waiting" ? "waiting" : outcome.conclusion,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      ...(progress.verdict === undefined ? {} : { stageVerdict: progress.verdict }),
      ...(stageBoundMs === undefined ? {} : { stageBoundMs }),
      ...(judgedFailure ? { judgedFailure: true as const } : {}),
      startedAt,
      endedAt,
      durationMs: result.durationMs,
    })
    return outcome
  }
}

function commandDetail(output: string): string {
  return digestCommandOutput(output, { limit: 2_000, head: 500 })
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

function commandCheckpointMigration(
  output: string,
): Readonly<{ value?: CheckpointMigrationAttestation; error?: string }> {
  let value: CheckpointMigrationAttestation | undefined
  for (const row of output.split(/\r?\n/u)) {
    const text = row.trim()
    if (!text.startsWith(CHECKPOINT_MIGRATION_TRAILER)) continue
    if (value !== undefined) {
      return { value, error: "configured command emitted more than one YRD-CHECKPOINT-MIGRATION trailer" }
    }
    try {
      value = CheckpointMigrationAttestationSchema.parse(JSON.parse(text.slice(CHECKPOINT_MIGRATION_TRAILER.length)))
    } catch {
      return { error: "configured command emitted a malformed YRD-CHECKPOINT-MIGRATION trailer" }
    }
  }
  return value === undefined ? {} : { value }
}

function commandDiagnostics(
  output: string,
  limit = 20,
): Readonly<{
  values: readonly CommandDiagnostic[]
  truncated: boolean
}> {
  const diagnostics: CommandDiagnostic[] = []
  for (const row of output.split(/\r?\n/u)) {
    const text = row.trim()
    // A porcelain status pair always has at least one non-space character;
    // without that requirement every line indented by two-plus spaces (vitest's
    // own test rows, for one) minted a phantom working-tree diagnostic.
    const changed = /^(?![ ]{2})[ MADRCU?!]{2}\s+(.+)$/u.exec(row)
    if (changed?.[1] !== undefined) {
      if (diagnostics.length >= limit) return { values: diagnostics, truncated: true }
      diagnostics.push({ file: changed[1], [sourceRowKey]: 1, message: "working tree changed during check" })
      continue
    }
    const match =
      /^(.*?)\((\d+),(\d+)\):\s*(.+)$/u.exec(text) ?? /^(.*?):(\d+)(?::(\d+))?\s*(?:-|:)\s*(.+)$/u.exec(text)
    if (match?.[1] === undefined || match[2] === undefined || match[4] === undefined) continue
    const rowNumber = Number(match[2])
    const column = match[3] === undefined ? undefined : Number(match[3])
    if (rowNumber < 1 || (column !== undefined && column < 1)) continue
    if (diagnostics.length >= limit) return { values: diagnostics, truncated: true }
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

function uniqueComparisonDiagnostics(values: readonly CommandDiagnostic[], cwd: string): readonly CommandDiagnostic[] {
  const seen = new Set<string>()
  const diagnostics: CommandDiagnostic[] = []
  for (const raw of values) {
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
 * habitant runner. Ambient exceptions must be declared via
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

async function completeComparisonDiagnostics(
  evidence: CommandEvidence,
  cwd: string,
): Promise<readonly CommandDiagnostic[]> {
  if (evidence.diagnosticsTruncated !== true) {
    return uniqueComparisonDiagnostics(evidence.diagnostics ?? [], cwd)
  }
  const streams = evidence.artifacts.filter(({ name }) => name === "stdout" || name === "stderr")
  if (streams.length === 0) throw new Error("truncated diagnostics have no retained stdout/stderr artifact")
  const values = (
    await Promise.all(
      streams.map(async ({ path }) => commandDiagnostics(await readFile(path, "utf8"), Infinity).values),
    )
  ).flat()
  if (values.length === 0) throw new Error("retained stdout/stderr artifacts contain no comparable diagnostics")
  return uniqueComparisonDiagnostics(values, cwd)
}

function compareCommandEvidence(
  parent: CommandEvidence,
  parentDiagnostics: readonly CommandDiagnostic[],
  candidate: CommandEvidence,
  candidateDiagnostics: readonly CommandDiagnostic[],
): GitCheckComparisonEvidence {
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
    unchangedDiagnosticCount: parentDiagnostics.filter((diagnostic) =>
      candidateIdentities.has(diagnosticIdentity(diagnostic)),
    ).length,
  })
}

function comparableCommandEvidence(outcome: JobResult<CommandEvidence>, purpose: string): CommandEvidence | undefined {
  if (outcome.status === "completed" && outcome.conclusion === "success") return outcome.output
  if (
    outcome.status === "completed" &&
    outcome.conclusion === "failure" &&
    outcome.error.code === `${purpose}-failed` &&
    outcome.output?.diagnostics !== undefined &&
    outcome.output.diagnostics.length > 0
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

/** See {@link CommandTerminalSchema}. Same attempt-directory addressing as
 * {@link writeTerminalArtifacts} and {@link createArtifactSink}, so the record
 * always merges beside the streams it describes rather than in a parallel store. */
async function writeTerminalRecord(
  root: string,
  input: StepExecution,
  attempt: number,
  record: CommandTerminal,
): Promise<void> {
  const dir = join(root, input.run, `${input.index}-${input.step}`, `attempt-${attempt}`)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "terminal.json"), `${JSON.stringify(CommandTerminalSchema.parse(record), undefined, 2)}\n`)
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
  /**
   * `truncated` names the streams whose in-memory capture is only a head and a
   * tail (`ProcessResult.outputTruncation`). For those, the STREAMED file is the
   * complete text and the passed-in string is deliberately shorter, so the
   * reconciliation below must not "repair" the file by overwriting it — that
   * would delete the only copy of the dropped middle, turning a loud truncation
   * back into silent evidence loss. Every other mismatch still overwrites: it
   * means the live write really did lose bytes.
   */
  const finish = async (
    stdout: string,
    stderr: string,
    truncated: ReadonlySet<ArtifactStream> = new Set<ArtifactStream>(),
  ): Promise<StepArtifact[]> => {
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
      if (streamedHash !== finalHash && !(truncated.has(name) && stream.seen)) {
        streamsMatch = false
        await writeFile(stream.path, content)
      }
      artifacts.push({ name, path: stream.path })
    }
    const fallback = [stdout, stderr].filter((content) => content !== "").join("")
    if (fallback === "") await rm(combined.path, { force: true })
    else if (!combined.seen || (!streamsMatch && truncated.size === 0)) await writeFile(combined.path, fallback)
    return artifacts
  }
  // `log` is published so a refusal can NAME the file holding the output it is
  // summarizing. `discloseStepFailure` guarantees this path exists for every
  // failed step (it writes a rendered failure there when the command produced
  // no output of its own), so naming it is never a promise the tree breaks.
  return Object.freeze({ drain, finish, write, log: combined.path })
}

const COMMAND_OUTPUT_LOGS = ["output.log", "stdout.log", "stderr.log"] as const

async function hasCommandOutput(dir: string): Promise<boolean> {
  for (const name of COMMAND_OUTPUT_LOGS) {
    const contents = await readFile(join(dir, name), "utf8").catch(() => "")
    if (contents !== "") return true
  }
  return false
}

async function hasTerminalRecord(dir: string): Promise<boolean> {
  return readFile(join(dir, "terminal.json"))
    .then(() => true)
    .catch(() => false)
}

/** Human-readable rendering of a typed step failure, for operators reading the
 * attempt directory rather than the journal. `output` is the step's own result
 * payload (CommandEvidence for a configured command) — passed separately from
 * `error` because `stageVerdict`/`stageBoundMs` live there, not nested under
 * `error.evidence` (see {@link failed}). */
export function renderStepFailure(error: JobError, output?: JsonValue): string {
  const lines = [`yrd: step failed with '${error.code}'`, "", error.message]
  const evidence = jsonRecord(output)
  if (typeof evidence?.stageVerdict === "string") {
    const bound = typeof evidence.stageBoundMs === "number" ? ` (bound ${evidence.stageBoundMs}ms)` : ""
    lines.push("", `watchdog verdict: ${evidence.stageVerdict}${bound}`)
  }
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
      await writeFile(join(dir, "output.log"), renderStepFailure(result.error, result.output))
    }
    // A step that refused before any command ran gets no terminal record from
    // configuredCommand — there was no process to report on — so this is the
    // ONLY place that outcome is ever written down (22896). Never clobber one
    // a command already wrote: that record's exitCode/signal/timing are real
    // process facts this disclosure has none of.
    if (!(await hasTerminalRecord(dir))) {
      const disclosedAt = new Date().toISOString()
      await writeTerminalRecord(root, input, attempt, {
        status: "failure",
        exitCode: null,
        signal: null,
        timedOut: false,
        startedAt: disclosedAt,
        endedAt: disclosedAt,
        durationMs: 0,
      })
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
// Queue git operations (re-merge rebases, worktree admin, merges) lock the shared
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
  incoming: Pick<Process, "run">,
  environment: NodeJS.ProcessEnv = globalThis.process.env,
  options: Readonly<{ noLazyFetch?: boolean }> = {},
) {
  const process = withGitTimeoutRetry(incoming)
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
      })
    } catch (cause) {
      // Failing to START git is not the same event as git failing, and until now only the second
      // one was survivable: every call passes `cwd: repo` as well as `git -C repo`, so a directory
      // that does not exist makes posix_spawn throw ENOENT before git runs. `allowFailure` promises
      // its callers a RESULT to classify — a tolerant probe of an unmaterialized submodule checkout
      // was instead killing the whole process (the recovery scan that meets exactly that estate).
      // Same treatment as the timeout below: a failed result for tolerant callers, a named throw
      // for the rest.
      const detail = cause instanceof Error ? cause.message : String(cause)
      const message = `yrd: git ${args.join(" ")} could not be started in '${repo}': ${detail}`
      if (!allowFailure) {
        // Preserve an underlying classification (e.g. yrd-process's
        // process-closed, thrown when a shutdown-in-progress pool refuses new
        // work) through this wrap. The contextual "could not be started in"
        // message is strictly more useful than the bare original, but a
        // caller further up the chain — the habitant's own mid-cycle recovery
        // classifier chief among them — must still be able to recognize WHAT
        // kind of failure this was without parsing prose (2026-08-31 SIGINT teardown race).
        const fact = failureFact(cause)
        throw fact === undefined ? new Error(message, { cause }) : createFailure({ ...fact, message }, cause)
      }
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
      // nonzero-code handling absorbs. Throwing here escaped past the re-merge
      // refusal paths and killed the habitant runner (2026-07-23 incident).
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
    execute(repo, args, allowFailure, true, false, timeoutMs)
  const raw = (repo: string, args: readonly string[], allowFailure = false): Promise<GitResult> =>
    execute(repo, args, allowFailure, false)
  const probe = (repo: string, args: readonly string[]): Promise<GitResult> => execute(repo, args, true, true, true)
  const rawProbe = (repo: string, args: readonly string[]): Promise<GitResult> => execute(repo, args, true, false, true)
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

async function writeQueueGitlink(git: Pick<Git, "process" | "env">, repo: string, path: string, commit: string) {
  return writeGitlink({
    repo,
    path,
    commit,
    git: adaptProcessGit(git.process, { env: git.env, timeoutMs: GIT_TIMEOUT_MS }),
  })
}

function queueGitlinkWriteSucceeded(result: Awaited<ReturnType<typeof writeGitlink>>): boolean {
  return result.state === "updated" || result.state === "unchanged"
}

function queueGitlinkWriteFailure(result: Awaited<ReturnType<typeof writeGitlink>>): string {
  return gitSuperFailureDetail(result)?.message ?? `git-super gitlink write ended as ${result.state}`
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
  const mergedCommit = run.integration?.commit
  // A merge whose result IS its own base joined nothing to history. Recording a
  // generated commit for it is not an approximation, it is a false claim: nothing
  // is reachable from a commit that was never created, so the record can never
  // prove itself and poisons every later verification of the estate. Claiming no
  // commits is the TRUE fact about such a merge, not a fallback — this is the
  // shape the shaset model makes a first-class outcome.
  const joinedHistory = !(result === "merged" && mergedCommit !== undefined && mergedCommit === candidate.baseSha)
  return {
    merge: {
      id: run.id,
      base: run.base,
      baseSha: candidate.baseSha,
      candidate: run.candidateId,
      result,
      ...(mergedCommit === undefined ? {} : { mergedCommit }),
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
        ...(generated === undefined || !joinedHistory ? {} : { generatedCommit: generated.generatedCommit }),
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
      candidateSha === undefined
        ? []
        : (await rawPayload(git, options.repo, candidate.baseSha, candidateSha)).gitlinks.map((entry) => entry.path)
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
    // Backstop, not the fix. `mergeRecordBody` cannot construct this contradiction
    // any more, so this can only fire if someone reintroduces it — and a merge
    // record is IMMUTABLE once written, so a false claim that escapes here is
    // permanent and wedges every later verification of the estate. Refuse to write
    // it rather than discover it years later from a `why` that answers nothing.
    const unprovable = unprovableMergeRecordClaim(body)
    if (unprovable !== undefined) {
      throw createFailure({
        kind: "infrastructure",
        code: "merge-record-unprovable-claim",
        message: `yrd: refusing to record ${unprovable}`,
      })
    }
    const remote = await synchronizeMergeRecordRef(git, options.repo, run.id)
    const record = createMergeRecord(body)
    const target = (await git.input(options.repo, ["hash-object", "-w", "--stdin"], `yrd merge ${run.id}\n`)).stdout
    const existing = await git.run(options.repo, ["notes", `--ref=${MERGE_RECORD_NOTES_NAME}`, "show", target], true)
    if (existing.code === 0) {
      // Tolerant on purpose: the existing note may have been written by a newer checkout.
      // A record this reader cannot read at all is still refused loudly (below); one that
      // reads but carries fields this schema does not recognize cannot be proven equivalent
      // to the record we are about to write, so it is refused too — the all-or-nothing
      // equivalence check survives unchanged, only the DIAGNOSIS improves.
      const parsed = parseMergeRecordTolerant(existing.stdout)
      if (parsed.outcome === "unreadable") {
        throw new Error(
          `yrd: merge '${run.id}' has an existing merge record this checkout cannot read: ${parsed.reason}`,
        )
      }
      if (
        parsed.outcome === "ok-with-unknown-fields" ||
        createMergeRecord(parsed.envelope.record).canonical !== record.canonical
      ) {
        const skew =
          parsed.outcome === "ok-with-unknown-fields"
            ? ` (equivalence cannot be proven: the existing record carries field(s) this checkout does not ` +
              `recognize — ${parsed.unknownFields.join(", ")})`
            : ""
        throw new Error(`yrd: merge '${run.id}' already has a different immutable merge record${skew}`)
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
      // Only an EXACT read (no unknown fields) is accepted as proof the race already
      // published this same record — see the equivalence note above.
      const racedParsed = raced.code === 0 ? parseMergeRecordTolerant(raced.stdout) : undefined
      if (
        racedParsed?.outcome === "ok" &&
        createMergeRecord(racedParsed.envelope.record).canonical === record.canonical
      ) {
        return
      }
      throw new Error(`yrd: merge record for '${run.id}' could not be published: ${added.stderr || added.stdout}`)
    }
    await publishMergeRecordRef(git, options.repo, run.id, remote)
  }
}

export type RepositoryMergeRecord = Readonly<{
  record: MergeRecordBody
  pointer: MergeRecordPointer
  /** Present when this record parsed tolerantly: checksum-authentic, but carrying one or
   * more fields a newer writer added that this checkout's schema does not recognize (and
   * therefore does not reflect in `record`). Never silently dropped — this is the report. */
  unknownFields?: readonly string[]
}>
/** One listed note the scan could not turn into verified truth, kept per record so a damaged
 * estate reports what it lost instead of losing the whole scan. */
export type UnverifiableMergeRecord = Readonly<{
  note: string
  status: "repository-incomplete" | "repository-corrupt"
  reason: string
  /** Which producer class this record came from, so a repair can report the estate
   * by cause instead of as one undifferentiated pile. */
  classification: MergeRecordRetraction["classification"]
  /** Present only when the record PARSED. A retraction binds by note blob sha, so
   * these are for reporting and for the audit trail — a record too damaged to parse
   * can still be retracted, which is the point of binding on the blob. */
  merge?: string
  checksum?: string
}>
/** A record that could not prove itself AND has an appended retraction confessing it.
 * Reported, never hidden: the estate stays honest about what it gave up on. */
export type RetractedMergeRecord = Readonly<{
  note: string
  reason: string
  retraction: MergeRecordRetraction
}>
export type RepositoryMergeRecordSearchResult =
  | Readonly<{
      status: "proven"
      records: readonly RepositoryMergeRecord[]
      /** Always empty unless the caller asked for per-record isolation. */
      unverifiable: readonly UnverifiableMergeRecord[]
      /** Records excused by an appended retraction. Never silently dropped. */
      retracted: readonly RetractedMergeRecord[]
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
/**
 * Read the appended retractions, keyed by the note blob they retract.
 *
 * Keying on the note BLOB sha is what makes a retraction unforgeable: a blob sha
 * is a content hash, so a retraction can only ever excuse the exact bytes it
 * names. It also keeps working for a record too damaged to parse, which is
 * precisely the record most likely to need retracting.
 *
 * An absent or unreadable retraction ref is not an error — an estate that has
 * never been repaired simply has none — but a retraction note that exists and
 * cannot be parsed IS reported, because silently ignoring it would let a broken
 * repair look like a healthy estate.
 */
async function readMergeRecordRetractions(
  git: ReturnType<typeof createGit>,
  repo: string,
): Promise<ReadonlyMap<string, MergeRecordRetraction>> {
  const listed = await git.run(repo, ["notes", `--ref=${MERGE_RECORD_RETRACTION_NOTES_NAME}`, "list"], true)
  const retractions = new Map<string, MergeRecordRetraction>()
  if (listed.code !== 0 || listed.stdout === "") return retractions
  for (const line of listed.stdout.split("\n")) {
    const [, target] = line.split(/\s+/u)
    if (target === undefined) continue
    const shown = await git.run(repo, ["notes", `--ref=${MERGE_RECORD_RETRACTION_NOTES_NAME}`, "show", target], true)
    if (shown.code !== 0) continue
    const retraction = parseMergeRecordRetraction(shown.stdout)
    retractions.set(retraction.note, retraction)
  }
  return retractions
}

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
    const corrupt = (
      reason: string,
      detail: Readonly<{
        classification?: MergeRecordRetraction["classification"]
        merge?: string
        checksum?: string
      }> = {},
    ): VerifiedListing =>
      ({
        outcome: "unverifiable",
        note: note ?? line,
        status: "repository-corrupt",
        reason,
        classification: detail.classification ?? "other",
        ...(detail.merge === undefined ? {} : { merge: detail.merge }),
        ...(detail.checksum === undefined ? {} : { checksum: detail.checksum }),
      }) as const
    if (note === undefined || target === undefined || extra !== undefined) {
      return {
        outcome: "unverifiable",
        note: line,
        status: "repository-corrupt",
        reason: `malformed merge-record listing: ${line}`,
        classification: "unreadable",
      }
    }
    const shown = await git.run(options.repo, ["notes", `--ref=${MERGE_RECORD_NOTES_NAME}`, "show", target], true)
    if (shown.code !== 0) return corrupt(`merge-record '${note}' is unreadable`, { classification: "unreadable" })
    // Tolerant on purpose: this is the bulk estate scan the tolerant-loader work exists
    // for. A note this checkout cannot read at all is still corrupt (below); a note that
    // is checksum-authentic but carries fields a newer writer added is NOT corrupt, and
    // misclassifying it as such would have been the checksum trap — see
    // `parseMergeRecordTolerant`'s doc comment for why re-hashing a stripped copy is wrong.
    const tolerant = parseMergeRecordTolerant(shown.stdout)
    if (tolerant.outcome === "unreadable") {
      return corrupt(`merge-record '${note}' is invalid: ${tolerant.reason}`, { classification: "unreadable" })
    }
    const parsed = tolerant.envelope
    const unknownFields = tolerant.outcome === "ok-with-unknown-fields" ? tolerant.unknownFields : undefined
    const expectedTarget = (
      await git.input(options.repo, ["hash-object", "--stdin"], `yrd merge ${parsed.record.merge.id}\n`)
    ).stdout
    if (target !== expectedTarget) {
      return corrupt(`merge-record '${note}' has the wrong attempt anchor '${target}'`, {
        merge: parsed.record.merge.id,
        checksum: parsed.checksum,
      })
    }
    if (parsed.record.merge.result === "merged") {
      const merged = parsed.record.merge.mergedCommit
      if (
        merged === undefined ||
        (await git.run(options.repo, ["merge-base", "--is-ancestor", merged, options.baseSha], true)).code !== 0
      ) {
        return corrupt(`merge-record '${note}' does not prove a merge on base`, {
          merge: parsed.record.merge.id,
          checksum: parsed.checksum,
        })
      }
      for (const change of parsed.record.changes) {
        if (change.generatedCommit === undefined || change.changeId === undefined) continue
        // TWO independent claims, diagnosed separately. Collapsing them into one
        // refusal produced a message that named the Change-Id — which is the half
        // that VERIFIES whenever reachability is what broke — and so pointed every
        // reader at the wrong cause. A refusal must name the half that failed.
        const reachable = await git.run(
          options.repo,
          ["merge-base", "--is-ancestor", change.generatedCommit, merged],
          true,
        )
        if (reachable.code !== 0) {
          return corrupt(
            `merge-record '${note}' cannot prove REACHABILITY for ${change.pr}: generated commit ` +
              `'${change.generatedCommit}' is not contained by recorded mergedCommit '${merged}' ` +
              `(the Change-Id trailer was not the problem). Change-Id ${change.changeId}`,
            {
              classification: "unreachable-generated-commit",
              merge: parsed.record.merge.id,
              checksum: parsed.checksum,
            },
          )
        }
        const trailers = await git.run(
          options.repo,
          ["show", "-s", "--format=%(trailers:key=Change-Id,valueonly)", change.generatedCommit],
          true,
        )
        if (trailers.code !== 0) {
          return corrupt(
            `merge-record '${note}' cannot READ the Change-Id trailer of generated commit ` +
              `'${change.generatedCommit}' for ${change.pr}: ${trailers.stderr || trailers.stdout}`,
            { merge: parsed.record.merge.id, checksum: parsed.checksum },
          )
        }
        if (trailers.stdout !== change.changeId) {
          return corrupt(
            `merge-record '${note}' cannot prove the CHANGE-ID for ${change.pr}: generated commit ` +
              `'${change.generatedCommit}' carries '${trailers.stdout || "<no trailer>"}', ` +
              `record claims '${change.changeId}' (reachability verified)`,
            {
              classification: "change-id-mismatch",
              merge: parsed.record.merge.id,
              checksum: parsed.checksum,
            },
          )
        }
      }
      for (const pin of parsed.record.pins) {
        const current = await readGitlink(git, options.repo, options.baseSha, pin.path)
        if (current === undefined) {
          return corrupt(`merge-record '${note}' lost gitlink '${pin.path}'`, {
            merge: parsed.record.merge.id,
            checksum: parsed.checksum,
          })
        }
        if (current === pin.after) continue
        const submodule = await submoduleCheckout(git, options.repo, pin.path)
        if (submodule === undefined) {
          return {
            outcome: "unverifiable",
            note,
            status: "repository-incomplete",
            reason: `merge-record '${note}' cannot inspect submodule checkout '${pin.path}'`,
            classification: "other",
            merge: parsed.record.merge.id,
            checksum: parsed.checksum,
          }
        }
        if (!(await isAncestor(git, submodule, pin.after, current))) {
          return corrupt(
            `merge-record '${note}' pin '${pin.after}' is not contained by '${pin.path}' at '${current}'`,
            {
              merge: parsed.record.merge.id,
              checksum: parsed.checksum,
            },
          )
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
        ...(unknownFields === undefined ? {} : { unknownFields }),
      },
    }
  }

  const records: RepositoryMergeRecord[] = []
  const unverifiable: UnverifiableMergeRecord[] = []
  const retracted: RetractedMergeRecord[] = []
  const retractions = await readMergeRecordRetractions(git, options.repo)
  for (const line of listed.stdout === "" ? [] : listed.stdout.split("\n")) {
    const listing = await verifyListing(line)
    if (listing.outcome === "verified") {
      records.push(listing.record)
      continue
    }
    if (listing.outcome === "filtered") continue
    // TAUGHT, NOT RELAXED. A record with an appended retraction no longer makes the
    // estate unprovable — but it does not become proven truth either. It is excused
    // and REPORTED. The all-or-nothing contract is untouched for everything else:
    // one unretracted bad record still refuses the whole single-selector verdict.
    const retraction = retractions.get(listing.note)
    if (retraction !== undefined) {
      retracted.push({ note: listing.note, reason: listing.reason, retraction })
      continue
    }
    if (options.isolateUnverifiable !== true) return { status: listing.status, reason: listing.reason }
    unverifiable.push({
      note: listing.note,
      status: listing.status,
      reason: listing.reason,
      classification: listing.classification,
      ...(listing.merge === undefined ? {} : { merge: listing.merge }),
      ...(listing.checksum === undefined ? {} : { checksum: listing.checksum }),
    })
  }
  // Records that exist but could not be verified are never "missing": reporting them as an empty
  // estate would hand the caller a clean-looking zero for a repository that just failed to prove
  // itself. A retracted record counts as existing for the same reason.
  if (records.length === 0 && unverifiable.length === 0 && retracted.length === 0) {
    return { status: "not-proven", reason: "merge-record-missing" }
  }
  return { status: "proven", records, unverifiable, retracted }
}

/** One record the estate cannot prove, and the retraction that would excuse it. */
export type MergeRecordRetractionPlan = Readonly<{
  note: string
  reason: string
  classification: MergeRecordRetraction["classification"]
  merge?: string
  checksum?: string
}>

export type MergeRecordEstateRepair = Readonly<{
  /** Records that verified on their own. */
  proven: number
  /** Records already excused by an existing retraction. */
  alreadyRetracted: number
  /** Every record that cannot prove itself and is not yet retracted — ALL of them,
   * never just the first, because the estate holds more than one producer class. */
  planned: readonly MergeRecordRetractionPlan[]
  /** Note shas actually written. Empty unless `apply` was set. */
  applied: readonly string[]
}>

/**
 * Enumerate every unprovable merge record, and optionally retract them.
 *
 * Read-only by default: planning and applying are separate so an operator can see
 * the whole estate before changing any of it. Nothing is ever edited — a
 * retraction is a new note on a separate ref, and the record it excuses stays
 * byte-identical.
 *
 * The enumeration is deliberately EXHAUSTIVE. `yrd why` refuses from a partially
 * verified estate on purpose, and that contract is untouched; but a repair that
 * fixed only the first failure would hand back an estate that still refuses, with
 * no indication that more remained. There are at least two producer classes on
 * record (an unreachable generated commit, and a missing Change-Id trailer), so
 * first-failure-only is not a hypothetical shortfall.
 *
 * `now` is a parameter rather than a clock read so the caller owns the timestamp
 * and the result stays reproducible under test.
 */
export async function repairMergeRecordEstate(
  options: Readonly<{
    inject: Readonly<{ process: Pick<Process, "run"> }>
    repo: string
    baseSha: string
    now: string
    apply?: boolean
  }>,
): Promise<MergeRecordEstateRepair> {
  const found = await findRepositoryMergeRecords({
    inject: options.inject,
    repo: options.repo,
    baseSha: options.baseSha,
    isolateUnverifiable: true,
  })
  // An estate with no records at all is not a fault; it is a repository that has
  // never merged anything through the queue.
  if (found.status === "not-proven") return { proven: 0, alreadyRetracted: 0, planned: [], applied: [] }
  if (found.status !== "proven") {
    // `isolateUnverifiable` cannot return a whole-estate refusal, so anything else
    // is the notes ref itself being unreadable — a different fault, and not one a
    // retraction can excuse. Say so rather than reporting an empty plan.
    throw createFailure({
      kind: "infrastructure",
      code: "merge-record-estate-unreadable",
      message: `yrd: cannot enumerate the merge-record estate: ${found.reason}`,
    })
  }

  const planned: MergeRecordRetractionPlan[] = found.unverifiable.map((entry) => ({
    note: entry.note,
    reason: entry.reason,
    classification: entry.classification,
    ...(entry.merge === undefined ? {} : { merge: entry.merge }),
    ...(entry.checksum === undefined ? {} : { checksum: entry.checksum }),
  }))

  if (options.apply !== true || planned.length === 0) {
    return { proven: found.records.length, alreadyRetracted: found.retracted.length, planned, applied: [] }
  }

  const git = createGit(options.inject.process)
  const applied: string[] = []
  for (const plan of planned) {
    const { canonical } = createMergeRecordRetraction({
      schema: "yrd/merge-record-retraction/v1",
      note: plan.note,
      reason: plan.reason,
      classification: plan.classification,
      retractedAt: options.now,
      ...(plan.merge === undefined ? {} : { merge: plan.merge }),
      ...(plan.checksum === undefined ? {} : { checksum: plan.checksum }),
    })
    // Anchored on the retracted note's own blob sha: always available, unique per
    // record, and meaningful even when the record is too damaged to name itself.
    const anchor = await git.input(options.repo, ["hash-object", "-w", "--stdin"], `yrd retract ${plan.note}\n`)
    const blob = await git.input(options.repo, ["hash-object", "-w", "--stdin"], canonical)
    const added = await git.run(
      options.repo,
      ["notes", `--ref=${MERGE_RECORD_RETRACTION_NOTES_NAME}`, "add", "-f", "-C", blob.stdout, anchor.stdout],
      true,
    )
    if (added.code !== 0) {
      throw createFailure({
        kind: "infrastructure",
        code: "merge-record-retraction-refused",
        message: `yrd: could not append a retraction for note '${plan.note}': ${added.stderr || added.stdout}`,
      })
    }
    applied.push(plan.note)
  }
  return { proven: found.records.length, alreadyRetracted: found.retracted.length, planned, applied }
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

export type ChangeRemergeInput = ChangeSnapshot &
  Readonly<{
    /** CLI-resolved immutable proposed tip (tracked delivery). Queue never resolves a symbolic proposal ref. */
    proposedHeadSha?: string
    current?: Readonly<{
      revision: number
      headSha: string
      baseSha?: string
      treeSha?: string
      patchId?: string
      fromRevision?: number
    }>
  }>

export type ChangeRemergeResult = Readonly<{
  headSha: string
  baseSha: string
  treeSha: string
  patchId: string
  unchanged: boolean
  /** Proposed-head records only: the proposed tip's patch equals the reviewed
   * source revision's patch, so an approval may carry across (patch
   * equivalence — the review-carry rule that replaced payload certificates). */
  reviewEquivalent?: boolean
}>

export type GitChangeRemerger = Readonly<{ recut(input: ChangeRemergeInput): Promise<ChangeRemergeResult> }>

export function createGitChangeRemerger(options: {
  inject: Readonly<{ process: Pick<Process, "run"> }>
  repo: string
  env?: NodeJS.ProcessEnv
}): GitChangeRemerger {
  const repo = resolve(options.repo)
  const git = createGit(options.inject.process, options.env)
  return Object.freeze({ recut: (input: ChangeRemergeInput) => remergeChange(git, repo, input) })
}

async function remergeChange(git: Git, repo: string, input: ChangeRemergeInput): Promise<ChangeRemergeResult> {
  if (input.proposedHeadSha !== undefined) {
    const recordGit = createGit(git.process, git.env, { noLazyFetch: true })
    const target = await inspectLiveQueueBase(recordGit, repo, input.base)
    if (target.diverged) {
      throw createFailure({
        kind: "refusal",
        code: "queue-environment-refused",
        message:
          `yrd: local '${target.branchRef}' and authoritative 'refs/remotes/origin/${target.branch}' differ; ` +
          `refresh or reconcile the target before recording change '${input.id}'`,
      })
    }
    return recordProposedHead(recordGit, repo, target, input, input.proposedHeadSha)
  }
  const target = await authoritativeQueueBase(git, repo, input.base)
  const current = input.current
  // An already-landed revision delivers nothing beyond the base, so its head
  // IS the base and `target..head` has no patch identity to short-circuit on.
  // Re-derive it from the immutable source instead of returning a stale
  // unchanged fast path (22373).
  const alreadyMergedDirect = current?.headSha === target.sha
  if (
    (current?.revision === input.revision || current?.fromRevision === input.revision) &&
    current.baseSha === target.sha &&
    current.treeSha !== undefined &&
    current.patchId !== undefined &&
    !alreadyMergedDirect
  ) {
    return {
      headSha: current.headSha,
      baseSha: target.sha,
      treeSha: current.treeSha,
      patchId: current.patchId,
      unchanged: true,
    }
  }
  return remergeDirectChangeByMerge(git, repo, target, input)
}

/**
 * Record a tracked branch's moved tip as the next revision's identity. The
 * certificate era re-proved the whole reviewed payload here; under the merge
 * model the candidate is rebuilt by merge at run time, so recording needs only
 * honest identities: the proposed head itself, its tree, and its plain patch
 * identity against the authoritative base. `reviewEquivalent` reports whether
 * the proposed tip's patch equals the reviewed source revision's patch; the
 * recorder carries an approval across only when it does.
 */
async function recordProposedHead(
  git: Git,
  repo: string,
  target: GitQueueTarget,
  input: ChangeRemergeInput,
  proposedHeadSha: string,
): Promise<ChangeRemergeResult> {
  if ((await git.optionalCommit(repo, proposedHeadSha)) !== proposedHeadSha) {
    throw createFailure({
      kind: "refusal",
      code: "proposed-commit-missing",
      message: `yrd: change '${input.id}' proposed commit '${proposedHeadSha}' is missing`,
    })
  }
  const tree = await git.run(repo, ["rev-parse", `${proposedHeadSha}^{tree}`], true)
  if (tree.code !== 0) throw new Error(`yrd: proposed commit '${proposedHeadSha}' has no readable tree`)
  const sourceBaseSha = input.baseSha
  const sourcePatchId =
    sourceBaseSha === undefined ? undefined : await git.stablePatchId(repo, sourceBaseSha, input.headSha)
  const proposedPatchId = await git.stablePatchId(repo, target.sha, proposedHeadSha)
  // An empty target..proposed diff means the payload is already contained;
  // fall back to the immutable source range's own identity, the same "fully
  // absorbed" convention the merge rebuild uses.
  const patchId = proposedPatchId ?? sourcePatchId
  if (patchId === undefined) {
    throw createFailure({
      kind: "refusal",
      code: "payload-certificate",
      message: `yrd: change '${input.id}' proposed head has no stable patch identity`,
    })
  }
  const current = input.current
  const unchanged =
    current !== undefined &&
    (current.revision === input.revision || current.fromRevision === input.revision) &&
    current.headSha === proposedHeadSha &&
    current.baseSha === target.sha &&
    current.treeSha === tree.stdout &&
    current.patchId === patchId
  return {
    headSha: proposedHeadSha,
    baseSha: target.sha,
    treeSha: tree.stdout,
    patchId,
    unchanged,
    reviewEquivalent: sourcePatchId !== undefined && sourcePatchId === proposedPatchId,
  }
}

type GitlinkEntry = Readonly<{ path: string; from: string; to: string }>
type RawPayload = Readonly<{ identity: string; paths: readonly string[]; gitlinks: readonly GitlinkEntry[] }>

async function rawPayload(
  git: Git,
  repo: string,
  from: string,
  to: string,
  pathspec?: readonly string[],
): Promise<RawPayload> {
  const identity = await changedPayloadIdentity(git, repo, from, to, pathspec)
  const fields = identity.split("\0")
  const paths: string[] = []
  const gitlinks: GitlinkEntry[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const header = fields[index]
    const path = fields[index + 1]
    if (header === undefined || header === "" || path === undefined || path === "") continue
    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) [A-Z]$/u.exec(header)
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined || match[4] === undefined) {
      throw new Error(`yrd: git diff --raw emitted an invalid record '${header}'`)
    }
    paths.push(path)
    if (match[1] === "160000" || match[2] === "160000") gitlinks.push({ path, from: match[3], to: match[4] })
  }
  return {
    identity,
    paths: paths.toSorted(),
    gitlinks: gitlinks.toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
  }
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

function queueRefusal(code: string, message: string): YrdFailure {
  return createFailure({ kind: "refusal", code, message: `yrd: ${message}` })
}

async function inspectLiveQueueBase(git: Git, repo: string, branch: string): Promise<GitQueueTarget> {
  const cached = await inspectQueueBase(git, repo, branch)
  const configuredRemote = await git.run(repo, ["config", "--get", "remote.origin.url"], true)
  if (configuredRemote.code !== 0 || configuredRemote.stdout === "") return cached

  const sourceRef = `refs/heads/${branch}`
  const inspected = await git.run(repo, ["ls-remote", "--exit-code", "origin", sourceRef], true)
  const live = /^([0-9a-f]{40,64})\s+refs\/heads\/.+$/iu.exec(inspected.stdout)?.[1]
  if (inspected.code !== 0 || live === undefined) {
    throw queueRefusal(
      "queue-environment-refused",
      `live 'origin/${branch}' could not be proved without mutating the repository`,
    )
  }
  if (cached.remoteSha !== live || (cached.localSha !== undefined && cached.localSha !== live)) {
    throw queueRefusal(
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
 * No `ConditionalLogger` reaches `reapOnce`: it runs from step bodies
 * (`JobHandler`s), and `JobContext` carries no logger — the job execution
 * layer around them does all lifecycle logging via `observeYrdLifecycle`
 * (@yrd/core), never handing it into the body. A successful reap is
 * routine, not a step outcome, so it does not belong on that lifecycle
 * line either way. This namespaced loggily logger — the same "yrd:queue"
 * namespace the rest of this package's log lines carry — is the minimal
 * fix for the one bug this site actually had: `console.warn` prints
 * unconditionally and no `--log-level`/`--quiet`/`LOG_LEVEL` can silence
 * it. A loggily logger honors all three; it does not yet inherit the
 * CLI's OWN resolved pipeline object (that needs a logger threaded through
 * `JobContext`, a larger change than one log line justifies).
 */
const scratchReapLog = createLogger("yrd:queue")

/**
 * The scratch entries git still lists as live worktrees. A queue worktree lives
 * at `<entry>/worktree`, so a listed path under the scratch root names its
 * entry's first segment; that is what separates an abandoned tree from one a
 * concurrent run is still using.
 */
/**
 * Sweep scratch abandoned by an earlier process, once per root per process.
 * Placed at creation rather than at queue-run startup so every entry point —
 * queue run, re-merge, patch-id, a direct step runner in a test host — pays for the
 * cleanup it might itself leave behind.
 */
async function reapOnce(git: Git, repo: string, root: string): Promise<void> {
  const key = resolve(root)
  if (reapedScratchRoots.has(key)) return
  reapedScratchRoots.add(key)
  const worktrees = await liveWorktreeEntries(git, repo, key)
  if (!worktrees.listed) {
    // The keep set is UNKNOWN, not empty. Reaping on it would delete a live
    // merge worktree on the strength of a git fault; skipping costs one sweep
    // and the next process sweeps again.
    scratchReapLog.warn?.(
      "queue skipped the abandoned-scratch sweep: 'git worktree list' could not answer, so which scratch " +
        "entries are still live is unknown and none can be safely removed",
      { action: "queue-scratch-reap-skipped", root: key, cause: "worktree-list-unreadable" },
    )
    return
  }
  const report = await reapOrphanedScratch(key, { keep: worktrees.live })
  if (report.reaped > 0 || report.failures.length > 0) {
    scratchReapLog.info?.(describeScratchReap(report), {
      action: "queue-scratch-reap",
      root: key,
      reaped: report.reaped,
      failures: report.failures.length,
    })
  }
}

/**
 * Prune run artifacts nothing has written for the retention floor, before this
 * step adds its own.
 *
 * Placed at the artifact WRITE site for the same reason `reapOnce` sits at the
 * scratch creation site: every entry point that can grow the store pays for
 * bounding it, and nothing else has to remember to schedule anything. The
 * gate inside `reapAgedArtifacts` is hourly rather than once-per-process
 * because the process that writes most artifacts is a resident that runs for
 * weeks — a once-per-process sweep would run at boot and never again.
 *
 * A prune failure is reported and swallowed deliberately: a step's verdict must
 * not depend on housekeeping. It is reported at `warn`, which is the level an
 * operator sees by default, because a store that cannot be pruned goes back to
 * growing without bound and nothing else would ever say so.
 */
async function pruneArtifactsOnce(root: string, environment: Readonly<Partial<Record<string, string>>>): Promise<void> {
  try {
    const report = await reapAgedArtifacts(root, { olderThanMs: resolveArtifactRetentionMs(environment) })
    // `undefined` is the hourly gate, not an empty sweep. Logging it as a
    // sweep would report a clean run for work that never happened.
    if (report === undefined) return
    const record =
      report.failures.length > 0 ? scratchReapLog.warn : report.reaped > 0 ? scratchReapLog.info : undefined
    record?.(describeScratchReap(report), {
      action: "queue-artifact-retention",
      root: report.root,
      scanned: report.entries,
      reaped: report.reaped,
      keptYoung: report.keptYoung,
      failed: report.failures.length,
      bytes: report.bytes,
    })
  } catch (cause) {
    scratchReapLog.warn?.(
      `yrd: could not prune run artifacts under '${root}', so the store keeps growing: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
      { action: "queue-artifact-retention-failed", root },
    )
  }
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
 * `withSubmoduleMainPromotions` prepared scratch on the same filesystem and
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
    gitProcess: adaptProcessGit(git.process, { env: git.env, timeoutMs: GIT_TIMEOUT_MS }),
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
}>

export type PinIntentProvisioner = (
  input: PinIntentProvisionInput,
) => Promise<Readonly<{ generatedPaths: readonly string[] }>>

type CandidatePreparation =
  | Readonly<{
      status: "passed"
      output: Readonly<{
        sha: string
        changes: readonly CandidateChange[]
        submoduleResolutions: readonly QueueSubmoduleResolutionEvidence[]
        componentModelChanges: readonly SubmoduleModelChangeAuthorization[]
      }>
    }>
  | CandidateFailure

/**
 * Prepare a candidate, naming the member that refused it.
 *
 * The preparation walks members in order and every refusal path returns from
 * inside that walk, so the guilty member is known exactly at the moment of
 * return and nowhere afterwards. Recording it in one cell at the top of each
 * iteration, and stamping it here, means a new refusal path added later is
 * attributed automatically — the alternative, editing every `return` site,
 * silently loses attribution the first time someone adds one.
 *
 * A refusal that already names a member keeps its own attribution.
 */
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
  authorizeSubmoduleModelChange?: SubmoduleModelChangeAuthorizer,
): Promise<CandidatePreparation> {
  const guilty: { id?: string } = {}
  const prepared = await prepareCandidateMembers(
    guilty,
    git,
    repo,
    path,
    authoritativeBase,
    input,
    attempt,
    artifactRoot,
    refuse,
    provisionPinIntent,
    authorizeSubmoduleModelChange,
  )
  if (prepared.status !== "failed" || guilty.id === undefined || prepared.error.pr !== undefined) return prepared
  return { ...prepared, error: { ...prepared.error, pr: guilty.id } }
}

async function prepareCandidateMembers(
  guilty: { id?: string },
  git: Git,
  repo: string,
  path: string,
  authoritativeBase: string,
  input: StepExecution,
  attempt: number,
  artifactRoot: string,
  refuse?: RefusePathsPolicy,
  provisionPinIntent?: PinIntentProvisioner,
  authorizeSubmoduleModelChange?: SubmoduleModelChangeAuthorizer,
): Promise<CandidatePreparation> {
  const submoduleResolutions: QueueSubmoduleResolutionEvidence[] = []
  const componentModelChanges: SubmoduleModelChangeAuthorization[] = []
  const changes: CandidateChange[] = []
  const recordChange = (pr: StepExecution["prs"][number], generatedCommit: string, containedInBase: boolean): void => {
    if (pr.intent !== undefined || pr.changeId === undefined) return
    changes.push(
      CandidateChangeSchema.parse({
        changeId: pr.changeId,
        pr: pr.id,
        revision: pr.revision,
        submittedHead: pr.headSha,
        generatedCommit,
        containedInBase,
      }),
    )
  }
  for (const pr of input.prs) {
    // The single write that makes every refusal below attributable.
    guilty.id = pr.id
    if (pr.intent !== undefined) {
      if (input.prs.length !== 1) {
        return candidateFailure(
          "intent-batch-refused",
          "yrd: changes of min commits are serial Queue members, never a batch",
        )
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
          `yrd: intent submodule '${pr.intent.authored.component}' is not a gitlink at '${authoritativeBase}'`,
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
    // Composed revisions are retired with the certificate-era rewrite
    // machinery. A member snapshot still declaring one (a certificate-era
    // record) must refuse loudly here — its head deliberately sits at the
    // base, so letting it fall through would "merge" it as an empty no-op and
    // silently drop its submodule payload.
    if (pr.composition !== undefined) {
      return candidateFailure(
        "composition-retired",
        `change '${pr.id}' declares a source composition; composed revisions are retired — ` +
          "submit the root change with its authored gitlink bumps instead (the queue fills the shaset from each submodule's main)",
      )
    }
    // A post-merge actuator retry carries the same immutable PR snapshot
    // against a base that already contains it. Nothing is left to merge, and
    // re-merging an already-contained head would only manufacture an empty
    // merge commit.
    //
    // This is the ONLY place the question "is this member already in the base?"
    // is put to git as a check that can answer no. It used to be asked, acted
    // on, and forgotten in the same breath — so every later consumer re-asked
    // it of the collapsed candidate, where `is-ancestor X X`,
    // `candidateSha === baseSha` and `tree(X) === tree(X)` all answer yes for
    // free. Recording it is what makes those consumers able to read a
    // measurement instead of a tautology.
    if (await isAncestor(git, path, pr.headSha, "HEAD")) {
      recordChange(pr, pr.headSha, true)
      continue
    }
    if (refuse !== undefined && refuse.paths.length > 0) {
      const inspected = await refusedPayloadPaths(git, path, pr.headSha, refuse.paths)
      if (inspected.status === "failed") return inspected
      if (inspected.output.length > 0) {
        const shown = inspected.output.slice(0, 8).join(", ") + (inspected.output.length > 8 ? ", …" : "")
        return candidateFailure(
          "refused-path",
          `change '${pr.id}' touches refused path(s) [${shown}]${refuse.reason === undefined ? "" : `; ${refuse.reason}`}`,
          ".",
          inspected.output,
        )
      }
    }
    let authoredFill:
      | Readonly<{
          updates: readonly GitlinkUpdate[]
          filledPins: readonly Extract<QueueSubmoduleResolutionEvidence, { kind: "pin" }>[]
        }>
      | undefined
    // First candidates only: a queue-rebuilt member (`pr.recut` set) already
    // ran this inspection and fill inside `rebuildCandidateByMerge`, and a
    // gitlink carrier bound for post-merge submodule-main promotion must not
    // be re-refused `min-commit-unpublished` here on re-verification.
    if (pr.recut === undefined) {
      const inspected = await authoredGitlinkPaths(git, path, pr.id, pr.headSha)
      if (inspected.status === "failed") return inspected
      if (inspected.output.length > 0) {
        // Step (b): an authored gitlink is a min commit, a floor. When every
        // one is on its submodule's main, the carrier composes, and after the
        // content merge below the queue writes the shaset commit that fills
        // each value in from that submodule's main. Added or deleted gitlinks
        // and min commits not on main keep the authored-gitlink refusal,
        // raised inside the fill helper.
        const filled = await fillAuthoredGitlinksFromMain(
          git,
          repo,
          path,
          pr,
          inspected.output,
          authorizeSubmoduleModelChange,
        )
        if (filled.status === "failed") return filled
        authoredFill = filled.output
        componentModelChanges.push(...filled.output.componentModelChanges)
      }
    }
    const before = await git.commit(path, "HEAD")
    const message = candidateChangeCommitMessage("merge", pr)
    const mergeArgs = ["merge", "--no-verify", "--no-ff", "-m", message, pr.headSha]
    const merged = await git.run(path, mergeArgs, true)
    if (merged.code !== 0) {
      const resolved = await resolveCandidateSubmoduleConflict(git, repo, path)
      if (resolved.status === "composed") {
        submoduleResolutions.push(...resolved.output)
        const wrapper = await stabilizeGeneratedRootWrapper(git, path, before, message)
        if (wrapper !== undefined) return wrapper
        recordChange(pr, await git.commit(path, "HEAD"), false)
        continue
      }
      const artifacts = await writeTerminalArtifacts(artifactRoot, input, attempt, merged.stdout, merged.stderr)
      await git.run(path, ["merge", "--abort"], true)
      const terminalDetail = [merged.stdout.trim(), merged.stderr.trim()].filter((part) => part !== "").join("\n")
      const detail = `change '${pr.id}' could not be applied: ${resolved.message}\n${terminalDetail || fetchDetail(merged)}`
      return {
        status: "failed",
        error: {
          code: resolved.code,
          message: detail,
        },
        output: await failureEvidence({
          command: ["git", "-C", path, ...mergeArgs],
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
    const mergedHead = await git.commit(path, "HEAD")
    // The clean path only. A conflicted merge is already refused above, and the
    // submodule-composition branch resolves by re-authoring its own tree, so its
    // deletions are the policy's, not the carrier's, and this comparison would
    // measure the wrong author.
    const erased = await unauthoredDeletionFailure(git, path, pr.id, pr.headSha, before, mergedHead)
    if (erased !== undefined) return erased
    // Deletions first, then what survives: the deletion guard rules on paths the
    // merge removed, so by here every remaining path is one this witness can
    // read, and the only question left is whether its content still says what
    // both parents said.
    const unwitnessed = await droppedContributionFailure(git, path, pr.id, pr.headSha, before, mergedHead)
    if (unwitnessed !== undefined) return unwitnessed
    let generated = mergedHead
    if (authoredFill !== undefined && authoredFill.updates.length > 0) {
      // The shaset commit: the queue's own write on top of the content merge,
      // filling each authored gitlink in from its submodule's main (plus the
      // regenerated bun.lock when manifests moved). The witnesses above judged
      // the merge; the wrapper's samePaths proof judges this write.
      const synthesized = await synthesizeGitlinkWrapper(
        git,
        path,
        mergedHead,
        authoredFill.updates,
        candidateChangeCommitMessage("compose", pr),
        provisionPinIntent,
      )
      if (synthesized.status === "failed") return synthesized
      generated = synthesized.output.commit
      submoduleResolutions.push(...authoredFill.filledPins)
    }
    recordChange(pr, generated, false)
  }
  return {
    status: "passed",
    output: {
      sha: await git.commit(path, "HEAD"),
      changes,
      submoduleResolutions,
      componentModelChanges,
    },
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
  authorizeSubmoduleModelChange?: SubmoduleModelChangeAuthorizer
}>

export type SubmoduleModelChangeAuthorizationRequest = Readonly<{
  operation: "add" | "remove"
  path: string
  ruling: string
  pr: string
  revision: number
  headSha: string
  /** Present on Candidate preparation. Optional only for legacy/direct host
   * gates that do not yet mint a Candidate authorization receipt. */
  patchId?: string
  source?: NonNullable<SubmoduleModelChangeAuthorization["source"]>
}>

export type SubmoduleModelChangeAuthorizer = (request: SubmoduleModelChangeAuthorizationRequest) => Promise<
  Readonly<{
    authorizer: string
    source?: NonNullable<SubmoduleModelChangeAuthorization["source"]>
  }>
>

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
        options.authorizeSubmoduleModelChange,
      )
      if (candidate.status === "failed") {
        const refusal = createFailure({
          kind: "refusal",
          code: candidate.error.code,
          message: candidate.error.message,
          ...(candidate.error.pr === undefined ? {} : { pr: candidate.error.pr }),
        })
        throw candidate.retryable === true ? markRecoverable(refusal) : refusal
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
      // composes the SAME tree merges on the same name with the same target,
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
        ...(candidate.output.submoduleResolutions.length === 0
          ? {}
          : { submoduleResolutions: candidate.output.submoduleResolutions }),
        ...(candidate.output.componentModelChanges.length === 0
          ? {}
          : { componentModelChanges: candidate.output.componentModelChanges }),
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

/**
 * Re-merge Phase 1 — rebuild by merge, never by rebase.
 *
 * A candidate is `merge(base tip, unchanged authored tip)` plus the shaset
 * fill-in. This is not a second implementation of that merge: it builds one
 * synthetic single-member `StepExecution` and hands it to
 * `prepareCandidateMembers` — the SAME per-member logic `gitCandidatePreparer`
 * uses to build a run's first candidate. One code path serves both a fresh
 * candidate and a stale-base rebuild; `rebuild-candidate-by-merge.test.ts`
 * test 9 proves it by replaying a first-candidate witness fixture through
 * this entry point instead.
 *
 * The synthetic member carries neither `recut` nor `intent` nor
 * `composition` — a rebuild mints no revision and certifies nothing; the
 * queue never rewrites the author's commits, so there is nothing to certify
 * against. `remergeChange`'s composed and proposed/preflight sub-paths are
 * NOT routed through this function (re-merge Phase 1 scope: direct revisions
 * only; composed revisions rewrite SUBMODULE-side history, a different
 * problem this phase does not touch).
 *
 * Content conflicts refuse `merge-conflict`, whatever the underlying
 * conflict-resolution machinery's own code — normalized here because that
 * machinery (`resolveCandidateSubmoduleConflict`) predates this phase's
 * vocabulary and serves batch (multi-member) submodule composition, a
 * different case from a single rebuilt member's base-moved conflict.
 */
export type RebuildByMergeInput = Readonly<{
  /** The change id, used only for error attribution and the synthetic commit
   * message — never persisted, never a revision number. */
  id: string
  /** The change's stable logical identity, stamped as the `Change-Id` trailer on
   * every commit this rebuild writes. REQUIRED, and required at the type level
   * on purpose: Change-Id ancestry is how merged truth is derived
   * (`merged-truth.ts`), so a queue-written commit with no trailer is invisible
   * to it. This field was absent until 2026-08-28 and the synthesized snapshot
   * below had nothing to stamp — 61 post-epoch trailer-less
   * `yrd: (compose|merge) … revision 1` commits on the superproject, 27 of them
   * reachable from origin/main, every one written through here. A caller
   * holding only an optional identity (`ChangeSnapshot.changeId`, absent for
   * pre-identity journals) refuses at its own seam rather than passing
   * undefined — see `remergeDirectChangeByMerge`. */
  changeId: string
  /** The author's branch name, carried through for error messages only. */
  branch: string
  /** The unchanged authored tip. Never rewritten. */
  headSha: string
}>

export type RebuildByMergeOptions = Readonly<{
  inject: Readonly<{ process: Pick<Process, "run"> }>
  repo: string
  artifactRoot?: string
  env?: NodeJS.ProcessEnv
  provisionPinIntent?: PinIntentProvisioner
}>

export type RebuildByMergeResult = Readonly<{
  /** The candidate: the worktree HEAD after the merge and any shaset fill-in. */
  sha: string
  treeSha: string
  /** True when `exactDelta(target, sha)` is empty — the rebuild changed
   * nothing against the current base, whether because the authored tip is a
   * literal ancestor or because its content is already fully contained
   * (the 23167 specimen: `git cherry` still reports unique commits). */
  unchanged: boolean
}>

/**
 * The ONLY two codes `resolveCandidateSubmoduleConflict`'s conflict branch
 * (inside `prepareCandidateMembers`, on `git merge`'s own non-zero exit) can
 * raise: `candidate-conflict` (three sites, including plain content) and
 * `submodule-composition-conflict`. This phase renames exactly those two to
 * `merge-conflict` — a NARROW allowlist of what to rename, not a denylist of
 * what to spare. Everything else `prepareCandidateMembers` can raise (the
 * deletion/contribution witnesses after a successful merge, the shaset
 * fill-in's own refusals including `min-commit-unpublished`, the component-
 * model-authorization family) is a different fact from a different check and
 * must pass through unrenamed — a denylist here would silently relabel a
 * witness catching real lost work as an ordinary conflict, which is exactly
 * the failure mode `unauthoredDeletionFailure` exists to make visible.
 */
const CONFLICT_CODES_TO_RENAME = new Set<string>(["candidate-conflict", "submodule-composition-conflict"])
/** Phase 0's stated remedy, verbatim (hub/yrd/2026-08-23-remerge-phase0-replay.md
 * § Design call step 3) — appended, never substituted, so the underlying
 * conflict detail (which paths, which git output) survives alongside it. */
const MERGE_CONFLICT_REMEDY = "merge or rebase locally and push"

/**
 * The dedicated path for a single-member change that authors at least one
 * gitlink — the caller's pre-branch (`rebuildCandidateByMerge`) routes here
 * BEFORE any merge is attempted, so the worktree is always the untouched
 * `target.sha` on entry; `resolveCandidateSubmoduleConflict`'s composition
 * branch is never reached from this call, by construction. Runs the exact
 * same pieces `prepareCandidateMembers` runs for its plain (non-composed)
 * member — `fillAuthoredGitlinksFromMain` (the caller already computed
 * `authoredGitlinks` to decide whether to route here at all; the fill itself
 * still runs here, since knowing WHICH paths were authored is not the same as
 * knowing what to fill them WITH), the two kept witnesses,
 * `synthesizeGitlinkWrapper` — with ONE difference from the ordinary path:
 * any merge conflict on a path this change's own fill covers resolves to the
 * base's (current worktree's) side via `writeQueueGitlink`, since the fill-in
 * overwrites it regardless of which side `git merge` would otherwise have
 * picked — Phase 0's rule, applied directly rather than through the
 * composition machinery that was built for a different problem.
 */
async function rebuildGitlinkConflictByTakingBase(
  git: Git,
  repo: string,
  path: string,
  pr: ChangeSnapshot,
  input: RebuildByMergeInput,
  target: Readonly<{ sha: string }>,
  authoredGitlinks: readonly string[],
  options: RebuildByMergeOptions,
): Promise<Readonly<{ status: "completed"; conclusion: "success"; output: Readonly<{ sha: string }> }>> {
  const filled = await fillAuthoredGitlinksFromMain(git, repo, path, pr, authoredGitlinks, undefined)
  if (filled.status === "failed") {
    throw createFailure({
      kind: "refusal",
      code: filled.error.code,
      message: filled.error.message,
      ...(filled.error.pr === undefined ? {} : { pr: filled.error.pr }),
    })
  }
  const fillPaths = new Set(filled.output.updates.map((update) => update.path))
  const before = await git.commit(path, "HEAD")
  const message = candidateChangeCommitMessage("merge", pr)
  const merged = await git.run(path, ["merge", "--no-verify", "--no-ff", "-m", message, input.headSha], true)
  if (merged.code !== 0) {
    // A failed submodule merge ("not checked out" — this scratch worktree's
    // gitlink checkouts are not fully materialized) does not always leave a
    // normal multi-stage index entry, so `git diff --diff-filter=U`
    // (`unmergedPaths`, built for ordinary content conflicts) can miss it
    // silently. `readQueueTreeConflicts` reads `git ls-files --unmerged`
    // directly — the raw index stages — and is what the first-candidate path
    // already trusts for this exact shape.
    const conflicts = (await readQueueTreeConflicts(git, path)).map((conflict) => conflict.path)
    const nonFillable = conflicts.filter((conflict) => !fillPaths.has(conflict))
    if (nonFillable.length > 0) {
      await git.run(path, ["merge", "--abort"], true)
      throw createFailure({
        kind: "refusal",
        code: "merge-conflict",
        message:
          `change '${input.id}' could not be merged onto '${target.sha}' at [${conflicts.join(", ")}]\n` +
          `remedy: ${MERGE_CONFLICT_REMEDY}`,
        pr: input.id,
      })
    }
    for (const conflict of conflicts) {
      // A gitlink conflict has no blob content to check out — it is a bare
      // (mode, oid) index entry — so the fix is `update-index --cacheinfo`
      // directly (the same primitive Phase 0's design call names, and the
      // same one `writeQueueGitlink` already wraps for exactly this shape),
      // not `checkout --ours`, which leaves the conflicted stages standing
      // for a path with no worktree file to resolve against.
      const oursValue = await readGitlink(git, path, before, conflict)
      if (oursValue === undefined) {
        await git.run(path, ["merge", "--abort"], true)
        throw createFailure({
          kind: "refusal",
          code: "merge-conflict",
          message: `change '${input.id}' could not read the base value for conflicted gitlink '${conflict}'`,
          pr: input.id,
        })
      }
      const staged = await writeQueueGitlink(git, path, conflict, oursValue)
      if (!queueGitlinkWriteSucceeded(staged)) {
        await git.run(path, ["merge", "--abort"], true)
        throw createFailure({
          kind: "refusal",
          code: "merge-conflict",
          message: `change '${input.id}' could not resolve gitlink '${conflict}' to the base value: ${queueGitlinkWriteFailure(staged)}`,
          pr: input.id,
        })
      }
    }
    const continued = await git.run(path, ["-c", "core.editor=true", "commit", "--no-edit"], true)
    if (continued.code !== 0) {
      await git.run(path, ["merge", "--abort"], true)
      throw createFailure({
        kind: "refusal",
        code: "merge-conflict",
        message: `change '${input.id}' could not finalize the base-resolved merge: ${continued.stderr || continued.stdout}`,
        pr: input.id,
      })
    }
  }
  const mergedHead = await git.commit(path, "HEAD")
  const erased = await unauthoredDeletionFailure(git, path, input.id, input.headSha, before, mergedHead)
  if (erased !== undefined) {
    throw createFailure({ kind: "refusal", code: erased.error.code, message: erased.error.message, pr: input.id })
  }
  const unwitnessed = await droppedContributionFailure(git, path, input.id, input.headSha, before, mergedHead)
  if (unwitnessed !== undefined) {
    throw createFailure({
      kind: "refusal",
      code: unwitnessed.error.code,
      message: unwitnessed.error.message,
      pr: input.id,
    })
  }
  let finalSha = mergedHead
  if (filled.output.updates.length > 0) {
    const synthesized = await synthesizeGitlinkWrapper(
      git,
      path,
      mergedHead,
      filled.output.updates,
      candidateChangeCommitMessage("compose", pr),
      options.provisionPinIntent,
    )
    if (synthesized.status === "failed") {
      throw createFailure({
        kind: "refusal",
        code: synthesized.error.code,
        message: synthesized.error.message,
        pr: input.id,
      })
    }
    finalSha = synthesized.output.commit
  }
  return { status: "completed", conclusion: "success", output: { sha: finalSha } }
}

export async function rebuildCandidateByMerge(
  options: RebuildByMergeOptions,
  target: Readonly<{ sha: string }>,
  input: RebuildByMergeInput,
): Promise<RebuildByMergeResult> {
  const repo = resolve(options.repo)
  const git = createGit(options.inject.process, options.env)
  // exactDelta wants a RefGit — trimmed stdout, throws on non-zero — not this
  // module's own Git, whose `.run` returns a {code, stdout, stderr} result for
  // every tolerant caller in this file. A local, minimal bridge rather than
  // reaching for a shared adapter: this is the one call site in `command.ts`
  // that needs one today. Built up front so both the fast-forward
  // short-circuit below and the merge path's own tail share ONE exactDelta
  // convention for `unchanged` — see the bug that cost: a first cut hardcoded
  // `unchanged: true` on the fast-forward path, conflating "no merge commit
  // needed" with "literally nothing changed". Wrong whenever the author's tip
  // has real commits beyond target that a bare fast-forward still delivers —
  // caught by recut-absorbed-payload.test.ts: target genuinely an ancestor of
  // headSha, but headSha carries one more authored commit beyond it.
  const refGit: Pick<import("./content-identity.ts").ExactDeltaGit, "text"> = {
    async text(r, a) {
      const result = await git.run(r, a, true)
      if (result.code !== 0) {
        throw new Error(`git ${a.join(" ")} exited ${result.code}: ${(result.stderr || result.stdout).trim()}`)
      }
      return result.stdout.trim()
    },
  }
  // A literal fast-forward: the current base is ALREADY an ancestor of the
  // author's own tip, so there is nothing to MERGE — `prepareCandidateMembers`'s
  // merge step below is `--no-ff` unconditionally (it exists to combine
  // genuinely divergent members), so delegating to it here would manufacture
  // a needless merge commit with a DIFFERENT sha for content a plain
  // fast-forward already delivers — breaking every downstream comparison that
  // expects a trivial rebuild's head to equal the author's own tip. Found via
  // bucket-2 triage (22925 family): 13 cannot-probe/infra-retry tests all
  // failed on exactly this headSha mismatch, not on refusal classification —
  // the retryable-infra logic itself was never wrong. Mirrors
  // remergeDirectChange's own early-return for the identical case
  // (sourceBase === target.sha), computed directly here rather than via a
  // merge-base helper that returns more than this needs. `unchanged` still
  // goes through exactDelta below, never a hardcoded true — ancestry only
  // proves no merge commit is needed, not that nothing changed.
  if (await isAncestor(git, repo, target.sha, input.headSha)) {
    const delta = await exactDelta(refGit, repo, target.sha, input.headSha)
    return { sha: input.headSha, treeSha: delta.candidateTree, unchanged: delta.entries.length === 0 }
  }
  const pr = ChangeSnapshotSchema.parse({
    id: input.id,
    changeId: input.changeId,
    branch: input.branch,
    base: input.branch,
    revision: 1,
    headSha: input.headSha,
  })
  const execution: StepExecution = {
    run: input.id,
    step: "rebuild-by-merge",
    index: 0,
    prs: [pr],
    shape: { results: {} },
  }
  const guilty: { id?: string } = {}
  const outcome = await withScratch<Readonly<{ sha: string }>>(git, repo, target.sha, undefined, async (path, root) => {
    const artifactRoot = resolve(options.artifactRoot ?? join(root, "artifacts"))
    // POSITIVE PRE-BRANCH, not a catch around a known-crashing path — but
    // narrowed to Phase 0's actual rule: "take the base's gitlink ON
    // CONFLICT", not on every authored gitlink unconditionally. A first cut
    // read "does this change author a gitlink at all" as the trigger; that
    // hijacked every clean, non-conflicting gitlink advance too (command.
    // test.ts:9195's queue-driven submodule-promotion/retry suite proved
    // it — the queue's OWN promotion machinery never got a chance to run,
    // because this pre-branch intercepted before any merge was even
    // attempted). Corrected per team-lead's ruling (22925 family): trigger
    // EXACTLY where the old code would have called
    // `resolveCandidateSubmoduleConflict` — a gitlink-mode conflict actually
    // DETECTED during the member merge — and nowhere else. No conflict means
    // the normal merge flow below runs untouched: a cleanly-merged
    // single-sided gitlink advance already carries the authored value, needs
    // no fill, and stays reachable by the queue's promotion/convergence
    // machinery exactly as before this function existed.
    //
    // Detection is a non-destructive TRIAL of the exact merge
    // `prepareCandidateMembers` would otherwise attempt (same target, same
    // head, same flags) — never a guess computed from authored-path lists
    // alone, since only git's own merge machinery can say whether a
    // divergent gitlink pin auto-resolves (one side's submodule commit an
    // ancestor of the other's) or is a genuine, unresolvable conflict. On
    // conflict, `readGitlinkConflictStages` (already used elsewhere in this
    // file for exactly this per-path question) tells us whether it is
    // gitlink-shaped; the trial is aborted/reset either way, so
    // `prepareCandidateMembers` below always starts from the same clean
    // `target.sha` state regardless of which branch this took.
    //
    // `resolveCandidateSubmoduleConflict`'s "composed" branch composes a
    // BATCH's divergent submodule commits together — the right tool for two
    // different members of the SAME candidate advancing one gitlink two
    // ways, and NOT the tool for a single member's own conflict, which the
    // shaset fill-in (`fillAuthoredGitlinksFromMain`, inside
    // `rebuildGitlinkConflictByTakingBase` below) already owns independently
    // of how a merge would resolve the path. Composing here would also crash
    // separately (`QueueSubmoduleResolutionEvidenceSchema` rejects the shape
    // `executeQueueSubmoduleComposition` actually returns, after every git
    // operation including the commit itself has already run; tracked as its
    // own shared-machinery finding,
    // `@yrd/core/evidence-schema-rejects-its-producer`, P2, deliberately left
    // unfixed here — out of scope, and dormant per the habitant runner's own
    // journal) — a conflict this pre-branch now routes around before ever
    // reaching it, rather than a tool it happens to be safe from by
    // construction.
    const authoredGitlinks = await authoredGitlinkPaths(git, path, input.id, input.headSha)
    if (authoredGitlinks.status === "failed") {
      throw createFailure({
        kind: "refusal",
        code: authoredGitlinks.error.code,
        message: authoredGitlinks.error.message,
        ...(authoredGitlinks.error.pr === undefined ? {} : { pr: authoredGitlinks.error.pr }),
      })
    }
    if (authoredGitlinks.output.length > 0) {
      const trialMessage = candidateChangeCommitMessage("merge", pr)
      const trial = await git.run(path, ["merge", "--no-verify", "--no-ff", "-m", trialMessage, input.headSha], true)
      if (trial.code !== 0) {
        let gitlinkConflict = false
        for (const conflictPath of authoredGitlinks.output) {
          if ((await readGitlinkConflictStages(git, path, conflictPath)) !== undefined) {
            gitlinkConflict = true
            break
          }
        }
        await git.run(path, ["merge", "--abort"], true)
        if (gitlinkConflict) {
          return rebuildGitlinkConflictByTakingBase(
            git,
            repo,
            path,
            pr,
            input,
            target,
            authoredGitlinks.output,
            options,
          )
        }
        // Not a gitlink conflict — some other path collided. Not this
        // pre-branch's business; prepareCandidateMembers below re-attempts
        // the same merge and handles it exactly as it always has.
      } else {
        // Clean merge. Reset the trial so prepareCandidateMembers performs
        // the real, authoritative merge (witness checks, shaset-fill-if-
        // needed, wrapper stabilization) untouched, rather than this
        // pre-branch silently keeping its own throwaway result.
        // submodule.recurse disabled: this scratch worktree's submodule
        // git-dir references are broken (git worktree add), and a plain
        // reset --hard would otherwise try to recurse into them.
        await git.run(path, ["-c", "submodule.recurse=false", "reset", "--hard", target.sha], true)
      }
    }
    const prepared = await prepareCandidateMembers(
      guilty,
      git,
      repo,
      path,
      target.sha,
      execution,
      1,
      artifactRoot,
      undefined,
      options.provisionPinIntent,
      undefined,
    )
    if (prepared.status === "failed") {
      const rename = CONFLICT_CODES_TO_RENAME.has(prepared.error.code)
      throw createFailure({
        kind: "refusal",
        code: rename ? "merge-conflict" : prepared.error.code,
        message: rename ? `${prepared.error.message}\nremedy: ${MERGE_CONFLICT_REMEDY}` : prepared.error.message,
        ...(prepared.error.pr === undefined ? {} : { pr: prepared.error.pr }),
      })
    }
    return { status: "completed", conclusion: "success", output: { sha: prepared.output.sha } }
  })
  if (outcome.status !== "completed" || outcome.conclusion !== "success") {
    throw new Error(`yrd: rebuild-by-merge scratch worktree did not complete for change '${input.id}'`)
  }
  const delta = await exactDelta(refGit, repo, target.sha, outcome.output.sha)
  return { sha: outcome.output.sha, treeSha: delta.candidateTree, unchanged: delta.entries.length === 0 }
}

/**
 * Adapts `rebuildCandidateByMerge`'s pure-git result to the `ChangeRemergeResult`
 * contract this file's `remergeChange` dispatcher (line ~2308, `service.recut`)
 * and its callers expect — the same shape `remergeDirectChange` (the rebase-based
 * path this replaces for the direct case) has always returned. Everything
 * downstream of `service.recut` — `run.ts`'s `executeRemergeChange` and the bay
 * reducer `remergeChange` (`yrd-bay/src/plugin.ts`) — already treats `unchanged`
 * as a no-op and any other result as "mint a revision", exactly what re-merge
 * Phase 1 needs. Neither needed a single line changed: this seam is the whole
 * change.
 *
 * `patchId`: a merge-based candidate has nothing to certify equivalence
 * against — the tested object IS the merged object, so there is no rewrite to
 * prove didn't drift. This is therefore a plain stable identity, not a
 * certificate: the candidate's own diff against its own base, via the same
 * primitive (`git.stablePatchId`) `remergeDirectChange` used for its
 * `materializedPatchId`, without the certification apparatus (range-diff,
 * absorbed paths, fast-forwarded-carrier-gitlink classification) that only
 * exists to prove a REWRITE didn't drift.
 *
 * Ref publish: `sourceCandidateRefFor(sha)` plus a push to origin, matching
 * what `remergeDirectChange` does at its own end — plain git in the caller's
 * `repo`, not bay state, so it belongs at this seam regardless of which side
 * built the candidate.
 */
/**
 * The one home for the "no migration verb" remedy, shared by both raise sites
 * that refuse a pre-identity record: `recut-change-id-missing` here, and
 * `candidate-change-id-missing` in `candidateChangeCommitMessage` below.
 * Identity is deliberately never invented for an existing record — there is
 * no migration verb, and re-pushing the SAME branch resolves to the same
 * change (identity is branch-keyed) and refuses again identically. The only
 * way out is the mint path: a fresh branch name gets a fresh, stable
 * Change-Id. One copy so the two sites cannot say two different things about
 * the same dead end — `candidateChangeCommitMessage`'s copy said "migrate it
 * before rebuilding" until this fix, naming a verb that does not exist and
 * was never going to; a reader who followed it re-pushed the unchanged
 * branch, hit the identical refusal, and stalled (PR2599, five hours,
 * 2026-08-29).
 */
const NO_CHANGE_ID_MIGRATION_REMEDY =
  "there is no migration verb, because identity is never invented for an existing record. Re-pushing THIS " +
  "branch cannot help: identity is branch-keyed, so it resolves to this same change and refuses again. Deliver " +
  "the payload under a NEW branch name, which takes the mint path and gets a stable Change-Id. Push it to the " +
  "receiver as 'refs/for/<base>/<issue>' under that new name. No work is lost (the payload is on the branch) " +
  "and no withdraw is needed"

async function remergeDirectChangeByMerge(
  git: Git,
  repo: string,
  target: GitQueueTarget,
  input: ChangeRemergeInput,
): Promise<ChangeRemergeResult> {
  const oldBase = input.baseSha
  if (oldBase === undefined) {
    throw createFailure({
      kind: "refusal",
      code: "recut-base-missing",
      message: `yrd: change '${input.id}' revision ${input.revision} has no immutable base SHA`,
    })
  }
  // `ChangeRemergeInput` extends `ChangeSnapshot`, whose `changeId` is optional
  // for one reason only: replaying a journal written before stable change
  // identity. Such a change cannot be rebuilt — the candidate would carry no
  // `Change-Id`, and merged truth is derived from that trailer's ancestry — so
  // refuse here, naming the same remedy `plugin.ts` already names for a
  // pre-identity record at its own rebuild seam. Identity is never invented:
  // a minted-here id would be a fact nothing else agrees with.
  if (input.changeId === undefined) {
    throw createFailure({
      kind: "refusal",
      code: "recut-change-id-missing",
      message:
        `yrd: change '${input.id}' revision ${String(input.revision)} predates stable Change-Id identity — ` +
        NO_CHANGE_ID_MIGRATION_REMEDY,
      pr: input.id,
    })
  }
  const built = await rebuildCandidateByMerge({ inject: { process: git.process }, repo, env: git.env }, target, {
    id: input.id,
    changeId: input.changeId,
    branch: input.branch,
    headSha: input.headSha,
  })
  // `built.unchanged` (from `exactDelta`) means the candidate carries no delta
  // against `target.sha` — the author's tip is either a literal ancestor or its
  // content is already fully contained (23167: `git cherry` still reports
  // unique commits even then). A `target.sha..built.sha` diff is trivially
  // empty in that case — `stablePatchId` returns undefined for an empty diff by
  // construction (`git patch-id` emits nothing), not as a failure signal — so
  // there is nothing there to identify. Fall back to the author's own range
  // instead — the same "fully absorbed" identity the old rebase-based direct
  // path (`remergeDirectChange`, deleted 2026-08-23 as dead code once this
  // seam replaced its only caller) used for the identical case: a stable value
  // independent of whether the base has moved at all.
  const patchId = built.unchanged
    ? await git.stablePatchId(repo, oldBase, input.headSha)
    : await git.stablePatchId(repo, target.sha, built.sha)
  if (patchId === undefined) {
    throw createFailure({
      kind: "refusal",
      code: "payload-certificate",
      message: `yrd: change '${input.id}' rebuild has no stable patch identity`,
    })
  }
  const ref = sourceCandidateRefFor(built.sha)
  const pinned = await git.run(
    repo,
    ["update-ref", "--create-reflog", ref, built.sha, "0".repeat(built.sha.length)],
    true,
  )
  if (pinned.code !== 0 && (await git.optionalCommit(repo, ref)) !== built.sha) {
    throw createFailure({
      kind: "infrastructure",
      code: "recut-publish",
      message: `yrd: change '${input.id}' re-merge ref could not be pinned: ${pinned.stderr || pinned.stdout}`,
    })
  }
  const remote = await git.run(repo, ["config", "--get", "remote.origin.url"], true)
  if (remote.code === 0 && remote.stdout !== "") {
    const published = await pushRefUpdates({
      root: repo,
      git: adaptProcessGit(git.process, { env: git.env, timeoutMs: GIT_TIMEOUT_MS }),
      timeoutMs: GIT_TIMEOUT_MS,
      updates: [{ repository: repo, remote: "origin", source: built.sha, destination: ref }],
    })
    if (published.state !== "updated" && published.state !== "unchanged") {
      throw createFailure({
        kind: "infrastructure",
        code: "recut-publish",
        message: `yrd: change '${input.id}' re-merge ref could not be published: ${
          gitSuperFailureDetail(published)?.message ?? published.state
        }`,
      })
    }
  }
  // `built.unchanged` (rebuildCandidateByMerge's own signal) is a pure
  // content check: does the candidate's tree differ from target.sha's — true
  // both for a trivial fast-forward AND for a genuine merge that happens to
  // land back on target's own content (the rare 23167 cherry-dedup case).
  // The OUTER ChangeRemergeResult.unchanged this function returns means
  // something narrower: "was this a pure fast-forward AND has the recorded
  // base not moved since — i.e. is there nothing for the queue to newly act
  // on" — OR the rarer built.unchanged case above. `oldBase === target.sha`
  // ALONE is not sufficient: three fixtures pinned this precisely, not two
  // (22925 family, bucket-2/3 triage). "certifies the raw carrier object
  // when a local replacement ref is present" (oldBase === target.sha AND a
  // literal fast-forward — expects unchanged:true) vs. recut-absorbed-
  // payload's "carrying only the paths the base did not already merge"
  // (oldBase !== target.sha, ALSO a fast-forward — expects unchanged:false)
  // vs. "recuts from the source merge base when submission recorded
  // authoritative current base" (oldBase === target.sha, but NOT a
  // fast-forward — a genuine two-sided merge of independently-diverged
  // content — expects unchanged:false even though oldBase matches target).
  // `built.sha === input.headSha` is the fast-forward tell: the short-circuit
  // in rebuildCandidateByMerge returns the author's own sha verbatim; the
  // full merge path always produces a new --no-ff commit that can never
  // equal it.
  const wasFastForward = built.sha === input.headSha
  const unchanged = (wasFastForward && oldBase === target.sha) || built.unchanged
  return {
    headSha: built.sha,
    baseSha: target.sha,
    treeSha: built.treeSha,
    patchId,
    unchanged,
  }
}

type CandidateFailure = Readonly<{
  status: "failed"
  /** The process may retry this same immutable input after an external
   * precondition changes. Runtime context only; never persisted evidence. */
  retryable?: true
  /**
   * `pr` names the ONE member this failure is attributable to, when one is.
   * Stamped at the `prepareCandidate` loop boundary rather than at each return
   * site, so no failure path can forget it. Absent means the failure belongs to
   * the candidate as a whole and every member shares it.
   */
  error: Readonly<{ code: string; message: string; pr?: string }>
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
    paths.map(async (submodule) => {
      const previous = await readGitlink(git, repo, baseSha, submodule)
      const target = await readGitlink(git, repo, headSha, submodule)
      if (previous === undefined) {
        return (
          `submodule '${submodule}' is a new submodule; a change's gitlink diff can only bump an ` +
          "existing submodule, never add one; authorize the component-model addition as an ordinary code change"
        )
      }
      if (target === undefined) {
        return (
          `submodule '${submodule}' is deleted; a change's gitlink diff can only bump an existing ` +
          "submodule, never remove one; restore it, or authorize the component-model deletion as an ordinary code change"
        )
      }
      return (
        `get commit '${target}' onto '${submodule}''s own main, then submit an ordinary change whose ` +
        `diff is the gitlink bump (issue ${issue}); ${cherryFfInstruction(await readCherryDragged(git, repo, submodule, previous))}`
      )
    }),
  )
  return steps.join("; ")
}

/** Best-effort `git cherry -v <estate-pin> <submodule-main>` in the submodule
 * checkout. Unavailable objects, an unmaterialized checkout, or a missing main
 * return undefined so the caller prints the command instead of inventing a list. */
async function readCherryDragged(
  git: Git,
  repo: string,
  submodule: string,
  estatePin: string,
): Promise<CherryDragged | undefined> {
  const checkout = join(repo, submodule)
  const main = await git.run(checkout, ["rev-parse", "--verify", SUBMODULE_MAIN_REF], true)
  if (main.code !== 0 || main.stdout === "") return undefined
  const cherry = await git.run(checkout, ["cherry", "-v", estatePin, main.stdout], true)
  if (cherry.code !== 0) return undefined
  return { unique: parseCherryVerbose(cherry.stdout) }
}

type BaseContainment =
  | Readonly<{ status: "contained" }>
  | Readonly<{ status: "drops-merged"; commits: string }>
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

  // Post-merge actuator retries intentionally carry a head already contained
  // by current main. They cannot remove current-base commits and remain safe.
  const alreadyMerged = await git.run(repo, ["merge-base", "--is-ancestor", carrierHead, authoritativeBase], true)
  if (alreadyMerged.code === 0) return { status: "contained" }
  if (alreadyMerged.code !== 1) {
    return {
      status: "inspection-failed",
      detail: alreadyMerged.stderr || alreadyMerged.stdout || "git merge-base failed",
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
  return { status: "drops-merged", commits: dropped.stdout }
}

/** Resolve the submodule checkout that can answer ancestry for a gitlink path.
 *
 * `join(root, path)` alone is not enough, and failing silently here is how this
 * check first went wrong: an uninitialized submodule directory still exists, so
 * every `git -C` against it walks UP and is answered by the superproject, which
 * knows none of the submodule's shas. It reports "not an ancestor" for a pin
 * that plainly is one. The toplevel comparison is what makes the wrong repo
 * loud instead of merely wrong. */
async function submoduleCheckout(git: Git, root: string, path: string): Promise<string | undefined> {
  const submodule = join(root, path)
  const toplevel = await git.run(submodule, ["rev-parse", "--show-toplevel"], true)
  if (toplevel.code !== 0 || toplevel.stdout === "") return undefined
  try {
    return (await realpath(toplevel.stdout)) === (await realpath(submodule)) ? submodule : undefined
  } catch {
    // silent-fallback-allow: the declared contract is `string | undefined`, and
    // undefined means "this path is not its own submodule checkout". The line
    // above already returns undefined for the resolvable-but-not-a-checkout
    // case, so the catch is the same answer for the unresolvable one. Declining
    // to name a checkout is the safe direction; the caller treats absence as
    // "no submodule here" rather than assuming one.
    return undefined
  }
}

/** A deletion is the one merge outcome nothing announces. Every guard above this
 * one asks whether the carrier CONTAINS the base; the residual case is a carrier
 * that does contain it and erases a merge anyway, cleanly, with no conflict.
 *
 * It happens when the carrier and the base have MORE THAN ONE merge base — the
 * criss-cross any re-merged or hand-resolved carrier can produce. `ort` then
 * resolves against a VIRTUAL base built from all of them, and that virtual tree
 * can hold a path the single `git merge-base` answer does not. `authoredDeltaBase`
 * measures the carrier's authored changes from that single answer, so a deletion
 * resolved against the virtual base appears in no diff the author ever reviewed:
 * ancestry says contained, `merge-tree` says mergeable, `git merge` exits 0, and
 * the merge is gone. Measured on git 2.54 (2026-08-14) with an empty authored
 * deletion set and the merged file missing from the merge result.
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
  merged: string,
): Promise<CandidateFailure | undefined> {
  const removed = await deletedPaths(git, repo, before, merged)
  if (removed.length === 0) return undefined
  const base = await authoredDeltaBase(git, repo, before, headSha)
  if (base.status === "unreadable") {
    return candidateFailure(
      "deletion-inspection",
      `could not measure the deletions change '${pr}' branch '${headSha}' authors against '${before}': ${base.detail}`,
    )
  }
  const authored = new Set(await deletedPaths(git, repo, base.sha, headSha))
  const unauthored = removed.filter((path) => !authored.has(path))
  if (unauthored.length === 0) return undefined
  const shown = unauthored.slice(0, 8).join(", ") + (unauthored.length > 8 ? ", …" : "")
  return candidateFailure(
    "unauthored-path-deletion",
    `merging change '${pr}' branch '${headSha}' deletes [${shown}], which its authored diff against ` +
      `'${base.sha}' never deletes; the merge resolved away merged work the branch never authored removing`,
    ".",
    unauthored,
  )
}

type WitnessLines =
  | Readonly<{ status: "lines"; lines: ReadonlySet<string> }>
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "opaque" }>
  | Readonly<{ status: "unreadable"; detail: string }>

/** One file's content as a SET of its non-blank lines — never diff hunks. A hunk
 * is a claim about position, and a resolution that merely moves a line would
 * read as a loss; membership asks the only question a merge cares about, which
 * is whether the content is still in the file at all. Being generous about where
 * a line may appear is deliberate: it can only make this guard miss, never make
 * it refuse honest work. */
async function witnessLines(git: Git, repo: string, rev: string, path: string): Promise<WitnessLines> {
  const tree = await git.raw(repo, ["ls-tree", "-z", rev, "--", path], true)
  if (tree.code !== 0 || tree.stdout === "") return { status: "absent" }
  const tab = tree.stdout.indexOf("\t")
  if (tab === -1) return { status: "absent" }
  const oid = /^\d{6} blob ([0-9a-f]{40,64})$/u.exec(tree.stdout.slice(0, tab))?.[1]
  const end = tree.stdout.indexOf("\0", tab + 1)
  if (tree.stdout.slice(tab + 1, end === -1 ? undefined : end) !== path) return { status: "absent" }
  // A gitlink or a subtree cannot be compared by text rows, and who authored a
  // pin is the containment guards' subject, never this one's.
  if (oid === undefined) return { status: "opaque" }
  const blob = await git.raw(repo, ["cat-file", "blob", oid], true)
  if (blob.code !== 0) {
    return { status: "unreadable", detail: blob.stderr || blob.stdout || `git cat-file blob ${oid} produced nothing` }
  }
  // Bytes that do not survive the decode to text have no lines to compare: NUL
  // is git's own binary marker, and U+FFFD means the decoder already replaced
  // bytes, so the "lines" would be a fiction no refusal may rest on.
  if (blob.stdout.includes("\0") || blob.stdout.includes("\uFFFD")) return { status: "opaque" }
  return { status: "lines", lines: new Set(blob.stdout.split(/\r?\n/u).filter((line) => line.trim() !== "")) }
}

/** The paths both parents changed, measured against EVERY merge base and
 * unioned. Against a single base this is the plain "both sides touched it" set.
 * Against a criss-cross it must be the union, because the shape this guard
 * exists for is invisible from one of the bases: the carrier that resolved a
 * merged marker away looks unchanged when measured from the base whose branch it
 * sits on, and changed only when measured from the other. Picking one base is
 * how the loss stays unseen. */
async function contestedPaths(
  git: Git,
  repo: string,
  bases: readonly string[],
  before: string,
  headSha: string,
): Promise<string[]> {
  const contested = new Set<string>()
  for (const base of bases) {
    const ours = new Set(await changedPaths(git, repo, base, before))
    for (const path of await changedPaths(git, repo, base, headSha)) {
      if (ours.has(path)) contested.add(path)
    }
  }
  return [...contested].toSorted()
}

type ContributionDrop = Readonly<{ path: string; side: "base" | "carrier"; lines: readonly string[] }>

/** A clean merge can be worse than a conflict. A conflict stops and asks; a
 * resolution that drops one parent's contribution merges with full ancestry and
 * no signal at all — which is how `d416a3179e` erased three shipped features.
 *
 * Every guard above this one rules on PATHS: does the carrier contain the base,
 * does the merge delete a merge. None of them reads what the merge result
 * SAYS, so a file that survives with one parent's content resolved out of it
 * passes all of them. The mechanism is the criss-cross its deletion sibling
 * documents: two merge bases, `ort` resolves against a virtual base built from
 * both, and a removal resolved there appears in no diff anyone reviewed.
 *
 * So ask the question directly, per contested file: is there a line one parent
 * carries that the RESULT does not, and that the other parent never authored
 * removing? "Authored removing" is measured against every merge base and
 * INTERSECTED — a removal only counts as the other parent's decision if it holds
 * from all of them. That intersection is the whole discrimination: a line the
 * carrier deliberately deleted on its own branch is absent from every base's
 * comparison and is never flagged, while the marker resolved away against a
 * virtual base is authored from no base at all and is.
 *
 * Declared limits, because a guard that hides its blind spots is worse than one
 * that has none. Content with no comparable lines — gitlinks, subtrees, binary
 * and anything the decoder had to replace bytes in — is excluded and NAMED in
 * the refusal. Paths the merge deletes outright belong to
 * `unauthoredDeletionFailure`, which runs first. And a parent's contribution
 * that consists only of removals leaves no line to look for, so it is not
 * witnessed here. Where the parents share a single merge base the check is very
 * nearly a tautology, as it should be. */
async function droppedContributionFailure(
  git: Git,
  repo: string,
  pr: string,
  headSha: string,
  before: string,
  merged: string,
): Promise<CandidateFailure | undefined> {
  const unreadable = (path: string, detail: string): CandidateFailure =>
    candidateFailure(
      "contribution-inspection",
      `could not read '${path}' while witnessing what merging change '${pr}' branch '${headSha}' kept: ${detail}`,
    )

  const found = await git.run(repo, ["merge-base", "--all", before, headSha], true)
  if (found.code !== 0 || found.stdout === "") {
    return unreadable(".", found.stderr || found.stdout || `no merge base between '${before}' and '${headSha}'`)
  }
  const bases = found.stdout.split(/\r?\n/u).filter((sha) => sha !== "")
  const contested = await contestedPaths(git, repo, bases, before, headSha)
  if (contested.length === 0) return undefined

  const drops: ContributionDrop[] = []
  const excluded: string[] = []
  for (const path of contested) {
    const result = await witnessLines(git, repo, merged, path)
    if (result.status === "unreadable") return unreadable(path, result.detail)
    if (result.status === "absent") continue
    if (result.status === "opaque") {
      excluded.push(path)
      continue
    }
    const ours = await witnessLines(git, repo, before, path)
    const theirs = await witnessLines(git, repo, headSha, path)
    if (ours.status === "unreadable") return unreadable(path, ours.detail)
    if (theirs.status === "unreadable") return unreadable(path, theirs.detail)
    if (ours.status === "opaque" || theirs.status === "opaque") {
      excluded.push(path)
      continue
    }
    const baseParent = ours.status === "lines" ? ours.lines : new Set<string>()
    const carrierParent = theirs.status === "lines" ? theirs.lines : new Set<string>()
    const lostFromBase = [...baseParent].filter((line) => !result.lines.has(line))
    const lostFromCarrier = [...carrierParent].filter((line) => !result.lines.has(line))
    if (lostFromBase.length === 0 && lostFromCarrier.length === 0) continue

    // Only a base that CARRIES the path can speak to who removed a line from it;
    // one that never had the file would answer "nobody authored anything", which
    // would turn every ordinary new-file merge into a refusal.
    const attested: Array<ReadonlySet<string>> = []
    let unwitnessable = false
    for (const base of bases) {
      const at = await witnessLines(git, repo, base, path)
      if (at.status === "unreadable") return unreadable(path, at.detail)
      if (at.status === "opaque") {
        unwitnessable = true
        break
      }
      if (at.status === "lines") attested.push(at.lines)
    }
    if (unwitnessable || attested.length === 0) {
      excluded.push(path)
      continue
    }
    const authoredRemovals = (parent: ReadonlySet<string>): ReadonlySet<string> =>
      attested
        .map((base) => new Set([...base].filter((line) => !parent.has(line))))
        .reduce((left, right) => new Set([...left].filter((line) => right.has(line))))
    const byCarrier = authoredRemovals(carrierParent)
    const byBase = authoredRemovals(baseParent)
    const droppedFromBase = lostFromBase.filter((line) => !byCarrier.has(line))
    const droppedFromCarrier = lostFromCarrier.filter((line) => !byBase.has(line))
    if (droppedFromBase.length > 0) drops.push({ path, side: "base", lines: droppedFromBase })
    if (droppedFromCarrier.length > 0) drops.push({ path, side: "carrier", lines: droppedFromCarrier })
  }
  if (drops.length === 0) return undefined

  const clip = (line: string): string => (line.length > 120 ? `${line.slice(0, 119)}…` : line)
  const list = (values: readonly string[]): string =>
    `${values.slice(0, 8).join(", ")}${values.length > 8 ? ", …" : ""}`
  const shown = drops
    .slice(0, 4)
    .map(
      (drop) =>
        `'${drop.path}' loses ${drop.lines.length} line(s) carried by ` +
        `${drop.side === "base" ? "the merge-queue base" : `branch '${headSha}'`}: ` +
        `${drop.lines.slice(0, 3).map(clip).join(" | ")}`,
    )
    .join("; ")
  // What was compared and what was not, in the refusal itself: a witness that
  // reports only its findings leaves the reader unable to tell a clean bill of
  // health from a check that quietly looked at nothing.
  const scope =
    `compared ${contested.length} path(s) both parents changed, against merge base(s) [${bases.join(", ")}]` +
    (excluded.length === 0
      ? ""
      : `; excluded ${excluded.length} path(s) with no comparable lines [${list(excluded)}]`) +
    "; paths the merge deletes outright are unauthored-path-deletion's subject"
  return candidateFailure(
    "dropped-parent-contribution",
    `merging change '${pr}' branch '${headSha}' produced a result that drops content neither parent ` +
      `authored removing: ${shown}${drops.length > 4 ? ", …" : ""}\n${scope}`,
    ".",
    [...new Set(drops.map((drop) => drop.path))],
  )
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
type SynthesizedGitlinkWrapper = Readonly<{ commit: string; treeSha: string; generatedPaths: readonly string[] }>

/**
 * The ONE shaset-commit writer shared by composed changes, min-commit changes, and the
 * materialize escape hatch. It stages only gitlink entries and writes a
 * byte-stable commit through Git.commitTree's pinned identity and timestamp.
 *
 * The provisioner runs for EVERY gitlink-bearing call — one shaset commit whose
 * diff is the gitlink updates plus, when submodule manifests moved dependency
 * specs across the staged range, the regenerated `bun.lock` in the SAME tree
 * write. `generatedPaths` reports what the provisioner staged so callers can
 * tell a tree that carries a regenerated lock from one that certifies by tree
 * equality alone.
 *
 * Exported for characterization, the (a) precedent applied to (b)'s entry seam:
 * this writer had NO behavioural test while being what the shaset-commit species
 * names. The param is narrowed to the two members it uses so the characterization
 * can supply a real-repo adapter without reconstructing the whole runtime git.
 * See tests/gitlink-wrapper.test.ts and @i/10-merge-queue/b-derivation-sites.
 */
export async function synthesizeGitlinkWrapper(
  git: Pick<Git, "run" | "commitTree" | "process" | "env">,
  path: string,
  parent: string,
  updates: readonly GitlinkUpdate[],
  message: string,
  provisionPinIntent?: PinIntentProvisioner,
): Promise<Readonly<{ status: "passed"; output: SynthesizedGitlinkWrapper }> | CandidateFailure> {
  // What the wrapper still has to WRITE, which is not the same as what it was
  // asked to SET: a requested value the parent commit already records stages
  // nothing at all, so counting it as expected below turns a no-op into a
  // refusal. That is exactly what parked PR2164 for five hours on 2026-08-28 —
  // the content merge fast-forwarded `km` to the same commit the shaset fill
  // computed from the submodule's main, `update-index` had nothing to change,
  // and the proof read `expected [km], got []`. Decided from the parent's own
  // tree, never from writeGitlink's `unchanged`: the tree is the fact, the
  // return value is only a report about the index.
  const expectedPaths: string[] = []
  const carriedByParent: string[] = []
  for (const update of updates) {
    const staged = await writeQueueGitlink(git, path, update.path, update.sha)
    if (!queueGitlinkWriteSucceeded(staged)) {
      return candidateFailure(
        "wrapper-mismatch",
        `generated wrapper could not stage gitlink '${update.path}': ${queueGitlinkWriteFailure(staged)}`,
        update.path,
        [update.path],
      )
    }
    const carried = await readGitlink(git, path, parent, update.path)
    if (carried !== undefined && carried.toLowerCase() === update.sha.toLowerCase()) {
      carriedByParent.push(update.path)
      continue
    }
    expectedPaths.push(update.path)
  }
  let provisionedPaths: readonly string[] = []
  if (provisionPinIntent !== undefined && updates.length > 0) {
    const provisionalTreeSha = (await git.run(path, ["write-tree"])).stdout
    const provisionalCandidateSha = await git.commitTree(path, provisionalTreeSha, [parent], message)
    const provisioned = await provisionPinIntent({
      path,
      baseSha: parent,
      provisionalCandidateSha,
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
    provisionedPaths = generatedPaths
  }
  const materialized = await stagedPaths(git, path)
  if (!samePaths(materialized, expectedPaths)) {
    // Name what was excluded from `expected` and why, in the refusal itself:
    // an empty `got` reads as "the writer did nothing" until the reader can see
    // how many requested paths were already satisfied by the parent.
    return candidateFailure(
      "wrapper-mismatch",
      `generated wrapper paths differ: expected [${expectedPaths.join(", ")}], got [${materialized.join(", ")}]` +
        (carriedByParent.length === 0
          ? ""
          : `; excluded ${carriedByParent.length} requested gitlink(s) '${parent}' already carries ` +
            `[${carriedByParent.join(", ")}]`),
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
  return { status: "passed", output: { commit, treeSha, generatedPaths: provisionedPaths } }
}

function pinIntentCommitMessage(submodule: string, target: string, issue: string): string {
  return (
    `chore(${submodule.split("/").at(-1) ?? submodule}): advance pin to ${target.slice(0, 12)} [${issue}]\n\n` +
    `Substrate-Pair: [[${issue}]]`
  )
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

/**
 * The ONE funnel every queue-written candidate commit message passes through,
 * and therefore the one place the trailer can be guaranteed.
 *
 * It used to return a bare subject when the member carried no `changeId`. That
 * silent branch is the trailer drop: the commit still lands, and merged-truth
 * derivation — which reads `Change-Id` ancestry — cannot see the change at all,
 * answering an unknown that looks exactly like not-merged. Refuse instead. A
 * member reaching here without identity is a pre-identity journal replay, the
 * only state `ChangeSnapshot.changeId`'s optionality exists for; `plugin.ts`
 * already refuses that state at its own rebuild seams with the same remedy.
 * Pin-intent members never reach here — `prepareCandidateMembers` routes them
 * to `pinIntentCommitMessage` and `continue`s — so this covers only ordinary
 * changes, every one of which has a minted identity.
 */
function candidateChangeCommitMessage(operation: "compose" | "merge", pr: StepExecution["prs"][number]): string {
  const subject = `yrd: ${operation} ${pr.id} revision ${String(pr.revision)}`
  if (pr.changeId === undefined) {
    throw queueRefusal(
      "candidate-change-id-missing",
      `change '${pr.id}' revision ${String(pr.revision)} has no Change-Id, so the ${operation} commit ` +
        `'${subject}' would land unattributable to merged-truth derivation; the change predates stable ` +
        `Change-Id identity — ${NO_CHANGE_ID_MIGRATION_REMEDY}`,
    )
  }
  // The member and revision are STATED, not left to be regexed back out of the
  // subject. The subject stays exactly as it reads today — people find these
  // commits by it — but merged-truth no longer depends on parsing prose the
  // vocabulary is free to change. A subject the walk fails to parse does not
  // degrade gracefully: the commit becomes a specimen, and one specimen makes
  // every not-found lineage lookup in that window answer the loud unknown.
  return (
    `${subject}\n\nChange-Id: ${pr.changeId}\nMerge-Change-Id: ${mergeChangeIdFor(operation, pr.changeId)}\n` +
    `Yrd-Member: ${pr.id}\nYrd-Revision: ${String(pr.revision)}`
  )
}

/** The revision prop that carries a @cto ruling authorizing a component-model
 * add or remove. Exported so the CLI's refusal projection can PRINT the exact
 * prop a blocked author must carry (actionable-error.ts's escalation census)
 * rather than keeping a second copy of the spelling that can drift from this
 * parser. */
export const SUBMODULE_MODEL_CHANGE_PROP = "component-model-change"
const SUBMODULE_MODEL_CHANGE_VALUE =
  /^(?<operation>add|remove) (?<path>[^;\s][^;]*); ruling (?<ruling>[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/u

export function parseSubmoduleModelChangeAuthorizationValue(
  pr: string,
  value: string | undefined,
): Omit<SubmoduleModelChangeAuthorizationRequest, "pr" | "revision" | "headSha" | "patchId" | "source"> | undefined {
  if (value === undefined) return undefined
  const match = SUBMODULE_MODEL_CHANGE_VALUE.exec(value.trim())
  if (match?.groups === undefined) {
    throw queueRefusal(
      "component-model-authorization-invalid",
      `change '${pr}' has malformed '${SUBMODULE_MODEL_CHANGE_PROP}' prop; expected ` +
        `'<add|remove> <gitlink-path>; ruling <@cto-verdict-message-id>'`,
    )
  }
  return {
    operation: match.groups["operation"] as "add" | "remove",
    path: match.groups["path"] as string,
    ruling: match.groups["ruling"] as string,
  }
}

export function parseSubmoduleModelChangeAuthorization(
  pr: StepExecution["prs"][number],
): Omit<SubmoduleModelChangeAuthorizationRequest, "pr" | "revision" | "headSha" | "patchId" | "source"> | undefined {
  return parseSubmoduleModelChangeAuthorizationValue(pr.id, pr.props?.[SUBMODULE_MODEL_CHANGE_PROP])
}

/**
 * Fill in an authored gitlink delta from that submodule's main — the shaset
 * model's composition-time write, moved forward from the merge-time promotion
 * loop that used to make this comparison after checks had already run. An
 * authored gitlink is a min commit, a floor: the request queues only when
 * that submodule's main CONTAINS it (checked before queueing by the
 * yrd-cli gate; re-derived here), and the queue writes main's newest commit
 * into the shaset, so authored values never merge as-is.
 *
 * Only UPDATE deltas fill: the shaset-commit writer is update-only (comma-form
 * `--cacheinfo` cannot add a path), and added or deleted gitlinks keep the
 * authored-gitlink refusal, as does a min commit that is not on its
 * submodule's main — that refusal is the composition-side backstop until step
 * (d) deletes it. Every failure is a typed candidateFailure, never a throw.
 */
async function fillAuthoredGitlinksFromMain(
  git: Git,
  repo: string,
  path: string,
  pr: StepExecution["prs"][number],
  gitlinks: readonly string[],
  authorizeSubmoduleModelChange?: SubmoduleModelChangeAuthorizer,
): Promise<
  | Readonly<{
      status: "passed"
      output: Readonly<{
        updates: readonly GitlinkUpdate[]
        filledPins: readonly Extract<QueueSubmoduleResolutionEvidence, { kind: "pin" }>[]
        componentModelChanges: readonly SubmoduleModelChangeAuthorization[]
      }>
    }>
  | CandidateFailure
> {
  const updates: GitlinkUpdate[] = []
  const filledPins: Extract<QueueSubmoduleResolutionEvidence, { kind: "pin" }>[] = []
  const componentModelChanges: SubmoduleModelChangeAuthorization[] = []
  const refused: string[] = []
  /** Distinct from `refused`: this gitlink was neither added nor removed, and
   * the fetch that would answer "is it on main" succeeded — the min commit
   * itself is simply not published there yet (re-merge Phase 1, the shaset
   * model's own precondition, stated as its own refusal per the design call
   * at hub/yrd/2026-08-23-remerge-phase0-replay.md). Kept separate from the
   * add/remove `refused` list below: that one is a component-model ruling
   * question, this one is a "push it to main first" question, and the two
   * remedies must never collapse into one generic message. */
  const unpublished: Readonly<{ path: string; authored: string; main: string }>[] = []
  const declared = parseSubmoduleModelChangeAuthorization(pr)
  for (const gitlink of gitlinks) {
    const authored = await readGitlink(git, path, pr.headSha, gitlink)
    const current = await readGitlink(git, path, "HEAD", gitlink)
    if (authored === undefined || current === undefined) {
      const operation = authored === undefined ? "remove" : "add"
      if (declared?.operation !== operation || declared.path !== gitlink) {
        refused.push(gitlink)
        continue
      }
      if (authorizeSubmoduleModelChange === undefined) {
        return candidateFailure(
          "component-model-authorizer-unavailable",
          `change '${pr.id}' requests '${operation} ${gitlink}' under ruling '${declared.ruling}', but this Yrd host ` +
            `has no verdict-message resolver; ask @cto for the ruling and run through the hh Yrd host`,
          ".",
          [gitlink],
        )
      }
      if (pr.baseSha === undefined) {
        return candidateFailure(
          "component-model-identity-unavailable",
          `change '${pr.id}' requests '${operation} ${gitlink}' but its immutable base SHA is unavailable; ` +
            "the host cannot compute a patch-bound authorization receipt",
          ".",
          [gitlink],
        )
      }
      const patchId = await git.stablePatchId(repo, pr.baseSha, pr.headSha)
      if (patchId === undefined) {
        return candidateFailure(
          "component-model-identity-unavailable",
          `change '${pr.id}' requests '${operation} ${gitlink}' but its base-to-head diff has no stable patch identity`,
          ".",
          [gitlink],
        )
      }
      const source = pr.recut?.sources?.find(
        (entry) => entry.repo === "." && entry.toHeadSha === pr.headSha && entry.patchId === patchId,
      )
      let authorization: Readonly<{
        authorizer: string
        source?: NonNullable<SubmoduleModelChangeAuthorization["source"]>
      }>
      try {
        authorization = await authorizeSubmoduleModelChange({
          ...declared,
          pr: pr.id,
          revision: pr.revision,
          headSha: pr.headSha,
          patchId,
          ...(source === undefined ? {} : { source }),
        })
      } catch (cause) {
        return candidateFailure(
          "component-model-authorization-refused",
          `change '${pr.id}' component-model ruling '${declared.ruling}' did not authorize '${operation} ${gitlink}': ` +
            `${cause instanceof Error ? cause.message : String(cause)}`,
          ".",
          [gitlink],
        )
      }
      componentModelChanges.push(
        SubmoduleModelChangeAuthorizationSchema.parse({
          ...declared,
          authorizer: authorization.authorizer,
          pr: pr.id,
          revision: pr.revision,
          headSha: pr.headSha,
          patchId,
          ...(authorization.source === undefined ? {} : { source: authorization.source }),
        }),
      )
      continue
    }
    const submoduleRepo = join(repo, gitlink)
    const main = await resolveSubmoduleMain(git, submoduleRepo, "origin")
    if (main.status === "unavailable") {
      return candidateFailure(
        "component-main-inspection-failed",
        `change '${pr.id}' could not read submodule '${gitlink}' main to fill in the shaset: ${main.message}`,
        gitlink,
        [gitlink],
      )
    }
    if (main.sha !== authored && !(await isAncestor(git, submoduleRepo, authored, main.sha))) {
      // The min commit is not on its submodule's main (the probe fetch
      // succeeded, so absence from the fetched history is a fact about main,
      // not about the network): submodule-main-first parks this before
      // queueing.
      unpublished.push({ path: gitlink, authored, main: main.sha })
      continue
    }
    if (main.sha === authored) continue
    // Main moved past the floor: write main's newest commit into the shaset.
    updates.push({ path: gitlink, sha: main.sha })
    filledPins.push({ kind: "pin", path: gitlink, sha: main.sha })
  }
  if (unpublished.length > 0) {
    const paths = unpublished.map((entry) => entry.path)
    const detail = unpublished
      .map(
        (entry) => `'${entry.path}' authored min commit '${entry.authored}' is not on submodule main '${entry.main}'`,
      )
      .join("; ")
    return {
      ...candidateFailure(
        "min-commit-unpublished",
        `change '${pr.id}' cannot fill the shaset: ${detail}; the author's gitlink is a min commit, never a value — ` +
          "push it to the submodule's own main first; the standing submission retries on the next queue pass",
        ".",
        paths,
      ),
      retryable: true,
    }
  }
  if (refused.length > 0) {
    const workflow = await intentSubmissionWorkflow(git, path, "HEAD", pr.headSha, refused, pr.issue)
    return candidateFailure(
      "authored-gitlink",
      `change '${pr.id}' changes generated-only gitlinks [${refused.join(", ")}]; ${workflow}; ` +
        `for an addition or deletion, ask @cto for an exact ruling and carry ` +
        `--prop '${SUBMODULE_MODEL_CHANGE_PROP}=<add|remove> <path>; ruling <verdict-message-id>' on this revision`,
      ".",
      refused,
    )
  }
  return { status: "passed", output: { updates, filledPins, componentModelChanges } }
}

async function readGitlink(
  git: Pick<Git, "run">,
  repo: string,
  ref: string,
  path: string,
): Promise<string | undefined> {
  const result = await git.run(repo, ["ls-tree", "-z", ref, "--", path], true)
  if (result.code !== 0 || result.stdout === "") return undefined
  const header = /^160000 commit ([0-9a-f]{40,64})\t/u.exec(result.stdout)
  if (header === null) return undefined
  const end = result.stdout.indexOf("\0", header[0].length)
  const recordPath = result.stdout.slice(header[0].length, end === -1 ? undefined : end)
  return recordPath === path ? header[1] : undefined
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

async function stagedPaths(git: Pick<Git, "run">, repo: string): Promise<string[]> {
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

function symmetricDifference(left: readonly string[], right: readonly string[]): string[] {
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  return [...left.filter((path) => !rightSet.has(path)), ...right.filter((path) => !leftSet.has(path))].toSorted()
}

async function authoredGitlinkPaths(
  git: Git,
  repo: string,
  pr: string,
  headSha: string,
): Promise<Readonly<{ status: "passed"; output: readonly string[] }> | CandidateFailure> {
  // HEAD is the composing branch, i.e. the authoritative current base.
  const base = await authoredDeltaBase(git, repo, "HEAD", headSha)
  if (base.status === "unreadable") {
    return candidateFailure(
      "gitlink-inspection",
      `could not inspect authored gitlinks for '${headSha}': ${base.detail}`,
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
type SubmoduleMainPromotion = Readonly<{
  origin: string
  repository: string
  mainSha: string
  targetSha: string
  pins: readonly CandidateSubmodulePin[]
}>
type SubmoduleMainPromotionFailure = Readonly<{
  code: string
  message: string
  results: readonly SubmoduleMainResult[]
  refusals: readonly SubmoduleMainRefusal[]
}>
type SubmoduleMainPromotionPlan =
  | Readonly<{
      status: "passed"
      promotions: readonly SubmoduleMainPromotion[]
      results: readonly SubmoduleMainResult[]
    }>
  | Readonly<{
      status: "failed"
      error: SubmoduleMainPromotionFailure
      /** Independent origins that remain safe to fast-forward despite the refusal. */
      promotions: readonly SubmoduleMainPromotion[]
      results: readonly SubmoduleMainResult[]
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

function submoduleMainRefusals(
  pins: readonly CandidateSubmodulePin[],
  code: string,
  message: string,
  mainSha?: string,
): readonly SubmoduleMainRefusal[] {
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

function submoduleMainFailure(
  code: string,
  message: string,
  results: readonly SubmoduleMainResult[] = [],
  refusals: readonly SubmoduleMainRefusal[] = [],
): SubmoduleMainPromotionFailure {
  return {
    code,
    message: message.startsWith("yrd: ") ? message : `yrd: ${message}`,
    results,
    refusals,
  }
}

function submoduleMainOutcomes(
  results: readonly SubmoduleMainResult[],
  refusals: readonly SubmoduleMainRefusal[],
): SubmoduleMainOutcomes {
  return SubmoduleMainOutcomesSchema.parse({
    kind: "component-main-outcomes",
    results,
    refusals,
  })
}

async function fetchSubmoduleMain(
  git: Git,
  repository: string,
  origin: string,
): Promise<
  Readonly<{ status: "passed"; sha: string }> | Readonly<{ status: "failed"; error: SubmoduleMainPromotionFailure }>
> {
  // The probe lives beside COMPONENT_MAIN_REF so admission can ask it too. Resolving the
  // fetched ref used to go through the throwing rev-parse helper; a gate cannot afford a throw
  // from inside a probe, so the probe asks git tolerantly and hands back a result to classify.
  // Same information, now survivable.
  const resolved = await resolveSubmoduleMain(git, repository, origin)
  if (resolved.status === "unavailable") {
    return {
      status: "failed",
      error: submoduleMainFailure("component-main-inspection-failed", resolved.message),
    }
  }
  return { status: "passed", sha: resolved.sha }
}

async function fetchSubmodulePin(
  git: Git,
  repository: string,
  pin: CandidateSubmodulePin,
): Promise<SubmoduleMainPromotionFailure | undefined> {
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
    return submoduleMainFailure(
      "component-main-inspection-failed",
      `could not load merged pin '${pin.sha}' for '${pin.path}' from '${pin.origin}': ${messageOf(cause)}`,
    )
  }
}

async function planSubmoduleMainPromotionGroup(
  git: Git,
  origin: string,
  pins: readonly CandidateSubmodulePin[],
  untrustedOrigins: ReadonlySet<string>,
  repository: string,
): Promise<
  | Readonly<{
      status: "passed"
      promotion?: SubmoduleMainPromotion
      results: readonly SubmoduleMainResult[]
    }>
  | Readonly<{ status: "failed"; error: SubmoduleMainPromotionFailure }>
> {
  const orderedPins = pins.toSorted((left, right) => left.path.localeCompare(right.path))
  await mkdir(repository, { recursive: true })
  const initialized = await git.run(repository, ["init", "--bare"], true)
  if (initialized.code !== 0) {
    const message = `could not initialize submodule ancestry probe for '${origin}': ${
      initialized.stderr || initialized.stdout || "git init failed"
    }`
    return {
      status: "failed",
      error: submoduleMainFailure(
        "component-main-inspection-failed",
        message,
        [],
        submoduleMainRefusals(orderedPins, "component-main-inspection-failed", message),
      ),
    }
  }
  const submoduleMain = await fetchSubmoduleMain(git, repository, origin)
  if (submoduleMain.status === "failed") {
    return {
      status: "failed",
      error: submoduleMainFailure(
        submoduleMain.error.code,
        submoduleMain.error.message,
        [],
        submoduleMainRefusals(orderedPins, submoduleMain.error.code, submoduleMain.error.message),
      ),
    }
  }

  const results: SubmoduleMainResult[] = []
  const pendingPins: CandidateSubmodulePin[] = []
  for (const pin of orderedPins) {
    const missing = await fetchSubmodulePin(git, repository, pin)
    if (missing !== undefined) {
      const unresolved = orderedPins.filter((candidate) => !results.some((result) => result.path === candidate.path))
      return {
        status: "failed",
        error: submoduleMainFailure(
          missing.code,
          missing.message,
          results,
          submoduleMainRefusals(unresolved, missing.code, missing.message, submoduleMain.sha),
        ),
      }
    }

    const reached = await git.run(repository, ["merge-base", "--is-ancestor", pin.sha, submoduleMain.sha], true)
    if (reached.code === 0) {
      results.push({
        path: pin.path,
        origin: pin.origin,
        pinSha: pin.sha,
        mainBeforeSha: submoduleMain.sha,
        mainAfterSha: submoduleMain.sha,
        action: "verified",
      })
      continue
    }
    if (reached.code !== 1) {
      const message = `could not compare merged pin '${pin.sha}' for '${pin.path}' with submodule main '${
        submoduleMain.sha
      }': ${reached.stderr || reached.stdout || "git merge-base failed"}`
      const unresolved = orderedPins.filter((candidate) => !results.some((result) => result.path === candidate.path))
      return {
        status: "failed",
        error: submoduleMainFailure(
          "component-main-inspection-failed",
          message,
          results,
          submoduleMainRefusals(unresolved, "component-main-inspection-failed", message, submoduleMain.sha),
        ),
      }
    }
    pendingPins.push(pin)
  }

  let targetSha = submoduleMain.sha
  let targetPath = "submodule main"
  for (const pin of pendingPins) {
    const covered = await git.run(repository, ["merge-base", "--is-ancestor", pin.sha, targetSha], true)
    if (covered.code === 0) continue
    if (covered.code !== 1) {
      const message = `could not compare merged pin '${pin.sha}' for '${pin.path}' with planned target '${targetSha}': ${
        covered.stderr || covered.stdout || "git merge-base failed"
      }`
      return {
        status: "failed",
        error: submoduleMainFailure(
          "component-main-inspection-failed",
          message,
          results,
          submoduleMainRefusals(pendingPins, "component-main-inspection-failed", message, submoduleMain.sha),
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
        error: submoduleMainFailure(
          "component-main-inspection-failed",
          message,
          results,
          submoduleMainRefusals(pendingPins, "component-main-inspection-failed", message, submoduleMain.sha),
        ),
      }
    }
    const containment = await inspectBaseContainment(git, repository, targetSha, pin.sha)
    if (containment.status === "inspection-failed") {
      const message = `could not inspect merged pin '${pin.sha}' for '${pin.path}' against planned submodule target '${targetSha}': ${containment.detail}`
      return {
        status: "failed",
        error: submoduleMainFailure(
          "component-main-inspection-failed",
          message,
          results,
          submoduleMainRefusals(pendingPins, "component-main-inspection-failed", message, submoduleMain.sha),
        ),
      }
    }
    if (containment.status === "drops-merged") {
      const message = `merged pin '${pin.path}' '${pin.sha}' does not contain planned submodule target '${targetSha}' at '${origin}' and would drop merged commits:\n${containment.commits}`
      return {
        status: "failed",
        error: submoduleMainFailure(
          "carrier-drops-landed",
          message,
          results,
          submoduleMainRefusals(pendingPins, "carrier-drops-landed", message, submoduleMain.sha),
        ),
      }
    }
    const message = `NON-ANCESTRAL submodule lineage at '${origin}': ${targetPath} '${targetSha}' and merged pin '${pin.path}' '${pin.sha}' diverge; compose the divergent submodule histories before retrying`
    return {
      status: "failed",
      error: submoduleMainFailure(
        "component-main-non-ancestral",
        message,
        results,
        submoduleMainRefusals(pendingPins, "component-main-non-ancestral", message, submoduleMain.sha),
      ),
    }
  }
  if (targetSha === submoduleMain.sha) return { status: "passed", results }

  const untrusted = pendingPins.map((pin) => pin.path).filter((path) => untrustedOrigins.has(path))
  if (untrusted.length > 0) {
    const message = `new submodule [${untrusted.join(", ")}] requires main to advance at '${origin}'; review the new remote before granting main-update authority`
    return {
      status: "failed",
      error: submoduleMainFailure(
        "component-main-origin-untrusted",
        message,
        results,
        submoduleMainRefusals(pendingPins, "component-main-origin-untrusted", message, submoduleMain.sha),
      ),
    }
  }
  return {
    status: "passed",
    promotion: {
      origin,
      repository,
      mainSha: submoduleMain.sha,
      targetSha,
      pins: pendingPins,
    },
    results,
  }
}

async function planSubmoduleMainPromotions(
  git: Git,
  repo: string,
  baseSha: string | undefined,
  candidateSha: string,
  scratchRoot: string,
): Promise<SubmoduleMainPromotionPlan> {
  const candidatePins = await candidateSubmodulePins(git, repo, repo, candidateSha)
  const basePins =
    baseSha === undefined
      ? new Map<string, CandidateSubmodulePin>()
      : new Map((await candidateSubmodulePins(git, repo, repo, baseSha)).map((pin) => [pin.path, pin] as const))
  const changed: CandidateSubmodulePin[] = []
  const untrustedOrigins = new Set<string>()
  const directRefusals: SubmoduleMainRefusal[] = []
  let directFailure: SubmoduleMainPromotionFailure | undefined
  for (const pin of candidatePins) {
    if (baseSha !== undefined && (await readGitlink(git, repo, baseSha, pin.path)) === pin.sha) continue
    const basePin = basePins.get(pin.path)
    if (baseSha === undefined) {
      // A merged root tree is the authority for its own submodule registry.
      // Reconciliation therefore trusts its standing .gitmodules origins and
      // audits every pin, including gaps left by earlier failed actuators.
    } else if (basePin === undefined) {
      untrustedOrigins.add(pin.path)
    } else if (basePin.origin !== pin.origin) {
      const message = `submodule origin for '${pin.path}' changed from '${basePin.origin}' to '${pin.origin}'; review the new remote before granting main-update authority`
      directFailure ??= submoduleMainFailure("component-main-origin-changed", message)
      directRefusals.push(...submoduleMainRefusals([pin], "component-main-origin-changed", message))
      continue
    }
    changed.push(pin)
  }
  const groups = new Map<string, CandidateSubmodulePin[]>()
  for (const pin of changed) groups.set(pin.origin, [...(groups.get(pin.origin) ?? []), pin])

  const promotions: SubmoduleMainPromotion[] = []
  const results: SubmoduleMainResult[] = []
  const refusals: SubmoduleMainRefusal[] = [...directRefusals]
  let failure = directFailure
  let groupIndex = 0
  for (const [origin, pins] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    const repository = join(scratchRoot, `component-${String(groupIndex)}`)
    groupIndex += 1
    const planned = await planSubmoduleMainPromotionGroup(git, origin, pins, untrustedOrigins, repository)
    if (planned.status === "failed") {
      failure ??= planned.error
      results.push(...planned.error.results)
      refusals.push(...planned.error.refusals)
      continue
    }
    results.push(...planned.results)
    if (planned.promotion !== undefined) promotions.push(planned.promotion)
  }
  return failure === undefined
    ? { status: "passed", promotions, results }
    : {
        status: "failed",
        error: { ...failure, results, refusals },
        promotions,
        results,
      }
}

async function applySubmoduleMainPromotions(
  git: Git,
  promotions: readonly SubmoduleMainPromotion[],
  initialResults: readonly SubmoduleMainResult[],
): Promise<
  | Readonly<{ status: "passed"; results: readonly SubmoduleMainResult[] }>
  | Readonly<{ status: "failed"; error: SubmoduleMainPromotionFailure }>
> {
  const results = [...initialResults]
  const refusals: SubmoduleMainRefusal[] = []
  let failure: SubmoduleMainPromotionFailure | undefined
  const transport = adaptProcessGit(git.process, { env: git.env, timeoutMs: GIT_TIMEOUT_MS })
  for (const promotion of promotions) {
    const update = {
      repository: promotion.repository,
      remote: promotion.origin,
      source: promotion.targetSha,
      destination: SUBMODULE_MAIN_REF,
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
      // non-bare submodule origin. updateInstead is the receiver's safe mode:
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
      results.push(
        ...promotion.pins.map(
          (pin): SubmoduleMainResult => ({
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

    const refreshed = await fetchSubmoduleMain(git, promotion.repository, promotion.origin)
    if (refreshed.status === "failed") {
      const message = `submodule main promotion for [${promotion.pins.map((pin) => pin.path).join(", ")}] ${
        pushed.state
      } but its result could not be verified: ${refreshed.error.message}`
      failure ??= submoduleMainFailure("component-main-promotion-failed", message)
      refusals.push(
        ...submoduleMainRefusals(promotion.pins, "component-main-promotion-failed", message, promotion.mainSha),
      )
      continue
    }
    const reached = await git.run(
      promotion.repository,
      ["merge-base", "--is-ancestor", promotion.targetSha, refreshed.sha],
      true,
    )
    if (reached.code === 0) {
      results.push(
        ...promotion.pins.map(
          (pin): SubmoduleMainResult => ({
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
      const message = `could not verify submodule main after promoting [${promotion.pins
        .map((pin) => pin.path)
        .join(", ")}]: ${reached.stderr || reached.stdout || "git merge-base failed"}`
      failure ??= submoduleMainFailure("component-main-promotion-failed", message)
      refusals.push(...submoduleMainRefusals(promotion.pins, "component-main-promotion-failed", message, refreshed.sha))
      continue
    }
    const stillFastForward = await git.run(
      promotion.repository,
      ["merge-base", "--is-ancestor", refreshed.sha, promotion.targetSha],
      true,
    )
    if (stillFastForward.code === 1) {
      const message = `NON-ANCESTRAL submodule lineage at '${promotion.origin}': submodule main '${
        refreshed.sha
      }' diverged from merged pin '${promotion.targetSha}' for [${promotion.pins
        .map((pin) => pin.path)
        .join(", ")}]; compose the divergent histories`
      failure ??= submoduleMainFailure("component-main-diverged-after-landing", message)
      refusals.push(
        ...submoduleMainRefusals(promotion.pins, "component-main-diverged-after-landing", message, refreshed.sha),
      )
      continue
    }
    const message =
      stillFastForward.code === 0
        ? `could not fast-forward submodule main from '${promotion.mainSha}' to '${promotion.targetSha}' for [${promotion.pins
            .map((pin) => pin.path)
            .join(", ")}]: ${pushDetail}`
        : `could not compare refreshed submodule main '${refreshed.sha}' with '${promotion.targetSha}' for [${promotion.pins
            .map((pin) => pin.path)
            .join(", ")}]: ${stillFastForward.stderr || stillFastForward.stdout || "git merge-base failed"}`
    failure ??= submoduleMainFailure("component-main-promotion-failed", message)
    refusals.push(...submoduleMainRefusals(promotion.pins, "component-main-promotion-failed", message, refreshed.sha))
  }
  return failure === undefined
    ? { status: "passed", results }
    : {
        status: "failed",
        error: {
          ...failure,
          results,
          refusals,
        },
      }
}

function submoduleMainFailureResult(error: SubmoduleMainPromotionFailure): JobResult<never> {
  return failedWithEvidence(error.code, error.message, submoduleMainOutcomes(error.results, error.refusals))
}

function submoduleMainEvidence(result: JobResult<IntegrationProof>): SubmoduleMainOutcomes | undefined {
  if (result.status === "completed" && result.conclusion === "success") {
    return submoduleMainOutcomes(result.output.componentMains ?? [], [])
  }
  if (result.status !== "completed" || result.conclusion !== "failure") return undefined
  const parsed = SubmoduleMainOutcomesSchema.safeParse(result.error.evidence)
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

function missingSubmoduleMainOutcomes(
  promotions: readonly SubmoduleMainPromotion[],
  plannedResults: readonly SubmoduleMainResult[],
  recordedResults: readonly SubmoduleMainResult[],
): readonly CandidateSubmodulePin[] {
  const recorded = new Set(recordedResults.map(({ origin, path, pinSha }) => `${origin}\0${path}\0${pinSha}`))
  const expected = [
    ...plannedResults.map(({ origin, path, pinSha }): CandidateSubmodulePin => ({ origin, path, sha: pinSha })),
    ...promotions.flatMap(({ pins }) => pins),
  ]
  return expected.filter(({ origin, path, sha }) => !recorded.has(`${origin}\0${path}\0${sha}`))
}

async function withSubmoduleMainPromotions(
  git: Git,
  repo: string,
  baseSha: string | undefined,
  candidateSha: string,
  run: (
    promotions: readonly SubmoduleMainPromotion[],
    results: readonly SubmoduleMainResult[],
  ) => Promise<JobResult<IntegrationProof>>,
  options: Readonly<{ settleSafePromotions?: boolean }> = {},
): Promise<JobResult<IntegrationProof>> {
  return withScratchRoot(git, repo, "yrd-component-main-", undefined, (root) =>
    submoduleMainPromotionsIn(git, repo, baseSha, candidateSha, run, options, root),
  )
}

async function submoduleMainPromotionsIn(
  git: Git,
  repo: string,
  baseSha: string | undefined,
  candidateSha: string,
  run: (
    promotions: readonly SubmoduleMainPromotion[],
    results: readonly SubmoduleMainResult[],
  ) => Promise<JobResult<IntegrationProof>>,
  options: Readonly<{ settleSafePromotions?: boolean }>,
  root: string,
): Promise<JobResult<IntegrationProof>> {
  let outcome: JobResult<IntegrationProof> | undefined
  let operationFailure: unknown
  try {
    const planned = await planSubmoduleMainPromotions(git, repo, baseSha, candidateSha, root)
    if (planned.status === "failed" && options.settleSafePromotions !== true) {
      const abortMessage =
        "submodule main promotion was not attempted because another changed submodule failed preflight"
      const aborted = planned.promotions.flatMap((promotion) =>
        submoduleMainRefusals(promotion.pins, "component-main-preflight-aborted", abortMessage, promotion.mainSha),
      )
      outcome = submoduleMainFailureResult({
        ...planned.error,
        refusals: [...planned.error.refusals, ...aborted],
      })
    } else {
      outcome = await run(planned.promotions, planned.results)
      if (planned.status === "failed") {
        const settled = submoduleMainEvidence(outcome)
        outcome = submoduleMainFailureResult({
          ...planned.error,
          results: settled?.results ?? planned.results,
          refusals: [...planned.error.refusals, ...(settled?.refusals ?? [])],
        })
      } else if (outcome.status === "completed" && outcome.conclusion === "success") {
        const missing = missingSubmoduleMainOutcomes(
          planned.promotions,
          planned.results,
          outcome.output.componentMains ?? [],
        )
        if (missing.length > 0) {
          const message = `submodule main action produced no result or refusal for [${missing
            .map(({ path }) => path)
            .join(", ")}]`
          outcome = submoduleMainFailureResult(
            submoduleMainFailure(
              "component-main-outcome-missing",
              message,
              outcome.output.componentMains ?? [],
              submoduleMainRefusals(missing, "component-main-outcome-missing", message),
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
  if (outcome === undefined) throw new Error("submodule main promotion produced no result")
  if ((outcome.status === "completed" && outcome.conclusion === "failure") || cleanupFailure === undefined) {
    return outcome
  }
  return submoduleMainScratchCleanupFailure(outcome, cleanupFailure)
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
    const staged = await writeQueueGitlink(git, path, resolution.path, resolution.sha)
    if (!queueGitlinkWriteSucceeded(staged)) {
      throw createSubmoduleCompositionRefusal(
        repo,
        resolution.path,
        `could not stage composed pin for '${resolution.path}': ${queueGitlinkWriteFailure(staged)}`,
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
    /** Repo-relative gate-script paths that execute at the BASE ref's version
     * (23183): before the candidate command runs, every declared path that
     * differs is materialized from the candidate's base sha into the execution
     * checkout and restored afterwards, so a change editing its own gate
     * script is judged by the pre-edit script. Local runner only. */
    scripts?: readonly string[]
    refuse?: RefusePathsPolicy
    /** The shaset provisioner for candidates this step RECONSTRUCTS itself
     * (no runner context). Without it a reconstructed candidate would compose
     * moved gitlinks with an unregenerated lock and hand that tree to checks —
     * the runner-context path gets the provisioner through prepareCandidate
     * instead. */
    provisionPinIntent?: PinIntentProvisioner
    authorizeSubmoduleModelChange?: SubmoduleModelChangeAuthorizer
    /** Generate data-only checkpoint migration evidence from the exact target
     * Candidate checkout inside this certified check invocation. */
    checkpointMigration?: (input: {
      path: string
      candidate: Pick<PinnedCandidate, "baseSha" | "candidateSha">
    }) => Promise<CheckpointMigrationAttestation>
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
  checkpointMigration?: CheckpointMigrationAttestation,
): GateCertificate {
  return GateCertificateSchema.parse({
    version: 1,
    mode,
    baseSha: candidate.baseSha,
    candidateSha: candidate.candidateSha,
    reports,
    ...(checkpointMigration === undefined ? {} : { checkpointMigration }),
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
      certificate: gateCertificate(candidate, mode, reports, outcome.output.checkpointMigration),
    }),
  }
}

function attachCheckpointMigrationAttestation(
  outcome: JobResult<CommandEvidence>,
  attestation: CheckpointMigrationAttestation | undefined,
  purpose: string,
): JobResult<CommandEvidence> {
  if (attestation === undefined) return outcome
  if (outcome.status === "waiting") {
    const checkpoint = outcome.checkpoint as CommandEvidence
    const existing = checkpoint.checkpointMigration
    if (existing !== undefined && existing.hash !== attestation.hash) {
      return failed(
        `${purpose}-checkpoint-migration-surface-disagreement`,
        "configured command and target Candidate assembly derived different checkpoint migration manifests",
        checkpoint,
      )
    }
    return {
      ...outcome,
      checkpoint: CommandEvidenceSchema.parse({ ...checkpoint, checkpointMigration: attestation }),
    }
  }
  if (outcome.output === undefined) return outcome
  const existing = outcome.output.checkpointMigration
  if (existing !== undefined && existing.hash !== attestation.hash) {
    return failed(
      `${purpose}-checkpoint-migration-surface-disagreement`,
      "configured command and target Candidate assembly derived different checkpoint migration manifests",
      outcome.output,
    )
  }
  return {
    ...outcome,
    output: CommandEvidenceSchema.parse({ ...outcome.output, checkpointMigration: attestation }),
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
    provisionPinIntent?: PinIntentProvisioner
    authorizeSubmoduleModelChange?: SubmoduleModelChangeAuthorizer
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
      options.provisionPinIntent,
      options.authorizeSubmoduleModelChange,
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
        ...(candidate.output.submoduleResolutions.length === 0
          ? {}
          : { submoduleResolutions: candidate.output.submoduleResolutions }),
        ...(candidate.output.componentModelChanges.length === 0
          ? {}
          : { componentModelChanges: candidate.output.componentModelChanges }),
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
    refuse?: RefusePathsPolicy
    provisionPinIntent?: PinIntentProvisioner
    authorizeSubmoduleModelChange?: SubmoduleModelChangeAuthorizer
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
      ...(candidate.componentModelChanges === undefined
        ? {}
        : { componentModelChanges: candidate.componentModelChanges }),
    }),
  )
}

/** What one gate-script overlay did to the execution checkout, and how to
 * undo it. `differing` empty means the change touched no declared path and
 * NOTHING was mutated — the common case, and the reason this costs one `git
 * diff` per gated check. */
export type GateScriptOverlay = Readonly<{
  differing: readonly string[]
  restore(): Promise<void>
}>

/** The one git capability the overlay needs, so the CLI's pre-submit runner
 * (a different process adapter) can reuse it. */
export type GateScriptGit = Readonly<{
  run(
    cwd: string,
    args: readonly string[],
    allowFailure?: boolean,
  ): Promise<Readonly<{ code: number; stdout: string; stderr: string }>>
}>

/** Make the declared gate-script paths in `checkout` read as the BASE ref's
 * version for the duration of a check (23183): every file under the declared
 * paths that differs between the candidate and its base is replaced with the
 * base's content (a file the base does not hold is removed), and `restore()`
 * puts the candidate's own content back so the checkout stays a pure
 * candidate materialization for whatever runs next. Fails loud — a gate whose
 * script cannot be pinned to the base must not run at all. */
export async function overlayGateScripts(
  git: GateScriptGit,
  checkout: string,
  baseSha: string,
  candidateSha: string,
  paths: readonly string[],
): Promise<GateScriptOverlay> {
  for (const path of paths) {
    const held = await git.run(checkout, ["cat-file", "-e", `${baseSha}:${path}`], true)
    if (held.code !== 0) {
      throw createFailure({
        kind: "refusal",
        code: "gate-script-missing-at-base",
        message:
          `yrd: gate script '${path}' does not exist at base ${baseSha.slice(0, 8)}. Gate scripts execute at the ` +
          "base ref's version, so a script must be ON the base before a check may run it; a change adding both " +
          "lands the script first (it takes effect for the NEXT change).",
      })
    }
  }
  const diff = await git.run(checkout, ["diff", "--name-only", baseSha, candidateSha, "--", ...paths], true)
  if (diff.code !== 0) {
    throw createFailure({
      kind: "infrastructure",
      code: "gate-script-diff-failed",
      message: `yrd: could not compare gate scripts between ${baseSha.slice(0, 8)} and ${candidateSha.slice(0, 8)}: ${diff.stderr.trim() || `git diff exited ${String(diff.code)}`}`,
    })
  }
  const differing = diff.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
  if (differing.length === 0) return { differing, restore: () => Promise.resolve() }

  const materialize = async (sourceSha: string, side: string): Promise<void> => {
    const present: string[] = []
    for (const file of differing) {
      const held = await git.run(checkout, ["cat-file", "-e", `${sourceSha}:${file}`], true)
      if (held.code === 0) present.push(file)
      else await rm(join(checkout, file), { force: true })
    }
    if (present.length === 0) return
    const restored = await git.run(checkout, ["checkout", sourceSha, "--", ...present], true)
    if (restored.code !== 0) {
      throw createFailure({
        kind: "infrastructure",
        code: "gate-script-overlay-failed",
        message:
          `yrd: could not materialize the ${side} version of gate scripts ${present.join(", ")} at ` +
          `${sourceSha.slice(0, 8)}: ${restored.stderr.trim() || `git checkout exited ${String(restored.code)}`}`,
      })
    }
  }
  await materialize(baseSha, "base")
  return {
    differing,
    restore: () => materialize(candidateSha, "candidate"),
  }
}

export function gitCheckStep(options: GitCheckOptions): StepRunner<ChangeShape, GitCheckResultEvidence> {
  const repo = resolve(options.repo)
  const git = createGit(options.inject.process, options.env)
  const mode = options.mode ?? "delta"
  // 23183: declared gate scripts execute at the BASE ref's version. The pin
  // covers the whole candidate execution — the parent comparison runs in its
  // own base-sha scratch checkout, where the scripts already ARE the base's —
  // and the restore in `finally` returns the checkout to a pure candidate
  // materialization for whatever runs next (a restore failure is loud: a
  // poisoned worktree must never pass silently). Waiting-runner steps refuse
  // `scripts` at config validation; the pin cannot outlive this call.
  const withGatePinnedScripts =
    (body: (path: string, candidate: PinnedCandidate) => Promise<JobResult<GitCheckResultEvidence>>) =>
    async (path: string, candidate: PinnedCandidate): Promise<JobResult<GitCheckResultEvidence>> => {
      const overlay =
        options.scripts === undefined || options.scripts.length === 0
          ? undefined
          : await overlayGateScripts(git, path, candidate.baseSha, candidate.candidateSha, options.scripts)
      try {
        return await body(path, candidate)
      } finally {
        await overlay?.restore()
      }
    }
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
          ...(options.provisionPinIntent === undefined ? {} : { provisionPinIntent: options.provisionPinIntent }),
          ...(options.authorizeSubmoduleModelChange === undefined
            ? {}
            : { authorizeSubmoduleModelChange: options.authorizeSubmoduleModelChange }),
        },
        (failure) => failed(failure.error.code, failure.error.message, failure.output),
        withGatePinnedScripts(async (path, candidate): Promise<JobResult<GitCheckResultEvidence>> => {
          const artifactRoot = options.artifactRoot ?? join(repo, ".git", "yrd", "artifacts")
          const configured = (
            cwd: string,
            targetSha: string,
            root: string,
            parentTree: boolean,
          ): ConfiguredCommandOptions<ChangeShape> => ({
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
          const checkpointMigration = async (): Promise<CheckpointMigrationAttestation | undefined> =>
            options.checkpointMigration === undefined
              ? undefined
              : CheckpointMigrationAttestationSchema.parse(await options.checkpointMigration({ path, candidate }))

          if (options.runner === "waiting") {
            const outcome = attachCheckpointMigrationAttestation(
              await configuredWaitingCommandStep(candidateConfig)(
                { ...input, targetSha: candidate.candidateSha },
                context,
              ),
              await checkpointMigration(),
              purpose,
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
            if (outcome.error.code === `${purpose}${INFRASTRUCTURE_SIGNAL_FAILURE_SUFFIX}`) {
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
            outcome = attachCheckpointMigrationAttestation(
              await configuredCommandStep(candidateConfig)({ ...input, targetSha: candidate.candidateSha }, context),
              await checkpointMigration(),
              purpose,
            )
          } catch (cause) {
            const fact = failureFact(cause)
            // The DRIVER's own writes — the artifact sink, the terminal
            // record — can hit the same ENOSPC/EDQUOT the check's process did,
            // and they surface as a throw rather than an exit status. Name it
            // as the storage failure it is; the outer `queue-environment-refused`
            // already carries the environment disposition.
            const error = JobErrorSchema.parse({
              code:
                fact?.code ??
                (isStorageExhaustion(cause) ? CHECK_STORAGE_EXHAUSTED : `${purpose}-candidate-execution-unavailable`),
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

          if (outcome.error.code === `${purpose}${INFRASTRUCTURE_SIGNAL_FAILURE_SUFFIX}`) {
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
                // The scratch is a bare detached worktree: every gitlink is an
                // empty directory until materialized. Where workspace members
                // live in submodules, the parent command's own dependency
                // install then dies on unresolvable `workspace:*` globs — the
                // candidate leg never sees this because its pool checkout
                // materializes (candidate-pool), as do the merge paths and the
                // CLI pre-submit runner (22755). Borrowing from the primary
                // checkout keeps this network-free, and a refusal throws into
                // this step's parent execution-refusal catch below: running
                // the parent command in an incomplete tree would report an
                // environment artifact as the base's verdict.
                const submodules = await materializeSubmodules(git, {
                  worktree: scratchPath,
                  referenceWorktree: repo,
                })
                if (submodules.code !== 0) {
                  throw createFailure({
                    kind: "infrastructure",
                    code: "parent-submodules-failed",
                    message: submodules.stderr || submodules.stdout || "could not materialize parent submodules",
                  })
                }
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
            parentOutcome.error.code === `${purpose}${INFRASTRUCTURE_SIGNAL_FAILURE_SUFFIX}`
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

          const comparisonArtifactsUnavailable = (
            phase: "parent" | "candidate",
            cause: unknown,
          ): JobResult<GitCheckResultEvidence> => {
            const error = JobErrorSchema.parse({
              code: `${purpose}-${phase}-diagnostics-artifact-unavailable`,
              message: `${purpose} ${phase} diagnostics artifact could not be read: ${messageOf(cause)}`,
            })
            const refusal = GitCheckComparisonRefusalEvidenceSchema.parse({
              ...candidate,
              kind: "check-comparison-refusal",
              phase,
              error,
              parent: parentEvidence,
              candidateEvidence,
              retryable: true,
            })
            return failedWithEvidence(
              "queue-environment-refused",
              `${purpose} ${phase} diagnostics artifact could not be compared: ${error.message}`,
              refusal,
            )
          }
          let candidateDiagnostics: readonly CommandDiagnostic[]
          try {
            candidateDiagnostics = await completeComparisonDiagnostics(candidateEvidence, path)
          } catch (cause) {
            return comparisonArtifactsUnavailable("candidate", cause)
          }
          let parentDiagnostics: readonly CommandDiagnostic[]
          try {
            parentDiagnostics = await completeComparisonDiagnostics(parentEvidence, parentPath)
          } catch (cause) {
            return comparisonArtifactsUnavailable("parent", cause)
          }
          const comparison = compareCommandEvidence(
            parentEvidence,
            parentDiagnostics,
            candidateEvidence,
            candidateDiagnostics,
          )
          const evidence = GitCheckEvidenceSchema.parse({
            ...candidateEvidence,
            ...candidateMetadata,
            comparison,
            certificate: gateCertificate(
              candidate,
              mode,
              [
                ...(candidateEvidence.gateReports ?? []),
                createGateReport("diagnostics", candidateDiagnostics.map(diagnosticIdentity)),
              ],
              candidateEvidence.checkpointMigration,
            ),
          })
          if (comparison.netNewDiagnostics.length === 0) {
            return { status: "completed", conclusion: "success", output: evidence }
          }
          return { status: "completed", conclusion: "failure", error: outcome.error, output: evidence }
        }),
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
  Readonly<{
    repo: string
    env?: NodeJS.ProcessEnv
    refuse?: RefusePathsPolicy
    checkpointIdentity?: string | (() => string)
    /** The shaset provisioner for candidates the merge step reconstructs
     * itself (no prior check evidence, no runner context). */
    provisionPinIntent?: PinIntentProvisioner
  }>

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
    checkpointIdentity?: string | (() => string)
    /** The shaset provisioner for candidates the merge step reconstructs
     * itself (no prior check evidence, no runner context). */
    provisionPinIntent?: PinIntentProvisioner
  }>

function checkedCandidate(shape: ChangeShape): GitCheckEvidence | undefined {
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

/** Every refusal below names what was actually compared — this queue's own
 * stored checkpoint identity, the Candidate's base/Candidate sha pair, and
 * once a certificate exists, its manifest hash and declared edges — so the
 * refusal is reproducible from its own printed text and a dead landing path
 * is never discovered only by a human reading the habitant runner's log by
 * hand (@i/10-yrd/checkpoint-refusal-names-its-input).
 *
 * Remedy order is not arbitrary. For the three path-* codes the cheap cure is
 * almost always THIS runner's own checkout having drifted from the recorded
 * gitlink: restoring it changes `currentIdentity` and commonly clears the
 * refusal with no code change. Only once the checkout is confirmed correct
 * does the manifest itself need a corrected edge — a shipped code change, and
 * therefore the expensive cure, named second. certificate-missing/-stale are
 * a different shape: the Candidate's OWN certificate is what is wrong, so the
 * cheap cure there is re-running checks-before-queueing for it, never a
 * checkout sync. */
function checkpointMigrationAdmissionRefusal(
  candidate: PinnedCandidate,
  currentIdentity: string,
): Readonly<{ code: string; message: string }> | undefined {
  const certificate = candidate.certificate
  const attestation = certificate?.checkpointMigration
  if (certificate === undefined || attestation === undefined) {
    return {
      code: "checkpoint-migration-certificate-missing",
      message:
        `Candidate '${candidate.candidateSha}' on base '${candidate.baseSha}' has no certified checkpoint migration manifest\n` +
        `compared: this queue's stored checkpoint identity '${currentIdentity}' against the Candidate's certificate, which is absent\n` +
        "cause: the Candidate was checked without checkpoint migration certification attached — an older or differently-configured check run\n" +
        "remedy: re-run checks-before-queueing for this Candidate so it certifies a manifest; if checks already ran on the current build and still produced none, that check run itself is the defect to chase next",
    }
  }
  if (certificate.baseSha !== candidate.baseSha || certificate.candidateSha !== candidate.candidateSha) {
    return {
      code: "checkpoint-migration-certificate-stale",
      message:
        `certificate manifest '${attestation.hash}' is bound to base '${certificate.baseSha}' Candidate '${certificate.candidateSha}', not the current base '${candidate.baseSha}' Candidate '${candidate.candidateSha}'\n` +
        `compared: the certificate's own base/Candidate binding against the Candidate now being merged; this queue's stored checkpoint identity is '${currentIdentity}'\n` +
        "cause: the Candidate moved — rebased or re-pinned — after it was checked, so its certificate no longer describes the commit pair being merged\n" +
        "remedy: re-run checks-before-queueing against the current base so a fresh certificate binds the moved Candidate; the stale certificate cannot be reused",
    }
  }

  const target = attestation.manifest.targetIdentity
  if (currentIdentity === target) return undefined
  const edgesBySource = new Map<string, { from: string; to: string }[]>()
  for (const edge of attestation.manifest.edges) {
    const existing = edgesBySource.get(edge.from) ?? []
    existing.push(edge)
    edgesBySource.set(edge.from, existing)
  }
  const compared =
    `compared: this queue's stored checkpoint identity '${currentIdentity}' against target '${target}' declared by ` +
    `certificate manifest '${attestation.hash}' (base '${candidate.baseSha}' Candidate '${candidate.candidateSha}')`
  const checkoutRemedy =
    "remedy: sync or restore this runner's own checkout to the recorded gitlink first — a running identity that " +
    "drifted from what was certified is the common cause and clears with no code change; only once the checkout " +
    "is confirmed correct does the manifest need a corrected edge, which is a code change"
  const visited = new Set<string>()
  let identity = currentIdentity
  while (identity !== target) {
    if (visited.has(identity)) {
      return {
        code: "checkpoint-migration-path-cyclic",
        message:
          `path from stored identity '${currentIdentity}' to target '${target}' cycles back to '${identity}' via [${[...visited].map((step) => `'${step}'`).join(" -> ")}]\n` +
          `${compared}\n` +
          "cause: the manifest declares a migration edge back into an identity already visited on this walk, so no path from the stored identity reaches the target\n" +
          checkoutRemedy,
      }
    }
    visited.add(identity)
    const next = edgesBySource.get(identity) ?? []
    if (next.length === 0) {
      return {
        code: "checkpoint-migration-path-missing",
        message:
          `manifest has no edge from '${identity}' toward target '${target}' (walk started at stored identity '${currentIdentity}')\n` +
          `${compared}\n` +
          "cause: the manifest's declared edges stop short of the target from this identity\n" +
          checkoutRemedy,
      }
    }
    if (next.length > 1) {
      return {
        code: "checkpoint-migration-path-ambiguous",
        message:
          `manifest has ${next.length} edges from identity '${identity}' (to [${next.map((edge) => `'${edge.to}'`).join(", ")}]) while walking stored identity '${currentIdentity}' toward target '${target}'\n` +
          `${compared}\n` +
          "cause: the manifest declares more than one successor from this identity, so the path is not deterministic\n" +
          checkoutRemedy,
      }
    }
    identity = next[0]?.to ?? identity
  }
  return undefined
}

async function validatePinnedCandidate(
  git: Git,
  repo: string,
  input: StepExecution,
  baseSha: string,
  checked: PinnedCandidate,
  checkpointIdentity?: string,
): Promise<PinnedCandidateResult> {
  let pinned = checked
  if (checked.baseSha !== baseSha) {
    const attemptedMerge =
      (await mergeAttemptRefs(git, repo, input, checked)).length > 0 &&
      (await git.run(repo, ["merge-base", "--is-ancestor", checked.candidateSha, baseSha], true)).code === 0
    const current = input.candidate
    const treeEquivalent =
      primaryPR(input).intent !== undefined &&
      checked.candidateTreeSha !== undefined &&
      current?.treeSha === checked.candidateTreeSha &&
      current.sha !== undefined &&
      current.ref !== undefined
    if (!treeEquivalent && !attemptedMerge) {
      return {
        error: {
          code: "stale-check",
          message: `queue '${primaryPR(input).base}' moved from checked base '${checked.baseSha}' to '${baseSha}'`,
        },
      }
    }
    if (!attemptedMerge) {
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
  if (checkpointIdentity !== undefined) {
    const refused = checkpointMigrationAdmissionRefusal(pinned, checkpointIdentity)
    if (refused !== undefined) return { error: refused }
  }
  if ((await git.commit(repo, pinned.candidateRef)) !== pinned.candidateSha) {
    return { error: { code: "stale-check", message: "checked candidate ref moved" } }
  }
  const sourceRefError = await sourceCandidateRefError(git, repo, pinned.sourceRewrites ?? [])
  if (sourceRefError !== undefined) return { error: { code: "invalid-candidate", message: sourceRefError } }
  const finalSources = new Map<string, SourceRewrite>()
  for (const source of pinned.sourceRewrites ?? []) finalSources.set(source.repo, source)
  const finalResolutions = new Map<string, QueueSubmoduleResolutionEvidence>()
  for (const resolution of pinned.submoduleResolutions ?? []) finalResolutions.set(resolution.path, resolution)
  for (const source of finalSources.values()) {
    // A recorded resolution is the LATER, final word for its path: the queue
    // filled in the submodule's value past the certified source tip (or a
    // conflict resolution re-authored it), and the resolution loop below holds
    // that path to its recorded value instead.
    if (finalResolutions.has(source.repo)) continue
    if ((await readGitlink(git, repo, pinned.candidateSha, source.repo)) !== source.newTipSha) {
      return {
        error: {
          code: "invalid-candidate",
          message: `checked candidate does not pin source '${source.repo}' to '${source.newTipSha}'`,
        },
      }
    }
  }
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
  options: Readonly<{
    artifactRoot?: string
    refuse?: RefusePathsPolicy
    checkpointIdentity?: string | (() => string)
    provisionPinIntent?: PinIntentProvisioner
  }>,
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
            ...(options.provisionPinIntent === undefined ? {} : { provisionPinIntent: options.provisionPinIntent }),
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
  const checkpointIdentity =
    typeof options.checkpointIdentity === "function" ? options.checkpointIdentity() : options.checkpointIdentity
  const validated = await validatePinnedCandidate(git, repo, input, base.sha, checked, checkpointIdentity)
  if ("error" in validated) return { status: "completed", conclusion: "failure", error: validated.error }
  // Last comparison before either merge step publishes: `checked` is the pin
  // both of them merge, and `base.sha` is what they merge it onto.
  const erased = await mergeDeletionFloor(git, repo, input, base.sha, checked)
  if (erased !== undefined) return { status: "completed", conclusion: "failure", error: erased.error }
  const regressed = await mergeGitlinkFloor(git, repo, input, base.sha, checked)
  if (regressed !== undefined) return { status: "completed", conclusion: "failure", error: regressed.error }
  return { status: "completed", conclusion: "success", base, checked }
}

/** The floor under every route into a merge. `unauthoredDeletionFailure` rules
 * on ONE carrier at the moment its merge is composed, and four routes reach the
 * merge step past it: a candidate reused from an earlier step, the
 * submodule-composition branch that re-authors its own tree and `continue`s, a
 * conflicted merge settled by that branch, and `configuredMergeStep`'s external
 * merge command, which is never inspected at all. Each can hand publication a
 * tree that predates work already sitting on the base branch, and a tree is the
 * one thing a containment check cannot see: ancestry says the candidate holds
 * every submitted head and the base, `merge-tree` says mergeable, the push
 * succeeds, and the merge is gone.
 *
 * So ask the question once more, where nothing can route around it: of every
 * path this candidate removes from the base branch, is each one a path some
 * submitted branch actually authors removing? Whatever is left over was composed
 * away, not decided away.
 *
 * Every such path is named IN FULL, unlike its composition-time sibling: whoever
 * reads this refusal is reconstructing what a merge would have erased, and a
 * truncated list is a search they have to redo by hand. */
async function mergeDeletionFloor(
  git: Git,
  repo: string,
  input: StepExecution,
  baseSha: string,
  checked: PinnedCandidate,
): Promise<CandidateFailure | undefined> {
  const removed = await deletedPaths(git, repo, baseSha, checked.candidateSha)
  if (removed.length === 0) return undefined
  const authored = new Set<string>()
  for (const pr of input.prs) {
    const base = await authoredDeltaBase(git, repo, baseSha, pr.headSha)
    if (base.status === "unreadable") {
      return candidateFailure(
        "carrier-inspection",
        `could not measure the deletions change '${pr.id}' branch '${pr.headSha}' authors against ` +
          `'${baseSha}': ${base.detail}; a Candidate whose history cannot be read cannot be cleared to merge`,
      )
    }
    for (const path of await deletedPaths(git, repo, base.sha, pr.headSha)) authored.add(path)
  }
  const unauthored = removed.filter((path) => !authored.has(path))
  if (unauthored.length === 0) return undefined
  const branch = primaryPR(input).base
  const submitted = input.prs.map((pr) => `'${pr.id}' branch '${pr.headSha}'`).join(", ")
  return candidateFailure(
    "merge-unauthored-deletion",
    `merge Candidate '${checked.candidateSha}' on '${branch}' at '${baseSha}' would delete ${unauthored.length} ` +
      `path(s) that no submitted branch authors deleting: [${unauthored.join(", ")}]\n` +
      `compared every path the Candidate removes from '${baseSha}' against the deletions authored by ${submitted}\n` +
      `cause: the Candidate's tree predates work already on '${branch}', so these removals are an artifact of how ` +
      `this Candidate was composed, not a change any author made\n` +
      `remedy: recompose the Candidate against '${baseSha}'; the submitted branches are unaffected and need no rework`,
    ".",
    unauthored,
  )
}

type ChangedGitlinkPin = Readonly<{ path: string; basePin: string; candidatePin: string }>

/** Every submodule gitlink the candidate MOVES relative to the base: the
 * `--raw -z` record stream filtered to 160000→160000 modifications. Added and
 * deleted gitlinks stay with the authored-gitlink machinery, which already
 * refuses them; the floor below rules only on pins that move. */
async function changedGitlinkPins(
  git: Git,
  repo: string,
  baseSha: string,
  candidateSha: string,
): Promise<ChangedGitlinkPin[]> {
  const raw = (
    await git.run(repo, [
      "diff",
      ...CERTIFICATE_DIFF_OPTIONS,
      "--raw",
      "--no-abbrev",
      "-z",
      baseSha,
      candidateSha,
      "--",
    ])
  ).stdout
  const records = raw.split("\0").filter((entry) => entry !== "")
  const changed: ChangedGitlinkPin[] = []
  for (let at = 0; at + 1 < records.length; at += 2) {
    const meta = records[at]
    const path = records[at + 1]
    if (meta === undefined || path === undefined || !meta.startsWith(":")) continue
    const [oldMode, newMode, oldSha, newSha, status] = meta.slice(1).split(" ")
    if (oldMode !== "160000" || newMode !== "160000" || status !== "M") continue
    if (oldSha === undefined || newSha === undefined || oldSha === newSha) continue
    changed.push({ path, basePin: oldSha, candidatePin: newSha })
  }
  return changed
}

type GitlinkRelation =
  | Readonly<{ kind: "forward" | "backward" | "diverged" }>
  | Readonly<{ kind: "unreadable"; detail: string }>

/** Ancestry between two pins, answered inside the submodule's own repository,
 * with ONE origin fetch retry when the objects are not local yet. */
async function gitlinkRelation(git: Git, submoduleRepo: string, pin: ChangedGitlinkPin): Promise<GitlinkRelation> {
  let detail = "git merge-base failed"
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const forward = await git.run(submoduleRepo, ["merge-base", "--is-ancestor", pin.basePin, pin.candidatePin], true)
    if (forward.code === 0) return { kind: "forward" }
    if (forward.code === 1) {
      const backward = await git.run(
        submoduleRepo,
        ["merge-base", "--is-ancestor", pin.candidatePin, pin.basePin],
        true,
      )
      if (backward.code === 0) return { kind: "backward" }
      if (backward.code === 1) return { kind: "diverged" }
      detail = backward.stderr.trim() || backward.stdout.trim() || detail
    } else {
      detail = forward.stderr.trim() || forward.stdout.trim() || detail
    }
    if (attempt === 0) await git.run(submoduleRepo, ["fetch", "--no-recurse-submodules", "--quiet", "origin"], true)
  }
  return { kind: "unreadable", detail }
}

/** The gitlink sibling of `mergeDeletionFloor`, from the same four-routes
 * family: of every submodule pin this candidate MOVES relative to the base
 * branch, is each new value a descendant of the value already on the base?
 *
 * Admission validated the pins against ITS base; the base has since moved, and
 * a candidate reused from that earlier step carries pins from before the
 * advance — which the promotion planner marks "verified" precisely because an
 * old pin IS on the component's history. Merging one silently reverts landed
 * submodule commits, rendered by plain git as the smallest possible diff
 * (PR2751.5, 2026-08-30). Ruling, verbatim, from
 * @i/10-yrd/superseded-carrier-with-pin-is-a-queued-revert: "admission checks
 * validate against the base at admission time; the merge run must
 * independently refuse any submodule gitlink that is not a descendant of the
 * same gitlink at the CURRENT base." */
async function mergeGitlinkFloor(
  git: Git,
  repo: string,
  input: StepExecution,
  baseSha: string,
  checked: PinnedCandidate,
): Promise<CandidateFailure | undefined> {
  const changed = await changedGitlinkPins(git, repo, baseSha, checked.candidateSha)
  if (changed.length === 0) return undefined
  const regressions: string[] = []
  const paths: string[] = []
  for (const pin of changed) {
    const submoduleRepo = join(repo, pin.path)
    // Prove the path before spawning git in it: an absent working directory
    // fails inside posix_spawn, which no allowFailure can contain.
    try {
      await realpath(submoduleRepo)
    } catch {
      return candidateFailure(
        "carrier-inspection",
        `submodule '${pin.path}' is not initialized at '${submoduleRepo}', so the merge cannot prove the pin ` +
          `direction between base '${pin.basePin}' and candidate '${pin.candidatePin}'; a Candidate whose pin ` +
          "direction cannot be read cannot be cleared to merge — initialize the submodule, then retry",
      )
    }
    const relation = await gitlinkRelation(git, submoduleRepo, pin)
    if (relation.kind === "unreadable") {
      return candidateFailure(
        "carrier-inspection",
        `could not prove the pin direction for submodule '${pin.path}' between base '${pin.basePin}' and ` +
          `candidate '${pin.candidatePin}': ${relation.detail}; fetch the submodule's history, then retry`,
      )
    }
    if (relation.kind === "forward") continue
    paths.push(pin.path)
    regressions.push(
      relation.kind === "backward"
        ? `'${pin.path}': BACKWARD from base '${pin.basePin}' to candidate '${pin.candidatePin}' — the candidate ` +
            "pin is an ancestor of the base pin, so merging reverts landed submodule commits"
        : `'${pin.path}': DIVERGED — base '${pin.basePin}' and candidate '${pin.candidatePin}' contain neither ` +
            "each other; compose the divergent submodule histories before retrying",
    )
  }
  if (regressions.length === 0) return undefined
  const branch = primaryPR(input).base
  return candidateFailure(
    "merge-gitlink-regression",
    `merge Candidate '${checked.candidateSha}' on '${branch}' at '${baseSha}' would move ${String(regressions.length)} ` +
      `submodule pin(s) against history:\n${regressions.join("\n")}\n` +
      `compared every submodule gitlink the Candidate changes against the same gitlink at '${baseSha}'; admission ` +
      "validated at its own base, and this floor revalidates at the merge's base\n" +
      "cause: the Candidate predates submodule work already on the base — an artifact of how this Candidate was " +
      "composed or reused, not a change any author made\n" +
      `remedy: recompose the Candidate against '${baseSha}' (a fresh composition writes the submodule's current ` +
      "main); the submitted branches are unaffected and need no rework",
    ".",
    paths,
  )
}

async function alreadyMergedEvidence(
  git: Git,
  repo: string,
  baseSha: string,
  checked: PinnedCandidate,
): Promise<AlreadyMergedEvidence | undefined> {
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
      message: "merge execution authority was canceled or superseded before merging",
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
    // Every sibling that spawns git in a `join(repo, <gitlink>)` path proves the
    // path first: an absent working directory fails inside posix_spawn, which no
    // allowFailure can contain, and a source store that is not materialized can
    // hold no candidate ref either way. This runs on the merge path, so the
    // answer must be this function's own per-candidate error string.
    try {
      await realpath(sourceRepo)
    } catch {
      return (
        `source '${source.repo}' is not initialized at '${sourceRepo}'; ` +
        `its candidate ref '${source.candidateRef}' cannot be proven`
      )
    }
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

async function mergeError(
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
    throw new Error(`yrd: could not verify merge '${landingSha}' contains '${sha}': ${fetchDetail(ancestry)}`)
  }
  return undefined
}

async function rollbackQueueBase(
  git: Git,
  repo: string,
  base: GitQueueTarget,
  merge: GitQueueTarget,
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
            expectedDestination: { state: "oid", oid: merge.sha },
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
      if ((await git.commit(checkedOut, "HEAD")) !== merge.sha) return `'${base.branch}' moved during rollback`
      const rolledBack = await git.run(checkedOut, ["reset", "--merge", base.sha], true)
      const restored = await materializeSubmodules(git, { worktree: checkedOut, referenceWorktree: repo })
      if (rolledBack.code !== 0 || restored.code !== 0) {
        const detail = [rolledBack.stderr, restored.stderr].filter((value) => value !== "").join("\n")
        return detail || `could not restore '${base.branch}' after source ref loss`
      }
    } else {
      const rolledBack = await git.run(repo, ["update-ref", base.branchRef, base.sha, merge.sha], true)
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

/** The one preamble `gitMergeStep` and `configuredMergeStep` both run before
 * they diverge into a native merge or an external merge command: resolve the
 * Candidate, and take the already-merged fast path if the base already
 * contains it. `artifactRoot` is the only input difference between the two
 * callers (`GitMergeOptions` has none; `ConfiguredMergeOptions` does). */
async function mergeStepPreamble(
  git: Git,
  repo: string,
  input: StepExecution,
  context: JobContext,
  options: Readonly<{
    artifactRoot?: string
    refuse?: RefusePathsPolicy
    checkpointIdentity?: string | (() => string)
    provisionPinIntent?: PinIntentProvisioner
  }>,
): Promise<
  | Readonly<{ done: true; result: JobResult<IntegrationProof> }>
  | Readonly<{ done: false; branch: string; base: GitQueueTarget; checked: PinnedCandidate }>
> {
  const branch = primaryPR(input).base
  const candidate = await mergeCandidate(git, repo, input, context, {
    artifactRoot: options.artifactRoot,
    ...(options.refuse === undefined ? {} : { refuse: options.refuse }),
    ...(options.checkpointIdentity === undefined ? {} : { checkpointIdentity: options.checkpointIdentity }),
    ...(options.provisionPinIntent === undefined ? {} : { provisionPinIntent: options.provisionPinIntent }),
  })
  if (candidate.status !== "completed" || candidate.conclusion !== "success") return { done: true, result: candidate }
  const { base, checked } = candidate
  const baseSha = base.sha
  const alreadyMerged = await alreadyMergedEvidence(git, repo, baseSha, checked)
  if (alreadyMerged === undefined) return { done: false, branch, base, checked }
  const cancellation = mergeAuthorityCancellation(context)
  if (cancellation !== undefined) return { done: true, result: cancellation }
  const recovering = (await mergeAttemptRefs(git, repo, input, checked)).length > 0
  const result = await withSubmoduleMainPromotions(
    git,
    repo,
    undefined,
    baseSha,
    async (promotions, results) => {
      const settlement = await applySubmoduleMainPromotions(git, promotions, results)
      if (settlement.status === "failed") return submoduleMainFailureResult(settlement.error)
      return {
        status: "completed",
        conclusion: "success",
        output: recovering
          ? await physicalIntegrationProof(git, repo, input, context, baseSha, checked, settlement.results)
          : integrationProof(baseSha, checked, alreadyMerged, settlement.results),
      }
    },
    { settleSafePromotions: true },
  )
  return { done: true, result }
}

export function gitMergeStep<Shape extends ChangeShape>(options: GitMergeOptions): StepRunner<Shape, IntegrationProof> {
  const repo = resolve(options.repo)
  const git = createGit(options.inject.process, options.env)
  return async (input, context): Promise<JobResult<IntegrationProof>> => {
    try {
      const preamble = await mergeStepPreamble(git, repo, input, context, {
        ...(options.refuse === undefined ? {} : { refuse: options.refuse }),
        ...(options.checkpointIdentity === undefined ? {} : { checkpointIdentity: options.checkpointIdentity }),
        ...(options.provisionPinIntent === undefined ? {} : { provisionPinIntent: options.provisionPinIntent }),
      })
      if (preamble.done) return preamble.result
      const { branch, base, checked } = preamble
      const baseSha = base.sha
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
            await recordMergeAttempt(git, repo, input, context, checked)
            return withSubmoduleMainPromotions(git, repo, checked.baseSha, checked.candidateSha, async () => {
              // Submodule mains are promoted explicitly around this root push.
              // A caller's recursive-push config would replay the root-only SHA refspec inside each submodule.
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
              // The root is on the remote from here. Record that BEFORE the
              // promotions below are attempted: a promotion failure must cost
              // the convergence work, never the fact of the merge.
              await recordRootMerged(git, repo, input, checked)
              // The changed-pin plan above preserves the pre-merge trust
              // boundary for new or changed submodule origins. Once root is
              // authoritative, audit every pin so this merge also converges
              // gaps left by an earlier actuator.
              return withSubmoduleMainPromotions(
                git,
                repo,
                undefined,
                checked.candidateSha,
                async (promotions, results) => {
                  const settlement = await applySubmoduleMainPromotions(git, promotions, results)
                  if (settlement.status === "failed") return submoduleMainFailureResult(settlement.error)
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
                      settlement.results,
                    ),
                  }
                },
                { settleSafePromotions: true },
              )
            })
          },
        )
        const merge = await authoritativeQueueBase(git, repo, branch)
        const missing = await mergeError(git, repo, input, checked, merge.sha)
        if (missing === undefined) {
          const sourceRefError = await sourceCandidateRefError(git, repo, checked.sourceRewrites ?? [])
          if (sourceRefError !== undefined) {
            const rollbackError = await rollbackQueueBase(git, repo, base, merge)
            if (rollbackError !== undefined) return failed("merge-rollback-failed", rollbackError)
            return failed("invalid-candidate", sourceRefError)
          }
          if (
            attempted.status === "completed" &&
            attempted.conclusion === "failure" &&
            submoduleMainEvidence(attempted) !== undefined
          ) {
            return attempted
          }
          if (
            attempted.status === "completed" &&
            attempted.conclusion === "failure" &&
            nativeRootPushFailureEvidence(attempted)
          ) {
            const reconciled = await withSubmoduleMainPromotions(
              git,
              repo,
              undefined,
              merge.sha,
              async (promotions, results) => {
                const settlement = await applySubmoduleMainPromotions(git, promotions, results)
                return settlement.status === "passed"
                  ? {
                      status: "completed" as const,
                      conclusion: "success" as const,
                      output: await physicalIntegrationProof(
                        git,
                        repo,
                        input,
                        context,
                        merge.sha,
                        checked,
                        settlement.results,
                      ),
                    }
                  : submoduleMainFailureResult(settlement.error)
              },
              { settleSafePromotions: true },
            )
            return reconciled
          }
          if (attempted.status === "completed" && attempted.conclusion === "success") return attempted
          return attempted
        }
        if (merge.sha !== baseSha) {
          return failed(
            "stale-base",
            `queue '${branch}' moved from '${baseSha}' to '${merge.sha}' before the candidate could merge`,
          )
        }
        if (attempted.status === "completed" && attempted.conclusion === "failure") return attempted
        if (attempted.status === "waiting") throw new Error("native merge cannot wait")
        return failed("merge-verification-failed", `merged '${branch}' does not contain '${missing}'`)
      }
      return await withSubmoduleMainPromotions(git, repo, checked.baseSha, checked.candidateSha, async () => {
        const checkedOut = await checkedOutWorktree(git, repo, base.branchRef)
        if (checkedOut !== undefined) {
          const status = await git.run(checkedOut, ["status", "--porcelain"])
          if (status.stdout !== "") return failed("dirty-base", status.stdout)
          if ((await git.commit(checkedOut, "HEAD")) !== baseSha) return failed("stale-base", `${branch} moved`)
          const cancellation = mergeAuthorityCancellation(context)
          if (cancellation !== undefined) return cancellation
          await recordMergeAttempt(git, repo, input, context, checked)
          const moved = await git.run(checkedOut, ["merge", "--ff-only", checked.candidateSha], true)
          if (moved.code !== 0) {
            await clearMergeAttempts(git, repo, input, checked)
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
            await clearMergeAttempts(git, repo, input, checked)
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
            await clearMergeAttempts(git, repo, input, checked)
            return failed("invalid-candidate", sourceRefError)
          }
        } else {
          const cancellation = mergeAuthorityCancellation(context)
          if (cancellation !== undefined) return cancellation
          await recordMergeAttempt(git, repo, input, context, checked)
          const expected = base.local ? baseSha : "0".repeat(baseSha.length)
          const moved = await git.run(repo, ["update-ref", base.branchRef, checked.candidateSha, expected], true)
          if (moved.code !== 0) {
            await clearMergeAttempts(git, repo, input, checked)
            return failed("stale-base", moved.stderr || "base branch moved")
          }
        }
        // Both local paths converge here with the branch already moved — the
        // checked-out `merge --ff-only` and the bare `update-ref` alike. Same
        // rule as the remote path: the record goes in ahead of the promotions.
        await recordRootMerged(git, repo, input, checked)
        return withSubmoduleMainPromotions(
          git,
          repo,
          undefined,
          checked.candidateSha,
          async (promotions, results) => {
            const settlement = await applySubmoduleMainPromotions(git, promotions, results)
            if (settlement.status === "failed") return submoduleMainFailureResult(settlement.error)
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
                settlement.results,
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

export function configuredMergeStep<Shape extends ChangeShape>(
  options: ConfiguredMergeOptions,
): StepRunner<Shape, IntegrationProof> {
  const repo = resolve(options.repo)
  const git = createGit(options.inject.process, options.env)
  const merge = async (input: StepExecution<Shape>, context: JobContext): Promise<JobResult<IntegrationProof>> => {
    try {
      const preamble = await mergeStepPreamble(git, repo, input, context, {
        artifactRoot: options.artifactRoot,
        ...(options.refuse === undefined ? {} : { refuse: options.refuse }),
        ...(options.checkpointIdentity === undefined ? {} : { checkpointIdentity: options.checkpointIdentity }),
        ...(options.provisionPinIntent === undefined ? {} : { provisionPinIntent: options.provisionPinIntent }),
      })
      if (preamble.done) return preamble.result
      const { branch, base, checked } = preamble
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
          YRD_CANDIDATE_SHA: checked.candidateSha,
          YRD_CANDIDATE_REF: checked.candidateRef,
          ...(options.environment === undefined ? {} : { YRD_ENVIRONMENT: options.environment }),
        }),
      })

      return await withSubmoduleMainPromotions(git, repo, checked.baseSha, checked.candidateSha, async () => {
        const cancellation = mergeAuthorityCancellation(context)
        if (cancellation !== undefined) return cancellation
        await recordMergeAttempt(git, repo, input, context, checked)
        const outcome = await command(input, context)
        let merge: GitQueueTarget
        try {
          merge = await authoritativeQueueBase(git, repo, branch)
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
        const missing = await mergeError(git, repo, input, checked, merge.sha)
        if (missing === undefined) {
          const sourceRefError = await sourceCandidateRefError(git, repo, checked.sourceRewrites ?? [])
          if (sourceRefError !== undefined) {
            const rollbackError = await rollbackQueueBase(git, repo, base, merge)
            if (rollbackError !== undefined) return failed("merge-rollback-failed", rollbackError)
            await clearMergeAttempts(git, repo, input, checked)
            return failed("invalid-candidate", sourceRefError)
          }
          return withSubmoduleMainPromotions(
            git,
            repo,
            undefined,
            merge.sha,
            async (promotions, results) => {
              const settlement = await applySubmoduleMainPromotions(git, promotions, results)
              if (settlement.status === "failed") return submoduleMainFailureResult(settlement.error)
              return {
                status: "completed",
                conclusion: "success",
                output: await physicalIntegrationProof(
                  git,
                  repo,
                  input,
                  context,
                  merge.sha,
                  checked,
                  settlement.results,
                ),
              }
            },
            { settleSafePromotions: true },
          )
        }
        await clearMergeAttempts(git, repo, input, checked)
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
      })
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

function primaryPR(input: StepExecution): StepExecution["prs"][number] {
  const primary = input.prs[0]
  if (primary === undefined) throw new Error(`yrd: queue run '${input.run}' has no PR`)
  return primary
}

function repositoryResultFailure(
  code: "repository-corrupt" | "repository-incomplete" | "unknown",
  message: string,
): never {
  throw createFailure({ kind: "infrastructure", code, message })
}

const MERGE_ATTEMPT_REF_ROOT = "refs/yrd/landing-attempts"

/**
 * Where "a run moved the base branch to this candidate" is kept. NOT a claim
 * that the change is integrated.
 *
 * These were one field until now, and the conflation is why the fact was
 * droppable: a merge that pushed the root and then failed submodule promotion
 * returned `submoduleMainFailureResult` and produced no `IntegrationProof`, so
 * the queue durably forgot a merge it had performed. Everything downstream then
 * re-derived "is this already in" from the collapsed candidate, where
 * `is-ancestor X X`, `candidateSha === baseSha` and `tree(X) === tree(X)` all
 * answer yes for free.
 *
 * Kept deliberately non-interchangeable with an `IntegrationProof`, and here
 * that is structural rather than nominal: this lives in its own ref namespace
 * and stores exactly one sha under a change-and-run key, so there is no shared
 * record for the two facts to collapse back into. Integrated-ness stays DERIVED
 * from this plus a settled promotion; it is not stored, so there is no field to
 * reach through.
 *
 * The ref name carries the change and the run; the ref value carries the
 * candidate, which is the ONLY sha this fact holds. Inventing a `baseSha` by
 * reading the candidate's first parent would be a fourth derived value dressed
 * as a recorded one — a fast-forward's first parent is not the base it
 * replaced. Whoever needs the prior base asks git, and gets an answer that can
 * fail.
 *
 * Keyed by CHANGE, not by run, and that is the whole point. `mergeAttemptRefs`
 * is keyed by `input.run`, so a retry — which is always a NEW run — can see
 * nothing its predecessor wrote, and a merge that pushed the root and then
 * failed promotion left no trace any later run could read. A change-keyed ref
 * is legible to every subsequent run of the same change, which is what makes
 * "did a previous run merge this?" answerable at all.
 *
 * Never cleared: a merge that happened stays happened. The attempt refs beside
 * it are the retractable ones.
 */
const ROOT_MERGE_REF_ROOT = "refs/yrd/root-merged"

function rootMergeRef(changeId: string, run: string): string {
  const safeChange = changeId.replace(/[^a-zA-Z0-9._-]/gu, "-")
  const safeRun = run.replace(/[^a-zA-Z0-9._-]/gu, "-")
  return `${ROOT_MERGE_REF_ROOT}/${safeChange}/${safeRun}`
}

/**
 * Record that the base branch now points at this candidate — called the instant
 * the root lands and BEFORE promotion is attempted.
 *
 * The ordering is the fix, not a detail. Writing it after promotion is what
 * made it droppable: the proof was produced on the success path only, so a
 * promotion failure discarded a merge that had already happened. Written ahead
 * of the attempt, "we merged the root and kept no record of it" stops being a
 * reachable state instead of being a state we clean up after.
 *
 * Best-effort by construction: this must never turn a landed merge into a
 * failed step, because the merge is already done by the time it runs and the
 * step's verdict belongs to the merge, not to its bookkeeping. A ref that
 * cannot be written is a lost record, and losing it leaves exactly the state
 * that exists today.
 */
async function recordRootMerged(git: Git, repo: string, input: StepExecution, checked: PinnedCandidate): Promise<void> {
  for (const change of checked.changes ?? []) {
    const ref = rootMergeRef(change.changeId, input.run)
    // The zero old-value asserts CREATION, matching every sibling update-ref in
    // this file (:3106, :3667, :5728): a run merges a given change once, so a
    // ref that already exists is a fact worth failing loudly on rather than
    // overwriting. Writing without an expected old value is a blind clobber,
    // and it is the convention the surrounding code already keeps.
    const written = await git.run(
      repo,
      ["update-ref", "--create-reflog", ref, checked.candidateSha, "0".repeat(checked.candidateSha.length)],
      true,
    )
    if (written.code === 0) continue
    // Non-fatal, because the merge is already done and the step's verdict
    // belongs to the merge rather than to its bookkeeping. Never SILENT,
    // because a lost record is the exact state this fact exists to prevent —
    // and a dropped write that says nothing is how the queue came to forget
    // merges it had performed.
    console.warn(
      `yrd: root-merge fact NOT recorded for change ${change.changeId} at ${checked.candidateSha}: ` +
        `git update-ref ${ref} exited ${String(written.code)}` +
        `${written.stderr.trim() === "" ? "" : `: ${written.stderr.trim()}`}`,
    )
  }
}

function mergeAttemptRef(input: StepExecution, context: JobContext): string {
  const safeJob = context.id.replace(/[^a-zA-Z0-9._-]/gu, "-")
  return `${MERGE_ATTEMPT_REF_ROOT}/${input.run}/${safeJob}/attempt-${context.attempt}`
}

async function recordMergeAttempt(
  git: Git,
  repo: string,
  input: StepExecution,
  context: JobContext,
  checked: PinnedCandidate,
): Promise<void> {
  const ref = mergeAttemptRef(input, context)
  const zero = "0".repeat(checked.candidateSha.length)
  const recorded = await git.run(repo, ["update-ref", "--create-reflog", ref, checked.candidateSha, zero], true)
  if (recorded.code === 0 || (await git.optionalCommit(repo, ref)) === checked.candidateSha) return
  return repositoryResultFailure(
    "repository-corrupt",
    `yrd: merge attempt ref '${ref}' is already occupied by different evidence`,
  )
}

async function mergeAttemptRefs(
  git: Git,
  repo: string,
  input: StepExecution,
  checked: PinnedCandidate,
): Promise<readonly string[]> {
  const prefix = `${MERGE_ATTEMPT_REF_ROOT}/${input.run}/`
  const listed = await git.run(repo, ["for-each-ref", "--format=%(objectname) %(refname)", prefix], true)
  if (listed.code !== 0) {
    return repositoryResultFailure(
      "repository-incomplete",
      `yrd: Queue run '${input.run}' merge attempts are unreadable: ${listed.stderr || listed.stdout}`,
    )
  }
  return listed.stdout === ""
    ? []
    : listed.stdout.split("\n").flatMap((line) => {
        const [sha, ref, extra] = line.split(/\s+/u)
        if (sha === undefined || ref === undefined || extra !== undefined) {
          return repositoryResultFailure(
            "repository-corrupt",
            `yrd: Queue run '${input.run}' merge attempt is malformed: ${line}`,
          )
        }
        if (sha !== checked.candidateSha) {
          return repositoryResultFailure(
            "repository-corrupt",
            `yrd: Queue run '${input.run}' merge attempt '${ref}' targets '${sha}', expected '${checked.candidateSha}'`,
          )
        }
        return [ref]
      })
}

async function clearMergeAttempts(
  git: Git,
  repo: string,
  input: StepExecution,
  checked: PinnedCandidate,
): Promise<void> {
  for (const ref of await mergeAttemptRefs(git, repo, input, checked)) {
    const deleted = await git.run(repo, ["update-ref", "-d", ref, checked.candidateSha], true)
    if (deleted.code !== 0) {
      return repositoryResultFailure(
        "repository-corrupt",
        `yrd: confirmed result could not retire merge attempt '${ref}'`,
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
  submoduleMains: readonly SubmoduleMainResult[] = [],
): Promise<IntegrationProof> {
  await clearMergeAttempts(git, repo, input, checked)
  return integrationProof(commit, checked, undefined, submoduleMains)
}

function integrationProof(
  commit: string,
  checked: PinnedCandidate,
  alreadyMerged?: AlreadyMergedEvidence,
  submoduleMains: readonly SubmoduleMainResult[] = [],
): IntegrationProof {
  return IntegrationProofSchema.parse({
    commit,
    baseSha: commit,
    ...(alreadyMerged === undefined ? {} : { alreadyLanded: alreadyMerged }),
    ...(checked.sourceRewrites === undefined ? {} : { sourceRewrites: checked.sourceRewrites }),
    ...(checked.submoduleResolutions === undefined ? {} : { submoduleResolutions: checked.submoduleResolutions }),
    ...(submoduleMains.length === 0 ? {} : { componentMains: submoduleMains }),
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
