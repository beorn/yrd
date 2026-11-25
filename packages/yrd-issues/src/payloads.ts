/**
 * The payload shape of the phase-3 verb (@cto 37a8972c, hh #37445). The original verbs carry their whole request in
 * argv, so they need no types here; `state` is the one whose request is data.
 *
 * Types only: no validation, no IO. A provider that answers in another shape is refused by its consumer, never quietly
 * coerced.
 */

/**
 * What a `state` write means. It moves one issue between the board's states and is set-state, so repeating it with the
 * same `<id>` is a no-op at the provider. `state` is the tracker's own name for the state: a provider refuses, by name,
 * one its tracker does not declare, and refuses an unknown `key` by name rather than creating anything (@cto 8dfe1bd3).
 */
export interface IssuesStatePayload {
  readonly key: string
  readonly state: string
}

