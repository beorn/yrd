import { describe, expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLogger } from "loggily"
import { adaptProcessGit } from "../src/git-super.ts"
import { createProcess } from "../src/index.ts"

const silentLog = createLogger("test", [{ level: "silent" }])

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

  // 24669: past maxOutputBytes the capture keeps a head and a tail and lets the child exit 0, so the
  // adapter must hand its consumer a failure it already reads. A consumer that checks only the text
  // notice still parses a hole in the middle of stdout as a complete read.
  test("reports a truncated capture as a failure naming the command and the cap (24669)", async () => {
    const root = await mkdtemp(join(tmpdir(), "adapt-truncation-"))
    const cli = (...args: readonly string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" })
    try {
      cli("init", "--quiet")
      for (let index = 0; index < 80; index += 1) {
        await writeFile(join(root, `file-${String(index)}-${"x".repeat(40)}`), "x\n")
      }
      cli("add", "-A")
      cli("-c", "user.email=test@main.hh.invalid", "-c", "user.name=test", "commit", "--quiet", "-m", "seed")
      const written = execFileSync("git", ["-C", root, "ls-tree", "-r", "-z", "HEAD"], { stdio: "pipe" }).byteLength
      const limit = 1024
      expect(written, "the fixture must write past the cap for the row to mean anything").toBeGreaterThan(limit)

      // The truncation warn is this fixture's own, so it owns the logger that emits it
      // instead of leaking a WARN into the run.
      await using process = createProcess({ maxOutputBytes: limit, inject: { log: silentLog } })
      const result = await adaptProcessGit(process).run({ repo: root, args: ["ls-tree", "-r", "-z", "HEAD"] })

      expect(result.code).toBe(0)
      expect(result.failure, "a truncated capture must never read as a complete one").toBeDefined()
      expect(result.failure).toContain("truncated")
      expect(result.failure).toContain(String(limit))
      expect(result.failure).toContain("ls-tree")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
