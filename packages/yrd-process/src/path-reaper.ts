/** Yrd's original path-holder API, backed by Removely's shared collector. */
import { inspectPathHolderCensus as inspectSharedPathHolderCensus } from "removely"
export { pathHolderRefusal } from "removely"

export type PathHolder = Readonly<{
  pid: number
  source: "cwd" | "exe" | "root" | `fd/${string}`
  target: string
}>

export type PathHolderUnavailableCoverage = Readonly<{
  /** ENOENT/ESRCH: the live proc entry disappeared while the census ran. */
  exited: number
  /** EACCES/EPERM: the entry remained but the caller was not allowed to inspect it. */
  denied: number
}>

export type PathHolderSourceCoverage = Readonly<{
  readable: number
  unavailable: PathHolderUnavailableCoverage
}>

/**
 * A same-uid proc the census could not fully observe, identified as far as the
 * world-readable side of `/proc` allows. `/proc/N/stat` stays readable even for
 * dumpable-0 session procs (systemd --user, sd-pam, sshd-session), so identity
 * costs no privilege. `denied` names exactly which observations failed.
 */
export type UnreadableProcess = Readonly<{
  pid: number
  comm?: string
  ppid?: number
  /**
   * Process state from the world-readable `/proc/N/stat`. `Z` (zombie) has
   * already released its fd table and address space, so it can hold no path.
   */
  state?: string
  /**
   * Retained for callers constructing legacy evidence. The current collector
   * proves exit from process-directory absence, never a missing stat file,
   * and does not populate this field.
   */
  exited?: true
  /**
   * Wall-clock start, ISO, from field 22 of the same stat read against the
   * host's boot time; absent when either could not be read.
   */
  startedAt?: string
  denied: readonly ("process" | "cwd" | "exe" | "root" | "maps" | "fd")[]
}>

export type LinuxPathHolderCoverage = Readonly<{
  platform: "linux"
  /** Linux filters numeric proc entries to the caller's UID before inspecting holder sources. */
  scope: "same-uid"
  procRoot: string
  /** False only when permission denial may have hidden a same-UID holder. Exited entries are not gaps. */
  complete: boolean
  processes: Readonly<{
    enumerated: number
    sameUid: number
    otherUid: number
    /**
     * Same-UID entries in state `Z`, counted without probing holder sources.
     * Their holder resources have been released, but they are not yet reaped.
     */
    zombie: number
    unavailable: PathHolderUnavailableCoverage
  }>
  sources: Readonly<Record<"cwd" | "exe" | "root" | "maps" | "fd", PathHolderSourceCoverage>>
  /** Every same-uid proc behind the denied counts, identified — the counts say
   * HOW MANY observations were hidden, this says WHO hid them. Optional for
   * censuses recorded before the field existed. */
  unreadable?: readonly UnreadableProcess[]
}>

export type DarwinPathHolderCoverage = Readonly<{
  platform: "darwin"
  mechanism: "lsof"
  /** Successful unfiltered lsof traversal; this flag does not certify UID or all-visible completeness. */
  complete: true
}>

export type PathHolderCoverage = LinuxPathHolderCoverage | DarwinPathHolderCoverage

export type PathHolderCensus = Readonly<{
  holders: PathHolder[]
  coverage: PathHolderCoverage
}>

/**
 * Keep the original one-argument, same-UID API. Required-resource failures throw;
 * ordinary permission denials retain their existing reduced-coverage result.
 */
export async function inspectPathHolderCensus(path: string): Promise<PathHolderCensus> {
  const census = await inspectSharedPathHolderCensus(path, { scope: "same-uid" })
  if (census.coverage.platform === "linux") {
    const coverage = census.coverage
    const unavailable = [
      coverage.processes.unavailable,
      ...Object.values(coverage.sources).map((source) => source.unavailable),
    ]
    const missing = unavailable.reduce((total, value) => total + value.missing, 0)
    const ambiguous = unavailable.reduce((total, value) => total + value.ambiguous, 0)
    const issues = (coverage.unreadable ?? []).flatMap(({ pid, issues }) =>
      issues
        .filter((issue) => issue.reason !== "denied")
        .map(
          (issue) =>
            `pid ${pid} ${issue.source} '${issue.resource}': ${issue.reason}${issue.code === undefined ? "" : ` (${issue.code})`}`,
        ),
    )
    if (missing > 0 || ambiguous > 0 || issues.length > 0) {
      // Existing teardown callers may independently explain permission denials.
      // Missing/ambiguous observations cannot safely enter that legacy override,
      // including mixed descriptor issues summarized by a dominant denial.
      throw new Error(
        `same-UID holder census in '${coverage.procRoot}' cannot certify '${path}': ` +
          (issues.length === 0 ? `missing ${missing}, ambiguous ${ambiguous}` : issues.join("; ")),
      )
    }
  }
  return census
}
