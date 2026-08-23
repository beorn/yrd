import { ChangeIdSchema, GitShaSchema } from "@yrd/bay"
import { QueueMemberIdSchema } from "./model.ts"
import { JobErrorSchema } from "@yrd/job"
import canonicalize from "canonicalize"
import { createHash } from "node:crypto"
import * as z from "zod"

export const MERGE_RECORD_REF = "refs/notes/yrd/merge-records" as const
export const MERGE_RECORD_NOTES_NAME = "yrd/merge-records" as const

/**
 * Retractions live on their OWN notes ref, never by editing the record they
 * retract. A merge record is immutable history: the estate's credibility rests on
 * nobody being able to rewrite what a merge claimed after the fact. So a repair
 * APPENDS a confession beside the record and leaves the original byte-identical,
 * which also makes the repair itself auditable and reversible.
 */
export const MERGE_RECORD_RETRACTION_REF = "refs/notes/yrd/merge-record-retractions" as const
export const MERGE_RECORD_RETRACTION_NOTES_NAME = "yrd/merge-record-retractions" as const

/**
 * Field shapes shared between the STRICT schemas below (what writers use, and what a
 * fully-current reader parses through) and the LENIENT siblings {@link parseMergeRecordTolerant}
 * uses for a record carrying fields newer than this checkout knows about. One shape, two
 * `unknownKeys` modes — sharing the shape is what keeps them from drifting apart; only
 * `.strict()` vs `.strip()` differs between a field's two schemas.
 */
const mergeRecordChangeShape = {
  changeId: ChangeIdSchema.optional(),
  /** A queue member, not necessarily a PR — `mergeRecordBody` fills this from
   * the member's `id`, so a merged intent records its own id here. */
  pr: QueueMemberIdSchema,
  revision: z.number().int().positive(),
  submittedHead: GitShaSchema,
  generatedCommit: GitShaSchema.optional(),
} as const
export const MergeRecordChangeSchema = z.object(mergeRecordChangeShape).strict()

const mergeRecordJobShape = {
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
} as const
export const MergeRecordJobSchema = z.object(mergeRecordJobShape).strict()

const mergeRecordPinShape = {
  path: z.string().trim().min(1),
  before: GitShaSchema.nullable(),
  after: GitShaSchema,
} as const
export const MergeRecordPinSchema = z.object(mergeRecordPinShape).strict()

const mergeRecordMergeShape = {
  id: z.string().trim().min(1),
  base: z.string().trim().min(1),
  baseSha: GitShaSchema,
  candidate: z.string().trim().min(1),
  result: z.enum(["merged", "failed", "canceled"]),
  mergedCommit: GitShaSchema.optional(),
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }),
} as const

const mergeRecordBodyResultInvariant = (
  record: Readonly<{ merge: Readonly<{ result: string; mergedCommit?: string }>; reason?: unknown }>,
  context: z.core.$RefinementCtx,
): void => {
  if (record.merge.result === "merged" && record.merge.mergedCommit === undefined) {
    context.addIssue({ code: "custom", path: ["merge", "mergedCommit"], message: "merged result needs commit" })
  }
  if (record.merge.result !== "merged" && record.reason === undefined) {
    context.addIssue({ code: "custom", path: ["reason"], message: "non-merged result needs reason" })
  }
}

export const MergeRecordBodySchema = z
  .object({
    merge: z.object(mergeRecordMergeShape).strict(),
    changes: z.array(MergeRecordChangeSchema).min(1),
    reason: JobErrorSchema.optional(),
    evidence: z.object({ jobs: z.array(MergeRecordJobSchema) }).strict(),
    pins: z.array(MergeRecordPinSchema),
    fix: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine(mergeRecordBodyResultInvariant)
export type MergeRecordBody = Readonly<z.infer<typeof MergeRecordBodySchema>>

/**
 * The same body shape, read tolerantly: every `.strict()` above becomes `.strip()`, so an
 * object carrying a field this checkout does not recognize — at the top level, inside
 * `merge`, inside one `changes`/`pins` entry, or inside `evidence.jobs` — parses instead of
 * throwing, with the unrecognized field silently DROPPED FROM THIS VALUE ONLY. Never used to
 * compute a checksum (that happens over the untouched raw JSON in
 * {@link parseMergeRecordTolerant}, before this schema ever sees it) and never used by a
 * writer. Reader-only, and only for the specific "extra field" drift — a record missing a
 * REQUIRED field still fails this schema exactly as it fails the strict one.
 */
const LenientMergeRecordBodySchema = z
  .object({
    merge: z.object(mergeRecordMergeShape).strip(),
    changes: z.array(z.object(mergeRecordChangeShape).strip()).min(1),
    reason: JobErrorSchema.optional(),
    evidence: z.object({ jobs: z.array(z.object(mergeRecordJobShape).strip()) }).strip(),
    pins: z.array(z.object(mergeRecordPinShape).strip()),
    fix: z.string().trim().min(1).optional(),
  })
  .strip()
  .superRefine(mergeRecordBodyResultInvariant)

/**
 * The contradiction that poisoned the estate: a merge that says it MERGED,
 * whose recorded result did not move the base, while still naming generated
 * commits it supposedly put on history. Nothing joined history, so no generated
 * commit can be reachable from the result, and the record can never prove itself.
 *
 * Deliberately a PREDICATE and not a schema refinement. A validation that refuses
 * to PARSE such a record would make the estate unrepairable — the repair path has
 * to read exactly the records that violate this to retract them. So the invariant
 * is enforced where records are WRITTEN, and merely reported where they are read.
 *
 * Returns the human-readable contradiction, or undefined when the record is sound.
 */
/**
 * The nothing-new outcome: a merged result that IS its own base joined nothing
 * to history — the change was already contained, and being up to date is a
 * success, not a defect.
 *
 * Deliberately a PROJECTION over facts the record already stores (result,
 * mergedCommit, baseSha), never a stored field: the body schema is `.strict()`,
 * so a new key would make every record written by a newer tree unreadable to
 * older checkouts — the exact whole-loader failure the tolerant-reader work
 * exists to prevent. Readers that want to SAY "Already up to date." ask this
 * predicate; the writer half (claiming no generated commits for such a merge)
 * is enforced where records are written.
 */
export function mergeJoinedNothing(record: MergeRecordBody): boolean {
  return (
    record.merge.result === "merged" &&
    record.merge.mergedCommit !== undefined &&
    record.merge.mergedCommit === record.merge.baseSha
  )
}

export function unprovableMergeRecordClaim(record: MergeRecordBody): string | undefined {
  if (record.merge.result !== "merged") return undefined
  const { mergedCommit, baseSha } = record.merge
  if (mergedCommit === undefined || mergedCommit !== baseSha) return undefined
  const claimed = record.changes.filter((change) => change.generatedCommit !== undefined)
  if (claimed.length === 0) return undefined
  return (
    `merge '${record.merge.id}' recorded mergedCommit '${mergedCommit}' equal to its own baseSha, so it ` +
    `joined nothing to merged history, yet claims generated commit(s) for ` +
    claimed.map((change) => `${change.pr} (${String(change.generatedCommit)})`).join(", ")
  )
}

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

/** The loosest possible envelope read: enough to find `record` and `checksum` and verify
 * the schema tag, deliberately NOT `.strict()` — an envelope-level field this checkout does
 * not recognize is dropped from this value only, exactly like a body-level one. */
const EnvelopeShapeSchema = z.object({
  schema: z.string(),
  record: z.unknown(),
  checksum: z.string().regex(/^[0-9a-f]{64}$/u),
})

/** One READ of a persisted merge record, never thrown — see {@link parseMergeRecordTolerant}. */
export type TolerantMergeRecordRead =
  | Readonly<{ outcome: "ok"; envelope: MergeRecordEnvelope }>
  | Readonly<{
      /** Parsed and checksum-verified, but with one or more fields this checkout's schema
       * does not recognize — dropped from `envelope`, named here so nothing is silent. */
      outcome: "ok-with-unknown-fields"
      envelope: MergeRecordEnvelope
      unknownFields: readonly string[]
    }>
  | Readonly<{ outcome: "unreadable"; reason: string }>

/**
 * Read a persisted merge record the way {@link parseMergeRecord} does, but never throw —
 * the PR1128 class applied to the merge-record store: one record a strict `.parse()` cannot
 * read must not veto every OTHER record a caller is scanning (`findRepositoryMergeRecords`'s
 * bulk recovery scan), and must not be misdiagnosed as corrupt when it is merely NEWER than
 * this checkout's schema.
 *
 * The checksum caution this exists to get right: {@link mergeRecordChecksum} verifies by
 * re-parsing through `MergeRecordBodySchema.strict()` and re-canonicalizing the RESULT. That
 * is correct for a writer serializing data it just built, but wrong for a reader tolerating
 * an unknown field — dropping the field before hashing produces a DIFFERENT digest than the
 * one the writer computed over the full record, so a perfectly authentic newer record would
 * fail its own checksum. This function hashes the RAW parsed JSON exactly as retrieved,
 * before any schema has touched it, which is the same bytes every writer — past, present, or
 * future-schema — canonicalized when it computed the checksum being verified.
 *
 * Only ONE failure mode is tolerated: `record` parses under {@link LenientMergeRecordBodySchema}
 * but not under the strict one, and every issue the strict parse raised is `unrecognized_keys`
 * — an extra field, nothing else wrong. A record missing a required field, or one with a
 * field of the wrong type, is genuine corruption and still reads as `"unreadable"`: tolerance
 * for schema drift must never become tolerance for a broken record.
 */
export function parseMergeRecordTolerant(value: string): TolerantMergeRecordRead {
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(value)
  } catch (cause) {
    return { outcome: "unreadable", reason: `yrd: merge record is not valid JSON: ${errorMessage(cause)}` }
  }
  const envelopeShape = EnvelopeShapeSchema.safeParse(parsedJson)
  if (!envelopeShape.success) {
    return { outcome: "unreadable", reason: `yrd: merge record envelope is malformed: ${envelopeShape.error.message}` }
  }
  if (envelopeShape.data.schema !== "yrd/merge-record/v1") {
    return {
      outcome: "unreadable",
      reason: `yrd: merge record declares schema '${envelopeShape.data.schema}', expected 'yrd/merge-record/v1'`,
    }
  }
  const rawRecord = envelopeShape.data.record
  // The checksum caution: hash the untouched raw value, never a schema round-trip.
  const expectedChecksum = createHash("sha256").update(canonicalJson(rawRecord)).digest("hex")
  if (envelopeShape.data.checksum !== expectedChecksum) {
    return {
      outcome: "unreadable",
      reason:
        `yrd: merge record checksum does not match its content: envelope claims ` +
        `'${envelopeShape.data.checksum}', the stored record hashes to '${expectedChecksum}'`,
    }
  }
  const strict = MergeRecordBodySchema.safeParse(rawRecord)
  if (strict.success) {
    return { outcome: "ok", envelope: { schema: "yrd/merge-record/v1", record: strict.data, checksum: expectedChecksum } }
  }
  const onlyUnrecognizedKeys = strict.error.issues.every((issue) => issue.code === "unrecognized_keys")
  if (!onlyUnrecognizedKeys) {
    return {
      outcome: "unreadable",
      reason: `yrd: merge record does not match the expected shape: ${strict.error.message}`,
    }
  }
  const lenient = LenientMergeRecordBodySchema.safeParse(rawRecord)
  if (!lenient.success) {
    // Should be unreachable — the lenient schema is strictly weaker than the strict one, so
    // anything failing ONLY on unrecognized-keys under strict must pass lenient. Fail loud
    // rather than assume: a silent `undefined` here would be exactly the silent-fallback
    // shape this whole function exists to avoid.
    return {
      outcome: "unreadable",
      reason: `yrd: merge record carries only unrecognized fields but still failed the tolerant parse: ${lenient.error.message}`,
    }
  }
  const unknownFields = strict.error.issues.flatMap((issue) =>
    issue.code === "unrecognized_keys" ? issue.keys.map((key) => [...issue.path, key].join(".")) : [],
  )
  return {
    outcome: "ok-with-unknown-fields",
    envelope: { schema: "yrd/merge-record/v1", record: lenient.data, checksum: expectedChecksum },
    unknownFields,
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * A confession that one merge record cannot prove itself, appended beside it.
 *
 * `note` and `checksum` together bind the retraction to EXACTLY the record it
 * names. Without both, a retraction written for one record could silence a
 * different record that later occupied the same anchor — which would turn the
 * repair verb into a way of hiding real corruption, the opposite of its purpose.
 */
export const MergeRecordRetractionSchema = z
  .object({
    schema: z.literal("yrd/merge-record-retraction/v1"),
    /** Blob sha of the retracted note, as `git notes list` reports it. */
    note: GitShaSchema,
    /**
     * Checksum and merge id CORROBORATE; the binding is `note` alone.
     *
     * Both are absent when the record was too damaged to parse — and that is
     * exactly the record most in need of retracting, so requiring them would
     * make the worst case unrepairable. The blob sha already pins the bytes.
     */
    checksum: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    merge: z.string().trim().min(1).optional(),
    /** Why it cannot prove itself, in the verifier's own words. */
    reason: z.string().trim().min(1),
    /** Which producer class this record came from, when it is known. */
    classification: z.enum(["unreachable-generated-commit", "change-id-mismatch", "unreadable", "other"]),
    retractedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
export type MergeRecordRetraction = Readonly<z.infer<typeof MergeRecordRetractionSchema>>

export function createMergeRecordRetraction(
  retraction: MergeRecordRetraction,
): Readonly<{ retraction: MergeRecordRetraction; canonical: string }> {
  const parsed = MergeRecordRetractionSchema.parse(retraction)
  return { retraction: parsed, canonical: canonicalJson(parsed) }
}

export function parseMergeRecordRetraction(value: string): MergeRecordRetraction {
  return MergeRecordRetractionSchema.parse(JSON.parse(value) as unknown)
}
