/**
 * @failure The set of finding codes `yrd queue audit` can emit lived only in the producers' string literals, so every consumer kept its own hand-copied whitelist; a producer gaining a code left those whitelists silently short and the new finding reached no page.
 * @level l1
 * @consumer @yrd/queue
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { YRD_QUEUE_AUDIT_FINDING_CODES, type QueueAuditEmission } from "@yrd/queue"

/** The two producers whose findings `queue audit` concatenates: the core walk
 * in this package, and the derived plan audit (git vs journal vs process) in
 * the CLI. */
const PRODUCERS = [
  { module: "packages/yrd-queue/src/queue.ts", from: "function auditQueues(", to: "\nfunction latestQueueMergeMs(" },
  { module: "packages/yrd-cli/src/plan-audit.ts", from: "export function installedPlanStale(", to: null },
] as const

const REPOSITORY = fileURLToPath(new URL("../../..", import.meta.url))

/** Scan a producer's own source for its emitted `code: "…"` literals. The
 * closed emission type already makes an unlisted code a compile error, so this
 * reads the other direction: a code listed here that no producer emits is dead
 * whitelist entry, and it also catches an emission smuggled past the type by a
 * cast. Fails loud when the region cannot be located rather than reporting an
 * empty code set. */
function emittedCodes(producer: (typeof PRODUCERS)[number]): Set<string> {
  const source = readFileSync(`${REPOSITORY}${producer.module}`, "utf8")
  const start = source.indexOf(producer.from)
  if (start < 0) {
    throw new Error(`audit producer region '${producer.from}' is gone from ${producer.module}; re-anchor this test`)
  }
  const end = producer.to === null ? source.length : source.indexOf(producer.to, start)
  if (end < 0) {
    throw new Error(`audit producer region end '${producer.to}' is gone from ${producer.module}; re-anchor this test`)
  }
  const region = source.slice(start, end)
  const codes = new Set([...region.matchAll(/^\s*code: "([a-z][a-z0-9-]*)",$/gmu)].map((match) => match[1] ?? ""))
  if (codes.size === 0) throw new Error(`no finding codes found in ${producer.module}; re-anchor this test`)
  return codes
}

describe("queue audit finding codes", () => {
  it("is one authoritative list with no duplicates", () => {
    expect(new Set(YRD_QUEUE_AUDIT_FINDING_CODES).size).toBe(YRD_QUEUE_AUDIT_FINDING_CODES.length)
  })

  it("makes an unlisted code a compile error at the producer BOUNDARY, not just inside it", () => {
    // The hole this closes: a producer typed with the open reader result gets
    // its local findings array checked, but a finding written straight into the
    // returned object literal widens on the way out and type-checks with any
    // string. Both producers now return QueueAuditEmission, so the closure
    // survives the return — which is what the two annotations below assert.
    const listed: QueueAuditEmission = { findings: [{ code: "draft-stranded", message: "listed" }] }
    expect(listed.findings[0]?.code).toBe("draft-stranded")
    // @ts-expect-error A code no consumer whitelists cannot be emitted, inline or otherwise.
    const unlisted: QueueAuditEmission = { findings: [{ code: "invented-code", message: "unlisted" }] }
    expect(unlisted.findings).toHaveLength(1)
  })

  it("covers exactly what the producers emit", () => {
    const emitted = PRODUCERS.flatMap((producer) => [...emittedCodes(producer)])
    // Both directions: nothing a producer emits is missing from the list (a
    // finding no consumer whitelists), and nothing on the list is unemitted (a
    // whitelist entry kept alive after its producer stopped writing it).
    expect([...new Set(emitted)].toSorted()).toEqual([...YRD_QUEUE_AUDIT_FINDING_CODES].toSorted())
  })
})
