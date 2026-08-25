/**
 * 21565 — persisted/watch projections carry a stable code, cause, and
 * resolution steps. Ordinary command stderr is concise, while deep failures
 * keep concrete remedies and durable operator references. Historical Queue
 * records are enriched at read time, so this contract needs no journal migration.
 */

import { createElement } from "react"
import type { ChangeDeliveryState } from "@yrd/bay"
import { createFailure } from "@yrd/core"
import { renderString } from "silvery"
import { describe, expect, it } from "vitest"
import { fixtureJob, fixturePr, fixtureRun, fixtureStep } from "../dev/queue-timeline-fixtures.ts"
import {
  actionableFailure,
  formatActionableFailure,
  formatHumanFailure,
  type ActionableFailure,
} from "../src/actionable-error.ts"
import { diagnostic } from "../src/output.tsx"
import { ChangeDetailData, QueueShowView, queueShowData } from "../src/queue-status-view.tsx"

const BASE_ROOT = "a".repeat(40)
const AUTHORED_ROOT = "b".repeat(40)
const BASE_PIN = "c".repeat(40)
const AUTHORED_PIN = "d".repeat(40)

const AUTHORED_GITLINK = {
  code: "authored-gitlink",
  message: "yrd: change 'PR42' changes generated-only gitlinks [vendor/yrd]",
} as const

const RECUT_CONFLICT = {
  code: "recut-gitlink-conflict",
  message:
    `yrd: change 'PR77' could not recut: target root '${BASE_ROOT}' pins submodule 'vendor/yrd' to '${BASE_PIN}'; ` +
    `replayed authored root '${AUTHORED_ROOT}' pins it to '${AUTHORED_PIN}'; ancestry walk failed because neither ` +
    "submodule commit is an ancestor of the other",
} as const

const DIVERGED_RECUT_BASE = {
  code: "recut-base-diverged",
  message:
    `change 'PR1986' revision 34 certifies base '${BASE_PIN}', but the authoritative candidate base is '${BASE_ROOT}', ` +
    "which never descended from it; the certificate cannot become valid without a fresh revision",
} as const

const ALL_DELIVERY_STATES: readonly ChangeDeliveryState[] = [
  "pushed",
  "submitted",
  "needs-author",
  "rejected",
  "integrated",
  "already-landed",
  "withdrawn",
  "canceled",
]

const RECUT_REFUSING: ReadonlySet<ChangeDeliveryState> = new Set<ChangeDeliveryState>([
  "integrated",
  "already-landed",
  "withdrawn",
  "canceled",
])

/** Mirrors the CLI's own state guards, so the regression fails when the
 * projection drifts from them: `yrd pr create` is accepted only for a draft
 * (pushed) PR — applyPrSelectionVerb refuses every other state twice — and
 * `yrd pr recut` refuses a terminal change outright (executeRecutPr
 * `terminal-target`). `yrd pr submit <branch>` is refused by no state. */
function refusedBy(delivery: ChangeDeliveryState, command: string): boolean {
  if (command.startsWith("yrd pr create")) return delivery !== "pushed"
  if (command.startsWith("yrd pr recut")) return RECUT_REFUSING.has(delivery)
  return false
}

describe("actionable failure projection", () => {
  it("turns authored-gitlink into a submit remedy, independent of PR delivery state", () => {
    expect(actionableFailure(AUTHORED_GITLINK)).toEqual({
      code: "authored-gitlink",
      cause: "change 'PR42' changes generated-only gitlinks [vendor/yrd]",
      resolution: ["yrd pr submit <branch>"],
      reference: "README.md#pr-eligibility-and-checks",
    } satisfies ActionableFailure)
    for (const delivery of ALL_DELIVERY_STATES) {
      expect(actionableFailure(AUTHORED_GITLINK).resolution).toEqual(["yrd pr submit <branch>"])
    }
  })

  it("surfaces the queue's own fast-forward-the-submodule's-main instruction as cause, never re-deriving it", () => {
    // intentSubmissionWorkflow (yrd-queue/src/command.ts) already speaks this
    // prose into the failure message; oneLineCause preserves it verbatim
    // because no quoted 'yrd ...' command follows it to strip. The projection
    // must not discard it and construct its own instead (23000 root cause).
    const failure = actionableFailure({
      code: "authored-gitlink",
      message:
        "yrd: change 'PR42' changes generated-only gitlinks [vendor/yrd]; get commit 'deadbeef' onto 'vendor/yrd''s " +
        "own main, then submit an ordinary change whose diff is the gitlink bump (issue @i/10-merge-queue/1)",
    })

    expect(failure.cause).toBe(
      "change 'PR42' changes generated-only gitlinks [vendor/yrd]; get commit 'deadbeef' onto 'vendor/yrd''s own " +
        "main, then submit an ordinary change whose diff is the gitlink bump (issue @i/10-merge-queue/1)",
    )
    expect(failure.resolution).toEqual(["yrd pr submit <branch>"])
  })

  it("preserves the cherry denominator the producer already named, never re-deriving it", () => {
    const failure = actionableFailure({
      code: "authored-gitlink",
      message:
        "yrd: change 'PR42' changes generated-only gitlinks [vendor/yrd]; get commit 'deadbeef' onto 'vendor/yrd''s " +
        "own main, then submit an ordinary change whose diff is the gitlink bump (issue @i/10-merge-queue/1); " +
        "before fast-forwarding, print what the FF would drag in with 'git cherry <estate-pin> <submodule-main>' " +
        "(empty unique list = no-op; non-empty is the dragged set)",
    })

    expect(failure.cause).toMatch(/git cherry <estate-pin> <submodule-main>/u)
    expect(failure.cause).toMatch(/empty unique list = no-op/u)
    expect(failure.resolution).toEqual(["yrd pr submit <branch>"])
  })

  it("does not project an unexecutable mechanical remedy for a submodule addition or deletion", () => {
    for (const change of ["new submodule 'vendor/new'", "submodule 'vendor/old' is deleted"]) {
      const projected = actionableFailure({
        code: "authored-gitlink",
        message:
          `yrd: change 'PR42' changes generated-only gitlinks [vendor/example]; ${change}; ` +
          "a change of min commits advances existing submodules only; a gitlink bump cannot express this component-model change",
      })
      expect(projected.resolution).toEqual([
        "Escalate the component-model addition or deletion; a gitlink bump only advances an existing " +
          "submodule, never adds or removes one.",
      ])
    }
  })

  it("projects a merge-tip carrier's exact linear rebuild commands", () => {
    const failure = actionableFailure({
      code: "merge-tip-carrier",
      message:
        "yrd: change 'PR42' root branch tip 'deadbeef' is a merge commit with 2 parents; " +
        "merge inside the affected submodule repository, fast-forward that submodule's main, rebuild the root " +
        "carrier as one linear pin-bump commit, then run 'yrd pr submit <branch>' and " +
        "'yrd pr recut PR42 --preflight --queue --apply'",
    })

    expect(failure).toMatchObject({
      code: "merge-tip-carrier",
      cause: expect.stringMatching(/merge inside.*submodule.*linear pin-bump/iu),
      resolution: ["yrd pr submit <branch>", "yrd pr recut PR42 --preflight --queue --apply"],
    })
  })


  it("extracts exact commands already embedded in a mechanical remedy", () => {
    const failure = actionableFailure({
      code: "queue-administration-retired",
      message:
        "yrd: admin queue init is retired and does nothing. Run 'yrd admin init' to install the managed pre-submit hook, and 'yrd queue audit' to compare git against the recorded runs.",
    })

    expect(failure.resolution).toEqual(["yrd admin init", "yrd queue audit"])
    expect(formatActionableFailure(failure)).toContain("err=queue-administration-retired")
    expect(formatActionableFailure(failure)).toContain("cause: admin queue init is retired and does nothing")
    expect(formatActionableFailure(failure)).toContain("resolve: yrd admin init")
  })

  it("projects retained-evidence cleanup from its shape, independent of failure code", () => {
    const worktree = "/tmp/repo/.git/yrd/pre-submit-worktrees/check-one/worktree"
    const provision = actionableFailure({
      code: "candidate-provision-failed",
      message:
        `yrd: dependency cache unavailable; workspace retained at '${worktree}' ` +
        "(cleanup: worktree; --keep-on-failure)",
    })
    expect(provision.resolution).toEqual([
      `Inspect the retained workspace at '${worktree}'.`,
      `git worktree remove --force '${worktree}'`,
      "rmdir '/tmp/repo/.git/yrd/pre-submit-worktrees/check-one'",
      "yrd pr submit <branch>",
    ])
    expect(formatHumanFailure(provision)).toContain(`resolve: Inspect the retained workspace at '${worktree}'.`)
    expect(formatHumanFailure(provision)).toContain(`resolve: git worktree remove --force '${worktree}'`)

    const directory = "/tmp/repo/.git/yrd/pre-submit-worktrees/check-two"
    const checkout = actionableFailure({
      code: "required-check-checkout-failed",
      message:
        `yrd: checkout materialization failed; workspace retained at '${directory}' ` +
        "(cleanup: directory; --keep-on-failure)",
    })
    expect(checkout.resolution).toEqual([
      `Inspect the retained workspace at '${directory}'.`,
      `rmdir '${directory}'`,
      "yrd pr submit <branch>",
    ])
    expect(formatHumanFailure(checkout)).toContain(`resolve: rmdir '${directory}'`)
  })
})

/**
 * 22396 — `resolution[]` is the ONLY machine-readable remedy channel, so a step
 * the change's current delivery state refuses is a wrong instruction, not a hint.
 * The authored-gitlink projection used to print `yrd pr create <branch>`
 * unconditionally; on a submitted PR both printed steps refuse.
 */
describe("22396 — state-aware remedies", () => {
  it("emits no command the change's delivery state refuses, in every state", () => {
    for (const delivery of ALL_DELIVERY_STATES) {
      const failure = actionableFailure(AUTHORED_GITLINK)
      const refused = failure.resolution.filter((step) => refusedBy(delivery, step))
      expect({ delivery, refused }).toEqual({ delivery, refused: [] })
      expect(failure.resolution.length).toBeGreaterThan(0)
    }
  })

  it("keeps the submit remedy available for an already-submitted authored-gitlink PR", () => {
    const failure = actionableFailure(AUTHORED_GITLINK)

    expect(failure.resolution).toEqual(["yrd pr submit <branch>"])
  })

  it("keeps the submit remedy available for a terminal change", () => {
    for (const delivery of ["integrated", "already-landed", "withdrawn", "canceled"] as const) {
      expect(actionableFailure(AUTHORED_GITLINK).resolution).toEqual(["yrd pr submit <branch>"])
    }
  })

  it("defaults to the submit remedy when no PR is in hand", () => {
    expect(actionableFailure(AUTHORED_GITLINK).resolution).toEqual(["yrd pr submit <branch>"])
  })


  it("threads the change's delivery state through the pr view and run detail projections", () => {
    const pr = fixturePr("PR42", "submitted", "2026-07-18T18:00:00.000Z")
    const run = fixtureRun("R42", [pr], "failed", "2026-07-18T18:01:00.000Z", {
      finishedAt: "2026-07-18T18:02:00.000Z",
      steps: [fixtureStep("merge", fixtureJob("J42", "failed", { error: { ...AUTHORED_GITLINK } }))],
    })

    const detail = ChangeDetailData(pr, [run])
    const projected = detail.runs[0]
    expect(projected?.failure?.resolution).toEqual(["yrd pr submit <branch>"])
    expect(projected?.steps[0]?.failure?.resolution).toEqual(projected?.failure?.resolution)

    const draft = queueShowData(run, [], [], undefined, "pushed")
    expect(draft.failure?.resolution).toEqual(["yrd pr submit <branch>"])
  })
})

describe("actionable failure output", () => {
  it("renders typed command failures as a sentence plus concrete resolution", async () => {
    let stderr = ""
    await diagnostic(
      {
        stdout() {},
        stderr(text) {
          stderr += text
        },
      },
      createFailure({
        kind: "refusal",
        code: "authored-gitlink",
        message: "yrd: change 'PR42' changes generated-only gitlinks [vendor/yrd]",
      }),
    )

    // A bare CLI diagnostic still points at the carrier-free submit remedy.
    expect(stderr).toBe(
      [
        "error: change 'PR42' changes generated-only gitlinks [vendor/yrd]",
        "resolve: yrd pr submit <branch>",
        "reference: README.md#pr-eligibility-and-checks",
        "",
      ].join("\n"),
    )
  })

  it("omits content-free resolution from ordinary human failures", async () => {
    let stderr = ""
    await diagnostic(
      {
        stdout() {},
        stderr(text) {
          stderr += text
        },
      },
      createFailure({ kind: "refusal", code: "pr-missing", message: "yrd: no change 'PR404'" }),
    )

    expect(stderr).toBe("error: no change 'PR404'\n")
  })

  it("keeps only executable remedies in the human projection", () => {
    expect(
      formatHumanFailure({
        code: "journal-version-skew",
        cause: "the journal contains newer fields",
        resolution: [
          "Run yrd from the checkout this repository pins.",
          "Update this checkout, then retry the same Yrd command.",
          "yrd pr view PR1",
        ],
      }),
    ).toBe("error: the journal contains newer fields\nresolve: yrd pr view PR1")
  })

  it("keeps wide-character diagnostics on one physical line", async () => {
    let stderr = ""
    await diagnostic(
      {
        columns: 1,
        stdout() {},
        stderr(text) {
          stderr += text
        },
      },
      new Error("错误"),
    )

    expect(stderr).toBe("error: 错误\n")
  })

  it("keeps the full actionable text in compact watch detail and pr view/runs data", async () => {
    const pr = fixturePr("PR42", "rejected", "2026-07-18T18:00:00.000Z")
    const run = fixtureRun("R42", [pr], "failed", "2026-07-18T18:01:00.000Z", {
      finishedAt: "2026-07-18T18:02:00.000Z",
      steps: [
        fixtureStep(
          "merge",
          fixtureJob("J42", "failed", {
            error: {
              code: "authored-gitlink",
              message: "yrd: change 'PR42' changes generated-only gitlinks [vendor/yrd]",
            },
          }),
        ),
      ],
    })
    const data = queueShowData(run, [], [], undefined, "rejected")

    expect(data.failure).toMatchObject({
      code: "authored-gitlink",
      cause: "change 'PR42' changes generated-only gitlinks [vendor/yrd]",
      resolution: ["yrd pr submit <branch>"],
    })
    expect(data.steps[0]?.failure).toEqual(data.failure)

    for (const compact of [true, false]) {
      const output = await renderString(createElement(QueueShowView, { data, compact }), {
        width: compact ? 70 : 180,
        height: 80,
        plain: true,
      })
      expect(output).toContain("err=authored-gitlink")
      expect(output).toContain("CAUSE")
      expect(output).toContain("change 'PR42' changes generated-only gitlinks [vendor/yrd]")
      expect(output).toContain("RESOLVE")
      expect(output).toContain("yrd pr submit <branch>")
      expect(output).toContain("REFERENCE README.md#pr-eligibility-and-checks")
      if (!compact) {
        expect(output.split("\n").find((row) => row.trimStart().startsWith("merge"))).toContain("err=authored-gitlink")
      }
    }
  })
})
