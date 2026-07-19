export type FailureLike = Readonly<{ code: string; message: string }>

/** Human-facing failure contract. Journal/domain facts deliberately remain the
 * minimal `{code,message}` pair; this projection enriches old and new records
 * uniformly at the presentation boundary. */
export type ActionableFailure = Readonly<{
  code: string
  cause: string
  resolution: readonly string[]
  reference?: string
}>

const GENERIC_RESOLUTION = "Correct the cause above, then retry the same Yrd command."

function oneLineCause(message: string): string {
  const normalized = message
    .replace(/^yrd:\s*/iu, "")
    .replace(/\s+/gu, " ")
    .trim()
  const [withoutRemedy = normalized] = normalized.split(/\s+(?=Run\s+['"`]yrd\s)/u, 1)
  const [cause = withoutRemedy] = withoutRemedy.split(/\s+hint:\s*/iu, 1)
  return cause.replace(/[.;:\s]+$/u, "") || "Yrd could not complete the request"
}

function embeddedYrdCommands(message: string): string[] {
  const commands: string[] = []
  for (const match of message.matchAll(/['"`](yrd\s+[^'"`]+)['"`]/giu)) {
    const command = match[1]?.trim()
    if (command !== undefined && !commands.includes(command)) commands.push(command)
  }
  return commands
}

function quotedValue(message: string, pattern: RegExp): string | undefined {
  return pattern.exec(message)?.[1]
}

function prId(message: string): string | undefined {
  return quotedValue(message, /\bPR\s+'([^']+)'/iu)
}

function authoredGitlinkFailure(failure: FailureLike, cause: string): ActionableFailure {
  const pr = prId(failure.message) ?? "<PR>"
  return Object.freeze({
    code: failure.code,
    cause,
    resolution: Object.freeze(["yrd pr submit <branch> --draft", `yrd pr recut ${pr} --queue --force`]),
    reference: "README.md#pr-eligibility-and-checks",
  })
}

function recutGitlinkFailure(failure: FailureLike, cause: string): ActionableFailure | undefined {
  const pr = prId(failure.message)
  const path = quotedValue(failure.message, /pins\s+submodule\s+'([^']+)'\s+to/iu)
  const basePin = quotedValue(
    failure.message,
    /target\s+root\s+'[^']+'\s+pins\s+submodule\s+'[^']+'\s+to\s+'([^']+)'/iu,
  )
  const authoredPin = quotedValue(
    failure.message,
    /replayed\s+authored\s+root\s+'[^']+'\s+pins\s+(?:it|submodule\s+'[^']+')\s+to\s+'([^']+)'/iu,
  )
  if (pr === undefined || path === undefined || basePin === undefined || authoredPin === undefined) return undefined
  return Object.freeze({
    code: failure.code,
    cause,
    resolution: Object.freeze([
      `git -C ${path} fetch --all --prune`,
      `git -C ${path} switch -c yrd/compose-${pr} ${authoredPin}`,
      `git -C ${path} merge ${basePin}`,
      `git -C ${path} push -u origin HEAD`,
      `git add ${path} && git commit -m "fix(yrd): compose ${path} pins"`,
      "yrd pr submit <branch> --draft",
      `yrd pr recut ${pr} --queue --force`,
    ]),
    reference: "README.md#resolving-divergent-gitlink-pins",
  })
}

export function actionableFailure(failure: FailureLike): ActionableFailure {
  const cause = oneLineCause(failure.message)
  if (failure.code === "authored-gitlink") return authoredGitlinkFailure(failure, cause)
  if (failure.code === "recut-gitlink-conflict") {
    const projected = recutGitlinkFailure(failure, cause)
    if (projected !== undefined) return projected
  }
  const commands = embeddedYrdCommands(failure.message)
  return Object.freeze({
    code: failure.code,
    cause,
    resolution: Object.freeze(commands.length === 0 ? [GENERIC_RESOLUTION] : commands),
  })
}

export function errorCodeLabel(code: string): string {
  return `err=${code}`
}

export function actionableFailureSummary(failure: ActionableFailure): string {
  return `${errorCodeLabel(failure.code)} — ${failure.cause}`
}

export function formatActionableFailure(failure: ActionableFailure, prefix = ""): string {
  return [
    `${prefix}${errorCodeLabel(failure.code)}`,
    `cause: ${failure.cause}`,
    ...failure.resolution.map((step) => `resolve: ${step}`),
    ...(failure.reference === undefined ? [] : [`reference: ${failure.reference}`]),
  ].join("\n")
}
