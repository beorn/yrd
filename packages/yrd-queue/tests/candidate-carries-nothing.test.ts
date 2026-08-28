/**
 * @failure Every member of a candidate is already contained in the base, so
 * nothing merges, the candidate sha IS the base sha, and the queue runs content
 * checks over `X..X` — a comparison of a commit against itself. Measured live
 * 2026-08-28: PR2145, PR2462, PR2503 and PR2504 were each handed
 * `fd5a0d02..fd5a0d02` in one compose pass, four unrelated changes with main's
 * own tip in both variables, and the pass merged nothing.
 * @level l2
 * @consumer @yrd/queue git check step
 */
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createProcess } from "@yrd/process"
import { gitCheckStep, type ChangeShape, type StepExecution } from "@yrd/queue"

const FIXTURE_CHANGE_ID = `I${"c0ffee12".repeat(5)}`

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

/**
 * A repository whose `issue/feature` branch was fast-forwarded onto `main`
 * after it landed — the `branch-moved` shape. Its recorded head is a main
 * commit, so the base already contains it and there is nothing to merge.
 */
async function landedCandidateRepository(): Promise<{ repo: string; headSha: string; baseSha: string }> {
  const root = await mkdtemp(join(tmpdir(), "yrd-carries-nothing-"))
  roots.push(root)
  const repo = join(root, "repo")
  await Bun.$`git init -q -b main ${repo}`
  await git(repo, ["config", "user.name", "Yrd Test"])
  await git(repo, ["config", "user.email", "yrd@example.invalid"])
  await writeFile(join(repo, "README.md"), "main\n")
  await git(repo, ["add", "README.md"])
  await git(repo, ["commit", "-qm", "main"])
  await writeFile(join(repo, "landed.txt"), "the branch's work, already on main\n")
  await git(repo, ["add", "landed.txt"])
  await git(repo, ["commit", "-qm", "the change lands on main"])
  const headSha = await git(repo, ["rev-parse", "HEAD"])
  await git(repo, ["branch", "-f", "issue/feature", headSha])
  await writeFile(join(repo, "after.txt"), "main moved on afterwards\n")
  await git(repo, ["add", "after.txt"])
  await git(repo, ["commit", "-qm", "main moves on"])
  const baseSha = await git(repo, ["rev-parse", "HEAD"])
  return { repo, headSha, baseSha }
}

/** The control: an ordinary branch carrying a commit the base does not have. */
async function realCandidateRepository(): Promise<{ repo: string; headSha: string; baseSha: string }> {
  const root = await mkdtemp(join(tmpdir(), "yrd-carries-something-"))
  roots.push(root)
  const repo = join(root, "repo")
  await Bun.$`git init -q -b main ${repo}`
  await git(repo, ["config", "user.name", "Yrd Test"])
  await git(repo, ["config", "user.email", "yrd@example.invalid"])
  await writeFile(join(repo, "README.md"), "main\n")
  await git(repo, ["add", "README.md"])
  await git(repo, ["commit", "-qm", "main"])
  const baseSha = await git(repo, ["rev-parse", "HEAD"])
  await git(repo, ["switch", "-qc", "issue/feature"])
  await writeFile(join(repo, "feature.txt"), "feature\n")
  await git(repo, ["add", "feature.txt"])
  await git(repo, ["commit", "-qm", "feature"])
  const headSha = await git(repo, ["rev-parse", "HEAD"])
  await git(repo, ["switch", "-q", "main"])
  return { repo, headSha, baseSha }
}

const checkInputFor = (headSha: string) =>
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

const jobContext = () => ({ id: "J-check", attempt: 1, runner: "test", signal: new AbortController().signal })

describe("a candidate that carries nothing is refused, never checked against itself", () => {
  it("refuses an all-contained candidate and never runs the check", async () => {
    const { repo, headSha, baseSha } = await landedCandidateRepository()
    const marker = join(repo, "the-check-ran.marker")
    await using process = createProcess()

    const outcome = await gitCheckStep({
      inject: { process },
      repo,
      // Records that it ran at all. A verdict computed from `X..X` must not exist.
      command: ["touch", marker],
    })(checkInputFor(headSha), jobContext())

    expect(outcome).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "candidate-carries-nothing" },
    })
    const message = (outcome as { error: { message: string } }).error.message
    // Names the sha and the cure, so the reader is not left with the queue's
    // old answer — a bare `substrate-pair-failed` naming the wrong culprit.
    expect(message).toContain(baseSha)
    expect(message).toContain("already contained in the base")
    expect(existsSync(marker), "the check must not run on an empty range").toBe(false)
  })

  it("still runs the same check for a candidate that carries a commit", async () => {
    const { repo, headSha } = await realCandidateRepository()
    const marker = join(repo, "the-check-ran.marker")
    await using process = createProcess()

    // The control: identical step, identical command, a real payload. Without
    // it the refusal above could be measuring the fixture rather than the
    // condition.
    const outcome = await gitCheckStep({
      inject: { process },
      repo,
      command: ["sh", "-c", `test "$YRD_BASE_SHA" != "$YRD_CANDIDATE_SHA" && touch ${marker}`],
      mode: "strict",
    })(checkInputFor(headSha), jobContext())

    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "completed", conclusion: "success" })
    expect(existsSync(marker), "the check must run, with a real pair").toBe(true)
  })
})
