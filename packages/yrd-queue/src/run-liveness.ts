/**
 * A running row's liveness, DERIVED at read time from its lease holder — never
 * stored belief (@i/10-yrd/24030).
 *
 * "running" used to mean "a Job row says in_progress". R3742 read `checking`
 * for two hours after its runner process died, and R3747 read `running` after
 * a SIGTERM drain cut it between its merge reaching main and its terminal row.
 * Nothing consulted the lease or the holder, so a dead holder and a live one
 * printed the same word.
 *
 * The predicate is pure: the caller supplies the clock and a probe for the
 * holder's process, so the queue package decides and the host answers. Every
 * reader of a running row (queue list, watch, pr runs, the dead-man line, the
 * pass-start settlement) derives through this one function, so there is one
 * answer to "is this run alive" in the codebase.
 */

/** The identity an in_progress Job carries: who holds it and until when. */
export type RunningJobIdentity = Readonly<{
  /** The holder's runner identity as written at claim, e.g. `yrd-cli:41231`. */
  runner: string
  /** ISO timestamp; the lease is held while `Date.parse(leaseExpiresAt) > now`. */
  leaseExpiresAt: string
}>

export type RunnerLivenessProbe = Readonly<{
  /** The read's clock, epoch milliseconds. */
  now: number
  /**
   * Whether the process behind a runner identity is alive: `true` / `false`
   * when the identity carries a pid the host can probe, `undefined` when it
   * does not (a bare `yrd-cli` with no pid cannot be probed by identity, so
   * only its lease can judge it).
   */
  runnerAlive: (runner: string) => boolean | undefined
}>

export type RunLiveness =
  | Readonly<{ state: "running"; runner: string; leaseExpiresAt: string }>
  | Readonly<{
      state: "orphaned"
      runner: string
      leaseExpiresAt: string
      /** Which fact condemned the row: the lease lapsed, or the holder is dead while the lease still stands. */
      cause: "lease-expired" | "holder-dead"
      /** The holder's pid when the identity carried one. */
      pid?: number
    }>

/** The pid a runner identity carries (`<name>:<pid>`), or `undefined` for a pid-less identity. */
export function runnerPid(runner: string): number | undefined {
  const match = /:(\d+)$/u.exec(runner)
  if (match === null) return undefined
  const pid = Number(match[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

/**
 * Derive a running row's liveness: `running` only while the lease is unexpired
 * AND the holder is not known to be dead; otherwise `orphaned`, naming the
 * holder and the lease expiry. An unparseable lease counts as expired — an
 * absent fact is never read as "alive".
 */
export function deriveRunLiveness(job: RunningJobIdentity, probe: RunnerLivenessProbe): RunLiveness {
  const pid = runnerPid(job.runner)
  const leaseExpiresAt = Date.parse(job.leaseExpiresAt)
  const leaseHeld = Number.isFinite(leaseExpiresAt) && leaseExpiresAt > probe.now
  if (!leaseHeld) {
    return {
      state: "orphaned",
      runner: job.runner,
      leaseExpiresAt: job.leaseExpiresAt,
      cause: "lease-expired",
      ...(pid === undefined ? {} : { pid }),
    }
  }
  if (probe.runnerAlive(job.runner) === false) {
    return {
      state: "orphaned",
      runner: job.runner,
      leaseExpiresAt: job.leaseExpiresAt,
      cause: "holder-dead",
      ...(pid === undefined ? {} : { pid }),
    }
  }
  return { state: "running", runner: job.runner, leaseExpiresAt: job.leaseExpiresAt }
}

/** One human line for an orphaned row: the dead holder and when its lease lapsed. */
export function describeOrphanedRun(liveness: Extract<RunLiveness, { state: "orphaned" }>): string {
  const holder =
    liveness.pid === undefined ? `holder ${liveness.runner}` : `holder ${liveness.runner} (pid ${liveness.pid})`
  return liveness.cause === "lease-expired"
    ? `orphaned: lease expired ${liveness.leaseExpiresAt}, ${holder}`
    : `orphaned: ${holder} is dead, lease until ${liveness.leaseExpiresAt}`
}
