/**
 * @failure A permission-denied live PID could be treated as dead, or an unexpected probe failure could disappear.
 * @level l1 (kernel PID presence and process identity)
 * @consumer Yrd's runner publisher and watch reader
 * @testonly none
 */
import { mkdirSync, mkdtempSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeRemoveSync } from "removely"
import { describe, expect, it, vi } from "vitest"
import { pidPresence, processStartIdentity } from "../src/pid-identity.ts"

describe("process identity", () => {
  it("retains a missing start tick's exact field, path, and errno alongside readable identity", () => {
    const root = mkdtempSync(join(tmpdir(), "yrd-proc-identity-"))
    try {
      mkdirSync(join(root, "sys/kernel/random"), { recursive: true })
      writeFileSync(join(root, "sys/kernel/random/boot_id"), "boot-a\n")
      mkdirSync(join(root, "42/ns"), { recursive: true })
      symlinkSync("pid:[42]", join(root, "42/ns/pid"))
      expect(processStartIdentity(42, root)).toEqual({
        boot: "boot-a",
        pidNamespace: "pid:[42]",
        unreadable: [{ field: "startTick", path: join(root, "42/stat"), code: "ENOENT" }],
      })
    } finally {
      safeRemoveSync(root, { within: realpathSync(tmpdir()) })
    }
  })

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
