import { join } from "node:path"
import { acquireExclusive, type ExclusiveOptions as GitExclusiveOptions, type WriterLock } from "git-super/exclusive"
import { createFailure, observeYrdLifecycle } from "@yrd/core"
import { createLogger, type ConditionalLogger } from "loggily"

export type Exclusive = Readonly<{
  run<Result>(operation: () => Promise<Result>, options?: ExclusiveRunOptions): Promise<Result>
}>

export type ExclusiveRunOptions = Readonly<{ holder?: string }>
export type ExclusiveOptions = GitExclusiveOptions

/** Yrd observability/failure policy around git-super's one POSIX lock primitive. */
export function createExclusive(
  dir: string,
  options: ExclusiveOptions = {},
  inject: Readonly<{ log?: ConditionalLogger; now?: () => number }> = {},
): Exclusive {
  const log = inject.log ?? createLogger("yrd", [{ level: "warn" }])
  return {
    async run(operation, runOptions = {}) {
      const holder = runOptions.holder?.trim()
      if (holder !== undefined && (holder === "" || /\r|\n/u.test(holder))) {
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
              ...(holder === undefined ? {} : { holder }),
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
