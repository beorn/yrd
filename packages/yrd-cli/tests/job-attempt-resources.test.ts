/**
 * @failure A Yrd Job can inherit ambient runtime state or delete another
 *          attempt's resources during settlement/recovery.
 * @level l2
 * @consumer @yrd/cli job-attempt isolation
 */
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { JobAttempt } from "@yrd/job"
import { createJobAttemptResources } from "../src/job-attempt-resources.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("Job attempt resources", () => {
  it("isolates ambient process state under one exact durable attempt root", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "yrd-job-attempts-"))
    roots.push(stateDir)
    const resources = createJobAttemptResources({ stateDir })
    const attempt: JobAttempt = { id: "../../job/with separators", attempt: 2, executor: "worker-1" }

    await resources.prepare(attempt)

    const root = resources.path(attempt)
    expect(root.startsWith(join(stateDir, "attempts"))).toBe(true)
    expect(root).not.toContain("job/with separators")
    expect(resources.environment(attempt)).toEqual({
      YRD_JOB_ROOT: root,
      TMPDIR: join(root, "tmp"),
    })
    expect(existsSync(join(root, "tmp"))).toBe(true)
  })

  it("releases only the proven attempt root and is safe to repeat after recovery", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "yrd-job-release-"))
    roots.push(stateDir)
    const resources = createJobAttemptResources({ stateDir })
    const first: JobAttempt = { id: "J1", attempt: 1, executor: "worker-1" }
    const second: JobAttempt = { id: "J1", attempt: 2, executor: "worker-2" }
    await resources.prepare(first)
    await resources.prepare(second)
    await writeFile(join(resources.path(first), "owned.txt"), "first\n")
    await writeFile(join(resources.path(second), "owned.txt"), "second\n")
    const sentinel = join(stateDir, "operator-owned.txt")
    await writeFile(sentinel, "keep\n")

    await resources.release(first)
    await resources.release(first)

    expect(existsSync(resources.path(first))).toBe(false)
    expect(existsSync(resources.path(second))).toBe(true)
    expect(existsSync(sentinel)).toBe(true)
  })
})
