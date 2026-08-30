/**
 * @failure `yrd gitlink advance` hands its bay to the repository's own pre-commit guard
 *          unprepared — the submodule still on the old commit and the bay never provisioned —
 *          so the guard refuses a clean fast-forward and the author finishes by hand.
 * @level l3
 * @consumer @i/10-yrd/gitlink-advance-is-one-command
 *
 * Measured 2026-08-30, the verb's first real use. Two refusals, both correct:
 *
 * 1. `PIN-GUARD REFUSAL (pre-commit): 1 gitlink pin move(s) would drop landed submodule work`
 *    — the bay's submodule store did not hold the target at all, so `merge-base
 *    --is-ancestor` answered "Not a valid commit name" and the guard read that silence as
 *    merged work being dropped.
 * 2. `root typecheck failed for a gitlink pin move … TYPECHECK BLOCKED: native TypeScript
 *    compiler is not executable` — a fresh bay has no dependencies, and the guard runs the
 *    repository's typecheck at authoring time.
 *
 * Why a bay's store goes cold, which the field report could only see the effect of: a bay's
 * submodule object store is an ALTERNATE onto the superproject's COMMON module store, never
 * onto the work tree that invoked the verb. The advance that failed ran from another bay, so
 * its own `resolveSubmoduleMain` fetch landed in that bay's store and the new bay inherited
 * none of it. Invoked from the root checkout — as this fixture does — the two stores are the
 * same one and the target is there by accident of geography. So the assertions below are on
 * what the verb DOES (it fetches and checks out inside the bay) and on the state it leaves,
 * not on a cold store this fixture cannot honestly manufacture.
 */

import { readdir } from "node:fs/promises"
import { basename, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  cleanupGitlinkFixtures,
  DEPENDENCIES_PRE_COMMIT_HOOK,
  FAST_FORWARD_PRE_COMMIT_HOOK,
  fixtureAdvance,
  gitProbe as git,
  installPreCommitHook,
  type RecordedRun,
  superprojectWithThreeCommitSubmodule,
} from "./gitlink-advance-fixture.ts"

afterEach(cleanupGitlinkFixtures)

/** The one bay an advance opens. Named rather than guessed, so a second bay fails loudly. */
async function soleBay(root: string): Promise<string> {
  const bays = await readdir(join(root, ".bays"))
  expect(bays, "an advance opens exactly one bay").toHaveLength(1)
  return join(root, ".bays", bays[0] as string)
}

/** Where a command sits in the recorded order, or -1. Matches on argv suffix and cwd. */
function indexOf(runs: readonly RecordedRun[], cwd: string, ...argv: readonly string[]): number {
  return runs.findIndex((run) => run.cwd === cwd && argv.every((token) => run.argv.includes(token)))
}

type FailureDocument = Readonly<{
  code: string
  message: string
  resolution: readonly string[]
  blocked?: string
}>

/**
 * The `--json` failure document, parsed out of the stream it was printed on.
 *
 * Read as a document rather than matched as a substring: the point of this assertion is that
 * the machine-readable surface carries the refusal, and a substring check would pass on
 * human prose that happened to share the stream.
 */
function failureDocument(output: string): FailureDocument {
  const line = output
    .split("\n")
    .map((candidate) => candidate.trim())
    .findLast((candidate) => candidate.startsWith('{"failure"'))
  expect(line, `no --json failure document in:\n${output}`).toBeDefined()
  const parsed = JSON.parse(line as string) as Readonly<{ failure: FailureDocument }>
  return parsed.failure
}

describe("yrd gitlink advance prepares the bay it commits in", { timeout: 180_000 }, () => {
  it("brings the bay's own submodule to the target before staging the gitlink", async () => {
    const fixture = await superprojectWithThreeCommitSubmodule()
    // A guard shaped like the one that refused: it asks THIS work tree's submodule to prove
    // the staged move is a fast-forward. Satisfied both before and after this change in a
    // root-invoked advance (see the header) — it is here as a standing control that the fix
    // does not break the guard it exists to satisfy.
    await installPreCommitHook(fixture.root, FAST_FORWARD_PRE_COMMIT_HOOK)
    const runs: RecordedRun[] = []

    const result = await fixtureAdvance(fixture.root, ["gitlink", "advance", "dep"], runs)

    expect(result.exit, `${result.stdout}\n${result.stderr}`).toBe(0)
    const bay = await soleBay(fixture.root)
    const submodule = join(bay, "dep")

    // The postcondition the guard needs: the bay's submodule holds the target AND sits on it.
    expect(await git(submodule, "cat-file", "-t", `${fixture.main[2]}^{commit}`)).toBe("commit")
    expect(await git(submodule, "rev-parse", "HEAD")).toBe(fixture.main[2])

    // And the bay is left honest. Staging a gitlink whose submodule stays parked on the old
    // commit leaves `M dep` in every status the bay will ever report, and the submit path
    // warning about uncommitted work it cannot include.
    expect(await git(bay, "status", "--porcelain", "--ignore-submodules=none")).toBe("")
    expect(result.stderr).not.toContain("has uncommitted work")

    // The mechanism, in the order that makes it work: the submodule reaches the target before
    // the index entry that names it is written.
    const fetched = indexOf(runs, submodule, "fetch")
    const checkedOut = indexOf(runs, submodule, "checkout", fixture.main[2])
    const staged = indexOf(runs, bay, "update-index")
    expect(fetched, "the verb fetches inside the bay's submodule").toBeGreaterThanOrEqual(0)
    expect(checkedOut, "the verb checks the target out inside the bay's submodule").toBeGreaterThan(fetched)
    expect(staged, "the gitlink is staged only after its submodule holds the target").toBeGreaterThan(checkedOut)
  })

  it("provisions the bay so an authoring-time guard can run, and installs after the checkout", async () => {
    const fixture = await superprojectWithThreeCommitSubmodule()
    // The second refusal: the repository's own typecheck runs at authoring time on a gitlink
    // move, and a fresh bay has no dependencies for it to run against.
    await installPreCommitHook(fixture.root, DEPENDENCIES_PRE_COMMIT_HOOK)
    const runs: RecordedRun[] = []

    const result = await fixtureAdvance(fixture.root, ["gitlink", "advance", "dep"], runs)

    expect(result.exit, `${result.stdout}\n${result.stderr}`).toBe(0)
    const bay = await soleBay(fixture.root)
    expect(await readdir(join(bay, "node_modules"))).toContain("local-thing")

    // Ordering is the measured half of this. Provisioned BEFORE the submodule reached the
    // target, a bay's dependency tree lacks the target's own workspace members and the
    // guard's typecheck reports errors against a tree that is in fact correct.
    const checkedOut = indexOf(runs, join(bay, "dep"), "checkout", fixture.main[2])
    const installed = indexOf(runs, bay, "install", "--frozen-lockfile")
    const staged = indexOf(runs, bay, "update-index")
    expect(installed, "the verb provisions the bay it is about to commit in").toBeGreaterThanOrEqual(0)
    expect(installed, "provisioning follows the submodule reaching its target").toBeGreaterThan(checkedOut)
    expect(staged, "the commit is written last").toBeGreaterThan(installed)
  })

  it("names the bay and carries the guard's own cure when the commit is refused", async () => {
    const fixture = await superprojectWithThreeCommitSubmodule()
    await installPreCommitHook(
      fixture.root,
      `#!/bin/sh
staged=$(git ls-files -s dep | awk '{print $2}')
recorded=$(git rev-parse HEAD:dep 2>/dev/null)
[ "$staged" = "$recorded" ] && exit 0
echo "PIN-GUARD REFUSAL (pre-commit): this repository refuses on purpose" >&2
echo "Run: bun install --frozen-lockfile" >&2
exit 1
`,
    )

    const result = await fixtureAdvance(fixture.root, ["gitlink", "advance", "dep", "--json"])
    const output = `${result.stdout}\n${result.stderr}`

    expect(result.exit).not.toBe(0)
    const bay = await soleBay(fixture.root)
    const bayId = basename(bay)

    // What refused, where it refused, and how to get back to it — on the human surface.
    expect(output).toContain("PIN-GUARD REFUSAL (pre-commit): this repository refuses on purpose")
    expect(output, "the guard's own cure line survives, whichever stream it chose").toContain(
      "Run: bun install --frozen-lockfile",
    )
    expect(output, "the refusal names the bay left behind").toContain(bay)
    expect(output).toContain(`yrd in ${bayId}`)

    // And the SAME three facts inside the `--json` document, read as a document rather than
    // as a substring of the stream it happened to be printed on.
    const document = failureDocument(output)
    expect(document.code).toBe("gitlink-commit-failed")
    expect(document.message).toContain(bay)
    expect(document.message).toContain("PIN-GUARD REFUSAL (pre-commit): this repository refuses on purpose")
    expect(document.message).toContain("Run: bun install --frozen-lockfile")
    expect(document.message).toContain("the bay is preserved")
    // The machine-readable remedy names the bay too, rather than the submit advice a change
    // that was never committed cannot use.
    expect(document.resolution).toContain(`yrd in ${bayId}`)

    // …and carries NOTHING of the required-check cure. `gitlink-commit-failed` ends in
    // `-failed`, so the dynamic step-failure family folded it onto `check-failed` and the
    // `--json` document went out with that code's reasoning attached: a refused pre-commit
    // guard explained as a check that judged the work, and steps for a change the advance
    // never submitted. The human stream showed the same sentence.
    expect(document.blocked ?? "").not.toContain("The check judged the WORK")
    expect(document.resolution).not.toContain("yrd pr submit <branch>")
    expect(document.resolution).not.toContain("yrd pr runs <change>")
    expect(output).not.toContain("The check judged the WORK")

    // The bay really is preserved with the advance staged — the claim the message makes.
    expect(await git(bay, "rev-parse", ":dep")).toBe(fixture.main[2])
    expect(await git(join(bay, "dep"), "rev-parse", "HEAD")).toBe(fixture.main[2])
  })
})
