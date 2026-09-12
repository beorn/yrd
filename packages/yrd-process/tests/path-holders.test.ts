/**
 * @failure A collector migration broadens Yrd's same-UID API or lets incomplete observations pass legacy teardown overrides.
 * @level l1
 * @consumer @yrd/process inspectPathHolderCensus and pathHolderRefusal
 */
import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest"
import type { LinuxPathHolderCoverage as SharedLinuxCoverage, PathHolderCensus as SharedCensus } from "removely"
import {
  inspectPathHolderCensus,
  pathHolderRefusal,
  type DarwinPathHolderCoverage,
  type LinuxPathHolderCoverage,
  type PathHolder,
  type PathHolderCensus,
  type PathHolderSourceCoverage,
  type PathHolderUnavailableCoverage,
  type UnreadableProcess,
} from "../src/index.ts"

const { inspect } = vi.hoisted(() => ({
  inspect: vi.fn<(path: string, options: { scope: "same-uid" }) => Promise<SharedCensus<"same-uid">>>(),
}))
vi.mock("removely", async (importOriginal) => ({
  ...(await importOriginal<typeof import("removely")>()),
  inspectPathHolderCensus: inspect,
}))

afterEach(() => vi.resetAllMocks())

// Existing callers construct this shape without any of the shared collector's
// new counters. Keep that source compatibility beside the runtime forwarding test.
const unavailable: PathHolderUnavailableCoverage = { exited: 0, denied: 0 }
const source: PathHolderSourceCoverage = { readable: 1, unavailable }
const unreadable: UnreadableProcess = { pid: 42, denied: ["maps"] }
const linux: LinuxPathHolderCoverage = {
  platform: "linux",
  scope: "same-uid",
  procRoot: "/proc",
  complete: true,
  processes: { enumerated: 1, sameUid: 1, otherUid: 0, zombie: 0, unavailable },
  sources: { cwd: source, exe: source, root: source, maps: source, fd: source },
}
const darwin: DarwinPathHolderCoverage = { platform: "darwin", mechanism: "lsof", complete: true }
const sharedUnavailable = { ...unavailable, missing: 0, ambiguous: 0 }
const sharedSource = { ...source, unavailable: sharedUnavailable, notApplicable: 0 }
const sharedLinux: SharedLinuxCoverage<"same-uid"> = {
  ...linux,
  processes: { ...linux.processes, admitted: 1, inspected: 1, excluded: 0, unavailable: sharedUnavailable },
  sources: { cwd: sharedSource, exe: sharedSource, root: sharedSource, maps: sharedSource, fd: sharedSource },
  unreadable: [],
}

describe("path-holder compatibility adapter", () => {
  test("retains the one-argument API, same-UID literal and legacy constructible types", () => {
    expectTypeOf(inspectPathHolderCensus).toEqualTypeOf<(path: string) => Promise<PathHolderCensus>>()
    expectTypeOf<LinuxPathHolderCoverage["scope"]>().toEqualTypeOf<"same-uid">()
    expectTypeOf<PathHolder["source"]>().toEqualTypeOf<"cwd" | "exe" | "root" | `fd/${string}`>()
    const legacy: PathHolderCensus[] = [
      { holders: [], coverage: { ...linux, unreadable: [unreadable] } },
      { holders: [], coverage: darwin },
    ]
    expect(legacy.map(({ coverage }) => coverage.platform)).toEqual(["linux", "darwin"])
  })

  test.each([
    { name: "complete Linux", census: { holders: [], coverage: sharedLinux } },
    {
      name: "denied Linux",
      census: {
        holders: [{ pid: 57, source: "fd/7", target: "/owned/output.log" }],
        coverage: {
          ...sharedLinux,
          complete: false,
          sources: {
            ...sharedLinux.sources,
            maps: { ...sharedSource, readable: 0, unavailable: { ...sharedUnavailable, denied: 1 } },
          },
          unreadable: [
            {
              ...unreadable,
              issues: [{ source: "maps", resource: "/proc/42/maps", reason: "denied", code: "EACCES" }],
            },
          ],
        },
      },
    },
    { name: "Darwin", census: { holders: [], coverage: darwin } },
  ] satisfies { name: string; census: SharedCensus<"same-uid"> }[])(
    "preserves $name evidence while selecting the legacy scope",
    async ({ census }) => {
      inspect.mockResolvedValueOnce(census)
      await expect(inspectPathHolderCensus("/owned")).resolves.toEqual(census)
      expect(inspect).toHaveBeenCalledExactlyOnceWith("/owned", { scope: "same-uid" })
    },
  )

  // Legacy callers may explain away permission denials with their own census.
  // A missing or ambiguous source is not a denial and must never take that path.
  test.each([
    { gap: "missing", denied: 0 },
    { gap: "ambiguous", denied: 0 },
    // A source may report a dominant denial counter while also naming a lost
    // descriptor. The named gap must survive the caller's denial override.
    { gap: "missing", denied: 1 },
  ] as const)(
    "throws for $gap source evidence alongside $denied denial with its original resource",
    async ({ gap, denied }) => {
      inspect.mockResolvedValueOnce({
        holders: [],
        coverage: {
          ...sharedLinux,
          complete: false,
          sources: {
            ...sharedLinux.sources,
            fd: {
              ...sharedSource,
              readable: 0,
              unavailable: { ...sharedUnavailable, denied, [gap]: denied === 0 ? 1 : 0 },
            },
          },
          unreadable: [
            {
              pid: 42,
              denied: denied === 0 ? [] : ["fd"],
              issues: [
                { source: "fd", resource: "/proc/42/fd/8", code: "ENOENT", reason: gap },
                ...(denied === 0
                  ? []
                  : [{ source: "fd" as const, resource: "/proc/42/fd/7", reason: "denied" as const, code: "EACCES" }]),
              ],
            },
          ],
        },
      })
      const census = inspectPathHolderCensus("/owned")
      await expect(census).rejects.toThrow(new RegExp(`${gap}.*(?:/proc/42/fd/8)|(?:/proc/42/fd/8).*${gap}`))
      await expect(census).rejects.toThrow("'/owned'")
    },
  )

  test("propagates required-resource failures instead of returning an empty census", async () => {
    const failure = new Error("Linux path-holder census requires readable proc root '/proc': EIO")
    inspect.mockRejectedValueOnce(failure)
    await expect(inspectPathHolderCensus("/owned")).rejects.toBe(failure)
  })

  test("the public refusal preserves the holder source and target", () => {
    const holders: PathHolder[] = [
      { pid: 42, source: "cwd", target: "/tmp/bay" },
      { pid: 57, source: "fd/7", target: "/tmp/bay/output.log" },
    ]
    expect(pathHolderRefusal(holders)).toBe(
      "path remains held by pid 42 via cwd (/tmp/bay); pid 57 via fd/7 (/tmp/bay/output.log)",
    )
    expect(pathHolderRefusal([])).toBeUndefined()
  })
})
