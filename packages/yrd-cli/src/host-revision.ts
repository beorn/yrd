import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { stepGateMode, type YrdStepConfig } from "./config.ts"

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

/**
 * Absolute-path identity for revision fingerprints (22334).
 * Relative vs absolute repo/stateDir/baysRoot used to produce two revision
 * families that init and the run path swapped forever.
 */
function stablePath(path: string): string {
  return resolve(path)
}

/**
 * Construction-time identity for the native merge implementation.
 *
 * Native merge semantics run inside the long-lived resident. Advance this
 * generation whenever those semantics change so the three-way installed
 * baseline audit fences a resident that still has the prior implementation
 * loaded instead of letting it execute under a current-looking identity.
 */
const NATIVE_MERGE_IMPLEMENTATION_REVISION = "yrd-native-merge-v4"

/** Internal identity seam for configured queue steps; intentionally not exported by the package root. */
export function queueStepRevision(input: QueueStepRevisionInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        implementation:
          input.name === "merge" && input.resolvedCommand === undefined
            ? NATIVE_MERGE_IMPLEMENTATION_REVISION
            : input.checkoutParent === undefined
              ? "yrd-queue-command-v3"
              : "yrd-queue-command-v4",
        repo: stablePath(input.repo),
        stateDir: stablePath(input.stateDir),
        ...(input.checkoutParent === undefined ? {} : { checkoutParent: stablePath(input.checkoutParent) }),
        name: input.name,
        run: input.config.run,
        resolvedCommand: input.resolvedCommand,
        runner: input.config.runner,
        environment: input.config.environment,
        // JSON.stringify drops undefined keys, so configs without these fields
        // keep their pre-R42 revision identity.
        env: input.config.env,
        environmentPassthrough: input.config.environmentPassthrough,
        classification: input.config.classification ?? "carrier",
        comparison: input.config.comparison,
        comparisonReady: input.config.comparisonReady,
        mode: stepGateMode(input.config),
        timeoutMs: input.timeoutMs,
        noProgressMs: input.noProgressMs,
        toolchain: input.toolchain,
      }),
    )
    .digest("hex")
}
