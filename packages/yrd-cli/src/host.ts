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
  configuredMergeStep,
  configuredWaitingCommandStep,
  gitCheckStep,
  gitMergeStep,
  inspectGitLineTarget,
  resolveGitLineTarget,
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
import { createProcess, shellCommand, type Process } from "@yrd/process"
import { createKmTaskSource, withTasks, type TaskSource } from "@yrd/task"
import { createLogger, type ConditionalLogger } from "loggily"
import { run } from "silvery/runtime"
import { resolveBaySubmitArgv } from "./bay-selection.ts"
import { loadYrdConfig, type ResolvedYrdProjectConfig, type YrdStepConfig } from "./config.ts"
import { classifyFailure, resolveInvocation } from "./invocation.ts"
import { withLiveRenderer } from "./live-renderer.ts"
import { diagnostic } from "./output.tsx"
import { discoverYrdRepository, type YrdRepository } from "./repository.ts"
import { runYrd, runYrdHelp } from "./run.ts"
import type { YrdCliApp, YrdCliExitCode, YrdCliIO, YrdCliLineAdministration, YrdCliServices } from "./types.ts"

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
  const mergeIndex = config.line.steps.indexOf("merge")
  if (mergeIndex >= 0 && config.steps.merge?.run === undefined) {
    for (const name of config.line.steps.slice(mergeIndex + 1)) {
      if (RawGitPushPattern.test(config.steps[name]?.run ?? "")) {
        raiseFailure(
          "configuration",
          "native-merge-post-push",
          `yrd: post-merge step '${name}' cannot push Git refs after the native merge step`,
        )
      }
    }
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
  resolvedCommand?: readonly string[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        implementation:
          name === "merge" && resolvedCommand === undefined
            ? "yrd-native-merge-v3"
            : checkoutParent === undefined
              ? "yrd-line-command-v2"
              : "yrd-line-command-v3",
        repo,
        stateDir,
        ...(checkoutParent === undefined ? {} : { checkoutParent }),
        name,
        run: config.run,
        resolvedCommand,
        runner: config.runner,
        environment: config.environment,
        classification: config.classification ?? "carrier",
        timeoutMs: stepTimeoutMs(config),
        toolchain: {
          bun: Bun.version,
          node: process.versions.node,
          platform: process.platform,
          arch: process.arch,
        },
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

/**
 * The ONE default wall-clock bound for a line step's local command (21012 S1).
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
        revision: lineStepRevision(repo, stateDir, name, config, checkoutParent),
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

function configuredLineSteps(
  options: DefaultYrdAppOptions,
  mergeCommand: readonly string[] | undefined,
): readonly RuntimeStep[] {
  let integrated = false
  return options.config.line.steps.map((name) => {
    const config = options.config.steps[name] ?? { runner: "local" as const }
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
            revision: lineStepRevision(options.repo, options.stateDir, name, config, undefined, mergeCommand),
          },
        ),
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
  const candidates = ref.startsWith("refs/") ? [ref] : [ref, `refs/remotes/origin/${ref}`]
  for (const candidate of candidates) {
    const result = await process.run({
      argv: ["git", "-C", repo, "rev-parse", "--verify", "--end-of-options", `${candidate}^{commit}`],
      cwd: repo,
      env: cleanEnvironment(globalThis.process.env),
    })
    if (result.exitCode === 0) return result.stdout.trim().toLowerCase()
  }
  return undefined
}

function lineBranch(ref: string): string {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length)
  if (ref.startsWith("refs/remotes/origin/")) return ref.slice("refs/remotes/origin/".length)
  if (ref.startsWith("origin/")) return ref.slice("origin/".length)
  return ref
}

async function resolveLineTarget(
  process: Pick<Process, "run">,
  repo: string,
  configuredBase: string,
  requestedBase: string,
  options: Readonly<{ requireAligned?: boolean }> = {},
): Promise<Readonly<{ base: string; sha: string }>> {
  const configured = lineBranch(configuredBase)
  const requested = lineBranch(requestedBase)
  const base = requested === configured ? configured : requested
  if (requestedBase !== base && (await resolveCommit(process, repo, requestedBase)) === undefined) {
    throw new Error(`yrd: line base '${requestedBase}' does not resolve`)
  }
  const inspect = options.requireAligned === true ? resolveGitLineTarget : inspectGitLineTarget
  const target = await inspect({ inject: { process }, repo, branch: base })
  if (target.diverged && options.requireAligned === true) {
    raiseFailure(
      "refusal",
      "line-target-diverged",
      `yrd: line '${base}' local ${target.localSha?.slice(0, 12)} differs from authoritative ` +
        `${target.remote}/${base} ${target.remoteSha?.slice(0, 12)}; align the local branch before admission`,
    )
  }
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
    options.config.steps.merge?.run === undefined ? undefined : shellCommand(options.config.steps.merge.run)
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
    steps: configuredLineSteps(options, mergeCommand),
    batch: options.config.line.batch,
    defaultSteps: options.config.line.steps,
    requires: options.config.line.requires,
    resolveBaseSha: async (base) =>
      (
        await resolveGitLineTarget({
          inject: { process: options.process },
          repo: options.repo,
          branch: lineBranch(base),
        })
      ).sha,
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
    withBays({
      jobs: bayJobs,
      defaultBase: lineBranch(options.config.line.base),
      resolveBase: async (base) => {
        const target = await resolveLineTarget(options.process, options.repo, options.config.line.base, base, {
          requireAligned: true,
        })
        return { base: target.base, baseSha: target.sha }
      },
    }),
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
  await app.dispatch(
    app.commands.bay.intake,
    { ...receipt.intake, receipt: receipt.id },
    { key: `receiver:${receipt.id}` },
  )
}

function lineAdministration(
  process: Pick<Process, "run">,
  repository: YrdRepository,
  config: ResolvedYrdProjectConfig,
): YrdCliLineAdministration {
  const inspect = async (base = config.line.base) => {
    const baseSha = await resolveCommit(process, repository.repo, base)
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
  const interactive = process.stdin.isTTY && process.stdout.isTTY
  const io: YrdCliIO = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
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
  const invocation = resolveInvocation(argv)
  const namespace = invocation.args[0]
  const namespaceOnly =
    invocation.projection === "root" &&
    invocation.args.length === 1 &&
    namespace !== undefined &&
    ["bay", "line", "task", "contest"].includes(namespace)
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
    namespaceOnly ||
    invocation.args.some(
      (argument) => argument === "--help" || argument === "-h" || argument === "--version" || argument === "-V",
    )
  ) {
    return runYrdHelp(namespaceOnly ? [...argv, "--help"] : argv, io)
  }

  let host: YrdHost | undefined
  try {
    const activeHost = await createYrdHost({ cwd: io.cwd })
    host = activeHost
    const selectedArgv = await resolveBaySubmitArgv(invocation, {
      worktree: activeHost.repository.worktree,
      process: activeHost.process,
      env: cleanEnvironment(globalThis.process.env),
    })
    return await runYrd(
      activeHost.app,
      selectedArgv ?? argv,
      {
        ...io,
        concurrency: io.concurrency ?? activeHost.config.contest.concurrency,
        resolveRevision: io.resolveRevision ?? ((ref, cwd) => resolveCommit(activeHost.process, cwd, ref)),
        resolveLineTarget:
          io.resolveLineTarget ??
          ((ref) =>
            resolveLineTarget(activeHost.process, activeHost.repository.repo, activeHost.config.line.base, ref)),
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
