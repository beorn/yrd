/**
 * Is a failed setup's output the shape of an UNREACHABLE REMOTE, or of a
 * repository that is actually broken? (@i/10-yrd/24486 rows 2 and 3.)
 *
 * The two need different words because they need different people. A 504 from
 * a code host while setup resolved one pinned dependency is nobody's defect and
 * clears itself; a lockfile that does not match its manifest is a change that
 * must not merge. Both arrive today as `yrd-setup-unusable`, so a reader of the
 * record cannot tell an outage from a break, and the fleet's whole delivery
 * mechanism stops on either. Measured 2026-09-11: one GitHub 504 cost 19m47s.
 *
 * THE DISTINCTION THIS MODULE MUST NOT BLUR, and the reason it is a table of
 * named signatures rather than a regex over "5\\d\\d": a remote that ANSWERED
 * and simply does not hold what was asked for is not a transport fault. Yrd
 * already learned this one layer up — a gitlink 404 is a component commit that
 * never left somebody's bay, and stopping the queue for it bills the queue for
 * a submitter's mistake. So 4xx is a break, 5xx and 429 are transport, and the
 * codes are matched only where an HTTP response actually puts them.
 *
 * Pure and text-only: no clock, no filesystem, no network. It classifies a
 * string the caller already has.
 */

/** The reason a setup stuck on something no change can fix. */
export const SETUP_UNREACHABLE_CODE = "yrd-setup-unreachable"

/** The reason a setup stuck on the repository's own state. */
export const SETUP_UNUSABLE_CODE = "yrd-setup-unusable"

export type TransportFault = Readonly<{
  /** Which signature matched, so the record says what was seen and not merely "transport". */
  signature: string
  /** The line it matched on, trimmed and bounded — evidence, not a log. */
  line: string
}>

/** Bound on the evidence line a record carries. A record is not a log. */
const MAX_LINE = 300

/**
 * Signatures of a remote that could not be reached or could not answer.
 *
 * Each is deliberately narrow and named. A broad pattern here does not fail
 * loudly — it quietly reclassifies real breaks as outages and retries them
 * forever, which is worse than the defect being fixed.
 */
const TRANSPORT_SIGNATURES: readonly Readonly<{ signature: string; pattern: RegExp }>[] = [
  // The measured specimen: `error: GET https://api.github.com/... - 504`.
  // Anchored on a URL so a version string or a byte count can never match.
  { signature: "http-5xx", pattern: /https?:\/\/\S+\s+-\s+(?:50\d|5[1-9]\d)\b/u },
  { signature: "http-5xx", pattern: /\b(?:HTTP|status(?: code)?)[\s:]+(?:5\d\d)\b/iu },
  // Rate limiting is transport-shaped: the remote is up, refusing right now,
  // and the next round is the cure. Every OTHER 4xx is an answer, not a fault.
  { signature: "rate-limited", pattern: /https?:\/\/\S+\s+-\s+429\b/u },
  { signature: "rate-limited", pattern: /\b(?:HTTP|status(?: code)?)[\s:]+429\b/iu },
  { signature: "rate-limited", pattern: /\bToo Many Requests\b/iu },
  { signature: "dns", pattern: /\bCould not resolve host\b/iu },
  { signature: "dns", pattern: /\bTemporary failure in name resolution\b/iu },
  { signature: "dns", pattern: /\bEAI_AGAIN\b/u },
  { signature: "dns", pattern: /\bENOTFOUND\b/u },
  { signature: "connect", pattern: /\bECONNREFUSED\b/u },
  { signature: "connect", pattern: /\bConnection refused\b/iu },
  { signature: "connect", pattern: /\bNetwork is unreachable\b/iu },
  { signature: "connect", pattern: /\bNo route to host\b/iu },
  { signature: "reset", pattern: /\bECONNRESET\b/u },
  { signature: "reset", pattern: /\bConnection reset by peer\b/iu },
  { signature: "timeout", pattern: /\bETIMEDOUT\b/u },
  { signature: "timeout", pattern: /\b(?:Connection|Operation) timed out\b/iu },
  { signature: "timeout", pattern: /\bTLS handshake timeout\b/iu },
  { signature: "timeout", pattern: /\btimeout was reached\b/iu },
]

/**
 * The first transport signature in `text`, or `undefined` when nothing in it
 * looks like an unreachable remote.
 *
 * `undefined` is the DEFAULT and the safe answer: an unrecognised failure is a
 * break, halts at once, and is billed the way it always was. Only a positive,
 * named match earns the softer treatment.
 */
export function transportFaultIn(text: string): TransportFault | undefined {
  for (const line of text.split("\n")) {
    for (const { signature, pattern } of TRANSPORT_SIGNATURES) {
      if (pattern.test(line)) return { signature, line: line.trim().slice(0, MAX_LINE) }
    }
  }
  return undefined
}

/** The record reason for a setup failure: transport-shaped, or the repository's. */
export function setupStuckCode(fault: TransportFault | undefined): string {
  return fault === undefined ? SETUP_UNUSABLE_CODE : SETUP_UNREACHABLE_CODE
}

/**
 * What clears this, said to a person reading the record.
 *
 * A transport fault names no branch and no author on purpose: nothing about the
 * change is wrong, and telling a submitter to repair their work would send them
 * looking for a defect that is not there.
 */
export function setupStuckNext(fault: TransportFault | undefined): string {
  if (fault === undefined) return "repair the queue setup, then run yrd queue run"
  return (
    `nothing here is the change's fault: setup could not reach a remote (${fault.signature}). ` +
    "The next round retries on the queue's own cadence; repair the remote or wait it out."
  )
}
