/**
 * @failure  The queue log tree grows without bound: the raw round output a round
 *           writes beside its journal — `logs/q-<utc>-<id>/` (git, trace2),
 *           `logs/check/q-<utc>-<id>/`, `logs/environments/<name>/<runId>/` and
 *           the separate `checks/<…>/q-<utc>-<id>/` tree — is read only on
 *           demand and retained forever, with nothing that prunes it (28499).
 * @level    l2 (a hermetic log tree on a real filesystem, real removely removal)
 * @consumer queue operator, host-health (disk and IO pressure)
 * @testonly none
 */
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { safeRemoveSync } from "removely"
import { afterAll, describe, expect, it } from "vitest"
import {
  ROUND_OUTPUT_WINDOW_MS,
  expiredRoundOutput,
  pruneRoundOutput,
  retentionHumanLines,
  retentionObservation,
} from "../src/log-retention.ts"

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date("2026-10-10T12:00:00.000Z")
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY)
/** The name `@yrd/queue-core` mints for a round, reproduced here so a fixture names a round the way the writer does. */
const round = (when: Date): string => `q-${when.toISOString().replace(/[-:.]/gu, "")}-deadbeef`

const roots: string[] = []
afterAll(() => {
  // Each root is scoped to its own parent: the R1 case below deliberately makes one OUTSIDE tmpdir(),
  // which removely's default allowed roots refuse, so the parent is named as the allowed root too.
  for (const root of roots) {
    const parent = realpathSync(dirname(root))
    safeRemoveSync(root, { within: parent, allowedRoots: [parent], allowMissing: true })
  }
})

type Tree = Readonly<{ workdir: string; logs: string; checks: string }>

function tree(label: string): Tree {
  const workdir = mkdtempSync(join(tmpdir(), `yrd-log-retention-${label}-`))
  roots.push(workdir)
  const logs = join(workdir, "logs")
  const checks = join(workdir, "checks")
  mkdirSync(logs, { recursive: true })
  mkdirSync(checks, { recursive: true })
  return { workdir, logs, checks }
}

/** A directory carrying one file, so its removal is a real recursive delete and not an empty-directory special case. */
function place(path: string, rel = "git/1.stdout.bin"): string {
  mkdirSync(join(path, dirname(rel)), { recursive: true })
  writeFileSync(join(path, rel), "x")
  return path
}

describe("expiredRoundOutput (selection, by name only)", () => {
  it("selects every round-output directory older than the window across all four shapes", () => {
    const { logs, checks } = tree("select")
    const oldRound = place(join(logs, round(ago(8))))
    const newRound = place(join(logs, round(ago(1))))
    const oldCheck = place(join(logs, "check", round(ago(9))))
    const oldEnv = place(join(logs, "environments", "fixer-28499", round(ago(10))))
    // An environment NAMED with a round stamp (`<commit12>-q-…`) is not itself a round; only its run child is.
    const namedEnv = place(join(logs, "environments", `abc123def456-${round(ago(20))}`, round(ago(1))))
    const oldChecksFlat = place(join(checks, "fixer", round(ago(8))))
    const oldChecksDeep = place(join(checks, "dev", "8", "26673-thing@20eb", round(ago(8))))

    const found = expiredRoundOutput({ roots: [logs, checks], now: NOW }).entries
    const paths = found.map((entry) => entry.path).sort()
    expect(paths).toEqual([oldRound, oldCheck, oldEnv, oldChecksFlat, oldChecksDeep].sort())
    expect(paths).not.toContain(newRound)
    expect(paths).not.toContain(namedEnv)
    // Containment is per-root: every selection names the root removely must be given.
    for (const entry of found) expect(entry.within === logs || entry.within === checks).toBe(true)
  })

  it("never selects the journals it sits beside, nor a plain file named like a round", () => {
    const { logs } = tree("journals")
    const journal = join(logs, `${round(ago(30))}.jsonl`)
    writeFileSync(journal, "{}\n")
    const fileLikeRound = join(logs, "check", `${round(ago(30))}.jsonl`)
    mkdirSync(join(logs, "check"), { recursive: true })
    writeFileSync(fileLikeRound, "{}\n")

    const found = expiredRoundOutput({ roots: [logs], now: NOW }).entries
    expect(found).toEqual([])
  })

  it("defaults to the seven-day window and honours an explicit one", () => {
    const { logs } = tree("window")
    expect(ROUND_OUTPUT_WINDOW_MS).toBe(7 * DAY)
    place(join(logs, round(ago(5))))
    const fiveDays = expiredRoundOutput({ roots: [logs], now: NOW, windowMs: 3 * DAY }).entries
    expect(fiveDays).toHaveLength(1)
    expect(expiredRoundOutput({ roots: [logs], now: NOW, windowMs: 6 * DAY }).entries).toHaveLength(0)
  })

  it("reports a declared-optional root that is not on disk as a NAMED absence, never a healthy zero (F2)", () => {
    const workdir = mkdtempSync(join(tmpdir(), "yrd-log-retention-empty-"))
    roots.push(workdir)
    const logs = join(workdir, "logs")
    const checks = join(workdir, "checks")
    const scan = expiredRoundOutput({
      roots: [
        { path: logs, optional: true },
        { path: checks, optional: true },
      ],
      now: NOW,
    })
    expect(scan.entries).toEqual([])
    expect(scan.missing).toEqual([logs, checks])
  })

  it("fails LOUDLY when a REQUIRED root does not exist, naming the path it queried (F2)", () => {
    const workdir = mkdtempSync(join(tmpdir(), "yrd-log-retention-required-"))
    roots.push(workdir)
    const logs = join(workdir, "logs")
    expect(() => expiredRoundOutput({ roots: [logs], now: NOW })).toThrow(`required root ${logs} does not exist`)
  })
})

describe("pruneRoundOutput (bounded removal through removely)", () => {
  it("removes at most `limit` directories oldest first and keeps the journals", async () => {
    const { logs } = tree("remove")
    const oldest = place(join(logs, round(ago(30))))
    const middle = place(join(logs, round(ago(20))))
    const next = place(join(logs, round(ago(15))))
    const journal = join(logs, `${round(ago(30))}.jsonl`)
    writeFileSync(journal, "{}\n")

    const first = await pruneRoundOutput({ roots: [logs], now: NOW, limit: 2 })
    expect(first.removed.map((entry) => entry.path)).toEqual([oldest, middle])
    expect(existsSync(oldest)).toBe(false)
    expect(existsSync(middle)).toBe(false)
    expect(existsSync(next)).toBe(true)
    expect(existsSync(journal)).toBe(true)
    expect(first.remaining.map((entry) => entry.path)).toEqual([next])

    const second = await pruneRoundOutput({ roots: [logs], now: NOW, limit: 2 })
    expect(second.removed.map((entry) => entry.path)).toEqual([next])
    expect(second.remaining).toEqual([])
  })

  it("selects but removes nothing on a dry run", async () => {
    const { logs } = tree("dry")
    const oldest = place(join(logs, round(ago(30))))
    const next = place(join(logs, round(ago(20))))

    const result = await pruneRoundOutput({ roots: [logs], now: NOW, limit: 5, dryRun: true })
    expect(result.removed).toEqual([])
    expect(result.remaining.map((entry) => entry.path)).toEqual([oldest, next])
    expect(existsSync(oldest)).toBe(true)
    expect(existsSync(next)).toBe(true)
  })

  it("removes across every root and shape, oldest first", async () => {
    const { logs, checks } = tree("across")
    const oldRound = place(join(logs, round(ago(9))))
    const oldCheck = place(join(logs, "check", round(ago(8))))
    const oldEnv = place(join(logs, "environments", "seat", round(ago(30))))
    const oldChecks = place(join(checks, "fixer", round(ago(10))))

    const result = await pruneRoundOutput({ roots: [logs, checks], now: NOW, limit: 10 })
    expect(result.removed.map((entry) => entry.path)).toEqual([oldEnv, oldChecks, oldRound, oldCheck])
    for (const path of [oldRound, oldCheck, oldEnv, oldChecks]) expect(existsSync(path)).toBe(false)
  })
})

describe("retentionHumanLines (the operator's rendering)", () => {
  it("promises and prints the list, and a dry run names the paths it would remove", () => {
    const selected = [
      { path: "/x/logs/q-a", name: "q-a", within: "/x/logs", started: ago(30) },
      { path: "/x/logs/q-b", name: "q-b", within: "/x/logs", started: ago(20) },
    ]
    const lines = retentionHumanLines(
      { windowMs: ROUND_OUTPUT_WINDOW_MS, removed: [], remaining: selected, missing: [] },
      { roots: ["/x/logs", "/x/checks"], dryRun: true, listed: selected },
    )
    expect(lines[0]).toContain("would remove 2 round-output directories older than 7 days")
    expect(lines[1]).toContain("searched /x/logs, /x/checks")
    expect(lines.slice(2)).toEqual(["/x/logs/q-a", "/x/logs/q-b"])
  })

  it("names the roots it searched even when nothing is over the window", () => {
    const lines = retentionHumanLines(
      { windowMs: ROUND_OUTPUT_WINDOW_MS, removed: [], remaining: [], missing: [] },
      { roots: ["/x/logs", "/x/checks"], dryRun: false, listed: [] },
    )
    expect(lines[0]).toContain("removed 0 round-output directories older than 7 days")
    expect(lines[1]).toContain("searched /x/logs, /x/checks")
    expect(lines).toHaveLength(2)
  })
})

/**
 * A scratch root OUTSIDE `tmpdir()`, which is the whole point of the R1 case:
 * removely's DEFAULT `allowedRoots` is [tmpdir()], so a fixture under mkdtemp()
 * proves nothing about the real /hh/var/yrd-workdir tree. `homedir()` is NOT
 * reliably outside it — the Vitest home guard pins HOME to `<run root>/home`,
 * i.e. INSIDE tmpdir(), measured 2026-10-10 — so prefer tmpdir()'s own parent,
 * outside by construction, and fall back to homedir() where that parent is not
 * writable (a bare `vitest` run, where tmpdir() is `/tmp`).
 */
function scratchOutsideTmpdir(): string {
  const tmp = resolve(tmpdir())
  const candidates = [dirname(tmp), homedir()].filter((candidate) => {
    const parent = resolve(candidate)
    return parent !== tmp && !parent.startsWith(`${tmp}${sep}`)
  })
  const refused: string[] = []
  for (const parent of candidates) {
    try {
      accessSync(parent, constants.W_OK)
      return mkdtempSync(join(parent, ".yrd-log-retention-selftest-"))
    } catch {
      // silent-fallback-allow: a directory this process cannot write is not the
      // fixture's host, so the next candidate must carry it; the throw below
      // names every host refused rather than leaving a bare empty result.
      refused.push(parent)
    }
  }
  throw new Error(
    `log retention fixture: no writable root outside ${tmp} to host the R1 case; refused ${refused.join(", ")}`,
  )
}

describe("retention against a root OUTSIDE tmpdir (R1: allowedRoots)", () => {
  it("removes a real queue-style root that removely's default allowed roots would refuse", async () => {
    // Guard the test's own premise, then remove.
    const scratch = scratchOutsideTmpdir()
    roots.push(scratch)
    const logs = join(scratch, "logs")
    mkdirSync(logs, { recursive: true })
    expect(resolve(logs).startsWith(resolve(tmpdir()))).toBe(false)

    const old = place(join(logs, round(ago(30))))
    const result = await pruneRoundOutput({ roots: [logs], now: NOW, limit: 5 })
    expect(result.removed.map((entry) => entry.path)).toEqual([old])
    expect(existsSync(old)).toBe(false)
  })
})

describe("an absent optional root is named in the row, never a healthy zero (F2)", () => {
  it("names the absent optional root in the observation row the prune writes", () => {
    const missing = "/x/checks"
    const observation = retentionObservation(
      { windowMs: ROUND_OUTPUT_WINDOW_MS, removed: [], remaining: [], missing: [missing] },
      { at: NOW },
    )
    expect(observation.kind).toBe("observation")
    expect(observation.removed).toBe(0)
    expect(observation.missing).toEqual([missing])
  })

  it("names an absent optional root in the human rendering", () => {
    const lines = retentionHumanLines(
      { windowMs: ROUND_OUTPUT_WINDOW_MS, removed: [], remaining: [], missing: ["/x/checks"] },
      { roots: ["/x/logs", "/x/checks"], dryRun: true, listed: [] },
    )
    expect(lines.join("\n")).toContain("no such optional root (absent, not an error): /x/checks")
  })
})
