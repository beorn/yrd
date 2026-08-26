import { usage } from "../invocation.ts"
import {
  applyChangeSelectionVerb,
  bayInOperands,
  bayRunOperands,
  bayStatusCommand,
  cancelQueueRun,
  certifyBayHandoff,
  closeBays,
  defaultRunArgv,
  enterBay,
  listBays,
  NO_TRACK_OPTION_DESCRIPTION,
  openPersistentBay,
  pathBay,
  refreshBays,
  runBaySession,
  RuntimeChildArgv,
  TRACK_OPTION_DESCRIPTION,
  type RuntimeInvocationIO,
} from "../run.ts"
import type { CommandRegistrationContext } from "./context.ts"

/** Register the `yrd bay` subtree. */
export function registerBayCommands(ctx: CommandRegistrationContext): void {
  const { program, installed, installedServices, io, setExit } = ctx
  const bay = program
    .command("bay")
    .description("manage work bays — a Git worktree plus a lease, an issue, and a managed lifecycle")
  bay.helpCommand(false)
  bay
    .command("_list", { isDefault: true, hidden: true })
    .option("--json", "emit stable JSON")
    .option("--all", "include open and terminal Bays")
    .option("--closed", "show terminal Bays only")
    .option("--check", "compute live destroy-safety status (fetches origin; may be slow)")
    .action(async (options) => listBays(installed(), options, io))
  bay
    .command("list")
    .description("list work bays")
    .option("--json", "emit stable JSON")
    .option("--all", "include open and terminal Bays")
    .option("--closed", "show terminal Bays only")
    .option("--check", "compute live destroy-safety status (fetches origin; may be slow)")
    .action(async (options) => listBays(installed(), options, io))
  bay
    .command("open")
    .argument("[config]", "issue to link; omit for an anonymous Bay")
    .description("open and keep a Bay")
    .option("--issue <ref>", "link an issue without a positional")
    .option("--pr <selector>", "continue an existing PR without creating or submitting a revision")
    .option("--bay <name>", "choose an issue-less or issue-linked Bay identity")
    .action(async (config, options) => {
      if ((io as RuntimeInvocationIO)[RuntimeChildArgv] !== undefined) {
        usage("bay open does not run commands; use 'yrd bay run <config> -- <command>'")
      }
      setExit(await openPersistentBay(installed(), installedServices(), config, options, io))
    })
  bay
    .command("run [config] [command...]")
    .description("run one scoped command (defaults to $SHELL)")
    .option("--issue <ref>", "link an issue without a positional")
    .option("--pr <selector>", "continue an existing PR without creating or submitting a revision")
    .option("--bay <name>", "choose an issue-less or issue-linked Bay identity")
    .option("--keep", "leave a successful run open")
    .action(async (config, command, options) => {
      const request = bayRunOperands(config, command, io)
      setExit(
        await runBaySession(installed(), installedServices(), request.arg, request.argv, options, io, {
          keep: options.keep,
        }),
      )
    })
  bay
    .command("in [bay] [command...]")
    .description("join an open Bay as a guest; defaults to $SHELL, or pass opaque argv after --")
    .action(async (selector, command) => {
      const request = bayInOperands(selector, command, io)
      setExit(await enterBay(installed(), installedServices(), request.selector, request.argv, io))
    })
  bay
    .command("path <selector>")
    .description("print an active bay path")
    .option("--json", "emit stable JSON")
    .action((selector, options) => pathBay(installed(), selector, options, io))
  bay
    .command("refresh [selector...]")
    .description("refresh work bays")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => refreshBays(installed(), selectors, options, io))
  bay
    .command("handoff <selector>")
    .description("certify a materialized exact-head handoff")
    .requiredOption("--branch <branch>", "exact branch recorded in the handoff packet")
    .requiredOption("--head <sha>", "exact head recorded in the handoff packet")
    .requiredOption("--evidence <ref>", "opaque materialized handoff reference")
    .option("--check", "resolve and validate the bay without certifying (read-only preflight)")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) =>
      certifyBayHandoff(
        installed(),
        selector,
        options as Readonly<{ branch: string; head: string; evidence: string; check?: boolean; json?: boolean }>,
        io,
      ),
    )
  bay
    .command("submit [selector...]")
    .description("submit bays or branches")
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
    .option("--composition <path>", "immutable version-1 source composition JSON")
    .option("--track", TRACK_OPTION_DESCRIPTION)
    .option("--no-track", NO_TRACK_OPTION_DESCRIPTION)
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) =>
      setExit(await applyChangeSelectionVerb(installed(), installedServices(), selectors, options, io, "bay.submit")),
    )
  bay
    .command("close [selector...]")
    .description("close work bays (checks bay status first; needs --force to override)")
    .option("--withdraw", "withdraw a live change before closing")
    .option("--force", "bypass bay status (requires explicit bay name; prints what is destroyed)")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => {
      await closeBays(installed(), installedServices(), selectors, options, io)
    })
  bay
    .command("status [selector...]")
    .description("safety oracle: is this bay safe to remove? (exit 0=safe 1=not-safe 2=unknown)")
    .option("--json", "emit stable JSON")
    .action(async (selectors, options) => setExit(await bayStatusCommand(installed(), selectors, options, io)))
}

/** Register the root-level Bay conveniences: `in`, `sh`, and `run cancel`. */
export function registerRootBayCommands(ctx: CommandRegistrationContext): void {
  const { program, installed, installedServices, io, setExit } = ctx
  program
    .command("in [bay] [command...]")
    .description("join an open Bay as a guest; defaults to $SHELL, or pass opaque argv after --")
    .action(async (bay, command) => {
      const request = bayInOperands(bay, command, io)
      setExit(await enterBay(installed(), installedServices(), request.selector, request.argv, io))
    })
  program
    .command("sh [config]")
    .description("run $SHELL in a scoped Bay")
    .option("--issue <ref>", "link an issue without a positional")
    .option("--pr <selector>", "continue an existing PR without creating or submitting a revision")
    .option("--bay <name>", "choose an issue-less or issue-linked Bay identity")
    .option("--keep", "leave a successful run open")
    .action(async (config, options) =>
      setExit(
        await runBaySession(
          installed(),
          installedServices(),
          config,
          defaultRunArgv(installedServices()),
          options,
          io,
          { keep: options.keep },
        ),
      ),
    )
  const run = program.command("run").description("act on individual queue runs")
  run.helpCommand(false)
  run
    .command("cancel <selector>")
    .description("cancel a waiting or running run; its PRs re-queue for a future drain, they are NOT rejected")
    .option("--reason <text>", "human-readable cancellation reason")
    .option("--json", "emit stable JSON")
    .action(async (selector, options) => setExit(await cancelQueueRun(installed(), selector, options, io)))
}
