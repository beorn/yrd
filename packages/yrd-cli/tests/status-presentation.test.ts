// @failure Queue watch status surfaces disagree about failure ownership, retry policy, or the running glyph.
// @level l2
// @consumer @yrd/cli

import { describe, expect, it } from "vitest"
import { failureDisposition, statusPresentation } from "../src/status-presentation.ts"

describe("shared queue status presentation", () => {
  it("uses the specified pulsing-disk glyph for running work", () => {
    expect(statusPresentation("running")).toEqual({ glyph: "◉", color: "$fg-info" })
  })

  it.each([
    ["source-publish", "env", "auto-requeue", "queue"],
    ["scratch-cleanup-failed", "env", "auto-requeue", "queue"],
    ["queue-environment-refused", "env", "auto-requeue", "queue"],
    ["job-lost", "timeout", "auto-requeue", "queue"],
    ["stale-base", "stale", "auto-recut", "queue"],
    ["stale-check", "stale", "auto-requeue", "queue"],
    ["stale-steps", "stale", "auto-requeue", "queue"],
    ["stale-plan", "stale", "auto-requeue", "queue"],
    ["stale-pr", "stale", "none", "queue"],
    ["authored-gitlink", "needs-author", "none", "author"],
    ["check-failed", "failed", "none", "author"],
    ["run-canceled", "canceled", "none", "queue"],
  ] as const)("classifies %s once for every watch/log consumer", (code, state, automation, actor) => {
    expect(failureDisposition(code)).toEqual({ state, automation, actor })
  })
})
