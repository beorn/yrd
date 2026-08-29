export * from "./alternates-audit.ts"
export * from "./derived-admission.ts"
export * from "./derived-member.ts"
export * from "./model.ts"
export * from "./queue.ts"
export * from "./queue-status-projection.ts"
export * from "./candidate-pool.ts"
export * from "./candidate-refs.ts"
export * from "./command.ts"
export * from "./merge-record.ts"
// Not `export *`, and deliberately the only line here that is not.
//
// merged-truth answers one question — did this change land — and it answers it
// at one strength: ancestry first, then Change-Id lineage, then a loud unknown.
// The legs it composes (`mergedByAncestry`, `mergedByChangeId`,
// `compareMergedTruth`) are each individually WEAKER than that composition, and
// a caller that reaches one directly gets a confident answer to a question it
// did not ask. That is not hypothetical: the queue carried two merged-ness
// readers of different strength, and the weaker one guarded the decision to
// burn a check leg.
//
// Nothing outside this module calls a leg today, so this list costs no call
// site. It exists so that the next one is a compile error rather than a review
// comment. The legs stay module-exported for merged-truth.test.ts, which tests
// each in isolation through the deep path — testable, but not an answer anyone
// can reach from `@yrd/queue`.
export {
  buildMergedTruthIndex,
  mergedTruth,
  type MergedTruth,
  type MergedTruthGit,
  type MergedTruthIndex,
  type MergedTruthIndexOptions,
  type MergedTruthLookupContext,
  type MergedTruthOccurrence,
  type MergedTruthQuery,
  type MergedTruthSpecimen,
  type MergedTruthSpecimenProblem,
  type MergedTruthDegeneracy,
  type QueueSynthesisOperation,
  type TrailerAbsentException,
} from "./merged-truth.ts"
export * from "./merge-record-statement.ts"
export * from "./stranded.ts"
export * from "./stranded-facts.ts"
export * from "./stranded-sweep.ts"
export * from "./stranded-observation.ts"
export * from "./submodule-composition-policy.ts"
