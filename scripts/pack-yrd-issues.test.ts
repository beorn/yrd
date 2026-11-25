/**
 * @failure  A release asset cut from `yrd-issues-v0.1.0` while the package still says 0.0.1 puts today's bytes under
 *           tomorrow's name; Hightea's pin names the version, so the mismatch would surface there as a missing asset
 *           with nothing saying which side was wrong (@cto, 2026-11-25, hh #37445).
 * @level    l1 (pure function; no git, no pack)
 * @testonly none
 * @consumer scripts/pack-yrd-issues.ts, and the tag a release asset is cut from
 */
import { describe, expect, it } from "vitest"
import { tagVersionRefusal } from "./pack-yrd-issues.ts"

describe("pack-yrd-issues tag/version gate", () => {
  it("refuses a tag whose version is not the package's, naming both", () => {
    expect(tagVersionRefusal("yrd-issues-v0.1.0", "0.0.1")).toBe(
      "tag yrd-issues-v0.1.0 names version 0.1.0, but packages/yrd-issues/package.json is 0.0.1",
    )
  })

  it("accepts the tag of the package's own version, prerelease included", () => {
    expect(tagVersionRefusal("yrd-issues-v0.0.1", "0.0.1")).toBeNull()
    expect(tagVersionRefusal("yrd-issues-v0.1.0-rc.4", "0.1.0-rc.4")).toBeNull()
  })

  it("refuses a tag that is not the package's version tag at all", () => {
    expect(tagVersionRefusal("yrd-issues-vlatest", "0.0.1")).toMatch(/yrd-issues-v<version>/)
    expect(tagVersionRefusal("v0.0.1", "0.0.1")).toMatch(/yrd-issues-v<version>/)
  })
})
