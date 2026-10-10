// @failure A journal record kind is added, removed or renamed without this pin announcing it, so a
// new kind ships silently: writers emit rows no reader was told about, and nothing reddens.
// @level l1 (a declared vocabulary; no I/O)
// @consumer yrd watch (unknown-kind reporting), every journal reader, the queue runner

import { describe, expect, it } from "vitest"
import { LOG_KINDS } from "../src/index.ts"

describe("the journal record-kind vocabulary", () => {
  it("is pinned by value, so adding a kind reddens this test", () => {
    expect(LOG_KINDS).toEqual([
      "run",
      "run-number",
      "queue",
      "pause",
      "change",
      "check",
      "result",
      "settle",
      "recut",
      "publish",
      "merge",
      "message",
      "merged-direct",
      "reap",
      "orphan",
      "git",
      "judged",
      "retained",
      "observation",
      "reference",
      "warning",
      "narrowing",
      "descent",
      "discarded",
      "step",
      "skipped",
      "override",
      "branch-deleted",
      "branch-kept",
      "notice-unrecorded",
      "remote-calls",
    ])
  })
})
