import { raiseFailure } from "./failure.ts"

export type SelectorCandidate<Value> = Readonly<{
  canonical: string
  aliases?: readonly string[]
  value: Value
}>

export type SelectorOptions = Readonly<{ kind: string }>

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

/** Resolve operator input without changing the selected entity's stored identity. */
export function resolveSelector<Value>(
  selector: string,
  candidates: Iterable<SelectorCandidate<Value>>,
  options: SelectorOptions,
): Value | undefined {
  const indexed = indexedCandidates(candidates)
  const canonical = indexed.find((candidate) => candidate.canonical === selector)
  if (canonical !== undefined) return canonical.value

  const folded = selector.toLowerCase()
  const insensitive = indexed.filter((candidate) =>
    [...candidate.selectors].some((candidateSelector) => candidateSelector.toLowerCase() === folded),
  )
  if (insensitive.length === 1) return insensitive[0]?.value
  if (insensitive.length > 1) ambiguous(selector, insensitive, options.kind)
  return undefined
}
