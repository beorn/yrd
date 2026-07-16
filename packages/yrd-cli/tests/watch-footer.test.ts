import { describe, expect, it } from "vitest"
import {
  footerWithSelectionHint,
  QUEUE_FOOTER_KEYS,
  QUEUE_FOOTER_KEYS_NO_FILTERS,
  SELECTION_FOOTER_HINT,
} from "../src/watch-footer.ts"

// The watch UI enables mouse tracking, which suppresses the terminal's native
// drag-select; the footer advertises the Shift-drag native-selection escape
// hatch. Silvery `Text` word-wraps and the footer Box is height={1}, so the
// hint must be dropped (not clipped) when it would push a keybinding label onto
// a wrapped, invisible second line. These pin the width gate.
describe("footerWithSelectionHint", () => {
  const full = QUEUE_FOOTER_KEYS + SELECTION_FOOTER_HINT
  const threshold = QUEUE_FOOTER_KEYS.length + SELECTION_FOOTER_HINT.length + 1

  it("appends the selection hint when the whole line fits", () => {
    expect(footerWithSelectionHint(QUEUE_FOOTER_KEYS, 200)).toBe(full)
    // Exactly at the threshold width the hint still fits.
    expect(footerWithSelectionHint(QUEUE_FOOTER_KEYS, threshold)).toBe(full)
  })

  it("omits the hint entirely on an 80-col terminal (no wrapped keybinding)", () => {
    const at80 = footerWithSelectionHint(QUEUE_FOOTER_KEYS, 80)
    expect(at80).toBe(QUEUE_FOOTER_KEYS)
    expect(at80).not.toContain("⇧-drag")
    // The user-specced keybindings survive unwrapped: base fits within 80.
    expect(QUEUE_FOOTER_KEYS.length).toBeLessThanOrEqual(80)
    expect(at80).toContain("h/j/k/l navigate")
  })

  it("drops the hint one column below the fit threshold", () => {
    expect(footerWithSelectionHint(QUEUE_FOOTER_KEYS, threshold - 1)).toBe(QUEUE_FOOTER_KEYS)
  })

  it("shows the hint for the shorter no-filters footer at 80 cols (it fits)", () => {
    const at80 = footerWithSelectionHint(QUEUE_FOOTER_KEYS_NO_FILTERS, 80)
    expect(at80).toBe(QUEUE_FOOTER_KEYS_NO_FILTERS + SELECTION_FOOTER_HINT)
    expect(at80.length).toBeLessThanOrEqual(80)
  })
})
