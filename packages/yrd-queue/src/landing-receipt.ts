import {
  ChangeIdSchema,
  GitShaSchema,
  PRIdSchema,
  PRLandingReceiptReplayMissingFieldSchema,
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
    environmentHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    durationMs: z.number().nonnegative(),
  })
  .strict()

export const LandingReceiptPinSchema = z
  .object({
    path: z.string().min(1),
    before: GitShaSchema.nullable(),
    after: GitShaSchema,
  })
  .strict()

export const LandingReceiptBodySchema = z
  .object({
    landing: z
      .object({
        commit: GitShaSchema,
        baseBefore: GitShaSchema,
        baseAfter: GitShaSchema,
      })
      .strict(),
    candidate: z
      .object({
        id: z.string().regex(/^C\d+$/u),
        commit: GitShaSchema,
        tree: GitShaSchema,
      })
      .strict(),
    run: z.object({ id: z.string().trim().min(1) }).strict(),
    changes: z.array(CandidateChangeReceiptSchema),
    pins: z.array(LandingReceiptPinSchema),
    gates: z.array(LandingReceiptGateSchema),
    refusals: z.array(z.record(z.string(), z.unknown())),
  })
  .strict()
export type LandingReceiptBody = Readonly<z.infer<typeof LandingReceiptBodySchema>>

export const LegacyLandingReceiptBodySchema = z
  .object({
    provenance: z.literal("legacy-journal"),
    coverage: z.enum(["receipt", "tombstone"]),
    landing: z.object({ commit: GitShaSchema, baseAfter: GitShaSchema }).strict(),
    changes: z.array(
      z
        .object({
          pr: PRIdSchema,
          revision: z.number().int().positive(),
          submittedHead: GitShaSchema,
        })
        .strict(),
    ),
    missing: z.array(PRLandingReceiptReplayMissingFieldSchema),
    tombstoneReason: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine(({ coverage, tombstoneReason }, context) => {
    if ((coverage === "tombstone") !== (tombstoneReason !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["tombstoneReason"],
        message: "tombstone coverage requires one explicit reason and physical coverage forbids one",
      })
    }
  })
export type LegacyLandingReceiptBody = Readonly<z.infer<typeof LegacyLandingReceiptBodySchema>>

export const LandingReceiptEnvelopeSchema = z
  .object({
    schema: z.literal("yrd/landing-receipt/v1"),
    receipt: LandingReceiptBodySchema,
    checksum: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = landingReceiptChecksum(value.receipt)
    if (value.checksum !== expected) {
      context.addIssue({ code: "custom", path: ["checksum"], message: `expected ${expected}` })
    }
  })
export type LandingReceiptEnvelope = Readonly<z.infer<typeof LandingReceiptEnvelopeSchema>>

export const LegacyLandingReceiptEnvelopeSchema = z
  .object({
    schema: z.literal("yrd/landing-receipt-legacy/v1"),
    receipt: LegacyLandingReceiptBodySchema,
    checksum: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = createHash("sha256").update(canonicalJson(value.receipt)).digest("hex")
    if (value.checksum !== expected) {
      context.addIssue({ code: "custom", path: ["checksum"], message: `expected ${expected}` })
    }
  })
export type LegacyLandingReceiptEnvelope = Readonly<z.infer<typeof LegacyLandingReceiptEnvelopeSchema>>
export const RepositoryLandingReceiptEnvelopeSchema = z.union([
  LandingReceiptEnvelopeSchema,
  LegacyLandingReceiptEnvelopeSchema,
])
export type RepositoryLandingReceiptEnvelope = Readonly<z.infer<typeof RepositoryLandingReceiptEnvelopeSchema>>

export const LandingReceiptPointerSchema = PRLandingReceiptPointerSchema
export type LandingReceiptPointer = PRLandingReceiptPointer

function canonicalJson(value: unknown): string {
  const encoded = canonicalize(value)
  if (encoded === undefined) throw new TypeError("yrd: landing receipt must be canonical JSON data")
  return encoded
}

export function landingReceiptChecksum(receipt: LandingReceiptBody): string {
  return createHash("sha256")
    .update(canonicalJson(LandingReceiptBodySchema.parse(receipt)))
    .digest("hex")
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

export function createLegacyLandingReceipt(receipt: LegacyLandingReceiptBody): Readonly<{
  envelope: LegacyLandingReceiptEnvelope
  canonical: string
}> {
  const parsed = LegacyLandingReceiptBodySchema.parse(receipt)
  const envelope = LegacyLandingReceiptEnvelopeSchema.parse({
    schema: "yrd/landing-receipt-legacy/v1",
    receipt: parsed,
    checksum: createHash("sha256").update(canonicalJson(parsed)).digest("hex"),
  })
  return { envelope, canonical: canonicalJson(envelope) }
}

export function parseLandingReceipt(value: string): RepositoryLandingReceiptEnvelope {
  return RepositoryLandingReceiptEnvelopeSchema.parse(JSON.parse(value) as unknown)
}
