/**
 * Every action key `@yrd/persistence` emits, defined once. A call site reads
 * `.key`; the string is spelled nowhere else. See `logAction` in `@yrd/core`
 * for why this is a definition site rather than a registry.
 */
import { logAction } from "@yrd/core"

/** Saved state failed its integrity check and is being rebuilt from the journal. */
export const STORAGE_STATE_DAMAGED_REBUILD = logAction({
  key: "storage-state-damaged-rebuild",
  level: "warn",
  disposition: "record",
})

/** Saved state disagreed with the journal it was projected from; rebuilding. */
export const STORAGE_STATE_INCONSISTENT_REBUILD = logAction({
  key: "storage-state-inconsistent-rebuild",
  level: "warn",
  disposition: "record",
})

/** A checkpoint write failed. The command's own result is unaffected; the next
 * start replays further and is slower. */
export const STORAGE_CHECKPOINT_UNWRITABLE = logAction({
  key: "storage-checkpoint-unwritable",
  level: "warn",
  disposition: "record",
})

/** A checkpoint was skipped because part of the history it would summarize is
 * no longer present. */
export const STORAGE_CHECKPOINT_HISTORY_MISSING = logAction({
  key: "storage-checkpoint-history-missing",
  level: "warn",
  disposition: "record",
})

/** The journal on disk carries a newer schema than this reader compiles
 * against; the columns this version knows are read and the rest ignored. */
export const STORAGE_SCHEMA_AHEAD_OF_READER = logAction({
  key: "storage-schema-ahead-of-reader",
  level: "warn",
  disposition: "record",
})

/** History eviction ran but could not reclaim the storage it retired. */
export const STORAGE_RECLAIM_DEFERRED = logAction({
  key: "storage-reclaim-deferred",
  level: "warn",
  disposition: "record",
})

/** The storage cleanup pass did not finish. Saved work is intact and the next
 * pass retries. */
export const STORAGE_CLEANUP_UNFINISHED = logAction({
  key: "storage-cleanup-unfinished",
  level: "warn",
  disposition: "record",
})

/** A legacy state record was too incomplete to migrate and was left behind. */
export const STORAGE_LEGACY_RECORD_INCOMPLETE = logAction({
  key: "storage-legacy-record-incomplete",
  level: "warn",
  disposition: "record",
})
