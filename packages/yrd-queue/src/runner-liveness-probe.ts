import { recordedPidLivenessSync } from "@yrd/process"
import { runnerPid, type RunnerLivenessProbe } from "@yrd/job"

/**
 * The host half of the liveness contract (@i/10-yrd/24030): whether the
 * process behind a runner identity is alive, answered by the ONE recorded-pid
 * liveness primitive yrd has (`recordedPidLivenessSync`, the same call the
 * habitant's reclaim and the NO RUNNER banner consume). A pid-less identity
 * (`yrd-cli`) answers `undefined` so only its lease can judge it; an
 * `unknown` verdict (the pid exists but its identity could not be read) also
 * answers `undefined`, because a probe that cannot prove death must never
 * license the settling branch — the direction that is expensive to get wrong.
 */
export function hostRunnerAlive(runner: string, options: Readonly<{ procRoot?: string }> = {}): boolean | undefined {
  const pid = runnerPid(runner)
  if (pid === undefined) return undefined
  const report = recordedPidLivenessSync({ pid }, options)
  if (report.liveness === "gone" || report.liveness === "recycled") return false
  if (report.liveness === "live") return true
  return undefined
}

/** Build the probe a recovery pass hands the liveness derivation. */
export function hostRunnerLivenessProbe(
  now: number,
  options: Readonly<{ procRoot?: string }> = {},
): RunnerLivenessProbe {
  return { now, runnerAlive: (runner) => hostRunnerAlive(runner, options) }
}
