/**
 * `@yrd/issues` — the issues interface's contract, shared by Yrd's argv runner and Hightea's cloud provider so the two
 * can never disagree about a verb, a placeholder, a replay key, or the phase-3 pair's payloads (@cto 37a8972c).
 *
 * Pure by construction: no IO, no argv runner, no YAML reader. Reading `issues.yml` and running a provider stay in
 * their owners.
 */

export {
  ISSUES_VERBS,
  ISSUES_VERB_NAMES,
  ISSUES_WRITE_VERBS,
  ISSUES_CLOSE_REASONS,
  ISSUES_EVENT_KINDS,
  isIssuesVerb,
  allowedPlaceholders,
  type IssuesVerb,
} from "./verbs.ts"

export { checkIssuesArgv, substituteArgv, type IssuesArgvRefusal } from "./argv.ts"

export type { IssuesStatePayload, IssuesWatchChange, IssuesWatchAnswer } from "./payloads.ts"
