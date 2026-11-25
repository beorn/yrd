/**
 * @reach node-only <fixture: a silvery module mock carrying no recordAppCrash>
 * @failure  The watch entry tolerates a silvery older than `recordAppCrash`
 *           (hh #35075) so a sibling pin without it still gets silvery's own
 *           crash listeners. The tolerance read the export straight off the
 *           module, so the CI sibling - and any vitest mock that mirrors it -
 *           threw "No recordAppCrash export is defined" instead of taking the
 *           tolerant branch: `yrd watch` could not start at all there.
 * @level    l1 (the module is imported through a mock whose shape is the
 *           assertion; no remote, no process boundary)
 * @consumer a seat running `yrd watch` against an older silvery sibling
 */

import { describe, expect, it, vi } from "vitest"

// Exactly the shape the source-siblings pin gives CI: the module has `run` and nothing else.
vi.mock("silvery/runtime", () => ({ run: vi.fn() }))

const { installWatchCrashRecord } = await import("../src/watch-crash-record.ts")

describe("the watch crash record against a silvery without recordAppCrash", () => {
  it("installs nothing, leaving the crash record to silvery's own listeners", async () => {
    await expect(installWatchCrashRecord()).resolves.toBeUndefined()
  })
})
