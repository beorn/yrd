/** Event-chain changes in the shared table shape. Status comes only from the event fold. */
import type { ChangeStatus, EventChange } from "./events.ts"
import type { Draft } from "./drafts.ts"
import { clocks, type Row } from "./table.ts"

function noticeOutcome(
  branch: string,
  change: EventChange,
): Pick<Row<ChangeStatus>, "told" | "refused" | "undelivered" | "next"> {
  const endingNotices = Object.values(change.notices ?? {}).filter((notice) => notice.for === change.ending?.id)
  const refused = endingNotices
    .filter((notice) => notice.result === "refused")
    .map((notice) => {
      if (notice.reason === undefined) throw new Error(`event change ${branch}: refused ${notice.to} has no reason`)
      return `${notice.to} refused=${notice.reason}`
    })
  const undelivered = endingNotices
    .filter((notice) => notice.result === "failed")
    .map((notice) => {
      if (notice.reason === undefined) throw new Error(`event change ${branch}: failed ${notice.to} has no reason`)
      return notice.reason
    })
  const notTold = [...refused, ...undelivered]
  const submitterTold = endingNotices.some((notice) => notice.to === "submitter" && notice.result === "delivered")
  return {
    ...(endingNotices.length === 0 ? {} : { told: notTold.length === 0 }),
    ...(refused.length === 0 ? {} : { refused: refused.join("; ") }),
    ...(undelivered.length === 0 ? {} : { undelivered: undelivered.join("; ") }),
    ...(notTold.length > 0
      ? {
          next: {
            owner: "the queue's operator",
            because: `${[...new Set(endingNotices.filter((notice) => notice.result !== "delivered").map((notice) => notice.to))].join(", ")} not told: ${notTold.join("; ")}`,
          },
        }
      : change.status === "failed" && submitterTold && change.submitter !== undefined
        ? {
            next: {
              owner: change.submitter,
              because: `it failed (${change.reason ?? "reason unrecorded"}), and only the branch's author can move it`,
            },
          }
        : {}),
  }
}

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
      ...((change.status === "merged" ? (change.merge ?? change.adoptedMerge) : undefined) === undefined
        ? {}
        : { merge: change.merge ?? change.adoptedMerge }),
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
      ...noticeOutcome(branch, change),
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

/**
 * Only matching heads with proven equal merge roots share a row (25718).
 * Keep contradictory or incomplete evidence on both retained endings.
 */
function foldEqualEndings(branch: string, segments: readonly EventChange[]) {
  const kept: {
    segment: EventChange
    duplicates?: NonNullable<Row<ChangeStatus>["duplicates"]>[number][]
    diagnostic?: string
  }[] = []
  for (const segment of segments) {
    const matches =
      segment.status === "merged" && segment.commit !== undefined
        ? kept.filter((entry) => entry.segment.status === "merged" && entry.segment.commit === segment.commit)
        : []
    const root = segment.merge ?? segment.adoptedMerge
    const diagnostics: string[] = []
    for (const entry of matches) {
      const prior = entry.segment
      const priorRoot = prior.merge ?? prior.adoptedMerge
      if (root !== undefined && priorRoot === root && prior.ending !== undefined && segment.ending !== undefined) {
        continue
      }
      const problem =
        root === undefined || priorRoot === undefined || prior.ending === undefined || segment.ending === undefined
          ? "equality unproven"
          : "contradictory endings"
      const diagnostic = `${branch}: ${problem}: ending ${prior.ending?.id ?? "missing"} merge ${priorRoot ?? "missing"}; ending ${segment.ending?.id ?? "missing"} merge ${root ?? "missing"}; both rows retained; inspect yrd queue show ${branch} --json`
      entry.diagnostic = [entry.diagnostic, diagnostic].filter((line) => line !== undefined).join("; ")
      diagnostics.push(diagnostic)
    }
    const original =
      root === undefined || segment.ending === undefined
        ? undefined
        : matches.find(
            (entry) =>
              entry.segment.ending !== undefined && (entry.segment.merge ?? entry.segment.adoptedMerge) === root,
          )
    if (original === undefined || original.segment.ending === undefined || segment.ending === undefined) {
      kept.push({ segment, ...(diagnostics.length === 0 ? {} : { diagnostic: diagnostics.join("; ") }) })
      continue
    }
    original.duplicates = [
      ...(original.duplicates ?? []),
      {
        ending: segment.ending.id,
        originalEnding: original.segment.ending.id,
        merge: root,
        ...(segment.endedAt === undefined ? {} : { endedAt: segment.endedAt }),
      },
    ]
    if (diagnostics.length > 0) {
      original.diagnostic = [original.diagnostic, ...diagnostics].filter((line) => line !== undefined).join("; ")
    }
    // The last submitted segment owns current selection even when its equal
    // ending folds back into a representative before another submitted head.
    kept.splice(kept.indexOf(original), 1)
    kept.push(original)
  }
  return kept
}

export function eventListRows(
  histories: ReadonlyMap<string, readonly EventChange[]>,
  drafts: readonly Draft[],
  options: Readonly<{ now?: Date; all?: boolean; drafts?: boolean }> = {},
): Readonly<{ table: readonly Row<ChangeStatus>[]; document: readonly Row<ChangeStatus>[] }> {
  const now = options.now ?? new Date()
  const folded = new Map(
    [...histories].map(([branch, segments]) => [branch, foldEqualEndings(branch, segments)] as const),
  )
  const current = new Map(
    [...folded].map(([branch, segments]) => {
      const last = segments.at(-1)
      if (last === undefined) throw new Error(`event change ${branch} has no opened segment`)
      return [branch, last.segment] as const
    }),
  )
  const retained = new Set<Row>()
  const withEndingFacts = (
    row: Row<ChangeStatus>,
    entry: ReturnType<typeof foldEqualEndings>[number],
  ): Row<ChangeStatus> => {
    const projected = {
      ...row,
      ...(entry.duplicates === undefined ? {} : { duplicates: entry.duplicates }),
      ...(entry.diagnostic === undefined
        ? {}
        : {
            diagnostic: [row.diagnostic, entry.diagnostic].filter((line) => line !== undefined).join("; "),
            ...(entry.segment.ending === undefined ? {} : { ending: entry.segment.ending.id }),
          }),
    }
    if (entry.diagnostic !== undefined) retained.add(projected)
    return projected
  }
  const active = eventRows(current).map((row) => {
    const entry = folded.get(row.branch)?.at(-1)
    if (entry === undefined) throw new Error(`event change ${row.branch} lost its current segment`)
    return withEndingFacts(row, entry)
  })
  const previous = [...folded].flatMap(([branch, segments]) =>
    segments.slice(0, -1).map((entry) => {
      const { segment } = entry
      const single = eventRows(new Map([[branch, segment]]))[0]
      if (single === undefined) throw new Error(`event change ${branch} lost an opened segment`)
      const { position: _position, ...row } = single
      return withEndingFacts(row, entry)
    }),
  )
  const visible = (row: Row): boolean => {
    if (options.all || retained.has(row)) return true
    if (row.position !== undefined) return true
    const at = clocks(row, now).clockAt
    const recent = (ending: Date) => now.getTime() - ending.getTime() <= 7 * 24 * 60 * 60 * 1000
    // Folded proof can be fresh while its original ending is outside the
    // window. Preserve original and run clocks; inspect every known ending.
    return (
      at === undefined ||
      recent(at) ||
      row.duplicates?.some((note) => note.endedAt !== undefined && recent(note.endedAt)) === true
    )
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
  const draftRows = eventRows(new Map(), drafts)
  return {
    table: [...ordered([...active, ...previous.filter((row) => retained.has(row))].filter(visible)), ...draftRows],
    document: [...ordered(selected), ...(options.drafts ? draftRows : [])],
  }
}
