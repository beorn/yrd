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
