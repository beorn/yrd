/**
 * 21565 — persisted/watch projections carry a stable code, cause, and
 * resolution steps. Ordinary command stderr is concise, while deep failures
 * keep concrete remedies and durable operator references. Historical Queue
 * records are enriched at read time, so this contract needs no journal migration.
 */

import { createElement } from "react"
import type { PRDeliveryState } from "@yrd/bay"
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
import { prDetailData, QueueShowView, queueShowData } from "../src/queue-status-view.tsx"

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

const ALL_DELIVERY_STATES: readonly PRDeliveryState[] = [
  "pushed",
  "submitted",
  "needs-author",
  "rejected",
  "integrated",
  "already-landed",
  "withdrawn",
  "canceled",
]

const RECUT_REFUSING: ReadonlySet<PRDeliveryState> = new Set<PRDeliveryState>([
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
function refusedBy(delivery: PRDeliveryState, command: string): boolean {
  if (command.startsWith("yrd pr create")) return delivery !== "pushed"
  if (command.startsWith("yrd pr recut")) return RECUT_REFUSING.has(delivery)
  return false
}

describe("actionable failure projection", () => {
  it("turns authored-gitlink on a draft PR into the exact create-to-recut drill", () => {
    expect(actionableFailure(AUTHORED_GITLINK, { delivery: "pushed" })).toEqual({
      code: "authored-gitlink",
      cause: "PR 'PR42' changes generated-only gitlinks [vendor/yrd]",
      resolution: ["yrd pr create <branch>", "yrd pr recut PR42 --preflight --queue"],
      reference: "README.md#pr-eligibility-and-checks",
    } satisfies ActionableFailure)
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

  it("extracts exact commands already embedded in a mechanical remedy", () => {
    const failure = actionableFailure({
      code: "config-drift",
      message:
        "queue base 'main' installed baseline is stale. Run 'yrd queue deinit main' then 'yrd queue init main' to migrate it.",
    })

    expect(failure.resolution).toEqual(["yrd queue deinit main", "yrd queue init main"])
    expect(formatActionableFailure(failure)).toContain("err=config-drift")
    expect(formatActionableFailure(failure)).toContain("cause: queue base 'main' installed baseline is stale")
    expect(formatActionableFailure(failure)).toContain("resolve: yrd queue deinit main")
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

  it("gives a submitted PR the submit record verb, never create", () => {
    const failure = actionableFailure(AUTHORED_GITLINK, { delivery: "submitted" })

    expect(failure.resolution).toEqual(["yrd pr submit <branch>", "yrd pr recut PR42 --preflight --queue"])
  })

  it("drops the recut step for a terminal PR that cannot be recut", () => {
    for (const delivery of ["integrated", "already-landed", "withdrawn", "canceled"] as const) {
      expect(actionableFailure(AUTHORED_GITLINK, { delivery }).resolution).toEqual(["yrd pr submit <branch>"])
    }
  })

  it("defaults to the record verb no state refuses when no PR is in hand", () => {
    // An unthreaded projection cannot know the state, so it must emit only
    // commands every state accepts — `create` is not one of them.
    expect(actionableFailure(AUTHORED_GITLINK).resolution).toEqual([
      "yrd pr submit <branch>",
      "yrd pr recut PR42 --preflight --queue",
    ])
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
      "yrd pr recut PR77 --preflight --queue",
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

    const detail = prDetailData(pr, [run])
    const projected = detail.runs[0]
    expect(projected?.failure?.resolution).toEqual(["yrd pr submit <branch>", "yrd pr recut PR42 --preflight --queue"])
    expect(projected?.steps[0]?.failure?.resolution).toEqual(projected?.failure?.resolution)

    const draft = queueShowData(run, [], [], undefined, "pushed")
    expect(draft.failure?.resolution).toEqual(["yrd pr create <branch>", "yrd pr recut PR42 --preflight --queue"])
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

    // A bare CLI diagnostic has no PR in hand, so it emits the record verb no
    // delivery state refuses (22396).
    expect(stderr).toBe(
      [
        "error: PR 'PR42' changes generated-only gitlinks [vendor/yrd]",
        "resolve: yrd pr submit <branch>",
        "resolve: yrd pr recut PR42 --preflight --queue",
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
      resolution: ["yrd pr submit <branch>", "yrd pr recut PR42 --preflight --queue"],
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
      expect(output).toContain("yrd pr recut PR42 --preflight --queue")
      expect(output).toContain("REFERENCE README.md#pr-eligibility-and-checks")
      if (!compact) {
        expect(output.split("\n").find((row) => row.trimStart().startsWith("merge"))).toContain("err=authored-gitlink")
      }
    }
  })
})
