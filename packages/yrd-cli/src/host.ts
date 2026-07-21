import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { hostname } from "node:os"
import { join, relative, resolve, sep } from "node:path"
import { clearLine, cursorTo } from "node:readline"
import { createScope, type Scope } from "@silvery/scope"
import {
  createBayJobDefs,
  createGitPushReceiver,
  createGitWorkspace,
  baseIdentity,
  loadGitPushReceiver,
  runReceiverHookFromEnvironment,
  withBays,
  type BayWorkspace,
  type GitPushReceiver,
  type ReceiverReceipt,
  type ReceiverTarget,
} from "@yrd/bay"
import {
  createAgContestRunner,
  createHeldOutCommandEvaluator,
  withContests,
  type ContestEvaluatorDef,
  type ContestGit,
  type ContestRunnerDef,
} from "@yrd/contest"
import { createYrd, createYrdDef, failureFact, pipe, raiseFailure, type Journal } from "@yrd/core"
import { withJobs } from "@yrd/job"
import {
  configuredCommandStep,
  configuredMergeStep,
  configuredWaitingCommandStep,
  createCandidatePool,
  createCandidatePoolGit,
  createGitPRRecutter,
  gitCheckStep,
  gitMergeStep,
  inspectGitQueueTarget,
  resolveGitQueueTarget,
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
import { createExclusive, createJournal, createReadOnlyJournal, importOrphanJournal } from "@yrd/persistence"
import { createProcess, shellCommand, type Process, type ProcessResult } from "@yrd/process"
import { createKmIssueSource, withIssues, type IssueSource } from "@yrd/issue"
import type { ConditionalLogger } from "loggily"
import { run } from "silvery/runtime"
import { cleanGitEnvironment } from "./git-environment.ts"
import { loadYrdConfig, SignalRecipientSchema, type ResolvedYrdProjectConfig, type YrdStepConfig } from "./config.ts"
import { classifyFailure, resolveInvocation } from "./invocation.ts"
import { withLiveRenderer } from "./live-renderer.ts"
import { createYrdLogger, residentObservability, resolveYrdObservability } from "./observability.ts"
import { formatResidentLogLine, residentArtifactHome } from "./runner-timeline.ts"
import { diagnostic } from "./output.tsx"
import { discoverYrdRepository, type YrdRepository } from "./repository.ts"
import { runYrdHelp, runYrdProcessRuntime } from "./run.ts"
import { queueStepRevision, type ToolchainFingerprint } from "./host-revision.ts"
import { createRunIndexObserver, type RunIndexObserver } from "./run-index.ts"
import {
  createSignalObserver,
  createTribeSignalAdapter,
  type SignalDeliveryAdapter,
  type SignalObserver,
} from "./signals.ts"
import type { YrdCliApp, YrdCliExitCode, YrdCliIO, YrdCliQueueAdministration, YrdCliServices } from "./types.ts"

type RuntimeStep = StepDef<PRShape, PRShape>

const RawGitPushPattern = /(?:^|[\n;&|])\s*git\s+push(?:\s|$)/u

export type DefaultYrdAppOptions = Readonly<{
  repo: string
  stateDir: string
  baysRoot: string
  journal: Journal<unknown>
  process: Pick<Process, "run">
  config: ResolvedYrdProjectConfig
  receiverPath?: string
  workspace?: BayWorkspace
  issueSources?: readonly IssueSource[]
  contestRunners?: readonly ContestRunnerDef[]
  contestEvaluators?: readonly ContestEvaluatorDef[]
  contestGit?: ContestGit
  defaultActor?: string
  scope?: Scope
  log?: ConditionalLogger
  /** Opt-in warm candidate-worktree pool shared across check steps (R40). */
  candidatePool?: CandidatePool
}>

function validateConfig(config: ResolvedYrdProjectConfig): void {
  for (const name of config.steps) {
    if (name !== "merge" && config.definitions[name]?.run === undefined) {
      raiseFailure(
        "configuration",
        "step-command-missing",
        `yrd: default queue step '${name}' requires steps.${name}.run`,
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
): RuntimeStep {
  return eraseStep(
    withStep(
      name,
      gitCheckStep({
        inject: { process },
        repo,
        command: shellCommand(stepCommand(name, config)),
        checkoutParent,
        ...(candidatePool === undefined ? {} : { candidatePool }),
        artifactRoot: join(stateDir, "artifacts"),
        purpose: name,
        runner: config.runner,
        classification: config.classification ?? "carrier",
        timeoutMs: stepTimeoutMs(config),
        noProgressTimeoutMs: stepNoProgressMs(config),
        ...(config.environment === undefined ? {} : { environment: config.environment }),
        ...(config.env === undefined ? {} : { environmentOverrides: config.env }),
        ...(config.environmentPassthrough === undefined
          ? {}
          : { environmentPassthrough: config.environmentPassthrough }),
      }),
      {
        revision,
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
  let integrated = false
  return config.steps.map((name) => {
    const stepConfig = config.definitions[name] ?? { runner: "local" as const }
    const timeoutMs = stepTimeoutMs(stepConfig)
    const noProgressMs = stepNoProgressMs(stepConfig)
    if (name === "merge") {
      integrated = true
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
        integrates: true,
        needsIntegration: false,
      }
    }
    if (!integrated) {
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
        integrates: false,
        needsIntegration: false,
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
      integrates: false,
      needsIntegration: true,
    }
  })
}

/** Re-derive the current config's step descriptors from disk. Fails loud on an
 * invalid config so the environment audit never certifies a broken selection. */
async function reloadConfiguredStepDescriptors(repository: YrdRepository): Promise<readonly InstalledStep[]> {
  const loaded = await loadYrdConfig({ repo: repository.repo, defaultBase: repository.defaultBase })
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
  options: DefaultYrdAppOptions,
  mergeCommand: readonly string[] | undefined,
): readonly RuntimeStep[] {
  const descriptors = configuredStepDescriptors(
    { repo: options.repo, stateDir: options.stateDir, baysRoot: options.baysRoot },
    options.config,
    mergeCommand,
  )
  let integrated = false
  return options.config.steps.map((name, index) => {
    const config = options.config.definitions[name] ?? { runner: "local" as const }
    const descriptor = descriptors[index]
    if (descriptor === undefined) throw new Error(`yrd: missing derived descriptor for queue step '${name}'`)
    const revision = descriptor.revision
    if (name === "merge") {
      integrated = true
      return eraseStep(
        withMerge(
          mergeCommand === undefined
            ? gitMergeStep({ inject: { process: options.process }, repo: options.repo })
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
          { revision },
        ),
      )
    }
    if (!integrated) {
      return candidateStep(
        options.process,
        options.repo,
        options.stateDir,
        options.baysRoot,
        name,
        config,
        revision,
        options.candidatePool,
      )
    }
    return eraseStep(
      withStep(name, integratedRunner(options.process, options.repo, options.stateDir, name, config), {
        revision,
        needsIntegration: true,
      }),
    )
  })
}

async function resolveCommit(process: Pick<Process, "run">, repo: string, ref: string): Promise<string | undefined> {
  const candidates = ref.startsWith("refs/") ? [ref] : [ref, `refs/remotes/origin/${ref}`]
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
  options: Readonly<{ refreshAuthority?: boolean }> = {},
): Promise<Readonly<{ base: string; sha: string }>> {
  const configured = baseIdentity(configuredBase)
  const requested = baseIdentity(requestedBase)
  const base = requested === configured ? configured : requested
  if (requestedBase !== base && (await resolveCommit(process, repo, requestedBase)) === undefined) {
    throw new Error(`yrd: queue base '${requestedBase}' does not resolve`)
  }
  const inspect = options.refreshAuthority === true ? resolveGitQueueTarget : inspectGitQueueTarget
  const target = await inspect({ inject: { process }, repo, branch: base })
  return { base, sha: target.sha }
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

function defaultContestAdapters(options: DefaultYrdAppOptions): {
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
  const runners = options.contestRunners ?? [
    createAgContestRunner({
      revision: createHash("sha256")
        .update(
          JSON.stringify({
            implementation: "yrd-ag-runner-v2",
            repo: options.repo,
            stateDir: options.stateDir,
            timeoutMs: options.config.contest.timeoutMs,
          }),
        )
        .digest("hex"),
      command: ["ag"],
      timeoutMs: options.config.contest.timeoutMs,
      artifactRoot: join(options.stateDir, "artifacts"),
      inject: { process: options.process },
    }),
  ]
  return { runners, evaluators, git: options.contestGit ?? localContestGit(options.process, options.repo) }
}

/** Compose the built-in workflow from immutable plugins and injected resources. */
export async function createDefaultYrdApp(options: DefaultYrdAppOptions): Promise<YrdCliApp> {
  validateConfig(options.config)
  const mergeCommand =
    options.config.definitions.merge?.run === undefined ? undefined : shellCommand(options.config.definitions.merge.run)
  const workspace =
    options.workspace ??
    (await createGitWorkspace({
      repo: options.repo,
      baysRoot: options.baysRoot,
      process: options.process,
      ...(options.receiverPath === undefined ? {} : { intakeRemote: options.receiverPath }),
    }))
  const bayJobs = createBayJobDefs(workspace)
  const queue = withQueue({
    steps: configuredQueueSteps(options, mergeCommand),
    batch: options.config.batch,
    defaultSteps: options.config.steps,
    requires: options.config.requires,
    resolveBaseSha: async (base) =>
      (
        await resolveGitQueueTarget({
          inject: { process: options.process },
          repo: options.repo,
          branch: baseIdentity(base),
        })
      ).sha,
  })
  const contestAdapters = defaultContestAdapters(options)
  const contests = withContests({
    ...contestAdapters,
    defaultBase: options.config.base,
  })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, queue.jobDefs, contests.jobDefs] }),
    withIssues({
      sources: options.issueSources ?? [createKmIssueSource({ process: options.process, cwd: options.repo })],
    }),
    withBays({
      jobs: bayJobs,
      defaultBase: baseIdentity(options.config.base),
      ...(options.defaultActor === undefined ? {} : { defaultActor: options.defaultActor }),
      resolveBase: async (base) => {
        const target = await resolveQueueTarget(options.process, options.repo, options.config.base, base, {
          refreshAuthority: true,
        })
        return { base: target.base, baseSha: target.sha }
      },
    }),
  )
  return createYrd(contests(queue(base)), {
    inject: {
      journal: options.journal,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
      ...(options.log === undefined ? {} : { log: options.log }),
    },
  })
}

export type YrdHost = Readonly<{
  app: YrdCliApp
  repository: YrdRepository
  config: ResolvedYrdProjectConfig
  receiver: GitPushReceiver
  process: Process
  services: YrdCliServices
  drain(): Promise<void>
  /** Releases the owned app, process, and scope. Idempotent with async disposal. */
  close(): Promise<void>
  /** Releases the host through the same lifecycle as close(). */
  [Symbol.asyncDispose](): Promise<void>
}>

function receiverTarget(app: YrdCliApp) {
  return (branch: string): ReceiverTarget | null => {
    const bay = Object.values(app.state().bays.byId).find(
      (candidate) => candidate.status === "active" && candidate.branch === branch,
    )
    if (bay?.baseSha === undefined) return null
    return { bay: bay.id, name: bay.name, base: bay.base, baseSha: bay.baseSha }
  }
}

async function intakeReceipt(app: YrdCliApp, receipt: Readonly<ReceiverReceipt>): Promise<void> {
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
  runtimeSteps: () => readonly InstalledStep[],
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
      const runtime = runtimeSteps()
      const findings = Object.values(baselines).flatMap((baseline) => {
        const configDrift = installedBaselineDrift(baseline, current)
        if (configDrift !== undefined) return [configDrift]
        const runtimeDrift = runtimeBaselineDrift(baseline, runtime)
        return runtimeDrift === undefined ? [] : [runtimeDrift]
      })
      return { findings }
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
      // remedy is `yrd queue deinit <base>`, so a wedged ref must not block it.
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

type ResidentRunnerIdentity = Readonly<{
  id: string
  host: string
  pane?: string
}>

type ResidentRunnerLease = Readonly<{ close(): Promise<void> }>

function residentRunnerIdentity(env: NodeJS.ProcessEnv): ResidentRunnerIdentity {
  const pane = [env.HERDR_PANE_ID, env.CMUX_SURFACE_ID]
    .map((value) => value?.trim())
    .find((value): value is string => value !== undefined && value !== "")
  return Object.freeze({
    id: `yrd-cli:${globalThis.process.pid}`,
    host: hostname(),
    ...(pane === undefined ? {} : { pane }),
  })
}

function residentRunnerLog(log: ConditionalLogger, identity: ResidentRunnerIdentity): ConditionalLogger {
  return log.child({
    runner: identity.id,
    host: identity.host,
    ...(identity.pane === undefined ? {} : { pane: identity.pane }),
  })
}

async function acquireResidentRunner(
  stateDir: string,
  identity: ResidentRunnerIdentity,
  log: ConditionalLogger,
): Promise<ResidentRunnerLease> {
  const runnerLog = log.child("runner")
  const released = Promise.withResolvers<void>()
  const acquired = Promise.withResolvers<void>()
  const held = createExclusive(join(stateDir, "resident-runner"), { timeoutMs: 0 }).run(async () => {
    acquired.resolve()
    await released.promise
  })
  try {
    await Promise.race([acquired.promise, held])
  } catch (error) {
    if (failureFact(error)?.code === "exclusive-busy") {
      const detail = error instanceof Error ? error.message.replace(/^yrd:\s*/u, "") : String(error)
      raiseFailure(
        "refusal",
        "resident-runner-active",
        `yrd: resident-runner-active: ${detail}. Stop the active 'yrd queue run' before starting another.`,
      )
    }
    throw error
  }
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
}

async function closeRuntime(
  app: YrdCliApp | undefined,
  process: Process,
  scope: Scope,
  resident?: ResidentRunnerLease,
  signals?: SignalObserver,
  candidatePool?: CandidatePool,
  runIndex?: RunIndexObserver,
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
        await signals?.close()
      } finally {
        try {
          await runIndex?.close()
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
  }
}

type ShutdownSignal = "SIGINT" | "SIGTERM"

/** Announce a graceful drain as ONE structured loggily record — never a bare
 * wrapped stderr paragraph, since the resident runner's stderr IS its log
 * stream. The force-stop hint and its consequences are structured FIELDS, so a
 * viewer can surface them without parsing prose. */
export function reportGracefulShutdown(log: ConditionalLogger, signal: ShutdownSignal): void {
  log.warn?.("graceful drain requested — finishing the active run before exit", {
    signal,
    mode: "drain",
    forceStop: "press Ctrl-C again to force stop",
    onForceStop: 'the active run may need `yrd queue recover`; its job settles as "job-lost"',
    recovery: "yrd queue recover",
  })
}

/** Own process signals at the run-to-exit CLI boundary, then restore native
 * signal exit semantics only after the host has drained its resources. */
function bindProcessShutdown(shutdown: () => Promise<void>, drain?: (signal: ShutdownSignal) => void): () => void {
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
    void shutdown().catch(() => undefined)
  }
  const onSigint = () => onSignal("SIGINT")
  const onSigterm = () => onSignal("SIGTERM")
  globalThis.process.on("SIGINT", onSigint)
  globalThis.process.on("SIGTERM", onSigterm)
  return finish
}

export type YrdHostOptions = Readonly<{
  cwd?: string
  env?: NodeJS.ProcessEnv
  log?: ConditionalLogger
  signalAdapter?: SignalDeliveryAdapter
}>

export async function createYrdHost(options: YrdHostOptions = {}): Promise<YrdHost> {
  return createYrdRuntimeHost(options, undefined, "active")
}

function createViewerWorkspace(): BayWorkspace {
  const refuse = () => ({
    status: "failed" as const,
    error: { code: "viewer-read-only", message: "yrd: viewer runtime cannot mutate bay workspaces" },
  })
  return Object.freeze({
    revision: "yrd-viewer-read-only-v1",
    provision: refuse,
    refresh: refuse,
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
  options: YrdHostOptions,
  resident: ResidentRunnerIdentity | undefined,
  mode: "active" | "viewer",
): Promise<YrdHost> {
  const scope = createScope("yrd-host")
  const ownsLog = options.log === undefined
  const log =
    options.log ??
    createYrdLogger(resolveYrdObservability({}, options.env ?? globalThis.process.env), (text) =>
      globalThis.process.stderr.write(text),
    )
  const env = cleanGitEnvironment(options.env ?? globalThis.process.env)
  const process = createProcess({ cwd: options.cwd, env, inject: { scope, log } })
  let app: YrdCliApp | undefined
  let residentLease: ResidentRunnerLease | undefined
  let signals: SignalObserver | undefined
  let runIndex: RunIndexObserver | undefined
  let candidatePool: CandidatePool | undefined
  try {
    const repository = await discoverYrdRepository({ cwd: options.cwd, env, process })
    if (resident !== undefined) residentLease = await acquireResidentRunner(repository.stateDir, resident, log)
    using _setupSpan = log.span?.("setup", { phase: "pre-worktree", repo: repository.repo })
    const loaded = await loadYrdConfig({ repo: repository.repo, defaultBase: repository.defaultBase })
    const receiver =
      mode === "active"
        ? await createGitPushReceiver({
            mainRepo: repository.repo,
            stateDir: repository.stateDir,
            process,
          })
        : await createViewerReceiver(repository, process)
    const journal =
      mode === "active"
        ? createJournal({ dir: repository.stateDir, inject: { log } })
        : createReadOnlyJournal({ dir: repository.stateDir, inject: { log } })
    if (mode === "active") runIndex = createRunIndexObserver({ journal, stateDir: repository.stateDir, log })
    const routes = loaded.config.notify ?? {}
    const defaultActor = env.TRIBE_NAME?.trim() || "operator"
    if (mode === "active") {
      const submitterRoute = Object.entries(routes).find(([, targets]) => targets?.includes("submitter") === true)?.[0]
      if (submitterRoute !== undefined && !SignalRecipientSchema.safeParse(defaultActor).success) {
        raiseFailure(
          "configuration",
          "signal-submitter-missing",
          `yrd: notify.${submitterRoute} targets submitter, but TRIBE_NAME is not a Tribe recipient; set TRIBE_NAME to the submitting Tribe handle (for example, @agent/2)`,
        )
      }
      if (routes["pr/needs-review"] !== undefined && !loaded.config.requires.includes("review")) {
        raiseFailure(
          "configuration",
          "signal-review-policy-missing",
          "yrd: notify.pr/needs-review requires 'requires: [review]' so the routed eligibility transition can exist",
        )
      }
      if (Object.keys(routes).length > 0) {
        signals = createSignalObserver({
          journal: runIndex?.journal ?? journal,
          stateDir: repository.stateDir,
          routes,
          reviewRequired: loaded.config.requires.includes("review"),
          adapter: options.signalAdapter ?? createTribeSignalAdapter(process),
          log,
        })
      }
    }
    if (mode === "active") {
      candidatePool = createCandidatePool({
        repo: repository.repo,
        parent: repository.baysRoot,
        git: createCandidatePoolGit(process, env),
        log,
      })
    }
    app = await createDefaultYrdApp({
      repo: repository.repo,
      stateDir: repository.stateDir,
      baysRoot: repository.baysRoot,
      ...(mode === "active" ? { receiverPath: receiver.receiverPath } : { workspace: createViewerWorkspace() }),
      journal: signals?.journal ?? runIndex?.journal ?? journal,
      process,
      config: loaded.config,
      defaultActor,
      scope,
      log,
      candidatePool,
    })
    runIndex?.start()
    signals?.start()
    const runtimeApp = app
    const resolveTarget = receiverTarget(runtimeApp)
    const receiverLog = log.child("receiver")
    const drain = async (): Promise<void> => {
      if (mode === "viewer") throw new Error("yrd: viewer runtime cannot drain the push receiver")
      using _span = receiverLog.span?.("drain")
      const result = await receiver.drain({
        resolveTarget,
        intake: (receipt) => intakeReceipt(runtimeApp, receipt),
        lockTimeoutMs: 30_000,
      })
      if (result.failed.length > 0 || result.ambiguous.length > 0) {
        throw new Error(
          `yrd: receiver inbox did not drain cleanly: ${JSON.stringify({ failed: result.failed, ambiguous: result.ambiguous })}`,
        )
      }
    }
    if (mode === "active") await drain()
    const services = Object.freeze({
      queue: queueAdministration(
        process,
        repository,
        loaded.config.base,
        () => reloadConfiguredStepDescriptors(repository),
        // The RUNTIME leg must come from the live runtime object — the steps
        // this process actually installed — never re-derived from config.
        () => runtimeApp.queue.steps(),
      ),
      recut: createGitPRRecutter({ inject: { process }, repo: repository.repo, env }),
      journal: Object.freeze({
        importOrphan: (sourcePath: string) =>
          importOrphanJournal({ dir: repository.stateDir, sourcePath, importedBy: defaultActor, log }),
      }),
    })
    let closePromise: Promise<void> | undefined
    const close = () =>
      (closePromise ??= closeRuntime(app, process, scope, residentLease, signals, candidatePool, runIndex).finally(
        () => {
          if (ownsLog) log.end()
        },
      ))
    return Object.freeze({
      app,
      repository,
      config: loaded.config,
      receiver,
      process,
      services,
      drain,
      close,
      [Symbol.asyncDispose]: close,
    })
  } catch (error) {
    await closeRuntime(app, process, scope, residentLease, signals, candidatePool, runIndex)
    if (ownsLog) log.end()
    throw error
  }
}

async function runReceiverHook(mode: "pre-receive" | "post-receive", env: NodeJS.ProcessEnv): Promise<void> {
  const gitDir = env.GIT_DIR
  if (gitDir === undefined || gitDir === "") throw new Error("yrd: receiver hook requires GIT_DIR")
  const scope = createScope("yrd-receiver-hook")
  const rootLog = createYrdLogger(resolveYrdObservability({}, env), (text) => globalThis.process.stderr.write(text))
  const log = rootLog.child({ host: "receiver-hook", mode })
  const runtimeProcess = createProcess({ cwd: globalThis.process.cwd(), env, inject: { scope, log } })
  let app: YrdCliApp | undefined
  try {
    const receiver = await loadGitPushReceiver(resolve(globalThis.process.cwd(), gitDir), runtimeProcess)
    const repository = await discoverYrdRepository({ cwd: receiver.mainRepo, env, process: runtimeProcess })
    const loaded = await loadYrdConfig({ repo: repository.repo, defaultBase: repository.defaultBase })
    app = await createDefaultYrdApp({
      repo: repository.repo,
      stateDir: repository.stateDir,
      baysRoot: repository.baysRoot,
      receiverPath: receiver.receiverPath,
      journal: createJournal({ dir: repository.stateDir, inject: { log } }),
      process: runtimeProcess,
      config: loaded.config,
      scope,
      log,
    })
    const runtimeApp = app
    await runReceiverHookFromEnvironment(mode, {
      env,
      process: runtimeProcess,
      resolveTarget: receiverTarget(runtimeApp),
      intake: (receipt) => intakeReceipt(runtimeApp, receipt),
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
  }
  if (!interactive) return io
  return withLiveRenderer(io, async (element, options) => {
    using handle = await run(element, { ...WATCH_LIVE_RENDER_OPTIONS, signal: options.signal })
    await handle.waitUntilExit()
  })
}

/** Process entrypoint shared by yrd, git-yrd, and git-bay. */
export async function runYrdProcess(
  argv: readonly string[] = process.argv,
  io: YrdCliIO = defaultIO(),
): Promise<YrdCliExitCode> {
  const env = process.env
  const invocation = resolveInvocation(argv)
  if (invocation.projection === "root" && invocation.args[0] === "receiver-hook") {
    const mode = invocation.args[1]
    if (mode !== "pre-receive" && mode !== "post-receive") {
      await diagnostic(io, invocation.name, new Error("receiver-hook requires pre-receive or post-receive"))
      return 2
    }
    try {
      await runReceiverHook(mode, env)
      return 0
    } catch (error) {
      await diagnostic(io, invocation.name, error)
      return classifyFailure(error).exitCode
    }
  }

  const wantsRootHelp = invocation.projection === "root" && invocation.args.length === 0
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
  let closePromise: Promise<void> | undefined
  const closeHost = () => (closePromise ??= host?.close() ?? Promise.resolve())
  let removeShutdownSignals: () => void = () => undefined
  try {
    return await runYrdProcessRuntime(argv, io, {
      ambientCwd: io.cwd ?? globalThis.process.cwd(),
      env,
      async load(context, options) {
        const resident = options.resident ? residentRunnerIdentity(env) : undefined
        // The resident follow-runner logs at DEBUG-by-default (see
        // residentObservability) so run/step starts and successful completions
        // reach its concise human formatter; one-shot commands keep WARN.
        const observability =
          resident === undefined ? context.observability : residentObservability(context.observability)
        // For the resident, the stderr log stream renders as scannable
        // watch-timeline rows (JSON stays in the JSONL file sink); one-shot
        // commands keep the default console format.
        const residentArtifacts: { root: string | undefined } = { root: undefined }
        const human =
          resident === undefined
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
        const runtimeLog = resident === undefined ? log : residentRunnerLog(log, resident)
        const activeHost = await createYrdRuntimeHost(
          { cwd: context.repo, env, log: runtimeLog },
          resident,
          options.viewer ? "viewer" : "active",
        )
        residentArtifacts.root = join(activeHost.repository.stateDir, "artifacts")
        host = activeHost
        const runnerLog = runtimeLog.child("runner")
        const drain = options.resident ? new AbortController() : undefined
        removeShutdownSignals = bindProcessShutdown(
          closeHost,
          drain === undefined
            ? undefined
            : (signal) => {
                drain.abort()
                reportGracefulShutdown(runnerLog, signal)
              },
        )
        return {
          app: activeHost.app,
          services: activeHost.services,
          io: {
            cwd: activeHost.repository.worktree,
            artifactRoot: join(activeHost.repository.stateDir, "artifacts"),
            ...(resident === undefined ? {} : { runner: resident.id }),
            concurrency: io.concurrency ?? activeHost.config.contest.concurrency,
            resolveRevision: (ref, cwd) =>
              io.resolveRevision === undefined
                ? resolveCommit(activeHost.process, cwd, ref)
                : io.resolveRevision(ref, cwd),
            resolveCommitMeta: (ref, cwd) =>
              io.resolveCommitMeta === undefined
                ? resolveCommitMeta(activeHost.process, cwd, ref)
                : io.resolveCommitMeta(ref, cwd),
            resolveQueueTarget: (ref, cwd) =>
              io.resolveQueueTarget === undefined
                ? resolveQueueTarget(activeHost.process, activeHost.repository.repo, activeHost.config.base, ref)
                : io.resolveQueueTarget(ref, cwd),
            ...(drain === undefined ? {} : { drainSignal: drain.signal }),
          },
        }
      },
    })
  } catch (error) {
    await diagnostic(io, invocation.name, error)
    return classifyFailure(error).exitCode
  } finally {
    try {
      await closeHost()
    } finally {
      removeShutdownSignals()
      log?.end()
    }
  }
}
