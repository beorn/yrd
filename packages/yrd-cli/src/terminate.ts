/**
 * The process's termination signals as one injectable port: a long-running command subscribes, settles what it owns,
 * then re-raises so the process still dies OF the signal. The queue service (25430) and the retained-store batch
 * (#35047) both use it, so a supervisor's TERM reaches their detached children through their Process owner.
 */

/** The termination signal a running command answers before it exits. */
export type TerminatePort = Readonly<{
  /** Call `handler` with the termination signal; answers the unsubscribe. */
  on: (handler: (signal?: NodeJS.Signals) => void) => () => void
  /** End the process as the signal would have, after the handler ran. */
  reraise: (signal?: NodeJS.Signals) => void
}>

export const processTerminate: TerminatePort = {
  on: (handler) => {
    const signals = ["SIGTERM", "SIGHUP", "SIGINT"] as const
    const listeners = signals.map((signal) => ({ signal, listener: () => handler(signal) }))
    for (const { signal, listener } of listeners) process.on(signal, listener)
    return () => {
      for (const { signal, listener } of listeners) process.off(signal, listener)
    }
  },
  // Re-raised with no listener left, so the process dies OF the signal exactly
  // as before: the service's `restart: "on-codes"` keeps a signal terminal.
  reraise: (signal = "SIGTERM") => {
    process.kill(process.pid, signal)
  },
}
