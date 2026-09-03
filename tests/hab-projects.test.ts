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
        // Exit 2 (the queue is stuck) stays down for its garage; everything the
        // loop ends on purpose — a signal, and a pin that moved under it — is a
        // 0, because hab reads every non-zero exit as a crash and spends a
        // restart budget on it. Whether `on-failure` then has to become
        // `always`, so a moved pin still relaunches, is @cto's to settle
        // (hab.projects.ts says so where the value is).
        // No health probe: the loop's process and journal are its liveness (M7).
        restart: "on-failure",
        permanentExitCodes: [2],
        owner: "@cto",
      },
    })
  })
})
