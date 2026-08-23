import { describe, expect, test } from "vitest"
import { resolve } from "node:path"
import { adaptProcessGit } from "../src/git-super.ts"
import type { ProcessResult } from "../src/index.ts"

describe("adaptProcessGit", () => {
  test("shares cleaned defaults across async and typed sync reads", async () => {
    const asyncRequests: unknown[] = []
    const syncExecutions: unknown[] = []
    const git = adaptProcessGit(
      {
        async run(request) {
          asyncRequests.push(request)
          return { exitCode: 0, signal: null, stdout: "async\n", stderr: "", durationMs: 1, timedOut: false }
        },
      },
      { env: { GIT_DIR: "/wrong", KEEP: "yes" }, timeoutMs: 321 },
      {
        executeSync(execution) {
          syncExecutions.push(execution)
          return { code: 0, stdout: "sync\n", stderr: "" }
        },
      },
    )

    await expect(git.run({ repo: "/repo", args: ["status"], env: { EXTRA: "async" } })).resolves.toMatchObject({
      code: 0,
      stdout: "async\n",
    })
    expect(
      git.readSync({
        repo: "/repo",
        command: { verb: "rev-parse", args: ["HEAD"] },
        env: { EXTRA: "sync" },
      }),
    ).toMatchObject({ code: 0, stdout: "sync\n" })

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
    expect(syncExecutions).toEqual([
      expect.objectContaining({
        argv: ["git", "-C", "/repo", "rev-parse", "HEAD"],
        cwd: process.cwd(),
        timeoutMs: 321,
        env: expect.objectContaining({ KEEP: "yes", EXTRA: "sync", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", TZ: "UTC" }),
      }),
    ])
    expect(syncExecutions).not.toEqual([
      expect.objectContaining({ env: expect.objectContaining({ GIT_DIR: "/wrong" }) }),
    ])
  })

  test("keeps the sync command verb typed and ahead of caller-controlled args", () => {
    const argv: string[][] = []
    const git = adaptProcessGit(
      {
        run: async (): Promise<ProcessResult> => ({
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          durationMs: 1,
          timedOut: false as const,
          verdict: "EXITED" as const,
          stalled: false as const,
        }),
      },
      {},
      {
        executeSync(execution) {
          argv.push([...execution.argv])
          return { code: 0, stdout: "", stderr: "" }
        },
      },
    )

    git.readSync({ repo: "/repo", command: { verb: "for-each-ref", args: ["--format=%(refname)"] } })
    expect(argv).toEqual([["git", "-C", "/repo", "for-each-ref", "--format=%(refname)"]])
  })

  test("runs a real bounded sync read without inventing a timeout", () => {
    const root = resolve(import.meta.dirname, "../../..")
    const git = adaptProcessGit(
      {
        run: async (): Promise<ProcessResult> => ({
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          durationMs: 1,
          timedOut: false as const,
          verdict: "EXITED" as const,
          stalled: false as const,
        }),
      },
      { timeoutMs: 5_000 },
    )

    const result = git.readSync({ repo: root, command: { verb: "rev-parse", args: ["--show-toplevel"] } })
    expect(result).toMatchObject({ code: 0 })
    expect(result).not.toHaveProperty("timedOut")
  })
})
