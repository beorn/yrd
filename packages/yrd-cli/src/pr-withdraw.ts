import { execFileSync } from "node:child_process"
import { createElement } from "react"
import { currentPRRev, isLivePR, prDeliveryState, type PR } from "@yrd/bay"
import { raiseFailure } from "@yrd/core"
import { cleanGitEnvironment } from "./git-environment.ts"
import { usage } from "./invocation.ts"
import { printResult } from "./output.tsx"
import { PRResultView } from "./queue-status-view.tsx"
import { projectPRTaskStatus } from "./task-status.ts"
import type { PruneGitFacts, YrdCliApp, YrdCliIO } from "./types.ts"

type JsonOption = Readonly<{ json?: boolean }>

const DEFAULT_WITHDRAW_REASON = "PR withdrawn"

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
  const delivery = prDeliveryState(pr)
  if (!isLivePR(pr)) {
    raiseFailure("refusal", "pr-terminal", `yrd: PR '${pr.id}' is ${delivery}; a terminal PR cannot be withdrawn`)
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

function pruneLine(row: PruneRow): string {
  return `[${row.verdict}] ${row.pr} ${row.branch} r${row.revision}: head ${short(row.headSha)} vs ${row.base}@${short(row.baseSha)} — ${row.detail}`
}

/** Prove one PR's superseded verdict against its resolved base tip. Every
 * check that ran (and every check that was skipped, with why) is named in the
 * returned row so the operator sees exactly what was verified. */
async function pruneVerdict(pr: PR, baseSha: string, git: PruneGitFacts, dryRun: boolean): Promise<PruneRow> {
  const revision = currentPRRev(pr)
  const identity = {
    pr: pr.id,
    branch: pr.branch,
    revision: revision.n,
    headSha: revision.head,
    base: pr.base,
    baseSha,
  }
  const head = await git.resolveCommit(revision.head)
  if (head === undefined) {
    return {
      ...identity,
      checks: { headPresent: false },
      verdict: "keep",
      detail: `head commit is not present in this repository; nothing could be verified — kept`,
    }
  }
  const ancestor = await git.isAncestor(revision.head, baseSha)
  const mergeTree = ancestor
    ? ("skipped" as const)
    : await (async () => {
        const merged = await git.mergeTree(baseSha, revision.head)
        if (merged === undefined) return "conflicts" as const
        return merged === (await git.treeOf(baseSha)) ? ("identical" as const) : ("divergent" as const)
      })()
  const checks: PruneChecks = { headPresent: true, ancestorOfBase: ancestor, mergeTree }
  const superseded = ancestor || mergeTree === "identical"
  const checked = `ancestor-of-base=${ancestor ? "yes" : "no"}, merge-tree=${mergeTree === "skipped" ? "skipped (head already reachable)" : mergeTree}`
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
    .filter((pr) => isLivePR(pr))
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

/** Real Git plumbing for `pr prune`, mirroring the Queue's merge step: quiet
 * rev-parse for commit facts, merge-base --is-ancestor for reachability, and
 * merge-tree --write-tree for content identity. Only the exit codes each
 * plumbing command documents are tolerated; anything else fails loud. */
export function createPruneGitFacts(cwd: string): PruneGitFacts {
  const git = (args: readonly string[], allowedExits: readonly number[]): GitCapture => {
    try {
      return {
        code: 0,
        stdout: execFileSync("git", ["-C", cwd, ...args], {
          encoding: "utf8",
          env: cleanGitEnvironment(process.env),
          stdio: ["ignore", "pipe", "pipe"],
        }),
      }
    } catch (error) {
      const failed = error as Readonly<{ status?: unknown; stdout?: unknown; stderr?: unknown }>
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
  })
}
