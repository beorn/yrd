import { join } from "node:path"
import { createProcess, type Process } from "@yrd/process"
import {
  gitEnvironment,
  gitIn,
  invokeGit,
  publishGitInvocation,
  resolveGitSelection,
  type Git,
  type GitInvocationOptions,
} from "./git.ts"
import { freshWorktree, type FreshWorktree, type Worktree } from "./worktree.ts"
import { populateReferenceStores } from "./reference.ts"
import { DeriveFailed, deriveInWorktree, type Derived, type DeriveSpec } from "./derive.ts"

/** `descents` records git-super's two-direction ancestry checks of nested pins (24320). */
export type Verification =
  | Readonly<{
      state: "verified"
      head: string
      targetHead: string
      candidate: string
      /** Present when the target's `derive:` changed something: the composed merge before it, and what it did. */
      derived?: Derived & Readonly<{ composed: string }>
      gitlinks: readonly SettledGitlink[]
      descents?: readonly SuperMergeDescent[]
      steps?: readonly SuperMergeStep[]
      unboundedLocalMains?: readonly SuperMergeUnboundedLocalMain[]
    }>
  | Readonly<{
      state: "failed"
      head: string
      targetHead: string
      detail: SuperMergeDetail
      gitlinks: readonly SettledGitlink[]
      descents?: readonly SuperMergeDescent[]
      steps?: readonly SuperMergeStep[]
      unboundedLocalMains?: readonly SuperMergeUnboundedLocalMain[]
    }>

export type VerifiedCandidate =
  | Readonly<{ state: "verified"; verifying: Extract<Verification, { state: "verified" }> }>
  | Readonly<{ state: "failed"; verifying: Extract<Verification, { state: "failed" }>; failedWorktree: Worktree }>

export type VerificationOptions = Readonly<{
  git: Git
  repo: string
  targetHead: string
  head: string
  path: string
  message: string
  worktree?: FreshWorktree
  process?: Process
  env?: NodeJS.ProcessEnv
  hooksPath?: string
  noFetch?: boolean
  unboundedLocalMain?: boolean
  /**
   * Run custom preparation or modeling in the candidate worktree before git-super merge runs.
   */
  beforeMerge?: (candidateWorktree: string) => Promise<void>
  /**
   * Times a named part of the verification into the caller's journal. Only the
   * queue round passes it; without it nothing is timed.
   */
  timed?: <T>(name: string, work: () => Promise<T>) => Promise<T>
  /**
   * The target's `derive:`, run in the merged worktree after the compose and before adoption; only the queue's
   * round passes it (derive.ts). A derive that changes a submodule is composed in as a second merge here, so the
   * candidate that leaves is still one two-parent merge with its own frozen publication intent.
   */
  derive?: DeriveSpec
}>

/** Shared by submit admission and both queue phases; only git-super composes gitlinks. */
export async function verifyCandidate(options: VerificationOptions): Promise<VerifiedCandidate> {
  const timed = options.timed ?? ((_name, work) => work())
  const worktree = await timed("worktree", () =>
    freshWorktree(options.git, options.repo, options.targetHead, options.path, options.worktree),
  )
  let result: SuperMergeResult
  try {
    const beforeMerge = options.beforeMerge
    if (beforeMerge !== undefined) {
      await timed("beforeMerge", () => beforeMerge(worktree.path))
    }
    result = await superMerge(options, worktree.path, options.head, options.message, worktree.excludedSubmodules)
  } catch (error) {
    await worktree.remove()
    throw error
  }
  const evidence = {
    head: options.head,
    targetHead: options.targetHead,
    gitlinks: result.gitlinks,
    ...(result.descents === undefined ? {} : { descents: result.descents }),
    ...(result.steps === undefined ? {} : { steps: result.steps }),
    ...(result.unboundedLocalMains === undefined ? {} : { unboundedLocalMains: result.unboundedLocalMains }),
  }
  if (result.state !== "updated" || result.partial) {
    if (result.detail === undefined) {
      await worktree.remove()
      throw new Error(`git-super merge of ${options.head} returned ${result.state} without a failure detail`)
    }
    return {
      state: "failed",
      verifying: { ...evidence, state: "failed", detail: result.detail },
      failedWorktree: worktree,
    }
  }
  if (result.commit === undefined) {
    await worktree.remove()
    throw new Error(`git-super merge of ${options.head} reported updated without a commit`)
  }
  let derived: (Derived & Readonly<{ composed: string }>) | undefined
  if (options.derive !== undefined) {
    const composed = result.commit
    let outcome: Derived | undefined
    try {
      outcome = await timed("derive", () =>
        deriveInWorktree({
          cwd: worktree.path,
          repo: options.repo,
          candidate: composed,
          targetHead: options.targetHead,
          derive: options.derive as DeriveSpec,
          process: options.process,
          env: options.env,
          selection: options.worktree?.selection,
          gitOptions: options.worktree?.gitOptions,
          hooksPath: options.hooksPath,
          queueRun: true,
        }),
      )
    } catch (error) {
      await worktree.remove()
      throw error
    }
    if (outcome !== undefined) {
      // The carrier holds the derived pins on the target; the same compose folds it into the merge, so the
      // candidate is again a two-parent merge whose frozen intent names the derived child (27176).
      const [, ...body] = options.message.split("\n\n")
      const message = [`${outcome.subject} (derived into ${options.head.slice(0, 12)})`, "", ...body].join("\n\n")
      const recomposed = await superMerge(options, worktree.path, outcome.carrier, message, worktree.excludedSubmodules)
      if (recomposed.state !== "updated" || recomposed.partial || recomposed.commit === undefined) {
        // The CHANGE is stuck by name, never the run: the service exited on this very refusal on 2026-10-02
        // 18:02 PDT (27170 round 2) because it surfaced as a run error the runner could not judge.
        await worktree.remove()
        throw new DeriveFailed(
          composed,
          `composing the carrier ${outcome.carrier.slice(0, 12)} into ${composed.slice(0, 12)} returned ${recomposed.state}${
            recomposed.detail === undefined ? "" : `: ${recomposed.detail.message}`
          }`,
          outcome.ran,
        )
      }
      // derive is a function of the merged gitlinks, so a second run on the final candidate leaves a clean tree;
      // the compose proves it while the step is young (@cto fa8ef67c), and a dirty second run is stuck by name.
      let again: Derived | undefined
      try {
        again = await timed("derive-again", () =>
          deriveInWorktree({
            cwd: worktree.path,
            repo: options.repo,
            candidate: recomposed.commit as string,
            targetHead: options.targetHead,
            derive: { ...(options.derive as DeriveSpec), logDir: join((options.derive as DeriveSpec).logDir, "again") },
            process: options.process,
            env: options.env,
            selection: options.worktree?.selection,
            gitOptions: options.worktree?.gitOptions,
            hooksPath: options.hooksPath,
            queueRun: true,
          }),
        )
      } catch (error) {
        await worktree.remove()
        throw error
      }
      if (again !== undefined) {
        await worktree.remove()
        throw new DeriveFailed(
          recomposed.commit,
          `a second run on the derived candidate changed ${again.submodules.map((row) => row.path).join(", ")} again; derive must be a function of the merged gitlinks`,
          again.ran,
        )
      }
      derived = { ...outcome, composed }
      // THE DERIVED CANDIDATE LANDS LIKE A PLAIN COMPOSE. The recompose merged the carrier INTO the first compose,
      // so its first parent was that compose; the land reads the candidate's first parent as the target it
      // compares-and-swaps onto (event-run.ts, `targetExpect: parent`) and a derived candidate could never land —
      // every derived round deferred as "root target moved" and re-derived (27170 round 1, dev11 e1975a26, 27192
      // on 2026-10-02). Same tree, same frozen message and push intent, parents [target, head].
      const selection =
        options.worktree?.selection ??
        (await resolveGitSelection(options.repo, { process: options.process, env: options.env }))
      const inWorktree = gitIn(worktree.path, options.process, selection, {
        ...(options.env === undefined ? {} : { env: options.env }),
        ...options.worktree?.gitOptions,
      })
      const frozen = await inWorktree(["show", "-s", "--format=%B", recomposed.commit])
      const tree = (await inWorktree(["rev-parse", `${recomposed.commit}^{tree}`])).trim()
      const landable = (
        await inWorktree(
          [
            "-c",
            "user.name=yrd",
            "-c",
            "user.email=yrd@derive",
            "commit-tree",
            tree,
            "-p",
            options.targetHead,
            "-p",
            options.head,
          ],
          frozen,
        )
      ).trim()
      await inWorktree(["update-ref", "HEAD", landable, recomposed.commit])
      result = {
        ...recomposed,
        commit: landable,
        gitlinks: [...result.gitlinks, ...recomposed.gitlinks],
        ...(result.descents === undefined && recomposed.descents === undefined
          ? {}
          : { descents: [...(result.descents ?? []), ...(recomposed.descents ?? [])] }),
        ...(result.steps === undefined && recomposed.steps === undefined
          ? {}
          : { steps: [...(result.steps ?? []), ...(recomposed.steps ?? [])] }),
      }
    }
  }
  if (options.worktree?.populateReference === true) {
    const population = options.worktree
    const selection =
      population.selection ??
      (await resolveGitSelection(options.repo, { process: population.process, env: population.env }))
    // The successful composition owns new child objects. Adopt their exact
    // closure into the queue's stores before releasing that temporary owner.
    // A failed adoption leaves the source intact and propagates the failure.
    await populateReferenceStores({
      acquired: (pin) => {
        population.plumbing?.journal?.({
          action: "acquired",
          head: result.commit,
          kind: "reference",
          path: pin.path,
          sha: pin.sha,
          source: pin.source,
          ...(pin.source === "local" ? { localSource: pin.localSource } : {}),
          ...(pin.source === "remote" && pin.localMiss !== undefined
            ? { localSource: pin.localMiss.localSource, localMissReason: pin.localMiss.reason }
            : {}),
        })
      },
      commit: result.commit,
      excludedSubmodules: worktree.excludedSubmodules,
      gitIn: (cwd) =>
        gitIn(cwd, population.process, selection, {
          ...(population.env === undefined ? {} : { env: population.env }),
          ...population.gitOptions,
        }),
      populated: (store) => {
        population.plumbing?.journal?.({
          head: result.commit,
          kind: "reference",
          ms: store.ms,
          path: store.path,
          sha: store.sha,
        })
      },
      repo: options.repo,
      source: worktree.path,
    })
  }
  await worktree.remove()
  const candidate = result.commit
  if (candidate === undefined) throw new Error(`git-super merge of ${options.head} lost its commit after derivation`)
  return {
    state: "verified",
    verifying: {
      ...evidence,
      gitlinks: result.gitlinks,
      ...(result.descents === undefined ? {} : { descents: result.descents }),
      ...(result.steps === undefined ? {} : { steps: result.steps }),
      state: "verified",
      candidate,
      ...(derived === undefined ? {} : { derived }),
    },
  }
}

async function superMerge(
  options: Pick<VerificationOptions, "process" | "env" | "hooksPath" | "noFetch" | "unboundedLocalMain">,
  cwd: string,
  commit: string,
  message: string,
  excludedSubmodules: readonly string[],
): Promise<SuperMergeResult> {
  // The tree's own list (27147): the merge compares nothing under a path the
  // tree left out, and refuses, by its own admission, a candidate that moves it.
  const execution = await gitSuperExecution(options, cwd, [
    "merge",
    commit,
    "-m",
    message,
    ...(options.noFetch ? ["--no-fetch"] : []),
    ...(options.unboundedLocalMain ? ["--unbounded-local-main"] : []),
    ...excludedSubmodules.flatMap((path) => ["--exclude-submodule", path]),
  ])
  let parsed: unknown
  try {
    parsed = JSON.parse(execution.stdout)
  } catch (error) {
    throw new Error(
      `git-super merge exited ${String(execution.exitCode)} without readable JSON: ${execution.stderr.trim() || execution.stdout.trim()}`,
      { cause: error },
    )
  }
  const result = readSuperMergeResult(parsed)
  if (execution.exitCode === 0 && result.state === "updated" && !result.partial) return result
  if ((execution.exitCode === 1 || execution.exitCode === 2) && result.detail !== undefined) return result
  throw new Error(
    `git-super merge exit/result disagreement: exit=${String(execution.exitCode)} state=${result.state} partial=${String(result.partial)}`,
  )
}

/** Run git-super with the queue's process bounds and preserve the structured refusal. */
export async function gitSuperExecution(
  options: Pick<VerificationOptions, "process" | "env" | "hooksPath"> & {
    gitOptions?: GitInvocationOptions
  },
  cwd: string,
  argv: readonly string[],
): Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>> {
  const owned = options.process === undefined
  const runner = options.process ?? createProcess({ cwd, env: gitEnvironment(options.env ?? globalThis.process.env) })
  const gitArgs = [
    ...(options.hooksPath === undefined ? [] : ["-c", `core.hooksPath=${options.hooksPath}`]),
    "super",
    "--json",
    ...argv,
  ]
  const invocation = {
    args: Object.freeze(gitArgs),
    cwd,
    selection: { executable: "git", contract: "native", scope: "default", origin: "native git" } as const,
  }
  try {
    const evidence = await invokeGit(
      runner,
      invocation,
      options.gitOptions ?? {},
      gitEnvironment(options.env ?? options.gitOptions?.env ?? globalThis.process.env),
      undefined,
    )
    const published = publishGitInvocation(options.gitOptions, evidence, true)
    if (published.failure !== undefined) {
      throw new Error(`git-super ${argv[0] ?? "command"} did not settle normally: ${published.failure}`)
    }
    if (published.result === undefined || published.result.exitCode === null) {
      throw new Error(`git-super ${argv[0] ?? "command"} produced no result`)
    }
    return published.result as Readonly<{ exitCode: number; stdout: string; stderr: string }>
  } finally {
    if (owned) await runner.close()
  }
}

export type SuperMergeDetail = Readonly<{
  code: string
  phase: string
  message: string
  subject?: string
  next?: string
}>

/**
 * How git-super composed a `merged` gitlink: the base both sides descend from,
 * the two parents, and how many paths each side changed.
 *
 * The journal carries it because a `merged` pin is the one settlement whose
 * commit exists in no submitter's tree — the merge authored it — so the
 * evidence that admitted it has to be readable afterwards from the record
 * alone.
 */
export type SettledComposition = Readonly<{
  base: string
  parent: string
  pin: string
  files: Readonly<{ parent: number; pin: number }>
}>

export type SettledGitlink = Readonly<{
  path: string
  from: string
  to: string
  /**
   * `kept-behind` is a NESTED pin the planner classified and deliberately left
   * alone: behind its own main, recorded inside its parent component's commit,
   * which a root merge does not rewrite (24454 row 4). It is neither a
   * publication nor a refusal, so it is logged like any other settle row and
   * never reaches `publishing`.
   *
   * It is the NORMAL state for km/apps/maddoc, not a rare one -- maddoc main
   * moves independently of the pin km records -- so refusing it would refuse
   * every km change whose maddoc pin had not caught up.
   */
  /**
   * `merged` is a pin the MERGE composed (24951): the change's pin and the
   * component main the root records had diverged, their own merge was clean
   * (24977: merge-tree's answer, no longer file disjointness), and git-super
   * created the two-parent commit carrying both. It publishes
   * exactly as `kept-ahead` does, because the component main tip is that
   * commit's first parent, so advancing main to it is a fast-forward.
   */
  state: "raised" | "kept-ahead" | "kept-behind" | "as-written" | "left-off-main" | "merged" | "not-run"
  /** Present on a `merged` row and on no other. */
  composition?: SettledComposition
}>

/**
 * One nested child seen while git-super descended into an Ahead parent.
 *
 * An EQUAL child emits no settle row -- it is recorded as it stands, neither
 * published nor refused -- and Equal is the NORMAL state for a nested pin. So
 * without this, the commonest nested outcome is indistinguishable in the journal
 * from a walk that never ran (24454 row 2).
 */
export type SuperMergeDescentChild = Readonly<{
  path: string
  target: string
  state: "equal" | "kept-ahead" | "kept-behind" | "as-written" | "left-off-main"
}>

/** git-super's descent into one Ahead parent, and everything it classified there. */
export type SuperMergeDescent = Readonly<{
  parent: string
  parentTarget: string
  children: readonly SuperMergeDescentChild[]
}>

export type SuperMergeResult = Readonly<{
  state: "updated" | "unchanged" | "failed" | "unknown"
  partial: boolean
  commit?: string
  detail?: SuperMergeDetail
  gitlinks: readonly SettledGitlink[]
  /** Absent when no parent was Ahead. Optional so an older git-super still parses. */
  descents?: readonly SuperMergeDescent[]
  /** How long each phase of the merge took, in order. Optional so an older git-super still parses. */
  steps?: readonly SuperMergeStep[]
  /** Local Equal pin reads made without remote refresh during submit composition. */
  unboundedLocalMains?: readonly SuperMergeUnboundedLocalMain[]
}>

export type SuperMergeUnboundedLocalMain = Readonly<{ path: string; pin: string; store: string }>

/**
 * One phase of git-super's merge and its duration. `name` is whatever git-super
 * said: its README lists the names as a closed set, and a name outside it is
 * written to the journal as given, where the drift is seen, never dropped.
 */
export type SuperMergeStep = Readonly<{ name: string; ms: number }>

/**
 * Parse git-super's merge JSON. Exported because it is a pure reader with no
 * coverage of its own until now, and the only other way to exercise it is a
 * full queue round -- which is what let the descents field reach production
 * unparsed. Same shape as the other readers this package exports.
 */
export function readSuperMergeResult(value: unknown): SuperMergeResult {
  if (typeof value !== "object" || value === null) throw new Error("git-super merge JSON is not an object")
  const found = value as Record<string, unknown>
  if (!new Set(["updated", "unchanged", "failed", "unknown"]).has(String(found.state))) {
    throw new Error(`git-super merge JSON has invalid state ${String(found.state)}`)
  }
  if (typeof found.partial !== "boolean") throw new Error("git-super merge JSON has no boolean partial field")
  if (!Array.isArray(found.gitlinks)) throw new Error("git-super merge JSON has no gitlinks array")
  const gitlinks = found.gitlinks.map((row, index): SettledGitlink => {
    if (typeof row !== "object" || row === null) {
      throw new Error(`git-super merge gitlink ${String(index)} is not an object`)
    }
    const entry = row as Record<string, unknown>
    if (
      typeof entry.path !== "string" ||
      typeof entry.from !== "string" ||
      typeof entry.to !== "string" ||
      !new Set(["raised", "kept-ahead", "kept-behind", "as-written", "left-off-main", "merged", "not-run"]).has(
        String(entry.state),
      )
    ) {
      throw new Error(`git-super merge gitlink ${String(index)} is incomplete`)
    }
    // A `merged` row without its composition is a producer defect, not an older
    // git-super: the word and the evidence were added together, and the journal
    // this row feeds is the whole reason the word exists.
    if (entry.state === "merged") {
      return { ...entry, composition: readSuperMergeComposition(entry.composition, index) } as SettledGitlink
    }
    return entry as SettledGitlink
  })
  const detail = found.detail === undefined ? undefined : readSuperMergeDetail(found.detail)
  // ABSENT MEANS NONE, MALFORMED MEANS THROW -- the same contract the gitlinks
  // array gets. Absent is the normal case for a round with no Ahead parent and
  // for any git-super older than the field, so it cannot be an error; but a
  // present-and-wrong row is a producer defect and swallowing it would leave the
  // journal quietly incomplete, which is the exact failure this row exists for.
  const descents = found.descents === undefined ? undefined : readSuperMergeDescents(found.descents)
  // The same contract as descents: absent is an older git-super, malformed is a
  // producer defect that would leave the compose silent inside.
  const steps = found.steps === undefined ? undefined : readSuperMergeSteps(found.steps)
  const unboundedLocalMains =
    found.unboundedLocalMains === undefined ? undefined : readSuperMergeUnboundedLocalMains(found.unboundedLocalMains)
  return {
    state: found.state as SuperMergeResult["state"],
    partial: found.partial,
    ...(typeof found.commit === "string" ? { commit: found.commit } : {}),
    ...(detail === undefined ? {} : { detail }),
    gitlinks,
    ...(descents === undefined ? {} : { descents }),
    ...(steps === undefined ? {} : { steps }),
    ...(unboundedLocalMains === undefined ? {} : { unboundedLocalMains }),
  }
}

function readSuperMergeUnboundedLocalMains(value: unknown): readonly SuperMergeUnboundedLocalMain[] {
  if (!Array.isArray(value)) throw new Error("git-super merge unboundedLocalMains is not an array")
  return value.map((row, index): SuperMergeUnboundedLocalMain => {
    const entry = typeof row === "object" && row !== null ? (row as Record<string, unknown>) : undefined
    if (
      entry === undefined ||
      typeof entry.path !== "string" ||
      entry.path === "" ||
      typeof entry.pin !== "string" ||
      entry.pin === "" ||
      typeof entry.store !== "string" ||
      entry.store === ""
    ) {
      throw new Error(`git-super merge unboundedLocalMain ${String(index)} is incomplete`)
    }
    return { path: entry.path, pin: entry.pin, store: entry.store }
  })
}

function readSuperMergeSteps(value: unknown): readonly SuperMergeStep[] {
  if (!Array.isArray(value)) throw new Error("git-super merge steps is not an array")
  return value.map((row, index): SuperMergeStep => {
    const entry = typeof row === "object" && row !== null ? (row as Record<string, unknown>) : undefined
    if (
      entry === undefined ||
      typeof entry.name !== "string" ||
      entry.name === "" ||
      typeof entry.ms !== "number" ||
      !Number.isFinite(entry.ms) ||
      entry.ms < 0
    ) {
      throw new Error(`git-super merge step ${String(index)} is not a named, non-negative duration`)
    }
    return { name: entry.name, ms: entry.ms }
  })
}

function readSuperMergeComposition(value: unknown, index: number): SettledComposition {
  if (typeof value !== "object" || value === null) {
    throw new Error(`git-super merge gitlink ${String(index)} is merged without a composition`)
  }
  const found = value as Record<string, unknown>
  const files = found.files as Record<string, unknown> | undefined
  if (
    typeof found.base !== "string" ||
    typeof found.parent !== "string" ||
    typeof found.pin !== "string" ||
    typeof files !== "object" ||
    files === null ||
    typeof files.parent !== "number" ||
    typeof files.pin !== "number"
  ) {
    throw new Error(`git-super merge gitlink ${String(index)} has an incomplete composition`)
  }
  return {
    base: found.base,
    files: { parent: files.parent, pin: files.pin },
    parent: found.parent,
    pin: found.pin,
  }
}

function readSuperMergeDescents(value: unknown): readonly SuperMergeDescent[] {
  if (!Array.isArray(value)) throw new Error("git-super merge descents is not an array")
  return value.map((row, index): SuperMergeDescent => {
    if (typeof row !== "object" || row === null) {
      throw new Error(`git-super merge descent ${String(index)} is not an object`)
    }
    const entry = row as Record<string, unknown>
    if (typeof entry.parent !== "string" || typeof entry.parentTarget !== "string") {
      throw new Error(`git-super merge descent ${String(index)} is incomplete`)
    }
    if (!Array.isArray(entry.children)) {
      throw new Error(`git-super merge descent ${String(index)} has no children array`)
    }
    const children = entry.children.map((child, childIndex): SuperMergeDescentChild => {
      if (typeof child !== "object" || child === null) {
        throw new Error(`git-super merge descent ${String(index)} child ${String(childIndex)} is not an object`)
      }
      const found = child as Record<string, unknown>
      if (
        typeof found.path !== "string" ||
        typeof found.target !== "string" ||
        !new Set(["equal", "kept-ahead", "kept-behind", "as-written", "left-off-main"]).has(String(found.state))
      ) {
        throw new Error(`git-super merge descent ${String(index)} child ${String(childIndex)} is incomplete`)
      }
      return found as SuperMergeDescentChild
    })
    // An EMPTY children array is meaningful, not a degenerate row: it says the
    // walk descended into this parent and found no nested gitlink. Dropping it
    // would erase the difference between that and never descending at all.
    return { parent: entry.parent, parentTarget: entry.parentTarget, children }
  })
}

export function readSuperMergeDetail(value: unknown): SuperMergeDetail {
  if (typeof value !== "object" || value === null) throw new Error("git-super merge detail is not an object")
  const detail = value as Record<string, unknown>
  if (typeof detail.code !== "string" || typeof detail.phase !== "string" || typeof detail.message !== "string") {
    throw new Error("git-super merge detail has no code, phase, or message")
  }
  return {
    code: detail.code,
    phase: detail.phase,
    message: detail.message,
    ...(typeof detail.subject === "string" ? { subject: detail.subject } : {}),
    ...(typeof detail.next === "string" ? { next: detail.next } : {}),
  }
}
