// @failure Queue watch status surfaces disagree about failure ownership, retry policy, or the running glyph.
// @level l2
// @consumer @yrd/cli

import { describe, expect, it } from "vitest"
import {
  failureDisposition,
  lifecyclePresentation,
  lifecycleStatus,
  statusPresentation,
} from "../src/status-presentation.ts"

describe("shared queue-state presentation", () => {
  it("projects bay and queue states through one open/working/done/fail vocabulary", () => {
    expect([
      lifecycleStatus("active"),
      lifecycleStatus("opening"),
      lifecycleStatus("closed"),
      lifecycleStatus("failed"),
    ]).toEqual(["open", "working", "done", "fail"])

    expect(lifecyclePresentation("active")).toEqual({ glyph: "○", color: "$fg-accent" })
    expect(lifecyclePresentation("opening")).toEqual({ glyph: "◉", color: "$fg-info" })
    expect(lifecyclePresentation("closed")).toEqual({ glyph: "✓", color: "$fg-success" })
    expect(lifecyclePresentation("failed")).toEqual({ glyph: "×", color: "$fg-error" })

    expect(statusPresentation("queued")).toEqual(lifecyclePresentation("open"))
    expect(statusPresentation("running")).toEqual(lifecyclePresentation("working"))
    expect(statusPresentation("done")).toEqual(lifecyclePresentation("done"))
    expect(statusPresentation("failed")).toEqual(lifecyclePresentation("fail"))
  })

  it("uses the specified pulsing-disk glyph for running work", () => {
    expect(statusPresentation("running")).toEqual({ glyph: "◉", color: "$fg-info" })
    expect(statusPresentation("already-landed")).toEqual({ glyph: "✓", color: "$fg-success" })
  })

  it.each([
    ["source-publish", "env", "auto-requeue", "queue"],
    ["scratch-cleanup-failed", "env", "auto-requeue", "queue"],
    ["queue-environment-refused", "env", "auto-requeue", "queue"],
    ["job-lost", "timeout", "auto-requeue", "queue"],
    ["stale-base", "stale", "auto-re-merge", "queue"],
    ["stale-check", "stale", "auto-requeue", "queue"],
    ["stale-steps", "stale", "auto-requeue", "queue"],
    ["stale-plan", "stale", "auto-requeue", "queue"],
    ["stale-pr", "stale", "none", "queue"],
    ["authored-gitlink", "needs-author", "none", "author"],
    ["check-failed", "failed", "none", "author"],
    ["run-canceled", "canceled", "none", "queue"],
    // The `plain-rejected` bucket, which failureDisposition did not read: its
    // members silently took the author default, which is exactly the routing
    // the bucket's own contract forbids ("no author-blame routing and no
    // auto-retry; the operator re-evaluates").
    ["intent-base-moved", "failed", "none", "queue"],
    ["intent-batch-refused", "failed", "none", "queue"],
    ["intent-component-unknown", "failed", "none", "queue"],
  ] as const)("classifies %s once for every watch/log consumer", (code, state, automation, owner) => {
    expect(failureDisposition(code)).toEqual({ state, automation, owner })
  })

  // The measured defect this vocabulary exists for: a certificate is minted by
  // a CHECK run and never by the author's branch, so billing the author is a
  // refusal naming the wrong party. It sat in no composition bucket at all, so
  // `failureDisposition` fell through to `{ failed, none, author }` and
  // consumed a submit authority for an operator's certificate.
  it.each(["checkpoint-migration-certificate-missing", "checkpoint-migration-certificate-stale"])(
    "never bills the author for %s, an operator-owned certificate",
    (code) => {
      expect(failureDisposition(code)).toEqual({ state: "failed", automation: "none", owner: "queue" })
    },
  )
})
