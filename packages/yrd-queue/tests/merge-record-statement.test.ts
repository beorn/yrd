import { describe, expect, it } from "vitest"
import { mergeRecordToStatement } from "../src/merge-record-statement.ts"
import { mergeJoinedNothing, MergeRecordBodySchema, type MergeRecordBody } from "../src/merge-record.ts"

const SHA_MERGED = "a".repeat(40)
const SHA_SUBMITTED = "b".repeat(40)
const SHA_BASE = "c".repeat(40)
const SHA_PIN_BEFORE = "d".repeat(40)
const SHA_PIN_AFTER = "e".repeat(40)
const HASH_CONFIG = "1".repeat(64)
const HASH_ENVIRONMENT = "2".repeat(64)

const merged: MergeRecordBody = MergeRecordBodySchema.parse({
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
})

describe("mergeRecordToStatement", () => {
  it("attests the merged sha as the subject", () => {
    expect(mergeRecordToStatement(merged, "queue:main")?.subject).toEqual([
      { name: "CANDIDATE1", digest: { sha1: SHA_MERGED } },
    ])
  })

  it("names submitted heads, the base, and prior pins as materials", () => {
    const materials = mergeRecordToStatement(merged, "queue:main")?.predicate.materials
    expect(materials).toEqual([
      { uri: "git+change:PR1@1", digest: { sha1: SHA_SUBMITTED } },
      { uri: "git+base:main", digest: { sha1: SHA_BASE } },
      { uri: "git+pin:vendor/submodule", digest: { sha1: SHA_PIN_BEFORE } },
    ])
  })

  it("carries gate runs as byproducts with their fingerprints", () => {
    expect(mergeRecordToStatement(merged, "queue:main")?.predicate.byproducts).toEqual([
      {
        name: "check",
        digest: { "yrd-config": HASH_CONFIG, "yrd-environment": HASH_ENVIRONMENT },
        result: "success",
      },
    ])
  })

  it("omits the byproduct digest when no fingerprint was recorded", () => {
    const unfingerprinted = MergeRecordBodySchema.parse({
      ...merged,
      evidence: { jobs: [{ id: "JOB1", step: "check", attempt: 1, result: "success" }] },
    })
    expect(mergeRecordToStatement(unfingerprinted, "queue:main")?.predicate.byproducts).toEqual([
      { name: "check", result: "success" },
    ])
  })

  it("takes the builder from the caller's queue identity, never a default", () => {
    expect(mergeRecordToStatement(merged, "queue:main")?.predicate.builder).toEqual({ id: "queue:main" })
  })

  it("digests a sha256 object under sha256", () => {
    const sha256Merged = "f".repeat(64)
    const sha256Record = MergeRecordBodySchema.parse({
      ...merged,
      merge: { ...merged.merge, mergedCommit: sha256Merged },
    })
    expect(mergeRecordToStatement(sha256Record, "queue:main")?.subject).toEqual([
      { name: "CANDIDATE1", digest: { sha256: sha256Merged } },
    ])
  })

  it("skips a pin with no prior sha", () => {
    const firstPin = MergeRecordBodySchema.parse({
      ...merged,
      pins: [{ path: "vendor/submodule", before: null, after: SHA_PIN_AFTER }],
    })
    expect(mergeRecordToStatement(firstPin, "queue:main")?.predicate.materials).toEqual([
      { uri: "git+change:PR1@1", digest: { sha1: SHA_SUBMITTED } },
      { uri: "git+base:main", digest: { sha1: SHA_BASE } },
    ])
  })

  it("has no subject to attest for a non-merged row", () => {
    const failed = MergeRecordBodySchema.parse({
      ...merged,
      merge: { ...merged.merge, result: "failed", mergedCommit: undefined },
      reason: { code: "merge-failed", message: "candidate did not apply" },
    })
    expect(mergeRecordToStatement(failed, "queue:main")).toBeUndefined()
  })
})

describe("mergeJoinedNothing — the nothing-new outcome is a projection over stored facts", () => {
  const base = {
    id: "RUN2",
    base: "main",
    baseSha: SHA_BASE,
    candidate: "CANDIDATE2",
    startedAt: "2026-08-13T00:00:00Z",
    finishedAt: "2026-08-13T00:01:00Z",
  }
  const skeleton = {
    changes: [{ pr: "PR2", revision: 1, submittedHead: SHA_SUBMITTED }],
    evidence: { jobs: [] },
    pins: [],
  }

  it.each([
    {
      name: "is true exactly when a merged result IS its own base",
      merge: { result: "merged", mergedCommit: SHA_BASE },
      reason: undefined,
      expected: true,
    },
    {
      name: "is false for an ordinary merge that moved the base",
      merge: { result: "merged", mergedCommit: SHA_MERGED },
      reason: undefined,
      expected: false,
    },
    {
      name: "is false for a failed run even when no commit exists — failure is not up to date",
      merge: { result: "failed", mergedCommit: undefined },
      reason: { code: "merge-failed", message: "boom" },
      expected: false,
    },
  ])("$name", ({ merge, reason, expected }) => {
    const record = MergeRecordBodySchema.parse({
      merge: { ...base, ...merge },
      ...skeleton,
      reason,
    })
    expect(mergeJoinedNothing(record)).toBe(expected)
  })
})
