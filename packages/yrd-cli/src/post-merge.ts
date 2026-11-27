import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { atomicWriteFileSync } from "@bearly/durable-file"
import {
  closingReferencesOf,
  enumerateChangeSegments,
  gitlinkRows,
  isRepositoryAt,
  readBranchHistory,
  readEventQueue,
  readIssueEffect,
  issueProviderId,
  trailerEffectId,
  writeQueueEvent,
  isAncestor,
  remoteUrl,
  trailer,
  type AppliedIssueEffect,
  type EventQueue,
  type GitRunner,
  type QueueLocation,
} from "@yrd/queue-core"
import { ISSUES_DECLARATION_PATH, parseIssuesDeclaration } from "./issues/declaration.ts"
import { runIssuesVerb } from "./issues/run.ts"
import {
  issueEventOperationId,
  issueEventSource,
  launchIssueEvent,
  type IssueEventLaunch,
  type IssueEventLaunchInput,
} from "./issue-event-edge.ts"

// Real public Km CLI trial (2026-10-16, km-cli-trial.json): 1.246s for one
// closing action across two introduced commits, 0.739s unchanged catch-up.
// Allow 50/run at that measured whole-command cost (~62.3s), with nearly 2x
// margin. This is a bounded attempt, not a claim about worst-case workloads.
const UPDATE_TIMEOUT_MS = 120_000

/**
 * How many attempts one merged branch's post-merge issue update gets (37513, @cto 68bee3e1). A failed attempt's
 * branches ride the service's next attempt instead of waiting for a restart's catch-up; after this many failures the
 * service stops carrying the branch and names it to `abandoned`, so a person reruns the close.
 */
export const POST_MERGE_ATTEMPTS = 3

/** A merged branch the service stopped carrying: its attempts, the last failure, and that attempt's record. */
export type AbandonedPostMerge = Readonly<{ branch: string; attempts: number; reason: string; evidence: string }>

/** What one attempt left owed: the branches its failure is charged to, and why. Empty when it settled. */
type AttemptOutcome = Readonly<{ failed: readonly string[]; reason: string; evidence: string }>

/**
 * A provider refuses a replayed operation id whose recorded request differs from this attempt's: the identity moved
 * since the attempt that landed it (a key that changed between resolves, or a request rebuilt from the current
 * state). Only this refusal earns the one settled retry; every other failure is carried as before. #38947 gives the
 * refusal a typed code; until it lands, the sentence is the only thing a provider says (@cto 61719dc4 condition 1).
 */
const STATE_OPERATION_ID_MOVED = /already belongs to another request/u

/**
 * The settled retry's id suffix, and the reason it is a hyphen: km names its pending-publication ref after the
 * operation id, so an id must satisfy `[A-Za-z0-9][A-Za-z0-9._-]*` and never contain `..` or end in `.lock`. The
 * obvious `:settled` cannot name a ref, so every retry was refused before it could land — the branch stayed carried
 * and the closer re-escalated a close that had already applied (38844 via #38952). Deterministic, so a replay is
 * still one write.
 */
const SETTLED_RETRY_SUFFIX = "-settled"

/**
 * A provider's stderr belongs to the attempt's own report, not the closer's process stream: the failure diagnostic
 * already carries its last line, and buffering the rest into whole reported lines keeps every chunk with the round's
 * evidence instead of escaping through the caller (yrd #38945).
 */
function reportedProviderStderr(report: (message: string) => void): (text: string) => void {
  let pending = ""
  return (chunk) => {
    pending += chunk
    const lines = pending.split("\n")
    pending = lines.pop() ?? ""
    for (const line of lines) {
      const text = line.trim()
      if (text !== "") report(`issuesProvider: ${text}`)
    }
  }
}

const failingStatus = (status: unknown): boolean =>
  status === "failed" || status === "unavailable" || status === "record-failed"

/**
 * The merged branches a failed attempt is charged to (37513). A failing action that names one of the attempt's
 * branches charges that branch alone; a failure that names none (`whole`: the update, an event write with no branch
 * row, the attempt itself), or a failed attempt whose actions name no branch of its own, charges every branch.
 */
export function chargedBranches(
  merged: readonly string[],
  actions: ReadonlyArray<Readonly<{ status?: unknown; branch?: unknown }>>,
  whole: boolean,
): readonly string[] {
  if (whole) return merged
  const named = new Set(
    actions
      .filter(({ status }) => failingStatus(status))
      .map(({ branch }) => branch)
      .filter((branch): branch is string => typeof branch === "string" && merged.includes(branch)),
  )
  return named.size === 0 ? merged : merged.filter((branch) => named.has(branch))
}

type Context = Readonly<{
  code: string
  config: string
  repo: string
  queue: string
  target: string
  /** The target this round's judgements were made against; merged item events need it (#31194). */
  base?: string
  merged: readonly string[]
  projectRoot?: string
  queueBranch?: string
  /** The target's remote name; the `merged` item event names the repository by its URL. */
  remote?: string
}>

type IssueDiagnostic = Readonly<{
  branch: string
  mergedEvent: string
  mergeSha: string
  providerId: string
  diagnostic: string
}>

type IssueAction = Omit<IssueDiagnostic, "diagnostic"> &
  (
    | { status: "fulfilled" }
    | {
        status: "skipped"
        reason?: string
        /** Set by the superseded-trailer rule (38978), so a skip that left an issue open can still be read. */
        commit?: string
        superseding?: readonly string[]
      }
    /** The write left with a detached child (hh #38766); `log` is where that child's own outcome lands. */
    | { status: "launched"; log: string }
    | { status: "failed" | "unavailable" | "record-failed"; diagnostic: string }
  )

/** The same attempt decoder serves recovery and the read-only diagnostic projection. */
function readPostMergeAttempt(
  path: string,
): Readonly<{ value: Record<string, unknown>; actions: readonly IssueAction[] }> {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new Error(`post-merge attempt evidence unreadable at ${path}: ${String(error)}`)
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`post-merge attempt evidence malformed at ${path}: attempt is not an object`)
  }
  const attempt = raw as Record<string, unknown>
  const actions = attempt.issueActions === undefined ? [] : attempt.issueActions // legacy attempts predate issue actions
  if (!Array.isArray(actions)) {
    throw new Error(`post-merge attempt evidence malformed at ${path}: issueActions is not an array`)
  }
  for (const action of actions) {
    if (typeof action !== "object" || action === null || Array.isArray(action)) {
      throw new Error(`post-merge attempt evidence malformed at ${path}: issue action is not an object`)
    }
    const item = action as Record<string, unknown>
    if (
      typeof item.status !== "string" ||
      typeof item.branch !== "string" ||
      typeof item.mergedEvent !== "string" ||
      typeof item.mergeSha !== "string" ||
      typeof item.providerId !== "string"
    ) {
      throw new Error(
        `post-merge attempt evidence malformed at ${path}: issue action lacks status, branch, mergedEvent, mergeSha or providerId`,
      )
    }
    if (item.status === "skipped" || item.status === "fulfilled") continue
    // The closer's launched writes (hh #38766) are read back here before the per-change view is built; a launched row
    // names the child's own log and has no diagnostic of its own, so it is a valid status, not a malformed one.
    if (item.status === "launched") {
      if (typeof item.log !== "string") {
        throw new Error(`post-merge attempt evidence malformed at ${path}: launched issue action lacks log`)
      }
      continue
    }
    if (item.status !== "failed" && item.status !== "unavailable" && item.status !== "record-failed") {
      throw new Error(`post-merge attempt evidence malformed at ${path}: unknown issue action status ${item.status}`)
    }
    if (typeof item.diagnostic !== "string") {
      throw new Error(`post-merge attempt evidence malformed at ${path}: failed issue action lacks diagnostic`)
    }
  }
  return { value: attempt, actions: actions as IssueAction[] }
}

/** Read-only projection; unread derived attempts are reported, never replay authority. */
/** The creation instant an attempt file's name carries (`2026-10-24T08-57-45.354Z-…json`), or undefined. */
function postMergeAttemptOpenedAt(name: string): Date | undefined {
  const matched = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d{3})Z/u.exec(name)
  if (matched === null) return undefined
  const [, day, hour, minute, second, millis] = matched
  const at = new Date(`${day}T${hour}:${minute}:${second}.${millis}Z`)
  return Number.isNaN(at.getTime()) ? undefined : at
}

export function readPostMergeIssueDiagnostics(
  workdir: string,
  reportUnavailable?: (message: string) => void,
  options: Readonly<{ notBefore?: Date }> = {},
): readonly IssueDiagnostic[] {
  const directory = join(workdir, "post-merge")
  if (!existsSync(directory)) return []
  const found = new Map<string, IssueDiagnostic>()
  let names: string[]
  try {
    names = readdirSync(directory).sort()
  } catch (error) {
    const diagnostic = `post-merge attempt evidence unreadable at ${directory}: ${String(error)}`
    if (reportUnavailable === undefined) throw new Error(diagnostic)
    reportUnavailable(diagnostic)
    return []
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    // #38870: a listing that prints 24 h of changes cannot show a diagnostic from an older merge, so it does not
    // open one. The attempt's own creation time is its file name; an unreadable name is still read, never skipped
    // on a guess.
    const openedAt = postMergeAttemptOpenedAt(name)
    if (options.notBefore !== undefined && openedAt !== undefined && openedAt < options.notBefore) continue
    const path = join(directory, name)
    let attempt: ReturnType<typeof readPostMergeAttempt>
    try {
      attempt = readPostMergeAttempt(path)
    } catch (error) {
      if (reportUnavailable === undefined) throw error
      reportUnavailable(String(error))
      continue
    }
    for (const item of attempt.actions) {
      const identity = JSON.stringify([item.branch, item.mergedEvent, item.mergeSha, item.providerId])
      // A launched write has no outcome here to report (hh #38766): the detached child owns it, and its own `failed`
      // event on the issue is the notify. Only rows this process judged stay diagnostics.
      // hh 38978: a trailer the landing did not carry leaves the issue OPEN, so this skip is not a clean ending and
      // must reach the submitter the way a refusal does — queue diagnostics, not only the attempt log (@cto 5db8edbf).
      if (item.status === "skipped" && item.reason === "trailer-commit-superseded") {
        const tookBack = (item.superseding ?? []).map((sha) => sha.slice(0, 12)).join(", ")
        found.set(identity, {
          branch: item.branch,
          mergedEvent: item.mergedEvent,
          mergeSha: item.mergeSha,
          providerId: item.providerId,
          diagnostic: `${item.branch}@${item.mergeSha}: closing trailer commit ${String(item.commit ?? "?")} did not survive the landing — ${tookBack === "" ? "the landing changed nothing" : `${tookBack} took its change back`}; the issue was left open`,
        })
        continue
      }
      if (item.status === "skipped" || item.status === "fulfilled" || item.status === "launched") {
        found.delete(identity)
        continue
      }
      found.set(identity, {
        branch: item.branch,
        mergedEvent: item.mergedEvent,
        mergeSha: item.mergeSha,
        providerId: item.providerId,
        diagnostic: item.diagnostic,
      })
    }
  }
  return [...found.values()]
}

/**
 * What the closer did with one component range a landing moved, said by name (29630, @cto 5a66fb46). Its outcome's
 * providerId is `component:<path>`, so a range read on a later attempt clears an earlier unresolved row.
 */
type ComponentUnread = Readonly<{
  unread: true
  component: string
  /** `unavailable` is a lost close until it is cured, so the attempt fails and is retried; `skipped` is a rule. */
  status: "unavailable" | "skipped" | "fulfilled"
  reason: "component-pin-unresolved" | "component-added" | "component-removed" | "component-read"
  diagnostic?: string
}>

/**
 * A trailer commit that did not survive its own landing (hh 38978): the landing's net diff over that commit's paths is
 * empty, so the change it names was reverted or removed again inside the same range. `superseding` names the commits
 * in the range that took the paths back, so a report can say which commit undid which.
 */
type Superseded = Readonly<{
  base: string
  landing: string
  superseding: readonly string[]
  /** `landing-empty` is the empty-commit case: nothing changed at all, so there is no commit to name. */
  why: "landing-empty" | "paths-taken-back"
}>

type ClosingReference = Readonly<{
  value: string
  commit: string
  trailer: string
  component?: string
  /** Present only when the commit's change did not survive: the closer leaves the issue open and says why. */
  superseded?: Superseded
}>

/** The paths one commit changed against its first parent; a root commit against nothing. */
async function changedPathsOf(git: GitRunner, commit: string): Promise<readonly string[]> {
  const parents = (await git(["rev-list", "--parents", "-n", "1", commit])).trim().split(" ")
  const out =
    parents.length === 1
      ? await git(["diff-tree", "--root", "--no-commit-id", "-r", "--name-only", "-z", "--no-renames", commit])
      : await git(["diff", "--name-only", "-z", "--no-renames", parents[1] as string, commit])
  return out.split("\0").filter((path) => path !== "")
}

type Survival =
  | Readonly<{ survived: true }>
  | Readonly<{ survived: false; superseding: readonly string[]; why: "landing-empty" | "paths-taken-back" }>

/**
 * Whether a closing trailer's commit survived its landing (hh 38978, cdde7969): the landing's net diff, restricted to
 * the paths that commit changed, is not empty. An empty commit carries no paths of its own — seats use one to hold
 * nothing but a trailer — so for it the whole landing's net diff is the question instead (@cto 5db8edbf): a landing
 * that changed something closes, a landing that changed nothing closes nothing. The verdict is read from the same range
 * the trailers were read from, root or component, so a landing that reverted its own work cannot close what it did not
 * deliver.
 */
async function survivalOf(git: GitRunner, base: string, landing: string, commit: string): Promise<Survival> {
  const paths = await changedPathsOf(git, commit)
  // `--literal-pathspecs` (@cto ea5c5f52): a path with `*`, `[` or a leading `:` is otherwise read as a glob or as
  // pathspec magic, which can match some other file and decide a reverted change survived.
  const net = await git([
    "--literal-pathspecs",
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    base,
    landing,
    ...(paths.length === 0 ? [] : ["--", ...paths]),
  ])
  if (net.split("\0").some((path) => path !== "")) return { survived: true }
  // An empty commit names no paths of its own, so no commit took anything back: the landing itself delivered nothing.
  if (paths.length === 0) return { survived: false, superseding: [], why: "landing-empty" }
  // `--full-history`, because default simplification prunes a commit whose path the tip no longer has — exactly the
  // supersession this reads for.
  const later = await git([
    "--literal-pathspecs",
    "log",
    "--format=%H",
    "--no-merges",
    "--full-history",
    `${commit}..${landing}`,
    "--",
    ...paths,
  ])
  return {
    survived: false,
    superseding: later
      .split("\n")
      .map((sha) => sha.trim())
      .filter((sha) => sha !== ""),
    why: "paths-taken-back",
  }
}

/**
 * The closing trailers in every component range a landing moved (29630, @cto 5a66fb46): each changed gitlink, from
 * its pin at the root range's base to its pin at the merge, nested components included. They are read from the queue
 * clone's own reference store for that component (`<queue clone>/<path>`), the store the landing's publication pushed
 * the component from, so nothing is fetched. A store or pin the clone cannot resolve is a named refusal, never a
 * skipped range, because a skipped range is a lost close. A component added or taken out by the landing has no range
 * of landed work; each is said by name too.
 */
async function* componentClosingReferences(
  git: GitRunner,
  store: string,
  from: string,
  to: string,
  branch: string,
  prefix = "",
): AsyncGenerator<ClosingReference | ComponentUnread, void> {
  for (const row of await gitlinkRows(git, from, to)) {
    const component = prefix === "" ? row.path : `${prefix}/${row.path}`
    if (row.oldMode !== "160000" || row.newMode !== "160000") {
      const added = row.oldMode !== "160000"
      yield {
        unread: true,
        component,
        status: "skipped",
        reason: added ? "component-added" : "component-removed",
        diagnostic: `${component} was ${added ? "added" : "taken out"} by this landing; it has no range of landed work to read`,
      }
      continue
    }
    const checkout = join(store, row.path)
    let old: string
    let unresolved: string | undefined
    try {
      old = (await git(["rev-parse", "--verify", "--end-of-options", `${from}:${row.path}`])).trim()
    } catch (cause) {
      old = ""
      unresolved = `its pin at ${from} cannot be read: ${String(cause)}`
    }
    const child = git.at(checkout)
    if (unresolved === undefined && !(await isRepositoryAt((cwd) => git.at(cwd), checkout))) {
      unresolved = `no component store at ${checkout}`
    }
    for (const pin of unresolved === undefined ? [old, row.sha] : []) {
      try {
        await child(["cat-file", "-e", `${pin}^{commit}`])
      } catch {
        // catch-cause-allow: `cat-file -e` answers "is this commit here" with its exit status alone, and absence is
        // the answer; it is reported below by store and sha as a named refusal, never dropped.
        unresolved = `${checkout} does not hold pin ${pin}`
        break
      }
    }
    if (unresolved !== undefined) {
      yield {
        unread: true,
        component,
        status: "unavailable",
        reason: "component-pin-unresolved",
        diagnostic: `${component} moved ${old === "" ? "?" : old}..${row.sha} and its closing trailers were not read: ${unresolved}`,
      }
      continue
    }
    for await (const reference of closingReferencesOf(child, [`${old}..${row.sha}`], branch)) {
      const survival = await survivalOf(child, old, row.sha, reference.commit)
      yield {
        ...reference,
        component,
        ...(survival.survived
          ? {}
          : { superseded: { base: old, landing: row.sha, superseding: survival.superseding, why: survival.why } }),
      }
    }
    yield { unread: true, component, status: "fulfilled", reason: "component-read" }
    yield* componentClosingReferences(child, checkout, old, row.sha, branch, component)
  }
}

async function closeMergedIssues(
  input: Readonly<{
    branches: readonly string[]
    queue: string
    store: QueueLocation
    git: GitRunner
    projectRoot: string
    /**
     * The target this round published; every merge it delivered is its ancestor. Each declaration's ancestry is
     * proved against it, never the project root's local main, which a shared-main projection lets lag (hh 38606).
     */
    target: string
    workdir: string
    cwd: string
    env?: NodeJS.ProcessEnv
    report: (message: string) => void
    stop?: AbortSignal
    knownQueue?: EventQueue
    /** The target's remote name, read only to name the repository on a superseded commit's event (38978). */
    remote?: string
    /** The issue-event edge, so a trailer the landing did not carry still leaves a merged event naming both commits. */
    launchEvent?: (input: IssueEventLaunchInput) => IssueEventLaunch
  }>,
): Promise<Readonly<{ outcomes: Array<Record<string, unknown>>; queue?: EventQueue }>> {
  const outcomes: Array<Record<string, unknown>> = []
  let completed = input.knownQueue
  // Each key's close in this round: true closed, false failed (29630).
  const closedKeys = new Map<string, boolean>()
  // The repository's own URL, read once, only to name it on an event for a superseded trailer (38978).
  let eventUrl: string | undefined
  let eventUrlUnreadable: string | undefined
  // Whether each landing's own declaration carries the `event` verb, read once per merge.
  const eventDeclared = new Map<string, boolean>()

  for (const branch of new Set(input.branches)) {
    if (input.stop?.aborted) return { outcomes, queue: completed }
    try {
      const reading = await readBranchHistory(input.store, input.queue, branch)
      const history = reading.history
      if (history === undefined) throw new Error(`post-merge named branch ${branch} has no event history`)
      const segments = enumerateChangeSegments(history.events, reading.ref, input.store.repo)
      for (const segment of segments) {
        if (segment.state.status !== "merged" || segment.state.ending?.kind !== "merged") continue
        const mergedEvent = segment.events.findLast((event) => event.type === "merged")
        const mergeSha = segment.state.merge
        if (mergedEvent === undefined || mergeSha === undefined) {
          throw new Error(`${branch}: merged segment ${segment.opened} has no actual merged event or merge SHA`)
        }
        try {
          const observed = trailer(mergedEvent, "Reason") === `observed on target at ${mergeSha}`
          if (observed && !(await isAncestor(input.git, segment.head, mergeSha))) {
            throw new Error(
              `${branch}@${mergeSha}: submitted head ${segment.head} is not an ancestor of its observed delivery`,
            )
          }
          const phase = segment.events.findLast(
            (event) => event.type === "merging" && trailer(event, "Base") !== undefined,
          )
          const base = observed
            ? trailer(mergedEvent, "Base")
            : phase === undefined
              ? undefined
              : trailer(phase, "Base")
          const pinnedBlob = (
            await input.git(["ls-tree", "--format=%(objectname)", mergeSha, "--", "issues.yml"])
          ).trim()
          if (pinnedBlob === "") {
            outcomes.push({
              branch,
              mergedEvent: mergedEvent.id,
              mergeSha,
              providerId: "",
              status: "skipped",
              reason: "issues.yml absent at the delivered merge",
            })
            continue
          }
          if (base === undefined || base === "") {
            const diagnostic = `${branch}@${mergeSha}: actual merged commit has no provable historical base; only the known submitted commit was inspected, no introduced range was invented`
            let references = 0
            for await (const reference of closingReferencesOf(input.git, ["-1", segment.head], branch)) {
              references++
              outcomes.push({
                branch,
                mergedEvent: mergedEvent.id,
                mergeSha,
                providerId: issueProviderId(mergeSha, "resolve", undefined, reference.value),
                status: "failed",
                reason: "missing-base",
                raw: reference.value,
                diagnostic,
              })
            }
            if (references === 0) {
              outcomes.push({
                branch,
                mergedEvent: mergedEvent.id,
                mergeSha,
                providerId: "",
                status: "unavailable",
                reason: "missing-base",
                diagnostic,
              })
            }
            input.report(diagnostic)
            continue
          }
          const rawCommitterTime = (await input.git(["show", "-s", "--format=%cI", mergeSha])).trim()
          if (rawCommitterTime === "" || Number.isNaN(Date.parse(rawCommitterTime))) {
            throw new Error(`${branch}@${mergeSha}: actual merge committer time is unreadable`)
          }
          const committerTime = new Date(rawCommitterTime).toISOString()
          for (const event of history.events) {
            const applied = readIssueEffect(event)
            if (
              applied?.mergedEvent === mergedEvent.id &&
              applied.mergeSha === mergeSha &&
              applied.declaration.blob !== pinnedBlob
            ) {
              throw new Error(
                `${branch}@${mergeSha}: applied declaration blob ${applied.declaration.blob} differs from pinned ${pinnedBlob}`,
              )
            }
          }
          const references = async function* (): AsyncGenerator<ClosingReference | ComponentUnread, void> {
            yield* closingReferencesOf(input.git, [`${base}..${observed ? segment.head : mergeSha}`], branch)
            if (observed && mergeSha !== segment.head) yield* closingReferencesOf(input.git, ["-1", mergeSha], branch)
            // 29630: every component range this landing moved, from the same base the root range starts at.
            yield* componentClosingReferences(input.git, input.store.repo, base, mergeSha, branch)
          }
          const refs = references()
          // One raw value is resolved once per landing, wherever it appears (root or component, @cto 5a66fb46).
          const resolvedRaw = new Set<string>()
          for await (const reference of refs) {
            if (input.stop?.aborted) return { outcomes, queue: completed }
            if ("unread" in reference) {
              outcomes.push({
                branch,
                mergedEvent: mergedEvent.id,
                mergeSha,
                providerId: `component:${reference.component}`,
                status: reference.status,
                reason: reference.reason,
                component: reference.component,
                ...(reference.diagnostic === undefined ? {} : { diagnostic: reference.diagnostic }),
              })
              if (reference.status === "unavailable") input.report(`${branch}@${mergeSha}: ${reference.diagnostic}`)
              continue
            }
            if (resolvedRaw.has(reference.value)) continue
            resolvedRaw.add(reference.value)
            // hh 38978: a closing trailer whose commit the landing did not carry closes nothing. Decided before the
            // no-resend record, because a landing that reverted its own work is not a delivery of that work.
            const landing = observed ? segment.head : mergeSha
            const survival =
              reference.component === undefined
                ? await survivalOf(input.git, base, landing, reference.commit)
                : undefined
            const superseded =
              reference.superseded ??
              (survival === undefined || survival.survived
                ? undefined
                : { base, landing, superseding: survival.superseding, why: survival.why })
            if (superseded !== undefined) {
              const tookBack =
                superseded.why === "landing-empty"
                  ? "the landing itself changed nothing"
                  : superseded.superseding.length === 0
                    ? "a later commit in the range"
                    : superseded.superseding.map((sha) => sha.slice(0, 12)).join(", ")
              const where = reference.component === undefined ? "" : ` in ${reference.component}`
              const said = `${branch}@${mergeSha}: ${reference.trailer}: ${reference.value} on ${reference.commit}${where} did not survive this landing — ${tookBack} took its change back; the issue is left open`
              input.report(said)
              let recorded: string | undefined
              // The same declaration that lets `merged` be written at all (recordMergedEvents), read here so a
              // project that declares no `event` verb is said plainly instead of failing inside the child.
              if (eventDeclared.get(mergeSha) === undefined) {
                try {
                  eventDeclared.set(mergeSha, await declaresEvent(input.git, mergeSha))
                } catch (cause) {
                  eventDeclared.set(mergeSha, false)
                  input.report(
                    `${branch}@${mergeSha}: issues.yml at the merge is unreadable, so the superseded-trailer event for ${reference.value} was not written: ${String(cause)}`,
                  )
                }
              }
              if (
                input.launchEvent !== undefined &&
                input.remote !== undefined &&
                eventDeclared.get(mergeSha) === true
              ) {
                if (eventUrl === undefined && eventUrlUnreadable === undefined) {
                  try {
                    eventUrl = await remoteUrl(input.git, input.remote)
                  } catch (cause) {
                    eventUrlUnreadable = String(cause)
                  }
                }
                if (eventUrl === undefined) {
                  input.report(
                    `${branch}@${mergeSha}: the superseded-trailer event for ${reference.value} was not written: remote ${input.remote} has no readable URL: ${String(eventUrlUnreadable)}`,
                  )
                } else {
                  const launch = input.launchEvent({
                    kind: "merged",
                    issue: reference.value,
                    source: mergedEventSource(eventUrl, mergeSha),
                    text: said,
                    opId: `${mergedEventOperationId(mergeSha)}-superseded-${reference.commit.slice(0, 12)}`,
                    projectRoot: input.projectRoot,
                    declaration: { repository: input.store.repo, commit: mergeSha, target: input.target },
                    cwd: input.cwd,
                    workdir: input.workdir,
                    env: input.env ?? process.env,
                  })
                  recorded = launch.launched ? launch.log : undefined
                  if (!launch.launched) {
                    input.report(
                      `${branch}@${mergeSha}: the superseded-trailer event for ${reference.value} was not launched: ${launch.why}`,
                    )
                  }
                }
              }
              outcomes.push({
                branch,
                mergedEvent: mergedEvent.id,
                mergeSha,
                providerId: `${trailerEffectId(mergeSha, "close", "completed", reference.value)}-superseded`,
                status: "skipped",
                reason: "trailer-commit-superseded",
                commit: reference.commit,
                superseding: superseded.superseding,
                ...(reference.component === undefined ? {} : { component: reference.component }),
                ...(recorded === undefined ? {} : { log: recorded }),
              })
              continue
            }
            // 29630 (@cto baa5a4f1): the no-resend record is keyed on the merge and the trailer value it carries, and is
            // read before resolve, so an issue the provider re-keyed after a human reopened it is not closed again.
            const trailerId = trailerEffectId(mergeSha, "close", "completed", reference.value)
            completed = await readEventQueue(input.store, input.queue, { knownQueue: completed })
            const answered = completed.issueEffects[trailerId]
            if (answered !== undefined) {
              if (answered.effect.declaration.blob !== pinnedBlob) {
                throw new Error(
                  `${branch}@${mergeSha}: applied declaration blob ${answered.effect.declaration.blob} differs from pinned ${pinnedBlob}`,
                )
              }
              outcomes.push({
                branch,
                mergedEvent: mergedEvent.id,
                mergeSha,
                providerId: trailerId,
                status: "fulfilled",
              })
              continue
            }
            const resolved = await runIssuesVerb({
              verb: "resolve",
              args: [reference.value],
              stderr: reportedProviderStderr(input.report),
              projectRoot: input.projectRoot,
              // The queue's own clone holds the delivered merge; the project root may not have fetched it yet (38780).
              declarationRepository: input.store.repo,
              declarationCommit: mergeSha,
              targetCommit: input.target,
              cwd: input.cwd,
              env: input.env,
              timeoutMs: UPDATE_TIMEOUT_MS,
              signal: input.stop,
              noProgressTimeoutMs: UPDATE_TIMEOUT_MS,
            })
            if (!resolved.ok) {
              const providerId = issueProviderId(mergeSha, "resolve", undefined, reference.value)
              const diagnostic = resolved.message
              outcomes.push({
                branch,
                mergedEvent: mergedEvent.id,
                mergeSha,
                providerId,
                status: "failed",
                diagnostic,
                raw: reference.value,
              })
              input.report(`issuesProvider.resolve failed for ${branch}@${mergeSha}: ${diagnostic}`)
              continue
            }
            const keys = (resolved.envelope.result as { keys: string[] }).keys
            // Resolving this same raw reference again clears its earlier derived failure,
            // independently of the opaque keys it now names. No applied effect is granted.
            outcomes.push({
              branch,
              mergedEvent: mergedEvent.id,
              mergeSha,
              providerId: issueProviderId(mergeSha, "resolve", undefined, reference.value),
              raw: reference.value,
              status: "fulfilled",
            })
            let keysClosed = true
            let declaration: Readonly<{ repository: string; commit: string }> | undefined
            for (const key of keys) {
              // km's operation id stays per key, so a provider replay inside its window is still one close.
              const providerId = issueProviderId(mergeSha, "close", "completed", key)
              const earlier = closedKeys.get(providerId)
              if (earlier !== undefined) {
                if (!earlier) keysClosed = false
                continue
              }
              completed = await readEventQueue(input.store, input.queue, { knownQueue: completed })
              // An effect recorded per key before 29630 still answers that key for this merge.
              const fulfilled = completed.issueEffects[providerId]
              if (fulfilled !== undefined) {
                if (fulfilled.effect.declaration.blob !== pinnedBlob) {
                  throw new Error(
                    `${branch}@${mergeSha}: applied declaration blob ${fulfilled.effect.declaration.blob} differs from pinned ${pinnedBlob}`,
                  )
                }
                closedKeys.set(providerId, true)
                outcomes.push({ branch, mergedEvent: mergedEvent.id, mergeSha, providerId, status: "fulfilled" })
                continue
              }
              const closed = await runIssuesVerb({
                verb: "close",
                args: [key, "completed"],
                id: providerId,
                stderr: reportedProviderStderr(input.report),
                projectRoot: input.projectRoot,
                declarationRepository: input.store.repo,
                declarationCommit: mergeSha,
                targetCommit: input.target,
                cwd: input.cwd,
                env: input.env,
                signal: input.stop,
                timeoutMs: UPDATE_TIMEOUT_MS,
                noProgressTimeoutMs: UPDATE_TIMEOUT_MS,
              })
              if (!closed.ok) {
                const diagnostic = closed.message
                // A retry of this key can carry an identity that moved since the attempt that landed it: the
                // provider then refuses the id because the request recorded under it differs, and no effect was
                // written (the attempt died between the apply and its record). A fresh, deterministic id settles
                // it without re-deciding anything: closing an issue this merge already closed answers no-change,
                // and an issue still open is closed now, which is the same intent. One retry per key per attempt,
                // and the recorded effect below is what stops the carrying.
                let failure = diagnostic
                if (STATE_OPERATION_ID_MOVED.test(diagnostic)) {
                  const settled = await runIssuesVerb({
                    verb: "close",
                    args: [key, "completed"],
                    id: `${providerId}${SETTLED_RETRY_SUFFIX}`,
                    stderr: reportedProviderStderr(input.report),
                    projectRoot: input.projectRoot,
                    declarationRepository: input.store.repo,
                    declarationCommit: mergeSha,
                    targetCommit: input.target,
                    cwd: input.cwd,
                    env: input.env,
                    signal: input.stop,
                    timeoutMs: UPDATE_TIMEOUT_MS,
                    noProgressTimeoutMs: UPDATE_TIMEOUT_MS,
                  })
                  if (settled.ok) {
                    closedKeys.set(providerId, true)
                    declaration = settled.envelope.declaration
                    outcomes.push({ branch, mergedEvent: mergedEvent.id, mergeSha, providerId, status: "fulfilled" })
                    continue
                  }
                  // The retry's own failure is part of this attempt's evidence: the first refusal alone cannot say
                  // whether the retry was refused, lost, or never landed, and swallowing it hid why a carried branch
                  // never settled (#38952).
                  failure = `${diagnostic}; settled retry: ${settled.message}`
                }
                closedKeys.set(providerId, false)
                keysClosed = false
                outcomes.push({
                  branch,
                  mergedEvent: mergedEvent.id,
                  mergeSha,
                  providerId,
                  status: "failed",
                  diagnostic: failure,
                })
                input.report(`issuesProvider.close ${JSON.stringify(key)} failed for ${branch}@${mergeSha}: ${failure}`)
                continue
              }
              closedKeys.set(providerId, true)
              declaration = closed.envelope.declaration
              outcomes.push({ branch, mergedEvent: mergedEvent.id, mergeSha, providerId, status: "fulfilled" })
            }
            // A key that failed leaves the trailer unanswered, so the retry resolves and closes it again.
            if (!keysClosed) continue
            try {
              const declarationBlob =
                declaration === undefined
                  ? pinnedBlob
                  : (
                      await input.git.at(declaration.repository)(["rev-parse", `${declaration.commit}:issues.yml`])
                    ).trim()
              if (declarationBlob === "") throw new Error(`issues.yml blob is unreadable at ${declaration?.commit}`)
              const issueEffect: AppliedIssueEffect = {
                kind: "issue-effect-v1",
                mergedEvent: mergedEvent.id,
                mergeSha,
                mergeCommitterTime: committerTime,
                verb: "close",
                semanticEnding: "completed",
                issueKey: keys.join(" "),
                trailer: reference.value,
                providerId: trailerId,
                declaration: { path: "issues.yml", blob: declarationBlob },
              }
              try {
                await writeQueueEvent(input.store, input.queue, {
                  type: "notified",
                  at: new Date(),
                  by: "yrd-run",
                  issueEffect,
                })
              } catch (error) {
                // A rival append or lost publication reply can already have fulfilled this identity.
                completed = await readEventQueue(input.store, input.queue, { knownQueue: completed })
                if (completed.issueEffects[trailerId] === undefined) throw error
              }
              outcomes.push({
                branch,
                mergedEvent: mergedEvent.id,
                mergeSha,
                providerId: trailerId,
                status: "fulfilled",
              })
            } catch (error) {
              const diagnostic = `provider succeeded but applied effect could not be recorded: ${String(error)}`
              outcomes.push({
                branch,
                mergedEvent: mergedEvent.id,
                mergeSha,
                providerId: trailerId,
                status: "record-failed",
                diagnostic,
              })
              input.report(`${branch}@${mergeSha}: ${diagnostic}`)
            }
          }
          if (input.stop?.aborted) return { outcomes, queue: completed }
          outcomes.push({ branch, mergedEvent: mergedEvent.id, mergeSha, providerId: "", status: "fulfilled" })
        } catch (error) {
          const diagnostic = String(error)
          outcomes.push({ branch, mergedEvent: mergedEvent.id, mergeSha, providerId: "", status: "failed", diagnostic })
          input.report(`${branch}@${mergeSha}: issue close failed: ${diagnostic}`)
        }
      }
      if (input.stop?.aborted) return { outcomes, queue: completed }
      outcomes.push({ branch, mergedEvent: "", mergeSha: "", providerId: "", status: "fulfilled" })
    } catch (error) {
      const diagnostic = String(error)
      outcomes.push({ branch, mergedEvent: "", mergeSha: "", providerId: "", status: "unavailable", diagnostic })
      input.report(`${branch}: issue close history unavailable: ${diagnostic}`)
    }
  }
  return { outcomes, queue: completed }
}

/** Whether issues.yml at `commit` declares `event`, read with the interface's own parser. */
async function declaresEvent(git: GitRunner, commit: string): Promise<boolean> {
  const blob = (await git(["ls-tree", "--format=%(objectname)", commit, "--", ISSUES_DECLARATION_PATH])).trim()
  if (blob === "") return false
  const text = await git(["cat-file", "blob", blob])
  return parseIssuesDeclaration(text, `${commit}:${ISSUES_DECLARATION_PATH}`).event !== undefined
}

/**
 * The `source` a `merged` event carries: the repository as the queue's name spells it, at the merge's 40-hex sha, e.g.
 * `github.com/beorn/hh-dev@<sha>` (operator ruling absorbed in #31194). km reads it with `parseEventRef`, the one
 * parser; #31194 acceptance row 6 holds the test that proves this form against it.
 */
export function mergedEventSource(url: string, mergeSha: string): string {
  return issueEventSource(url, mergeSha)
}

/**
 * The operation id a `merged` event is written under, so a retry writes nothing. km keys its replay record by a ref
 * named after the id, one ref segment with no colon, so the ruled `yrd:<kind>:<sha>` (@cto 721b42d7 condition 2) is
 * spelled with dashes; #31194 acceptance row 4 holds the test that proves this id against km's rule.
 */
export function mergedEventOperationId(mergeSha: string): string {
  return issueEventOperationId("merged", mergeSha)
}

/** The base every other one descends from, or undefined when two are unrelated: then none is earliest. */
async function earliestBase(git: GitRunner, bases: readonly string[]): Promise<string | undefined> {
  const distinct = [...new Set(bases)]
  for (const candidate of distinct) {
    let earliest = true
    for (const other of distinct) {
      if (other !== candidate && !(await isAncestor(git, candidate, other))) {
        earliest = false
        break
      }
    }
    if (earliest) return candidate
  }
  return undefined
}

/**
 * One `merged` item event per delivered change, on the issue the change names (@cto 721b42d7, #31194). Yrd passes
 * the change's issue value as it holds it and the provider resolves it; the event's time is the provider's write
 * time. Replay-safe under {@link mergedEventOperationId}. A failed call is reported and kept as derived evidence: it
 * never holds or undoes the merge, and nothing here closes an issue (#29630 is the one close writer). Nothing is read
 * while issues.yml at the round's target declares no `event`: no event could be written.
 *
 * A branch can merge again. Its history then holds each delivery, and an earlier one's event belongs to the attempt
 * of the round that merged it; rewriting it here would write it twice once km's replay window has passed. So only
 * the branch's latest delivery, or one this attempt's rounds delivered (its merge is not an ancestor of the earliest
 * round base), is written (@cto 8a9995af). The case this loses: a round's attempt never completes and the same
 * branch merges again before any catch-up, so the earlier event is skipped for good.
 */
async function recordMergedEvents(
  input: Readonly<{
    branches: readonly string[]
    queue: string
    store: QueueLocation
    git: GitRunner
    remote: string
    /** The target this round published; every merge it delivered is its ancestor. */
    target: string
    /** The base of every round this attempt carries, at least one; the earliest is the one all others descend from. */
    bases: readonly string[]
    projectRoot?: string
    cwd: string
    /** Where the queue keeps its log tree: each launched write's own log is `<workdir>/logs/issue-events/<id>.log`. */
    workdir: string
    env?: NodeJS.ProcessEnv
    launchEvent: (input: IssueEventLaunchInput) => IssueEventLaunch
    report: (message: string) => void
    stop?: AbortSignal
  }>,
): Promise<Array<Record<string, unknown>>> {
  const outcomes: Array<Record<string, unknown>> = []
  const unrecorded: string[] = []
  const record = (outcome: Record<string, unknown>, why?: string): void => {
    outcomes.push({ verb: "event", ...outcome })
    const at =
      outcome.mergeSha === "" ? String(outcome.branch) : `${String(outcome.branch)}@${String(outcome.mergeSha)}`
    if (why !== undefined) unrecorded.push(`${at} (${why})`)
  }
  // A branch-level outcome keeps its own id, so the close path's branch rows (providerId "") never clear it.
  const branchLevel = { mergedEvent: "", mergeSha: "", providerId: "yrd-merged", status: "unavailable" } as const
  // A change history is read only for a write it can feed. The declaration at each merge still decides that merge.
  let declared: boolean
  try {
    declared = await declaresEvent(input.git, input.target)
  } catch (error) {
    const diagnostic = `merged events not recorded: issues.yml at target ${input.target} is unreadable: ${String(error)}`
    for (const branch of new Set(input.branches)) record({ ...branchLevel, branch, diagnostic })
    input.report(diagnostic)
    return outcomes
  }
  if (!declared) {
    const reason = `issues.yml declares no event at target ${input.target}`
    for (const branch of new Set(input.branches)) record({ ...branchLevel, branch, status: "skipped", reason })
    return outcomes
  }
  let url: string
  try {
    url = await remoteUrl(input.git, input.remote)
  } catch (error) {
    const diagnostic = `merged events not recorded: remote ${input.remote} has no readable URL: ${String(error)}`
    for (const branch of new Set(input.branches)) record({ ...branchLevel, branch, diagnostic })
    input.report(diagnostic)
    return outcomes
  }
  let base: string | undefined
  try {
    base = await earliestBase(input.git, input.bases)
  } catch (error) {
    const diagnostic = `merged events not recorded: round bases ${input.bases.join(", ")} are unreadable: ${String(error)}`
    for (const branch of new Set(input.branches)) record({ ...branchLevel, branch, diagnostic })
    input.report(diagnostic)
    return outcomes
  }
  if (base === undefined) {
    // Coalesced rounds whose bases are unrelated: no earliest exists, and picking one could skip or rewrite an event.
    const diagnostic = `merged events not recorded: this attempt's round bases ${[...new Set(input.bases)].join(", ")} are unrelated; neither is an ancestor of the other`
    for (const branch of new Set(input.branches)) record({ ...branchLevel, branch, diagnostic })
    input.report(diagnostic)
    return outcomes
  }
  let recorded = 0
  for (const branch of new Set(input.branches)) {
    if (input.stop?.aborted) break
    let segments: ReturnType<typeof enumerateChangeSegments>
    try {
      const reading = await readBranchHistory(input.store, input.queue, branch)
      if (reading.history === undefined) throw new Error(`post-merge named branch ${branch} has no event history`)
      segments = enumerateChangeSegments(reading.history.events, reading.ref, input.store.repo)
    } catch (error) {
      record({ ...branchLevel, branch, diagnostic: String(error) }, "history unavailable")
      continue
    }
    const delivered = segments.filter(
      (segment) => segment.state.status === "merged" && segment.state.ending?.kind === "merged",
    )
    const latest = delivered.at(-1)
    for (const segment of delivered) {
      if (input.stop?.aborted) break
      const mergedEvent = segment.events.findLast((event) => event.type === "merged")
      const mergeSha = segment.state.merge
      if (mergedEvent === undefined || mergeSha === undefined) {
        const diagnostic = `${branch}: merged segment ${segment.opened} has no actual merged event or merge SHA`
        record({ ...branchLevel, branch, diagnostic }, "no merge SHA")
        continue
      }
      const providerId = mergedEventOperationId(mergeSha)
      const identity = { branch, mergedEvent: mergedEvent.id, mergeSha, providerId }
      if (segment !== latest) {
        let before: boolean
        try {
          before = await isAncestor(input.git, mergeSha, base)
        } catch (error) {
          record({ ...identity, status: "failed", diagnostic: String(error) }, String(error))
          continue
        }
        if (before) {
          // What the code knows is the ancestry, never that the earlier event exists.
          record({
            ...identity,
            status: "skipped",
            reason: `not rewritten: merged at ${mergeSha} before this round's base`,
          })
          continue
        }
      }
      const issue = segment.state.issue
      if (issue === undefined || issue === "") {
        // Named only once the event is live at that merge; before then no change is counted.
        let live: boolean
        try {
          live = await declaresEvent(input.git, mergeSha)
        } catch (error) {
          record({ ...identity, status: "failed", diagnostic: String(error) }, String(error))
          continue
        }
        if (live) record({ ...identity, status: "skipped", reason: "no-issue" }, "names no issue")
        else record({ ...identity, status: "skipped", reason: "issues.yml declares no event at the merge" })
        continue
      }
      // hh #38766 (@cto 15f0394a, e72bc1a0): the write is launched, never awaited. One provider write costs ~35 s
      // against a healthy km and is unbounded while km holds its write lane; a merge round is serial, so waiting on it
      // slowed every merge. The child owns the outcome and says so itself: on failure it writes this branch's `failed`
      // event, by name, under `<id>-failed`, so the abandoned-issue rail hears it without the round holding still.
      const launched = input.launchEvent({
        kind: "merged",
        issue,
        source: mergedEventSource(url, mergeSha),
        text: `${branch} merged at ${mergeSha}`,
        opId: providerId,
        projectRoot: input.projectRoot ?? input.cwd,
        declaration: { repository: input.store.repo, commit: mergeSha, target: input.target },
        cwd: input.cwd,
        workdir: input.workdir,
        env: input.env ?? process.env,
        fallback: { kind: "failed", text: `${branch} merged event for ${mergeSha} did not land` },
      })
      if (launched.launched) {
        recorded++
        record({ ...identity, status: "launched", issue, log: launched.log })
      } else {
        record({ ...identity, status: "failed", issue, diagnostic: launched.why }, launched.why)
      }
    }
  }
  if (unrecorded.length > 0) {
    input.report(`merged events: ${recorded} recorded, ${unrecorded.length} not recorded: ${unrecorded.join("; ")}`)
  }
  return outcomes
}

/** Serial provider writes and serial cleanup have independent lifetimes; attempt evidence is never replay authority. */
export function createPostMerge<C extends Context>(
  options: Readonly<{
    workdir: string
    cwd: string
    env?: NodeJS.ProcessEnv
    stop?: AbortSignal
    cleanup: (context: C) => Promise<void>
    report: (message: string) => void
    git?: GitRunner
    store?: QueueLocation
    /**
     * How a merged item event is started (hh #38766): production launches a detached child, and the fixtures inject a
     * recorder so a unit test proves the launch without spawning one.
     */
    launchEvent?: (input: IssueEventLaunchInput) => IssueEventLaunch
    /** Told the branches given up on after {@link POST_MERGE_ATTEMPTS} failures; a throw here is reported, never raised. */
    abandoned?: (context: C, abandoned: readonly AbandonedPostMerge[]) => Promise<void>
  }>,
) {
  const directory = join(options.workdir, "post-merge")
  const evidenceFailures = new Set<string>()
  const evidence = (path: string, write: () => void): void => {
    try {
      write()
    } catch (error) {
      if (!evidenceFailures.has(path)) {
        options.report("post-merge evidence unavailable at " + path + ": " + String(error))
      }
      evidenceFailures.add(path)
    }
  }
  evidence(directory, () => {
    mkdirSync(directory, { recursive: true })
  })
  // Called only after this service has acquired its existing queue ownership.
  // Only labels are repaired: neither update nor cleanup decides from these bytes.
  const recover = (): void => {
    let previousNames: string[] = []
    evidence(directory, () => {
      previousNames = readdirSync(directory)
    })
    for (const name of previousNames) {
      if (!name.endsWith(".json")) continue
      const path = join(directory, name)
      try {
        const previous = readPostMergeAttempt(path).value
        if (previous.status === "running") {
          atomicWriteFileSync(
            path,
            JSON.stringify({ ...previous, status: "interrupted", interruptedAt: new Date().toISOString() }) + "\n",
          )
        }
      } catch (error) {
        options.report("post-merge evidence unavailable at " + path + ": " + String(error))
      }
    }
  }
  /** The next attempt's context, and the base of every round coalesced into it: the attempt resolves the earliest. */
  let pending: Readonly<{ context: C; bases: ReadonlyArray<string | undefined> }> | undefined
  /** A failed attempt's branches, waiting for the next nudge (37513); folded into `pending` as soon as one exists. */
  let carried: Readonly<{ context: C; bases: ReadonlyArray<string | undefined> }> | undefined
  /** Failed attempts per merged branch since its last settled one (37513). */
  const failures = new Map<string, number>()
  /**
   * The base of the round that last delivered each branch still owed (37513). A carried branch takes only its own
   * round's base, so a branch that settled never keeps an early base live, which would stop recordMergedEvents
   * skipping an earlier delivery of a branch merged again (@dev/4).
   */
  const baseOf = new Map<string, string | undefined>()
  let active: Promise<void> | undefined
  let cleanupPending: C | undefined
  let cleanupActive: Promise<void> | undefined
  let closing = false
  const coalesce = (previous: C | undefined, context: C): C =>
    previous === undefined
      ? context
      : {
          ...context,
          merged: [...new Set([...previous.merged, ...context.merged])],
        }
  // The existing service stays resident: keep only its last validated snapshot across sequential attempts.
  let completedQueue: Readonly<{ branch: string; value: EventQueue }> | undefined
  const dropPending = (): void => {
    if (carried !== undefined) {
      options.report(
        JSON.stringify(carried.context.merged) +
          ": failed post-merge issue updates dropped during shutdown; the next service's startup catch-up retries them",
      )
      carried = undefined
    }
    if (pending === undefined) return
    options.report(
      JSON.stringify(pending.context.merged) +
        ": pending post-merge attempt dropped during shutdown; startup catch-up handles remaining environment rows; branches without rows need branch triage",
    )
    pending = undefined
  }
  const dropCleanupPending = (): void => {
    if (cleanupPending === undefined) return
    options.report(
      JSON.stringify(cleanupPending.merged) +
        ": pending post-merge cleanup dropped during shutdown; startup catch-up handles remaining environment rows; branches without rows need branch triage",
    )
    cleanupPending = undefined
  }
  const pumpCleanup = async (): Promise<void> => {
    while (cleanupPending !== undefined && !options.stop?.aborted) {
      const next = cleanupPending
      cleanupPending = undefined
      try {
        await options.cleanup(next)
      } catch (error) {
        options.report(
          "post-merge cleanup failed for " + next.target + "; retained for the next catch-up: " + String(error),
        )
      }
    }
    if (options.stop?.aborted) dropCleanupPending()
  }
  const startCleanup = (): void => {
    cleanupActive = pumpCleanup()
      .catch((error) => options.report("post-merge cleanup failed: " + String(error)))
      .finally(() => {
        cleanupActive = undefined
        if (cleanupPending !== undefined && !options.stop?.aborted) startCleanup()
      })
  }
  const scheduleCleanup = (context: C): void => {
    cleanupPending = coalesce(cleanupPending, context)
    if (cleanupActive === undefined) startCleanup()
  }
  /** The round's `merged` item events; a failure is reported and returned, never thrown into the update or close. */
  const mergedEvents = async (
    context: C,
    rounds: ReadonlyArray<string | undefined>,
  ): Promise<Readonly<{ actions: Array<Record<string, unknown>>; failed: boolean }>> => {
    if (context.merged.length === 0) return { actions: [], failed: false }
    const { git, store } = options
    const { queueBranch, remote } = context
    const bases = rounds.filter((base): base is string => base !== undefined)
    if (
      git === undefined ||
      store === undefined ||
      queueBranch === undefined ||
      remote === undefined ||
      bases.length === 0 ||
      bases.length < rounds.length
    ) {
      const missing = [
        ...(git === undefined ? ["git"] : []),
        ...(store === undefined ? ["store"] : []),
        ...(queueBranch === undefined ? ["queueBranch"] : []),
        ...(remote === undefined ? ["remote"] : []),
        ...(bases.length === 0 || bases.length < rounds.length ? ["base"] : []),
      ]
      // Reported, not counted as failed: production cannot arrive here. queue-core-commands.ts creates this runner
      // with git and store, and its context type requires queueBranch, remote and base; only the unit tests of the
      // update, close and cleanup lifetimes omit them.
      options.report(`merged events not recorded: missing input(s) ${missing.join(", ")}`)
      return { actions: [], failed: false }
    }
    try {
      const actions = await recordMergedEvents({
        branches: context.merged,
        queue: queueBranch,
        store,
        git,
        remote,
        target: context.target,
        bases,
        ...(context.projectRoot === undefined ? {} : { projectRoot: context.projectRoot }),
        cwd: options.cwd,
        workdir: options.workdir,
        env: options.env,
        launchEvent: options.launchEvent ?? launchIssueEvent,
        report: options.report,
        stop: options.stop,
      })
      return { actions, failed: actions.some(({ status }) => status === "failed" || status === "unavailable") }
    } catch (error) {
      options.report("merged events not recorded: " + String(error))
      return { actions: [], failed: true }
    }
  }
  const attempt = async (context: C, bases: ReadonlyArray<string | undefined>): Promise<AttemptOutcome> => {
    const id = new Date().toISOString().replaceAll(":", "-") + "-" + randomUUID()
    const path = join(directory, id + ".json")
    const stdout = join(directory, id + ".stdout.log")
    const stderr = join(directory, id + ".stderr.log")
    const startedAt = new Date().toISOString()
    const provenance = { ...context, bases, cwd: options.cwd, startedAt, stdout, stderr }
    evidence(stdout, () => {
      writeFileSync(stdout, "")
    })
    evidence(stderr, () => {
      writeFileSync(stderr, "")
    })
    evidence(path, () => {
      atomicWriteFileSync(path, JSON.stringify({ ...provenance, status: "running" }) + "\n")
    })
    let issueActions: Array<Record<string, unknown>> = []
    // 29630 (@cto 5a66fb46): no provider update runs here; Yrd's own closer below is the only issue writer.
    let settled: Record<string, unknown> =
      context.merged.length === 0 ? { status: "skipped", reason: "nothing merged this round" } : { status: "succeeded" }
    let eventsFailed = false
    /** Set when the failure names no branch: the attempt as a whole (37513). */
    let failedWhole = false
    try {
      // Before the update and the close, so an issue reads merged, then closed. Never needs --project-root.
      const events = await mergedEvents(context, bases)
      issueActions = events.actions
      eventsFailed = events.failed
      // An event write that failed without a branch row names nobody, so it is charged to every branch (@dev/4).
      if (
        events.failed &&
        !events.actions.some(({ status, branch }) => failingStatus(status) && typeof branch === "string")
      ) {
        failedWhole = true
      }
      if (
        context.merged.length > 0 &&
        options.git !== undefined &&
        options.store !== undefined &&
        context.projectRoot !== undefined &&
        context.queueBranch !== undefined
      ) {
        const closed = await closeMergedIssues({
          branches: context.merged,
          queue: context.queueBranch,
          store: options.store,
          git: options.git,
          projectRoot: context.projectRoot,
          target: context.target,
          workdir: options.workdir,
          cwd: options.cwd,
          env: options.env,
          report: options.report,
          stop: options.stop,
          knownQueue: completedQueue?.branch === context.queueBranch ? completedQueue.value : undefined,
          ...(context.remote === undefined ? {} : { remote: context.remote }),
          launchEvent: options.launchEvent ?? launchIssueEvent,
        })
        issueActions = [...issueActions, ...closed.outcomes]
        if (
          issueActions.some(
            ({ status }) => status === "failed" || status === "unavailable" || status === "record-failed",
          )
        ) {
          settled = { ...settled, status: "failed" }
        }
        if (closed.queue !== undefined) completedQueue = { branch: context.queueBranch, value: closed.queue }
      } else if (context.merged.length > 0 && context.projectRoot === undefined) {
        options.report(
          "automatic issue close skipped: pass --project-root <path> to opt in; issues.yml must be committed at the delivered merge in that repository",
        )
      } else if (context.merged.length > 0) {
        const missing = [
          ...(options.git === undefined ? ["git"] : []),
          ...(options.store === undefined ? ["store"] : []),
          ...(context.queueBranch === undefined ? ["queueBranch"] : []),
        ]
        const reason = `automatic issue close unavailable: explicit projectRoot ${context.projectRoot} has missing input(s): ${missing.join(", ")}`
        settled = { status: "unavailable", reason }
        options.report(reason)
      }
      if (eventsFailed) settled = { ...settled, status: "failed" }
    } catch (error) {
      const reason = "post-merge issue close attempt unavailable: " + String(error)
      failedWhole = true
      settled = { status: "unavailable", reason }
      options.report(reason)
    } finally {
      evidence(path, () => {
        atomicWriteFileSync(
          path,
          JSON.stringify({ ...provenance, ...settled, issueActions, endedAt: new Date().toISOString() }) + "\n",
        )
      })
      // Its own provider has settled; earlier cleanup must not hold up the
      // next provider. The separate cleanup lifetime still owns serial drain.
      scheduleCleanup(context)
    }
    if (settled.status !== "failed" && settled.status !== "unavailable") {
      return { failed: [], reason: "", evidence: path }
    }
    const diagnostic = issueActions.find((action) => failingStatus(action.status) && "diagnostic" in action)
    const reason = [
      String(settled.status),
      ...(typeof settled.exitCode === "number" ? ["exit " + String(settled.exitCode)] : []),
      ...(typeof settled.signal === "string" ? ["signal " + settled.signal] : []),
      ...(settled.timedOut === true ? ["timed out"] : []),
      ...(typeof settled.reason === "string" ? [settled.reason] : []),
      ...(diagnostic !== undefined && "diagnostic" in diagnostic ? [String(diagnostic.diagnostic)] : []),
    ].join(", ")
    return { failed: chargedBranches(context.merged, issueActions, failedWhole), reason, evidence: path }
  }
  /** Fold the carried branches into `pending`, whose newer context wins every field but `merged`. */
  const foldCarried = (): void => {
    if (carried === undefined) return
    pending =
      pending === undefined
        ? carried
        : { context: coalesce(carried.context, pending.context), bases: [...carried.bases, ...pending.bases] }
    carried = undefined
  }
  /** Carry what an attempt left owed into the next attempt, or name it after the last allowed failure (37513). */
  const settle = async (next: NonNullable<typeof pending>, outcome: AttemptOutcome): Promise<void> => {
    // A reload's abort fails its in-flight attempt on purpose; the next service's startup catch-up owns it.
    if (options.stop?.aborted) return
    for (const branch of next.context.merged) {
      if (outcome.failed.includes(branch)) continue
      failures.delete(branch)
      baseOf.delete(branch)
    }
    const again: string[] = []
    const given: AbandonedPostMerge[] = []
    for (const branch of outcome.failed) {
      const count = (failures.get(branch) ?? 0) + 1
      if (count < POST_MERGE_ATTEMPTS) {
        failures.set(branch, count)
        again.push(branch)
      } else {
        failures.delete(branch)
        baseOf.delete(branch)
        given.push({ branch, attempts: count, reason: outcome.reason, evidence: outcome.evidence })
      }
    }
    if (again.length > 0) {
      const bases = [...new Set(again.map((branch) => baseOf.get(branch)))]
      const owed = { context: { ...next.context, merged: again }, bases }
      carried =
        carried === undefined
          ? owed
          : { context: coalesce(carried.context, owed.context), bases: [...carried.bases, ...owed.bases] }
      if (pending !== undefined) foldCarried()
    }
    if (given.length === 0) return
    for (const each of given) {
      options.report(
        "post-merge issue update for " +
          each.branch +
          " failed " +
          String(each.attempts) +
          " attempts and is no longer carried: " +
          each.reason +
          "; evidence " +
          each.evidence +
          "; its issue stays open until its close is rerun",
      )
    }
    // A reload's stop wins over the hand-off: the line above already names each branch.
    if (options.stop?.aborted) return
    try {
      await options.abandoned?.(next.context, given)
    } catch (error) {
      options.report(
        "could not hand on the abandoned post-merge updates for " +
          JSON.stringify(given.map(({ branch }) => branch)) +
          ": " +
          String(error),
      )
    }
  }
  const pump = async (): Promise<void> => {
    while (pending !== undefined && !options.stop?.aborted) {
      const next = pending
      pending = undefined
      await settle(next, await attempt(next.context, next.bases))
    }
    if (options.stop?.aborted) dropPending()
  }
  const start = (): void => {
    active = pump()
      .catch((error) => options.report("post-merge attempt failed: " + String(error)))
      .finally(() => {
        active = undefined
        if (pending !== undefined && !options.stop?.aborted) start()
      })
  }
  const nudge = (context: C): void => {
    if (closing) return
    for (const branch of context.merged) {
      // A branch still owed keeps its earlier round's base: that base precedes both deliveries, so a re-merge
      // during an outage does not skip the earlier delivery's merged event (@dev/4 GO 546f9f23).
      if (!baseOf.has(branch)) baseOf.set(branch, context.base)
      failures.delete(branch)
    }
    foldCarried()
    // Coalescing keeps the newest round's context; its bases keep every round's, so no delivery is skipped (#31194).
    pending = { context: coalesce(pending?.context, context), bases: [...(pending?.bases ?? []), context.base] }
    if (active !== undefined) return
    start()
  }
  const drain = async (): Promise<void> => {
    while (active !== undefined) await active
  }
  const close = async (): Promise<void> => {
    closing = true
    // Production reload aborts first. Without abort, an active attempt's
    // finally may still offer its own cleanup; both lifetimes drain below.
    if (options.stop !== undefined) {
      dropPending()
      dropCleanupPending()
    }
    await drain()
    while (cleanupActive !== undefined) await cleanupActive
  }
  return { nudge, recover, [Symbol.asyncDispose]: close }
}
