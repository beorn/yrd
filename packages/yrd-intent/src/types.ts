import { createHash } from "node:crypto"
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

/** The prefix every newly minted intent record carries. */
export const INTENT_ID_PREFIX = "yrdpin#"

/**
 * An intent record id, in either minted form.
 *
 * `yrdpin#<n>` is what {@link INTENT_ID_PREFIX} mints. `I<n>` is what the
 * counter minted before it, and live journals still carry records under those
 * keys — this alternation is the shape of the real data, not a compatibility
 * allowance. A replay parses every historical `intent/submitted` event, so a
 * schema that accepted only the new form would refuse to load journals that
 * already exist. Nothing renders one form as the other: a record named `I148`
 * IS `I148`, and only new records are born `yrdpin#`.
 *
 * `I<n>` also collided with `ChangeIdSchema` (`I` + 40 hex) on its prefix;
 * retiring it from the mint is what closes that collision going forward.
 */
export const IntentRecordIdSchema = z.string().regex(/^(?:I|yrdpin#)\d+$/u, "expected an intent id, e.g. yrdpin#162")

const INTENT_ID_NUMBER = /^(?:I|yrdpin#)(\d+)$/u

/** The counter value inside an intent id, in either form; `undefined` when the
 * string is not an intent id at all. */
export function intentIdNumber(id: string): number | undefined {
  const match = INTENT_ID_NUMBER.exec(id)
  return match === undefined || match === null ? undefined : Number(match[1])
}

/** The prefix every newly minted pin tombstone carries. Unlike the intent
 * counter this has only ever had one form, so there is nothing to alternate
 * over — but the shape stays the same as {@link intentIdNumber}'s, because the
 * two counters are read side by side and a lone hand-rolled slice is where the
 * next off-by-one hides. */
export const TOMBSTONE_ID_PREFIX = "T"

const TOMBSTONE_ID_NUMBER = /^T(\d+)$/u

/** The counter value inside a pin tombstone id; `undefined` when the string is
 * not a tombstone id at all. */
export function tombstoneIdNumber(id: string): number | undefined {
  const match = TOMBSTONE_ID_NUMBER.exec(id)
  return match === undefined || match === null ? undefined : Number(match[1])
}

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
export const RemedyStepSchema = z
  .object({
    argv: z.array(TextSchema).min(1).readonly(),
    cwd: TextSchema.optional(),
    note: TextSchema.optional(),
  })
  .strict()
export type RemedyStepV1 = z.infer<typeof RemedyStepSchema>

/** Render a remedy step as the shell line a human would type. */
export function renderRemedyStep(step: RemedyStepV1): string {
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
 * One failed attempt to land an intent, reduced to the facts that decide
 * whether retrying can ever help.
 *
 * `reason` is the human sentence and is deliberately NOT part of the
 * fingerprint — see {@link intentAttemptFingerprint}.
 */
export const IntentAttemptFailureSchema = z
  .object({
    /** The failing job's typed code, e.g. `carrier-drops-landed`. Open, not an
     * enum: the point of fingerprinting is that the code set is never closed. */
    code: TextSchema,
    /** The step that failed, when one did; absent for pre-step failures. */
    step: TextSchema.optional(),
    component: ComponentPathSchema,
    /** The component commit this attempt tried to pin. */
    target: CommitShaSchema.optional(),
    /** The component pin the attempt was evaluated against. */
    priorPin: CommitShaSchema.optional(),
    reason: TextSchema,
    /** When the attempt was observed to fail. Never fingerprinted — see below. */
    at: z.iso.datetime({ offset: true }),
  })
  .strict()
export type IntentAttemptFailure = z.infer<typeof IntentAttemptFailureSchema>

/**
 * The identity of a failure CAUSE, stable across attempts.
 *
 * Digested: the typed code, the failing step, and the component-level terms the
 * refusal was computed from (component, target, prior pin). Two attempts share
 * a fingerprint exactly when nothing that could change the answer has changed,
 * so a third identical one cannot succeed either.
 *
 * Deliberately NOT digested: `reason`. A rendered failure message carries the
 * run id, the attempt's scratch directory and its timestamps, so digesting it
 * would give every attempt a fresh fingerprint, park nothing, and leave the
 * lane spinning exactly as before — a silent no-op instead of a loud one. The
 * observed specimen message contained
 * `.git/yrd/scratch/yrd-queue-8BbPQW/worktree/dep-a`; the next attempt said
 * `yrd-queue-TlDgln`. The evidence tuple is what repeats; the sentence is not.
 *
 * Also deliberately NOT digested: the root base sha, and `at`. The base moves
 * whenever anything else lands, and a failure that survives a base move is MORE
 * dead, not less; `at` differs on every attempt by definition, so including it
 * would make every fingerprint unique and the whole predicate a no-op.
 */
export function intentAttemptFingerprint(failure: IntentAttemptFailure): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([failure.code, failure.step ?? null, failure.component, failure.target ?? null, failure.priorPin ?? null]),
    )
    .digest("hex")
    .slice(0, 16)
  return `${failure.code}:${digest}`
}

/**
 * How many consecutive attempts sharing one fingerprint park an intent.
 *
 * Three, not two: one repeat proves the failure survived a retry, two prove it
 * survived the retry of the retry. Below that a genuinely flaky infrastructure
 * failure would be parked as if it were dead.
 */
export const INTENT_PARK_AFTER_IDENTICAL_ATTEMPTS = 3

/** The disposition code every parked record carries. */
export const INTENT_PARK_DISPOSITION_CODE = "intent-attempts-exhausted"

/**
 * Why an intent stopped being retried, and what closes it.
 *
 * Parking is the QUEUE's verdict on a declared advance it cannot execute — not
 * a refusal (nothing evaluated it as wrong) and not a withdrawal (nobody asked
 * for it). It exists so the lane advances past work that can never succeed,
 * and it carries the remedy because the lane advancing is the moment the
 * owner stops finding out by watching the queue.
 */
export const IntentParkSchema = z
  .object({
    fingerprint: TextSchema,
    /** Consecutive attempts that produced {@link fingerprint}. */
    attempts: z.number().int().positive(),
    /** When the FIRST of those attempts failed — the start of the block. */
    since: z.iso.datetime({ offset: true }),
    /** Wall time the fingerprint has held, `failure.at` minus {@link since}. */
    blockedMs: z.number().int().nonnegative(),
    failure: IntentAttemptFailureSchema,
    /** Machine-executable steps, in the same shape every refusal remedy uses. */
    remedy: z.array(RemedyStepSchema).readonly(),
    /** One sentence naming the fix, for a page or a status row. */
    remedySummary: TextSchema,
  })
  .strict()
export type IntentPark = z.infer<typeof IntentParkSchema>

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
export const IntentStatusSchema = z.enum([
  "open",
  "integrated",
  "noop",
  "parked",
  "refused",
  "superseded",
  "withdrawn",
])
export type IntentStatus = z.infer<typeof IntentStatusSchema>

export const TERMINAL_INTENT_STATUSES: ReadonlySet<IntentStatus> = new Set<IntentStatus>([
  "integrated",
  "noop",
  "parked",
  "refused",
  "superseded",
  "withdrawn",
])

/**
 * Terminal statuses the owner may still close out by hand.
 *
 * A parked record is the queue's disposition, not the owner's: the queue gave
 * up retrying, and the lane-stall finding it raises keeps naming it until
 * someone acts. Resubmitting is one act; deciding the advance is no longer
 * wanted is the other, and without this carve-out that second act has no verb
 * and the finding has no clearing edge.
 */
export const WITHDRAWABLE_TERMINAL_STATUSES: ReadonlySet<IntentStatus> = new Set<IntentStatus>(["parked"])

export const PinIntentSchema = z
  .object({
    schema: z.literal(PIN_INTENT_SCHEMA),
    /** Human counter (`yrdpin#162`, …) — the operator-facing handle. */
    id: IntentRecordIdSchema,
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
    supersededBy: IntentRecordIdSchema.optional(),
    supersededIntent: IntentRecordIdSchema.optional(),
    supersedeConsent: z.enum(["same-submitter", "forced"]).optional(),
    disposition: IntentDispositionSchema.optional(),
    integration: PinIntentIntegrationSchema.optional(),
    evaluation: PinIntentEvaluationFactSchema.optional(),
    parked: IntentParkSchema.optional(),
  })
  .strict()
export type PinIntent = z.infer<typeof PinIntentSchema>

export const IntentParkArgsSchema = z.object({ intent: TextSchema, park: IntentParkSchema }).strict()
export type IntentParkArgs = z.infer<typeof IntentParkArgsSchema>

/**
 * The remedy for a parked intent, built from the failure alone.
 *
 * There is no per-code table here on purpose: an enumerated list is the exact
 * mistake the fingerprint exists to avoid, and a remedy keyed on a code set
 * would go quiet for the next unlisted one. Both steps are literally runnable —
 * a reader who types them is doing the right thing, which is the standing
 * obligation on every remedy string in this tool. The resubmit deliberately
 * omits `--target`: an absent target means "the component's trunk tip at
 * landing", which is the correct advance for a target that has diverged from
 * or fallen behind its own component main — the shape of both observed
 * specimens.
 */
function intentParkRemedy(
  intent: Readonly<{ id: string; issue: IssueRef }>,
  failure: IntentAttemptFailure,
  attempts: number,
): Readonly<{ remedy: readonly RemedyStepV1[]; remedySummary: string }> {
  const pinClause =
    failure.priorPin === undefined
      ? ""
      : ` The component was pinned at '${failure.priorPin}' when the attempt was evaluated.`
  const targetClause = failure.target === undefined ? "" : ` at target '${failure.target}'`
  return {
    remedy: [
      {
        argv: ["yrd", "intent", "show", intent.id],
        note: `read the ${attempts} identical '${failure.code}' failures and their evidence`,
      },
      {
        argv: ["yrd", "intent", "submit", "--component", failure.component, "--issue", intent.issue.id],
        note: "resubmit once the cause is fixed; omitting --target advances to the component's trunk tip at landing",
      },
    ],
    remedySummary:
      `Intent '${intent.id}' failed '${failure.code}' ${attempts} times in a row for '${failure.component}'` +
      `${targetClause}; retrying cannot change the outcome.${pinClause} Fix the cause, then resubmit for ` +
      `'${failure.component}' — or withdraw the intent if the advance is no longer wanted.`,
  }
}

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
  /** Retire a record the queue can no longer usefully retry, with its remedy. */
  park(args: IntentParkArgs): Promise<PinIntent>
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

/**
 * The park verdict for one intent's attempt history, oldest attempt first, or
 * `undefined` while another attempt could still change the answer.
 *
 * This is the whole policy, and it is deliberately code-blind: it counts the
 * trailing run of attempts that share {@link intentAttemptFingerprint} and
 * parks at {@link INTENT_PARK_AFTER_IDENTICAL_ATTEMPTS}. A caller that wanted
 * "park these known-deterministic codes" would have to pass a code list, and
 * there is nowhere to pass one — that is the point. The two specimens this was
 * built for refused with different codes on consecutive nights, and the code
 * that costs the next outage has not been written yet.
 *
 * Attempts whose fingerprints differ reset the count, which is what keeps a
 * flaky remote or a lost lease retrying instead of being buried.
 */
export function intentParkVerdict(
  intent: Readonly<{ id: string; issue: IssueRef }>,
  failures: readonly IntentAttemptFailure[],
): IntentPark | undefined {
  const latest = failures.at(-1)
  if (latest === undefined) return undefined
  const fingerprint = intentAttemptFingerprint(latest)
  let attempts = 0
  let since = latest.at
  for (let index = failures.length - 1; index >= 0; index -= 1) {
    const failure = failures[index]
    if (failure === undefined || intentAttemptFingerprint(failure) !== fingerprint) break
    attempts += 1
    since = failure.at
  }
  if (attempts < INTENT_PARK_AFTER_IDENTICAL_ATTEMPTS) return undefined
  return IntentParkSchema.parse({
    fingerprint,
    attempts,
    since,
    blockedMs: Math.max(0, Date.parse(latest.at) - Date.parse(since)),
    failure: latest,
    ...intentParkRemedy(intent, latest, attempts),
  })
}
