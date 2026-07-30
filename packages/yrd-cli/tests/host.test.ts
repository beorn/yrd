/**
 * @failure The default host composes incompatible definitions, state paths, receivers, or lifecycle ownership.
 * @level l3
 * @consumer @yrd/cli host
 */
import { existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { pathToFileURL } from "node:url"
import { Database } from "bun:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { currentPRRev, prBaseSha, prDeliveryState } from "@yrd/bay"
import { createFailure, createMemoryJournal } from "@yrd/core"
import { DIAGNOSTICS_COMPARISON_READY, GitCheckEvidenceSchema, IntegrationProofSchema, Queues } from "@yrd/queue"
import { createExclusive, createJournal, createReadOnlyJournal } from "@yrd/persistence"
import { createProcess, type Process, type ProcessRequest, type ProcessResult } from "@yrd/process"
import { createLogger, type ConditionalLogger } from "loggily"
import * as z from "zod"
import {
  CURRENT_JOURNAL_COMPATIBILITY,
  createDefaultYrdApp as createDefaultYrdAppRaw,
  createYrdHost as createYrdHostRaw,
  runYrdProcess,
} from "../src/host.ts"
import { queueStepRevision } from "../src/host-revision.ts"
import {
  authoritativeImplementationSource,
  implementationSourceIdentity,
  sourceRepositoryFor,
  takeImplementationSourceBridge,
} from "../src/implementation-source.ts"
import type { ResolvedYrdProjectConfig } from "../src/config.ts"
import { classifyFailure } from "../src/invocation.ts"
import { withLiveRenderer } from "../src/live-renderer.ts"
import { discoverYrdRepository } from "../src/repository.ts"

const roots: string[] = []
const silentLog = createLogger("test", [{ level: "silent" }])
const BOUNDED_ONE_SECOND_LOOP =
  'fixture_ticks=0; while [ "$fixture_ticks" -lt 120 ]; do fixture_ticks=$((fixture_ticks + 1)); sleep 1; done'

function createDefaultYrdApp(options: Parameters<typeof createDefaultYrdAppRaw>[0]) {
  return createDefaultYrdAppRaw({ ...options, log: options.log ?? silentLog })
}

function createYrdHost(options: Parameters<typeof createYrdHostRaw>[0] = {}) {
  return createYrdHostRaw({ ...options, log: options.log ?? silentLog })
}

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

async function journalEnvelope(repo: string) {
  return Array.fromAsync(createReadOnlyJournal({ dir: join(repo, ".git", "yrd") }).read())
}

function testJournal(dir: string, log?: ConditionalLogger) {
  return createJournal({
    dir,
    writerVersion: CURRENT_JOURNAL_COMPATIBILITY.version,
    inject: { sqliteVersion: "3.53.0", ...(log === undefined ? {} : { log }) },
  } as unknown as Parameters<typeof createJournal>[0])
}

async function byteManifest(root: string): Promise<readonly string[]> {
  const entries: string[] = []
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const relativePath = prefix === "" ? entry.name : join(prefix, entry.name)
      // SQLite's shared-memory coordination bytes are volatile even for a
      // read-only WAL viewer. The DB, WAL, and every directory entry remain in
      // the byte-purity assertion; only this documented coordination file is excluded.
      if (relativePath === "journal.sqlite-shm") continue
      if (entry.isDirectory()) {
        entries.push(`directory\t${relativePath}`)
        await walk(path, relativePath)
      } else if (entry.isSymbolicLink()) {
        entries.push(`symlink\t${relativePath}\t${await readlink(path)}`)
      } else {
        const digest = createHash("sha256")
          .update(await readFile(path))
          .digest("hex")
        entries.push(`file\t${relativePath}\t${digest}`)
      }
    }
  }
  await walk(root, "")
  return entries.toSorted()
}

function journalCompatibilityYaml(): string {
  return ""
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
  await writeFile(join(repo, ".yrd.yml"), 'checks: [{check: {run: "true"}}]\n')
  await git(repo, "add", "README.md", ".yrd.yml")
  await git(repo, "commit", "-qm", "main")
  await git(repo, "switch", "-qc", "issue/feature")
  await writeFile(join(repo, "feature.txt"), "feature\n")
  await git(repo, "add", "feature.txt")
  await git(repo, "commit", "-qm", "feature")
  const featureSha = await git(repo, "rev-parse", "HEAD")
  await git(repo, "switch", "-q", "main")
  return { repo, featureSha }
}

/** Install legacy spelling on the base branch: config authority is the base,
 * never the operator worktree's uncommitted bytes (design C5). */
async function commitYrdConfig(repo: string, source: string): Promise<void> {
  await writeFile(join(repo, ".yrd.yml"), source)
  await git(repo, "add", ".yrd.yml")
  await git(repo, "commit", "-qm", "test Yrd config")
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
  await writeFile(
    join(repo, ".yrd.yml"),
    `base: main
batch: 1
checks: [{check: {run: "true"}}]
`,
  )
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

async function unpublishedSubmodulePinRepository(): Promise<{
  repo: string
  branch: string
  pin: string
}> {
  const root = await mkdtemp(join(tmpdir(), "yrd-unpublished-submodule-pin-"))
  roots.push(root)
  const moduleRemote = join(root, "module.git")
  const module = join(root, "module")
  const repo = join(root, "repo")
  const branch = "issue/unpublished-submodule-pin"

  await git(root, "init", "--bare", "-q", "-b", "main", moduleRemote)
  await git(root, "init", "-q", "-b", "main", module)
  await git(module, "config", "user.name", "Yrd Test")
  await git(module, "config", "user.email", "yrd@example.invalid")
  await git(module, "remote", "add", "origin", moduleRemote)
  await writeFile(join(module, "README.md"), "published\n")
  await git(module, "add", "README.md")
  await git(module, "commit", "-qm", "published module base")
  await git(module, "push", "-qu", "origin", "main")

  await git(root, "init", "-q", "-b", "main", repo)
  await git(repo, "config", "user.name", "Yrd Test")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await git(repo, "config", "protocol.file.allow", "always")
  await writeFile(join(repo, "README.md"), "root\n")
  await writeFile(
    join(repo, ".yrd.yml"),
    `base: main
batch: 1
checks: [{check: {run: "true"}}]
`,
  )
  await git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", moduleRemote, "dep")
  await git(repo, "add", "README.md", ".yrd.yml", ".gitmodules", "dep")
  await git(repo, "commit", "-qm", "published root base")
  await git(repo, "switch", "-qc", branch)

  await writeFile(join(repo, "dep", "local-only.txt"), "not published\n")
  await git(join(repo, "dep"), "add", "local-only.txt")
  await git(join(repo, "dep"), "commit", "-qm", "local-only submodule work")
  const pin = await git(join(repo, "dep"), "rev-parse", "HEAD")
  await git(repo, "add", "dep")
  await git(repo, "commit", "-qm", "point at local-only submodule work")
  return { repo, branch, pin }
}

describe("createDefaultYrdApp", { timeout: 20_000 }, () => {
  it("binds installed-step revisions to the host axes, not to the launcher's own version", () => {
    const toolchain = { bun: "1.3.0", node: "24.0.0", platform: "darwin", arch: "arm64" }
    const input = {
      repo: "/repo",
      stateDir: "/repo/.git/yrd",
      name: "check",
      config: { run: "bun run check", runner: "local" as const },
      timeoutMs: 60_000,
      noProgressMs: 600_000,
      toolchain,
    }
    const baseline = queueStepRevision(input)

    // The queue suite owns revision→cache-miss behavior; this host seam owns
    // the preceding fingerprint→revision identity edge.
    //
    // This assertion used to read "every toolchain fingerprint component",
    // which made 22374 a passing test rather than a caught bug: `bun` and
    // `node` name whichever binary invoked yrd, so one host with two bun
    // installs minted two permanent revision families and the resident and its
    // operators overwrote each other's baseline on every drain. Identity
    // follows what a step would actually RUN.
    for (const changed of [
      { ...toolchain, platform: "linux" },
      { ...toolchain, arch: "x64" },
    ]) {
      expect(queueStepRevision({ ...input, toolchain: changed })).not.toBe(baseline)
    }
    for (const launcher of [
      { ...toolchain, bun: "1.3.1" },
      { ...toolchain, node: "24.1.0" },
    ]) {
      expect(queueStepRevision({ ...input, toolchain: launcher })).toBe(baseline)
    }
  })

  it("stamps every default-host append with the current journal compatibility contract", async () => {
    const { repo, featureSha } = await repository()
    const journal = createMemoryJournal()
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
      journal,
      process: runtimeProcess,
      config,
    })

    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const batches = await Array.fromAsync(journal.read())
    expect(batches.flatMap(({ values }) => values)).toEqual([
      expect.objectContaining({ compatibility: CURRENT_JOURNAL_COMPATIBILITY }),
    ])
  })

  it("lets a fresh repository's first writer create the journal at its own version", async () => {
    const { repo, featureSha } = await repository()
    const stateDir = join(repo, ".git", "yrd-no-reader-floor")
    const journal = createJournal({
      dir: stateDir,
      writerVersion: CURRENT_JOURNAL_COMPATIBILITY.version,
      inject: { sqliteVersion: "3.53.0" },
    } as unknown as Parameters<typeof createJournal>[0])
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
      stateDir,
      baysRoot: join(repo, ".bays"),
      journal,
      process: runtimeProcess,
      config,
    })

    await expect(app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })).resolves.toBeDefined()
    await expect(Array.fromAsync(journal.read())).resolves.toHaveLength(1)
  })

  it("refuses the activated writer while the repository still installs the prior reader floor", async () => {
    const { repo, featureSha } = await repository()
    const stateDir = join(repo, ".git", "yrd-prior-reader-floor")
    const journal = createJournal({
      dir: stateDir,
      writerVersion: CURRENT_JOURNAL_COMPATIBILITY.version - 1,
      inject: { sqliteVersion: "3.53.0" },
    } as unknown as Parameters<typeof createJournal>[0])
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
      stateDir,
      baysRoot: join(repo, ".bays"),
      journal,
      process: runtimeProcess,
      config,
    })

    await expect(app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })).rejects.toMatchObject(
      {
        failure: {
          kind: "refusal",
          code: "journal-write-version-floor",
          message: expect.stringContaining("yrd admin journal bump 2"),
        },
      },
    )
    await expect(Array.fromAsync(journal.read())).resolves.toEqual([])
  })

  it("distinguishes loaded native source from the freshly fetched authoritative gitlink", async () => {
    const { repo } = await repository()
    const root = join(repo, "..")
    const source = join(root, "source")
    const sourceRemote = join(root, "source-origin.git")
    const rootRemote = join(root, "root-origin.git")
    await git(root, "init", "-q", "-b", "main", source)
    await git(source, "config", "user.name", "Yrd Test")
    await git(source, "config", "user.email", "yrd@example.invalid")
    await writeFile(join(source, "version.txt"), "loaded\n")
    await git(source, "add", "version.txt")
    await git(source, "commit", "-qm", "loaded source")
    const loadedSha = await git(source, "rev-parse", "HEAD")
    await git(root, "init", "-q", "--bare", sourceRemote)
    await git(source, "remote", "add", "origin", sourceRemote)
    await git(source, "push", "-q", "origin", "main")

    await git(repo, "config", "protocol.file.allow", "always")
    await git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sourceRemote, "runtime")
    await git(repo, "commit", "-qam", "add runtime source")
    await git(root, "init", "-q", "--bare", rootRemote)
    await git(repo, "remote", "add", "origin", rootRemote)
    await git(repo, "push", "-q", "origin", "main")

    await writeFile(join(repo, "runtime", "version.txt"), "authoritative\n")
    await git(join(repo, "runtime"), "commit", "-qam", "authoritative source")
    const authoritativeSha = await git(join(repo, "runtime"), "rev-parse", "HEAD")
    await git(join(repo, "runtime"), "push", "-q", "origin", "main")
    await git(repo, "add", "runtime")
    await git(repo, "commit", "-qm", "advance runtime source")
    await git(repo, "push", "-q", "origin", "main")
    await git(join(repo, "runtime"), "checkout", "-q", loadedSha)

    await using process = createProcess({ cwd: repo })
    const discovered = await discoverYrdRepository({ cwd: repo, process })

    const sourceRepository = { root: join(repo, "runtime") }
    expect(await implementationSourceIdentity(process, sourceRepository)).toBe(`git:${loadedSha}`)
    expect(
      await authoritativeImplementationSource(
        process,
        discovered.repo,
        await git(repo, "rev-parse", "main"),
        sourceRepository,
      ),
    ).toBe(`git:${authoritativeSha}`)

    await writeFile(join(repo, "runtime", "version.txt"), "dirty loaded bytes\n")
    expect(await implementationSourceIdentity(process, sourceRepository)).toMatch(/^dirty:[0-9a-f]{64}$/u)

    await writeFile(join(repo, "runtime", "version.txt"), "loaded\n")
    await writeFile(join(repo, "runtime", "untracked-runtime.ts"), "export const shadow = true\n")
    const untrackedIdentity = await implementationSourceIdentity(process, sourceRepository)
    expect(untrackedIdentity).toMatch(/^dirty:[0-9a-f]{64}$/u)
    await writeFile(join(repo, "runtime", "untracked-runtime.ts"), "export const shadow = false\n")
    expect(await implementationSourceIdentity(process, sourceRepository)).not.toBe(untrackedIdentity)
  })

  it("does not mistake an untracked installed package for the consumer repository's runtime source", async () => {
    const { repo } = await repository()
    const installedDirectory = join(repo, "node_modules", "@yrd", "cli", "src")
    const installedModule = join(installedDirectory, "host.ts")
    await mkdir(installedDirectory, { recursive: true })
    await writeFile(installedModule, "export {}\n")
    const sourceRepository = sourceRepositoryFor(pathToFileURL(installedModule).href)
    expect(sourceRepository).toBeUndefined()
  })

  it("consumes a launcher-attested implementation source for a gitless sealed runtime", () => {
    const repository = join(tmpdir(), "certified-yrd-source")
    const env = {
      YRD_WRAPPER_IMPLEMENTATION_SOURCE: `git:${"6".repeat(40)}`,
      YRD_WRAPPER_IMPLEMENTATION_REPOSITORY: repository,
      PRESERVED: "yes",
    }

    expect(takeImplementationSourceBridge(env)).toEqual({
      identity: `git:${"6".repeat(40)}`,
      repository: { root: repository },
    })
    expect(env).toEqual({ PRESERVED: "yes" })
  })

  it("threads an explicit diagnostics comparator into the installed runtime step", async () => {
    const { repo, featureSha } = await repository()
    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      steps: ["lint"],
      requires: [],
      definitions: {
        lint: {
          run: "printf 'src/shared.ts:1:1 - shared diagnostic\\n'; exit 17",
          runner: "local",
          comparison: "diagnostics",
        },
      },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["lint"] },
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

    const run = (await app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 }))[0]
    expect(run).toMatchObject({ status: "completed", conclusion: "success" })
    const job = run?.steps[0]?.job
    if (job?.status !== "completed" || job.conclusion !== "success") {
      throw new Error("diagnostics-comparison step did not pass")
    }
    expect(GitCheckEvidenceSchema.parse(job.output).comparison).toMatchObject({
      netNewDiagnostics: [],
      resolvedDiagnostics: [],
    })
  })

  it("threads strict mode into the shipping child environment and typed evidence", async () => {
    const { repo, featureSha } = await repository()
    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      steps: ["check"],
      requires: [],
      definitions: {
        check: {
          run: 'test "$YRD_GATE_MODE" = strict',
          runner: "local",
          mode: "strict",
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

    const run = (await app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 }))[0]
    expect(run).toMatchObject({ status: "completed", conclusion: "success" })
    const job = run?.steps[0]?.job
    if (job?.status !== "completed" || job.conclusion !== "success") {
      throw new Error("strict-mode step did not pass")
    }
    const evidence = GitCheckEvidenceSchema.parse(job.output)
    expect(evidence).toMatchObject({
      mode: "strict",
      certificate: {
        version: 1,
        mode: "strict",
        baseSha: expect.stringMatching(/^[0-9a-f]{40}$/u),
        candidateSha: evidence.candidateSha,
        reports: [
          {
            version: 1,
            comparator: { id: "exit-code", version: 1 },
            residual: { count: 0, hash: expect.stringMatching(/^[0-9a-f]{64}$/u) },
          },
        ],
      },
    })
  })

  it("activates projection checkpoints for the complete built-in projector stack", async () => {
    const { repo, featureSha } = await repository()
    const stateDir = join(repo, ".git", "yrd")
    const events: unknown[] = []
    const log = createLogger("test", [{ level: "trace" }, { write: (value: unknown) => events.push(value) }])
    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      steps: ["check", "merge"],
      requires: [],
      definitions: { check: { run: "true", runner: "local" }, merge: { runner: "local" } },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["check"] },
    }
    await using runtimeProcess = createProcess({ cwd: repo })
    const createApp = () =>
      createDefaultYrdApp({
        repo,
        stateDir,
        baysRoot: join(repo, ".bays"),
        journal: testJournal(stateDir, log),
        process: runtimeProcess,
        config,
        log,
      })

    try {
      const first = await createApp()
      await first.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
      await first.close()

      using database = new Database(join(stateDir, "journal.sqlite"), { readonly: true, strict: true })
      const checkpoint = database
        .query<{ cursor: number; checkpoint_json: string }, []>(
          "SELECT cursor, checkpoint_json FROM journal_snapshot WHERE singleton = 1",
        )
        .get()
      if (checkpoint === null) throw new Error("expected SQLite projection checkpoint")
      expect(JSON.parse(checkpoint.checkpoint_json)).toMatchObject({ cursor: checkpoint.cursor })

      events.length = 0
      const restored = await createApp()
      try {
        const restoredPR = restored.state().bays.prs.PR1!
        expect(restoredPR).toMatchObject({ branch: "issue/feature" })
        expect(currentPRRev(restoredPR)).toMatchObject({ head: featureSha })
        expect(events).toContainEqual(
          expect.objectContaining({
            kind: "span",
            namespace: "test:core:replay",
            props: expect.objectContaining({ fromCursor: checkpoint.cursor }),
          }),
        )
      } finally {
        await restored.close()
      }
    } finally {
      log.end()
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
    expect(Object.keys(app.commands.bay)).toEqual([
      "open",
      "refresh",
      "checkpoint",
      "orphan",
      "certifyHandoff",
      "intake",
      "submit",
      "close",
    ])
    expect(Object.keys(app.commands.pr)).toEqual([
      "close",
      "edit",
      "recut",
      "settleSuperseded",
      "ready",
      "review",
      "comment",
      "requestChecks",
      "recordAdmission",
      "requestReview",
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
    expect(run).toMatchObject({ status: "completed", conclusion: "success" })
    expect(run.steps.map((step) => step.name)).toEqual(["security", "merge", "publish"])
    expect(run.steps[0]?.job).toMatchObject({ runner: "yrd-local", context: "worktree-context:1" })
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

    const submittedPR = app.state().bays.prs.PR1!
    expect(submittedPR).toMatchObject({ base: "main" })
    expect(prBaseSha(submittedPR)).toBe(baseSha)
    await expect(
      app.bays.submit({ branch: "origin/issue/feature", headSha: featureSha, base: "main" }),
    ).rejects.toThrow("payload already recorded as PR 'PR1'")
    expect(Object.keys(app.state().bays.prs)).toEqual(["PR1"])
  })

  it("coalesces Bay base refresh without pruning a recoverable tracking carrier", async () => {
    const { repo, featureSha } = await repository()
    const remote = join(repo, "..", "origin.git")
    await git(repo, "init", "-q", "--bare", remote)
    await git(repo, "remote", "add", "origin", remote)
    await git(repo, "push", "-q", "origin", "main", "issue/feature")
    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      steps: ["check"],
      requires: [],
      definitions: { check: { run: "true", runner: "local" } },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["check"] },
    }
    const commands: string[][] = []
    await using runtimeProcess = createProcess({ cwd: repo })
    const tracedProcess = {
      run: async (request: Parameters<typeof runtimeProcess.run>[0]) => {
        commands.push([...request.argv])
        return runtimeProcess.run(request)
      },
    }
    await using app = await createDefaultYrdApp({
      repo,
      stateDir: join(repo, ".git", "yrd"),
      baysRoot: join(repo, ".bays"),
      journal: createMemoryJournal(),
      process: tracedProcess,
      config,
    })
    await app.bays.submit({
      branch: "issue/feature",
      headSha: featureSha,
      base: "main",
      issue: "@issue/feature",
      draft: true,
    })
    commands.length = 0

    const opened = await app.bays.open({
      name: "feature",
      branch: "issue/feature",
      issue: "@issue/feature",
    })
    const jobs = await app.jobs.runMany(app.jobs.requested(opened), { runner: "test", leaseMs: 60_000 })

    expect(jobs.every((job) => job.status === "completed" && job.conclusion === "success")).toBe(true)
    const remoteCommands = () =>
      commands.filter(
        (argv) =>
          argv[0] === "git" && argv[1] === "-C" && argv[2] === repo && (argv[3] === "fetch" || argv[3] === "ls-remote"),
      )
    expect(remoteCommands()).toEqual([
      expect.arrayContaining([
        "git",
        "-C",
        repo,
        "fetch",
        "--no-recurse-submodules",
        "--quiet",
        "origin",
        "+refs/heads/*:refs/remotes/origin/*",
      ]),
    ])
    expect(await git(repo, "rev-parse", "refs/remotes/origin/issue/feature")).toBe(featureSha)

    await git(repo, "switch", "-qc", "issue/recoverable")
    await writeFile(join(repo, "recoverable.txt"), "recoverable\n")
    await git(repo, "add", "recoverable.txt")
    await git(repo, "commit", "-qm", "recoverable feature")
    const recoverableSha = await git(repo, "rev-parse", "HEAD")
    await git(repo, "switch", "-q", "main")
    await git(repo, "push", "-q", "origin", "issue/recoverable")
    await app.bays.submit({
      branch: "issue/recoverable",
      headSha: recoverableSha,
      base: "main",
      issue: "@issue/recoverable",
      draft: true,
    })
    await git(repo, "push", "-q", "origin", "--delete", "issue/recoverable")
    await git(repo, "update-ref", "refs/remotes/origin/issue/recoverable", recoverableSha)
    commands.length = 0

    const recoverable = await app.bays.open({
      name: "recoverable",
      branch: "issue/recoverable",
      issue: "@issue/recoverable",
    })
    const recoverableJobs = await app.jobs.runMany(app.jobs.requested(recoverable), {
      runner: "test",
      leaseMs: 60_000,
    })

    expect(recoverableJobs.every((job) => job.status === "completed" && job.conclusion === "success")).toBe(true)
    expect(remoteCommands()).toEqual([
      expect.arrayContaining([
        "git",
        "-C",
        repo,
        "fetch",
        "--no-recurse-submodules",
        "--quiet",
        "origin",
        "+refs/heads/*:refs/remotes/origin/*",
      ]),
    ])
    expect(await git(repo, "rev-parse", "refs/remotes/origin/issue/recoverable")).toBe(recoverableSha)
  })

  it("adds one queue-authority fetch per same-base cycle instead of one per PR", async () => {
    const { repo, featureSha } = await repository()
    const addFeature = async (branch: string, file: string): Promise<string> => {
      await git(repo, "switch", "-qc", branch)
      await writeFile(join(repo, file), `${branch}\n`)
      await git(repo, "add", file)
      await git(repo, "commit", "-qm", `${branch} feature`)
      const sha = await git(repo, "rev-parse", "HEAD")
      await git(repo, "switch", "-q", "main")
      return sha
    }
    const secondSha = await addFeature("issue/second", "second.txt")
    const thirdSha = await addFeature("issue/third", "third.txt")
    const fourthSha = await addFeature("issue/fourth", "fourth.txt")

    const remote = join(repo, "..", "origin.git")
    await git(repo, "init", "-q", "--bare", remote)
    await git(repo, "remote", "add", "origin", remote)
    await git(repo, "push", "-q", "origin", "main", "issue/feature", "issue/second", "issue/third", "issue/fourth")

    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 2,
      steps: ["check"],
      requires: [],
      definitions: { check: { run: "true", runner: "local" } },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["check"] },
    }
    const commands: string[][] = []
    await using runtimeProcess = createProcess({ cwd: repo })
    const tracedProcess = {
      run: async (request: Parameters<typeof runtimeProcess.run>[0]) => {
        commands.push([...request.argv])
        return runtimeProcess.run(request)
      },
    }
    await using app = await createDefaultYrdApp({
      repo,
      stateDir: join(repo, ".git", "yrd"),
      baysRoot: join(repo, ".bays"),
      journal: createMemoryJournal(),
      process: tracedProcess,
      config,
    })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
    await app.bays.submit({ branch: "issue/second", headSha: secondSha, base: "main" })
    await app.bays.submit({ branch: "issue/third", headSha: thirdSha, base: "main" })
    await app.bays.submit({ branch: "issue/fourth", headSha: fourthSha, base: "main" })
    commands.length = 0

    const runCycle = async (prs: readonly [string, string]): Promise<void> => {
      for (const pr of prs) await app.bays.requestChecks({ pr })
      commands.length = 0
      const runs = await app.queue.run(
        { prs: [...prs] },
        { runner: "test", leaseMs: 60_000, continueAdmissions: () => false },
      )
      const rootFetches = commands.filter(
        (argv) => argv[0] === "git" && argv[1] === "-C" && argv[2] === repo && argv[3] === "fetch",
      )
      expect(runs).toEqual([])
      // Every same-base PR shares this cycle's one authoritative root refresh.
      expect(rootFetches).toHaveLength(1)
      expect(rootFetches.every((argv) => argv.includes("--no-recurse-submodules"))).toBe(true)
      commands.length = 0
    }

    await runCycle(["PR1", "PR2"])
    await runCycle(["PR3", "PR4"])
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

    expect(currentPRRev(submitted)).toMatchObject({ n: 1, head: featureSha, baseSha: remoteBaseSha })
    expect(prDeliveryState(submitted)).toBe("submitted")
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

    expect(runs).toEqual([
      expect.objectContaining({
        status: "completed",
        conclusion: "success",
        prs: [expect.objectContaining({ id: "PR1" })],
      }),
    ])
    expect(prDeliveryState(queueHost.state().bays.prs.PR1!)).toBe("integrated")
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

    expect(run).toMatchObject({
      status: "completed",
      conclusion: "success",
      integration: { commit: landing, baseSha: landing },
    })
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
  it("loads the base-authoritative reader floor and persists current versioned frames", async () => {
    const { repo, featureSha } = await repository()
    await commitYrdConfig(repo, 'base: main\nbatch: 1\nchecks: [{check: {run: "true"}}]\n')

    await using host = await createYrdHost({ cwd: repo })
    await host.app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const frames = (await journalEnvelope(repo)).flatMap(({ values }) => values)
    expect(frames).toEqual([expect.objectContaining({ compatibility: CURRENT_JOURNAL_COMPATIBILITY })])
  })

  it("boots doctor --rebuild-views through a stale Journal view registration", async () => {
    const { repo, featureSha } = await repository()
    await commitYrdConfig(repo, 'base: main\nbatch: 1\nchecks: [{check: {run: "true"}}]\n')
    {
      await using host = await createYrdHost({ cwd: repo })
      await host.app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
    }
    const stateDir = join(repo, ".git", "yrd")
    {
      using database = new Database(join(stateDir, "journal.sqlite"), { readwrite: true, strict: true })
      database.run("UPDATE journal_views SET cursor = cursor - 1")
    }
    let stdout = ""
    let stderr = ""

    await expect(
      runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "--repo", repo, "doctor", "--rebuild-views", "--json"], {
        cwd: repo,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
      }),
    ).resolves.toBe(0)
    expect(stderr).toBe("")
    const result = JSON.parse(stdout) as { rebuilt?: { cursor?: number } }
    expect(result.rebuilt?.cursor).toBeGreaterThan(0)
    {
      using database = new Database(join(stateDir, "journal.sqlite"), { readonly: true, strict: true })
      const head = Number(
        database.query<{ value: string }, []>("SELECT value FROM journal_metadata WHERE key='head_cursor'").get()
          ?.value,
      )
      expect(
        database
          .query<{ cursor: number }, []>("SELECT cursor FROM journal_views WHERE view_id='yrd.queue-attempts'")
          .get()?.cursor,
      ).toBe(head)
    }
  })

  it("runs the literal queue watch through the read-only viewer", async () => {
    const { repo } = await repository()
    await commitYrdConfig(
      repo,
      `base: main
checks: [{check: {run: "true"}}]
`,
    )
    let mounted = false
    let stderr = ""
    const io = withLiveRenderer(
      {
        cwd: repo,
        stdout: () => undefined,
        stderr: (text) => {
          stderr += text
        },
      },
      async () => {
        mounted = true
      },
    )
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "--repo", repo, "queue", "watch"], io),
      stderr,
    ).toBe(0)

    expect(mounted).toBe(true)
  })

  it("runs the literal PR-list through the read-only viewer", async () => {
    const { repo } = await repository()
    await commitYrdConfig(
      repo,
      `base: main
checks: [{check: {run: "true"}}]
`,
    )
    const stateDir = join(repo, ".git", "yrd")
    const configBefore = await git(repo, "config", "--local", "--list")
    const refsBefore = await git(repo, "for-each-ref", "--format=%(refname)%09%(objectname)")
    expect(existsSync(stateDir)).toBe(false)
    let stdout = ""
    let stderr = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "--repo", repo, "pr", "list", "--json"], {
        cwd: repo,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
      }),
      stderr,
    ).toBe(0)

    expect(JSON.parse(stdout)).toMatchObject({ command: "pr.list", prs: [] })
    expect(await Bun.file(join(repo, ".git", "yrd", "prs.git", "HEAD")).exists()).toBe(false)
    expect(await Bun.file(join(repo, ".git", "yrd", "receiver-inbox")).exists()).toBe(false)
    expect(existsSync(stateDir)).toBe(false)
    expect(await git(repo, "config", "--local", "--list")).toBe(configBefore)
    expect(await git(repo, "for-each-ref", "--format=%(refname)%09%(objectname)")).toBe(refsBefore)
  })

  it("preserves every Yrd state byte while listing a populated PR journal", async () => {
    const { repo, featureSha } = await repository()
    await commitYrdConfig(
      repo,
      `base: main
checks: [{check: {run: "true"}}]
`,
    )
    await using seeded = await createYrdHost({ cwd: repo })
    await seeded.app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
    await seeded.close()

    const stateDir = join(repo, ".git", "yrd")
    const stateBefore = await byteManifest(stateDir)
    const configBefore = await git(repo, "config", "--local", "--list")
    const refsBefore = await git(repo, "for-each-ref", "--format=%(refname)%09%(objectname)")
    let stdout = ""
    let stderr = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "--repo", repo, "pr", "list", "--json"], {
        cwd: repo,
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
      command: "pr.list",
      prs: [
        expect.objectContaining({
          branch: "issue/feature",
          revs: [expect.objectContaining({ head: featureSha })],
        }),
      ],
    })
    expect(await byteManifest(stateDir)).toEqual(stateBefore)
    expect(await git(repo, "config", "--local", "--list")).toBe(configBefore)
    expect(await git(repo, "for-each-ref", "--format=%(refname)%09%(objectname)")).toBe(refsBefore)
  })

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
      expect((failure as Error).message).toContain(
        `writer lock is busy (owner=yrd-cli:${process.pid}; contender=yrd-cli:${process.pid}; ${join(root, "writer.lock")})`,
      )
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
    expect(stdout).toContain("--config <path>")
    expect(stdout).toContain("YRD_REPO")
    expect(stdout).not.toContain("--cwd")
    expect(stdout).not.toContain("YRD_CWD")
    expect(stdout).not.toContain("--root")
    const commandBlock = stdout.match(/Commands:\n(?<commands>[\s\S]*?)\n\nModel:/u)?.groups?.commands ?? ""
    expect(
      commandBlock
        .split("\n")
        .flatMap(
          (text) => text.match(/^\s{2}(?<command>[a-z]+)(?:\s+(?:\[[^\]]+\]|<[^>]+>))*\s{2,}/u)?.groups?.command ?? [],
        ),
    ).toEqual([
      "pr",
      "bay",
      "issue",
      "contest",
      "queue",
      "check",
      "doctor",
      "admin",
      "migrate",
      "log",
      "watch",
      "prime",
      "in",
      "sh",
      "run",
    ])
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

  it("keeps runtime bootstrap failures structured when JSON is requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "yrd-json-bootstrap-failure-"))
    roots.push(root)
    let stdout = ""
    let stderr = ""

    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "--repo", root, "pr", "list", "--json"], {
        cwd: root,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
      }),
    ).toBe(3)
    expect(stdout).toBe("")
    expect(JSON.parse(stderr)).toEqual({
      failure: {
        kind: "infrastructure",
        code: "unexpected",
        message: `yrd: '${root}' is not inside a Git worktree`,
        cause: `'${root}' is not inside a Git worktree`,
        resolution: ["Correct the cause above, then retry the same Yrd command."],
      },
    })
  })

  it("renders invalid receiver-hook modes concisely in human and JSON projections", async () => {
    let humanStderr = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "receiver-hook", "invalid"], {
        stdout() {},
        stderr(text) {
          humanStderr += text
        },
      }),
    ).toBe(2)
    expect(humanStderr).toBe("error: receiver-hook requires pre-receive or post-receive\n")

    let jsonStderr = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "receiver-hook", "invalid", "--json"], {
        stdout() {},
        stderr(text) {
          jsonStderr += text
        },
      }),
    ).toBe(2)
    expect(JSON.parse(jsonStderr)).toEqual({
      failure: {
        kind: "usage",
        code: "invalid-arguments",
        message: "yrd: receiver-hook requires pre-receive or post-receive",
        cause: "receiver-hook requires pre-receive or post-receive",
        resolution: ["Correct the cause above, then retry the same Yrd command."],
      },
    })
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

  it("projects an active Bay path from the selected repository authority", async () => {
    const { repo } = await repository()
    const ambient = join(repo, "..", "bay-path-ambient")
    await mkdir(ambient)
    await using owner = await createYrdHost({ cwd: repo })
    const opened = await owner.app.bays.open({ name: "selected" })
    const jobs = await owner.app.jobs.runMany(owner.app.jobs.requested(opened), {
      runner: "test",
      leaseMs: 60_000,
    })
    expect(jobs.every((job) => job.status === "completed" && job.conclusion === "success")).toBe(true)
    await owner.close()

    let stderr = ""
    const path = join(repo, ".bays", "B1")

    let projected = ""
    stderr = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/git-bay", "--repo", repo, "path", "selected", "--json"], {
        cwd: ambient,
        stdout: (text) => {
          projected += text
        },
        stderr: (text) => {
          stderr += text
        },
      }),
      stderr,
    ).toBe(0)
    expect(projected).toBe(`${JSON.stringify({ bay: "B1", command: "bay.path", path })}\n`)
    expect(await realpath(path)).toBe(path)
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
    await commitYrdConfig(repo, ["base: main", "batch: 1", "checks: [{check: {run: 'true'}}]", ""].join("\n"))

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
        journalCompatibilityYaml().trimEnd(),
        "base: main",
        "batch: 1",
        `checks: [{check: {run: ${JSON.stringify(`touch ${checkMarker}`)}}}]`,
        "",
      ].join("\n"),
    )
    await git(repo, "add", ".yrd.yml")
    await git(repo, "commit", "-qm", "shipping config")

    let submitError = ""
    expect(
      await runYrdProcess(
        ["/usr/bin/bun", "/usr/local/bin/yrd", "bay", "submit", "issue/feature", "--base", "main", "--json"],
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
          status: "completed",
          conclusion: "success",
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
        journalCompatibilityYaml().trimEnd(),
        "base: main",
        "batch: 2",
        `checks: [{check: {run: ${JSON.stringify(`touch ${checkMarker}`)}}}]`,
        "",
      ].join("\n"),
    )
    await git(repo, "add", ".yrd.yml")
    await git(repo, "commit", "-qm", "shipping config")

    for (const branch of ["issue/feature", "issue/second"]) {
      let stderr = ""
      expect(
        await runYrdProcess(
          ["/usr/bin/bun", "/usr/local/bin/yrd", "bay", "submit", branch, "--base", "main", "--json"],
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
          status: "completed",
          conclusion: "success",
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
        journalCompatibilityYaml().trimEnd(),
        "base: main",
        "batch: 1",
        `checks: [{check: {run: ${JSON.stringify(`printf check >> ${checkMarker}`)}}}]`,
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
          status: "completed",
          conclusion: "success",
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

  it("runs the managed required check before pr submit mutates the PR journal", async () => {
    const { repo } = await repository()
    await writeFile(
      join(repo, ".yrd.yml"),
      [
        journalCompatibilityYaml().trimEnd(),
        "base: main",
        "batch: 1",
        "requires: [review]",
        "checks:",
        "  - main-health:",
        "      classification: base",
        "      run: |",
        "        test -f feature.txt &&",
        '        printf "[yrd-base-health] base %.12s is red: test:fast failed\\n" "$YRD_BASE_SHA" &&',
        "        exit 1",
        "",
      ].join("\n"),
    )
    await git(repo, "add", ".yrd.yml")
    await git(repo, "commit", "-qm", "shipping config")
    const baseSha = await git(repo, "rev-parse", "main")

    let submitStdout = ""
    let submitStderr = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "pr", "submit", "issue/feature", "--json"], {
        cwd: repo,
        stdout: (text) => {
          submitStdout += text
        },
        stderr: (text) => {
          submitStderr += text
        },
      }),
      submitStderr,
    ).toBe(1)
    expect(submitStdout).toContain(`[yrd-base-health] base ${baseSha.slice(0, 12)} is red: test:fast failed`)
    expect(JSON.parse(submitStderr)).toMatchObject({
      failure: {
        kind: "refusal",
        code: "required-check-failed",
        message: expect.stringContaining("yrd check main-health"),
      },
    })
    expect((await journalEnvelope(repo)).flatMap(({ values }) => values)).toEqual([])
    await using host = await createYrdHost({ cwd: repo })
    expect(host.app.bays.list()).toEqual([])
  })

  it("refuses the retired config wrapper before plain or JSON startup mutates state", async () => {
    const { repo } = await repository()
    const retiredWrapper = ["li", "ne"].join("")
    await commitYrdConfig(repo, `${retiredWrapper}:\n  base: main\n  steps: [check, merge]\n`)

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
      expect(stderr).toContain("configure the required checks as 'checks: [...]'")
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
    const reopenedPR = reopened.app.state().bays.prs.PR1!
    expect(reopenedPR).toMatchObject({ branch: "issue/feature", state: "open", merged: false })
    expect(currentPRRev(reopenedPR)).toMatchObject({ head: headSha })
    expect(prDeliveryState(reopenedPR)).toBe("submitted")
    await reopened.close()
  })

  it("finds a direct-branch PR for status and refuses pr merge without appending", async () => {
    const { repo } = await repository()
    await git(repo, "switch", "-q", "issue/feature")
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
    expect(await journalEnvelope(repo)).toEqual([])

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

    const before = await journalEnvelope(repo)
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
    expect(await journalEnvelope(repo)).toEqual(before)
  })

  it("refuses pr submit when a changed submodule pin is on zero origin refs", async () => {
    const { repo, branch, pin } = await unpublishedSubmodulePinRepository()
    const component = await realpath(join(repo, "dep"))
    let stdout = ""
    let stderr = ""

    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "--repo", repo, "pr", "submit", branch, "--json"], {
        cwd: repo,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
      }),
      stderr,
    ).toBe(1)
    expect(stdout).toBe("")
    expect(JSON.parse(stderr)).toMatchObject({
      failure: {
        kind: "refusal",
        code: "submodule-pin-unpublished",
      },
    })
    expect(stderr).toContain("dep")
    expect(stderr).toContain(pin)
    expect(stderr).toContain(`cd '${component}' && git push origin '${pin}:refs/heads/${branch}'`)

    let listed = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "--repo", repo, "pr", "list", "--json"], {
        cwd: repo,
        stdout: (text) => {
          listed += text
        },
        stderr: () => undefined,
      }),
    ).toBe(0)
    expect(JSON.parse(listed)).toMatchObject({
      prs: [{ branch, checkRequests: [] }],
    })

    await git(component, "push", "-q", "origin", `${pin}:refs/heads/${branch}`)
    stdout = ""
    stderr = ""
    const publishedExit = await runYrdProcess(
      ["/usr/bin/bun", "/usr/local/bin/yrd", "--repo", repo, "pr", "submit", branch, "--json"],
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
    expect(publishedExit, stderr).toBe(0)
    expect(stderr).toBe("")
    expect(JSON.parse(stdout)).toMatchObject({
      command: "pr.submit",
      prs: [{ branch, status: "submitted" }],
    })

    listed = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "--repo", repo, "pr", "list", "--json"], {
        cwd: repo,
        stdout: (text) => {
          listed += text
        },
        stderr: () => undefined,
      }),
    ).toBe(0)
    const listedPrs = JSON.parse(listed) as { prs: Array<{ checkRequests: readonly unknown[] }> }
    expect(listedPrs.prs[0]?.checkRequests).toHaveLength(1)
  })

  it("keeps a draft pushed when pr ready refuses an unpublished changed submodule pin", async () => {
    const { repo, branch, pin } = await unpublishedSubmodulePinRepository()
    const component = await realpath(join(repo, "dep"))
    let stdout = ""
    let stderr = ""

    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "--repo", repo, "pr", "create", branch, "--json"], {
        cwd: repo,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
      }),
      stderr,
    ).toBe(0)
    expect(stderr).toBe("")
    const created = JSON.parse(stdout)
    expect(created).toMatchObject({
      prs: [{ id: "PR1", branch }],
    })

    stdout = ""
    stderr = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "--repo", repo, "pr", "ready", "PR1", "--json"], {
        cwd: repo,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
      }),
      stderr,
    ).toBe(1)
    expect(stdout).toBe("")
    expect(JSON.parse(stderr)).toMatchObject({
      failure: {
        kind: "refusal",
        code: "submodule-pin-unpublished",
      },
    })
    expect(stderr).toContain(`cd '${component}' && git push origin '${pin}:refs/heads/${branch}'`)

    let listed = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "--repo", repo, "pr", "list", "--json"], {
        cwd: repo,
        stdout: (text) => {
          listed += text
        },
        stderr: () => undefined,
      }),
    ).toBe(0)
    expect(JSON.parse(listed)).toMatchObject({
      prs: [{ id: "PR1", branch, status: "pushed", checkRequests: [] }],
    })
  })

  it("refuses pr recut --queue when the recut revision retains an unpublished changed submodule pin", async () => {
    const { repo, branch, pin } = await unpublishedSubmodulePinRepository()
    const component = await realpath(join(repo, "dep"))
    let stdout = ""
    let stderr = ""

    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "--repo", repo, "pr", "create", branch, "--json"], {
        cwd: repo,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
      }),
      stderr,
    ).toBe(0)

    stdout = ""
    stderr = ""
    expect(
      await runYrdProcess(
        [
          "/usr/bin/bun",
          "/usr/local/bin/yrd",
          "--repo",
          repo,
          "pr",
          "recut",
          "PR1",
          "--revision",
          "1",
          "--queue",
          "--json",
        ],
        {
          cwd: repo,
          stdout: (text) => {
            stdout += text
          },
          stderr: (text) => {
            stderr += text
          },
        },
      ),
      stderr,
    ).toBe(1)
    expect(stdout).toBe("")
    expect(JSON.parse(stderr)).toMatchObject({
      failure: {
        kind: "refusal",
        code: "submodule-pin-unpublished",
      },
    })
    expect(stderr).toContain(`cd '${component}' && git push origin '${pin}:refs/heads/${branch}'`)

    let listed = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "--repo", repo, "pr", "list", "--json"], {
        cwd: repo,
        stdout: (text) => {
          listed += text
        },
        stderr: () => undefined,
      }),
    ).toBe(0)
    expect(JSON.parse(listed)).toMatchObject({
      prs: [{ id: "PR1", branch, status: "pushed", checkRequests: [] }],
    })
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

  it("teaches exact run inspection guidance for a submitted direct-branch PR without appending", async () => {
    const { repo } = await repository()
    await commitYrdConfig(
      repo,
      [
        "base: main",
        "batch: 1",
        "checks:",
        "  - check:",
        "      run: |",
        "        if test -f feature.txt; then printf 'feature.txt:1: target regression\\n'; exit 1; fi",
        "",
      ].join("\n"),
    )
    await git(repo, "switch", "-q", "issue/feature")
    let submitOutput = ""
    let submitError = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "bay", "submit", "--base", "main", "--json"], {
        cwd: repo,
        stdout: (text) => {
          submitOutput += text
        },
        stderr: (text) => {
          submitError += text
        },
      }),
      `${submitOutput}\n${submitError}`,
    ).toBe(0)
    expect(submitError).toBe("")
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "queue", "run", "PR1", "--json"], {
        cwd: repo,
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    ).toBe(1)

    const before = await journalEnvelope(repo)
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
      guidance: Readonly<{ view: string }>
    }>
    expect(rejected).toMatchObject({
      command: "pr.merge",
      status: "submitted",
      next: "yrd pr runs PR1",
    })
    expect(rejected.guidance).toEqual({
      inspect: "yrd pr runs PR1",
      resubmit: "fix the branch and run yrd pr submit again",
    })
    expect(await journalEnvelope(repo)).toEqual(before)
  })

  it("starts a fresh current journal without reading or rewriting legacy journal files", async () => {
    const { repo } = await repository()
    const oldYrdJournal = join(repo, ".git", "yrd", "events.jsonl")
    const oldBayJournal = join(repo, ".git", "bay", "journal.jsonl")
    await mkdir(join(repo, ".git", "yrd"), { recursive: true })
    await mkdir(join(repo, ".git", "bay"), { recursive: true })
    await writeFile(oldYrdJournal, "old yrd journal remains opaque\n")
    await writeFile(oldBayJournal, "old bay journal remains opaque\n")

    await using host = await createYrdHost({ cwd: repo })
    expect(host.services.recut).toBeDefined()
    await expect(host.services.queueReadModel?.attempts()).resolves.toEqual([])
    const headSha = await git(repo, "rev-parse", "issue/feature")
    await host.app.bays.submit({ branch: "issue/feature", headSha, base: "main" })

    expect((await journalEnvelope(repo)).flatMap((batch) => batch.values)).toHaveLength(1)
    expect(await readFile(oldYrdJournal, "utf8")).toBe("old yrd journal remains opaque\n")
    expect(await readFile(oldBayJournal, "utf8")).toBe("old bay journal remains opaque\n")
  })

  it("quiesces an expired pre-settlement root before active host bring-up completes", async () => {
    const { repo, featureSha } = await repository()
    await commitYrdConfig(repo, 'base: main\nbatch: 1\nchecks: [{check: {run: "true"}}]\n')
    const stateDir = join(repo, ".git", "yrd")
    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      steps: ["check"],
      requires: [],
      definitions: { check: { run: "true", runner: "local" } },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["check"] },
    }
    const inner = testJournal(stateDir)
    let refuseFinish = true
    const legacyJournal: typeof inner = {
      read: (after, before) => inner.read(after, before),
      append: (value, cursor) => {
        const frame = structuredClone(value) as {
          events?: {
            name?: string
            data?: { leaseExpiresAt?: string; run?: Record<string, unknown>; type?: string }
          }[]
        }
        for (const event of frame.events ?? []) {
          if (event.name === "queue/run/started" && event.data?.run !== undefined) {
            delete event.data.run.settlement
          }
          if (event.name === "job/transitioned" && event.data?.type === "start") {
            event.data.leaseExpiresAt = "2026-01-01T00:01:00.000Z"
          }
        }
        if (
          refuseFinish &&
          frame.events?.some((event) => event.name === "job/transitioned" && event.data?.type === "finish")
        ) {
          refuseFinish = false
          throw new Error("yrd: job finish refused (host legacy fixture)")
        }
        return inner.append(frame, cursor)
      },
    }

    await using runtimeProcess = createProcess({ cwd: repo })
    {
      await using legacy = await createDefaultYrdApp({
        repo,
        stateDir,
        baysRoot: join(repo, ".bays"),
        journal: legacyJournal,
        process: runtimeProcess,
        config,
      })
      await legacy.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
      await expect(
        legacy.queue.run(
          { prs: ["PR1"] },
          { runner: "legacy", leaseMs: 60_000, now: () => Date.parse("2026-01-01T00:00:00.000Z") },
        ),
      ).rejects.toThrow("host legacy fixture")
    }
    {
      using database = new Database(join(stateDir, "journal.sqlite"), { readwrite: true, strict: true })
      database.run("DROP TABLE journal_views")
    }

    await using host = await createYrdHost({ cwd: repo })
    expect(host.app.queue.get("R1")).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "legacy-quiesced" },
      steps: [
        expect.objectContaining({
          job: expect.objectContaining({ status: "completed", conclusion: "cancelled" }),
        }),
      ],
    })
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

  it("keeps repeated resident signals idempotent while hard escalation reaps the active process tree", async () => {
    const { repo, featureSha } = await repository()
    const childPidPath = join(repo, "resident-hard-stop.pid")
    const grandchildPidPath = join(repo, "resident-hard-stop-grandchild.pid")
    const hardStopPath = join(repo, "resident-hard-stop.started")
    const command = [
      `trap 'touch ${JSON.stringify(hardStopPath)}' TERM`,
      `printf '%s\\n' "$$" > ${JSON.stringify(childPidPath)}`,
      `sh -c 'trap "" TERM; ${BOUNDED_ONE_SECOND_LOOP}' & printf '%s\\n' "$!" > ${JSON.stringify(grandchildPidPath)}`,
      BOUNDED_ONE_SECOND_LOOP,
    ].join("; ")
    await commitYrdConfig(repo, `checks: [{check: {run: ${JSON.stringify(command)}, timeoutMs: 30000}}]\n`)

    await using submitter = await createYrdHost({ cwd: repo })
    await submitter.app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
    await submitter.close()

    const cli = Bun.spawn(
      [process.execPath, join(import.meta.dirname, "../../../bin/yrd.ts"), "queue", "run", "--interval", "1", "--json"],
      { cwd: repo, stdout: "pipe", stderr: "pipe" },
    )
    const stdout = new Response(cli.stdout).text()
    const stderr = new Response(cli.stderr).text()
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

      cli.kill("SIGINT")
      await Bun.sleep(100)
      cli.kill("SIGTERM")
      await vi.waitFor(async () => expect(await Bun.file(hardStopPath).exists()).toBe(true), { timeout: 5_000 })
      cli.kill("SIGINT")

      await expect(cli.exited).resolves.toBe(143)
      await vi.waitFor(() => expect(processExists(childPid!)).toBe(false), { timeout: 5_000 })
      await vi.waitFor(() => expect(processExists(grandchildPid!)).toBe(false), { timeout: 5_000 })
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
      await stdout
      await stderr
    }
    if (cleanupError !== undefined) throw cleanupError
  }, 30_000)

  it("refuses a second resident follow-runner with the active runner identity", async () => {
    const { repo, featureSha } = await repository()
    const startedPath = join(repo, "..", "resident-check.started")
    const executionsPath = join(repo, "..", "resident-check.executions")
    const command = [
      `printf 'run\\n' >> ${JSON.stringify(executionsPath)}`,
      `touch ${JSON.stringify(startedPath)}`,
      "sleep 2",
    ].join("; ")
    await commitYrdConfig(repo, `checks: [{check: {run: ${JSON.stringify(command)}, timeoutMs: 5000}}]\n`)
    await git(repo, "switch", "-qc", "issue/second", "main")
    await writeFile(join(repo, "second.txt"), "second\n")
    await git(repo, "add", "second.txt")
    await git(repo, "commit", "-qm", "second")
    const secondSha = await git(repo, "rev-parse", "HEAD")
    await git(repo, "switch", "-q", "main")
    // #62: the resident runner is now `queue run` in its follow-by-default form
    // (no selector, no --once). Follow drains the WHOLE default queue, so to keep
    // each resident bound to exactly one PR, PR1 is submitted first and PR2 only
    // after the first runner releases the lease.
    {
      await using submitter = await createYrdHost({ cwd: repo })
      await submitter.app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
      await submitter.close()
    }
    const spawnFollow = (pane: string) => {
      const logPath = join(repo, "..", `resident-${pane.replace(/[^a-z0-9]+/giu, "-")}.log`)
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dirname, "../../../bin/yrd.ts"),
          "queue",
          "run",
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
    const first = spawnFollow("w1:p1")
    let second: ReturnType<typeof spawnFollow> | undefined
    let replacement: ReturnType<typeof spawnFollow> | undefined
    try {
      await vi.waitFor(async () => expect(await Bun.file(startedPath).exists()).toBe(true), {
        timeout: 5_000,
      })
      // A second resident follow-runner is refused while the first holds the lease.
      second = spawnFollow("w1:p2")

      const outcome = await Promise.race([
        second.child.exited.then((exitCode) => ({ exitCode })),
        Bun.sleep(2_000).then(() => ({ exitCode: "still-running" as const })),
      ])
      expect(outcome).toEqual({ exitCode: 1 })
      expect(await second.stderr).toContain(
        `resident-runner-active: writer lock is busy (owner=yrd-cli:${first.child.pid}; contender=yrd-cli:${second.child.pid}`,
      )
      expect((await readFile(executionsPath, "utf8")).trim().split("\n")).toEqual(["run"])
      // A graceful drain (SIGTERM) lets the first exit after finishing PR1's run.
      first.child.kill("SIGTERM")
      expect(await first.child.exited, `${await first.stdout}\n${await first.stderr}`).toBe(0)

      // With the lease released, submit PR2 and let a replacement reclaim + drain it.
      {
        await using submitter = await createYrdHost({ cwd: repo })
        await submitter.app.bays.submit({ branch: "issue/second", headSha: secondSha, base: "main" })
        await submitter.close()
      }
      replacement = spawnFollow("w1:p3")
      try {
        await vi.waitFor(
          async () => expect((await readFile(executionsPath, "utf8")).trim().split("\n")).toEqual(["run", "run"]),
          { timeout: 8_000 },
        )
      } catch (cause) {
        const replacementLog = await readFile(replacement.logPath, "utf8").catch(() => "<missing replacement log>")
        throw new Error(`replacement resident did not execute PR2\n${replacementLog}`, { cause })
      }
      replacement.child.kill("SIGTERM")
      await expect(replacement.child.exited).resolves.toBe(0)

      await using settled = await createYrdHost({ cwd: repo })
      const runIds = Queues.ids(settled.app.state().queues)
      expect(runIds).toEqual(["R1", "R2"])
      expect(runIds.map((id) => settled.app.queue.get(id)?.status)).toEqual(["completed", "completed"])
      expect(runIds.map((id) => settled.app.queue.get(id)?.conclusion)).toEqual(["success", "success"])
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
  }, 60_000)

  it("records a process-host attestation as the resident's loaded implementation", async () => {
    const { repo } = await repository()
    const statusPath = join(repo, ".git", "yrd", "resident-runner", "status.json")
    const implementationSource = `git:${await git(repo, "rev-parse", "HEAD")}`
    const cli = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dirname, "../../../bin/yrd.ts"),
        "queue",
        "run",
        "--interval",
        "10",
        "--json",
      ],
      {
        cwd: repo,
        env: {
          ...process.env,
          HERDR_PANE_ID: "w1:attested",
          YRD_WRAPPER_IMPLEMENTATION_SOURCE: implementationSource,
          YRD_WRAPPER_IMPLEMENTATION_REPOSITORY: repo,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const stdout = new Response(cli.stdout).text()
    const stderr = new Response(cli.stderr).text()
    try {
      await vi.waitFor(
        async () =>
          expect(JSON.parse(await readFile(statusPath, "utf8"))).toMatchObject({
            pid: cli.pid,
            implementationSource,
          }),
        { timeout: 10_000 },
      )
      cli.kill("SIGTERM")
      await expect(cli.exited).resolves.toBe(0)
    } finally {
      cli.kill("SIGKILL")
      await cli.exited
      await stdout
      await stderr
    }
  }, 30_000)

  it("replaces a dead resident owner after the OS releases its lease", async () => {
    const { repo } = await repository()
    const argv = [
      process.execPath,
      join(import.meta.dirname, "../../../bin/yrd.ts"),
      "queue",
      "run",
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

  it("submits the current linked-worktree branch when no bay selector is given", async () => {
    const { repo, featureSha } = await repository()
    const linked = join(repo, "..", "current")
    await using setup = await createYrdHost({ cwd: repo })
    const opened = await setup.app.bays.open({ name: "stale" })
    const jobs = await setup.app.jobs.runMany(setup.app.jobs.requested(opened), {
      runner: "test",
      leaseMs: 60_000,
    })
    expect(jobs.every((job) => job.status === "completed" && job.conclusion === "success")).toBe(true)
    await setup.close()
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
          base: "main",
          issue: "github:beorn/yrd#42",
          state: "open",
          merged: false,
          revs: [expect.objectContaining({ n: 1, head: featureSha })],
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
    await commitYrdConfig(
      repo,
      `base: main\nchecks: [{check: {run: ${JSON.stringify(`pwd > ${JSON.stringify(checkCwd)}`)}}}]\n`,
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
      prs: [
        {
          id: "PR1",
          branch: "issue/feature",
          revs: [expect.objectContaining({ head: featureSha })],
        },
      ],
    })
    expect(selected.stderr).toBe("")

    const diff = await run(["pr", "diff", "PR1", "--repo", relativeRepo, "--json"], poisoned)
    expect(diff.exitCode, diff.stderr).toBe(0)
    expect(JSON.parse(diff.stdout)).toMatchObject({
      command: "pr.diff",
      pr: "PR1",
      diff: expect.stringContaining("feature.txt"),
    })
    expect(diff.stderr).toBe("")

    const submitted = await run(["pr", "submit", "--repo", relativeRepo, "--json"])
    expect(submitted.exitCode, submitted.stderr).toBe(0)
    expect(JSON.parse(submitted.stdout)).toMatchObject({
      command: "pr.submit",
      prs: [
        {
          id: "PR1",
          branch: "issue/feature",
          revs: [expect.objectContaining({ head: featureSha })],
        },
      ],
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
    expect(managedCwd).toBe(linked)
    expect(managedCwd).not.toBe(ambient)
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
      prs: [
        {
          id: "PR1",
          revs: [
            expect.objectContaining({
              composition: expect.objectContaining({
                sources: [expect.objectContaining({ repo: "dep", tipSha: sourceTipSha })],
              }),
            }),
          ],
        },
      ],
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
      status: "completed",
      conclusion: "success",
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

  it("fails a check that emits then goes silent as a stall instead of wedging the queue behind a live child", async () => {
    const { repo, featureSha } = await repository()
    // Emit one banner line (arms the progress lease), then hold silent far
    // longer than the declared no-progress bound while still well under the
    // wall-clock bound: the wedge signature from the 2026-07-16 R423 incident,
    // where the candidate vitest printed its RUN header then produced nothing.
    const command = "printf 'RUN v1\\n'; sleep 30"
    await commitYrdConfig(
      repo,
      `base: main\nbatch: 1\nchecks: [{check: {run: ${JSON.stringify(command)}, noProgressMs: 400, timeoutMs: 30000}}]\n`,
    )

    await using host = await createYrdHost({ cwd: repo })
    await host.app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
    const run = (await host.app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 }))[0]!

    expect(run).toMatchObject({ status: "completed", conclusion: "failure" })
    const failedJob = run.steps.find(
      (step) => step.job?.status === "completed" && step.job.conclusion === "failure",
    )?.job
    if (failedJob?.status !== "completed" || failedJob.conclusion !== "failure") {
      throw new Error("expected a stalled check job")
    }
    expect(failedJob.error).toMatchObject({ code: "check-stalled" })
    const evidence = GitCheckEvidenceSchema.parse(failedJob.output)
    expect(evidence).toMatchObject({ stageVerdict: "STALLED" })
    // A stall must not merge: the wedged candidate never reached the queue tip.
    expect(await git(repo, "rev-parse", "main")).not.toBe(featureSha)
  }, 20_000)

  it("reports a failed queue against origin when the operator HEAD is detached", async () => {
    const { repo, featureSha } = await repository()
    await commitYrdConfig(
      repo,
      "checks: [{check: {run: \"printf 'real stdout\\\\n'; printf 'real stderr\\\\n' >&2; exit 7\"}}]\n",
    )
    const baseSha = await git(repo, "rev-parse", "main")
    const first = await createYrdHost({ cwd: repo })
    await first.app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
    const run = (await first.app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 }))[0]!
    expect(run).toMatchObject({ status: "completed", conclusion: "failure" })
    const failedJob = run.steps.find(
      (step) => step.job?.status === "completed" && step.job.conclusion === "failure",
    )?.job
    if (failedJob?.status !== "completed" || failedJob.conclusion !== "failure") {
      throw new Error("missing failed configured check")
    }
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
    expect(stdout).toMatch(/pr#1\.1\s+→ CANDIDATE C1 → RUN main#1 issue\/feature\s+rejected/u)
    expect(stdout).toContain("OPEN 1")
    expect(stdout).toContain("REJECTED 0")
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
    await commitYrdConfig(repo, 'checks: [{check: {run: "exit 7"}}]\n')

    const host = await createYrdHost({ cwd: repo })
    try {
      await host.app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
      const prior = (await host.app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 }))[0]!
      expect(prior).toMatchObject({ status: "completed", conclusion: "failure" })
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
      expect(current).toMatchObject({ status: "completed", conclusion: "failure" })
    } finally {
      await host.close()
    }

    const journalBefore = await journalEnvelope(repo)
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
    expect(stdout.match(/pr#1/giu)).toHaveLength(3)
    expect(`${stdout}\n${stderr}`).not.toMatch(/precedes/u)
    expect(await journalEnvelope(repo)).toEqual(journalBefore)
  })

  it("renders a conflicting Candidate without admitting a Job", async () => {
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

    const host = await createYrdHost({ cwd: repo })
    try {
      await host.app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
      const [run] = await host.app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 })
      expect(run).toMatchObject({
        id: "R1",
        candidateId: "C1",
        status: "completed",
        conclusion: "failure",
        jobs: [],
        error: { code: "candidate-conflicting" },
      })
      expect(Queues.ids(host.app.state().queues)).toEqual(["R1"])
      expect(host.app.state().queues.candidates.C1).toMatchObject({
        id: "C1",
        mergeability: "conflicting",
        revs: [{ pr: "PR1", n: 1, head: featureSha }],
      })
      expect(host.app.queue.eligibility("PR1")).toMatchObject({
        runnable: false,
        reason: { code: "candidate-conflicting", message: "PR 'PR1' revision 1 conflicts in Candidate 'C1'" },
      })
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
    expect(stdout).toContain("C1")
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
  it("propagates a hard timeout and loud diagnosis for a blackholed Git process", async () => {
    const run = vi.fn(async (request: ProcessRequest): Promise<ProcessResult> => {
      return {
        exitCode: 124,
        signal: "SIGTERM",
        stdout: "",
        stderr: "",
        durationMs: request.timeoutMs ?? 0,
        timedOut: true,
        verdict: "TIMED_OUT",
      }
    })

    await expect(
      discoverYrdRepository({ cwd: "/blackholed-repository", process: { run } as Pick<Process, "run"> }),
    ).rejects.toThrow("timed out after 30000ms")
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      argv: ["git", "-C", "/blackholed-repository", "rev-parse", "--path-format=absolute", "--show-toplevel"],
      timeoutMs: 30_000,
    })
  })

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

describe("stepNoProgressMs — the no-output-progress bound that stalls a silent child (queue wedge guard)", () => {
  it("applies the default when a step declares no bound, and the declared bound when it does", async () => {
    const { DEFAULT_STEP_NO_PROGRESS_MS, stepNoProgressMs } = await import("../src/host.ts")
    expect(stepNoProgressMs({ run: "x", runner: "local" })).toBe(DEFAULT_STEP_NO_PROGRESS_MS)
    expect(stepNoProgressMs({ run: "x", runner: "waiting" })).toBe(DEFAULT_STEP_NO_PROGRESS_MS)
    expect(stepNoProgressMs({ run: "x", runner: "local", noProgressMs: 4_321 })).toBe(4_321)
  })

  it("defaults strictly below the wall-clock bound so silence fails as a stall before the coarse timeout", async () => {
    const { DEFAULT_STEP_NO_PROGRESS_MS, DEFAULT_STEP_TIMEOUT_MS } = await import("../src/host.ts")
    expect(DEFAULT_STEP_NO_PROGRESS_MS).toBeLessThan(DEFAULT_STEP_TIMEOUT_MS)
  })

  it("binds the no-progress bound into the queue step revision identity", () => {
    const toolchain = { bun: "1.3.0", node: "24.0.0", platform: "darwin", arch: "arm64" }
    const input = {
      repo: "/repo",
      stateDir: "/repo/.git/yrd",
      name: "check",
      config: { run: "bun run check", runner: "local" as const },
      timeoutMs: 60_000,
      noProgressMs: 600_000,
      toolchain,
    }
    const baseline = queueStepRevision(input)
    expect(queueStepRevision({ ...input, noProgressMs: 120_000 })).not.toBe(baseline)
  })

  it("binds the declared diagnostics comparator into the queue step revision identity", () => {
    const toolchain = { bun: "1.3.0", node: "24.0.0", platform: "darwin", arch: "arm64" }
    const input = {
      repo: "/repo",
      stateDir: "/repo/.git/yrd",
      name: "lint",
      config: { run: "bun run lint", runner: "local" as const },
      timeoutMs: 60_000,
      noProgressMs: 600_000,
      toolchain,
    }
    const baseline = queueStepRevision(input)

    expect(queueStepRevision({ ...input, config: { ...input.config, comparison: "diagnostics" as const } })).not.toBe(
      baseline,
    )
  })

  it("binds the effective gate mode into the queue step revision identity", () => {
    const toolchain = { bun: "1.3.0", node: "24.0.0", platform: "darwin", arch: "arm64" }
    const input = {
      repo: "/repo",
      stateDir: "/repo/.git/yrd",
      name: "check",
      config: { run: "bun run check", runner: "local" as const },
      timeoutMs: 60_000,
      noProgressMs: 600_000,
      toolchain,
    }
    const delta = queueStepRevision(input)

    expect(queueStepRevision({ ...input, config: { ...input.config, mode: "delta" as const } })).toBe(delta)
    expect(queueStepRevision({ ...input, config: { ...input.config, mode: "strict" as const } })).not.toBe(delta)
    expect(
      queueStepRevision({
        ...input,
        config: {
          ...input.config,
          comparison: "diagnostics" as const,
          comparisonReady: DIAGNOSTICS_COMPARISON_READY,
        },
      }),
    ).not.toBe(delta)
  })
})

describe("step environment declarations — deterministic check children (merge-queue R42)", () => {
  it("parses declared env values and ambient passthrough names", async () => {
    const { parseYrdConfig } = await import("../src/config.ts")
    const config = parseYrdConfig({
      checks: [{ check: { run: "bun run check", env: { NODE_ENV: "test" }, environmentPassthrough: ["CI"] } }],
    })
    expect(config.checks[0]).toEqual({
      check: {
        run: "bun run check",
        runner: "local",
        env: { NODE_ENV: "test" },
        environmentPassthrough: ["CI"],
      },
    })
  })

  it("rejects reserved and malformed environment declarations", async () => {
    const { parseYrdConfig } = await import("../src/config.ts")
    for (const step of [
      { run: "x", env: { YRD_PR: "forged" } },
      { run: "x", env: { GIT_DIR: "/elsewhere" } },
      { run: "x", environmentPassthrough: ["YRD_SHA"] },
      { run: "x", environmentPassthrough: ["BAD NAME"] },
      { run: "x", environmentPassthrough: ["CI", "CI"] },
    ]) {
      expect(() => parseYrdConfig({ checks: [{ check: step }] }), JSON.stringify(step)).toThrow()
    }
  })

  it("binds environment declarations into the queue step revision identity", () => {
    const toolchain = { bun: "1.3.0", node: "24.0.0", platform: "darwin", arch: "arm64" }
    const input = {
      repo: "/repo",
      stateDir: "/repo/.git/yrd",
      name: "check",
      config: { run: "bun run check", runner: "local" as const },
      timeoutMs: 60_000,
      noProgressMs: 600_000,
      toolchain,
    }
    const baseline = queueStepRevision(input)
    expect(queueStepRevision({ ...input, config: { ...input.config, env: { NODE_ENV: "test" } } })).not.toBe(baseline)
    expect(queueStepRevision({ ...input, config: { ...input.config, environmentPassthrough: ["CI"] } })).not.toBe(
      baseline,
    )
  })
})
