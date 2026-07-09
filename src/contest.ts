import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { definePlugin } from "./core.ts"
import type { BayEvent, BayPlugin, BayState, Cause, ConfigSource, GitbayEvent } from "./types.ts"
import { createJsonlJournal } from "./journal.ts"
import { git, repoScopedCleanEnv } from "./layers/git.ts"
import { bayEventsPath } from "./paths.ts"

export type ContestMetrics = {
  inputTokens?: number
  cachedInputTokens?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
  outputTokens?: number
  reasoningOutputTokens?: number
  totalTokens?: number
  costUsd?: number
  costSource?: string
  costRates?: ContestCostRates
  source?: string
}

export type ContestCostRates = {
  inputTokensUsdPerMillion?: number
  cachedInputTokensUsdPerMillion?: number
  cacheCreationInputTokensUsdPerMillion?: number
  cacheReadInputTokensUsdPerMillion?: number
  outputTokensUsdPerMillion?: number
  reasoningOutputTokensUsdPerMillion?: number
  totalTokensUsdPerMillion?: number
}

export function parseContestCostField(raw: string): keyof ContestCostRates {
  const normalized = raw.trim().toLowerCase().replace(/[_\s]+/g, "-")
  if (normalized === "input" || normalized === "input-tokens" || normalized === "prompt") return "inputTokensUsdPerMillion"
  if (normalized === "cached-input" || normalized === "cached-input-tokens" || normalized === "cached-prompt") {
    return "cachedInputTokensUsdPerMillion"
  }
  if (normalized === "cache-creation-input" || normalized === "cache-create" || normalized === "cache-creation") {
    return "cacheCreationInputTokensUsdPerMillion"
  }
  if (normalized === "cache-read-input" || normalized === "cache-read") return "cacheReadInputTokensUsdPerMillion"
  if (normalized === "output" || normalized === "output-tokens" || normalized === "completion") return "outputTokensUsdPerMillion"
  if (normalized === "reasoning-output" || normalized === "reasoning") return "reasoningOutputTokensUsdPerMillion"
  if (normalized === "total" || normalized === "total-tokens") return "totalTokensUsdPerMillion"
  throw new Error(`unknown cost field '${raw}'`)
}

export function parseContestCostRates(raw: string): ContestCostRates {
  const rates: ContestCostRates = {}
  const fields = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
  if (fields.length === 0) throw new Error("requires at least one rate")
  for (const field of fields) {
    const sep = field.includes(":") ? field.indexOf(":") : field.indexOf("=")
    if (sep <= 0) throw new Error("rates use <field:usd-per-million>")
    const key = parseContestCostField(field.slice(0, sep))
    const value = Number(field.slice(sep + 1))
    if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be a non-negative number`)
    rates[key] = value
  }
  return rates
}

export function parseContestAgentCost(raw: string): [string, ContestCostRates] {
  const eq = raw.indexOf("=")
  if (eq <= 0) throw new Error("requires <name=field:usd-per-million,...>")
  const name = raw.slice(0, eq).trim()
  if (name === "") throw new Error("requires an agent name")
  return [name, parseContestCostRates(raw.slice(eq + 1))]
}

export async function resolveContestCostAdapters(
  agents: string[],
  inline: Map<string, ContestCostRates>,
  source: ConfigSource,
): Promise<Map<string, ContestCostRates>> {
  const adapters = new Map(inline)
  for (const agent of agents) {
    if (adapters.has(agent)) continue
    const raw = await source.get(`contest.cost.${agent}`)
    if (raw === undefined) continue
    const trimmed = raw.trim()
    if (trimmed === "" || trimmed === "none") continue
    try {
      adapters.set(agent, parseContestCostRates(trimmed))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`bay.contest.cost.${agent}: ${message}`)
    }
  }
  return adapters
}

export type ContestEval = {
  command: string
  startedAt: string
  finishedAt: string
  durationMs: number
  exitCode: number
  stdout: string
  stderr: string
}

export type ContestAttempt = {
  id: string
  agent: string
  bayName: string
  bayPath: string
  command: string[]
  startedAt: string
  finishedAt: string
  durationMs: number
  exitCode: number
  logs: { stdout: string; stderr: string }
  metrics: ContestMetrics
  git: {
    baseSha: string
    headSha?: string
    committed: boolean
    changedFiles: string[]
    status: string
    diffStat: string
  }
  evals: ContestEval[]
}

export type ContestRecord = {
  version: 1
  id: string
  task: string
  prompt: string
  repo: string
  base: string
  baseSha: string
  createdAt: string
  agents: string[]
  attempts: ContestAttempt[]
  winner?: string
  promoted?: {
    attempt: string
    at: string
    push: CommandResult
    submit: CommandResult
    pr?: string
  }
}

export type CommandResult = {
  code: number
  stdout: string
  stderr: string
}

export type CompeteOptions = {
  task: string
  prompt: string
  agents: string[]
  base: string
  agentCommands: Map<string, string>
  costAdapters: Map<string, ContestCostRates>
  evalCommands: string[]
  json: boolean
}

type RepoPaths = {
  repo: string
  gitDir: string
  bayDir: string
}

type ContestEvent = Extract<GitbayEvent, { name: `contest/${string}` }>
type ContestOpenedData = Extract<ContestEvent, { name: "contest/opened" }>["data"]
type ContestAttemptStartedData = Extract<ContestEvent, { name: "contest/attempt/started" }>["data"]
type ContestAttemptFinishedData = Extract<ContestEvent, { name: "contest/attempt/finished" }>["data"]

export type ContestSlice = {
  records: Record<string, ContestRecord>
  starts: Record<string, Record<string, ContestAttemptStartedData>>
}

export type ContestEventAppender = <Name extends ContestEvent["name"]>(
  name: Name,
  data: Extract<ContestEvent, { name: Name }>["data"],
  idPart: string,
) => Promise<void>

export function emptyContestSlice(): ContestSlice {
  return { records: {}, starts: {} }
}

export function contestSlice(state: BayState): ContestSlice {
  return (state.slices.contests as ContestSlice | undefined) ?? emptyContestSlice()
}

export function contestRecords(state: BayState): Record<string, ContestRecord> {
  return contestSlice(state).records
}

export async function resolveRepoPaths(cwd = process.cwd()): Promise<RepoPaths> {
  const repoRes = await git(["-C", cwd, "rev-parse", "--show-toplevel"], cwd)
  if (repoRes.code !== 0) throw new Error(`yrd: not inside a git repository: ${repoRes.stderr.trim()}`)
  const repo = repoRes.stdout.trim()
  const gitDirRes = await git(["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"], repo)
  if (gitDirRes.code !== 0) throw new Error(`yrd: cannot resolve git dir: ${gitDirRes.stderr.trim()}`)
  const gitDir = gitDirRes.stdout.trim()
  return { repo, gitDir, bayDir: join(gitDir, "bay") }
}

export async function nextContestId(bayDir: string): Promise<string> {
  const contests = join(bayDir, "contests")
  if (!existsSync(contests)) return "C1"
  const ids = (await readdir(contests, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => /^C(\d+)$/.exec(entry.name)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
  return `C${ids.length === 0 ? 1 : Math.max(...ids) + 1}`
}

export function contestPath(bayDir: string, id: string): string {
  return join(bayDir, "contests", id, "contest.json")
}

function attemptOrder(id: string): number {
  const match = /^A(?<n>\d+)$/u.exec(id)
  return match?.groups?.n === undefined ? Number.MAX_SAFE_INTEGER : Number.parseInt(match.groups.n, 10)
}

function openedRecord(id: string, ts: string, data: ContestOpenedData, existing?: ContestRecord): ContestRecord {
  return {
    version: 1,
    id,
    task: data.task,
    prompt: data.prompt,
    repo: data.repo,
    base: data.base,
    baseSha: data.baseSha,
    createdAt: ts,
    agents: data.agents,
    attempts: existing?.attempts ?? [],
    ...(existing?.winner === undefined ? {} : { winner: existing.winner }),
    ...(existing?.promoted === undefined ? {} : { promoted: existing.promoted }),
  }
}

function finishedAttempt(start: ContestAttemptStartedData, done: ContestAttemptFinishedData): ContestAttempt {
  return {
    id: done.attempt,
    agent: done.agent,
    bayName: done.bay,
    bayPath: done.bayPath,
    command: start.command,
    startedAt: done.startedAt,
    finishedAt: done.finishedAt,
    durationMs: done.durationMs,
    exitCode: done.exitCode,
    logs: done.logs,
    metrics: done.metrics,
    git: done.git,
    evals: done.evals,
  }
}

function sortAttempts(attempts: ContestAttempt[]): ContestAttempt[] {
  return [...attempts].sort((a, b) => attemptOrder(a.id) - attemptOrder(b.id))
}

export function applyContestEvent(slice: ContestSlice, event: BayEvent): ContestSlice {
  if (!event.name.startsWith("contest/")) return slice
  const contest = event.data.contest
  if (typeof contest !== "string") return slice

  switch (event.name) {
    case "contest/opened": {
      const data = event.data as ContestOpenedData
      return {
        ...slice,
        records: { ...slice.records, [contest]: openedRecord(contest, event.ts, data, slice.records[contest]) },
      }
    }
    case "contest/attempt/started": {
      const data = event.data as ContestAttemptStartedData
      return {
        ...slice,
        starts: { ...slice.starts, [contest]: { ...(slice.starts[contest] ?? {}), [data.attempt]: data } },
      }
    }
    case "contest/attempt/finished": {
      const data = event.data as ContestAttemptFinishedData
      const record = slice.records[contest]
      const start = slice.starts[contest]?.[data.attempt]
      if (record === undefined || start === undefined) return slice
      const attempts = sortAttempts([
        ...record.attempts.filter((attempt) => attempt.id !== data.attempt),
        finishedAttempt(start, data),
      ])
      return { ...slice, records: { ...slice.records, [contest]: { ...record, attempts } } }
    }
    case "contest/selected": {
      const record = slice.records[contest]
      if (record === undefined) return slice
      const data = event.data as Extract<ContestEvent, { name: "contest/selected" }>["data"]
      return { ...slice, records: { ...slice.records, [contest]: { ...record, winner: data.winner } } }
    }
    case "contest/promoted": {
      const record = slice.records[contest]
      if (record === undefined) return slice
      const data = event.data as Extract<ContestEvent, { name: "contest/promoted" }>["data"]
      return {
        ...slice,
        records: {
          ...slice.records,
          [contest]: {
            ...record,
            promoted: {
              attempt: data.attempt,
              at: event.ts,
              push: data.push,
              submit: data.submit,
              ...(data.pr === undefined ? {} : { pr: data.pr }),
            },
          },
        },
      }
    }
    default:
      return slice
  }
}

export function withContests(): BayPlugin {
  return definePlugin({
    name: "contests",
    apply(state, event) {
      const current = contestSlice(state)
      const next = applyContestEvent(current, event)
      return next === current ? state : { ...state, slices: { ...state.slices, contests: next } }
    },
  })
}

export async function foldContestFromEvents(bayDir: string, id: string): Promise<ContestRecord | undefined> {
  const journal = createJsonlJournal(bayEventsPath(bayDir))
  let slice = emptyContestSlice()
  for await (const event of journal.replay()) slice = applyContestEvent(slice, event)
  return slice.records[id]
}

export async function readContest(bayDir: string, id: string): Promise<ContestRecord> {
  const folded = await foldContestFromEvents(bayDir, id)
  if (folded !== undefined) return folded

  const path = contestPath(bayDir, id)
  const raw = await readFile(path, "utf8").catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`yrd: contest '${id}' not found at ${path}: ${message}`)
  })
  return JSON.parse(raw) as ContestRecord
}

export async function writeContest(bayDir: string, record: ContestRecord): Promise<void> {
  const path = contestPath(bayDir, record.id)
  await mkdir(join(bayDir, "contests", record.id), { recursive: true })
  await writeFile(path, JSON.stringify(record, null, 2) + "\n", "utf8")
}

export function createContestEventAppender(bayDir: string, cause: Cause): ContestEventAppender {
  const journal = createJsonlJournal(bayEventsPath(bayDir))
  return async (name, data, idPart) => {
    await journal.append({
      id: `${cause.commandId}:${name}:${idPart}`,
      name,
      ts: new Date().toISOString(),
      cause,
      data,
    })
  }
}

export async function runCommand(cmd: string[], cwd: string, env: Record<string, string> = {}): Promise<CommandResult> {
  const child = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...repoScopedCleanEnv(), ...env },
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout, stderr }
}

export function sanitizePart(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return cleaned === "" ? "task" : cleaned.slice(0, 48)
}

export function builtInAgentCommand(agent: string, prompt: string): string[] {
  if (agent === "codex") return ["ag", "codex", "exec", "--json", "--", prompt]
  if (agent === "claude") {
    return ["ag", "claude", "-p", "--output-format", "json", "--dangerously-skip-permissions", "--", prompt]
  }
  throw new Error(
    `yrd: no built-in contest agent '${agent}' (built-ins: codex, claude). ` +
      `Use --agent-cmd ${agent}='<command using $YRD_PROMPT>'`,
  )
}

export function resolveAgentCommand(agent: string, prompt: string, custom: Map<string, string>): string[] {
  const command = custom.get(agent)
  if (command !== undefined) return ["sh", "-c", command]
  return builtInAgentCommand(agent, prompt)
}

export function attemptPrompt(task: string, prompt: string, bayPath: string): string {
  return `${prompt}

Yrd contest attempt rules:
- Implement task: ${task}
- Work only in this bay worktree: ${bayPath}
- Commit the final attempt locally.
- Do not push, submit, merge, or close the bay.
- Leave concise verification notes in your final response.`
}

export function extractMetrics(text: string, source: string): ContestMetrics {
  const metrics: ContestMetrics = {}
  let foundCost = false
  const visit = (value: unknown, keyHint = ""): void => {
    if (typeof value === "number" && Number.isFinite(value)) {
      const key = keyHint.toLowerCase().replace(/[_-]/g, "")
      if (key === "inputtokens" || key === "prompttokens") metrics.inputTokens = Math.max(metrics.inputTokens ?? 0, value)
      else if (key === "cachedinputtokens" || key === "cachedprompttokens") {
        metrics.cachedInputTokens = Math.max(metrics.cachedInputTokens ?? 0, value)
      } else if (key === "cachecreationinputtokens") {
        metrics.cacheCreationInputTokens = Math.max(metrics.cacheCreationInputTokens ?? 0, value)
      } else if (key === "cachereadinputtokens") {
        metrics.cacheReadInputTokens = Math.max(metrics.cacheReadInputTokens ?? 0, value)
      }
      else if (key === "outputtokens" || key === "completiontokens") {
        metrics.outputTokens = Math.max(metrics.outputTokens ?? 0, value)
      } else if (key === "reasoningoutputtokens") {
        metrics.reasoningOutputTokens = Math.max(metrics.reasoningOutputTokens ?? 0, value)
      } else if (key === "totaltokens") metrics.totalTokens = Math.max(metrics.totalTokens ?? 0, value)
      else if (key === "costusd" || key === "totalcostusd" || key === "usd" || key === "cost") {
        metrics.costUsd = Math.max(metrics.costUsd ?? 0, value)
        foundCost = true
      }
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, keyHint)
      return
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) visit(child, key)
    }
  }

  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    try {
      visit(JSON.parse(trimmed))
    } catch {
      // Logs are often mixed human text + JSON. Non-JSON lines are still kept
      // in artifacts; they just do not contribute structured metrics.
    }
  }

  if (metrics.totalTokens === undefined && (metrics.inputTokens !== undefined || metrics.outputTokens !== undefined)) {
    metrics.totalTokens = (metrics.inputTokens ?? 0) + (metrics.outputTokens ?? 0)
  }
  if (
    metrics.inputTokens !== undefined ||
    metrics.cachedInputTokens !== undefined ||
    metrics.cacheCreationInputTokens !== undefined ||
    metrics.cacheReadInputTokens !== undefined ||
    metrics.outputTokens !== undefined ||
    metrics.reasoningOutputTokens !== undefined ||
    metrics.totalTokens !== undefined ||
    metrics.costUsd !== undefined
  ) {
    metrics.source = source
  }
  if (foundCost) metrics.costSource = source
  return metrics
}

function costTerm(tokens: number | undefined, usdPerMillion: number | undefined): number {
  if (tokens === undefined || usdPerMillion === undefined) return 0
  return (tokens / 1_000_000) * usdPerMillion
}

function hasCostRates(rates: ContestCostRates): boolean {
  return Object.values(rates).some((value) => value !== undefined)
}

export function applyCostAdapter(metrics: ContestMetrics, rates: ContestCostRates | undefined, source: string): ContestMetrics {
  if (rates === undefined || !hasCostRates(rates) || metrics.costUsd !== undefined) return metrics
  const costUsd =
    costTerm(metrics.inputTokens, rates.inputTokensUsdPerMillion) +
    costTerm(metrics.cachedInputTokens, rates.cachedInputTokensUsdPerMillion) +
    costTerm(metrics.cacheCreationInputTokens, rates.cacheCreationInputTokensUsdPerMillion) +
    costTerm(metrics.cacheReadInputTokens, rates.cacheReadInputTokensUsdPerMillion) +
    costTerm(metrics.outputTokens, rates.outputTokensUsdPerMillion) +
    costTerm(metrics.reasoningOutputTokens, rates.reasoningOutputTokensUsdPerMillion) +
    costTerm(metrics.totalTokens, rates.totalTokensUsdPerMillion)
  if (costUsd <= 0) return metrics
  return { ...metrics, costUsd, costSource: source, costRates: rates }
}

async function gitText(args: string[], cwd: string): Promise<string> {
  const res = await git(["-C", cwd, ...args], cwd)
  return res.code === 0 ? res.stdout.trim() : ""
}

export async function collectGitMetrics(bayPath: string, baseSha: string): Promise<ContestAttempt["git"]> {
  const headSha = await gitText(["rev-parse", "HEAD"], bayPath)
  const committed = headSha !== "" && headSha !== baseSha
  const status = await gitText(["status", "--short"], bayPath)
  const changed = committed ? await gitText(["diff", "--name-only", `${baseSha}..HEAD`], bayPath) : ""
  const dirty = await gitText(["diff", "--name-only"], bayPath)
  const changedFiles = [...new Set([...changed.split("\n"), ...dirty.split("\n")].filter((line) => line.trim() !== ""))]
  const diffStat = committed
    ? await gitText(["diff", "--stat", `${baseSha}..HEAD`], bayPath)
    : await gitText(["diff", "--stat"], bayPath)
  return { baseSha, headSha: headSha || undefined, committed, changedFiles, status, diffStat }
}

export async function runEvalCommand(command: string, cwd: string, env: Record<string, string>): Promise<ContestEval> {
  const started = Date.now()
  const startedAt = new Date(started).toISOString()
  const result = await runCommand(["sh", "-c", command], cwd, env)
  const finished = Date.now()
  return {
    command,
    startedAt,
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

export async function runAttempt(params: {
  id: string
  agent: string
  bayName: string
  bayPath: string
  task: string
  prompt: string
  baseSha: string
  contestDir: string
  agentCommands: Map<string, string>
  costAdapters: Map<string, ContestCostRates>
  evalCommands: string[]
  appendEvent?: ContestEventAppender
}): Promise<ContestAttempt> {
  const prompt = attemptPrompt(params.task, params.prompt, params.bayPath)
  const command = resolveAgentCommand(params.agent, prompt, params.agentCommands)
  const contestId = basename(params.contestDir)
  const started = Date.now()
  const startedAt = new Date(started).toISOString()
  await params.appendEvent?.(
    "contest/attempt/started",
    {
      contest: contestId,
      attempt: params.id,
      agent: params.agent,
      bay: params.bayName,
      bayPath: params.bayPath,
      command,
      startedAt,
    },
    `attempt:${params.id}:started`,
  )
  const env = {
    YRD_CONTEST_ATTEMPT: params.id,
    YRD_AGENT: params.agent,
    YRD_TASK: params.task,
    YRD_PROMPT: prompt,
    YRD_BAY: params.bayPath,
  }
  const result = await runCommand(command, params.bayPath, env)
  const finished = Date.now()
  const finishedAt = new Date(finished).toISOString()
  const attemptDir = join(params.contestDir, params.id)
  await mkdir(attemptDir, { recursive: true })
  const stdoutPath = join(attemptDir, "stdout.log")
  const stderrPath = join(attemptDir, "stderr.log")
  await writeFile(stdoutPath, result.stdout, "utf8")
  await writeFile(stderrPath, result.stderr, "utf8")
  const metrics = applyCostAdapter(
    extractMetrics(`${result.stdout}\n${result.stderr}`, "runner-output"),
    params.costAdapters.get(params.agent),
    `configured:${params.agent}`,
  )
  const evals: ContestEval[] = []
  for (const command of params.evalCommands) {
    evals.push(await runEvalCommand(command, params.bayPath, env))
  }
  const attempt: ContestAttempt = {
    id: params.id,
    agent: params.agent,
    bayName: params.bayName,
    bayPath: params.bayPath,
    command,
    startedAt,
    finishedAt,
    durationMs: finished - started,
    exitCode: result.code,
    logs: { stdout: stdoutPath, stderr: stderrPath },
    metrics,
    git: await collectGitMetrics(params.bayPath, params.baseSha),
    evals,
  }
  await params.appendEvent?.(
    "contest/attempt/finished",
    {
      contest: contestId,
      attempt: attempt.id,
      agent: attempt.agent,
      bay: attempt.bayName,
      bayPath: attempt.bayPath,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
      exitCode: attempt.exitCode,
      durationMs: attempt.durationMs,
      logs: attempt.logs,
      metrics: attempt.metrics,
      git: attempt.git,
      evals: attempt.evals,
    },
    `attempt:${attempt.id}:finished`,
  )
  return attempt
}

export function formatContest(record: ContestRecord): string {
  const lines = [`${record.id} ${record.task}`, `base ${record.base} ${record.baseSha.slice(0, 12)}`]
  for (const attempt of record.attempts) {
    const verdict = attempt.exitCode === 0 ? "ok" : `exit ${attempt.exitCode}`
    const tokens = attempt.metrics.totalTokens === undefined ? "" : ` tokens=${attempt.metrics.totalTokens}`
    const cost = attempt.metrics.costUsd === undefined ? "" : ` cost=$${attempt.metrics.costUsd.toFixed(4)}`
    const winner = record.winner === attempt.id ? " winner" : ""
    lines.push(
      `${attempt.id} ${attempt.agent} ${verdict} ${attempt.durationMs}ms${tokens}${cost}${winner} ` +
        `${attempt.git.committed ? attempt.git.headSha?.slice(0, 12) : "no-commit"} ${basename(attempt.bayPath)}`,
    )
  }
  if (record.promoted) lines.push(`promoted ${record.promoted.attempt}${record.promoted.pr ? ` as ${record.promoted.pr}` : ""}`)
  return lines.join("\n")
}

export function parsePrFromText(text: string): string | undefined {
  return text.match(/\bPR\d+\b/)?.[0]
}
