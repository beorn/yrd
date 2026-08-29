/**
 * @failure The queue asks "is this member already in the base?" once, as a check
 * that can answer no, then throws the answer away — so every later consumer
 * re-derives it from the COLLAPSED candidate, where `is-ancestor X X`,
 * `candidateSha === baseSha` and `tree(X) === tree(X)` all answer yes for free.
 * Three tautologies stood in for one real measurement. Measured live
 * 2026-08-28: PR2145, PR2462, PR2503 and PR2504 handed `fd5a0d02..fd5a0d02`.
 * @level l2
 * @consumer @yrd/queue candidate construction
 */
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { safeRemove } from "removely"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createProcess } from "@yrd/process"
import { gitCheckStep, GitCheckEvidenceSchema, type ChangeShape, type StepExecution } from "@yrd/queue"

const FIXTURE_CHANGE_ID = `I${"c0ffee12".repeat(5)}`

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => safeRemove(root, { within: tmpdir(), allowMissing: true })))
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

async function repoOnMain(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  const repo = join(root, "repo")
  await Bun.$`git init -q -b main ${repo}`
  await git(repo, ["config", "user.name", "Yrd Test"])
  await git(repo, ["config", "user.email", "yrd@example.invalid"])
  await writeFile(join(repo, "README.md"), "main\n")
  await git(repo, ["add", "README.md"])
  await git(repo, ["commit", "-qm", "main"])
  return repo
}

/** The blocked-candidate shape: the branch was fast-forwarded onto main after it
 * landed, and main moved on. Its head is a main commit. */
async function landedThenOvertaken(): Promise<{ repo: string; headSha: string }> {
  const repo = await repoOnMain("yrd-contained-landed-")
  await writeFile(join(repo, "landed.txt"), "already on main\n")
  await git(repo, ["add", "landed.txt"])
  await git(repo, ["commit", "-qm", "the change lands on main"])
  const headSha = await git(repo, ["rev-parse", "HEAD"])
  await git(repo, ["branch", "-f", "issue/feature", headSha])
  await writeFile(join(repo, "after.txt"), "main moved on\n")
  await git(repo, ["add", "after.txt"])
  await git(repo, ["commit", "-qm", "main moves on"])
  return { repo, headSha }
}

/** The convergence-retry shape: the base contains the head because a MERGE
 * commit — the queue's own, in a prior run — brought it in. */
async function mergedByAPriorRun(): Promise<{ repo: string; headSha: string }> {
  const repo = await repoOnMain("yrd-contained-retried-")
  await git(repo, ["switch", "-qc", "issue/feature"])
  await writeFile(join(repo, "feature.txt"), "feature\n")
  await git(repo, ["add", "feature.txt"])
  await git(repo, ["commit", "-qm", "feature"])
  const headSha = await git(repo, ["rev-parse", "HEAD"])
  await git(repo, ["switch", "-q", "main"])
  await git(repo, ["merge", "--no-ff", "-q", "-m", "yrd: merge PR1 revision 1", headSha])
  return { repo, headSha }
}

/** The control: a branch carrying a commit the base does not have. */
async function carriesACommit(): Promise<{ repo: string; headSha: string }> {
  const repo = await repoOnMain("yrd-contained-real-")
  await git(repo, ["switch", "-qc", "issue/feature"])
  await writeFile(join(repo, "feature.txt"), "feature\n")
  await git(repo, ["add", "feature.txt"])
  await git(repo, ["commit", "-qm", "feature"])
  const headSha = await git(repo, ["rev-parse", "HEAD"])
  await git(repo, ["switch", "-q", "main"])
  return { repo, headSha }
}

const executionFor = (headSha: string) =>
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
        headSha,
      },
    ],
    shape: { results: {} },
  }) satisfies StepExecution<ChangeShape>

/** The recorded fact for the single member, read back off the candidate the
 * check step was pinned to. */
async function recordedContainment(repo: string, headSha: string): Promise<boolean | undefined> {
  await using process = createProcess()
  const outcome = await gitCheckStep({ inject: { process }, repo, command: ["true"], mode: "strict" })(
    executionFor(headSha),
    { id: "J-check", attempt: 1, runner: "test", signal: new AbortController().signal },
  )
  if (outcome.status !== "completed" || outcome.conclusion !== "success") {
    throw new Error(`check did not settle: ${JSON.stringify(outcome)}`)
  }
  const evidence = GitCheckEvidenceSchema.parse(outcome.output)
  return evidence.changes?.[0]?.containedInBase
}

describe("containment is recorded where it is measured, not re-derived from the collapsed candidate", () => {
  it("records containment for a candidate whose head the base already holds", async () => {
    const { repo, headSha } = await landedThenOvertaken()
    expect(await recordedContainment(repo, headSha)).toBe(true)
  })

  it("records the negative for a candidate that carries a commit", async () => {
    const { repo, headSha } = await carriesACommit()
    // The control. Without it, `true` above could be a constant rather than a
    // measurement — which is the exact failure mode this whole field exists to
    // end.
    expect(await recordedContainment(repo, headSha)).toBe(false)
  })

  it("reads the SAME for a convergence retry, so this fact alone does not separate the two", async () => {
    const landed = await landedThenOvertaken()
    const retried = await mergedByAPriorRun()

    const landedFact = await recordedContainment(landed.repo, landed.headSha)
    const retriedFact = await recordedContainment(retried.repo, retried.headSha)

    // Both are contained, and for opposite reasons: one because it landed and
    // was left behind, one because THIS queue merged it moments ago and still
    // owes the convergence work. The measurement is honest and it is the same
    // in both — recording it replaces three tautologies with one real check,
    // and it does NOT by itself decide retire-versus-proceed.
    //
    // Asserted rather than left implicit so nobody builds a disposition on this
    // field believing it discriminates. What separates them is whether a merge
    // this run's predecessor performed was ever recorded — and it is not,
    // because a merge that pushes the root and then fails submodule promotion
    // returns `submoduleMainFailureResult` and discards the proof.
    expect(landedFact).toBe(true)
    expect(retriedFact).toBe(true)
    expect(landedFact).toBe(retriedFact)
  })
})
