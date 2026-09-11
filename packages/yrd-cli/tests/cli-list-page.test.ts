/**
 * @failure  The flag day (yrd 1f638504) replaced the one-shot list's page — a
 *           silvery table with STATE in the state's colour under the queue
 *           pills and the RUNNER box — with a bare line per row, and the
 *           operator asked for the old display back (2026-09-05, 24169). A
 *           page drawn by a second renderer would drift from the watch's; a
 *           page drawn for a pipe with colour codes would break `| grep`; a
 *           `--json` that changed shape would break every consumer.
 * @consumer the operator at the prompt · `yrd list | grep` · every `--json`
 *           reader (tent's trackerBridge among them)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { stripAnsi } from "@silvery/ansi"
import { gitIn, submit } from "@yrd/queue-core"
import { runYrdProcess } from "../src/cli.ts"
import type { YrdCliExitCode, YrdCliIO } from "../src/types.ts"

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true })
})

type Ran = Readonly<{ exitCode: YrdCliExitCode; stdout: string; stderr: string; report: string }>

/** The CLI as the shell runs it: argv in, exit code and both streams out; `color` and `columns` as the terminal would say them. */
async function yrd(cwd: string, io: Pick<YrdCliIO, "color" | "columns">, ...args: string[]): Promise<Ran> {
  let stdout = ""
  let stderr = ""
  const full: YrdCliIO = {
    ...io,
    cwd,
    stderr(text) {
      stderr += text
    },
    stdout(text) {
      stdout += text
    },
  }
  const exitCode = await runYrdProcess([process.execPath, "/usr/local/bin/yrd", ...args], full)
  return {
    exitCode,
    report: `yrd ${args.join(" ")} exited ${String(exitCode)}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    stderr,
    stdout,
  }
}

/** A bare remote whose `main` declares the queue, a clone of it, and one change submitted from the clone. */
async function queueWithOneChange(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-list-page-"))
  roots.push(root)
  const seed = gitIn(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await git(["config", "user.email", "queue@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, ".yrd.yml"), "checks:\n  - verify:\n      run: test -f pass.txt\n")
  await git(["add", ".yrd.yml"])
  await git(["commit", "--quiet", "-m", "main declares the queue"])
  await git(["push", "--quiet", "origin", "main"])
  await git(["checkout", "--quiet", "-b", "task/one", "main"])
  writeFileSync(join(work, "pass.txt"), "pass\n")
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "task/one does its work"])
  await git(["checkout", "--quiet", "main"])
  await submit(git, "origin", {
    branch: "task/one",
    submitter: "@dev/10",
    target: { branch: "main", remote: "origin" },
  })
  mkdirSync(join(root, "queue"), { recursive: true })
  return work
}

/**
 * A queue with a change whose branch NAME coincides with the term `merged`
 * (the live specimen, `task/merged-ball-conditional-close`) but whose own
 * state stays `queued`, alongside a second change actually merged — landed
 * directly onto the target, bypassing the queue entirely, which is enough for
 * `readChange` to call it `merged` by ancestry (queue-core/src/state.ts:71,
 * "a direct merge in the garage still shows as merged"). The defect this
 * pins is not a wrong count: it is one row that only LOOKS like an answer.
 */
async function queueWithMergedCoincidence(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "yrd-cli-list-page-coincidence-"))
  roots.push(root)
  const seed = gitIn(root)
  const remote = join(root, "remote.git")
  const work = join(root, "work")
  await seed(["init", "--quiet", "--bare", "--initial-branch=main", remote])
  await seed(["clone", "--quiet", remote, work])
  const git = gitIn(work)
  await git(["config", "user.email", "queue@yrd.test"])
  await git(["config", "user.name", "yrd"])
  await git(["checkout", "--quiet", "-b", "main"])
  writeFileSync(join(work, ".yrd.yml"), "checks:\n  - verify:\n      run: test -f pass.txt\n")
  await git(["add", ".yrd.yml"])
  await git(["commit", "--quiet", "-m", "main declares the queue"])
  await git(["push", "--quiet", "origin", "main"])
  // The coincidence: branch TEXT says `merged`, but the change is only queued.
  await git(["checkout", "--quiet", "-b", "task/merged-ball-conditional-close", "main"])
  writeFileSync(join(work, "coincidence.txt"), "coincidence\n")
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "fix(yrd): condition merged bead closure on full acceptance"])
  await git(["checkout", "--quiet", "main"])
  await submit(git, "origin", {
    branch: "task/merged-ball-conditional-close",
    submitter: "@dev/10",
    target: { branch: "main", remote: "origin" },
  })
  // The real merge: nothing in its own branch or subject says `merged`.
  await git(["checkout", "--quiet", "-b", "task/direct", "main"])
  writeFileSync(join(work, "direct.txt"), "direct\n")
  await git(["add", "."])
  await git(["commit", "--quiet", "-m", "task/direct lands directly"])
  await git(["checkout", "--quiet", "main"])
  await submit(git, "origin", {
    branch: "task/direct",
    submitter: "@dev/11",
    target: { branch: "main", remote: "origin" },
  })
  await git(["merge", "--quiet", "--ff-only", "task/direct"])
  await git(["push", "--quiet", "origin", "main"])
  mkdirSync(join(root, "queue"), { recursive: true })
  return work
}

const ESC = "["

describe("`yrd list` prints the watch's page, once", () => {
  it("draws the pills, the column header, the row with its state glyph and word, and the count — plain for a pipe", async () => {
    const work = await queueWithOneChange()
    const plain = await yrd(work, { color: false }, "list")
    expect(plain.exitCode, plain.report).toBe(0)
    expect(plain.stdout, plain.report).not.toContain(ESC)
    expect(plain.stdout, plain.report).toContain("Child observation is not configured")
    const lines = plain.stdout.split("\n")
    // The queue's name first, then the identity pills, then (past the journal
    // notice a machine that runs no queue prints, G5) the header the pane draws.
    expect(lines[0]).toMatch(/remote\.git#main$/u)
    expect(lines[1]).toContain("YRD QUEUES")
    expect(lines[1]).toContain("⎇ main")
    const header = lines.findIndex((line) => /^TIME\s+STATUS\s+RUN\s+CHANGES\s+BY\s+AGE\s+RUNTIME/u.test(line))
    expect(header, plain.report).toBeGreaterThan(1)
    expect(lines.slice(2, header).join("\n")).toContain("no run journal was read")
    const row = lines.find((line) => line.includes("task/one"))
    expect(row, plain.report).toBeDefined()
    expect(row).toContain("○ queued")
    expect(row).toContain("task/one does its work")
    expect(row).toContain("@dev/10")
    expect(plain.stdout).toContain("1 change(s)")
    // Nothing the retired bare line printed and the page does not: no `[run]` suffix in the row.
    expect(row).not.toMatch(/\[q-/u)
  })

  it("colours the same page for a terminal: the state's colour on the STATUS cell, and not one other byte", async () => {
    const work = await queueWithOneChange()
    const plain = await yrd(work, { color: false, columns: 120 }, "list")
    const colored = await yrd(work, { color: true, columns: 120 }, "list")
    expect(colored.exitCode, colored.report).toBe(0)
    expect(colored.stdout).toContain(ESC)
    // One renderer: the coloured page is the plain page with colour on it.
    // (Line by line, trailing blanks aside: a colour reset after padding keeps one blank the plain line drops.)
    const trimmed = (text: string): string[] => text.split("\n").map((line) => line.trimEnd())
    expect(trimmed(stripAnsi(colored.stdout))).toEqual(trimmed(plain.stdout))
    const row = colored.stdout.split("\n").find((line) => stripAnsi(line).includes("task/one"))
    expect(row, colored.report).toBeDefined()
    // The STATUS cell — glyph and word — is painted: an SGR sequence opens before `queued`.
    expect(row).toMatch(/\[[0-9;]*m[^]*○ queued/u)
  })

  it("lays the page out to the terminal's width, and to 120 columns for a pipe", async () => {
    const work = await queueWithOneChange()
    const narrow = await yrd(work, { color: false, columns: 80 }, "list")
    const wide = await yrd(work, { color: false, columns: 160 }, "list")
    const piped = await yrd(work, { color: false }, "list")
    const widest = (text: string): number => Math.max(...text.split("\n").map((line) => [...line].length))
    expect(widest(narrow.stdout)).toBeLessThanOrEqual(80)
    expect(widest(wide.stdout)).toBeLessThanOrEqual(160)
    expect(widest(piped.stdout)).toBeLessThanOrEqual(120)
    // The header keeps every column at every width.
    for (const ran of [narrow, wide, piped]) expect(ran.stdout, ran.report).toMatch(/^TIME\s+STATUS\s+RUN\s+CHANGES/mu)
  })

  it("leaves `--json` exactly as it was: the same document with or without colour, and never a colour byte", async () => {
    const work = await queueWithOneChange()
    const plain = await yrd(work, { color: false }, "list", "--json")
    const colored = await yrd(work, { color: true, columns: 120 }, "list", "--json")
    expect(plain.exitCode, plain.report).toBe(0)
    expect(colored.stdout).toBe(plain.stdout)
    expect(plain.stdout).not.toContain(ESC)
    const document = JSON.parse(plain.stdout) as Record<string, unknown>
    // `runner` joined the document on 2026-09-11 (@i/10-yrd/24486 row 5). This
    // assertion is the reason the addition is deliberate rather than incidental:
    // a `--json` that changes shape breaks every consumer, so the key set is
    // pinned and a new key has to be argued for here before it ships.
    expect(Object.keys(document).sort()).toEqual(["changes", "journal", "observation", "pause", "runner"])
    expect((document as { observation: unknown }).observation).toMatchObject({ contract: "native", notices: [] })
    const [row] = document["changes"] as readonly Record<string, unknown>[]
    expect(row).toMatchObject({ branch: "task/one", position: 1, state: "queued", submitter: "@dev/10" })
    // The bare-line era's row fields, all still there under their names.
    expect(Object.keys(row!)).toEqual(expect.arrayContaining(["branch", "head", "state", "since", "subject"]))
  })

  /**
   * @failure Three rows read `queued` and nothing is working them, and a script
   *          reading `--json` cannot tell — so a seat submits into an outage on
   *          the strength of a row that reads exactly as it does when the queue
   *          is healthy and merely busy. Measured 2026-09-11 during the outage
   *          this bead is about (@i/10-yrd/24486 row 5).
   */
  it("says whether anything is polling, on a QUEUED row and not only on a stuck one", async () => {
    const work = await queueWithOneChange()
    const ran = await yrd(work, { color: false }, "list", "--json")
    expect(ran.exitCode, ran.report).toBe(0)
    const document = JSON.parse(ran.stdout) as { changes: readonly { state: string }[]; runner: Record<string, unknown> }
    // The state a submitter ARRIVES INTO, which is the whole point of the row:
    // the answer must be there when nothing is stuck.
    expect(document.changes[0]?.state).toBe("queued")
    expect(document.runner).toMatchObject({ health: expect.any(String) as string })
    expect(["processing", "idle", "silent", "absent"]).toContain(document.runner["health"])
    // Never a blank and never a zero: with no journal it says where it looked.
    if (document.runner["health"] === "absent") expect(document.runner["absent"]).toEqual(expect.any(String))
    expect(document.runner["journalDir"]).toEqual(expect.any(String))
  })
})

/**
 * @failure A term that IS a state name was compared to branch, subject, run,
 *          result and reason but never to STATE — the field the payload itself
 *          emits. On the live queue `merged` returned exactly ONE row, matched
 *          on the branch `task/merged-ball-conditional-close`, while several
 *          hundred rows whose state field read merged were excluded, out of 247
 *          (a-state-name-filters-to-zero-rows-and-exit-zero).
 * @consumer a reader who saw `state: merged` in the JSON and typed `merged`
 */
describe("a state name means the state", () => {
  it("selects by STATE: `queued` finds the queued change rather than a coincidence", async () => {
    const cwd = await queueWithOneChange()
    const ran = await yrd(cwd, { color: false, columns: 120 }, "list", "--json", "queued")

    expect(ran.exitCode, ran.report).toBe(0)
    const document = JSON.parse(ran.stdout) as Record<string, unknown>
    const changes = document["changes"] as readonly Record<string, unknown>[]
    expect(changes, ran.report).toHaveLength(1)
    expect(changes[0]).toMatchObject({ branch: "task/one", state: "queued" })
  })

  /**
   * AC3: the coincidence pinned BESIDE the empty case, checking the exit code
   * and the message rather than only the row count — because the row count
   * alone is exactly what read as a plausible answer in production.
   */
  it("keeps the real merge beside its own coincidence, rather than stopping at the row that only looks like an answer", async () => {
    const cwd = await queueWithMergedCoincidence()
    const ran = await yrd(cwd, { color: false, columns: 120 }, "list", "--json", "merged")

    expect(ran.exitCode, ran.report).toBe(0)
    const document = JSON.parse(ran.stdout) as Record<string, unknown>
    const changes = document["changes"] as readonly Record<string, unknown>[]
    const byBranch = (branch: string): Record<string, unknown> | undefined =>
      changes.find((change) => change["branch"] === branch)
    // Both answer: the coincidence, matched on branch TEXT, and the real
    // merge, matched on its own STATE — neither shadows the other.
    expect(byBranch("task/merged-ball-conditional-close"), ran.report).toMatchObject({ state: "queued" })
    expect(byBranch("task/direct"), ran.report).toMatchObject({ state: "merged" })
    // The message, not only the count: both rows counted as matches, so the
    // numerator is 2 — the denominator is however many rows this fixture's
    // queue reading carries in total, which is not this test's concern.
    expect(document["scope"], ran.report).toMatch(/^2 of \d+ change\(s\) match merged$/u)
  })
})

/**
 * @failure `--status <state>` was removed from every `yrd list` renderer by the
 *          flag day (1f638504), which deleted `queue-list-json-filter.test.ts`
 *          — the regression test that pinned it — in the same commit, so
 *          nothing went red. What it dropped was RULED and merged:
 *          @yrd/core/21096-cli-ux/22301, closed 2026-07-28 at fe9ded50ed. Its
 *          specimen was the opposite of an empty answer — the flag was IGNORED
 *          under `--json` and the reader got all 669 retained runs, 14 MB,
 *          while the same command without `--json` showed one row.
 * @consumer anyone who scripted `yrd list --status`, and every reader of 22301
 *
 * These are that test's own assertions, read out of the deleted file rather
 * than remembered — the exit-0 empty-payload one included, which is the promise
 * that every command emits a parseable document even when the selection is
 * empty.
 */
describe("`--status` is a spelling of a filter term (@yrd/core/21096-cli-ux/22301)", () => {
  it("answers byte for byte what the positional term answers, on the command and on its alias", async () => {
    const work = await queueWithOneChange()
    const positional = await yrd(work, { color: false, columns: 120 }, "queue", "list", "queued")
    const flagged = await yrd(work, { color: false, columns: 120 }, "queue", "list", "--status", "queued")
    const aliased = await yrd(work, { color: false, columns: 120 }, "list", "--status", "queued")

    expect(positional.exitCode, positional.report).toBe(0)
    // One predicate, two spellings: not "both succeed", but the same document.
    expect(flagged.stdout, flagged.report).toBe(positional.stdout)
    expect(flagged.exitCode, flagged.report).toBe(positional.exitCode)
    expect(aliased.stdout, aliased.report).toBe(positional.stdout)
  })

  it("filters the JSON PAYLOAD, not only the rendered rows — the defect 22301 closed", async () => {
    const work = await queueWithOneChange()
    const unfiltered = await yrd(work, { color: false, columns: 120 }, "list", "--json")
    const filtered = await yrd(work, { color: false, columns: 120 }, "list", "--json", "--status", "queued")

    expect(filtered.exitCode, filtered.report).toBe(0)
    const branchesIn = (ran: Ran): readonly string[] =>
      ((JSON.parse(ran.stdout) as Record<string, unknown>)["changes"] as readonly Record<string, unknown>[]).map(
        (change) => String(change["branch"]),
      )
    // The unfiltered listing still carries the change (the original's first
    // assertion), and the filtered payload selects it by its state.
    expect(branchesIn(unfiltered), unfiltered.report).toContain("task/one")
    expect(branchesIn(filtered), filtered.report).toEqual(["task/one"])
  })

  it("gives a state with no rows the same valid empty document and exit 0 on both spellings", async () => {
    const work = await queueWithOneChange()
    const positional = await yrd(work, { color: false, columns: 120 }, "list", "--json", "merged")
    const flagged = await yrd(work, { color: false, columns: 120 }, "list", "--json", "--status", "merged")
    const documentOf = (ran: Ran): Record<string, unknown> => JSON.parse(ran.stdout) as Record<string, unknown>

    // EXIT 0 BY DEFAULT is the owning bead's ruling (@chief, 2026-09-07): a
    // filter term matching zero rows is user input producing an empty result,
    // not an invariant violation, and the README taxonomy reserves 2 for stuck.
    // The opt-in `--require-match` returning 1 is pinned separately, below.
    expect(positional.exitCode, positional.report).toBe(0)
    expect(flagged.exitCode, flagged.report).toBe(positional.exitCode)
    // The promise `--json` keeps for every consumer: a parseable document, the
    // empty selection included. This is the assertion that reported the last
    // breakage of it, so it is made on BOTH spellings rather than one. `scope`
    // joins the shape here (AC1): a zero-row filter is exactly the case that
    // must say what it matched against, and JSON gets the same notice the page does.
    // `runner` is here for the same reason and is arguably needed MOST here: a
    // reader who selected nothing has the least evidence of all, and "no rows"
    // reads identically whether the queue is empty or nothing is polling
    // (@i/10-yrd/24486 row 5).
    expect(Object.keys(documentOf(flagged)).sort()).toEqual([
      "changes",
      "journal",
      "observation",
      "pause",
      "runner",
      "scope",
    ])
    expect(documentOf(flagged)["changes"], flagged.report).toEqual([])
    expect(documentOf(positional)["changes"], positional.report).toEqual([])
    // And 22301's own specimen, the other way round: a non-matching state must
    // never answer with the queue it did not select.
    expect(flagged.stdout, flagged.report).not.toContain("task/one")
    expect(flagged.stdout, flagged.report).toBe(positional.stdout)
    expect(stripAnsi(flagged.stderr), flagged.report).toBe(stripAnsi(positional.stderr))
  })
})

/**
 * @failure A filter term matching zero rows exited 0 with no explanation:
 *          identical to a genuine typo, so a reader migrating off `--status
 *          queued` was never told the flag moved, and never told their term
 *          matched no state (a-state-name-filters-to-zero-rows-and-exit-zero,
 *          AC1). `--json` dropped the notice entirely — only the page carried
 *          it — so a scripted reader had strictly less to go on than a human
 *          at the prompt.
 * @consumer a reader who mistyped a state, or scripted `--json` wanting to
 *           tell "no matches" apart from "my request was wrong"
 */
describe("a filter matching nothing says so loudly, and stays exit 0 unless asked otherwise (AC1)", () => {
  it("names what it was checked against, on the page and in --json alike", async () => {
    const work = await queueWithOneChange()
    const human = await yrd(work, { color: false, columns: 120 }, "list", "merged")
    const json = await yrd(work, { color: false, columns: 120 }, "list", "--json", "merged")

    expect(human.exitCode, human.report).toBe(0)
    expect(json.exitCode, json.report).toBe(0)
    // Named, not just counted: the fields the term was checked against, so a
    // state name that matched nothing is told it WAS considered, not skipped.
    const expected = "0 of 1 change(s) match merged. Checked branch, subject, run, failure and state."
    expect(human.stdout, human.report).toContain(expected)
    const document = JSON.parse(json.stdout) as Record<string, unknown>
    expect(document["scope"], json.report).toBe(expected)
  })

  it("opts into exit 1 on that same zero with --require-match, never exit 2, and leaves a real match at exit 0", async () => {
    const work = await queueWithOneChange()
    const empty = await yrd(work, { color: false, columns: 120 }, "list", "--json", "merged", "--require-match")
    const matched = await yrd(work, { color: false, columns: 120 }, "list", "--json", "queued", "--require-match")

    expect(empty.exitCode, empty.report).toBe(1)
    // The README taxonomy reserves 2 for stuck; a filter matching nothing is
    // user input producing an empty result, never an invariant violation.
    expect(empty.exitCode, empty.report).not.toBe(2)
    expect(matched.exitCode, matched.report).toBe(0)
    // `--require-match` changes only the exit code, never the document.
    expect(JSON.parse(empty.stdout)).toMatchObject({ changes: [] })
  })
})
