import { adaptProcessGit, createProcess, type GitSyncReadCommand } from "@yrd/process"
import type { GitProcessResult } from "git-super/process"
import { createElement } from "react"
import {
} from "@yrd/bay"
import { raiseFailure } from "@yrd/core"
import { Queues, type Run } from "@yrd/queue"
import { ChangeResultView } from "./queue-status-view.tsx"
import { projectChangeTaskStatus } from "./task-status.ts"
import type { PruneGitFacts, YrdCliApp, YrdCliIO } from "./types.ts"

type JsonOption = Readonly<{ json?: boolean }>

const GIT_TIMEOUT_MS = 30_000
/** Commits per `rev-list` invocation, so a listing with thousands of candidate
 * heads cannot overflow the argument vector. */
const REV_LIST_BATCH = 400

function short(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 12) : sha
}

/** What closing this revision spends, in the operator's own terms: the exact
 * revision leaving delivery — so an operator acting on a STALE read sees the
 * mismatch here, before the spend, not after it (the PR78 specimen) — and the
 * one command that brings the payload back. */
/** Closing an unmerged change is not housekeeping: it spends the
 * payload identity, and every other branch is barred from that commit
 * afterwards. The verb reads reversible, so the spend is stated and
 * acknowledged BEFORE the first event — never a silent success. The
 * acknowledgement is an explicit flag, not a prompt, so a non-TTY caller gets
 * the same typed refusal instead of hanging. */
export type WithdrawPrsOptions = JsonOption & Readonly<{ reason?: string; burnPayload?: boolean }>

/** S7: record withdrawal retired with the store — a branch IS the change and
 * its "withdrawal" is two acts the author already owns: cancel the queued
 * work, and retire the standing consent. The refusal teaches both. The
 * spent-payload disclosure died with payload identity itself: content
 * re-enters through the derived lane on any branch, so there is nothing to
 * burn and nothing to reopen. */
export async function withdrawPrs(
  _app: YrdCliApp,
  _selectors: readonly string[],
  _options: WithdrawPrsOptions,
  _io: YrdCliIO,
  command: "pr.close" | "pr.withdraw" = "pr.withdraw",
): Promise<void> {
  const verb = command === "pr.close" ? "close" : "withdraw"
  raiseFailure(
    "refusal",
    `${verb}-retired`,
    `yrd: change ${verb} retired with the record store — cancel queued work with 'yrd cancel <branch>', ` +
      `and retire the standing submission by deleting its submit ref ` +
      `(git push <receiver> :refs/yrd/submit/<branch>) or shelving the branch ('yrd archive <branch>')`,
  )
}

type PruneChecks = Readonly<{
  headPresent?: boolean
  ancestorOfBase?: boolean
  mergeTree?: "identical" | "divergent" | "conflicts" | "skipped"
}>

export type RemergePreflightVerdict = "SUBSUMED-WITHDRAW" | "RECUT" | "RECUT-FORCE" | "FRESH-NOOP"

export type RemergePreflightResult = Readonly<{
  command: "pr.recut.preflight"
  pr: string
  revision: number
  verdict: RemergePreflightVerdict
  evidence: Readonly<{
    headSha: string
    proposedHeadSha?: string
    expectedCurrent?: Readonly<{ revision: number; headSha: string; track?: boolean }>
    sourceBaseSha: string
    targetBase: string
    targetBaseSha: string
    pinDistance: Readonly<{ sourceOnly: number; targetOnly: number }>
    patchId: string | null
    patchMatchTarget: string | null
    ancestorOfTarget: boolean
    tree: "identical" | "divergent" | "conflicts" | "skipped"
    certified: boolean
    passingCheck: boolean
    requestedQueue: boolean
  }>
  next: string
}>

async function contentChecks(headSha: string, baseSha: string, git: PruneGitFacts): Promise<PruneChecks> {
  const head = await git.resolveCommit(headSha)
  if (head === undefined) return { headPresent: false }
  const ancestor = await git.isAncestor(headSha, baseSha)
  const mergeTree = ancestor
    ? ("skipped" as const)
    : await (async () => {
        const merged = await git.mergeTree(baseSha, headSha)
        if (merged === undefined) return "conflicts" as const
        return merged === (await git.treeOf(baseSha)) ? ("identical" as const) : ("divergent" as const)
      })()
  return { headPresent: true, ancestorOfBase: ancestor, mergeTree }
}

export type RemergePreflightOptions = JsonOption &
  Readonly<{
    revision?: number
    queue?: boolean
    proposedHeadSha?: string
    expectedCurrent?: Readonly<{ revision: number; headSha: string; track?: boolean }>
  }>

/**
 * Is this head already contained in its target base — the SUBSUMED proof the
 * re-merge preflight existed to compute?
 *
 * The preflight itself (`preflightRemerge`) and its record resolver
 * (`requiredLivePr`) are gone with the change-record store: every other input
 * it weighed — the revision list, the recut certification, `needsAuthor`, the
 * passing-check force flag — was a field on the record, and the four verdicts
 * they produced collapsed to two once the in-process applier had no record-side
 * re-mint left to do. Only this question survives, and it never needed a record:
 * it is pure git.
 *
 * `true` means the content is already on the base, so resubmitting it would
 * merge the same payload twice — the outcome the ancestry model cannot clean up
 * afterwards, and the reason the runner escalates instead of redelivering.
 */
export async function headSubsumedByBase(
  headSha: string,
  base: string,
  io: YrdCliIO,
): Promise<Readonly<{ subsumed: boolean; targetBaseSha: string; tree: PruneChecks["mergeTree"] }>> {
  const cwd = io.cwd ?? process.cwd()
  const git = io.pruneGit === undefined ? createPruneGitFacts(cwd) : io.pruneGit(cwd)
  const targetBaseSha = (await git.resolveCommit(`origin/${base}`)) ?? (await git.resolveCommit(base))
  if (targetBaseSha === undefined) {
    raiseFailure(
      "configuration",
      "recut-preflight-target-missing",
      `yrd: base '${base}' resolves to no commit here (neither 'origin/${base}' nor '${base}'), so whether ` +
        `${headSha.slice(0, 12)} is already contained in it cannot be decided`,
    )
  }
  const checks = await contentChecks(headSha, targetBaseSha, git)
  if (checks.headPresent !== true) {
    raiseFailure(
      "configuration",
      "recut-preflight-head-missing",
      `yrd: head '${headSha}' is not present in this repository`,
    )
  }
  return {
    subsumed: checks.ancestorOfBase === true || checks.mergeTree === "identical",
    targetBaseSha,
    tree: checks.mergeTree,
  }
}

type GitCapture = Readonly<{ code: number; stdout: string }>

/** Real Git plumbing shared by the merge reconciler and the re-merge preflight:
 * reachability, exact merge-result tree identity, graph distance, and
 * attribution-only stable patch matching. Only documented exit codes are
 * tolerated; anything else fails loud. */
export function createPruneGitFacts(cwd: string): PruneGitFacts {
  const acceptedResult = (
    args: readonly string[],
    allowedExits: readonly number[],
    result: GitProcessResult,
  ): GitCapture => {
    if (result.timedOut === true) {
      throw new Error(`yrd: git ${args.join(" ")} timed out after ${GIT_TIMEOUT_MS}ms`)
    }
    if (result.code !== 0 && !allowedExits.includes(result.code)) {
      const detail = result.stderr.trim() || result.failure?.trim() || ""
      throw new Error(`yrd: git ${args.join(" ")} failed in '${cwd}'${detail === "" ? "" : `: ${detail}`}`)
    }
    if (result.failure !== undefined && result.code === 0) {
      throw new Error(`yrd: git ${args.join(" ")} failed in '${cwd}': ${result.failure}`)
    }
    return { code: result.code, stdout: result.stdout }
  }
  const localRead = (args: readonly string[]): GitSyncReadCommand => {
    const [verb, ...rest] = args
    switch (verb) {
      case "rev-parse":
      case "merge-base":
      case "rev-list":
      case "cat-file":
      case "diff":
      case "patch-id":
      case "log":
        return { verb, args: rest }
    }
    throw new Error(`yrd: Git command is not a typed local read: ${args.join(" ")}`)
  }
  const reader = adaptProcessGit(undefined, { timeoutMs: GIT_TIMEOUT_MS })
  const git = (args: readonly string[], allowedExits: readonly number[], input?: string): GitCapture =>
    acceptedResult(
      args,
      allowedExits,
      reader.readSync({ repo: cwd, command: localRead(args), ...(input === undefined ? {} : { stdin: input }) }),
    )
  const mutateGit = async (args: readonly string[], allowedExits: readonly number[]): Promise<GitCapture> => {
    await using process = createProcess()
    const result = await adaptProcessGit(process, { timeoutMs: GIT_TIMEOUT_MS }).run({
      repo: cwd,
      args,
    })
    return acceptedResult(args, allowedExits, result)
  }
  return Object.freeze({
    resolveCommit(ref: string): string | undefined {
      const result = git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], [1])
      const sha = result.stdout.trim()
      return result.code === 0 && sha !== "" ? sha : undefined
    },
    isAncestor(ancestor: string, descendant: string): boolean {
      return git(["merge-base", "--is-ancestor", ancestor, descendant], [1]).code === 0
    },
    parents(sha: string): readonly string[] {
      const raw = git(["rev-list", "--parents", "-n", "1", sha], []).stdout.trim().toLowerCase()
      const [commit, ...parents] = raw.split(/\s+/u)
      if (commit !== sha.toLowerCase()) {
        throw new Error(
          `yrd: git rev-list --parents of ${short(sha)} returned '${commit ?? "no commit"}', expected the commit itself`,
        )
      }
      return parents
    },
    async mergeTree(baseSha: string, headSha: string): Promise<string | undefined> {
      const args = ["merge-tree", "--write-tree", baseSha, headSha] as const
      // `--quiet` can report success for a real conflict when a sibling
      // directory entry also merges cleanly. Run the normal command and
      // discard stdout so conflict bodies never enter this process.
      const result = await mutateGit(args, [1])
      if (result.code !== 0) return undefined
      const tree = result.stdout.trim().split("\n", 1)[0]?.trim()
      if (tree === undefined || tree === "") {
        throw new Error(`yrd: git merge-tree of ${short(baseSha)} + ${short(headSha)} returned no tree OID`)
      }
      return tree
    },
    treeOf(sha: string): string {
      const tree = git(["rev-parse", `${sha}^{tree}`], []).stdout.trim()
      if (tree === "") throw new Error(`yrd: git rev-parse ${short(sha)}^{tree} returned no tree OID`)
      return tree
    },
    pinDistance(sourceBaseSha: string, targetBaseSha: string) {
      const raw = git(["rev-list", "--left-right", "--count", `${sourceBaseSha}...${targetBaseSha}`], []).stdout.trim()
      const [sourceOnlyRaw, targetOnlyRaw, ...extra] = raw.split(/\s+/u)
      const sourceOnly = Number(sourceOnlyRaw)
      const targetOnly = Number(targetOnlyRaw)
      if (
        extra.length !== 0 ||
        !Number.isSafeInteger(sourceOnly) ||
        sourceOnly < 0 ||
        !Number.isSafeInteger(targetOnly) ||
        targetOnly < 0
      ) {
        throw new Error(
          `yrd: git rev-list distance for ${short(sourceBaseSha)}...${short(targetBaseSha)} was invalid: '${raw}'`,
        )
      }
      return { sourceOnly, targetOnly }
    },
    mergedOnBase(baseSha: string, heads: readonly string[]): readonly string[] {
      const unique = [...new Set(heads)]
      if (unique.length === 0) return []
      // Two batched calls, independent of row count. `cat-file --batch-check`
      // names which commits this repository actually has; `rev-list --no-walk`
      // then lists the ones that are NOT reachable from the base tip. Merged is
      // the difference — never the absence of an object, which would let a
      // shallow or unfetched checkout invent merges.
      const presence = git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], [], `${unique.join("\n")}\n`)
      const resolved = new Map<string, string>()
      for (const [index, line] of presence.stdout.trim().split("\n").entries()) {
        const [name, type] = line.trim().split(/\s+/u)
        const requested = unique[index]
        if (requested === undefined || name === undefined || type !== "commit") continue
        resolved.set(name, requested)
      }
      if (resolved.size === 0) return []
      const present = [...resolved.keys()]
      const unmerged = new Set<string>()
      for (let start = 0; start < present.length; start += REV_LIST_BATCH) {
        const batch = present.slice(start, start + REV_LIST_BATCH)
        for (const line of git(["rev-list", "--no-walk", ...batch, "--not", baseSha], []).stdout.split("\n")) {
          const sha = line.trim()
          if (sha !== "") unmerged.add(sha)
        }
      }
      return present.filter((sha) => !unmerged.has(sha)).map((sha) => resolved.get(sha) ?? sha)
    },
    patchMatch(sourceBaseSha: string, headSha: string, targetBaseSha: string) {
      const diff = git(["diff", "--no-ext-diff", "--binary", sourceBaseSha, headSha], []).stdout
      const patchLine = git(["patch-id", "--stable"], [], diff).stdout.trim().split("\n", 1)[0]?.trim()
      const patchId = patchLine?.split(/\s+/u, 1)[0]
      if (patchId === undefined || patchId === "") return {}

      const targetLog = git(
        ["log", "--no-merges", "--format=%H", "--patch", `${sourceBaseSha}..${targetBaseSha}`],
        [],
      ).stdout
      const targetSha = git(["patch-id", "--stable"], [], targetLog)
        .stdout.trim()
        .split("\n")
        .map((line) => line.trim().split(/\s+/u))
        .find(([candidate]) => candidate === patchId)?.[1]
      return { patchId, ...(targetSha === undefined || targetSha === "" ? {} : { targetSha }) }
    },
  })
}
