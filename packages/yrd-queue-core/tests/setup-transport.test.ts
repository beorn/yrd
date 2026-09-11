import { describe, expect, test } from "vitest"

import {
  SETUP_UNREACHABLE_CODE,
  SETUP_UNUSABLE_CODE,
  setupStuckCode,
  setupStuckNext,
  transportFaultIn,
} from "../src/setup-transport.ts"

// @i/10-yrd/24486 rows 2 and 3. A 504 from a code host and a lockfile that does
// not match its manifest both stopped the whole queue as `yrd-setup-unusable`,
// so a reader of the record could not tell an outage from a break.
//
// Row 3 is the NEGATIVE CONTROL and it is the half that matters: a classifier
// that is too generous does not fail loudly — it quietly relabels real breaks
// as outages and retries them forever.

describe("what IS an unreachable remote", () => {
  // The measured specimen, verbatim from the 2026-09-11 outage log.
  test("the 504 that cost 19m47s", () => {
    const log = [
      "$ bun install --frozen-lockfile --prefer-offline",
      "error: GET https://api.github.com/repos/beorn/verify-publishable/tarball/ef92031daa - 504",
      "error: verify-publishable@github:beorn/verify-publishable failed to resolve",
    ].join("\n")
    const fault = transportFaultIn(log)
    expect(fault?.signature).toBe("http-5xx")
    expect(fault?.line).toContain("504")
    expect(setupStuckCode(fault)).toBe(SETUP_UNREACHABLE_CODE)
  })

  test.each([
    ["dns", "fatal: unable to access 'https://example.invalid/': Could not resolve host: example.invalid"],
    ["dns", "getaddrinfo EAI_AGAIN registry.npmjs.org"],
    ["dns", "Error: getaddrinfo ENOTFOUND registry.npmjs.org"],
    ["connect", "connect ECONNREFUSED 127.0.0.1:443"],
    ["connect", "ssh: connect to host github.com port 22: Network is unreachable"],
    ["reset", "fatal: the remote end hung up unexpectedly: Connection reset by peer"],
    ["timeout", "Error: connect ETIMEDOUT 140.82.121.3:443"],
    ["timeout", "net/http: TLS handshake timeout"],
    ["http-5xx", "error: GET https://registry.npmjs.org/left-pad - 502"],
    // GIT'S OWN LINE, and the gap that mattered most: git is the likeliest
    // producer of a transport fault during setup, and its wording matches
    // neither the `- <code>` form nor the `HTTP <code>` one (@cto 2026-09-11).
    ["http-5xx", "fatal: unable to access 'https://github.com/beorn/x/': The requested URL returned error: 502"],
    ["http-5xx", "fatal: unable to access 'https://example.invalid/': The requested URL returned error: 503"],
    ["rate-limited", "fatal: unable to access 'https://github.com/beorn/x/': The requested URL returned error: 429"],
    ["http-5xx", "remote: HTTP 503 Service Unavailable"],
    ["rate-limited", "error: GET https://api.github.com/rate_limit - 429"],
    ["rate-limited", "remote: 429 Too Many Requests"],
  ])("%s: %s", (signature, line) => {
    expect(transportFaultIn(line)?.signature).toBe(signature)
  })

  test("it finds the fault anywhere in a long log, and quotes only that line", () => {
    const log = ["$ bun install", "resolving 412 packages", "connect ECONNREFUSED 140.82.121.3:443", "exit 1"].join("\n")
    expect(transportFaultIn(log)).toEqual({ signature: "connect", line: "connect ECONNREFUSED 140.82.121.3:443" })
  })

  test("the evidence line is bounded — a record is not a log", () => {
    const fault = transportFaultIn(`ECONNRESET ${"x".repeat(5000)}`)
    expect(fault?.line.length).toBeLessThanOrEqual(300)
  })
})

describe("row 3, the negative control: what is NOT an unreachable remote", () => {
  // Real breaks. Every one of these must still halt at once and be billed the
  // way it always was, or the retry masks the defect it was meant to survive.
  test.each([
    ["a frozen lockfile", "error: lockfile had changes, but lockfile is frozen"],
    ["a missing module", "error: Cannot find module '@yrd/queue-core'"],
    ["a failing test", "FAIL packages/yrd-cli/tests/queue-core-up.test.ts > 3 failed"],
    ["a bare exit", "error: script \"setup\" exited with code 1"],
    ["a type error", "src/index.ts(12,3): error TS2345: Argument of type 'string'"],
    ["a permission problem", "EACCES: permission denied, open '/nix/store/x'"],
    ["a full disk", "ENOSPC: no space left on device"],
  ])("%s", (_why, line) => {
    expect(transportFaultIn(line)).toBeUndefined()
    expect(setupStuckCode(transportFaultIn(line))).toBe(SETUP_UNUSABLE_CODE)
  })

  // The one yrd already paid for, one layer up: a remote that ANSWERED and does
  // not hold what was asked for is a component commit that never left somebody's
  // bay. Nothing about the queue is repaired by stopping it, and nothing about
  // the remote is repaired by retrying.
  test.each([
    ["404, the remote answered", "error: GET https://api.github.com/repos/beorn/x/tarball/deadbeef - 404"],
    ["401, the remote answered", "error: GET https://api.github.com/repos/beorn/x - 401"],
    ["403, the remote answered", "remote: HTTP 403 Forbidden"],
    // The same control in git's wording. Widening for git's 5xx must not widen
    // for git's 4xx: a repository that is private or gone ANSWERED, and no
    // number of retries changes the answer.
    ["git's own 404", "fatal: unable to access 'https://github.com/beorn/x/': The requested URL returned error: 404"],
    ["git's own 403", "fatal: unable to access 'https://github.com/beorn/x/': The requested URL returned error: 403"],
  ])("%s is an ANSWER, not a fault", (_why, line) => {
    expect(transportFaultIn(line)).toBeUndefined()
  })

  // The reason the signatures are anchored on a URL or an HTTP word rather than
  // on three digits: a version, a byte count and a duration all contain them.
  test.each([
    ["a version", "resolved left-pad@5.0.4"],
    ["a byte count", "wrote 504 bytes to bun.lock"],
    ["a duration", "setup finished in 502ms"],
    ["a line number", "src/index.ts(503,12): error TS2322"],
    ["a package count", "installed 429 packages"],
  ])("%s is not an HTTP status", (_why, line) => {
    expect(transportFaultIn(line)).toBeUndefined()
  })
})

describe("what the record tells a person", () => {
  test("a break tells them to repair the setup", () => {
    expect(setupStuckNext(undefined)).toBe("repair the queue setup, then run yrd queue run")
  })

  // It names no branch and no author on purpose: nothing about the change is
  // wrong, and sending a submitter to look for a defect that is not there is
  // how a transient outage becomes somebody's afternoon.
  test("a transport fault says the change is not at fault, and names the signature", () => {
    const next = setupStuckNext({ signature: "http-5xx", line: "... - 504" })
    expect(next).toContain("nothing here is the change's fault")
    expect(next).toContain("http-5xx")
    expect(next).toContain("retries on the queue's own cadence")
    expect(next).not.toMatch(/repair the queue setup/u)
  })
})
