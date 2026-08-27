/**
 * @failure The queue's landing push — the merge step's push of the integration
 * commit — runs from a linked scratch worktree that SHARES the source
 * repository's `.git`, so the AUTHOR's hooks (`.git/hooks`, `core.hooksPath`)
 * execute inside the queue's trusted context. Probe-verified 2026-08-27: a
 * failing source `pre-push` hook (exit 99) fails the integration as
 * `merge-push-failed` / kind `native-root-push-failure`, and the hook's code
 * runs with the queue's authority (arbitrary source-controlled code).
 *
 * The retired record-publication path deliberately isolated hooks — its test
 * "publishes from trusted staging without running source push hooks"
 * (612198a0) pinned exactly this, and 4a5419f8 quarantined the pre-submit
 * checkout the same way. That isolation is the spec; the S7 record-store
 * purge dropped it from the surviving derived lane (see the src-gap NOTE it
 * left in yrd-cli/tests/host.test.ts). The surviving idiom is git-super's
 * worktree quarantine: `-c core.hooksPath=/dev/null`, per invocation, so
 * every author-facing push keeps its hooks.
 * @level l2
 * @consumer @yrd/queue merge step (gitMergeStep) landing push and its
 * rollback compensation (rollbackQueueBase)
 */
import { existsSync } from "node:fs"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createProcess, type Process } from "@yrd/process"
import {
  GitCheckEvidenceSchema,
  gitCheckStep,
  gitMergeStep,
  type ChangeShape,
  type StepExecution,
} from "@yrd/queue"

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

/** Like `git` but for commands the test EXPECTS may refuse. */
async function gitAttempt(
  repo: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout, stderr }
}

type Fixture = Readonly<{
  repo: string
  remote: string
  featureSha: string
  /** Written by the source repository's pre-push hook the moment it EXECUTES —
   * distinct from the hook's exit code, so the tests can tell "the push was
   * refused" apart from "author-controlled code ran in the queue's context". */
  marker: string
}>

/**
 * `main` and a carrier branch on a bare origin, then a source `pre-push` hook
 * that records execution and refuses (exit 99) — the probe fixture. Installed
 * AFTER the setup pushes so fixture provisioning itself never trips it.
 */
async function hookedRepository(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "yrd-landing-hooks-"))
  roots.push(root)
  const repo = join(root, "repo")
  await Bun.$`git init -q -b main ${repo}`
  await git(repo, ["config", "user.name", "Yrd Test"])
  await git(repo, ["config", "user.email", "yrd@example.invalid"])
  await writeFile(join(repo, "README.md"), "main\n")
  await git(repo, ["add", "README.md"])
  await git(repo, ["commit", "-qm", "main"])

  await git(repo, ["switch", "-qc", "issue/feature"])
  await writeFile(join(repo, "feature.txt"), "feature\n")
  await git(repo, ["add", "feature.txt"])
  await git(repo, ["commit", "-qm", "feature"])
  const featureSha = await git(repo, ["rev-parse", "HEAD"])
  await git(repo, ["switch", "-q", "main"])

  const remote = join(root, "origin.git")
  await Bun.$`git init -q --bare ${remote}`
  await git(repo, ["remote", "add", "origin", remote])
  await git(repo, ["push", "-q", "origin", "main", "issue/feature"])

  const marker = join(root, "pre-push-hook-ran")
  await writeFile(
    join(repo, ".git", "hooks", "pre-push"),
    `#!/bin/sh\nprintf ran > '${marker}'\necho "source pre-push hook refused" >&2\nexit 99\n`,
  )
  await chmod(join(repo, ".git", "hooks", "pre-push"), 0o755)
  return { repo, remote, featureSha, marker }
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

describe("landing push hook isolation — trusted queue pushes quarantine source hooks", () => {
  it("lands the integration commit without executing the source repository's pre-push hook", async () => {
    const fixture = await hookedRepository()
    await using process = createProcess()
    const checked = await checkedCandidate(fixture.repo, process, fixture.featureSha)
    const candidateSha = GitCheckEvidenceSchema.parse(checked).candidateSha

    const outcome = await gitMergeStep({ inject: { process }, repo: fixture.repo })(
      mergeExecution(fixture.featureSha, checked) as never,
      jobContext(),
    )

    // Red before the fix: merge-push-failed / native-root-push-failure — the
    // author's hook both GATED the queue's own landing push and EXECUTED
    // inside its trusted context (marker present).
    expect(outcome, JSON.stringify(outcome, null, 2)).toMatchObject({ status: "completed", conclusion: "success" })
    expect(await git(fixture.remote, ["rev-parse", "main"])).toBe(candidateSha)
    expect(await git(fixture.remote, ["ls-tree", "-r", "--name-only", "main"])).toContain("feature.txt")
    // The arbitrary-code half of the defect, not just the exit code: the
    // hook's body never ran under the queue's authority.
    expect(existsSync(fixture.marker)).toBe(false)
  }, 30_000)

  it("keeps author-facing pushes in the same repository subject to its hooks", async () => {
    const fixture = await hookedRepository()
    await using process = createProcess()
    const checked = await checkedCandidate(fixture.repo, process, fixture.featureSha)

    // A quarantined landing push happens first, in this same repository…
    const outcome = await gitMergeStep({ inject: { process }, repo: fixture.repo })(
      mergeExecution(fixture.featureSha, checked) as never,
      jobContext(),
    )
    expect(outcome, JSON.stringify(outcome, null, 2)).toMatchObject({ status: "completed", conclusion: "success" })
    expect(existsSync(fixture.marker)).toBe(false)
    // …and it is per-invocation config: nothing was written into the shared
    // repository state that would ALSO quarantine the author.
    expect((await gitAttempt(fixture.repo, ["config", "--get", "core.hooksPath"])).code).not.toBe(0)

    // An ordinary author-side push from the source repository still runs the
    // repository's own pre-push hook — the isolation must not leak.
    await git(fixture.repo, ["switch", "-q", "issue/feature"])
    await writeFile(join(fixture.repo, "author.txt"), "author\n")
    await git(fixture.repo, ["add", "author.txt"])
    await git(fixture.repo, ["commit", "-qm", "author work"])
    const attempted = await gitAttempt(fixture.repo, ["push", "origin", "issue/feature"])

    expect(attempted.code).not.toBe(0)
    expect(attempted.stderr).toContain("source pre-push hook refused")
    expect(existsSync(fixture.marker)).toBe(true)
    expect(await git(fixture.remote, ["rev-parse", "refs/heads/issue/feature"])).toBe(fixture.featureSha)
  }, 30_000)
})
