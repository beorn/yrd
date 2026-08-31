import { readFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { defineStepPlan, withActionStep, withCheckStep, withMergeStep, type StepDef } from "@yrd/config"
import { asFailure, createFailure } from "@yrd/core"
import {
  DEFAULT_NEEDS_PERSON_OWNER,
  DEFAULT_QUEUE_BATCH_SIZE,
  DEFAULT_QUEUE_PROGRESS_POLICY,
  DIAGNOSTICS_COMPARISON_READY,
  GateModeSchema,
  type GateMode,
  type QueueProgressPolicy,
  type TrailerAbsentException,
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
/** A repo-relative gate-script path (file or directory). Absolute paths and
 * `..` segments would let a declaration reach outside the repository the base
 * ref governs, so both refuse at parse time. */
const GateScriptPathSchema = TextSchema.refine(
  (path) =>
    !path.startsWith("/") &&
    !path.startsWith("\\") &&
    !/^[A-Za-z]:/u.test(path) &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
  { message: "must be a repo-relative path without '.' or '..' segments" },
)
const GateScriptsSchema = z
  .array(GateScriptPathSchema)
  .min(1)
  .superRefine((paths, context) => {
    if (new Set(paths).size !== paths.length) {
      context.addIssue({ code: "custom", message: "contains duplicate script paths" })
    }
  })
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
    /** Gate scripts this check executes, as repo-relative paths (files or
     * directories). Declared paths run at the BASE ref's version, like the
     * config itself (23183): before the command starts, every declared path
     * that differs is materialized from the base into the execution checkout
     * and restored afterwards, so a change that edits its own gate script is
     * judged by the pre-edit script. The paths' object shas at the base are
     * folded into the step's derived revision, so a script edit is a revision
     * change the plan audit sees. */
    scripts: GateScriptsSchema.optional(),
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
    if (step.scripts !== undefined && step.runner !== "local") {
      // A waiting step's child outlives the invocation, and a base-pinned
      // overlay restored on return would flip the scripts under it mid-run.
      context.addIssue({
        code: "custom",
        path: ["scripts"],
        message: "is only supported by the local runner",
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
 * the Queue, never composes onto base, and never produces merge evidence.
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

/** Built-in hours a pushed-but-unsubmitted draft may sit before health checks
 * and `yrd watch` surface it as a page-worthy warning. Distinct from — and much
 * longer than — `queue audit`'s own DRAFT_STRANDED_GRACE_MS (@yrd/queue,
 * 15 minutes): that grace is how soon the finding exists at all, long enough
 * to allow a deliberate push-review-submit pause; this is how long it may sit
 * unpaged before a live seat should actually be interrupted. Live specimens
 * that motivated the finding sat 9-22 hours (@i/10-merge-queue/drafts-strand-silently);
 * a default in between catches those long before they age out a full day
 * without paging on every short pause. */
export const DEFAULT_DRAFT_PAGE_AFTER_HOURS = 4

const DraftsSchema = z
  .object({
    /** Hours, not ms — the config surface is for repository owners, and every
     * live incident this exists to catch is hours-scale. Unset keeps
     * {@link DEFAULT_DRAFT_PAGE_AFTER_HOURS}. */
    pageAfterHours: z.number().positive().optional(),
  })
  .strict()
  .default({})

const NeedsPersonSchema = z
  .object({
    /** Static role routing for an admission refusal that settled with no
     * mechanical remedy (@i/10-merge-queue/22918-needs-person-unowned) — a
     * repository-declared fact, never guessed at read time. Unset keeps
     * {@link DEFAULT_NEEDS_PERSON_OWNER}, which reads as explicitly unowned
     * rather than silently omitting the finding's `owner` field. */
    owner: TextSchema.optional(),
  })
  .strict()
  .default({})

/**
 * A per-commit ruling on history the lineage index cannot read.
 *
 * Lives in `.yrd.yml` and NOT in the yrd packages because the fact being
 * declared is a property of ONE repository's history: which of its own commits
 * rejoined foreign history without a readable `Change-Id`. Hard-coding a sha
 * list in a shipped package would make every other repository carry a ruling
 * about commits it does not have.
 *
 * Every field is required rather than defaulted, because a ruling is a claim
 * about permanent history that no later reader can re-derive cheaply. `note`
 * is where the evidence goes.
 */
const MergedTruthCommitSchema = TextSchema.regex(/^[0-9a-f]{40}$/iu, {
  message:
    "must be a full 40-character commit sha. Rulings are keyed by full sha, so an abbreviation matches " +
    "nothing and the ruling silently clears no specimen — resolve it with `git rev-parse <short-sha>`",
})

const MergedTruthChangeIdSchema = TextSchema.regex(/^I[0-9a-f]{40}$/u, {
  message: "must be a change id: 'I' followed by 40 hex characters",
})

const MergedTruthExceptionSchema = z
  .object({
    commit: MergedTruthCommitSchema,
    disposition: z.enum(["carries-change", "carries-no-change"]),
    /** Singular spelling, for the common one-change ruling. */
    changeId: MergedTruthChangeIdSchema.optional(),
    /** Plural spelling. A back-merge rejoins as many changes as its branch
     * carried, and ruling such a commit for only one of them leaves the rest
     * answering a TRUSTED not-found — the queue then re-admits and re-runs work
     * that already landed. */
    changeIds: z.array(MergedTruthChangeIdSchema).optional(),
    note: TextSchema.optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    const declared = [...(entry.changeId === undefined ? [] : [entry.changeId]), ...(entry.changeIds ?? [])]
    if (entry.disposition === "carries-change") {
      if (declared.length === 0) {
        context.addIssue({
          code: "custom",
          message:
            `'${entry.commit}' is ruled 'carries-change' but names no change id — set 'changeId:' (or ` +
            `'changeIds: [...]' when the commit rejoined several), or rule it 'carries-no-change'`,
        })
      }
      if (new Set(declared).size !== declared.length) {
        context.addIssue({ code: "custom", message: `'${entry.commit}' names the same change id twice` })
      }
      return
    }
    if (declared.length > 0) {
      context.addIssue({
        code: "custom",
        message: `'${entry.commit}' is ruled 'carries-no-change' but also names a change id — pick one`,
      })
    }
    if (entry.note === undefined) {
      context.addIssue({
        code: "custom",
        message:
          `'${entry.commit}' is ruled 'carries-no-change' and must carry a 'note:' recording why — a bare ` +
          `ruling turns a loud unknown into a silent 'not merged' with nothing to audit it against`,
      })
    }
  })

const MergedTruthExceptionsSchema = z
  .array(MergedTruthExceptionSchema)
  .default([])
  .superRefine((entries, context) => {
    const seen = new Set<string>()
    for (const entry of entries) {
      const key = entry.commit.toLowerCase()
      if (seen.has(key)) {
        context.addIssue({ code: "custom", message: `'${entry.commit}' is ruled more than once` })
      }
      seen.add(key)
    }
  })

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
  drafts: DraftsSchema,
  needsPerson: NeedsPersonSchema,
  mergedTruthExceptions: MergedTruthExceptionsSchema,
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
  drafts: Readonly<z.infer<typeof DraftsSchema>>
  needsPerson: Readonly<z.infer<typeof NeedsPersonSchema>>
  mergedTruthExceptions: readonly z.infer<typeof MergedTruthExceptionSchema>[]
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
  /** Optional, like `progress`, for the same reason: `loadYrdConfig` always
   * populates it, but hand-built fixtures throughout the test suite construct
   * this type directly without it. Absent means "use the built-in default" —
   * see {@link DEFAULT_DRAFT_PAGE_AFTER_HOURS} — never "drafts never page". */
  drafts?: Readonly<{ pageAfterHours: number }>
  /** Optional, like `drafts`, for the same reason: `loadYrdConfig` always
   * populates it (`owner` always resolved, never blank), but hand-built
   * fixtures construct this type directly without it. Absent means "use the
   * built-in unowned default" — see {@link DEFAULT_NEEDS_PERSON_OWNER} —
   * never "no needs-person finding is ever owned". */
  needsPerson?: Readonly<{ owner: string }>
  /** Per-commit rulings on history the lineage index cannot read. Optional
   * for the same reason as `drafts` and `needsPerson` — hand-built fixtures
   * construct this type directly. Absent means "no ruling has been declared",
   * which leaves every specimen standing and every not-found lookup loudly
   * unknown; it never means "trust a not-found". */
  mergedTruthExceptions?: readonly MergedTruthExceptionConfig[]
}>

export type MergedTruthExceptionConfig = Readonly<z.infer<typeof MergedTruthExceptionSchema>>

/**
 * The config rulings in the shape {@link buildMergedTruthIndex} takes.
 *
 * Keyed by full sha, lowercased: git prints lowercase and the index compares
 * the key to walked commit shas by string equality, so an upper-case
 * declaration would match nothing — and would then be reported as an unmatched
 * exception rather than silently doing nothing, which is the point of carrying
 * the set out at all.
 */
export function mergedTruthExceptions(
  config: Pick<ResolvedYrdProjectConfig, "mergedTruthExceptions">,
): ReadonlyMap<string, TrailerAbsentException> {
  const entries = new Map<string, TrailerAbsentException>()
  for (const entry of config.mergedTruthExceptions ?? []) {
    if (entry.disposition === "carries-no-change") {
      // `note` is required by the schema for this disposition; the assertion
      // states that here rather than defaulting it to a placeholder, which
      // would put an unaudited ruling into the index under a made-up reason.
      entries.set(entry.commit.toLowerCase(), { disposition: "carries-no-change", note: entry.note ?? "" })
      continue
    }
    const declared = [...(entry.changeId === undefined ? [] : [entry.changeId]), ...(entry.changeIds ?? [])]
    const [first, ...rest] = declared
    if (first === undefined) {
      // Unreachable through `parseYrdConfig` — the schema refuses this shape —
      // and therefore raised rather than skipped: a hand-built config reaching
      // here would otherwise have its ruling dropped and read as never declared.
      throw createFailure({
        kind: "configuration",
        code: "invalid-config",
        message: `yrd: mergedTruthExceptions entry '${entry.commit}' is 'carries-change' but names no change id`,
      })
    }
    entries.set(entry.commit.toLowerCase(), {
      disposition: "carries-change",
      changeIds: [first, ...rest],
      ...(entry.note === undefined ? {} : { note: entry.note }),
    })
  }
  return entries
}

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
    const {
      base,
      batch,
      checks,
      guards,
      merge,
      landing,
      requires,
      contest,
      progress,
      drafts,
      needsPerson,
      mergedTruthExceptions,
    } = parsed.data
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
      drafts,
      needsPerson,
      mergedTruthExceptions,
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
 * manifest gates — none of them parse `.yrd.yml` — then wedged the habitant
 * queue runner for 31 minutes the moment its own config load (always FROM
 * THE BASE REF, `readConfigFromBase` in `host.ts`) hit the newly-merged key.
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
    !["base", "batch", "checks", "requires", "contest", "progress", "drafts"].includes(path)
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
    ["drafts.pageAfterHours", "must be a positive number"],
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
  const steps = [...declaredStepNames(parsed)]
  const plan = declaredStepPlan(steps, definitions)
  const kinds = new Map(plan.map((step) => [step.name, step.kind] as const))
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
      drafts: {
        pageAfterHours: parsed.drafts.pageAfterHours ?? DEFAULT_DRAFT_PAGE_AFTER_HOURS,
      },
      needsPerson: {
        owner: parsed.needsPerson.owner ?? DEFAULT_NEEDS_PERSON_OWNER,
      },
      mergedTruthExceptions: parsed.mergedTruthExceptions,
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

/** The declared step plan (5e cut 3 — the one legacy flow collapsed to its
 * validated step list). Kind inference is positional: `merge` is the merge
 * step, everything after it is an action, everything before it a check. */
function declaredStepPlan(
  steps: readonly string[],
  definitions: Readonly<Record<string, YrdStepConfig>>,
): readonly StepDef[] {
  const mergeIndex = steps.indexOf("merge")
  return defineStepPlan(
    steps.map((name, index) => {
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
  )
}

/** The ordered step names a parsed config declares: its checks, then the
 * built-in merge.
 *
 * ONE definition, shared by the process's own config load and by the per-Run
 * read of the config blob at a Run's base sha. A second spelling of this list
 * is how a queue comes to execute something other than what it declares
 * (23192), so there is deliberately only one. */
export function declaredStepNames(config: YrdProjectConfig): readonly string[] {
  return [...config.checks.map(checkName), "merge"]
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
