/**
 * @failure A one-shot `queue run --once` started composing beside a live
 *          resident runner instead of refusing: admission had no
 *          exclusivity of its own (only settlement does,
 *          `habitantOwnsSettlementDrain`, host.ts). Measured 2026-08-30
 *          (@cto, PR2744): `@ci` ran a one-shot leg beside the resident
 *          runner; the second driver sat at zero CPU inside Vitest
 *          collection next to another leg's whole-suite run, and the
 *          CPU-work lease killed it — a false refusal that cost a real
 *          change.
 * @level l2
 * @consumer @yrd/cli queue run --once (admission exclusivity)
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createExclusive } from "@yrd/persistence"
import { failureFact } from "@yrd/core"
import { safeRemoveSync } from "removely"
import { refuseOneShotQueueRunUnderResidentLease } from "../src/run.ts"

describe("refuseOneShotQueueRunUnderResidentLease — the guard `queue run --once` calls before gate()/compose", () => {
  it("refuses, naming the holder and the cure, when the resident runner's real lease is held", async () => {
    const repo = mkdtempSync(join(tmpdir(), "yrd-once-refuses-"))
    execFileSync("git", ["init", "-q", "-b", "main", repo])
    // Same convention `queue list --check`'s own held-lease test uses
    // (cli.test.ts): the state dir a non-worktree repo's git-common-dir
    // implies, locked at the exact path `habitantRunnerLeaseObservation`
    // probes.
    const stateDir = join(repo, ".git", "yrd")
    const driver = { queueId: `${repo}#main`, epoch: "11111111-1111-4111-8111-111111111111" }

    const lockAcquired = Promise.withResolvers<void>()
    const lockRelease = Promise.withResolvers<void>()
    const lock = createExclusive(join(stateDir, "resident-runner"), { timeoutMs: 0 }).run(
      async () => {
        lockAcquired.resolve()
        await lockRelease.promise
      },
      { holder: `queue=${driver.queueId} epoch=${driver.epoch}` },
    )
    try {
      await lockAcquired.promise

      let caught: unknown
      try {
        await refuseOneShotQueueRunUnderResidentLease(repo)
      } catch (error) {
        caught = error
      }

      const fact = failureFact(caught)
      expect(fact, `expected a typed refusal, got ${String(caught)}`).toMatchObject({
        kind: "refusal",
        code: "queue-run-resident-owns-admission",
      })
      // The message is the only thing an operator reads: it must name the
      // EXACT holder (never just "a habitant") and the cure, or a refusal at
      // 2am sends them hunting instead of typing the fix.
      expect(fact?.message).toContain(`queue=${driver.queueId} epoch=${driver.epoch}`)
      expect(fact?.message).toContain("yrd pr submit <branch>")
      expect(fact?.message).toContain("hab --hab-dir <root> restart yrd-runner")
    } finally {
      lockRelease.resolve()
      await lock
      safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
    }
  })

  it("is a no-op when no resident lease is held — the everyday `queue run --once` case", async () => {
    const repo = mkdtempSync(join(tmpdir(), "yrd-once-refuses-free-"))
    execFileSync("git", ["init", "-q", "-b", "main", repo])
    try {
      await expect(refuseOneShotQueueRunUnderResidentLease(repo)).resolves.toBeUndefined()
    } finally {
      safeRemoveSync(repo, { within: tmpdir(), allowMissing: true })
    }
  })
})
