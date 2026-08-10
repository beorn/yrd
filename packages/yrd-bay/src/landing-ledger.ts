import * as z from "zod"
import { GitShaSchema } from "./model.ts"

const OneLineSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), { message: "must fit in one Git trailer line" })

const LandingIdentityObjectSchema = z
  .object({
    changeId: z.uuidv7(),
    pr: OneLineSchema,
    revision: z.number().int().positive(),
    headSha: GitShaSchema,
    base: OneLineSchema,
    run: OneLineSchema,
  })
  .strict()

export const LandingIdentitySchema = LandingIdentityObjectSchema.readonly()

export type LandingIdentity = Readonly<z.infer<typeof LandingIdentitySchema>>

export const RepositoryLandingSchema = LandingIdentityObjectSchema.extend({ landingSha: GitShaSchema })
  .strict()
  .readonly()
export type RepositoryLanding = Readonly<z.infer<typeof RepositoryLandingSchema>>

const FIELD_SEPARATOR = "\u001f"
const RECORD_SEPARATOR = "\u001e"

/** One Git-owned parse for repository rebuilds. Values are separated with
 * control bytes forbidden by LandingIdentitySchema, so no authored value can
 * manufacture another field or record. */
export const LANDING_LOG_FORMAT =
  [
    "%H",
    "%(trailers:key=Yrd-Change-Id,valueonly,separator=%x1d)",
    "%(trailers:key=Yrd-PR,valueonly,separator=%x1d)",
    "%(trailers:key=Yrd-Revision,valueonly,separator=%x1d)",
    "%(trailers:key=Yrd-Submitted-Head,valueonly,separator=%x1d)",
    "%(trailers:key=Yrd-Base,valueonly,separator=%x1d)",
    "%(trailers:key=Yrd-Run,valueonly,separator=%x1d)",
  ].join("%x1f") + "%x1e"

/** Decode only Git's `%(trailers)` output. An unstamped commit is ignored;
 * any partial or duplicated Yrd identity fails the whole read. */
export function parseLandingLog(raw: string): readonly RepositoryLanding[] {
  const landings: RepositoryLanding[] = []
  for (const untrimmed of raw.split(RECORD_SEPARATOR)) {
    const record = untrimmed.replace(/^(?:\r?\n)+/u, "").trimEnd()
    if (record === "") continue
    const fields = record.split(FIELD_SEPARATOR)
    if (fields.length !== 7) throw new Error("yrd: Git landing trailer record has the wrong field count")
    const [landingSha, changeId, pr, revision, headSha, base, run] = fields
    if ([changeId, pr, revision, headSha, base, run].every((value) => value === "")) continue
    landings.push(
      RepositoryLandingSchema.parse({
        landingSha,
        changeId,
        pr,
        revision: Number(revision),
        headSha,
        base,
        run,
      }),
    )
  }
  return landings
}

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
