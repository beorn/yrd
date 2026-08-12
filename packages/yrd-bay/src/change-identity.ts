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
