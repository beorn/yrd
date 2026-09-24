import type { JournalRun } from "@yrd/queue-core"

/**
 * A JournalRun built by hand for a test (25441). The reader always writes
 * `checks`, `steps` and `commands`, so they stay required on the type; a
 * fixture that is about something else leaves them empty here, in one place,
 * rather than every consumer learning to read an absent list as an empty one.
 */
export function journalRun(
  run: Omit<JournalRun, "checks" | "steps" | "commands"> & Partial<Pick<JournalRun, "checks" | "steps" | "commands">>,
): JournalRun {
  return { checks: [], commands: [], steps: [], ...run }
}
