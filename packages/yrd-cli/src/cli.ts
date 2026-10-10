/**
 * The whole command surface ([plan](../../../../pm/@i/10-yrd/plan.md)
 * § The final design, Commands).
 *
 * The command surface is
 * `yrd queue submit|withdraw|run|up|stop|start|pause|resume|list|stats|show|health`,
 * `yrd drop`, `yrd merge`, `yrd check`, `yrd env open|list|close`, `yrd logs prune`, with `yrd submit` and
 * `yrd list` as the aliases of the two used most, `yrd watch` as
 * `queue list --watch`, and `yrd bay` as `env`'s until flag day's word is
 * retired. Every
 * queue command is `@yrd/queue-core` through `coreQueueCommand`; nothing here
 * holds queue state, and nothing here parses `.yrd.yml` past the one line
 * that selects the core.
 *
 * What this file replaced is the point of M6: a 15,770-line `run.ts` and a
 * 5,472-line `host.ts` that built an app out of `@yrd/queue`,
 * `@yrd/persistence`, `@yrd/contest` and `@yrd/job` before any command could
 * run, and registered `pr`, `queue audit|status`, `log`, `why`, the receiver,
 * the garage ledger, the journal and checkpoint administration beside them.
 * All of it is deleted, not hidden.
 *
 * NO OPTION IS ACCEPTED AND IGNORED. An option one of these commands does not
 * implement — `--dry-run` on a command that has no dry run, `--repo`, a
 * repository operand — refuses with exit 2 and names it. That rule is why
 * `--dry-run` exists on `submit` at all: the old wrapper took the flag from
 * its own surface, the new core's submit never saw it, and a dry run opened a
 * real change: one submit opened two changes, 2026-09-03.
 */

import { Command as CliCommand, CommanderError, int } from "@silvery/commander"
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { drainOutput } from "loggily"
import {
  activateRunIndex,
  createEventStore,
  isQueueEventShapeUnreadable,
  lookupRunIndex,
  openLog,
  parseDuration,
  readRunLog,
  runIndexPath,
  runIndexRef,
  RUN_INDEX_CODES,
  yrdQueueRunnerDeclarations,
} from "@yrd/queue-core"
import type { CoreQueueCommand } from "./queue-core-commands.ts"
import { closeEnvironment, listEnvironments, openEnvironment } from "./env-commands.ts"
import { refreshMirrors, MIRROR_STORE_SETTING, type MirrorRefreshOptions } from "./mirror-commands.ts"
import { createYrdLogger, resolveYrdObservability, type YrdObservabilityFlags } from "./observability.ts"
import { repositoryHere } from "./declaration.ts"
import {
  ROUND_OUTPUT_WINDOW_MS,
  ROUND_REMOVAL_BATCH,
  expiredRoundOutput,
  removeExpiredRoundOutput,
  retentionHumanLines,
  retentionObservation,
  type ExpiredRoundOutput,
} from "./log-retention.ts"
import { resolveDeclaredQueueLocations, resolveQueueLocation, type QueueLocation } from "./queue-location.ts"
import { formatQueueAddress, parseQueueAddress, parseRunAddress } from "./address.ts"
import { formatYrdRuntimeVersion, YRD_VERSION } from "./version.ts"
import { legendLines } from "./watch-words.ts"
import type { YrdCliExitCode, YrdCliIO } from "./types.ts"

/** The seat a submit names. Never the git author: the fleet's git identity
 * names nobody (ruling @i/10-yrd/24028). */
const DEFAULT_SUBMITTER_ENV = "YRD_DEFAULT_SUBMITTER"

type GlobalOptions = YrdObservabilityFlags

type SubmitOptions = Readonly<{
  json?: boolean
  submitter?: string
  notify?: string
  issue?: string
  dryRun?: boolean
  prepare?: boolean
  queue?: string
  gitlink?: string[]
}>
type PauseOptions = Readonly<{
  json?: boolean
  notify?: string
  submitter?: string
  queue?: string
  reason?: string
  maintenance?: string
}>
type MergeOptions = Readonly<{
  json?: boolean
  submitter?: string
  notify?: string
  issue?: string
  queue?: string
  noCheck?: boolean
  check?: boolean
}>

// Only queue actions load the runtime identity fence. Help and --version must
// not perform its Git reads (version owns its own bounded source diagnostic).
const coreQueueCommand: typeof import("./queue-core-commands.ts").coreQueueCommand = async (...args) => {
  const queue = await import("./queue-core-commands.ts")
  return queue.coreQueueCommand(...args)
}

// The declared health probe loads the same way, and for a sharper reason: it
// runs on the supervisor's tick, so it must not pay for the queue core it does
// not use. It reads one file.
const queueHealthCommand = async (workdir: string, io: YrdCliIO): Promise<YrdCliExitCode> => {
  const health = await import("./queue-health.ts")
  return health.queueHealthCommand(workdir, health.SERVICE, io)
}

const NOTIFY_HELP = "deprecated alias for --submitter; both flags must name the same submitter"
const SUBMITTER_HELP = `the submitter and result recipient; else ${DEFAULT_SUBMITTER_ENV}, else unknown`
// 27262: on withdraw/drop the actor and the coordination recipient are two
// fields. `--submitter` sets only `By:`; `--notify` sets `Recipient:` and sends
// no notice, so this help must not reuse the "result recipient" wording.
const WITHDRAW_SUBMITTER_HELP = `the actor who ends the change, recorded as By:; else ${DEFAULT_SUBMITTER_ENV}, else unknown`
const ISSUE_HELP =
  "the issue, checked against the branch's first Refs/Resolves binding; unbound legacy name fallback is reported"
const DRY_RUN_HELP = "preview admission and push nothing; fetches the queue tip into refs/gitomic/fetched/"
const QUEUE_HELP = "a branch at origin or <repo>#<branch> address; defaults to origin/HEAD inside a clone"

const SUBMIT_HELP: [string, string][] = [
  [
    "Preparation",
    "run --prepare before lock sync to retain moved child commits; then commit regenerated locks and submit normally. Refuses --dry-run and --gitlink combinations.",
  ],
  ["Result", "one recipient: --submitter; another seat can read yrd queue show <branch> after submission"],
  [
    "Pin-only",
    "repeat --gitlink <path>=<full-sha> with --issue <id> to build an exact-target-parent carrier in the queue-owned clone; a remote-unheld pin or branch operand refuses",
  ],
  [
    "1. Inspect",
    "read this branch and fetch the configured target's advertised commit objects without pulling or integrating; refuse the target branch; a stopped line still accepts the change, and says who stopped it and what lifts it",
  ],
  ["2. Validate", "require shared history, then verify the submitted commit against the current target"],
  [
    "3. Compose",
    "git-super merges the submitted commit onto the observed target and settles gitlinks; conflicts stop before a change opens",
  ],
  [
    "4. Publish",
    "keep the submitted commit unchanged; atomically push that commit as the branch head and its opened record with leases against observed remote refs",
  ],
  ["5. Return", "the change is queued; checks and the merge run later, and the queue revalidates at merge"],
]

const MERGE_HELP: [string, string][] = [
  [
    "1. Find the change",
    "the change of this checkout's branch head, or, with no such local branch, the branch's change in line; one already merged exits 0 and nothing runs",
  ],
  [
    "2. Submit unless open",
    "a change not in line is submitted from this checkout exactly as submit does; a change already queued, checked or stuck is not resubmitted, so a checked verdict is kept",
  ],
  [
    "3. Wait for the round lock",
    "one round at a time in the queue's workdir: a round already running, the service's or anyone's, finishes first, and the wait names it",
  ],
  [
    "4. Run this change's round",
    "its checks and its merge, now, ahead of the line and on a stopped line too; a stuck change ahead of it does not hold it back",
  ],
  [
    "5. Judge the stuck change again",
    "when this change merged while a stuck change stopped the line, that stuck head is judged once more on the new target, and the stop lifts if it passes",
  ],
  [
    "6. Exit with this change's state",
    "0 merged, 1 failed or withdrawn, 2 stuck or still in line; a change left in line is named with why and the command to run again, and a stop that still stands is named with the command that merges what it waits on",
  ],
]

export function resolveSubmitter(declared: string | undefined, env: NodeJS.ProcessEnv): string {
  const named = declared?.trim()
  if (named !== undefined && named !== "") return named
  const launched = env[DEFAULT_SUBMITTER_ENV]?.trim()
  return launched === undefined || launched === "" ? "unknown" : launched
}

function submitterOption(
  options: Pick<SubmitOptions, "submitter" | "notify">,
  env: NodeJS.ProcessEnv,
  io: YrdCliIO,
): string {
  if (options.notify !== undefined) {
    io.stderr("yrd: `--notify` is now `--submitter`\n")
    if (options.submitter !== undefined && options.submitter !== options.notify) {
      throw new Error("--submitter and --notify name different submitters; use one value")
    }
  }
  return resolveSubmitter(options.submitter ?? options.notify, env)
}

function buildProgram(
  name: string,
  io: YrdCliIO,
  env: NodeJS.ProcessEnv,
  setExit: (code: YrdCliExitCode) => void,
  log: () => ReturnType<typeof createYrdLogger> | undefined,
): CliCommand {
  const cwd = (): string => io.cwd ?? process.cwd()
  const program = new CliCommand(name)
    .description("yrd (shipyard) — agentic software delivery")
    .showSuggestionAfterError()
    // Set before any subcommand exists: a subcommand copies the output
    // configuration at its creation, so one set afterwards leaves `yrd queue
    // list --help` writing past `io` to the process's own stdout.
    .configureOutput({
      writeErr: (text) => io.stderr(text),
      writeOut: (text) => io.stdout(text),
    })
  program.helpCommand(false)
  program.exitOverride()
  program.version(YRD_VERSION, "-V, --version")
  program
    .option("--log-level <level>", "silent, error, warn, info, debug or trace")
    .option("-v, --verbose", "raise the log level; repeat for more", (_value, previous: number) => previous + 1, 0)
    .option("-q, --quiet", "lower the log level; repeat for less", (_value, previous: number) => previous + 1, 0)

  const WITHDRAW_DESCRIPTION =
    "end the branch's open change and take it out of the line; the branch itself is untouched"
  const WITHDRAW_HELP =
    "Appends a withdrawn record to the change - an ending like merged or failed - so the queue drops the " +
    "change from the line and never judges it again; resubmitting the branch re-opens it. Withdrawing the " +
    "change a stuck stop names lifts that stop, and the line behind it runs again. The other way out of the " +
    "line is the submitter's: replace the branch with a head that clears the stuck reason - resubmitting " +
    "the same content sticks on the same ground."
  const withdrawOptions = <T extends { option: (flags: string, description: string) => T }>(command: T): T =>
    command
      .option("--json", "emit stable JSON")
      .option("--submitter <agent>", WITHDRAW_SUBMITTER_HELP)
      .option("--notify <seat>", "the coordination seat recorded as Recipient:; no notice is sent (27262)")
      .option("--queue <value>", QUEUE_HELP)
      .option("--reason <text>", "why the change leaves the line, written on the record")
  const queueEnd = async (branch: string, options: PauseOptions, command: "withdraw" | "drop"): Promise<void> => {
    const location = await resolveQueueLocation(cwd(), options.queue, env)
    setExit(
      await coreQueueCommand(
        location.repo,
        io,
        {
          branch,
          by: resolveSubmitter(options.submitter, env),
          ...(options.notify === undefined ? {} : { recipient: options.notify }),
          command,
          ...(options.reason === undefined ? {} : { reason: options.reason }),
        },
        {
          json: options.json,
          env,
          log: log(),
          selection: location.selection,
          populateReference: location.owned,
          queue: location.queue,
          workdir: location.workdir,
        },
      ),
    )
  }

  type SweepCandidatesOptions = Readonly<{
    json?: boolean
    dryRun?: boolean
    remote?: string
    batchSize?: number
    queue?: string
  }>
  const SWEEP_CANDIDATES_DESCRIPTION =
    "sweep stranded candidate refs (refs/heads/yrd/candidates/* and refs/yrd/candidates/*) using leased push deletes"
  const sweepCandidatesOptions = (command: CliCommand): CliCommand =>
    command
      .option("--dry-run", "list candidate refs without deleting")
      .option("--remote <name>", "git remote to sweep (defaults to target remote)")
      .option("--batch-size <count>", "number of refs to delete in each leased push batch (default: 50)", int)
      .option("--queue <value>", QUEUE_HELP)
      .option("--json", "emit stable JSON")

  const queueSweepCandidates = async (options: SweepCandidatesOptions): Promise<void> => {
    const location = await resolveQueueLocation(cwd(), options.queue, env)
    setExit(
      await coreQueueCommand(
        location.repo,
        io,
        {
          command: "sweep-candidates",
          dryRun: options.dryRun,
          remote: options.remote,
          batchSize: options.batchSize,
        },
        {
          json: options.json,
          env,
          log: log(),
          selection: location.selection,
          populateReference: location.owned,
          queue: location.queue,
          workdir: location.workdir,
        },
      ),
    )
  }

  const queueIgnore = async (branch: string, options: PauseOptions, ignored: boolean): Promise<void> => {
    let action: Parameters<typeof coreQueueCommand>[2]
    if (ignored) {
      const reason = options.reason
      if (reason === undefined || reason.trim() === "") {
        io.stderr(`yrd-ignore-reason-required: ${branch}: ignoring an open change requires --reason <text>\n`)
        setExit(2)
        return
      }
      action = { command: "ignore", branch, by: resolveSubmitter(options.notify, env), reason }
    } else {
      if (options.reason !== undefined) {
        io.stderr(`yrd-ignore-reason-conflict: ${branch}: unignore does not accept --reason\n`)
        setExit(2)
        return
      }
      action = { command: "unignore", branch, by: resolveSubmitter(options.notify, env) }
    }
    const location = await resolveQueueLocation(cwd(), options.queue, env)
    setExit(
      await coreQueueCommand(location.repo, io, action, {
        json: options.json,
        env,
        log: log(),
        selection: location.selection,
        populateReference: location.owned,
        queue: location.queue,
        workdir: location.workdir,
      }),
    )
  }

  const queueSubmit = async (branch: string | undefined, options: SubmitOptions): Promise<void> => {
    if (options.prepare === true && options.dryRun === true) {
      throw new Error("--prepare writes permanent child refs and cannot be combined with --dry-run")
    }
    if (options.prepare === true && (options.gitlink?.length ?? 0) > 0) {
      throw new Error("--prepare cannot be combined with --gitlink; prepare an existing authored branch")
    }
    const pins = (options.gitlink ?? []).map((value) => {
      const separator = value.indexOf("=")
      if (separator <= 0 || separator === value.length - 1) {
        throw new Error(`--gitlink needs <path>=<full-sha>, got ${value}`)
      }
      return { path: value.slice(0, separator), sha: value.slice(separator + 1) }
    })
    if (pins.length > 0 && branch !== undefined) {
      throw new Error("--gitlink builds its own carrier branch; omit the branch operand")
    }
    if (pins.length > 0 && options.issue === undefined) {
      throw new Error("--gitlink needs --issue <id> for the carrier's Refs binding")
    }
    const location = await resolveQueueLocation(cwd(), options.queue, env, pins.length > 0 ? "queue" : "submit")
    const taken = await coreQueueCommand(
      location.repo,
      io,
      {
        command: "submit",
        submitter: submitterOption(options, env, io),
        ...(branch === undefined ? {} : { branch }),
        ...(options.issue === undefined ? {} : { issue: options.issue }),
        ...(options.dryRun === true ? { dryRun: true } : {}),
        ...(options.prepare === true ? { prepare: true } : {}),
        ...(pins.length === 0 ? {} : { pins }),
      },
      {
        json: options.json,
        env,
        log: log(),
        selection: location.selection,
        populateReference: location.owned,
        queue: location.queue,
        workdir: location.workdir,
        remote: location.remote,
      },
    )
    setExit(taken)
  }
  const queue = program.command("queue").description("the line of changes for the target branch")
  queue.helpCommand(false)
  const runs = program.command("runs").description("lookup or activate durable numbers within one queue")
  runs.helpCommand(false)
  runs
    .command("show <run-address>")
    .description("read a published run by full repository@branch#number address")
    .option("--json", "emit stable JSON")
    .action(async (operand: string, options: { json?: boolean }) => {
      const address = parseRunAddress(operand)
      const location = await resolveQueueLocation(cwd(), formatQueueAddress(address.queue), env)
      const lookup = await lookupRunIndex(
        createEventStore(location.repo, "origin", location.selection),
        address.queue.queue,
        address.number,
      )
      if (lookup.kind === "unknown") {
        throw new Error(
          `${RUN_INDEX_CODES.unknown}: parsed ${address.canonical}; ${runIndexRef(address.queue.queue)}:${runIndexPath(address.number)} on ${address.queue.transport} has no entry; indexed range is ${lookup.knownThrough === 0 ? "empty" : `1..${lookup.knownThrough} (may have gaps)`}`,
        )
      }
      const journal = join(location.workdir, "logs", `${lookup.record.id}.jsonl`)
      let detail:
        | Readonly<{ status: "available"; records: ReturnType<typeof readRunLog> }>
        | Readonly<{ status: "unavailable"; reason: string }>
      try {
        const records = readRunLog(join(location.workdir, "logs"), lookup.record.id)
        if (!records.some((record) => record.kind === "run" && record.run === lookup.record.id)) {
          throw new Error(`${journal} has no header for indexed run ${lookup.record.id}`)
        }
        detail = { status: "available", records }
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
        detail = {
          status: "unavailable",
          reason: `${journal} is absent on this host; the index record remains authoritative`,
        }
      }
      const product = { address: address.canonical, number: lookup.number, record: lookup.record, detail }
      io.stdout(
        options.json === true
          ? `${JSON.stringify(product)}\n`
          : [
              `${product.address}  ${lookup.record.id}  ${lookup.record.startedAt}  ${lookup.record.host}  ${lookup.record.actor}  first queue tip ${lookup.record.firstQueueTip}`,
              ...(detail.status === "available"
                ? detail.records.map((record) => JSON.stringify(record))
                : [detail.reason]),
            ].join("\n") + "\n",
      )
    })
  runs
    .command("activate <queue-address>")
    .description("create the run index once for an existing queue, after its CODE carrier lands")
    .option("--json", "emit stable JSON")
    .action(async (operand: string, options: { json?: boolean }) => {
      const address = parseQueueAddress(operand)
      if (address.kind !== "remote") {
        throw new Error(`${operand}: activation needs a portable remote <repo>@<branch> address`)
      }
      const canonical = formatQueueAddress(address)
      const location = await resolveQueueLocation(cwd(), canonical, env)
      const oid = await activateRunIndex(
        createEventStore(location.repo, "origin", location.selection),
        address.queue,
        new Date(),
      )
      const product = { queue: canonical, ref: runIndexRef(address.queue), oid }
      io.stdout(
        options.json === true ? `${JSON.stringify(product)}\n` : `${canonical}: activated ${product.ref} at ${oid}\n`,
      )
    })
  queue
    .command("submit [branch]")
    .description("push the branch and open its change; defaults to the branch checked out here")
    .option("--prepare", "retain moved child commits before lock sync; leave the root branch and change unopened")
    .option("--json", "emit stable JSON")
    .option("--submitter <agent>", SUBMITTER_HELP)
    .option("--notify <seat>", NOTIFY_HELP)
    .option("--issue <id>", ISSUE_HELP)
    .option("--dry-run", DRY_RUN_HELP)
    .option("--queue <value>", QUEUE_HELP)
    .option(
      "--gitlink <path=sha>",
      "pin an existing component commit; repeat for multiple gitlinks",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .addHelpSection("On submit:", SUBMIT_HELP)
    .addHelpSection(
      "Before submitting:",
      "Commit your changes on your own branch. A separate git push or git super push is optional and does not queue a change. --dry-run previews admission and pushes nothing.",
    )
    .action(async (branch, options) => queueSubmit(branch, options as SubmitOptions))
  queue
    .command("health")
    .description("print the service's own health document, as the service last wrote it; the declared supervisor probe")
    .option("--queue <value>", QUEUE_HELP)
    .addHelpSection(
      "On health:",
      "Reads a file and nothing else — no network, no declaration, no second judgement of the queue. " +
        "The service writes the document as it starts and at the end of every round, and restates it on a " +
        "heartbeat between, so this reports the loop's own verdict rather than forming one; past the document's " +
        "own deadline it reports overdue. Exits 0 healthy, 1 no document, 2 stuck or overdue, 3 the document is unreadable.",
    )
    .action(async (options) => {
      const declared = options as { queue?: string }
      const location = await resolveQueueLocation(cwd(), declared.queue, env)
      setExit(await queueHealthCommand(location.workdir, io))
    })
  queue
    .command("pause")
    .description(
      "stop checking and merging while the service keeps the queue visible; a --reason pause still accepts " +
        "submissions, while --maintenance also stops intake for a fenced migration",
    )
    .option("--json", "emit stable JSON")
    .option("--notify <seat>", "name who paused the queue")
    .option("--queue <value>", QUEUE_HELP)
    .option("--reason <text>", "why checking and merging are paused; submissions remain open")
    .option("--maintenance <reason>", "stop submissions as well for a fenced migration")
    .action(async (options) => {
      const declared = options as PauseOptions
      if ((declared.reason === undefined) === (declared.maintenance === undefined)) {
        throw new Error("queue pause needs exactly one of --reason <text> or --maintenance <reason>")
      }
      const location = await resolveQueueLocation(cwd(), declared.queue, env)
      setExit(
        await coreQueueCommand(
          location.repo,
          io,
          {
            by: resolveSubmitter(declared.notify, env),
            command: "pause",
            reason: declared.maintenance ?? declared.reason ?? "",
            ...(declared.maintenance === undefined ? {} : { cause: "maintenance" as const }),
          },
          {
            json: declared.json,
            env,
            log: log(),
            selection: location.selection,
            populateReference: location.owned,
            queue: location.queue,
            workdir: location.workdir,
          },
        ),
      )
    })
  queue
    .command("override")
    .description(
      "hold one declared merge check off for a bounded window, without a commit to the gated repository: " +
        "--check <name> --off --until <time> --reason <text>; --check <name> --clear --reason <text>; --list",
    )
    .option("--check <name>", "the declared merge check to turn off or back on")
    .option("--off", "turn the check off at merge until --until")
    .option("--clear", "turn the check back on now")
    .option("--list", "print the override table, active and expired entries alike")
    .option("--until <time>", "an ISO instant, or HH:MM on this host's clock; at most 12 h from now")
    .option("--reason <text>", "why; required for --off and --clear")
    .option("--json", "emit stable JSON")
    .option("--notify <seat>", "name who set or cleared the override")
    .option("--queue <value>", QUEUE_HELP)
    .addHelpSection(
      "On override:",
      "Applies at MERGE judging only; submit verdicts and the declaration are untouched. The first round " +
        "after a set applies it, and the first round after --clear or --until runs the check again. An " +
        "expired entry reads as expired, never as absent. The actor is the claimed git actor until the " +
        "who-acted token lands (25074).",
    )
    .action(async (options) => {
      const declared = options as PauseOptions & {
        check?: string
        off?: boolean
        clear?: boolean
        list?: boolean
        until?: string
        reason?: string
      }
      const actions = [declared.off === true, declared.clear === true, declared.list === true].filter(Boolean).length
      if (actions !== 1) {
        io.stderr("yrd: queue override takes exactly one of --off, --clear or --list\n")
        setExit(1)
        return
      }
      const action = declared.off === true ? "off" : declared.clear === true ? "clear" : "list"
      const missing = [
        action !== "list" && declared.check === undefined ? "--check <name>" : undefined,
        action !== "list" && declared.reason === undefined ? "--reason <text>" : undefined,
        action === "off" && declared.until === undefined ? "--until <time>" : undefined,
      ].filter((flag): flag is string => flag !== undefined)
      if (missing.length > 0) {
        io.stderr(`yrd: queue override --${action} needs ${missing.join(", ")}\n`)
        setExit(1)
        return
      }
      const location = await resolveQueueLocation(cwd(), declared.queue, env)
      setExit(
        await coreQueueCommand(
          location.repo,
          io,
          {
            action,
            by: resolveSubmitter(declared.notify, env),
            command: "override",
            verified: false,
            ...(declared.check === undefined ? {} : { check: declared.check }),
            ...(declared.until === undefined ? {} : { until: declared.until }),
            ...(declared.reason === undefined ? {} : { reason: declared.reason }),
          },
          {
            json: declared.json,
            env,
            log: log(),
            selection: location.selection,
            populateReference: location.owned,
            queue: location.queue,
            workdir: location.workdir,
          },
        ),
      )
    })
  queue
    .command("archive")
    .description("move merged and cancelled histories ended at least seven days ago to cold custody")
    .option("--dry-run", "list exact eligible refs without writing")
    .option("--min-age <days>", "minimum whole days after the latest ending (at least 7; default: 7)", int)
    .option("--state <state>", "restrict to merged or cancelled histories (default: both)")
    .option("--limit <count>", "maximum transfers after filtering and oldest-first ordering", int)
    .option("--json", "emit stable JSON")
    .option("--notify <seat>", "name who archived the histories")
    .option("--queue <value>", QUEUE_HELP)
    .action(async (options) => {
      const declared = options as PauseOptions & {
        dryRun?: boolean
        minAge?: number
        state?: "merged" | "cancelled"
        limit?: number
      }
      const location = await resolveQueueLocation(cwd(), declared.queue, env)
      setExit(
        await coreQueueCommand(
          location.repo,
          io,
          {
            command: "archive",
            dryRun: declared.dryRun === true,
            by: resolveSubmitter(declared.notify, env),
            minAgeDays: declared.minAge,
            state: declared.state,
            limit: declared.limit,
          },
          {
            json: declared.json,
            env,
            log: log(),
            selection: location.selection,
            populateReference: location.owned,
            queue: location.queue,
            workdir: location.workdir,
          },
        ),
      )
    })
  withdrawOptions(queue.command("withdraw <branch>").description(WITHDRAW_DESCRIPTION))
    .addHelpSection("On withdraw:", WITHDRAW_HELP)
    .action(async (branch, options) => queueEnd(branch as string, options as PauseOptions, "withdraw"))
  sweepCandidatesOptions(queue.command("sweep-candidates").description(SWEEP_CANDIDATES_DESCRIPTION)).action(
    async (options) => queueSweepCandidates(options as SweepCandidatesOptions),
  )
  queue
    .command("resume")
    .description(
      "resume checking and merging on the next service interval; a stop the queue put on a stuck change also " +
        "lifts when that change is withdrawn or merged",
    )
    .option("--json", "emit stable JSON")
    .option("--notify <seat>", "name who resumed the queue")
    .option("--queue <value>", QUEUE_HELP)
    .option("--reason <text>", "why checking and merging may resume")
    .action(async (options) => {
      const declared = options as PauseOptions
      const location = await resolveQueueLocation(cwd(), declared.queue, env)
      setExit(
        await coreQueueCommand(
          location.repo,
          io,
          {
            by: resolveSubmitter(declared.notify, env),
            command: "resume",
            ...(declared.reason === undefined ? {} : { reason: declared.reason }),
          },
          {
            json: declared.json,
            env,
            log: log(),
            selection: location.selection,
            populateReference: location.owned,
            queue: location.queue,
            workdir: location.workdir,
          },
        ),
      )
    })
  function parseStopAt(value: string): number | undefined {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
    const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim())
    if (!match) return undefined
    const hours = Number(match[1])
    const minutes = Number(match[2])
    const seconds = Number(match[3] ?? 0)
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) return undefined
    const target = new Date()
    target.setHours(hours, minutes, seconds, 0)
    if (target.getTime() <= Date.now()) {
      target.setDate(target.getDate() + 1)
    }
    return target.getTime()
  }

  queue
    .command("run")
    .description(
      "one round of queue work, run now rather than by the service; a round already running in the queue's " +
        "workdir finishes first",
    )
    .option("--json", "emit stable JSON")
    .option("--queue <value>", QUEUE_HELP)
    .option("--tier <value>", "which check tier to run: normal (default) or long")
    .option("--stop-at <value>", "stop starting new checks after ISO timestamp or HH:MM time")
    .option("--stop-after <value>", "stop starting new checks after duration, e.g. 2h, 30m, 90s")
    .action(async (options) => {
      const {
        json,
        queue,
        tier: tierOpt,
        stopAt: stopAtOpt,
        stopAfter: stopAfterOpt,
      } = options as {
        json?: boolean
        queue?: string
        tier?: string
        stopAt?: string
        stopAfter?: string
      }
      let tier: "normal" | "long" | undefined
      if (tierOpt !== undefined) {
        if (tierOpt !== "normal" && tierOpt !== "long") {
          io.stderr(`yrd: --tier must be normal or long (got ${tierOpt})\n`)
          setExit(1)
          return
        }
        tier = tierOpt
      }
      let stopAtMs: number | undefined
      if (stopAfterOpt !== undefined) {
        const ms = parseDuration(stopAfterOpt)
        if (ms === undefined) {
          io.stderr(`yrd: --stop-after must be a valid duration like 2h, 30m, 90s (got ${stopAfterOpt})\n`)
          setExit(1)
          return
        }
        stopAtMs = Date.now() + ms
      } else if (stopAtOpt !== undefined) {
        const parsed = parseStopAt(stopAtOpt)
        if (parsed === undefined) {
          io.stderr(`yrd: --stop-at must be a valid ISO timestamp or HH:MM time (got ${stopAtOpt})\n`)
          setExit(1)
          return
        }
        stopAtMs = parsed
      }
      const location = await resolveQueueLocation(cwd(), queue, env)
      const taken = await coreQueueCommand(
        location.repo,
        io,
        { command: "run", ...(tier === undefined ? {} : { tier }), ...(stopAtMs === undefined ? {} : { stopAtMs }) },
        {
          json,
          env,
          log: log(),
          selection: location.selection,
          populateReference: location.owned,
          queue: location.queue,
          workdir: location.workdir,
        },
      )
      setExit(taken)
    })
  queue
    .command("up")
    .description(
      "the service: the same round on a loop; a stuck change stops the line, and the service stays up holding " +
        "the stop and paging through queue health until the change is merged (yrd merge) or withdrawn " +
        "(yrd queue withdraw) or the queue is resumed; it exits 0 when the gitlink moves under it, 2 only when " +
        "no round can run at all",
    )
    .option("--interval <seconds>", "seconds between rounds (default 15)", int)
    .option("--json", "emit stable JSON")
    .option("--queue <value>", QUEUE_HELP)
    .action(async (options) => {
      const { interval, json, queue } = options as { interval?: number; json?: boolean; queue?: string }
      const location = await resolveQueueLocation(cwd(), queue, env)
      const taken = await coreQueueCommand(
        location.repo,
        io,
        { command: "up", ...(interval === undefined ? {} : { intervalSeconds: interval }) },
        {
          json,
          env,
          log: log(),
          selection: location.selection,
          populateReference: location.owned,
          queue: location.queue,
          workdir: location.workdir,
        },
      )
      setExit(taken)
    })
  /**
   * A terminal with a keyboard on the other end. BOTH ends must be one: a
   * watch whose output is a pipe has nobody to draw for, and one whose input
   * is a file has nobody to take a key from — either way the rounds it prints
   * are what the reader wanted.
   */
  const interactiveHere = (): boolean => process.stdin.isTTY === true && process.stdout.isTTY === true
  const localStatusStore = (location: QueueLocation): Readonly<{ path: string; transport: string }> => {
    if (location.address === undefined) throw new Error(`queue at ${location.repo} has no selected address`)
    return { path: join(location.workdir, "repo"), transport: location.address.transport }
  }

  /**
   * `queue list` and `yrd watch` are ONE command (README 1069): the alias is
   * the same action with `--watch` implied, so the two can never grow apart.
   * Both take the same positional filters and the same lens.
   */
  const listRequest = (
    filters: readonly string[],
    options: Readonly<{
      latest?: boolean
      watch?: boolean
      interval?: number
      status?: string
      requireMatch?: boolean
      all?: boolean
      drafts?: boolean
    }>,
  ): CoreQueueCommand => {
    // `--status` is a SPELLING of a filter term, never a second filter path.
    // @yrd/core/21096-cli-ux/22301 merged the rule that the flag and the rows
    // must answer one question — it was ignored under `--json`, which emitted
    // every retained run — and the flag was then dropped with the old surface
    // (1f638504) along with the test that pinned it. One predicate is what
    // keeps the rule true without a second thing to keep in step: `--status
    // merged` IS `list merged`, matched against the state field by
    // `matchesTerm` like every other term.
    const terms = options.status === undefined ? filters : [...filters, options.status]
    return {
      command: "list",
      ...(terms.length === 0 ? {} : { terms }),
      ...(options.latest === true ? { latest: true } : {}),
      ...(options.watch === true ? { watch: true } : {}),
      ...(options.interval === undefined ? {} : { intervalSeconds: options.interval }),
      ...(options.requireMatch === true ? { requireMatch: true } : {}),
      ...(options.all === true ? { all: true } : {}),
      ...(options.drafts === true ? { drafts: true } : {}),
    }
  }
  const listOptions = <T extends { option: (flags: string, description: string, parser?: unknown) => T }>(
    command: T,
  ): T =>
    command
      .option("--latest", "one row per current branch head; default JSON keeps every run of that head")
      .option("--all", "include ended changes older than seven days on event queues")
      .option("--drafts", "include unsubmitted branch heads on event queues")
      .option("--status <state>", "select by state: exactly the same as giving <state> as a filter term")
      .option("--json", "emit stable JSON: result belongs to the run named by run; state is the current change state")
      .option("--fresh", "ask the remote instead of the queue-owned local status store")
      .option("--queue <value>", QUEUE_HELP)
      .option("--interval <seconds>", "seconds between refreshes while watching (default 5)", int)
      .option(
        "--require-match",
        "exit 1 instead of 0 when a filter term matches no rows (default: exit 0, said loudly either way)",
      )
  const LIST_DESCRIPTION =
    "the change under a check, every change in line, the ended newest first, then the drafts; filters are case-insensitive OR terms"
  // The legend, one line per state from the one word table (watch-words.ts), read when the program is built.
  const STATES_HELP = legendLines().join("\n")
  const WATCH_FLAG_HELP = "refresh until the selected change ends, exiting with its code as yrd check does"
  const queueList = async (filters: readonly string[] | undefined, options: unknown): Promise<void> => {
    const { interval, json, latest, status, watch, queue, requireMatch, all, drafts, fresh } = options as {
      interval?: number
      json?: boolean
      latest?: boolean
      status?: string
      watch?: boolean
      queue?: string
      requireMatch?: boolean
      all?: boolean
      drafts?: boolean
      fresh?: boolean
    }
    // A bare interactive watch follows the same declaration set as the runners.
    // Selected watches retain their single-queue ending and exit-code contract.
    if (
      watch === true &&
      queue === undefined &&
      json !== true &&
      interactiveHere() &&
      (filters === undefined || filters.length === 0) &&
      status === undefined
    ) {
      const declared = await resolveDeclaredQueueLocations(cwd(), yrdQueueRunnerDeclarations, env)
      if (declared.length > 0) {
        const sources: import("./watch-pane.tsx").WatchSource[] = []
        for (const entry of declared) {
          const id = `${entry.declaration.repository.name}#${entry.declaration.queue.base}`
          let reader: import("./watch-pane.tsx").WatchSource | undefined
          const initialize = async (initial?: typeof entry) => {
            const resolved = initial ?? (await resolveDeclaredQueueLocations(cwd(), [entry.declaration], env))[0]
            if (resolved === undefined) throw new Error(`declared queue ${id} did not resolve`)
            if (resolved.kind === "unreadable") throw resolved.error
            const location = resolved.location
            const diagnostics: string[] = []
            const taken = await coreQueueCommand(
              location.repo,
              {
                ...io,
                stderr: (text) => {
                  diagnostics.push(text)
                  io.stderr(text)
                },
              },
              listRequest([], { interval, latest, watch, requireMatch, all, drafts }),
              {
                selection: location.selection,
                populateReference: location.owned,
                queue: location.queue,
                workdir: location.workdir,
                env,
                log: log(),
                watchSource: (source) => {
                  reader = source
                },
              },
            )
            if (reader?.snapshot === undefined) {
              throw new Error(
                `reading ${id} exited ${String(taken)}: ${diagnostics.join("").trim() || "no queue snapshot returned"}`,
              )
            }
            return reader.snapshot
          }
          let snapshot: import("./watch-pane.tsx").WatchSnapshot | undefined
          let error: string | undefined
          try {
            snapshot = await initialize(entry)
          } catch (failure: unknown) {
            error = failure instanceof Error ? failure.message : String(failure)
          }
          sources.push({
            id,
            label: id,
            snapshot,
            error,
            load: async (request) => {
              if (reader === undefined) return initialize()
              if (reader.load === undefined) throw new Error(`${id} has no refresh reader`)
              return reader.load(request)
            },
            open: async (row) => {
              if (reader?.open === undefined) throw new Error(`${id} has no detail reader`)
              return reader.open(row)
            },
            loadDiff: async (row) => {
              if (reader?.loadDiff === undefined) throw new Error(`${id} has no diff reader`)
              return reader.loadDiff(row)
            },
            loadCommandOutput: async (command) => {
              if (reader?.loadCommandOutput === undefined) throw new Error(`${id} has no command-output reader`)
              return reader.loadCommandOutput(command)
            },
          })
        }
        const { WatchPane } = await import("./watch-pane.tsx")
        const { run } = await import("silvery/runtime")
        const { createElement } = await import("react")
        const { WATCH_RUN_OPTIONS } = await import("./watch-run-options.ts")
        const snapshot = sources.find((source) => source.snapshot !== undefined)?.snapshot ?? {
          queue: "Declared queues",
          queues: [],
          rows: [],
          unfiltered: [],
          at: new Date(),
        }
        const app = await run(
          createElement(WatchPane, {
            sources,
            snapshot,
            intervalMs: Math.max(1, interval ?? 5) * 1000,
          }),
          WATCH_RUN_OPTIONS,
        )
        await app.waitUntilExit()
        setExit(0)
        return
      }
    }
    const location = await resolveQueueLocation(cwd(), queue, env, "reader")
    const taken = await coreQueueCommand(
      location.repo,
      io,
      listRequest(filters ?? [], { interval, latest, status, watch, requireMatch, all, drafts }),
      {
        selection: location.selection,
        populateReference: location.owned,
        queue: location.queue,
        workdir: location.workdir,
        json,
        env,
        interactive: interactiveHere(),
        ...(fresh === true || watch === true ? {} : { localStatusStore: localStatusStore(location) }),
        log: log(),
      },
    )
    setExit(taken)
  }
  const LS_DESCRIPTION =
    "group changes by status (in check, waiting, draft, ended in the last 24 h) with issue number, title, and owner seat"
  const queueLs = async (filters: readonly string[] | undefined, options: unknown): Promise<void> => {
    const { json, queue, fresh } = options as {
      json?: boolean
      queue?: string
      fresh?: boolean
    }
    const location = await resolveQueueLocation(cwd(), queue, env, "reader")
    const taken = await coreQueueCommand(
      location.repo,
      io,
      {
        command: "ls",
        terms: filters ?? [],
      },
      {
        selection: location.selection,
        populateReference: location.owned,
        queue: location.queue,
        workdir: location.workdir,
        json,
        env,
        ...(fresh === true ? {} : { localStatusStore: localStatusStore(location) }),
        log: log(),
      },
    )
    setExit(taken)
  }
  listOptions(
    queue
      .command("list [filter...]")
      .description(LIST_DESCRIPTION)
      .option("--watch", WATCH_FLAG_HELP)
      .addHelpSection("States:", STATES_HELP),
  ).action(async (filters, options) => queueList(filters as string[] | undefined, options))
  // `yrd list` is `yrd queue list` (the operator's spelling, 2026-09-04),
  // registered the way `yrd submit` is: the same action, the same options, one
  // alias visible in `--help`. `yrd queue list` stays the canonical form.
  listOptions(
    program
      .command("list [filter...]")
      .description(`${LIST_DESCRIPTION} (the same as ${name} queue list)`)
      .option("--watch", WATCH_FLAG_HELP)
      .addHelpSection("States:", STATES_HELP),
  ).action(async (filters, options) => queueList(filters as string[] | undefined, options))
  queue
    .command("ls [filter...]")
    .description(LS_DESCRIPTION)
    .option("--json", "emit stable JSON: one document, complete on a pipe or a file")
    .option("--fresh", "read the queue from its source rather than the cached mirror")
    .option("--queue <value>", QUEUE_HELP)
    .action(async (filters, options) => queueLs(filters as string[] | undefined, options))
  // `yrd ls` is `yrd queue ls` (the operator's spelling, #27093),
  // registered the way `yrd list` is: the same action, the same options, one
  // alias visible in `--help`. `yrd queue ls` stays the canonical form.
  program
    .command("ls [filter...]")
    .description(`${LS_DESCRIPTION} (the same as ${name} queue ls)`)
    .option("--json", "emit stable JSON: one document, complete on a pipe or a file")
    .option("--fresh", "read the queue from its source rather than the cached mirror")
    .option("--queue <value>", QUEUE_HELP)
    .action(async (filters, options) => queueLs(filters as string[] | undefined, options))
  queue
    .command("stats")
    .description(
      "the queue's numbers from the same rows `queue list` shows: merged, failed, same-head retries, re-pushed " +
        "branches, refs pushed and never submitted, opened→merged latency; for the whole queue and per submitter or branch",
    )
    .option(
      "--since <when>",
      "a duration back from now (3h, 45m, 2d, 1w), an instant, or a commit (its committer date); rows decided before it are outside",
    )
    .option("--by <key>", "group under the queue line by submitter (default) or branch")
    .option("--json", "emit stable JSON: one document, complete on a pipe or a file")
    .option("--queue <value>", QUEUE_HELP)
    .action(async (options) => {
      const { by, json, since, queue } = options as { by?: string; json?: boolean; since?: string; queue?: string }
      const location = await resolveQueueLocation(cwd(), queue, env, "reader")
      if (by !== undefined && by !== "submitter" && by !== "branch") {
        io.stderr(`yrd: --by takes submitter or branch, not ${by}\n`)
        setExit(2)
        return
      }
      const taken = await coreQueueCommand(
        location.repo,
        io,
        { command: "stats", ...(since === undefined ? {} : { since }), ...(by === undefined ? {} : { by }) },
        {
          json,
          env,
          log: log(),
          selection: location.selection,
          populateReference: location.owned,
          queue: location.queue,
          workdir: location.workdir,
        },
      )
      setExit(taken)
    })
  queue
    .command("show [branch]")
    .description("the branch's changes, each check's result and log")
    .option("--all", "all branches and their change segments as JSON")
    .option("--json", "emit stable JSON")
    .option("--fresh", "ask the remote instead of the queue-owned local status store")
    .option("--queue <value>", QUEUE_HELP)
    .action(async (branch, options) => {
      const { all, json, queue, fresh } = options as { all?: boolean; json?: boolean; queue?: string; fresh?: boolean }
      const location = await resolveQueueLocation(cwd(), queue, env, "reader")
      const taken = await coreQueueCommand(
        location.repo,
        io,
        {
          command: "show",
          ...(branch === undefined ? {} : { branch: branch as string }),
          ...(all === true ? { all } : {}),
        },
        {
          json,
          env,
          log: log(),
          selection: location.selection,
          populateReference: location.owned,
          queue: location.queue,
          workdir: location.workdir,
          ...(fresh === true ? {} : { localStatusStore: localStatusStore(location) }),
        },
      )
      setExit(taken)
    })
  listOptions(
    program
      .command("watch [filter...]")
      .description(
        "queue list with --watch implied: refresh until the selected change ends. " +
          "On a terminal it draws the pane: the table, the RUNNER and STATS boxes, and one change opened " +
          "(Enter) as its run: a one-line status, the Timeline tab and one tab per stage the round ran. Keys: j/k move, " +
          "Enter opens, Escape closes, o r d f show one status, a shows everything, v folds the diff, ? help, q leaves. " +
          "The run journal is local to the machine the queue runs on, so off it the check running now, " +
          "the run id, the RUNNER and STATS boxes and the check clocks are absent and the watch says where it looked.",
      ),
  ).action(async (filters, options) => queueList(filters as string[] | undefined, { ...options, watch: true }))
  addQueueExamples(queue, name)

  // `yrd submit` is `yrd queue submit` (plan § Commands), registered rather
  // than rewritten: one alias, visible in `--help`, with the same options.
  program
    .command("submit [branch]")
    .description("push the branch and open its change")
    .option("--prepare", "retain moved child commits before lock sync; leave the root branch and change unopened")
    .option("--json", "emit stable JSON")
    .option("--submitter <agent>", SUBMITTER_HELP)
    .option("--notify <seat>", NOTIFY_HELP)
    .option("--issue <id>", ISSUE_HELP)
    .option("--dry-run", DRY_RUN_HELP)
    .option("--queue <value>", QUEUE_HELP)
    .option(
      "--gitlink <path=sha>",
      "pin an existing component commit; repeat for multiple gitlinks",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .addHelpSection("On submit:", SUBMIT_HELP)
    .addHelpSection(
      "Before submitting:",
      "Commit your changes on your own branch. A separate git push or git super push is optional and does not queue a change. --dry-run previews admission and pushes nothing.",
    )
    .action(async (branch, options) => queueSubmit(branch, options as SubmitOptions))

  const queueMerge = async (branch: string, options: MergeOptions): Promise<void> => {
    // A change not in line yet is submitted from the checkout this runs in,
    // exactly as submit does; outside a clone only a change already in line
    // can be merged. The round itself runs where every queue round runs.
    const author =
      repositoryHere(cwd()) === undefined ? undefined : await resolveQueueLocation(cwd(), options.queue, env, "submit")
    const location = await resolveQueueLocation(cwd(), options.queue, env)
    const noCheck = options.noCheck === true || options.check === false
    setExit(
      await coreQueueCommand(
        location.repo,
        io,
        {
          branch,
          command: "merge",
          submitter: submitterOption(options, env, io),
          ...(options.issue === undefined ? {} : { issue: options.issue }),
          ...(noCheck ? { noCheck: true } : {}),
          ...(author === undefined
            ? {}
            : {
                author: {
                  repo: author.repo,
                  selection: author.selection,
                  ...(author.remote === undefined ? {} : { remote: author.remote }),
                },
              }),
        },
        {
          json: options.json,
          env,
          log: log(),
          selection: location.selection,
          populateReference: location.owned,
          queue: location.queue,
          workdir: location.workdir,
        },
      ),
    )
  }
  program
    .command("merge <branch>")
    .description(
      "merge the branch's change now, ahead of the line and on a stopped line too: submit it unless it is in " +
        "line, then run its checks and its merge in this process",
    )
    .option("--json", "emit stable JSON")
    .option("--submitter <agent>", SUBMITTER_HELP)
    .option("--notify <seat>", NOTIFY_HELP)
    .option("--issue <id>", ISSUE_HELP)
    .option("--no-check", "merge with git machinery only (compose, merge, push), skipping all declared checks")
    .option("--queue <value>", QUEUE_HELP)
    .addHelpSection("On merge:", MERGE_HELP)
    .action(async (branch, options) => queueMerge(branch as string, options as MergeOptions))

  // `yrd withdraw` is `yrd queue withdraw` (24824, absorbing design 3b § 1: the
  // verb beside submit and merge), registered the way `yrd submit` and `yrd
  // list` are — one action and one option table, with the alias in `--help`, so
  // neither spelling can grow a flag the other lacks.
  withdrawOptions(
    program.command("withdraw <branch>").description(`${WITHDRAW_DESCRIPTION} (the same as ${name} queue withdraw)`),
  )
    .addHelpSection("On withdraw:", WITHDRAW_HELP)
    .action(async (branch, options) => queueEnd(branch as string, options as PauseOptions, "withdraw"))

  sweepCandidatesOptions(
    program
      .command("sweep-candidates")
      .description(`${SWEEP_CANDIDATES_DESCRIPTION} (the same as ${name} queue sweep-candidates)`),
  ).action(async (options) => queueSweepCandidates(options as SweepCandidatesOptions))

  // One option table with withdraw (24824 §1): the actor and the coordination
  // recipient are separate facts on BOTH endings, so drop must not carry its own
  // table that names neither --submitter (@dev/11 27262 HOLD fba7572b).
  withdrawOptions(
    program.command("drop <branch>").description("end an event change and delete its branch in one leased publish"),
  ).action(async (branch, options) => queueEnd(branch as string, options as PauseOptions, "drop"))

  program
    .command("ignore <branch>")
    .description("ignore one open event change while keeping it visible outside the queue position")
    .option("--reason <text>", "why this change is ignored")
    .option("--queue <value>", QUEUE_HELP)
    .option("--notify <seat>", "name who ignored the change")
    .option("--json", "emit stable JSON")
    .action(async (branch, options) => queueIgnore(branch as string, options as PauseOptions, true))

  program
    .command("unignore <branch>")
    .description("return one ignored event change to the queue position")
    .option("--reason <text>", "refused: unignore clears the previous reason")
    .option("--queue <value>", QUEUE_HELP)
    .option("--notify <seat>", "name who unignored the change")
    .option("--json", "emit stable JSON")
    .action(async (branch, options) => queueIgnore(branch as string, options as PauseOptions, false))

  program
    .command("check <name...>")
    .description("run one of the queue's checks here, now, in a fresh worktree of HEAD")
    .option("--json", "emit stable JSON")
    .action(async (names, options) => {
      const json = (options as { json?: boolean }).json
      const taken = await coreQueueCommand(
        cwd(),
        io,
        { command: "check", names: names as readonly string[] },
        { json, env, log: log() },
      )
      setExit(taken)
    })

  // The queue workdir's own log tree (28499, @cto ruling 2026-10-10T02:50Z). The
  // round prunes its own raw output a batch at a time; THIS verb is the one-time
  // bounded drain of a backlog that already exists — dry-run first, then apply.
  // Journals are kept: `yrd runs <n>` and the "why not merged" explainer read
  // them after the round ends, so only the raw output a journal points at goes.
  const logs = program.command("logs").description("the queue workdir's own log tree: what is kept and what is pruned")
  logs.helpCommand(false)
  logs
    .command("prune")
    .description(
      "remove round output older than the retention window (default 7 days), oldest first; journals are kept",
    )
    .option("--dry-run", "list what would be removed and remove nothing")
    .option("--limit <count>", "remove at most this many round-output directories", int)
    .option("--queue <value>", QUEUE_HELP)
    .option("--json", "emit stable JSON")
    .action(async (options) => {
      const { dryRun, json, limit, queue } = options as {
        dryRun?: boolean
        json?: boolean
        limit?: number
        queue?: string
      }
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
        io.stderr(`yrd: --limit must be a non-negative integer (got ${String(limit)})\n`)
        setExit(1)
        return
      }
      const location = await resolveQueueLocation(cwd(), queue, env)
      const now = new Date()
      // `logs` is required, `checks` optional (a host may never have run a check).
      const roots = [
        { path: join(location.workdir, "logs") },
        { path: join(location.workdir, "checks"), optional: true },
      ]
      const scan = expiredRoundOutput({ roots, now })
      const selected = scan.entries
      const chosen = limit === undefined ? selected : selected.slice(0, limit)
      const removed: ExpiredRoundOutput[] = []
      if (dryRun !== true) {
        // Bounded batches through removely; the list is selected ONCE, so a
        // drain of thousands never re-walks the tree between batches.
        for (let index = 0; index < chosen.length; index += ROUND_REMOVAL_BATCH) {
          const batch = await removeExpiredRoundOutput({ selected: chosen.slice(index, index + ROUND_REMOVAL_BATCH) })
          removed.push(...batch.removed)
        }
      }
      const result = {
        windowMs: ROUND_OUTPUT_WINDOW_MS,
        removed,
        remaining: selected.slice(removed.length),
        missing: scan.missing,
      }
      // One observation row, in the very log tree just pruned: the drain is on record.
      const record = openLog(join(location.workdir, "logs"), () => now)
      appendFileSync(record.path, `${JSON.stringify(retentionObservation(result, { run: record.id, at: now }))}\n`)
      const days = Math.round(ROUND_OUTPUT_WINDOW_MS / (24 * 60 * 60 * 1000))
      const stillOlder = selected.length - removed.length
      // `--dry-run` PROMISES a list, so the human mode prints the paths it would
      // remove (and the apply mode the paths it did): a count alone would leave
      // the operator unable to check the one thing the flag exists for.
      const listed = dryRun === true ? chosen : removed
      io.stdout(
        json === true
          ? `${JSON.stringify({
              workdir: location.workdir,
              dryRun: dryRun === true,
              windowDays: days,
              selected: selected.length,
              planned: chosen.length,
              removed: removed.length,
              remaining: stillOlder,
              ...(scan.missing.length === 0 ? {} : { missing: scan.missing }),
              ...(dryRun === true ? { list: chosen.map((entry) => entry.path) } : {}),
            })}\n`
          : retentionHumanLines(
              {
                windowMs: ROUND_OUTPUT_WINDOW_MS,
                removed,
                remaining: selected.slice(removed.length),
                missing: scan.missing,
              },
              { roots: roots.map((root) => root.path), dryRun: dryRun === true, listed },
            ).join("\n") + "\n",
      )
    })

  // `env` is the printed name; `bay` is today's word, kept as its alias.
  const env_ = program.command("env").alias("bay").description("an environment for one branch")
  env_.helpCommand(false)
  env_
    .command("open [commit]")
    .description(
      "with [commit], retain that exact commit detached; with --bay/--issue and no argument instead, " +
        "open or adopt its task/<name> branch; prints the path either way",
    )
    .option("--bay <name>", "name the environment")
    .option("--issue <ref>", "bind the branch to this issue with a Refs commit before setup")
    .option("--hold <reason>", "lock the worktree with this reason; git worktree unlock <path> clears it")
    .option("--json", "emit stable JSON")
    .action(async (commit, options) =>
      setExit(
        await openEnvironment(
          { ...options, ...(commit === undefined ? {} : { commit }) } as Parameters<typeof openEnvironment>[0],
          io,
        ),
      ),
    )
  env_
    .command("list", { isDefault: true })
    .description("the environments this repository holds")
    .option("--json", "emit stable JSON")
    .action(async (options) => setExit(await listEnvironments(options as Parameters<typeof listEnvironments>[0], io)))

  env_
    .command("close <path>")
    .description("run teardown and remove a clean, unlocked environment, retaining its submodule stores")
    .addHelpSection(
      "When this caller's same-UID CWD census cannot read every pid:",
      "The close is not certified and not refused: the request is queued under the queue workdir " +
        "(`state/yrd/env-close-requests/`) and the queue's own round, whose census reads every pid, " +
        "runs the same close lifecycle and journals the outcome. That ending exits 4, named `queued` " +
        "in --json, because the environment still exists. A request this caller cannot write is " +
        "refused loudly instead.",
    )
    .option(
      "--retain <directory>",
      "durable GitSuper retention directory; defaults to the workdir retained-modules directory",
    )
    .option("--json", "emit stable JSON")
    .action(async (path, options) => setExit(await closeEnvironment(path, options, io)))

  const mirror = program
    .command("mirror")
    .description("this host's local copy of each hosted repository, read by composes")
  mirror.helpCommand(false)
  mirror
    .command("refresh")
    .description(
      "create or fetch the mirror of every hosted repository this repository declares, nested ones included, " +
        `under the store \`git config ${MIRROR_STORE_SETTING}\` names`,
    )
    .option("--commit <rev>", "read the declarations at this commit (default HEAD)")
    .option("--json", "emit stable JSON")
    .addHelpSection(
      "On refresh:",
      "One clone --mirror or fetch --prune per repository, under that mirror's exclusive lock; a refresh that " +
        "waited on another one that finished meanwhile fetches nothing. Exits 0 with every mirror refreshed " +
        "(each skipped path is named), 1 when a mirror could not be created, fetched or locked.",
    )
    .action(async (options) => setExit(await refreshMirrors(options as MirrorRefreshOptions, io)))

  addExamples(program, name)
  return program
}

function addExamples(program: CliCommand, name: string): void {
  program.addHelpSection("Workflow:", [
    [
      "1. Update your branch",
      "from a clean branch: git fetch origin main, then git rebase FETCH_HEAD; substitute your configured target",
    ],
    [
      "2. Verify and commit",
      "run your checks; use git super status and git super diff to inspect changes across submodules",
    ],
    ["3. Publish if useful", "git push or git super push shares the branch; a push alone does not queue it"],
    [`4. ${name} submit [branch]`, "publish the branch and open its change; defaults to the current branch"],
    [`5. ${name} queue show <branch>`, "follow checks and the merge, or find the failure log path"],
  ])
  program.addHelpSection("Aliases:", [
    [`${name} submit`, `${name} queue submit`],
    [`${name} withdraw`, `${name} queue withdraw`],
    [`${name} list`, `${name} queue list`],
    [`${name} ls`, `${name} queue ls`],
    [`${name} bay`, `${name} env (today's word)`],
  ])
  program.addHelpSection("Examples:", [
    [`$ ${name} submit fix-login`, "push the branch and open its change"],
    [`$ ${name} merge fix-login`, "merge the branch now, ahead of the line: its checks, then its merge"],
    [`$ ${name} queue list`, "the change under a check, the line, the ended, then the drafts"],
    [`$ ${name} queue stats --since 1d`, "merged, failed, retries, re-pushes and latency, per submitter"],
    [`$ ${name} queue show fix-login`, "the branch's changes, each check's result and log"],
    [`$ ${name} queue run`, "one round of queue work, run now"],
    [`$ ${name} check affected-tests`, "run one of the queue's checks here, now"],
    [`$ ${name} env open <commit>`, "open an exact commit detached and keep it"],
  ])
}

function addQueueExamples(queue: CliCommand, name: string): void {
  queue.addHelpSection("Examples:", [
    [`$ ${name} queue submit fix-login`, "push the branch and open its change"],
    [`$ ${name} queue list`, "the change under a check, the line, the ended, then the drafts"],
    [`$ ${name} queue stats --since 1d`, "merged, failed, retries, re-pushes and latency, per submitter"],
    [`$ ${name} queue show fix-login`, "the branch's changes, each check's result and log"],
    [`$ ${name} queue run`, "one round of queue work, run now"],
    [`$ ${name} queue up`, "the service: the same round on a loop"],
  ])
}

/**
 * Every failure of a command reaches exactly one exit site: an invocation that
 * could not be parsed or a command that could not judge is STUCK, exit 2
 * (plan § The final design). A check that failed is exit 1 and returned by the
 * command itself, never thrown.
 */
export async function runYrdProcess(argv: readonly string[], io: YrdCliIO): Promise<YrdCliExitCode> {
  const args = argv.slice(2)
  const env = process.env
  const name = "yrd"
  if (args.length === 1 && (args[0] === "-V" || args[0] === "--version")) {
    io.stdout(`${formatYrdRuntimeVersion()}\n`)
    return 0
  }
  let exit: YrdCliExitCode = 0
  const setExit = (code: YrdCliExitCode): void => {
    if (code !== 0) exit = code
  }
  let logger: ReturnType<typeof createYrdLogger> | undefined
  const program = buildProgram(name, io, env, setExit, () => logger)
  try {
    // The logger is built from the globals BEFORE any action runs, so the
    // queue's log-record stream is rendered at the level the invocation asked for
    // and at no other reading of the environment.
    program.hook("preAction", () => {
      if (logger !== undefined) return
      logger = createYrdLogger(resolveYrdObservability(program.opts() as GlobalOptions, env), (text) => io.stderr(text))
    })
    await program.parseAsync([...args], { from: "user" })
    return exit
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0 || error.code === "commander.helpDisplayed" || error.code === "commander.version") {
        return 0
      }
      // Commander already printed the refusal, and it names the option or the
      // operand. Exit 2 is what an invocation this program cannot judge is.
      return 2
    }
    if (isQueueEventShapeUnreadable(error)) {
      const rendered = args.map((arg) => (/[ \t\n"'$`\\]/u.test(arg) ? JSON.stringify(arg) : arg)).join(" ")
      const mainCommand = `@in main -- bun yrd${rendered.length > 0 ? ` ${rendered}` : ""}`
      io.stderr(
        `yrd: ${error.message}: this CLI is older than the queue's writer; run from main instead:\n  ${mainCommand}\n`,
      )
      return 2
    }
    io.stderr(`yrd: ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  } finally {
    logger?.end?.()
  }
}

/** The process entry, shared by `yrd` and `git-yrd`. */
export async function runYrdExecutable(): Promise<never> {
  const color = process.env.NO_COLOR === undefined && (process.stdout.isTTY || process.env.FORCE_COLOR !== undefined)
  const io: YrdCliIO = {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    color,
    ...(process.stdout.isTTY && process.stdout.columns > 0 ? { columns: process.stdout.columns } : {}),
    cwd: process.cwd(),
  }
  const exitCode = await runYrdProcess(process.argv, io)
  await drainOutput()
  process.exit(exitCode)
}
