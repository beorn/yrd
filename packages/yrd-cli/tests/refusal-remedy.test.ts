/**
 * @failure Every refusal remedy is treated as human work, so a refusal whose printed remedy is fully deterministic still waits for an operator to type it — and a refusal that genuinely needs judgment could be executed mechanically.
 * @level l1
 * @consumer @yrd/cli resident runner
 */
import { describe, expect, it } from "vitest"
import { classifyRefusalRemedy, formatRemedyCommand } from "../src/refusal-remedy.ts"

const PR = "PR1791"

function authoredGitlink(pr = PR): { code: string; message: string } {
  return {
    code: "authored-gitlink",
    message:
      `yrd: PR '${pr}' changes generated-only gitlinks [km, ag]; authored root branches use ` +
      `'yrd pr submit <branch>', then 'yrd pr recut ${pr} --preflight --queue' and run its exact next command ` +
      "on that same PR; no composition manifest or manual triage is needed",
  }
}

describe("refusal remedy classification — self-applicable vs judgment-required", () => {
  it("classifies an authored-gitlink carrier as the deterministic resubmit + recut drill", () => {
    const remedy = classifyRefusalRemedy(authoredGitlink(), { branch: "task/22474", delivery: "submitted" })

    expect(remedy.kind).toBe("self-applicable")
    if (remedy.kind !== "self-applicable") return
    expect(remedy.steps).toEqual([
      { verb: "submit", branch: "task/22474" },
      { verb: "recut", pr: PR, preflight: true, queue: true, force: false },
    ])
    // The applied command is logged VERBATIM, with the branch placeholder the
    // printed remedy carries resolved to the PR's real branch.
    expect(remedy.steps.map(formatRemedyCommand)).toEqual([
      "yrd pr submit task/22474",
      `yrd pr recut ${PR} --preflight --queue`,
    ])
  })

  it("keeps a draft carrier on the create path the printed remedy names for it", () => {
    const remedy = classifyRefusalRemedy(authoredGitlink(), { branch: "task/22474", delivery: "pushed" })

    expect(remedy.kind).toBe("self-applicable")
    if (remedy.kind !== "self-applicable") return
    expect(remedy.steps[0]).toEqual({ verb: "create", branch: "task/22474" })
    expect(remedy.steps.map(formatRemedyCommand)[0]).toBe("yrd pr create task/22474")
  })

  it("applies the same drill to a composition-invalid carrier, which prints the identical remedy", () => {
    const remedy = classifyRefusalRemedy(
      {
        code: "composition-invalid",
        message:
          `yrd: PR '${PR}' composition manifest names no source; authored root branches use ` +
          `'yrd pr submit <branch>', then 'yrd pr recut ${PR} --preflight --queue' and run its exact next command`,
      },
      { branch: "task/22474", delivery: "submitted" },
    )

    expect(remedy.kind).toBe("self-applicable")
  })

  it("refuses to mechanise a divergent-gitlink compose, whose recipe can conflict", () => {
    const remedy = classifyRefusalRemedy(
      {
        code: "recut-gitlink-conflict",
        message:
          `yrd: PR '${PR}' target root '${"c".repeat(40)}' pins submodule 'km' to '${"a".repeat(40)}' but the ` +
          `replayed authored root '${"d".repeat(40)}' pins it to '${"b".repeat(40)}'`,
      },
      { branch: "task/22474", delivery: "submitted" },
    )

    expect(remedy.kind).toBe("judgment")
    if (remedy.kind !== "judgment") return
    expect(remedy.reason).toContain("judgment")
  })

  it("leaves a recut certificate refusal to judgment — it prints no command to run", () => {
    const remedy = classifyRefusalRemedy(
      { code: "recut-certificate", message: `yrd: PR '${PR}' recut tree certificate does not match revision 3` },
      { branch: "task/22474", delivery: "submitted" },
    )

    expect(remedy.kind).toBe("judgment")
  })

  it("leaves a payload certificate refusal to judgment", () => {
    const remedy = classifyRefusalRemedy(
      {
        code: "payload-certificate",
        message: `yrd: PR '${PR}' declared payload range-diff does not match the recorded source rewrite`,
      },
      { branch: "task/22474", delivery: "submitted" },
    )

    expect(remedy.kind).toBe("judgment")
  })

  it("leaves an environment refusal to judgment — it names no PR-scoped command", () => {
    const remedy = classifyRefusalRemedy(
      { code: "queue-base-unresolved", message: "yrd: resident auto-recut could not resolve queue base 'main'" },
      { branch: "task/22474", delivery: "submitted" },
    )

    expect(remedy.kind).toBe("judgment")
  })

  it("refuses to recut a terminal PR — the printed remedy drops the step the state would refuse", () => {
    const remedy = classifyRefusalRemedy(authoredGitlink(), { branch: "task/22474", delivery: "integrated" })

    // With the recut step gone the drill is incomplete: resubmitting alone would
    // not compose the carrier, so this is not a loss-free mechanical remedy.
    expect(remedy.kind).toBe("judgment")
  })

  it("never mechanises a remedy that names a non-yrd command", () => {
    const remedy = classifyRefusalRemedy(
      {
        code: "source-lineage",
        message: `yrd: PR '${PR}' source lineage broke; run 'git -C km fetch --all --prune' then resubmit`,
      },
      { branch: "task/22474", delivery: "submitted" },
    )

    expect(remedy.kind).toBe("judgment")
  })

  it("never mechanises a remedy that names an unknown yrd verb", () => {
    const remedy = classifyRefusalRemedy(
      { code: "queue-drift", message: `yrd: PR '${PR}' is stale; run 'yrd queue deinit main' first` },
      { branch: "task/22474", delivery: "submitted" },
    )

    expect(remedy.kind).toBe("judgment")
  })
})
