/**
 * @failure  A new `Record:` kind or journal decision ships, and every reader already running freezes on its
 *           first use: `tipRecord` throws on a kind it does not know, and the journal fold refuses a decision it
 *           does not know. Measured 2026-09-16: a `yrd watch` built before `withdrawn` (24492) threw on the first
 *           withdrawn record and showed RUNNER SILENT for 1h26m while the runner was healthy (@i/10-yrd/24735).
 * @level    l1 (the two vocabulary constants, no I/O)
 * @consumer every reader of change records and run journals: watch, list, show, queue health
 *
 * Trailers and fields are the safe way to add meaning, because readers ignore the ones they do not know. These
 * two lists change only on purpose: whoever edits one edits this test in the same change, and either ships the
 * reader that survives the new word first (@i/10-yrd/24735) or accepts that every older running reader freezes.
 */

import { describe, expect, test } from "vitest"

import { TERMINAL_DECISIONS } from "../src/log.ts"
import { RECORD_KINDS } from "../src/records.ts"

describe("the record and decision vocabularies are pinned (a new word freezes every older running reader)", () => {
  test("the Record: kinds are exactly these eight", () => {
    expect([...RECORD_KINDS]).toEqual([
      "opened",
      "checked",
      "merged",
      "failed",
      "stuck",
      "withdrawn",
      "sent",
      "deferred",
    ])
  })

  test("the journal's change decisions are exactly these five", () => {
    expect([...TERMINAL_DECISIONS].sort()).toEqual(["checked", "failed", "merged", "stuck", "withdrawn"])
  })
})
