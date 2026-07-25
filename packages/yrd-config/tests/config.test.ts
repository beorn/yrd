/**
 * @failure Flow selection shadows submissions or silently changes durable workflow identity.
 * @level l1
 * @consumer @yrd/config authors and the Yrd runtime
 */
import { describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  defineConfig,
  diagnoseFlowPin,
  flowPin,
  loadConfigModule,
  selectFlow,
  withActionStep,
  withCheckStep,
  withFlow,
  withMergeStep,
  yrd,
} from "../src/index.ts"

const check = withCheckStep("check", { run: "bun test" })
const merge = withMergeStep({ run: "git merge" })

describe("flow configuration", () => {
  it("selects exactly one FlowDef from immutable Submission facts", () => {
    const config = defineConfig(
      withFlow({
        name: "docs",
        rev: "3",
        on: ({ branch }) => branch.startsWith("docs/"),
        steps: [check, merge],
      }),
      yrd.flow({
        name: "product",
        rev: "7",
        on: ({ branch }) => !branch.startsWith("docs/"),
        steps: [yrd.check("check", { run: "bun test" }), yrd.action("pack"), yrd.merge()],
      }),
    )

    const selected = selectFlow(config, {
      base: "main",
      branch: "docs/target-model",
      head: "a".repeat(40),
      bay: "B4",
      issue: "@yrd/core/21085-target-model",
    })

    expect(selected.flow.name).toBe("docs")
    expect(selected.pin).toEqual({
      name: "docs",
      rev: "3",
      fingerprint: flowPin(selected.flow).fingerprint,
    })
  })

  it("refuses zero and ambiguous matches loudly instead of using first-match-wins", () => {
    const neither = defineConfig(
      withFlow({ name: "docs", rev: "1", on: () => false, steps: [check, merge] }),
      withFlow({ name: "code", rev: "1", on: () => false, steps: [check, merge] }),
    )
    expect(() => selectFlow(neither, { base: "main", branch: "topic", head: "b".repeat(40) })).toThrow(
      "matched no flows; available flows: code, docs",
    )

    const both = defineConfig(
      withFlow({ name: "docs", rev: "1", on: () => true, steps: [check, merge] }),
      withFlow({ name: "code", rev: "1", on: () => true, steps: [check, merge] }),
    )
    expect(() => selectFlow(both, { base: "main", branch: "topic", head: "b".repeat(40) })).toThrow(
      "matched multiple flows: code, docs",
    )
  })

  it("fingerprints structural step identity, order, kinds, and runner bindings", () => {
    const original = withFlow({
      name: "main",
      rev: "9",
      on: () => true,
      steps: [withCheckStep("check", { run: "bun test", runner: "local" }), merge],
    })
    const executableOnly = withFlow({
      name: "main",
      rev: "9",
      on: () => true,
      steps: [withCheckStep("check", { run: "bun test --changed", runner: "local" }), merge],
    })
    const rebound = withFlow({
      name: "main",
      rev: "9",
      on: () => true,
      steps: [withCheckStep("check", { run: "bun test", runner: "waiting" }), merge],
    })
    const reordered = withFlow({
      name: "main",
      rev: "9",
      on: () => true,
      steps: [withActionStep("announce"), check, merge],
    })

    expect(flowPin(executableOnly).fingerprint).toBe(flowPin(original).fingerprint)
    expect(flowPin(rebound).fingerprint).not.toBe(flowPin(original).fingerprint)
    expect(flowPin(reordered).fingerprint).not.toBe(flowPin(original).fingerprint)
  })

  it("reports unchanged-revision drift loudly and revision drift as a resume refusal", () => {
    const original = withFlow({ name: "main", rev: "2", on: () => true, steps: [check, merge] })
    const structuralDrift = withFlow({
      name: "main",
      rev: "2",
      on: () => true,
      steps: [withCheckStep("check", { runner: "waiting" }), merge],
    })
    const revisionDrift = withFlow({ name: "main", rev: "3", on: () => true, steps: [check, merge] })

    expect(diagnoseFlowPin(flowPin(original), defineConfig(structuralDrift))).toEqual([
      expect.objectContaining({ code: "flow-fingerprint-drift", severity: "warning" }),
    ])
    expect(diagnoseFlowPin(flowPin(original), defineConfig(revisionDrift))).toEqual([
      expect.objectContaining({ code: "flow-revision-drift", severity: "refusal" }),
    ])
  })
})

describe(".yrd.ts module loading", () => {
  it("evaluates the supplied base-authority source rather than reading candidate content", async () => {
    const root = await mkdtemp(join(tmpdir(), "yrd-config-"))
    try {
      const loaded = await loadConfigModule({
        path: join(root, ".yrd.ts"),
        cacheDir: join(root, "cache"),
        source: `
          import { defineConfig, yrd } from "@yrd/config"
          export default defineConfig(yrd.flow({
            name: "base-authority",
            rev: "4",
            on: ({ base }) => base === "main",
            steps: [yrd.check("check"), yrd.merge()],
          }))
        `,
      })
      expect(selectFlow(loaded, { base: "main", branch: "topic", head: "d".repeat(40) }).pin).toMatchObject({
        name: "base-authority",
        rev: "4",
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
