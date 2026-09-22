/** Event-chain changes in the shared table shape. Status comes only from the event fold. */
import type { ChangeStatus, EventChange } from "./events.ts"
import type { Row } from "./table.ts"

/** One row per branch; the caller supplies the already-folded change chains. */
export function eventRows(changes: ReadonlyMap<string, EventChange>): readonly Row<ChangeStatus>[] {
  const openedAt = (branch: string, change: EventChange): number => {
    if (change.since === undefined) throw new Error(`event change ${branch} has no opened Time:`)
    return change.since.getTime()
  }
  const inLine = [...changes]
    .filter(
      ([, change]) =>
        !change.ignored &&
        (change.status === "queued" ||
          change.status === "verifying" ||
          change.status === "checking" ||
          change.status === "merging" ||
          change.status === "stuck"),
    )
    .sort(
      ([leftBranch, left], [rightBranch, right]) =>
        openedAt(leftBranch, left) - openedAt(rightBranch, right) || leftBranch.localeCompare(rightBranch),
    )
  for (const [branch, change] of inLine) openedAt(branch, change)
  const positions = new Map(inLine.map(([branch], index) => [branch, index + 1]))
  const rows: Row<ChangeStatus>[] = []
  for (const [branch, change] of changes) {
    if (change.commit === undefined) {
      throw new Error(`event change ${branch} has no submitted commit`)
    }
    rows.push({
      branch,
      head: change.commit,
      state: change.status,
      format: "event",
      ...(positions.get(branch) === undefined ? {} : { position: positions.get(branch) }),
      ...(change.issue === undefined ? {} : { issue: change.issue }),
      ...(change.since === undefined ? {} : { since: change.since }),
      ...(change.at === undefined ? {} : { at: change.at }),
      ...(change.endedAt === undefined ? {} : { endedAt: change.endedAt }),
      ...(change.reason === undefined ? {} : { reason: change.reason }),
    })
  }
  return rows.sort((left, right) => {
    if (left.position !== undefined && right.position !== undefined) return left.position - right.position
    if (left.position !== undefined) return -1
    if (right.position !== undefined) return 1
    return (right.endedAt?.getTime() ?? 0) - (left.endedAt?.getTime() ?? 0) || left.branch.localeCompare(right.branch)
  })
}
