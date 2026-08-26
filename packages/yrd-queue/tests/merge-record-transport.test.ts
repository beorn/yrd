/**
 * @failure A stalled or refused remote read while synchronizing the merge-record
 * ref (`ls-remote`, then the record-ref fetch) throws a PLAIN Error: unlike the
 * identical stall at live-base inspection (`queue-environment-refused`), nothing
 * downstream can classify it as retryable infrastructure, so a transient
 * transport fault presents as a terminal, unclassifiable failure.
 * @level l2
 * @consumer @yrd/cli habitant runner, queueAuthorityReleaseReason, failureDisposition
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { failureFact } from "@yrd/core"
import { createProcess, type Process, type ProcessRequest, type ProcessResult } from "@yrd/process"
import { canonicalRefusalCode, gitMergeRecorder, MERGE_RECORD_REF, type Candidate, type Run } from "@yrd/queue"

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

/** A real repository with a configured `origin`, so `config --get
 * remote.origin.url` answers and the recorder proceeds to the remote reads the
 * test intercepts. The URL is never contacted. */
async function repository(): Promise<Readonly<{ repo: string; baseSha: string }>> {
  const root = await mkdtemp(join(tmpdir(), "yrd-merge-record-transport-"))
  roots.push(root)
  const repo = join(root, "repo")
  await Bun.$`git init -q -b main ${repo}`.quiet()
  await git(repo, ["config", "user.name", "Yrd Test"])
  await git(repo, ["config", "user.email", "yrd@example.invalid"])
  await writeFile(join(repo, "README.md"), "initial\n")
  await git(repo, ["add", "README.md"])
  await git(repo, ["commit", "-qm", "initial"])
  await git(repo, ["remote", "add", "origin", "https://origin.invalid/repo.git"])
  return { repo, baseSha: await git(repo, ["rev-parse", "HEAD"]) }
}

/** The smallest terminal FAILED merge run the recorder accepts: candidate-less
 * result, so no payload walk happens and the first remote read is the
 * merge-record ref synchronization under test. */
function failedMergeRun(baseSha: string): Readonly<{ run: Run; candidate: Candidate }> {
  const run = {
    id: "R1",
    queueId: "merge-queue:main",
    candidateId: "C1",
    prs: [{ id: "PR1", branch: "topic/transport", base: "main", revision: 1, headSha: "2".repeat(40) }],
    base: "main",
    steps: [{ name: "merge", title: "Merge", revision: "git-merge-v1", kind: "merge" as const }],
    startedAt: "2026-01-01T00:00:00.000Z",
    cursor: 1,
    status: "completed" as const,
    conclusion: "failure" as const,
    jobs: [],
    shape: { results: {} },
    finishedAt: "2026-01-01T00:01:00.000Z",
    error: { code: "merge-conflict", message: "candidate did not apply" },
  } as unknown as Run
  const candidate: Candidate = {
    id: "C1",
    queueId: "merge-queue:main",
    baseSha,
    revs: [{ pr: "PR1", n: 1, head: "2".repeat(40) }],
    mergeability: "conflicting",
    createdAt: "2026-01-01T00:00:00.000Z",
  }
  return { run, candidate }
}

type Interception = (request: ProcessRequest) => ProcessResult | undefined

function intercepting(delegate: Pick<Process, "run">, interception: Interception): Pick<Process, "run"> {
  return {
    run(request: ProcessRequest) {
      const intercepted = interception(request)
      return intercepted === undefined ? delegate.run(request) : Promise.resolve(intercepted)
    },
  }
}

function stalled(request: ProcessRequest): ProcessResult {
  return {
    exitCode: 143,
    signal: "SIGTERM",
    stdout: "",
    stderr: "",
    durationMs: request.timeoutMs ?? 0,
    timedOut: true,
  }
}

function refused(stderr: string): ProcessResult {
  return { exitCode: 128, signal: null, stdout: "", stderr, durationMs: 1, timedOut: false }
}

function advertisement(tip: string): ProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: `${tip}\t${MERGE_RECORD_REF}\n`,
    stderr: "",
    durationMs: 1,
    timedOut: false,
  }
}

describe("merge-record ref synchronization under transport failure", () => {
  it("classifies a stalled ls-remote as retryable infrastructure, not a plain terminal error", async () => {
    const { repo, baseSha } = await repository()
    await using delegate = createProcess()
    const process = intercepting(delegate, (request) =>
      request.argv.includes("ls-remote") ? stalled(request) : undefined,
    )
    const record = gitMergeRecorder({ inject: { process }, repo })

    const rejection = await record(failedMergeRun(baseSha)).then(
      () => undefined,
      (cause: unknown) => cause,
    )

    expect(rejection, "the merge recorder must refuse when the record ref cannot be read").toBeInstanceOf(Error)
    const fact = failureFact(rejection)
    expect(fact, "a transport stall must be a typed YrdFailure, not a plain Error").toBeDefined()
    expect(fact).toMatchObject({ kind: "infrastructure", code: "transport-read-failed" })
  })

  it("classifies a refused record-ref fetch the same way as the ls-remote stall", async () => {
    const { repo, baseSha } = await repository()
    const remoteTip = "f".repeat(40)
    await using delegate = createProcess()
    const process = intercepting(delegate, (request) => {
      if (request.argv.includes("ls-remote")) return advertisement(remoteTip)
      if (request.argv.includes("fetch")) {
        return refused("fatal: unable to access 'https://origin.invalid/repo.git': Connection timed out")
      }
      return undefined
    })
    const record = gitMergeRecorder({ inject: { process }, repo })

    const rejection = await record(failedMergeRun(baseSha)).then(
      () => undefined,
      (cause: unknown) => cause,
    )

    expect(rejection).toBeInstanceOf(Error)
    const fact = failureFact(rejection)
    expect(fact, "a refused record-ref fetch must be a typed YrdFailure, not a plain Error").toBeDefined()
    expect(fact).toMatchObject({ kind: "infrastructure", code: "transport-read-failed" })
  })

  it("registers the canonical code in the closed refusal vocabulary", () => {
    expect(canonicalRefusalCode("transport-read-failed")).toBe("transport-read-failed")
  })

  it("collapses the pre-existing change-state spelling onto the canonical code", () => {
    expect(canonicalRefusalCode("change-state-remote-unreadable")).toBe("transport-read-failed")
  })
})
