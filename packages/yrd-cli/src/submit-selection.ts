import { raiseFailure } from "@yrd/core"
import type { Process } from "@yrd/process"
import type { Invocation } from "./invocation.ts"

type SubmitSelectionOptions = Readonly<{
  worktree: string
  process: Pick<Process, "run">
  env: NodeJS.ProcessEnv
}>

function submitArguments(invocation: Invocation): readonly string[] | undefined {
  if (invocation.projection === "bay") {
    return invocation.args[0] === "submit" ? invocation.args.slice(1) : undefined
  }
  return (invocation.args[0] === "bay" || invocation.args[0] === "pr") && invocation.args[1] === "submit"
    ? invocation.args.slice(2)
    : undefined
}

function hasSelector(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === undefined) continue
    if (argument === "--") return index + 1 < args.length
    if (argument === "--base" || argument === "--queue" || argument === "--issue" || argument === "--composition") {
      index += 1
      continue
    }
    if (
      argument === "--json" ||
      argument.startsWith("--base=") ||
      argument.startsWith("--queue=") ||
      argument.startsWith("--issue=") ||
      argument.startsWith("--composition=") ||
      argument.startsWith("-")
    ) {
      continue
    }
    return true
  }
  return false
}

function withSelector(invocation: Invocation, selector: string): string[] {
  const args = [...invocation.args]
  args.splice(invocation.projection === "bay" ? 1 : 2, 0, selector)
  if (invocation.name === "git bay") return ["git", "bay", ...args]
  if (invocation.name === "git yrd") return ["git", "yrd", ...args]
  return ["yrd", ...args]
}

export async function resolveSubmitArgv(
  invocation: Invocation,
  options: SubmitSelectionOptions,
): Promise<readonly string[] | undefined> {
  const args = submitArguments(invocation)
  if (args === undefined || hasSelector(args)) return undefined

  const result = await options.process.run({
    argv: ["git", "-C", options.worktree, "branch", "--show-current"],
    cwd: options.worktree,
    env: options.env,
  })
  const branch = result.exitCode === 0 ? result.stdout.trim() : ""
  if (branch === "") {
    raiseFailure("refusal", "bay-submit-branch-missing", "yrd: no current Git branch; pass a bay or branch selector")
  }
  return withSelector(invocation, branch)
}
