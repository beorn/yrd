/**
 * @failure A candidate whose tree predates work already on the base branch lands
 * anyway, and the landing silently DELETES that work. Proven live on 2026-07-23:
 * merge `d52ed8dc6d` carried candidate `445e809b17` (a full-tree recomposition)
 * onto `6427898550` and removed five bead files minted by `076d61f9c3` minutes
 * earlier, with no conflict, no refusal and nothing in the run's evidence.
 *
 * The composition-time guard (`unauthored-path-deletion`) rules on ONE carrier's
 * merge at the moment it is applied. It cannot rule on a candidate that reaches
 * the merge step already built — reused from a prior step, re-authored by the
 * submodule-composition branch, or produced by a configured external merge
 * command. This is the floor under all of them: the last comparison before the
 * candidate becomes the base branch.
 * @level l2
 * @consumer @yrd/queue merge step (gitMergeStep, configuredMergeStep)
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createProcess, type Process } from "@yrd/process"
import { gitCheckStep, gitMergeStep, type ChangeShape, type StepExecution } from "@yrd/queue"

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

/** Present-or-absent for one path at one revision, without throwing on absence. */
async function present(repo: string, rev: string, path: string): Promise<boolean> {
  return (await git(repo, ["ls-tree", "--name-only", rev, "--", path])) !== ""
}

type Fixture = Readonly<{
  repo: string
  remote: string
  /** The commit both main and the carrier branch fork from. */
  forkSha: string
  /** The carrier branch head, as its author left it. */
  featureSha: string
  /** The base-branch tip, carrying work the carrier never saw. */
  mintSha: string
}>

/**
 * `main` and `issue/feature` fork at `forkSha`; `main` then advances with
 * `mint.md`, a path the carrier never touches. `seed` files exist at the fork so
 * a control can author a deletion of its own file.
 */
async function forkedRepository(
  seed: Readonly<Record<string, string>> = {},
  minted: readonly string[] = ["mint.md"],
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "yrd-landing-floor-"))
  roots.push(root)
  const repo = join(root, "repo")
  await Bun.$`git init -q -b main ${repo}`
  await git(repo, ["config", "user.name", "Yrd Test"])
  await git(repo, ["config", "user.email", "yrd@example.invalid"])
  await writeFile(join(repo, "README.md"), "main\n")
  for (const [path, content] of Object.entries(seed)) await writeFile(join(repo, path), content)
  await git(repo, ["add", "-A"])
  await git(repo, ["commit", "-qm", "main"])
  const forkSha = await git(repo, ["rev-parse", "HEAD"])

  await git(repo, ["switch", "-qc", "issue/feature"])
  await writeFile(join(repo, "feature.txt"), "feature\n")
  await git(repo, ["add", "feature.txt"])
  await git(repo, ["commit", "-qm", "feature"])
  const featureSha = await git(repo, ["rev-parse", "HEAD"])

  // The concurrently-landed work. It lands on main AFTER the carrier forked, so
  // the carrier's own tree has never contained it.
  await git(repo, ["switch", "-q", "main"])
  for (const path of minted) await writeFile(join(repo, path), "minted\n")
  await git(repo, ["add", "-A"])
  await git(repo, ["commit", "-qm", "mint"])
  const mintSha = await git(repo, ["rev-parse", "HEAD"])

  const remote = join(root, "origin.git")
  await Bun.$`git init -q --bare ${remote}`
  await git(repo, ["remote", "add", "origin", remote])
  await git(repo, ["push", "-q", "origin", "main", "issue/feature"])
  return { repo, remote, forkSha, featureSha, mintSha }
}

const checkInputFor = (featureSha: string) =>
  ({
    run: "R1",
    step: "check",
    index: 0,
    prs: [{ id: "PR1", branch: "issue/feature", base: "main", revision: 1, headSha: featureSha }],
    shape: { results: {} },
  }) satisfies StepExecution<ChangeShape>

const jobContext = () => ({ id: "J-merge", attempt: 1, runner: "test", signal: new AbortController().signal })

const mergeExecution = (featureSha: string, checked: unknown) => ({
  ...checkInputFor(featureSha),
  step: "merge",
  index: 1,
  shape: { results: { check: checked } },
})

/** Run the real check step so the merge step receives a real checked candidate. */
async function checkedCandidate(repo: string, process: Pick<Process, "run">, featureSha: string) {
  const checked = await gitCheckStep({ inject: { process }, repo, command: ["true"] })(checkInputFor(featureSha), {
    id: "J-check",
    attempt: 1,
    runner: "test",
    signal: new AbortController().signal,
  })
  if (checked.status !== "completed" || checked.conclusion !== "success") {
    throw new Error(`check did not pass: ${JSON.stringify(checked)}`)
  }
  return checked.output
}

/**
 * The specimen: a candidate commit that CONTAINS the base and the carrier — so
 * every containment guard is satisfied — but whose TREE is the carrier's, taken
 * from before the base advanced. This is what a full-tree recomposition from a
 * stale base produces, and what `445e809b17` was.
 */
async function recomposedCandidate(fixture: Fixture): Promise<{ sha: string; ref: string }> {
  const tree = await git(fixture.repo, ["rev-parse", `${fixture.featureSha}^{tree}`])
  const sha = await git(fixture.repo, [
    "commit-tree",
    tree,
    "-p",
    fixture.mintSha,
    "-p",
    fixture.featureSha,
    "-m",
    "candidate: re-authored from a pre-mint base",
  ])
  const ref = "refs/yrd/candidates/R1"
  await git(fixture.repo, ["update-ref", ref, sha])
  return { sha, ref }
}

/** A checked-candidate evidence record the merge step accepts as its prior. */
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

describe("landing floor — a merge may not delete paths no submitted branch authors deleting", () => {
  it("refuses a candidate whose tree predates landed work, and names every path it would erase", async () => {
    const fixture = await forkedRepository()
    await using process = createProcess()
    const candidate = await recomposedCandidate(fixture)

    const outcome = await gitMergeStep({ inject: { process }, repo: fixture.repo })(
      mergeExecution(fixture.featureSha, checkEvidence(fixture.mintSha, candidate)) as never,
      jobContext(),
    )

    expect(outcome).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "landing-unauthored-deletion" },
    })
    if (outcome.status !== "completed" || outcome.conclusion !== "failure") throw new Error("unreachable")
    // Naming the path verbatim is the whole point: the 2026-07-23 landing was
    // found by hand days later precisely because nothing named what it removed.
    expect(outcome.error.message).toContain("mint.md")
    // The refusal must place the fault on the composition, not on the author.
    expect(outcome.error.code).not.toBe("merge-failed")
    expect(outcome.error.message).not.toContain("rebuild the branch")

    // The floor's only real assertion: main still carries the landed work.
    expect(await git(fixture.remote, ["rev-parse", "main"])).toBe(fixture.mintSha)
    expect(await present(fixture.remote, "main", "mint.md")).toBe(true)
  })

  it("names every erased path, never a truncated sample", async () => {
    // The composition-time sibling stops at eight and appends an ellipsis. Here
    // the list IS the finding — the 2026-07-23 landing erased five files and the
    // count only became knowable by diffing the merge by hand afterwards.
    const minted = Array.from({ length: 12 }, (_, at) => `mint-${String(at).padStart(2, "0")}.md`)
    const fixture = await forkedRepository({}, minted)
    await using process = createProcess()
    const candidate = await recomposedCandidate(fixture)

    const outcome = await gitMergeStep({ inject: { process }, repo: fixture.repo })(
      mergeExecution(fixture.featureSha, checkEvidence(fixture.mintSha, candidate)) as never,
      jobContext(),
    )

    expect(outcome).toMatchObject({ conclusion: "failure", error: { code: "landing-unauthored-deletion" } })
    if (outcome.status !== "completed" || outcome.conclusion !== "failure") throw new Error("unreachable")
    for (const path of minted) expect(outcome.error.message).toContain(path)
    expect(outcome.error.message).not.toContain("…")
    expect(await git(fixture.remote, ["rev-parse", "main"])).toBe(fixture.mintSha)
  })

  it("lets a carrier's own authored deletion land", async () => {
    const fixture = await forkedRepository({ "doomed.txt": "doomed\n" })
    await using process = createProcess()
    await git(fixture.repo, ["switch", "-q", "issue/feature"])
    await git(fixture.repo, ["rm", "-q", "doomed.txt"])
    await git(fixture.repo, ["commit", "-qm", "remove doomed.txt"])
    const featureSha = await git(fixture.repo, ["rev-parse", "HEAD"])
    await git(fixture.repo, ["switch", "-q", "main"])
    await git(fixture.repo, ["push", "-q", "-f", "origin", "issue/feature"])

    const checked = await checkedCandidate(fixture.repo, process, featureSha)
    const outcome = await gitMergeStep({ inject: { process }, repo: fixture.repo })(
      mergeExecution(featureSha, checked) as never,
      jobContext(),
    )

    expect(outcome).toMatchObject({ status: "completed", conclusion: "success" })
    // The authored deletion landed, and the concurrent landing survived it.
    expect(await present(fixture.remote, "main", "doomed.txt")).toBe(false)
    expect(await present(fixture.remote, "main", "mint.md")).toBe(true)
  })

  it("leaves a carrier that deletes nothing untouched", async () => {
    const fixture = await forkedRepository()
    await using process = createProcess()

    const checked = await checkedCandidate(fixture.repo, process, fixture.featureSha)
    const outcome = await gitMergeStep({ inject: { process }, repo: fixture.repo })(
      mergeExecution(fixture.featureSha, checked) as never,
      jobContext(),
    )

    expect(outcome).toMatchObject({ status: "completed", conclusion: "success" })
    expect(await git(fixture.remote, ["show", "main:feature.txt"])).toBe("feature")
    expect(await present(fixture.remote, "main", "mint.md")).toBe(true)
  })
})
