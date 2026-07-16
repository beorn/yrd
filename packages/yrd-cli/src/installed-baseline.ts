import { readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import * as z from "zod"
import { raiseFailure } from "@yrd/core"
import { InstalledStepSchema, type InstalledStep, type QueueAuditFinding } from "@yrd/queue"

/** The installed baseline: the queue installation baseline written by `yrd queue
 * init` (provision). It pins the check-definition revisions the operator
 * installed so `yrd queue audit` can detect that the selected current
 * repository config drifted before any expensive Run starts. */
const InstalledBaselineSchema = z
  .object({
    base: z.string().trim().min(1),
    baseSha: z.string().regex(/^[0-9a-f]{40}$/u),
    installedAt: z.iso.datetime({ offset: true }),
    steps: z.array(InstalledStepSchema).min(1),
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

export async function writeInstalledBaseline(stateDir: string, baseline: InstalledBaseline): Promise<void> {
  const baselines = await readInstalledBaselines(stateDir)
  const file = InstalledBaselineFileSchema.parse({ version: 1, baselines: { ...baselines, [baseline.base]: baseline } })
  await writeFile(installedBaselinePath(stateDir), `${JSON.stringify(file, undefined, 2)}\n`, "utf8")
}

export async function removeInstalledBaseline(stateDir: string, base: string): Promise<boolean> {
  const baselines = await readInstalledBaselines(stateDir)
  if (baselines[base] === undefined) return false
  const rest = Object.fromEntries(Object.entries(baselines).filter(([key]) => key !== base))
  if (Object.keys(rest).length === 0) {
    await rm(installedBaselinePath(stateDir), { force: true })
    return true
  }
  await writeFile(
    installedBaselinePath(stateDir),
    `${JSON.stringify({ version: 1, baselines: rest }, undefined, 2)}\n`,
    "utf8",
  )
  return true
}

export function installedBaselineRemedy(base: string): string {
  return `Run 'yrd queue deinit ${base}' then 'yrd queue init ${base}' to migrate the installed baseline before starting runs.`
}

/** Abbreviate long hash-shaped revisions for the operator message; leave
 * short human-readable revisions (test fixtures, tags) intact. */
const shortRevision = (revision: string): string =>
  /^[0-9a-f]{16,}$/iu.test(revision) ? revision.slice(0, 8) : revision

/** Compare the persisted installed baseline against the selected current
 * config-derived steps. Any delta collapses into ONE actionable finding so the
 * operator gets exactly one deinit/init migration remedy per base. */
export function installedBaselineDrift(
  baseline: InstalledBaseline,
  current: readonly InstalledStep[],
): QueueAuditFinding | undefined {
  const currentByName = new Map(current.map((step) => [step.name, step] as const))
  const deltas: string[] = []
  for (const installed of baseline.steps) {
    const live = currentByName.get(installed.name)
    if (live === undefined) {
      deltas.push(`step '${installed.name}' (installed revision '${shortRevision(installed.revision)}') is no longer configured`)
      continue
    }
    if (live.revision !== installed.revision) {
      deltas.push(
        `step '${installed.name}' revision '${shortRevision(installed.revision)}' installed, current '${shortRevision(live.revision)}'`,
      )
    } else if (
      live.integrates !== installed.integrates ||
      live.needsIntegration !== installed.needsIntegration ||
      live.classification !== installed.classification
    ) {
      deltas.push(`step '${installed.name}' integration contract changed`)
    }
  }
  const installedNames = new Set(baseline.steps.map((step) => step.name))
  for (const live of current) {
    if (!installedNames.has(live.name)) {
      deltas.push(`step '${live.name}' (current revision '${shortRevision(live.revision)}') is not in the installed baseline`)
    }
  }
  if (deltas.length === 0) return undefined
  return {
    code: "config-drift",
    message: `queue base '${baseline.base}' installed baseline is stale: ${deltas.join("; ")}. ${installedBaselineRemedy(baseline.base)}`,
  }
}
