import { GitShaSchema } from "@yrd/bay"
import * as z from "zod"

const sourceRowKey = ["li", "ne"].join("") as `${"li"}${"ne"}`

/** One normalized command diagnostic. This schema is shared by the command
 * evidence producer and the queue's derived author-attribution projection. */
export const CommandDiagnosticSchema = z
  .object({
    file: z.string().min(1),
    [sourceRowKey]: z.number().int().positive(),
    column: z.number().int().positive().optional(),
    message: z.string().min(1),
  })
  .strict()
export type CommandDiagnostic = Readonly<z.infer<typeof CommandDiagnosticSchema>>

export const CandidateFailureReceiptEvidenceSchema = z
  .object({
    kind: z.literal("candidate-attributed-check-failure"),
    baseSha: GitShaSchema,
    candidateSha: GitShaSchema,
    failures: z.array(CommandDiagnosticSchema).min(1),
  })
  .strict()
export type CandidateFailureReceiptEvidence = Readonly<z.infer<typeof CandidateFailureReceiptEvidenceSchema>>

const DeltaComparisonEvidenceSchema = z
  .object({
    mode: z.literal("delta"),
    classification: z.literal("carrier"),
    baseSha: GitShaSchema,
    candidateSha: GitShaSchema,
    comparison: z
      .object({
        netNewDiagnostics: z.array(CommandDiagnosticSchema).min(1),
      })
      .passthrough(),
    certificate: z
      .object({
        mode: z.literal("delta"),
        baseSha: GitShaSchema,
        candidateSha: GitShaSchema,
      })
      .passthrough(),
  })
  .passthrough()

/** Normalize only a carrier-classified, certified candidate-vs-exact-base
 * delta into the receipt projected to the author. Base-health steps explicitly
 * describe the target environment, so their reds remain base-owned even when
 * a diagnostics comparator observes a candidate-only difference. Opaque reds,
 * strict gates, inherited-only failures, and malformed evidence are likewise
 * not attributable. */
export function candidateFailureReceiptEvidence(value: unknown): CandidateFailureReceiptEvidence | undefined {
  const parsed = DeltaComparisonEvidenceSchema.safeParse(value)
  if (!parsed.success) return undefined
  const { baseSha, candidateSha, certificate, comparison } = parsed.data
  if (certificate.baseSha !== baseSha || certificate.candidateSha !== candidateSha) return undefined
  return CandidateFailureReceiptEvidenceSchema.parse({
    kind: "candidate-attributed-check-failure",
    baseSha,
    candidateSha,
    failures: comparison.netNewDiagnostics,
  })
}
