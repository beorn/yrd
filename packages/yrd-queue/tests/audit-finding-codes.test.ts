/**
 * @failure The set of finding codes `yrd queue audit` can emit lived only in the producers' string literals, so every consumer kept its own hand-copied whitelist; a producer gaining a code left those whitelists silently short and the new finding reached no page.
 * @level l1
 * @consumer @yrd/queue
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { YRD_QUEUE_AUDIT_FINDING_CODES, type QueueAuditEmission } from "@yrd/queue"

/** The three producers whose findings `queue audit` concatenates: the core
 * walk in this package, the derived plan audit (git vs journal vs process) in
 * the CLI, and the submodule-alternates census in this package. */
const PRODUCERS = [
  { module: "packages/yrd-queue/src/queue.ts", from: "function auditQueues(", to: "\nfunction latestQueueMergeMs(" },
  { module: "packages/yrd-cli/src/plan-audit.ts", from: "export function installedPlanStale(", to: null },
  {
    module: "packages/yrd-queue/src/alternates-audit.ts",
    from: "export function submoduleAlternatesFindings(",
    to: null,
  },
] as const

const REPOSITORY = fileURLToPath(new URL("../../..", import.meta.url))

/** Scan a producer's own source for its emitted `code: "…"` literals. The
 * closed emission type already makes an unlisted code a compile error, so this
 * reads the other direction: a code listed here that no producer emits is dead
 * whitelist entry, and it also catches an emission smuggled past the type by a
 * cast. Fails loud when the region cannot be located rather than reporting an
 * empty code set. */
function producerRegion(producer: (typeof PRODUCERS)[number]): string {
  const source = readFileSync(`${REPOSITORY}${producer.module}`, "utf8")
  const start = source.indexOf(producer.from)
  if (start < 0) {
    throw new Error(`audit producer region '${producer.from}' is gone from ${producer.module}; re-anchor this test`)
  }
  const end = producer.to === null ? source.length : source.indexOf(producer.to, start)
  if (end < 0) {
    throw new Error(`audit producer region end '${producer.to}' is gone from ${producer.module}; re-anchor this test`)
  }
  return source.slice(start, end)
}

/** The core walk's region — `auditQueues` and every helper it delegates a
 * population walk to, which is what the anchors below bracket. */
function auditRegion(): string {
  const core = PRODUCERS[0]
  if (core === undefined) throw new Error("the core audit producer is gone; re-anchor this test")
  return producerRegion(core)
}

function emittedCodes(producer: (typeof PRODUCERS)[number]): Set<string> {
  const region = producerRegion(producer)
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
    const listed: QueueAuditEmission = { findings: [{ code: "unrecorded-submit", message: "listed" }] }
    expect(listed.findings[0]?.code).toBe("unrecorded-submit")
    // @ts-expect-error A code no consumer whitelists cannot be emitted, inline or otherwise.
    const unlisted: QueueAuditEmission = { findings: [{ code: "invented-code", message: "unlisted" }] }
    expect(unlisted.findings).toHaveLength(1)
  })

  it("computes every audited population from durable state, never from the compose's queue", () => {
    // THE OTHER DIRECTION, and the one the census above structurally cannot
    // see. `emittedCodes` reads SOURCE TEXT, so a producer whose POPULATION is
    // empty still "emits" its `code:` literal and this file stays green while
    // the finding never fires again. That is exactly what S7 did to four codes
    // at once: `auditQueues` asked `admissionQueue(state, steps)` and
    // `queueProgressQueue(state, steps)` for their members, and since
    // branch-is-change a member is MATERIALIZED by the compose — it needs the
    // PR-number mint and a git enrichment read, neither of which a pure audit
    // has. So the audit could only ever pass an empty `derived` and get an
    // empty queue back, and `queue-progress-stalled`, `queue-never-started` and
    // `admission-refusal-loop` (whose head-of-line test read that same queue)
    // went permanently silent with every type fence green.
    //
    // The rule this pins: the audit's populations come from DURABLE state —
    // standing submit facts, retained run snapshots, the refusal ledger, the
    // Job store — so there is no argument a caller can forget to pass and no
    // parameter that defaults to nothing. Naming `admissionQueue` here is not
    // a style rule: it is the one function in this file whose population an
    // audit is structurally unable to obtain.
    const region = auditRegion()
    expect(region).not.toContain("admissionQueue(")
  })

  it("covers exactly what the producers emit", () => {
    const emitted = PRODUCERS.flatMap((producer) => [...emittedCodes(producer)])
    // Both directions: nothing a producer emits is missing from the list (a
    // finding no consumer whitelists), and nothing on the list is unemitted (a
    // whitelist entry kept alive after its producer stopped writing it).
    expect([...new Set(emitted)].toSorted()).toEqual([...YRD_QUEUE_AUDIT_FINDING_CODES].toSorted())
  })
})
