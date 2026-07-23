// @failure PR descriptions render raw: authored hard-wraps mangle mid-word in a narrow pane, bold/lists show literal markup, and a body-trailer Issue line is appended a second time.
// @level l1
// @consumer @yrd/cli pr view + watch detail

import type { PR } from "@yrd/bay"
import { createElement } from "react"
import { renderString } from "silvery"
import { describe, expect, test } from "vitest"
import { PRDetailView } from "../src/queue-status-view.tsx"
import { composeDescription } from "../src/run.ts"

const BASE_SHA = "a".repeat(40)
const AT = "2026-07-20T09:00:00.000Z"

function fixturePr(description: string, extra: Partial<PR> = {}): PR {
  const headSha = "b".repeat(40)
  return {
    id: "PR7",
    name: "Fixture PR7",
    branch: "topic/pr7",
    base: "main",
    status: "submitted",
    revision: 1,
    headSha,
    baseSha: BASE_SHA,
    revisions: [{ revision: 1, headSha, base: "main", baseSha: BASE_SHA, pushedAt: AT, submittedAt: AT }],
    submittedAt: AT,
    reviews: [],
    comments: [],
    checkRequests: [],
    description,
    ...extra,
  }
}

async function renderDetail(pr: PR, width = 80): Promise<string> {
  return renderString(createElement(PRDetailView, { pr, runs: [], now: Date.parse("2026-07-20T10:00:00.000Z") }), {
    width,
    plain: true,
  })
}

const DESCRIPTION = [
  "Refactors the queue admission path so submissions",
  "and check-requests share one causal clock.",
  "",
  "Key changes:",
  "",
  "- **Dedupe** the trailing issue line",
  "- Reflow paragraphs to the pane width",
].join("\n")

describe("PR description renders as Markdown (watch detail + pr view via PRDetailView)", () => {
  test("reflows authored hard-wraps to the pane width", async () => {
    const out = await renderDetail(fixturePr(DESCRIPTION), 80)
    // The authored line break between "submissions" and "and check-requests" is
    // gone — the paragraph reflowed onto one line at width 80 instead of keeping
    // the author's 50-column wrap.
    expect(out).toContain("submissions and check-requests")
  })

  test("renders bold and bullet markup styled, not literal", async () => {
    const out = await renderDetail(fixturePr(DESCRIPTION), 80)
    expect(out).toContain("Dedupe") // bold content survives
    expect(out).not.toContain("**") // emphasis markers stripped
    expect(out).toContain("•") // bullet list rendered, not a raw "- "
    expect(out).not.toMatch(/^- /mu) // no raw dash-bullet line
  })

  test("narrow pane reflows without mid-word or mid-phrase breaks", async () => {
    const source =
      "This is a fairly long single paragraph that the author hard\nwrapped at an inconvenient column boundary."
    const out = await renderDetail(fixturePr(source), 40)
    // "hard" and "wrapped" straddled the authored newline; reflow rejoins them.
    expect(out.replace(/\s+/gu, " ")).toContain("hard wrapped at an inconvenient")
  })
})

describe("composeDescription — Issue trailer dedupe", () => {
  test("does not append a second Issue line when the body already ends with it", () => {
    const body = "Fixes the admission clock.\n\nIssue: @yrd/core/21096"
    expect(composeDescription(body, "@yrd/core/21096")).toBe(body)
  })

  test("appends the Issue trailer when the body lacks it", () => {
    expect(composeDescription("Fixes the admission clock.", "@yrd/core/21096")).toBe(
      "Fixes the admission clock.\n\nIssue: @yrd/core/21096",
    )
  })

  test("still appends when the body ends with a DIFFERENT issue ref", () => {
    const body = "Fixes it.\n\nIssue: @yrd/core/99999"
    expect(composeDescription(body, "@yrd/core/21096")).toBe(`${body}\n\nIssue: @yrd/core/21096`)
  })

  test("is lenient on the Issue label's case and spacing", () => {
    const body = "Body text.\n\nissue:@yrd/core/21096"
    expect(composeDescription(body, "@yrd/core/21096")).toBe(body)
  })
})
