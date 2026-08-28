/**
 * @failure  A Yrd refusal a person with authority may legitimately override
 *           prints no `escalate:` line, so its reader cannot tell "nobody may
 *           land this" from "a person with authority may, and here is how" —
 *           and the fallback is a seat routing around the gate. The
 *           `ActionableFailure.escalation` field, its `escalate:`/`manual:`
 *           renderer, and the `formatHumanFailure` filter that deliberately
 *           keeps an escalation sentence verbatim were all built and tested,
 *           with ZERO production sites populating them.
 *           @i/10-yrd/escalation-channel-unused.
 * @level    l1 (pure projection + string render; no repo, no subprocess)
 * @consumer @i/10-yrd/escalation-channel-unused
 *
 * The census's VALUE is its absence half: a refusal printing no escalation is
 * asserting no override exists. That assertion is only worth reading if the
 * table is complete, so this file walks the whole closed `YRD_REFUSAL_CODES`
 * vocabulary and proves every uncensused code renders none — the negative
 * control the bead's acceptance names, not a spot check of one code.
 */
import { createElement } from "react"
import { createFailure } from "@yrd/core"
import { YRD_REFUSAL_CODES, type RefusalCode } from "@yrd/queue"
import { renderString } from "silvery"
import { describe, expect, it } from "vitest"
import { fixtureJob, fixturePr, fixtureRun, fixtureStep } from "../dev/queue-timeline-fixtures.ts"
import { actionableFailure, formatActionableFailure, formatHumanFailure } from "../src/actionable-error.ts"
import { diagnostic } from "../src/output.tsx"
import { QueueShowView, queueShowData } from "../src/queue-status-view.tsx"
import { classifyRefusalRemedy } from "../src/refusal-remedy.ts"

/** Every code the census wires, with a message in the exact shape its producer
 * emits — the escalation text substitutes the change, base and reviewer OUT of
 * that message, so a fabricated shape would prove nothing about live output. */
const CENSUSED: readonly Readonly<{ code: RefusalCode; message: string; expect: readonly (string | RegExp)[] }>[] = [
  {
    code: "authored-gitlink",
    // command.ts's `refused` arm, plus the min-commit prose that marks the
    // component-model branch (the only authorizable arm of this code).
    message:
      "yrd: change 'PR42' changes generated-only gitlinks [vendor/new]; new submodule 'vendor/new'; " +
      "a change of min commits advances existing submodules only; a gitlink bump cannot express this component-model change",
    expect: ["@cto rules on the component model", "--prop 'component-model-change=<add|remove> <path>; ruling "],
  },
  {
    code: "component-model-authorization-refused",
    message:
      "yrd: change 'PR42' component-model ruling '11111111-2222-3333-4444-555555555555' did not authorize " +
      "'remove vendor/old': ruling names a different path",
    expect: ["Only @cto can widen or replace the ruling", "--prop 'component-model-change="],
  },
  {
    code: "component-model-authorizer-unavailable",
    message:
      "yrd: change 'PR42' requests 'add vendor/new' under ruling '11111111-2222-3333-4444-555555555555', but this " +
      "Yrd host has no verdict-message resolver; ask @cto for the ruling and run through the hh Yrd host",
    expect: ["host operator owns the verdict-message resolver", "Submit through the hh Yrd host"],
  },
  {
    code: "review-required",
    message: "yrd: change 'PR42' needs approval for revision 3",
    expect: ["A reviewer may approve this revision", "Reviewer runs: yrd pr review PR42 --approve --by <reviewer>"],
  },
  {
    code: "review-rejected",
    message: "yrd: change 'PR42' was rejected by @cto for revision 3",
    expect: ["@cto rejected this revision", "@cto runs: yrd pr review PR42 --approve --by @cto"],
  },
  {
    code: "queue-paused",
    message: "yrd: queue 'main' is paused: cutover in progress; change 'PR42' is not in the allowed set",
    expect: [
      "Whoever declared the hold may admit this change through it or lift it",
      "yrd queue pause main --reason <why> --for <ttl> --allow PR42",
      "Or lift the hold: yrd queue resume main",
    ],
  },
]

const CENSUSED_CODES: ReadonlySet<string> = new Set(CENSUSED.map((entry) => entry.code))

/** Refusals a person CANNOT override, each for a different reason, kept as
 * named specimens rather than only as members of the vocabulary sweep below:
 * a wholesale walk that silently stopped enumerating would still pass. */
const UNOVERRIDABLE: readonly Readonly<{ code: RefusalCode; message: string }>[] = [
  // Names its own cure exhaustively (run.ts refuseSubmitWithoutMergeAuthority).
  {
    code: "no-merge-authority",
    message: "yrd: '/repo' declares no merge authority (selected config 'merge: none'), so its queue has no runner",
  },
  // The author pushes the commit to the submodule's own main; nobody's ruling
  // substitutes for that.
  {
    code: "min-commit-unpublished",
    message:
      "yrd: change 'PR42' cannot fill the shaset: 'vendor/yrd' authored min commit 'deadbeef' is not on submodule " +
      "main 'cafebabe'; push it to the submodule's own main first, then resubmit",
  },
  // A red check is a fact about the branch. No authority makes it green.
  { code: "required-check-failed", message: "yrd: change 'PR42' required check failed in R7" },
]

describe("escalation census: the refusals a person may authorize past", () => {
  it("populates escalation for every censused refusal and renders it in both text projections", () => {
    for (const { code, message, expect: expected } of CENSUSED) {
      const failure = actionableFailure({ code, message })
      expect(failure.escalation, `${code} carries an escalation`).toBeDefined()
      expect(failure.escalation?.reason.length ?? 0).toBeGreaterThan(0)
      expect(failure.escalation?.steps.length ?? 0).toBeGreaterThan(0)

      const structured = formatActionableFailure(failure)
      const human = formatHumanFailure(failure)
      for (const rendered of [structured, human]) {
        expect(rendered, `${code} renders an escalate: line`).toContain(`escalate: ${failure.escalation?.reason ?? ""}`)
        for (const step of failure.escalation?.steps ?? []) expect(rendered).toContain(`manual: ${step}`)
        for (const fragment of expected) {
          if (typeof fragment === "string") expect(rendered).toContain(fragment)
          else expect(rendered).toMatch(fragment)
        }
      }
    }
  })

  it("replaces the false correct-and-retry line, which is what the refusal used to say instead", () => {
    for (const { code, message } of CENSUSED) {
      const failure = actionableFailure({ code, message })
      // "Correct the cause above, then retry the same Yrd command" is a lie
      // when the cause is a decision somebody else has to make.
      expect(failure.resolution, `${code} keeps a single blocked-reason line`).toHaveLength(1)
      expect(failure.resolution[0]).not.toContain("retry the same Yrd command")
      expect(formatHumanFailure(failure)).toContain(`resolve: ${failure.resolution[0] ?? ""}`)
    }
  })

  it("names a concrete actor or command in every escalation — never 'contact support'", () => {
    for (const { code, message } of CENSUSED) {
      const failure = actionableFailure({ code, message })
      const text = [failure.escalation?.reason ?? "", ...(failure.escalation?.steps ?? [])].join(" ")
      expect(text, `${code} names an actor or an exact command`).toMatch(
        /@cto|reviewer|host operator|Whoever declared the hold|yrd (?:pr|queue) /iu,
      )
      expect(text).not.toMatch(/contact support|file a ticket|reach out to the team/iu)
      // A placeholder that survived substitution means the message shape the
      // producer emits and the shape this census parses have drifted apart.
      expect(text, `${code} substituted its identifiers out of the message`).not.toMatch(
        /<change>|<base>|<reviewer> rejected/u,
      )
    }
  })
})

describe("escalation census: absence means no override exists", () => {
  it("renders no escalation for a refusal nobody may authorize past", () => {
    for (const { code, message } of UNOVERRIDABLE) {
      const failure = actionableFailure({ code, message })
      expect(failure.escalation, `${code} must claim no override`).toBeUndefined()
      expect(formatActionableFailure(failure)).not.toContain("escalate:")
      expect(formatActionableFailure(failure)).not.toContain("manual:")
      expect(formatHumanFailure(failure)).not.toContain("escalate:")
    }
  })

  it("walks the whole closed refusal vocabulary: only censused codes escalate", () => {
    // The denominator matters — a vocabulary that stopped enumerating would
    // make this sweep vacuous while still passing.
    expect(YRD_REFUSAL_CODES.length).toBeGreaterThan(150)
    const escalating: string[] = []
    for (const code of YRD_REFUSAL_CODES) {
      // A neutral message: no retained-workspace marker, no component-model
      // prose, so every code takes its own default projection arm.
      const failure = actionableFailure({ code, message: `yrd: change 'PR42' refused with ${code}` })
      if (failure.escalation !== undefined) escalating.push(code)
    }
    // authored-gitlink escalates only on its component-model arm, which this
    // neutral message is not — so the sweep's expected set is the other five.
    expect(escalating.toSorted()).toEqual([...CENSUSED_CODES].filter((code) => code !== "authored-gitlink").toSorted())
  })

  it("keeps the ordinary authored-gitlink refusal unescalated — the same code, the other arm", () => {
    const ordinary = actionableFailure({
      code: "authored-gitlink",
      message: "yrd: change 'PR42' changes generated-only gitlinks [vendor/yrd]",
    })
    expect(ordinary.escalation).toBeUndefined()
    expect(ordinary.resolution).toEqual([
      "Get the named commit onto the component's own main first (see cause); " +
        "then resubmit: 'yrd pr submit <branch>'.",
    ])

    const componentModel = actionableFailure({
      code: "authored-gitlink",
      message:
        "yrd: change 'PR42' changes generated-only gitlinks [vendor/new]; new submodule 'vendor/new'; " +
        "a change of min commits advances existing submodules only",
    })
    expect(componentModel.escalation?.reason).toContain("@cto rules on the component model")
    // The pre-existing resolution sentence is unchanged; the census supplies
    // the actor it never named, it does not rewrite the act.
    expect(componentModel.resolution).toEqual([
      "Escalate the component-model addition or deletion; a gitlink bump only advances an existing " +
        "submodule, never adds or removes one.",
    ])
  })
})

describe("escalation census: the runner's classification is unchanged", () => {
  it("classifies every censused refusal as judgment, exactly as it did before it escalated", () => {
    // classifyRefusalRemedy short-circuits on `escalation`, so wiring a code
    // whose printed remedy WAS a mechanical redelivery drill would silently
    // disable the runner's auto-remedy for it. Every censused code already
    // classified as judgment (its remedy was the generic correct-and-retry
    // line, or prose) — this proves the census took no such code.
    for (const { code, message } of CENSUSED) {
      const remedy = classifyRefusalRemedy({ code, message }, { branch: "feat/x" })
      expect(remedy.kind, `${code} stays judgment-required`).toBe("judgment")
      const escalation = actionableFailure({ code, message }).escalation
      expect(remedy.kind === "judgment" ? remedy.reason : "").toBe(escalation?.reason)
    }
  })
})

describe("escalation census: end to end in CLI output", () => {
  it("prints escalate:/manual: on stderr for a refusal a reviewer may authorize", async () => {
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
        code: "review-required",
        message: "yrd: change 'PR42' needs approval for revision 3",
      }),
    )

    expect(stderr).toBe(
      [
        "error: change 'PR42' needs approval for revision 3",
        "resolve: Approval is another seat's act; no retry of this command can supply it.",
        "escalate: A reviewer may approve this revision — the queue admits the change the moment one does.",
        "manual: Reviewer runs: yrd pr review PR42 --approve --by <reviewer>",
        "manual: The approval binds to the revision reviewed; a later push needs a fresh one.",
        "",
      ].join("\n"),
    )
  })

  it("prints no escalate: line for a refusal nobody may authorize past", async () => {
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
        code: "min-commit-unpublished",
        message:
          "yrd: change 'PR42' cannot fill the shaset: 'vendor/yrd' authored min commit 'deadbeef' is not on " +
          "submodule main 'cafebabe'; push it to the submodule's own main first, then resubmit",
      }),
    )

    expect(stderr).not.toContain("escalate:")
    expect(stderr).not.toContain("manual:")
    expect(stderr).toContain("error: change 'PR42' cannot fill the shaset")
  })

  it("renders ESCALATE/MANUAL in the queue view, at both widths", async () => {
    const pr = fixturePr("PR42", "submitted", "2026-07-18T18:00:00.000Z")
    const run = fixtureRun("R42", [pr], "failed", "2026-07-18T18:01:00.000Z", {
      finishedAt: "2026-07-18T18:02:00.000Z",
      steps: [
        fixtureStep(
          "merge",
          fixtureJob("J42", "failed", {
            error: {
              code: "queue-paused",
              message: "yrd: queue 'main' is paused: cutover in progress; change 'PR42' is not in the allowed set",
            },
          }),
        ),
      ],
    })
    const data = queueShowData(run)

    expect(data.failure?.escalation?.steps).toEqual([
      "Admit this one through by re-declaring the hold: yrd queue pause main --reason <why> --for <ttl> --allow PR42",
      "Or lift the hold: yrd queue resume main",
    ])

    for (const compact of [true, false]) {
      const output = await renderString(createElement(QueueShowView, { data, compact }), {
        width: compact ? 70 : 220,
        height: 80,
        plain: true,
      })
      expect(output).toContain("ESCALATE")
      expect(output).toContain("MANUAL")
      expect(output).toContain("yrd queue resume main")
    }
  })
})
