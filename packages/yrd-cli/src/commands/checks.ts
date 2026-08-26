import { checkRequired, guardRequired } from "../run.ts"
import type { CommandRegistrationContext } from "./context.ts"

/** Register the working-tree verification verbs: `check` and `guard`. */
export function registerCheckCommands(ctx: CommandRegistrationContext): void {
  const { program, installedServices, io } = ctx
  program
    .command("check <name...>")
    .description("run configured required checks in the current working tree")
    .option("--json", "emit stable JSON")
    .action(async (names, options) => checkRequired(installedServices(), names, options, io))

  program
    .command("guard [name...]")
    .description("run configured pre-submit guards against the current head; omit names for all")
    .option("--json", "emit stable JSON")
    .action(async (names, options) => guardRequired(installedServices(), names, options, io))
}
