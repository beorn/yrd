/**
 * @failure Queue candidate construction bounces divergent-but-clean submodule pins as generic root conflicts, forcing authors to recut wrappers by hand.
 * @level l0
 * @consumer @yrd/queue candidate construction
 */

import { describe, expect, it } from "vitest"
import { planQueueSubmoduleComposition, type QueueTreeConflict } from "../src/submodule-composition.ts"

const oid = (digit: string) => digit.repeat(40)

function gitlinkConflict(
  path: string,
  baseSha: string,
  currentSha: string,
  incomingSha: string,
  origin = `https://example.test/${path}.git`,
): QueueTreeConflict {
  return {
    path,
    origin,
    stages: [
      { stage: 1, mode: "160000", oid: baseSha },
      { stage: 2, mode: "160000", oid: currentSha },
      { stage: 3, mode: "160000", oid: incomingSha },
    ],
  }
}

function plainFileConflict(path: string): QueueTreeConflict {
  return {
    path,
    stages: [
      { stage: 1, mode: "100644", oid: oid("4") },
      { stage: 2, mode: "100644", oid: oid("5") },
      { stage: 3, mode: "100644", oid: oid("6") },
    ],
  }
}

describe("queue-native submodule composition planner", () => {
  it("plans deterministic two-parent compositions in path order", () => {
    const conflicts = [
      gitlinkConflict("vendor/zeta", oid("1"), oid("2"), oid("3")),
      gitlinkConflict("vendor/alpha", oid("4"), oid("5"), oid("6")),
    ]

    const planned = planQueueSubmoduleComposition(conflicts)

    expect(planned).toMatchObject({
      status: "planned",
      resolutions: [
        {
          kind: "compose",
          path: "vendor/alpha",
          baseSha: oid("4"),
          currentSha: oid("5"),
          incomingSha: oid("6"),
          origin: "https://example.test/vendor/alpha.git",
          message:
            `yrd: compose vendor/alpha\n\n` +
            `Yrd-Composition-Path: vendor/alpha\n` +
            `Yrd-Composition-Base: ${oid("4")}\n` +
            `Yrd-Composition-Parents: ${oid("5")} ${oid("6")}`,
        },
        {
          kind: "compose",
          path: "vendor/zeta",
          baseSha: oid("1"),
          currentSha: oid("2"),
          incomingSha: oid("3"),
        },
      ],
    })
    if (planned.status !== "planned") throw new Error("expected a composition plan")
    expect(
      planned.resolutions.every(
        (resolution) => resolution.kind === "pin" || /^refs\/yrd\/compositions\/[0-9a-f]{64}$/u.test(resolution.ref),
      ),
    ).toBe(true)
    expect(planQueueSubmoduleComposition(conflicts.toReversed())).toEqual(planned)
  })

  it("resolves one-sided and identical gitlink moves without minting commits", () => {
    const planned = planQueueSubmoduleComposition([
      { ...gitlinkConflict("vendor/incoming", oid("1"), oid("1"), oid("2")), origin: undefined },
      gitlinkConflict("vendor/current", oid("3"), oid("4"), oid("3")),
      gitlinkConflict("vendor/same", oid("5"), oid("6"), oid("6")),
    ])

    expect(planned).toEqual({
      status: "planned",
      resolutions: [
        { kind: "pin", path: "vendor/current", sha: oid("4") },
        { kind: "pin", path: "vendor/incoming", sha: oid("2") },
        { kind: "pin", path: "vendor/same", sha: oid("6") },
      ],
    })
  })

  it("refuses the whole candidate when any conflict is not a three-stage gitlink", () => {
    const planned = planQueueSubmoduleComposition([
      gitlinkConflict("vendor/mergeable", oid("1"), oid("2"), oid("3")),
      {
        path: "README.md",
        stages: [
          { stage: 1, mode: "100644", oid: oid("4") },
          { stage: 2, mode: "100644", oid: oid("5") },
          { stage: 3, mode: "100644", oid: oid("6") },
        ],
      },
    ])

    expect(planned).toEqual({
      status: "refused",
      code: "candidate-conflict",
      paths: ["README.md"],
      message: "content conflict in README.md; the PR must be rebased or merged against the current base, then retry",
    })
  })

  it("names plain-file content conflicts as content conflicts, not submodule pins", () => {
    const planned = planQueueSubmoduleComposition([
      plainFileConflict(".agents/skills/tent/scripts/yrd-cutover.test.ts"),
      plainFileConflict(".claude/skills/tent/scripts/yrd-cutover.test.ts"),
    ])

    expect(planned).toEqual({
      status: "refused",
      code: "candidate-conflict",
      paths: [".agents/skills/tent/scripts/yrd-cutover.test.ts", ".claude/skills/tent/scripts/yrd-cutover.test.ts"],
      message:
        "content conflict in .agents/skills/tent/scripts/yrd-cutover.test.ts, .claude/skills/tent/scripts/yrd-cutover.test.ts; " +
        "the PR must be rebased or merged against the current base, then retry",
    })
    if (planned.status !== "refused") throw new Error("expected a refusal")
    expect(planned.message).not.toMatch(/gitlink|submodule/u)
  })

  it("splits a mixed refusal into content and submodule clauses", () => {
    const planned = planQueueSubmoduleComposition([
      plainFileConflict("README.md"),
      { ...gitlinkConflict("vendor/no-origin", oid("1"), oid("2"), oid("3")), origin: undefined },
    ])

    expect(planned).toMatchObject({
      status: "refused",
      code: "candidate-conflict",
      paths: ["README.md", "vendor/no-origin"],
    })
    if (planned.status !== "refused") throw new Error("expected a refusal")
    expect(planned.message).toContain("content conflict in README.md")
    expect(planned.message).toContain("one complete three-stage gitlink per path")
    expect(planned.message).toContain("vendor/no-origin")
  })

  it("refuses duplicate conflict facts for the same path", () => {
    const conflict = gitlinkConflict("vendor/duplicate-path", oid("1"), oid("2"), oid("3"))

    expect(planQueueSubmoduleComposition([conflict, conflict])).toMatchObject({
      status: "refused",
      code: "candidate-conflict",
      paths: [conflict.path],
    })
  })

  it.each([
    [
      "missing stage",
      { path: "vendor/missing", stages: gitlinkConflict("x", oid("1"), oid("2"), oid("3")).stages.slice(1) },
    ],
    [
      "duplicate stage",
      {
        path: "vendor/duplicate",
        stages: [
          { stage: 1 as const, mode: "160000", oid: oid("1") },
          { stage: 2 as const, mode: "160000", oid: oid("2") },
          { stage: 2 as const, mode: "160000", oid: oid("3") },
        ],
      },
    ],
    ["malformed oid", gitlinkConflict("vendor/malformed", oid("1"), oid("2"), "not-an-oid")],
    ["unsupported oid length", gitlinkConflict("vendor/oid-length", oid("1"), oid("2"), "3".repeat(41))],
    ["missing origin", { ...gitlinkConflict("vendor/no-origin", oid("1"), oid("2"), oid("3")), origin: undefined }],
  ] satisfies ReadonlyArray<readonly [string, QueueTreeConflict]>)(
    "refuses %s facts instead of guessing",
    (_name, conflict) => {
      expect(planQueueSubmoduleComposition([conflict])).toMatchObject({
        status: "refused",
        code: "candidate-conflict",
        paths: [conflict.path],
      })
    },
  )
})
