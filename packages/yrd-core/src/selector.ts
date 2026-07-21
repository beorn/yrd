import { raiseFailure } from "./failure.ts"

export type SelectorCandidate<Value> = Readonly<{
  canonical: string
  aliases?: readonly string[]
  value: Value
}>

export type SelectorOptions<Value = unknown> = Readonly<{
  kind: string
  /** Read-bias for a colliding folded selector: when several aliases resolve to
   * the same input, a single candidate satisfying `prefer` wins (e.g. "the one
   * live PR on this branch"). When none qualify, the first candidate is returned
   * — callers pass their candidates most-relevant-first (e.g. most recent). More
   * than one preferred candidate, or no preference at all, stays a loud
   * ambiguity. Opt-in: without `prefer`, collisions refuse exactly as before. */
  prefer?: (value: Value) => boolean
}>

/** How a selector reached its resolved entity. `canonical` when the input
 * folds to the entity's own canonical identity (an exact or case-folded id);
 * `alias` when it matched only through a secondary handle (a branch, a name).
 * Consumers that special-case id-addressing — a mutation guard that lets an
 * id-named terminal through, a terminal-branch dispatch that reopens on a moving
 * branch — read this instead of re-deriving the fold at each call site. */
export type SelectorMatch<Value> = Readonly<{
  value: Value
  matchedBy: "canonical" | "alias"
}>

type IndexedCandidate<Value> = Readonly<{
  canonical: string
  selectors: ReadonlySet<string>
  value: Value
}>

function indexedCandidates<Value>(candidates: Iterable<SelectorCandidate<Value>>): IndexedCandidate<Value>[] {
  const indexed = new Map<string, { selectors: Set<string>; value: Value }>()
  for (const candidate of candidates) {
    const current = indexed.get(candidate.canonical)
    if (current === undefined) {
      indexed.set(candidate.canonical, {
        selectors: new Set([candidate.canonical, ...(candidate.aliases ?? [])]),
        value: candidate.value,
      })
      continue
    }
    for (const alias of candidate.aliases ?? []) current.selectors.add(alias)
  }
  return [...indexed].map(([canonical, candidate]) => ({ canonical, ...candidate }))
}

function ambiguous<Value>(selector: string, matches: readonly IndexedCandidate<Value>[], kind: string): never {
  const canonical = matches
    .map((candidate) => candidate.canonical)
    .toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  raiseFailure(
    "refusal",
    "selector-ambiguous",
    `yrd: ${kind} selector '${selector}' is ambiguous: ${canonical.join(", ")}`,
  )
}

function foldedWinner<Value>(
  selector: string,
  folded: string,
  insensitive: readonly IndexedCandidate<Value>[],
  options: SelectorOptions<Value>,
): IndexedCandidate<Value> | undefined {
  if (insensitive.length <= 1) return insensitive[0]
  if (options.prefer !== undefined) {
    const preferred = insensitive.filter((candidate) => options.prefer!(candidate.value))
    if (preferred.length === 1) return preferred[0]
    if (preferred.length === 0) return insensitive[0]
  }
  ambiguous(selector, insensitive, options.kind)
}

/** Resolve operator input, reporting HOW it matched, without changing the
 * selected entity's stored identity. The single place case-folding lives:
 * callers read {@link SelectorMatch.matchedBy} rather than re-deriving the fold. */
export function resolveSelectorMatch<Value>(
  selector: string,
  candidates: Iterable<SelectorCandidate<Value>>,
  options: SelectorOptions<Value>,
): SelectorMatch<Value> | undefined {
  const indexed = indexedCandidates(candidates)
  const canonical = indexed.find((candidate) => candidate.canonical === selector)
  if (canonical !== undefined) return { value: canonical.value, matchedBy: "canonical" }

  const folded = selector.toLowerCase()
  const insensitive = indexed.filter((candidate) =>
    [...candidate.selectors].some((candidateSelector) => candidateSelector.toLowerCase() === folded),
  )
  const winner = foldedWinner(selector, folded, insensitive, options)
  if (winner === undefined) return undefined
  return { value: winner.value, matchedBy: winner.canonical.toLowerCase() === folded ? "canonical" : "alias" }
}

/** Resolve operator input to the selected entity, discarding the match
 * provenance. The value-only convenience over {@link resolveSelectorMatch}. */
export function resolveSelector<Value>(
  selector: string,
  candidates: Iterable<SelectorCandidate<Value>>,
  options: SelectorOptions<Value>,
): Value | undefined {
  return resolveSelectorMatch(selector, candidates, options)?.value
}
