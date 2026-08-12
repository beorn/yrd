import {
  ChangeIdSchema,
  GitShaSchema,
  PRIdSchema,
  PRLandingReceiptPointerSchema,
  type PRLandingReceiptPointer,
} from "@yrd/bay"
import canonicalize from "canonicalize"
import { createHash } from "node:crypto"
import * as z from "zod"

export const LANDING_RECEIPT_REF = "refs/notes/yrd/receipts" as const
export const LANDING_RECEIPT_NOTES_NAME = "yrd/receipts" as const

export const CandidateChangeReceiptSchema = z
  .object({
    changeId: ChangeIdSchema,
    pr: PRIdSchema,
    revision: z.number().int().positive(),
    submittedHead: GitShaSchema,
    generatedCommit: GitShaSchema,
  })
  .strict()
export type CandidateChangeReceipt = Readonly<z.infer<typeof CandidateChangeReceiptSchema>>

export const LandingReceiptGateSchema = z
  .object({
    identity: z.string().trim().min(1),
    attempt: z.number().int().positive(),
    configHash: z.string().regex(/^[0-9a-f]{64}$/u),
    environmentHash: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
    durationMs: z.number().nonnegative(),
  })
  .strict()

export const LandingReceiptPinSchema = z
  .object({ path: z.string().min(1), before: GitShaSchema.nullable(), after: GitShaSchema })
  .strict()

export const LandingReceiptBodySchema = z
  .object({
    landing: z.object({ commit: GitShaSchema, baseBefore: GitShaSchema, baseAfter: GitShaSchema }).strict(),
    candidate: z.object({ id: z.string().regex(/^C\d+$/u), commit: GitShaSchema, tree: GitShaSchema }).strict(),
    run: z
      .object({
        id: z.string().trim().min(1),
        startedAt: z.iso.datetime({ offset: true }),
        landedAt: z.iso.datetime({ offset: true }),
        driver: z
          .object({
            identity: z.string().trim().min(1),
            epoch: z.string().trim().min(1),
            job: z.string().trim().min(1),
            attempt: z.number().int().positive(),
          })
          .strict(),
      })
      .strict(),
    changes: z.array(CandidateChangeReceiptSchema).min(1),
    pins: z.array(LandingReceiptPinSchema),
    gates: z.array(LandingReceiptGateSchema).min(1),
    refusals: z.array(z.record(z.string(), z.unknown())),
  })
  .strict()
export type LandingReceiptBody = Readonly<z.infer<typeof LandingReceiptBodySchema>>

export const LandingReceiptEnvelopeSchema = z
  .object({
    schema: z.literal("yrd/landing-receipt/v1"),
    receipt: LandingReceiptBodySchema,
    checksum: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = landingReceiptChecksum(value.receipt)
    if (value.checksum !== expected) context.addIssue({ code: "custom", path: ["checksum"], message: `expected ${expected}` })
  })
export type LandingReceiptEnvelope = Readonly<z.infer<typeof LandingReceiptEnvelopeSchema>>

export const LandingReceiptPointerSchema = PRLandingReceiptPointerSchema
export type LandingReceiptPointer = PRLandingReceiptPointer

function canonicalJson(value: unknown): string {
  const encoded = canonicalize(value)
  if (encoded === undefined) throw new TypeError("yrd: landing receipt must be canonical JSON data")
  return encoded
}

export function landingReceiptChecksum(receipt: LandingReceiptBody): string {
  return createHash("sha256").update(canonicalJson(LandingReceiptBodySchema.parse(receipt))).digest("hex")
}

export function createLandingReceipt(receipt: LandingReceiptBody): Readonly<{
  envelope: LandingReceiptEnvelope
  canonical: string
}> {
  const parsed = LandingReceiptBodySchema.parse(receipt)
  const envelope = LandingReceiptEnvelopeSchema.parse({
    schema: "yrd/landing-receipt/v1",
    receipt: parsed,
    checksum: landingReceiptChecksum(parsed),
  })
  return { envelope, canonical: canonicalJson(envelope) }
}

export function parseLandingReceipt(value: string): LandingReceiptEnvelope {
  return LandingReceiptEnvelopeSchema.parse(JSON.parse(value) as unknown)
}
