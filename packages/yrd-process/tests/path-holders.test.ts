/**
 * @failure A process chrooted into a disposable path is invisible to teardown, so the path can be removed under a live holder.
 * @level l2
 * @consumer @yrd/process inspectPathHolderCensus
 */
import { afterEach, describe, expect, test, vi } from "vitest"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspectPathHolderCensus, pathHolderRefusal, type PathHolder } from "../src/index.ts"
import { inspectPathHolderCensusInProc } from "../src/path-reaper.ts"

const temporary: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe("inspectPathHolderCensus", () => {
  test("the public refusal preserves the holder source and target", () => {
    expect(inspectPathHolderCensus).toBeTypeOf("function")
    const holders: PathHolder[] = [
      { pid: 42, source: "cwd", target: "/tmp/bay" },
      { pid: 57, source: "fd/7", target: "/tmp/bay/output.log" },
    ]

    expect(pathHolderRefusal(holders)).toBe(
      "path remains held by pid 42 via cwd (/tmp/bay); pid 57 via fd/7 (/tmp/bay/output.log)",
    )
    expect(pathHolderRefusal([])).toBeUndefined()
  })

  test.runIf(process.platform === "linux")("reports a process whose filesystem root holds the owned path", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "yrd-path-holders-"))
    temporary.push(fixture)
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
    const census = await inspectPathHolderCensusInProc(ownedPath, procRoot)
    expect(census.holders).toEqual([{ pid: 4242, source: "root", target: ownedPath }])
    expect(kill).not.toHaveBeenCalled()
  })

  test.runIf(process.platform === "linux")("reports mapped files below the owned path", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "yrd-path-maps-"))
    temporary.push(fixture)
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

    const census = await inspectPathHolderCensusInProc(ownedPath, procRoot)
    expect(census.holders).toEqual([{ pid: 4242, source: "fd/maps", target: mappedFile }])
  })

  test.runIf(process.platform === "linux")(
    "reports reduced same-UID coverage instead of a clean empty census when a source is denied",
    async () => {
      const fixture = mkdtempSync(join(tmpdir(), "yrd-path-coverage-denied-"))
      temporary.push(fixture)
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
      // The counts say HOW MANY observations were hidden; this names WHO.
      expect(census.coverage).toMatchObject({
        unreadable: [{ pid: 4242, comm: "probe", ppid: 1, denied: ["maps"] }],
      })
    },
  )

  test.runIf(process.platform === "linux")(
    "a ZOMBIE is not a gap at all — it is counted and skipped, and only the live denial blocks",
    async () => {
      // A zombie has been reaped by the kernel: its address space, descriptors
      // and cwd are already released, so /proc/N/fd answers EACCES because there
      // is NOTHING TO LIST, not because permission is withheld.
      //
      // This test used to assert the opposite half — that the census merely
      // RECORDED the state beside the denial, leaving the zombie in `unreadable`
      // and `complete` false either way. Recording it was never enough: a
      // process that provably holds nothing was still making every caller
      // refuse. That false gap is invisible because it errs safe, and a guard
      // that refuses too often looks exactly like one that works.
      //
      // Observed on hab1 2026-09-10, blocking a whole-estate reap of 107 rows:
      // pids 286562 (claude), 1794340 (bun), 659207/659240/659270 (git) and
      // 4034727 (sh) — every one state Z, every one denying only `fd`.
      //
      // The live sibling below is the control: it denies the same source and it
      // MUST still block, or this fix would have bought completeness by going
      // blind.
      const fixture = mkdtempSync(join(tmpdir(), "yrd-path-coverage-zombie-"))
      temporary.push(fixture)
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
      // The zombie is counted, never probed, and never listed as unreadable.
      // The live one is the only thing left blocking.
      expect(census.coverage).toMatchObject({
        complete: false,
        processes: { enumerated: 2, sameUid: 2, otherUid: 0, zombie: 1 },
        unreadable: [{ pid: 4243, comm: "probe", state: "S", denied: ["maps"] }],
      })
    },
  )

  test.runIf(process.platform === "linux")(
    "a census whose ONLY denials are zombies is COMPLETE",
    async () => {
      // The other direction, and the one that actually unblocks a caller: with
      // the live sibling removed, nothing is hiding a holder and the census may
      // say so. Without this the fix above is unobservable — `complete` would
      // stay false for a different reason and no caller would ever notice.
      const fixture = mkdtempSync(join(tmpdir(), "yrd-path-coverage-zombies-only-"))
      temporary.push(fixture)
      const ownedPath = join(fixture, "owned")
      const procRoot = join(fixture, "proc")
      mkdirSync(ownedPath)
      for (const pid of [4242, 4243]) {
        const processRoot = join(procRoot, String(pid))
        mkdirSync(join(processRoot, "fd"), { recursive: true })
        symlinkSync("/", join(processRoot, "cwd"))
        symlinkSync("/bin/sh", join(processRoot, "exe"))
        symlinkSync("/", join(processRoot, "root"))
        writeFileSync(join(processRoot, "maps"), "")
        writeFileSync(join(processRoot, "stat"), `${pid} (probe) Z 1 0 0 0\n`)
        chmodSync(join(processRoot, "maps"), 0o000)
      }

      const census = await inspectPathHolderCensusInProc(ownedPath, procRoot)
      expect(census.holders).toEqual([])
      expect(census.coverage).toMatchObject({
        complete: true,
        processes: { enumerated: 2, sameUid: 2, otherUid: 0, zombie: 2 },
      })
      expect(census.coverage).not.toHaveProperty("unreadable")
    },
  )

  test.runIf(process.platform === "linux")(
    "a gap whose proc exited between the denied read and the identity read clears itself",
    async () => {
      // Measured 2026-09-01 on five consecutive bay closes after zombies were
      // already auto-cleared: /proc/N/fd answered EACCES while the process was
      // dying, then /proc/N/stat was gone by the identity read, so the row was
      // `pid N via fd` with no comm and no state. `exited` is the transition that
      // separates it from the control beside it: same denial, still alive.
      const fixture = mkdtempSync(join(tmpdir(), "yrd-path-coverage-exited-between-reads-"))
      temporary.push(fixture)
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
      } finally {
        // A 000 directory cannot be recursed into by the afterEach cleanup.
        for (const table of deniedFdTables) chmodSync(table, 0o755)
      }
    },
  )

  test.runIf(process.platform === "linux")(
    "a denied source is named with its comm, ppid and start time from the same stat read",
    async () => {
      // Identity is whatever the world-readable stat gives: comm, ppid, and
      // the start time from field 22 against the host's boot time — for a
      // zombie, a live proc, and one that was gone before it could be read.
      const fixture = mkdtempSync(join(tmpdir(), "yrd-path-coverage-tolerated-record-"))
      temporary.push(fixture)
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
        // Live (S), not Z: a zombie is no longer a denial at all — it is counted
        // and skipped — so a zombie fixture would exercise nothing here. This
        // test is about the IDENTITY decoration on a real gap, and it needs a
        // real gap to decorate.
        [4242, statLine(4242, "S", 9_000)],
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
            { pid: 4242, comm: "probe", ppid: 1, state: "S", startedAt: startedAt(90_000), denied: ["fd"] },
            { pid: 4243, comm: "probe", ppid: 1, state: "S", startedAt: startedAt(120_000), denied: ["fd"] },
            { pid: 4244, exited: true, denied: ["fd"] },
          ],
        })
      } finally {
        for (const table of deniedFdTables) chmodSync(table, 0o755)
      }
    },
  )

  test.runIf(process.platform === "linux")(
    "keeps an exited source separate from denial without reducing coverage",
    async () => {
      const fixture = mkdtempSync(join(tmpdir(), "yrd-path-coverage-exited-"))
      temporary.push(fixture)
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
      temporary.push(fixture)
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
          processes: { enumerated: 0, sameUid: 0, otherUid: 0, zombie: 0, unavailable: { exited: 0, denied: 0 } },
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
    temporary.push(fixture)
    const ownedPath = join(fixture, "owned")
    const procRoot = join(fixture, "missing-proc")
    mkdirSync(ownedPath)

    await expect(inspectPathHolderCensusInProc(ownedPath, procRoot)).rejects.toThrow(
      `Linux path-holder census requires readable proc root '${procRoot}'`,
    )
  })
})
