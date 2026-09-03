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
 * 2 stuck — plus 18, which only `queue up` returns, when the pin moved and
 * hab must relaunch the service on the new one. The incumbent resident's
 * lifecycle codes (3, 10 to 17) went with the resident at M6.
 */
export type YrdCliExitCode = 0 | 1 | 2 | 18

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
