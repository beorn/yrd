/**
 * The structured identity a warn/error log record carries in its `action`
 * field, and the one place each identity is spelled.
 *
 * WHY A DEFINITION SITE AND NOT A REGISTRY. `YRD_REFUSAL_CODES` is this
 * repository's cautionary tale: a central list of ~280 code STRINGS that
 * producers restate independently, plus a `YRD_REFUSAL_CODE_ALIASES` table
 * that exists only because the two homes drifted into different spellings of
 * the same failure. A list you must remember to update is a second home for
 * the same truth (`no-parallel-derivation`).
 *
 * Action keys are not codes. A refusal code is CONSTRUCTED at runtime from a
 * domain failure, so a registry can only validate it after the fact. An action
 * key is STATIC — one per emission site, known when the line is written — so
 * the site can reference the definition instead of restating it. The string
 * lives here exactly once; a call site imports the entry and reads `.key`.
 * There is nothing to keep in sync, which is what separates this from the
 * registry the operator's doctrine warns about.
 *
 * WHAT AN ENTRY MAY HOLD. Identity (`key`), severity (`level`), and app
 * behaviour (`disposition`). It holds NOTHING about destinations, sinks,
 * subscribers, or who gets told: the execution environment routes logs and
 * Yrd never does. A field naming a channel or a recipient does not belong in
 * this type and its absence is deliberate.
 *
 * GROWING AN ENTRY. Two fields are anticipated and land without reshaping the
 * type or any call site:
 *   - `disposition` already carries the stop-the-queue axis. It is a closed
 *     union, so adding `"halt"` beside `"record"` is a one-word edit per entry
 *     and every entry is forced to state which it is — the field is required
 *     precisely so a new condition cannot default into silence.
 *   - the rewritten message text lands as a `message` field on this same
 *     object, read by an emission helper rather than passed at the call site.
 *     It is deliberately NOT declared yet: the rewrites are owned elsewhere
 *     and in flight, and an empty field waiting for them would be a second
 *     home for prose that still lives at the call sites.
 */

/**
 * What Yrd DOES when this condition fires — app behaviour, never routing.
 *
 * `record` — log it and carry on. Every condition is `record` today; that is a
 * fact about current behaviour, not a judgement that it should stay one.
 *
 * `halt` is reserved for the stop-the-queue disposition under discussion and
 * has no members yet. Adding it here is what makes the choice explicit at
 * every entry rather than implicit in whichever `catch` happens to run.
 */
export type LogActionDisposition = "record"

/** The severities an action key is defined for. `action` identifies a
 * CONDITION worth naming; info/debug/trace records describe ordinary progress
 * and are identified by their lifecycle instead (see observeYrdLifecycle). */
export type LogActionLevel = "warn" | "error"

export type LogAction = Readonly<{
  /** The exact string that reaches the `action` field of the log record.
   * Kebab-case, `<subject>-<object>-<outcome>`; see LOG_ACTION_KEY_PATTERN. */
  key: string
  level: LogActionLevel
  disposition: LogActionDisposition
}>

/**
 * The shape every key is held to: two or more lowercase kebab-case tokens.
 * One token is a category, not an identity — `queue` tells a reader which
 * subsystem spoke and nothing about what happened.
 */
export const LOG_ACTION_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)+$/

/** Define one action key. Refuses a malformed key at module load, so a typo
 * cannot reach a log record and quietly become a distinct identity nobody can
 * grep for. */
export function logAction(entry: LogAction): LogAction {
  if (!LOG_ACTION_KEY_PATTERN.test(entry.key)) {
    throw new Error(
      `yrd: log action key '${entry.key}' is not lowercase kebab-case with at least two tokens; ` +
        `an action key names one condition (subject-object-outcome), never a bare subsystem`,
    )
  }
  return Object.freeze(entry)
}

/**
 * The dedupe key for one OCCURRENCE of a repeating condition, for
 * `ConditionReporter.report`. The action names the condition; the
 * discriminators name which instance of it is active, so two different
 * branches announce separately while the same branch tallies.
 *
 * Building it here is what keeps the reporter's key and the record's `action`
 * from becoming two independently-typed strings — the shape live call sites
 * spell by hand today, and the drift a rename would otherwise have to chase
 * through both.
 */
export function logActionInstance(entry: LogAction, ...discriminators: readonly string[]): string {
  return discriminators.length === 0 ? entry.key : `${entry.key}:${discriminators.join(":")}`
}
