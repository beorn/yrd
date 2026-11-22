/**
 * The published/execution split of the queue read model (#28522, ADR-0033).
 *
 * A change's authoritative facts are commits on its own ref; the journal that
 * says which check is running now, what it measured and which log it wrote is
 * local to the queue machine (ADR-0003). The JSON documents used to carry both
 * in one row, so a reader off the machine could not tell a measured zero from a
 * source it could not see (#24340, @cto disposition 6e5624aa).
 *
 * This module keeps the two sides apart by construction:
 *
 * - `PublishedChange` is the pre-journal projection of a row — what the event
 *   chain on the change ref says, and nothing the journal added;
 * - `Execution` is the local collection, carried only inside `Local<T>` so a
 *   reader must narrow before using it.
 *
 * The shapes are the ones @cto approved on 2026-10-10 and quoted verbatim in
 * #24340's "Exact proposed wire boundaries": `schemaVersion: 2`, a `published`
 * object beside `execution: Local<...>`, and no root `changes` array.
 */
import type { JournalRun, JournalSummary, Journals } from "./log.ts"
import { localAbsent, localValue, type Local, type LocalSource } from "./local.ts"
import type { Row } from "./table.ts"

/** The JSON contract version carried by list, watch and change-history documents. */
export const SCHEMA_VERSION = 2 as const

/**
 * The row fields only a journal read can answer. They are never part of a
 * published change: each one names something this machine observed, and a
 * reader that wants it reads `execution` and narrows on `local`.
 *
 * `unknownKinds` rides here with `malformed` because reader version skew is a
 * property of this machine's journal reading, not of the change's records.
 */
const JOURNAL_ONLY_FIELDS = [
  "result",
  "log",
  "incident",
  "diagnostics",
  "malformed",
  "unknownKinds",
  "live",
  "base",
] as const

type JournalOnlyField = (typeof JOURNAL_ONLY_FIELDS)[number]

/** One change as its own refs describe it: no journal-only field can be present. */
export type PublishedChange = Readonly<Omit<Row, JournalOnlyField>>

/** Every journal row read on this machine, keyed by the change each one wrote about. */
export type Execution<Run extends JournalSummary = JournalSummary> = Readonly<{
  /** The directory that was read, so a reader can name the source it did or did not see. */
  dir: string
  /**
   * Every run of every change, flattened from the journal map. Identity is the
   * run's own `id`; the change it wrote about is its `branch` and `head`. The
   * selected optional run is found by joining on `branch@head`, never by index.
   */
  runs: readonly Run[]
  /** Rows that could not be read, each naming its run, key and sentence. */
  malformed: Journals["malformed"]
}>

/**
 * The published projection of one mixed row, field by field.
 *
 * Rest destructuring is deliberate: a new field added to `Row` is published by
 * default, and one added to {@link JOURNAL_ONLY_FIELDS} disappears from the
 * published side the moment it is named here — never a cast that would let a
 * journal-only field through unnoticed.
 */
export function publishedChange(row: Row): PublishedChange {
  const { result, log, incident, diagnostics, malformed, unknownKinds, live, base, ...published } = row
  // Named so the omission is the point of the destructuring, not an accident:
  // these values are exactly the ones `execution` carries instead.
  void result
  void log
  void incident
  void diagnostics
  void malformed
  void unknownKinds
  void live
  void base
  return published
}

/** The execution collection for one completed journal reading. */
export function executionOf<Run extends JournalSummary>(journals: Journals<Run>): Execution<Run> {
  return {
    dir: journals.dir,
    runs: [...journals.runs.values()].flat(),
    malformed: journals.malformed,
  }
}

/**
 * The `Local` answer for a journal source read at ingress.
 *
 * A readable source is this machine's answer, including a readable empty one.
 * A partly-defective source still yields its valid runs beside the keyed
 * defects: the defects travel in `malformed`, so the collection is not withheld
 * for a row that could not be read. An absent or unreadable source is a
 * `local:false` carrying the sentence that names what was looked for and where.
 */
export function executionAnswer<Run extends JournalSummary>(
  source: LocalSource<Journals<Run>>,
  dir: string,
): Local<Execution<Run>> {
  switch (source.kind) {
    case "readable":
      return localValue(executionOf(source.value))
    case "malformed-partial":
      return localValue(executionOf(source.value))
    case "absent":
      return localAbsent(`run journal not found at ${dir}`)
    case "unreadable":
      return localAbsent(source.why)
  }
}

export type { JournalRun }
