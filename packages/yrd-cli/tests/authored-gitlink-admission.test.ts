/**
 * @failure The pre-admission gate's decision changes without a test saying so, because the only
 *          suites naming `authored-gitlink` use it as a fixture label for refusal machinery and
 *          stay green through a behaviour change.
 * @level l1
 * @consumer @i/10-merge-queue/shaset-model step (a) — min-commit admission
 *
 * CHARACTERIZATION, not specification. Every assertion below pins what the gate does TODAY, so
 * that when step (a) replaces the authored-gitlink refusal with derivation, the edit to this file
 * IS the record of the behaviour change. Do not "fix" these expectations to match the new model
 * without changing the model — change them deliberately, in the same commit as the code.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { failureFact } from "@yrd/core"
import { createProcess } from "@yrd/process"
import { afterEach, describe, expect, it } from "vitest"
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

/**
 * A superproject on `main` recording one component commit, plus a branch that advances that
 * gitlink by hand — the exact shape an author produces when they bump a pin themselves.
 * `main` deliberately stays at the base so the gate's live merge-base lookup has two sides.
 */
async function superprojectWithHandBumpedPin(): Promise<{
  root: string
  headSha: string
  pin: string
  publish: () => Promise<void>
  publishToSideBranchOnly: () => Promise<void>
}> {
  const fixture = await mkdtemp(join(tmpdir(), "yrd-authored-gitlink-"))
  roots.push(fixture)
  const component = join(fixture, "component")
  const componentRemote = join(fixture, "component.git")
  const root = join(fixture, "root")

  await repository(component)
  await writeFile(join(component, "component.txt"), "one\n")
  await git(component, ["add", "component.txt"])
  await git(component, ["commit", "-qm", "component one"])
  await git(fixture, ["init", "-q", "--bare", "-b", "main", componentRemote])
  await git(component, ["remote", "add", "origin", componentRemote])
  await git(component, ["push", "-q", "-u", "origin", "main"])

  await repository(root)
  await git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", component, "dep"])
  await git(root, ["commit", "-qam", "record component one"])
  await git(join(root, "dep"), ["remote", "set-url", "origin", componentRemote])

  await writeFile(join(component, "component.txt"), "two\n")
  await git(component, ["commit", "-qam", "component two"])
  const pin = await git(component, ["rev-parse", "HEAD"])

  await git(root, ["checkout", "-q", "-b", "task/hand-bump"])
  await git(join(root, "dep"), ["fetch", "-q", component, pin])
  await git(join(root, "dep"), ["checkout", "-q", pin])
  await git(root, ["add", "dep"])
  await git(root, ["commit", "-qm", "bump dep by hand"])
  const headSha = await git(root, ["rev-parse", "HEAD"])

  return {
    root,
    headSha,
    pin,
    publish: async () => {
      await git(component, ["push", "-q", "origin", "main"])
    },
    publishToSideBranchOnly: async () => {
      await git(component, ["push", "-q", "origin", `${pin}:refs/heads/someones-wip`])
    },
  }
}

type GateArgs = Parameters<typeof requireQueueableSubmodulePins>

// Only the fields this gate actually reads. Cast at the boundary rather than building a whole PR:
// widening the fixture would make it look like the gate depends on more than it does.
function prFixture(headSha: string): GateArgs[0] {
  return {
    id: "PR9001",
    name: "hand-bumped pin",
    branch: "task/hand-bump",
    base: "main",
    state: "open",
    merged: false,
    issue: "@i/10-merge-queue/shaset-model",
    revs: [{ n: 1, head: headSha, base: "main", baseSha: headSha, pushedAt: "2026-08-18T00:00:00.000Z" }],
    reviews: [],
    comments: [],
    checkRequests: [],
  } as unknown as GateArgs[0]
}

async function refusalFrom(root: string, headSha: string): Promise<{ kind: string; code: string; message: string }> {
  await using process = createProcess()
  const services = { process } as unknown as GateArgs[1]
  const io = { cwd: root } as unknown as GateArgs[2]
  try {
    await requireQueueableSubmodulePins(prFixture(headSha), services, io)
  } catch (error) {
    const fact = failureFact(error)
    if (fact === undefined) throw error
    return { kind: fact.kind, code: fact.code, message: fact.message }
  }
  throw new Error("the gate admitted a hand-bumped gitlink; that is the step-(a) behaviour, not today's")
}

describe("pre-admission gate for hand-written gitlinks — behaviour as of the shaset build's start", () => {
  it("refuses a hand-bumped gitlink even when the component commit IS published", async () => {
    const { root, headSha, publish } = await superprojectWithHandBumpedPin()
    await publish()

    const refusal = await refusalFrom(root, headSha)

    // The whole point of step (a): being published is NOT currently enough to be admitted.
    expect(refusal).toMatchObject({ kind: "refusal", code: "authored-gitlink" })
    expect(refusal.message).toContain("authored gitlinks are never admitted")
    expect(refusal.message).toContain("dep")

    // CROSS-STEP COUPLING, pinned deliberately. The remedy tells the author to run
    // `yrd intent submit`, and step (d) DELETES that verb along with the PinIntent kind.
    // `actionable-errors.test.ts` separately asserts this same remedy and will keep passing
    // after the verb is gone, so this is the one place that fails and names the dependency.
    // If you are here because this broke: the remedy must change in the same commit as the
    // verb, not afterwards.
    expect(refusal.message).toContain("yrd intent submit")
  })

  it("checks publication BEFORE the authored-gitlink refusal, and the model keeps that order", async () => {
    const { root, headSha } = await superprojectWithHandBumpedPin()
    // Deliberately not published.

    const refusal = await refusalFrom(root, headSha)

    // submodule-main-first wins the race. Step (a) turns this refusal into a park; it must not
    // turn it into an admission, and it must keep beating the authored-gitlink branch.
    expect(refusal).toMatchObject({ kind: "refusal", code: "submodule-pin-unpublished" })
    // The message names the QUESTION the oracle now asks — main-ancestry, with main's sha —
    // not the old any-branch phrasing ("is on zero refs fetched from origin"), which became
    // false the moment the oracle tightened: a side-branch pin IS on a ref, just not on main.
    expect(refusal.message).toContain("is not on that component's main")
  })

  /**
   * THE GAP STEP (a) HAD TO CLOSE — flipped deliberately, in the same commit as the oracle.
   *
   * The shaset model says a min commit is satisfied by "the newest commit on that submodule's
   * MAIN", and calls the rule submodule-main-first. The old oracle did not ask that question:
   * it passed git-super `refPrefixes: ["refs/heads/"]`, which is EVERY branch, so a commit on
   * someone's unmerged side branch counted as published and only the authored-gitlink backstop
   * stopped it. The oracle now asks the merge path's own question — fetch the component's main
   * into the shared probe ref, then ancestry — so the side-branch pin is refused by the
   * publication check itself, before the backstop.
   *
   * The characterization above said "when this flips, it must flip to a park, never to an
   * admission". A refusal is not an admission; the park CONVERSION arrives with the queue-side
   * derivation set, which ships together with the backstop's deletion — not with the oracle.
   */
  it("refuses a pin that is on a side branch and NOT on the component's main", async () => {
    const { root, headSha, publishToSideBranchOnly } = await superprojectWithHandBumpedPin()
    await publishToSideBranchOnly()

    const refusal = await refusalFrom(root, headSha)

    // The oracle itself stops it now — reaching `authored-gitlink` here would mean the
    // publication check waved through a pin the component's main never accepted.
    expect(refusal).toMatchObject({ kind: "refusal", code: "submodule-pin-unpublished" })
    expect(refusal.message).toContain("is not on that component's main")
  })
})
