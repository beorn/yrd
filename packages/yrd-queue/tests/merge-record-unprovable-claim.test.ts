/**
 * @failure A merge-record refusal names the Change-Id — the half that VERIFIES whenever reachability
 * is what broke — so every reader is steered at the wrong cause; and the writer can mint the
 * contradiction in the first place, recording generated commits for a merge that joined nothing to
 * history, which no later verification can ever prove.
 * @level l2
 * @consumer yrd why
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createProcess } from "@yrd/process"
import {
  createMergeRecord,
  createMergeRecordRetraction,
  findRepositoryMergeRecords,
  MERGE_RECORD_NOTES_NAME,
  MERGE_RECORD_RETRACTION_NOTES_NAME,
  mergeRecordChecksum,
  repairMergeRecordEstate,
  unprovableMergeRecordClaim,
} from "@yrd/queue"
import type { MergeRecordBody } from "@yrd/queue"

const CHANGE_ID = `I${"7".repeat(40)}`
const OTHER_CHANGE_ID = `I${"9".repeat(40)}`
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(repo: string, args: readonly string[], stdin?: string): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    ...(stdin === undefined ? {} : { stdin: new TextEncoder().encode(stdin) }),
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

/**
 * Three commits in a line. `predecessor` stands in for the PREVIOUS merge's merge
 * commit — the sha the poisoned real-world record (`faba4bfe…`) put in its own
 * `mergedCommit` field — and `generated` is its CHILD carrying a correct Change-Id
 * trailer. A child can never be reachable from its parent, so the record can never
 * prove itself no matter how sound its Change-Id is.
 */
async function linearRepository(): Promise<
  Readonly<{ repo: string; predecessor: string; generated: string; tip: string }>
> {
  const root = await mkdtemp(join(tmpdir(), "yrd-unprovable-claim-"))
  roots.push(root)
  const repo = join(root, "repo")
  await Bun.$`git init -q -b main ${repo}`.quiet()
  await git(repo, ["config", "user.email", "yrd@example.invalid"])
  await git(repo, ["config", "user.name", "Yrd Test"])

  await writeFile(join(repo, "a.txt"), "a\n")
  await git(repo, ["add", "a.txt"])
  await git(repo, ["commit", "-qm", "yrd: merge PR1060 revision 2"])
  const predecessor = await git(repo, ["rev-parse", "HEAD"])

  await writeFile(join(repo, "b.txt"), "b\n")
  await git(repo, ["add", "b.txt"])
  await git(repo, ["commit", "-qm", `yrd: merge PR1061 revision 1\n\nChange-Id: ${CHANGE_ID}`])
  const generated = await git(repo, ["rev-parse", "HEAD"])

  await writeFile(join(repo, "c.txt"), "c\n")
  await git(repo, ["add", "c.txt"])
  await git(repo, ["commit", "-qm", "later merge"])
  const tip = await git(repo, ["rev-parse", "HEAD"])

  return { repo, predecessor, generated, tip }
}

function record(
  id: string,
  mergedCommit: string,
  change: MergeRecordBody["changes"][number],
  baseSha = mergedCommit,
): MergeRecordBody {
  return {
    merge: {
      id,
      base: "main",
      baseSha,
      candidate: `candidate:${id}`,
      result: "merged",
      mergedCommit,
      startedAt: "2026-08-16T00:49:39.730Z",
      finishedAt: "2026-08-16T00:50:06.095Z",
    },
    changes: [change],
    evidence: { jobs: [] },
    pins: [],
  }
}

async function publish(repo: string, body: MergeRecordBody): Promise<void> {
  const anchor = await git(repo, ["hash-object", "-w", "--stdin"], `yrd merge ${body.merge.id}\n`)
  const blob = await git(repo, ["hash-object", "-w", "--stdin"], createMergeRecord(body).canonical)
  await git(repo, ["notes", `--ref=${MERGE_RECORD_NOTES_NAME}`, "add", "-C", blob, anchor])
}

describe("a merge-record refusal names the half that actually failed", () => {
  it("names REACHABILITY, and says the Change-Id was not the problem, for the faba4bfe shape", async () => {
    const { repo, predecessor, generated, tip } = await linearRepository()
    // The real poisoned record: mergedCommit is the PREDECESSOR's merge commit while
    // the generated commit is a child of it. The trailer is perfectly correct.
    await publish(
      repo,
      record("R2504", predecessor, {
        changeId: CHANGE_ID,
        pr: "PR1061",
        revision: 1,
        submittedHead: generated,
        generatedCommit: generated,
      }),
    )
    await using process = createProcess()

    const proof = await findRepositoryMergeRecords({ inject: { process }, repo, baseSha: tip })

    expect(proof).toMatchObject({ status: "repository-corrupt" })
    if (proof.status !== "repository-corrupt") throw new Error("expected a corrupt verdict")
    // The failing half, named.
    expect(proof.reason).toContain("REACHABILITY")
    expect(proof.reason).toContain(generated)
    expect(proof.reason).toContain(predecessor)
    expect(proof.reason).toContain("PR1061")
    // The half that VERIFIES must not be presented as the cause. This is the whole
    // bug: the old text read "cannot prove <Change-Id>" while that Change-Id was an
    // exact match, sending every reader after a trailer that was never wrong.
    expect(proof.reason).toContain("the Change-Id trailer was not the problem")
  })

  it("names the CHANGE-ID, and confirms reachability verified, when the trailer is what is wrong", async () => {
    const { repo, generated, tip } = await linearRepository()
    // Reachable from the recorded merge, but the record claims a Change-Id the
    // generated commit does not carry — the PR1019 producer class.
    await publish(
      repo,
      record("R2427", tip, {
        changeId: OTHER_CHANGE_ID,
        pr: "PR1019",
        revision: 1,
        submittedHead: generated,
        generatedCommit: generated,
      }),
    )
    await using process = createProcess()

    const proof = await findRepositoryMergeRecords({ inject: { process }, repo, baseSha: tip })

    expect(proof).toMatchObject({ status: "repository-corrupt" })
    if (proof.status !== "repository-corrupt") throw new Error("expected a corrupt verdict")
    expect(proof.reason).toContain("CHANGE-ID")
    expect(proof.reason).toContain(OTHER_CHANGE_ID)
    expect(proof.reason).toContain("reachability verified")
    // The two producer classes must be distinguishable from the message alone.
    expect(proof.reason).not.toContain("REACHABILITY")
  })

  it("enumerates BOTH producer classes in one isolated scan, not just the first", async () => {
    const { repo, predecessor, generated, tip } = await linearRepository()
    await publish(
      repo,
      record("R2504", predecessor, {
        changeId: CHANGE_ID,
        pr: "PR1061",
        revision: 1,
        submittedHead: generated,
        generatedCommit: generated,
      }),
    )
    await publish(
      repo,
      record("R2427", tip, {
        changeId: OTHER_CHANGE_ID,
        pr: "PR1019",
        revision: 1,
        submittedHead: generated,
        generatedCommit: generated,
      }),
    )
    await using process = createProcess()

    const isolated = await findRepositoryMergeRecords({
      inject: { process },
      repo,
      baseSha: tip,
      isolateUnverifiable: true,
    })

    if (isolated.status !== "proven") throw new Error("expected the scan to complete")
    // The estate holds >= 2 poisoned records from >= 2 producer classes. A repair
    // that fixed only the first failure would leave the estate still unprovable.
    expect(isolated.unverifiable).toHaveLength(2)
    const reasons = isolated.unverifiable.map((entry) => entry.reason).join("\n")
    expect(reasons).toContain("REACHABILITY")
    expect(reasons).toContain("CHANGE-ID")
  })
})

describe("the writer cannot mint a claim no verification could ever prove", () => {
  it("reports the contradiction when a no-op merge claims generated commits", () => {
    const poisoned = record("R2504", "c".repeat(40), {
      changeId: CHANGE_ID,
      pr: "PR1061",
      revision: 1,
      submittedHead: "9".repeat(40),
      generatedCommit: "9".repeat(40),
    })

    const claim = unprovableMergeRecordClaim(poisoned)

    expect(claim).toBeDefined()
    expect(claim).toContain("joined nothing to merged history")
    expect(claim).toContain("PR1061")
  })

  it("passes a no-op merge that honestly claims no generated commits", () => {
    const honest = record("R2504", "c".repeat(40), {
      changeId: CHANGE_ID,
      pr: "PR1061",
      revision: 1,
      submittedHead: "9".repeat(40),
    })

    expect(unprovableMergeRecordClaim(honest)).toBeUndefined()
  })

  it("passes a real merge that moved the base and claims its generated commit", () => {
    const real = record(
      "R2505",
      "d".repeat(40),
      {
        changeId: CHANGE_ID,
        pr: "PR1062",
        revision: 1,
        submittedHead: "9".repeat(40),
        generatedCommit: "9".repeat(40),
      },
      "c".repeat(40),
    )

    expect(unprovableMergeRecordClaim(real)).toBeUndefined()
  })

  it("still READS a poisoned record, because an unreadable record is an unrepairable one", () => {
    const poisoned = record("R2504", "c".repeat(40), {
      changeId: CHANGE_ID,
      pr: "PR1061",
      revision: 1,
      submittedHead: "9".repeat(40),
      generatedCommit: "9".repeat(40),
    })

    // The invariant is deliberately NOT a schema refinement: the repair path has to
    // parse exactly the records that violate it in order to retract them.
    expect(() => createMergeRecord(poisoned)).not.toThrow()
  })
})


describe("a retracted record stops poisoning the estate without rewriting history", () => {
  /** The note blob sha git assigned to a published record — what a retraction binds to. */
  async function noteBlobFor(repo: string, mergeId: string): Promise<string> {
    const anchor = await git(repo, ["hash-object", "-w", "--stdin"], `yrd merge ${mergeId}\n`)
    const listed = await git(repo, ["notes", `--ref=${MERGE_RECORD_NOTES_NAME}`, "list"])
    const row = listed.split("\n").find((line) => line.endsWith(anchor))
    if (row === undefined) throw new Error(`no note found for ${mergeId}`)
    const blob = row.split(/\s+/u)[0]
    if (blob === undefined) throw new Error("unreadable notes listing")
    return blob
  }

  async function retract(repo: string, body: MergeRecordBody, reason: string): Promise<string> {
    const note = await noteBlobFor(repo, body.merge.id)
    const canonical = createMergeRecordRetraction({
      schema: "yrd/merge-record-retraction/v1",
      note,
      checksum: mergeRecordChecksum(body),
      merge: body.merge.id,
      reason,
      classification: "unreachable-generated-commit",
      retractedAt: "2026-08-18T04:00:00.000Z",
    }).canonical
    const anchor = await git(repo, ["hash-object", "-w", "--stdin"], `yrd retract ${body.merge.id}\n`)
    const blob = await git(repo, ["hash-object", "-w", "--stdin"], canonical)
    await git(repo, ["notes", `--ref=${MERGE_RECORD_RETRACTION_NOTES_NAME}`, "add", "-C", blob, anchor])
    return note
  }

  it("verifies again once the unprovable record is retracted, and reports what it excused", async () => {
    const { repo, predecessor, generated, tip } = await linearRepository()
    const poisoned = record("R2504", predecessor, {
      changeId: CHANGE_ID,
      pr: "PR1061",
      revision: 1,
      submittedHead: generated,
      generatedCommit: generated,
    })
    await publish(repo, poisoned)
    await using process = createProcess()

    // Before: one bad record refuses the whole single-selector verdict.
    await expect(findRepositoryMergeRecords({ inject: { process }, repo, baseSha: tip })).resolves.toMatchObject({
      status: "repository-corrupt",
    })

    const note = await retract(repo, poisoned, "generated commit is a child of the recorded mergedCommit")

    // After: the estate answers again. This is what unwedges a pin advance that
    // has been failing on a record nobody can fix, without editing that record.
    const repaired = await findRepositoryMergeRecords({ inject: { process }, repo, baseSha: tip })
    expect(repaired).toMatchObject({ status: "proven" })
    if (repaired.status !== "proven") throw new Error("expected the estate to verify")
    // Excused, never hidden — the estate stays honest about what it gave up on.
    expect(repaired.retracted).toHaveLength(1)
    expect(repaired.retracted[0]?.note).toBe(note)
    expect(repaired.retracted[0]?.retraction.merge).toBe("R2504")
    expect(repaired.retracted[0]?.reason).toContain("REACHABILITY")
    // And it does NOT become proven truth.
    expect(repaired.records).toHaveLength(0)
  })

  it("leaves the original record byte-identical — the repair appends, never rewrites", async () => {
    const { repo, predecessor, generated } = await linearRepository()
    const poisoned = record("R2504", predecessor, {
      changeId: CHANGE_ID,
      pr: "PR1061",
      revision: 1,
      submittedHead: generated,
      generatedCommit: generated,
    })
    await publish(repo, poisoned)
    const before = await noteBlobFor(repo, "R2504")

    await retract(repo, poisoned, "generated commit is a child of the recorded mergedCommit")

    // A merge record is immutable history. The estate's credibility rests on nobody
    // being able to rewrite what a merge claimed after the fact, INCLUDING us.
    expect(await noteBlobFor(repo, "R2504")).toBe(before)
  })

  it("does not excuse a record the retraction does not name", async () => {
    const { repo, predecessor, generated, tip } = await linearRepository()
    const poisoned = record("R2504", predecessor, {
      changeId: CHANGE_ID,
      pr: "PR1061",
      revision: 1,
      submittedHead: generated,
      generatedCommit: generated,
    })
    const other = record("R2427", tip, {
      changeId: OTHER_CHANGE_ID,
      pr: "PR1019",
      revision: 1,
      submittedHead: generated,
      generatedCommit: generated,
    })
    await publish(repo, poisoned)
    await publish(repo, other)
    await retract(repo, poisoned, "retracting only R2504")
    await using process = createProcess()

    // R2427 is still unretracted, so the all-or-nothing verdict still refuses.
    // A retraction excuses EXACTLY the bytes it names and nothing adjacent to them.
    await expect(findRepositoryMergeRecords({ inject: { process }, repo, baseSha: tip })).resolves.toMatchObject({
      status: "repository-corrupt",
    })

    const isolated = await findRepositoryMergeRecords({
      inject: { process },
      repo,
      baseSha: tip,
      isolateUnverifiable: true,
    })
    if (isolated.status !== "proven") throw new Error("expected the scan to complete")
    expect(isolated.retracted).toHaveLength(1)
    expect(isolated.unverifiable).toHaveLength(1)
    expect(isolated.unverifiable[0]?.reason).toContain("CHANGE-ID")
  })
})


describe("the estate-repair verb enumerates every producer class, not just the first", () => {
  const NOW = "2026-08-18T04:00:00.000Z"

  /** Both poisoned records, from the two producer classes actually on record. */
  async function poisonedEstate() {
    const fixture = await linearRepository()
    const unreachable = record("R2504", fixture.predecessor, {
      changeId: CHANGE_ID,
      pr: "PR1061",
      revision: 1,
      submittedHead: fixture.generated,
      generatedCommit: fixture.generated,
    })
    const badTrailer = record("R2427", fixture.tip, {
      changeId: OTHER_CHANGE_ID,
      pr: "PR1019",
      revision: 1,
      submittedHead: fixture.generated,
      generatedCommit: fixture.generated,
    })
    await publish(fixture.repo, unreachable)
    await publish(fixture.repo, badTrailer)
    return fixture
  }

  it("plans a retraction for BOTH classes and writes nothing without apply", async () => {
    const { repo, tip } = await poisonedEstate()
    await using process = createProcess()

    const planned = await repairMergeRecordEstate({ inject: { process }, repo, baseSha: tip, now: NOW })

    // First-failure-only would have returned one, and left an estate that still
    // refuses with no sign that more remained.
    expect(planned.planned).toHaveLength(2)
    expect(planned.applied).toEqual([])
    expect(planned.planned.map((entry) => entry.classification).sort()).toEqual([
      "change-id-mismatch",
      "unreachable-generated-commit",
    ])
    expect(planned.planned.map((entry) => entry.merge).sort()).toEqual(["R2427", "R2504"])

    // Read-only means read-only: the estate still refuses.
    await expect(findRepositoryMergeRecords({ inject: { process }, repo, baseSha: tip })).resolves.toMatchObject({
      status: "repository-corrupt",
    })
  })

  it("applies both retractions and the estate answers again", async () => {
    const { repo, tip } = await poisonedEstate()
    await using process = createProcess()

    const repaired = await repairMergeRecordEstate({
      inject: { process },
      repo,
      baseSha: tip,
      now: NOW,
      apply: true,
    })

    expect(repaired.applied).toHaveLength(2)
    // The whole point: a selector query stops refusing. This is what unwedges a
    // pin advance that has been failing on a record nobody can fix.
    const after = await findRepositoryMergeRecords({ inject: { process }, repo, baseSha: tip })
    expect(after).toMatchObject({ status: "proven" })
    if (after.status !== "proven") throw new Error("expected the estate to verify")
    expect(after.retracted).toHaveLength(2)
  })

  it("is idempotent — a second run plans nothing and reports what is already excused", async () => {
    const { repo, tip } = await poisonedEstate()
    await using process = createProcess()
    await repairMergeRecordEstate({ inject: { process }, repo, baseSha: tip, now: NOW, apply: true })

    const again = await repairMergeRecordEstate({ inject: { process }, repo, baseSha: tip, now: NOW, apply: true })

    expect(again.planned).toEqual([])
    expect(again.applied).toEqual([])
    expect(again.alreadyRetracted).toBe(2)
  })

  it("retracts a record too damaged to name itself", async () => {
    const { repo, tip } = await linearRepository()
    // No merge id, no checksum — the record cannot be parsed at all. This is the
    // case that would be unrepairable if a retraction had to name the record's
    // own fields, and it is the case most likely to need repairing.
    const anchor = await git(repo, ["hash-object", "-w", "--stdin"], "yrd merge R-damaged\n")
    const blob = await git(repo, ["hash-object", "-w", "--stdin"], "{ this is not a merge record")
    await git(repo, ["notes", `--ref=${MERGE_RECORD_NOTES_NAME}`, "add", "-C", blob, anchor])
    await using process = createProcess()

    const repaired = await repairMergeRecordEstate({
      inject: { process },
      repo,
      baseSha: tip,
      now: NOW,
      apply: true,
    })

    expect(repaired.applied).toHaveLength(1)
    expect(repaired.planned[0]?.classification).toBe("unreadable")
    expect(repaired.planned[0]?.merge).toBeUndefined()
    await expect(findRepositoryMergeRecords({ inject: { process }, repo, baseSha: tip })).resolves.toMatchObject({
      status: "proven",
    })
  })

  it("reports an empty estate as empty rather than as a repair", async () => {
    const { repo, tip } = await linearRepository()
    await using process = createProcess()

    const repaired = await repairMergeRecordEstate({ inject: { process }, repo, baseSha: tip, now: NOW, apply: true })

    expect(repaired).toMatchObject({ proven: 0, alreadyRetracted: 0, planned: [], applied: [] })
  })
})
