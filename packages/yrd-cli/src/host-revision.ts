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
  /** Object shas (blob or tree) of the step's declared gate scripts at the ref
   * the derivation reads its config from (23183). Folding them in makes a
   * gate-script edit a REVISION change: the run record carries which script
   * version judged it, the plan audit's revision comparison surfaces the edit,
   * and a moved-base re-derivation picks the new script up like any other
   * config change. Absent (no `scripts:` declared) keeps the prior identity —
   * JSON.stringify drops undefined keys. */
  scripts?: Readonly<Record<string, string>>
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

/**
 * Launcher-independent toolchain identity for revision fingerprints (22374,
 * the same class as 22334 above).
 *
 * `bun` and `node` report whichever binary happened to invoke this process, so
 * a host with two bun installs — an operator shell's and a supervisor's frozen
 * PATH — computed two permanent revision families for byte-identical config.
 * The resident and every operator then overwrote each other's installed
 * baseline on every drain, and the failure surfaced as `config-drift`: a
 * message naming the config, which had never changed.
 *
 * `platform` and `arch` stay in the hash. They decide which binaries a step's
 * commands actually resolve to, and they cannot differ between two shells on
 * one host — so they carry identity without carrying the accident.
 */
function stableToolchain(toolchain: ToolchainFingerprint): Pick<ToolchainFingerprint, "platform" | "arch"> {
  return { platform: toolchain.platform, arch: toolchain.arch }
}

/** Internal identity seam for configured queue steps; intentionally not exported by the package root. */
export function queueStepRevision(input: QueueStepRevisionInput): string {
  const nativeMerge = input.name === "merge" && input.resolvedCommand === undefined
  return createHash("sha256")
    .update(
      JSON.stringify({
        implementation: nativeMerge
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
        toolchain: stableToolchain(input.toolchain),
        scripts: input.scripts,
      }),
    )
    .digest("hex")
}
