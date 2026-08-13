import { createHash, randomUUID } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { hostname } from "node:os"
import { join, relative, resolve, sep } from "node:path"
import { clearLine, cursorTo } from "node:readline"
import { createScope, type Scope } from "@silvery/scope"
import { createGitWorktreeStore } from "git-super/worktree"
import {
  createBayJobDefs,
  createDeploymentJobDefs,
  createGitDeploymentStore,
  createGitPushReceiver,
  createGitWorkspace,
  baseIdentity,
  defaultBayBranch,
  loadGitPushReceiver,
  runReceiverHookFromEnvironment,
  withBays,
  withDeployments,
  type BayWorkspace,
  type GitDeploymentStore,
  type GitPushReceiver,
  type GitWorkspaceLifecycleHooks,
  type RemoteBranchSnapshot,
  type ReceiverReceipt,
  type ReceiverRefUpdate,
  type ReceiverSubmitIntent,
  type ReceiverTarget,
} from "@yrd/bay"
import {
  createHeldOutCommandEvaluator,
  withContests,
  type ContestEvaluatorDef,
  type ContestGit,
  type ContestRunnerDef,
} from "@yrd/contest"
import {
  createFailure,
  createYrd,
  createYrdDef,
  failureFact,
  pipe,
  raiseFailure,
  SUPPORTED_VERSIONS,
  stageReport,
  type Journal,
  type JournalCompatibility,
} from "@yrd/core"
import { defineConfig, selectFlow } from "@yrd/config"
import { localRunner, withJobs } from "@yrd/job"
import {
  configuredCommandStep,
  configuredMergeStep,
  configuredWaitingCommandStep,
  createCandidatePool,
  createCandidatePoolGit,
  createGitPRRecutter,
  gitCandidatePreparer,
  gitCheckStep,
  gitMergeStep,
  gitMergeRecorder,
  findRepositoryMergeRecords,
  inspectGitQueueTarget,
  resolveGitQueueTarget,
  worktreeContexts,
  withQueue,
  withMerge,
  withStep,
  type CandidatePool,
  type CommandEvidence,
  type InstalledStep,
  type IntegratedShape,
  type PRShape,
  type QueueAuditResult,
  type StepDef,
  type StepExecution,
  type StepRunner,
} from "@yrd/queue"
import {
  installedBaselineDrift,
  readInstalledBaselines,
  removeInstalledBaseline,
  runtimeBaselineDrift,
  writeInstalledBaseline,
} from "./installed-baseline.ts"
import {
  createExclusive,
  createJournal,
  createReadOnlyJournal,
  importOrphanJournal,
  type MutableJournal,
} from "@yrd/persistence"
import { createProcess, shellCommand, type Process, type ProcessResult } from "@yrd/process"
import { withIntents } from "@yrd/intent"
import { admitPinIntent } from "./intent-admission.ts"
import { createKmIssueSource, withIssues, type IssueSource } from "@yrd/issue"
import type { ConditionalLogger } from "loggily"
import { run } from "silvery/runtime"
import { cleanGitEnvironment } from "./git-environment.ts"
import { CHECKOUT_TIMEOUT_ENV, resolveCheckoutTimeoutMs } from "./git-timeouts.ts"
import { observeFreshRemoteBranch, observeOriginBranchAdvertisement, observeOriginRemote } from "./remote-branch.ts"
import {
  implementationSourceIdentity,
  sourceRepositoryFor,
  takeImplementationSourceAttestation,
} from "./implementation-source.ts"
import { ensureWorkspaceDependencies } from "./workspace-provisioning.ts"
import { withGitIndexLockRetry } from "./git-index-lock-retry.ts"
import { loadYrdConfig, stepGateMode, type ResolvedYrdProjectConfig, type YrdStepConfig } from "./config.ts"
import { classifyFailure, resolveInvocation, type RuntimePosture } from "./invocation.ts"
import { withLiveRenderer } from "./live-renderer.ts"
import { createYrdLogger, residentObservability, resolveYrdObservability } from "./observability.ts"
import { formatResidentLogLine, residentArtifactHome } from "./runner-timeline.ts"
import { diagnostic } from "./output.tsx"
import { createPrPublicationService } from "./pr-publication.ts"
import { discoverYrdRepository, type YrdRepository } from "./repository.ts"
import {
  isYrdRuntimeReloadRequest,
  residentRunnerLeaseHeld,
  runYrdHelp,
  runYrdProcessRuntime,
  yrdJsonOutputRequested,
  yrdQueueRunnerCheckRequested,
} from "./run.ts"
import { queueStepRevision, type ToolchainFingerprint } from "./host-revision.ts"
import { retainedWorkspaceNote, type RetainedWorkspace } from "./workspace-retention.ts"
import type {
  YrdCliApp,
  YrdCliCheckResult,
  YrdCliChecks,
  YrdCliExitCode,
  YrdCliIO,
  YrdCliQueueAdministration,
  YrdCliServices,
} from "./types.ts"
import { createQueueReadModel } from "./queue-read-model.ts"
import { queueReadBases } from "./queue-read-boundary.ts"
import { LandingAuthorityBoundary } from "./landing-authority-boundary.ts"
import { execYrdProcessInPlace } from "./runtime-reload.ts"

type QueueTargetResolver = NonNullable<YrdCliIO["resolveQueueTarget"]>

/** Viewer projections are immutable for one invocation, so they may share one
 * queue-target read. Active postures observe a changing queue and must resolve
 * the target on every cycle; caching it for a resident turns every later base
 * advance into an endless same-base recut loop. */
export function createPostureQueueTargetResolver(
  posture: RuntimePosture,
  resolveTarget: QueueTargetResolver,
): QueueTargetResolver {
  if (posture !== "viewer") return resolveTarget
  const targets = new Map<string, Promise<Readonly<{ base: string; sha: string }>>>()
  return (ref, cwd) => {
    const key = `${cwd}\0${ref}`
    const cached = targets.get(key)
    if (cached !== undefined) return cached
    const recoverable = resolveTarget(ref, cwd).catch((error: unknown) => {
      targets.delete(key)
      throw error
    })
    targets.set(key, recoverable)
    return recoverable
  }
}

type RuntimeStep = StepDef<PRShape, PRShape>

const RawGitPushPattern = /(?:^|[\n;&|])\s*git\s+push(?:\s|$)/u

export const CURRENT_JOURNAL_COMPATIBILITY = Object.freeze({
  version: SUPPORTED_VERSIONS.at(-1) ?? 0,
}) satisfies JournalCompatibility

export type DefaultYrdAppOptions = Readonly<{
  repo: string
  stateDir: string
  baysRoot: string
  journal: Journal<unknown>
  process: Pick<Process, "run">
  config: ResolvedYrdProjectConfig
  receiverPath?: string
  workspace?: BayWorkspace
  workspaceLifecycle?: GitWorkspaceLifecycleHooks
  issueSources?: readonly IssueSource[]
  contestRunners?: readonly ContestRunnerDef[]
  contestEvaluators?: readonly ContestEvaluatorDef[]
  contestGit?: ContestGit
  defaultSubmitter?: string
  scope?: Scope
  log?: ConditionalLogger
  /** Opt-in warm candidate-worktree pool shared across check steps (R40). */
  candidatePool?: CandidatePool
  /** Runtime Runner identity recorded on fresh Jobs. */
  runnerId?: string
}>

type DefaultYrdRuntimeAppOptions = DefaultYrdAppOptions &
  Readonly<{
    /** Git identity of the native implementation actually loaded by this host. */
    implementationSource?: string
  }>

function validateConfig(config: ResolvedYrdProjectConfig): void {
  for (const name of config.steps) {
    if (name !== "merge" && config.definitions[name]?.run === undefined) {
      raiseFailure(
        "configuration",
        "step-command-missing",
        `yrd: required check '${name}' requires an inline run definition`,
      )
    }
  }
  if (config.definitions.merge?.runner === "waiting") {
    raiseFailure("configuration", "merge-runner-invalid", "yrd: merge cannot use a waiting runner")
  }
  const mergeIndex = config.steps.indexOf("merge")
  if (mergeIndex >= 0 && config.definitions.merge?.run === undefined) {
    for (const name of config.steps.slice(mergeIndex + 1)) {
      if (RawGitPushPattern.test(config.definitions[name]?.run ?? "")) {
        raiseFailure(
          "configuration",
          "native-merge-post-push",
          `yrd: post-merge step '${name}' cannot push Git refs after the native merge step`,
        )
      }
    }
  }
  for (const evaluator of config.contest.evaluators) {
    if (config.definitions[evaluator]?.run === undefined) {
      raiseFailure(
        "configuration",
        "evaluator-command-missing",
        `yrd: contest evaluator '${evaluator}' requires a configured step command`,
      )
    }
  }
}

const MANAGED_PRE_SUBMIT_MARKER = "# managed-by-yrd: pre-submit-v1"

function annotateRetainedWorkspace(cause: unknown, workspace: RetainedWorkspace): Error {
  const note = retainedWorkspaceNote(workspace)
  const failure = failureFact(cause)
  if (failure !== undefined) {
    return createFailure({ ...failure, message: `${failure.message}; ${note}` }, cause)
  }
  if (cause instanceof Error) return new Error(`${cause.message}; ${note}`, { cause })
  return new Error(`${String(cause)}; ${note}`, { cause })
}

export function configuredChecks(
  process: Pick<Process, "run">,
  stateDir: string,
  config: ResolvedYrdProjectConfig,
  environment: NodeJS.ProcessEnv,
): YrdCliChecks {
  const names =
    config.checks ??
    config.steps.filter(
      (name) => (config.definitions[name]?.kind ?? (name === "merge" ? "merge" : "check")) === "check",
    )
  const hook = join(stateDir, "hooks", "pre-submit")
  const repo = resolve(stateDir, "../..")
  const runInCheckout = async (
    name: string,
    definition: YrdStepConfig,
    cwd: string,
    ref: string | undefined,
    keepOnFailure: boolean,
  ): Promise<YrdCliCheckResult> => {
    const baseSha = await resolveCommit(process, repo, config.base)
    if (baseSha === undefined) {
      raiseFailure(
        "configuration",
        "required-check-base-missing",
        `yrd: required-check base '${config.base}' is missing`,
      )
    }
    const candidateSha = await resolveCommit(process, ref === undefined ? cwd : repo, ref ?? "HEAD")
    if (candidateSha === undefined) {
      raiseFailure(
        "configuration",
        "required-check-candidate-missing",
        `yrd: required-check candidate '${ref ?? "HEAD"}' is missing`,
      )
    }
    const inherited = cleanGitEnvironment(environment)
    const declared = Object.fromEntries(
      (definition.environmentPassthrough ?? []).flatMap((name) =>
        environment[name] === undefined ? [] : [[name, environment[name]]],
      ),
    )
    const environmentFor = (candidate: string) => ({
      ...inherited,
      ...declared,
      ...definition.env,
      YRD_REPO: repo,
      YRD_BASE_SHA: baseSha,
      YRD_CANDIDATE_SHA: candidate,
      ...(definition.environment === undefined ? {} : { YRD_ENVIRONMENT: definition.environment }),
    })
    const run = (workingDirectory: string, candidate: string) =>
      process.run({
        argv: shellCommand(definition.run ?? ""),
        cwd: workingDirectory,
        env: environmentFor(candidate),
        timeoutMs: stepTimeoutMs(definition),
      })
    // A required check has to judge what the queue will judge: the candidate
    // composed onto current base, which is what gitCheckStep receives once
    // prepareCandidate has merged. Judging the raw branch tip instead refuses
    // ordinary staleness the queue absorbs — an ancestry-shaped check reads its
    // own base as unreachable, and a tree-reading check misses whatever main
    // fixed after the branch diverged.
    //
    // When base is already an ancestor the composition IS the candidate, so an
    // up-to-date branch keeps the old path and pays one ancestry probe. Only a
    // stale candidate composes. That diverts a stale in-place run into a
    // checkout, which stops the check from seeing uncommitted work — and
    // YRD_CANDIDATE_SHA has always named a commit, never the working tree, so
    // the composed checkout is the honest materialization of what was declared.
    const composes = !(await isAncestorCommit(process, repo, baseSha, candidateSha))
    if (ref === undefined && !composes) return run(cwd, candidateSha)

    const checkoutSha = composes ? baseSha : candidateSha
    const parent = join(stateDir, "pre-submit-worktrees")
    mkdirSync(parent, { recursive: true })
    const checkoutRoot = await mkdtemp(join(parent, "check-"))
    const checkout = join(checkoutRoot, "worktree")
    // Candidate materialization is trusted Yrd plumbing. Repository hooks run
    // in that process by default, so the shared worktree capability quarantines
    // hooks instead of exposing Yrd's ambient authority to hook code.
    const checkoutTimeoutMs = resolveCheckoutTimeoutMs(environment)
    let worktrees: Awaited<ReturnType<typeof createGitWorktreeStore>>
    try {
      worktrees = createGitWorktreeStore({
        repo,
        process,
        env: inherited,
        timeouts: { operation: checkoutTimeoutMs, cleanup: checkoutTimeoutMs },
      })
      await worktrees.add({
        kind: "detached",
        path: checkout,
        ref: checkoutSha,
        hooks: "quarantine",
        operation: `CLI pre-submit worktree add ${checkoutSha}`,
      })
    } catch (cause) {
      if (!keepOnFailure) await rm(checkoutRoot, { recursive: true, force: true })
      const message = cause instanceof Error ? cause.message : String(cause)
      const retained = keepOnFailure ? `; ${retainedWorkspaceNote({ path: checkoutRoot, cleanup: "directory" })}` : ""
      if (/timed out after/iu.test(message)) {
        raiseFailure(
          "infrastructure",
          "required-check-checkout-timeout",
          `yrd: pre-submit checkout of '${candidateSha}' exceeded ${checkoutTimeoutMs}ms during 'git worktree add'; raise ${CHECKOUT_TIMEOUT_ENV} or retry under lower load${retained}`,
        )
      }
      raiseFailure(
        "infrastructure",
        "required-check-checkout-failed",
        `${message || `yrd: could not materialize required-check candidate '${candidateSha}'`}${retained}`,
      )
    }
    let candidate = candidateSha
    if (composes) {
      const merged = await worktrees.git.run(
        checkout,
        ["merge", "--no-ff", "-m", `pre-submit: compose ${candidateSha} onto ${baseSha}`, candidateSha],
        true,
      )
      if (merged.code !== 0) {
        await worktrees.git.run(checkout, ["merge", "--abort"], true)
        const detail = merged.stderr.trim() || merged.stdout.trim() || `git merge exited ${String(merged.code)}`
        if (!keepOnFailure) {
          await worktrees.remove(checkout, {
            operation: `CLI pre-submit failed-composition cleanup ${candidateSha}`,
          })
          await rm(checkoutRoot, { recursive: true, force: true })
        }
        const retained = keepOnFailure ? `; ${retainedWorkspaceNote({ path: checkout, cleanup: "worktree" })}` : ""
        // Only a real conflict reaches here. Ordinary staleness composed above,
        // so this names the one thing the author still has to do by hand.
        raiseFailure(
          "refusal",
          "required-check-composition-conflict",
          `yrd: required-check candidate '${candidateSha}' conflicts with base '${baseSha}': ${detail}; ` +
            `merge '${config.base}' into the branch and resolve the conflict, then re-run${retained}`,
        )
      }
      const composed = await resolveCommit(process, checkout, "HEAD")
      if (composed === undefined) {
        raiseFailure(
          "infrastructure",
          "required-check-composition-missing",
          `yrd: composing required-check candidate '${candidateSha}' onto base '${baseSha}' left no commit in '${checkout}'`,
        )
      }
      candidate = composed
    }
    // The hook quarantine above also silences the repository hook that used to
    // populate submodules on checkout, so a submodule-backed workspace member
    // would be missing and provisioning would fail with 'workspace:* failed to
    // resolve'. Populate them here as trusted Yrd plumbing, under the same
    // quarantine so submodule checkouts cannot run hook code either (22755).
    try {
      await worktrees.materializeSubmodules(checkout, { hooks: "quarantine" })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (!keepOnFailure) {
        try {
          await worktrees.remove(checkout, {
            operation: `CLI pre-submit failed-materialization cleanup ${candidateSha}`,
          })
        } catch (cleanupCause) {
          throw new AggregateError(
            [cause, cleanupCause],
            `yrd: pre-submit submodule population failed and checkout cleanup also failed: ${message}`,
            { cause },
          )
        }
        await rm(checkoutRoot, { recursive: true, force: true })
      }
      const retained = keepOnFailure ? `; ${retainedWorkspaceNote({ path: checkout, cleanup: "worktree" })}` : ""
      if (/timed out after/iu.test(message)) {
        raiseFailure(
          "infrastructure",
          "required-check-checkout-timeout",
          `yrd: pre-submit submodule population of '${candidateSha}' exceeded ${checkoutTimeoutMs}ms during 'git submodule update'; raise ${CHECKOUT_TIMEOUT_ENV} or retry under lower load${retained}`,
        )
      }
      raiseFailure(
        "infrastructure",
        "required-check-submodule-populate-failed",
        `${message || `yrd: could not populate submodules for required-check candidate '${candidateSha}' in ${checkout}`}${retained}`,
      )
    }
    let failed = true
    try {
      await ensureWorkspaceDependencies(process, {
        path: checkout,
        subject: `required check '${name}' workspace`,
        manifestSubject: "candidate",
        env: environmentFor(candidate),
        fail(message) {
          raiseFailure("infrastructure", "candidate-provision-failed", `yrd: ${message}`)
        },
      })
      const result = await run(checkout, candidate)
      failed = result.exitCode !== 0 || result.timedOut
      if (!failed || !keepOnFailure) return result
      return { ...result, retainedWorkspace: { path: checkout, cleanup: "worktree" } }
    } catch (cause) {
      if (keepOnFailure) throw annotateRetainedWorkspace(cause, { path: checkout, cleanup: "worktree" })
      throw cause
    } finally {
      if (!keepOnFailure || !failed) {
        try {
          await worktrees.remove(checkout, { operation: `CLI pre-submit worktree remove ${candidateSha}` })
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          raiseFailure(
            "infrastructure",
            "required-check-checkout-cleanup-failed",
            /timed out after/iu.test(message)
              ? `yrd: required-check checkout removal of '${checkout}' exceeded ${checkoutTimeoutMs}ms; raise ${CHECKOUT_TIMEOUT_ENV} or retry under lower load`
              : message || `yrd: could not remove required-check checkout '${checkout}'`,
          )
        }
        await rm(checkoutRoot, { recursive: true, force: true })
      }
    }
  }
  return Object.freeze({
    names: Object.freeze([...names]),
    async run(name, cwd, context) {
      if (!names.includes(name)) {
        raiseFailure(
          "configuration",
          "required-check-unknown",
          `yrd: required check '${name}' is not configured (configured: ${names.join(", ") || "none"})`,
        )
      }
      const definition = config.definitions[name]
      if (definition?.run === undefined) {
        raiseFailure("configuration", "required-check-command-missing", `yrd: required check '${name}' has no command`)
      }
      return runInCheckout(name, definition, cwd, context?.ref, context?.keepOnFailure === true)
    },
    install(_cwd) {
      mkdirSync(join(stateDir, "hooks"), { recursive: true })
      let existing: string | undefined
      try {
        existing = readFileSync(hook, "utf8")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      if (existing !== undefined && !existing.includes(MANAGED_PRE_SUBMIT_MARKER)) {
        raiseFailure(
          "refusal",
          "pre-submit-hook-unmanaged",
          `yrd: will not replace the unmanaged pre-submit hook at '${hook}'`,
        )
      }
      const command = names.length === 0 ? "exit 0" : `exec yrd check ${names.join(" ")}`
      const source = `#!/bin/sh\n${MANAGED_PRE_SUBMIT_MARKER}\n${command}\n`
      if (existing !== source) writeFileSync(hook, source, { encoding: "utf8", mode: 0o755 })
      chmodSync(hook, 0o755)
      return Promise.resolve(hook)
    },
  })
}

function hostToolchainFingerprint(): ToolchainFingerprint {
  return {
    bun: Bun.version,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  }
}

function contestEvaluatorRevision(
  repo: string,
  stateDir: string,
  checkoutParent: string,
  name: string,
  config: YrdStepConfig,
  timeoutMs: number,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        implementation: "yrd-contest-command-v3",
        repo,
        stateDir,
        checkoutParent,
        name,
        run: config.run,
        runner: config.runner,
        environment: config.environment,
        timeoutMs,
      }),
    )
    .digest("hex")
}

function eraseStep<Input extends PRShape, Output extends PRShape>(step: StepDef<Input, Output>): RuntimeStep {
  return step as unknown as RuntimeStep
}

/**
 * The ONE default wall-clock bound for a queue step's local command (21012 S1).
 * Generous by design — a legitimate broad local gate takes minutes; only a
 * wedged process tree exceeds it. Declarative override: `timeoutMs` on the
 * step config. Applies to the local command execution of BOTH runners (a
 * waiting step's LAUNCHER is still a local command); the remote work behind a
 * waiting step is governed by the remote system's own timeout. Policy lives
 * HERE (host), mechanism lives in @yrd/process — never bound inside the lib.
 */
export const DEFAULT_STEP_TIMEOUT_MS = 15 * 60_000
const GIT_TIMEOUT_MS = 30_000

function assertGitDidNotTimeOut(result: Pick<ProcessResult, "timedOut">, args: readonly string[]): void {
  if (result.timedOut) throw new Error(`yrd: git ${args.join(" ")} timed out after ${GIT_TIMEOUT_MS}ms`)
}

/** Effective wall-clock bound for a step: declared, else the host default. */
export function stepTimeoutMs(config: YrdStepConfig): number {
  return config.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
}

/**
 * The default no-output-progress bound for a queue step's local command. A
 * step that emits its banner then goes SILENT — a wedged child that neither
 * progresses nor exits, the 2026-07-16 R423 failure — is caught here: sooner
 * and more specifically than the coarse wall-clock DEFAULT_STEP_TIMEOUT_MS,
 * and it fails LOUDLY as `<step>-stalled` with a STALLED verdict in the
 * evidence instead of leaving the queue awaiting a pipe only SIGKILL can free.
 * Kept strictly below the wall-clock bound so silence stalls before it times
 * out, yet generous enough that a legitimately slow-but-progressing gate
 * (which resets the lease on every byte) never trips it. Declarative override:
 * `noProgressMs` on the step config. Policy lives HERE (host); mechanism lives
 * in @yrd/process — never bound inside the lib.
 */
export const DEFAULT_STEP_NO_PROGRESS_MS = 10 * 60_000

/** Effective no-output-progress bound for a step: declared, else the host default. */
export function stepNoProgressMs(config: YrdStepConfig): number {
  return config.noProgressMs ?? DEFAULT_STEP_NO_PROGRESS_MS
}

function stepCommand(name: string, config: YrdStepConfig): string {
  if (config.run === undefined) throw new Error(`yrd: queue step '${name}' has no command`)
  return config.run
}

function candidateStep(
  process: Pick<Process, "run">,
  repo: string,
  stateDir: string,
  checkoutParent: string,
  name: string,
  config: YrdStepConfig,
  revision: string,
  candidatePool: CandidatePool | undefined,
  kind: "check" | "action",
): RuntimeStep {
  const command = shellCommand(stepCommand(name, config))
  const checkProcess: Pick<Process, "run"> = {
    async run(request) {
      if (
        request.argv.length === command.length &&
        request.argv.every((argument, index) => argument === command[index])
      ) {
        if (request.cwd === undefined) {
          raiseFailure(
            "infrastructure",
            "candidate-provision-failed",
            `yrd: required check '${name}' has no candidate working directory to provision`,
          )
        }
        await ensureWorkspaceDependencies(process, {
          path: request.cwd,
          subject: `required check '${name}' workspace`,
          manifestSubject: "candidate",
          ...(request.env === undefined ? {} : { env: request.env }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          fail(message) {
            raiseFailure("infrastructure", "candidate-provision-failed", `yrd: ${message}`)
          },
        })
      }
      return process.run(request)
    },
  }
  return eraseStep(
    withStep(
      name,
      gitCheckStep({
        inject: { process: checkProcess },
        repo,
        command,
        checkoutParent,
        artifactRoot: join(stateDir, "artifacts"),
        purpose: name,
        runner: config.runner,
        mode: stepGateMode(config),
        classification: config.classification ?? "carrier",
        ...(config.comparison === undefined ? {} : { comparison: config.comparison }),
        ...(config.comparisonReady === undefined ? {} : { comparisonReady: config.comparisonReady }),
        timeoutMs: stepTimeoutMs(config),
        noProgressTimeoutMs: stepNoProgressMs(config),
        ...(config.environment === undefined ? {} : { environment: config.environment }),
        ...(config.env === undefined ? {} : { environmentOverrides: config.env }),
        ...(config.environmentPassthrough === undefined
          ? {}
          : { environmentPassthrough: config.environmentPassthrough }),
        ...(candidatePool === undefined ? {} : { candidatePool }),
      }),
      {
        revision,
        kind,
        classification: config.classification ?? "carrier",
      },
    ),
  )
}

/**
 * Derive the installed-step descriptor — identity, integration contract, and
 * revision — for every configured step. This is the ONE home for the descriptor
 * recipe: {@link configuredQueueSteps} wires its runtime machinery around these
 * revisions, and the environment audit re-derives from a freshly loaded config
 * through this same function, so drift detection always proves the CURRENT
 * on-disk config rather than a startup snapshot.
 */
function configuredStepDescriptors(
  fixed: Readonly<{ repo: string; stateDir: string; baysRoot: string }>,
  config: ResolvedYrdProjectConfig,
  mergeCommand: readonly string[] | undefined,
): readonly InstalledStep[] {
  const toolchain = hostToolchainFingerprint()
  const mergeIndex = config.steps.indexOf("merge")
  return config.steps.map((name, index) => {
    const stepConfig = config.definitions[name] ?? { runner: "local" as const }
    const kind =
      stepConfig.kind ?? (name === "merge" ? "merge" : mergeIndex >= 0 && index > mergeIndex ? "action" : "check")
    const timeoutMs = stepTimeoutMs(stepConfig)
    const noProgressMs = stepNoProgressMs(stepConfig)
    if (kind === "merge") {
      return {
        name,
        title: "merge",
        revision: queueStepRevision({
          repo: fixed.repo,
          stateDir: fixed.stateDir,
          name,
          config: stepConfig,
          timeoutMs,
          noProgressMs,
          toolchain,
          resolvedCommand: mergeCommand,
        }),
        kind,
      }
    }
    if (kind === "check") {
      return {
        name,
        title: name,
        revision: queueStepRevision({
          repo: fixed.repo,
          stateDir: fixed.stateDir,
          name,
          config: stepConfig,
          timeoutMs,
          noProgressMs,
          toolchain,
          checkoutParent: fixed.baysRoot,
        }),
        kind,
        classification: stepConfig.classification ?? "carrier",
      }
    }
    return {
      name,
      title: name,
      revision: queueStepRevision({
        repo: fixed.repo,
        stateDir: fixed.stateDir,
        name,
        config: stepConfig,
        timeoutMs,
        noProgressMs,
        toolchain,
      }),
      kind,
    }
  })
}

/** Re-derive the current config's step descriptors from disk. Fails loud on an
 * invalid config so the environment audit never certifies a broken selection. */
async function reloadConfiguredStepDescriptors(
  repository: YrdRepository,
  process: Pick<Process, "run">,
  configPath?: string,
): Promise<readonly InstalledStep[]> {
  const loaded = await loadRepositoryConfig(repository, process, configPath)
  validateConfig(loaded.config)
  const mergeCommand =
    loaded.config.definitions.merge?.run === undefined ? undefined : shellCommand(loaded.config.definitions.merge.run)
  return configuredStepDescriptors(
    { repo: repository.repo, stateDir: repository.stateDir, baysRoot: repository.baysRoot },
    loaded.config,
    mergeCommand,
  )
}

function integratedRunner(
  process: Pick<Process, "run">,
  repo: string,
  stateDir: string,
  name: string,
  config: YrdStepConfig,
): StepRunner<IntegratedShape, CommandEvidence> {
  const options = {
    inject: { process },
    command: shellCommand(stepCommand(name, config)),
    cwd: repo,
    purpose: name,
    mode: stepGateMode(config),
    timeoutMs: stepTimeoutMs(config),
    noProgressTimeoutMs: stepNoProgressMs(config),
    artifactRoot: join(stateDir, "artifacts"),
    variables: (input: StepExecution<IntegratedShape>) => ({
      YRD_INTEGRATED_SHA: input.shape.integration.commit,
      ...(config.environment === undefined ? {} : { YRD_ENVIRONMENT: config.environment }),
    }),
    ...(config.env === undefined ? {} : { environmentOverrides: config.env }),
    ...(config.environmentPassthrough === undefined ? {} : { environmentPassthrough: config.environmentPassthrough }),
  }
  return config.runner === "waiting" ? configuredWaitingCommandStep(options) : configuredCommandStep(options)
}

function configuredQueueSteps(
  options: DefaultYrdRuntimeAppOptions,
  mergeCommand: readonly string[] | undefined,
): readonly RuntimeStep[] {
  const descriptors = configuredStepDescriptors(
    { repo: options.repo, stateDir: options.stateDir, baysRoot: options.baysRoot },
    options.config,
    mergeCommand,
  )
  return options.config.steps.map((name, index) => {
    const config = options.config.definitions[name] ?? { runner: "local" as const }
    const descriptor = descriptors[index]
    if (descriptor === undefined) throw new Error(`yrd: missing derived descriptor for queue step '${name}'`)
    const revision = descriptor.revision
    if (descriptor.kind === "merge") {
      return eraseStep(
        withMerge(
          mergeCommand === undefined
            ? gitMergeStep({
                inject: { process: options.process },
                repo: options.repo,
              })
            : configuredMergeStep({
                inject: { process: options.process },
                repo: options.repo,
                command: mergeCommand,
                artifactRoot: join(options.stateDir, "artifacts"),
                timeoutMs: stepTimeoutMs(config),
                ...(config.environment === undefined ? {} : { environment: config.environment }),
                ...(config.env === undefined ? {} : { environmentOverrides: config.env }),
                ...(config.environmentPassthrough === undefined
                  ? {}
                  : { environmentPassthrough: config.environmentPassthrough }),
              }),
          {
            revision,
          },
        ),
      )
    }
    if (descriptor.kind === "check") {
      return candidateStep(
        options.process,
        options.repo,
        options.stateDir,
        options.baysRoot,
        name,
        config,
        revision,
        options.candidatePool,
        descriptor.kind,
      )
    }
    return eraseStep(
      withStep(name, integratedRunner(options.process, options.repo, options.stateDir, name, config), {
        revision,
        kind: "action",
      }),
    )
  })
}

async function resolveCommit(process: Pick<Process, "run">, repo: string, ref: string): Promise<string | undefined> {
  const candidates = ref.startsWith("refs/") ? [ref] : [`refs/remotes/origin/${ref}`, ref]
  for (const candidate of candidates) {
    const args = ["rev-parse", "--verify", "--end-of-options", `${candidate}^{commit}`]
    const result = await process.run({
      argv: ["git", "-C", repo, ...args],
      cwd: repo,
      env: cleanGitEnvironment(globalThis.process.env),
      timeoutMs: GIT_TIMEOUT_MS,
    })
    assertGitDidNotTimeOut(result, args)
    if (result.exitCode === 0) return result.stdout.trim().toLowerCase()
  }
  return undefined
}

async function requireSubmitLinearTip(
  process: Pick<Process, "run">,
  repo: string,
  branch: string,
  head: string | undefined,
  source: "local" | "origin",
  localHead?: string,
): Promise<string | undefined> {
  if (head === undefined) return undefined
  const args = ["rev-list", "--parents", "-n", "1", head]
  const lineage = await process.run({
    argv: ["git", "-C", repo, ...args],
    cwd: repo,
    env: cleanGitEnvironment(globalThis.process.env),
    timeoutMs: GIT_TIMEOUT_MS,
  })
  assertGitDidNotTimeOut(lineage, args)
  const [commit, ...parents] = lineage.stdout.trim().toLowerCase().split(/\s+/u)
  if (lineage.exitCode !== 0 || commit !== head) {
    raiseFailure(
      "configuration",
      "submit-branch-lineage-inspection-failed",
      `yrd: could not inspect submitted ${source === "origin" ? `branch 'origin/${branch}'` : `local branch '${branch}'`} ` +
        `at '${head}': ${lineage.stderr.trim() || lineage.stdout.trim() || `exit ${String(lineage.exitCode)}`}`,
    )
  }
  if (parents.length <= 1) return head
  const identity =
    source === "origin"
      ? `live 'origin/${branch}' is '${head}'; local '${branch}' is '${localHead ?? "missing"}'`
      : `local '${branch}' is '${head}'`
  raiseFailure(
    "refusal",
    "merge-tip-carrier",
    `yrd: ${identity}. The submitted branch tip is a merge commit with ${parents.length} parents; ` +
      `Yrd requires a linear root carrier. linear rebuild required: merge inside the affected component repository, ` +
      `fast-forward that component's main, rebuild '${branch}' as one linear pin-bump commit, push it to origin, ` +
      `then run 'yrd pr submit ${branch}'`,
  )
}

/** Submission asks whether this is unpublished local work or "what commit does
 * the authored branch name on origin now?" Once origin advertises the branch,
 * stale remote-tracking refs are never accepted as live. */
async function resolveSubmitCommit(
  process: Pick<Process, "run">,
  repo: string,
  branch: string,
): Promise<string | undefined> {
  const origin = await observeOriginRemote(process, repo)
  if (!origin.ok) {
    raiseFailure(
      "configuration",
      "submit-origin-inspection-failed",
      `yrd: could not inspect origin before resolving submitted branch '${branch}': ${origin.detail}`,
    )
  }
  if (!origin.configured) {
    const localHead = await resolveCommit(process, repo, `refs/heads/${branch}`)
    return requireSubmitLinearTip(process, repo, branch, localHead, "local")
  }
  const advertisement = await observeOriginBranchAdvertisement(process, repo, branch)
  if (!advertisement.ok) {
    raiseFailure(
      "configuration",
      "submit-branch-refresh-failed",
      `yrd: could not refresh live branch '${branch}' from origin: ${advertisement.detail}\n` +
        "remedy: restore access to origin and retry; Yrd did not submit the stale local ref",
    )
  }
  // Origin absence is a fact, not a fetch failure: this is an unpublished
  // authored branch and its local commit is the only candidate available.
  if (!advertisement.advertised) {
    const localHead = await resolveCommit(process, repo, `refs/heads/${branch}`)
    return requireSubmitLinearTip(process, repo, branch, localHead, "local")
  }
  const observed = await observeFreshRemoteBranch(process, repo, branch)
  if (!observed.ok && observed.phase === "fetch") {
    raiseFailure(
      "configuration",
      "submit-branch-refresh-failed",
      `yrd: could not refresh live branch '${branch}' from origin: ${observed.detail}\n` +
        "remedy: restore access to origin and retry; Yrd did not submit the stale local ref",
    )
  }
  if (!observed.ok) {
    raiseFailure(
      "configuration",
      "submit-branch-head-missing",
      `yrd: refreshed live branch '${branch}' but '${observed.target}' did not resolve to a commit: ${observed.detail}`,
    )
  }
  const localHead = await resolveCommit(process, repo, `refs/heads/${branch}`)
  return requireSubmitLinearTip(process, repo, branch, observed.head, "origin", localHead)
}

async function readConfigFromBase(
  process: Pick<Process, "run">,
  repository: YrdRepository,
  base: string,
  path: string,
): Promise<string | undefined> {
  const { sha } = await inspectGitQueueTarget({
    inject: { process },
    repo: repository.repo,
    branch: baseIdentity(base),
  })
  const object = `${sha}:${path}`
  const exists = await process.run({
    argv: ["git", "-C", repository.repo, "cat-file", "-e", object],
    cwd: repository.repo,
    env: cleanGitEnvironment(globalThis.process.env),
  })
  if (exists.exitCode !== 0) return undefined
  const shown = await process.run({
    argv: ["git", "-C", repository.repo, "show", object],
    cwd: repository.repo,
    env: cleanGitEnvironment(globalThis.process.env),
  })
  if (shown.exitCode !== 0) {
    raiseFailure(
      "infrastructure",
      "config-read-failed",
      shown.stderr.trim() || `yrd: failed to read config '${path}' from base '${base}'`,
    )
  }
  return shown.stdout
}

function loadRepositoryConfig(
  repository: YrdRepository,
  process: Pick<Process, "run">,
  configPath?: string,
): ReturnType<typeof loadYrdConfig> {
  return loadYrdConfig({
    repo: repository.repo,
    defaultBase: repository.defaultBase,
    ...(configPath === undefined ? {} : { configPath }),
    readAuthority: (base, path) => readConfigFromBase(process, repository, base, path),
  })
}

async function resolveCommitMeta(
  process: Pick<Process, "run">,
  repo: string,
  ref: string,
): Promise<Readonly<{ subject: string; body?: string }> | undefined> {
  const sha = await resolveCommit(process, repo, ref)
  if (sha === undefined) return undefined
  const args = ["show", "--no-patch", "--format=%s%x00%b", sha]
  const result = await process.run({
    argv: ["git", "-C", repo, ...args],
    cwd: repo,
    env: cleanGitEnvironment(globalThis.process.env),
    timeoutMs: GIT_TIMEOUT_MS,
  })
  assertGitDidNotTimeOut(result, args)
  if (result.exitCode !== 0) return undefined
  const separator = result.stdout.indexOf("\0")
  const subject = (separator === -1 ? result.stdout : result.stdout.slice(0, separator)).trim()
  if (subject === "") return undefined
  const body = separator === -1 ? "" : result.stdout.slice(separator + 1).trim()
  return { subject, ...(body === "" ? {} : { body }) }
}

async function resolveQueueTarget(
  process: Pick<Process, "run">,
  repo: string,
  configuredBase: string,
  requestedBase: string,
  options: Readonly<{ refreshAuthority?: boolean; remoteBranch?: string }> = {},
): Promise<Readonly<{ base: string; sha: string; remoteBranch?: RemoteBranchSnapshot }>> {
  const configured = baseIdentity(configuredBase)
  const requested = baseIdentity(requestedBase)
  const base = requested === configured ? configured : requested
  if (requestedBase !== base && (await resolveCommit(process, repo, requestedBase)) === undefined) {
    throw new Error(`yrd: queue base '${requestedBase}' does not resolve`)
  }
  const target =
    options.refreshAuthority === true
      ? await resolveGitQueueTarget({
          inject: { process },
          repo,
          branch: base,
          ...(options.remoteBranch === undefined ? {} : { refreshRemoteBranches: [options.remoteBranch] }),
        })
      : await inspectGitQueueTarget({ inject: { process }, repo, branch: base })
  if (options.remoteBranch === undefined || target.remote !== "origin") return { base, sha: target.sha }
  const headSha = await resolveCommit(process, repo, `refs/remotes/origin/${options.remoteBranch}`)
  // Say WHICH fact an absent headSha is. Only a positive "origin does not
  // advertise it" earns `absent`; origin advertising a branch whose head we
  // cannot resolve locally is `unknown`, because we still have no head to give.
  const advertisement =
    headSha === undefined ? await observeOriginBranchAdvertisement(process, repo, options.remoteBranch) : undefined
  if (advertisement?.ok === false && advertisement.timedOut) {
    throw new Error(
      `yrd: git ls-remote --heads --exit-code origin refs/heads/${options.remoteBranch} timed out after ${GIT_TIMEOUT_MS}ms`,
    )
  }
  const headState =
    headSha !== undefined ? "resolved" : advertisement?.ok === true && !advertisement.advertised ? "absent" : "unknown"
  return {
    base,
    sha: target.sha,
    remoteBranch: {
      branch: options.remoteBranch,
      headState,
      ...(headSha === undefined ? {} : { headSha }),
    },
  }
}

function localContestGit(process: Pick<Process, "run">, repo: string): ContestGit {
  return {
    revision: createHash("sha256").update(`yrd-contest-git-v2\0${repo}`).digest("hex"),
    resolveCommit: (ref) => resolveCommit(process, repo, ref),
  }
}

function bayPath(root: string, bay: string): string {
  const path = resolve(root, bay)
  const local = relative(resolve(root), path)
  if (local === "" || local === ".." || local.startsWith(`..${sep}`)) {
    throw new Error(`yrd: contest Bay '${bay}' escapes the configured Bays root`)
  }
  return path
}

function contestAdapters(options: DefaultYrdAppOptions): {
  runners: readonly ContestRunnerDef[]
  evaluators: readonly ContestEvaluatorDef[]
  git: ContestGit
} {
  const evaluators =
    options.contestEvaluators ??
    options.config.contest.evaluators.map((id) => {
      const step = options.config.definitions[id]
      if (step === undefined) throw new Error(`yrd: contest evaluator '${id}' has no step configuration`)
      return createHeldOutCommandEvaluator({
        id,
        revision: contestEvaluatorRevision(
          options.repo,
          options.stateDir,
          options.baysRoot,
          id,
          step,
          options.config.contest.timeoutMs,
        ),
        command: shellCommand(stepCommand(id, step)),
        timeoutMs: options.config.contest.timeoutMs,
        runner: step.runner,
        ...(step.environment === undefined ? {} : { targetEnvironment: step.environment }),
        checkoutParent: options.baysRoot,
        artifactRoot: join(options.stateDir, "artifacts"),
        resolveBayPath: (bay) => bayPath(options.baysRoot, bay),
        inject: { process: options.process },
      })
    })
  const runners = options.contestRunners ?? []
  return { runners, evaluators, git: options.contestGit ?? localContestGit(options.process, options.repo) }
}

/** Compose the built-in workflow from immutable plugins and injected resources. */
async function createDefaultYrdRuntimeApp(options: DefaultYrdRuntimeAppOptions): Promise<YrdCliApp> {
  validateConfig(options.config)
  const flowConfig = options.config.flows === undefined ? undefined : defineConfig(...options.config.flows)
  const mergeCommand =
    options.config.definitions.merge?.run === undefined ? undefined : shellCommand(options.config.definitions.merge.run)
  const workspace =
    options.workspace ??
    (await createGitWorkspace({
      repo: options.repo,
      baysRoot: options.baysRoot,
      process: options.process,
      ...(options.receiverPath === undefined ? {} : { intakeRemote: options.receiverPath }),
      ...options.workspaceLifecycle,
    }))
  const bayJobs = createBayJobDefs(
    workspace,
    createPrPublicationService({ repo: options.repo, process: options.process }),
  )
  let deploymentStorePromise: ReturnType<typeof createGitDeploymentStore> | undefined
  const deploymentStore = () => {
    deploymentStorePromise ??= createGitDeploymentStore({
      repo: options.repo,
      deploymentsRoot: join(options.stateDir, "deployments"),
      process: options.process,
      prepare: (path) =>
        ensureWorkspaceDependencies(options.process, {
          path,
          subject: "immutable deployment",
          manifestSubject: "deployment",
          runPostinstall: true,
          fail(message) {
            throw new Error(`yrd: ${message}`)
          },
        }),
    })
    return deploymentStorePromise
  }
  const lazyDeploymentStore: GitDeploymentStore = {
    materialize: async (input) => (await deploymentStore()).materialize(input),
    reap: async (input) => (await deploymentStore()).reap(input),
    release: async (input) => (await deploymentStore()).release(input),
  }
  const deploymentJobs = createDeploymentJobDefs(lazyDeploymentStore)
  const queue = withQueue({
    steps: configuredQueueSteps(options, mergeCommand),
    batch: options.config.batch,
    defaultSteps: options.config.steps,
    defaultBase: options.config.base,
    requires: options.config.requires,
    ...(options.config.progress === undefined ? {} : { progress: options.config.progress }),
    ...(flowConfig === undefined ? {} : { flows: flowConfig }),
    resolveBaseSha: async (base) =>
      (
        await resolveGitQueueTarget({
          inject: { process: options.process },
          repo: options.repo,
          branch: baseIdentity(base),
        })
      ).sha,
    prepareCandidate: gitCandidatePreparer({
      inject: { process: options.process },
      repo: options.repo,
      checkoutParent: options.baysRoot,
      artifactRoot: join(options.stateDir, "artifacts"),
      ...(options.candidatePool === undefined ? {} : { candidatePool: options.candidatePool }),
    }),
    recordMerge: gitMergeRecorder({ inject: { process: options.process }, repo: options.repo }),
    evaluateIntent: ({ intent, baseSha, tombstones }) =>
      admitPinIntent({
        process: options.process,
        repo: options.repo,
        base: baseSha,
        component: intent.component,
        issue: `${intent.issue.source}:${intent.issue.id}`,
        ...(intent.target === undefined ? {} : { target: intent.target }),
        ...(intent.preconditions.expectedCurrentPin === undefined
          ? {}
          : { expectedCurrentPin: intent.preconditions.expectedCurrentPin }),
        ...(intent.preconditions.allowOffTrunk === true ? { allowOffTrunk: true } : {}),
        tombstones,
        deriveTarget: true,
      }),
    runner: (jobs) => {
      const contexts = worktreeContexts({
        repo: options.repo,
        parent: options.baysRoot,
        size: 2,
        submodules: "isolated",
        git: createCandidatePoolGit(options.process),
        ...(options.candidatePool === undefined ? {} : { pool: options.candidatePool }),
        ...(options.log === undefined ? {} : { log: options.log }),
      })
      const runner = localRunner({
        id: options.runnerId ?? "yrd-local",
        jobs,
        leaseMs: 60_000,
        maxInFlight: contexts.maxInFlight,
        contexts,
      })
      return Object.freeze({ ...runner, [Symbol.asyncDispose]: () => contexts.close() })
    },
  })
  const installedContests = contestAdapters(options)
  const contests = withContests({
    ...installedContests,
    defaultBase: options.config.base,
  })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs, contests.jobDefs, deploymentJobs] }),
    withDeployments({ jobs: deploymentJobs }),
    withIssues({
      sources: options.issueSources ?? [createKmIssueSource({ process: options.process, cwd: options.repo })],
    }),
    withIntents(),
    withBays({
      jobs: bayJobs,
      defaultBase: baseIdentity(options.config.base),
      ...(options.defaultSubmitter === undefined ? {} : { defaultSubmitter: options.defaultSubmitter }),
      resolveBase: async (base, context) => {
        const target = await resolveQueueTarget(options.process, options.repo, options.config.base, base, {
          refreshAuthority: true,
          ...(context?.branch === undefined ? {} : { remoteBranch: context.branch }),
        })
        return {
          base: target.base,
          baseSha: target.sha,
          ...(target.remoteBranch === undefined ? {} : { remoteBranch: target.remoteBranch }),
        }
      },
      ...(flowConfig === undefined
        ? {}
        : { selectFlow: (submission: Parameters<typeof selectFlow>[1]) => selectFlow(flowConfig, submission).pin }),
    }),
  )
  return createYrd(contests(queue(base)), {
    inject: {
      journal: options.journal,
      compatibility: CURRENT_JOURNAL_COMPATIBILITY,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
      ...(options.log === undefined ? {} : { log: options.log }),
    },
  })
}

export function createDefaultYrdApp(options: DefaultYrdAppOptions): Promise<YrdCliApp> {
  return createDefaultYrdRuntimeApp(options)
}

export type YrdHost = Readonly<{
  app: YrdCliApp
  repository: YrdRepository
  config: ResolvedYrdProjectConfig
  receiver: GitPushReceiver
  process: Process
  /** Native implementation identity captured exactly once during host startup. */
  implementationSource?: string
  services: YrdCliServices
  drain(): Promise<void>
  /** Releases the owned app, process, and scope. Idempotent with async disposal. */
  close(): Promise<void>
  /** Releases the host through the same lifecycle as close(). */
  [Symbol.asyncDispose](): Promise<void>
}>

/**
 * What `receiverTarget` below requires of a `refs/heads/` push, in one sentence,
 * rendered into the receiver's refusal. It lives beside the resolver rather than
 * at the call sites so the rule and the explanation of the rule cannot drift
 * apart.
 *
 * Note what the rule is NOT: there is no branch-name pattern anywhere in intake.
 * A branch is authorized because an ACTIVE BAY tracks it, which is both stricter
 * than a name prefix and indifferent to what the branch is called — `cto/…` and
 * `chief/…` are admitted on the same terms as `task/…`.
 *
 * It also does not describe a `refs/for/` push, which carries its authorization
 * in the ref and so can never fail this way. That path refuses by throwing the
 * reason it actually hit — this sentence would name a bay the pusher was never
 * asked for.
 */
const INTAKE_POLICY =
  "no active bay tracks this branch — open one with `yrd bay open --bay <name>`, or push a branch an active bay already tracks"

/**
 * Resolves what a pushed ref lands on: a branch push must find an active bay,
 * a submit push carries its own answer.
 *
 * The asymmetry is the point. A `refs/for/<base>/<change>` push predates its bay
 * by construction — that is what "push IS submit" means — so it cannot be
 * authorized by "an active bay tracks this branch", and asking it to be is how
 * the whole namespace stayed unreachable. Intake does not need a bay either:
 * `bay.intake` takes `bay` as optional and mints a PR from branch/name/base
 * alone. The PR is the unit of intake; a bay is a workspace that usually
 * happens to exist.
 */
/**
 * Exactly the bay fields the resolver reads. Narrow on purpose: it is what lets
 * the rule be tested against a literal instead of a booted runtime, and it says
 * in the type that intake authorization looks at nothing else.
 */
export type ReceiverBayView = Readonly<{
  id: string
  name: string
  issue?: string
  branch: string
  base: string
  baseSha?: string
  status: string
}>
export type ReceiverBayIndex = Readonly<{
  state: () => Readonly<{ bays: Readonly<{ byId: Readonly<Record<string, ReceiverBayView>> }> }>
}>

export function receiverTarget(app: ReceiverBayIndex, process: Pick<Process, "run">, repo: string) {
  return async (
    branch: string,
    _update: Readonly<ReceiverRefUpdate>,
    intent?: ReceiverSubmitIntent,
  ): Promise<ReceiverTarget | null> => {
    // One rule for what a change is called: the branch a bay for this issue
    // would already have. So a bay opened later for the same issue converges on
    // the carrier the submit already created rather than forking a second one.
    const carrier = intent === undefined ? branch : defaultBayBranch(intent.name)
    const bay = Object.values(app.state().bays.byId).find(
      (candidate) =>
        candidate.status === "active" &&
        (candidate.branch === carrier || (intent !== undefined && candidate.issue === intent.name)),
    )
    if (bay !== undefined) {
      if (bay.baseSha === undefined) return null
      return {
        bay: bay.id,
        name: bay.name,
        ...(bay.issue === undefined ? {} : { issue: bay.issue }),
        base: bay.base,
        baseSha: bay.baseSha,
        // A branch push names its branch in the ref and the receiver reads it
        // there; only a submit push needs to be told.
        ...(intent === undefined ? {} : { branch: bay.branch }),
      }
    }
    if (intent === undefined) return null
    const baseSha = await resolveCommit(process, repo, `refs/heads/${intent.base}`)
    // Never `return null` here: null renders INTAKE_POLICY, which would answer a
    // vanished base branch with instructions to open a bay. The push already
    // proved this base existed a moment ago, so its disappearance is a race
    // worth naming, not an authorization verdict.
    if (baseSha === undefined) {
      throw new Error(`yrd: base branch '${intent.base}' disappeared between admission and resolution`)
    }
    return { name: intent.name, issue: intent.name, base: intent.base, baseSha, branch: carrier }
  }
}

/**
 * Creates the carrier branch a submit push named, at the head it pushed.
 *
 * A `refs/heads/` push already IS its branch, so this is a no-op there. A
 * `refs/for/<base>/<change>` push names a CHANGE, and the carrier is derived —
 * which means nothing creates it unless intake does. Without this the PR is
 * admitted and then permanently undeliverable: the pre-submit gate resolves the
 * PR's branch and finds no such ref, so it refuses with
 * `required-check candidate '<branch>' is missing` and the change can never
 * leave draft. An intake path must not validate against a thing it does not
 * materialize.
 *
 * It also gives the pushed head an anchor of its own. Until now it was
 * reachable only through whatever branch the pusher happened to hold, so moving
 * that branch orphaned the PR.
 *
 * Fast-forward only, under a compare-and-swap: `update-ref <ref> <new> <old>`
 * fails if anyone moved the carrier in between, so a concurrent writer is a
 * loud refusal rather than a silently lost revision.
 */
export async function materializeCarrier(
  process: Pick<Process, "run">,
  repo: string,
  receipt: Readonly<ReceiverReceipt>,
): Promise<void> {
  if (receipt.change === undefined) return
  const ref = `refs/heads/${receipt.branch}`
  const current = await resolveCommit(process, repo, ref)
  // Replaying a receipt must not fail; the carrier is already where it belongs.
  if (current === receipt.headSha) return
  if (current !== undefined && !(await isAncestorCommit(process, repo, current, receipt.headSha))) {
    throw new Error(
      `yrd: carrier '${receipt.branch}' is at ${current.slice(0, 12)}, which the pushed head ` +
        `${receipt.headSha.slice(0, 12)} does not descend from; rebase the change onto it and push again`,
    )
  }
  const previous = current ?? "0".repeat(receipt.headSha.length)
  const args = ["update-ref", ref, receipt.headSha, previous]
  const result = await process.run({
    argv: ["git", "-C", repo, ...args],
    cwd: repo,
    env: cleanGitEnvironment(globalThis.process.env),
    timeoutMs: GIT_TIMEOUT_MS,
  })
  assertGitDidNotTimeOut(result, args)
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || `yrd: could not create carrier '${receipt.branch}' at ${receipt.headSha.slice(0, 12)}`,
    )
  }
}

async function isAncestorCommit(
  process: Pick<Process, "run">,
  repo: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const args = ["merge-base", "--is-ancestor", ancestor, descendant]
  const result = await process.run({
    argv: ["git", "-C", repo, ...args],
    cwd: repo,
    env: cleanGitEnvironment(globalThis.process.env),
    timeoutMs: GIT_TIMEOUT_MS,
  })
  assertGitDidNotTimeOut(result, args)
  return result.exitCode === 0
}

async function intakeReceipt(
  app: YrdCliApp,
  receipt: Readonly<ReceiverReceipt>,
  process: Pick<Process, "run">,
  repo: string,
): Promise<void> {
  // Before the dispatch, never after: a PR that exists without its carrier is
  // exactly the undeliverable state this exists to prevent, and a failure here
  // leaves the receipt for the next drain to retry.
  await materializeCarrier(process, repo, receipt)
  await app.dispatch(
    app.commands.bay.intake,
    { ...receipt.intake, receipt: receipt.id },
    { key: `receiver:${receipt.id}` },
  )
}

function queueAdministration(
  process: Pick<Process, "run">,
  repository: YrdRepository,
  defaultBase: string,
  deriveConfiguredSteps: () => Promise<readonly InstalledStep[]>,
  runtimeSteps: (() => readonly InstalledStep[]) | undefined,
): YrdCliQueueAdministration {
  const inspect = async (base = defaultBase) => {
    const baseSha = await resolveCommit(process, repository.repo, base)
    if (baseSha === undefined) throw new Error(`yrd: queue base '${base}' does not resolve`)
    return { base, baseSha }
  }
  return Object.freeze({
    async auditEnvironment(): Promise<QueueAuditResult> {
      // Re-derive the selected config's steps from disk on EVERY audit so a
      // config change after startup is proven, not masked by a stale snapshot.
      // The audit proves THREE-WAY equality (merge-queue R41b): runtime
      // installed revisions == persisted baseline == fresh disk derivation.
      // Legs form a remedy ladder per base: a baseline-vs-disk delta names the
      // deinit/init migration first (migrating the baseline may make the
      // runtime leg moot or freshly actionable); only when baseline and disk
      // agree is the runtime leg proven, so a resident built before another
      // process's migration fails loud instead of certifying baseline == disk
      // while it still executes the old steps.
      const [baselines, current] = await Promise.all([
        readInstalledBaselines(repository.stateDir),
        deriveConfiguredSteps(),
      ])
      const runtime = runtimeSteps?.()
      const baselineFindings = Object.values(baselines).flatMap((baseline) => {
        const configDrift = installedBaselineDrift(baseline, current)
        if (configDrift !== undefined) return [configDrift]
        const runtimeDrift = runtime === undefined ? undefined : runtimeBaselineDrift(baseline, runtime)
        return runtimeDrift === undefined ? [] : [runtimeDrift]
      })
      // How the runner is LAUNCHED decides what may change under it: an
      // immutable artifact cannot change, and a hot-reloading dev run is
      // meant to. The runtime does not second-guess that choice by
      // comparing its own checkout to a pin.
      return { findings: baselineFindings }
    },
    async provision(base) {
      const [inspected, current] = await Promise.all([inspect(base), deriveConfiguredSteps()])
      await writeInstalledBaseline(repository.stateDir, {
        ...inspected,
        installedAt: new Date().toISOString(),
        steps: current,
      })
      return { ...inspected, steps: current.map((step) => step.name), persistentResources: false }
    },
    async deprovision(base = defaultBase) {
      // Deinit must clear the stored baseline by key WITHOUT requiring the base
      // ref to resolve: a deleted stale base is exactly the case whose prescribed
      // remedy is `yrd admin queue deinit <base>`, so a wedged ref must not block it.
      const stored = (await readInstalledBaselines(repository.stateDir))[base]
      const baseSha = (await resolveCommit(process, repository.repo, base)) ?? stored?.baseSha
      const released = (await removeInstalledBaseline(repository.stateDir, base)) ? ["installed-baseline"] : []
      if (baseSha === undefined) {
        throw new Error(`yrd: queue base '${base}' does not resolve and no installed baseline is stored for it`)
      }
      return { base, baseSha, released, persistentResources: false }
    },
  })
}

type ResidentRunnerSeed = Readonly<{
  id: string
  epoch: string
  host: string
  pane?: string
}>

type ResidentRunnerIdentity = ResidentRunnerSeed & Readonly<{ queueId: string }>

type ResidentRunnerLease = Readonly<{ close(): Promise<void> }>

function residentRunnerSeed(env: NodeJS.ProcessEnv): ResidentRunnerSeed {
  const pane = [env.HERDR_PANE_ID, env.CMUX_SURFACE_ID]
    .map((value) => value?.trim())
    .find((value): value is string => value !== undefined && value !== "")
  return Object.freeze({
    id: `yrd-cli:${globalThis.process.pid}`,
    epoch: randomUUID(),
    host: hostname(),
    ...(pane === undefined ? {} : { pane }),
  })
}

function residentRunnerLog(log: ConditionalLogger, identity: ResidentRunnerSeed, queueId?: string): ConditionalLogger {
  return log.child({
    runner: identity.id,
    ...(queueId === undefined ? {} : { driverQueue: queueId }),
    driverEpoch: identity.epoch,
    host: identity.host,
    ...(identity.pane === undefined ? {} : { pane: identity.pane }),
  })
}

function residentRunnerLockOwnerPid(stateDir: string): number | undefined {
  try {
    const value = JSON.parse(readFileSync(join(stateDir, "resident-runner", "writer.lock"), "utf8")) as {
      pid?: unknown
    }
    return typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0 ? value.pid : undefined
  } catch {
    // silent-fallback-allow: unreadable advisory owner metadata means the lock owner is unknown.
    return undefined
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    // ESRCH = no such process (dead). EPERM and friends = exists but not signalable — treat as live.
    return (cause as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

function assertResidentSupportsJournalVersion(stateDir: string, target: number): void {
  let record: Readonly<{
    pid?: unknown
    exitedAt?: unknown
    journalVersions?: unknown
  }>
  try {
    record = JSON.parse(readFileSync(join(stateDir, "resident-runner", "status.json"), "utf8")) as typeof record
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  if (
    typeof record.pid !== "number" ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    record.exitedAt !== undefined ||
    !processAlive(record.pid)
  ) {
    return
  }
  const versions =
    Array.isArray(record.journalVersions) &&
    record.journalVersions.every(
      (version: unknown) => typeof version === "number" && Number.isSafeInteger(version) && version > 0,
    )
      ? (record.journalVersions as number[])
      : []
  const capability = Math.max(0, ...versions)
  if (capability < target) {
    raiseFailure(
      "refusal",
      "journal-resident-version-skew",
      `yrd: live resident pid ${String(record.pid)} supports journal v${String(capability)} but bump target is v${String(target)}; stop or upgrade that resident first`,
    )
  }
}

async function acquireResidentRunner(
  stateDir: string,
  identity: ResidentRunnerIdentity,
  log: ConditionalLogger,
): Promise<ResidentRunnerLease> {
  const runnerLog = log.child("runner")
  // When a prior owner died hard, the kernel may still be releasing the flock
  // for a beat after the pid is gone. Retry briefly if the lock body names a
  // dead pid so re-arm does not need a human `rm` of writer.lock (22306).
  const attempts = 8
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    const released = Promise.withResolvers<void>()
    const acquired = Promise.withResolvers<void>()
    const held = createExclusive(join(stateDir, "resident-runner"), { timeoutMs: 0 }).run(
      async () => {
        acquired.resolve()
        await released.promise
      },
      { holder: `queue=${identity.queueId} epoch=${identity.epoch}` },
    )
    try {
      await Promise.race([acquired.promise, held])
      runnerLog.info?.("Resident runner lease acquired", { runner: identity.id, stateDir })
      let closePromise: Promise<void> | undefined
      return Object.freeze({
        close: () =>
          (closePromise ??= (async () => {
            released.resolve()
            await held
            runnerLog.info?.("Resident runner lease released", { runner: identity.id, stateDir })
          })()),
      })
    } catch (error) {
      lastError = error
      if (failureFact(error)?.code !== "exclusive-busy") throw error
      const ownerPid = residentRunnerLockOwnerPid(stateDir)
      const ownerDead = ownerPid !== undefined && !processAlive(ownerPid)
      if (!ownerDead || attempt === attempts - 1) break
      runnerLog.warn?.("resident-runner lock busy with dead owner pid; retrying reclaim", {
        action: "resident-runner-lock-reap-retry",
        ownerPid,
        attempt: attempt + 1,
      })
      await Bun.sleep(25 * (attempt + 1))
    }
  }
  const error = lastError
  if (failureFact(error)?.code === "exclusive-busy") {
    const detail = error instanceof Error ? error.message.replace(/^yrd:\s*/u, "") : String(error)
    const ownerPid = residentRunnerLockOwnerPid(stateDir)
    const deadHint =
      ownerPid !== undefined && !processAlive(ownerPid)
        ? ` Owner pid ${ownerPid} is dead — if re-arm keeps failing, inspect \`lsof ${join(stateDir, "resident-runner", "writer.lock")}\` for a live holder.`
        : ""
    raiseFailure(
      "refusal",
      "resident-runner-active",
      `yrd: resident-runner-active: ${detail}. Stop the active 'yrd queue run' before starting another.${deadHint}`,
    )
  }
  throw error
}

async function closeRuntime(
  app: YrdCliApp | undefined,
  process: Process,
  scope: Scope,
  resident?: ResidentRunnerLease,
  candidatePool?: CandidatePool,
): Promise<void> {
  try {
    await app?.close()
  } finally {
    try {
      // Warm worktrees are removed via Git BEFORE the Process closes — a closed
      // Process rejects every run(), which would strand the pool's worktrees.
      await candidatePool?.close()
    } finally {
      try {
        await process.close()
      } finally {
        try {
          await scope[Symbol.asyncDispose]()
        } finally {
          await resident?.close()
        }
      }
    }
  }
}

type ShutdownSignal = "SIGINT" | "SIGTERM"
const ONE_SHOT_RECOVERY_CUTOFF = "1970-01-01T00:00:00.000Z"

function queueRecoveryArgv(repositoryRoot: string): readonly string[] {
  return ["yrd", "--repo", repositoryRoot, "queue", "recover"]
}

/** Announce a graceful drain as ONE structured loggily record — never a bare
 * wrapped stderr paragraph, since the resident runner's stderr IS its log
 * stream. The force-stop hint and its consequences are structured FIELDS, so a
 * viewer can surface them without parsing prose. */
export function reportGracefulShutdown(log: ConditionalLogger, signal: ShutdownSignal, repositoryRoot: string): void {
  log.warn?.(`Stopping after the current run finishes (${signal}); press Ctrl-C again to stop immediately.`, {
    signal,
    mode: "drain",
    forceStop: "press Ctrl-C again to stop immediately",
    recovery: queueRecoveryArgv(repositoryRoot),
  })
}

async function settleOneShotQueueRun(
  host: YrdHost,
  runner: string,
  signal: ShutdownSignal,
  log: ConditionalLogger,
): Promise<void> {
  try {
    // A runner-scoped recovery also sweeps every unrelated lease older than its
    // cutoff. Epoch keeps this signal path exact: only this PID-scoped one-shot
    // runner is declared dead.
    const runs = await host.app.queue.recover({
      recoveryTime: ONE_SHOT_RECOVERY_CUTOFF,
      runner,
      reason: `one-shot queue runner interrupted by ${signal}`,
    })
    if (runs.length > 0) {
      log.warn?.(`Stopped queue run ${runs.map((run) => run.id).join(", ")} safely after ${signal}.`)
    }
  } catch (error) {
    log.error?.(`Could not stop the queue run safely after ${signal}; run the recovery argv attached.`, {
      error: error instanceof Error ? error.message : String(error),
      recovery: queueRecoveryArgv(host.repository.repo),
    })
    throw error
  }
}

/** Own process signals at the run-to-exit CLI boundary, then restore native
 * signal exit semantics only after the host has drained its resources. */
function bindProcessShutdown(
  shutdown: (signal: ShutdownSignal) => Promise<void>,
  drain?: (signal: ShutdownSignal) => void,
): () => void {
  let draining = false
  let hardSignal: ShutdownSignal | undefined
  const remove = (): void => {
    globalThis.process.off("SIGINT", onSigint)
    globalThis.process.off("SIGTERM", onSigterm)
  }
  const forward = (signal: ShutdownSignal): void => {
    remove()
    globalThis.process.kill(globalThis.process.pid, signal)
  }
  const finish = (): void => {
    remove()
    if (hardSignal !== undefined) forward(hardSignal)
  }
  const onSignal = (signal: ShutdownSignal): void => {
    if (drain !== undefined && !draining) {
      draining = true
      drain(signal)
      return
    }
    if (hardSignal !== undefined) return
    hardSignal = signal
    // Closing the host aborts a live renderer, but the renderer owns terminal
    // restoration in its surrounding `using` block. Let the command boundary
    // unwind that block before `finish()` restores native signal exit status.
    void shutdown(signal).catch(() => undefined)
  }
  const onSigint = () => onSignal("SIGINT")
  const onSigterm = () => onSignal("SIGTERM")
  globalThis.process.on("SIGINT", onSigint)
  globalThis.process.on("SIGTERM", onSigterm)
  return finish
}

export type YrdHostOptions = Readonly<{
  cwd?: string
  configPath?: string
  env?: NodeJS.ProcessEnv
  log?: ConditionalLogger
  workspaceLifecycle?: GitWorkspaceLifecycleHooks
  /** Opaque logical submitter supplied by an embedding host; standalone Yrd defaults to operator. */
  defaultSubmitter?: string
}>

export type YrdProcessHostOptions = Pick<YrdHostOptions, "workspaceLifecycle" | "defaultSubmitter">

type YrdRuntimeHostOptions = YrdHostOptions &
  Readonly<{
    /** Loaded identity attested by the process host for a gitless sealed root. */
    implementationSource?: string
    /** Repair a stale view registry before the runtime replays Journal history. */
    repairViewsBeforeReplay?: boolean
  }>

export async function createYrdHost(options: YrdHostOptions = {}): Promise<YrdHost> {
  return createYrdRuntimeHost(options, undefined, "active")
}

/**
 * Build only the read-only queue audit needed by the resident health command.
 * The audit reuses the canonical config/baseline comparison but deliberately
 * has no app and no journal, so its cost cannot grow with delivery history.
 */
async function runnerHealthProbeServices(options: YrdRuntimeHostOptions): Promise<YrdCliServices> {
  const scope = createScope("yrd-runner-health")
  const ownsLog = options.log === undefined
  const log =
    options.log ??
    createYrdLogger(resolveYrdObservability({}, options.env ?? globalThis.process.env), (text) =>
      globalThis.process.stderr.write(text),
    )
  const env = cleanGitEnvironment(options.env ?? globalThis.process.env)
  const process = withGitIndexLockRetry(createProcess({ cwd: options.cwd, env, inject: { scope, log } }))
  try {
    const repository = await discoverYrdRepository({ cwd: options.cwd, env, process })
    const loaded = await loadRepositoryConfig(repository, process, options.configPath)
    const administration = queueAdministration(
      process,
      repository,
      loaded.config.base,
      () => reloadConfiguredStepDescriptors(repository, process, options.configPath),
      undefined,
    )
    if (administration.auditEnvironment === undefined) {
      throw new Error("yrd: runner health audit is unavailable")
    }
    const audit = await administration.auditEnvironment()
    return Object.freeze({
      base: loaded.config.base,
      queue: Object.freeze({ auditEnvironment: () => Promise.resolve(audit) }),
    })
  } finally {
    try {
      await closeRuntime(undefined, process, scope)
    } finally {
      if (ownsLog) log.end()
    }
  }
}

function createViewerWorkspace(): BayWorkspace {
  const refuse = () => ({
    status: "completed" as const,
    conclusion: "failure" as const,
    error: { code: "viewer-read-only", message: "yrd: viewer runtime cannot mutate bay workspaces" },
  })
  return Object.freeze({
    revision: "yrd-viewer-read-only-v1",
    provision: refuse,
    refresh: refuse,
    checkpoint: refuse,
    deprovision: refuse,
  })
}

async function createViewerReceiver(repository: YrdRepository, process: Process): Promise<GitPushReceiver> {
  const args = ["rev-parse", "--show-object-format"]
  const result = await process.run({
    argv: ["git", "-C", repository.repo, ...args],
    cwd: repository.repo,
    timeoutMs: GIT_TIMEOUT_MS,
  })
  assertGitDidNotTimeOut(result, args)
  const objectFormat = result.stdout.trim()
  if (result.exitCode !== 0 || (objectFormat !== "sha1" && objectFormat !== "sha256")) {
    throw new Error(result.stderr.trim() || `yrd: unsupported Git object format '${objectFormat}'`)
  }
  const refuse = (): never => {
    throw new Error("yrd: viewer runtime cannot mutate or drain the push receiver")
  }
  return Object.freeze({
    version: 1,
    receiverPath: join(repository.stateDir, "prs.git"),
    mainRepo: repository.repo,
    stateDir: repository.stateDir,
    inboxDir: join(repository.stateDir, "receiver-inbox"),
    objectFormat,
    shaLength: objectFormat === "sha1" ? 40 : 64,
    process,
    prepare: refuse,
    finalize: refuse,
    drain: refuse,
  })
}

async function createYrdRuntimeHost(
  options: YrdRuntimeHostOptions,
  residentSeed: ResidentRunnerSeed | undefined,
  mode: "active" | "viewer",
): Promise<YrdHost & Readonly<{ resident?: ResidentRunnerIdentity }>> {
  const scope = createScope("yrd-host")
  const ownsLog = options.log === undefined
  const log =
    options.log ??
    createYrdLogger(resolveYrdObservability({}, options.env ?? globalThis.process.env), (text) =>
      globalThis.process.stderr.write(text),
    )
  const env = cleanGitEnvironment(options.env ?? globalThis.process.env)
  const process = withGitIndexLockRetry(createProcess({ cwd: options.cwd, env, inject: { scope, log } }))
  let app: YrdCliApp | undefined
  let residentLease: ResidentRunnerLease | undefined
  let candidatePool: CandidatePool | undefined
  try {
    const repository = await discoverYrdRepository({ cwd: options.cwd, env, process })
    const loaded = await loadRepositoryConfig(repository, process, options.configPath)
    const resident =
      residentSeed === undefined
        ? undefined
        : Object.freeze({
            ...residentSeed,
            queueId: `${resolve(repository.repo)}#${baseIdentity(loaded.config.base)}`,
          })
    if (resident !== undefined) {
      residentLease = await acquireResidentRunner(
        repository.stateDir,
        resident,
        residentRunnerLog(log, resident, resident.queueId),
      )
    }
    using _setupSpan = log.span?.("setup", { phase: "pre-worktree", repo: repository.repo })
    const discoveredImplementationSource = sourceRepositoryFor(import.meta.url)
    const receiver =
      mode === "active"
        ? await createGitPushReceiver({
            mainRepo: repository.repo,
            stateDir: repository.stateDir,
            process,
          })
        : await createViewerReceiver(repository, process)
    const queueReadModel = createQueueReadModel({ dir: repository.stateDir })
    const journal =
      mode === "active"
        ? createJournal({
            dir: repository.stateDir,
            views: [queueReadModel.view],
            writerVersion: CURRENT_JOURNAL_COMPATIBILITY.version,
            inject: { log },
          })
        : createReadOnlyJournal({
            dir: repository.stateDir,
            inject: { log },
          })
    if (options.repairViewsBeforeReplay === true) {
      await (journal as MutableJournal).views.rebuild()
    }
    const defaultSubmitter = options.defaultSubmitter ?? "operator"
    if (mode === "active") {
      candidatePool = createCandidatePool({
        repo: repository.repo,
        parent: repository.baysRoot,
        git: createCandidatePoolGit(process, env),
        log,
      })
    }
    const implementationSource =
      options.implementationSource ?? (await implementationSourceIdentity(process, discoveredImplementationSource))
    if (resident !== undefined && implementationSource === undefined) {
      raiseFailure(
        "refusal",
        "runtime-source-unavailable",
        "yrd: resident runner cannot determine the implementation source it loaded; not starting",
      )
    }
    app = await createDefaultYrdRuntimeApp({
      repo: repository.repo,
      stateDir: repository.stateDir,
      baysRoot: repository.baysRoot,
      ...(mode === "active" ? { receiverPath: receiver.receiverPath } : { workspace: createViewerWorkspace() }),
      ...(options.workspaceLifecycle === undefined ? {} : { workspaceLifecycle: options.workspaceLifecycle }),
      journal,
      process,
      config: loaded.config,
      defaultSubmitter,
      scope,
      log,
      candidatePool,
      runnerId: resident?.id ?? `yrd-cli:${globalThis.process.pid}`,
      ...(implementationSource === undefined ? {} : { implementationSource }),
    })
    if (mode === "active") {
      // Cutover migration: a pre-settlement (v1) journal can leave non-terminal
      // legacy roots that the v2 projection cannot settle on its own. Settle the
      // abandoned ones (loud receipt) and refuse only while a previous writer still
      // holds a live lease — before any command reads or advances the queue.
      await app.queue.quiesceLegacyRoots({ now: new Date().toISOString(), by: "yrd/migration" })
    }
    const runtimeApp = app
    const resolveTarget = receiverTarget(runtimeApp, process, repository.repo)
    const receiverLog = log.child("receiver")
    const drain = async (): Promise<void> => {
      if (mode === "viewer") throw new Error("yrd: viewer runtime cannot drain the push receiver")
      using _span = receiverLog.span?.("drain")
      const result = await receiver.drain({
        resolveTarget,
        intakePolicy: INTAKE_POLICY,
        intake: (receipt) => intakeReceipt(runtimeApp, receipt, process, repository.repo),
        lockTimeoutMs: 30_000,
      })
      if (result.failed.length > 0 || result.ambiguous.length > 0) {
        throw new Error(
          `yrd: receiver inbox did not drain cleanly: ${JSON.stringify({ failed: result.failed, ambiguous: result.ambiguous })}`,
        )
      }
    }
    if (mode === "active") await drain()
    const checks = configuredChecks(process, repository.stateDir, loaded.config, env)
    const services = Object.freeze({
      ...(loaded.config.flows === undefined ? {} : { config: defineConfig(...loaded.config.flows) }),
      queue: queueAdministration(
        process,
        repository,
        loaded.config.base,
        () => reloadConfiguredStepDescriptors(repository, process, options.configPath),
        // The RUNTIME leg must come from the live runtime object — the steps
        // this process actually installed — never re-derived from config.
        () => runtimeApp.queue.steps(),
      ),
      recut: createGitPRRecutter({ inject: { process }, repo: repository.repo, env }),
      mergeRecords: Object.freeze({
        async find(selector: string) {
          const baseSha = (
            await resolveGitQueueTarget({
              inject: { process },
              repo: repository.repo,
              branch: baseIdentity(loaded.config.base),
            })
          ).sha
          return findRepositoryMergeRecords({ inject: { process }, repo: repository.repo, baseSha, selector })
        },
      }),
      base: loaded.config.base,
      [LandingAuthorityBoundary]: loaded.config.landing ?? "expected",
      checks,
      journal: Object.freeze({
        importOrphan: (sourcePath: string) =>
          importOrphanJournal({
            dir: repository.stateDir,
            sourcePath,
            importedBy: defaultSubmitter,
            views: [queueReadModel.view],
            log,
          }),
        rebuildViews: () => {
          if (mode !== "active") throw new Error("yrd: viewer runtime cannot rebuild Journal views")
          return (journal as MutableJournal).views.rebuild()
        },
        bump: (version: number) => {
          if (mode !== "active") throw new Error("yrd: viewer runtime cannot bump the Journal version")
          assertResidentSupportsJournalVersion(repository.stateDir, version)
          return (journal as MutableJournal).administration.bump(version)
        },
      }),
      queueReadModel: Object.freeze({ snapshot: queueReadModel.snapshot }),
      process,
      environment: env,
    })
    let closePromise: Promise<void> | undefined
    const close = () =>
      (closePromise ??= closeRuntime(app, process, scope, residentLease, candidatePool).finally(() => {
        if (ownsLog) log.end()
      }))
    return Object.freeze({
      app,
      repository,
      config: loaded.config,
      receiver,
      process,
      ...(resident === undefined ? {} : { resident }),
      ...(implementationSource === undefined ? {} : { implementationSource }),
      services,
      drain,
      close,
      [Symbol.asyncDispose]: close,
    })
  } catch (error) {
    await closeRuntime(app, process, scope, residentLease, candidatePool)
    if (ownsLog) log.end()
    throw error
  }
}

async function runReceiverHook(
  mode: "pre-receive" | "post-receive",
  env: NodeJS.ProcessEnv,
  workspaceLifecycle?: GitWorkspaceLifecycleHooks,
): Promise<void> {
  const gitDir = env.GIT_DIR
  if (gitDir === undefined || gitDir === "") throw new Error("yrd: receiver hook requires GIT_DIR")
  const scope = createScope("yrd-receiver-hook")
  const rootLog = createYrdLogger(resolveYrdObservability({}, env), (text) => globalThis.process.stderr.write(text))
  const log = rootLog.child({ host: "receiver-hook", mode })
  const runtimeProcess = withGitIndexLockRetry(
    createProcess({ cwd: globalThis.process.cwd(), env, inject: { scope, log } }),
  )
  let app: YrdCliApp | undefined
  try {
    const receiver = await loadGitPushReceiver(resolve(globalThis.process.cwd(), gitDir), runtimeProcess)
    const repository = await discoverYrdRepository({ cwd: receiver.mainRepo, env, process: runtimeProcess })
    const loaded = await loadRepositoryConfig(repository, runtimeProcess)
    const implementationSource = await implementationSourceIdentity(
      runtimeProcess,
      sourceRepositoryFor(import.meta.url),
    )
    app = await createDefaultYrdRuntimeApp({
      repo: repository.repo,
      stateDir: repository.stateDir,
      baysRoot: repository.baysRoot,
      receiverPath: receiver.receiverPath,
      journal: createJournal({
        dir: repository.stateDir,
        views: [createQueueReadModel({ dir: repository.stateDir }).view],
        writerVersion: CURRENT_JOURNAL_COMPATIBILITY.version,
        inject: { log },
      }),
      process: runtimeProcess,
      config: loaded.config,
      ...(workspaceLifecycle === undefined ? {} : { workspaceLifecycle }),
      scope,
      log,
      ...(implementationSource === undefined ? {} : { implementationSource }),
    })
    const runtimeApp = app
    await runReceiverHookFromEnvironment(mode, {
      env,
      process: runtimeProcess,
      resolveTarget: receiverTarget(runtimeApp, runtimeProcess, repository.repo),
      intakePolicy: INTAKE_POLICY,
      intake: (receipt) => intakeReceipt(runtimeApp, receipt, runtimeProcess, repository.repo),
    })
  } finally {
    await closeRuntime(app, runtimeProcess, scope)
    rootLog.end()
  }
}

/**
 * Silvery `run()` options for the live, interactive watch UI (`yrd watch`,
 * `yrd queue ls --watch`, …).
 *
 * `mouse: true` is load-bearing, not cosmetic. The watch UI is a fullscreen
 * (alternate-screen) app whose primary surface is a scrollable `ListView`.
 * When mouse tracking is NOT enabled, terminals (Ghostty, xterm-family) fall
 * back to "alternate scroll": they translate the trackpad/mouse wheel into
 * cursor arrow-key sequences (ESC[A / ESC[B). Those arrows reach silvery as
 * ordinary keyboard input, and the ListView's built-in navigation consumes
 * them to move the selection cursor — so scrolling the trackpad moves the
 * highlighted row instead of scrolling the viewport. Enabling mouse tracking
 * (silvery emits CSI ?1003h / ?1006h) makes the terminal deliver the wheel as
 * SGR mouse reports, which the ListView scrolls the viewport with while
 * leaving the cursor put. Regression: @km/code/trackpad-wheel-not-scrolling.
 */
export const WATCH_LIVE_RENDER_OPTIONS = {
  mode: "fullscreen",
  mouse: true,
  // Mouse tracking intercepts terminal-native drag selection. Keep Silvery's
  // selection feature explicit and copy completed drags through OSC52.
  selection: true,
  copyOnSelect: true,
} as const

function defaultIO(): YrdCliIO {
  const color = process.env.NO_COLOR === undefined && (process.stdout.isTTY || process.env.FORCE_COLOR !== undefined)
  const interactive = process.stdin.isTTY && process.stdout.isTTY
  const stderrIsTTY = process.stderr.isTTY === true
  const io: YrdCliIO = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    interactive,
    stderrIsTTY,
    clearStderrLine: () => {
      const positioned = cursorTo(process.stderr, 0)
      const cleared = clearLine(process.stderr, 0)
      return positioned && cleared
    },
    color,
    columns: process.stdout.columns,
    rows: process.stdout.rows,
    cwd: process.cwd(),
    ...(process.env.HAB_SERVICE_NAME?.trim() ? { healthServiceName: process.env.HAB_SERVICE_NAME.trim() } : {}),
    residentLeaseHeld: (cwd) => residentRunnerLeaseHeld(cwd),
  }
  if (!interactive) return io
  return withLiveRenderer(io, async (element, options) => {
    using handle = await run(element, { ...WATCH_LIVE_RENDER_OPTIONS, signal: options.signal })
    await handle.waitUntilExit()
  })
}

/** Process entrypoint shared by yrd and git-yrd. */
async function runYrdProcessHost(
  argv: readonly string[],
  io: YrdCliIO,
  terminateAfterCleanup: boolean,
  options: YrdProcessHostOptions,
): Promise<YrdCliExitCode> {
  const env = process.env
  const invocation = resolveInvocation(argv)
  if (invocation.args[0] === "receiver-hook") {
    const json = yrdJsonOutputRequested(argv)
    const mode = invocation.args[1]
    if (mode !== "pre-receive" && mode !== "post-receive") {
      await diagnostic(
        io,
        createFailure({
          kind: "usage",
          code: "invalid-arguments",
          message: "yrd: receiver-hook requires pre-receive or post-receive",
        }),
        { json },
      )
      return 2
    }
    try {
      await runReceiverHook(mode, env, options.workspaceLifecycle)
      return 0
    } catch (error) {
      await diagnostic(io, error, { json })
      return classifyFailure(error).exitCode
    }
  }

  const wantsRootHelp = invocation.args.length === 0
  if (
    wantsRootHelp ||
    invocation.args.some(
      (argument) => argument === "--help" || argument === "-h" || argument === "--version" || argument === "-V",
    )
  ) {
    return runYrdHelp(wantsRootHelp ? [...argv, "--help"] : argv, io)
  }

  let log: ConditionalLogger | undefined
  let host: YrdHost | undefined
  let oneShotRunner: string | undefined
  let shutdownLog: ConditionalLogger | undefined
  let closePromise: Promise<void> | undefined
  const closeHost = (signal?: ShutdownSignal) =>
    (closePromise ??= (async () => {
      try {
        if (signal !== undefined && host !== undefined && oneShotRunner !== undefined && shutdownLog !== undefined) {
          await settleOneShotQueueRun(host, oneShotRunner, signal, shutdownLog)
        }
      } finally {
        await host?.close()
      }
    })())
  let removeShutdownSignals: () => void = () => undefined
  let processExit: YrdCliExitCode | undefined
  try {
    const sourceAttestation = takeImplementationSourceAttestation(env)
    if (
      io.implementationSource !== undefined &&
      sourceAttestation !== undefined &&
      io.implementationSource !== sourceAttestation
    ) {
      throw new Error("yrd: process-host implementation source conflicts with launcher attestation")
    }
    const exitCode = await runYrdProcessRuntime(argv, io, {
      ambientCwd: io.cwd ?? globalThis.process.cwd(),
      env,
      ...(yrdQueueRunnerCheckRequested(argv)
        ? {
            async probe(context) {
              return {
                services: await runnerHealthProbeServices({
                  cwd: context.repo,
                  env,
                  ...(context.configPath === undefined ? {} : { configPath: context.configPath }),
                }),
                io: { cwd: context.repo },
              }
            },
          }
        : {}),
      async load(context, posture) {
        const runner =
          posture === "resident-queue-run" || posture === "one-shot-queue-run" ? residentRunnerSeed(env) : undefined
        const residentSeed = posture === "resident-queue-run" ? runner : undefined
        // The resident follow-runner logs at DEBUG-by-default (see
        // residentObservability) so run/step starts and successful completions
        // reach its concise human formatter; one-shot commands keep WARN.
        const observability =
          residentSeed === undefined ? context.observability : residentObservability(context.observability)
        // For the resident, the stderr log stream renders as scannable
        // watch-timeline rows (JSON stays in the JSONL file sink); one-shot
        // commands keep the default console format.
        const residentArtifacts: { root: string | undefined } = { root: undefined }
        const human =
          residentSeed === undefined
            ? undefined
            : (event: Parameters<typeof formatResidentLogLine>[0]) => {
                const artifactRoot = residentArtifacts.root
                if (artifactRoot !== undefined) {
                  const home = residentArtifactHome(event, artifactRoot)
                  if (home !== undefined) mkdirSync(home, { recursive: true })
                }
                return formatResidentLogLine(event, {
                  color: io.color === true,
                  ...(artifactRoot === undefined ? {} : { artifactRoot }),
                  includeDebug: observability.explicitLevel || observability.debug !== undefined,
                })
              }
        log = createYrdLogger(observability, (text) => io.stderr(text), human)
        const runtimeLog = runner === undefined ? log : residentRunnerLog(log, runner)
        const selectedImplementationSource = io.implementationSource ?? sourceAttestation
        const activeHost = await createYrdRuntimeHost(
          {
            cwd: context.repo,
            env,
            log: runtimeLog,
            ...(context.configPath === undefined ? {} : { configPath: context.configPath }),
            ...(selectedImplementationSource === undefined
              ? {}
              : { implementationSource: selectedImplementationSource }),
            ...(posture === "journal-view-repair" ? { repairViewsBeforeReplay: true } : {}),
            ...(options.workspaceLifecycle === undefined ? {} : { workspaceLifecycle: options.workspaceLifecycle }),
            ...(options.defaultSubmitter === undefined ? {} : { defaultSubmitter: options.defaultSubmitter }),
          },
          residentSeed,
          posture === "viewer" ? "viewer" : "active",
        )
        const resident = activeHost.resident
        const resolveReadQueueTarget = createPostureQueueTargetResolver(posture, (ref, cwd) =>
          io.resolveQueueTarget === undefined
            ? resolveQueueTarget(activeHost.process, activeHost.repository.repo, activeHost.config.base, ref)
            : io.resolveQueueTarget(ref, cwd),
        )
        if (posture === "viewer") {
          await Promise.all(
            queueReadBases(activeHost.app.state(), activeHost.config.base).map((base) =>
              resolveReadQueueTarget(base, activeHost.repository.worktree),
            ),
          )
        }
        residentArtifacts.root = join(activeHost.repository.stateDir, "artifacts")
        host = activeHost
        const runnerLog = runtimeLog.child("runner")
        oneShotRunner = posture === "one-shot-queue-run" ? runner?.id : undefined
        shutdownLog = runnerLog
        const drain =
          posture === "resident-queue-run" || posture === "bracketed-bay-open" ? new AbortController() : undefined
        removeShutdownSignals = bindProcessShutdown(
          closeHost,
          drain === undefined
            ? undefined
            : (signal) => {
                drain.abort(signal)
                if (posture === "resident-queue-run") {
                  reportGracefulShutdown(runnerLog, signal, activeHost.repository.repo)
                } else {
                  runtimeLog.warn?.(`Bay work was interrupted by ${signal}; preserving the Bay instead of closing it.`)
                }
              },
        )
        return {
          app: activeHost.app,
          services: activeHost.services,
          io: {
            cwd: activeHost.repository.worktree,
            repositoryRoot: activeHost.repository.repo,
            artifactRoot: join(activeHost.repository.stateDir, "artifacts"),
            stateDir: activeHost.repository.stateDir,
            ...(runner === undefined ? {} : { runner: runner.id }),
            ...(resident === undefined ? {} : { driver: { queueId: resident.queueId, epoch: resident.epoch } }),
            ...(runner === undefined || activeHost.implementationSource === undefined
              ? {}
              : { implementationSource: activeHost.implementationSource }),
            concurrency: io.concurrency ?? activeHost.config.contest.concurrency,
            resolveRevision: (ref, cwd) =>
              io.resolveRevision === undefined
                ? resolveSubmitCommit(activeHost.process, cwd, ref)
                : io.resolveRevision(ref, cwd),
            resolveCommitMeta: (ref, cwd) =>
              io.resolveCommitMeta === undefined
                ? resolveCommitMeta(activeHost.process, cwd, ref)
                : io.resolveCommitMeta(ref, cwd),
            resolveQueueTarget: resolveReadQueueTarget,
            ...(drain === undefined ? {} : { drainSignal: drain.signal }),
          },
        }
      },
    })
    processExit = exitCode
    return exitCode
  } catch (error) {
    if (isYrdRuntimeReloadRequest(error)) {
      try {
        return await execYrdProcessInPlace({
          closeRuntime: closeHost,
          removeShutdownSignals,
          closeLog: () => log?.end(),
          execPath: globalThis.process.execPath,
          argv,
          env,
          execve: (execPath, execArgv, execEnv) => {
            const execve = globalThis.process.execve
            if (execve === undefined) throw new Error("this Bun runtime cannot reload a resident with execve")
            return execve(execPath, [...execArgv], execEnv)
          },
        })
      } catch (reloadError) {
        await diagnostic(io, reloadError, { json: yrdJsonOutputRequested(argv) })
        processExit = classifyFailure(reloadError).exitCode
        return processExit
      }
    }
    await diagnostic(io, error, { json: yrdJsonOutputRequested(argv) })
    processExit = classifyFailure(error).exitCode
    return processExit
  } finally {
    try {
      await closeHost()
    } finally {
      removeShutdownSignals()
      // One command, one stage table. Emitted last so it covers the whole
      // invocation, and through the host-owned logger so `DEBUG=yrd:perf`
      // reaches it like any other namespace. `unaccountedMs` is the honest row:
      // a breakdown that silently omits most of the command reads as coverage,
      // which is how a multi-second stage stayed invisible behind a `totalMs`
      // that described 2% of the work.
      // Bun 1.3 can spin or fault while disposing an invocation's file-backed
      // logger. The executable boundary already owns termination; the writer's
      // process-exit hook flushes its buffer after host cleanup, preserving the
      // classified code instead of losing it to a hang or SIGILL.
      if (processExit !== undefined && terminateAfterCleanup) globalThis.process.exit(processExit)
      log?.child("perf").debug?.("command stage breakdown", stageReport())
      log?.end()
    }
  }
}

/** Process-host seam for embedded callers and focused tests. */
export function runYrdProcess(
  argv: readonly string[] = process.argv,
  io: YrdCliIO = defaultIO(),
  options: YrdProcessHostOptions = {},
): Promise<YrdCliExitCode> {
  return runYrdProcessHost(argv, io, false, options)
}

/** Real executable boundary: fully close the host, then terminate even when a
 * file-backed logger would otherwise retain or fault Bun resources. Kept out of
 * the package index; only bin/yrd.ts owns process lifetime. */
export async function runYrdExecutable(): Promise<never> {
  const exitCode = await runYrdProcessHost(globalThis.process.argv, defaultIO(), true, {})
  globalThis.process.exit(exitCode)
}
