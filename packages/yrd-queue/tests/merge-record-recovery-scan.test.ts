/**
 * @failure The bulk merge-record scan — the one `yrd doctor --rebuild-index-from-repo` runs to
 * rebuild a lost index — fails hardest in exactly the damaged estate it exists for: a component
 * checkout the working tree never materialized crashes the process with ENOENT out of `posix_spawn`
 * (`git -C <dir>` is also given `cwd: <dir>`, so the tolerant probe never sees an exit code), and a
 * single unverifiable record ends the whole scan instead of being reported and skipped.
 * @level l2
 * @consumer yrd doctor --rebuild-index-from-repo
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

/** The estate a recovery scan actually meets: a superproject whose base tree pins a component that
 * this checkout never materialized on disk. Git builds the tree from the index, so the gitlink is
 * real repository truth while `<repo>/dep` does not exist — the same shape a `--no-checkout` clone,
 * a partially materialized habitat, or a working tree older than the commit that introduced the
 * component presents to the scan. */
async function unmaterializedComponentRepository(): Promise<
  Readonly<{ repo: string; baseSha: string; moduleA: string; moduleB: string }>
> {
  const root = await mkdtemp(join(tmpdir(), "yrd-recovery-scan-"))
  roots.push(root)
  const module = join(root, "module")
  const repo = join(root, "repo")
  await Bun.$`git init -q -b main ${module}`.quiet()
  await git(module, ["config", "user.email", "yrd@example.invalid"])
  await git(module, ["config", "user.name", "Yrd Test"])
  await writeFile(join(module, "version.txt"), "a\n")
  await git(module, ["add", "version.txt"])
  await git(module, ["commit", "-qm", "module a"])
  const moduleA = await git(module, ["rev-parse", "HEAD"])
  await writeFile(join(module, "version.txt"), "b\n")
  await git(module, ["commit", "-qam", "module b"])
  const moduleB = await git(module, ["rev-parse", "HEAD"])

  await Bun.$`git init -q -b main ${repo}`.quiet()
  await git(repo, ["config", "user.email", "yrd@example.invalid"])
  await git(repo, ["config", "user.name", "Yrd Test"])
  await writeFile(join(repo, "root.txt"), "root\n")
  await git(repo, ["add", "root.txt"])
  await git(repo, ["update-index", "--add", `--cacheinfo`, `160000,${moduleB},dep`])
  await git(repo, ["commit", "-qm", "root pins dep at b"])
  const baseSha = await git(repo, ["rev-parse", "HEAD"])
  return { repo, baseSha, moduleA, moduleB }
}

function mergedRecord(
  id: string,
  member: string,
  mergedCommit: string,
  pins: MergeRecordBody["pins"] = [],
): MergeRecordBody {
  return {
    merge: {
      id,
      base: "main",
      baseSha: mergedCommit,
      candidate: `candidate:${id}`,
      result: "merged",
      mergedCommit,
      startedAt: "2026-08-14T20:00:00.000Z",
      finishedAt: "2026-08-14T20:01:00.000Z",
    },
    changes: [{ pr: member, revision: 1, submittedHead: mergedCommit }],
    evidence: { jobs: [] },
    pins,
  }
}

/** Publish exactly the way `recordMerge` does: the note hangs off the attempt anchor blob. */
async function publish(repo: string, record: MergeRecordBody): Promise<void> {
  const anchor = await git(repo, ["hash-object", "-w", "--stdin"], `yrd merge ${record.merge.id}\n`)
  const blob = await git(repo, ["hash-object", "-w", "--stdin"], createMergeRecord(record).canonical)
  await git(repo, ["notes", `--ref=${MERGE_RECORD_NOTES_NAME}`, "add", "-C", blob, anchor])
}

/** A note that is not a merge record at all — the shape a truncated write, a partial fetch or a
 * hand-edited note leaves behind. */
async function publishPoisoned(repo: string, id: string): Promise<void> {
  const anchor = await git(repo, ["hash-object", "-w", "--stdin"], `yrd merge ${id}\n`)
  const blob = await git(repo, ["hash-object", "-w", "--stdin"], "{ this is not a merge record")
  await git(repo, ["notes", `--ref=${MERGE_RECORD_NOTES_NAME}`, "add", "-C", blob, anchor])
}

describe("bulk merge-record scan over a damaged estate", () => {
  it("reports a component checkout it cannot inspect instead of crashing on spawn", async () => {
    const { repo, baseSha, moduleA } = await unmaterializedComponentRepository()
    // The pin the record authored differs from the one the base carries, so the scan must ask the
    // component for ancestry — and `<repo>/dep` does not exist.
    await publish(
      repo,
      mergedRecord("R-unmaterialized", "PR1", baseSha, [{ path: "dep", before: null, after: moduleA }]),
    )
    await using process = createProcess()

    await expect(findRepositoryMergeRecords({ inject: { process }, repo, baseSha })).resolves.toMatchObject({
      status: "repository-incomplete",
      reason: expect.stringContaining("cannot inspect component checkout 'dep'"),
    })

    // The recovery scan meets this estate more often than any other caller, and it reports the one
    // record rather than losing the scan.
    const isolated = await findRepositoryMergeRecords({ inject: { process }, repo, baseSha, isolateUnverifiable: true })
    expect(isolated).toMatchObject({
      status: "proven",
      records: [],
      unverifiable: [
        {
          status: "repository-incomplete",
          reason: expect.stringContaining("cannot inspect component checkout 'dep'"),
        },
      ],
    })
  })

  it("reports one unverifiable record and finishes the scan over the rest", async () => {
    const { repo, baseSha } = await unmaterializedComponentRepository()
    await publish(repo, mergedRecord("R-good", "PR1", baseSha))
    await publishPoisoned(repo, "R-poisoned")
    await using process = createProcess()

    const isolated = await findRepositoryMergeRecords({
      inject: { process },
      repo,
      baseSha,
      isolateUnverifiable: true,
    })

    expect(isolated).toMatchObject({
      status: "proven",
      records: [{ record: { merge: { id: "R-good" } } }],
    })
    if (isolated.status !== "proven") throw new Error("expected the scan to complete")
    expect(isolated.unverifiable).toHaveLength(1)
    expect(isolated.unverifiable[0]?.reason).toContain("is invalid")
  })

  it("keeps the all-or-nothing verdict for the single-selector read", async () => {
    const { repo, baseSha } = await unmaterializedComponentRepository()
    await publish(repo, mergedRecord("R-good", "PR1", baseSha))
    await publishPoisoned(repo, "R-poisoned")
    await using process = createProcess()

    // `yrd why <selector>` answers one question and must not answer it from a partially verified
    // estate; only the bulk recovery scan trades the whole-scan verdict for per-record isolation.
    await expect(findRepositoryMergeRecords({ inject: { process }, repo, baseSha })).resolves.toMatchObject({
      status: "repository-corrupt",
    })
  })
})
