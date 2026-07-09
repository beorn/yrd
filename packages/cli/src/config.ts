export type YrdStepRunner = "local" | "waiting"

export type YrdStepConfig = Readonly<{
  run?: string
  runner: YrdStepRunner
  environment?: string
}>

export type YrdLineConfig = Readonly<{
  base?: string
  batch?: false | number
  steps?: readonly string[]
}>

export type YrdContestConfig = Readonly<{
  concurrency?: number
  timeoutMs?: number
  evaluators?: readonly string[]
}>

export type YrdProjectConfig = Readonly<{
  version: 1
  line: YrdLineConfig
  steps: Readonly<Record<string, YrdStepConfig>>
  contest: YrdContestConfig
}>

function fail(path: string, message: string): never {
  throw new Error(`yrd: config ${path} ${message}`)
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "must be an object")
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const known = new Set(allowed)
  const unknown = Object.keys(value).find((key) => !known.has(key))
  if (unknown !== undefined) {
    if (path === "") throw new Error(`yrd: config unknown top-level key '${unknown}'`)
    fail(`${path}.${unknown}`, "is not supported")
  }
}

function nonEmpty(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(path, "must be a non-empty string")
  return value
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(path, "must be a positive integer")
  return value as number
}

function stepNames(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail(path, "must be an array of registered step names")
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const name = nonEmpty(item, path)
    if (!/^[a-z][a-z0-9_-]*$/iu.test(name)) fail(path, `contains invalid step '${name}'`)
    if (seen.has(name)) fail(path, `contains duplicate step '${name}'`)
    seen.add(name)
    result.push(name)
  }
  return result
}

function parseLine(value: unknown): YrdLineConfig {
  if (value === undefined) return {}
  const input = record(value, "line")
  keys(input, ["base", "batch", "steps"], "line")
  const base = input.base === undefined ? undefined : nonEmpty(input.base, "line.base")
  const batch = input.batch
  if (batch !== undefined && batch !== false && (!Number.isSafeInteger(batch) || (batch as number) < 0)) {
    fail("line.batch", "must be false or a non-negative integer")
  }
  return {
    ...(base === undefined ? {} : { base }),
    ...(batch === undefined ? {} : { batch: batch as false | number }),
    ...(input.steps === undefined ? {} : { steps: stepNames(input.steps, "line.steps") }),
  }
}

function parseStep(value: unknown, name: string): YrdStepConfig {
  if (typeof value === "string") return { run: nonEmpty(value, `steps.${name}.run`), runner: "local" }
  const input = record(value, `steps.${name}`)
  keys(input, ["run", "runner", "environment"], `steps.${name}`)
  const runner = input.runner ?? "local"
  if (runner !== "local" && runner !== "waiting") {
    fail(`steps.${name}.runner`, "must be 'local' or 'waiting'")
  }
  return {
    ...(input.run === undefined ? {} : { run: nonEmpty(input.run, `steps.${name}.run`) }),
    runner,
    ...(input.environment === undefined
      ? {}
      : { environment: nonEmpty(input.environment, `steps.${name}.environment`) }),
  }
}

function parseSteps(value: unknown): Readonly<Record<string, YrdStepConfig>> {
  if (value === undefined) return {}
  const input = record(value, "steps")
  const result: Record<string, YrdStepConfig> = {}
  for (const [name, step] of Object.entries(input)) {
    if (!/^[a-z][a-z0-9_-]*$/iu.test(name)) fail("steps", `contains invalid step '${name}'`)
    result[name] = parseStep(step, name)
  }
  return result
}

function parseContest(value: unknown): YrdContestConfig {
  if (value === undefined) return {}
  const input = record(value, "contest")
  keys(input, ["concurrency", "timeoutMs", "evaluators"], "contest")
  return {
    ...(input.concurrency === undefined
      ? {}
      : { concurrency: positiveInteger(input.concurrency, "contest.concurrency") }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: positiveInteger(input.timeoutMs, "contest.timeoutMs") }),
    ...(input.evaluators === undefined ? {} : { evaluators: stepNames(input.evaluators, "contest.evaluators") }),
  }
}

/** Parse the data-only policy consumed by the built-in workflow plugin. The
 * file selects registered transitions; custom transitions are composed in TS. */
export function parseYrdConfig(value: unknown): YrdProjectConfig {
  if (value === undefined || value === null) return { version: 1, line: {}, steps: {}, contest: {} }
  const input = record(value, "")
  keys(input, ["version", "line", "steps", "contest"], "")
  if (input.version !== undefined && input.version !== 1) fail("version", "must be 1")
  return {
    version: 1,
    line: parseLine(input.line),
    steps: parseSteps(input.steps),
    contest: parseContest(input.contest),
  }
}
