/**
 * @failure The pre-admission gate's decision changes without a test saying so, because the only
 *          suites naming `authored-gitlink` use it as a fixture label for refusal machinery and
 *          stay green through a behaviour change.
 * @level l1
 * @consumer @i/10-merge-queue/shaset-model step (a) — min-commit admission;
 *           @i/10-merge-queue/intent-deletion-radius step (d) — the admission flip
 *
 * CHARACTERIZATION, not specification. The first describe block below is what step (a) left
 * standing deliberately ("the backstop survives untouched, per the coupling: its deletion
 * ships with the provisioner lift or not at all" — shaset-model.md). Step (d) is that
 * shipment: the provisioner lift merged in step (b), so a published, on-main, single-update
 * authored gitlink is now ADMITTED here — this file's edit IS the record of that change, per
 * its own prior instruction not to "fix" these expectations without changing the model.
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
 * A superproject on `main` recording one submodule commit, plus a branch that advances that
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
  const submodule = join(fixture, "submodule")
  const submoduleRemote = join(fixture, "submodule.git")
  const root = join(fixture, "root")

  await repository(submodule)
  await writeFile(join(submodule, "submodule.txt"), "one\n")
  await git(submodule, ["add", "submodule.txt"])
  await git(submodule, ["commit", "-qm", "submodule one"])
  await git(fixture, ["init", "-q", "--bare", "-b", "main", submoduleRemote])
  await git(submodule, ["remote", "add", "origin", submoduleRemote])
  await git(submodule, ["push", "-q", "-u", "origin", "main"])

  await repository(root)
  await git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", submodule, "dep"])
  await git(root, ["commit", "-qam", "record submodule one"])
  await git(join(root, "dep"), ["remote", "set-url", "origin", submoduleRemote])

  await writeFile(join(submodule, "submodule.txt"), "two\n")
  await git(submodule, ["commit", "-qam", "submodule two"])
  const pin = await git(submodule, ["rev-parse", "HEAD"])

  await git(root, ["checkout", "-q", "-b", "task/hand-bump"])
  await git(join(root, "dep"), ["fetch", "-q", submodule, pin])
  await git(join(root, "dep"), ["checkout", "-q", pin])
  await git(root, ["add", "dep"])
  await git(root, ["commit", "-qm", "bump dep by hand"])
  const headSha = await git(root, ["rev-parse", "HEAD"])

  return {
    root,
    headSha,
    pin,
    publish: async () => {
      await git(submodule, ["push", "-q", "origin", "main"])
    },
    publishToSideBranchOnly: async () => {
      await git(submodule, ["push", "-q", "origin", `${pin}:refs/heads/someones-wip`])
    },
  }
}

/**
 * A superproject on `main` with NO submodule recorded at all, plus a branch that adds one by
 * hand — the shape a min-commit admission must still refuse: the shaset-commit writer
 * (`synthesizeGitlinkWrapper`) is update-only, so an added gitlink can never be filled in from
 * a submodule's main the way an existing one can, no matter how published its target is.
 */
async function superprojectWithHandAddedPin(): Promise<{ root: string; headSha: string }> {
  const fixture = await mkdtemp(join(tmpdir(), "yrd-authored-gitlink-added-"))
  roots.push(fixture)
  const submodule = join(fixture, "submodule")
  const submoduleRemote = join(fixture, "submodule.git")
  const root = join(fixture, "root")

  await repository(submodule)
  await writeFile(join(submodule, "submodule.txt"), "one\n")
  await git(submodule, ["add", "submodule.txt"])
  await git(submodule, ["commit", "-qm", "submodule one"])
  await git(fixture, ["init", "-q", "--bare", "-b", "main", submoduleRemote])
  await git(submodule, ["remote", "add", "origin", submoduleRemote])
  await git(submodule, ["push", "-q", "-u", "origin", "main"])

  await repository(root)
  await writeFile(join(root, "root.txt"), "root\n")
  await git(root, ["add", "root.txt"])
  await git(root, ["commit", "-qm", "root, no submodule yet"])

  await git(root, ["checkout", "-q", "-b", "task/hand-add"])
  await git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", submodule, "dep"])
  await git(root, ["commit", "-qm", "add dep by hand"])
  const headSha = await git(root, ["rev-parse", "HEAD"])
  return { root, headSha }
}

type GateArgs = Parameters<typeof requireQueueableSubmodulePins>

// Only the fields this gate actually reads. Cast at the boundary rather than building a whole PR:
// widening the fixture would make it look like the gate depends on more than it does.
function changeFixture(headSha: string, props?: Readonly<Record<string, string>>): GateArgs[0] {
  return {
    id: "PR9001",
    name: "hand-bumped pin",
    branch: "task/hand-bump",
    base: "main",
    state: "open",
    merged: false,
    issue: "@i/10-merge-queue/shaset-model",
    revs: [
      {
        n: 1,
        head: headSha,
        base: "main",
        baseSha: headSha,
        pushedAt: "2026-08-18T00:00:00.000Z",
        ...(props === undefined ? {} : { props }),
      },
    ],
    reviews: [],
    comments: [],
    checkRequests: [],
  } as unknown as GateArgs[0]
}

async function admissionOutcome(
  root: string,
  headSha: string,
  options: Readonly<{
    props?: Readonly<Record<string, string>>
    authorizeSubmoduleModelChange?: NonNullable<GateArgs[1]["submoduleModelChangeAuthorizer"]>
  }> = {},
): Promise<{ outcome: "admitted" } | { outcome: "refused"; kind: string; code: string; message: string }> {
  await using process = createProcess()
  const services = {
    process,
    ...(options.authorizeSubmoduleModelChange === undefined
      ? {}
      : { submoduleModelChangeAuthorizer: options.authorizeSubmoduleModelChange }),
  } as unknown as GateArgs[1]
  const io = { cwd: root } as unknown as GateArgs[2]
  try {
    await requireQueueableSubmodulePins(changeFixture(headSha, options.props), services, io)
  } catch (error) {
    const fact = failureFact(error)
    if (fact === undefined) throw error
    return { outcome: "refused", kind: fact.kind, code: fact.code, message: fact.message }
  }
  return { outcome: "admitted" }
}

async function refusalFrom(root: string, headSha: string): Promise<{ kind: string; code: string; message: string }> {
  const result = await admissionOutcome(root, headSha)
  if (result.outcome === "admitted") throw new Error("expected a refusal; the gate admitted the branch")
  return result
}

describe("pre-admission gate for hand-written gitlinks — step (d)'s admission flip", () => {
  it("admits a hand-bumped gitlink once the submodule commit is published on its main", async () => {
    const { root, headSha, publish } = await superprojectWithHandBumpedPin()
    await publish()

    // The whole point of step (d): being published and on-main is now enough to be admitted.
    // The queue's own composition-time fill (`fillAuthoredGitlinksFromMain`, unchanged by this
    // step) derives the shaset value from the submodule's main; this gate only needed to stop
    // refusing what that machinery can now safely process.
    await expect(admissionOutcome(root, headSha)).resolves.toEqual({ outcome: "admitted" })
  })

  it("checks publication BEFORE the authored-gitlink question, and the model keeps that order", async () => {
    const { root, headSha } = await superprojectWithHandBumpedPin()
    // Deliberately not published.

    const refusal = await refusalFrom(root, headSha)

    // submodule-main-first still wins the race — an unpublished pin is refused before the
    // gate ever asks whether the change is an update it could otherwise admit.
    expect(refusal).toMatchObject({ kind: "refusal", code: "submodule-pin-unpublished" })
    // The message names the QUESTION the oracle asks — main-ancestry, with main's sha — not
    // the old any-branch phrasing ("is on zero refs fetched from origin").
    expect(refusal.message).toContain("is not on that submodule's main")
    // The remedy no longer names a verb step (d) deletes.
    expect(refusal.message).not.toContain("yrd intent submit")
    expect(refusal.message).toContain("ordinary change")
  })

  it("refuses a pin that is on a side branch and NOT on the submodule's main", async () => {
    const { root, headSha, publishToSideBranchOnly } = await superprojectWithHandBumpedPin()
    await publishToSideBranchOnly()

    const refusal = await refusalFrom(root, headSha)

    // The publication oracle stops it, same as before the admission flip: this case never
    // reaches the authored-gitlink question at all.
    expect(refusal).toMatchObject({ kind: "refusal", code: "submodule-pin-unpublished" })
    expect(refusal.message).toContain("is not on that submodule's main")
  })

  it("still refuses a hand-ADDED gitlink, even when its target is published on the submodule's main", async () => {
    const { root, headSha } = await superprojectWithHandAddedPin()

    const refusal = await refusalFrom(root, headSha)

    // An addition is not a min commit on an existing submodule — the shaset-commit writer
    // cannot fill it in, so the admission flip must not reach a new path. If this ever starts
    // returning "admitted", composition will refuse what the gate just admitted.
    expect(refusal).toMatchObject({ kind: "refusal", code: "authored-gitlink" })
    expect(refusal.message).toContain("dep")
  })

  it("admits a hand-added gitlink only when the exact @cto ruling resolves", async () => {
    const { root, headSha } = await superprojectWithHandAddedPin()
    const ruling = "195c96a6-a461-4c98-a97d-5537e76aa9fd"
    const requests: unknown[] = []

    await expect(
      admissionOutcome(root, headSha, {
        props: { "component-model-change": `add dep; ruling ${ruling}` },
        authorizeSubmoduleModelChange: async (request) => {
          requests.push(request)
          return { authorizer: "@cto" }
        },
      }),
    ).resolves.toEqual({ outcome: "admitted" })
    expect(requests).toEqual([{ operation: "add", path: "dep", ruling, pr: "PR9001", revision: 1, headSha }])
  })
})
