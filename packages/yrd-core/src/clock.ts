/**
 * The one wall-clock reader every injectable `now`/`clock` option defaults to.
 *
 * Two shapes coexisted across the codebase before this: an epoch-millisecond
 * provider (`options.now ?? Date.now`, `() => number`) and an ISO-8601
 * provider (`options.clock ?? (() => new Date().toISOString())`,
 * `() => string`) — each reinvented locally at every call site. `systemClock`
 * gives both a single home; callers keep their own `now`/`clock` option field
 * (name and shape unchanged, so no persisted format and no public option
 * shifts) and just default it to `systemClock.now` or `systemClock.iso`
 * instead of rebuilding the same one-liner.
 *
 * NOT for elapsed-time/duration measurement — `Date.now()` can jump on a
 * clock adjustment. That need is `performance.now()` (see
 * `yrd-process`'s `createProcess` and this package's own `stage-clock.ts`),
 * deliberately left alone here.
 */
export type Clock = Readonly<{
  /** Epoch milliseconds, i.e. `Date.now()`. */
  now(): number
  /** Wall-clock timestamp as ISO-8601, i.e. `new Date().toISOString()`. */
  iso(): string
}>

export const systemClock: Clock = Object.freeze({
  now: () => Date.now(),
  iso: () => new Date().toISOString(),
})
