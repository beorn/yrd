/**
 * Stable human aliases for failure codes that do not scan at queue-table width.
 * Domain/journal facts keep their lossless code; list, watch, and resident-log
 * projections call {@link failureSlug} at the presentation boundary.
 */
export const FAILURE_SLUGS = Object.freeze({
  "queue-environment-refused": "queue-env",
  "recut-certificate": "recut-cert",
  "recut-certificate-missing": "recut-cert-missing",
  "submodule-composition-conflict": "submodule-conflict",
  "submodule-composition-unavailable": "submodule-unavail",
  "submodule-merge-review-required": "submodule-review",
} as const)

const FAILURE_SLUG_LOOKUP: Readonly<Record<string, string>> = FAILURE_SLUGS

export function failureSlug(code: string): string {
  return FAILURE_SLUG_LOOKUP[code] ?? code
}
