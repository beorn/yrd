/**
 * 21565 — persisted/watch projections carry a stable code, cause, and
 * resolution steps. Ordinary command stderr is concise, while deep failures
 * keep concrete remedies and durable operator references. Historical Queue
 * records are enriched at read time, so this contract needs no journal migration.
 */

import { createElement } from "react"
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
import { QueueShowView, queueShowData } from "../src/queue-status-view.tsx"

const BASE_ROOT = "a".repeat(40)
const AUTHORED_ROOT = "b".repeat(40)
const BASE_PIN = "c".repeat(40)
const AUTHORED_PIN = "d".repeat(40)

describe("actionable failure projection", () => {
  it("turns authored-gitlink into the exact create-to-recut drill", () => {
    expect(
      actionableFailure({
        code: "authored-gitlink",
        message: "yrd: PR 'PR42' changes generated-only gitlinks [vendor/yrd]",
      }),
    ).toEqual({
      code: "authored-gitlink",
      cause: "PR 'PR42' changes generated-only gitlinks [vendor/yrd]",
      resolution: ["yrd pr create <branch>", "yrd pr recut PR42 --preflight --queue"],
      reference: "README.md#pr-eligibility-and-checks",
    } satisfies ActionableFailure)
  })

  it("names both root commits and pins in a recut divergence and gives the compose recipe", () => {
    const failure = actionableFailure({
      code: "recut-gitlink-conflict",
      message:
        `yrd: PR 'PR77' could not recut: target root '${BASE_ROOT}' pins submodule 'vendor/yrd' to '${BASE_PIN}'; ` +
        `replayed authored root '${AUTHORED_ROOT}' pins it to '${AUTHORED_PIN}'; ancestry walk failed because neither ` +
        "submodule commit is an ancestor of the other",
    })

    expect(failure.code).toBe("recut-gitlink-conflict")
    expect(failure.cause).toContain(`target root '${BASE_ROOT}'`)
    expect(failure.cause).toContain(`replayed authored root '${AUTHORED_ROOT}'`)
    expect(failure.cause).toContain(`'${BASE_PIN}'`)
    expect(failure.cause).toContain(`'${AUTHORED_PIN}'`)
    expect(failure.resolution).toEqual([
      "git -C vendor/yrd fetch --all --prune",
      `git -C vendor/yrd switch -c yrd/compose-PR77 ${AUTHORED_PIN}`,
      `git -C vendor/yrd merge ${BASE_PIN}`,
      "git -C vendor/yrd push -u origin HEAD",
      'git add vendor/yrd && git commit -m "fix(yrd): compose vendor/yrd pins"',
      "yrd pr create <branch>",
      "yrd pr recut PR77 --preflight --queue",
    ])
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

    expect(stderr).toBe(
      [
        "error: PR 'PR42' changes generated-only gitlinks [vendor/yrd]",
        "resolve: yrd pr create <branch>",
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
    const data = queueShowData(run)

    expect(data.failure).toMatchObject({
      code: "authored-gitlink",
      cause: "PR 'PR42' changes generated-only gitlinks [vendor/yrd]",
      resolution: ["yrd pr create <branch>", "yrd pr recut PR42 --preflight --queue"],
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
