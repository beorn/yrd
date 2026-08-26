/**
 * @failure A diagnostic spends its whole budget repeating one retried line and
 * truncates away the status code that was the entire diagnosis — the six-hour
 * outage whose message read `… - 429 error: git-super@… failed to resolve`
 * six times, with the `429` mid-line after an ellipsis and the head already
 * dropped.
 * @level l1
 * @consumer @yrd/core command output digests
 */
import { describe, expect, it } from "vitest"
import { digestCommandOutput, outputStatusCode } from "../src/output-digest.ts"

/** The reported specimen, in the shape a package manager actually emits it:
 * one cause, then the SAME retry line six times. */
const RETRY_STORM = [
  "bun install --frozen-lockfile --ignore-scripts",
  "error: request failed - 429",
  "error: git-super@github:beorn/git-super#176fdb64 failed to resolve",
  "error: git-super@github:beorn/git-super#176fdb64 failed to resolve",
  "error: git-super@github:beorn/git-super#176fdb64 failed to resolve",
  "error: git-super@github:beorn/git-super#176fdb64 failed to resolve",
  "error: git-super@github:beorn/git-super#176fdb64 failed to resolve",
  "error: git-super@github:beorn/git-super#176fdb64 failed to resolve",
].join("\n")

describe("digestCommandOutput", () => {
  it("collapses a run of identical lines into one line with a count", () => {
    const digest = digestCommandOutput(RETRY_STORM, { limit: 2_000 })
    expect(digest).toContain("error: git-super@github:beorn/git-super#176fdb64 failed to resolve (×6)")
    // Six retries of ONE dependency must not read as six dependencies.
    expect(digest.split("failed to resolve").length - 1).toBe(1)
  })

  it("keeps the cause visible in a budget the raw retries would have exhausted", () => {
    // The budget is far too small for the raw storm; collapsing is what makes
    // the 429 fit, which is the whole point of doing it before truncating.
    const digest = digestCommandOutput(RETRY_STORM, { limit: 160 })
    expect(digest).toContain("429")
  })

  it("drops the tail, never the head, so the first error survives a short budget", () => {
    const output = ["FIRST: the cause", ...Array.from({ length: 50 }, (_, i) => `noise ${String(i)}`)].join("\n")
    const digest = digestCommandOutput(output, { limit: 120 })
    expect(digest.startsWith("FIRST: the cause")).toBe(true)
    expect(digest).not.toContain("noise 49")
  })

  it("says that it truncated rather than trailing off silently", () => {
    const digest = digestCommandOutput("x".repeat(500), { limit: 100 })
    expect(digest).toContain("output truncated")
    expect(digest.length).toBeLessThanOrEqual(100)
  })

  it("returns short output untouched", () => {
    expect(digestCommandOutput("just this\nand this", { limit: 2_000 })).toBe("just this\nand this")
  })

  it("keeps a head and a tail when a head budget is named", () => {
    const output = ["HEAD line", ...Array.from({ length: 200 }, (_, i) => `mid ${String(i)}`), "TAIL line"].join("\n")
    const digest = digestCommandOutput(output, { limit: 300, head: 100 })
    expect(digest.startsWith("HEAD line")).toBe(true)
    expect(digest.endsWith("TAIL line")).toBe(true)
    expect(digest).toContain("output truncated")
  })

  it("collapses only ADJACENT repeats, so interleaved lines keep their order", () => {
    // Reordering an interleaved log to group repeats would invent a sequence
    // that never happened — worse than the repetition it removes.
    const digest = digestCommandOutput(["a", "b", "a"].join("\n"), { limit: 2_000 })
    expect(digest).toBe("a\nb\na")
  })
})

describe("outputStatusCode", () => {
  it("finds the code in the shape the reported specimen carried it", () => {
    expect(outputStatusCode("error: request failed - 429")).toBe("429")
  })

  it("finds the usual spellings", () => {
    expect(outputStatusCode("HTTP 503 while fetching")).toBe("503")
    expect(outputStatusCode("status code 404")).toBe("404")
    expect(outputStatusCode("status: 401")).toBe("401")
    expect(outputStatusCode("429 Too Many Requests")).toBe("429")
  })

  it("claims NO status when the output only contains a number that looks like one", () => {
    // Inventing a status code is worse than omitting it: the headline would
    // then assert a diagnosis the output never made.
    expect(outputStatusCode("resolving silvery@1.500.0")).toBeUndefined()
    expect(outputStatusCode("compiled 404 modules")).toBeUndefined()
    expect(outputStatusCode("no numbers here at all")).toBeUndefined()
  })

  it("reports the FIRST status code, which is the one that started the failure", () => {
    expect(outputStatusCode("HTTP 429 rate limited\nHTTP 500 later")).toBe("429")
  })
})
