/**
 * @failure `yrd doctor` misses durable Flow drift and permits unexplained pending work.
 * @level l1
 * @consumer Yrd operators
 */
import { describe, expect, it } from "vitest"
import { defineConfig, flowPin, yrd } from "@yrd/config"
import { diagnoseYrdFlows } from "../src/config-doctor.ts"

describe("Flow config doctor", () => {
  it("attributes unchanged-revision structural drift and revision refusal to every durable owner", () => {
    const original = yrd.flow({ name: "main", rev: "2", on: () => true, steps: [yrd.check("check"), yrd.merge()] })
    const changed = defineConfig(
      yrd.flow({
        name: "main",
        rev: "2",
        on: () => true,
        steps: [yrd.check("check", { runner: "waiting" }), yrd.merge()],
      }),
    )
    expect(
      diagnoseYrdFlows(
        { prs: [{ id: "PR1", flow: flowPin(original) }], runs: [{ id: "R7", flow: flowPin(original) }] },
        changed,
      ),
    ).toEqual([
      expect.objectContaining({ owner: "PR1", code: "flow-fingerprint-drift", severity: "warning" }),
      expect.objectContaining({ owner: "R7", code: "flow-fingerprint-drift", severity: "warning" }),
    ])

    const bumped = defineConfig(
      yrd.flow({ name: "main", rev: "3", on: () => true, steps: [yrd.check("check"), yrd.merge()] }),
    )
    expect(diagnoseYrdFlows({ prs: [], runs: [{ id: "R7", flow: flowPin(original) }] }, bumped)).toEqual([
      expect.objectContaining({ owner: "R7", code: "flow-revision-drift", severity: "refusal" }),
    ])
  })
})
