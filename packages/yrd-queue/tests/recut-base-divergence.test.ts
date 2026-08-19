/**
 * @failure Every recut-certificate cause is refused under one code, so a deterministically stale certified base — which no retry can cure — is indistinguishable from an unfetched base object, which a retry cures. Sharing the code means the queue must treat both as retryable and storms the head (PR1986 r34: 3 refusals in 2m51s) or must park both and freezes a partition-recoverable PR (2026-07-27: 106 refusals over 1h44m).
 * @level l2
 * @consumer @yrd/queue candidate preparer
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { failureFact } from "@yrd/core"
import { createProcess } from "@yrd/process"
import { gitCandidatePreparer, type CandidatePreparationInput } from "@yrd/queue"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(repo: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

/**
 * The live shape a recut carrier reaches the certificate check in: `head` is a
 * proper descendant of the authoritative base (so it neither drops landed work
 * nor is already contained), and `diverged` sits on a lineage the authoritative
 * base never took — the certified base a queued revision keeps pointing at
 * after main moves along a different history.
 */
async function carrierRepository(): Promise<{
  repo: string
  base: string
  head: string
  headTree: string
  diverged: string
}> {
  const root = await mkdtemp(join(tmpdir(), "yrd-recut-base-divergence-"))
  roots.push(root)
  const repo = join(root, "repo")
  await Bun.$`git init -q -b main ${repo}`
  await git(repo, ["config", "user.name", "Yrd Test"])
  await git(repo, ["config", "user.email", "yrd@example.invalid"])
  await writeFile(join(repo, "README.md"), "root\n")
  await git(repo, ["add", "README.md"])
  await git(repo, ["commit", "-qm", "root"])
  const root0 = await git(repo, ["rev-parse", "HEAD"])

  await git(repo, ["switch", "-q", "-c", "abandoned", root0])
  await writeFile(join(repo, "abandoned.txt"), "a lineage main never took\n")
  await git(repo, ["add", "abandoned.txt"])
  await git(repo, ["commit", "-qm", "abandoned base"])
  const diverged = await git(repo, ["rev-parse", "HEAD"])

  await git(repo, ["switch", "-q", "main"])
  await writeFile(join(repo, "landed.txt"), "landed on main\n")
  await git(repo, ["add", "landed.txt"])
  await git(repo, ["commit", "-qm", "land work on main"])
  const base = await git(repo, ["rev-parse", "HEAD"])

  await git(repo, ["switch", "-q", "-c", "issue/feature", base])
  await writeFile(join(repo, "feature.txt"), "feature\n")
  await git(repo, ["add", "feature.txt"])
  await git(repo, ["commit", "-qm", "feature"])
  const head = await git(repo, ["rev-parse", "HEAD"])
  const headTree = await git(repo, ["rev-parse", "HEAD^{tree}"])
  await git(repo, ["switch", "-q", "main"])
  return { repo, base, head, headTree, diverged }
}

function preparation(
  base: string,
  head: string,
  certified: Readonly<{ baseSha: string; treeSha: string; patchId: string }>,
): CandidatePreparationInput {
  const remerge = { ...certified, fromRevision: 33, reviewCarried: true }
  return {
    id: "C1",
    queueId: "refs/heads/main",
    baseSha: base,
    revs: [{ pr: "PR1986", n: 34, head }],
    prs: [
      {
        id: "PR1986",
        changeId: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
        branch: "issue/feature",
        base: "main",
        revision: 34,
        headSha: head,
        baseSha: base,
        recut: remerge,
      },
    ],
  }
}

async function refusalOf(repo: string, input: CandidatePreparationInput): Promise<{ code: string; message: string }> {
  await using process = createProcess({ cwd: repo })
  const prepare = gitCandidatePreparer({ inject: { process }, repo })
  const error = await Promise.resolve(prepare(input)).then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  const fact = failureFact(error)
  if (fact === undefined) throw new Error(`expected a typed refusal, got ${String(error)}`)
  return { code: fact.code, message: fact.message }
}

describe("recut base divergence — a stale certified base is discriminated from an absent one", () => {
  it("refuses a certified base that is not an ancestor of the authoritative base as deterministically diverged", async () => {
    const { repo, base, head, headTree, diverged } = await carrierRepository()

    const refusal = await refusalOf(
      repo,
      preparation(base, head, { baseSha: diverged, treeSha: headTree, patchId: "0".repeat(40) }),
    )

    expect(refusal.code).toBe("recut-base-diverged")
    // The receipt has to name both sides: the operator's next act is producing a
    // revision at the authoritative base, and they cannot check that without it.
    expect(refusal.message).toContain(diverged)
    expect(refusal.message).toContain(base)
  })

  it("keeps an absent certified base object on the ordinary retryable certificate code", async () => {
    const { repo, base, head, headTree } = await carrierRepository()
    // A well-formed sha with no object behind it: the shape a lazy-fetch failure
    // or an unfetched remote leaves behind, and the shape a later fetch cures.
    const unfetched = "c".repeat(40)

    const refusal = await refusalOf(
      repo,
      preparation(base, head, { baseSha: unfetched, treeSha: headTree, patchId: "0".repeat(40) }),
    )

    expect(refusal.code).toBe("recut-certificate")
    expect(refusal.message).toContain(unfetched)
  })
})
