/**
 * Pushed-not-submitted: deciding whether a ref that reached the remote and
 * never became a carrier is genuinely stranded.
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
  /** Commit time of the ref tip, epoch ms. */
  pushedAtMs: number
  /** A carrier (PR) already exists for this ref. */
  carried: boolean
  /** Commits on this ref with no patch-equivalent counterpart on the base. */
  uniqueCommits: number
  /** Commits already applied to the base under a different sha — a regenerated
   * carrier's contribution. Ancestry cannot see these; patch-equivalence can. */
  equivalentCommits: number
}>

export type UnsubmittedFinding = Readonly<{
  code: "pushed-not-submitted"
  ref: string
  tipSha: string
  ageMs: number
  uniqueCommits: number
  equivalentCommits: number
  message: string
}>

export type UnsubmittedOptions = Readonly<{
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
 */
export function classifyPushedRef(fact: PushedRefFact, options: UnsubmittedOptions): UnsubmittedFinding | undefined {
  if (fact.carried) return undefined
  // Clock skew between pusher and sweeper must not produce a negative age that
  // silently passes a TTL comparison; a future timestamp is simply not yet due.
  const ageMs = options.nowMs - fact.pushedAtMs
  if (ageMs < options.ttlMs) return undefined
  if (ageMs > options.ageBoundMs) return undefined
  if (fact.uniqueCommits === 0) return undefined

  const total = fact.uniqueCommits + fact.equivalentCommits
  // The split, never a bare verdict: a partially landed branch told only that
  // it is "unfinished" invites its author to redo the commits that shipped.
  const applied = fact.equivalentCommits === 0 ? "" : `, ${fact.equivalentCommits} of ${total} already applied`
  return {
    code: "pushed-not-submitted",
    ref: fact.ref,
    tipSha: fact.tipSha,
    ageMs,
    uniqueCommits: fact.uniqueCommits,
    equivalentCommits: fact.equivalentCommits,
    message:
      `ref '${fact.ref}' was pushed ${formatAge(ageMs)} ago and no merge request carries it; ` +
      `${fact.uniqueCommits} unlanded ${fact.uniqueCommits === 1 ? "commit" : "commits"}${applied}`,
  }
}
