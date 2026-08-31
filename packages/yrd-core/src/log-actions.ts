/**
 * Every action key `@yrd/core` emits, defined once. A call site reads `.key`;
 * the string is spelled nowhere else. See {@link logAction} for why this is a
 * definition site rather than a registry.
 */
import { logAction } from "./log-action.ts"

/** A checkpoint write failed at the app boundary. The command's own result is
 * unaffected; the next start replays further and is slower. */
export const APP_CHECKPOINT_UNWRITABLE = logAction({
  key: "app-checkpoint-unwritable",
  level: "warn",
  disposition: "record",
})

/** A lifecycle's measured duration was not a finite non-negative number, so
 * the clock it read moved backwards or returned a non-number. The observed
 * result is unaffected; the recorded `durationMs` is not trustworthy. */
export const LIFECYCLE_DURATION_UNMEASURABLE = logAction({
  key: "lifecycle-duration-unmeasurable",
  level: "error",
  disposition: "record",
})
