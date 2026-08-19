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
  message: "yrd: PR 'PR42' changes generated-only gitlinks [vendor/yrd]",
} as const

const RECUT_CONFLICT = {
  code: "recut-gitlink-conflict",
  message:
    `yrd: PR 'PR77' could not recut: target root '${BASE_ROOT}' pins submodule 'vendor/yrd' to '${BASE_PIN}'; ` +
    `replayed authored root '${AUTHORED_ROOT}' pins it to '${AUTHORED_PIN}'; ancestry walk failed because neither ` +
    "submodule commit is an ancestor of the other",
} as const

const DIVERGED_RECUT_BASE = {
  code: "recut-base-diverged",
  message:
    `PR 'PR1986' revision 34 certifies base '${BASE_PIN}', but the authoritative candidate base is '${BASE_ROOT}', ` +
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
 * `yrd pr recut` refuses a terminal PR outright (executeRecutPr
 * `terminal-target`). `yrd pr submit <branch>` is refused by no state. */
function refusedBy(delivery: ChangeDeliveryState, command: string): boolean {
  if (command.startsWith("yrd pr create")) return delivery !== "pushed"
  if (command.startsWith("yrd pr recut")) return RECUT_REFUSING.has(delivery)
  return false
}

describe("actionable failure projection", () => {
  it("turns authored-gitlink into a submit remedy, independent of PR delivery state", () => {
    expect(actionableFailure(AUTHORED_GITLINK, { delivery: "pushed" })).toEqual({
      code: "authored-gitlink",
      cause: "PR 'PR42' changes generated-only gitlinks [vendor/yrd]",
      resolution: ["yrd pr submit <branch>"],
      reference: "README.md#pr-eligibility-and-checks",
    } satisfies ActionableFailure)
    for (const delivery of ALL_DELIVERY_STATES) {
      expect(actionableFailure(AUTHORED_GITLINK, { delivery }).resolution).toEqual(["yrd pr submit <branch>"])
    }
  })

  it("surfaces the queue's own fast-forward-the-component's-main instruction as cause, never re-deriving it", () => {
    // intentSubmissionWorkflow (yrd-queue/src/command.ts) already speaks this
    // prose into the failure message; oneLineCause preserves it verbatim
    // because no quoted 'yrd ...' command follows it to strip. The projection
    // must not discard it and construct its own instead (23000 root cause).
    const failure = actionableFailure({
      code: "authored-gitlink",
      message:
        "yrd: PR 'PR42' changes generated-only gitlinks [vendor/yrd]; get commit 'deadbeef' onto 'vendor/yrd''s " +
        "own main, then submit an ordinary merge request whose diff is the gitlink bump (issue @i/10-merge-queue/1)",
    })

    expect(failure.cause).toBe(
      "PR 'PR42' changes generated-only gitlinks [vendor/yrd]; get commit 'deadbeef' onto 'vendor/yrd''s own " +
        "main, then submit an ordinary merge request whose diff is the gitlink bump (issue @i/10-merge-queue/1)",
    )
    expect(failure.resolution).toEqual(["yrd pr submit <branch>"])
  })

  it("does not project an unexecutable mechanical remedy for a component addition or deletion", () => {
    for (const change of ["new component 'vendor/new'", "component 'vendor/old' is deleted"]) {
      const projected = actionableFailure({
        code: "authored-gitlink",
        message:
          `yrd: PR 'PR42' changes generated-only gitlinks [vendor/example]; ${change}; ` +
          "pin intents advance existing components only; a gitlink bump cannot express this component-model change",
      })
      expect(projected.resolution).toEqual([
        "Escalate the component-model addition or deletion; a gitlink bump only advances an existing " +
          "component, never adds or removes one.",
      ])
    }
  })

  it("projects a merge-tip carrier's exact linear rebuild commands", () => {
    const failure = actionableFailure({
      code: "merge-tip-carrier",
      message:
        "yrd: change 'PR42' root branch tip 'deadbeef' is a merge commit with 2 parents; " +
        "merge inside the affected component repository, fast-forward that component's main, rebuild the root " +
        "carrier as one linear pin-bump commit, then run 'yrd pr submit <branch>' and " +
        "'yrd pr recut PR42 --preflight --queue --apply'",
    })

    expect(failure).toMatchObject({
      code: "merge-tip-carrier",
      cause: expect.stringMatching(/merge inside.*component.*linear pin-bump/iu),
      resolution: ["yrd pr submit <branch>", "yrd pr recut PR42 --preflight --queue --apply"],
    })
  })

  it("names both root commits and pins in a recut divergence", () => {
    const failure = actionableFailure(RECUT_CONFLICT)

    expect(failure.code).toBe("recut-gitlink-conflict")
    expect(failure.cause).toContain(`target root '${BASE_ROOT}'`)
    expect(failure.cause).toContain(`replayed authored root '${AUTHORED_ROOT}'`)
    expect(failure.cause).toContain(`'${BASE_PIN}'`)
    expect(failure.cause).toContain(`'${AUTHORED_PIN}'`)
    expect(failure.reference).toBe("README.md#resolving-divergent-gitlink-pins")
  })

  it("prescribes a fresh revision, never a retry, for a diverged recut base", () => {
    const failure = actionableFailure(DIVERGED_RECUT_BASE, { delivery: "submitted" })

    expect(failure.code).toBe("recut-base-diverged")
    // Both bases stay in the result: the operator checks the fresh revision
    // against the base the queue actually holds, not the one it certified.
    expect(failure.cause).toContain(BASE_PIN)
    expect(failure.cause).toContain(BASE_ROOT)
    expect(failure.resolution).toEqual(["yrd pr submit <branch>", "yrd pr recut PR1986 --preflight --queue --apply"])
    // The parked PR must never be told to run the command that parked it.
    expect(failure.resolution).not.toContain("Correct the cause above, then retry the same Yrd command.")
    expect(failure.reference).toBe("README.md#pr-eligibility-and-checks")
  })

  it("extracts exact commands already embedded in a mechanical remedy", () => {
    const failure = actionableFailure({
      code: "config-drift",
      message:
        "queue base 'main' installed baseline is stale. Run 'yrd admin queue deinit main' then 'yrd admin queue init main' to migrate it.",
    })

    expect(failure.resolution).toEqual(["yrd admin queue deinit main", "yrd admin queue init main"])
    expect(formatActionableFailure(failure)).toContain("err=config-drift")
    expect(formatActionableFailure(failure)).toContain("cause: queue base 'main' installed baseline is stale")
    expect(formatActionableFailure(failure)).toContain("resolve: yrd admin queue deinit main")
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
 * the PR's current delivery state refuses is a wrong instruction, not a hint.
 * The authored-gitlink projection used to print `yrd pr create <branch>`
 * unconditionally; on a submitted PR both printed steps refuse.
 */
describe("22396 — state-aware remedies", () => {
  it("emits no command the PR's delivery state refuses, in every state", () => {
    for (const delivery of ALL_DELIVERY_STATES) {
      const failure = actionableFailure(AUTHORED_GITLINK, { delivery })
      const refused = failure.resolution.filter((step) => refusedBy(delivery, step))
      expect({ delivery, refused }).toEqual({ delivery, refused: [] })
      expect(failure.resolution.length).toBeGreaterThan(0)
    }
  })

  it("keeps the submit remedy available for an already-submitted authored-gitlink PR", () => {
    const failure = actionableFailure(AUTHORED_GITLINK, { delivery: "submitted" })

    expect(failure.resolution).toEqual(["yrd pr submit <branch>"])
  })

  it("keeps the submit remedy available for a terminal PR", () => {
    for (const delivery of ["integrated", "already-landed", "withdrawn", "canceled"] as const) {
      expect(actionableFailure(AUTHORED_GITLINK, { delivery }).resolution).toEqual(["yrd pr submit <branch>"])
    }
  })

  it("defaults to the submit remedy when no PR is in hand", () => {
    expect(actionableFailure(AUTHORED_GITLINK).resolution).toEqual(["yrd pr submit <branch>"])
  })

  it("escalates the recut gitlink conflict instead of printing the merge as executable", () => {
    const failure = actionableFailure(RECUT_CONFLICT, { delivery: "submitted" })

    expect(failure.resolution).toEqual([
      `Escalate to a human: composing 'vendor/yrd' from authored pin '${AUTHORED_PIN}' onto base pin '${BASE_PIN}' ` +
        "needs merge-conflict judgment; do not run the recipe mechanically.",
    ])
    expect(failure.resolution.some((step) => /^(?:git|yrd)\s/u.test(step))).toBe(false)
    expect(failure.escalation?.reason).toContain(`git -C vendor/yrd merge ${BASE_PIN}`)
    expect(failure.escalation?.steps).toEqual([
      "git -C vendor/yrd fetch --all --prune",
      `git -C vendor/yrd switch -c yrd/compose-PR77 ${AUTHORED_PIN}`,
      `git -C vendor/yrd merge ${BASE_PIN}`,
      "git -C vendor/yrd push -u origin HEAD",
      'git add vendor/yrd && git commit -m "fix(yrd): compose vendor/yrd pins"',
      "yrd pr submit <branch>",
      "yrd pr recut PR77 --preflight --queue --apply",
    ])
    expect(failure.reference).toBe("README.md#resolving-divergent-gitlink-pins")
  })

  it("carries the escalation into the human and structured projections", () => {
    const failure = actionableFailure(RECUT_CONFLICT, { delivery: "pushed" })

    const human = formatHumanFailure(failure)
    expect(human).toContain("resolve: Escalate to a human")
    expect(human).toContain(`escalate: git -C vendor/yrd merge ${BASE_PIN}`)
    expect(human).toContain("manual: git -C vendor/yrd fetch --all --prune")
    expect(human).toContain("manual: yrd pr create <branch>")
    expect(human).toContain("reference: README.md#resolving-divergent-gitlink-pins")

    const structured = formatActionableFailure(failure)
    expect(structured).toContain("err=recut-gitlink-conflict")
    expect(structured).toContain("resolve: Escalate to a human")
    expect(structured).toContain("manual: git -C vendor/yrd push -u origin HEAD")
  })

  it("threads the PR's delivery state through the pr view and run detail projections", () => {
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
        message: "yrd: PR 'PR42' changes generated-only gitlinks [vendor/yrd]",
      }),
    )

    // A bare CLI diagnostic still points at the carrier-free submit remedy.
    expect(stderr).toBe(
      [
        "error: PR 'PR42' changes generated-only gitlinks [vendor/yrd]",
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
      createFailure({ kind: "refusal", code: "pr-missing", message: "yrd: no PR 'PR404'" }),
    )

    expect(stderr).toBe("error: no PR 'PR404'\n")
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
              message: "yrd: PR 'PR42' changes generated-only gitlinks [vendor/yrd]",
            },
          }),
        ),
      ],
    })
    const data = queueShowData(run, [], [], undefined, "rejected")

    expect(data.failure).toMatchObject({
      code: "authored-gitlink",
      cause: "PR 'PR42' changes generated-only gitlinks [vendor/yrd]",
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
      expect(output).toContain("PR 'PR42' changes generated-only gitlinks [vendor/yrd]")
      expect(output).toContain("RESOLVE")
      expect(output).toContain("yrd pr submit <branch>")
      expect(output).toContain("REFERENCE README.md#pr-eligibility-and-checks")
      if (!compact) {
        expect(output.split("\n").find((row) => row.trimStart().startsWith("merge"))).toContain("err=authored-gitlink")
      }
    }
  })
})
