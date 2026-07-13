export type Cursor = number

/** Exact append-only journal position exposed to read-only projection consumers. */
export type JournalStamp = Readonly<{
  cursor: Cursor
  /** Timestamp of the last event at this cursor; absent for an empty journal. */
  at?: string
}>

export type JournalBatch<Value> = Readonly<{
  cursor: Cursor
  values: readonly Value[]
}>

export type JournalAppend = Readonly<{ appended: true; cursor: Cursor }> | Readonly<{ appended: false; cursor: Cursor }>

export type Journal<Value> = Readonly<{
  read(after?: Cursor, before?: Cursor): AsyncIterable<JournalBatch<Value>>
  append(value: Value, expectedCursor: Cursor): Promise<JournalAppend>
}>

export function createMemoryJournal<Value>(initial: readonly Value[] = []): Journal<Value> {
  const values = structuredClone(initial) as Value[]

  return {
    // oxlint-disable-next-line typescript/require-await -- Journal.read is an AsyncIterable contract.
    async *read(after = 0, before = values.length) {
      assertCursor(after)
      assertCursor(before)
      const cursor = Math.min(before, values.length)
      if (after > cursor) throw new RangeError(`yrd: journal cursor ${after} is past ${cursor}`)
      if (after < cursor) yield { cursor, values: structuredClone(values.slice(after, cursor)) }
    },
    append(value, expectedCursor) {
      assertCursor(expectedCursor)
      if (expectedCursor !== values.length) {
        return Promise.resolve({ appended: false as const, cursor: values.length })
      }
      values.push(structuredClone(value))
      return Promise.resolve({ appended: true as const, cursor: values.length })
    },
  }
}

function assertCursor(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("yrd: journal cursor must be a non-negative safe integer")
  }
}
