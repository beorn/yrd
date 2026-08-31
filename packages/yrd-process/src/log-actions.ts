/**
 * Every action key `@yrd/process` emits, defined once. A call site reads
 * `.key`; the string is spelled nowhere else. See `logAction` in `@yrd/core`.
 */
import { logAction } from "@yrd/core"

/** A command wrote more than Yrd captures, so the middle of its stream was
 * dropped — the retained head and tail are not contiguous. */
export const PROCESS_OUTPUT_TRUNCATED = logAction({
  key: "process-output-truncated",
  level: "warn",
  disposition: "record",
})

/** The command exited but a grandchild held its output pipe open past the
 * drain grace, so Yrd stopped waiting and the capture may be short. */
export const PROCESS_OUTPUT_HELD_OPEN = logAction({
  key: "process-output-held-open",
  level: "warn",
  disposition: "record",
})

/** The command did not finish after being killed; Yrd stopped waiting for it. */
export const PROCESS_KILL_UNCONFIRMED = logAction({
  key: "process-kill-unconfirmed",
  level: "warn",
  disposition: "record",
})
