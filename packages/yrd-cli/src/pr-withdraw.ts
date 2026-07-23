import { execFileSync } from "node:child_process"
import { createElement } from "react"
import { isLivePR, type PR } from "@yrd/bay"
import { raiseFailure } from "@yrd/core"
import { cleanGitEnvironment } from "./git-environment.ts"
import { usage } from "./invocation.ts"
import { printResult } from "./output.tsx"
import { PRResultView } from "./queue-status-view.tsx"
import { projectPRTaskStatus } from "./task-status.ts"
import type { PruneGitFacts, YrdCliApp, YrdCliIO } from "./types.ts"

type JsonOption = Readonly<{ json?: boolean }>

const DEFAULT_WITHDRAW_REASON = "PR withdrawn"
const GIT_TIMEOUT_MS = 30_000

function jsonEnabled(options: JsonOption): boolean {
  return options.json === true
}

function short(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 12) : sha
}

/** Resolve one live PR or raise the typed refusal that names why it cannot be
 * withdrawn. An unknown selector and a terminal PR are both loud failures —
 * never a silent no-op. */
function requiredLivePr(app: YrdCliApp, selector: string): PR {
  const pr = app.bays.pr(selector)
  if (pr === undefined) {
    raiseFailure("refusal", "pr-missing", `yrd: no PR '${selector}'`)
  }
  if (!isLivePR(pr.status)) {
    raiseFailure("refusal", "pr-terminal", `yrd: PR '${pr.id}' is ${pr.status}; a terminal PR cannot be withdrawn`)
  }
  return pr as PR
}

/** Withdraw the selected live PR revision: emit pr/withdrawn with the recorded
 * reason and terminalize any Queue work still holding that authority. */
async function withdrawOne(app: YrdCliApp, id: string, reason: string | undefined, io: YrdCliIO): Promise<PR> {
  await app.bays.closePr({ pr: id, ...(reason === undefined ? {} : { reason }) })
  const withdrawn = app.bays.pr(id)
  if (withdrawn === undefined) throw new Error(`yrd: PR '${id}' disappeared after withdraw`)
  await app.queue.cancel({ prs: [id], by: io.runner ?? "operator", reason: reason ?? DEFAULT_WITHDRAW_REASON })
  return withdrawn as PR
}

export type WithdrawPrsOptions = JsonOption & Readonly<{ reason?: string }>

/** `yrd pr withdraw <selector...> [--reason <text>]` — withdraw live PRs,
 * recording the operator's reason on each pr/withdrawn event. Every selector is
 * validated before the first event is emitted so a mixed batch refuses whole. */
export async function withdrawPrs(
  app: YrdCliApp,
  selectors: readonly string[],
  options: WithdrawPrsOptions,
  io: YrdCliIO,
): Promise<void> {
  if (selectors.length === 0) usage("pr withdraw requires at least one PR selector")
  const reason = options.reason?.trim()
  if (options.reason !== undefined && (reason === undefined || reason === "")) {
    usage("--reason requires non-empty text")
  }
  const targets: PR[] = []
  const seen = new Set<string>()
  for (const selector of selectors) {
    const pr = requiredLivePr(app, selector)
    if (seen.has(pr.id)) usage(`pr withdraw selectors resolve to PR '${pr.id}' more than once`)
    seen.add(pr.id)
    targets.push(pr)
  }
  const withdrawn: PR[] = []
  for (const target of targets) {
    withdrawn.push(await withdrawOne(app, target.id, reason, io))
  }
  await printResult(
    io,
    jsonEnabled(options),
    {
      command: "pr.withdraw",
      ...(reason === undefined ? {} : { reason }),
      prs: withdrawn.map(projectPRTaskStatus),
    },
    createElement(PRResultView, { prs: withdrawn, runs: [] }),
  )
}

export type PrunePrsOptions = JsonOption & Readonly<{ dryRun?: boolean }>

type PruneChecks = Readonly<{
  headPresent: boolean
  ancestorOfBase?: boolean
  mergeTree?: "identical" | "divergent" | "conflicts" | "skipped"
}>

type PruneVerdict = "withdraw" | "would-withdraw" | "keep"

type PruneRow = Readonly<{
  pr: string
  branch: string
  revision: number
  headSha: string
  base: string
  baseSha: string
  checks: PruneChecks
  verdict: PruneVerdict
  reason?: string
  detail: string
}>

export type RecutPreflightVerdict = "SUBSUMED-WITHDRAW" | "RECUT" | "RECUT-FORCE" | "FRESH-NOOP"

export type RecutPreflightResult = Readonly<{
  command: "pr.recut.preflight"
  pr: string
  revision: number
  verdict: RecutPreflightVerdict
  evidence: Readonly<{
    headSha: string
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

function pruneLine(row: PruneRow): string {
  return `[${row.verdict}] ${row.pr} ${row.branch} r${row.revision}: head ${short(row.headSha)} vs ${row.base}@${short(row.baseSha)} — ${row.detail}`
}

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

/** Prove one PR's superseded verdict against its resolved base tip. Every
 * check that ran (and every check that was skipped, with why) is named in the
 * returned row so the operator sees exactly what was verified. */
async function pruneVerdict(pr: PR, baseSha: string, git: PruneGitFacts, dryRun: boolean): Promise<PruneRow> {
  const identity = {
    pr: pr.id,
    branch: pr.branch,
    revision: pr.revision,
    headSha: pr.headSha,
    base: pr.base,
    baseSha,
  }
  const checks = await contentChecks(pr.headSha, baseSha, git)
  if (!checks.headPresent) {
    return {
      ...identity,
      checks,
      verdict: "keep",
      detail: `head commit is not present in this repository; nothing could be verified — kept`,
    }
  }
  const superseded = checks.ancestorOfBase === true || checks.mergeTree === "identical"
  const checked = `ancestor-of-base=${checks.ancestorOfBase === true ? "yes" : "no"}, merge-tree=${
    checks.mergeTree === "skipped" ? "skipped (head already reachable)" : checks.mergeTree
  }`
  if (!superseded) {
    return { ...identity, checks, verdict: "keep", detail: `${checked} — live content not on base — kept` }
  }
  const reason = `superseded: content already in ${baseSha}`
  return {
    ...identity,
    checks,
    verdict: dryRun ? "would-withdraw" : "withdraw",
    reason,
    detail: `${checked} — ${reason}`,
  }
}

export type RecutPreflightOptions = JsonOption & Readonly<{ revision?: number; queue?: boolean }>

/** Classify one immutable PR revision against one resolved target without
 * creating refs, appending journal events, or calling the recutter. Exact
 * ancestry/tree equivalence authorizes withdrawal; patch-id is attribution
 * evidence only because stable patch IDs intentionally ignore whitespace. */
export async function preflightRecut(
  app: YrdCliApp,
  selector: string,
  options: RecutPreflightOptions,
  io: YrdCliIO,
): Promise<void> {
  if (options.revision !== undefined && (!Number.isInteger(options.revision) || options.revision < 1)) {
    usage("--revision must be a positive integer")
  }
  const pr = requiredLivePr(app, selector)
  const revision = options.revision ?? pr.revision
  const source = pr.revisions.find((candidate) => candidate.revision === revision)
  if (source === undefined) {
    raiseFailure("refusal", "revision-missing", `yrd: PR '${pr.id}' has no revision ${revision}`)
  }
  if (source.composition !== undefined) {
    raiseFailure(
      "refusal",
      "recut-preflight-composition",
      `yrd: PR '${pr.id}' revision ${source.revision} has composed source payloads; root-tree preflight cannot prove every source yet`,
    )
  }
  if (source.baseSha === undefined) {
    raiseFailure(
      "configuration",
      "recut-preflight-source-base-missing",
      `yrd: PR '${pr.id}' revision ${source.revision} has no immutable source base; preflight cannot classify its pin distance`,
    )
  }

  const cwd = io.cwd ?? process.cwd()
  const git = io.pruneGit === undefined ? createPruneGitFacts(cwd) : io.pruneGit(cwd)
  const targetBaseSha = (await git.resolveCommit(`origin/${pr.base}`)) ?? (await git.resolveCommit(pr.base))
  if (targetBaseSha === undefined) {
    raiseFailure(
      "configuration",
      "recut-preflight-target-missing",
      `yrd: PR '${pr.id}' targets base '${pr.base}' but neither 'origin/${pr.base}' nor '${pr.base}' resolves to a commit here`,
    )
  }
  const checks = await contentChecks(source.headSha, targetBaseSha, git)
  if (!checks.headPresent) {
    raiseFailure(
      "configuration",
      "recut-preflight-head-missing",
      `yrd: PR '${pr.id}' revision ${source.revision} head '${source.headSha}' is not present in this repository`,
    )
  }
  if (checks.ancestorOfBase === undefined || checks.mergeTree === undefined) {
    throw new Error(`yrd: preflight content proof for '${pr.id}' did not return complete evidence`)
  }
  const pinDistance =
    git.pinDistance ??
    raiseFailure(
      "configuration",
      "recut-preflight-git-facts",
      "yrd: installed PR Git facts do not provide pin-distance evidence",
    )
  const patchMatch =
    git.patchMatch ??
    raiseFailure(
      "configuration",
      "recut-preflight-git-facts",
      "yrd: installed PR Git facts do not provide patch-match evidence",
    )
  const distance = await pinDistance(source.baseSha, targetBaseSha)
  if (distance.sourceOnly !== 0) {
    raiseFailure(
      "refusal",
      "recut-preflight-base-diverged",
      `yrd: PR '${pr.id}' revision ${source.revision} base ${short(source.baseSha)} diverged from target ${short(targetBaseSha)} ` +
        `(source-only=${distance.sourceOnly}, target-only=${distance.targetOnly})`,
    )
  }
  const patch = await patchMatch(source.baseSha, source.headSha, targetBaseSha)
  const subsumed = checks.ancestorOfBase === true || checks.mergeTree === "identical"
  const requiresForce = app.queue.eligibility(pr.id).checks.status === "passed"
  const certifiedCurrentBase = distance.targetOnly === 0 && source.recut !== undefined
  const verdict: RecutPreflightVerdict = subsumed
    ? "SUBSUMED-WITHDRAW"
    : certifiedCurrentBase
      ? "FRESH-NOOP"
      : requiresForce
        ? "RECUT-FORCE"
        : "RECUT"
  const revisionFlag = options.revision === undefined ? "" : ` --revision ${source.revision}`
  const queueFlag = options.queue === true ? " --queue" : ""
  const recutCommand = `yrd pr recut ${pr.id}${revisionFlag}${queueFlag}`
  const next =
    verdict === "SUBSUMED-WITHDRAW"
      ? `yrd pr withdraw ${pr.id} --reason "superseded: content already in ${targetBaseSha}"`
      : verdict === "RECUT-FORCE"
        ? `${recutCommand} --force`
        : verdict === "RECUT"
          ? recutCommand
          : options.queue === true
            ? `yrd pr ready ${pr.id}`
            : `yrd pr view ${pr.id}`
  const evidence: RecutPreflightResult["evidence"] = {
    headSha: source.headSha,
    sourceBaseSha: source.baseSha,
    targetBase: pr.base,
    targetBaseSha,
    pinDistance: distance,
    patchId: patch.patchId ?? null,
    patchMatchTarget: patch.targetSha ?? null,
    ancestorOfTarget: checks.ancestorOfBase === true,
    tree: checks.mergeTree,
    certified: source.recut !== undefined,
    passingCheck: requiresForce,
    requestedQueue: options.queue === true,
  }
  const result: RecutPreflightResult = {
    command: "pr.recut.preflight",
    pr: pr.id,
    revision: source.revision,
    verdict,
    evidence,
    next,
  }
  await printResult(
    io,
    jsonEnabled(options),
    result,
    [
      `${verdict} ${pr.id} r${source.revision}`,
      `pin-distance: source-only=${distance.sourceOnly}, target-only=${distance.targetOnly} (${short(source.baseSha)}..${short(targetBaseSha)})`,
      `patch-id-match-target: ${patch.targetSha === undefined ? "none" : short(patch.targetSha)} (patch-id=${patch.patchId ?? "none"})`,
      `tree-proof: ancestor=${checks.ancestorOfBase === true ? "yes" : "no"}, merge-tree=${checks.mergeTree}`,
      `next: ${next}`,
    ].join("\n"),
  )
}

/** `yrd pr prune [--dry-run]` — scan every live PR against its base tip and
 * withdraw the ones whose content already landed (head is an ancestor of the
 * base, or merging head into the base reproduces the base tree exactly).
 * Prints one explicit verdict per PR; --dry-run emits no events. */
export async function prunePrs(app: YrdCliApp, options: PrunePrsOptions, io: YrdCliIO): Promise<void> {
  const dryRun = options.dryRun === true
  const cwd = io.cwd ?? process.cwd()
  const git = io.pruneGit === undefined ? createPruneGitFacts(cwd) : io.pruneGit(cwd)
  const live = app.bays
    .prs()
    .filter((pr) => isLivePR(pr.status))
    .toSorted((left, right) => left.id.localeCompare(right.id, "en", { numeric: true })) as readonly PR[]

  const rows: PruneRow[] = []
  for (const pr of live) {
    const baseSha = (await git.resolveCommit(`origin/${pr.base}`)) ?? (await git.resolveCommit(pr.base))
    if (baseSha === undefined) {
      raiseFailure(
        "configuration",
        "prune-base-missing",
        `yrd: PR '${pr.id}' targets base '${pr.base}' but neither 'origin/${pr.base}' nor '${pr.base}' resolves to a commit here`,
      )
    }
    rows.push(await pruneVerdict(pr, baseSha, git, dryRun))
  }

  const withdrawn: PR[] = []
  if (!dryRun) {
    for (const row of rows) {
      if (row.verdict !== "withdraw") continue
      withdrawn.push(await withdrawOne(app, row.pr, row.reason, io))
    }
  }

  const kept = rows.filter((row) => row.verdict === "keep").length
  const superseded = rows.length - kept
  const summary =
    rows.length === 0
      ? "pr prune: no live PRs to check"
      : `pr prune: checked ${rows.length} live PR${rows.length === 1 ? "" : "s"} — ${
          dryRun ? `${superseded} would be withdrawn` : `${superseded} withdrawn`
        }, ${kept} kept${dryRun ? " (dry run: no events emitted)" : ""}`
  await printResult(
    io,
    jsonEnabled(options),
    {
      command: "pr.prune",
      dryRun,
      checked: rows.map(({ detail: _detail, ...row }) => row),
      withdrawn: withdrawn.map(projectPRTaskStatus),
    },
    [...rows.map(pruneLine), summary].join("\n"),
  )
}

type GitCapture = Readonly<{ code: number; stdout: string }>

/** Real Git plumbing shared by `pr prune` and `pr recut --preflight`:
 * reachability, exact merge-result tree identity, graph distance, and
 * attribution-only stable patch matching. Only documented exit codes are
 * tolerated; anything else fails loud. */
export function createPruneGitFacts(cwd: string): PruneGitFacts {
  const git = (args: readonly string[], allowedExits: readonly number[], input?: string): GitCapture => {
    try {
      return {
        code: 0,
        stdout: execFileSync("git", ["-C", cwd, ...args], {
          encoding: "utf8",
          env: cleanGitEnvironment(process.env),
          ...(input === undefined ? {} : { input }),
          stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
          timeout: GIT_TIMEOUT_MS,
        }),
      }
    } catch (error) {
      const failed = error as Readonly<{ code?: unknown; status?: unknown; stdout?: unknown; stderr?: unknown }>
      if (failed.code === "ETIMEDOUT") {
        throw new Error(`yrd: git ${args.join(" ")} timed out after ${GIT_TIMEOUT_MS}ms`, { cause: error })
      }
      if (typeof failed.status === "number" && allowedExits.includes(failed.status)) {
        return { code: failed.status, stdout: typeof failed.stdout === "string" ? failed.stdout : "" }
      }
      const detail = typeof failed.stderr === "string" && failed.stderr.trim() !== "" ? `: ${failed.stderr.trim()}` : ""
      throw new Error(`yrd: git ${args.join(" ")} failed in '${cwd}'${detail}`)
    }
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
    mergeTree(baseSha: string, headSha: string): string | undefined {
      const result = git(["merge-tree", "--write-tree", baseSha, headSha], [1])
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
