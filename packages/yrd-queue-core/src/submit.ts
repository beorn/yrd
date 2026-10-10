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
import { join, resolve } from "node:path"
import { pushRefUpdates } from "git-super/push"
import { retryTransientPush } from "./transient-push.ts"
import { refuseMovedPrivateGitlinks } from "./private-submodules.ts"
import {
  Conflict,
  RetriesExhausted,
  createEventStore,
  listRefs,
  openEvents,
  selectionFor,
  runnerFor,
  type Event,
} from "./git.ts"
import { readConfig, targetName, type Target } from "./config.ts"
import { gitlinkRows, isAncestor, mergeBase, mergeBases, readRemoteCommit, seamProcess, type Git } from "./git.ts"
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
  readBranchHistory,
  readEventOps,
  readEventOpsWithRefs,
} from "./events.ts"
import { archivedChangesPrefix, classifyQueueRef, pauseRef, queueRefPrefix } from "./refs.ts"
import { verifyCandidate, type Verification, type SettledGitlink } from "./verifying.ts"
import { revertedPathsFinding } from "./revert-guard.ts"
import { gitlinksAt, holdsCommit } from "./reference.ts"
import { withRemoteSeam } from "./remote-calls.ts"

/** Outward submission evidence observes the candidate rather than relabelling the producer's claims. */
/**
 * Why a composed child is not yet retained, and the cure (27747). Present only
 * on a row the queue composed itself: a `merged` row whose child no durable
 * store holds yet. The queue recomposes the child at land, so a preview naming
 * it is telling the truth only if it also says the child is not retained.
 */
export type SubmitCustody = Readonly<{
  /** The two-parent child the compose authored, which no store holds yet. */
  pin: string
  state: "composed-not-retained"
  /** The store this row names, which would have to hold `pin` for the claim to stand. */
  store: string
  cure: string
}>

export type SubmitGitlink = Readonly<
  Omit<SettledGitlink, "state"> &
    (
      | { state: "not-run" }
      | {
          state: Exclude<SettledGitlink["state"], "not-run">
          recorded: string
          authorHead: string
          landingPin: string
          /** Present when the compose authored the pin and no store holds it yet. */
          custody?: SubmitCustody
        }
    )
>

export type SubmitVerification =
  | Readonly<Omit<Extract<Verification, { state: "verified" }>, "gitlinks"> & { gitlinks: readonly SubmitGitlink[] }>
  | Extract<Verification, { state: "failed" }>

async function submissionReceipt(git: Git, root: string, verifying: Verification): Promise<SubmitVerification> {
  if (verifying.state !== "verified") return verifying
  const settled = verifying.gitlinks.filter((row) => row.state !== "not-run")
  const observed = new Map(
    (
      await gitlinksAt(
        git,
        verifying.candidate,
        settled.map((row) => row.path),
      )
    ).map((row) => [row.path, row.sha]),
  )
  const gitlinks: SubmitGitlink[] = []
  for (const row of verifying.gitlinks) {
    if (row.state === "not-run") {
      gitlinks.push({ ...row, state: "not-run" })
      continue
    }
    const recorded = observed.get(row.path)
    const expected = row.state === "raised" ? row.to : row.from
    if (recorded !== expected) {
      throw new Error(
        `submission receipt ${row.path} state ${row.state}: producer ${expected}, candidate tree ${recorded ?? "absent"} at ${verifying.candidate}`,
      )
    }
    const authorHead = row.state === "merged" && row.composition?.pin ? row.composition.pin : row.from
    const landingPin = row.state === "raised" ? row.to : row.from
    const custody = await composedChildCustody(git, root, row, recorded, verifying.candidate)
    gitlinks.push({ ...row, recorded, authorHead, landingPin, ...(custody === undefined ? {} : { custody }) })
  }
  return { ...verifying, gitlinks }
}

/**
 * THE ONE PIN ON A ROW THE QUEUE AUTHORED ITSELF (27747).
 *
 * A `merged` row whose composition did not fast-forward carries, in `from`,
 * the two-parent child git-super COMPOSED — not a pin any authored tree held.
 * `recorded` is what the candidate tree names, and git-super wrote that child
 * into the submodule store of the tree it was handed, borrowed from the
 * reference: in a submit preview that store is scratch. So the candidate can
 * name a component pin no durable store holds, and a receipt that says only
 * "verified" claims a composition the candidate itself cannot read back.
 * MEASURED 2026-10-06: candidate 2d311854 recorded ag 2e6ea138, an object in NO
 * store, reported verified; dev/2's held 27787 dry run hit the same shape; and
 * an ordinary change to vendor/yrd whose component main had advanced hit it too.
 *
 * The child is a PREVIEW artifact by construction — nothing publishes it and
 * the queue recomposes it at land — so NAMING it is honest exactly when the row
 * also says it is not retained. Report that as `custody`, and say in the same
 * breath whether the change's own pin is readable in the change's own checkout,
 * because that reading is what decides whether a reader can resolve the change
 * at all.
 *
 * REFUSING WAS MEASURED AND REJECTED HERE (2026-10-06). A refusal on "the store
 * this row names does not hold the composed child" fires for every change whose
 * component main advanced — it refused this submission's own vendor/yrd move —
 * so it would stop the queue's intake rather than fix the lie. The lie is the
 * SILENCE, and a row that reports `composed-not-retained` is not silent.
 *
 * Every OTHER pin this receipt names is the AUTHOR's own — the change's pin,
 * which the 26754/27323 preview deliberately does not push, so custody there is
 * the author's and belongs to the publication step. A composition that
 * fast-forwarded (`composition.pin` is the change's own pin) authored nothing,
 * so it is skipped the same way.
 */
async function composedChildCustody(
  git: Git,
  root: string,
  row: SettledGitlink,
  recorded: string | undefined,
  candidate: string,
): Promise<SubmitCustody | undefined> {
  if (row.state !== "merged" || row.composition === undefined || row.composition.pin === row.from) return undefined
  if (recorded === undefined) return undefined
  const common = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
  const store = row.store ?? join(common, "modules", row.path)
  const storeGit: Git = (args, input) => git(["-C", store, ...args], input)
  if (await holdsCommit(storeGit, recorded)) return undefined
  const ownPin = row.composition.pin
  const ownStore = join(root, row.path)
  const ownGit: Git = (args, input) => git(["-C", ownStore, ...args], input)
  // The change's own pin reading is a SEPARATE fact from the child's custody,
  // and it is the one that decides whether a reader can resolve the change at
  // all, so the report carries it rather than folding it into one apology.
  const ownHolds = await holdsCommit(ownGit, ownPin)
  return {
    cure: ownHolds
      ? `the child is preview-only under candidate ${candidate}: nothing publishes it and the queue recomposes it at land. ` +
        `To make it durable here, compose where it is retained (the queue-owned clone), or publish ${recorded} to ` +
        `${row.path}'s declared remote so ${store} can be populated`
      : `the child is preview-only under candidate ${candidate}, and the change's own head ${ownPin} is absent from the ` +
        `change's own checkout ${ownStore} as well: fetch that pin into the checkout or publish it before relying on this ` +
        `preview. The queue recomposes the child at land`,
    pin: recorded,
    state: "composed-not-retained",
    store,
  }
}

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
  verifying: SubmitVerification
  issue?: IssueResolution
  admission: AdmissionOutcome
  /** Present only when this submit appended a new warning event; its caller sends one notification. */
  admissionWarning?: Readonly<{ event: string; reason: string; at: string }>
  /**
   * Present only when this submit appended a `reverted-paths` warning (#27363): the compose put a
   * target advance back, or could not prove it did not. Durable in the change chain either way.
   */
  revertWarning?: Readonly<{
    event: string
    reason: string
    count: number
    coverage: "complete" | "incomplete"
    at: string
  }>
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
   */
  state: "published" | "retained"
}>

/** git-super's retention namespace: one ref per object, named by it, create-only, never advanced. */
export function retentionRef(sha: string): string {
  return `refs/git-super/pins/${sha}`
}

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
const ZERO_SHA = /^0+$/u

/** One branch-authored component pin, with its local object reader and exact comparison bases. */
export type MovedGitlink = Readonly<
  Omit<PublishedGitlink, "state"> & { checkout: string; child: Git; bases: readonly string[] }
>

/**
 * Discover every branch-authored moved pin, nested paths included, without publishing refs.
 * A missing local pin is fetched from its remote before collection completes.
 * Missing objects refuse with the path, checkout and remote before any push.
 * Local checkout and reader fields are construction facts, never receiver path authority.
 */
export async function collectMovedGitlinks(
  git: Git,
  root: string,
  from: string | readonly string[],
  to: string,
  prefix = "",
): Promise<readonly MovedGitlink[]> {
  const pins: MovedGitlink[] = []
  const collect = async (git: Git, root: string, from: string | readonly string[], to: string, prefix: string) => {
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
      const child = runnerFor(git).at(checkout)
      // The DECLARED submodule url is what the record names; the transport rewrite is the host's.
      const remote = await remoteUrl(child, "origin")
      // Where the pin is: this checkout, else the remote under some ref (a branch
      // somebody pushed by hand; the queue fetches by sha, so ask the same way),
      // else nowhere, which is a refusal before anything is pushed.
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
        } catch (cause) {
          throw new Error(
            `${path} at ${row.sha} is a gitlink this change moved to a commit neither ${checkout} nor ${remote} holds; ` +
              "commit it in that checkout (or check the submodule out at it) so submit can publish it, then resubmit",
            { cause },
          )
        }
      }
      const ref = retentionRef(row.sha)
      // A moved submodule may itself have moved a gitlink: the nested pin has to
      // be fetchable too, from ITS remote, or the queue cannot materialize km.
      const before = await Promise.all(
        bases.map(async (base, index) =>
          byBase[index]?.get(row.path)?.oldMode === "160000"
            ? (await git(["rev-parse", `${base}:${row.path}`])).trim()
            : EMPTY_TREE,
        ),
      )
      pins.push({ path, sha: row.sha, remote, ref, checkout, child, bases: before })
      await collect(child, checkout, before, row.sha, path)
    }
  }
  await collect(git, root, from, to, prefix)
  return pins
}

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
 * Every collected pin gets a permanent retention ref, including fetched pins.
 */
export async function publishMovedGitlinks(
  git: Git,
  root: string,
  from: string | readonly string[],
  to: string,
  prefix = "",
): Promise<readonly PublishedGitlink[]> {
  const published: PublishedGitlink[] = []
  // Discover every eligible nested pin before the first remote write.
  const pins = await collectMovedGitlinks(git, root, from, to, prefix)
  const checkouts = new Map<string, MovedGitlink[]>()
  for (const pin of pins) {
    const group = checkouts.get(pin.checkout) ?? []
    group.push(pin)
    checkouts.set(pin.checkout, group)
  }
  for (const [checkout, group] of checkouts) {
    const first = group[0]
    if (first === undefined) throw new Error(`empty retention plan for child checkout ${checkout}`)
    let result: Awaited<ReturnType<typeof pushRefUpdates>>
    const pinRefs = group.map((pin) => pin.ref).join(", ")
    try {
      result = await retryTransientPush(
        () =>
          pushRefUpdates({
            root: checkout,
            git: seamProcess(first.child, checkout),
            updates: group.map((pin) => ({
              repository: checkout,
              remote: "origin",
              source: pin.sha,
              destination: pin.ref,
              expectedDestination: { state: "missing" },
            })),
          }),
        {
          repository: checkout,
          ref: pinRefs,
          text: (pushed) =>
            [
              pushed.detail?.message,
              ...pushed.repositories.flatMap((repository) => [
                repository.detail?.message,
                ...repository.refs.map((row) => row.detail?.message),
              ]),
            ]
              .filter((line): line is string => line !== undefined && line !== "")
              .join("\n"),
        },
      )
    } catch (cause) {
      throw Object.assign(
        new Error(
          `could not publish ${group.map((pin) => `${pin.path}@${pin.sha} at ${pin.remote} ${pin.ref}`).join(", ")} from ${checkout}; retained receipts: ${JSON.stringify(published)}`,
          { cause },
        ),
        { published },
      )
    }
    const refs = result.repositories.flatMap((repository) => repository.refs)
    const failures: string[] = []
    for (const pin of group) {
      const receipt = refs.find((ref) => ref.source === pin.sha && ref.destination === pin.ref)
      if (receipt?.state === "updated" || receipt?.state === "unchanged") {
        published.push({
          path: pin.path,
          sha: pin.sha,
          remote: pin.remote,
          ref: pin.ref,
          state: receipt.state === "updated" ? "published" : "retained",
        })
      } else if (receipt?.detail?.code === "destination-changed") {
        failures.push(
          `${receipt.detail.message} ${pin.remote} ${pin.ref} must name ${pin.sha}: a retention ref is named by its object and never moves`,
        )
      } else {
        failures.push(
          `could not publish ${pin.path}@${pin.sha} from ${checkout} at ${pin.remote} ${pin.ref}: ${receipt?.state ?? result.state}; ${receipt?.detail?.message ?? result.detail?.message ?? "no confirmed ref receipt"}`,
        )
      }
    }
    if (failures.length > 0) {
      throw Object.assign(new Error(`${failures.join("; ")}; retained receipts: ${JSON.stringify(published)}`), {
        published,
      })
    }
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
 * component checkouts into the candidate worktree's submodule checkouts, by sha and with no ref: preview custody
 * anchors what the compose keeps (27510).
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
    const sourceChild = runnerFor(git).at(sourceCheckout)
    const targetChild = runnerFor(git).at(targetCheckout)
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
            // No ref (27510): the compose reads the object in this process, and preview custody anchors what it keeps.
            row.sha,
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
  verifying: SubmitVerification
  issue?: IssueResolution
  admission: AdmissionOutcome
  /** An operator or stuck stop is echoed; maintenance refuses intake. */
  stop?: PauseRecord
}>

type SubmitOps = Awaited<ReturnType<typeof readEventOpsWithRefs>>
type SubmitAdmission = Readonly<
  Omit<SubmitInspection, "verifying"> & { root: string; bases: readonly string[]; operational: SubmitOps }
>

/** Captured admission and permanent child receipts, before composition or opening a change.
 * root, bases and operational preserve the same admission snapshot for ordinary submit.
 * Product adapters project the branch/head/base and published receipts, not operational storage.
 */
export type Prepared = SubmitAdmission & Readonly<{ branch: string; published: readonly PublishedGitlink[] }>

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
  const ended = await withRemoteSeam("previewRetirement", () => endedSubjects(git, admitted.root, remote, request))
  const verifying = await composeSubmit(git, request, admitted, ended)
  const { root, bases: _bases, operational: _operational, ...inspection } = admitted
  return { ...inspection, verifying: await submissionReceipt(git, root, verifying) }
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
    const store = createEventStore(root, remote, selectionFor(git), runnerFor(git).backend)
    if ((await queueFormat(store, request.target.branch)) === "event") {
      const { ref, history } = await readBranchHistory(store, request.target.branch, request.branch)
      if (history !== undefined) {
        refuseMergedSubmit(history.events, ref, root, request.branch, head)
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
  // 27147: after issue admission, before composition or any publication.
  await refuseMovedPrivateGitlinks(
    git,
    resolve((await git(["rev-parse", "--show-toplevel"])).trim()),
    request.branch,
    base,
    head,
  )
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
  const store = createEventStore(root, remote, selectionFor(git), runnerFor(git).backend)
  const queue = request.target.branch
  const format = await queueFormat(store, queue)
  switch (format) {
    case "empty": {
      // Queue creation addresses the declaration; only the runner executes its newer keys (27187).
      const config = await readConfig(git, targetHead, request.target, {
        newerKeys: (keys) => {
          console.warn(
            `yrd: creating event queue ${targetName(request.target)} from ${targetHead}: newer declaration keys ` +
              `${keys.map((key) => `${key}:`).join(", ")}. The queue runs them; submit does not. ` +
              "Update this environment's Yrd to the one the target pins to silence this.",
          )
        },
      })
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

/**
 * The submitting branch, when its own change has ended for good (27510 retirement, 28442 one-branch read): landed,
 * or cancelled as dropped, withdrawn or deleted. A failed or resubmitted change is still live. Other ended subjects
 * keep the seven-day preview-custody backstop: listing every change chain here shares the 300000 ms git bound. A
 * branch whose history is invalid is never evidence of retirement: it is named and left out.
 */
async function endedSubjects(
  git: Git,
  root: string,
  remote: string,
  request: SubmitRequest,
): Promise<ReadonlySet<string>> {
  const store = createEventStore(root, remote, selectionFor(git), runnerFor(git).backend)
  const format = await queueFormat(store, request.target.branch)
  // An empty queue has ended no change. One in another format cannot say which have: its retirement is the backstop.
  if (format === "empty") return new Set()
  if (format !== "event") {
    console.warn(
      `yrd: preview custody cannot read which changes ended from ${request.target.branch}'s ${format} queue; their anchors retire at the seven-day backstop`,
    )
    return new Set()
  }
  try {
    const { history } = await readBranchHistory(store, request.target.branch, request.branch)
    if (history === undefined) return new Set()
    const { reason, status } = history.state
    if (status === "merged" || (status === "cancelled" && ["dropped", "withdrawn", "deleted"].includes(reason ?? ""))) {
      return new Set([request.branch])
    }
    return new Set()
  } catch (error) {
    if (error instanceof Conflict) throw error
    console.warn(
      `yrd: preview custody keeps ${request.branch}'s anchors: its change history is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    )
    return new Set()
  }
}

async function composeSubmit(
  git: Git,
  request: SubmitRequest,
  admitted: SubmitAdmission,
  ended: ReadonlySet<string>,
): Promise<Verification> {
  // Submit, like the queue runner, keeps registered worktrees out of inherited habitat scratch.
  const common = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
  const tempRoot = join(common, "yrd", "tmp")
  mkdirSync(tempRoot, { recursive: true })
  const scratch = mkdtempSync(join(tempRoot, "yrd-submit-verifying-"))
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
      previewCustody: {
        subject: request.branch,
        leftover: (why) =>
          console.warn(`yrd: preview custody left an orphan anchor; the next submit sweeps it: ${why}`),
        retired: ended,
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

export async function prepareSubmit(git: Git, remote: string, request: SubmitRequest): Promise<Prepared> {
  refuseTarget(request.branch, request.target.branch)
  const head = (await git(["rev-parse", "--verify", `refs/heads/${request.branch}^{commit}`])).trim()
  const admitted = await withRemoteSeam("inspectSubmit", () => admitSubmitAtHead(git, remote, request, head))
  const published = await withRemoteSeam("publishMovedGitlinks", () =>
    publishMovedGitlinks(git, admitted.root, admitted.bases, head),
  )
  return { ...admitted, branch: request.branch, published }
}

export async function submit(git: Git, remote: string, request: SubmitRequest): Promise<Submitted> {
  const { branch: _branch, published, ...admitted } = await prepareSubmit(git, remote, request)
  const ended = await withRemoteSeam("previewRetirement", () => endedSubjects(git, admitted.root, remote, request))
  const verifying = await withRemoteSeam("composeSubmit", () => composeSubmit(git, request, admitted, ended))
  const receipt = await submissionReceipt(git, admitted.root, verifying)
  const { root, bases: _bases, operational, ...inspection } = admitted
  return withRemoteSeam("submitEvent", () =>
    submitEvent(git, remote, request, root, { ...inspection, verifying: receipt }, operational, published),
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
  const store = createEventStore(root, remote, selectionFor(git), runnerFor(git).backend)
  const ref = changesRef(request.target.branch, request.branch)
  const coldRef = `${archivedChangesPrefix(request.target.branch)}${request.branch}`
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
    const selected = await readBranchHistory(store, request.target.branch, request.branch)
    const archived = selected.ref === coldRef ? selected.history?.events : undefined
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
    // #27363: the compose revert detector reports through its OWN durable admission-warning,
    // beside the admission policy warning and never folded into it.
    const revertFinding = revertedPathsFinding(
      inspected.verifying.state === "verified" ? inspected.verifying.reverted : undefined,
    )
    type PendingWarning = Readonly<{
      input: ReturnType<typeof changeInput>
      kind: "policy-warning" | "reverted-paths" | undefined
      reason: string
    }>
    const warningInputs: readonly PendingWarning[] = [
      ...(warningReason === undefined
        ? []
        : [
            {
              input: changeInput("admission-warning", {
                at: warningAt,
                commit: head,
                queueTip: ops.queue.tip,
                reason: warningReason,
                ...(warningKind === undefined ? {} : { warningKind }),
                title: `admission ${warningKind === undefined ? "could not judge" : "policy warning"} ${request.branch}@${head.slice(0, 12)}`,
              }),
              kind: warningKind as PendingWarning["kind"],
              reason: warningReason,
            },
          ]),
      ...(revertFinding === undefined
        ? []
        : [
            {
              input: changeInput("admission-warning", {
                at: warningAt,
                commit: head,
                queueTip: ops.queue.tip,
                reason: revertFinding.reason,
                title: `admission reverted paths ${request.branch}@${head.slice(0, 12)}`,
                warningKind: "reverted-paths" as const,
              }),
              kind: "reverted-paths" as const,
              reason: revertFinding.reason,
            },
          ]),
    ]
    let retry = false
    let retryOpened: string | undefined
    let written: readonly PendingWarning[] = []
    // Lease the authoritative queue tip beside this change. A new maintenance
    // event between the read and publish makes the whole atomic push fail.
    const decideSubmit = (events: readonly Event[]) => {
      // A chain selected hot may move to cold while transact refreshes. Never replay it as a new branch.
      if (selected.ref === ref && selected.history !== undefined && events.length === 0) {
        throw new Conflict(`${ref} moved after submit selected its history; retry submit`, { refs: [ref] })
      }
      written = []
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
        if (warningInputs.length === 0) return []
        const currentSegment = events.slice(events.findLastIndex((event) => event.type === "opened"))
        written = warningInputs.filter(
          (warning) =>
            !currentSegment.some(
              (event) =>
                event.type === "admission-warning" &&
                event.props.some(([key, value]) => key === "Commit" && value === head) &&
                event.props.some(([key, value]) => key === "Reason" && value === warning.reason) &&
                event.props.find(([key]) => key === "Warning-Kind")?.[1] === warning.kind,
            ),
        )
        return written.map((warning) => warning.input)
      }
      written = warningInputs
      return [...decide(events, input), ...warningInputs.map((warning) => warning.input)]
    }
    const also = [
      { ref: branchRef, expect: branchAt, oid: head },
      { ref: queueRef(request.target.branch), expect: ops.queue.tip, oid: ops.queue.tip },
    ]
    let result
    try {
      if (archived === undefined) {
        result = await chain.transact(decideSubmit, `submit ${request.branch}`, { also })
      } else {
        const tip = archived.at(-1)?.id
        if (tip === undefined) throw new Error(`${coldRef}: archived history has no tip`)
        if (store.backend.publish === undefined) {
          throw new TypeError(`${coldRef}: backend cannot publish atomic custody`)
        }
        const staged = await chain.stage(decideSubmit(archived), { expect: tip })
        await store.backend.publish(
          root,
          [
            { ref, expect: "0".repeat(staged.head.length), oid: staged.head },
            { ref: coldRef, expect: tip, oid: null },
            ...also.map((update) => ({ ...update, expect: update.expect ?? "0".repeat(staged.head.length) })),
          ],
          remote,
        )
        result = { head: staged.head, events: staged.events, retries: 0 }
      }
    } catch (error) {
      if (
        !(error instanceof Conflict) ||
        error.refs.length === 0 ||
        error.refs.some((lost) => lost !== queueRef(request.target.branch))
      ) {
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
    const appended = result.events.filter(
      (event) =>
        event.type === "admission-warning" && event.props.some(([key, value]) => key === "Commit" && value === head),
    )
    const warningEvents = written.map((warning, index) => {
      const event = appended[appended.length - written.length + index]?.id
      if (event === undefined) throw new Error(`${ref} in ${root}: submit published no admission-warning event`)
      return { event, kind: warning.kind, reason: warning.reason }
    })
    const policyWarning = warningEvents.find((warning) => warning.kind !== "reverted-paths")
    const revertWarning = warningEvents.find((warning) => warning.kind === "reverted-paths")
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
      ...(policyWarning !== undefined
        ? {
            admissionWarning: {
              event: policyWarning.event,
              reason: policyWarning.reason,
              at: warningAt.toISOString(),
            },
          }
        : {}),
      ...(revertWarning !== undefined
        ? {
            revertWarning: {
              at: warningAt.toISOString(),
              coverage: revertFinding?.coverage ?? "complete",
              count: revertFinding?.count ?? 0,
              event: revertWarning.event,
              reason: revertWarning.reason,
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
  let base: string
  try {
    const found = await mergeBase(git, head, targetHead)
    if (found === undefined) throw new Error("no merge base")
    base = found
  } catch (cause) {
    throw new Error(
      `cannot read issue binding for ${branch} at ${head} against target ${targetHead}: ${String(cause)}`,
      { cause },
    )
  }
  let binding: IssueResolution | undefined
  for await (const candidate of issueBindingsOf(git, [`${base}..${head}`, `^${targetHead}`], branch, resolveIssue)) {
    const { issue, commit } = candidate
    if (binding === undefined) binding = { issue, source: "binding", commit }
    else if (binding.issue !== issue) {
      const trailer = candidate.trailer ?? "Refs/Resolves"
      throw new Error(
        `conflicting issue bindings for ${branch}: ${binding.issue} at ${binding.commit}; ${issue} at ${commit}; ` +
          `the second binding is a ${trailer} trailer, and a Refs or Resolves trailer always binds; ` +
          `keep a follow-up link without binding it with a "Follow-up: ${issue}" line, ` +
          `then fix trailer at ${commit}`,
      )
    }
  }
  if (binding !== undefined) {
    const canonicalDeclared = declared === undefined ? undefined : await canonicalIssue(declared, branch, resolveIssue)
    if (canonicalDeclared !== undefined && canonicalDeclared !== binding.issue) {
      throw new Error(
        `declared issue ${canonicalDeclared} conflicts with ${binding.issue} bound at ${binding.commit} on ${branch}; fix trailer at ${binding.commit}`,
      )
    }
    return binding
  }
  if (declared !== undefined) return { issue: await canonicalIssue(declared, branch, resolveIssue), source: "declared" }
  const legacy = /^(\d+)-/u.exec(branch.split("/").at(-1) ?? "")?.[1]
  return legacy === undefined
    ? undefined
    : { issue: await canonicalIssue(legacy, branch, resolveIssue), source: "legacy-branch" }
}

/** Read all explicit bindings through the submit decoder, preserving Git's commit order. */
export async function* issueBindingsOf(
  git: Git,
  revisions: readonly string[],
  branch: string,
  resolveIssue?: IssueResolver,
): AsyncGenerator<Readonly<{ issue: string; commit: string; trailer?: string }>, void> {
  // NUL separates each commit, Git trailer values, body and keyed trailers.
  // The body fallback accepts colonless Refs/Resolves while excluding subjects.
  let history: string
  try {
    history = await git([
      "log",
      "--reverse",
      "--topo-order",
      "-z",
      "--format=%H%x00%(trailers:key=Resolves,key=Refs,valueonly,separator=%x1e)%x00%B%x00%(trailers:key=Resolves,key=Refs,separator=%x1e)",
      ...revisions,
      "--",
    ])
  } catch (cause) {
    throw new Error(`cannot read issue binding for ${branch} in ${revisions.join(" ")}: ${String(cause)}`, { cause })
  }
  const records = history.split("\0")
  if (records.pop() !== "") {
    throw new Error(`incomplete issue binding history for ${branch} in ${revisions.join(" ")}`)
  }
  for (let index = 0; index < records.length; index += 4) {
    const commit = records[index]
    const values = records[index + 1]
    const body = records[index + 2]
    const keyed = records[index + 3]
    if (commit === undefined || values === undefined || body === undefined || keyed === undefined) {
      throw new Error(`incomplete issue binding history for ${branch} in ${revisions.join(" ")}`)
    }
    // The second trailer block keeps each key beside its value, so a refusal can
    // name the trailer that bound the second issue instead of guessing (27300).
    const trailerNames = new Map<string, string>()
    for (const entry of keyed.split("\u001e")) {
      const named = /^[ \t]*([A-Za-z][A-Za-z-]*)[ \t]*:[ \t]*(\S.*)$/u.exec(entry)
      if (named !== null && named[1] !== undefined && named[2] !== undefined) {
        trailerNames.set(named[2].trim(), named[1])
      }
    }
    const candidates: { issue: string; trailer: string | undefined }[] = []
    const consider = (issue: string, trailer: string | undefined): void => {
      if (issue !== "" && !candidates.some((candidate) => candidate.issue === issue)) {
        candidates.push({ issue, trailer })
      }
    }
    for (const value of values.split("\u001e")) {
      const issue = value.trim()
      consider(issue, trailerNames.get(issue))
    }
    // Also parse trailer-shaped lines like "Refs <issue>" or "Refs: <issue>" or "Resolves <issue>"
    // from commit body to accept trailers without colon (27041).
    // Never inspect the subject line, and require a single-token issue value to avoid binding prose lines.
    const nonSubjectLines = body.split(/\r?\n/).slice(1)
    const trailerRegex = /^[ \t]*(refs|resolves)[ \t]*:?[ \t]+(\S+)[ \t]*$/i
    for (const line of nonSubjectLines) {
      const match = trailerRegex.exec(line)
      if (match !== null) {
        const keyword = match[1]?.toLowerCase() ?? ""
        consider(match[2]?.trim() ?? "", keyword === "refs" ? "Refs" : "Resolves")
      }
    }
    for (const candidate of candidates) {
      const issue = candidate.issue
      if (/[\u0000-\u001f\u007f]/u.test(issue)) {
        throw new Error(
          `invalid issue binding in ${branch} at ${commit}: expected a single-line value without control characters`,
        )
      }
      yield {
        issue: await canonicalIssue(issue, branch, resolveIssue),
        commit,
        ...(candidate.trailer === undefined ? {} : { trailer: candidate.trailer }),
      }
    }
  }
}

async function canonicalIssue(raw: string, branch: string, resolveIssue?: IssueResolver): Promise<string> {
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
