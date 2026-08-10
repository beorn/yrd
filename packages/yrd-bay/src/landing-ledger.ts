import * as z from "zod"
import { GitShaSchema } from "./model.ts"

const OneLineSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !/[\r\n]/u.test(value), { message: "must fit in one Git trailer line" })

export const LandingIdentitySchema = z
  .object({
    changeId: z.uuidv7(),
    pr: OneLineSchema,
    revision: z.number().int().positive(),
    headSha: GitShaSchema,
    base: OneLineSchema,
    run: OneLineSchema,
  })
  .strict()
  .readonly()

export type LandingIdentity = Readonly<z.infer<typeof LandingIdentitySchema>>

const MANAGED_TRAILER = /^Yrd-(?:Change-Id|PR|Revision|Submitted-Head|Base|Run):/mu

/** Attach the repository-rebuild identity before checks run. The caller owns
 * commit construction; this function owns the ONE canonical trailer spelling
 * shared by Candidate creation and the landing-index reader. */
export function renderLandingCommitMessage(message: string, value: LandingIdentity): string {
  const identity = LandingIdentitySchema.parse(value)
  const body = message.trimEnd()
  if (body === "") throw new TypeError("yrd: landing commit message must not be empty")
  if (MANAGED_TRAILER.test(body)) {
    throw new TypeError("yrd: landing commit message already contains a Yrd landing trailer")
  }
  return [
    body,
    "",
    `Yrd-Change-Id: ${identity.changeId}`,
    `Yrd-PR: ${identity.pr}`,
    `Yrd-Revision: ${String(identity.revision)}`,
    `Yrd-Submitted-Head: ${identity.headSha}`,
    `Yrd-Base: ${identity.base}`,
    `Yrd-Run: ${identity.run}`,
  ].join("\n")
}
