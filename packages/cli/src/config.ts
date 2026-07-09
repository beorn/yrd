import { readFile } from "node:fs/promises"
import { join } from "node:path"

export type YrdStepConfig = Readonly<{
  run?: string
  runner: "local" | "waiting"
  environment?: string
}>

export type YrdProjectConfig = Readonly<{
  line: Readonly<{ base?: string; batch?: false | number; steps?: readonly string[] }>
  steps: Readonly<Record<string, YrdStepConfig>>
  contest: Readonly<{ concurrency?: number; timeoutMs?: number; evaluators?: readonly string[] }>
}>

export type ResolvedYrdProjectConfig = Readonly<{
  line: Readonly<{ base: string; batch: false | number; steps: readonly string[] }>
  steps: Readonly<Record<string, YrdStepConfig>>
  contest: Readonly<{ concurrency: number; timeoutMs: number; evaluators: readonly string[] }>
}>

function fail(path: string, message: string): never {
  throw new Error(`yrd: config${path === "" ? "" : ` ${path}`} ${message}`)
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "must be an object")
  return value as Record<string, unknown>
}

function only(value: Record<string, unknown>, names: readonly string[], path: string): void {
  const unknown = Object.keys(value).find((name) => !names.includes(name))
  if (unknown !== undefined) fail(path === "" ? unknown : `${path}.${unknown}`, "is not supported")
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(path, "must be a non-empty string")
  return value
}

function integer(value: unknown, path: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(path, `must be an integer >= ${minimum}`)
  return value as number
}

function names(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail(path, "must be an array of step names")
  const result = value.map((name) => text(name, path))
  if (result.some((name) => !/^[a-z][a-z0-9_-]*$/iu.test(name))) fail(path, "contains an invalid step name")
  if (new Set(result).size !== result.length) fail(path, "contains duplicate steps")
  return result
}

function line(value: unknown): YrdProjectConfig["line"] {
  if (value === undefined) return {}
  const input = object(value, "line")
  only(input, ["base", "batch", "steps"], "line")
  const batch = input.batch
  if (batch !== undefined && batch !== false) integer(batch, "line.batch", 0)
  return {
    ...(input.base === undefined ? {} : { base: text(input.base, "line.base") }),
    ...(batch === undefined ? {} : { batch: batch as false | number }),
    ...(input.steps === undefined ? {} : { steps: names(input.steps, "line.steps") }),
  }
}

function steps(value: unknown): YrdProjectConfig["steps"] {
  if (value === undefined) return {}
  const input = object(value, "steps")
  return Object.fromEntries(
    Object.entries(input).map(([name, value]) => {
      if (!/^[a-z][a-z0-9_-]*$/iu.test(name)) fail("steps", `contains invalid step '${name}'`)
      if (typeof value === "string") return [name, { run: text(value, `steps.${name}`), runner: "local" }]
      const step = object(value, `steps.${name}`)
      only(step, ["run", "runner", "environment"], `steps.${name}`)
      const runner = step.runner ?? "local"
      if (runner !== "local" && runner !== "waiting") fail(`steps.${name}.runner`, "must be local or waiting")
      return [
        name,
        {
          ...(step.run === undefined ? {} : { run: text(step.run, `steps.${name}.run`) }),
          runner,
          ...(step.environment === undefined
            ? {}
            : { environment: text(step.environment, `steps.${name}.environment`) }),
        },
      ]
    }),
  )
}

function contest(value: unknown): YrdProjectConfig["contest"] {
  if (value === undefined) return {}
  const input = object(value, "contest")
  only(input, ["concurrency", "timeoutMs", "evaluators"], "contest")
  return {
    ...(input.concurrency === undefined ? {} : { concurrency: integer(input.concurrency, "contest.concurrency", 1) }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: integer(input.timeoutMs, "contest.timeoutMs", 1) }),
    ...(input.evaluators === undefined ? {} : { evaluators: names(input.evaluators, "contest.evaluators") }),
  }
}

export function parseYrdConfig(value: unknown): YrdProjectConfig {
  if (value === undefined || value === null) return { line: {}, steps: {}, contest: {} }
  const input = object(value, "")
  only(input, ["line", "steps", "contest"], "")
  return { line: line(input.line), steps: steps(input.steps), contest: contest(input.contest) }
}

async function defaultRead(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
}

export async function loadYrdConfig(options: {
  repo: string
  defaultBase: string
  read?: (path: string) => Promise<string | undefined>
}): Promise<{ path?: string; config: ResolvedYrdProjectConfig }> {
  const path = join(options.repo, ".yrd.yml")
  const source = await (options.read ?? defaultRead)(path)
  const parsed = parseYrdConfig(source === undefined ? undefined : Bun.YAML.parse(source))
  const steps = { ...parsed.steps }
  steps.check ??= { run: 'git diff --check "$YRD_BASE_SHA"..HEAD', runner: "local" }
  steps.merge ??= { runner: "local" }
  const defaultSteps = ["check", ...(steps.review ? ["review"] : []), "merge", ...(steps.deploy ? ["deploy"] : [])]
  return {
    ...(source === undefined ? {} : { path }),
    config: {
      line: {
        base: parsed.line.base ?? options.defaultBase,
        batch: parsed.line.batch ?? 1,
        steps: parsed.line.steps ?? defaultSteps,
      },
      steps,
      contest: {
        concurrency: parsed.contest.concurrency ?? 2,
        timeoutMs: parsed.contest.timeoutMs ?? 30 * 60_000,
        evaluators: parsed.contest.evaluators ?? ["check"],
      },
    },
  }
}
