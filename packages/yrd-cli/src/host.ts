import { createHash } from "node:crypto"
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
  gitCheckStep,
  gitMergeStep,
  inspectGitQueueTarget,
  resolveGitQueueTarget,
  withQueue,
  withMerge,
  withStep,
  type CommandEvidence,
  type IntegratedShape,
  type PRShape,
  type StepDef,
  type StepExecution,
  type StepRunner,
} from "@yrd/queue"
import { createExclusive, createJournal } from "@yrd/persistence"
import { createProcess, shellCommand, type Process } from "@yrd/process"
import { createKmIssueSource, withIssues, type IssueSource } from "@yrd/issue"
import type { ConditionalLogger } from "loggily"
import { run } from "silvery/runtime"
import { cleanGitEnvironment } from "./git-environment.ts"
import { loadYrdConfig, type ResolvedYrdProjectConfig, type YrdStepConfig } from "./config.ts"
import { classifyFailure, resolveInvocation } from "./invocation.ts"
import { withLiveRenderer } from "./live-renderer.ts"
import { createYrdLogger, resolveYrdObservability } from "./observability.ts"
import { diagnostic } from "./output.tsx"
import { discoverYrdRepository, type YrdRepository } from "./repository.ts"
import { runYrdHelp, runYrdProcessRuntime } from "./run.ts"
import { queueStepRevision, type ToolchainFingerprint } from "./host-revision.ts"
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
  scope?: Scope
  log?: ConditionalLogger
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

/** Effective wall-clock bound for a step: declared, else the host default. */
export function stepTimeoutMs(config: YrdStepConfig): number {
  return config.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
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
): RuntimeStep {
  return eraseStep(
    withStep(
      name,
      gitCheckStep({
        inject: { process },
        repo,
        command: shellCommand(stepCommand(name, config)),
        checkoutParent,
        artifactRoot: join(stateDir, "artifacts"),
        purpose: name,
        runner: config.runner,
        classification: config.classification ?? "carrier",
        timeoutMs: stepTimeoutMs(config),
        ...(config.environment === undefined ? {} : { environment: config.environment }),
      }),
      {
        revision: queueStepRevision({
          repo,
          stateDir,
          name,
          config,
          timeoutMs: stepTimeoutMs(config),
          toolchain: hostToolchainFingerprint(),
          checkoutParent,
        }),
        classification: config.classification ?? "carrier",
      },
    ),
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
    artifactRoot: join(stateDir, "artifacts"),
    variables: (input: StepExecution<IntegratedShape>) => ({
      YRD_INTEGRATED_SHA: input.shape.integration.commit,
      ...(config.environment === undefined ? {} : { YRD_ENVIRONMENT: config.environment }),
    }),
  }
  return config.runner === "waiting" ? configuredWaitingCommandStep(options) : configuredCommandStep(options)
}

function configuredQueueSteps(
  options: DefaultYrdAppOptions,
  mergeCommand: readonly string[] | undefined,
): readonly RuntimeStep[] {
  let integrated = false
  return options.config.steps.map((name) => {
    const config = options.config.definitions[name] ?? { runner: "local" as const }
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
              }),
          {
            revision: queueStepRevision({
              repo: options.repo,
              stateDir: options.stateDir,
              name,
              config,
              timeoutMs: stepTimeoutMs(config),
              toolchain: hostToolchainFingerprint(),
              resolvedCommand: mergeCommand,
            }),
          },
        ),
      )
    }
    if (!integrated) {
      return candidateStep(options.process, options.repo, options.stateDir, options.baysRoot, name, config)
    }
    return eraseStep(
      withStep(name, integratedRunner(options.process, options.repo, options.stateDir, name, config), {
        revision: queueStepRevision({
          repo: options.repo,
          stateDir: options.stateDir,
          name,
          config,
          timeoutMs: stepTimeoutMs(config),
          toolchain: hostToolchainFingerprint(),
        }),
        needsIntegration: true,
      }),
    )
  })
}

async function resolveCommit(process: Pick<Process, "run">, repo: string, ref: string): Promise<string | undefined> {
  const candidates = ref.startsWith("refs/") ? [ref] : [ref, `refs/remotes/origin/${ref}`]
  for (const candidate of candidates) {
    const result = await process.run({
      argv: ["git", "-C", repo, "rev-parse", "--verify", "--end-of-options", `${candidate}^{commit}`],
      cwd: repo,
      env: cleanGitEnvironment(globalThis.process.env),
    })
    if (result.exitCode === 0) return result.stdout.trim().toLowerCase()
  }
  return undefined
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
  config: ResolvedYrdProjectConfig,
): YrdCliQueueAdministration {
  const inspect = async (base = config.base) => {
    const baseSha = await resolveCommit(process, repository.repo, base)
    if (baseSha === undefined) throw new Error(`yrd: queue base '${base}' does not resolve`)
    return { base, baseSha }
  }
  return Object.freeze({
    async provision(base) {
      return { ...(await inspect(base)), steps: config.steps, persistentResources: false }
    },
    async deprovision(base) {
      return { ...(await inspect(base)), released: [], persistentResources: false }
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
    executor: identity.id,
    host: identity.host,
    ...(identity.pane === undefined ? {} : { pane: identity.pane }),
  })
}

async function acquireResidentRunner(
  stateDir: string,
  identity: ResidentRunnerIdentity,
  log: ConditionalLogger,
): Promise<ResidentRunnerLease> {
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
        `yrd: resident-runner-active: ${detail}. Stop the active 'yrd queue run --watch' before starting another.`,
      )
    }
    throw error
  }
  log.info?.("Resident runner lease acquired", { executor: identity.id, stateDir })

  let closePromise: Promise<void> | undefined
  return Object.freeze({
    close: () =>
      (closePromise ??= (async () => {
        released.resolve()
        await held
        log.info?.("Resident runner lease released", { executor: identity.id, stateDir })
      })()),
  })
}

async function closeRuntime(
  app: YrdCliApp | undefined,
  process: Process,
  scope: Scope,
  resident?: ResidentRunnerLease,
): Promise<void> {
  try {
    await app?.close()
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

type ShutdownSignal = "SIGINT" | "SIGTERM"

const GracefulShutdownMessage =
  "Shutting down gracefully; please wait for the current job to\n" +
  "finish. Press Ctrl-C again to force stop (the active run may\n" +
  'require `yrd queue recover` and job will have status "job-lost").\n'

function clearTerminalSignalEcho(io: YrdCliIO): boolean {
  if (io.stderrIsTTY !== true) return false
  try {
    return io.clearStderrLine?.() === true
  } catch {
    return false
  }
}

function reportGracefulShutdown(io: YrdCliIO, log: ConditionalLogger, signal: ShutdownSignal): void {
  if (io.stderrIsTTY === true) {
    io.stderr(`${clearTerminalSignalEcho(io) ? "" : "\n"}${GracefulShutdownMessage}`)
  }
  log.warn?.("Graceful drain requested", {
    signal,
    mode: "drain",
    nextSignal: "force",
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
  const onSignal = (signal: ShutdownSignal): void => {
    if (drain !== undefined && !draining) {
      draining = true
      drain(signal)
      return
    }
    if (hardSignal !== undefined) {
      forward(signal)
      return
    }
    hardSignal = signal
    void shutdown().then(
      () => forward(signal),
      () => forward(signal),
    )
  }
  const onSigint = () => onSignal("SIGINT")
  const onSigterm = () => onSignal("SIGTERM")
  globalThis.process.on("SIGINT", onSigint)
  globalThis.process.on("SIGTERM", onSigterm)
  return remove
}

export async function createYrdHost(
  options: { cwd?: string; env?: NodeJS.ProcessEnv; log?: ConditionalLogger } = {},
): Promise<YrdHost> {
  return createYrdRuntimeHost(options)
}

async function createYrdRuntimeHost(
  options: { cwd?: string; env?: NodeJS.ProcessEnv; log?: ConditionalLogger },
  resident?: ResidentRunnerIdentity,
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
  try {
    const repository = await discoverYrdRepository({ cwd: options.cwd, env, process })
    if (resident !== undefined) residentLease = await acquireResidentRunner(repository.stateDir, resident, log)
    using _setupSpan = log.span?.("setup", { phase: "pre-worktree", repo: repository.repo })
    const loaded = await loadYrdConfig({ repo: repository.repo, defaultBase: repository.defaultBase })
    const receiver = await createGitPushReceiver({
      mainRepo: repository.repo,
      stateDir: repository.stateDir,
      process,
    })
    app = await createDefaultYrdApp({
      repo: repository.repo,
      stateDir: repository.stateDir,
      baysRoot: repository.baysRoot,
      receiverPath: receiver.receiverPath,
      journal: createJournal({ dir: repository.stateDir, inject: { log } }),
      process,
      config: loaded.config,
      scope,
      log,
    })
    const runtimeApp = app
    const resolveTarget = receiverTarget(runtimeApp)
    const receiverLog = log.child("receiver")
    const drain = async (): Promise<void> => {
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
    await drain()
    const services = Object.freeze({ queue: queueAdministration(process, repository, loaded.config) })
    let closePromise: Promise<void> | undefined
    const close = () =>
      (closePromise ??= closeRuntime(app, process, scope, residentLease).finally(() => {
        if (ownsLog) log.end()
      }))
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
    await closeRuntime(app, process, scope, residentLease)
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
    cwd: process.cwd(),
  }
  if (!interactive) return io
  return withLiveRenderer(io, async (element, options) => {
    using handle = await run(element, { signal: options.signal, mode: "fullscreen", mouse: false })
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
        log = createYrdLogger(context.observability, (text) => io.stderr(text))
        const resident = options.resident ? residentRunnerIdentity(env) : undefined
        const runtimeLog = resident === undefined ? log : residentRunnerLog(log, resident)
        const activeHost = await createYrdRuntimeHost({ cwd: context.repo, env, log: runtimeLog }, resident)
        host = activeHost
        const runnerLog = runtimeLog.child("runner")
        const drain = options.resident ? new AbortController() : undefined
        removeShutdownSignals = bindProcessShutdown(
          closeHost,
          drain === undefined
            ? undefined
            : (signal) => {
                drain.abort()
                reportGracefulShutdown(io, runnerLog, signal)
              },
        )
        return {
          app: activeHost.app,
          services: activeHost.services,
          io: {
            cwd: activeHost.repository.worktree,
            ...(resident === undefined ? {} : { runner: resident.id }),
            concurrency: io.concurrency ?? activeHost.config.contest.concurrency,
            resolveRevision: (ref, cwd) =>
              io.resolveRevision === undefined
                ? resolveCommit(activeHost.process, cwd, ref)
                : io.resolveRevision(ref, cwd),
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
