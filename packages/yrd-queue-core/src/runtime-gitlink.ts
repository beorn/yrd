/**
 * WHERE THIS RUNTIME'S OWN GITLINK LIVES — the question M7's relaunch depends
 * on, and the one the loop has been answering wrong since M8 (@i/10-yrd/24515).
 *
 * M7's rule is that the round which merges this yrd's own gitlink is the last
 * one this code runs: the loop exits 0, the supervisor relaunches it on the new
 * pin, and nobody has to notice. The old answer asked whether the RUNTIME
 * CHECKOUT sits inside the QUEUE CHECKOUT, and turned the exit off when it did
 * not. That held while the queue ran from the repository it was checking. M8
 * moved the queue into its own clone, the runtime kept loading from the shared
 * checkout, and the answer became "no" permanently — so the exit has been off
 * in production for a month and every pin move has needed a person.
 *
 * The question this module asks instead: WHAT PATH DOES THE RUNTIME OCCUPY IN
 * ITS OWN SUPERPROJECT? That path is a fact about the runtime alone, so it is
 * true wherever the queue happens to be working from — and because the queue
 * clones the same repository, the same path addresses the same gitlink there.
 *
 * Pure: paths in, decision out. No git, no filesystem.
 */

import { relative, sep } from "node:path"

/** The runtime occupies a gitlink at `path` in its own superproject. */
export type RuntimeGitlinkPath = Readonly<{ kind: "gitlink"; path: string }>

/**
 * The relaunch exit is off, with WHY — and `why` is written to be read by a
 * person on a page rather than grepped out of an INFO line.
 *
 * That this type exists at all is the fix. The old code returned `undefined`
 * and logged at INFO; @cto could not find the line in hab's session files. A
 * capability that switches itself off and says so where nobody reads is
 * indistinguishable from one that works, and this defect is the second time
 * the fleet has paid for that exact shape.
 */
export type RuntimeGitlinkOff = Readonly<{ kind: "off"; reason: string; why: string }>

export type RuntimeGitlinkDecision = RuntimeGitlinkPath | RuntimeGitlinkOff

/**
 * The gitlink path this runtime occupies in its superproject.
 *
 * `superproject` is `git rev-parse --show-superproject-working-tree` run in the
 * runtime's own checkout: the working tree of the repository that RECORDS this
 * one as a submodule, or empty when nothing does.
 *
 * Deliberately NOT given the queue checkout. The queue's location is not
 * evidence about where this runtime lives, and treating it as evidence is the
 * whole defect.
 */
export function runtimeGitlinkPath(checkout: string, superproject: string | undefined): RuntimeGitlinkDecision {
  if (superproject === undefined || superproject.trim() === "") {
    return {
      kind: "off",
      reason: "no-superproject",
      why:
        `the relaunch exit is off: this yrd runs from ${checkout}, which no superproject records as a submodule, ` +
        "so no gitlink can move under it. A standalone clone is expected to be here; a deployed runtime is not.",
    }
  }
  const path = relative(superproject.trim(), checkout).split(sep).join("/")
  if (path === "" || path === ".." || path.startsWith("../")) {
    return {
      kind: "off",
      reason: "runtime-outside-superproject",
      why:
        `the relaunch exit is off: this yrd runs from ${checkout}, which is not inside the superproject ` +
        `${superproject.trim()} that reported it. The relaunch cannot be armed until that disagreement is repaired.`,
    }
  }
  return { kind: "gitlink", path }
}
