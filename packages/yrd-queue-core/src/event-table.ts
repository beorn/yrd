/** Event-chain changes in the shared table shape. Status comes only from the event fold. */
import type { ChangeStatus, EventChange } from "./events.ts"
import type { Draft } from "./drafts.ts"
import { clocks, type Row } from "./table.ts"

/** One row per branch; the caller supplies the already-folded change chains. */
export function eventRows(
  changes: ReadonlyMap<string, EventChange>,
  drafts: readonly Draft[] = [],
): readonly Row<ChangeStatus>[] {
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
    const adoptedTimes = change.adoptedPhases
    const startedAt =
      adoptedTimes === undefined
        ? undefined
        : [adoptedTimes.verifying, adoptedTimes.checking, adoptedTimes.merging]
            .filter((at): at is Date => at !== undefined)
            .sort((left, right) => left.getTime() - right.getTime())[0]
    rows.push({
      branch,
      head: change.commit,
      state: change.status,
      format: "event",
      ...(positions.get(branch) === undefined ? {} : { position: positions.get(branch) }),
      ...(change.issue === undefined ? {} : { issue: change.issue }),
      ...(change.submitter === undefined ? {} : { submitter: change.submitter }),
      ...(change.since === undefined ? {} : { since: change.since }),
      ...(change.at === undefined ? {} : { at: change.at }),
      ...(change.endedAt === undefined ? {} : { endedAt: change.endedAt }),
      ...((change.status === "merged" ? (change.merge ?? change.candidate ?? change.adoptedMerge) : undefined) ===
      undefined
        ? {}
        : { merge: change.merge ?? change.candidate ?? change.adoptedMerge }),
      ...(change.run === undefined ? {} : { run: change.run }),
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(adoptedTimes !== undefined && startedAt === undefined ? { adoptedPhaseMissing: true } : {}),
      ...(change.deferred === undefined
        ? change.reason === undefined
          ? {}
          : { reason: change.reason }
        : { reason: `deferred ${change.deferred.check}: ${change.deferred.reason}` }),
      ...(change.ignored === undefined ? {} : { ignored: change.ignored }),
      ...(change.diagnostic === undefined ? {} : { diagnostic: change.diagnostic }),
    })
  }
  const changeRows = rows.sort((left, right) => {
    if (left.position !== undefined && right.position !== undefined) return left.position - right.position
    if (left.position !== undefined) return -1
    if (right.position !== undefined) return 1
    return (right.endedAt?.getTime() ?? 0) - (left.endedAt?.getTime() ?? 0) || left.branch.localeCompare(right.branch)
  })
  const draftRows: Row<ChangeStatus>[] = drafts
    .map(
      (draft): Row<ChangeStatus> => ({
        branch: draft.branch,
        head: draft.head,
        state: "draft",
        format: "event",
        ...(draft.committedAt === undefined ? {} : { at: draft.committedAt }),
        ...(draft.author === undefined ? {} : { author: draft.author }),
        ...(draft.movedSinceSubmit ? { movedSinceSubmit: true } : {}),
      }),
    )
    .sort(
      (left, right) =>
        (right.at?.getTime() ?? Number.NEGATIVE_INFINITY) - (left.at?.getTime() ?? Number.NEGATIVE_INFINITY) ||
        left.branch.localeCompare(right.branch),
    )
  return [...changeRows, ...draftRows]
}

/** The current table and the opened-segment document share the legacy seven-day ending window. */
/**
 * One change is one row (25718): a segment that merged a head an earlier
 * segment already merged is the same ending recorded twice (a re-submit after
 * the merge, 25708), so it folds into that earlier row as a duplicate note
 * instead of standing as a second merged row with its own `since`.
 */
function foldEqualEndings(
  segments: readonly EventChange[],
): readonly Readonly<{ segment: EventChange; duplicates?: Row<ChangeStatus>["duplicates"] }>[] {
  const kept: { segment: EventChange; duplicates?: { ending: string; endedAt?: Date }[] }[] = []
  for (const segment of segments) {
    const original =
      segment.status === "merged" && segment.commit !== undefined
        ? kept.find((entry) => entry.segment.status === "merged" && entry.segment.commit === segment.commit)
        : undefined
    if (original === undefined || segment.ending === undefined) {
      kept.push({ segment })
      continue
    }
    original.duplicates = [
      ...(original.duplicates ?? []),
      { ending: segment.ending.id, ...(segment.endedAt === undefined ? {} : { endedAt: segment.endedAt }) },
    ]
  }
  return kept
}

export function eventListRows(
  histories: ReadonlyMap<string, readonly EventChange[]>,
  drafts: readonly Draft[],
  options: Readonly<{ now?: Date; all?: boolean; drafts?: boolean }> = {},
): Readonly<{ table: readonly Row<ChangeStatus>[]; document: readonly Row<ChangeStatus>[] }> {
  const now = options.now ?? new Date()
  const folded = new Map([...histories].map(([branch, segments]) => [branch, foldEqualEndings(segments)] as const))
  const current = new Map(
    [...folded].map(([branch, segments]) => {
      const last = segments.at(-1)
      if (last === undefined) throw new Error(`event change ${branch} has no opened segment`)
      return [branch, last.segment] as const
    }),
  )
  const duplicatesOf = (branch: string, index: number): Row<ChangeStatus>["duplicates"] =>
    folded.get(branch)?.[index]?.duplicates
  const active = eventRows(current).map((row) => {
    const duplicates =
      row.format === "event" ? duplicatesOf(row.branch, (folded.get(row.branch)?.length ?? 0) - 1) : undefined
    return duplicates === undefined ? row : { ...row, duplicates }
  })
  const previous = [...folded].flatMap(([branch, segments]) =>
    segments.slice(0, -1).map(({ segment, duplicates }) => {
      const single = eventRows(new Map([[branch, segment]]))[0]
      if (single === undefined) throw new Error(`event change ${branch} lost an opened segment`)
      const { position: _position, ...row } = single
      return duplicates === undefined ? row : { ...row, duplicates }
    }),
  )
  const visible = (row: Row): boolean => {
    if (options.all) return true
    if (row.position !== undefined) return true
    const at = clocks(row, now).clockAt
    return at === undefined || now.getTime() - at.getTime() <= 7 * 24 * 60 * 60 * 1000
  }
  const selected = [...active, ...previous].filter(visible)
  const ordered = (rows: readonly Row<ChangeStatus>[]): Row<ChangeStatus>[] => [
    ...rows.filter((row) => row.position !== undefined),
    ...rows
      .filter((row) => row.position === undefined)
      .sort(
        (left, right) => (clocks(right, now).clockAt?.getTime() ?? 0) - (clocks(left, now).clockAt?.getTime() ?? 0),
      ),
  ]
  const draftRows = options.drafts ? eventRows(new Map(), drafts) : []
  return {
    table: [...ordered(active.filter(visible)), ...draftRows],
    document: [...ordered(selected), ...draftRows],
  }
}
