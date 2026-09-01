import { parseJournalFrame, type Journal, type JournalEntityKind, type JournalFrame } from "@yrd/core"

/** In-memory journal with the history index that activates Core's compaction
 * path. Keep this one shared fixture: a plain createMemoryJournal deliberately
 * has no history and cannot reproduce projection/replay divergence. */
export function indexedJournal(initial: readonly JournalFrame[] = []): Journal<unknown> {
  const values = initial.map((frame) => parseJournalFrame(structuredClone(frame)))
  const entityIds = (frame: JournalFrame, kind: JournalEntityKind): readonly string[] => {
    const ids = new Set<string>()
    for (const applied of frame.events) {
      const data = applied.data as Readonly<Record<string, unknown>>
      if (applied.name === "job/requested") {
        if (kind === "job") ids.add(applied.id)
        if (kind === "job-key" && typeof data.key === "string") ids.add(data.key)
      }
      if (applied.name === "job/transitioned" && kind === "job" && typeof data.id === "string") ids.add(data.id)
      if (applied.name === "job/restored" && typeof data.job === "object" && data.job !== null) {
        const job = data.job as Readonly<{ id?: unknown; key?: unknown }>
        if (kind === "job" && typeof job.id === "string") ids.add(job.id)
        if (kind === "job-key" && typeof job.key === "string") ids.add(job.key)
      }
      if (kind === "queue") {
        if (typeof data.run === "string") ids.add(data.run)
        else if (typeof data.run === "object" && data.run !== null) {
          const run = data.run as Readonly<{ id?: unknown }>
          if (typeof run.id === "string") ids.add(run.id)
        }
        if (applied.name === "queue/batch/isolated" && typeof data.parent === "string") ids.add(data.parent)
      }
    }
    return [...ids]
  }
  return {
    async *read(after = 0, before = values.length) {
      const end = Math.min(before, values.length)
      if (after < end) yield { cursor: end, values: structuredClone(values.slice(after, end)) }
    },
    append(value, expectedCursor) {
      if (expectedCursor !== values.length) return Promise.resolve({ appended: false as const, cursor: values.length })
      values.push(parseJournalFrame(structuredClone(value)))
      return Promise.resolve({ appended: true as const, cursor: values.length })
    },
    history: {
      command(query) {
        return structuredClone(
          values.find(
            (frame) =>
              (query.id !== undefined && frame.command.id === query.id) ||
              (query.key !== undefined && frame.cause.key === query.key),
          ),
        )
      },
      hasIdentity(kind, id) {
        return values.some((frame) =>
          kind === "cause" ? frame.cause.id === id : frame.events.some((applied) => applied.id === id),
        )
      },
      entity(kind, id) {
        return values.flatMap((value, index) =>
          entityIds(value, kind).includes(id) ? [{ cursor: index + 1, value: structuredClone(value) }] : [],
        )
      },
      diagnostics() {
        return {
          pageCount: 0,
          freelistCount: 0,
          autoVacuum: "incremental" as const,
          historyFrames: 0,
          tailFrames: values.length,
          evictedThrough: 0,
          oldestRetainedCursor: values.length === 0 ? null : 1,
          archiveFallbacks: 0,
        }
      },
    },
  }
}
