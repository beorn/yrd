import { isAbsolute, relative, resolve } from "node:path"
import { Command as CliCommand, CommanderError, int } from "@silvery/commander"
import { createElement } from "react"
import { resolveBay, resolveSubmission, submissionForBay, type Bay, type BaysState, type Submission } from "@yrd/bay"
import type { Contest, ContestsState } from "@yrd/contest"
import type { Command, CommandRun, EffectRun, EffectsState } from "@yrd/core"
import type { LineRun, LinesState } from "@yrd/line"
import { classifyFailure, configuration, refusal, resolveInvocation, stableJson, usage } from "./invocation.ts"
import { LineRunsView, LineStatusView, SubmissionResultView, type LineStatusResult } from "./line-status-view.tsx"
import { diagnostic, printHuman, printResult } from "./output.tsx"
import { BayStatusView, ContestStatusView } from "./status-view.tsx"
import type {
  LineAuditFinding,
  LineAuditResult,
  YrdCliApp,
  YrdCliExitCode,
  YrdCliIO,
  YrdCliLineAdministration,
} from "./types.ts"

type CliState = {
  effects: EffectsState
  bays: BaysState
  lines: LinesState
  contests: ContestsState
}

type RuntimeOptions = {
  executor: string
  leaseMs: number
  now?: () => number
}

type JsonOption = { json?: boolean }

function runtimeOptions(io: YrdCliIO): RuntimeOptions {
  return {
    executor: io.executor ?? "yrd-cli",
    leaseMs: io.leaseMs ?? 5 * 60_000,
    ...(io.now === undefined ? {} : { now: io.now }),
  }
}

async function stateOf(app: YrdCliApp): Promise<CliState> {
  return (await app.state()) as CliState
}

function installedCommand<Args>(
  app: YrdCliApp,
  expectedPath: string,
  command: Command<Args, any> | undefined,
  visibility: "public" | "internal" = "public",
): Command<Args, any> {
  if (command === undefined) configuration(`${expectedPath} capability is not installed`)
  const path = app.commandRegistry.pathOf(command)
  if (path?.join(".") !== expectedPath) {
    configuration(`${expectedPath} is not registered to its command object reference`)
  }
  if (command.metadata.visibility !== visibility) {
    configuration(`${expectedPath} is ${command.metadata.visibility}, expected ${visibility}`)
  }
  return command
}

async function invokePublic<Args>(
  app: YrdCliApp,
  path: string,
  command: Command<Args, any> | undefined,
  args: Args,
): Promise<CommandRun> {
  return await app.command(installedCommand(app, path, command), args)
}

async function runEffects(app: YrdCliApp, ids: readonly string[], io: YrdCliIO): Promise<EffectRun[]> {
  const results: EffectRun[] = []
  for (const id of ids) {
    let run = (await stateOf(app)).effects.runs[id]
    if (run === undefined) throw new Error(`yrd: effect '${id}' disappeared after it was requested`)
    if (run.status === "requested") run = await app.effectRuns.run(id, runtimeOptions(io))
    results.push(run)
  }
  return results
}

function assertEffectsPassed(runs: readonly EffectRun[], action: string): void {
  const unresolved = runs.find((run) => run.status !== "passed")
  if (unresolved === undefined) return
  const detail = unresolved.error?.message ?? unresolved.lostReason ?? unresolved.detail ?? unresolved.status
  refusal(`${action} ${unresolved.status}: ${detail}`)
}

function within(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child))
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

function currentBay(state: BaysState, cwd: string): Bay | undefined {
  return Object.values(state.bays)
    .filter((bay) => bay.path !== undefined && within(bay.path, cwd))
    .sort((left, right) => right.path!.length - left.path!.length)[0]
}

function sortedBays(state: BaysState): Bay[] {
  return Object.values(state.bays).sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))
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
  options: { from?: string; head?: string; base?: string; line?: string; json?: boolean },
  io: YrdCliIO,
): Promise<void> {
  const from = oneOfAliases(options.from, options.head, "from", "head")
  const base = oneOfAliases(options.base, options.line, "base", "line")
  const command = await invokePublic(app, "bay.open", app.commands.bay.open, {
    name,
    ...(from === undefined ? {} : { from }),
    ...(base === undefined ? {} : { base }),
  })
  assertEffectsPassed(await runEffects(app, command.effectIds, io), `bay '${name}' provision`)
  const id = (command.events.find((applied) => applied.name === "bay/opened")?.data as { id?: unknown } | undefined)?.id
  if (typeof id !== "string") throw new Error("yrd: bay.open did not identify the opened bay")
  const bay = resolveBay((await stateOf(app)).bays, id)
  if (bay?.path === undefined || bay.status !== "active") refusal(`bay '${id}' did not become active`)
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
  const state = await stateOf(app)
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
  const command = await invokePublic(app, "bay.refresh", app.commands.bay.refresh, { bay: bay.id })
  assertEffectsPassed(await runEffects(app, command.effectIds, io), `bay '${bay.id}' refresh`)
  const refreshed = resolveBay((await stateOf(app)).bays, bay.id)
  if (refreshed === undefined) throw new Error(`yrd: bay '${bay.id}' disappeared after refresh`)
  return refreshed
}

async function closeBays(
  app: YrdCliApp,
  selectors: readonly string[],
  options: { withdraw?: boolean; json?: boolean },
  io: YrdCliIO,
): Promise<void> {
  const bays = selectedBays((await stateOf(app)).bays, selectors, io.cwd ?? process.cwd(), "close")
  const closed: Bay[] = []
  for (const bay of bays) {
    const command = await invokePublic(app, "bay.close", app.commands.bay.close, {
      bay: bay.id,
      ...(options.withdraw === true ? { withdraw: true } : {}),
    })
    assertEffectsPassed(await runEffects(app, command.effectIds, io), `bay '${bay.id}' close`)
    const current = resolveBay((await stateOf(app)).bays, bay.id)
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

async function resolveRevision(ref: string, io: YrdCliIO): Promise<string> {
  const cwd = io.cwd ?? process.cwd()
  if (io.resolveRevision !== undefined) {
    const resolved = await io.resolveRevision(ref, cwd)
    if (resolved === undefined) refusal(`no Git commit '${ref}'`)
    return resolved
  }
  const child = Bun.spawn(["git", "-C", cwd, "rev-parse", "--verify", `${ref}^{commit}`], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) refusal(stderr.trim() || `no Git commit '${ref}'`)
  return stdout.trim()
}

async function submitBay(
  app: YrdCliApp,
  selector: string,
  base: string | undefined,
  io: YrdCliIO,
): Promise<Submission> {
  let state = await stateOf(app)
  let submission = resolveSubmission(state.bays, selector)
  let bay =
    resolveBay(state.bays, selector) ??
    (submission?.bay === undefined ? undefined : resolveBay(state.bays, submission.bay))
  if (submission?.status === "integrated") return submission
  if (bay?.status === "active") {
    bay = await refreshBay(app, bay, io)
    if (bay.dirty === true) refusal(`bay '${bay.id}' has uncommitted work; commit or discard it before submit`)
    if (bay.headSha === undefined) refusal(`bay '${bay.id}' has no committed head to submit`)
    state = await stateOf(app)
    submission = submissionForBay(state.bays, bay.id)
    if (submission === undefined || submission.headSha !== bay.headSha) {
      const intake = installedCommand(app, "bay.intake", app.commands.bay.intake, "internal")
      await app.command(intake, {
        bay: bay.id,
        headSha: bay.headSha,
        ...(bay.baseSha === undefined ? {} : { baseSha: bay.baseSha }),
      })
      state = await stateOf(app)
      submission = submissionForBay(state.bays, bay.id)
    }
  }
  if (submission?.status === "submitted") return submission
  if (submission?.status === "pushed") {
    await invokePublic(app, "bay.submit", app.commands.bay.submit, { submission: submission.id })
    return resolveSubmission((await stateOf(app)).bays, submission.id)!
  }

  if (bay === undefined) {
    await invokePublic(app, "bay.submit", app.commands.bay.submit, {
      branch: selector,
      headSha: await resolveRevision(selector, io),
      ...(base === undefined ? {} : { base }),
    })
    const direct = resolveSubmission((await stateOf(app)).bays, selector)
    if (direct === undefined) throw new Error(`yrd: direct branch submit '${selector}' did not create a submission`)
    return direct
  }
  if (bay.status !== "active") refusal(`bay '${bay.id}' is ${bay.status}, not active`)
  if (submission === undefined) throw new Error(`yrd: bay '${bay.id}' intake did not create a submission`)
  refusal(`submission '${submission.id}' is ${submission.status}, not pushed`)
}

async function submitBays(
  app: YrdCliApp,
  selectors: readonly string[],
  options: { wait?: boolean; base?: string; line?: string; json?: boolean },
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  const state = await stateOf(app)
  const inferred =
    selectors.length > 0
      ? [...selectors]
      : selectedBays(state.bays, [], io.cwd ?? process.cwd(), "submit").map((bay) => bay.id)
  const submissions: Submission[] = []
  const base = oneOfAliases(options.base, options.line, "base", "line")
  for (const selector of inferred) {
    const submission = await submitBay(app, selector, base, io)
    submissions.push(submission)
  }
  const runs =
    options.wait === true
      ? await app.line.integrate({ submissions: submissions.map((submission) => submission.id) }, runtimeOptions(io))
      : []
  await printResult(
    io,
    jsonEnabled(options),
    { command: "bay.submit", submissions, ...(runs.length === 0 ? {} : { runs }) },
    createElement(SubmissionResultView, { submissions, runs }),
  )
  return runs.some((run) => run.status === "failed") ? 1 : 0
}

function lineTargets(state: CliState, selectors: readonly string[], retry: boolean): Submission[] {
  if (selectors.length > 0) {
    return unique(
      selectors.map((selector) => {
        const submission = resolveSubmission(state.bays, selector)
        if (submission === undefined) refusal(`no submission '${selector}'`)
        return submission
      }),
    )
  }
  return Object.values(state.bays.submissions)
    .filter((submission) => submission.status === "submitted" || (retry && submission.status === "rejected"))
    .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))
}

async function integrateLines(
  app: YrdCliApp,
  selectors: readonly string[],
  options: { steps?: unknown; retry?: boolean },
  io: YrdCliIO,
): Promise<LineRun[]> {
  installedCommand(app, "line.integrate", app.commands.line.integrate)
  const steps = csv(options.steps)
  const submissions = lineTargets(await stateOf(app), selectors, options.retry === true)
  return await app.line.integrate(
    {
      submissions: submissions.map((submission) => submission.id),
      ...(steps === undefined ? {} : { steps }),
      ...(options.retry === true ? { retry: true } : {}),
    },
    runtimeOptions(io),
  )
}

async function lineStatus(
  app: YrdCliApp,
  selectors: readonly string[],
  options: JsonOption,
  io: YrdCliIO,
): Promise<void> {
  const state = await stateOf(app)
  const bases = new Set<string>()
  const selected = new Set<string>()
  for (const selector of selectors) {
    const submission = resolveSubmission(state.bays, selector)
    if (submission === undefined) bases.add(selector)
    else {
      bases.add(submission.base)
      selected.add(submission.id)
    }
  }
  if (selectors.length === 0) {
    for (const submission of Object.values(state.bays.submissions)) bases.add(submission.base)
    for (const run of Object.values(state.lines.runs)) bases.add(run.base)
    if (bases.size === 0) bases.add("main")
  }
  const results: LineStatusResult[] = []
  for (const base of [...bases].sort()) {
    const summary = await app.line.status(base)
    results.push({
      ...summary,
      submissions: Object.values(state.bays.submissions).filter(
        (submission) => submission.base === base && (selected.size === 0 || selected.has(submission.id)),
      ),
    })
  }
  await printResult(
    io,
    jsonEnabled(options),
    { command: "line.status", results },
    createElement(LineStatusView, {
      state: state.bays,
      results,
      selected,
      now: io.now?.() ?? Date.now(),
    }),
  )
}

function localLineAudit(state: CliState): LineAuditResult {
  const findings: LineAuditFinding[] = []
  const installed = Object.values(state.lines.installed).sort((left, right) => left.index - right.index)
  installed.forEach((step, index) => {
    if (step.index !== index) {
      findings.push({
        code: "step-index-gap",
        message: `line step '${step.name}' has index ${step.index}, expected ${index}`,
      })
    }
  })
  for (const run of Object.values(state.lines.runs)) {
    for (const submission of run.submissions) {
      if (state.bays.submissions[submission.id] !== undefined) continue
      findings.push({
        code: "missing-submission",
        message: `line run '${run.id}' references missing submission '${submission.id}'`,
        run: run.id,
        submission: submission.id,
      })
    }
    for (const step of run.steps) {
      if (step.effectId !== undefined && state.effects.runs[step.effectId] === undefined) {
        findings.push({
          code: "missing-effect",
          message: `line run '${run.id}' step '${step.name}' references missing effect '${step.effectId}'`,
          run: run.id,
          submission: run.submission.id,
        })
      }
    }
  }
  return { findings }
}

async function lineAudit(app: YrdCliApp, options: JsonOption, io: YrdCliIO): Promise<YrdCliExitCode> {
  const administration = app.line as typeof app.line & YrdCliLineAdministration
  const result = administration.audit === undefined ? localLineAudit(await stateOf(app)) : await administration.audit()
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

async function lineAdministration(
  app: YrdCliApp,
  action: "provision" | "deprovision",
  base: string | undefined,
  options: JsonOption,
  io: YrdCliIO,
): Promise<void> {
  const administration = app.line as typeof app.line & YrdCliLineAdministration
  const capability = administration[action]
  if (capability === undefined) configuration(`line.${action} capability is not installed`)
  const result = await capability.call(administration, base)
  await printResult(
    io,
    jsonEnabled(options),
    { command: `line.${action}`, base: base ?? "main", result },
    `${base ?? "main"} ${action}ed`,
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
    if (separator <= 0 || separator === item.length - 1)
      usage(`invalid --artifact '${item}'; expected name=path-or-url`)
    return { name: item.slice(0, separator), uri: item.slice(separator + 1) }
  })
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

async function waitingLineRun(app: YrdCliApp, selector: string, stepName?: string): Promise<LineRun> {
  const direct = await app.line.get(selector)
  if (direct !== undefined) return direct
  const state = await stateOf(app)
  const submission = resolveSubmission(state.bays, selector)
  if (submission === undefined) refusal(`no line run or submission '${selector}'`)
  const summary = await app.line.status(submission.base)
  const run = [...summary.waiting, ...summary.running]
    .reverse()
    .find(
      (candidate) =>
        candidate.submissions.some((member) => member.id === submission.id) &&
        candidate.steps.some((step) => (stepName === undefined ? step.status === "waiting" : step.name === stepName)),
    )
  if (run === undefined) {
    refusal(
      stepName === undefined
        ? `submission '${submission.id}' has no waiting step`
        : `submission '${submission.id}' has no active '${stepName}' step`,
    )
  }
  return run
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
  const run = await waitingLineRun(app, selector, options.step)
  const state = await stateOf(app)
  const waiting = run.steps.filter(
    (candidate) => candidate.effectId !== undefined && state.effects.runs[candidate.effectId]?.status === "waiting",
  )
  const step =
    options.step === undefined
      ? waiting.length === 1
        ? waiting[0]
        : undefined
      : run.steps.find((candidate) => candidate.name === options.step)
  if (options.step === undefined && waiting.length !== 1) {
    usage(
      waiting.length === 0
        ? `line run '${run.id}' has no waiting step`
        : `line run '${run.id}' has multiple waiting steps; use --step <name>`,
    )
  }
  if (step?.effectId === undefined) {
    refusal(`line run '${run.id}' step '${options.step ?? "unknown"}' has no durable effect`)
  }
  const effectRun = state.effects.runs[step.effectId]
  if (effectRun === undefined) throw new Error(`yrd: line run '${run.id}' lost effect '${step.effectId}'`)
  if (effectRun.status !== "waiting")
    refusal(`line run '${run.id}' step '${step.name}' is ${effectRun.status}, not waiting`)
  const recordedArtifacts = artifacts(options.artifact)
  const exitCode = positiveInteger(options.exitCode, "--exit-code")
  const durationMs = positiveInteger(options.durationMs, "--duration-ms")
  const evidence = {
    ...jsonRecord(effectRun.checkpoint),
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.url === undefined ? {} : { url: options.url }),
    ...(effectRun.artifacts === undefined && recordedArtifacts === undefined
      ? {}
      : { artifacts: [...(effectRun.artifacts ?? []), ...(recordedArtifacts ?? [])] }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(durationMs === undefined ? {} : { durationMs }),
  }
  const transition = installedCommand(app, "effect.transition", app.commands.effect.transition, "internal")
  await app.command(transition, {
    type: "finish",
    id: effectRun.id,
    attempt: effectRun.attempt,
    ...(options.token === undefined ? {} : { token: options.token }),
    outcome:
      options.ok === true
        ? { status: "passed", output: evidence }
        : {
            status: "failed",
            error: {
              code: `${step.name}-failed`,
              message: options.detail ?? `${step.name} failed externally`,
            },
            output: evidence,
          },
  })
  const resumed = await app.line.run(run.id, runtimeOptions(io))
  await printResult(
    io,
    jsonEnabled(options),
    { command: "line.finish", run: resumed },
    `${resumed.id} ${resumed.status}`,
  )
}

async function sleep(milliseconds: number, io: YrdCliIO): Promise<void> {
  if (io.sleep !== undefined) return await io.sleep(milliseconds, io.signal)
  await new Promise<void>((complete) => {
    if (io.signal?.aborted === true) return complete()
    const timeout = setTimeout(complete, milliseconds)
    io.signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout)
        complete()
      },
      { once: true },
    )
  })
}

function aborted(io: YrdCliIO): boolean {
  return io.signal?.aborted === true
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
  let exit: YrdCliExitCode = 0
  while (true) {
    const runs = await integrateLines(app, selectors, options, io)
    if (jsonEnabled(options)) {
      for (const run of runs) io.stdout(stableJson({ command: "line.watch", run }))
    } else if (runs.length > 0) {
      await printHuman(io, createElement(LineRunsView, { runs }))
    }
    if (runs.some((run) => run.status === "failed")) exit = 1
    if (selectors.length > 0 || aborted(io)) return exit
    await sleep(interval, io)
    if (aborted(io)) return exit
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

async function runContest(app: YrdCliApp, contest: string, io: YrdCliIO): Promise<Contest> {
  const concurrency = io.concurrency ?? 8
  if (!Number.isInteger(concurrency) || concurrency < 1) usage("contest concurrency must be a positive integer")
  return await app.contests.run(contest, { ...runtimeOptions(io), concurrency })
}

function contestId(command: CommandRun): string {
  const opened = command.events.find((applied) => applied.name === "contest/opened")
  const id = (opened?.data as { contest?: { id?: unknown } } | undefined)?.contest?.id
  if (typeof id !== "string") throw new Error("yrd: task.compete did not identify the contest")
  return id
}

async function competeTask(
  app: YrdCliApp,
  taskInput: string,
  options: { agents?: string; prompt?: string; evaluators?: unknown; base?: string; line?: string; json?: boolean },
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  if (options.agents === undefined) usage("task compete requires --agents <list>")
  if (options.prompt !== undefined && options.prompt.trim() === "") usage("--prompt requires non-empty text")
  const task = await app.tasks.resolve(app.tasks.ref(taskInput))
  const requestedBase = oneOfAliases(options.base, options.line, "base", "line")
  const base = await app.contests.resolveBase(requestedBase)
  const command = await invokePublic(app, "task.compete", app.commands.task.compete, {
    task,
    competitors: competitors(options.agents, options.prompt),
    ...(csv(options.evaluators) === undefined ? {} : { evaluators: csv(options.evaluators) }),
    base: base.base,
    baseSha: base.sha,
  })
  const contest = await runContest(app, contestId(command), io)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "task.compete", contest },
    createElement(ContestStatusView, { contest }),
  )
  return contest.status === "failed" ? 1 : 0
}

async function showContest(app: YrdCliApp, id: string, options: JsonOption, io: YrdCliIO): Promise<void> {
  const contest = await app.contests.show(id)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "contest.show", contest },
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
  await invokePublic(app, "contest.select", app.commands.contest.select, {
    contest: id,
    attempt: options.winner,
    ...(options.by === undefined ? {} : { selectedBy: options.by }),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  })
  const contest = await app.contests.show(id)
  await printResult(
    io,
    jsonEnabled(options),
    { command: "contest.select", contest },
    createElement(ContestStatusView, { contest }),
  )
}

async function promoteContest(app: YrdCliApp, id: string, options: JsonOption, io: YrdCliIO): Promise<YrdCliExitCode> {
  await invokePublic(app, "contest.promote", app.commands.contest.promote, { contest: id })
  const contest = await runContest(app, id, io)
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
    [`$ ${bay} open fix --from topic`, "open from an existing source branch"],
    [`$ ${bay} submit --wait`, "submit the current bay and run its line"],
  ]
  if (projection === "root") {
    examples.push(
      [`$ ${name} line status`, "inspect active PRs and evidence"],
      [`$ ${name} line integrate --steps check,merge`, "run selected integration steps"],
      [`$ ${name} task compete km:T1 -a codex/claude`, "run a real-task contest"],
    )
  }
  program.addHelpSection("Examples:", examples)
}

function buildProgram(
  app: YrdCliApp,
  name: string,
  projection: "root" | "bay",
  io: YrdCliIO,
  setExit: (code: YrdCliExitCode) => void,
  commanderOutput: { wroteError: boolean },
): CliCommand {
  const program = new CliCommand(name)
    .description(
      projection === "bay"
        ? "operate isolated Git work bays"
        : "software-development orchestration for tasks, bays, integration lines, and contests",
    )
    .showHelpAfterError()
    .showSuggestionAfterError()
  program.helpCommand(false)
  program.exitOverride()

  const bay = projection === "bay" ? program : program.command("bay").description("operate isolated Git work bays")
  bay.helpCommand(false)
  bay
    .command("open <name>")
    .description("open a bay and print its worktree path")
    .option("--from <branch>", "use an existing source branch")
    .option("--head <branch>", "alias for --from")
    .option("--base <branch>", "select the base branch")
    .option("--line <branch>", "alias for --base")
    .option("--json", "emit stable JSON")
    .action(async (workName, options) => await openBay(app, workName, options, io))
  bay
    .command("refresh [selector...]")
    .description("refresh zero or more live bay leases")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => await refreshBays(app, selectors, options, io))
  bay
    .command("submit [selector...]")
    .description("submit zero or more bays or pushed revisions")
    .option("--wait", "run the line before returning")
    .option("--base <branch>", "base branch for a direct branch submit")
    .option("--line <branch>", "alias for --base")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => setExit(await submitBays(app, selectors, options, io)))
  bay
    .command("close [selector...]")
    .description("close zero or more bays")
    .option("--withdraw", "withdraw a live submission before closing")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => await closeBays(app, selectors, options, io))

  if (projection === "bay") {
    addExamples(program, name, projection)
    configureOutput(program, io, commanderOutput)
    return program
  }

  const line = program.command("line").description("inspect and run integration lines")
  line.helpCommand(false)
  line
    .command("status [selector...]")
    .description("show line or submission status")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => await lineStatus(app, selectors, options, io))
  line
    .command("audit")
    .description("audit folded line state")
    .option("--json", "emit stable JSON")
    .action(async (options) => setExit(await lineAudit(app, options, io)))
  line
    .command("provision [base]")
    .description("run the installed line-environment provision preflight")
    .option("--json", "emit stable JSON")
    .action(async (base, options) => await lineAdministration(app, "provision", base, options, io))
  line
    .command("deprovision [base]")
    .description("release installed line-environment resources")
    .option("--json", "emit stable JSON")
    .action(async (base, options) => await lineAdministration(app, "deprovision", base, options, io))
  line
    .command("integrate [selector...]")
    .description("run selected line steps for zero or more submissions")
    .option("--steps [step...]", "registered step names, comma-separated or repeated")
    .option("--retry", "retry rejected submissions")
    .option("--watch", "keep draining the default line")
    .option("--interval <seconds>", "watch interval in seconds", int)
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => {
      if (options.watch === true) {
        setExit(await watchLine(app, selectors, options, io))
        return
      }
      const runs = await integrateLines(app, selectors, options, io)
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
    .description("finish one waiting external line step and resume its run")
    .option("--step <name>", "waiting step name")
    .option("--ok", "record a passing result")
    .option("--fail", "record a failing result")
    .option("--token <token>", "waiting-effect correlation token")
    .option("--detail <text>", "human-readable result detail")
    .option("--url <url>", "external runner URL")
    .option("--artifact [artifact...]", "artifact name=path-or-url")
    .option("--exit-code <code>", "external process exit code", int)
    .option("--duration-ms <milliseconds>", "external duration", int)
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => await finishLine(app, selector, options, io))
  line
    .command("watch [selector...]")
    .description("keep draining runnable submissions")
    .option("--steps [step...]", "registered step names, comma-separated or repeated")
    .option("--retry", "retry rejected submissions")
    .option("--interval <seconds>", "poll interval in seconds", int)
    .option("--json", "emit stable JSON lines")
    .action(async (selectors, options) => setExit(await watchLine(app, selectors, options, io)))

  const task = program.command("task").description("orchestrate work from tracker-neutral tasks")
  task.helpCommand(false)
  task
    .command("compete <task>")
    .description("run multiple model and harness competitors on one real task")
    .option("-a, --agents <agents>", "ag-style competitor list")
    .option("--prompt <text>", "additional implementation instructions")
    .option("--evaluators [evaluator...]", "evaluator ids, comma-separated or repeated")
    .option("--base <branch>", "base branch")
    .option("--line <branch>", "alias for --base")
    .option("--json", "emit stable JSON")
    .action(async (taskId, options) => setExit(await competeTask(app, taskId, options, io)))

  const contest = program.command("contest").description("inspect and choose immutable contest attempts")
  contest.helpCommand(false)
  contest
    .command("show <contest>")
    .description("show recorded attempts, metrics, evidence, and selection")
    .option("--json", "emit stable JSON")
    .action(async (contestId, options) => await showContest(app, contestId, options, io))
  contest
    .command("select <contest>")
    .description("record a manual winner")
    .option("--winner <attempt>", "winning attempt id")
    .option("--by <actor>", "selector identity")
    .option("--reason <text>", "selection rationale")
    .option("--json", "emit stable JSON")
    .action(async (contestId, options) => await selectContest(app, contestId, options, io))
  contest
    .command("promote <contest>")
    .description("verify and submit the exact selected Git pin")
    .option("--json", "emit stable JSON")
    .action(async (contestId, options) => setExit(await promoteContest(app, contestId, options, io)))

  addExamples(program, name, projection)
  configureOutput(program, io, commanderOutput)
  return program
}

/** Run the one Yrd command surface. git-bay projects its canonical bay subtree;
 * every mutation still resolves through the composed app's command registry. */
export async function runYrd(app: YrdCliApp, argv: readonly string[], io: YrdCliIO): Promise<YrdCliExitCode> {
  const invocation = resolveInvocation(argv)
  let exit: YrdCliExitCode = 0
  const setExit = (code: YrdCliExitCode) => {
    exit = maxExit(exit, code)
  }
  const commanderOutput = { wroteError: false }
  const program = buildProgram(app, invocation.name, invocation.projection, io, setExit, commanderOutput)
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
    const code = classifyFailure(error)
    await diagnostic(io, invocation.name, error)
    return code
  }
}
