import { usage } from "../invocation.ts"
import { prunePrs } from "../pr-withdraw.ts"
import {
  adminPruneCandidateRefs,
  bayPruneCommand,
  bumpJournal,
  initSubmoduleTracking,
  initYrdConfig,
  journalImportOrphan,
  refuseRetiredQueueAdministration,
} from "../run.ts"
import type { CommandRegistrationContext } from "./context.ts"

/** Register the `yrd admin` subtree. */
export function registerAdminCommands(ctx: CommandRegistrationContext): void {
  const { program, installed, installedServices, io, setExit } = ctx
  const admin = program.command("admin").description("perform infrequent repository and state administration")
  admin.helpCommand(false)
  admin
    .command("init")
    .description("scaffold .yrd.yml and install the managed pre-submit hook")
    .option("--json", "emit stable JSON")
    .action(async (options) => initYrdConfig(installedServices(), options, io))
  // Retired verbs stay registered so an operator following an old runbook
  // gets the reason and the replacement, not "unknown command".
  const adminQueue = admin.command("queue", { hidden: true }).description("retired queue administration")
  adminQueue
    .command("init [base]", { hidden: true })
    .description("retired: refuses and names why")
    .option("--json", "emit stable JSON")
    .action(() => refuseRetiredQueueAdministration("init"))
  adminQueue
    .command("deinit [base]", { hidden: true })
    .description("retired: refuses and names why")
    .option("--json", "emit stable JSON")
    .action(() => refuseRetiredQueueAdministration("deinit"))
  const adminBay = admin.command("bay").description("administer work bays")
  adminBay
    .command("prune")
    .description("census prunable bays and write an approval, or apply one exact approved set")
    .option("--apply", "close the exact set in --approval")
    .option("--approval <path>", "approval artifact to verify and apply")
    .option("--save-approval <path>", "write the dry-run census as a new approval artifact")
    .option(
      "--exclude <bay>",
      "exclude a bay from the dry-run approval (repeatable)",
      (value: string, previous: readonly string[]) => [...previous, value],
      [] as readonly string[],
    )
    .option("--json", "emit stable JSON")
    .action(async (options) => setExit(await bayPruneCommand(installed(), installedServices(), options, io)))
  const adminPr = admin.command("pr").description("administer changes")
  adminPr
    .command("prune")
    .description("withdraw live PRs whose content their base branch already contains")
    .option("--dry-run", "print every checked verdict without withdrawing")
    .option("--json", "emit stable JSON")
    .action(async (options) => prunePrs(installed(), options, io))
  const adminCandidateRefs = admin.command("candidate-refs").description("administer synthetic Candidate refs")
  adminCandidateRefs
    .command("prune")
    .description("sweep the Candidate ref namespace and delete the refs this same pass proved reclaimable")
    .option("--retention-days <days>", "override the retention window (default 7)")
    .option("--json", "emit stable JSON")
    .action(async (options) => setExit(await adminPruneCandidateRefs(installed(), options, io)))
  const adminJournal = admin.command("journal").description("administer the durable journal")
  adminJournal
    .command("bump <version>")
    .description("one-way raise the journal version floor after a tested snapshot restore")
    .option("--json", "emit stable JSON")
    .action(async (version, options) => {
      const parsed = Number(version)
      if (!Number.isSafeInteger(parsed) || parsed < 1) usage("journal bump version must be a positive integer")
      await bumpJournal(installedServices(), parsed, options, io)
    })
  adminJournal
    .command("import-orphan <source>")
    .description("archive preserved v3 rows without replaying them as live entries")
    .option("--json", "emit stable JSON")
    .action(async (source, options) => journalImportOrphan(installedServices(), source, options, io))
  const adminSubmodule = admin.command("submodule").description("administer submodule tracking")
  adminSubmodule
    .command("init")
    .description("set submodule.<name>.branch for submodules not yet tracking one")
    .option("--dry-run", "print what would be set without writing .gitmodules")
    .option("--json", "emit stable JSON")
    .action(async (options) => setExit(await initSubmoduleTracking(options, io)))
}
