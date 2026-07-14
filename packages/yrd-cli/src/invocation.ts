import { basename, resolve } from "node:path"
import { failureFact, raiseFailure, type FailureFact } from "@yrd/core"
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
}>

/** Resolve the one repository selector against the captured invocation
 * directory. CLI overrides environment; ambient discovery is the fallback. */
export function resolveYrdContext(
  options: Readonly<{ repo?: string }>,
  env: Readonly<Record<string, string | undefined>>,
  ambientCwd: string,
): YrdContext {
  const ambient = resolve(ambientCwd)
  return Object.freeze({
    repo: resolve(ambient, options.repo ?? env.YRD_REPO ?? "."),
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

export function usage(message: string): never {
  raiseFailure("usage", "invalid-usage", message)
}

export function configuration(message: string): never {
  raiseFailure("configuration", "invalid-configuration", message)
}

export function refusal(message: string): never {
  raiseFailure("refusal", "request-refused", message)
}
