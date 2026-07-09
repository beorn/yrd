import { createHash } from "node:crypto"
import { mkdir, realpath, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { pathToFileURL } from "node:url"
import type { EffectOutcome } from "@yrd/core"
import type {
  AttemptRunOutput,
  ContestArtifact,
  ContestRunnerAdapter,
  ContestRunnerInput,
  EffectAdapterContext,
  JsonObject,
  JsonValue,
  TokenCounts,
  UsdCost,
} from "./types.ts"

export type AgProcessRequest = Readonly<{
  kind: "agent" | "git"
  argv: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
}>

export type AgProcessResult = Readonly<{
  exitCode: number
  stdout: string
  stderr: string
}>

export type AgProcessRunner = (request: AgProcessRequest) => Promise<AgProcessResult>

export type AgContestLaunch = Readonly<{
  provider: string
  account?: string
  tier?: string
  effort?: string
  instructions?: string
  yolo?: boolean
  args: readonly string[]
}>

export type AgContestRunnerOptions = Readonly<{
  /** Executable plus any static prefix, for example `["bun", "/repo/ag/.../cli.ts"]`. */
  command?: readonly string[]
  harness?: string
  process?: AgProcessRunner
  now?: () => number
  /** Hard bound for a local agent process. Remote adapters should return waiting instead. */
  timeoutMs?: number
  artifactRoot?: string | ((input: ContestRunnerInput, context: EffectAdapterContext) => string | Promise<string>)
  environment?: (input: ContestRunnerInput, context: EffectAdapterContext) => NodeJS.ProcessEnv
  /** Replaces only provider launch policy; task prompt and evidence handling remain mandatory. */
  resolveLaunch?: (input: ContestRunnerInput) => AgContestLaunch
}>

type Failure = Readonly<{ code: string; message: string }>
type Checked<Result> = { ok: true; value: Result } | { ok: false; error: Failure }
type Metric =
  | Readonly<{ kind: "reported"; value: number; source: string }>
  | Readonly<{ kind: "missing"; reason: string }>

type MetricsEvidence = Readonly<{
  schema: "yrd.ag.metrics.v1"
  provider: string
  tokens: Readonly<{
    input: Metric
    output: Metric
    cachedInput: Metric
    cacheWrite: Metric
    reasoning: Metric
  }>
  cost: UsdCost
  projection: TokenCounts
}>

type RawArtifacts = Readonly<{
  artifacts: readonly ContestArtifact[]
  manifestPath: string
  metrics: MetricsEvidence
}>

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u
const REF_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u
const TOKEN_FIELDS = {
  input: ["input_tokens", "inputTokens"],
  output: ["output_tokens", "outputTokens"],
  cachedInput: ["cached_input_tokens", "cache_read_input_tokens", "cacheReadTokens"],
  cacheWrite: ["cache_creation_input_tokens", "cache_write_input_tokens", "cacheWriteTokens"],
  reasoning: ["reasoning_output_tokens", "reasoning_tokens", "reasoningTokens"],
} as const

const defaultProcess: AgProcessRunner = async (request) => {
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

function failed(code: string, message: string): EffectOutcome<AttemptRunOutput> {
  return { status: "failed", error: { code, message } }
}

function text(value: JsonValue | undefined, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.trim() === "") throw new Error(`yrd: Ag ${label} must be a non-empty string`)
  return value
}

function boolean(value: JsonValue | undefined, label: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "boolean") throw new Error(`yrd: Ag ${label} must be a boolean`)
  return value
}

function record(value: JsonValue | undefined, label: string): JsonObject | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`yrd: Ag ${label} must be an object`)
  }
  return value as JsonObject
}

function stringList(value: JsonValue | undefined, label: string): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    throw new Error(`yrd: Ag ${label} must be an array of non-empty strings`)
  }
  if (value.includes("--")) throw new Error(`yrd: Ag ${label} must not contain '--'; Yrd owns the task prompt boundary`)
  return value as readonly string[]
}

function inferredProvider(model: string): string {
  const normalized = model.toLowerCase()
  if (normalized === "claude" || normalized.startsWith("claude-")) return "claude"
  if (normalized === "codex" || normalized.startsWith("gpt-") || normalized.startsWith("codex-")) return "codex"
  return model
}

function defaultLaunch(input: ContestRunnerInput): AgContestLaunch {
  const config = input.competitor.config
  const routing = record(config.routing, "routing")
  const provider =
    text(config.provider, "provider") ??
    text(routing?.provider, "routing.provider") ??
    inferredProvider(input.competitor.model)
  const account = text(config.account, "account") ?? text(routing?.account, "routing.account")
  const tier = text(config.tier, "tier") ?? text(routing?.tier, "routing.tier")
  const effort = text(config.effort, "effort")
  const instructions = text(config.instructions, "instructions")
  const yolo = boolean(config.yolo, "yolo") ?? provider === "claude"
  const configuredArgs = stringList(config.args, "args")
  const args =
    provider === "codex"
      ? ["exec", "--json", ...configuredArgs]
      : provider === "claude"
        ? ["-p", "--output-format", "stream-json", "--verbose", ...configuredArgs]
        : configuredArgs
  if (provider !== "codex" && provider !== "claude" && args.length === 0) {
    throw new Error(
      `yrd: Ag provider '${provider}' has no known one-shot contract; configure args or inject resolveLaunch`,
    )
  }
  return {
    provider,
    ...(account === undefined ? {} : { account }),
    ...(tier === undefined ? {} : { tier }),
    ...(effort === undefined ? {} : { effort }),
    ...(instructions === undefined ? {} : { instructions }),
    yolo,
    args,
  }
}

function validateCommand(command: readonly string[]): readonly string[] {
  if (command.length === 0 || command.some((part) => part.trim() === "")) {
    throw new Error("yrd: Ag command must contain only non-empty argv values")
  }
  return command
}

function modelArg(input: ContestRunnerInput, provider: string): readonly string[] {
  return inferredProvider(input.competitor.model) === provider && input.competitor.model === provider
    ? []
    : ["--model", input.competitor.model]
}

function launchArgv(command: readonly string[], input: ContestRunnerInput, launch: AgContestLaunch): readonly string[] {
  const argv = [...command, launch.provider, "--no-tribe"]
  if (launch.account !== undefined) argv.push("--account", launch.account)
  if (launch.tier !== undefined) argv.push("--tier", launch.tier)
  argv.push(...modelArg(input, launch.provider))
  if (launch.yolo === true) argv.push("--yolo")
  if (launch.effort !== undefined) {
    argv.push(launch.provider === "codex" ? "--model-reasoning-effort" : "--effort", launch.effort)
  }
  argv.push(...launch.args, "--", taskPrompt(input, launch.instructions))
  return argv
}

function taskPrompt(input: ContestRunnerInput, instructions?: string): string {
  const task = input.task
  const lines = [
    "Implement the following real task in the isolated Yrd Work Bay that is your current working directory.",
    "",
    `Task source: ${task.ref.source}`,
    `Task id: ${task.ref.id}`,
    `Title: ${task.title}`,
  ]
  if (task.url !== undefined) lines.push(`URL: ${task.url}`)
  if (task.revision !== undefined) lines.push(`Task revision: ${task.revision}`)
  if (task.labels !== undefined && task.labels.length > 0) lines.push(`Labels: ${task.labels.join(", ")}`)
  lines.push("", "Task description:", task.description ?? "No additional description was supplied.", "")
  if (instructions !== undefined) lines.push("Additional instructions:", instructions, "")
  lines.push(
    `Base branch: ${input.base}`,
    `Base commit: ${input.bay.baseSha ?? "missing"}`,
    `Work branch: ${input.bay.branch}`,
    "",
    "Complete the task end to end, run focused verification, and commit all intended changes to the current branch.",
    "Do not create or switch branches. Leave the working tree clean. Do not merely describe the implementation.",
  )
  return lines.join("\n")
}

function executionEnvironment(
  input: ContestRunnerInput,
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
    YRD_CONTEST: input.contest,
    YRD_ATTEMPT: input.attempt,
    YRD_TASK_SOURCE: input.task.ref.source,
    YRD_TASK_ID: input.task.ref.id,
    YRD_BAY: input.bay.id,
    YRD_BRANCH: input.bay.branch,
    YRD_BASE: input.base,
    ...(input.bay.baseSha === undefined ? {} : { YRD_BASE_SHA: input.bay.baseSha }),
    YRD_EFFECT: context.id,
  }
}

async function execute(
  runner: AgProcessRunner,
  request: AgProcessRequest,
  timeoutMs?: number,
): Promise<Checked<AgProcessResult>> {
  const controller = timeoutMs === undefined ? undefined : new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const running = runner(controller === undefined ? request : { ...request, signal: controller.signal })
    const value =
      timeoutMs === undefined
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
  runner: AgProcessRunner,
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): Promise<Checked<AgProcessResult>> {
  return await execute(runner, { kind: "git", argv: ["git", ...args], cwd, env })
}

function output(result: AgProcessResult): string {
  return result.stdout.trim() || result.stderr.trim()
}

function gitFailure(result: Checked<AgProcessResult>, code: string, action: string): Failure | undefined {
  if (!result.ok) return { code, message: `${action}: ${result.error.message}` }
  if (result.value.exitCode !== 0) {
    return { code, message: `${action}: ${output(result.value) || `Git exited ${result.value.exitCode}`}` }
  }
  return undefined
}

async function workspacePreflight(
  runner: AgProcessRunner,
  input: ContestRunnerInput,
  env: NodeJS.ProcessEnv,
): Promise<Checked<{ cwd: string; commonGitDir: string; head: string; baseSha: string }>> {
  if (input.bay.status !== "active") {
    return { ok: false, error: { code: "bay-not-active", message: `Bay '${input.bay.id}' is ${input.bay.status}` } }
  }
  if (input.bay.path === undefined) {
    return { ok: false, error: { code: "bay-path-missing", message: `Bay '${input.bay.id}' has no workspace path` } }
  }
  if (input.bay.baseSha === undefined || !SHA.test(input.bay.baseSha)) {
    return {
      ok: false,
      error: { code: "bay-base-missing", message: `Bay '${input.bay.id}' has no valid pinned base commit` },
    }
  }
  if (input.bay.dirty === true) {
    return {
      ok: false,
      error: { code: "bay-dirty", message: `Bay '${input.bay.id}' was dirty at its last refresh` },
    }
  }
  let cwd: string
  try {
    cwd = await realpath(input.bay.path)
  } catch (error) {
    return {
      ok: false,
      error: { code: "bay-path-invalid", message: error instanceof Error ? error.message : String(error) },
    }
  }
  const top = await git(runner, cwd, env, ["rev-parse", "--show-toplevel"])
  const topFailure = gitFailure(top, "git-workspace-invalid", "Could not resolve Bay Git root")
  if (topFailure !== undefined) return { ok: false, error: topFailure }
  let topPath: string
  try {
    topPath = await realpath(top.ok ? top.value.stdout.trim() : "")
  } catch (error) {
    return {
      ok: false,
      error: { code: "git-workspace-invalid", message: error instanceof Error ? error.message : String(error) },
    }
  }
  if (topPath !== cwd) {
    return {
      ok: false,
      error: { code: "bay-workspace-mismatch", message: `Bay path '${cwd}' resolves to Git worktree '${topPath}'` },
    }
  }
  const branch = await git(runner, cwd, env, ["symbolic-ref", "--quiet", "--short", "HEAD"])
  const branchFailure = gitFailure(branch, "bay-branch-invalid", "Could not resolve Bay branch")
  if (branchFailure !== undefined) return { ok: false, error: branchFailure }
  const actualBranch = branch.ok ? branch.value.stdout.trim() : ""
  if (actualBranch !== input.bay.branch) {
    return {
      ok: false,
      error: {
        code: "bay-branch-mismatch",
        message: `Bay '${input.bay.id}' expected branch '${input.bay.branch}', found '${actualBranch}'`,
      },
    }
  }
  const head = await git(runner, cwd, env, ["rev-parse", "--verify", "HEAD^{commit}"])
  const headFailure = gitFailure(head, "bay-head-invalid", "Could not resolve Bay HEAD")
  if (headFailure !== undefined) return { ok: false, error: headFailure }
  const headSha = head.ok ? head.value.stdout.trim().toLowerCase() : ""
  if (!SHA.test(headSha)) {
    return { ok: false, error: { code: "bay-head-invalid", message: `Git returned invalid commit '${headSha}'` } }
  }
  if (input.bay.headSha !== undefined && input.bay.headSha.toLowerCase() !== headSha) {
    return {
      ok: false,
      error: {
        code: "bay-head-mismatch",
        message: `Bay '${input.bay.id}' expected HEAD ${input.bay.headSha}, found ${headSha}`,
      },
    }
  }
  const baseObject = await git(runner, cwd, env, ["cat-file", "-e", `${input.bay.baseSha}^{commit}`])
  const baseFailure = gitFailure(baseObject, "bay-base-invalid", "Could not resolve pinned Bay base")
  if (baseFailure !== undefined) return { ok: false, error: baseFailure }
  const basedOn = await git(runner, cwd, env, ["merge-base", "--is-ancestor", input.bay.baseSha, headSha])
  const basedOnFailure = gitFailure(basedOn, "bay-base-diverged", "Bay HEAD does not descend from its pinned base")
  if (basedOnFailure !== undefined) return { ok: false, error: basedOnFailure }
  const clean = await git(runner, cwd, env, ["status", "--porcelain=v1", "--untracked-files=all"])
  const cleanFailure = gitFailure(clean, "git-status-failed", "Could not verify initial worktree state")
  if (cleanFailure !== undefined) return { ok: false, error: cleanFailure }
  if (clean.ok && clean.value.stdout.trim() !== "") {
    return {
      ok: false,
      error: { code: "bay-dirty", message: `Bay '${input.bay.id}' contains uncommitted work before Ag launch` },
    }
  }
  const common = await git(runner, cwd, env, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  const commonFailure = gitFailure(common, "git-common-dir-invalid", "Could not resolve Git common directory")
  if (commonFailure !== undefined) return { ok: false, error: commonFailure }
  const commonGitDir = resolve(cwd, common.ok ? common.value.stdout.trim() : "")
  return { ok: true, value: { cwd, commonGitDir, head: headSha, baseSha: input.bay.baseSha } }
}

function jsonRecords(stdout: string): { transcript: string; records: readonly Record<string, unknown>[] } {
  const lines: string[] = []
  const records: Record<string, unknown>[] = []
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    try {
      const value: unknown = JSON.parse(trimmed)
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue
      lines.push(trimmed)
      records.push(value as Record<string, unknown>)
    } catch {
      // Ag may write a launch banner before the provider's JSONL stream; stdout.log retains it.
    }
  }
  return { transcript: lines.length === 0 ? "" : `${lines.join("\n")}\n`, records }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function usageCandidates(record: Record<string, unknown>): readonly Record<string, unknown>[] {
  const candidates: Record<string, unknown>[] = []
  const direct = object(record.usage)
  if (direct !== undefined) candidates.push(direct)
  const payload = object(record.payload)
  const info = object(payload?.info)
  const total = object(info?.total_token_usage)
  const last = object(info?.last_token_usage)
  if (total !== undefined) candidates.push(total)
  if (last !== undefined && total === undefined) candidates.push(last)
  return candidates
}

function numberAt(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value
  }
  return undefined
}

function usdAt(record: Record<string, unknown>): number | undefined {
  for (const key of ["total_cost_usd", "cost_usd", "usd"]) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value
  }
  const cost = object(record.cost)
  if (cost?.currency === "USD" && typeof cost.amount === "number" && Number.isFinite(cost.amount) && cost.amount >= 0) {
    return cost.amount
  }
  return undefined
}

function missing(label: string): Metric {
  return { kind: "missing", reason: `Ag/provider transcript did not expose ${label}` }
}

function metrics(records: readonly Record<string, unknown>[], provider: string): MetricsEvidence {
  const values: Partial<Record<keyof typeof TOKEN_FIELDS, Metric>> = {}
  let reportedCost: number | undefined
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!
    const source = `ag:${provider}:stdout-jsonl:${index + 1}`
    for (const candidate of usageCandidates(record)) {
      for (const [name, keys] of Object.entries(TOKEN_FIELDS) as [keyof typeof TOKEN_FIELDS, readonly string[]][]) {
        const value = numberAt(candidate, keys)
        if (value !== undefined) values[name] = { kind: "reported", value, source }
      }
      reportedCost = usdAt(candidate) ?? reportedCost
    }
    reportedCost = usdAt(record) ?? reportedCost
  }
  const tokens = {
    input: values.input ?? missing("input tokens"),
    output: values.output ?? missing("output tokens"),
    cachedInput: values.cachedInput ?? missing("cached input tokens"),
    cacheWrite: values.cacheWrite ?? missing("cache-write tokens"),
    reasoning: values.reasoning ?? missing("reasoning tokens"),
  }
  const projection: TokenCounts = {
    input: tokens.input.kind === "reported" ? tokens.input.value : null,
    output: tokens.output.kind === "reported" ? tokens.output.value : null,
    cachedInput: tokens.cachedInput.kind === "reported" ? tokens.cachedInput.value : null,
    cacheWrite: tokens.cacheWrite.kind === "reported" ? tokens.cacheWrite.value : null,
    reasoning: tokens.reasoning.kind === "reported" ? tokens.reasoning.value : null,
  }
  return {
    schema: "yrd.ag.metrics.v1",
    provider,
    tokens,
    cost:
      reportedCost === undefined
        ? { kind: "missing", reason: "Ag/provider transcript did not expose USD cost" }
        : { kind: "reported", usd: reportedCost, source: `ag:${provider}:transcript` },
    projection,
  }
}

function digest(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`
}

async function artifact(kind: string, path: string, content: string, mediaType: string): Promise<ContestArtifact> {
  await writeFile(path, content, { flag: "wx" })
  return { kind, uri: pathToFileURL(path).href, digest: digest(content), mediaType }
}

async function rawArtifacts(
  root: string,
  input: ContestRunnerInput,
  context: EffectAdapterContext,
  provider: string,
  result: AgProcessResult,
): Promise<Checked<RawArtifacts>> {
  const dir = join(root, "contests", input.contest, input.attempt, `attempt-${context.attempt}`)
  try {
    await mkdir(dir, { recursive: true })
    const parsed = jsonRecords(result.stdout)
    const evidence = metrics(parsed.records, provider)
    const artifacts = await Promise.all([
      artifact("stdout", join(dir, "stdout.log"), result.stdout, "text/plain"),
      artifact("stderr", join(dir, "stderr.log"), result.stderr, "text/plain"),
      artifact("transcript", join(dir, "transcript.jsonl"), parsed.transcript, "application/x-ndjson"),
      artifact("metrics", join(dir, "metrics.json"), `${JSON.stringify(evidence, null, 2)}\n`, "application/json"),
    ])
    return { ok: true, value: { artifacts, manifestPath: join(dir, "manifest.json"), metrics: evidence } }
  } catch (error) {
    return {
      ok: false,
      error: { code: "artifact-write-failed", message: error instanceof Error ? error.message : String(error) },
    }
  }
}

async function failureWithManifest(
  raw: RawArtifacts,
  failure: Failure,
  result: AgProcessResult,
): Promise<EffectOutcome<AttemptRunOutput>> {
  const manifest = {
    schema: "yrd.ag.run.v1",
    status: "failed",
    error: failure,
    process: { exitCode: result.exitCode },
    artifacts: raw.artifacts,
    metrics: raw.metrics,
  }
  try {
    await writeFile(raw.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" })
    return failed(failure.code, `${failure.message}. Artifacts: ${pathToFileURL(raw.manifestPath).href}`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return failed(failure.code, `${failure.message}. Artifact manifest failed: ${detail}`)
  }
}

async function verifyResult(
  runner: AgProcessRunner,
  input: ContestRunnerInput,
  env: NodeJS.ProcessEnv,
  cwd: string,
  before: string,
): Promise<Checked<string>> {
  const branch = await git(runner, cwd, env, ["symbolic-ref", "--quiet", "--short", "HEAD"])
  const branchFailure = gitFailure(branch, "bay-branch-invalid", "Could not verify final Bay branch")
  if (branchFailure !== undefined) return { ok: false, error: branchFailure }
  const finalBranch = branch.ok ? branch.value.stdout.trim() : ""
  if (finalBranch !== input.bay.branch) {
    return {
      ok: false,
      error: { code: "bay-branch-changed", message: `Agent changed branch to '${finalBranch}'` },
    }
  }
  const head = await git(runner, cwd, env, ["rev-parse", "--verify", "HEAD^{commit}"])
  const headFailure = gitFailure(head, "git-result-invalid", "Could not resolve result commit")
  if (headFailure !== undefined) return { ok: false, error: headFailure }
  const commit = head.ok ? head.value.stdout.trim().toLowerCase() : ""
  if (!SHA.test(commit))
    return { ok: false, error: { code: "git-result-invalid", message: `Invalid commit '${commit}'` } }
  if (commit === before) {
    return { ok: false, error: { code: "no-commit", message: "Ag exited successfully without producing a new commit" } }
  }
  const ancestor = await git(runner, cwd, env, ["merge-base", "--is-ancestor", before, commit])
  const ancestorFailure = gitFailure(ancestor, "history-rewritten", "Result commit does not descend from Bay HEAD")
  if (ancestorFailure !== undefined) return { ok: false, error: ancestorFailure }
  const status = await git(runner, cwd, env, ["status", "--porcelain=v1", "--untracked-files=all"])
  const statusFailure = gitFailure(status, "git-status-failed", "Could not verify final worktree state")
  if (statusFailure !== undefined) return { ok: false, error: statusFailure }
  if (status.ok && status.value.stdout.trim() !== "") {
    return {
      ok: false,
      error: { code: "dirty-workspace", message: "Agent left changes outside the committed result" },
    }
  }
  return { ok: true, value: commit }
}

async function pinAttempt(
  runner: AgProcessRunner,
  cwd: string,
  env: NodeJS.ProcessEnv,
  ref: string,
  commit: string,
): Promise<Checked<undefined>> {
  const existing = await git(runner, cwd, env, ["show-ref", "--verify", "--quiet", ref])
  if (!existing.ok) return existing
  if (existing.value.exitCode === 0) {
    const resolved = await git(runner, cwd, env, ["rev-parse", "--verify", `${ref}^{commit}`])
    const resolveFailure = gitFailure(resolved, "attempt-ref-read-failed", `Could not resolve attempt ref '${ref}'`)
    if (resolveFailure !== undefined) return { ok: false, error: resolveFailure }
    const pinned = resolved.ok ? resolved.value.stdout.trim().toLowerCase() : ""
    return pinned === commit
      ? { ok: true, value: undefined }
      : {
          ok: false,
          error: { code: "attempt-ref-conflict", message: `Write-once ref '${ref}' already pins ${pinned}` },
        }
  }
  if (existing.value.exitCode !== 1) {
    return {
      ok: false,
      error: { code: "attempt-ref-read-failed", message: output(existing.value) || "Could not inspect attempt ref" },
    }
  }
  const create = await git(runner, cwd, env, ["update-ref", "--create-reflog", ref, commit, "0".repeat(commit.length)])
  if (!create.ok) return create
  if (create.value.exitCode === 0) return { ok: true, value: undefined }
  const raced = await git(runner, cwd, env, ["rev-parse", "--verify", `${ref}^{commit}`])
  if (raced.ok && raced.value.exitCode === 0) {
    if (raced.value.stdout.trim().toLowerCase() === commit) return { ok: true, value: undefined }
  }
  return {
    ok: false,
    error: {
      code: "attempt-ref-conflict",
      message: output(create.value) || `Could not create write-once ref '${ref}'`,
    },
  }
}

function validateIdentity(input: ContestRunnerInput): Failure | undefined {
  if (!REF_SEGMENT.test(input.contest)) {
    return { code: "invalid-contest-id", message: `Contest id '${input.contest}' is not safe for a Git ref` }
  }
  if (!REF_SEGMENT.test(input.attempt)) {
    return { code: "invalid-attempt-id", message: `Attempt id '${input.attempt}' is not safe for a Git ref` }
  }
  return undefined
}

export function createAgContestRunner(options: AgContestRunnerOptions = {}): ContestRunnerAdapter {
  const harness = options.harness ?? "ag"
  const runner = options.process ?? defaultProcess
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? 30 * 60_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("yrd: Ag timeoutMs must be a positive safe integer")
  }
  return {
    harness,
    async run(input, context): Promise<EffectOutcome<AttemptRunOutput>> {
      const invalidIdentity = validateIdentity(input)
      if (invalidIdentity !== undefined) return failed(invalidIdentity.code, invalidIdentity.message)
      if (input.competitor.harness !== harness) {
        return failed(
          "harness-mismatch",
          `Ag adapter '${harness}' cannot run competitor harness '${input.competitor.harness}'`,
        )
      }
      let command: readonly string[]
      let launch: AgContestLaunch
      try {
        command = validateCommand(options.command ?? ["ag"])
        launch = (options.resolveLaunch ?? defaultLaunch)(input)
        if (launch.provider.trim() === "" || launch.args.some((arg) => arg === "" || arg === "--")) {
          throw new Error("yrd: Ag launch must have a provider and must leave the '--' prompt boundary to Yrd")
        }
      } catch (error) {
        return failed("ag-config-invalid", error instanceof Error ? error.message : String(error))
      }
      let extraEnv: NodeJS.ProcessEnv = {}
      try {
        extraEnv = options.environment?.(input, context) ?? {}
      } catch (error) {
        return failed("ag-environment-invalid", error instanceof Error ? error.message : String(error))
      }
      const env = executionEnvironment(input, context, extraEnv)
      const preflight = await workspacePreflight(runner, input, env)
      if (!preflight.ok) return failed(preflight.error.code, preflight.error.message)
      let artifactRoot: string
      try {
        const configuredRoot =
          typeof options.artifactRoot === "function" ? await options.artifactRoot(input, context) : options.artifactRoot
        artifactRoot = resolve(configuredRoot ?? join(preflight.value.commonGitDir, "yrd", "artifacts"))
      } catch (error) {
        return failed("artifact-root-invalid", error instanceof Error ? error.message : String(error))
      }
      const startedAt = now()
      const processResult = await execute(
        runner,
        {
          kind: "agent",
          argv: launchArgv(command, input, launch),
          cwd: preflight.value.cwd,
          env,
        },
        timeoutMs,
      )
      const finishedAt = now()
      const agResult = processResult.ok
        ? processResult.value
        : { exitCode: -1, stdout: "", stderr: processResult.error.message }
      const captured = await rawArtifacts(artifactRoot, input, context, launch.provider, agResult)
      if (!captured.ok) return failed(captured.error.code, captured.error.message)
      if (!processResult.ok) return await failureWithManifest(captured.value, processResult.error, agResult)
      if (agResult.exitCode !== 0) {
        const detail = agResult.stderr.trim() || agResult.stdout.trim()
        return await failureWithManifest(
          captured.value,
          {
            code: "ag-process-failed",
            message: `Ag exited ${agResult.exitCode}${detail === "" ? "" : `: ${detail.slice(-2_000)}`}`,
          },
          agResult,
        )
      }
      const verified = await verifyResult(runner, input, env, preflight.value.cwd, preflight.value.head)
      if (!verified.ok) return await failureWithManifest(captured.value, verified.error, agResult)
      const ref = `refs/yrd/attempts/${input.contest}/${input.attempt}`
      const pinned = await pinAttempt(runner, preflight.value.cwd, env, ref, verified.value)
      if (!pinned.ok) return await failureWithManifest(captured.value, pinned.error, agResult)
      const gitArtifact: ContestArtifact = { kind: "git-commit", uri: `git:${verified.value}` }
      return {
        status: "passed",
        output: {
          pin: {
            commit: verified.value,
            ref,
            branch: input.bay.branch,
            bay: input.bay.id,
            baseSha: preflight.value.baseSha,
          },
          wallTimeMs: Math.max(0, finishedAt - startedAt),
          tokens: captured.value.metrics.projection,
          cost: captured.value.metrics.cost,
          artifacts: [...captured.value.artifacts, gitArtifact],
        },
      }
    },
  }
}
