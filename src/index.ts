// bay library — event-sourced core; capabilities land as with*() layers.
// Design: @hab/20926-gitbay/spec.md (hh workspace).
export * from "./types.ts"
export { createBay, makeEvent, definePlugin } from "./core.ts"
export { pipe } from "./pipe.ts"
export { createJsonlJournal } from "./journal.ts"
export { createGitConfigSource, resolveOption } from "./config.ts"
export { withWorkspaces, type WorkspacesOptions, type WorkspacesSlice } from "./layers/workspaces.ts"
export { withQueue, queuedChangesets, type QueueSlice } from "./layers/queue.ts"
export { withMergeWorker, type MergeWorkerOptions } from "./layers/merge-worker.ts"
