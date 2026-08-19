import { raiseFailure } from "@yrd/core"

/**
 * The linear-root rule, stated once: a root carrier's tip must have at most
 * one parent. The submit path and the recut preflight gate both raise the
 * SAME refusal through here, so the rule cannot drift between the gate and
 * the landing path — a merge-tip carrier once ran the whole preflight gate
 * clean and was refused only at submit, after the gate investment
 * (2026-08-19). `identity` names what the caller inspected; `branch` names
 * the ref the author rebuilds.
 */
export function requireLinearRootTip(identity: string, branch: string, parents: readonly string[]): void {
  if (parents.length <= 1) return
  raiseFailure(
    "refusal",
    "merge-tip-carrier",
    `yrd: ${identity}. The submitted branch tip is a merge commit with ${parents.length} parents; ` +
      `Yrd requires a linear root carrier. linear rebuild required: merge inside the affected component repository, ` +
      `fast-forward that component's main, rebuild '${branch}' as one linear pin-bump commit, push it to origin, ` +
      `then run 'yrd pr submit ${branch}'`,
  )
}
