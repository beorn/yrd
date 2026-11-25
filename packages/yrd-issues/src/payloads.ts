/**
 * The payload shapes of the two phase-3 verbs (@cto 37a8972c, hh #37445). The twelve original verbs carry their whole
 * request in argv, so they need no types here; `state` and `watch` are the pair whose request and answer are data.
 *
 * Types only: no validation, no IO. A provider that answers in another shape is refused by its consumer, never quietly
 * coerced.
 */

/**
 * What a `state` write means. It moves one issue between the board's states and is set-state, so repeating it with the
 * same `<id>` is a no-op at the provider. `state` is the tracker's own name for the state: a provider refuses, by name,
 * one its tracker does not declare.
 */
export interface IssuesStatePayload {
  readonly key: string
  readonly state: string
}

/** One change a `watch` reports. `deleted` is a tombstone, so a consumer drops the row rather than editing it. */
export interface IssuesWatchChange {
  readonly key: string
  readonly op: "created" | "updated" | "deleted"
  readonly version: string
}

/**
 * `watch`'s answer. `position` is opaque to every consumer and is exactly what the next call passes as `<since>`; a
 * provider that returns a position it cannot later accept would make the next watch refuse, so the pair is its own
 * round-trip contract.
 */
export interface IssuesWatchAnswer {
  readonly position: string
  readonly changes: readonly IssuesWatchChange[]
}
