/**
 * The process crash record for the live watch pane (ADR-0031 decision 3, hh #31167): the process entry's one crash
 * handler writes the FATAL record, lets silvery record and restore the pane, flushes within a bound and exits 1.
 *
 * Version-tolerant on purpose. A silvery with `recordAppCrash` registers no process listener of its own and needs
 * loggily's `installCrashHandler`; the silvery this repository's own install pins still owns its listeners, so it gets
 * nothing here. The module types below compile against both. The tolerance goes when this repository's pins carry
 * both functions (hh #35075). Dynamic imports only, so the one-shot commands stay cold.
 */
type Restore = (error: Error) => void
interface SilveryRuntimeCrashRecord {
  readonly recordAppCrash?: Restore
}
interface LoggilyCrashHandler {
  readonly createLogger: (name: string) => unknown
  readonly installCrashHandler?: (options: { logger: never; restore: Restore }) => Disposable
}

/** Install the crash handler for one watch pane's lifetime; dispose it when the pane has exited. */
export async function installWatchCrashRecord(): Promise<Disposable | undefined> {
  const [silveryModule, loggily]: [unknown, LoggilyCrashHandler] = await Promise.all([
    import("silvery/runtime"),
    import("loggily"),
  ])
  // The bridge is the tolerance itself: a silvery older than `recordAppCrash` has no property to overlap with, and
  // TypeScript refuses the structural assignment outright. Narrow here, once, instead of pinning the pane to one
  // silvery. Goes with the tolerance when the pins carry both functions (hh #35075).
  const silveryRuntime = silveryModule as SilveryRuntimeCrashRecord
  // Presence is asked with `in`, never by reading the property: a module mock (and CI's own silvery sibling,
  // which is older than recordAppCrash) throws on the read instead of answering undefined, so the optimistic
  // read turned this tolerance into "yrd watch cannot start" against exactly the silvery it exists to tolerate.
  const restore = "recordAppCrash" in silveryRuntime ? silveryRuntime.recordAppCrash : undefined
  // silent-fallback-allow: a silvery without recordAppCrash still owns its own crash listeners, so its record is kept.
  if (restore === undefined) return undefined
  if (loggily.installCrashHandler === undefined) {
    throw new Error(
      "yrd watch: this silvery leaves process crashes to the entry (recordAppCrash), but this loggily has no " +
        "installCrashHandler; a crash would lose its record. Install loggily with installCrashHandler (0.14.0 or later).",
    )
  }
  return loggily.installCrashHandler({ logger: loggily.createLogger("yrd:watch") as never, restore })
}
