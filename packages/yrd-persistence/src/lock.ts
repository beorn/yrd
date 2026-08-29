import { join } from "node:path"
import { acquireExclusive, type ExclusiveOptions as GitExclusiveOptions, type WriterLock } from "git-super/exclusive"
import { createFailure, observeYrdLifecycle } from "@yrd/core"
import { createLogger, type ConditionalLogger } from "loggily"

export type Exclusive = Readonly<{
  run<Result>(operation: () => Promise<Result>, options: ExclusiveRunOptions): Promise<Result>
}>

/**
 * `holder` is REQUIRED, and that is the point.
 *
 * git-super renders an unnamed holder as the literal "unknown operation", and
 * every one of 3,312 starvation messages measured on one host on 2026-08-28
 * said exactly that — so the lock could be observed to starve for ninety
 * minutes with no way to name what held it. The bead that tracked the incident
 * could not name the offender either. An optional field documented as
 * "please set this" produced one caller that did out of ten; a required one
 * cannot be omitted by a new call site, which is the only version of this rule
 * that survives the next author.
 */
export type ExclusiveRunOptions = Readonly<{ holder: string }>
export type ExclusiveOptions = GitExclusiveOptions

/** Yrd observability/failure policy around git-super's one POSIX lock primitive. */
export function createExclusive(
  dir: string,
  options: ExclusiveOptions = {},
  inject: Readonly<{ log?: ConditionalLogger; now?: () => number }> = {},
): Exclusive {
  const log = inject.log ?? createLogger("yrd", [{ level: "warn" }])
  return {
    async run(operation, runOptions) {
      // The type says `holder` is required. That reaches every TypeScript
      // caller and NO caller TypeScript cannot see — and one of those is how
      // this stayed anonymous: `tools/yrd-runtime.mjs` in the superproject is
      // a hand-written .mjs mirror of `drainSettlements`, it acquires this very
      // lock, and it never got the argument the TS original was given. It read
      // as "unknown operation" for as long as the field was optional, and as
      // `undefined is not an object (evaluating 'runOptions.holder')` the
      // moment it became required. Neither names what to do. So the check is
      // here as well as in the type, because a requirement only the compiler
      // enforces is not a requirement at the boundary a .mjs crosses.
      if (runOptions === undefined || typeof runOptions.holder !== "string") {
        throw new TypeError(
          `yrd: exclusive run requires { holder } naming the operation taking ${join(dir, "writer.lock")}; ` +
            "an unnamed holder renders as \"unknown operation\" in every starvation message, which is how a " +
            "ninety-minute stall was observed with nothing to attribute it to",
        )
      }
      const holder = runOptions.holder.trim()
      if (holder === "" || /\r|\n/u.test(holder)) {
        throw new TypeError("yrd: exclusive holder must be a non-empty single line")
      }
      let lock: WriterLock
      try {
        lock = await observeYrdLifecycle(
          log,
          {
            lifecycle: "lock",
            attributes: {
              path: join(dir, "writer.lock"),
              timeoutMs: options.timeoutMs ?? 30_000,
              holder,
            },
            now: inject.now,
          },
          () => acquireExclusive(dir, options, holder),
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!message.includes("worktree mutation lock is busy")) throw error
        throw createFailure({
          kind: "infrastructure",
          code: "exclusive-busy",
          message: message.replace("git-super: worktree mutation lock is busy", "yrd: writer lock is busy"),
        })
      }
      try {
        return await operation()
      } finally {
        lock.release()
      }
    },
  }
}
