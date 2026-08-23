/**
 * @failure Every refusal remedy is treated as human work, so a refusal whose printed remedy is fully deterministic still waits for an operator to type it — and a refusal that genuinely needs judgment could be executed mechanically.
 * @level l1
 * @consumer @yrd/cli resident runner
 */
import { describe, expect, it } from "vitest"
import { classifyRefusalRemedy } from "../src/refusal-remedy.ts"

const Change = "PR1791"

function authoredGitlink(pr = Change): { code: string; message: string } {
  return {
    code: "authored-gitlink",
    message: `yrd: PR '${pr}' changes generated-only gitlinks [km, ag]`,
  }
}

describe("refusal remedy classification — self-applicable vs judgment-required", () => {
  it("leaves authored-gitlink pin work to the author instead of auto-recutting", () => {
    const remedy = classifyRefusalRemedy(authoredGitlink(), { branch: "task/22474", delivery: "submitted" })

    expect(remedy.kind).toBe("judgment")
    if (remedy.kind !== "judgment") return
    // A submit never re-enters the merge queue by itself (no recut --queue
    // step): the classifier correctly refuses to auto-apply it, same as
    // before, just for a printed-remedy reason now instead of an unparseable one.
    expect(remedy.reason).toContain("never re-enters the change into the merge queue")
  })

  it("does not resurrect the draft create path for a gitlink-bump remedy", () => {
    const remedy = classifyRefusalRemedy(authoredGitlink(), { branch: "task/22474", delivery: "pushed" })

    expect(remedy.kind).toBe("judgment")
  })

  it("does not mechanise a composition-invalid carrier lacking a mechanical remedy", () => {
    const remedy = classifyRefusalRemedy(
      { code: "composition-invalid", message: `yrd: PR '${Change}' composition manifest names no source` },
      { branch: "task/22474", delivery: "submitted" },
    )

    expect(remedy.kind).toBe("judgment")
  })

  it("refuses to mechanise a divergent-gitlink compose, whose recipe can conflict", () => {
    const remedy = classifyRefusalRemedy(
      {
        code: "recut-gitlink-conflict",
        message:
          `yrd: PR '${Change}' target root '${"c".repeat(40)}' pins submodule 'km' to '${"a".repeat(40)}' but the ` +
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
      { code: "recut-certificate", message: `yrd: PR '${Change}' recut tree certificate does not match revision 3` },
      { branch: "task/22474", delivery: "submitted" },
    )

    expect(remedy.kind).toBe("judgment")
  })

  it("leaves a payload certificate refusal to judgment", () => {
    const remedy = classifyRefusalRemedy(
      {
        code: "payload-certificate",
        message: `yrd: PR '${Change}' declared payload range-diff does not match the recorded source rewrite`,
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
        message: `yrd: PR '${Change}' source lineage broke; run 'git -C km fetch --all --prune' then resubmit`,
      },
      { branch: "task/22474", delivery: "submitted" },
    )

    expect(remedy.kind).toBe("judgment")
  })

  it("never mechanises a remedy that names an unknown yrd verb", () => {
    const remedy = classifyRefusalRemedy(
      { code: "queue-drift", message: `yrd: PR '${Change}' is stale; run 'yrd queue deinit main' first` },
      { branch: "task/22474", delivery: "submitted" },
    )

    expect(remedy.kind).toBe("judgment")
  })
})
