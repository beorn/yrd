/**
 * Pure keybinding state machine for the watch pane's `x` cancel affordance.
 *
 * The watch viewer is read-only except for this one write: canceling the SELECTED
 * queue/run row. Cancel is destructive (it aborts an in-flight run), so it is
 * two-step — press `x` to arm a confirmation, then `y`/Enter to confirm — and it
 * is fail-safe: any other key, Escape, or a second `x` dismisses the prompt
 * without canceling. The confirmed cancel is wired to the SAME path as the
 * `run cancel <R>` CLI (app.queue.cancelRun); the reducer only decides state.
 *
 * Extracted as a pure function so the decision is unit-testable without mounting
 * the React watch pane (whose live renderer is exercised separately).
 */
export type RunCancelKey = Readonly<{ char: string; escape: boolean; return: boolean }>

export type RunCancelDecision = Readonly<{
  /** Next armed state: true renders the confirm prompt for the selected run. */
  armed: boolean
  /** When set, the operator confirmed — cancel this run id via the shared path. */
  cancel?: string
}>

export function reduceRunCancelKey(
  key: RunCancelKey,
  armed: boolean,
  selectedRun: string | undefined,
): RunCancelDecision {
  // No run under the cursor (or the row has no run): cancel is unavailable, and
  // no keypress can arm or fire it.
  if (selectedRun === undefined) return { armed: false }
  if (armed) {
    // The confirm prompt is showing. Only an explicit yes fires the cancel; every
    // other key (including a second `x` and Escape) dismisses it — never cancel on
    // an ambiguous key.
    if (!key.escape && (key.char === "y" || key.return)) return { armed: false, cancel: selectedRun }
    return { armed: false }
  }
  // Idle: `x` arms the confirmation for the selected run; nothing else does.
  if (key.char === "x") return { armed: true }
  return { armed: false }
}
