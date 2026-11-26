/**
 * @failure #38739 (c), @cto 5d7283e9: a hold was recognised by prose, so rewording a message could turn a
 *          human's stop into an automatic retry — or an automatic retry into a stop that waits for a person.
 * @level l1 (one decision, both kinds, and the near-misses a rewording would produce)
 * @consumer queue operator, submitter and the standing-stuck gate
 * @reach none
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import {
  automaticRetryHold,
  BOUND_KILL_REQUEUE,
  isBoundKillRequeue,
  isTransientPushHold,
  TRANSIENT_PUSH_HOLD,
} from "../src/retry-hold.ts"

describe("automatic retry holds", () => {
  it("names each hold by its own exported constant, and matches it wherever it sits in the reason", () => {
    expect(isBoundKillRequeue(`${BOUND_KILL_REQUEUE} behind the next change`)).toBe(true)
    expect(isBoundKillRequeue(`${BOUND_KILL_REQUEUE}: verify ran past its bound with no usable YRD-CHECK-RESULT`)).toBe(
      true,
    )
    expect(isTransientPushHold(`${TRANSIENT_PUSH_HOLD} on merge publication`)).toBe(true)
    expect(automaticRetryHold(`${BOUND_KILL_REQUEUE} behind the next change`)).toBe("bound-kill-requeue")
    expect(automaticRetryHold(`${TRANSIENT_PUSH_HOLD} on merge publication`)).toBe("transient-push-hold")
  })

  it("never reads prose: a stuck without the exact constant keeps a human's stop", () => {
    // Rewordings of each message, a case change, and an empty or absent reason. None may be auto-retired.
    for (const reason of [
      "requeued after a verdictless bound kill",
      "re-queued once after a verdictless bound kill",
      "verdictless bound kill",
      "transient GitHub 502",
      "transient GitHub errors",
      BOUND_KILL_REQUEUE.toUpperCase(),
      "",
      undefined,
    ]) {
      expect(automaticRetryHold(reason), String(reason)).toBeUndefined()
      expect(isBoundKillRequeue(reason), String(reason)).toBe(false)
      expect(isTransientPushHold(reason), String(reason)).toBe(false)
    }
  })

  it("keeps the two holds apart", () => {
    expect(isTransientPushHold(`${BOUND_KILL_REQUEUE} behind the next change`)).toBe(false)
    expect(isBoundKillRequeue(`${TRANSIENT_PUSH_HOLD} on merge publication`)).toBe(false)
  })
})
