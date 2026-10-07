/**
 * @failure A public submit alias rewrites its caller, opens a change on dry run,
 *          or publishes the branch without its event chain.
 * @level l3
 * @consumer `yrd submit` and `yrd queue submit`
 */
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { changesRef } from "../../packages/yrd-queue-core/src/index.ts"
import {
  addYrdRemote,
  boundaryRepository,
  commitOnBranch,
  git,
  queueSubmit,
  refExists,
  refs,
  refSha,
  remoteNames,
  removeTemporaryRoots,
  runYrd,
  secondWorkingRepo,
} from "./fixture.ts"

afterEach(removeTemporaryRoots)

describe("the submit path", { timeout: 120_000 }, () => {
  // 26183: public submit cases run against the event queue after the 25041 strict-reader cutover.
  // The core stale-compose test does not prove that both public submit aliases
  // accept a moved target while leaving the author's branch and FETCH_HEAD alone.
  it.each([
    { label: "submit", argv: ["submit"] },
    { label: "queue submit", argv: ["queue", "submit"] },
  ])("$label previews and submits a stale but composable branch without rewriting it", async ({ argv }) => {
    const { repo, origin } = await boundaryRepository({ exit: 0 })
    const branch = "24099-stale"
    const head = await commitOnBranch(repo, branch)
    const peer = await secondWorkingRepo(origin, "other", "other@example.invalid")
    await git(peer, "checkout", "-q", "main")
    await git(peer, "commit", "--allow-empty", "-qm", "target moved")
    await git(peer, "push", "-q", "origin", "main")
    const target = await refSha(origin, "refs/heads/main")
    const fetchHead = join(repo, ".git", "FETCH_HEAD")
    await writeFile(fetchHead, "the caller's previous fetch\n")
    // The only local ref writes allowed are Gitomic's private fetch cache and the preview's own custody anchor
    // (27510): refs/yrd/preview/<clone>/<subject>/<candidate-root>, at the candidate its receipt names.
    const callerRefs = async () =>
      (await git(repo, "for-each-ref", "--format=%(refname) %(objectname)"))
        .split("\n")
        .filter((line) => line !== "" && !line.startsWith("refs/gitomic/") && !line.startsWith("refs/yrd/preview/"))
        .join("\n")
    const previewAnchors = async () =>
      (await git(repo, "for-each-ref", "--format=%(refname) %(objectname)", "refs/yrd/preview/"))
        .split("\n")
        .filter((line) => line !== "")
    const beforeLocal = await callerRefs()
    expect(await previewAnchors()).toEqual([])
    const beforeRemote = await git(origin, "for-each-ref", "--format=%(refname) %(objectname)")

    const preview = await runYrd(repo, ...argv, branch, "--dry-run", "--json")
    expect(preview.exitCode, preview.report).toBe(0)
    expect(JSON.parse(preview.stdout)).toMatchObject({
      dryRun: true,
      targetHead: target,
      verifying: { state: "verified", head, targetHead: target },
    })
    expect(await callerRefs()).toBe(beforeLocal)
    const candidate = (JSON.parse(preview.stdout) as { verifying: { candidate: string } }).verifying.candidate
    expect(await previewAnchors()).toEqual([
      expect.stringMatching(new RegExp(`^refs/yrd/preview/[0-9a-f]{64}/${branch}/${candidate} ${candidate}$`, "u")),
    ])
    expect(await git(origin, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(beforeRemote)
    expect(await readFile(fetchHead, "utf8")).toBe("the caller's previous fetch\n")

    const opened = await runYrd(repo, ...argv, branch, "--json")
    expect(opened.exitCode, opened.report).toBe(0)
    expect(JSON.parse(opened.stdout)).toMatchObject({ branch, head, targetHead: target })
    expect(await refSha(repo, `refs/heads/${branch}`)).toBe(head)
    expect(await refSha(origin, `refs/heads/${branch}`)).toBe(head)
    expect(await refExists(origin, changesRef("main", branch))).toBe(true)
    expect(await readFile(fetchHead, "utf8")).toBe("the caller's previous fetch\n")
  })

  // A removed public flag must be rejected by both aliases before any write.
  it.each([
    { label: "submit", argv: ["submit"] },
    { label: "queue submit", argv: ["queue", "submit"] },
  ])("$label rejects the retired --rebase flag without changing refs", async ({ argv }) => {
    const { repo, origin } = await boundaryRepository({ exit: 0 })
    const branch = "24099-retired-rebase"
    await commitOnBranch(repo, branch)
    const beforeLocal = await git(repo, "for-each-ref", "--format=%(refname) %(objectname)")
    const beforeRemote = await refs(origin)
    const refused = await runYrd(repo, ...argv, branch, "--rebase", "--dry-run", "--json")
    expect(refused.exitCode, refused.report).not.toBe(0)
    expect(refused.report).toContain("unknown option '--rebase'")
    expect(await git(repo, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(beforeLocal)
    expect(await refs(origin)).toEqual(beforeRemote)
  })

  it("one push puts the branch and its opened event at the queue remote", async () => {
    const { repo, origin } = await boundaryRepository({ exit: 0 })
    await addYrdRemote(repo, origin)
    const branch = "24099-widget"
    const head = await commitOnBranch(repo, branch)

    const submit = await queueSubmit(repo, branch)

    expect(submit.exitCode, submit.report).toBe(0)
    // Both, or neither: the queue needs the branch and its event chain.
    expect(await refSha(origin, `refs/heads/${branch}`), submit.report).toBe(head)
    expect(await refExists(origin, changesRef("main", branch)), submit.report).toBe(true)
  })

  /**
   * Measured 2026-09-03 on the wrapper: `yrd submit --dry-run` was accepted by
   * the wrapper's own option table, the new core's submit never received it,
   * and the dry run opened a real change. An option a command does not implement must refuse; an
   * option it does implement must reach the code that acts on it.
   */
  it("a dry run of the target refuses like the submit, and puts nothing at the remote", async () => {
    const { repo, origin } = await boundaryRepository({ exit: 0 })
    await addYrdRemote(repo, origin)
    const before = await refs(origin)

    const dry = await runYrd(repo, "queue", "submit", "main", "--dry-run")

    expect(dry.exitCode, dry.report).not.toBe(0)
    expect(dry.report).toContain("main is the target, not a change")
    expect(await refs(origin), dry.report).toEqual(before)
  })

  it("a dry run says what it would open and puts nothing at the remote", async () => {
    const { repo, origin } = await boundaryRepository({ exit: 0 })
    await addYrdRemote(repo, origin)
    const branch = "24099-dry"
    const head = await commitOnBranch(repo, branch)
    const before = await refs(origin)

    const dry = await runYrd(repo, "queue", "submit", branch, "--dry-run", "--json")

    expect(dry.exitCode, dry.report).toBe(0)
    expect(JSON.parse(dry.stdout), dry.report).toMatchObject({
      change: `${branch}@${head}`,
      dryRun: true,
      target: "origin#main",
      issue: "24099",
    })
    // The whole point: the remote is byte-for-byte where it was.
    expect(await refs(origin), dry.report).toEqual(before)
    expect(await refExists(origin, `refs/heads/${branch}`), dry.report).toBe(false)
    expect(await refExists(origin, changesRef("main", branch)), dry.report).toBe(false)
    // Nor locally: a dry run appends no event for the next submit to chain onto.
    expect(await refExists(repo, changesRef("main", branch)), dry.report).toBe(false)
  })

  it("uses origin as the repository and does not add a declaration-selected remote", async () => {
    const { repo, origin } = await boundaryRepository({ exit: 0 })
    expect(await remoteNames(repo)).not.toContain("yrd")
    const branch = "24099-remote"
    const head = await commitOnBranch(repo, branch)

    const submit = await queueSubmit(repo, branch)

    expect(submit.exitCode, submit.report).toBe(0)
    expect(await remoteNames(repo), submit.report).toEqual(["origin"])
    expect(await refSha(origin, `refs/heads/${branch}`), submit.report).toBe(head)
  })
})
