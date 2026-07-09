#!/usr/bin/env bun
import { readFile } from "node:fs/promises"
import {
  contestPath,
  createContestEventAppender,
  formatContest,
  nextContestId,
  parseContestAgentCost,
  parsePrFromText,
  readContest,
  resolveRepoPaths,
  resolveContestCostAdapters,
  runAttempt,
  runCommand,
  sanitizePart,
  writeContest,
  type CompeteOptions,
  type ContestCostRates,
  type ContestRecord,
} from "../src/contest.ts"
import { createGitConfigSource, resolveOption } from "../src/config.ts"
import { createScratchWorkspaces } from "../src/scratch.ts"
import { git, resolveBaseRef } from "../src/layers/git.ts"

// yrd — the software delivery yard (staged identity for this repo; see
// docs/yrd.md). Projections are subcommands; `bay`, `line`, `task`, and
// `contest` are installed today. `bay` IS the git-bay CLI — same
// implementation, not a fork. `line` projects onto the same
// check/merge/integrate machinery and journal events. `task compete` and
// `contest ...` are the first contest projection over real bay attempts.
//
// Law 2 holds: quiet on success, meaningful exit codes. Unknown projection is
// an error (exit 2), bare `yrd`/help prints the yard usage (exit 0).

const USAGE = `yrd — the software delivery yard

USAGE
  yrd bay <verb> [args]   the Git-native bay (same implementation as \`git bay\`)
  yrd line <verb> [args]  integration line projection over the same bay state
  yrd task compete <task> --agents "ag codex/claude" [options]
  yrd contest <verb> [args]

Installed projections: bay, line, task, contest
`

const LINE_USAGE = `yrd line — integration line projection

USAGE
  yrd line status [selector...] [--json]
  yrd line audit [--json]
  yrd line provision [base] [--json]
  yrd line deprovision [base] [--json]
  yrd line integrate [PR|name] [--steps check,merge,deploy] [--retry] [--watch] [--interval <sec>]
  yrd line finish <PR|name> [--step check] (--ok|--fail) [--token <token>] [--detail <text>] [--artifact <name=ref>]
  yrd line watch [PR|name] [--steps check,merge,deploy] [--interval <sec>]

Installed steps: check, merge, deploy
Provision preflights bay.provision in a disposable scratch workspace.
`

const TASK_USAGE = `yrd task — task intake projection

USAGE
  yrd task compete <task> [--agents "ag codex/claude"] [--prompt <text>] [--prompt-file <path>]
                   [--agent-cmd <name=command>] [--agent-cost <name=field:usd-per-million,...>]
                   [--eval <command>] [--base <ref>] [--bays <n>] [--json]

Built-in contest agents: codex, claude
Agent lists use ag-style provider-list syntax; "ag codex/claude" fans out into attempts.
Custom commands run with YRD_PROMPT, YRD_TASK, YRD_BAY, YRD_AGENT, and YRD_CONTEST_ATTEMPT in env.
Cost adapters are explicit rates only: --agent-cost codex=input:1.25,output:10,cached-input:0.125
Repo config can set the same rates with: git config bay.contest.cost.codex 'input:1.25,output:10'
`

const CONTEST_USAGE = `yrd contest — contest lifecycle

USAGE
  yrd contest show <contest> [--json]
  yrd contest select <contest> --winner <attempt>
  yrd contest promote <contest> [--force]
`

const projection = process.argv[2]
const GIT_BAY_TS = new URL("./git-bay.ts", import.meta.url).pathname

async function reenterGitBay(args: string[]): Promise<void> {
  // Dynamic import so argv rewriting happens BEFORE the CLI reads process.argv
  // (static imports would hoist above it).
  process.argv = [process.argv[0] ?? "bun", process.argv[1] ?? "yrd", ...args]
  await import("./git-bay.ts")
}

function printUsage(): void {
  console.log(USAGE)
}

function fail(message: string): never {
  console.error(message)
  process.exit(2)
}

function domainError(message: string): never {
  throw new Error(message.startsWith("yrd:") ? message : `yrd: ${message}`)
}

type LineStepName = "check" | "merge" | "deploy"

function parseSteps(raw: string | undefined): LineStepName[] {
  if (raw === undefined || raw.trim() === "") return ["check", "merge"]
  const steps = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (steps.length === 0) return ["check", "merge"]
  const seen = new Set<string>()
  for (const step of steps) {
    if (seen.has(step)) fail(`yrd: line integrate: duplicate step '${step}'`)
    seen.add(step)
    if (step !== "check" && step !== "merge" && step !== "deploy") {
      fail(`yrd: line integrate: unknown step '${step}' (installed: check, merge, deploy)`)
    }
  }
  return steps as LineStepName[]
}

type ParsedIntegrate = {
  target?: string
  steps: LineStepName[]
  retry: boolean
  passthrough: string[]
}

type ParsedLineLifecycle = {
  base?: string
  json: boolean
}

type LineStepView = {
  ok?: boolean
  waiting?: boolean
  durationMs?: number
  skipped?: boolean
  token?: string
  url?: string
  error?: { code?: string; message?: string; exitCode?: number }
  artifacts?: unknown[]
}

type LineItemView = {
  pr: string
  state: string
  target: string
  stale?: boolean
  staleReasons?: string[]
  steps?: Partial<Record<LineStepName, LineStepView>>
}

type LineSummaryView = {
  base: string
  baseSha?: string
  counts?: Record<string, number>
  items: LineItemView[]
}

type LineStatusView = {
  line?: LineSummaryView | LineItemView
  pr?: { id?: string; state?: string }
  detail?: string
}

type LineStatusTargetView = LineStatusView & {
  selector: string
}

type ParsedFinish = {
  target: string
  ok: boolean
  step: "check"
  token?: string
  detail?: string
  url?: string
  artifacts: string[]
  exitCode?: string
  durationMs?: string
}

function parseIntegrateArgs(args: string[]): ParsedIntegrate {
  let target: string | undefined
  let stepsRaw: string | undefined
  let retry = false
  const passthrough: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--steps") {
      const value = args[++i]
      if (value === undefined) fail("yrd: line integrate: --steps requires a comma-separated value")
      stepsRaw = value
      continue
    }
    if (arg.startsWith("--steps=")) {
      stepsRaw = arg.slice("--steps=".length)
      continue
    }
    if (arg === "--retry") {
      retry = true
      continue
    }
    if (arg === "--watch") {
      passthrough.push(arg)
      continue
    }
    if (arg === "--interval") {
      const value = args[++i]
      if (value === undefined) fail("yrd: line integrate: --interval requires a value")
      passthrough.push(arg, value)
      continue
    }
    if (arg.startsWith("--interval=")) {
      passthrough.push("--interval", arg.slice("--interval=".length))
      continue
    }
    if (arg === "--help" || arg === "-h") {
      console.log(LINE_USAGE)
      process.exit(0)
    }
    if (arg.startsWith("-")) fail(`yrd: line integrate: unknown option '${arg}'`)
    if (target !== undefined) fail(`yrd: line integrate: unexpected extra argument '${arg}'`)
    target = arg
  }

  return { target, steps: parseSteps(stepsRaw), retry, passthrough }
}

function parseStatusArgs(args: string[]): { targets: string[]; json: boolean } {
  const targets: string[] = []
  let json = false
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      console.log(LINE_USAGE)
      process.exit(0)
    }
    if (arg === "--json") {
      json = true
      continue
    }
    if (arg.startsWith("-")) fail(`yrd: line status: unknown option '${arg}'`)
    targets.push(arg)
  }
  return { targets, json }
}

function parseLineLifecycleArgs(args: string[], verb: "provision" | "deprovision"): ParsedLineLifecycle {
  let base: string | undefined
  let json = false
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      console.log(LINE_USAGE)
      process.exit(0)
    }
    if (arg === "--json") {
      json = true
      continue
    }
    if (arg.startsWith("-")) fail(`yrd: line ${verb}: unknown option '${arg}'`)
    if (base !== undefined) fail(`yrd: line ${verb}: unexpected extra argument '${arg}'`)
    base = arg
  }
  return { base, json }
}

function parseFinishArgs(args: string[]): ParsedFinish {
  let target: string | undefined
  let step = "check"
  let ok = false
  let failResult = false
  let token: string | undefined
  let detail: string | undefined
  let url: string | undefined
  const artifacts: string[] = []
  let exitCode: string | undefined
  let durationMs: string | undefined

  const valueAfter = (argv: string[], index: number, name: string): string => {
    const value = argv[index + 1]
    if (value === undefined) fail(`yrd: line finish: ${name} requires a value`)
    return value
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--help" || arg === "-h") {
      console.log(LINE_USAGE)
      process.exit(0)
    }
    if (arg === "--ok") {
      ok = true
      continue
    }
    if (arg === "--fail") {
      failResult = true
      continue
    }
    if (arg === "--step") {
      step = valueAfter(args, i, "--step")
      i++
      continue
    }
    if (arg.startsWith("--step=")) {
      step = arg.slice("--step=".length)
      continue
    }
    if (arg === "--token") {
      token = valueAfter(args, i, "--token")
      i++
      continue
    }
    if (arg.startsWith("--token=")) {
      token = arg.slice("--token=".length)
      continue
    }
    if (arg === "--detail") {
      detail = valueAfter(args, i, "--detail")
      i++
      continue
    }
    if (arg.startsWith("--detail=")) {
      detail = arg.slice("--detail=".length)
      continue
    }
    if (arg === "--url") {
      url = valueAfter(args, i, "--url")
      i++
      continue
    }
    if (arg.startsWith("--url=")) {
      url = arg.slice("--url=".length)
      continue
    }
    if (arg === "--artifact") {
      artifacts.push(valueAfter(args, i, "--artifact"))
      i++
      continue
    }
    if (arg.startsWith("--artifact=")) {
      artifacts.push(arg.slice("--artifact=".length))
      continue
    }
    if (arg === "--exit-code") {
      exitCode = valueAfter(args, i, "--exit-code")
      i++
      continue
    }
    if (arg.startsWith("--exit-code=")) {
      exitCode = arg.slice("--exit-code=".length)
      continue
    }
    if (arg === "--duration-ms") {
      durationMs = valueAfter(args, i, "--duration-ms")
      i++
      continue
    }
    if (arg.startsWith("--duration-ms=")) {
      durationMs = arg.slice("--duration-ms=".length)
      continue
    }
    if (arg.startsWith("-")) fail(`yrd: line finish: unknown option '${arg}'`)
    if (target !== undefined) fail(`yrd: line finish: unexpected extra argument '${arg}'`)
    target = arg
  }

  if (target === undefined || target.trim() === "") fail("yrd: line finish: PR or name is required")
  if (step !== "check") fail(`yrd: line finish: unsupported step '${step}' (installed async finish: check)`)
  if (ok === failResult) fail("yrd: line finish: choose exactly one of --ok or --fail")
  return {
    target,
    ok,
    step: "check",
    ...(token !== undefined ? { token } : {}),
    ...(detail !== undefined ? { detail } : {}),
    ...(url !== undefined ? { url } : {}),
    artifacts,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  }
}

function writeCaptured(res: Awaited<ReturnType<typeof runCommand>>): void {
  if (res.stdout !== "") process.stdout.write(res.stdout)
  if (res.stderr !== "") process.stderr.write(res.stderr)
}

function requireCommandOk(res: Awaited<ReturnType<typeof runCommand>>): void {
  if (res.code === 0) return
  writeCaptured(res)
  process.exit(res.code)
}

function formatCounts(counts: Record<string, number> | undefined): string {
  if (counts === undefined) return ""
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([state, count]) => `${state}=${count}`)
    .join(", ")
}

function formatStep(name: LineStepName, step: LineStepView | undefined): string {
  if (step === undefined) return `${name}=-`
  const status = step.waiting === true ? "waiting" : step.skipped === true ? "skipped" : step.ok === true ? "ok" : "failed"
  const code = !step.ok && step.error?.code !== undefined ? `:${step.error.code}` : ""
  const duration = step.durationMs !== undefined ? ` ${step.durationMs}ms` : ""
  const artifacts = Array.isArray(step.artifacts) && step.artifacts.length > 0 ? ` artifacts=${step.artifacts.length}` : ""
  const url = step.url !== undefined ? ` url=${step.url}` : ""
  return `${name}=${status}${code}${duration}${artifacts}${url}`
}

function formatLineItem(item: LineItemView): string {
  const check = formatStep("check", item.steps?.check)
  const merge = formatStep("merge", item.steps?.merge)
  const deploy = formatStep("deploy", item.steps?.deploy)
  const staleReasons = item.stale === true ? item.staleReasons?.join("; ") || "yes" : ""
  const stale = staleReasons === "" ? "" : ` stale=${staleReasons}`
  return `${item.pr} ${item.state} target=${item.target} ${check} ${merge} ${deploy}${stale}`
}

function formatLineSummary(line: LineSummaryView): string {
  const base = line.baseSha === undefined ? line.base : `${line.base}@${line.baseSha.slice(0, 12)}`
  const counts = formatCounts(line.counts)
  const countPart = counts === "" ? "" : ` (${counts})`
  if (line.items.length === 0) return `line ${base} - no open PRs${countPart}`
  const label = line.items.length === 1 ? "1 open PR" : `${line.items.length} open PRs`
  return [`line ${base} - ${label}${countPart}`, ...line.items.map(formatLineItem)].join("\n")
}

function formatLineStatus(view: LineStatusView): string {
  const line = view.line
  if (line !== undefined) {
    if ("items" in line) return formatLineSummary(line)
    return formatLineItem(line)
  }
  const id = view.pr?.id ?? "PR?"
  const state = view.pr?.state ?? "unknown"
  const detail = view.detail === undefined || view.detail.trim() === "" ? "" : ` - ${view.detail.split("\n")[0]}`
  return `${id} ${state} - not on the active line${detail}`
}

async function lineStatus(args: string[]): Promise<void> {
  const parsed = parseStatusArgs(args)
  const paths = await resolveRepoPaths()
  if (parsed.targets.length > 1) {
    const targets: LineStatusTargetView[] = []
    for (const target of parsed.targets) {
      const res = await runGitBay(["ls", target, "--json"], paths.repo)
      requireCommandOk(res)
      targets.push({ selector: target, ...(JSON.parse(res.stdout) as LineStatusView) })
    }
    if (parsed.json) {
      console.log(JSON.stringify({ targets }))
      return
    }
    console.log(targets.map(formatLineStatus).join("\n"))
    return
  }

  const target = parsed.targets[0]
  const lsArgs = ["ls", ...(target === undefined ? [] : [target]), "--json"]
  const res = await runGitBay(lsArgs, paths.repo)
  requireCommandOk(res)
  if (parsed.json) {
    process.stdout.write(res.stdout)
    return
  }
  console.log(formatLineStatus(JSON.parse(res.stdout) as LineStatusView))
}

function mergedPrsFrom(output: string): string[] {
  const seen = new Set<string>()
  for (const match of output.matchAll(/bay: (PR\d+) merging → merged\b/gu)) {
    seen.add(match[1]!)
  }
  return [...seen]
}

async function runGitBayAndWrite(args: string[], cwd: string): Promise<Awaited<ReturnType<typeof runCommand>>> {
  const res = await runGitBay(args, cwd)
  writeCaptured(res)
  return res
}

async function runDeployStep(paths: Awaited<ReturnType<typeof resolveRepoPaths>>, target: string): Promise<void> {
  const res = await runGitBayAndWrite(["deploy", target], paths.repo)
  if (res.code !== 0) process.exit(res.code)
}

function isWatch(parsed: ParsedIntegrate): boolean {
  return parsed.passthrough.includes("--watch")
}

function parseWatchIntervalSec(parsed: ParsedIntegrate): number {
  const index = parsed.passthrough.indexOf("--interval")
  const raw = index === -1 ? "15" : parsed.passthrough[index + 1]
  const interval = Number(raw)
  if (!Number.isFinite(interval) || interval <= 0) {
    fail(`yrd: line integrate: --interval must be a positive number of seconds, got '${raw ?? ""}'`)
  }
  return interval
}

async function lineWatchWithDeploy(parsed: ParsedIntegrate): Promise<void> {
  const paths = await resolveRepoPaths()
  const intervalMs = parseWatchIntervalSec(parsed) * 1000
  let target = parsed.target

  for (;;) {
    const integrated = await runGitBayAndWrite(["integrate", ...(target === undefined ? [] : [target])], paths.repo)
    if (integrated.code !== 0) process.exit(integrated.code)
    for (const pr of mergedPrsFrom(integrated.stdout)) {
      await runDeployStep(paths, pr)
    }
    target = undefined
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

async function lineIntegrate(args: string[]): Promise<void> {
  const parsed = parseIntegrateArgs(args)
  const stepKey = parsed.steps.join(",")
  const includesDeploy = parsed.steps.includes("deploy")

  if (parsed.retry) {
    if (parsed.target === undefined) fail("yrd: line integrate: --retry requires a PR or name")
    if (stepKey !== "check,merge") {
      fail("yrd: line integrate: --retry resumes the configured line; use --steps check,merge or omit --steps")
    }
    if (parsed.passthrough.length > 0) fail("yrd: line integrate: --retry does not support --watch/--interval")
    await reenterGitBay(["retry", parsed.target])
    return
  }

  if (includesDeploy) {
    if (parsed.steps.at(-1) !== "deploy") {
      fail(`yrd: line integrate: deploy must be the final step (got '${stepKey}')`)
    }
    if (stepKey !== "deploy" && stepKey !== "merge,deploy" && stepKey !== "check,merge,deploy") {
      fail(`yrd: line integrate: unsupported step order '${stepKey}' (installed sequence: check,merge,deploy)`)
    }
    if (isWatch(parsed)) {
      if (stepKey !== "check,merge,deploy") {
        fail("yrd: line integrate: --watch with deploy runs the full line; use --steps check,merge,deploy")
      }
      await lineWatchWithDeploy(parsed)
      return
    }
    if (parsed.passthrough.length > 0) fail("yrd: line integrate: deploy does not support --interval without --watch")

    const paths = await resolveRepoPaths()
    if (stepKey === "deploy") {
      if (parsed.target === undefined) fail("yrd: line integrate --steps deploy requires a PR or name")
      await runDeployStep(paths, parsed.target)
      return
    }

    if (stepKey === "merge,deploy") {
      if (parsed.target === undefined) fail("yrd: line integrate --steps merge,deploy requires a PR or name")
      const merged = await runGitBayAndWrite(["merge", parsed.target], paths.repo)
      if (merged.code !== 0) process.exit(merged.code)
      await runDeployStep(paths, parsed.target)
      return
    }

    const integrated = await runGitBayAndWrite(["integrate", ...(parsed.target === undefined ? [] : [parsed.target])], paths.repo)
    if (integrated.code !== 0) process.exit(integrated.code)
    for (const pr of parsed.target === undefined ? mergedPrsFrom(integrated.stdout) : [parsed.target]) {
      await runDeployStep(paths, pr)
    }
    return
  }

  if (stepKey === "check") {
    if (parsed.target === undefined) fail("yrd: line integrate --steps check requires a PR or name")
    if (parsed.passthrough.length > 0) fail("yrd: line integrate --steps check does not support --watch/--interval")
    await reenterGitBay(["check", parsed.target])
    return
  }

  if (stepKey === "merge") {
    if (parsed.target === undefined) fail("yrd: line integrate --steps merge requires a PR or name")
    if (parsed.passthrough.length > 0) fail("yrd: line integrate --steps merge does not support --watch/--interval")
    await reenterGitBay(["merge", parsed.target])
    return
  }

  if (stepKey !== "check,merge") {
    fail(`yrd: line integrate: unsupported step order '${stepKey}' (installed sequence: check,merge,deploy)`)
  }

  await reenterGitBay(["integrate", ...(parsed.target === undefined ? [] : [parsed.target]), ...parsed.passthrough])
}

async function lineFinish(args: string[]): Promise<void> {
  const parsed = parseFinishArgs(args)
  await reenterGitBay([
    "check-finish",
    parsed.target,
    parsed.ok ? "--ok" : "--fail",
    ...(parsed.token === undefined ? [] : ["--token", parsed.token]),
    ...(parsed.detail === undefined ? [] : ["--detail", parsed.detail]),
    ...(parsed.url === undefined ? [] : ["--url", parsed.url]),
    ...parsed.artifacts.flatMap((artifact) => ["--artifact", artifact]),
    ...(parsed.exitCode === undefined ? [] : ["--exit-code", parsed.exitCode]),
    ...(parsed.durationMs === undefined ? [] : ["--duration-ms", parsed.durationMs]),
  ])
}

async function resolveLineBase(repo: string, requested: string | undefined): Promise<{ base: string; baseSha: string }> {
  const base = requested ?? (await resolveBaseRef(repo))
  const resolved = await git(["-C", repo, "rev-parse", "--verify", "--quiet", `${base}^{commit}`], repo)
  if (resolved.code !== 0 || resolved.stdout.trim() === "") {
    domainError(`line: cannot resolve base '${base}'`)
  }
  return { base, baseSha: resolved.stdout.trim() }
}

async function resolveProvisionCommand(repo: string): Promise<string | undefined> {
  const command = await resolveOption(undefined, "provision", createGitConfigSource(repo))
  return command === undefined || command.trim() === "" ? undefined : command
}

async function lineProvision(args: string[]): Promise<void> {
  const parsed = parseLineLifecycleArgs(args, "provision")
  const paths = await resolveRepoPaths()
  const { base, baseSha } = await resolveLineBase(paths.repo, parsed.base)
  const provisionCommand = await resolveProvisionCommand(paths.repo)
  const scratch = createScratchWorkspaces({
    mainRepo: paths.repo,
    provisionCommand,
    prefix: "yrd-line-provision-",
  })
  const lease = await scratch.acquire(baseSha, { provision: true })
  const scratchPath = lease.path
  try {
    const actualSha = await git(["-C", scratchPath, "rev-parse", "HEAD"], scratchPath)
    if (actualSha.code !== 0 || actualSha.stdout.trim() !== baseSha) {
      domainError(`line provision: scratch resolved ${actualSha.stdout.trim() || "unknown"} instead of ${baseSha}`)
    }
  } finally {
    await lease.dispose()
  }

  const result = {
    line: {
      base,
      baseSha,
      provisioned: true,
      ...(provisionCommand === undefined ? {} : { provisionCommand }),
    },
    scratch: { path: scratchPath, released: true },
  }
  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  const configured = provisionCommand === undefined ? "no bay.provision configured" : "bay.provision ok"
  console.log(`yrd: line ${base} provisioned at ${baseSha.slice(0, 12)} (${configured}; scratch released)`)
}

async function lineDeprovision(args: string[]): Promise<void> {
  const parsed = parseLineLifecycleArgs(args, "deprovision")
  const paths = await resolveRepoPaths()
  const { base, baseSha } = await resolveLineBase(paths.repo, parsed.base)
  const result = {
    line: {
      base,
      baseSha,
      deprovisioned: true,
      persistentResources: false,
    },
  }
  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`yrd: line ${base} has no persistent resources to deprovision (${baseSha.slice(0, 12)})`)
}

async function lineProjection(args: string[]): Promise<void> {
  const command = args[0]
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    console.log(LINE_USAGE)
    return
  }
  if (command === "status") {
    await lineStatus(args.slice(1))
    return
  }
  if (command === "audit") {
    await reenterGitBay(["audit", ...args.slice(1)])
    return
  }
  if (command === "watch") {
    await lineIntegrate([...args.slice(1), "--watch"])
    return
  }
  if (command === "integrate") {
    await lineIntegrate(args.slice(1))
    return
  }
  if (command === "finish") {
    await lineFinish(args.slice(1))
    return
  }
  if (command === "provision") {
    await lineProvision(args.slice(1))
    return
  }
  if (command === "deprovision") {
    await lineDeprovision(args.slice(1))
    return
  }
  fail(`yrd: unknown line command '${command}' (installed: status, audit, provision, deprovision, integrate, finish, watch)`)
}

async function runGitBay(args: string[], cwd: string) {
  return await runCommand([process.execPath, GIT_BAY_TS, ...args], cwd)
}

function requireOk(res: Awaited<ReturnType<typeof runCommand>>, label: string): void {
  if (res.code === 0) return
  const said = [res.stderr.trim(), res.stdout.trim()].filter((part) => part !== "").join("\n")
  domainError(`${label} failed (exit ${res.code})${said === "" ? "" : `:\n${said}`}`)
}

function parseList(raw: string): string[] {
  const normalized = raw.trim().startsWith("ag ") ? raw.trim().slice("ag ".length) : raw
  return normalized
    .split(/[\/,]/)
    .map((part) => part.trim())
    .filter((part) => part !== "")
}

function parseAgentCommand(raw: string): [string, string] {
  const eq = raw.indexOf("=")
  if (eq <= 0) fail("yrd: task compete: --agent-cmd requires <name=command>")
  const name = raw.slice(0, eq).trim()
  const command = raw.slice(eq + 1).trim()
  if (name === "" || command === "") fail("yrd: task compete: --agent-cmd requires <name=command>")
  return [name, command]
}

function parseAgentCost(raw: string): [string, ContestCostRates] {
  try {
    return parseContestAgentCost(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    fail(`yrd: task compete: --agent-cost ${message}`)
  }
}

async function parseCompeteArgs(args: string[]): Promise<CompeteOptions & { bays?: number }> {
  let task: string | undefined
  let prompt: string | undefined
  let promptFile: string | undefined
  let agents = ["codex", "claude"]
  let base = "main"
  let bays: number | undefined
  let json = false
  const agentCommands = new Map<string, string>()
  const costAdapters = new Map<string, ContestCostRates>()
  const evalCommands: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const valueAfter = (name: string): string => {
      const value = args[++i]
      if (value === undefined) fail(`yrd: task compete: ${name} requires a value`)
      return value
    }
    if (arg === "--help" || arg === "-h") {
      console.log(TASK_USAGE)
      process.exit(0)
    }
    if (arg === "--agents") {
      agents = parseList(valueAfter("--agents"))
      continue
    }
    if (arg.startsWith("--agents=")) {
      agents = parseList(arg.slice("--agents=".length))
      continue
    }
    if (arg === "--agent-cmd") {
      const [name, command] = parseAgentCommand(valueAfter("--agent-cmd"))
      agentCommands.set(name, command)
      continue
    }
    if (arg.startsWith("--agent-cmd=")) {
      const [name, command] = parseAgentCommand(arg.slice("--agent-cmd=".length))
      agentCommands.set(name, command)
      continue
    }
    if (arg === "--agent-cost" || arg === "--cost-adapter") {
      const [name, rates] = parseAgentCost(valueAfter(arg))
      costAdapters.set(name, rates)
      continue
    }
    if (arg.startsWith("--agent-cost=")) {
      const [name, rates] = parseAgentCost(arg.slice("--agent-cost=".length))
      costAdapters.set(name, rates)
      continue
    }
    if (arg.startsWith("--cost-adapter=")) {
      const [name, rates] = parseAgentCost(arg.slice("--cost-adapter=".length))
      costAdapters.set(name, rates)
      continue
    }
    if (arg === "--eval" || arg === "--eval-cmd") {
      evalCommands.push(valueAfter(arg))
      continue
    }
    if (arg.startsWith("--eval=")) {
      evalCommands.push(arg.slice("--eval=".length))
      continue
    }
    if (arg === "--prompt") {
      prompt = valueAfter("--prompt")
      continue
    }
    if (arg.startsWith("--prompt=")) {
      prompt = arg.slice("--prompt=".length)
      continue
    }
    if (arg === "--prompt-file") {
      promptFile = valueAfter("--prompt-file")
      continue
    }
    if (arg.startsWith("--prompt-file=")) {
      promptFile = arg.slice("--prompt-file=".length)
      continue
    }
    if (arg === "--base") {
      base = valueAfter("--base")
      continue
    }
    if (arg.startsWith("--base=")) {
      base = arg.slice("--base=".length)
      continue
    }
    if (arg === "--bays") {
      bays = Number(valueAfter("--bays"))
      continue
    }
    if (arg.startsWith("--bays=")) {
      bays = Number(arg.slice("--bays=".length))
      continue
    }
    if (arg === "--json") {
      json = true
      continue
    }
    if (arg.startsWith("-")) fail(`yrd: task compete: unknown option '${arg}'`)
    if (task !== undefined) fail(`yrd: task compete: unexpected extra argument '${arg}'`)
    task = arg
  }

  if (task === undefined || task.trim() === "") fail("yrd: task compete: task is required")
  if (agents.length === 0) fail("yrd: task compete: --agents must name at least one competitor")
  if (bays !== undefined && (!Number.isInteger(bays) || bays < 1)) {
    fail("yrd: task compete: --bays must be a positive integer")
  }
  if (bays !== undefined && bays !== agents.length) {
    fail(`yrd: task compete: --bays ${bays} does not match ${agents.length} agent(s)`)
  }
  if (promptFile !== undefined) prompt = await readFile(promptFile, "utf8")
  prompt ??= `Implement this task: ${task}`
  return { task, prompt, agents, base, agentCommands, costAdapters, evalCommands, json, bays }
}

async function taskCompete(args: string[]): Promise<void> {
  const parsed = await parseCompeteArgs(args)
  const paths = await resolveRepoPaths()
  let costAdapters: Map<string, ContestCostRates>
  try {
    costAdapters = await resolveContestCostAdapters(parsed.agents, parsed.costAdapters, createGitConfigSource(paths.repo))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    fail(`yrd: task compete: invalid cost adapter config: ${message}`)
  }
  const init = await runGitBay(["init"], paths.repo)
  requireOk(init, "yrd: task compete: git bay init")

  const base = await runCommand(["git", "rev-parse", parsed.base], paths.repo)
  requireOk(base, `yrd: task compete: cannot resolve base '${parsed.base}'`)
  const baseSha = base.stdout.trim()
  const id = await nextContestId(paths.bayDir)
  const contestDir = contestPath(paths.bayDir, id).replace(/\/contest\.json$/, "")
  const appendEvent = createContestEventAppender(paths.bayDir, { commandId: `yrd:task:compete:${id}` })
  const record: ContestRecord = {
    version: 1,
    id,
    task: parsed.task,
    prompt: parsed.prompt,
    repo: paths.repo,
    base: parsed.base,
    baseSha,
    createdAt: new Date().toISOString(),
    agents: parsed.agents,
    attempts: [],
  }
  await writeContest(paths.bayDir, record)
  await appendEvent(
    "contest/opened",
    {
      contest: id,
      task: record.task,
      prompt: record.prompt,
      repo: record.repo,
      base: record.base,
      baseSha: record.baseSha,
      agents: record.agents,
    },
    "opened",
  )

  const opened: { id: string; agent: string; bayName: string; bayPath: string }[] = []
  for (const [index, agent] of parsed.agents.entries()) {
    const bayName = `contest-${id.toLowerCase()}-${sanitizePart(parsed.task)}-${sanitizePart(agent)}`
    const open = await runGitBay(["open", bayName], paths.repo)
    requireOk(open, `yrd: task compete: open bay for ${agent}`)
    opened.push({ id: `A${index + 1}`, agent, bayName, bayPath: open.stdout.trim() })
  }

  record.attempts = await Promise.all(
    opened.map((attempt) =>
      runAttempt({
        id: attempt.id,
        agent: attempt.agent,
        bayName: attempt.bayName,
        bayPath: attempt.bayPath,
        task: parsed.task,
        prompt: parsed.prompt,
        baseSha,
        contestDir,
        agentCommands: parsed.agentCommands,
        costAdapters,
        evalCommands: parsed.evalCommands,
        appendEvent,
      }),
    ),
  )
  await writeContest(paths.bayDir, record)
  console.log(parsed.json ? JSON.stringify(record) : formatContest(record))
}

async function taskProjection(args: string[]): Promise<void> {
  const command = args[0]
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    console.log(TASK_USAGE)
    return
  }
  if (command === "compete") {
    await taskCompete(args.slice(1))
    return
  }
  fail(`yrd: unknown task command '${command}' (installed: compete)`)
}

async function contestShow(args: string[]): Promise<void> {
  const id = args.find((arg) => !arg.startsWith("-"))
  const json = args.includes("--json")
  if (args.some((arg) => arg !== "--json" && arg.startsWith("-"))) fail("yrd: contest show: unknown option")
  if (id === undefined) fail("yrd: contest show: contest id is required")
  const paths = await resolveRepoPaths()
  const record = await readContest(paths.bayDir, id)
  console.log(json ? JSON.stringify(record) : formatContest(record))
}

async function contestSelect(args: string[]): Promise<void> {
  const id = args.find((arg) => !arg.startsWith("-"))
  let winner: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--winner") {
      winner = args[++i]
      if (winner === undefined) fail("yrd: contest select: --winner requires an attempt id")
      continue
    }
    if (arg.startsWith("--winner=")) {
      winner = arg.slice("--winner=".length)
      continue
    }
    if (arg.startsWith("-")) fail(`yrd: contest select: unknown option '${arg}'`)
  }
  if (id === undefined) fail("yrd: contest select: contest id is required")
  if (winner === undefined || winner === "") fail("yrd: contest select: --winner is required")
  const paths = await resolveRepoPaths()
  const record = await readContest(paths.bayDir, id)
  if (!record.attempts.some((attempt) => attempt.id === winner)) {
    domainError(`yrd: contest select: ${id} has no attempt '${winner}'`)
  }
  record.winner = winner
  await writeContest(paths.bayDir, record)
  await createContestEventAppender(paths.bayDir, { commandId: `yrd:contest:select:${id}` })(
    "contest/selected",
    { contest: id, winner },
    `winner:${winner}`,
  )
  console.log(`yrd: ${id} winner ${winner}`)
}

async function contestPromote(args: string[]): Promise<void> {
  const id = args.find((arg) => !arg.startsWith("-"))
  const force = args.includes("--force")
  if (args.some((arg) => arg !== "--force" && arg.startsWith("-"))) fail("yrd: contest promote: unknown option")
  if (id === undefined) fail("yrd: contest promote: contest id is required")
  const paths = await resolveRepoPaths()
  const record = await readContest(paths.bayDir, id)
  if (record.winner === undefined) domainError(`yrd: contest promote: ${id} has no selected winner`)
  const attempt = record.attempts.find((item) => item.id === record.winner)
  if (attempt === undefined) domainError(`yrd: contest promote: winner '${record.winner}' is missing`)
  if (attempt.exitCode !== 0 && !force) {
    domainError(`yrd: contest promote: ${attempt.id} exited ${attempt.exitCode}; use --force to promote anyway`)
  }
  if (!attempt.git.committed && !force) {
    domainError(`yrd: contest promote: ${attempt.id} has no committed changes; use --force to push anyway`)
  }

  const push = await runCommand(["git", "-C", attempt.bayPath, "push"], attempt.bayPath)
  if (push.code !== 0) {
    record.promoted = { attempt: attempt.id, at: new Date().toISOString(), push, submit: { code: -1, stdout: "", stderr: "" } }
    await writeContest(paths.bayDir, record)
    requireOk(push, `yrd: contest promote: git push for ${attempt.id}`)
  }
  const submit = await runGitBay(["submit", attempt.bayName], paths.repo)
  const pr = parsePrFromText(`${push.stdout}\n${push.stderr}\n${submit.stdout}\n${submit.stderr}`)
  record.promoted = { attempt: attempt.id, at: new Date().toISOString(), push, submit, ...(pr === undefined ? {} : { pr }) }
  await writeContest(paths.bayDir, record)
  await createContestEventAppender(paths.bayDir, { commandId: `yrd:contest:promote:${id}` })(
    "contest/promoted",
    {
      contest: id,
      attempt: attempt.id,
      ...(pr === undefined ? {} : { pr }),
      push,
      submit,
    },
    `attempt:${attempt.id}`,
  )
  requireOk(submit, `yrd: contest promote: submit ${attempt.bayName}`)
  console.log(`yrd: ${id} promoted ${attempt.id}${pr === undefined ? "" : ` as ${pr}`}`)
}

async function contestProjection(args: string[]): Promise<void> {
  const command = args[0]
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    console.log(CONTEST_USAGE)
    return
  }
  if (command === "show") {
    await contestShow(args.slice(1))
    return
  }
  if (command === "select") {
    await contestSelect(args.slice(1))
    return
  }
  if (command === "promote") {
    await contestPromote(args.slice(1))
    return
  }
  fail(`yrd: unknown contest command '${command}' (installed: show, select, promote)`)
}

async function main(): Promise<void> {
  if (projection === undefined || projection === "--help" || projection === "-h" || projection === "help") {
    printUsage()
  } else if (projection === "bay") {
    await reenterGitBay(process.argv.slice(3))
  } else if (projection === "line") {
    await lineProjection(process.argv.slice(3))
  } else if (projection === "task") {
    await taskProjection(process.argv.slice(3))
  } else if (projection === "contest") {
    await contestProjection(process.argv.slice(3))
  } else {
    fail(`yrd: unknown projection '${projection}' (installed: bay, line, task, contest)`)
  }
}

await main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err)
  console.error(message.startsWith("yrd:") ? message : `yrd: ${message}`)
  process.exit(1)
})

export {}
