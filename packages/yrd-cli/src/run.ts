import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { Command as CliCommand, CommanderError, Help, int } from "@silvery/commander"
import { createElement } from "react"
import {
  CompositionV1Schema,
  baseIdentity,
  resolveBay,
  resolvePR,
  type Bay,
  type BaysState,
  type CompositionV1,
  type PR,
} from "@yrd/bay"
import type { Contest } from "@yrd/contest"
import type { Job } from "@yrd/job"
import type { QueueRun, QueueSummary } from "@yrd/queue"
import { classifyFailure, configuration, refusal, resolveInvocation, stableJson, usage } from "./invocation.ts"
import { getLiveRenderer } from "./live-renderer.ts"
import {
  QueueLogView,
  QueueListView,
  PRRunsView,
  QueueRunsView,
  QueueWatchView,
  QueueStatusView,
  type QueueLogCoverage,
  PRResultView,
  queueLogAttempts,
  queueLogRows,
  queueRevisionKey,
  queueShowData,
  queueSubmissionTimes,
  type QueueStatusResult,
} from "./queue-status-view.tsx"
import { submittedPrPositions } from "./queue-position.ts"
import { diagnostic, printHuman, printResult } from "./output.tsx"
import { BayStatusView, ContestStatusView, IssueLensView, type IssueLensRow } from "./status-view.tsx"
import type { YrdCliApp, YrdCliExitCode, YrdCliIO, YrdCliServices, YrdCliState } from "./types.ts"
import { YRD_VERSION } from "./version.ts"
import { QueueWatchPane, type QueueWatchSnapshot } from "./watch-pane.tsx"

function queueGitDir(cwd: string): string | undefined {
  try {
    const output = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    const gitDir = output.trim()
    if (gitDir === "") return undefined
    return isAbsolute(gitDir) ? gitDir : resolve(cwd, gitDir)
  } catch {
    return undefined
  }
}

function commitSubject(cwd: string, headSha: string): string | undefined {
  try {
    const subject = execFileSync(
      "git",
      ["-C", cwd, "show", "-s", "--format=%s", "--no-show-signature", headSha, "--"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trimEnd()
    return subject === "" ? undefined : subject
  } catch {
    return undefined
  }
}

async function firstEventTimestamp(app: YrdCliApp): Promise<string> {
  for await (const event of app.events()) return event.ts
  return "-"
}

async function queueLegacyCoverage(cwd: string, since: string): Promise<QueueLogCoverage | undefined> {
  const gitDir = queueGitDir(cwd)
  if (gitDir === undefined) return undefined
  const paths = [join(gitDir, "yrd", "events.jsonl"), join(gitDir, "bay", "journal.jsonl")]
  const legacy = (
    await Promise.all(
      paths.map(async (path) => {
        try {
          const content = await readFile(path, "utf8")
          return { path, frames: content.split(/\r?\n/u).filter((value) => value.trim() !== "").length }
        } catch (error) {
          if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
            return undefined
          }
          throw error
        }
      }),
    )
  ).filter((coverage): coverage is { path: string; frames: number } => coverage !== undefined)
  return legacy.length === 0 ? undefined : { since, completeness: "queue-only", legacy }
}

type RuntimeOptions = {
  runner: string
  leaseMs: number
  now?: () => number
}

type WatchOptions = Readonly<{ base?: string; pr?: string; json?: boolean }>

type JsonOption = { json?: boolean }

function runtimeOptions(io: YrdCliIO): RuntimeOptions {
  return {
    runner: io.runner ?? "yrd-cli",
    leaseMs: io.leaseMs ?? 5 * 60_000,
    ...(io.now === undefined ? {} : { now: io.now }),
  }
}

function stateOf(app: YrdCliApp): YrdCliState {
  return app.state()
}

async function runJobs(app: YrdCliApp, ids: readonly string[], io: YrdCliIO): Promise<Job[]> {
  return [...(await app.jobs.runMany(ids, runtimeOptions(io)))]
}

function assertJobsPassed(runs: readonly Job[], action: string): void {
  const unresolved = runs.find((run) => run.status !== "passed")
  if (unresolved === undefined) return
  const detail =
    (unresolved.status === "failed" ? unresolved.error.message : undefined) ??
    (unresolved.status === "lost" ? unresolved.lostReason : undefined) ??
    ("detail" in unresolved ? unresolved.detail : undefined) ??
    unresolved.status
  refusal(`${action} ${unresolved.status}: ${detail}`)
}

function within(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child))
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

function currentBay(state: BaysState, cwd: string): Bay | undefined {
  return Object.values(state.byId)
    .filter((bay) => bay.path !== undefined && within(bay.path, cwd))
    .toSorted((left, right) => (right.path?.length ?? 0) - (left.path?.length ?? 0))[0]
}

function sortedBays(state: BaysState): Bay[] {
  return Object.values(state.byId).toSorted((left, right) =>
    left.id.localeCompare(right.id, undefined, { numeric: true }),
  )
}

function unique<Value extends { id: string }>(values: readonly Value[]): Value[] {
  return [...new Map(values.map((value) => [value.id, value])).values()]
}

function byQueueRunChronology(left: QueueRun, right: QueueRun): number {
  const started = left.startedAt.localeCompare(right.startedAt)
  return started === 0 ? left.id.localeCompare(right.id, undefined, { numeric: true }) : started
}

export function mergedQueueRuns(
  canonical: QueueSummary,
  aliases: readonly QueueSummary[],
): Pick<QueueSummary, "running" | "waiting" | "finished"> {
  const canonicalIds = new Set([...canonical.running, ...canonical.waiting, ...canonical.finished].map((run) => run.id))
  const merge = (key: "running" | "waiting" | "finished"): QueueRun[] =>
    unique([
      ...aliases.flatMap((summary) => summary[key]).filter((run) => !canonicalIds.has(run.id)),
      ...canonical[key],
    ]).toSorted(byQueueRunChronology)
  return { running: merge("running"), waiting: merge("waiting"), finished: merge("finished") }
}

function selectedBays(state: BaysState, selectors: readonly string[], cwd: string, action: string): Bay[] {
  if (selectors.length > 0) {
    return unique(
      selectors.map((selector) => {
        const bay = resolveBay(state, selector)
        if (bay === undefined) refusal(`no bay '${selector}'`)
        return bay
      }),
    )
  }
  const local = currentBay(state, cwd)
  if (local !== undefined) return [local]
  const live = sortedBays(state).filter((bay) => bay.status !== "closed")
  if (live.length === 0) refusal(`no bays are available to ${action}`)
  return live
}

function csv(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (value === true) return []
  const values = Array.isArray(value) ? value : [value]
  const result = values.flatMap((item) => {
    if (typeof item !== "string") usage("expected a comma-separated list")
    return item
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
  })
  return result
}

function oneOfAliases(primary: unknown, alias: unknown, primaryName: string, aliasName: string): string | undefined {
  if (primary !== undefined && alias !== undefined && primary !== alias) {
    usage(`--${primaryName} and --${aliasName} disagree`)
  }
  const value = primary ?? alias
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.trim() === "") usage(`--${primaryName} requires a non-empty value`)
  return value
}

function jsonEnabled(options: JsonOption): boolean {
  return options.json === true
}

async function openBay(
  app: YrdCliApp,
  name: string,
  options: {
    from?: string
    head?: string
    base?: string
    queue?: string
    issue?: string
    actor?: string
    json?: boolean
  },
  io: YrdCliIO,
  command = "bay.open",
  pr?: string,
): Promise<void> {
  const from = oneOfAliases(options.from, options.head, "from", "head")
  const base = oneOfAliases(options.base, options.queue, "base", "queue")
  const result = await app.bays.open({
    name,
    ...(options.issue === undefined ? {} : { issue: options.issue }),
    ...(options.actor === undefined ? {} : { actor: options.actor }),
    ...(from === undefined ? {} : { from }),
    ...(base === undefined ? {} : { base }),
  })
  assertJobsPassed(await runJobs(app, app.jobs.requested(result), io), `bay '${name}' provision`)
  const bay = app.bays.get(name)
  if (bay?.path === undefined || bay.status !== "active") refusal(`bay '${name}' did not become active`)
  await printResult(
    io,
    jsonEnabled(options),
    { command, ...(pr === undefined ? {} : { pr }), bay },
    createElement(BayStatusView, { bays: [bay] }),
  )
}

async function refreshBays(
  app: YrdCliApp,
  selectors: readonly string[],
  options: JsonOption,
  io: YrdCliIO,
): Promise<void> {
  const state = stateOf(app)
  const bays = selectedBays(state.bays, selectors, io.cwd ?? process.cwd(), "refresh")
  const refreshed: Bay[] = []
  for (const bay of bays) {
    refreshed.push(await refreshBay(app, bay, io))
  }
  await printResult(
    io,
    jsonEnabled(options),
    { command: "bay.refresh", bays: refreshed },
    createElement(BayStatusView, { bays: refreshed }),
  )
}

async function refreshBay(app: YrdCliApp, bay: Bay, io: YrdCliIO): Promise<Bay> {
  const result = await app.bays.refresh({ bay: bay.id })
  assertJobsPassed(await runJobs(app, app.jobs.requested(result), io), `bay '${bay.id}' refresh`)
  const refreshed = app.bays.get(bay.id)
  if (refreshed === undefined) throw new Error(`yrd: bay '${bay.id}' disappeared after refresh`)
  return refreshed
}

async function closeBays(
  app: YrdCliApp,
  selectors: readonly string[],
  options: { withdraw?: boolean; json?: boolean },
  io: YrdCliIO,
): Promise<void> {
  const bays = selectedBays(stateOf(app).bays, selectors, io.cwd ?? process.cwd(), "close")
  const closed: Bay[] = []
  for (const bay of bays) {
    const result = await app.bays.close({
      bay: bay.id,
      ...(options.withdraw === true ? { withdraw: true } : {}),
    })
    assertJobsPassed(await runJobs(app, app.jobs.requested(result), io), `bay '${bay.id}' close`)
    const current = app.bays.get(bay.id)
    if (current === undefined) throw new Error(`yrd: bay '${bay.id}' disappeared after close`)
    closed.push(current)
  }
  await printResult(
    io,
    jsonEnabled(options),
    { command: "bay.close", bays: closed },
    createElement(BayStatusView, { bays: closed }),
  )
}

async function closePrs(
  app: YrdCliApp,
  selectors: readonly string[],
  options: JsonOption,
  io: YrdCliIO,
): Promise<void> {
  if (selectors.length === 0) usage("pr close requires at least one PR selector")
  const prs: PR[] = []
  for (const selector of selectors) {
    await app.bays.closePr({ pr: selector })
    const pr = app.bays.pr(selector)
    if (pr === undefined) throw new Error(`yrd: PR '${selector}' disappeared after close`)
    prs.push(pr)
  }
  await printResult(
    io,
    jsonEnabled(options),
    { command: "pr.close", prs },
    createElement(PRResultView, { prs, runs: [] }),
  )
}

async function optionalRevision(ref: string, io: YrdCliIO): Promise<string | undefined> {
  const cwd = io.cwd ?? process.cwd()
  return io.resolveRevision?.(ref, cwd)
}

async function resolvedQueueTarget(ref: string, io: YrdCliIO): Promise<Readonly<{ base: string; sha?: string }>> {
  const cwd = io.cwd ?? process.cwd()
  if (io.resolveQueueTarget !== undefined) {
    const target = await io.resolveQueueTarget(ref, cwd)
    return { ...target, base: baseIdentity(target.base) }
  }
  const sha = await optionalRevision(ref, io)
  return { base: baseIdentity(ref), ...(sha === undefined ? {} : { sha }) }
}

type QueueTargetGroup = Readonly<{ base: string; aliases: ReadonlySet<string>; headSha?: string }>

async function queueTargetGroups(bases: ReadonlySet<string>, io: YrdCliIO): Promise<QueueTargetGroup[]> {
  const groups = new Map<string, { aliases: Set<string>; headSha?: string }>()
  for (const ref of [...bases].toSorted()) {
    const target = await resolvedQueueTarget(ref, io)
    const group = groups.get(target.base) ?? { aliases: new Set<string>() }
    group.aliases.add(ref)
    group.aliases.add(baseIdentity(ref))
    group.aliases.add(target.base)
    if (target.sha !== undefined) group.headSha = target.sha
    groups.set(target.base, group)
  }
  return [...groups.entries()].map(([base, group]) => ({ base, ...group }))
}

async function submitBays(
  app: YrdCliApp,
  selectors: readonly string[],
  options: { base?: string; queue?: string; issue?: string; composition?: string; json?: boolean },
  io: YrdCliIO,
  command: "bay.submit" | "pr.submit",
): Promise<YrdCliExitCode> {
  const state = stateOf(app)
  const inferred =
    selectors.length > 0
      ? [...selectors]
      : selectedBays(state.bays, [], io.cwd ?? process.cwd(), "submit").map((bay) => bay.id)
  const prs: PR[] = []
  const base = oneOfAliases(options.base, options.queue, "base", "queue")
  const composition = await readComposition(options.composition, io)
  if (composition !== undefined && inferred.length !== 1) {
    usage("--composition requires exactly one bay or branch selector")
  }
  for (const selector of inferred) {
    const pr = await app.bays.submitSelection(selector, {
      ...(base === undefined ? {} : { base }),
      ...(options.issue === undefined ? {} : { issue: options.issue }),
      ...(composition === undefined ? {} : { composition }),
      resolveRevision: (ref) => optionalRevision(ref, io),
      run: runtimeOptions(io),
    })
    prs.push(pr)
  }
  await printResult(io, jsonEnabled(options), { command, prs }, createElement(PRResultView, { prs, runs: [] }))
  return 0
}

async function readComposition(path: string | undefined, io: YrdCliIO): Promise<CompositionV1 | undefined> {
  if (path === undefined) return undefined
  const absolute = resolve(io.cwd ?? process.cwd(), path)
  try {
    return CompositionV1Schema.parse(JSON.parse(await readFile(absolute, "utf8")))
  } catch (cause) {
    usage(
      `invalid composition manifest '${path}': ${cause instanceof Error ? cause.message : String(cause)}; ` +
        "provide version 1 with normalized repo-relative payload paths",
    )
  }
}

function requiredPr(app: YrdCliApp, selector: string): PR {
  const pr = app.bays.pr(selector)
  if (pr === undefined) refusal(`no PR '${selector}'`)
  return pr as PR
}

function allQueueRuns(app: YrdCliApp): QueueRun[] {
  return Object.keys(stateOf(app).queues.records)
    .map((id) => app.queue.get(id))
    .filter((run): run is QueueRun => run !== undefined)
    .toSorted(byQueueRunChronology)
}

function prQueueRuns(app: YrdCliApp, pr: PR): QueueRun[] {
  return allQueueRuns(app).filter((run) => run.prs.some((member) => member.id === pr.id))
}

async function listBays(app: YrdCliApp, options: JsonOption, io: YrdCliIO): Promise<void> {
  const bays = app.bays.list()
  await printResult(io, jsonEnabled(options), { command: "bay.list", bays }, createElement(BayStatusView, { bays }))
}

async function listPrs(
  app: YrdCliApp,
  options: JsonOption & Readonly<{ base?: string; state?: string; issue?: string }>,
  io: YrdCliIO,
): Promise<void> {
  const prs = app.bays
    .prs()
    .filter((pr) => options.base === undefined || baseIdentity(pr.base) === baseIdentity(options.base))
    .filter((pr) => options.state === undefined || pr.status === options.state)
    .filter((pr) => options.issue === undefined || pr.issue === options.issue)
  const selected = new Set(prs.map((pr) => pr.id))
  const runs = allQueueRuns(app).filter((run) => run.prs.some((member) => selected.has(member.id)))
  await printResult(
    io,
    jsonEnabled(options),
    { command: "pr.list", prs, runs },
    createElement(PRResultView, { prs, runs }),
  )
}

async function viewPr(
  app: YrdCliApp,
  selector: string,
  options: JsonOption,
  io: YrdCliIO,
  command = "pr.view",
): Promise<void> {
  const pr = requiredPr(app, selector)
  const state = stateOf(app)
  const target = resolveQueueTargets(state, [pr.id], undefined, pr.id)
  const { results } = await queueStatusSnapshots(app, state, target, io)
  const positions = pr.status === "submitted" ? await queuedPrPositions(state, pr.base, io) : undefined
  const position = positions?.get(pr.id)
  await printResult(
    io,
    jsonEnabled(options),
    { command, pr, ...(position === undefined ? {} : { position }), results },
    createElement(QueueStatusView, {
      state: state.bays,
      results,
      selected: target.selected,
      ...(positions === undefined ? {} : { positions }),
      now: io.now?.() ?? Date.now(),
    }),
  )
}

async function viewPrRuns(app: YrdCliApp, selector: string, options: JsonOption, io: YrdCliIO): Promise<void> {
  const pr = requiredPr(app, selector)
  const runs = prQueueRuns(app, pr)
  const attempts = await queueLogAttempts(app.events())
  const data = runs.map((run) => queueShowData(run, runs, attempts))
  await printResult(
    io,
    jsonEnabled(options),
    { command: "pr.runs", pr, runs: data },
    createElement(PRRunsView, { runs: data }),
  )
}

async function diffPr(
  app: YrdCliApp,
  selector: string,
  options: JsonOption & Readonly<{ stat?: boolean }>,
  io: YrdCliIO,
): Promise<void> {
  const pr = requiredPr(app, selector)
  const cwd = io.cwd ?? process.cwd()
  const base = pr.baseSha ?? pr.base
  let diff: string
  try {
    diff = execFileSync(
      "git",
      ["-C", cwd, "diff", ...(options.stat === true ? ["--stat"] : []), `${base}...${pr.headSha}`, "--"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    )
  } catch (error) {
    refusal(`cannot diff PR '${pr.id}': ${error instanceof Error ? error.message : String(error)}`)
  }
  const composition = pr.composition
  const rendered =
    composition === undefined
      ? diff
      : [
          "Source composition (the Queue generates the root gitlink wrapper):",
          ...composition.sources.flatMap((source) => [
            `  ${source.repo} ${source.branch} ${source.baseSha.slice(0, 12)}..${source.tipSha.slice(0, 12)}`,
            ...source.payload.map((path) => `    ${path}`),
          ]),
          "",
          "Root diff:",
          diff === "" ? "  (none before Candidate construction)" : diff,
        ].join("\n")
  await printResult(
    io,
    jsonEnabled(options),
    {
      command: "pr.diff",
      pr: pr.id,
      base,
      head: pr.headSha,
      ...(composition === undefined ? {} : { composition }),
      diff,
    },
    rendered,
  )
}

async function checkoutPr(
  app: YrdCliApp,
  selector: string,
  options: JsonOption & Readonly<{ bay?: string }>,
  io: YrdCliIO,
): Promise<void> {
  const pr = requiredPr(app, selector)
  const name = options.bay ?? `pr-${pr.id.toLowerCase()}`
  await openBay(
    app,
    name,
    { from: pr.branch, base: pr.base, ...(pr.issue === undefined ? {} : { issue: pr.issue }), ...options },
    io,
    "pr.checkout",
    pr.id,
  )
}

function currentGitBranch(cwd: string, io: YrdCliIO): string | undefined {
  const injected = io.currentBranch?.(cwd)
  if (injected !== undefined) return injected
  try {
    const branch = execFileSync("git", ["-C", cwd, "branch", "--show-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
    return branch === "" ? undefined : branch
  } catch {
    return undefined
  }
}

function currentPr(app: YrdCliApp, io: YrdCliIO): PR {
  const state = stateOf(app)
  const cwd = io.cwd ?? process.cwd()
  const bay = currentBay(state.bays, cwd)
  const branch = bay?.branch ?? currentGitBranch(cwd, io)
  const pr =
    (bay === undefined ? undefined : Object.values(state.bays.prs).find((candidate) => candidate.bay === bay.id)) ??
    Object.values(state.bays.prs).find((candidate) => candidate.branch === branch)
  if (pr === undefined) refusal("the current bay or branch has no PR; submit it with 'yrd pr submit'")
  return pr as PR
}

async function queuedPrPosition(state: YrdCliState, pr: PR, io: YrdCliIO): Promise<number | undefined> {
  if (pr.status !== "submitted") return undefined
  return (await queuedPrPositions(state, pr.base, io)).get(pr.id)
}

async function queuedPrPositions(state: YrdCliState, base: string, io: YrdCliIO): Promise<ReadonlyMap<string, number>> {
  const prs = Object.values(state.bays.prs)
  const groups = await queueTargetGroups(new Set(prs.map((candidate) => candidate.base)), io)
  const group = groups.find((candidate) => candidate.aliases.has(base))
  if (group === undefined) throw new Error(`yrd: queue target group for base '${base}' disappeared`)
  const candidates = prs.filter((candidate) => group.aliases.has(candidate.base))
  return submittedPrPositions(candidates)
}

async function statusPr(app: YrdCliApp, options: JsonOption, io: YrdCliIO): Promise<void> {
  const pr = currentPr(app, io)
  await viewPr(app, pr.id, options, io, "pr.status")
}

async function editPr(
  app: YrdCliApp,
  selector: string,
  options: JsonOption & Readonly<{ issue?: string; note?: string }>,
  io: YrdCliIO,
): Promise<void> {
  if (options.issue === undefined && options.note === undefined) usage("pr edit requires --issue or --note")
  const pr = requiredPr(app, selector)
  await app.bays.editPr({
    pr: pr.id,
    ...(options.issue === undefined ? {} : { issue: options.issue }),
    ...(options.note === undefined ? {} : { note: options.note }),
  })
  const edited = requiredPr(app, pr.id)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "pr.edit", pr: edited },
    createElement(PRResultView, { prs: [edited], runs: prQueueRuns(app, edited) }),
  )
}

async function retryPr(app: YrdCliApp, selector: string, options: JsonOption, io: YrdCliIO): Promise<YrdCliExitCode> {
  const selectedRun = app.queue.get(selector)
  const prs = selectedRun?.prs.map((pr) => pr.id) ?? [requiredPr(app, selector).id]
  const runs = await app.queue.run({ prs, retry: true }, runtimeOptions(io))
  await printResult(
    io,
    jsonEnabled(options),
    { command: "pr.retry", prs, runs },
    createElement(QueueRunsView, { runs }),
  )
  return runs.some((run) => run.status === "failed") ? 1 : 0
}

function issueRows(app: YrdCliApp, selected?: string): IssueLensRow[] {
  const state = stateOf(app)
  const contests = app.contests.list()
  const refs = new Set<string>()
  for (const bay of Object.values(state.bays.byId)) if (bay.issue !== undefined) refs.add(bay.issue)
  for (const pr of Object.values(state.bays.prs)) if (pr.issue !== undefined) refs.add(pr.issue)
  for (const contest of contests) refs.add(`${contest.issue.ref.source}:${contest.issue.ref.id}`)
  if (selected !== undefined && !refs.has(selected)) refusal(`no issue '${selected}' is in flight`)
  return [...refs]
    .filter((issue) => selected === undefined || issue === selected)
    .toSorted()
    .map((issue) => {
      const bays = Object.values(state.bays.byId).filter((bay) => bay.issue === issue)
      const bayIds = new Set(bays.map((bay) => bay.id))
      const prs = Object.values(state.bays.prs).filter(
        (pr) => pr.issue === issue || (pr.bay !== undefined && bayIds.has(pr.bay)),
      )
      const joinedContests = contests.filter(
        (contest) => `${contest.issue.ref.source}:${contest.issue.ref.id}` === issue,
      )
      return {
        issue,
        bays: bays.map((bay) => bay.id).join(",") || "-",
        prs: prs.map((pr) => pr.id).join(",") || "-",
        contests: joinedContests.map((contest) => contest.id).join(",") || "-",
        outcome:
          [...prs.map((pr) => pr.status), ...joinedContests.map((contest) => contest.status)].join(",") || "in-flight",
      }
    })
}

async function listIssues(app: YrdCliApp, options: JsonOption, io: YrdCliIO, selected?: string): Promise<void> {
  const issues = issueRows(app, selected)
  await printResult(
    io,
    jsonEnabled(options),
    { command: selected === undefined ? "issue.list" : "issue.view", issues },
    createElement(IssueLensView, { rows: issues }),
  )
}

async function runQueues(
  app: YrdCliApp,
  selectors: readonly string[],
  options: { steps?: unknown },
  io: YrdCliIO,
): Promise<readonly QueueRun[]> {
  const steps = csv(options.steps)
  return app.queue.run(
    {
      prs: [...selectors],
      ...(steps === undefined ? {} : { steps }),
    },
    runtimeOptions(io),
  )
}

async function pauseQueue(
  app: YrdCliApp,
  base: string | undefined,
  options: JsonOption & Readonly<{ reason?: unknown; allow?: unknown }>,
  io: YrdCliIO,
): Promise<void> {
  if (options.reason === undefined) {
    if (csv(options.allow) !== undefined) usage("--allow requires --reason")
    const pauses = await queuePauses(app, base, io)
    const human =
      pauses.length === 0
        ? "No paused queues."
        : pauses
            .map((pause) => {
              const allowed = pause.allowedPRs.length === 0 ? "none" : pause.allowedPRs.join(", ")
              return `Queue ${pause.base} paused: ${pause.reason} (allowed: ${allowed})`
            })
            .join("\n")
    await printResult(io, jsonEnabled(options), { command: "queue.pause", pauses }, human)
    return
  }
  if (typeof options.reason !== "string" || options.reason.trim() === "") usage("--reason requires text")
  const target = await resolvedQueueTarget(base ?? "main", io)
  const pause = await app.queue.pause({
    base: target.base,
    reason: options.reason,
    allowedPRs: csv(options.allow) ?? [],
  })
  const allowed = pause.allowedPRs.length === 0 ? "none" : pause.allowedPRs.join(", ")
  await printResult(
    io,
    jsonEnabled(options),
    { command: "queue.pause", pause },
    `Queue ${pause.base} paused: ${pause.reason} (allowed: ${allowed})`,
  )
}

async function queuePauses(app: YrdCliApp, base: string | undefined, io: YrdCliIO) {
  if (base === undefined) {
    return Object.values(stateOf(app).queues.pauses).toSorted((left, right) => left.base.localeCompare(right.base))
  }
  const target = await resolvedQueueTarget(base, io)
  const pause = stateOf(app).queues.pauses[target.base]
  return pause === undefined ? [] : [pause]
}

async function recoverQueue(
  app: YrdCliApp,
  options: JsonOption & Readonly<{ reason?: string }>,
  io: YrdCliIO,
): Promise<void> {
  if (options.reason?.trim() === "") usage("--reason requires text")
  const runs = await app.queue.recover({
    recoveryTime: new Date(io.now?.() ?? Date.now()).toISOString(),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  })
  await printResult(
    io,
    jsonEnabled(options),
    { command: "queue.recover", results: runs },
    createElement(QueueRunsView, { runs }),
  )
}

async function resumeQueue(app: YrdCliApp, base: string | undefined, options: JsonOption, io: YrdCliIO): Promise<void> {
  const target = await resolvedQueueTarget(base ?? "main", io)
  await app.queue.resume(target.base)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "queue.resume", base: target.base },
    `Queue ${target.base} resumed`,
  )
}

async function renderDashboard(
  app: YrdCliApp,
  selectors: readonly string[],
  options: JsonOption,
  io: YrdCliIO,
): Promise<void> {
  const state = stateOf(app)
  const target = resolveQueueTargets(state, selectors, undefined, undefined)
  const { results } = await queueStatusSnapshots(app, state, target, io)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "dashboard", results },
    createElement(QueueStatusView, {
      state: state.bays,
      results,
      selected: target.selected,
      now: io.now?.() ?? Date.now(),
    }),
  )
}

async function queueStatusSnapshots(
  app: YrdCliApp,
  state: YrdCliState,
  target: { bases: Set<string>; selected: Set<string>; prFilter: string | undefined },
  io: YrdCliIO,
): Promise<{ results: readonly QueueStatusResult[] }> {
  if (target.selected.size === 0 && target.bases.size === 0) {
    for (const pr of Object.values(state.bays.prs)) target.bases.add(pr.base)
    for (const run of Object.values(state.queues.records)) target.bases.add(run.base)
    if (target.bases.size === 0) target.bases.add("main")
  }
  const results: QueueStatusResult[] = []
  for (const group of await queueTargetGroups(target.bases, io)) {
    const canonical = app.queue.status(group.base)
    const aliases = [...group.aliases].filter((base) => base !== group.base).map((base) => app.queue.status(base))
    const runs = mergedQueueRuns(canonical, aliases)
    results.push({
      base: group.base,
      ...runs,
      ...(canonical.pause === undefined ? {} : { pause: canonical.pause }),
      ...(group.headSha === undefined ? {} : { headSha: group.headSha }),
      prs: Object.values(state.bays.prs).filter(
        (pr) => group.aliases.has(pr.base) && (target.selected.size === 0 || target.selected.has(pr.id)),
      ),
    })
  }
  return { results }
}

async function listQueues(
  app: YrdCliApp,
  options: JsonOption & Readonly<{ base?: string }>,
  io: YrdCliIO,
): Promise<void> {
  const state = stateOf(app)
  const target = resolveQueueTargets(state, [], options.base, undefined)
  const { results } = await queueStatusSnapshots(app, state, target, io)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "queue.list", results },
    createElement(QueueListView, { results, now: io.now?.() ?? Date.now() }),
  )
}

async function dashboard(
  app: YrdCliApp,
  options: JsonOption & Readonly<{ base?: string }>,
  io: YrdCliIO,
): Promise<void> {
  await renderDashboard(app, options.base === undefined ? [] : [options.base], options, io)
}

async function primeYrd(app: YrdCliApp, options: JsonOption, io: YrdCliIO): Promise<void> {
  const state = stateOf(app)
  const cwd = io.cwd ?? process.cwd()
  const bay = currentBay(state.bays, cwd)
  const branch = bay?.branch ?? currentGitBranch(cwd, io)
  const pr = Object.values(state.bays.prs).find(
    (candidate) => (bay !== undefined && candidate.bay === bay.id) || candidate.branch === branch,
  )
  const queue = pr === undefined ? undefined : app.queue.status(pr.base)
  const briefing = {
    model: "issue -> bay -> pr -> queue -> integrated or rejected",
    loop: [
      "yrd pr submit",
      "yrd pr status",
      "yrd pr runs <PR>",
      "yrd pr retry <PR|R>",
      "fix the branch and run yrd pr submit again",
    ],
    live: {
      bay: bay?.id,
      pr: pr?.id,
      base: pr?.base ?? bay?.base,
      position: pr === undefined ? undefined : await queuedPrPosition(state, pr, io),
      pause: queue?.pause,
    },
    boundaries: ["the queue is the only merger", "issues are read-only references; edit them in the tracker"],
    json: "add --json to every read or mutation",
  }
  const live = [
    `bay=${briefing.live.bay ?? "-"}`,
    `pr=${briefing.live.pr ?? "-"}`,
    `base=${briefing.live.base ?? "-"}`,
    `position=${briefing.live.position && briefing.live.position > 0 ? briefing.live.position : "-"}`,
    `pause=${briefing.live.pause?.reason ?? "active"}`,
  ].join(" ")
  const human = [
    "Yrd agent briefing",
    "Pick an issue -> work in a bay -> submit a PR -> the queue runs checks and merges it.",
    "Loop:",
    ...briefing.loop.map((step, index) => `${index + 1}. ${step}`),
    `Live: ${live}`,
    "The queue is the only merger; pr merge only teaches the correct next command.",
    "The tracker holds the pen; yrd's issue surface is a read-only lens.",
    "Use --json for lossless machine-readable output.",
  ].join("\n")
  await printResult(io, jsonEnabled(options), { command: "prime", ...briefing }, human)
}

function resolveQueueTargets(
  state: YrdCliState,
  selectors: readonly string[],
  base: string | undefined,
  filterPr: string | undefined,
): { bases: Set<string>; selected: Set<string>; prFilter: string | undefined } {
  const bases = new Set<string>()
  const selected = new Set<string>()
  if (base !== undefined) bases.add(base)
  if (filterPr !== undefined) selected.add(filterPr)
  for (const selector of selectors) {
    const pr = resolvePR(state.bays, selector)
    if (pr === undefined) bases.add(selector)
    else {
      bases.add(pr.base)
      selected.add(pr.id)
    }
  }
  if (filterPr !== undefined) {
    const found = state.bays.prs[filterPr]
    if (found !== undefined) selected.add(found.id)
    if (found !== undefined) bases.add(found.base)
  }
  return { bases, selected, prFilter: filterPr }
}

function queueLogTargets(
  state: YrdCliState,
  selectors: readonly string[],
  base: string | undefined,
  pr: string | undefined,
): { bases: Set<string>; selected: Set<string>; prFilter: string | undefined } {
  const target = resolveQueueTargets(state, selectors, base, pr)
  if (selectors.length === 0 && base === undefined && pr === undefined) {
    for (const item of Object.values(state.bays.prs)) target.bases.add(item.base)
    for (const run of Object.values(state.queues.records)) target.bases.add(run.base)
    if (target.bases.size === 0) target.bases.add("main")
  }
  return target
}

async function logRuns(
  app: YrdCliApp,
  selectors: readonly string[],
  options: { all?: boolean; base?: string; pr?: string; json?: boolean },
  io: YrdCliIO,
): Promise<void> {
  const state = stateOf(app)
  const target = queueLogTargets(state, selectors, options.base, options.pr)
  const summaries: QueueStatusResult[] = []
  for (const group of await queueTargetGroups(target.bases, io)) {
    const canonical = app.queue.status(group.base)
    const aliases = [...group.aliases].filter((base) => base !== group.base).map((base) => app.queue.status(base))
    const merged = mergedQueueRuns(canonical, aliases)
    const inScope = (run: QueueRun) =>
      target.selected.size === 0 || run.prs.some((member) => target.selected.has(member.id))
    const runs = {
      running: merged.running.filter(inScope),
      waiting: merged.waiting.filter(inScope),
      finished: merged.finished.filter(inScope),
    }
    summaries.push({
      base: group.base,
      ...runs,
      ...(group.headSha === undefined ? {} : { headSha: group.headSha }),
      prs: Object.values(state.bays.prs).filter(
        (pr) => group.aliases.has(pr.base) && (target.selected.size === 0 || target.selected.has(pr.id)),
      ),
    })
  }
  const prStatusById = new Map<string, PR["status"]>(
    summaries.flatMap((result) => result.prs.map((pr) => [pr.id, pr.status])),
  )
  const revisionSubjects = new Map<string, string>()
  const cwd = io.cwd ?? process.cwd()
  for (const pr of summaries.flatMap((result) => result.finished.flatMap((run) => run.prs))) {
    const key = queueRevisionKey(pr)
    if (revisionSubjects.has(key)) continue
    const subject = commitSubject(cwd, pr.headSha)
    if (subject !== undefined) revisionSubjects.set(key, subject)
  }
  const runIds = new Set(
    summaries.flatMap((summary) => [...summary.running, ...summary.waiting, ...summary.finished].map((run) => run.id)),
  )
  const attempts = (await queueLogAttempts(app.events())).filter((attempt) => runIds.has(attempt.run))
  const submissionTimes = await queueSubmissionTimes(app.events())
  const rows = queueLogRows(
    summaries,
    target.selected,
    target.prFilter,
    prStatusById,
    attempts,
    revisionSubjects,
    submissionTimes,
  )
  const coverage = await queueLegacyCoverage(io.cwd ?? process.cwd(), await firstEventTimestamp(app))
  await printResult(
    io,
    jsonEnabled(options),
    {
      command: "log",
      rows,
      ...(options.all === true ? { results: summaries, attempts } : {}),
      ...(coverage === undefined ? {} : { coverage }),
    },
    createElement(QueueLogView, { rows, coverage, columns: Math.min(io.columns ?? 120, 120) }),
  )
}

async function queueAudit(
  app: YrdCliApp,
  services: YrdCliServices,
  options: JsonOption,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const core = app.queue.audit()
  const environment = await services.queue?.auditEnvironment?.()
  const result = { findings: [...core.findings, ...(environment?.findings ?? [])] }
  await printResult(
    io,
    jsonEnabled(options),
    { command: "queue.audit", ...result },
    result.findings.length === 0
      ? "queue audit clean"
      : result.findings.map((finding) => `${finding.code}: ${finding.message}`).join("\n"),
  )
  return result.findings.length === 0 ? 0 : 1
}

async function queueAdministration(
  services: YrdCliServices,
  command: "init" | "deinit",
  base: string | undefined,
  options: JsonOption,
  io: YrdCliIO,
): Promise<void> {
  const action = command === "init" ? "provision" : "deprovision"
  const administration = services.queue
  const capability = administration?.[action]
  if (capability === undefined) configuration(`queue.${command} capability is not installed`)
  const result = await capability(base)
  await printResult(
    io,
    jsonEnabled(options),
    { command: `queue.${command}`, base: base ?? "main", result },
    `${base ?? "main"} ${command === "init" ? "initialized" : "deinitialized"}`,
  )
}

function positiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || (value as number) < 0) usage(`${label} must be a non-negative integer`)
  return value as number
}

function artifacts(values: unknown): readonly { name: string; uri: string }[] | undefined {
  const items = csv(values)
  if (items === undefined) return undefined
  return items.map((item) => {
    const separator = item.indexOf("=")
    if (separator <= 0 || separator === item.length - 1) {
      usage(`invalid --artifact '${item}'; expected name=path-or-url`)
    }
    return { name: item.slice(0, separator), uri: item.slice(separator + 1) }
  })
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

async function finishQueue(
  app: YrdCliApp,
  selector: string,
  options: {
    step?: string
    ok?: boolean
    fail?: boolean
    job?: string
    runner?: string
    attempt?: string
    token?: string
    detail?: string
    url?: string
    artifact?: unknown
    exitCode?: number
    durationMs?: number
    json?: boolean
  },
  io: YrdCliIO,
): Promise<void> {
  if (options.ok === options.fail) usage("queue finish requires exactly one of --ok or --fail")
  const { job: jobId, runner, token } = options
  if (jobId === undefined || options.attempt === undefined || runner === undefined || token === undefined) {
    usage("queue finish requires --job, --runner, --attempt, and --token")
  }
  const attempt = Number(options.attempt)
  if (!Number.isSafeInteger(attempt) || attempt < 1) usage("--attempt must be a positive integer")
  const waiting = app.queue.waiting(selector, options.step)
  const selectedJob = waiting.step.job
  const recordedArtifacts = artifacts(options.artifact)
  const exitCode = positiveInteger(options.exitCode, "--exit-code")
  const durationMs = positiveInteger(options.durationMs, "--duration-ms")
  const evidence = {
    ...jsonRecord(selectedJob.checkpoint),
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.url === undefined ? {} : { url: options.url }),
    ...(selectedJob.artifacts === undefined && recordedArtifacts === undefined
      ? {}
      : { artifacts: [...(selectedJob.artifacts ?? []), ...(recordedArtifacts ?? [])] }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(durationMs === undefined ? {} : { durationMs }),
  }
  const resumed = await app.queue.finish(
    selector,
    {
      job: jobId,
      step: waiting.step.name,
      runner,
      attempt,
      token,
      result:
        options.ok === true
          ? { status: "passed", output: evidence }
          : {
              status: "failed",
              error: {
                code: `${waiting.step.name}-failed`,
                message: options.detail ?? `${waiting.step.name} failed externally`,
              },
              output: evidence,
            },
    },
    runtimeOptions(io),
  )
  await printResult(
    io,
    jsonEnabled(options),
    { command: "queue.finish", run: resumed },
    `${resumed.id} ${resumed.status}`,
  )
}

async function watchQueueRuns(
  app: YrdCliApp,
  selectors: readonly string[],
  options: { steps?: unknown; json?: boolean; interval?: number },
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const intervalSeconds = options.interval ?? 15
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds <= 0) {
    usage("--interval must be a positive number of seconds")
  }
  const interval = intervalSeconds * 1_000
  const scope = io.scope ?? app.scope
  let exit: YrdCliExitCode = 0
  while (true) {
    const runs = await runQueues(app, selectors, options, io)
    if (jsonEnabled(options)) {
      for (const run of runs) io.stdout(stableJson({ command: "queue.run", mode: "watch", run }))
    } else if (runs.length > 0) {
      await printHuman(io, createElement(QueueRunsView, { runs }))
    }
    if (runs.some((run) => run.status === "failed")) exit = 1
    if (selectors.length > 0 || scope.signal.aborted) return exit
    await scope.sleep(interval)
    if (scope.signal.aborted) return exit
  }
}

async function watchQueue(app: YrdCliApp, options: WatchOptions, io: YrdCliIO): Promise<YrdCliExitCode> {
  const interval = 1_000
  const scope = io.scope ?? app.scope
  const load = async (): Promise<QueueWatchSnapshot> => {
    const state = stateOf(app)
    const target = resolveQueueTargets(state, [], options.base, options.pr)
    const { results } = await queueStatusSnapshots(app, state, target, io)
    return { results, now: io.now?.() ?? Date.now() }
  }

  if (!jsonEnabled(options)) {
    const renderLive = getLiveRenderer(io)
    if (renderLive === undefined) {
      refusal("watch requires an interactive terminal; use --json for streaming output")
    }
    const initial = await load()
    await renderLive(createElement(QueueWatchPane, { initial, load, intervalMs: interval }), {
      signal: scope.signal,
    })
    return 0
  }

  while (true) {
    const snapshot = await load()
    await printResult(
      io,
      true,
      { command: "watch", results: snapshot.results },
      createElement(QueueWatchView, snapshot),
    )
    if (scope.signal.aborted) return 0
    await scope.sleep(interval)
    if (scope.signal.aborted) return 0
  }
}

function competitors(
  input: string,
  prompt?: string,
): readonly { model: string; harness: string; config: { instructions?: string } }[] {
  const trimmed = input.trim()
  if (trimmed === "") usage("--agents must name at least one competitor")
  const firstSpace = trimmed.indexOf(" ")
  const harness = firstSpace > 0 ? trimmed.slice(0, firstSpace) : "ag"
  const modelList = firstSpace > 0 ? trimmed.slice(firstSpace + 1) : trimmed
  const models = modelList
    .split(/[/,]/u)
    .map((model) => model.trim())
    .filter(Boolean)
  if (models.length === 0) usage("--agents must name at least one competitor")
  return models.map((model) => ({
    model,
    harness,
    config: prompt === undefined ? {} : { instructions: prompt },
  }))
}

async function advanceContest(app: YrdCliApp, contest: string, io: YrdCliIO, retry = false): Promise<Contest> {
  const concurrency = io.concurrency ?? 8
  if (!Number.isInteger(concurrency) || concurrency < 1) usage("contest concurrency must be a positive integer")
  return app.contests.evaluate(contest, { ...runtimeOptions(io), concurrency, retry })
}

async function openContest(
  app: YrdCliApp,
  issueInput: string,
  options: { agents?: string; prompt?: string; evaluators?: unknown; base?: string; queue?: string; json?: boolean },
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  if (options.agents === undefined) usage("contest open requires --agents <list>")
  if (options.prompt?.trim() === "") usage("--prompt requires non-empty text")
  const issue = await app.issues.resolve(app.issues.ref(issueInput))
  const requestedBase = oneOfAliases(options.base, options.queue, "base", "queue")
  const base = await app.contests.resolveBase(requestedBase)
  const opened = await app.contests.compete({
    issue,
    competitors: competitors(options.agents, options.prompt),
    ...(csv(options.evaluators) === undefined ? {} : { evaluators: csv(options.evaluators) }),
    base: base.base,
    baseSha: base.sha,
  })
  const contest = await advanceContest(app, opened.id, io)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "contest.open", contest },
    createElement(ContestStatusView, { contest }),
  )
  return contest.status === "failed" ? 1 : 0
}

async function viewContest(app: YrdCliApp, id: string, options: JsonOption, io: YrdCliIO): Promise<void> {
  const contest = app.contests.get(id)
  if (contest === undefined) refusal(`no contest '${id}'`)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "contest.view", contest },
    createElement(ContestStatusView, { contest }),
  )
}

async function evalContest(
  app: YrdCliApp,
  id: string,
  options: { retry?: boolean; json?: boolean },
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const contest = await advanceContest(app, id, io, options.retry === true)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "contest.eval", contest },
    createElement(ContestStatusView, { contest }),
  )
  return contest.status === "failed" ? 1 : 0
}

async function finishContest(
  app: YrdCliApp,
  id: string,
  options: {
    attempt?: string
    evaluator?: string
    ok?: boolean
    fail?: boolean
    error?: string
    token?: string
    detail?: string
    artifact?: unknown
    json?: boolean
  },
  io: YrdCliIO,
): Promise<void> {
  const errorCode = options.error?.trim()
  if (options.error !== undefined && errorCode === "") usage("contest finish --error requires a non-empty code")
  const outcomes = Number(options.ok === true) + Number(options.fail === true) + Number(errorCode !== undefined)
  if (outcomes !== 1) usage("contest finish requires exactly one of --ok, --fail, or --error")
  if (options.token === undefined || options.token === "") usage("contest finish requires --token <token>")
  const recordedArtifacts = artifacts(options.artifact)?.map(({ name, uri }) => ({ kind: name, uri })) ?? []
  if (errorCode !== undefined && recordedArtifacts.length > 0) {
    usage("contest finish --artifact records evaluator verdict evidence and cannot be used with --error")
  }
  const contest = await app.contests.finish({
    contest: id,
    ...(options.attempt === undefined ? {} : { attempt: options.attempt }),
    ...(options.evaluator === undefined ? {} : { evaluator: options.evaluator }),
    token: options.token,
    result:
      errorCode === undefined
        ? {
            status: "passed",
            output: {
              verdict: options.ok === true ? "passed" : "failed",
              ...(options.detail === undefined ? {} : { summary: options.detail }),
              artifacts: recordedArtifacts,
            },
          }
        : {
            status: "failed",
            error: {
              code: errorCode,
              message: options.detail?.trim() || `remote evaluator failed (${errorCode})`,
            },
          },
  })
  await printResult(
    io,
    jsonEnabled(options),
    { command: "contest.finish", contest },
    createElement(ContestStatusView, { contest }),
  )
}

async function selectContest(
  app: YrdCliApp,
  id: string,
  options: { winner?: string; by?: string; reason?: string; json?: boolean },
  io: YrdCliIO,
): Promise<void> {
  if (options.winner === undefined || options.winner === "") usage("contest select requires --winner <attempt>")
  const contest = await app.contests.select({
    contest: id,
    attempt: options.winner,
    ...(options.by === undefined ? {} : { selectedBy: options.by }),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  })
  await printResult(
    io,
    jsonEnabled(options),
    { command: "contest.select", contest },
    createElement(ContestStatusView, { contest }),
  )
}

async function promoteContest(app: YrdCliApp, id: string, options: JsonOption, io: YrdCliIO): Promise<YrdCliExitCode> {
  const concurrency = io.concurrency ?? 8
  if (!Number.isInteger(concurrency) || concurrency < 1) usage("contest concurrency must be a positive integer")
  const contest = await app.contests.promote({ contest: id }, { ...runtimeOptions(io), concurrency })
  await printResult(
    io,
    jsonEnabled(options),
    { command: "contest.promote", contest },
    createElement(ContestStatusView, { contest }),
  )
  return contest.status === "promotion-failed" ? 1 : 0
}

async function listContests(app: YrdCliApp, options: JsonOption, io: YrdCliIO): Promise<void> {
  const contests = app.contests.list()
  const human =
    contests.length === 0
      ? "No contests."
      : [
          "CONTEST ISSUE STATUS",
          ...contests.map(
            (contest) => `${contest.id} ${contest.issue.ref.source}:${contest.issue.ref.id} ${contest.status}`,
          ),
        ].join("\n")
  await printResult(io, jsonEnabled(options), { command: "contest.list", contests }, human)
}

async function refusePrMerge(
  app: YrdCliApp,
  selector: string,
  options: JsonOption,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const pr = app.bays.pr(selector)
  if (pr === undefined) {
    const next = `yrd pr submit ${selector}`
    const message = `the queue is the only merger; branch '${selector}' is not submitted; submit it: ${next}`
    const guidance = {
      command: "pr.merge",
      branch: selector,
      status: "not-submitted",
      next,
      guidance: { submit: next },
      failure: { kind: "refusal", code: "queue-only-merger", message },
    }
    if (jsonEnabled(options)) {
      io.stderr(stableJson(guidance))
      return 1
    }
    refusal(message)
  }

  const position = await queuedPrPosition(stateOf(app), pr, io)
  const detail = prMergeRefusalDetail(pr, position)
  const message = `the queue is the only merger; ${detail.message}`
  const guidance = {
    command: "pr.merge",
    pr: pr.id,
    status: pr.status,
    ...(position === undefined ? {} : { position }),
    next: detail.next,
    guidance: detail.guidance,
    failure: { kind: "refusal", code: "queue-only-merger", message },
  }
  if (jsonEnabled(options)) {
    io.stderr(stableJson(guidance))
    return 1
  }
  refusal(message)
}

function prMergeRefusalDetail(
  pr: PR,
  position: number | undefined,
): Readonly<{ next: string; guidance: Readonly<Record<string, string>>; message: string }> {
  if (pr.status === "submitted") {
    const watch = `yrd watch --pr ${pr.id}`
    return {
      next: watch,
      guidance: { watch },
      message: `PR '${pr.id}' is queued${position === undefined ? "" : ` at position ${position}`}; watch: ${watch}`,
    }
  }
  if (pr.status === "rejected") {
    const inspect = `yrd pr runs ${pr.id}`
    const retry = `yrd pr retry ${pr.id}`
    const resubmit = "fix the branch and run yrd pr submit again"
    return {
      next: inspect,
      guidance: { inspect, retry, resubmit },
      message: `PR '${pr.id}' was rejected; see: ${inspect}; then ${retry} or ${resubmit}`,
    }
  }
  if (pr.status === "pushed") {
    const submit = `yrd pr submit ${pr.branch}`
    return { next: submit, guidance: { submit }, message: `PR '${pr.id}' is not queued; submit it: ${submit}` }
  }
  const view = `yrd pr view ${pr.id}`
  return { next: view, guidance: { view }, message: `PR '${pr.id}' is ${pr.status}; see: ${view}` }
}

function maxExit(left: YrdCliExitCode, right: YrdCliExitCode): YrdCliExitCode {
  return Math.max(left, right) as YrdCliExitCode
}

function configureOutput(command: CliCommand, io: YrdCliIO, output: { wroteError: boolean }): void {
  command.configureOutput({
    writeOut: (text) => io.stdout(text),
    writeErr: (text) => {
      output.wroteError = true
      io.stderr(text)
    },
    getOutHasColors: () => io.color === true,
    getErrHasColors: () => io.color === true,
  })
  for (const child of command.commands) configureOutput(child as unknown as CliCommand, io, output)
}

function configureCanonicalHelp(program: CliCommand): void {
  const standard = new Help()
  const withoutAlias = (value: string, command: CliCommand): string => {
    const alias = command.alias()
    return alias === "" ? value : value.replace(`|${alias}`, "")
  }
  program.configureHelp({
    subcommandTerm: (command) => withoutAlias(standard.subcommandTerm(command), command as unknown as CliCommand),
    commandUsage: (command) => withoutAlias(standard.commandUsage(command), command as unknown as CliCommand),
  })
}

function addExamples(program: CliCommand, name: string, projection: "root" | "bay"): void {
  const bay = projection === "bay" ? name : `${name} bay`
  const examples: [string, string][] = [
    [`$ ${bay} open fix --from topic`, "open an existing branch"],
    [`$ ${bay} submit`, "submit the current bay as a PR"],
  ]
  if (projection === "root") {
    examples.push(
      [`$ ${name} pr`, "inspect active PRs"],
      [`$ ${name} queue run --steps check,merge`, "run selected steps"],
      [`$ ${name} watch --pr PR7`, "monitor PR and queue health"],
      [`$ ${name} contest open km:T1 -a codex/claude`, "compare implementations"],
    )
  }
  program.addHelpSection("Examples:", examples)
}

function addQueueExamples(queue: CliCommand, name: string): void {
  queue.addHelpSection("Examples:", [
    [`$ ${name} queue`, "list active queues"],
    [`$ ${name} queue run PR7 --steps check,merge`, "run selected steps for one PR"],
    [`$ ${name} log --base release/2.0`, "show completed work for a base"],
    [`$ ${name} pr runs PR7`, "show step-level run evidence and proofs"],
    [`$ ${name} queue pause --reason maintenance --allow PR7`, "pause all but selected PRs"],
    [`$ ${name} queue recover --json`, "recover expired runner leases"],
    [`$ ${name} queue run --watch`, "keep the default queue moving"],
  ])
}

function buildProgram(
  app: YrdCliApp | undefined,
  services: YrdCliServices,
  name: string,
  projection: "root" | "bay",
  io: YrdCliIO,
  setExit: (code: YrdCliExitCode) => void,
  commanderOutput: { wroteError: boolean },
): CliCommand {
  const installed = (): YrdCliApp => app ?? configuration("command runtime is not initialized")
  const program = new CliCommand(name)
    .description(projection === "bay" ? "manage isolated Git work bays" : "yrd (shipyard) — agentic software delivery")
    .showHelpAfterError()
    .showSuggestionAfterError()
  program.helpCommand(false)
  program.exitOverride()
  configureCanonicalHelp(program)
  if (projection === "root") program.version(YRD_VERSION, "-V, --version")
  if (projection === "root") {
    program.addHelpSection(
      "Model:",
      "Pick an issue -> work it in a bay -> submit as a PR -> PRs queue per base ->\na run verifies and merges each one -> integrated, or rejected with the log.",
    )
    program.addHelpSection("Objects:", [
      ["issue", "tracker-owned intent; yrd exposes a read-only delivery lens"],
      ["bay", "isolated Git workspace; also standalone as git-bay"],
      ["pr", "submitted branch@head revision; the queue's unit"],
      ["contest", "competing implementations; winner promotes to a PR"],
      ["queue", "one per base; verifies and merges PRs serially"],
    ])
    program.addHelpSection(
      "Boundaries:",
      "Runs, steps, jobs, attempts, and runners are records inside PRs and the log.\nThe queue is the only merger; pr merge is a teaching refusal.\nThe tracker holds the pen; yrd never creates or edits issues.",
    )
    program
      .command("_dashboard", { isDefault: true, hidden: true })
      .option("--base <branch>", "scope the dashboard to one base")
      .option("--json", "emit stable JSON")
      .action(async (options) => dashboard(installed(), options, io))
  }

  const bay = projection === "bay" ? program : program.command("bay").description("manage isolated Git work bays")
  bay.helpCommand(false)
  if (projection === "root") bay.alias("bays")
  bay
    .command("_list", { isDefault: true, hidden: true })
    .option("--json", "emit stable JSON")
    .action(async (options) => listBays(installed(), options, io))
  bay
    .command("open <name>")
    .description("open a work bay")
    .option("--from <branch>", "use an existing source branch")
    .option("--head <branch>", "alias for --from")
    .option("--base <branch>", "select the base branch")
    .option("--queue <branch>", "alias for --base")
    .option("--issue <ref>", "link a tracker-neutral issue reference")
    .option("--actor <id>", "record the worker or implementation identity")
    .option("--json", "emit stable JSON")
    .action(async (workName, options) => openBay(installed(), workName, options, io))
  bay
    .command("refresh [selector...]")
    .description("refresh work bays")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => refreshBays(installed(), selectors, options, io))
  bay
    .command("submit [selector...]")
    .description("submit bays or branches")
    .option("--base <branch>", "base branch for a direct branch submit")
    .option("--queue <branch>", "alias for --base")
    .option("--issue <ref>", "link a tracker-neutral issue reference")
    .option("--composition <path>", "immutable version-1 source composition JSON")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => setExit(await submitBays(installed(), selectors, options, io, "bay.submit")))
  bay
    .command("close [selector...]")
    .description("close work bays")
    .option("--withdraw", "withdraw a live PR before closing")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => closeBays(installed(), selectors, options, io))

  if (projection === "bay") {
    addExamples(program, name, projection)
    configureOutput(program, io, commanderOutput)
    return program
  }

  program
    .command("log")
    .description("show queue history, newest first")
    .option("--base <branch>", "scope log to one base branch")
    .option("--pr <pr>", "scope log to one PR")
    .option("--all", "include lossless queue and run records in JSON")
    .option("--json", "emit stable JSON")
    .action(async (options) => logRuns(installed(), [], options, io))

  program
    .command("watch")
    .description("monitor queue progress")
    .option("--base <branch>", "scope watch to one base")
    .option("--pr <pr>", "scope watch to one PR")
    .option("--json", "emit stable JSON")
    .action(async (options) => {
      setExit(await watchQueue(installed(), options, io))
    })

  program
    .command("prime")
    .description("brief an agent on Yrd and current delivery state")
    .option("--json", "emit stable JSON")
    .action(async (options) => primeYrd(installed(), options, io))

  const queue = program.command("queue").description("manage integration queues")
  queue.helpCommand(false)
  queue.alias("queues")
  queue
    .command("_list", { isDefault: true, hidden: true })
    .option("--base <branch>", "scope queues to one base")
    .option("--json", "emit stable JSON")
    .action(async (options) => listQueues(installed(), options, io))
  queue
    .command("audit")
    .description("check queue state")
    .option("--json", "emit stable JSON")
    .action(async (options) => setExit(await queueAudit(installed(), services, options, io)))
  queue
    .command("init [base]")
    .description("prepare queue resources")
    .option("--json", "emit stable JSON")
    .action(async (base, options) => queueAdministration(services, "init", base, options, io))
  queue
    .command("deinit [base]")
    .description("release queue resources")
    .option("--json", "emit stable JSON")
    .action(async (base, options) => queueAdministration(services, "deinit", base, options, io))
  queue
    .command("pause [base]")
    .description("pause new queue runs")
    .option("--reason <text>", "record the pause reason")
    .option("--allow [pr...]", "PR ids allowed through the pause")
    .option("--json", "emit stable JSON")
    .action(async (base, options) => pauseQueue(installed(), base, options, io))
  queue
    .command("resume [base]")
    .description("resume a paused queue")
    .option("--json", "emit stable JSON")
    .action(async (base, options) => resumeQueue(installed(), base, options, io))
  queue
    .command("recover")
    .description("recover expired runner leases")
    .option("--reason <text>", "record the recovery reason")
    .option("--json", "emit stable JSON")
    .action(async (options) => recoverQueue(installed(), options, io))
  queue
    .command("run [selector...]")
    .description("run queue steps for PRs")
    .option("--steps [step...]", "registered step names, comma-separated or repeated")
    .option("--watch", "keep draining the default queue")
    .option("--interval <seconds>", "watch interval in seconds", int)
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => {
      if (options.watch === true) {
        setExit(await watchQueueRuns(installed(), selectors, options, io))
        return
      }
      const runs = await runQueues(installed(), selectors, options, io)
      await printResult(
        io,
        jsonEnabled(options),
        { command: "queue.run", results: runs },
        createElement(QueueRunsView, { runs }),
      )
      setExit(runs.some((run) => run.status === "failed") ? 1 : 0)
    })
  queue
    .command("finish <selector>")
    .description("resume a waiting step")
    .option("--step <name>", "waiting step name")
    .option("--ok", "record a passing result")
    .option("--fail", "record a failing result")
    .option("--job <id>", "waiting-job id")
    .option("--runner <runner>", "waiting-job runner identity")
    .option("--attempt <attempt>", "waiting-job attempt number")
    .option("--token <token>", "waiting-job correlation token")
    .option("--detail <text>", "human-readable result detail")
    .option("--url <url>", "external runner URL")
    .option("--artifact [artifact...]", "artifact name=path-or-url")
    .option("--exit-code <code>", "external process exit code", int)
    .option("--duration-ms <milliseconds>", "external duration", int)
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => finishQueue(installed(), selector, options, io))
  addQueueExamples(queue, name)

  const pr = program.command("pr").description("manage pull requests")
  pr.helpCommand(false)
  pr.alias("prs")
  pr.command("_list", { isDefault: true, hidden: true })
    .option("--base <branch>", "scope PRs to one base")
    .option("--state <state>", "scope PRs to one native state")
    .option("--issue <ref>", "scope PRs to one issue reference")
    .option("--json", "emit stable JSON")
    .action(async (options) => listPrs(installed(), options, io))
  pr.command("submit [selector...]")
    .description("submit bays or branches without running the queue")
    .option("--base <branch>", "base branch for a direct branch submit")
    .option("--queue <branch>", "alias for --base")
    .option("--issue <ref>", "link a tracker-neutral issue reference")
    .option("--composition <path>", "immutable version-1 source composition JSON")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => setExit(await submitBays(installed(), selectors, options, io, "pr.submit")))
  pr.command("view <selector>")
    .description("show a PR and its runs")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => viewPr(installed(), selector, options, io))
  pr.command("runs <selector>")
    .description("show run, step, attempt, proof, and artifact detail")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => viewPrRuns(installed(), selector, options, io))
  pr.command("diff <selector>")
    .description("show the candidate diff")
    .option("--stat", "show diff statistics")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => diffPr(installed(), selector, options, io))
  pr.command("checkout <selector>")
    .description("materialize a bay from a PR branch")
    .option("--bay <name>", "name the new bay")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => checkoutPr(installed(), selector, options, io))
  pr.command("status")
    .description("show the current bay or branch PR")
    .option("--json", "emit stable JSON")
    .action(async (options) => statusPr(installed(), options, io))
  pr.command("edit <selector>")
    .description("edit the issue link or note")
    .option("--issue <ref>", "set the tracker-neutral issue reference")
    .option("--note <text>", "set the delivery note")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => editPr(installed(), selector, options, io))
  pr.command("retry <selector>")
    .description("retry a rejected PR or run")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => setExit(await retryPr(installed(), selector, options, io)))
  pr.command("close [selector...]")
    .description("close a live PR without merging (leaves it out of the queue)")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => closePrs(installed(), selectors, options, io))
  pr.command("merge <selector>")
    .description("teach that the queue is the only merger")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => setExit(await refusePrMerge(installed(), selector, options, io)))

  const issue = program.command("issue").description("inspect tracker-neutral issue delivery")
  issue.helpCommand(false)
  issue.alias("issues")
  issue
    .command("_list", { isDefault: true, hidden: true })
    .option("--json", "emit stable JSON")
    .action(async (options) => listIssues(installed(), options, io))
  issue
    .command("view <issue>")
    .description("show Yrd delivery records joined to an issue")
    .option("--json", "emit stable JSON")
    .action(async (issueId, options) => listIssues(installed(), options, io, issueId))

  const contest = program.command("contest").description("inspect and select contest attempts")
  contest.helpCommand(false)
  contest.alias("contests")
  contest
    .command("_list", { isDefault: true, hidden: true })
    .option("--json", "emit stable JSON")
    .action(async (options) => listContests(installed(), options, io))
  contest
    .command("open <issue>")
    .description("compare implementations of one real issue")
    .option("-a, --agents <agents>", "ag-style competitor list")
    .option("--prompt <text>", "additional implementation instructions")
    .option("--evaluators [evaluator...]", "evaluator ids, comma-separated or repeated")
    .option("--base <branch>", "base branch")
    .option("--queue <branch>", "alias for --base")
    .option("--json", "emit stable JSON")
    .action(async (issueId, options) => setExit(await openContest(installed(), issueId, options, io)))
  contest
    .command("eval <contest>")
    .description("run pending work and evaluators")
    .option("--retry", "retry failed work or re-evaluate failed verdicts")
    .option("--json", "emit stable JSON")
    .action(async (contestId, options) => setExit(await evalContest(installed(), contestId, options, io)))
  contest
    .command("finish <contest>")
    .description("finish a waiting evaluator")
    .option("--attempt <attempt>", "contest attempt id")
    .option("--evaluator <evaluator>", "evaluator id")
    .option("--ok", "record a passing evaluator verdict")
    .option("--fail", "record a failing evaluator verdict")
    .option("--error <code>", "record an evaluator infrastructure failure")
    .option("--token <token>", "waiting-job correlation token")
    .option("--detail <text>", "human-readable result summary")
    .option("--artifact [artifact...]", "artifact name=path-or-url")
    .option("--json", "emit stable JSON")
    .action(async (contestId, options) => finishContest(installed(), contestId, options, io))
  contest
    .command("view <contest>")
    .description("show attempts, metrics, and evidence")
    .option("--json", "emit stable JSON")
    .action(async (contestId, options) => viewContest(installed(), contestId, options, io))
  contest
    .command("select <contest>")
    .description("select a winner")
    .option("--winner <attempt>", "winning attempt id")
    .option("--by <actor>", "selector identity")
    .option("--reason <text>", "selection rationale")
    .option("--json", "emit stable JSON")
    .action(async (contestId, options) => selectContest(installed(), contestId, options, io))
  contest
    .command("promote <contest>")
    .description("submit the selected Git pin")
    .option("--json", "emit stable JSON")
    .action(async (contestId, options) => setExit(await promoteContest(installed(), contestId, options, io)))

  const order = new Map(
    ["pr", "bay", "issue", "contest", "queue", "log", "watch", "prime"].map((command, index) => [command, index]),
  )
  const orderedCommands = program.commands as unknown as CliCommand[]
  orderedCommands.sort((left, right) => (order.get(left.name()) ?? 99) - (order.get(right.name()) ?? 99))
  addExamples(program, name, projection)
  configureOutput(program, io, commanderOutput)
  return program
}

/** Run the one Yrd command surface. git-bay projects its canonical bay subtree;
 * every mutation still resolves through the composed app's command registry. */
async function executeYrd(
  app: YrdCliApp | undefined,
  argv: readonly string[],
  io: YrdCliIO,
  services: YrdCliServices = {},
): Promise<YrdCliExitCode> {
  const invocation = resolveInvocation(argv)
  let exit: YrdCliExitCode = 0
  const setExit = (code: YrdCliExitCode) => {
    exit = maxExit(exit, code)
  }
  const commanderOutput = { wroteError: false }
  const program = buildProgram(app, services, invocation.name, invocation.projection, io, setExit, commanderOutput)
  const args = invocation.args
  try {
    await program.parseAsync(args, { from: "user" })
    return exit
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0 || error.code === "commander.helpDisplayed") return 0
      if (!commanderOutput.wroteError) await diagnostic(io, invocation.name, error)
      return 2
    }
    const { exitCode } = classifyFailure(error)
    await diagnostic(io, invocation.name, error)
    return exitCode
  }
}

/** Render command metadata without creating a repository-backed runtime. */
export function runYrdHelp(argv: readonly string[], io: YrdCliIO): Promise<YrdCliExitCode> {
  return executeYrd(undefined, argv, io, {})
}

/** Run the one Yrd command surface. git-bay projects its canonical bay subtree;
 * every mutation still resolves through the composed app's command registry. */
export function runYrd(
  app: YrdCliApp,
  argv: readonly string[],
  io: YrdCliIO,
  services: YrdCliServices = {},
): Promise<YrdCliExitCode> {
  return executeYrd(app, argv, io, services)
}
