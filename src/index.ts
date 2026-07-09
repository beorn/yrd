// bay library — event-sourced core; capabilities land as with*() layers.
// Design: @hab/20926-gitbay/spec.md (hh workspace).
export * from "./types.ts"
export * from "./app.ts"
export * from "./effects.ts"
export { createGitbay, makeEvent, definePlugin } from "./core.ts"
export { pipe } from "./pipe.ts"
export { nextPrId } from "./ids.ts"
export { createJsonlJournal } from "./journal.ts"
export { createGitConfigSource, resolveOption } from "./config.ts"
export { migrateJournal } from "./migrate.ts"
export {
  createScratchWorkspaces,
  ProvisionError,
  type ScratchLease,
  type ScratchOptions,
  type ScratchWorkspaces,
} from "./scratch.ts"
export {
  withWorktrees,
  staleLeases,
  DEFAULT_LEASE_TIMEOUT_MS,
  type WorktreesOptions,
  type WorktreesSlice,
} from "./layers/worktrees.ts"
export { withQueue, submittedPrs, integratablePrs, type QueueSlice } from "./layers/queue.ts"
export { overlap, composeBatch, type Overlap, type SkippedTarget, type BatchResult } from "./batch-compat.ts"
export { changedPaths } from "./layers/git.ts"
export { withBatchBuild, batchLandEvidence, type BatchBuildOptions } from "./layers/batch-build.ts"
export { withMergeWorker, type MergeWorkerOptions } from "./layers/merge-worker.ts"
export { formatBayGateTrailer, type BatchLandEvidence } from "./layers/pipeline.ts"
export { withReceive, resolveReceive, leaseForBranch, type ReceiveOptions } from "./layers/receive.ts"
export { withAudit, formatAudit, type AuditFinding } from "./layers/audit.ts"
export { withAdopt } from "./layers/adopt.ts"
export { createSqliteStore } from "./store/sqlite.ts"
export { createReadStore } from "./store/read.ts"
export { createYrdEventStore } from "./store/app.ts"
export { acquireWriterLock } from "./store/lock.ts"
export {
  applyContestEvent,
  contestRecords,
  contestSlice,
  emptyContestSlice,
  parseContestAgentCost,
  parseContestCostField,
  parseContestCostRates,
  resolveContestCostAdapters,
  withContests,
  type ContestCostRates,
  type ContestSlice,
} from "./contest.ts"
