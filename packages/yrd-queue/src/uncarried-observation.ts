/**
 * The uncarried OBSERVATION vocabulary — how a sweep's counts are allowed to
 * reach a reader: the minted observation record, its coverage-floor sentence,
 * the bounded count, the denominator ledger line, and the rail phrasing.
 * Moved here from `@yrd/cli`'s queue-status-view so the uncarried domain has
 * ONE home beside `uncarried.ts` / `uncarried-facts.ts` / `uncarried-sweep.ts`
 * (5a: one derivation per fact); the sweep's remote-base-aware result (W2a)
 * is the input, and this module is its only phrasing.
 */
/** One uncarried sweep: what it found AND when it looked. The two travel
 * together because either alone is misleading. */
export type UncarriedObservation = Readonly<{
  /** Stranded refs the sweep confirmed — already past the mergedness filter. */
  count: number
  /** Refs enumerated, so a zero is readable rather than merely small. */
  scanned: number
  /** Legacy refs whose reflog clock was not retained. Optional for status
   * written by older habitants; absence is unknown coverage, never zero. */
  missingUpdateClocks?: number
  /**
   * Uncarried refs whose update clock WAS retained, so the sweep could judge
   * them. With `missingUpdateClocks` this gives the coverage fraction, which
   * `scanned` alone cannot: `scanned` counts carried and superseded refs the
   * rail never had to measure. Optional for status written by older habitants;
   * absence is unknown coverage, never full coverage.
   */
  measurable?: number
  observedAt: string
  /**
   * The coverage sentence, and the count already bounded — carried as FIELDS so
   * that no consumer can serialize this record without them.
   *
   * Five machine surfaces emit this object (`queue.uncarried --json`,
   * `queue.list`, the watch stream, `RunnerHealthFacts`, the habitant
   * heartbeat's `status.json`), and every one of them used to ship a bare
   * `count` while the coverage stayed behind at the one call site that
   * remembered to compute it. Making the derived half part of the record turns
   * "remember to say it is a floor" from a rule into a type: they are minted
   * once by {@link uncarriedObservation} and travel wherever the count goes.
   */
  floor: string
  bounded: string
}>

/**
 * Mint an observation with its coverage attached. The ONLY constructor — both
 * the habitant's sweeper and the tolerant reader of an older `status.json` go
 * through here, so a record that reaches a renderer always knows how much of
 * its own population it managed to measure.
 */
export function uncarriedObservation(
  input: Readonly<{
    count: number
    scanned: number
    measurable?: number
    missingUpdateClocks?: number
    observedAt: string
  }>,
): UncarriedObservation {
  return {
    count: input.count,
    scanned: input.scanned,
    ...(input.measurable === undefined ? {} : { measurable: input.measurable }),
    ...(input.missingUpdateClocks === undefined ? {} : { missingUpdateClocks: input.missingUpdateClocks }),
    observedAt: input.observedAt,
    floor: uncarriedCoverageFloor(input.measurable, input.missingUpdateClocks),
    bounded: uncarriedFloorCount(input.count, input.missingUpdateClocks),
  }
}

/**
 * What the rail's COLOUR claims: that an action exists. Warning only when the
 * sweep actually found stranded work; muted otherwise, INCLUDING a zero drawn
 * from partial coverage.
 *
 * That last clause is a deliberate ruling (@chief, 2026-08-17), not an
 * oversight, and it is written down here because it looks like a bug to anyone
 * who has just read {@link uncarriedCoverageFloor}: a zero at 15% coverage
 * really is an unmeasured fleet rather than a clean one. The epistemics belong
 * in the rail TEXT, which now always carries `≥` and its coverage sentence.
 * Colouring partial coverage would leave the rail permanently lit on a real
 * fleet — 2211 of 2602 refs lack retained clocks — and a rail that is always
 * warning becomes noise and gets ignored, which is precisely how the previous
 * one died. Do not add a third colour here; strengthen the sentence instead.
 */
export function uncarriedRailColor(observation: UncarriedObservation | undefined): string {
  return observation !== undefined && observation.count > 0 ? "$fg-warning" : "$fg-muted"
}

/**
 * How much of the candidate population this sweep could actually judge.
 *
 * The rail is required to say this next to its count, because the count is a
 * FLOOR and reads exactly like a total. Measured 2026-08-14: 2,442 of 2,786
 * uncarried refs had no retained reflog clock, so the rail saw 12% of its
 * population — and a zero from a 12% reading is not a clean fleet, it is an
 * unmeasured one. One function, shared by the rail and the `queue uncarried`
 * command, so the two surfaces cannot phrase the same gap differently.
 */
export function uncarriedCoverageFloor(
  measurable: number | undefined,
  missingUpdateClocks: number | undefined,
  unenumerable = 0,
): string {
  // An absent clock count is unknown coverage, never full coverage — the
  // distinction an older habitant's status cannot make for itself.
  if (missingUpdateClocks === undefined) return "push-clock coverage unknown, so a floor"
  // Two independent gaps, phrased separately. A ref with no merge base was not
  // missing a clock, and folding it into that count would attribute the gap to
  // a cause nobody measured.
  const gaps: string[] = []
  if (missingUpdateClocks > 0) gaps.push(`${String(missingUpdateClocks)} refs without retained update clocks`)
  if (unenumerable > 0) {
    gaps.push(`${String(unenumerable)} ref${unenumerable === 1 ? "" : "s"} with no merge base`)
  }
  // Full coverage is a claim about BOTH gaps. Returning it while refs went
  // unenumerable is the under-count this whole helper exists to refuse.
  if (gaps.length === 0) return "every candidate had a retained update clock"
  const gap = gaps.join(" and ")
  if (measurable === undefined) return `a floor — ${gap}, against an unknown candidate population`
  const candidates = measurable + missingUpdateClocks + unenumerable
  const percent = Math.round((measurable / candidates) * 100)
  // A rail that rounds a real 0.4% down to a flat "0% measurable" says the
  // sweep saw nothing, which is a different fact from seeing almost nothing.
  const share = measurable > 0 && percent === 0 ? "<1%" : `${String(percent)}%`
  return `a floor — ${share} of ${String(candidates)} candidates measurable, ${gap}`
}

/**
 * A sweep count printed with its floor bound: `≥N` whenever any candidate went
 * unmeasured, a bare `N` only when coverage was provably complete.
 *
 * Exported and shared by EVERY surface that prints one of these counts — the
 * runner-box rail and the `queue uncarried` command — because the bound is the
 * half a reader acts on: "33 uncarried" is a work item, "≥33 of a population
 * 15% of which we could measure" is an unknown, and the two were being phrased
 * differently on the two surfaces (@i/10-merge-queue/22925-watch-shows-every-pr).
 * Unknown coverage counts as partial: an older habitant that cannot report its
 * clock gap has not proven it had none.
 */
export function uncarriedFloorCount(count: number, missingUpdateClocks: number | undefined, unenumerable = 0): string {
  // A ref the sweep could not enumerate is unmeasured exactly like a ref with
  // no retained clock: either one makes the count a floor rather than a total.
  const partial = missingUpdateClocks === undefined || missingUpdateClocks > 0 || unenumerable > 0
  return `${partial ? "≥" : ""}${String(count)}`
}

/** Every bucket a sweep sorted its refs into, in the order the ledger prints. */
export type UncarriedBuckets = Readonly<{
  scanned: number
  carried: number
  exempt: number
  superseded: number
  outsideAgeBound: number
  examined: number
  missingUpdateClocks: number
  unenumerable: number
}>

/**
 * The ledger line that makes a zero believable.
 *
 * ONE function rather than a template at each call site, for the same reason
 * `uncarriedFloorCount` is: the identity
 *
 *   scanned = carried + exempt + superseded + clocks + aged + examined + unenumerable
 *
 * is only checkable by a reader if every term is on the line, and a term that
 * lives in a string literal is one careless edit from silently disappearing.
 * A dropped term does not look like a bug — it looks like a smaller fleet.
 */
export function uncarriedDenominator(buckets: UncarriedBuckets): string {
  return [
    `scanned ${String(buckets.scanned)}`,
    `${String(buckets.carried)} carried`,
    // Policy exclusions sit with every other bucket, at zero as much as at
    // seven: an exemption reported somewhere else is one a reader has to
    // already suspect before they can find it.
    `${String(buckets.exempt)} exempt by policy`,
    `${String(buckets.superseded)} superseded revisions collapsed`,
    `${String(buckets.outsideAgeBound)} outside the age bound`,
    `${String(buckets.examined)} examined`,
    `${String(buckets.missingUpdateClocks)} refs without retained update clocks`,
    `${String(buckets.unenumerable)} unenumerable`,
  ].join(" · ")
}

/**
 * How a rail must say what it measured, or that it did not measure.
 *
 * Exported and used by the renderer so the rule is one function rather than a
 * convention: there is no code path that can produce a bare count. An absent
 * observation says so in words — a missing measurement rendering as "0" would
 * claim a healthy queue that nobody looked at.
 */
export function uncarriedLine(observation: UncarriedObservation | undefined, nowMs: number): string {
  // Plain language, own label (operator ruling 2026-08-18, item 15): the old
  // "uncarried not swept" was jargon-fused — two words with no verb between
  // them reading as one compound term. This still says nothing was measured
  // (never a bare 0, the same honest-absence rule the rest of this function
  // upholds) and now names the sweep so the label cannot fuse with whatever
  // renders next to it.
  if (observation === undefined) return "UNCARRIED — stranded-refs sweep hasn't produced an observation yet"
  const ageMs = Math.max(0, nowMs - Date.parse(observation.observedAt))
  // Both halves are read off the record, not recomputed here: `≥` is not
  // decoration — the count is a floor whenever any candidate went unmeasured,
  // and an operator scanning the rail reads a bare number as a total long
  // before they read the parenthetical that says otherwise.
  return (
    `uncarried ${observation.bounded} of ${String(observation.scanned)} refs (${observation.floor}), ` +
    `as of ${humanAge(ageMs)} ago`
  )
}

function humanAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000)
  if (minutes < 1) return "under a minute"
  if (minutes < 60) return `${String(minutes)}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${String(hours)}h` : `${String(hours)}h${String(rest)}m`
}
