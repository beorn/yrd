/**
 * The whole command surface ([plan](../../../../pm/@i/10-yrd/plan.md)
 * § The final design, Commands).
 *
 * The command surface is `yrd queue submit|run|up|pause|resume|list|show`,
 * `yrd check`, `yrd env open|list`, with `yrd submit` as the alias of the one
 * used most and `yrd bay` as `env`'s until flag day's word is retired. Every
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
import type { CoreQueueCommand } from "./queue-core-commands.ts"
import { listEnvironments, openEnvironment } from "./env-commands.ts"
import {
  closeGarage,
  garageRefCommit,
  garageSeat,
  garageServiceRefusal,
  garageStatusLine,
  openGarage,
  readGarageDeclaration,
} from "./garage.ts"
import { createYrdLogger, resolveYrdObservability, type YrdObservabilityFlags } from "./observability.ts"
import { formatYrdRuntimeVersion, YRD_VERSION } from "./version.ts"
import type { YrdCliExitCode, YrdCliIO } from "./types.ts"

/** The seat a submit names. Never the git author: the fleet's git identity
 * names nobody (ruling @i/10-yrd/24028). */
const DEFAULT_SUBMITTER_ENV = "YRD_DEFAULT_SUBMITTER"

type GlobalOptions = YrdObservabilityFlags

type SubmitOptions = Readonly<{ json?: boolean; notify?: string; issue?: string; dryRun?: boolean }>
type PauseOptions = Readonly<{ json?: boolean; notify?: string }>

// Only queue actions load the runtime identity fence. Help and --version must
// not perform its Git reads (version owns its own bounded source diagnostic).
const coreQueueCommand: typeof import("./queue-core-commands.ts").coreQueueCommand = async (...args) => {
  const queue = await import("./queue-core-commands.ts")
  return queue.coreQueueCommand(...args)
}

const NOTIFY_HELP = `the seat that hears the result; else ${DEFAULT_SUBMITTER_ENV}, else unknown`
const ISSUE_HELP = "the issue; else the head's Resolves/Refs trailer, else the branch name's leading segment"
const DRY_RUN_HELP = "print the change this would open and push nothing"

export function resolveSubmitter(declared: string | undefined, env: NodeJS.ProcessEnv): string {
  const named = declared?.trim()
  if (named !== undefined && named !== "") return named
  const launched = env[DEFAULT_SUBMITTER_ENV]?.trim()
  return launched === undefined || launched === "" ? "unknown" : launched
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
  program.helpCommand(false)
  program.exitOverride()
  program.version(YRD_VERSION, "-V, --version")
  program
    .option("--log-level <level>", "silent, error, warn, info, debug or trace")
    .option("-v, --verbose", "raise the log level; repeat for more", (_value, previous: number) => previous + 1, 0)
    .option("-q, --quiet", "lower the log level; repeat for less", (_value, previous: number) => previous + 1, 0)

  const queueSubmit = async (branch: string | undefined, options: SubmitOptions): Promise<void> => {
    const taken = await coreQueueCommand(
      cwd(),
      io,
      {
        command: "submit",
        submitter: resolveSubmitter(options.notify, env),
        ...(branch === undefined ? {} : { branch }),
        ...(options.issue === undefined ? {} : { issue: options.issue }),
        ...(options.dryRun === true ? { dryRun: true } : {}),
      },
      { json: options.json, env, log: log() },
    )
    setExit(taken)
  }
  const queue = program.command("queue").description("the line of changes for the target branch")
  queue.helpCommand(false)
  queue
    .command("submit [branch]")
    .description("push the branch and open its change; defaults to the branch checked out here")
    .option("--json", "emit stable JSON")
    .option("--notify <seat>", NOTIFY_HELP)
    .option("--issue <id>", ISSUE_HELP)
    .option("--dry-run", DRY_RUN_HELP)
    .action(async (branch, options) => queueSubmit(branch, options as SubmitOptions))
  queue
    .command("pause <reason>")
    .description("stop checking and merging while the service keeps the queue visible")
    .option("--json", "emit stable JSON")
    .option("--notify <seat>", "name who paused the queue")
    .action(async (reason, options) => {
      const declared = options as PauseOptions
      setExit(
        await coreQueueCommand(
          cwd(),
          io,
          { by: resolveSubmitter(declared.notify, env), command: "pause", reason: reason as string },
          { json: declared.json, env, log: log() },
        ),
      )
    })
  queue
    .command("resume [reason]")
    .description("resume checking and merging on the next service interval")
    .option("--json", "emit stable JSON")
    .option("--notify <seat>", "name who resumed the queue")
    .action(async (reason, options) => {
      const declared = options as PauseOptions
      setExit(
        await coreQueueCommand(
          cwd(),
          io,
          {
            by: resolveSubmitter(declared.notify, env),
            command: "resume",
            ...(reason === undefined ? {} : { reason: reason as string }),
          },
          { json: declared.json, env, log: log() },
        ),
      )
    })
  queue
    .command("run")
    .description("one round of queue work, run now rather than by the service")
    .option("--json", "emit stable JSON")
    .action(async (options) => {
      const json = (options as { json?: boolean }).json
      const taken = await coreQueueCommand(cwd(), io, { command: "run" }, { json, env, log: log() })
      setExit(taken)
    })
  queue
    .command("up")
    .description("the service: the same round on a loop; exits 2 when stuck, 0 when the gitlink moves under it")
    .option("--interval <seconds>", "seconds between rounds (default 15)", int)
    .option("--json", "emit stable JSON")
    .action(async (options) => {
      const { interval, json } = options as { interval?: number; json?: boolean }
      // The garage stops the SERVICE, and this is the last moment before it
      // becomes one. `queue run` — one round, run now — goes through untouched,
      // because that is what a garage is FOR; it stamps the reason on its own
      // record instead.
      const garage = readGarageDeclaration(cwd())
      if (garage !== undefined) {
        io.stderr(`${garageServiceRefusal(garage)}\n`)
        setExit(2)
        return
      }
      const taken = await coreQueueCommand(
        cwd(),
        io,
        { command: "up", ...(interval === undefined ? {} : { intervalSeconds: interval }) },
        { json, env, log: log() },
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

  /**
   * `queue list` and `yrd watch` are ONE command (README 1069): the alias is
   * the same action with `--watch` implied, so the two can never grow apart.
   * Both take the same positional filters and the same lens.
   */
  const listRequest = (
    filters: readonly string[],
    options: Readonly<{ latest?: boolean; watch?: boolean; interval?: number }>,
  ): CoreQueueCommand => ({
    command: "list",
    ...(filters.length === 0 ? {} : { terms: filters }),
    ...(options.latest === true ? { latest: true } : {}),
    ...(options.watch === true ? { watch: true } : {}),
    ...(options.interval === undefined ? {} : { intervalSeconds: options.interval }),
  })
  const listOptions = <T extends { option: (flags: string, description: string, parser?: unknown) => T }>(
    command: T,
  ): T =>
    command
      .option("--latest", "one row per change; the default keeps every run that touched it")
      .option("--json", "emit stable JSON: result belongs to the run named by run; state is the current change state")
      .option("--interval <seconds>", "seconds between refreshes while watching (default 5)", int)
  listOptions(
    queue
      .command("list [filter...]")
      .description("every change in line, then the failed and the merged; filters are case-insensitive OR terms")
      .option("--watch", "refresh until the selected change ends, exiting with its code as yrd check does"),
  ).action(async (filters, options) => {
    const { interval, json, latest, watch } = options as {
      interval?: number
      json?: boolean
      latest?: boolean
      watch?: boolean
    }
    const taken = await coreQueueCommand(
      cwd(),
      io,
      listRequest((filters as string[] | undefined) ?? [], { interval, latest, watch }),
      { json, env, interactive: interactiveHere(), log: log() },
    )
    setExit(taken)
  })
  queue
    .command("show <branch>")
    .description("the branch's changes, each check's result and log")
    .option("--json", "emit stable JSON")
    .action(async (branch, options) => {
      const json = (options as { json?: boolean }).json
      const taken = await coreQueueCommand(
        cwd(),
        io,
        { branch: branch as string, command: "show" },
        { json, env, log: log() },
      )
      setExit(taken)
    })
  // The garage is a ref, so a mechanic can open it with plain git and every
  // surface reads it. These two spellings stay because the queue is IN the
  // garage: they are the only non-plumbing way to open and close it, and
  // `readGarageDeclaration` is already on the run path above.
  listOptions(
    program
      .command("watch [filter...]")
      .description(
        "queue list with --watch implied: refresh until the selected change ends. " +
          "The run journal is local to the machine the queue runs on, so off it the check running now, " +
          "the run id and the check clocks are absent and the watch says where it looked.",
      ),
  ).action(async (filters, options) => {
    const { interval, json, latest } = options as { interval?: number; json?: boolean; latest?: boolean }
    const taken = await coreQueueCommand(
      cwd(),
      io,
      listRequest((filters as string[] | undefined) ?? [], { interval, latest, watch: true }),
      { json, env, interactive: interactiveHere(), log: log() },
    )
    setExit(taken)
  })
  const garage = queue
    .command("garage", { hidden: true })
    .description("stop the service and work on the queue yourself")
  garage.helpCommand(false)
  garage
    .command("open")
    .description("open the garage; the service stays down until it closes")
    .requiredOption("--reason <text>", "why the service is off")
    .action((options) => {
      const repo = cwd()
      const standing = readGarageDeclaration(repo)
      if (standing !== undefined) {
        io.stderr(`yrd: the garage is already open — ${garageStatusLine(standing)}\n`)
        setExit(2)
        return
      }
      const { reason } = options as { reason: string }
      const { garage: opened } = openGarage(repo, { by: garageSeat(env), reason })
      io.stdout(`${garageStatusLine(opened)}\n`)
    })
  garage
    .command("close")
    .description("close the garage; the service may start again")
    .action(() => {
      const repo = cwd()
      const standing = readGarageDeclaration(repo)
      const at = garageRefCommit(repo)
      if (standing === undefined || at === undefined) {
        io.stderr("yrd: no garage is open here\n")
        setExit(2)
        return
      }
      closeGarage(repo, at)
      io.stdout(`the garage is closed (it was ${standing.reason})\n`)
    })

  addQueueExamples(queue, name)

  // `yrd submit` is `yrd queue submit` (plan § Commands), registered rather
  // than rewritten: one alias, visible in `--help`, with the same options.
  program
    .command("submit [branch]")
    .description("push the branch and open its change")
    .option("--json", "emit stable JSON")
    .option("--notify <seat>", NOTIFY_HELP)
    .option("--issue <id>", ISSUE_HELP)
    .option("--dry-run", DRY_RUN_HELP)
    .action(async (branch, options) => queueSubmit(branch, options as SubmitOptions))

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

  // `env` is the printed name; `bay` is today's word, kept as its alias.
  const env_ = program.command("env").alias("bay").description("an environment for one branch")
  env_.helpCommand(false)
  env_
    .command("open")
    .description("open an environment for one branch and keep it; prints its path")
    .option("--bay <name>", "name the environment")
    .option("--issue <ref>", "the issue this environment is for")
    .option("--json", "emit stable JSON")
    .action(async (options) => setExit(await openEnvironment(options as Parameters<typeof openEnvironment>[0], io)))
  env_
    .command("list", { isDefault: true })
    .description("the environments this repository holds")
    .option("--json", "emit stable JSON")
    .action(async (options) => setExit(await listEnvironments(options as Parameters<typeof listEnvironments>[0], io)))

  addExamples(program, name)
  return program
}

function addExamples(program: CliCommand, name: string): void {
  program.addHelpSection("Aliases:", [
    [`${name} submit`, `${name} queue submit`],
    [`${name} bay`, `${name} env (today's word)`],
  ])
  program.addHelpSection("Examples:", [
    [`$ ${name} submit fix-login`, "push the branch and open its change"],
    [`$ ${name} queue list`, "every change in line, then the failed and the merged"],
    [`$ ${name} queue show fix-login`, "the branch's changes, each check's result and log"],
    [`$ ${name} queue run`, "one round of queue work, run now"],
    [`$ ${name} check affected-tests`, "run one of the queue's checks here, now"],
    [`$ ${name} env open --bay fix`, "open an environment and keep it"],
  ])
}

function addQueueExamples(queue: CliCommand, name: string): void {
  queue.addHelpSection("Examples:", [
    [`$ ${name} queue submit fix-login`, "push the branch and open its change"],
    [`$ ${name} queue list`, "every change in line, then the failed and the merged"],
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
  program.configureOutput({
    writeOut: (text) => io.stdout(text),
    writeErr: (text) => io.stderr(text),
  })
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
    cwd: process.cwd(),
  }
  const exitCode = await runYrdProcess(process.argv, io)
  // A forced exit discards queued pipe writes (large queue JSON stopped at
  // 64KiB). Finish both streams before terminating; an empty-write callback
  // is not a flush barrier in Bun. A failed drain must reject, not report success.
  await Promise.all(
    [process.stdout, process.stderr].map(
      (stream) =>
        new Promise<void>((resolve, reject) => {
          stream.end((error?: Error | null) => (error ? reject(error) : resolve()))
        }),
    ),
  )
  process.exit(exitCode)
}
