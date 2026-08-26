import { int, type Command as CliCommand } from "@silvery/commander"
import { createElement, Fragment } from "react"
import { queuePauseWarnings, Queues } from "@yrd/queue"
import { refusal, refuseShadowedQueueFilterTerms, usage } from "../invocation.ts"
import { getLiveRenderer } from "../live-renderer.ts"
import { printResult, printResultWithWarnings } from "../output.tsx"
import { queueReadFailureMessage } from "../queue-read-failure.ts"
import { QueueRunsView, QueueTimelineView } from "../queue-status-view.tsx"
import {
  admissionBlockedChanges,
  cancelAttempt,
  cancelQueueRun,
  checkQueueRunner,
  createQueueListSnapshotLoader,
  finishQueue,
  followQueueRuns,
  jsonEnabled,
  listQueues,
  logRuns,
  needsPersonWarnings,
  pauseQueue,
  preparePublicationQueueCycle,
  projectChangeTaskStatusWithEligibility,
  projectEligibilityTaskStatus,
  projectPublication,
  projectQueueStatusResultTaskStatus,
  QUEUE_TIMELINE_STATUS_HELP,
  queueAudit,
  queueUncarried,
  refuseRetiredQueueCandidateRefs,
  refuseRetiredQueueRecover,
  requestYrdRuntimeReload,
  requiredPr,
  requireInstalledDeclaredPlan,
  resumeQueue,
  runQueues,
  staleDraftWarnings,
  type QueueListOptions,
  type QueueListSnapshot,
  type WatchOptions,
} from "../run.ts"
import { runtimeReloadLineage } from "../runtime-reload.ts"
import { projectQueueRunTaskStatus } from "../task-status.ts"
import { formatYrdRuntimeVersion } from "../version.ts"
import type { QueueWatchFocus } from "../watch-pane.tsx"
import type { YrdCliApp, YrdCliExitCode, YrdCliIO, YrdCliServices } from "../types.ts"
import type { CommandRegistrationContext } from "./context.ts"

/** Register the top-level queue lenses: `log`, `watch`, and `cancel`. */
export function registerQueueLensCommands(ctx: CommandRegistrationContext): void {
  const { program, installed, installedServices, io, setExit } = ctx
  program
    .command("log")
    .description("show queue history, newest first")
    .option("--base <branch>", "scope log to one base branch")
    .option("--pr <pr>", "scope log to one change")
    .option("--failed", "show rejected history only")
    .option("--since <duration>", "show history within a duration")
    .option("-L, --limit <count>", "limit history rows", int, 20)
    .option("--all", "show all rows; include lossless queue and run records in JSON")
    .option("--json", "emit stable JSON")
    .action(async (options) => logRuns(installed(), [], options, io, installedServices()))

  program
    .command("watch [filter...]")
    .description("alias for queue ls --watch")
    .option("--base <branch>", "select one base queue")
    .option("--pr <pr>", "scope watch to one change")
    .option("--status <statuses>", QUEUE_TIMELINE_STATUS_HELP)
    .option("--since <duration>", "timeline window (default: everything; flow metrics default 24h)")
    .option("--latest", "show only the latest Run for each change")
    .option("--json", "emit stable JSON")
    .action(async (filters, options) => {
      setExit(await watchQueue(installed(), filters, options, io, installedServices()))
    })

  program
    .command("cancel <selector>")
    .description(
      "stop the current attempt for a change or run — members re-queue and the change stays open; to stop delivering it, use `yrd mr close --reason <text> --burn-payload` (run both for both effects)",
    )
    .option("--reason <text>", "human-readable cancellation reason")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => setExit(await cancelAttempt(installed(), selector, options, io)))
}

/** Register the `yrd queue` subtree. */
export function registerQueueCommands(ctx: CommandRegistrationContext): void {
  const { program, name, io, installed, installedServices, runtimeApp, setExit, invocation, bootstrap } = ctx
  const queue = program.command("queue").description("manage integration queues")
  queue.helpCommand(false)
  const listQueue = async (positional: string[], options: QueueListOptions): Promise<void> => {
    // A positional term spelled like a subcommand is the one shape this surface
    // cannot read: `queue list list` could be either. `--term` is the reading
    // that has to be asked for; everything else refuses rather than searching.
    refuseShadowedQueueFilterTerms(positional)
    const filters = [...positional, ...(options.term ?? [])]
    if (options.check === true) {
      if (options.watch === true || filters.length > 0) usage("queue list --check does not accept --watch or filters")
      setExit(await checkQueueRunner(runtimeApp(), installedServices(), options, io))
      return
    }
    if (options.watch === true) {
      setExit(await watchQueue(installed(), filters, options, io, installedServices()))
      return
    }
    await listQueues(installed(), filters, options, io, installedServices())
  }
  const TERM_OPTION_HELP = "filter the timeline by a literal word, including one spelled like a subcommand (repeatable)"
  const collectTerm = (value: string, previous: readonly string[]): readonly string[] => [...previous, value]
  queue
    .command("_list [filter...]", { isDefault: true, hidden: true })
    .option("--term <word>", TERM_OPTION_HELP, collectTerm, [] as readonly string[])
    .option("--base <branch>", "select one base queue")
    .option("--pr <pr>", "scope the queue timeline to one change")
    .option("--status <statuses>", QUEUE_TIMELINE_STATUS_HELP)
    .option("--since <duration>", "timeline window (default: everything; flow metrics default 24h)")
    .option("--latest", "show only the latest Run for each change")
    .option("--watch", "keep this projection live and interactive")
    .option("--check", "probe habitant lease, heartbeat, declared-plan freshness, and Git distance")
    .option("--json", "emit stable JSON")
    .action(listQueue)
  queue
    .command("list [filter...]")
    .description("show the queue timeline")
    .option("--term <word>", TERM_OPTION_HELP, collectTerm, [] as readonly string[])
    .option("--base <branch>", "select one base queue")
    .option("--pr <pr>", "scope the queue timeline to one change")
    .option("--status <statuses>", QUEUE_TIMELINE_STATUS_HELP)
    .option("--since <duration>", "timeline window (default: everything; flow metrics default 24h)")
    .option("--latest", "show only the latest Run for each change")
    .option("--watch", "keep this projection live and interactive")
    .option("--check", "probe habitant lease, heartbeat, declared-plan freshness, and Git distance")
    .option("--json", "emit stable JSON")
    .action(listQueue)
  queue
    .command("audit")
    .description("check queue state")
    .option("--json", "emit stable JSON")
    .action(async (options) => setExit(await queueAudit(installed(), installedServices(), options, io)))
  // Retired verb (5e cut 7): stays registered, hidden, so an old runbook gets
  // a loud typed refusal naming the replacements, never a silent timeline
  // filter. Inventory: yrd doctor. Deletion: yrd admin candidate-refs prune.
  queue
    .command("candidate-refs", { hidden: true })
    .description("retired: refuses and names why")
    .option("--prune", "ignored; the verb is retired")
    .option("--retention-days <days>", "ignored; the verb is retired")
    .option("--json", "emit stable JSON")
    .action(() => refuseRetiredQueueCandidateRefs())
  queue
    .command("uncarried")
    .description("find refs pushed to the remote that no change carries")
    .option("--base <branch>", "base branch the refs are judged against")
    .option("--namespace <ref>", "ref namespace to sweep")
    .option("--json", "emit stable JSON")
    .action(async (options) => setExit(await queueUncarried(installed(), options, io)))
  queue
    .command("pause [base]")
    .description("pause new queue runs")
    .option("--reason <text>", "record the pause reason")
    .option("--for <duration>", "required hold TTL, such as 30m, 6h, or 1d")
    .option("--allow [pr...]", "PR ids allowed through the pause")
    .option("--json", "emit stable JSON")
    .action(async (base, options) => pauseQueue(installed(), base, options, io))
  queue
    .command("resume [base]")
    .description("resume a paused queue")
    .option("--json", "emit stable JSON")
    .action(async (base, options) => resumeQueue(installed(), base, options, io))
  // Retired verb (5e cut 6): stays registered, hidden, so an operator
  // following an old runbook gets the reason and the replacements, not a
  // silent timeline filter. Restart re-derives recovery; see
  // refuseRetiredQueueRecover for the one remainder.
  queue
    .command("recover", { hidden: true })
    .description("retired: refuses and names why")
    .option("--reason <text>", "ignored; the verb is retired")
    .option("--runner <id>", "ignored; the verb is retired")
    .option("--json", "emit stable JSON")
    .action(() => refuseRetiredQueueRecover())
  queue
    .command("run [selector...]")
    .description("drain the queue — habitant follow by default; --once or change selectors for a single pass")
    .option("--steps [step...]", "registered step names, comma-separated or repeated")
    .option("--once", "drain the default queue exactly once, then exit")
    .option("--interval <seconds>", "follow-mode poll interval in seconds", int)
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => {
      const mode = invocation.queueRunMode
      if (mode === undefined) throw new Error("yrd: normalized queue run mode is missing")
      // One lineage per process: the count this process was exec'd with, reset
      // by a clean gate pass, carried forward by the next reload request.
      const lineage = bootstrap === undefined ? undefined : runtimeReloadLineage(bootstrap.env)
      const gate = () =>
        requireInstalledDeclaredPlan(
          installedServices(),
          mode === "follow"
            ? {
                reloadInPlace:
                  bootstrap === undefined || lineage === undefined ? {} : { request: requestYrdRuntimeReload, lineage },
              }
            : {},
        )
      if (mode === "follow") {
        setExit(await followQueueRuns(installed(), selectors, options, io, gate, installedServices()))
        return
      }
      await gate()
      const app = installed()
      const publications = await preparePublicationQueueCycle(app, installedServices(), io)
      if (publications.length > 0) await gate()
      const runs = await runQueues(app, selectors, options, io)
      const selectedChangeIds =
        selectors.length === 0 ? undefined : new Set(selectors.map((selector) => requiredPr(app, selector).id))
      const blocked = admissionBlockedChanges(app, selectedChangeIds)
      const blockerText = blocked.map(({ eligibility }) => eligibility.reason?.message).join("\n")
      const human =
        blocked.length === 0
          ? createElement(QueueRunsView, { runs })
          : runs.length === 0
            ? blockerText
            : createElement(Fragment, null, createElement(QueueRunsView, { runs }), "\n", blockerText)
      await printResult(
        io,
        jsonEnabled(options),
        {
          command: "queue.run",
          publications: publications.map((job) => ({ ...job, projection: projectPublication(job) })),
          results: runs.map(projectQueueRunTaskStatus),
          ...(blocked.length === 0
            ? {}
            : {
                blocked: blocked.map(({ pr, eligibility }) => ({
                  pr: projectChangeTaskStatusWithEligibility(pr, eligibility),
                  eligibility: projectEligibilityTaskStatus(eligibility),
                })),
              }),
        },
        human,
      )
      const publicationFailed = publications.some((job) => job.status !== "completed" || job.conclusion !== "success")
      setExit(publicationFailed || runs.some(Queues.failed) ? 1 : 0)
    })
  queue
    .command("cancel <run>")
    .description("cancel a running or waiting queue run and leave its PRs submitted")
    .option("--reason <text>", "record the cancellation reason")
    .option("--json", "emit stable JSON")
    .action(async (run, options) => setExit(await cancelQueueRun(installed(), run, options, io)))
  queue
    .command("finish <selector>")
    .description("resume a waiting step")
    .option("--step <name>", "waiting step name")
    .option("--ok", "record a passing result")
    .option("--fail", "record a failing result")
    .option("--job <id>", "waiting-job id")
    .option("--runner <runner>", "waiting-job runner identity")
    .option("--attempt <attempt>", "waiting-job attempt number")
    .option("--token <token>", "waiting-job props token")
    .option("--detail <text>", "human-readable result detail")
    .option("--url <url>", "external runner URL")
    .option("--artifact [artifact...]", "artifact name=path-or-url")
    .option("--exit-code <code>", "external process exit code", int)
    .option("--duration-ms <milliseconds>", "external duration", int)
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => finishQueue(installed(), selector, options, io))
  addQueueExamples(queue, name)
}

async function watchQueue(
  app: YrdCliApp,
  filters: readonly string[],
  options: WatchOptions,
  io: YrdCliIO,
  services: YrdCliServices,
): Promise<YrdCliExitCode> {
  const interval = 15_000
  const scope = io.scope ?? app.scope
  const query = createQueueListSnapshotLoader(app, filters, options, io, services, !jsonEnabled(options))
  const load = (focus?: QueueWatchFocus): Promise<QueueListSnapshot> => query.load(focus)

  if (!jsonEnabled(options)) {
    io.stderr(`yrd watch runtime: ${formatYrdRuntimeVersion()}\n`)
    const renderLive = getLiveRenderer(io)
    if (renderLive === undefined) {
      refusal("watch requires an interactive terminal; use --json for streaming output")
    }
    const initial = await load()
    const { QueueWatchPane } = await import("../watch-pane.tsx")
    await renderLive(
      createElement(QueueWatchPane, {
        initial,
        load,
        intervalMs: interval,
        ...(options.pr === undefined ? {} : { pr: options.pr }),
        // The watch `x`+confirm affordance shares the CLI's cancel path exactly:
        // cancel journals a run cancellation whose PRs re-queue (not reject), and
        // the pane's poll loop reflects it on the next cycle.
        onCancelRun: async (run: string) => {
          await app.queue.cancelRun({ run, by: io.runner ?? "operator", reason: "run canceled from watch" })
        },
      }),
      {
        signal: scope.signal,
      },
    )
    return 0
  }

  while (true) {
    const snapshot = await load()
    await printResultWithWarnings(
      io,
      true,
      {
        command: "queue.list",
        projection: snapshot.projection,
        results: snapshot.results.map(projectQueueStatusResultTaskStatus),
        ...(snapshot.readFailure === undefined ? {} : { readFailure: snapshot.readFailure }),
      },
      createElement(QueueTimelineView, {
        repositoryRoot: snapshot.repositoryRoot,
        projection: snapshot.projection,
        runnerRefusal: snapshot.runnerRefusal,
        results: snapshot.results,
        state: snapshot.state,
        columns: io.columns ?? 120,
      }),
      [
        ...queuePauseWarnings(snapshot.state, snapshot.results),
        ...staleDraftWarnings(snapshot.staleDrafts ?? []),
        ...needsPersonWarnings(snapshot.needsPerson ?? []),
        ...(snapshot.readFailure === undefined ? [] : [queueReadFailureMessage(snapshot.readFailure, true)]),
      ],
    )
    if (scope.signal.aborted) return 0
    await scope.sleep(interval)
    if (scope.signal.aborted) return 0
  }
}

function addQueueExamples(queue: CliCommand, name: string): void {
  const repository = `${name} --repo <repository>`
  queue.addHelpSection("Examples:", [
    [`$ ${name} queue`, "list active queues"],
    [`$ ${repository} queue run PR7 --steps check,merge`, "run selected steps for one change"],
    [`$ ${name} log --base release/2.0`, "show completed work for a base"],
    [`$ ${name} pr runs PR7`, "show step-level run evidence and proofs"],
    [`$ ${repository} queue pause --reason maintenance --for 30m --allow PR7`, "pause all but selected PRs"],
    [`$ ${repository} queue run`, "habitant follow-runner: keep the default queue moving"],
  ])
}
