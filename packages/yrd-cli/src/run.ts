import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { Command as CliCommand, CommanderError, int } from "@silvery/commander"
import { createElement } from "react"
import { resolveBay, resolvePR, type Bay, type BaysState, type PR } from "@yrd/bay"
import type { Contest } from "@yrd/contest"
import type { DeepReadonly } from "@yrd/core"
import type { Job } from "@yrd/job"
import type { LineRun } from "@yrd/line"
import { classifyFailure, configuration, refusal, resolveInvocation, stableJson, usage } from "./invocation.ts"
import { getLiveRenderer } from "./live-renderer.ts"
import {
  LineLogView,
  LineRunsView,
  LineWatchView,
  LineShowView,
  LineStatusView,
  PRChecksView,
  PREligibilityView,
  type PRCheckViewRecord,
  type LineLogCoverage,
  PRResultView,
  lineLogAttempts,
  lineLogRows,
  lineShowData,
  type LineStatusResult,
} from "./line-status-view.tsx"
import { diagnostic, printHuman, printResult } from "./output.tsx"
import { BayStatusView, ContestStatusView } from "./status-view.tsx"
import type { YrdCliApp, YrdCliExitCode, YrdCliIO, YrdCliServices, YrdCliState } from "./types.ts"
import { YRD_VERSION } from "./version.ts"
import { LineWatchPane, tailJournal, type LineWatchSnapshot } from "./watch-pane.tsx"

function lineGitDir(cwd: string): string | undefined {
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

async function firstEventTimestamp(app: YrdCliApp): Promise<string> {
  for await (const event of app.events()) return event.ts
  return "-"
}

async function lineLegacyCoverage(cwd: string, since: string): Promise<LineLogCoverage | undefined> {
  const gitDir = lineGitDir(cwd)
  if (gitDir === undefined) return undefined
  const journal = join(gitDir, "bay", "journal.jsonl")
  try {
    const content = await readFile(journal, "utf8")
    const lines = content.split(/\r?\n/u).filter((value) => value.trim() !== "")
    return { since, completeness: "queue-only", legacy: { path: journal, frames: lines.length } }
  } catch {
    return undefined
  }
}

type RuntimeOptions = {
  executor: string
  leaseMs: number
  now?: () => number
}

type WatchOptions = Readonly<{ base?: string; pr?: string; json?: boolean }>

type JsonOption = { json?: boolean }

function runtimeOptions(io: YrdCliIO): RuntimeOptions {
  return {
    executor: io.executor ?? "yrd-cli",
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
    line?: string
    task?: string
    actor?: string
    json?: boolean
  },
  io: YrdCliIO,
): Promise<void> {
  const from = oneOfAliases(options.from, options.head, "from", "head")
  const base = oneOfAliases(options.base, options.line, "base", "line")
  const result = await app.bays.open({
    name,
    ...(options.task === undefined ? {} : { task: options.task }),
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
    { command: "bay.open", bay },
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
    { command: "pr.close", prs: prs.map(prFact) },
    createElement(PRResultView, { prs, runs: [] }),
  )
}

async function listPrs(
  app: YrdCliApp,
  options: JsonOption & Readonly<{ needsReview?: boolean }>,
  io: YrdCliIO,
): Promise<void> {
  const rows = app.bays
    .prs()
    .map((pr) => ({ pr, eligibility: app.line.eligibility(pr.id) }))
    .filter(({ pr, eligibility }) =>
      options.needsReview === true
        ? (pr.status === "pushed" || pr.status === "submitted") &&
          eligibility.review.required &&
          !eligibility.review.approved
        : true,
    )
    .toSorted((left, right) => left.pr.id.localeCompare(right.pr.id, undefined, { numeric: true }))
  await printResult(
    io,
    jsonEnabled(options),
    { command: "pr.list", prs: rows.map(({ pr, eligibility }) => ({ ...prFact(pr), eligibility })) },
    createElement(PREligibilityView, { rows }),
  )
}

async function readyPr(app: YrdCliApp, selector: string, options: JsonOption, io: YrdCliIO): Promise<void> {
  await app.bays.ready({ pr: selector })
  const pr = app.bays.pr(selector)
  if (pr === undefined) throw new Error(`yrd: PR '${selector}' disappeared after ready`)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "pr.ready", pr: prFact(pr), eligibility: app.line.eligibility(pr.id) },
    createElement(PRResultView, { prs: [pr], runs: [] }),
  )
}

async function reviewPr(
  app: YrdCliApp,
  selector: string,
  options: JsonOption & Readonly<{ approve?: boolean; reject?: boolean; by?: string; ref?: string; note?: string }>,
  io: YrdCliIO,
): Promise<void> {
  if (options.approve === options.reject) usage("pr review requires exactly one of --approve or --reject")
  await app.bays.review({
    pr: selector,
    actor: options.by ?? io.executor ?? "operator",
    decision: options.approve === true ? "approve" : "reject",
    ...(options.ref === undefined ? {} : { ref: options.ref }),
    ...(options.note === undefined ? {} : { note: options.note }),
  })
  const pr = app.bays.pr(selector)
  if (pr === undefined) throw new Error(`yrd: PR '${selector}' disappeared after review`)
  const review =
    options.ref === undefined
      ? app.bays.reviewState(pr.id).current
      : pr.reviews.findLast((candidate) => candidate.ref === options.ref)
  if (review === undefined) throw new Error(`yrd: PR '${pr.id}' did not retain its current review`)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "pr.review", pr: prFact(pr), review, eligibility: app.line.eligibility(pr.id) },
    `${pr.id} revision ${pr.revision} ${review.decision} by ${review.actor}`,
  )
}

async function commentPr(
  app: YrdCliApp,
  selector: string,
  options: JsonOption & Readonly<{ by?: string; ref?: string; note?: string }>,
  io: YrdCliIO,
): Promise<void> {
  if (options.note === undefined || options.note.trim() === "") usage("pr comment requires --note <text>")
  await app.bays.comment({
    pr: selector,
    actor: options.by ?? io.executor ?? "operator",
    note: options.note,
    ...(options.ref === undefined ? {} : { ref: options.ref }),
  })
  const pr = app.bays.pr(selector)
  if (pr === undefined) throw new Error(`yrd: PR '${selector}' disappeared after comment`)
  const comment =
    options.ref === undefined ? pr.comments.at(-1) : pr.comments.findLast((candidate) => candidate.ref === options.ref)
  if (comment === undefined) throw new Error(`yrd: PR '${pr.id}' did not retain its comment`)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "pr.comment", pr: prFact(pr), comment },
    `${pr.id} revision ${pr.revision} commented by ${comment.actor}`,
  )
}

async function prChecks(
  app: YrdCliApp,
  selectors: readonly string[],
  options: JsonOption & Readonly<{ follow?: boolean }>,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  if (selectors.length === 0) usage("pr checks requires at least one PR selector")
  let checks: readonly PRCheckViewRecord[] = prCheckRecords(app, selectors)
  if (options.follow === true) {
    const missing = checks.find((check) => check.status === "not-requested")
    if (missing !== undefined) refusal(`PR '${missing.pr}' has no requested checks; submit it before following`)
    checks = await followCheckRecords(app, selectors, checks, io)
  }
  if (jsonEnabled(options)) {
    for (const check of checks) io.stdout(stableJson({ kind: "pr.check", ...check }))
  } else {
    await printHuman(io, createElement(PRChecksView, { records: checks, now: io.now?.() ?? Date.now() }))
  }
  return checks.some((check) => check.status === "failed") ? 1 : 0
}

function checksTerminal(records: readonly PRCheckViewRecord[]): boolean {
  return records.every((record) => record.status !== "queued" && record.status !== "checking")
}

async function followCheckRecords(
  app: YrdCliApp,
  selectors: readonly string[],
  initial: readonly PRCheckViewRecord[],
  io: YrdCliIO,
): Promise<readonly PRCheckViewRecord[]> {
  return tailJournal({
    initial: [...initial],
    intervalMs: 1_000,
    scope: io.scope ?? app.scope,
    done: checksTerminal,
    load: async () => {
      await app.refresh()
      return prCheckRecords(app, selectors)
    },
  })
}

async function optionalRevision(ref: string, io: YrdCliIO): Promise<string | undefined> {
  const cwd = io.cwd ?? process.cwd()
  return io.resolveRevision?.(ref, cwd)
}

async function resolvedLineTarget(ref: string, io: YrdCliIO): Promise<Readonly<{ base: string; sha?: string }>> {
  const cwd = io.cwd ?? process.cwd()
  if (io.resolveLineTarget !== undefined) return io.resolveLineTarget(ref, cwd)
  const sha = await optionalRevision(ref, io)
  return { base: ref, ...(sha === undefined ? {} : { sha }) }
}

type LineTargetGroup = Readonly<{ base: string; aliases: ReadonlySet<string>; headSha?: string }>

async function lineTargetGroups(bases: ReadonlySet<string>, io: YrdCliIO): Promise<LineTargetGroup[]> {
  const groups = new Map<string, { aliases: Set<string>; headSha?: string }>()
  for (const ref of [...bases].toSorted()) {
    const target = await resolvedLineTarget(ref, io)
    const group = groups.get(target.base) ?? { aliases: new Set<string>() }
    group.aliases.add(ref)
    group.aliases.add(target.base)
    if (target.sha !== undefined) group.headSha = target.sha
    groups.set(target.base, group)
  }
  return [...groups.entries()].map(([base, group]) => ({ base, ...group }))
}

async function submitBays(
  app: YrdCliApp,
  selectors: readonly string[],
  options: {
    wait?: boolean
    follow?: boolean
    draft?: boolean
    base?: string
    line?: string
    json?: boolean
    command?: "bay.submit" | "pr.submit"
  },
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const state = stateOf(app)
  const inferred =
    selectors.length > 0
      ? [...selectors]
      : selectedBays(state.bays, [], io.cwd ?? process.cwd(), "submit").map((bay) => bay.id)
  const prs: PR[] = []
  const base = oneOfAliases(options.base, options.line, "base", "line")
  for (const selector of inferred) {
    const pr = await app.bays.submitSelection(selector, {
      ...(base === undefined ? {} : { base }),
      ...(options.draft === true ? { draft: true } : {}),
      resolveRevision: (ref) => optionalRevision(ref, io),
      run: runtimeOptions(io),
    })
    prs.push(pr)
  }
  for (const pr of prs) await app.bays.requestChecks({ pr: pr.id })
  const admissions = await app.line.admit({})
  const followed =
    options.follow === true ? await app.line.admit({ prs: prs.map((pr) => pr.id) }, runtimeOptions(io)) : admissions
  const runs =
    options.wait === true ? await app.line.integrate({ prs: prs.map((pr) => pr.id) }, runtimeOptions(io)) : []
  const selected = prs.map((pr) => pr.id)
  let checks: readonly PRCheckViewRecord[] = prCheckRecords(app, selected)
  if (options.follow === true && !checksTerminal(checks)) checks = await followCheckRecords(app, selected, checks, io)
  const command = options.command ?? "bay.submit"
  await printResult(
    io,
    jsonEnabled(options),
    command === "pr.submit"
      ? { command, prs: prs.map(prFact), checks }
      : { command, prs: prs.map(prFact), ...(runs.length === 0 ? {} : { runs }) },
    createElement(PRResultView, {
      prs,
      runs: [...followed, ...runs],
      ...(command === "pr.submit" ? { checks } : {}),
      now: io.now?.() ?? Date.now(),
    }),
  )
  return checks.some((check) => check.status === "failed") ||
    [...followed, ...runs].some((run) => run.status === "failed")
    ? 1
    : 0
}

function prFact(pr: DeepReadonly<PR>): Readonly<{
  id: string
  branch: string
  base: string
  revision: number
  headSha: string
  baseSha?: string
}> {
  return {
    id: pr.id,
    branch: pr.branch,
    base: pr.base,
    revision: pr.revision,
    headSha: pr.headSha,
    ...(pr.baseSha === undefined ? {} : { baseSha: pr.baseSha }),
  }
}

function selectedCheckPRs(app: YrdCliApp, selectors: readonly string[]): PR[] {
  return selectors.map((selector) => {
    const pr = app.bays.pr(selector)
    if (pr === undefined) refusal(`no PR '${selector}'`)
    return pr
  })
}

function prCheckRecords(app: YrdCliApp, selectors: readonly string[]): PRCheckViewRecord[] {
  selectedCheckPRs(app, selectors)
  return [...app.line.checks(selectors)]
}

async function integrateLines(
  app: YrdCliApp,
  selectors: readonly string[],
  options: { steps?: unknown; retry?: boolean },
  io: YrdCliIO,
): Promise<readonly LineRun[]> {
  const steps = csv(options.steps)
  return app.line.integrate(
    {
      prs: [...selectors],
      ...(steps === undefined ? {} : { steps }),
      ...(options.retry === true ? { retry: true } : {}),
    },
    runtimeOptions(io),
  )
}

async function holdLine(
  app: YrdCliApp,
  base: string | undefined,
  options: JsonOption & Readonly<{ reason?: unknown; allow?: unknown }>,
  io: YrdCliIO,
): Promise<void> {
  const target = await resolvedLineTarget(base ?? "main", io)
  if (typeof options.reason !== "string" || options.reason.trim() === "") usage("--reason requires text")
  const hold = await app.line.hold({
    base: target.base,
    reason: options.reason,
    allowedPRs: csv(options.allow) ?? [],
  })
  const allowed = hold.allowedPRs.length === 0 ? "none" : hold.allowedPRs.join(", ")
  await printResult(
    io,
    jsonEnabled(options),
    { command: "line.hold", hold },
    `Line ${hold.base} held: ${hold.reason} (allowed: ${allowed})`,
  )
}

async function releaseLine(app: YrdCliApp, base: string | undefined, options: JsonOption, io: YrdCliIO): Promise<void> {
  const target = await resolvedLineTarget(base ?? "main", io)
  await app.line.release(target.base)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "line.release", base: target.base },
    `Line ${target.base} released`,
  )
}

async function lineStatus(
  app: YrdCliApp,
  selectors: readonly string[],
  options: JsonOption,
  io: YrdCliIO,
): Promise<void> {
  const state = stateOf(app)
  const target = resolveLineTargets(state, selectors, undefined, undefined)
  const { results } = await lineStatusSnapshots(app, state, target, io)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "line.status", results },
    createElement(LineStatusView, {
      state: state.bays,
      results,
      selected: target.selected,
      now: io.now?.() ?? Date.now(),
    }),
  )
}

async function lineStatusSnapshots(
  app: YrdCliApp,
  state: YrdCliState,
  target: { bases: Set<string>; selected: Set<string>; prFilter: string | undefined },
  io: YrdCliIO,
): Promise<{ results: readonly LineStatusResult[] }> {
  if (target.selected.size === 0 && target.bases.size === 0) {
    for (const pr of Object.values(state.bays.prs)) target.bases.add(pr.base)
    for (const run of Object.values(state.lines.records)) target.bases.add(run.base)
    if (target.bases.size === 0) target.bases.add("main")
  }
  const results: LineStatusResult[] = []
  for (const group of await lineTargetGroups(target.bases, io)) {
    const status = [...group.aliases].map((base) => app.line.status(base))
    const hold = status.find((entry) => entry.hold !== undefined)?.hold
    results.push({
      base: group.base,
      running: status.flatMap((summary) => summary.running),
      waiting: status.flatMap((summary) => summary.waiting),
      finished: status.flatMap((summary) => summary.finished),
      ...(hold === undefined ? {} : { hold }),
      ...(group.headSha === undefined ? {} : { headSha: group.headSha }),
      prs: Object.values(state.bays.prs).filter(
        (pr) => group.aliases.has(pr.base) && (target.selected.size === 0 || target.selected.has(pr.id)),
      ),
    })
  }
  return { results }
}

function resolveLineTargets(
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

function lineLogTargets(
  state: YrdCliState,
  selectors: readonly string[],
  base: string | undefined,
  pr: string | undefined,
): { bases: Set<string>; selected: Set<string>; prFilter: string | undefined } {
  const target = resolveLineTargets(state, selectors, base, pr)
  if (selectors.length === 0 && base === undefined && pr === undefined) {
    for (const item of Object.values(state.bays.prs)) target.bases.add(item.base)
    for (const run of Object.values(state.lines.records)) target.bases.add(run.base)
    if (target.bases.size === 0) target.bases.add("main")
  }
  return target
}

async function lineLog(
  app: YrdCliApp,
  selectors: readonly string[],
  options: { base?: string; pr?: string; json?: boolean },
  io: YrdCliIO,
): Promise<void> {
  const state = stateOf(app)
  const target = lineLogTargets(state, selectors, options.base, options.pr)
  const summaries: LineStatusResult[] = []
  for (const group of await lineTargetGroups(target.bases, io)) {
    const records = [...group.aliases].map((base) => app.line.status(base))
    summaries.push({
      base: group.base,
      running: records.flatMap((record) => record.running),
      waiting: records.flatMap((record) => record.waiting),
      finished: records.flatMap((record) => record.finished),
      ...(group.headSha === undefined ? {} : { headSha: group.headSha }),
      prs: Object.values(state.bays.prs).filter(
        (pr) => group.aliases.has(pr.base) && (target.selected.size === 0 || target.selected.has(pr.id)),
      ),
    })
  }
  const prStatusById = new Map<string, PR["status"]>(
    summaries.flatMap((result) => result.prs.map((pr) => [pr.id, pr.status])),
  )
  const attempts = await lineLogAttempts(app.events())
  const rows = lineLogRows(
    summaries,
    target.selected,
    target.prFilter,
    prStatusById,
    io.now?.() ?? Date.now(),
    attempts,
  )
  const coverage = await lineLegacyCoverage(io.cwd ?? process.cwd(), await firstEventTimestamp(app))
  await printResult(
    io,
    jsonEnabled(options),
    { command: "line.log", rows, ...(coverage === undefined ? {} : { coverage }) },
    createElement(LineLogView, { rows, coverage, columns: Math.min(io.columns ?? 120, 120) }),
  )
}

async function lineShow(app: YrdCliApp, selector: string, options: JsonOption, io: YrdCliIO): Promise<void> {
  const run = app.line.get(selector)
  if (run === undefined) refusal(`no line run '${selector}'`)
  const finished = Object.values(stateOf(app).lines.records)
    .map((record) => app.line.get(record.id))
    .filter(
      (candidate): candidate is LineRun =>
        candidate !== undefined && (candidate.status === "passed" || candidate.status === "failed"),
    )
  const attempts = await lineLogAttempts(app.events())
  const data = lineShowData(run, finished, attempts)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "line.show", run: data },
    createElement(LineShowView, { data }),
  )
}

async function lineAudit(
  app: YrdCliApp,
  services: YrdCliServices,
  options: JsonOption,
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const core = app.line.audit()
  const environment = await services.line?.auditEnvironment?.()
  const result = { findings: [...core.findings, ...(environment?.findings ?? [])] }
  await printResult(
    io,
    jsonEnabled(options),
    { command: "line.audit", ...result },
    result.findings.length === 0
      ? "line audit clean"
      : result.findings.map((finding) => `${finding.code}: ${finding.message}`).join("\n"),
  )
  return result.findings.length === 0 ? 0 : 1
}

async function recoverLine(
  app: YrdCliApp,
  options: JsonOption & Readonly<{ reason?: string }>,
  io: YrdCliIO,
): Promise<void> {
  if (options.reason?.trim() === "") usage("--reason requires text")
  const runs = await app.line.recover({
    ...runtimeOptions(io),
    recoveryTime: new Date(io.now?.() ?? Date.now()).toISOString(),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  })
  await printResult(
    io,
    jsonEnabled(options),
    { command: "line.recover", results: runs },
    createElement(LineRunsView, { runs }),
  )
}

async function lineAdministration(
  services: YrdCliServices,
  command: "init" | "deinit",
  base: string | undefined,
  options: JsonOption,
  io: YrdCliIO,
): Promise<void> {
  const action = command === "init" ? "provision" : "deprovision"
  const administration = services.line
  const capability = administration?.[action]
  if (capability === undefined) configuration(`line.${command} capability is not installed`)
  const result = await capability(base)
  await printResult(
    io,
    jsonEnabled(options),
    { command: `line.${command}`, base: base ?? "main", result },
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

async function finishLine(
  app: YrdCliApp,
  selector: string,
  options: {
    step?: string
    ok?: boolean
    fail?: boolean
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
  if (options.ok === options.fail) usage("line finish requires exactly one of --ok or --fail")
  const waiting = app.line.waiting(selector, options.step)
  const job = waiting.step.job
  const recordedArtifacts = artifacts(options.artifact)
  const exitCode = positiveInteger(options.exitCode, "--exit-code")
  const durationMs = positiveInteger(options.durationMs, "--duration-ms")
  const evidence = {
    ...jsonRecord(job.checkpoint),
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.url === undefined ? {} : { url: options.url }),
    ...(job.artifacts === undefined && recordedArtifacts === undefined
      ? {}
      : { artifacts: [...(job.artifacts ?? []), ...(recordedArtifacts ?? [])] }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(durationMs === undefined ? {} : { durationMs }),
  }
  const resumed = await app.line.finish(
    selector,
    {
      step: waiting.step.name,
      ...(options.token === undefined ? {} : { token: options.token }),
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
    { command: "line.finish", run: resumed },
    `${resumed.id} ${resumed.status}`,
  )
}

async function watchLine(
  app: YrdCliApp,
  selectors: readonly string[],
  options: { steps?: unknown; retry?: boolean; json?: boolean; interval?: number },
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
    const runs = await integrateLines(app, selectors, options, io)
    if (jsonEnabled(options)) {
      for (const run of runs) io.stdout(stableJson({ command: "line.integrate", mode: "watch", run }))
    } else if (runs.length > 0) {
      await printHuman(io, createElement(LineRunsView, { runs }))
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
  const load = async (): Promise<LineWatchSnapshot> => {
    await app.refresh()
    const state = stateOf(app)
    const target = resolveLineTargets(state, [], options.base, options.pr)
    const { results } = await lineStatusSnapshots(app, state, target, io)
    return { results, now: io.now?.() ?? Date.now() }
  }

  if (!jsonEnabled(options)) {
    const renderLive = getLiveRenderer(io)
    if (renderLive === undefined) {
      refusal("watch requires an interactive terminal; use --json for streaming output")
    }
    const initial = await load()
    await renderLive(createElement(LineWatchPane, { initial, load, intervalMs: interval }), {
      signal: scope.signal,
    })
    return 0
  }

  const initial = await load()
  await tailJournal({
    initial,
    load,
    intervalMs: interval,
    scope,
    done: () => false,
    visit: (snapshot) =>
      printResult(io, true, { command: "watch", results: snapshot.results }, createElement(LineWatchView, snapshot)),
  })
  return 0
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

async function competeTask(
  app: YrdCliApp,
  taskInput: string,
  options: { agents?: string; prompt?: string; evaluators?: unknown; base?: string; line?: string; json?: boolean },
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  if (options.agents === undefined) usage("task compete requires --agents <list>")
  if (options.prompt?.trim() === "") usage("--prompt requires non-empty text")
  const task = await app.tasks.resolve(app.tasks.ref(taskInput))
  const requestedBase = oneOfAliases(options.base, options.line, "base", "line")
  const base = await app.contests.resolveBase(requestedBase)
  const opened = await app.contests.compete({
    task,
    competitors: competitors(options.agents, options.prompt),
    ...(csv(options.evaluators) === undefined ? {} : { evaluators: csv(options.evaluators) }),
    base: base.base,
    baseSha: base.sha,
  })
  const contest = await advanceContest(app, opened.id, io)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "task.compete", contest },
    createElement(ContestStatusView, { contest }),
  )
  return contest.status === "failed" ? 1 : 0
}

async function showContest(app: YrdCliApp, id: string, options: JsonOption, io: YrdCliIO): Promise<void> {
  const contest = app.contests.get(id)
  if (contest === undefined) refusal(`no contest '${id}'`)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "contest.show", contest },
    createElement(ContestStatusView, { contest }),
  )
}

async function evaluateContest(
  app: YrdCliApp,
  id: string,
  options: { retry?: boolean; json?: boolean },
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const contest = await advanceContest(app, id, io, options.retry === true)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "contest.evaluate", contest },
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

function addExamples(program: CliCommand, name: string, projection: "root" | "bay"): void {
  const bay = projection === "bay" ? name : `${name} bay`
  const examples: [string, string][] = [
    [`$ ${bay} open fix --from topic`, "open an existing branch"],
    [`$ ${bay} submit --wait`, "submit and run the line"],
  ]
  if (projection === "root") {
    examples.push(
      [`$ ${name} line status`, "inspect active PRs"],
      [`$ ${name} line integrate --steps check,merge`, "run selected steps"],
      [`$ ${name} watch --pr PR7`, "monitor PR and queue health"],
      [`$ ${name} task compete km:T1 -a codex/claude`, "compare implementations"],
    )
  }
  program.addHelpSection("Examples:", examples)
}

function addLineExamples(line: CliCommand, name: string): void {
  line.addHelpSection("Examples:", [
    [`$ ${name} line status`, "show the default line"],
    [`$ ${name} line status release/2.0`, "show another base branch"],
    [`$ ${name} line integrate PR7 --steps check,merge`, "run selected steps for one PR"],
    [`$ ${name} line log --base release/2.0`, "show terminal completed log for a base"],
    [`$ ${name} line show R1`, "show step-level run evidence and proofs"],
    [`$ ${name} line hold --reason maintenance --allow PR7`, "hold all but selected PRs"],
    [`$ ${name} line integrate --watch`, "keep the default line moving"],
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
    .description(projection === "bay" ? "manage isolated Git work bays" : "software delivery orchestration")
    .showHelpAfterError()
    .showSuggestionAfterError()
  program.helpCommand(false)
  program.exitOverride()
  if (projection === "root") program.version(YRD_VERSION, "-V, --version")
  if (projection === "root") {
    program.addHelpSection(
      "Help:",
      "Yrd coordinates software work from task to delivery.\nBays isolate implementations. Lines verify and integrate them.\nContests compare alternatives before promotion.",
    )
  }

  const bay = projection === "bay" ? program : program.command("bay").description("manage isolated Git work bays")
  bay.helpCommand(false)
  bay
    .command("open <name>")
    .description("open a work bay")
    .option("--from <branch>", "use an existing source branch")
    .option("--head <branch>", "alias for --from")
    .option("--base <branch>", "select the base branch")
    .option("--line <branch>", "alias for --base")
    .option("--task <ref>", "link a tracker-neutral task reference")
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
    .option("--wait", "run the line before returning")
    .option("--base <branch>", "base branch for a direct branch submit")
    .option("--line <branch>", "alias for --base")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => setExit(await submitBays(installed(), selectors, options, io)))
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
    .command("watch")
    .description("monitor line progress")
    .option("--base <branch>", "scope watch to one base")
    .option("--pr <pr>", "scope watch to one PR")
    .option("--json", "emit stable JSON")
    .action(async (options) => {
      setExit(await watchQueue(installed(), options, io))
    })

  const line = program.command("line").description("manage integration lines")
  line.helpCommand(false)
  line
    .command("status [selector...]")
    .description("show line and PR status")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => lineStatus(installed(), selectors, options, io))
  line
    .command("log [selector...]")
    .description("show terminal log of finished PR runs")
    .option("--base <branch>", "scope log to one base branch")
    .option("--pr <pr>", "scope log to one PR")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => lineLog(installed(), selectors, options, io))
  line
    .command("show <run>")
    .description("show run steps and evidence")
    .option("--json", "emit stable JSON")
    .action(async (run, options) => lineShow(installed(), run, options, io))
  line
    .command("audit")
    .description("check line state")
    .option("--json", "emit stable JSON")
    .action(async (options) => setExit(await lineAudit(installed(), services, options, io)))
  line
    .command("init [base]")
    .description("prepare line resources")
    .option("--json", "emit stable JSON")
    .action(async (base, options) => lineAdministration(services, "init", base, options, io))
  line
    .command("deinit [base]")
    .description("release line resources")
    .option("--json", "emit stable JSON")
    .action(async (base, options) => lineAdministration(services, "deinit", base, options, io))
  line
    .command("hold [base]")
    .description("hold new line runs")
    .requiredOption("--reason <text>", "record the hold reason")
    .option("--allow [pr...]", "PR ids allowed through the hold")
    .option("--json", "emit stable JSON")
    .action(async (base, options) => holdLine(installed(), base, options, io))
  line
    .command("release [base]")
    .description("release a line hold")
    .option("--json", "emit stable JSON")
    .action(async (base, options) => releaseLine(installed(), base, options, io))
  line
    .command("recover")
    .description("recover expired runner leases")
    .option("--reason <text>", "record the recovery reason")
    .option("--json", "emit stable JSON")
    .action(async (options) => recoverLine(installed(), options, io))
  line
    .command("integrate [selector...]")
    .description("run line steps for PRs")
    .option("--steps [step...]", "registered step names, comma-separated or repeated")
    .option("--retry", "retry rejected PRs")
    .option("--watch", "keep draining the default line")
    .option("--interval <seconds>", "watch interval in seconds", int)
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => {
      if (options.watch === true) {
        setExit(await watchLine(installed(), selectors, options, io))
        return
      }
      const runs = await integrateLines(installed(), selectors, options, io)
      await printResult(
        io,
        jsonEnabled(options),
        { command: "line.integrate", results: runs },
        createElement(LineRunsView, { runs }),
      )
      setExit(runs.some((run) => run.status === "failed") ? 1 : 0)
    })
  line
    .command("finish <selector>")
    .description("resume a waiting step")
    .option("--step <name>", "waiting step name")
    .option("--ok", "record a passing result")
    .option("--fail", "record a failing result")
    .option("--token <token>", "waiting-job correlation token")
    .option("--detail <text>", "human-readable result detail")
    .option("--url <url>", "external runner URL")
    .option("--artifact [artifact...]", "artifact name=path-or-url")
    .option("--exit-code <code>", "external process exit code", int)
    .option("--duration-ms <milliseconds>", "external duration", int)
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => finishLine(installed(), selector, options, io))
  addLineExamples(line, name)

  const pr = program.command("pr").description("manage pull requests")
  pr.helpCommand(false)
  pr.command("submit [selector...]")
    .description("submit PR revisions and admit configured checks")
    .option("--draft", "leave the PR pushed until pr ready")
    .option("--follow", "follow admitted checks to a terminal result")
    .option("--base <branch>", "base branch for a direct branch submit")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) =>
      setExit(await submitBays(installed(), selectors, { ...options, command: "pr.submit" }, io)),
    )
  pr.command("list")
    .description("list PR eligibility")
    .option("--needs-review", "show revisions needing approval")
    .option("--json", "emit stable JSON")
    .action(async (options) => listPrs(installed(), options, io))
  pr.command("ready <selector>")
    .description("move a pushed PR revision into the queue")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => readyPr(installed(), selector, options, io))
  pr.command("review <selector>")
    .description("record a revision-bound review verdict")
    .option("--approve", "approve the current revision")
    .option("--reject", "reject the current revision")
    .option("--by <actor>", "reviewer identity")
    .option("--ref <id>", "idempotency reference")
    .option("--note <text>", "review note")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => reviewPr(installed(), selector, options, io))
  pr.command("comment <selector>")
    .description("record a non-gating revision comment")
    .option("--by <actor>", "commenter identity")
    .option("--ref <id>", "idempotency reference")
    .requiredOption("--note <text>", "comment text")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => commentPr(installed(), selector, options, io))
  pr.command("checks <selector...>")
    .description("show admitted checks for current PR revisions")
    .option("--follow", "follow active checks to a terminal result")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => setExit(await prChecks(installed(), selectors, options, io)))
  pr.command("close [selector...]")
    .description("close a live PR without merging (leaves it out of the line)")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => closePrs(installed(), selectors, options, io))

  const task = program.command("task").description("orchestrate tracker-neutral tasks")
  task.helpCommand(false)
  task
    .command("compete <task>")
    .description("compare implementations of one real task")
    .option("-a, --agents <agents>", "ag-style competitor list")
    .option("--prompt <text>", "additional implementation instructions")
    .option("--evaluators [evaluator...]", "evaluator ids, comma-separated or repeated")
    .option("--base <branch>", "base branch")
    .option("--line <branch>", "alias for --base")
    .option("--json", "emit stable JSON")
    .action(async (taskId, options) => setExit(await competeTask(installed(), taskId, options, io)))

  const contest = program.command("contest").description("inspect and select contest attempts")
  contest.helpCommand(false)
  contest
    .command("evaluate <contest>")
    .description("run pending work and evaluators")
    .option("--retry", "retry failed work or re-evaluate failed verdicts")
    .option("--json", "emit stable JSON")
    .action(async (contestId, options) => setExit(await evaluateContest(installed(), contestId, options, io)))
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
    .command("show <contest>")
    .description("show attempts, metrics, and evidence")
    .option("--json", "emit stable JSON")
    .action(async (contestId, options) => showContest(installed(), contestId, options, io))
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
  const args = invocation.args.length === 0 ? ["--help"] : invocation.args
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
