/**
 * @failure The queue's merge worktree is prepared on the system temp dir, so an
 * unrelated process exhausting a tmpfs `/tmp` fails every merge on every queue
 * ("No space left on device"), and the ENOSPC surfaces as `merge-failed` —
 * indistinguishable from a content conflict the author is told to resolve.
 * Proven live 2026-08-14 on R2227/R2228/R2232/R2233.
 * @level l2
 * @consumer @yrd/queue git merge step
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createProcess, type Process, type ProcessRequest } from "@yrd/process"
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

/**
 * A repo on `main` with an `issue/feature` branch and a bare `origin`, which is
 * what drives the merge step down its remote-merge path — the one that
 * prepares a scratch worktree, and the path that died on 2026-08-14.
 */
async function remoteRepository(): Promise<{ repo: string; remote: string; featureSha: string }> {
  const root = await mkdtemp(join(tmpdir(), "yrd-merge-scratch-"))
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
  return { repo, remote, featureSha }
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

/** Run the check step so the merge step receives a real checked candidate. */
async function checkedCandidate(repo: string, process: Pick<Process, "run">, featureSha: string) {
  const checked = await gitCheckStep({ inject: { process }, repo, command: ["test", "-f", "feature.txt"] })(
    checkInputFor(featureSha),
    { id: "J-check", attempt: 1, runner: "test", signal: new AbortController().signal },
  )
  if (checked.status !== "completed" || checked.conclusion !== "success") {
    throw new Error(`check did not pass: ${JSON.stringify(checked)}`)
  }
  return checked.output
}

const mergeExecution = (featureSha: string, checked: unknown) => ({
  ...checkInputFor(featureSha),
  step: "merge",
  index: 1,
  shape: { results: { check: checked } },
})

const isWorktreeAdd = (argv: readonly string[]): boolean => {
  const at = argv.indexOf("worktree")
  return at !== -1 && argv[at + 1] === "add"
}

/** `git … worktree add --detach <path> <ref>` — the target is the second-to-last argument. */
const worktreeAddPath = (argv: readonly string[]): string => {
  const path = argv[argv.length - 2]
  if (path === undefined) throw new Error(`unexpected worktree-add argv: ${argv.join(" ")}`)
  return path
}

describe("merge scratch lives on the repository filesystem, not the temp dir", () => {
  it("prepares every merge worktree under the repo's own .git/yrd/scratch", async () => {
    const { repo, remote, featureSha } = await remoteRepository()
    await using real = createProcess()
    const seen: string[][] = []
    const recording: Pick<Process, "run"> = {
      run(request: ProcessRequest) {
        seen.push([...request.argv])
        return real.run(request)
      },
    }
    const checked = await checkedCandidate(repo, recording, featureSha)

    const outcome = await gitMergeStep({ inject: { process: recording }, repo })(
      mergeExecution(featureSha, checked) as never,
      jobContext(),
    )

    expect(outcome).toMatchObject({ status: "completed", conclusion: "success" })
    // The queue composes its own merge commit, so assert the PAYLOAD merged
    // rather than pinning the candidate sha.
    expect(await git(remote, ["show", "main:feature.txt"])).toBe("feature")

    const added = seen.filter(isWorktreeAdd).map(worktreeAddPath)
    expect(added.length).toBeGreaterThan(0)
    for (const path of added) {
      // The invariant: scratch follows the REPOSITORY. On a host whose /tmp is
      // a tmpfs, that is the whole difference between a merge and an outage.
      expect(path.startsWith(join(repo, ".git", "yrd", "scratch"))).toBe(true)
      // The pre-fix shape was `mkdtemp(join(tmpdir(), "yrd-queue-"))`, i.e. a
      // scratch directory sitting directly in the system temp root.
      expect(path.startsWith(join(tmpdir(), "yrd-queue-"))).toBe(false)
    }
  })

  it("reports a worktree-preparation ENOSPC as its own typed failure, not merge-failed", async () => {
    const { repo, featureSha } = await remoteRepository()
    await using real = createProcess()
    // Inject the exact failure git produced during the outage: the worktree add
    // reports ENOSPC while every other git call behaves normally.
    const exhausting: Pick<Process, "run"> = {
      async run(request: ProcessRequest) {
        if (request.argv[0] === "git" && isWorktreeAdd(request.argv)) {
          return {
            exitCode: 128,
            signal: null,
            stdout: "",
            stderr: [
              "Preparing worktree (detached HEAD 8f2fc41c6a)",
              "error: unable to create file hub/silvery/research/cmux.md: No space left on device",
              "fatal: could not detach HEAD",
            ].join("\n"),
            durationMs: 1,
            timedOut: false,
          }
        }
        return real.run(request)
      },
    }
    const checked = await checkedCandidate(repo, real, featureSha)

    const outcome = await gitMergeStep({ inject: { process: exhausting }, repo })(
      mergeExecution(featureSha, checked) as never,
      jobContext(),
    )

    expect(outcome).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "worktree-storage-exhausted" },
    })
    if (outcome.status !== "completed" || outcome.conclusion !== "failure") throw new Error("unreachable")
    // Naming the filesystem's inode AND byte state is the point: the outage had
    // bytes at 51% while inodes sat at 100%, so a byte-only report misleads.
    expect(outcome.error.message).toContain("inodes")
    expect(outcome.error.message).toContain("bytes")
    expect(outcome.error.message).toContain("No space left on device")
    expect(outcome.error.code).not.toBe("merge-failed")
  })
})

describe("every scratch consumer classifies ENOSPC, not just the merge step", () => {
  /** Fail `worktree add` with the outage's own stderr; every other git call is real. */
  const exhaustingWorktreeAdd = (real: Pick<Process, "run">): Pick<Process, "run"> => ({
    async run(request: ProcessRequest) {
      if (request.argv[0] === "git" && isWorktreeAdd(request.argv)) {
        return {
          exitCode: 128,
          signal: null,
          stdout: "",
          stderr: [
            "Preparing worktree (detached HEAD 8f2fc41c6a)",
            "error: unable to create file hub/silvery/research/cmux.md: No space left on device",
            "fatal: could not detach HEAD",
          ].join("\n"),
          durationMs: 1,
          timedOut: false,
        }
      }
      return real.run(request)
    },
  })

  it("reports a check-step scratch ENOSPC as worktree-storage-exhausted, not check-failed", async () => {
    const { repo, featureSha } = await remoteRepository()
    await using real = createProcess()

    // The check step prepares its candidate worktree on the same filesystem the
    // merge step does, and died on the same 2026-08-14 ENOSPC — but it never
    // asked the classifier, so the queue told the author their change failed
    // its checks. Classification now lives at the scratch primitive, so the
    // consumer cannot forget to ask.
    const outcome = await gitCheckStep({
      inject: { process: exhaustingWorktreeAdd(real) },
      repo,
      command: ["test", "-f", "feature.txt"],
    })(checkInputFor(featureSha), { id: "J-check", attempt: 1, runner: "test", signal: new AbortController().signal })

    expect(outcome).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "worktree-storage-exhausted" },
    })
    if (outcome.status !== "completed" || outcome.conclusion !== "failure") throw new Error("unreachable")
    expect(outcome.error.code).not.toBe("check-failed")
    expect(outcome.error.message).toContain("inodes")
    expect(outcome.error.message).toContain("No space left on device")
  })
})
