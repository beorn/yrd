/**
 * @failure A verdict or review binds to a key that moves when main edits NEAR the
 *          change (context drift breaks the binding, the burn-in's PR1028 defect) —
 *          or worse, a key that fails to move when the change's own content moved,
 *          silently carrying authorization onto different code (a false merge).
 * @level l1
 * @consumer verdict binding, the review door and note keying (identity consumers 1
 *           and 2), re-anchored on this key by @i/10-merge-queue/binding-key-replaces-patch-id
 *
 * Every case runs over a real repository, and the two burn-in mechanisms are
 * reproduced non-vacuously: the context-drift case asserts that `git patch-id
 * --stable` DOES move on the same pair before asserting the binding key does not.
 */
import { chmod, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { bindingKey } from "../src/binding-key.ts"
import { bothSidesMovedGitlinkFixture, fixtureRefGit } from "./support/remerge-fixtures.ts"

const git = fixtureRefGit()
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-binding-key-"))
  roots.push(root)
  const repo = join(root, "repo")
  await git.text(root, ["init", "-b", "main", "repo"])
  return repo
}

async function commitFile(repo: string, path: string, content: string, message: string): Promise<string> {
  await Bun.write(join(repo, path), content)
  await git.text(repo, ["add", "--", path])
  await git.text(repo, ["commit", "-m", message])
  return git.text(repo, ["rev-parse", "HEAD"])
}

/** `git diff a b | git patch-id --stable`, the burn-in's failed key — used as a
 * negative control so the context-drift case cannot pass vacuously. */
async function patchIdOf(repo: string, base: string, tip: string): Promise<string> {
  const diff = Bun.spawn(["git", "-C", repo, "diff", base, tip], { stdout: "pipe", stderr: "pipe" })
  const patch = await new Response(diff.stdout).text()
  if ((await diff.exited) !== 0) throw new Error(`git diff exited non-zero: ${await new Response(diff.stderr).text()}`)
  const id = Bun.spawn(["git", "-C", repo, "patch-id", "--stable"], {
    stdin: new TextEncoder().encode(patch),
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = await new Response(id.stdout).text()
  if ((await id.exited) !== 0) throw new Error(`git patch-id exited non-zero: ${await new Response(id.stderr).text()}`)
  const first = out.trim().split(/\s+/u)[0]
  if (first === undefined || first === "") throw new Error("git patch-id emitted nothing for a non-empty patch")
  return first
}

function lines(...rows: readonly string[]): string {
  return `${rows.join("\n")}\n`
}

const TWELVE = ["l0", "l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10", "l11"] as const

function twelve(overrides: Readonly<Record<number, string | null>>): string {
  const rows: string[] = []
  TWELVE.forEach((row, index) => {
    const override = overrides[index]
    if (override === null) return
    rows.push(override ?? row)
    return
  })
  return lines(...rows)
}

describe("bindingKey", () => {
  it("survives pure context drift where git patch-id breaks (the PR1028 mechanism)", async () => {
    const repo = await makeRepo()
    const fork = await commitFile(repo, "f.txt", twelve({}), "base")
    await git.text(repo, ["checkout", "-b", "task/author", fork])
    const authorTip = await commitFile(repo, "f.txt", twelve({ 1: "l1 (authored)" }), "author: edit l1")
    await git.text(repo, ["checkout", "main"])
    // Main inserts a line two rows below the author's edit: inside the authored
    // hunk's 3-line context window, outside its changed lines.
    await Bun.write(join(repo, "f.txt"), lines("l0", "l1", "l2", "l3", "inserted by main", ...TWELVE.slice(4)))
    await git.text(repo, ["add", "--", "f.txt"])
    await git.text(repo, ["commit", "-m", "main: insert near the change"])
    const movedBase = await git.text(repo, ["rev-parse", "HEAD"])
    const variantTree = await git.text(repo, ["merge-tree", "--write-tree", movedBase, authorTip])

    // Negative control: the context drift is real — the burn-in's key moves.
    expect(await patchIdOf(repo, fork, authorTip)).not.toBe(await patchIdOf(repo, movedBase, variantTree))

    const authored = await bindingKey(git, repo, fork, authorTip)
    const rebased = await bindingKey(git, repo, movedBase, variantTree)
    expect(rebased.key).toBe(authored.key)
  })

  it("is insensitive to hunk grouping: the same edits key identically with and without an untouched separator line", async () => {
    const repo = await makeRepo()
    // Pair A: the two edited rows are separated by an untouched line, so the
    // diff carries two change groups. Pair B: the separator is absent from both
    // sides, so the same edits form one group with a different -/+ interleaving.
    const withSeparatorBase = await commitFile(repo, "g.txt", lines("a", "x", "sep", "y", "d"), "pair a base")
    const withSeparatorTip = await commitFile(repo, "g.txt", lines("a", "x2", "sep", "y2", "d"), "pair a tip")
    const withoutSeparatorBase = await commitFile(repo, "g.txt", lines("a", "x", "y", "d"), "pair b base")
    const withoutSeparatorTip = await commitFile(repo, "g.txt", lines("a", "x2", "y2", "d"), "pair b tip")

    const grouped = await bindingKey(git, repo, withSeparatorBase, withSeparatorTip)
    const merged = await bindingKey(git, repo, withoutSeparatorBase, withoutSeparatorTip)
    expect(merged.key).toBe(grouped.key)
  })

  it("moves when the base absorbed part of the change — the surviving contribution is a different change", async () => {
    const repo = await makeRepo()
    const fork = await commitFile(repo, "f.txt", twelve({}), "base")
    await git.text(repo, ["checkout", "-b", "task/absorbed", fork])
    const authorTip = await commitFile(
      repo,
      "f.txt",
      twelve({ 1: "l1 (authored)", 10: "l10 (authored)" }),
      "author: edit l1 and l10",
    )
    await git.text(repo, ["checkout", "main"])
    const movedBase = await commitFile(repo, "f.txt", twelve({ 10: "l10 (authored)" }), "main: absorb the l10 edit")
    const variantTree = await git.text(repo, ["merge-tree", "--write-tree", movedBase, authorTip])

    const authored = await bindingKey(git, repo, fork, authorTip)
    const rebased = await bindingKey(git, repo, movedBase, variantTree)
    expect(rebased.key).not.toBe(authored.key)
  })

  it("keys the path: identical line content in different files is a different change", async () => {
    const repo = await makeRepo()
    await commitFile(repo, "one.txt", "same\n", "seed one")
    const base = await commitFile(repo, "two.txt", "same\n", "seed two")
    await git.text(repo, ["checkout", "-b", "task/in-one", base])
    const editOne = await commitFile(repo, "one.txt", "same edited\n", "edit one.txt")
    await git.text(repo, ["checkout", "main"])
    const editTwo = await commitFile(repo, "two.txt", "same edited\n", "edit two.txt")

    const inOne = await bindingKey(git, repo, base, editOne)
    const inTwo = await bindingKey(git, repo, base, editTwo)
    expect(inOne.key).not.toBe(inTwo.key)
  })

  it("keys added-line order: the same lines added in a different order is a different change", async () => {
    const repo = await makeRepo()
    const base = await commitFile(repo, "f.txt", "a\n", "base")
    await git.text(repo, ["checkout", "-b", "task/de", base])
    const forward = await commitFile(repo, "f.txt", "a\nD\nE\n", "append D then E")
    await git.text(repo, ["checkout", "main"])
    const reversed = await commitFile(repo, "f.txt", "a\nE\nD\n", "append E then D")

    const forwardKey = await bindingKey(git, repo, base, forward)
    const reversedKey = await bindingKey(git, repo, base, reversed)
    expect(forwardKey.key).not.toBe(reversedKey.key)
  })

  it("keys a gitlink move by its recorded target: different pins differ, the same pin matches", async () => {
    const fixture = await bothSidesMovedGitlinkFixture()
    roots.push(fixture.root)

    const authorMove = await bindingKey(git, fixture.superRepo, fixture.baseSha, fixture.authorTip)
    const mainMove = await bindingKey(git, fixture.superRepo, fixture.baseSha, fixture.mainTip)
    const authorMoveAgain = await bindingKey(git, fixture.superRepo, fixture.baseSha, fixture.authorTip)

    expect(authorMove.key).not.toBe(mainMove.key)
    expect(authorMoveAgain.key).toBe(authorMove.key)
    expect(authorMove.files.map((file) => file.path)).toEqual([fixture.gitlinkPath])
  })

  it("keys binary content by object id — patch text has nothing to hash there", async () => {
    const repo = await makeRepo()
    const binary = (bytes: readonly number[]): Uint8Array => Uint8Array.from(bytes)
    await Bun.write(join(repo, "blob.bin"), binary([0, 1, 2, 3]))
    await git.text(repo, ["add", "--", "blob.bin"])
    await git.text(repo, ["commit", "-m", "base binary"])
    const base = await git.text(repo, ["rev-parse", "HEAD"])
    await git.text(repo, ["checkout", "-b", "task/bin-a", base])
    await Bun.write(join(repo, "blob.bin"), binary([0, 1, 2, 3, 4]))
    await git.text(repo, ["add", "--", "blob.bin"])
    await git.text(repo, ["commit", "-m", "binary change a"])
    const tipA = await git.text(repo, ["rev-parse", "HEAD"])
    await git.text(repo, ["checkout", "main"])
    await Bun.write(join(repo, "blob.bin"), binary([9, 9, 9]))
    await git.text(repo, ["add", "--", "blob.bin"])
    await git.text(repo, ["commit", "-m", "binary change b"])
    const tipB = await git.text(repo, ["rev-parse", "HEAD"])

    const keyA = await bindingKey(git, repo, base, tipA)
    const keyB = await bindingKey(git, repo, base, tipB)
    expect(keyA.key).not.toBe(keyB.key)
    expect(keyA.files[0]?.content.form).toBe("opaque")
  })

  it("keys a mode-only change, and keys it differently from a content change", async () => {
    const repo = await makeRepo()
    const base = await commitFile(repo, "run.sh", "#!/bin/sh\n", "base script")
    await git.text(repo, ["checkout", "-b", "task/chmod", base])
    await chmod(join(repo, "run.sh"), 0o755)
    await git.text(repo, ["add", "--", "run.sh"])
    await git.text(repo, ["commit", "-m", "mark executable"])
    const chmodTip = await git.text(repo, ["rev-parse", "HEAD"])
    await git.text(repo, ["checkout", "main"])
    const editTip = await commitFile(repo, "run.sh", "#!/bin/sh\nset -e\n", "edit script")

    const chmodKey = await bindingKey(git, repo, base, chmodTip)
    const editKey = await bindingKey(git, repo, base, editTip)
    expect(chmodKey.key).not.toBe(editKey.key)
    expect(chmodKey.files[0]?.modeDelta).toBe("100644->100755")
  })

  it("distinguishes which side of a change lacks the trailing newline", async () => {
    const repo = await makeRepo()
    await commitFile(repo, "seed.txt", "seed\n", "seed")
    await Bun.write(join(repo, "n.txt"), "x\na")
    await git.text(repo, ["add", "--", "n.txt"])
    await git.text(repo, ["commit", "-m", "no trailing newline"])
    const bare = await git.text(repo, ["rev-parse", "HEAD"])
    await Bun.write(join(repo, "n.txt"), "x\na\n")
    await git.text(repo, ["add", "--", "n.txt"])
    await git.text(repo, ["commit", "-m", "trailing newline"])
    const terminated = await git.text(repo, ["rev-parse", "HEAD"])

    const addNewline = await bindingKey(git, repo, bare, terminated)
    const dropNewline = await bindingKey(git, repo, terminated, bare)
    expect(addNewline.key).not.toBe(dropNewline.key)
  })

  it("keys a blob-to-symlink typechange by its object ids, distinct from a plain edit", async () => {
    const repo = await makeRepo()
    await commitFile(repo, "target.txt", "content\n", "target")
    const base = await commitFile(repo, "entry", "plain file\n", "entry as blob")
    await git.text(repo, ["checkout", "-b", "task/symlinkify", base])
    await rm(join(repo, "entry"))
    await symlink("target.txt", join(repo, "entry"))
    await git.text(repo, ["add", "--all"])
    await git.text(repo, ["commit", "-m", "entry becomes a symlink"])
    const linked = await git.text(repo, ["rev-parse", "HEAD"])
    await git.text(repo, ["checkout", "main"])
    const edited = await commitFile(repo, "entry", "plain file edited\n", "edit entry")

    const typechange = await bindingKey(git, repo, base, linked)
    const edit = await bindingKey(git, repo, base, edited)
    expect(typechange.key).not.toBe(edit.key)
    expect(typechange.files[0]?.content.form).toBe("opaque")
    expect(typechange.files[0]?.modeDelta).toBe("100644->120000")
  })

  it("throws on an empty change instead of minting a key every empty change would share", async () => {
    const repo = await makeRepo()
    const sha = await commitFile(repo, "a.txt", "one\n", "base")

    await expect(bindingKey(git, repo, sha, sha)).rejects.toThrow(/empty/u)
  })

  it("accepts tree object ids directly and reports both resolved trees", async () => {
    const repo = await makeRepo()
    const base = await commitFile(repo, "a.txt", "one\n", "base")
    const changed = await commitFile(repo, "a.txt", "two\n", "change")
    const baseTree = await git.text(repo, ["rev-parse", `${base}^{tree}`])
    const changedTree = await git.text(repo, ["rev-parse", `${changed}^{tree}`])

    const fromCommits = await bindingKey(git, repo, base, changed)
    const fromTrees = await bindingKey(git, repo, baseTree, changedTree)
    expect(fromTrees.key).toBe(fromCommits.key)
    expect(fromTrees.baseTree).toBe(baseTree)
    expect(fromTrees.candidateTree).toBe(changedTree)
  })
})
