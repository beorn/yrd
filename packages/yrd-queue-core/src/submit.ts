/**
 * `yrd queue submit <branch>`: the one path in
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design, The change).
 *
 * One atomic push of the branch and of its change's opened record. Either both
 * arrive at the remote or neither does, so a reader never sees a submitted
 * branch without its change or a change without its branch. A submit at an
 * unchanged open head is a retry, and the change keeps its place in line from
 * its first opened record. A head already merging or merged is refused.
 * Verification composes the submitted head with the observed target without
 * rewriting that head. A lease keeps the branch push from clobbering a remote
 * head the submitter never saw.
 *
 * Operator and stuck stops still take work (the andon, operator 2026-09-16):
 * they stop checking and merging while submits wait in line. A maintenance
 * stop fences intake during migration. Submit runs no check (`on: submit`
 * checks run in the queue run's judge step). The stop comes from the same
 * derivation every reader uses. An atomic lease of the pause ref (legacy) or
 * queue event tip (event format) prevents a stop racing with publication.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ABSENT,
  Conflict,
  RetriesExhausted,
  createEventStore,
  listRefs,
  openEvents,
  selectionFor,
  type Event,
} from "./git.ts"
import { readEventChain } from "./event-read.ts"
import { readConfig, targetName, type Target } from "./config.ts"
import { gitIn, gitlinkRows, isAncestor, mergeBase, mergeBases, readRemoteCommit, type Git } from "./git.ts"
import { type PauseRecord } from "./pause.ts"
import { remoteUrl } from "./remote.ts"
import {
  changeInput,
  changesRef,
  createEventQueue,
  decide,
  initial,
  project,
  queueFormat,
  queueRef,
  readEventOps,
  readEventOpsWithRefs,
} from "./events.ts"
import { classifyQueueRef, pauseRef, queueRefPrefix } from "./refs.ts"
import { verifyCandidate, type Verification } from "./verifying.ts"
import { withRemoteSeam } from "./remote-calls.ts"

export type SubmitRequest = Readonly<{
  /** The branch being submitted: the change's own. */
  branch: string
  /** The queue's target: the branch it merges on, at the remote holding it. */
  target: Target
  /** Target declaration commit captured by the CLI; admission must not run newer code with older policy. */
  expectedTargetHead?: string
  submitter: string
  issue?: string
  /** Host-owned issue identity. A configured resolver must either return one canonical issue or throw. */
  resolveIssue?: IssueResolver
  /** Target-owned process policy. The host runs it; core only interprets its verdict. */
  admit?: (issue: string, branch: string, head: string, targetHead: string) => Promise<AdmissionVerdict>
}>

export type AdmissionVerdict = Readonly<
  | { kind: "admit" }
  | { kind: "refuse"; reason: string }
  | { kind: "warn"; reason: string }
  | { kind: "cannot-judge"; reason: string }
>
export type AdmissionOutcome = Readonly<
  | { kind: "skipped"; reason: string }
  | { kind: "admitted" }
  | { kind: "warn"; reason: string }
  | { kind: "cannot-judge"; reason: string }
>

export type IssueResolver = (raw: string) => Promise<string>

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
  admission: AdmissionOutcome
  /** Present only when this submit appended a new warning event; its caller sends one notification. */
  admissionWarning?: Readonly<{ event: string; reason: string; at: string }>
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
  from: string | readonly string[],
  to: string,
  prefix = "",
): Promise<readonly PublishedGitlink[]> {
  const published: PublishedGitlink[] = []
  const bases = typeof from === "string" ? [from] : from
  if (bases.length === 0) throw new Error(`cannot publish gitlinks in ${root}: no merge base`)
  const spans = await Promise.all(bases.map((base) => gitlinkRows(git, base, to)))
  const byBase = spans.map((rows) => new Map(rows.map((row) => [row.path, row])))
  for (const row of spans[0] ?? []) {
    // In criss-cross history a pin is branch-authored only if it differs
    // from every best common ancestor, not just Git's first merge base.
    if (!byBase.every((rows) => rows.has(row.path))) continue
    if (row.newMode !== "160000" || ZERO_SHA.test(row.sha)) continue
    const path = prefix === "" ? row.path : `${prefix}/${row.path}`
    const checkout = join(root, row.path)
    const child = gitIn(checkout, undefined, selectionFor(git))
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
    // By name: `ls-remote origin <ref>` carries the whole advertisement to filter it here (25570).
    const listed = (await readRemoteCommit(child, "origin", ref)) ?? ""
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
      try {
        await child(["push", "--quiet", `--force-with-lease=${ref}:${ABSENT}`, "origin", `${row.sha}:${ref}`])
      } catch (cause) {
        throw new Error(`could not publish ${path}@${row.sha} to ${remote} ${ref}`, { cause })
      }
      published.push({ path, sha: row.sha, remote, ref, state: "published" })
    }
    // A moved submodule may itself have moved a gitlink: the nested pin has to
    // be fetchable too, from ITS remote, or the queue cannot materialize km.
    const before = await Promise.all(
      bases.map(async (base, index) =>
        byBase[index]?.get(row.path)?.oldMode === "160000"
          ? (await git(["rev-parse", `${base}:${row.path}`])).trim()
          : EMPTY_TREE,
      ),
    )
    published.push(...(await publishMovedGitlinks(child, checkout, before, row.sha, path)))
  }
  return published
}

/**
 * In candidate verification (and especially dry-run mode where gitlinks are not published
 * to remote retention refs), candidate worktrees borrow from the superproject reference.
 * When the reference was a linked worktree, git-super resolves the reference to the primary
 * clone, which lacks the author's fresh local component commits.
 *
 * This models the publish by fetching moved gitlinks directly from the author's local
 * component checkouts into the candidate worktree's submodule checkouts under refs/git-super/pins/<sha>.
 */
export async function modelMovedGitlinks(
  git: Git,
  sourceRoot: string,
  from: string | readonly string[],
  to: string,
  candidateRoot: string,
  prefix = "",
): Promise<void> {
  const bases = typeof from === "string" ? [from] : from
  if (bases.length === 0) return
  const spans = await Promise.all(bases.map((base) => gitlinkRows(git, base, to)))
  const byBase = spans.map((rows) => new Map(rows.map((row) => [row.path, row])))
  for (const row of spans[0] ?? []) {
    if (!byBase.every((rows) => rows.has(row.path))) continue
    if (row.newMode !== "160000" || ZERO_SHA.test(row.sha)) continue
    const path = prefix === "" ? row.path : `${prefix}/${row.path}`
    const sourceCheckout = join(sourceRoot, row.path)
    const targetCheckout = join(candidateRoot, row.path)
    if (!existsSync(sourceCheckout) || !existsSync(targetCheckout)) continue
    const sourceChild = gitIn(sourceCheckout, undefined, selectionFor(git))
    const targetChild = gitIn(targetCheckout, undefined, selectionFor(git))
    let targetHasSha = false
    try {
      await targetChild(["cat-file", "-e", `${row.sha}^{commit}`])
      targetHasSha = true
    } catch {
      // silent-fallback-allow: absence in candidate checkout triggers local resolution from author checkout
      // catch-cause-allow: absence in candidate checkout triggers local resolution from author checkout
    }
    if (!targetHasSha) {
      const remote = await remoteUrl(sourceChild, "origin")
      let hasSha = false
      try {
        await sourceChild(["cat-file", "-e", `${row.sha}^{commit}`])
        hasSha = true
      } catch {
        // catch-cause-allow: absence in source checkout falls back to fetching from remote origin
        try {
          await sourceChild([
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-recurse-submodules",
            "--no-write-fetch-head",
            "origin",
            row.sha,
          ])
          hasSha = true
        } catch (cause) {
          throw new Error(
            `${path} at ${row.sha} is a gitlink this change moved to a commit neither ${sourceCheckout} nor ${remote} holds; ` +
              "commit it in that checkout (or check the submodule out at it) so submit can publish it, then resubmit",
            { cause },
          )
        }
      }
      if (hasSha) {
        try {
          await targetChild([
            "-c",
            "protocol.file.allow=always",
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-recurse-submodules",
            "--no-write-fetch-head",
            sourceCheckout,
            `${row.sha}:refs/git-super/pins/${row.sha}`,
          ])
        } catch (cause) {
          throw new Error(`could not resolve local component commit ${row.sha} for ${path} from ${sourceCheckout}`, {
            cause,
          })
        }
      }
    }
    const before = await Promise.all(
      bases.map(async (base, index) =>
        byBase[index]?.get(row.path)?.oldMode === "160000"
          ? (await git(["rev-parse", `${base}:${row.path}`])).trim()
          : EMPTY_TREE,
      ),
    )
    await modelMovedGitlinks(sourceChild, sourceCheckout, before, row.sha, targetCheckout, path)
  }
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
  admission: AdmissionOutcome
  /** An operator or stuck stop is echoed; maintenance refuses intake. */
  stop?: PauseRecord
}>

type SubmitOps = Awaited<ReturnType<typeof readEventOpsWithRefs>>
type SubmitAdmission = Readonly<
  Omit<SubmitInspection, "verifying"> & { root: string; bases: readonly string[]; operational: SubmitOps }
>

export function refuseMaintenance(
  stop: PauseRecord | undefined,
  remote: string,
  queue: string,
  published: readonly PublishedGitlink[] = [],
): void {
  if (stop?.cause !== "maintenance") return
  const childPins = published.filter((row) => row.state === "published")
  throw new Error(
    `submission stopped for maintenance on ${remote}#${queue}: ${stop.reason}; ` +
      `set by ${stop.by} at ${stop.at.toISOString()}; submit after resume` +
      (childPins.length === 0
        ? ""
        : `; root refs were not published, but child retention refs remain: ${childPins.map((row) => `${row.path} ${row.ref}`).join(", ")}`),
  )
}

/** The bound on a courtesy check: this observation cannot reserve the target. */
export function freshnessLine(targetHead: string): string {
  return `freshness checked at ${targetHead}; the queue revalidates at merge`
}

/** A terminal or landing chain refuses inside the submit transaction, with the merge it names. */
function refuseMergedSubmit(events: readonly Event[], ref: string, root: string, branch: string, head: string): void {
  if (events.length === 0) return
  const current = project(events, ref, root)
  if (current.status === "merging") {
    throw new Error(
      `landing in progress; resubmit after merged/failed/stuck, resume if runner gone: ` +
        `${branch}@${head} collides with the merge of ${branch}@${current.commit ?? "unknown head"} ` +
        `at ${current.candidate ?? "unknown candidate"} (event ${current.tip ?? "unknown"}); ` +
        `retry after the merge of ${branch}@${current.commit ?? "unknown head"} ends`,
    )
  }
  if (current.status === "merged" && current.commit === head) {
    const ending = events.findLast((event) => event.id === current.ending?.id)
    throw new Error(
      `${branch}@${head} already merged at ${ending?.links[0] ?? "unknown root"} ` +
        `(event ${current.ending?.id ?? "unknown"}); push a new head or nothing`,
    )
  }
}

/** The same read-only admission checks serve the action and its preview. */
export async function inspectSubmit(git: Git, remote: string, request: SubmitRequest): Promise<SubmitInspection> {
  refuseTarget(request.branch, request.target.branch)
  const head = (await git(["rev-parse", "--verify", `refs/heads/${request.branch}^{commit}`])).trim()
  return inspectSubmitAtHead(git, remote, request, head)
}

/** Admission for a generated carrier before any local branch ref is written. */
export async function inspectSubmitAtHead(
  git: Git,
  remote: string,
  request: SubmitRequest,
  head: string,
): Promise<SubmitInspection> {
  const admitted = await admitSubmitAtHead(git, remote, request, head)
  const verifying = await composeSubmit(git, request, admitted)
  const { root: _root, bases: _bases, operational: _operational, ...inspection } = admitted
  return { ...inspection, verifying }
}

async function admitSubmitAtHead(
  git: Git,
  remote: string,
  request: SubmitRequest,
  head: string,
): Promise<SubmitAdmission> {
  refuseTarget(request.branch, request.target.branch)
  const targetHead = await readRemoteCommit(git, request.target.remote, `refs/heads/${request.target.branch}`)
  if (targetHead === undefined) throw new Error(`${targetName(request.target)} has no advertised target branch`)
  if (
    request.admit !== undefined &&
    request.expectedTargetHead !== undefined &&
    request.expectedTargetHead !== targetHead
  ) {
    throw new Error(
      `${targetName(request.target)} moved from declared ${request.expectedTargetHead} to ${targetHead} before admission; rerun submit to read its current .yrd.yml`,
    )
  }
  const bound = freshnessLine(targetHead)
  if (await isAncestor(git, head, targetHead)) {
    // The target may have advanced past this branch's exact landing. Consult
    // its retained event chain so the refusal names the merge and the cure.
    const root = (await git(["rev-parse", "--show-toplevel"])).trim()
    const store = createEventStore(root, remote, selectionFor(git))
    if ((await queueFormat(store, request.target.branch)) === "event") {
      const ref = changesRef(request.target.branch, request.branch)
      const chain = await openEvents({ ...store, ref })
      if ((await chain.head()) !== null) {
        refuseMergedSubmit(await readEventChain(chain), ref, root, request.branch, head)
      }
    }
    throw new Error(
      `nothing new to submit: ${targetName(request.target)} at ${targetHead} already contains ${request.branch} at ${head}; ${bound}`,
    )
  }
  const bases = await mergeBases(git, head, targetHead)
  const base = bases[0]
  if (base === undefined) {
    throw new Error(
      `${request.branch} at ${head} has no common base with ${targetName(request.target)}; found no merge base, expected ${targetHead}. Start a change from that target; ${bound}`,
    )
  }
  const issue = await issueOf(git, request.branch, head, targetHead, request.issue, request.resolveIssue)
  let admission: AdmissionOutcome
  if (request.admit === undefined) {
    admission = { kind: "skipped", reason: "target declares no admission command" }
  } else {
    const issueValue = issue?.issue ?? ""
    const issueLabel = issue?.issue ?? "unbound issue"
    let verdict: AdmissionVerdict
    try {
      verdict = await request.admit(issueValue, request.branch, head, targetHead)
    } catch (cause) {
      verdict = {
        kind: "cannot-judge",
        reason: `admission for ${issueLabel} threw before a verdict: ${String(cause)}`,
      }
    }
    switch (verdict.kind) {
      case "admit":
        admission = { kind: "admitted" }
        break
      case "refuse":
        throw new Error(`admission refused ${request.branch}@${head} for ${issueLabel}: ${verdict.reason}`)
      case "warn":
      case "cannot-judge":
        admission = verdict
        break
      default: {
        const unreachable: never = verdict
        throw new Error(`unknown admission verdict: ${String(unreachable)}`)
      }
    }
  }
  // Operator and stuck stops are echoed; a maintenance stop refuses intake.
  // Issue conflicts are settled before
  // repository composition starts; every other refusal below still carries
  // this captured stop.
  const root = (await git(["rev-parse", "--show-toplevel"])).trim()
  const store = createEventStore(root, remote, selectionFor(git))
  const queue = request.target.branch
  const format = await queueFormat(store, queue)
  switch (format) {
    case "empty": {
      const config = await readConfig(git, targetHead, request.target)
      if (config === undefined) {
        throw new Error(
          `cannot create event queue ${remote}#${queue}: the pinned commit ${targetHead} has no .yrd.yml; declare checks in .yrd.yml at that commit before creating an event queue`,
        )
      }
      let createError: unknown
      try {
        await createEventQueue(store, queue, targetHead, config, new Date())
      } catch (error) {
        if (!(error instanceof Conflict) && !(error instanceof RetriesExhausted)) throw error
        createError = error
      }
      const again = await queueFormat(store, queue)
      if (again !== "event") {
        const named = createError instanceof Error ? createError.message : String(createError ?? "no create error")
        throw new Error(
          `${remote}#${queue} did not become an event queue after create: classified ${again}; create: ${named}`,
          createError instanceof Error ? { cause: createError } : undefined,
        )
      }
      break
    }
    case "legacy": {
      const refs = await listRefs(queueRefPrefix(queue), store)
      const named = [...refs.keys()].filter((ref) => classifyQueueRef(queue, ref) === "change")
      throw new Error(
        `${remote}#${queue} uses a legacy Record ref ${named[0] ?? "(none listed)"}; expected ${queueRef(queue)}`,
      )
    }
    case "event":
      break
    default: {
      const unreachable: never = format
      throw new Error(`${remote}#${queue} classified ${String(unreachable)}`)
    }
  }
  const operational = await readEventOpsWithRefs(store, git, request.target.branch, targetHead)
  const stop = operational.ops.stop
  refuseMaintenance(stop, remote, request.target.branch)
  return {
    head,
    targetHead,
    base,
    bases,
    root,
    operational,
    ...(issue === undefined ? {} : { issue }),
    admission,
    ...(stop === undefined ? {} : { stop }),
  }
}

async function composeSubmit(git: Git, request: SubmitRequest, admitted: SubmitAdmission): Promise<Verification> {
  const scratch = mkdtempSync(join(tmpdir(), "yrd-submit-verifying-"))
  const hooksPath = join(scratch, "hooks-disabled")
  mkdirSync(hooksPath)
  let verifying: Verification
  try {
    const composed = await verifyCandidate({
      git,
      repo: admitted.root,
      targetHead: admitted.targetHead,
      head: admitted.head,
      path: join(scratch, "candidate"),
      message: `verify ${request.branch} at ${admitted.head} against ${admitted.targetHead}`,
      hooksPath,
      noFetch: true,
      unboundedLocalMain: true,
      beforeMerge: async (candidate) => {
        await modelMovedGitlinks(git, admitted.root, admitted.bases, admitted.head, candidate)
      },
    })
    verifying = composed.verifying
    if (composed.state === "failed") {
      await composed.failedWorktree.remove()
      throw new Error(
        `${request.branch} at ${admitted.head} cannot be composed with ${targetName(request.target)} at ${admitted.targetHead}: ` +
          `${composed.verifying.detail.code}: ${composed.verifying.detail.message}; ${freshnessLine(admitted.targetHead)}`,
      )
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  return verifying
}

export async function submit(git: Git, remote: string, request: SubmitRequest): Promise<Submitted> {
  refuseTarget(request.branch, request.target.branch)
  const head = (await git(["rev-parse", "--verify", `refs/heads/${request.branch}^{commit}`])).trim()
  const admitted = await withRemoteSeam("inspectSubmit", () => admitSubmitAtHead(git, remote, request, head))
  const published = await withRemoteSeam("publishMovedGitlinks", () =>
    publishMovedGitlinks(git, admitted.root, admitted.bases, head),
  )
  const verifying = await withRemoteSeam("composeSubmit", () => composeSubmit(git, request, admitted))
  const { root, bases: _bases, operational, ...inspection } = admitted
  return withRemoteSeam("submitEvent", () =>
    submitEvent(git, remote, request, root, { ...inspection, verifying }, operational, published),
  )
}

async function submitEvent(
  git: Git,
  remote: string,
  request: SubmitRequest,
  root: string,
  inspected: SubmitInspection,
  admittedOps: SubmitOps,
  published: readonly PublishedGitlink[],
): Promise<Submitted> {
  const head = inspected.head
  const store = createEventStore(root, remote, selectionFor(git))
  const ref = changesRef(request.target.branch, request.branch)
  const branchRef = `refs/heads/${request.branch}`
  const chain = await openEvents({ ...store, ref, writer: request.submitter })
  let afterConflict: SubmitOps | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    const refs = attempt === 0 ? await listRefs(queueRefPrefix(request.target.branch), store) : undefined
    // The unchanged tip names the same append-only queue history. A retired
    // pause ref must still refuse; a stop needs its change chain reread.
    const reuse =
      refs !== undefined &&
      admittedOps.ops.stop === undefined &&
      admittedOps.listedQueueTip === admittedOps.ops.queue.tip &&
      refs.get(queueRef(request.target.branch)) === admittedOps.ops.queue.tip &&
      !refs.has(pauseRef(request.target.branch))
    // ADR-0022: the read after a rejected CAS is the next attempt's base.
    // A stuck pause depends on a separate change ref, so it must be rederived
    // on the second attempt.
    const operational =
      attempt === 1 && afterConflict !== undefined && afterConflict.ops.pause?.cause !== "stuck"
        ? afterConflict
        : reuse
          ? admittedOps
          : await readEventOpsWithRefs(
              store,
              git,
              request.target.branch,
              inspected.targetHead,
              refs === undefined ? undefined : { refs },
            )
    const { ops } = operational
    refuseMaintenance(ops.stop, remote, request.target.branch, published)
    const branchAt = (await listRefs(branchRef, store)).get(branchRef) ?? null
    const input = changeInput("opened", {
      queueTip: ops.queue.tip,
      at: new Date(),
      commit: head,
      by: request.submitter,
      ...(inspected.issue === undefined ? {} : { issue: inspected.issue.issue }),
      title: `${request.submitter} submitted ${request.branch} to ${targetName(request.target)}`,
    })
    const warningReason =
      inspected.admission.kind === "cannot-judge" || inspected.admission.kind === "warn"
        ? inspected.admission.reason
        : undefined
    const warningKind = inspected.admission.kind === "warn" ? "policy-warning" : undefined
    const warningAt = new Date()
    const warning =
      warningReason !== undefined
        ? changeInput("admission-warning", {
            queueTip: ops.queue.tip,
            at: warningAt,
            commit: head,
            reason: warningReason,
            ...(warningKind === undefined ? {} : { warningKind }),
            title: `admission ${warningKind === undefined ? "could not judge" : "policy warning"} ${request.branch}@${head.slice(0, 12)}`,
          })
        : undefined
    let retry = false
    let retryOpened: string | undefined
    let warningWritten = false
    // Lease the authoritative queue tip beside this change. A new maintenance
    // event between the read and publish makes the whole atomic push fail.
    let result
    try {
      result = await chain.transact(
        (events) => {
          warningWritten = false
          let current
          try {
            current = events.length === 0 ? initial : project(events, ref, root)
          } catch (error) {
            throw new Error(
              `${ref}@${events.at(-1)?.id ?? "absent"}: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            )
          }
          refuseMergedSubmit(events, ref, root, request.branch, head)
          retry =
            current.commit === head &&
            (current.status === "queued" ||
              current.status === "verifying" ||
              current.status === "checking" ||
              current.status === "stuck")
          if (retry) {
            retryOpened = events.findLast((event) => event.type === "opened")?.id
            if (warning === undefined) return []
            const currentSegment = events.slice(events.findLastIndex((event) => event.type === "opened"))
            const repeated = currentSegment.some(
              (event) =>
                event.type === "admission-warning" &&
                event.props.some(([key, value]) => key === "Commit" && value === head) &&
                event.props.some(([key, value]) => key === "Reason" && value === warningReason) &&
                event.props.find(([key]) => key === "Warning-Kind")?.[1] === warningKind,
            )
            if (repeated) return []
            warningWritten = true
            return [warning]
          }
          warningWritten = warning !== undefined
          return [...decide(events, input), ...(warning === undefined ? [] : [warning])]
        },
        `submit ${request.branch}`,
        {
          also: [
            { ref: branchRef, expect: branchAt, oid: head },
            { ref: queueRef(request.target.branch), expect: ops.queue.tip, oid: ops.queue.tip },
          ],
        },
      )
    } catch (error) {
      if (!(error instanceof Conflict) || !error.refs.some((ref) => ref === queueRef(request.target.branch))) {
        throw error
      }
      if (attempt === 0) {
        afterConflict = await readEventOpsWithRefs(store, git, request.target.branch, inspected.targetHead)
        refuseMaintenance(afterConflict.ops.stop, remote, request.target.branch, published)
        continue
      }
      const moved = await readEventOps(store, git, request.target.branch, inspected.targetHead)
      refuseMaintenance(moved.stop, remote, request.target.branch, published)
      throw error
    }
    const opened = retryOpened ?? result.events.findLast((event) => event.type === "opened")?.id
    if (opened === undefined) throw new Error(`${ref} in ${root}: submit published no opened event`)
    const warningEvent = warningWritten
      ? result.events.findLast((event) => event.type === "admission-warning")?.id
      : undefined
    if (warningWritten && warningEvent === undefined) {
      throw new Error(`${ref} in ${root}: submit published no admission-warning event`)
    }
    if (retry) {
      const latest = await readEventOps(store, git, request.target.branch, inspected.targetHead)
      refuseMaintenance(latest.stop, remote, request.target.branch, published)
    }
    return {
      branch: request.branch,
      head,
      targetHead: inspected.targetHead,
      opened,
      retry,
      published,
      verifying: inspected.verifying,
      admission: inspected.admission,
      ...(warningEvent !== undefined && warningReason !== undefined
        ? {
            admissionWarning: {
              event: warningEvent,
              reason: warningReason,
              at: warningAt.toISOString(),
            },
          }
        : {}),
      ...(inspected.issue === undefined ? {} : { issue: inspected.issue }),
      ...(ops.stop === undefined ? {} : { stop: ops.stop }),
    }
  }
  throw new Error(`${remote}#${request.target.branch} queue tip moved twice during submit; resubmit`)
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
  resolveIssue?: IssueResolver,
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
  const canonical = async (raw: string): Promise<string> => {
    const normalized = normalizeIssueReference(raw)
    if (resolveIssue === undefined) return normalized
    let resolved: string
    try {
      resolved = await resolveIssue(normalized)
    } catch (cause) {
      throw new Error(`cannot resolve issue ${JSON.stringify(raw)} for ${branch}: ${String(cause)}`, { cause })
    }
    if (
      typeof resolved !== "string" ||
      resolved.trim() === "" ||
      resolved !== resolved.trim() ||
      /[\u0000-\u001f\u007f]/u.test(resolved)
    ) {
      throw new Error(`issue resolver returned no single-line canonical issue for ${JSON.stringify(raw)} on ${branch}`)
    }
    return normalizeIssueReference(resolved)
  }
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
      const canonicalIssue = await canonical(issue)
      if (binding === undefined) binding = { issue: canonicalIssue, source: "binding", commit }
      else if (binding.issue !== canonicalIssue) {
        throw new Error(
          `conflicting issue bindings for ${branch}: ${binding.issue} at ${binding.commit}; ${canonicalIssue} at ${commit}; fix trailer at ${commit}`,
        )
      }
    }
  }
  if (binding !== undefined) {
    const canonicalDeclared = declared === undefined ? undefined : await canonical(declared)
    if (canonicalDeclared !== undefined && canonicalDeclared !== binding.issue) {
      throw new Error(
        `declared issue ${canonicalDeclared} conflicts with ${binding.issue} bound at ${binding.commit} on ${branch}; fix trailer at ${binding.commit}`,
      )
    }
    return binding
  }
  if (declared !== undefined) return { issue: await canonical(declared), source: "declared" }
  const legacy = /^(\d+)-/u.exec(branch.split("/").at(-1) ?? "")?.[1]
  return legacy === undefined ? undefined : { issue: await canonical(legacy), source: "legacy-branch" }
}

/**
 * Normalize a bead reference spelling before resolution and comparison.
 *
 * An absolute path under the vault root (e.g. `/hh/pm/@ag/hab/25488-...`),
 * a trailing `.md`, and the vault-relative path (`@ag/hab/25488-...`) all
 * name one issue (25719).
 */
export function normalizeIssueReference(raw: string): string {
  let issue = raw.trim()
  if (issue.endsWith(".md")) {
    issue = issue.slice(0, -3)
  }
  const atIndex = issue.indexOf("/@")
  if (atIndex >= 0) {
    issue = issue.slice(atIndex + 1)
  } else if (issue.startsWith("./@")) {
    issue = issue.slice(2)
  }
  return issue
}
