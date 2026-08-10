import { prDeliveryState, type PR } from "@yrd/bay"
import { createPruneGitFacts } from "./pr-withdraw.ts"
import type { PruneGitFacts, YrdCliIO } from "./types.ts"

/** Delivery states whose label asserts something about CONTENT: that this PR's
 * revision never reached the base branch. That is a checkable claim, so the
 * surface checks it before printing it. Every other state is a claim about
 * PROCESS (queued, checking, awaiting an author) and needs no ancestry proof. */
const NOT_LANDED_CLAIMS = new Set(["withdrawn", "canceled"])

type JournalLandingCandidate = PR &
  Readonly<{
    integratedAt: string
    integration: NonNullable<PR["integration"]>
  }>

function hasJournalLanding(pr: PR): pr is JournalLandingCandidate {
  return pr.integratedAt !== undefined && pr.integration !== undefined
}

export type PrLanding = Readonly<{
  /** The recorded delivery state the ancestry proof contradicts. */
  recorded: string
  /** Base tip the head was proven to be reachable from. */
  baseSha: string
  headSha: string
  /** Typed code for the WHY column and the JSON row. */
  code: string
}>

export type PrLandingReconciliation = Readonly<{
  landings: ReadonlyMap<string, PrLanding>
  /** Bases whose tip or ancestry could not be read. Never swallowed: the caller
   * prints them beside the result so an unverified row is never mistaken for a
   * verified one. */
  warnings: readonly string[]
}>

export type PrLandingVerdict =
  | Readonly<{ status: "proven"; baseSha: string; landingSha: string }>
  | Readonly<{ status: "not-proven"; reason: "journal-missing" }>
  | Readonly<{
      status: "corrupt"
      reason: "journal-landing-not-on-base"
      baseSha: string
      landingSha: string
    }>
  | Readonly<{ status: "unknown"; reason: "base-unresolved"; base: string }>
  | Readonly<{ status: "unknown"; reason: "git-failed"; base: string; detail: string }>

export type PrLandingProofs = Readonly<{
  verdicts: ReadonlyMap<string, PrLandingVerdict>
  warnings: readonly string[]
}>

const EMPTY: PrLandingReconciliation = { landings: new Map(), warnings: [] }

async function landedCommits(git: PruneGitFacts, baseSha: string, commits: readonly string[]): Promise<Set<string>> {
  if (git.landedOnBase !== undefined) return new Set(await git.landedOnBase(baseSha, commits))
  const landed = new Set<string>()
  for (const commit of commits) {
    if ((await git.resolveCommit(commit)) === undefined) continue
    if (await git.isAncestor(commit, baseSha)) landed.add(commit)
  }
  return landed
}

function failureText(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message.trim() : String(error)
}

/** Resolve physical landedness at the CLI boundary. The repository decides:
 * the journal projection locates the exact landing commit, then reachability
 * from the live base proves it. The journal is a rebuildable index, never the
 * second half of an AND gate. The authored revision is deliberately irrelevant:
 * a regenerated carrier may never appear on the base even though the queue's
 * landing commit does.
 *
 * Every input receives a typed verdict. Missing journal evidence never probes
 * Git until a durable change-id can identify what to search for; the landing
 * ledger fills that index gap. A journal row disproved by Git is CORRUPT and
 * loud, while an unresolvable base remains UNKNOWN. */
export async function provePrLandings(prs: readonly PR[], io: YrdCliIO): Promise<PrLandingProofs> {
  const verdicts = new Map<string, PrLandingVerdict>()
  const candidates: JournalLandingCandidate[] = []
  for (const pr of prs) {
    if (hasJournalLanding(pr)) candidates.push(pr)
    else verdicts.set(pr.id, { status: "not-proven", reason: "journal-missing" })
  }
  if (candidates.length === 0) return { verdicts, warnings: [] }

  const cwd = io.cwd ?? process.cwd()
  const git = io.pruneGit === undefined ? createPruneGitFacts(cwd) : io.pruneGit(cwd)
  const byBase = new Map<string, JournalLandingCandidate[]>()
  for (const pr of candidates) {
    const grouped = byBase.get(pr.base)
    if (grouped === undefined) byBase.set(pr.base, [pr])
    else grouped.push(pr)
  }

  const warnings: string[] = []
  for (const [base, members] of byBase) {
    try {
      const baseSha = (await git.resolveCommit(`origin/${base}`)) ?? (await git.resolveCommit(base))
      if (baseSha === undefined) {
        for (const pr of members) verdicts.set(pr.id, { status: "unknown", reason: "base-unresolved", base })
        warnings.push(
          `yrd: base '${base}' did not resolve here, so ${members.length} journal landing` +
            `${members.length === 1 ? "" : "s"} could not be checked against it`,
        )
        continue
      }
      const commits = members.map((pr) => pr.integration.commit)
      const landed = await landedCommits(git, baseSha, commits)
      for (const pr of members) {
        const landingSha = pr.integration.commit
        if (landed.has(landingSha)) {
          verdicts.set(pr.id, { status: "proven", baseSha, landingSha })
          continue
        }
        verdicts.set(pr.id, { status: "corrupt", reason: "journal-landing-not-on-base", baseSha, landingSha })
        warnings.push(
          `yrd: journal records PR '${pr.id}' landing ${landingSha}, but base ${baseSha} does not contain it — rebuild the landing index and inspect repository integrity`,
        )
      }
    } catch (error) {
      const detail = failureText(error)
      for (const pr of members) verdicts.set(pr.id, { status: "unknown", reason: "git-failed", base, detail })
      warnings.push(`yrd: could not prove journal landings against base '${base}': ${detail}`)
    }
  }
  return { verdicts, warnings }
}

/** Reconcile every PR whose recorded state claims its content never landed.
 * The repository is authoritative: an indexed landing commit reachable from
 * the base proves delivery. A missing index row remains typed non-proof until
 * the landing ledger can locate the change by its durable trailer; an indexed
 * commit absent from the base is typed corruption, never a quiet fallback.
 *
 * The live specimen (22376): an author withdrawal arrived on top of a completed
 * merge, and `pr list` printed only the later write. An author who trusts
 * `withdrawn` re-cuts a branch already on main, and duplicate landings of the
 * same content are exactly what the ancestry model cannot clean up afterwards.
 *
 * Git is consulted only when there is such a claim to check, and at most twice
 * per distinct base regardless of how many rows the projection carries. */
export async function reconcilePrLandings(prs: readonly PR[], io: YrdCliIO): Promise<PrLandingReconciliation> {
  const candidates = prs.filter((pr) => NOT_LANDED_CLAIMS.has(prDeliveryState(pr)))
  if (candidates.length === 0) return EMPTY
  const proof = await provePrLandings(candidates, io)
  const landings = new Map<string, PrLanding>()
  for (const pr of candidates) {
    const verdict = proof.verdicts.get(pr.id)
    if (verdict?.status !== "proven") continue
    const recorded = prDeliveryState(pr)
    landings.set(pr.id, {
      recorded,
      baseSha: verdict.baseSha,
      headSha: verdict.landingSha,
      code: `${recorded}-after-landing`,
    })
  }
  return { landings, warnings: proof.warnings }
}
