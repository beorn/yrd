import { readFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { defineConfig, withActionStep, withCheckStep, withFlow, withMergeStep, type FlowDef } from "@yrd/config"
import { asFailure, createFailure } from "@yrd/core"
import {
  DEFAULT_QUEUE_BATCH_SIZE,
  DEFAULT_QUEUE_PROGRESS_POLICY,
  DIAGNOSTICS_COMPARISON_READY,
  GateModeSchema,
  type GateMode,
  type QueueProgressPolicy,
} from "@yrd/queue"
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
    /** Explicit parent-versus-candidate comparison for diagnostics-shaped
     * lint/typecheck output. Absent means the command's exit code is final. */
    comparison: z.literal("diagnostics").optional(),
    /** Report id that must be present before a compound diagnostics comparison
     * may run, proving every earlier structured child completed. */
    comparisonReady: z.literal(DIAGNOSTICS_COMPARISON_READY).optional(),
    /** Required-check posture. Delta accepts only a structured, auditable residual
     * already present at the exact base; strict requires an absolutely green
     * candidate and never invokes a base comparator. */
    mode: GateModeSchema.optional(),
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
  .superRefine((step, context) => {
    if (step.comparisonReady !== undefined && step.comparison === undefined) {
      context.addIssue({
        code: "custom",
        path: ["comparisonReady"],
        message: "requires comparison: diagnostics",
      })
    }
    if (step.comparison === undefined) return
    if (step.run === undefined) {
      context.addIssue({
        code: "custom",
        path: ["comparison"],
        message: "requires a local run command",
      })
    }
    if (step.runner !== "local") {
      context.addIssue({
        code: "custom",
        path: ["comparison"],
        message: "is only supported by the local runner",
      })
    }
  })
const StepSchema = z.preprocess((value) => (typeof value === "string" ? { run: value } : value), StepObjectSchema)

const ContestSchema = z
  .object({
    concurrency: z.number().int().min(1).optional(),
    timeoutMs: z.number().int().min(1).optional(),
    evaluators: StepNamesSchema.optional(),
  })
  .strict()
  .default({})

const InlineCheckSchema = z
  .record(StepNameSchema, StepSchema)
  .refine((value) => Object.keys(value).length === 1, { message: "must define exactly one named check" })
const CheckEntrySchema = z.union([StepNameSchema, InlineCheckSchema])
const ChecksSchema = z
  .array(CheckEntrySchema)
  .superRefine((checks, context) => {
    const names = checks.map(checkName)
    if (new Set(names).size !== names.length) context.addIssue({ code: "custom", message: "contains duplicate checks" })
  })
  .default([])

/**
 * One repository-declared pre-submit guard.
 *
 * Deliberately NOT `StepObjectSchema`. A step carries `runner`, `mode`,
 * `comparison`, `classification` and the rest of the Queue's execution
 * vocabulary, none of which a guard has any meaning for — a guard never runs in
 * the Queue, never composes onto base, and never produces landing evidence.
 * Reusing the step schema would advertise a dozen keys that silently do
 * nothing, which is a worse duplication than two small schemas.
 *
 * `paths` is what keeps a repository-wide authoring rule from taxing every
 * code-only carrier: declare the subset the guard is about and a candidate
 * touching none of it never spawns the command at all.
 */
const GuardObjectSchema = z
  .object({
    run: TextSchema,
    /** Repository-relative globs; absent means the guard always runs. */
    paths: z.array(TextSchema).min(1).optional(),
    /** Declared child values applied over the deterministic base allowlist. */
    env: z.record(EnvironmentNameSchema, z.string()).optional(),
    /** Ambient names copied into the guard child beyond the base allowlist — explicit, never implicit. */
    environmentPassthrough: z
      .array(EnvironmentNameSchema)
      .min(1)
      .superRefine((names, context) => {
        if (new Set(names).size !== names.length) {
          context.addIssue({ code: "custom", message: "contains duplicate environment names" })
        }
      })
      .optional(),
    /** Declarative wall-clock bound; absent = the guard default (never silently unbounded). */
    timeoutMs: z.number().int().min(1).optional(),
  })
  .strict()
const GuardSchema = z.preprocess((value) => (typeof value === "string" ? { run: value } : value), GuardObjectSchema)

/**
 * Guards have no built-ins, so — unlike checks — a bare name is not a legal
 * entry. Every guard names a command the repository owns.
 */
const GuardEntrySchema = z
  .record(StepNameSchema, GuardSchema)
  .refine((value) => Object.keys(value).length === 1, { message: "must define exactly one named guard" })
const GuardsSchema = z
  .array(GuardEntrySchema)
  .superRefine((guards, context) => {
    const names = guards.map(guardName)
    if (new Set(names).size !== names.length) context.addIssue({ code: "custom", message: "contains duplicate guards" })
  })
  .default([])

const ProgressSchema = z
  .object({
    noLandingMs: z.number().int().min(1).optional(),
    refusalCount: z.number().int().min(1).optional(),
    minAdmissionChecks: z.number().int().min(1).optional(),
  })
  .strict()
  .default({})

/**
 * Whether anything in this repository is ever going to drain its queue.
 *
 * This cannot be inferred. A repository whose runner is about to be armed for
 * the first time and one that will never have a runner have the SAME queue
 * state: no runner, no drained run, no recorded facts. Absent this declaration,
 * a submit into the second is byte-identical to a submit into the first, which
 * is how two carriers came to sit `submitted` for an hour on 2026-08-05 in a
 * repository whose queue had never once run.
 *
 * `expected` when absent — every repository that predates this key keeps
 * behaving exactly as it did, and only a repository that says `none` refuses.
 */
const MergeSchema = z.enum(["expected", "none"]).optional()

const ProjectFields = {
  base: TextSchema.optional(),
  batch: z.union([z.literal(false), z.number().int().min(0)]).optional(),
  checks: ChecksSchema,
  guards: GuardsSchema,
  merge: MergeSchema,
  /** Renamed to `merge:` 2026-08-18 (same values, same `expected` default) --
   * the merge-queue record noun is "change", not "PR", and `landing:` named
   * the killed vocabulary. Read-only compatibility: still parsed so existing
   * checked-in `.yrd.yml` files keep working; write `merge:` going forward.
   * Remove this key once no committed config still sets `landing:` (grep
   * `^landing:` across hh + vendor/* .yrd.yml before deleting). */
  landing: MergeSchema,
  requires: RequirementsSchema.optional(),
  contest: ContestSchema,
  progress: ProgressSchema,
} as const

const ProjectSchema = z.object(ProjectFields).strict()

export type YrdStepConfig = Readonly<z.infer<typeof StepObjectSchema>>
export type YrdGuardConfig = Readonly<z.infer<typeof GuardObjectSchema>>
export type YrdGateMode = GateMode
export type YrdProjectConfig = Readonly<{
  base?: string
  batch?: false | number
  checks: readonly z.infer<typeof CheckEntrySchema>[]
  guards: readonly z.infer<typeof GuardEntrySchema>[]
  merge?: "expected" | "none"
  requires?: readonly "review"[]
  contest: Readonly<z.infer<typeof ContestSchema>>
  progress: Readonly<z.infer<typeof ProgressSchema>>
}>

export type ResolvedYrdProjectConfig = Readonly<{
  base: string
  batch: false | number
  /** Public configured predicates. Merge is deliberately absent. */
  checks?: readonly string[]
  /** Configured pre-submit guard names, in declaration order. Distinct from
   * `checks`: a guard runs in the invoking working repository before the
   * revision is registered and is never re-run by the Queue. */
  guards?: readonly string[]
  /** Command and scope for each configured guard. */
  guardDefinitions?: Readonly<Record<string, YrdGuardConfig>>
  /** Internal Queue execution plan: configured checks plus built-in merge. */
  steps: readonly string[]
  /** Declared, never inferred — see MergeSchema. `loadYrdConfig` always sets
   * it; absent (hand-built configs) reads as "expected", same as an unset key. */
  merge?: "expected" | "none"
  requires: readonly "review"[]
  definitions: Readonly<Record<string, YrdStepConfig>>
  contest: Readonly<{ concurrency: number; timeoutMs: number; evaluators: readonly string[] }>
  progress?: QueueProgressPolicy
  /** Programmatic flow authority. Optional only for direct legacy test/app construction. */
  flows?: readonly FlowDef[]
}>

export function parseYrdConfig(value: unknown): YrdProjectConfig {
  const retiredWrapper = ["li", "ne"].join("")
  if (typeof value === "object" && value !== null && retiredWrapper in value) {
    throw createFailure({
      kind: "configuration",
      code: "invalid-config",
      message: `yrd: remove '${retiredWrapper}:' and configure the required checks as 'checks: [...]'`,
    })
  }
  if (typeof value === "object" && value !== null && "do" in value) {
    throw createFailure({
      kind: "configuration",
      code: "invalid-config",
      message: "yrd: config do is not supported; .yrd.yml contains delivery correctness only",
    })
  }
  const parsed = ProjectSchema.safeParse(value ?? {})
  if (parsed.success) {
    const { base, batch, checks, guards, merge, landing, requires, contest, progress } = parsed.data
    if (merge !== undefined && landing !== undefined && merge !== landing) {
      throw createFailure({
        kind: "configuration",
        code: "invalid-config",
        message: `yrd: config merge ('${merge}') and landing ('${landing}') disagree; landing: is a deprecated alias for merge: — keep only one`,
      })
    }
    const resolvedMerge = merge ?? landing
    return {
      ...(base === undefined ? {} : { base }),
      ...(batch === undefined ? {} : { batch }),
      checks,
      guards,
      ...(resolvedMerge === undefined ? {} : { merge: resolvedMerge }),
      ...(requires === undefined ? {} : { requires }),
      contest,
      progress,
    }
  }
  const issue = mostSpecificConfigIssue(parsed.error.issues[0])
  const message = issue === undefined ? "yrd: config is invalid" : configError(issue).message
  throw createFailure({ kind: "configuration", code: "invalid-config", message })
}

/**
 * The queue's own submission/admission gate: judge a CANDIDATE's raw pushed
 * `.yrd.yml` text against this exact schema, before the push is even
 * accepted (wired into the Git receiver — `@yrd/bay`'s `validateConfig` hook
 * — by the host that owns both the receiver and this schema; `@yrd/bay`
 * cannot import this file itself without a dependency cycle).
 *
 * This is the fix for PR1337 (2026-08-19): a `.yrd.yml` carrying an invalid
 * `test-fast.comparison: gate-residuals` key passed typecheck, lockfile and
 * manifest gates — none of them parse `.yrd.yml` — then wedged the resident
 * queue runner for 31 minutes the moment its own config load (always FROM
 * THE BASE REF, `readConfigFromBase` in `host.ts`) hit the newly-landed key.
 * Nothing before this function ever asked whether the PUSHED `.yrd.yml`
 * itself would parse.
 *
 * `yaml === undefined` (the pushed tree has no config file at all) is a
 * real, valid answer — the built-in defaults, exactly what `loadYrdConfig`
 * resolves for a base with no config — never a skip: it still calls
 * `parseYrdConfig`, which still throws if `undefined` were ever somehow
 * invalid (it is not, by construction), so a future schema change that made
 * absence meaningful could not silently bypass this gate by accident.
 */
export function validatePushedYrdConfig(yaml: string | undefined): void {
  parseYrdConfig(yaml === undefined ? undefined : Bun.YAML.parse(yaml))
}

function mostSpecificConfigIssue(issue: z.core.$ZodIssue | undefined): z.core.$ZodIssue | undefined {
  if (issue?.code !== "invalid_union") return issue
  return issue.errors
    .flatMap((issues) => issues.map(mostSpecificConfigIssue))
    .filter((candidate): candidate is z.core.$ZodIssue => candidate !== undefined)
    .sort(
      (left, right) =>
        right.path.length - left.path.length ||
        Number(right.code === "custom" || right.code === "unrecognized_keys") -
          Number(left.code === "custom" || left.code === "unrecognized_keys"),
    )[0]
}

function configError(issue: z.core.$ZodIssue): Error {
  const path = issue.path.map(String).join(".")
  if (
    issue.code === "invalid_key" &&
    (String(issue.path.at(-1)).startsWith("YRD_") || String(issue.path.at(-1)).startsWith("GIT_"))
  ) {
    return new Error(`yrd: config ${path} uses a reserved prefix`)
  }
  if (
    issue.code === "invalid_type" &&
    issue.path.length === 1 &&
    !["base", "batch", "checks", "requires", "contest", "progress"].includes(path)
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
    ["progress.noLandingMs", "must be an integer >= 1"],
    ["progress.refusalCount", "must be an integer >= 1"],
    ["progress.minAdmissionChecks", "must be an integer >= 1"],
  ])
  const message =
    known.get(path) ??
    (path.endsWith(".runner")
      ? "must be local or waiting"
      : path.endsWith(".mode")
        ? "must be delta or strict"
        : path.endsWith(".classification")
          ? "must be base or carrier"
          : issue.message)
  return new Error(`yrd: config${path === "" ? "" : ` ${path}`} ${message}`)
}

/** Effective required-check posture. Delta is deliberately the temporary default
 * while inherited debt is being burned down; callers bind this value into
 * step identity so an explicit strict flip invalidates stale installations. */
export function stepGateMode(config: YrdStepConfig): YrdGateMode {
  return config.mode ?? "delta"
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
}): Promise<{ path?: string; config: ResolvedYrdProjectConfig }> {
  const repo = resolve(options.repo)
  const explicit = options.configPath === undefined ? undefined : authorityPath(repo, options.configPath)
  const read = async (authority: string): Promise<string | undefined> =>
    options.readAuthority === undefined
      ? (options.read ?? defaultRead)(join(repo, authority))
      : options.readAuthority(options.defaultBase, authority)
  const candidates = explicit === undefined ? [".yrd.yml"] : [explicit]
  let authority = candidates[0] ?? ".yrd.yml"
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

  let parsed: YrdProjectConfig
  try {
    parsed = parseYrdConfig(source === undefined ? undefined : Bun.YAML.parse(source))
  } catch (error) {
    throw asFailure(error, { kind: "configuration", code: "invalid-config" })
  }
  const definitions = Object.fromEntries(parsed.checks.map(resolveCheck))
  definitions.merge = { runner: "local", kind: "merge" }
  const checks = parsed.checks.map(checkName)
  const steps = [...checks, "merge"]
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
      batch: parsed.batch ?? DEFAULT_QUEUE_BATCH_SIZE,
      checks,
      guards: parsed.guards.map(guardName),
      guardDefinitions: Object.fromEntries(parsed.guards.map(resolveGuard)),
      steps,
      merge: parsed.merge ?? "expected",
      requires: parsed.requires ?? [],
      definitions: resolvedDefinitions,
      contest: {
        concurrency: parsed.contest.concurrency ?? 2,
        timeoutMs: parsed.contest.timeoutMs ?? 30 * 60_000,
        evaluators: parsed.contest.evaluators ?? checks.slice(0, 1),
      },
      progress: {
        noLandingMs: parsed.progress.noLandingMs ?? DEFAULT_QUEUE_PROGRESS_POLICY.noLandingMs,
        refusalCount: parsed.progress.refusalCount ?? DEFAULT_QUEUE_PROGRESS_POLICY.refusalCount,
        minAdmissionChecks: parsed.progress.minAdmissionChecks ?? DEFAULT_QUEUE_PROGRESS_POLICY.minAdmissionChecks,
      },
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
  if (!inside.endsWith(".yml") && !inside.endsWith(".yaml")) {
    throw createFailure({
      kind: "configuration",
      code: "config-path-invalid",
      message: `yrd: --config '${requested}' must name a .yml or .yaml file`,
    })
  }
  return inside
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

function checkName(check: z.infer<typeof CheckEntrySchema>): string {
  return typeof check === "string" ? check : (Object.keys(check)[0] ?? "")
}

function guardName(guard: z.infer<typeof GuardEntrySchema>): string {
  return Object.keys(guard)[0] ?? ""
}

function resolveGuard(guard: z.infer<typeof GuardEntrySchema>): readonly [string, YrdGuardConfig] {
  const name = guardName(guard)
  const definition = guard[name]
  if (definition === undefined) throw new Error(`yrd: configured guard '${name}' lost its definition`)
  return [name, definition]
}

function resolveCheck(check: z.infer<typeof CheckEntrySchema>): readonly [string, YrdStepConfig] {
  const name = checkName(check)
  if (typeof check !== "string") {
    const definition = check[name]
    if (definition === undefined) throw new Error(`yrd: configured check '${name}' lost its definition`)
    return [name, { ...definition, kind: "check" }]
  }
  if (name === "typecheck") return [name, { run: "bun run typecheck", runner: "local", kind: "check" }]
  if (name === "check") {
    return [name, { run: 'git diff --check "$YRD_BASE_SHA"..HEAD', runner: "local", kind: "check" }]
  }
  throw createFailure({
    kind: "configuration",
    code: "check-definition-missing",
    message: `yrd: required check '${name}' has no built-in definition; use {${name}: {run: ...}}`,
  })
}

export function renderYrdConfigScaffold(): string {
  return "checks: [typecheck]\n"
}
