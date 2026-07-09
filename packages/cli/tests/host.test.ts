import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createMemoryEventStore } from "@yrd/core"
import { createDefaultYrdApp, createYrdHost } from "../src/host.ts"
import type { ResolvedYrdProjectConfig } from "../src/config.ts"

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

describe("createDefaultYrdApp", () => {
  it("composes the final plugin stack and integrates through configured typed steps", async () => {
    const { repo, featureSha } = await repository()
    const config: ResolvedYrdProjectConfig = {
      version: 1,
      line: { base: "main", batch: 1, steps: ["check", "merge"] },
      steps: {
        check: { run: "test -f feature.txt", runner: "local" },
        merge: { runner: "local" },
      },
      contest: { concurrency: 2, timeoutMs: 60_000, evaluators: ["check"] },
    }
    const app = createDefaultYrdApp({
      repo,
      stateDir: join(repo, ".git", "yrd"),
      baysRoot: join(repo, ".bays"),
      store: createMemoryEventStore(),
      config,
    })

    expect((await app.state()).lines).toMatchObject({
      batchSize: 1,
      defaultSteps: ["check", "merge"],
      installed: {
        check: { index: 0, kind: "step" },
        review: { index: 1, kind: "step" },
        merge: { index: 2, kind: "merge" },
        deploy: { index: 3, kind: "step", needsIntegration: true },
      },
    })
    expect(
      app.commandRegistry
        .entries()
        .filter((entry) => entry.command.visibility === "public")
        .map((entry) => entry.path.join(".")),
    ).toEqual([
      "bay.open",
      "bay.refresh",
      "bay.submit",
      "bay.close",
      "line.integrate",
      "task.compete",
      "contest.select",
      "contest.promote",
    ])

    await app.command(app.commands.bay.submit, { branch: "task/feature", headSha: featureSha, base: "main" })
    const run = await app.line.integrate({ submission: "S1" }, { executor: "test", leaseMs: 60_000 })
    expect(run).toMatchObject({ status: "passed", selected: ["check", "merge"] })
    expect(await git(repo, "merge-base", "--is-ancestor", featureSha, "main")).toBe("")
    await app.close()
  })

  it("refuses data config that names a transition the built-in plugin did not install", async () => {
    const { repo } = await repository()
    const config: ResolvedYrdProjectConfig = {
      version: 1,
      line: { base: "main", batch: 1, steps: ["security"] },
      steps: { security: { run: "security-check", runner: "local" } },
      contest: { concurrency: 2, timeoutMs: 60_000, evaluators: ["security"] },
    }

    expect(() =>
      createDefaultYrdApp({
        repo,
        stateDir: join(repo, ".git", "yrd"),
        baysRoot: join(repo, ".bays"),
        store: createMemoryEventStore(),
        config,
      }),
    ).toThrow("step 'security' requires a custom withStep() composition")
  })
})

describe("createYrdHost", () => {
  it("initializes one filesystem authority and reopens it without a transition path", async () => {
    const { repo } = await repository()
    const first = await createYrdHost({ cwd: repo })

    expect(first.repository).toMatchObject({ repo, stateDir: join(repo, ".git", "yrd") })
    expect(first.receiver.receiverPath).toBe(join(repo, ".git", "yrd", "prs.git"))
    expect(await Bun.file(join(repo, ".git", "yrd", "index.sqlite")).exists()).toBe(true)
    expect(await Bun.file(join(first.receiver.receiverPath, "hooks", "pre-receive")).exists()).toBe(true)
    const administration = first.app.line as typeof first.app.line & {
      provision(base?: string): Promise<unknown>
      deprovision(base?: string): Promise<unknown>
    }
    expect(await administration.provision()).toMatchObject({ base: "main", persistentResources: false })
    expect(await administration.deprovision()).toMatchObject({ base: "main", released: [] })
    await first.close()

    const reopened = await createYrdHost({ cwd: repo })
    expect(await reopened.app.state()).toMatchObject({ bays: { bays: {}, submissions: {} }, lines: { runs: {} } })
    await reopened.close()
  })
})
