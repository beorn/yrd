import { createHash } from "node:crypto"

const GITLINK_MODE = "160000"
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu

export type QueueConflictStage = Readonly<{
  stage: number
  mode: string
  oid: string
}>

export type QueueTreeConflict = Readonly<{
  path: string
  origin?: string
  stages: readonly QueueConflictStage[]
}>

export type QueueSubmodulePinResolution = Readonly<{
  kind: "pin"
  path: string
  sha: string
}>

export type QueueSubmoduleCommitResolution = Readonly<{
  kind: "compose"
  path: string
  origin: string
  baseSha: string
  currentSha: string
  incomingSha: string
  ref: string
  message: string
}>

export type QueueSubmoduleResolution = QueueSubmodulePinResolution | QueueSubmoduleCommitResolution

export type QueueSubmoduleCompositionPlan =
  | Readonly<{ status: "planned"; resolutions: readonly QueueSubmoduleResolution[] }>
  | Readonly<{ status: "refused"; code: "candidate-conflict"; paths: readonly string[]; message: string }>

type GitlinkStages = Readonly<{ baseSha: string; currentSha: string; incomingSha: string }>

/**
 * Turn root-merge conflict facts into deterministic queue-owned resolution
 * intent. Git execution stays at the command adapter boundary; this planner
 * only decides whether the entire conflict set is safe to hand to that
 * runner and which parent identities it must preserve.
 */
export function planQueueSubmoduleComposition(conflicts: readonly QueueTreeConflict[]): QueueSubmoduleCompositionPlan {
  const duplicatePaths = duplicateConflictPaths(conflicts)
  const invalidPaths = new Set(duplicatePaths)
  const parsed = new Map<string, GitlinkStages>()

  for (const conflict of conflicts) {
    const stages = parseGitlinkStages(conflict)
    if (stages === undefined) {
      invalidPaths.add(conflict.path)
      continue
    }
    parsed.set(conflict.path, stages)
    if (directPin(stages) === undefined && !validOrigin(conflict.origin)) invalidPaths.add(conflict.path)
  }

  if (invalidPaths.size > 0) return refusal([...invalidPaths])

  const resolutions: QueueSubmoduleResolution[] = []
  for (const conflict of conflicts.toSorted(compareConflictPaths)) {
    const stages = parsed.get(conflict.path)
    if (stages === undefined) throw new Error(`yrd: missing planned gitlink stages for '${conflict.path}'`)
    const pin = directPin(stages)
    if (pin !== undefined) {
      resolutions.push({ kind: "pin", path: conflict.path, sha: pin })
      continue
    }
    const origin = conflict.origin
    if (origin === undefined) throw new Error(`yrd: missing planned submodule origin for '${conflict.path}'`)
    resolutions.push({
      kind: "compose",
      path: conflict.path,
      origin,
      ...stages,
      ref: compositionRef(conflict.path, origin, stages),
      message: compositionMessage(conflict.path, stages.baseSha, stages.currentSha, stages.incomingSha),
    })
  }
  return { status: "planned", resolutions }
}

function parseGitlinkStages(conflict: QueueTreeConflict): GitlinkStages | undefined {
  if (conflict.path.length === 0 || conflict.path.includes("\0") || conflict.stages.length !== 3) return undefined
  const stages = new Map<number, QueueConflictStage>()
  for (const stage of conflict.stages) {
    if (
      (stage.stage !== 1 && stage.stage !== 2 && stage.stage !== 3) ||
      stage.mode !== GITLINK_MODE ||
      !OBJECT_ID.test(stage.oid) ||
      stages.has(stage.stage)
    ) {
      return undefined
    }
    stages.set(stage.stage, stage)
  }
  const base = stages.get(1)
  const current = stages.get(2)
  const incoming = stages.get(3)
  if (base === undefined || current === undefined || incoming === undefined) return undefined
  return { baseSha: base.oid, currentSha: current.oid, incomingSha: incoming.oid }
}

function directPin(stages: GitlinkStages): string | undefined {
  if (stages.currentSha === stages.incomingSha) return stages.currentSha
  if (stages.baseSha === stages.currentSha) return stages.incomingSha
  if (stages.baseSha === stages.incomingSha) return stages.currentSha
  return undefined
}

function validOrigin(origin: string | undefined): origin is string {
  return origin !== undefined && origin.length > 0 && !origin.includes("\0")
}

function duplicateConflictPaths(conflicts: readonly QueueTreeConflict[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const conflict of conflicts) {
    if (seen.has(conflict.path)) duplicates.add(conflict.path)
    seen.add(conflict.path)
  }
  return [...duplicates]
}

function compareConflictPaths(left: QueueTreeConflict, right: QueueTreeConflict): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
}

function refusal(paths: readonly string[]): QueueSubmoduleCompositionPlan {
  const sorted = [...new Set(paths)].toSorted()
  return {
    status: "refused",
    code: "candidate-conflict",
    paths: sorted,
    message:
      "queue-native composition requires one complete three-stage gitlink per path and an origin for divergent pins: " +
      sorted.join(", ") +
      "; resolve these conflicts or supply the missing submodule origin, then retry",
  }
}

function compositionRef(path: string, origin: string, stages: GitlinkStages): string {
  const identity = createHash("sha256")
    .update("yrd-submodule-composition-v1")
    .update("\0")
    .update(path)
    .update("\0")
    .update(origin)
    .update("\0")
    .update(stages.baseSha)
    .update("\0")
    .update(stages.currentSha)
    .update("\0")
    .update(stages.incomingSha)
    .digest("hex")
  return `refs/yrd/compositions/${identity}`
}

function compositionMessage(path: string, baseSha: string, currentSha: string, incomingSha: string): string {
  const escapedPath = path.replaceAll("\\", "\\\\").replaceAll("\r", "\\r").replaceAll("\n", "\\n")
  return (
    `yrd: compose ${escapedPath}\n\n` +
    `Yrd-Composition-Path: ${escapedPath}\n` +
    `Yrd-Composition-Base: ${baseSha}\n` +
    `Yrd-Composition-Parents: ${currentSha} ${incomingSha}`
  )
}
