/**
 * @failure  The queue log tree grows without bound: the raw round output a round
 *           writes beside its journal — `logs/q-<utc>-<id>/` (git, trace2),
 *           `logs/check/q-<utc>-<id>/`, `logs/environments/<name>/<runId>/` and
 *           the separate `checks/<…>/q-<utc>-<id>/` tree — is read only on
 *           demand and retained forever, with nothing that prunes it (28499);
 *           and what IS kept — round output inside the window, every journal —
 *           stays plain, so the kept history alone fills the disk (34923).
 * @level    l2 (a hermetic log tree on a real filesystem, real removely removal)
 * @consumer queue operator, host-health (disk and IO pressure)
 * @testonly none
 * @reach    fs-walk <fixture-only: mkdtempSync scratch queue workdirs with logs/ and checks/ round-output trees>
 */
import {
  accessSync,
  appendFileSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { gzipSync } from "node:zlib"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { safeRemoveSync } from "removely"
import { afterAll, describe, expect, it, vi } from "vitest"
import { journalKey, openLog, readJournalProjection, readJournals, readRetainedFile, readRunLog } from "@yrd/queue-core"
import { readCommandOutput } from "../src/queue-core-commands.ts"
import {
  JOURNAL_UNIT_SHARE,
  NEWEST_LANE_UNITS,
  RETENTION_JOURNAL,
  RETENTION_JOURNAL_MAX_BYTES,
  ROUND_COMPRESSION_BYTES,
  ROUND_COMPRESSION_FILES,
  ROUND_COMPRESSION_SLOW_MS,
  ROUND_COMPRESSION_UNITS,
  ROUND_OUTPUT_WINDOW_MS,
  RETENTION_JUDGED_SPACING_MS,
  ROUND_REMOVAL_BATCH,
  appendRetentionObservation,
  holdsJudgeCommand,
  type HoldsCandidate,
  type HoldsJudge,
  compressionVisitOrder,
  expiredRoundOutput,
  pruneRoundOutput,
  removeExpiredRoundOutput,
  retentionHumanLines,
  retentionObservation,
  retentionRowWorthWriting,
  sweepRoundOutputInRound,
} from "../src/log-retention.ts"

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date("2026-10-10T12:00:00.000Z")
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY)
/** The name `@yrd/queue-core` mints for a round, reproduced here so a fixture names a round the way the writer does. */
const round = (when: Date): string => `q-${when.toISOString().replace(/[-:.]/gu, "")}-deadbeef`

/**
 * 34923: a removal the test chooses fails, so the sweep's own "remove the plain
 * file" step can be made to fail AFTER its archive is installed. Every other
 * removal is the real removely.
 */
const removalFault = vi.hoisted(() => ({ path: undefined as string | undefined }))
vi.mock("removely", async (importOriginal) => {
  const real = await importOriginal<typeof import("removely")>()
  return {
    ...real,
    safeRemove: async (target: string, options: Parameters<typeof real.safeRemove>[1]): Promise<void> => {
      if (target === removalFault.path) throw new Error(`injected removal failure for ${target}`)
      return real.safeRemove(target, options)
    },
  }
})

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
    const oldRound = place(join(logs, round(ago(15))))
    const newRound = place(join(logs, round(ago(1))))
    const oldCheck = place(join(logs, "check", round(ago(16))))
    const oldEnv = place(join(logs, "environments", "fixer-28499", round(ago(17))))
    // An old `<commit12>-q-…` parent that still holds a round inside the window is named, not removed.
    const namedParent = join(logs, "environments", `abc123def456-${round(ago(20))}`)
    const namedEnv = place(join(namedParent, round(ago(1))))
    const oldChecksFlat = place(join(checks, "fixer", round(ago(15))))
    const oldChecksDeep = place(join(checks, "dev", "8", "26673-thing@20eb", round(ago(15))))

    const scan = expiredRoundOutput({ roots: [logs, checks], now: NOW })
    const paths = scan.entries.map((entry) => entry.path).sort()
    expect(paths).toEqual([oldRound, oldCheck, oldEnv, oldChecksFlat, oldChecksDeep].sort())
    expect(paths).not.toContain(newRound)
    expect(paths).not.toContain(namedParent)
    expect(paths).not.toContain(namedEnv)
    expect(scan.withheld).toEqual([namedParent])
    // Containment is per-root: every selection names the root removely must be given.
    for (const entry of scan.entries) expect(entry.within === logs || entry.within === checks).toBe(true)
  })

  /**
   * @failure An empty logs/environments/<env> directory older than the window stays forever, so prune reports selected 0.
   * @level l2
   * @consumer yrd logs prune
   */
  it("selects an empty environment directory older than the window and leaves a young one", () => {
    const { logs } = tree("env-empty-old")
    const oldDir = join(logs, "environments", "fixer-28499")
    mkdirSync(oldDir, { recursive: true })
    utimesSync(oldDir, ago(19), ago(19))
    const youngDir = join(logs, "environments", "fixer-young")
    mkdirSync(youngDir, { recursive: true })
    utimesSync(youngDir, ago(1), ago(1))
    const held = join(logs, "environments", "fixer-held")
    place(join(held, round(ago(1))))
    utimesSync(held, ago(19), ago(19))
    const found = expiredRoundOutput({ roots: [logs], now: NOW }).entries.map((entry) => entry.path)
    expect(found).toEqual([oldDir])
  })

  /**
   * @failure An old plain container holding an old round is removed as one unit, taking the round with it.
   * @level l2
   * @consumer yrd logs prune
   */
  it("keeps an old plain container that holds an old round and selects the round", () => {
    const { logs } = tree("env-old-round")
    const parent = join(logs, "environments", "fixer-28499")
    const child = place(join(parent, round(ago(19))))
    utimesSync(parent, ago(19), ago(19))
    const found = expiredRoundOutput({ roots: [logs], now: NOW }).entries.map((entry) => entry.path)
    expect(found).toEqual([child])
  })

  /**
   * @failure An environment directory named <commit>-q-<utc>-<id> is older than the window and prune reports selected 0.
   * @level l2
   * @consumer yrd logs prune
   */
  it("selects an old environment directory named <commit>-q-<utc>-<id> with no round child", () => {
    const { logs } = tree("env-stamp")
    const envDir = place(join(logs, "environments", `0010d72a646a-${round(ago(19))}`), "setup.log")
    const found = expiredRoundOutput({ roots: [logs], now: NOW }).entries
    expect(found.map((entry) => entry.path)).toEqual([envDir])
    expect(found[0]?.started.toISOString()).toBe(ago(19).toISOString())
  })

  it("selects an old stamped environment once every round inside it is past the window", () => {
    const { logs } = tree("env-old-children")
    const parent = join(logs, "environments", `0010d72a646a-${round(ago(20))}`)
    const child = place(join(parent, round(ago(19))))
    const scan = expiredRoundOutput({ roots: [logs], now: NOW })
    expect(scan.entries.map((entry) => entry.path)).toEqual([parent])
    expect(scan.entries.map((entry) => entry.path)).not.toContain(child)
    expect(scan.withheld).toEqual([])
  })

  it("names a q- round whose stamp cannot be read and does not select it", () => {
    const { checks } = tree("q-round-unreadable")
    const broken = join(checks, "fixer", "26673-thing@20eb", "q-2027-new-format")
    place(broken, "setup.log")
    const scan = expiredRoundOutput({ roots: [checks], now: NOW })
    expect(scan.entries).toEqual([])
    expect(scan.unreadable).toEqual([broken])
  })

  it("names a directory whose q- stamp cannot be read and does not select it", () => {
    const { logs } = tree("unreadable")
    const broken = join(logs, "environments", "0010d72a646a-q-2026not-a-stamp")
    place(broken, "setup.log")
    const bay = join(logs, "environments", "topic-q-1-not-a-stamp")
    const oldChild = place(join(bay, round(ago(19))))
    const scan = expiredRoundOutput({ roots: [logs], now: NOW })
    expect(scan.entries.map((entry) => entry.path)).toEqual([oldChild])
    expect(scan.unreadable).toEqual([broken])
    expect(scan.withheld).toEqual([])
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

  it("defaults to the two-day window and honours an explicit one", () => {
    const { logs } = tree("window")
    expect(ROUND_OUTPUT_WINDOW_MS).toBe(2 * DAY)
    place(join(logs, round(ago(5))))
    // The default is the window production runs, so the five-day round is past it without being named.
    expect(expiredRoundOutput({ roots: [logs], now: NOW }).entries).toHaveLength(1)
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
  it("removes at most `limit` directories oldest first and keeps journals with usable projections", async () => {
    const { logs } = tree("remove")
    // The new projection shares the journal's lifetime, not the pruned output's.
    // Existing coverage kept only a dummy journal and could not detect loss of
    // the persisted reader facts or accidental inclusion in the run census.
    const log = openLog(logs, () => ago(30))
    log.write({ kind: "run", target: "main", queue: "main" })
    log.write({ kind: "change", branch: "task/retained", head: "abc123", decision: "failed" })
    log.finish()
    const oldest = place(join(logs, log.id))
    const middle = place(join(logs, round(ago(20))))
    const next = place(join(logs, round(ago(15))))
    const journal = log.path
    const projection = journal.replace(/\.jsonl$/u, ".projection.json")

    const first = await pruneRoundOutput({ roots: [logs], now: NOW, limit: 2 })
    expect(first.removed.map((entry) => entry.path)).toEqual([oldest, middle])
    expect(existsSync(oldest)).toBe(false)
    expect(existsSync(middle)).toBe(false)
    expect(existsSync(next)).toBe(true)
    expect(existsSync(journal)).toBe(true)
    expect(existsSync(projection)).toBe(true)
    const reading = readJournals(logs, { now: ago(30) })
    expect(reading.fallbacks).toBeUndefined()
    expect([...reading.runs.values()].flat()).toHaveLength(1)
    expect(reading.runs.get(journalKey("task/retained", "abc123"))).toMatchObject([{ decision: "failed" }])
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
    const oldRound = place(join(logs, round(ago(16))))
    const oldCheck = place(join(logs, "check", round(ago(15))))
    const oldEnv = place(join(logs, "environments", "seat", round(ago(30))))
    const oldChecks = place(join(checks, "fixer", round(ago(17))))

    const result = await pruneRoundOutput({ roots: [logs, checks], now: NOW, limit: 10 })
    expect(result.removed.map((entry) => entry.path)).toEqual([oldEnv, oldChecks, oldRound, oldCheck])
    for (const path of [oldRound, oldCheck, oldEnv, oldChecks]) expect(existsSync(path)).toBe(false)
  })

  // 28836: the budget counts successful removals, not attempts. An unremovable oldest entry must not fill the
  // prefix, or every pass re-selects it and the removable directory behind it is never reached.
  it("passes over an unremovable oldest entry and still removes a younger one in one pass", async () => {
    const { logs } = tree("stuck-head")
    const stuck = place(join(logs, round(ago(60))))
    const removable = place(join(logs, round(ago(50))))
    chmodSync(stuck, 0o500)
    try {
      const result = await pruneRoundOutput({ roots: [logs], now: NOW, limit: 1 })
      expect(result.removed.map((entry) => entry.path)).toEqual([removable])
      expect(result.failures.map((failure) => failure.path)).toEqual([stuck])
      expect(existsSync(removable)).toBe(false)
      expect(existsSync(stuck)).toBe(true)
    } finally {
      chmodSync(stuck, 0o700)
    }
  })

  // 28836: when every candidate fails the pass still ends, and the failure row stays bounded to `limit` with the
  // count of the rest, so a long stuck prefix cannot grow the observation row.
  it("bounds the failure row to `limit` and counts the rest when every candidate fails", async () => {
    const { logs } = tree("all-fail")
    const stuck = [
      place(join(logs, round(ago(60)))),
      place(join(logs, round(ago(59)))),
      place(join(logs, round(ago(58)))),
    ]
    chmodSync(logs, 0o500)
    try {
      const result = await pruneRoundOutput({ roots: [logs], now: NOW, limit: 2 })
      expect(result.removed).toEqual([])
      expect(result.failures.map((failure) => failure.path)).toEqual([stuck[0], stuck[1]])
      expect(result.failuresOmitted).toBe(1)
      for (const path of stuck) expect(existsSync(path)).toBe(true)
    } finally {
      chmodSync(logs, 0o700)
    }
  })
})

describe("retentionHumanLines (the operator's rendering)", () => {
  it("promises and prints the list, and a dry run names the paths it would remove", () => {
    const selected = [
      { path: "/x/logs/q-a", name: "q-a", within: "/x/logs", started: ago(30) },
      { path: "/x/logs/q-b", name: "q-b", within: "/x/logs", started: ago(20) },
    ]
    const lines = retentionHumanLines(
      {
        windowMs: ROUND_OUTPUT_WINDOW_MS,
        removed: [],
        failures: [],
        failuresOmitted: 0,
        remaining: selected,
        missing: [],
      },
      { roots: ["/x/logs", "/x/checks"], dryRun: true, listed: selected },
    )
    expect(lines[0]).toContain("would remove 2 round-output directories older than 2 days")
    expect(lines[1]).toContain("searched /x/logs, /x/checks")
    expect(lines.slice(2)).toEqual(["/x/logs/q-a", "/x/logs/q-b"])
  })

  it("names the roots it searched even when nothing is over the window", () => {
    const lines = retentionHumanLines(
      { windowMs: ROUND_OUTPUT_WINDOW_MS, removed: [], failures: [], failuresOmitted: 0, remaining: [], missing: [] },
      { roots: ["/x/logs", "/x/checks"], dryRun: false, listed: [] },
    )
    expect(lines[0]).toContain("removed 0 round-output directories older than 2 days")
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

describe("a withheld environment is counted in the row, never a silent remaining 0 (#37419)", () => {
  it("names how many expired rounds a young round's environment withheld, with a bounded sample", () => {
    const withheld = Array.from({ length: 10 }, (_, index) => `/x/logs/environments/env-${index}`)
    const observation = retentionObservation(
      {
        windowMs: ROUND_OUTPUT_WINDOW_MS,
        removed: [],
        failures: [],
        failuresOmitted: 0,
        remaining: [],
        missing: [],
        withheld,
      },
      { at: NOW },
    )
    expect(observation.remaining).toBe(0)
    expect(observation.withheld).toBe(10)
    expect(observation.withheldSample).toEqual(withheld.slice(0, 8))
  })

  it("carries withheld from the round sweep into the row it writes", async () => {
    const { workdir, logs } = tree("withheld-round")
    // The removal makes the row worth writing; the young round keeps its old environment whole.
    place(join(logs, round(ago(30))))
    const env = join(logs, "environments", `abc123def456-${round(ago(20))}`)
    place(join(env, round(ago(1))))
    await sweepRoundOutputInRound({ workdir, now: NOW, report: () => {} })
    const rows = readFileSync(join(workdir, RETENTION_JOURNAL), "utf8").trim().split("\n")
    const row = JSON.parse(rows.at(-1) ?? "{}") as Record<string, unknown>
    expect(row.withheld).toBe(1)
    expect(row.withheldSample).toEqual([env])
  })

  it("writes no withheld fields when nothing was withheld", () => {
    const observation = retentionObservation(
      { windowMs: ROUND_OUTPUT_WINDOW_MS, removed: [], failures: [], failuresOmitted: 0, remaining: [], missing: [] },
      { at: NOW },
    )
    expect("withheld" in observation).toBe(false)
    expect("withheldSample" in observation).toBe(false)
  })
})

describe("an absent optional root is named in the row, never a healthy zero (F2)", () => {
  it("names the absent optional root in the observation row the prune writes", () => {
    const missing = "/x/checks"
    const observation = retentionObservation(
      {
        windowMs: ROUND_OUTPUT_WINDOW_MS,
        removed: [],
        failures: [],
        failuresOmitted: 0,
        remaining: [],
        missing: [missing],
      },
      { at: NOW },
    )
    expect(observation.kind).toBe("observation")
    expect(observation.removed).toBe(0)
    expect(observation.missing).toEqual([missing])
  })

  it("writes NO row when an absent optional root is the round's only fact (@cto 2026-10-10T23:30Z)", () => {
    const { workdir } = tree("absent-only")
    const wrote = appendRetentionObservation(
      workdir,
      {
        windowMs: ROUND_OUTPUT_WINDOW_MS,
        removed: [],
        failures: [],
        failuresOmitted: 0,
        remaining: [],
        missing: ["/x/checks"],
      },
      NOW,
    )
    expect(wrote).toBe(false)
    expect(existsSync(join(workdir, RETENTION_JOURNAL))).toBe(false)
  })

  it("still names the absent optional root in a row it DOES write, for a round that removed something", () => {
    const { workdir, logs } = tree("absent-plus-removal")
    const removed = [{ path: join(logs, round(ago(30))), name: round(ago(30)), within: logs, started: ago(30) }]
    const wrote = appendRetentionObservation(
      workdir,
      {
        windowMs: ROUND_OUTPUT_WINDOW_MS,
        removed,
        failures: [],
        failuresOmitted: 0,
        remaining: [],
        missing: ["/x/checks"],
      },
      NOW,
    )
    expect(wrote).toBe(true)
    const rows = readFileSync(join(workdir, RETENTION_JOURNAL), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ removed: 1, missing: ["/x/checks"] })
  })

  it("names an absent optional root in the human rendering", () => {
    const lines = retentionHumanLines(
      {
        windowMs: ROUND_OUTPUT_WINDOW_MS,
        removed: [],
        failures: [],
        failuresOmitted: 0,
        remaining: [],
        missing: ["/x/checks"],
      },
      { roots: ["/x/logs", "/x/checks"], dryRun: true, listed: [] },
    )
    expect(lines.join("\n")).toContain("no such optional root (absent, not an error): /x/checks")
  })
})

describe("sweepRoundOutputInRound (the round hook)", () => {
  it("removes at most one ROUND_REMOVAL_BATCH per round, oldest first, and records one observation row", async () => {
    const { workdir, logs } = tree("round-bound")
    // Ten expired rounds, listed oldest first: ago(24) is the oldest.
    const oldestFirst = [24, 23, 22, 21, 20, 19, 18, 17, 16, 15].map((days) => place(join(logs, round(ago(days)))))
    const first = await sweepRoundOutputInRound({ workdir, now: NOW })
    // The round takes a BOUNDED batch, not the whole backlog: removal is the
    // oldest prefix, so the newest rounds survive for a later round.
    expect(first?.removed).toHaveLength(ROUND_REMOVAL_BATCH)
    expect(first?.remaining).toHaveLength(oldestFirst.length - ROUND_REMOVAL_BATCH)
    for (const removed of oldestFirst.slice(0, ROUND_REMOVAL_BATCH)) expect(existsSync(removed)).toBe(false)
    for (const kept of oldestFirst.slice(ROUND_REMOVAL_BATCH)) expect(existsSync(kept)).toBe(true)
    // Exactly one row, beside the journals, naming what is STILL older than the window.
    const rows = readFileSync(join(workdir, RETENTION_JOURNAL), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: "observation",
      scope: "log-retention",
      removed: ROUND_REMOVAL_BATCH,
      remaining: oldestFirst.length - ROUND_REMOVAL_BATCH,
    })
    expect(rows[0]?.oldest).toBe(round(ago(16)))
    // A second round makes progress on the rest, still within its bound.
    const second = await sweepRoundOutputInRound({ workdir, now: NOW })
    expect(second?.removed).toHaveLength(oldestFirst.length - ROUND_REMOVAL_BATCH)
    expect(second?.remaining).toHaveLength(0)
  })

  it("never touches the journals it sits beside, and writes its row at the workdir root, not in the log tree", async () => {
    const { workdir, logs } = tree("round-journals")
    const journal = join(logs, `${round(ago(30))}.jsonl`)
    writeFileSync(journal, `{"kind":"run"}\n`)
    place(join(logs, round(ago(30))))
    await sweepRoundOutputInRound({ workdir, now: NOW })
    // The expired round DIRECTORY goes; its journal does not.
    expect(existsSync(join(logs, round(ago(30))))).toBe(false)
    expect(readFileSync(journal, "utf8")).toBe(`{"kind":"run"}\n`)
    expect(existsSync(join(workdir, RETENTION_JOURNAL))).toBe(true)
    // A run-journal name inside logs/ would make the runner's header read refuse the newest journal.
    expect(existsSync(join(logs, RETENTION_JOURNAL))).toBe(false)
  })

  it("keeps the round alive across three rounds when one directory cannot be removed, and removes the rest", async () => {
    const { workdir, logs, checks } = tree("round-stuck")
    // A read-only `logs` refuses the removal of its own child; `checks` still drains.
    const stuck = place(join(logs, round(ago(60))))
    const removable = place(join(checks, "fixer", round(ago(60))))
    chmodSync(logs, 0o500)
    const lines: string[] = []
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        // The round RETURNS every time — the process never exits into Hab's
        // restart budget over one directory (@cto 2026-10-10T23:16Z).
        const result = await sweepRoundOutputInRound({ workdir, now: NOW, report: (line) => lines.push(line) })
        expect(result, `round ${String(attempt)} must return, never throw`).toBeDefined()
        expect(result?.failures.map((failure) => failure.path)).toEqual([stuck])
        expect(existsSync(stuck)).toBe(true)
      }
    } finally {
      chmodSync(logs, 0o700)
    }
    expect(existsSync(removable)).toBe(false)
    expect(lines).toHaveLength(3)
    for (const line of lines) {
      expect(line).toContain(stuck)
      expect(line).toContain("the next round retries")
    }
    const rows = readFileSync(join(workdir, RETENTION_JOURNAL), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(rows).toHaveLength(3)
    for (const row of rows) expect(JSON.stringify(row.failures)).toContain(stuck)
  })

  it("reports a sweep that cannot RUN — a missing required root — as a failure, never a throw", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "yrd-log-retention-round-noroot-"))
    roots.push(workdir)
    const lines: string[] = []
    const result = await sweepRoundOutputInRound({ workdir, now: NOW, report: (line) => lines.push(line) })
    expect(result).toBeUndefined()
    expect(lines.join("")).toContain(`required root ${join(workdir, "logs")} does not exist`)
    expect(lines.join("")).toContain("the service retries at its next round")
    const rows = readFileSync(join(workdir, RETENTION_JOURNAL), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: "observation", scope: "log-retention", removed: 0, remaining: 0 })
    expect(String(rows[0]?.error)).toContain("required root")
  })
})

describe("a removal failure is a result, never an exception (28499, @cto 2026-10-10T23:16Z)", () => {
  it("continues past an entry that fails, reports it, and keeps it in remaining", async () => {
    const { logs } = tree("batch-fail")
    // A round selected by name that is already gone: the race with a concurrent
    // `yrd logs prune` that removely refuses with "target does not exist".
    const gone = join(logs, round(ago(30)))
    const oldest = place(join(logs, round(ago(29))))
    const next = place(join(logs, round(ago(28))))
    const result = await removeExpiredRoundOutput({
      selected: [
        { path: gone, name: round(ago(30)), within: logs, started: ago(30) },
        { path: oldest, name: round(ago(29)), within: logs, started: ago(29) },
        { path: next, name: round(ago(28)), within: logs, started: ago(28) },
      ],
    })
    // The batch finishes: a failure in the middle never blocks the drain.
    expect(result.removed.map((entry) => entry.path)).toEqual([oldest, next])
    expect(result.failures.map((failure) => failure.path)).toEqual([gone])
    expect(result.failures[0]?.error).toContain("does not exist")
    // The failed entry stays visible, so the next round retries it.
    expect(result.remaining.map((entry) => entry.path)).toEqual([gone])
    expect(existsSync(oldest)).toBe(false)
    expect(existsSync(next)).toBe(false)
  })
})

describe("retention.jsonl is bounded (28499, @cto 2026-10-10T23:16Z)", () => {
  it("writes no row for a round with nothing to say", async () => {
    const { workdir } = tree("round-quiet")
    const result = await sweepRoundOutputInRound({ workdir, now: NOW, report: () => {} })
    expect(result?.removed).toEqual([])
    expect(result?.failures).toEqual([])
    expect(existsSync(join(workdir, RETENTION_JOURNAL))).toBe(false)
    expect(
      retentionRowWorthWriting({
        windowMs: ROUND_OUTPUT_WINDOW_MS,
        removed: [],
        failures: [],
        failuresOmitted: 0,
        remaining: [],
        missing: [],
      }),
    ).toBe(false)
  })

  it("rotates at the bound, leaving exactly two files with the new rows in the fresh one", () => {
    const { workdir, logs } = tree("round-rotate")
    const file = join(workdir, RETENTION_JOURNAL)
    writeFileSync(file, "x".repeat(RETENTION_JOURNAL_MAX_BYTES))
    const removed = [{ path: join(logs, round(ago(30))), name: round(ago(30)), within: logs, started: ago(30) }]
    const wrote = appendRetentionObservation(
      workdir,
      { windowMs: ROUND_OUTPUT_WINDOW_MS, removed, failures: [], failuresOmitted: 0, remaining: [], missing: [] },
      NOW,
    )
    expect(wrote).toBe(true)
    expect(
      readdirSync(workdir)
        .filter((name) => name.startsWith(RETENTION_JOURNAL))
        .sort(),
    ).toEqual([RETENTION_JOURNAL, `${RETENTION_JOURNAL}.1`])
    expect(readFileSync(`${file}.1`, "utf8")).toHaveLength(RETENTION_JOURNAL_MAX_BYTES)
    const rows = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: "observation", scope: "log-retention", removed: 1 })
  })
})

// ---------------------------------------------------------------------------
// 34923 slice 2: the same round sweep gzip-compresses what it keeps.
// ---------------------------------------------------------------------------

/** Text big enough to be worth compressing (more than one 4 KiB block), distinct per label. */
const body = (label: string, lines = 2000): string =>
  `${Array.from({ length: lines }, (_, index) => `${label} line ${String(index)}`).join("\n")}\n`

/** A round whose writer FINISHED: header, a change, padding past one block, and the projection `finish()` publishes. */
function finishedRound(dir: string, when: Date): ReturnType<typeof openLog> {
  const log = openLog(dir, () => when)
  log.write({ kind: "run", target: "main", queue: "main" })
  log.write({ kind: "change", branch: "task/kept", head: "abc123", decision: "failed" })
  for (let index = 0; index < 60; index++) log.write({ kind: "warning", subject: "pad", reason: "x".repeat(80) })
  log.finish()
  return log
}

/** A round with no projection: only its header, naming `pid` when given. */
function unfinishedRound(dir: string, when: Date, pid?: number): ReturnType<typeof openLog> {
  const log = openLog(dir, () => when)
  log.write({ kind: "run", target: "main", queue: "main", ...(pid === undefined ? {} : { pid }) })
  for (let index = 0; index < 60; index++) log.write({ kind: "warning", subject: "pad", reason: "x".repeat(80) })
  return log
}

function output(path: string, text: string | Buffer): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

/** A pid that existed and is gone: a child that has already exited. */
function exitedPid(): number {
  const child = spawnSync("true")
  if (child.pid === undefined || child.pid <= 0) throw new Error("fixture: could not spawn a child to learn a dead pid")
  return child.pid
}

function retentionRows(workdir: string): Record<string, unknown>[] {
  return readFileSync(join(workdir, RETENTION_JOURNAL), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function gone(path: string): void {
  expect(existsSync(path), `${path} should be converted`).toBe(false)
  expect(existsSync(`${path}.gz`), `${path}.gz should be installed`).toBe(true)
}

function plain(path: string): void {
  expect(existsSync(path), `${path} should stay plain`).toBe(true)
  expect(existsSync(`${path}.gz`), `${path} should not be compressed`).toBe(false)
}

const skipReasons = (result: Awaited<ReturnType<typeof sweepRoundOutputInRound>>): string[] =>
  (result?.compression?.skipped ?? []).map((skip) => `${skip.path}: ${skip.reason}`)

describe("the round sweep gzips finished round output past 24 hours (34923 ruling 2, 3)", () => {
  it("converts a finished round's raw output and check logs; every reader returns the same text", async () => {
    const { workdir, logs, checks } = tree("gz-raw")
    const log = finishedRound(logs, ago(1.5))
    const live = finishedRound(logs, ago(0.5))
    const git = join(logs, log.id, "git")
    const stdout = output(join(git, "1.stdout.bin"), body("out"))
    const stderr = output(join(git, "1.stderr.bin"), `\u001b[31m${body("err")}\u001b[0m`)
    // Metadata, trace2, a sub-block file and anything unknown stay plain.
    const metadata = output(join(git, "1.stdout.bin.json"), `{"padding":"${"y".repeat(5000)}"}\n`)
    const tiny = output(join(git, "2.stdout.bin"), "small\n")
    const trace = output(join(logs, log.id, "trace2", "1.trace2"), body("trace"))
    const unknown = output(join(git, "1.stdout.bin.link-123"), body("unknown"))
    // A queue round's check log, as event-run.ts writes it: checks/<branch>@<head>/<run>/attempt-N/<phase>/<name>.log.
    const checkLog = output(join(checks, "task", "kept@abc123", log.id, "attempt-1", "merge", "unit.log"), body("unit"))
    // The live round: younger than 24 hours, and the newest journal.
    const young = output(join(logs, live.id, "git", "1.stdout.bin"), body("young"))
    const projection = log.path.replace(/\.jsonl$/u, ".projection.json")

    const command = { args: ["log"], cwd: workdir, stdout, stderr }
    const before = {
      command: readCommandOutput(command),
      check: readRetainedFile(checkLog).toString("utf8"),
      journal: readRunLog(logs, log.id),
    }
    expect(before.command.text).toContain("out line 1999")

    const result = await sweepRoundOutputInRound({ workdir, now: NOW, report: () => {} })
    expect(result?.compression).toMatchObject({ compressed: 3, deferred: 0, failures: [] })
    for (const path of [stdout, stderr, checkLog]) gone(path)
    for (const path of [metadata, tiny, trace, unknown, young, log.path, projection]) plain(path)

    // Same text through every reader: the command pane, the check pane's one read, the journal.
    expect(readCommandOutput(command)).toEqual(before.command)
    expect(readRetainedFile(checkLog).toString("utf8")).toBe(before.check)
    expect(readRunLog(logs, log.id)).toEqual(before.journal)
    expect(readFileSync(`${stdout}.gz`).length).toBeLessThan(Buffer.byteLength(body("out")))

    const row = retentionRows(workdir)
    expect(row).toHaveLength(1)
    const compression = row[0]?.compression as { compressed: number; bytesIn: number; bytesOut: number }
    expect(compression).toMatchObject({ compressed: 3 })
    expect(compression.bytesIn).toBe(
      Buffer.byteLength(body("out")) +
        Buffer.byteLength(`\u001b[31m${body("err")}\u001b[0m`) +
        Buffer.byteLength(body("unit")),
    )
    expect(compression.bytesOut).toBeGreaterThan(0)
    expect(compression.bytesOut).toBeLessThan(compression.bytesIn)
  })

  it("proves a round with no projection finished when its header's writer pid is gone", async () => {
    const { workdir, logs } = tree("gz-pid-gone")
    const log = unfinishedRound(logs, ago(1.5), exitedPid())
    finishedRound(logs, ago(0.5))
    const stdout = output(join(logs, log.id, "git", "1.stdout.bin"), body("dead"))
    const result = await sweepRoundOutputInRound({ workdir, now: NOW, report: () => {} })
    expect(result?.compression?.compressed).toBe(1)
    gone(stdout)
  })

  it("leaves the live, unproven and symlinked candidates untouched and names each one", async () => {
    const { workdir, logs, checks } = tree("gz-unproven")
    // Every candidate sits past the 24-hour compression line and inside the two-day window (hh 38654); older ones
    // would be expired before the sweep reached the question this test asks.
    const otherWriter = unfinishedRound(logs, ago(1.9), process.ppid)
    const ownWriter = unfinishedRound(logs, ago(1.85), process.pid)
    const noPid = unfinishedRound(logs, ago(1.8))
    const linked = finishedRound(logs, ago(1.75))
    // The newest round journal is the live round, however old it reads.
    const newest = finishedRound(logs, ago(1.5))
    const paths = {
      otherWriter: output(join(logs, otherWriter.id, "git", "1.stdout.bin"), body("a")),
      ownWriter: output(join(logs, ownWriter.id, "git", "1.stdout.bin"), body("b")),
      noPid: output(join(logs, noPid.id, "git", "1.stdout.bin"), body("c")),
      linked: join(logs, linked.id, "git", "1.stdout.bin"),
      orphan: output(join(checks, "fix", "y@def456", round(ago(1.7)), "attempt-1", "merge", "unit.log"), body("d")),
      newest: output(join(logs, newest.id, "git", "1.stdout.bin"), body("e")),
      environment: output(join(logs, "environments", "bay", round(ago(1.6)), "logs", "setup.log"), body("f")),
    }
    const target = output(join(workdir, "elsewhere.bin"), body("target"))
    mkdirSync(dirname(paths.linked), { recursive: true })
    symlinkSync(target, paths.linked)

    const result = await sweepRoundOutputInRound({ workdir, now: NOW, report: () => {} })
    expect(result?.compression?.compressed).toBe(0)
    for (const path of Object.values(paths)) plain(path)
    expect(readFileSync(target, "utf8")).toBe(body("target"))
    const named = skipReasons(result).join("\n")
    expect(named).toMatch(new RegExp(`${otherWriter.id}.*PID ${String(process.ppid)} is present`, "u"))
    expect(named).toMatch(new RegExp(`${ownWriter.id}.*this process`, "u"))
    expect(named).toMatch(new RegExp(`${noPid.id}.*names no writer pid`, "u"))
    expect(named).toContain(`${paths.linked}: a symbolic link`)
    expect(named).toMatch(/y@def456.*no run journal/u)
    expect(named).toMatch(new RegExp(`${newest.id}.*newest round journal`, "u"))
    // An environment tree is a live writer's (a bay): kept plain by class, not a candidate at all.
    expect(named).not.toContain("environments")
  })

  it("resumes every interrupted state and never loses the sole readable copy", async () => {
    const { workdir, logs } = tree("gz-restart")
    const log = finishedRound(logs, ago(1.5))
    finishedRound(logs, ago(0.5))
    const git = join(logs, log.id, "git")
    // gzip only: done; nothing to do.
    const gzOnly = join(git, "1.stdout.bin")
    output(`${gzOnly}.gz`, gzipSync(body("a")))
    // both, archive verifies equal: the plain copy goes.
    const bothEqual = output(join(git, "2.stdout.bin"), body("b"))
    output(`${bothEqual}.gz`, gzipSync(body("b")))
    // both, archive decodes to other bytes: a conflict, both kept.
    const bothDiffer = output(join(git, "3.stdout.bin"), body("c"))
    output(`${bothDiffer}.gz`, gzipSync(body("not c")))
    // both, archive corrupt: named, plain kept, archive never overwritten.
    const corrupt = output(join(git, "4.stdout.bin"), body("d"))
    output(`${corrupt}.gz`, "not gzip at all")
    // a temp the sweep left behind: removed, and the file converted afresh.
    const leftover = output(join(git, "5.stdout.bin"), body("e"))
    const temp = output(`${leftover}.gz.tmp-${String(exitedPid())}`, "partial")

    const result = await sweepRoundOutputInRound({ workdir, now: NOW, report: () => {} })
    expect(result?.compression?.failures).toEqual([])
    expect(readRetainedFile(gzOnly).toString("utf8")).toBe(body("a"))
    gone(bothEqual)
    expect(readRetainedFile(bothEqual).toString("utf8")).toBe(body("b"))
    expect(readFileSync(bothDiffer, "utf8")).toBe(body("c"))
    expect(readFileSync(`${bothDiffer}.gz`)).toEqual(gzipSync(body("not c")))
    expect(readFileSync(corrupt, "utf8")).toBe(body("d"))
    expect(readFileSync(`${corrupt}.gz`, "utf8")).toBe("not gzip at all")
    expect(existsSync(temp)).toBe(false)
    gone(leftover)
    expect(readRetainedFile(leftover).toString("utf8")).toBe(body("e"))
    expect(result?.compression?.compressed).toBe(2)
    const named = skipReasons(result).join("\n")
    expect(named).toContain(`${bothDiffer}: ${bothDiffer}.gz decodes to different bytes`)
    expect(named).toContain(`${corrupt}: ${corrupt}.gz is not a readable gzip`)
  })

  it("abandons a source that changes while it is compressed and keeps the plain file", async () => {
    const { workdir, logs } = tree("gz-changing")
    const log = finishedRound(logs, ago(1.5))
    finishedRound(logs, ago(0.5))
    // Incompressible bytes, so the stream runs long enough for the writer below to land mid-compression.
    const source = output(join(logs, log.id, "git", "1.stdout.bin"), randomBytes(24 * 1024 * 1024))
    const temp = `${source}.gz.tmp-${String(process.pid)}`
    const sweep = sweepRoundOutputInRound({ workdir, now: NOW, report: () => {} })
    let appended = false
    for (let spin = 0; spin < 100_000 && !appended; spin++) {
      if (existsSync(temp)) {
        appendFileSync(source, "late write\n")
        appended = true
      } else await new Promise((resolveTick) => setImmediate(resolveTick))
    }
    expect(appended, "the fixture must land its write while the source is being compressed").toBe(true)
    const result = await sweep
    plain(source)
    expect(existsSync(temp)).toBe(false)
    expect(readFileSync(source).subarray(-11).toString("utf8")).toBe("late write\n")
    expect(skipReasons(result).join("\n")).toContain(`${source}: it changed while it was compressed`)
  })
})

describe("the round sweep gzips journals past seven days, never the newest (34923 ruling 3, 4)", () => {
  it("converts old journals, keeps the newer and the newest plain, and their readers read the same runs", async () => {
    const { workdir, logs } = tree("gz-journals")
    // Journals compress at seven days and are never removed; raw output expires at the two-day round window (hh
    // 38654). So the 10- and 8-day rounds lose their directories AND their journals gzip, while the 1.5-day round is
    // inside both and stays plain — the one case that proves the two clocks are independent.
    const old = finishedRound(logs, ago(10))
    const eight = finishedRound(logs, ago(8))
    const inside = finishedRound(logs, ago(1.5))
    output(join(logs, old.id, "git", "1.stdout.bin"), body("ten days"))
    output(join(logs, eight.id, "git", "1.stdout.bin"), body("eight days"))
    const ids = [old.id, eight.id]
    const before = {
      logs: ids.map((id) => readRunLog(logs, id)),
      runs: readJournals(logs, { runIds: ids, now: NOW }).runs,
    }

    const result = await sweepRoundOutputInRound({ workdir, now: NOW, report: () => {} })
    gone(old.path)
    gone(eight.path)
    plain(inside.path)
    const removed = (result?.removed ?? []).map((entry) => entry.path).sort()
    expect(removed).toEqual([join(logs, eight.id), join(logs, old.id)].sort())
    expect(ids.map((id) => readRunLog(logs, id))).toEqual(before.logs)
    expect(readJournals(logs, { runIds: ids, now: NOW }).runs).toEqual(before.runs)
    // The projection still serves the converted journal: refreshed against the archive, never left stale.
    for (const id of ids) expect(readJournalProjection(logs, id, { detail: "omit" }).kind).toBe("projection")
  })

  it("never compresses the newest round journal, however old", async () => {
    const { workdir, logs } = tree("gz-journal-newest")
    const older = finishedRound(logs, ago(20))
    const newest = finishedRound(logs, ago(16))
    const result = await sweepRoundOutputInRound({ workdir, now: NOW, report: () => {} })
    gone(older.path)
    plain(newest.path)
    expect(skipReasons(result).join("\n")).toContain(`${newest.path}: the newest round journal`)
  })
})

describe("yrd logs prune only removes; compression is the queue round's (34923)", () => {
  it("leaves finished output and old journals plain, and says so in its rendering", async () => {
    const { logs, checks } = tree("gz-prune-verb")
    const old = finishedRound(logs, ago(17))
    const log = finishedRound(logs, ago(1.5))
    finishedRound(logs, ago(0.5))
    const stdout = output(join(logs, log.id, "git", "1.stdout.bin"), body("verb"))
    const result = await pruneRoundOutput({ roots: [logs, { path: checks, optional: true }], now: NOW })
    expect(result.compression).toBeUndefined()
    plain(stdout)
    plain(old.path)
    const lines = retentionHumanLines(result, { roots: [logs, checks], dryRun: false, listed: result.removed })
    expect(lines[1]).toContain("journals kept; this verb never compresses, the queue round's own sweep does")
  })
})

describe("compressed output still expires by round name; journals never (34923 ruling 4)", () => {
  it("removes a compressed round directory past the window by its name, and keeps the compressed journal", async () => {
    const { workdir, logs } = tree("gz-expiry")
    // Inside the two-day window but past the 24-hour compression line, so the first pass compresses it and keeps it.
    const log = finishedRound(logs, ago(1.5))
    finishedRound(logs, ago(0.5))
    const stdout = output(join(logs, log.id, "git", "1.stdout.bin"), body("expiring"))
    const first = await sweepRoundOutputInRound({ workdir, now: NOW, report: () => {} })
    expect(first?.compression?.compressed).toBe(1)
    gone(stdout)
    // A week later the round is 8.5 days old: its directory goes by NAME, though the archive inside is newer, and its
    // journal is past the seven-day compression line too.
    const later = new Date(NOW.getTime() + 7 * DAY)
    const second = await sweepRoundOutputInRound({ workdir, now: later, report: () => {} })
    expect(second?.removed.map((entry) => entry.path)).toEqual([join(logs, log.id)])
    expect(existsSync(join(logs, log.id))).toBe(false)
    // Its journal is now past seven days too: compressed, never removed.
    gone(log.path)
    const third = await sweepRoundOutputInRound({
      workdir,
      now: new Date(later.getTime() + 30 * DAY),
      report: () => {},
    })
    expect(third?.removed).toEqual([])
    expect(existsSync(`${log.path}.gz`)).toBe(true)
    expect(readRunLog(logs, log.id).some((record) => record.kind === "run")).toBe(true)
  })
})

describe("compression work is bounded per round and later rounds progress (34923 ruling 4)", () => {
  it("converts at most ROUND_COMPRESSION_FILES files a round, counts the rest deferred, and finishes next round", async () => {
    const { workdir, logs } = tree("gz-bound-files")
    const log = finishedRound(logs, ago(1.5))
    finishedRound(logs, ago(0.5))
    const files = Array.from({ length: ROUND_COMPRESSION_FILES + 3 }, (_, index) =>
      output(join(logs, log.id, "git", `${String(index + 1)}.stdout.bin`), body(`file ${String(index)}`, 500)),
    )
    const first = await sweepRoundOutputInRound({ workdir, now: NOW, report: () => {} })
    expect(first?.compression?.compressed).toBe(ROUND_COMPRESSION_FILES)
    expect(first?.compression?.deferred).toBe(1)
    const second = await sweepRoundOutputInRound({ workdir, now: NOW, report: () => {} })
    expect(second?.compression?.compressed).toBe(3)
    expect(second?.compression?.deferred).toBe(0)
    for (const path of files) gone(path)
  })

  // The expected SET changed with @cto 34923 ruling 2118: the pass no longer walks oldest first, so which 64 of the 66
  // rounds go first is the newest lane's 4 plus the ring's next 60. The counts, the bound and the memory are unchanged.
  it("examines at most ROUND_COMPRESSION_UNITS candidates a round, newest lane first; the service's memory moves on", async () => {
    const { workdir, logs } = tree("gz-bound-units")
    // The service keeps one `settled` set for its life (queue-core-commands.ts): a finished round is not examined twice.
    const settled = new Set<string>()
    const rounds = Array.from({ length: ROUND_COMPRESSION_UNITS + 2 }, (_, index) =>
      finishedRound(logs, new Date(ago(1.9).getTime() + index * 35_000)),
    )
    finishedRound(logs, ago(0.5))
    // Every round holds output so it stays a candidate, but only every 4th file is past the 4 KiB compression floor:
    // the units bound (2048 since @cto 340938a3) is what ends the pass, never ROUND_COMPRESSION_FILES (1024), which a
    // compressible file in every round would hit first. Files under the floor are left and count no file.
    const withFile = (index: number): boolean => index % 4 === 0
    const files = rounds.flatMap((log, index) => {
      const path = join(logs, log.id, "git", "1.stdout.bin")
      if (!withFile(index)) {
        output(path, "small\n")
        return []
      }
      return [output(path, body(log.id, 300))]
    })
    expect(files.length).toBeLessThan(ROUND_COMPRESSION_FILES)
    const first = await sweepRoundOutputInRound({ workdir, now: NOW, report: () => {}, settled })
    expect(first?.compression?.deferred).toBe(2)
    const left = files.filter((path) => existsSync(path))
    expect(left.length).toBeLessThanOrEqual(2)
    expect(first?.compression?.compressed).toBe(files.length - left.length)
    // The newest lane: the 4 latest eligible rounds are examined first, whatever the ring's start.
    rounds.forEach((log, index) => {
      if (index >= rounds.length - NEWEST_LANE_UNITS && withFile(index)) gone(join(logs, log.id, "git", "1.stdout.bin"))
    })
    const second = await sweepRoundOutputInRound({ workdir, now: NOW, report: () => {}, settled })
    expect(second?.compression?.compressed).toBe(left.length)
    expect(second?.compression?.deferred).toBe(0)
    for (const path of files) gone(path)
    // Without that memory (a restarted service) the finished rounds are examined again, still within the bound.
    const restarted = await sweepRoundOutputInRound({ workdir, now: NOW, report: () => {} })
    expect(restarted?.compression).toMatchObject({ compressed: 0, deferred: 2, failures: [] })
  })

  // Live 2026-11-21 (37402, @cto ec815fba GO): passes examined 64 units and the service restarted every 30-90 minutes,
  // so a fresh memory never finished walking ~7,900 candidates and `deferred` saw-toothed at 6.7k-7.9k for six hours.
  describe("a fresh service walks the candidates between restarts; deferred is only what is still owed (37402)", () => {
    const lastRow = (workdir: string): Record<string, unknown> => {
      const rows = readFileSync(join(workdir, RETENTION_JOURNAL), "utf8").trim().split("\n")
      return JSON.parse(rows[rows.length - 1] ?? "{}") as Record<string, unknown>
    }

    it("examines a 200-round backlog in one pass of a fresh service", async () => {
      const { workdir, logs } = tree("gz-units-walk")
      const files = Array.from({ length: 200 }, (_, index) => {
        const log = finishedRound(logs, new Date(ago(1.5).getTime() + index * 60_000))
        return output(join(logs, log.id, "git", "1.stdout.bin"), body(log.id, 300))
      })
      finishedRound(logs, ago(0.5))
      const result = await sweepRoundOutputInRound({ workdir, now: NOW, report: () => {} })
      expect(result?.compression).toMatchObject({ compressed: 200, deferred: 0, failures: [] })
      for (const path of files) gone(path)
    })

    it("names a pass slower than ROUND_COMPRESSION_SLOW_MS in its row, and only that pass", async () => {
      const { workdir, logs } = tree("gz-slow-pass")
      const log = finishedRound(logs, ago(1.5))
      output(join(logs, log.id, "git", "1.stdout.bin"), body(log.id, 300))
      finishedRound(logs, ago(0.5))
      let tick = 0
      const slow = await sweepRoundOutputInRound({
        workdir,
        now: NOW,
        report: () => {},
        clock: () => (tick += ROUND_COMPRESSION_SLOW_MS + 1000),
      })
      const elapsedMs = ROUND_COMPRESSION_SLOW_MS + 1000
      expect(slow?.compression?.slow).toEqual({ elapsedMs, boundMs: ROUND_COMPRESSION_SLOW_MS })
      expect(lastRow(workdir).compression).toMatchObject({ slow: { elapsedMs, boundMs: ROUND_COMPRESSION_SLOW_MS } })
      const second = finishedRound(logs, ago(1.5))
      output(join(logs, second.id, "git", "1.stdout.bin"), body(second.id, 300))
      const fast = await sweepRoundOutputInRound({ workdir, now: NOW, report: () => {}, clock: () => 0 })
      expect(fast?.compression?.slow).toBeUndefined()
      expect(lastRow(workdir).compression).not.toHaveProperty("slow")
    })

    it("counts each unproven candidate apart from deferred, by its reason, in the result and the row", async () => {
      const { workdir, logs, checks } = tree("gz-unproven")
      // A journal that names no writer pid.
      const noPid = unfinishedRound(logs, ago(1.5))
      output(join(logs, noPid.id, "git", "1.stdout.bin"), body(noPid.id, 300))
      // Round output under logs with no journal: its header cannot be read (live: 466 of the 11-21 samples).
      const orphan = round(new Date(ago(1.5).getTime() + 60_000))
      output(join(logs, orphan, "git", "1.stdout.bin"), body(orphan, 300))
      // A check round under checks that no run journal names (live: 143).
      const unnamed = round(new Date(ago(1.5).getTime() + 180_000))
      output(join(checks, "task", `unnamed@${"a".repeat(40)}`, unnamed, "git", "1.stdout.bin"), body(unnamed, 300))
      // A journal already gzipped with no projection: its header cannot be read.
      const zipped = unfinishedRound(logs, new Date(ago(1.5).getTime() + 120_000))
      writeFileSync(`${zipped.path}.gz`, gzipSync(readFileSync(zipped.path)))
      safeRemoveSync(zipped.path, { within: logs, allowedRoots: [logs] })
      output(join(logs, zipped.id, "git", "1.stdout.bin"), body(zipped.id, 300))
      finishedRound(logs, ago(0.5))
      const result = await sweepRoundOutputInRound({ workdir, now: NOW, report: () => {} })
      const byReason = { "no-writer-pid": 1, "no-run-journal": 1, "journal-header-unreadable": 2 }
      expect(result?.compression).toMatchObject({ compressed: 0, deferred: 0, unproven: 4, unprovenByReason: byReason })
      expect(lastRow(workdir).compression).toMatchObject({ unproven: 4, unprovenByReason: byReason })
      // Still named, one by one, as before.
      expect(skipReasons(result).filter((line) => line.includes("not proven finished"))).toHaveLength(4)
    })
  })

  // Live 2026-11-18 (34923 row 6, @cto 2023): 41 passes converted nothing, because ~59k older journals that cannot be
  // proven finished took every unit, and the service's memory of them ends at each restart. Rounds come first.
  it("reaches a completed round in a fresh lifetime past more than one budget of older unprovable journals", async () => {
    const { workdir, logs } = tree("gz-order-journals")
    const stale = Array.from({ length: ROUND_COMPRESSION_UNITS + 2 }, (_, index) =>
      unfinishedRound(logs, new Date(ago(20).getTime() + index * 60_000)),
    )
    const kept = finishedRound(logs, ago(1.5))
    finishedRound(logs, ago(0.5))
    const stdout = output(join(logs, kept.id, "git", "1.stdout.bin"), body("kept"))
    const result = await sweepRoundOutputInRound({ workdir, now: NOW, report: () => {} })
    // One round and 63 journals examined (still charged and named), 3 journals deferred.
    expect(result?.compression).toMatchObject({ compressed: 1, deferred: 3, failures: [] })
    gone(stdout)
    for (const log of stale) plain(log.path)
    expect(skipReasons(result).join("\n")).toMatch(/names no writer pid/u)
  })

  // @cto 34923 ruling 2118: the visit order is journals' share first, newest lanes, rotating rings. These pin the
  // order itself, which the counts-only tests above cannot see.
  describe("the visit order (34923 ruling 2118)", () => {
    const candidate = (kind: "round" | "journal", index: number, minutes = index) => ({
      kind,
      path: `/logs/${kind}-${String(index).padStart(3, "0")}`,
      run: `q-${String(index)}`,
      within: "/logs",
      started: new Date(ago(17).getTime() + minutes * 60_000),
      entry: kind === "round" ? ("directory" as const) : ("file" as const),
    })

    it("puts the journals' share first, then every round, then the other journals; settled and repeated paths never", () => {
      const journals = Array.from({ length: 40 }, (_, index) => candidate("journal", index))
      const rounds = Array.from({ length: 70 }, (_, index) => candidate("round", index))
      const settled = new Set([rounds[3]?.path ?? "", journals[5]?.path ?? ""])
      const order = compressionVisitOrder([...journals, ...rounds, ...rounds.slice(0, 5)], settled, NOW)
      const kinds = order.map((entry) => entry.kind)
      expect(kinds.slice(0, JOURNAL_UNIT_SHARE).every((kind) => kind === "journal")).toBe(true)
      expect(kinds.slice(JOURNAL_UNIT_SHARE, JOURNAL_UNIT_SHARE + 69).every((kind) => kind === "round")).toBe(true)
      expect(order).toHaveLength(40 + 70 - 2)
      expect(new Set(order.map((entry) => entry.path)).size).toBe(order.length)
      expect(order.some((entry) => settled.has(entry.path))).toBe(false)
      // Work-conserving: with few rounds, the journals beyond their share fill the pass's units after them.
      const manyJournals = Array.from({ length: 100 }, (_, index) => candidate("journal", index))
      const fewRounds = compressionVisitOrder([...manyJournals, ...rounds.slice(0, 10)], new Set(), NOW)
      // 16 journals, the 10 rounds, then the other journals: a pass's units, none left idle while candidates remain.
      const units = Math.min(ROUND_COMPRESSION_UNITS, fewRounds.length)
      expect(fewRounds.slice(0, units).filter((entry) => entry.kind === "journal")).toHaveLength(units - 10)
    })

    it("leads each kind with its newest candidates, repeats for a fixed clock, and moves the ring's start with it", () => {
      const rounds = Array.from({ length: 200 }, (_, index) => candidate("round", index))
      const order = compressionVisitOrder(rounds, new Set(), NOW)
      expect(order.slice(0, NEWEST_LANE_UNITS).map((entry) => entry.path)).toEqual(
        rounds
          .slice(-NEWEST_LANE_UNITS)
          .reverse()
          .map((entry) => entry.path),
      )
      expect(compressionVisitOrder(rounds, new Set(), NOW)).toEqual(order)
      const later = compressionVisitOrder(rounds, new Set(), new Date(NOW.getTime() + 144_000))
      expect(later.slice(0, NEWEST_LANE_UNITS)).toEqual(order.slice(0, NEWEST_LANE_UNITS))
      expect(later[NEWEST_LANE_UNITS]?.path).not.toBe(order[NEWEST_LANE_UNITS]?.path)
      expect(new Set(later.map((entry) => entry.path))).toEqual(new Set(order.map((entry) => entry.path)))
    })
  })

  // A restarted service has a fresh `settled` set; here every pass is a restart, the harshest schedule. The clock
  // advances 2.4 minutes a pass (one queue round). Observed counts are this fixture's, not a coverage theorem.
  describe("progress when every pass starts with a fresh memory (34923 ruling 2118)", () => {
    const STEP_MS = 144_000
    async function sweepUntilConverted(
      workdir: string,
      files: () => readonly string[],
      options: { maxPasses: number; arrive?: (pass: number, now: Date) => void },
    ): Promise<number> {
      for (let pass = 1; pass <= options.maxPasses; pass++) {
        const now = new Date(NOW.getTime() + pass * STEP_MS)
        options.arrive?.(pass, now)
        await sweepRoundOutputInRound({ workdir, now, report: () => {} })
        if (files().every((path) => !existsSync(path))) return pass
      }
      throw new Error(`not every file converted within ${String(options.maxPasses)} passes`)
    }
    // What one pass can convert when every round holds one compressible file: the smaller of the units and files
    // bounds. Since units went to 2048 (@cto 340938a3) that is the files bound, so the backlogs keep their 1024-unit
    // sizes and their run time instead of doubling past the 30 s test timeout on a loaded host.
    const PASS_BUDGET = Math.min(ROUND_COMPRESSION_UNITS, ROUND_COMPRESSION_FILES)
    // Twenty seconds apart from 1.9 days back: 3 x 1024 rounds span ~17 hours, all past the 24-hour compression line
    // and inside the two-day round window (@cto 2026-11-25, hh 38654). From older than two days they would already be
    // expired, so the removal budget — not this compression bound — would end the drain (37402).
    function backlog(logs: string, count: number): string[] {
      return Array.from({ length: count }, (_, index) => {
        const log = finishedRound(logs, new Date(ago(1.9).getTime() + index * 20_000))
        return output(join(logs, log.id, "git", "1.stdout.bin"), body(log.id, 300))
      })
    }

    it("no new arrivals: a backlog of three lifetimes' budget converts", async () => {
      const { workdir, logs } = tree("gz-progress-still")
      const files = backlog(logs, 3 * PASS_BUDGET)
      finishedRound(logs, ago(0.5))
      const passes = await sweepUntilConverted(workdir, () => files, { maxPasses: 40 })
      expect(passes).toBeGreaterThanOrEqual(3)
    })

    it("regular arrivals: each newcomer converts in the pass after it becomes eligible, and the backlog still drains", async () => {
      const { workdir, logs } = tree("gz-progress-regular")
      const files = backlog(logs, 2 * PASS_BUDGET)
      finishedRound(logs, ago(0.5))
      const arrivals: string[] = []
      const passes = await sweepUntilConverted(workdir, () => [...files, ...arrivals], {
        maxPasses: 40,
        arrive: (pass) => {
          if (arrivals.length > 0) gone(arrivals[arrivals.length - 1] ?? "")
          // An eligible newcomer: just past the 24-hour line, newer than every backlog round.
          const log = finishedRound(logs, new Date(ago(1.1).getTime() + pass * 60_000))
          arrivals.push(output(join(logs, log.id, "git", "1.stdout.bin"), body(log.id, 300)))
        },
      })
      expect(passes).toBeGreaterThanOrEqual(2)
    })

    it("bursty arrivals: a burst wider than the newest lane still drains with the backlog", async () => {
      const { workdir, logs } = tree("gz-progress-bursty")
      const files = backlog(logs, PASS_BUDGET)
      finishedRound(logs, ago(0.5))
      const arrivals: string[] = []
      await sweepUntilConverted(workdir, () => [...files, ...arrivals], {
        maxPasses: 40,
        arrive: (pass) => {
          if (pass > 3) return
          for (let index = 0; index < 3 * NEWEST_LANE_UNITS; index++) {
            // Every burst member is already past the 24-hour line, so the whole burst is eligible at once.
            const log = finishedRound(logs, new Date(ago(1.5).getTime() + (pass * 20 + index) * 60_000))
            arrivals.push(output(join(logs, log.id, "git", "1.stdout.bin"), body(log.id, 300)))
          }
        },
      })
    })
  })

  // Shares are ceilings under the global byte bound, with the native first-file exception kept (ruling 2118 point 4).
  it("a journal that fills the byte bound first leaves rounds deferred, honestly counted, for the next pass", async () => {
    const { workdir, logs } = tree("gz-bytes-journal-first")
    const big = openLog(logs, () => ago(16))
    big.write({ kind: "run", target: "main", queue: "main" })
    const size = Math.floor(ROUND_COMPRESSION_BYTES * 0.6)
    for (let written = 0; written < size; written += 100_000) {
      big.write({ kind: "warning", subject: "pad", reason: "j".repeat(100_000) })
    }
    big.finish()
    const kept = finishedRound(logs, ago(1.5))
    finishedRound(logs, ago(0.5))
    const stdout = output(join(logs, kept.id, "git", "1.stdout.bin"), Buffer.alloc(size, 0x61))
    const first = await sweepRoundOutputInRound({ workdir, now: NOW, report: () => {} })
    expect(first?.compression).toMatchObject({ compressed: 1, deferred: 1, failures: [] })
    gone(big.path)
    plain(stdout)
    const second = await sweepRoundOutputInRound({ workdir, now: NOW, report: () => {} })
    expect(second?.compression).toMatchObject({ compressed: 1, deferred: 0 })
    gone(stdout)
  })

  it("a round's single file larger than the byte bound converts alone, and the next round waits a pass", async () => {
    const { workdir, logs } = tree("gz-bytes-first-file")
    const huge = finishedRound(logs, ago(1.9))
    const after = finishedRound(logs, ago(1.5))
    finishedRound(logs, ago(0.5))
    const hugeFile = output(
      join(logs, huge.id, "git", "1.stdout.bin"),
      Buffer.alloc(ROUND_COMPRESSION_BYTES + 4096, 0x63),
    )
    const afterFile = output(join(logs, after.id, "git", "1.stdout.bin"), body("after"))
    const first = await sweepRoundOutputInRound({ workdir, now: NOW, report: () => {} })
    // Newest lane: `after` is examined first and converts; then `huge` is a positive cost past a started pass.
    expect(first?.compression).toMatchObject({ compressed: 1, deferred: 1 })
    gone(afterFile)
    plain(hugeFile)
    const second = await sweepRoundOutputInRound({ workdir, now: NOW, report: () => {} })
    // Alone in its pass, the first-file exception lets it through whole.
    expect(second?.compression).toMatchObject({ compressed: 1, bytesIn: ROUND_COMPRESSION_BYTES + 4096, deferred: 0 })
    gone(hugeFile)
  })

  it("reads at most ROUND_COMPRESSION_BYTES of source a round, a single larger file alone", async () => {
    const { workdir, logs } = tree("gz-bound-bytes")
    const log = finishedRound(logs, ago(1.5))
    finishedRound(logs, ago(0.5))
    const size = Math.floor(ROUND_COMPRESSION_BYTES * 0.6)
    const first = output(join(logs, log.id, "git", "1.stdout.bin"), Buffer.alloc(size, 0x61))
    const second = output(join(logs, log.id, "git", "2.stdout.bin"), Buffer.alloc(size, 0x62))
    const one = await sweepRoundOutputInRound({ workdir, now: NOW, report: () => {} })
    expect(one?.compression).toMatchObject({ compressed: 1, bytesIn: size, deferred: 1 })
    gone(first)
    plain(second)
    const two = await sweepRoundOutputInRound({ workdir, now: NOW, report: () => {} })
    expect(two?.compression).toMatchObject({ compressed: 1, bytesIn: size, deferred: 0 })
    gone(second)
    expect(readRetainedFile(second).equals(Buffer.alloc(size, 0x62))).toBe(true)
  })
})

describe("a compression failure is a result, never a failed round (34923 ruling 4)", () => {
  it("reports a gzip that cannot be written, keeps the plain file, still drains the rest, and retries next round", async () => {
    const { workdir, logs } = tree("gz-fail-write")
    const stuck = finishedRound(logs, ago(1.9))
    const fine = finishedRound(logs, ago(1.5))
    finishedRound(logs, ago(0.5))
    const expired = place(join(logs, round(ago(16))))
    const stuckGit = join(logs, stuck.id, "git")
    const stuckFile = output(join(stuckGit, "1.stdout.bin"), body("stuck"))
    const fineFile = output(join(logs, fine.id, "git", "1.stdout.bin"), body("fine"))
    chmodSync(stuckGit, 0o500)
    const lines: string[] = []
    let result: Awaited<ReturnType<typeof sweepRoundOutputInRound>>
    try {
      result = await sweepRoundOutputInRound({ workdir, now: NOW, report: (line) => lines.push(line) })
    } finally {
      chmodSync(stuckGit, 0o700)
    }
    expect(result).toBeDefined()
    expect(result?.removed.map((entry) => entry.path)).toEqual([expired])
    expect(result?.compression?.failures.map((failure) => failure.path)).toEqual([stuckFile])
    plain(stuckFile)
    gone(fineFile)
    expect(lines.join("")).toContain(`could not compress ${stuckFile}`)
    expect(lines.join("")).toContain("the next round retries")
    expect(JSON.stringify(retentionRows(workdir)[0]?.compression)).toContain(stuckFile)
    const next = await sweepRoundOutputInRound({ workdir, now: NOW, report: () => {} })
    expect(next?.compression?.failures).toEqual([])
    gone(stuckFile)
  })

  it("reports a plain file that cannot be removed after its archive is installed, and the next round finishes it", async () => {
    const { workdir, logs } = tree("gz-fail-remove")
    const log = finishedRound(logs, ago(1.5))
    finishedRound(logs, ago(0.5))
    const stdout = output(join(logs, log.id, "git", "1.stdout.bin"), body("kept"))
    removalFault.path = stdout
    const lines: string[] = []
    let result: Awaited<ReturnType<typeof sweepRoundOutputInRound>>
    try {
      result = await sweepRoundOutputInRound({ workdir, now: NOW, report: (line) => lines.push(line) })
    } finally {
      removalFault.path = undefined
    }
    expect(result).toBeDefined()
    expect(result?.compression?.failures.map((failure) => failure.error).join("")).toContain("injected removal failure")
    // Both copies remain readable; nothing was lost.
    expect(readFileSync(stdout, "utf8")).toBe(body("kept"))
    expect(readRetainedFile(`${stdout}`).toString("utf8")).toBe(body("kept"))
    expect(lines.join("")).toContain(`could not compress ${stdout}`)
    const next = await sweepRoundOutputInRound({ workdir, now: NOW, report: () => {} })
    expect(next?.compression?.compressed).toBe(1)
    gone(stdout)
    expect(readRetainedFile(stdout).toString("utf8")).toBe(body("kept"))
  })
})

// #34952 (@cto 72645433): a target that declares `retention.holds` has every destructive unit of a pass judged first,
// removal and compression alike; nothing the judge did not clear is removed or unlinked, and a failed judge keeps all.
describe("a target's holds judge (34952)", () => {
  /** A judge that holds every candidate path in `held`, recording what it was asked. */
  const judging = (held: ReadonlySet<string>) => {
    const asked: HoldsCandidate[][] = []
    const judge: HoldsJudge = async (candidates) => {
      asked.push([...candidates])
      return candidates.map((candidate) =>
        held.has(candidate.path)
          ? { path: candidate.path, held: true, proof: `held at delete: cited by pm/x.md:${String(asked.length)}` }
          : { path: candidate.path, held: false },
      )
    }
    return { judge, asked }
  }

  it("keeps a newly cited expired directory and removes the uncited one beside it", async () => {
    const { logs, checks } = tree("holds-cited")
    const cited = place(join(logs, round(ago(20))))
    const control = place(join(logs, round(ago(19))))
    const { judge, asked } = judging(new Set([cited]))
    const result = await pruneRoundOutput({ roots: [logs, { path: checks, optional: true }], now: NOW, holds: judge })
    expect(asked).toHaveLength(1)
    expect(existsSync(cited)).toBe(true)
    expect(existsSync(control)).toBe(false)
    expect(result.removed.map((entry) => entry.path)).toEqual([control])
    expect(result.held).toEqual([{ path: cited, kind: "removal", proof: "held at delete: cited by pm/x.md:1" }])
    expect(result.remaining.map((entry) => entry.path)).toEqual([cited])
  })

  it("keeps the whole pass when the judge throws, answers short, answers twice, or names a path it was not asked", async () => {
    const answers: Record<string, HoldsJudge> = {
      throws: async () => {
        throw new Error("state rail unreachable")
      },
      short: async (candidates) => candidates.slice(1).map((candidate) => ({ path: candidate.path, held: false })),
      twice: async (candidates) => [
        ...candidates.map((candidate) => ({ path: candidate.path, held: false })),
        { path: candidates[0]?.path ?? "", held: false },
      ],
      stranger: async (candidates) => [
        ...candidates.slice(1).map((candidate) => ({ path: candidate.path, held: false })),
        { path: "/elsewhere/q-x", held: false },
      ],
      unproven: async (candidates) => candidates.map((candidate) => ({ path: candidate.path, held: true })),
    }
    for (const [name, judge] of Object.entries(answers)) {
      const { logs, checks } = tree(`holds-fail-${name}`)
      const one = place(join(logs, round(ago(20))))
      const two = place(join(logs, round(ago(19))))
      const result = await pruneRoundOutput({ roots: [logs, { path: checks, optional: true }], now: NOW, holds: judge })
      expect([existsSync(one), existsSync(two)], name).toEqual([true, true])
      expect(result.removed, name).toEqual([])
      expect(result.holdsFailure, name).toBeTypeOf("string")
      expect(retentionRowWorthWriting(result), name).toBe(true)
    }
  })

  it("never stalls on held entries: more held than a batch, and the eligible one behind them drains", async () => {
    const { logs, checks } = tree("holds-prefix")
    const heldOld = Array.from({ length: ROUND_REMOVAL_BATCH * 3 }, (_, index) =>
      place(join(logs, round(ago(40 - index * 0.5)))),
    )
    const control = place(join(logs, round(ago(15))))
    const { judge } = judging(new Set(heldOld))
    const first = await sweepRoundOutputInRound({
      workdir: dirname(logs),
      now: NOW,
      report: () => {},
      holds: judge,
    })
    expect(existsSync(control)).toBe(false)
    expect(first?.removed.map((entry) => entry.path)).toEqual([control])
    expect(heldOld.every((path) => existsSync(path))).toBe(true)
    expect(first?.held).toHaveLength(heldOld.length)
    void checks
  })

  it("judges compression units with the removals: a held round keeps its plain output, an uncited one is gzipped", async () => {
    const { workdir, logs } = tree("holds-compress")
    const cited = finishedRound(logs, ago(1.9))
    const plainCited = output(join(logs, cited.id, "git", "1.stdout.bin"), body("cited"))
    const free = finishedRound(logs, ago(1.5))
    const plainFree = output(join(logs, free.id, "git", "1.stdout.bin"), body("free"))
    finishedRound(logs, ago(0.5))
    const expired = place(join(logs, round(ago(20))))
    const { judge, asked } = judging(new Set([join(logs, cited.id)]))
    const result = await sweepRoundOutputInRound({ workdir, now: NOW, report: () => {}, holds: judge })
    expect(asked).toHaveLength(1)
    const kinds = new Set(asked[0]?.map((candidate) => candidate.kind))
    expect(kinds.has("removal") && kinds.has("round")).toBe(true)
    expect(existsSync(expired)).toBe(false)
    plain(plainCited)
    gone(plainFree)
    expect(result?.held?.map((entry) => entry.path)).toEqual([join(logs, cited.id)])
  })

  it("a failed judge also keeps compression, and its row names the failure", async () => {
    const { workdir, logs } = tree("holds-compress-fail")
    const round1 = finishedRound(logs, ago(1.9))
    const plain1 = output(join(logs, round1.id, "git", "1.stdout.bin"), body("kept"))
    finishedRound(logs, ago(0.5))
    const lines: string[] = []
    const result = await sweepRoundOutputInRound({
      workdir,
      now: NOW,
      report: (line) => lines.push(line),
      holds: async () => {
        throw new Error("dev main moved")
      },
    })
    plain(plain1)
    expect(result?.compression?.compressed ?? 0).toBe(0)
    expect(lines.join("")).toContain("the target's holds judge did not answer (dev main moved)")
    expect(retentionRows(workdir).at(-1)).toMatchObject({ holdsFailure: "dev main moved" })
  })

  it("runs a judged pass at most once per spacing, and judges afresh after it", async () => {
    const { workdir, logs } = tree("holds-pace")
    const cited = place(join(logs, round(ago(20))))
    const { judge, asked } = judging(new Set([cited]))
    const pace = {}
    await sweepRoundOutputInRound({ workdir, now: NOW, report: () => {}, holds: judge, pace })
    const soon = new Date(NOW.getTime() + RETENTION_JUDGED_SPACING_MS - 1)
    expect(await sweepRoundOutputInRound({ workdir, now: soon, report: () => {}, holds: judge, pace })).toBeUndefined()
    expect(asked).toHaveLength(1)
    const later = new Date(NOW.getTime() + RETENTION_JUDGED_SPACING_MS)
    await sweepRoundOutputInRound({ workdir, now: later, report: () => {}, holds: judge, pace })
    expect(asked).toHaveLength(2)
    expect(existsSync(cited)).toBe(true)
  })
})

describe("holdsJudgeCommand: the declared argv, strictly read (34952)", () => {
  const script = (label: string, text: string): string => {
    const { workdir } = tree(`holds-argv-${label}`)
    const path = join(workdir, "judge.sh")
    writeFileSync(path, `#!/bin/sh\n${text}\n`)
    chmodSync(path, 0o755)
    return path
  }
  const candidates: HoldsCandidate[] = [
    { path: "/q/logs/q-a", kind: "removal" },
    { path: "/q/logs/q-b", kind: "round" },
  ]

  it("passes the request on stdin and returns the verdicts", async () => {
    const { workdir } = tree("holds-argv-ok")
    const seen = join(workdir, "stdin.json")
    const path = script(
      "ok",
      `cat > ${seen}; echo '{"version":1,"verdicts":[{"path":"/q/logs/q-a","held":true,"proof":"cited"},{"path":"/q/logs/q-b","held":false}],"read":{"railBase":"abc"}}'`,
    )
    const judge = holdsJudgeCommand({ argv: [path], cwd: workdir, roots: ["/q/logs"] })
    expect(await judge(candidates)).toEqual([
      { path: "/q/logs/q-a", held: true, proof: "cited" },
      { path: "/q/logs/q-b", held: false },
    ])
    expect(JSON.parse(readFileSync(seen, "utf8"))).toEqual({ version: 1, roots: ["/q/logs"], candidates })
  })

  it("throws on a non-zero exit, a missing command, non-JSON, or another version", async () => {
    const { workdir } = tree("holds-argv-bad")
    const cases: Record<string, string[]> = {
      exit: [script("exit", "echo 'rail unreachable' >&2; exit 1")],
      missing: [join(workdir, "no-such-judge")],
      garbage: [script("garbage", "echo not-json")],
      version: [script("version", `echo '{"version":2,"verdicts":[]}'`)],
    }
    for (const [name, argv] of Object.entries(cases)) {
      const judge = holdsJudgeCommand({ argv, cwd: workdir, roots: ["/q/logs"] })
      await expect(judge(candidates), name).rejects.toThrow(/retention\.holds|ENOENT|no such|not found/u)
    }
  })
})
