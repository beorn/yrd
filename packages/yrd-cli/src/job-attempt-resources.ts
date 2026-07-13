import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { JobAttempt, JobAttemptResources } from "@yrd/job"

export type JobAttemptResourceHost = JobAttemptResources &
  Readonly<{
    path(attempt: JobAttempt): string
    environment(attempt: JobAttempt): Readonly<Record<string, string>>
  }>

/** Filesystem adapter for resources that must not outlive one durable attempt. */
export function createJobAttemptResources(options: { stateDir: string }): JobAttemptResourceHost {
  const attemptsRoot = join(resolve(options.stateDir), "attempts")
  const path = (attempt: JobAttempt): string =>
    join(attemptsRoot, createHash("sha256").update(attempt.id).digest("hex"), `attempt-${attempt.attempt}`)

  return Object.freeze({
    path,
    environment(attempt) {
      const root = path(attempt)
      return Object.freeze({
        YRD_JOB_ROOT: root,
        TMPDIR: join(root, "tmp"),
      })
    },
    async prepare(attempt) {
      const root = path(attempt)
      await mkdir(join(root, "tmp"), { recursive: true })
    },
    async release(attempt) {
      const root = path(attempt)
      await rm(root, { recursive: true, force: true })
      if (existsSync(root)) throw new Error(`yrd: Job attempt root '${root}' still exists after release`)
    },
  })
}
