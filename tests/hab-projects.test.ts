/**
 * @failure Hab queue-runner declarations drift into implicit paths or commands whose argv no longer identifies the repository they operate on.
 * @level l2
 * @consumer Hallohuman Hab composition loading vendor/yrd/hab.projects.ts
 */
import { describe, expect, it } from "vitest"
import hab, { yrdQueueRunnerDeclarations } from "../hab.projects.ts"

describe("Yrd Hab runner declarations", () => {
  it("declares one supervised service whose repository, argv, owner and exit policy are explicit", () => {
    expect(yrdQueueRunnerDeclarations).toEqual([
      { serviceName: "yrd-service", repository: { name: "code", path: "." }, queue: { base: "main" }, owner: "@ci" },
    ])
    expect(hab.services).toEqual({
      "yrd-service": {
        command: "bun tools/yrd-runtime.mjs yrd queue up --interval 120",
        env: { TRIBE_NAME: "@yrd-service", YRD_HABITANT_RSS_CAP_MB: "24576" },
        // The queue relaunches only after an ending the loop chose: 0 for a
        // clean round/gitlink recycle, or 1 for a candidate failure. Exit 2 is
        // stuck, and any signal is an unplanned host-level interruption; both
        // stay down and page @ci instead of repeating an unmeasured fault.
        // No health probe: the loop's process and journal are its liveness (M7).
        restart: "on-codes",
        relaunchExitCodes: [0, 1],
        owner: "@ci",
      },
    })
  })
})
