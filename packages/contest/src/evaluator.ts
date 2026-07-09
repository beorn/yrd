import { createHash } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { EffectOutcome } from "@yrd/core"
import type {
  ContestArtifact,
  ContestEvaluatorAdapter,
  ContestEvaluatorInput,
  EffectAdapterContext,
  EvaluatorResult,
} from "./types.ts"

export type EvaluatorProcessRequest = Readonly<{
  kind: "evaluator" | "git"
  argv: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
}>

export type EvaluatorProcessResult = Readonly<{
  exitCode: number
  stdout: string
  stderr: string
}>

export type EvaluatorProcessRunner = (request: EvaluatorProcessRequest) => Promise<EvaluatorProcessResult>

export type HeldOutCommandEvaluatorOptions = Readonly<{
  id: string
  /** Executable and static arguments. Yrd never interpolates task or Git data into this array. */
  command: readonly string[]
  resolveBayPath(
    bay: string,
    input: ContestEvaluatorInput,
    context: EffectAdapterContext,
  ): string | Promise<string>
  process?: EvaluatorProcessRunner
  now?: () => number
  timeoutMs?: number
  artifactRoot?:
    | string
    | ((input: ContestEvaluatorInput, context: EffectAdapterContext) => string | Promise<string>)
  environment?: (input: ContestEvaluatorInput, context: EffectAdapterContext) => NodeJS.ProcessEnv
}>

type Failure = Readonly<{ code: string; message: string }>
type Checked<Value> = Readonly<{ ok: true; value: Value }> | Readonly<{ ok: false; error: Failure }>

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u

const defaultProcess: EvaluatorProcessRunner = async (request) => {
  const child = Bun.spawn([...request.argv], {
    cwd: request.cwd,
    env: request.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    signal: request.signal,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, stdout, stderr }
}

function failed(code: string, message: string): EffectOutcome<EvaluatorResult> {
  return { status: "failed", error: { code, message } }
}

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

function normalizeSha(value: string): string | undefined {
  const normalized = value.trim().toLowerCase()
  return SHA.test(normalized) ? normalized : undefined
}

function validatePin(input: ContestEvaluatorInput): Failure | undefined {
  if (normalizeSha(input.pin.commit) === undefined) {
    return { code: "pin-invalid", message: `Attempt pin '${input.pin.commit}' is not a full Git commit id` }
  }
  if (!input.pin.ref.startsWith("refs/") || input.pin.ref.includes("\0")) {
    return { code: "pin-ref-invalid", message: `Attempt pin ref '${input.pin.ref}' is not a full Git ref` }
  }
  if (input.pin.bay.trim() === "") return { code: "pin-bay-invalid", message: "Attempt pin has no Bay id" }
  return undefined
}

function executionEnvironment(
  id: string,
  input: ContestEvaluatorInput,
  context: EffectAdapterContext,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("GIT_") || key.startsWith("YRD_")) continue
    env[key] = value
  }
  for (const [key, value] of Object.entries(extra)) {
    if (key.startsWith("GIT_") || key.startsWith("YRD_")) continue
    env[key] = value
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
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
    YRD_EFFECT: context.id,
    YRD_EFFECT_ATTEMPT: String(context.attempt),
  }
}

async function execute(
  runner: EvaluatorProcessRunner,
  request: EvaluatorProcessRequest,
  timeoutMs?: number,
): Promise<Checked<EvaluatorProcessResult>> {
  const controller = timeoutMs === undefined ? undefined : new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const running = runner(controller === undefined ? request : { ...request, signal: controller.signal })
    const value = timeoutMs === undefined
      ? await running
      : await Promise.race([
          running,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              controller!.abort()
              reject(new Error(`timed out after ${timeoutMs}ms`))
            }, timeoutMs)
          }),
        ])
    if (!Number.isSafeInteger(value.exitCode)) {
      return { ok: false, error: { code: `${request.kind}-invalid-result`, message: "process returned an invalid exit code" } }
    }
    return { ok: true, value }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: controller?.signal.aborted === true ? `${request.kind}-timeout` : `${request.kind}-spawn-failed`,
        message: error instanceof Error ? error.message : String(error),
      },
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function git(
  runner: EvaluatorProcessRunner,
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): Promise<Checked<EvaluatorProcessResult>> {
  return await execute(runner, { kind: "git", argv: ["git", ...args], cwd, env })
}

function output(result: EvaluatorProcessResult): string {
  return result.stderr.trim() || result.stdout.trim() || `Git exited ${result.exitCode}`
}

function gitFailure(result: Checked<EvaluatorProcessResult>, code: string, action: string): Failure | undefined {
  if (!result.ok) return { code, message: `${action}: ${result.error.message}` }
  if (result.value.exitCode !== 0) return { code, message: `${action}: ${output(result.value)}` }
  return undefined
}

function digest(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`
}

function pathKey(input: ContestEvaluatorInput, context: EffectAdapterContext, evaluator: string): string {
  return createHash("sha256")
    .update(`${input.contest}\0${input.attempt}\0${evaluator}\0${context.id}`)
    .digest("hex")
    .slice(0, 24)
}

async function artifact(kind: string, path: string, content: string, mediaType: string): Promise<ContestArtifact> {
  await writeFile(path, content, { flag: "wx" })
  return { kind, uri: pathToFileURL(path).href, digest: digest(content), mediaType }
}

async function defaultArtifactRoot(
  runner: EvaluatorProcessRunner,
  bayPath: string,
  env: NodeJS.ProcessEnv,
): Promise<Checked<string>> {
  const common = await git(runner, bayPath, env, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  const failure = gitFailure(common, "git-common-dir-invalid", "Could not resolve the Bay Git common directory")
  if (failure !== undefined) return { ok: false, error: failure }
  const path = common.ok ? common.value.stdout.trim() : ""
  if (path === "") {
    return { ok: false, error: { code: "git-common-dir-invalid", message: "Git returned an empty common directory" } }
  }
  return { ok: true, value: resolve(bayPath, path, "yrd", "artifacts") }
}

async function writeEvidence(
  root: string,
  evaluator: string,
  input: ContestEvaluatorInput,
  context: EffectAdapterContext,
  checkout: string,
  processResult: EvaluatorProcessResult,
  durationMs: number,
): Promise<Checked<EvaluatorResult>> {
  const verdict = processResult.exitCode === 0 ? "passed" : "failed"
  const summary = `${evaluator} exited ${processResult.exitCode}`
  const dir = join(root, "contests", pathKey(input, context, evaluator), `attempt-${context.attempt}`)
  try {
    await mkdir(dir, { recursive: true })
    const stdout = await artifact("stdout", join(dir, "stdout.log"), processResult.stdout, "text/plain")
    const stderr = await artifact("stderr", join(dir, "stderr.log"), processResult.stderr, "text/plain")
    const manifest = {
      schema: "yrd.contest.command-evaluator.v1",
      evaluator: { id: evaluator, authority: "held-out" },
      contest: input.contest,
      attempt: input.attempt,
      effect: context,
      task: input.task.ref,
      competitor: input.competitor,
      pin: input.pin,
      checkout: { path: checkout, commit: input.pin.commit.toLowerCase(), detached: true },
      process: { exitCode: processResult.exitCode, durationMs },
      result: { verdict, summary },
      artifacts: [stdout, stderr],
    }
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
    const manifestArtifact = await artifact(
      "evaluator-manifest",
      join(dir, "manifest.json"),
      manifestText,
      "application/json",
    )
    return {
      ok: true,
      value: { verdict, summary, artifacts: [stdout, stderr, manifestArtifact] },
    }
  } catch (error) {
    return {
      ok: false,
      error: { code: "artifact-write-failed", message: error instanceof Error ? error.message : String(error) },
    }
  }
}

async function resolveArtifactRoot(
  configured: HeldOutCommandEvaluatorOptions["artifactRoot"],
  runner: EvaluatorProcessRunner,
  bayPath: string,
  env: NodeJS.ProcessEnv,
  input: ContestEvaluatorInput,
  context: EffectAdapterContext,
): Promise<Checked<string>> {
  if (configured === undefined) return await defaultArtifactRoot(runner, bayPath, env)
  try {
    const value = typeof configured === "function" ? await configured(input, context) : configured
    return { ok: true, value: resolve(nonEmpty(value, "held-out evaluator artifact root")) }
  } catch (error) {
    return {
      ok: false,
      error: { code: "artifact-root-invalid", message: error instanceof Error ? error.message : String(error) },
    }
  }
}

/**
 * Run a held-out command in a temporary detached worktree materialized from the
 * immutable attempt pin. Nonzero exits are durable failed verdicts; Git,
 * process, cleanup, and evidence failures fail the effect itself.
 */
export function createHeldOutCommandEvaluator(options: HeldOutCommandEvaluatorOptions): ContestEvaluatorAdapter {
  const id = nonEmpty(options.id, "held-out evaluator id")
  const command = commandArgv(options.command)
  const runner = options.process ?? defaultProcess
  const now = options.now ?? Date.now
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error("yrd: held-out evaluator timeoutMs must be a positive integer")
  }

  return {
    id,
    authority: "held-out",
    async evaluate(input, context): Promise<EffectOutcome<EvaluatorResult>> {
      const invalidPin = validatePin(input)
      if (invalidPin !== undefined) return failed(invalidPin.code, invalidPin.message)

      let bayPath: string
      try {
        bayPath = await realpath(await options.resolveBayPath(input.pin.bay, input, context))
      } catch (error) {
        return failed("bay-path-invalid", error instanceof Error ? error.message : String(error))
      }
      let extraEnv: NodeJS.ProcessEnv
      try {
        extraEnv = options.environment?.(input, context) ?? {}
      } catch (error) {
        return failed("evaluator-environment-invalid", error instanceof Error ? error.message : String(error))
      }
      const env = executionEnvironment(id, input, context, extraEnv)

      const pinRef = await git(runner, bayPath, env, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${input.pin.ref}^{commit}`,
      ])
      const refFailure = gitFailure(pinRef, "pin-ref-invalid", `Could not resolve attempt ref '${input.pin.ref}'`)
      if (refFailure !== undefined) return failed(refFailure.code, refFailure.message)
      const refSha = normalizeSha(pinRef.ok ? pinRef.value.stdout : "")
      if (refSha === undefined) return failed("pin-ref-invalid", "Git returned an invalid commit for the attempt ref")
      if (refSha !== input.pin.commit.toLowerCase()) {
        return failed(
          "pin-ref-mismatch",
          `Attempt ref '${input.pin.ref}' resolves to ${refSha}, not pinned commit ${input.pin.commit}`,
        )
      }

      const artifacts = await resolveArtifactRoot(options.artifactRoot, runner, bayPath, env, input, context)
      if (!artifacts.ok) return failed(artifacts.error.code, artifacts.error.message)

      let temporaryRoot: string
      try {
        temporaryRoot = await mkdtemp(join(tmpdir(), "yrd-evaluator-"))
      } catch (error) {
        return failed("pin-checkout-create-failed", error instanceof Error ? error.message : String(error))
      }
      const checkout = join(temporaryRoot, "checkout")
      let worktreeAdded = false
      let processResult: EvaluatorProcessResult | undefined
      let durationMs = 0
      let operationFailure: Failure | undefined
      let cleanupFailure: Failure | undefined

      try {
        const add = await git(runner, bayPath, env, ["worktree", "add", "--detach", checkout, input.pin.commit])
        const addFailure = gitFailure(add, "pin-checkout-create-failed", "Could not materialize the pinned checkout")
        if (addFailure !== undefined) {
          operationFailure = addFailure
        } else {
          worktreeAdded = true
          const head = await git(runner, checkout, env, ["rev-parse", "--verify", "HEAD^{commit}"])
          const headFailure = gitFailure(head, "pin-checkout-invalid", "Could not resolve detached checkout HEAD")
          if (headFailure !== undefined) {
            operationFailure = headFailure
          } else {
            const headSha = normalizeSha(head.ok ? head.value.stdout : "")
            if (headSha === undefined) {
              operationFailure = { code: "pin-checkout-invalid", message: "Git returned an invalid checkout commit" }
            } else if (headSha !== input.pin.commit.toLowerCase()) {
              operationFailure = {
                code: "pin-checkout-mismatch",
                message: `Detached checkout resolves to ${headSha}, not pinned commit ${input.pin.commit}`,
              }
            }
          }

          if (operationFailure === undefined) {
            const detached = await execute(runner, {
              kind: "git",
              argv: ["git", "symbolic-ref", "--quiet", "HEAD"],
              cwd: checkout,
              env,
            })
            if (!detached.ok) {
              operationFailure = { code: "pin-checkout-invalid", message: detached.error.message }
            } else if (detached.value.exitCode !== 1) {
              operationFailure = {
                code: "pin-checkout-attached",
                message: detached.value.exitCode === 0
                  ? "Pinned evaluator checkout is attached to a mutable branch"
                  : `Could not verify detached checkout: ${output(detached.value)}`,
              }
            }
          }

          if (operationFailure === undefined) {
            const clean = await git(runner, checkout, env, ["status", "--porcelain=v1", "--untracked-files=all"])
            const cleanFailure = gitFailure(clean, "pin-checkout-invalid", "Could not inspect the detached checkout")
            if (cleanFailure !== undefined) operationFailure = cleanFailure
            else if (clean.ok && clean.value.stdout.trim() !== "") {
              operationFailure = { code: "pin-checkout-dirty", message: "Pinned evaluator checkout is not clean" }
            }
          }

          if (operationFailure === undefined) {
            const startedAt = now()
            const evaluated = await execute(
              runner,
              { kind: "evaluator", argv: command, cwd: checkout, env },
              options.timeoutMs,
            )
            durationMs = Math.max(0, now() - startedAt)
            if (!evaluated.ok) operationFailure = evaluated.error
            else processResult = evaluated.value
          }
        }
      } finally {
        if (worktreeAdded) {
          const removed = await git(runner, bayPath, env, ["worktree", "remove", "--force", checkout])
          const removeFailure = gitFailure(removed, "pin-checkout-cleanup-failed", "Could not remove evaluator checkout")
          if (removeFailure !== undefined) cleanupFailure = removeFailure
        }
        try {
          await rm(temporaryRoot, { recursive: true, force: true })
        } catch (error) {
          cleanupFailure = {
            code: "pin-checkout-cleanup-failed",
            message: error instanceof Error ? error.message : String(error),
          }
        }
      }

      if (operationFailure !== undefined) return failed(operationFailure.code, operationFailure.message)
      if (cleanupFailure !== undefined) return failed(cleanupFailure.code, cleanupFailure.message)
      if (processResult === undefined) return failed("evaluator-missing-result", "Evaluator completed without a process result")

      const evidence = await writeEvidence(artifacts.value, id, input, context, checkout, processResult, durationMs)
      if (!evidence.ok) return failed(evidence.error.code, evidence.error.message)
      return { status: "passed", output: evidence.value }
    },
  }
}
