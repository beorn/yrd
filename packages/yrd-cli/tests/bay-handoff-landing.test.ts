/**
 * @failure The handoff-ready SLA alarm asserts a state of the world it never measured:
 *          it fires on branches whose work already landed, and it keeps recommending a
 *          certified head whose gitlinks have aged out from under it.
 * @level l1
 * @consumer @i/10-yrd/bay-alarm-never-checks-landing — 21 of 38 firings verified false in one night
 *           @i/10-yrd/handoff-ready-ages-into-revert — certification never expires, so its advice rots
 *
 * BOTH DIRECTIONS ARE LOAD-BEARING HERE. A fix that silences the alarm is a regression, not a
 * fix, so every false-positive class below is paired with a true positive that must still alarm.
 * The false classes are drawn from the beads' own census (n=13): three heads were ancestors of
 * main, and four more had landed by carrier regeneration and were ancestors of nothing.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProcess } from "@yrd/process"
import { afterEach, describe, expect, it } from "vitest"
import {
  certificationFreshness,
  classifyBranchLanding,
  projectHandoffReadyLanding,
} from "../src/bay-handoff-landing.ts"

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

async function commit(repo: string, file: string, body: string, message: string): Promise<string> {
  await writeFile(join(repo, file), body)
  await git(repo, ["add", file])
  await git(repo, ["commit", "-qm", message])
  return git(repo, ["rev-parse", "HEAD"])
}

/** A root repository with a real `origin` the base resolver can fetch from. */
async function estate(): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), "yrd-bay-landing-"))
  roots.push(fixture)
  const root = join(fixture, "root")
  const remote = join(fixture, "remote.git")
  await repository(root)
  await commit(root, "base.txt", "base\n", "base")
  await git(fixture, ["init", "-q", "--bare", "-b", "main", remote])
  await git(root, ["remote", "add", "origin", remote])
  await git(root, ["push", "-q", "--no-recurse-submodules", "-u", "origin", "main"])
  return root
}

async function process_() {
  return createProcess()
}

describe("landing check — the alarm must ask whether the work landed", () => {
  it("STILL ALARMS on a branch carrying genuinely unlanded content", async () => {
    const root = await estate()
    await git(root, ["checkout", "-q", "-b", "task/stranded"])
    const head = await commit(root, "stranded.txt", "only here\n", "stranded work")
    await git(root, ["checkout", "-q", "main"])

    const landing = await classifyBranchLanding({
      process: await process_(),
      repo: root,
      head,
      base: "main",
    })

    // The true positive. Six of the census's thirteen were this, and they are the
    // whole reason the alarm exists.
    expect(landing).toEqual({ state: "unlanded", uniqueCommits: 1 })
  })

  it("does NOT alarm when the head is an ancestor of main (B241/B245/B252)", async () => {
    const root = await estate()
    const head = await git(root, ["rev-parse", "HEAD"])
    // Main moves on underneath a branch that already landed — the exact shape that had
    // an alarm demanding submission of a revision sitting 84 commits back on main.
    await commit(root, "later.txt", "main moved\n", "main advances")
    await git(root, ["push", "-q", "--no-recurse-submodules", "origin", "main"])

    const landing = await classifyBranchLanding({
      process: await process_(),
      repo: root,
      head,
      base: "main",
    })

    expect(landing).toEqual({ state: "landed", via: "ancestry" })
  })

  it("does NOT alarm when a regenerated carrier landed the content (B243/B249/B250/B251)", async () => {
    const root = await estate()
    await git(root, ["checkout", "-q", "-b", "task/regenerated"])
    const head = await commit(root, "carried.txt", "carried payload\n", "authored commit")
    await git(root, ["checkout", "-q", "main"])
    // Main moves first, so the regenerated carrier lands on a different parent. Without
    // this the cherry-pick reproduces an identical sha and the scenario is not the one
    // the bead describes.
    await commit(root, "unrelated.txt", "main moved\n", "main advances")
    // Yrd regenerates the carrier, so what lands is a DIFFERENT sha with the same patch.
    await git(root, ["cherry-pick", head])
    await git(root, ["push", "-q", "--no-recurse-submodules", "origin", "main"])

    const landed = await git(root, ["rev-parse", "HEAD"])
    expect(landed).not.toBe(head)
    // Positive control: ancestry alone genuinely cannot see this, which is why the
    // content leg exists. Four of the census's seven landed branches were only this.
    await expect(git(root, ["merge-base", "--is-ancestor", head, "main"])).rejects.toThrow()

    const landing = await classifyBranchLanding({
      process: await process_(),
      repo: root,
      head,
      base: "main",
    })

    expect(landing).toEqual({ state: "landed", via: "content" })
  })

  it("counts every unlanded commit, so a partially-landed branch still alarms", async () => {
    const root = await estate()
    await git(root, ["checkout", "-q", "-b", "task/partial"])
    const first = await commit(root, "shared.txt", "shared\n", "shared commit")
    const head = await commit(root, "unique.txt", "unique\n", "unique commit")
    await git(root, ["checkout", "-q", "main"])
    // Main moves first, for the same reason the regenerated-carrier case above moves it:
    // cherry-picking onto the UNMOVED tip reproduces `first` byte-for-byte whenever the
    // replay lands in the same wall-clock second as the original, and then `shared commit`
    // is on main by ANCESTRY. The count would still read 1, so nothing goes red — but
    // `--cherry-pick` would have nothing to do, and this test's whole subject, that one of
    // the two landed BY PATCH, would go unexercised in most runs.
    await commit(root, "unrelated.txt", "main moved\n", "main advances")
    await git(root, ["cherry-pick", first])
    await git(root, ["push", "-q", "--no-recurse-submodules", "origin", "main"])
    // Precondition, stated rather than assumed: what landed is a DIFFERENT sha carrying the
    // same patch, so patch equivalence is the only thing that can see it.
    expect(await git(root, ["rev-parse", "HEAD"])).not.toBe(first)
    await expect(git(root, ["merge-base", "--is-ancestor", first, "main"])).rejects.toThrow()

    const landing = await classifyBranchLanding({
      process: await process_(),
      repo: root,
      head,
      base: "main",
    })

    // One of the two is on main by patch; the other is not. Still unlanded, and the
    // count is the honest denominator rather than a bare boolean.
    expect(landing).toEqual({ state: "unlanded", uniqueCommits: 1 })
  })
})

describe("certification freshness — the alarm must not recommend a head it can no longer vouch for", () => {
  /** Root + one real submodule at `dep`, both published to bare remotes. */
  async function estateWithSubmodule(): Promise<{ root: string; dep: string }> {
    const fixture = await mkdtemp(join(tmpdir(), "yrd-bay-freshness-"))
    roots.push(fixture)
    const root = join(fixture, "root")
    const rootRemote = join(fixture, "root.git")
    const dep = join(fixture, "dep")
    const depRemote = join(fixture, "dep.git")

    await repository(dep)
    await commit(dep, "dep.txt", "dep one\n", "dep one")
    await git(fixture, ["init", "-q", "--bare", "-b", "main", depRemote])
    await git(dep, ["remote", "add", "origin", depRemote])
    await git(dep, ["push", "-q", "-u", "origin", "main"])

    await repository(root)
    await commit(root, "base.txt", "base\n", "base")
    await git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", dep, "dep"])
    await git(root, ["commit", "-qam", "record dep"])
    await git(join(root, "dep"), ["remote", "set-url", "origin", depRemote])
    await git(fixture, ["init", "-q", "--bare", "-b", "main", rootRemote])
    await git(root, ["remote", "add", "origin", rootRemote])
    await git(root, ["push", "-q", "--no-recurse-submodules", "-u", "origin", "main"])
    return { root, dep }
  }

  /** Move `dep` to a new commit and record that bump on the current root branch. */
  async function bumpDep(root: string, dep: string, body: string, message: string): Promise<string> {
    await commit(dep, "dep.txt", body, message)
    const pin = await git(dep, ["rev-parse", "HEAD"])
    await git(dep, ["push", "-q", "origin", "main"])
    await git(join(root, "dep"), ["fetch", "-q", "origin", pin])
    await git(join(root, "dep"), ["checkout", "-q", pin])
    await git(root, ["add", "dep"])
    await git(root, ["commit", "-qm", message])
    return pin
  }

  it("is STALE when the branch changed a pin and main has since moved that same pin", async () => {
    const { root, dep } = await estateWithSubmodule()
    await git(root, ["checkout", "-q", "-b", "task/changed-pin"])
    const certified = await bumpDep(root, dep, "dep two\n", "branch bumps dep")
    const head = await git(root, ["rev-parse", "HEAD"])

    await git(root, ["checkout", "-q", "main"])
    const onMain = await bumpDep(root, dep, "dep three\n", "main bumps dep")
    await git(root, ["push", "-q", "--no-recurse-submodules", "origin", "main"])

    const freshness = await certificationFreshness({
      process: await process_(),
      repo: root,
      head,
      base: "main",
    })

    expect(freshness).toEqual({
      state: "stale",
      pins: [{ path: "dep", certified, main: onMain }],
    })
  })

  it("is FRESH when the branch never touched the pin and only main moved it", async () => {
    const { root, dep } = await estateWithSubmodule()
    await git(root, ["checkout", "-q", "-b", "task/inherited-pin"])
    // The branch changes an ordinary file and leaves `dep` exactly as it inherited it.
    const head = await commit(root, "work.txt", "work\n", "unrelated work")

    await git(root, ["checkout", "-q", "main"])
    await bumpDep(root, dep, "dep three\n", "main bumps dep")
    await git(root, ["push", "-q", "--no-recurse-submodules", "origin", "main"])

    const freshness = await certificationFreshness({
      process: await process_(),
      repo: root,
      head,
      base: "main",
    })

    // THE FALSE-POSITIVE GUARD, and the bead's own § CORRECTED finding. Tip-versus-main
    // reports this pin as differing; a three-way merge takes main's newer value and
    // reverts nothing. Only a base→tip read tells the two apart, and calling this stale
    // is how a bulk "rebase the set" ruling silently discards a sibling's pin.
    expect(freshness).toEqual({ state: "fresh" })
  })

  it("is FRESH when the branch changed a pin main has not touched since", async () => {
    const { root, dep } = await estateWithSubmodule()
    await git(root, ["checkout", "-q", "-b", "task/ahead-pin"])
    await bumpDep(root, dep, "dep two\n", "branch bumps dep")
    const head = await git(root, ["rev-parse", "HEAD"])
    await git(root, ["checkout", "-q", "main"])

    const freshness = await certificationFreshness({
      process: await process_(),
      repo: root,
      head,
      base: "main",
    })

    // The branch is the only writer of this pin. Nothing has aged, so the certification
    // still says what it said — the alarm may name this head.
    expect(freshness).toEqual({ state: "fresh" })
  })
})

describe("degradation — an underivable fact must be loud, never absent", () => {
  it("carries an explicit unknown, with the reason, when the base cannot be resolved", async () => {
    const root = await estate()
    await git(root, ["checkout", "-q", "-b", "task/unresolvable"])
    const head = await commit(root, "work.txt", "work\n", "work")

    const projection = await projectHandoffReadyLanding({
      process: await process_(),
      repo: root,
      head,
      base: "no-such-base",
    })

    // NOT silence, and NOT a thrown listing. An absent landing fact reads as "not landed"
    // to the alarm, which is exactly the false firing this whole projection removes — so
    // the failure has to survive into the output where its consumer can see it.
    expect(projection.landing.state).toBe("unknown")
    expect(projection.certification.state).toBe("unknown")
    expect(projection.landing).toMatchObject({ detail: expect.stringContaining("no-such-base") })
  })

  it("degrades the two facts independently, so a readable one still lands", async () => {
    const root = await estate()
    const head = await git(root, ["rev-parse", "HEAD"])
    await commit(root, "later.txt", "main moved\n", "main advances")
    await git(root, ["push", "-q", "--no-recurse-submodules", "origin", "main"])

    const projection = await projectHandoffReadyLanding({
      process: await process_(),
      repo: root,
      head,
      base: "main",
    })

    // A repository with no submodules has nothing to age, so both facts are decidable
    // here; the point is that the landing verdict is not held hostage to the other.
    expect(projection).toEqual({
      landing: { state: "landed", via: "ancestry" },
      certification: { state: "fresh" },
    })
  })
})
