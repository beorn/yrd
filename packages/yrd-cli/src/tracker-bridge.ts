import type { DeepReadonly, JournalStamp } from "@yrd/core"
import { GitShaSchema, type PR } from "@yrd/bay"
import * as z from "zod"

const TrackerIssueRefSchema = z.string().trim().min(1)
const TrackerPRStatusSchema = z.enum(["pushed", "submitted", "rejected", "integrated", "withdrawn"])

const TrackerDeliveryBaseSchema = z
  .object({
    pr: z.string().trim().min(1),
    issueRef: TrackerIssueRefSchema,
    revision: z.number().int().positive(),
    status: TrackerPRStatusSchema,
    at: z.iso.datetime({ offset: true }),
    detail: z.string().min(1).optional(),
  })
  .strict()

export const TrackerDeliverySchema = z.discriminatedUnion("status", [
  TrackerDeliveryBaseSchema.extend({ status: z.literal("pushed") }).strict(),
  TrackerDeliveryBaseSchema.extend({ status: z.literal("submitted") }).strict(),
  TrackerDeliveryBaseSchema.extend({ status: z.literal("rejected") }).strict(),
  TrackerDeliveryBaseSchema.extend({ status: z.literal("integrated"), landingSha: GitShaSchema }).strict(),
  TrackerDeliveryBaseSchema.extend({ status: z.literal("withdrawn") }).strict(),
])
export type TrackerDelivery = z.infer<typeof TrackerDeliverySchema>

export const TrackerBridgeSnapshotSchema = z
  .object({
    version: z.literal(1),
    asOf: z
      .object({
        cursor: z.number().int().nonnegative(),
        at: z.iso.datetime({ offset: true }).optional(),
      })
      .strict(),
    deliveries: z.array(TrackerDeliverySchema),
  })
  .strict()
export type TrackerBridgeSnapshot = z.infer<typeof TrackerBridgeSnapshotSchema>

function transitionAt(pr: DeepReadonly<PR>): string {
  const pushedAt = pr.revisions.findLast((revision) => revision.revision === pr.revision)?.pushedAt
  const at =
    pr.status === "submitted"
      ? pr.submittedAt
      : pr.status === "rejected"
        ? pr.rejectedAt
        : pr.status === "integrated"
          ? pr.integratedAt
          : pr.status === "withdrawn"
            ? pr.withdrawnAt
            : pushedAt
  if (at === undefined) throw new Error(`yrd: PR '${pr.id}' ${pr.status} transition has no timestamp`)
  return at
}

function trackerDelivery(pr: DeepReadonly<PR>): TrackerDelivery | undefined {
  if (pr.issue === undefined) return undefined
  const base = {
    pr: pr.id,
    issueRef: pr.issue,
    revision: pr.revision,
    status: pr.status,
    at: transitionAt(pr),
    ...(pr.detail === undefined || pr.detail.length === 0 ? {} : { detail: pr.detail }),
  }
  if (pr.status !== "integrated") return TrackerDeliverySchema.parse(base)
  const landingSha = pr.integration?.commit
  if (landingSha === undefined) throw new Error(`yrd: integrated PR '${pr.id}' has no landing SHA`)
  return TrackerDeliverySchema.parse({ ...base, landingSha })
}

/** Stable tracker-neutral snapshot projected from the journal-owned PR state. */
export function trackerBridgeSnapshot(prs: readonly DeepReadonly<PR>[], asOf: JournalStamp): TrackerBridgeSnapshot {
  const deliveries = prs
    .map(trackerDelivery)
    .filter((delivery): delivery is TrackerDelivery => delivery !== undefined)
    .toSorted(
      (left, right) =>
        left.issueRef.localeCompare(right.issueRef) ||
        left.pr.localeCompare(right.pr, undefined, { numeric: true }) ||
        left.revision - right.revision,
    )
  return TrackerBridgeSnapshotSchema.parse({ version: 1, asOf, deliveries })
}
