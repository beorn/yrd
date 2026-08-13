import { IssueRefSchema, type IssueRef } from "@yrd/issue"
import * as z from "zod"

/** Schema tag carried on every admitted record; the record's version is the tag. */
export const PIN_INTENT_SCHEMA = "yrd.intent.pin-advance.v1"
export const PIN_TOMBSTONE_SCHEMA = "yrd.intent.pin-tombstone.v1"

const TextSchema = z.string().trim().min(1)
const CommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/u, "expected a full 40-character commit sha")
const IntentIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u, "expected a lowercase UUID")
const CandidateIdSchema = z.string().regex(/^C\d+$/u, "expected a Candidate id")
const RunIdSchema = z.string().regex(/^R\d+$/u, "expected a Run id")

/**
 * Root-relative gitlink path of the component whose pin advances.
 *
 * The same normalization `GitPayloadPathSchema` applies to carrier payloads:
 * relative, forward-slashed, no traversal. A component path is identity here —
 * an intent for `../escape` is not a narrower request, it is a different repo.
 */
export const ComponentPathSchema = TextSchema.refine(
  (value) =>
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.split("/").some((segment) => segment === "" || segment === "." || segment === ".."),
  "expected a normalized root-relative component path",
)

/**
 * Preconditions are declared, not negotiated: both ancestry gates are TRUE and
 * not disableable in v1. `expectedCurrentPin` is the optional CAS guard, and a
 * violated guard outranks the noop outcome at evaluation time (design 4).
 *
 * `allowOffTrunk` is the one waiver, and it waives exactly one gate: the target
 * must be reachable from the component's own trunk. Absent — the only shape a
 * pre-waiver journal can hold — means the gate is ENFORCED; present means the
 * submitter declared a deliberate off-trunk pin, and the declaration is the
 * audit trail. A pin advance is a pointer move, so content only on the line the
 * trunk abandoned disappears without a diff anyone reads; the waiver has to be
 * something a reader can find on the record afterwards.
 */
export const PinIntentPreconditionsSchema = z
  .object({
    targetPublished: z.literal(true),
    targetDescendsFromCurrentPin: z.literal(true),
    allowOffTrunk: z.literal(true).optional(),
    expectedCurrentPin: CommitShaSchema.optional(),
  })
  .strict()
export type PinIntentPreconditions = z.infer<typeof PinIntentPreconditionsSchema>

/**
 * A machine-executable remedy step.
 *
 * The printed sentence is RENDERED from this record, never the reverse. Today
 * the queue prints prose and the resident re-parses it back into steps — a
 * self-inflicted NLP loop where a wording change silently flips a remedy from
 * self-applicable to judgment. A step is the argv plus the directory it runs
 * in; `note` is for the reader, never for the parser.
 */
export const RunnableRemedyStepSchema = z
  .object({
    argv: z.array(TextSchema).min(1).readonly(),
    cwd: TextSchema.optional(),
    note: TextSchema.optional(),
  })
  .strict()

/**
 * A remedy step whose action belongs to a different actor than whoever is
 * reading the refusal — the pipeline's own credential-bearing Job, a
 * component's maintaining developer, `@chief` — so it carries no `argv` and
 * must never be rendered as a shell line. Mirrors {@link RefusalRemedy}'s
 * `judgment` split (self-applicable steps vs. a reason a human must weigh):
 * a `judgment` remedy has no mechanical step at all, while this is one step
 * inside an otherwise-mechanical remedy that names the actor instead of a
 * command.
 */
export const NamedActorRemedyStepSchema = z.object({ humanRequired: z.literal(true), note: TextSchema }).strict()

export const RemedyStepSchema = z.union([RunnableRemedyStepSchema, NamedActorRemedyStepSchema])
export type RemedyStepV1 = z.infer<typeof RemedyStepSchema>

/**
 * Render a remedy step as the shell line a human would type — or, for a
 * {@link NamedActorRemedyStepSchema} step, the actor statement in `note`. A
 * `humanRequired` step is never turned into a runnable command.
 */
export function renderRemedyStep(step: RemedyStepV1): string {
  if ("humanRequired" in step) return step.note
  const command = step.argv.map(shellQuote).join(" ")
  return step.cwd === undefined ? command : `cd ${shellQuote(step.cwd)} && ${command}`
}

function shellQuote(value: string): string {
  return /^[\w./:@=-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}

/** Terminal dispositions carry the typed refusal code, never a parsed sentence. */
export const IntentDispositionSchema = z
  .object({ code: TextSchema, reason: TextSchema.optional(), at: TextSchema })
  .strict()
export type IntentDisposition = z.infer<typeof IntentDispositionSchema>

/**
 * One self-contained authored-to-landed lineage fact.
 *
 * Queue settlement emits this in the SAME journal frame as the landing. The
 * authored tuple is repeated deliberately: a lossless journal consumer can
 * prove what was declared and what landed without consulting a side store.
 */
export const PinIntentAuthoredSchema = z
  .object({
    intentId: IntentIdSchema,
    issue: IssueRefSchema,
    component: ComponentPathSchema,
    target: CommitShaSchema.optional(),
  })
  .strict()
export type PinIntentAuthored = z.infer<typeof PinIntentAuthoredSchema>
export const PinIntentEvaluationSchema = z.object({ priorPin: CommitShaSchema, target: CommitShaSchema }).strict()
export type PinIntentEvaluation = z.infer<typeof PinIntentEvaluationSchema>
export const PinIntentLandingSchema = z
  .object({
    candidate: CandidateIdSchema,
    run: RunIdSchema,
    /** Authoritative root tip from which the synthesized commit was built. */
    baseSha: CommitShaSchema,
    /** Synthesized root commit that was fast-forwarded after checks passed. */
    commit: CommitShaSchema,
    /** Tree identity used for check reuse; never substitute the commit SHA. */
    treeSha: CommitShaSchema,
    componentPin: CommitShaSchema,
  })
  .strict()
export type PinIntentLanding = z.infer<typeof PinIntentLandingSchema>

export type PinIntentRelation = "advance" | "noop" | "deferred"
export type PinIntentAdmitted = Readonly<{
  admitted: true
  currentPin: string
  target?: string
  relation: PinIntentRelation
}>
export type PinIntentRefused = Readonly<{
  admitted: false
  code:
    | "intent-component-unknown"
    | "intent-target-unpublished"
    | "intent-target-tombstoned"
    | "intent-target-off-trunk"
    | "intent-pin-divergent"
    | "intent-pin-moved"
    | "intent-checks-failed"
  message: string
  evidence: Readonly<{
    component: string
    target?: string
    currentPin?: string
    trunk?: string
    tombstone?: string
    declared?: readonly string[]
    candidate?: string
    run?: string
    step?: string
    attempts?: number
  }>
  remedy: readonly RemedyStepV1[]
}>
export type PinIntentAdmission = PinIntentAdmitted | PinIntentRefused

export const PinIntentRefusalSchema = z
  .object({
    code: z.enum([
      "intent-component-unknown",
      "intent-target-unpublished",
      "intent-target-tombstoned",
      "intent-target-off-trunk",
      "intent-pin-divergent",
      "intent-pin-moved",
      "intent-checks-failed",
    ]),
    message: TextSchema,
    evidence: z
      .object({
        component: ComponentPathSchema,
        target: CommitShaSchema.optional(),
        currentPin: CommitShaSchema.optional(),
        /** The component trunk tip the target failed to be reachable from. */
        trunk: CommitShaSchema.optional(),
        tombstone: CommitShaSchema.optional(),
        declared: z.array(ComponentPathSchema).readonly().optional(),
        candidate: CommitShaSchema.optional(),
        run: RunIdSchema.optional(),
        step: TextSchema.optional(),
        attempts: z.number().int().positive().optional(),
      })
      .strict(),
    remedy: z.array(RemedyStepSchema).readonly(),
  })
  .strict()

export const PinIntentEvaluationFactSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      intent: TextSchema,
      baseSha: CommitShaSchema,
      outcome: z.enum(["advance", "noop"]),
      evaluated: PinIntentEvaluationSchema,
    })
    .strict(),
  z
    .object({
      intent: TextSchema,
      baseSha: CommitShaSchema,
      outcome: z.literal("refused"),
      refusal: PinIntentRefusalSchema,
    })
    .strict(),
])
export type PinIntentEvaluationFact = z.infer<typeof PinIntentEvaluationFactSchema>

const pinIntentIntegrationShape = {
  authored: PinIntentAuthoredSchema,
  evaluated: PinIntentEvaluationSchema,
  landing: PinIntentLandingSchema,
} as const

export const PinIntentIntegrationSchema = z
  .object(pinIntentIntegrationShape)
  .strict()
  .superRefine((fact, context) => {
    if (fact.landing.componentPin !== fact.evaluated.target) {
      context.addIssue({
        code: "custom",
        path: ["landing", "componentPin"],
        message: "the merged component pin must equal the evaluated target",
      })
    }
  })
export type PinIntentIntegration = z.infer<typeof PinIntentIntegrationSchema>
export const PinIntentIntegratedFactSchema = z
  .object({ intent: TextSchema, ...pinIntentIntegrationShape })
  .strict()
  .superRefine((fact, context) => {
    if (fact.landing.componentPin !== fact.evaluated.target) {
      context.addIssue({
        code: "custom",
        path: ["landing", "componentPin"],
        message: "the merged component pin must equal the evaluated target",
      })
    }
  })
export type PinIntentIntegratedFact = z.infer<typeof PinIntentIntegratedFactSchema>

/**
 * `open` is the only non-terminal status. Every evaluation disposition is
 * terminal, which is what makes design 6.1 invariant 1
 * ("a terminal record holds no queue position") mechanical rather than a rule.
 */
export const IntentStatusSchema = z.enum(["open", "integrated", "noop", "refused", "superseded", "withdrawn"])
export type IntentStatus = z.infer<typeof IntentStatusSchema>

export const TERMINAL_INTENT_STATUSES: ReadonlySet<IntentStatus> = new Set<IntentStatus>([
  "integrated",
  "noop",
  "refused",
  "superseded",
  "withdrawn",
])

export const PinIntentSchema = z
  .object({
    schema: z.literal(PIN_INTENT_SCHEMA),
    /** Human counter (`I1`, `I2`, …) — the operator-facing handle. */
    id: TextSchema,
    /** UUIDv7 idempotency identity — the same id replays, never re-opens. */
    intentId: IntentIdSchema,
    issue: IssueRefSchema,
    component: ComponentPathSchema,
    /**
     * Absent means "the component's main tip at landing" — the queue derives
     * the value. Present, it is a CONSTRAINT CHECK, never an authored value the
     * queue must honor. This is the bridge to Lockfile Authority: the named
     * target is the transitional artifact, priced to disappear.
     */
    target: CommitShaSchema.optional(),
    preconditions: PinIntentPreconditionsSchema,
    submitter: TextSchema,
    submittedAt: TextSchema,
    status: IntentStatusSchema,
    supersededBy: TextSchema.optional(),
    supersededIntent: TextSchema.optional(),
    supersedeConsent: z.enum(["same-submitter", "forced"]).optional(),
    disposition: IntentDispositionSchema.optional(),
    integration: PinIntentIntegrationSchema.optional(),
    evaluation: PinIntentEvaluationFactSchema.optional(),
  })
  .strict()
export type PinIntent = z.infer<typeof PinIntentSchema>

export const IntentSubmitArgsSchema = z
  .object({
    intentId: IntentIdSchema,
    issue: IssueRefSchema,
    component: ComponentPathSchema,
    target: CommitShaSchema.optional(),
    expectedCurrentPin: CommitShaSchema.optional(),
    allowOffTrunk: z.boolean().optional(),
    submitter: TextSchema,
    forceSupersede: z.boolean().optional(),
  })
  .strict()
export type IntentSubmitArgs = z.infer<typeof IntentSubmitArgsSchema>

export const IntentWithdrawArgsSchema = z.object({ intent: TextSchema, reason: TextSchema.optional() }).strict()
export type IntentWithdrawArgs = z.infer<typeof IntentWithdrawArgsSchema>

export const PinTombstoneSchema = z
  .object({
    schema: z.literal(PIN_TOMBSTONE_SCHEMA),
    /** Human counter (`T1`, `T2`, …) — the operator-facing handle. */
    id: TextSchema,
    /** UUID idempotency identity — retries replay instead of duplicating policy. */
    tombstoneId: IntentIdSchema,
    issue: IssueRefSchema,
    component: ComponentPathSchema,
    /** A rolled-back component commit whose descendants must not re-enter. */
    sha: CommitShaSchema,
    submitter: TextSchema,
    reason: TextSchema.optional(),
    recordedAt: TextSchema,
  })
  .strict()
export type PinTombstone = z.infer<typeof PinTombstoneSchema>

export const PinTombstoneArgsSchema = PinTombstoneSchema.omit({ schema: true, id: true, recordedAt: true }).strict()
export type PinTombstoneArgs = z.infer<typeof PinTombstoneArgsSchema>

export type IntentsState = Readonly<{
  records: Readonly<Record<string, PinIntent>>
  /** Submission order — the FIFO position the queue reads. */
  order: readonly string[]
  tombstoneRecords: Readonly<Record<string, PinTombstone>>
  tombstoneOrder: readonly string[]
}>

export type Intents = Readonly<{
  submit(args: IntentSubmitArgs): Promise<PinIntent>
  tombstone(args: PinTombstoneArgs): Promise<PinTombstone>
  withdraw(intent: string, reason?: string): Promise<PinIntent>
  get(intent: string): PinIntent | undefined
  /** The open record for a (issue, component) key, if any. */
  live(issue: IssueRef, component: string): PinIntent | undefined
  /** Every record ever admitted, in submission order. */
  list(): readonly PinIntent[]
  /** Open records only, in submission order — terminal records hold no position. */
  queued(): readonly PinIntent[]
  /** Rollback invalidations, optionally narrowed to one component. */
  tombstones(component?: string): readonly PinTombstone[]
}>

export type HasIntents = Readonly<{ intents: Intents }>

/** The (issue, component) supersession key, separated unambiguously without a NUL source byte. */
export function intentKey(issue: IssueRef, component: string): string {
  return `${issue.source}:${issue.id}\0${component}`
}

/**
 * The replay fingerprint: everything a submitter declares. A repeated
 * `intentId` with a different fingerprint is a bug in the caller, not a retry,
 * so it is refused rather than silently replayed.
 */
export function intentFingerprint(
  input: Readonly<{
    issue: IssueRef
    component: string
    target?: string | undefined
    expectedCurrentPin?: string | undefined
    allowOffTrunk?: boolean | undefined
    submitter: string
  }>,
): string {
  return JSON.stringify([
    input.issue.source,
    input.issue.id,
    input.component,
    input.target ?? null,
    input.expectedCurrentPin ?? null,
    input.submitter,
    input.allowOffTrunk === true,
  ])
}

/** Fingerprint of an admitted record, in the same shape a submission produces. */
export function recordFingerprint(record: PinIntent): string {
  return intentFingerprint({
    issue: record.issue,
    component: record.component,
    submitter: record.submitter,
    ...(record.target === undefined ? {} : { target: record.target }),
    ...(record.preconditions.expectedCurrentPin === undefined
      ? {}
      : { expectedCurrentPin: record.preconditions.expectedCurrentPin }),
    ...(record.preconditions.allowOffTrunk === undefined ? {} : { allowOffTrunk: record.preconditions.allowOffTrunk }),
  })
}
