/**
 * `yrd check <name>` — run one of the queue's checks here, now
 * ([plan](../../../../pm/@i/10-yrd/plan.md) § The final design, Commands).
 *
 * The named check is the TARGET's declaration of it, run in the tree the
 * command stands in; the exit is the result (0 pass, 1 fail, 2 stuck), and a
 * name the target does not declare is refused loudly. The fake check exits as
 * the plan says only where the change's own file is, so a bay with one commit
 * is where the result shows.
 *
 * The incumbent's `yrd check` runs against `--repo`, not the tree it stands
 * in, so only the pass case is measured on both cores.
 */

import { afterEach, describe, expect, it } from "vitest"
import { boundaryRepository, checkAttempts, measuringNewCore, removeScratchRoots, runYrdIn, submitOneCommit } from "./fixture.ts"

afterEach(removeScratchRoots)

describe("yrd check <name>", () => {
  it("runs the target's check in this tree and exits 0 on a pass", async () => {
    const { repo, checkLog } = await boundaryRepository({ exit: 0 })
    const { bayPath } = await submitOneCommit(repo, "pass")
    const before = await checkAttempts(checkLog)

    const run = await runYrdIn(repo, bayPath, "check", "check")

    expect(run.exitCode, run.report).toBe(0)
    expect(await checkAttempts(checkLog), run.report).toBe(before + 1)
  })

  it.skipIf(!measuringNewCore())("exits 1 on a fail, and says which check and where its log is", async () => {
    const { repo } = await boundaryRepository({ exit: 1 })
    const { bayPath } = await submitOneCommit(repo, "fail")

    const run = await runYrdIn(repo, bayPath, "check", "check", "--json")

    expect(run.exitCode, run.report).toBe(1)
    const answer = JSON.parse(run.stdout) as { command: string; checks: readonly { name: string; result: string; log: string }[] }
    expect(answer.command, run.report).toBe("check")
    expect(answer.checks.map((check) => [check.name, check.result]), run.report).toEqual([["check", "fail"]])
    expect(answer.checks[0]?.log ?? "", run.report).not.toBe("")
  })

  it.skipIf(!measuringNewCore())("exits 2 when the check itself cannot judge", async () => {
    const { repo } = await boundaryRepository({ exit: 2 })
    const { bayPath } = await submitOneCommit(repo, "stuck")

    const run = await runYrdIn(repo, bayPath, "check", "check")

    expect(run.exitCode, run.report).toBe(2)
  })

  it.skipIf(!measuringNewCore())("refuses a name the target does not declare, and names what it does", async () => {
    const { repo } = await boundaryRepository({ exit: 0 })
    const { bayPath } = await submitOneCommit(repo, "unknown")

    const run = await runYrdIn(repo, bayPath, "check", "nothing-declared")

    expect(run.exitCode, run.report).not.toBe(0)
    expect(`${run.stdout}\n${run.stderr}`, run.report).toContain("nothing-declared")
    expect(`${run.stdout}\n${run.stderr}`, run.report).toContain("declares")
  })
})
