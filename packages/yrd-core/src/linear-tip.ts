import { raiseFailure } from "./failure.ts"

export type CherryUnique = Readonly<{ sha: string; subject: string }>

/** Result of `git cherry <estate-pin> <component-main>` plus the two counts
 * the worker actually asks: of the commits this FF would carry, how many are
 * not yours, and how many are unreviewed. */
export type CherryDragged = Readonly<{
  unique: readonly CherryUnique[]
  notYours: number
  unreviewed: number
}>

/**
 * The linear-root rule, stated once: a root carrier's tip must have at most
 * one parent. Every entrance raises the SAME refusal through here — the
 * submit branch resolver, the active-Bay submit path, `pr ready`, and the
 * recut preflight gate — so the rule cannot drift between an entrance and
 * the landing path. A merge-tip carrier once ran a whole gate clean and was
 * refused only at submit, after the gate investment, and the active-Bay
 * entrance met no check at all (PR1364, 2026-08-19). `identity` names what
 * the caller inspected; `branch` names the ref the author rebuilds.
 * `dragged` is the cherry unique list when the caller already has it; omitted
 * means print the command so the worker can run it.
 */
export function requireLinearRootTip(
  identity: string,
  branch: string,
  parents: readonly string[],
  dragged?: CherryDragged,
): void {
  if (parents.length <= 1) return
  raiseFailure("refusal", "merge-tip-carrier", linearRebuildMessage(identity, branch, parents.length, dragged))
}

/** The cherry denominator, stated once: merge-tip-carrier and the authored-gitlink
 * projection both instruct a component-main FF, and both must name what that FF
 * would drag in. Omitted `dragged` prints the command; empty unique list is a
 * no-op; non-empty is the dragged set with N not-yours and M unreviewed. */
export function cherryFfInstruction(dragged?: CherryDragged): string {
  if (dragged === undefined) {
    return (
      `before fast-forwarding, print what the FF would drag in with ` +
      `'git cherry <estate-pin> <component-main>' (empty unique list = no-op; non-empty is the dragged set)`
    )
  }
  if (dragged.unique.length === 0) {
    return "FF is a no-op (git cherry unique list is empty)"
  }
  const lines = dragged.unique.map((row) => `${row.sha} ${row.subject}`).join("; ")
  return (
    `dragged set (${dragged.unique.length} unique): ${lines}. ` +
    `of the commits this FF would carry, ${dragged.notYours} are not yours and ${dragged.unreviewed} are unreviewed`
  )
}

function linearRebuildMessage(
  identity: string,
  branch: string,
  parentCount: number,
  dragged: CherryDragged | undefined,
): string {
  const prefix =
    `yrd: ${identity}. The submitted branch tip is a merge commit with ${parentCount} parents; ` +
    `Yrd requires a linear root carrier. linear rebuild required: `
  const suffix =
    `then merge inside the affected component repository, ` +
    `fast-forward that component's main, rebuild '${branch}' as one linear pin-bump commit, push it to origin, ` +
    `then run 'yrd pr submit ${branch}'`
  return prefix + `${cherryFfInstruction(dragged)}; ` + suffix
}
