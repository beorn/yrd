/**
 * What a command may write to, and what it may exit with.
 *
 * Both are small on purpose. The old wrapper's `types.ts` carried the app,
 * its services and every projection the status views needed — a file that
 * top-level-imported `@yrd/queue`, `@yrd/persistence`, `@yrd/contest` and
 * `@yrd/job`, so the new core's own command file could not compile without
 * all four packages present. Nothing here imports a package the queue does
 * not run on.
 */

/**
 * Every code a Yrd command may exit with (plan § Commands): 0 pass, 1 fail,
 * 2 stuck. A gitlink that moved under `queue up` is a 0 like any other intended
 * ending: Hab relaunches the runner after allowlisted exits 0 and 1, while exit
 * 2 and every signal stay terminal. Relaunching onto the new gitlink is the cure,
 * not the fault. The incumbent resident's lifecycle codes (3, 10 to 18) went
 * with it at M6.
 *
 * 3 came back in 2026-09 for ONE command: `queue health`, the declared
 * supervisor probe, whose ladder is the supervisor's and not the queue's —
 * `healthy 0`, `absent 1`, `unhealthy 2`, `unknown 3`. It is not a fourth queue
 * outcome and no queue command returns it. A probe that printed `unknown` and
 * exited 2 would be making two claims that disagree, which is the defect this
 * whole bead is about, one layer down.
 *
 * 4 is `yrd env close`'s ACCEPTED-NOT-DONE (22894): the environment is still
 * there and its close has been queued for a context whose same-UID census reads
 * every pid. It is not 0 because a caller chaining on success would otherwise
 * treat a live environment as gone; it is not 2 because nothing was refused.
 * Same class as hab run's `HAB_RUN_REPORT_EXIT = 4`.
 */
export type YrdCliExitCode = 0 | 1 | 2 | 3 | 4

export type LocalBranchProtectionResult = Readonly<{
  protections: readonly string[]
  evidence: readonly Readonly<{ kind: "malformed-lease"; path: string; reason: string }>[]
}>

export type YrdCliIO = {
  stdout(text: string): void
  stderr(text: string): void
  /** The directory the command stands in. The declaration found there, or at
   * the nearest directory above it in the same repository, is the repository:
   * no command takes a repository operand and none resolves an alias. */
  cwd: string
  /** Render Yrd argv in an absolute repository cwd as a POSIX shell command.
   * Pure display only: hosts preserve their entrypoint and authority readers.
   * Absent, the CLI prints standalone Yrd with an explicit cwd. */
  formatYrdCommand?: (argv: readonly string[], cwd: string) => string
  /** Human output may carry colour. Tests and pipes say no. */
  color?: boolean
  /** The terminal's width in cells, for the pages that lay out to it; absent, they assume 120. */
  columns?: number
  /** Without a target, read current external uses once per cleanup round.
   * With a canonical absolute target, read every current host use overlapping it, including owner leases.
   * Paths are absolute and reasons are opaque text. An unavailable reader preserves automatic
   * candidates. Ordinary cleanup permits an absent reader; explicit retained-checkout release requires it. */
  liveEnvironmentUse?: (targetPath?: string) => Promise<readonly Readonly<{ path: string; reason: string }>[]>
  /** Pure syntactic issue mapping for branch cleanup; never performs external lookups. */
  branchIssue?: (input: Readonly<{ branch: string; recordedIssue?: string }>) => string | undefined
  /** Fresh host holds, leases and live/dirty work associated with this exact local branch.
   * Rejections preserve the branch. null explicitly selects a standalone repository with no host holds.
   * Explicit retained-checkout release requires the callback and records its non-blocking evidence.
   */
  localBranchProtections:
    | ((
        input: Readonly<{ repo: string; branch: string; tip: string; issue?: string; retainedCheckout?: string }>,
      ) => Promise<LocalBranchProtectionResult>)
    | null
}
