import type { ReactNode } from "react"
import { Text, renderString } from "silvery"
import { stableJson, unrecognizedKeyFailure } from "./invocation.ts"
import type { YrdCliIO } from "./types.ts"
import { formatYrdRuntimeVersion } from "./version.ts"

export type HumanOutput = ReactNode
export type HumanRenderOptions = Readonly<{ height?: number }>

async function rendered(io: YrdCliIO, output: HumanOutput, options: HumanRenderOptions = {}): Promise<string> {
  const text = await renderString(typeof output === "string" ? <Text>{output}</Text> : <>{output}</>, {
    width: Math.min(io.columns ?? 120, 120),
    height: options.height ?? 10_000,
    plain: io.color !== true,
  })
  return text.endsWith("\n") ? text : `${text}\n`
}

export async function printHuman(io: YrdCliIO, output: HumanOutput, options: HumanRenderOptions = {}): Promise<void> {
  io.stdout(await rendered(io, output, options))
}

export async function printResult(
  io: YrdCliIO,
  json: boolean,
  value: unknown,
  human: HumanOutput,
  options: HumanRenderOptions = {},
): Promise<void> {
  if (json) {
    io.stdout(stableJson(value))
    return
  }
  await printHuman(io, human, options)
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
  if (skew === undefined) {
    io.stderr(await rendered(io, <Text color="$fg-error">{`${program}: ${detail}`}</Text>))
    return
  }
  const guidance =
    `${program}: cannot read this repository's Yrd journal: rows carry fields this build does not recognize ` +
    `(${skew.keys.join(", ")}). The journal was likely written by a newer yrd than the one running ` +
    `(${formatYrdRuntimeVersion()}); refusing to render a stale or partial view. Run yrd from the checkout this ` +
    `repository pins (its vendored/submodule copy, e.g. a current-main worktree), or update this checkout, then ` +
    `retry.${options.verbose === true ? `\n${detail}` : " Re-run with -v for the raw validation detail."}`
  io.stderr(await rendered(io, <Text color="$fg-error">{guidance}</Text>))
}
