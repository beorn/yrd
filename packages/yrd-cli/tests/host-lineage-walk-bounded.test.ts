/**
 * @failure The compose path's merged-truth walk was UNBOUNDED, so the lineage
 * index carried every pre-epoch commit as a specimen and could answer for
 * nothing: measured 2026-08-31 on the live base, 6008 specimens over 26533
 * commits (77.4% coverage), which made every landed standing fact resolve
 * `unresolved`/`unreadable` instead of `landed`. An `unresolved` row is KEPT,
 * exactly as `pending` is, so landed facts accumulated forever and re-composed
 * on every pass — the stale-fact pile that took the landing path down for 72
 * minutes.
 *
 * Neither existing unit could catch it. `landedSubmits` and
 * `buildMergedTruthIndex` are both tested with injected fixtures, so nothing
 * asserted what the HOST passes as `stop` — and the defect was precisely a
 * missing argument at the wiring seam, invisible from either side.
 *
 * The bound must be the PARENT of the oldest stamped commit, and that is the
 * assertion worth having: `merged-truth` walks `stop..tip` exclusively, so
 * passing the oldest stamped commit itself drops the very entry the bound
 * exists to preserve — and a dropped index entry reads as "this change never
 * landed", which re-admits and re-runs work that already merged. The
 * off-by-one and the correct version differ by one commit and agree on every
 * other observable.
 * @level l2
 * @consumer @yrd/cli host · the queue's scanLandedSubmits capability
 */
import { describe, expect, it } from "vitest"
import { stampingEpochStop } from "@yrd/queue"

const OLDEST_STAMPED = "f".repeat(40)
const ITS_PARENT = "9".repeat(40)
const NEWER_STAMPED = "a".repeat(40)
const TIP = "b".repeat(40)

type GitCall = Readonly<{ repo: string; args: readonly string[] }>

/** A merged-truth git reader over a scripted repository. `optionalText`
 * answers `undefined` for anything unscripted, which is what a real
 * `rev-parse --verify` does for a root commit's parent. */
function scriptedGit(
  script: Readonly<{ stampedLog: string; parents?: Readonly<Record<string, string>> }>,
  calls: GitCall[],
) {
  return {
    async text(repo: string, args: readonly string[]): Promise<string> {
      calls.push({ repo, args })
      if (args[0] === "log") return script.stampedLog
      throw new Error(`unscripted text read: git ${args.join(" ")}`)
    },
    async optionalText(repo: string, args: readonly string[]): Promise<string | undefined> {
      calls.push({ repo, args })
      const ref = args[args.length - 1]
      return ref === undefined ? undefined : script.parents?.[ref]
    },
  }
}

describe("the compose path bounds its merged-truth walk at the stamping epoch", () => {
  it("stops at the PARENT of the oldest stamped commit, never at the commit itself", async () => {
    const calls: GitCall[] = []
    const git = scriptedGit(
      // Newest first, as `git log` emits it: the OLDEST is the last row.
      { stampedLog: `${NEWER_STAMPED}\n${OLDEST_STAMPED}`, parents: { [`${OLDEST_STAMPED}^`]: ITS_PARENT } },
      calls,
    )

    const stop = await stampingEpochStop(git, "/repo", TIP)

    expect(stop, "the bound must be the parent — `stop..tip` excludes `stop` itself").toBe(ITS_PARENT)
    expect(stop, "stopping AT the oldest stamped commit drops the entry the bound exists to keep").not.toBe(
      OLDEST_STAMPED,
    )
  })

  it("asks for the oldest STAMPED commit, not merely the oldest commit", async () => {
    const calls: GitCall[] = []
    const git = scriptedGit({ stampedLog: OLDEST_STAMPED, parents: { [`${OLDEST_STAMPED}^`]: ITS_PARENT } }, calls)

    await stampingEpochStop(git, "/repo", TIP)

    const log = calls.find((call) => call.args[0] === "log")
    expect(log, "no log query was issued at all").toBeDefined()
    expect(
      log?.args,
      "without the Change-Id filter this derives the oldest commit in history, which is no bound at all",
    ).toContain("--grep=Change-Id: I")
    expect(log?.args, "a non-first-parent walk would wander into merged side branches").toContain("--first-parent")
    expect(log?.args, "the walk must be anchored at the resolved tip").toContain(TIP)
  })

  it("yields NO bound when the base has never stamped a trailer", async () => {
    const calls: GitCall[] = []
    const git = scriptedGit({ stampedLog: "" }, calls)

    expect(
      await stampingEpochStop(git, "/repo", TIP),
      "a repository that never stamped must fall back to the unbounded walk, never to a bound at zero",
    ).toBeUndefined()
  })

  it("yields NO bound when the oldest stamped commit is a root", async () => {
    const calls: GitCall[] = []
    // No `parents` entry: `rev-parse --verify <root>^` exits non-zero, which
    // `optionalText` reports as undefined rather than throwing.
    const git = scriptedGit({ stampedLog: OLDEST_STAMPED }, calls)

    expect(
      await stampingEpochStop(git, "/repo", TIP),
      "a root commit has no parent, and excluding everything would make every landed fact a trusted not-found",
    ).toBeUndefined()
  })
})
