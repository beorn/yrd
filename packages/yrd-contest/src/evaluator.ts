import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseJobLaunch, type JobContext, type JobResult } from "@yrd/job"
import type { Process, ProcessResult } from "@yrd/process"
import type { ContestEvaluatorDef, ContestEvaluatorInput, EvaluatorResult } from "./types.ts"
import {
  FULL_SHA,
  accepted,
  attempt,
  captureArtifacts,
  createGit,
  errorMessage,
  executionEnvironment,
  failed,
  jsonArtifact,
  rejected,
  runProcess,
  sha256,
  type Checked,
  type Failure,
  type Git,
} from "./execution.ts"

export type HeldOutCommandEvaluatorOptions = Readonly<{
  id: string
  revision: string
  /** Executable and static arguments. Yrd never interpolates task or Git data into this array. */
  command: readonly string[]
  resolveBayPath(bay: string, input: ContestEvaluatorInput, context: JobContext): string | Promise<string>
  timeoutMs?: number
  runner?: "local" | "waiting"
  targetEnvironment?: string
  checkoutParent?: string | ((input: ContestEvaluatorInput, context: JobContext) => string | Promise<string>)
  artifactRoot?: string | ((input: ContestEvaluatorInput, context: JobContext) => string | Promise<string>)
  environment?: (input: ContestEvaluatorInput, context: JobContext) => NodeJS.ProcessEnv
  inject: Readonly<{ process: Pick<Process, "run">; env?: NodeJS.ProcessEnv }>
}>

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`yrd: ${label} must be a non-empty string`)
  return value.trim()
}

function commandArgv(command: readonly string[]): readonly string[] {
  if (command.length === 0 || command.some((part) => typeof part !== "string" || part.trim() === "")) {
    throw new Error("yrd: held-out evaluator command must contain only non-empty argv values")
  }
  return [...command]
}

function validatePin(input: ContestEvaluatorInput): Failure | undefined {
  if (!FULL_SHA.test(input.pin.commit.trim().toLowerCase())) {
    return { code: "pin-invalid", message: `Attempt pin '${input.pin.commit}' is not a full Git commit id` }
  }
  if (!input.pin.ref.startsWith("refs/") || input.pin.ref.includes("\0")) {
    return { code: "pin-ref-invalid", message: `Attempt pin ref '${input.pin.ref}' is not a full Git ref` }
  }
  if (input.pin.bay.trim() === "") return { code: "pin-bay-invalid", message: "Attempt pin has no Bay id" }
  return undefined
}

function evaluatorEnvironment(
  base: NodeJS.ProcessEnv,
  id: string,
  targetEnvironment: string | undefined,
  input: ContestEvaluatorInput,
  context: JobContext,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return executionEnvironment(base, extra, {
    YRD_EVALUATOR: id,
    YRD_CONTEST: input.contest,
    YRD_ATTEMPT: input.attempt,
    YRD_TASK_SOURCE: input.task.ref.source,
    YRD_TASK_ID: input.task.ref.id,
    YRD_COMPETITOR: input.competitor.id,
    YRD_BAY: input.pin.bay,
    YRD_BRANCH: input.pin.branch,
    YRD_PIN_COMMIT: input.pin.commit.toLowerCase(),
    YRD_PIN_REF: input.pin.ref,
    ...(input.pin.baseSha === undefined ? {} : { YRD_BASE_SHA: input.pin.baseSha }),
    ...(targetEnvironment === undefined ? {} : { YRD_ENVIRONMENT: targetEnvironment }),
    YRD_JOB: context.id,
    YRD_JOB_ATTEMPT: String(context.attempt),
  })
}

function pathKey(input: ContestEvaluatorInput, context: JobContext, evaluator: string): string {
  return sha256(`${input.contest}\0${input.attempt}\0${evaluator}\0${context.id}`).slice(0, 24)
}

async function writeEvidence(
  root: string,
  evaluator: string,
  input: ContestEvaluatorInput,
  context: JobContext,
  checkout: string,
  processResult: ProcessResult,
): Promise<Checked<EvaluatorResult>> {
  const verdict = processResult.exitCode === 0 ? "passed" : "failed"
  const summary = `${evaluator} exited ${processResult.exitCode}`
  const dir = join(root, "contests", pathKey(input, context, evaluator), `attempt-${context.attempt}`)
  const streams = await captureArtifacts(dir, [
    { kind: "stdout", file: "stdout.log", content: processResult.stdout, mediaType: "text/plain" },
    { kind: "stderr", file: "stderr.log", content: processResult.stderr, mediaType: "text/plain" },
  ])
  if (!streams.ok) return streams
  const manifest = await captureArtifacts(dir, [
    jsonArtifact("evaluator-manifest", "manifest.json", {
      schema: "yrd.contest.command-evaluator.v1",
      evaluator: { id: evaluator, authority: "held-out" },
      contest: input.contest,
      attempt: input.attempt,
      job: context,
      task: input.task.ref,
      competitor: input.competitor,
      pin: input.pin,
      checkout: { path: checkout, commit: input.pin.commit.toLowerCase(), detached: true },
      process: { exitCode: processResult.exitCode, durationMs: processResult.durationMs },
      result: { verdict, summary },
      artifacts: streams.value,
    }),
  ])
  if (!manifest.ok) return manifest
  return accepted({ verdict, summary, artifacts: [...streams.value, ...manifest.value] })
}

async function writeWaitingEvidence(
  root: string,
  evaluator: string,
  input: ContestEvaluatorInput,
  context: JobContext,
  checkout: string,
  processResult: ProcessResult,
): Promise<Checked<JobResult<EvaluatorResult>>> {
  if (processResult.exitCode !== 0) {
    const detail = (processResult.stderr || processResult.stdout).trim()
    return rejected(
      "evaluator-launcher-failed",
      `${evaluator} launcher exited ${processResult.exitCode}${detail === "" ? "" : `: ${detail}`}`,
    )
  }
  const parsed = await attempt("evaluator-launcher-invalid", () => parseJobLaunch(processResult.stdout))
  if (!parsed.ok) return parsed
  const dir = join(root, "contests", pathKey(input, context, evaluator), `attempt-${context.attempt}`)
  const artifacts = await captureArtifacts(dir, [
    { kind: "stdout", file: "stdout.log", content: processResult.stdout, mediaType: "text/plain" },
    { kind: "stderr", file: "stderr.log", content: processResult.stderr, mediaType: "text/plain" },
    jsonArtifact("evaluator-launch-manifest", "launch.json", {
      schema: "yrd.contest.command-evaluator-launch.v1",
      evaluator: { id: evaluator, authority: "held-out" },
      contest: input.contest,
      attempt: input.attempt,
      task: input.task.ref,
      competitor: input.competitor,
      pin: input.pin,
      checkout: { path: checkout, commit: input.pin.commit.toLowerCase(), detached: true },
      process: { exitCode: processResult.exitCode, durationMs: processResult.durationMs },
      launch: parsed.value,
    }),
  ])
  if (!artifacts.ok) return artifacts
  return accepted({
    status: "waiting",
    ...parsed.value,
    artifacts: [...artifacts.value, ...(parsed.value.artifacts ?? [])],
    checkpoint: {
      evaluator,
      contest: input.contest,
      attempt: input.attempt,
      pin: input.pin,
    },
  })
}

async function resolveArtifactRoot(
  configured: HeldOutCommandEvaluatorOptions["artifactRoot"],
  git: Git,
  bayPath: string,
  input: ContestEvaluatorInput,
  context: JobContext,
): Promise<Checked<string>> {
  if (configured === undefined) {
    const common = await git.commonDir(bayPath, "Could not resolve the Bay Git common directory")
    return common.ok ? accepted(join(common.value, "yrd", "artifacts")) : common
  }
  return attempt("artifact-root-invalid", async () => {
    const value = typeof configured === "function" ? await configured(input, context) : configured
    return resolve(nonEmpty(value, "held-out evaluator artifact root"))
  })
}

async function resolveCheckoutParent(
  configured: HeldOutCommandEvaluatorOptions["checkoutParent"],
  input: ContestEvaluatorInput,
  context: JobContext,
): Promise<Checked<string>> {
  return attempt("pin-checkout-create-failed", async () => {
    const value = typeof configured === "function" ? await configured(input, context) : (configured ?? tmpdir())
    const parent = nonEmpty(value, "held-out evaluator checkout parent")
    await mkdir(parent, { recursive: true })
    return realpath(parent)
  })
}

async function verifyAttemptPin(git: Git, bayPath: string, input: ContestEvaluatorInput): Promise<Failure | undefined> {
  const ref = await git.commit(
    bayPath,
    input.pin.ref,
    "pin-ref-invalid",
    `Could not resolve attempt ref '${input.pin.ref}'`,
    true,
  )
  if (!ref.ok) return ref.error
  return ref.value === input.pin.commit.toLowerCase()
    ? undefined
    : {
        code: "pin-ref-mismatch",
        message: `Attempt ref '${input.pin.ref}' resolves to ${ref.value}, not pinned commit ${input.pin.commit}`,
      }
}

async function evaluateCheckout(
  git: Git,
  process: Pick<Process, "run">,
  command: readonly string[],
  checkout: string,
  env: NodeJS.ProcessEnv,
  commit: string,
  timeoutMs: number | undefined,
  signal: AbortSignal,
): Promise<Checked<ProcessResult>> {
  const head = await git.commit(checkout, "HEAD", "pin-checkout-invalid", "Could not resolve detached checkout HEAD")
  if (!head.ok) return head
  if (head.value !== commit.toLowerCase()) {
    return rejected("pin-checkout-mismatch", `Detached checkout resolves to ${head.value}, not pinned commit ${commit}`)
  }
  const detached = await git.run(checkout, ["symbolic-ref", "--quiet", "HEAD"])
  if (!detached.ok) return rejected("pin-checkout-invalid", detached.error.message)
  if (detached.value.exitCode !== 1) {
    const attached = detached.value.exitCode === 0
    return rejected(
      attached ? "pin-checkout-attached" : "pin-checkout-invalid",
      attached
        ? "Pinned evaluator checkout is attached to a mutable branch"
        : `Could not verify detached checkout: ${git.output(detached.value)}`,
    )
  }
  const clean = await git.clean(checkout, "pin-checkout-invalid", "Could not inspect the detached checkout")
  if (!clean.ok) return clean
  if (!clean.value) {
    return rejected("pin-checkout-dirty", "Pinned evaluator checkout is not clean")
  }
  const result = await runProcess(
    process,
    { argv: command, cwd: checkout, env, timeoutMs, signal },
    "evaluator-spawn-failed",
  )
  if (!result.ok) return result
  return result.value.timedOut ? rejected("evaluator-timeout", `Evaluator timed out after ${timeoutMs}ms`) : result
}

/**
 * Run a held-out command in a temporary detached worktree materialized from the
 * immutable attempt pin. Nonzero exits are durable failed verdicts; Git,
 * process, cleanup, and evidence failures fail the job itself.
 */
export function createHeldOutCommandEvaluator(options: HeldOutCommandEvaluatorOptions): ContestEvaluatorDef {
  const id = nonEmpty(options.id, "held-out evaluator id")
  const revision = nonEmpty(options.revision, "held-out evaluator revision")
  const command = commandArgv(options.command)
  const process = options.inject.process
  const baseEnv = options.inject.env ?? globalThis.process.env
  const runner = options.runner ?? "local"
  if (runner !== "local" && runner !== "waiting")
    throw new Error("yrd: held-out evaluator runner must be local or waiting")
  const targetEnvironment =
    options.targetEnvironment === undefined
      ? undefined
      : nonEmpty(options.targetEnvironment, "held-out evaluator target environment")
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error("yrd: held-out evaluator timeoutMs must be a positive integer")
  }

  return {
    id,
    revision,
    authority: "held-out",
    async evaluate(input, context) {
      const invalidPin = validatePin(input)
      if (invalidPin !== undefined) return failed(invalidPin.code, invalidPin.message)
      const bay = await attempt("bay-path-invalid", async () =>
        realpath(await options.resolveBayPath(input.pin.bay, input, context)),
      )
      if (!bay.ok) return failed(bay.error.code, bay.error.message)
      const extraEnv = await attempt("evaluator-environment-invalid", () => options.environment?.(input, context) ?? {})
      if (!extraEnv.ok) return failed(extraEnv.error.code, extraEnv.error.message)
      const bayPath = bay.value
      const env = evaluatorEnvironment(baseEnv, id, targetEnvironment, input, context, extraEnv.value)
      const git = createGit(process, env, context.signal)
      const pinFailure = await verifyAttemptPin(git, bayPath, input)
      if (pinFailure !== undefined) return failed(pinFailure.code, pinFailure.message)
      const artifacts = await resolveArtifactRoot(options.artifactRoot, git, bayPath, input, context)
      if (!artifacts.ok) return failed(artifacts.error.code, artifacts.error.message)
      const parent = await resolveCheckoutParent(options.checkoutParent, input, context)
      if (!parent.ok) return failed(parent.error.code, parent.error.message)
      const temporary = await attempt("pin-checkout-create-failed", () => mkdtemp(join(parent.value, "yrd-evaluator-")))
      if (!temporary.ok) return failed(temporary.error.code, temporary.error.message)
      const temporaryRoot = temporary.value
      const checkout = join(temporaryRoot, "checkout")
      let worktreeAdded = false
      let cleanupFailure: Failure | undefined
      let operation: JobResult<EvaluatorResult> = failed("evaluator-missing-result", "Evaluator produced no evidence")
      try {
        const add = await git.run(bayPath, ["worktree", "add", "--detach", checkout, input.pin.commit])
        const addFailure = git.failure(add, "pin-checkout-create-failed", "Could not materialize the pinned checkout")
        if (addFailure !== undefined) {
          operation = failed(addFailure.code, addFailure.message)
        } else {
          worktreeAdded = true
          const evaluated = await evaluateCheckout(
            git,
            process,
            command,
            checkout,
            env,
            input.pin.commit,
            options.timeoutMs,
            context.signal,
          )
          if (!evaluated.ok) {
            operation = failed(evaluated.error.code, evaluated.error.message)
          } else if (runner === "waiting") {
            const waiting = await writeWaitingEvidence(artifacts.value, id, input, context, checkout, evaluated.value)
            operation = waiting.ok ? waiting.value : failed(waiting.error.code, waiting.error.message)
          } else {
            const evidence = await writeEvidence(artifacts.value, id, input, context, checkout, evaluated.value)
            operation = evidence.ok
              ? { status: "passed", output: evidence.value }
              : failed(evidence.error.code, evidence.error.message)
          }
        }
      } finally {
        if (worktreeAdded) {
          const removed = await git.run(bayPath, ["worktree", "remove", "--force", checkout])
          const removeFailure = git.failure(
            removed,
            "pin-checkout-cleanup-failed",
            "Could not remove evaluator checkout",
          )
          if (removeFailure !== undefined) cleanupFailure = removeFailure
        }
        try {
          await rm(temporaryRoot, { recursive: true, force: true })
        } catch (error) {
          cleanupFailure ??= { code: "pin-checkout-cleanup-failed", message: errorMessage(error) }
        }
      }
      if (operation.status === "failed") return operation
      if (cleanupFailure !== undefined) {
        const manifest =
          operation.status === "passed"
            ? operation.output.artifacts.find((artifact) => artifact.kind === "evaluator-manifest")
            : undefined
        const runnerUrl = operation.status === "waiting" ? operation.url : undefined
        const suffix =
          manifest !== undefined
            ? `. Artifacts: ${manifest.uri}`
            : runnerUrl === undefined
              ? ""
              : `. Runner: ${runnerUrl}`
        return failed(cleanupFailure.code, `${cleanupFailure.message}${suffix}`)
      }
      return operation
    },
  }
}
