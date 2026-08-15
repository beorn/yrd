/**
 * @failure `REPOSITORY-CORRUPT` is the loudest word `yrd why` owns, and intent carriers are the
 * majority of what it answers about — 263 of the 422 carrier changes under the live merge-record
 * ref are intents, 159 are PRs (read 2026-08-15). Nothing about a landed pin intent is
 * unprovable today: an intent authors a gitlink bump, so its record carries no `changeId` and the
 * verifier proves it by pin containment alone. These pin that, so the word cannot start firing on
 * the healthy majority — and pin the operator-visible cost that remains, which is a refusal
 * naming a record the operator did not ask about.
 * @level l2
 * @consumer yrd why <selector>
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createProcess } from "@yrd/process"
import { createMergeRecord, findRepositoryMergeRecords, MERGE_RECORD_NOTES_NAME } from "@yrd/queue"
import type { MergeRecordBody } from "@yrd/queue"

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

/** A superproject whose component IS materialized — the estate a pin landing verifies against.
 * The base pins `dep` at its third commit, so a record that advanced the pin to the second one
 * still has to be proven by asking the component for ancestry. */
async function pinnedComponentRepository(): Promise<
  Readonly<{ repo: string; baseSha: string; moduleA: string; moduleB: string; moduleC: string }>
> {
  const root = await mkdtemp(join(tmpdir(), "yrd-why-intent-"))
  roots.push(root)
  const module = join(root, "module")
  const repo = join(root, "repo")
  await Bun.$`git init -q -b main ${module}`.quiet()
  await git(module, ["config", "user.email", "yrd@example.invalid"])
  await git(module, ["config", "user.name", "Yrd Test"])
  const commit = async (content: string, message: string): Promise<string> => {
    await writeFile(join(module, "version.txt"), content)
    await git(module, ["add", "version.txt"])
    await git(module, ["commit", "-qm", message])
    return git(module, ["rev-parse", "HEAD"])
  }
  const moduleA = await commit("a\n", "module a")
  const moduleB = await commit("b\n", "module b")
  const moduleC = await commit("c\n", "module c")

  await Bun.$`git init -q -b main ${repo}`.quiet()
  await git(repo, ["config", "user.email", "yrd@example.invalid"])
  await git(repo, ["config", "user.name", "Yrd Test"])
  await writeFile(join(repo, "root.txt"), "root\n")
  await git(repo, ["add", "root.txt"])
  await git(repo, ["update-index", "--add", "--cacheinfo", `160000,${moduleC},dep`])
  // No Change-Id trailer: this is the commit an unprovable PR record points at.
  await git(repo, ["commit", "-qm", "root pins dep at c"])
  const baseSha = await git(repo, ["rev-parse", "HEAD"])
  await Bun.$`git clone -q ${module} ${join(repo, "dep")}`.quiet()
  return { repo, baseSha, moduleA, moduleB, moduleC }
}

/** The shape the live ref actually holds for a landed pin intent: the carrier id sits in
 * `changes[].pr`, and the record carries NO `changeId` and NO `generatedCommit` — an intent
 * authors a gitlink bump, not a Change-Id-trailered commit. Transcribed from `yrdpin#254`
 * (merge R2399) and `yrdpin#271` (merge R2434) under the live ref; only the git shas are
 * remapped onto this fixture's repository. */
function landedIntent(
  id: string,
  member: string,
  mergedCommit: string,
  pins: MergeRecordBody["pins"],
): MergeRecordBody {
  return {
    merge: {
      id,
      base: "main",
      baseSha: mergedCommit,
      candidate: `C${id}`,
      result: "merged",
      mergedCommit,
      startedAt: "2026-08-15T00:48:43.301Z",
      finishedAt: "2026-08-15T00:49:32.549Z",
    },
    changes: [{ pr: member, revision: 1, submittedHead: mergedCommit }],
    evidence: { jobs: [] },
    pins,
  }
}

/** The shape of a PR carrier the repository cannot prove: the record claims a Change-Id its own
 * generated commit does not carry. Transcribed from `PR1019` (merge R2427, note
 * 3ad2f96c80796f52078e6eb64f775d2430f4a856), the one record under the live ref that fails. */
function unprovablePullRequest(mergedCommit: string, generatedCommit: string): MergeRecordBody {
  return {
    merge: {
      id: "R2427",
      base: "main",
      baseSha: mergedCommit,
      candidate: "C2828",
      result: "merged",
      mergedCommit,
      startedAt: "2026-08-15T05:35:31.483Z",
      finishedAt: "2026-08-15T05:35:58.595Z",
    },
    changes: [
      {
        changeId: "I95efe0e96edfb358ddcbbc761138e16e399f9db5",
        generatedCommit,
        pr: "PR1019",
        revision: 2,
        submittedHead: generatedCommit,
      },
    ],
    evidence: { jobs: [] },
    pins: [],
  }
}

/** Publish exactly the way `recordMerge` does: the note hangs off the attempt anchor blob. */
async function publish(repo: string, record: MergeRecordBody): Promise<void> {
  const anchor = await git(repo, ["hash-object", "-w", "--stdin"], `yrd merge ${record.merge.id}\n`)
  const blob = await git(repo, ["hash-object", "-w", "--stdin"], createMergeRecord(record).canonical)
  await git(repo, ["notes", `--ref=${MERGE_RECORD_NOTES_NAME}`, "add", "-C", blob, anchor])
}

describe("yrd why over intent carriers", () => {
  it("proves a landed pin intent instead of calling the repository corrupt", async () => {
    const { repo, baseSha, moduleA, moduleB, moduleC } = await pinnedComponentRepository()
    // `yrdpin#254`: the pin advanced, so ancestry has to be proven against the component checkout.
    await publish(
      repo,
      landedIntent("R2399", "yrdpin#254", baseSha, [{ path: "dep", before: moduleA, after: moduleB }]),
    )
    // `yrdpin#271`: the pin the record authored is the one the base already carries.
    await publish(
      repo,
      landedIntent("R2434", "yrdpin#271", baseSha, [{ path: "dep", before: moduleC, after: moduleC }]),
    )
    await using process = createProcess()

    for (const selector of ["yrdpin#254", "yrdpin#271"]) {
      const proof = await findRepositoryMergeRecords({ inject: { process }, repo, baseSha, selector })
      expect(proof, `${selector} landed cleanly and must not be reported as corruption`).toMatchObject({
        status: "proven",
      })
      if (proof.status !== "proven") throw new Error("expected the intent landing to be proven")
      expect(proof.records).toHaveLength(1)
    }
  })

  it("keeps REPOSITORY-CORRUPT for a landing the repository genuinely cannot prove", async () => {
    const { repo, baseSha } = await pinnedComponentRepository()
    await publish(repo, unprovablePullRequest(baseSha, baseSha))
    await using process = createProcess()

    await expect(
      findRepositoryMergeRecords({ inject: { process }, repo, baseSha, selector: "PR1019" }),
    ).resolves.toMatchObject({
      status: "repository-corrupt",
      reason: expect.stringContaining("cannot prove I95efe0e96edfb358ddcbbc761138e16e399f9db5"),
    })
  })

  it("still refuses the whole estate when an unrelated record is unprovable", async () => {
    const { repo, baseSha, moduleC } = await pinnedComponentRepository()
    await publish(
      repo,
      landedIntent("R2434", "yrdpin#271", baseSha, [{ path: "dep", before: moduleC, after: moduleC }]),
    )
    await publish(repo, unprovablePullRequest(baseSha, baseSha))
    await using process = createProcess()

    // The all-or-nothing single-selector verdict is deliberate (doctor-rebuild-hardening): one
    // question answered from a partially verified estate is answered from unproven truth. The
    // intent selector is healthy and the answer is still a refusal — about someone else's record.
    await expect(
      findRepositoryMergeRecords({ inject: { process }, repo, baseSha, selector: "yrdpin#271" }),
    ).resolves.toMatchObject({
      status: "repository-corrupt",
      reason: expect.stringContaining("cannot prove I95efe0e96edfb358ddcbbc761138e16e399f9db5"),
    })
  })
})
