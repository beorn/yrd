/**
 * @failure A rebuild whose candidate tree is identical to its base cannot be refused as
 *          empty, or the delta misnames what changed — a gitlink move read as content, a
 *          nested path truncated, a malformed record silently narrowed to fewer entries.
 * @level l1
 * @consumer the empty-candidate refusal on the re-merge path (Phase 1)
 *
 * Every case runs over a real repository: `exactDelta` is a read of git's own
 * tree facts, so the fixtures are genuine trees, not canned strings.
 */
import { mkdtemp, rm, symlink, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { exactDelta, formatExactDelta } from "../src/content-identity.ts"
import { bothSidesMovedGitlinkFixture, fixtureRefGit } from "./support/remerge-fixtures.ts"

const git = fixtureRefGit()
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-content-identity-"))
  roots.push(root)
  const repo = join(root, "repo")
  await git.run(root, ["init", "-b", "main", "repo"])
  return repo
}

async function commitFile(repo: string, path: string, content: string, message: string): Promise<string> {
  await Bun.write(join(repo, path), content)
  await git.run(repo, ["add", "--", path])
  await git.run(repo, ["commit", "-m", message])
  return git.run(repo, ["rev-parse", "HEAD"])
}

describe("exactDelta", () => {
  it("reports an empty delta for one commit against itself", async () => {
    const repo = await makeRepo()
    const sha = await commitFile(repo, "a.txt", "one\n", "base")

    const delta = await exactDelta(git, repo, sha, sha)

    expect(delta.entries).toEqual([])
    expect(delta.baseTree).toBe(delta.candidateTree)
    expect(delta.baseTree).toBe(await git.run(repo, ["rev-parse", `${sha}^{tree}`]))
  })

  it("reports an empty delta for distinct commits whose trees are identical", async () => {
    const repo = await makeRepo()
    const first = await commitFile(repo, "a.txt", "one\n", "base")
    await git.run(repo, ["commit", "--allow-empty", "-m", "no tree change"])
    const second = await git.run(repo, ["rev-parse", "HEAD"])

    expect(second).not.toBe(first)
    const delta = await exactDelta(git, repo, first, second)

    expect(delta.entries).toEqual([])
    expect(delta.baseTree).toBe(delta.candidateTree)
  })

  it("names a content change with its path, kind and both object ids", async () => {
    const repo = await makeRepo()
    const base = await commitFile(repo, "a.txt", "one\n", "base")
    const changed = await commitFile(repo, "a.txt", "two\n", "change")

    const delta = await exactDelta(git, repo, base, changed)

    expect(delta.baseTree).toBe(await git.run(repo, ["rev-parse", `${base}^{tree}`]))
    expect(delta.candidateTree).toBe(await git.run(repo, ["rev-parse", `${changed}^{tree}`]))
    expect(delta.entries).toHaveLength(1)
    const entry = delta.entries[0]
    expect(entry).toMatchObject({ path: "a.txt", kind: "modified", object: "blob" })
    expect(entry?.baseOid).toBe(await git.run(repo, ["rev-parse", `${base}:a.txt`]))
    expect(entry?.candidateOid).toBe(await git.run(repo, ["rev-parse", `${changed}:a.txt`]))
  })

  it("names added and deleted paths, leaving the absent side unset", async () => {
    const repo = await makeRepo()
    const base = await commitFile(repo, "old.txt", "old\n", "base")
    await unlink(join(repo, "old.txt"))
    await Bun.write(join(repo, "new.txt"), "new\n")
    await git.run(repo, ["add", "--all"])
    await git.run(repo, ["commit", "-m", "swap files"])
    const swapped = await git.run(repo, ["rev-parse", "HEAD"])

    const delta = await exactDelta(git, repo, base, swapped)

    expect(delta.entries.map((entry) => [entry.kind, entry.path])).toEqual([
      ["added", "new.txt"],
      ["deleted", "old.txt"],
    ])
    const added = delta.entries[0]
    expect(added?.baseOid).toBeUndefined()
    expect(added?.baseMode).toBeUndefined()
    expect(added?.candidateOid).toBe(await git.run(repo, ["rev-parse", `${swapped}:new.txt`]))
    const deleted = delta.entries[1]
    expect(deleted?.candidateOid).toBeUndefined()
    expect(deleted?.candidateMode).toBeUndefined()
    expect(deleted?.baseOid).toBe(await git.run(repo, ["rev-parse", `${base}:old.txt`]))
  })

  it("names nested paths in full", async () => {
    const repo = await makeRepo()
    const base = await commitFile(repo, "top.txt", "top\n", "base")
    await Bun.write(join(repo, "deep/nested/dir/leaf.txt"), "leaf\n")
    await git.run(repo, ["add", "--all"])
    await git.run(repo, ["commit", "-m", "nested add"])
    const nested = await git.run(repo, ["rev-parse", "HEAD"])

    const delta = await exactDelta(git, repo, base, nested)

    expect(delta.entries.map((entry) => entry.path)).toEqual(["deep/nested/dir/leaf.txt"])
    expect(delta.entries[0]?.kind).toBe("added")
  })

  it("reports a blob-to-symlink switch as a typechange", async () => {
    const repo = await makeRepo()
    await commitFile(repo, "target.txt", "content\n", "target")
    const base = await commitFile(repo, "entry", "plain file\n", "entry as blob")
    await unlink(join(repo, "entry"))
    await symlink("target.txt", join(repo, "entry"))
    await git.run(repo, ["add", "--all"])
    await git.run(repo, ["commit", "-m", "entry becomes a symlink"])
    const linked = await git.run(repo, ["rev-parse", "HEAD"])

    const delta = await exactDelta(git, repo, base, linked)

    expect(delta.entries).toHaveLength(1)
    expect(delta.entries[0]).toMatchObject({
      path: "entry",
      kind: "typechange",
      object: "symlink",
      baseMode: "100644",
      candidateMode: "120000",
    })
  })

  it("names a gitlink-only change with its object kind and both recorded submodule commits", async () => {
    const fixture = await bothSidesMovedGitlinkFixture()
    roots.push(fixture.root)

    const delta = await exactDelta(git, fixture.superRepo, fixture.baseSha, fixture.mainTip)

    expect(delta.entries).toHaveLength(1)
    expect(delta.entries[0]).toMatchObject({
      path: fixture.gitlinkPath,
      kind: "modified",
      object: "gitlink",
      baseMode: "160000",
      candidateMode: "160000",
      baseOid: fixture.baseGitlink,
      candidateOid: fixture.mainGitlink,
    })
  })

  it("accepts tree object ids directly, not only commits", async () => {
    const repo = await makeRepo()
    const base = await commitFile(repo, "a.txt", "one\n", "base")
    const changed = await commitFile(repo, "a.txt", "two\n", "change")
    const baseTree = await git.run(repo, ["rev-parse", `${base}^{tree}`])
    const changedTree = await git.run(repo, ["rev-parse", `${changed}^{tree}`])

    const delta = await exactDelta(git, repo, baseTree, changedTree)

    expect(delta.baseTree).toBe(baseTree)
    expect(delta.candidateTree).toBe(changedTree)
    expect(delta.entries.map((entry) => entry.path)).toEqual(["a.txt"])
  })

  it("throws on an identity git cannot resolve instead of answering empty", async () => {
    const repo = await makeRepo()
    const sha = await commitFile(repo, "a.txt", "one\n", "base")

    await expect(exactDelta(git, repo, sha, "no-such-identity")).rejects.toThrow(/no-such-identity|exited/u)
  })
})

describe("formatExactDelta", () => {
  it("prints both tree shas and the explicit no-changed-paths fact for an empty delta", async () => {
    const repo = await makeRepo()
    const sha = await commitFile(repo, "a.txt", "one\n", "base")

    const delta = await exactDelta(git, repo, sha, sha)
    const rendered = formatExactDelta(delta)

    expect(rendered).toBe(
      `exact delta: base tree ${delta.baseTree} -> candidate tree ${delta.candidateTree}: no changed paths`,
    )
  })

  it("prints one line per changed path with kind and object", async () => {
    const repo = await makeRepo()
    const base = await commitFile(repo, "a.txt", "one\n", "base")
    const changed = await commitFile(repo, "a.txt", "two\n", "change")

    const delta = await exactDelta(git, repo, base, changed)
    const rendered = formatExactDelta(delta)

    expect(rendered).toContain(delta.baseTree)
    expect(rendered).toContain(delta.candidateTree)
    expect(rendered).toContain("1 changed path(s)")
    expect(rendered).toContain("  modified blob a.txt")
  })
})
