import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { runConfiguredCommand } from "../src/command.ts"

describe("configured commands", () => {
  it("passes dynamic values through YRD_* environment variables without changing shell source", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "yrd-command-"))
    const marker = join(cwd, "injected")
    const task = `task; touch ${marker}; #`

    try {
      const result = await runConfiguredCommand({
        command: `printf '%s' "$YRD_TASK"`,
        cwd,
        purpose: "task validation",
        variables: { YRD_TASK: task },
      })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe(task)
      expect(existsSync(marker)).toBe(false)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it.each([
    ["{name}", "$YRD_TASK"],
    ["{pr}", "$YRD_PR"],
    ["{target}", "$YRD_TARGET"],
    ["{detail}", "$YRD_DETAIL"],
  ])("rejects retired placeholder %s and names its environment replacement", async (placeholder, replacement) => {
    await expect(
      runConfiguredCommand({
        command: `printf '%s' '${placeholder}'`,
        cwd: process.cwd(),
        purpose: "test",
      }),
    ).rejects.toThrow(`${placeholder} is retired; use ${replacement}`)
  })

  it("does not inherit spoofed YRD_* values that the caller did not provide", async () => {
    const prior = process.env.YRD_PR
    process.env.YRD_PR = "spoofed"
    try {
      const result = await runConfiguredCommand({
        command: `printf '%s' "\${YRD_PR-unset}"`,
        cwd: process.cwd(),
        purpose: "test",
      })
      expect(result.stdout).toBe("unset")
    } finally {
      if (prior === undefined) delete process.env.YRD_PR
      else process.env.YRD_PR = prior
    }
  })
})
