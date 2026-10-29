/**
 * The issues declaration: `issues.yml` at a project's root, whose top-level keys ARE the verbs and whose values
 * are argv lists, plus the display-only `alias` repair template. This module only reads the text
 * into a validated table; it never runs anything and never decides from issue state.
 */

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
} as const

export type IssuesCode = (typeof ISSUES_CODES)[keyof typeof ISSUES_CODES]

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
])

/** GitHub's pair (`gh issue close --reason`). */
export const ISSUES_CLOSE_REASONS = ["completed", "not-planned"] as const

export const ISSUES_DECLARATION_PATH = "issues.yml"

export function isIssuesVerb(value: string): value is IssuesVerb {
  return Object.hasOwn(ISSUES_VERBS, value)
}

/** The placeholders a verb's argv may carry: its operands, plus `<id>` on a write verb. */
export function allowedPlaceholders(verb: IssuesVerb): readonly string[] {
  return ISSUES_WRITE_VERBS.has(verb) ? [...ISSUES_VERBS[verb], "id"] : ISSUES_VERBS[verb]
}

export type IssuesDeclaration = Readonly<Partial<Record<IssuesVerb, readonly string[]>> & { alias?: readonly string[] }>

/** A declaration that cannot be used, with the message naming what is wrong. */
export class IssuesDeclarationError extends Error {
  readonly code: IssuesCode = ISSUES_CODES.declarationInvalid
}

const PLACEHOLDER = /<([A-Za-z_][A-Za-z0-9_-]*)>/u
const WHOLE_PLACEHOLDER = /^<([A-Za-z_][A-Za-z0-9_-]*)>$/u

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
  const declaration: Partial<Record<IssuesVerb | "alias", readonly string[]>> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!isIssuesVerb(key) && key !== "alias") {
      throw refuse(`key ${JSON.stringify(key)} is not a verb; the verbs are ${ISSUES_VERB_NAMES.join(", ")}`)
    }
    if (!Array.isArray(value) || value.length === 0 || !value.every((word) => typeof word === "string")) {
      throw refuse(`${key} must be a non-empty list of strings (an argv)`)
    }
    const argv = value as string[]
    const allowed: readonly string[] = key === "alias" ? ["raw", "key"] : allowedPlaceholders(key)
    for (const word of argv) {
      const whole = WHOLE_PLACEHOLDER.exec(word)
      if (whole !== null) {
        const name = whole[1] as string
        if (!allowed.includes(name)) {
          throw refuse(
            `${key} carries placeholder <${name}>, which ${key} does not take; ` +
              `${key} takes ${allowed.length === 0 ? "none" : allowed.map((n) => `<${n}>`).join(", ")}`,
          )
        }
        continue
      }
      const embedded = PLACEHOLDER.exec(word)
      if (embedded !== null) {
        throw refuse(
          `${key} element ${JSON.stringify(word)} embeds <${embedded[1] as string}>; ` +
            "a placeholder must be a whole argv element",
        )
      }
    }
    if (key === "alias") {
      for (const name of ["raw", "key"]) {
        if (!argv.includes(`<${name}>`)) {
          throw refuse(`alias lacks <${name}>; include both <raw> and <key> as whole argv elements`)
        }
      }
    } else if (ISSUES_WRITE_VERBS.has(key) && !argv.includes("<id>")) {
      throw refuse(`write verb ${key} lacks <id>; add <id> where the provider takes its replay key`)
    }
    declaration[key] = argv
  }
  return declaration
}

/** Substitute each placeholder with exactly one argv element; nothing is ever shell-parsed. */
export function substituteArgv(argv: readonly string[], values: Readonly<Record<string, string>>): string[] {
  return argv.map((word) => {
    const whole = WHOLE_PLACEHOLDER.exec(word)
    if (whole === null) return word
    const value = values[whole[1] as string]
    if (value === undefined) throw new Error(`yrd issues: no value for placeholder ${word}`)
    return value
  })
}
