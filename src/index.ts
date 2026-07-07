// bay library — event-sourced core; capabilities land as with*() layers.
// Design: @hab/20926-gitbay/spec.md (hh workspace).
export * from "./types.ts"
export { createBay, makeEvent, definePlugin } from "./core.ts"
export { pipe } from "./pipe.ts"
export { createJsonlJournal } from "./journal.ts"
export { createGitConfigSource, resolveOption } from "./config.ts"
export {
  withWorkspaces,
  staleLeases,
  DEFAULT_LEASE_TIMEOUT_MS,
  type WorkspacesOptions,
  type WorkspacesSlice,
} from "./layers/workspaces.ts"
export { withQueue, queuedChangesets, type QueueSlice } from "./layers/queue.ts"
export { withMergeWorker, type MergeWorkerOptions } from "./layers/merge-worker.ts"
export { withReceive, resolveReceive, leaseForBranch, type ReceiveOptions } from "./layers/receive.ts"
export { withAudit, formatAudit, type AuditFinding } from "./layers/audit.ts"
export { withAdopt } from "./layers/adopt.ts"
export { createSqliteStore } from "./store/sqlite.ts"
export { createReadStore } from "./store/read.ts"
export { acquireWriterLock } from "./store/lock.ts"
