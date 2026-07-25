import { createHash } from "node:crypto"
import { createFailure } from "@yrd/core"

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

/** Immutable facts available before a PR exists. Flow predicates must never
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

export type FlowDef = Readonly<{
  name: string
  rev: string
  on: (submission: Submission) => boolean
  steps: readonly StepDef[]
}>

export type FlowPin = Readonly<{
  name: string
  rev: string
  fingerprint: string
}>

export type YrdConfig = Readonly<{ flows: readonly FlowDef[] }>
export type SelectedFlow = Readonly<{ flow: FlowDef; pin: FlowPin }>

export type FlowDiagnostic = Readonly<{
  severity: "warning" | "refusal"
  code: "flow-missing" | "flow-revision-drift" | "flow-fingerprint-drift"
  message: string
  expected: FlowPin
  current?: FlowPin
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

/** Extension-author spelling. */
export function withFlow(definition: FlowDef): FlowDef {
  const flowName = name(definition.name, "flow name")
  const rev = text(definition.rev, `revision for flow '${flowName}'`)
  if (typeof definition.on !== "function") {
    configuration("invalid-flow", `yrd: flow '${flowName}' requires an on(Submission) predicate`)
  }
  if (definition.steps.length === 0) configuration("invalid-flow", `yrd: flow '${flowName}' has no steps`)
  const steps = definition.steps.map((candidate) => step(candidate.kind, candidate.name, candidate))
  const duplicate = steps.find(
    (candidate, index) => steps.findIndex((other) => other.name === candidate.name) !== index,
  )
  if (duplicate !== undefined) {
    configuration("invalid-flow", `yrd: flow '${flowName}' contains duplicate step '${duplicate.name}'`)
  }
  const merges = steps.filter((candidate) => candidate.kind === "merge")
  if (merges.length > 1) {
    configuration("invalid-flow", `yrd: flow '${flowName}' permits at most one merge step; found ${merges.length}`)
  }
  return Object.freeze({ name: flowName, rev, on: definition.on, steps: Object.freeze(steps) })
}

/** One config constructor; the variadic form keeps author files declarative. */
export function defineConfig(...definitions: readonly FlowDef[]): YrdConfig {
  const flows = definitions.map(withFlow)
  if (flows.length === 0) configuration("invalid-config", "yrd: config requires at least one flow")
  const duplicate = flows.find(
    (candidate, index) => flows.findIndex((other) => other.name === candidate.name) !== index,
  )
  if (duplicate !== undefined) {
    configuration("invalid-config", `yrd: config contains duplicate flow '${duplicate.name}'`)
  }
  return Object.freeze({ flows: Object.freeze(flows) })
}

/** Structural identity deliberately excludes executable text and predicates.
 * It changes only when the declared workflow graph changes. */
export function flowFingerprint(flow: Pick<FlowDef, "steps">): string {
  const structure = flow.steps.map(({ name: stepName, kind, runner }) => ({ name: stepName, kind, runner }))
  return createHash("sha256").update(JSON.stringify(structure)).digest("hex")
}

export function flowPin(flow: FlowDef): FlowPin {
  return Object.freeze({ name: flow.name, rev: flow.rev, fingerprint: flowFingerprint(flow) })
}

/** Exactly-one matching is an invariant, never array-order policy. */
export function selectFlow(config: YrdConfig, submission: Submission): SelectedFlow {
  const matches = config.flows.filter((flow) => flow.on(submission))
  if (matches.length === 0) {
    const available = config.flows
      .map((flow) => flow.name)
      .toSorted()
      .join(", ")
    configuration("flow-selection-zero", `yrd: submission matched no flows; available flows: ${available}`)
  }
  if (matches.length !== 1) {
    const names = matches
      .map((flow) => flow.name)
      .toSorted()
      .join(", ")
    configuration("flow-selection-ambiguous", `yrd: submission matched multiple flows: ${names}`)
  }
  const selected = matches[0]
  if (selected === undefined) throw new Error("yrd: exact-one flow selection lost its match")
  return Object.freeze({ flow: selected, pin: flowPin(selected) })
}

/** Compare durable work with live base-authority config for `yrd doctor` and
 * resume gates. An unchanged-revision structural edit is warn-loud; a revision
 * mismatch is a hard refusal for pending/waiting work. */
export function diagnoseFlowPin(expected: FlowPin, config: YrdConfig): readonly FlowDiagnostic[] {
  const flow = config.flows.find((candidate) => candidate.name === expected.name)
  if (flow === undefined) {
    return [
      Object.freeze({
        severity: "refusal",
        code: "flow-missing",
        message: `yrd: pinned flow '${expected.name}' is absent from base-authority config`,
        expected,
      }),
    ]
  }
  const current = flowPin(flow)
  if (current.rev !== expected.rev) {
    return [
      Object.freeze({
        severity: "refusal",
        code: "flow-revision-drift",
        message: `yrd: pinned flow '${expected.name}' revision ${expected.rev} cannot resume under revision ${current.rev}`,
        expected,
        current,
      }),
    ]
  }
  if (current.fingerprint !== expected.fingerprint) {
    return [
      Object.freeze({
        severity: "warning",
        code: "flow-fingerprint-drift",
        message: `yrd: flow '${expected.name}' changed structure without bumping revision ${expected.rev}`,
        expected,
        current,
      }),
    ]
  }
  return []
}

/** Config-author spelling. The `with*` exports above are the same bindings for
 * extensions; neither surface introduces an object-schema DSL. */
export const yrd = Object.freeze({
  check: withCheckStep,
  action: withActionStep,
  merge: withMergeStep,
  flow: withFlow,
  config: defineConfig,
})
