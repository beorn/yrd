import { raiseFailure } from "@yrd/core"
import { friendlyRepositoryPath, parseQueueRunAddress } from "./queue-naming.ts"

/**
 * `<repository>:<base>#<number>` — the run reference that stays unambiguous
 * outside a single repository, for reports, pages and logs that span several.
 *
 * Yrd itself has no repository names. They are declared by the composition
 * host and injected at the CLI boundary (`normalizeYrdRepositoryAliasInvocation`),
 * and one Yrd process reads exactly ONE repository's journal. So the qualified
 * form is resolved at that boundary: the prefix picks the repository the
 * command runs against and is stripped, leaving the bare `<base>#<number>`
 * that `printedRunRefAliases` already teaches the resolver.
 *
 * The prefix is never dropped on a guess. Both repositories in a composition
 * can hold a run of the same number on a base of the same name, so silently
 * ignoring an unrecognized prefix would answer with the WRONG run — the one
 * failure mode this form exists to remove.
 */
export type QualifiedRunRef = Readonly<{ repository: string; run: string }>

/**
 * Only a token that carries a run NUMBER is a run reference. `topic:alpha` is
 * a filter term and `--reason "fixes:issue#12"` is prose; neither may be
 * rewritten or refused, so the number is what makes the form recognizable.
 * The base is a Git ref and may contain slashes, so only the first colon
 * splits, and a second colon disqualifies the token entirely.
 *
 * A repository name starts with a LETTER so this form cannot collide with the
 * watch legend's own `<label>:<base>#<number>` shorthand, whose prefix is a
 * digit. Reading `1:main#2173` as repository "1" turned a pasted watch row into
 * a generic not-found about a repository nobody declared; the digit form is
 * recognized separately below and refused by name.
 */
const QUALIFIED_RUN_REF = /^(?<repository>[A-Za-z][A-Za-z0-9._-]*):(?<run>[^\s:]+#\d+)$/u

/**
 * `<label>:<base>#<number>` — the compact form the watch prints when it covers
 * more than one queue. The label is display shorthand for a queue in ONE
 * rendered listing, not an identity any command can resolve: nothing outside
 * that pane knows which base label 2 stood for, and the next listing may number
 * the queues differently.
 */
const WATCH_LABELED_RUN_REF = /^(?<label>\d+):(?<run>[^\s:]+#\d+)$/u

export function parseQualifiedRunRef(token: string): QualifiedRunRef | undefined {
  const groups = QUALIFIED_RUN_REF.exec(token)?.groups
  if (groups?.repository === undefined || groups.run === undefined) return undefined
  return Object.freeze({ repository: groups.repository, run: groups.run })
}

/**
 * Refuse a reference this process cannot resolve, naming the bare form that
 * works here:
 *
 * - a WATCH LABEL prefix (`1:main#2173`), pasted from a multi-queue listing.
 *   The label belonged to that render, so no process can map it back to a
 *   queue — but the rest of the token is already the bare form.
 * - a REPOSITORY prefix (`pm:main#2711`) in a process that never received the
 *   host's repository declarations — standalone Yrd, or the `--repo`/`YRD_REPO`
 *   bypasses. Such a process cannot tell whether the prefix names itself or a
 *   sibling, and both may hold that run number, so it says so instead of
 *   resolving one of them.
 */
export function requireUnqualifiedRunSelector(selector: string, subcommand: string): string {
  const labeled = WATCH_LABELED_RUN_REF.exec(selector)?.groups
  if (labeled?.run !== undefined) {
    raiseFailure(
      "usage",
      "invalid-usage",
      `run reference '${selector}' carries the watch legend's queue label '${labeled.label ?? ""}', which names a queue only inside the listing that printed it; use the bare form '${labeled.run}'`,
    )
  }
  const qualified = parseQualifiedRunRef(selector)
  if (qualified === undefined) return selector
  raiseFailure(
    "usage",
    "invalid-usage",
    `qualified run reference '${selector}' needs the composition host's repository declarations, which this process did not receive (standalone Yrd, --repo and YRD_REPO all bypass the host adapter); use the bare form '${qualified.run}' here, or run 'yrd queue ${subcommand} ${qualified.repository} ${qualified.run}' from the composition host`,
  )
}

/**
 * Resolve the canonical `path@branch#N` run address (operator rulings
 * 2026-08-18, items 34/36) against THIS process's repository: the path half
 * picks the repository, and one Yrd process reads exactly one journal — so a
 * matching path strips to the bare `<branch>#<number>` the resolver accepts,
 * and a foreign path refuses loudly instead of answering about the wrong
 * repository (both repositories can hold a run of the same number).
 *
 * A token that is not the canonical form passes through untouched; with no
 * known repository root the address cannot be judged, so it refuses and
 * names the bare form that works anywhere.
 */
export function resolveCanonicalRunSelector(selector: string, repositoryRoot: string | undefined): string {
  const address = parseQueueRunAddress(selector)
  if (address === undefined) return selector
  if (repositoryRoot !== undefined) {
    const friendly = friendlyRepositoryPath(repositoryRoot)
    if (address.path === repositoryRoot || address.path === friendly) return address.run
    raiseFailure(
      "usage",
      "invalid-usage",
      `run address '${selector}' names repository '${address.path}', but this command reads '${friendly}'; ` +
        `run it from '${address.path}', or use the bare form '${address.run}' here`,
    )
  }
  raiseFailure(
    "usage",
    "invalid-usage",
    `run address '${selector}' names a repository, but this command resolved none to compare it against; ` +
      `use the bare form '${address.run}'`,
  )
}
