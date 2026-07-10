import { describe, expect, it } from "vitest"
import { createProcess } from "@yrd/process"

describe("Process", () => {
  it("runs argv without a shell and returns one stable result shape", async () => {
    await using process = createProcess({ env: { PATH: Bun.env.PATH, GIT_DIR: "leak", YRD_JOB: "leak" } })
    const result = await process.run({
      argv: ["sh", "-c", 'printf "%s:%s" "$GIT_DIR" "$YRD_JOB"; printf error >&2'],
    })
    const isolated = await process.run({
      argv: ["sh", "-c", 'printf "%s:%s" "$GIT_DIR" "$YRD_JOB"'],
      env: { PATH: Bun.env.PATH, YRD_JOB: "job-1" },
    })

    expect(result).toMatchObject({ exitCode: 0, stdout: "leak:leak", stderr: "error", timedOut: false })
    expect(isolated.stdout).toBe(":job-1")
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("owns timeout and cancellation through its Scope", async () => {
    await using process = createProcess({ env: { PATH: Bun.env.PATH } })
    const result = await process.run({ argv: ["sh", "-c", "sleep 10"], timeoutMs: 10 })

    expect(result.timedOut).toBe(true)
    expect(result.signal).not.toBeNull()
  })

  it("refuses work after close", async () => {
    const process = createProcess()
    await process.close()
    await expect(process.run({ argv: ["printf", "never"] })).rejects.toThrow("closed")
  })
})
