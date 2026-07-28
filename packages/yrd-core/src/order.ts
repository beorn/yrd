/**
 * Natural (digit-aware) ordering for yrd identifiers.
 *
 * yrd sorts identifiers whose meaning is numeric but whose type is string —
 * `R9` before `R41`, `#1207` before `#1210`, `pr#4.1` before `pr#4.10`. Plain
 * lexicographic order gets those wrong, so every such comparator wants
 * `{ numeric: true }` collation.
 *
 * `String.prototype.localeCompare(other, undefined, { numeric: true })` is the
 * obvious spelling and the wrong one: passing an options object defeats the
 * engine's cached-collator fast path, so the runtime canonicalizes a locale and
 * constructs a fresh ICU collator on EVERY comparison. A CPU sample of
 * `yrd queue list` on a real journal put `ucol_open` / `uloc_toLanguageTag` /
 * `icu::Collator::createInstance` among the hottest leaves, at 3.5M such calls
 * per invocation. One hoisted collator produces byte-identical ordering roughly
 * 15x faster per comparison (measured: 404.5ms vs 26.6ms over 200k comparisons;
 * 9.5x on a real 20k-element sort).
 *
 * Use {@link compareNatural} for any identifier ordering. A literal
 * `localeCompare(x, undefined, { numeric: true })` anywhere in yrd is the defect
 * this replaces — `packages/yrd-core/tests/order.test.ts` fails the build if one
 * reappears.
 *
 * Comparators that do NOT want numeric collation (ISO timestamps, SHAs, plain
 * branch names) should keep bare `localeCompare(other)`: with no options object
 * the engine already uses its cached collator, and that path is faster still.
 */
const naturalCollator = new Intl.Collator(undefined, { numeric: true })

/** Compare two identifiers in natural (digit-aware) order. Ordering is
 * identical to `left.localeCompare(right, undefined, { numeric: true })`. */
export function compareNatural(left: string, right: string): number {
  return naturalCollator.compare(left, right)
}
