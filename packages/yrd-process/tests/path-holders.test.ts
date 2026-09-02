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
  certifyPathReapDeletion,
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
      // A live entry always carries stat; without it the proc reads as exited
      // between reads and clears itself, which is a different case below.
      writeFileSync(join(processRoot, "stat"), "4242 (probe) S 1 0 0 0\n")
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
      expect(census.coverage).toMatchObject({
        unreadable: [{ pid: 4242, denied: ["maps"] }],
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
      // The refusal names the pid — the discriminating fact, not only counts.
      expect(pathReapDeletionFailure(reap)).toMatch(/census incomplete.*pid 4242 \(probe, ppid 1\) via maps/iu)
      expect(pathReapDeletionFailure(reap)).toMatch(/--tolerate-unreadable/u)
      // Waiving exactly the named pid certifies; waiving a different pid never does.
      expect(pathReapDeletionFailure(reap, new Set([4242]))).toBeUndefined()
      expect(pathReapDeletionFailure(reap, new Set([9999]))).toMatch(/pid 4242 \(probe, ppid 1\) via maps/iu)
    },
  )

  test.runIf(process.platform === "linux")(
    "a zombie gap certifies deletion with no waiver, and its neighbours still need one",
    async () => {
      // A zombie has released its fd table, so /proc/N/fd answers EACCES with
      // nothing behind it. Requiring an operator to name it is what made the
      // tolerance flag unreachable: zombies churn between one census and the next.
      const fixture = mkdtempSync(join(tmpdir(), "yrd-path-coverage-zombie-"))
      scratch.push(fixture)
      const ownedPath = join(fixture, "owned")
      const procRoot = join(fixture, "proc")
      mkdirSync(ownedPath)
      for (const [pid, state] of [
        [4242, "Z"],
        [4243, "S"],
      ] as const) {
        const processRoot = join(procRoot, String(pid))
        mkdirSync(join(processRoot, "fd"), { recursive: true })
        symlinkSync("/", join(processRoot, "cwd"))
        symlinkSync("/bin/sh", join(processRoot, "exe"))
        symlinkSync("/", join(processRoot, "root"))
        writeFileSync(join(processRoot, "maps"), "")
        writeFileSync(join(processRoot, "stat"), `${pid} (probe) ${state} 1 0 0 0\n`)
        // Deny exactly one source, the way a released fd table denies /proc/N/fd.
        chmodSync(join(processRoot, "maps"), 0o000)
      }

      const census = await inspectPathHolderCensusInProc(ownedPath, procRoot)
      expect(census.holders).toEqual([])
      expect(census.coverage).toMatchObject({
        complete: false,
        unreadable: [
          { pid: 4242, comm: "probe", state: "Z", denied: ["maps"] },
          { pid: 4243, comm: "probe", state: "S", denied: ["maps"] },
        ],
      })

      const reap = {
        targetedPids: [],
        survivorPids: [],
        survivorHolders: [],
        survivorCoverage: census.coverage,
        forcedKill: false,
        signalFailures: [],
      }
      // The live proc still has to be named; the zombie is never asked for.
      // The identity decoration sits between pid and source, so match across it.
      const refusal = pathReapDeletionFailure(reap)
      expect(refusal).toMatch(/pid 4243 \(probe, ppid 1\) via maps/iu)
      expect(refusal).not.toMatch(/pid 4242 \(probe, ppid 1\) via maps/iu)
      expect(refusal).toMatch(/auto-cleared as provably empty: 4242/iu)
      // Naming only the live proc certifies — the zombie needs no waiver.
      expect(pathReapDeletionFailure(reap, new Set([4243]))).toBeUndefined()
      // Naming only the zombie does not certify the live proc.
      expect(pathReapDeletionFailure(reap, new Set([4242]))).toMatch(/pid 4243 \(probe, ppid 1\) via maps/iu)
    },
  )

  test.runIf(process.platform === "linux")(
    "a gap whose proc exited between the denied read and the identity read clears itself",
    async () => {
      // Measured 2026-09-01 on five consecutive bay closes after zombies were
      // already auto-cleared: /proc/N/fd answered EACCES while the process was
      // dying, then /proc/N/stat was gone by the identity read, so the row was
      // `pid N via fd` with no comm and no state — a different pid on every
      // census, so no waiver could ever name it. An entry that is gone holds
      // nothing; the control beside it, same denial but still alive, is named.
      const fixture = mkdtempSync(join(tmpdir(), "yrd-path-coverage-exited-between-reads-"))
      scratch.push(fixture)
      const ownedPath = join(fixture, "owned")
      const procRoot = join(fixture, "proc")
      mkdirSync(ownedPath)
      const deniedFdTables: string[] = []
      for (const [pid, stat] of [
        [4242, undefined],
        [4243, "4243 (probe) S 1 0 0 0\n"],
      ] as const) {
        const processRoot = join(procRoot, String(pid))
        mkdirSync(join(processRoot, "fd"), { recursive: true })
        symlinkSync("/", join(processRoot, "cwd"))
        symlinkSync("/bin/sh", join(processRoot, "exe"))
        symlinkSync("/", join(processRoot, "root"))
        writeFileSync(join(processRoot, "maps"), "")
        if (stat !== undefined) writeFileSync(join(processRoot, "stat"), stat)
        // Deny the fd table itself, the way a dying process denies /proc/N/fd.
        chmodSync(join(processRoot, "fd"), 0o000)
        deniedFdTables.push(join(processRoot, "fd"))
      }

      try {
        const census = await inspectPathHolderCensusInProc(ownedPath, procRoot)
        expect(census.holders).toEqual([])
        expect(census.coverage).toMatchObject({
          complete: false,
          unreadable: [
            { pid: 4242, exited: true, denied: ["fd"] },
            { pid: 4243, comm: "probe", state: "S", denied: ["fd"] },
          ],
        })

        const reap = {
          targetedPids: [],
          survivorPids: [],
          survivorHolders: [],
          survivorCoverage: census.coverage,
          forcedKill: false,
          signalFailures: [],
        }
        const refusal = pathReapDeletionFailure(reap)
        expect(refusal).toMatch(/pid 4243 \(probe, ppid 1\) via fd/iu)
        expect(refusal).not.toMatch(/pid 4242 via fd/iu)
        expect(refusal).toMatch(/auto-cleared as provably empty: 4242/iu)
        // Naming only the live proc certifies; the exited one is never asked for.
        expect(pathReapDeletionFailure(reap, new Set([4243]))).toBeUndefined()
        expect(pathReapDeletionFailure(reap, new Set([4242]))).toMatch(/pid 4243 \(probe, ppid 1\) via fd/iu)
      } finally {
        // A 000 directory cannot be recursed into by the afterEach cleanup.
        for (const table of deniedFdTables) chmodSync(table, 0o755)
      }
    },
  )

  test.runIf(process.platform === "linux")(
    "a census whose only gaps are zombies certifies with no flag at all",
    async () => {
      const fixture = mkdtempSync(join(tmpdir(), "yrd-path-coverage-all-zombie-"))
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
      writeFileSync(join(processRoot, "stat"), "4242 (defunct) Z 1 0 0 0\n")
      chmodSync(join(processRoot, "maps"), 0o000)

      const census = await inspectPathHolderCensusInProc(ownedPath, procRoot)
      expect(census.coverage).toMatchObject({ complete: false })
      expect(
        pathReapDeletionFailure({
          targetedPids: [],
          survivorPids: [],
          survivorHolders: [],
          survivorCoverage: census.coverage,
          forcedKill: false,
          signalFailures: [],
        }),
      ).toBeUndefined()
    },
  )

  test.runIf(process.platform === "linux")(
    "the certification records every tolerated gap with its reason, identity and start time",
    async () => {
      // The close record has to say what the certification waived and why, in
      // one shape for a zombie, a proc that exited mid-census and a pid the
      // operator named — with the identity the world-readable stat gives:
      // comm, ppid, and the start time from field 22 against the boot time.
      const fixture = mkdtempSync(join(tmpdir(), "yrd-path-coverage-tolerated-record-"))
      scratch.push(fixture)
      const ownedPath = join(fixture, "owned")
      const procRoot = join(fixture, "proc")
      mkdirSync(ownedPath)
      mkdirSync(procRoot)
      const bootSeconds = 1_770_000_000
      writeFileSync(join(procRoot, "stat"), `cpu  1 2 3\nbtime ${bootSeconds}\nprocesses 42\n`)
      // After comm: state, ppid, seventeen fields of filler, then starttime (field 22).
      const statLine = (pid: number, state: string, ticks: number) =>
        `${pid} (probe) ${state} 1 ${Array.from({ length: 17 }, () => "0").join(" ")} ${ticks} 0 0\n`
      const startedAt = (afterBootMs: number) => new Date(bootSeconds * 1_000 + afterBootMs).toISOString()
      const deniedFdTables: string[] = []
      for (const [pid, stat] of [
        [4242, statLine(4242, "Z", 9_000)],
        [4243, statLine(4243, "S", 12_000)],
        [4244, undefined],
      ] as const) {
        const processRoot = join(procRoot, String(pid))
        mkdirSync(join(processRoot, "fd"), { recursive: true })
        symlinkSync("/", join(processRoot, "cwd"))
        symlinkSync("/bin/sh", join(processRoot, "exe"))
        symlinkSync("/", join(processRoot, "root"))
        writeFileSync(join(processRoot, "maps"), "")
        if (stat !== undefined) writeFileSync(join(processRoot, "stat"), stat)
        chmodSync(join(processRoot, "fd"), 0o000)
        deniedFdTables.push(join(processRoot, "fd"))
      }

      try {
        const census = await inspectPathHolderCensusInProc(ownedPath, procRoot)
        expect(census.coverage).toMatchObject({
          complete: false,
          unreadable: [
            { pid: 4242, comm: "probe", ppid: 1, state: "Z", startedAt: startedAt(90_000), denied: ["fd"] },
            { pid: 4243, comm: "probe", ppid: 1, state: "S", startedAt: startedAt(120_000), denied: ["fd"] },
            { pid: 4244, exited: true, denied: ["fd"] },
          ],
        })
        const reap = {
          targetedPids: [],
          survivorPids: [],
          survivorHolders: [],
          survivorCoverage: census.coverage,
          forcedKill: false,
          signalFailures: [],
        }
        // Unwaived: the live proc is named with its start time, nothing is tolerated.
        const refused = certifyPathReapDeletion(reap)
        expect(refused.failure).toContain(`pid 4243 (probe, ppid 1, started ${startedAt(120_000)}) via fd`)
        expect(refused.tolerated).toEqual([])
        // Waived: the record carries every tolerated gap with its reason and identity.
        const certified = certifyPathReapDeletion(reap, new Set([4243]))
        expect(certified.failure).toBeUndefined()
        expect(certified.tolerated).toEqual([
          { pid: 4242, comm: "probe", ppid: 1, startedAt: startedAt(90_000), reason: "zombie" },
          { pid: 4243, comm: "probe", ppid: 1, startedAt: startedAt(120_000), reason: "operator-flag" },
          { pid: 4244, reason: "exited" },
        ])
        // The string projection is the same certification, not a second reader.
        expect(pathReapDeletionFailure(reap, new Set([4243]))).toBeUndefined()
      } finally {
        for (const table of deniedFdTables) chmodSync(table, 0o755)
      }
    },
  )

  test.runIf(process.platform === "linux")("denied counts without named pids can never be tolerated", async () => {
    // An injected census claims denials it cannot attribute to a pid — the
    // tolerance flag must not certify what the census could not name.
    const reap = {
      targetedPids: [],
      survivorPids: [],
      survivorHolders: [],
      survivorCoverage: {
        platform: "linux",
        scope: "same-uid",
        procRoot: "injected-unnamed-denials",
        complete: false,
        processes: { enumerated: 2, sameUid: 2, otherUid: 0, unavailable: { exited: 0, denied: 1 } },
        sources: {
          cwd: { readable: 1, unavailable: { exited: 0, denied: 0 } },
          exe: { readable: 1, unavailable: { exited: 0, denied: 0 } },
          root: { readable: 1, unavailable: { exited: 0, denied: 0 } },
          maps: { readable: 1, unavailable: { exited: 0, denied: 0 } },
          fd: { readable: 1, unavailable: { exited: 0, denied: 0 } },
        },
      },
      forcedKill: false,
      signalFailures: [],
    } as const
    expect(pathReapDeletionFailure(reap, new Set([4242, 9999]))).toMatch(/no denied pids were identified/iu)
  })

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
