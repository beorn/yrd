/**
 * @reach fs-walk vendor/yrd/packages/*\/package.json vendor/yrd/package.json vendor/yrd/bun.lock
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
 * Linked worktree dependencies must load before test collection; a missing
 * own dependency must still fail loudly even when an ancestor can resolve it.
 */
import { existsSync } from "node:fs"
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, unlink } from "node:fs/promises"
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
  it("imports git-super after a frozen standalone Yrd install", async ({ onTestFailed }) => {
    let phase = "create standalone fixture"
    let failedPhase: string | undefined
    onTestFailed(() => {
      console.error(`Standalone boot failed during ${failedPhase ?? phase}; last phase: ${phase}`)
    })
    const root = await mkdtemp(join(tmpdir(), "yrd-standalone-"))
    try {
      phase = "copy standalone manifests"
      await copyFile(join(REPO_ROOT, "package.json"), join(root, "package.json"))
      await copyFile(join(REPO_ROOT, "bun.lock"), join(root, "bun.lock"))
      for (const entry of await readdir(join(REPO_ROOT, "packages"), { withFileTypes: true })) {
        if (!entry.isDirectory() || !existsSync(join(REPO_ROOT, "packages", entry.name, "package.json"))) continue
        const packageDir = join(root, "packages", entry.name)
        await mkdir(packageDir, { recursive: true })
        await copyFile(join(REPO_ROOT, "packages", entry.name, "package.json"), join(packageDir, "package.json"))
      }

      phase = "bun install --frozen-lockfile"
      const install = Bun.spawn(["bun", "install", "--frozen-lockfile"], {
        cwd: root,
        stdout: "ignore",
        stderr: "pipe",
      })
      const [installStderr, installExit] = await Promise.all([new Response(install.stderr).text(), install.exited])
      expect(installExit, installStderr).toBe(0)

      phase = "import installed git-super"
      const imported = Bun.spawn(["bun", "-e", 'await import("git-super")'], {
        cwd: join(root, "packages", "yrd-bay"),
        stdout: "ignore",
        stderr: "pipe",
      })
      const [importStderr, importExit] = await Promise.all([new Response(imported.stderr).text(), imported.exited])
      expect(importExit, importStderr).toBe(0)

      // 27306: successful package import alone can mask the enclosing Yrd HEAD
      // being mistaken for the installed archive's pinned Git Super identity.
      phase = "prepare dependency selector fixture and git init"
      await mkdir(join(root, "tests", "support"), { recursive: true })
      await copyFile(
        join(REPO_ROOT, "tests", "support", "git-super-bin.ts"),
        join(root, "tests", "support", "git-super-bin.ts"),
      )
      const init = Bun.spawn(["git", "init", root], { stdout: "ignore", stderr: "pipe" })
      const [initStderr, initExit] = await Promise.all([new Response(init.stderr).text(), init.exited])
      expect(initExit, initStderr).toBe(0)
      const selectCommand = [
        "bun",
        "-e",
        'const selected = await import("./tests/support/git-super-bin.ts"); console.log(JSON.stringify({bin: selected.gitSuperBin, sha: selected.gitSuperSha}))',
      ]
      phase = "select installed git-super identity"
      const selected = Bun.spawn(selectCommand, { cwd: root, stdout: "pipe", stderr: "pipe" })
      const [selectionStdout, selectionStderr, selectionExit] = await Promise.all([
        new Response(selected.stdout).text(),
        new Response(selected.stderr).text(),
        selected.exited,
      ])
      expect(selectionExit, selectionStderr).toBe(0)
      const selection = JSON.parse(selectionStdout) as { bin: string; sha: string }
      const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
        overrides: Record<string, string>
      }
      const declared = manifest.overrides["git-super"]
      if (declared === undefined) throw new Error("standalone fixture requires its declared git-super override")
      expect(selection.sha).toBe(declared.split("#")[1])
      expect(selection.bin.startsWith(join(root, "node_modules") + "/")).toBe(true)

      // Worktree tooling links node_modules, whose package entries may themselves
      // point outside that directory. The installed dependency still owns its bin.
      phase = "prepare linked dependency fixture"
      const linkedModules = join(root, "linked-modules")
      const worktree = join(root, "standalone-worktree")
      await mkdir(linkedModules)
      await mkdir(join(worktree, "tests", "support"), { recursive: true })
      await symlink(await realpath(join(root, "node_modules", "git-super")), join(linkedModules, "git-super"), "dir")
      await symlink(linkedModules, join(worktree, "node_modules"), "dir")
      for (const file of ["package.json", "bun.lock", "tests/support/git-super-bin.ts"]) {
        await copyFile(join(root, file), join(worktree, file))
      }
      phase = "select linked git-super identity"
      const linked = Bun.spawn(selectCommand, { cwd: worktree, stdout: "pipe", stderr: "pipe" })
      const [linkedStdout, linkedStderr, linkedExit] = await Promise.all([
        new Response(linked.stdout).text(),
        new Response(linked.stderr).text(),
        linked.exited,
      ])
      expect(linkedExit, linkedStderr).toBe(0)
      expect(JSON.parse(linkedStdout)).toEqual({
        bin: await realpath(join(root, "node_modules", "git-super", "bin")),
        sha: declared.split("#")[1],
      })

      phase = "reject missing own git-super dependency"
      await unlink(join(linkedModules, "git-super"))
      const missing = Bun.spawn(selectCommand, { cwd: worktree, stdout: "ignore", stderr: "pipe" })
      const [missingStderr, missingExit] = await Promise.all([new Response(missing.stderr).text(), missing.exited])
      expect(missingExit).not.toBe(0)
      expect(missingStderr).toContain(join(worktree, "node_modules", "git-super"))
      expect(missingStderr).toContain(await realpath(join(root, "node_modules", "git-super", "package.json")))
    } catch (error) {
      failedPhase = phase
      throw error
    } finally {
      phase = "remove standalone fixture"
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
