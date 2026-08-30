/**
 * @failure A recycled pid answers `kill -0`, so a long-dead owner reads as live and its workspace is refused forever.
 * @level l2
 * @consumer @yrd/process recordedPidLiveness
 * @bead @i/10-yrd/bay-prune-without-data-loss
 */
import { afterEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  classifyRecordedPid,
  observePidSync,
  parseElapsedTime,
  recordedPidIsRunning,
  recordedPidLivenessSync,
  PID_IDENTITY_RECYCLE_MARGIN_MS,
} from "../src/index.ts"

const BOOT_SECONDS = 1_770_000_000
const USER_HZ = 100
const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

/** A synthetic `/proc` holding one process that started `startedAfterBootMs` after boot. */
function procRootWith(
  pid: number,
  startedAfterBootMs: number,
  options: Readonly<{ comm?: string; cmdline?: string }> = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "yrd-pid-identity-"))
  roots.push(root)
  writeFileSync(join(root, "stat"), `cpu  1 2 3\nbtime ${String(BOOT_SECONDS)}\nprocesses 42\n`)
  mkdirSync(join(root, String(pid)))
  const ticks = Math.round((startedAfterBootMs / 1_000) * USER_HZ)
  // Fields 1..22 with `comm` parenthesized in position 2; everything between the
  // comm and starttime is filler the parser must skip by position, not by name.
  const filler = Array.from({ length: 18 }, (_, index) => String(index)).join(" ")
  writeFileSync(
    join(root, String(pid), "stat"),
    `${String(pid)} (${options.comm ?? "bun"}) S ${filler} ${String(ticks)} 0 0\n`,
  )
  writeFileSync(join(root, String(pid), "cmdline"), options.cmdline ?? "bun\0yrd\0queue\0run")
  return root
}

function startedAtMs(startedAfterBootMs: number): number {
  return BOOT_SECONDS * 1_000 + startedAfterBootMs
}

describe("observePidSync against a synthetic proc tree", () => {
  it("reads the start time from field 22 and the command from cmdline", () => {
    const procRoot = procRootWith(4242, 90_000)
    const observation = observePidSync(4242, { procRoot })

    expect(observation.kind).toBe("identified")
    if (observation.kind !== "identified") return
    expect(observation.identity.startedAtMs).toBe(startedAtMs(90_000))
    expect(observation.identity.command).toBe("bun yrd queue run")
  })

  it("skips a comm containing spaces and parentheses rather than splitting the whole line", () => {
    // procps' own trap: `comm` is arbitrary bytes inside parens, so a naive
    // whitespace split reads a filler field as the start time.
    const procRoot = procRootWith(4243, 30_000, { comm: "yrd (queue) run" })
    const observation = observePidSync(4243, { procRoot })

    expect(observation.kind).toBe("identified")
    if (observation.kind !== "identified") return
    expect(observation.identity.startedAtMs).toBe(startedAtMs(30_000))
  })

  it("reports a missing proc entry as gone, never as unknown", () => {
    const procRoot = procRootWith(4244, 10_000)
    expect(observePidSync(9999, { procRoot })).toEqual({ kind: "gone" })
  })
})

describe("classifyRecordedPid", () => {
  const identified = (identity: Readonly<{ startedAtMs?: number; command?: string }>) =>
    ({ kind: "identified", identity }) as const

  it("is live when the process started before the record that names it", () => {
    const report = classifyRecordedPid(
      { pid: 7, runningSinceMs: startedAtMs(90_000) },
      identified({ startedAtMs: startedAtMs(30_000) }),
    )
    expect(report.liveness).toBe("live")
    expect(recordedPidIsRunning(report)).toBe(true)
  })

  it("is RECYCLED when the process started after the record — B58's class", () => {
    // The owner wrote the record, so the owner preceded it. A process at that pid
    // which started later is a reuse of the number, and `kill -0` cannot see the
    // difference: it answered "live" for days against a long-dead owner.
    const report = classifyRecordedPid(
      { pid: 7, runningSinceMs: startedAtMs(30_000) },
      identified({ startedAtMs: startedAtMs(30_000) + PID_IDENTITY_RECYCLE_MARGIN_MS + 1_000 }),
    )
    expect(report.liveness).toBe("recycled")
    expect(recordedPidIsRunning(report)).toBe(false)
    expect(report.evidence).toMatch(/pid was reused/u)
  })

  it("stays live inside the recycle margin, so clock arithmetic cannot retire a live owner", () => {
    const report = classifyRecordedPid(
      { pid: 7, runningSinceMs: startedAtMs(30_000) },
      identified({ startedAtMs: startedAtMs(30_000) + PID_IDENTITY_RECYCLE_MARGIN_MS - 1_000 }),
    )
    expect(report.liveness).toBe("live")
  })

  it("is recycled when the command no longer matches the recorded owner", () => {
    const report = classifyRecordedPid(
      { pid: 7, commandContains: "yrd queue run" },
      identified({ command: "sshd: /usr/sbin/sshd -D" }),
    )
    expect(report.liveness).toBe("recycled")
    expect(report.evidence).toMatch(/does not contain/u)
  })

  it("is gone on an absent process", () => {
    const report = classifyRecordedPid({ pid: 7, runningSinceMs: 1 }, { kind: "gone" })
    expect(report.liveness).toBe("gone")
    expect(recordedPidIsRunning(report)).toBe(false)
  })

  it("is UNKNOWN — never dead — when identity was expected but could not be read", () => {
    // The unprovable case must not collapse into either safe answer, and a
    // caller that only wants a boolean must treat it as still running.
    const denied = classifyRecordedPid({ pid: 7, runningSinceMs: 1 }, { kind: "denied", detail: "EACCES" })
    expect(denied.liveness).toBe("unknown")
    expect(recordedPidIsRunning(denied)).toBe(true)

    const unreadable = classifyRecordedPid({ pid: 7, runningSinceMs: 1 }, identified({}))
    expect(unreadable.liveness).toBe("unknown")
    expect(recordedPidIsRunning(unreadable)).toBe(true)
    expect(unreadable.evidence).toMatch(/identity is unproven/u)
  })

  it("says so when the record carries no identity to check against", () => {
    // The pre-existing bare-signal semantics, preserved verbatim for records that
    // remember only a pid — and now stated, rather than passing for an identity
    // check that never happened.
    const report = classifyRecordedPid({ pid: 7 }, identified({ startedAtMs: 1 }))
    expect(report.liveness).toBe("live")
    expect(report.evidence).toMatch(/no identity to check it against/u)
  })
})

describe("recordedPidLivenessSync", () => {
  it("joins observation and classification for the recycled shape", () => {
    const procRoot = procRootWith(555, 600_000)
    const report = recordedPidLivenessSync({ pid: 555, runningSinceMs: startedAtMs(0) }, { procRoot })
    expect(report.liveness).toBe("recycled")
  })
})

describe("parseElapsedTime", () => {
  it("reads every ps etime shape and refuses the rest", () => {
    expect(parseElapsedTime("01:02")).toBe(62_000)
    expect(parseElapsedTime("03:01:02")).toBe(10_862_000)
    expect(parseElapsedTime("2-03:01:02")).toBe(183_662_000)
    expect(parseElapsedTime("bogus")).toBeUndefined()
  })
})
