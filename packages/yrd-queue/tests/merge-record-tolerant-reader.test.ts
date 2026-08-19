/**
 * @failure `parseMergeRecord` round-trips a record through `MergeRecordBodySchema`'s
 * `.strict()` parse to verify its checksum — so a record written by a NEWER process with
 * one additional field fails `.strict()` parsing before the checksum is even computed, and
 * a naive tolerant fix that drops the unknown field before re-hashing would compute the
 * checksum over different bytes than the writer did, rejecting a perfectly authentic record
 * as corrupt. This is the shaset (d) checksum caution: verify against the RAW stored
 * canonical bytes, never a lossy re-serialization.
 * @level l2
 * @consumer @yrd/queue
 */
import { createHash } from "node:crypto"
import canonicalize from "canonicalize"
import { describe, expect, it } from "vitest"
import {
  createMergeRecord,
  parseMergeRecord,
  parseMergeRecordTolerant,
  type MergeRecordBody,
} from "../src/merge-record.ts"

/** Checksum the way a NEWER `mergeRecordChecksum` would, over the record exactly as
 * written — including a field this reader does not recognize. Standing in for a future
 * writer; must never be implemented by calling this file's own `mergeRecordChecksum`,
 * which round-trips through today's `.strict()` schema and would throw on that field. */
function checksumOverRawContent(record: unknown): string {
  return createHash("sha256")
    .update(canonicalize(record) ?? "")
    .digest("hex")
}

const SHA_MERGED = "a".repeat(40)
const SHA_SUBMITTED = "b".repeat(40)
const SHA_BASE = "c".repeat(40)
const SHA_PIN_BEFORE = "d".repeat(40)
const SHA_PIN_AFTER = "e".repeat(40)
const HASH_CONFIG = "1".repeat(64)
const HASH_ENVIRONMENT = "2".repeat(64)

const VALID_BODY: MergeRecordBody = {
  merge: {
    id: "RUN1",
    base: "main",
    baseSha: SHA_BASE,
    candidate: "CANDIDATE1",
    result: "merged",
    mergedCommit: SHA_MERGED,
    startedAt: "2026-08-13T00:00:00Z",
    finishedAt: "2026-08-13T00:01:00Z",
  },
  changes: [{ pr: "PR1", revision: 1, submittedHead: SHA_SUBMITTED }],
  evidence: {
    jobs: [
      {
        id: "JOB1",
        step: "check",
        attempt: 1,
        finishedAt: "2026-08-13T00:00:30Z",
        result: "success",
        configHash: HASH_CONFIG,
        environmentHash: HASH_ENVIRONMENT,
      },
    ],
  },
  pins: [{ path: "vendor/submodule", before: SHA_PIN_BEFORE, after: SHA_PIN_AFTER }],
}

describe("parseMergeRecordTolerant reads exactly what parseMergeRecord reads", () => {
  it("accepts a record with today's exact shape, same as the strict reader", () => {
    const { canonical } = createMergeRecord(VALID_BODY)
    const strict = parseMergeRecord(canonical)
    const result = parseMergeRecordTolerant(canonical)
    expect(result).toEqual({ outcome: "ok", envelope: strict })
  })

  it("refuses invalid JSON with a specific reason, never throws", () => {
    const result = parseMergeRecordTolerant("{not json")
    expect(result.outcome).toBe("unreadable")
    expect(result).toMatchObject({ reason: expect.stringContaining("not valid JSON") })
  })

  it("refuses a genuinely corrupt record (missing a required field), never mistaking it for 'merely newer'", () => {
    const { envelope } = createMergeRecord(VALID_BODY)
    // Drop a REQUIRED field. This is real corruption, not forward-compatible drift, and
    // the tolerant reader must not paper over it: silently accepting a structurally broken
    // record is the dangerous direction of leniency.
    const { id: _id, ...mergeWithoutId } = envelope.record.merge
    const corrupted = { ...envelope, record: { ...envelope.record, merge: mergeWithoutId } }
    const result = parseMergeRecordTolerant(JSON.stringify(corrupted))
    expect(result.outcome).toBe("unreadable")
  })

  it("refuses a record whose checksum does not match its content", () => {
    const { envelope } = createMergeRecord(VALID_BODY)
    const tampered = { ...envelope, record: { ...envelope.record, fix: "quietly rewritten" } }
    const result = parseMergeRecordTolerant(JSON.stringify(tampered))
    expect(result.outcome).toBe("unreadable")
    expect(result).toMatchObject({ reason: expect.stringContaining("checksum") })
  })
})

describe("the checksum caution: an unknown field must not be dropped before checksumming", () => {
  /** A record shaped as a hypothetical NEWER writer would produce it: one field the
   * current schema does not recognize, with the checksum computed the same way every
   * writer computes it — over the full canonical JSON of the record AS WRITTEN, unknown
   * field included. This is the exact shape `mergeRecordChecksum` would produce from a
   * schema that had grown a new optional top-level field. */
  function recordWithUnknownTopLevelField(): Readonly<{ raw: string; unknownField: string }> {
    const { envelope } = createMergeRecord(VALID_BODY)
    const withExtra = { ...envelope.record, futureField: "the next writer added this" }
    const checksum = checksumOverRawContent(withExtra)
    return {
      raw: JSON.stringify({ schema: "yrd/merge-record/v1", record: withExtra, checksum }),
      unknownField: "futureField",
    }
  }

  it("accepts the checksum computed over the FULL record, unknown field included", () => {
    const { raw } = recordWithUnknownTopLevelField()
    const result = parseMergeRecordTolerant(raw)
    // The defining assertion: this must NOT be "unreadable" with a checksum-mismatch
    // reason. A naive fix that strips the unknown field before re-hashing computes a
    // DIFFERENT digest than the one above and rejects this authentic record as tampered.
    expect(result.outcome).not.toBe("unreadable")
  })

  it("still round-trips every field the current schema DOES understand", () => {
    const { raw } = recordWithUnknownTopLevelField()
    const result = parseMergeRecordTolerant(raw)
    if (result.outcome === "unreadable") throw new Error(`expected a readable result, got: ${result.reason}`)
    expect(result.envelope.record.merge).toEqual(VALID_BODY.merge)
    expect(result.envelope.record.changes).toEqual(VALID_BODY.changes)
    expect(result.envelope.record.pins).toEqual(VALID_BODY.pins)
  })

  it("surfaces the unknown field in the tolerance report instead of silently dropping it", () => {
    const { raw, unknownField } = recordWithUnknownTopLevelField()
    const result = parseMergeRecordTolerant(raw)
    expect(result.outcome).toBe("ok-with-unknown-fields")
    if (result.outcome !== "ok-with-unknown-fields") throw new Error("unreachable")
    expect(result.unknownFields).toContain(unknownField)
  })

  it("does the same for an unknown field nested inside `merge`, path-qualified in the report", () => {
    const { envelope } = createMergeRecord(VALID_BODY)
    const withExtra = { ...envelope.record, merge: { ...envelope.record.merge, futureFlag: true } }
    const checksum = checksumOverRawContent(withExtra)
    const raw = JSON.stringify({ schema: "yrd/merge-record/v1", record: withExtra, checksum })

    const result = parseMergeRecordTolerant(raw)
    expect(result.outcome).toBe("ok-with-unknown-fields")
    if (result.outcome !== "ok-with-unknown-fields") throw new Error("unreachable")
    expect(result.unknownFields).toContain("merge.futureFlag")
    expect(result.envelope.record.merge.id).toBe(VALID_BODY.merge.id)
  })
})
