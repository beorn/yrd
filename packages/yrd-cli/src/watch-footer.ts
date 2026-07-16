/**
 * Watch-UI footer text — keybindings + a width-gated text-selection affordance.
 *
 * Pure string helpers (no silvery/render dependency) so the width-gating logic
 * is unit-testable without mounting the pane. Consumed by watch-pane.tsx.
 */

// Base keybinding footers (user respec 2026-07-15). Pause/resume removed;
// `N new` moved to the pane header's temporal-trust row.
export const QUEUE_FOOTER_KEYS =
  "q quit - enter/esc show/hide detail - p/r/f/d toggle filters - h/j/k/l navigate"
export const QUEUE_FOOTER_KEYS_NO_FILTERS = "q quit - enter/esc show/hide detail - h/j/k/l navigate"

// Text-selection affordance. The watch UI enables mouse tracking
// (WATCH_LIVE_RENDER_OPTIONS `mouse: true`), so the terminal no longer does
// native drag-select by default. Shift-drag bypasses app mouse reporting for
// native terminal selection on the xterm/kitty/Ghostty family (Ghostty default
// `mouse-shift-capture=false`) and works over every region — content,
// scrollbar, divider — since it never reaches the app. (Silvery's in-app
// plain-drag also selects+copies via OSC 52; Shift-drag is the
// guaranteed-universal path we advertise.)
export const SELECTION_FOOTER_HINT = " - ⇧-drag to select"

/**
 * Append the selection hint only when the whole footer still fits on its single
 * (`height={1}`) row at `columns`. Silvery `Text` word-wraps, so an over-width
 * hint would wrap a keybinding label onto the clipped second row — dropping
 * `navigate` on an 80-col terminal. On narrow terminals the hint is omitted
 * entirely (not clipped), so the user-specced keybindings are never disturbed.
 * The `+ 1` reserves a cell for the ambiguous-width ⇧ glyph.
 */
export function footerWithSelectionHint(keys: string, columns: number): string {
  return keys.length + SELECTION_FOOTER_HINT.length + 1 <= columns
    ? keys + SELECTION_FOOTER_HINT
    : keys
}
