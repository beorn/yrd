/**
 * @failure Deployment materialization exists only as an in-process store, so
 *          callers can bypass the Journal or cannot reach the lifecycle at all.
 * @level l3 — Journal-backed plugin over an in-memory Journal
 * @consumer Hab generation activation through Yrd
 */
import { createMemoryJournal, createYrd, createYrdDef, pipe } from "@yrd/core"
import { withJobs } from "@yrd/job"
import { createLogger } from "loggily"
import { describe, expect, it, vi } from "vitest"

import { createDeploymentJobDefs, deploymentJobKey, withDeployments, type GitDeploymentStore } from "../src/index.ts"

const INPUT = {
  deploymentId: "D1",
  generation: "G1",
  sha: "a".repeat(40),
  pin: "tip" as const,
}

function deploymentStore(): GitDeploymentStore {
  return {
    materialize: vi.fn(),
    reap: vi.fn(),
    release: vi.fn(),
  }
}

async function app() {
  const jobs = createDeploymentJobDefs(deploymentStore())
  return createYrd(pipe(createYrdDef(), withJobs({ definitions: jobs }), withDeployments({ jobs })), {
    inject: {
      journal: createMemoryJournal(),
      clock: () => "2026-08-06T12:00:00.000Z",
      log: createLogger("test", [{ level: "silent" }]),
    },
  })
}

describe("withDeployments", () => {
  it("admits materialization as one keyed Journal Job", async () => {
    await using yrd = await app()

    const requested = await yrd.deployments.materialize(INPUT)
    const ids = yrd.jobs.requested(requested)

    expect(ids).toHaveLength(1)
    expect(yrd.jobs.get(ids[0]!)).toMatchObject({
      definition: "deployment.materialize",
      key: deploymentJobKey("materialize", INPUT.deploymentId),
      input: INPUT,
      status: "queued",
    })
  })
})
