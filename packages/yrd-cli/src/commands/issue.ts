import { ensureIssueDelivery, listIssues } from "../run.ts"
import type { CommandRegistrationContext } from "./context.ts"

/** Register the `yrd issue` subtree. */
export function registerIssueCommands(ctx: CommandRegistrationContext): void {
  const { program, installed, io, setExit } = ctx
  const issue = program.command("issue").description("inspect tracker-neutral issue delivery")
  issue.helpCommand(false)
  issue
    .command("_list", { isDefault: true, hidden: true })
    .option("--json", "emit stable JSON")
    .action(async (options) => listIssues(installed(), options, io))
  issue
    .command("view <issue>")
    .description("show Yrd delivery records joined to an issue")
    .option("--json", "emit stable JSON")
    .action(async (issueId, options) => listIssues(installed(), options, io, issueId))
  issue
    .command("ensure <issue>")
    .description("ensure one issue-owned Bay and one tracked draft change")
    .option("--json", "emit stable JSON")
    .action(async (issueId, options) => setExit(await ensureIssueDelivery(installed(), issueId, options, io)))
}
