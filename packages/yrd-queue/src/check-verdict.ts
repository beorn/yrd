/**
 * Durable check-verdict fact (@i/10-merge-queue/failed-check-erased boxes 1+3):
 * the schema, the pure fold, and the read ladder for the `check/verdict`
 * journal event — a required check's settled outcome keyed by CONTENT
 * (headSha + baseSha + step), never by a record id, so it answers for
 * grandfathered record-lane changes and recordless derived members alike, and
 * a same-sha resubmission reads the history its predecessor wrote.
 *
 * Everything here is PURE and persists nothing: no event registration, no
 * reducer wiring, no QueuesState shape change — the checkpoint identity does
 * not move with this module in the tree. The identity-moving door commit
 * (stage 2 of the approved design) registers `check/verdict`, adds the
 * `checkVerdicts` slice whose reducer case is {@link foldCheckVerdictFact},
 * and wires {@link verdictEligibilityStatus} / {@link projectVerdictCheckRecords}
 * into `checkEligibility` / `projectChangeChecks` verdict-first. Until then no
 * live caller imports this file; behavior today is unchanged by construction.
 *
 * Status vocabulary: `infrastructure` records an attempt that ENDED WITHOUT a
 * pass/fail verdict (runner died, check child SIGKILLed) and never claims one
 * — the same D1 honesty the pre-submit leg's SIGKILL raise applies (absence of
 * a verdict is refused, never invented). At the eligibility surface it renders
 * as `failed` with its receipt visible, matching how a lease-reaped check job
 * reads today, because `ChangeEligibility["checks"]["status"]` deliberately
 * has no infrastructure member.
 */
import { GitShaSchema } from "@yrd/bay"
import { JobErrorSchema } from "@yrd/job"
import canonicalize from "canonicalize"
import * as z from "zod"
import type { ChangeCheckRecord } from "./model.ts"

const TextSchema = z.string().trim().min(1)

export const CheckVerdictLegSchema = z.enum(["pre-submit", "admission", "carrier"])
export type CheckVerdictLeg = z.infer<typeof CheckVerdictLegSchema>

export const CheckVerdictStatusSchema = z.enum(["passed", "failed", "infrastructure"])
export type CheckVerdictStatus = z.infer<typeof CheckVerdictStatusSchema>

/**
 * The `check/verdict` event payload. Identity is the content triple
 * (`headSha`, `baseSha`, `step`); `member`/`revision`/`branch` are context the
 * reader may render but must never key on (merged-truth doctrine: ids are
 * context, not identity). `baseSha` absent means the check judged the tree
 * alone (the pre-submit leg); a composed admission/carrier check names the
 * base it composed against. `receipt` is required whenever the status is not
 * `passed`: a failure with no receipt is exactly the unexplained nothing this
 * event exists to abolish.
 */
export const CheckVerdictSchema = z
  .object({
    headSha: GitShaSchema,
    baseSha: GitShaSchema.optional(),
    step: TextSchema,
    stepRevision: TextSchema.optional(),
    leg: CheckVerdictLegSchema,
    status: CheckVerdictStatusSchema,
    exitCode: z.number().int().optional(),
    timedOut: z.literal(true).optional(),
    receipt: JobErrorSchema.optional(),
    artifact: TextSchema.optional(),
    job: TextSchema.optional(),
    run: TextSchema.optional(),
    member: TextSchema.optional(),
    revision: z.number().int().positive().optional(),
    branch: TextSchema.optional(),
    by: TextSchema,
    ref: TextSchema.optional(),
  })
  .strict()
  .refine((fact) => fact.status === "passed" || fact.receipt !== undefined, {
    message: "yrd: a non-passing check verdict must carry its receipt",
    path: ["receipt"],
  })
export type CheckVerdictFact = Readonly<z.infer<typeof CheckVerdictSchema>>

/** A verdict as the projection stores it: the fact plus the frame clock the
 * reducer stamps (`applied.ts`), exactly like `pr/checks-requested` rows. */
export type RecordedCheckVerdict = CheckVerdictFact & Readonly<{ at: string }>

/** Verdicts keyed by {@link checkVerdictTreeKey}, append-only per key. */
export type CheckVerdictsState = Readonly<Record<string, readonly RecordedCheckVerdict[]>>

export const emptyCheckVerdicts: CheckVerdictsState = Object.freeze({})

/**
 * The content key one tree's one check answers under. `baseSha` is part of the
 * key, not the identity of the work — the same head checked against two bases
 * is two answers (the `revisionCheckRequestTally` rule) — and its absent form
 * is spelled `-`, which no sha can collide with.
 */
export function checkVerdictTreeKey(headSha: string, baseSha: string | undefined, step: string): string {
  return `${headSha}:${baseSha ?? "-"}:${step}`
}

/**
 * THE fold — the future `check/verdict` reducer case, verbatim. Append-only:
 * nothing is ever rewritten or removed, attempts accumulate in frame order.
 * Ref-deduped: a producer idempotency `ref` already present under the key
 * returns the INPUT state unchanged (same reference), so an at-least-once
 * emitter converges to one row per attempt and replay stays a pure fold of
 * the frame sequence. Slice-absent tolerant: `undefined` state is the empty
 * slice, because pre-door checkpoints have no `checkVerdicts` key at all.
 */
export function foldCheckVerdictFact(
  state: CheckVerdictsState | undefined,
  fact: CheckVerdictFact,
  at: string,
): CheckVerdictsState {
  const current = state ?? emptyCheckVerdicts
  const key = checkVerdictTreeKey(fact.headSha, fact.baseSha, fact.step)
  const existing = current[key] ?? []
  if (fact.ref !== undefined && existing.some((verdict) => verdict.ref === fact.ref)) return current
  return { ...current, [key]: [...existing, { ...fact, at }] }
}

/** Every recorded verdict for one exact tree+base+step, oldest first;
 * `[]` from an absent slice — absence of evidence, never evidence. */
export function verdictsForTree(
  state: CheckVerdictsState | undefined,
  headSha: string,
  baseSha: string | undefined,
  step: string,
): readonly RecordedCheckVerdict[] {
  return state?.[checkVerdictTreeKey(headSha, baseSha, step)] ?? []
}

/** The current answer for one tree+base+step: the newest recorded attempt. */
export function latestVerdictForTree(
  state: CheckVerdictsState | undefined,
  headSha: string,
  baseSha: string | undefined,
  step: string,
): RecordedCheckVerdict | undefined {
  return verdictsForTree(state, headSha, baseSha, step).at(-1)
}

/**
 * Every recorded verdict for one head across all bases and steps, in a
 * deterministic order (key, then recorded position). The read a surface makes
 * when the base is unknown or gone — a withdrawn change, a `pr runs` history
 * section — so terminal delivery can no longer erase what ran.
 */
export function verdictsForHead(
  state: CheckVerdictsState | undefined,
  headSha: string,
): readonly RecordedCheckVerdict[] {
  if (state === undefined) return []
  const prefix = `${headSha}:`
  return Object.keys(state)
    .filter((key) => key.startsWith(prefix))
    .toSorted()
    .flatMap((key) => state[key] ?? [])
}

function verdictPayload(recorded: RecordedCheckVerdict): CheckVerdictFact {
  const { at: _at, ...payload } = recorded
  return payload
}

/**
 * Command-level idempotency (design A6): true when this exact fact already
 * stands under its key — by producer `ref` when the fact carries one, else by
 * whole-payload equality (RFC 8785 canonical JSON, the same `canonicalize`
 * the merge record uses). The recording command answers `events: []` on true,
 * so a retried settle emits nothing new.
 */
export function checkVerdictAlreadyRecorded(state: CheckVerdictsState | undefined, fact: CheckVerdictFact): boolean {
  const rows = verdictsForTree(state, fact.headSha, fact.baseSha, fact.step)
  if (fact.ref !== undefined) return rows.some((verdict) => verdict.ref === fact.ref)
  const encoded = canonicalize(fact)
  if (encoded === undefined) return false
  return rows.some((verdict) => canonicalize(verdictPayload(verdict)) === encoded)
}

/**
 * A verdict at the eligibility surface. `infrastructure` reads `failed` —
 * the attempt is over and did not pass; its receipt says why, exactly as a
 * lease-reaped check job renders today — because the checks status vocabulary
 * has no infrastructure member and inventing one is the S5 cutover's call.
 */
export function checkVerdictSurfaceStatus(verdict: RecordedCheckVerdict): "passed" | "failed" {
  return verdict.status === "passed" ? "passed" : "failed"
}

/**
 * The verdict leg of `checkEligibility`'s ladder, as a pure fold:
 *
 * 1. Any step whose newest verdict did not pass ⇒ `failed` — one red gate
 *    settles the revision, no later leg may soften it.
 * 2. Every named step's newest verdict passed ⇒ `passed`.
 * 3. Anything less — no verdicts at all, or coverage short of the full step
 *    list — ⇒ `undefined`: this leg holds insufficient evidence and the
 *    caller falls through to the legs that know about live jobs and runs.
 *    Partial passes are never promoted (`checksExit` counts only complete
 *    green) and an empty slice never renders as evidence (design A11).
 */
export function verdictEligibilityStatus(
  state: CheckVerdictsState | undefined,
  headSha: string,
  baseSha: string | undefined,
  steps: readonly string[],
): "passed" | "failed" | undefined {
  if (steps.length === 0) return undefined
  const latest = steps.map((step) => latestVerdictForTree(state, headSha, baseSha, step))
  if (latest.some((verdict) => verdict !== undefined && verdict.status !== "passed")) return "failed"
  if (latest.every((verdict) => verdict !== undefined && verdict.status === "passed")) return "passed"
  return undefined
}

export type VerdictStepSelector = Readonly<{ name: string; classification?: "base" | "carrier" }>

export type VerdictCheckContext = Readonly<{
  pr: string
  revision: number
  queuedAt?: string
}>

/**
 * Verdict rows in the `ChangeCheckRecord` shape `pr checks` prints — one row
 * per selected step whose tree holds a recorded verdict, newest attempt per
 * step. Steps with no verdict get NO row here: the caller merges its existing
 * fallback rows for those, so this leg adds evidence and never manufactures
 * it. Returns `undefined` when no selected step has any — the ladder falls
 * through untouched, which is the whole pre-door behavior contract.
 */
export function projectVerdictCheckRecords(
  state: CheckVerdictsState | undefined,
  headSha: string,
  baseSha: string | undefined,
  steps: readonly VerdictStepSelector[],
  context: VerdictCheckContext,
): ChangeCheckRecord[] | undefined {
  const rows: ChangeCheckRecord[] = []
  for (const step of steps) {
    const verdict = latestVerdictForTree(state, headSha, baseSha, step.name)
    if (verdict === undefined) continue
    const status = checkVerdictSurfaceStatus(verdict)
    rows.push({
      pr: context.pr,
      revision: context.revision,
      status,
      step: step.name,
      classification: step.classification ?? "carrier",
      command: [`check.${verdict.leg}.${verdict.step}`],
      ...(context.queuedAt === undefined ? {} : { queuedAt: context.queuedAt }),
      ...(verdict.job === undefined ? {} : { job: verdict.job }),
      ...(verdict.run === undefined ? {} : { run: verdict.run }),
      ...(verdict.artifact === undefined ? {} : { artifact: verdict.artifact }),
      ...(verdict.receipt === undefined ? {} : { diagnostics: verdict.receipt.message }),
      ...(status === "failed" && verdict.receipt !== undefined ? { error: verdict.receipt } : {}),
    })
  }
  return rows.length === 0 ? undefined : rows
}
