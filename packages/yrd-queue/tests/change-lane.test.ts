/**
 * @failure Queue admission can misclassify code, config, or gitlinks as cheap documentation work.
 * @level l1
 * @consumer @yrd/queue change-lane classifier
 */
import { describe, expect, it } from "vitest"
import { classifyQueueLane, isPmPath, type GitDiffEntry, type PmPathPolicy } from "../src/change-lane.ts"

const REGULAR = "100644"
const EXECUTABLE = "100755"
const SYMLINK = "120000"
const GITLINK = "160000"
const MISSING = "000000"
const PM_PATHS = {
  exact: ["AGENTS.md", "CLAUDE.md", "README.md"],
  prefixes: ["hub/", "docs/", ".claude/", ".agents/", "@"],
  extensions: [".avif", ".gif", ".jpeg", ".jpg", ".md", ".mdx", ".pdf", ".png", ".svg", ".txt", ".webp"],
} as const satisfies PmPathPolicy

function changed(path: string, overrides: Partial<GitDiffEntry> = {}): GitDiffEntry {
  return { status: "M", path, oldMode: REGULAR, newMode: REGULAR, ...overrides }
}

function classify(entries: readonly GitDiffEntry[], policy: PmPathPolicy = PM_PATHS) {
  return classifyQueueLane(entries, policy)
}

describe("queue change-lane classification", () => {
  it("classifies a pure documentation carrier as pm", () => {
    expect(
      classify([
        changed("@yrd/core/21750-pm-sw-queue-lanes.md", {
          status: "A",
          oldMode: MISSING,
        }),
        changed("hub/yrd/flow-engine.md"),
        changed("docs/architecture.md"),
        changed(".claude/skills/tent/SKILL.md"),
        changed(".agents/skills/tent/SKILL.md"),
        changed("AGENTS.md"),
        changed("CLAUDE.md"),
      ]),
    ).toBe("pm")
  })

  it("keeps documentation deletions in pm", () => {
    expect(
      classify([
        changed("docs/retired.md", {
          status: "D",
          newMode: MISSING,
        }),
      ]),
    ).toBe("pm")
  })

  it.each([
    ["docs to docs", "docs/old.md", "docs/new.md", "pm"],
    ["code to docs", "packages/app/index.ts", "docs/index.md", "sw"],
    ["docs to code", "docs/index.md", "packages/app/index.ts", "sw"],
  ] as const)("classifies a %s rename from both paths", (_name, oldPath, path, expected) => {
    expect(
      classify([
        changed(path, {
          status: "R",
          oldPath,
        }),
      ]),
    ).toBe(expected)
  })

  it.each([
    ["mixed carrier", [changed("docs/notes.md"), changed("packages/yrd-cli/src/run.ts")]],
    ["configuration", [changed(".yrd.yml")]],
    ["instruction config", [changed(".claude/settings.json")]],
    ["code-shaped docs child", [changed("docs/example.ts")]],
    ["executable documentation", [changed("docs/release.md", { newMode: EXECUTABLE })]],
    ["documentation losing its executable bit", [changed("docs/release.md", { oldMode: EXECUTABLE })]],
    ["symlink documentation", [changed("docs/latest.md", { status: "T", newMode: SYMLINK })]],
    ["symlink becoming documentation", [changed("docs/latest.md", { status: "T", oldMode: SYMLINK })]],
    ["gitlink", [changed("vendor/yrd", { oldMode: GITLINK, newMode: GITLINK })]],
    ["deleted gitlink", [changed("vendor/yrd", { status: "D", oldMode: GITLINK, newMode: MISSING })]],
  ] satisfies readonly (readonly [string, readonly GitDiffEntry[]])[])("classifies %s as sw", (_name, entries) => {
    expect(classify(entries)).toBe("sw")
  })

  it("uses injected path-policy data with no hidden allowlist", () => {
    const docsOnly = { exact: [], prefixes: ["docs/"], extensions: [".md"] } satisfies PmPathPolicy
    expect(isPmPath("docs/queue.md", docsOnly)).toBe(true)
    expect(isPmPath("hub/queue.md", docsOnly)).toBe(false)
    expect(classify([changed("hub/queue.md")], docsOnly)).toBe("sw")
  })

  it.each([
    ["empty diff", []],
    ["unknown status", [changed("docs/notes.md", { status: "X" as GitDiffEntry["status"] })]],
    ["unknown mode", [changed("docs/notes.md", { newMode: "100600" })]],
    ["inconsistent add", [changed("docs/notes.md", { status: "A" })]],
    ["inconsistent delete", [changed("docs/notes.md", { status: "D" })]],
    ["rename without old path", [changed("docs/new.md", { status: "R" })]],
    ["traversal path", [changed("../docs/notes.md")]],
    ["absolute path", [changed("/docs/notes.md")]],
  ] satisfies readonly (readonly [string, readonly GitDiffEntry[]])[])(
    "refuses %s instead of guessing",
    (_name, entries) => {
      expect(() => classify(entries)).toThrow(/queue lane/iu)
    },
  )
})
