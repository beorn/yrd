/**
 * @failure yrd submit refusal when git-super fails inlines git-super stderr into one
 *          4,300-character line with literal \n escapes, so line filters swallow the
 *          entire reason and hide the failing step, command, exit code, and git error.
 * @level   l2
 * @consumer seats running yrd submit when git-super worktree add fails
 * @testonly none
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { freshWorktree, gitIn } from "@yrd/queue-core"
import { runYrdProcess } from "../src/cli.ts"
import type { YrdCliExitCode, YrdCliIO } from "../src/types.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

type World = Readonly<{
  root: string
  remote: string
  work: string
}>

async function yrd(
  work: string,
  ...args: string[]
): Promise<
  Readonly<{
    exitCode: YrdCliExitCode
    stdout: string
    stderr: string
    report: string
  }>
> {
  let stdout = ""
  let stderr = ""
  const io: YrdCliIO = {
    color: false,
    cwd: work,
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
  }
  const exitCode = await runYrdProcess([process.execPath, "/usr/local/bin/yrd", ...args], io)
  return { exitCode, stdout, stderr, report: `yrd ${args.join(" ")} exited ${exitCode}\n${stdout}\n${stderr}` }
}

async function world(): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "yrd-submit-refusal-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])

  const git = gitIn(work)
  await git(["config", "user.email", "submit-refusal@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])

  writeFileSync(join(work, ".yrd.yml"), "checks:\n  - verify:\n      run: test -f .yrd.yml\n")
  writeFileSync(
    join(work, ".gitmodules"),
    '[submodule "vendor/sub"]\n\tpath = vendor/sub\n\turl = https://example.test/sub.git\n',
  )
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "initial main with .gitmodules"])
  await git(["push", "--quiet", "origin", "main"])

  // Configure a wrapper for yrd.git that mocks git super worktree add failure
  const wrapper = join(root, "git-wrapper.sh")
  writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      'case " $* " in *" super "*" worktree add "*)',
      "  cat << 'EOF' >&2",
      '{"commit":"13cbce41041ca97b280ec7264ef9c99618853b9e","detail":{"code":"worktree-materialize-failed","message":"worktree add /tmp/candidate at 13cbce41041ca97b280ec7264ef9c99618853b9e failed; the worktree was removed.\\nCloning into \'vendor/tribe\'...\\nerror: /hh/dev/.git/worktrees/25074-3d1c/modules/vendor/tribe/objects: ignoring alternate object stores, nesting too deep\\nfatal: bad object .alternate\\nfatal: remote did not send all necessary objects\\nFailed to clone \'vendor/tribe\'","phase":"materialize","remedy":"Repair the reported submodule condition"},"gitmodules":true,"partial":false,"path":"/tmp/candidate","repositories":[{"detail":{"code":"worktree-materialize-failed","message":"worktree add /tmp/candidate at 13cbce41041ca97b280ec7264ef9c99618853b9e failed; the worktree was removed.\\nCloning into \'vendor/tribe\'...\\nerror: /hh/dev/.git/worktrees/25074-3d1c/modules/vendor/tribe/objects: ignoring alternate object stores, nesting too deep\\nfatal: bad object .alternate\\nfatal: remote did not send all necessary objects\\nFailed to clone \'vendor/tribe\'","phase":"materialize","remedy":"Repair the reported submodule condition"},"refs":[],"repository":"/hh/var/wt/state-red","state":"failed"}],"requested":"13cbce41041ca97b280ec7264ef9c99618853b9e","state":"failed"}',
      "EOF",
      "  exit 2 ;;",
      "esac",
      'exec git "$@"',
      "",
    ].join("\n"),
  )
  chmodSync(wrapper, 0o755)
  await git(["config", "--local", "yrd.git", JSON.stringify({ executable: wrapper, contract: "native" })])

  return { root, remote, work }
}

describe("yrd submit refusal when git super worktree add fails (25979)", () => {
  it("prints failing step, command, exit code and unescaped git error with fatal first on separate lines", async () => {
    const w = await world()
    const git = gitIn(w.work)
    await git(["checkout", "--quiet", "-b", "task/fail-super"])
    writeFileSync(join(w.work, "change.txt"), "some change\n")
    await git(["add", "change.txt"])
    await git(["commit", "--quiet", "-m", "task/fail-super: change"])

    const res = await yrd(w.work, "submit", "task/fail-super", "--submitter", "@dev/8")
    expect(res.exitCode, res.report).toBe(2)

    // Stderr must be multiline
    const lines = res.stderr.split("\n").filter((l) => l.trim().length > 0)
    expect(lines.length, res.report).toBeGreaterThan(3)

    // Names step on its own line
    const stepLine = lines.find((l) => l.includes("worktree") && l.includes("git-super") && l.includes("failed"))
    expect(stepLine, res.report).toBeDefined()
    expect(stepLine, res.report).not.toContain("command:")
    expect(stepLine, res.report).not.toContain("exit code:")

    // Names command on its own line
    const commandLine = lines.find((l) => l.startsWith("command: git") || l.includes("command: git super"))
    expect(commandLine, res.report).toBeDefined()
    expect(commandLine, res.report).not.toContain("exit code:")

    // Names exit code on its own line
    const exitLine = lines.find((l) => l.startsWith("exit code: 2") || l.includes("exit code: 2"))
    expect(exitLine, res.report).toBeDefined()

    // Git error: fatal line is first among stderr lines and unescaped
    const fatalIndex = lines.findIndex((l) => l.startsWith("fatal: bad object .alternate"))
    expect(fatalIndex, res.report).toBeGreaterThan(-1)

    // Unescaped: no literal \n escapes
    expect(res.stderr, res.report).not.toContain("\\n")

    // The fatal line appears before the non-fatal error lines
    const errorIndex = lines.findIndex((l) => l.includes("ignoring alternate object stores"))
    expect(errorIndex, res.report).toBeGreaterThan(fatalIndex)
  })

  it("prints the refusal naming step, command, exit code and git error on separate lines under --json", async () => {
    const w = await world()
    const git = gitIn(w.work)
    await git(["checkout", "--quiet", "-b", "task/fail-super-json"])
    writeFileSync(join(w.work, "change.txt"), "some change json\n")
    await git(["add", "change.txt"])
    await git(["commit", "--quiet", "-m", "task/fail-super-json: change"])

    const res = await yrd(w.work, "submit", "task/fail-super-json", "--submitter", "@dev/8", "--json")
    expect(res.exitCode, res.report).toBe(2)

    const lines = res.stderr.split("\n").filter((l) => l.trim().length > 0)
    expect(lines.length, res.report).toBeGreaterThan(3)

    const stepLine = lines.find((l) => l.includes("worktree") && l.includes("git-super") && l.includes("failed"))
    expect(stepLine, res.report).toBeDefined()

    const commandLine = lines.find((l) => l.startsWith("command: git") || l.includes("command: git super"))
    expect(commandLine, res.report).toBeDefined()

    const exitLine = lines.find((l) => l.startsWith("exit code: 2") || l.includes("exit code: 2"))
    expect(exitLine, res.report).toBeDefined()

    const fatalIndex = lines.findIndex((l) => l.startsWith("fatal: bad object .alternate"))
    expect(fatalIndex, res.report).toBeGreaterThan(-1)

    expect(res.stderr, res.report).not.toContain("\\n")
  })

  it("prints exit code none and error message without synthesized command on non-git spawn failure (25979 P3)", async () => {
    async function said(thrown: unknown): Promise<string> {
      const git = (async (args: readonly string[]) => {
        if (args[0] === "ls-tree") return "100644 blob 0123456789abcdef0123456789abcdef01234567\t.gitmodules\n"
        if (args[0] === "super") throw thrown
        return ""
      }) as never
      try {
        await freshWorktree(git, "/repo", "c0ffee", "/work/bay")
        return "(no error)"
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }

    const resolution = await said(new Error("not found on the selected environment's PATH"))
    const resLines = resolution.split("\n").filter((l) => l.trim().length > 0)
    expect(resLines[0]).toContain(
      "worktree /work/bay at c0ffee requires git-super because that commit records .gitmodules; git super worktree add failed:",
    )
    expect(resLines[1]).toBe("exit code: none (the command did not run)")
    expect(resLines.some((l) => l.startsWith("command:"))).toBe(false)
    expect(resLines).toContain("not found on the selected environment's PATH")
    expect(resLines).not.toContain("exit code: 2")

    const enoent = await said(new Error("spawn git-super ENOENT"))
    const enoentLines = enoent.split("\n").filter((l) => l.trim().length > 0)
    expect(enoentLines[0]).toContain(
      "worktree /work/bay at c0ffee requires git-super because that commit records .gitmodules; git super worktree add failed:",
    )
    expect(enoentLines[1]).toBe("exit code: none (the command did not run)")
    expect(enoentLines.some((l) => l.startsWith("command:"))).toBe(false)
    expect(enoentLines).toContain("spawn git-super ENOENT")
    expect(enoentLines).not.toContain("exit code: 2")
  })
})
