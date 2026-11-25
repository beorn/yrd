/**
 * The issues interface's verb vocabulary: the twelve original verbs (design `issues-interface` rev 6 § 4, @cto ruling
 * 0e9e794e) plus the phase-3 verb `state` (@cto 37a8972c, hh #37445).
 *
 * `watch` is deliberately absent (@cto 8dfe1bd3): a verb with no caller is a guess. Hightea reads host items as an AHP
 * records channel over `km://` (030acd32 A) and takes GitHub changes from its webhook plus the timed re-list, so no
 * Hightea caller needs `watch` today. It returns with the first argv caller that does, taking `<since>` as the
 * provider store's own position (km's journal seq, Hightea's row seq), never a per-watch counter.
 *
 * This module is pure: no IO, no argv runner, no YAML reader, no decision made from issue state. Both consumers import
 * it — Yrd's argv runner (`packages/yrd-cli/src/issues/declaration.ts`) and Hightea's cloud provider — so the two
 * providers can never disagree about what a verb is or which verbs carry a replay key.
 */

/** Each verb's positional operands, in order. `<id>` is the write verbs' replay key and comes from `--id`. */
export const ISSUES_VERBS = {
  resolve: ["raw"],
  view: ["key"],
  list: [],
  create: ["title", "body"],
  comment: ["key", "text"],
  close: ["key", "reason"],
  reopen: ["key"],
  assign: ["key", "seat"],
  unassign: ["key", "seat"],
  // One item event on the issue a change names (@cto 721b42d7, #31194): <raw> is the change's issue value exactly as
  // Yrd holds it, resolved by the provider; <source> is `<repository>@<sha>`; <text> is the same on every replay.
  event: ["raw", "kind", "source", "text"],
  "list-page": ["page"],
  // 38182 (@cto 17:49Z): the long-lived form of `list-page`. It takes no operand — the frames carry their own
  // page requests — and a project opts in by declaring its argv. Yrd runs it once and hands its stdio unchanged.
  "list-page-serve": [],
  // #37838 slice 2: the journal a row's owner was last seen writing, from a cutoff in epoch milliseconds. It is a
  // declared argv beside the reads (@cto 0a53b47f), so the provider stays the only thing that knows the store.
  activity: ["cutoff"],
  // #37445 (@cto 37a8972c): move one issue between the board's states. A WRITE, so it carries <id> and a replay is a
  // no-op at the provider; the provider refuses, by name, a state its tracker does not declare and an unknown key.
  state: ["key", "state"],
} as const satisfies Record<string, readonly string[]>

export type IssuesVerb = keyof typeof ISSUES_VERBS

export const ISSUES_VERB_NAMES = Object.keys(ISSUES_VERBS) as IssuesVerb[]

/** The verbs that change the store; each must carry `<id>` so a replay is a no-op at the provider. */
export const ISSUES_WRITE_VERBS: ReadonlySet<IssuesVerb> = new Set<IssuesVerb>([
  "create",
  "comment",
  "close",
  "reopen",
  "assign",
  "unassign",
  "event",
  "state",
])

/** GitHub's pair (`gh issue close --reason`). */
export const ISSUES_CLOSE_REASONS = ["completed", "not-planned"] as const

/** The change transitions an `event` records; never `closed`, whose one writer is the close path (#29630). */
export const ISSUES_EVENT_KINDS = ["merged", "failed", "withdrawn"] as const

export function isIssuesVerb(value: string): value is IssuesVerb {
  return Object.hasOwn(ISSUES_VERBS, value)
}

/** The placeholders a verb's argv may carry: its operands, plus `<id>` on a write verb. */
export function allowedPlaceholders(verb: IssuesVerb): readonly string[] {
  if (verb === "assign") return [...ISSUES_VERBS.assign, "id", "expected-owner", "requester"]
  return ISSUES_WRITE_VERBS.has(verb) ? [...ISSUES_VERBS[verb], "id"] : ISSUES_VERBS[verb]
}
