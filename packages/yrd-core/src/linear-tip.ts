export type CherryUnique = Readonly<{ sha: string; subject: string }>

/** Result of `git cherry <estate-pin> <submodule-main>` plus the two counts
 * the worker actually asks: of the commits this FF would carry, how many are
 * not yours, and how many are unreviewed. */
export type CherryDragged = Readonly<{
  unique: readonly CherryUnique[]
  notYours?: number
  unreviewed?: number
}>

/** The cherry denominator, stated once: the merged result and the authored-gitlink
 * projection both instruct a submodule-main FF, and both must name what that FF
 * would drag in. Omitted `dragged` prints the command; empty unique list is a
 * no-op; non-empty is the dragged set with N not-yours and M unreviewed. */
export function cherryFfInstruction(dragged?: CherryDragged): string {
  if (dragged === undefined) {
    return (
      `before fast-forwarding, print what the FF would drag in with ` +
      `'git cherry <estate-pin> <submodule-main>' (empty unique list = no-op; non-empty is the dragged set)`
    )
  }
  if (dragged.unique.length === 0) {
    return "FF is a no-op (git cherry unique list is empty)"
  }
  const lines = dragged.unique.map((row) => `${row.sha} ${row.subject}`).join("; ")
  const named = `dragged set (${dragged.unique.length} unique): ${lines}`
  if (dragged.notYours === undefined || dragged.unreviewed === undefined) return named
  return (
    `${named}. ` +
    `of the commits this FF would carry, ${dragged.notYours} are not yours and ${dragged.unreviewed} are unreviewed`
  )
}

/** Unique (`+`) rows of `git cherry -v <estate-pin> <submodule-main>`. Equivalent (`-`)
 * rows are already in the estate and are not the dragged set. */
export function parseCherryVerbose(stdout: string): readonly CherryUnique[] {
  const unique: CherryUnique[] = []
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^\+\s+([0-9a-f]+)\s+(.*)$/u.exec(line)
    if (match?.[1] === undefined) continue
    unique.push({ sha: match[1], subject: match[2] ?? "" })
  }
  return unique
}
