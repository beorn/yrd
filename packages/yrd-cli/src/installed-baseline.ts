import { readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import * as z from "zod"
import { raiseFailure } from "@yrd/core"
import { createExclusive } from "@yrd/persistence"
import { ReplayInstalledStepSchema, type InstalledStep, type QueueAuditFinding } from "@yrd/queue"

/** The installed baseline: the queue installation baseline written by `yrd queue
 * init` (provision). It pins the check-definition revisions the operator
 * installed so `yrd queue audit` can detect that the selected current
 * repository config drifted before any expensive Run starts. */
const InstalledBaselineSchema = z
  .object({
    base: z.string().trim().min(1),
    baseSha: z.string().regex(/^[0-9a-f]{40}$/u),
    installedAt: z.iso.datetime({ offset: true }),
    steps: z.array(ReplayInstalledStepSchema).min(1),
  })
  .strict()

const InstalledBaselineFileSchema = z
  .object({
    version: z.literal(1),
    baselines: z.record(z.string(), InstalledBaselineSchema),
  })
  .strict()

export type InstalledBaseline = Readonly<{
  base: string
  baseSha: string
  installedAt: string
  steps: readonly InstalledStep[]
}>

export function installedBaselinePath(stateDir: string): string {
  return join(stateDir, "installed-baseline.json")
}

export async function readInstalledBaselines(stateDir: string): Promise<Readonly<Record<string, InstalledBaseline>>> {
  const path = installedBaselinePath(stateDir)
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    raiseFailure("infrastructure", "installed-baseline-invalid", `yrd: installed baseline at ${path} is not JSON`)
  }
  const result = InstalledBaselineFileSchema.safeParse(parsed)
  if (!result.success) {
    raiseFailure(
      "infrastructure",
      "installed-baseline-invalid",
      `yrd: installed baseline at ${path} is malformed: ${result.error.message}`,
    )
  }
  return result.data.baselines
}

/** Minimal filesystem seam for the atomic replace. Explicit DI so a test can
 * inject a staging-write or rename failure and prove the prior authority file is
 * left byte-identical + parseable and no temp residue survives. Defaults to
 * node:fs/promises. */
type BaselineFsOps = Readonly<{
  writeFile?: (path: string, data: string, encoding: "utf8") => Promise<void>
  rename?: (from: string, to: string) => Promise<void>
}>

/** Per-write uniquifier for the temp file name so an atomic replace never
 * clobbers a sibling write's staging file. */
let baselineTempSequence = 0

/** Serialize every read-modify-write of the installed baseline authority behind
 * one exclusive writer lock so concurrent provision/deprovision on different
 * bases cannot lose either update. The lock is cross-process (POSIX flock) and
 * intra-process (shared held-set), scoped to its own directory under stateDir. */
function withBaselineWriteLock<Result>(stateDir: string, operation: () => Promise<Result>): Promise<Result> {
  return createExclusive(join(stateDir, "installed-baseline.lock"), { timeoutMs: 30_000 }).run(operation)
}

/** Publish the whole baseline authority through a unique temp file + rename so a
 * partially written or interrupted write can never corrupt the live file. On any
 * failure the temp file is removed in `finally`, so the authority is untouched
 * (rename never ran) and no `.tmp` residue survives. */
async function replaceBaselineFile(
  stateDir: string,
  baselines: Record<string, InstalledBaseline>,
  fs: BaselineFsOps = {},
): Promise<void> {
  const writeFileOp = fs.writeFile ?? writeFile
  const renameOp = fs.rename ?? rename
  const path = installedBaselinePath(stateDir)
  const file = InstalledBaselineFileSchema.parse({ version: 1, baselines })
  const temporary = `${path}.${process.pid}.${baselineTempSequence++}.tmp`
  try {
    await writeFileOp(temporary, `${JSON.stringify(file, undefined, 2)}\n`, "utf8")
    await renameOp(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function writeInstalledBaseline(
  stateDir: string,
  baseline: InstalledBaseline,
  fs: BaselineFsOps = {},
): Promise<void> {
  await withBaselineWriteLock(stateDir, async () => {
    const baselines = await readInstalledBaselines(stateDir)
    await replaceBaselineFile(stateDir, { ...baselines, [baseline.base]: baseline }, fs)
  })
}

export async function removeInstalledBaseline(
  stateDir: string,
  base: string,
  fs: BaselineFsOps = {},
): Promise<boolean> {
  return withBaselineWriteLock(stateDir, async () => {
    const baselines = await readInstalledBaselines(stateDir)
    if (baselines[base] === undefined) return false
    const rest = Object.fromEntries(Object.entries(baselines).filter(([key]) => key !== base))
    if (Object.keys(rest).length === 0) {
      await rm(installedBaselinePath(stateDir), { force: true })
    } else {
      await replaceBaselineFile(stateDir, rest, fs)
    }
    return true
  })
}

export function installedBaselineRemedy(base: string): string {
  return `Run 'yrd queue deinit ${base}' then 'yrd queue init ${base}' to migrate the installed baseline before starting runs.`
}

/** Abbreviate long hash-shaped revisions for the operator message; leave
 * short human-readable revisions (test fixtures, tags) intact. */
const shortRevision = (revision: string): string =>
  /^[0-9a-f]{16,}$/iu.test(revision) ? revision.slice(0, 8) : revision

/** Vocabulary for the live side of a step-plan comparison: the same delta
 * engine proves both audit legs, but each leg must NAME its live side so the
 * operator can tell WHICH leg diverged (merge-queue R41b). */
type StepPlanVocabulary = Readonly<{ live: string; missingLive: string }>
const CONFIG_VOCABULARY: StepPlanVocabulary = { live: "current", missingLive: "is no longer configured" }
const RUNTIME_VOCABULARY: StepPlanVocabulary = {
  live: "runtime",
  missingLive: "is not installed in this running process",
}

function stepPlanDeltas(
  baseline: InstalledBaseline,
  live: readonly InstalledStep[],
  vocabulary: StepPlanVocabulary,
): string[] {
  const liveByName = new Map(live.map((step) => [step.name, step] as const))
  const deltas: string[] = []
  for (const installed of baseline.steps) {
    const liveStep = liveByName.get(installed.name)
    if (liveStep === undefined) {
      deltas.push(
        `step '${installed.name}' (installed revision '${shortRevision(installed.revision)}') ${vocabulary.missingLive}`,
      )
      continue
    }
    if (liveStep.revision !== installed.revision) {
      deltas.push(
        `step '${installed.name}' revision '${shortRevision(installed.revision)}' installed, ${vocabulary.live} '${shortRevision(liveStep.revision)}'`,
      )
    } else if (liveStep.kind !== installed.kind || liveStep.classification !== installed.classification) {
      deltas.push(`step '${installed.name}' integration contract changed`)
    }
  }
  const installedNames = new Set(baseline.steps.map((step) => step.name))
  for (const liveStep of live) {
    if (!installedNames.has(liveStep.name)) {
      deltas.push(
        `step '${liveStep.name}' (${vocabulary.live} revision '${shortRevision(liveStep.revision)}') is not in the installed baseline`,
      )
    }
  }
  // Step revisions intentionally exclude sequence, so a pure reorder of the same
  // steps leaves every per-step delta empty. Compare the ORDERED plan (restricted
  // to steps present on both sides) so a reorder is still caught as drift.
  const installedSequence = baseline.steps.map((step) => step.name).filter((name) => liveByName.has(name))
  const liveSequence = live.map((step) => step.name).filter((name) => installedNames.has(name))
  if (installedSequence.length > 0 && installedSequence.join(">") !== liveSequence.join(">")) {
    deltas.push(
      `step order changed: installed ${installedSequence.join("→")}, ${vocabulary.live} ${liveSequence.join("→")}`,
    )
  }
  return deltas
}

/** Compare the persisted installed baseline against the selected current
 * config-derived steps. Any delta collapses into ONE actionable finding so the
 * operator gets exactly one deinit/init migration remedy per base. */
export function installedBaselineDrift(
  baseline: InstalledBaseline,
  current: readonly InstalledStep[],
): QueueAuditFinding | undefined {
  const deltas = stepPlanDeltas(baseline, current, CONFIG_VOCABULARY)
  if (deltas.length === 0) return undefined
  return {
    code: "config-drift",
    message: `queue base '${baseline.base}' installed baseline is stale: ${deltas.join("; ")}. ${installedBaselineRemedy(baseline.base)}`,
  }
}

/** Compare the persisted installed baseline against the RUNTIME's actually
 * installed steps — the third audit leg (merge-queue R41b). A resident built
 * before a deinit/init migration keeps executing its construction-time steps,
 * so baseline == disk alone would certify a lie; the remedy is restarting the
 * process, not another baseline migration. */
export function runtimeBaselineDrift(
  baseline: InstalledBaseline,
  runtime: readonly InstalledStep[],
): QueueAuditFinding | undefined {
  const deltas = stepPlanDeltas(baseline, runtime, RUNTIME_VOCABULARY)
  if (deltas.length === 0) return undefined
  return {
    code: "runtime-drift",
    message: `queue base '${baseline.base}' resident runtime diverges from the installed baseline: ${deltas.join("; ")}. Restart this queue runner process so it loads the installed baseline before starting runs.`,
  }
}
