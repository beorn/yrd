export * from "./alternates-audit.ts"
export * from "./receiver-inbox-audit.ts"
export * from "./change-population.ts"
export * from "./derived-admission.ts"
export * from "./derived-member.ts"
export * from "./model.ts"
// Not `export *`, and deliberately the only other line here that is not (see
// the merged-truth.ts block below for the first).
//
// checkRunStatus, checkStatus, projectQueueStarted and
// assertSubmoduleModelAuthorizationsAvailable have no caller outside this
// package — every use is internal to queue.ts or its own dedicated test
// file (check-status-ladder.test.ts, queue.test.ts,
// composition-fill-in.test.ts), which import them by relative path. They
// stay module-exported in queue.ts for those tests, but this explicit list
// leaves them off `@yrd/queue`'s surface rather than reaching them
// through a blanket `export *`.
export {
  QueueRunningConflict,
  isQueueRunningConflict,
  type QueueRunArgs,
  type AdmitSelection,
  type PauseQueueArgs,
  type RecoverQueueOptions,
  type RecordAdmissionRefusalArgs,
  type SettleAdmissionRefusalArgs,
  type RetireSubmitFactArgs,
  type RetireRevisionArgs,
  REVISION_RETIRED_CODE,
  ADMISSION_REFUSAL_LOOP_THRESHOLD,
  type CancelRunArgs,
  type QuiesceLegacyRunArgs,
  type SettleOrphanedRunArgs,
  type StepExecution,
  type StepRunner,
  type StepDef,
  type StepOptions,
  withStep,
  withMerge,
  type QueueOptions,
  type QueueOutcome,
  DEFAULT_QUEUE_BATCH_SIZE,
  type QueueProgressPolicy,
  DEFAULT_QUEUE_PROGRESS_POLICY,
  DEFAULT_NEEDS_PERSON_OWNER,
  type QueueAuditOptions,
  type CandidatePreparationInput,
  type PreparedCandidate,
  type CandidatePreparer,
  type QueueRuntimeState,
  type QueueCommands,
  type Queue,
  type QuiesceLegacyRootsOptions,
  type QuiesceLegacyRootsResult,
  type QueueRunOptions,
  type WaitingQueueStep,
  type WaitingAdmissionStep,
  type FinishQueueArgs,
  type CancelQueueArgs,
  type CancelAdmissionJobsArgs,
  type HasQueue,
  type QueuePlugin,
  withQueue,
  advanceQueue,
  type UnreadableQueueRun,
  COMPOSITION_FAILURE_BUCKETS,
  YRD_REFUSAL_CODES,
  type RefusalCode,
  YRD_REFUSAL_CODE_ALIASES,
  type CanonicalRefusalCodeOptions,
  canonicalRefusalCode,
  authorAttributionResult,
} from "./queue.ts"
export * from "./queue-status-projection.ts"
export * from "./candidate-pool.ts"
export * from "./candidate-refs.ts"
export * from "./command.ts"
// Not `export *` either — scratch storage is overwhelmingly this package's own
// business (the storage-exhaustion classifier, the scratch parent resolver, the
// `yrd-` name prefix), and none of that belongs on `@yrd/queue`'s surface.
//
// These three cross it because a SECOND caller has the identical abandoned-tree
// problem: the CLI's `pre-submit-worktrees` root, whose entries a killed process
// leaves behind exactly as a killed queue run leaves merge scratch. It reaps
// them with these primitives rather than a fork, which is what
// `liveWorktreeEntries` was extracted for.
export {
  ARTIFACT_PRUNE_INTERVAL_MS,
  ARTIFACT_RETENTION_ENV,
  DEFAULT_ARTIFACT_RETENTION_MS,
  describeScratchReap,
  liveScratchOwners,
  liveWorktreeEntries,
  reapAgedArtifacts,
  reapOrphanedScratch,
  resolveArtifactRetentionMs,
  SCRATCH_OWNER_FILE,
  type ScratchOwner,
  type ScratchOwnerCensus,
  type ScratchReapReport,
  writeScratchOwner,
} from "./scratch-storage.ts"
export * from "./merge-record.ts"
// Not `export *` either — see the queue.ts block above for the first.
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
  describeMergedTruthGaps,
  mergedTruth,
  type MergedTruth,
  stampingEpochStop,
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
