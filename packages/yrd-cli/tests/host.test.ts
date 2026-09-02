/**
 * @failure The default host composes incompatible definitions, state paths, receivers, or lifecycle ownership.
 * @level l3
 * @consumer @yrd/cli host
 */
import { existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { Database } from "bun:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { currentChangeRev, changeBaseSha, changeDeliveryState, receiverInboxDir, recordLaneOwnsBranch } from "@yrd/bay"
import { Command, createFailure, createMemoryJournal, parseJournalFrame } from "@yrd/core"
import { DIAGNOSTICS_COMPARISON_READY, GitCheckEvidenceSchema, IntegrationProofSchema, Queues } from "@yrd/queue"
import { createExclusive, createJournal, createReadOnlyJournal } from "@yrd/persistence"
import { createProcess, type Process, type ProcessRequest, type ProcessResult } from "@yrd/process"
import { createLogger, type ConditionalLogger, type LogEvent } from "loggily"
import * as z from "zod"
import {
  CURRENT_JOURNAL_COMPATIBILITY,
  configuredChecks,
  createDefaultYrdApp as createDefaultYrdAppRaw,
  createDefaultYrdCheckpointMigrationAttestation,
  createPinIntentProvisioner,
  createPostureQueueTargetResolver,
  createYrdHost as createYrdHostRaw,
  habitantOwnsSettlementDrain,
  runYrdProcess,
} from "../src/host.ts"
import { HABITANT_EXIT } from "../src/habitant-exit.ts"
import { QUEUE_OUTCOME_EXIT } from "../src/outcome-notify.ts"
import { checkpointBumpGateViolations, SHIPPED_CHECKPOINT_IDENTITIES } from "../src/checkpoint-bump-gate.ts"
import { queueStepRevision } from "../src/host-revision.ts"
import { sourceRepositoryFor, takeImplementationSourceAttestation } from "../src/implementation-source.ts"
import type { ResolvedYrdProjectConfig } from "../src/config.ts"
import { classifyFailure } from "../src/invocation.ts"
import { withLiveRenderer } from "../src/live-renderer.ts"
import { discoverYrdRepository } from "../src/repository.ts"
import type { YrdSettlementLaunch } from "../src/settlement.ts"
import { installDeclaredYrdEntry } from "./support/declared-yrd-entry.ts"

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

async function initBareMain(cwd: string, remote: string): Promise<void> {
  await git(cwd, "-c", "init.defaultBranch=host-default", "init", "-q", "--bare", remote)
  await git(remote, "symbolic-ref", "HEAD", "refs/heads/main")
  expect(await git(remote, "symbolic-ref", "HEAD")).toBe("refs/heads/main")
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
  await installDeclaredYrdEntry(repo)
  await writeFile(join(repo, "README.md"), "main\n")
  await writeFile(join(repo, ".yrd.yml"), 'checks: [{check: {run: "true"}}]\n')
  await git(repo, "add", "README.md", ".yrd.yml", "bin/yrd")
  await git(repo, "commit", "-qm", "main")
  await git(repo, "switch", "-qc", "issue/feature")
  await writeFile(join(repo, "feature.txt"), "feature\n")
  await git(repo, "add", "feature.txt")
  // The Change-Id trailer is what the receiver's push-time gate requires of a
  // recordless refs/for tip (S6 derived identity); the value is arbitrary.
  await git(repo, "commit", "-qm", `feature\n\nChange-Id: I${"cafe".repeat(10)}`)
  const featureSha = await git(repo, "rev-parse", "HEAD")
  await git(repo, "switch", "-q", "main")
  return { repo, featureSha }
}

async function staleRemoteBranchRepository(): Promise<{
  author: string
  observer: string
  branch: string
  staleHead: string
  liveHead: string
}> {
  const root = await mkdtemp(join(tmpdir(), "yrd-submit-live-branch-"))
  roots.push(root)
  const remote = join(root, "origin.git")
  const author = join(root, "author")
  const observer = join(root, "observer")
  const branch = "issue/feature"
  await git(root, "init", "-q", "-b", "main", author)
  await git(author, "config", "user.name", "Yrd Test")
  await git(author, "config", "user.email", "yrd@example.invalid")
  await installDeclaredYrdEntry(author)
  await writeFile(join(author, "README.md"), "main\n")
  await writeFile(join(author, ".yrd.yml"), 'checks: [{check: {run: "true"}}]\n')
  await git(author, "add", "README.md", ".yrd.yml", "bin/yrd")
  await git(author, "commit", "-qm", "main")
  await initBareMain(author, remote)
  await git(author, "remote", "add", "origin", remote)
  await git(author, "push", "-qu", "origin", "main")
  await git(author, "switch", "-qc", branch)
  await writeFile(join(author, "feature.txt"), "first\n")
  await git(author, "add", "feature.txt")
  await git(author, "commit", "-qm", "first branch head")
  await git(author, "push", "-qu", "origin", branch)
  await git(root, "clone", "-q", remote, observer)
  const staleHead = await git(observer, "rev-parse", `refs/remotes/origin/${branch}`)
  await writeFile(join(author, "feature.txt"), "second\n")
  await git(author, "add", "feature.txt")
  await git(author, "commit", "-qm", "live branch head")
  const liveHead = await git(author, "rev-parse", "HEAD")
  await git(author, "push", "-q", "origin", branch)
  expect(staleHead).not.toBe(liveHead)
  return { author, observer, branch, staleHead, liveHead }
}

/** A branch that never rebased after its base moved on: `main` carries a commit
 * the branch has never seen, and the branch's own delta does not touch it. This
 * is the ordinary shape of any pushed branch whose base advanced, and the queue
 * absorbs it by composing before it judges. */
async function staleBaseCandidateRepository(): Promise<{ repo: string; featureSha: string; baseSha: string }> {
  const { repo, featureSha } = await repository()
  await git(repo, "switch", "-q", "main")
  await writeFile(join(repo, "merged-after-branch.txt"), "merged on main after the branch diverged\n")
  await git(repo, "add", "merged-after-branch.txt")
  await git(repo, "commit", "-qm", "merge unrelated work on main")
  const baseSha = await git(repo, "rev-parse", "HEAD")
  return { repo, featureSha, baseSha }
}

/** The shape a LANDED change leaves behind: the branch was fast-forwarded onto
 * the base after it merged, and the base then moved on. Base is no longer an
 * ancestor of the branch tip, so a required check composes — and the merge is a
 * no-op, because the tip is already reachable from the base. Composition then
 * yields the base itself and the pair is X..X.
 * Measured on `task/hub-yrd-split-brain` (2026-08-28). */
async function landedCandidateRepository(): Promise<{ repo: string; candidateSha: string; baseSha: string }> {
  const { repo } = await repository()
  await git(repo, "switch", "-q", "main")
  await writeFile(join(repo, "landed.txt"), "the branch's work, already on main\n")
  await git(repo, "add", "landed.txt")
  await git(repo, "commit", "-qm", "the change lands on main")
  const candidateSha = await git(repo, "rev-parse", "HEAD")
  await git(repo, "branch", "-f", "issue/feature", candidateSha)
  await writeFile(join(repo, "after.txt"), "main moved on afterwards\n")
  await git(repo, "add", "after.txt")
  await git(repo, "commit", "-qm", "main moves on")
  const baseSha = await git(repo, "rev-parse", "HEAD")
  return { repo, candidateSha, baseSha }
}

async function candidatePackageRepository(
  options: Readonly<{ postinstall?: string }> = {},
): Promise<{ repo: string; featureSha: string }> {
  const { repo } = await repository()
  await git(repo, "switch", "-q", "main")
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({
      scripts: {
        typecheck: "test -f node_modules/.provisioned",
        lint: "test -f node_modules/.provisioned",
        ...(options.postinstall === undefined ? {} : { postinstall: options.postinstall }),
      },
      devDependencies: { typescript: "6.0.3" },
    }),
  )
  await writeFile(join(repo, "bun.lock"), "lockfileVersion = 1\n")
  await writeFile(join(repo, ".gitignore"), "node_modules/\n")
  await writeFile(join(repo, ".yrd.yml"), 'checks: [{typecheck: {run: "bun run typecheck"}}]\n')
  await git(repo, "add", "package.json", "bun.lock", ".gitignore", ".yrd.yml")
  await git(repo, "commit", "-qm", "declare candidate toolchain")
  await git(repo, "switch", "-q", "issue/feature")
  await git(repo, "rebase", "-q", "main")
  const featureSha = await git(repo, "rev-parse", "HEAD")
  await git(repo, "switch", "-q", "main")
  return { repo, featureSha }
}

async function manifestChangingPinRepository(options: Readonly<{ manifestChange?: boolean }> = {}): Promise<{
  repo: string
  baseSha: string
  provisionalCandidateSha: string
}> {
  const { repo } = await repository()
  const module = join(repo, "..", "manifest-module")
  await git(repo, "switch", "-q", "main")
  await git(repo, "config", "protocol.file.allow", "always")
  await git(repo, "init", "-q", "-b", "main", module)
  await git(module, "config", "user.name", "Yrd Test")
  await git(module, "config", "user.email", "yrd@example.invalid")
  await writeFile(join(module, "package.json"), `${JSON.stringify({ dependencies: { fixture: "1.0.0" } })}\n`)
  await git(module, "add", "package.json")
  await git(module, "commit", "-qm", "base dependency spec")

  await git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", module, "dep")
  await writeFile(
    join(repo, "package.json"),
    `${JSON.stringify({ private: true, dependencies: { fixture: "1.0.0" } })}\n`,
  )
  await writeFile(join(repo, "bun.lock"), '{"fixture":"1.0.0"}\n')
  await git(repo, "add", ".gitmodules", "dep", "package.json", "bun.lock")
  await git(repo, "commit", "-qm", "pin dependency base")
  const baseSha = await git(repo, "rev-parse", "HEAD")

  if (options.manifestChange === false) {
    await writeFile(join(module, "README.md"), "documentation only\n")
    await git(module, "add", "README.md")
    await git(module, "commit", "-qm", "change documentation only")
  } else {
    await writeFile(join(module, "package.json"), `${JSON.stringify({ dependencies: { fixture: "2.0.0" } })}\n`)
    await git(module, "add", "package.json")
    await git(module, "commit", "-qm", "change dependency spec")
  }
  const targetSha = await git(module, "rev-parse", "HEAD")
  await git(join(repo, "dep"), "fetch", "-q", "origin")
  await git(join(repo, "dep"), "checkout", "-q", targetSha)
  await git(repo, "add", "dep")
  const treeSha = await git(repo, "write-tree")
  const provisionalCandidateSha = await git(
    repo,
    "commit-tree",
    treeSha,
    "-p",
    baseSha,
    "-m",
    "provisional pin candidate",
  )
  return { repo, baseSha, provisionalCandidateSha }
}

async function fixtureBun(
  repo: string,
  install: readonly string[],
  postinstall: readonly string[] = ["exit 64"],
): Promise<string> {
  const fixtureBin = join(repo, "..", "bin")
  await mkdir(fixtureBin, { recursive: true })
  await writeFile(
    join(fixtureBin, "bun"),
    [
      "#!/bin/sh",
      'if [ "$1" = "install" ]; then',
      ...install.map((line) => `  ${line}`),
      "fi",
      'if [ "$1" = "run" ] && [ "$2" = "typecheck" ]; then',
      "  test -f node_modules/.provisioned",
      "  exit",
      "fi",
      'if [ "$1" = "run" ] && [ "$2" = "postinstall" ]; then',
      ...postinstall.map((line) => `  ${line}`),
      "fi",
      "exit 64",
      "",
    ].join("\n"),
    { mode: 0o755 },
  )
  return fixtureBin
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

/** A branch whose own delta touches no gitlink, submitted after main bumped an
 * unrelated submodule pin. The change's recorded base is current main, so a two-dot
 * diff from it reports main's pin move as this branch reverting the pin — while
 * the branch's authored delta, measured from where it actually diverged, has no
 * gitlink in it at all. */
async function staleBaseUnrelatedPinRepository(): Promise<{
  repo: string
  branch: string
  basePin: string
  advancedPin: string
}> {
  const root = await mkdtemp(join(tmpdir(), "yrd-stale-base-unrelated-pin-"))
  roots.push(root)
  const moduleRemote = join(root, "module.git")
  const module = join(root, "module")
  const rootRemote = join(root, "root.git")
  const repo = join(root, "repo")
  const branch = "issue/tent-scripts"

  await initBareMain(root, moduleRemote)
  await git(root, "init", "-q", "-b", "main", module)
  await git(module, "config", "user.name", "Yrd Test")
  await git(module, "config", "user.email", "yrd@example.invalid")
  await git(module, "remote", "add", "origin", moduleRemote)
  await writeFile(join(module, "README.md"), "submodule base\n")
  await git(module, "add", "README.md")
  await git(module, "commit", "-qm", "submodule base")
  await git(module, "push", "-qu", "origin", "main")
  const basePin = await git(module, "rev-parse", "HEAD")

  await initBareMain(root, rootRemote)
  await git(root, "init", "-q", "-b", "main", repo)
  await git(repo, "config", "user.name", "Yrd Test")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await git(repo, "config", "protocol.file.allow", "always")
  await git(repo, "remote", "add", "origin", rootRemote)
  await installDeclaredYrdEntry(repo)
  await writeFile(join(repo, "README.md"), "root\n")
  await writeFile(
    join(repo, ".yrd.yml"),
    `base: main
batch: 1
checks: [{check: {run: "true"}}]
`,
  )
  await git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", moduleRemote, "dep")
  await git(repo, "add", "README.md", ".yrd.yml", ".gitmodules", "dep", "bin/yrd")
  await git(repo, "commit", "-qm", "published root base")
  await git(repo, "push", "-qu", "origin", "main")

  await git(repo, "switch", "-qc", branch)
  await mkdir(join(repo, "tools"), { recursive: true })
  await writeFile(join(repo, "tools", "watch.ts"), "export const watch = true\n")
  await git(repo, "add", "tools/watch.ts")
  await git(repo, "commit", "-qm", "wire the watcher script")
  await git(repo, "push", "-qu", "origin", branch)
  await git(repo, "switch", "-q", "main")

  // Main moves on under the branch: an unrelated submodule pin advances and
  // merges, with no involvement from the branch.
  await writeFile(join(module, "README.md"), "submodule advanced\n")
  await git(module, "add", "README.md")
  await git(module, "commit", "-qm", "advance the submodule")
  await git(module, "push", "-q", "origin", "main")
  const advancedPin = await git(module, "rev-parse", "HEAD")
  await git(join(repo, "dep"), "fetch", "-q", "origin", "main")
  await git(join(repo, "dep"), "checkout", "-q", advancedPin)
  await git(repo, "add", "dep")
  await git(repo, "commit", "-qm", "advance the dep pin on main")
  await git(repo, "push", "-q", "origin", "main")
  return { repo, branch, basePin, advancedPin }
}

async function unpublishedSubmodulePinRepository(): Promise<{
  repo: string
  rootRemote: string
  moduleRemote: string
  branch: string
  pin: string
}> {
  const root = await mkdtemp(join(tmpdir(), "yrd-unpublished-submodule-pin-"))
  roots.push(root)
  const moduleRemote = join(root, "module.git")
  const module = join(root, "module")
  const rootRemote = join(root, "root.git")
  const repo = join(root, "repo")
  const branch = "issue/unpublished-submodule-pin"

  await initBareMain(root, moduleRemote)
  await git(root, "init", "-q", "-b", "main", module)
  await git(module, "config", "user.name", "Yrd Test")
  await git(module, "config", "user.email", "yrd@example.invalid")
  await git(module, "remote", "add", "origin", moduleRemote)
  await writeFile(join(module, "README.md"), "published\n")
  await git(module, "add", "README.md")
  await git(module, "commit", "-qm", "published module base")
  await git(module, "push", "-qu", "origin", "main")

  await initBareMain(root, rootRemote)
  await git(root, "init", "-q", "-b", "main", repo)
  await git(repo, "config", "user.name", "Yrd Test")
  await git(repo, "config", "user.email", "yrd@example.invalid")
  await git(repo, "config", "protocol.file.allow", "always")
  await git(repo, "remote", "add", "origin", rootRemote)
  await installDeclaredYrdEntry(repo)
  await writeFile(join(repo, "README.md"), "root\n")
  await writeFile(
    join(repo, ".yrd.yml"),
    `base: main
batch: 1
checks: [{check: {run: "true"}}]
`,
  )
  await git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", moduleRemote, "dep")
  await git(repo, "add", "README.md", ".yrd.yml", ".gitmodules", "dep", "bin/yrd")
  await git(repo, "commit", "-qm", "published root base")
  await git(repo, "push", "-qu", "origin", "main")
  await git(repo, "switch", "-qc", branch)

  await writeFile(join(repo, "dep", "local-only.txt"), "not published\n")
  await git(join(repo, "dep"), "add", "local-only.txt")
  await git(join(repo, "dep"), "commit", "-qm", "local-only submodule work")
  const pin = await git(join(repo, "dep"), "rev-parse", "HEAD")
  await git(repo, "add", "dep")
  await git(repo, "commit", "-qm", "point at local-only submodule work")
  return { repo, rootRemote, moduleRemote, branch, pin }
}

describe("createDefaultYrdApp", { timeout: 20_000 }, () => {
  it("derives a deterministic checkpoint manifest that a queue-config change does not move", async () => {
    const { repo } = await repository()
    await using runtimeProcess = createProcess({ cwd: repo })
    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      steps: ["check", "merge"],
      requires: [],
      definitions: { check: { run: "true", runner: "local" }, merge: { runner: "local" } },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["check"] },
    }
    const options = {
      repo,
      stateDir: join(repo, ".git", "yrd"),
      baysRoot: join(repo, ".bays"),
      process: runtimeProcess,
      config,
    }

    const first = await createDefaultYrdCheckpointMigrationAttestation(options)
    const repeated = await createDefaultYrdCheckpointMigrationAttestation(options)
    const changed = await createDefaultYrdCheckpointMigrationAttestation({
      ...options,
      config: {
        ...config,
        steps: ["check", "other", "merge"],
        definitions: { ...config.definitions, other: { run: "true", runner: "local" } },
      },
    })

    expect(repeated).toEqual(first)
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/u)
    expect(first.manifest.targetIdentity).toMatch(/^[0-9a-f]{64}$/u)
    // The checkpoint composition identity of this exact config. A refactor or
    // vocabulary rename must never move it: persisted event/state keys are
    // labels, not code vocabulary (R2752). An INTENTIONAL persisted-contract
    // change updates this constant consciously and adds a retained migration
    // edge measured from the PRODUCTION journal's stored identity (the
    // R2752/R2732 refusal prints it), never from a harness value.
    // Conscious update 2026-08-19: the props cut registers pr/props-set and
    // retires the correlation pair from every schema that carries props — an
    // intentional persisted-contract change, so the identity moves and the
    // correlation-era predecessor gains a retained edge below.
    // Conscious update 2026-08-23 (23192): `QueuesState.defaultSteps` is
    // DELETED and every Run now records the plan git declared at its base sha
    // (`source`, `baseSha`, `configBlobSha` on `stepSelection`). Both are
    // persisted-contract changes, so the identity moves once, deliberately.
    // While the step list lived in `initialState`, an ordinary `.yrd.yml`
    // checks edit was indistinguishable from a schema change — it invalidated
    // every stored checkpoint and refused any Candidate carrying it with
    // `checkpoint-migration-certificate-missing`, so the declared check could
    // not be adopted at all.
    // Conscious update 2026-08-25 (5e cuts 1+4): the terminal-associations
    // back-fill cut removes the pr/terminal-associated event and the
    // queues.terminalAssociations state container, and the change-record fat
    // cut removes the never-written pr/regression-recorded event, so the
    // identity moves and the production predecessor ae0d2084 (measured from
    // the live journal's stored checkpoint_identity, cursor 90900) gains a
    // retained edge below. The cut-1 interim identity fe430448 was never
    // stored by any deployment, so it is deliberately NOT retained.
    // Conscious update 2026-08-25: the live deployment reached 36d85bbb
    // before its checkpoint's retired nested `regressions` field was found.
    // Bumping the bays projector version creates a real forward repair edge;
    // all earlier edges retain their historical 36d85bbb successor.
    // Conscious update 2026-08-26 (22991 phase 2, first store-deletion door):
    // `queues.authority.statuses` — the stored per-change copy of
    // ChangeDeliveryState — leaves `initialState`, so the identity moves once
    // and the production predecessor 701431d5 (measured from the live
    // journal's stored checkpoint_identity, cursor 92592, read-only
    // 2026-08-26) gains a retained edge below.
    // Conscious update 2026-08-28 (bd1c0b88, `CandidateChange.containedInBase`):
    // an OPTIONAL schema field still changes the accepted input shape the
    // identity hashes, so the identity moves once even though no stored record
    // needs rewriting. The predecessor 381cdb9e — what shared main's vendor pin
    // 18d9b83dbb19 computes, and the ledger's own superseded last entry — gains
    // a retained edge below.
    // Conscious update 2026-08-30 (@i/10-yrd/absent-branch-is-terminal): the
    // queue retires a standing submit fact whose candidate cannot merge.
    // Three inputs move the identity at once and none rewrites a stored
    // record — `queues.retiredSubmits` in initialState, the registered
    // `queue/submit/retired` event, and `Candidate.conflicts` as another
    // optional key in an accepted input shape. The predecessor 74775b57 —
    // the ledger's own superseded last entry — gains a retained edge below.
    // Conscious update 2026-08-31 (the no-parking ruling): two schema
    // widenings move the identity together. Lease recovery reclaims a WAITING
    // job whose runner is dead, so the `lose` Job transition gains an optional
    // `token` with `leaseExpiresAt` optional beside it; and the reject class
    // reads the check's own judgment, so `queue/admission/refused` gains an
    // optional `judgedFailure`. All three are optional keys in accepted input
    // shapes, exactly the identity input `CandidateChange.containedInBase`
    // records above. No stored record needs rewriting: every `lose` ever
    // journaled carries `leaseExpiresAt` and no `token`, no refusal fact
    // carries `judgedFailure`, and the widened schemas accept both. The
    // predecessor 1d285ebf — the ledger's own superseded last entry — gains a
    // retained edge.
    // Conscious update 2026-09-01: pre-Candidate derived identities add the
    // empty `queues.derivedIdentities` projection and its binding event. The
    // former target fd6a78df is retained.
    // Conscious update 2026-09-01 (journal-v4 reader PREP): Job, Bay, and Queue
    // schemas accept narrowly field-gated v4 markers, Jobs advances to v9,
    // and Queue advances to v13 for their replay semantics. The writer remains
    // v3. Existing checkpoint state needs no rewrite, but accepted schemas and
    // the projector versions move the identity, so former target 3f8a2627 is
    // retained.
    // Conscious update 2026-09-01 (@i/10-yrd/24028): the queue registers one
    // new event, `queue/attempt/notified`, projected into a new
    // `queues.outcomes` record (queues-v14), and the derived submit fact gains
    // an optional `notify` seat — a registered event and a widened accepted
    // shape both move the identity; former target 7ea283b8 is retained.
    const previousTargetIdentity = "36d85bbb8b59e8a3c6c327b8f14f643816d951cd003904ac0acbe0bbca150691"
    expect(first.manifest.targetIdentity).toBe("ca7e3d9577514291a125a9b003182b400f8495f79c2187f9aefea318d457ba56")
    expect(first.manifest.edges).toContainEqual({
      from: "fe5e818396dd2c5f9bab6191ab0dd882d9ee584046c618463b4583ff724effe8",
      to: previousTargetIdentity,
    })
    expect(first.manifest.edges).toContainEqual({
      from: "0a3476ef91823d46f19770047a4e6462c970c5afc250cba9dd82eb31c5febc25",
      to: previousTargetIdentity,
    })
    // The PRODUCTION composition's correlation-era identity (measured from the
    // live journal's stored checkpoint, 2026-08-19 — see the retained list's
    // own comment). Its edge is what lets a deployment cross the props cut.
    expect(first.manifest.edges).toContainEqual({
      from: "227fed2369cdf2a8f3c6a0b63a61bff97d7a46dd60a1fdd7c782ed3b4f69f5e5",
      to: previousTargetIdentity,
    })
    // The PRODUCTION composition's identity immediately before branch-is-change
    // phase 2a (measured from the live journal 2026-08-21 — see the retained
    // list's own comment). Its edge is what lets a deployment cross into the
    // `branch/*` events and `bays.submits`.
    expect(first.manifest.edges).toContainEqual({
      from: "61773b43456a2943913a6514131c04502a9d26baadedfcf28e4c12bf6d746d37",
      to: previousTargetIdentity,
    })
    // Production journal stored identity 2026-08-22 (cursor 76950,
    // evictedThrough 27609). Missing this edge is the live
    // checkpoint-migration-missing pair f41d7eff→0150a374.
    expect(first.manifest.edges).toContainEqual({
      from: "f41d7efff8a3d2eb53b47ae8ab6ca3cf4058e2c37ff325a35c848efea94f9fcd",
      to: previousTargetIdentity,
    })
    // Production journal stored identity 2026-08-23, measured from the live
    // refusal 348ade4e→288eb203 (history evicted through cursor 27609). Its
    // edge is what lets a deployment cross the cut that took the declared step
    // list out of `initialState`.
    expect(first.manifest.edges).toContainEqual({
      from: "348ade4e2dbe135e789387756816d753858f037668bb3a121cb2719802b3b598",
      to: previousTargetIdentity,
    })
    // The interim identity the live journal then ADVANCED TO, measured from its
    // own refusal 288eb203→ae0d2084. A predecessor is whatever the deployment
    // stores, not whatever merged on main.
    expect(first.manifest.edges).toContainEqual({
      from: "288eb2031f0ae914db51e4fca58add50aa39397abd773be99e81d9a35c06e817",
      to: previousTargetIdentity,
    })
    // Production journal stored identity 2026-08-25 (cursor 90900), the
    // composition immediately before the terminal-associations back-fill cut
    // (5e cut 1). Its edge is what carries the deployment across that cut.
    expect(first.manifest.edges).toContainEqual({
      from: "ae0d2084bdb1202cf8205a03b4d09ccf915bcccf197e90afbe62617e7c078839",
      to: previousTargetIdentity,
    })
    // Production journal stored identity 2026-08-26 (cursor 92592), the
    // composition immediately before 22991 phase 2's statuses cut. Its edge
    // is what carries the deployment across that cut.
    expect(first.manifest.edges).toContainEqual({
      from: "701431d5952e57f998e77413fe6c79dfede32f203863a5ff163b07b704ab6c25",
      to: previousTargetIdentity,
    })
    // The composition at shared main's vendor pin 18d9b83dbb19 — the identity
    // the running yrd-runner is asked to store today. Its edge is what carries
    // the live deployment across the containedInBase bump; without it a boot
    // on this code refuses with checkpoint-migration-missing, and eviction
    // (history_evicted_through 27609) makes that terminal.
    expect(first.manifest.edges).toContainEqual({
      from: "381cdb9edee92b0988087ae0fab8bb365b59069224ef47dc6b881dbde735808c",
      to: previousTargetIdentity,
    })
    expect(first.manifest.edges).toContainEqual({
      from: "3f8a2627fde94c410a98beaed80e2198298baea1fb8a5b533f3e71231e8faafa",
      to: previousTargetIdentity,
    })
    expect(first.manifest.edges).toContainEqual({
      from: previousTargetIdentity,
      to: first.manifest.targetIdentity,
    })
    // The door cannot run twice: nothing migrates OUT of the current identity,
    // so a checkpoint already at the target never takes an edge.
    expect(first.manifest.edges.some((edge) => edge.from === first.manifest.targetIdentity)).toBe(false)
    // 23192: a queue-CONFIG change must NOT move the projection identity.
    // While the declared step list sat in `initialState` it did, and an
    // ordinary `.yrd.yml` checks edit then demanded a checkpoint migration
    // certificate no operator can produce for one — discarding the stored
    // checkpoint, which a retention-evicted journal cannot replay from the
    // beginning. The identity tracks the persisted event/state contract;
    // installed steps register no per-step schema and are not part of it.
    expect(changed.manifest.targetIdentity).toBe(first.manifest.targetIdentity)
  })

  it("gates a projection-version bump at the bump: every shipped identity keeps a migration path", async () => {
    // 23217. The lock above catches that the identity MOVED; nothing until now
    // caught shipping the move without retaining the value it superseded. That
    // is a breaking change which passes every gate and stops the fleet days
    // later, on a seat that did not write it — twice for `bays` alone (v14,
    // then v15), and 7h09m of dead landing path on 2026-08-26.
    const { repo } = await repository()
    await using runtimeProcess = createProcess({ cwd: repo })
    const options = {
      repo,
      stateDir: join(repo, ".git", "yrd"),
      baysRoot: join(repo, ".bays"),
      process: runtimeProcess,
      config: {
        base: "main",
        batch: 1,
        steps: ["check", "merge"],
        requires: [],
        definitions: { check: { run: "true", runner: "local" }, merge: { runner: "local" } },
        contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["check"] },
      } satisfies ResolvedYrdProjectConfig,
    }
    const { manifest } = await createDefaultYrdCheckpointMigrationAttestation(options)

    // The ledger's last entry is the identity this source computes, so the
    // lock above and the ledger can never drift apart unnoticed.
    expect(SHIPPED_CHECKPOINT_IDENTITIES.at(-1)).toBe(manifest.targetIdentity)
    // THE GATE. Green means every identity we have shipped can still reach the
    // current one. A bump that forgets its edge turns this red before it ships.
    expect(checkpointBumpGateViolations(manifest)).toEqual([])

    // A bump, simulated on the REAL manifest rather than a toy graph: the
    // target moves, and the edges that carried no explicit `to` re-resolve onto
    // the new target exactly as `checkpointMigrationManifest` resolves them.
    // What does NOT follow is an edge out of the identity we just superseded —
    // which is precisely the defect, and precisely what nothing refuses today.
    const bumped = "9".repeat(64)
    const afterBump = {
      ...manifest,
      targetIdentity: bumped,
      edges: manifest.edges.map((edge) => (edge.to === manifest.targetIdentity ? { ...edge, to: bumped } : edge)),
    }
    const violations = checkpointBumpGateViolations(afterBump, [...SHIPPED_CHECKPOINT_IDENTITIES, bumped])
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain(`shipped checkpoint identity '${manifest.targetIdentity}'`)
    expect(violations[0]).toContain("refuses at startup with checkpoint-migration-missing")

    // And the gate accepts the fix it asks for: retain the superseded identity.
    // That costs no identity change, because migrations are not an input to
    // `projectionCheckpointIdentity` — which is why the remedy is always cheap
    // and is only ever expensive once a deployment has already refused.
    const repaired = {
      ...afterBump,
      edges: [...afterBump.edges, { from: manifest.targetIdentity, to: bumped }],
    }
    expect(checkpointBumpGateViolations(repaired, [...SHIPPED_CHECKPOINT_IDENTITIES, bumped])).toEqual([])

    // A bump that is not recorded at all is the cheaper mistake, and is caught
    // by the other half of the gate.
    expect(checkpointBumpGateViolations(afterBump)[0]).toContain("SHIPPED_CHECKPOINT_IDENTITIES")

    // The ledger's own documented gap, measured rather than asserted in prose.
    // These five identities this composition shipped before the gate existed
    // have no path today, which is exactly why they are not in the ledger — a
    // gate seeded with them would be red on arrival and get switched off.
    // WHEN ONE OF THESE BECOMES REACHABLE this goes red: that is the ratchet
    // working. Move it into SHIPPED_CHECKPOINT_IDENTITIES, in date order, and
    // delete it from here and from the ledger's gap comment.
    for (const stranded of [
      "b45cdd9c3cb1e83752bb472a0b1ecb50505abc6670786a4ee8e2f95fef30acd4",
      "690704d679947c4814c3cbd024dc08f91f03959dc4a340f4d3f2ad24ea23f8c7",
      "5d25a0aa9aeef5425421ce6d640804d360e5cfdb3b333ae4337d3e56513e5f5d",
      "2267a28ea7be952a07e1d3fa351a7d8e2112a810af227229364617749518f32f",
      "fe430448d3a1ce0f2af9d118335b8947a75a0e9b40684bedbbb2c77b12ef3744",
    ]) {
      expect(SHIPPED_CHECKPOINT_IDENTITIES).not.toContain(stranded)
      expect(checkpointBumpGateViolations(manifest, [stranded, manifest.targetIdentity])).toHaveLength(1)
    }
  })

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
    // This assertion used to read "every toolchain fingerprint submodule",
    // which made 22374 a passing test rather than a caught bug: `bun` and
    // `node` name whichever binary invoked yrd, so one host with two bun
    // installs minted two permanent revision families and the habitant and its
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
    expect(CURRENT_JOURNAL_COMPATIBILITY).toEqual({ version: 3 })

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
      expect.objectContaining({ compatibility: { version: 3 } }),
    ])
  })

  it("installs immutable deployment requests in the default Journal-backed host", async () => {
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

    const requested = await app.deployments?.materialize({
      deploymentId: "D1",
      generation: "@dev/1#generation-1.attempt-1",
      sha: featureSha,
      pin: "tip",
    })

    expect(requested).toBeDefined()
    expect(app.jobs.getByKey("deployment:D1:materialize")).toMatchObject({
      definition: "deployment.materialize",
      status: "queued",
    })
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
          message: expect.stringContaining("yrd admin journal bump 3"),
        },
      },
    )
    await expect(Array.fromAsync(journal.read())).resolves.toEqual([])
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
    const env = {
      YRD_WRAPPER_IMPLEMENTATION_SOURCE: `git:${"6".repeat(40)}`,
      PRESERVED: "yes",
    }

    expect(takeImplementationSourceAttestation(env)).toBe(`git:${"6".repeat(40)}`)
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

  it("provisions dependencies before built-in and custom checks run in candidate worktrees (22541)", async () => {
    const { repo, featureSha } = await candidatePackageRepository()

    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      steps: ["typecheck", "lint"],
      requires: [],
      definitions: {
        typecheck: { run: "bun run typecheck", runner: "local" },
        lint: { run: "bun run lint", runner: "local" },
      },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["typecheck"] },
    }
    const provisioned: string[] = []
    await using runtimeProcess = createProcess({ cwd: repo })
    const process = {
      run(request: ProcessRequest): Promise<ProcessResult> {
        if (request.argv.join(" ") !== "bun install --frozen-lockfile --ignore-scripts") {
          return runtimeProcess.run(request)
        }
        if (request.cwd === undefined) throw new Error("candidate provisioning requires a working directory")
        provisioned.push(request.cwd)
        return runtimeProcess.run({
          ...request,
          argv: ["sh", "-c", "mkdir -p node_modules && : > node_modules/.provisioned"],
        })
      },
    }
    await using app = await createDefaultYrdApp({
      repo,
      stateDir: join(repo, ".git", "yrd"),
      baysRoot: join(repo, ".bays"),
      journal: createMemoryJournal(),
      process,
      config,
    })
    await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const run = (await app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 }))[0]

    expect(provisioned).toHaveLength(2)
    expect(run).toMatchObject({ status: "completed", conclusion: "success" })
    expect(new Set(provisioned)).toHaveLength(1)
  })

  it("regenerates a manifest-changing pin lockfile before the candidate identity is fixed", async () => {
    const { repo, baseSha, provisionalCandidateSha } = await manifestChangingPinRepository()
    const requests: string[][] = []
    await using runtimeProcess = createProcess({ cwd: repo })
    const process = {
      async run(request: ProcessRequest): Promise<ProcessResult> {
        requests.push([...request.argv])
        if (request.argv[0] !== "bun") return runtimeProcess.run(request)
        if (request.argv.includes("--frozen-lockfile")) {
          return {
            exitCode: 1,
            signal: null,
            stdout: "",
            stderr: "error: lockfile had changes, but lockfile is frozen",
            durationMs: 1,
            timedOut: false,
          }
        }
        if (request.cwd === undefined) throw new Error("pin provisioning has no candidate workspace")
        await writeFile(join(request.cwd, "bun.lock"), '{"fixture":"2.0.0"}\n')
        return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 1, timedOut: false }
      },
    } satisfies Pick<Process, "run">
    const artifactRoot = join(repo, ".git", "yrd", "artifacts")
    const materialized: string[] = []
    const provision = createPinIntentProvisioner({
      process,
      repo,
      artifactRoot,
      materializeSubmodules(path) {
        materialized.push(path)
        return Promise.resolve()
      },
    })

    const result = await provision({
      path: repo,
      baseSha,
      provisionalCandidateSha,
    })

    expect(result).toEqual({ generatedPaths: ["bun.lock"] })
    expect(materialized).toEqual([repo])
    expect(requests.filter((argv) => argv[0] === "bun")).toEqual([
      ["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
      ["bun", "install", "--ignore-scripts"],
    ])
    expect(await readFile(join(repo, "bun.lock"), "utf8")).toBe('{"fixture":"2.0.0"}\n')
    const disclosures = await readdir(join(artifactRoot, "lockfile-regeneration"))
    expect(disclosures).toHaveLength(1)
    const disclosure = JSON.parse(
      await readFile(join(artifactRoot, "lockfile-regeneration", disclosures[0]!), "utf8"),
    ) as { changedSubmoduleManifests: string[]; lockfileChanged: boolean }
    expect(disclosure).toMatchObject({
      changedSubmoduleManifests: ["dep/package.json"],
      lockfileChanged: true,
    })
  })

  it("leaves the lockfile untouched when a pin changes no dependency manifest", async () => {
    const { repo, baseSha, provisionalCandidateSha } = await manifestChangingPinRepository({
      manifestChange: false,
    })
    await using process = createProcess({ cwd: repo })
    const provision = createPinIntentProvisioner({
      process,
      repo,
      artifactRoot: join(repo, ".git", "yrd", "artifacts"),
      materializeSubmodules: () => Promise.resolve(),
    })

    await expect(provision({ path: repo, baseSha, provisionalCandidateSha })).resolves.toEqual({
      generatedPaths: [],
    })
    await expect(readFile(join(repo, "bun.lock"), "utf8")).resolves.toBe('{"fixture":"1.0.0"}\n')
  })

  it("inspects submodules in the quarantined pre-submit checkout before provisioning (22755)", async () => {
    const { repo, featureSha } = await candidatePackageRepository()

    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      steps: ["typecheck"],
      requires: [],
      definitions: { typecheck: { run: "bun run typecheck", runner: "local" } },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["typecheck"] },
    }
    const calls: string[][] = []
    await using runtimeProcess = createProcess({ cwd: repo })
    const process = {
      run(request: ProcessRequest): Promise<ProcessResult> {
        calls.push([...request.argv])
        if (request.argv.join(" ") !== "bun install --frozen-lockfile --ignore-scripts") {
          return runtimeProcess.run(request)
        }
        return runtimeProcess.run({
          ...request,
          argv: ["sh", "-c", "mkdir -p node_modules && : > node_modules/.provisioned"],
        })
      },
    }
    const stateDir = join(repo, ".git", "yrd")
    await mkdir(stateDir, { recursive: true })
    const checks = configuredChecks(process, stateDir, config, { PATH: globalThis.process.env.PATH })

    const result = await checks.run("typecheck", repo, { ref: featureSha, keepOnFailure: true })
    expect(result.exitCode).toBe(0)
    expect(await readdir(join(stateDir, "pre-submit-worktrees"))).toEqual([])

    // The hook quarantine on 'git worktree add' (4a5419f) also silences the hook
    // that populated submodules, so the checkout must populate them explicitly —
    // as quarantined plumbing — or every submodule-backed workspace member is
    // missing and provisioning fails with 'workspace:* failed to resolve'.
    const addIndex = calls.findIndex((argv) => argv.includes("worktree") && argv.includes("add"))
    expect(addIndex).toBeGreaterThanOrEqual(0)
    const installIndex = calls.findIndex((argv) => argv.join(" ") === "bun install --frozen-lockfile --ignore-scripts")
    expect(installIndex).toBeGreaterThan(addIndex)
    const inspectIndex = calls.findIndex(
      (argv, index) =>
        index > addIndex && index < installIndex && argv.includes("cat-file") && argv.includes("HEAD:.gitmodules"),
    )
    expect(inspectIndex, "no submodule inspection between checkout and provisioning").toBeGreaterThan(addIndex)
    const inspect = calls[inspectIndex] ?? []
    expect(
      inspect.some((argument) => argument === "core.hooksPath=/dev/null"),
      "submodule inspection must keep the hook quarantine",
    ).toBe(true)
  })

  it("composes a stale candidate onto current base before a required check judges ancestry", async () => {
    const { repo, featureSha, baseSha } = await staleBaseCandidateRepository()
    // The literal assertion tools/manifest-co-change.ts makes, and the one that
    // refused PR908: correct against a composed candidate, false against a raw
    // branch tip whose base merely moved.
    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      steps: ["manifest-co-change"],
      requires: [],
      definitions: {
        "manifest-co-change": {
          run:
            'printf "candidate %s\\n" "$YRD_CANDIDATE_SHA"; ' +
            'git merge-base --is-ancestor "$YRD_BASE_SHA" "$YRD_CANDIDATE_SHA" || { ' +
            'printf "manifest-co-change: YRD_BASE_SHA %s is not an ancestor of candidate %s\\n" ' +
            '"$YRD_BASE_SHA" "$YRD_CANDIDATE_SHA" >&2; exit 1; }',
          runner: "local",
        },
      },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["manifest-co-change"] },
    }
    await using process = createProcess({ cwd: repo })
    const checks = configuredChecks(process, join(repo, ".git", "yrd"), config, {
      PATH: globalThis.process.env.PATH,
    })

    const result = await checks.run("manifest-co-change", repo, { ref: featureSha })

    expect(result.stderr).toBe("")
    expect(result.exitCode).toBe(0)
    const composed = /candidate ([0-9a-f]{40})/u.exec(result.stdout)?.[1]
    expect(composed, result.stdout).toBeDefined()
    // The check judged a composition, not the branch tip: base is an ancestor of
    // it and the branch tip is not it.
    expect(composed).not.toBe(featureSha)
    await git(repo, "merge-base", "--is-ancestor", baseSha, composed!)
    await git(repo, "merge-base", "--is-ancestor", featureSha, composed!)
    // The control for the refusals below: an ordinary stale candidate STILL
    // gets a real pair, so those refusals fire on the degenerate range and not
    // on staleness. Both variables named the same commit on
    // `task/hub-yrd-split-brain`; here they cannot.
    expect(composed).not.toBe(baseSha)
  })

  it("refuses a required check whose composition would collapse onto the base, before the check runs", async () => {
    const { repo, candidateSha, baseSha } = await landedCandidateRepository()
    const marker = join(repo, "the-check-ran.marker")
    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      steps: ["substrate-pair"],
      requires: [],
      // Any check reading the pair as a range measures nothing here. This one
      // records that it ran at all, which is the assertion that matters: a
      // verdict computed from X..X must not exist.
      definitions: { "substrate-pair": { run: `touch ${marker}`, runner: "local" } },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["substrate-pair"] },
    }
    await using process = createProcess({ cwd: repo })
    const stateDir = join(repo, ".git", "yrd")
    const checks = configuredChecks(process, stateDir, config, { PATH: globalThis.process.env.PATH })

    let failure: unknown
    try {
      await checks.run("substrate-pair", repo, { ref: "issue/feature" })
    } catch (cause) {
      failure = cause
    }

    const classified = classifyFailure(failure)
    expect(classified).toMatchObject({
      exitCode: 1,
      failure: { kind: "refusal", code: "required-check-degenerate-range" },
    })
    // Both shas by name, so the reader can see the collapse without re-deriving
    // it, and the cure — the half a bare "check failed" withholds.
    const message = (classified as { failure: { message: string } }).failure.message
    expect(message).toContain(candidateSha)
    expect(message).toContain(baseSha)
    expect(message).toContain("no candidate range")
    expect(message).toContain("commit the work this branch is meant to carry")
    expect(existsSync(marker), "the check must not run on an empty range").toBe(false)
    // Refused BEFORE the checkout, so nothing was spent materializing a
    // candidate that could not be measured. Asserted as "no workspace exists"
    // rather than "the workspace parent is absent": where the parent gets
    // created is an implementation detail, and none being materialized is the
    // claim.
    const workspaces = join(stateDir, "pre-submit-worktrees")
    expect(existsSync(workspaces) ? await readdir(workspaces) : []).toEqual([])
  })

  it("refuses a composition that produced the base itself when the containment probe could not answer", async () => {
    const { repo, candidateSha, baseSha } = await landedCandidateRepository()
    const marker = join(repo, "the-check-ran.marker")
    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      steps: ["substrate-pair"],
      requires: [],
      definitions: { "substrate-pair": { run: `touch ${marker}`, runner: "local" } },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["substrate-pair"] },
    }
    await using runtimeProcess = createProcess({ cwd: repo })
    // `isAncestorCommit` reads any non-zero exit as "not an ancestor", so a git
    // that ERRORED rather than answered sends the containment probe's caller
    // down the composing path. That is the one way past the refusal above, and
    // this is the assertion that the invariant still holds there.
    const process = {
      run(request: ProcessRequest): Promise<ProcessResult> {
        const containmentProbe =
          request.argv.includes("--is-ancestor") &&
          request.argv.at(-2) === candidateSha &&
          request.argv.at(-1) === baseSha
        if (!containmentProbe) return runtimeProcess.run(request)
        return runtimeProcess.run({ ...request, argv: ["sh", "-c", 'printf "fatal: fixture\\n" >&2; exit 128'] })
      },
    }
    const stateDir = join(repo, ".git", "yrd")
    await mkdir(stateDir, { recursive: true })
    const checks = configuredChecks(process, stateDir, config, { PATH: globalThis.process.env.PATH })

    let failure: unknown
    try {
      await checks.run("substrate-pair", repo, { ref: "issue/feature" })
    } catch (cause) {
      failure = cause
    }

    const classified = classifyFailure(failure)
    expect(classified).toMatchObject({
      // Infrastructure, not a refusal: Yrd's own probe disagreed with Yrd's own
      // merge, and there is nothing here for the author to repair. Exit 3 is
      // that classification's own code, so the exit distinguishes it from the
      // author-actionable refusal without reading the message.
      exitCode: 3,
      failure: { kind: "infrastructure", code: "required-check-composition-degenerate" },
    })
    expect((classified as { failure: { message: string } }).failure.message).toContain(baseSha)
    expect(existsSync(marker), "the check must not run on an empty range").toBe(false)
    expect(await readdir(join(stateDir, "pre-submit-worktrees"))).toEqual([])
  })

  it("refuses a carrier whose tip is the base itself, and still runs the same check for a local reading", async () => {
    const { repo } = await repository()
    await git(repo, "switch", "-q", "main")
    const baseSha = await git(repo, "rev-parse", "HEAD")
    await git(repo, "branch", "-f", "issue/feature", baseSha)
    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      steps: ["substrate-pair"],
      requires: [],
      definitions: { "substrate-pair": { run: "true", runner: "local" } },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["substrate-pair"] },
    }
    await using process = createProcess({ cwd: repo })
    const checks = configuredChecks(process, join(repo, ".git", "yrd"), config, {
      PATH: globalThis.process.env.PATH,
    })

    let failure: unknown
    try {
      await checks.run("substrate-pair", repo, { ref: "issue/feature", carrier: true })
    } catch (cause) {
      failure = cause
    }
    const classified = classifyFailure(failure)
    expect(classified).toMatchObject({
      exitCode: 1,
      failure: { kind: "refusal", code: "required-check-degenerate-range" },
    })
    expect((classified as { failure: { message: string } }).failure.message).toContain(baseSha)

    // The control, and the reason the refusal is carrier-scoped: `yrd check`
    // points at whatever tree it was given, and a tree sitting on the base is
    // an ordinary local reading rather than an empty carrier.
    const local = await checks.run("substrate-pair", repo, { ref: "issue/feature" })
    expect(local.exitCode).toBe(0)
  })

  it("overrides an inherited tmpfs TMPDIR with a run-scoped dir for an in-place check, then removes it", async () => {
    const { repo } = await repository()
    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      steps: ["tmp-probe"],
      requires: [],
      definitions: {
        "tmp-probe": {
          run:
            'test -n "$TMPDIR" && test "$TMPDIR" != "/inherited-tmpfs-probe" && ' +
            'case "$TMPDIR" in */pre-submit-worktrees/check-tmp-*) touch "$TMPDIR/probe.txt";; ' +
            '*) printf "unexpected TMPDIR %s\\n" "$TMPDIR" >&2; exit 1;; esac',
          runner: "local",
        },
      },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["tmp-probe"] },
    }
    await using process = createProcess({ cwd: repo })
    const stateDir = join(repo, ".git", "yrd")
    const checks = configuredChecks(process, stateDir, config, {
      PATH: globalThis.process.env.PATH,
      TMPDIR: "/inherited-tmpfs-probe",
    })

    // No ref, current base: the in-place path — the check runs in the
    // operator's own tree but must still get a run-scoped disk-backed TMPDIR.
    const result = await checks.run("tmp-probe", repo, {})

    expect(result.stderr).toBe("")
    expect(result.exitCode).toBe(0)
    expect(await readdir(join(stateDir, "pre-submit-worktrees"))).toEqual([])
  })

  it("gives a checkout-path check a TMPDIR inside its own workspace root, removed with it", async () => {
    const { repo, featureSha } = await staleBaseCandidateRepository()
    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      steps: ["tmp-probe"],
      requires: [],
      definitions: {
        "tmp-probe": {
          run:
            'test "$TMPDIR" != "/inherited-tmpfs-probe" && ' +
            'case "$TMPDIR" in */pre-submit-worktrees/check-*/tmp) touch "$TMPDIR/probe.txt";; ' +
            '*) printf "unexpected TMPDIR %s\\n" "$TMPDIR" >&2; exit 1;; esac',
          runner: "local",
        },
      },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["tmp-probe"] },
    }
    await using process = createProcess({ cwd: repo })
    const stateDir = join(repo, ".git", "yrd")
    const checks = configuredChecks(process, stateDir, config, {
      PATH: globalThis.process.env.PATH,
      TMPDIR: "/inherited-tmpfs-probe",
    })

    const result = await checks.run("tmp-probe", repo, { ref: featureSha })

    expect(result.stderr).toBe("")
    expect(result.exitCode).toBe(0)
    expect(await readdir(join(stateDir, "pre-submit-worktrees"))).toEqual([])
  })

  it("composes the operator's own stale branch before an explicit local check reads the tree", async () => {
    const { repo } = await staleBaseCandidateRepository()
    await git(repo, "switch", "-q", "issue/feature")
    // The watcher-wire shape: the branch's own files are fine, but the check
    // reads a tree the base has since moved under. Only composition supplies it.
    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      steps: ["typecheck"],
      requires: [],
      definitions: { typecheck: { run: "test -f feature.txt && test -f merged-after-branch.txt", runner: "local" } },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["typecheck"] },
    }
    await using process = createProcess({ cwd: repo })
    const checks = configuredChecks(process, join(repo, ".git", "yrd"), config, {
      PATH: globalThis.process.env.PATH,
    })

    // No ref: the managed pre-submit hook, and `pr submit` while sitting on the
    // branch, both merge here with the operator's own checkout as cwd.
    const result = await checks.run("typecheck", repo)

    expect(result.exitCode).toBe(0)
    // Composition never writes through the operator's checkout.
    expect(await git(repo, "status", "--porcelain")).toBe("")
    expect(await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("issue/feature")
  })

  it("prints the merge-and-resubmit remedy for a required-check composition conflict", async () => {
    const { repo } = await repository()
    await git(repo, "switch", "-q", "issue/feature")
    await writeFile(join(repo, "README.md"), "feature conflict\n")
    await git(repo, "add", "README.md")
    await git(repo, "commit", "-qm", "feature conflict")
    await git(repo, "switch", "-q", "main")
    await writeFile(join(repo, "README.md"), "main conflict\n")
    await git(repo, "add", "README.md")
    await git(repo, "commit", "-qm", "main conflict")

    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      steps: ["typecheck"],
      requires: [],
      definitions: { typecheck: { run: "true", runner: "local" } },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["typecheck"] },
    }
    await using process = createProcess({ cwd: repo })
    const checks = configuredChecks(process, join(repo, ".git", "yrd"), config, {
      PATH: globalThis.process.env.PATH,
    })

    let failure: unknown
    try {
      await checks.run("typecheck", repo, { ref: "issue/feature" })
    } catch (cause) {
      failure = cause
    }
    expect(classifyFailure(failure)).toMatchObject({
      exitCode: 1,
      failure: { kind: "refusal", code: "required-check-composition-conflict" },
    })
    const message = failure instanceof Error ? failure.message : String(failure)
    expect(message).toContain("merge base 'main' into the change's branch")
    expect(message).toContain("yrd pr submit")
  })

  it.each(["checkout", "submodule"] as const)(
    "retains and names the candidate workspace when %s materialization fails",
    async (phase) => {
      const { repo, featureSha } = await candidatePackageRepository()
      const config: ResolvedYrdProjectConfig = {
        base: "main",
        batch: 1,
        steps: ["typecheck"],
        requires: [],
        definitions: { typecheck: { run: "bun run typecheck", runner: "local" } },
        contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["typecheck"] },
      }
      await using runtimeProcess = createProcess({ cwd: repo })
      const process = {
        run(request: ProcessRequest): Promise<ProcessResult> {
          const checkoutFailure =
            phase === "checkout" && request.argv.includes("worktree") && request.argv.includes("add")
          const submoduleFailure =
            phase === "submodule" &&
            request.cwd?.includes("pre-submit-worktrees") === true &&
            request.argv.includes("submodule.alternateLocation")
          if (!checkoutFailure && !submoduleFailure) return runtimeProcess.run(request)
          return runtimeProcess.run({
            ...request,
            argv: ["sh", "-c", `printf '${phase} materialization failed\\n' >&2; exit 9`],
          })
        },
      }
      const checks = configuredChecks(process, join(repo, ".git", "yrd"), config, {
        PATH: globalThis.process.env.PATH,
      })

      let failure: unknown
      try {
        await checks.run("typecheck", repo, { ref: featureSha, keepOnFailure: true })
      } catch (cause) {
        failure = cause
      }

      expect(failure).toBeInstanceOf(Error)
      const message = (failure as Error).message
      expect(message).toContain(`${phase} materialization failed`)
      const retained = /workspace retained at '([^']+)'/u.exec(message)?.[1]
      expect(retained, message).toBeDefined()
      expect(existsSync(retained!)).toBe(true)
      if (phase === "submodule") expect(existsSync(join(retained!, "package.json"))).toBe(true)
    },
  )

  it.each([
    ["exits nonzero", 3, false],
    ["times out", 0, true],
  ] as const)("retains a required-check workspace when the check command %s", async (_label, exitCode, timedOut) => {
    const { repo, featureSha } = await candidatePackageRepository()
    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      steps: ["typecheck"],
      requires: [],
      definitions: { typecheck: { run: "bun run typecheck", runner: "local" } },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["typecheck"] },
    }
    await using runtimeProcess = createProcess({ cwd: repo })
    const process = {
      run(request: ProcessRequest): Promise<ProcessResult> {
        const command = request.argv.join(" ")
        if (command === "bun install --frozen-lockfile --ignore-scripts") {
          return runtimeProcess.run({ ...request, argv: ["sh", "-c", "mkdir -p node_modules"] })
        }
        if (command === "sh -c bun run typecheck") {
          if (timedOut) {
            return Promise.resolve({
              stdout: "",
              stderr: "typecheck timed out\n",
              exitCode,
              signal: null,
              durationMs: 1,
              timedOut,
            })
          }
          return runtimeProcess.run({
            ...request,
            argv: ["sh", "-c", `printf 'typecheck failed\\n' >&2; exit ${String(exitCode)}`],
          })
        }
        return runtimeProcess.run(request)
      },
    }
    const checks = configuredChecks(process, join(repo, ".git", "yrd"), config, {
      PATH: globalThis.process.env.PATH,
    })

    const result = await checks.run("typecheck", repo, { ref: featureSha, keepOnFailure: true })

    expect(result).toMatchObject({ exitCode, timedOut })
    expect(result.stderr).toContain(timedOut ? "typecheck timed out" : "typecheck failed")
    const retained = result.retainedWorkspace?.path
    expect(retained).toBeDefined()
    expect(existsSync(join(retained!, "package.json"))).toBe(true)
  })

  it.each([
    ["a failed dependency install", "exit", "dependency cache unavailable"],
    ["an unavailable package manager", "throw", "spawn bun ENOENT"],
  ] as const)(
    "reports %s as a retryable candidate environment refusal (22541)",
    async (_label, failureMode, expectedMessage) => {
      const { repo, featureSha } = await candidatePackageRepository()
      const config: ResolvedYrdProjectConfig = {
        base: "main",
        batch: 1,
        steps: ["typecheck"],
        requires: [],
        definitions: { typecheck: { run: "bun run typecheck", runner: "local" } },
        contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["typecheck"] },
      }
      await using runtimeProcess = createProcess({ cwd: repo })
      const process = {
        run(request: ProcessRequest): Promise<ProcessResult> {
          if (request.argv.join(" ") !== "bun install --frozen-lockfile --ignore-scripts") {
            return runtimeProcess.run(request)
          }
          if (failureMode === "throw") throw new Error(expectedMessage)
          return runtimeProcess.run({
            ...request,
            argv: ["sh", "-c", "printf 'dependency cache unavailable\\n' >&2; exit 7"],
          })
        },
      }
      await using app = await createDefaultYrdApp({
        repo,
        stateDir: join(repo, ".git", "yrd"),
        baysRoot: join(repo, ".bays"),
        journal: createMemoryJournal(),
        process,
        config,
      })
      await app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

      const run = (await app.queue.run({ prs: ["PR1"] }, { runner: "test", leaseMs: 60_000 }))[0]

      expect(run).toMatchObject({
        status: "completed",
        conclusion: "failure",
        error: {
          code: "queue-environment-refused",
          evidence: {
            kind: "check-execution-refusal",
            phase: "candidate",
            error: {
              code: "candidate-provision-failed",
              message: expect.stringContaining(expectedMessage),
            },
            retryable: true,
          },
        },
      })
    },
  )

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
        expect(currentChangeRev(restoredPR)).toMatchObject({ head: featureSha })
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

  it("adopts current batch policy while migrating a retained checkpoint", async () => {
    const { repo, featureSha } = await repository()
    const stateDir = join(repo, ".git", "yrd")
    const config = (batch: number): ResolvedYrdProjectConfig => ({
      base: "main",
      batch,
      steps: ["check", "merge"],
      requires: [],
      definitions: { check: { run: "true", runner: "local" }, merge: { runner: "local" } },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["check"] },
    })
    await using runtimeProcess = createProcess({ cwd: repo })

    const predecessor = await createDefaultYrdApp({
      repo,
      stateDir,
      baysRoot: join(repo, ".bays"),
      journal: testJournal(stateDir),
      process: runtimeProcess,
      config: config(10),
    })
    await predecessor.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
    await predecessor.queue.run({ prs: ["PR1"], steps: ["check"] }, { runner: "test", leaseMs: 60_000 })
    expect(predecessor.state().queues.batchSize).toBe(10)
    const historicalRun = Queues.values(predecessor.state().queues)[0]
    expect(historicalRun?.batchSize).toBe(10)
    await predecessor.close()

    using database = new Database(join(stateDir, "journal.sqlite"), { strict: true })
    const checkpoint = database
      .query<{ checkpoint_json: string; cursor: number }, []>(
        "SELECT checkpoint_json, cursor FROM journal_snapshot WHERE singleton = 1",
      )
      .get()
    if (checkpoint === null) throw new Error("expected predecessor projection checkpoint")
    const checkpointValue = z.record(z.string(), z.unknown()).parse(JSON.parse(checkpoint.checkpoint_json))
    expect(checkpointValue).toMatchObject({ value: { state: { queues: { batchSize: 10 } } } })
    const retainedIdentity = "0a3476ef91823d46f19770047a4e6462c970c5afc250cba9dd82eb31c5febc25"
    const retainedCheckpoint = JSON.stringify({ ...checkpointValue, identity: retainedIdentity })
    database
      .query(
        "UPDATE journal_snapshot SET checkpoint_identity = ?, checkpoint_json = ?, checkpoint_sha256 = ? WHERE singleton = 1",
      )
      .run(retainedIdentity, retainedCheckpoint, createHash("sha256").update(retainedCheckpoint).digest("hex"))
    database.close()

    await using restored = await createDefaultYrdApp({
      repo,
      stateDir,
      baysRoot: join(repo, ".bays"),
      journal: testJournal(stateDir),
      process: runtimeProcess,
      config: config(1),
    })

    expect(restored.state().bays.prs.PR1).toMatchObject({ branch: "issue/feature" })
    expect(restored.state().queues.batchSize).toBe(1)
    expect(historicalRun === undefined ? undefined : restored.queue.get(historicalRun.id)?.batchSize).toBe(10)
  })

  it("forward-repairs retired state from the deployed 36d85bbb checkpoint", async () => {
    const { repo, featureSha } = await repository()
    const stateDir = join(repo, ".git", "yrd")
    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      steps: ["check", "merge"],
      requires: [],
      definitions: { check: { run: "true", runner: "local" }, merge: { runner: "local" } },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["check"] },
    }
    await using runtimeProcess = createProcess({ cwd: repo })

    const predecessor = await createDefaultYrdApp({
      repo,
      stateDir,
      baysRoot: join(repo, ".bays"),
      journal: testJournal(stateDir),
      process: runtimeProcess,
      config,
    })
    await predecessor.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
    await predecessor.close()

    using database = new Database(join(stateDir, "journal.sqlite"), { strict: true })
    const checkpoint = database
      .query<{ checkpoint_json: string; cursor: number }, []>(
        "SELECT checkpoint_json, cursor FROM journal_snapshot WHERE singleton = 1",
      )
      .get()
    if (checkpoint === null) throw new Error("expected predecessor projection checkpoint")
    const checkpointValue = z
      .object({ value: z.object({ state: z.record(z.string(), z.unknown()) }).passthrough() })
      .passthrough()
      .parse(JSON.parse(checkpoint.checkpoint_json))
    const bays = z
      .object({ prs: z.record(z.string(), z.record(z.string(), z.unknown())) })
      .passthrough()
      .parse(checkpointValue.value.state["bays"])
    const queues = z.record(z.string(), z.unknown()).parse(checkpointValue.value.state["queues"])
    const { derivedIdentities: _modernDerivedIdentities, ...queuesAt36d } = queues
    const pr = bays.prs["PR1"]
    if (pr === undefined) throw new Error("expected predecessor PR1 projection")
    // A checkpoint written before the intent rail's deletion (2026-08-18) still carries a
    // populated `intents` slice — the shape a real intents-v1/v2 checkpoint held. Nothing reads
    // it anymore; the migrate path must drop it rather than let it leak into every future
    // checkpoint forever.
    const staleIntents = {
      records: { "yrdpin#9": { id: "yrdpin#9", status: "open", component: "vendor/yrd" } },
      order: ["yrdpin#9"],
      tombstoneRecords: {},
      tombstoneOrder: [],
      unreadable: [],
    }
    const staleRegressions = [
      {
        pr: "PR1",
        issueRef: "@yrd/regression",
        revision: 1,
        headSha: featureSha,
        run: "run-1",
        landingSha: featureSha,
        detectedAt: "2026-08-25T00:00:00.000Z",
        severity: "high",
        evidence: "retired checkpoint-only state",
        implementationRunRef: "run-1",
        reviewRef: "review-1",
        repairIssueRef: "@yrd/repair",
        repairPr: "PR2",
        repairRun: "run-2",
        repairLandingSha: featureSha,
        recordedAt: "2026-08-25T01:00:00.000Z",
      },
    ]
    const retainedIdentity = "36d85bbb8b59e8a3c6c327b8f14f643816d951cd003904ac0acbe0bbca150691"
    const retainedCheckpoint = JSON.stringify({
      ...checkpointValue,
      value: {
        ...checkpointValue.value,
        state: {
          ...checkpointValue.value.state,
          intents: staleIntents,
          bays: { ...bays, prs: { ...bays.prs, PR1: { ...pr, regressions: staleRegressions } } },
          queues: { ...queuesAt36d, terminalAssociations: { pending: {}, applied: {} } },
        },
      },
      identity: retainedIdentity,
    })
    database
      .query(
        "UPDATE journal_snapshot SET checkpoint_identity = ?, checkpoint_json = ?, checkpoint_sha256 = ? WHERE singleton = 1",
      )
      .run(retainedIdentity, retainedCheckpoint, createHash("sha256").update(retainedCheckpoint).digest("hex"))
    database.close()

    await using restored = await createDefaultYrdApp({
      repo,
      stateDir,
      baysRoot: join(repo, ".bays"),
      journal: testJournal(stateDir),
      process: runtimeProcess,
      config,
    })

    // Boot succeeds past the stale slices, and runtime state carries no trace of them.
    expect(restored.state().bays.prs.PR1).toMatchObject({ branch: "issue/feature" })
    expect(restored.state()).not.toHaveProperty("intents")
    expect(restored.state().bays.prs.PR1).not.toHaveProperty("regressions")
    expect(restored.state().queues).not.toHaveProperty("terminalAssociations")
    expect(restored.state().queues.derivedIdentities).toEqual({})
    await restored.close()

    // The drop is durable: the checkpoint THIS boot writes back to disk does not carry the
    // stale slice forward either — one migration is the only chance to shed it, since nothing
    // downstream owns the key anymore to prune it on a later pass.
    using redatabase = new Database(join(stateDir, "journal.sqlite"), { readonly: true, strict: true })
    const rewritten = redatabase
      .query<{ checkpoint_json: string }, []>("SELECT checkpoint_json FROM journal_snapshot WHERE singleton = 1")
      .get()
    if (rewritten === null) throw new Error("expected a fresh projection checkpoint after restore")
    const rewrittenValue = z
      .object({ value: z.object({ state: z.record(z.string(), z.unknown()) }).passthrough() })
      .passthrough()
      .parse(JSON.parse(rewritten.checkpoint_json))
    expect(rewrittenValue.value.state).not.toHaveProperty("intents")
    expect(rewrittenValue.value.state).not.toHaveProperty("bays.prs.PR1.regressions")
    expect(rewrittenValue.value.state).not.toHaveProperty("queues.terminalAssociations")
  })

  it("drops the stored authority.statuses copy from a 701431d5 checkpoint exactly once (22991 phase 2)", async () => {
    const { repo, featureSha } = await repository()
    const stateDir = join(repo, ".git", "yrd")
    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      steps: ["check", "merge"],
      requires: [],
      definitions: { check: { run: "true", runner: "local" }, merge: { runner: "local" } },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["check"] },
    }
    await using runtimeProcess = createProcess({ cwd: repo })

    const predecessor = await createDefaultYrdApp({
      repo,
      stateDir,
      baysRoot: join(repo, ".bays"),
      journal: testJournal(stateDir),
      process: runtimeProcess,
      config,
    })
    await predecessor.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
    await predecessor.close()

    using database = new Database(join(stateDir, "journal.sqlite"), { strict: true })
    const checkpoint = database
      .query<{ checkpoint_json: string; cursor: number }, []>(
        "SELECT checkpoint_json, cursor FROM journal_snapshot WHERE singleton = 1",
      )
      .get()
    if (checkpoint === null) throw new Error("expected predecessor projection checkpoint")
    const checkpointValue = z
      .object({ value: z.object({ state: z.record(z.string(), z.unknown()) }).passthrough() })
      .passthrough()
      .parse(JSON.parse(checkpoint.checkpoint_json))
    const queues = z.record(z.string(), z.unknown()).parse(checkpointValue.value.state["queues"])
    const authority = z.record(z.string(), z.unknown()).parse(queues["authority"])
    // The shape the production journal holds at cursor 92592: a per-change
    // ChangeDeliveryState copy beside the token facts. The live copy was
    // proven congruent with the record derivation (2084/2084) before this
    // door authored the drop.
    const retainedIdentity = "701431d5952e57f998e77413fe6c79dfede32f203863a5ff163b07b704ab6c25"
    const retainedCheckpoint = JSON.stringify({
      ...checkpointValue,
      value: {
        ...checkpointValue.value,
        state: {
          ...checkpointValue.value.state,
          queues: {
            ...queues,
            authority: { ...authority, statuses: { PR1: "submitted" } },
          },
        },
      },
      identity: retainedIdentity,
    })
    database
      .query(
        "UPDATE journal_snapshot SET checkpoint_identity = ?, checkpoint_json = ?, checkpoint_sha256 = ? WHERE singleton = 1",
      )
      .run(retainedIdentity, retainedCheckpoint, createHash("sha256").update(retainedCheckpoint).digest("hex"))
    database.close()

    await using restored = await createDefaultYrdApp({
      repo,
      stateDir,
      baysRoot: join(repo, ".bays"),
      journal: testJournal(stateDir),
      process: runtimeProcess,
      config,
    })

    // Boot succeeds past the stored copy; runtime state carries no trace of
    // it, while the token facts and the change record survive untouched.
    expect(restored.state().bays.prs.PR1).toMatchObject({ branch: "issue/feature" })
    expect(restored.state().queues.authority).not.toHaveProperty("statuses")
    expect(restored.state().queues.authority.submits).toHaveProperty("PR1")
    await restored.close()

    // Durable, and exactly once: the checkpoint written back is at the target
    // identity with no statuses key, and a SECOND boot takes no edge (nothing
    // migrates out of the target identity — the door cannot run twice).
    using redatabase = new Database(join(stateDir, "journal.sqlite"), { strict: true })
    const rewritten = redatabase
      .query<{ checkpoint_json: string; checkpoint_identity: string }, []>(
        "SELECT checkpoint_json, checkpoint_identity FROM journal_snapshot WHERE singleton = 1",
      )
      .get()
    if (rewritten === null) throw new Error("expected a fresh projection checkpoint after restore")
    expect(rewritten.checkpoint_identity).toBe("ca7e3d9577514291a125a9b003182b400f8495f79c2187f9aefea318d457ba56")
    const rewrittenValue = z
      .object({ value: z.object({ state: z.record(z.string(), z.unknown()) }).passthrough() })
      .passthrough()
      .parse(JSON.parse(rewritten.checkpoint_json))
    expect(rewrittenValue.value.state).not.toHaveProperty("queues.authority.statuses")
    redatabase.close()

    await using rebooted = await createDefaultYrdApp({
      repo,
      stateDir,
      baysRoot: join(repo, ".bays"),
      journal: testJournal(stateDir),
      process: runtimeProcess,
      config,
    })
    expect(rebooted.state().queues.authority).not.toHaveProperty("statuses")
    expect(rebooted.state().bays.prs.PR1).toMatchObject({ branch: "issue/feature" })
  })

  it("carries a 381cdb9e checkpoint — the pinned composition's — across the containedInBase bump", async () => {
    // bd1c0b88 added an OPTIONAL `CandidateChange.containedInBase`, so no
    // stored record needs rewriting and the migration callbacks have literally
    // nothing to do on a checkpoint this recent. That is precisely the bump
    // whose edge is easiest to omit — nothing fails while the migration is
    // missing, because there is no migration work to fail. Only a deployment
    // booting fails, days later, with checkpoint-migration-missing and no
    // rebuild available (history_evicted_through 27609). This exercises the
    // edge from the identity shared main's vendor pin 18d9b83dbb19 computes.
    const { repo, featureSha } = await repository()
    const stateDir = join(repo, ".git", "yrd")
    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      steps: ["check", "merge"],
      requires: [],
      definitions: { check: { run: "true", runner: "local" }, merge: { runner: "local" } },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["check"] },
    }
    await using runtimeProcess = createProcess({ cwd: repo })

    const predecessor = await createDefaultYrdApp({
      repo,
      stateDir,
      baysRoot: join(repo, ".bays"),
      journal: testJournal(stateDir),
      process: runtimeProcess,
      config,
    })
    await predecessor.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
    await predecessor.close()

    using database = new Database(join(stateDir, "journal.sqlite"), { strict: true })
    const checkpoint = database
      .query<{ checkpoint_json: string }, []>("SELECT checkpoint_json FROM journal_snapshot WHERE singleton = 1")
      .get()
    if (checkpoint === null) throw new Error("expected predecessor projection checkpoint")
    const retainedIdentity = "381cdb9edee92b0988087ae0fab8bb365b59069224ef47dc6b881dbde735808c"
    const retainedCheckpoint = JSON.stringify({
      ...z.record(z.string(), z.unknown()).parse(JSON.parse(checkpoint.checkpoint_json)),
      identity: retainedIdentity,
    })
    database
      .query(
        "UPDATE journal_snapshot SET checkpoint_identity = ?, checkpoint_json = ?, checkpoint_sha256 = ? WHERE singleton = 1",
      )
      .run(retainedIdentity, retainedCheckpoint, createHash("sha256").update(retainedCheckpoint).digest("hex"))
    database.close()

    await using restored = await createDefaultYrdApp({
      repo,
      stateDir,
      baysRoot: join(repo, ".bays"),
      journal: testJournal(stateDir),
      process: runtimeProcess,
      config,
    })
    // The stored projection crosses the bump intact — no field is invented for
    // it, because the new one is optional and simply reads "not measured".
    expect(restored.state().bays.prs.PR1).toMatchObject({ branch: "issue/feature" })
    await restored.close()

    using redatabase = new Database(join(stateDir, "journal.sqlite"), { strict: true })
    const rewritten = redatabase
      .query<{ checkpoint_identity: string }, []>(
        "SELECT checkpoint_identity FROM journal_snapshot WHERE singleton = 1",
      )
      .get()
    if (rewritten === null) throw new Error("expected a fresh projection checkpoint after restore")
    expect(rewritten.checkpoint_identity).toBe("ca7e3d9577514291a125a9b003182b400f8495f79c2187f9aefea318d457ba56")
    redatabase.close()
  })

  it("folds a correlation-era checkpoint's revision labels into props while migrating a retained checkpoint", async () => {
    const { repo, featureSha } = await repository()
    const stateDir = join(repo, ".git", "yrd")
    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      steps: ["check", "merge"],
      requires: [],
      definitions: { check: { run: "true", runner: "local" }, merge: { runner: "local" } },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["check"] },
    }
    await using runtimeProcess = createProcess({ cwd: repo })

    const predecessor = await createDefaultYrdApp({
      repo,
      stateDir,
      baysRoot: join(repo, ".bays"),
      journal: testJournal(stateDir),
      process: runtimeProcess,
      config,
    })
    await predecessor.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
    await predecessor.close()

    using database = new Database(join(stateDir, "journal.sqlite"), { strict: true })
    const checkpoint = database
      .query<{ checkpoint_json: string; cursor: number }, []>(
        "SELECT checkpoint_json, cursor FROM journal_snapshot WHERE singleton = 1",
      )
      .get()
    if (checkpoint === null) throw new Error("expected predecessor projection checkpoint")
    const checkpointValue = z
      .object({ value: z.object({ state: z.record(z.string(), z.unknown()) }).passthrough() })
      .passthrough()
      .parse(JSON.parse(checkpoint.checkpoint_json))
    // A checkpoint written before the props cut spells a revision's label as
    // the retired single `correlation: {namespace, id}` pair — the production
    // journal's stored checkpoint holds 100+ of them across pr revisions, job
    // inputs and queue records. Journal FRAMES fold at their schema read
    // boundary, but checkpoint STATE restores structurally, so the migrate
    // path itself must fold or the labels enter a process that only reads
    // `props` and go invisible to settlement and detail views forever.
    const bays = z
      .object({ prs: z.record(z.string(), z.unknown()) })
      .passthrough()
      .parse(checkpointValue.value.state["bays"])
    const pr = z
      .object({ revs: z.array(z.record(z.string(), z.unknown())) })
      .passthrough()
      .parse(bays.prs["PR1"])
    const legacyRevs = pr.revs.map(({ props: _props, ...rev }) => ({
      ...rev,
      correlation: { namespace: "tribe-request", id: "2f333586-27b7-434e-8764-6ae53ec0c468" },
    }))
    // The PRODUCTION composition's correlation-era identity — the same value
    // the retained list carries, so this test also pins that the edge a live
    // deployment needs to cross the props cut actually exists.
    const retainedIdentity = "227fed2369cdf2a8f3c6a0b63a61bff97d7a46dd60a1fdd7c782ed3b4f69f5e5"
    const retainedCheckpoint = JSON.stringify({
      ...checkpointValue,
      value: {
        ...checkpointValue.value,
        state: {
          ...checkpointValue.value.state,
          bays: { ...bays, prs: { ...bays.prs, PR1: { ...pr, revs: legacyRevs } } },
        },
      },
      identity: retainedIdentity,
    })
    database
      .query(
        "UPDATE journal_snapshot SET checkpoint_identity = ?, checkpoint_json = ?, checkpoint_sha256 = ? WHERE singleton = 1",
      )
      .run(retainedIdentity, retainedCheckpoint, createHash("sha256").update(retainedCheckpoint).digest("hex"))
    database.close()

    await using restored = await createDefaultYrdApp({
      repo,
      stateDir,
      baysRoot: join(repo, ".bays"),
      journal: testJournal(stateDir),
      process: runtimeProcess,
      config,
    })

    // Boot migrates the retained checkpoint and the fold merges each legacy
    // pair as a one-entry props map — visible to everything that reads props.
    expect(restored.state().bays.prs.PR1).toMatchObject({ branch: "issue/feature" })
    const migrated = z
      .object({ revs: z.array(z.record(z.string(), z.unknown())) })
      .passthrough()
      .parse(restored.state().bays.prs.PR1)
    for (const rev of migrated.revs) {
      expect(rev).not.toHaveProperty("correlation")
      expect(rev["props"]).toEqual({ "tribe-request": "2f333586-27b7-434e-8764-6ae53ec0c468" })
    }
    await restored.close()

    // The fold is durable: the checkpoint THIS boot writes back carries the
    // props spelling, and no correlation pair rides forward to a future one.
    using redatabase = new Database(join(stateDir, "journal.sqlite"), { readonly: true, strict: true })
    const rewritten = redatabase
      .query<{ checkpoint_json: string }, []>("SELECT checkpoint_json FROM journal_snapshot WHERE singleton = 1")
      .get()
    if (rewritten === null) throw new Error("expected a fresh projection checkpoint after restore")
    expect(rewritten.checkpoint_json.includes('"correlation"')).toBe(false)
    expect(rewritten.checkpoint_json).toContain('"tribe-request"')
  })

  it("restores the pre-branch-submits production checkpoint and gives bays its empty submits slice", async () => {
    // The PRODUCTION identity immediately before branch-is-change phase 2a
    // (retained list: 61773b43…, measured from the live journal 2026-08-21).
    // Its checkpoint predates `bays.submits` entirely. A deployment that boots
    // the 2a code must cross that edge and end up with the slice present and
    // empty — not refuse (the PR1305 outage shape), not leak `undefined` into
    // every reader of `submits`.
    const { repo, featureSha } = await repository()
    const stateDir = join(repo, ".git", "yrd")
    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      steps: ["check", "merge"],
      requires: [],
      definitions: { check: { run: "true", runner: "local" }, merge: { runner: "local" } },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["check"] },
    }
    await using runtimeProcess = createProcess({ cwd: repo })

    const predecessor = await createDefaultYrdApp({
      repo,
      stateDir,
      baysRoot: join(repo, ".bays"),
      journal: testJournal(stateDir),
      process: runtimeProcess,
      config,
    })
    await predecessor.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
    await predecessor.close()

    using database = new Database(join(stateDir, "journal.sqlite"), { strict: true })
    const checkpoint = database
      .query<{ checkpoint_json: string }, []>("SELECT checkpoint_json FROM journal_snapshot WHERE singleton = 1")
      .get()
    if (checkpoint === null) throw new Error("expected predecessor projection checkpoint")
    const checkpointValue = z
      .object({ value: z.object({ state: z.record(z.string(), z.unknown()) }).passthrough() })
      .passthrough()
      .parse(JSON.parse(checkpoint.checkpoint_json))
    const bays = z.object({ submits: z.unknown() }).passthrough().parse(checkpointValue.value.state["bays"])
    // Strip the slice the way a checkpoint written before 2a genuinely lacks it.
    const { submits: _current, ...baysBefore } = bays
    const retainedIdentity = "61773b43456a2943913a6514131c04502a9d26baadedfcf28e4c12bf6d746d37"
    const retainedCheckpoint = JSON.stringify({
      ...checkpointValue,
      value: { ...checkpointValue.value, state: { ...checkpointValue.value.state, bays: baysBefore } },
      identity: retainedIdentity,
    })
    const stripped = z
      .object({ value: z.object({ state: z.object({ bays: z.record(z.string(), z.unknown()) }).passthrough() }) })
      .passthrough()
      .parse(JSON.parse(retainedCheckpoint))
    expect(stripped.value.state.bays).not.toHaveProperty("submits")
    database
      .query(
        "UPDATE journal_snapshot SET checkpoint_identity = ?, checkpoint_json = ?, checkpoint_sha256 = ? WHERE singleton = 1",
      )
      .run(retainedIdentity, retainedCheckpoint, createHash("sha256").update(retainedCheckpoint).digest("hex"))
    database.close()

    await using restored = await createDefaultYrdApp({
      repo,
      stateDir,
      baysRoot: join(repo, ".bays"),
      journal: testJournal(stateDir),
      process: runtimeProcess,
      config,
    })
    expect(restored.state().bays.prs.PR1).toMatchObject({ branch: "issue/feature" })
    expect(restored.state().bays.submits).toEqual({})
    // And the new fact merges on the migrated state like on any other.
    await restored.bays.recordBranchSubmit({ branch: "issue/ref-only", sha: featureSha, base: "main" })
    expect(restored.state().bays.submits["issue/ref-only"]).toMatchObject({ sha: featureSha, base: "main" })
  })

  it("migrates the live production checkpoint identity f41d7eff when history is evicted", async () => {
    // /hh journal_snapshot.checkpoint_identity at cursor 76950, read 2026-08-22.
    // history_evicted_through=27609 so rebuild from zero is unavailable.
    // Missing this retain-edge is the live checkpoint-migration-missing pair.
    const { repo, featureSha } = await repository()
    const stateDir = join(repo, ".git", "yrd")
    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      steps: ["check", "merge"],
      requires: [],
      definitions: { check: { run: "true", runner: "local" }, merge: { runner: "local" } },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["check"] },
    }
    await using runtimeProcess = createProcess({ cwd: repo })

    const predecessor = await createDefaultYrdApp({
      repo,
      stateDir,
      baysRoot: join(repo, ".bays"),
      journal: testJournal(stateDir),
      process: runtimeProcess,
      config,
    })
    await predecessor.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
    await predecessor.queue.run({ prs: ["PR1"], steps: ["check"] }, { runner: "test", leaseMs: 60_000 })
    await predecessor.close()

    using database = new Database(join(stateDir, "journal.sqlite"), { strict: true })
    const checkpoint = database
      .query<{ checkpoint_json: string; cursor: number }, []>(
        "SELECT checkpoint_json, cursor FROM journal_snapshot WHERE singleton = 1",
      )
      .get()
    if (checkpoint === null) throw new Error("expected predecessor projection checkpoint")
    expect(checkpoint.cursor).toBeGreaterThan(1)
    const checkpointValue = z.record(z.string(), z.unknown()).parse(JSON.parse(checkpoint.checkpoint_json))
    const retainedIdentity = "f41d7efff8a3d2eb53b47ae8ab6ca3cf4058e2c37ff325a35c848efea94f9fcd"
    const retainedCheckpoint = JSON.stringify({ ...checkpointValue, identity: retainedIdentity })
    database
      .query(
        "UPDATE journal_snapshot SET checkpoint_identity = ?, checkpoint_json = ?, checkpoint_sha256 = ? WHERE singleton = 1",
      )
      .run(retainedIdentity, retainedCheckpoint, createHash("sha256").update(retainedCheckpoint).digest("hex"))
    // Live floor is 27609 below snapshot 76950. Keep eviction strictly below this
    // fixture's snapshot so SQLite's completeness assert still holds, and drop
    // the retained rows the floor claims to have evicted.
    database.query("DELETE FROM journal_history WHERE cursor <= ?").run(1)
    database
      .query(
        "INSERT INTO journal_metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run("history_evicted_through", "1")
    database.close()

    await using restored = await createDefaultYrdApp({
      repo,
      stateDir,
      baysRoot: join(repo, ".bays"),
      journal: testJournal(stateDir),
      process: runtimeProcess,
      config,
    })
    expect(restored.state().bays.prs.PR1).toMatchObject({ branch: "issue/feature" })
  })

  it("boots a host over ae0d2084, the identity /hh's live journal actually holds", async () => {
    // THE CARRIER TEST. Reachability proves no checkpoint-migration-missing;
    // it does NOT prove the migrate callbacks survive `validate()`. Advancing
    // the /hh gitlink restarts the resident runner onto this source, which must
    // migrate the stored checkpoint across two hops (ae0d2084 -> 36d85bbb ->
    // current). Every other retained identity had a boot test; the one
    // production actually holds did not, so the only untested edge was the
    // load-bearing one.
    //
    // Measured read-only from /hh/dev/.git/yrd/journal.sqlite on 2026-08-26:
    // journal_snapshot.checkpoint_identity = ae0d2084…, cursor 91579,
    // history_evicted_through = 27609 — so rebuild from complete history is
    // unavailable (app.ts takes that branch only at evictedThrough === 0) and
    // this migration is the only thing carrying the deployment.
    const config: ResolvedYrdProjectConfig = {
      base: "main",
      batch: 1,
      steps: ["check", "merge"],
      requires: [],
      definitions: { check: { run: "true", runner: "local" }, merge: { runner: "local" } },
      contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["check"] },
    }

    // Each identity gets its OWN journal. Reusing one across both cases boots
    // the second host on a store the first migration already rewrote, and the
    // integrity assert that trips there says nothing about the identity graph.
    const bootStoring = async (identity: string) => {
      const { repo, featureSha } = await repository()
      const stateDir = join(repo, ".git", "yrd")
      const runtimeProcess = createProcess({ cwd: repo })
      const host = () => ({
        repo,
        stateDir,
        baysRoot: join(repo, ".bays"),
        journal: testJournal(stateDir),
        process: runtimeProcess,
        config,
      })

      const predecessor = await createDefaultYrdApp(host())
      await predecessor.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
      await predecessor.queue.run({ prs: ["PR1"], steps: ["check"] }, { runner: "test", leaseMs: 60_000 })
      await predecessor.close()

      using database = new Database(join(stateDir, "journal.sqlite"), { strict: true })
      const stored = database
        .query<{ checkpoint_json: string }, []>("SELECT checkpoint_json FROM journal_snapshot WHERE singleton = 1")
        .get()
      if (stored === null) throw new Error("expected predecessor projection checkpoint")
      const value = z.record(z.string(), z.unknown()).parse(JSON.parse(stored.checkpoint_json))
      const json = JSON.stringify({ ...value, identity })
      database
        .query(
          "UPDATE journal_snapshot SET checkpoint_identity = ?, checkpoint_json = ?, checkpoint_sha256 = ? WHERE singleton = 1",
        )
        .run(identity, json, createHash("sha256").update(json).digest("hex"))
      // Stand in for the live floor: history cannot support a rebuild, so a
      // missing edge is terminal rather than silently repaired by replay.
      database.query("DELETE FROM journal_history WHERE cursor <= ?").run(1)
      database
        .query(
          "INSERT INTO journal_metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run("history_evicted_through", "1")
      database.close()

      return { open: () => createDefaultYrdApp(host()), runtimeProcess }
    }

    const live = await bootStoring("ae0d2084bdb1202cf8205a03b4d09ccf915bcccf197e90afbe62617e7c078839")
    const restored = await live.open()
    expect(restored.state().bays.prs.PR1).toMatchObject({ branch: "issue/feature" })
    await restored.close()
    await live.runtimeProcess[Symbol.asyncDispose]()

    // WHAT THIS TEST DOES NOT PROVE, and why there is no boot-level negative
    // control beside it. Storing an unretained identity here does NOT produce a
    // migration refusal: `history_evicted_through` written straight into the
    // fixture's metadata does not reach `history.diagnostics().evictedThrough`
    // at load, so app.ts reads 0, takes the rebuild-from-complete-history
    // branch, replays over the history rows this fixture deleted, and dies on
    // a journal integrity assert instead. Measured, not assumed: an identity of
    // 64 zeroes — which has never existed anywhere — fails identically to a
    // real unretained one, so the assertion would have discriminated nothing.
    // Identity discrimination is proven at manifest level instead, by the
    // stranded-identity loop in the bump-gate test above.
  })

  it("boots past historical pin-intent and tombstone events, quarantining them by name, while the shape their ids mint still parses", async () => {
    // Positional replay proof (queue-member-id-no-discrimination discipline): raw, positional
    // frames in the intent rail's OLD shapes, copied verbatim as DATA from the deleted
    // `@yrd/intent` package's own schemas — never imported, since the package is gone. A real
    // journal from before 2026-08-18 holds exactly these two event names, and this journal never
    // ran a single command through the (also gone) `withIntents()` plugin; it is written the way
    // a five-year-old journal actually is, by direct positional append, not by shape.
    const { repo } = await repository()
    const stateDir = join(repo, ".git", "yrd")
    const journal = testJournal(stateDir)

    const submitCommand = { id: "00000000-0000-7000-8000-0000000f0001", op: "fixture.intent-submitted" }
    expect(
      await journal.append(
        {
          command: submitCommand,
          cause: {
            id: "00000000-0000-7000-8000-0000000f0011",
            commandId: submitCommand.id,
            op: submitCommand.op,
            commandHash: Command.hash(submitCommand),
          },
          events: [
            {
              id: "00000000-0000-7000-8000-0000000f0021",
              name: "intent/submitted",
              ts: "2026-08-13T00:00:00.000Z",
              data: {
                schema: "yrd.intent.pin-advance.v1",
                id: "yrdpin#164",
                intentId: "00000000-0000-7000-8000-0000000f0031",
                issue: { source: "km", id: "@yrd/core/legacy-fixture" },
                component: "vendor/yrd",
                target: "1".repeat(40),
                preconditions: { targetPublished: true, targetDescendsFromCurrentPin: true },
                submitter: "operator",
              },
            },
          ],
        },
        0,
      ),
    ).toMatchObject({ appended: true })
    const tombstoneCommand = { id: "00000000-0000-7000-8000-0000000f0002", op: "fixture.pin-tombstoned" }
    expect(
      await journal.append(
        {
          command: tombstoneCommand,
          cause: {
            id: "00000000-0000-7000-8000-0000000f0012",
            commandId: tombstoneCommand.id,
            op: tombstoneCommand.op,
            commandHash: Command.hash(tombstoneCommand),
          },
          events: [
            {
              id: "00000000-0000-7000-8000-0000000f0022",
              name: "intent/pin-tombstoned",
              ts: "2026-08-13T00:00:01.000Z",
              data: {
                schema: "yrd.intent.pin-tombstone.v1",
                id: "T1",
                tombstoneId: "00000000-0000-7000-8000-0000000f0032",
                issue: { source: "km", id: "@yrd/core/legacy-fixture" },
                component: "vendor/yrd",
                sha: "2".repeat(40),
                submitter: "operator",
                recordedAt: "2026-08-13T00:00:01.000Z",
              },
            },
          ],
        },
        1,
      ),
    ).toMatchObject({ appended: true })

    // Boot succeeds — this is the PR1128 shape the quarantine exists to prevent: without it,
    // `canonicalEvent` throws over the very first unregistered name and takes the whole app's
    // replay down with it, over one stray journal frame nothing has read since 2026-08-13.
    await using runtimeProcess = createProcess({ cwd: repo })
    await using restored = await createDefaultYrdApp({
      repo,
      stateDir,
      baysRoot: join(repo, ".bays"),
      journal: testJournal(stateDir),
      process: runtimeProcess,
      config: {
        base: "main",
        batch: 1,
        steps: ["check", "merge"],
        requires: [],
        definitions: { check: { run: "true", runner: "local" }, merge: { runner: "local" } },
        contest: { concurrency: 1, timeoutMs: 60_000, evaluators: ["check"] },
      },
    })

    const unknown = restored.unknownEventNames()
    expect(unknown.map((entry) => entry.name)).toEqual(["intent/pin-tombstoned", "intent/submitted"])
    expect(unknown.every((entry) => entry.count === 1)).toBe(true)

    const snapshot = await restored.historySnapshot()
    expect(snapshot.asOf.cursor).toBeGreaterThanOrEqual(2)

    // Stored member ids from those quarantined records still parse and print — the intent
    // rail's own kind-discrimination survives, relocated into @yrd/queue, even though the
    // records themselves are now unreadable.
    const { IntentRecordIdSchema, queueMemberKind } = await import("@yrd/queue")
    expect(IntentRecordIdSchema.safeParse("yrdpin#164").success).toBe(true)
    expect(queueMemberKind("yrdpin#164")).toBe("gitlink")
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

    expect(app.state().queues).toMatchObject({ batchSize: 1 })
    // The configured plan reaches runs through the INSTALLED step set, not
    // through durable state: `queues.defaultSteps` is no longer seeded from
    // configuration, so a checkpoint can never supply a plan the configuration
    // does not declare, and a `.yrd.yml` edit is not a state change (23192).
    expect("defaultSteps" in app.state().queues, "the durable state carries no step plan at all").toBe(false)
    expect(app.queue.steps().map((step) => step.name)).toEqual(["security", "merge", "publish"])
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
      "publish",
    ])
    expect(app.commands.bay.intake.metadata?.visibility).toBe("internal")
    expect(app.commands.bay.open.metadata?.visibility).toBe("public")
    expect(app.commands.pr.close.metadata?.visibility).toBe("public")
    expect(app.commands.pr.review.metadata?.visibility).toBe("public")
    expect("admit" in app.commands.queue).toBe(false)
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
    expect(changeBaseSha(submittedPR)).toBe(baseSha)
    await expect(
      app.bays.submit({ branch: "origin/issue/feature", headSha: featureSha, base: "main" }),
    ).rejects.toThrow("payload already recorded as change 'PR1'")
    expect(Object.keys(app.state().bays.prs)).toEqual(["PR1"])
  })

  it("coalesces Bay base refresh without pruning a recoverable tracking carrier", async () => {
    const { repo, featureSha } = await repository()
    const remote = join(repo, "..", "origin.git")
    await initBareMain(repo, remote)
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
      by: "test",
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
      by: "test",
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

  it("adds one queue-authority fetch per same-base cycle instead of one per change", async () => {
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
    await initBareMain(repo, remote)
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
    await initBareMain(repo, remote)
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

    const submission = await app.bays.submitSelection("issue/feature", {
      resolveRevision: async () => featureSha,
      run: { runner: "test", leaseMs: 60_000 },
    })

    // Post-purge a recordless direct branch routes to the DERIVED lane: the
    // submit fact is the acceptance and no record mints. The queue-authority
    // refresh still happened — origin/main tracking advanced to the remote
    // base — without touching the operator's dirty main checkout.
    expect(submission).toEqual({ lane: "derived", branch: "issue/feature", sha: featureSha, base: "main" })
    expect(await git(repo, "rev-parse", "refs/remotes/origin/main")).toBe(remoteBaseSha)
    expect(await git(repo, "rev-parse", "main")).toBe(localBaseSha)
    expect(await readFile(join(repo, "operator-wip.txt"), "utf8")).toBe("preserve these bytes\n")
    expect(Object.keys(app.state().bays.prs)).toEqual([])
    expect(app.state().bays.submits["issue/feature"]).toMatchObject({ sha: featureSha, base: "main" })
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
    expect(changeDeliveryState(queueHost.state().bays.prs.PR1!)).toBe("integrated")
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
    const merge = await git(repo, "rev-parse", "main")

    expect(run).toMatchObject({
      status: "completed",
      conclusion: "success",
      integration: { commit: merge, baseSha: merge },
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
  it("turns one refs/for push into a DERIVED-lane submission: the submit fact, never a record (S6 door)", async () => {
    const { repo, featureSha } = await repository()
    const initialized = await createYrdHost({ cwd: repo, defaultSubmitter: "@dev/3" })
    const receiverPath = initialized.receiver.receiverPath
    await initialized.close()

    // This is the only author action. Post-door the receiver's conditional
    // dispatch never intakes a recordless branch — the submit-ref write IS the
    // submission, the carrier branch is materialized, and no `pr/*` record
    // event ever journals. The queue's next compose derives and runs it.
    await git(repo, "push", receiverPath, `${featureSha}:refs/for/main/@yrd/core/atomic-submit`)

    await using reopened = await createYrdHost({ cwd: repo, defaultSubmitter: "@dev/3" })
    expect(reopened.app.state().bays.prs).toEqual({})
    expect(reopened.app.state().bays.submits["issue/@yrd/core/atomic-submit"]).toMatchObject({
      sha: featureSha,
      base: "main",
    })
    // The carrier branch exists for the derived member to run from.
    expect((await git(repo, "rev-parse", "refs/heads/issue/@yrd/core/atomic-submit")).trim()).toBe(featureSha)
    // The lane rule itself, on the live state the dispatch consulted.
    expect(recordLaneOwnsBranch(reopened.app.state().bays, "issue/@yrd/core/atomic-submit")).toBe(false)

    const transactions = (await journalEnvelope(repo))
      .flatMap(({ values }) => values)
      .map((value) => parseJournalFrame(value).events.map(({ name }) => name))
    expect(transactions).toContainEqual(["branch/submitted"])
    expect(transactions.flat().filter((name) => name.startsWith("pr/"))).toEqual([])
  })

  it("names the frozen change and the fresh-ref remedy when a push cannot append a revision", async () => {
    // The push is ACCEPTED and the revision does not move: the record that owns
    // this carrier is terminal, so the S6 door declines intake and the submit
    // fact derives a NEW change instead of revision N+1. Nothing said so at the
    // point of use, and the author only found out by looking afterwards.
    //
    // Asserted on the PUSH's stderr, not a reopened host's logger, because that
    // is the whole claim: the receiver hook runs in the pushing process with
    // stderr inherited, so this reaches the author's terminal as `remote:`
    // output. Watching a later drain would pass while the author saw nothing —
    // the first draft of this test did exactly that.
    const { repo, featureSha } = await repository()
    const change = "@yrd/core/frozen-ref"
    const carrier = `issue/${change}`
    const initialized = await createYrdHost({ cwd: repo, defaultSubmitter: "@dev/3" })
    const receiverPath = initialized.receiver.receiverPath
    const baseSha = await git(repo, "rev-parse", "refs/heads/main")
    await initialized.app.bays.intake({ branch: carrier, headSha: featureSha, baseSha })
    const minted = Object.keys(initialized.app.state().bays.prs)
    expect(minted, "fixture: intake must mint exactly one record to close").toHaveLength(1)
    const pr = minted[0] as string
    await initialized.app.bays.closePr({ pr })
    // Positive controls on the fixture: the record must EXIST and NOT be live.
    // Without both, this is the ordinary recordless push that must stay quiet.
    expect(initialized.app.state().bays.prs[pr]?.branch).toBe(carrier)
    expect(recordLaneOwnsBranch(initialized.app.state().bays, carrier)).toBe(false)
    await initialized.close()

    const push = Bun.spawn(["git", "-C", repo, "push", receiverPath, `${featureSha}:refs/for/main/${change}`], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [pushErr, pushCode] = await Promise.all([new Response(push.stderr).text(), push.exited])

    expect(pushCode, `the push must still succeed — this is a notice, not a refusal:\n${pushErr}`).toBe(0)
    expect(pushErr, `the notice must reach the pusher:\n${pushErr}`).toContain("did not append a revision")
    expect(pushErr, "the change the author thought they were revising").toContain(change)
    expect(pushErr, "and the fresh ref that WOULD carry it").toContain(
      `git push --no-recurse-submodules bay HEAD:refs/for/main/${change}-r2`,
    )

    // Nothing was lost: the submit fact stands and the queue derives from it.
    await using reopened = await createYrdHost({ cwd: repo, defaultSubmitter: "@dev/3" })
    expect(reopened.app.state().bays.submits[carrier]).toMatchObject({ sha: featureSha, base: "main" })
  })

  it("stays SILENT on the ordinary recordless push, which has no revision to miss", async () => {
    // The control that makes the test above mean something: a notice printed
    // unconditionally would pass that one and put a warning on every healthy
    // derived-lane submission, which is the same defect pointed the other way.
    const { repo, featureSha } = await repository()
    const initialized = await createYrdHost({ cwd: repo, defaultSubmitter: "@dev/3" })
    const receiverPath = initialized.receiver.receiverPath
    expect(initialized.app.state().bays.prs, "fixture: no record may exist").toEqual({})
    await initialized.close()

    const push = Bun.spawn(
      ["git", "-C", repo, "push", receiverPath, `${featureSha}:refs/for/main/@yrd/core/quiet-submit`],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [pushErr, pushCode] = await Promise.all([new Response(push.stderr).text(), push.exited])

    expect(pushCode, pushErr).toBe(0)
    expect(pushErr, `an ordinary submit must not warn:\n${pushErr}`).not.toContain("did not append a revision")
  })

  it("uses the Hab service identity at the shipping process host", async () => {
    const { repo } = await repository()
    const previousServiceName = process.env.HAB_SERVICE_NAME
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    // Never the "yrd-runner" default from run.ts: an identity equal to the fallback
    // passes even with the Hab plumbing removed.
    process.env.HAB_SERVICE_NAME = "yrd-runner-under-test"
    try {
      expect(
        await runYrdProcess([
          "/usr/bin/bun",
          "/usr/local/bin/yrd",
          "--repo",
          repo,
          "queue",
          "list",
          "--check",
          "--json",
        ]),
      ).toBe(1)
      expect(JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join(""))).toMatchObject({
        schema: "hab-service-health/1",
        service: "yrd-runner-under-test",
      })
      expect(stderr.mock.calls).toEqual([])
    } finally {
      if (previousServiceName === undefined) delete process.env.HAB_SERVICE_NAME
      else process.env.HAB_SERVICE_NAME = previousServiceName
      stdout.mockRestore()
      stderr.mockRestore()
    }
  })

  it("caches viewer queue targets but re-resolves them for a habitant runner", async () => {
    const mutableResolver = () => {
      let reads = 0
      return {
        reads: () => reads,
        resolve: async (base: string) => ({ base, sha: ["first", "second"][reads++]! }),
      }
    }

    const viewerBacking = mutableResolver()
    const viewer = createPostureQueueTargetResolver("viewer", viewerBacking.resolve)
    expect([(await viewer("main", "/repo")).sha, (await viewer("main", "/repo")).sha]).toEqual(["first", "first"])
    expect(viewerBacking.reads()).toBe(1)

    const habitantBacking = mutableResolver()
    const habitant = createPostureQueueTargetResolver("habitant-queue-run", habitantBacking.resolve)
    expect([(await habitant("main", "/repo")).sha, (await habitant("main", "/repo")).sha]).toEqual(["first", "second"])
    expect(habitantBacking.reads()).toBe(2)
  })

  it("uses an explicit default submitter while generic Yrd stays operator-owned", async () => {
    const explicit = await repository()
    await using explicitHost = await createYrdHost({ cwd: explicit.repo, defaultSubmitter: "@dev/3" })
    await explicitHost.app.bays.submit({ branch: "issue/feature", headSha: explicit.featureSha, base: "main" })
    expect(explicitHost.app.bays.pr("PR1")).toMatchObject({ revs: [{ submitter: "@dev/3" }] })

    const generic = await repository()
    await using genericHost = await createYrdHost({ cwd: generic.repo })
    await genericHost.app.bays.submit({ branch: "issue/feature", headSha: generic.featureSha, base: "main" })
    expect(genericHost.app.bays.pr("PR1")).toMatchObject({ revs: [{ submitter: "operator" }] })
  })

  it("loads the base-authoritative reader floor and persists current versioned frames", async () => {
    const { repo, featureSha } = await repository()
    await commitYrdConfig(repo, 'base: main\nbatch: 1\nchecks: [{check: {run: "true"}}]\n')

    await using host = await createYrdHost({ cwd: repo })
    await host.app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })

    const frames = (await journalEnvelope(repo)).flatMap(({ values }) => values)
    expect(frames).toEqual([expect.objectContaining({ compatibility: CURRENT_JOURNAL_COMPATIBILITY })])
  })

  it("loads config from the authoritative remote base when local main is stale", async () => {
    const { repo } = await repository()
    const remote = join(repo, "..", "origin.git")
    await initBareMain(repo, remote)
    await git(repo, "remote", "add", "origin", remote)
    await git(repo, "push", "-q", "origin", "main")
    const staleLocalMain = await git(repo, "rev-parse", "main")

    await git(repo, "switch", "-qc", "remote-config")
    await commitYrdConfig(repo, "merge: none\n")
    const authoritativeMain = await git(repo, "rev-parse", "HEAD")
    await git(repo, "push", "-q", "origin", "HEAD:main")
    await git(repo, "fetch", "-q", "origin", "main:refs/remotes/origin/main")
    await git(repo, "switch", "-q", "main")

    expect(await git(repo, "rev-parse", "main")).toBe(staleLocalMain)
    expect(await git(repo, "rev-parse", "origin/main")).toBe(authoritativeMain)
    await using host = await createYrdHost({ cwd: repo })
    expect(host.config.merge).toBe("none")
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

  it("runs the literal supervisor probe without opening corrupt journal history", async () => {
    const { repo } = await repository()
    const stateDir = join(repo, ".git", "yrd")
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, "journal.sqlite"), "not a sqlite database")
    let stdout = ""
    let stderr = ""

    expect(
      await runYrdProcess(
        ["/usr/bin/bun", "/usr/local/bin/yrd", "--repo", repo, "queue", "list", "--check", "--json"],
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
    expect(JSON.parse(stdout)).toMatchObject({
      schema: "hab-service-health/1",
      service: "yrd-runner",
      state: "absent",
      running: false,
      facts: { lease: "free" },
    })
    expect(stderr).not.toContain("sqlite")
    expect(await readFile(join(stateDir, "journal.sqlite"), "utf8")).toBe("not a sqlite database")
  })

  /**
   * `--repo`/`--config` DO govern config resolution for the normal command
   * path (verified directly: `--repo`/`--config` pointed at a repository whose
   * `.yrd.yml` a built-in check name cannot resolve correctly fails `yrd queue
   * list` with that repository's own config error). But `queue list --check`
   * runs through SEPARATE bootstrap machinery — the cheap, journal-free probe
   * (`bootstrap.probe`, host.ts) that a Hab-style supervisor polls frequently —
   * and that machinery used to set `io.cwd` to the `--repo`-selected
   * repository only AFTER `bootstrap.probe()` returned successfully. When the
   * SELECTED repository's own config is exactly what makes probe() throw (the
   * PR1337 shape), the assignment never ran, and the process-level catch
   * handler re-ran the health check against `io` with its cwd still unset —
   * silently falling back to `process.cwd()`, the ambient directory, and
   * reporting a misleading "not a Git queue repository" about THAT directory
   * instead of naming the real config problem in the repository --repo
   * actually selected. A flag's authority must hold on the error path too.
   */
  it("keeps --repo's authority on the queue list --check error path, naming the real config problem", async () => {
    const ambient = await repository()
    const root = await mkdtemp(join(tmpdir(), "yrd-check-repo-flag-"))
    roots.push(root)
    const selectedPath = join(root, "selected")
    await git(root, "init", "-q", "-b", "main", selectedPath)
    const selected = await realpath(selectedPath)
    await git(selected, "config", "user.name", "Yrd Test")
    await git(selected, "config", "user.email", "yrd@example.invalid")
    // `lint` has no built-in definition (config.ts's resolveCheck) — a real,
    // named config error, distinct from "not a Git repository" and from
    // `ambient`'s own (valid) config, so which repository's facts came back
    // is unambiguous.
    await writeFile(join(selected, ".yrd.yml"), "checks: [lint]\n")
    await git(selected, "add", ".yrd.yml")
    await git(selected, "commit", "-qm", "invalid config")

    let stdout = ""
    let stderr = ""
    const exitCode = await runYrdProcess(
      ["/usr/bin/bun", "/usr/local/bin/yrd", "--repo", selected, "queue", "list", "--check", "--json"],
      {
        // The ambient cwd is a DIFFERENT, valid repository — proving the
        // reported facts follow --repo, never silently fall back to cwd.
        cwd: ambient.repo,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
      },
    )
    const body = JSON.parse(stdout || "{}") as Readonly<{
      facts?: Readonly<{ git?: Readonly<{ cwd?: string }> }>
      error?: Readonly<{ code?: string; cause?: string }>
    }>
    expect(exitCode, `stdout=${stdout} stderr=${stderr}`).toBe(2)
    expect(body.facts?.git?.cwd, "facts must name the --repo-selected directory, not the ambient one").toBe(selected)
    expect(body.error?.code).toBe("check-definition-missing")
    expect(body.error?.cause).toContain("required check 'lint' has no built-in definition")
    expect(body.error?.cause).not.toContain("is not a Git queue repository")
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

    await exclusive.run(
      async () => {
        let failure: unknown
        try {
          await exclusive.run(async () => undefined, { holder: "test-inner" })
        } catch (error) {
          failure = error
        }
        expect(failure).toBeInstanceOf(Error)
        expect((failure as Error).message).toContain(
          `writer lock is busy (holder=test-outer; owner=pid:${process.pid}; contender=pid:${process.pid} operation=test-inner; ${join(root, "writer.lock")})`,
        )
        // 23228: the holder is a REQUIRED option, so this message can no longer
        // read "unknown operation" — which is what all 3,312 starvation messages
        // measured on one host on 2026-08-28 said, leaving a ninety-minute
        // incident with nothing to name. This assertion previously PINNED that
        // defect by expecting the unnamed form.
        expect((failure as Error).message).not.toContain("unknown operation")
        expect(classifyFailure(failure)).toMatchObject({
          exitCode: 3,
          failure: { kind: "infrastructure", code: "exclusive-busy" },
        })
      },
      { holder: "test-outer" },
    )
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
          (text) =>
            text.match(/^\s{2}(?<command>[a-z]+(?:\|[a-z]+)?)(?:\s+(?:\[[^\]]+\]|<[^>]+>))*\s{2,}/u)?.groups?.command ??
            [],
        ),
    ).toEqual([
      "bay",
      "issue",
      "contest",
      "queue",
      "check",
      "doctor",
      "why",
      "admin",
      "log",
      "watch",
      "cancel",
      // The branch-state quartet: `yrd branch <state>` is the complete set,
      // and every state is also a bare verb. Root `submit` is one of them
      // (@cto 2026-08-19, cliverbs ruling-a) — it used to alias the change path,
      // which keeps its own spelling as `yrd pr submit`.
      "branch",
      "draft",
      "submit",
      "archive",
      "ignore",
      "deployment",
      "in",
      "sh",
      "run",
      "change|mr",
      // `gitlink advance` — advancing a submodule's recorded commit is one verb, not the
      // hand-built sequence all thirteen of them were on 2026-08-29/30.
      "gitlink",
      "guard",
    ])
    expect(stdout).not.toMatch(/\b(?:pr\|prs|bay\|bays|issue\|issues|contest\|contests|queue\|queues)\b/u)
    expect(stderr).toBe("")
    expect(await Bun.file(join(root, ".git", "yrd", "events-v3.jsonl")).exists()).toBe(false)

    stdout = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "--repo", root, "bay", "--help"], {
        cwd: root,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
      }),
    ).toBe(0)
    expect(stdout).toContain("Usage: yrd bay")
    expect(stdout).not.toContain("--repo <path>")
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

  it("derives the target checkpoint manifest before opening a Journal host", async () => {
    const { repo } = await repository()
    let stdout = ""
    let stderr = ""

    const exitCode = await runYrdProcess(
      ["/usr/bin/bun", "/usr/local/bin/yrd", "_checkpoint-migration-manifest", "--assembly-root", repo],
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

    expect(exitCode, stderr).toBe(0)
    expect(stdout).toMatch(/^YRD-CHECKPOINT-MIGRATION /u)
    const attestation = JSON.parse(stdout.slice("YRD-CHECKPOINT-MIGRATION ".length)) as {
      manifest: { targetIdentity: string; edges: readonly { from: string; to: string }[] }
    }
    expect(attestation).toMatchObject({
      version: 1,
      manifest: { version: 1, targetIdentity: expect.stringMatching(/^[0-9a-f]{64}$/u) },
      hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })
    // Every durable production predecessor keeps a declared path to the
    // CURRENT identity — a dropped edge is the queue's R2732
    // checkpoint-migration-path-missing refusal (2026-08-18: the intents-v2
    // identity change shipped without one; the intent rail's deletion, same
    // day, is the second edge this same lock caught).
    //
    // Since 42ef9a27 / c344e112 (2026-08-25) that path is TWO HOPS, not one:
    // every historical predecessor converges on the released change-record
    // identity, which then takes a single real forward edge to the target. This
    // expectation read `to: targetIdentity` for a whole day after the graph
    // stopped being shaped that way, so the lock was red on main and asserting
    // nothing anyone could act on.
    const releasedHop = "36d85bbb8b59e8a3c6c327b8f14f643816d951cd003904ac0acbe0bbca150691"
    expect(attestation.manifest.edges).toEqual([
      { from: "0106b543f7e02d29dddc830b48352f4188e4ae86c641f4888771c27ce805f6e3", to: releasedHop },
      { from: "0150a374820eafd53c72571ff04caffc85acf1c9839c60736299ecd20f2c4657", to: releasedHop },
      { from: "063c12e0029825f80853c78e29a4c23cde4e992f3257b806b37ee256b260f691", to: releasedHop },
      { from: "0a3476ef91823d46f19770047a4e6462c970c5afc250cba9dd82eb31c5febc25", to: releasedHop },
      // The ledger's superseded last entry — what every deployment has been
      // asked to store since 2026-08-30 — retained across the waiting-job
      // reclaim bump (the no-parking ruling, 2026-08-31).
      { from: "1d285ebf24b688b75dbca2c5101a5f1e85cf70ab004a5ca400be89a57daf53d4", to: releasedHop },
      // The production composition's correlation-era identity (props cut).
      { from: "227fed2369cdf2a8f3c6a0b63a61bff97d7a46dd60a1fdd7c782ed3b4f69f5e5", to: releasedHop },
      // The ledger's superseded last entry before `yrd pr retire` registered
      // `queue/revision/retired` (2026-09-01) — what deployments were asked to
      // store until then.
      { from: "2498f5d42e338959e6b67e49b4b78c9939bb0f94ca3e9b506bcef39276b9c6a5", to: releasedHop },
      // The interim step-plan identity the live journal advanced to while
      // this work was in flight, measured from its own refusal.
      { from: "288eb2031f0ae914db51e4fca58add50aa39397abd773be99e81d9a35c06e817", to: releasedHop },
      // The production identity before the declared step list left
      // `initialState` (23192), measured from the live journal's refusal.
      { from: "348ade4e2dbe135e789387756816d753858f037668bb3a121cb2719802b3b598", to: releasedHop },
      // The one real forward edge: the released identity above to the target.
      { from: releasedHop, to: attestation.manifest.targetIdentity },
      // The identity shared main's vendor pin 18d9b83dbb19 computes — what the
      // running yrd-runner is asked to store — retained across the
      // containedInBase bump (bd1c0b88, 2026-08-28).
      { from: "381cdb9edee92b0988087ae0fab8bb365b59069224ef47dc6b881dbde735808c", to: releasedHop },
      // The derived-identity composition retained while journal-v4 reader
      // capability lands without activating its explicitly v3 writer.
      { from: "3f8a2627fde94c410a98beaed80e2198298baea1fb8a5b533f3e71231e8faafa", to: releasedHop },
      { from: "47f4ac247383142e258574ee2bdc635d51508a1f94621dc1a1482867d271bca7", to: releasedHop },
      // The production composition's identity before branch-is-change 2a.
      { from: "61773b43456a2943913a6514131c04502a9d26baadedfcf28e4c12bf6d746d37", to: releasedHop },
      // Production journal stored identity 2026-08-26 (cursor 92592), the
      // composition immediately before 22991 phase 2's statuses cut.
      { from: "701431d5952e57f998e77413fe6c79dfede32f203863a5ff163b07b704ab6c25", to: releasedHop },
      // The ledger's superseded last entry — what every deployment has been
      // asked to store since 2026-08-28 — retained across the submit-fact
      // retirement bump (@i/10-yrd/absent-branch-is-terminal, 2026-08-30).
      { from: "74775b5709b3cf9ef1ef3cfaae63013e486aa09d6386e01bf17d4482557203f1", to: releasedHop },
      // The ledger's superseded last entry before every queue outcome began
      // ending in exactly one journaled ball (@i/10-yrd/24028, 2026-09-01).
      { from: "7ea283b896818c5252981498fd85fa312a8dc58eec45101449b5212c5042c074", to: releasedHop },
      { from: "9697d38f2755d391287f82d8fa976c8eb8177d429a09e151eae087f526e859e7", to: releasedHop },
      // Production journal stored identity, read read-only from /hh's live
      // journal 2026-08-26 at cursor 91511 (evictedThrough 27609, so rebuild
      // from complete history is unavailable and this edge is load-bearing).
      { from: "ae0d2084bdb1202cf8205a03b4d09ccf915bcccf197e90afbe62617e7c078839", to: releasedHop },
      // Production journal stored identity 2026-08-22 (evictedThrough 27609).
      { from: "f41d7efff8a3d2eb53b47ae8ab6ca3cf4058e2c37ff325a35c848efea94f9fcd", to: releasedHop },
      // The no-parking composition's released identity, retained across the
      // derived branch+sha binding bump this branch introduces.
      { from: "fd6a78dfadab8397265aaa36309c18cb69794cead6b0577f0982f1c1c1ee1f5c", to: releasedHop },
      { from: "fe5e818396dd2c5f9bab6191ab0dd882d9ee584046c618463b4583ff724effe8", to: releasedHop },
    ])
    expect(existsSync(join(repo, ".git", "yrd"))).toBe(false)
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
    expect(stdout).toContain("yrd --repo <repository> queue run PR7 --steps check,merge")
    expect(stdout).toContain("yrd --repo <repository> queue pause --reason maintenance --for 30m --allow PR7")
    expect(stdout).not.toContain("queue recover")
    expect(stdout).toContain("yrd --repo <repository> queue run")
    expect(stdout).not.toMatch(/\$ yrd queue (?:run|pause|recover)(?:\s|$)/u)
    expect(stderr).toBe("")
    expect(await Bun.file(join(root, ".git", "yrd", "events-v3.jsonl")).exists()).toBe(false)
  })

  it("projects an active Bay path from the selected repository authority", async () => {
    const { repo } = await repository()
    const ambient = join(repo, "..", "bay-path-ambient")
    await mkdir(ambient)
    await using owner = await createYrdHost({ cwd: repo })
    const opened = await owner.app.bays.open({ name: "selected", by: "test" })
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
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "--repo", repo, "bay", "path", "selected", "--json"], {
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

  it("forwards host-owned lifecycle hooks to the mutable Bay workspace", async () => {
    const { repo } = await repository()
    const observed: Array<{ bay: string; path: string }> = []
    await using host = await createYrdHost({
      cwd: repo,
      workspaceLifecycle: {
        postProvision: (workspace) => {
          observed.push(workspace)
        },
      },
    })
    const opened = await host.app.bays.open({ name: "hooked", by: "test" })
    const jobs = await host.app.jobs.runMany(host.app.jobs.requested(opened), {
      runner: "test",
      leaseMs: 60_000,
    })

    expect(jobs.every((job) => job.status === "completed" && job.conclusion === "success")).toBe(true)
    expect(observed).toEqual([{ bay: "B1", path: join(repo, ".bays", "B1") }])
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

  it("names the canonical queue root across nested repositories and linked worktrees", async () => {
    const { repo } = await repository()
    const nested = join(repo, "pm")
    const linked = join(repo, "..", "linked-status")
    await git(repo, "init", "-q", "-b", "main", nested)
    await git(nested, "config", "user.name", "Yrd Test")
    await git(nested, "config", "user.email", "yrd@example.invalid")
    await writeFile(join(nested, ".yrd.yml"), 'checks: [{check: {run: "true"}}]\n')
    await git(nested, "add", ".yrd.yml")
    await git(nested, "commit", "-qm", "nested queue")
    await git(repo, "worktree", "add", "-q", linked, "issue/feature")

    const statusFrom = async (cwd: string, options: readonly string[] = []): Promise<string> => {
      let stdout = ""
      let stderr = ""
      expect(
        await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", ...options, "queue", "status"], {
          cwd,
          columns: 160,
          stdout: (text) => {
            stdout += text
          },
          stderr: (text) => {
            stderr += text
          },
        }),
        stderr,
      ).toBe(0)
      return stdout
    }

    // The canonical root rides the top-line queue pill now (items 30/32b/33):
    // `digit shortest-unique-path ⎇ branch`. A lone queue shortens to its
    // basename, so the authority resolution shows as `repo` vs `pm` — and a
    // linked worktree resolving to anything but its PRIMARY would surface as
    // `linked-status` here.
    expect((await statusFrom(repo)).split("\n", 1)[0]).toContain("1 repo ⎇ main")
    expect((await statusFrom(nested)).split("\n", 1)[0]).toContain("1 pm ⎇ main")
    expect((await statusFrom(linked)).split("\n", 1)[0]).toContain("1 repo ⎇ main")
    expect((await statusFrom(nested, ["--repo", repo])).split("\n", 1)[0]).toContain("1 repo ⎇ main")
  })

  it("refuses literal --steps merge without starting the certifying check process", async () => {
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

    const mainBefore = await git(repo, "rev-parse", "main")
    let stdout = ""
    let stderr = ""
    // Post-purge the branch runs as a DERIVED member, so the merge-only pass is
    // the bare one-shot (a record selector cannot name it). Derived admission
    // executes the configured check once as its eligibility gate — the marker
    // exists — but that execution is NOT certificate authority: the run's own
    // check step stays not-selected and the merge still refuses uncertified.
    const exitCode = await runYrdProcess(
      ["/usr/bin/bun", "/usr/local/bin/yrd", "queue", "run", "--once", "--steps", "merge", "--json"],
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
    expect(await Bun.file(checkMarker).exists(), JSON.stringify({ exitCode, stdout, stderr })).toBe(true)
    // The three-way verdict (@i/10-yrd/24028): a merge refused on a
    // yrd-owned code (`checkpoint-migration-certificate-missing`) is "yrd
    // failed" — the queue owner's ball — never the author's 1.
    expect(exitCode, stderr).toBe(QUEUE_OUTCOME_EXIT.yrdFailed)
    const result = JSON.parse(stdout) as { results: Array<{ id: string }> }
    expect(result).toMatchObject({
      command: "queue.run",
      results: [
        {
          status: "completed",
          conclusion: "failure",
          error: { code: "checkpoint-migration-certificate-missing" },
          stepSelection: {
            authority: "explicit",
            steps: ["merge"],
            omittedSteps: [{ name: "check", index: 0, status: "skipped", reason: "not-selected" }],
          },
          steps: [{ name: "merge" }],
          prs: [{ branch: "issue/feature", headSha: featureSha, revision: 1 }],
        },
      ],
    })
    expect(await git(repo, "rev-parse", "main")).toBe(mainBefore)
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

  it("refuses a literal merge-only batch without starting either certifying check", async () => {
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

    const mainBefore = await git(repo, "rev-parse", "main")
    let stdout = ""
    let stderr = ""
    // Post-purge both branches run as DERIVED members, so the merge-only batch
    // is the bare one-shot. Derived admission runs the configured check as its
    // eligibility gate (the marker exists), but the merge-only run still holds
    // no certificate for either member and must refuse without one.
    const exitCode = await runYrdProcess(
      ["/usr/bin/bun", "/usr/local/bin/yrd", "queue", "run", "--once", "--steps", "merge", "--json"],
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
    expect(await Bun.file(checkMarker).exists(), JSON.stringify({ exitCode, stdout, stderr })).toBe(true)
    // The three-way verdict (@i/10-yrd/24028): a merge refused on a
    // yrd-owned code (`checkpoint-migration-certificate-missing`) is "yrd
    // failed" — the queue owner's ball — never the author's 1.
    expect(exitCode, stderr).toBe(QUEUE_OUTCOME_EXIT.yrdFailed)
    const result = JSON.parse(stdout) as { command: string; results: Record<string, unknown>[] }
    expect(result.command).toBe("queue.run")
    expect(result.results.length).toBeGreaterThanOrEqual(1)
    expect(result.results[0]).toMatchObject({
      status: "completed",
      conclusion: "failure",
      error: { code: "checkpoint-migration-certificate-missing" },
      stepSelection: {
        authority: "explicit",
        steps: ["merge"],
        omittedSteps: [{ name: "check", index: 0, status: "skipped", reason: "not-selected" }],
      },
      steps: [{ name: "merge" }],
      prs: [
        { branch: "issue/feature", headSha: featureSha },
        { branch: "issue/second", headSha: secondSha },
      ],
    })
    for (const run of result.results) {
      expect(run).toMatchObject({
        status: "completed",
        conclusion: "failure",
        error: { code: "checkpoint-migration-certificate-missing" },
      })
    }
    expect(await git(repo, "rev-parse", "main")).toBe(mainBefore)
  })

  it("does not reuse a prior configured check as merge-only certificate authority", async () => {
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
    // Post-purge the branch runs as a DERIVED member; the merge-only pass is
    // the bare one-shot. Derived admission executes the configured check once
    // more as its eligibility gate — the marker gains a second entry — and
    // NEITHER execution (pre-submit or admission) is certificate authority for
    // the merge-only run.
    const exitCode = await runYrdProcess(
      ["/usr/bin/bun", "/usr/local/bin/yrd", "queue", "run", "--once", "--steps", "merge", "--json"],
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
    expect(await readFile(checkMarker, "utf8")).toBe("checkcheck")
    // yrd-owned refusal code → yrd failed (17), the three-way verdict (@i/10-yrd/24028).
    expect(exitCode, JSON.stringify({ stdout, stderr })).toBe(QUEUE_OUTCOME_EXIT.yrdFailed)
    const result = JSON.parse(stdout) as { results: Record<string, unknown>[] }
    expect(result).toMatchObject({
      results: [
        {
          status: "completed",
          conclusion: "failure",
          error: { code: "checkpoint-migration-certificate-missing" },
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

  it("provisions a detached required-check workspace before pr submit runs it (22600)", async () => {
    const { repo } = await candidatePackageRepository()
    const fixtureBin = await fixtureBun(repo, ["mkdir -p node_modules", ": > node_modules/.provisioned", "exit 0"])
    const previousPath = process.env.PATH
    process.env.PATH = `${fixtureBin}:${previousPath ?? ""}`
    try {
      let stdout = ""
      let stderr = ""
      const exitCode = await runYrdProcess(
        ["/usr/bin/bun", "/usr/local/bin/yrd", "pr", "submit", "issue/feature", "--keep-on-failure", "--json"],
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

      expect(exitCode, stderr).toBe(0)
      // Derived acceptance: the provisioned workspace ran the required check
      // to a pass, and the submit fact — not a record — is the result.
      expect(JSON.parse(stdout)).toMatchObject({
        command: "pr.submit",
        prs: [],
        derived: [{ lane: "derived", branch: "issue/feature", base: "main" }],
        requiredChecks: [{ name: "typecheck", status: "passed", exitCode: 0 }],
      })
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  })

  it("types a detached required-check provisioning failure before pr submit mutates state (22600)", async () => {
    const { repo } = await candidatePackageRepository()
    const fixtureBin = await fixtureBun(repo, ["printf 'dependency cache unavailable\\n' >&2", "exit 7"])
    const previousPath = process.env.PATH
    process.env.PATH = `${fixtureBin}:${previousPath ?? ""}`
    try {
      let stdout = ""
      let stderr = ""
      const exitCode = await runYrdProcess(
        ["/usr/bin/bun", "/usr/local/bin/yrd", "pr", "submit", "issue/feature", "--keep-on-failure", "--json"],
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

      expect(exitCode).toBe(3)
      expect(stdout).toBe("")
      const failure = JSON.parse(stderr) as { failure: { message: string; resolution: string[] } }
      expect(failure).toMatchObject({
        failure: {
          kind: "infrastructure",
          code: "candidate-provision-failed",
          message: expect.stringContaining("dependency cache unavailable"),
        },
      })
      const retained = /workspace retained at '([^']+)'/u.exec(failure.failure.message)?.[1]
      expect(retained, failure.failure.message).toBeDefined()
      expect(existsSync(join(retained!, "package.json"))).toBe(true)
      expect(failure.failure.resolution).toEqual([
        `Inspect the retained workspace at '${retained!}'.`,
        `git worktree remove --force '${retained!}'`,
        `rmdir '${dirname(retained!)}'`,
        "yrd pr submit <branch>",
      ])
      expect((await journalEnvelope(repo)).flatMap(({ values }) => values)).toEqual([])
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  })

  it("does not execute checkout hooks or candidate postinstall in the trusted submit process", async () => {
    const { repo } = await candidatePackageRepository()
    const fakeCredential = "fixture-push-credential"
    const postCheckoutMarker = join(repo, "..", "post-checkout-observation")
    const postinstallMarker = join(repo, "..", "postinstall-observation")

    await git(repo, "switch", "-q", "issue/feature")
    const manifest = JSON.parse(await readFile(join(repo, "package.json"), "utf8")) as {
      scripts: Record<string, string>
    }
    manifest.scripts.postinstall = "sh ./probe-postinstall.sh"
    await writeFile(join(repo, "package.json"), `${JSON.stringify(manifest)}\n`)
    await writeFile(
      join(repo, "probe-postinstall.sh"),
      `#!/bin/sh\nprintf '%s' "$YRD_TEST_PUSH_TOKEN" > ${JSON.stringify(postinstallMarker)}\n`,
      { mode: 0o755 },
    )
    await git(repo, "add", "package.json", "probe-postinstall.sh")
    await git(repo, "commit", "-qm", "add candidate execution probes")
    await git(repo, "switch", "-q", "main")
    await writeFile(
      join(repo, ".git", "hooks", "post-checkout"),
      `#!/bin/sh\nprintf '%s' "$YRD_TEST_PUSH_TOKEN" > ${JSON.stringify(postCheckoutMarker)}\n`,
      { mode: 0o755 },
    )

    const fixtureBin = await fixtureBun(
      repo,
      ["mkdir -p node_modules", ": > node_modules/.provisioned", "exit 0"],
      ["sh ./probe-postinstall.sh", "exit 0"],
    )
    const previousPath = process.env.PATH
    const previousCredential = process.env.YRD_TEST_PUSH_TOKEN
    process.env.PATH = `${fixtureBin}:${previousPath ?? ""}`
    process.env.YRD_TEST_PUSH_TOKEN = fakeCredential
    try {
      expect(existsSync(postCheckoutMarker)).toBe(false)
      expect(existsSync(postinstallMarker)).toBe(false)

      let stdout = ""
      let stderr = ""
      const exitCode = await runYrdProcess(
        ["/usr/bin/bun", "/usr/local/bin/yrd", "pr", "submit", "issue/feature", "--json"],
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

      expect(exitCode, stderr).toBe(0)
      expect(JSON.parse(stdout)).toMatchObject({
        command: "pr.submit",
        prs: [],
        derived: [{ lane: "derived", branch: "issue/feature", base: "main" }],
        requiredChecks: [{ name: "typecheck", status: "passed", exitCode: 0 }],
      })
      expect({
        postCheckoutObserved: existsSync(postCheckoutMarker) ? await readFile(postCheckoutMarker, "utf8") : undefined,
        postinstallObserved: existsSync(postinstallMarker) ? await readFile(postinstallMarker, "utf8") : undefined,
      }).toEqual({
        postCheckoutObserved: undefined,
        postinstallObserved: undefined,
      })
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousCredential === undefined) delete process.env.YRD_TEST_PUSH_TOKEN
      else process.env.YRD_TEST_PUSH_TOKEN = previousCredential
    }
  })

  it("does not provision the operator checkout for an explicit local check (22600)", async () => {
    const { repo } = await candidatePackageRepository()
    const fixtureBin = await fixtureBun(repo, ["mkdir -p node_modules", ": > node_modules/.provisioned", "exit 0"])
    const previousPath = process.env.PATH
    process.env.PATH = `${fixtureBin}:${previousPath ?? ""}`
    try {
      let stderr = ""
      const exitCode = await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "check", "typecheck", "--json"], {
        cwd: repo,
        stdout() {},
        stderr: (text) => {
          stderr += text
        },
      })

      expect(exitCode).toBe(1)
      expect(existsSync(join(repo, "node_modules", ".provisioned"))).toBe(false)
      expect(JSON.parse(stderr)).toMatchObject({
        failure: {
          kind: "refusal",
          code: "required-check-failed",
        },
      })
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  })

  it("refuses a pr submit of a landed branch instead of gating it against itself", async () => {
    const { repo, candidateSha, baseSha } = await landedCandidateRepository()
    await git(repo, "update-ref", "refs/remotes/origin/main", baseSha)
    await git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
    await git(repo, "update-ref", "refs/remotes/origin/issue/feature", candidateSha)

    let stderr = ""
    const exitCode = await runYrdProcess(
      ["/usr/bin/bun", "/usr/local/bin/yrd", "pr", "submit", "issue/feature", "--base", "main", "--track", "--json"],
      {
        cwd: repo,
        stdout() {},
        stderr: (text) => {
          stderr += text
        },
      },
    )

    // The end-to-end claim: the submit path, not just the check host, refuses a
    // candidate that carries nothing. The wiring is what fails silently —
    // `substrate-pair` had to catch this one from inside the check, after
    // `typecheck` and `manifest-co-change` had already passed over the same
    // empty range.
    expect(exitCode).toBe(1)
    expect(JSON.parse(stderr)).toMatchObject({
      failure: { kind: "refusal", code: "required-check-degenerate-range" },
    })
  })

  it("refuses a pr submit whose branch tip is the base itself", async () => {
    const { repo } = await repository()
    await git(repo, "switch", "-q", "main")
    const baseSha = await git(repo, "rev-parse", "HEAD")
    await git(repo, "branch", "-f", "issue/feature", baseSha)
    await git(repo, "update-ref", "refs/remotes/origin/main", baseSha)
    await git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
    await git(repo, "update-ref", "refs/remotes/origin/issue/feature", baseSha)

    let stderr = ""
    const exitCode = await runYrdProcess(
      ["/usr/bin/bun", "/usr/local/bin/yrd", "pr", "submit", "issue/feature", "--base", "main", "--track", "--json"],
      {
        cwd: repo,
        stdout() {},
        stderr: (text) => {
          stderr += text
        },
      },
    )

    // Nothing composes here, so this fires only if `pr submit` actually
    // DECLARES that it is gating a carrier. `yrd check` declares the opposite
    // and keeps running (22600), which is what makes this assertion about the
    // wiring rather than about the condition.
    expect(exitCode).toBe(1)
    expect(JSON.parse(stderr)).toMatchObject({
      failure: { kind: "refusal", code: "required-check-degenerate-range" },
    })
  })

  it("binds current-branch pr submit to the invoking linked-worktree candidate", async () => {
    const { repo } = await repository()
    await writeFile(
      join(repo, ".yrd.yml"),
      [
        journalCompatibilityYaml().trimEnd(),
        'checks: [{candidate: {run: \'test "$YRD_BASE_SHA" != "$YRD_CANDIDATE_SHA" && test "$YRD_CANDIDATE_SHA" = "$(git rev-parse HEAD)"\'}}]',
        "",
      ].join("\n"),
    )
    await git(repo, "add", ".yrd.yml")
    await git(repo, "commit", "-qm", "require the named candidate")
    const baseSha = await git(repo, "rev-parse", "HEAD")
    await git(repo, "update-ref", "refs/remotes/origin/main", baseSha)
    await git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
    const linked = join(dirname(repo), "linked-check")
    await git(repo, "worktree", "add", "-qb", "issue/linked-check", linked)
    await writeFile(join(linked, "candidate.txt"), "candidate\n")
    await git(linked, "add", "candidate.txt")
    await git(linked, "commit", "-qm", "candidate")
    const linkedSha = await git(linked, "rev-parse", "HEAD")

    let stdout = ""
    let stderr = ""
    const exitCode = await runYrdProcess(
      ["/usr/bin/bun", "/usr/local/bin/yrd", "pr", "submit", "--base", "main", "--track", "--json"],
      {
        cwd: linked,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
      },
    )

    expect(exitCode, stderr).toBe(0)
    // The derived submit fact carries the invoking linked worktree's own head,
    // and the passing pre-submit check proved $YRD_CANDIDATE_SHA was that head.
    expect(JSON.parse(stdout)).toMatchObject({
      command: "pr.submit",
      prs: [],
      derived: [{ lane: "derived", branch: "issue/linked-check", sha: linkedSha, base: "main" }],
      requiredChecks: [{ name: "candidate", status: "passed", exitCode: 0 }],
    })
  })

  it("reports a SIGKILLed explicit required check as infrastructure", async () => {
    const { repo } = await repository()
    await writeFile(join(repo, ".yrd.yml"), 'checks: [{check: {run: "kill -9 $$"}}]\n')
    await git(repo, "add", ".yrd.yml")
    await git(repo, "commit", "-qm", "kill required check")
    let stderr = ""

    const exitCode = await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "check", "check", "--json"], {
      cwd: repo,
      stdout() {},
      stderr: (text) => {
        stderr += text
      },
    })

    expect(exitCode).toBe(3)
    expect(JSON.parse(stderr)).toMatchObject({
      failure: {
        kind: "infrastructure",
        code: "required-check-infrastructure-signal",
        message: expect.stringContaining("SIGKILL"),
      },
    })
  })

  it("runs the managed required check before pr submit mutates the change journal", async () => {
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
        '        printf "[yrd-base-health] base %.12s is red: test:fast failed\\n" "$YRD_BASE_SHA" >&2 &&',
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
      await runYrdProcess(
        ["/usr/bin/bun", "/usr/local/bin/yrd", "pr", "submit", "issue/feature", "--keep-on-failure", "--json"],
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
    expect(submitStdout).toBe("")
    const failure = JSON.parse(submitStderr) as {
      failure: { message: string; cause: string; resolution: string[] }
    }
    expect(failure).toMatchObject({
      failure: {
        kind: "refusal",
        code: "required-check-failed",
        message: expect.stringContaining("check stderr:"),
      },
    })
    const retained = /workspace retained at '([^']+)'/u.exec(failure.failure.message)?.[1]
    expect(retained, failure.failure.message).toBeDefined()
    expect(existsSync(retained!)).toBe(true)
    expect(failure.failure.cause).toContain(`required check failed: 'main-health' exited 1`)
    expect(failure.failure.cause).toContain("check stderr:")
    expect(failure.failure.cause).toContain(`[yrd-base-health] base ${baseSha.slice(0, 12)} is red: test:fast failed`)
    expect(failure.failure.cause).toContain(`workspace retained at '${retained!}'`)
    expect(failure.failure.cause).not.toMatch(/\band$/u)
    expect(failure.failure.resolution).toEqual([
      `Inspect the retained workspace at '${retained!}'.`,
      `git worktree remove --force '${retained!}'`,
      `rmdir '${dirname(retained!)}'`,
      "yrd check 'main-health'",
    ])

    let humanStdout = ""
    let humanStderr = ""
    expect(
      await runYrdProcess(
        ["/usr/bin/bun", "/usr/local/bin/yrd", "pr", "submit", "issue/feature", "--keep-on-failure"],
        {
          cwd: repo,
          stdout: (text) => {
            humanStdout += text
          },
          stderr: (text) => {
            humanStderr += text
          },
        },
      ),
      humanStderr,
    ).toBe(1)
    expect(humanStdout).toBe("")
    const humanRetained = /workspace retained at '([^']+)'/u.exec(humanStderr)?.[1]
    expect(humanRetained, humanStderr).toBeDefined()
    expect(humanStderr).toContain("error: required check failed: 'main-health' exited 1; check stderr:")
    expect(humanStderr).not.toMatch(/\band\s*\nresolve:/u)
    expect(humanStderr).toContain(`resolve: Inspect the retained workspace at '${humanRetained!}'.`)
    expect(humanStderr).toContain(`resolve: git worktree remove --force '${humanRetained!}'`)
    expect(humanStderr).toContain(`resolve: rmdir '${dirname(humanRetained!)}'`)
    expect(humanStderr).toContain("resolve: yrd check 'main-health'")
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

  it("skips a receiver inbox entry whose push never completed instead of refusing the whole drain", async () => {
    // Measured 2026-09-01 17:29:57 PDT. A `pre-receive` hook writes its
    // `.prepared.json` BEFORE Git decides whether to accept the update. One
    // submitter's push was interrupted after the object landed but before any
    // ref was created, so `recoverPrepared` could not confirm the push and
    // reported the entry ambiguous — forever, because nothing else ever moves
    // it. The host then turned that one entry into a refusal of the WHOLE
    // inbox, and since this drain runs at host construction for every active
    // command, every later pass exited 3 while eight eligible changes waited
    // behind a row none of them had anything to do with.
    const { repo, featureSha } = await repository()
    const stateDir = join(repo, ".git", "yrd")

    // One host to create the receiver and its inbox, exactly as a real
    // repository would already have them.
    const warm = await createYrdHost({ cwd: repo })
    await warm.close()

    // The orphan, in the shape the interrupted push left behind: a branch
    // creation (`oldSha` all zeroes) naming a ref that does not exist. The id
    // is the receiver's own content hash of the update, not a free-form name —
    // an entry whose id does not rebuild from its fields is `failed`, not
    // ambiguous, and would be refusing this drain for a different and correct
    // reason.
    const ref = "refs/heads/issue/interrupted-push"
    const branch = "issue/interrupted-push"
    const oldSha = "0".repeat(40)
    const id = createHash("sha256").update(`${ref}\0${oldSha}\0${featureSha}`).digest("hex")
    const receivedAt = new Date(Date.now() - 90_000).toISOString()
    const orphan = {
      version: 1,
      id,
      receivedAt,
      ref,
      branch,
      oldSha,
      headSha: featureSha,
      intake: {
        base: "main",
        baseSha: await git(repo, "rev-parse", "main"),
        branch,
        headSha: featureSha,
      },
    }
    const inbox = receiverInboxDir(stateDir)
    await writeFile(join(inbox, `${id}.prepared.json`), `${JSON.stringify(orphan)}\n`)

    const events: unknown[] = []
    const log = createLogger("test", [{ level: "trace" }, { write: (value: unknown) => events.push(value) }])
    try {
      // (a) On the code this replaces, THIS LINE THROWS
      //     "receiver inbox did not drain cleanly" and there is no host at all —
      //     no queue pass, no `pr submit`, no read-only status, for anyone.
      const host = await createYrdHost({ cwd: repo, log })
      try {
        // (b) The rest of the inbox drained and the host is usable: work that
        //     has nothing to do with the orphan proceeds.
        await host.app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
        expect(Object.keys(host.app.state().bays.prs)).toEqual(["PR1"])
      } finally {
        await host.close()
      }

      // Reported, never swallowed — one row naming the id, the branch it belongs
      // to, the file to retire and its AGE, which is the only thing separating a
      // push happening right now from one that never finished. An operator
      // cannot clear what nobody named. WARN, not ERROR: the level IS the
      // disposition (`receiver-drain-refusal.ts`), so a skipped entry cannot be
      // reported as if it had stopped the runtime.
      const rows = events.filter(
        (event): event is { level: string; props: Record<string, unknown> } =>
          typeof event === "object" &&
          event !== null &&
          "props" in event &&
          typeof event.props === "object" &&
          event.props !== null &&
          "action" in event.props &&
          event.props.action === "receiver-drain-ambiguous",
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]!.level).toBe("warn")
      expect(rows[0]!.props).toMatchObject({
        disposition: "skipped",
        id,
        branch,
        receivedAt,
        path: join(inbox, `${id}.prepared.json`),
      })
      expect(rows[0]!.props.ageMinutes).toBeGreaterThanOrEqual(1)

      // Skipped, not consumed: the entry is still on disk, so a push that was
      // merely SLOW is still delivered by a later drain under the same id, and
      // nothing has been destroyed on an unprovable guess about what happened.
      expect(await Bun.file(join(inbox, `${id}.prepared.json`)).exists()).toBe(true)
    } finally {
      log.end()
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
    expect(currentChangeRev(reopenedPR)).toMatchObject({ head: headSha })
    expect(changeDeliveryState(reopenedPR)).toBe("submitted")
    await reopened.close()
  })

  // S7 note (@i/10 22991): the record half of the old "finds a direct-branch PR
  // for status" flow is unreachable post-purge — a direct-branch submit writes
  // a derived fact instead of minting PR1, and `pr status`/`pr merge` do not
  // yet read the derived lane (`pr status` refuses "the current bay or branch
  // has no PR" and `pr merge <branch>` still answers "not submitted" for a
  // branch whose submit fact exists — reported upstream as a src gap, not
  // fenced here). What survives: merge stays queue-only and appends nothing,
  // and the submit fact itself is the durable acceptance.
  it("accepts a direct-branch submit as a durable derived fact and keeps pr merge append-free", async () => {
    const { repo, featureSha } = await repository()
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
    expect(JSON.parse(submitJson)).toMatchObject({
      command: "pr.submit",
      prs: [],
      derived: [{ lane: "derived", branch: "issue/feature", sha: featureSha, base: "main" }],
    })

    // The acceptance is a journal fact, not a record: the branch/submitted
    // event carries the submitted head.
    const submitted = await journalEnvelope(repo)
    expect(JSON.stringify(submitted)).toContain("branch/submitted")
    expect(JSON.stringify(submitted)).toContain(featureSha)

    let mergeJson = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "pr", "merge", "issue/feature", "--json"], {
        cwd: repo,
        stdout: () => undefined,
        stderr: (text) => {
          mergeJson += text
        },
      }),
    ).toBe(1)
    expect(JSON.parse(mergeJson)).toMatchObject({ command: "pr.merge", branch: "issue/feature" })
    expect(await journalEnvelope(repo)).toEqual(submitted)
  })

  it("refuses to compose a docs submission whose incidental submodule pin is unpublished", async () => {
    const { repo, rootRemote, branch, pin } = await unpublishedSubmodulePinRepository()
    await writeFile(join(repo, "README.md"), "root documentation\n")
    await git(repo, "add", "README.md")
    await git(repo, "commit", "-qm", "document the root project")
    const head = await git(repo, "rev-parse", branch)
    const rootMainBefore = await git(rootRemote, "rev-parse", "refs/heads/main")
    let stdout = ""
    let stderr = ""

    // Post-purge the submit itself is a derived acceptance — the unpublished
    // pin no longer refuses at submit time. The gate moved to compose, which
    // must refuse the member LOUDLY (min-commit-unpublished) instead of
    // queuing or merging the docs change with its incidental pin.
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
    ).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({
      command: "pr.submit",
      prs: [],
      derived: [{ lane: "derived", branch, sha: head, base: "main" }],
    })

    stdout = ""
    stderr = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "--repo", repo, "queue", "run", "--once", "--json"], {
        cwd: repo,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
      }),
      stderr,
      // The three-way verdict (@i/10-yrd/24028): the refusal is the author's
      // (push the gitlink to the submodule's main first), so the pass sends
      // it back and exits 1 — the pass itself continued.
    ).toBe(QUEUE_OUTCOME_EXIT.changeRefused)
    expect(JSON.parse(stdout)).toMatchObject({ command: "queue.run", publications: [], results: [] })
    // The refusal is loud on the runner stream and names the exact pin and the
    // pipeline-routed cure: land the commit on the submodule's own main.
    expect(stderr).toContain("min-commit-unpublished")
    expect(stderr).toContain(pin)
    expect(stderr).toContain("is not on submodule main")
    expect(stderr).toContain("push it to the submodule's own main first")
    expect(await git(rootRemote, "rev-parse", "refs/heads/main")).toBe(rootMainBefore)

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
    expect(JSON.parse(listed)).toMatchObject({ prs: [] })

    // Once the pin merges on the submodule's own MAIN, the backstop this test used to hit here
    // no longer applies — step (d)'s admission flip lets a published, on-main, single-update
    // authored gitlink through (packages/yrd-cli/tests/authored-gitlink-admission.test.ts
    // covers that admission directly; composition-fill-in.test.ts in @yrd/queue covers the
    // derived shaset value it produces). This test stays scoped to the still-refusing case.
  })

  it("admits a branch whose only gitlink drift is base movement it never authored", async () => {
    const { repo, branch, basePin, advancedPin } = await staleBaseUnrelatedPinRepository()
    expect(basePin).not.toBe(advancedPin)
    let stdout = ""
    let stderr = ""

    const exit = await runYrdProcess(
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

    // Measured from the change's recorded base, main's own pin move reads as this
    // branch reverting 'dep'. Measured from where the branch actually diverged,
    // its authored delta is one script file and no gitlink at all.
    expect(stderr).not.toContain("authored-gitlink")
    expect(exit, stderr).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({
      command: "pr.submit",
      prs: [],
      derived: [{ lane: "derived", branch, base: "main" }],
    })

    // Admission is proven by the queue pass itself: the derived member composes
    // and integrates without any authored-gitlink refusal.
    let runOut = ""
    let runErr = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "--repo", repo, "queue", "run", "--once", "--json"], {
        cwd: repo,
        stdout: (text) => {
          runOut += text
        },
        stderr: (text) => {
          runErr += text
        },
      }),
      runErr,
    ).toBe(0)
    expect(runErr).not.toContain("authored-gitlink")
    expect(JSON.parse(runOut)).toMatchObject({
      command: "queue.run",
      results: [{ status: "completed", conclusion: "success", prs: [{ branch }] }],
    })
  })

  it("fetches the live remote branch before submitting from a separate stale clone", async () => {
    const { observer, branch, liveHead } = await staleRemoteBranchRepository()

    let stdout = ""
    let stderr = ""
    expect(
      await runYrdProcess(
        ["/usr/bin/bun", "/usr/local/bin/yrd", "--repo", observer, "pr", "submit", branch, "--json"],
        {
          cwd: observer,
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
    // The derived fact carries the LIVE head — the submit fetched the remote
    // branch first instead of submitting the observer's stale tracking ref.
    expect(JSON.parse(stdout)).toMatchObject({
      command: "pr.submit",
      prs: [],
      derived: [{ lane: "derived", branch, sha: liveHead, base: "main" }],
    })
    expect(await git(observer, "rev-parse", `refs/remotes/origin/${branch}`)).toBe(liveHead)
  })

  it("fails typed instead of submitting a stale branch when origin cannot be fetched", async () => {
    const { observer, branch, staleHead } = await staleRemoteBranchRepository()
    await git(observer, "remote", "set-url", "origin", join(observer, "missing-origin.git"))
    let stdout = ""
    let stderr = ""

    expect(
      await runYrdProcess(
        ["/usr/bin/bun", "/usr/local/bin/yrd", "--repo", observer, "pr", "create", branch, "--json"],
        {
          cwd: observer,
          stdout: (text) => {
            stdout += text
          },
          stderr: (text) => {
            stderr += text
          },
        },
      ),
    ).toBe(2)
    expect(stdout).toBe("")
    expect(JSON.parse(stderr)).toMatchObject({
      failure: {
        kind: "configuration",
        code: "submit-branch-refresh-failed",
      },
    })
    expect(stderr).toContain(`could not refresh live branch '${branch}' from origin`)
    expect(await git(observer, "rev-parse", `refs/remotes/origin/${branch}`)).toBe(staleHead)
    expect(await journalEnvelope(observer)).toEqual([])
  })

  // S7 record-store deletion (@i/10 22991) — record-lane tests removed with the
  // legacy mint. These flows are unreachable post-purge from these entrypoints:
  // `pr create` on a direct branch refuses `record-mint-retired`, so no draft
  // record, `pr ready`, `pr publish`, or record publication projection exists
  // to drive.
  // - "keeps a draft pushed when pr ready refuses an unpublished changed
  //   submodule pin": pr create → pr ready on a direct-branch DRAFT is the
  //   record lane; the surviving pin gate (compose-time min-commit-unpublished)
  //   is covered by "refuses to compose a docs submission whose incidental
  //   submodule pin is unpublished" above.
  // - "publishes from trusted staging without running source push hooks":
  //   record publication jobs (pr create + pr publish + queue-run publication)
  //   are the retired mint's machinery. NOTE, reported as a src gap: the
  //   derived lane's LANDING push runs from a scratch worktree that shares the
  //   source repository's hooks, so a failing source pre-push hook now fails
  //   the integration push (native-root-push-failure) — the isolation this
  //   test used to pin does not exist on the surviving path.
  // - "keeps a failed publication visible on the change after queue run --once
  //   exits red": publication projections lived on the record (`pr view`
  //   publication status); with no record there is no surface carrying a
  //   failed publication — compose refusals surface only on the runner's
  //   stderr log, reported as a src gap.

  it("keeps a derived submit durable and loud across a refused compose until a pass can integrate it", async () => {
    // The record publication flow (pr create → pr publish → queue-run
    // publication) retired with the mint. What survives is its durability
    // contract, re-homed on the derived lane: the submit FACT persists across
    // a queue pass that cannot compose it, every refusing pass says why, and
    // once the arrangement it names exists the next pass integrates.
    const { repo, rootRemote, moduleRemote, branch, pin } = await unpublishedSubmodulePinRepository()
    const head = await git(repo, "rev-parse", branch)
    const rootMainBefore = await git(rootRemote, "rev-parse", "refs/heads/main")
    let stdout = ""
    let stderr = ""
    const invoke = async (args: readonly string[]) =>
      runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "--repo", repo, ...args], {
        cwd: repo,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
      })

    expect(await invoke(["pr", "submit", branch, "--json"]), stderr).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({
      command: "pr.submit",
      prs: [],
      derived: [{ lane: "derived", branch, sha: head, base: "main" }],
    })

    // First pass: the unpublished pin refuses the compose — loudly, naming the
    // cure — and integrates nothing. The submit fact is NOT consumed.
    stdout = ""
    stderr = ""
    // An author-owned refusal sends the change back: exit 1, pass continued
    // (the three-way verdict, @i/10-yrd/24028).
    expect(await invoke(["queue", "run", "--once", "--json"]), stderr).toBe(QUEUE_OUTCOME_EXIT.changeRefused)
    expect(JSON.parse(stdout)).toMatchObject({ command: "queue.run", publications: [], results: [] })
    expect(stderr).toContain("min-commit-unpublished")
    expect(stderr).toContain("push it to the submodule's own main first")
    expect(await git(rootRemote, "rev-parse", "refs/heads/main")).toBe(rootMainBefore)

    // The arrangement the refusal names: the pin lands on the submodule's own
    // main. No resubmit — the durable fact alone must carry the next pass.
    await git(join(repo, "dep"), "push", "-q", "origin", `${pin}:refs/heads/main`)

    stdout = ""
    stderr = ""
    expect(await invoke(["queue", "run", "--once", "--json"]), stderr).toBe(0)
    const integrated = JSON.parse(stdout) as {
      results: Array<{ integration?: { commit?: string } }>
    }
    expect(integrated).toMatchObject({
      command: "queue.run",
      results: [{ status: "completed", conclusion: "success", prs: [{ branch, headSha: head }] }],
    })
    const integrationCommit = integrated.results[0]?.integration?.commit
    expect(integrationCommit).toBeDefined()
    expect(await git(rootRemote, "rev-parse", "refs/heads/main")).toBe(integrationCommit)
    expect(await git(moduleRemote, "rev-parse", "refs/heads/main")).toBe(pin)
  })

  it("executes every bare read and no-op recovery without creating journal state", async () => {
    const { repo } = await repository()
    const surfaces = [
      { args: ["--json"], command: "dashboard" },
      { args: ["queue", "--json"], command: "queue.list" },
      { args: ["pr", "list", "--json"], command: "pr.list" },
      { args: ["issue", "--json"], command: "issue.list" },
      { args: ["log", "--all", "--json"], command: "log" },
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

  // S7 note (@i/10 22991): the record-keyed run inspection ladder this test
  // taught (`pr merge PRn` → next: "yrd pr checks PRn" → the failed check's
  // typed evidence) has no derived-lane equivalent yet. A failing derived
  // member never becomes a run, and no read surface carries it — `pr checks`
  // and `pr merge` answer not-found/not-submitted for the synthetic id, and
  // queue/pr list/log stay empty — reported upstream as a src gap, not fenced
  // here. What survives and is pinned: the queue pass itself says LOUDLY why
  // the member was skipped, and a merge attempt appends nothing.
  it("skips a failing derived member loudly on the queue pass and keeps merge append-free", async () => {
    const { repo, featureSha } = await repository()
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
    expect(JSON.parse(submitOutput)).toMatchObject({
      command: "bay.submit",
      prs: [],
      derived: [{ lane: "derived", branch: "issue/feature", sha: featureSha, base: "main" }],
    })

    let runOutput = ""
    let runError = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "queue", "run", "--once", "--json"], {
        cwd: repo,
        stdout: (text) => {
          runOutput += text
        },
        stderr: (text) => {
          runError += text
        },
      }),
      // A failed required check is the author's: sent back, exit 1, the pass
      // continued (the three-way verdict, @i/10-yrd/24028).
    ).toBe(QUEUE_OUTCOME_EXIT.changeRefused)
    // The failing check keeps the member out of the run — and the pass says
    // so on its own stream instead of composing or silently dropping it.
    expect(JSON.parse(runOutput)).toMatchObject({ command: "queue.run", publications: [], results: [] })
    expect(runError).toContain("check-failed")
    expect(runError).toContain("required-check-failed")

    const before = await journalEnvelope(repo)
    let refusal = ""
    expect(
      await runYrdProcess(["/usr/bin/bun", "/usr/local/bin/yrd", "pr", "merge", "issue/feature", "--json"], {
        cwd: repo,
        stdout: () => undefined,
        stderr: (text) => {
          refusal += text
        },
      }),
    ).toBe(1)
    expect(JSON.parse(refusal)).toMatchObject({ command: "pr.merge", branch: "issue/feature" })
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
    await expect(host.services.queueReadModel?.snapshot()).resolves.toMatchObject({ attempts: [] })
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

  it("keeps repeated habitant signals idempotent while hard escalation reaps the active process tree", async () => {
    const { repo, featureSha } = await repository()
    const childPidPath = join(repo, "habitant-hard-stop.pid")
    const grandchildPidPath = join(repo, "habitant-hard-stop-grandchild.pid")
    const hardStopPath = join(repo, "habitant-hard-stop.started")
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

  it("drains a ONE-SHOT queue pass on SIGTERM: the job finishes and the exit says it was stopped", async () => {
    // The 2026-09-01 incident, end to end. Three one-shot passes died to signals
    // in one day — a peer's SIGTERM, an account rotation that took the parent
    // shell, an agent loop whose stop walked the process tree — and each death
    // left its job unfinished for a later pass to re-lose.
    //
    // `queue run --once` resolves to the `one-shot-queue-run` posture, which was
    // the ONE queue posture `host.ts` minted no drain controller for. Without it
    // the boundary treated the first signal as the hard one: it closed the host
    // CONCURRENTLY with the still-running pass, killing the check mid-flight,
    // and then re-raised the signal so the process died by SIGTERM.
    const { repo, featureSha } = await repository()
    const startedPath = join(repo, "..", "one-shot-check.started")
    const finishedPath = join(repo, "..", "one-shot-check.finished")
    const command = [`touch ${JSON.stringify(startedPath)}`, "sleep 3", `touch ${JSON.stringify(finishedPath)}`].join(
      "; ",
    )
    await commitYrdConfig(repo, `checks: [{check: {run: ${JSON.stringify(command)}, timeoutMs: 20000}}]\n`)
    {
      await using submitter = await createYrdHost({ cwd: repo })
      await submitter.app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
      await submitter.close()
    }

    const child = Bun.spawn(
      [process.execPath, join(import.meta.dirname, "../../../bin/yrd.ts"), "queue", "run", "--once", "--json"],
      {
        cwd: repo,
        env: { ...process.env, LOGGILY_FILE: join(repo, "..", "one-shot.log") },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    try {
      // Signal it MID-JOB: the check has started and has ~3s left to run.
      await vi.waitFor(async () => expect(await Bun.file(startedPath).exists()).toBe(true), { timeout: 15_000 })
      expect(await Bun.file(finishedPath).exists()).toBe(false)
      child.kill("SIGTERM")
      const exitCode = await child.exited

      // 1. The job in flight FINISHED. This is the assertion the three incidents
      //    were about: before the drain, closing the host on the first signal
      //    tore the Process down under the running check and this file never
      //    appeared.
      expect(await Bun.file(finishedPath).exists(), "the check was killed mid-run instead of finishing").toBe(true)

      // 2. The exit says "stopped on purpose", not "died after SIGTERM". A
      //    one-shot has no supervisor, so its exit status is the only thing the
      //    operator or the script that ran it ever learns.
      expect(exitCode, `${await stdout}\n${await stderr}`).toBe(HABITANT_EXIT.drained)
      expect(exitCode).not.toBe(0)
      expect(exitCode).not.toBe(1)

      // 3. Nothing is left `in_progress` for the next pass to find, and the
      //    lease came off — proven by a fresh host taking it right here, which
      //    is refused outright while another pass holds it.
      await using inspector = await createYrdHost({ cwd: repo })
      const summary = inspector.app.queue.status("main")
      expect([...summary.running, ...summary.waiting].map((run) => run.id)).toEqual([])
      await inspector.close()
    } finally {
      child.kill("SIGKILL")
      await child.exited
      await stdout
      await stderr
    }
  }, 40_000)

  it("refuses a second habitant follow-runner with the active runner identity", async () => {
    const { repo, featureSha } = await repository()
    const startedPath = join(repo, "..", "habitant-check.started")
    const executionsPath = join(repo, "..", "habitant-check.executions")
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
    // #62: the habitant runner is now `queue run` in its follow-by-default form
    // (no selector, no --once). Follow drains the WHOLE default queue, so to keep
    // each habitant bound to exactly one change, PR1 is submitted first and PR2 only
    // after the first runner releases the lease.
    {
      await using submitter = await createYrdHost({ cwd: repo })
      await submitter.app.bays.submit({ branch: "issue/feature", headSha: featureSha, base: "main" })
      await submitter.close()
    }
    const spawnFollow = (pane: string) => {
      const logPath = join(repo, "..", `habitant-${pane.replace(/[^a-z0-9]+/giu, "-")}.log`)
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
      // A second habitant follow-runner is refused while the first holds the lease.
      second = spawnFollow("w1:p2")

      const outcome = await Promise.race([
        second.child.exited.then((exitCode) => ({ exitCode })),
        Bun.sleep(2_000).then(() => ({ exitCode: "still-running" as const })),
      ])
      expect(outcome).toEqual({ exitCode: 1 })
      // `mode=resident` is part of the holder line: a one-shot pass takes the
      // same lease, so the holder must say which kind of pass it is
      // (queue-runner-lease.test.ts owns the rest of that matrix).
      expect(await second.stderr).toMatch(
        new RegExp(
          `resident-runner-active: writer lock is busy \\(holder=queue=.*#main epoch=[0-9a-f-]{36} mode=resident; ` +
            `owner=pid:${first.child.pid}; contender=pid:${second.child.pid}`,
          "u",
        ),
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
        throw new Error(`replacement habitant did not execute PR2\n${replacementLog}`, { cause })
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

  it("records a process-host attestation as the habitant's loaded implementation", async () => {
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
          YRD_JOURNAL_KEEP_FRAMES: "500",
          YRD_WRAPPER_IMPLEMENTATION_SOURCE: implementationSource,
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
            driver: {
              queueId: `${repo}#main`,
              epoch: expect.stringMatching(/^[0-9a-f-]{36}$/u),
              lastMerged: null,
            },
            retention: {
              policy: { keepFrames: 500 },
              source: "mutable-journal",
              observedAt: expect.any(String),
              generation: expect.stringMatching(/^[0-9a-f-]{36}$/u),
            },
          }),
        { timeout: 10_000 },
      )
      const doctor = Bun.spawn(
        [process.execPath, join(import.meta.dirname, "../../../bin/yrd.ts"), "doctor", "--json"],
        {
          cwd: repo,
          env: { ...process.env, YRD_JOURNAL_RETENTION: "disabled" },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [doctorStdout, doctorStderr, doctorExit] = await Promise.all([
        new Response(doctor.stdout).text(),
        new Response(doctor.stderr).text(),
        doctor.exited,
      ])
      expect(doctorExit, `${doctorStderr}\n${doctorStdout}`).toBe(0)
      expect(JSON.parse(doctorStdout)).toMatchObject({
        retention: {
          advisory: true,
          writer: { active: true, armed: true, policy: { keepFrames: 500 } },
        },
      })
      cli.kill("SIGTERM")
      await expect(cli.exited).resolves.toBe(0)
    } finally {
      cli.kill("SIGKILL")
      await cli.exited
      await stdout
      await stderr
    }
  }, 30_000)

  it("keys the habitant driver epoch to the configured queue base", async () => {
    const { repo } = await repository()
    await git(repo, "branch", "release/2.0", "HEAD")
    await writeFile(join(repo, ".yrd.yml"), 'base: release/2.0\nchecks: [{check: {run: "true"}}]\n')
    await git(repo, "add", ".yrd.yml")
    await git(repo, "commit", "-qm", "select release queue")
    const statusPath = join(repo, ".git", "yrd", "resident-runner", "status.json")
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
      { cwd: repo, stdout: "pipe", stderr: "pipe" },
    )
    const stdout = new Response(cli.stdout).text()
    const stderr = new Response(cli.stderr).text()
    try {
      await vi.waitFor(
        async () =>
          expect(JSON.parse(await readFile(statusPath, "utf8"))).toMatchObject({
            pid: cli.pid,
            driver: {
              queueId: `${repo}#release/2.0`,
              epoch: expect.stringMatching(/^[0-9a-f-]{36}$/u),
              lastMerged: null,
            },
          }),
        { timeout: 10_000 },
      )
      const health = Bun.spawn(
        [process.execPath, join(import.meta.dirname, "../../../bin/yrd.ts"), "queue", "list", "--check", "--json"],
        { cwd: repo, stdout: "pipe", stderr: "pipe" },
      )
      const [healthStdout, healthStderr, healthExit] = await Promise.all([
        new Response(health.stdout).text(),
        new Response(health.stderr).text(),
        health.exited,
      ])
      expect(healthExit, `${healthStderr}\n${healthStdout}`).toBe(0)
      expect(JSON.parse(healthStdout)).toMatchObject({
        state: "healthy",
        facts: { leaseDriver: { queueId: `${repo}#release/2.0` } },
      })
    } finally {
      cli.kill("SIGTERM")
      await cli.exited
      await stdout
      await stderr
    }
  }, 30_000)

  it("replaces a dead habitant owner after the OS releases its lease", async () => {
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
    const opened = await setup.app.bays.open({ name: "stale", by: "test" })
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
    // Implicit current-branch routing survives the purge: the linked worktree's
    // own branch is the one submitted, as a derived fact at its head. --issue
    // binds to records only; the derived lane WARNS it was dropped and proceeds.
    const submitted = JSON.parse(stdout) as { warnings?: string[] }
    expect(submitted).toMatchObject({
      command: "bay.submit",
      prs: [],
      derived: [{ lane: "derived", branch: "issue/feature", sha: featureSha, base: "main" }],
    })
    expect(submitted.warnings?.some((warning) => warning.includes("issue") && warning.includes("derived lane"))).toBe(
      true,
    )

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
    // The derived fact's sha is the SELECTED repository's unique feature head —
    // the poisoned YRD_REPO/GIT_DIR environment never leaks into resolution.
    // (The record-lane pr diff/pr status legs retired with the mint: no record
    // exists for a direct branch, and the derived lane has no status reader
    // yet — that read gap is reported upstream, not fenced here.)
    const selected = await run(["bay", "submit", "--repo", relativeRepo, "--json"], poisoned)
    expect(selected.exitCode, selected.stderr).toBe(0)
    expect(JSON.parse(selected.stdout)).toMatchObject({
      command: "bay.submit",
      prs: [],
      derived: [{ lane: "derived", branch: "issue/feature", sha: featureSha, base: "main" }],
    })

    const submitted = await run(["pr", "submit", "--repo", relativeRepo, "--json"])
    expect(submitted.exitCode, submitted.stderr).toBe(0)
    expect(JSON.parse(submitted.stdout)).toMatchObject({
      command: "pr.submit",
      prs: [],
      derived: [{ lane: "derived", branch: "issue/feature", sha: featureSha, base: "main" }],
    })

    const managedCwd = (await readFile(checkCwd, "utf8")).trim()
    // The config commit advanced main after the selected revision diverged, so
    // the check judges that repository's composed candidate rather than its
    // checkout. Which repository owns the workspace is the authority claim, and
    // it is still exactly one: the selected one, never ambient, never wrong.
    expect(managedCwd.startsWith(join(repo, ".git", "yrd", "pre-submit-worktrees") + sep)).toBe(true)
    expect(managedCwd).not.toBe(ambient)
    expect(managedCwd.startsWith(wrong.repo + sep)).toBe(false)
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
    expect(stderr).toBe("yrd: dead-man: the queue has work but no habitant runner owns the drain lease\n")

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
    expect(stderr).toBe("yrd: dead-man: the queue has work but no habitant runner owns the drain lease\n")
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
        reason: { code: "candidate-conflicting", message: "change 'PR1' revision 1 conflicts in Candidate 'C1'" },
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
    await initBareMain(repo, remote)
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

describe("pre-submit checkout isolation and timeout policy (22648)", () => {
  async function slowCheckoutRepository(sleepSeconds: number): Promise<{ repo: string }> {
    const { repo } = await repository()
    await mkdir(join(repo, ".git", "hooks"), { recursive: true })
    await writeFile(join(repo, ".git", "hooks", "post-checkout"), `#!/bin/sh\nsleep ${sleepSeconds}\nexit 0\n`, {
      mode: 0o755,
    })
    return { repo }
  }

  async function submitFeature(repo: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    let stdout = ""
    let stderr = ""
    const exitCode = await runYrdProcess(
      ["/usr/bin/bun", "/usr/local/bin/yrd", "pr", "submit", "issue/feature", "--json"],
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
    return { exitCode, stdout, stderr }
  }

  it("bypasses a checkout hook that would outlive the materialization limit", async () => {
    const { repo } = await slowCheckoutRepository(2.4)
    const previous = process.env.YRD_CHECKOUT_TIMEOUT_MS
    process.env.YRD_CHECKOUT_TIMEOUT_MS = "500"
    try {
      const { exitCode, stdout, stderr } = await submitFeature(repo)
      expect(exitCode, stderr).toBe(0)
      expect(JSON.parse(stdout)).toMatchObject({
        command: "pr.submit",
        prs: [],
        derived: [{ lane: "derived", branch: "issue/feature" }],
      })
    } finally {
      if (previous === undefined) delete process.env.YRD_CHECKOUT_TIMEOUT_MS
      else process.env.YRD_CHECKOUT_TIMEOUT_MS = previous
    }
  })

  it("retains a conservative default for materializing the candidate tree", async () => {
    const { GIT_MATERIALIZE_TIMEOUT_DEFAULT_MS, resolveCheckoutTimeoutMs } = await import("../src/git-timeouts.ts")
    expect(GIT_MATERIALIZE_TIMEOUT_DEFAULT_MS).toBeGreaterThanOrEqual(90_000)
    expect(resolveCheckoutTimeoutMs({})).toBe(GIT_MATERIALIZE_TIMEOUT_DEFAULT_MS)
  })

  it("refuses an invalid YRD_CHECKOUT_TIMEOUT_MS loudly instead of silently falling back (22648)", async () => {
    const { resolveCheckoutTimeoutMs } = await import("../src/git-timeouts.ts")
    expect(() => resolveCheckoutTimeoutMs({ YRD_CHECKOUT_TIMEOUT_MS: "soon" })).toThrow(/YRD_CHECKOUT_TIMEOUT_MS/u)
    expect(() => resolveCheckoutTimeoutMs({ YRD_CHECKOUT_TIMEOUT_MS: "-5" })).toThrow(/YRD_CHECKOUT_TIMEOUT_MS/u)
  })
})

describe("fillMissingStateFromInitial", () => {
  it("fills fields the stored checkpoint predates and keeps every stored value", async () => {
    const { fillMissingStateFromInitial } = await import("../src/host.ts")
    const initial = {
      queues: { batchSize: 3, active: [] as string[] },
      intents: { records: {}, order: [] as string[], unreadable: [] as { id: string }[] },
    }
    const stored = {
      queues: { batchSize: 5, active: ["run-1"] },
      intents: { records: { "yrdpin#1": { component: "vendor/yrd" } }, order: ["yrdpin#1"] },
    }
    expect(fillMissingStateFromInitial(initial, stored)).toEqual({
      queues: { batchSize: 5, active: ["run-1"] },
      intents: { records: { "yrdpin#1": { component: "vendor/yrd" } }, order: ["yrdpin#1"], unreadable: [] },
    })
  })

  it("keeps populated containers and scalars verbatim when nothing is missing", async () => {
    const { fillMissingStateFromInitial } = await import("../src/host.ts")
    const initial = { a: { b: [] as number[], c: 0 }, d: {} }
    const stored = { a: { b: [1, 2], c: 7 }, d: { kept: true } }
    expect(fillMissingStateFromInitial(initial, stored)).toEqual(stored)
  })

  it("takes the initial value only for keys with no stored value at all", async () => {
    const { fillMissingStateFromInitial } = await import("../src/host.ts")
    expect(fillMissingStateFromInitial({ a: 1, b: { c: [] as string[] } }, {} as { a?: number })).toEqual({
      a: 1,
      b: { c: [] },
    })
  })
})

describe("targetImplementationEntrypoint", () => {
  const repo = join(sep, "repo")
  const baysRoot = join(repo, ".bays")
  const candidate = join(sep, "elsewhere", "warm", "worktree")

  it("resolves a composed implementation inside the Candidate tree", async () => {
    const { targetImplementationEntrypoint } = await import("../src/host.ts")
    expect(targetImplementationEntrypoint(repo, join(repo, "vendor", "yrd"), candidate, baysRoot)).toBe(
      join(candidate, "vendor", "yrd", "bin", "yrd.ts"),
    )
  })

  it("keeps a standalone implementation outside the repository fixed", async () => {
    const { targetImplementationEntrypoint } = await import("../src/host.ts")
    const standalone = join(sep, "opt", "yrd")
    expect(targetImplementationEntrypoint(repo, standalone, candidate, baysRoot)).toBe(
      join(standalone, "bin", "yrd.ts"),
    )
  })

  it("keeps a bay-installed implementation fixed instead of composing a phantom Candidate path", async () => {
    // 2026-08-17: the habitant runner executed Yrd from its own bay under the
    // repository's bays root. Mapping that root into the Candidate composed
    // <warm-bay>/.bays/<runner-bay>/vendor/yrd/bin/yrd.ts — a path no
    // Candidate tree can contain (bays are untracked) — and substrate-pair
    // refused the derivation with Module not found on every such cycle.
    const { targetImplementationEntrypoint } = await import("../src/host.ts")
    const bayImplementation = join(baysRoot, "B65", "vendor", "yrd")
    expect(targetImplementationEntrypoint(repo, bayImplementation, candidate, baysRoot)).toBe(
      join(bayImplementation, "bin", "yrd.ts"),
    )
  })

  it("maps a linked-worktree implementation by its own working tree, never the assembly root", async () => {
    // 2026-08-18: the habitant runner executed Yrd from a linked git worktree
    // of the repository. Stripping the assembly root left the worktrees
    // directory prefixed onto the Candidate path —
    // <bay>/worktree/.worktrees/<runner-worktree>/…/bin/yrd.ts, a path no
    // Candidate tree can contain — and every new-PR check refused with Module
    // not found. The implementation's enclosing working tree is the base.
    const { targetImplementationEntrypoint } = await import("../src/host.ts")
    const workTree = join(repo, ".worktrees", "wt1")
    const linked = join(workTree, "vendor", "yrd")
    expect(targetImplementationEntrypoint(repo, linked, candidate, baysRoot, workTree)).toBe(
      join(candidate, "vendor", "yrd", "bin", "yrd.ts"),
    )
  })

  it("keeps the implementation fixed when its declared working tree does not contain it", async () => {
    const { targetImplementationEntrypoint } = await import("../src/host.ts")
    const unrelated = join(sep, "srv", "elsewhere")
    expect(targetImplementationEntrypoint(repo, join(repo, "vendor", "yrd"), candidate, baysRoot, unrelated)).toBe(
      join(repo, "vendor", "yrd", "bin", "yrd.ts"),
    )
  })

  it("maps a primary-root implementation identically with and without its working tree", async () => {
    const { targetImplementationEntrypoint } = await import("../src/host.ts")
    expect(targetImplementationEntrypoint(repo, join(repo, "vendor", "yrd"), candidate, baysRoot, repo)).toBe(
      join(candidate, "vendor", "yrd", "bin", "yrd.ts"),
    )
  })
})

describe("habitantOwnsSettlementDrain", () => {
  // @i/10-yrd/settlement-drain-is-runner-owned: only a habitant invocation
  // (`queue run`) may own the settlement drain. Every other command's
  // settlement launch must return without ever calling
  // spawnYrdSettlementWorker — a second worker there only contends with the
  // habitant runner's own for the writer lock (measured 2026-08-29: a
  // steady 0.9/min tax across ordinary CLI calls, 61% from one caller
  // alone, none of it the runner itself).
  const fakeLaunch = (
    habitant: boolean,
    spawn: (asHabitant: boolean) => void = () => undefined,
  ): YrdSettlementLaunch => ({
    habitant,
    drainNotices: () => undefined,
    spawn,
  })

  it("is false when no settlement launch exists at all (help/version answers with nothing to own)", () => {
    expect(habitantOwnsSettlementDrain(undefined)).toBe(false)
  })

  it("is false for an ordinary, non-habitant command", () => {
    expect(habitantOwnsSettlementDrain(fakeLaunch(false))).toBe(false)
  })

  it("is true only for a queue-run (habitant) command", () => {
    expect(habitantOwnsSettlementDrain(fakeLaunch(true))).toBe(true)
  })

  it("is the sole gate spawnYrdSettlementWorker may fire behind: a non-habitant launch never spawns, a habitant launch spawns exactly once, as habitant", () => {
    for (const habitant of [false, true]) {
      const calls: boolean[] = []
      const launch = fakeLaunch(habitant, (asHabitant) => calls.push(asHabitant))
      if (habitantOwnsSettlementDrain(launch)) launch.spawn(true)
      expect(calls).toEqual(habitant ? [true] : [])
    }
  })

  it("regression: two concurrent non-habitant launches beside one habitant launch — only the habitant spawns", () => {
    const calls: boolean[] = []
    const nonHabitantA = fakeLaunch(false, (asHabitant) => calls.push(asHabitant))
    const nonHabitantB = fakeLaunch(false, (asHabitant) => calls.push(asHabitant))
    const habitant = fakeLaunch(true, (asHabitant) => calls.push(asHabitant))
    for (const launch of [nonHabitantA, habitant, nonHabitantB]) {
      if (habitantOwnsSettlementDrain(launch)) launch.spawn(true)
    }
    expect(calls).toEqual([true])
  })

  it("host.ts calls settlement.spawn from exactly one, habitant-gated call site — the regression this bead closes was a second, ungated call site", async () => {
    const { readFileSync } = await import("node:fs")
    const source = readFileSync(new URL("../src/host.ts", import.meta.url), "utf8")
    const spawnCalls = source.split("\n").filter((line) => /settlement\??\.spawn\(/.test(line))
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0]).toContain("spawn(true)")
    expect(spawnCalls[0]).not.toContain("spawn(false)")
  })
})
