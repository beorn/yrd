/**
 * @failure A merge-record refusal names the Change-Id — the half that VERIFIES whenever reachability
 * is what broke — so every reader is steered at the wrong cause; and the writer can mint the
 * contradiction in the first place, recording generated commits for a landing that joined nothing to
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
  findRepositoryMergeRecords,
  MERGE_RECORD_NOTES_NAME,
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
 * Three commits in a line. `predecessor` stands in for the PREVIOUS landing's merge
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
  await git(repo, ["commit", "-qm", "later landing"])
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
  it("reports the contradiction when a no-op landing claims generated commits", () => {
    const poisoned = record("R2504", "c".repeat(40), {
      changeId: CHANGE_ID,
      pr: "PR1061",
      revision: 1,
      submittedHead: "9".repeat(40),
      generatedCommit: "9".repeat(40),
    })

    const claim = unprovableMergeRecordClaim(poisoned)

    expect(claim).toBeDefined()
    expect(claim).toContain("joined nothing to landed history")
    expect(claim).toContain("PR1061")
  })

  it("passes a no-op landing that honestly claims no generated commits", () => {
    const honest = record("R2504", "c".repeat(40), {
      changeId: CHANGE_ID,
      pr: "PR1061",
      revision: 1,
      submittedHead: "9".repeat(40),
    })

    expect(unprovableMergeRecordClaim(honest)).toBeUndefined()
  })

  it("passes a real landing that moved the base and claims its generated commit", () => {
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
