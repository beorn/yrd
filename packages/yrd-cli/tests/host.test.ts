/**
 * @failure The default host composes incompatible definitions, state paths, receivers, or lifecycle ownership.
 * @level l3
 * @consumer @yrd/cli host
 */
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createFailure, createMemoryJournal } from "@yrd/core"
import { GitCheckEvidenceSchema } from "@yrd/line"
import { createExclusive } from "@yrd/persistence"
import { createProcess } from "@yrd/process"
import { createDefaultYrdApp, createYrdHost, runYrdProcess } from "../src/host.ts"
import type { ResolvedYrdProjectConfig } from "../src/config.ts"
import { classifyFailure } from "../src/invocation.ts"
import { discoverYrdRepository } from "../src/repository.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(repo: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

async function repository(): Promise<{ repo: string; featureSha: string }> {
  const root = await mkdtemp(join(tmpdir(), "yrd-host-"))
  roots.push(root)
  const repoPath = join(root, "repo")
  await git(root, "init", "-q", "-b", "main", repoPath)
  const repo = await realpath(repoPath)
  await git(repo, "config", "user.name", "Yrd Test")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await writeFile(join(repo, "README.md"), "main\n")
  await git(repo, "add", "README.md")
  await git(repo, "commit", "-qm", "main")
  await git(repo, "switch", "-qc", "task/feature")
  await writeFile(join(repo, "feature.txt"), "feature\n")
  await git(repo, "add", "feature.txt")
  await git(repo, "commit", "-qm", "feature")
  const featureSha = await git(repo, "rev-parse", "HEAD")
  await git(repo, "switch", "-q", "main")
  return { repo, featureSha }
}

describe("createDefaultYrdApp", { timeout: 20_000 }, () => {
  it("composes the final plugin stack and integrates through configured typed steps", async () => {
    const { repo, featureSha } = await repository()
    const config: ResolvedYrdProjectConfig = {
      line: { base: "main", batch: 1, steps: ["security", "merge", "publish"] },
      steps: {
        security: { run: "test -f feature.txt", runner: "local" },
        merge: { runner: "local" },
        publish: { run: "test -f feature.txt", runner: "local" },
      },
      contest: { concurrency: 2, timeoutMs: 60_000, evaluators: ["security"] },
    }
    await using runtimeProcess = createProcess({ cwd: repo })
    const app = await createDefaultYrdApp({
      repo,
      stateDir: join(repo, ".git", "yrd"),
      baysRoot: join(repo, ".bays"),
      journal: createMemoryJournal(),
      process: runtimeProcess,
      config,
    })

    expect(app.state().lines).toMatchObject({
      batchSize: 1,
      defaultSteps: ["security", "merge", "publish"],
    })
    expect(Object.keys(app.commands.bay)).toEqual(["open", "refresh", "intake", "submit", "close"])
    expect(Object.keys(app.commands.pr)).toEqual(["close"])
    expect(app.commands.bay.intake.metadata?.visibility).toBe("internal")
    expect(app.commands.bay.open.metadata?.visibility).toBe("public")
    expect(app.commands.pr.close.metadata?.visibility).toBe("public")
    expect(app.commands.line.integrate.metadata?.visibility).toBe("public")

    await app.bays.submit({ branch: "task/feature", headSha: featureSha, base: "main" })
    const run = (await app.line.integrate({ prs: ["PR1"] }, { executor: "test", leaseMs: 60_000 }))[0]!
    expect(run.status).toBe("passed")
    expect(run.steps.map((step) => step.name)).toEqual(["security", "merge", "publish"])
    expect(await git(repo, "merge-base", "--is-ancestor", featureSha, "main")).toBe("")
    const evaluatorRevision = app.jobs.definition("contest.evaluator.security").revision
    await app.close()

    const changedTimeout = await createDefaultYrdApp({
      repo,
      stateDir: join(repo, ".git", "yrd"),
      baysRoot: join(repo, ".bays"),
      journal: createMemoryJournal(),
      process: runtimeProcess,
      config: { ...config, contest: { ...config.contest, timeoutMs: 120_000 } },
    })
    expect(changedTimeout.jobs.definition("contest.evaluator.security").revision).not.toBe(evaluatorRevision)
    await changedTimeout.close()
  })

  it("normalizes remote aliases of the configured line and refuses duplicate payload admission", async () => {
    const { repo, featureSha } = await repository()
    const baseSha = await git(repo, "rev-parse", "main")
    await git(repo, "update-ref", "refs/remotes/origin/main", baseSha)
    const config: ResolvedYrdProjectConfig = {
      line: { base: "main", batch: 1, steps: ["check", "merge"] },
      steps: { check: { run: "true", runner: "local" }, merge: { runner: "local" } },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["check"] },
    }
    await using runtimeProcess = createProcess({ cwd: repo })
    await using app = await createDefaultYrdApp({
      repo,
      stateDir: join(repo, ".git", "yrd"),
      baysRoot: join(repo, ".bays"),
      journal: createMemoryJournal(),
      process: runtimeProcess,
      config,
    })

    await app.bays.submit({ branch: "task/feature", headSha: featureSha, base: "origin/main" })

    expect(app.state().bays.prs.PR1).toMatchObject({ base: "main", baseSha })
    await expect(app.bays.submit({ branch: "origin/task/feature", headSha: featureSha, base: "main" })).rejects.toThrow(
      "payload already recorded as PR 'PR1'",
    )
    expect(Object.keys(app.state().bays.prs)).toEqual(["PR1"])
  })

  it("refuses stale local line authority before recording a PR", async () => {
    const { repo, featureSha } = await repository()
    const remote = join(repo, "..", "origin.git")
    await git(repo, "init", "-q", "--bare", remote)
    await git(repo, "remote", "add", "origin", remote)
    await git(repo, "push", "-q", "origin", "main", "task/feature")
    await git(repo, "switch", "-qc", "task/remote-main")
    await writeFile(join(repo, "remote.txt"), "remote\n")
    await git(repo, "add", "remote.txt")
    await git(repo, "commit", "-qm", "remote main")
    await git(repo, "push", "-q", "origin", "HEAD:main")
    await git(repo, "switch", "-q", "main")

    const config: ResolvedYrdProjectConfig = {
      line: { base: "main", batch: 1, steps: ["check", "merge"] },
      steps: { check: { run: "true", runner: "local" }, merge: { runner: "local" } },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["check"] },
    }
    await using runtimeProcess = createProcess({ cwd: repo })
    await using app = await createDefaultYrdApp({
      repo,
      stateDir: join(repo, ".git", "yrd"),
      baysRoot: join(repo, ".bays"),
      journal: createMemoryJournal(),
      process: runtimeProcess,
      config,
    })

    await expect(
      app.bays.submitSelection("task/feature", {
        resolveRevision: async () => featureSha,
        run: { executor: "test", leaseMs: 60_000 },
      }),
    ).rejects.toThrow("differs from authoritative")
    expect(app.state().bays.prs).toEqual({})
  })

  it("refreshes a shared journal before the host selects queued PRs", async () => {
    const { repo, featureSha } = await repository()
    const config: ResolvedYrdProjectConfig = {
      line: { base: "main", batch: 1, steps: ["check", "merge"] },
      steps: {
        check: { run: "test -f feature.txt", runner: "local" },
        merge: { runner: "local" },
      },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["check"] },
    }
    const journal = createMemoryJournal()
    await using runtimeProcess = createProcess({ cwd: repo })
    const options = {
      repo,
      stateDir: join(repo, ".git", "yrd"),
      baysRoot: join(repo, ".bays"),
      journal,
      process: runtimeProcess,
      config,
    }
    await using lineHost = await createDefaultYrdApp(options)
    await using submitter = await createDefaultYrdApp(options)
    await submitter.bays.submit({ branch: "task/feature", headSha: featureSha, base: "main" })
    expect(lineHost.state().bays.prs.PR1).toBeUndefined()

    const runs = await lineHost.line.integrate({}, { executor: "test", leaseMs: 60_000 })

    expect(runs).toEqual([expect.objectContaining({ status: "passed", prs: [expect.objectContaining({ id: "PR1" })] })])
    expect(lineHost.state().bays.prs.PR1).toMatchObject({ status: "integrated" })
  })

  it("uses steps.merge.run as the configured merge step", async () => {
    const { repo, featureSha } = await repository()
    const config: ResolvedYrdProjectConfig = {
      line: { base: "main", batch: 1, steps: ["check", "merge"] },
      steps: {
        check: { run: "test -f feature.txt", runner: "local" },
        merge: {
          run: 'touch delegated-merge.marker && git merge --no-ff --no-edit "$YRD_SHA"',
          runner: "local",
        },
      },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["check"] },
    }
    await using runtimeProcess = createProcess({ cwd: repo })
    await using app = await createDefaultYrdApp({
      repo,
      stateDir: join(repo, ".git", "yrd"),
      baysRoot: join(repo, ".bays"),
      journal: createMemoryJournal(),
      process: runtimeProcess,
      config,
    })
    await app.bays.submit({ branch: "task/feature", headSha: featureSha, base: "main" })

    const run = (await app.line.integrate({}, { executor: "test", leaseMs: 60_000 }))[0]!
    const landing = await git(repo, "rev-parse", "main")

    expect(run).toMatchObject({ status: "passed", integration: { commit: landing, baseSha: landing } })
    expect(await Bun.file(join(repo, "delegated-merge.marker")).exists()).toBe(true)
  })

  it("refuses a post-merge raw push when native merge owns the base ref", async () => {
    const { repo } = await repository()
    const config: ResolvedYrdProjectConfig = {
      line: { base: "main", batch: 1, steps: ["check", "merge", "deploy"] },
      steps: {
        check: { run: "true", runner: "local" },
        merge: { runner: "local" },
        deploy: { run: "git push origin main", runner: "local" },
      },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["check"] },
    }
    await using runtimeProcess = createProcess({ cwd: repo })

    await expect(
      createDefaultYrdApp({
        repo,
        stateDir: join(repo, ".git", "yrd"),
        baysRoot: join(repo, ".bays"),
        journal: createMemoryJournal(),
        process: runtimeProcess,
        config,
      }),
    ).rejects.toMatchObject({
      failure: { kind: "configuration", code: "native-merge-post-push" },
    })
  })
})

describe("createYrdHost", { timeout: 20_000 }, () => {
  it("classifies typed failure facts without scraping their messages", () => {
    const failure = createFailure({
      kind: "configuration",
      code: "runner-missing",
      message: "wording may change without changing the verdict",
    })
    const verdict = classifyFailure(failure)

    expect(verdict).toEqual({
      exitCode: 2,
      failure: {
        kind: "configuration",
        code: "runner-missing",
        message: "wording may change without changing the verdict",
      },
    })
    expect(JSON.parse(JSON.stringify(verdict))).toEqual(verdict)
    expect(classifyFailure(new Error("yrd: no bay 'message-shaped-but-untyped'"))).toMatchObject({
      exitCode: 3,
      failure: { kind: "infrastructure", code: "unexpected" },
    })
  })

  it("classifies writer-lock contention as an infrastructure failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "yrd-lock-exit-"))
    roots.push(root)
    const exclusive = createExclusive(root, { timeoutMs: 0 })

    await exclusive.run(async () => {
      let failure: unknown
      try {
        await exclusive.run(async () => undefined)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toContain("writer lock is busy")
      expect(classifyFailure(failure)).toMatchObject({
        exitCode: 3,
        failure: { kind: "infrastructure", code: "unexpected" },
      })
    })
  })

  it("prints help outside Git without initializing a repository host", async () => {
    const root = await mkdtemp(join(tmpdir(), "yrd-help-"))
    roots.push(root)
    let stdout = ""
    let stderr = ""

    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "--help"], {
        cwd: root,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
      }),
    ).toBe(0)
    expect(stdout).toContain("Usage: yrd")
    expect(stderr).toBe("")
    expect(await Bun.file(join(root, ".git", "yrd", "events.jsonl")).exists()).toBe(false)
  })

  it("treats a bare command namespace as help without initializing a repository host", async () => {
    const root = await mkdtemp(join(tmpdir(), "yrd-line-help-"))
    roots.push(root)
    let stdout = ""
    let stderr = ""

    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "line"], {
        cwd: root,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
      }),
    ).toBe(0)
    expect(stdout).toContain("Usage: yrd line")
    expect(stderr).toBe("")
    expect(await Bun.file(join(root, ".git", "yrd", "events.jsonl")).exists()).toBe(false)
  })

  it("initializes one filesystem authority and reopens its durable PR state", async () => {
    const { repo } = await repository()
    const first = await createYrdHost({ cwd: repo })

    expect(first.repository).toMatchObject({ repo, stateDir: join(repo, ".git", "yrd") })
    expect(first.receiver.receiverPath).toBe(join(repo, ".git", "yrd", "prs.git"))
    expect(await Bun.file(join(first.receiver.receiverPath, "hooks", "pre-receive")).exists()).toBe(true)
    const headSha = await git(repo, "rev-parse", "task/feature")
    await first.app.bays.submit({ branch: "task/feature", headSha, base: "main" })
    await first.close()

    const reopened = await createYrdHost({ cwd: repo })
    expect(reopened.app.state().bays.prs.PR1).toMatchObject({
      branch: "task/feature",
      headSha,
      status: "submitted",
    })
    await reopened.close()
  })

  it("disposes its owned runtime exactly once across close and await using", async () => {
    const { repo } = await repository()
    let releases = 0

    {
      await using host = await createYrdHost({ cwd: repo })
      host.app.scope.defer(() => {
        releases += 1
      })

      const close = host.close()
      expect(host[Symbol.asyncDispose]()).toBe(close)
      await close
      expect(releases).toBe(1)
    }

    expect(releases).toBe(1)
  })

  it("reaps an active configured child before SIGINT releases its executor lease", async () => {
    const { repo, featureSha } = await repository()
    const baseSha = await git(repo, "rev-parse", "main")
    const childPidPath = join(repo, "active-check.pid")
    const grandchildPidPath = join(repo, "active-check-grandchild.pid")
    const progressPath = join(repo, "active-check.progress")
    const finishedPath = join(repo, "active-check.finished")
    const scratchPath = join(repo, "active-check.scratch")
    const command = [
      `printf '%s\\n' "$$" > ${JSON.stringify(childPidPath)}`,
      `pwd > ${JSON.stringify(scratchPath)}`,
      `sh -c 'trap "" TERM; while :; do sleep 1; done' & printf '%s\\n' "$!" > ${JSON.stringify(grandchildPidPath)}`,
      "i=0",
      `while [ "$i" -lt 200 ]; do printf '%s\\n' "$i" >> ${JSON.stringify(progressPath)}; i=$((i + 1)); sleep 0.05; done`,
      `touch ${JSON.stringify(finishedPath)}`,
    ].join("; ")
    await writeFile(
      join(repo, ".yrd.yml"),
      `steps:\n  check:\n    run: ${JSON.stringify(command)}\n    timeoutMs: 30000\n`,
    )

    await using submitter = await createYrdHost({ cwd: repo })
    await submitter.app.bays.submit({ branch: "task/feature", headSha: featureSha, base: "main" })
    await submitter.close()

    const cli = Bun.spawn(
      [process.execPath, join(import.meta.dirname, "../../../bin/yrd.ts"), "line", "integrate", "PR1", "--json"],
      { cwd: repo, stdout: "pipe", stderr: "pipe" },
    )
    const cliStdout = new Response(cli.stdout).text()
    const cliStderr = new Response(cli.stderr).text()
    let childPid: number | undefined
    let grandchildPid: number | undefined
    try {
      await vi.waitFor(async () => expect(await Bun.file(childPidPath).exists()).toBe(true))
      childPid = Number.parseInt((await readFile(childPidPath, "utf8")).trim(), 10)
      expect(Number.isSafeInteger(childPid)).toBe(true)
      await vi.waitFor(async () => expect(await Bun.file(grandchildPidPath).exists()).toBe(true))
      grandchildPid = Number.parseInt((await readFile(grandchildPidPath, "utf8")).trim(), 10)
      expect(Number.isSafeInteger(grandchildPid)).toBe(true)
      await vi.waitFor(async () => expect((await readFile(progressPath, "utf8")).trim()).not.toBe(""))

      cli.kill("SIGINT")
      await expect(cli.exited).resolves.toBe(130)
      await vi.waitFor(() => expect(processExists(childPid!)).toBe(false))
      await vi.waitFor(() => expect(processExists(grandchildPid!)).toBe(false))

      await using recovery = await createYrdHost({ cwd: repo })
      const recovered = await recovery.app.line.recover({
        recoveryTime: "2100-01-01T00:00:00.000Z",
        executor: "recovery",
        leaseMs: 100,
      })
      expect(recovered).toEqual([
        expect.objectContaining({
          status: "failed",
          error: expect.objectContaining({ code: "job-lost" }),
          steps: expect.arrayContaining([expect.objectContaining({ job: expect.objectContaining({ attempt: 1 }) })]),
        }),
      ])
      expect(
        recovered.flatMap((run) => run.steps.flatMap((step) => (step.job === undefined ? [] : [step.job.attempt]))),
      ).toEqual([1])
      expect(await git(repo, "rev-parse", "main")).toBe(baseSha)
      expect(await Bun.file(finishedPath).exists()).toBe(false)
      const scratch = (await readFile(scratchPath, "utf8")).trim()
      expect(
        existsSync(scratch),
        [await cliStdout, await cliStderr, await git(repo, "worktree", "list", "--porcelain")].join("\n"),
      ).toBe(false)
    } finally {
      if (childPid !== undefined && processExists(childPid)) {
        try {
          process.kill(-childPid, "SIGKILL")
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
        }
      }
      if (grandchildPid !== undefined && processExists(grandchildPid)) {
        try {
          process.kill(grandchildPid, "SIGKILL")
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
        }
      }
      cli.kill("SIGKILL")
      await cli.exited
    }
  })

  it("submits the current linked-worktree branch when no bay selector is given", async () => {
    const { repo, featureSha } = await repository()
    const linked = join(repo, "..", "current")
    let setupStderr = ""

    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "bay", "open", "stale"], {
        cwd: repo,
        stdout: () => undefined,
        stderr: (text) => {
          setupStderr += text
        },
      }),
      setupStderr,
    ).toBe(0)
    await git(repo, "worktree", "add", "-q", linked, "task/feature")

    let stdout = ""
    let stderr = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "bay", "submit", "--base", "main", "--json"], {
        cwd: linked,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
      }),
      stderr,
    ).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({
      prs: [{ branch: "task/feature", headSha: featureSha, base: "main", status: "submitted" }],
    })

    await git(linked, "switch", "-q", "--detach")
    stdout = ""
    stderr = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "bay", "submit", "--base", "main", "--json"], {
        cwd: linked,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
      }),
    ).toBe(1)
    expect(stdout).toBe("")
    expect(stderr).toContain("no current Git branch; pass a bay or branch selector")
  })

  it("reports a failed line against origin when the operator HEAD is detached", async () => {
    const { repo, featureSha } = await repository()
    await writeFile(
      join(repo, ".yrd.yml"),
      "steps:\n  check: printf 'real stdout\\n'; printf 'real stderr\\n' >&2; exit 7\n",
    )
    const baseSha = await git(repo, "rev-parse", "main")
    const first = await createYrdHost({ cwd: repo })
    await first.app.bays.submit({ branch: "task/feature", headSha: featureSha, base: "main" })
    const run = (await first.app.line.integrate({ prs: ["PR1"] }, { executor: "test", leaseMs: 60_000 }))[0]!
    expect(run.status).toBe("failed")
    const failedJob = run.steps.find((step) => step.job?.status === "failed")?.job
    if (failedJob?.status !== "failed") throw new Error("missing failed configured check")
    const evidence = GitCheckEvidenceSchema.parse(failedJob.output)
    expect(evidence).toMatchObject({
      exitCode: 7,
      baseSha,
      artifacts: [{ name: "stdout" }, { name: "stderr" }],
    })
    const artifacts = new Map(evidence.artifacts.map((artifact) => [artifact.name, artifact.path]))
    const stdoutArtifact = artifacts.get("stdout")
    const stderrArtifact = artifacts.get("stderr")
    if (stdoutArtifact === undefined || stderrArtifact === undefined) throw new Error("missing command artifacts")
    expect(await readFile(stdoutArtifact, "utf8")).toBe("real stdout\n")
    expect(await readFile(stderrArtifact, "utf8")).toBe("real stderr\n")
    const submittedAt = first.app.state().bays.prs.PR1?.submittedAt
    const finishedAt = run.finishedAt
    if (submittedAt === undefined || finishedAt === undefined) throw new Error("missing immutable history timestamps")
    const expectedAgeMs = Date.parse(finishedAt) - Date.parse(submittedAt)
    await first.close()

    await git(repo, "update-ref", "refs/remotes/origin/main", baseSha)
    await git(repo, "switch", "-q", "--detach", featureSha)
    await git(repo, "branch", "-D", "main")
    let stdout = ""
    let stderr = ""

    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "line", "status"], {
        cwd: repo,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
        columns: 120,
        color: false,
        now: () => Date.now(),
      }),
    ).toBe(0)
    expect(stdout).toContain(`main@${baseSha.slice(0, 12)}`)
    expect(stdout).toMatch(/PR1\s+task\/feature\s+rejected/u)
    expect(stdout).not.toContain(featureSha.slice(0, 12))
    expect(stderr).toBe("")

    stdout = ""
    stderr = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "line", "status"], {
        cwd: repo,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
        columns: 120,
        color: true,
      }),
      stderr,
    ).toBe(0)
    expect(stdout).toContain(pathToFileURL(stdoutArtifact).href)

    stdout = ""
    stderr = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "line", "show", run.id], {
        cwd: repo,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
        columns: 120,
        color: true,
      }),
      stderr,
    ).toBe(0)
    expect(stdout).toContain(pathToFileURL(stdoutArtifact).href)
    expect(stdout).toContain(pathToFileURL(stderrArtifact).href)

    const machineHistory = async (now: string) => {
      let json = ""
      let error = ""
      expect(
        await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "line", "log", "--json"], {
          cwd: repo,
          stdout: (text) => {
            json += text
          },
          stderr: (text) => {
            error += text
          },
          now: () => Date.parse(now),
        }),
        error,
      ).toBe(0)
      return (JSON.parse(json) as { rows: readonly { subject: string; ageMs?: number }[] }).rows[0]
    }
    expect(await machineHistory("2026-07-13T12:00:00.000Z")).toMatchObject({ subject: "feature", ageMs: expectedAgeMs })
    expect(await machineHistory("2026-07-14T12:00:00.000Z")).toMatchObject({ subject: "feature", ageMs: expectedAgeMs })
  })

  it("renders clickable candidate-conflict evidence written by the real Git check adapter", async () => {
    const { repo } = await repository()
    await writeFile(join(repo, "conflict.txt"), "main\n")
    await git(repo, "add", "conflict.txt")
    await git(repo, "commit", "-qm", "main conflict")
    await git(repo, "switch", "-q", "task/feature")
    await writeFile(join(repo, "conflict.txt"), "feature\n")
    await git(repo, "add", "conflict.txt")
    await git(repo, "commit", "-qm", "feature conflict")
    const featureSha = await git(repo, "rev-parse", "HEAD")
    await git(repo, "switch", "-q", "main")
    await writeFile(join(repo, ".yrd.yml"), 'steps:\n  check:\n    run: "true"\n')

    const host = await createYrdHost({ cwd: repo })
    let artifact: string | undefined
    try {
      await host.app.bays.submit({ branch: "task/feature", headSha: featureSha, base: "main" })
      const run = (await host.app.line.integrate({ prs: ["PR1"] }, { executor: "test", leaseMs: 60_000 }))[0]!
      expect(run).toMatchObject({ status: "failed", error: { code: "candidate-conflict" } })
      const failedStep = run.steps.find((step) => step.job?.status === "failed")
      const artifacts = (failedStep?.job as { output?: { artifacts?: readonly { path: string }[] } } | undefined)
        ?.output?.artifacts
      artifact = artifacts?.[0]?.path
      expect(artifact).toMatch(/\/\.git\/yrd\/artifacts\/R1\/0-check\/attempt-1\/(?:stdout|stderr)\.log$/u)
      expect(artifact === undefined ? "" : await readFile(artifact, "utf8")).toContain("CONFLICT")
    } finally {
      await host.close()
    }

    let stdout = ""
    let stderr = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "line", "status"], {
        cwd: repo,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
        columns: 120,
        color: true,
      }),
      stderr,
    ).toBe(0)
    expect(stdout).toContain("candidate-conflict")
    expect(stdout).not.toContain("yrd line show")
    expect(artifact === undefined ? stdout : stdout).toContain(
      artifact === undefined ? "candidate-conflict" : pathToFileURL(artifact).href,
    )
  })

  it("reports the authoritative remote line head when local main is stale", async () => {
    const { repo, featureSha } = await repository()
    const localSha = await git(repo, "rev-parse", "main")
    const remote = join(repo, "..", "origin.git")
    await git(repo, "init", "-q", "--bare", remote)
    await git(repo, "remote", "add", "origin", remote)
    await git(repo, "push", "-q", "origin", "main", "task/feature")
    await git(repo, "push", "-q", "origin", `${featureSha}:refs/heads/main`)
    await git(repo, "fetch", "-q", "origin", "main:refs/remotes/origin/main")
    expect(await git(repo, "rev-parse", "main")).toBe(localSha)

    let stdout = ""
    let stderr = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "line", "status", "--json"], {
        cwd: repo,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
      }),
    ).toBe(0)

    expect(JSON.parse(stdout)).toMatchObject({ results: [{ base: "main", headSha: featureSha }] })
    expect(stderr).toBe("")
  })
})

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

describe("discoverYrdRepository", { timeout: 20_000 }, () => {
  it("resolves a relative core.worktree from a separate Git directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "yrd-separated-git-"))
    roots.push(root)
    const repo = join(root, "repo")
    const gitDir = join(root, "modules", "repo.git")
    await mkdir(join(root, "modules"))
    await git(root, "init", "-q", "-b", "main", "--separate-git-dir", gitDir, repo)
    await git(repo, "config", "core.worktree", relative(gitDir, repo))
    const resolvedRepo = await realpath(repo)
    const resolvedGitDir = await realpath(gitDir)

    expect(await discoverYrdRepository({ cwd: repo })).toEqual({
      repo: resolvedRepo,
      worktree: resolvedRepo,
      gitDir: resolvedGitDir,
      stateDir: join(resolvedGitDir, "yrd"),
      baysRoot: join(resolvedRepo, ".bays"),
      defaultBase: "main",
    })
  })

  it("reads the primary config.worktree when invoked from a linked bay", async () => {
    const root = await mkdtemp(join(tmpdir(), "yrd-separated-linked-"))
    roots.push(root)
    const repo = join(root, "repo")
    const linked = join(root, "bay")
    const gitDir = join(root, "modules", "repo.git")
    const worktree = relative(gitDir, repo)
    await mkdir(join(root, "modules"))
    await git(root, "init", "-q", "-b", "main", "--separate-git-dir", gitDir, repo)
    await git(repo, "config", "core.worktree", worktree)
    await git(repo, "config", "user.name", "Yrd Test")
    await git(repo, "config", "user.email", "yrd@example.invalid")
    await writeFile(join(repo, "README.md"), "main\n")
    await git(repo, "add", "README.md")
    await git(repo, "commit", "-qm", "main")
    await git(repo, "config", "extensions.worktreeConfig", "true")
    await git(repo, "config", "--worktree", "core.worktree", worktree)
    await git(repo, "config", "--local", "--unset-all", "core.worktree")
    await git(repo, "worktree", "add", "-qb", "task/bay", linked)

    expect(await discoverYrdRepository({ cwd: linked })).toMatchObject({
      repo: await realpath(repo),
      worktree: await realpath(linked),
      gitDir: await realpath(gitDir),
      baysRoot: join(await realpath(repo), ".bays"),
    })
  })

  it("finds the shared Git directory and primary worktree from a linked worktree", async () => {
    const { repo } = await repository()
    const linked = join(repo, "..", "linked")
    await git(repo, "worktree", "add", "-qb", "task/linked", linked)
    const nested = join(linked, "nested")
    await mkdir(nested)

    expect(await discoverYrdRepository({ cwd: nested, env: { ...process.env, GIT_DIR: "/must/not/leak" } })).toEqual({
      repo,
      worktree: await realpath(linked),
      gitDir: join(repo, ".git"),
      stateDir: join(repo, ".git", "yrd"),
      baysRoot: join(repo, ".bays"),
      defaultBase: "main",
    })
  })

  it("refuses a directory outside Git", async () => {
    const root = await mkdtemp(join(tmpdir(), "yrd-not-repository-"))
    roots.push(root)
    await expect(discoverYrdRepository({ cwd: root })).rejects.toThrow("not inside a Git worktree")
  })
})

describe("stepTimeoutMs — the ONE default wall-clock bound for local step commands (21012 S1)", () => {
  it("applies the default when a step declares no bound, and the declared bound when it does", async () => {
    const { DEFAULT_STEP_TIMEOUT_MS, stepTimeoutMs } = await import("../src/host.ts")
    expect(stepTimeoutMs({ run: "x", runner: "local" })).toBe(DEFAULT_STEP_TIMEOUT_MS)
    expect(stepTimeoutMs({ run: "x", runner: "waiting" })).toBe(DEFAULT_STEP_TIMEOUT_MS)
    expect(stepTimeoutMs({ run: "x", runner: "local", timeoutMs: 1_234 })).toBe(1_234)
  })
})
