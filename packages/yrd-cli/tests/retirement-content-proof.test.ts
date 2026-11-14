/**
 * @failure A rebuilt landing keeps its branch forever because reachability ignores equivalent patches, or a
 * merge, empty or squashed landing retires on a per-commit patch match that never covered it (34265).
 * @level l2 (real Git; temporary roots under the OS temp dir)
 * @consumer Yrd post-merge local and root retirement
 * @reach fs-walk <fixture-only: temporary native Git repositories>
 * @testonly none
 */
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { testGitIn as gitIn } from "../../../tests/support/test-git-in.ts"
import { patchEquivalentOffTarget } from "../src/retirement-content-proof.ts"

describe("patch equivalence off the target", () => {
  // @failure A rebuilt landing keeps its branch forever because reachability ignores equivalent patches (34265).
  // @level l2; @consumer branch retirement; @testonly none
  it("accepts a landing re-landed as its own commits without ancestry", async () => {
    const { root, git } = await equivalenceFixture("patch-equivalent-rebuilt")
    const base = await commitFiles(root, git, { "r.txt": "r\n" }, "root")
    await commitFiles(root, git, { "a.txt": "1\n" }, "main a")
    await commitFiles(root, git, { "b.txt": "2\n" }, "main b")
    await git(["checkout", "--quiet", base])
    await commitFiles(root, git, { "a.txt": "1\n" }, "branch a")
    await commitFiles(root, git, { "b.txt": "2\n" }, "branch b")
    const tip = (await git(["rev-parse", "HEAD"])).trim()
    await git(["checkout", "--quiet", "main"])
    await expect(patchEquivalentOffTarget(git, "main", tip)).resolves.toBe(true)
  })

  // @failure A merge's own content is invisible to `git cherry`, so every listed commit matches and the
  // retirement deletes a branch whose unique merge content the target never received (@cto, 34265).
  // @level l2; @consumer branch retirement; @testonly none
  it("refuses a tip whose off-target range holds a merge, even when every listed commit matches", async () => {
    const { root, git } = await equivalenceFixture("patch-equivalent-merge")
    const base = await commitFiles(root, git, { "r.txt": "r\n" }, "root")
    await commitFiles(root, git, { "x.txt": "1\n" }, "main x")
    await commitFiles(root, git, { "y.txt": "2\n" }, "main y")
    await git(["checkout", "--quiet", base])
    const first = await commitFiles(root, git, { "x.txt": "1\n" }, "branch x")
    await git(["checkout", "--quiet", "-b", "side"])
    const second = await commitFiles(root, git, { "y.txt": "2\n" }, "branch y")
    await git(["checkout", "--quiet", first])
    await git(["merge", "--quiet", "--no-commit", "--no-ff", second])
    writeFileSync(join(root, "h.txt"), "unique merge content\n")
    await git(["add", "-A"])
    await git(["commit", "--quiet", "-m", "merge carrying its own content"])
    const tip = (await git(["rev-parse", "HEAD"])).trim()
    await git(["checkout", "--quiet", "main"])
    const listed = (await git(["cherry", "main", tip])).trim().split("\n")
    expect(listed.length).toBeGreaterThan(0)
    expect(listed.every((line) => line.startsWith("- "))).toBe(true)
    await expect(patchEquivalentOffTarget(git, "main", tip)).resolves.toBe(false)
  })

  // @failure A target that replays two branch commits as one squash is read as the same content (34265).
  // @level l2; @consumer branch retirement; @testonly none
  it("keeps a multi-commit squash the target replays as one commit", async () => {
    const { root, git } = await equivalenceFixture("patch-equivalent-squash")
    const base = await commitFiles(root, git, { "r.txt": "r\n" }, "root")
    await commitFiles(root, git, { "a.txt": "1\n", "b.txt": "2\n" }, "main both")
    await git(["checkout", "--quiet", base])
    await commitFiles(root, git, { "a.txt": "1\n" }, "branch a")
    await commitFiles(root, git, { "b.txt": "2\n" }, "branch b")
    const tip = (await git(["rev-parse", "HEAD"])).trim()
    await git(["checkout", "--quiet", "main"])
    await expect(patchEquivalentOffTarget(git, "main", tip)).resolves.toBe(false)
  })

  // @failure A graph-only empty commit has no patch to match and is read as landed, discarding branch history.
  // @level l2; @consumer branch retirement; @testonly none
  it("keeps a graph-only empty commit", async () => {
    const { root, git } = await equivalenceFixture("patch-equivalent-empty")
    await commitFiles(root, git, { "r.txt": "r\n" }, "root")
    await commitFiles(root, git, { "a.txt": "1\n" }, "main a")
    await git(["commit", "--quiet", "--allow-empty", "-m", "graph only"])
    const tip = (await git(["rev-parse", "HEAD"])).trim()
    await expect(patchEquivalentOffTarget(git, "main", tip)).resolves.toBe(false)
  })

  // @failure A nonempty match earlier in the range is read as covering a later empty commit, so the branch's
  // graph-only commit — which no target commit can match — is dropped with it (34265, @cto claim check).
  // @level l2; @consumer branch retirement; @testonly none
  it("keeps an empty commit that follows a matching commit", async () => {
    const { root, git } = await equivalenceFixture("patch-equivalent-matched-then-empty")
    const base = await commitFiles(root, git, { "r.txt": "r\n" }, "root")
    await commitFiles(root, git, { "a.txt": "1\n" }, "main a")
    await git(["checkout", "--quiet", base])
    await commitFiles(root, git, { "a.txt": "1\n" }, "branch a")
    await git(["commit", "--quiet", "--allow-empty", "-m", "graph only after a match"])
    const tip = (await git(["rev-parse", "HEAD"])).trim()
    await git(["checkout", "--quiet", "main"])
    const listed = (await git(["cherry", "main", tip])).trim().split("\n")
    expect(listed).toHaveLength(2)
    expect(listed.filter((line) => line.startsWith("- "))).toHaveLength(1)
    await expect(patchEquivalentOffTarget(git, "main", tip)).resolves.toBe(false)
  })

  // @failure A tip with one commit the target never received is read as fully landed (34265).
  // @level l2; @consumer branch retirement; @testonly none
  it("keeps a tip with an unmatched commit", async () => {
    const { root, git } = await equivalenceFixture("patch-equivalent-partial")
    const base = await commitFiles(root, git, { "r.txt": "r\n" }, "root")
    await commitFiles(root, git, { "a.txt": "1\n" }, "main a")
    await git(["checkout", "--quiet", base])
    await commitFiles(root, git, { "a.txt": "1\n" }, "branch a")
    await commitFiles(root, git, { "b.txt": "2\n" }, "branch b")
    const tip = (await git(["rev-parse", "HEAD"])).trim()
    await git(["checkout", "--quiet", "main"])
    await expect(patchEquivalentOffTarget(git, "main", tip)).resolves.toBe(false)
  })
})

async function equivalenceFixture(name: string): Promise<{ root: string; git: ReturnType<typeof gitIn> }> {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `yrd-retirement-proof-${name}-`))
  const git = gitIn(root)
  await git(["init", "--quiet", "--initial-branch=main"])
  await git(["config", "user.name", "fixture"])
  await git(["config", "user.email", "fixture@yrd.test"])
  return { root, git }
}

async function commitFiles(
  root: string,
  git: ReturnType<typeof gitIn>,
  files: Record<string, string>,
  message: string,
): Promise<string> {
  for (const [file, content] of Object.entries(files)) writeFileSync(join(root, file), content)
  await git(["add", "-A"])
  await git(["commit", "--quiet", "-m", message])
  return (await git(["rev-parse", "HEAD"])).trim()
}
