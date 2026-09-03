/**
 * @failure A change's state is prose in the plan and a stored column in the
 *          code, so the rebuild at M4 could keep any status it likes and every
 *          existing test would still pass. Nothing pins that the five states
 *          are DERIVED — that ancestry beats the fact table, that a position
 *          renumbers when the change ahead leaves, that two readers of one
 *          fact table agree, that a reader holding only git can answer at all.
 * @level   l3
 * @consumer `yrd queue list` · `yrd queue show` · an author asking where their
 *           change stands · anyone reading the queue from a second checkout
 *
 * Black box, on the M1 harness. A case here reads the CLI's own `--json`
 * answer, the refs, and the target's tip — never a journal, never a module.
 *
 * WRITTEN FROM THE PLAN (`pm/@i/10-yrd/plan.md` § The final design, § The
 * change, the state rule), not from the code:
 *
 *   queued    an opened fact and no checked fact
 *   checked   a checked fact and no ended fact after it
 *   stuck     the last fact is ended with stuck; the change keeps its place
 *   merged    the head is an ancestor of the target — AND ANCESTRY WINS OVER
 *             ANY FACT, so a change merged around the queue reads merged before any
 *             queue run has appended the merged fact
 *   failed    the last fact is ended with fail; the row is still listed
 *
 * and: position in line is the order of the opened facts; `queue list` shows
 * every change in line with state, position, last result and log path, work
 * item, failed rows included and merged rows below; nothing stores a status,
 * so two readers of one fact table must never disagree.
 *
 * Each case used to carry what it cost against the retired implementation —
 * `today: green` or `today: red — <what it did instead>`, measured on yrd main
 * at fce445eb on 2026-09-02. The core they were measured against is gone and
 * every case passes, so the names say what the case is about and nothing else.
 */
import { readFile } from "node:fs/promises"
import { afterEach, describe, expect, it } from "vitest"
import {
  boundaryRepository,
  mergeAroundQueue,
  queueRunOnce,
  refreshSecondReader,
  removeTemporaryRoots,
  secondReader,
  submitOneCommit,
  targetTip,
  yrdJson,
  type YrdJsonResult,
} from "./fixture.ts"

afterEach(removeTemporaryRoots)

/** The five, and only the five. § The words: "Change states, all derived". */
const PLAN_STATES = ["queued", "checked", "stuck", "merged", "failed"] as const
type PlanState = (typeof PLAN_STATES)[number]

/** The states a change is still in line in — the ones `queue list` positions. */
const IN_LINE: readonly string[] = ["queued", "checked", "stuck"]

/**
 * One row of `queue list`. The plan names the columns; the types are what a
 * reader can do with them. `head` is whatever the reader chose to print, full
 * or abbreviated — `headIs` below is the only place that compares one.
 */
type PlanRow = Readonly<Record<string, unknown>> & { branch?: unknown; head?: unknown; state?: unknown }

/**
 * Every change `queue list` reports, in the order it reported them. The ONE
 * place that knows the reader's shape: the plan says `queue list` answers with
 * the changes in line, so a reader that answers with something else fails here,
 * once, saying what it answered with instead.
 */
async function changesListed(repo: string): Promise<{ rows: readonly PlanRow[]; result: YrdJsonResult }> {
  const result = await yrdJson(repo, "queue", "list")
  if (result.exitCode !== 0) throw new Error(`queue list did not answer\n${result.report}`)
  if (typeof result.json !== "object" || result.json === null) {
    throw new Error(`queue list answered with no JSON object, so it named no changes\n${result.report}`)
  }
  const changes = (result.json as { changes?: unknown }).changes
  if (!Array.isArray(changes)) {
    throw new Error(
      `queue list answered with keys ${Object.keys(result.json).join(",")} and no 'changes' array\n${result.report}`,
    )
  }
  return { rows: changes as readonly PlanRow[], result }
}

/** The row for one branch, or a failure naming every branch the reader did list. */
function rowFor(rows: readonly PlanRow[], branch: string, report: string): PlanRow {
  const row = rows.find((candidate) => candidate.branch === branch)
  if (row === undefined) {
    const listed = rows.map((candidate) => String(candidate.branch)).join(", ") || "nothing"
    throw new Error(`queue list did not list ${branch}; it listed ${listed}\n${report}`)
  }
  return row
}

/** A row's state, checked against the plan's vocabulary before it is compared. */
function stateOf(row: PlanRow, report: string): PlanState {
  const state = row.state
  if (typeof state !== "string") throw new Error(`the row for ${String(row.branch)} carries no state\n${report}`)
  if (!(PLAN_STATES as readonly string[]).includes(state)) {
    throw new Error(
      `the row for ${String(row.branch)} reads '${state}', which is not one of ${PLAN_STATES.join(", ")}\n${report}`,
    )
  }
  return state as PlanState
}

/** Does a row's head name this sha? The reader may abbreviate it. */
function headIs(row: PlanRow, sha: string): boolean {
  const head = row.head
  return typeof head === "string" && head.length >= 7 && sha.startsWith(head)
}

/**
 * Where the branch's newest change stands, as `queue show` answers — the
 * second reader of the same fact table. § Commands: `queue show <branch>` is
 * "its changes newest first, each check's result and log", so the newest
 * change's state is the first thing it has to be able to say.
 */
async function stateFromShow(repo: string, branch: string): Promise<{ state: string; report: string }> {
  const result = await yrdJson(repo, "queue", "show", branch)
  if (result.exitCode !== 0) throw new Error(`queue show ${branch} did not answer\n${result.report}`)
  if (typeof result.json !== "object" || result.json === null) {
    throw new Error(`queue show ${branch} answered with no JSON object\n${result.report}`)
  }
  const answer = result.json as { changes?: unknown; state?: unknown }
  const newest = Array.isArray(answer.changes) ? (answer.changes[0] as PlanRow | undefined) : undefined
  const state = newest?.state ?? answer.state
  if (typeof state !== "string") {
    throw new Error(
      `queue show ${branch} answered with keys ${Object.keys(answer).join(",")} and named no change state, ` +
        `so it cannot be compared with queue list\n${result.report}`,
    )
  }
  return { state, report: result.report }
}

describe("a change's state, derived", { timeout: 180_000 }, () => {
  it("queued — an opened change the queue has not checked stands first in line", async () => {
    const { repo } = await boundaryRepository({ exit: 0 })
    const { branch, headSha } = await submitOneCommit(repo, "alpha")

    const { rows, result } = await changesListed(repo)
    const row = rowFor(rows, branch, result.report)

    expect(stateOf(row, result.report), result.report).toBe("queued")
    expect(headIs(row, headSha), `${result.report}\nrow head: ${String(row.head)}`).toBe(true)
    expect(row.position, result.report).toBe(1)
  })

  it("checked — a change whose checks passed but which has not landed is checked", async () => {
    // Two changes and one queue run: the first in line merges, the second is
    // left checked. There is no other way, at the boundary, to reach the state
    // between "checks passed" and "landed".
    const { repo } = await boundaryRepository({ exit: 0 })
    const first = await submitOneCommit(repo, "alpha")
    const second = await submitOneCommit(repo, "beta")

    await queueRunOnce(repo)

    const { rows, result } = await changesListed(repo)
    expect(stateOf(rowFor(rows, first.branch, result.report), result.report), result.report).toBe("merged")
    expect(stateOf(rowFor(rows, second.branch, result.report), result.report), result.report).toBe("checked")
  })

  it("stuck — a change the queue could not judge keeps its place in line", async () => {
    // A check that exits 2 is the queue's own fault: § The queue run makes it
    // stuck, and § The words says a stuck change keeps its place.
    const { repo } = await boundaryRepository({ exit: 2 })
    const { branch } = await submitOneCommit(repo, "two")

    await queueRunOnce(repo)

    const { rows, result } = await changesListed(repo)
    const row = rowFor(rows, branch, result.report)
    expect(stateOf(row, result.report), result.report).toBe("stuck")
    expect(row.position, `a stuck change keeps its place\n${result.report}`).toBe(1)
  })

  it("failed — an ended change is still a row on the table", async () => {
    // § Principles 7: "failed changes are rows on the table like any other".
    const { repo } = await boundaryRepository({ exit: 1 })
    const { branch, headSha } = await submitOneCommit(repo, "red")

    await queueRunOnce(repo)

    const { rows, result } = await changesListed(repo)
    const row = rowFor(rows, branch, result.report)
    expect(stateOf(row, result.report), result.report).toBe("failed")
    expect(headIs(row, headSha), `${result.report}\nrow head: ${String(row.head)}`).toBe(true)
  })

  it("merged — a change whose head reached the target has left the line", async () => {
    const { repo } = await boundaryRepository({ exit: 0 })
    const { branch } = await submitOneCommit(repo, "alpha")

    await queueRunOnce(repo)

    const { rows, result } = await changesListed(repo)
    const row = rowFor(rows, branch, result.report)
    expect(stateOf(row, result.report), result.report).toBe("merged")
    // Position is position IN LINE, and a merged change is not in it.
    expect(row.position, `a merged change holds no place in line\n${result.report}`).toBeUndefined()
  })

  it("merged — ancestry wins over any fact: a bypass reads merged before any queue run", async () => {
    // The rule the whole area turns on. § The change: "merged if its head is an
    // ancestor of the target, and ancestry wins over any fact (a change merged
    // around the queue in the garage shows merged, and the next queue run appends the
    // merged fact so the tip catches up)". The state is read from git, so the
    // reader answers merged with the fact table still saying queued.
    const { repo } = await boundaryRepository({ exit: 0 })
    const { branch, headSha } = await submitOneCommit(repo, "byhand")

    const before = await targetTip(repo)
    const tip = await mergeAroundQueue(repo, headSha)
    expect(tip, "the bypass did not move the target").not.toBe(before)

    const { rows, result } = await changesListed(repo)
    const row = rowFor(rows, branch, result.report)
    expect(stateOf(row, result.report), `the head is an ancestor of the target\n${result.report}`).toBe("merged")
    expect(row.position, `a merged change holds no place in line\n${result.report}`).toBeUndefined()
  })

  it("position — the change behind a merged one moves up, because nothing stores a position", async () => {
    const { repo } = await boundaryRepository({ exit: 0 })
    const first = await submitOneCommit(repo, "alpha")
    const second = await submitOneCommit(repo, "beta")

    const before = await changesListed(repo)
    expect(rowFor(before.rows, second.branch, before.result.report).position, before.result.report).toBe(2)

    await queueRunOnce(repo)

    const after = await changesListed(repo)
    expect(stateOf(rowFor(after.rows, first.branch, after.result.report), after.result.report)).toBe("merged")
    expect(
      rowFor(after.rows, second.branch, after.result.report).position,
      `the change ahead left the line, so this one is first\n${after.result.report}`,
    ).toBe(1)
  })

  it("position — the order of the opened facts is the order of the line", async () => {
    const { repo } = await boundaryRepository({ exit: 0 })
    const first = await submitOneCommit(repo, "alpha")
    const second = await submitOneCommit(repo, "beta")
    const third = await submitOneCommit(repo, "gamma")

    const { rows, result } = await changesListed(repo)
    const inLine = rows.filter((row) => IN_LINE.includes(String(row.state)))
    expect(
      inLine.map((row) => [row.branch, row.position]),
      result.report,
    ).toEqual([
      [first.branch, 1],
      [second.branch, 2],
      [third.branch, 3],
    ])
  })

  it("two readers of one fact table never disagree — queue list and queue show tell an author the same thing", async () => {
    // § Principle 2 and § Commands: nothing stores a status, so both commands
    // derive from the same facts. Four states, four repositories, because the
    // disagreement that matters is the one an author hits on a change of theirs
    // that ended badly.
    const cases: readonly { readonly bay: string; readonly exit: number; readonly run: boolean }[] = [
      { bay: "queued", exit: 0, run: false },
      { bay: "merged", exit: 0, run: true },
      { bay: "failed", exit: 1, run: true },
      { bay: "stuck", exit: 2, run: true },
    ]
    for (const one of cases) {
      const { repo } = await boundaryRepository({ exit: one.exit })
      const { branch } = await submitOneCommit(repo, one.bay)
      if (one.run) await queueRunOnce(repo)

      const { rows, result } = await changesListed(repo)
      const listed = stateOf(rowFor(rows, branch, result.report), result.report)
      const shown = await stateFromShow(repo, branch)

      expect(shown.state, `queue list says '${listed}' for ${branch}\n${shown.report}`).toBe(listed)
    }
  })

  it("nothing is stored — a reader holding only the git store derives the same states", async () => {
    // § Principle 1: "Git is the truth. Every fact is a ref or a commit."
    // § The final design: "There is one store: the git repository." A checkout
    // that never ran the queue holds nothing else, so what it can say about a
    // change is exactly what the git store holds — and that has to be the same
    // answer the queue's own checkout gives.
    const { repo, origin } = await boundaryRepository({ exit: 0 })
    const { branch } = await submitOneCommit(repo, "alpha")
    const reader = await secondReader(origin)

    const queued = await changesListed(repo)
    const queuedElsewhere = await changesListed(reader)
    expect(
      stateOf(rowFor(queuedElsewhere.rows, branch, queuedElsewhere.result.report), queuedElsewhere.result.report),
      `the queue's own checkout says '${stateOf(rowFor(queued.rows, branch, queued.result.report), queued.result.report)}'\n${queuedElsewhere.result.report}`,
    ).toBe("queued")

    await queueRunOnce(repo)
    await refreshSecondReader(reader)

    const merged = await changesListed(reader)
    expect(stateOf(rowFor(merged.rows, branch, merged.result.report), merged.result.report), merged.result.report).toBe(
      "merged",
    )
  })

  it("a row names its issue", async () => {
    // § The change: "the convention is `<issue>-<slug>`"; § Commands:
    // `queue list` shows the issue. A branch that carries one has to reach
    // the row, because the issue is how the queue's table joins the bead
    // table.
    const { repo } = await boundaryRepository({ exit: 0 })
    const { branch } = await submitOneCommit(repo, "24058-derived")

    const { rows, result } = await changesListed(repo)
    const row = rowFor(rows, branch, result.report)
    const issue = row.issue
    expect(
      typeof issue === "string" ? issue : `no issue on a row with keys ${Object.keys(row).join(",")}`,
      result.report,
    ).toContain("24058")
  })

  it("a row names its last result and the log that result came from", async () => {
    // § Commands: `queue list` shows "last result and log path". A failed row
    // an author cannot open is a row that tells them to go and ask the queue.
    const { repo } = await boundaryRepository({ exit: 1 })
    const { branch } = await submitOneCommit(repo, "red")

    await queueRunOnce(repo)

    const { rows, result } = await changesListed(repo)
    const row = rowFor(rows, branch, result.report)
    expect(String(row.result), result.report).toContain("fail")

    const log = row.log
    expect(
      typeof log === "string" && log !== "",
      `the row for ${branch} names no log path; its keys are ${Object.keys(row).join(",")}\n${result.report}`,
    ).toBe(true)
    await expect(
      readFile(String(log), "utf8"),
      `the row names ${String(log)}, which is not there to read\n${result.report}`,
    ).resolves.toBeTypeOf("string")
  })

  it("merged rows go below the changes in line", async () => {
    const { repo } = await boundaryRepository({ exit: 0 })
    const first = await submitOneCommit(repo, "alpha")
    await queueRunOnce(repo)
    const second = await submitOneCommit(repo, "beta")

    const { rows, result } = await changesListed(repo)
    const order = rows.map((row) => String(row.branch))
    expect(order, result.report).toEqual([second.branch, first.branch])
    expect(stateOf(rowFor(rows, second.branch, result.report), result.report)).toBe("queued")
    expect(stateOf(rowFor(rows, first.branch, result.report), result.report)).toBe("merged")
  })
})
