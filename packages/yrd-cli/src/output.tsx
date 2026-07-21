import type { ReactNode } from "react"
import { Text, renderString } from "silvery"
import { actionableFailure, formatActionableFailure, type ActionableFailure } from "./actionable-error.ts"
import { classifyFailure, stableJson, unrecognizedKeyFailure } from "./invocation.ts"
import type { YrdCliIO } from "./types.ts"
import { formatYrdRuntimeVersion } from "./version.ts"

export type HumanOutput = ReactNode

async function rendered(io: YrdCliIO, output: HumanOutput): Promise<string> {
  const text = await renderString(typeof output === "string" ? <Text>{output}</Text> : <>{output}</>, {
    width: Math.min(io.columns ?? 120, 120),
    height: 10_000,
    plain: io.color !== true,
  })
  return text.endsWith("\n") ? text : `${text}\n`
}

export async function printHuman(io: YrdCliIO, output: HumanOutput): Promise<void> {
  io.stdout(await rendered(io, output))
}

export async function printResult(io: YrdCliIO, json: boolean, value: unknown, human: HumanOutput): Promise<void> {
  if (json) {
    io.stdout(stableJson(value))
    return
  }
  await printHuman(io, human)
}

/** Like {@link printResult}, but carries advisory warnings alongside the result.
 * In JSON mode they become a `warnings` array on the value (never printed to
 * stdout, which would corrupt the JSON stream); in human mode each warning is
 * one stderr message after the rendered output. No warnings means byte-identical
 * output to {@link printResult}. */
export async function printResultWithWarnings(
  io: YrdCliIO,
  json: boolean,
  value: Record<string, unknown>,
  human: HumanOutput,
  warnings: readonly string[],
): Promise<void> {
  if (json) {
    io.stdout(stableJson(warnings.length === 0 ? value : { ...value, warnings }))
    return
  }
  await printHuman(io, human)
  for (const warning of warnings) io.stderr(warning.endsWith("\n") ? warning : `${warning}\n`)
}

export type DiagnosticOptions = Readonly<{ verbose?: boolean }>

export async function diagnostic(
  io: YrdCliIO,
  program: string,
  error: unknown,
  options: DiagnosticOptions = {},
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  const detail = message.replace(/^yrd:\s*/u, "")
  const skew = unrecognizedKeyFailure(error)
  const failure: ActionableFailure =
    skew === undefined
      ? actionableFailure(classifyFailure(error).failure)
      : {
          code: "journal-version-skew",
          cause:
            `This Yrd cannot read the repository journal because rows contain newer fields ` +
            `(${skew.keys.join(", ")}); refusing a stale or partial view with ${formatYrdRuntimeVersion()}.`,
          resolution: [
            "Run yrd from the checkout this repository pins (for example, its vendored copy in a current-main worktree).",
            "Update this checkout, then retry the same Yrd command.",
            ...(options.verbose === true ? [] : ["Re-run with -v to include the raw validation detail."]),
          ],
        }
  const renderedFailure = formatActionableFailure(failure, `${program}: `)
  const verboseDetail = skew !== undefined && options.verbose === true ? `\ndetail: ${detail}` : ""
  io.stderr(await rendered(io, <Text color="$fg-error">{`${renderedFailure}${verboseDetail}`}</Text>))
}
