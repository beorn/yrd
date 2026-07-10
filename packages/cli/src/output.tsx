import type { ReactNode } from "react"
import { Text, renderString } from "silvery"
import { stableJson } from "./invocation.ts"
import type { YrdCliIO } from "./types.ts"

export type HumanOutput = ReactNode

async function rendered(io: YrdCliIO, output: HumanOutput): Promise<string> {
  const text = await renderString(typeof output === "string" ? <Text>{output}</Text> : <>{output}</>, {
    width: io.columns ?? 120,
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

export async function diagnostic(io: YrdCliIO, program: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  const detail = message.replace(/^yrd:\s*/u, "")
  io.stderr(await rendered(io, <Text color="$fg-error">{`${program}: ${detail}`}</Text>))
}
