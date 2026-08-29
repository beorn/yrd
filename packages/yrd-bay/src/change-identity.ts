import { createHash } from "node:crypto"
import * as z from "zod"
import { GitRefSchema, GitShaSchema } from "./model.ts"

const CHANGE_ID_DOMAIN = "yrd-change-id-v1\0"
const DERIVED_CHANGE_ID_DOMAIN = "yrd-derived-change-id-v1\0"

export const ChangeIdSchema = z.string().regex(/^I[0-9a-f]{40}$/u)
export type ChangeId = z.infer<typeof ChangeIdSchema>

/** Mint the stable logical change identity from the first accepted command. */
export function changeIdForCommand(commandId: string): ChangeId {
  const canonicalCommandId = z.uuidv7().parse(commandId).toLowerCase()
  return ChangeIdSchema.parse(
    `I${createHash("sha1").update(CHANGE_ID_DOMAIN).update(canonicalCommandId).digest("hex")}`,
  )
}

/**
 * Mint the stable logical change identity for a DERIVED submission whose tip
 * commit carries no `Change-Id` trailer: a pure derivation from the
 * submission's stable facts — branch and tip sha — so every re-derivation of
 * the same push mints the same identity, with no store round-trip. A new sha
 * on the branch is a new revision of the SAME change, but that continuity is
 * the retained `ChangeSnapshot`'s to keep (the identity's one durable home,
 * which admission reuses before ever calling this): this mint only ever names
 * a push no snapshot has recorded yet.
 *
 * The domain string keeps this namespace disjoint from `changeIdForCommand`'s
 * — a command-minted and a submit-minted identity can never collide. Facts
 * are canonicalized (validated + trimmed ref, lowercased full hex sha)
 * because an identity minted from a non-canonical fact would not be stable
 * across re-reads; garbage input throws rather than minting a drifting id.
 */
export function changeIdForDerivedSubmit(input: Readonly<{ branch: string; sha: string }>): ChangeId {
  const branch = GitRefSchema.parse(input.branch)
  const sha = GitShaSchema.parse(input.sha).toLowerCase()
  return ChangeIdSchema.parse(
    `I${createHash("sha1").update(DERIVED_CHANGE_ID_DOMAIN).update(`${branch}\0${sha}`).digest("hex")}`,
  )
}

/** The trailer key a commit carries its change identity on. */
export const CHANGE_ID_TRAILER_KEY = "Change-Id"

/**
 * The individual candidate values behind one
 * `%(trailers:key=Change-Id,valueonly,separator=%x2c)` git read: split on the
 * comma separator, whitespace-trimmed, empties dropped. Shared by the
 * receiver's push-time gate and the CLI's derived-submit enrichment reader so
 * the two can never disagree about what a commit's trailers said.
 */
export function changeIdTrailerCandidates(raw: string): string[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
}

/** The first well-formed Change-Id among the candidates, or undefined when none is. */
export function findChangeId(candidates: readonly string[]): ChangeId | undefined {
  const found = candidates.find((value) => ChangeIdSchema.safeParse(value).success)
  return found === undefined ? undefined : ChangeIdSchema.parse(found)
}

/** Where a settled change identity actually came from. */
export type ChangeIdProvenance = "record" | "snapshot" | "trailer" | "synthetic"

/**
 * A settled identity, or the one reason settling is impossible. Modelled as a
 * discriminated result rather than a throw because the sole refusal is a TYPED
 * queue refusal (`derived-change-id-missing`) whose failure vocabulary lives in
 * `@yrd/core`, one layer above this module: the resolver decides, the caller
 * raises. That split is what lets the receiver adopt this same ladder later
 * without importing the queue's failure machinery.
 */
export type ResolvedChangeIdentity =
  | Readonly<{
      ok: true
      changeId: ChangeId
      provenance: ChangeIdProvenance
      /**
       * An AUTHORITATIVE trailer the tip carries that disagrees with the
       * anchored identity that outranked it — the silent identity split.
       *
       * It is reachable by following the receiver's own printed cure. A
       * trailerless branch admits under a synthetic id, that id anchors in the
       * run's `ChangeSnapshot`, the author then runs the advertised `git commit
       * --amend --no-edit` to stamp a real trailer and re-pushes — and the
       * anchor still wins, correctly (an identity that changed mid-flight would
       * orphan every fact already keyed on it). The commit and the queue now
       * disagree about the change's identity, permanently, and today nothing
       * says so. Surfacing it is not the cure; settling identity ONCE, at the
       * submit fact, is. This field is what lets the divergence be counted
       * before that lands, and asserted against after.
       */
      supersededTrailer?: ChangeId
    }>
  | Readonly<{ ok: false; reason: "non-canonical-submit-facts" }>

/**
 * Settle a derived submission's change identity from every piece of evidence
 * that can carry one, in rank order:
 *
 * 1. `record` — a LIVE change record's own identity. The record lane answers
 *    for the branch; nothing outranks it.
 * 2. `snapshot` — a retained `ChangeSnapshot` for the branch. This is what
 *    makes identity stable across a force-push and a rebase: after birth the
 *    tip sha never re-enters the key, so a branch keeps one identity for its
 *    whole life however its commits are rewritten.
 * 3. `trailer` — the tip commit's `Change-Id`, the author's own declaration.
 * 4. `synthetic` — a birth-time mint from (branch, tip sha). Ranked last and
 *    reachable only at BIRTH, when no anchor exists yet.
 *
 * The sha appears in exactly one arm, and only for a branch nothing has
 * recorded yet. Reading rank 4 as "identity is keyed on the tip sha" inverts
 * the design: it is a seed consumed once, at birth, and anchored by the first
 * journaled snapshot — ranks 1 and 2 are what every later derivation reads.
 */
export function resolveChangeIdentity(
  evidence: Readonly<{
    record?: string | undefined
    snapshot?: string | undefined
    trailer?: string | undefined
    branch: string
    sha: string
  }>,
): ResolvedChangeIdentity {
  const trailer = evidence.trailer === undefined ? undefined : ChangeIdSchema.parse(evidence.trailer)
  const anchored: readonly (readonly [ChangeIdProvenance, string | undefined])[] = [
    ["record", evidence.record],
    ["snapshot", evidence.snapshot],
  ]
  for (const [provenance, value] of anchored) {
    if (value === undefined) continue
    const changeId = ChangeIdSchema.parse(value)
    return trailer !== undefined && trailer !== changeId
      ? { ok: true, changeId, provenance, supersededTrailer: trailer }
      : { ok: true, changeId, provenance }
  }
  if (trailer !== undefined) return { ok: true, changeId: trailer, provenance: "trailer" }
  // Birth. A synthetic identity minted from a non-canonical fact would not be
  // stable across re-derivation, which is the mint's entire contract — so the
  // caller refuses instead of anchoring a drifting id.
  if (!GitRefSchema.safeParse(evidence.branch).success || !GitShaSchema.safeParse(evidence.sha).success) {
    return { ok: false, reason: "non-canonical-submit-facts" }
  }
  return {
    ok: true,
    changeId: changeIdForDerivedSubmit({ branch: evidence.branch, sha: evidence.sha }),
    provenance: "synthetic",
  }
}
