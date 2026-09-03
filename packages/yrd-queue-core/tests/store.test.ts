/**
 * The store, against a real repository.
 *
 * The plan's store IS git, so these tests drive real repositories through the
 * production git seam. A mocked git would prove that the code agrees with a
 * mock, which is the one thing nobody needs to know.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { appendFact, changeRef, gitIn, readChange, readFact, readFacts, trailer } from "../src/index.ts"
import type { Fact, Git } from "../src/index.ts"

/**
 * The facts of a change that certainly has some. `ChangeFacts.facts` is a
 * non-empty list by type, and `readFacts` answers an unknown change with none,
 * so the fixture says out loud which of the two it wrote.
 */
function written(facts: readonly Fact[]): readonly [Fact, ...Fact[]] {
  const [first, ...rest] = facts
  if (first === undefined) throw new Error("the fixture wrote no facts to read a change from")
  return [first, ...rest]
}

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

/** A repository with one commit on `main`, and a branch one commit ahead. */
async function repository(): Promise<Readonly<{ git: Git; root: string; head: string; branchSha: string }>> {
  const root = mkdtempSync(join(tmpdir(), "yrd-core-"))
  roots.push(root)
  const git = gitIn(root)
  await git(["init", "--initial-branch=main", "--quiet"])
  await git(["config", "user.email", "queue@yrd.test"])
  await git(["config", "user.name", "yrd"])
  writeFileSync(join(root, "base.txt"), "base\n")
  await git(["add", "base.txt"])
  await git(["commit", "--quiet", "-m", "base"])
  const branchSha = (await git(["rev-parse", "HEAD"])).trim()
  await git(["checkout", "--quiet", "-b", "task/one"])
  writeFileSync(join(root, "one.txt"), "one\n")
  await git(["add", "one.txt"])
  await git(["commit", "--quiet", "-m", "one"])
  const head = (await git(["rev-parse", "HEAD"])).trim()
  await git(["checkout", "--quiet", "main"])
  return { branchSha, git, head, root }
}

describe("a change's facts are its commits", () => {
  it("opened writes one fact, reachable with its head, readable back", async () => {
    const { git, head } = await repository()
    const sha = await appendFact(git, {
      branch: "main",
      change: { branch: "task/one", head },
      kind: "opened",
      subject: "@dev/2 submitted task/one to main",
      trailers: [
        ["Submitter", "@dev/2"],
        ["Work-Item", "@i/10-yrd/24061"],
      ],
    })

    const facts = await readFacts(git, { branch: "task/one", head })
    expect(facts).toHaveLength(1)
    expect(facts[0]?.kind).toBe("opened")
    expect(facts[0]?.sha).toBe(sha)
    expect(trailer(facts[0]!, "Submitter")).toBe("@dev/2")
    expect(trailer(facts[0]!, "Work-Item")).toBe("@i/10-yrd/24061")

    // The head is the fact's parent, so the content stays reachable from the
    // change ref alone: a prune of the branch cannot orphan what was judged.
    const parents = (await git(["rev-list", "--parents", "-n", "1", sha])).trim().split(/\s+/u)
    expect(parents.slice(1)).toContain(head)
    expect((await git(["rev-parse", changeRef({ branch: "task/one", head })])).trim()).toBe(sha)
  })

  it("keeps the facts in the order they happened", async () => {
    const { git, head } = await repository()
    await appendFact(git, { branch: "main", change: { branch: "task/one", head }, kind: "opened", subject: "submitted" })
    await appendFact(git, {
      branch: "main",
      change: { branch: "task/one", head },
      kind: "checked",
      subject: "on-submit checks passed",
      trailers: [
        ["Config", "88f70021"],
        ["Check", "typecheck exit=0 ms=1200 log=/tmp/typecheck.log"],
        ["Check", "affected-tests exit=0 ms=90000 log=/tmp/tests.log"],
      ],
    })

    const facts = await readFacts(git, { branch: "task/one", head })
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "checked"])
    expect(facts[1]?.trailers.filter(([name]) => name === "Check")).toHaveLength(2)
  })

  it("refuses a second writer that read the same tip, instead of interleaving", async () => {
    const { git, head } = await repository()
    await appendFact(git, { branch: "main", change: { branch: "task/one", head }, kind: "opened", subject: "submitted" })
    const ref = changeRef({ branch: "task/one", head })
    const tip = (await git(["rev-parse", ref])).trim()
    await appendFact(git, { branch: "main", change: { branch: "task/one", head }, kind: "checked", subject: "checks passed" })

    // The loser's own update-ref, replayed with the tip it had read.
    const stale = (await git(["commit-tree", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-p", tip, "-p", head, "-m", "late\n\nFact: checked\n"])).trim()
    await expect(git(["update-ref", ref, stale, tip])).rejects.toThrow()
    const facts = await readFacts(git, { branch: "task/one", head })
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "checked"])
  })

  it("refuses facts written before the 2026-09-03 format, naming the ref and the cure", async () => {
    // Facts written before that day spelled the change as a `Branch:` and
    // `Head:` pair with the queue's own branch on `Target:`. There is no
    // compatibility reader on purpose: two spellings of a change's name in the
    // one store is exactly what the name exists to prevent. So a reader that
    // meets one says which ref it is, that the facts predate the format, and
    // what the queue mechanic does about it.
    const { git, head } = await repository()
    const ref = changeRef({ branch: "task/old", head })
    const old = (
      await git([
        "commit-tree",
        "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        "-p",
        head,
        "-m",
        ["@dev/2 submitted task/old to main", "", "Fact: opened", "Branch: task/old", `Head: ${head}`, "Target: main", ""].join("\n"),
      ])
    ).trim()
    await git(["update-ref", ref, old])

    const refused = readFacts(git, { branch: "task/old", head })

    await expect(refused).rejects.toThrow(ref)
    await expect(refused).rejects.toThrow(/predate the 2026-09-03 format/u)
    await expect(refused).rejects.toThrow(/git bundle create/u)
  })

  it("git's own parser reads the trailers: prose that looks like one is not, and a folded value reads whole", async () => {
    // A hand-rolled `^Key: value$` scan called every line that looked like a
    // trailer one, so a prose `Note: fix` in the body stood in the derived
    // state; and a value git had folded onto a second line read as two.
    const { git } = await repository()
    const tree = (await git(["rev-parse", "HEAD^{tree}"])).trim()
    const sha = (
      await git([
        "commit-tree",
        tree,
        "-m",
        [
          "task/one failed",
          "",
          "Note: fix the thing",
          "",
          "Fact: failed",
          "Change: task/one@abc",
          "Branch: main",
          "Detail: what git said,",
          "  wrapped onto a second line",
          "",
        ].join("\n"),
      ])
    ).trim()

    const fact = await readFact(git, sha)

    expect(fact.kind).toBe("failed")
    expect(fact.subject).toBe("task/one failed")
    expect(trailer(fact, "Note")).toBeUndefined()
    expect(trailer(fact, "Detail")).toBe("what git said, wrapped onto a second line")
  })

  it("reads no facts for a branch nobody submitted", async () => {
    const { git, head } = await repository()
    expect(await readFacts(git, { branch: "task/one", head })).toEqual([])
  })
})

describe("the state is derived, and ancestry wins over any fact", () => {
  it("queued, then checked, from the facts", async () => {
    const { git, head } = await repository()
    await appendFact(git, { branch: "main", change: { branch: "task/one", head }, kind: "opened", subject: "submitted" })
    let facts = await readFacts(git, { branch: "task/one", head })
    expect(readChange({ branch: "task/one", branchHead: head, facts: written(facts), head, headOnBranch: false }).state).toBe("queued")

    await appendFact(git, { branch: "main", change: { branch: "task/one", head }, kind: "checked", subject: "checks passed" })
    facts = await readFacts(git, { branch: "task/one", head })
    expect(readChange({ branch: "task/one", branchHead: head, facts: written(facts), head, headOnBranch: false }).state).toBe("checked")
  })

  it("merged from ancestry alone, with no merged fact written", async () => {
    const { git, head, branchSha } = await repository()
    await appendFact(git, { branch: "main", change: { branch: "task/one", head }, kind: "opened", subject: "submitted" })
    await git(["merge", "--quiet", "--no-ff", "-m", "merge task/one", head])
    expect((await git(["rev-parse", "HEAD"])).trim()).not.toBe(branchSha)

    const facts = await readFacts(git, { branch: "task/one", head })
    const onTarget = await isAncestor(git, head, "HEAD")
    expect(onTarget).toBe(true)
    // The change ref still says `opened`. Ancestry is the stronger reading, so a
    // hand merge in the garage shows as merged and nothing re-checks it.
    expect(facts.at(-1)?.kind).toBe("opened")
    expect(readChange({ branch: "task/one", branchHead: head, facts: written(facts), head, headOnBranch: onTarget }).state).toBe("merged")
  })

  it("a branch that moved off its head is failed, replaced; a branch that is gone, deleted", async () => {
    const { git, head } = await repository()
    await appendFact(git, { branch: "main", change: { branch: "task/one", head }, kind: "opened", subject: "submitted" })
    const facts = await readFacts(git, { branch: "task/one", head })

    const replaced = readChange({ branch: "task/one", branchHead: "0".repeat(40), facts: written(facts), head, headOnBranch: false })
    expect(replaced).toMatchObject({ reason: "replaced", state: "failed" })

    const deleted = readChange({ branch: "task/one", branchHead: undefined, facts: written(facts), head, headOnBranch: false })
    expect(deleted).toMatchObject({ reason: "deleted", state: "failed" })
  })

  it("stuck leaves the change open and carries its why", async () => {
    const { git, head } = await repository()
    await appendFact(git, { branch: "main", change: { branch: "task/one", head }, kind: "opened", subject: "submitted" })
    await appendFact(git, {
      branch: "main",
      change: { branch: "task/one", head },
      kind: "stuck",
      subject: "the queue could not judge this change",
      trailers: [["Reason", "check-timeout"]],
    })

    const facts = await readFacts(git, { branch: "task/one", head })
    expect(readChange({ branch: "task/one", branchHead: head, facts: written(facts), head, headOnBranch: false })).toMatchObject({
      reason: "check-timeout",
      state: "stuck",
    })
  })
})

async function isAncestor(git: Git, sha: string, of: string): Promise<boolean> {
  try {
    await git(["merge-base", "--is-ancestor", sha, of])
    return true
  } catch {
    return false
  }
}
