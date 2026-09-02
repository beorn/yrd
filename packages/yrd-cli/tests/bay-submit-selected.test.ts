/**
 * @failure a change submitted from a Bay reaches CHECK REQUESTED and is never selected for a run.
 * @level l3
 * @consumer @yrd/cli change selection
 *
 * The defect this pins (@yrd/bay-submit-record/22958, observed 2026-08-18):
 * PR1303 was created by `yrd bay submit` from bay B91, carried CHECK REQUESTED
 * stamps through five revisions and two runners, and reported "No runs
 * recorded" the whole time while changes submitted after it merged past it
 * repeatedly. The consequence class is the expensive one — a submission that
 * can never run is byte-identical, on every surface an author reads, to one
 * that is merely waiting its turn.
 *
 * The in-memory `queue run` coverage in `cli.test.ts` drives a fixture Git, so
 * it cannot see a divergence between what the Bay writes and what the queue's
 * candidate pool reads. This exercises the real path end to end: a real
 * repository, a real Bay worktree, a real commit, `yrd bay submit`, and a real
 * one-shot queue run — and asserts the change is SELECTED, that the run names
 * it, and that base actually advanced to the submitted head.
 */
import { mkdtemp, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { safeRemove } from "removely"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runYrdProcess } from "../src/host.ts"
import type { YrdCliExitCode, YrdCliIO } from "../src/types.ts"
import { installDeclaredYrdEntry } from "./support/declared-yrd-entry.ts"

const roots: string[] = []
const BAY = "delivery"
const BRANCH = "task/delivery"

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => safeRemove(root, { within: tmpdir(), allowMissing: true })))
})

describe("a change submitted from a Bay", { timeout: 60_000 }, () => {
  it("is selected for a run and records one, and the run merges it", async () => {
    const { repo } = await repository()

    const opened = output(repo)
    expect(await yrd(repo, opened.io, "bay", "open", "--bay", BAY), opened.stderr()).toBe(0)
    const bayPath = opened.stdout().trim()
    expect(await git(bayPath, "branch", "--show-current")).toBe(BRANCH)

    // Real work in the real Bay worktree — this is the commit the queue has to
    // select, and the head every later assertion is anchored to.
    await writeFile(join(bayPath, "feature.txt"), "feature\n")
    await git(bayPath, "add", "feature.txt")
    await git(bayPath, "commit", "-qm", "feature")
    const featureSha = await git(bayPath, "rev-parse", "HEAD")

    // Standing IN the Bay, exactly as an author does. `--repo` is the fleet's
    // ordinary form and is the whole difference: it makes the process host
    // discover the repository, which used to erase the author's own directory
    // from `io.cwd` before the selector was inferred.
    const submitted = output(bayPath)
    expect(await yrd(repo, submitted.io, "bay", "submit", "--json"), submitted.stderr()).toBe(0)
    const submission = JSON.parse(submitted.stdout()) as {
      command: string
      prs: readonly { id: string; branch: string; status: string }[]
      derived?: readonly { branch: string; sha: string }[]
    }
    expect(submission.command).toBe("bay.submit")

    // The regression, stated as the thing that is easy to miss: the submit
    // reported exit 0 either way. What it submitted was the REPOSITORY's
    // current branch — `main`, the base — routed to the derived lane as a
    // degenerate fact the queue can never select, while the Bay's real commit
    // was never submitted at all.
    expect(submission.derived ?? [], "bay submit routed the Bay's work to the derived lane").toHaveLength(0)
    expect(submission.prs).toHaveLength(1)
    expect(submission.prs[0]).toMatchObject({ branch: BRANCH, status: "submitted" })
    const pr = submission.prs[0]?.id
    if (pr === undefined) throw new Error("bay submit recorded no change")

    // The stamp the 2026-08-18 evidence had — present, on the Bay's own head,
    // and by itself proving nothing about whether the queue can see it.
    const detail = output(repo)
    expect(await yrd(repo, detail.io, "pr", "list", "--json"), detail.stderr()).toBe(0)
    expect(JSON.parse(detail.stdout())).toMatchObject({
      prs: [{ id: pr, branch: BRANCH, checkRequests: [{ headSha: featureSha, revision: 1 }] }],
    })

    const baseBefore = await git(repo, "rev-parse", "origin/main")
    const run = output(repo)
    expect(await yrd(repo, run.io, "queue", "run", "--json"), run.stderr()).toBe(0)
    const result = JSON.parse(run.stdout()) as {
      command: string
      results: readonly {
        id: string
        status: string
        conclusion: string
        prs: readonly { id: string; branch: string; headSha: string }[]
      }[]
    }

    // The bead's exact symptom, asserted as its negation: "No runs recorded"
    // while a CHECK REQUESTED change stands is the failure, so an empty
    // `results` is the red this test exists to raise.
    expect(result.command).toBe("queue.run")
    expect(result.results, `no run recorded for submitted change ${pr}`).toHaveLength(1)
    expect(result.results[0]).toMatchObject({
      status: "completed",
      conclusion: "success",
      prs: [{ id: pr, branch: BRANCH, headSha: featureSha }],
    })

    // Selected AND consumed. A run that names the change but leaves the base
    // where it was would satisfy every assertion above and still be stuck, and
    // the base the queue lands on is the receiver's, never the local ref.
    const baseAfter = await git(repo, "rev-parse", "origin/main")
    expect(baseAfter).not.toBe(baseBefore)
    await git(repo, "merge-base", "--is-ancestor", featureSha, "origin/main")
  })
})

async function repository(): Promise<{ repo: string }> {
  const root = await mkdtemp(join(tmpdir(), "yrd-bay-submit-selected-"))
  roots.push(root)
  const repoPath = join(root, "repo")
  const origin = join(root, "origin.git")
  await git(root, "init", "-q", "--bare", origin)
  await git(root, "init", "-q", "-b", "main", repoPath)
  const repo = await realpath(repoPath)
  await git(repo, "config", "user.name", "Yrd Test")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await git(repo, "remote", "add", "origin", origin)
  await installDeclaredYrdEntry(repo)
  await writeFile(join(repo, "README.md"), "main\n")
  await writeFile(join(repo, ".yrd.yml"), 'base: main\nbatch: 1\nchecks: [{check: {run: "true"}}]\n')
  await git(repo, "add", "README.md", ".yrd.yml", "bin/yrd")
  await git(repo, "commit", "-qm", "main")
  await git(repo, "push", "-q", "-u", "origin", "main")
  return { repo }
}

function output(cwd: string): { io: YrdCliIO; stdout(): string; stderr(): string } {
  let stdout = ""
  let stderr = ""
  return {
    io: {
      cwd,
      color: false,
      stdout(text) {
        stdout += text
      },
      stderr(text) {
        stderr += text
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  }
}

function yrd(repo: string, io: YrdCliIO, ...args: string[]): Promise<YrdCliExitCode> {
  return runYrdProcess([process.execPath, "/usr/local/bin/yrd", "--repo", repo, ...args], io)
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}
