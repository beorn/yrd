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
import { GitCheckEvidenceSchema, IntegrationProofSchema } from "@yrd/queue"
import { createExclusive } from "@yrd/persistence"
import { createProcess } from "@yrd/process"
import * as z from "zod"
import { createDefaultYrdApp, createYrdHost, runYrdProcess } from "../src/host.ts"
import { queueStepRevision } from "../src/host-revision.ts"
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
  await git(repo, "switch", "-qc", "issue/feature")
  await writeFile(join(repo, "feature.txt"), "feature\n")
  await git(repo, "add", "feature.txt")
  await git(repo, "commit", "-qm", "feature")
  const featureSha = await git(repo, "rev-parse", "HEAD")
  await git(repo, "switch", "-q", "main")
  return { repo, featureSha }
}

async function compositionRepository(): Promise<{
  repo: string
  oldPinSha: string
  newPinSha: string
  sourceTipSha: string
  rootBaseSha: string
}> {
  const { repo } = await repository()
  const module = join(repo, "..", "module")
  await git(repo, "config", "protocol.file.allow", "always")
  await git(repo, "switch", "-q", "main")
  await git(repo, "init", "-q", "-b", "main", module)
  await git(module, "config", "user.name", "Yrd Test")
  await git(module, "config", "user.email", "yrd@example.invalid")
  await writeFile(join(module, "README.md"), "base\n")
  await git(module, "add", "README.md")
  await git(module, "commit", "-qm", "base")
  const oldPinSha = await git(module, "rev-parse", "HEAD")

  await git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", module, "dep")
  await writeFile(join(repo, ".yrd.yml"), 'base: main\nbatch: 1\nsteps: [check, merge]\ncheck: "true"\nmerge: {}\n')
  await git(repo, "add", ".yrd.yml", ".gitmodules", "dep")
  await git(repo, "commit", "-qm", "add dependency and queue")

  await git(module, "switch", "-qc", "issue/source")
  await mkdir(join(module, "src"), { recursive: true })
  await writeFile(join(module, "src/candidate.ts"), "export const candidate = true\n")
  await git(module, "add", "src/candidate.ts")
  await git(module, "commit", "-qm", "candidate payload")
  const sourceTipSha = await git(module, "rev-parse", "HEAD")

  await git(module, "switch", "-q", "main")
  await mkdir(join(module, "src"), { recursive: true })
  await writeFile(join(module, "src/upstream.ts"), "export const upstream = true\n")
  await git(module, "add", "src/upstream.ts")
  await git(module, "commit", "-qm", "upstream payload")
  const newPinSha = await git(module, "rev-parse", "HEAD")

  await git(join(repo, "dep"), "fetch", "-q", "origin")
  await git(join(repo, "dep"), "checkout", "-q", newPinSha)
  await git(repo, "add", "dep")
  await git(repo, "commit", "-qm", "advance dependency")
  const rootBaseSha = await git(repo, "rev-parse", "HEAD")
  await git(repo, "branch", "issue/source", rootBaseSha)
  return { repo, oldPinSha, newPinSha, sourceTipSha, rootBaseSha }
}

describe("createDefaultYrdApp", { timeout: 20_000 }, () => {
  it("binds installed-step revisions to every toolchain fingerprint component", () => {
    const toolchain = { bun: "1.3.0", node: "24.0.0", platform: "darwin", arch: "arm64" }
    const input = {
      repo: "/repo",
      stateDir: "/repo/.git/yrd",
      name: "check",
      config: { run: "bun run check", runner: "local" as const },
      timeoutMs: 60_000,
      toolchain,
    }
    const baseline = queueStepRevision(input)

    // The queue suite owns revision→cache-miss behavior; this host seam owns
    // the preceding fingerprint→revision identity edge.
    for (const changed of [
      { ...toolchain, bun: "1.3.1" },
      { ...toolchain, node: "24.1.0" },
      { ...toolchain, platform: "linux" },
      { ...toolchain, arch: "x64" },
    ]) {
      expect(queueStepRevision({ ...input, toolchain: changed })).not.toBe(baseline)
    }
  })

  it("composes the final plugin stack and integrates through configured typed steps", async () => {
    const { repo, featureSha } = await repository()
    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      steps: ["security", "merge", "publish"],
      requires: [],
      definitions: {
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

    expect(app.state().queues).toMatchObject({
      batchSize: 1,
      defaultSteps: ["security", "merge", "publish"],
    })
    expect(Object.keys(app.commands.bay)).toEqual(["open", "refresh", "intake", "submit", "close"])
    expect(Object.keys(app.commands.pr)).toEqual([
      "close",
      "edit",
      "recut",
      "ready",
      "review",
      "comment",
      "requestChecks",
      "regression",
    ])
    expect(app.commands.bay.intake.metadata?.visibility).toBe("internal")
    expect(app.commands.bay.open.metadata?.visibility).toBe("public")
    expect(app.commands.pr.close.metadata?.visibility).toBe("public")
    expect(app.commands.pr.review.metadata?.visibility).toBe("public")
    expect(app.commands.queue.admit.metadata?.visibility).toBe("internal")
    expect(app.commands.queue.run.metadata?.visibility).toBe("public")

    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
    const run = (await app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 }))[0]!
    expect(run.status).toBe("passed")
    expect(run.steps.map((step) => step.name)).toEqual(["security", "merge", "publish"])
    expect(await git(repo, "merge-base", "--is-ancestor", featureSha, "main")).toBe("")
    const evaluatorRevision = app.jobs.definition("contest.evaluator.security").revision
    const queueRevision = app.jobs.definition("queue.step.security").revision
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

    const changedLineTimeout = await createDefaultYrdApp({
      repo,
      stateDir: join(repo, ".git", "yrd"),
      baysRoot: join(repo, ".bays"),
      journal: createMemoryJournal(),
      process: runtimeProcess,
      config: {
        ...config,
        definitions: {
          ...config.definitions,
          security: { ...config.definitions.security!, timeoutMs: 30_000 },
        },
      },
    })
    expect(changedLineTimeout.jobs.definition("queue.step.security").revision).not.toBe(queueRevision)
    await changedLineTimeout.close()
  })

  it("normalizes remote aliases of the configured queue and refuses duplicate payload admission", async () => {
    const { repo, featureSha } = await repository()
    const baseSha = await git(repo, "rev-parse", "main")
    await git(repo, "update-ref", "refs/remotes/origin/main", baseSha)
    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      steps: ["check", "merge"],
      requires: [],
      definitions: { check: { run: "true", runner: "local" }, merge: { runner: "local" } },
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

    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "origin/main" })

    expect(app.state().bays.prs.PR1).toMatchObject({ base: "main", baseSha })
    await expect(
      app.bays.submit({ branch: "origin/issue/feature", headSha: featureSha, base: "main" }),
    ).rejects.toThrow("payload already recorded as PR 'PR1'")
    expect(Object.keys(app.state().bays.prs)).toEqual(["PR1"])
  })

  it("refreshes queue authority without touching dirty behind operator main", async () => {
    const { repo, featureSha } = await repository()
    const localBaseSha = await git(repo, "rev-parse", "main")
    const remote = join(repo, "..", "origin.git")
    await git(repo, "init", "-q", "--bare", remote)
    await git(repo, "remote", "add", "origin", remote)
    await git(repo, "push", "-q", "origin", "main", "issue/feature")
    await git(repo, "switch", "-qc", "issue/remote-main")
    await writeFile(join(repo, "remote.txt"), "remote\n")
    await git(repo, "add", "remote.txt")
    await git(repo, "commit", "-qm", "remote main")
    const remoteBaseSha = await git(repo, "rev-parse", "HEAD")
    await git(repo, "push", "-q", "origin", "HEAD:main")
    await git(repo, "switch", "-q", "main")
    await writeFile(join(repo, "operator-wip.txt"), "preserve these bytes\n")

    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      steps: ["check", "merge"],
      requires: [],
      definitions: { check: { run: "true", runner: "local" }, merge: { runner: "local" } },
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

    const submitted = await app.bays.submitSelection("issue/feature", {
      resolveRevision: async () => featureSha,
      run: { runner: "test", leaseMs: 60_000 },
    })

    expect(submitted).toMatchObject({ revision: 1, headSha: featureSha, baseSha: remoteBaseSha, status: "submitted" })
    expect(await git(repo, "rev-parse", "main")).toBe(localBaseSha)
    expect(await readFile(join(repo, "operator-wip.txt"), "utf8")).toBe("preserve these bytes\n")
    expect(Object.keys(app.state().bays.prs)).toEqual(["PR1"])
  })

  it("refreshes a shared journal before the host selects queued PRs", async () => {
    const { repo, featureSha } = await repository()
    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      steps: ["check", "merge"],
      requires: [],
      definitions: {
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
    await using queueHost = await createDefaultYrdApp(options)
    await using submitter = await createDefaultYrdApp(options)
    await submitter.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
    expect(queueHost.state().bays.prs.PR1).toBeUndefined()

    const runs = await queueHost.queue.run({}, { runner: "test", leaseMs: 60_000 })

    expect(runs).toEqual([expect.objectContaining({ status: "passed", prs: [expect.objectContaining({ id: "PR1" })] })])
    expect(queueHost.state().bays.prs.PR1).toMatchObject({ status: "integrated" })
  })

  it("uses steps.merge.run as the configured merge step", async () => {
    const { repo, featureSha } = await repository()
    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      steps: ["check", "merge"],
      requires: [],
      definitions: {
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
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({}, { runner: "test", leaseMs: 60_000 }))[0]!
    const landing = await git(repo, "rev-parse", "main")

    expect(run).toMatchObject({ status: "passed", integration: { commit: landing, baseSha: landing } })
    expect(await Bun.file(join(repo, "delegated-merge.marker")).exists()).toBe(true)
  })

  it("refuses a post-merge raw push when native merge owns the base ref", async () => {
    const { repo } = await repository()
    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      steps: ["check", "merge", "deploy"],
      requires: [],
      definitions: {
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
        failure: { kind: "infrastructure", code: "exclusive-busy" },
      })
    })
  })

  it("prints help outside Git without initializing a repository host", async () => {
    const root = await mkdtemp(join(tmpdir(), "yrd-help-"))
    roots.push(root)
    let stdout = ""
    let stderr = ""

    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "--repo", root, "--help"], {
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
    expect(stdout).toContain("yrd (shipyard) — agentic software delivery")
    expect(stdout).toContain("Model:")
    expect(stdout).toContain("Objects:")
    expect(stdout).toContain("Boundaries:")
    expect(stdout).toContain("--repo <path>")
    expect(stdout).toContain("YRD_REPO")
    expect(stdout).not.toContain("--cwd")
    expect(stdout).not.toContain("YRD_CWD")
    expect(stdout).not.toContain("--config")
    expect(stdout).not.toContain("--root")
    const commandBlock = stdout.match(/Commands:\n(?<commands>[\s\S]*?)\n\nModel:/u)?.groups?.commands ?? ""
    expect(
      commandBlock
        .split("\n")
        .flatMap((text) => text.match(/^\s{2}(?<command>[a-z]+)(?:\s+\[[^\]]+\])*\s{2,}/u)?.groups?.command ?? []),
    ).toEqual(["pr", "bay", "issue", "contest", "queue", "migrate", "log", "watch", "prime"])
    expect(stdout).not.toMatch(/\b(?:pr\|prs|bay\|bays|issue\|issues|contest\|contests|queue\|queues)\b/u)
    expect(stderr).toBe("")
    expect(await Bun.file(join(root, ".git", "yrd", "events-v3.jsonl")).exists()).toBe(false)

    stdout = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/git-bay", "--repo", root, "--help"], {
        cwd: root,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
      }),
    ).toBe(0)
    expect(stdout).toContain("Usage: git bay")
    expect(stdout).toContain("--repo <path>")
    expect(stdout).not.toContain("--cwd")
    expect(stderr).toBe("")
  })

  it("prints namespace help without initializing a repository host", async () => {
    const root = await mkdtemp(join(tmpdir(), "yrd-queue-help-"))
    roots.push(root)
    let stdout = ""
    let stderr = ""

    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "queue", "--help"], {
        cwd: root,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
      }),
    ).toBe(0)
    expect(stdout).toContain("Usage: yrd queue")
    expect(stderr).toBe("")
    expect(await Bun.file(join(root, ".git", "yrd", "events-v3.jsonl")).exists()).toBe(false)
  })

  it("preserves native Commander styling in a fresh color-forced process", async () => {
    const yrdRoot = join(import.meta.dirname, "../../..")
    const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "1", NODE_ENV: "production" }
    delete env.NO_COLOR
    const child = Bun.spawn([process.execPath, join(yrdRoot, "bin", "yrd.ts"), "--help"], {
      cwd: yrdRoot,
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(exitCode, stderr).toBe(0)
    expect(stderr).toBe("")
    const sgr = String.raw`\u001B\[[0-9;]*m`
    for (const text of ["Usage:", "yrd", "-h, --help", "Examples:"]) {
      expect(stdout).toMatch(new RegExp(`${sgr}${text}${sgr}`, "u"))
    }
  })

  it("runs bare root as plain help while preserving the JSON dashboard", async () => {
    const { repo } = await repository()
    await writeFile(
      join(repo, ".yrd.yml"),
      ["base: main", "batch: 1", "steps: [check, merge]", "check: 'true'", "merge: {}", ""].join("\n"),
    )

    let plain = ""
    let plainError = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd"], {
        cwd: repo,
        columns: 80,
        stdout: (text) => {
          plain += text
        },
        stderr: (text) => {
          plainError += text
        },
      }),
      plainError,
    ).toBe(0)
    expect(plain).toContain("Usage: yrd [options] [command]")
    expect(plain).not.toContain("OPEN")
    expect(plain).not.toContain("\u001b[")
    expect(Math.max(...plain.split("\n").map((line) => line.length))).toBeLessThanOrEqual(80)
    expect(plainError).toBe("")

    let json = ""
    let jsonError = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "--json"], {
        cwd: repo,
        stdout: (text) => {
          json += text
        },
        stderr: (text) => {
          jsonError += text
        },
      }),
      jsonError,
    ).toBe(0)
    expect(JSON.parse(json)).toMatchObject({ command: "dashboard", results: [{ base: "main" }] })
    expect(jsonError).toBe("")
  })

  it("runs the literal --steps merge CLI without starting the configured check process", async () => {
    const { repo, featureSha } = await repository()
    const checkMarker = join(repo, "configured-check-started.marker")
    await writeFile(
      join(repo, ".yrd.yml"),
      [
        "base: main",
        "batch: 1",
        "steps: [check, merge]",
        `check: ${JSON.stringify(`touch ${checkMarker}`)}`,
        "merge: {}",
        "",
      ].join("\n"),
    )
    await git(repo, "add", ".yrd.yml")
    await git(repo, "commit", "-qm", "shipping config")

    let submitError = ""
    expect(
      await runYrdProcess(
        ["/usr/bin/bun", "/usr/local/bin/yrd", "pr", "submit", "issue/feature", "--base", "main", "--json"],
        {
          cwd: repo,
          stdout: () => undefined,
          stderr: (text) => {
            submitError += text
          },
        },
      ),
      submitError,
    ).toBe(0)

    let stdout = ""
    let stderr = ""
    const exitCode = await runYrdProcess(
      ["/usr/bin/bun", "/usr/local/bin/yrd", "queue", "run", "PR1", "--steps", "merge", "--json"],
      {
        cwd: repo,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
      },
    )
    expect(await Bun.file(checkMarker).exists(), JSON.stringify({ exitCode, stdout, stderr })).toBe(false)
    expect(exitCode, stderr).toBe(0)
    const result = JSON.parse(stdout) as { results: Array<{ id: string }> }
    expect(result).toMatchObject({
      command: "queue.run",
      results: [
        {
          status: "passed",
          stepSelection: {
            authority: "explicit",
            steps: ["merge"],
            omittedSteps: [{ name: "check", index: 0, status: "skipped", reason: "not-selected" }],
          },
          steps: [{ name: "merge" }],
          prs: [{ id: "PR1", headSha: featureSha }],
        },
      ],
    })
    expect(await git(repo, "merge-base", "--is-ancestor", featureSha, "main")).toBe("")
    const runId = result.results[0]?.id
    if (runId === undefined) throw new Error("merge-only CLI produced no durable run")
    await using reopened = await createYrdHost({ cwd: repo })
    expect(reopened.app.queue.get(runId)).toMatchObject({
      stepSelection: {
        authority: "explicit",
        steps: ["merge"],
        omittedSteps: [{ name: "check", index: 0, status: "skipped", reason: "not-selected" }],
      },
    })
  })

  it("runs a literal merge-only batch without starting either configured check", async () => {
    const { repo, featureSha } = await repository()
    await git(repo, "switch", "-qc", "issue/second")
    await writeFile(join(repo, "second.txt"), "second\n")
    await git(repo, "add", "second.txt")
    await git(repo, "commit", "-qm", "second")
    const secondSha = await git(repo, "rev-parse", "HEAD")
    await git(repo, "switch", "-q", "main")
    const checkMarker = join(repo, "configured-check-started.marker")
    await writeFile(
      join(repo, ".yrd.yml"),
      [
        "base: main",
        "batch: 2",
        "steps: [check, merge]",
        `check: ${JSON.stringify(`touch ${checkMarker}`)}`,
        "merge: {}",
        "",
      ].join("\n"),
    )
    await git(repo, "add", ".yrd.yml")
    await git(repo, "commit", "-qm", "shipping config")

    for (const branch of ["issue/feature", "issue/second"]) {
      let stderr = ""
      expect(
        await runYrdProcess(
          ["/usr/bin/bun", "/usr/local/bin/yrd", "pr", "submit", branch, "--base", "main", "--json"],
          {
            cwd: repo,
            stdout: () => undefined,
            stderr: (text) => {
              stderr += text
            },
          },
        ),
        stderr,
      ).toBe(0)
    }

    let stdout = ""
    let stderr = ""
    const exitCode = await runYrdProcess(
      ["/usr/bin/bun", "/usr/local/bin/yrd", "queue", "run", "PR1", "PR2", "--steps", "merge", "--json"],
      {
        cwd: repo,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
      },
    )
    expect(await Bun.file(checkMarker).exists(), JSON.stringify({ exitCode, stdout, stderr })).toBe(false)
    expect(exitCode, stderr).toBe(0)
    const result = JSON.parse(stdout) as { results: Record<string, unknown>[] }
    expect(result).toMatchObject({
      command: "queue.run",
      results: [
        {
          status: "passed",
          stepSelection: {
            authority: "explicit",
            steps: ["merge"],
            omittedSteps: [{ name: "check", index: 0, status: "skipped", reason: "not-selected" }],
          },
          steps: [{ name: "merge" }],
          prs: [
            { id: "PR1", headSha: featureSha },
            { id: "PR2", headSha: secondSha },
          ],
        },
      ],
    })
    expect(await git(repo, "merge-base", "--is-ancestor", featureSha, "main")).toBe("")
    expect(await git(repo, "merge-base", "--is-ancestor", secondSha, "main")).toBe("")
  })

  it("does not reuse a prior configured check as merge-only authority", async () => {
    const { repo } = await repository()
    const checkMarker = join(repo, "..", "configured-check-runs.log")
    await writeFile(
      join(repo, ".yrd.yml"),
      [
        "base: main",
        "batch: 1",
        "steps: [check, merge]",
        `check: ${JSON.stringify(`printf check >> ${checkMarker}`)}`,
        "merge: {}",
        "",
      ].join("\n"),
    )
    await git(repo, "add", ".yrd.yml")
    await git(repo, "commit", "-qm", "shipping config")

    let submitError = ""
    expect(
      await runYrdProcess(
        ["/usr/bin/bun", "/usr/local/bin/yrd", "pr", "submit", "issue/feature", "--base", "main", "--follow", "--json"],
        {
          cwd: repo,
          stdout: () => undefined,
          stderr: (text) => {
            submitError += text
          },
        },
      ),
      submitError,
    ).toBe(0)
    expect(await readFile(checkMarker, "utf8")).toBe("check")

    let stdout = ""
    let stderr = ""
    const exitCode = await runYrdProcess(
      ["/usr/bin/bun", "/usr/local/bin/yrd", "queue", "run", "PR1", "--steps", "merge", "--json"],
      {
        cwd: repo,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
      },
    )
    expect(await readFile(checkMarker, "utf8")).toBe("check")
    expect(exitCode, JSON.stringify({ stdout, stderr })).toBe(0)
    const result = JSON.parse(stdout) as { results: Record<string, unknown>[] }
    expect(result).toMatchObject({
      results: [
        {
          status: "passed",
          stepSelection: {
            authority: "explicit",
            steps: ["merge"],
            omittedSteps: [{ name: "check", index: 0, status: "skipped", reason: "not-selected" }],
          },
          shape: { results: {} },
          steps: [{ name: "merge" }],
        },
      ],
    })
    expect(result.results[0]).not.toHaveProperty("reusedFrom")
  })

  it("preserves a literal shipping-config main-health failure through submit --follow and pr checks", async () => {
    const { repo } = await repository()
    const tentScript = join(repo, ".claude", "skills", "tent", "scripts", "tent.ts")
    await mkdir(join(repo, ".claude", "skills", "tent", "scripts"), { recursive: true })
    await writeFile(
      tentScript,
      [
        'const index = process.argv.indexOf("--base-sha")',
        'const baseSha = index < 0 ? "unknown" : (process.argv[index + 1] ?? "unknown")',
        "console.log(`[yrd-base-health] base ${baseSha.slice(0, 12)} is red: test:fast failed`)",
        "process.exitCode = 1",
        "",
      ].join("\n"),
    )
    await writeFile(
      join(repo, ".yrd.yml"),
      [
        "base: main",
        "batch: 1",
        "steps: [main-health, check, merge]",
        "requires: [review]",
        "",
        "main-health:",
        "  classification: base",
        "  run: |",
        '    bun .claude/skills/tent/scripts/tent.ts main-health-read --base-sha "$YRD_BASE_SHA"',
        "check: |",
        "  git submodule update --init --recursive --jobs 20 &&",
        "  bun install --frozen-lockfile --ignore-scripts &&",
        "  bun run build:info &&",
        "  bun fix:all &&",
        '  status="$(git status --porcelain)" &&',
        '  if test -n "$status"; then printf \'%s\\n\' "$status" >&2; exit 1; fi &&',
        "  bun run typecheck &&",
        '  bun run test:affected "$YRD_BASE_SHA"',
        "merge: {}",
        "",
        "contest:",
        "  concurrency: 2",
        "  timeoutMs: 1800000",
        "  evaluators: [check]",
        "",
      ].join("\n"),
    )
    await git(repo, "add", ".yrd.yml", ".claude/skills/tent/scripts/tent.ts")
    await git(repo, "commit", "-qm", "shipping config")
    const baseSha = await git(repo, "rev-parse", "main")

    let submitStdout = ""
    let submitStderr = ""
    expect(
      await runYrdProcess(
        ["/usr/bin/bun", "/usr/local/bin/yrd", "pr", "submit", "issue/feature", "--follow", "--json"],
        {
          cwd: repo,
          stdout: (text) => {
            submitStdout += text
          },
          stderr: (text) => {
            submitStderr += text
          },
        },
      ),
      submitStderr,
    ).toBe(1)
    expect(submitStderr.trim().split("\n")).toEqual([
      expect.stringMatching(/\bERROR yrd:jobs:main-health main-health failed\b/u),
      expect.stringMatching(/\bERROR yrd:queue:run run failed\b/u),
      expect.stringMatching(/\bERROR yrd:queue:admit admit failed\b/u),
    ])
    const submitted = JSON.parse(submitStdout) as { checks: Record<string, unknown>[] }
    expect(submitted).toMatchObject({
      command: "pr.submit",
      checks: [
        {
          pr: "PR1",
          revision: 1,
          run: "R1",
          step: "main-health",
          status: "failed",
          classification: "base",
          command: ["sh", "-c", expect.stringContaining("main-health-read")],
          diagnostics: expect.stringContaining(
            `[yrd-base-health] base ${baseSha.slice(0, 12)} is red: test:fast failed`,
          ),
        },
      ],
    })

    let checksStdout = ""
    let checksStderr = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "pr", "checks", "PR1", "--json"], {
        cwd: repo,
        stdout: (text) => {
          checksStdout += text
        },
        stderr: (text) => {
          checksStderr += text
        },
      }),
      checksStderr,
    ).toBe(1)
    expect(checksStderr).toBe("")
    expect(JSON.parse(checksStdout)).toEqual({ kind: "pr.check", ...submitted.checks[0] })

    for (const color of [false, true]) {
      let stdout = ""
      let stderr = ""
      expect(
        await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "pr", "checks", "PR1"], {
          cwd: repo,
          columns: 180,
          color,
          stdout: (text) => {
            stdout += text
          },
          stderr: (text) => {
            stderr += text
          },
        }),
        stderr,
      ).toBe(1)
      expect(stderr).toBe("")
      expect(stdout).toContain("main-health")
      expect(stdout).toContain("base")
      expect(stdout).toContain("test:fast failed")
      expect(stdout).toContain("main-health-read")
      if (color) expect(stdout).toContain("\u001b[")
      else expect(stdout).not.toContain("\u001b[")
    }
  })

  it("refuses the retired config wrapper before plain or JSON startup mutates state", async () => {
    const { repo } = await repository()
    const retiredWrapper = ["li", "ne"].join("")
    await writeFile(join(repo, ".yrd.yml"), `${retiredWrapper}:\n  base: main\n  steps: [check, merge]\n`)

    for (const args of [["--json"]]) {
      let stdout = ""
      let stderr = ""
      expect(
        await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", ...args], {
          cwd: repo,
          stdout: (text) => {
            stdout += text
          },
          stderr: (text) => {
            stderr += text
          },
        }),
      ).toBe(2)
      expect(stdout).toBe("")
      expect(stderr).toContain(`remove '${retiredWrapper}:'`)
      expect(stderr).toContain("configure base, batch, steps, and step definitions at the top level")
      expect(await Bun.file(join(repo, ".git", "yrd", "events-v3.jsonl")).exists()).toBe(false)
    }
  })

  it("initializes one filesystem authority and reopens its durable PR state", async () => {
    const { repo } = await repository()
    const first = await createYrdHost({ cwd: repo })

    expect(first.repository).toMatchObject({ repo, stateDir: join(repo, ".git", "yrd") })
    expect(first.receiver.receiverPath).toBe(join(repo, ".git", "yrd", "prs.git"))
    expect(await Bun.file(join(first.receiver.receiverPath, "hooks", "pre-receive")).exists()).toBe(true)
    const headSha = await git(repo, "rev-parse", "issue/feature")
    await first.app.bays.submit({ branch: "issue/feature", headSha, base: "main" })
    await first.close()

    const reopened = await createYrdHost({ cwd: repo })
    expect(reopened.app.state().bays.prs.PR1).toMatchObject({
      branch: "issue/feature",
      headSha,
      status: "submitted",
    })
    await reopened.close()
  })

  it("finds a direct-branch PR for status and refuses pr merge without appending", async () => {
    const { repo } = await repository()
    await git(repo, "switch", "-q", "issue/feature")
    const journal = join(repo, ".git", "yrd", "events-v3.jsonl")
    let missingJson = ""
    let missingStdout = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "pr", "merge", "issue/feature", "--json"], {
        cwd: repo,
        stdout: (text) => {
          missingStdout += text
        },
        stderr: (text) => {
          missingJson += text
        },
      }),
    ).toBe(1)
    expect(missingStdout).toBe("")
    expect(JSON.parse(missingJson)).toMatchObject({
      command: "pr.merge",
      branch: "issue/feature",
      status: "not-submitted",
      next: "yrd pr submit issue/feature",
    })
    expect(await Bun.file(journal).exists()).toBe(false)

    let submitJson = ""
    let submitError = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "pr", "submit", "--base", "main", "--json"], {
        cwd: repo,
        stdout: (text) => {
          submitJson += text
        },
        stderr: (text) => {
          submitError += text
        },
      }),
      submitError,
    ).toBe(0)
    expect(JSON.parse(submitJson)).toMatchObject({ command: "pr.submit", prs: [{ id: "PR1" }] })

    let statusJson = ""
    let statusError = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "pr", "status", "--json"], {
        cwd: repo,
        stdout: (text) => {
          statusJson += text
        },
        stderr: (text) => {
          statusError += text
        },
      }),
      statusError,
    ).toBe(0)
    expect(JSON.parse(statusJson)).toMatchObject({ command: "pr.status", pr: { id: "PR1" } })

    const before = await readFile(journal, "utf8")
    let mergeJson = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "pr", "merge", "PR1", "--json"], {
        cwd: repo,
        stdout: () => undefined,
        stderr: (text) => {
          mergeJson += text
        },
      }),
    ).toBe(1)
    expect(JSON.parse(mergeJson)).toMatchObject({
      command: "pr.merge",
      position: 1,
      next: "yrd watch --pr PR1",
      guidance: { watch: "yrd watch --pr PR1" },
    })
    expect(await readFile(journal, "utf8")).toBe(before)
  })

  it("executes every bare read and no-op recovery without creating journal state", async () => {
    const { repo } = await repository()
    const surfaces = [
      { args: ["--json"], command: "dashboard" },
      { args: ["queue", "--json"], command: "queue.list" },
      { args: ["pr", "list", "--json"], command: "pr.list" },
      { args: ["issue", "--json"], command: "issue.list" },
      { args: ["log", "--all", "--json"], command: "log" },
      { args: ["prime", "--json"], command: "prime" },
      { args: ["queue", "pause", "--json"], command: "queue.pause" },
      { args: ["queue", "recover", "--json"], command: "queue.recover" },
    ] as const

    for (const surface of surfaces) {
      let stdout = ""
      let stderr = ""
      expect(
        await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", ...surface.args], {
          cwd: repo,
          stdout: (text) => {
            stdout += text
          },
          stderr: (text) => {
            stderr += text
          },
        }),
        `${surface.args.join(" ")}: ${stderr}`,
      ).toBe(0)
      expect(JSON.parse(stdout), surface.args.join(" ")).toMatchObject({ command: surface.command })
      expect(stderr).toBe("")
    }

    expect(await Bun.file(join(repo, ".git", "yrd", "events-v3.jsonl")).exists()).toBe(false)
  })

  it("teaches exact inspect-and-resubmit guidance for a rejected direct-branch PR without appending", async () => {
    const { repo } = await repository()
    await writeFile(join(repo, ".yrd.yml"), 'base: main\nbatch: 1\nsteps: [check, merge]\ncheck: "false"\nmerge: {}\n')
    await git(repo, "switch", "-q", "issue/feature")
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "pr", "submit", "--base", "main", "--json"], {
        cwd: repo,
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    ).toBe(0)
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "queue", "run", "PR1", "--json"], {
        cwd: repo,
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    ).toBe(1)

    const journal = join(repo, ".git", "yrd", "events-v3.jsonl")
    const before = await readFile(journal, "utf8")
    let refusal = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "pr", "merge", "PR1", "--json"], {
        cwd: repo,
        stdout: () => undefined,
        stderr: (text) => {
          refusal += text
        },
      }),
    ).toBe(1)
    const rejected = JSON.parse(refusal) as Readonly<{
      guidance: Readonly<{ inspect: string; resubmit: string }>
    }>
    expect(rejected).toMatchObject({
      command: "pr.merge",
      status: "rejected",
      next: "yrd pr runs PR1",
    })
    expect(rejected.guidance).toEqual({
      inspect: "yrd pr runs PR1",
      resubmit: "fix the branch and run yrd pr submit again",
    })
    expect(await readFile(journal, "utf8")).toBe(before)
  })

  it("starts a fresh v3 journal without reading or rewriting legacy journal files", async () => {
    const { repo } = await repository()
    const oldYrdJournal = join(repo, ".git", "yrd", "events.jsonl")
    const oldBayJournal = join(repo, ".git", "bay", "journal.jsonl")
    await mkdir(join(repo, ".git", "yrd"), { recursive: true })
    await mkdir(join(repo, ".git", "bay"), { recursive: true })
    await writeFile(oldYrdJournal, "old yrd journal remains opaque\n")
    await writeFile(oldBayJournal, "old bay journal remains opaque\n")

    await using host = await createYrdHost({ cwd: repo })
    expect(host.services.recut).toBeDefined()
    const headSha = await git(repo, "rev-parse", "issue/feature")
    await host.app.bays.submit({ branch: "issue/feature", headSha, base: "main" })

    expect(await Bun.file(join(repo, ".git", "yrd", "events-v3.jsonl")).exists()).toBe(true)
    expect(await readFile(oldYrdJournal, "utf8")).toBe("old yrd journal remains opaque\n")
    expect(await readFile(oldBayJournal, "utf8")).toBe("old bay journal remains opaque\n")
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

  it("drains the active run on the first watch signal without admitting another", async () => {
    const { repo, featureSha } = await repository()
    const startedPath = join(repo, "drain-check.started")
    const finishedPath = join(repo, "drain-check.finished")
    const command = [`touch ${JSON.stringify(startedPath)}`, "sleep 0.2", `touch ${JSON.stringify(finishedPath)}`].join(
      "; ",
    )
    await writeFile(
      join(repo, ".yrd.yml"),
      `base: main\nbatch: 1\nsteps: [check]\ncheck:\n  run: ${JSON.stringify(command)}\n  timeoutMs: 5000\n`,
    )
    await git(repo, "switch", "-qc", "issue/second", "main")
    await writeFile(join(repo, "second.txt"), "second\n")
    await git(repo, "add", "second.txt")
    await git(repo, "commit", "-qm", "second")
    const secondSha = await git(repo, "rev-parse", "HEAD")
    await git(repo, "switch", "-q", "main")

    await using submitter = await createYrdHost({ cwd: repo })
    await submitter.app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
    await submitter.app.bays.submit({ branch: "issue/second", headSha: secondSha, base: "main" })
    await submitter.close()

    const cli = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dirname, "../../../bin/yrd.ts"),
        "queue",
        "run",
        "--watch",
        "--interval",
        "1",
        "--json",
      ],
      { cwd: repo, stdout: "pipe", stderr: "pipe" },
    )
    const stdout = new Response(cli.stdout).text()
    const stderr = new Response(cli.stderr).text()
    try {
      await vi.waitFor(async () => expect(await Bun.file(startedPath).exists()).toBe(true), { timeout: 5_000 })
      cli.kill("SIGTERM")
      await vi.waitFor(async () => expect(await Bun.file(finishedPath).exists()).toBe(true), { timeout: 5_000 })
      expect(await cli.exited, await stderr).toBe(0)

      await using settled = await createYrdHost({ cwd: repo })
      expect(Object.keys(settled.app.state().queues.records)).toEqual(["R1"])
      expect(settled.app.queue.get("R1")?.status).toBe("passed")
    } finally {
      cli.kill("SIGKILL")
      await cli.exited
      await stdout
      await stderr
    }
  })

  it("refuses a second resident watch with the active executor identity", async () => {
    const { repo, featureSha } = await repository()
    const startedPath = join(repo, "resident-check.started")
    const executionsPath = join(repo, "resident-check.executions")
    const command = [
      `printf 'run\\n' >> ${JSON.stringify(executionsPath)}`,
      `touch ${JSON.stringify(startedPath)}`,
      "sleep 2",
    ].join("; ")
    await writeFile(
      join(repo, ".yrd.yml"),
      `steps: [check]\ncheck:\n  run: ${JSON.stringify(command)}\n  timeoutMs: 5000\n`,
    )
    await git(repo, "switch", "-qc", "issue/second", "main")
    await writeFile(join(repo, "second.txt"), "second\n")
    await git(repo, "add", "second.txt")
    await git(repo, "commit", "-qm", "second")
    const secondSha = await git(repo, "rev-parse", "HEAD")
    await git(repo, "switch", "-q", "main")
    await using submitter = await createYrdHost({ cwd: repo })
    await submitter.app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
    await submitter.app.bays.submit({ branch: "issue/second", headSha: secondSha, base: "main" })
    await submitter.close()
    const spawnWatch = (selector: string, pane: string) => {
      const logPath = join(repo, `resident-${pane.replace(/[^a-z0-9]+/giu, "-")}.log`)
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dirname, "../../../bin/yrd.ts"),
          "queue",
          "run",
          selector,
          "--watch",
          "--interval",
          "1",
          "--json",
        ],
        {
          cwd: repo,
          env: {
            ...process.env,
            HERDR_PANE_ID: pane,
            LOGGILY_FILE: logPath,
            LOG_LEVEL: "trace",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      return { child, logPath, stdout: new Response(child.stdout).text(), stderr: new Response(child.stderr).text() }
    }
    const first = spawnWatch("PR1", "w1:p1")
    let second: ReturnType<typeof spawnWatch> | undefined
    let replacement: ReturnType<typeof spawnWatch> | undefined
    try {
      await vi.waitFor(async () => expect(await Bun.file(startedPath).exists()).toBe(true), {
        timeout: 5_000,
      })
      second = spawnWatch("PR2", "w1:p2")

      const outcome = await Promise.race([
        second.child.exited.then((exitCode) => ({ exitCode })),
        Bun.sleep(1_000).then(() => ({ exitCode: "still-running" as const })),
      ])
      expect(outcome).toEqual({ exitCode: 1 })
      expect(await second.stderr).toContain(`resident-runner-active: writer lock is busy (yrd-cli:${first.child.pid}`)
      expect((await readFile(executionsPath, "utf8")).trim().split("\n")).toEqual(["run"])
      await expect(first.child.exited).resolves.toBe(0)

      replacement = spawnWatch("PR2", "w1:p3")
      await expect(replacement.child.exited).resolves.toBe(0)
      expect((await readFile(executionsPath, "utf8")).trim().split("\n")).toEqual(["run", "run"])

      await using settled = await createYrdHost({ cwd: repo })
      const runIds = Object.keys(settled.app.state().queues.records)
      expect(runIds).toEqual(["R1", "R2"])
      expect(runIds.map((id) => settled.app.queue.get(id)?.status)).toEqual(["passed", "passed"])
      expect(
        runIds.map((id) => {
          const job = settled.app.queue.get(id)?.steps[0]?.job
          return job !== undefined && "runner" in job ? job.runner : undefined
        }),
      ).toEqual([`yrd-cli:${first.child.pid}`, `yrd-cli:${replacement.child.pid}`])

      const firstLog = await readFile(first.logPath, "utf8")
      expect(firstLog).toMatch(new RegExp(`yrd-cli:${first.child.pid}.*w1:p1|w1:p1.*yrd-cli:${first.child.pid}`, "u"))
      expect(firstLog).toContain("pre-worktree")
      expect(await readFile(replacement.logPath, "utf8")).toMatch(
        new RegExp(`yrd-cli:${replacement.child.pid}.*w1:p3|w1:p3.*yrd-cli:${replacement.child.pid}`, "u"),
      )
    } finally {
      replacement?.child.kill("SIGKILL")
      second?.child.kill("SIGKILL")
      first.child.kill("SIGKILL")
      await replacement?.child.exited
      await second?.child.exited
      await first.child.exited
      await replacement?.stdout
      await replacement?.stderr
      await second?.stdout
      await second?.stderr
      await first.stdout
      await first.stderr
    }
  })

  it("replaces a dead resident owner after the OS releases its lease", async () => {
    const { repo } = await repository()
    await writeFile(join(repo, ".yrd.yml"), 'steps: [check]\ncheck:\n  run: "true"\n')
    const argv = [
      process.execPath,
      join(import.meta.dirname, "../../../bin/yrd.ts"),
      "queue",
      "run",
      "--watch",
      "--interval",
      "1",
      "--json",
    ]
    const spawnWatch = () => Bun.spawn(argv, { cwd: repo, stdout: "pipe", stderr: "pipe" })
    const lockPath = join(repo, ".git", "yrd", "resident-runner", "writer.lock")
    const first = spawnWatch()
    const firstStdout = new Response(first.stdout).text()
    const firstStderr = new Response(first.stderr).text()
    let replacement: ReturnType<typeof spawnWatch> | undefined
    let replacementStdout: Promise<string> | undefined
    let replacementStderr: Promise<string> | undefined
    try {
      await vi.waitFor(async () => {
        expect(await Bun.file(lockPath).exists()).toBe(true)
        expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ pid: first.pid })
      })
      first.kill("SIGKILL")
      await first.exited

      replacement = spawnWatch()
      replacementStdout = new Response(replacement.stdout).text()
      replacementStderr = new Response(replacement.stderr).text()
      await vi.waitFor(async () => {
        expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ pid: replacement?.pid })
      })
      replacement.kill("SIGKILL")
      await replacement.exited
    } finally {
      replacement?.kill("SIGKILL")
      first.kill("SIGKILL")
      await replacement?.exited
      await first.exited
      await replacementStdout
      await replacementStderr
      await firstStdout
      await firstStderr
    }
  })

  it("keeps watch resident after a failed run and drains the next run with its own result", async () => {
    const { repo, featureSha } = await repository()
    const startedPath = join(repo, "second-check.started")
    const finishedPath = join(repo, "second-check.finished")
    const command = [
      "if test -f feature.txt; then exit 7; fi",
      `touch ${JSON.stringify(startedPath)}`,
      "sleep 0.2",
      `touch ${JSON.stringify(finishedPath)}`,
    ].join("; ")
    await writeFile(
      join(repo, ".yrd.yml"),
      `base: main\nbatch: 1\nsteps: [check]\ncheck:\n  run: ${JSON.stringify(command)}\n  timeoutMs: 5000\n`,
    )
    await git(repo, "switch", "-qc", "issue/second", "main")
    await writeFile(join(repo, "second.txt"), "second\n")
    await git(repo, "add", "second.txt")
    await git(repo, "commit", "-qm", "second")
    const secondSha = await git(repo, "rev-parse", "HEAD")
    await git(repo, "switch", "-q", "main")

    await using submitter = await createYrdHost({ cwd: repo })
    await submitter.app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
    await submitter.app.bays.submit({ branch: "issue/second", headSha: secondSha, base: "main" })
    await submitter.close()

    const cli = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dirname, "../../../bin/yrd.ts"),
        "queue",
        "run",
        "--watch",
        "--interval",
        "1",
        "--json",
      ],
      { cwd: repo, stdout: "pipe", stderr: "pipe" },
    )
    const stdout = new Response(cli.stdout).text()
    const stderr = new Response(cli.stderr).text()
    try {
      await vi.waitFor(async () => expect(await Bun.file(startedPath).exists()).toBe(true), { timeout: 5_000 })
      cli.kill("SIGTERM")
      await vi.waitFor(async () => expect(await Bun.file(finishedPath).exists()).toBe(true), { timeout: 5_000 })
      expect(await cli.exited, await stderr).toBe(0)

      await using settled = await createYrdHost({ cwd: repo })
      const runIds = Object.keys(settled.app.state().queues.records)
      expect(runIds).toEqual(["R1", "R2"])
      expect(runIds.map((id) => settled.app.queue.get(id)?.status)).toEqual(["failed", "passed"])
    } finally {
      cli.kill("SIGKILL")
      await cli.exited
      await stdout
      await stderr
    }
  })

  it("reaps an active configured child before SIGINT releases its runner lease", async () => {
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
      `steps: [check, merge]\ncheck:\n  run: ${JSON.stringify(command)}\n  timeoutMs: 30000\n`,
    )

    await using submitter = await createYrdHost({ cwd: repo })
    await submitter.app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
    await submitter.close()

    const cli = Bun.spawn(
      [process.execPath, join(import.meta.dirname, "../../../bin/yrd.ts"), "queue", "run", "PR1", "--json"],
      { cwd: repo, stdout: "pipe", stderr: "pipe" },
    )
    const cliStdout = new Response(cli.stdout).text()
    const cliStderr = new Response(cli.stderr).text()
    let childPid: number | undefined
    let grandchildPid: number | undefined
    let cleanupError: unknown
    try {
      await vi.waitFor(async () => expect(await Bun.file(childPidPath).exists()).toBe(true), { timeout: 5_000 })
      childPid = Number.parseInt((await readFile(childPidPath, "utf8")).trim(), 10)
      expect(Number.isSafeInteger(childPid)).toBe(true)
      await vi.waitFor(async () => expect(await Bun.file(grandchildPidPath).exists()).toBe(true), { timeout: 5_000 })
      grandchildPid = Number.parseInt((await readFile(grandchildPidPath, "utf8")).trim(), 10)
      expect(Number.isSafeInteger(grandchildPid)).toBe(true)
      await vi.waitFor(async () => expect((await readFile(progressPath, "utf8")).trim()).not.toBe(""), {
        timeout: 5_000,
      })

      cli.kill("SIGINT")
      await expect(cli.exited).resolves.toBe(130)
      await vi.waitFor(() => expect(processExists(childPid!)).toBe(false), { timeout: 5_000 })
      await vi.waitFor(() => expect(processExists(grandchildPid!)).toBe(false), { timeout: 5_000 })

      await using recovery = await createYrdHost({ cwd: repo })
      const recovered = await recovery.app.queue.recover({
        recoveryTime: "2100-01-01T00:00:00.000Z",
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
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") cleanupError ??= error
        }
      }
      if (grandchildPid !== undefined && processExists(grandchildPid)) {
        try {
          process.kill(grandchildPid, "SIGKILL")
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") cleanupError ??= error
        }
      }
      cli.kill("SIGKILL")
      await cli.exited
    }
    if (cleanupError !== undefined) throw cleanupError
  }, 30_000)

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
    await git(repo, "worktree", "add", "-q", linked, "issue/feature")

    let stdout = ""
    let stderr = ""
    expect(
      await runYrdProcess(
        [
          "/usr/bin/bun",
          "/usr/local/bin/yrd",
          "bay",
          "submit",
          "--base",
          "main",
          "--issue",
          "github:beorn/yrd#42",
          "--json",
        ],
        {
          cwd: linked,
          stdout: (text) => {
            stdout += text
          },
          stderr: (text) => {
            stderr += text
          },
        },
      ),
      stderr,
    ).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({
      prs: [
        {
          branch: "issue/feature",
          headSha: featureSha,
          base: "main",
          issue: "github:beorn/yrd#42",
          status: "submitted",
        },
      ],
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

  it("selects one repository authority and operation root outside Git", async () => {
    const { repo } = await repository()
    const linked = join(repo, "..", "selected-repo")
    const ambient = join(repo, "..", "ambient")
    await git(repo, "worktree", "add", "-q", linked, "issue/feature")
    await writeFile(join(linked, "selected-only.txt"), "selected repository\n")
    await git(linked, "add", "selected-only.txt")
    await git(linked, "commit", "-qm", "make selected revision unique")
    const featureSha = await git(linked, "rev-parse", "HEAD")
    await mkdir(ambient)
    const checkCwd = join(repo, "check-cwd.txt")
    await writeFile(
      join(repo, ".yrd.yml"),
      `base: main\nsteps: [check]\ncheck: ${JSON.stringify(`pwd > ${JSON.stringify(checkCwd)}`)}\n`,
    )

    const wrong = await repository()
    await writeFile(join(wrong.repo, ".yrd.yml"), "steps: definitely-not-an-array\n")
    await git(wrong.repo, "switch", "-q", "issue/feature")
    await writeFile(join(wrong.repo, "wrong-only.txt"), "wrong repository\n")
    await git(wrong.repo, "add", "wrong-only.txt")
    await git(wrong.repo, "commit", "-qm", "diverge wrong repository")
    await git(wrong.repo, "switch", "-q", "main")
    const relativeRepo = relative(ambient, linked)
    const yrdBin = join(import.meta.dirname, "../../../bin/yrd.ts")
    const gitBayBin = join(import.meta.dirname, "../../../bin/git-bay")
    const run = async (args: readonly string[], env: NodeJS.ProcessEnv = process.env, executable = yrdBin) => {
      const child = Bun.spawn([process.execPath, executable, ...args], {
        cwd: ambient,
        env: { ...env, NO_COLOR: "1" },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      return { stdout, stderr, exitCode }
    }

    const poisoned = {
      ...process.env,
      YRD_REPO: wrong.repo,
      GIT_DIR: join(wrong.repo, ".git"),
      GIT_WORK_TREE: wrong.repo,
    }
    const selected = await run(["submit", "--repo", relativeRepo, "--json"], poisoned, gitBayBin)
    expect(selected.exitCode, selected.stderr).toBe(0)
    expect(JSON.parse(selected.stdout)).toMatchObject({
      command: "bay.submit",
      prs: [{ id: "PR1", branch: "issue/feature", headSha: featureSha }],
    })
    expect(selected.stderr).toBe("")

    const diff = await run(["pr", "diff", "PR1", "--repo", relativeRepo, "--json"], poisoned)
    expect(diff.exitCode, diff.stderr).toBe(0)
    expect(JSON.parse(diff.stdout)).toMatchObject({ command: "pr.diff", pr: "PR1" })
    expect(JSON.parse(diff.stdout).diff).toContain("feature.txt")
    expect(diff.stderr).toBe("")

    const submitted = await run(["pr", "submit", "--follow", "--repo", relativeRepo, "--json"])
    expect(submitted.exitCode, submitted.stderr).toBe(0)
    expect(JSON.parse(submitted.stdout)).toMatchObject({
      command: "pr.submit",
      prs: [{ id: "PR1", branch: "issue/feature", headSha: featureSha }],
    })
    expect(submitted.stderr).toBe("")

    const status = await run(["pr", "status", "--json"], { ...process.env, YRD_REPO: relativeRepo })
    expect(status.exitCode, status.stderr).toBe(0)
    expect(JSON.parse(status.stdout)).toMatchObject({
      command: "pr.status",
      pr: { id: "PR1", branch: "issue/feature" },
    })
    expect(status.stderr).toBe("")

    const managedCwd = (await readFile(checkCwd, "utf8")).trim()
    expect(managedCwd.startsWith(`${join(repo, ".bays")}/`)).toBe(true)
    expect(managedCwd).not.toBe(ambient)
    expect(managedCwd).not.toBe(linked)
  })

  it("submits and lands one composed source packet through the public CLI", async () => {
    const { repo, oldPinSha, newPinSha, sourceTipSha, rootBaseSha } = await compositionRepository()
    const manifest = join(repo, "..", "composition.json")
    await writeFile(
      manifest,
      JSON.stringify({
        version: 1,
        sources: [
          {
            repo: "dep",
            branch: "issue/source",
            baseSha: oldPinSha,
            tipSha: sourceTipSha,
            payload: ["src/candidate.ts"],
          },
        ],
      }),
    )
    let submitStdout = ""
    let submitStderr = ""
    expect(
      await runYrdProcess(
        [
          "/usr/bin/bun",
          "/usr/local/bin/yrd",
          "bay",
          "submit",
          "issue/source",
          "--base",
          "main",
          "--composition",
          manifest,
          "--json",
        ],
        {
          cwd: repo,
          stdout: (text) => {
            submitStdout += text
          },
          stderr: (text) => {
            submitStderr += text
          },
        },
      ),
      submitStderr,
    ).toBe(0)
    expect(JSON.parse(submitStdout)).toMatchObject({
      prs: [{ id: "PR1", composition: { sources: [{ repo: "dep", tipSha: sourceTipSha }] } }],
    })
    await rm(manifest)

    let diffStdout = ""
    let diffStderr = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "pr", "diff", "PR1"], {
        cwd: repo,
        stdout: (text) => {
          diffStdout += text
        },
        stderr: (text) => {
          diffStderr += text
        },
      }),
      diffStderr,
    ).toBe(0)
    expect(diffStdout).toContain("Source composition")
    expect(diffStdout).toContain("dep issue/source")
    expect(diffStdout).toContain("src/candidate.ts")

    let runStdout = ""
    let runStderr = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "queue", "run", "PR1", "--json"], {
        cwd: repo,
        stdout: (text) => {
          runStdout += text
        },
        stderr: (text) => {
          runStderr += text
        },
      }),
      runStderr,
    ).toBe(0)
    const result = z
      .object({ results: z.array(z.object({ status: z.string(), integration: IntegrationProofSchema }).passthrough()) })
      .parse(JSON.parse(runStdout)).results[0]
    if (result === undefined) throw new Error("expected one composed Queue result")
    expect(result).toMatchObject({
      status: "passed",
      integration: {
        commit: expect.stringMatching(/^[0-9a-f]{40}$/u),
        sourceRewrites: [
          {
            repo: "dep",
            oldBaseSha: oldPinSha,
            oldTipSha: sourceTipSha,
            newBaseSha: newPinSha,
            newTipSha: expect.stringMatching(/^[0-9a-f]{40}$/u),
            patchId: expect.stringMatching(/^[0-9a-f]{40}$/u),
            rangeDiff: "=",
            payload: ["src/candidate.ts"],
          },
        ],
      },
    })
    const candidateSha = result.integration.commit
    const landedPinSha = result.integration.sourceRewrites?.[0]?.newTipSha
    if (landedPinSha === undefined) throw new Error("expected one source rewrite receipt")
    expect(await git(repo, "rev-parse", "main")).toBe(candidateSha)
    expect(await git(repo, "rev-parse", "main^")).toBe(rootBaseSha)
    expect(await git(join(repo, "dep"), "rev-parse", "HEAD")).toBe(landedPinSha)
    expect(await git(repo, "status", "--porcelain")).toBe("")
  })

  it("reports a failed queue against origin when the operator HEAD is detached", async () => {
    const { repo, featureSha } = await repository()
    await writeFile(
      join(repo, ".yrd.yml"),
      "steps: [check, merge]\ncheck: printf 'real stdout\\n'; printf 'real stderr\\n' >&2; exit 7\n",
    )
    const baseSha = await git(repo, "rev-parse", "main")
    const first = await createYrdHost({ cwd: repo })
    await first.app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
    const run = (await first.app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 }))[0]!
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
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "_dashboard"], {
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
    expect(stdout).toMatch(/PR1\s+issue\/feature\s+rejected/u)
    expect(stdout).not.toContain(featureSha.slice(0, 12))
    expect(stderr).toBe("")

    stdout = ""
    stderr = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "_dashboard"], {
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
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "pr", "runs", "PR1"], {
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
        await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "log", "--json"], {
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

  it("replays the live PR25 finish-before-later-submit journal shape through bare yrd", async () => {
    const { repo, featureSha } = await repository()
    await writeFile(join(repo, ".yrd.yml"), "steps: [check]\ncheck: exit 7\n")

    const host = await createYrdHost({ cwd: repo })
    try {
      await host.app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
      const prior = (await host.app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 }))[0]!
      expect(prior.status).toBe("failed")
      if (prior.finishedAt === undefined) throw new Error("missing prior revision finish time")

      await git(repo, "switch", "-q", "issue/feature")
      await writeFile(join(repo, "follow-up.txt"), "follow-up\n")
      await git(repo, "add", "follow-up.txt")
      await git(repo, "commit", "-qm", "follow-up")
      const nextHead = await git(repo, "rev-parse", "HEAD")
      await git(repo, "switch", "-q", "main")

      await host.app.bays.intake({ branch: "issue/feature", headSha: nextHead, base: "main" })
      await host.app.bays.ready({ pr: "PR1" })
      const currentSubmittedAt = host.app.state().bays.prs.PR1?.submittedAt
      if (currentSubmittedAt === undefined) throw new Error("missing current revision submission time")
      expect(Date.parse(prior.finishedAt)).toBeLessThan(Date.parse(currentSubmittedAt))

      const current = (await host.app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 }))[0]!
      expect(current.status).toBe("failed")
    } finally {
      await host.close()
    }

    const journalPath = join(repo, ".git", "yrd", "events-v3.jsonl")
    const journalBefore = await readFile(journalPath)
    const cli = Bun.spawn([process.execPath, join(import.meta.dirname, "../../../bin/yrd.ts"), "_dashboard"], {
      cwd: repo,
      env: { ...process.env, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(cli.stdout).text(),
      new Response(cli.stderr).text(),
      cli.exited,
    ])

    expect(exitCode, stderr).toBe(0)
    expect(stderr).toBe("")
    expect(stdout).toContain("Recent failures")
    expect(stdout.match(/PR1/gu)).toHaveLength(2)
    expect(`${stdout}\n${stderr}`).not.toMatch(/precedes/u)
    expect(await readFile(journalPath)).toEqual(journalBefore)
  })

  it("renders clickable candidate-conflict evidence written by the real Git check adapter", async () => {
    const { repo } = await repository()
    await writeFile(join(repo, "conflict.txt"), "main\n")
    await git(repo, "add", "conflict.txt")
    await git(repo, "commit", "-qm", "main conflict")
    await git(repo, "switch", "-q", "issue/feature")
    await writeFile(join(repo, "conflict.txt"), "feature\n")
    await git(repo, "add", "conflict.txt")
    await git(repo, "commit", "-qm", "feature conflict")
    const featureSha = await git(repo, "rev-parse", "HEAD")
    await git(repo, "switch", "-q", "main")
    await writeFile(join(repo, ".yrd.yml"), 'steps: [check, merge]\ncheck:\n  run: "true"\n')

    const host = await createYrdHost({ cwd: repo })
    let artifact: string | undefined
    try {
      await host.app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
      const run = (await host.app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 }))[0]!
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
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "_dashboard"], {
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
    expect(artifact === undefined ? stdout : stdout).toContain(
      artifact === undefined ? "candidate-conflict" : pathToFileURL(artifact).href,
    )
  })

  it("reports the authoritative remote queue head when local main is stale", async () => {
    const { repo, featureSha } = await repository()
    const localSha = await git(repo, "rev-parse", "main")
    const remote = join(repo, "..", "origin.git")
    await git(repo, "init", "-q", "--bare", remote)
    await git(repo, "remote", "add", "origin", remote)
    await git(repo, "push", "-q", "origin", "main", "issue/feature")
    await git(repo, "push", "-q", "origin", `${featureSha}:refs/heads/main`)
    await git(repo, "fetch", "-q", "origin", "main:refs/remotes/origin/main")
    expect(await git(repo, "rev-parse", "main")).toBe(localSha)

    let stdout = ""
    let stderr = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "--json"], {
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
    await git(repo, "worktree", "add", "-qb", "issue/bay", linked)

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
    await git(repo, "worktree", "add", "-qb", "issue/linked", linked)
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
