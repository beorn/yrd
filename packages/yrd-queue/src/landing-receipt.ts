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

const FailedAttemptChangeSchema = z
  .object({
    pr: PRIdSchema,
    revision: z.number().int().positive(),
    submittedHead: GitShaSchema,
    changeId: ChangeIdSchema,
  })
  .strict()

const FailedAttemptRecordedAtSchema = z.iso.datetime({ offset: true })

export const FailedAttemptReceiptBodySchema = z
  .object({
    kind: z.literal("failed-attempt"),
    change: FailedAttemptChangeSchema,
    attempt: z.discriminatedUnion("source", [
      z
        .object({
          source: z.literal("queue-admission"),
          step: z.string().trim().min(1).optional(),
          count: z.number().int().positive(),
          recordedAt: FailedAttemptRecordedAtSchema,
        })
        .strict(),
      z
        .object({
          source: z.literal("revision-admission"),
          step: z.string().trim().min(1),
          baseSha: GitShaSchema,
          recordedAt: FailedAttemptRecordedAtSchema,
        })
        .strict(),
      z
        .object({
          source: z.literal("run-step"),
          run: z.string().trim().min(1),
          candidate: z.string().trim().min(1),
          step: z.string().trim().min(1),
          job: z.string().trim().min(1),
          attempt: z.number().int().positive(),
          recordedAt: FailedAttemptRecordedAtSchema,
        })
        .strict(),
    ]),
    failure: z
      .object({
        code: z.string().trim().min(1),
        message: z.string().trim().min(1),
      })
      .strict(),
    settlement: z
      .object({
        disposition: z.literal("needs-person"),
        reason: z.string().trim().min(1),
        settledAt: FailedAttemptRecordedAtSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
export type FailedAttemptReceiptBody = Readonly<z.infer<typeof FailedAttemptReceiptBodySchema>>

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
export const FailedAttemptReceiptEnvelopeSchema = z
  .object({
    schema: z.literal("yrd/failed-attempt-receipt/v1"),
    receipt: FailedAttemptReceiptBodySchema,
    checksum: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = createHash("sha256").update(canonicalJson(value.receipt)).digest("hex")
    if (value.checksum !== expected) {
      context.addIssue({ code: "custom", path: ["checksum"], message: `expected ${expected}` })
    }
  })
export type FailedAttemptReceiptEnvelope = Readonly<z.infer<typeof FailedAttemptReceiptEnvelopeSchema>>
export const RepositoryLandingReceiptEnvelopeSchema = z.union([
  LandingReceiptEnvelopeSchema,
  LegacyLandingReceiptEnvelopeSchema,
  FailedAttemptReceiptEnvelopeSchema,
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

export function createFailedAttemptReceipt(receipt: FailedAttemptReceiptBody): Readonly<{
  envelope: FailedAttemptReceiptEnvelope
  canonical: string
}> {
  const parsed = FailedAttemptReceiptBodySchema.parse(receipt)
  const envelope = FailedAttemptReceiptEnvelopeSchema.parse({
    schema: "yrd/failed-attempt-receipt/v1",
    receipt: parsed,
    checksum: createHash("sha256").update(canonicalJson(parsed)).digest("hex"),
  })
  return { envelope, canonical: canonicalJson(envelope) }
}

export function parseLandingReceipt(value: string): RepositoryLandingReceiptEnvelope {
  return RepositoryLandingReceiptEnvelopeSchema.parse(JSON.parse(value) as unknown)
}
