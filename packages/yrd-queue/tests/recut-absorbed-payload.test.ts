/**
 * @failure Recut refused `payload-mismatch` when the rebase correctly dropped a patch-equivalent commit, and wedged the drain on a fully absorbed branch (22373).
 * @level l2
 * @consumer @yrd/queue Git PR remerger
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createProcess } from "@yrd/process"
import { createGitChangeRemerger, type ChangeRemergeResult } from "@yrd/queue"

/** A change fixture's stable identity. Production changes always carry one
 * (`Queues.snapshot` reads it off the revision), and the queue refuses to
 * write a candidate commit it cannot stamp with it. */
const FIXTURE_CHANGE_ID = `I${"c0ffee12".repeat(5)}`

/**
 * Every fixture git invocation runs under a pinned identity AND a pinned clock,
 * matching tests/support/remerge-fixtures.ts. A commit that reads the wall clock
 * for its committer date is not reproducible, and this file REPLAYS commits:
 * `git cherry-pick` keeps the author date but stamps a fresh committer date, so
 * whether the replay landed in the same wall-clock second as the original
 * decided whether `target` was a distinct commit or byte-identical to `headSha`.
 * That coin flip is what made the two already-landed cases below ~4% red each
 * (2 red in 25 file runs, measured 2026-08-28).
 */
const FIXTURE_ENV = {
  GIT_AUTHOR_NAME: "Yrd Test",
  GIT_AUTHOR_EMAIL: "yrd@example.invalid",
  GIT_COMMITTER_NAME: "Yrd Test",
  GIT_COMMITTER_EMAIL: "yrd@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
} as const

/**
 * The clock the BASE lands under, deliberately a different day from the authored
 * one above. Pinning both to the same instant would be reproducible but wrong:
 * a cherry-pick would then reproduce the authored commit byte-for-byte, main's
 * tip would BE the author's tip, and `rebuildCandidateByMerge`'s ancestry
 * short-circuit would answer every case here without the merge machinery under
 * test ever running. Determinism has to pick the universe where the code under
 * test executes, not the one where it is skipped.
 */
const LANDED_CLOCK = { GIT_COMMITTER_DATE: "2026-01-02T00:00:00Z" } as const

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(repo: string, args: readonly string[], env: Readonly<Record<string, string>> = {}): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...FIXTURE_ENV, ...env },
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

const seeded = (file: string) => Array.from({ length: 20 }, (_unused, index) => `${file} line ${index + 1}\n`).join("")

async function commit(repo: string, file: string, content: string, message: string): Promise<string> {
  await writeFile(join(repo, file), content)
  await git(repo, ["add", file])
  await git(repo, ["commit", "-qm", message])
  return git(repo, ["rev-parse", "HEAD"])
}

/** Append a line to an existing tracked file and commit it. */
async function append(repo: string, file: string, line: string, message: string): Promise<string> {
  const current = await readFile(join(repo, file), "utf8")
  return commit(repo, file, `${current}${line}\n`, message)
}

async function changedPaths(repo: string, from: string, to: string): Promise<string[]> {
  const output = await git(repo, ["diff", "--name-only", from, to])
  return output === "" ? [] : output.split("\n").toSorted()
}

/**
 * A root repo on `main` seeding `AGENTS.md`, `CLAUDE.md` and `hab.yml`, plus an
 * `issue/feature` branch carrying one ordinary commit per file — the PR1646
 * shape: three commits, three payload paths.
 */
async function featureRepo(): Promise<{ repo: string; sourceBase: string; headSha: string }> {
  const root = await mkdtemp(join(tmpdir(), "yrd-recut-absorbed-"))
  roots.push(root)
  const repo = join(root, "repo")
  await Bun.$`git init -q -b main ${repo}`
  await git(repo, ["config", "user.name", "Yrd Test"])
  await git(repo, ["config", "user.email", "yrd@example.invalid"])
  for (const file of ["AGENTS.md", "CLAUDE.md", "hab.yml"]) await commit(repo, file, seeded(file), `root: ${file}`)
  const sourceBase = await git(repo, ["rev-parse", "HEAD"])

  await git(repo, ["switch", "-qc", "issue/feature", sourceBase])
  await append(repo, "AGENTS.md", "authored agents", "feat: agents")
  await append(repo, "CLAUDE.md", "authored claude", "feat: claude")
  const headSha = await append(repo, "hab.yml", "authored hab", "feat: hab")
  await git(repo, ["switch", "-q", "main"])
  return { repo, sourceBase, headSha }
}

/**
 * Absorb the named feature commits into `main` by another route, exactly as
 * authored: patch-equivalent commits that are NOT the authored ones. The
 * distinct committer clock is what makes "another route" true rather than
 * accidental — see LANDED_CLOCK.
 */
async function landOnMain(repo: string, subjects: readonly string[]): Promise<string> {
  for (const subject of subjects) {
    const sha = await git(repo, ["rev-list", "-1", "--fixed-strings", `--grep=${subject}`, "issue/feature"])
    await git(repo, ["cherry-pick", sha], LANDED_CLOCK)
  }
  return git(repo, ["rev-parse", "HEAD"])
}

/**
 * Land the whole feature branch on `main` by MERGING it, the way the queue
 * itself lands work: the authored head becomes a literal ancestor of the base,
 * so `target..head` is empty and the base's tree already IS the authored tree.
 * Distinct from `landOnMain` above, which absorbs the same payload as
 * patch-equivalent commits the author never wrote.
 */
async function mergeOnMain(repo: string): Promise<string> {
  await git(repo, ["merge", "--no-ff", "-m", "merge: issue/feature", "issue/feature"], LANDED_CLOCK)
  return git(repo, ["rev-parse", "HEAD"])
}

async function remerge(
  repo: string,
  sourceBase: string,
  headSha: string,
  current?: Readonly<{ revision: number; headSha: string; baseSha: string; treeSha: string; patchId: string }>,
): Promise<ChangeRemergeResult> {
  await using process = createProcess()
  return await createGitChangeRemerger({ inject: { process }, repo }).recut({
    id: "PR1",
    changeId: FIXTURE_CHANGE_ID,
    branch: "issue/feature",
    base: "main",
    revision: 1,
    headSha,
    baseSha: sourceBase,
    ...(current === undefined ? {} : { current }),
  })
}

describe("recut against a base that absorbed part of the payload (22373)", () => {
  it("succeeds carrying only the paths the base did not already merge", async () => {
    const { repo, sourceBase, headSha } = await featureRepo()
    const target = await landOnMain(repo, ["feat: agents", "feat: claude"])
    // Fixture precondition, stated rather than assumed: the base absorbed the
    // payload as commits the author never wrote, so it is NOT an ancestor of the
    // authored head and the merge machinery under test actually runs. A base
    // that reproduced the authored commits would take the ancestry
    // short-circuit and prove nothing.
    expect(await git(repo, ["merge-base", target, headSha])).not.toBe(target)

    const result = await remerge(repo, sourceBase, headSha)

    expect(result.unchanged).toBe(false)
    expect(await git(repo, ["rev-parse", `${result.headSha}^`])).toBe(target)
    expect(await changedPaths(repo, target, result.headSha)).toEqual(["hab.yml"])
    // Every authored line is delivered — the absorbed two by the base, the third by this recut.
    for (const [file, line] of [
      ["AGENTS.md", "authored agents"],
      ["CLAUDE.md", "authored claude"],
      ["hab.yml", "authored hab"],
    ] as const) {
      expect(await git(repo, ["show", `${result.headSha}:${file}`])).toBe(`${seeded(file)}${line}`)
    }
  })

  it("reaches an already-landed head when the base absorbed the whole payload", async () => {
    const { repo, sourceBase, headSha } = await featureRepo()
    const target = await landOnMain(repo, ["feat: agents", "feat: claude", "feat: hab"])
    // Fixture precondition, same guard as the absorbed case above: a base that
    // reproduced the authored commits would be an ancestor of the authored head,
    // the ancestry short-circuit would answer, and nothing below would exercise
    // a merge.
    expect(await git(repo, ["merge-base", target, headSha])).not.toBe(target)

    const result = await remerge(repo, sourceBase, headSha)

    // Nothing is left to deliver. The base absorbed the payload by patch
    // equivalence, not by ancestry, so the rebuild is a genuine merge whose tree
    // IS the base's tree — and `unchanged` is the tree-equality proof that
    // closes the change as already-landed instead of wedging the drain on a
    // payload refusal. That proof, not the head's sha, is the fact under test:
    // asserting the head EQUALS the base held only while the fixture's
    // cherry-picks happened to hash identically to the authored commits, a
    // wall-clock coincidence rather than anything the queue promises.
    expect(result.unchanged).toBe(true)
    expect(result.baseSha).toBe(target)
    expect(result.treeSha).toBe(await git(repo, ["rev-parse", `${target}^{tree}`]))
    expect(await changedPaths(repo, target, result.headSha)).toEqual([])
  })

  it("re-derives an already-landed revision instead of refusing its absent patch certificate", async () => {
    const { repo, sourceBase, headSha } = await featureRepo()
    // Landed by MERGE, not absorbed by cherry-pick: this case needs the authored
    // head to be a literal ancestor of the base, so the recorded revision's head
    // IS the base and `remergeChange`'s `alreadyMergedDirect` guard fires. An
    // absorbed base only produces that shape when the replayed commits happen to
    // hash identically to the authored ones — the coincidence that made this
    // test red — and when they do not, the recorded head is a merge commit, the
    // unchanged fast path answers, and nothing re-derives at all. The assertion
    // below states that precondition rather than assuming it, so a fixture that
    // ever drifts back to the absorbed shape fails loudly instead of passing
    // vacuously.
    const target = await mergeOnMain(repo)
    const first = await remerge(repo, sourceBase, headSha)
    expect(first.headSha).toBe(target)

    // `target..head` is empty for an already-landed head, so the fast path has
    // no patch identity to certify against and must re-derive from the source.
    const again = await remerge(repo, sourceBase, headSha, {
      revision: 1,
      headSha: first.headSha,
      baseSha: first.baseSha,
      treeSha: first.treeSha,
      patchId: first.patchId,
    })

    expect(again.headSha).toBe(target)
    expect(again.patchId).toBe(first.patchId)
    expect(again.treeSha).toBe(first.treeSha)
  })

  it("still expects a payload path the base merely touched without absorbing", async () => {
    const { repo, sourceBase, headSha } = await featureRepo()
    // The base rewrites AGENTS.md's first line — content the author never
    // wrote, far enough from the authored append at the end of the file that
    // both the merge and the authored patch identity survive. That path is NOT
    // absorbed and must stay in the expected payload.
    await commit(
      repo,
      "AGENTS.md",
      seeded("AGENTS.md").replace("AGENTS.md line 1\n", "AGENTS.md upstream line 1\n"),
      "base: agents preamble",
    )
    const target = await commit(repo, "unrelated.md", "unrelated\n", "base: unrelated")

    const result = await remerge(repo, sourceBase, headSha)

    expect(await changedPaths(repo, target, result.headSha)).toEqual(["AGENTS.md", "CLAUDE.md", "hab.yml"])
  })
})
