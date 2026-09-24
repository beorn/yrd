/**
 * @failure A dependency's published surface drifts stale relative to what the
 * CLI imports — e.g. a fixed npm package version whose `dist` predates an export
 * the CLI now uses — so a fresh `bun install` in a standalone clone produces
 * a `SyntaxError` at import time before any command runs. Measured 2026-09-01:
 * `git-super@0.1.0` on npm predates the `createGit` export its `worktree`
 * subpath now ships, so `bun bin/yrd.ts --help` failed at import time in a
 * fresh clone while the hh-dev superproject stayed green by resolving its
 * own vendored workspace copy of git-super instead.
 * @level l2
 * @consumer Every standalone clone of this repository — `git clone` + `bun
 * install` + `bun bin/yrd.ts` — including CI and external contributors who
 * do not have the hh-dev superproject's vendored packages masking a stale
 * public dependency.
 */
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

async function runCli(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "bin/yrd.ts", ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

describe("standalone CLI boot", () => {
  it("imports git-super after a frozen standalone Yrd install", async () => {
    const root = await mkdtemp(join(tmpdir(), "yrd-standalone-"))
    try {
      await copyFile(join(REPO_ROOT, "package.json"), join(root, "package.json"))
      await copyFile(join(REPO_ROOT, "bun.lock"), join(root, "bun.lock"))
      for (const entry of await readdir(join(REPO_ROOT, "packages"), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const packageDir = join(root, "packages", entry.name)
        await mkdir(packageDir, { recursive: true })
        await copyFile(join(REPO_ROOT, "packages", entry.name, "package.json"), join(packageDir, "package.json"))
      }

      const install = Bun.spawn(["bun", "install", "--frozen-lockfile"], {
        cwd: root,
        stdout: "ignore",
        stderr: "pipe",
      })
      const [installStderr, installExit] = await Promise.all([new Response(install.stderr).text(), install.exited])
      expect(installExit, installStderr).toBe(0)

      const imported = Bun.spawn(["bun", "-e", 'await import("git-super")'], {
        cwd: join(root, "packages", "yrd-bay"),
        stdout: "ignore",
        stderr: "pipe",
      })
      const [importStderr, importExit] = await Promise.all([new Response(imported.stderr).text(), imported.exited])
      expect(importExit, importStderr).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("imports and runs --help with no module-resolution errors", async () => {
    const { stdout, stderr, exitCode } = await runCli("--help")
    expect(stderr).not.toMatch(/SyntaxError/)
    expect(exitCode).toBe(0)
    expect(stdout).toContain("Usage: yrd")
  })

  it("imports and runs --version with no module-resolution errors", async () => {
    const { stdout, stderr, exitCode } = await runCli("--version")
    expect(stderr).not.toMatch(/SyntaxError/)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/^yrd \d+\.\d+\.\d+/)
  })
})
