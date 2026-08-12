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
export const YRD_BAY_PROTECTIONS_SCHEMA = "yrd-bay-protections/1" as const
export const YRD_BAY_PROTECTION_UNKNOWN_SOURCE = "live-process-cwd-unavailable" as const
export const HISTORICAL_BAY_OWNER_AGE_FLOOR_MS = 48 * 60 * 60 * 1_000

export function freshOriginBranchMissing(exitCode: number | null): boolean | undefined {
  if (exitCode === 0) return false
  if (exitCode === 1) return true
  return undefined
}

export type BayStatusClass = "owner" | "consumer" | "worktree" | "commits" | "stash" | "pr"

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
  /** Historical provision failure that never recorded a workspace path. */
  closedDegenerate?: boolean
  /** Parsed PID from `:<PID>` address when present; undefined if no handle. */
  ownerPid?: number
  /** The command checking status is the process that owns this Bay. */
  ownerIsCaller?: boolean
  /** Result of `kill -0` when ownerPid is set; undefined if not checked. */
  ownerAlive?: boolean
  /** Elapsed time since this Bay was opened. */
  ageMs?: number
  /** Host-owned live consumers that still reference this Bay. */
  protectedBy?: readonly string[]
  /** Host-owned consumer probes that could not establish absence. */
  protectionGaps?: readonly string[]
  /** `git status --porcelain` empty when path exists. */
  worktreeDirty?: boolean
  worktreeMissing?: boolean
  /** Tip is ancestor of origin/main OR patch-id-equivalent (caller decides). */
  tipLanded?: boolean
  /** Ref or equivalence proof that makes the tip durable. */
  tipDurableAt?: string
  tipLandedUnknown?: boolean
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
  /** Informational only — open PR does not block local removal. */
  openPrIds?: readonly string[]
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

export function parseYrdBayProtections(raw: string | undefined): readonly YrdBayProtection[] {
  if (raw === undefined) return []
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
  const rows = envelope["protections"]
  if (!Array.isArray(rows)) throw new TypeError(`${YRD_BAY_PROTECTIONS_ENV}.protections must be an array`)
  return rows.map((row, index) => {
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
}

export function protectionEvidenceForBay(
  protections: readonly YrdBayProtection[],
  bay: Readonly<{ id: string; path?: string }>,
): string[] {
  return protections
    .filter(
      (protection) =>
        protection.source !== YRD_BAY_PROTECTION_UNKNOWN_SOURCE &&
        (protection.bay === bay.id || (bay.path !== undefined && protection.path === bay.path)),
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

export function classifyBayStatus(facts: BayStatusFacts): BayStatusReport {
  if (facts.closedDegenerate === true) {
    const lines: readonly BayStatusLine[] = [
      { class: "owner", verdict: "PASS", evidence: "closed-degenerate Bay has no workspace owner" },
      { class: "consumer", verdict: "PASS", evidence: "closed-degenerate Bay has no workspace consumer" },
      { class: "worktree", verdict: "PASS", evidence: "closed-degenerate: no workspace path was ever recorded" },
      { class: "commits", verdict: "PASS", evidence: "closed-degenerate Bay has no workspace tip to preserve" },
      { class: "stash", verdict: "PASS", evidence: "closed-degenerate Bay has no workspace stash" },
      { class: "pr", verdict: "PASS", evidence: "closed-degenerate Bay can release its branch identity" },
    ]
    return {
      bay: facts.bayId,
      name: facts.name,
      branch: facts.branch,
      wrapper: "git",
      lines,
      exit: 0,
      safe: true,
    }
  }
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
      evidence: `pid ${facts.ownerPid} present but liveness not checked`,
    })
  } else if (facts.ownerAlive) {
    lines.push({
      class: "owner",
      verdict: "BLOCK",
      evidence: `owner pid ${facts.ownerPid} is live (kill -0 succeeded)`,
    })
  } else {
    lines.push({
      class: "owner",
      verdict: "PASS",
      evidence: `owner pid ${facts.ownerPid} is dead (kill -0 ESRCH)`,
    })
  }

  // consumer — a generic host seam; Yrd never imports the consumer's policy.
  if ((facts.protectedBy?.length ?? 0) > 0) {
    lines.push({
      class: "consumer",
      verdict: "BLOCK",
      evidence: (facts.protectedBy ?? []).join("; "),
    })
  } else if ((facts.protectionGaps?.length ?? 0) > 0) {
    lines.push({
      class: "consumer",
      verdict: "UNKNOWN",
      evidence: (facts.protectionGaps ?? []).join("; "),
    })
  } else {
    lines.push({
      class: "consumer",
      verdict: "PASS",
      evidence: "no live external consumer references this Bay",
    })
  }

  // worktree
  if (facts.path === undefined || facts.worktreeMissing === true) {
    lines.push({
      class: "worktree",
      verdict: facts.path === undefined ? "UNKNOWN" : "PASS",
      evidence:
        facts.path === undefined
          ? "no workspace path recorded"
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
  const unique = facts.uniquePatches ?? facts.aheadOfOrigin
  if (facts.remoteTrackingFresh === false) {
    lines.push({
      class: "commits",
      verdict: "UNKNOWN",
      evidence: "could not refresh and prune origin refs — commit durability is unknown",
    })
  } else if (facts.branchMissingFromOrigin === true) {
    // A missing origin ref is only safe when the tip carries nothing unique.
    // Absent + unique commits is the clean-but-ahead class this ladder exists
    // to catch: the work exists in exactly one place and nothing advertises it.
    if (unique === undefined) {
      lines.push({
        class: "commits",
        verdict: "UNKNOWN",
        evidence: "branch is absent from origin after a fresh pruned fetch — unique commits unmeasurable",
      })
    } else if (unique > 0) {
      lines.push({
        class: "commits",
        verdict: "BLOCK",
        evidence: `no advertised origin ref after a fresh pruned fetch — ${String(unique)} unique commit(s) at risk`,
      })
    } else {
      lines.push({
        class: "commits",
        verdict: "PASS",
        evidence: "branch is absent from origin after a fresh pruned fetch and the tip has no unique commits",
      })
    }
  } else if (facts.tipDurableAt !== undefined && facts.tipLanded !== true) {
    lines.push({
      class: "commits",
      verdict: "PASS",
      evidence:
        unique === undefined
          ? `tip is pushed to ${facts.tipDurableAt} — not merged, but durable`
          : `tip has ${unique} unique commit(s) pushed to ${facts.tipDurableAt} — not merged, but durable`,
    })
  } else if (facts.tipLandedUnknown === true || (facts.tipLanded === undefined && facts.aheadOfOrigin === undefined)) {
    lines.push({
      class: "commits",
      verdict: "UNKNOWN",
      evidence: "could not prove the tip is merged into origin/main (ancestry/patch-id unavailable)",
    })
  } else if (facts.tipLanded === true || facts.aheadOfOrigin === 0) {
    lines.push({
      class: "commits",
      verdict: "PASS",
      evidence:
        facts.tipDurableAt !== undefined
          ? `tip is durable at ${facts.tipDurableAt}`
          : facts.aheadOfOrigin === 0
            ? "tip is not ahead of origin/main"
            : "tip is merged (ancestor or patch-id equivalent of origin/main)",
    })
  } else {
    lines.push({
      class: "commits",
      verdict: "BLOCK",
      evidence:
        unique !== undefined
          ? `tip has ${unique} unique commit(s) on no advertised origin ref — at risk`
          : "tip is not merged and is on no advertised origin ref — at risk",
    })
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

  // pr — informational only
  const prs = facts.openPrIds ?? []
  lines.push({
    class: "pr",
    verdict: "PASS",
    evidence:
      prs.length === 0
        ? "no open PR on this branch (informational; open PR does not block local removal)"
        : `open PR(s) ${prs.join(", ")} (informational; work is on remote — does not block local removal)`,
  })

  const hasBlock = lines.some((line) => line.verdict === "BLOCK")
  const hasUnknown = lines.some((line) => line.verdict === "UNKNOWN")
  // Blocking classes for exit code exclude informational `pr`.
  const material = lines.filter((line) => line.class !== "pr")
  const materialBlock = material.some((line) => line.verdict === "BLOCK")
  const materialUnknown = material.some((line) => line.verdict === "UNKNOWN")

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

  // silence unused (pr still contributes to report lines)
  void hasBlock
  void hasUnknown

  return {
    bay: facts.bayId,
    name: facts.name,
    branch: facts.branch,
    ...(facts.path === undefined ? {} : { path: facts.path }),
    wrapper: "git",
    lines,
    exit,
    safe,
  }
}

export function formatBayStatusHuman(report: BayStatusReport): string {
  const header = `bay ${report.bay} ${report.name}  branch ${report.branch}  wrapper=${report.wrapper}  exit=${report.exit}  safe=${report.safe === null ? "unknown" : report.safe}`
  const body = report.lines
    .map((line) => `  ${line.class.padEnd(9)} ${line.verdict.padEnd(7)} ${line.evidence}`)
    .join("\n")
  return `${header}\n${body}`
}
