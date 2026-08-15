import { ChangeIdSchema, GitShaSchema } from "@yrd/bay"
import { QueueMemberIdSchema } from "./model.ts"
import { JobErrorSchema } from "@yrd/job"
import canonicalize from "canonicalize"
import { createHash } from "node:crypto"
import * as z from "zod"

export const MERGE_RECORD_REF = "refs/notes/yrd/merge-records" as const
export const MERGE_RECORD_NOTES_NAME = "yrd/merge-records" as const

export const MergeRecordChangeSchema = z
  .object({
    changeId: ChangeIdSchema.optional(),
    /** A queue member, not necessarily a PR — `mergeRecordBody` fills this from
     * the member's `id`, so a landed intent records its own id here. */
    pr: QueueMemberIdSchema,
    revision: z.number().int().positive(),
    submittedHead: GitShaSchema,
    generatedCommit: GitShaSchema.optional(),
  })
  .strict()

export const MergeRecordJobSchema = z
  .object({
    id: z.string().trim().min(1),
    step: z.string().trim().min(1),
    attempt: z.number().int().positive(),
    startedAt: z.iso.datetime({ offset: true }).optional(),
    finishedAt: z.iso.datetime({ offset: true }).optional(),
    result: z.enum(["success", "failure", "cancelled", "skipped", "timed_out"]),
    configHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    environmentHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
  })
  .strict()

export const MergeRecordPinSchema = z
  .object({ path: z.string().trim().min(1), before: GitShaSchema.nullable(), after: GitShaSchema })
  .strict()

export const MergeRecordBodySchema = z
  .object({
    merge: z
      .object({
        id: z.string().trim().min(1),
        base: z.string().trim().min(1),
        baseSha: GitShaSchema,
        candidate: z.string().trim().min(1),
        result: z.enum(["merged", "failed", "canceled"]),
        mergedCommit: GitShaSchema.optional(),
        /** Set when this merge reused a check verdict across the queue's own
         * base motion instead of re-proving it: the base the carried verdict
         * was minted at. `baseSha` above is the base it landed on, so the two
         * together are the whole claim. Absent on an ordinary merge. */
        transplantedFromBase: GitShaSchema.optional(),
        startedAt: z.iso.datetime({ offset: true }),
        finishedAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
    changes: z.array(MergeRecordChangeSchema).min(1),
    reason: JobErrorSchema.optional(),
    evidence: z.object({ jobs: z.array(MergeRecordJobSchema) }).strict(),
    pins: z.array(MergeRecordPinSchema),
    fix: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.merge.result === "merged" && record.merge.mergedCommit === undefined) {
      context.addIssue({ code: "custom", path: ["merge", "mergedCommit"], message: "merged result needs commit" })
    }
    if (record.merge.result !== "merged" && record.reason === undefined) {
      context.addIssue({ code: "custom", path: ["reason"], message: "non-merged result needs reason" })
    }
  })
export type MergeRecordBody = Readonly<z.infer<typeof MergeRecordBodySchema>>

export const MergeRecordEnvelopeSchema = z
  .object({
    schema: z.literal("yrd/merge-record/v1"),
    record: MergeRecordBodySchema,
    checksum: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = mergeRecordChecksum(value.record)
    if (value.checksum !== expected) {
      context.addIssue({ code: "custom", path: ["checksum"], message: `expected ${expected}` })
    }
  })
export type MergeRecordEnvelope = Readonly<z.infer<typeof MergeRecordEnvelopeSchema>>

export const MergeRecordPointerSchema = z
  .object({
    ref: z.literal(MERGE_RECORD_REF),
    target: GitShaSchema,
    note: GitShaSchema,
    checksum: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict()
export type MergeRecordPointer = Readonly<z.infer<typeof MergeRecordPointerSchema>>

function canonicalJson(value: unknown): string {
  const encoded = canonicalize(value)
  if (encoded === undefined) throw new TypeError("yrd: merge record must be canonical JSON data")
  return encoded
}

export function mergeRecordChecksum(record: MergeRecordBody): string {
  return createHash("sha256")
    .update(canonicalJson(MergeRecordBodySchema.parse(record)))
    .digest("hex")
}

export function createMergeRecord(record: MergeRecordBody): Readonly<{
  envelope: MergeRecordEnvelope
  canonical: string
}> {
  const parsed = MergeRecordBodySchema.parse(record)
  const envelope = MergeRecordEnvelopeSchema.parse({
    schema: "yrd/merge-record/v1",
    record: parsed,
    checksum: mergeRecordChecksum(parsed),
  })
  return { envelope, canonical: canonicalJson(envelope) }
}

export function parseMergeRecord(value: string): MergeRecordEnvelope {
  return MergeRecordEnvelopeSchema.parse(JSON.parse(value) as unknown)
}
