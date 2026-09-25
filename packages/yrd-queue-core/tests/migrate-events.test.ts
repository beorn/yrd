// @failure an incomplete remote or stale rollback bundle is treated as a successful cutover.
// @level l1
// @consumer 25041 one-shot plan, apply and rollback refusal receipts

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  assertAdvertised,
  assertDirectParity,
  classify,
  readbackStatus,
  readPlan,
  requireVerifiedBundle,
  remoteAdvertisement,
  requireMaintenanceStop,
} from "../scripts/migrate-events.ts"

const HEAD = "a".repeat(40)
const OLD = "b".repeat(40)
const NEW = "c".repeat(40)
const old = { ref: `refs/yrd/main/task/example@${HEAD}`, oid: OLD }
const pause = { ref: "refs/yrd/main/pause", oid: OLD }
const head = { ref: "refs/heads/main", oid: HEAD }

describe("25041 migration refuses incomplete evidence", () => {
  /** @failure An ordinary andon pause is mistaken for an intake fence, allowing a live submit to race cutover.
   * @level l1 @consumer all six migration phases
   */
  it("requires a standing maintenance stop and names how to set it", () => {
    const context = "main"
    const set = { kind: "paused", cause: "maintenance", by: "@chief", reason: "lab" }
    expect(() => requireMaintenanceStop(set as Parameters<typeof requireMaintenanceStop>[0], context)).not.toThrow()
    for (const stop of [undefined, { ...set, cause: "operator" }, { ...set, cause: "stuck" }]) {
      expect(() => requireMaintenanceStop(stop as Parameters<typeof requireMaintenanceStop>[0], context)).toThrow(
        "yrd queue pause --queue 'main' --maintenance '<reason>'",
      )
    }
  })
  it("refuses zero remote queue refs, unknown format and a missing plan journal by name", async () => {
    const git = async () => `${HEAD}\trefs/heads/main\n`
    await expect(
      remoteAdvertisement(git as Parameters<typeof remoteAdvertisement>[0], "origin", "main"),
    ).rejects.toThrow(/zero-refs.*refs\/yrd\/main/)
    expect(() => classify("main", [old, pause, { ref: "refs/yrd/main/mystery", oid: OLD }])).toThrow(
      /unknown-format.*mystery/,
    )
    expect(() =>
      readPlan({
        phase: "apply",
        repo: "/tmp",
        remote: "origin",
        queue: "main",
        journal: `/tmp/25041-missing-${process.pid}`,
      }),
    ).toThrow(/missing-journal.*plan.json/)
  })

  it("refuses a changed lease and classifies a mixed readback as divergent", () => {
    const plan = {
      options: { remote: "origin", queue: "main" },
      oldRefs: [old, pause],
      heads: [head],
      target: HEAD,
    } as unknown as Parameters<typeof assertAdvertised>[0]
    expect(() =>
      assertAdvertised(plan, { queue: [{ ...old, oid: NEW }, pause], heads: [head], target: HEAD }, "before push"),
    ).toThrow(/changed-census.*before push/)
    expect(
      readbackStatus(
        [old, pause],
        [{ ref: "refs/yrd/main", oid: NEW }],
        { queue: [old], heads: [head], target: HEAD },
        [head],
      ),
    ).toBe("divergent")
  })

  it("maps only the created commit out of legacy direct rows and refuses another missing direct commit", () => {
    expect(assertDirectParity([HEAD], [], HEAD)).toEqual({ creationCommit: HEAD, directCommits: [] })
    expect(() => assertDirectParity([OLD, HEAD], [], HEAD)).toThrow(/direct-parity.*outside queue creation/)
  })

  it("refuses a modified ops rollback bundle before reading its snapshot or publishing refs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yrd-ops-bundle-"))
    const bundle = join(dir, "old-refs.bundle")
    try {
      writeFileSync(bundle, "modified after the verified plan")
      await expect(
        requireVerifiedBundle(
          join(dir, "old-refs.git"),
          bundle,
          "a".repeat(64),
          [],
          {} as Parameters<typeof requireVerifiedBundle>[4],
        ),
      ).rejects.toThrow(/invalid-bundle.*SHA256 differs from plan/u)
    } finally {
      rmSync(dir, { recursive: true })
    }
  })
})
