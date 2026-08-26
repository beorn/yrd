import type { Command as CliCommand } from "@silvery/commander"
import { applyChangeState, changeStateDeps, type ChangeState } from "../change-state.ts"
import { currentGitBranch } from "../run.ts"
import type { CommandRegistrationContext } from "./context.ts"

/** Register the branch-state verbs: the `branch` quartet and its bare top-level spellings. */
export function registerBranchStateCommands(ctx: CommandRegistrationContext): void {
  const { program, io, installedServices, setExit } = ctx
  // The branch-state verbs. `yrd branch <state>` is the complete quartet, and
  // all four states are bare top-level verbs too.
  //
  // Root `yrd submit` IS this verb (@cto 2026-08-19, cliverbs ruling-a): it
  // used to be an alias for `yrd pr submit`, which stays untouched as the change
  // path. The two are the same user intent at two phases — the receiver
  // already dual-writes `refs/yrd/submit/<branch>` on carrier push
  // (`writeSubmitRefForCarrier`, commented "phase 2 re-points readers at this
  // ref alone") — so the everyday spelling now names the phase-2 act directly.
  // `change`/`mr`/`pr` remain one noun for the merge-request RECORD.
  const CHANGE_STATE_HELP = {
    draft: "move branches into draft — the default state, and how a submitted branch is unsubmitted",
    submit: "approve branches to merge, naming each branch's current tip as the approved commit",
    archive: "shelve branches — deletes each branch, which the receiver files under refs/yrd/archive/",
    ignore: "keep branches out of the queue's view without archiving them",
  } as const satisfies Record<ChangeState, string>

  const registerChangeStateVerb = (target: CliCommand, state: ChangeState): void => {
    const verb = target
      .command(`${state} [selector...]`)
      .description(CHANGE_STATE_HELP[state])
      .option("--dry-run", "print the resolved branches and the exact git command without pushing")
    if (state === "archive") {
      verb
        .option("-m, --message <text>", "why this branch is being archived")
        .option("-F, --file <path>", "read the message from a file, or from stdin with '-'")
    }
    type ChangeStateVerbOptions = Readonly<{ dryRun?: boolean; message?: string; file?: string }>
    verb.action(async (selectors: readonly string[], options: ChangeStateVerbOptions) =>
      setExit(
        await applyChangeState(
          state,
          selectors,
          { dryRun: options.dryRun, message: options.message, messageFile: options.file },
          io,
          changeStateDeps(io, () => currentGitBranch(io.cwd ?? process.cwd(), io), installedServices().process),
        ),
      ),
    )
  }

  const branch = program.command("branch").description("move a branch into a delivery state")
  branch.helpCommand(false)
  for (const state of ["draft", "submit", "archive", "ignore"] as const) {
    registerChangeStateVerb(branch, state)
    registerChangeStateVerb(program, state)
  }
}
