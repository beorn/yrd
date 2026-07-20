import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { formatYrdRuntimeVersion, YRD_VERSION } from "../src/version.ts"

const root = resolve(import.meta.dirname, "../../..")

type GitProbe = (args: readonly string[]) => { status: number; stdout: string }

async function run(
  executable: "yrd" | "git-yrd" | "git-bay",
  flag: "--version" | "-V",
  cwd: string,
  environment: NodeJS.ProcessEnv = {},
) {
  const child = Bun.spawn([resolve(root, "bin", executable), flag], {
    cwd,
    env: {
      ...process.env,
      GIT_DIR: "/definitely/not/the/yrd/git-dir",
      GIT_PREFIX: "caller/prefix/that/must/not-leak/",
      NODE_ENV: "production",
      ...environment,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

describe("version CLI", () => {
  it("reports unknown when HEAD succeeds but git status fails", () => {
    const calls: string[][] = []
    const git: GitProbe = (args) => {
      calls.push([...args])
      if (calls.length === 1) return { status: 0, stdout: "0123456789\n" }
      return { status: 1, stdout: "" }
    }
    expect(formatYrdRuntimeVersion(git)).toBe(`yrd ${YRD_VERSION}+unknown`)
    expect(calls).toEqual([
      ["rev-parse", "--short=10", "--verify", "HEAD"],
      ["status", "--porcelain=v1"],
    ])
  })

  it.each(["a", "not-a-sha", "0123456789extra", "012345678Z"])(
    "reports unknown when successful HEAD output is malformed: %s",
    (head) => {
      const git: GitProbe = (args) =>
        args.includes("rev-parse") ? { status: 0, stdout: `${head}\n` } : { status: 0, stdout: "" }

      expect(formatYrdRuntimeVersion(git)).toBe(`yrd ${YRD_VERSION}+unknown`)
    },
  )

  it("bounds and names a blackholed source Git process", async () => {
    const outside = mkdtempSync(resolve(tmpdir(), "yrd-version-blackhole-"))
    try {
      const bin = join(outside, "bin")
      mkdirSync(bin)
      const git = join(bin, "git")
      writeFileSync(git, "#!/bin/sh\nexec /bin/sleep 30\n")
      chmodSync(git, 0o755)

      const startedAt = Date.now()
      const result = await run("yrd", "--version", outside, {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      })

      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("git rev-parse --short=10 --verify HEAD timed out after 5000ms")
      expect(Date.now() - startedAt).toBeLessThan(8_000)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  }, 10_000)

  it.each([
    ["yrd", "--version"],
    ["yrd", "-V"],
    ["git-yrd", "--version"],
    ["git-yrd", "-V"],
    ["git-bay", "--version"],
    ["git-bay", "-V"],
  ] as const)("prints Yrd source version + SHA for %s %s without entering a UI", async (executable, flag) => {
    const outside = mkdtempSync(resolve(tmpdir(), "yrd-version-caller-"))
    try {
      const sha = execFileSync("git", ["-C", root, "rev-parse", "--short=10", "HEAD"], {
        encoding: "utf8",
      }).trim()
      const result = await run(executable, flag, outside)

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toMatch(new RegExp(`^yrd ${YRD_VERSION}\\+${sha}(?:-dirty)?\\n$`, "u"))
      expect(result.stderr).toBe("")
      expect(`${result.stdout}${result.stderr}`).not.toContain("\x1b[?1049h")
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it("keeps the Yrd source identity when the production entrypoint is bundled", async () => {
    const build = Bun.spawn([process.execPath, resolve(root, "scripts/build.ts")], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [buildExit, buildStdout, buildStderr] = await Promise.all([
      build.exited,
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
    ])
    expect(buildExit, `${buildStdout}${buildStderr}`).toBe(0)

    const sha = execFileSync("git", ["-C", root, "rev-parse", "--short=10", "HEAD"], {
      encoding: "utf8",
    }).trim()
    const built = Bun.spawn([resolve(root, "dist/bin/yrd"), "--version"], {
      cwd: tmpdir(),
      env: {
        ...process.env,
        GIT_DIR: "/definitely/not/the/yrd/git-dir",
        GIT_PREFIX: "caller/prefix/that/must/not-leak/",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      built.exited,
      new Response(built.stdout).text(),
      new Response(built.stderr).text(),
    ])

    expect(exitCode, stderr).toBe(0)
    expect(stdout).toMatch(new RegExp(`^yrd ${YRD_VERSION}\\+${sha}(?:-dirty)?\\n$`, "u"))
    expect(stderr).toBe("")
  })
})
