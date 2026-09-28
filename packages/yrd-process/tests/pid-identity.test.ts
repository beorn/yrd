/**
 * @failure A permission-denied live PID could be treated as dead, or an unexpected probe failure could disappear.
 * @level l1 (kernel PID presence and process identity)
 * @consumer Yrd's runner publisher and watch reader
 * @testonly none
 */
import { readlinkSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import { pidPresence, processStartIdentity } from "../src/pid-identity.ts"

describe("process identity", () => {
  it("classifies signal-zero outcomes without hiding unexpected errors", () => {
    const probe = vi.spyOn(process, "kill")
    try {
      probe.mockImplementation(() => true)
      expect(pidPresence(123)).toBe("present")
      probe.mockImplementation(() => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" })
      })
      expect(pidPresence(123)).toBe("absent")
      probe.mockImplementation(() => {
        throw Object.assign(new Error("denied"), { code: "EPERM" })
      })
      expect(pidPresence(123)).toBe("present")
      probe.mockImplementation(() => {
        throw Object.assign(new Error("unexpected"), { code: "EIO" })
      })
      expect(() => pidPresence(123)).toThrow("unexpected")
      expect(() => pidPresence(0)).toThrow(TypeError)
      expect(() => pidPresence(1.5)).toThrow(TypeError)
    } finally {
      probe.mockRestore()
    }
  })

  it.skipIf(process.platform !== "linux")("reads this process's boot, PID namespace, and start tick", () => {
    expect(processStartIdentity(process.pid)).toEqual({
      boot: expect.any(String),
      pidNamespace: readlinkSync("/proc/self/ns/pid"),
      tick: expect.any(Number),
    })
  })
})
