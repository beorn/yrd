#!/usr/bin/env bun
import { readFile } from "node:fs/promises"
import {
  contestPath,
  formatContest,
  nextContestId,
  parsePrFromText,
  readContest,
  resolveRepoPaths,
  runAttempt,
  runCommand,
  sanitizePart,
  writeContest,
  type CompeteOptions,
  type ContestRecord,
} from "../src/contest.ts"

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
  yrd task compete <task> --agents codex,claude [options]
  yrd contest <verb> [args]

Installed projections: bay, line, task, contest
`

const LINE_USAGE = `yrd line — integration line projection

USAGE
  yrd line status [PR|name] [--json]
  yrd line audit [--json]
  yrd line integrate [PR|name] [--steps check,merge] [--retry] [--watch] [--interval <sec>]
  yrd line watch [PR|name] [--interval <sec>]

Installed steps: check, merge
Staged steps: deploy
`

const TASK_USAGE = `yrd task — task intake projection

USAGE
  yrd task compete <task> [--agents codex,claude] [--prompt <text>] [--prompt-file <path>]
                   [--agent-cmd <name=command>] [--eval <command>] [--base <ref>] [--bays <n>] [--json]

Built-in contest agents: codex, claude
Custom commands run with YRD_PROMPT, YRD_TASK, YRD_BAY, YRD_AGENT, and YRD_CONTEST_ATTEMPT in env.
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

function parseSteps(raw: string | undefined): string[] {
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
    if (step === "deploy") {
      fail("yrd: line integrate: step 'deploy' is staged, not installed yet (installed: check, merge)")
    }
    if (step !== "check" && step !== "merge") {
      fail(`yrd: line integrate: unknown step '${step}' (installed: check, merge; staged: deploy)`)
    }
  }
  return steps
}

type ParsedIntegrate = {
  target?: string
  steps: string[]
  retry: boolean
  passthrough: string[]
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

async function lineIntegrate(args: string[]): Promise<void> {
  const parsed = parseIntegrateArgs(args)
  const stepKey = parsed.steps.join(",")

  if (parsed.retry) {
    if (parsed.target === undefined) fail("yrd: line integrate: --retry requires a PR or name")
    if (stepKey !== "check,merge") {
      fail("yrd: line integrate: --retry resumes the configured line; use --steps check,merge or omit --steps")
    }
    if (parsed.passthrough.length > 0) fail("yrd: line integrate: --retry does not support --watch/--interval")
    await reenterGitBay(["retry", parsed.target])
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
    fail(`yrd: line integrate: unsupported step order '${stepKey}' (installed sequence: check,merge)`)
  }

  await reenterGitBay(["integrate", ...(parsed.target === undefined ? [] : [parsed.target]), ...parsed.passthrough])
}

async function lineProjection(args: string[]): Promise<void> {
  const command = args[0]
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    console.log(LINE_USAGE)
    return
  }
  if (command === "status") {
    await reenterGitBay(["ls", ...args.slice(1)])
    return
  }
  if (command === "audit") {
    await reenterGitBay(["audit", ...args.slice(1)])
    return
  }
  if (command === "watch") {
    await reenterGitBay(["integrate", ...args.slice(1), "--watch"])
    return
  }
  if (command === "integrate") {
    await lineIntegrate(args.slice(1))
    return
  }
  if (command === "provision" || command === "deprovision") {
    fail(`yrd: line ${command}: staged, not installed yet`)
  }
  fail(`yrd: unknown line command '${command}' (installed: status, audit, integrate, watch)`)
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
  return raw
    .split(",")
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

async function parseCompeteArgs(args: string[]): Promise<CompeteOptions & { bays?: number }> {
  let task: string | undefined
  let prompt: string | undefined
  let promptFile: string | undefined
  let agents = ["codex", "claude"]
  let base = "main"
  let bays: number | undefined
  let json = false
  const agentCommands = new Map<string, string>()
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
  return { task, prompt, agents, base, agentCommands, evalCommands, json, bays }
}

async function taskCompete(args: string[]): Promise<void> {
  const parsed = await parseCompeteArgs(args)
  const paths = await resolveRepoPaths()
  const init = await runGitBay(["init"], paths.repo)
  requireOk(init, "yrd: task compete: git bay init")

  const base = await runCommand(["git", "rev-parse", parsed.base], paths.repo)
  requireOk(base, `yrd: task compete: cannot resolve base '${parsed.base}'`)
  const baseSha = base.stdout.trim()
  const id = await nextContestId(paths.bayDir)
  const contestDir = contestPath(paths.bayDir, id).replace(/\/contest\.json$/, "")
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
        evalCommands: parsed.evalCommands,
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
