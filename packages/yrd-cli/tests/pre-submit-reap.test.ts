/**
 * @failure The pre-submit checkout reaper kept every abandoned entry — its keep
 * set was `git worktree list`, and an abandoned checkout stays registered — so
 * 27 GB accumulated over 13 days while every sweep reported success. A second
 * arm skipped the sweep entirely, silently, whenever that listing failed.
 * @level l2
 * @consumer @yrd/cli pre-submit checkout scratch
 */
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeScratchOwner } from "@yrd/queue"
import type { ConditionalLogger } from "loggily"
import { afterEach, describe, expect, it } from "vitest"
import { reapAbandonedPreSubmitCheckouts } from "../src/host.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

type Line = Readonly<{ level: string; message: string; fields: Record<string, unknown> }>

function recordingLog(): Readonly<{ lines: Line[]; log: ConditionalLogger }> {
  const lines: Line[] = []
  const at =
    (level: string) =>
    (message: string, fields: Record<string, unknown> = {}): void => {
      lines.push({ level, message, fields })
    }
  const log = { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") } as ConditionalLogger
  return { lines, log }
}

async function scratchRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yrd-presubmit-reap-"))
  roots.push(root)
  return root
}

const STALE = new Date(Date.now() - 48 * 60 * 60 * 1000)

/** A pid that has provably exited. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" })
  await child.exited
  return child.pid
}

async function abandoned(root: string, name: string, owner?: number): Promise<string> {
  const entry = join(root, name)
  await mkdir(join(entry, "worktree"), { recursive: true })
  // The record is written when the entry is created, so the owner necessarily
  // precedes it; only the directory mtime is aged, which is the reading the age
  // floor makes and the one a running check cannot refresh.
  if (owner !== undefined) await writeScratchOwner(entry, { pid: owner, startedAtMs: Date.now() })
  await utimes(join(entry, "worktree"), STALE, STALE)
  await utimes(entry, STALE, STALE)
  return entry
}

describe("reapAbandonedPreSubmitCheckouts — the sweep that must never go quiet", () => {
  it("reaps an entry nothing claims, and says so in one line carrying every count", async () => {
    const root = await scratchRoot()
    const entry = await abandoned(root, "check-orphan")
    const { lines, log } = recordingLog()

    await reapAbandonedPreSubmitCheckouts(root, { log })

    expect(existsSync(entry)).toBe(false)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.level).toBe("info")
    expect(lines[0]?.message).toContain("reaped 1 of 1 scanned")
    expect(lines[0]?.fields).toMatchObject({ scanned: 1, reaped: 1, keptLive: 0, keptYoung: 0, failed: 0, unowned: 1 })
  })

  /**
   * The measured failure wore this exact shape: a sweep that kept its whole
   * population reported the same silence as a sweep with nothing to do. The
   * counts are what tell the two apart, so they are emitted either way.
   */
  it("still emits a line when it reaps nothing, so an inert sweep is legible", async () => {
    const root = await scratchRoot()
    await abandoned(root, "check-kept", process.pid)
    const { lines, log } = recordingLog()

    await reapAbandonedPreSubmitCheckouts(root, { log })

    expect(lines).toHaveLength(1)
    expect(lines[0]?.level).toBe("debug")
    expect(lines[0]?.message).toContain("reaped 0 of 1 scanned")
    expect(lines[0]?.fields).toMatchObject({ scanned: 1, reaped: 0, keptLive: 1, running: 1 })
  })

  it("keeps a workspace --keep-on-failure retained, however old and however dead its owner", async () => {
    const root = await scratchRoot()
    const entry = join(root, "check-retained")
    await mkdir(entry, { recursive: true })
    await writeScratchOwner(entry, { pid: await deadPid(), startedAtMs: STALE.getTime(), retained: true })
    await utimes(entry, STALE, STALE)
    const { lines, log } = recordingLog()

    await reapAbandonedPreSubmitCheckouts(root, { log })

    expect(existsSync(entry)).toBe(true)
    expect(lines[0]?.fields).toMatchObject({ reaped: 0, keptLive: 1, retained: 1 })
  })

  it("releases an entry whose recorded owner exited, and keeps the one whose owner runs", async () => {
    const root = await scratchRoot()
    const gone = await abandoned(root, "check-gone", await deadPid())
    const alive = await abandoned(root, "check-alive", process.pid)
    const { lines, log } = recordingLog()

    await reapAbandonedPreSubmitCheckouts(root, { log })

    expect(existsSync(gone)).toBe(false)
    expect(existsSync(alive)).toBe(true)
    expect(lines[0]?.fields).toMatchObject({ scanned: 2, reaped: 1, keptLive: 1, exited: 1, running: 1 })
  })

  /**
   * The old sweep asked git which entries were live and skipped everything when
   * git could not answer. Nothing here asks git anything, so a git that cannot
   * answer cannot stop the sweep — it can only cost the registration cleanup,
   * which says so.
   */
  it("reaps even when every git call fails, and names the prune it could not do", async () => {
    const root = await scratchRoot()
    const entry = await abandoned(root, "check-orphan")
    const { lines, log } = recordingLog()
    const git = { run: async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" }) }

    await reapAbandonedPreSubmitCheckouts(root, { log, git, repo: "/nowhere" })

    expect(existsSync(entry)).toBe(false)
    expect(lines.map((line) => line.level)).toEqual(["info", "warn"])
    expect(lines[1]?.message).toContain("'git worktree prune' failed")
    expect(lines[1]?.message).toContain("registrations remain")
  })

  it("leaves an entry it did not create, and one younger than the floor", async () => {
    const root = await scratchRoot()
    const foreign = join(root, "someone-elses-work")
    await mkdir(foreign, { recursive: true })
    await utimes(foreign, STALE, STALE)
    const young = join(root, "check-young")
    await mkdir(young, { recursive: true })
    const { lines, log } = recordingLog()

    await reapAbandonedPreSubmitCheckouts(root, { log })

    expect(existsSync(foreign)).toBe(true)
    expect(existsSync(young)).toBe(true)
    expect(lines[0]?.fields).toMatchObject({ scanned: 2, reaped: 0, keptYoung: 1, keptForeign: 1 })
  })
})
