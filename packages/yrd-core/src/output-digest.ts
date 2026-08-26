/**
 * One elision policy for captured child output, so every diagnostic spends its
 * character budget on distinct facts and keeps the first one.
 *
 * The failure that paid for this: a rate-limited install repeated ONE retried
 * dependency's resolve failure six times, and the truncation dropped the head,
 * so the `429` that was the entire diagnosis survived only mid-line at the edge
 * of an ellipsis. It produced three wrong readings in sequence — an unreachable
 * sha, then an invented count of "many dependencies", and only on the third
 * pass the rate limit (@i/10-merge-queue/retries-crowd-out-the-cause).
 *
 * Collapsing happens BEFORE truncating, which is the load-bearing order: the
 * repeats are what consumed the budget the cause needed.
 */

const TRUNCATION_MARKER = "\n… output truncated …\n"

export type OutputDigestOptions = Readonly<{
  /** Total character budget for the returned digest, marker included. */
  limit: number
  /** Characters of the HEAD that survive truncation. Omitted, the whole budget
   * is head — the first error is the one that explains the rest. Named, the
   * remaining budget carries the tail as well, for output whose last lines
   * carry a summary the reader also needs. */
  head?: number
}>

/**
 * Fold runs of the same line into one line carrying its count.
 *
 * ADJACENT runs only. Grouping repeats that were interleaved with other lines
 * would reorder the log into a sequence that never happened — a worse lie than
 * the repetition it removes. Blank runs collapse to one blank line without a
 * count, since `(×3)` on nothing reads as data.
 */
function collapseAdjacentRepeats(output: string): string {
  const collapsed: string[] = []
  let previous: string | undefined
  let run = 0
  const flush = (): void => {
    if (previous === undefined) return
    collapsed.push(run > 1 && previous.trim() !== "" ? `${previous} (×${String(run)})` : previous)
  }
  for (const line of output.split("\n")) {
    if (line === previous) {
      run += 1
      continue
    }
    flush()
    previous = line
    run = 1
  }
  flush()
  return collapsed.join("\n")
}

/** Collapse repeated lines, then fit the result to `limit` without ever losing
 * the beginning. */
export function digestCommandOutput(output: string, options: OutputDigestOptions): string {
  const collapsed = collapseAdjacentRepeats(output.trim())
  const { limit } = options
  if (collapsed.length <= limit) return collapsed
  // A budget too small to hold the marker cannot afford to announce itself;
  // keeping the head is still the right half to keep.
  const headRoom = limit - TRUNCATION_MARKER.length
  if (headRoom <= 0) return collapsed.slice(0, limit)
  const head = options.head ?? headRoom
  const tailRoom = headRoom - head
  if (tailRoom <= 0) return `${collapsed.slice(0, headRoom)}${TRUNCATION_MARKER}`
  return `${collapsed.slice(0, head)}${TRUNCATION_MARKER}${collapsed.slice(-tailRoom)}`
}

/**
 * The shapes in which a package manager or fetcher actually states a status
 * code, so the headline can name the code the output named.
 *
 * Deliberately NOT a bare three-digit match: `silvery@1.500.0` and `compiled
 * 404 modules` would both answer one, and a headline asserting a status the
 * output never reported is a fabricated diagnosis — strictly worse than no
 * status at all, because a reader would act on it.
 */
const STATUS_PATTERNS: readonly RegExp[] = [
  /\bHTTP\/?[\d.]*\s+([1-5]\d{2})\b/iu,
  /\bstatus(?:\s+code)?\s*[:=]?\s*([1-5]\d{2})\b/iu,
  /(?:^|\s)-\s*([1-5]\d{2})\b/u,
  /\b([1-5]\d{2})\s+(?:Too Many Requests|Not Found|Forbidden|Unauthorized|Bad Request|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out)\b/iu,
]

/** The first status code the output states, or `undefined` when it states none.
 * First in the TEXT, not first pattern to match: the earliest code is the one
 * that started the failure, and the later ones are usually its consequences. */
export function outputStatusCode(output: string): string | undefined {
  let earliest: Readonly<{ index: number; code: string }> | undefined
  for (const pattern of STATUS_PATTERNS) {
    const match = pattern.exec(output)
    const code = match?.[1]
    if (match === null || match === undefined || code === undefined) continue
    if (earliest === undefined || match.index < earliest.index) earliest = { index: match.index, code }
  }
  return earliest?.code
}
