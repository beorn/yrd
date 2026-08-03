/**
 * @failure A permission-filtered Linux /proc entry is mistaken for a vanished process, so Yrd certifies a Bay path safe while an uninspectable process may still own it.
 * @level l2
 * @consumer @yrd/process reapOwnedPath
 */
import { beforeEach, describe, expect, test, vi } from "vitest"

const fs = vi.hoisted(() => ({
  readFile: vi.fn<(path: string) => Promise<Buffer>>(),
  readdir: vi.fn<(path: string, options?: unknown) => Promise<unknown[]>>(),
  readlink: vi.fn<(path: string) => Promise<string>>(),
  realpath: vi.fn<(path: string) => Promise<string>>(),
  stat: vi.fn<(path: string) => Promise<{ uid: number }>>(),
}))

vi.mock("node:fs/promises", () => fs)

import { reapOwnedPath } from "../src/path-reaper.ts"

const PID = 424_242
const PROC = `/proc/${PID}`

type DeniedProbe = Readonly<{
  code: "EACCES" | "EPERM"
  source: "cmdline" | "cwd" | "exe" | "fd" | "fd/7" | "stat"
}>

function permissionError(code: DeniedProbe["code"]): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

beforeEach(() => {
  fs.readFile.mockReset().mockResolvedValue(Buffer.from("/usr/bin/bun\0"))
  fs.readdir.mockReset().mockImplementation(async (path) => {
    if (path === "/proc") return [{ name: String(PID), isDirectory: () => true }]
    if (path === `${PROC}/fd`) return ["7"]
    throw Object.assign(new Error(`unexpected readdir ${path}`), { code: "EINVAL" })
  })
  fs.readlink.mockReset().mockResolvedValue("/outside-bay")
  fs.realpath.mockReset().mockResolvedValue("/bay")
  fs.stat.mockReset().mockResolvedValue({ uid: process.getuid?.() ?? 0 })
})

describe.runIf(process.platform === "linux")("Linux Bay ownership certification", () => {
  test.each(["ENOENT", "ESRCH"] as const)(
    "accepts a process that disappears with %s during inspection",
    async (code) => {
      fs.stat.mockRejectedValueOnce(Object.assign(new Error(code), { code }))

      await expect(reapOwnedPath("/bay", 0, 0)).resolves.toEqual({
        forcedKill: false,
        signalFailures: [],
        survivorPids: [],
        targetedPids: [],
      })
    },
  )

  test.each<DeniedProbe>([
    { source: "stat", code: "EACCES" },
    { source: "cwd", code: "EPERM" },
    { source: "exe", code: "EACCES" },
    { source: "cmdline", code: "EPERM" },
    { source: "fd", code: "EACCES" },
    { source: "fd/7", code: "EPERM" },
  ])("refuses certification when pid $source inspection fails with $code", async ({ code, source }) => {
    const denied = permissionError(code)
    if (source === "stat") fs.stat.mockRejectedValueOnce(denied)
    if (source === "cmdline") fs.readFile.mockRejectedValueOnce(denied)
    if (source === "fd") {
      fs.readdir.mockImplementationOnce(async () => [{ name: String(PID), isDirectory: () => true }])
      fs.readdir.mockRejectedValueOnce(denied)
    }
    if (source === "cwd" || source === "exe" || source === "fd/7") {
      fs.readlink.mockImplementation(async (path) => {
        if (path === `${PROC}/${source}`) throw denied
        return "/outside-bay"
      })
    }

    await expect(reapOwnedPath("/bay", 0, 0)).rejects.toThrow(
      `cannot certify Bay path ownership: pid ${PID} ${source} inspection failed (${code})`,
    )
  })
})
