/**
 * @failure `PRIdSchema` was `z.string().trim().min(1)`, so `QueueMemberIdSchema`'s union of PR ids and intent ids decided nothing: every intent id parsed as a change id, the intent arm was dead code as a parser, and a mis-kinded member id failed later — or never — instead of at the schema.
 * @level l0
 * @consumer @yrd/queue
 */
import { describe, expect, it } from "vitest"
import { PRIdSchema } from "@yrd/bay"
import { CandidateChangeSchema, IntentRecordIdSchema, MergeRecordChangeSchema, QueueMemberIdSchema } from "@yrd/queue"

/**
 * Drawn from the live journal (39,254 history frames plus the snapshot prefix
 * and checkpoint, read 2026-08-13): 943 distinct PR ids running PR1..PR943,
 * and 181 distinct intent ids running I1..I163 then yrdpin#164..yrdpin#181 —
 * one continuous counter across the `yrdpin#` cutover. Every one of the 70,309
 * id occurrences parses under the tightened schemas and none is refused, which
 * is what makes this a tightening to the shape of real data rather than to an
 * aspiration.
 */
const REAL_PR_IDS = ["PR1", "PR182", "PR908", "PR913", "PR943"] as const
const REAL_LEGACY_INTENT_IDS = ["I1", "I7", "I148", "I163"] as const
const REAL_PIN_INTENT_IDS = ["yrdpin#164", "yrdpin#170", "yrdpin#181"] as const
const REAL_INTENT_IDS = [...REAL_LEGACY_INTENT_IDS, ...REAL_PIN_INTENT_IDS]
const MINTED_MEMBER_ID_CASES = [
  { kind: "change", ids: REAL_PR_IDS, asPR: true, asIntent: false },
  { kind: "legacy intent", ids: REAL_LEGACY_INTENT_IDS, asPR: false, asIntent: true },
  { kind: "pin intent", ids: REAL_PIN_INTENT_IDS, asPR: false, asIntent: true },
] as const

/** Forms Yrd renders or an operator types. None is an id, and the journal only
 * ever holds them in `command.args`, which is `TextSchema` on purpose. */
const SELECTORS_AND_DISPLAY_FORMS = [
  "pr#182.1",
  "pr#908",
  "182",
  "908",
  "task/pr-submit-deps-admission-final-dev5",
  "PR",
  "PRabc",
  "PR-target",
  "pr1",
  " PR1 ",
  "",
] as const

describe("queue member ids discriminate", () => {
  it.each(MINTED_MEMBER_ID_CASES)("parses every minted $kind id through exactly its own arm", (idCase) => {
    // Under the old `min(1)` change-id schema, both intent rows also parsed as
    // PR ids, so the first union arm always won.
    // A union whose arms overlap still decides nothing useful: the first match
    // wins and the kind becomes an accident of arm order.
    for (const id of idCase.ids) {
      expect(PRIdSchema.safeParse(id).success, `${id} change arm`).toBe(idCase.asPR)
      expect(IntentRecordIdSchema.safeParse(id).success, `${id} intent arm`).toBe(idCase.asIntent)
      expect(QueueMemberIdSchema.safeParse(id).success, `${id} union`).toBe(true)
    }
  })

  it("refuses the display forms and operator selectors that are not ids", () => {
    for (const value of SELECTORS_AND_DISPLAY_FORMS) {
      expect(QueueMemberIdSchema.safeParse(value).success, `'${value}' is not a member id`).toBe(false)
    }
  })

  it("carries a merged intent at the change positions that record a queue member", () => {
    // `command.ts` fills both of these from the member's own `id`, so an intent
    // that merges writes its intent id here. They must be member positions, not
    // PR positions, or the tightened PR arm would refuse a real merge.
    const change = {
      changeId: `I${"a".repeat(40)}`,
      revision: 1,
      submittedHead: "0".repeat(40),
      generatedCommit: "1".repeat(40),
    }
    for (const id of [...REAL_PR_IDS, ...REAL_INTENT_IDS]) {
      expect(CandidateChangeSchema.safeParse({ ...change, pr: id }).success, `candidate change must carry ${id}`).toBe(
        true,
      )
      expect(
        MergeRecordChangeSchema.safeParse({ ...change, pr: id }).success,
        `merge record change must carry ${id}`,
      ).toBe(true)
    }
    expect(CandidateChangeSchema.safeParse({ ...change, pr: "pr#182.1" }).success).toBe(false)
    expect(MergeRecordChangeSchema.safeParse({ ...change, pr: "pr#182.1" }).success).toBe(false)
  })
})
