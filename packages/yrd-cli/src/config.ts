import { readFile } from "node:fs/promises"
import { join } from "node:path"
import * as z from "zod"

const TextSchema = z.string().trim().min(1)
const StepNameSchema = TextSchema.regex(/^[a-z][a-z0-9_-]*$/iu)
const StepNamesSchema = z.array(StepNameSchema).superRefine((names, context) => {
  if (new Set(names).size !== names.length) context.addIssue({ code: "custom", message: "contains duplicate steps" })
})
const RunnerSchema = z.enum(["local", "waiting"])
const StepObjectSchema = z
  .object({ run: TextSchema.optional(), runner: RunnerSchema.default("local"), environment: TextSchema.optional() })
  .strict()
const StepSchema = z.preprocess((value) => (typeof value === "string" ? { run: value } : value), StepObjectSchema)

const ProjectSchema = z
  .object({
    line: z
      .object({
        base: TextSchema.optional(),
        batch: z.union([z.literal(false), z.number().int().min(0)]).optional(),
        steps: StepNamesSchema.optional(),
      })
      .strict()
      .default({}),
    steps: z.record(StepNameSchema, StepSchema).default({}),
    contest: z
      .object({
        concurrency: z.number().int().min(1).optional(),
        timeoutMs: z.number().int().min(1).optional(),
        evaluators: StepNamesSchema.optional(),
      })
      .strict()
      .default({}),
  })
  .strict()

export type YrdStepConfig = Readonly<z.infer<typeof StepObjectSchema>>
export type YrdProjectConfig = Readonly<z.infer<typeof ProjectSchema>>

export type ResolvedYrdProjectConfig = Readonly<{
  line: Readonly<{ base: string; batch: false | number; steps: readonly string[] }>
  steps: Readonly<Record<string, YrdStepConfig>>
  contest: Readonly<{ concurrency: number; timeoutMs: number; evaluators: readonly string[] }>
}>

export function parseYrdConfig(value: unknown): YrdProjectConfig {
  const parsed = ProjectSchema.safeParse(value ?? {})
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  if (issue === undefined) throw new Error("yrd: config is invalid")
  throw configError(issue)
}

function configError(issue: z.core.$ZodIssue): Error {
  const path = issue.path.map(String).join(".")
  if (issue.code === "unrecognized_keys") {
    const key = issue.keys[0] ?? "unknown"
    return new Error(`yrd: config ${path === "" ? key : `${path}.${key}`} is not supported`)
  }
  const known = new Map<string, string>([
    ["line.batch", "must be an integer >= 0"],
    ["contest.concurrency", "must be an integer >= 1"],
    ["contest.timeoutMs", "must be an integer >= 1"],
  ])
  const message = known.get(path) ?? (path.endsWith(".runner") ? "must be local or waiting" : issue.message)
  return new Error(`yrd: config${path === "" ? "" : ` ${path}`} ${message}`)
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
