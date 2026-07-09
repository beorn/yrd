import { fileURLToPath } from "node:url"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Bay } from "@yrd/bay"
import { createAgContestRunner, type AgProcessRequest, type AgProcessResult, type AgProcessRunner } from "../src/ag.ts"
import type { ContestRunnerInput } from "../src/types.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const runProcess: AgProcessRunner = async (request): Promise<AgProcessResult> => {
  const child = Bun.spawn([...request.argv], {
    cwd: request.cwd,
    env: request.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, stdout, stderr }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runProcess({ kind: "git", argv: ["git", ...args], cwd, env: process.env })
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

async function commitSolution(request: AgProcessRequest): Promise<string> {
  await writeFile(join(request.cwd, "solution.ts"), "export const solution = true\n")
  await git(request.cwd, "add", "solution.ts")
  await git(request.cwd, "commit", "-qm", "implement task")
  return await git(request.cwd, "rev-parse", "HEAD")
}

function artifactPath(uri: string): string {
  expect(uri.startsWith("file://")).toBe(true)
  return fileURLToPath(uri)
}

describe("createAgContestRunner", () => {
  it("runs Ag in the exact Bay, passes the real task as one argv value, and pins the committed result", async () => {
    const { root, repo, bay, baseSha } = await repository()
    const agentRequests: AgProcessRequest[] = []
    let committed = ""
    const process: AgProcessRunner = async (request) => {
      if (request.kind === "git") return await runProcess(request)
      agentRequests.push(request)
      committed = await commitSolution(request)
      return {
        exitCode: 0,
        stdout:
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
        stderr: "provider diagnostic\n",
      }
    }
    const times = [1_000, 3_345]
    const runner = createAgContestRunner({
      command: ["bun", "/opt/ag/cli.ts"],
      process,
      now: () => times.shift() ?? 3_345,
      artifactRoot: join(root, "artifacts"),
    })

    const outcome = await runner.run(
      contestInput(bay, {
        provider: "codex",
        account: "bench",
        tier: "frontier",
        effort: "xhigh",
        args: ["--ephemeral"],
      }),
      { id: "E1", attempt: 1, executor: "test" },
    )

    if (outcome.status === "failed") throw new Error(`${outcome.error.code}: ${outcome.error.message}`)
    expect(outcome.status).toBe("passed")
    if (outcome.status !== "passed") return
    expect(agentRequests).toHaveLength(1)
    expect(agentRequests[0]?.cwd).toBe(await realpath(repo))
    expect(agentRequests[0]?.argv.slice(0, -1)).toEqual([
      "bun",
      "/opt/ag/cli.ts",
      "codex",
      "--no-tribe",
      "--account",
      "bench",
      "--tier",
      "frontier",
      "--model",
      "gpt-5.6-sol",
      "--model-reasoning-effort",
      "xhigh",
      "exec",
      "--json",
      "--ephemeral",
      "--",
    ])
    const prompt = agentRequests[0]?.argv.at(-1) ?? ""
    expect(prompt).toContain("Task source: km")
    expect(prompt).toContain("Task id: @yrd/core/21012")
    expect(prompt).toContain("Finish Yrd")
    expect(prompt).toContain("Implement the contest runner end to end.\nPreserve immutable evidence.")
    expect(prompt).toContain("commit all intended changes")
    expect(prompt).toContain(`Base commit: ${baseSha}`)
    expect(agentRequests[0]?.env.YRD_TASK_ID).toBe("@yrd/core/21012")
    expect(outcome.output).toMatchObject({
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

    const kinds = outcome.output.artifacts.map((artifact) => artifact.kind)
    expect(kinds).toEqual(["stdout", "stderr", "transcript", "metrics", "git-commit"])
    const transcript = outcome.output.artifacts.find((artifact) => artifact.kind === "transcript")
    expect(await readFile(artifactPath(transcript!.uri), "utf8")).toContain('"type":"turn.completed"')
    const metrics = outcome.output.artifacts.find((artifact) => artifact.kind === "metrics")
    const metricEvidence = JSON.parse(await readFile(artifactPath(metrics!.uri), "utf8")) as {
      tokens: { cacheWrite: { kind: string; reason?: string } }
      cost: { kind: string }
    }
    expect(metricEvidence.tokens.cacheWrite).toMatchObject({ kind: "missing" })
    expect(metricEvidence.cost).toMatchObject({ kind: "missing" })
  })

  it("does not evaluate task text as shell source and records Claude-reported cost without estimating missing metrics", async () => {
    const { root, bay } = await repository()
    const marker = join(root, "must-not-exist")
    let launch: AgProcessRequest | undefined
    const process: AgProcessRunner = async (request) => {
      if (request.kind === "git") return await runProcess(request)
      launch = request
      await commitSolution(request)
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({
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
        stderr: "",
      }
    }
    const runner = createAgContestRunner({ process, artifactRoot: join(root, "artifacts") })
    const baseInput = contestInput(bay, { provider: "claude", account: "bench", effort: "max" })
    const input: ContestRunnerInput = {
      ...baseInput,
      task: { ...baseInput.task, description: `Do the work; $(touch ${marker}) is literal acceptance text.` },
    }

    const outcome = await runner.run(input, { id: "E1", attempt: 1, executor: "test" })

    if (outcome.status === "failed") throw new Error(`${outcome.error.code}: ${outcome.error.message}`)
    expect(outcome.status).toBe("passed")
    if (outcome.status !== "passed") return
    expect(launch?.argv.slice(0, -1)).toEqual([
      "ag",
      "claude",
      "--no-tribe",
      "--account",
      "bench",
      "--model",
      "gpt-5.6-sol",
      "--yolo",
      "--effort",
      "max",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--",
    ])
    expect(launch?.argv.at(-1)).toContain(`$(touch ${marker})`)
    expect(await Bun.file(marker).exists()).toBe(false)
    expect(outcome.output.tokens).toEqual({
      input: 700,
      output: 200,
      cachedInput: 500,
      cacheWrite: 30,
      reasoning: null,
    })
    expect(outcome.output.cost).toEqual({ kind: "reported", usd: 0.42, source: "ag:claude:transcript" })
    const metrics = outcome.output.artifacts.find((artifact) => artifact.kind === "metrics")
    const evidence = JSON.parse(await readFile(artifactPath(metrics!.uri), "utf8")) as {
      tokens: { reasoning: { kind: string } }
    }
    expect(evidence.tokens.reasoning).toEqual({
      kind: "missing",
      reason: "Ag/provider transcript did not expose reasoning tokens",
    })
  })

  it("returns typed failures, preserves process artifacts, and refuses to pin a run without a new commit", async () => {
    const { root, repo, bay } = await repository()
    const failedRunner = createAgContestRunner({
      artifactRoot: join(root, "failed-artifacts"),
      process: async (request) =>
        request.kind === "git"
          ? await runProcess(request)
          : { exitCode: 17, stdout: "partial transcript\n", stderr: "provider failed\n" },
    })

    const failed = await failedRunner.run(contestInput(bay, { provider: "codex" }), {
      id: "E1",
      attempt: 1,
      executor: "test",
    })
    expect(failed).toMatchObject({ status: "failed", error: { code: "ag-process-failed" } })
    if (failed.status === "failed") {
      const manifestUri = failed.error.message.match(/file:\/\/\S+\/manifest\.json/u)?.[0]
      expect(manifestUri).toBeDefined()
      expect(await Bun.file(artifactPath(manifestUri!)).exists()).toBe(true)
    }
    const missingRef = await runProcess({
      kind: "git",
      argv: ["git", "show-ref", "--verify", "--quiet", "refs/yrd/attempts/C1/A1"],
      cwd: repo,
      env: process.env,
    })
    expect(missingRef.exitCode).not.toBe(0)

    const noCommitRunner = createAgContestRunner({
      artifactRoot: join(root, "no-commit-artifacts"),
      process: async (request) =>
        request.kind === "git" ? await runProcess(request) : { exitCode: 0, stdout: "{}\n", stderr: "" },
    })
    const noCommit = await noCommitRunner.run(contestInput(bay, { provider: "codex" }), {
      id: "E2",
      attempt: 2,
      executor: "test",
    })
    expect(noCommit).toMatchObject({ status: "failed", error: { code: "no-commit" } })
  })

  it("keeps a pre-existing attempt ref immutable", async () => {
    const { root, repo, bay, baseSha } = await repository()
    await git(repo, "update-ref", "refs/yrd/attempts/C1/A1", baseSha)
    const runner = createAgContestRunner({
      artifactRoot: join(root, "artifacts"),
      process: async (request) => {
        if (request.kind === "git") return await runProcess(request)
        await commitSolution(request)
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0, reasoning_output_tokens: 1 },
          })}\n`,
          stderr: "",
        }
      },
    })

    const outcome = await runner.run(contestInput(bay, { provider: "codex" }), {
      id: "E1",
      attempt: 1,
      executor: "test",
    })

    expect(outcome).toMatchObject({ status: "failed", error: { code: "attempt-ref-conflict" } })
    expect(await git(repo, "rev-parse", "refs/yrd/attempts/C1/A1")).toBe(baseSha)
  })

  it("refuses to launch without a clean pinned Bay base snapshot", async () => {
    const { root, bay } = await repository()
    let launches = 0
    const runner = createAgContestRunner({
      artifactRoot: join(root, "artifacts"),
      process: async (request) => {
        if (request.kind === "git") return await runProcess(request)
        launches++
        return { exitCode: 0, stdout: "", stderr: "" }
      },
    })

    const missingBase = await runner.run(contestInput({ ...bay, baseSha: undefined }, { provider: "codex" }), {
      id: "E1",
      attempt: 1,
      executor: "test",
    })
    expect(missingBase).toMatchObject({ status: "failed", error: { code: "bay-base-missing" } })

    const dirty = await runner.run(contestInput({ ...bay, dirty: true }, { provider: "codex" }), {
      id: "E2",
      attempt: 1,
      executor: "test",
    })
    expect(dirty).toMatchObject({ status: "failed", error: { code: "bay-dirty" } })
    expect(launches).toBe(0)
  })

  it("bounds a local Ag process and aborts it without creating an attempt ref", async () => {
    const { root, repo, bay } = await repository()
    const runner = createAgContestRunner({
      artifactRoot: join(root, "artifacts"),
      timeoutMs: 10,
      process: async (request) => {
        if (request.kind === "git") return await runProcess(request)
        await new Promise<void>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
        })
        return { exitCode: 0, stdout: "", stderr: "" }
      },
    })

    const outcome = await runner.run(contestInput(bay, { provider: "codex" }), {
      id: "E-timeout",
      attempt: 1,
      executor: "test",
    })

    expect(outcome).toMatchObject({ status: "failed", error: { code: "agent-timeout" } })
    const ref = await runProcess({
      kind: "git",
      argv: ["git", "show-ref", "--verify", "--quiet", "refs/yrd/attempts/C1/A1"],
      cwd: repo,
      env: process.env,
    })
    expect(ref.exitCode).not.toBe(0)
  })
})
