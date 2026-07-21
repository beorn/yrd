/**
 * @failure Human list/watch/log surfaces expose long domain failure codes verbatim,
 *   so the decision cell is clipped differently by each narrow viewport instead of
 *   using one stable, scannable slug vocabulary.
 * @level l2
 * @consumer @yrd/cli list, watch, and resident-runner human output
 */
import { describe, expect, it } from "vitest"

import { errorCodeLabel } from "../src/actionable-error.ts"
import { FAILURE_SLUGS, failureSlug } from "../src/failure-slug.ts"

describe("human failure slugs", () => {
  it("projects the settled short vocabulary from one exact table", () => {
    expect(FAILURE_SLUGS).toEqual({
      "queue-environment-refused": "queue-env",
      "recut-certificate": "recut-cert",
      "recut-certificate-missing": "recut-cert-missing",
      "submodule-composition-conflict": "submodule-conflict",
      "submodule-composition-unavailable": "submodule-unavail",
    })
  })

  it("preserves codes that have no settled display alias", () => {
    expect(failureSlug("merge-conflict")).toBe("merge-conflict")
  })

  it("feeds the shared list/watch error label projection", () => {
    expect(errorCodeLabel("recut-certificate")).toBe("err=recut-cert")
  })
})
