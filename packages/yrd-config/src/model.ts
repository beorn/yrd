import { createFailure, JournalCompatibilitySchema, type JournalCompatibility } from "@yrd/core"

const NamePattern = /^[a-z][a-z0-9_-]*$/u

export type SourceComposition = Readonly<{
  version: 1
  sources: readonly Readonly<{
    repo: string
    branch: string
    baseSha: string
    tipSha: string
    payload: readonly string[]
  }>[]
}>

/** Immutable facts available before a change exists. Flow predicates must never
 * inspect mutable PR or Candidate state. */
export type Submission = Readonly<{
  base: string
  branch: string
  head: string
  composition?: SourceComposition
  bay?: string
  issue?: string
}>

export type StepKind = "check" | "action" | "merge"
export type RunnerBinding = "local" | "waiting"

export type StepOptions = Readonly<{
  run?: string
  runner?: RunnerBinding
  required?: boolean
  timeoutMs?: number
  noProgressMs?: number
  env?: Readonly<Record<string, string>>
  classification?: "base" | "carrier"
}>

export type StepDef = Readonly<
  StepOptions & {
    name: string
    kind: StepKind
    runner: RunnerBinding
  }
>

export type JournalConfigDef = Readonly<{
  kind: "journal"
  compatibility: JournalCompatibility
}>

function configuration(code: string, message: string): never {
  throw createFailure({ kind: "configuration", code, message })
}

function text(value: string, label: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) configuration("invalid-flow", `yrd: ${label} cannot be blank`)
  return normalized
}

function name(value: string, label: string): string {
  const normalized = text(value, label)
  if (!NamePattern.test(normalized)) {
    configuration("invalid-flow", `yrd: ${label} '${normalized}' must match ${NamePattern.source}`)
  }
  return normalized
}

function positive(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 1) {
    configuration("invalid-flow", `yrd: ${label} must be a positive integer`)
  }
  return value
}

function step(kind: StepKind, stepName: string, options: StepOptions = {}): StepDef {
  const normalizedName = name(stepName, "step name")
  const runner = options.runner ?? "local"
  return Object.freeze({
    name: normalizedName,
    kind,
    runner,
    ...(options.run === undefined ? {} : { run: text(options.run, `run for step '${normalizedName}'`) }),
    ...(options.required === undefined ? {} : { required: options.required }),
    ...(positive(options.timeoutMs, `timeoutMs for step '${normalizedName}'`) === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
    ...(positive(options.noProgressMs, `noProgressMs for step '${normalizedName}'`) === undefined
      ? {}
      : { noProgressMs: options.noProgressMs }),
    ...(options.env === undefined ? {} : { env: Object.freeze({ ...options.env }) }),
    ...(options.classification === undefined ? {} : { classification: options.classification }),
  })
}

/** Extension-author spelling. */
export function withCheckStep(stepName: string, options: StepOptions = {}): StepDef {
  return step("check", stepName, options)
}

/** Extension-author spelling. */
export function withActionStep(stepName: string, options: StepOptions = {}): StepDef {
  return step("action", stepName, options)
}

/** Extension-author spelling. The merge boundary has one canonical name. */
export function withMergeStep(options: StepOptions = {}): StepDef {
  return step("merge", "merge", options)
}

/** Validate and freeze the one declared step plan (5e cut 3 — exactly one
 * flow ever existed, so the flow wrapper collapsed to its step list). The
 * validation is the old flow validation: named steps, no duplicates, at most
 * one merge step. */
export function defineStepPlan(definitions: readonly StepDef[]): readonly StepDef[] {
  if (definitions.length === 0) configuration("invalid-flow", "yrd: the step plan has no steps")
  const steps = definitions.map((candidate) => step(candidate.kind, candidate.name, candidate))
  const duplicate = steps.find(
    (candidate, index) => steps.findIndex((other) => other.name === candidate.name) !== index,
  )
  if (duplicate !== undefined) {
    configuration("invalid-flow", `yrd: the step plan contains duplicate step '${duplicate.name}'`)
  }
  const merges = steps.filter((candidate) => candidate.kind === "merge")
  if (merges.length > 1) {
    configuration("invalid-flow", `yrd: the step plan permits at most one merge step; found ${merges.length}`)
  }
  return Object.freeze(steps)
}

/** Declare the oldest reader contract that every writer must preserve. */
export function withJournalCompatibility(compatibility: JournalCompatibility): JournalConfigDef {
  return Object.freeze({
    kind: "journal",
    compatibility: Object.freeze(JournalCompatibilitySchema.parse(compatibility)),
  })
}

/** Config-author spelling. The `with*` exports above are the same bindings for
 * extensions; neither surface introduces an object-schema DSL. */
export const yrd = Object.freeze({
  check: withCheckStep,
  action: withActionStep,
  merge: withMergeStep,
  journal: withJournalCompatibility,
})
