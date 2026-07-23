import type { Process, ProcessResult } from "@yrd/process"
import type {
  QueueSubmoduleCommitResolution,
  QueueSubmoduleCompositionPlan,
  QueueSubmodulePinResolution,
} from "./submodule-composition.ts"

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu

type PlannedComposition = Extract<QueueSubmoduleCompositionPlan, { status: "planned" }>

export type QueueSubmoduleReviewedBlob = Readonly<{ path: string; oid: string; content: string }>

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

/** Execute a validated plan against full local stores and publish immutable composition refs. */
export async function executeQueueSubmoduleComposition(
  plan: PlannedComposition,
  options: QueueSubmoduleCompositionExecutionOptions,
): Promise<QueueSubmoduleCompositionExecution> {
  const context = createGitContext(options)
  const resolutions: QueueSubmoduleExecutedResolution[] = []
  for (const resolution of plan.resolutions) {
    if (resolution.kind === "pin") {
      resolutions.push(resolution)
      continue
    }
    const executed = await executeComposition(context, options.inject.storeForOrigin, resolution)
    if (executed.status === "refused") return executed
    resolutions.push(executed.resolution)
  }
  return { status: "composed", resolutions }
}

type GitContext = Readonly<{
  process: Pick<Process, "run">
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
}>

type ExecutedComposition =
  | Readonly<{ status: "composed"; resolution: QueueSubmoduleExecutedResolution }>
  | Extract<QueueSubmoduleCompositionExecution, { status: "refused" }>

async function executeComposition(
  context: GitContext,
  storeForOrigin: (origin: string) => string,
  resolution: QueueSubmoduleCommitResolution,
): Promise<ExecutedComposition> {
  let operation = "locate its full local store"
  try {
    const store = storeForOrigin(resolution.origin)
    if (store.length === 0) throw new Error("store locator returned an empty path")

    operation = "inspect repository depth"
    const shallow = await requiredGit(context, store, ["rev-parse", "--is-shallow-repository"], operation)
    if (shallow !== "false") {
      return unavailable(
        resolution.path,
        `submodule store for '${resolution.path}' is shallow; fetch full history for both parent tips and retry`,
      )
    }

    operation = "verify planned commits"
    await requiredGit(context, store, ["cat-file", "-e", `${resolution.baseSha}^{commit}`], operation)
    await requiredGit(context, store, ["cat-file", "-e", `${resolution.currentSha}^{commit}`], operation)
    await requiredGit(context, store, ["cat-file", "-e", `${resolution.incomingSha}^{commit}`], operation)

    operation = "verify the planned merge base"
    for (const parent of [resolution.currentSha, resolution.incomingSha]) {
      if (!(await isAncestor(context, store, resolution.baseSha, parent))) {
        return unavailable(
          resolution.path,
          `planned merge base '${resolution.baseSha}' for '${resolution.path}' is not an ancestor of parent '${parent}'; ` +
            "refresh the root conflict stages and retry",
        )
      }
    }

    operation = "find a merge base"
    const mergeBaseResult = await runGit(context, store, ["merge-base", resolution.currentSha, resolution.incomingSha])
    if (!settled(mergeBaseResult)) throw new Error(gitDetail(mergeBaseResult))
    if (mergeBaseResult.exitCode === 1) {
      return unavailable(
        resolution.path,
        `submodule histories for '${resolution.path}' have no merge base; publish a shared ancestor or resolve the pin manually, then retry`,
      )
    }
    if (mergeBaseResult.exitCode !== 0) throw new Error(gitDetail(mergeBaseResult))
    objectId(mergeBaseResult.stdout, operation)

    operation = "materialize the composed tree"
    const merged = await runGit(context, store, [
      "merge-tree",
      "--write-tree",
      "--name-only",
      resolution.currentSha,
      resolution.incomingSha,
    ])
    if (!settled(merged)) throw new Error(gitDetail(merged))
    if (merged.exitCode === 1) {
      return {
        status: "refused",
        code: "submodule-composition-conflict",
        path: resolution.path,
        message:
          `submodule '${resolution.path}' has real content conflicts: ${gitDetail(merged)}; ` +
          "fix the source submodule and push; the same PR resumes automatically",
      }
    }
    if (merged.exitCode !== 0) throw new Error(gitDetail(merged))
    const tree = objectId(merged.stdout.split(/\r?\n/u)[0] ?? "", operation)

    operation = "read both-changed Markdown from the composed tree"
    const reviewedBlobs = await readBothChangedMarkdown(context, store, resolution.baseSha, resolution, tree)

    operation = "create the queue-authored composition commit"
    const sha = await createCompositionCommit(context, store, resolution, tree)

    operation = "publish the immutable composition ref"
    await publishComposition(context, store, resolution, sha)
    return {
      status: "composed",
      resolution: { kind: "compose", path: resolution.path, sha, ref: resolution.ref, reviewedBlobs },
    }
  } catch (cause) {
    return unavailable(
      resolution.path,
      `submodule composition for '${resolution.path}' is unavailable while trying to ${operation}: ${messageOf(cause)}; ` +
        "repair or fetch the submodule store, then retry",
    )
  }
}

function createGitContext(options: QueueSubmoduleCompositionExecutionOptions): GitContext {
  const source = options.env ?? globalThis.process.env
  const env = Object.fromEntries(
    Object.entries(source).filter(([key, value]) => value !== undefined && !key.startsWith("GIT_")),
  ) as NodeJS.ProcessEnv
  return {
    process: options.inject.process,
    env: { ...env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", TZ: "UTC" },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    timeoutMs: options.timeoutMs ?? 30_000,
  }
}

async function runGit(
  context: GitContext,
  repo: string,
  args: readonly string[],
  options: Readonly<{ stdin?: string; env?: NodeJS.ProcessEnv }> = {},
): Promise<ProcessResult> {
  return context.process.run({
    argv: ["git", "-C", repo, ...args],
    cwd: repo,
    env: options.env ?? context.env,
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(context.timeoutMs === undefined ? {} : { timeoutMs: context.timeoutMs }),
  })
}

async function requiredGit(
  context: GitContext,
  repo: string,
  args: readonly string[],
  operation: string,
  options: Readonly<{ stdin?: string; env?: NodeJS.ProcessEnv; trim?: boolean }> = {},
): Promise<string> {
  const result = await runGit(context, repo, args, options)
  if (!settled(result) || result.exitCode !== 0) throw new Error(`${operation} failed: ${gitDetail(result)}`)
  return options.trim === false ? result.stdout : result.stdout.trim()
}

function settled(result: ProcessResult): boolean {
  return (
    !result.timedOut &&
    result.signal === null &&
    result.stalled !== true &&
    (result.verdict === undefined || result.verdict === "EXITED") &&
    result.sweepFailure === undefined
  )
}

function gitDetail(result: ProcessResult): string {
  const output = result.stderr.trim() || result.stdout.trim() || `git exited ${result.exitCode}`
  if (result.sweepFailure !== undefined) return `process sweep failed (${result.sweepFailure}): ${output}`
  if (result.stalled) return `git stalled: ${output}`
  if (result.timedOut) return `git timed out: ${output}`
  if (result.signal !== null) return `git terminated by ${result.signal}: ${output}`
  return output
}

function objectId(output: string, operation: string): string {
  const oid = output.trim()
  if (!OBJECT_ID.test(oid)) throw new Error(`${operation} returned invalid object identity '${oid}'`)
  return oid
}

async function isAncestor(context: GitContext, store: string, base: string, tip: string): Promise<boolean> {
  const result = await runGit(context, store, ["merge-base", "--is-ancestor", base, tip])
  if (!settled(result)) throw new Error(gitDetail(result))
  if (result.exitCode === 0) return true
  if (result.exitCode === 1) return false
  throw new Error(gitDetail(result))
}

async function readBothChangedMarkdown(
  context: GitContext,
  store: string,
  mergeBase: string,
  resolution: QueueSubmoduleCommitResolution,
  tree: string,
): Promise<QueueSubmoduleReviewedBlob[]> {
  const current = await changedPaths(context, store, mergeBase, resolution.currentSha)
  const incoming = new Set(await changedPaths(context, store, mergeBase, resolution.incomingSha))
  const paths = current.filter((path) => incoming.has(path) && path.toLowerCase().endsWith(".md")).toSorted(compareText)
  const reviewed: QueueSubmoduleReviewedBlob[] = []
  for (const path of paths) {
    const entry = await requiredGit(context, store, ["ls-tree", "-z", tree, "--", path], `locate '${path}'`, {
      trim: false,
    })
    if (entry === "") continue
    const header = entry.slice(0, entry.indexOf("\t"))
    const [mode, type, oid] = header.split(" ")
    if (mode === undefined || type !== "blob" || oid === undefined || !OBJECT_ID.test(oid)) {
      throw new Error(`composed Markdown '${path}' is not a readable blob`)
    }
    const content = await requiredGit(context, store, ["cat-file", "blob", oid], `read '${path}'`, { trim: false })
    reviewed.push({ path, oid, content })
  }
  return reviewed
}

async function changedPaths(context: GitContext, store: string, base: string, tip: string): Promise<string[]> {
  const output = await requiredGit(
    context,
    store,
    ["diff", "--name-only", "-z", "--diff-filter=AMRT", base, tip, "--"],
    "enumerate changed paths",
    { trim: false },
  )
  return output.split("\0").filter((path) => path !== "")
}

async function createCompositionCommit(
  context: GitContext,
  store: string,
  resolution: QueueSubmoduleCommitResolution,
  tree: string,
): Promise<string> {
  const currentTime = await commitTime(context, store, resolution.currentSha)
  const incomingTime = await commitTime(context, store, resolution.incomingSha)
  const date = `${Math.max(currentTime, incomingTime)} +0000`
  const env = {
    ...context.env,
    GIT_AUTHOR_NAME: "Yrd Queue",
    GIT_AUTHOR_EMAIL: "queue@yrd.dev",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: "Yrd Queue",
    GIT_COMMITTER_EMAIL: "queue@yrd.dev",
    GIT_COMMITTER_DATE: date,
  }
  return objectId(
    await requiredGit(
      context,
      store,
      ["commit-tree", tree, "-p", resolution.currentSha, "-p", resolution.incomingSha],
      "create composition commit",
      { stdin: `${resolution.message}\n`, env },
    ),
    "create composition commit",
  )
}

async function commitTime(context: GitContext, store: string, sha: string): Promise<number> {
  const output = await requiredGit(context, store, ["show", "-s", "--format=%ct", sha], "read parent time")
  if (!/^\d+$/u.test(output)) throw new Error(`parent '${sha}' has invalid commit time '${output}'`)
  const timestamp = Number(output)
  if (!Number.isSafeInteger(timestamp)) throw new Error(`parent '${sha}' commit time is outside the safe range`)
  return timestamp
}

async function publishComposition(
  context: GitContext,
  store: string,
  resolution: QueueSubmoduleCommitResolution,
  sha: string,
): Promise<void> {
  const existing = await remoteRef(context, store, resolution)
  if (existing !== undefined) {
    if (existing === sha) return
    throw new Error(`remote composition ref '${resolution.ref}' already names '${existing}' and will not be moved`)
  }
  const pushed = await runGit(context, store, [
    "push",
    "--porcelain",
    "--no-verify",
    `--force-with-lease=${resolution.ref}:`,
    resolution.origin,
    `${sha}:${resolution.ref}`,
  ])
  const published = await remoteRef(context, store, resolution)
  if (published === sha) return
  if (published !== undefined) {
    throw new Error(`remote composition ref '${resolution.ref}' already names '${published}' and will not be moved`)
  }
  if (!settled(pushed) || pushed.exitCode !== 0) throw new Error(gitDetail(pushed))
  throw new Error(`published composition ref '${resolution.ref}' is missing`)
}

async function remoteRef(
  context: GitContext,
  store: string,
  resolution: QueueSubmoduleCommitResolution,
): Promise<string | undefined> {
  const output = await requiredGit(
    context,
    store,
    ["ls-remote", "--refs", resolution.origin, resolution.ref],
    "read composition ref",
  )
  if (output === "") return undefined
  const [sha, ref] = output.split(/\s+/u)
  if (ref !== resolution.ref || sha === undefined || !OBJECT_ID.test(sha)) {
    throw new Error(`remote composition ref '${resolution.ref}' is missing or malformed`)
  }
  return sha
}

function unavailable(
  path: string,
  message: string,
): Extract<QueueSubmoduleCompositionExecution, { status: "refused" }> {
  return { status: "refused", code: "submodule-composition-unavailable", path, message }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
