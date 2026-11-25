/**
 * The pure rule set an argv must satisfy before any provider may run it: placeholders are whole elements, a verb takes
 * only the placeholders it declares, a write verb carries its replay key, and `list-page` carries its page request.
 *
 * Extracted from `yrd-cli`'s declaration reader (@cto 37a8972c) so that both providers refuse the same argv with the
 * same words. It reads a table and returns a refusal; it never runs anything and never parses a file.
 */

import { allowedPlaceholders, ISSUES_WRITE_VERBS, type IssuesVerb } from "./verbs.ts"

const PLACEHOLDER = /<([A-Za-z_][A-Za-z0-9_-]*)>/u
const WHOLE_PLACEHOLDER = /^<([A-Za-z_][A-Za-z0-9_-]*)>$/u

/** One argv that may not be used, with the message that names what is wrong. */
export interface IssuesArgvRefusal {
  readonly message: string
}

/**
 * Check one verb's argv. Returns null when the argv is usable, else the refusal to throw or answer with. The messages are
 * the interface's own contract: callers prefix them with their code and location rather than rewording them.
 */
export function checkIssuesArgv(verb: IssuesVerb, argv: readonly string[]): IssuesArgvRefusal | null {
  const allowed = allowedPlaceholders(verb)
  for (const word of argv) {
    const whole = WHOLE_PLACEHOLDER.exec(word)
    if (whole !== null) {
      const name = whole[1] as string
      if (!allowed.includes(name)) {
        return {
          message:
            `${verb} carries placeholder <${name}>, which ${verb} does not take; ` +
            `${verb} takes ${allowed.length === 0 ? "none" : allowed.map((n) => `<${n}>`).join(", ")}`,
        }
      }
      continue
    }
    const embedded = PLACEHOLDER.exec(word)
    if (embedded !== null) {
      return {
        message:
          `${verb} element ${JSON.stringify(word)} embeds <${embedded[1] as string}>; ` +
          "a placeholder must be a whole argv element",
      }
    }
  }
  if (ISSUES_WRITE_VERBS.has(verb) && !argv.includes("<id>")) {
    return { message: `write verb ${verb} lacks <id>; add <id> where the provider takes its replay key` }
  }
  if (verb === "list-page" && !argv.includes("<page>")) {
    return { message: "list-page lacks <page>; add <page> where the provider takes its finite page request" }
  }
  return null
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
