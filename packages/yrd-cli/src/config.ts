import { readFile } from "node:fs/promises"
import { extname, isAbsolute, join, relative, resolve } from "node:path"
import {
  defineConfig,
  loadConfigModule,
  withActionStep,
  withCheckStep,
  withFlow,
  withMergeStep,
  type FlowDef,
  type StepDef,
  type YrdConfig,
} from "@yrd/config"
import { asFailure, createFailure } from "@yrd/core"
import * as z from "zod"

const TextSchema = z.string().trim().min(1)
const StepNameSchema = TextSchema.regex(/^[a-z][a-z0-9_-]*$/iu)
const StepNamesSchema = z.array(StepNameSchema).superRefine((names, context) => {
  if (new Set(names).size !== names.length) context.addIssue({ code: "custom", message: "contains duplicate steps" })
})
const RequirementsSchema = z.array(z.enum(["review"])).superRefine((requirements, context) => {
  if (new Set(requirements).size !== requirements.length) {
    context.addIssue({ code: "custom", message: "contains duplicate requirements" })
  }
})
const RunnerSchema = z.enum(["local", "waiting"])
export const SignalRecipientSchema = TextSchema.regex(/^@[a-z0-9][a-z0-9/_-]*$/iu)
const DirectNotifyTargetSchema = z.union([z.literal("submitter"), SignalRecipientSchema])
const NotifyTargetSchema = z.union([DirectNotifyTargetSchema, z.literal("broadcast")])
const DirectNotifyTargetsSchema = z
  .array(DirectNotifyTargetSchema)
  .min(1)
  .superRefine((targets, context) => {
    if (new Set(targets).size !== targets.length) {
      context.addIssue({ code: "custom", message: "contains duplicate notification targets" })
    }
  })
const NotifySchema = z
  .object({
    "pr/rejected": DirectNotifyTargetsSchema.optional(),
    "pr/needs-review": DirectNotifyTargetsSchema.optional(),
    "pr/integrated": z.tuple([z.literal("broadcast")]).optional(),
    "run/failed": DirectNotifyTargetsSchema.optional(),
  })
  .strict()
export type SignalRouteTarget = z.infer<typeof NotifyTargetSchema>
export type SignalKind = "pr/rejected" | "pr/needs-review" | "pr/integrated" | "run/failed"
export type SignalRoutes = Readonly<Partial<Record<SignalKind, readonly SignalRouteTarget[]>>>
const EnvironmentNameSchema = TextSchema.regex(/^[A-Za-z_][A-Za-z0-9_]*$/u).refine(
  (name) => !name.startsWith("YRD_") && !name.startsWith("GIT_"),
  { message: "uses a reserved prefix" },
)
const StepObjectSchema = z
  .object({
    kind: z.enum(["check", "action", "merge"]).optional(),
    run: TextSchema.optional(),
    runner: RunnerSchema.default("local"),
    classification: z.enum(["base", "carrier"]).optional(),
    environment: TextSchema.optional(),
    /** Declared child values applied over the deterministic base allowlist (merge-queue R42). */
    env: z.record(EnvironmentNameSchema, z.string()).optional(),
    /** Ambient names copied into the check child beyond the base allowlist — explicit, never implicit. */
    environmentPassthrough: z
      .array(EnvironmentNameSchema)
      .min(1)
      .superRefine((names, context) => {
        if (new Set(names).size !== names.length) {
          context.addIssue({ code: "custom", message: "contains duplicate environment names" })
        }
      })
      .optional(),
    /** Declarative per-step wall-clock bound; absent = the host default applies (21012 S1 — never silently unbounded). */
    timeoutMs: z.number().int().min(1).optional(),
    /** Declarative per-step no-output-progress bound; absent = the host default applies. A child that emits its banner
     * then goes SILENT for this long fails LOUDLY as `<step>-stalled` instead of wedging the queue behind a live child. */
    noProgressMs: z.number().int().min(1).optional(),
  })
  .strict()
const StepSchema = z.preprocess((value) => (typeof value === "string" ? { run: value } : value), StepObjectSchema)

const ContestSchema = z
  .object({
    concurrency: z.number().int().min(1).optional(),
    timeoutMs: z.number().int().min(1).optional(),
    evaluators: StepNamesSchema.optional(),
  })
  .strict()
  .default({})

const ProjectSchema = z
  .object({
    base: TextSchema.optional(),
    batch: z.union([z.literal(false), z.number().int().min(0)]).optional(),
    steps: StepNamesSchema.optional(),
    requires: RequirementsSchema.optional(),
    contest: ContestSchema,
    notify: NotifySchema.optional(),
  })
  .catchall(StepSchema)

export type YrdStepConfig = Readonly<z.infer<typeof StepObjectSchema>>
export type YrdProjectConfig = Readonly<{
  base?: string
  batch?: false | number
  steps?: readonly string[]
  requires?: readonly "review"[]
  definitions: Readonly<Record<string, YrdStepConfig>>
  contest: Readonly<z.infer<typeof ContestSchema>>
  notify?: SignalRoutes
}>

export type ResolvedYrdProjectConfig = Readonly<{
  base: string
  batch: false | number
  steps: readonly string[]
  requires: readonly "review"[]
  definitions: Readonly<Record<string, YrdStepConfig>>
  contest: Readonly<{ concurrency: number; timeoutMs: number; evaluators: readonly string[] }>
  notify?: SignalRoutes
  /** Programmatic flow authority. Optional only for direct legacy test/app construction. */
  flows?: readonly FlowDef[]
}>

export function parseYrdConfig(value: unknown): YrdProjectConfig {
  const retiredWrapper = ["li", "ne"].join("")
  if (typeof value === "object" && value !== null && retiredWrapper in value) {
    throw createFailure({
      kind: "configuration",
      code: "invalid-config",
      message: `yrd: remove '${retiredWrapper}:' and configure base, batch, steps, and step definitions at the top level`,
    })
  }
  const parsed = ProjectSchema.safeParse(value ?? {})
  if (parsed.success) {
    const { base, batch, steps, requires, contest, notify, ...definitions } = parsed.data
    return {
      ...(base === undefined ? {} : { base }),
      ...(batch === undefined ? {} : { batch }),
      ...(steps === undefined ? {} : { steps }),
      ...(requires === undefined ? {} : { requires }),
      definitions,
      contest,
      ...(notify === undefined ? {} : { notify }),
    }
  }
  const issue = parsed.error.issues[0]
  const message = issue === undefined ? "yrd: config is invalid" : configError(issue).message
  throw createFailure({ kind: "configuration", code: "invalid-config", message })
}

function configError(issue: z.core.$ZodIssue): Error {
  const path = issue.path.map(String).join(".")
  if (
    issue.code === "invalid_type" &&
    issue.path.length === 1 &&
    !["base", "batch", "steps", "requires", "contest", "notify"].includes(path)
  ) {
    return new Error(`yrd: config ${path} is not supported`)
  }
  if (issue.code === "unrecognized_keys") {
    const key = issue.keys[0] ?? "unknown"
    return new Error(`yrd: config ${path === "" ? key : `${path}.${key}`} is not supported`)
  }
  const known = new Map<string, string>([
    ["batch", "must be an integer >= 0"],
    ["contest.concurrency", "must be an integer >= 1"],
    ["contest.timeoutMs", "must be an integer >= 1"],
  ])
  const message =
    known.get(path) ??
    (path.endsWith(".runner")
      ? "must be local or waiting"
      : path.endsWith(".classification")
        ? "must be base or carrier"
        : issue.message)
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
  /** Read a repository-relative config blob from the named base authority. */
  readAuthority?: (base: string, path: string) => Promise<string | undefined>
  /** Explicit config path from --config; resolved within the repository/base tree. */
  configPath?: string
  cacheDir?: string
  loadModule?: (options: Readonly<{ path: string; source: string; cacheDir?: string }>) => Promise<YrdConfig>
}): Promise<{ path?: string; config: ResolvedYrdProjectConfig }> {
  const repo = resolve(options.repo)
  const explicit = options.configPath === undefined ? undefined : authorityPath(repo, options.configPath)
  const read = async (authority: string): Promise<string | undefined> =>
    options.readAuthority === undefined
      ? (options.read ?? defaultRead)(join(repo, authority))
      : options.readAuthority(options.defaultBase, authority)
  const candidates = explicit === undefined ? [".yrd.ts", ".yrd.yml"] : [explicit]
  let authority = candidates[0] ?? ".yrd.ts"
  let source: string | undefined
  for (const candidate of candidates) {
    authority = candidate
    source = await read(candidate)
    if (source !== undefined) break
  }
  if (explicit !== undefined && source === undefined) {
    throw createFailure({
      kind: "configuration",
      code: "config-not-found",
      message: `yrd: base '${options.defaultBase}' has no config '${explicit}'`,
    })
  }
  const path = join(repo, authority)

  if (source !== undefined && isTypeScriptConfig(authority)) {
    const flows = await (options.loadModule ?? loadConfigModule)({
      path,
      source,
      ...(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }),
    })
    return { path, config: resolveFlowConfig(flows, options.defaultBase) }
  }

  let parsed: YrdProjectConfig
  try {
    parsed = parseYrdConfig(source === undefined ? undefined : Bun.YAML.parse(source))
  } catch (error) {
    throw asFailure(error, { kind: "configuration", code: "invalid-config" })
  }
  const definitions = { ...parsed.definitions }
  definitions.check ??= { run: 'git diff --check "$YRD_BASE_SHA"..HEAD', runner: "local" }
  definitions.merge ??= { runner: "local" }
  const defaultSteps = [
    "check",
    ...(definitions.review ? ["review"] : []),
    "merge",
    ...(definitions.deploy ? ["deploy"] : []),
  ]
  const steps = parsed.steps ?? defaultSteps
  const flows = defineConfig(legacyFlow(steps, definitions))
  const kinds = new Map(flows.flows[0]?.steps.map((step) => [step.name, step.kind] as const) ?? [])
  const resolvedDefinitions = Object.fromEntries(
    Object.entries(definitions).map(([name, definition]) => [
      name,
      { ...definition, ...(kinds.get(name) === undefined ? {} : { kind: kinds.get(name) }) },
    ]),
  )
  return {
    ...(source === undefined ? {} : { path }),
    config: {
      base: parsed.base ?? options.defaultBase,
      batch: parsed.batch ?? 1,
      steps,
      requires: parsed.requires ?? [],
      definitions: resolvedDefinitions,
      contest: {
        concurrency: parsed.contest.concurrency ?? 2,
        timeoutMs: parsed.contest.timeoutMs ?? 30 * 60_000,
        evaluators: parsed.contest.evaluators ?? ["check"],
      },
      notify: parsed.notify ?? {},
      flows: flows.flows,
    },
  }
}

function authorityPath(repo: string, requested: string): string {
  const absolute = resolve(repo, requested)
  const inside = relative(repo, absolute)
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    throw createFailure({
      kind: "configuration",
      code: "config-path-invalid",
      message: `yrd: --config '${requested}' must stay inside the repository`,
    })
  }
  if (!isTypeScriptConfig(inside) && !inside.endsWith(".yml") && !inside.endsWith(".yaml")) {
    throw createFailure({
      kind: "configuration",
      code: "config-path-invalid",
      message: `yrd: --config '${requested}' must name a .ts, .yml, or .yaml file`,
    })
  }
  return inside
}

function isTypeScriptConfig(path: string): boolean {
  return extname(path) === ".ts"
}

function legacyFlow(steps: readonly string[], definitions: Readonly<Record<string, YrdStepConfig>>): FlowDef {
  const mergeIndex = steps.indexOf("merge")
  return withFlow({
    name: "default",
    rev: "legacy-v1",
    on: () => true,
    steps: steps.map((name, index) => {
      const definition = definitions[name] ?? { runner: "local" as const }
      const options = {
        ...(definition.run === undefined ? {} : { run: definition.run }),
        runner: definition.runner,
        ...(definition.timeoutMs === undefined ? {} : { timeoutMs: definition.timeoutMs }),
        ...(definition.noProgressMs === undefined ? {} : { noProgressMs: definition.noProgressMs }),
        ...(definition.env === undefined ? {} : { env: definition.env }),
        ...(definition.classification === undefined ? {} : { classification: definition.classification }),
      }
      const kind =
        definition.kind ?? (name === "merge" ? "merge" : mergeIndex >= 0 && index > mergeIndex ? "action" : "check")
      if (kind === "merge") return withMergeStep(options)
      return kind === "action" ? withActionStep(name, options) : withCheckStep(name, options)
    }),
  })
}

function resolvedStep(step: StepDef): YrdStepConfig {
  return {
    kind: step.kind,
    ...(step.run === undefined ? {} : { run: step.run }),
    runner: step.runner,
    ...(step.classification === undefined ? {} : { classification: step.classification }),
    ...(step.env === undefined ? {} : { env: step.env }),
    ...(step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs }),
    ...(step.noProgressMs === undefined ? {} : { noProgressMs: step.noProgressMs }),
  }
}

function resolveFlowConfig(config: YrdConfig, defaultBase: string): ResolvedYrdProjectConfig {
  const definitions: Record<string, YrdStepConfig> = {}
  const names: string[] = []
  for (const flow of config.flows) {
    for (const step of flow.steps) {
      const resolved = resolvedStep(step)
      const current = definitions[step.name]
      if (current !== undefined && JSON.stringify(current) !== JSON.stringify(resolved)) {
        throw createFailure({
          kind: "configuration",
          code: "flow-step-conflict",
          message: `yrd: flow step '${step.name}' has conflicting runner/executable definitions`,
        })
      }
      definitions[step.name] = resolved
      if (!names.includes(step.name)) names.push(step.name)
    }
  }
  return {
    base: defaultBase,
    batch: 1,
    steps: names,
    requires: [],
    definitions,
    contest: {
      concurrency: 2,
      timeoutMs: 30 * 60_000,
      evaluators: names.filter((name) => name !== "merge").slice(0, 1),
    },
    notify: {},
    flows: config.flows,
  }
}
