import * as z from "zod"

export const FailureKindSchema = z.enum(["usage", "configuration", "refusal", "infrastructure"])
export type FailureKind = z.infer<typeof FailureKindSchema>

export const FailureFactSchema = z
  .object({
    kind: FailureKindSchema,
    code: z.string().regex(/^[a-z][a-z0-9._-]*$/u),
    message: z.string().min(1),
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
