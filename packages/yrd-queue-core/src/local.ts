/**
 * Which of a rendered answer's fields exist only on the machine that holds the
 * journal, and what a reader can tell about a non-answer.
 *
 * A change's authoritative facts are commits on its own ref; the JOURNAL that
 * says which check is running now, what it measured and when it started is
 * local to the queue machine (ADR-0003: git is the only store, and derived
 * caches are never authority). The locality is correct. What was missing is
 * that nothing MARKED it, so a reader off the machine saw a degraded view that
 * looked exactly like the full one (#24340).
 *
 * The shape is the one @cto approved on 2026-10-10 (disposition 6e5624aa) and
 * analysed in #24340, retained verbatim rather than replaced by a smaller
 * primitive:
 *
 *     Local<T> = {local:true, value:T} | {local:false, why:string}
 *
 * The compiler is the point. A field declared `Local<T>` is not a `T`: reading
 * it as one fails to typecheck until the reader narrows on `local`, so "is this
 * answer from this machine?" is a question the code must answer rather than a
 * habit it may forget. What it cannot cover is a field nobody typed as `Local`,
 * and a value read outside the type system (a JSON boundary, a cast) — those
 * stay a review question, not a compiler one.
 *
 * Three distinctions this module keeps separate, because folding any of them
 * into another produces exactly the silent default #24340 is about:
 *
 * - an available `undefined` is `{local:true, value:undefined}`, never a
 *   `{local:false}`: the source was read and had nothing to say;
 * - a readable source with no rows (`readable-empty`) is not an absent source
 *   (`absent`): the first is measured nothing, the second is no measurement;
 * - a defect (`unreadable`, `malformed-partial`) is not an absence: it carries
 *   the sentence saying what went wrong, so a reader is never told "nothing
 *   happened here" when something did.
 */

/**
 * An answer whose truth is a fact of this machine only, or the sentence saying
 * why it could not be read here.
 *
 * `why` is addressed to a human reader and names the source and the cure where
 * the source knows them; it is never a code to be matched on.
 */
export type Local<T> = Readonly<{ local: true; value: T }> | Readonly<{ local: false; why: string }>

/** This machine read the source and this is what it found — including `undefined`, which is an answer. */
export function localValue<T>(value: T): Local<T> {
  return { local: true, value }
}

/** This machine could not read the source, and this is the sentence that says why. */
export function localAbsent(why: string): Local<never> {
  return { local: false, why }
}

/** Whether this answer is one this machine can vouch for. */
export function isLocal<T>(answer: Local<T>): answer is Readonly<{ local: true; value: T }> {
  return answer.local
}

/**
 * What reading a local source produced, before any question is asked of it.
 *
 * This is the ingestion shape: `readable` covers both an empty journal and a
 * full one (the value is the collection, and a reader that cares about emptiness
 * asks for it — see `localSourceState`), and the two defect kinds are distinct
 * because their cures are: `unreadable` is a source this process could not open
 * at all, `malformed-partial` is a source it read and found partly defective,
 * whose valid rows are still worth showing beside the defect.
 */
export type LocalSource<T> =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "unreadable"; why: string }>
  | Readonly<{ kind: "malformed-partial"; value: T; why: string }>
  | Readonly<{ kind: "readable"; value: T }>

/**
 * The five answers a reader must be able to tell apart, as one word each.
 *
 * Kept as a function over an explicit emptiness predicate rather than as two
 * more union members: emptiness is a property of the VALUE (an empty collection
 * is a measurement), while `absent`/`unreadable`/`malformed-partial` are
 * properties of the SOURCE, and collapsing them into one enum would put the
 * two kinds of fact in one slot and invite a caller to render them alike.
 */
export type LocalSourceState = "absent" | "unreadable" | "malformed-partial" | "readable-empty" | "readable-present"

export function localSourceState<T>(source: LocalSource<T>, isEmpty: (value: T) => boolean): LocalSourceState {
  switch (source.kind) {
    case "absent":
      return "absent"
    case "unreadable":
      return "unreadable"
    case "malformed-partial":
      return "malformed-partial"
    case "readable":
      return isEmpty(source.value) ? "readable-empty" : "readable-present"
  }
}

/**
 * A readable source as the marked answer a renderer takes, with emptiness made
 * explicit rather than left to each renderer's own `length` check.
 *
 * A defect is `local:false` with its explanation: the CTO's amendment keeps a
 * defect from being rendered as a value. `readable-empty` is `local:true` with
 * the empty value, because the source WAS read and it is a measurement.
 */
export function localCollectionAnswer<T>(
  source: LocalSource<T>,
  isEmpty: (value: T) => boolean,
  absentWhy: string,
): Local<T> {
  switch (source.kind) {
    case "absent":
      return localAbsent(absentWhy)
    case "unreadable":
      return localAbsent(source.why)
    case "malformed-partial":
      return localAbsent(source.why)
    case "readable":
      return localValue(source.value)
  }
}
