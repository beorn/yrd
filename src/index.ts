// bay library — event-sourced core; capabilities land as with*() layers.
// Design: @hab/20926-gitbay/spec.md (hh workspace).
export * from "./types.ts"
export { createBay, makeEvent, definePlugin } from "./core.ts"
export { pipe } from "./pipe.ts"
export { createJsonlJournal } from "./journal.ts"
export { createGitConfigSource, resolveOption } from "./config.ts"
