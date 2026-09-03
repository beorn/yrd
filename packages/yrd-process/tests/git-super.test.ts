import { describe, expect, test } from "vitest"
import { adaptProcessGit } from "../src/git-super.ts"

describe("adaptProcessGit", () => {
  test("scrubs the caller's Git routing variables and keeps the rest", async () => {
    const asyncRequests: unknown[] = []
    const git = adaptProcessGit(
      {
        async run(request) {
          asyncRequests.push(request)
          return { exitCode: 0, signal: null, stdout: "async\n", stderr: "", durationMs: 1, timedOut: false }
        },
      },
      { env: { GIT_DIR: "/wrong", KEEP: "yes" }, timeoutMs: 321 },
    )

    await expect(git.run({ repo: "/repo", args: ["status"], env: { EXTRA: "async" } })).resolves.toMatchObject({
      code: 0,
      stdout: "async\n",
    })

    expect(asyncRequests).toEqual([
      expect.objectContaining({
        argv: ["git", "-C", "/repo", "status"],
        cwd: "/repo",
        timeoutMs: 321,
        env: expect.objectContaining({ KEEP: "yes", EXTRA: "async", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", TZ: "UTC" }),
      }),
    ])
    expect(asyncRequests).not.toEqual([
      expect.objectContaining({ env: expect.objectContaining({ GIT_DIR: "/wrong" }) }),
    ])
  })
})
