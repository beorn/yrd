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
      { serviceName: "yrd-service", repository: { name: "code", path: "." }, queue: { base: "main" }, owner: "@cto" },
    ])
    expect(hab.services).toEqual({
      "yrd-service": {
        command: "bun tools/yrd-runtime.mjs yrd queue up --interval 120",
        env: { TRIBE_NAME: "@yrd-service", YRD_HABITANT_RSS_CAP_MB: "24576" },
        // `restart: "on-failure"` is what makes exit 18 (the pin moved) relaunch
        // on the new pin, while exit 2 (the queue is stuck) stays down for its
        // garage. No health probe: the loop's process and journal are its
        // liveness (M7).
        restart: "on-failure",
        permanentExitCodes: [2],
        owner: "@cto",
      },
    })
  })
})
