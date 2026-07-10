import { basename } from "node:path"
import type { YrdCliExitCode } from "./types.ts"

export type Invocation = Readonly<{
  name: string
  args: string[]
  projection: "root" | "bay"
}>

export type CliFailure = Error & Readonly<{ name: "CliFailure"; exitCode: YrdCliExitCode }>

function cliFailure(exitCode: YrdCliExitCode, message: string): CliFailure {
  return Object.assign(new Error(message), { name: "CliFailure" as const, exitCode })
}

function isCliFailure(error: unknown): error is CliFailure {
  return error instanceof Error && error.name === "CliFailure" && "exitCode" in error
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

const INFRASTRUCTURE =
  /(?:corrupt|event log|writer lock|lock (?:failed|failure|timed out)|append requires|sqlite|database|git unavailable|eacces|enoent|epipe|i\/o)/iu
const CONFIGURATION =
  /(?:capability is not installed|no handler registered|no .* (?:runner|evaluator|source) .* registered|requires at least one .* evaluator|configured|configuration|invalid .* step name|unknown step)/iu

export function classifyFailure(error: unknown): YrdCliExitCode {
  if (isCliFailure(error)) return error.exitCode
  const message = error instanceof Error ? error.message : String(error)
  if (INFRASTRUCTURE.test(message)) return 3
  if (CONFIGURATION.test(message)) return 2
  if (message.startsWith("yrd:")) return 1
  return 3
}

export function usage(message: string): never {
  throw cliFailure(2, message)
}

export function configuration(message: string): never {
  throw cliFailure(2, message)
}

export function refusal(message: string): never {
  throw cliFailure(1, message)
}
