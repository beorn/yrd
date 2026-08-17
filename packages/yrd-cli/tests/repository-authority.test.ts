/**
 * @failure A composition host resolves a repository selector to a linked worktree or to an inherited GIT_DIR, so one shared journal is opened through two different authorities and the refusal that should name the missing repository never fires.
 * @level l2
 * @consumer @yrd/cli composition hosts selecting a named repository, and every command that must find one common Git directory
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { repositoryAuthority, repositoryGitDir } from "../src/repository-authority.ts"

const roots: string[] = []

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  // macOS hands out /var/... symlinks for the temporary directory; Git reports
  // the real path, so every expectation below compares against the real one.
  return execFileSync("bash", ["-c", `cd ${JSON.stringify(root)} && pwd -P`], { encoding: "utf8" }).trim()
}

function initRepository(prefix: string): string {
  const repo = temporaryRoot(prefix)
  execFileSync("git", ["init", "-q", repo])
  return repo
}

function addWorktree(repo: string, name: string): string {
  const path = join(repo, "..", name)
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "root"], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "yrd",
      GIT_AUTHOR_EMAIL: "yrd@example.invalid",
      GIT_COMMITTER_NAME: "yrd",
      GIT_COMMITTER_EMAIL: "yrd@example.invalid",
    },
  })
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", name, path])
  return resolve(path)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("repositoryAuthority", () => {
  it("returns the repository itself when it owns a real .git directory", () => {
    const repo = initRepository("yrd-authority-primary-")
    expect(repositoryAuthority(repo)).toBe(repo)
  })

  it("resolves a linked worktree to the primary worktree that owns the shared journal", () => {
    const repo = initRepository("yrd-authority-linked-")
    const linked = addWorktree(repo, "yrd-authority-linked-slot")
    roots.push(linked)
    expect(repositoryAuthority(linked)).toBe(repo)
  })

  it("refuses a declared repository with no .git, naming the exact path it looked for", () => {
    const plain = temporaryRoot("yrd-authority-missing-")
    expect(() => repositoryAuthority(plain)).toThrow(`yrd: declared repository ${plain} has no ${join(plain, ".git")}`)
  })

  it("ignores an inherited GIT_DIR when resolving authority", () => {
    const repo = initRepository("yrd-authority-ambient-")
    const other = initRepository("yrd-authority-ambient-other-")
    const linked = addWorktree(repo, "yrd-authority-ambient-slot")
    roots.push(linked)
    const previous = process.env.GIT_DIR
    process.env.GIT_DIR = join(other, ".git")
    try {
      expect(repositoryAuthority(linked)).toBe(repo)
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previous
    }
  })
})

describe("repositoryGitDir", () => {
  it("prefers the declared repository over environment and cwd", () => {
    const declared = initRepository("yrd-gitdir-declared-")
    const ambient = initRepository("yrd-gitdir-ambient-")
    expect(repositoryGitDir({ selected: declared, env: { YRD_REPO: ambient }, cwd: ambient })).toBe(
      join(declared, ".git"),
    )
  })

  it("refuses a declared repository that is not a Git repository", () => {
    const plain = temporaryRoot("yrd-gitdir-declared-missing-")
    expect(() => repositoryGitDir({ selected: plain, env: {}, cwd: plain })).toThrow(
      `yrd: declared repository ${plain} has no ${join(plain, ".git")}`,
    )
  })

  it("falls back to YRD_REPO when nothing is declared", () => {
    const repo = initRepository("yrd-gitdir-env-")
    const elsewhere = temporaryRoot("yrd-gitdir-env-cwd-")
    expect(repositoryGitDir({ env: { YRD_REPO: repo }, cwd: elsewhere })).toBe(join(repo, ".git"))
  })

  it("refuses a YRD_REPO that is not a Git repository, naming the variable and the remedy", () => {
    const plain = temporaryRoot("yrd-gitdir-env-missing-")
    expect(() => repositoryGitDir({ env: { YRD_REPO: plain }, cwd: plain })).toThrow(
      `yrd: YRD_REPO=${plain} is not a Git repository (${join(plain, ".git")} is missing); ` +
        `point YRD_REPO at the repository this command operates on`,
    )
  })

  it("walks up from the invocation directory when nothing is declared", () => {
    const repo = initRepository("yrd-gitdir-walk-")
    const nested = join(repo, "deep", "nested")
    mkdirSync(nested, { recursive: true })
    expect(repositoryGitDir({ env: {}, cwd: nested })).toBe(join(repo, ".git"))
  })

  it("uses the runtime root only after the cwd walk finds nothing", () => {
    const runtime = initRepository("yrd-gitdir-runtime-")
    const bare = temporaryRoot("yrd-gitdir-runtime-cwd-")
    expect(repositoryGitDir({ env: {}, cwd: bare, runtimeRoot: runtime })).toBe(join(runtime, ".git"))
  })

  it("refuses when no repository is reachable and none is declared", () => {
    const bare = temporaryRoot("yrd-gitdir-none-")
    expect(() => repositoryGitDir({ env: {}, cwd: bare })).toThrow(
      `yrd: no Git repository at or above ${bare} and none declared; set YRD_REPO`,
    )
  })

  it("resolves a linked worktree to the common Git directory the primary owns", () => {
    const repo = initRepository("yrd-gitdir-linked-")
    const linked = addWorktree(repo, "yrd-gitdir-linked-slot")
    roots.push(linked)
    expect(repositoryGitDir({ selected: linked, env: {}, cwd: linked })).toBe(join(repo, ".git"))
  })
})
