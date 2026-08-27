import { createHash } from "node:crypto"
import * as z from "zod"

const CHANGE_ID_DOMAIN = "yrd-change-id-v1\0"

export const ChangeIdSchema = z.string().regex(/^I[0-9a-f]{40}$/u)
export type ChangeId = z.infer<typeof ChangeIdSchema>

/** Mint the stable logical change identity from the first accepted command. */
export function changeIdForCommand(commandId: string): ChangeId {
  const canonicalCommandId = z.uuidv7().parse(commandId).toLowerCase()
  return ChangeIdSchema.parse(
    `I${createHash("sha1").update(CHANGE_ID_DOMAIN).update(canonicalCommandId).digest("hex")}`,
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
