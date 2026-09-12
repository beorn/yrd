/**
 * @failure  The queue judges a change in a merge root whose files are not the
 *           ones the merge commit records, and nothing says so — the root is
 *           torn down as the run ends, so every later diagnosis is an inference
 *           from behaviour (@i/10-yrd/24573).
 * @level    l2 (real Git — the subject is what is ON DISK versus what a commit
 *           records, and a stubbed Git cannot disagree with itself)
 * @consumer merge() in run.ts, immediately before the on-merge checks run
 */

import { afterEach, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { judgedTreeDigest } from "../src/worktree.ts"

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { force: true, recursive: true })
})

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

/**
 * A base commit and a candidate that changes one root file — the incident's
 * shape, where the other side never touched the file at all.
 */
function repoWithACandidate(): { repo: string; base: string; candidate: string } {
  const repo = mkdtempSync(join(tmpdir(), "yrd-judged-"))
  scratch.push(repo)
  git(repo, ["init", "-q", "-b", "main"])
  git(repo, ["config", "user.email", "test@example.com"])
  git(repo, ["config", "user.name", "Test"])
  writeFileSync(join(repo, "tool.ts"), "export function existing() {}\n")
  writeFileSync(join(repo, "untouched.ts"), "export const keep = 1\n")
  git(repo, ["add", "-A"])
  git(repo, ["commit", "-q", "-m", "base"])
  const base = git(repo, ["rev-parse", "HEAD"])

  writeFileSync(join(repo, "tool.ts"), "export function existing() {}\nexport function rootJudgedTest() {}\n")
  git(repo, ["add", "tool.ts"])
  git(repo, ["commit", "-q", "-m", "candidate adds a symbol"])
  const candidate = git(repo, ["rev-parse", "HEAD"])
  return { base, candidate, repo }
}

describe("judgedTreeDigest says what the checks are about to read (24573)", () => {
  it("reports the changed path as matching when the tree really is the commit", async () => {
    const { repo, base, candidate } = repoWithACandidate()

    const files = await judgedTreeDigest(repo, { base, candidate })

    // Only the path the candidate changed: a file neither side touched is not
    // what a stale tree silently reverts, and hashing it would be noise.
    expect(files.map((file) => file.path)).toEqual(["tool.ts"])
    expect(files[0]?.same).toBe(true)
    expect(files[0]?.committed).toBe(files[0]?.ondisk)
  })

  it("FIRES when the bytes on disk are not the commit's — the whole point", async () => {
    const { repo, base, candidate } = repoWithACandidate()
    // Exactly the reported symptom: the file on disk is the version WITHOUT the
    // symbol, while HEAD records the version with it. No git verb can produce
    // this state honestly, which is why it went unexplained for three rounds.
    writeFileSync(join(repo, "tool.ts"), "export function existing() {}\n")

    const files = await judgedTreeDigest(repo, { base, candidate })

    expect(files[0]?.same, "a root that is not its own commit must not read as clean").toBe(false)
    expect(files[0]?.committed).not.toBe(files[0]?.ondisk)
  })

  it("reports a DELETED path as a row rather than omitting it", async () => {
    const repo = mkdtempSync(join(tmpdir(), "yrd-judged-del-"))
    scratch.push(repo)
    git(repo, ["init", "-q", "-b", "main"])
    git(repo, ["config", "user.email", "test@example.com"])
    git(repo, ["config", "user.name", "Test"])
    writeFileSync(join(repo, "gone.ts"), "export const gone = 1\n")
    git(repo, ["add", "-A"])
    git(repo, ["commit", "-q", "-m", "base"])
    const base = git(repo, ["rev-parse", "HEAD"])
    git(repo, ["rm", "-q", "gone.ts"])
    git(repo, ["commit", "-q", "-m", "candidate deletes it"])
    const candidate = git(repo, ["rev-parse", "HEAD"])

    const files = await judgedTreeDigest(repo, { base, candidate })

    // The deletion was carried out. That is a different fact from the path never
    // having been looked at, and an omitted row cannot express it.
    expect(files.map((file) => file.path)).toEqual(["gone.ts"])
    expect(files[0]?.committed).toBe("deleted")
    expect(files[0]?.ondisk).toBe("absent")
    expect(files[0]?.same).toBe(true)
  })

  it.each([
    { mutation: undefined, same: true, title: "matches a candidate-added symlink by its stored link text" },
    {
      mutation: "untouched.ts",
      same: false,
      title: "FIRES when a candidate-added symlink's link text changes on disk",
    },
  ])("$title", async ({ mutation, same }) => {
    const { repo, base } = repoWithACandidate()
    symlinkSync("tool.ts", join(repo, "link.ts"))
    git(repo, ["add", "link.ts"])
    git(repo, ["commit", "-q", "-m", "candidate adds a link"])
    const candidate = git(repo, ["rev-parse", "HEAD"])
    if (mutation !== undefined) {
      rmSync(join(repo, "link.ts"))
      symlinkSync(mutation, join(repo, "link.ts"))
    }

    const link = (await judgedTreeDigest(repo, { base, candidate })).find((file) => file.path === "link.ts")

    expect(link?.same).toBe(same)
    if (same) expect(link?.committed).toBe(link?.ondisk)
    else expect(link?.committed).not.toBe(link?.ondisk)
  })

  it("skips gitlinks, whose pins the settle rows already carry", async () => {
    const { repo, base, candidate } = repoWithACandidate()
    const sub = mkdtempSync(join(tmpdir(), "yrd-judged-sub-"))
    scratch.push(sub)
    git(sub, ["init", "-q", "-b", "main"])
    git(sub, ["config", "user.email", "test@example.com"])
    git(sub, ["config", "user.name", "Test"])
    writeFileSync(join(sub, "lib.ts"), "export const lib = 1\n")
    git(sub, ["add", "-A"])
    git(sub, ["commit", "-q", "-m", "sub"])
    git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "vendor/pkg"])
    git(repo, ["commit", "-q", "-m", "candidate adds a submodule"])
    const withGitlink = git(repo, ["rev-parse", "HEAD"])

    const files = await judgedTreeDigest(repo, { base, candidate: withGitlink })

    // .gitmodules is an ordinary file and belongs; the gitlink itself is a
    // directory here and hashing it would fail or, worse, hash something else.
    expect(files.map((file) => file.path).sort()).toEqual([".gitmodules", "tool.ts"])
    expect(files.every((file) => file.same)).toBe(true)
    void base
    void candidate
  })
})
