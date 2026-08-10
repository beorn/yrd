import * as z from "zod"
import { GitShaSchema } from "./model.ts"

const OneLineSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), { message: "must fit in one Git trailer line" })

const SubmittedChangeIdentityObjectSchema = z
  .object({
    changeId: z.uuidv7(),
    pr: OneLineSchema,
    revision: z.number().int().positive(),
    headSha: GitShaSchema,
    base: OneLineSchema,
  })
  .strict()

export const SubmittedChangeIdentitySchema = SubmittedChangeIdentityObjectSchema.readonly()
export type SubmittedChangeIdentity = Readonly<z.infer<typeof SubmittedChangeIdentitySchema>>

const LandingIdentityObjectSchema = SubmittedChangeIdentityObjectSchema.extend({ run: OneLineSchema }).strict()
export const LandingIdentitySchema = LandingIdentityObjectSchema.readonly()

export type LandingIdentity = Readonly<z.infer<typeof LandingIdentitySchema>>

export const RepositoryLandingSchema = LandingIdentityObjectSchema.extend({ landingSha: GitShaSchema })
  .strict()
  .readonly()
export type RepositoryLanding = Readonly<z.infer<typeof RepositoryLandingSchema>>

export type LandingIndexVerdict =
  | Readonly<{ status: "proven"; source: "index"; landing: RepositoryLanding }>
  | Readonly<{
      status: "proven"
      source: "repository"
      landing: RepositoryLanding
      indexGap: true
    }>
  | Readonly<{ status: "not-proven"; reason: "repository-identity-absent" }>
  | Readonly<{
      status: "corrupt"
      reason: "duplicate-repository-identity"
      landings: readonly RepositoryLanding[]
    }>
  | Readonly<{
      status: "corrupt"
      reason: "repository-identity-mismatch"
      landing: RepositoryLanding
    }>
  | Readonly<{
      status: "corrupt"
      reason: "index-identity-mismatch" | "index-landing-not-on-base"
      indexed: RepositoryLanding
    }>
  | Readonly<{
      status: "corrupt"
      reason: "index-landing-mismatch"
      indexed: RepositoryLanding
      repository: RepositoryLanding
    }>

function sameSubmittedIdentity(left: SubmittedChangeIdentity, right: SubmittedChangeIdentity): boolean {
  return (
    left.changeId === right.changeId &&
    left.pr === right.pr &&
    left.revision === right.revision &&
    left.headSha === right.headSha &&
    left.base === right.base
  )
}

/** Join the rebuildable index to repository truth. `repositoryLandings` must
 * come from the already-resolved live base; an unreadable scan throws before
 * this pure decision and therefore remains UNKNOWN at the caller boundary. */
export function reconcileLandingIndex(
  expectedValue: SubmittedChangeIdentity,
  indexedValue: RepositoryLanding | undefined,
  repositoryLandings: readonly RepositoryLanding[],
): LandingIndexVerdict {
  const expected = SubmittedChangeIdentitySchema.parse(expectedValue)
  const matching = repositoryLandings
    .map((landing) => RepositoryLandingSchema.parse(landing))
    .filter((landing) => landing.changeId === expected.changeId)
  if (matching.length > 1) {
    return { status: "corrupt", reason: "duplicate-repository-identity", landings: matching }
  }
  const repository = matching[0]
  if (repository !== undefined && !sameSubmittedIdentity(repository, expected)) {
    return { status: "corrupt", reason: "repository-identity-mismatch", landing: repository }
  }

  if (indexedValue === undefined) {
    return repository === undefined
      ? { status: "not-proven", reason: "repository-identity-absent" }
      : { status: "proven", source: "repository", landing: repository, indexGap: true }
  }

  const indexed = RepositoryLandingSchema.parse(indexedValue)
  if (!sameSubmittedIdentity(indexed, expected)) {
    return { status: "corrupt", reason: "index-identity-mismatch", indexed }
  }
  if (repository === undefined) {
    return { status: "corrupt", reason: "index-landing-not-on-base", indexed }
  }
  if (indexed.landingSha !== repository.landingSha || indexed.run !== repository.run) {
    return { status: "corrupt", reason: "index-landing-mismatch", indexed, repository }
  }
  return { status: "proven", source: "index", landing: repository }
}

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
