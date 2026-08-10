import { createHash } from "node:crypto"
import type { Process } from "@yrd/process"
import {
  composeSubmoduleCommits,
  planSubmoduleComposition,
  type SubmoduleCommitResolution,
  type SubmoduleCompositionGit,
  type SubmoduleCompositionPlan,
  type SubmoduleConflictStage,
  type SubmodulePinResolution,
  type SubmoduleReviewedBlob,
  type SubmoduleTreeConflict,
} from "git-super/composition"

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
  const git = adaptGit(options.inject.process)
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
      await publishImmutableRemoteRef({
        inject: { process: options.inject.process },
        repo: store,
        origin: planned.origin,
        ref: planned.ref,
        sha: resolution.sha,
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      })
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

function adaptGit(process: Pick<Process, "run">): SubmoduleCompositionGit {
  return {
    async run(request) {
      const result = await process.run({
        argv: ["git", "-C", request.repo, ...request.args],
        cwd: request.repo,
        env: request.env,
        ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        timeoutMs: request.timeoutMs,
      })
      return {
        code: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        signal: result.signal,
        timedOut: result.timedOut,
        ...(result.stalled === undefined ? {} : { stalled: result.stalled }),
        ...((result.verdict !== undefined && result.verdict !== "EXITED") || result.sweepFailure !== undefined
          ? { failure: result.sweepFailure ?? `process verdict ${result.verdict}` }
          : {}),
      }
    },
  }
}

/** @internal Publish one immutable remote ref with create-only CAS semantics. */
export async function publishImmutableRemoteRef(request: {
  inject: Readonly<{ process: Pick<Process, "run"> }>
  repo: string
  origin: string
  ref: string
  sha: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<void> {
  const git = adaptGit(request.inject.process)
  const existing = await remoteRef(git, request.repo, request.origin, request.ref, request)
  if (existing !== undefined) {
    if (existing === request.sha) return
    throw new Error(`remote immutable ref '${request.ref}' already names '${existing}' and will not be moved`)
  }
  const pushed = await queueGit(
    git,
    request.repo,
    [
      "push",
      "--porcelain",
      "--no-verify",
      `--force-with-lease=${request.ref}:`,
      request.origin,
      `${request.sha}:${request.ref}`,
    ],
    request,
  )
  const published = await remoteRef(git, request.repo, request.origin, request.ref, request)
  if (published === request.sha) return
  if (published !== undefined) {
    throw new Error(`remote immutable ref '${request.ref}' already names '${published}' and will not be moved`)
  }
  if (!settled(pushed) || pushed.code !== 0) throw new Error(gitDetail(pushed))
  throw new Error(`published immutable ref '${request.ref}' is missing`)
}

async function remoteRef(
  git: SubmoduleCompositionGit,
  repo: string,
  origin: string,
  ref: string,
  options: Readonly<{ env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number }>,
): Promise<string | undefined> {
  const result = await queueGit(git, repo, ["ls-remote", "--refs", origin, ref], options)
  if (!settled(result) || result.code !== 0) throw new Error(gitDetail(result))
  const output = result.stdout.trim()
  if (output === "") return undefined
  const [sha, resolvedRef] = output.split(/\s+/u)
  if (resolvedRef !== ref || sha === undefined || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(sha)) {
    throw new Error(`remote immutable ref '${ref}' is missing or malformed`)
  }
  return sha
}

function queueGit(
  git: SubmoduleCompositionGit,
  repo: string,
  args: readonly string[],
  options: Readonly<{ env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number }>,
): Promise<Awaited<ReturnType<SubmoduleCompositionGit["run"]>>> {
  const source = options.env ?? globalThis.process.env
  const env = Object.fromEntries(
    Object.entries(source).filter(([key, value]) => value !== undefined && !key.startsWith("GIT_")),
  ) as NodeJS.ProcessEnv
  return git.run({
    repo,
    args,
    env: { ...env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", TZ: "UTC" },
    timeoutMs: options.timeoutMs ?? 30_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
}

function settled(result: Awaited<ReturnType<SubmoduleCompositionGit["run"]>>): boolean {
  return (
    result.failure === undefined &&
    result.timedOut !== true &&
    result.stalled !== true &&
    (result.signal === undefined || result.signal === null)
  )
}

function gitDetail(result: Awaited<ReturnType<SubmoduleCompositionGit["run"]>>): string {
  const output = result.stderr.trim() || result.stdout.trim() || `git exited ${result.code}`
  return result.failure === undefined ? output : `${result.failure}: ${output}`
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
