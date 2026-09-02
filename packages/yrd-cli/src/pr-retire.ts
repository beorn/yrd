/**
 * `yrd pr retire <change-or-branch> --revision N` — retire ONE revision of a
 * change from the receiver store in ONE journaled act.
 *
 * A superseded revision lives in TWO rows of the receiver store (`prs.git`):
 * `refs/yrd/submit/<branch>` — the submit fact — and `refs/for/<base>/<branch>`
 * — the landing request the push created. Retiring only the submit fact does
 * not remove the revision: the `refs/for` row re-projects the fact at its own
 * sha, and the next compose derives it again. Measured 2026-09-01 20:15-20:34
 * PDT: the follower pass composed PR3186 from
 * refs/for/main/@i/19-hab-tsx/wave2-slice6-continuation-gate ten minutes after
 * its submit fact was retired (journal cursor 126175); a Change-Id audit then
 * found 13 more superseded refs/for-only rows that only a hand audit could
 * see, all retired by hand with `git --git-dir prs.git update-ref -d`. The
 * receiver refuses deletion of `refs/for` by push (by design), so before this
 * verb there was no user-level way to retire a revision.
 *
 * The act, in order: (1) journal `queue/revision/retired` — change id,
 * revision, both shas, who retired it — which also retires the standing `bays.submits`
 * projection in the same frame and makes any re-projection of this row
 * underivable (@yrd/queue `retiredSubmits`); (2) delete both rows in one
 * `update-ref --stdin` transaction guarded by their expected old values;
 * (3) read both rows back and print the readback plus the successor's rows.
 * Journal FIRST, exactly as `pr close` writes its withdrawn record before
 * queue work terminalizes: a transaction that fails partway leaves the
 * retirement behind, where compose reads it, and the `queue list` WARN row
 * names this verb again as the cure until the rows are gone.
 *
 * `--burn-payload` is the same acknowledgement `pr close` demands: retiring
 * a revision that has NO live successor (no higher revision of the same
 * Change-Id with a standing submit fact) spends the only pointer to that
 * work, so the verb refuses until the operator says so.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { createElement } from "react"
import { Text } from "silvery"
import {
  CHANGE_ID_TRAILER_KEY,
  changeIdTrailerCandidates,
  findChangeId,
  resolveChangeIdentity,
  SUBMIT_REF_PREFIX,
} from "@yrd/bay"
import { raiseFailure } from "@yrd/core"
import { cleanGitEnvironment, createProcess, type Process } from "@yrd/process"
import { compareRevisions, resolveQueueChange, revisionOf } from "@yrd/queue"
import { usage } from "./invocation.ts"
import { printResult } from "./output.tsx"
import type { YrdCliApp, YrdCliIO, YrdCliServices } from "./types.ts"

const GIT_TIMEOUT_MS = 30_000
const FOR_REF_PREFIX = "refs/for/"
const HEADS_PREFIX = "refs/heads/"

type JsonOption = Readonly<{ json?: boolean }>

export type RetirePrOptions = JsonOption &
  Readonly<{
    revision?: number
    burnPayload?: boolean
    reason?: string
    /** Who retires it; defaults to the invoking runner identity. */
    by?: string
  }>

/** One `refs/for/<base>/<branch>` row of the receiver store, with the submit
 * fact standing beside it (when one does) and the identity its tip declares. */
export type ReceiverRevisionRow = Readonly<{
  forRef: string
  forSha: string
  base: string
  branch: string
  /** `refs/yrd/submit/<branch>`'s sha, absent when only the landing request survives. */
  submitSha?: string
  /** The tip commit's Change-Id trailer; absent for a pre-epoch commit. */
  changeId?: string
  /** `<stem>-rN` parsed off the branch (`revisionOf`); a bare branch is revision 1 of itself. */
  stem: string
  revision: string
}>

export type ReceiverRevisionScan = Readonly<{
  store: string
  rows: readonly ReceiverRevisionRow[]
  /** Every submit fact in the store by branch, including facts with no refs/for row. */
  submits: ReadonlyMap<string, string>
}>

type GitRunner = (
  args: readonly string[],
  stdin?: string,
) => Promise<Readonly<{ code: number; stdout: string; stderr: string }>>

function storeGit(process: Pick<Process, "run">, store: string): GitRunner {
  return async (args, stdin) => {
    const result = await process.run({
      argv: ["git", "--git-dir", store, ...args],
      cwd: store,
      env: cleanGitEnvironment(globalThis.process.env),
      timeoutMs: GIT_TIMEOUT_MS,
      ...(stdin === undefined ? {} : { stdin }),
    })
    if (result.timedOut) throw new Error(`yrd: git ${args.join(" ")} in '${store}' timed out after ${GIT_TIMEOUT_MS}ms`)
    return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr }
  }
}

/** The receiver store for this invocation. Refuses, never guesses: the store
 * is `<stateDir>/prs.git` and a missing state dir means this command cannot
 * see any row at all. */
export function receiverStorePath(io: YrdCliIO): string {
  if (io.stateDir === undefined) {
    raiseFailure(
      "refusal",
      "retire-store-missing",
      "yrd: pr retire needs the receiver store (<stateDir>/prs.git), and this invocation resolved no state directory",
    )
  }
  const store = join(io.stateDir, "prs.git")
  if (!existsSync(store)) {
    raiseFailure(
      "refusal",
      "retire-store-missing",
      `yrd: receiver store '${store}' does not exist; nothing pushed through the receiver can be retired here`,
    )
  }
  return store
}

/** Whether a receiver store exists for this invocation, for read-only callers
 * that scan when they can and say nothing when there is nothing to scan. */
export function optionalReceiverStorePath(io: YrdCliIO): string | undefined {
  if (io.stateDir === undefined) return undefined
  const store = join(io.stateDir, "prs.git")
  return existsSync(store) ? store : undefined
}

async function listRefs(git: GitRunner, patterns: readonly string[]): Promise<Map<string, string>> {
  const listed = await git(["for-each-ref", "--format=%(refname)%00%(objectname)", ...patterns])
  if (listed.code !== 0)
    throw new Error(`yrd: could not list receiver refs ${patterns.join(" ")}: ${listed.stderr.trim()}`)
  const refs = new Map<string, string>()
  for (const line of listed.stdout.split("\n")) {
    if (line === "") continue
    const [ref, sha] = line.split("\0")
    if (ref === undefined || sha === undefined || sha === "")
      throw new Error(`yrd: malformed for-each-ref row: ${line}`)
    refs.set(ref, sha)
  }
  return refs
}

/** Split `refs/for/<base>/<branch>`: the branch is the longest suffix the store
 * knows as a carrier (`refs/heads/<branch>`) or a submit fact; failing both,
 * the first segment is the base. Bases may carry slashes, so a fixed split
 * would misread `refs/for/release/1.x/<branch>`. */
function splitForRef(ref: string, known: ReadonlySet<string>): Readonly<{ base: string; branch: string }> {
  const rest = ref.slice(FOR_REF_PREFIX.length)
  const segments = rest.split("/")
  for (let cut = 1; cut < segments.length; cut += 1) {
    const branch = segments.slice(cut).join("/")
    if (known.has(branch)) return { base: segments.slice(0, cut).join("/"), branch }
  }
  const [base, ...branch] = segments
  if (base === undefined || branch.length === 0) {
    throw new Error(`yrd: landing-request ref '${ref}' names no <base>/<branch>`)
  }
  return { base, branch: branch.join("/") }
}

async function readChangeId(git: GitRunner, sha: string): Promise<string | undefined> {
  const read = await git([
    "log",
    "-1",
    `--format=%(trailers:key=${CHANGE_ID_TRAILER_KEY},valueonly,separator=%x2c)`,
    sha,
  ])
  if (read.code !== 0) throw new Error(`yrd: could not read the Change-Id trailer of ${sha}: ${read.stderr.trim()}`)
  return findChangeId(changeIdTrailerCandidates(read.stdout))
}

/** Every landing-request row of the receiver store, joined with its submit
 * fact and its declared identity. One `for-each-ref`, one `log` per row. */
export async function scanReceiverRevisions(
  process: Pick<Process, "run">,
  store: string,
): Promise<ReceiverRevisionScan> {
  const git = storeGit(process, store)
  const refs = await listRefs(git, [FOR_REF_PREFIX, SUBMIT_REF_PREFIX, HEADS_PREFIX])
  const submits = new Map<string, string>()
  const known = new Set<string>()
  for (const [ref, sha] of refs) {
    if (ref.startsWith(SUBMIT_REF_PREFIX)) {
      submits.set(ref.slice(SUBMIT_REF_PREFIX.length), sha)
      known.add(ref.slice(SUBMIT_REF_PREFIX.length))
    } else if (ref.startsWith(HEADS_PREFIX)) {
      known.add(ref.slice(HEADS_PREFIX.length))
    }
  }
  const rows: ReceiverRevisionRow[] = []
  for (const [ref, sha] of [...refs].toSorted(([left], [right]) => left.localeCompare(right))) {
    if (!ref.startsWith(FOR_REF_PREFIX)) continue
    const { base, branch } = splitForRef(ref, known)
    const marker = revisionOf(branch)
    const submitSha = submits.get(branch)
    const changeId = await readChangeId(git, sha)
    rows.push({
      forRef: ref,
      forSha: sha,
      base,
      branch,
      ...(submitSha === undefined ? {} : { submitSha }),
      ...(changeId === undefined ? {} : { changeId }),
      stem: marker?.stem ?? branch,
      revision: marker?.revision ?? "1",
    })
  }
  return { store, rows, submits }
}

function sameChange(left: ReceiverRevisionRow, right: ReceiverRevisionRow): boolean {
  if (left.changeId !== undefined && right.changeId !== undefined) return left.changeId === right.changeId
  return left.stem === right.stem
}

/** Higher revisions of the same change whose submit fact still stands — the
 * successors that prove retiring `row` loses nothing. */
export function liveSuccessors(scan: ReceiverRevisionScan, row: ReceiverRevisionRow): readonly ReceiverRevisionRow[] {
  return scan.rows.filter(
    (other) =>
      other.forRef !== row.forRef &&
      sameChange(other, row) &&
      compareRevisions(other.revision, row.revision) > 0 &&
      other.submitSha !== undefined,
  )
}

/** The orphan class the 2026-09-01 audit found by hand: a refs/for row with
 * no submit fact whose change has a NEWER submitted revision. Each is one
 * WARN row naming this verb as the cure. */
export function orphanRevisionWarnings(scan: ReceiverRevisionScan): readonly string[] {
  return scan.rows.flatMap((row) => {
    if (row.submitSha !== undefined) return []
    const successors = liveSuccessors(scan, row)
    if (successors.length === 0) return []
    const newest = successors.toSorted((left, right) => compareRevisions(right.revision, left.revision))[0]
    if (newest === undefined) return []
    return [
      `WARN ${row.forRef} (${describeRevision(row)}) has no submit fact and revision ${newest.revision} is submitted ` +
        `on '${newest.branch}' — a superseded revision compose can still derive from; retire it: ` +
        retireCommand(row),
    ]
  })
}

function describeRevision(row: ReceiverRevisionRow): string {
  return `revision ${row.revision} of ${row.changeId ?? `change '${row.stem}'`}`
}

/** The exact command that retires this row. */
export function retireCommand(row: ReceiverRevisionRow): string {
  return `yrd pr retire ${row.changeId ?? row.stem} --revision ${row.revision}`
}

const CHANGE_ID_SHAPE = /^I[0-9a-f]{40}$/u

function resolveTargetRow(
  app: YrdCliApp,
  scan: ReceiverRevisionScan,
  selector: string,
  revision: number | undefined,
): ReceiverRevisionRow {
  const wanted = revision === undefined ? undefined : String(revision)
  let candidates: ReceiverRevisionRow[]
  let named: string
  if (CHANGE_ID_SHAPE.test(selector)) {
    named = `change ${selector}`
    candidates = scan.rows.filter((row) => row.changeId === selector)
  } else {
    const state = app.state()
    const change = resolveQueueChange(state.bays, state.queues, selector)
    if (change !== undefined) {
      named = `change ${change.id} (branch '${change.branch}')`
      candidates = scan.rows.filter((row) => row.branch === change.branch)
    } else {
      const stem = revisionOf(selector)?.stem ?? selector
      named = `branch or change stem '${selector}'`
      const exact = scan.rows.filter((row) => row.branch === selector)
      candidates = exact.length > 0 && wanted === undefined ? exact : scan.rows.filter((row) => row.stem === stem)
    }
  }
  const matching = wanted === undefined ? candidates : candidates.filter((row) => row.revision === wanted)
  if (matching.length === 1) return matching[0] as ReceiverRevisionRow
  const known =
    candidates.length === 0
      ? "no revision of it is in the store"
      : `known revisions: ${candidates
          .toSorted((left, right) => compareRevisions(left.revision, right.revision))
          .map((row) => `r${row.revision} ${row.forRef}${row.submitSha === undefined ? " (no submit fact)" : ""}`)
          .join(", ")}`
  if (matching.length === 0) {
    raiseFailure(
      "refusal",
      "retire-target-missing",
      `yrd: nothing to retire for ${named}${wanted === undefined ? "" : ` revision ${wanted}`}: scanned ` +
        `${scan.rows.length} landing-request row(s) under ${FOR_REF_PREFIX} in ${scan.store}; ${known}`,
    )
  }
  raiseFailure(
    "refusal",
    "retire-revision-ambiguous",
    `yrd: ${named} names ${matching.length} rows; pass --revision N to pick exactly one — ${known}`,
  )
}

function short(sha: string): string {
  return sha.slice(0, 12)
}

function rowLine(row: ReceiverRevisionRow): string {
  return `${row.forRef} @ ${short(row.forSha)}, ${SUBMIT_REF_PREFIX}${row.branch} ${
    row.submitSha === undefined ? "absent" : `@ ${short(row.submitSha)}`
  }`
}

export async function retirePr(
  app: YrdCliApp,
  services: YrdCliServices,
  selector: string,
  options: RetirePrOptions,
  io: YrdCliIO,
): Promise<void> {
  if (options.revision !== undefined && (!Number.isInteger(options.revision) || options.revision < 1)) {
    usage("--revision must be a positive integer")
  }
  const reason = options.reason?.trim()
  if (options.reason !== undefined && (reason === undefined || reason === "")) usage("--reason requires non-empty text")
  const store = receiverStorePath(io)
  const { reason: _raw, ...rest } = options
  const trimmed: RetirePrOptions = { ...rest, ...(reason === undefined ? {} : { reason }) }
  if (services.process !== undefined) {
    await retireWith(app, services.process, store, selector, trimmed, io)
    return
  }
  await using process = createProcess()
  await retireWith(app, process, store, selector, trimmed, io)
}

async function retireWith(
  app: YrdCliApp,
  process: Pick<Process, "run">,
  store: string,
  selector: string,
  options: RetirePrOptions,
  io: YrdCliIO,
): Promise<void> {
  const reason = options.reason
  const git = storeGit(process, store)
  const scan = await scanReceiverRevisions(process, store)
  const row = resolveTargetRow(app, scan, selector, options.revision)
  const successors = liveSuccessors(scan, row)
  const others = scan.rows.filter((other) => other.forRef !== row.forRef && sameChange(other, row))
  if (successors.length === 0 && options.burnPayload !== true) {
    raiseFailure(
      "refusal",
      "retire-no-successor",
      `yrd: pr retire spends ${describeRevision(row)} permanently — ${rowLine(row)} — and no live successor ` +
        `revision of the same Change-Id stands (a higher revision with a submit fact)${
          others.length === 0
            ? "; no other revision of this change is in the store"
            : `; other revisions: ${others
                .toSorted((left, right) => compareRevisions(left.revision, right.revision))
                .map(
                  (other) =>
                    `r${other.revision} ${other.forRef}${other.submitSha === undefined ? " (no submit fact)" : ""}`,
                )
                .join(", ")}`
        }. If the work landed or is abandoned, re-read the rows above, then pass --burn-payload to acknowledge the spend.`,
    )
  }
  const identity = row.changeId ?? synthesizedChangeId(row)
  const state = app.state()
  const derived = state.queues.derivedIdentities[row.branch]?.[row.submitSha ?? row.forSha]
  const by = options.by?.trim() || io.runner || "operator"
  const revision = Number(row.revision)
  const submitRef = `${SUBMIT_REF_PREFIX}${row.branch}`
  io.stderr(
    `yrd: retiring ${describeRevision(row)} on '${row.branch}': ${rowLine(row)}` +
      (successors.length === 0
        ? " — no live successor; the payload is spent on --burn-payload\n"
        : ` — live successor r${successors.map((other) => other.revision).join(", r")}\n`),
  )
  // (1) The durable half first. A crash after this line leaves a retirement
  // compose honours and a WARN row that names this verb until (2) succeeds.
  await app.queue.retireRevision({
    branch: row.branch,
    base: row.base,
    changeId: identity,
    revision,
    ...(row.submitSha === undefined ? {} : { submitSha: row.submitSha }),
    forRef: row.forRef,
    forSha: row.forSha,
    by,
    ...(derived === undefined ? {} : { pr: derived.id }),
    ...(reason === undefined ? {} : { reason }),
  })
  // (2) Both rows, one transaction, each guarded by the sha it was read at.
  const commands = [
    "start",
    `delete ${row.forRef} ${row.forSha}`,
    ...(row.submitSha === undefined ? [] : [`delete ${submitRef} ${row.submitSha}`]),
    "prepare",
    "commit",
    "",
  ].join("\n")
  const deleted = await git(["update-ref", "--stdin"], commands)
  if (deleted.code !== 0) {
    raiseFailure(
      "refusal",
      "retire-refs-moved",
      `yrd: the retirement of ${describeRevision(row)} is journaled, but the receiver store refused to delete ` +
        `its rows at the shas they were read at (${deleted.stderr.trim() || deleted.stdout.trim()}) — a row moved ` +
        `under this command; re-run '${retireCommand(row)}' to read the rows afresh`,
    )
  }
  // (3) Readback: both rows absent, in the store's own words.
  const after = await listRefs(git, [row.forRef, submitRef])
  const remaining = [...after.keys()]
  if (remaining.length > 0) {
    throw new Error(`yrd: retirement transaction committed but ${remaining.join(", ")} still exist(s) in ${store}`)
  }
  const result = {
    command: "pr.retire",
    changeId: identity,
    revision,
    branch: row.branch,
    base: row.base,
    by,
    ...(reason === undefined ? {} : { reason }),
    ...(derived === undefined ? {} : { pr: derived.id }),
    retired: {
      forRef: row.forRef,
      forSha: row.forSha,
      submitRef,
      ...(row.submitSha === undefined ? {} : { submitSha: row.submitSha }),
    },
    readback: { [row.forRef]: "absent", [submitRef]: "absent" },
    burnPayload: successors.length === 0,
    successors: successors.map((other) => ({
      branch: other.branch,
      revision: Number(other.revision),
      forRef: other.forRef,
      forSha: other.forSha,
      submitRef: `${SUBMIT_REF_PREFIX}${other.branch}`,
      ...(other.submitSha === undefined ? {} : { submitSha: other.submitSha }),
    })),
  }
  const lines = [
    `retired ${describeRevision(row)} on '${row.branch}' (${by})`,
    `  ${row.forRef}: absent (was ${short(row.forSha)})`,
    `  ${submitRef}: absent${row.submitSha === undefined ? " (had no submit fact)" : ` (was ${short(row.submitSha)})`}`,
    ...(successors.length === 0
      ? ["  successor: none — payload spent (--burn-payload)"]
      : successors.map((other) => `  successor r${other.revision}: ${rowLine(other)}`)),
  ]
  await printResult(io, options.json === true, result, createElement(Text, null, lines.join("\n")))
}

/** A pre-epoch tip carries no trailer; the journal fact still needs an
 * identity, and the queue's own synthetic one (branch + sha) is the one every
 * other reader would derive for this row. */
function synthesizedChangeId(row: ReceiverRevisionRow): string {
  const resolved = resolveChangeIdentity({ branch: row.branch, sha: row.forSha })
  if (!resolved.ok) {
    raiseFailure(
      "refusal",
      "retire-target-missing",
      `yrd: ${row.forRef} at ${row.forSha} carries no Change-Id trailer and its facts are not canonical enough ` +
        "to mint a synthetic identity from; retire it by hand",
    )
  }
  return resolved.changeId
}
