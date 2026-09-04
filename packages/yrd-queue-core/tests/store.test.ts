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
import { appendRecord,
  changeName,
  changeRef, gitIn, readChange, readRecord, readRecords, trailer,
} from "../src/index.ts"
import type { ChangeRecord, Git } from "../src/index.ts"

/**
 * The records of a change that certainly has some. `ChangeRecords.records` is a
 * non-empty list by type, and `readRecords` answers an unknown change with none,
 * so the fixture says out loud which of the two it wrote.
 */
function written(records: readonly ChangeRecord[]): readonly [ChangeRecord, ...ChangeRecord[]] {
  const [first, ...rest] = records
  if (first === undefined) throw new Error("the fixture wrote no records to read a change from")
  return [first, ...rest]
}

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

describe("a change's records are its commits", () => {
  it("opened writes one record, reachable with its head, readable back", async () => {
    const { git, head } = await repository()
    const sha = await appendRecord(git, {
      change: { branch: "task/one", head },
      kind: "opened",
      subject: "@dev/2 submitted task/one to main",
      target: "origin#main",
      trailers: [
        ["Submitter", "@dev/2"],
        ["Issue", "@i/10-yrd/24061"],
      ],
    })

    const records = await readRecords(git, { branch: "task/one", head })
    expect(records).toHaveLength(1)
    expect(records[0]?.kind).toBe("opened")
    expect(records[0]?.sha).toBe(sha)
    expect(trailer(records[0]!, "Submitter")).toBe("@dev/2")
    expect(trailer(records[0]!, "Issue")).toBe("@i/10-yrd/24061")

    // The head is the record's parent, so the content stays reachable from the
    // change ref alone: a prune of the branch cannot orphan what was judged.
    const parents = (await git(["rev-list", "--parents", "-n", "1", sha])).trim().split(/\s+/u)
    expect(parents.slice(1)).toContain(head)
    expect((await git(["rev-parse", changeRef({ branch: "task/one", head })])).trim()).toBe(sha)
  })

  it("keeps the records in the order they happened", async () => {
    const { git, head } = await repository()
    await appendRecord(git, { change: { branch: "task/one", head }, kind: "opened", subject: "submitted", target: "origin#main",
    })
    await appendRecord(git, {
      change: { branch: "task/one", head },
      kind: "checked",
      subject: "on-submit checks passed",
      target: "origin#main",
      trailers: [
        ["Config", "88f70021"],
        ["Check", "typecheck exit=0 ms=1200 log=/tmp/typecheck.log"],
        ["Check", "affected-tests exit=0 ms=90000 log=/tmp/tests.log"],
      ],
    })

    const records = await readRecords(git, { branch: "task/one", head })
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked"])
    expect(records[1]?.trailers.filter(([name]) => name === "Check")).toHaveLength(2)
  })

  it("refuses a second writer that read the same tip, instead of interleaving", async () => {
    const { git, head } = await repository()
    await appendRecord(git, { change: { branch: "task/one", head }, kind: "opened", subject: "submitted", target: "origin#main",
    })
    const ref = changeRef({ branch: "task/one", head })
    const tip = (await git(["rev-parse", ref])).trim()
    await appendRecord(git, { change: { branch: "task/one", head }, kind: "checked", subject: "checks passed", target: "origin#main",
    })

    // The loser's own update-ref, replayed with the tip it had read.
    const stale = (await git(["commit-tree", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-p", tip, "-p", head, "-m", "late\n\nRecord: checked\n",
      ])).trim()
    await expect(git(["update-ref", ref, stale, tip])).rejects.toThrow()
    const records = await readRecords(git, { branch: "task/one", head })
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked"])
  })

  it("refuses a change ref whose tip lacks the expected Record trailer, naming the ref and commit", async () => {
    const { git, head } = await repository()
    const ref = changeRef({ branch: "task/malformed", head })
    const malformed = (
      await git([
          "commit-tree",
          "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
          "-p",
          head,
          "-m",
        "not a change record",
      ])
    ).trim()
    await git([
      "update-ref",
      ref,
      malformed,
    ])
    await expect(readRecords(git, { branch: "task/malformed", head })).rejects.toThrow(
      `${ref} at ${malformed.slice(0, 12)} carries no valid Record: opened|checked|merged|failed|stuck|sent trailer`,
    )
  })

  it("git's own parser reads the trailers: prose that looks like one is not, and a folded value reads whole", async () => {
    // A `^Key: value$` scan written by hand called every line that looked like a
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
          "Record: failed",
          "Change: task/one@abc",
          "Target: main",
          "Detail: what git said,",
          "  wrapped onto a second line",
          "",
        ].join("\n"),
      ])
    ).trim()

    const record = await readRecord(git, sha)

    expect(record.kind).toBe("failed")
    expect(record.subject).toBe("task/one failed")
    expect(trailer(record, "Note")).toBeUndefined()
    expect(trailer(record, "Detail")).toBe("what git said, wrapped onto a second line")
  })

  it("reads no records for a branch nobody submitted", async () => {
    const { git, head } = await repository()
    expect(await readRecords(git, { branch: "task/one", head })).toEqual([])
  })
})

describe("the state is derived, and ancestry wins over any record", () => {
  it("queued, then checked, from the records", async () => {
    const { git, head } = await repository()
    await appendRecord(git, { change: { branch: "task/one", head }, kind: "opened", subject: "submitted", target: "origin#main",
    })
    let records = await readRecords(git, { branch: "task/one", head })
    expect(readChange({ branch: "task/one", branchHead: head, records: written(records), head, headOnTarget: false }).state,
    ).toBe("queued")

    await appendRecord(git, { change: { branch: "task/one", head }, kind: "checked", subject: "checks passed", target: "origin#main",
    })
    records = await readRecords(git, { branch: "task/one", head })
    expect(readChange({ branch: "task/one", branchHead: head, records: written(records), head, headOnTarget: false }).state,
    ).toBe("checked")
  })

  it("merged from ancestry alone, with no merged record written", async () => {
    const { git, head, target } = await repository()
    await appendRecord(git, { change: { branch: "task/one", head }, kind: "opened", subject: "submitted", target: "origin#main",
    })
    await git(["merge", "--quiet", "--no-ff", "-m", "merge task/one", head])
    expect((await git(["rev-parse", "HEAD"])).trim()).not.toBe(target)

    const records = await readRecords(git, { branch: "task/one", head })
    const onTarget = await isAncestor(git, head, "HEAD")
    expect(onTarget).toBe(true)
    // The change ref still says `opened`. Ancestry is the stronger reading, so a
    // direct in the garage shows as merged and nothing re-checks it.
    expect(records.at(-1)?.kind).toBe("opened")
    expect(readChange({ branch: "task/one", branchHead: head, records: written(records), head, headOnTarget: onTarget }).state,
    ).toBe("merged")
  })

  it("a branch that moved off its head is failed, replaced; a branch that is gone, deleted", async () => {
    const { git, head } = await repository()
    await appendRecord(git, { change: { branch: "task/one", head }, kind: "opened", subject: "submitted", target: "origin#main",
    })
    const records = await readRecords(git, { branch: "task/one", head })

    const replaced = readChange({ branch: "task/one", branchHead: "0".repeat(40), records: written(records), head, headOnTarget: false,
    })
    expect(replaced).toMatchObject({ reason: "replaced", state: "failed" })

    const deleted = readChange({ branch: "task/one", branchHead: undefined, records: written(records), head, headOnTarget: false,
    })
    expect(deleted).toMatchObject({ reason: "deleted", state: "failed" })
  })

  it("stuck leaves the change open and carries its why", async () => {
    const { git, head } = await repository()
    await appendRecord(git, { change: { branch: "task/one", head }, kind: "opened", subject: "submitted", target: "origin#main",
    })
    await appendRecord(git, {
      change: { branch: "task/one", head },
      kind: "stuck",
      subject: "the queue could not judge this change",
      target: "origin#main",
      trailers: [["Reason", "check-timeout"]],
    })

    const records = await readRecords(git, { branch: "task/one", head })
    expect(readChange({ branch: "task/one", branchHead: head, records: written(records), head, headOnTarget: false }),
    ).toMatchObject({
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
