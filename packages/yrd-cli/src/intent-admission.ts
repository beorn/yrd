import { resolve } from "node:path"
import type { Process, ProcessResult } from "@yrd/process"
import type { PinTombstone, RemedyStepV1 } from "@yrd/intent"
import { cleanGitEnvironment } from "./git-environment.ts"

const GIT_TIMEOUT_MS = 30_000

/**
 * How the declared target sits relative to the pin the base branch carries.
 *
 * `deferred` is the no-target form: the queue derives the component's main tip
 * at landing, so there is nothing to relate yet.
 */
export type PinIntentRelation = "advance" | "noop" | "deferred"

export type PinIntentAdmitted = Readonly<{
  admitted: true
  currentPin: string
  relation: PinIntentRelation
}>

export type PinIntentRefused = Readonly<{
  admitted: false
  code:
    | "intent-component-unknown"
    | "intent-target-unpublished"
    | "intent-target-tombstoned"
    | "intent-pin-divergent"
  message: string
  evidence: Readonly<{
    component: string
    target?: string
    currentPin?: string
    tombstone?: string
    declared?: readonly string[]
  }>
  remedy: readonly RemedyStepV1[]
}>

export type PinIntentAdmission = PinIntentAdmitted | PinIntentRefused

export type PinIntentAdmissionOptions = Readonly<{
  process: Pick<Process, "run">
  repo: string
  base: string
  component: string
  target?: string
  tombstones?: readonly Pick<PinTombstone, "sha">[]
}>

/**
 * Advisory admission for a pin-advance intent.
 *
 * Advisory because main moves: merge-time evaluation is the only authority, and
 * this deliberately re-runs there. Admission exists so the submitter gets a
 * loud, actionable failure while their context is still warm — the same split
 * as Candidate mergeability today.
 *
 * Every refusal carries typed {@link RemedyStepV1} steps. The printed sentence
 * is rendered from those steps, never parsed back out of prose.
 */
export async function admitPinIntent(options: PinIntentAdmissionOptions): Promise<PinIntentAdmission> {
  const repo = resolve(options.repo)
  const gitlinks = await baseGitlinks(options.process, repo, options.base)
  const currentPin = gitlinks.get(options.component)
  if (currentPin === undefined) {
    return {
      admitted: false,
      code: "intent-component-unknown",
      message: `yrd: '${options.component}' is not a declared component on '${options.base}'`,
      evidence: { component: options.component, declared: [...gitlinks.keys()] },
      remedy: [...gitlinks.keys()].map((declared) => ({
        argv: ["yrd", "intent", "submit", "--component", declared],
        note: `declared component on ${options.base}`,
      })),
    }
  }

  const target = options.target
  if (target === undefined) return { admitted: true, currentPin, relation: "deferred" }

  const componentRepo = resolve(repo, options.component)
  const branch = await componentBranch(options.process, repo, options.component)
  await tryGit(options.process, componentRepo, ["fetch", "--quiet", "--prune", "origin"])
  if (!(await isPublished(options.process, componentRepo, target))) {
    return {
      admitted: false,
      code: "intent-target-unpublished",
      message: `yrd: target '${target}' is not reachable from any published branch of '${options.component}'`,
      evidence: { component: options.component, target, currentPin },
      remedy: [
        {
          argv: ["git", "push", "origin", `${target}:refs/heads/${branch}`],
          cwd: options.component,
          note: "publish the target, then resubmit the intent",
        },
      ],
    }
  }

  for (const tombstone of options.tombstones ?? []) {
    if (!(await isAncestor(options.process, componentRepo, tombstone.sha, target))) continue
    return {
      admitted: false,
      code: "intent-target-tombstoned",
      message: `yrd: target '${target}' descends from rolled-back pin '${tombstone.sha}' of '${options.component}'`,
      evidence: { component: options.component, target, currentPin, tombstone: tombstone.sha },
      remedy: [
        {
          argv: ["git", "revert", tombstone.sha],
          cwd: options.component,
          note: "revert the tombstoned component change on the intended lineage",
        },
        {
          argv: ["git", "push", "origin", `HEAD:refs/heads/${branch}`],
          cwd: options.component,
          note: "publish the safe descendant",
        },
        {
          argv: ["yrd", "intent", "submit", "--component", options.component, "--target", "<safe-sha>"],
          note: "submit a target that does not descend from the rolled-back pin",
        },
      ],
    }
  }

  if (await isAncestor(options.process, componentRepo, currentPin, target)) {
    return { admitted: true, currentPin, relation: "advance" }
  }
  if (await isAncestor(options.process, componentRepo, target, currentPin)) {
    // Already contained. Admitted, not refused: evaluation concludes `noop`,
    // which is terminal SUCCESS with a receipt, not a failure.
    return { admitted: true, currentPin, relation: "noop" }
  }

  return {
    admitted: false,
    code: "intent-pin-divergent",
    message: `yrd: target '${target}' and the current pin '${currentPin}' of '${options.component}' have no ancestry`,
    evidence: { component: options.component, target, currentPin },
    remedy: [
      {
        argv: ["git", "merge", currentPin],
        cwd: options.component,
        note: "merge inside the component, where merges belong",
      },
      {
        argv: ["git", "push", "origin", `HEAD:refs/heads/${branch}`],
        cwd: options.component,
        note: "land the merge on component main",
      },
      {
        argv: ["yrd", "intent", "submit", "--component", options.component, "--target", "<merge-sha>"],
        note: "submit a NEW intent with the merge sha; it supersedes this one by key",
      },
    ],
  }
}

/** Every gitlink declared on the base branch, path -> pin. */
async function baseGitlinks(
  process: Pick<Process, "run">,
  repo: string,
  base: string,
): Promise<ReadonlyMap<string, string>> {
  const raw = await git(process, repo, ["ls-tree", "-r", "-z", base])
  const gitlinks = new Map<string, string>()
  for (const entry of raw.split("\0")) {
    if (entry === "") continue
    const [meta, path] = entry.split("\t")
    if (meta === undefined || path === undefined)
      throw new Error(`yrd: git ls-tree returned an invalid entry: ${entry}`)
    const [mode, , sha] = meta.split(" ")
    if (mode === "160000" && sha !== undefined) gitlinks.set(path, sha)
  }
  return gitlinks
}

/**
 * The component's tracked branch from `.gitmodules`, defaulting to `main`.
 *
 * This is the branch a publication remedy pushes to, so a wrong answer makes
 * the remedy wrong — which is exactly the defect class typed remedies exist to
 * kill. Read it, never assume it.
 */
async function componentBranch(process: Pick<Process, "run">, repo: string, component: string): Promise<string> {
  const configured = await tryGit(process, repo, [
    "config",
    "-f",
    ".gitmodules",
    "--get",
    `submodule.${component}.branch`,
  ])
  const branch = configured?.trim()
  return branch === undefined || branch === "" || branch === "." ? "main" : branch
}

async function isPublished(process: Pick<Process, "run">, componentRepo: string, target: string): Promise<boolean> {
  const exists = await tryGit(process, componentRepo, ["cat-file", "-e", `${target}^{commit}`])
  if (exists === undefined) return false
  const refs = await tryGit(process, componentRepo, [
    "for-each-ref",
    "--format=%(refname)",
    `--contains=${target}`,
    "refs/remotes/origin/",
  ])
  return refs !== undefined && refs.trim() !== ""
}

async function isAncestor(
  process: Pick<Process, "run">,
  componentRepo: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await run(process, componentRepo, ["merge-base", "--is-ancestor", ancestor, descendant])
  if (result.timedOut) throw new Error(`yrd: git merge-base --is-ancestor timed out after ${GIT_TIMEOUT_MS}ms`)
  if (result.exitCode === 0) return true
  if (result.exitCode === 1) return false
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`
  throw new Error(`yrd: git merge-base --is-ancestor failed: ${detail}`)
}

async function run(process: Pick<Process, "run">, cwd: string, args: readonly string[]): Promise<ProcessResult> {
  return process.run({
    argv: ["git", "-C", cwd, ...args],
    cwd,
    env: cleanGitEnvironment(globalThis.process.env),
    timeoutMs: GIT_TIMEOUT_MS,
  })
}

async function git(process: Pick<Process, "run">, cwd: string, args: readonly string[]): Promise<string> {
  const result = await run(process, cwd, args)
  if (result.timedOut) throw new Error(`yrd: git ${args.join(" ")} timed out after ${GIT_TIMEOUT_MS}ms`)
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`
    throw new Error(`yrd: git ${args.join(" ")} failed: ${detail}`)
  }
  return result.stdout
}

/** Run a probe whose non-zero exit is an ANSWER, not an error. */
async function tryGit(
  process: Pick<Process, "run">,
  cwd: string,
  args: readonly string[],
): Promise<string | undefined> {
  const result = await run(process, cwd, args)
  if (result.timedOut) throw new Error(`yrd: git ${args.join(" ")} timed out after ${GIT_TIMEOUT_MS}ms`)
  return result.exitCode === 0 ? result.stdout : undefined
}
