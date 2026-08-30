/**
 * @failure A refusal names a cure that does not exist. `c63fcf01` fixed the
 * legacy-identity messages that named a migration verb nothing implements;
 * `fc6bd709` then found the SAME wrong cure written a second time as prose in
 * the refusal registry. Two unvalidated copies is how a wrong remedy survived
 * long enough to cost PR2599 five hours. The queue's own required-check
 * refusal still says "or request fresh checks", and no verb requests checks.
 * @level l2
 * @consumer @yrd/cli refusal rendering, @i/10-yrd/refusals-name-their-cure
 *
 * The oracle is the REAL Commander program (`runYrdHelp`), not a hand-listed
 * verb table: a second table would be one more copy to drift, which is the
 * defect this file exists to catch.
 */
import { describe, expect, it } from "vitest"
import { canonicalRefusalCode, COMPOSITION_FAILURE_BUCKETS } from "@yrd/queue"
import { actionableFailure, formatActionableFailure, formatHumanFailure } from "../src/actionable-error.ts"
import { classifyRefusalRemedy } from "../src/refusal-remedy.ts"
import { REFUSAL_CURES, refusalCure, type RefusalCureText } from "../src/refusal-cure.ts"
import { runYrdHelp } from "../src/run.ts"

/** Every `yrd …` command line a registered cure prints, evidence and
 * resolution alike — the lines a reader is being told to type. */
function cureCommands(cure: RefusalCureText): readonly string[] {
  return [...cure.evidence, ...cure.resolution].filter((line) => line.startsWith("yrd "))
}

const helpCache = new Map<string, Promise<string>>()

function help(path: readonly string[]): Promise<string> {
  const key = path.join(" ")
  const cached = helpCache.get(key)
  if (cached !== undefined) return cached
  const pending = (async () => {
    let out = ""
    const io = {
      stdout: (text: string) => {
        out += text
      },
      stderr: (text: string) => {
        out += text
      },
      color: false,
      columns: 200,
    }
    await runYrdHelp([...path, "--help"], io)
    return out
  })()
  helpCache.set(key, pending)
  return pending
}

/** Whether the real CLI registers this command path. A group's own help lists
 * its subcommands, so `yrd pr checks …` is proven by `checks` appearing in
 * `yrd pr --help`'s command list. */
async function cliRegisters(command: string): Promise<boolean> {
  const [binary, ...rest] = command.trim().split(/\s+/u)
  if (binary !== "yrd") return false
  // Drop operands/flags: `<selector>`, `[target]`, `--json`, a literal arg.
  const words = rest.filter((word) => /^[a-z][a-z-]*$/u.test(word))
  const [group, verb] = words
  if (group === undefined) return false
  if (verb === undefined) return (await help([])).includes(` ${group}`)
  const text = await help([group])
  return new RegExp(`^\\s+${verb}\\b`, "mu").test(text)
}

const CODES = Object.keys(REFUSAL_CURES)

describe("the refusal-cure census names only cures that exist", () => {
  it("registers a cure for every refusal this bead's outcome names", () => {
    for (const code of [
      "stale-check",
      "merge-push-failed",
      "checkpoint-migration-certificate-missing",
      "check-failed",
      "component-main-inspection-failed",
    ]) {
      expect(CODES, `'${code}' has no registered cure`).toContain(code)
    }
  })

  it("every command a cure prints is a verb the real CLI registers", async () => {
    const unknown: string[] = []
    for (const code of CODES) {
      const cure = refusalCure(code, "")
      expect(cure, `'${code}' is registered but produced no cure`).toBeDefined()
      for (const command of cureCommands(cure as RefusalCureText)) {
        if (!(await cliRegisters(command))) unknown.push(`${code}: '${command}'`)
      }
    }
    expect(unknown, `a cure names a verb the CLI does not register:\n${unknown.join("\n")}`).toEqual([])
  }, 120_000)

  it("proves the oracle can FAIL — a verb nobody registers is rejected", async () => {
    expect(await cliRegisters("yrd pr migrate-identity <change>")).toBe(false)
    expect(await cliRegisters("yrd checks request-fresh")).toBe(false)
    // …and can pass, so a broken help capture cannot mark every cure unknown.
    expect(await cliRegisters("yrd pr submit <branch>")).toBe(true)
  }, 120_000)

  it("says something in every cure: a cure with no step must say why there is none", () => {
    for (const code of CODES) {
      const cure = refusalCure(code, "") as RefusalCureText
      const said = cure.resolution.length > 0 || cure.evidence.length > 0 || cure.blocked !== undefined
      expect(said, `'${code}' registers an empty cure`).toBe(true)
      if (cure.resolution.length === 0) {
        expect(cure.blocked, `'${code}' prints no step and does not say why`).toBeDefined()
      }
    }
  })

  it("prints only executable steps as the remedy — prose belongs in `blocked`", () => {
    for (const code of CODES) {
      const cure = refusalCure(code, "") as RefusalCureText
      for (const step of cure.resolution) {
        expect(step, `'${code}' resolution step is not a command`).toMatch(/^yrd\s/u)
      }
    }
  })

  it("reaches the RENDERED bytes, not just the source string (the 2026-08-27 ADR obligation)", () => {
    const rendered = formatHumanFailure(
      actionableFailure({ code: "stale-check", message: "queue 'main' moved from checked base 'aaa' to 'bbb'" }),
    )
    expect(rendered).toContain("blocked:")
    expect(rendered).toContain("evidence:")
    const structured = formatActionableFailure(
      actionableFailure({
        code: "check-failed",
        message: "affected-tests command exited 1; full output: /t/output.log",
      }),
    )
    expect(structured).toContain("evidence: /t/output.log")
    expect(structured).toMatch(/resolve: yrd /u)
  })

  it("exposes reason, evidence and remedy in the JSON envelope, not cause/resolution alone", () => {
    // The acceptance row's shape check, on the same object `--json` serializes
    // (`HumanFailureProjection` is `ActionableFailure` plus `summary`).
    const projected = JSON.parse(
      JSON.stringify(
        actionableFailure({
          code: "component-main-inspection-failed",
          message:
            "yrd: change 'PR2699' changes submodule pins whose submodule main could not be inspected:\n" +
            "submodule 'sub/yrd' pin 'deadbeef': could not fetch origin",
        }),
      ),
    ) as Record<string, unknown>
    expect(Object.keys(projected)).toEqual(expect.arrayContaining(["cause", "blocked", "evidence", "resolution"]))
    expect(projected["evidence"]).toEqual([{ text: "yrd pr runs PR2699" }])
    expect(projected["resolution"]).toEqual(["yrd gitlink advance sub/yrd"])
    // The refusal names the submodule it is about, not a placeholder.
    expect(String(projected["blocked"])).toContain("sub/yrd")
  })

  it("changes no refusal from judgment to something the runner applies by itself", () => {
    for (const code of CODES) {
      const remedy = classifyRefusalRemedy(
        { code, message: `change 'PR1' refused` },
        { branch: "task/x", delivery: "submitted" },
      )
      expect(remedy.kind, `'${code}' became mechanically self-applicable`).toBe("judgment")
    }
  })
})

/**
 * @failure The census above only ever proves what IS registered is sound; it
 * never proved the needs-author vocabulary was COVERED. `REFUSAL_CURES` held
 * 6 codes and 0 of the 16 `COMPOSITION_FAILURE_BUCKETS["needs-author"]`
 * (queue.ts) names — every one of those refusals stops an author with a
 * remedy that, if it existed at all, lived only as prose inside the raw
 * `message` string: invisible to `--json`, and invisible to this file's own
 * sweep, which walks `Object.keys(REFUSAL_CURES)` and so cannot see a code
 * that never became a key. This sweep reads the bucket instead — the SAME
 * live source `composition-failure-buckets.test.ts` derives its own
 * denominator from — so a code added to (or renamed out of) the bucket moves
 * this sweep's target too, and a future cure written only into a message
 * string (never into the registry) reddens here immediately rather than
 * waiting for the next person who asks the registry "what is the cure for
 * code X" and gets nothing.
 */
describe("the refusal-cure census covers every needs-author code", () => {
  const NEEDS_AUTHOR_CODES = [...COMPOSITION_FAILURE_BUCKETS["needs-author"]]

  it("derives a non-trivial needs-author set (denominator guard against a vacuous sweep)", () => {
    expect(NEEDS_AUTHOR_CODES.length).toBeGreaterThanOrEqual(16)
  })

  it("gives every needs-author code a REGISTERED cure — CURE_CENSUS or ESCALATION_CENSUS — never bare prose a producer's message happens to carry", () => {
    const uncured: string[] = []
    for (const code of NEEDS_AUTHOR_CODES) {
      // `authored-gitlink` is handled by its own dual-arm special case in
      // `actionableFailure` (actionable-error.ts): the ordinary arm prints
      // its own remedy, the component-model arm escalates through
      // ESCALATION_CENSUS. A neutral probe message below only ever exercises
      // the ordinary arm — escalation-census.test.ts already censuses both
      // arms directly — so this sweep excludes it by name rather than
      // reading a neutral message as "uncovered".
      if (code === "authored-gitlink") continue
      const canonical = canonicalRefusalCode(code)
      const registeredCure = canonical !== undefined && CODES.includes(canonical)
      // A neutral probe: no retained-workspace marker, no check headline, no
      // component-model prose — so a code that escalates here does so from
      // ESCALATION_CENSUS membership alone, never from message content.
      const failure = actionableFailure({ code, message: `yrd: change 'PR1' refused with ${code}` })
      if (!registeredCure && failure.escalation === undefined) uncured.push(code)
    }
    expect(uncured, `needs-author code(s) with no registered cure: ${uncured.join(", ")}`).toEqual([])
  })

  it("names the fourteen self-serve needs-author codes this batch registered — a positive control naming the exact set the sweep above proved, so a future deletion of one entry fails HERE too, pinpointed by name", () => {
    const selfServe = [
      "candidate-change-id-missing",
      "recut-change-id-missing",
      "contribution-inspection",
      "deletion-inspection",
      "gitlink-inspection",
      "refused-path-inspection",
      "payload-certificate",
      "dropped-parent-contribution",
      "unauthored-path-deletion",
      "min-commit-unpublished",
      "carrier-drops-landed",
      "composition-retired",
      "refused-path",
      "wrapper-mismatch",
    ]
    // The escalation-gated two plus this list account for the whole bucket —
    // proof this list is not a subset that happens to pass, but the complete
    // complement.
    const escalated = ["authored-gitlink", "component-model-authorization-refused"]
    expect(selfServe.toSorted()).toEqual(NEEDS_AUTHOR_CODES.filter((code) => !escalated.includes(code)).toSorted())
    for (const code of selfServe) {
      expect(CODES, `'${code}' is a needs-author code with no CURE_CENSUS entry`).toContain(code)
    }
  })
})
