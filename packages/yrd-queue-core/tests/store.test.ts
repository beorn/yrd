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
import { appendFact, changeRef, gitIn, readChange, readFacts, trailer } from "../src/index.ts"
import type { Git } from "../src/index.ts"

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

/** A repository with one commit on `main`, and a branch one commit ahead. */
async function repository(): Promise<Readonly<{ git: Git; root: string; head: string; target: string }>> {
  const root = mkdtempSync(join(tmpdir(), "yrd-core-"))
  roots.push(root)
  const git = gitIn(root)
  await git(["init", "--initial-branch=main", "--quiet"])
  await git(["config", "user.email", "queue@yrd.test"])
  await git(["config", "user.name", "yrd"])
  writeFileSync(join(root, "target.txt"), "base\n")
  await git(["add", "target.txt"])
  await git(["commit", "--quiet", "-m", "base"])
  const target = (await git(["rev-parse", "HEAD"])).trim()
  await git(["checkout", "--quiet", "-b", "task/one"])
  writeFileSync(join(root, "one.txt"), "one\n")
  await git(["add", "one.txt"])
  await git(["commit", "--quiet", "-m", "one"])
  const head = (await git(["rev-parse", "HEAD"])).trim()
  await git(["checkout", "--quiet", "main"])
  return { git, head, root, target }
}

describe("a change's facts are its commits", () => {
  it("opened writes one fact, reachable with its head, readable back", async () => {
    const { git, head } = await repository()
    const sha = await appendFact(git, {
      branch: "task/one",
      head,
      kind: "opened",
      subject: "@dev/2 submitted task/one to main",
      trailers: [
        ["Submitter", "@dev/2"],
        ["Target", "main"],
        ["Work-Item", "@i/10-yrd/24061"],
      ],
    })

    const facts = await readFacts(git, "task/one", head)
    expect(facts).toHaveLength(1)
    expect(facts[0]?.kind).toBe("opened")
    expect(facts[0]?.sha).toBe(sha)
    expect(trailer(facts[0]!, "Submitter")).toBe("@dev/2")
    expect(trailer(facts[0]!, "Work-Item")).toBe("@i/10-yrd/24061")

    // The head is the fact's parent, so the content stays reachable from the
    // change ref alone: a prune of the branch cannot orphan what was judged.
    const parents = (await git(["rev-list", "--parents", "-n", "1", sha])).trim().split(/\s+/u)
    expect(parents.slice(1)).toContain(head)
    expect((await git(["rev-parse", changeRef("task/one", head)])).trim()).toBe(sha)
  })

  it("keeps the facts in the order they happened", async () => {
    const { git, head } = await repository()
    await appendFact(git, { branch: "task/one", head, kind: "opened", subject: "submitted" })
    await appendFact(git, {
      branch: "task/one",
      head,
      kind: "checked",
      subject: "on-submit checks passed",
      trailers: [
        ["Config", "88f70021"],
        ["Check", "typecheck exit=0 ms=1200 log=/tmp/typecheck.log"],
        ["Check", "affected-tests exit=0 ms=90000 log=/tmp/tests.log"],
      ],
    })

    const facts = await readFacts(git, "task/one", head)
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "checked"])
    expect(facts[1]?.trailers.filter(([name]) => name === "Check")).toHaveLength(2)
  })

  it("refuses a second writer that read the same tip, instead of interleaving", async () => {
    const { git, head } = await repository()
    await appendFact(git, { branch: "task/one", head, kind: "opened", subject: "submitted" })
    const ref = changeRef("task/one", head)
    const tip = (await git(["rev-parse", ref])).trim()
    await appendFact(git, { branch: "task/one", head, kind: "checked", subject: "checks passed" })

    // The loser's own update-ref, replayed with the tip it had read.
    const stale = (await git(["commit-tree", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-p", tip, "-p", head, "-m", "late\n\nFact: checked\n"])).trim()
    await expect(git(["update-ref", ref, stale, tip])).rejects.toThrow()
    const facts = await readFacts(git, "task/one", head)
    expect(facts.map((fact) => fact.kind)).toEqual(["opened", "checked"])
  })

  it("reads no facts for a branch nobody submitted", async () => {
    const { git, head } = await repository()
    expect(await readFacts(git, "task/one", head)).toEqual([])
  })
})

describe("the state is derived, and ancestry wins over any fact", () => {
  it("queued, then checked, from the facts", async () => {
    const { git, head } = await repository()
    await appendFact(git, { branch: "task/one", head, kind: "opened", subject: "submitted" })
    let facts = await readFacts(git, "task/one", head)
    expect(readChange({ branchHead: head, facts, head, headOnTarget: false }).state).toBe("queued")

    await appendFact(git, { branch: "task/one", head, kind: "checked", subject: "checks passed" })
    facts = await readFacts(git, "task/one", head)
    expect(readChange({ branchHead: head, facts, head, headOnTarget: false }).state).toBe("checked")
  })

  it("merged from ancestry alone, with no merged fact written", async () => {
    const { git, head, target } = await repository()
    await appendFact(git, { branch: "task/one", head, kind: "opened", subject: "submitted" })
    await git(["merge", "--quiet", "--no-ff", "-m", "merge task/one", head])
    expect((await git(["rev-parse", "HEAD"])).trim()).not.toBe(target)

    const facts = await readFacts(git, "task/one", head)
    const onTarget = await isAncestor(git, head, "HEAD")
    expect(onTarget).toBe(true)
    // The change ref still says `opened`. Ancestry is the stronger reading, so a
    // hand merge in the garage shows as merged and nothing re-checks it.
    expect(facts.at(-1)?.kind).toBe("opened")
    expect(readChange({ branchHead: head, facts, head, headOnTarget: onTarget }).state).toBe("merged")
  })

  it("a branch that moved off its head is failed, replaced; a branch that is gone, deleted", async () => {
    const { git, head } = await repository()
    await appendFact(git, { branch: "task/one", head, kind: "opened", subject: "submitted" })
    const facts = await readFacts(git, "task/one", head)

    const replaced = readChange({ branchHead: "0".repeat(40), facts, head, headOnTarget: false })
    expect(replaced).toMatchObject({ reason: "replaced", state: "failed" })

    const deleted = readChange({ branchHead: undefined, facts, head, headOnTarget: false })
    expect(deleted).toMatchObject({ reason: "deleted", state: "failed" })
  })

  it("stuck leaves the change open and carries its why", async () => {
    const { git, head } = await repository()
    await appendFact(git, { branch: "task/one", head, kind: "opened", subject: "submitted" })
    await appendFact(git, {
      branch: "task/one",
      head,
      kind: "stuck",
      subject: "the queue could not judge this change",
      trailers: [["Why", "check-timeout"]],
    })

    const facts = await readFacts(git, "task/one", head)
    expect(readChange({ branchHead: head, facts, head, headOnTarget: false })).toMatchObject({
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
