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
  inspectPathHolderCensus,
  inspectPathHolders,
  pathHolderRefusal,
  pathReapDeletionFailure,
  pathReapFailure,
  type PathHolder,
} from "../src/index.ts"
// Package-private: the classification decision and the coverage type it feeds.
// Imported by source path rather than widened onto the package surface, the way
// the synthetic-proc seam beside it already is.
import {
  classifyProcessEntryUnavailability,
  inspectPathHolderCensusInProc,
  inspectPathHoldersInProc,
} from "../src/path-reaper.ts"
import type { LinuxPathHolderCoverage } from "../src/path-reaper.ts"

const scratch: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe("inspectPathHolders", () => {
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
          uninspectable: [],
          processes: {
            enumerated: 0,
            sameUid: 0,
            otherUid: 0,
            unavailable: { exited: 0, denied: 0, uninspectable: 0 },
          },
          sources: {
            cwd: { readable: 0, unavailable: { exited: 0, denied: 0, uninspectable: 0 } },
            exe: { readable: 0, unavailable: { exited: 0, denied: 0, uninspectable: 0 } },
            root: { readable: 0, unavailable: { exited: 0, denied: 0, uninspectable: 0 } },
            maps: { readable: 0, unavailable: { exited: 0, denied: 0, uninspectable: 0 } },
            fd: { readable: 0, unavailable: { exited: 0, denied: 0, uninspectable: 0 } },
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

describe("proc-entry unavailability is resolved against what the process says", () => {
  // A permission errno is ambiguous in both directions. These are the eight
  // readings the census can reach; the four that do NOT move are the controls
  // that keep the two new rules from firing on ordinary processes.
  test.each([
    {
      case: "a zombie's fd survives the process and holds nothing",
      code: "EACCES",
      state: "Z",
      entryUid: 0,
      expected: "exited",
    },
    { case: "a zombie's cwd is already gone", code: "ENOENT", state: "Z", entryUid: 0, expected: "exited" },
    {
      case: "a non-dumpable process re-owns its entries to root",
      code: "EACCES",
      state: "S",
      entryUid: 0,
      expected: "uninspectable",
    },
    { case: "EPERM reads the same way as EACCES", code: "EPERM", state: "S", entryUid: 0, expected: "uninspectable" },
    {
      case: "control: a live process whose entries are still ours",
      code: "EACCES",
      state: "S",
      entryUid: 3001,
      expected: "denied",
    },
    { case: "control: an exited entry is never a gap", code: "ENOENT", state: "S", entryUid: 3001, expected: "exited" },
    { case: "control: ESRCH is the same exit", code: "ESRCH", state: "S", entryUid: 3001, expected: "exited" },
    {
      case: "control: an unrelated errno is nobody's business here",
      code: "EIO",
      state: "S",
      entryUid: 3001,
      expected: undefined,
    },
  ])("$case", ({ code, state, entryUid, expected }) => {
    expect(classifyProcessEntryUnavailability(code, { state, processUid: 3001, entryUid })).toBe(expected)
  })

  test("an unreadable status degrades to the conservative answer, never to a certification", () => {
    // The status read can lose a race with the process exiting. Losing it must
    // cost coverage, not correctness: with no facts the census answers exactly
    // what it answered before this rule existed.
    expect(classifyProcessEntryUnavailability("EACCES", {})).toBe("denied")
    expect(classifyProcessEntryUnavailability("EACCES", { state: "S" })).toBe("denied")
    expect(classifyProcessEntryUnavailability("EACCES", { processUid: 3001 })).toBe("denied")
  })

  test("the zombie state is read BEFORE ownership, because a zombie is root-owned too", () => {
    // Measured on every zombie present when this was written: their inner proc
    // entries are owned by root exactly like a non-dumpable process's. If the
    // ownership rule ran first, every zombie would be misclassified as a
    // permanent gap and the deletion refusal would never clear.
    expect(classifyProcessEntryUnavailability("EACCES", { state: "Z", processUid: 3001, entryUid: 0 })).toBe("exited")
    expect(classifyProcessEntryUnavailability("EACCES", { state: "S", processUid: 3001, entryUid: 0 })).toBe(
      "uninspectable",
    )
  })
})

describe("a zombie's denied fd is a contradiction, not a coverage gap", () => {
  /** A zombie as `/proc` really presents one: cwd, exe and root already gone,
   * `maps` readable and empty, and `fd` a surviving directory that denies. */
  function zombieProc(withStatus: boolean): { ownedPath: string; procRoot: string; fdPath: string } {
    const fixture = mkdtempSync(join(tmpdir(), "yrd-path-coverage-zombie-"))
    scratch.push(fixture)
    const ownedPath = join(fixture, "owned")
    const procRoot = join(fixture, "proc")
    const processRoot = join(procRoot, "4242")
    mkdirSync(ownedPath)
    mkdirSync(join(processRoot, "fd"), { recursive: true })
    writeFileSync(join(processRoot, "maps"), "")
    if (withStatus) writeFileSync(join(processRoot, "status"), "Name:\tsh\nState:\tZ (zombie)\nPid:\t4242\n")
    const fdPath = join(processRoot, "fd")
    chmodSync(fdPath, 0o000)
    return { ownedPath, procRoot, fdPath }
  }

  test.runIf(process.platform === "linux")("a zombie costs no coverage and certifies deletion", async () => {
    const { ownedPath, procRoot, fdPath } = zombieProc(true)
    try {
      const census = await inspectPathHolderCensusInProc(ownedPath, procRoot)

      expect(census.holders).toEqual([])
      expect(census.coverage).toMatchObject({
        complete: true,
        uninspectable: [],
        sources: {
          // The denial the process contradicts: recorded as the exit it is.
          fd: { readable: 0, unavailable: { exited: 1, denied: 0, uninspectable: 0 } },
          cwd: { readable: 0, unavailable: { exited: 1, denied: 0, uninspectable: 0 } },
          maps: { readable: 1, unavailable: { exited: 0, denied: 0, uninspectable: 0 } },
        },
      })
    } finally {
      chmodSync(fdPath, 0o755)
    }
  })

  test.runIf(process.platform === "linux")(
    "control: the SAME fixture without the state read is still a denial",
    async () => {
      // Without this the test above proves nothing — a census that certified
      // everything would pass it just as happily. The only difference between
      // the two fixtures is the status file the classification reads.
      const { ownedPath, procRoot, fdPath } = zombieProc(false)
      try {
        const census = await inspectPathHolderCensusInProc(ownedPath, procRoot)

        expect(census.coverage).toMatchObject({
          complete: false,
          uninspectable: [],
          sources: { fd: { readable: 0, unavailable: { exited: 0, denied: 1, uninspectable: 0 } } },
        })
      } finally {
        chmodSync(fdPath, 0o755)
      }
    },
  )
})

describe("a permanent gap is named and can be accepted; a clearable one cannot", () => {
  function coverage(
    uninspectable: readonly Readonly<{ pid: number; comm: string }>[],
    denied = 0,
  ): LinuxPathHolderCoverage {
    return {
      platform: "linux",
      scope: "same-uid",
      procRoot: "/proc",
      complete: false,
      uninspectable,
      processes: { enumerated: 1, sameUid: 1, otherUid: 0, unavailable: { exited: 0, denied: 0, uninspectable: 0 } },
      sources: {
        cwd: { readable: 0, unavailable: { exited: 0, denied, uninspectable: uninspectable.length } },
        exe: { readable: 1, unavailable: { exited: 0, denied: 0, uninspectable: 0 } },
        root: { readable: 1, unavailable: { exited: 0, denied: 0, uninspectable: 0 } },
        maps: { readable: 1, unavailable: { exited: 0, denied: 0, uninspectable: 0 } },
        fd: { readable: 1, unavailable: { exited: 0, denied: 0, uninspectable: 0 } },
      },
    }
  }
  const reapOf = (survivorCoverage: LinuxPathHolderCoverage) => ({
    targetedPids: [],
    survivorPids: [],
    survivorHolders: [],
    survivorCoverage,
    forcedKill: false,
    signalFailures: [],
  })

  test("the refusal names the pid and comm instead of dumping the census", () => {
    const failure = pathReapDeletionFailure(reapOf(coverage([{ pid: 2217355, comm: "sshd-session" }])))

    expect(failure).toBe(
      "path-holder census cannot inspect pid 2217355 (sshd-session): the kernel marks it non-dumpable, so no " +
        "retry will ever read its open files. Confirm it holds nothing under the path, then accept that pid explicitly",
    )
  })

  test("accepting the named pid certifies deletion", () => {
    const reap = reapOf(coverage([{ pid: 2217355, comm: "sshd-session" }]))

    expect(pathReapDeletionFailure(reap, { acceptUninspectablePids: [2217355] })).toBeUndefined()
  })

  test("accepting some OTHER pid certifies nothing", () => {
    // Acceptance is per-pid and never implicit; the operator's judgement is
    // about one process they inspected by other means, not about the class.
    const reap = reapOf(coverage([{ pid: 2217355, comm: "sshd-session" }]))

    expect(pathReapDeletionFailure(reap, { acceptUninspectablePids: [999] })).toMatch(/cannot inspect pid 2217355/u)
  })

  test("accepting a permanent gap never waives a clearable denial standing beside it", () => {
    // The two classes are independent: a denial may be hiding a live holder and
    // may clear on its own, so no acceptance of a non-dumpable process can
    // speak for it.
    const reap = reapOf(coverage([{ pid: 2217355, comm: "sshd-session" }], 1))

    expect(pathReapDeletionFailure(reap, { acceptUninspectablePids: [2217355] })).toMatch(
      /census incomplete.*deletion cannot be certified/u,
    )
  })
})
