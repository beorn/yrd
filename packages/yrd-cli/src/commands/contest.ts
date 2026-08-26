import { createElement } from "react"
import { CompetitorDefSchema, type CompetitorDef, type Contest } from "@yrd/contest"
import { refusal, usage } from "../invocation.ts"
import { printResult } from "../output.tsx"
import { ContestStatusView } from "../status-view.tsx"
import { artifacts, csv, jsonEnabled, oneOfAliases, runtimeOptions, type JsonOption } from "../run.ts"
import type { YrdCliApp, YrdCliExitCode, YrdCliIO } from "../types.ts"
import type { CommandRegistrationContext } from "./context.ts"

/** Register the `yrd contest` subtree. */
export function registerContestCommands(ctx: CommandRegistrationContext): void {
  const { program, installed, io, setExit } = ctx
  const contest = program.command("contest").description("inspect and select contest attempts")
  contest.helpCommand(false)
  contest
    .command("_list", { isDefault: true, hidden: true })
    .option("--json", "emit stable JSON")
    .action(async (options) => listContests(installed(), options, io))
  contest
    .command("open <issue>")
    .description("compare implementations of one real issue")
    .option("--competitors <json>", "opaque competitor id, runner port, and config entries")
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
    .option("--token <token>", "waiting-job props token")
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
    .option("--by <identity>", "selector identity")
    .option("--reason <text>", "selection rationale")
    .option("--json", "emit stable JSON")
    .action(async (contestId, options) => selectContest(installed(), contestId, options, io))
  contest
    .command("promote <contest>")
    .description("submit the selected submodule commit")
    .option("--json", "emit stable JSON")
    .action(async (contestId, options) => setExit(await promoteContest(installed(), contestId, options, io)))
}

function competitors(input: string): readonly CompetitorDef[] {
  let value: unknown
  try {
    value = JSON.parse(input)
  } catch {
    usage("--competitors must be JSON")
  }
  const parsed = CompetitorDefSchema.array().min(2).safeParse(value)
  if (!parsed.success) {
    usage("--competitors must be a JSON array with at least two {id,runner,config} entries")
  }
  return parsed.data
}

async function advanceContest(app: YrdCliApp, contest: string, io: YrdCliIO, retry = false): Promise<Contest> {
  const concurrency = io.concurrency ?? 8
  if (!Number.isInteger(concurrency) || concurrency < 1) usage("contest concurrency must be a positive integer")
  return app.contests.evaluate(contest, { ...runtimeOptions(io), concurrency, retry })
}

async function openContest(
  app: YrdCliApp,
  issueInput: string,
  options: { competitors?: string; evaluators?: unknown; base?: string; queue?: string; json?: boolean },
  io: YrdCliIO,
): Promise<YrdCliExitCode> {
  if (options.competitors === undefined) usage("contest open requires --competitors <json>")
  const issue = await app.issues.resolve(app.issues.ref(issueInput))
  const requestedBase = oneOfAliases(options.base, options.queue, "base", "queue")
  const base = await app.contests.resolveBase(requestedBase)
  const opened = await app.contests.compete({
    issue,
    competitors: competitors(options.competitors),
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
            status: "completed",
            conclusion: "success",
            output: {
              verdict: options.ok === true ? "passed" : "failed",
              ...(options.detail === undefined ? {} : { summary: options.detail }),
              artifacts: recordedArtifacts,
            },
          }
        : {
            status: "completed",
            conclusion: "failure",
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
