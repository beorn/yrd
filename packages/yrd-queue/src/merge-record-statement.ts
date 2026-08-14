import type { MergeRecordBody } from "./merge-record.ts"

/**
 * https://in-toto.io/Statement/v1 shape, naming-only alignment (no DSSE signing — Future work,
 * see pm/@yrd/future/landing-attestation.md). Read-time projection over the durable
 * MergeRecordBody; never persisted, never part of the checksum, free to change shape.
 */
export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1" as const
export const YRD_MERGE_PREDICATE_TYPE = "https://yrd.dev/attestation/merge-record/v1" as const

export type InTotoStatement = Readonly<{
  _type: typeof IN_TOTO_STATEMENT_TYPE
  subject: readonly Readonly<{ name: string; digest: Readonly<Record<string, string>> }>[]
  predicateType: typeof YRD_MERGE_PREDICATE_TYPE
  predicate: Readonly<{
    materials: readonly Readonly<{ uri: string; digest: Readonly<Record<string, string>> }>[]
    byproducts: readonly Readonly<{
      name: string
      digest?: Readonly<Record<string, string>>
      result: string
    }>[]
    builder: Readonly<{ id: string }>
  }>
}>

/** sha1 (40 hex) or sha256 (64 hex) — MergeRecordBody's GitShaSchema accepts either. */
function shaDigest(sha: string): Readonly<Record<string, string>> {
  return { [sha.length === 64 ? "sha256" : "sha1"]: sha }
}

/**
 * Project a durable MergeRecordBody onto an in-toto Statement shape. `builderId` is the queue
 * identity (Candidate.queueId) — not a MergeRecordBody field, so it is supplied by the caller
 * rather than defaulted here. Returns undefined for non-merged rows: a Statement needs a subject,
 * and a refused or canceled attempt minted no landed sha.
 */
export function mergeRecordToStatement(record: MergeRecordBody, builderId: string): InTotoStatement | undefined {
  const mergedCommit = record.merge.mergedCommit
  if (mergedCommit === undefined) return undefined
  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [{ name: record.merge.candidate, digest: shaDigest(mergedCommit) }],
    predicateType: YRD_MERGE_PREDICATE_TYPE,
    predicate: {
      materials: [
        ...record.changes.map((change) => ({
          uri: `git+change:${change.pr}@${String(change.revision)}`,
          digest: shaDigest(change.submittedHead),
        })),
        { uri: `git+base:${record.merge.base}`, digest: shaDigest(record.merge.baseSha) },
        ...record.pins.flatMap((pin) =>
          pin.before === null ? [] : [{ uri: `git+pin:${pin.path}`, digest: shaDigest(pin.before) }],
        ),
      ],
      byproducts: record.evidence.jobs.map((job) => ({
        name: job.step,
        ...(job.configHash === undefined && job.environmentHash === undefined
          ? {}
          : {
              digest: {
                ...(job.configHash === undefined ? {} : { "yrd-config": job.configHash }),
                ...(job.environmentHash === undefined ? {} : { "yrd-environment": job.environmentHash }),
              },
            }),
        result: job.result,
      })),
      builder: { id: builderId },
    },
  }
}
