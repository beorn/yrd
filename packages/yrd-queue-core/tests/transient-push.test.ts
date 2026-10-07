/**
 * @failure A GitHub 5xx on yrd publish was retried as a silent class, or a 4xx
 *          / unrecognized refusal was retried the same way (27995, @cto 12ae0948).
 * @level   l1
 * @consumer yrd queue runner and submit pin publish
 * @testonly none
 */

import { describe, expect, test } from "vitest"
import { isTransientPushHold, matchTransientPush5xx, TRANSIENT_PUSH_HOLD } from "../src/transient-push.ts"

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
