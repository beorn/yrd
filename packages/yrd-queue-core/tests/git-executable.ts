/** Test-only executable selection; fixture writes and ref oracles stay on native Git. */
import { accessSync, appendFileSync, constants } from "node:fs"
import { isAbsolute } from "node:path"
import { createProcess, type Process } from "@yrd/process"
import { afterEach, expect } from "vitest"
import { gitEnvironment, gitIn } from "../src/git.ts"
import type { Git } from "../src/index.ts"

const executable = process.env.YRD_TEST_GIT_EXECUTABLE
const trace = process.env.YRD_TEST_GIT_TRACE
const runners: Process[] = []

// A missing candidate is failed setup, not evidence of behavioral divergence.
if (executable !== undefined) {
  if (!isAbsolute(executable)) throw new Error("YRD_TEST_GIT_EXECUTABLE requires an absolute executable path")
  accessSync(executable, constants.X_OK)
}
if (trace !== undefined && !isAbsolute(trace)) throw new Error("YRD_TEST_GIT_TRACE requires an absolute path")

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.close()
})

export function gitUnderTest(cwd: string): Git {
  if (executable === undefined && trace === undefined) return gitIn(cwd)
  const runner = createProcess({ cwd, env: gitEnvironment(process.env) })
  runners.push(runner)
  return gitIn(cwd, {
    ...runner,
    async run(request) {
      const result = await runner.run({ ...request, argv: [executable ?? "git", ...request.argv.slice(1)] })
      if (trace !== undefined) {
        appendFileSync(
          trace,
          `${JSON.stringify({
            case: expect.getState().currentTestName,
            cwd,
            args: request.argv.slice(1),
            stdin: request.stdin,
            result,
          })}\n`,
        )
      }
      return result
    },
  })
}
