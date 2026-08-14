/**
 * UNCARRIED refs: deciding whether a ref that reached the remote and never
 * became a carrier is genuinely stranded.
 *
 * The name is deliberate, and not the one the bead uses. "Unsubmitted" is
 * already taken on the status view, where it means a REGISTERED PR sitting at
 * bay status `pushed` — a merge request that exists and has not been submitted.
 * This module's population is the opposite end: a ref with NO merge request at
 * all, which by construction has no candidate and so cannot be found by looking
 * at candidates. Two populations under one word would have put two disagreeing
 * counts on one dashboard, both correct.
 *
 * P2 of the hardening program. Under push-IS-submit this rail is the backstop —
 * the first version of any admission path will miss cases, and a state nobody
 * can see is the failure this phase exists to delete. But a backstop that cries
 * wolf is deleted by its operators, so the predicate is deliberately narrow.
 *
 * Pure by construction: it consumes facts someone else gathered. Git I/O
 * belongs at the CLI boundary where deterministic facts are already injected,
 * which keeps this judgement testable without a repository and keeps the domain
 * layer free of process calls.
 */

/** One remote ref, with the facts needed to judge whether it is stranded. */
export type PushedRefFact = Readonly<{
  ref: string
  tipSha: string
  /** Clone-local observation/update time of the ref, epoch ms. */
  observedAtMs: number
  /** A carrier (PR) already exists for this ref. */
  carried: boolean
  /** Commits on this ref with no patch-equivalent counterpart on the base. */
  uniqueCommits: number
  /** Commits already applied to the base under a different sha — a regenerated
   * carrier's contribution. Ancestry cannot see these; patch-equivalence can. */
  equivalentCommits: number
  payloadKind: PayloadKind
  pinDirection: PinDirection
  /**
   * Earlier revisions of this ref's series that the sweep collapsed into it —
   * a POPULATION fact, which is why it arrives gathered rather than derived
   * here: one ref name cannot know what else was pushed beside it.
   */
  absorbedRevisions: number
}>

/**
 * What the ref's diff against the base actually consists of.
 *
 * `gitlink-only` matters because commit counts are MEANINGLESS for it: at the
 * superproject level a submodule pointer bump is a unique patch by
 * construction, even when the content behind the pointer already landed or is
 * older than trunk's. Cherry counts pointers, not payload.
 */
export type PayloadKind = "content" | "gitlink-only"

/** A ref name split at the fleet's revision marker: everything before `-rN`,
 * and the digits themselves kept as written. */
export type RefRevision = Readonly<{ stem: string; revision: string }>

/**
 * The revision a ref name DECLARES, under the convention the fleet already
 * writes: `task/<slug>-<seat>-rN`. `-r6` is dead the moment `-r20` exists, and
 * the naming already says so — this rail simply did not read it. Measured
 * 2026-08-14 on the live flagged set: 62 of 129 rows were earlier revisions of
 * a series whose newer revision was flagged too, so half the rail was noise.
 *
 * ANCHORED AT THE END, and deliberately so. `task/21023-auto-restack-agent1-r11-source`
 * and `-r12-currentpin` exist on this remote, where the trailing word names a
 * VARIANT rather than a revision: two refs can share `-r12` and mean different
 * artifacts. Reading a revision out of the middle of a name would collapse
 * those into each other and delete a real row, which is a worse failure than
 * the noise being fixed. Names that do not end in `-rN` are their own series
 * of one and pass through unchanged.
 *
 * No leading zeros: `-r007` is not the convention, and admitting it would put
 * two refs (`-r7`, `-r007`) at the same revision of the same stem with no
 * defined winner. It is a singleton instead.
 */
export function revisionOf(branch: string): RefRevision | undefined {
  const marker = /^(.+)-r([1-9][0-9]*)$/.exec(branch)
  if (marker === null) return undefined
  const [, stem, revision] = marker
  if (stem === undefined || revision === undefined) return undefined
  return { stem, revision }
}

/**
 * Order two revision markers. Compared as digit STRINGS by length then
 * lexicographically, never through `Number`: a ref name may carry an
 * arbitrarily long digit run, and parsing one past 2^53 would silently tie two
 * distinct revisions and suppress the live one. Leading zeros are excluded by
 * `revisionOf`, which is what makes length-first exact.
 */
export function compareRevisions(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Which way this ref's submodule pins move relative to the base.
 *
 * `forward` — the branch pin contains trunk's, a real advance.
 * `aligned` — pins are equal; nothing to carry.
 * `backward` — trunk's pin contains the branch's, so landing it rolls back.
 * `diverged` — neither contains the other; unsafe for the same reason.
 * `none` — the ref touches no gitlinks.
 *
 * Direction is immune to whether loss shows up as an added, deleted or MODIFIED
 * file, which is why it beats counting files: a pin walked backwards usually
 * modifies content back to an older state and deletes nothing at all.
 *
 * CONTRACT FOR WHOEVER GATHERS THIS, and getting it wrong produces confident
 * false alarms — two of us raised one on the same evening. **Compare pins ONLY
 * for gitlinks the branch actually MODIFIES relative to the merge base.** The
 * pin `git ls-tree <branch> <path>` reports is what the branch's tree records,
 * which is NOT what a merge produces: where the branch never touched that path,
 * git's three-way merge keeps trunk's side and the stale recorded pin is
 * irrelevant. Verified with `merge-tree --write-tree` on a branch whose
 * recorded pin was four commits behind trunk's — the merged tree carried
 * TRUNK's pin.
 *
 * Where the branch does modify it divergently, a merge CONFLICTS rather than
 * silently reverting ("Recursive merging with submodules currently only
 * supports trivial cases"), which is loud and recoverable. The silent
 * regression this field exists to catch belongs to a third case: a composer
 * that takes the branch's TREE as authored instead of merging it.
 */
export type PinDirection = "forward" | "aligned" | "backward" | "diverged" | "none"

/**
 * `rescue` — real unlanded work that trunk can safely take.
 * `rebase-required` — carrying this as-is would revert trunk; its author must
 * rebase. Emphatically NOT a rescue: a finding that says "carry this" about a
 * backward pin causes the exact loss the rail exists to prevent.
 */
export type UncarriedVerdict = "rescue" | "rebase-required"

export type UncarriedFinding = Readonly<{
  code: "pushed-not-submitted"
  verdict: UncarriedVerdict
  ref: string
  tipSha: string
  ageMs: number
  uniqueCommits: number
  equivalentCommits: number
  pinDirection: PinDirection
  /** How many earlier revisions of the same series this one row stands for. */
  absorbedRevisions: number
  message: string
}>

export type UncarriedOptions = Readonly<{
  nowMs: number
  /** Grace period before a pushed ref is considered stranded rather than
   * mid-flight. Admission is meant to happen ON the push, so this is small. */
  ttlMs: number
  /** Refs older than this are history, not work. Measured 2026-08-10: 1,502 of
   * 1,546 uncarried refs on origin were older than seven days, so an unbounded
   * rail reports 1,546 rows once and is switched off before it reports again. */
  ageBoundMs: number
}>

/** Whole hours and minutes, so a finding reads like an operator would say it. */
function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`
}

/**
 * Judge one pushed ref. Returns a finding only when every condition holds:
 * no carrier, past the TTL, inside the age bound, and carrying work that has
 * not landed by ANY route.
 *
 * The landedness half is not an optimisation. Measured over the 24-hour window
 * this rail would actually watch, seven of eleven uncarried refs had already
 * landed — six ancestral and one regenerated with all six commits applied.
 * Reporting those is not a smaller problem than missing a stranded branch; it
 * is the problem that kills the rail.
 *
 * Population rule: no verdict from this classifier is actionable unless its
 * validation report names the union of every seat's measured branch set plus
 * every branch authorized for action. A report that omits that population is
 * review-refusable. The one-time P0 proof is the ten-specimen union in
 * `tests/uncarried.test.ts`, including the separately authorized
 * `task/22716-p1a-certification-dev3` branch.
 */
export function classifyPushedRef(fact: PushedRefFact, options: UncarriedOptions): UncarriedFinding | undefined {
  if (fact.carried) return undefined
  // Clock skew between pusher and sweeper must not produce a negative age that
  // silently passes a TTL comparison; a future timestamp is simply not yet due.
  const ageMs = options.nowMs - fact.observedAtMs
  if (ageMs < options.ttlMs) return undefined
  if (ageMs > options.ageBoundMs) return undefined

  // Said on the row, not only in the denominator: an operator reading one
  // finding needs to know it already covers the series, or they go looking for
  // the older revisions to check whether those were missed too.
  const absorbed =
    fact.absorbedRevisions === 0
      ? ""
      : ` — it supersedes ${fact.absorbedRevisions} earlier ${fact.absorbedRevisions === 1 ? "revision" : "revisions"} of the same series, which mint no rows of their own`

  const build = (verdict: UncarriedVerdict, detail: string): UncarriedFinding => ({
    code: "pushed-not-submitted",
    verdict,
    ref: fact.ref,
    tipSha: fact.tipSha,
    ageMs,
    uniqueCommits: fact.uniqueCommits,
    equivalentCommits: fact.equivalentCommits,
    pinDirection: fact.pinDirection,
    absorbedRevisions: fact.absorbedRevisions,
    message: `ref '${fact.ref}' was observed locally ${formatAge(ageMs)} ago and no merge request carries it; ${detail}${absorbed}`,
  })

  // DIVERGED outranks every commit count. Each side holds something the other
  // lacks, so carrying it as-is drops trunk's half however much unlanded work
  // rides along. Reporting "N unlanded commits" about such a ref invites exactly
  // the carry that loses trunk's work.
  if (fact.pinDirection === "diverged") {
    return build(
      "rebase-required",
      "its submodule pin has DIVERGED from trunk's — its author must rebase; carrying it as-is reverts trunk",
    )
  }

  // A pointer bump is a unique patch by construction, so the commit count says
  // nothing here. Only direction distinguishes a real advance from one trunk has
  // already absorbed.
  //
  // `backward` is silence, not a warning, and getting that wrong is how this
  // rail generates its own false alarms: backward means trunk CONTAINS the
  // branch's pin, so there is nothing to carry and nothing to rebase — the work
  // is already home. A sweep that flags every spent carrier as a revert risk
  // reports the whole fleet's history as danger.
  if (fact.payloadKind === "gitlink-only") {
    if (fact.pinDirection !== "forward") return undefined
    return build("rescue", "it advances a submodule pin that trunk does not yet carry")
  }

  // Content payload: landedness decides first. Zero unlanded commits means SPENT
  // — the work integrated, and the queue regenerating the carrier is why the tip
  // is not ancestral. That is not a stranded branch.
  if (fact.uniqueCommits === 0) return undefined

  // Real unlanded content, but the pins would roll back. The content is worth
  // rescuing; THIS BRANCH is not the way to do it.
  if (fact.pinDirection === "backward") {
    return build(
      "rebase-required",
      `${fact.uniqueCommits} unlanded ${fact.uniqueCommits === 1 ? "commit" : "commits"}, but its submodule pin would move BACKWARD — rebase before carrying`,
    )
  }

  const total = fact.uniqueCommits + fact.equivalentCommits
  // The split, never a bare verdict: a partially landed branch told only that
  // it is "unfinished" invites its author to redo the commits that shipped.
  const applied = fact.equivalentCommits === 0 ? "" : `, ${fact.equivalentCommits} of ${total} already applied`
  return build("rescue", `${fact.uniqueCommits} unlanded ${fact.uniqueCommits === 1 ? "commit" : "commits"}${applied}`)
}
