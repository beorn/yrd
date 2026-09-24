/**
 * The readings the watch is built on, and every one of them is a reading:
 * the run journal read back, the clocks, the declared checks joined to what
 * ran, who acts next, and the head subjects in one batched call.
 *
 * Each test here exists because the field it covers has no honest default. A
 * reader that answered `0s` for a runtime nobody measured, or an empty string
 * for a subject it could not fetch, would be stating a measurement that was
 * never taken — so the assertions below are as much about what is ABSENT as
 * about what is there.
 */

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  checksOf,
  clocks,
  gitIn,
  incidentTrailers,
  journalKey,
  list,
  nextOwner,
  readChange,
  readJournals,
  runStartedAt,
  skippedChecks,
  subjects,
  watchRows,
} from "../src/index.ts"
import type { ChangeRecord, CheckSpec, Git, Row } from "../src/index.ts"
import type { QueueEntry } from "../src/remote.ts"
// `openLog` is the writer, and index.ts lists only what a consumer outside the
// package imports. A test that writes a journal is inside it.
import { openLog } from "../src/log.ts"

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

function scratch(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `yrd-${name}-`))
  roots.push(root)
  return root
}

/** A journal directory with one run's records written the way `openLog` writes them. */
function journalDir(
  records: readonly Readonly<Record<string, unknown>>[],
  at = new Date(),
): Readonly<{ dir: string; run: string }> {
  const dir = join(scratch("journal"), "logs")
  const log = openLog(dir, () => at)
  for (const record of records) log.write(record as never)
  return { dir, run: log.id }
}

describe("a run's journal, read back", () => {
  it("names the check running now: a start row this run never ended", () => {
    const at = new Date("2026-09-03T20:00:00.000Z")
    const { dir, run } = journalDir(
      [
        { base: "aaa", checks: ["typecheck", "test"], kind: "run", queue: "q", target: "main" },
        {
          branch: "task/one",
          head: "abc123",
          kind: "check",
          log: "/w/checks/typecheck.log",
          name: "typecheck",
          phase: "merge",
          start: "2026-09-03T19:58:00.000Z",
        },
        {
          branch: "task/one",
          end: "2026-09-03T19:59:00.000Z",
          head: "abc123",
          kind: "check",
          log: "/w/checks/typecheck.log",
          ms: 60_000,
          name: "typecheck",
          phase: "merge",
          start: "2026-09-03T19:58:00.000Z",
        },
        {
          branch: "task/one",
          head: "abc123",
          kind: "check",
          log: "/w/checks/test.log",
          name: "test",
          phase: "merge",
          start: "2026-09-03T19:59:00.000Z",
        },
      ],
      at,
    )

    const journals = readJournals(dir, { now: at })
    expect(journals.absent).toBeUndefined()
    const runs = journals.runs.get(journalKey("task/one", "abc123"))
    expect(runs).toHaveLength(1)
    expect(runs?.[0]?.id).toBe(run)
    // `end` is the one field only an ending can write, so the unended start
    // row IS the check running now — the whole hook the "running" overlay
    // hangs on (log.ts's own contract).
    expect(runs?.[0]?.running?.name).toBe("test")
    expect(runs?.[0]?.running?.log).toBe("/w/checks/test.log")
    // The ended one is settled in place, not appended twice.
    expect(runs?.[0]?.checks).toHaveLength(2)
    expect(runs?.[0]?.checks[0]?.endedAt?.toISOString()).toBe("2026-09-03T19:59:00.000Z")
    expect(runs?.[0]?.checks[0]?.ms).toBe(60_000)
    expect(runs?.[0]?.base).toBe("aaa")
    expect(runs?.[0]?.checks[0]?.result).toBeUndefined()
    expect(checksOf([], "open", [], runs?.[0]?.running, runs?.[0]?.checks).map((check) => check.state)).toEqual([
      "unmeasured",
      "running",
    ])
  })

  it("reads each step of the round with the git commands it ran, in journal order (25441)", () => {
    const at = new Date("2026-09-03T20:00:00.000Z")
    const change = { branch: "task/one", head: "abc123" }
    const git = (n: number, args: readonly string[], exit = 0) => ({
      args,
      cwd: "/w",
      evidence: `/w/logs/run/git/${String(n)}.stdout.bin.json`,
      exit,
      kind: "git",
    })
    const { dir } = journalDir(
      [
        { base: "aaa", checks: ["test"], kind: "run", queue: "q", target: "main" },
        // Before any step: the round's own command, shown only on the round tab.
        git(1, ["fetch", "origin"]),
        { kind: "step", name: "read", phase: "run", start: "2026-09-03T19:50:00.000Z", target: "main", base: "aaa" },
        git(2, ["for-each-ref", "refs/yrd"]),
        {
          base: "aaa",
          end: "2026-09-03T19:50:02.000Z",
          kind: "step",
          ms: 2_000,
          name: "read",
          phase: "run",
          start: "2026-09-03T19:50:00.000Z",
          target: "main",
        },
        { ...change, kind: "step", name: "compose", phase: "merge", start: "2026-09-03T19:51:00.000Z" },
        git(3, ["merge", "--no-edit", "task/one"], 1),
        {
          ...change,
          end: "2026-09-03T19:51:05.000Z",
          kind: "step",
          ms: 5_000,
          name: "compose",
          phase: "merge",
          start: "2026-09-03T19:51:00.000Z",
          threw: true,
        },
        { ...change, kind: "step", ms: 1_200, name: "settle", phase: "merge", within: "compose" },
        { ...change, kind: "change", decision: "failed", reason: "compose" },
      ],
      at,
    )

    const run = readJournals(dir, { now: at }).runs.get(journalKey("task/one", "abc123"))?.[0]
    expect(
      run?.steps?.map((step) => ({
        name: step.name,
        ms: step.ms,
        threw: step.threw,
        commands: step.commands.map((command) => `${command.args.join(" ")} → ${String(command.exit)}`),
        parts: step.parts,
      })),
    ).toEqual([
      { name: "read", ms: 2_000, threw: undefined, commands: ["for-each-ref refs/yrd → 0"], parts: undefined },
      {
        name: "compose",
        ms: 5_000,
        threw: true,
        commands: ["merge --no-edit task/one → 1"],
        parts: [{ name: "settle", ms: 1_200 }],
      },
    ])
    expect(run?.commands?.map((command) => command.args.join(" "))).toEqual(["fetch origin"])
    // Output stays on disk: the command carries its raw files' paths, never their bytes.
    expect(run?.steps?.[1]?.commands[0]).toMatchObject({
      stdout: "/w/logs/run/git/3.stdout.bin",
      stderr: "/w/logs/run/git/3.stderr.bin",
    })
  })

  it("reads nested steps as the live journal writes them: a command belongs to the innermost step open (25441)", () => {
    const at = new Date("2026-09-03T20:00:00.000Z")
    const change = { branch: "task/one", head: "abc123" }
    const git = (n: number, args: readonly string[]) => ({
      args,
      cwd: "/w",
      evidence: `/w/logs/run/git/${String(n)}.stdout.bin.json`,
      exit: 0,
      kind: "git",
    })
    const step = (name: string, start: string, end?: string) => ({
      ...change,
      kind: "step",
      name,
      phase: "merge",
      start,
      ...(end === undefined ? {} : { end, ms: new Date(end).getTime() - new Date(start).getTime() }),
    })
    const { dir } = journalDir(
      [
        step("compose", "2026-09-03T19:51:00.000Z"),
        step("worktree", "2026-09-03T19:51:01.000Z"),
        git(1, ["worktree", "add"]),
        step("worktree", "2026-09-03T19:51:01.000Z", "2026-09-03T19:51:02.000Z"),
        git(2, ["merge", "task/one"]),
        step("compose", "2026-09-03T19:51:00.000Z", "2026-09-03T19:51:21.000Z"),
      ],
      at,
    )

    const steps = readJournals(dir, { now: at }).runs.get(journalKey("task/one", "abc123"))?.[0]?.steps
    expect(
      steps?.map((entry) => [entry.name, entry.ms, entry.unended, entry.commands.map((command) => command.args[0])]),
    ).toEqual([
      ["compose", 21_000, undefined, ["merge"]],
      ["worktree", 1_000, undefined, ["worktree"]],
    ])
  })

  it("marks a step a killed call left open inside its parent unended, and keeps a step the journal was cut after open (25441)", () => {
    const at = new Date("2026-09-03T20:00:00.000Z")
    const change = { branch: "task/one", head: "abc123" }
    const { dir } = journalDir(
      [
        { ...change, kind: "step", name: "compose", phase: "merge", start: "2026-09-03T19:51:00.000Z" },
        { ...change, kind: "step", name: "worktree", phase: "merge", start: "2026-09-03T19:51:01.000Z" },
        {
          ...change,
          end: "2026-09-03T19:51:09.000Z",
          kind: "step",
          ms: 9_000,
          name: "compose",
          phase: "merge",
          start: "2026-09-03T19:51:00.000Z",
          threw: true,
        },
        { ...change, kind: "step", name: "merge", phase: "merge", start: "2026-09-03T19:52:00.000Z" },
        {
          args: ["push", "origin"],
          cwd: "/w",
          evidence: "/w/logs/run/git/1.failed.json",
          failure: "spawn",
          kind: "git",
        },
      ],
      at,
    )

    const steps = readJournals(dir, { now: at }).runs.get(journalKey("task/one", "abc123"))?.[0]?.steps
    expect(
      steps?.map((step) => ({ name: step.name, unended: step.unended, ended: step.endedAt !== undefined })),
    ).toEqual([
      { name: "compose", unended: undefined, ended: true },
      { name: "worktree", unended: true, ended: false },
      { name: "merge", unended: undefined, ended: false },
    ])
    // A command that failed before it could write output names no files, and says why.
    expect(steps?.[2]?.commands).toEqual([{ args: ["push", "origin"], cwd: "/w", failure: "spawn" }])
  })

  it("rereads a journal when the file's mtime or size changes", () => {
    const at = new Date("2026-09-03T20:00:00.000Z")
    const { dir, run } = journalDir([{ branch: "task/one", head: "abc123", kind: "change" }], at)
    expect(readJournals(dir, { now: at }).runs.get(journalKey("task/one", "abc123"))).toHaveLength(1)
    appendFileSync(
      join(dir, `${run}.jsonl`),
      `${JSON.stringify({ at: at.toISOString(), branch: "task/two", head: "def456", kind: "change", run })}\n`,
    )
    const journals = readJournals(dir, { now: at })
    expect(journals.runs.get(journalKey("task/one", "abc123"))).toHaveLength(1)
    expect(journals.runs.get(journalKey("task/two", "def456"))).toHaveLength(1)
  })

  it("invalidates the journal cache when mtime changes at the same size", () => {
    const at = new Date("2026-09-03T20:00:00.000Z")
    const { dir, run } = journalDir([{ branch: "task/one", head: "abc123", kind: "change" }], at)
    const path = join(dir, `${run}.jsonl`)
    expect(readJournals(dir, { now: at }).runs.get(journalKey("task/one", "abc123"))).toHaveLength(1)
    const later = new Date(at.getTime() + 5_000)
    utimesSync(path, later, later)
    expect(readJournals(dir, { now: at }).runs.get(journalKey("task/one", "abc123"))).toHaveLength(1)
  })

  it("drops cached journals that leave the directory", () => {
    const at = new Date("2026-09-03T20:00:00.000Z")
    const { dir, run } = journalDir([{ branch: "task/one", head: "abc123", kind: "change" }], at)
    expect(readJournals(dir, { now: at }).runs.size).toBe(1)
    rmSync(join(dir, `${run}.jsonl`))
    expect(readJournals(dir, { now: at }).absent).toMatch(
      /holds no run journal|older than the window|no such directory/,
    )
  })

  it("says nothing is running once the run reached a decision, whatever start row it left open", () => {
    const at = new Date("2026-09-03T20:00:00.000Z")
    const { dir } = journalDir(
      [
        {
          branch: "task/one",
          head: "abc123",
          kind: "check",
          log: "/w/checks/test.log",
          name: "test",
          phase: "merge",
          start: "2026-09-03T19:59:00.000Z",
        },
        { branch: "task/one", decision: "failed", head: "abc123", kind: "change", reason: "test" },
      ],
      at,
    )

    const runs = readJournals(dir, { now: at }).runs.get(journalKey("task/one", "abc123"))
    expect(runs?.[0]?.decision).toBe("failed")
    expect(runs?.[0]?.running).toBeUndefined()
    const views = checksOf([], "failed", [], runs?.[0]?.running, runs?.[0]?.checks)
    expect(views[0]?.state).toBe("unmeasured")
    expect(views[0]?.result).toBeUndefined()
  })

  it.each(["change-ref-taken", "change-ref-contended"] as const)(
    "keeps a merged decision when a legacy %s sent-record race diagnostic follows it",
    (reason) => {
      const at = new Date("2026-09-03T20:00:00.000Z")
      const branch = "task/one"
      const head = "abc123"
      const { dir } = journalDir(
        [
          { branch, decision: "merged", head, kind: "change" },
          {
            branch,
            decision: "sent",
            head,
            intended: "record123",
            kind: "change",
            next: "git log --oneline --left-right record123...remote456",
            reason,
            ref: "refs/yrd/changes/task/one@abc123",
            relation: "behind",
            remote: "remote456",
            text: "the sent-record lease raced",
          },
          { branch, head, kind: "message", says: "merged", text: "merged task/one" },
        ],
        at,
      )

      // `now: at` anchors the seven-day journal window to the fixture's own
      // date; without it this test goes red by calendar once the hardcoded
      // date ages out — which is exactly how it spent four days reading as a
      // production regression (@i/10-yrd/24129).
      const read = () => readJournals(dir, { now: at })
      expect(read).not.toThrow()
      const runs = read().runs.get(journalKey(branch, head))
      expect(runs?.[0]?.decision).toBe("merged")
      expect(runs?.[0]?.reason).toBeUndefined()
    },
  )

  it("a non-terminal decision row cannot overwrite a terminal decision, and is named", () => {
    const at = new Date("2026-09-03T20:00:00.000Z")
    const branch = "task/one"
    const head = "abc123"
    const { dir, run } = journalDir(
      [
        { branch, decision: "merged", head, kind: "change" },
        // No race reason: this is not the known diagnostic shape, it is a
        // defective writer, and the fold must refuse it loudly rather than
        // fold the merged run to sent (@i/10-yrd/24129).
        { branch, decision: "sent", head, kind: "change", reason: "some-new-writer-defect" },
      ],
      at,
    )
    const runs = readJournals(dir, { now: at }).runs.get(journalKey(branch, head))
    expect(runs?.[0]?.decision).toBe("merged")
    expect(runs?.[0]?.malformed?.[0]).toContain("non-terminal decision")
    expect(runs?.[0]?.malformed?.[0]).toContain("sent")
    expect(runs?.[0]?.malformed?.[0]).toContain(run)
  })

  it("a run whose only decision row is non-terminal stays undecided — nothing is synthesised", () => {
    const at = new Date("2026-09-03T20:00:00.000Z")
    const branch = "task/one"
    const head = "abc123"
    const { dir } = journalDir([{ branch, decision: "sent", head, kind: "change", reason: "defect" }], at)
    const runs = readJournals(dir, { now: at }).runs.get(journalKey(branch, head))
    expect(runs?.[0]?.decision).toBeUndefined()
    expect(runs?.[0]?.malformed?.[0]).toContain("non-terminal decision")
  })

  // Was "still refuses a partial incident outside a change-ref race
  // diagnostic". 24408 supersedes the refusal, not the detection: a partial
  // incident that is not a race diagnostic is still a defect, and it is still
  // named — on the change it was about, where the reader is looking, instead
  // of as a throw that takes the other changes down with it.
  it("names a partial incident outside a change-ref race diagnostic without refusing the read", () => {
    const { dir, run } = journalDir([
      {
        branch: "task/one",
        decision: "stuck",
        head: "abc123",
        kind: "change",
        next: "repair the queue",
      },
      { branch: "task/two", decision: "merged", head: "def456", kind: "change" },
    ])

    const journals = readJournals(dir)

    const defect = journals.runs.get(journalKey("task/one", "abc123"))?.[0]?.malformed?.[0]
    expect(defect).toContain("incomplete incident")
    expect(defect).toContain(run)
    expect(defect).toContain(journalKey("task/one", "abc123"))
    // Only `next` was written, so the other five are the ones to name.
    expect(defect).toContain("missing code, subject, via, evidence, owner")
    expect(journals.runs.get(journalKey("task/two", "def456"))?.[0]?.decision).toBe("merged")
  })

  // @cto rider 2 on 24408: a field PRESENT but unreadable is a different bug
  // from one never written, and reporting them as one sends the reader back to
  // the JSONL to find out which they have. The five-undefined case above
  // cannot catch a reader that labels every defect "missing".
  it("tells a field that was never written apart from one that is not a string", () => {
    const { dir } = journalDir([
      { branch: "task/one", code: "check-failed", head: "abc123", kind: "change", owner: 7, subject: "task/one" },
    ])

    const defect = readJournals(dir).runs.get(journalKey("task/one", "abc123"))?.[0]?.malformed?.[0]
    expect(defect).toContain("missing via, evidence, next")
    expect(defect).toContain("not a string: owner")
  })

  // 24408: one short row from `waiting()` took every read verb down for the
  // journal's whole seven-day window while the queue itself was healthy and
  // merging. The accepted requirement is the bead's — a read verb DEGRADES on
  // a malformed row: it names the defect on the change that row was about and
  // reads everything else. The partial-incident tests around this one only
  // ever asserted the throw, so a reader that dropped B along with A, or the
  // whole run, or the whole file, would satisfy every one of them.
  it("one malformed row for change A does not hide change B's runs", () => {
    const { dir, run } = journalDir([
      { base: "aaa", checks: ["verify"], kind: "run", queue: "q", target: "main" },
      { branch: "task/a", code: "gitlink-off-main", decision: "stuck", head: "abc123", kind: "change" },
      { branch: "task/b", decision: "merged", head: "def456", kind: "change" },
      { branch: "task/b", commit: "landed", head: "def456", kind: "merge" },
    ])

    const journals = readJournals(dir)

    const defect = journals.runs.get(journalKey("task/a", "abc123"))?.[0]?.malformed?.[0]
    expect(defect).toContain("incomplete incident")
    expect(defect).toContain(run)
    expect(defect).toContain(journalKey("task/a", "abc123"))
    // The exact 24408 writer bug: a code and none of its five siblings. Naming
    // WHICH five is what saves the reader the trip to the JSONL with jq.
    expect(defect).toContain("missing subject, via, evidence, next, owner")
    // The defect is aggregated for the caller that prints it, never skipped in
    // silence, and the aggregate carries the same field names.
    expect(journals.malformed).toEqual([{ key: journalKey("task/a", "abc123"), message: defect, run }])
    expect(journals.malformed[0]?.message).toContain("missing subject, via, evidence, next, owner")
    const b = journals.runs.get(journalKey("task/b", "def456"))?.[0]
    expect(b).toMatchObject({ decision: "merged", merge: "landed" })
    expect(b?.malformed).toBeUndefined()
  })

  it("reads a deferred check result cleanly without marking the journal malformed (25029)", () => {
    const { dir } = journalDir([
      { base: "aaa", checks: ["affected-tests"], kind: "run", queue: "q", target: "main" },
      {
        branch: "task/wide",
        head: "abc123",
        kind: "check",
        log: "/w/checks/affected-tests.log",
        name: "affected-tests",
        phase: "merge",
        start: "2026-09-19T10:20:00.000Z",
      },
      {
        branch: "task/wide",
        exit: "3",
        head: "abc123",
        kind: "result",
        name: "affected-tests",
        phase: "merge",
        result: "deferred",
      },
    ])

    const journals = readJournals(dir)
    expect(journals.malformed).toEqual([])
    const check = journals.runs.get(journalKey("task/wide", "abc123"))?.[0]?.checks[0]
    expect(check).toMatchObject({
      name: "affected-tests",
      phase: "merge",
      result: "deferred",
      exit: "3",
    })
  })

  // 24202: CI's parse-only regressions above do not prove retention, attempted
  // vs recorded decisions, or the completion clock. Exercise the whole lifecycle.
  it.each([
    ["change-ref-taken", "next", "sent"],
    ["change-ref-contended", "inspect", "merged"],
  ] as const)("retains %s/%s diagnostics without adopting attempted %s decisions", (reason, field, decision) => {
    const first = new Date("2026-09-06T04:00:00.000Z")
    let at = first
    const dir = join(scratch("diagnostics"), "logs")
    const log = openLog(dir, () => at)
    const change = { branch: "task/one", head: "abc123" }
    const diagnostic = {
      ...change,
      kind: "change" as const,
      reason,
      decision,
      [field]: "git log --oneline --left-right intended...remote",
      text: "ref write failed: remote advanced",
      intended: "intended",
      remote: "remote",
    }
    log.write(diagnostic)
    const only = readJournals(dir, { now: at }).runs.get(journalKey(change.branch, change.head))?.[0]
    expect(only?.decision).toBeUndefined()
    expect(only?.diagnostics).toEqual([{ ...diagnostic, at: first.toISOString(), run: log.id }])
    expect(
      watchRows([{ ...change, state: "merged" }], {
        journals: readJournals(dir, { now: at }),
        perRun: true,
      })[0]?.row.endedAt,
    ).toBeUndefined()

    at = new Date(first.getTime() + 1000)
    log.write({ ...change, kind: "change", decision: "merged", reason: "already on the target" })
    log.write({ ...change, kind: "merge", commit: "landed" })
    const ended = at
    at = new Date(first.getTime() + 2000)
    log.write(diagnostic)
    const journals = readJournals(dir, { now: at })
    const run = journals.runs.get(journalKey(change.branch, change.head))?.[0]
    expect(run).toMatchObject({ decision: "merged", reason: "already on the target", merge: "landed", at: ended })
    expect(run?.incident).toBeUndefined()
    expect(run?.diagnostics).toEqual([
      { ...diagnostic, at: first.toISOString(), run: log.id },
      { ...diagnostic, at: at.toISOString(), run: log.id },
    ])
    const row = watchRows([{ ...change, state: "merged" }], { journals, perRun: true })[0]?.row
    expect(row).toMatchObject({ state: "merged", result: "pass", endedAt: ended, diagnostics: run?.diagnostics })
  })

  // A reserved reason must not bypass incident validation. 24408 changes what
  // "does not hide it" MEANS — the defect is reported on the change instead of
  // thrown — so the assertion moves from the throw to `malformed`. The rule
  // itself is untouched: a race reason still buys no exemption.
  it.each(["code", "subject", "via", "evidence", "owner"])(
    "does not let a race reason hide partial incident %s",
    (field) => {
      const { dir, run } = journalDir([
        {
          branch: "task/one",
          head: "abc123",
          kind: "change",
          decision: "stuck",
          reason: "change-ref-taken",
          next: "inspect the failure",
          [field]: "present",
        },
      ])
      const decided = readJournals(dir)
      expect(decided.runs.get(journalKey("task/one", "abc123"))?.[0]?.malformed?.[0]).toContain("incomplete incident")
      expect(decided.malformed).toEqual([
        { key: journalKey("task/one", "abc123"), message: expect.stringContaining("incomplete incident"), run },
      ])
      // The authority-field rule must hold even when no decision string was recorded.
      const undecided = journalDir([
        { branch: "task/one", head: "abc123", kind: "change", reason: "change-ref-taken", [field]: "present" },
      ])
      expect(readJournals(undecided.dir).runs.get(journalKey("task/one", "abc123"))?.[0]?.malformed?.[0]).toContain(
        "incomplete incident",
      )
    },
  )

  it("validates a complete incident even when its reason is reserved for ref-write diagnostics", () => {
    const incident = {
      code: "check-failed",
      subject: "task/one",
      via: "test",
      evidence: "/checks/test.log",
      next: "inspect the log",
      owner: "operator",
    }
    const record = {
      ...incident,
      branch: "task/one",
      head: "abc123",
      kind: "change",
      decision: "stuck",
      reason: "change-ref-contended",
    }
    const { dir } = journalDir([record])
    const run = readJournals(dir).runs.get(journalKey(record.branch, record.head))?.[0]
    expect(run?.incident).toEqual(incident)
    expect(run?.diagnostics).toBeUndefined()
    // The writer's own validator still judges the value; 24408 changes only
    // what its verdict costs — the row, not the read.
    const malformed = journalDir([{ ...record, evidence: "relative-path" }])
    const defect = readJournals(malformed.dir).runs.get(journalKey(record.branch, record.head))?.[0]
    expect(defect?.malformed?.[0]).toContain("not an absolute path")
    expect(defect?.incident).toBeUndefined()
  })

  it("an abandoned older run is unmeasured after a newer run, while the newest unended run stays live", () => {
    // A single decided-run fixture misses a process that died before writing
    // its decision. Serialization makes a subsequent run proof it is no longer live.
    const start = new Date("2026-09-03T19:00:00.000Z")
    const later = new Date("2026-09-03T20:00:00.000Z")
    const check = {
      branch: "task/one",
      head: "abc123",
      kind: "check" as const,
      name: "test",
      phase: "merge",
      log: "/w/old/test.log",
      start: start.toISOString(),
    }
    const { dir, run: oldId } = journalDir([check], start)
    const current: Row = { branch: check.branch, head: check.head, state: "failed" }
    const newestUnended = watchRows([current], { journals: readJournals(dir, { now: later }), perRun: true })[0]!
    expect(newestUnended.row.live?.run).toBe(oldId)
    expect(clocks(newestUnended.row, later).runtimeMs).toBe(60 * 60 * 1000)
    const log = openLog(dir, () => later)
    log.write({ ...check, log: "/w/new/test.log", start: later.toISOString() })
    log.write({ ...check, kind: "result", result: "fail", exit: "1" })
    log.write({ branch: check.branch, head: check.head, kind: "change", decision: "failed", reason: "test" })
    const rows = watchRows([current], { journals: readJournals(dir, { now: later }), perRun: true })
    expect(rows.map(({ row }) => row.run)).toEqual([log.id, oldId])
    const old = rows[1]!
    expect(old.row.live).toBeUndefined()
    expect(clocks(old.row, later).runtimeMs).toBeUndefined()
    const views = checksOf(
      [],
      "failed",
      [],
      old.row.live === undefined
        ? undefined
        : {
            name: old.row.live.check,
            log: old.row.live.log,
          },
      old.run?.checks,
    )
    expect(views[0]?.state).toBe("unmeasured")
    expect(rows[0]?.row).toMatchObject({ result: "fail test", run: log.id, log: "/w/new/test.log" })
  })

  it("says where it looked when there is no journal there at all, and never returns an empty answer silently", () => {
    const dir = join(scratch("nowhere"), "logs")

    const journals = readJournals(dir)

    expect(journals.dir).toBe(dir)
    expect(journals.absent).toContain(dir)
    expect(journals.absent).toContain("there is no such directory")
    expect(journals.runs.size).toBe(0)
  })

  it("says the journals it holds are all older than the window rather than reading none in silence", () => {
    const at = new Date("2026-09-03T20:00:00.000Z")
    const { dir } = journalDir([{ branch: "task/one", decision: "merged", head: "abc", kind: "change" }], at)

    const journals = readJournals(dir, { now: new Date("2026-10-03T20:00:00.000Z") })

    expect(journals.absent).toContain("older than the window")
    expect(journals.runs.size).toBe(0)
  })

  it("reads a run's start instant out of its own id, so a month of journals costs one readdir", () => {
    expect(runStartedAt("q-20260903T200000000Z-deadbeef")?.toISOString()).toBe("2026-09-03T20:00:00.000Z")
    expect(runStartedAt("not-one-of-ours.jsonl")).toBeUndefined()
  })
})

describe("the clocks", () => {
  const since = new Date("2026-09-03T19:00:00.000Z")
  const started = new Date("2026-09-03T19:30:00.000Z")
  const now = new Date("2026-09-03T20:00:00.000Z")
  // @i/10-yrd/24196 (review finding 3): an attempt's runtime is how long its checks ran, from its first check's
  // start to its decision, or to now while a check holds the row. A change waiting in line holds no check, so
  // nothing about it is running: a runtime that kept counting there read like a check that never ended.
  it("counts an attempt's runtime to now only while a check holds the row, never while a change waits in line", () => {
    const waits: Row = { branch: "task/one", head: "abc", since, startedAt: started, state: "checked" }
    const held: Row = { ...waits, live: { check: "test", phase: "merge", run: "q-1", since: started } }

    expect({
      checked: clocks(waits, now).runtimeMs,
      decided: clocks({ ...waits, endedAt: new Date("2026-09-03T19:45:00.000Z") }, now).runtimeMs,
      held: clocks(held, now).runtimeMs,
      queued: clocks({ ...waits, state: "queued" }, now).runtimeMs,
    }).toEqual({ checked: undefined, decided: 15 * 60 * 1000, held: 30 * 60 * 1000, queued: undefined })
  })

  // Git can prove a change merged or its branch disappeared without an ending
  // record. Missing evidence must not turn a stopped clock live.
  it.each(["merged", "failed", "stuck", "direct"] as const)(
    "leaves runtime unknown for a %s change with no recorded ending time",
    (state) => {
      const row: Row = { branch: "task/one", head: "abc", since, startedAt: started, state }
      expect(clocks(row, now).runtimeMs).toBeUndefined()
    },
  )

  it("leaves runtime ABSENT when nothing recorded that checking began, rather than answering zero", () => {
    const row: Row = {
      branch: "task/one",
      head: "abc",
      live: { check: "test", phase: "merge", run: "q-1", since: started },
      since,
      state: "queued",
    }

    expect(clocks(row, now).runtimeMs).toBeUndefined()
  })

  // 24196 (A2-set-v2 items 4 and 5, superseding decisions 5 and 6's basis): a row shows ONE clock, the
  // instant its place in the table is ordered by, and one duration whose word names its basis. They are
  // named fields derived here once, never a renderer's relabel of another clock: `clockAt` is the submit instant
  // while the change is in line, held and stuck rows included, and its ending record's instant once it
  // ended (never the notice sent after it); `waitingMs` is now less the submit for every change in line,
  // absent while its check runs and once it ended; `checkingMs` is how long the check running now has run;
  // `tookMs` is an ended change's submit to its end; `stuckMs` is how long a stuck change has been stuck,
  // from its OWN stuck record (A2-set-v4: the stop record a round writes after it is the top line's
  // "line stopped since T", and a second stuck change under an older stop has no stop record of its own).
  // The fields are read through a cast only until they exist, so this file compiles red-first.
  it("names the one clock a row is ordered by, and its durations: waiting since submit for every change in line, this check's run time, stuck since its own stuck record, took from submit to end", () => {
    const opened = new Date("2026-09-03T19:48:00.000Z")
    const stuckAt = new Date("2026-09-03T19:50:00.000Z")
    const withdrawnAt = new Date("2026-09-03T19:40:00.000Z")
    const passed = new Date("2026-09-03T19:57:00.000Z")
    const noticed = new Date("2026-09-03T19:59:00.000Z")
    const checkStarted = new Date("2026-09-03T19:56:30.000Z")
    const queued: Row = { at: opened, branch: "task/queued", head: "abc", since: opened, state: "queued" }
    const checked: Row = {
      at: passed,
      branch: "task/checked",
      head: "abd",
      since,
      startedAt: started,
      state: "checked",
    }
    const stuck: Row = { at: stuckAt, branch: "task/stuck", endedAt: stuckAt, head: "abe", since, state: "stuck" }
    const running: Row = { ...checked, live: { check: "test", phase: "merge", run: "q-1", since: checkStarted } }
    // The tip is the notice sent after the merge: the ending is the merged record's instant, not the notice's.
    const merged: Row = { ...checked, at: noticed, endedAt: passed, state: "merged" }
    const withdrawn: Row = {
      at: withdrawnAt,
      branch: "task/withdrawn",
      endedAt: withdrawnAt,
      head: "abf",
      since,
      state: "withdrawn",
    }
    const read = (row: Row) => {
      const measured = clocks(row, now) as Readonly<Record<string, unknown>>
      return {
        checkingMs: measured["checkingMs"],
        clockAt: measured["clockAt"],
        stuckMs: measured["stuckMs"],
        tookMs: measured["tookMs"],
        waitingMs: measured["waitingMs"],
      }
    }
    const minutes = (count: number): number => count * 60 * 1000
    const none = { checkingMs: undefined, stuckMs: undefined, tookMs: undefined, waitingMs: undefined }

    expect({
      checked: read(checked),
      merged: read(merged),
      queued: read(queued),
      running: read(running),
      stuck: read(stuck),
      withdrawn: read(withdrawn),
    }).toEqual({
      checked: { ...none, clockAt: since, waitingMs: minutes(60) },
      merged: { ...none, clockAt: passed, tookMs: minutes(57) },
      queued: { ...none, clockAt: opened, waitingMs: minutes(12) },
      running: { ...none, checkingMs: minutes(3) + 30_000, clockAt: since },
      stuck: { ...none, clockAt: since, stuckMs: minutes(10), waitingMs: minutes(60) },
      withdrawn: { ...none, clockAt: withdrawnAt, tookMs: minutes(40) },
    })
  })
})

/**
 * @failure  The operator, 2026-09-16 21:34 PDT: "also the ordering looks weird - look at the time stamps".
 *           Ended rows were ordered by their tip's instant, and the tip of a merged change is the notice
 *           sent after it, so a merge rose to the top whenever its notice went out again; the change the
 *           runner holds sat wherever its place in line put it; and a branch pushed without a submit was
 *           nowhere (@i/10-yrd/24196, decision 4; the operator's v3 words).
 * @level    l1 (the table read from records built in memory)
 * @consumer the operator reading `yrd watch` and `yrd list`, top to bottom
 */
describe("the table's one order (24196)", () => {
  const now = new Date("2026-09-03T20:00:00.000Z")
  const ago = (minutes: number): Date => new Date(now.getTime() - minutes * 60 * 1000)
  let shas = 0
  const sha = (): string => (shas += 1).toString(16).padStart(40, "0")

  /** One change's records, oldest first, each carrying its name and when it was opened, as every record does. */
  function change(
    branch: string,
    opened: Date,
    steps: readonly Readonly<{
      kind: ChangeRecord["kind"]
      at: Date
      trailers?: readonly (readonly [string, string])[]
    }>[],
    over: Partial<Pick<QueueEntry["change"], "headOnTarget" | "branchHead">> = {},
  ): QueueEntry {
    const head = sha()
    const record = (kind: ChangeRecord["kind"], at: Date, trailers: readonly (readonly [string, string])[] = []) => ({
      at,
      kind,
      sha: sha(),
      subject: kind,
      trailers: [
        ["Record", kind],
        ["Change", `${branch}@${head}`],
        ["Opened", opened.toISOString()],
        ...trailers,
      ] as const,
    })
    const records = [record("opened", opened), ...steps.map((step) => record(step.kind, step.at, step.trailers))] as [
      ChangeRecord,
      ...ChangeRecord[],
    ]
    const changeRecords = { branch, branchHead: head, head, headOnTarget: false, records, ...over }
    return { change: changeRecords, reading: readChange(changeRecords) }
  }

  it("puts the change the runner holds first, then the line by its places, stuck where it stands, then the ended rows newest ending first, then the drafts newest first", () => {
    const pending = change("task/a-pending", ago(60), [{ at: ago(3), kind: "checked" }])
    const held = change("task/b-held", ago(50), [])
    const incident = incidentTrailers({
      code: "yrd-check-unresolved",
      evidence: "/w/logs/q-1.jsonl",
      next: "repair and resume",
      owner: "the queue's operator",
      subject: "the check could not be resolved",
      via: "affected-tests",
    })
    const stuck = change("task/c-stuck", ago(40), [{ at: ago(6), kind: "stuck", trailers: incident }])
    const submitted = change("task/d-submitted", ago(30), [])
    const merged = change(
      "task/e-merged",
      ago(90),
      [
        { at: ago(80), kind: "checked" },
        { at: ago(10), kind: "merged" },
        // The notice, a minute ago: the change ended nine minutes before it.
        {
          at: ago(1),
          kind: "sent",
          trailers: [
            ["State", "merged"],
            ["Delivery", "sent"],
            ["To", "@dev/2"],
          ],
        },
      ],
      { headOnTarget: true },
    )
    const failed = change("task/f-failed", ago(70), [{ at: ago(5), kind: "failed", trailers: [["Reason", "test"]] }])
    const withdrawn = change("task/g-withdrawn", ago(100), [{ at: ago(20), kind: "withdrawn" }])
    const run = "q-20260903T195500000Z-0000b0b0"
    const check = { name: "affected-tests", phase: "submit", startedAt: ago(4) }
    const journals = {
      dir: "/w/logs",
      malformed: [],
      runs: new Map([
        [
          journalKey(held.change.branch, held.change.head),
          [
            {
              at: ago(4),
              branch: held.change.branch,
              checks: [check],
              head: held.change.head,
              id: run,
              running: check,
              startedAt: ago(5),
            },
          ],
        ],
      ]),
    }
    const directMerges = [
      {
        at: ago(15),
        commit: sha(),
        gitlinks: [],
        parents: [],
        subject: "a hotfix",
        target: "main",
        why: "a direct push",
      },
    ]
    // The drafts as the one derivation reads them (drafts.ts): the branch, its head, and its head commit's
    // author and instant.
    const drafts = [
      { author: "ada", branch: "task/h-draft-older", committedAt: ago(120), head: sha(), movedSinceSubmit: false },
      { author: "grace", branch: "task/i-draft-newer", committedAt: ago(30), head: sha(), movedSinceSubmit: false },
    ]

    const rows = list([withdrawn, submitted, merged, held, failed, stuck, pending], {
      directMerges,
      drafts,
      journals,
      now,
    } as Parameters<typeof list>[1])

    expect(rows.map((row) => row.branch)).toEqual([
      "task/b-held",
      "task/a-pending",
      "task/c-stuck",
      "task/d-submitted",
      "task/f-failed",
      "task/e-merged",
      "main",
      "task/g-withdrawn",
      "task/i-draft-newer",
      "task/h-draft-older",
    ])
  })
})

describe("the declared checks, joined to what ran", () => {
  const declared: readonly CheckSpec[] = [
    { name: "typecheck", run: "bun run typecheck" },
    { name: "test", run: "bun run test" },
    { name: "lint", run: "bun run lint" },
  ]

  it("keeps candidate failure and green baseline comparator as separate measured occurrences", () => {
    const startedAt = new Date("2026-09-03T20:00:00Z")
    const measured = [
      {
        name: "test",
        phase: "merge",
        startedAt,
        endedAt: startedAt,
        result: "fail" as const,
        log: "/candidate/test.log",
      },
      { name: "test", phase: "base", startedAt, endedAt: startedAt, result: "pass" as const, log: "/base/test.log" },
    ]
    const views = checksOf([], "failed", [{ name: "test", run: "test" }], undefined, measured)
    expect(views.map((view) => [view.name, view.phase, view.state, view.log])).toEqual([
      ["test", "merge", "failed", "/candidate/test.log"],
      ["test", "base", "passed", "/base/test.log"],
    ])
    const current: Row = { branch: "task/one", head: "abc", state: "failed" }
    const projected = watchRows([current], {
      perRun: true,
      journals: {
        dir: "/logs",
        malformed: [],
        runs: new Map([
          [
            journalKey(current.branch, current.head),
            [{ ...current, id: "q", startedAt, at: startedAt, checks: measured, decision: "failed" }],
          ],
        ]),
      },
    })
    expect(projected[0]?.row.log).toBe("/candidate/test.log")
    expect(projected[0]?.row.result).toBe("fail test")
  })

  it("renders every check after a failing one as NOT RUN, with the command that would have run it", () => {
    const views = checksOf(
      ["typecheck exit=0 ms=1000 log=/w/typecheck.log", "test exit=1 ms=2000 log=/w/test.log"],
      "failed",
      declared,
    )

    expect(views.map((view) => [view.name, view.state])).toEqual([
      ["typecheck", "passed"],
      ["test", "failed"],
      ["lint", "not-run"],
    ])
    // S2.21: the command lives with the result, so a reader never has to guess
    // what produced a log.
    expect(views[2]?.spec?.run).toBe("bun run lint")
    expect(views[1]?.log).toBe("/w/test.log")
  })

  it('reads a check declared `run: "true"` as off, never passed, whether or not it ran (25422)', () => {
    const views = checksOf(["typecheck exit=0 ms=0 log=/w/typecheck.log"], "merged", [
      { name: "typecheck", run: "true" },
      { name: "affected-tests", run: " true " },
      { name: "test", run: "bun run test" },
    ])

    expect(views.map((view) => [view.name, view.state])).toEqual([
      ["typecheck", "off"],
      ["affected-tests", "off"],
      ["test", "not-run"],
    ])
  })

  it("reads a packed exit=3 as stuck: cannot-judge is never a fail (@cto 7645ec3a)", () => {
    const views = checksOf(["affected-tests exit=3 ms=5 log=/w/affected.log"], "stuck", [
      { name: "affected-tests", run: "bun run affected-tests" },
    ])

    expect(views.map((view) => [view.name, view.state, view.result?.result])).toEqual([
      ["affected-tests", "stuck", "stuck"],
    ])
  })

  it("reads a packed check's OWN exit even when the change's ending disagrees — the shape a merge conflict makes: every check passed, the change still ended failed", () => {
    // Before the fix, the LAST packed trailer's verdict was inferred from the
    // change's ending ("failed" -> fail) rather than read from its own exit.
    // A change can end failed for a reason no check made, and a check that
    // exited 0 must stay passed regardless of where it sits in the list.
    const twoChecks: readonly CheckSpec[] = [
      { name: "typecheck", run: "bun run typecheck" },
      { name: "lint", run: "bun run lint" },
    ]
    const views = checksOf(
      ["typecheck exit=0 ms=1000 log=/w/typecheck.log", "lint exit=0 ms=500 log=/w/lint.log"],
      "failed",
      twoChecks,
    )

    expect(views.map((view) => [view.name, view.state])).toEqual([
      ["typecheck", "passed"],
      ["lint", "passed"],
    ])
  })

  it("marks the check the journal says is running now, and keeps its log path", () => {
    const views = checksOf(["typecheck exit=0 ms=1000 log=/w/typecheck.log"], "open", declared, {
      log: "/w/test.log",
      name: "test",
    })

    expect(views.map((view) => view.state)).toEqual(["passed", "running", "not-run"])
    expect(views[1]?.log).toBe("/w/test.log")
  })

  it("uses only the selected run's measured checks, including an end without a result", () => {
    // Historical detail must not mix a current failed trailer into an older
    // run, nor turn an interrupted result write into an invented pass.
    const startedAt = new Date("2026-09-03T20:00:00Z")
    const views = checksOf(["lint exit=1 ms=5 log=/later/lint.log"], "failed", declared, undefined, [
      {
        name: "typecheck",
        phase: "merge",
        startedAt,
        endedAt: startedAt,
        result: "stuck",
        exit: "missing",
        log: "/old/typecheck.log",
      },
      { name: "test", phase: "merge", startedAt, endedAt: startedAt, log: "/old/test.log" },
    ])
    expect(views.map((view) => view.state)).toEqual(["stuck", "unmeasured", "not-run"])
    expect(views[0]?.result).toMatchObject({ result: "stuck", exit: "missing", log: "/old/typecheck.log" })
    expect(views[1]?.result).toBeUndefined()
    expect(views[1]?.log).toBe("/old/test.log")
    expect(views[2]?.log).toBeUndefined()
    expect(
      checksOf(["lint exit=1 ms=5 log=/later/lint.log"], "failed", declared, undefined, []).every(
        (view) => view.state === "not-run",
      ),
    ).toBe(true)
  })

  it("keeps a measured result the declaration no longer names, and says its command is not knowable", () => {
    const views = checksOf(["gone exit=1 ms=5 log=/w/gone.log"], "failed", [
      { name: "typecheck", run: "bun run typecheck" },
    ])

    expect(views.map((view) => [view.name, view.state])).toEqual([
      ["typecheck", "not-run"],
      ["gone", "failed"],
    ])
    // Absent, never an empty command string presented as if it were one.
    expect(views[1]?.spec).toBeUndefined()
  })
})

describe("who acts next", () => {
  it("is the queue while the queue still owes the change work", () => {
    expect(nextOwner({ state: "queued" })?.owner).toBe("the queue")
    expect(nextOwner({ state: "checked" })?.owner).toBe("the queue")
  })

  it("is the submitter once it failed, because only they can move the branch", () => {
    const next = nextOwner({ reason: "test", state: "failed" }, { submitter: "@dev/2" })

    expect(next?.owner).toBe("@dev/2")
    expect(next?.because).toContain("test")
  })

  it("is nobody once it merged", () => {
    expect(nextOwner({ state: "merged" })).toBeUndefined()
  })

  it("points a stuck change at the evidence rather than inventing a person no record names", () => {
    const next = nextOwner({ reason: "setup", state: "stuck" }, { journal: "/w/logs" })

    expect(next?.owner).toBe("the queue's operator")
    expect(next?.because).toContain("/w/logs")
  })
})

describe("the head subjects", () => {
  it("reads every subject in ONE call and simply omits a head this repository has not fetched", async () => {
    const root = scratch("subjects")
    const git = gitIn(root)
    await git(["init", "--quiet", "--initial-branch=main", root])
    await git(["config", "user.email", "queue@yrd.test"])
    await git(["config", "user.name", "yrd"])
    mkdirSync(join(root, "src"), { recursive: true })
    writeFileSync(join(root, "src", "one.txt"), "one\n")
    await git(["add", "."])
    await git(["commit", "--quiet", "-m", "the first change's own subject"])
    const head = (await git(["rev-parse", "HEAD"])).trim()
    const absent = "0".repeat(40)

    const found = await subjects(git, [head, absent])

    expect(found.get(head)).toBe("the first change's own subject")
    // Not an empty string, which would read on screen as a change with no
    // subject rather than one this repository has not fetched.
    expect(found.has(absent)).toBe(false)
  })

  it("titles a merge-only re-cut by the change's own newest commit, never the merge's subject (25425)", async () => {
    const root = scratch("subjects-recut")
    const git = gitIn(root)
    await git(["init", "--quiet", "--initial-branch=main", root])
    await git(["config", "user.email", "queue@yrd.test"])
    await git(["config", "user.name", "yrd"])
    const commit = async (file: string, message: string): Promise<void> => {
      writeFileSync(join(root, file), `${file}\n`)
      await git(["add", "."])
      await git(["commit", "--quiet", "-m", message])
    }
    await commit("base.txt", "main's base")
    await git(["checkout", "--quiet", "-b", "task/one"])
    await commit("one.txt", "fix(parser): keep the last token")
    const own = (await git(["rev-parse", "HEAD"])).trim()
    // Two re-cuts in a row: main moved twice, and each time only main was merged in.
    for (const step of ["first", "second"]) {
      await git(["checkout", "--quiet", "main"])
      await commit(`${step}.txt`, `main moved: ${step}`)
      await git(["checkout", "--quiet", "task/one"])
      await git(["merge", "--quiet", "--no-edit", "main"])
    }
    const recut = (await git(["rev-parse", "HEAD"])).trim()

    const found = await subjects(git, [own, recut])

    expect(found.get(own)).toBe("fix(parser): keep the last token")
    expect(found.get(recut)).toBe("fix(parser): keep the last token")
  })

  it("asks git nothing at all for an empty table, because git with no revision walks HEAD", async () => {
    let asked = 0
    const git: Git = async () => {
      asked += 1
      return ""
    }

    expect((await subjects(git, [])).size).toBe(0)
    expect(asked).toBe(0)
  })
})

/**
 * @failure A merge check an override held off reads as "not run", which is the absence C5 forbids.
 * @level l1 @consumer `yrd show` and the watch's check tabs
 */
describe("a check an override skipped (25296 X3)", () => {
  it("reads skipped from the merged record's Skipped: trailer, and a check with no trailer stays not-run", () => {
    const records = [
      {
        trailers: [
          ["Check", "lint exit=0 ms=10 log=/l.log"],
          ["Skipped", "verify override=aaaa by=@dev/3 (claimed) until=2026-09-23T23:00:00.000Z"],
        ] as const,
      },
    ]
    const skipped = skippedChecks(records)
    expect([...skipped]).toEqual(["verify"])
    const declared = [
      { name: "verify", run: "verify" },
      { name: "other", run: "other" },
    ]
    const views = checksOf([], "merged", declared, undefined, undefined, skipped)
    expect(views.map((view) => [view.name, view.state])).toEqual([
      ["verify", "skipped"],
      ["other", "not-run"],
    ])
  })
})
