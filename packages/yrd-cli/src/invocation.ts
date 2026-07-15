import { basename, resolve } from "node:path"
import { Command as CliCommand } from "@silvery/commander"
import { failureFact, raiseFailure, type FailureFact } from "@yrd/core"
import { resolveYrdObservability, type YrdObservability, type YrdObservabilityFlags } from "./observability.ts"
import type { YrdCliExitCode } from "./types.ts"

export type Invocation = Readonly<{
  name: string
  args: string[]
  projection: "root" | "bay"
}>

export type FailureVerdict = Readonly<{ exitCode: YrdCliExitCode; failure: FailureFact }>

export type YrdContext = Readonly<{
  /** Git path used to discover the repository and its operation root. */
  repo: string
  /** One host-owned logging policy shared by every command service. */
  observability: YrdObservability
}>

const increaseDiagnostics = (_value: string, previous: number): number => previous + 1

/** Install the one set of process-level options on a Commander root. */
export function configureYrdGlobalOptions(program: CliCommand): CliCommand {
  return program
    .option("--repo <path>", "repository authority and operation root (env: YRD_REPO)")
    .option("-v, --verbose", "increase diagnostics (-vv enables spans, -vvv traces)", increaseDiagnostics, 0)
    .option("-q, --quiet", "reduce diagnostics (-q errors only, -qq silent)", increaseDiagnostics, 0)
    .option("--log-level <level>", "set trace|debug|info|warn|error|silent (env: LOG_LEVEL)")
}

const ROOT_COMMAND_ALIASES = {
  bays: "bay",
  contests: "contest",
  issues: "issue",
  prs: "pr",
  queues: "queue",
} as const

const QUEUE_SUBCOMMANDS = new Set([
  "_list",
  "list",
  "audit",
  "init",
  "deinit",
  "pause",
  "resume",
  "recover",
  "run",
  "finish",
])

function rootCommandIndex(args: readonly string[]): number | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--repo" || arg === "--log-level") {
      index += 1
      continue
    }
    if (arg?.startsWith("-")) continue
    return index
  }
  return undefined
}

/** Translate parse-only legacy spellings before Commander sees them. This keeps
 * help and suggestions canonical without requiring a newer Commander API. */
export function canonicalizeYrdCommandAliases(args: readonly string[], projection: Invocation["projection"]): string[] {
  const canonical = [...args]
  if (projection !== "root") return canonical

  const commandIndex = rootCommandIndex(canonical)
  if (commandIndex === undefined) return canonical
  const command = canonical[commandIndex]
  const alias = command === undefined ? undefined : ROOT_COMMAND_ALIASES[command as keyof typeof ROOT_COMMAND_ALIASES]
  if (alias !== undefined) canonical[commandIndex] = alias

  if (canonical[commandIndex] === "watch") {
    canonical.splice(commandIndex, 1, "queue", "list", "--watch")
  }

  if (
    (canonical[commandIndex] === "pr" || canonical[commandIndex] === "queue") &&
    canonical[commandIndex + 1] === "ls"
  ) {
    canonical[commandIndex + 1] = "list"
  }
  if (canonical[commandIndex] === "queue" && !QUEUE_SUBCOMMANDS.has(canonical[commandIndex + 1] ?? "")) {
    canonical.splice(commandIndex + 1, 0, "list")
  }
  return canonical
}

/** Resolve the command operand with Commander's canonical global-option rules. */
export function yrdCommandOperand(args: readonly string[]): string | undefined {
  const parser = configureYrdGlobalOptions(new CliCommand("yrd"))
  return parser.parseOptions([...args]).operands[0]
}

/** Resolve the one repository selector against the captured invocation
 * directory. CLI overrides environment; ambient discovery is the fallback. */
export function resolveYrdContext(
  options: Readonly<{ repo?: string }> & YrdObservabilityFlags,
  env: Readonly<Record<string, string | undefined>>,
  ambientCwd: string,
): YrdContext {
  const ambient = resolve(ambientCwd)
  return Object.freeze({
    repo: resolve(ambient, options.repo ?? env.YRD_REPO ?? "."),
    observability: resolveYrdObservability(options, env),
  })
}

function executableName(value: string | undefined): string {
  if (value === undefined) return ""
  return basename(value).replace(/\.(?:[cm]?[jt]s)$/u, "")
}

function presentation(executable: string): Pick<Invocation, "name" | "projection"> | undefined {
  if (executable === "git-bay") return { name: "git bay", projection: "bay" }
  if (executable === "git-yrd") return { name: "git yrd", projection: "root" }
  if (executable === "yrd") return { name: "yrd", projection: "root" }
  return undefined
}

/** Resolve process.argv, direct argv, and Git's two-token spelling. git-bay is
 * a projection of the canonical bay subtree, not a separately defined CLI. */
export function resolveInvocation(argvInput: readonly string[]): Invocation {
  const argv = [...argvInput]
  const first = executableName(argv[0])
  const second = executableName(argv[1])
  if (first === "git" && argv[1] === "bay") return { name: "git bay", args: argv.slice(2), projection: "bay" }
  if (first === "git" && argv[1] === "yrd") return { name: "git yrd", args: argv.slice(2), projection: "root" }

  const direct = presentation(first)
  if (direct !== undefined) return { ...direct, args: argv.slice(1) }

  const script = presentation(second)
  if (script !== undefined) return { ...script, args: argv.slice(2) }

  return { name: "yrd", args: argv, projection: "root" }
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value))}\n`
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (typeof value !== "object" || value === null) return value
  const object = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => [key, stableValue(object[key])]),
  )
}

export function classifyFailure(error: unknown): FailureVerdict {
  const failure =
    failureFact(error) ??
    Object.freeze({
      kind: "infrastructure" as const,
      code: "unexpected",
      message: error instanceof Error ? error.message : String(error),
    })
  const exitCode = (
    failure.kind === "refusal" ? 1 : failure.kind === "usage" || failure.kind === "configuration" ? 2 : 3
  ) satisfies YrdCliExitCode
  return Object.freeze({ exitCode, failure })
}

export type UnrecognizedKeyFailure = Readonly<{ keys: readonly string[] }>

/** Journal rows written by a newer Yrd surface as Zod `unrecognized_keys`
 * issues, either bare (domain event replay) or as the cause of a journal
 * corruption error (storage frame decode). Detection duck-types the issue
 * shape because the raising Zod instance may not be this module's import. */
export function unrecognizedKeyFailure(error: unknown): UnrecognizedKeyFailure | undefined {
  const keys = new Set<string>()
  let cause: unknown = error
  for (let depth = 0; typeof cause === "object" && cause !== null && depth < 8; depth += 1) {
    const record = cause as Readonly<{ issues?: unknown; cause?: unknown }>
    if (Array.isArray(record.issues)) collectUnrecognizedKeys(record.issues, keys, 0)
    cause = record.cause
  }
  if (keys.size === 0) return undefined
  return Object.freeze({ keys: Object.freeze([...keys].sort()) })
}

function collectUnrecognizedKeys(issues: readonly unknown[], into: Set<string>, depth: number): void {
  if (depth > 4) return
  for (const issue of issues) {
    if (typeof issue !== "object" || issue === null) continue
    const record = issue as Readonly<{ code?: unknown; keys?: unknown; errors?: unknown }>
    if (record.code === "unrecognized_keys" && Array.isArray(record.keys)) {
      for (const key of record.keys) if (typeof key === "string") into.add(key)
    }
    if (record.code === "invalid_union" && Array.isArray(record.errors)) {
      for (const branch of record.errors) {
        if (Array.isArray(branch)) collectUnrecognizedKeys(branch, into, depth + 1)
      }
    }
  }
}

export function usage(message: string): never {
  raiseFailure("usage", "invalid-usage", message)
}

export function configuration(message: string): never {
  raiseFailure("configuration", "invalid-configuration", message)
}

export function refusal(message: string): never {
  raiseFailure("refusal", "request-refused", message)
}
