import { describe, expect, it } from "vitest"
import {
  compareTypecheckDiagnostics,
  parseTypecheckDiagnostics,
  type TypecheckBaselineBucket,
  type TypecheckDiagnostic,
} from "../../../scripts/standalone-typecheck.ts"

const baseline = [
  {
    file: "packages/example.test.ts",
    code: 2305,
    count: 1,
    reason: "Known fixture-only diagnostic.",
  },
] satisfies readonly TypecheckBaselineBucket[]

function diagnostic(file: string, code: number): TypecheckDiagnostic {
  return { file, code, line: 1, column: 2, message: "fixture diagnostic" }
}

describe("standalone typecheck baseline", () => {
  it("parses stable file and code buckets from TypeScript output", () => {
    const output = "packages/example.test.ts(3,7): error TS2305: Module has no exported member.\n"
    expect(parseTypecheckDiagnostics(output, "/repo")).toEqual([
      {
        file: "packages/example.test.ts",
        line: 3,
        column: 7,
        code: 2305,
        message: "Module has no exported member.",
      },
    ])
  })

  it("fails closed when a known bucket grows or an unknown bucket appears", () => {
    const result = compareTypecheckDiagnostics(
      [
        diagnostic("packages/example.test.ts", 2305),
        diagnostic("packages/example.test.ts", 2305),
        diagnostic("packages/new.test.ts", 7006),
      ],
      baseline,
    )
    expect(result.knownDiagnostics).toHaveLength(1)
    expect(result.newDiagnostics.map(({ file, code }) => [file, code])).toEqual([
      ["packages/example.test.ts", 2305],
      ["packages/new.test.ts", 7006],
    ])
  })

  it("allows baseline diagnostics to be removed without weakening the guard", () => {
    const result = compareTypecheckDiagnostics([], baseline)
    expect(result.newDiagnostics).toEqual([])
    expect(result.fixedBaselineCount).toBe(1)
  })
})
