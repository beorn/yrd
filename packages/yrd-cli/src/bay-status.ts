/**
 * `yrd bay status` — single safety oracle for bay destroy/close (22290).
 *
 * Exit: 0 = safe to remove · 1 = not safe · 2 = cannot determine.
 * Unprovable must never collapse into safe (§ Fail Loud).
 *
 * Diagnostic only for each class: evidence lines explain PASS/BLOCK/UNKNOWN.
 * This does not close bays; `bay close` / `bay prune` call it.
 */

import type { YrdBayProtection } from "./types.ts"

export const YRD_BAY_PROTECTIONS_ENV = "YRD_BAY_PROTECTIONS" as const
export const YRD_BAY_PROTECTIONS_SCHEMA = "yrd-bay-protections/2" as const
export const YRD_BAY_PROTECTION_UNKNOWN_SOURCE = "live-process-cwd-unavailable" as const
export const YRD_BAY_PROTECTION_PROVIDERS = [
  "hab-launch-claims",
  "inhab-launch-records",
  "live-process-cwds",
  "herdr-live-sessions",
] as const
export const HISTORICAL_BAY_OWNER_AGE_FLOOR_MS = 48 * 60 * 60 * 1_000

/**
 * A host claim yrd proved cannot be consuming a workspace, carried as evidence
 * on the consumer PASS line rather than as a gap.
 *
 * `YRD_BAY_PROTECTION_UNKNOWN_SOURCE`'s sibling: both are synthesized by the
 * parser rather than declared by the host, and neither is a real protection, so
 * `protectionEvidenceForBay` must exclude both.
 */
export const YRD_BAY_PROTECTION_NOT_CONSUMED_SOURCE = "host-claim-not-consumed" as const

/**
 * The age past which an unreceipted host claim is NOT-CONSUMED.
 *
 * Deliberately the SAME number as the ownerless-Bay floor, not a second policy:
 * both answer one question — how long a host fact may go unconfirmed before its
 * absence is itself the fact. A claim whose receipt never appeared inside that
 * window did not survive to hold anything.
 */
export const UNRECEIPTED_CLAIM_NOT_CONSUMED_FLOOR_MS = HISTORICAL_BAY_OWNER_AGE_FLOOR_MS

export function freshOriginBranchMissing(exitCode: number | null): boolean | undefined {
  if (exitCode === 0) return false
  if (exitCode === 1) return true
  return undefined
}

export type BayStatusClass = "owner" | "consumer" | "worktree" | "commits" | "submodule" | "stash" | "pr"

export type BayStatusVerdict = "PASS" | "BLOCK" | "UNKNOWN"

export type BayStatusLine = Readonly<{
  class: BayStatusClass
  verdict: BayStatusVerdict
  evidence: string
}>

export type BayStatusReport = Readonly<{
  bay: string
  name: string
  branch: string
  path?: string
  /** Live queue SHA `pr create` will consume — not the historical provision pin. */
  effectiveBase?: Readonly<{ base: string; baseSha?: string }>
  /** wrapper attribution for composed stacks (22290). */
  wrapper: "git"
  lines: readonly BayStatusLine[]
  /** 0 safe · 1 not safe · 2 unprovable */
  exit: 0 | 1 | 2
  safe: boolean | null
}>

/** Facts gathered from the environment; pure classification consumes only these. */
export type BayStatusFacts = Readonly<{
  bayId: string
  name: string
  branch: string
  path?: string
  /** Historical provision failure that never recorded a worktree path. */
  closedDegenerate?: boolean
  /** Parsed PID from `:<PID>` address when present; undefined if no handle. */
  ownerPid?: number
  /** The command checking status is the process that owns this Bay. */
  ownerIsCaller?: boolean
  /** Whether the RECORDED owner is running when ownerPid is set; undefined when
   * its identity could not be established. Derived from one liveness verdict
   * (`@yrd/process` recordedPidLiveness), never from a bare `kill -0`: a pid is a
   * recycled resource, so "some process answers" is not "the owner is alive". */
  ownerAlive?: boolean
  /** That verdict's own words, so a Bay released because its pid was REUSED does
   * not report itself as an owner that exited. */
  ownerEvidence?: string
  /** Elapsed time since this Bay was opened. */
  ageMs?: number
  /** Host-owned live consumers that still reference this Bay. */
  protectedBy?: readonly string[]
  /** Host-owned consumer probes that could not establish absence. */
  protectionGaps?: readonly string[]
  /** Host claims proven NOT-CONSUMED by age. They block nothing, and they are
   * reported on the consumer PASS line so the reason this Bay stopped being
   * paged stays legible to whoever audits the census. */
  consumerNotConsumed?: readonly string[]
  /** `git status --porcelain` empty when path exists. */
  worktreeDirty?: boolean
  worktreeMissing?: boolean
  /** Tip is ancestor of origin/main OR patch-id-equivalent (caller decides). */
  tipMerged?: boolean
  /** Ref or equivalence proof that makes the tip durable. */
  tipDurableAt?: string
  /** Which immutable input supplied the commit proof rendered below. */
  tipProofSource?: "live worktree HEAD" | "persisted Bay head"
  tipMergedUnknown?: boolean
  /** Commits not on origin/main (ahead count) when computable. */
  aheadOfOrigin?: number
  /** Commits whose stable patch is absent from origin/main. */
  uniquePatches?: number
  /** Whether origin remote-tracking refs were refreshed and pruned for this report. */
  remoteTrackingFresh?: boolean
  /** A fresh origin census found no remote-tracking ref for this Bay branch. */
  branchMissingFromOrigin?: boolean
  /** Repo-global stash entries attributed to this bay (best-effort). */
  stashAttributed?: number
  stashUnknown?: boolean
  /** Live changes whose submit/repair path still consumes this Bay. */
  openChangeIds?: readonly string[]
  /** `BaysState.submits[branch]` still holds a live, standing `refs/yrd/submit/<branch>`
   * fact for this Bay's branch. The derived lane writes that ref directly and never
   * mints a Change record for it (yrd-bay/src/model.ts `recordLaneOwnsBranch`), so a
   * derived-lane submission is invisible to `openChangeIds` — closing this Bay would
   * destroy the workspace a live submission still depends on. */
  derivedLaneSubmitLive?: boolean
  /** Live queue SHA `pr create` will consume. */
  effectiveBase?: Readonly<{ base: string; baseSha?: string }>
  /** Every submodule under this Bay's worktree, at every depth (B399, 2026-08-30):
   * `yrd bay status B399` BLOCKed correctly on the root tip, but a second unique
   * object sat in the km submodule's bay-private gitdir on no km branch anywhere —
   * invisible, because the oracle asked only the root these questions. Omitted
   * (not `[]`) when the worktree itself is missing, mirroring `worktreeMissing`. */
  submodules?: readonly BayStatusSubmoduleFacts[]
  /** The submodule walk itself failed (not "found none" — could not tell).
   * Unprovable must never collapse into safe, so this is a loud UNKNOWN rather
   * than a silent empty `submodules` list. */
  submodulesUnknown?: boolean
}>

/**
 * One submodule's commit-durability facts, gathered and classified exactly like
 * the root worktree's — same ladder, same origin-freshness precondition — so a
 * commit that only the submodule holds is never a blind spot the root's own
 * cleanliness can paper over.
 */
export type BayStatusSubmoduleFacts = Readonly<{
  /** Displaypath from a recursive submodule walk (nested-safe, e.g. `km/apps/maddoc`). */
  path: string
  /** The submodule's own checked-out tip. */
  sha: string
  remoteTrackingFresh: boolean
  tipMerged?: boolean
  tipDurableAt?: string
  tipProofSource?: BayStatusFacts["tipProofSource"]
  tipMergedUnknown?: boolean
  aheadOfOrigin?: number
  uniquePatches?: number
}>

/** Extract trailing `:<digits>` PID from a bay name or BY address (22287). */
export function parseOwnerPid(...candidates: readonly (string | undefined)[]): number | undefined {
  for (const raw of candidates) {
    if (raw === undefined) continue
    const match = /:(\d+)$/u.exec(raw.trim())
    if (match?.[1] !== undefined) {
      const pid = Number(match[1])
      if (Number.isSafeInteger(pid) && pid > 0) return pid
    }
  }
  return undefined
}

export function parseYrdBayProtections(
  raw: string | undefined,
  options: Readonly<{ nowMs?: number }> = {},
): readonly YrdBayProtection[] {
  if (raw === undefined) return []
  const nowMs = options.nowMs ?? Date.now()
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new TypeError(`${YRD_BAY_PROTECTIONS_ENV} must contain valid JSON`, { cause: error })
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${YRD_BAY_PROTECTIONS_ENV} must be an object`)
  }
  const envelope = value as Record<string, unknown>
  if (envelope["schema"] !== YRD_BAY_PROTECTIONS_SCHEMA) {
    throw new TypeError(`${YRD_BAY_PROTECTIONS_ENV}.schema must be ${JSON.stringify(YRD_BAY_PROTECTIONS_SCHEMA)}`)
  }
  const providerRows = envelope["providers"]
  if (!Array.isArray(providerRows)) throw new TypeError(`${YRD_BAY_PROTECTIONS_ENV}.providers must be an array`)
  const seenProviders = new Set<string>()
  const unavailableProviders: YrdBayProtection[] = []
  for (const [index, row] of providerRows.entries()) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new TypeError(`${YRD_BAY_PROTECTIONS_ENV}.providers[${index}] must be an object`)
    }
    const provider = row as Record<string, unknown>
    const name = protectionProviderText(provider["provider"], index, "provider")
    if (!(YRD_BAY_PROTECTION_PROVIDERS as readonly string[]).includes(name)) {
      throw new TypeError(`${YRD_BAY_PROTECTIONS_ENV}.providers[${index}].provider is unknown: ${JSON.stringify(name)}`)
    }
    if (seenProviders.has(name)) {
      throw new TypeError(`${YRD_BAY_PROTECTIONS_ENV}.providers contains duplicate ${JSON.stringify(name)}`)
    }
    seenProviders.add(name)
    const status = protectionProviderText(provider["status"], index, "status")
    if (status !== "complete" && status !== "unavailable") {
      throw new TypeError(`${YRD_BAY_PROTECTIONS_ENV}.providers[${index}].status must be "complete" or "unavailable"`)
    }
    const evidence = protectionProviderText(provider["evidence"], index, "evidence")
    if (status === "unavailable") {
      // An unreachable provider is a REFUSAL, and a refusal the reader cannot act
      // on is half-written: it must name the provider (it always did) and the cure
      // (it did not). A host that declares no cure is told exactly which field to
      // set, rather than leaving every future reader to rediscover it.
      const cure = provider["cure"] === undefined ? undefined : protectionProviderText(provider["cure"], index, "cure")
      unavailableProviders.push({
        bay: "*",
        path: "*",
        source: YRD_BAY_PROTECTION_UNKNOWN_SOURCE,
        evidence:
          `provider ${name} unavailable: ${evidence} — ` +
          (cure === undefined
            ? `no cure declared; the host must set ${YRD_BAY_PROTECTIONS_ENV}.providers[].cure for ${name}`
            : `cure: ${cure}`),
      })
    }
  }
  const missingProviders = YRD_BAY_PROTECTION_PROVIDERS.filter((provider) => !seenProviders.has(provider))
  if (missingProviders.length > 0) {
    throw new TypeError(
      `${YRD_BAY_PROTECTIONS_ENV}.providers missing required provider(s): ${missingProviders.join(", ")}`,
    )
  }
  const rows = envelope["protections"]
  if (!Array.isArray(rows)) throw new TypeError(`${YRD_BAY_PROTECTIONS_ENV}.protections must be an array`)
  const protections = rows.map((row, index) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new TypeError(`${YRD_BAY_PROTECTIONS_ENV}.protections[${index}] must be an object`)
    }
    const protection = row as Record<string, unknown>
    return {
      bay: protectionText(protection["bay"], index, "bay"),
      path: protectionText(protection["path"], index, "path"),
      source: protectionText(protection["source"], index, "source"),
      evidence: protectionText(protection["evidence"], index, "evidence"),
    }
  })
  return [...protections, ...unavailableProviders, ...parseUnreceiptedClaims(envelope["claims"], seenProviders, nowMs)]
}

/**
 * Host claims the provider READ but whose consumption it could not confirm.
 *
 * A claim without a current receipt is a fact about that claim, not an outage of
 * the provider that read it. Collapsing the two is what produced an anonymous
 * `provider hab-launch-claims unavailable` that named no cure and refused an
 * entire Bay population indefinitely. Yrd owns what the fact means, and owns it
 * once:
 *
 * - past `UNRECEIPTED_CLAIM_NOT_CONSUMED_FLOOR_MS` the claim is dead and cannot
 *   be holding a workspace — NOT-CONSUMED, which blocks nothing;
 * - below the floor it is genuinely undecided, and says so naming its own claim
 *   id and the cure that would settle it.
 *
 * Both shapes address every Bay (`bay: "*"`): a claim with no receipt is exactly
 * a claim whose workspace reference is unknown, so it can name no single Bay.
 */
function parseUnreceiptedClaims(
  value: unknown,
  declaredProviders: ReadonlySet<string>,
  nowMs: number,
): YrdBayProtection[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError(`${YRD_BAY_PROTECTIONS_ENV}.claims must be an array`)
  return value.map((row, index): YrdBayProtection => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new TypeError(`${YRD_BAY_PROTECTIONS_ENV}.claims[${index}] must be an object`)
    }
    const claim = row as Record<string, unknown>
    const provider = claimText(claim["provider"], index, "provider")
    if (!declaredProviders.has(provider)) {
      throw new TypeError(
        `${YRD_BAY_PROTECTIONS_ENV}.claims[${index}].provider is not a declared provider: ${JSON.stringify(provider)}`,
      )
    }
    const id = claimText(claim["claim"], index, "claim")
    const cure = claimText(claim["cure"], index, "cure")
    const ageMs = nowMs - claimedAtMs(claim["claimedAt"], index)
    const floor = describeClaimAge(UNRECEIPTED_CLAIM_NOT_CONSUMED_FLOOR_MS)
    if (ageMs >= UNRECEIPTED_CLAIM_NOT_CONSUMED_FLOOR_MS) {
      return {
        bay: "*",
        path: "*",
        source: YRD_BAY_PROTECTION_NOT_CONSUMED_SOURCE,
        evidence: `${provider} claim ${id} went ${describeClaimAge(ageMs)} with no current receipt (floor ${floor}): NOT-CONSUMED`,
      }
    }
    return {
      bay: "*",
      path: "*",
      source: YRD_BAY_PROTECTION_UNKNOWN_SOURCE,
      evidence:
        `${provider} claim ${id} has no current receipt after ${describeClaimAge(ageMs)}, ` +
        `below the ${floor} NOT-CONSUMED floor — cure: ${cure}`,
    }
  })
}

/** Accepts an ISO-8601 instant or epoch milliseconds; refuses anything else. */
function claimedAtMs(value: unknown, index: number): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(
        `${YRD_BAY_PROTECTIONS_ENV}.claims[${index}].claimedAt must be a positive epoch-millisecond integer`,
      )
    }
    return value
  }
  const text = claimText(value, index, "claimedAt")
  const parsed = Date.parse(text)
  if (Number.isNaN(parsed)) {
    throw new TypeError(
      `${YRD_BAY_PROTECTIONS_ENV}.claims[${index}].claimedAt must be an ISO-8601 instant or epoch milliseconds: ${JSON.stringify(text)}`,
    )
  }
  return parsed
}

/** Whole hours: a claim age is compared against a 48h floor, so minutes are noise. */
function describeClaimAge(ms: number): string {
  return `${String(Math.max(0, Math.round(ms / 3_600_000)))}h`
}

function claimText(value: unknown, index: number, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${YRD_BAY_PROTECTIONS_ENV}.claims[${index}].${field} must be a non-empty string`)
  }
  return value
}

/** The parser's own rows, which are verdicts about the census rather than
 * host-declared protections. Every selector partitions on this set, so a new
 * synthetic source can never silently read as a live protection. */
const SYNTHETIC_PROTECTION_SOURCES: ReadonlySet<string> = new Set([
  YRD_BAY_PROTECTION_UNKNOWN_SOURCE,
  YRD_BAY_PROTECTION_NOT_CONSUMED_SOURCE,
])

export function protectionEvidenceForBay(
  protections: readonly YrdBayProtection[],
  bay: Readonly<{ id: string; path?: string }>,
): string[] {
  return protections
    .filter(
      (protection) =>
        !SYNTHETIC_PROTECTION_SOURCES.has(protection.source) &&
        (protection.bay === bay.id || (bay.path !== undefined && protection.path === bay.path)),
    )
    .map((protection) => protection.evidence)
}

/** Claims proven NOT-CONSUMED: reported, never blocking. */
export function protectionNotConsumedEvidenceForBay(
  protections: readonly YrdBayProtection[],
  bay: Readonly<{ id: string; path?: string }>,
): string[] {
  return protections
    .filter(
      (protection) =>
        protection.source === YRD_BAY_PROTECTION_NOT_CONSUMED_SOURCE &&
        (protection.bay === "*" ||
          protection.bay === bay.id ||
          (bay.path !== undefined && protection.path === bay.path)),
    )
    .map((protection) => protection.evidence)
}

export function protectionGapEvidenceForBay(
  protections: readonly YrdBayProtection[],
  bay: Readonly<{ id: string; path?: string }>,
): string[] {
  return protections
    .filter(
      (protection) =>
        protection.source === YRD_BAY_PROTECTION_UNKNOWN_SOURCE &&
        (protection.bay === "*" ||
          protection.bay === bay.id ||
          (bay.path !== undefined && protection.path === bay.path)),
    )
    .map((protection) => protection.evidence)
}

function protectionText(value: unknown, index: number, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${YRD_BAY_PROTECTIONS_ENV}.protections[${index}].${field} must be a non-empty string`)
  }
  return value
}

function protectionProviderText(value: unknown, index: number, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${YRD_BAY_PROTECTIONS_ENV}.providers[${index}].${field} must be a non-empty string`)
  }
  return value
}

function livePRLine(prs: readonly string[], branch: string, derivedLaneSubmitLive: boolean): BayStatusLine {
  if (prs.length > 0) {
    return {
      class: "pr",
      verdict: "BLOCK",
      evidence: `live change(s) ${prs.join(", ")} still references this Bay; submit/repair requires its workspace carrier`,
    }
  }
  if (derivedLaneSubmitLive) {
    return {
      class: "pr",
      verdict: "BLOCK",
      evidence: `derived-lane submission for ${branch} is still live (refs/yrd/submit) with no Change record; workspace still required`,
    }
  }
  return { class: "pr", verdict: "PASS", evidence: "no live change references this Bay" }
}

/**
 * The one consumer verdict.
 *
 * A generic host seam: Yrd never imports the consumer's policy, it only ranks
 * the evidence the host supplied. Both the ordinary and the closed-degenerate
 * ladder call this, so a Bay can never be classified by two consumer rules that
 * drift apart — they differ only in the words a clean result uses.
 *
 * Rank: a live reference BLOCKS; an unestablished absence is UNKNOWN; otherwise
 * the Bay passes, carrying any claim this census proved NOT-CONSUMED so a reader
 * can see which facts were ruled on rather than inferring it from silence.
 */
function consumerLine(facts: BayStatusFacts, cleanEvidence: string): BayStatusLine {
  const consumers = facts.protectedBy ?? []
  if (consumers.length > 0) return { class: "consumer", verdict: "BLOCK", evidence: consumers.join("; ") }
  const gaps = facts.protectionGaps ?? []
  if (gaps.length > 0) return { class: "consumer", verdict: "UNKNOWN", evidence: gaps.join("; ") }
  const notConsumed = facts.consumerNotConsumed ?? []
  return {
    class: "consumer",
    verdict: "PASS",
    evidence: notConsumed.length === 0 ? cleanEvidence : `${cleanEvidence}; ${notConsumed.join("; ")}`,
  }
}

/** The facts one commit-durability verdict is ranked from — the shape shared by
 * the root worktree and every submodule (see `commitDurabilityVerdict`). */
type CommitDurabilityFacts = Readonly<{
  remoteTrackingFresh?: boolean
  branchMissingFromOrigin?: boolean
  tipDurableAt?: string
  tipMerged?: boolean
  tipMergedUnknown?: boolean
  aheadOfOrigin?: number
  uniquePatches?: number
  tipProofSource?: BayStatusFacts["tipProofSource"]
}>

/**
 * The one commit-durability ladder: ancestor-or-patch-id-equivalent of
 * origin/main, reachable from some other advertised ref, or genuinely at risk.
 *
 * Factored out of `classifyBayStatus`'s inline "commits" block so the root
 * worktree and every submodule rank the SAME evidence (B399, 2026-08-30):
 * `yrd bay status B399` BLOCKed correctly on the root tip, but a second unique
 * object sat in the km submodule's bay-private gitdir on no km branch anywhere,
 * invisible, because only the root worktree was ever asked these questions.
 * `branchMissingFromOrigin` has no submodule analogue (a submodule carries no
 * bay-branch name of its own) — left `undefined`, this ladder degrades exactly
 * to the ancestor/patch-id/reachability checks a submodule needs.
 */
function commitDurabilityVerdict(facts: CommitDurabilityFacts): Readonly<{ verdict: BayStatusVerdict; evidence: string }> {
  const unique = facts.uniquePatches ?? facts.aheadOfOrigin
  const proofSource = facts.tipProofSource === undefined ? "" : ` (proof used ${facts.tipProofSource})`
  if (facts.remoteTrackingFresh === false) {
    return { verdict: "UNKNOWN", evidence: "could not refresh and prune origin refs — commit durability is unknown" }
  }
  if (facts.branchMissingFromOrigin === true) {
    // A missing origin ref is only safe when the tip carries nothing unique.
    // Absent + unique commits is the clean-but-ahead class this ladder exists
    // to catch: the work exists in exactly one place and nothing advertises it.
    if (unique === undefined) {
      return {
        verdict: "UNKNOWN",
        evidence: "branch is absent from origin after a fresh pruned fetch — unique commits unmeasurable",
      }
    }
    if (unique > 0) {
      return {
        verdict: "BLOCK",
        evidence: `no advertised origin ref after a fresh pruned fetch — ${String(unique)} unique commit(s) at risk${proofSource}`,
      }
    }
    return {
      verdict: "PASS",
      evidence: `branch is absent from origin after a fresh pruned fetch and the tip has no unique commits${proofSource}`,
    }
  }
  if (facts.tipDurableAt !== undefined && facts.tipMerged !== true) {
    return {
      verdict: "PASS",
      evidence:
        unique === undefined
          ? `tip is pushed to ${facts.tipDurableAt} — not merged, but durable${proofSource}`
          : `tip has ${unique} unique commit(s) pushed to ${facts.tipDurableAt} — not merged, but durable${proofSource}`,
    }
  }
  if (facts.tipMergedUnknown === true || (facts.tipMerged === undefined && facts.aheadOfOrigin === undefined)) {
    return { verdict: "UNKNOWN", evidence: "could not prove the tip is merged into origin/main (ancestry/patch-id unavailable)" }
  }
  if (facts.tipMerged === true || facts.aheadOfOrigin === 0) {
    return {
      verdict: "PASS",
      evidence:
        facts.tipDurableAt !== undefined
          ? `tip is durable at ${facts.tipDurableAt}${proofSource}`
          : facts.aheadOfOrigin === 0
            ? `tip is not ahead of origin/main${proofSource}`
            : `tip is merged (ancestor or patch-id equivalent of origin/main)${proofSource}`,
    }
  }
  return {
    verdict: "BLOCK",
    evidence:
      unique !== undefined
        ? `tip has ${unique} unique commit(s) on no advertised origin ref — at risk${proofSource}`
        : "tip is not merged and is on no advertised origin ref — at risk",
  }
}

/** A safe branch-name fragment from a bay name or submodule displaypath. */
function orphanSlug(value: string): string {
  return value.replaceAll(/[^\w.-]+/gu, "-")
}

/**
 * The push that actually preserves a BLOCKed tip, scoped to whichever
 * repository holds it — the root worktree's own origin, or (for a submodule)
 * that component's own origin, never the superproject's. Never a local ref: a
 * local `refs/yrd/closed/*`-shaped ref advertises nothing to anyone auditing
 * the remote, which is exactly the shape two seats independently mistook for
 * preservation on 2026-08-30 — the sha survived on nobody's fetch.
 *
 * The destination is an unqualified branch name (`<sha>:wip/orphan-<name>`),
 * never a fully-qualified `refs/heads/wip/orphan-<name>` — git resolves that
 * shorthand to the same ref, but the qualified form is the literal shape
 * `remedy-banned-actions-guard.test.ts` scans this whole tool surface for
 * (a hand-push to a submodule's `refs/heads/*`), and this text is printed
 * advice a human reads, not that guard's allowlisted internal actuation.
 */
function commitDurabilityCure(worktreePath: string, revision: string, branchIdentity: string): string {
  return `git -C '${worktreePath}' push origin ${revision}:wip/orphan-${orphanSlug(branchIdentity)}`
}

/** One commit-durability line, with its cure appended when it BLOCKs.
 * `identity` prefixes the evidence (empty for the root — it needs none). */
function commitDurabilityLine(
  bayClass: "commits" | "submodule",
  identity: string,
  /** `undefined` only when there is no live worktree path to `-C` into — the
   * evidence still names the risk, it just cannot hand back a runnable cure. */
  cure: string | undefined,
  facts: CommitDurabilityFacts,
): BayStatusLine {
  const { verdict, evidence } = commitDurabilityVerdict(facts)
  const named = identity === "" ? evidence : `${identity}: ${evidence}`
  return {
    class: bayClass,
    verdict,
    evidence: verdict === "BLOCK" && cure !== undefined ? `${named} — cure: ${cure}` : named,
  }
}

function classifyClosedDegenerateBay(facts: BayStatusFacts): BayStatusReport {
  const lines: readonly BayStatusLine[] = [
    { class: "owner", verdict: "PASS", evidence: "closed-degenerate Bay has no workspace owner" },
    consumerLine(facts, "closed-degenerate Bay has no live external consumer reference"),
    { class: "worktree", verdict: "PASS", evidence: "closed-degenerate: no worktree path was ever recorded" },
    { class: "commits", verdict: "PASS", evidence: "closed-degenerate Bay has no workspace tip to preserve" },
    { class: "stash", verdict: "PASS", evidence: "closed-degenerate Bay has no workspace stash" },
    livePRLine(facts.openChangeIds ?? [], facts.branch, facts.derivedLaneSubmitLive === true),
  ]
  const blocked = lines.some((line) => line.verdict === "BLOCK")
  const unknown = lines.some((line) => line.verdict === "UNKNOWN")
  return {
    bay: facts.bayId,
    name: facts.name,
    branch: facts.branch,
    wrapper: "git",
    lines,
    exit: blocked ? 1 : unknown ? 2 : 0,
    safe: blocked ? false : unknown ? null : true,
  }
}

export function classifyBayStatus(facts: BayStatusFacts): BayStatusReport {
  if (facts.closedDegenerate === true) return classifyClosedDegenerateBay(facts)
  const lines: BayStatusLine[] = []

  // owner
  if (
    facts.ownerPid === undefined &&
    facts.ageMs !== undefined &&
    facts.ageMs >= HISTORICAL_BAY_OWNER_AGE_FLOOR_MS &&
    (facts.protectedBy?.length ?? 0) === 0
  ) {
    lines.push({
      class: "owner",
      verdict: "PASS",
      evidence: "no owner token or live host consumer after the 48h migration floor",
    })
  } else if (facts.ownerPid === undefined) {
    lines.push({
      class: "owner",
      verdict: "UNKNOWN",
      evidence: "no :<PID> address on bay name/BY and the 48h migration floor is not proven",
    })
  } else if (facts.ownerIsCaller === true) {
    lines.push({
      class: "owner",
      verdict: "PASS",
      evidence: `this Yrd process owns the Bay (pid ${facts.ownerPid})`,
    })
  } else if (facts.ownerAlive === undefined) {
    lines.push({
      class: "owner",
      verdict: "UNKNOWN",
      evidence: facts.ownerEvidence ?? `pid ${facts.ownerPid} present but liveness not checked`,
    })
  } else if (facts.ownerAlive) {
    lines.push({
      class: "owner",
      verdict: "BLOCK",
      evidence: facts.ownerEvidence ?? `owner pid ${facts.ownerPid} is live`,
    })
  } else {
    lines.push({
      class: "owner",
      verdict: "PASS",
      evidence: facts.ownerEvidence ?? `owner pid ${facts.ownerPid} is not running`,
    })
  }

  lines.push(consumerLine(facts, "no live external consumer references this Bay"))

  // worktree
  if (facts.path === undefined || facts.worktreeMissing === true) {
    lines.push({
      class: "worktree",
      verdict: facts.path === undefined ? "UNKNOWN" : "PASS",
      evidence:
        facts.path === undefined
          ? "no worktree path recorded"
          : `path missing on disk (${facts.path}) — nothing local to lose`,
    })
  } else if (facts.worktreeDirty === undefined) {
    lines.push({
      class: "worktree",
      verdict: "UNKNOWN",
      evidence: `could not read git status in ${facts.path}`,
    })
  } else if (facts.worktreeDirty) {
    lines.push({
      class: "worktree",
      verdict: "BLOCK",
      evidence: `dirty worktree at ${facts.path} (git status --porcelain non-empty)`,
    })
  } else {
    lines.push({
      class: "worktree",
      verdict: "PASS",
      evidence: `clean worktree at ${facts.path}`,
    })
  }

  // commits — clean tree alone is NOT enough (22290 sample: 22/25 clean-but-ahead)
  const rootCure = facts.path === undefined ? undefined : commitDurabilityCure(facts.path, "HEAD", facts.name)
  lines.push(commitDurabilityLine("commits", "", rootCure, facts))

  // submodules — the oracle's universe used to stop at the root worktree
  // (B399, 2026-08-30): `yrd bay status B399` BLOCKed correctly on the root
  // tip, but a second unique object sat in the km submodule's bay-private
  // gitdir on no km branch anywhere, invisible to a classifier fed root facts
  // only. Every submodule ranks through the SAME ladder as the root's commits
  // line above; one BLOCK anywhere among them makes the whole Bay BLOCK via
  // the fold below, exactly like any other class.
  if (facts.submodulesUnknown === true) {
    lines.push({
      class: "submodule",
      verdict: "UNKNOWN",
      evidence: "could not enumerate this Bay's submodules",
    })
  }
  for (const submodule of facts.submodules ?? []) {
    const identity = `${submodule.path}@${submodule.sha.slice(0, 12)}`
    const cure =
      facts.path === undefined
        ? undefined
        : commitDurabilityCure(`${facts.path}/${submodule.path}`, submodule.sha, `${facts.name}-${submodule.path}`)
    lines.push(commitDurabilityLine("submodule", identity, cure, submodule))
  }

  // stash
  if (facts.stashUnknown === true) {
    lines.push({
      class: "stash",
      verdict: "UNKNOWN",
      evidence: "could not inspect git stash list",
    })
  } else if ((facts.stashAttributed ?? 0) > 0) {
    lines.push({
      class: "stash",
      verdict: "BLOCK",
      evidence: `${facts.stashAttributed} stash entr(y/ies) attributed to this bay`,
    })
  } else {
    lines.push({
      class: "stash",
      verdict: "PASS",
      evidence: "no stash entries attributed to this bay",
    })
  }

  // pr — submit and repair still consume the Bay until an immutable carrier
  // replaces that dependency, so a live change is a hard inbound reference.
  lines.push(livePRLine(facts.openChangeIds ?? [], facts.branch, facts.derivedLaneSubmitLive === true))

  const materialBlock = lines.some((line) => line.verdict === "BLOCK")
  const materialUnknown = lines.some((line) => line.verdict === "UNKNOWN")

  let exit: 0 | 1 | 2
  let safe: boolean | null
  if (materialBlock) {
    exit = 1
    safe = false
  } else if (materialUnknown) {
    exit = 2
    safe = null
  } else {
    exit = 0
    safe = true
  }

  return {
    bay: facts.bayId,
    name: facts.name,
    branch: facts.branch,
    ...(facts.path === undefined ? {} : { path: facts.path }),
    ...(facts.effectiveBase === undefined ? {} : { effectiveBase: facts.effectiveBase }),
    wrapper: "git",
    lines,
    exit,
    safe,
  }
}

export function formatBayStatusHuman(report: BayStatusReport): string {
  const base =
    report.effectiveBase === undefined
      ? ""
      : `  base ${report.effectiveBase.base}${report.effectiveBase.baseSha === undefined ? "" : `@${report.effectiveBase.baseSha.slice(0, 12)}`}`
  const header = `bay ${report.bay} ${report.name}  branch ${report.branch}${base}  wrapper=${report.wrapper}  exit=${report.exit}  safe=${report.safe === null ? "unknown" : report.safe}`
  const body = report.lines
    .map((line) => `  ${line.class.padEnd(9)} ${line.verdict.padEnd(7)} ${line.evidence}`)
    .join("\n")
  return `${header}\n${body}`
}
