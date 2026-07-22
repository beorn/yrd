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
  archiveFallbacks: number
}>

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
