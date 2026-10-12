/**
 * @failure A GitHub 5xx on yrd publish was retried as a silent class, a 4xx
 *          / unrecognized refusal was retried the same way (27995, @cto 12ae0948),
 *          or a queue publication bypassed the one funnel that owns that retry
 *          and its landed probe (28805, @cto one owner per site).
 * @level   l1
 * @consumer yrd queue runner and submit pin publish
 * @testonly none
 */

import { describe, expect, test } from "vitest"
import { PublicationRejected } from "gitomic"
import {
  isTransientPushHold,
  matchTransientPush5xx,
  publishWithTransientRetry,
  TRANSIENT_PUSH_HOLD,
  transientPushRetry,
} from "../src/transient-push.ts"

describe("transient GitHub 5xx on a git push", () => {
  test.each([
    [
      "git's returned-error 500",
      "fatal: unable to access 'https://github.com/beorn/hh.git/': The requested URL returned error: 500",
    ],
    [
      "git's returned-error 502",
      "fatal: unable to access 'https://github.com/beorn/x/': The requested URL returned error: 502",
    ],
    ["Internal Server Error", "remote: Internal Server Error"],
    [
      "specimen request id beside Internal Server Error",
      ["remote: Internal Server Error", "remote: Request ID: 8B8E:93E9C:1C9E26:269104:6AC672BE"].join("\n"),
    ],
  ])("%s", (_why, text) => {
    expect(matchTransientPush5xx(text)?.line.length).toBeGreaterThan(0)
  })

  test("keeps the 5xx shape when it sits at the end of a long PublicationRejected line", () => {
    const prefix = "Publication to refs/yrd/main/changes/task/x was rejected: ".padEnd(280, "x")
    const text = `${prefix} remote: Internal Server Error`
    expect(matchTransientPush5xx(text)?.line.startsWith("Internal Server Error")).toBe(true)
  })

  test("captures the GitHub Request ID from the same stderr", () => {
    const text = [
      "error: RPC failed; HTTP 500 curl 22 The requested URL returned error: 500",
      "remote: Request ID: E702:98420",
    ].join("\n")
    expect(matchTransientPush5xx(text)).toMatchObject({
      line: expect.stringContaining("returned error: 500"),
      requestId: "E702:98420",
    })
  })
})

describe("not a transient 5xx — stay fail-loud, no retry", () => {
  test.each([
    ["4xx 403", "fatal: unable to access 'https://github.com/beorn/hh.git/': The requested URL returned error: 403"],
    ["4xx 401", "The requested URL returned error: 401"],
    ["4xx 404", "The requested URL returned error: 404"],
    ["unrecognized hook refusal", "remote: pre-receive hook declined"],
    ["bare HTTP 500 without git's shapes", "error: RPC failed; HTTP 500 curl 22"],
    ["connection reset", "fatal: the remote end hung up unexpectedly: Connection reset by peer"],
    ["empty", ""],
  ])("%s", (_why, text) => {
    expect(matchTransientPush5xx(text)).toBeUndefined()
  })
})

describe("auto-probe only holds this code wrote", () => {
  test("keys on the hold phrase, not on quoted 5xx text", () => {
    expect(isTransientPushHold(`${TRANSIENT_PUSH_HOLD} on merge publication`)).toBe(true)
    expect(isTransientPushHold("remote: Internal Server Error")).toBe(false)
    expect(isTransientPushHold("The requested URL returned error: 500")).toBe(false)
    expect(isTransientPushHold(undefined)).toBe(false)
  })
})

const GITHUB_5XX = [
  "remote: Internal Server Error",
  "fatal: unable to access 'https://github.com/beorn/hh.git/': The requested URL returned error: 500",
  "remote: Request ID: 8B8E:93E9C:1C9E26:269104:6AC672BE",
].join("\n")

const FUNNEL_UPDATE = { ref: "refs/yrd/main/changes/task/x", expect: "0".repeat(40), oid: "a".repeat(40) } as const

/** A 5xx as gitomic's shell backend spells it: the remote refused after the push. */
function transientFivexx(): PublicationRejected {
  return new PublicationRejected([FUNNEL_UPDATE], [GITHUB_5XX], GITHUB_5XX)
}

function stubBackoff(): () => void {
  const sleep = transientPushRetry.sleep
  transientPushRetry.sleep = async () => {}
  return () => {
    transientPushRetry.sleep = sleep
  }
}

function silenceStderr(): () => void {
  const write = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
    if (typeof encoding === "function") encoding()
    if (typeof callback === "function") callback()
    return true
  }) as typeof process.stderr.write
  return () => {
    process.stderr.write = write
  }
}

/** @failure 28805, @cto: a 500 can arrive AFTER GitHub applied the push, so the
 * funnel must consult the landed probe and return the staged write instead of
 * re-running the publication — a blind re-run appends a second event or fails
 * the lease. This is the funnel every queue publication shares.
 * @level l1 @consumer every queue publication site
 */
describe("one funnel for a queue publication (28805)", () => {
  test("returns the staged write when a 500 arrived after it landed, never re-running work", async () => {
    const restore = stubBackoff()
    const unsilence = silenceStderr()
    try {
      const staged = { head: "a".repeat(40) }
      let runs = 0
      const probed: (typeof staged)[] = []
      const result = await publishWithTransientRetry<typeof staged>(
        async (prepared) => {
          runs++
          prepared(staged)
          throw transientFivexx()
        },
        {
          repository: "origin",
          ref: FUNNEL_UPDATE.ref,
          landed: async (candidate) => {
            probed.push(candidate)
            return candidate.head === staged.head ? candidate : undefined
          },
        },
      )
      expect(result).toBe(staged)
      expect(runs).toBe(1)
      expect(probed).toEqual([staged])
    } finally {
      unsilence()
      restore()
    }
  })

  /** @failure 28805 addition 2, @cto (28793 round 2): a probe that itself throws is
   * an unknown, not a "did not land". The funnel settles on the ORIGINAL 5xx, records
   * the probe's error in the attempt note, and never re-runs work.
   * @level l1 @consumer every queue publication site
   */
  test("settles on the original 5xx and never re-runs work when the landed probe throws", async () => {
    const restore = stubBackoff()
    const unsilence = silenceStderr()
    try {
      const staged = { head: "a".repeat(40) }
      const original = transientFivexx()
      let runs = 0
      const notes: (string | undefined)[] = []
      await expect(
        publishWithTransientRetry<typeof staged>(
          async (prepared) => {
            runs++
            prepared(staged)
            throw original
          },
          {
            repository: "origin",
            ref: FUNNEL_UPDATE.ref,
            note: (_attempt, probeError) => notes.push(probeError),
            landed: async () => {
              throw new Error("fatal: Connection reset by peer")
            },
          },
        ),
      ).rejects.toBe(original)
      expect(runs).toBe(1)
      expect(notes).toHaveLength(1)
      expect(notes[0]).toContain("Connection reset by peer")
    } finally {
      unsilence()
      restore()
    }
  })

  /** @failure 28805: exhaustion is the CALLER's decision. The funnel retries a
   * persistent 5xx its bounded number of times and then hands the ORIGINAL 5xx
   * back, so a runner can HOLD and a CLI can fail loud (it never swallows it).
   * @level l1 @consumer every queue publication site
   */
  test("exhausts a persistent 5xx and returns the original error for the caller to map", async () => {
    const restore = stubBackoff()
    const unsilence = silenceStderr()
    try {
      const staged = { head: "a".repeat(40) }
      const original = transientFivexx()
      let runs = 0
      await expect(
        publishWithTransientRetry<typeof staged>(
          async (prepared) => {
            runs++
            prepared(staged)
            throw original
          },
          { repository: "origin", ref: FUNNEL_UPDATE.ref },
        ),
      ).rejects.toBe(original)
      expect(runs).toBe(transientPushRetry.attempts)
    } finally {
      unsilence()
      restore()
    }
  })

  /** @failure 27995, @cto 12ae0948: anything but the 5xx shapes stays fail-loud with
   * no retry, on the very first attempt, through the funnel too.
   * @level l1 @consumer every queue publication site
   */
  test("propagates a 4xx refusal on the first attempt, with no landed probe", async () => {
    const restore = stubBackoff()
    const unsilence = silenceStderr()
    try {
      const staged = { head: "a".repeat(40) }
      const refusal = new Error("fatal: The requested URL returned error: 403")
      let runs = 0
      let probed = 0
      await expect(
        publishWithTransientRetry<typeof staged>(
          async (prepared) => {
            runs++
            prepared(staged)
            throw refusal
          },
          {
            repository: "origin",
            ref: FUNNEL_UPDATE.ref,
            landed: async () => {
              probed++
              return staged
            },
          },
        ),
      ).rejects.toBe(refusal)
      expect(runs).toBe(1)
      expect(probed).toBe(0)
    } finally {
      unsilence()
      restore()
    }
  })
})
