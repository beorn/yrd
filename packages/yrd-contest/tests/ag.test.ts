import { fileURLToPath } from "node:url"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import type { Bay } from "@yrd/bay"
import { createProcess, type Process, type ProcessRequest, type ProcessResult } from "@yrd/process"
import { createAgContestRunner } from "../src/ag.ts"
import type { ContestRunnerDef, ContestRunnerInput } from "../src/types.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const systemProcess = createProcess()
afterAll(() => systemProcess.close())
const job = (id = "E1", attempt = 1) => ({ id, attempt, executor: "test", signal: new AbortController().signal })
const argv = (value: string) => value.split(" ")

function passed(result: Awaited<ReturnType<ContestRunnerDef["run"]>>) {
  if (result.status !== "passed") throw new Error(`expected passed result, got ${result.status}`)
  return result.output
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await systemProcess.run({ argv: ["git", ...args], cwd, env: process.env })
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout)
  return result.stdout.trim()
}

async function repository(): Promise<{ root: string; repo: string; bay: Bay; baseSha: string }> {
  const root = await mkdtemp(join(tmpdir(), "yrd-contest-ag-"))
  roots.push(root)
  const repo = join(root, "repo")
  await mkdir(repo)
  await git(repo, "init", "-q", "-b", "main")
  await git(repo, "config", "user.name", "Yrd Contest Test")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await writeFile(join(repo, "README.md"), "base\n")
  await git(repo, "add", "README.md")
  await git(repo, "commit", "-qm", "base")
  const baseSha = await git(repo, "rev-parse", "HEAD")
  await git(repo, "switch", "-qc", "task/contest-c1-a1")
  return {
    root,
    repo,
    baseSha,
    bay: {
      id: "B1",
      name: "contest-c1-a1",
      branch: "task/contest-c1-a1",
      base: "main",
      status: "active",
      openedAt: "2026-07-09T12:00:00.000Z",
      refreshedAt: "2026-07-09T12:00:00.000Z",
      path: repo,
      headSha: baseSha,
      baseSha,
      dirty: false,
    },
  }
}

function contestInput(bay: Bay, config: ContestRunnerInput["competitor"]["config"]): ContestRunnerInput {
  return {
    contest: "C1",
    attempt: "A1",
    task: {
      ref: { source: "km", id: "@yrd/core/21012" },
      title: "Finish Yrd",
      description: "Implement the contest runner end to end.\nPreserve immutable evidence.",
      url: "https://tasks.example.invalid/21012",
      labels: ["#P0", "#feature"],
      revision: "r7",
    },
    competitor: { id: "cmp-1", model: "gpt-5.6-sol", harness: "ag", config },
    base: "main",
    bay,
  }
}

async function commitSolution(request: ProcessRequest): Promise<string> {
  if (request.cwd === undefined) throw new Error("agent request has no cwd")
  await writeFile(join(request.cwd, "solution.ts"), "export const solution = true\n")
  await git(request.cwd, "add", "solution.ts")
  await git(request.cwd, "commit", "-qm", "implement task")
  return await git(request.cwd, "rev-parse", "HEAD")
}

function result(
  exitCode: number,
  stdout = "",
  stderr = "",
  options: Readonly<{ durationMs?: number; timedOut?: boolean }> = {},
): ProcessResult {
  return {
    exitCode,
    signal: null,
    stdout,
    stderr,
    durationMs: options.durationMs ?? 0,
    timedOut: options.timedOut ?? false,
  }
}

function injected(run: Pick<Process, "run">["run"]): Readonly<{ process: Pick<Process, "run"> }> {
  return { process: { run } }
}

function artifactPath(uri: string): string {
  return fileURLToPath(uri)
}

describe("createAgContestRunner", () => {
  it("runs Ag in the exact Bay, passes the real task as one argv value, and pins the committed result", async () => {
    const { root, repo, bay, baseSha } = await repository()
    const agentRequests: ProcessRequest[] = []
    let committed = ""
    const process: Pick<Process, "run">["run"] = async (request) => {
      if (request.argv[0] === "git") return systemProcess.run(request)
      agentRequests.push(request)
      committed = await commitSolution(request)
      return result(
        0,
        "ag codex -> bench\n" +
          `${JSON.stringify({
            type: "turn.completed",
            usage: {
              input_tokens: 1_200,
              cached_input_tokens: 800,
              output_tokens: 450,
              reasoning_output_tokens: 125,
            },
          })}\n`,
        "provider diagnostic\n",
        { durationMs: 2_345 },
      )
    }
    const runner = createAgContestRunner({
      revision: "ag-runner-v1",
      command: ["bun", "/opt/ag/cli.ts"],
      inject: injected(process),
      artifactRoot: join(root, "artifacts"),
      environment: () => ({ GIT_DIR: "/tmp/forged", YRD_TASK_ID: "forged", SAFE_VALUE: "kept" }),
    })

    const output = passed(
      await runner.run(
        contestInput(bay, {
          provider: "codex",
          account: "bench",
          tier: "frontier",
          effort: "xhigh",
          args: ["--ephemeral"],
          instructions: "Preserve the public command contract.",
        }),
        job(),
      ),
    )

    expect(agentRequests).toHaveLength(1)
    expect(agentRequests[0]?.cwd).toBe(await realpath(repo))
    expect(agentRequests[0]?.argv.slice(0, -1)).toEqual(
      argv(
        "bun /opt/ag/cli.ts codex --no-tribe --account bench --tier frontier --model gpt-5.6-sol --model-reasoning-effort xhigh exec --json --ephemeral --",
      ),
    )
    const prompt = agentRequests[0]?.argv.at(-1) ?? ""
    expect(prompt).toContain("Task id: @yrd/core/21012")
    expect(prompt).toContain("Implement the contest runner end to end.\nPreserve immutable evidence.")
    expect(prompt).toContain("Additional instructions:\nPreserve the public command contract.")
    expect(prompt).toContain(`Base commit: ${baseSha}`)
    expect(agentRequests[0]?.env?.YRD_TASK_ID).toBe("@yrd/core/21012")
    expect(agentRequests[0]?.env?.GIT_DIR).toBeUndefined()
    expect(agentRequests[0]?.env?.SAFE_VALUE).toBe("kept")
    expect(output).toMatchObject({
      pin: {
        commit: committed,
        ref: "refs/yrd/attempts/C1/A1",
        branch: "task/contest-c1-a1",
        bay: "B1",
        baseSha,
      },
      wallTimeMs: 2_345,
      tokens: { input: 1_200, output: 450, cachedInput: 800, cacheWrite: null, reasoning: 125 },
      cost: { kind: "missing" },
    })
    expect(await git(repo, "rev-parse", "refs/yrd/attempts/C1/A1")).toBe(committed)
    expect(await git(repo, "status", "--porcelain")).toBe("")

    const kinds = output.artifacts.map((artifact) => artifact.kind)
    expect(kinds).toEqual(["stdout", "stderr", "transcript", "metrics", "git-commit"])
    const transcript = output.artifacts.find((artifact) => artifact.kind === "transcript")
    expect(await readFile(artifactPath(transcript!.uri), "utf8")).toContain('"type":"turn.completed"')
  })

  it("does not evaluate task text as shell source and records Claude-reported cost without estimating missing metrics", async () => {
    const { root, bay } = await repository()
    const marker = join(root, "must-not-exist")
    let launch: ProcessRequest | undefined
    const process: Pick<Process, "run">["run"] = async (request) => {
      if (request.argv[0] === "git") return systemProcess.run(request)
      launch = request
      await commitSolution(request)
      return result(
        0,
        `${JSON.stringify({
          type: "result",
          subtype: "success",
          usage: {
            input_tokens: 700,
            output_tokens: 200,
            cache_creation_input_tokens: 30,
            cache_read_input_tokens: 500,
          },
          total_cost_usd: 0.42,
        })}\n`,
      )
    }
    const runner = createAgContestRunner({
      revision: "ag-runner-v1",
      inject: injected(process),
      artifactRoot: join(root, "artifacts"),
    })
    const baseInput = contestInput(bay, { provider: "claude", account: "bench", effort: "max" })
    const input: ContestRunnerInput = {
      ...baseInput,
      task: { ...baseInput.task, description: `Do the work; $(touch ${marker}) is literal acceptance text.` },
    }

    const output = passed(await runner.run(input, job()))

    expect(launch?.argv.slice(0, -1)).toEqual(
      argv("ag claude --no-tribe --account bench --model gpt-5.6-sol --yolo --effort max -p --output-format json --"),
    )
    expect(launch?.argv.at(-1)).toContain(`$(touch ${marker})`)
    expect(await Bun.file(marker).exists()).toBe(false)
    expect(output.tokens).toEqual({
      input: 700,
      output: 200,
      cachedInput: 500,
      cacheWrite: 30,
      reasoning: null,
    })
    expect(output.cost).toEqual({ kind: "reported", usd: 0.42, source: "ag:claude:transcript" })
  })

  it("returns typed failures, preserves process artifacts, and refuses to pin a run without a new commit", async () => {
    const { root, repo, bay } = await repository()
    const failedRunner = createAgContestRunner({
      revision: "ag-runner-v1",
      artifactRoot: join(root, "failed-artifacts"),
      inject: injected((request) =>
        request.argv[0] === "git"
          ? systemProcess.run(request)
          : Promise.resolve(result(17, "partial transcript\n", "provider failed\n")),
      ),
    })

    const failed = await failedRunner.run(contestInput(bay, { provider: "codex" }), job())
    expect(failed).toMatchObject({ status: "failed", error: { code: "ag-process-failed" } })
    if (failed.status === "failed") {
      const manifestUri = failed.error.message.match(/file:\/\/\S+\/manifest\.json/u)?.[0]
      expect(manifestUri).toBeDefined()
      expect(await Bun.file(artifactPath(manifestUri!)).exists()).toBe(true)
    }
    const missingRef = await systemProcess.run({
      argv: ["git", "show-ref", "--verify", "--quiet", "refs/yrd/attempts/C1/A1"],
      cwd: repo,
      env: process.env,
    })
    expect(missingRef.exitCode).not.toBe(0)

    const noCommitRunner = createAgContestRunner({
      revision: "ag-runner-v1",
      artifactRoot: join(root, "no-commit-artifacts"),
      inject: injected((request) =>
        request.argv[0] === "git" ? systemProcess.run(request) : Promise.resolve(result(0, "{}\n")),
      ),
    })
    const noCommit = await noCommitRunner.run(contestInput(bay, { provider: "codex" }), job("E2", 2))
    expect(noCommit).toMatchObject({ status: "failed", error: { code: "no-commit" } })
  })

  it("keeps a pre-existing attempt ref immutable", async () => {
    const { root, repo, bay, baseSha } = await repository()
    await git(repo, "update-ref", "refs/yrd/attempts/C1/A1", baseSha)
    const runner = createAgContestRunner({
      revision: "ag-runner-v1",
      artifactRoot: join(root, "artifacts"),
      inject: injected(async (request) => {
        if (request.argv[0] === "git") return systemProcess.run(request)
        await commitSolution(request)
        return result(
          0,
          `${JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0, reasoning_output_tokens: 1 },
          })}\n`,
        )
      }),
    })

    const outcome = await runner.run(contestInput(bay, { provider: "codex" }), job())

    expect(outcome).toMatchObject({ status: "failed", error: { code: "attempt-ref-conflict" } })
    expect(await git(repo, "rev-parse", "refs/yrd/attempts/C1/A1")).toBe(baseSha)
  })

  it("refuses to launch without a clean pinned Bay base snapshot", async () => {
    const { root, bay } = await repository()
    let launches = 0
    const runner = createAgContestRunner({
      revision: "ag-runner-v1",
      artifactRoot: join(root, "artifacts"),
      inject: injected(async (request) => {
        if (request.argv[0] === "git") return systemProcess.run(request)
        launches++
        return result(0)
      }),
    })

    const missingBase = await runner.run(contestInput({ ...bay, baseSha: undefined }, { provider: "codex" }), job())
    expect(missingBase).toMatchObject({ status: "failed", error: { code: "bay-base-missing" } })

    const dirty = await runner.run(contestInput({ ...bay, dirty: true }, { provider: "codex" }), job("E2"))
    expect(dirty).toMatchObject({ status: "failed", error: { code: "bay-dirty" } })
    expect(launches).toBe(0)
  })

  it("bounds a local Ag process and aborts it without creating an attempt ref", async () => {
    const { root, repo, bay } = await repository()
    const runner = createAgContestRunner({
      revision: "ag-runner-v1",
      artifactRoot: join(root, "artifacts"),
      timeoutMs: 10,
      inject: injected((request) =>
        request.argv[0] === "git"
          ? systemProcess.run(request)
          : Promise.resolve(result(143, "", "terminated", { durationMs: 10, timedOut: true })),
      ),
    })

    const outcome = await runner.run(contestInput(bay, { provider: "codex" }), job("E-timeout"))

    expect(outcome).toMatchObject({ status: "failed", error: { code: "ag-timeout" } })
    const ref = await systemProcess.run({
      argv: ["git", "show-ref", "--verify", "--quiet", "refs/yrd/attempts/C1/A1"],
      cwd: repo,
      env: process.env,
    })
    expect(ref.exitCode).not.toBe(0)
  })
})
