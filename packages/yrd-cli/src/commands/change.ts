import type { Command as CliCommand } from "@silvery/commander"
import { changeDeliveryState, currentChangeRev, type Change } from "@yrd/bay"
import { latestRunForCurrentRevision, projectedChangeStatus, type Run } from "@yrd/queue"
import { refusal, stableJson } from "../invocation.ts"
import { withdrawPrs } from "../pr-withdraw.ts"
import {
  applyChangeSelectionVerb,
  CHANGE_LIST_RECORD_STATE_HELP,
  CHANGE_LIST_STATE_HELP,
  changeChecks,
  checkoutPr,
  commentPr,
  diffPr,
  editPr,
  jsonEnabled,
  listPrs,
  NO_TRACK_OPTION_DESCRIPTION,
  publishPr,
  queuedChangePosition,
  readyPr,
  requestReviewPr,
  reviewPr,
  statusPr,
  TRACK_OPTION_DESCRIPTION,
  viewChangeRuns,
  viewPr,
  type JsonOption,
} from "../run.ts"
import type { YrdCliApp, YrdCliExitCode, YrdCliIO } from "../types.ts"
import type { CommandRegistrationContext } from "./context.ts"

/** Register the `yrd change` subtree (`mr` and `pr` stay taught aliases). */
export function registerChangeCommands(ctx: CommandRegistrationContext): void {
  const { program, name, installed, installedServices, io, setExit } = ctx
  // `change` is the printed name (operator ruling 2026-08-18, superseding
  // I23's `mr`-primary call); `mr` and `pr` are permanent taught aliases --
  // ids keep printing as PRnnn (a pure label) and both spellings keep
  // working forever.
  const pr = program
    .command("change")
    .alias("mr")
    .alias("pr")
    .description(
      "manage changes (a branch selector targets the live delivery; address a terminal change by its id, printed as PRnnn; mr/pr accepted)",
    )
  pr.helpCommand(false)
  const list = pr
    .command("list")
    .description("list changes")
    .option("--base <branch>", "scope changes to one base")
    .option(
      "--state <state>",
      `scope changes to one record state (${CHANGE_LIST_RECORD_STATE_HELP}) ` +
        `or one native or projected delivery status (${CHANGE_LIST_STATE_HELP})`,
    )
    .option("--issue <ref>", "scope changes to one issue reference")
    .option("--needs-review", "show revisions needing approval")
    .option("--reviewer <reviewer>", "scope --needs-review to one requested reviewer")
    .option("--json", "emit stable JSON")
    .action(async (options) => listPrs(installed(), options, io))
  list.addHelpSection(
    "Status fields:",
    [
      "state — answers: is the change record open or closed? tense: current",
      "status — answers: what delivery result should a reader act on? tense: current",
      "nativeStatus — answers: what delivery status did the rebuildable index record? tense: historical",
      "taskStatus — answers: how does this delivery map to the shared work-state vocabulary? tense: current",
      "eligibility.reason.code — answers: why can the current revision not run now? tense: current",
      "mergedOnBase.code — answers: why did repository proof override nativeStatus? tense: current",
      "--state needs-author — answers: does this change currently need author action? tense: current",
    ].join("\n"),
  )
  const create = pr
    .command("create [selector]")
    .description("create a draft change without requesting required checks")
    .option("--base <branch>", "base branch for a direct branch create")
    .option("--queue <branch>", "alias for --base")
    .option("--issue <ref>", "link a tracker-neutral issue reference")
    .option("--title <text>", "PR subject (defaults to the head commit subject)")
    .option("--description <text>", "PR description body (defaults to the head commit body)")
    .option(
      "--prop <key>=<value>",
      "set a prop on the draft revision — an opaque key=value label (repeatable)",
      (value: string, previous: readonly string[]) => [...previous, value],
      [] as readonly string[],
    )
    .option("--composition <path>", "queue-generated source composition JSON; not for authored root branches")
    .option(
      "--reviewer <reviewer>",
      "request a review from <reviewer> right after create (repeatable)",
      (value: string, previous: readonly string[]) => [...previous, value],
      [] as readonly string[],
    )
    .option("--track", TRACK_OPTION_DESCRIPTION)
    .option("--no-track", NO_TRACK_OPTION_DESCRIPTION)
    .option("--json", "emit stable JSON")
    .action(async (selector, options) =>
      setExit(
        await applyChangeSelectionVerb(
          installed(),
          installedServices(),
          selector === undefined ? [] : [selector],
          options,
          io,
          "pr.create",
        ),
      ),
    )
  addAuthoredCarrierWorkflow(create, name)
  pr.command("submit [selector...]")
    .description("submit change revisions after the managed local required-check hook")
    .option("--base <branch>", "base branch for a direct branch submit")
    .option("--queue <branch>", "alias for --base")
    .option("--issue <ref>", "link a tracker-neutral issue reference")
    .option("--title <text>", "PR subject (defaults to the head commit subject)")
    .option("--description <text>", "PR description body (defaults to the head commit body)")
    .option(
      "--prop <key>=<value>",
      "set a prop on the submitted revision — an opaque key=value label (repeatable)",
      (value: string, previous: readonly string[]) => [...previous, value],
      [] as readonly string[],
    )
    .option("--composition <path>", "queue-generated source composition JSON; not for authored root branches")
    .option(
      "--reviewer <reviewer>",
      "request a review from <reviewer> right after submit (repeatable)",
      (value: string, previous: readonly string[]) => [...previous, value],
      [] as readonly string[],
    )
    .option("--track", TRACK_OPTION_DESCRIPTION)
    .option("--no-track", NO_TRACK_OPTION_DESCRIPTION)
    .option("--keep-on-failure", "retain a failed client-side required-check workspace for inspection")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) =>
      setExit(await applyChangeSelectionVerb(installed(), installedServices(), selectors, options, io, "pr.submit")),
    )
  pr.command("view <selector>")
    .description("show a change and its runs")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => viewPr(installed(), selector, options, io, installedServices()))
  pr.command("runs <selector>")
    .description("show run, step, attempt, proof, and artifact detail")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => viewChangeRuns(installed(), selector, options, io, installedServices()))
  pr.command("diff <selector>")
    .description("show the candidate diff")
    .option("--stat", "show diff statistics")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => diffPr(installed(), selector, options, io))
  pr.command("checkout <selector>")
    .description("materialize a bay from a change revision head (detached HEAD)")
    .option("--bay <name>", "name the new bay")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => checkoutPr(installed(), selector, options, io))
  pr.command("status")
    .description("show the current bay or branch change")
    .option("--json", "emit stable JSON")
    .action(async (options) => statusPr(installed(), options, io, installedServices()))
  pr.command("edit <selector>")
    .description("edit the issue link, note, title, description, or branch tracking")
    .option("--issue <ref>", "set the tracker-neutral issue reference")
    .option("--note <text>", "set the delivery note")
    .option("--title <text>", "set the change subject")
    .option("--description <text>", "set the change description body")
    .option("--track", TRACK_OPTION_DESCRIPTION)
    .option("--untrack", "stop tracking: a stale head again blocks the re-merge")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => editPr(installed(), selector, options, io))
  // Hidden with recut: the draft story is `create` = draft, `submit` = ready.
  pr.command("publish <selector>", { hidden: true })
    .description("request credential-bearing publication of one immutable change revision")
    .option("--queue", "re-merge and queue the revision after publishing succeeds")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => publishPr(installed(), installedServices(), selector, options, io))
  pr.command("ready <selector>", { hidden: true })
    .description("submit a pushed change revision and request configured checks")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) =>
      setExit(await readyPr(installed(), installedServices(), selector, options, io)),
    )
  pr.command("review <selector>")
    .description("record a revision-bound review verdict")
    .option("--approve", "approve the current revision")
    .option("--reject", "reject the current revision")
    .option("--by <identity>", "reviewer identity")
    .option("--ref <id>", "idempotency reference")
    .option("--note <text>", "review note")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => reviewPr(installed(), selector, options, io))
  pr.command("request-review <selector> [reviewers...]")
    .description("replace the requested reviewers for a change (declarative set)")
    .option("--clear", "clear the requested reviewer set")
    .option("--by <identity>", "requesting identity")
    .option("--json", "emit stable JSON")
    .action(async (selector, reviewers, options) => requestReviewPr(installed(), selector, reviewers, options, io))
  pr.command("comment <selector>")
    .description("record a non-gating revision comment")
    .option("--by <identity>", "commenter identity")
    .option("--ref <id>", "idempotency reference")
    .requiredOption("--note <text>", "comment text")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => commentPr(installed(), selector, options, io))
  pr.command("checks <selector...>")
    .description("show required-check evidence for current change revisions")
    .option("--follow", "follow active checks to a terminal result")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => setExit(await changeChecks(installed(), selectors, options, io)))
  pr.command("close [selector...]")
    .description("close a live change without merging — records why, leaves the queue")
    .option("--reason <text>", "close rationale recorded on each pr/withdrawn event")
    .option("--burn-payload", "acknowledge that closing spends the payload identity permanently")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => withdrawPrs(installed(), selectors, options, io, "pr.close"))
  // Hidden ruled alias of `close` — one act, two spellings (I23); the envelope
  // keeps its stable pr.withdraw name for journal consumers.
  pr.command("withdraw <selector...>", { hidden: true })
    .description("withdraw live changes from delivery, recording the reason")
    .option("--reason <text>", "withdrawal rationale recorded on each pr/withdrawn event")
    .option("--burn-payload", "acknowledge that withdrawing spends the payload identity permanently")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => withdrawPrs(installed(), selectors, options, io))
  pr.command("merge <selector>")
    .description("teach that the queue is the only merger")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => setExit(await refuseChangeMerge(installed(), selector, options, io)))
}

function addAuthoredCarrierWorkflow<
  Options extends Record<string, unknown>,
  Arguments extends unknown[],
  ArgumentRecord extends Record<string, unknown>,
>(command: CliCommand<Options, Arguments, ArgumentRecord>, name: string): void {
  command.addHelpSection("Authored root branch:", [
    [`$ ${name} pr create <branch>`, "record the authored root branch as a draft change"],
    [
      `$ ${name} pr submit <branch>`,
      "tracked changes re-merge implicitly when the branch moves; this is the explicit fallback spelling",
    ],
  ])
}

async function refuseChangeMerge(
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

  const position = await queuedChangePosition(app, pr, io)
  const detail = changeMergeRefusalDetail(pr, position, latestRunForCurrentRevision(pr, app.queue.status(pr.base)))
  const message = `the queue is the only merger; ${detail.message}`
  const guidance = {
    command: "pr.merge",
    pr: pr.id,
    status: changeDeliveryState(pr),
    ...(detail.run === undefined ? {} : { run: detail.run, outcome: detail.outcome }),
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

function changeMergeRefusalDetail(
  pr: Change,
  position: number | undefined,
  latestRun: Run | undefined,
): Readonly<{
  next: string
  guidance: Readonly<Record<string, string>>
  message: string
  run?: string
  outcome?: "rejected"
}> {
  const delivery = changeDeliveryState(pr)
  const projectedStatus = projectedChangeStatus(pr)
  if (latestRun?.status === "completed" && latestRun.conclusion === "failure") {
    const inspect = `yrd pr runs ${pr.id}`
    const resubmit = "fix the branch and run yrd pr submit again"
    return {
      next: inspect,
      guidance: { inspect, resubmit },
      message: `change '${pr.id}' latest Run '${latestRun.id}' was rejected; see: ${inspect}; then ${resubmit}`,
      run: latestRun.id,
      outcome: "rejected",
    }
  }
  if (currentChangeRev(pr).admission?.status === "refused") {
    const inspect = `yrd pr checks ${pr.id}`
    const resubmit = "fix the branch and run yrd pr submit again"
    return {
      next: inspect,
      guidance: { inspect, resubmit },
      message: `change '${pr.id}' current revision failed required checks; see: ${inspect}; then ${resubmit}`,
    }
  }
  if (delivery === "submitted" || delivery === "ready") {
    const watch = `yrd watch --pr ${pr.id}`
    return {
      next: watch,
      guidance: { watch },
      message: `change '${pr.id}' is queued${position === undefined ? "" : ` at position ${position}`}; watch: ${watch}`,
    }
  }
  if (delivery === "rejected") {
    const inspect = `yrd pr runs ${pr.id}`
    const fixPush = "fix the branch and push; the same PR resumes automatically"
    return {
      next: inspect,
      guidance: { inspect, fixPush },
      message: `change '${pr.id}' ${projectedStatus === "needs-author" ? "needs author changes" : "was rejected"}; see: ${inspect}; then ${fixPush}`,
    }
  }
  if (delivery === "pushed") {
    const submit = `yrd pr submit ${pr.branch}`
    return { next: submit, guidance: { submit }, message: `change '${pr.id}' is not queued; submit it: ${submit}` }
  }
  const view = `yrd pr view ${pr.id}`
  return { next: view, guidance: { view }, message: `change '${pr.id}' is ${delivery}; see: ${view}` }
}
