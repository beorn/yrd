/**
 * The terminal the live pane runs in — the retired pane's
 * `WATCH_LIVE_RENDER_OPTIONS`, restored.
 *
 * Spelled out rather than left to the runtime's terminal detection because
 * every one of them is a display fact the operator used: the alternate screen
 * so leaving restores the shell; SGR mouse tracking so a wheel scrolls the
 * viewport instead of arriving as arrow keys that move the cursor, a click
 * selects a row or a pill, and the QUEUE/DETAIL divider drags; buffer
 * selection with copy-on-drag (OSC 52) so a drag over a sha or a path copies it.
 * One module, no imports, so the one-shot commands that import it stay as cold
 * as the cold-graph test pins.
 */
export const WATCH_RUN_OPTIONS = {
  mode: "fullscreen",
  mouse: true,
  selection: true,
  copyOnSelect: true,
} as const
