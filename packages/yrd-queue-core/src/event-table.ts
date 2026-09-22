/** Event-chain changes in the shared table shape. Status comes only from the event fold. */
import type { ChangeStatus, EventChange } from "./events.ts"
import type { Row } from "./table.ts"

/** One row per branch; the caller supplies the already-folded change chains. */
export function eventRows(changes: ReadonlyMap<string, EventChange>): readonly Row<ChangeStatus>[] {
  const rows: Row<ChangeStatus>[] = []
  for (const [branch, change] of changes) {
    if (change.commit === undefined) {
      throw new Error(`event change ${branch} has no submitted commit`)
    }
    rows.push({
      branch,
      head: change.commit,
      state: change.status,
      ...(change.reason === undefined ? {} : { reason: change.reason }),
    })
  }
  return rows
}
