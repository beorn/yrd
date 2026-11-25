/**
 * The issues declaration: `issues.yml` at a project's root, whose top-level keys ARE the verbs and whose values
 * are argv lists (design `issues-interface` rev 6 § 4, @cto ruling 0e9e794e). This module only reads the text
 * into a validated table; it never runs anything and never decides from issue state.
 *
 * The verb vocabulary and the argv rules are not owned here: they live in `@yrd/issues`, which Hightea's cloud
 * provider imports too, and are re-exported below so this stays the one import path for the runner (@cto 37a8972c).
 */

import { checkIssuesArgv, ISSUES_VERB_NAMES, isIssuesVerb, type IssuesVerb } from "@yrd/issues"

/** The stable codes `yrd issues` refuses or fails with. The subject follows the code. */
export const ISSUES_CODES = {
  badArguments: "yrd-issues-bad-arguments",
  notARepository: "yrd-issues-not-a-repository",
  originNotARepository: "yrd-issues-origin-not-a-repository",
  originUnsupported: "yrd-issues-origin-unsupported",
  noMain: "yrd-issues-no-main",
  declarationMissing: "yrd-issues-declaration-missing",
  declarationInvalid: "yrd-issues-declaration-invalid",
  unsupported: "yrd-issues-verb-unsupported",
  providerMissing: "yrd-issues-provider-missing",
  providerFailed: "yrd-issues-provider-failed",
  providerNotJson: "yrd-issues-provider-not-json",
  providerInvalidResult: "yrd-issues-provider-invalid-result",
  providerTimedOut: "yrd-issues-provider-timed-out",
  providerStalled: "yrd-issues-provider-stalled",
  environmentUnreadable: "yrd-issues-environment-unreadable",
  // #37838 (@cto e1873f39): ONE list-page entry may read the provider's bounded pages (`traverse:true` in its own
  // <page> request), so the read must refuse a set that changed under it and never pass a partial set off as
  // complete.
  pageSourceMoved: "yrd-issues-page-source-moved",
  pageBound: "yrd-issues-page-bound",
} as const

export type IssuesCode = (typeof ISSUES_CODES)[keyof typeof ISSUES_CODES]

export {
  ISSUES_VERBS,
  ISSUES_VERB_NAMES,
  ISSUES_WRITE_VERBS,
  ISSUES_CLOSE_REASONS,
  ISSUES_EVENT_KINDS,
  isIssuesVerb,
  allowedPlaceholders,
} from "@yrd/issues"
export type { IssuesVerb } from "@yrd/issues"

export const ISSUES_DECLARATION_PATH = "issues.yml"

export type IssuesDeclaration = Readonly<Partial<Record<IssuesVerb, readonly string[]>>>

/** A declaration that cannot be used, with the message naming what is wrong. */
export class IssuesDeclarationError extends Error {
  readonly code: IssuesCode = ISSUES_CODES.declarationInvalid
}

/**
 * Parse and validate the whole declaration, every verb, before any one is run: a misspelled verb or a write verb
 * without its replay key is refused when the file is first read, not when a caller first needs that verb.
 * `where` names the file as `<repository>@<commit>:issues.yml` in every refusal.
 */
export function parseIssuesDeclaration(text: string, where: string): IssuesDeclaration {
  const refuse = (detail: string): IssuesDeclarationError =>
    new IssuesDeclarationError(`${ISSUES_CODES.declarationInvalid}: ${where}: ${detail}`)
  let raw: unknown
  try {
    raw = Bun.YAML.parse(text)
  } catch (error) {
    throw refuse(`is not YAML: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw refuse("the top level must be a mapping whose keys are verbs")
  }
  const declaration: Partial<Record<IssuesVerb, readonly string[]>> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!isIssuesVerb(key)) {
      throw refuse(`key ${JSON.stringify(key)} is not a verb; the verbs are ${ISSUES_VERB_NAMES.join(", ")}`)
    }
    if (!Array.isArray(value) || value.length === 0 || !value.every((word) => typeof word === "string")) {
      throw refuse(`${key} must be a non-empty list of strings (an argv)`)
    }
    const argv = value as string[]
    const refusal = checkIssuesArgv(key, argv)
    if (refusal !== null) throw refuse(refusal.message)
    declaration[key] = argv
  }
  return declaration
}

export { substituteArgv } from "@yrd/issues"
