import { raiseFailure } from "./failure.ts"

/**
 * The linear-root rule, stated once: a root carrier's tip must have at most
 * one parent. Every entrance raises the SAME refusal through here — the
 * submit branch resolver, the active-Bay submit path, `pr ready`, and the
 * recut preflight gate — so the rule cannot drift between an entrance and
 * the landing path. A merge-tip carrier once ran a whole gate clean and was
 * refused only at submit, after the gate investment, and the active-Bay
 * entrance met no check at all (PR1364, 2026-08-19). `identity` names what
 * the caller inspected; `branch` names the ref the author rebuilds.
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
