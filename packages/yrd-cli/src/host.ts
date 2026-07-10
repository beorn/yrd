import { createHash } from "node:crypto"
import { join, relative, resolve, sep } from "node:path"
import { createScope, type Scope } from "@silvery/scope"
import {
  createBayJobDefs,
  createGitPushReceiver,
  createGitWorkspace,
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
import { createYrd, createYrdDef, pipe, raiseFailure, type Journal } from "@yrd/core"
import { withJobs } from "@yrd/job"
import {
  configuredCommandStep,
  configuredWaitingCommandStep,
  gitCheckStep,
  gitMergeStep,
  withLine,
  withMerge,
  withStep,
  type CommandEvidence,
  type IntegratedShape,
  type PRShape,
  type StepDef,
  type StepExecution,
  type StepRunner,
} from "@yrd/line"
import { createJournal } from "@yrd/persistence"
import { createProcess, type Process } from "@yrd/process"
import { createKmTaskSource, withTasks, type TaskSource } from "@yrd/task"
import { createLogger, type ConditionalLogger } from "loggily"
import { loadYrdConfig, type ResolvedYrdProjectConfig, type YrdStepConfig } from "./config.ts"
import { classifyFailure, resolveInvocation } from "./invocation.ts"
import { diagnostic } from "./output.tsx"
import { discoverYrdRepository, type YrdRepository } from "./repository.ts"
import { runYrd, runYrdHelp } from "./run.ts"
import type { YrdCliApp, YrdCliExitCode, YrdCliIO, YrdCliLineAdministration, YrdCliServices } from "./types.ts"

type RuntimeStep = StepDef<PRShape, PRShape>

export type DefaultYrdAppOptions = Readonly<{
  repo: string
  stateDir: string
  baysRoot: string
  journal: Journal<unknown>
  process: Pick<Process, "run">
  config: ResolvedYrdProjectConfig
  receiverPath?: string
  workspace?: BayWorkspace
  taskSources?: readonly TaskSource[]
  contestRunners?: readonly ContestRunnerDef[]
  contestEvaluators?: readonly ContestEvaluatorDef[]
  contestGit?: ContestGit
  scope?: Scope
  log?: ConditionalLogger
}>

function validateConfig(config: ResolvedYrdProjectConfig): void {
  for (const name of config.line.steps) {
    if (name !== "merge" && config.steps[name]?.run === undefined) {
      raiseFailure(
        "configuration",
        "step-command-missing",
        `yrd: default line step '${name}' requires steps.${name}.run`,
      )
    }
  }
  if (config.steps.merge?.runner === "waiting") {
    raiseFailure("configuration", "merge-runner-invalid", "yrd: merge cannot use a waiting runner")
  }
  if (config.steps.merge?.run !== undefined) {
    raiseFailure(
      "configuration",
      "merge-command-unsupported",
      "yrd: steps.merge.run is not supported by the default Git line; compose withMerge() for a custom merge",
    )
  }
  for (const evaluator of config.contest.evaluators) {
    if (config.steps[evaluator]?.run === undefined) {
      raiseFailure(
        "configuration",
        "evaluator-command-missing",
        `yrd: contest evaluator '${evaluator}' requires a configured step command`,
      )
    }
  }
}

function lineStepRevision(
  repo: string,
  stateDir: string,
  name: string,
  config: YrdStepConfig,
  checkoutParent?: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        implementation: checkoutParent === undefined ? "yrd-line-command-v2" : "yrd-line-command-v3",
        repo,
        stateDir,
        ...(checkoutParent === undefined ? {} : { checkoutParent }),
        name,
        run: config.run,
        runner: config.runner,
        environment: config.environment,
      }),
    )
    .digest("hex")
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

function stepCommand(name: string, config: YrdStepConfig): string {
  if (config.run === undefined) throw new Error(`yrd: line step '${name}' has no command`)
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
        command: stepCommand(name, config),
        checkoutParent,
        artifactRoot: join(stateDir, "artifacts"),
        purpose: name,
        runner: config.runner,
        ...(config.environment === undefined ? {} : { environment: config.environment }),
      }),
      { revision: lineStepRevision(repo, stateDir, name, config, checkoutParent) },
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
    command: stepCommand(name, config),
    cwd: repo,
    purpose: name,
    artifactRoot: join(stateDir, "artifacts"),
    variables: (input: StepExecution<IntegratedShape>) => ({
      YRD_INTEGRATED_SHA: input.shape.integration.commit,
      ...(config.environment === undefined ? {} : { YRD_ENVIRONMENT: config.environment }),
    }),
  }
  return config.runner === "waiting" ? configuredWaitingCommandStep(options) : configuredCommandStep(options)
}

function configuredLineSteps(options: DefaultYrdAppOptions): readonly RuntimeStep[] {
  let integrated = false
  return options.config.line.steps.map((name) => {
    const config = options.config.steps[name] ?? { runner: "local" as const }
    if (name === "merge") {
      integrated = true
      return eraseStep(
        withMerge(gitMergeStep({ inject: { process: options.process }, repo: options.repo }), {
          revision: lineStepRevision(options.repo, options.stateDir, name, config),
        }),
      )
    }
    if (!integrated) {
      return candidateStep(options.process, options.repo, options.stateDir, options.baysRoot, name, config)
    }
    return eraseStep(
      withStep(name, integratedRunner(options.process, options.repo, options.stateDir, name, config), {
        revision: lineStepRevision(options.repo, options.stateDir, name, config),
        needsIntegration: true,
      }),
    )
  })
}

function cleanEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) => value !== undefined && !key.startsWith("GIT_")),
  )
}

async function resolveCommit(process: Pick<Process, "run">, repo: string, ref: string): Promise<string | undefined> {
  const result = await process.run({
    argv: ["git", "-C", repo, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    cwd: repo,
    env: cleanEnvironment(globalThis.process.env),
  })
  return result.exitCode === 0 ? result.stdout.trim().toLowerCase() : undefined
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
      const step = options.config.steps[id]
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
        command: ["sh", "-c", stepCommand(id, step)],
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
  const workspace =
    options.workspace ??
    (await createGitWorkspace({
      repo: options.repo,
      baysRoot: options.baysRoot,
      process: options.process,
      ...(options.receiverPath === undefined ? {} : { intakeRemote: options.receiverPath }),
    }))
  const bayJobs = createBayJobDefs(workspace)
  const line = withLine({
    steps: configuredLineSteps(options),
    batch: options.config.line.batch,
    defaultSteps: options.config.line.steps,
  })
  const contestAdapters = defaultContestAdapters(options)
  const contests = withContests({
    ...contestAdapters,
    defaultBase: options.config.line.base,
  })
  const base = pipe(
    createYrdDef(),
    withJobs({ definitions: [bayJobs, line.jobDefs, contests.jobDefs] }),
    withTasks({
      sources: options.taskSources ?? [createKmTaskSource({ process: options.process, cwd: options.repo })],
    }),
    withBays({ jobs: bayJobs, defaultBase: options.config.line.base }),
  )
  return createYrd(contests(line(base)), {
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
  close(): Promise<void>
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
  await app.command(
    app.commands.bay.intake,
    { ...receipt.intake, receipt: receipt.id },
    { commandId: `receiver:${receipt.id}` },
  )
}

function lineAdministration(
  process: Pick<Process, "run">,
  repository: YrdRepository,
  config: ResolvedYrdProjectConfig,
): YrdCliLineAdministration {
  const inspect = async (base = config.line.base) => {
    const baseSha = await resolveCommit(process, repository.repo, `refs/heads/${base}`)
    if (baseSha === undefined) throw new Error(`yrd: line base '${base}' does not resolve`)
    return { base, baseSha }
  }
  return Object.freeze({
    async provision(base) {
      return { ...(await inspect(base)), steps: config.line.steps, persistentResources: false }
    },
    async deprovision(base) {
      return { ...(await inspect(base)), released: [], persistentResources: false }
    },
  })
}

async function closeRuntime(app: YrdCliApp | undefined, process: Process, scope: Scope): Promise<void> {
  try {
    await app?.close()
  } finally {
    try {
      await process.close()
    } finally {
      await scope.disposeAsync()
    }
  }
}

export async function createYrdHost(options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<YrdHost> {
  const scope = createScope("yrd-host")
  const log = createLogger("yrd")
  const process = createProcess({ cwd: options.cwd, env: options.env, inject: { scope, log } })
  let app: YrdCliApp | undefined
  try {
    const repository = await discoverYrdRepository({ ...options, process })
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
    const services = Object.freeze({ line: lineAdministration(process, repository, loaded.config) })
    let closePromise: Promise<void> | undefined
    const close = () => (closePromise ??= closeRuntime(app, process, scope))
    return Object.freeze({
      app,
      repository,
      config: loaded.config,
      receiver,
      process,
      services,
      drain,
      close,
    })
  } catch (error) {
    await closeRuntime(app, process, scope)
    throw error
  }
}

async function runReceiverHook(mode: "pre-receive" | "post-receive", env: NodeJS.ProcessEnv): Promise<void> {
  const gitDir = env.GIT_DIR
  if (gitDir === undefined || gitDir === "") throw new Error("yrd: receiver hook requires GIT_DIR")
  const scope = createScope("yrd-receiver-hook")
  const log = createLogger("yrd").child({ host: "receiver-hook", mode })
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
  }
}

function defaultIO(): YrdCliIO {
  const color = process.env.NO_COLOR === undefined && (process.stdout.isTTY || process.env.FORCE_COLOR !== undefined)
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    color,
    columns: process.stdout.columns,
    cwd: process.cwd(),
  }
}

/** Process entrypoint shared by yrd, git-yrd, and git-bay. */
export async function runYrdProcess(
  argv: readonly string[] = process.argv,
  io: YrdCliIO = defaultIO(),
): Promise<YrdCliExitCode> {
  const invocation = resolveInvocation(argv)
  if (invocation.projection === "root" && invocation.args[0] === "receiver-hook") {
    const mode = invocation.args[1]
    if (mode !== "pre-receive" && mode !== "post-receive") {
      await diagnostic(io, invocation.name, new Error("receiver-hook requires pre-receive or post-receive"))
      return 2
    }
    try {
      await runReceiverHook(mode, process.env)
      return 0
    } catch (error) {
      await diagnostic(io, invocation.name, error)
      return classifyFailure(error).exitCode
    }
  }

  if (
    invocation.args.length === 0 ||
    invocation.args.some(
      (argument) => argument === "--help" || argument === "-h" || argument === "--version" || argument === "-V",
    )
  ) {
    return runYrdHelp(argv, io)
  }

  let host: YrdHost | undefined
  try {
    const activeHost = await createYrdHost({ cwd: io.cwd })
    host = activeHost
    return await runYrd(
      activeHost.app,
      argv,
      {
        ...io,
        concurrency: io.concurrency ?? activeHost.config.contest.concurrency,
        resolveRevision: io.resolveRevision ?? ((ref, cwd) => resolveCommit(activeHost.process, cwd, ref)),
      },
      activeHost.services,
    )
  } catch (error) {
    await diagnostic(io, invocation.name, error)
    return classifyFailure(error).exitCode
  } finally {
    await host?.close()
  }
}
