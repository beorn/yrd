import { createHash } from "node:crypto"
import type { YrdStepConfig } from "./config.ts"

export type ToolchainFingerprint = Readonly<{
  bun: string
  node: string
  platform: string
  arch: string
}>

export type QueueStepRevisionInput = Readonly<{
  repo: string
  stateDir: string
  name: string
  config: YrdStepConfig
  timeoutMs: number
  noProgressMs: number
  toolchain: ToolchainFingerprint
  checkoutParent?: string
  resolvedCommand?: readonly string[]
}>

/** Internal identity seam for configured queue steps; intentionally not exported by the package root. */
export function queueStepRevision(input: QueueStepRevisionInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        implementation:
          input.name === "merge" && input.resolvedCommand === undefined
            ? "yrd-native-merge-v3"
            : input.checkoutParent === undefined
              ? "yrd-queue-command-v3"
              : "yrd-queue-command-v4",
        repo: input.repo,
        stateDir: input.stateDir,
        ...(input.checkoutParent === undefined ? {} : { checkoutParent: input.checkoutParent }),
        name: input.name,
        run: input.config.run,
        resolvedCommand: input.resolvedCommand,
        runner: input.config.runner,
        environment: input.config.environment,
        classification: input.config.classification ?? "carrier",
        timeoutMs: input.timeoutMs,
        noProgressMs: input.noProgressMs,
        toolchain: input.toolchain,
      }),
    )
    .digest("hex")
}
