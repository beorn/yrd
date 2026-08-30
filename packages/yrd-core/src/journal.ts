export type Cursor = number

export type JournalBatch<Value> = Readonly<{
  cursor: Cursor
  values: readonly Value[]
}>

export type JournalAppend = Readonly<{ appended: true; cursor: Cursor }> | Readonly<{ appended: false; cursor: Cursor }>

export type JournalCheckpoint = Readonly<{
  identity: string
  cursor: Cursor
  value: unknown
}>

export type JournalCheckpointStore = Readonly<{
  load(identity: string): Promise<JournalCheckpoint | undefined>
  /** Return the checksum-validated stored checkpoint regardless of identity.
   * Core alone decides whether a declared migration may consume it. */
  inspect?(): Promise<JournalCheckpoint | undefined>
  save?(checkpoint: JournalCheckpoint): Promise<boolean>
}>

export type JournalHistoryEntry<Value> = Readonly<{
  cursor: Cursor
  value: Value
}>

export type JournalIdentityKind = "cause" | "event"
export type JournalEntityKind = "job" | "job-key" | "queue"

export type JournalHistoryDiagnostics = Readonly<{
  pageCount: number
  freelistCount: number
  autoVacuum: "none" | "full" | "incremental"
  historyFrames: number
  tailFrames: number
  /** Highest cursor the retention window has dropped; frames at or below it are gone. */
  evictedThrough: number
  /** Lowest cursor still present in history or the live tail. Null when the journal has no retained frames. */
  oldestRetainedCursor: Cursor | null
  archiveFallbacks: number
}>

/**
 * Whether a reader may start reading where it wants to start.
 *
 * `evictedThrough` is a PERMANENT property of a journal: retention deletes
 * frames, and nothing a caller does brings them back. So the only question
 * worth asking about it is positional — is the cursor I hold still inside the
 * range that survives? — and the answer decides behaviour, not severity.
 *
 * `below-floor` is therefore never on its own a reason to fail. A caller whose
 * range dips under the floor has exactly two honest moves: refuse to serve a
 * history with an invisible hole in it (what the SQLite reader does, because
 * silently returning a short range is the worse error), or start at the floor
 * and say so (what a settlement drain does, because the range below the floor
 * cannot be settled by anyone and holding a cursor there settles nothing ever
 * again). What no caller may do is treat it as a transient failure to retry:
 * the retry is guaranteed to fail identically, forever.
 *
 * One decision point so those two moves stay two readings of one fact rather
 * than drifting into two facts — the same reason `classifyJournalSchema` exists
 * for the version axis.
 */
export type JournalHistoryCoverage =
  | Readonly<{ kind: "covered"; evictedThrough: number; from: number }>
  | Readonly<{ kind: "below-floor"; evictedThrough: number; from: number }>

/**
 * The one decision point for a `(evictedThrough, from)` pair.
 *
 * `from` is exclusive, matching {@link Journal.read}'s `after`: a reader
 * starting AT the floor asks for the first surviving frame and is covered.
 */
export function classifyJournalHistory(evictedThrough: number, from: number): JournalHistoryCoverage {
  if (from < evictedThrough) return { kind: "below-floor", evictedThrough, from }
  return { kind: "covered", evictedThrough, from }
}

/**
 * Immutable, journal-owned lookup facts. Implementations derive these facts in
 * the same transaction as their frame and must fail loud when they disagree
 * with journal authority. Absence explicitly disables live-state eviction.
 */
export type JournalHistory<Value> = Readonly<{
  command(query: Readonly<{ id?: string; key?: string }>): Value | undefined
  hasIdentity(kind: JournalIdentityKind, id: string): boolean
  entity(kind: JournalEntityKind, id: string): readonly JournalHistoryEntry<Value>[]
  diagnostics(): JournalHistoryDiagnostics
}>

export type Journal<Value> = Readonly<{
  read(after?: Cursor, before?: Cursor): AsyncIterable<JournalBatch<Value>>
  append(value: Value, expectedCursor: Cursor): Promise<JournalAppend>
  checkpoint?: JournalCheckpointStore
  history?: JournalHistory<Value>
}>

export function createMemoryJournal<Value>(initial: readonly Value[] = []): Journal<Value> {
  const values = globalThis.structuredClone(initial) as Value[]

  return {
    // oxlint-disable-next-line typescript/require-await -- Journal.read is an AsyncIterable contract.
    async *read(after = 0, before = values.length) {
      assertCursor(after)
      assertCursor(before)
      const cursor = Math.min(before, values.length)
      if (after > cursor) throw new RangeError(`yrd: journal cursor ${after} is past ${cursor}`)
      if (after < cursor) yield { cursor, values: globalThis.structuredClone(values.slice(after, cursor)) }
    },
    append(value, expectedCursor) {
      assertCursor(expectedCursor)
      if (expectedCursor !== values.length) {
        return Promise.resolve({ appended: false as const, cursor: values.length })
      }
      values.push(globalThis.structuredClone(value))
      return Promise.resolve({ appended: true as const, cursor: values.length })
    },
  }
}

function assertCursor(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("yrd: journal cursor must be a non-negative safe integer")
  }
}
