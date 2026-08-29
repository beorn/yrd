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
import { chmod, mkdtemp, rm, symlink, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  crossBaseDeltaEquality,
  exactDelta,
  formatExactDelta,
  resolveAbsorbedPaths,
  resolveMissingAgainstCandidate,
} from "../src/content-identity.ts"
import { bothSidesMovedGitlinkFixture, fixtureRefGit, movedBaseFixture } from "./support/remerge-fixtures.ts"

const git = fixtureRefGit()
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-content-identity-"))
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

describe("exactDelta", () => {
  it("reports an empty delta for one commit against itself", async () => {
    const repo = await makeRepo()
    const sha = await commitFile(repo, "a.txt", "one\n", "base")

    const delta = await exactDelta(git, repo, sha, sha)

    expect(delta.entries).toEqual([])
    expect(delta.baseTree).toBe(delta.candidateTree)
    expect(delta.baseTree).toBe(await git.text(repo, ["rev-parse", `${sha}^{tree}`]))
  })

  it("reports an empty delta for distinct commits whose trees are identical", async () => {
    const repo = await makeRepo()
    const first = await commitFile(repo, "a.txt", "one\n", "base")
    await git.text(repo, ["commit", "--allow-empty", "-m", "no tree change"])
    const second = await git.text(repo, ["rev-parse", "HEAD"])

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

    expect(delta.baseTree).toBe(await git.text(repo, ["rev-parse", `${base}^{tree}`]))
    expect(delta.candidateTree).toBe(await git.text(repo, ["rev-parse", `${changed}^{tree}`]))
    expect(delta.entries).toHaveLength(1)
    const entry = delta.entries[0]
    expect(entry).toMatchObject({ path: "a.txt", kind: "modified", object: "blob" })
    expect(entry?.baseOid).toBe(await git.text(repo, ["rev-parse", `${base}:a.txt`]))
    expect(entry?.candidateOid).toBe(await git.text(repo, ["rev-parse", `${changed}:a.txt`]))
  })

  it("names added and deleted paths, leaving the absent side unset", async () => {
    const repo = await makeRepo()
    const base = await commitFile(repo, "old.txt", "old\n", "base")
    await unlink(join(repo, "old.txt"))
    await Bun.write(join(repo, "new.txt"), "new\n")
    await git.text(repo, ["add", "--all"])
    await git.text(repo, ["commit", "-m", "swap files"])
    const swapped = await git.text(repo, ["rev-parse", "HEAD"])

    const delta = await exactDelta(git, repo, base, swapped)

    expect(delta.entries.map((entry) => [entry.kind, entry.path])).toEqual([
      ["added", "new.txt"],
      ["deleted", "old.txt"],
    ])
    const added = delta.entries[0]
    expect(added?.baseOid).toBeUndefined()
    expect(added?.baseMode).toBeUndefined()
    expect(added?.candidateOid).toBe(await git.text(repo, ["rev-parse", `${swapped}:new.txt`]))
    const deleted = delta.entries[1]
    expect(deleted?.candidateOid).toBeUndefined()
    expect(deleted?.candidateMode).toBeUndefined()
    expect(deleted?.baseOid).toBe(await git.text(repo, ["rev-parse", `${base}:old.txt`]))
  })

  it("names nested paths in full", async () => {
    const repo = await makeRepo()
    const base = await commitFile(repo, "top.txt", "top\n", "base")
    await Bun.write(join(repo, "deep/nested/dir/leaf.txt"), "leaf\n")
    await git.text(repo, ["add", "--all"])
    await git.text(repo, ["commit", "-m", "nested add"])
    const nested = await git.text(repo, ["rev-parse", "HEAD"])

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
    await git.text(repo, ["add", "--all"])
    await git.text(repo, ["commit", "-m", "entry becomes a symlink"])
    const linked = await git.text(repo, ["rev-parse", "HEAD"])

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
    const baseTree = await git.text(repo, ["rev-parse", `${base}^{tree}`])
    const changedTree = await git.text(repo, ["rev-parse", `${changed}^{tree}`])

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

/**
 * The cross-base equality clause, corrected per the 2026-08-26 burn-in
 * (hub/yrd/2026-08-26-patch-equivalence-burn-in.md § exactDelta disagreements):
 * comparing RESULTING BLOBS across bases refuses every ordinary rebase over a
 * touched file (24 false positives on real history), while path-set + mode +
 * gitlink-target comparison admits all 24 and still refuses the 18 real
 * divergences (17 absorbed pins, 1 empty landing).
 */
describe("crossBaseDeltaEquality", () => {
  it("admits a clean rebase whose blobs moved with the base — same paths, different resulting blobs", async () => {
    const fixture = await movedBaseFixture({ mainMoves: "overlapping-path-mergeable" })
    roots.push(fixture.root)
    const variantTree = await git.text(fixture.repo, ["merge-tree", "--write-tree", fixture.baseTwo, fixture.authorTip])

    const authored = await exactDelta(git, fixture.repo, fixture.baseOne, fixture.authorTip)
    const landed = await exactDelta(git, fixture.repo, fixture.baseTwo, variantTree)

    // The drift is real: the resulting blob differs between the two deltas.
    expect(landed.entries[0]?.candidateOid).not.toBe(authored.entries[0]?.candidateOid)

    const comparison = crossBaseDeltaEquality(authored, landed)
    expect(comparison.equal).toBe(true)
    expect(comparison.differing).toEqual([])
  })

  it("ignores landed paths outside the authored set — the merge machinery's own contributions are invisible", async () => {
    const fixture = await movedBaseFixture({ mainMoves: "disjoint-paths" })
    roots.push(fixture.root)
    const variantTree = await git.text(fixture.repo, ["merge-tree", "--write-tree", fixture.baseTwo, fixture.authorTip])

    const authored = await exactDelta(git, fixture.repo, fixture.baseOne, fixture.authorTip)
    // Landed measured against the OLD base carries main's own file too.
    const landed = await exactDelta(git, fixture.repo, fixture.baseOne, variantTree)
    expect(landed.entries.length).toBeGreaterThan(authored.entries.length)

    const comparison = crossBaseDeltaEquality(authored, landed)
    expect(comparison.equal).toBe(true)
  })

  it("refuses an absorbed gitlink: the landed pin is not the authored pin", async () => {
    const fixture = await bothSidesMovedGitlinkFixture()
    roots.push(fixture.root)

    const authored = await exactDelta(git, fixture.superRepo, fixture.baseSha, fixture.authorTip)
    const landed = await exactDelta(git, fixture.superRepo, fixture.baseSha, fixture.mainTip)

    const comparison = crossBaseDeltaEquality(authored, landed)
    expect(comparison.equal).toBe(false)
    expect(comparison.differing).toHaveLength(1)
    expect(comparison.differing[0]).toMatchObject({ path: fixture.gitlinkPath, reason: "gitlink-target" })
  })

  it("refuses when an authored path is missing from the landed delta — the base absorbed the whole file's change", async () => {
    const fixture = await movedBaseFixture({ mainMoves: "overlapping-path-mergeable" })
    roots.push(fixture.root)
    // Main lands the author's exact edit, so the rebased candidate adds nothing.
    await git.text(fixture.repo, ["checkout", "main"])
    const absorbing = await git.text(fixture.repo, [
      "commit-tree",
      `${fixture.authorTip}^{tree}`,
      "-p",
      fixture.baseTwo,
      "-m",
      "main absorbs the change",
    ])
    const variantTree = await git.text(fixture.repo, ["merge-tree", "--write-tree", absorbing, fixture.authorTip])

    const authored = await exactDelta(git, fixture.repo, fixture.baseOne, fixture.authorTip)
    const landed = await exactDelta(git, fixture.repo, absorbing, variantTree)

    expect(landed.entries).toEqual([])
    const comparison = crossBaseDeltaEquality(authored, landed)
    expect(comparison.equal).toBe(false)
    expect(comparison.landedEmpty).toBe(true)
    expect(comparison.differing[0]).toMatchObject({ path: fixture.authorPath, reason: "missing-from-landed" })
  })

  it("refuses a kind disagreement on a shared path", async () => {
    const repo = await makeRepo()
    const base = await commitFile(repo, "f.txt", "one\n", "base")
    const edited = await commitFile(repo, "f.txt", "two\n", "edit f")
    await git.text(repo, ["checkout", "-b", "task/delete-f", base])
    await unlink(join(repo, "f.txt"))
    await git.text(repo, ["add", "--all"])
    await git.text(repo, ["commit", "-m", "delete f"])
    const deleted = await git.text(repo, ["rev-parse", "HEAD"])

    const authored = await exactDelta(git, repo, base, edited)
    const landed = await exactDelta(git, repo, base, deleted)

    const comparison = crossBaseDeltaEquality(authored, landed)
    expect(comparison.equal).toBe(false)
    expect(comparison.differing[0]).toMatchObject({ path: "f.txt", reason: "kind" })
  })

  it("compares the mode DELTA, refusing a dropped chmod but never an inherited base mode", async () => {
    const repo = await makeRepo()
    const base = await commitFile(repo, "run.sh", "#!/bin/sh\n", "base")
    await git.text(repo, ["checkout", "-b", "task/chmod-and-edit", base])
    await Bun.write(join(repo, "run.sh"), "#!/bin/sh\nset -e\n")
    await chmod(join(repo, "run.sh"), 0o755)
    await git.text(repo, ["add", "--", "run.sh"])
    await git.text(repo, ["commit", "-m", "edit and mark executable"])
    const chmodTip = await git.text(repo, ["rev-parse", "HEAD"])
    await git.text(repo, ["checkout", "main"])
    const plainTip = await commitFile(repo, "run.sh", "#!/bin/sh\nset -e\n", "edit only")

    const authored = await exactDelta(git, repo, base, chmodTip)
    const landedKeepingChmod = await exactDelta(git, repo, base, chmodTip)
    const landedDroppingChmod = await exactDelta(git, repo, base, plainTip)

    expect(crossBaseDeltaEquality(authored, landedKeepingChmod).equal).toBe(true)
    const dropped = crossBaseDeltaEquality(authored, landedDroppingChmod)
    expect(dropped.equal).toBe(false)
    expect(dropped.differing[0]).toMatchObject({ path: "run.sh", reason: "mode-delta" })
  })

  it("resolves a base-absorbed path as agreement, and keeps a genuinely dropped path refused", async () => {
    const repo = await makeRepo()
    await commitFile(repo, "one.txt", "one\n", "seed one")
    const base = await commitFile(repo, "two.txt", "two\n", "seed two")
    await git.text(repo, ["checkout", "-b", "task/edit-both", base])
    await Bun.write(join(repo, "one.txt"), "one edited\n")
    await Bun.write(join(repo, "two.txt"), "two edited\n")
    await git.text(repo, ["add", "--all"])
    await git.text(repo, ["commit", "-m", "edit both files"])
    const authorTip = await git.text(repo, ["rev-parse", "HEAD"])
    await git.text(repo, ["checkout", "main"])
    // Main absorbs the one.txt edit; the rebased candidate then contributes
    // only two.txt, so one.txt is missing from the landed delta.
    const absorbingBase = await commitFile(repo, "one.txt", "one edited\n", "main: absorb the one.txt edit")
    const variantTree = await git.text(repo, ["merge-tree", "--write-tree", absorbingBase, authorTip])

    const authored = await exactDelta(git, repo, base, authorTip)
    const landed = await exactDelta(git, repo, absorbingBase, variantTree)

    const strict = crossBaseDeltaEquality(authored, landed)
    expect(strict.equal).toBe(false)
    expect(strict.differing[0]).toMatchObject({ path: "one.txt", reason: "missing-from-landed" })

    const resolved = await resolveAbsorbedPaths(git, repo, authored, landed, strict)
    expect(resolved.equal).toBe(true)
    expect(resolved.differing).toEqual([])

    // The same missing path against a base that did NOT absorb it is a real
    // drop and must stay refused.
    const unabsorbed = await exactDelta(git, repo, base, variantTree)
    const landedDropping = { ...unabsorbed, entries: unabsorbed.entries.filter((entry) => entry.path !== "one.txt") }
    const dropped = crossBaseDeltaEquality(authored, landedDropping)
    const droppedResolved = await resolveAbsorbedPaths(git, repo, authored, landedDropping, dropped)
    expect(droppedResolved.equal).toBe(false)
    expect(droppedResolved.differing[0]).toMatchObject({ path: "one.txt", reason: "missing-from-landed" })
  })

  it("resolves an absorbed deletion — the path already absent from the landed base", async () => {
    const repo = await makeRepo()
    await commitFile(repo, "keep.txt", "keep\n", "seed keep")
    const base = await commitFile(repo, "gone.txt", "gone\n", "seed gone")
    await git.text(repo, ["checkout", "-b", "task/delete-and-edit", base])
    await unlink(join(repo, "gone.txt"))
    await Bun.write(join(repo, "keep.txt"), "keep edited\n")
    await git.text(repo, ["add", "--all"])
    await git.text(repo, ["commit", "-m", "delete gone.txt, edit keep.txt"])
    const authorTip = await git.text(repo, ["rev-parse", "HEAD"])
    await git.text(repo, ["checkout", "main"])
    await unlink(join(repo, "gone.txt"))
    await git.text(repo, ["add", "--all"])
    await git.text(repo, ["commit", "-m", "main: delete gone.txt too"])
    const absorbingBase = await git.text(repo, ["rev-parse", "HEAD"])
    const variantTree = await git.text(repo, ["merge-tree", "--write-tree", absorbingBase, authorTip])

    const authored = await exactDelta(git, repo, base, authorTip)
    const landed = await exactDelta(git, repo, absorbingBase, variantTree)

    const strict = crossBaseDeltaEquality(authored, landed)
    expect(strict.differing[0]).toMatchObject({ path: "gone.txt", reason: "missing-from-landed" })
    const resolved = await resolveAbsorbedPaths(git, repo, authored, landed, strict)
    expect(resolved.equal).toBe(true)
  })

  it("resolves an absorbed-then-further-edited path against the candidate tree, and keeps a real drop refused", async () => {
    const repo = await makeRepo()
    const rows = (first: string, last: string): string => `${[first, "b", "c", "d", "e", "f", "g", last].join("\n")}\n`
    await commitFile(repo, "one.txt", rows("a", "h"), "seed one")
    const base = await commitFile(repo, "two.txt", "two\n", "seed two")
    await git.text(repo, ["checkout", "-b", "task/edit-both-2", base])
    await Bun.write(join(repo, "one.txt"), rows("a (authored)", "h"))
    await Bun.write(join(repo, "two.txt"), "two edited\n")
    await git.text(repo, ["add", "--all"])
    await git.text(repo, ["commit", "-m", "edit both files"])
    const authorTip = await git.text(repo, ["rev-parse", "HEAD"])
    await git.text(repo, ["checkout", "main"])
    // Main absorbs the one.txt edit byte-for-byte AND keeps editing a distant
    // region of the same file, so the base's blob is not byte-identical to the
    // authored candidate yet the rebase stays conflict-free.
    const absorbingBase = await commitFile(
      repo,
      "one.txt",
      rows("a (authored)", "h (moved by main)"),
      "main: absorb and extend",
    )
    const candidateTree = await git.text(repo, ["merge-tree", "--write-tree", absorbingBase, authorTip])

    const authored = await exactDelta(git, repo, base, authorTip)
    const landed = await exactDelta(git, repo, absorbingBase, candidateTree)
    expect(landed.entries.map((entry) => entry.path)).toEqual(["two.txt"])

    const strict = crossBaseDeltaEquality(authored, landed)
    expect(strict.differing[0]).toMatchObject({ path: "one.txt", reason: "missing-from-landed" })
    // Byte-equality cannot resolve this shape — the base kept editing.
    const byteResolved = await resolveAbsorbedPaths(git, repo, authored, landed, strict)
    expect(byteResolved.equal).toBe(false)

    const resolved = await resolveMissingAgainstCandidate(git, repo, landed, strict, candidateTree)
    expect(resolved.equal).toBe(true)
    expect(resolved.differing).toEqual([])

    // A merged tree that DROPPED the one.txt work disagrees with the candidate
    // at that path and must stay refused: merge two.txt only, onto the
    // unabsorbing base, and compare against the candidate that carries both.
    await git.text(repo, ["checkout", "-b", "task/drops-one", base])
    const droppedTip = await commitFile(repo, "two.txt", "two edited\n", "merge that lost the one.txt work")
    const fullCandidate = await git.text(repo, ["merge-tree", "--write-tree", base, authorTip])
    const landedDropping = await exactDelta(git, repo, base, droppedTip)
    expect(landedDropping.entries.map((entry) => entry.path)).toEqual(["two.txt"])
    const strictDropped = crossBaseDeltaEquality(authored, landedDropping)
    const still = await resolveMissingAgainstCandidate(git, repo, landedDropping, strictDropped, fullCandidate)
    expect(still.equal).toBe(false)
    expect(still.differing[0]).toMatchObject({ path: "one.txt", reason: "missing-from-landed" })
  })

  it("never calls an empty delta equal to anything — an empty key is an absence, not a value", async () => {
    const repo = await makeRepo()
    const sha = await commitFile(repo, "a.txt", "one\n", "base")
    const changed = await commitFile(repo, "a.txt", "two\n", "change")

    const empty = await exactDelta(git, repo, sha, sha)
    const full = await exactDelta(git, repo, sha, changed)

    const bothEmpty = crossBaseDeltaEquality(empty, empty)
    expect(bothEmpty.equal).toBe(false)
    expect(bothEmpty.authoredEmpty).toBe(true)
    expect(bothEmpty.landedEmpty).toBe(true)

    const authoredEmpty = crossBaseDeltaEquality(empty, full)
    expect(authoredEmpty.equal).toBe(false)
    expect(authoredEmpty.authoredEmpty).toBe(true)
    expect(authoredEmpty.landedEmpty).toBe(false)
  })
})
