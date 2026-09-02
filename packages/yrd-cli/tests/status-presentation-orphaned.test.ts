/**
 * @failure A running row whose holder was dead had no word of its own: every
 *          reader printed `checking` (@i/10-yrd/24030). The `orphaned-run`
 *          code the settlement writes needs one presentation state so the
 *          list row, the detail pane and the audit agree on the word.
 * @level l1
 * @consumer @yrd/cli status-presentation
 */
import { describe, expect, it } from "vitest"
import {
  failureDisposition,
  hasStatusPresentation,
  lifecycleStatus,
  statusPresentation,
  statusPresentationState,
} from "../src/status-presentation.ts"

describe("the orphaned presentation state (24030)", () => {
  it("is a known state, aliased from the orphaned-run code, and never the working pulse", () => {
    expect(hasStatusPresentation("orphaned")).toBe(true)
    expect(statusPresentationState("orphaned")).toBe("orphaned")
    expect(statusPresentationState("orphaned-run")).toBe("orphaned")
    expect(statusPresentation("orphaned")).toEqual({ glyph: "×", color: "$fg-warning" })
    expect(statusPresentation("orphaned")).not.toEqual(statusPresentation("running"))
    expect(lifecycleStatus("orphaned")).toBe("fail")
  })

  it("keeps the failure disposition of the code it presents: environment-owned, auto-requeued", () => {
    expect(failureDisposition("orphaned-run")).toEqual({ state: "env", automation: "auto-requeue", owner: "queue" })
  })
})
