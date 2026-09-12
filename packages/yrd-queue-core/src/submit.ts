/**
 * `yrd queue submit <branch>`: the one path in
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design, The change).
 *
 * One atomic push of the branch and of its change's opened record. Either both
 * arrive at the remote or neither does, so a reader never sees a submitted
 * branch without its change or a change without its branch. A submit at an
 * unchanged head appends a new opened record to the existing change: that is a
 * retry, and the change keeps its place in line from its first opened record.
 * The branch is always pushed with a lease, because a rebased branch is the
 * ordinary case and a lease is what stops it clobbering a head the submitter
 * never saw.
 */

import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { targetName, type Target } from "./config.ts"
import { ABSENT, appendRecord, type Git } from "./records.ts"
import { gitIn, gitlinkRows, isAncestor, mergeBase, readRemoteCommit, refAt } from "./git.ts"
import { changeRef } from "./refs.ts"
import { requireResumed } from "./pause.ts"

export type SubmitRequest = Readonly<{
  /** The branch being submitted: the change's own. */
  branch: string
  /** The queue's target: the branch it merges on, at the remote holding it. */
  target: Target
  submitter: string
  issue?: string
  /** Explicit permission to rebase this clean, checked-out branch onto the captured target. */
  rebase?: boolean
}>

export type Submitted = Readonly<{
  branch: string
  head: string
  /** The target commit observed during preflight; the queue checks again at merge. */
  targetHead: string
  /** The opened record's sha. */
  opened: string
  /** True when the change already existed at this head, so this was a retry. */
  retry: boolean
  /** Gitlinks this change moved whose commits submit published to their submodule remotes (24454). */
  published: readonly PublishedGitlink[]
}>

export type PublishedGitlink = Readonly<{
  /** Root-relative, nested paths joined: `km`, `km/apps/maddoc`. */
  path: string
  /** The pin the change records at that path. */
  sha: string
  /** The submodule remote the pin now lives at, and the retention ref naming it there. */
  remote: string
  ref: string
  /**
   * `published`: this submit wrote the ref. `retained`: it already named the pin (a retry, or a prior submit).
   * `fetchable`: the checkout lacked the pin and the remote already held it under some ref (a branch somebody
   * pushed), so nothing was written; the queue fetches by sha exactly as this did.
   */
  state: "published" | "retained" | "fetchable"
}>

/** git-super's retention namespace: one ref per object, named by it, create-only, never advanced. */
export function retentionRef(sha: string): string {
  return `refs/git-super/pins/${sha}`
}

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
const ZERO_SHA = /^0+$/u

/**
 * Publish every gitlink `to` moved against `from`, nested paths included, to
 * its submodule's remote under git-super's retention ref (24454).
 *
 * A submodule change lands as an ordinary submit of the root: the author
 * commits inside the submodule, bumps the gitlink, and submits the root. The
 * queue judges the whole tree and, after every check has passed, moves the
 * submodule main itself. For that the queue must be able to FETCH the pin
 * from the submodule's remote, and a commit made in a bay is nowhere else,
 * so submit puts it there first, on a ref that advances no branch: the
 * retention ref is named by the object, written create-only, and an identical
 * value already there is the one write it accepts again (a retry). Nothing
 * about a submodule main moves here; that is the queue's, at merge.
 *
 * The pin has to be in the submitter's own submodule checkout, because that is
 * the only store that holds it; a checkout that lacks it refuses the submit
 * and says which commit and which checkout, before anything is pushed.
 */
export async function publishMovedGitlinks(
  git: Git,
  root: string,
  from: string,
  to: string,
  prefix = "",
): Promise<readonly PublishedGitlink[]> {
  const published: PublishedGitlink[] = []
  for (const row of await gitlinkRows(git, from, to)) {
    if (row.newMode !== "160000" || ZERO_SHA.test(row.sha)) continue
    const path = prefix === "" ? row.path : `${prefix}/${row.path}`
    const checkout = join(root, row.path)
    const child = gitIn(checkout)
    const remote = (await child(["remote", "get-url", "origin"])).trim()
    // Where the pin is: this checkout, else the remote under some ref (a branch
    // somebody pushed by hand; the queue fetches by sha, so ask the same way),
    // else nowhere, which is a refusal before anything is pushed.
    let fetchedFromRemote = false
    try {
      await child(["cat-file", "-e", `${row.sha}^{commit}`])
    } catch {
      // catch-cause-allow: absence IS the answer here, not a failure. This
      // `cat-file -e` asks "does this checkout already hold the pin?", and the
      // error it throws on a miss carries nothing a caller could act on — the
      // next line goes and fetches it. Nothing is swallowed: if the fetch ALSO
      // fails, the inner catch below rethrows with `{ cause }` and the message
      // names the checkout, the remote and the sha.
      try {
        await child([
          "fetch",
          "--quiet",
          "--no-tags",
          "--no-recurse-submodules",
          "--no-write-fetch-head",
          "origin",
          row.sha,
        ])
        fetchedFromRemote = true
      } catch (cause) {
        throw new Error(
          `${path} at ${row.sha} is a gitlink this change moved to a commit neither ${checkout} nor ${remote} holds; ` +
            "commit it in that checkout (or check the submodule out at it) so submit can publish it, then resubmit",
          { cause },
        )
      }
    }
    const ref = retentionRef(row.sha)
    const listed = (await child(["ls-remote", "--refs", "origin", ref])).trim().split(/\s+/u)[0] ?? ""
    if (listed === row.sha) {
      published.push({ path, sha: row.sha, remote, ref, state: "retained" })
    } else if (listed !== "") {
      throw new Error(
        `${remote} ${ref} names ${listed}, not ${row.sha}: a retention ref is named by its object and never moves; ` +
          "repair that ref at the submodule remote before resubmitting",
      )
    } else if (fetchedFromRemote) {
      published.push({ path, sha: row.sha, remote, ref, state: "fetchable" })
    } else {
      await child(["push", "--quiet", `--force-with-lease=${ref}:${ABSENT}`, "origin", `${row.sha}:${ref}`])
      published.push({ path, sha: row.sha, remote, ref, state: "published" })
    }
    // A moved submodule may itself have moved a gitlink: the nested pin has to
    // be fetchable too, from ITS remote, or the queue cannot materialize km.
    const before = row.oldMode === "160000" ? (await git(["rev-parse", `${from}:${row.path}`])).trim() : EMPTY_TREE
    published.push(...(await publishMovedGitlinks(child, checkout, before, row.sha, path)))
  }
  return published
}

/**
 * The target is not a change. Thrown at the one path in, and by the CLI's
 * dry run before it says what it would open: a preview that accepts what
 * the action refuses is the reverse of the flag's purpose (2026-09-03).
 */
export function refuseTarget(branch: string, target: string): void {
  if (branch === target) {
    throw new Error(`${target} is the target, not a change; a change is a branch submitted to be merged into ${target}`)
  }
}

export type SubmitInspection = Readonly<{ head: string; targetHead: string; base: string; rebaseRequired: boolean }>

/** The bound on a courtesy check: this observation cannot reserve the target. */
export function freshnessLine(targetHead: string): string {
  return `freshness checked at ${targetHead}; the queue revalidates at merge`
}

/** The same read-only admission checks serve the action and its preview. */
export async function inspectSubmit(git: Git, remote: string, request: SubmitRequest): Promise<SubmitInspection> {
  refuseTarget(request.branch, request.target.branch)
  // This is the early courtesy refusal. The run is the enforcement point: a
  // pause that races this read may let the change open, but it cannot let it
  // be checked or merged while the pause stands.
  await requireResumed(git, remote, request.target.branch)
  const head = (await git(["rev-parse", "--verify", `refs/heads/${request.branch}^{commit}`])).trim()
  const targetHead = await readRemoteCommit(git, request.target.remote, `refs/heads/${request.target.branch}`)
  if (targetHead === undefined) throw new Error(`${targetName(request.target)} has no advertised target branch`)
  const bound = freshnessLine(targetHead)
  if (await isAncestor(git, head, targetHead)) {
    throw new Error(
      `nothing new to submit: ${targetName(request.target)} at ${targetHead} already contains ${request.branch} at ${head}; ${bound}`,
    )
  }
  const base = await mergeBase(git, head, targetHead)
  if (base === undefined) {
    throw new Error(
      `${request.branch} at ${head} has no common base with ${targetName(request.target)}; found no merge base, expected ${targetHead}. Start a change from that target; ${bound}`,
    )
  }
  const rebaseRequired = !(await isAncestor(git, targetHead, head))
  if (rebaseRequired && request.rebase !== true) {
    throw new Error(
      `${request.branch} is stale: found merge base ${base}, expected ${targetName(request.target)} at ${targetHead}. Rebase onto that target and retry, or check out this branch and use yrd submit --rebase; ${bound}`,
    )
  }
  if (request.rebase === true) await requireRebaseWorktree(git, request.branch, bound)
  await refuseDivergedMovedPins(git, targetHead, head, request.branch)
  return { head, targetHead, base, rebaseRequired }
}

/**
 * 24463: a moved gitlink that has diverged from that component's current
 * `refs/heads/main` will fail at merge as gitlink-off-main. Refuse at submit
 * instead, naming the merge-and-pin cure, before a queue cycle.
 *
 * Equal, behind (pin ancestor of main), and ahead (main ancestor of pin) pass:
 * the queue can settle or publish those. Diverged cannot.
 */
export async function refuseDivergedMovedPins(git: Git, from: string, to: string, branch: string): Promise<void> {
  const root = (await git(["rev-parse", "--show-toplevel"])).trim()
  for (const row of await gitlinkRows(git, from, to)) {
    if (row.newMode !== "160000" || ZERO_SHA.test(row.sha)) continue
    const child = gitIn(join(root, row.path))
    const componentMain = await readRemoteCommit(child, "origin", "refs/heads/main")
    if (componentMain === undefined) {
      throw new Error(
        `${row.path} origin has no refs/heads/main; cannot check pin ${row.sha} against component main`,
      )
    }
    try {
      await child(["cat-file", "-e", `${row.sha}^{commit}`])
    } catch {
      // Missing object: 24454 publishMovedGitlinks names the checkout and remote.
      continue
    }
    if ((await isAncestor(child, row.sha, componentMain)) || (await isAncestor(child, componentMain, row.sha))) {
      continue
    }
    throw new Error(
      `${row.path} pin ${row.sha} has diverged from refs/heads/main at ${componentMain}. ` +
        `Merge ${row.path}'s current main into ${branch}, pin the merge commit, and resubmit.`,
    )
  }
}

async function requireRebaseWorktree(git: Git, branch: string, bound: string): Promise<void> {
  const checkedOut = (await git(["branch", "--show-current"])).trim()
  if (checkedOut !== branch) {
    throw new Error(
      `--rebase needs ${branch} checked out here; found ${checkedOut === "" ? "detached HEAD" : checkedOut}. Check out ${branch} and retry; ${bound}`,
    )
  }
  const gitdir = (await git(["rev-parse", "--absolute-git-dir"])).trim()
  const entries = await readdir(gitdir)
  const operation = entries.find((name) =>
    [
      "rebase-merge",
      "rebase-apply",
      "sequencer",
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "BISECT_LOG",
    ].includes(name),
  )
  if (operation !== undefined) {
    throw new Error(
      `--rebase refused: ${operation} in ${gitdir} marks an active Git operation; finish it before retrying; ${bound}`,
    )
  }
  const dirty = (await git(["status", "--porcelain=v1", "--untracked-files=all"])).trim()
  if (dirty !== "") {
    throw new Error(
      `--rebase needs a clean worktree and index, including untracked files; commit or move this work before retrying; ${bound}:\n${dirty}`,
    )
  }
}

export async function submit(git: Git, remote: string, request: SubmitRequest): Promise<Submitted> {
  const inspected = await inspectSubmit(git, remote, request)
  const { targetHead } = inspected
  let head = inspected.head
  if (inspected.rebaseRequired) {
    try {
      await git(["rebase", "--no-autostash", "--no-update-refs", targetHead])
    } catch (cause) {
      throw new Error(
        `rebase of ${request.branch} onto ${targetHead} stopped; no change was opened. Inspect Git's error and status; resolve conflicts and run git rebase --continue, then rerun yrd submit. ${String(cause)}`,
        { cause },
      )
    }
    head = (await git(["rev-parse", "--verify", `refs/heads/${request.branch}^{commit}`])).trim()
    if (!(await isAncestor(git, targetHead, head))) {
      throw new Error(
        `rebase left ${request.branch} at ${head} without captured target ${targetHead}; no change was opened`,
      )
    }
    if (head === targetHead) {
      throw new Error(
        `nothing new to submit after rebase: ${targetName(request.target)} at ${targetHead} already contains this change; ${freshnessLine(targetHead)}`,
      )
    }
  }
  // 24454: every gitlink this head moved is fetchable from its submodule
  // remote before the change exists, or the submit refuses with the commit and
  // checkout named. A refused publication opens nothing.
  const root = (await git(["rev-parse", "--show-toplevel"])).trim()
  const published = await publishMovedGitlinks(git, root, targetHead, head)
  // 24463 row 5: re-measure immediately before the push; a verdict is void
  // the moment component main moves.
  await refuseDivergedMovedPins(git, targetHead, head, request.branch)
  const change = { branch: request.branch, head }
  const ref = changeRef(request.target.branch, change)
  // Where the remote holds the branch and this change right now, in one
  // reading: a retry appends to the remote's history of the change, so that
  // history is fetched first, and the branch's lease is the remote's own value,
  // never a tracking ref that may be stale or missing in a fresh clone.
  // ls-remote answers "absent" as an empty list, never as an error, which is
  // the one honest empty a submit is allowed to swallow.
  const at = new Map(
    (await git(["ls-remote", "--refs", remote, `refs/heads/${request.branch}`, ref]))
      .split("\n")
      .map((row) => row.trim().split(/\s+/u))
      .map(([sha, name]) => [name ?? "", sha ?? ""] as const),
  )
  const remoteTip = at.get(ref) ?? ""
  const remoteBranch = at.get(`refs/heads/${request.branch}`) ?? ""
  const retry = remoteTip !== ""
  if (retry) await git(["fetch", "--quiet", remote, `+${ref}:${ref}`])
  // A local change ref the remote does not hold is an orphan of a refused
  // push; submit is the only writer of these refs, so it goes.
  else if ((await refAt(git, ref)) !== undefined) await git(["update-ref", "-d", ref])
  const issue = await issueOf(git, request.branch, head, request.issue)
  const trailers: (readonly [string, string])[] = [["Submitter", request.submitter]]
  if (issue !== undefined) trailers.push(["Issue", issue])
  const opened = await appendRecord(git, request.target.branch, {
    change,
    kind: "opened",
    subject: `${request.submitter} submitted ${request.branch} to ${targetName(request.target)}`,
    trailers,
  })
  // Two explicit leases make the push the same compare-and-swap the local
  // append is: each ref must still be where this submitter just read it (the
  // zero sha means "absent"), or the whole push refuses and nothing merges —
  // and then the local change ref goes back to what the remote holds, so a
  // refused submit leaves no opened record for the next one to chain onto.
  try {
    await git([
      "push",
      "--quiet",
      "--atomic",
      `--force-with-lease=refs/heads/${request.branch}:${remoteBranch === "" ? ABSENT : remoteBranch}`,
      `--force-with-lease=${ref}:${retry ? remoteTip : ABSENT}`,
      remote,
      `${head}:refs/heads/${request.branch}`,
      `${ref}:${ref}`,
    ])
  } catch (error) {
    await git(retry ? ["update-ref", ref, remoteTip] : ["update-ref", "-d", ref])
    throw error
  }
  return { branch: request.branch, head, targetHead, opened, retry, published }
}

/**
 * The issue a change is for (ruling C4): the one declared on submit, else
 * the head commit's `Resolves:` or `Refs:` trailer, else the leading
 * `<issue>-` segment of the branch name's last component, the convention
 * (§ The change). None of those, and the change has no issue.
 */
export async function issueOf(git: Git, branch: string, head: string, declared?: string): Promise<string | undefined> {
  if (declared !== undefined) return declared
  const fromTrailer = (
    await git(["log", "-1", "--format=%(trailers:key=Resolves,key=Refs,valueonly,separator=%x00)", head])
  )
    .split("\0")
    .map((value) => value.trim())
    .find((value) => value !== "")
  if (fromTrailer !== undefined) return fromTrailer
  return /^(\d+)-/u.exec(branch.split("/").at(-1) ?? "")?.[1]
}
