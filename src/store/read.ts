import { join } from "node:path"
import type { BayStore } from "../types.ts"
import { createJsonlJournal } from "../journal.ts"

/**
 * Read-only store — the journal with no sqlite and NO writer lock. For verbs
 * that only fold state (`status`, hook-side lookups): the journal is the source
 * of truth, appends are atomic lines, and a reader that races an appender sees
 * a valid prefix of history. Never hand this to a dispatching bay — append()
 * throws so a mis-wired writer fails loud instead of bypassing the single-writer
 * lock (principles § Fail Loud, Fail Now).
 */
export function createReadStore(dir: string): BayStore {
  const journal = createJsonlJournal(join(dir, "journal.jsonl"))
  return {
    journal: {
      replay: journal.replay,
      append: async () => {
        throw new Error(
          "bay: read-only store cannot append — open the real store (writer lock) to dispatch state-changing commands",
        )
      },
    },
    close: async () => {},
  }
}
