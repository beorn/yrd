import { raiseFailure } from "@yrd/core"

/** Apply the already-parsed submit selector contract without maintaining a
 * second option map. The execution context owns implicit branch selection. */
export function resolveSubmitSelectors(selectors: readonly string[], current: string | undefined): string[] {
  if (selectors.length > 0) return [...selectors]
  if (current === undefined || current === "") {
    raiseFailure("refusal", "bay-submit-branch-missing", "yrd: no current Git branch; pass a bay or branch selector")
  }
  return [current]
}
