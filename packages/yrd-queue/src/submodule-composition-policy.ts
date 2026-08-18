import { createHash } from "node:crypto"
import { adaptProcessGit, gitSuperFailureDetail, type Process } from "@yrd/process"
import {
  composeSubmoduleCommits,
  planSubmoduleComposition,
  type SubmoduleCommitResolution,
  type SubmoduleCompositionPlan,
  type SubmoduleConflictStage,
  type SubmodulePinResolution,
  type SubmoduleReviewedBlob,
  type SubmoduleTreeConflict,
} from "git-super/composition"
import { pushRefUpdates } from "git-super/push"
import type { GitSuperResult } from "git-super/result"

/**
 * The ref a component's main is read from — ONE definition, because more than one drifts.
 *
 * The merge path fetches this ref to decide what a submodule's main currently is, and the
 * shaset model's submodule-main-first rule asks the same question at admission time. Those
 * two stages disagreed while each spelled the ref itself: merge asked for `refs/heads/main`
 * and admission accepted any branch, so a pin on someone's side branch passed admission and
 * only failed later. Naming it once is the seam that lets admission ask the merge path's
 * question instead of a weaker one of its own.
 */
export const COMPONENT_MAIN_REF = "refs/heads/main"

/**
 * The private ref a component's main is fetched into before anything asks it a question.
 *
 * Never a caller-supplied name: the whole point is that both stages probe the same place,
 * and a ref the caller chooses is a ref two callers can choose differently.
 */
export const COMPONENT_MAIN_PROBE_REF = "refs/yrd/component-main"

/** The one git call shape this probe needs, so both stages can supply their own runner. */
export type ComponentMainGit = (
  repository: string,
  args: readonly string[],
) => Promise<Readonly<{ code: number; stdout: string; stderr: string }>>

export type ComponentMainResolution =
  | Readonly<{ status: "resolved"; sha: string }>
  | Readonly<{ status: "unavailable"; message: string }>

/**
 * Fetch a component's main into the probe ref and resolve it — the ONE way either stage
 * learns what a submodule's main currently is.
 *
 * This exists because asking the question two ways produced two answers. Merge fetched
 * exactly `refs/heads/main` and tested ancestry against it; admission asked git-super
 * whether the pin sat under any `refs/heads/` tip, so a pin pushed to a side branch
 * passed admission and was only caught later, after the PR had a carrier. The fix is not
 * a tighter prefix — `refPrefixes` matches with `startsWith`, so `refs/heads/main` would
 * silently also accept `refs/heads/maintenance` and widen the check inside a change meant
 * to narrow it. Exactness is only expressible by fetching one ref and naming its sha.
 *
 * Returns a RESULT rather than throwing: both callers are probes that must classify a
 * missing origin loudly, and neither can afford a throw from inside a gate.
 */
export async function resolveComponentMain(
  run: ComponentMainGit,
  repository: string,
  origin: string,
): Promise<ComponentMainResolution> {
  const fetched = await run(repository, [
    "fetch",
    "--quiet",
    "--no-tags",
    "--no-recurse-submodules",
    origin,
    `+${COMPONENT_MAIN_REF}:${COMPONENT_MAIN_PROBE_REF}`,
  ])
  if (fetched.code !== 0) {
    return {
      status: "unavailable",
      message:
        `could not refresh component main from '${origin}': ` +
        `${fetched.stderr.trim() || fetched.stdout.trim() || "git fetch failed"}`,
    }
  }
  const resolved = await run(repository, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${COMPONENT_MAIN_PROBE_REF}^{commit}`,
  ])
  const sha = resolved.stdout.trim()
  if (resolved.code !== 0 || sha === "") {
    return {
      status: "unavailable",
      message:
        `fetched '${COMPONENT_MAIN_REF}' from '${origin}' but could not resolve it: ` +
        `${resolved.stderr.trim() || resolved.stdout.trim() || "git rev-parse failed"}`,
    }
  }
  return { status: "resolved", sha }
}

export type QueueConflictStage = SubmoduleConflictStage
export type QueueTreeConflict = SubmoduleTreeConflict
export type QueueSubmodulePinResolution = SubmodulePinResolution

export type QueueSubmoduleCommitResolution = SubmoduleCommitResolution & Readonly<{ ref: string; message: string }>

export type QueueSubmoduleResolution = QueueSubmodulePinResolution | QueueSubmoduleCommitResolution

export type QueueSubmoduleCompositionPlan =
  | Readonly<{ status: "planned"; resolutions: readonly QueueSubmoduleResolution[] }>
  | Readonly<{ status: "refused"; code: "candidate-conflict"; paths: readonly string[]; message: string }>

export type QueueSubmoduleReviewedBlob = SubmoduleReviewedBlob

export type QueueSubmoduleExecutedResolution =
  | QueueSubmodulePinResolution
  | Readonly<{
      kind: "compose"
      path: string
      sha: string
      ref: string
      reviewedBlobs: readonly QueueSubmoduleReviewedBlob[]
    }>

export type QueueSubmoduleCompositionExecution =
  | Readonly<{ status: "composed"; resolutions: readonly QueueSubmoduleExecutedResolution[] }>
  | Readonly<{
      status: "refused"
      code: "submodule-composition-conflict" | "submodule-composition-unavailable"
      path: string
      message: string
    }>

export type QueueSubmoduleCompositionExecutionOptions = Readonly<{
  inject: Readonly<{
    process: Pick<Process, "run">
    storeForOrigin(origin: string): string
  }>
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
}>

/** Add queue-authored refs/messages to git-super's workflow-neutral plan. */
export function planQueueSubmoduleComposition(conflicts: readonly QueueTreeConflict[]): QueueSubmoduleCompositionPlan {
  const plan = planSubmoduleComposition(conflicts)
  if (plan.status === "refused") return queueRefusal(plan)
  return {
    status: "planned",
    resolutions: plan.resolutions.map((resolution): QueueSubmoduleResolution => {
      if (resolution.kind === "pin") return resolution
      return {
        ...resolution,
        ref: compositionRef(resolution),
        message: compositionMessage(resolution),
      }
    }),
  }
}

/** Construct with git-super, then apply Yrd's immutable publication policy. */
export async function executeQueueSubmoduleComposition(
  plan: Extract<QueueSubmoduleCompositionPlan, { status: "planned" }>,
  options: QueueSubmoduleCompositionExecutionOptions,
): Promise<QueueSubmoduleCompositionExecution> {
  const git = adaptProcessGit(options.inject.process, {
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
  const executed = await composeSubmoduleCommits(
    plan satisfies Extract<SubmoduleCompositionPlan, { status: "planned" }>,
    {
      inject: { git, storeForOrigin: options.inject.storeForOrigin },
      commit: {
        author: { name: "Yrd Queue", email: "queue@yrd.dev" },
        message: compositionMessage,
      },
      reviewPath: (path) => path.toLowerCase().endsWith(".md"),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    },
  )
  if (executed.status === "refused") return queueExecutionRefusal(executed.failure)

  const resolutions: QueueSubmoduleExecutedResolution[] = []
  for (const resolution of executed.resolutions) {
    if (resolution.kind === "pin") {
      resolutions.push(resolution)
      continue
    }
    const planned = { ...resolution, ref: compositionRef(resolution), message: compositionMessage(resolution) }
    try {
      const store = options.inject.storeForOrigin(planned.origin)
      const published = await pushRefUpdates({
        root: store,
        git,
        timeoutMs: options.timeoutMs,
        verify: false,
        updates: [
          {
            repository: store,
            remote: planned.origin,
            source: resolution.sha,
            destination: planned.ref,
            expectedDestination: { state: "missing" },
          },
        ],
      })
      const failure = immutablePublicationFailure(published, planned.ref)
      if (failure !== undefined) throw new Error(failure)
    } catch (cause) {
      return unavailable(
        resolution.path,
        `submodule composition for '${resolution.path}' is unavailable while trying to publish its immutable ref: ${messageOf(cause)}; ` +
          "repair or fetch the submodule store, then retry",
      )
    }
    resolutions.push({ ...resolution, ref: planned.ref })
  }
  return { status: "composed", resolutions }
}

function immutablePublicationFailure(result: GitSuperResult, ref: string): string | undefined {
  if (result.state === "updated" || result.state === "unchanged") return undefined
  const failure = gitSuperFailureDetail(result)
  if (failure?.code === "destination-changed") {
    return `remote immutable ref '${ref}' already exists and will not be moved: ${failure.message}`
  }
  return failure?.message ?? `remote immutable ref '${ref}' publication ended as ${result.state}`
}

function queueRefusal(
  plan: Extract<SubmoduleCompositionPlan, { status: "refused" }>,
): Extract<QueueSubmoduleCompositionPlan, { status: "refused" }> {
  const paths = plan.conflicts.map(({ path }) => path)
  const contentPaths = plan.conflicts.filter(({ kind }) => kind === "content").map(({ path }) => path)
  const gitlinkPaths = plan.conflicts.filter(({ kind }) => kind === "invalid-gitlink").map(({ path }) => path)
  const clauses: string[] = []
  if (contentPaths.length > 0) {
    clauses.push(
      "content conflict in " +
        contentPaths.join(", ") +
        "; the PR must be rebased or merged against the current base, then retry",
    )
  }
  if (gitlinkPaths.length > 0) {
    clauses.push(
      "queue-native composition requires one complete three-stage gitlink per path and an origin for divergent pins: " +
        gitlinkPaths.join(", ") +
        "; resolve these conflicts or supply the missing submodule origin, then retry",
    )
  }
  return { status: "refused", code: "candidate-conflict", paths, message: clauses.join("; ") }
}

function queueExecutionRefusal(
  failure: Readonly<{ kind: "conflict" | "unavailable"; path: string; operation: string; detail: string }>,
): Extract<QueueSubmoduleCompositionExecution, { status: "refused" }> {
  if (failure.kind === "conflict") {
    return {
      status: "refused",
      code: "submodule-composition-conflict",
      path: failure.path,
      message:
        `submodule '${failure.path}' has real content conflicts: ${failure.detail}; ` +
        "fix the source submodule and push; the same PR resumes automatically",
    }
  }
  return unavailable(
    failure.path,
    `submodule composition for '${failure.path}' is unavailable while trying to ${failure.operation}: ${failure.detail}; ` +
      "repair or fetch the submodule store, then retry",
  )
}

function unavailable(
  path: string,
  message: string,
): Extract<QueueSubmoduleCompositionExecution, { status: "refused" }> {
  return { status: "refused", code: "submodule-composition-unavailable", path, message }
}

function compositionRef(resolution: SubmoduleCommitResolution): string {
  const identity = createHash("sha256")
    .update("yrd-submodule-composition-v1")
    .update("\0")
    .update(resolution.path)
    .update("\0")
    .update(resolution.origin)
    .update("\0")
    .update(resolution.baseSha)
    .update("\0")
    .update(resolution.currentSha)
    .update("\0")
    .update(resolution.incomingSha)
    .digest("hex")
  return `refs/yrd/compositions/${identity}`
}

function compositionMessage(resolution: SubmoduleCommitResolution): string {
  const escapedPath = resolution.path.replaceAll("\\", "\\\\").replaceAll("\r", "\\r").replaceAll("\n", "\\n")
  return (
    `yrd: compose ${escapedPath}\n\n` +
    `Yrd-Composition-Path: ${escapedPath}\n` +
    `Yrd-Composition-Base: ${resolution.baseSha}\n` +
    `Yrd-Composition-Parents: ${resolution.currentSha} ${resolution.incomingSha}`
  )
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
