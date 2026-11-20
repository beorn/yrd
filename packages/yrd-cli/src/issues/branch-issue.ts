const LEAD_OR_SEAT_ISSUE_ID =
  /^(?:(?:dev|agy|grok|fable|adhoc|luna|chief|cto|cpo|dsh)-?[a-z0-9]*-)?(\d{4,5})(?!-\d{2}-\d{2})(?=-|$)/iu
const FIVE_DIGIT_ISSUE_ID = /(?:^|-)(\d{5})(?=-|$)/u

/**
 * Map a branch, ref, environment, or issue path name to its issue number through the issues interface (#37174).
 * Accepts leading or seat-prefixed 4- or 5-digit issue numbers (excluding YYYY-MM-DD dates) and hyphen-bounded
 * 5-digit issue numbers anywhere in the leaf (excluding 4-digit trailing time markers like `-1004` and non-hyphen
 * hex SHAs like `dead12345beef`).
 */
export function branchIssueId(name: string): string | undefined {
  const leaf = (name.slice(name.lastIndexOf("/") + 1) || name).replace(/\.md$/u, "")
  return LEAD_OR_SEAT_ISSUE_ID.exec(leaf)?.[1] ?? FIVE_DIGIT_ISSUE_ID.exec(leaf)?.[1]
}
