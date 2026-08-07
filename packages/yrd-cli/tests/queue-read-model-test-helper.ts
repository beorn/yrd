/** Explicit adapter for in-memory test Journals; production reads are supplied
 * by createYrdHost's SQLite-backed capability. Shared by every test file that
 * drives runYrd against a memory journal — a bare `services = {}` makes any
 * attempt-reading command exit with the missing-capability error, which only
 * cli.test.ts's capability-contract test wants on purpose. */
import type { runYrd } from "@yrd/cli"
import { queueLogAttempts, type QueueAttempt } from "../src/queue-status-view.tsx"

export function testQueueReadModel(app: Parameters<typeof runYrd>[0]) {
  let cachedCursor: number | undefined
  let cachedAttempts: readonly QueueAttempt[] = []
  return {
    async snapshot() {
      const journal = await app.journalSnapshot()
      if (journal.asOf.cursor !== cachedCursor) {
        cachedAttempts = await queueLogAttempts(app.events())
        cachedCursor = journal.asOf.cursor
      }
      return {
        cursor: journal.asOf.cursor,
        generation: 0,
        attempts: cachedAttempts,
      }
    },
  }
}
