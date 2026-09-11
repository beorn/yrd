/**
 * Settling at submit and merge: git-super raises every held-back gitlink to its
 * submodule's newest main. An authored gitlink main does not carry waits without
 * ending the change or blocking the next entry; an object no remote can supply
 * is the submitter's failed change, never a queue-owned stuck.
 *
 * Measured 2026-09-02 on the old core: a root gitlink pointed at a branch
 * commit forked on the gitlink, and every later change was judged against a
 * submodule state no main had ever carried. Measured the same day on this
 * core before E4: asking every submodule of the root's tree cost 15 fetches
 * and 13.7 s per judged change.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { createProcess } from "@yrd/process"
import type { Process } from "@yrd/process"
import {
  appendRecord,
  changeRef,
  checksOf,
  gitIn,
  journalKey,
  list,
  queueRun,
  readJournals,
  readQueue,
  readRecords,
  submit,
  trailer,
  watchRows,
} from "../src/index.ts"
import type { Git, QueueRunOptions } from "../src/index.ts"

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

type World = Readonly<{
  git: Git
  work: string
  /** A commit the submodule's main carries (behind its tip). */
  onMain: string
  /** A commit on a branch of the submodule that its main does not carry. */
  offMain: string
  /** The newest commit on the submodule's main when the fixture was made. */
  main: string
  options(check?: Readonly<{ run: string; on: readonly ("submit" | "merge")[] }>): Promise<QueueRunOptions>
}>

/**
 * A submodule whose main is `one` then `three`, with a branch `feature` at
 * `two` off `one`; a root whose main records the submodule at `three`.
 */
async function world(): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), "yrd-core-gitlink-"))
  roots.push(root)
  // A submodule at a local path: git refuses file transport for submodule
  // clones unless every git in the chain is told. Every git runner below and
  // the queue's own git children read this process's environment when they
  // are made, so it is said here, first.
  process.env.GIT_CONFIG_COUNT = "3"
  // Ownership uses hosted identities; Git itself routes fixture transport locally,
  // including child checkouts created later by the real queue materializer.
  process.env.GIT_CONFIG_KEY_1 = `url.${join(root, "submodule.git")}.insteadOf`
  process.env.GIT_CONFIG_VALUE_1 = "https://git-super.test/owned/submodule.git"
  process.env.GIT_CONFIG_KEY_2 = `url.${join(root, "remote.git")}.insteadOf`
  process.env.GIT_CONFIG_VALUE_2 = "https://git-super.test/owned/root.git"
  process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow"
  process.env.GIT_CONFIG_VALUE_0 = "always"
  const seed = gitIn(root)
  const identity = async (git: Git): Promise<void> => {
    await git(["config", "user.email", "queue@yrd.test"])
    await git(["config", "user.name", "yrd"])
  }

  const submodule = join(root, "submodule.git")
  const submoduleWork = join(root, "submodule-work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", submodule])
  await seed(["clone", "--quiet", submodule, submoduleWork])
  const cg = gitIn(submoduleWork)
  await identity(cg)
  await cg(["remote", "set-url", "origin", "https://git-super.test/owned/submodule.git"])
  await cg(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(submoduleWork, "lib.txt"), "one\n")
  await cg(["add", "lib.txt"])
  await cg(["commit", "--quiet", "-m", "one"])
  const onMain = (await cg(["rev-parse", "HEAD"])).trim()
  await cg(["checkout", "--quiet", "-b", "feature"])
  writeFileSync(join(submoduleWork, "lib.txt"), "two\n")
  await cg(["commit", "--quiet", "-am", "two, not on main"])
  const offMain = (await cg(["rev-parse", "HEAD"])).trim()
  await cg(["checkout", "--quiet", "main"])
  writeFileSync(join(submoduleWork, "lib.txt"), "three\n")
  await cg(["commit", "--quiet", "-am", "three"])
  const main = (await cg(["rev-parse", "HEAD"])).trim()
  await cg(["push", "--quiet", "origin", "main", "feature"])

  const remote = join(root, "remote.git")
  const work = join(root, "work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await identity(git)
  await git(["remote", "set-url", "origin", "https://git-super.test/owned/root.git"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, ".yrd.yml"), "{}\n")
  await git(["submodule", "add", "--quiet", "https://git-super.test/owned/submodule.git", "submodule"])
  await git(["add", ".yrd.yml", ".gitmodules", "submodule"])
  await git(["commit", "--quiet", "-m", "base, with the submodule at its main"])
  await git(["push", "--quiet", "origin", "main"])
  const workdir = join(root, "queue")
  mkdirSync(workdir, { recursive: true })
  return {
    git,
    main,
    offMain,
    onMain,
    options: async (check) => {
      return {
        checks: check === undefined ? [] : [{ name: "submodule-check", on: check.on, run: check.run }],
        configBlob: "test-config",
        env: process.env,
        repo: work,
        target: { branch: "main", remote: "origin" },
        targetSha: await remoteTip(git, "refs/heads/main"),
        workdir,
      }
    },
    work,
  }
}

/** A change that moves the submodule's gitlink to `sha`, submitted. */
async function submitGitlink(w: World, branch: string, sha: string): Promise<string> {
  await w.git(["checkout", "--quiet", "-b", branch, "main"])
  const sub = gitIn(join(w.work, "submodule"))
  await sub(["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"])
  await sub(["checkout", "--quiet", sha])
  await w.git(["add", "submodule"])
  // The branch is in the message, so two branches recording the same commit in
  // the same second are two heads, not one head under two names.
  await w.git(["commit", "--quiet", "-m", `${branch}: move the submodule gitlink to ${sha.slice(0, 12)}`])
  const head = (await w.git(["rev-parse", "HEAD"])).trim()
  await w.git(["checkout", "--quiet", "main"])
  await submit(w.git, "origin", { branch, submitter: "@dev/2", target: { branch: "main", remote: "origin" } })
  return head
}

/** The submodule's gitlink moved on main itself, around the queue, and pushed: the case candidate settling never sees (E5). */
async function gitlinkAroundQueue(w: World, sha: string): Promise<string> {
  await w.git(["checkout", "--quiet", "main"])
  const sub = gitIn(join(w.work, "submodule"))
  await sub(["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"])
  await sub(["checkout", "--quiet", sha])
  await w.git(["add", "submodule"])
  await w.git(["commit", "--quiet", "-m", `move the submodule gitlink to ${sha.slice(0, 12)} around the queue`])
  await w.git(["push", "--quiet", "origin", "main"])
  return (await w.git(["rev-parse", "HEAD"])).trim()
}

/** A change that touches a file and no gitlink, submitted. */
async function submitFile(w: World, branch: string): Promise<string> {
  await w.git(["checkout", "--quiet", "-b", branch, "main"])
  writeFileSync(join(w.work, `${branch.replace(/\//gu, "-")}.txt`), `${branch}\n`)
  await w.git(["add", "."])
  await w.git(["commit", "--quiet", "-m", `${branch}: a file, no gitlink`])
  const head = (await w.git(["rev-parse", "HEAD"])).trim()
  await w.git(["checkout", "--quiet", "main"])
  await submit(w.git, "origin", { branch, submitter: "@dev/2", target: { branch: "main", remote: "origin" } })
  return head
}

/**
 * A change whose gitlink object exists nowhere the queue can fetch. Submit
 * itself refuses it now (24454: the pin is in no store it could publish
 * from), so the queue's own defence is exercised by opening the change by
 * hand exactly as a submit does: an older submit, or an object that vanished
 * from the remote after it, opens the same change.
 */
async function submitMissingGitlink(w: World, branch: string, missing: string): Promise<string> {
  const base = (await w.git(["rev-parse", "main"])).trim()
  await w.git(["read-tree", "main"])
  await w.git(["update-index", "--add", "--info-only", "--cacheinfo", `160000,${missing},submodule`])
  const tree = (await w.git(["write-tree"])).trim()
  const head = (
    await w.git(["commit-tree", tree, "-p", base, "-m", `${branch}: record an unavailable submodule`])
  ).trim()
  await w.git(["update-ref", `refs/heads/${branch}`, head])
  await w.git(["read-tree", "main"])
  await expect(
    submit(w.git, "origin", { branch, submitter: "@dev/2", target: { branch: "main", remote: "origin" } }),
  ).rejects.toThrow(
    new RegExp(`submodule at ${missing} is a gitlink this change moved to a commit neither .* holds`, "u"),
  )
  // Nothing was opened by the refused submit; the change below is opened by hand.
  expect((await w.git(["ls-remote", "--refs", "origin", `refs/heads/${branch}`])).trim()).toBe("")
  const change = { branch, head }
  const ref = changeRef("main", change)
  await appendRecord(w.git, "main", {
    change,
    kind: "opened",
    subject: `@dev/2 submitted ${branch} to origin main`,
    trailers: [["Submitter", "@dev/2"]],
  })
  await w.git(["push", "--quiet", "--atomic", "origin", `${head}:refs/heads/${branch}`, `${ref}:${ref}`])
  return head
}

async function remoteTip(git: Git, ref: string): Promise<string> {
  const tip = (await git(["ls-remote", "--refs", "origin", ref])).trim().split(/\s+/u)[0]
  if (tip === undefined || tip === "") throw new Error(`the remote ref ${ref} is absent`)
  return tip
}

async function gitlinkAt(w: World, commit: string): Promise<string> {
  const row = (await w.git(["ls-tree", commit, "--", "submodule"])).trim().split(/\s+/u)
  return row[2] ?? ""
}

async function advanceSubmodule(w: World, contents: string): Promise<string> {
  const submoduleWork = join(w.work, "..", "submodule-work")
  const submodule = gitIn(submoduleWork)
  await submodule(["checkout", "--quiet", "main"])
  writeFileSync(join(submoduleWork, "lib.txt"), `${contents}\n`)
  await submodule(["commit", "--quiet", "-am", contents])
  await submodule(["push", "--quiet", "origin", "main"])
  return (await submodule(["rev-parse", "HEAD"])).trim()
}

/**
 * A commit on top of the submodule's main that main does not carry yet, pushed
 * under a branch so the queue can fetch it: the shape 24454 lands through the
 * root queue, with nobody fast-forwarding the submodule by hand.
 */
async function aheadOfSubmodule(w: World, contents: string): Promise<string> {
  const submoduleWork = join(w.work, "..", "submodule-work")
  const submodule = gitIn(submoduleWork)
  await submodule(["checkout", "--quiet", "-b", `ahead-${contents}`, "main"])
  writeFileSync(join(submoduleWork, "lib.txt"), `${contents}\n`)
  await submodule(["commit", "--quiet", "-am", `${contents}, ahead of main`])
  await submodule(["push", "--quiet", "origin", `ahead-${contents}`])
  await submodule(["checkout", "--quiet", "main"])
  return (await submodule(["rev-parse", `ahead-${contents}`])).trim()
}

/**
 * A commit made in the submitter's OWN submodule checkout, on top of the
 * submodule's main, and pushed nowhere: the shape an author's bay holds after
 * committing a submodule change and before anything publishes it.
 */
async function bayOnlySubmoduleCommit(w: World, contents: string): Promise<string> {
  const sub = gitIn(join(w.work, "submodule"))
  await sub(["config", "user.email", "queue@yrd.test"])
  await sub(["config", "user.name", "yrd"])
  await sub(["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"])
  await sub(["checkout", "--quiet", "--detach", w.main])
  writeFileSync(join(w.work, "submodule", "lib.txt"), `${contents}\n`)
  await sub(["commit", "--quiet", "-am", `${contents}, only in the bay`])
  return (await sub(["rev-parse", "HEAD"])).trim()
}

async function submoduleRemoteRef(w: World, ref: string): Promise<string | undefined> {
  const tip = (await w.git(["ls-remote", "--refs", "https://git-super.test/owned/submodule.git", ref]))
    .trim()
    .split(/\s+/u)[0]
  return tip === undefined || tip === "" ? undefined : tip
}

async function submoduleMain(w: World): Promise<string> {
  const tip = (await w.git(["ls-remote", "--refs", "https://git-super.test/owned/submodule.git", "refs/heads/main"]))
    .trim()
    .split(/\s+/u)[0]
  if (tip === undefined || tip === "") throw new Error("the submodule remote has no main")
  return tip
}

/**
 * One level deeper than `world()`: `apps/leaf` inside the submodule, which is
 * the shape `km/apps/maddoc` has in production.
 *
 * The leaf's own main is then moved ON, so the pin the submodule records for it
 * is BEHIND. That is the ordinary resting state of a nested pin -- the leaf's
 * main moves independently of the parent that records it -- and it is what
 * makes `kept-behind` the common case rather than an exotic one.
 */
async function addNestedSubmodule(
  w: World,
): Promise<Readonly<{ leafRecorded: string; leafMain: string; submoduleMain: string }>> {
  const root = join(w.work, "..")
  const seed = gitIn(root)
  // A fourth transport rewrite, beside the three `world()` declared. Ownership
  // is decided on the hosted identity, so the leaf needs one of its own or
  // git-super records it `as-written` and never asks its main anything.
  process.env.GIT_CONFIG_COUNT = "4"
  process.env.GIT_CONFIG_KEY_3 = `url.${join(root, "leaf.git")}.insteadOf`
  process.env.GIT_CONFIG_VALUE_3 = "https://git-super.test/owned/leaf.git"

  const leaf = join(root, "leaf.git")
  const leafWork = join(root, "leaf-work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", leaf])
  await seed(["clone", "--quiet", leaf, leafWork])
  const lg = gitIn(leafWork)
  await lg(["config", "user.email", "queue@yrd.test"])
  await lg(["config", "user.name", "yrd"])
  await lg(["remote", "set-url", "origin", "https://git-super.test/owned/leaf.git"])
  await lg(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(leafWork, "leaf.txt"), "leaf one\n")
  await lg(["add", "leaf.txt"])
  await lg(["commit", "--quiet", "-m", "leaf one"])
  await lg(["push", "--quiet", "origin", "main"])
  const leafRecorded = (await lg(["rev-parse", "HEAD"])).trim()

  const submoduleWork = join(root, "submodule-work")
  const sg = gitIn(submoduleWork)
  await sg(["checkout", "--quiet", "main"])
  await sg(["submodule", "add", "--quiet", "https://git-super.test/owned/leaf.git", "apps/leaf"])
  await sg(["add", ".gitmodules", "apps/leaf"])
  await sg(["commit", "--quiet", "-m", "the submodule gains a nested app"])
  await sg(["push", "--quiet", "origin", "main"])
  const submoduleMain = (await sg(["rev-parse", "HEAD"])).trim()

  // The leaf's main moves on AFTER the submodule pinned it, so the recorded
  // nested pin is behind its own main without anybody doing anything wrong.
  writeFileSync(join(leafWork, "leaf.txt"), "leaf two\n")
  await lg(["commit", "--quiet", "-am", "leaf two"])
  await lg(["push", "--quiet", "origin", "main"])
  const leafMain = (await lg(["rev-parse", "HEAD"])).trim()

  const sub = gitIn(join(w.work, "submodule"))
  await w.git(["checkout", "--quiet", "main"])
  await sub(["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"])
  await sub(["checkout", "--quiet", submoduleMain])
  // The queue BORROWS from this checkout as its reference, and git-super
  // refuses to borrow from a reference that carries no store for a gitlink --
  // at any depth. Without this the run ends stuck on "the reference holds no
  // object store for apps/leaf", which is the materializer doing its job and
  // says nothing about the state under test.
  await sub(["submodule", "update", "--init", "--recursive"])
  await w.git(["add", "submodule"])
  await w.git(["commit", "--quiet", "-m", "root records the submodule that carries the nested app"])
  await w.git(["push", "--quiet", "origin", "main"])
  return { leafMain, leafRecorded, submoduleMain }
}

describe("settling gitlinks", () => {
  // D1 (24454, 2026-09-10): a pin that diverged from its submodule's main is
  // the submitter's defect and FAILS back to them. It used to wait (H5) for a
  // person to move main under it; the queue now moves main itself, forward only,
  // so nothing could ever clear that wait.
  it("an off-main gitlink fails back to its submitter while the next change proceeds", async () => {
    const w = await world()
    const head = await submitGitlink(w, "task/off", w.offMain)
    await submitFile(w, "task/next")

    const outcome = await queueRun(await w.options())

    // A run that failed a change exits 1: the exit code is the run's verdict, not the queue's health.
    expect(outcome).toMatchObject({ exitCode: 1, failed: ["task/off"], merged: ["task/next"], stuck: [] })
    const failedRecords = await readRecords(
      w.git,
      await remoteTip(w.git, changeRef("main", { branch: "task/off", head })),
    )
    // The failure, then the notification of it: the submitter is told, not left to find out.
    expect(failedRecords.map((record) => record.kind)).toEqual(["opened", "failed", "sent"])
    const failure = failedRecords.at(-2)!
    expect(trailer(failure, "Fault")).toBe("submitter")
    expect(trailer(failure, "Reason")).toBe("gitlink-off-main")
    expect(trailer(failure, "Remedy")).toContain("Rebase submodule onto its configured submodule branch")
    expect(trailer(failure, "Remedy")).toContain("submit again")
    expect(trailer(failure, "Detail")).toContain(w.offMain)
    expect(readFileSync(outcome.log, "utf8")).toContain("gitlink-off-main")

    // Nothing waits: the next run has nothing to do for it.
    const repeated = await queueRun(await w.options())
    expect(repeated).toMatchObject({ exitCode: 0, failed: [], merged: [], stuck: [] })
    expect(
      (await readRecords(w.git, await remoteTip(w.git, changeRef("main", { branch: "task/off", head })))).map(
        (record) => record.kind,
      ),
    ).toEqual(["opened", "failed", "sent"])

    // The submitter's cure: put the pin on submodule main, then submit again.
    const submoduleWork = join(w.work, "..", "submodule-work")
    const submodule = gitIn(submoduleWork)
    await submodule(["checkout", "--quiet", "main"])
    await submodule(["merge", "--quiet", "--no-ff", "-s", "ours", "-m", "merge feature", "feature"])
    await submodule(["push", "--quiet", "origin", "main"])
    const submoduleMain = (await submodule(["rev-parse", "HEAD"])).trim()
    // The submitter's root checkout follows main, which task/next moved.
    await w.git(["fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main"])
    await w.git(["checkout", "--quiet", "main"])
    await w.git(["merge", "--quiet", "--ff-only", "origin/main"])
    const resubmitted = await submitGitlink(w, "task/off-rebased", w.offMain)

    const retried = await queueRun(await w.options())

    expect(retried).toMatchObject({ exitCode: 0, failed: [], merged: ["task/off-rebased"], stuck: [] })
    expect(
      (
        await readRecords(
          w.git,
          await remoteTip(w.git, changeRef("main", { branch: "task/off-rebased", head: resubmitted })),
        )
      ).map((record) => record.kind),
    ).toEqual(["opened", "checked", "merged", "sent"])
    expect(await gitlinkAt(w, await remoteTip(w.git, "refs/heads/main"))).toBe(submoduleMain)
  })

  // 24408 kept its teeth after D1: the failure's journal row must stay readable
  // by every read verb, and carries no half-written incident (a failed change
  // is the submitter's, not a queue incident).
  it("an off-main failure writes a journal row the readers accept, with no incident", async () => {
    const w = await world()
    const head = await submitGitlink(w, "task/off", w.offMain)

    const outcome = await queueRun(await w.options())

    expect(outcome).toMatchObject({ exitCode: 1, failed: ["task/off"], merged: [], stuck: [] })
    const read = () => readJournals(dirname(outcome.log))
    expect(read).not.toThrow()
    const run = read().runs.get(journalKey("task/off", head))?.[0]
    expect(run?.decision).toBe("failed")
    expect(run?.incident).toBeUndefined()
  })

  // 24454: a submodule change lands through the ROOT queue. The authored pin is
  // ahead of the submodule's main; git-super keeps it (kept-ahead) and freezes
  // its publication into the merge, and the queue publishes that intent at
  // land: the submodule's main first, root main last. Nobody fast-forwards the
  // submodule by hand, and no submodule main moves before the root merge has
  // passed every check.
  it("an authored gitlink ahead of submodule main lands with that main advanced to it, children first", async () => {
    const w = await world()
    const ahead = await aheadOfSubmodule(w, "four")
    expect(await submoduleMain(w)).toBe(w.main)
    const head = await submitGitlink(w, "task/ahead", ahead)
    const outcome = await queueRun(await w.options())

    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/ahead"])
    const target = await remoteTip(w.git, "refs/heads/main")
    expect(await gitlinkAt(w, target)).toBe(ahead)
    // The queue advanced the submodule's main to the landed pin: a fresh
    // recursive clone of root main fetches it from main, not from a branch.
    expect(await submoduleMain(w)).toBe(ahead)
    const message = await w.git(["show", "-s", "--format=%B", target])
    expect(message).toContain(`Change: task/ahead@${head}`)
    expect(message).toContain(`Settled: submodule@${ahead} kept-ahead submodule-main@${w.main}`)
    const merged = (
      await readRecords(w.git, await remoteTip(w.git, changeRef("main", { branch: "task/ahead", head })))
    ).find((record) => record.kind === "merged")
    expect(merged).toBeDefined()
    expect(trailer(merged!, "Merge")).toBe(target)
    // The published child is on the record, so a reader of the record alone
    // knows which submodule main this landing moved and to what.
    expect(trailer(merged!, "Published")).toBe(`submodule ${w.main} -> ${ahead}`)
  })

  // 24454: the whole landing is one ordinary submit of the root. The author
  // committed inside the submodule and bumped the gitlink; nothing else was
  // pushed. Submit publishes the moved pin to the submodule's remote under
  // git-super's retention ref, create-only and named by the oid, so the queue
  // can fetch it, judge the whole tree, and move the submodule's main itself.
  it("a submit publishes a moved gitlink's commit the submodule remote lacks, and the queue lands it", async () => {
    const w = await world()
    const pin = await bayOnlySubmoduleCommit(w, "five")
    expect(await submoduleRemoteRef(w, `refs/git-super/pins/${pin}`)).toBeUndefined()
    const head = await submitGitlink(w, "task/bay-only", pin)
    // Published at submit, before the change was opened: the retention ref
    // names exactly the pin, and the submodule's main has not moved.
    expect(await submoduleRemoteRef(w, `refs/git-super/pins/${pin}`)).toBe(pin)
    expect(await submoduleMain(w)).toBe(w.main)
    const outcome = await queueRun(await w.options())

    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/bay-only"])
    const target = await remoteTip(w.git, "refs/heads/main")
    expect(await gitlinkAt(w, target)).toBe(pin)
    expect(await submoduleMain(w)).toBe(pin)
    const merged = (
      await readRecords(w.git, await remoteTip(w.git, changeRef("main", { branch: "task/bay-only", head })))
    ).find((record) => record.kind === "merged")
    expect(merged).toBeDefined()
    expect(trailer(merged!, "Published")).toBe(`submodule ${w.main} -> ${pin}`)
  })

  // The same submit, retried at the same head: the retention ref already
  // names the pin, which is the one identical write a create-only ref accepts.
  it("a retried submit finds its moved pin already retained and opens the retry", async () => {
    const w = await world()
    const pin = await bayOnlySubmoduleCommit(w, "six")
    const head = await submitGitlink(w, "task/bay-only-twice", pin)
    expect(await submoduleRemoteRef(w, `refs/git-super/pins/${pin}`)).toBe(pin)
    const again = await submit(w.git, "origin", {
      branch: "task/bay-only-twice",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })
    expect(again).toMatchObject({ head, retry: true })
    expect(await submoduleRemoteRef(w, `refs/git-super/pins/${pin}`)).toBe(pin)
  })

  // 24454, the partial-failure rule: the submodule main is published, then
  // the root push is refused because root main moved under its lease (a
  // direct merge, or another queue). That is the one partial state this
  // landing accepts: the change keeps its place, nothing is stuck, and the
  // next run composes on the new root main where the published pin reads as
  // Equal, so the landing finishes with no second publication.
  it("a published child under a refused root push keeps the change in place, and the next run lands it", async () => {
    const w = await world()
    const ahead = await aheadOfSubmodule(w, "seven")
    const head = await submitGitlink(w, "task/partial", ahead)
    await using real = createProcess({ cwd: w.work })
    let rootPushesSeen = 0
    let movedAround = ""
    const observing: Process = {
      ...real,
      async run(request) {
        const rootPush =
          request.argv.includes("push") &&
          !request.argv.includes("super") &&
          request.argv.some((arg) => arg.endsWith(":refs/heads/main"))
        if (rootPush && rootPushesSeen++ === 0) {
          // Between the children's publication and the root push, root main
          // moves around the queue: the lease must refuse, and nothing else.
          expect(await submoduleMain(w)).toBe(ahead)
          await w.git(["checkout", "--quiet", "main"])
          writeFileSync(join(w.work, "around.txt"), "around the queue\n")
          await w.git(["add", "around.txt"])
          await w.git(["commit", "--quiet", "-m", "a file landed around the queue"])
          await w.git(["push", "--quiet", "origin", "main"])
          movedAround = (await w.git(["rev-parse", "HEAD"])).trim()
        }
        return real.run(request)
      },
    }
    const first = await queueRun({ ...(await w.options()), process: observing })
    expect(first.exitCode).toBe(0)
    expect(first.merged).toEqual([])
    expect(first.stuck).toEqual([])
    expect(rootPushesSeen).toBe(1)
    // The partial state, exactly: submodule main moved, root main did not take the merge.
    expect(await submoduleMain(w)).toBe(ahead)
    expect(await remoteTip(w.git, "refs/heads/main")).toBe(movedAround)
    const firstRows = readFileSync(first.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(firstRows.find((row) => row.kind === "publish")).toMatchObject({
      path: "submodule",
      from: w.main,
      to: ahead,
    })
    expect(firstRows.find((row) => row.kind === "change" && row.decision === "checked")).toMatchObject({
      reason: "target-moved",
    })
    // The landing record is on the change ref, and it says what was published.
    const ref = changeRef("main", { branch: "task/partial", head })
    const landing = (await readRecords(w.git, await remoteTip(w.git, ref))).at(-1)
    expect(landing?.kind).toBe("checked")
    expect(trailer(landing!, "Publishing")).toBe(`submodule ${w.main} -> ${ahead}`)

    const second = await queueRun(await w.options())
    expect(second.exitCode).toBe(0)
    expect(second.merged).toEqual(["task/partial"])
    const target = await remoteTip(w.git, "refs/heads/main")
    expect(await gitlinkAt(w, target)).toBe(ahead)
    expect(await submoduleMain(w)).toBe(ahead)
    expect((await w.git(["rev-parse", `${target}^1`])).trim()).toBe(movedAround)
    const secondRows = readFileSync(second.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    // Nothing to publish the second time: the pin now equals the submodule's main.
    expect(secondRows.find((row) => row.kind === "publish")).toBeUndefined()
    const merged = (await readRecords(w.git, await remoteTip(w.git, ref))).find((record) => record.kind === "merged")
    expect(merged).toBeDefined()
    expect(trailer(merged!, "Published")).toBeUndefined()
  })

  it("a held-back authored gitlink merges raised and keeps the submitted Change identity", async () => {
    const w = await world()
    const head = await submitGitlink(w, "task/on", w.onMain)
    // Existing merge results cannot prove the cleanup ordering: observe real
    // producer bytes and require the remote terminal record before deletion.
    const produced = new Map<string, string>()
    let cleaned = false
    await using real = createProcess({ cwd: w.work })
    const observing: Process = {
      ...real,
      async run(request) {
        const deletion = request.argv.indexOf("update-ref")
        const ref = request.argv[deletion + 2]
        if (deletion >= 0 && request.argv[deletion + 1] === "-d" && ref?.startsWith("refs/git-super/receipts/")) {
          const merge = ref.slice("refs/git-super/receipts/".length)
          expect(await remoteTip(w.git, "refs/heads/main")).toBe(merge)
          const record = (
            await readRecords(w.git, await remoteTip(w.git, changeRef("main", { branch: "task/on", head })))
          ).find((row) => row.kind === "merged")
          expect(record).toBeDefined()
          expect(trailer(record!, "Root-Changes")).toBe(produced.get(merge))
          cleaned = true
        }
        const result = await real.run(request)
        if (result.exitCode === 0 && request.argv.includes("merge") && request.argv.includes("super")) {
          const merge = (JSON.parse(result.stdout) as { commit: string }).commit
          const bytes = await w.git(["show", `refs/git-super/receipts/${merge}:receipt.json`])
          produced.set(merge, Buffer.from(bytes, "utf8").toString("base64"))
        }
        return result
      },
    }
    const outcome = await queueRun({ ...(await w.options()), process: observing })

    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/on"])
    const target = await remoteTip(w.git, "refs/heads/main")
    expect(await gitlinkAt(w, target)).toBe(w.main)
    const message = await w.git(["show", "-s", "--format=%B", target])
    expect(message).toContain(`Change: task/on@${head}`)
    expect(message).toContain(`Settled: submodule@${w.main}`)
    const merge = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record.kind === "merge")
    expect(merge?.gitlinks).toContain(`submodule ${w.onMain} -> ${w.main}`)
    // The durable terminal record copies the exact producer bytes, and survives
    // removal of the temporary local receipt; old merge-result tests miss this.
    const ref = changeRef("main", { branch: "task/on", head })
    const recordTip = await remoteTip(w.git, ref)
    const records = await readRecords(w.git, recordTip)
    const merged = records.find((record) => record.kind === "merged")
    expect(merged).toBeDefined()
    const receiptRef = `refs/git-super/receipts/${target}`
    const copied = produced.get(target)
    expect(copied).toBeDefined()
    expect(trailer(merged!, "Root-Changes")).toBe(copied)
    expect(cleaned).toBe(true)
    expect((await w.git(["for-each-ref", "--format=%(refname)", receiptRef])).trim()).toBe("")
    expect(
      trailer((await readRecords(w.git, recordTip)).find((record) => record.kind === "merged")!, "Root-Changes"),
    ).toBe(copied)
  })

  it("the queue-owned merge is isolated from vetoing and observing repository hooks", async () => {
    const w = await world()
    const head = await submitGitlink(w, "task/hook-isolation", w.onMain)
    const observed = join(w.work, "..", "queue-hook-observed.log")
    for (const [hook, exit] of [
      ["prepare-commit-msg", 1],
      ["post-commit", 0],
    ] as const) {
      const path = join(w.work, ".git", "hooks", hook)
      writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${hook}' >> '${observed}'\nexit ${String(exit)}\n`)
      chmodSync(path, 0o755)
    }

    const outcome = await queueRun(await w.options())

    expect(outcome).toMatchObject({ exitCode: 0, failed: [], merged: ["task/hook-isolation"], stuck: [] })
    expect(existsSync(observed)).toBe(false)
    const target = await remoteTip(w.git, "refs/heads/main")
    expect((await w.git(["rev-list", "--parents", "-n", "1", target])).trim().split(" ")).toHaveLength(3)
    expect(await w.git(["show", "-s", "--format=%B", target])).toContain(`Settled: submodule@${w.main}`)
    expect(await gitlinkAt(w, target)).toBe(w.main)
    expect(
      (
        await readRecords(w.git, await remoteTip(w.git, changeRef("main", { branch: "task/hook-isolation", head })))
      ).map((record) => record.kind),
    ).toEqual(["opened", "checked", "merged", "sent"])
  })

  /** An anomaly already on root main is not the candidate's authorship, but every merge that passes over it must expose it. */
  it("an untouched off-main target gitlink stays put and is reported in the run log", async () => {
    const w = await world()
    await gitlinkAroundQueue(w, w.offMain)
    await submitFile(w, "task/pass-over-off-main")

    const outcome = await queueRun(await w.options())

    expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/pass-over-off-main"] })
    const target = await remoteTip(w.git, "refs/heads/main")
    expect(await gitlinkAt(w, target)).toBe(w.offMain)
    expect(await w.git(["show", "-s", "--format=%(trailers:key=Settled,valueonly)", target])).toContain(
      `submodule@${w.offMain} left-off-main submodule-main@${w.main}`,
    )
    const settle = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.kind === "settle")
    expect(settle).toContainEqual(
      expect.objectContaining({
        from: w.offMain,
        path: "submodule",
        state: "left-off-main",
        to: w.main,
      }),
    )
  })

  it("an unfetchable candidate gitlink fails the submitter and the next change proceeds", async () => {
    const w = await world()
    const missing = "f".repeat(40)
    const head = await submitMissingGitlink(w, "task/missing", missing)
    await submitFile(w, "task/next")

    const outcome = await queueRun(await w.options())

    expect(outcome).toMatchObject({ exitCode: 1, failed: ["task/missing"], merged: ["task/next"], stuck: [] })
    const records = await readRecords(
      w.git,
      await remoteTip(w.git, changeRef("main", { branch: "task/missing", head })),
    )
    expect(records.map((record) => record.kind)).toEqual(["opened", "failed", "sent"])
    const failed = records.find((record) => record.kind === "failed")
    expect(trailer(failed!, "Fault")).toBe("submitter")
    expect(trailer(failed!, "Reason")).toContain(missing)
    expect(failed?.subject).toContain("submodule")
  })

  it("normalizes an unrecognized git-super failure without losing its boundary detail", async () => {
    const w = await world()
    const head = await submitGitlink(w, "task/unreadable-main", w.onMain)
    const missing = join(w.work, "missing-submodule.git")
    let external: Readonly<{ code: string; phase: string; message: string }> | undefined
    await using real = createProcess({ cwd: w.work })
    const observing: Process = {
      ...real,
      async run(request) {
        const merge =
          request.argv.includes("merge") && (request.argv[0] === "git-super" || request.argv.includes("super"))
        if (merge) await gitIn(join(request.cwd ?? w.work, "submodule"))(["remote", "set-url", "origin", missing])
        const result = await real.run(request)
        if (merge) {
          external = (
            JSON.parse(result.stdout) as Readonly<{
              detail?: Readonly<{ code: string; phase: string; message: string }>
            }>
          ).detail
        }
        return result
      },
    }

    const outcome = await queueRun({ ...(await w.options()), process: observing })

    expect(outcome).toMatchObject({ exitCode: 2, failed: [], merged: [], stuck: ["task/unreadable-main"] })
    expect(external).toMatchObject({ code: "git-failed", phase: "resolve-submodule-branch" })
    const records = await readRecords(
      w.git,
      await remoteTip(w.git, changeRef("main", { branch: "task/unreadable-main", head })),
    )
    expect(records.map((record) => record.kind)).toEqual(["opened", "stuck", "sent"])
    const stuck = records[1]!
    expect(trailer(stuck, "Code")).toBe("yrd-merge-unresolved")
    expect(trailer(stuck, "Subject")).toContain("submodule")
    expect(trailer(stuck, "Via")).toContain("git-failed")
    expect(trailer(stuck, "Via")).toContain("resolve-submodule-branch")
    expect(trailer(stuck, "Evidence")).toBe(outcome.log)
    expect(trailer(stuck, "Owner")).toBe("the queue operator")
    expect(trailer(records[2]!, "Owner")).toBe("the queue operator")
    if (external === undefined) throw new Error("git-super returned no failure detail")
    const evidence = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(evidence.filter((record) => record.kind === "change" && record.head === head)).toEqual([
      expect.objectContaining({
        branch: "task/unreadable-main",
        code: "yrd-merge-unresolved",
        decision: "stuck",
        diagnosisCode: external.code,
        phase: external.phase,
        reason: external.message,
      }),
    ])
  })

  it("a candidate failure introduced by raising submodule main is queue-owned stuck", async () => {
    const w = await world()
    const breaking = await advanceSubmodule(w, "breaking submodule main")
    const head = await submitFile(w, "task/base-red")

    // Attribution comes from the validated root receipt even if the old CLI
    // merge-result rows contain no raises; the real producer and refs stay intact.
    await using real = createProcess({ cwd: w.work })
    let stripped = false
    const observing: Process = {
      ...real,
      async run(request) {
        const result = await real.run(request)
        if (result.exitCode === 0 && request.argv.includes("merge") && request.argv.includes("super")) {
          stripped = true
          const merge = JSON.parse(result.stdout) as Record<string, unknown>
          return { ...result, stdout: JSON.stringify({ ...merge, gitlinks: [] }) }
        }
        return result
      },
    }
    const outcome = await queueRun({
      ...(await w.options({ on: ["submit"], run: "! grep -q 'breaking submodule main' submodule/lib.txt" })),
      process: observing,
    })

    expect(stripped).toBe(true)
    expect(outcome).toMatchObject({ exitCode: 2, failed: [], merged: [], stuck: ["task/base-red"] })
    const records = await readRecords(
      w.git,
      await remoteTip(w.git, changeRef("main", { branch: "task/base-red", head })),
    )
    const stuck = records.find((record) => record.kind === "stuck")
    expect(trailer(stuck!, "Code")).toBe("yrd-submodule-main-regression")
    expect(trailer(stuck!, "Subject")).toContain("submodule")
    expect(trailer(stuck!, "Subject")).toContain(breaking)
    expect(trailer(stuck!, "Evidence")).toBe(outcome.log)
    expect(trailer(stuck!, "Next")).toContain("yrd queue run")
    expect(
      records
        .filter((record) => record.kind === "stuck" || record.kind === "sent")
        .map((record) => trailer(record, "Owner")),
    ).toEqual(["the queue operator", "the queue operator"])
    expect(trailer(stuck!, "Fault")).toBeUndefined()
    const phases = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.kind === "result" && record.name === "submodule-check")
      .map((record) => record.phase)
    expect(phases).toEqual(["submit", "base"])
  })

  /** A missing receipt claims no automatic changes; a malformed present receipt stops before candidate checks. */
  it.each(["absent", "malformed"] as const)(
    "treats an %s root receipt according to its declared contract",
    async (fault) => {
      const w = await world()
      await advanceSubmodule(w, "breaking submodule main")
      await submitFile(w, `task/receipt-${fault}`)
      await using real = createProcess({ cwd: w.work })
      const observing: Process = {
        ...real,
        async run(request) {
          const result = await real.run(request)
          if (result.exitCode === 0 && request.argv.includes("merge") && request.argv.includes("super")) {
            const merge = (JSON.parse(result.stdout) as { commit: string }).commit
            const ref = `refs/git-super/receipts/${merge}`
            const prior = (await w.git(["rev-parse", ref])).trim()
            await w.git(fault === "absent" ? ["update-ref", "-d", ref, prior] : ["update-ref", ref, merge, prior])
          }
          return result
        },
      }
      const outcome = await queueRun({
        ...(await w.options({ on: ["submit"], run: "exit 1" })),
        process: observing,
      })
      expect(outcome.exitCode).toBe(fault === "absent" ? 1 : 2)
      const phases = readFileSync(outcome.log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((record) => record.kind === "result" && record.name === "submodule-check")
        .map((record) => record.phase)
      expect(phases).toEqual(fault === "absent" ? ["submit"] : [])
      if (fault === "malformed") expect(readFileSync(outcome.log, "utf8")).toContain("Root-Changes")
    },
  )

  /** Attribution must compare candidate-minus-content even when root main's old gitlink is divergent, not silently keep that old tree. */
  it("the settled-base comparator applies a raise over an off-main target gitlink", async () => {
    const w = await world()
    await gitlinkAroundQueue(w, w.offMain)
    const head = await submitGitlink(w, "task/repair-off-main", w.onMain)

    const outcome = await queueRun(await w.options({ on: ["submit"], run: "! grep -q '^three$' submodule/lib.txt" }))

    expect(outcome).toMatchObject({ exitCode: 2, failed: [], merged: [], stuck: ["task/repair-off-main"] })
    const records = await readRecords(
      w.git,
      await remoteTip(w.git, changeRef("main", { branch: "task/repair-off-main", head })),
    )
    const stuck = records.find((record) => record.kind === "stuck")
    expect(trailer(stuck!, "Code")).toBe("yrd-submodule-main-regression")
    expect(trailer(stuck!, "Subject")).toContain(`submodule@${w.main}`)
    const phases = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.kind === "result" && record.name === "submodule-check")
      .map((record) => record.phase)
    expect(phases).toEqual(["submit", "base"])
  })

  /** Actual receipt rows trigger comparison even when every raised path is absent or an ordinary file in the base. */
  it.each(["existing-gitlink", "new-path", "ordinary-file"] as const)(
    "a candidate-only failure stays the submitter's with a green %s comparator",
    async (baseEntry) => {
      const w = await world()
      let head: string
      if (baseEntry === "existing-gitlink") {
        await advanceSubmodule(w, "healthy submodule main")
        head = await submitFile(w, "task/candidate-red")
      } else {
        if (baseEntry === "ordinary-file") {
          writeFileSync(join(w.work, "new-submodule"), "base-owned ordinary file\n")
          await w.git(["add", "new-submodule"])
          await w.git(["commit", "--quiet", "-m", "base has an ordinary file"])
          await w.git(["push", "--quiet", "origin", "main"])
        }
        await w.git(["checkout", "--quiet", "-b", "task/candidate-red", "main"])
        if (baseEntry === "ordinary-file") await w.git(["rm", "--quiet", "new-submodule"])
        await w.git(["submodule", "add", "--quiet", "https://git-super.test/owned/submodule.git", "new-submodule"])
        await gitIn(join(w.work, "new-submodule"))(["checkout", "--quiet", w.onMain])
        writeFileSync(join(w.work, "task-candidate-red.txt"), "authored failure\n")
        await w.git(["add", ".gitmodules", "new-submodule", "task-candidate-red.txt"])
        await w.git(["commit", "--quiet", "-m", "candidate adds a held-back submodule"])
        head = (await w.git(["rev-parse", "HEAD"])).trim()
        await submit(w.git, "origin", {
          branch: "task/candidate-red",
          submitter: "@dev/2",
          target: { branch: "main", remote: "origin" },
        })
      }

      const outcome = await queueRun(
        await w.options({
          on: ["submit"],
          run: "if test -f task-candidate-red.txt || test -d new-submodule; then echo CANDIDATE_FAIL; exit 1; else echo BASE_PASS; fi",
        }),
      )

      expect(outcome, readFileSync(outcome.log, "utf8")).toMatchObject({
        exitCode: 1,
        failed: ["task/candidate-red"],
        merged: [],
        stuck: [],
      })
      const records = await readRecords(
        w.git,
        await remoteTip(w.git, changeRef("main", { branch: "task/candidate-red", head })),
      )
      expect(records.map((record) => record.kind)).toEqual(["opened", "failed", "sent"])
      expect(trailer(records.find((record) => record.kind === "failed")!, "Fault")).toBe("submitter")
      const phases = readFileSync(outcome.log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((record) => record.kind === "result" && record.name === "submodule-check")
        .map((record) => record.phase)
      expect(phases).toEqual(["submit", "base"])
      // The read-side must not relabel the green comparator as the candidate's
      // deciding artifact, nor collapse its two measured phase occurrences.
      const journals = readJournals(dirname(outcome.log))
      const queue = await readQueue(w.git, "origin", "main", outcome.target)
      const shown = watchRows(list(queue.changes, { journals }), { journals }).find((row) => row.row.head === head)!
      expect(shown.row.result).toBe("fail submodule-check")
      expect(readFileSync(shown.row.log!, "utf8")).toBe("CANDIDATE_FAIL\n")
      const detail = checksOf([], "failed", [], shown.run?.running, shown.run?.checks)
      expect(detail.map((check) => [check.phase, check.state, readFileSync(check.log!, "utf8")])).toEqual([
        ["submit", "failed", "CANDIDATE_FAIL\n"],
        ["base", "passed", "BASE_PASS\n"],
      ])
    },
  )

  it("a gitlink moved on the target around the queue is reported with its path, and no submodule is asked about it (E5)", async () => {
    const w = await world()
    // One change first: the queue's history starts at its own first record, so a
    // queue that has judged nothing reports nothing (direct.ts). Its branch is
    // then taken away, so the run retires it without building a worktree and
    // the count below stays about the direct-merge reading alone.
    await submitFile(w, "task/first")
    await w.git(["push", "--quiet", "origin", ":task/first"])
    const direct = await gitlinkAroundQueue(w, w.offMain)

    const outcome = await queueRun(await w.options())

    expect(outcome.exitCode).toBe(0)
    expect(outcome.directMerges).toEqual([direct])
    const log = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(log.filter((record) => record.kind === "merged-direct")).toMatchObject([
      { commit: direct, gitlinks: ["submodule"] },
    ])
    const told = log.filter((record) => record.kind === "message" && record.says === "merged-direct")
    expect(told).toMatchObject([{ id: direct, says: "merged-direct", to: "none" }])
    expect(told[0]?.text).toContain(`main moved around the queue at ${direct.slice(0, 12)}`)
    expect(told[0]?.text).toContain("it moved the gitlink at submodule")
  })

  it("a gitlink the reference checkout never fetched is materialized from the submodule's remote, and the change merges", async () => {
    const w = await world()
    // The submodule's main moves on in its own clone and the reference
    // checkout under `work` never fetches it; the change records it by plumbing,
    // so the reference's submodule store lacks the commit when the queue
    // builds the worktree. The queue fetches it there (2026-09-03: it refused
    // the network and stuck on @dev/2's 24089 instead).
    const submoduleWork = join(w.work, "..", "submodule-work")
    const cg = gitIn(submoduleWork)
    writeFileSync(join(submoduleWork, "lib.txt"), "four\n")
    await cg(["commit", "--quiet", "-am", "four"])
    await cg(["push", "--quiet", "origin", "main"])
    const four = (await cg(["rev-parse", "HEAD"])).trim()
    // Plumbing only: the working tree and its submodule checkout stay where
    // they are, so nothing here fetches the commit into the reference store.
    const base = (await w.git(["rev-parse", "main"])).trim()
    await w.git(["read-tree", "main"])
    await w.git(["update-index", "--add", "--cacheinfo", `160000,${four},submodule`])
    const tree = (await w.git(["write-tree"])).trim()
    const head = (
      await w.git([
        "commit-tree",
        tree,
        "-p",
        base,
        "-m",
        "task/unfetched: move the submodule gitlink to a commit this checkout never fetched",
      ])
    ).trim()
    await w.git(["update-ref", "refs/heads/task/unfetched", head])
    await w.git(["read-tree", "main"])
    await submit(w.git, "origin", {
      branch: "task/unfetched",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })

    const outcome = await queueRun(await w.options())

    expect(outcome.exitCode).toBe(0)
    const kinds = (
      await readRecords(w.git, await remoteTip(w.git, changeRef("main", { branch: "task/unfetched", head })))
    ).map((record) => record.kind)
    expect(kinds).not.toContain("stuck")
    expect(kinds).toContain("merged")
  })

  it("two changes moving the same gitlink ask the submodule once per run: a commit on main stays on main (E4)", async () => {
    const w = await world()
    await submitGitlink(w, "task/first", w.onMain)
    const second = await submitGitlink(w, "task/second", w.onMain)

    const outcome = await queueRun(await w.options())

    // Both were judged on submit — the first fetched, the second read the
    // run's answer — and one merge per run lands the first (ruling D4).
    expect(outcome.exitCode).toBe(0)
    expect(outcome.merged).toEqual(["task/first"])
    expect(
      (
        await readRecords(w.git, await remoteTip(w.git, changeRef("main", { branch: "task/second", head: second })))
      ).map((record) => record.kind),
    ).toEqual(["opened", "checked"])
  })

  /**
   * The settled-base run exists to answer one question — does the base fail
   * the same things? — and re-running the whole check to answer it is what
   * costs the queue a second full check on every failure (hh-dev, run
   * q-20260910T063044822Z-41b0c4ff: 5.3 min to name one attributable test id,
   * then 4.7 min re-running the identical plan to say it was green at base).
   * The check names the scope; the queue puts it in that same check's base
   * environment and says on the row which of the two runs it made.
   */
  describe("the scope the base run is given", () => {
    /** A check that fails where the raised submodule content is, saying `line` on its way. */
    const failingCheck = (line: string): string =>
      [
        `printf 'ONLY=%s\\n' "\${AFFECTED_TESTS_ONLY:-unset}"`,
        `printf '%s\\n' '${line}'`,
        "! grep -q 'breaking submodule main' submodule/lib.txt",
      ].join("; ")

    /** The base-phase rows this run wrote for the check, and the run's narrowing refusals. */
    const baseRows = (
      log: string,
    ): Readonly<{ rows: readonly Record<string, unknown>[]; refusals: readonly Record<string, unknown>[] }> => {
      const records = readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      return {
        refusals: records.filter((record) => record.kind === "narrowing"),
        rows: records.filter((record) => record.kind === "check" && record.phase === "base"),
      }
    }

    it("is the scope the failing check asked for, and the base run is told it", async () => {
      const w = await world()
      await advanceSubmodule(w, "breaking submodule main")
      await submitFile(w, "task/narrowed-base")

      const outcome = await queueRun(
        await w.options({
          on: ["submit"],
          run: failingCheck('YRD-BASE-NARROWING {"env":{"AFFECTED_TESTS_ONLY":"tools/pool.test.ts"}}'),
        }),
      )

      // Unchanged verdict: the base fails the same check, so the raise is the
      // fault and nobody is billed for it.
      expect(outcome).toMatchObject({ exitCode: 2, failed: [], merged: [], stuck: ["task/narrowed-base"] })
      const { refusals, rows } = baseRows(outcome.log)
      expect(refusals).toEqual([])
      expect(rows.map((row) => row.scope)).toEqual(["narrowed", "narrowed"])
      // The name is NOT in the check's `environmentPassthrough`, so the only
      // way it can reach the base run is the offer the check itself made.
      const [start] = rows
      expect(readFileSync(String(start?.log), "utf8")).toContain("ONLY=tools/pool.test.ts")
    })

    it("is the whole check when the failing check offers nothing", async () => {
      const w = await world()
      await advanceSubmodule(w, "breaking submodule main")
      await submitFile(w, "task/full-base")

      const outcome = await queueRun(await w.options({ on: ["submit"], run: failingCheck("no offer on this line") }))

      expect(outcome).toMatchObject({ exitCode: 2, failed: [], merged: [], stuck: ["task/full-base"] })
      const { refusals, rows } = baseRows(outcome.log)
      expect(refusals).toEqual([])
      expect(rows.map((row) => row.scope)).toEqual(["full", "full"])
      expect(readFileSync(String(rows[0]?.log), "utf8")).toContain("ONLY=unset")
    })

    it("is the whole check when the offer cannot be honoured, and the run says why", async () => {
      const w = await world()
      await advanceSubmodule(w, "breaking submodule main")
      await submitFile(w, "task/refused-base")

      const outcome = await queueRun(
        await w.options({ on: ["submit"], run: failingCheck("YRD-BASE-NARROWING {not json}") }),
      )

      expect(outcome).toMatchObject({ exitCode: 2, failed: [], merged: [], stuck: ["task/refused-base"] })
      const { refusals, rows } = baseRows(outcome.log)
      // A refusal is never a quiet absence: the row names the check and the
      // sentence, and the base run it fell back to is the full one.
      expect(refusals).toMatchObject([
        { name: "submodule-check", reason: expect.stringContaining("is not JSON"), scope: "full" },
      ])
      expect(rows.map((row) => row.scope)).toEqual(["full", "full"])
      expect(readFileSync(String(rows[0]?.log), "utf8")).toContain("ONLY=unset")
    })
  })

  /**
   * 24454 row 4, the consumer half. git-super now classifies NESTED gitlinks and
   * emits `kept-behind` for a nested pin behind its own main. This queue reads
   * that JSON as its ruled command boundary, so a state it does not know is a
   * throw out of `superMerge` and into composition -- and km pins maddoc, whose
   * main moves on its own, so every km change would have carried one.
   *
   * The whole point is that it is READ and LOGGED and NOT PUBLISHED. A nested pin
   * lives inside its parent's commit; publishing it would move a main no root
   * merge is entitled to move.
   */
  it("reads a nested kept-behind pin, logs it, and publishes nothing for it", async () => {
    const w = await world()
    const nested = await addNestedSubmodule(w)
    // The parent must be AHEAD or the planner does not descend into it at all,
    // and this arm would assert on a level that was never walked.
    const ahead = await aheadOfSubmodule(w, "five")
    const head = await submitGitlink(w, "task/nested-behind", ahead)

    const outcome = await queueRun(await w.options())

    expect(outcome).toMatchObject({ exitCode: 0, merged: ["task/nested-behind"] })
    const target = await remoteTip(w.git, "refs/heads/main")

    const settle = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.kind === "settle")
    // READ, and read as itself: the nested path, on its own rung, measured
    // against the leaf's main rather than the parent's.
    expect(settle).toContainEqual(
      expect.objectContaining({
        from: nested.leafRecorded,
        path: "submodule/apps/leaf",
        state: "kept-behind",
        to: nested.leafMain,
      }),
    )
    expect(await w.git(["show", "-s", "--format=%(trailers:key=Settled,valueonly)", target])).toContain(
      `submodule/apps/leaf@${nested.leafRecorded} kept-behind submodule-main@${nested.leafMain}`,
    )

    // NOT PUBLISHED. The parent's main moved because the parent was Ahead; the
    // leaf's main did not move at all, and the landing record names only the
    // parent as published.
    expect(await submoduleMain(w)).toBe(ahead)
    expect((await gitIn(join(w.work, "..", "leaf-work"))(["ls-remote", "origin", "refs/heads/main"])).trim()).toContain(
      nested.leafMain,
    )
    const merged = (
      await readRecords(w.git, await remoteTip(w.git, changeRef("main", { branch: "task/nested-behind", head })))
    ).find((record) => record.kind === "merged")
    expect(merged).toBeDefined()
    expect(trailer(merged!, "Published")).toBe(`submodule ${nested.submoduleMain} -> ${ahead}`)
    expect(trailer(merged!, "Published")).not.toContain("apps/leaf")
  })

  /**
   * B2 (@cto, 24454 row 4). `candidateFailure` names three cases and sends
   * EVERYTHING ELSE to stuck as `yrd-merge-unresolved`, a queue fault needing a
   * person. `nested-pin-lowered` is built by git-super's `obviousDetail`, whose
   * phase defaults to "preflight", so before this it matched none of the three.
   *
   * A lowering is the SUBMITTER's -- its own remedy says "owner: the submodule
   * writer" -- so an unclassified one would have stopped the line for the fleet
   * instead of going back to the one person who can re-record the gitlink.
   */
  it("fails the change on a nested pin LOWERED below the parent's own main, never stuck", async () => {
    const w = await world()
    const nested = await addNestedSubmodule(w)
    // The submodule's main ADVANCES its nested pin, so the candidate below --
    // which keeps recording the older one -- is a lowering rather than merely
    // behind.
    const submoduleWork = join(w.work, "..", "submodule-work")
    const sg = gitIn(submoduleWork)
    await sg(["checkout", "--quiet", "main"])
    const nestedCheckout = gitIn(join(submoduleWork, "apps/leaf"))
    await nestedCheckout(["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"])
    await nestedCheckout(["checkout", "--quiet", nested.leafMain])
    await sg(["add", "apps/leaf"])
    await sg(["commit", "--quiet", "-m", "the submodule's main raises its nested pin"])
    await sg(["push", "--quiet", "origin", "main"])

    // The candidate is cut from that new submodule main -- so the PARENT is
    // Ahead and the planner descends -- and re-records the leaf at the older
    // pin, which is the lowering.
    const sub = gitIn(join(w.work, "submodule"))
    await w.git(["checkout", "--quiet", "-b", "task/nested-lowered", "main"])
    await sub(["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"])
    await sub(["checkout", "--quiet", (await sg(["rev-parse", "HEAD"])).trim()])
    const subLeaf = gitIn(join(w.work, "submodule/apps/leaf"))
    await subLeaf(["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"])
    await subLeaf(["checkout", "--quiet", nested.leafRecorded])
    await sub(["add", "apps/leaf"])
    await sub(["commit", "--quiet", "-m", "re-record the nested pin at an older commit"])
    await sub(["push", "--quiet", "origin", "HEAD:refs/git-super/pins/lowered"])
    await w.git(["add", "submodule"])
    await w.git(["commit", "--quiet", "-m", "task/nested-lowered: carry the lowered nested pin"])
    const head = (await w.git(["rev-parse", "HEAD"])).trim()
    await w.git(["checkout", "--quiet", "main"])
    await submit(w.git, "origin", {
      branch: "task/nested-lowered",
      submitter: "@dev/2",
      target: { branch: "main", remote: "origin" },
    })

    const outcome = await queueRun(await w.options())

    // FAILED, NOT STUCK. exitCode 1 is an attributed candidate failure; 2 is the
    // queue going down.
    expect(outcome.exitCode, "a submitter's lowering must not stop the queue").toBe(1)
    expect(outcome.merged).toEqual([])
    const records = await readRecords(
      w.git,
      await remoteTip(w.git, changeRef("main", { branch: "task/nested-lowered", head })),
    )
    expect(records.map((record) => record.kind)).toEqual(["opened", "failed", "sent"])
    const failed = records.find((record) => record.kind === "failed")
    expect(trailer(failed!, "Reason")).toBe("nested-pin-lowered")
    // And the record tells the author what to do, rather than naming a queue fault.
    expect(failed?.subject ?? "").toContain("apps/leaf")
  })

  /**
   * THE PRODUCTION LAYOUT (@cto, measured 2026-09-11). In the queue's own clone
   * `km/apps/maddoc` holds ONLY a `.git` directory and no checked-out files,
   * where `addNestedSubmodule` builds a fully populated one.
   *
   * That distinction is exactly what row 4's `gitlink-store-absent` guard keys
   * on, so an arm that only ever sees a populated nested checkout cannot say
   * whether the guard refuses real traffic. It must not: an EMPTY worktree with
   * its own `.git` is still that gitlink's own repository, and only a path with
   * NO repository at all makes Git discovery answer with the parent.
   */
  it("classifies a nested pin whose checkout holds only its .git, as production does", async () => {
    const w = await world()
    const nested = await addNestedSubmodule(w)
    const ahead = await aheadOfSubmodule(w, "eight")
    // Strip the nested checkout down to its `.git`, leaving the repository in
    // place and the working tree empty -- the queue clone's shape.
    const nestedPath = join(w.work, "submodule/apps/leaf")
    for (const entry of readdirSync(nestedPath)) {
      if (entry !== ".git") rmSync(join(nestedPath, entry), { force: true, recursive: true })
    }
    expect(readdirSync(nestedPath)).toEqual([".git"])
    await submitGitlink(w, "task/nested-bare", ahead)

    const outcome = await queueRun(await w.options())

    expect(outcome, "an empty worktree with its own .git is not an absent store").toMatchObject({
      exitCode: 0,
      merged: ["task/nested-bare"],
    })
    const settle = readFileSync(outcome.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.kind === "settle")
    expect(settle).toContainEqual(
      expect.objectContaining({
        from: nested.leafRecorded,
        path: "submodule/apps/leaf",
        state: "kept-behind",
        to: nested.leafMain,
      }),
    )
  })
})
