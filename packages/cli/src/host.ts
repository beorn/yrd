import { join, resolve } from "node:path"
import {
  createGitPushReceiver,
  createGitWorkspace,
  drainReceiverInbox,
  loadGitPushReceiver,
  resolveBay,
  type BaysState,
  type BayWorkspaceAdapter,
  type GitPushReceiver,
  type ReceiverReceipt,
  type ReceiverTarget,
} from "@yrd/bay"
import {
  createAgContestRunner,
  createHeldOutCommandEvaluator,
  type ContestEvaluatorAdapter,
  type ContestGitAdapter,
  type ContestRunnerAdapter,
} from "@yrd/contest"
import {
  createYrd,
  createYrdEventStore,
  from,
  withEffects,
  type EffectOutcome,
  type YrdEventStore,
} from "@yrd/core"
import {
  configuredWaitingCommandStep,
  deployCommandStep,
  gitCheckStep,
  gitMergeStep,
  withBatch,
  withDefaultSteps,
  withLine,
  withMerge,
  withStep,
  type CommandEvidence,
  type GitCheckEvidence,
  type IntegratedShape,
  type StepExecution,
  type StepRunner,
  type SubmissionShape,
} from "@yrd/line"
import { createKmTaskSource, withTasks, type TaskSource } from "@yrd/task"
import { withBays } from "@yrd/bay"
import { withContests } from "@yrd/contest"
import type { ResolvedYrdProjectConfig, YrdStepConfig } from "./config.ts"
import { loadYrdConfig } from "./config.ts"
import { classifyFailure, diagnostic, resolveInvocation } from "./invocation.ts"
import { discoverYrdRepository, type YrdRepository } from "./repository.ts"
import { runYrd } from "./run.ts"
import { classifyStateLayout } from "./state-layout.ts"
import type { YrdCliApp, YrdCliExitCode, YrdCliIO, YrdCliLineAdministration } from "./types.ts"

const BUILTIN_STEPS = new Set(["check", "review", "merge", "deploy"])

export type DefaultYrdAppOptions = Readonly<{
  repo: string
  stateDir: string
  baysRoot: string
  store: YrdEventStore
  config: ResolvedYrdProjectConfig
  receiverPath?: string
  workspace?: BayWorkspaceAdapter
  taskSources?: readonly TaskSource[]
  contestRunners?: readonly ContestRunnerAdapter[]
  contestEvaluators?: readonly ContestEvaluatorAdapter[]
  contestGit?: ContestGitAdapter
}>

function validateConfig(config: ResolvedYrdProjectConfig): void {
  for (const name of Object.keys(config.steps)) {
    if (!BUILTIN_STEPS.has(name)) {
      throw new Error(`yrd: step '${name}' requires a custom withStep() composition`)
    }
  }
  for (const name of config.line.steps) {
    if (!BUILTIN_STEPS.has(name)) throw new Error(`yrd: step '${name}' requires a custom withStep() composition`)
    if ((name === "review" || name === "deploy") && config.steps[name]?.run === undefined) {
      throw new Error(`yrd: default line step '${name}' requires steps.${name}.run`)
    }
  }
  if (config.steps.merge?.runner === "waiting") throw new Error("yrd: merge cannot use a waiting runner")
  for (const evaluator of config.contest.evaluators) {
    if (config.steps[evaluator]?.run === undefined) {
      throw new Error(`yrd: contest evaluator '${evaluator}' requires a configured step command`)
    }
  }
}

function unavailableStep<Shape extends SubmissionShape>(name: string): StepRunner<Shape, CommandEvidence> {
  return (): EffectOutcome<CommandEvidence> => ({
    status: "failed",
    error: { code: `${name}-not-configured`, message: `yrd: line step '${name}' is not configured` },
  })
}

function gitCandidateStep(repo: string, stateDir: string, name: string, config?: YrdStepConfig) {
  if (config?.run === undefined) return unavailableStep<SubmissionShape>(name)
  return gitCheckStep({
    repo,
    command: config.run,
    artifactRoot: join(stateDir, "artifacts"),
    purpose: name,
    runner: config.runner,
    ...(config.environment === undefined ? {} : { environment: config.environment }),
  })
}

function deployStep(repo: string, stateDir: string, config?: YrdStepConfig): StepRunner<IntegratedShape, CommandEvidence> {
  if (config?.run === undefined) return unavailableStep<IntegratedShape>("deploy")
  const options = {
    command: config.run,
    cwd: repo,
    purpose: "deploy",
    artifactRoot: join(stateDir, "artifacts"),
    variables: (input: StepExecution<IntegratedShape>) => ({
      YRD_INTEGRATED_SHA: input.shape.integration.commit,
      ...(config.environment === undefined ? {} : { YRD_ENVIRONMENT: config.environment }),
    }),
  }
  return config.runner === "waiting"
    ? configuredWaitingCommandStep(options)
    : deployCommandStep({
        command: options.command,
        cwd: options.cwd,
        artifactRoot: options.artifactRoot,
        variables: options.variables,
      })
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
}

function localContestGit(repo: string): ContestGitAdapter {
  return {
    resolveCommit: async (ref) => await resolveCommit(repo, ref),
  }
}

async function resolveCommit(repo: string, ref: string): Promise<string | undefined> {
  const child = Bun.spawn(["git", "-C", repo, "rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: repo,
    env: cleanEnvironment(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
  return exitCode === 0 ? stdout.trim().toLowerCase() : undefined
}

/** The built-in workflow is an ordinary with* composition. Consumers needing
 * different transitions can compose their own app and pass it to runYrd(). */
export function createDefaultYrdApp(options: DefaultYrdAppOptions): YrdCliApp {
  validateConfig(options.config)
  const workspace =
    options.workspace ??
    createGitWorkspace({
      repo: options.repo,
      baysRoot: options.baysRoot,
      ...(options.receiverPath === undefined ? {} : { intakeRemote: options.receiverPath }),
    })
  const taskSources = options.taskSources ?? [createKmTaskSource({ cwd: options.repo })]
  const check = gitCandidateStep(options.repo, options.stateDir, "check", options.config.steps.check)
  const review = gitCandidateStep(options.repo, options.stateDir, "review", options.config.steps.review)
  const merge = gitMergeStep({ repo: options.repo, command: options.config.steps.merge?.run })
  const deploy = deployStep(options.repo, options.stateDir, options.config.steps.deploy)

  const lineApp = from(createYrd({ store: options.store }))
    .then(withEffects())
    .then(withTasks({ sources: taskSources }))
    .then(withBays({ workspace, defaultBase: options.config.line.base }))
    .then(withLine())
    .then(withBatch(options.config.line.batch))
    .then(withStep("check", check))
    .then(withStep("review", review))
    .then(withMerge(merge))
    .then(withStep("deploy", deploy, { needsIntegration: true }))
    .then(withDefaultSteps(options.config.line.steps))
    .build()

  let app: YrdCliApp | undefined
  const evaluators =
    options.contestEvaluators ??
    options.config.contest.evaluators.map((id) => {
      const step = options.config.steps[id]!
      return createHeldOutCommandEvaluator({
        id,
        command: ["sh", "-c", step.run!],
        timeoutMs: options.config.contest.timeoutMs,
        artifactRoot: join(options.stateDir, "artifacts"),
        async resolveBayPath(bay) {
          if (app === undefined) throw new Error("yrd: contest app is not initialized")
          const record = resolveBay((await app.state()).bays, bay)
          if (record?.path === undefined) throw new Error(`yrd: contest bay '${bay}' has no workspace path`)
          return record.path
        },
      })
    })
  const runners =
    options.contestRunners ??
    [
      createAgContestRunner({
        command: ["ag"],
        timeoutMs: options.config.contest.timeoutMs,
        artifactRoot: join(options.stateDir, "artifacts"),
      }),
    ]
  app = withContests({
    runners,
    evaluators,
    git: options.contestGit ?? localContestGit(options.repo),
  })(lineApp) as YrdCliApp
  return app
}

export type YrdHost = Readonly<{
  app: YrdCliApp
  repository: YrdRepository
  config: ResolvedYrdProjectConfig
  receiver: GitPushReceiver
  drain(): Promise<void>
  close(): Promise<void>
}>

function receiverTarget(app: YrdCliApp) {
  return async (branch: string): Promise<ReceiverTarget | null> => {
    const bays = ((await app.state()) as { bays: BaysState }).bays
    const bay = Object.values(bays.bays).find(
      (candidate) => candidate.status === "active" && candidate.branch === branch,
    )
    if (bay?.baseSha === undefined) return null
    return { bay: bay.id, name: bay.name, base: bay.base, baseSha: bay.baseSha }
  }
}

async function intakeReceipt(app: YrdCliApp, receipt: Readonly<ReceiverReceipt>): Promise<void> {
  await app.command(app.commands.bay.intake, { ...receipt.intake, receipt: receipt.id })
}

function attachLineAdministration(app: YrdCliApp, repository: YrdRepository, config: ResolvedYrdProjectConfig): void {
  const administration: Required<Pick<YrdCliLineAdministration, "provision" | "deprovision">> = {
    async provision(base = config.line.base) {
      const sha = await resolveCommit(repository.repo, `refs/heads/${base}`)
      if (sha === undefined) throw new Error(`yrd: line base '${base}' does not resolve`)
      return { base, baseSha: sha, steps: config.line.steps, persistentResources: false }
    },
    async deprovision(base = config.line.base) {
      const sha = await resolveCommit(repository.repo, `refs/heads/${base}`)
      if (sha === undefined) throw new Error(`yrd: line base '${base}' does not resolve`)
      return { base, baseSha: sha, released: [], persistentResources: false }
    },
  }
  Object.assign(app.line, administration)
}

async function assertStateLayout(repository: YrdRepository): Promise<void> {
  const layout = await classifyStateLayout({
    gitDir: repository.gitDir,
    legacyLocations: repository.legacyLocations,
  })
  if (layout.decision.action !== "refuse") return
  const detail = layout.findings.map((finding) => finding.message).join("\n")
  throw new Error(`${layout.decision.diagnostic}${detail === "" ? "" : `\n${detail}`}`)
}

async function composeFilesystemApp(
  repository: YrdRepository,
  config: ResolvedYrdProjectConfig,
  receiver: GitPushReceiver,
) {
  const store = await createYrdEventStore({ dir: repository.stateDir })
  try {
    const app = createDefaultYrdApp({
      repo: repository.repo,
      stateDir: repository.stateDir,
      baysRoot: repository.baysRoot,
      receiverPath: receiver.receiverPath,
      store,
      config,
    })
    attachLineAdministration(app, repository, config)
    return app
  } catch (error) {
    await store.close()
    throw error
  }
}

export async function createYrdHost(options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<YrdHost> {
  const repository = await discoverYrdRepository(options)
  await assertStateLayout(repository)
  const loaded = await loadYrdConfig({ repo: repository.repo, defaultBase: repository.defaultBase })
  const receiver = await createGitPushReceiver({ mainRepo: repository.repo, stateDir: repository.stateDir })
  const app = await composeFilesystemApp(repository, loaded.config, receiver)
  const resolveTarget = receiverTarget(app)
  const drain = async (): Promise<void> => {
    const result = await drainReceiverInbox(receiver, {
      resolveTarget,
      intake: async (receipt) => await intakeReceipt(app, receipt),
      lockTimeoutMs: 30_000,
    })
    if (result.failed.length > 0 || result.ambiguous.length > 0) {
      throw new Error(
        `yrd: receiver inbox did not drain cleanly: ${JSON.stringify({ failed: result.failed, ambiguous: result.ambiguous })}`,
      )
    }
  }
  try {
    await drain()
  } catch (error) {
    await app.close()
    throw error
  }
  return { app, repository, config: loaded.config, receiver, drain, close: () => app.close() }
}

async function runReceiverHook(mode: "pre-receive" | "post-receive", env: NodeJS.ProcessEnv): Promise<void> {
  const gitDir = env.GIT_DIR
  if (gitDir === undefined || gitDir === "") throw new Error("yrd: receiver hook requires GIT_DIR")
  const receiver = await loadGitPushReceiver(resolve(process.cwd(), gitDir))
  const repository = await discoverYrdRepository({ cwd: receiver.mainRepo, env })
  await assertStateLayout(repository)
  const loaded = await loadYrdConfig({ repo: repository.repo, defaultBase: repository.defaultBase })
  const app = await composeFilesystemApp(repository, loaded.config, receiver)
  try {
    const { runReceiverHookFromEnvironment } = await import("@yrd/bay")
    await runReceiverHookFromEnvironment(mode, { env, resolveTarget: receiverTarget(app) })
  } finally {
    await app.close()
  }
}

function defaultIO(): YrdCliIO {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
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
      diagnostic(io, invocation.name, new Error("receiver-hook requires pre-receive or post-receive"))
      return 2
    }
    try {
      await runReceiverHook(mode, process.env)
      return 0
    } catch (error) {
      diagnostic(io, invocation.name, error)
      return 1
    }
  }

  let host: YrdHost | undefined
  try {
    host = await createYrdHost({ cwd: io.cwd })
    return await runYrd(host.app, argv, {
      ...io,
      concurrency: io.concurrency ?? host.config.contest.concurrency,
    })
  } catch (error) {
    diagnostic(io, invocation.name, error)
    return classifyFailure(error)
  } finally {
    await host?.close()
  }
}
