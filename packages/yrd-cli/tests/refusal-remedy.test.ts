/**
 * @failure Every refusal remedy is treated as human work, so a refusal whose printed remedy is fully deterministic still waits for an operator to type it — and a refusal that genuinely needs judgment could be executed mechanically.
 * @level l1
 * @consumer @yrd/cli habitant runner
 */
import { describe, expect, it } from "vitest"
import { classifyRefusalRemedy } from "../src/refusal-remedy.ts"

const Change = "PR1791"

function authoredGitlink(pr = Change): { code: string; message: string } {
  return {
    code: "authored-gitlink",
    message: `yrd: change '${pr}' changes generated-only gitlinks [km, ag]`,
  }
}

describe("refusal remedy classification — self-applicable vs judgment-required", () => {
  it("leaves authored-gitlink pin work to the author instead of auto-redelivering", () => {
    const remedy = classifyRefusalRemedy(authoredGitlink(), { branch: "task/22474", delivery: "submitted" })

    expect(remedy.kind).toBe("judgment")
    if (remedy.kind !== "judgment") return
    // The pin-first prose resolution is deliberately not a bare mechanical
    // command: the fast-forward must happen before any resubmit, so the
    // classifier refuses to auto-apply it.
    expect(remedy.reason).toContain("not a mechanical Yrd redelivery command")
  })

  it("does not resurrect the draft create path for a gitlink-bump remedy", () => {
    const remedy = classifyRefusalRemedy(authoredGitlink(), { branch: "task/22474", delivery: "pushed" })

    expect(remedy.kind).toBe("judgment")
  })

  it("does not mechanise a composition-invalid carrier lacking a mechanical remedy", () => {
    const remedy = classifyRefusalRemedy(
      { code: "composition-invalid", message: `yrd: change '${Change}' composition manifest names no source` },
      { branch: "task/22474", delivery: "submitted" },
    )

    expect(remedy.kind).toBe("judgment")
  })

  it("leaves a recut certificate refusal to judgment — it prints no command to run", () => {
    const remedy = classifyRefusalRemedy(
      {
        code: "recut-certificate",
        message: `yrd: change '${Change}' recut tree certificate does not match revision 3`,
      },
      { branch: "task/22474", delivery: "submitted" },
    )

    expect(remedy.kind).toBe("judgment")
  })

  it("leaves a payload certificate refusal to judgment", () => {
    const remedy = classifyRefusalRemedy(
      {
        code: "payload-certificate",
        message: `yrd: change '${Change}' declared payload range-diff does not match the recorded source rewrite`,
      },
      { branch: "task/22474", delivery: "submitted" },
    )

    expect(remedy.kind).toBe("judgment")
  })

  it("leaves an environment refusal to judgment — it names no PR-scoped command", () => {
    const remedy = classifyRefusalRemedy(
      { code: "queue-base-unresolved", message: "yrd: habitant auto-recut could not resolve queue base 'main'" },
      { branch: "task/22474", delivery: "submitted" },
    )

    expect(remedy.kind).toBe("judgment")
  })

  it("refuses to redeliver a terminal change mechanically", () => {
    const remedy = classifyRefusalRemedy(
      {
        code: "composition-invalid",
        message:
          "yrd: change 'PR1791' needs a certified refresh; " +
          "tracked changes re-merge implicitly; fallback: 'yrd pr submit <branch>'",
      },
      { branch: "task/22474", delivery: "integrated" },
    )

    expect(remedy.kind).toBe("judgment")
    if (remedy.kind !== "judgment") return
    expect(remedy.reason).toContain("cannot be redelivered mechanically")
  })

  it("self-applies the implicit re-merge drill for a live submitted change", () => {
    const remedy = classifyRefusalRemedy(
      {
        code: "composition-invalid",
        message:
          "yrd: change 'PR1791' needs a certified refresh; " +
          "tracked changes re-merge implicitly; fallback: 'yrd pr submit <branch>'",
      },
      { branch: "task/22474", delivery: "submitted" },
    )

    expect(remedy).toEqual({ kind: "self-applicable", steps: [{ verb: "submit", branch: "task/22474" }] })
  })

  it("never mechanises a remedy that names a non-yrd command", () => {
    const remedy = classifyRefusalRemedy(
      {
        code: "source-lineage",
        message: `yrd: change '${Change}' source lineage broke; run 'git -C km fetch --all --prune' then resubmit`,
      },
      { branch: "task/22474", delivery: "submitted" },
    )

    expect(remedy.kind).toBe("judgment")
  })

  it("never mechanises a remedy that names an unknown yrd verb", () => {
    const remedy = classifyRefusalRemedy(
      { code: "queue-drift", message: `yrd: change '${Change}' is stale; run 'yrd queue deinit main' first` },
      { branch: "task/22474", delivery: "submitted" },
    )

    expect(remedy.kind).toBe("judgment")
  })

  it("keeps the R-b escape-hatch recut drill parseable and self-applicable for a live change", () => {
    // The CLI verb is retired, but the bay's public recut command remains the
    // sanctioned drill for untracked changes, wedge repair, and pre-TD
    // adoption; a refusal that prints it still self-applies.
    const remedy = classifyRefusalRemedy(
      {
        code: "composition-invalid",
        message: `yrd: change '${Change}' needs a certified refresh; run 'yrd pr recut ${Change} --preflight --queue --apply'`,
      },
      { branch: "task/22474", delivery: "submitted" },
    )

    expect(remedy).toEqual({
      kind: "self-applicable",
      steps: [{ verb: "recut", pr: Change, preflight: true, apply: true, queue: true, force: false }],
    })
  })

  it("refuses the escape-hatch recut drill for a terminal change", () => {
    const remedy = classifyRefusalRemedy(
      {
        code: "composition-invalid",
        message: `yrd: change '${Change}' needs a certified refresh; run 'yrd pr recut ${Change} --preflight --queue --apply'`,
      },
      { branch: "task/22474", delivery: "integrated" },
    )

    expect(remedy.kind).toBe("judgment")
  })
})
