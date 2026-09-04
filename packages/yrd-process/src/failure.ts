import * as z from "zod"

export const FailureKindSchema = z.enum(["usage", "configuration", "refusal", "infrastructure"])
export type FailureKind = z.infer<typeof FailureKindSchema>

export const FailureEventSchema = z
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
     * different outcome from "attributable to a member we did not name".
     */
    pr: z.string().min(1).optional(),
  })
  .strict()
export type FailureEvent = Readonly<z.infer<typeof FailureEventSchema>>

export type YrdFailure = Error & Readonly<{ name: "YrdFailure"; failure: FailureEvent }>

export function createFailure(input: FailureEvent, cause?: unknown): YrdFailure {
  const failure = Object.freeze(FailureEventSchema.parse(input))
  const error = cause === undefined ? new Error(failure.message) : new Error(failure.message, { cause })
  return Object.assign(error, { name: "YrdFailure" as const, failure })
}

export function failureEvent(error: unknown): FailureEvent | undefined {
  if (!(error instanceof Error) || error.name !== "YrdFailure" || !("failure" in error)) return undefined
  const parsed = FailureEventSchema.safeParse(error.failure)
  return parsed.success ? Object.freeze(parsed.data) : undefined
}
