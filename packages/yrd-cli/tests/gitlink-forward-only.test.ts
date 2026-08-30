/**
 * @failure A change that moves a submodule's gitlink BACKWARDS is queued and merged, reverting
 *          commits nobody decided to revert — the PR2118 shape (2026-08-27), which passed every
 *          gate yrd owned because legitimacy (published on the submodule's main) was the only
 *          question anything asked.
 * @level l2
 * @consumer @i/10-yrd/gitlinks-move-only-forward; ADR 2026-08-27-pin-legitimacy-is-not-monotonicity
 *
 * The four directions plus the exemption, on real repositories. Diverged is not a variant of
 * behind: it is the case PR2118 actually hit, and the case a bare ancestry bit cannot describe.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { failureFact } from "@yrd/core"
import { createProcess } from "@yrd/process"
import { afterEach, describe, expect, it } from "vitest"
import { backwardGitlinkRefusal, gitlinkDirections, resolveBaseTip } from "../src/gitlink-forward-only.ts"
import { requireQueueableSubmodulePins } from "../src/run.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(repo: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

async function repository(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  await git(path, ["init", "-q", "-b", "main"])
  await git(path, ["config", "user.name", "Yrd Test"])
  await git(path, ["config", "user.email", "yrd@example.invalid"])
}

type Fixture = Readonly<{
  root: string
  /** Submodule commits by label: the A line, the B line, and the merge that joins them. */
  sha: Readonly<Record<"a1" | "a2" | "a3" | "b1" | "merge", string>>
  /** Point superproject `main`'s tip at one submodule commit, then return the branch head. */
  branchWriting: (options: { mainRecords: string; branchRecords: string }) => Promise<string>
  /** A branch that edits a file and touches no gitlink at all. */
  branchTouchingNoGitlink: (options: { mainRecords: string }) => Promise<string>
  /** Move superproject `main` on, leaving every branch head exactly where it was. */
  advanceMainTo: (sha: string) => Promise<void>
}>

/**
 * A superproject over a submodule whose main is NOT linear: an A line of three commits, a B
 * line of one off A1, and a merge joining them. That merge is what makes divergence
 * expressible — A3 and B1 are both merged on the submodule's main, so both are legitimate
 * min commits, and neither is an ancestor of the other.
 */
async function superprojectOverForkedSubmodule(): Promise<Fixture> {
  const parent = await mkdtemp(join(tmpdir(), "yrd-gitlink-forward-"))
  roots.push(parent)
  const submodule = join(parent, "submodule")
  const submoduleRemote = join(parent, "submodule.git")
  const root = join(parent, "root")

  await repository(submodule)
  const commit = async (text: string, message: string): Promise<string> => {
    await writeFile(join(submodule, "submodule.txt"), `${text}\n`)
    await git(submodule, ["add", "submodule.txt"])
    await git(submodule, ["commit", "-qm", message])
    return git(submodule, ["rev-parse", "HEAD"])
  }
  const a1 = await commit("a1", "submodule a1")
  const a2 = await commit("a2", "submodule a2")
  const a3 = await commit("a3", "submodule a3")
  await git(submodule, ["checkout", "-q", "-b", "line-b", a1])
  await writeFile(join(submodule, "other.txt"), "b1\n")
  await git(submodule, ["add", "other.txt"])
  await git(submodule, ["commit", "-qm", "submodule b1"])
  const b1 = await git(submodule, ["rev-parse", "HEAD"])
  await git(submodule, ["checkout", "-q", "main"])
  await git(submodule, ["merge", "-q", "--no-ff", "-m", "submodule merge line-b", b1])
  const merge = await git(submodule, ["rev-parse", "HEAD"])

  await git(parent, ["init", "-q", "--bare", "-b", "main", submoduleRemote])
  await git(submodule, ["remote", "add", "origin", submoduleRemote])
  await git(submodule, ["push", "-q", "-u", "origin", "main"])

  // The superproject's base commit records A1. Every branch below is cut from here, so the
  // change's own diff always has A1 on its left-hand side — which is exactly the point of the
  // monotonicity check being asked against main's TIP instead.
  await repository(root)
  await git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", submodule, "dep"])
  await git(join(root, "dep"), ["remote", "set-url", "origin", submoduleRemote])
  await git(join(root, "dep"), ["fetch", "-q", "origin"])
  await git(join(root, "dep"), ["checkout", "-q", a1])
  await git(root, ["add", "dep"])
  await git(root, ["commit", "-qm", "record dep at a1"])
  const base = await git(root, ["rev-parse", "HEAD"])

  const recordAt = async (sha: string, message: string): Promise<string> => {
    await git(join(root, "dep"), ["checkout", "-q", sha])
    await git(root, ["add", "dep"])
    await git(root, ["commit", "-qm", message])
    return git(root, ["rev-parse", "HEAD"])
  }

  return {
    root,
    sha: { a1, a2, a3, b1, merge },
    branchWriting: async ({ mainRecords, branchRecords }) => {
      await git(root, ["checkout", "-q", "main"])
      if (mainRecords !== a1) await recordAt(mainRecords, "advance dep on main")
      await git(root, ["checkout", "-q", "-B", "task/bump", base])
      const head = await recordAt(branchRecords, "bump dep on the branch")
      await git(root, ["checkout", "-q", "main"])
      return head
    },
    advanceMainTo: async (sha) => {
      await git(root, ["checkout", "-q", "main"])
      await recordAt(sha, "advance dep on main, after the branch was written")
    },
    branchTouchingNoGitlink: async ({ mainRecords }) => {
      await git(root, ["checkout", "-q", "main"])
      if (mainRecords !== a1) await recordAt(mainRecords, "advance dep on main")
      await git(root, ["checkout", "-q", "-B", "task/no-gitlink", base])
      await writeFile(join(root, "root.txt"), "unrelated edit\n")
      await git(root, ["add", "root.txt"])
      await git(root, ["commit", "-qm", "edit a file, touch no gitlink"])
      const head = await git(root, ["rev-parse", "HEAD"])
      await git(root, ["checkout", "-q", "main"])
      return head
    },
  }
}

type GateArgs = Parameters<typeof requireQueueableSubmodulePins>

// Only the fields the gate reads. Cast at the boundary rather than building a whole change:
// widening the fixture would make it look like the gate depends on more than it does.
function changeFixture(headSha: string): GateArgs[0] {
  return {
    id: "PR2118",
    name: "gitlink bump",
    branch: "task/bump",
    base: "main",
    state: "open",
    merged: false,
    issue: "@i/10-yrd/gitlinks-move-only-forward",
    revs: [{ n: 1, head: headSha, base: "main", baseSha: headSha, pushedAt: "2026-08-30T00:00:00.000Z" }],
    reviews: [],
    comments: [],
    checkRequests: [],
  } as unknown as GateArgs[0]
}

async function admissionOutcome(
  root: string,
  headSha: string,
): Promise<{ outcome: "admitted" } | { outcome: "refused"; kind: string; code: string; message: string }> {
  await using process = createProcess()
  const services = { process } as unknown as GateArgs[1]
  const io = { cwd: root } as unknown as GateArgs[2]
  try {
    await requireQueueableSubmodulePins(changeFixture(headSha), services, io)
  } catch (error) {
    const fact = failureFact(error)
    if (fact === undefined) throw error
    return { outcome: "refused", kind: fact.kind, code: fact.code, message: fact.message }
  }
  return { outcome: "admitted" }
}

describe("a gitlink can only move forward", { timeout: 60_000 }, () => {
  it("admits a gitlink that moves AHEAD of main's current value", async () => {
    const fixture = await superprojectOverForkedSubmodule()
    const head = await fixture.branchWriting({ mainRecords: fixture.sha.a1, branchRecords: fixture.sha.a3 })

    await expect(admissionOutcome(fixture.root, head)).resolves.toEqual({ outcome: "admitted" })
  })

  it("admits a gitlink IDENTICAL to main's current value — main simply got there first", async () => {
    const fixture = await superprojectOverForkedSubmodule()
    // The change's own diff still writes this gitlink (its base records a1), so the branch is
    // not exempt — it reaches the comparison and the comparison says "no movement".
    const head = await fixture.branchWriting({ mainRecords: fixture.sha.a3, branchRecords: fixture.sha.a3 })

    await expect(admissionOutcome(fixture.root, head)).resolves.toEqual({ outcome: "admitted" })
  })

  it("refuses a gitlink BEHIND main's current value, naming both shas and the revert size", async () => {
    const fixture = await superprojectOverForkedSubmodule()
    const head = await fixture.branchWriting({ mainRecords: fixture.sha.a3, branchRecords: fixture.sha.a2 })

    const refusal = await admissionOutcome(fixture.root, head)

    expect(refusal).toMatchObject({ outcome: "refused", kind: "refusal", code: "gitlink-moves-backward" })
    if (refusal.outcome !== "refused") throw new Error("unreachable")
    expect(refusal.message).toContain(fixture.sha.a2)
    expect(refusal.message).toContain(fixture.sha.a3)
    expect(refusal.message).toContain("is behind by 1 commit")
    expect(refusal.message).toContain("would revert 1 commit")
    // The cure, not just the complaint.
    expect(refusal.message).toContain("re-merge this change onto current main")
  })

  it("refuses a DIVERGED gitlink on a main-only count, not an ancestry bit", async () => {
    const fixture = await superprojectOverForkedSubmodule()
    // Both a3 and b1 are merged on the submodule's own main, so legitimacy passes for either.
    // Neither is an ancestor of the other: this is PR2118's actual shape.
    const head = await fixture.branchWriting({ mainRecords: fixture.sha.a3, branchRecords: fixture.sha.b1 })

    const refusal = await admissionOutcome(fixture.root, head)

    expect(refusal).toMatchObject({ outcome: "refused", kind: "refusal", code: "gitlink-moves-backward" })
    if (refusal.outcome !== "refused") throw new Error("unreachable")
    expect(refusal.message).toContain("DIVERGED")
    // 2 main-only (a2, a3) and 1 change-only (b1) — the two numbers an ancestry bit cannot give.
    expect(refusal.message).toContain("2 main-only, 1 change-only")
    expect(refusal.message).toContain("would revert 2 commits")
  })

  it("exempts a branch that writes no gitlink at all, however far its base has fallen behind", async () => {
    const fixture = await superprojectOverForkedSubmodule()
    // main has advanced dep from a1 to a3; this branch's base still records a1 and it never
    // touches the gitlink. A tree comparison against main would call that a 2-commit regression.
    const head = await fixture.branchTouchingNoGitlink({ mainRecords: fixture.sha.a3 })

    await expect(admissionOutcome(fixture.root, head)).resolves.toEqual({ outcome: "admitted" })
  })

  it("re-asks against main as it stands NOW: the same head admitted earlier is refused once main moves", async () => {
    const fixture = await superprojectOverForkedSubmodule()
    const head = await fixture.branchWriting({ mainRecords: fixture.sha.a1, branchRecords: fixture.sha.a2 })

    // Submit time: main records a1, the branch writes a2 — forward, admitted.
    await expect(admissionOutcome(fixture.root, head)).resolves.toEqual({ outcome: "admitted" })

    // Main moves on to a3. The branch is untouched — same head sha, same diff, same everything.
    await fixture.advanceMainTo(fixture.sha.a3)

    // The earlier green is not a fact anyone can cite: the question is asked again, against
    // where main now is, and the answer has changed. Every path that admits a revision runs
    // this gate, including the queue's own re-merge and preflight passes.
    const refusal = await admissionOutcome(fixture.root, head)
    expect(refusal).toMatchObject({ outcome: "refused", code: "gitlink-moves-backward" })
    if (refusal.outcome !== "refused") throw new Error("unreachable")
    expect(refusal.message).toContain("is behind by 1 commit")
  })

  it("never answers 'backwards' when the submodule checkout cannot be read at all", async () => {
    const fixture = await superprojectOverForkedSubmodule()
    const head = await fixture.branchWriting({ mainRecords: fixture.sha.a3, branchRecords: fixture.sha.a2 })
    // Strip the submodule checkout so nothing about it can be read. Whichever gate speaks
    // first, the one answer that must never come back is a verdict about direction: "could not
    // tell" and "moving backwards" have opposite cures, and reporting the second as the first
    // sends an author to re-merge over what is really an unreadable checkout.
    await rm(join(fixture.root, "dep"), { recursive: true, force: true })
    await mkdir(join(fixture.root, "dep"), { recursive: true })

    const refusal = await admissionOutcome(fixture.root, head)

    expect(refusal).toMatchObject({ outcome: "refused", kind: "refusal" })
    if (refusal.outcome !== "refused") throw new Error("unreachable")
    expect(refusal.code).not.toBe("gitlink-moves-backward")
  })
})

describe("gitlinkDirections — the states the gate reads", () => {
  it("reports a value it cannot find as UNDETERMINED, with the reason, not as a direction", async () => {
    const fixture = await superprojectOverForkedSubmodule()
    const bare = await mkdtemp(join(tmpdir(), "yrd-gitlink-empty-"))
    roots.push(bare)
    await repository(bare)
    await using process = createProcess()
    const baseTipSha = await resolveBaseTip({ process, repo: fixture.root, base: "main" })
    if (baseTipSha === undefined) throw new Error("base tip did not resolve")

    // The superproject records dep at a1; the comparison is pointed at a repository that holds
    // neither a1 nor a3, so both sides are missing.
    const directions = await gitlinkDirections({
      process,
      repo: fixture.root,
      baseTipSha,
      gitlinks: [{ path: "dep", gitlink: fixture.sha.a3, repository: bare }],
    })

    expect(directions).toHaveLength(1)
    expect(directions[0]).toMatchObject({ state: "undetermined", path: "dep" })
    const [only] = directions
    if (only?.state !== "undetermined") throw new Error("unreachable")
    expect(only.reason).toContain("not present in")
    expect(only.reason).toContain(fixture.sha.a1)
    expect(only.reason).toContain(fixture.sha.a3)
  })

  it("reports a path main does not record as ABSENT-ON-MAIN — an addition has nothing to revert", async () => {
    const fixture = await superprojectOverForkedSubmodule()
    await using process = createProcess()
    const baseTipSha = await resolveBaseTip({ process, repo: fixture.root, base: "main" })
    if (baseTipSha === undefined) throw new Error("base tip did not resolve")

    const directions = await gitlinkDirections({
      process,
      repo: fixture.root,
      baseTipSha,
      gitlinks: [{ path: "newdep", gitlink: fixture.sha.a3, repository: join(fixture.root, "dep") }],
    })

    // Whether an addition is ALLOWED is the add-authorization gate's ruling, upstream of this
    // one. Answering it here refused every @cto-authorized submodule addition.
    expect(directions).toEqual([{ state: "absent-on-main", path: "newdep", gitlink: fixture.sha.a3 }])
  })

  it("resolveBaseTip prefers origin/<base>, and reads the TIP rather than the merge base", async () => {
    const fixture = await superprojectOverForkedSubmodule()
    await fixture.branchWriting({ mainRecords: fixture.sha.a3, branchRecords: fixture.sha.a2 })
    await using process = createProcess()

    const tip = await resolveBaseTip({ process, repo: fixture.root, base: "main" })

    expect(tip).toBe(await git(fixture.root, ["rev-parse", "main"]))
    expect(await resolveBaseTip({ process, repo: fixture.root, base: "no-such-branch" })).toBeUndefined()
  })
})

describe("backwardGitlinkRefusal", () => {
  it("distinguishes strictly-behind from diverged, and names the clearing command in both", () => {
    const behind = backwardGitlinkRefusal([
      { state: "backward", path: "vendor/yrd", from: "a".repeat(40), to: "b".repeat(40), behind: 3, ahead: 0 },
    ])
    expect(behind).toContain("is behind by 3 commits")
    expect(behind).not.toContain("DIVERGED")
    expect(behind).toContain("re-merge this change onto current main")

    const diverged = backwardGitlinkRefusal([
      { state: "backward", path: "ag", from: "c".repeat(40), to: "d".repeat(40), behind: 5, ahead: 1 },
    ])
    expect(diverged).toContain("has DIVERGED from it (5 main-only, 1 change-only)")
    expect(diverged).toContain("would revert 5 commits")
    expect(diverged).toContain("re-merge this change onto current main")
  })

  it("reports every backwards gitlink, not just the first — PR2118 moved three at once", () => {
    const message = backwardGitlinkRefusal([
      { state: "backward", path: "ag", from: "a".repeat(40), to: "b".repeat(40), behind: 3, ahead: 0 },
      { state: "backward", path: "km", from: "c".repeat(40), to: "d".repeat(40), behind: 1, ahead: 0 },
      { state: "backward", path: "vendor/yrd", from: "e".repeat(40), to: "f".repeat(40), behind: 5, ahead: 1 },
    ])
    expect(message.split("\n")).toHaveLength(3)
    for (const path of ["ag", "km", "vendor/yrd"]) expect(message).toContain(`submodule '${path}'`)
  })
})
