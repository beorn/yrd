import { realpath } from "node:fs/promises"
import { resolve, join } from "node:path"
import type { JsonValue } from "@yrd/core"
import type { JobContext, JobResult } from "@yrd/job"
import type { Process, ProcessResult } from "@yrd/process"
import type {
  AttemptRunOutput,
  ContestArtifact,
  ContestRunnerDef,
  ContestRunnerInput,
  JsonObject,
  TokenCounts,
  UsdCost,
} from "./types.ts"
import {
  FULL_SHA,
  accepted,
  attempt,
  captureArtifacts,
  createGit,
  executionEnvironment,
  failed,
  jsonArtifact,
  rejected,
  runProcess,
  type Checked,
  type Failure,
  type Git,
} from "./execution.ts"

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
  revision: string
  /** Executable plus any static prefix, for example `["bun", "/repo/ag/.../cli.ts"]`. */
  command?: readonly string[]
  harness?: string
  /** Hard bound for a local agent process. Remote adapters should return waiting instead. */
  timeoutMs?: number
  artifactRoot?: string | ((input: ContestRunnerInput, context: JobContext) => string | Promise<string>)
  environment?: (input: ContestRunnerInput, context: JobContext) => NodeJS.ProcessEnv
  /** Replaces only provider launch policy; issue prompt and evidence handling remain mandatory. */
  resolveLaunch?: (input: ContestRunnerInput) => AgContestLaunch
  inject: Readonly<{ process: Pick<Process, "run">; env?: NodeJS.ProcessEnv }>
}>

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
  dir: string
  metrics: MetricsEvidence
}>

const REF_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u
const TOKEN_FIELDS = {
  input: ["input_tokens", "inputTokens"],
  output: ["output_tokens", "outputTokens"],
  cachedInput: ["cached_input_tokens", "cache_read_input_tokens", "cacheReadTokens"],
  cacheWrite: ["cache_creation_input_tokens", "cache_write_input_tokens", "cacheWriteTokens"],
  reasoning: ["reasoning_output_tokens", "reasoning_tokens", "reasoningTokens"],
} as const

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
  if (value.includes("--")) {
    throw new Error(`yrd: Ag ${label} must not contain '--'; Yrd owns the issue prompt boundary`)
  }
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
        ? ["-p", "--output-format", "json", ...configuredArgs]
        : configuredArgs
  if (provider !== "codex" && provider !== "claude" && args.length === 0) {
    throw new Error(
      `yrd: Ag provider '${provider}' has no known one-shot contract; configure args or inject resolveLaunch`,
    )
  }
  return { provider, account, tier, effort, instructions, yolo, args }
}

function validateCommand(command: readonly string[]): readonly string[] {
  if (command.length === 0 || command.some((part) => part.trim() === "")) {
    throw new Error("yrd: Ag command must contain only non-empty argv values")
  }
  return command
}

function modelArg(input: ContestRunnerInput, provider: string): readonly string[] {
  return input.competitor.model === provider ? [] : ["--model", input.competitor.model]
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
  argv.push(...launch.args, "--", issuePrompt(input, launch.instructions))
  return argv
}

function issuePrompt(input: ContestRunnerInput, instructions?: string): string {
  const issue = input.issue
  const parts = [
    "Implement the following real issue in the isolated Yrd Work Bay that is your current working directory.",
    "",
    `Issue source: ${issue.ref.source}`,
    `Issue id: ${issue.ref.id}`,
    `Title: ${issue.title}`,
  ]
  if (issue.url !== undefined) parts.push(`URL: ${issue.url}`)
  if (issue.revision !== undefined) parts.push(`Issue revision: ${issue.revision}`)
  if (issue.labels !== undefined && issue.labels.length > 0) parts.push(`Labels: ${issue.labels.join(", ")}`)
  parts.push("", "Issue description:", issue.description ?? "No additional description was supplied.", "")
  if (instructions !== undefined) parts.push("Additional instructions:", instructions, "")
  parts.push(
    `Base branch: ${input.base}`,
    `Base commit: ${input.bay.baseSha ?? "missing"}`,
    `Work branch: ${input.bay.branch}`,
    "",
    "Complete the issue end to end, run focused verification, and commit all intended changes to the current branch.",
    "Do not create or switch branches. Leave the working tree clean. Do not merely describe the implementation.",
  )
  return parts.join("\n")
}

function agEnvironment(
  base: NodeJS.ProcessEnv,
  input: ContestRunnerInput,
  context: JobContext,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return executionEnvironment(base, extra, {
    YRD_CONTEST: input.contest,
    YRD_ATTEMPT: input.attempt,
    YRD_ISSUE_SOURCE: input.issue.ref.source,
    YRD_ISSUE_ID: input.issue.ref.id,
    YRD_BAY: input.bay.id,
    YRD_BRANCH: input.bay.branch,
    YRD_BASE: input.base,
    ...(input.bay.baseSha === undefined ? {} : { YRD_BASE_SHA: input.bay.baseSha }),
    YRD_JOB: context.id,
  })
}

async function workspacePreflight(
  git: Git,
  input: ContestRunnerInput,
): Promise<Checked<{ cwd: string; commonGitDir: string; head: string; baseSha: string }>> {
  if (input.bay.status !== "active") {
    return rejected("bay-not-active", `Bay '${input.bay.id}' is ${input.bay.status}`)
  }
  if (input.bay.path === undefined) {
    return rejected("bay-path-missing", `Bay '${input.bay.id}' has no workspace path`)
  }
  if (input.bay.baseSha === undefined || !FULL_SHA.test(input.bay.baseSha)) {
    return rejected("bay-base-missing", `Bay '${input.bay.id}' has no valid pinned base commit`)
  }
  if (input.bay.dirty === true) {
    return rejected("bay-dirty", `Bay '${input.bay.id}' was dirty at its last refresh`)
  }
  const bayPath = input.bay.path
  const path = await attempt("bay-path-invalid", () => realpath(bayPath))
  if (!path.ok) return path
  const cwd = path.value
  const top = await git.text(
    cwd,
    ["rev-parse", "--show-toplevel"],
    "git-workspace-invalid",
    "Could not resolve Bay Git root",
  )
  if (!top.ok) return top
  const topPath = await attempt("git-workspace-invalid", () => realpath(top.value))
  if (!topPath.ok) return topPath
  if (topPath.value !== cwd) {
    return rejected("bay-workspace-mismatch", `Bay path '${cwd}' resolves to Git worktree '${topPath.value}'`)
  }
  const branch = await git.branch(cwd, "bay-branch-invalid", "Could not resolve Bay branch")
  if (!branch.ok) return branch
  if (branch.value !== input.bay.branch) {
    return rejected(
      "bay-branch-mismatch",
      `Bay '${input.bay.id}' expected branch '${input.bay.branch}', found '${branch.value}'`,
    )
  }
  const head = await git.commit(cwd, "HEAD", "bay-head-invalid", "Could not resolve Bay HEAD")
  if (!head.ok) return head
  if (input.bay.headSha !== undefined && input.bay.headSha.toLowerCase() !== head.value) {
    return rejected(
      "bay-head-mismatch",
      `Bay '${input.bay.id}' expected HEAD ${input.bay.headSha}, found ${head.value}`,
    )
  }
  const base = await git.commit(cwd, input.bay.baseSha, "bay-base-invalid", "Could not resolve pinned Bay base")
  if (!base.ok) return base
  const basedOn = await git.run(cwd, ["merge-base", "--is-ancestor", base.value, head.value])
  const basedOnFailure = git.failure(basedOn, "bay-base-diverged", "Bay HEAD does not descend from its pinned base")
  if (basedOnFailure !== undefined) return rejected(basedOnFailure.code, basedOnFailure.message)
  const clean = await git.clean(cwd, "git-status-failed", "Could not verify initial worktree state")
  if (!clean.ok) return clean
  if (!clean.value) {
    return rejected("bay-dirty", `Bay '${input.bay.id}' contains uncommitted work before Ag launch`)
  }
  const common = await git.commonDir(cwd, "Could not resolve Git common directory")
  if (!common.ok) return common
  return accepted({ cwd, commonGitDir: common.value, head: head.value, baseSha: base.value })
}

function jsonRecords(stdout: string): { transcript: string; records: readonly Record<string, unknown>[] } {
  const entries: string[] = []
  const records: Record<string, unknown>[] = []
  for (const entry of stdout.split(/\r?\n/u)) {
    const trimmed = entry.trim()
    if (trimmed === "") continue
    try {
      const value: unknown = JSON.parse(trimmed)
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue
      entries.push(trimmed)
      records.push(value as Record<string, unknown>)
    } catch {
      // Ag may write a launch banner before the provider's JSONL stream; stdout.log retains it.
    }
  }
  return { transcript: entries.length === 0 ? "" : `${entries.join("\n")}\n`, records }
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
  for (const [index, record] of records.entries()) {
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

async function rawArtifacts(
  root: string,
  input: ContestRunnerInput,
  context: JobContext,
  provider: string,
  result: ProcessResult,
): Promise<Checked<RawArtifacts>> {
  const dir = join(root, "contests", input.contest, input.attempt, `attempt-${context.attempt}`)
  const parsed = jsonRecords(result.stdout)
  const evidence = metrics(parsed.records, provider)
  const artifacts = await captureArtifacts(dir, [
    { kind: "stdout", file: "stdout.log", content: result.stdout, mediaType: "text/plain" },
    { kind: "stderr", file: "stderr.log", content: result.stderr, mediaType: "text/plain" },
    { kind: "transcript", file: "transcript.jsonl", content: parsed.transcript, mediaType: "application/x-ndjson" },
    jsonArtifact("metrics", "metrics.json", evidence),
  ])
  return artifacts.ok ? accepted({ artifacts: artifacts.value, dir, metrics: evidence }) : artifacts
}

async function failureWithManifest(
  raw: RawArtifacts,
  failure: Failure,
  result: ProcessResult,
): Promise<JobResult<AttemptRunOutput>> {
  const manifest = await captureArtifacts(raw.dir, [
    jsonArtifact("run-manifest", "manifest.json", {
      schema: "yrd.ag.run.v1",
      status: "failed",
      error: failure,
      process: { exitCode: result.exitCode },
      artifacts: raw.artifacts,
      metrics: raw.metrics,
    }),
  ])
  if (!manifest.ok) {
    return failed(failure.code, `${failure.message}. Artifact manifest failed: ${manifest.error.message}`)
  }
  const artifact = manifest.value[0]
  return artifact === undefined
    ? failed(failure.code, `${failure.message}. Artifact manifest failed: no artifact was written`)
    : failed(failure.code, `${failure.message}. Artifacts: ${artifact.uri}`)
}

async function verifyResult(
  git: Git,
  input: ContestRunnerInput,
  cwd: string,
  before: string,
): Promise<Checked<string>> {
  const branch = await git.branch(cwd, "bay-branch-invalid", "Could not verify final Bay branch")
  if (!branch.ok) return branch
  if (branch.value !== input.bay.branch) {
    return rejected("bay-branch-changed", `Agent changed branch to '${branch.value}'`)
  }
  const head = await git.commit(cwd, "HEAD", "git-result-invalid", "Could not resolve result commit")
  if (!head.ok) return head
  if (head.value === before) {
    return rejected("no-commit", "Ag exited successfully without producing a new commit")
  }
  const ancestor = await git.run(cwd, ["merge-base", "--is-ancestor", before, head.value])
  const ancestorFailure = git.failure(ancestor, "history-rewritten", "Result commit does not descend from Bay HEAD")
  if (ancestorFailure !== undefined) return rejected(ancestorFailure.code, ancestorFailure.message)
  const clean = await git.clean(cwd, "git-status-failed", "Could not verify final worktree state")
  if (!clean.ok) return clean
  if (!clean.value) {
    return rejected("dirty-workspace", "Agent left changes outside the committed result")
  }
  return head
}

async function pinAttempt(git: Git, cwd: string, ref: string, commit: string): Promise<Checked<undefined>> {
  const existing = await git.run(cwd, ["show-ref", "--verify", "--quiet", ref])
  if (!existing.ok) return existing
  if (existing.value.exitCode === 0) {
    const pinned = await git.commit(cwd, ref, "attempt-ref-read-failed", `Could not resolve attempt ref '${ref}'`)
    if (!pinned.ok) return pinned
    return pinned.value === commit
      ? accepted(undefined)
      : rejected("attempt-ref-conflict", `Write-once ref '${ref}' already pins ${pinned.value}`)
  }
  if (existing.value.exitCode !== 1) {
    return rejected("attempt-ref-read-failed", git.output(existing.value))
  }
  const create = await git.run(cwd, ["update-ref", "--create-reflog", ref, commit, "0".repeat(commit.length)])
  if (!create.ok) return create
  if (create.value.exitCode === 0) return accepted(undefined)
  const raced = await git.commit(cwd, ref, "attempt-ref-read-failed", `Could not resolve raced ref '${ref}'`)
  return raced.ok && raced.value === commit
    ? accepted(undefined)
    : rejected("attempt-ref-conflict", git.output(create.value))
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

export function createAgContestRunner(options: AgContestRunnerOptions): ContestRunnerDef {
  const harness = options.harness ?? "ag"
  const revision = options.revision.trim()
  if (revision === "") throw new Error("yrd: Ag runner revision must not be empty")
  const process = options.inject.process
  const baseEnv = options.inject.env ?? globalThis.process.env
  const timeoutMs = options.timeoutMs ?? 30 * 60_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("yrd: Ag timeoutMs must be a positive safe integer")
  }
  return {
    harness,
    revision,
    async run(input, context): Promise<JobResult<AttemptRunOutput>> {
      const invalidIdentity = validateIdentity(input)
      if (invalidIdentity !== undefined) return failed(invalidIdentity.code, invalidIdentity.message)
      if (input.competitor.harness !== harness) {
        return failed(
          "harness-mismatch",
          `Ag adapter '${harness}' cannot run competitor harness '${input.competitor.harness}'`,
        )
      }
      const configured = await attempt("ag-config-invalid", () => {
        const command = validateCommand(options.command ?? ["ag"])
        const launch = (options.resolveLaunch ?? defaultLaunch)(input)
        if (launch.provider.trim() === "" || launch.args.some((arg) => arg === "" || arg === "--")) {
          throw new Error("yrd: Ag launch must have a provider and must leave the '--' prompt boundary to Yrd")
        }
        return { command, launch }
      })
      if (!configured.ok) return failed(configured.error.code, configured.error.message)
      const { command, launch } = configured.value
      const extraEnv = await attempt("ag-environment-invalid", () => options.environment?.(input, context) ?? {})
      if (!extraEnv.ok) return failed(extraEnv.error.code, extraEnv.error.message)
      const env = agEnvironment(baseEnv, input, context, extraEnv.value)
      const git = createGit(process, env, context.signal)
      const preflight = await workspacePreflight(git, input)
      if (!preflight.ok) return failed(preflight.error.code, preflight.error.message)
      const artifactRoot = await attempt("artifact-root-invalid", async () => {
        const configuredRoot =
          typeof options.artifactRoot === "function" ? await options.artifactRoot(input, context) : options.artifactRoot
        return resolve(configuredRoot ?? join(preflight.value.commonGitDir, "yrd", "artifacts"))
      })
      if (!artifactRoot.ok) return failed(artifactRoot.error.code, artifactRoot.error.message)
      const processResult = await runProcess(
        process,
        {
          argv: launchArgv(command, input, launch),
          cwd: preflight.value.cwd,
          env,
          timeoutMs,
          signal: context.signal,
        },
        "ag-spawn-failed",
      )
      const agResult: ProcessResult = processResult.ok
        ? processResult.value
        : {
            exitCode: -1,
            signal: null,
            stdout: "",
            stderr: processResult.error.message,
            durationMs: 0,
            timedOut: false,
          }
      const captured = await rawArtifacts(artifactRoot.value, input, context, launch.provider, agResult)
      if (!captured.ok) return failed(captured.error.code, captured.error.message)
      if (!processResult.ok) return failureWithManifest(captured.value, processResult.error, agResult)
      if (agResult.timedOut) {
        return failureWithManifest(
          captured.value,
          { code: "ag-timeout", message: `Ag timed out after ${timeoutMs}ms` },
          agResult,
        )
      }
      if (agResult.exitCode !== 0) {
        const detail = agResult.stderr.trim() || agResult.stdout.trim()
        return failureWithManifest(
          captured.value,
          {
            code: "ag-process-failed",
            message: `Ag exited ${agResult.exitCode}${detail === "" ? "" : `: ${detail.slice(-2_000)}`}`,
          },
          agResult,
        )
      }
      const verified = await verifyResult(git, input, preflight.value.cwd, preflight.value.head)
      if (!verified.ok) return failureWithManifest(captured.value, verified.error, agResult)
      const ref = `refs/yrd/attempts/${input.contest}/${input.attempt}`
      const pinned = await pinAttempt(git, preflight.value.cwd, ref, verified.value)
      if (!pinned.ok) return failureWithManifest(captured.value, pinned.error, agResult)
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
          wallTimeMs: agResult.durationMs,
          tokens: captured.value.metrics.projection,
          cost: captured.value.metrics.cost,
          artifacts: [...captured.value.artifacts, gitArtifact],
        },
      }
    },
  }
}
