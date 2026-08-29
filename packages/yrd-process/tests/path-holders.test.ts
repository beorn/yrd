/**
 * @failure A process chrooted into a disposable path is invisible to teardown, so the path can be removed under a live holder.
 * @level l2
 * @consumer @yrd/process inspectPathHolders
 */
import { afterEach, describe, expect, test, vi } from "vitest"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createProcess,
  inspectPathHolderCensus,
  inspectPathHolders,
  pathHolderRefusal,
  pathReapDeletionFailure,
  pathReapFailure,
  type PathHolder,
} from "../src/index.ts"
import { inspectPathHolderCensusInProc, inspectPathHoldersInProc } from "../src/path-reaper.ts"

const scratch: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe("inspectPathHolders", () => {
  test.runIf(process.platform === "linux")(
    "an injected census preserves incomplete coverage as a deletion refusal",
    async () => {
      const fixture = mkdtempSync(join(tmpdir(), "yrd-path-injected-census-"))
      scratch.push(fixture)
      const ownedPath = join(fixture, "owned")
      mkdirSync(ownedPath)
      const service = createProcess({
        inject: {
          pathHolderCensus: async () => ({
            holders: [],
            coverage: {
              platform: "linux",
              scope: "same-uid",
              procRoot: "injected-test-fixture",
              complete: false,
              processes: {
                enumerated: 1,
                sameUid: 1,
                otherUid: 0,
                unavailable: { exited: 0, denied: 0 },
              },
              sources: {
                cwd: { readable: 0, unavailable: { exited: 0, denied: 1 } },
                exe: { readable: 0, unavailable: { exited: 0, denied: 1 } },
                root: { readable: 0, unavailable: { exited: 0, denied: 1 } },
                maps: { readable: 0, unavailable: { exited: 0, denied: 1 } },
                fd: { readable: 0, unavailable: { exited: 0, denied: 1 } },
              },
            },
          }),
        },
      })
      try {
        const result = await service.reapPath(ownedPath)
        expect(result.survivorCoverage?.complete).toBe(false)
        expect(pathReapDeletionFailure(result)).toMatch(/census incomplete.*injected-test-fixture.*denied/isu)
      } finally {
        await service.close()
      }
    },
  )

  test("the public refusal preserves the holder source and target", () => {
    expect(inspectPathHolderCensus).toBeTypeOf("function")
    expect(inspectPathHolders).toBeTypeOf("function")
    const holders: PathHolder[] = [
      { pid: 42, source: "cwd", target: "/tmp/bay" },
      { pid: 57, source: "fd/7", target: "/tmp/bay/output.log" },
    ]

    expect(pathHolderRefusal(holders)).toBe(
      "path remains held by pid 42 via cwd (/tmp/bay); pid 57 via fd/7 (/tmp/bay/output.log)",
    )
    expect(pathHolderRefusal([])).toBeUndefined()
    expect(
      pathReapDeletionFailure({
        targetedPids: [],
        survivorPids: [],
        forcedKill: false,
        signalFailures: [],
      }),
    ).toMatch(/coverage missing.*deletion cannot be certified/iu)
    expect(
      pathReapFailure({
        targetedPids: [42, 57],
        survivorPids: [42, 57],
        survivorHolders: holders,
        forcedKill: true,
        signalFailures: [],
      }),
    ).toContain("pid 57 via fd/7 (/tmp/bay/output.log)")
  })

  test.runIf(process.platform === "linux")("reports a process whose filesystem root holds the owned path", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "yrd-path-holders-"))
    scratch.push(fixture)
    const ownedPath = join(fixture, "owned")
    const procRoot = join(fixture, "proc")
    const processRoot = join(procRoot, "4242")
    mkdirSync(ownedPath)
    mkdirSync(join(processRoot, "fd"), { recursive: true })
    symlinkSync("/", join(processRoot, "cwd"))
    symlinkSync("/bin/sh", join(processRoot, "exe"))
    symlinkSync(ownedPath, join(processRoot, "root"))
    writeFileSync(join(processRoot, "maps"), "")

    const kill = vi.spyOn(process, "kill")
    await expect(inspectPathHoldersInProc(ownedPath, procRoot)).resolves.toEqual([
      { pid: 4242, source: "root", target: ownedPath },
    ])
    expect(kill).not.toHaveBeenCalled()
  })

  test.runIf(process.platform === "linux")("reports mapped files below the owned path", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "yrd-path-maps-"))
    scratch.push(fixture)
    const ownedPath = join(fixture, "owned")
    const mappedFile = join(ownedPath, "native.node")
    const procRoot = join(fixture, "proc")
    const processRoot = join(procRoot, "4242")
    mkdirSync(ownedPath)
    writeFileSync(mappedFile, "mapped fixture\n")
    mkdirSync(join(processRoot, "fd"), { recursive: true })
    symlinkSync("/", join(processRoot, "cwd"))
    symlinkSync("/bin/sh", join(processRoot, "exe"))
    symlinkSync("/", join(processRoot, "root"))
    writeFileSync(join(processRoot, "maps"), `7f000000-7f001000 r--p 00000000 00:00 0 ${mappedFile}\n`)

    await expect(inspectPathHoldersInProc(ownedPath, procRoot)).resolves.toEqual([
      { pid: 4242, source: "fd/maps", target: mappedFile },
    ])
  })

  test.runIf(process.platform === "linux")(
    "reports reduced same-UID coverage instead of a clean empty census when a source is denied",
    async () => {
      const fixture = mkdtempSync(join(tmpdir(), "yrd-path-coverage-denied-"))
      scratch.push(fixture)
      const ownedPath = join(fixture, "owned")
      const procRoot = join(fixture, "proc")
      const processRoot = join(procRoot, "4242")
      mkdirSync(ownedPath)
      mkdirSync(join(processRoot, "fd"), { recursive: true })
      symlinkSync("/", join(processRoot, "cwd"))
      symlinkSync("/bin/sh", join(processRoot, "exe"))
      symlinkSync("/", join(processRoot, "root"))
      writeFileSync(join(processRoot, "maps"), "")
      chmodSync(join(processRoot, "maps"), 0o000)

      const census = await inspectPathHolderCensusInProc(ownedPath, procRoot)

      expect(census.holders).toEqual([])
      expect(census.coverage).toMatchObject({
        platform: "linux",
        scope: "same-uid",
        complete: false,
        processes: { enumerated: 1, sameUid: 1, otherUid: 0, unavailable: { exited: 0, denied: 0 } },
        sources: {
          cwd: { readable: 1, unavailable: { exited: 0, denied: 0 } },
          exe: { readable: 1, unavailable: { exited: 0, denied: 0 } },
          root: { readable: 1, unavailable: { exited: 0, denied: 0 } },
          maps: { readable: 0, unavailable: { exited: 0, denied: 1 } },
          fd: { readable: 1, unavailable: { exited: 0, denied: 0 } },
        },
      })
      const reap = {
        targetedPids: [],
        survivorPids: [],
        survivorHolders: [],
        survivorCoverage: census.coverage,
        forcedKill: false,
        signalFailures: [],
      }
      expect(pathReapFailure(reap)).toBeUndefined()
      expect(pathReapDeletionFailure(reap)).toMatch(/census incomplete.*same-uid.*denied/iu)
    },
  )

  test.runIf(process.platform === "linux")(
    "keeps an exited source separate from denial without reducing coverage",
    async () => {
      const fixture = mkdtempSync(join(tmpdir(), "yrd-path-coverage-exited-"))
      scratch.push(fixture)
      const ownedPath = join(fixture, "owned")
      const procRoot = join(fixture, "proc")
      const processRoot = join(procRoot, "4242")
      mkdirSync(ownedPath)
      mkdirSync(join(processRoot, "fd"), { recursive: true })
      symlinkSync("/", join(processRoot, "cwd"))
      symlinkSync("/bin/sh", join(processRoot, "exe"))
      symlinkSync("/", join(processRoot, "root"))
      // No maps entry: ENOENT represents a source that exited during traversal.

      const census = await inspectPathHolderCensusInProc(ownedPath, procRoot)

      expect(census.holders).toEqual([])
      expect(census.coverage).toMatchObject({
        platform: "linux",
        complete: true,
        sources: {
          maps: { readable: 0, unavailable: { exited: 1, denied: 0 } },
        },
      })
    },
  )

  test.runIf(process.platform === "linux")(
    "a complete empty census says what proc root and same-UID scope were searched",
    async () => {
      const fixture = mkdtempSync(join(tmpdir(), "yrd-path-coverage-empty-"))
      scratch.push(fixture)
      const ownedPath = join(fixture, "owned")
      const procRoot = join(fixture, "proc")
      mkdirSync(ownedPath)
      mkdirSync(procRoot)

      await expect(inspectPathHolderCensusInProc(ownedPath, procRoot)).resolves.toEqual({
        holders: [],
        coverage: {
          platform: "linux",
          scope: "same-uid",
          procRoot,
          complete: true,
          processes: { enumerated: 0, sameUid: 0, otherUid: 0, unavailable: { exited: 0, denied: 0 } },
          sources: {
            cwd: { readable: 0, unavailable: { exited: 0, denied: 0 } },
            exe: { readable: 0, unavailable: { exited: 0, denied: 0 } },
            root: { readable: 0, unavailable: { exited: 0, denied: 0 } },
            maps: { readable: 0, unavailable: { exited: 0, denied: 0 } },
            fd: { readable: 0, unavailable: { exited: 0, denied: 0 } },
          },
        },
      })
    },
  )

  test.runIf(process.platform === "linux")("fails loudly when the required proc root is missing", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "yrd-path-coverage-missing-"))
    scratch.push(fixture)
    const ownedPath = join(fixture, "owned")
    const procRoot = join(fixture, "missing-proc")
    mkdirSync(ownedPath)

    await expect(inspectPathHolderCensusInProc(ownedPath, procRoot)).rejects.toThrow(
      `Linux path-holder census requires readable proc root '${procRoot}'`,
    )
  })
})
