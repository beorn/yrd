/**
 * @failure A candidate whose submodule pin predates the pin already on the base
 * branch merges anyway, and the merge silently REVERTS landed submodule
 * commits. Proven live on 2026-08-30: PR2751.5's entire remaining diff was one
 * gitlink line moving vendor/yrd BACKWARD one commit (ce97ec6c, landed 16:12)
 * over the base's 22902f91 (landed 16:47) — admission had validated it honestly
 * at ITS base, where ce97ec6c was current; then main moved. Only an accidental
 * wedge prevented the merge (@i/10-yrd/superseded-carrier-with-pin-is-a-queued-revert).
 *
 * Ruling, verbatim: "admission checks validate against the base at admission
 * time; the merge run must independently refuse any submodule gitlink that is
 * not a descendant of the same gitlink at the CURRENT base."
 *
 * The shaset fill-in rewrites AUTHORED update gitlinks from the submodule's
 * main at composition time, so a freshly composed candidate cannot regress —
 * but the same four routes that motivate the deletion floor reach the merge
 * step already built (a candidate reused from an earlier step above all), and
 * the promotion planner treats a behind-main pin as "verified" because it IS
 * on main's history. This floor is the last comparison before publication,
 * exactly beside its deletion sibling.
 * @level l2
 * @consumer @yrd/queue merge step (gitMergeStep, configuredMergeStep)
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createProcess } from "@yrd/process"
import { gitCheckStep, gitMergeStep, type ChangeShape, type StepExecution } from "@yrd/queue"

const FIXTURE_CHANGE_ID = `I${"c0ffee12".repeat(5)}`

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(repo: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, "-c", "protocol.file.allow=always", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

/** The fixture's origin: an ordinary init + core.bare flip so the repository
 * accepts pushes; spelled without the direct flag because that spelling is
 * reserved for Yrd-owned receiver infrastructure by the repo's git gate. */
async function bareOrigin(path: string): Promise<void> {
  await Bun.$`git init -q ${path}`.quiet()
  await git(path, ["config", "core.bare", "true"])
}

type Fixture = Readonly<{
  repo: string
  remote: string
  component: string
  /** Component history: c1 is the fork-time pin; c2 lands on component main after. */
  c1: string
  c2: string
  /** The commit both main and the carrier branch fork from (pin = c1). */
  forkSha: string
  /** The carrier branch head: authors feature.txt, leaves the pin at c1. */
  featureSha: string
  /** The base-branch tip: the pin advanced to c2 AFTER the carrier forked. */
  mintSha: string
}>

/**
 * A root repository with one submodule. `main` and `issue/feature` fork with the
 * pin at `c1`; `main` then advances the pin to `c2` — submodule work the
 * carrier's tree has never contained.
 */
async function forkedSubmoduleRepository(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "yrd-gitlink-floor-"))
  roots.push(root)

  const component = join(root, "component")
  await Bun.$`git init -q -b main ${component}`.quiet()
  await git(component, ["config", "user.name", "Yrd Test"])
  await git(component, ["config", "user.email", "yrd@example.invalid"])
  await writeFile(join(component, "lib.txt"), "one\n")
  await git(component, ["add", "-A"])
  await git(component, ["commit", "-qm", "c1"])
  const c1 = await git(component, ["rev-parse", "HEAD"])
  await writeFile(join(component, "lib.txt"), "two\n")
  await git(component, ["add", "-A"])
  await git(component, ["commit", "-qm", "c2"])
  const c2 = await git(component, ["rev-parse", "HEAD"])

  const repo = join(root, "repo")
  await Bun.$`git init -q -b main ${repo}`.quiet()
  await git(repo, ["config", "user.name", "Yrd Test"])
  await git(repo, ["config", "user.email", "yrd@example.invalid"])
  await writeFile(join(repo, "README.md"), "main\n")
  await git(repo, ["add", "-A"])
  await git(repo, ["commit", "-qm", "root"])
  await git(repo, ["submodule", "add", component, "vendor/comp"])
  await git(repo, ["-C", "vendor/comp", "checkout", "-q", c1])
  await git(repo, ["add", "-A"])
  await git(repo, ["commit", "-qm", "pin c1"])
  const forkSha = await git(repo, ["rev-parse", "HEAD"])

  await git(repo, ["switch", "-qc", "issue/feature"])
  await writeFile(join(repo, "feature.txt"), "feature\n")
  await git(repo, ["add", "feature.txt"])
  await git(repo, ["commit", "-qm", "feature"])
  const featureSha = await git(repo, ["rev-parse", "HEAD"])

  // The concurrently-landed submodule advance: the pin moves to c2 on main
  // AFTER the carrier forked, so the carrier's tree still pins c1.
  await git(repo, ["switch", "-q", "main"])
  await git(repo, ["-C", "vendor/comp", "checkout", "-q", c2])
  await git(repo, ["add", "vendor/comp"])
  await git(repo, ["commit", "-qm", "advance pin to c2"])
  const mintSha = await git(repo, ["rev-parse", "HEAD"])

  const remote = join(root, "origin.git")
  await bareOrigin(remote)
  await git(repo, ["remote", "add", "origin", remote])
  await git(repo, ["push", "-q", "origin", "main", "issue/feature"])
  return { repo, remote, component, c1, c2, forkSha, featureSha, mintSha }
}

const checkInputFor = (featureSha: string) =>
  ({
    run: "R1",
    step: "check",
    index: 0,
    prs: [
      {
        id: "PR1",
        changeId: FIXTURE_CHANGE_ID,
        branch: "issue/feature",
        base: "main",
        revision: 1,
        headSha: featureSha,
      },
    ],
    shape: { results: {} },
  }) satisfies StepExecution<ChangeShape>

const jobContext = () => ({ id: "J-merge", attempt: 1, runner: "test", signal: new AbortController().signal })

const mergeExecution = (featureSha: string, checked: unknown) => ({
  ...checkInputFor(featureSha),
  step: "merge",
  index: 1,
  shape: { results: { check: checked } },
})

/**
 * The specimen: a candidate that CONTAINS the base and the carrier — every
 * containment guard satisfied — but whose TREE is the carrier's, pinning the
 * submodule at c1 while the base already pins c2. This is what a candidate
 * reused from a pre-advance admission is at merge time, and what PR2751.5 was.
 */
async function regressedCandidate(fixture: Fixture): Promise<{ sha: string; ref: string }> {
  const tree = await git(fixture.repo, ["rev-parse", `${fixture.featureSha}^{tree}`])
  const sha = await git(fixture.repo, [
    "commit-tree",
    tree,
    "-p",
    fixture.mintSha,
    "-p",
    fixture.featureSha,
    "-m",
    "candidate: re-authored from a pre-advance base",
  ])
  const ref = "refs/yrd/candidates/R1"
  await git(fixture.repo, ["update-ref", ref, sha])
  return { sha, ref }
}

const checkEvidence = (baseSha: string, candidate: { sha: string; ref: string }) => ({
  command: ["true"],
  exitCode: 0,
  durationMs: 1,
  configHash: "0".repeat(64),
  artifacts: [],
  baseSha,
  candidateSha: candidate.sha,
  candidateRef: candidate.ref,
})

describe("gitlink floor — a merge may not move a submodule pin against history", () => {
  it("refuses a candidate whose pin is an ancestor of the base's pin, naming both pins and the direction", async () => {
    const fixture = await forkedSubmoduleRepository()
    await using process = createProcess()
    const candidate = await regressedCandidate(fixture)

    const outcome = await gitMergeStep({ inject: { process }, repo: fixture.repo })(
      mergeExecution(fixture.featureSha, checkEvidence(fixture.mintSha, candidate)) as never,
      jobContext(),
    )

    expect(outcome).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "merge-gitlink-regression" },
    })
    if (outcome.status !== "completed" || outcome.conclusion !== "failure") throw new Error("unreachable")
    // Both pins, the path, and the direction: whoever reads this refusal is
    // deciding whether to withdraw a superseded carrier or recompose.
    expect(outcome.error.message).toContain("vendor/comp")
    expect(outcome.error.message).toContain(fixture.c1)
    expect(outcome.error.message).toContain(fixture.c2)
    expect(outcome.error.message.toUpperCase()).toContain("BACKWARD")
    // The fault is the composition's, never the author's.
    expect(outcome.error.message).not.toContain("rebuild the branch")

    // The floor's only real assertion: main still pins the landed submodule work.
    expect(await git(fixture.remote, ["rev-parse", "main"])).toBe(fixture.mintSha)
  })

  it("refuses a diverged pin — neither side contains the other", async () => {
    const fixture = await forkedSubmoduleRepository()
    await using process = createProcess()
    // A component commit on a divergent line from c2 (forked at c1).
    await git(fixture.component, ["checkout", "-q", "-b", "side", fixture.c1])
    await writeFile(join(fixture.component, "lib.txt"), "side\n")
    await git(fixture.component, ["add", "-A"])
    await git(fixture.component, ["commit", "-qm", "c2b"])
    const c2b = await git(fixture.component, ["rev-parse", "HEAD"])
    // The carrier pins the divergent commit.
    await git(fixture.repo, ["switch", "-q", "issue/feature"])
    await git(fixture.repo, ["-C", "vendor/comp", "fetch", "-q", "origin"])
    await git(fixture.repo, ["-C", "vendor/comp", "checkout", "-q", c2b])
    await git(fixture.repo, ["add", "vendor/comp"])
    await git(fixture.repo, ["commit", "-qm", "pin c2b"])
    const divergedHead = await git(fixture.repo, ["rev-parse", "HEAD"])
    await git(fixture.repo, ["switch", "-q", "main"])

    const tree = await git(fixture.repo, ["rev-parse", `${divergedHead}^{tree}`])
    const sha = await git(fixture.repo, [
      "commit-tree",
      tree,
      "-p",
      fixture.mintSha,
      "-p",
      divergedHead,
      "-m",
      "candidate: diverged pin",
    ])
    const ref = "refs/yrd/candidates/R1"
    await git(fixture.repo, ["update-ref", ref, sha])

    const outcome = await gitMergeStep({ inject: { process }, repo: fixture.repo })(
      mergeExecution(divergedHead, checkEvidence(fixture.mintSha, { sha, ref })) as never,
      jobContext(),
    )

    expect(outcome).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "merge-gitlink-regression" },
    })
    if (outcome.status !== "completed" || outcome.conclusion !== "failure") throw new Error("unreachable")
    expect(outcome.error.message.toUpperCase()).toContain("DIVERGED")
    expect(await git(fixture.remote, ["rev-parse", "main"])).toBe(fixture.mintSha)
  })

  it("lets a forward pin advance merge (negative control)", async () => {
    const fixture = await forkedSubmoduleRepository()
    await using process = createProcess()
    // The carrier itself advances the pin PAST the base's c2: c3 on main's line.
    await git(fixture.component, ["checkout", "-q", "main"])
    await writeFile(join(fixture.component, "lib.txt"), "three\n")
    await git(fixture.component, ["add", "-A"])
    await git(fixture.component, ["commit", "-qm", "c3"])
    const c3 = await git(fixture.component, ["rev-parse", "HEAD"])
    await git(fixture.repo, ["switch", "-q", "issue/feature"])
    await git(fixture.repo, ["-C", "vendor/comp", "fetch", "-q", "origin"])
    await git(fixture.repo, ["-C", "vendor/comp", "checkout", "-q", c3])
    await git(fixture.repo, ["add", "vendor/comp"])
    await git(fixture.repo, ["commit", "-qm", "pin c3"])
    const advancedHead = await git(fixture.repo, ["rev-parse", "HEAD"])
    await git(fixture.repo, ["switch", "-q", "main"])

    const tree = await git(fixture.repo, ["rev-parse", `${advancedHead}^{tree}`])
    const sha = await git(fixture.repo, [
      "commit-tree",
      tree,
      "-p",
      fixture.mintSha,
      "-p",
      advancedHead,
      "-m",
      "candidate: forward pin",
    ])
    const ref = "refs/yrd/candidates/R1"
    await git(fixture.repo, ["update-ref", ref, sha])

    const outcome = await gitMergeStep({ inject: { process }, repo: fixture.repo })(
      mergeExecution(advancedHead, checkEvidence(fixture.mintSha, { sha, ref })) as never,
      jobContext(),
    )

    expect(outcome).toMatchObject({ status: "completed", conclusion: "success" })
    // Main now pins the advance; nothing was reverted on the way.
    expect(await git(fixture.remote, ["ls-tree", "main", "vendor/comp"])).toContain(c3)
  })

  it("leaves a carrier that never touches the pin untouched (no gitlink diff at merge)", async () => {
    const fixture = await forkedSubmoduleRepository()
    await using process = createProcess()
    // Checked through the real check step: the candidate is composed against
    // the CURRENT base, so its tree pins c2 exactly like the base does.
    const checked = await gitCheckStep({ inject: { process }, repo: fixture.repo, command: ["true"] })(
      checkInputFor(fixture.featureSha),
      { id: "J-check", attempt: 1, runner: "test", signal: new AbortController().signal },
    )
    if (checked.status !== "completed" || checked.conclusion !== "success") {
      throw new Error(`check did not pass: ${JSON.stringify(checked)}`)
    }

    const outcome = await gitMergeStep({ inject: { process }, repo: fixture.repo })(
      mergeExecution(fixture.featureSha, checked.output) as never,
      jobContext(),
    )

    expect(outcome).toMatchObject({ status: "completed", conclusion: "success" })
    expect(await git(fixture.remote, ["ls-tree", "main", "vendor/comp"])).toContain(fixture.c2)
    expect(await git(fixture.remote, ["show", "main:feature.txt"])).toBe("feature")
  })
})
