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
import {
  appendRecord,
  changeRef,
  gitIn,
  incidentFrom,
  incidentTrailers,
  readChange,
  readRecord,
  readRecords,
  refAt,
  trailer,
} from "../src/index.ts"
import type { ChangeRecord, Git } from "../src/index.ts"
import { cleanupRootChanges, readRootChanges } from "../src/records.ts"

/**
 * The records of a change that certainly has some. `ChangeRecords.records` is a
 * non-empty list by type, so the fixture says out loud that it wrote records
 * at the captured commit it reads.
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
    const sha = await appendRecord(git, "main", {
      change: { branch: "task/one", head },
      kind: "opened",
      subject: "@dev/2 submitted task/one to main",
      trailers: [
        ["Submitter", "@dev/2"],
        ["Issue", "@i/10-yrd/24061"],
      ],
    })

    const records = await readRecords(git, sha)
    expect(records).toHaveLength(1)
    expect(records[0]?.kind).toBe("opened")
    expect(records[0]?.sha).toBe(sha)
    expect(trailer(records[0]!, "Submitter")).toBe("@dev/2")
    expect(trailer(records[0]!, "Issue")).toBe("@i/10-yrd/24061")

    // The head is the record's parent, so the content stays reachable from the
    // change ref alone: a prune of the branch cannot orphan what was judged.
    const parents = (await git(["rev-list", "--parents", "-n", "1", sha])).trim().split(/\s+/u)
    expect(parents.slice(1)).toContain(head)
    expect((await git(["rev-parse", changeRef("main", { branch: "task/one", head })])).trim()).toBe(sha)
  })

  it("keeps the records in the order they happened", async () => {
    const { git, head } = await repository()
    const opened = await appendRecord(git, "main", {
      change: { branch: "task/one", head },
      kind: "opened",
      subject: "submitted",
    })
    const checked = await appendRecord(git, "main", {
      change: { branch: "task/one", head },
      kind: "checked",
      subject: "on-submit checks passed",
      trailers: [
        ["Config", "88f70021"],
        ["Check", "typecheck exit=0 ms=1200 log=/tmp/typecheck.log"],
        ["Check", "affected-tests exit=0 ms=90000 log=/tmp/tests.log"],
      ],
    })

    const records = await readRecords(git, checked)
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked"])
    expect((await git(["rev-list", "--parents", "-n", "1", checked])).trim().split(/\s+/u)).toEqual([checked, opened])
    expect(records[1]?.trailers.filter(([name]) => name === "Check")).toHaveLength(2)
  })

  // Requirement: a root-only checked intent retains its candidate merge with
  // the records, without making that merge a first-parent record. Before this
  // case, checked records had only their prior record as a parent, so a fresh
  // clone could lose the candidate merge after its branch disappeared.
  it("retains a checked root-only intent's merge outside first-parent record history", async () => {
    const { git, head, root, target } = await repository()
    const change = { branch: "task/one", head }
    const opened = await appendRecord(git, "main", { change, kind: "opened", subject: "submitted" })
    const tree = (await git(["rev-parse", `${head}^{tree}`])).trim()
    const merge = (await git(["commit-tree", tree, "-p", target, "-p", head, "-m", "candidate merge"])).trim()
    const checked = await appendRecord(git, "main", {
      change,
      kind: "checked",
      subject: "root-only intent checked",
      trailers: [
        ["Config", "88f70021"],
        ["Merge", merge],
      ],
    })

    expect((await git(["rev-list", "--parents", "-n", "1", checked])).trim().split(/\s+/u)).toEqual([
      checked,
      opened,
      merge,
    ])
    expect((await git(["log", "--first-parent", "--format=%H", checked])).split("\n")).not.toContain(merge)
    const records = await readRecords(git, checked)
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked"])
    expect(trailer(records[1]!, "Landing")).toBeUndefined()

    const recoveryRoot = mkdtempSync(join(tmpdir(), "yrd-core-recovery-"))
    roots.push(recoveryRoot)
    const recovery = join(recoveryRoot, "repo.git")
    await git(["clone", "--mirror", "--no-local", root, recovery])
    await expect(gitIn(recovery)(["cat-file", "-e", `${merge}^{commit}`])).resolves.toBe("")
  })

  // Requirement: preserve the exact approved root JSON through a checked record,
  // with no producer ref after cleanup or cold clone. Existing merge retention
  // coverage had no automatic-change payload, malformed receipt, or CAS cleanup.
  it("copies exact root receipt bytes, refuses unsafe cleanup, and recovers without the producer ref", async () => {
    const { git, head, root, target } = await repository()
    const change = { branch: "task/one", head }
    const opened = await appendRecord(git, "main", { change, kind: "opened", subject: "submitted" })
    const path = "submodule\ufffd*"
    const tree = (await git(["mktree", "-z"], `160000 commit ${head}\t${path}\0`)).trim()
    const merge = (await git(["commit-tree", tree, "-p", target, "-p", head, "-m", "automatic raise"])).trim()
    await expect(readRootChanges(git, merge)).resolves.toBeUndefined()
    // Whitespace and key order are deliberate: JSON is not required to be canonical.
    const json =
      JSON.stringify({ changes: [{ path, mode: "160000", from: target, to: head }], merge, version: 1 }, null, 2) + "\n"
    const blob = (await git(["hash-object", "-w", "--stdin"], json)).trim()
    const receiptTree = (await git(["mktree", "-z"], `100644 blob ${blob}\treceipt.json\0`)).trim()
    const receipt = (await git(["commit-tree", receiptTree, "-p", merge, "-m", "receipt"])).trim()
    const ref = `refs/git-super/receipts/${merge}`
    await git(["update-ref", ref, receipt])
    const validated = await readRootChanges(git, merge)
    expect(validated).toMatchObject({
      merge,
      encoded: Buffer.from(json).toString("base64"),
      receipt: { ref, oid: receipt },
      changes: [{ path, mode: "160000", from: target, to: head }],
    })
    if (validated === undefined) throw new Error("fixture receipt missing")
    await expect(cleanupRootChanges(git, validated, opened)).rejects.toThrow(
      "does not retain the exact validated receipt",
    )
    expect(await refAt(git, ref)).toBe(receipt)
    const checked = await appendRecord(git, "main", {
      change,
      kind: "checked",
      subject: "checked",
      trailers: [
        ["Merge", merge],
        ["Root-Changes", validated.encoded],
      ],
    })
    expect(trailer(await readRecord(git, checked), "Root-Changes")).toBe(validated.encoded)
    const replacement = (
      await git(["commit-tree", receiptTree, "-p", merge, "-m", "competing identical payload"])
    ).trim()
    await git(["update-ref", ref, replacement, receipt])
    await expect(cleanupRootChanges(git, validated, checked)).rejects.toThrow("changed; preserve its unexpected value")
    expect(await refAt(git, ref)).toBe(replacement)
    await git(["update-ref", ref, receipt, replacement])
    await cleanupRootChanges(git, validated, checked)
    await cleanupRootChanges(git, validated, checked)
    expect(await refAt(git, ref)).toBeUndefined()
    const recovery = join(root, "..", `${root.split("/").at(-1)}-receipt-recovery.git`)
    roots.push(recovery)
    await git(["clone", "--mirror", "--no-local", root, recovery])
    const cold = gitIn(recovery)
    expect(await refAt(cold, ref)).toBeUndefined()
    const record = await readRecord(cold, checked)
    await expect(readRootChanges(cold, merge, trailer(record, "Root-Changes"))).resolves.toMatchObject({
      merge,
      encoded: validated.encoded,
      changes: validated.changes,
    })
    expect((await readRecords(cold, checked)).map((row) => row.kind)).toEqual(["opened", "checked"])
  })

  it("rejects malformed present receipts and copied fields without treating them as absence", async () => {
    const { git, head, root, target } = await repository()
    const change = { branch: "task/one", head }
    await appendRecord(git, "main", { change, kind: "opened", subject: "submitted" })
    const tree = (await git(["mktree", "-z"], `160000 commit ${head}\tsubmodule\0`)).trim()
    const merge = (await git(["commit-tree", tree, "-p", target, "-p", head, "-m", "raise"])).trim()
    const row = { path: "submodule", mode: "160000", from: target, to: head }
    const payload = { version: 1, merge, changes: [row] }
    const good = JSON.stringify(payload)
    const ref = `refs/git-super/receipts/${merge}`
    for (const [json, message] of [
      [good.replace('"version":1', '"version":0,"v\\u0065rsion":1'), "duplicate JSON field version"],
      [good.replace('"path":"submodule"', '"path":"wrong","p\\u0061th":"submodule"'), "duplicate JSON field path"],
      [JSON.stringify({ ...payload, version: 2 }), "version 1"],
      [JSON.stringify({ ...payload, merge: head }), "exact Merge"],
      [JSON.stringify({ ...payload, changes: [row, row] }), "must be unique"],
      [JSON.stringify({ ...payload, changes: [{ ...row, path: "../submodule" }] }), "root-relative"],
      [JSON.stringify({ ...payload, changes: [{ ...row, mode: "100644" }] }), "mode 160000"],
      [JSON.stringify({ ...payload, changes: [{ ...row, to: target }] }), "does not match"],
      [JSON.stringify({ ...payload, changes: [{ ...row, from: target.slice(0, 12) }] }), "full from/to OIDs"],
    ] as const) {
      const blob = (await git(["hash-object", "-w", "--stdin"], json)).trim()
      const receiptTree = (await git(["mktree", "-z"], `100644 blob ${blob}\treceipt.json\0`)).trim()
      const receipt = (await git(["commit-tree", receiptTree, "-p", merge, "-m", "malformed receipt"])).trim()
      await git(["update-ref", ref, receipt])
      await expect(readRootChanges(git, merge)).rejects.toThrow(message)
      await expect(readRootChanges(git, merge, Buffer.from(json).toString("base64"))).rejects.toThrow(message)
    }
    const blob = (await git(["hash-object", "-w", "--stdin"], good)).trim()
    await git(["update-ref", ref, blob])
    await expect(readRootChanges(git, merge)).rejects.toThrow("does not name one commit")
    const receiptTree = (await git(["mktree", "-z"], `100644 blob ${blob}\treceipt.json\0`)).trim()
    const replay = (await git(["commit-tree", receiptTree, "-p", head, "-m", "wrong parent"])).trim()
    await git(["update-ref", ref, replay])
    await expect(readRootChanges(git, merge)).rejects.toThrow("must have sole parent")
    const extraTree = (
      await git(["mktree", "-z"], `100644 blob ${blob}\treceipt.json\0` + `100644 blob ${blob}\textra.json\0`)
    ).trim()
    const extra = (await git(["commit-tree", extraTree, "-p", merge, "-m", "extra file"])).trim()
    await git(["update-ref", ref, extra])
    await expect(readRootChanges(git, merge)).rejects.toThrow("exactly one regular receipt.json")
    const invalidBlob = Bun.spawnSync(["git", "-C", root, "hash-object", "-w", "--stdin"], {
      stdin: Buffer.from([0xff]),
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(invalidBlob.exitCode, invalidBlob.stderr.toString()).toBe(0)
    const invalidTree = (
      await git(["mktree", "-z"], `100644 blob ${invalidBlob.stdout.toString().trim()}\treceipt.json\0`)
    ).trim()
    const invalidReceipt = (await git(["commit-tree", invalidTree, "-p", merge, "-m", "invalid UTF-8"])).trim()
    await git(["update-ref", ref, invalidReceipt])
    await expect(readRootChanges(git, merge)).rejects.toThrow("not lossless UTF-8")
    const readFailure = new Error("receipt ref read failed in the selected repository")
    await expect(
      readRootChanges(async (args, input) => {
        if (args[0] === "for-each-ref") throw readFailure
        return git(args, input)
      }, merge),
    ).rejects.toBe(readFailure)
    await expect(readRootChanges(git, merge, "not-base64!")).rejects.toThrow("canonical base64")
    await expect(readRootChanges(git, merge, Buffer.from([0xff]).toString("base64"))).rejects.toThrow("not UTF-8")
    const encoded = Buffer.from(good).toString("base64")
    await expect(
      appendRecord(git, "main", {
        change,
        kind: "checked",
        subject: "ambiguous",
        trailers: [
          ["Merge", merge],
          ["Root-Changes", encoded],
          ["root-changes", encoded],
        ],
      }),
    ).rejects.toThrow("exactly one Root-Changes")
    const badRecord = (
      await git([
        "commit-tree",
        tree,
        "-p",
        merge,
        "-m",
        `malformed\n\nRecord: checked\nChange: task/one@${head}\nMerge: ${merge}\nRoot-Changes: invalid!\n`,
      ])
    ).trim()
    await expect(readRecord(git, badRecord)).rejects.toThrow("canonical base64")
    const unretained = (
      await git([
        "commit-tree",
        tree,
        "-p",
        head,
        "-m",
        `unretained\n\nRecord: checked\nChange: task/one@${head}\nMerge: ${merge}\nRoot-Changes: ${encoded}\n`,
      ])
    ).trim()
    await expect(readRecord(git, unretained)).rejects.toThrow("as its second parent")
    await expect(readRecords(git, unretained)).rejects.toThrow("as its second parent")
  })

  it.each([
    ["a malformed candidate id", [["Merge", "not-an-object-id"]], /Merge: must name a full object id/u],
    [
      "ambiguous candidate ids",
      [
        ["Merge", "a".repeat(40)],
        ["Merge", "b".repeat(40)],
      ],
      /2 Merge: trailers/u,
    ],
  ] as const)("refuses checked intent with %s", async (_name, trailers, error) => {
    const { git, head } = await repository()
    const change = { branch: "task/one", head }
    await appendRecord(git, "main", { change, kind: "opened", subject: "submitted" })
    await expect(appendRecord(git, "main", { change, kind: "checked", subject: "checked", trailers })).rejects.toThrow(
      error,
    )
  })

  it("refuses a second writer that read the same tip, instead of interleaving", async () => {
    const { git, head } = await repository()
    await appendRecord(git, "main", {
      change: { branch: "task/one", head },
      kind: "opened",
      subject: "submitted",
    })
    const ref = changeRef("main", { branch: "task/one", head })
    const tip = (await git(["rev-parse", ref])).trim()
    await appendRecord(git, "main", {
      change: { branch: "task/one", head },
      kind: "checked",
      subject: "checks passed",
    })

    // The loser's own update-ref, replayed with the tip it had read.
    const stale = (
      await git([
        "commit-tree",
        "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        "-p",
        tip,
        "-p",
        head,
        "-m",
        "late\n\nRecord: checked\n",
      ])
    ).trim()
    await expect(git(["update-ref", ref, stale, tip])).rejects.toThrow()
    const records = await readRecords(git, (await refAt(git, ref))!)
    expect(records.map((record) => record.kind)).toEqual(["opened", "checked"])
  })

  it("refuses a history whose tip lacks the expected Record trailer, naming the commit", async () => {
    const { git, head } = await repository()
    const ref = changeRef("main", { branch: "task/malformed", head })
    const malformed = (
      await git(["commit-tree", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-p", head, "-m", "not a change record"])
    ).trim()
    await git(["update-ref", ref, malformed])
    await expect(readRecords(git, malformed)).rejects.toThrow(
      `at ${malformed.slice(0, 12)} carries no valid Record: opened|checked|merged|failed|stuck|sent trailer`,
    )
  })

  it("refuses a record without its Change trailer, naming the commit", async () => {
    const { git, head } = await repository()
    const ref = changeRef("main", { branch: "task/nameless", head })
    const nameless = (
      await git([
        "commit-tree",
        "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        "-p",
        head,
        "-m",
        "nameless change\n\nRecord: opened\n",
      ])
    ).trim()
    await git(["update-ref", ref, nameless])

    await expect(readRecords(git, nameless)).rejects.toThrow(`at ${nameless.slice(0, 12)} carries no Change: trailer`)
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

  it("finds no change ref for a branch nobody submitted", async () => {
    const { git, head } = await repository()
    expect(await refAt(git, changeRef("main", { branch: "task/one", head }))).toBeUndefined()
  })
})

describe("the state is derived, and ancestry wins over any record", () => {
  it("queued, then checked, from the records", async () => {
    const { git, head } = await repository()
    const opened = await appendRecord(git, "main", {
      change: { branch: "task/one", head },
      kind: "opened",
      subject: "submitted",
    })
    let records = await readRecords(git, opened)
    expect(
      readChange({ branch: "task/one", branchHead: head, records: written(records), head, headOnTarget: false }).state,
    ).toBe("queued")

    const checked = await appendRecord(git, "main", {
      change: { branch: "task/one", head },
      kind: "checked",
      subject: "checks passed",
    })
    records = await readRecords(git, checked)
    expect(
      readChange({ branch: "task/one", branchHead: head, records: written(records), head, headOnTarget: false }).state,
    ).toBe("checked")
  })

  it("merged from ancestry alone, with no merged record written", async () => {
    const { git, head, target } = await repository()
    const opened = await appendRecord(git, "main", {
      change: { branch: "task/one", head },
      kind: "opened",
      subject: "submitted",
    })
    await git(["merge", "--quiet", "--no-ff", "-m", "merge task/one", head])
    expect((await git(["rev-parse", "HEAD"])).trim()).not.toBe(target)

    const records = await readRecords(git, opened)
    const onTarget = await isAncestor(git, head, "HEAD")
    expect(onTarget).toBe(true)
    // The change ref still says `opened`. Ancestry is the stronger reading, so a
    // direct in the garage shows as merged and nothing re-checks it.
    expect(records.at(-1)?.kind).toBe("opened")
    expect(
      readChange({ branch: "task/one", branchHead: head, records: written(records), head, headOnTarget: onTarget })
        .state,
    ).toBe("merged")
  })

  it("a branch that moved off its head is failed, replaced; a branch that is gone, deleted", async () => {
    const { git, head } = await repository()
    const opened = await appendRecord(git, "main", {
      change: { branch: "task/one", head },
      kind: "opened",
      subject: "submitted",
    })
    const records = await readRecords(git, opened)

    const replaced = readChange({
      branch: "task/one",
      branchHead: "0".repeat(40),
      records: written(records),
      head,
      headOnTarget: false,
    })
    expect(replaced).toMatchObject({ reason: "replaced", state: "failed" })

    const deleted = readChange({
      branch: "task/one",
      branchHead: undefined,
      records: written(records),
      head,
      headOnTarget: false,
    })
    expect(deleted).toMatchObject({ reason: "deleted", state: "failed" })
  })

  it("stuck leaves the change open and carries its why", async () => {
    const { git, head } = await repository()
    await appendRecord(git, "main", {
      change: { branch: "task/one", head },
      kind: "opened",
      subject: "submitted",
    })
    const incident = {
      code: "yrd-check-unresolved",
      subject: "the queue could not judge this change",
      via: "verify during merge",
      evidence: "/tmp/q-one.jsonl",
      next: "repair verify, then run yrd queue run",
      owner: "the queue operator",
    } as const
    const stuck = await appendRecord(git, "main", {
      change: { branch: "task/one", head },
      kind: "stuck",
      subject: incident.subject,
      trailers: incidentTrailers(incident),
    })

    const records = await readRecords(git, stuck)
    expect(incidentFrom(records.at(-1)!)).toEqual(incident)
    expect(
      readChange({ branch: "task/one", branchHead: head, records: written(records), head, headOnTarget: false }),
    ).toMatchObject({
      reason: "yrd-check-unresolved",
      state: "stuck",
    })
  })

  it("refuses a partial stuck incident instead of silently inventing missing evidence", async () => {
    // A list/show reader must get the complete durable cause from the record;
    // existing state tests only prove the happy path with all six fields.
    const { git, head } = await repository()
    const stuck = await appendRecord(git, "main", {
      change: { branch: "task/one", head },
      kind: "stuck",
      subject: "the queue could not judge this change",
      trailers: [["Code", "yrd-check-unresolved"]],
    })

    const records = await readRecords(git, stuck)
    expect(() =>
      readChange({ branch: "task/one", branchHead: head, records: written(records), head, headOnTarget: false }),
    ).toThrow(/carries 0 Subject: trailers; a queue incident needs exactly one non-empty value/u)
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
