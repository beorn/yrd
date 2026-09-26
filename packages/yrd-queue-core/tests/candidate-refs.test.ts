/**
 * @failure  Merge candidate refs (refs/heads/yrd/candidates/*) stranded on origin outlive
 *           their changes, accumulate into thousands of dark branches (De), and are never
 *           deleted on terminal state or swept (26022).
 * @level    l2 (hermetic git repositories, real remotes, real leased pushes)
 * @consumer queue operator, dark-work watchdog, Yrd queue runner
 * @testonly none
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  candidateRefsFor,
  deleteCandidateRefsForShas,
  sourceCandidateRefFor,
  sweepCandidateRefs,
  SOURCE_CANDIDATE_REF_NAMESPACE,
  CANDIDATE_REF_NAMESPACE,
} from "../src/candidate-refs.ts"
import { gitIn, type Git } from "../src/index.ts"

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

async function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "yrd-candidate-refs-test-"))
  roots.push(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  const seed = gitIn(root)
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])

  const git = gitIn(work)
  await git(["config", "user.email", "queue@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, "init.txt"), "init\n")
  await git(["add", "init.txt"])
  await git(["commit", "--quiet", "-m", "init"])
  await git(["push", "--quiet", "origin", "main"])

  const createCommit = async (msg: string): Promise<string> => {
    writeFileSync(join(work, `${msg}.txt`), `${msg}\n`)
    await git(["add", "."])
    await git(["commit", "--quiet", "-m", msg])
    return (await git(["rev-parse", "HEAD"])).trim()
  }

  return { root, remote, work, git, createCommit }
}

describe("candidate-refs naming", () => {
  it("defines standard candidate ref namespaces and helper formatters", () => {
    expect(SOURCE_CANDIDATE_REF_NAMESPACE).toBe("refs/heads/yrd/candidates")
    expect(CANDIDATE_REF_NAMESPACE).toBe("refs/yrd/candidates")
    const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
    expect(sourceCandidateRefFor(sha)).toBe(`refs/heads/yrd/candidates/${sha}`)
    expect(candidateRefsFor(sha)).toEqual([`refs/heads/yrd/candidates/${sha}`, `refs/yrd/candidates/${sha}`])
  })
})

describe("deleteCandidateRefsForShas", () => {
  it("deletes candidate refs on origin with --force-with-lease", async () => {
    const { work, git, createCommit } = await createFixture()
    const sha1 = await createCommit("c1")
    const sha2 = await createCommit("c2")

    // Push candidate refs to origin
    await git(["push", "--quiet", "origin", `${sha1}:refs/heads/yrd/candidates/${sha1}`])
    await git(["push", "--quiet", "origin", `${sha2}:refs/heads/yrd/candidates/${sha2}`])

    // Verify they exist on origin
    const remoteRefsBefore = await git(["ls-remote", "--refs", "origin", "refs/heads/yrd/candidates/*"])
    expect(remoteRefsBefore).toContain(`refs/heads/yrd/candidates/${sha1}`)
    expect(remoteRefsBefore).toContain(`refs/heads/yrd/candidates/${sha2}`)

    // Delete candidate ref for sha1
    const result = await deleteCandidateRefsForShas(git, work, "origin", [sha1])
    expect(result.deleted).toContain(`refs/heads/yrd/candidates/${sha1}`)

    // Verify sha1 is gone, sha2 remains
    const remoteRefsAfter = await git(["ls-remote", "--refs", "origin", "refs/heads/yrd/candidates/*"])
    expect(remoteRefsAfter).not.toContain(`refs/heads/yrd/candidates/${sha1}`)
    expect(remoteRefsAfter).toContain(`refs/heads/yrd/candidates/${sha2}`)
  })
})

describe("sweepCandidateRefs", () => {
  it("identifies reclaimable refs on dry run without deleting them", async () => {
    const { work, git, createCommit } = await createFixture()
    const sha1 = await createCommit("c1")
    const sha2 = await createCommit("c2")

    await git(["push", "--quiet", "origin", `${sha1}:refs/heads/yrd/candidates/${sha1}`])
    await git(["push", "--quiet", "origin", `${sha2}:refs/heads/yrd/candidates/${sha2}`])

    const sweepResult = await sweepCandidateRefs(git, {
      repo: work,
      remote: "origin",
      dryRun: true,
    })

    expect(sweepResult.scanned).toBe(2)
    expect(sweepResult.reclaimable).toBe(2)
    expect(sweepResult.deleted).toHaveLength(0)

    // Verify refs still exist on remote
    const remoteRefs = await git(["ls-remote", "--refs", "origin", "refs/heads/yrd/candidates/*"])
    expect(remoteRefs).toContain(`refs/heads/yrd/candidates/${sha1}`)
    expect(remoteRefs).toContain(`refs/heads/yrd/candidates/${sha2}`)
  })

  it("deletes reclaimable refs with pinned lease in batches", async () => {
    const { work, git, createCommit } = await createFixture()
    const sha1 = await createCommit("c1")
    const sha2 = await createCommit("c2")
    const sha3 = await createCommit("c3")

    await git(["push", "--quiet", "origin", `${sha1}:refs/heads/yrd/candidates/${sha1}`])
    await git(["push", "--quiet", "origin", `${sha2}:refs/heads/yrd/candidates/${sha2}`])
    await git(["push", "--quiet", "origin", `${sha3}:refs/heads/yrd/candidates/${sha3}`])

    const sweepResult = await sweepCandidateRefs(git, {
      repo: work,
      remote: "origin",
      dryRun: false,
      batchSize: 2, // test chunking
    })

    expect(sweepResult.scanned).toBe(3)
    expect(sweepResult.reclaimable).toBe(3)
    expect(sweepResult.deleted).toHaveLength(3)

    // Remote refs should be completely gone
    const remoteRefs = await git(["ls-remote", "--refs", "origin", "refs/heads/yrd/candidates/*"])
    expect(remoteRefs.trim()).toBe("")
  })

  it("preserves candidate refs that are currently active in the queue", async () => {
    const { work, git, createCommit } = await createFixture()
    const activeSha = await createCommit("active")
    const idleSha = await createCommit("idle")

    await git(["push", "--quiet", "origin", `${activeSha}:refs/heads/yrd/candidates/${activeSha}`])
    await git(["push", "--quiet", "origin", `${idleSha}:refs/heads/yrd/candidates/${idleSha}`])

    const sweepResult = await sweepCandidateRefs(git, {
      repo: work,
      remote: "origin",
      dryRun: false,
      activeShas: new Set([activeSha]),
    })

    expect(sweepResult.scanned).toBe(2)
    expect(sweepResult.live).toBe(1)
    expect(sweepResult.reclaimable).toBe(1)
    expect(sweepResult.deleted).toEqual([`refs/heads/yrd/candidates/${idleSha}`])

    // Verify active ref survived on origin
    const remoteRefs = await git(["ls-remote", "--refs", "origin", "refs/heads/yrd/candidates/*"])
    expect(remoteRefs).toContain(`refs/heads/yrd/candidates/${activeSha}`)
    expect(remoteRefs).not.toContain(`refs/heads/yrd/candidates/${idleSha}`)
  })
})
