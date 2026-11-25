/**
 * @failure  Hightea pins `@yrd/issues` by the sha256 of a release asset. If the packer were not reproducible, a
 *           re-cut would look exactly like a tampered asset, and if it shipped the wrong tree the pin would install
 *           something other than the contract yrd runs.
 * @level    l1 (pure: reads the package directory, writes no repository files)
 * @testonly none
 * @consumer Hightea's @yrd/issues pin (@cto 8dfe1bd3, hh #37445)
 */
import { describe, expect, it } from "vitest"
import { gunzipSync } from "node:zlib"
import { packYrdIssues } from "./pack-yrd-issues.ts"

/** The entry names one tarball holds, in archive order. */
function entries(bytes: Uint8Array): string[] {
  const raw = gunzipSync(bytes)
  const names: string[] = []
  for (let offset = 0; offset + 512 <= raw.length; ) {
    const header = raw.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "")
    const size = Number.parseInt(header.subarray(124, 136).toString("utf8").trim() || "0", 8)
    names.push(name)
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return names
}

describe("pack-yrd-issues", () => {
  it("packs the same bytes twice, so a tag's sha256 means something", () => {
    const first = new Bun.CryptoHasher("sha256").update(packYrdIssues()).digest("hex")
    const second = new Bun.CryptoHasher("sha256").update(packYrdIssues()).digest("hex")
    expect(second).toBe(first)
  })

  it("ships the contract under package/ and leaves the tests out", () => {
    const names = entries(packYrdIssues())
    expect(names).toEqual([
      "package/package.json",
      "package/src/argv.ts",
      "package/src/index.ts",
      "package/src/payloads.ts",
      "package/src/verbs.ts",
    ])
  })
})
