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
 * 2 stuck. A pin that moved under `queue up` is a 0 like any other intended
 * ending: hab reads every non-zero exit as a crash and spends a restart budget
 * on it, and the relaunch onto the new pin is the cure, not the fault. The
 * incumbent resident's lifecycle codes (3, 10 to 18) went with it at M6.
 */
export type YrdCliExitCode = 0 | 1 | 2

export type YrdCliIO = {
  stdout(text: string): void
  stderr(text: string): void
  /** The directory the command stands in. The declaration found there, or at
   * the nearest directory above it in the same repository, is the repository:
   * no command takes a repository operand and none resolves an alias. */
  cwd?: string
  /** Human output may carry colour. Tests and pipes say no. */
  color?: boolean
}
