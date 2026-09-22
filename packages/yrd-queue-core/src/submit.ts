/**
 * `yrd queue submit <branch>`: the one path in
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design, The change).
 *
 * One atomic push of the branch and of its change's opened record. Either both
 * arrive at the remote or neither does, so a reader never sees a submitted
 * branch without its change or a change without its branch. A submit at an
 * unchanged head appends a new opened record to the existing change: that is a
 * retry, and the change keeps its place in line from its first opened record.
 * Verification composes the submitted head with the observed target without
 * rewriting that head. A lease keeps the branch push from clobbering a remote
 * head the submitter never saw.
 *
 * A stopped line still takes work (the andon, operator 2026-09-16): a pause —
 * a person's or a stuck change's — stops checking and merging, never
 * submission. Nothing here needs a running or unpaused queue: submit runs no
 * check (`on: submit` checks run in the queue run's judge step), and every
 * write it makes is to the branch, its change ref and the submodule retention
 * refs, never to the pause ref. So the stop is read only to be echoed, through
 * the same derivation every other reader uses.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listRefs, openEvents } from "gitomic/events"
import { targetName, type Target } from "./config.ts"
import { ABSENT, appendRecord } from "./legacy-records.ts"
import { gitIn, gitlinkRows, isAncestor, mergeBase, readRemoteCommit, refAt, type Git } from "./git.ts"
import { changeRef } from "./refs.ts"
import type { PauseRecord } from "./pause.ts"
import { readStop, remoteUrl } from "./remote.ts"
import { changeInput, changesRef, decide, eventPause, evolve, initial, queueFormat, readEventQueue } from "./events.ts"
import { verifyCandidate, type Verification } from "./verifying.ts"

export type SubmitRequest = Readonly<{
  /** The branch being submitted: the change's own. */
  branch: string
  /** The queue's target: the branch it merges on, at the remote holding it. */
  target: Target
  submitter: string
  issue?: string
}>

export type IssueResolution = Readonly<{
  issue: string
  source: "binding" | "declared" | "legacy-branch"
  /** The first explicit binding's carrying commit, when source is binding. */
  commit?: string
}>

export type Submitted = Readonly<{
  branch: string
  head: string
  /** The target commit observed during preflight; the queue checks again at merge. */
  targetHead: string
  /** The opened event or legacy record's sha. */
  opened: string
  /** True when this branch already had an open change at this head, so this was a retry. */
  retry: boolean
  /** Gitlinks this change moved whose commits submit published to their submodule remotes (24454). */
  published: readonly PublishedGitlink[]
  verifying: Verification
  issue?: IssueResolution
  /** The stop the line stood under when this was accepted: the change waits behind it. */
  stop?: PauseRecord
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
    // The DECLARED submodule url is what the record names; the transport rewrite is the host's.
    const remote = await remoteUrl(child, "origin")
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

export type SubmitInspection = Readonly<{
  head: string
  targetHead: string
  base: string
  verifying: Verification
  issue?: IssueResolution
  /** The stop the line stands under, echoed and never refused on. */
  stop?: PauseRecord
}>

/** The bound on a courtesy check: this observation cannot reserve the target. */
export function freshnessLine(targetHead: string): string {
  return `freshness checked at ${targetHead}; the queue revalidates at merge`
}

/** The same read-only admission checks serve the action and its preview. */
export async function inspectSubmit(git: Git, remote: string, request: SubmitRequest): Promise<SubmitInspection> {
  refuseTarget(request.branch, request.target.branch)
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
  const issue = await issueOf(git, request.branch, head, targetHead, request.issue)
  // The line's stop, read to be ECHOED: a stopped line accepts the change and
  // the run is where the stop is enforced. Issue conflicts are settled before
  // repository composition starts; every other refusal below still carries
  // this captured stop.
  const root = (await git(["rev-parse", "--show-toplevel"])).trim()
  const store = { repo: root, remote }
  const stop =
    (await queueFormat(store, request.target.branch)) === "event"
      ? eventPause(await readEventQueue(store, request.target.branch))
      : (await readStop(git, remote, request.target.branch, targetHead)).stop
  const scratch = mkdtempSync(join(tmpdir(), "yrd-submit-verifying-"))
  const hooksPath = join(scratch, "hooks-disabled")
  mkdirSync(hooksPath)
  let verifying: Verification
  try {
    const composed = await verifyCandidate({
      git,
      repo: root,
      targetHead,
      head,
      path: join(scratch, "candidate"),
      message: `verify ${request.branch} at ${head} against ${targetHead}`,
      hooksPath,
    })
    verifying = composed.verifying
    if (composed.state === "failed") {
      await composed.failedWorktree.remove()
      throw new Error(
        `${request.branch} at ${head} cannot be composed with ${targetName(request.target)} at ${targetHead}: ` +
          `${composed.verifying.detail.code}: ${composed.verifying.detail.message}; ${bound}`,
      )
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  return {
    head,
    targetHead,
    base,
    verifying,
    ...(issue === undefined ? {} : { issue }),
    ...(stop === undefined ? {} : { stop }),
  }
}

export async function submit(git: Git, remote: string, request: SubmitRequest): Promise<Submitted> {
  const inspected = await inspectSubmit(git, remote, request)
  const root = (await git(["rev-parse", "--show-toplevel"])).trim()
  if ((await queueFormat({ repo: root, remote }, request.target.branch)) === "event") {
    return submitEvent(git, remote, request, root, inspected)
  }
  return submitLegacy(git, remote, request, inspected)
}

async function submitEvent(
  git: Git,
  remote: string,
  request: SubmitRequest,
  root: string,
  inspected: SubmitInspection,
): Promise<Submitted> {
  const head = inspected.head
  const published = await publishMovedGitlinks(git, root, inspected.targetHead, head)
  const store = { repo: root, remote }
  const queue = await readEventQueue(store, request.target.branch)
  const ref = changesRef(request.target.branch, request.branch)
  const branchRef = `refs/heads/${request.branch}`
  const branchAt = (await listRefs(branchRef, store)).get(branchRef) ?? null
  const input = changeInput("opened", {
    queueTip: queue.tip,
    at: new Date(),
    commit: head,
    by: request.submitter,
    ...(inspected.issue === undefined ? {} : { issue: inspected.issue.issue }),
    title: `${request.submitter} submitted ${request.branch} to ${targetName(request.target)}`,
  })
  const chain = await openEvents({ ...store, ref, writer: request.submitter })
  let retry = false
  let retryOpened: string | undefined
  // The opened event keeps `head`; publishing the branch beside it is for the
  // branch ref's meaning, not for object reachability. Gitomic moves both in
  // one atomic publish and refuses a branch lease that went stale.
  const result = await chain.transact(
    (events) => {
      const current = events.reduce(evolve, initial)
      retry =
        current.commit === head &&
        (current.status === "queued" ||
          current.status === "verifying" ||
          current.status === "checking" ||
          current.status === "merging" ||
          current.status === "stuck")
      if (retry) {
        retryOpened = events.findLast((event) => event.type === "opened")?.id
        return []
      }
      return decide(events, input)
    },
    `submit ${request.branch}`,
    { also: [{ ref: branchRef, expect: branchAt, oid: head }] },
  )
  const opened = retryOpened ?? result.events.findLast((event) => event.type === "opened")?.id
  if (opened === undefined) throw new Error(`${ref} in ${root}: submit published no opened event`)
  return {
    branch: request.branch,
    head,
    targetHead: inspected.targetHead,
    opened,
    retry,
    published,
    verifying: inspected.verifying,
    ...(inspected.issue === undefined ? {} : { issue: inspected.issue }),
    ...(inspected.stop === undefined ? {} : { stop: inspected.stop }),
  }
}

async function submitLegacy(
  git: Git,
  remote: string,
  request: SubmitRequest,
  inspected: SubmitInspection,
): Promise<Submitted> {
  const { targetHead } = inspected
  const head = inspected.head
  const issue = inspected.issue
  // 24454: every gitlink this head moved is fetchable from its submodule
  // remote before the change exists, or the submit refuses with the commit and
  // checkout named. A refused publication opens nothing.
  const root = (await git(["rev-parse", "--show-toplevel"])).trim()
  const published = await publishMovedGitlinks(git, root, targetHead, head)
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
  const trailers: (readonly [string, string])[] = [["Submitter", request.submitter]]
  if (issue !== undefined) trailers.push(["Issue", issue.issue])
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
  return {
    branch: request.branch,
    head,
    targetHead,
    opened,
    retry,
    published,
    verifying: inspected.verifying,
    ...(issue === undefined ? {} : { issue }),
    ...(inspected.stop === undefined ? {} : { stop: inspected.stop }),
  }
}

/**
 * The first explicit Refs/Resolves binding in branch history wins. The
 * merge-base and all target ancestry are excluded; neither later work nor a
 * branch rename loses the binding. Conflicting explicit/declared issues refuse.
 * An unbound branch may use a declaration or the reported legacy name fallback.
 */
export async function issueOf(
  git: Git,
  branch: string,
  head: string,
  targetHead: string,
  declared?: string,
): Promise<IssueResolution | undefined> {
  if (
    declared !== undefined &&
    (declared.trim() === "" || declared !== declared.trim() || /[\u0000-\u001f\u007f]/u.test(declared))
  ) {
    throw new Error(
      `issue for ${branch} must be a nonempty single-line value without surrounding whitespace or control characters`,
    )
  }
  let history: string
  try {
    const base = await mergeBase(git, head, targetHead)
    if (base === undefined) throw new Error("no merge base")
    // NUL separates each commit and its trailer block. Git supplies trailer
    // parsing; record separators distinguish values within that block.
    history = await git([
      "log",
      "--reverse",
      "--topo-order",
      "-z",
      "--format=%H%x00%(trailers:key=Resolves,key=Refs,valueonly,separator=%x1e)",
      `${base}..${head}`,
      `^${targetHead}`,
      "--",
    ])
  } catch (cause) {
    throw new Error(
      `cannot read issue binding for ${branch} at ${head} against target ${targetHead}: ${String(cause)}`,
      { cause },
    )
  }
  let binding: IssueResolution | undefined
  const records = history.split("\0")
  if (records.pop() !== "") {
    throw new Error(`incomplete issue binding history for ${branch} at ${head} against target ${targetHead}`)
  }
  for (let index = 0; index < records.length; index += 2) {
    const commit = records[index]
    const values = records[index + 1]
    if (commit === undefined || values === undefined) {
      throw new Error(`incomplete issue binding history for ${branch} at ${head} against target ${targetHead}`)
    }
    for (const value of values.split("\u001e")) {
      const issue = value.trim()
      if (issue === "") continue
      if (/[\u0000-\u001f\u007f]/u.test(issue)) {
        throw new Error(
          `invalid issue binding in ${branch} at ${commit}: expected a single-line value without control characters`,
        )
      }
      if (binding === undefined) binding = { issue, source: "binding", commit }
      else if (binding.issue !== issue) {
        throw new Error(
          `conflicting issue bindings for ${branch}: ${binding.issue} at ${binding.commit}; ${issue} at ${commit}`,
        )
      }
    }
  }
  if (binding !== undefined) {
    if (declared !== undefined && declared !== binding.issue) {
      throw new Error(
        `declared issue ${declared} conflicts with ${binding.issue} bound at ${binding.commit} on ${branch}`,
      )
    }
    return binding
  }
  if (declared !== undefined) return { issue: declared, source: "declared" }
  const legacy = /^(\d+)-/u.exec(branch.split("/").at(-1) ?? "")?.[1]
  return legacy === undefined ? undefined : { issue: legacy, source: "legacy-branch" }
}
