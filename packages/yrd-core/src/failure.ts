import * as z from "zod"

export const FailureKindSchema = z.enum(["usage", "configuration", "refusal", "infrastructure"])
export type FailureKind = z.infer<typeof FailureKindSchema>

export const FailureFactSchema = z
  .object({
    kind: FailureKindSchema,
    code: z.string().regex(/^[a-z][a-z0-9._-]*$/u),
    message: z.string().min(1),
    /**
     * The single member a failure is attributable to, when one is.
     *
     * A batch operation that fails because of ONE member must be able to say
     * which, structurally. Without this the id survives only inside `message`,
     * so every consumer that needs to act on the guilty member has to parse
     * prose — and a consumer that cannot parse it punishes the whole batch
     * instead. Absent means "not attributable to a single member", which is a
     * different fact from "attributable to a member we did not name".
     */
    pr: z.string().min(1).optional(),
  })
  .strict()
export type FailureFact = Readonly<z.infer<typeof FailureFactSchema>>

export type YrdFailure = Error & Readonly<{ name: "YrdFailure"; failure: FailureFact }>

export function createFailure(input: FailureFact, cause?: unknown): YrdFailure {
  const failure = Object.freeze(FailureFactSchema.parse(input))
  const error = cause === undefined ? new Error(failure.message) : new Error(failure.message, { cause })
  return Object.assign(error, { name: "YrdFailure" as const, failure })
}

export function failureFact(error: unknown): FailureFact | undefined {
  if (!(error instanceof Error) || error.name !== "YrdFailure" || !("failure" in error)) return undefined
  const parsed = FailureFactSchema.safeParse(error.failure)
  return parsed.success ? Object.freeze(parsed.data) : undefined
}

export function asFailure(
  error: unknown,
  fallback: Readonly<{ kind: FailureKind; code: string; message?: string }>,
): YrdFailure {
  if (failureFact(error) !== undefined) return error as YrdFailure
  const message = fallback.message ?? (error instanceof Error ? error.message : String(error))
  return createFailure({ kind: fallback.kind, code: fallback.code, message }, error)
}

export function raiseFailure(kind: FailureKind, code: string, message: string): never {
  throw createFailure({ kind, code, message })
}

/**
 * A thrown error that says of ITSELF that the caller can recover from it.
 *
 * Every ERROR-level row a queue pass emits now ends that pass (operator ruling
 * 2026-09-01: "any ERROR should result in it dying"), and a thrown failure
 * inside an observed lifecycle is one such row unless something says
 * otherwise. Some throws are races the runner already survives by design — a
 * peer holding the queue, a journal briefly busy, a job a concurrent writer
 * settled first — and the lifecycle that reports them cannot know that: it
 * sees a thrown error, not the catch block three frames up that will skip the
 * cycle. This marker moves that knowledge onto the error, where the thrower
 * has it, so the row it produces is the abnormal-recoverable WARN rather than
 * the ERROR that would stop the runner on a condition it was about to retry.
 *
 * A symbol rather than a FailureFact field: the fact is a persisted schema,
 * and "the process can retry this" is a claim about the process, not about
 * the journal row.
 */
const RECOVERABLE_FAILURE = Symbol.for("yrd.recoverable-failure")

export function markRecoverable<Failure extends Error>(error: Failure): Failure {
  Object.defineProperty(error, RECOVERABLE_FAILURE, { value: true, enumerable: false })
  return error
}

export function isRecoverableFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as Record<symbol, unknown>)[RECOVERABLE_FAILURE] === true
}
